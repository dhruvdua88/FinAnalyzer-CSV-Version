@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "NODE_OPTIONS=--no-deprecation"
set "NPM_INSTALL_CMD=npm install --no-audit --no-fund"
set "REPAIR_ATTEMPTED=0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not available in PATH.
  echo Reinstall Node.js and retry.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo Rust toolchain is not installed. Install via: winget install Rustlang.Rustup
  pause
  exit /b 1
)

call close_tauri.bat >nul 2>nul

call :ensure_dependencies
if errorlevel 1 goto :fail

set "HAS_TAURI_CONFIG=0"
if exist "tauri.conf.json" set "HAS_TAURI_CONFIG=1"
if exist "tauri.conf.json5" set "HAS_TAURI_CONFIG=1"
if exist "Tauri.toml" set "HAS_TAURI_CONFIG=1"
if exist "src-tauri\tauri.conf.json" set "HAS_TAURI_CONFIG=1"
if exist "src-tauri\tauri.conf.json5" set "HAS_TAURI_CONFIG=1"
if exist "src-tauri\Tauri.toml" set "HAS_TAURI_CONFIG=1"

if "%HAS_TAURI_CONFIG%"=="0" (
  echo Desktop Tauri config not found in this folder.
  echo Falling back to browser mode...
  call run_software.bat
  exit /b %errorlevel%
)

echo Starting FinAnalyzer in Tauri mode...
call npm run tauri:dev
exit /b %errorlevel%

:fail
echo Failed to start Tauri app.
pause
exit /b 1

:ensure_dependencies
set "NEED_INSTALL=0"
if not exist "node_modules" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\tauri.cmd" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\cross-env.cmd" set "NEED_INSTALL=1"

if "%NEED_INSTALL%"=="0" (
  echo Requirements check passed.
  exit /b 0
)

echo Installing app requirements...
call %NPM_INSTALL_CMD%
if not errorlevel 1 goto :verify_dependencies

if "%REPAIR_ATTEMPTED%"=="0" (
  echo Requirements install failed. Attempting automatic repair...
  set "REPAIR_ATTEMPTED=1"
  if exist "node_modules" rmdir /s /q "node_modules" >nul 2>nul
  call %NPM_INSTALL_CMD%
  if errorlevel 1 (
    echo Automatic repair failed while installing requirements.
    exit /b 1
  )
) else (
  echo Failed to install app requirements.
  exit /b 1
)

:verify_dependencies
if not exist "node_modules\.bin\tauri.cmd" (
  echo Requirements install is incomplete: missing tauri runtime.
  exit /b 1
)
if not exist "node_modules\.bin\cross-env.cmd" (
  echo Requirements install is incomplete: missing cross-env runtime.
  exit /b 1
)
echo Requirements are ready.
exit /b 0
