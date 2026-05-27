#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/run_software_mac.command"

if [[ ! -x "$LAUNCHER" ]]; then
  echo "Launcher not found or not executable: $LAUNCHER"
  exit 1
fi

open "$LAUNCHER"
