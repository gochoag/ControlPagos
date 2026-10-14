@echo off
setlocal
cd /d "%~dp0"
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"

if not exist "%ANDROID_HOME%\platform-tools" (
  echo No se encontro Android SDK en %ANDROID_HOME%.
  pause
  exit /b 1
)

call npm install
if errorlevel 1 goto :error

if not exist "android\gradlew.bat" (
  call npx cap add android
  if errorlevel 1 goto :error
)

call npm run build:debug
if errorlevel 1 goto :error

echo.
echo APK generado en:
echo %CD%\android\app\build\outputs\apk\debug\app-debug.apk
pause
exit /b 0

:error
echo.
echo No se pudo generar el APK local.
pause
exit /b 1
