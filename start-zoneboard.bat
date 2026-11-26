@echo off
title ZoneBoard
cd /d "%~dp0"

rem 1. Node.js must be installed (version 22 or newer)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page: install the LTS version, then run this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
  echo Your Node.js is too old. Install the LTS version from nodejs.org, then run this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

rem 2. Settings: made from the example the first time, then you fill them in
if not exist zoneboard.env (
  copy zoneboard.env.example zoneboard.env >nul
  echo.
  echo First run: fill in your Kite keys and a password in the file that opens now.
  echo Save it, close Notepad, then run start-zoneboard.bat again.
  notepad zoneboard.env
  exit /b 0
)

rem 3. Libraries, once
if not exist node_modules (
  echo Installing libraries, one time only...
  call npm install --omit=dev
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
)

rem 4. Open the board in the browser a few seconds after the server starts
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 4; Start-Process 'http://127.0.0.1:8080/login'"

echo.
echo ZoneBoard is running at http://127.0.0.1:8080
echo Keep this window open while you use it. Close it to stop ZoneBoard.
echo.
node --env-file=zoneboard.env server.mjs
echo.
echo ZoneBoard stopped.
pause
