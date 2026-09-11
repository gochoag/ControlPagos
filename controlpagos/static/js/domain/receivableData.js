(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ControlPagosReceivableData = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function sanitizeEntityName(name) {
    return String(name || "").trim();
  }

  function defaultCreateId() {
    return Date.now() + Math.floor(Math.random() * 1000);
  }

  function ensureArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function buildReceivableContacts(existingContacts, receivables, createId = defaultCreateId) {
    const contactMap = new Map();

    ensureArray(existingContacts).forEach((contact) => {
      const name = sanitizeEntityName(contact && contact.name);
      if (!name || contactMap.has(name)) return;

      contactMap.set(name, {
        id: contact.id || createId(),
        name,
      });
    });

    ensureArray(receivables).forEach((item) => {
      const name = sanitizeEntityName(item && item.name);
      if (!name || contactMap.has(name)) return;

      contactMap.set(name, {
        id: item.id || createId(),
        name,
      });
    });

    return Array.from(contactMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "es", { sensitivity: "base" })
    );
  }

  function sanitizeDataForSave(data, createId = defaultCreateId) {
    const safeData = data && typeof data === "object" ? data : {};
    const receivables = ensureArray(safeData.receivables).map(({ phone, ...item }) => ({
      ...item,
    }));

    return {
      ...safeData,
      receivables,
      payables: ensureArray(safeData.payables),
      classes: ensureArray(safeData.classes),
      memberships: ensureArray(safeData.memberships),
      savings: ensureArray(safeData.savings),
      receivableContacts: buildReceivableContacts(
        safeData.receivableContacts,
        receivables,
        createId
      ),
    };
  }

  return {
    buildReceivableContacts,
    sanitizeDataForSave,
    sanitizeEntityName,
  };
});
