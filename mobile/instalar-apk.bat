@echo off
setlocal
title Instalar ControlPagos en Android

set "APK=%~dp0android\app\build\outputs\apk\debug\app-debug.apk"

if not exist "%APK%" (
  echo.
  echo No se encontro la APK.
  echo Primero ejecuta crear-apk-local.bat.
  echo.
  pause
  exit /b 1
)

where adb >nul 2>nul
if errorlevel 1 (
  echo.
  echo No se encontro ADB en el PATH.
  echo Abre Android Studio o configura Android platform-tools antes de continuar.
  echo.
  pause
  exit /b 1
)

echo.
echo Dispositivos Android detectados:
adb devices
echo.
echo Instalando ControlPagos y conservando sus datos...
adb wait-for-device
adb install -r "%APK%"

if errorlevel 1 (
  echo.
  echo No se pudo instalar. Revisa que el telefono este desbloqueado
  echo y que hayas autorizado la depuracion USB o ADB inalambrico.
  echo.
  pause
  exit /b 1
)

echo.
echo ControlPagos fue instalado correctamente.
echo Puedes abrirlo desde el telefono.
echo.
pause
