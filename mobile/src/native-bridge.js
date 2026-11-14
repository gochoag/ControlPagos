import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

window.NativeApp = {
  isNativeAndroid,

  async localAuthAvailable() {
    if (!isNativeAndroid()) return false;
    const info = await BiometricAuth.checkBiometry();
    return Boolean(info.isAvailable || info.deviceIsSecure);
  },

  async authenticate() {
    if (!isNativeAndroid()) throw new Error('Autenticación local no disponible');
    await BiometricAuth.authenticate({
      reason: 'Acceder a tus datos de ControlPagos',
      allowDeviceCredential: true,
      androidTitle: 'Desbloquear ControlPagos',
      androidSubtitle: 'Usa tu huella o el PIN del teléfono',
      androidConfirmationRequired: false,
      androidBiometryStrength: 1,
    });
  },

  secureGet(key) {
    return SecureStorage.get(key);
  },

  secureSet(key, value) {
    return SecureStorage.set(key, value);
  },

  secureRemove(key) {
    return SecureStorage.remove(key);
  },

  async saveAndShareFile(filename, base64Data) {
    if (!isNativeAndroid()) throw new Error('Guardado nativo no disponible');
    const result = await Filesystem.writeFile({
      path: filename,
      data: base64Data,
      directory: Directory.Cache,
    });
    await Share.share({
      title: filename,
      text: 'Copia de seguridad de ControlPagos',
      files: [result.uri],
      dialogTitle: 'Guardar o compartir respaldo',
    });
    return result.uri;
  },
};

// Un APK sin el plugin App (anterior a la build 2) cuenta como build 0: también debe actualizarse.
async function installedBuild() {
  try {
    return Number((await App.getInfo()).build) || 0;
  } catch {
    return 0;
  }
}

function showUpdateRequired(downloadUrl) {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'update-title');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:#0b0f19;color:#e5e7eb;font-family:system-ui,sans-serif;text-align:center';
  overlay.innerHTML = `
    <div style="max-width:360px">
      <h1 id="update-title" style="font-size:1.4rem;margin:0 0 12px">Actualiza ControlPagos</h1>
      <p style="margin:0 0 24px;line-height:1.5">Hay una versión nueva de la app. Descárgala e instálala para seguir usándola; tus datos están en el servidor y no se pierden.</p>
      <button type="button" style="width:100%;padding:14px;border:0;border-radius:12px;background:#10b981;color:#fff;font-size:1rem;font-weight:600">Descargar actualización</button>
    </div>`;
  // Capacitor abre los dominios externos (GitHub) en el navegador del sistema.
  overlay.querySelector('button').addEventListener('click', () => { window.location.href = downloadUrl; });
  document.body.appendChild(overlay);
  overlay.querySelector('button').focus();
}

async function checkForRequiredUpdate() {
  if (!isNativeAndroid()) return;
  try {
    const response = await fetch('/api/app/version', { cache: 'no-store' });
    if (!response.ok) return;
    const { minBuild, downloadUrl } = await response.json();
    if ((await installedBuild()) < minBuild) showUpdateRequired(downloadUrl);
  } catch {
    // Sin conexión: no se bloquea; se comprueba en el siguiente arranque.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkForRequiredUpdate);
} else {
  checkForRequiredUpdate();
}
