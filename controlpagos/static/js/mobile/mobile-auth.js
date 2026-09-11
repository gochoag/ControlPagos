(function () {
  const TOKEN_KEY = 'controlpagos.deviceToken';
  const DISMISSED_KEY = 'controlpagos.deviceOfferDismissed';
  const native = () => window.NativeApp?.isNativeAndroid?.() === true;
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  async function jsonRequest(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    headers.set('X-CSRF-Token', csrf());
    const response = await fetch(url, { ...options, headers });
    const result = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result?.error || 'No se pudo completar la operación');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function hasToken() {
    return native() && Boolean(await window.NativeApp.secureGet(TOKEN_KEY));
  }

  async function loginWithDevice() {
    const button = document.getElementById('device-login-btn');
    if (button) button.disabled = true;
    try {
      const token = await window.NativeApp.secureGet(TOKEN_KEY);
      if (!token) return;
      await window.NativeApp.authenticate();
      const result = await jsonRequest('/api/auth/device/login', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      window.location.assign(result.redirect || '/');
    } catch (error) {
      if (error.status === 401) {
        await window.NativeApp.secureRemove(TOKEN_KEY);
        document.getElementById('device-login-area')?.classList.add('hidden');
      }
      const message = document.getElementById('device-login-error');
      if (message && !['userCancel', 'systemCancel'].includes(error.code)) {
        message.textContent = error.message || 'No se pudo usar la autenticación del teléfono.';
        message.classList.remove('hidden');
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function initLoginPage() {
    if (!native() || !(await hasToken()) || !(await window.NativeApp.localAuthAvailable())) return;
    document.getElementById('device-login-area')?.classList.remove('hidden');
    document.getElementById('device-login-btn')?.addEventListener('click', loginWithDevice);
    if (!sessionStorage.getItem('controlpagos.biometricPrompted')) {
      sessionStorage.setItem('controlpagos.biometricPrompted', '1');
      setTimeout(loginWithDevice, 350);
    }
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
      window.app?.showToast('Acceso con huella o PIN activado');
    } catch (error) {
      if (!['userCancel', 'systemCancel'].includes(error.code)) {
        window.app?.showToast(error.message || 'No se pudo activar el acceso rápido', 'error');
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
      updateAuthenticatedControls(false);
      window.app?.showToast('Acceso con huella o PIN desactivado');
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
        <div><h2 class="font-semibold text-white">Acceso rápido en este teléfono</h2><p class="mt-1 text-sm text-gray-400">La próxima vez entra con tu huella o PIN, sin guardar tu contraseña.</p></div>
      </div>
      <div class="mt-4 flex justify-end gap-2"><button id="device-offer-later" class="px-4 py-2 text-sm text-gray-400">Ahora no</button><button id="device-offer-enable" class="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white">Activar</button></div>`;
    document.body.appendChild(card);
    card.querySelector('#device-offer-enable').addEventListener('click', enable);
    card.querySelector('#device-offer-later').addEventListener('click', async () => {
      await window.NativeApp.secureSet(DISMISSED_KEY, true);
      card.remove();
    });
  }

  async function initAuthenticatedPage(authMethod) {
    if (!native()) return;
    const enabled = await hasToken();
    updateAuthenticatedControls(enabled);
    if (enabled || authMethod !== 'password') return;
    if (await window.NativeApp.secureGet(DISMISSED_KEY)) return;
    if (await window.NativeApp.localAuthAvailable()) showEnrollmentCard();
  }

  window.MobileAuth = { initLoginPage, initAuthenticatedPage, enable, disable, loginWithDevice };
})();
