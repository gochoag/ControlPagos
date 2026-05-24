const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

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
