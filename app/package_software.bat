@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

for /f "tokens=*" %%i in ('node -e "process.stdout.write(require('./package.json').version)"') do set "VERSION=%%i"
for /f "tokens=2 delims==" %%i in ('wmic os get localdatetime /value 2^>nul') do set "DT=%%i"
set "DATE_STR=!DT:~0,4!-!DT:~4,2!-!DT:~6,2!"
set "ZIP_NAME=FinAnalyzer_v!VERSION!_!DATE_STR!.zip"
set "RELEASE_ROOT=%~dp0release"
set "PACKAGE_DIR=%RELEASE_ROOT%\FinAnalyzer_Release"
set "ZIP_FILE=%~dp0!ZIP_NAME!"

echo === FinAnalyzer Packager (Windows) ===
echo Version : !VERSION!
echo Date    : !DATE_STR!
echo Output  : !ZIP_NAME!
echo.

echo [1/4] Building app...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo [2/4] Preparing release folder...
if exist "%PACKAGE_DIR%" rmdir /s /q "%PACKAGE_DIR%"
if not exist "%PACKAGE_DIR%" mkdir "%PACKAGE_DIR%"

echo [3/4] Copying files...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$src='%~dp0'; $dst='%PACKAGE_DIR%';" ^
  "$exclude=@('node_modules','release','.git');" ^
  "Get-ChildItem -LiteralPath $src -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object { Copy-Item $_.FullName -Destination $dst -Recurse -Force }"
if errorlevel 1 (
  echo Failed while copying project files.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Directory -Recurse -Filter node_modules -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue };" ^
  "foreach($d in @('.tally-source-temp','.claude','.cursor','.vscode','.idea','sea\out','desktop-backend\target','src-tauri\target')){ $p=Join-Path '%PACKAGE_DIR%' $d; if(Test-Path $p){ Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue } };" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter 'session_changed_files_*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter '*.log' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue;" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter '*.pid' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue;" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter '*.tsbuildinfo' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue;" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter '.DS_Store' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue;" ^
  "$remove=@('.env','.env.local','.env.production','.env.development','TrialBal.pdf','FinAnalyzer_Dashboard.xlsx','FinAnalyzer_Presenter_Notes.md','python-tsf-exporter.zip');" ^
  "foreach($f in $remove){ $p=Join-Path '%PACKAGE_DIR%' $f; if(Test-Path $p){ Remove-Item $p -Force -ErrorAction SilentlyContinue } };" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter 'returns_R2B_*.json' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue;" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter '*.pptx' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue;" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter '*.TSF' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue;" ^
  "Get-ChildItem -LiteralPath '%PACKAGE_DIR%' -Filter '*.tsf' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue"

echo [4/4] Creating zip...
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '!ZIP_FILE!') { Remove-Item '!ZIP_FILE!' -Force }; Compress-Archive -Path '%PACKAGE_DIR%\*' -DestinationPath '!ZIP_FILE!' -Force"
if errorlevel 1 (
  echo Failed to create zip package.
  pause
  exit /b 1
)

echo.
echo === Done! ===
echo Zip : !ZIP_FILE!
echo.
echo Run guide inside zip: RUN_ME_FIRST.html
echo Start (browser): run_software.bat
echo Start (desktop): run_tauri.bat
exit /b 0
