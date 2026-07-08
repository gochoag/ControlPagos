const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.join(__dirname, '..');
const helperPath = path.join(projectRoot, 'js', 'receivableData.js');
const appPath = path.join(projectRoot, 'js', 'app.js');

function loadReceivableDataHelpers() {
  if (!fs.existsSync(helperPath)) {
    throw new Error('Missing helper module: js/receivableData.js');
  }

  return require(helperPath);
}

function loadAppForTest({ fetchImpl, localStorageImpl, documentOverrides, contextOverrides } = {}) {
  const appSource = fs.readFileSync(appPath, 'utf8');
  const sidebarBalance = {
    textContent: '',
    classList: {
      remove() {},
      add() {},
    },
  };
  const modalPanel = {
    classList: {
      remove() {},
      add() {},
    },
  };
  const modal = {
    classList: {
      remove() {},
      add() {},
    },
    querySelector(selector) {
      return selector === 'div' ? modalPanel : null;
    },
  };
  const modalTitle = { textContent: '' };
  const modalBody = { innerHTML: '' };
  const modalSaveButton = {
    textContent: '',
    onclick: null,
  };
  const helpers = loadReceivableDataHelpers();
  const window = {
    ControlPagosReportFormatter: {},
    ControlPagosReceivableData: helpers,
  };
  const defaultElements = {
    'sidebar-balance': sidebarBalance,
    'modal-container': modal,
    'modal-title': modalTitle,
    'modal-body': modalBody,
    'modal-save-btn': modalSaveButton,
  };
  const document = {
    getElementById(id) {
      return defaultElements[id] || null;
    },
    addEventListener() {},
    createElement() {
      return {
        setAttribute() {},
        click() {},
        remove() {},
      };
    },
    body: {
      appendChild() {},
    },
    ...documentOverrides,
  };
  const context = {
    window,
    document,
    localStorage: localStorageImpl || {
      getItem() {
        return null;
      },
      setItem() {},
    },
    fetch: fetchImpl,
    console,
    Intl,
    Date,
    JSON,
    encodeURIComponent,
    requestAnimationFrame(callback) {
      callback();
    },
    setTimeout,
    clearTimeout,
    ...contextOverrides,
  };

  vm.runInNewContext(appSource, context, { filename: appPath });
  context.window.app.__testDom = {
    modal,
    title: modalTitle,
    body: modalBody,
    saveButton: modalSaveButton,
  };

  return context.window.app;
}

test('js/receivableData.js exposes the receivable helper contract', () => {
  const helpers = loadReceivableDataHelpers();

  expect(typeof helpers.buildReceivableContacts).toBe('function');
  expect(typeof helpers.sanitizeDataForSave).toBe('function');
});

test('buildReceivableContacts keeps only id and name while merging existing contacts with receivables', () => {
  const { buildReceivableContacts } = loadReceivableDataHelpers();
  const existingContacts = [
    { id: 'existing-1', name: 'Alan', phone: '0999999999', note: 'vip' },
  ];
  const receivables = [
    { name: 'Alan', amount: 25, desc: 'Saldo anterior', phone: '0888888888' },
    { name: 'Brenda', amount: 40, desc: 'Diseno', phone: '0777777777' },
  ];

  const contacts = buildReceivableContacts(existingContacts, receivables);

  expect(contacts).toHaveLength(2);
  expect(contacts[0]).toEqual({ id: 'existing-1', name: 'Alan' });
  expect(contacts[1].name).toBe('Brenda');
  expect(Boolean(contacts[1].id)).toBe(true);
  expect(Object.keys(contacts[1]).sort()).toEqual(['id', 'name']);
});

test('buildReceivableContacts preserves receivable id when creating a new contact entry', () => {
  const { buildReceivableContacts } = loadReceivableDataHelpers();

  const contacts = buildReceivableContacts([], [
    { id: 'receivable-7', name: 'Brenda', amount: 40, desc: 'Diseno', phone: '0777777777' },
  ]);

  expect(contacts).toEqual([
    { id: 'receivable-7', name: 'Brenda' },
  ]);
});

