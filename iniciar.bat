@echo off
setlocal
title ControlPagos

echo Iniciando ControlPagos...
echo La ventana debe permanecer abierta mientras uses la aplicacion.
echo.

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo ERROR: Python no esta disponible en el PATH.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creando entorno virtual...
  python -m venv .venv
)

echo Instalando dependencias Python...
call .venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo ERROR: Fallo la instalacion de dependencias.
  pause
  exit /b 1
)

echo.
echo Aplicando migraciones...
call .venv\Scripts\python.exe -m flask --app wsgi db upgrade
if errorlevel 1 (
  echo ERROR: Fallo la migracion de la base.
  pause
  exit /b 1
)

echo Iniciando servidor en http://127.0.0.1:5000 ...
start "" http://127.0.0.1:5000
call .venv\Scripts\python.exe -m flask --app wsgi run --debug

echo.
echo ControlPagos se ha detenido o ocurrio un error.
pause
