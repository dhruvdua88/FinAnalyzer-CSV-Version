#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_HOST="127.0.0.1"
APP_PORT="5173"
APP_URL="http://${APP_HOST}:${APP_PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not available in PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not available in PATH."
  exit 1
fi

PORT_PIDS="$(lsof -tiTCP:${APP_PORT} -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PORT_PIDS" ]]; then
  echo "Stopping existing process(es) on port ${APP_PORT}..."
  echo "$PORT_PIDS" | xargs kill 2>/dev/null || true
  sleep 1

  PORT_PIDS_REMAINING="$(lsof -tiTCP:${APP_PORT} -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$PORT_PIDS_REMAINING" ]]; then
    echo "$PORT_PIDS_REMAINING" | xargs kill -9 2>/dev/null || true
  fi
fi

if [[ ! -d node_modules || ! -x node_modules/.bin/vite || ! -x node_modules/.bin/cross-env ]]; then
  echo "Installing app requirements..."
  npm install --no-audit --no-fund
fi

echo "Starting FinAnalyzer at ${APP_URL}"
exec npm run dev -- --host "$APP_HOST" --port "$APP_PORT" --strictPort