test('sanitizeDataForSave removes phone from receivables and receivableContacts without touching business data', () => {
  const { sanitizeDataForSave } = loadReceivableDataHelpers();
  const data = {
    receivables: [
      { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07', phone: '0999999999' },
      { id: 2, name: 'Brenda', amount: 40, desc: 'Diseno', date: '2026-07-08' },
    ],
    receivableContacts: [
      { id: 'existing-1', name: 'Alan', phone: '0999999999' },
      { id: 'existing-2', name: 'Brenda', phone: '0888888888' },
    ],
    payables: [
      { name: 'Tienda', amount: 15, desc: 'Internet', phone: 'should-stay' },
    ],
    classes: [
      { student: 'Juan', hours: 2, desc: 'Martes' },
    ],
    memberships: [
      { name: 'GPT', cost: 20, active: true },
    ],
    savings: [
      { name: 'Josselin', amount: 10, desc: 'Caja chica' },
    ],
  };

  const sanitized = sanitizeDataForSave(data);

  expect(sanitized.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
    { id: 2, name: 'Brenda', amount: 40, desc: 'Diseno', date: '2026-07-08' },
  ]);
  expect(sanitized.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
    { id: 'existing-2', name: 'Brenda' },
  ]);
  expect(sanitized.payables).toEqual(data.payables);
  expect(sanitized.classes).toEqual(data.classes);
  expect(sanitized.memberships).toEqual(data.memberships);
  expect(sanitized.savings).toEqual(data.savings);
});

test('sanitizeDataForSave normalizes invalid non-receivable collections to arrays', () => {
  const { sanitizeDataForSave } = loadReceivableDataHelpers();

  const sanitized = sanitizeDataForSave({
    receivables: [],
    receivableContacts: [],
    payables: null,
    classes: { student: 'Juan' },
    memberships: 'GPT',
    savings: undefined,
  });

  expect(sanitized.payables).toEqual([]);
  expect(sanitized.classes).toEqual([]);
  expect(sanitized.memberships).toEqual([]);
  expect(sanitized.savings).toEqual([]);
});

test('loadData sanitizes legacy receivable phone data in memory before any manual save', async () => {
  const app = loadAppForTest({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          receivables: [
            { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07', phone: '0999999999' },
          ],
          receivableContacts: [
            { id: 'existing-1', name: 'Alan', phone: '0999999999' },
          ],
          payables: [],
          classes: [],
          memberships: [],
          savings: [],
        };
      },
    }),
  });

  await app.loadData();

  expect(app.data.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(app.data.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
});

