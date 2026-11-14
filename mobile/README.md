# App Android de ControlPagos

La app es un WebView (Capacitor) que abre `https://controlpagos.cfd`. La interfaz y la lógica web las sirve el backend, así que se actualizan solas con cada despliegue. Solo hace falta un APK nuevo cuando cambia algo **nativo**: plugins de `package.json`, `capacitor.config.json` (por ejemplo, el dominio) o `android/`.

Incluye desbloqueo con huella/PIN, almacenamiento cifrado con Android Keystore y guardado/compartir nativo de respaldos.

## Actualización obligatoria

Al abrir, la app consulta `GET /api/app/version`. Si su `versionCode` es menor que `minBuild`, muestra una pantalla que obliga a descargar el APK nuevo desde GitHub Releases.

Cuando un cambio nativo exige un APK nuevo, en el **mismo PR**:

1. Sube `versionCode` (y `versionName`) en `android/app/build.gradle`.
2. Iguala `MIN_APP_BUILD` en `controlpagos/config.py` a ese `versionCode`.
3. Tras el merge, publica el APK: `git tag app-v<versionCode> && git push origin app-v<versionCode>`. El workflow `apk.yml` lo compila, lo firma y lo adjunta al release `latest`.

Publica el tag **antes** o justo después del despliegue: mientras no exista el release, el botón de descarga no tendrá APK nuevo.

Si el cambio nativo es opcional (no rompe la app vieja), no subas `MIN_APP_BUILD`.

## Clave de firma (una sola vez)

```powershell
keytool -genkeypair -v -keystore controlpagos-release.jks -alias controlpagos -keyalg RSA -keysize 4096 -validity 10000
```

- Guarda el `.jks` y sus contraseñas en tu gestor de contraseñas **y** fuera del PC. Sin esa clave Android no permite instalar actualizaciones encima de la app.
- Secrets del repositorio en GitHub: `ANDROID_KEYSTORE_B64` (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("controlpagos-release.jks"))`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` y `ANDROID_KEY_PASSWORD`.

## Compilar en local

- APK de depuración: `crear-apk-local.bat` (o `npm run build:debug`) e `instalar-apk.bat` con el teléfono conectado por USB.
- Si cambias `src/native-bridge.js`: `npm run build:bridge` y sube también el archivo generado en `controlpagos/static/js/mobile/`.

Después del primer acceso con contraseña, acepta **Activar huella/PIN**. Puedes revocarlo desde **Más**.
