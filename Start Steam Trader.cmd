@echo off
setlocal
cd /d "%~dp0"
echo Steam Transfer Desk
echo Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 LTS or newer from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
set "INSTALL_NEEDED="
if not exist node_modules\express\package.json set "INSTALL_NEEDED=1"
if not exist node_modules\qrcode\package.json set "INSTALL_NEEDED=1"
if not exist node_modules\steam-session\package.json set "INSTALL_NEEDED=1"
if defined INSTALL_NEEDED (
  echo Installing dependencies. This may take a few minutes...
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
echo Starting the local server. The browser will open when it is ready.
echo Keep this window open while using the app.
node server.js --open
echo The local server has stopped.
pause
