# APK local de ControlPagos

Este módulo genera un APK **solo para desarrollo**. El WebView abre `http://localhost:5000` y ADB conecta ese puerto con el servidor Flask de la PC.

La APK incorpora autenticación mediante huella/PIN, almacenamiento cifrado con Android Keystore y guardado/compartir nativo de respaldos. Estas funciones requieren reconstruir e instalar la APK cuando cambian los complementos de `mobile/package.json`.

1. En la raíz del proyecto ejecuta `iniciar.bat` y deja la ventana abierta.
   Si cambiaste el diseño, ejecuta antes `npm install` y `npm run build:css` en la raíz.
2. Activa **Opciones de desarrollador → Depuración USB** en Android y conecta el cable.
3. Acepta en el teléfono la autorización de depuración.
4. Ejecuta `mobile\conectar-android.bat`.
5. Ejecuta `mobile\crear-apk-local.bat`.
6. Instala `mobile\android\app\build\outputs\apk\debug\app-debug.apk`, o ejecuta:

   ```powershell
   adb install -r mobile\android\app\build\outputs\apk\debug\app-debug.apk
   ```

El APK solo funcionará mientras el teléfono esté conectado por USB, el redireccionamiento ADB esté activo y Flask se esté ejecutando. `cleartext: true` no debe utilizarse en el APK definitivo de PythonAnywhere.
Después del primer acceso con contraseña, acepta **Activar huella/PIN**. En los siguientes inicios aparecerá el diálogo protegido de Android. Puedes revocarlo desde **Más**.
