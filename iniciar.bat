@echo off
setlocal
title ControlPagos

echo Iniciando ControlPagos...
echo Por favor espera, se abrira una ventana de consola que debes mantener abierta.
echo.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js no esta instalado o no esta en el PATH.
  echo Instala Node.js y vuelve a intentar.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm no esta disponible en el PATH.
  echo Reinstala Node.js o abre una nueva consola despues de instalarlo.
  pause
  exit /b 1
)

echo Instalando dependencias...
call npm install
if errorlevel 1 (
  echo.
  echo ERROR: Fallo la instalacion de dependencias.
  pause
  exit /b 1
)

echo.
echo Iniciando servidor...
call npm start

echo.
echo ControlPagos se ha detenido o ocurrio un error.
pause
