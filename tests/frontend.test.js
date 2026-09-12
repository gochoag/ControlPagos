const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.join(__dirname, '..');
const staticRoot = path.join(projectRoot, 'controlpagos', 'static');
const helperPath = path.join(staticRoot, 'js', 'domain', 'receivableData.js');
const appPath = path.join(staticRoot, 'js', 'core', 'app.js');
const apiPath = path.join(staticRoot, 'js', 'core', 'api.js');

test('sanitization removes legacy phone fields and preserves business data', () => {
  const { sanitizeDataForSave } = require(helperPath);
  const result = sanitizeDataForSave({
    receivables: [{ id: 1, name: 'Ana', amount: 10, phone: '0999' }],
    receivableContacts: [{ id: 2, name: 'Ana', phone: '0999' }],
    payables: [], classes: [], memberships: [], savings: [],
  });

  expect(result.receivables).toEqual([{ id: 1, name: 'Ana', amount: 10 }]);
  expect(result.receivableContacts).toEqual([{ id: 2, name: 'Ana' }]);
});

test('contact helper merges names without duplicates', () => {
  const { buildReceivableContacts } = require(helperPath);
  const result = buildReceivableContacts(
    [{ id: 1, name: 'Ana' }],
    [{ id: 2, name: 'Ana' }, { id: 3, name: 'Beto' }]
  );
  expect(result).toEqual([{ id: 1, name: 'Ana' }, { id: 3, name: 'Beto' }]);
});

function loadApp() {
  const panel = { classList: { add() {}, remove() {} } };
  const elements = {
    'modal-container': {
      classList: { add() {}, remove() {} },
      querySelector() { return panel; },
    },
    'modal-title': { textContent: '' },
    'modal-body': { innerHTML: '' },
    'modal-save-btn': { textContent: '', onclick: null },
  };
  const window = {
    ControlPagosReportFormatter: {},
    ControlPagosReceivableData: require(helperPath),
  };
  const context = {
    window,
    document: {
      getElementById(id) { return elements[id] || null; },
      addEventListener() {},
      querySelectorAll() { return []; },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    console,
    Intl,
    Date,
    requestAnimationFrame(callback) { callback(); },
    setTimeout,
  };
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), context);
  return { app: window.app, elements };
}

test('receivable and contact forms contain no phone inputs', () => {
  const { app, elements } = loadApp();
  app.openModal('receivables', 'Ana');
  expect(elements['modal-body'].innerHTML).not.toContain('phone');
  app.openModal('receivable-contact', 'Ana', { isEditing: true });
  expect(elements['modal-body'].innerHTML).not.toContain('phone');
});

test('API layer uses record-level writes and clears legacy financial storage', () => {
  const source = fs.readFileSync(apiPath, 'utf8');
  expect(source).toContain('_requestRecord("POST"');
  expect(source).toContain('_requestRecord("PATCH"');
  expect(source).toContain('_requestRecord("DELETE"');
  expect(source).toContain('localStorage.removeItem("controlPagosData_v1")');
  expect(source).not.toContain('localStorage.setItem("controlPagosData_v1"');
});

test('Google Drive OAuth is no longer loaded by the interface', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'controlpagos', 'templates', 'index.html'), 'utf8');
  expect(html).not.toContain('accounts.google.com/gsi/client');
  expect(html).not.toContain('drive-actions');
});

test('visual assets are local and do not depend on a CDN', () => {
  const templates = ['index.html', 'login.html']
    .map((name) => fs.readFileSync(path.join(projectRoot, 'controlpagos', 'templates', name), 'utf8'))
    .join('\n');
  expect(templates).not.toContain('cdn.tailwindcss.com');
  expect(templates).not.toContain('cdnjs.cloudflare.com');
  expect(templates).not.toContain('fonts.googleapis.com');
  expect(templates).toContain('/static/css/style.css');
  expect(fs.existsSync(path.join(staticRoot, 'vendor', 'fontawesome', 'css', 'all.min.css'))).toBe(true);
});

test('Android backup uses the native bridge and desktop uses a browser download', () => {
  const source = fs.readFileSync(apiPath, 'utf8');
  expect(source).toContain('saveAndShareFile');
  expect(source).toContain("'/api/backup/database'");
  expect(source).toContain('URL.createObjectURL');
});

test('mobile login supports device authentication without storing a password', () => {
  const source = fs.readFileSync(path.join(staticRoot, 'js', 'mobile', 'mobile-auth.js'), 'utf8');
  expect(source).toContain('/api/auth/device/login');
  expect(source).toContain('secureSet(TOKEN_KEY');
  expect(source).not.toContain('secureSet(PASSWORD');
  expect(source).not.toContain("secureSet('password'");
});

