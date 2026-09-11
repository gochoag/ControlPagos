@echo off
setlocal
cd /d "%~dp0"

adb get-state >nul 2>nul
if errorlevel 1 (
  echo No hay un dispositivo Android conectado.
  echo Activa las opciones de desarrollador y la depuracion USB.
  pause
  exit /b 1
)

adb reverse tcp:5000 tcp:5000
if errorlevel 1 (
  echo No se pudo redirigir el puerto 5000.
  pause
  exit /b 1
)

echo Conexion preparada: Android localhost:5000 -^> PC localhost:5000
pause
