
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
