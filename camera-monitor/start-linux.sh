#!/usr/bin/env bash
# Local Security Camera Monitor — Linux launcher.
# Run:  ./start-linux.sh
# It downloads the streaming engine (go2rtc) the first time, then starts the
# monitor and opens your browser.
set -euo pipefail
cd "$(dirname "$0")"

GO2RTC_VERSION="v1.9.14"
BASE="https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}"
BIN="./go2rtc"
URL="http://127.0.0.1:1984/dashboard.html"

if [ ! -x "$BIN" ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)   ASSET="go2rtc_linux_amd64" ;;
    aarch64|arm64)  ASSET="go2rtc_linux_arm64" ;;
    armv7l|armv6l|arm) ASSET="go2rtc_linux_arm" ;;
    i386|i686)      ASSET="go2rtc_linux_i386" ;;
    *) echo "Unsupported Linux architecture: $ARCH"; exit 1 ;;
  esac
  echo "First run: downloading go2rtc ${GO2RTC_VERSION} (${ASSET})…"
  curl -fL "${BASE}/${ASSET}" -o go2rtc
  chmod +x go2rtc
fi

echo "Starting Camera Monitor…"
echo "  Dashboard: ${URL}"
echo "  (Press Ctrl+C to stop.)"
( sleep 2; xdg-open "$URL" >/dev/null 2>&1 || true ) &
exec "$BIN" -config go2rtc.yaml
