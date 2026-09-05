@echo off
REM Local Security Camera Monitor - Windows launcher.
REM Double-click this file. It downloads the streaming engine (go2rtc) the first
REM time, then starts the monitor and opens your browser.
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "GO2RTC_VERSION=v1.9.14"
set "BASE=https://github.com/AlexxIT/go2rtc/releases/download/%GO2RTC_VERSION%"
set "URL=http://127.0.0.1:1984/dashboard.html"

if not exist "go2rtc.exe" (
  set "ASSET=go2rtc_win64.zip"
  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ASSET=go2rtc_win_arm64.zip"
  if /I "%PROCESSOR_ARCHITECTURE%"=="x86"   set "ASSET=go2rtc_win32.zip"
  echo First run: downloading go2rtc %GO2RTC_VERSION% ^(!ASSET!^)...
  powershell -NoProfile -Command "Invoke-WebRequest -Uri '%BASE%/!ASSET!' -OutFile 'go2rtc.zip'"
  if errorlevel 1 ( echo Download failed. Check your internet connection. & pause & exit /b 1 )
  powershell -NoProfile -Command "Expand-Archive -Path 'go2rtc.zip' -DestinationPath '.' -Force"
  del /q go2rtc.zip
)

echo Starting Camera Monitor...
echo   Dashboard: %URL%
echo   (Close this window to stop.)
start "" "%URL%"
go2rtc.exe -config go2rtc.yaml
