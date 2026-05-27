@echo off
setlocal
cd /d "%~dp0"

if exist "dist\TSF Exporter\TSF Exporter.exe" (
  start "" "dist\TSF Exporter\TSF Exporter.exe" %*
  exit /b 0
)

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" main.py %*
  exit /b %errorlevel%
)

python main.py %*
exit /b %errorlevel%
