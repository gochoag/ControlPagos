const app = {
  data: {
    receivables: [], // Deben (Jimy, Alan, etc)
    receivableContacts: [], // Ficha persistente de clientes por cobrar
    payables: [], // Debo (Tienda, Gualpa)
    classes: [], // Horas Clases (Juan)
    memberships: [], // Membresias (GPT)
  },
  currentView: "dashboard",
  config: {
    googleClientId: "",
    googleDriveFolderId: "",
  },
  googleTokenClient: null,
  googleAccessToken: "",
  oauthTokenPromiseResolvers: null,
  themes: [
    { id: 'green-cascade', name: 'Green Cascade' },
    { id: 'deep-purple', name: 'Deep Purple' },
    { id: 'midnight-blue', name: 'Midnight Blue' }
  ],
  currentThemeIndex: 0,
  reportFormatter: window.ControlPagosReportFormatter,
  driveMenuOpen: false,
    backupMenuOpen: false,


    async init() {
        await this.loadPublicConfig();
        this.initGoogleOAuth();
        await this.loadData();
        this.loadTheme();
        this.navigate('dashboard');
    },

    async loadPublicConfig() {
        try {
            const response = await fetch('/api/config');
            if (!response.ok) throw new Error('No se pudo cargar configuración pública');
            this.config = await response.json();
        } catch (error) {
            console.warn('No se pudo cargar configuración de Google Drive', error);
        }
    },

    initGoogleOAuth() {
        if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
            return;
        }
        if (!this.config.googleClientId) {
            return;
        }

        this.googleTokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: this.config.googleClientId,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: (tokenResponse) => {
                if (tokenResponse.error) {
                    if (this.oauthTokenPromiseResolvers) {
                        this.oauthTokenPromiseResolvers.reject(new Error(tokenResponse.error));
                        this.oauthTokenPromiseResolvers = null;
                    }
                    return;
                }

                this.googleAccessToken = tokenResponse.access_token;
                if (this.oauthTokenPromiseResolvers) {
                    this.oauthTokenPromiseResolvers.resolve(this.googleAccessToken);
                    this.oauthTokenPromiseResolvers = null;
                }
            },
        });
    },

    requestGoogleAccessToken(promptMode = 'consent') {
        return new Promise((resolve, reject) => {
            if (!this.googleTokenClient) {
                reject(new Error('OAuth de Google no inicializado'));
                return;
            }

            this.oauthTokenPromiseResolvers = { resolve, reject };
            this.googleTokenClient.requestAccessToken({ prompt: promptMode });
        });
    },

    async loadData() {
        try {
            // Try fetching from Server (db.json)
            const response = await fetch('/api/data');
            if (response.ok) {
                this.data = await response.json();
                console.log('Data loaded from Server');
            } else {
                throw new Error('Server not responding');
            }
        } catch (e) {
            console.warn("Server unavailable, falling back to LocalStorage", e);
            // Fallback
            const stored = localStorage.getItem('controlPagosData_v1');
            if (stored) {
                try {
                    this.data = JSON.parse(stored);
                } catch (parseErr) {
                    this.data = { receivables: [], receivableContacts: [], payables: [], classes: [], memberships: [], savings: [] };
                }
            } else {
                this.data = { receivables: [], receivableContacts: [], payables: [], classes: [], memberships: [], savings: [] };
                // Don't auto-save seed to server yet to avoid overwriting invalid state
            }
        }
        
        // Ensure structure matches schema
        if (!this.data.receivables) this.data.receivables = [];
        if (!this.data.receivableContacts) this.data.receivableContacts = [];
        if (!this.data.payables) this.data.payables = [];
        if (!this.data.classes) this.data.classes = [];
        if (!this.data.memberships) this.data.memberships = [];
        if (!this.data.savings) this.data.savings = [];
        this.syncReceivableContacts();

        this.updateSidebarBalance();
    },

    async saveData() {
        this.syncReceivableContacts();
        // 1. Save locally immediately for speed/backup
        localStorage.setItem('controlPagosData_v1', JSON.stringify(this.data));
        this.updateSidebarBalance();

        // 2. Sync to Server (db.json)
        try {
            await fetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.data)
            });
            console.log('Data synced to db.json');
        } catch (e) {
            console.error("Failed to save to db.json", e);
            this.showToast('Error: No se guardó en el archivo (Solo Local)', 'error');
        }
    },

    downloadBackup() {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.data, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "control_pagos_backup_" + new Date().toISOString().slice(0,10) + ".json");
        document.body.appendChild(downloadAnchorNode); // required for firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        this.showToast('Copia de seguridad descargada');
    },

    restoreBackup(input) {
        const file = input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target.result);
                if (json.receivables && json.payables) {
                    this.data = json;
                    if(!this.data.savings) this.data.savings = []; // Ensure compatibility with old backups
                    this.saveData();
                    this.navigate(this.currentView);
                    this.showToast('Datos restaurados correctamente');
                } else {
                    this.showToast('Formato incorrecto');
                }
            } catch (err) {
                this.showToast('Error al leer archivo');
            }
        };
        reader.readAsText(file);
        input.value = '';
    },

    async subirDbADrive() {
        try {
            if (!this.config.googleClientId) {
                this.showToast('Falta ID_CLIENTE en configuración', 'error');
                return;
            }

            if (!this.config.googleDriveFolderId) {
                this.showToast('Falta GDRIVE_FOLDER_ID en configuración', 'error');
                return;
            }

            if (!this.googleTokenClient) {
                this.initGoogleOAuth();
            }

            if (!this.googleTokenClient) {
                this.showToast('No se pudo iniciar OAuth de Google', 'error');
                return;
            }

            const token = this.googleAccessToken || await this.requestGoogleAccessToken('consent');

            const response = await fetch('/api/drive/upload-db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessToken: token,
                    folderId: this.config.googleDriveFolderId,
                })
            });

            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || 'No se pudo subir db.json a Drive');
            }

            if (result.action === 'updated') {
                this.showToast('db.json actualizado en Google Drive');
            } else {
                this.showToast('db.json subido a Google Drive');
            }
        } catch (error) {
            console.error('Error al subir db.json a Drive:', error);
            this.showToast('Error al subir db.json a Drive', 'error');
        }
    },

    async restaurarDbDesdeDrive() {
        try {
            if (!this.config.googleClientId) {
                this.showToast('Falta ID_CLIENTE en configuración', 'error');
                return;
            }

            if (!this.config.googleDriveFolderId) {
                this.showToast('Falta GDRIVE_FOLDER_ID en configuración', 'error');
                return;
            }

            if (!this.googleTokenClient) {
                this.initGoogleOAuth();
            }

            if (!this.googleTokenClient) {
                this.showToast('No se pudo iniciar OAuth de Google', 'error');
                return;
            }

            const token = this.googleAccessToken || await this.requestGoogleAccessToken('consent');

            const response = await fetch('/api/drive/restore-db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessToken: token,
                    folderId: this.config.googleDriveFolderId,
                })
            });

            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || result.detail || 'No se pudo restaurar db.json desde Drive');
            }

            this.data = result.data;
            this.syncReceivableContacts();
            localStorage.setItem('controlPagosData_v1', JSON.stringify(this.data));
            this.updateSidebarBalance();
            this.navigate(this.currentView);
            this.showToast('Datos restaurados desde Google Drive');
        } catch (error) {
            console.error('Error al restaurar db.json desde Drive:', error);
            this.showToast(error.message || 'Error al restaurar desde Drive', 'error');
        }
    },

    toggleDriveMenu() {
        this.driveMenuOpen = !this.driveMenuOpen;
        const menu = document.getElementById('drive-actions');
        const chevron = document.getElementById('drive-chevron');
        if (menu) {
            menu.classList.toggle('hidden', !this.driveMenuOpen);
        }
        if (chevron) {
            chevron.style.transform = this.driveMenuOpen ? 'rotate(180deg)' : '';
        }
    },

    closeDriveMenu() {
        this.driveMenuOpen = false;
        const menu = document.getElementById('drive-actions');
        const chevron = document.getElementById('drive-chevron');
        if (menu) {
            menu.classList.add('hidden');
        }
        if (chevron) {
            chevron.style.transform = '';
        }
    },

    toggleBackupMenu() {
        this.backupMenuOpen = !this.backupMenuOpen;
        const menu = document.getElementById('backup-actions');
        const chevron = document.getElementById('backup-chevron');
        if (menu) {
            menu.classList.toggle('hidden', !this.backupMenuOpen);
        }
        if (chevron) {
            chevron.style.transform = this.backupMenuOpen ? 'rotate(180deg)' : '';
        }
    },

    closeBackupMenu() {
        this.backupMenuOpen = false;
        const menu = document.getElementById('backup-actions');
        const chevron = document.getElementById('backup-chevron');
        if (menu) {
            menu.classList.add('hidden');
        }
        if (chevron) {
            chevron.style.transform = '';
        }
    },

  navigate(view) {
    this.currentView = view;

    // Update styling for nav items
    document.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.remove(
        "bg-brand-600",
        "text-white",
        "shadow-lg",
        "shadow-brand-500/20"
      );
      el.classList.add("text-gray-300");
    });
    const activeNav = document.getElementById(`nav-${view}`);
    if (activeNav) {
      activeNav.classList.add(
        "bg-brand-600",
        "text-white",
        "shadow-lg",
        "shadow-brand-500/20"
      );
      activeNav.classList.remove("text-gray-300");
    }

    const main = document.getElementById("main-view");
    main.innerHTML = "";
    main.classList.remove("opacity-0");

    // Simple View Router
    switch (view) {
      case "dashboard":
        this.renderDashboard(main);
        break;
      case "receivables":
        this.renderGenericList(
          main,
          "receivables",
          "Cuentas por Cobrar (Deben)",
          "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
        );
        break;
      case "payables":
        this.renderGenericList(
          main,
          "payables",
          "Cuentas por Pagar (Debo)",
          "bg-rose-500/10 text-rose-400 border-rose-500/20"
        );
        break;
      case "classes":
        this.renderClasses(main);
        break;
      case "savings":
        this.renderGenericList(
          main,
          "savings",
          "Ahorros (Terceros)",
          "bg-blue-500/10 text-blue-400 border-blue-500/20"
        );
        break;
      case "memberships":
        this.renderMemberships(main);
        break;
    }

    // Animation Entrance
    main.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 300, easing: "ease-out" }
    );
  },

  updateSidebarBalance() {
    const totalReceivable = this.data.receivables.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );
    const totalPayable = this.data.payables.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );
    const balance = totalReceivable - totalPayable;

    const el = document.getElementById("sidebar-balance");
    el.textContent = this.formatMoney(balance);
    el.classList.remove("text-emerald-400", "text-rose-400", "text-white");
    if (balance > 0) el.classList.add("text-emerald-400");
    else if (balance < 0) el.classList.add("text-rose-400");
    else el.classList.add("text-white");
  },

  sanitizeEntityName(name) {
    return String(name || "").trim();
  },

  syncReceivableContacts() {
    const existingContacts = Array.isArray(this.data.receivableContacts)
      ? this.data.receivableContacts
      : [];
    const contactMap = new Map();

    existingContacts.forEach((contact) => {
      const name = this.sanitizeEntityName(contact.name);
      if (!name) return;

      const normalizedPhone = this.normalizePhoneInput(contact.phone || "");
      contactMap.set(name, {
        id: contact.id || Date.now() + Math.floor(Math.random() * 1000),
        name,
        phone: normalizedPhone === null ? "" : normalizedPhone,
      });
    });

    this.data.receivables.forEach((item) => {
      const name = this.sanitizeEntityName(item.name);
      if (!name) return;

      const normalizedPhone = this.normalizePhoneInput(item.phone || "");
      if (!contactMap.has(name)) {
        contactMap.set(name, {
          id: Date.now() + Math.floor(Math.random() * 1000),
          name,
          phone: normalizedPhone && normalizedPhone !== null ? normalizedPhone : "",
        });
        return;
      }

      const current = contactMap.get(name);
      if (!current.phone && normalizedPhone && normalizedPhone !== null) {
        current.phone = normalizedPhone;
      }
    });

    this.data.receivableContacts = Array.from(contactMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "es", { sensitivity: "base" })
    );
  },

  getReceivableContact(name) {
    const cleanName = this.sanitizeEntityName(name);
    return (this.data.receivableContacts || []).find((contact) => contact.name === cleanName) || null;
  },

  upsertReceivableContact(name, phone = "") {
    const cleanName = this.sanitizeEntityName(name);
    if (!cleanName) return null;

    const normalizedPhone = this.normalizePhoneInput(phone || "");
    const safePhone = normalizedPhone === null ? "" : normalizedPhone;
    const existing = this.getReceivableContact(cleanName);

    if (existing) {
      existing.phone = safePhone || existing.phone || "";
      return existing;
    }

    const contact = {
      id: Date.now(),
      name: cleanName,
      phone: safePhone,
    };
    this.data.receivableContacts.push(contact);
    this.syncReceivableContacts();
    return contact;
  },

  renameReceivableContact(oldName, newName, phone = "") {
    const cleanOldName = this.sanitizeEntityName(oldName);
    const cleanNewName = this.sanitizeEntityName(newName);
    if (!cleanNewName) return false;

    const normalizedPhone = this.normalizePhoneInput(phone || "");
    if (normalizedPhone === null) return null;

    const targetPhone = normalizedPhone || "";
    const currentContact = this.getReceivableContact(cleanOldName);
    const duplicateContact = this.getReceivableContact(cleanNewName);

    this.data.receivables.forEach((item) => {
      if ((item.name || "") === cleanOldName) {
        item.name = cleanNewName;
      }
      if ((item.name || "") === cleanNewName) {
        if (targetPhone) item.phone = targetPhone;
        else delete item.phone;
      }
    });

    if (duplicateContact && duplicateContact !== currentContact) {
      duplicateContact.phone = targetPhone || duplicateContact.phone || "";
      this.data.receivableContacts = this.data.receivableContacts.filter(
        (contact) => contact !== currentContact
      );
    } else if (currentContact) {
      currentContact.name = cleanNewName;
      currentContact.phone = targetPhone;
    } else {
      this.data.receivableContacts.push({
        id: Date.now(),
        name: cleanNewName,
        phone: targetPhone,
      });
    }

    this.syncReceivableContacts();
    return true;
  },

  getGroupedCollection(type) {
    const sourceItems = (this.data[type] || []).map((item, originalIndex) => ({
      ...item,
      originalIndex,
    }));
    const grouped = {};

    if (type === "receivables") {
      this.syncReceivableContacts();
      (this.data.receivableContacts || []).forEach((contact) => {
        grouped[contact.name] = {
          total: 0,
          items: [],
          phone: contact.phone || "",
        };
      });
    }

    sourceItems.forEach((item) => {
      const name = item.name || item.student || "Desconocido";
      if (!grouped[name]) {
        grouped[name] = { total: 0, items: [], phone: "" };
      }

      grouped[name].items.push(item);

      if (type === "receivables") {
        grouped[name].phone = grouped[name].phone || this.getGroupPhone(name, type) || "";
      } else if (!grouped[name].phone && item.phone) {
        grouped[name].phone = item.phone;
      }

      if (!item.isNote) {
        grouped[name].total += Number(type === "classes" ? item.hours : item.amount);
      }
    });

    return grouped;
  },

  // --- RENDERERS ---

  renderDashboard(container) {
    const totalReceivable = this.data.receivables.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );
    const totalPayable = this.data.payables.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );
    const totalHours = this.data.classes.reduce(
      (sum, item) => sum + Number(item.hours || 0),
      0
    );
    const activeMemberships = this.data.memberships.filter(
      (m) => m.active
    ).length;

    container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                ${this.createSummaryCard(
                  "Por Cobrar",
                  this.formatMoney(totalReceivable),
                  "fa-hand-holding-dollar",
                  "text-emerald-400",
                  "from-emerald-500/20 to-teal-500/5",
                  "12 pendientes"
                )}
                ${this.createSummaryCard(
                  "Por Pagar",
                  this.formatMoney(totalPayable),
                  "fa-money-bill-transfer",
                  "text-rose-400",
                  "from-rose-500/20 to-pink-500/5",
                  "3 deudas"
                )}
                ${this.createSummaryCard(
                  "Horas Clases",
                  totalHours + " hrs",
                  "fa-clock",
                  "text-indigo-400",
                  "from-indigo-500/20 to-blue-500/5",
                  "Acumuladas"
                )}
                ${this.createSummaryCard(
                  "Membresías",
                  activeMemberships,
                  "fa-id-badge",
                  "text-amber-400",
                  "from-amber-500/20 to-orange-500/5",
                  "Activas"
                )}
            </div>

            <!-- Recent Activity / Quick Actions could go here -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4">
                <div class="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6 backdrop-blur-xl">
                    <h3 class="text-lg font-semibold text-white mb-4 flex items-center">
                        <i class="fa-solid fa-bolt text-yellow-400 mr-2"></i> Acciones Rápidas
                    </h3>
                    <div class="grid grid-cols-2 gap-4">
                        <button onclick="app.openModal('receivables')" class="p-4 rounded-xl bg-gray-700/50 hover:bg-gray-700 border border-gray-600 transition group text-left">
                            <div class="bg-emerald-500/20 w-10 h-10 rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition">
                                <i class="fa-solid fa-plus text-emerald-400"></i>
                            </div>
                            <span class="text-gray-300 text-sm">Registrar Cobro</span>
                        </button>
                        <button onclick="app.openModal('payables')" class="p-4 rounded-xl bg-gray-700/50 hover:bg-gray-700 border border-gray-600 transition group text-left">
                             <div class="bg-rose-500/20 w-10 h-10 rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition">
                                <i class="fa-solid fa-plus text-rose-400"></i>
                            </div>
                            <span class="text-gray-300 text-sm">Registrar Deuda</span>
                        </button>
                    </div>
                </div>
                
                <div class="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6 backdrop-blur-xl">
                    <h3 class="text-lg font-semibold text-white mb-4">Estado Financiero</h3>
                    <div class="flex items-center justify-between p-4 bg-gray-700/30 rounded-xl mb-3">
                         <span class="text-gray-400">Balance Neto</span>
                         <span class="text-2xl font-bold ${
                           totalReceivable - totalPayable >= 0
                             ? "text-emerald-400"
                             : "text-rose-400"
                         }">
                            ${this.formatMoney(totalReceivable - totalPayable)}
                         </span>
                    </div>
                    <p class="text-xs text-center text-gray-500">Calculado automáticamente basado en tus registros.</p>
                </div>
            </div>
        `;
  },

  createSummaryCard(title, value, icon, colorClass, gradientClass, subtitle) {
    return `
            <div class="bg-gradient-to-br ${gradientClass} border border-white/5 rounded-2xl p-6 backdrop-blur-md relative overflow-hidden group">
                <div class="absolute -right-4 -top-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <i class="fa-solid ${icon} text-9xl ${colorClass}"></i>
                </div>
                <div class="relative z-10">
                    <div class="flex items-center justify-between mb-4">
                        <span class="text-gray-400 font-medium">${title}</span>
                        <div class="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center backdrop-blur-sm">
                            <i class="fa-solid ${icon} ${colorClass}"></i>
                        </div>
                    </div>
                    <h2 class="text-3xl font-bold text-white mb-1">${value}</h2>
                    <p class="text-xs text-gray-500">${subtitle}</p>
                </div>
            </div>
        `;
  },

    renderGenericList(container, type, title, tagClass, colorClass) { // colorClass added for dynamic coloring
        const searchTerm = (this.searchState && this.searchState[type]) || '';
        const grouped = this.getGroupedCollection(type);
        let groupEntries = Object.entries(grouped);

        if (searchTerm) {
            const lowerTerm = searchTerm.toLowerCase();
            groupEntries = groupEntries.filter(([name, group]) => {
                const descriptionText = group.items.map((item) => item.desc || "").join(" ").toLowerCase();
                const phone = (group.phone || "").toLowerCase();
                return name.toLowerCase().includes(lowerTerm) || descriptionText.includes(lowerTerm) || phone.includes(lowerTerm);
            });
        }

        let html = `
            <div class="flex justify-between items-center gap-4 mb-6">
                <div>
                    <h2 class="text-2xl font-bold text-white">${title}</h2>
                    <p class="text-gray-400 text-sm mt-1">Gestión por persona/entidad</p>
                </div>
                <button onclick="app.openModal('${type}')" class="bg-brand-600 hover:bg-brand-500 text-white px-5 py-2.5 rounded-xl shadow-lg shadow-brand-500/20 flex items-center space-x-2 transition-all active:scale-95">
                    <i class="fa-solid fa-plus"></i>
                    <span>Agregar Nuevo</span>
                </button>
            </div>

            <div class="mb-6">
                <div class="relative">
                    <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <i class="fa-solid fa-magnifying-glass text-gray-500"></i>
                    </div>
                    <input type="text" 
                        oninput="app.updateSearch('${type}', this.value)" 
                        value="${(this.searchState && this.searchState[type]) || ''}"
                        class="block w-full pl-10 pr-3 py-2 border border-gray-700 rounded-xl leading-5 bg-gray-800 text-gray-300 placeholder-gray-500 focus:outline-none focus:bg-gray-700 focus:border-brand-500/50 transition duration-150 ease-in-out sm:text-sm" 
                        placeholder="Buscar por nombre o descripción...">
                </div>
            </div>

            <div class="flex flex-col space-y-4">
        `;

        if (groupEntries.length === 0) {
             html += `<div class="text-center py-20 text-gray-500 bg-gray-800/50 rounded-2xl border border-gray-700/50 border-dashed">No hay registros aún.</div>`;
        } else {
            groupEntries.forEach(([key, group]) => {
                const cleanId = key.replace(/[^a-zA-Z0-9]/g, '');
                const escapedKey = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const showEditContactAction = type === 'receivables';
                const debtItems = group.items.filter(item => !item.isNote);
                const hasDebt = debtItems.length > 0;
                const deleteAction = type === 'receivables'
                    ? (hasDebt
                        ? `app.confirmDeleteGroup('${type}', '${escapedKey}')`
                        : `app.confirmDeleteReceivableContact('${escapedKey}')`)
                    : `app.confirmDeleteGroup('${type}', '${escapedKey}')`;
                const deleteTitle = type === 'receivables'
                    ? (hasDebt ? 'Borrar deuda pendiente' : 'Borrar cliente')
                    : 'Borrar historial completo';
                const deleteIcon = type === 'receivables'
                    ? (hasDebt ? 'fa-solid fa-fire' : 'fa-solid fa-user-xmark')
                    : 'fa-solid fa-fire';
                
                html += `
                <div class="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden mb-4 shadow-lg shadow-black/20">
                    <!-- Header -->
                    <button onclick="app.toggleAccordion('${cleanId}')" class="w-full flex items-center justify-between p-5 bg-gradient-to-r from-gray-800 to-gray-800/50 hover:from-gray-700 hover:to-gray-700/50 transition-all duration-300 text-left group border-b border-transparent hover:border-gray-600">
                        <div class="flex items-center space-x-4">
                            <div class="w-10 h-10 rounded-full ${tagClass.split(' ')[0]} flex items-center justify-center text-lg font-bold">
                                ${key.charAt(0).toUpperCase()}
                            </div>
                            <div>
                                <h3 class="text-lg font-bold text-white group-hover:text-brand-400 transition">${key}</h3>
                                <p class="text-xs text-gray-400">${group.items.length} registro(s)</p>
                                ${group.phone ? `<p class="text-xs text-brand-400 mt-1"><i class="fa-solid fa-phone mr-1"></i>${group.phone}</p>` : ''}
                            </div>
                        </div>
                        <div class="flex items-center space-x-4">
                            <span class="text-xl font-bold text-white mr-2">
                                ${type === 'classes' ? group.total + ' hrs' : this.formatMoney(group.total)}
                            </span>
                             ${showEditContactAction ? `
                             <span onclick="event.stopPropagation(); app.openReceivableContactModal('${escapedKey}')" class="w-8 h-8 rounded-full bg-gray-700 hover:bg-sky-600 flex items-center justify-center text-gray-300 hover:text-white transition-colors mr-2 z-20" title="Editar cliente">
                                <i class="fa-solid fa-user-pen"></i>
                             </span>
                             ` : ''}
                             <!-- Copy Button -->
                             <span onclick="event.stopPropagation(); app.copyGroupDetails('${escapedKey}', '${type}')" class="w-8 h-8 rounded-full ${hasDebt ? 'bg-gray-700 hover:bg-brand-600 text-gray-300 hover:text-white' : 'bg-gray-700 text-gray-500'} flex items-center justify-center transition-colors mr-2 z-20" title="${hasDebt ? 'Copiar detalle' : 'No hay deuda pendiente para copiar'}">
                                <i class="fa-regular fa-copy"></i>
                             </span>
                             <!-- Delete Group Button -->
                             <span onclick="event.stopPropagation(); ${deleteAction}" class="w-8 h-8 rounded-full bg-gray-700 hover:bg-rose-600 flex items-center justify-center text-gray-300 hover:text-white transition-colors mr-2 z-20" title="${deleteTitle}">
                                <i class="${deleteIcon}"></i>
                             </span>
                             <i id="icon-${cleanId}" class="fa-solid fa-chevron-down text-gray-400 transition-transform duration-300 ${this.currentAccordionState && this.currentAccordionState[cleanId] ? 'rotate-180' : ''}"></i>
                        </div>
                    </button>
                    
                    <!-- Body (Collapsed by default unless previously open) -->
                    <div id="body-${cleanId}" class="${this.currentAccordionState && this.currentAccordionState[cleanId] ? '' : 'hidden'} border-t border-gray-700/50 bg-gray-900/50">
                        <div class="p-2 space-y-1">
                `;

                // Individual Items
                group.items.forEach(subItem => {
                    if (subItem.isNote) {
                        // NOTE RENDER
                        html += `
                        <div class="flex justify-between items-start p-3 m-1 rounded-lg bg-yellow-500/10 border border-yellow-500/20 hover:bg-yellow-500/20 transition group/item">
                            <div class="flex-1">
                                <span class="text-[10px] font-bold text-yellow-500 uppercase tracking-wider mb-1 block"><i class="fa-regular fa-note-sticky mr-1"></i> Nota</span>
                                <p class="text-yellow-200/90 text-sm whitespace-pre-wrap italic">"${subItem.desc}"</p>
                                <span class="text-xs text-yellow-500/50 mt-1 block">${new Date(subItem.date).toLocaleDateString()}</span>
                            </div>
                            <div class="flex flex-col items-end pl-4 space-y-2">
                                <button onclick="app.editItem('${type}', ${subItem.originalIndex})" class="text-yellow-500 hover:text-white transition text-xs flex items-center bg-yellow-500/10 hover:bg-yellow-500 px-2 py-1 rounded" title="Editar Nota">
                                    <i class="fa-solid fa-pencil"></i>
                                </button>
                                <button onclick="app.deleteItem('${type}', ${subItem.originalIndex})" class="text-yellow-500 hover:text-white transition text-xs flex items-center bg-yellow-500/10 hover:bg-rose-500 px-2 py-1 rounded">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </div>
                        `;
                    } else {
                        // STANDARD ITEM RENDER
                        html += `
                        <div class="flex justify-between items-start p-3 rounded-lg hover:bg-white/5 transition group/item">
                            <div class="flex-1">
                                <p class="text-gray-300 text-sm whitespace-pre-wrap">${subItem.desc || 'Sin descripción'}</p>
                                <span class="text-xs text-gray-500 mt-1 block">${new Date(subItem.date).toLocaleDateString()} &bull; ${new Date(subItem.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                            </div>
                            <div class="flex flex-col items-end pl-4">
                                <span class="font-bold ${type === 'classes' ? 'text-indigo-400' : (type === 'receivables' ? 'text-emerald-400' : 'text-rose-400')}">
                                    ${type === 'classes' ? subItem.hours + 'h' : this.formatMoney(subItem.amount)}
                                </span>
                                <div class="flex space-x-1 mt-2 opacity-0 group-hover/item:opacity-100 transition">
                                    <button onclick="app.editItem('${type}', ${subItem.originalIndex})" class="text-brand-400 hover:text-white text-xs flex items-center bg-brand-500/10 hover:bg-brand-500 px-2 py-1 rounded" title="Editar">
                                        <i class="fa-solid fa-pencil"></i>
                                    </button>
                                    <button onclick="app.deleteItem('${type}', ${subItem.originalIndex})" class="text-rose-500 hover:text-white text-xs flex items-center bg-rose-500/10 hover:bg-rose-500 px-2 py-1 rounded" title="Borrar">
                                        <i class="fa-solid fa-trash-can"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                        `;
                    }
                });

                // Add quick action within accordion
                html += `
                            <div class="p-4 mt-2 bg-gray-800/50 rounded-xl border border-dashed border-gray-700">
                                <p class="text-xs text-brand-400 font-bold mb-2 uppercase tracking-wide">Agregar nuevo registro a ${key}</p>
                                <div class="flex flex-col md:flex-row gap-2">
                                     <input onkeyup="if(event.key === 'Enter') app.saveInlineItem('${type}', '${escapedKey}', '${cleanId}')" type="number" id="inline-amount-${cleanId}" placeholder="${type === 'classes' ? 'Horas' : 'Monto ($)'}" step="${type === 'classes' ? '0.5' : '0.01'}" class="w-32 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-brand-500 outline-none font-bold">
                                    <input onkeyup="if(event.key === 'Enter') app.saveInlineItem('${type}', '${escapedKey}', '${cleanId}')" type="text" id="inline-desc-${cleanId}" placeholder="Descripción..." class="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-brand-500 outline-none">
                                    <button onclick="app.saveInlineItem('${type}', '${escapedKey}', '${cleanId}')" class="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded-lg text-sm transition shadow-lg shadow-brand-500/20">
                                        <i class="fa-solid fa-paper-plane"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>`;
            });
        }

        html += `</div>`;
        container.innerHTML = html;
        // this.currentAccordionState = {}; // Keep state for seamless interactions
    },

    toggleAccordion(id) {
        const body = document.getElementById(`body-${id}`);
        const icon = document.getElementById(`icon-${id}`);
        if(body.classList.contains('hidden')) {
            body.classList.remove('hidden');
            icon.classList.add('rotate-180');
        } else {
            body.classList.add('hidden');
            icon.classList.remove('rotate-180');
        }
    },

  renderClasses(container) {
    this.renderGenericList(
      container,
      "classes",
      "Control de Horas Clases",
      "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
    );
  },

  renderMemberships(container) {
    const items = this.data.memberships;
    let html = `
            <div class="flex justify-between items-center">
                <h2 class="text-2xl font-bold text-white">Membresías</h2>
                <button onclick="app.openModal('memberships')" class="bg-brand-600 hover:bg-brand-500 text-white px-5 py-2.5 rounded-xl shadow-lg shadow-brand-500/20 flex items-center space-x-2 transition-all active:scale-95">
                    <i class="fa-solid fa-plus"></i>
                    <span>Nueva Membresía</span>
                </button>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
         `;

    items.forEach((item, index) => {
      html += `
                <div class="bg-gradient-to-br from-amber-500/10 to-transparent border border-amber-500/20 rounded-2xl p-6 relative">
                    <div class="flex justify-between items-start mb-4">
                        <div class="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-xl">
                            <i class="fa-solid fa-star"></i>
                        </div>
                        <div class="px-2 py-1 rounded bg-green-500/20 text-green-400 text-xs font-bold border border-green-500/20">ACTIVA</div>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-1">${
                      item.name
                    }</h3>
                    <p class="text-3xl font-bold text-white mb-2">${this.formatMoney(
                      item.cost
                    )}</p>
                    ${ item.nextPayment ? 
                        `<p class="text-sm text-brand-400 font-semibold mb-2"><i class="fa-regular fa-calendar mr-1"></i>Pagar el: ${new Date(item.nextPayment + 'T00:00:00').toLocaleDateString()}</p>` 
                        : '' 
                    }
                    <p class="text-sm text-gray-400 mb-6 line-clamp-2">${
                      item.desc || "Sin descripción"
                    }</p>
                    
                    <div class="flex space-x-2 mt-4">
                        <button onclick="app.editItem('memberships', ${index})" class="flex-1 py-2 rounded-lg bg-brand-500/10 hover:bg-brand-500 hover:text-white text-brand-400 transition text-sm font-medium border border-brand-500/20">
                            Editar
                        </button>
                        <button onclick="app.deleteItem('memberships', ${index})" class="flex-1 py-2 rounded-lg bg-gray-700 hover:bg-rose-500/20 hover:text-rose-400 text-gray-300 transition text-sm font-medium border border-gray-600 hover:border-rose-500/30">
                            Cancelar
                        </button>
                    </div>
                </div>
             `;
    });
    html += "</div>";
    container.innerHTML = html;
  },

  // --- MODAL & FORMS ---

  openModal(type, prefillName = '', options = {}) {
    const { isEditing = false } = options;
    if (!isEditing) {
      this.editingIndex = null;
    }
    const modal = document.getElementById("modal-container");
    const title = document.getElementById("modal-title");
    const body = document.getElementById("modal-body");
    const saveBtn = document.getElementById("modal-save-btn");
    saveBtn.textContent = isEditing ? "Actualizar" : "Guardar";

    modal.classList.remove("hidden");
    // Small delay to allow display:block to apply before opacity transition
    requestAnimationFrame(() => {
      modal.querySelector("div").classList.remove("scale-95", "opacity-0");
    });

    let formHtml = "";

    if (type === "receivable-contact") {
      const contact = this.getReceivableContact(prefillName);
      this.editingContactOriginalName = contact ? contact.name : prefillName;
      title.textContent = "Editar Cliente";
      formHtml = `
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Nombre del cliente</label>
                    <input type="text" id="input-contact-name" value="${contact?.name || prefillName || ''}" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Ej. Jimmy">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Teléfono</label>
                    <input type="text" id="input-contact-phone" value="${contact?.phone || ''}" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Ej. +593 00 000 0000">
                    <p class="text-xs text-gray-500 mt-1">Puedes dejarlo vacio si todavia no tienes el numero.</p>
                </div>
            `;
      saveBtn.onclick = () => this.saveReceivableContact();
    } else if (type === "receivables" || type === "payables") {
      title.textContent =
        type === "receivables"
          ? "Registrar Cobro (Deuda ajena)"
          : "Registrar Deuda (Propia)";
      formHtml = `
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Nombre (Persona/Entidad)</label>
                    <input type="text" id="input-name" value="${prefillName}" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Ej. Juan, Tienda...">
                </div>
                 <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Monto ($)</label>
                    <input type="number" step="0.01" id="input-amount" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="0.00">
                </div>
                ${type === "receivables" ? `
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Teléfono (opcional)</label>
                    <input type="text" id="input-phone" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Ej. +593 00 000 0000 o 096 292 0000">
                    <p class="text-xs text-gray-500 mt-1">Acepta formatos como <code>+593 00 000 0000</code>, <code>0962900000</code> o <code>096 292 0000</code>.</p>
                </div>
                ` : ''}
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Descripción / Evidencia</label>
                    <textarea id="input-desc" rows="3" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Detalles del trabajo o deuda..."></textarea>
                </div>
            `;
      saveBtn.onclick = () => this.saveItem(type);
    } else if (type === "classes") {
      title.textContent = "Registrar Horas de Clase";
      formHtml = `
                 <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Estudiante</label>
                    <input type="text" id="input-student" value="${prefillName}" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Ej. Juan">
                </div>
                 <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Horas Pendientes</label>
                    <input type="number" step="0.5" id="input-hours" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="0">
                </div>
                 <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Detalles</label>
                    <textarea id="input-desc" rows="2" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition"></textarea>
                </div>
            `;
      saveBtn.onclick = () => this.saveItem(type);
    } else if (type === "memberships") {
      title.textContent = "Nueva Membresía";
      formHtml = `
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Servicio</label>
                    <input type="text" id="input-name" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Ej. GPT Plus">
                </div>
                 <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Costo ($)</label>
                    <input type="number" step="0.01" id="input-cost" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="0.00">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Próximo Pago</label>
                    <input type="date" id="input-date" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Descripción</label>
                    <input type="text" id="input-desc" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition">
                </div>
            `;
      saveBtn.onclick = () => this.saveItem(type);
    } else if (type === "savings") {
      title.textContent = "Registrar Ahorro (Tercero)";
      formHtml = `
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Nombre (Dueño del dinero)</label>
                    <input type="text" id="input-name" value="${prefillName}" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Ej. Josselin">
                </div>
                 <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Monto ($)</label>
                    <input type="number" step="0.01" id="input-amount" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="0.00">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-400 mb-1">Descripción</label>
                    <textarea id="input-desc" rows="3" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition" placeholder="Origen del dinero..."></textarea>
                </div>
            `;
      saveBtn.onclick = () => this.saveItem(type);
    }

    body.innerHTML = formHtml;
  },

  openReceivableContactModal(name) {
    this.openModal("receivable-contact", name, { isEditing: true });
  },

  closeModal() {
    const modal = document.getElementById("modal-container");
    modal.querySelector("div").classList.add("scale-95", "opacity-0");
    setTimeout(() => {
      modal.classList.add("hidden");
    }, 200);
  },

  saveReceivableContact() {
    const oldName = this.sanitizeEntityName(this.editingContactOriginalName || "");
    const newName = this.sanitizeEntityName(document.getElementById("input-contact-name")?.value || "");
    const rawPhone = document.getElementById("input-contact-phone")?.value || "";
    const normalizedPhone = this.normalizePhoneInput(rawPhone);

    if (!newName) {
      return this.showToast("El nombre del cliente es obligatorio", "error");
    }

    if (normalizedPhone === null) {
      return this.showToast("Numero de telefono invalido. Usa por ejemplo +593 00 000 0000 o 0962900000", "error");
    }

    this.renameReceivableContact(oldName || newName, newName, normalizedPhone || "");
    this.saveData();
    this.closeModal();
    this.navigate(this.currentView);
    this.showToast("Cliente actualizado");
  },

  saveItem(type) {
    const newItem = {
      id: Date.now(),
      date: new Date().toISOString(),
    };

    if (type === "receivables" || type === "payables" || type === "savings") {
      newItem.name = this.sanitizeEntityName(document.getElementById("input-name").value);
      newItem.amount = document.getElementById("input-amount").value;
      newItem.desc = document.getElementById("input-desc").value;
      if (type === "receivables") {
        const phoneInputValue = document.getElementById("input-phone")?.value || "";
        const fallbackPhone = this.getGroupPhone(newItem.name, type) || "";
        const normalizedPhone = this.normalizePhoneInput(phoneInputValue || fallbackPhone);
        if (normalizedPhone === null) {
          return this.showToast("Numero de telefono invalido. Usa por ejemplo +593 00 000 0000 o 0962900000", "error");
        }
        if (normalizedPhone) {
          newItem.phone = normalizedPhone;
        }
      }
      if (!newItem.name || !newItem.amount)
        return this.showToast("Nombre y monto requeridos");
    } else if (type === "classes") {
      newItem.student = document.getElementById("input-student").value;
      newItem.hours = document.getElementById("input-hours").value;
      newItem.desc = document.getElementById("input-desc").value;
      if (!newItem.student || !newItem.hours)
        return this.showToast("Estudiante y horas requeridos");
    } else if (type === "memberships") {
      newItem.name = document.getElementById("input-name").value;
      newItem.cost = document.getElementById("input-cost").value;
      newItem.desc = document.getElementById("input-desc").value;
      newItem.nextPayment = document.getElementById("input-date").value; // Capture date
      newItem.active = true;
      if (!newItem.name || !newItem.cost)
        return this.showToast("Nombre y costo requeridos");
    }

    if (this.editingIndex != null) {
        // Update existing
        const previousItem = this.data[type][this.editingIndex];
        newItem.id = this.data[type][this.editingIndex].id; // Keep ID
        newItem.date = this.data[type][this.editingIndex].date; // Keep original date
        this.data[type][this.editingIndex] = newItem;
        if (type === "receivables") {
          this.renameReceivableContact(previousItem.name, newItem.name, newItem.phone || "");
        }
        this.showToast("Registro actualizado");
        this.editingIndex = null;
    } else {
        // Create new
        this.data[type].push(newItem);
        if (type === "receivables") {
          this.upsertReceivableContact(newItem.name, newItem.phone || "");
        }
        this.showToast("Registro guardado correctamente");
    }

    this.saveData();
    this.closeModal();
    this.navigate(this.currentView); // Refresh current view
  },

  editItem(type, index) {
      this.editingIndex = index;
      this.openModal(type, '', { isEditing: true });
      
      const item = this.data[type][index];
      const title = document.getElementById("modal-title");
      title.textContent = "Editar Registro";
      
      // Populate Fields
      setTimeout(() => {
          if(document.getElementById("input-name")) document.getElementById("input-name").value = item.name || item.student || '';
          if(document.getElementById("input-amount")) document.getElementById("input-amount").value = item.amount || '';
          if(document.getElementById("input-phone")) document.getElementById("input-phone").value = item.phone || this.getGroupPhone(item.name || '', type) || '';
          if(document.getElementById("input-hours")) document.getElementById("input-hours").value = item.hours || '';
          if(document.getElementById("input-cost")) document.getElementById("input-cost").value = item.cost || '';
          if(document.getElementById("input-desc")) document.getElementById("input-desc").value = item.desc || '';
          if(document.getElementById("input-student")) document.getElementById("input-student").value = item.student || '';
          if(document.getElementById("input-date") && item.nextPayment) document.getElementById("input-date").value = item.nextPayment;
      }, 50);
  },

  deleteItem(type, index) {
      // Show custom modal
      const modal = document.getElementById('confirm-modal');
      const content = document.getElementById('confirm-modal-content');
      const confirmBtn = document.getElementById('confirm-delete-btn');
      
      modal.classList.remove('hidden');
      requestAnimationFrame(() => {
          content.classList.remove('scale-95', 'opacity-0');
          content.classList.add('scale-100', 'opacity-100');
      });

      // Bind click event (removing previous listeners to avoid duplicates if any)
      this.setConfirmButtonVariant('danger', 'Eliminar');
      confirmBtn.onclick = () => {
          this.executeDelete(type, index);
      };
      
      // Default text restoration in case it was changed
      modal.querySelector('h3').textContent = '¿Estás seguro?';
      modal.querySelector('p').textContent = 'Esta acción eliminará el registro permanentemente.';
  },

  confirmDeleteGroup(type, name) {
      const modal = document.getElementById('confirm-modal');
      const content = document.getElementById('confirm-modal-content');
      const confirmBtn = document.getElementById('confirm-delete-btn');
      
      // Update Text
      if (type === 'receivables') {
          modal.querySelector('h3').textContent = `¿Borrar deuda de ${name}?`;
          modal.querySelector('p').textContent = `Se eliminarán solo los movimientos de deuda. El cliente y su contacto se conservarán.`;
      } else {
          modal.querySelector('h3').textContent = `¿Limpiar historial de ${name}?`;
          modal.querySelector('p').textContent = `Se borrarán TODOS los registros de ${name}. No podrás deshacer esto.`;
      }

      modal.classList.remove('hidden');
      requestAnimationFrame(() => {
          content.classList.remove('scale-95', 'opacity-0');
          content.classList.add('scale-100', 'opacity-100');
      });

      this.setConfirmButtonVariant('danger', 'Eliminar');
      confirmBtn.onclick = () => {
          this.executeDeleteGroup(type, name);
      };
  },

  confirmDeleteReceivableContact(name) {
      const modal = document.getElementById('confirm-modal');
      const content = document.getElementById('confirm-modal-content');
      const confirmBtn = document.getElementById('confirm-delete-btn');

      modal.querySelector('h3').textContent = `¿Borrar cliente ${name}?`;
      modal.querySelector('p').textContent = `Se borrará la persona y su contacto guardado. Esta acción no se puede deshacer.`;

      modal.classList.remove('hidden');
      requestAnimationFrame(() => {
          content.classList.remove('scale-95', 'opacity-0');
          content.classList.add('scale-100', 'opacity-100');
      });

      this.setConfirmButtonVariant('danger', 'Eliminar');
      confirmBtn.onclick = () => {
          this.executeDeleteReceivableContact(name);
      };
  },

  executeDeleteGroup(type, name) {
      this.data[type] = this.data[type].filter(item => {
          const itemName = item.name || item.student || 'Desconocido';
          return itemName !== name;
      });
      
      this.saveData();
      this.closeConfirmModal();
      this.navigate(this.currentView);
      this.showToast(type === 'receivables' ? `Deuda de ${name} eliminada` : `Historial de ${name} eliminado`);
  },

  executeDeleteReceivableContact(name) {
      const hasDebt = this.data.receivables.some(item => (item.name || 'Desconocido') === name && !item.isNote);
      if (hasDebt) {
          this.closeConfirmModal();
          this.showToast(`No se puede borrar ${name} porque todavía tiene registros`, 'error');
          return;
      }

      this.data.receivableContacts = (this.data.receivableContacts || []).filter(contact => contact.name !== name);
      this.data.receivables = this.data.receivables.filter(item => (item.name || 'Desconocido') !== name);
      this.saveData();
      this.closeConfirmModal();
      this.navigate(this.currentView);
      this.showToast(`Cliente ${name} eliminado`);
  },

  setConfirmButtonVariant(variant = 'danger', label = 'Eliminar', disabled = false) {
      const confirmBtn = document.getElementById('confirm-delete-btn');
      if (!confirmBtn) {
          return;
      }

      confirmBtn.disabled = disabled;
      confirmBtn.textContent = label;

      const baseClass = 'px-5 py-2.5 rounded-xl text-white font-medium transition disabled:opacity-70 disabled:cursor-not-allowed';
      if (variant === 'success') {
          confirmBtn.className = `${baseClass} bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-500/20`;
          return;
      }

      confirmBtn.className = `${baseClass} bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-500/20`;
  },

  resetConfirmModalState() {
      const modal = document.getElementById('confirm-modal');
      const confirmBtn = document.getElementById('confirm-delete-btn');
      if (!modal || !confirmBtn) {
          return;
      }

      modal.querySelector('h3').textContent = '¿Estás seguro?';
      modal.querySelector('p').textContent = 'Esta acción eliminará el registro permanentemente.';
      this.setConfirmButtonVariant('danger', 'Eliminar');
      confirmBtn.onclick = null;
  },

  closeConfirmModal() {
      const modal = document.getElementById('confirm-modal');
      const content = document.getElementById('confirm-modal-content');
      
      content.classList.remove('scale-100', 'opacity-100');
      content.classList.add('scale-95', 'opacity-0');
      
      setTimeout(() => {
          modal.classList.add('hidden');
          this.resetConfirmModalState();
      }, 300);
  },

  copyGroupDetails(name, type) {
      const text = this.buildGroupDetailsText(name, type);
      if(!text) {
          this.showToast('No hay deuda pendiente para copiar', 'error');
          return;
      }

      navigator.clipboard.writeText(text).then(() => {
          this.showToast('Detalle copiado al portapapeles');
      }).catch(err => {
          console.error(err);
          this.showToast('Error al copiar', 'error');
      });
  },

  executeDelete(type, index) {
    
      const item = this.data[type][index];
      let cleanId = null;
      if (item) {
          const name = item.name || item.student || 'Desconocido';
          cleanId = name.replace(/[^a-zA-Z0-9]/g, '');
      }

      this.data[type].splice(index, 1);
      this.saveData();

      if (cleanId) {
          this.currentAccordionState = this.currentAccordionState || {};
          this.currentAccordionState[cleanId] = true;
      }
      
      this.closeConfirmModal();
      this.navigate(this.currentView);
      this.showToast("Registro eliminado");
  },

  // --- UTILS ---
  formatMoney(amount) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  },

  normalizePhoneInput(value) {
      const rawValue = String(value || "").trim();
      if (!rawValue) {
          return "";
      }

      const digits = rawValue.replace(/\D/g, "");
      let normalizedDigits = "";

      if (digits.startsWith("593") && digits.length === 12) {
          normalizedDigits = digits;
      } else if (digits.startsWith("0") && digits.length === 10) {
          normalizedDigits = `593${digits.slice(1)}`;
      } else if (digits.length === 9 && digits.startsWith("9")) {
          normalizedDigits = `593${digits}`;
      } else {
          return null;
      }

      return `+${normalizedDigits.slice(0, 3)} ${normalizedDigits.slice(3, 5)} ${normalizedDigits.slice(5, 8)} ${normalizedDigits.slice(8)}`;
  },

  getGroupPhone(name, type) {
      if (type === 'receivables') {
          const contact = this.getReceivableContact(name);
          if (contact && contact.phone) {
              return contact.phone;
          }
      }

      const groupItems = (this.data[type] || []).filter(item => (item.name || item.student || 'Desconocido') === name);
      const itemWithPhone = groupItems.find(item => item.phone);
      return itemWithPhone ? itemWithPhone.phone : '';
  },

  buildGroupDetailsText(name, type) {
      const items = this.data[type].filter(i => ((i.name || i.student) === name) && !i.isNote);
      if (!items.length || !this.reportFormatter) return "";

      return this.reportFormatter.buildGroupReportMessage(name, type, items, {
          locale: 'es-EC'
      });
  },

  saveInlineItem(type, name, cleanId) {
      const descInput = document.getElementById(`inline-desc-${cleanId}`);
      const amountInput = document.getElementById(`inline-amount-${cleanId}`);
      
      const desc = descInput.value;
      let amount = amountInput.value || 0; // Default to 0 if empty
      
      const isNote = !amountInput.value && desc; // It's a note if amount is empty but desc exists

      if(!amount && !desc) return this.showToast('Digita un monto o una nota', 'error');

      const newItem = {
          id: Date.now(),
          desc: desc,
          date: new Date().toISOString(),
          isNote: isNote // Flag for rendering
      };

      // Map fields based on type
      if (type === 'classes') {
          newItem.student = name; // Use existing name
          newItem.hours = amount;
      } else {
          newItem.name = name; // Use existing name
          newItem.amount = amount;
          if (type === 'receivables') {
              const existingPhone = this.getGroupPhone(name, type);
              if (existingPhone) {
                  newItem.phone = existingPhone;
              }
              this.upsertReceivableContact(name, existingPhone || "");
          }
      }

      this.data[type].push(newItem);
      this.saveData();
      
      // We want to keep this specific accordion open after render
      this.currentAccordionState = this.currentAccordionState || {};
      this.currentAccordionState[cleanId] = true;
      
      this.navigate(this.currentView);
      this.showToast('Agregado correctamente');
      
      // Restore accordion state logic needs to be in navigate/render
      // Since navigate re-renders everything, we need to handle the "open" state there.
      // See renderGenericList below for the modification.
  },

  showToast(msg) {
    const toast = document.getElementById("toast");
    const toastMsg = document.getElementById("toast-message");
    toastMsg.textContent = msg;

    toast.classList.remove("translate-y-20", "opacity-0");

    setTimeout(() => {
      toast.classList.add("translate-y-20", "opacity-0");
    }, 3000);
  },
  updateSearch(type, value) {
      this.searchState = this.searchState || {};
      this.searchState[type] = value;
      this.navigate(this.currentView);
      setTimeout(() => {
          const input = document.querySelector('input[placeholder="Buscar por nombre o descripción..."]');
          if(input) {
              input.focus();
              const len = input.value.length;
              input.setSelectionRange(len, len);
          }
      }, 0);
  },

  loadTheme() {
    const savedThemeIndex = localStorage.getItem('themeIndex');
    if (savedThemeIndex !== null) {
      this.currentThemeIndex = parseInt(savedThemeIndex);
    }
    this.applyTheme();
  },

  applyTheme() {
    const theme = this.themes[this.currentThemeIndex];
    document.documentElement.setAttribute('data-theme', theme.id);
    const themeNameEl = document.getElementById('current-theme-name');
    if (themeNameEl) {
      themeNameEl.textContent = theme.name;
    }
    // Highlight active option in dropdown
    this.themes.forEach((_, i) => {
      const opt = document.getElementById(`theme-opt-${i}`);
      if (!opt) return;
      if (i === this.currentThemeIndex) {
        opt.classList.add('text-white', 'bg-white/10');
      } else {
        opt.classList.remove('text-white', 'bg-white/10');
      }
    });
  },

  setTheme(index) {
    this.currentThemeIndex = index;
    localStorage.setItem('themeIndex', this.currentThemeIndex);
    this.applyTheme();
    this.showToast(`Tema: ${this.themes[index].name}`);
  },

  cycleTheme() {
    this.setTheme((this.currentThemeIndex + 1) % this.themes.length);
  },
};

window.app = app;

// Start App when DOM ready
document.addEventListener("DOMContentLoaded", () => {
  app.init();
});
