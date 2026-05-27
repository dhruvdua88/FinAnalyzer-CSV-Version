@echo off
setlocal

set "FOUND=0"

for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq FinAnalyzer.exe" /FO CSV /NH ^| findstr /I "FinAnalyzer.exe"') do (
  set "FOUND=1"
  echo Stopping FinAnalyzer.exe PID %%~P...
  taskkill /PID %%~P /T /F >nul 2>nul
)

for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq finanalyzer.exe" /FO CSV /NH ^| findstr /I "finanalyzer.exe"') do (
  set "FOUND=1"
  echo Stopping finanalyzer.exe PID %%~P...
  taskkill /PID %%~P /T /F >nul 2>nul
)

for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq app.exe" /FO CSV /NH ^| findstr /I "app.exe"') do (
  set "FOUND=1"
  echo Stopping Tauri app PID %%~P...
  taskkill /PID %%~P /T /F >nul 2>nul
)

if "%FOUND%"=="0" (
  echo Tauri app is not running.
) else (
  echo Tauri app stopped.
)

exit /b 0
