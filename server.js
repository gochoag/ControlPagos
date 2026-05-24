require('dotenv').config();
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { buildGroupReportMessage } = require('./js/reportFormatter');

const REQUESTED_PORT = Number(process.env.PORT || 4343);
const MAX_PORT_ATTEMPTS = 10;
const DB_FILE = path.join(__dirname, 'db.json');
const WHATSAPP_AUTH_PATH = path.join(__dirname, '.wwebjs_auth');
const WHATSAPP_CACHE_PATH = path.join(__dirname, '.wwebjs_cache');
const WHATSAPP_CLIENT_ID = 'controlpagos';
const CHROME_CANDIDATES = [
    process.env.WHATSAPP_CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
];
const QR_TTL_MS = 45 * 1000;
const AUTH_READY_TIMEOUT_MS = 60 * 1000;

let whatsappClient = null;
let whatsappInitPromise = null;
let qrExpiryTimer = null;
let authReadyTimer = null;
let restartInProgress = false;
let shutdownInProgress = false;
const whatsappState = {
    status: 'idle',
    qr: '',
    qrDataUrl: '',
    qrGeneratedAt: null,
    qrExpiresAt: null,
    lastError: '',
    info: null,
    lastEventAt: null,
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const jsonResponse = (data, status = 200) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
        },
    });
};

const errorResponse = (error, status = 500, detail = '') => {
    return jsonResponse(detail ? { error, detail } : { error }, status);
};

const noContentResponse = () => {
    return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
    });
};

const readRequestJson = async (request) => {
    try {
        return await request.json();
    } catch {
        throw new Error('Invalid JSON body');
    }
};

const resolveStaticFilePath = (pathname) => {
    const requestedPath = pathname === '/'
        ? 'index.html'
        : pathname.replace(/^\/+/u, '');
    const normalizedPath = path.normalize(requestedPath);

    if (!normalizedPath || normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        return null;
    }

    return path.join(__dirname, normalizedPath);
};

const serveStaticFile = async (pathname) => {
    const filePath = resolveStaticFilePath(pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return null;
    }

    const file = Bun.file(filePath);
    const headers = {
        ...CORS_HEADERS,
    };

    if (file.type) {
        headers['Content-Type'] = file.type;
    }

    return new Response(file, {
        headers,
    });
};

const createEmptyData = () => ({
    receivables: [],
    receivableContacts: [],
    payables: [],
    classes: [],
    memberships: [],
    savings: [],
});

const ensureDataShape = (data) => {
    const safeData = data && typeof data === 'object' ? data : {};
    return {
        receivables: Array.isArray(safeData.receivables) ? safeData.receivables : [],
        receivableContacts: Array.isArray(safeData.receivableContacts) ? safeData.receivableContacts : [],
        payables: Array.isArray(safeData.payables) ? safeData.payables : [],
        classes: Array.isArray(safeData.classes) ? safeData.classes : [],
        memberships: Array.isArray(safeData.memberships) ? safeData.memberships : [],
        savings: Array.isArray(safeData.savings) ? safeData.savings : [],
    };
};

// Helper to read DB
const readDB = () => {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = createEmptyData();
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }

    const data = fs.readFileSync(DB_FILE, 'utf8');
    return ensureDataShape(JSON.parse(data || '{}'));
};

// Helper to write DB
const writeDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(ensureDataShape(data), null, 2));
};

const setWhatsappState = (status, extra = {}) => {
    Object.assign(whatsappState, extra, {
        status,
        lastEventAt: new Date().toISOString(),
    });
};

const clearQrExpiryTimer = () => {
    if (qrExpiryTimer) {
        clearTimeout(qrExpiryTimer);
        qrExpiryTimer = null;
    }
};

const clearAuthReadyTimer = () => {
    if (authReadyTimer) {
        clearTimeout(authReadyTimer);
        authReadyTimer = null;
    }
};

const clearWhatsappTimers = () => {
    clearQrExpiryTimer();
    clearAuthReadyTimer();
};

