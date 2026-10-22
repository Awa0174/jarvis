@echo off
rem Starts JARVIS on Windows: puts a per-user Node.js install on PATH if needed,
rem then runs `npm start` (bridge + face). Add --writes to allow real actions.
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nicht gefunden. Bitte Node.js 20+ installieren.
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo Node %%v - starte JARVIS...
if "%~1"=="--writes" (
  npm start -- --writes
) else (
  npm start
)
