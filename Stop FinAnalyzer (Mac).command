#!/bin/zsh
# ============================================================
#  FinAnalyzer - STOP (macOS)
#  Double-click this file to shut down the FinAnalyzer server.
# ============================================================
APP_PORTS="5173 5174 5175 5176"
FOUND=0
for PORT in ${=APP_PORTS}; do
  PIDS="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    FOUND=1
    echo "Stopping FinAnalyzer on port ${PORT}..."
    echo "$PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    PIDS_LEFT="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"
    [[ -n "$PIDS_LEFT" ]] && echo "$PIDS_LEFT" | xargs kill -9 2>/dev/null || true
  fi
done
if [[ "$FOUND" -eq 0 ]]; then
  echo "No running FinAnalyzer server was found."
else
  echo "FinAnalyzer stopped."
fi
echo "You can close this window now."
