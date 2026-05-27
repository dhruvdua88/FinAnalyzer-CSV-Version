@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "APP_PORT=5173"
set "APP_URL=http://127.0.0.1:%APP_PORT%"
set "APP_LOG=vite-dev.log"
set "NPM_INSTALL_CMD=npm install --no-audit --no-fund"
set "REPAIR_ATTEMPTED=0"

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

if exist "%APP_LOG%" del /f /q "%APP_LOG%" >nul 2>nul
echo Starting FinAnalyzer web app...
start "FinAnalyzer Dev Server" /min cmd /k "cd /d ""%~dp0"" & npm run dev -- --host 127.0.0.1 --port %APP_PORT% --strictPort > ""%APP_LOG%"" 2>&1"

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
  echo.
  echo You can also review the "FinAnalyzer Dev Server" command window.
)
if not exist "%APP_LOG%" (
  echo Check the "FinAnalyzer Dev Server" command window for errors.
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
