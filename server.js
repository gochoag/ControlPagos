require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 4343;
const DB_FILE = path.join(__dirname, 'db.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files (HTML, CSS, JS)

// Helper to read DB
const readDB = () => {
    if (!fs.existsSync(DB_FILE)) {
        // Initial Seed
        const initialData = {
            receivables: [],
            payables: [],
            classes: [],
            memberships: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data || '{}');
};

// Helper to write DB
const writeDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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
        const newData = req.body;
        writeDB(newData);
        res.json({ success: true, message: 'Saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Error writing database' });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        googleClientId: process.env.ID_CLIENTE || '',
        googleDriveFolderId: process.env.GDRIVE_FOLDER_ID || ''
    });
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
        const escapedFileName = fileName.replace(/'/g, "\\'");
        const query = encodeURIComponent(`name='${escapedFileName}' and '${targetFolderId}' in parents and trashed=false`);

        const searchResponse = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=1`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        if (!searchResponse.ok) {
            const detail = await searchResponse.text();
            return res.status(400).json({ error: 'Error buscando archivo en Drive', detail });
        }

        const searchData = await searchResponse.json();
        const existingFile = Array.isArray(searchData.files) ? searchData.files[0] : null;

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
                Authorization: `Bearer ${accessToken}`
            },
            body: form
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
            name: uploadedFile.name
        });
    } catch (err) {
        res.status(500).json({ error: 'Fallo en subida a Drive', detail: err.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`✅ SERVIDOR ACTIVO`);
    console.log(`📂 Base de datos: ${DB_FILE}`);
    console.log(`🌐 Abre tu navegador en: http://localhost:${PORT}`);
    console.log(`==================================================\n`);
    
    // Auto-open browser (optional, basic logic)
    const { exec } = require('child_process');
    exec(`start http://localhost:${PORT}/index.html`);
});
