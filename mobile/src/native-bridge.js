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
