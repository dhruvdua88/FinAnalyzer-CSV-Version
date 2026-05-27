@echo off
REM ============================================================
REM  FinAnalyzer - START (Windows)
REM  Double-click this file to launch FinAnalyzer in your browser.
REM  All program files live in the "app" folder next to this file.
REM ============================================================
cd /d "%~dp0app"
if not exist "run_software.bat" (
  echo Could not find the "app" folder next to this launcher.
  echo Make sure this file stays in the same folder as the "app" folder.
  pause
  exit /b 1
)
call run_software.bat
