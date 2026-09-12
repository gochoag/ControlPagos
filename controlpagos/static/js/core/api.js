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
      return true;
    } catch (error) {
      console.error("No se pudieron cargar los datos", error);
      this.data = {
        receivables: [], receivableContacts: [], payables: [],
        classes: [], memberships: [], savings: [],
      };
      this.showToast(error.message || "Se requiere conexión", "error");
      return false;
    }
  };

  app.refreshVisibleData = async function ({ force = false, notify = false } = {}) {
    if (navigator.onLine === false || this._foregroundRefreshInProgress) return false;
    const now = Date.now();
    if (!force && now - (this._lastForegroundRefreshAt || 0) < 1000) return false;
    this._lastForegroundRefreshAt = now;
    this._foregroundRefreshInProgress = true;
    const previousData = clone(this.data);
    const previousServerData = this._serverData ? clone(this._serverData) : null;
    try {
      await this._syncQueue.catch(() => undefined);
      const loaded = await this.loadData();
      if (loaded) {
        this.navigate(this.currentView);
        if (notify) this.showToast("Datos actualizados");
      }
      else {
        this.data = previousData;
        this._serverData = previousServerData;
        this.updateSidebarBalance();
      }
      return loaded;
    } finally {
      this._foregroundRefreshInProgress = false;
    }
  };

  app.setupPullToRefresh = function () {
    const container = document.getElementById("app-scroll-container");
    const indicator = document.getElementById("pull-refresh-indicator");
    if (!container || !indicator || container.dataset.pullRefreshReady) return;
    container.dataset.pullRefreshReady = "true";

    const threshold = 72;
    const maximum = 108;
    let startY = 0;
    let distance = 0;
    let pulling = false;
    let refreshing = false;

    const reset = () => {
      distance = 0;
      pulling = false;
      indicator.style.setProperty("--pull-distance", "0px");
      indicator.classList.remove("is-visible", "is-ready", "is-loading");
      indicator.querySelector("i")?.classList.replace("fa-arrows-rotate", "fa-arrow-down");
    };

    const updateIndicator = () => {
      indicator.style.setProperty("--pull-distance", `${distance}px`);
      indicator.classList.toggle("is-visible", distance > 8);
      indicator.classList.toggle("is-ready", distance >= threshold);
    };

    container.addEventListener("touchstart", (event) => {
      if (refreshing || container.scrollTop > 0 || event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
      distance = 0;
      pulling = true;
    }, { passive: true });

    container.addEventListener("touchmove", (event) => {
      if (!pulling || refreshing) return;
      const delta = event.touches[0].clientY - startY;
      if (delta <= 0) {
        reset();
        return;
      }
      distance = Math.min(maximum, Math.round(delta * 0.52));
      updateIndicator();
      if (event.cancelable) event.preventDefault();
    }, { passive: false });

    const finishPull = async () => {
      if (!pulling || refreshing) return;
      if (distance < threshold) {
        reset();
        return;
      }
      refreshing = true;
      pulling = false;
      indicator.classList.remove("is-ready");
      indicator.classList.add("is-visible", "is-loading");
      indicator.style.setProperty("--pull-distance", "0px");
      indicator.querySelector("i")?.classList.replace("fa-arrow-down", "fa-arrows-rotate");
      await this.refreshVisibleData({ force: true, notify: true });
      refreshing = false;
      reset();
    };

    container.addEventListener("touchend", finishPull, { passive: true });
    container.addEventListener("touchcancel", reset, { passive: true });
  };

  app.init = async function () {
    this.loadTheme();
    const authMethod = document.querySelector('meta[name="auth-method"]')?.content || 'unknown';
    const freshAuthentication = document.querySelector('meta[name="auth-fresh"]')?.content === 'true';
    await window.MobileAuth?.initAuthenticatedPage(authMethod, freshAuthentication).catch((error) => {
      console.warn('No se pudo inicializar el acceso rápido', error);
    });
    await this.loadData();
    this.navigate("dashboard");
    this.updateOnlineStatus();
    this._lastForegroundRefreshAt = Date.now();
    window.addEventListener("online", () => {
      this.updateOnlineStatus();
      this.loadData().then(() => this.navigate(this.currentView));
    });
    window.addEventListener("offline", () => this.updateOnlineStatus());
    window.addEventListener("focus", () => this.refreshVisibleData());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.refreshVisibleData();
    });
    this.setupPullToRefresh();
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