test('restaurarDbDesdeDrive sanitizes legacy receivable phone data before localStorage exposure', async () => {
  let savedPayload = null;
  const app = loadAppForTest({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            receivables: [
              { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07', phone: '0999999999' },
            ],
            receivableContacts: [
              { id: 'existing-1', name: 'Alan', phone: '0999999999' },
            ],
            payables: [],
            classes: [],
            memberships: [],
            savings: [],
          },
        };
      },
    }),
    localStorageImpl: {
      getItem() {
        return null;
      },
      setItem(key, value) {
        if (key === 'controlPagosData_v1') {
          savedPayload = JSON.parse(value);
        }
      },
    },
  });

  app.config.googleClientId = 'client-id';
  app.config.googleDriveFolderId = 'folder-id';
  app.googleTokenClient = {};
  app.googleAccessToken = 'token';
  app.navigate = () => {};
  app.showToast = () => {};

  await app.restaurarDbDesdeDrive();

  expect(app.data.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(app.data.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
  expect(savedPayload.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(savedPayload.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
});

test('downloadBackup sanitizes legacy receivable phone data before export', () => {
  let exportedPayload = null;
  const anchor = {
    setAttribute(name, value) {
      if (name === 'href') {
        exportedPayload = JSON.parse(decodeURIComponent(value.split(',')[1]));
      }
    },
    click() {},
    remove() {},
  };
  const app = loadAppForTest({
    documentOverrides: {
      createElement() {
        return anchor;
      },
    },
  });

  app.showToast = () => {};
  app.data = {
    receivables: [
      { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07', phone: '0999999999' },
    ],
    receivableContacts: [
      { id: 'existing-1', name: 'Alan', phone: '0999999999' },
    ],
    payables: [],
    classes: [],
    memberships: [],
    savings: [],
  };

  app.downloadBackup();

  expect(exportedPayload.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(exportedPayload.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
});

test('restoreBackup sanitizes legacy receivable phone data before assigning and persistence', () => {
  let persistedPayload = null;
  class FileReaderStub {
    readAsText(file) {
      this.onload({
        target: {
          result: file.contents,
        },
      });
    }
  }

  const app = loadAppForTest({
    contextOverrides: {
      FileReader: FileReaderStub,
    },
  });

  app.navigate = () => {};
  app.showToast = () => {};
  app.saveData = function saveDataStub() {
    persistedPayload = JSON.parse(JSON.stringify(this.data));
  };

  const input = {
    files: [{
      contents: JSON.stringify({
        receivables: [
          { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07', phone: '0999999999' },
        ],
        receivableContacts: [
          { id: 'existing-1', name: 'Alan', phone: '0999999999' },
        ],
        payables: [],
        classes: [],
        memberships: [],
        savings: [],
      }),
    }],
    value: 'chosen-file.json',
  };

  app.restoreBackup(input);

  expect(app.data.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(app.data.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
  expect(persistedPayload.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(persistedPayload.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
  expect(input.value).toBe('');
});

test('openModal renders receivable and receivable-contact forms without phone fields', () => {
  const app = loadAppForTest();

  app.openModal('receivables', 'Alan');
  expect(app.__testDom.title.textContent).toBe('Registrar Cobro (Deuda ajena)');
  expect(app.__testDom.body.innerHTML).toContain('id="input-name"');
  expect(app.__testDom.body.innerHTML).not.toContain('phone');
  expect(app.__testDom.body.innerHTML).not.toContain('input-phone');
  expect(app.__testDom.body.innerHTML).not.toContain('fa-phone');

  app.openModal('receivable-contact', 'Alan', { isEditing: true });
  expect(app.__testDom.title.textContent).toBe('Editar Cliente');
  expect(app.__testDom.body.innerHTML).toContain('id="input-contact-name"');
  expect(app.__testDom.body.innerHTML).not.toContain('phone');
  expect(app.__testDom.body.innerHTML).not.toContain('input-contact-phone');
  expect(app.__testDom.body.innerHTML).not.toContain('fa-phone');
});

test('saveData strips legacy receivable phone data before localStorage and POST persistence', async () => {
  let savedPayload = null;
  let postedPayload = null;
  const app = loadAppForTest({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/data' && options.body) {
        postedPayload = JSON.parse(options.body);
      }

      return {
        ok: true,
        async json() {
          return {};
        },
      };
    },
    localStorageImpl: {
      getItem() {
        return null;
      },
      setItem(key, value) {
        if (key === 'controlPagosData_v1') {
          savedPayload = JSON.parse(value);
        }
      },
    },
  });

  app.showToast = () => {};
  app.data = {
    receivables: [
      { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07', phone: '0999999999' },
    ],
    receivableContacts: [
      { id: 'existing-1', name: 'Alan', phone: '0999999999' },
    ],
    payables: [],
    classes: [],
    memberships: [],
    savings: [],
  };

  await app.saveData();

  expect(app.data.receivables).toEqual([
    { id: 1, name: 'Alan', amount: 25, desc: 'Saldo anterior', date: '2026-07-07' },
  ]);
  expect(app.data.receivableContacts).toEqual([
    { id: 'existing-1', name: 'Alan' },
  ]);
  expect(savedPayload.receivables).toEqual(app.data.receivables);
  expect(savedPayload.receivableContacts).toEqual(app.data.receivableContacts);
  expect(postedPayload.receivables).toEqual(app.data.receivables);
  expect(postedPayload.receivableContacts).toEqual(app.data.receivableContacts);
});