test('Android refreshes data on return and locks only after inactivity', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');
  const mobileSource = fs.readFileSync(path.join(staticRoot, 'js', 'mobile', 'mobile-auth.js'), 'utf8');
  expect(apiSource).toContain('refreshVisibleData');
  expect(apiSource).toContain('visibilitychange');
  expect(mobileSource).toContain('INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000');
  expect(mobileSource).toContain("document.getElementById('device-login-area')?.classList.add('hidden')");
  expect(mobileSource).not.toContain('setTimeout(loginWithDevice');
});

test('mobile has pull to refresh, keeps the header above cards, and uses the web launcher icon', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');
  const appSource = fs.readFileSync(appPath, 'utf8');
  const html = fs.readFileSync(path.join(projectRoot, 'controlpagos', 'templates', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(staticRoot, 'css', 'source.css'), 'utf8');
  const manifest = fs.readFileSync(path.join(projectRoot, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const launcher = fs.readFileSync(path.join(projectRoot, 'mobile', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_controlpagos_launcher.xml'), 'utf8');
  expect(apiSource).toContain('setupPullToRefresh');
  expect(apiSource).toContain('const threshold = 72');
  expect(html).toContain('id="pull-refresh-indicator"');
  expect(css).toContain('.app-header { z-index: 60; isolation: isolate; }');
  expect(appSource).toContain('group-delete');
  expect(manifest).toContain('@drawable/ic_controlpagos_launcher');
  expect(launcher).toContain('#3CA6A6');
  expect(launcher).toContain('#012E40');
});

test('mobile groups keep actions on the edge and refresh without a success toast', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');
  const appSource = fs.readFileSync(appPath, 'utf8');
  const html = fs.readFileSync(path.join(projectRoot, 'controlpagos', 'templates', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(staticRoot, 'css', 'source.css'), 'utf8');
  expect(apiSource).not.toContain('Datos actualizados');
  expect(appSource).toContain('window.matchMedia');
  expect(css).toContain('.group-summary > .fa-chevron-down');
  expect(css).toContain('.group-edit { top: 5.35rem; right: 6.15rem; }');
  expect(css).toContain('.group-copy { top: 5.35rem; right: 3.4rem; }');
  expect(css).toContain('top: 5.85rem;');
  expect(html).toContain('/static/css/style.css?v=9');
  expect(html).toContain('/static/js/core/api.js?v=9');
  expect(html).not.toContain("app.navigate('dashboard'); toggleMobileMenu()");
  expect(html).not.toContain("app.navigate('receivables'); toggleMobileMenu()");
});

test('the invisible toast never captures taps over Android navigation', () => {
  const css = fs.readFileSync(path.join(staticRoot, 'css', 'source.css'), 'utf8');
  expect(css).toContain('#toast { pointer-events: none; }');
});

test('temporary IDs are mapped independently for contacts and receivables', async () => {
  const fakeApp = {
    data: {
      receivableContacts: [{ id: 999, name: 'Ana' }],
      receivables: [{ id: 999, name: 'Ana', amount: '10' }],
    },
  };
  const context = {
    window: { app: fakeApp, addEventListener() {}, location: { assign() {} } },
    document: { querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } },
    navigator: { onLine: true },
    localStorage: { removeItem() {} },
    Headers,
    FormData,
    fetch,
    console,
    JSON,
    Map,
    Promise,
  };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8'), context);
  fakeApp._requestRecord = async (_method, resource) => ({
    id: resource === 'receivableContacts' ? 10 : 20,
  });

  await fakeApp._syncCollection('receivableContacts', [], fakeApp.data.receivableContacts);
  await fakeApp._syncCollection('receivables', [], fakeApp.data.receivables);

  expect(fakeApp.data.receivableContacts[0].id).toBe(10);
  expect(fakeApp.data.receivables[0].id).toBe(20);
});

test('sync only patches locally changed records', async () => {
  const fakeApp = {
    data: { receivableContacts: [], receivables: [], payables: [], classes: [], memberships: [], savings: [] },
  };
  const context = {
    window: { app: fakeApp, addEventListener() {}, location: { assign() {} } },
    document: { querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } },
    navigator: { onLine: true },
    localStorage: { removeItem() {} },
    Headers, FormData, fetch, console, JSON, Map, Promise,
  };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8'), context);
  fakeApp._serverData = {
    receivableContacts: [],
    receivables: [
      { id: 1, name: 'Ana', amount: '10', desc: '', date: '2026-09-01T00:00:00Z' },
      { id: 2, name: 'Beto', amount: '20', desc: '', date: '2026-09-01T00:00:00Z' },
    ],
    payables: [], classes: [], memberships: [], savings: [],
  };
  const desired = JSON.parse(JSON.stringify(fakeApp._serverData));
  desired.receivables[1].amount = '21.00';
  const writes = [];
  fakeApp._requestRecord = async (method, resource, item) => {
    writes.push({ method, resource, id: item.id });
    return item;
  };

  await fakeApp._syncDesiredState(desired);

  expect(writes).toEqual([{ method: 'PATCH', resource: 'receivables', id: 2 }]);
  expect(fakeApp._serverData.receivables[1].amount).toBe('21.00');
});
