require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sanitizeDataForSave } = require('./js/receivableData.js');

const REQUESTED_PORT = Number(process.env.PORT || 4343);
const MAX_PORT_ATTEMPTS = 10;
const DB_FILE = path.join(__dirname, 'db.json');

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

const sanitizeStoredData = (data) => sanitizeDataForSave(ensureDataShape(data));

const readDB = () => {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = createEmptyData();
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }

    const data = fs.readFileSync(DB_FILE, 'utf8');
    return sanitizeStoredData(JSON.parse(data || '{}'));
};

const writeDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(sanitizeStoredData(data), null, 2));
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

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
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
            const fileBuffer = Buffer.from(JSON.stringify(readDB(), null, 2));
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

            const driveData = sanitizeStoredData(await downloadResponse.json());
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

if (require.main === module) {
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
        console.log('\nCerrando servidor...');
        server.stop(true);
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\nCerrando servidor...');
        server.stop(true);
        process.exit(0);
    });

    process.on('SIGBREAK', () => {
        console.log('\nCerrando servidor...');
        server.stop(true);
        process.exit(0);
    });
}

module.exports = {
    sanitizeStoredData,
    readDB,
    writeDB,
    ensureDataShape,
    createEmptyData,
    handleRequest,
    startServer,
    DB_FILE,
};
