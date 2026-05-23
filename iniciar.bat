@echo off
setlocal
title ControlPagos

echo Iniciando ControlPagos...
echo Por favor espera, se abrira una ventana de consola que debes mantener abierta.
echo.

cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo ERROR: bun no esta disponible en el PATH.
  echo Instala Bun o abre una nueva consola despues de instalarlo.
  pause
  exit /b 1
)

echo Instalando dependencias...
call bun install
if errorlevel 1 (
  echo.
  echo ERROR: Fallo la instalacion de dependencias.
  pause
  exit /b 1
)

echo.
echo Iniciando servidor...
call bun start

echo.
echo ControlPagos se ha detenido o ocurrio un error.
pause
