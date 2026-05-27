@echo off
setlocal EnableDelayedExpansion

set "FOUND=0"
set "KILLED=;"
set "PORT_LIST=5173 5174 5175 5176"

for %%A in (%PORT_LIST%) do (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%%A" ^| findstr "LISTENING"') do (
    set "PID=%%P"
    echo !KILLED! | findstr /C:";!PID!;" >nul
    if errorlevel 1 (
      set "FOUND=1"
      set "KILLED=!KILLED!!PID!;"
      echo Stopping process !PID! on port %%A...
      taskkill /PID !PID! /T /F >nul 2>nul
    )
  )
)

taskkill /FI "WINDOWTITLE eq FinAnalyzer Dev Server*" /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq FinAnalyzer Tauri Dev*" /F >nul 2>nul
taskkill /IM finanalyzer.exe /T /F >nul 2>nul
taskkill /IM FinAnalyzer.exe /T /F >nul 2>nul

set /a RETRIES=8
:wait_for_shutdown
set "STILL_LISTENING=0"
for %%A in (%PORT_LIST%) do (
  netstat -ano | findstr ":%%A" | findstr "LISTENING" >nul
  if not errorlevel 1 set "STILL_LISTENING=1"
)
if "!STILL_LISTENING!"=="0" goto :status
if !RETRIES! LEQ 0 goto :status
set /a RETRIES-=1
ping -n 2 127.0.0.1 >nul
goto :wait_for_shutdown

:status
if "%FOUND%"=="0" (
  echo No FinAnalyzer server process was found on known ports.
) else (
  if "!STILL_LISTENING!"=="0" (
    echo FinAnalyzer servers stopped.
  ) else (
    echo Some server ports are still in use. Run close_software.bat once more.
  )
)

exit /b 0
