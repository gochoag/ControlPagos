const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const serverModulePath = path.join(projectRoot, 'server.js');

test('package.json no longer depends on express or cors', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const dependencies = packageJson.dependencies || {};

  expect(dependencies.express).toBeUndefined();
  expect(dependencies.cors).toBeUndefined();
});

test('iniciar.bat launches bun natively without WSL', () => {
  const launcher = fs.readFileSync(path.join(projectRoot, 'iniciar.bat'), 'utf8').toLowerCase();

  expect(launcher.includes('wsl')).toBe(false);
  expect(launcher.includes('bun server.js')).toBe(true);
});

test('server.js handles default port conflicts gracefully', () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');

  expect(serverSource.includes('EADDRINUSE')).toBe(true);
  expect(serverSource.includes('server.port')).toBe(true);
  expect(serverSource.includes('HAS_CUSTOM_PORT')).toBe(false);
});

test('server.js registers graceful shutdown hooks without reusePort', () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');

  expect(serverSource.includes("process.on('SIGINT'")).toBe(true);
  expect(serverSource.includes("process.on('SIGTERM'")).toBe(true);
  expect(serverSource.includes("process.on('SIGBREAK'")).toBe(true);
  expect(serverSource.includes('reusePort')).toBe(false);
});

test('server.js sanitizes persisted and exported receivable data at the server boundary', () => {
  const serverSource = fs.readFileSync(serverModulePath, 'utf8');
  const { sanitizeStoredData } = require(serverModulePath);

  const sanitized = sanitizeStoredData({
    receivables: [
      { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07', phone: '0999999999' },
    ],
    receivableContacts: [
      { id: 'existing-1', name: 'Alan', phone: '0999999999' },
    ],
    payables: null,
    classes: undefined,
    memberships: 'GPT',
    savings: { name: 'Caja chica' },
  });

  expect(sanitized.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(sanitized.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
  expect(sanitized.payables).toEqual([]);
  expect(sanitized.classes).toEqual([]);
  expect(sanitized.memberships).toEqual([]);
  expect(sanitized.savings).toEqual([]);

  expect(serverSource.includes('const sanitizeStoredData = (data) => sanitizeDataForSave(ensureDataShape(data));')).toBe(true);
  expect(serverSource.includes('const fileBuffer = Buffer.from(JSON.stringify(readDB(), null, 2));')).toBe(true);
  expect(serverSource.includes('const driveData = sanitizeStoredData(await downloadResponse.json());')).toBe(true);
});
