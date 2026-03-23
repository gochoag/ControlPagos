require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { buildGroupReportMessage } = require('./js/reportFormatter');

const app = express();
const PORT = 4343;
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files (HTML, CSS, JS)

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

const restartWhatsAppAsync = async (reason = '') => {
    if (restartInProgress) {
        return;
    }

    restartInProgress = true;

    try {
        await destroyWhatsappClient();
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
            restartWhatsAppAsync('El QR anterior vencio y se esta generando uno nuevo.');
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
            restartWhatsAppAsync('La vinculacion se quedo cargando demasiado tiempo.');
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
            restartWhatsAppAsync('La autenticacion fallo y se esta generando una nueva sesion.');
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
            restartWhatsAppAsync('WhatsApp se desconecto y se esta reintentando la conexion.');
        }, 1500);
    });

    whatsappInitPromise = whatsappClient.initialize().catch(async (error) => {
        setWhatsappState('error', {
            qr: '',
            qrDataUrl: '',
            qrGeneratedAt: null,
            qrExpiresAt: null,
            info: null,
            lastError: error.message,
        });
        await destroyWhatsappClient();
        throw error;
    });

    return whatsappInitPromise;
};

// Routes
app.get('/api/data', (req, res) => {
    try {
        const data = readDB();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Error reading database' });
    }
});

app.post('/api/data', (req, res) => {
    try {
        writeDB(req.body);
        res.json({ success: true, message: 'Saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Error writing database' });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        googleClientId: process.env.ID_CLIENTE || '',
        googleDriveFolderId: process.env.GDRIVE_FOLDER_ID || '',
    });
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json({
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
});

app.post('/api/whatsapp/init', (req, res) => {
    initializeWhatsApp().catch((error) => {
        setWhatsappState('error', {
            lastError: error.message,
        });
    });

    res.json({
        success: true,
        status: whatsappState.status,
    });
});

app.post('/api/whatsapp/restart', async (req, res) => {
    try {
        restartWhatsAppAsync('Reiniciando manualmente la sesion de WhatsApp.');
        res.json({
            success: true,
            status: whatsappState.status,
        });
    } catch (error) {
        res.status(500).json({
            error: 'No se pudo reiniciar WhatsApp',
            detail: error.message,
        });
    }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        await disconnectWhatsAppAsync();
        res.json({
            success: true,
            status: whatsappState.status,
        });
    } catch (error) {
        res.status(500).json({
            error: 'No se pudo desconectar WhatsApp',
            detail: error.message,
        });
    }
});

app.post('/api/whatsapp/send-report', async (req, res) => {
    try {
        const { name, type } = req.body || {};
        const validTypes = ['receivables', 'payables', 'classes', 'savings'];
        const data = readDB();

        if (!name || !validTypes.includes(type)) {
            return res.status(400).json({ error: 'Faltan datos para enviar el reporte' });
        }

        if (!whatsappClient || whatsappState.status !== 'ready') {
            return res.status(409).json({ error: 'WhatsApp no esta listo todavia' });
        }

        const items = Array.isArray(data[type])
            ? data[type].filter((item) => (item.name || item.student || 'Desconocido') === name)
            : [];
        if (!items.length) {
            return res.status(404).json({ error: 'No se encontraron registros para esa persona' });
        }

        const storedPhone = getGroupPhone(data, name, items);
        const normalizedPhone = normalizeWhatsappNumber(storedPhone);

        if (!normalizedPhone) {
            return res.status(400).json({ error: 'La persona no tiene un numero de WhatsApp valido guardado' });
        }

        const message = buildGroupReportMessage(name, type, items, {
            locale: 'es-EC',
        });
        await whatsappClient.sendMessage(`${normalizedPhone}@c.us`, message);

        res.json({
            success: true,
            phone: normalizedPhone,
        });
    } catch (error) {
        res.status(500).json({
            error: 'No se pudo enviar el mensaje por WhatsApp',
            detail: error.message,
        });
    }
});

app.post('/api/drive/upload-db', async (req, res) => {
    try {
        const { accessToken, folderId } = req.body || {};
        const targetFolderId = folderId || process.env.GDRIVE_FOLDER_ID;

        if (!accessToken) {
            return res.status(400).json({ error: 'Falta accessToken' });
        }

        if (!targetFolderId) {
            return res.status(400).json({ error: 'Falta folderId o GDRIVE_FOLDER_ID' });
        }

        if (!fs.existsSync(DB_FILE)) {
            return res.status(404).json({ error: 'No existe db.json para subir' });
        }

        const fileName = 'db.json';
        const fileBuffer = fs.readFileSync(DB_FILE);
        let existingFile = null;
        try {
            existingFile = await findDriveDbFile(accessToken, targetFolderId);
        } catch (error) {
            return res.status(400).json({ error: 'Error buscando archivo en Drive', detail: error.message });
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
            return res.status(400).json({ error: 'Error subiendo db.json', detail: uploadText });
        }

        const uploadedFile = JSON.parse(uploadText);
        res.json({
            success: true,
            action: existingFile ? 'updated' : 'created',
            fileId: uploadedFile.id,
            name: uploadedFile.name,
        });
    } catch (err) {
        res.status(500).json({ error: 'Fallo en subida a Drive', detail: err.message });
    }
});

app.post('/api/drive/restore-db', async (req, res) => {
    try {
        const { accessToken, folderId } = req.body || {};
        const targetFolderId = folderId || process.env.GDRIVE_FOLDER_ID;

        if (!accessToken) {
            return res.status(400).json({ error: 'Falta accessToken' });
        }

        if (!targetFolderId) {
            return res.status(400).json({ error: 'Falta folderId o GDRIVE_FOLDER_ID' });
        }

        let driveFile = null;
        try {
            driveFile = await findDriveDbFile(accessToken, targetFolderId);
        } catch (error) {
            return res.status(400).json({ error: 'Error buscando archivo en Drive', detail: error.message });
        }

        if (!driveFile) {
            return res.status(404).json({ error: 'No se encontró db.json en la carpeta de Drive' });
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
            return res.status(400).json({ error: 'Error descargando db.json desde Drive', detail });
        }

        const driveData = ensureDataShape(await downloadResponse.json());
        writeDB(driveData);

        res.json({
            success: true,
            name: driveFile.name,
            modifiedTime: driveFile.modifiedTime,
            data: driveData,
        });
    } catch (error) {
        res.status(500).json({
            error: 'No se pudo restaurar db.json desde Drive',
            detail: error.message,
        });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log('\n==================================================');
    console.log('SERVIDOR ACTIVO');
    console.log(`Base de datos: ${DB_FILE}`);
    console.log(`Abre tu navegador en: http://localhost:${PORT}`);
    console.log('==================================================\n');

    if (process.platform === 'win32') {
        const { exec } = require('child_process');
        exec(`start http://localhost:${PORT}/index.html`);
    }
});
