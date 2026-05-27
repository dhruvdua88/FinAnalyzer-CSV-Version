#!/bin/zsh
# ============================================================
#  FinAnalyzer - START (macOS)
#  Double-click this file to launch FinAnalyzer in your browser.
#  All program files live in the "app" folder next to this file.
#
#  First time only: if macOS blocks it, right-click -> Open,
#  or run  chmod +x "Start FinAnalyzer (Mac).command"  in Terminal.
# ============================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/app"
if [[ ! -f run_software_mac.command ]]; then
  echo "Could not find the 'app' folder next to this launcher."
  echo "Keep this file in the same folder as the 'app' folder."
  exit 1
fi
chmod +x run_software_mac.command 2>/dev/null || true
exec ./run_software_mac.command
