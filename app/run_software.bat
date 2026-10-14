@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM Default: serve the prebuilt UI (dist\) from the desktop backend. The UI is
REM rebuilt only when its sources change, so normal launches skip Vite entirely.
REM Pass --dev to run the Vite dev server instead (for code changes / HMR).

set "APP_PORT=5173"
set "APP_URL=http://127.0.0.1:%APP_PORT%"
set "APP_LOG=finanalyzer-server.log"
set "DEV_LOG=vite-dev.log"
set "TEMP_ROOT=%USERPROFILE%\.finanalyzer-temp"
set "NPM_INSTALL_CMD=npm install --no-audit --no-fund"
set "REPAIR_ATTEMPTED=0"
set "MODE=prod"
if /i "%~1"=="--dev" set "MODE=dev"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not available in PATH.
  echo Install Node.js LTS from https://nodejs.org and retry.
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

call close_software.bat >nul 2>nul

call :ensure_dependencies
if errorlevel 1 goto :fail

if "%MODE%"=="dev" goto :start_dev

node scripts\ensure-build.cjs
if errorlevel 1 (
  echo Could not build the interface. Falling back to the development server...
  goto :start_dev
)

if not exist "%TEMP_ROOT%" mkdir "%TEMP_ROOT%" >nul 2>nul
if exist "%APP_LOG%" del /f /q "%APP_LOG%" >nul 2>nul
echo Starting FinAnalyzer...
start "FinAnalyzer Server" /min cmd /c "cd /d ""%~dp0"" & node desktop-backend\backend.cjs --standalone --app-root . --temp-dir ""%TEMP_ROOT%"" --port %APP_PORT% > ""%APP_LOG%"" 2>&1"
goto :wait_setup

:start_dev
set "APP_LOG=%DEV_LOG%"
if exist "%APP_LOG%" del /f /q "%APP_LOG%" >nul 2>nul
echo Starting FinAnalyzer development server...
start "FinAnalyzer Dev Server" /min cmd /k "cd /d ""%~dp0"" & npm run dev -- --host 127.0.0.1 --port %APP_PORT% --strictPort > ""%APP_LOG%"" 2>&1"

:wait_setup
set /a RETRIES=60
:wait_for_port
netstat -ano | findstr ":%APP_PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 goto :ready
set /a RETRIES-=1
if !RETRIES! LEQ 0 goto :fail_startup
ping -n 2 127.0.0.1 >nul
goto :wait_for_port

:ready
start "" %APP_URL%
echo FinAnalyzer started at %APP_URL%.
exit /b 0

:fail_startup
echo FinAnalyzer did not become ready at %APP_URL%.
if exist "%APP_LOG%" (
  echo Check the startup log: %APP_LOG%
  echo -------- LOG START --------
  type "%APP_LOG%"
  echo --------- LOG END ---------
)
if not exist "%APP_LOG%" (
  echo Check the minimized FinAnalyzer command window for errors.
)
pause
exit /b 1

:fail
echo Failed to start FinAnalyzer.
pause
exit /b 1

:ensure_dependencies
set "NEED_INSTALL=0"
if not exist "node_modules" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\vite.cmd" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\cross-env.cmd" set "NEED_INSTALL=1"
if not exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" set "NEED_INSTALL=1"

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
if not exist "node_modules\.bin\vite.cmd" (
  echo Requirements install is incomplete: missing vite runtime.
  exit /b 1
)
if not exist "node_modules\.bin\cross-env.cmd" (
  echo Requirements install is incomplete: missing cross-env runtime.
  exit /b 1
)
echo Requirements are ready.
exit /b 0