const getClientInfo = () => {
    if (!whatsappClient || !whatsappClient.info) {
        return null;
    }

    return {
        pushname: whatsappClient.info.pushname || '',
        wid: whatsappClient.info.wid ? whatsappClient.info.wid.user : '',
    };
};

const getChromeExecutablePath = () => {
    return CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || undefined;
};

const restartWhatsAppAsync = async (reason = '', options = {}) => {
    if (restartInProgress) {
        return;
    }

    const {
        clearCache = false,
        clearSession = false,
    } = options;

    restartInProgress = true;

    try {
        await destroyWhatsappClient();
        if (clearSession) {
            removeWhatsappSessionFiles();
        }
        if (clearCache || clearSession) {
            removeWhatsappCacheFiles();
        }
        setWhatsappState('initializing', {
            qr: '',
            qrDataUrl: '',
            qrGeneratedAt: null,
            qrExpiresAt: null,
            info: null,
            lastError: reason,
        });
        await initializeWhatsApp();
    } catch (error) {
        setWhatsappState('error', {
            lastError: error.message,
        });
    } finally {
        restartInProgress = false;
    }
};

const scheduleQrExpiry = (qrGeneratedAt) => {
    clearQrExpiryTimer();

    qrExpiryTimer = setTimeout(() => {
        const isSameQr = whatsappState.qrGeneratedAt === qrGeneratedAt;
        if (isSameQr && whatsappState.status === 'qr') {
            setWhatsappState('qr_expired', {
                qr: '',
                qrDataUrl: '',
                qrGeneratedAt: null,
                qrExpiresAt: null,
                lastError: 'El QR vencio antes de ser escaneado. Generando uno nuevo...',
            });
            restartWhatsAppAsync('El QR anterior vencio y se esta generando uno nuevo.', {
                clearCache: true,
            });
        }
    }, QR_TTL_MS);
};

const scheduleAuthReadyTimeout = () => {
    clearAuthReadyTimer();

    authReadyTimer = setTimeout(() => {
        if (['authenticated', 'loading'].includes(whatsappState.status)) {
            setWhatsappState('restarting', {
                lastError: 'La vinculacion tardo demasiado. Reiniciando la sesion de WhatsApp...',
            });
            restartWhatsAppAsync('La vinculacion se quedo cargando demasiado tiempo.', {
                clearCache: true,
            });
        }
    }, AUTH_READY_TIMEOUT_MS);
};

const normalizeWhatsappNumber = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) {
        return null;
    }

    if (digits.startsWith('593') && digits.length === 12) {
        return digits;
    }

    if (digits.startsWith('0') && digits.length === 10) {
        return `593${digits.slice(1)}`;
    }

    if (digits.length === 9 && digits.startsWith('9')) {
        return `593${digits}`;
    }

    return null;
};

const getGroupedItems = (type, name) => {
    const data = readDB();
    const collection = Array.isArray(data[type]) ? data[type] : [];
    return collection.filter((item) => (item.name || item.student || 'Desconocido') === name);
};

const getGroupPhone = (data, name, items = []) => {
    const contacts = Array.isArray(data.receivableContacts) ? data.receivableContacts : [];
    const contact = contacts.find((item) => item.name === name);
    if (contact && contact.phone) {
        return contact.phone;
    }

    const withPhone = items.find((item) => item.phone);
    return withPhone ? withPhone.phone : '';
};

