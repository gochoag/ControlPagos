(function () {
  const app = window.app;
  const resources = ["receivables", "payables", "classes", "memberships", "savings"];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const comparable = (value) => {
    const normalized = { ...value };
    ["amount", "cost", "hours"].forEach((key) => {
      if (key in normalized && normalized[key] !== "") normalized[key] = Number(normalized[key]);
    });
    ["name", "student", "desc"].forEach((key) => {
      if (key in normalized) normalized[key] = String(normalized[key] || "").trim();
    });
    if ("isNote" in normalized || "amount" in normalized) normalized.isNote = Boolean(normalized.isNote);
    if ("active" in normalized) normalized.active = Boolean(normalized.active);
    return JSON.stringify(normalized, Object.keys(normalized).sort());
  };

  app._serverData = null;
  app._syncQueue = Promise.resolve();
  app._idAliases = new Map();

  app.getCsrfToken = function () {
    return document.querySelector('meta[name="csrf-token"]')?.content || "";
  };

  app.apiRequest = async function (url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    if (options.method && options.method !== "GET") {
      headers.set("X-CSRF-Token", this.getCsrfToken());
    }

    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      window.location.assign("/login");
      throw new Error("La sesión terminó");
    }
    const result = response.status === 204
      ? null
      : await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || "No se pudo completar la operación");
    }
    return result;
  };

  app.loadData = async function () {
    try {
      this.data = this.receivableData.sanitizeDataForSave(await this.apiRequest("/api/data"));
      this._serverData = clone(this.data);
      localStorage.removeItem("controlPagosData_v1");
      this.syncReceivableContacts();
      this.updateSidebarBalance();
    } catch (error) {
      console.error("No se pudieron cargar los datos", error);
      this.data = {
        receivables: [], receivableContacts: [], payables: [],
        classes: [], memberships: [], savings: [],
      };
      this.showToast(error.message || "Se requiere conexión", "error");
    }
  };

  app.init = async function () {
    await this.loadData();
    this.loadTheme();
    this.navigate("dashboard");
    this.updateOnlineStatus();
    const authMethod = document.querySelector('meta[name="auth-method"]')?.content || 'unknown';
    window.MobileAuth?.initAuthenticatedPage(authMethod).catch((error) => {
      console.warn('No se pudo inicializar el acceso rápido', error);
    });
    window.addEventListener("online", () => {
      this.updateOnlineStatus();
      this.loadData().then(() => this.navigate(this.currentView));
    });
    window.addEventListener("offline", () => this.updateOnlineStatus());
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch((error) => {
        console.warn("No se pudo registrar la PWA", error);
      });
    }
  };

  app.updateOnlineStatus = function () {
    const online = navigator.onLine !== false;
    document.getElementById("offline-banner")?.classList.toggle("hidden", online);
    document.querySelectorAll("[data-requires-online]").forEach((element) => {
      element.disabled = !online;
    });
  };

  app._requestRecord = async function (method, resource, item) {
    const suffix = method === "POST" ? "" : `/${item.id}`;
    return this.apiRequest(`/api/${resource}${suffix}`, {
      method,
      body: method === "DELETE" ? undefined : JSON.stringify(item),
    });
  };

  app._syncCollection = async function (resource, previousItems, desiredItems, mode = "all") {
    desiredItems.forEach((item) => {
      const aliasKey = `${resource}:${item.id}`;
      if (this._idAliases.has(aliasKey)) item.id = this._idAliases.get(aliasKey);
    });
    const previous = new Map(previousItems.map((item) => [String(item.id), item]));
    const desired = new Map(desiredItems.map((item) => [String(item.id), item]));

    if (mode !== "upserts") {
      for (const oldItem of previousItems) {
        if (!desired.has(String(oldItem.id))) {
          await this._requestRecord("DELETE", resource, oldItem);
        }
      }
    }
    if (mode === "deletes") return;
    for (const item of desiredItems) {
      const oldItem = previous.get(String(item.id));
      if (!oldItem) {
        const temporaryId = item.id;
        const created = await this._requestRecord("POST", resource, item);
        this._idAliases.set(`${resource}:${temporaryId}`, created.id);
        item.id = created.id;
        const liveItem = (this.data[resource] || []).find((entry) => entry.id === temporaryId);
        if (liveItem) liveItem.id = created.id;
      } else if (comparable(oldItem) !== comparable(item)) {
        await this._requestRecord("PATCH", resource, item);
      }
    }
  };

  app._syncDesiredState = async function (desired) {
    if (!this._serverData) this._serverData = await this.apiRequest("/api/data");
    await this._syncCollection(
      "receivableContacts",
      this._serverData.receivableContacts || [],
      desired.receivableContacts || [],
      "upserts"
    );
    for (const resource of resources) {
      await this._syncCollection(
        resource,
        this._serverData[resource] || [],
        desired[resource] || []
      );
    }
    await this._syncCollection(
      "receivableContacts",
      this._serverData.receivableContacts || [],
      desired.receivableContacts || [],
      "deletes"
    );
    this._serverData = clone(desired);
  };

  app.saveData = function () {
    if (navigator.onLine === false) {
      this.showToast("Se requiere conexión para modificar datos", "error");
      if (this._serverData) this.data = clone(this._serverData);
      this.navigate(this.currentView);
      return Promise.resolve(false);
    }
    this.syncReceivableContacts();
    this.data = this.receivableData.sanitizeDataForSave(this.data);
    this.updateSidebarBalance();
    const desired = clone(this.data);
    this._syncQueue = this._syncQueue
      .then(() => this._syncDesiredState(desired))
      .catch(async (error) => {
        console.error("Error al sincronizar", error);
        this.showToast(error.message || "No se guardaron los cambios", "error");
        await this.loadData();
        this.navigate(this.currentView);
      });
    return this._syncQueue;
  };

  app._downloadFile = async function (url, fallbackName) {
    const response = await fetch(url);
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('La sesión terminó');
    }
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'No se pudo crear la copia de seguridad');
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackName;
    const blob = await response.blob();

    if (window.NativeApp?.isNativeAndroid?.()) {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo preparar el archivo'));
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
        reader.readAsDataURL(blob);
      });
      await window.NativeApp.saveAndShareFile(filename, base64);
      return;
    }

    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  };

  app.downloadBackup = async function () {
    try {
      await this._downloadFile('/api/backup', 'controlpagos_backup.json');
      this.showToast('Respaldo JSON preparado');
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  };

  app.downloadDatabaseBackup = async function () {
    if (!window.confirm('La copia SQLite contiene también usuarios y credenciales cifradas. ¿Crear la copia completa?')) return;
    try {
      await this._downloadFile('/api/backup/database', 'controlpagos.sqlite3');
      this.showToast('Copia completa preparada');
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  };

  app.restoreBackup = async function (input) {
    const file = input.files[0];
    if (!file) return;
    if (!window.confirm("Este respaldo reemplazará todos los datos actuales. ¿Continuar?")) {
      input.value = "";
      return;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await this.apiRequest("/api/backup/restore", {
        method: "POST",
        body: form,
      });
      this.data = this.receivableData.sanitizeDataForSave(result.data);
      this._serverData = clone(this.data);
      this.navigate(this.currentView);
      this.showToast("Datos restaurados correctamente");
    } catch (error) {
      this.showToast(error.message, "error");
    } finally {
      input.value = "";
    }
  };

  if (typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", () => app.init());
  }
})();
