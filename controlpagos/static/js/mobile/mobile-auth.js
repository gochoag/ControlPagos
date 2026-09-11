(function () {
  const TOKEN_KEY = 'controlpagos.deviceToken';
  const DISMISSED_KEY = 'controlpagos.deviceOfferDismissed';
  const LAST_ACTIVITY_KEY = 'controlpagos.deviceLastActivityAt';
  const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
  let lastActivityAt = 0;
  let lockTimer;
  let lockEnabled = false;
  let locked = false;
  let unlocking = false;
  let trackingInitialized = false;

  const native = () => window.NativeApp?.isNativeAndroid?.() === true;
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  async function jsonRequest(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    headers.set('X-CSRF-Token', csrf());
    const response = await fetch(url, { ...options, headers });
    const result = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result?.error || 'No se pudo completar la operaci\u00f3n');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function hasToken() {
    return native() && Boolean(await window.NativeApp.secureGet(TOKEN_KEY));
  }

  async function readLastActivity() {
    const value = await window.NativeApp.secureGet(LAST_ACTIVITY_KEY);
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function lockScreen(show) {
    const screen = document.getElementById('app-lock-screen');
    if (!screen) return;
    screen.classList.toggle('hidden', !show);
    screen.classList.toggle('flex', show);
  }

  function showUnlockError(message = '') {
    const error = document.getElementById('app-unlock-error');
    if (!error) return;
    error.textContent = message;
    error.classList.toggle('hidden', !message);
  }

  async function persistActivity() {
    if (lockEnabled && !locked && lastActivityAt) {
      await window.NativeApp.secureSet(LAST_ACTIVITY_KEY, String(lastActivityAt));
    }
  }

  function scheduleLock() {
    clearTimeout(lockTimer);
    if (!lockEnabled || locked || !lastActivityAt) return;
    const remaining = Math.max(0, INACTIVITY_TIMEOUT_MS - (Date.now() - lastActivityAt));
    lockTimer = window.setTimeout(lockForInactivity, remaining);
  }

  function recordActivity() {
    if (!lockEnabled || locked) return;
    lastActivityAt = Date.now();
    scheduleLock();
  }

  function lockForInactivity() {
    if (!lockEnabled || locked) return;
    if (Date.now() - lastActivityAt < INACTIVITY_TIMEOUT_MS) {
      scheduleLock();
      return;
    }
    locked = true;
    clearTimeout(lockTimer);
    showUnlockError();
    lockScreen(true);
  }

  async function checkInactivity() {
    if (!lockEnabled || locked) return;
    if (Date.now() - lastActivityAt >= INACTIVITY_TIMEOUT_MS) lockForInactivity();
    else scheduleLock();
  }

  async function unlock() {
    if (!locked || unlocking) return;
    const button = document.getElementById('app-unlock-btn');
    unlocking = true;
    if (button) button.disabled = true;
    try {
      await window.NativeApp.authenticate();
      locked = false;
      lastActivityAt = Date.now();
      await persistActivity();
      showUnlockError();
      lockScreen(false);
      scheduleLock();
      window.app?.refreshVisibleData?.();
    } catch (error) {
      if (!['userCancel', 'systemCancel'].includes(error.code)) {
        showUnlockError(error.message || 'No se pudo verificar la huella o el PIN.');
      }
    } finally {
      unlocking = false;
      if (button) button.disabled = false;
    }
  }

  function setupActivityTracking() {
    if (trackingInitialized) return;
    trackingInitialized = true;
    ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => {
      document.addEventListener(eventName, recordActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistActivity().catch(() => undefined);
      if (document.visibilityState === 'visible') checkInactivity();
    });
    window.addEventListener('focus', checkInactivity);
    document.getElementById('app-unlock-btn')?.addEventListener('click', unlock);
  }

  async function startSessionLock(freshAuthentication = false) {
    lockEnabled = true;
    setupActivityTracking();
    const savedActivity = freshAuthentication ? 0 : await readLastActivity();
    lastActivityAt = savedActivity || Date.now();
    if (freshAuthentication || !savedActivity) await persistActivity();
    await checkInactivity();
  }

  async function loginWithDevice() {
    const token = await window.NativeApp.secureGet(TOKEN_KEY);
    if (!token) return;
    await window.NativeApp.authenticate();
    const result = await jsonRequest('/api/auth/device/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    window.location.assign(result.redirect || '/');
  }

  async function initLoginPage() {
    // Sin una sesión web activa se solicita usuario y contraseña. La huella/PIN
    // solo protege una sesión ya iniciada y nunca elige una cuenta por sí sola.
    document.getElementById('device-login-area')?.classList.add('hidden');
  }

  async function enable() {
    try {
      if (!(await window.NativeApp.localAuthAvailable())) {
        window.app?.showToast('Configura primero una huella o PIN en Android', 'error');
        return;
      }
      await window.NativeApp.authenticate();
      const result = await jsonRequest('/api/auth/device/register', {
        method: 'POST',
        body: JSON.stringify({ label: 'ControlPagos Android' }),
      });
      await window.NativeApp.secureSet(TOKEN_KEY, result.token);
      await window.NativeApp.secureRemove(DISMISSED_KEY);
      updateAuthenticatedControls(true);
      document.getElementById('device-enrollment-card')?.remove();
      await startSessionLock(true);
      window.app?.showToast('Bloqueo con huella o PIN activado');
    } catch (error) {
      if (!['userCancel', 'systemCancel'].includes(error.code)) {
        window.app?.showToast(error.message || 'No se pudo activar el acceso r\u00e1pido', 'error');
      }
    }
  }

  async function disable() {
    try {
      const token = await window.NativeApp.secureGet(TOKEN_KEY);
      await jsonRequest('/api/auth/device', {
        method: 'DELETE',
        body: JSON.stringify({ token }),
      });
      await window.NativeApp.secureRemove(TOKEN_KEY);
      await window.NativeApp.secureRemove(LAST_ACTIVITY_KEY);
      lockEnabled = false;
      locked = false;
      clearTimeout(lockTimer);
      lockScreen(false);
      updateAuthenticatedControls(false);
      window.app?.showToast('Bloqueo con huella o PIN desactivado');
    } catch (error) {
      window.app?.showToast(error.message, 'error');
    }
  }

  function updateAuthenticatedControls(enabled) {
    document.querySelectorAll('[data-mobile-auth]').forEach((button) => {
      button.classList.toggle('hidden', !native());
      button.innerHTML = enabled
        ? '<i class="fa-solid fa-fingerprint w-7 text-brand-400"></i>Desactivar huella/PIN'
        : '<i class="fa-solid fa-fingerprint w-7 text-brand-400"></i>Activar huella/PIN';
      button.onclick = enabled ? disable : enable;
    });
  }

  function showEnrollmentCard() {
    if (document.getElementById('device-enrollment-card')) return;
    const card = document.createElement('section');
    card.id = 'device-enrollment-card';
    card.className = 'fixed z-50 left-4 right-4 bottom-24 rounded-2xl border border-brand-500/40 bg-gray-800 p-5 shadow-2xl md:left-auto md:w-96';
    card.innerHTML = `
      <div class="flex gap-4">
        <div class="w-11 h-11 shrink-0 rounded-full bg-brand-500/15 text-brand-400 flex items-center justify-center"><i class="fa-solid fa-fingerprint text-xl"></i></div>
        <div><h2 class="font-semibold text-white">Bloqueo en este tel\u00e9fono</h2><p class="mt-1 text-sm text-gray-400">Tras 15 minutos sin usar la app, pide tu huella o PIN. Tu contrase\u00f1a no se guarda.</p></div>
      </div>
      <div class="mt-4 flex justify-end gap-2"><button id="device-offer-later" class="px-4 py-2 text-sm text-gray-400">Ahora no</button><button id="device-offer-enable" class="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white">Activar</button></div>`;
    document.body.appendChild(card);
    card.querySelector('#device-offer-enable').addEventListener('click', enable);
    card.querySelector('#device-offer-later').addEventListener('click', async () => {
      await window.NativeApp.secureSet(DISMISSED_KEY, true);
      card.remove();
    });
  }

  async function initAuthenticatedPage(authMethod, freshAuthentication) {
    if (!native()) return;
    const enabled = await hasToken();
    updateAuthenticatedControls(enabled);
    if (enabled) {
      await startSessionLock(freshAuthentication || authMethod === 'device');
      return;
    }
    if (authMethod !== 'password') return;
    if (await window.NativeApp.secureGet(DISMISSED_KEY)) return;
    if (await window.NativeApp.localAuthAvailable()) showEnrollmentCard();
  }

  window.MobileAuth = { initLoginPage, initAuthenticatedPage, enable, disable, loginWithDevice };
})();
