@echo off
setlocal
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "NODE_OPTIONS=--no-deprecation"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo Rust toolchain is not installed. Install via: winget install Rustlang.Rustup
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo Building Tauri desktop installer...
call npm run tauri:build
if errorlevel 1 goto :fail

echo.
echo Build completed. Check:
echo   src-tauri\target\release\bundle\nsis
echo.
for %%F in ("%~dp0src-tauri\target\release\bundle\nsis\*.exe") do (
  echo Installer:
  echo   %%~nxF
)
exit /b 0

:fail
echo Tauri packaging failed.
pause
exit /b 1