const findDriveDbFile = async (accessToken, targetFolderId) => {
    const fileName = 'db.json';
    const escapedFileName = fileName.replace(/'/g, "\\'");
    const query = encodeURIComponent(`name='${escapedFileName}' and '${targetFolderId}' in parents and trashed=false`);

    const searchResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)&pageSize=10&orderBy=modifiedTime desc`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    );

    if (!searchResponse.ok) {
        const detail = await searchResponse.text();
        throw new Error(`Error buscando archivo en Drive: ${detail}`);
    }

    const searchData = await searchResponse.json();
    return Array.isArray(searchData.files) ? searchData.files[0] : null;
};

const removeWhatsappSessionFiles = () => {
    fs.rmSync(WHATSAPP_AUTH_PATH, { recursive: true, force: true });
};

const removeWhatsappCacheFiles = () => {
    fs.rmSync(WHATSAPP_CACHE_PATH, { recursive: true, force: true });
};

const destroyWhatsappClient = async () => {
    clearWhatsappTimers();

    if (!whatsappClient) {
        whatsappInitPromise = null;
        return;
    }

    try {
        await whatsappClient.destroy();
    } catch (error) {
        console.warn('No se pudo destruir el cliente de WhatsApp:', error.message);
    }

    whatsappClient = null;
    whatsappInitPromise = null;
};

const disconnectWhatsAppAsync = async () => {
    clearWhatsappTimers();

    if (whatsappClient) {
        try {
            await whatsappClient.logout();
        } catch (error) {
            console.warn('No se pudo cerrar sesion en WhatsApp:', error.message);
        }
    }

    await destroyWhatsappClient();
    removeWhatsappSessionFiles();
    removeWhatsappCacheFiles();

    setWhatsappState('idle', {
        qr: '',
        qrDataUrl: '',
        qrGeneratedAt: null,
        qrExpiresAt: null,
        info: null,
        lastError: '',
    });
};

const initializeWhatsApp = () => {
    if (whatsappInitPromise) {
        return whatsappInitPromise;
    }

    setWhatsappState('initializing', {
        lastError: '',
    });

    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: WHATSAPP_CLIENT_ID,
            dataPath: WHATSAPP_AUTH_PATH,
        }),
        authTimeoutMs: AUTH_READY_TIMEOUT_MS,
        qrMaxRetries: 10,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        webVersionCache: {
            type: 'local',
            path: WHATSAPP_CACHE_PATH,
            strict: false,
        },
        deviceName: 'ControlPagos',
        browserName: 'Chrome',
        puppeteer: {
            headless: true,
            executablePath: getChromeExecutablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
    });

    whatsappClient.on('qr', async (qr) => {
        const qrDataUrl = await QRCode.toDataURL(qr);
        const qrGeneratedAt = new Date().toISOString();
        const qrExpiresAt = new Date(Date.now() + QR_TTL_MS).toISOString();
        setWhatsappState('qr', {
            qr,
            qrDataUrl,
            qrGeneratedAt,
            qrExpiresAt,
            info: null,
            lastError: '',
        });
        scheduleQrExpiry(qrGeneratedAt);
    });

    whatsappClient.on('loading_screen', () => {
        if (!['ready', 'qr', 'authenticated'].includes(whatsappState.status)) {
            setWhatsappState('loading', {
                info: null,
            });
        }
    });

    whatsappClient.on('authenticated', () => {
        clearQrExpiryTimer();
        setWhatsappState('authenticated', {
            qr: '',
            qrDataUrl: '',
            qrGeneratedAt: null,
            qrExpiresAt: null,
            lastError: '',
        });
        scheduleAuthReadyTimeout();
    });

    whatsappClient.on('ready', () => {
        clearWhatsappTimers();
        setWhatsappState('ready', {
            qr: '',
            qrDataUrl: '',
            qrGeneratedAt: null,
            qrExpiresAt: null,
            lastError: '',
            info: getClientInfo(),
        });
    });

    whatsappClient.on('auth_failure', (message) => {
        clearWhatsappTimers();
        setWhatsappState('auth_failure', {
            qr: '',
            qrDataUrl: '',
            qrGeneratedAt: null,
            qrExpiresAt: null,
            info: null,
            lastError: message || 'Fallo de autenticacion en WhatsApp',
        });

        setTimeout(() => {
            restartWhatsAppAsync('La autenticacion fallo y se esta generando una nueva sesion.', {
                clearCache: true,
                clearSession: true,
            });
        }, 1500);
    });

    whatsappClient.on('disconnected', async (reason) => {
        clearWhatsappTimers();
        setWhatsappState('disconnected', {
            qr: '',
            qrDataUrl: '',
            qrGeneratedAt: null,
            qrExpiresAt: null,
            info: null,
            lastError: reason || 'WhatsApp se desconecto',
        });

        setTimeout(() => {
            restartWhatsAppAsync('WhatsApp se desconecto y se esta reintentando la conexion.', {
                clearCache: true,
            });
        }, 1500);
    });

    whatsappInitPromise = whatsappClient.initialize().catch(async (error) => {
        await destroyWhatsappClient();

        if (isRecoverableWhatsAppError(error)) {
            setWhatsappState('restarting', {
                qr: '',
                qrDataUrl: '',
                qrGeneratedAt: null,
                qrExpiresAt: null,
                info: null,
                lastError: 'WhatsApp se reiniciara tras un error interno temporal.',
            });
            restartWhatsAppAsync('Se reinicio WhatsApp tras un error interno temporal.', {
                clearCache: true,
            });
            return;
        }

        setWhatsappState('error', {
            qr: '',
            qrDataUrl: '',
            qrGeneratedAt: null,
            qrExpiresAt: null,
            info: null,
            lastError: error.message,
        });
        throw error;
    });

    return whatsappInitPromise;
};

const isRecoverableWhatsAppError = (error) => {
    const message = error && error.message ? error.message : String(error || '');
    return message.includes('Execution context was destroyed')
        || message.includes('Cannot find context with specified id')
        || message.includes('Navigating frame was detached')
        || message.includes('Target closed')
        || message.includes('Attempted to use detached Frame');
};

const handleRecoverableWhatsAppError = (error) => {
    if (!isRecoverableWhatsAppError(error)) {
        return false;
    }

    setWhatsappState('restarting', {
        lastError: 'WhatsApp se reiniciara tras un error interno temporal.',
    });
    restartWhatsAppAsync('Se reinicio WhatsApp tras un error interno temporal.', {
        clearCache: true,
    });
    return true;
};

const shutdownServerAsync = async (signal = '') => {
    if (shutdownInProgress) {
        return;
    }

    shutdownInProgress = true;

    if (signal) {
        console.log(`\nCerrando servidor por ${signal} y limpiando Puppeteer...`);
    } else {
        console.log('\nCerrando servidor y limpiando Puppeteer...');
    }

    try {
        await destroyWhatsappClient();
        console.log('WhatsApp cerrado limpiamente.');
    } catch (error) {
        console.error('Error al cerrar WhatsApp:', error.message);
    }

    try {
        server.stop(true);
    } catch (error) {
        console.error('Error al detener el servidor HTTP:', error.message);
    }

    process.exit(0);
};

process.on('unhandledRejection', (reason) => {
    if (handleRecoverableWhatsAppError(reason)) {
        return;
    }

    console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
    if (handleRecoverableWhatsAppError(error)) {
        return;
    }

    console.error('Uncaught exception:', error);
});

const handleRequest = async (request) => {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
        return noContentResponse();
    }

    if (request.method === 'GET' && pathname === '/api/data') {
        try {
            return jsonResponse(readDB());
        } catch {
            return errorResponse('Error reading database');
        }
    }

    if (request.method === 'POST' && pathname === '/api/data') {
        try {
            const body = await readRequestJson(request);
            writeDB(body);
            return jsonResponse({ success: true, message: 'Saved successfully' });
        } catch (error) {
            if (error.message === 'Invalid JSON body') {
                return errorResponse(error.message, 400);
            }

            return errorResponse('Error writing database');
        }
    }

    if (request.method === 'GET' && pathname === '/api/config') {
        return jsonResponse({
            googleClientId: process.env.ID_CLIENTE || '',
            googleDriveFolderId: process.env.GDRIVE_FOLDER_ID || '',
        });
    }

    if (request.method === 'GET' && pathname === '/api/whatsapp/status') {
        return jsonResponse({
            success: true,
            status: whatsappState.status,
            qrReady: Boolean(whatsappState.qrDataUrl),
            qrDataUrl: whatsappState.qrDataUrl,
            qrGeneratedAt: whatsappState.qrGeneratedAt,
            qrExpiresAt: whatsappState.qrExpiresAt,
            info: whatsappState.info,
            lastError: whatsappState.lastError,
            lastEventAt: whatsappState.lastEventAt,
        });
    }

    if (request.method === 'POST' && pathname === '/api/whatsapp/init') {
        initializeWhatsApp().catch((error) => {
            setWhatsappState('error', {
                lastError: error.message,
            });
        });

        return jsonResponse({
            success: true,
            status: whatsappState.status,
        });
    }

    if (request.method === 'POST' && pathname === '/api/whatsapp/restart') {
        try {
            restartWhatsAppAsync('Reiniciando manualmente la sesion de WhatsApp.');
            return jsonResponse({
                success: true,
                status: whatsappState.status,
            });
        } catch (error) {
            return errorResponse('No se pudo reiniciar WhatsApp', 500, error.message);
        }
    }

    if (request.method === 'POST' && pathname === '/api/whatsapp/disconnect') {
        try {
            await disconnectWhatsAppAsync();
            return jsonResponse({
                success: true,
                status: whatsappState.status,
            });
        } catch (error) {
            return errorResponse('No se pudo desconectar WhatsApp', 500, error.message);
        }
    }

    if (request.method === 'POST' && pathname === '/api/whatsapp/send-report') {
        try {
            const { name, type } = await readRequestJson(request);
            const validTypes = ['receivables', 'payables', 'classes', 'savings'];
            const data = readDB();

            if (!name || !validTypes.includes(type)) {
                return errorResponse('Faltan datos para enviar el reporte', 400);
            }

            if (!whatsappClient || whatsappState.status !== 'ready') {
                return errorResponse('WhatsApp no esta listo todavia', 409);
            }

            const items = Array.isArray(data[type])
                ? data[type].filter((item) => (item.name || item.student || 'Desconocido') === name)
                : [];
            if (!items.length) {
                return errorResponse('No se encontraron registros para esa persona', 404);
            }

            const storedPhone = getGroupPhone(data, name, items);
            const normalizedPhone = normalizeWhatsappNumber(storedPhone);

            if (!normalizedPhone) {
                return errorResponse('La persona no tiene un numero de WhatsApp valido guardado', 400);
            }

            const message = buildGroupReportMessage(name, type, items, {
                locale: 'es-EC',
            });
            await whatsappClient.sendMessage(`${normalizedPhone}@c.us`, message);

            return jsonResponse({
                success: true,
                phone: normalizedPhone,
            });
        } catch (error) {
            if (error.message === 'Invalid JSON body') {
                return errorResponse(error.message, 400);
            }

            return errorResponse('No se pudo enviar el mensaje por WhatsApp', 500, error.message);
        }
    }

    if (request.method === 'POST' && pathname === '/api/drive/upload-db') {
        try {
            const { accessToken, folderId } = await readRequestJson(request);
            const targetFolderId = folderId || process.env.GDRIVE_FOLDER_ID;

            if (!accessToken) {
                return errorResponse('Falta accessToken', 400);
            }

            if (!targetFolderId) {
                return errorResponse('Falta folderId o GDRIVE_FOLDER_ID', 400);
            }

            if (!fs.existsSync(DB_FILE)) {
                return errorResponse('No existe db.json para subir', 404);
            }

            const fileName = 'db.json';
            const fileBuffer = fs.readFileSync(DB_FILE);
            let existingFile = null;
            try {
                existingFile = await findDriveDbFile(accessToken, targetFolderId);
            } catch (error) {
                return errorResponse('Error buscando archivo en Drive', 400, error.message);
            }

            const metadata = existingFile
                ? { name: fileName }
                : { name: fileName, parents: [targetFolderId] };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([fileBuffer], { type: 'application/json' }), fileName);

            const uploadUrl = existingFile
                ? `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=multipart`
                : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

            const uploadResponse = await fetch(uploadUrl, {
                method: existingFile ? 'PATCH' : 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
                body: form,
            });

            const uploadText = await uploadResponse.text();
            if (!uploadResponse.ok) {
                return errorResponse('Error subiendo db.json', 400, uploadText);
            }

            const uploadedFile = JSON.parse(uploadText);
            return jsonResponse({
                success: true,
                action: existingFile ? 'updated' : 'created',
                fileId: uploadedFile.id,
                name: uploadedFile.name,
            });
        } catch (error) {
            if (error.message === 'Invalid JSON body') {
                return errorResponse(error.message, 400);
            }

            return errorResponse('Fallo en subida a Drive', 500, error.message);
        }
    }

    if (request.method === 'POST' && pathname === '/api/drive/restore-db') {
        try {
            const { accessToken, folderId } = await readRequestJson(request);
            const targetFolderId = folderId || process.env.GDRIVE_FOLDER_ID;

            if (!accessToken) {
                return errorResponse('Falta accessToken', 400);
            }

            if (!targetFolderId) {
                return errorResponse('Falta folderId o GDRIVE_FOLDER_ID', 400);
            }

            let driveFile = null;
            try {
                driveFile = await findDriveDbFile(accessToken, targetFolderId);
            } catch (error) {
                return errorResponse('Error buscando archivo en Drive', 400, error.message);
            }

            if (!driveFile) {
                return errorResponse('No se encontró db.json en la carpeta de Drive', 404);
            }

            const downloadResponse = await fetch(
                `https://www.googleapis.com/drive/v3/files/${driveFile.id}?alt=media`,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                }
            );

            if (!downloadResponse.ok) {
                const detail = await downloadResponse.text();
                return errorResponse('Error descargando db.json desde Drive', 400, detail);
            }

            const driveData = ensureDataShape(await downloadResponse.json());
            writeDB(driveData);

            return jsonResponse({
                success: true,
                name: driveFile.name,
                modifiedTime: driveFile.modifiedTime,
                data: driveData,
            });
        } catch (error) {
            if (error.message === 'Invalid JSON body') {
                return errorResponse(error.message, 400);
            }

            return errorResponse('No se pudo restaurar db.json desde Drive', 500, error.message);
        }
    }

    const staticResponse = await serveStaticFile(pathname);
    if (staticResponse) {
        return staticResponse;
    }

    return errorResponse('Not found', 404);
};

