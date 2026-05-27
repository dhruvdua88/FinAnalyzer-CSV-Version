#!/bin/bash
# FinAnalyzer — Mac packager
# Usage: bash package_software_mac.sh
# Creates FinAnalyzer_v{VERSION}_{DATE}.zip in the project root.

set -e
cd "$(dirname "$0")"

VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
DATE_STR=$(date +%Y-%m-%d)
ZIP_NAME="FinAnalyzer_v${VERSION}_${DATE_STR}.zip"

echo "=== FinAnalyzer Packager (Mac) ==="
echo "Version : $VERSION"
echo "Date    : $DATE_STR"
echo "Output  : $ZIP_NAME"
echo ""

echo "[1/3] Building app..."
npm run build

echo ""
echo "[2/3] Creating zip: $ZIP_NAME"
rm -f "$ZIP_NAME"

zip -r "$ZIP_NAME" . \
  --exclude "*node_modules*" \
  --exclude "*/.git/*" \
  --exclude ".git/*" \
  --exclude "*/.claude/*" \
  --exclude ".claude/*" \
  --exclude "*/.cursor/*" \
  --exclude "*/.vscode/*" \
  --exclude "*/.idea/*" \
  --exclude "*/release/*" \
  --exclude "release/*" \
  --exclude "*/sea/out/*" \
  --exclude "sea/out/*" \
  --exclude "*/desktop-backend/target/*" \
  --exclude "*/src-tauri/target/*" \
  --exclude "*/session_changed_files_*" \
  --exclude "session_changed_files_*" \
  --exclude "*/.tally-source-temp/*" \
  --exclude ".tally-source-temp/*" \
  --exclude "*.log" \
  --exclude "*.pid" \
  --exclude "*.tsbuildinfo" \
  --exclude ".DS_Store" \
  --exclude "*/.DS_Store" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude "*.pem" \
  --exclude "*.key" \
  --exclude "python-tsf-exporter.zip" \
  --exclude "*/returns_R2B_*.json" \
  --exclude "returns_R2B_*.json" \
  --exclude "TrialBal.pdf" \
  --exclude "FinAnalyzer_Dashboard.xlsx" \
  --exclude "*.TSF" \
  --exclude "*.tsf" \
  --exclude "*.pptx" \
  --exclude "FinAnalyzer_Presenter_Notes.md" \
  --exclude "FinAnalyzer_v*.zip"

echo ""
SIZE=$(du -sh "$ZIP_NAME" | cut -f1)
echo "[3/3] Done!"
echo ""
echo "  File : $(pwd)/$ZIP_NAME"
echo "  Size : $SIZE"
