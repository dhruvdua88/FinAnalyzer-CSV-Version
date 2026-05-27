@echo off
REM ============================================================
REM  FinAnalyzer - STOP (Windows)
REM  Double-click this file to shut down the FinAnalyzer server.
REM ============================================================
cd /d "%~dp0app"
if not exist "close_software.bat" (
  echo Could not find the "app" folder next to this launcher.
  pause
  exit /b 1
)
call close_software.bat
echo.
echo You can close this window now.
pause