const startServer = () => {
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
        const candidatePort = REQUESTED_PORT + attempt;

        try {
            return Bun.serve({
                port: candidatePort,
                fetch: handleRequest,
            });
        } catch (error) {
            if (error.code !== 'EADDRINUSE' || attempt === MAX_PORT_ATTEMPTS - 1) {
                throw error;
            }

            console.warn(`Puerto ${candidatePort} ocupado. Reintentando con ${candidatePort + 1}...`);
        }
    }

    throw new Error('No se encontró un puerto disponible para iniciar el servidor');
};
// Captura cuando cierras el programa con Ctrl+C
process.on('SIGINT', async () => {
    console.log('\nCerrando servidor y limpiando Puppeteer...');
    try {
        if (whatsappClient) {
            await whatsappClient.destroy();
            console.log('WhatsApp cerrado limpiamente.');
        }
    } catch (e) {
        console.error('Error al cerrar WhatsApp:', e.message);
    }
    process.exit(0);
});
// Start Server
const server = startServer();
const activePort = server.port;

console.log('\n==================================================');
console.log('SERVIDOR ACTIVO');
console.log(`Base de datos: ${DB_FILE}`);
console.log(`Abre tu navegador en: http://localhost:${activePort}`);
console.log('==================================================\n');

if (process.platform === 'win32') {
    const { exec } = require('child_process');
    exec(`start http://localhost:${activePort}/index.html`);
}

process.on('SIGINT', () => {
    void shutdownServerAsync('SIGINT');
});

process.on('SIGTERM', () => {
    void shutdownServerAsync('SIGTERM');
});

process.on('SIGBREAK', () => {
    void shutdownServerAsync('SIGBREAK');
});

void server;
