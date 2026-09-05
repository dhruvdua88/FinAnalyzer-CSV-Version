#!/usr/bin/env bash
# Local Security Camera Monitor — macOS launcher.
# Double-click this file (or run it in Terminal). It downloads the streaming
# engine (go2rtc) the first time, then starts the monitor and opens your browser.
set -euo pipefail
cd "$(dirname "$0")"

GO2RTC_VERSION="v1.9.14"
BASE="https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}"
BIN="./go2rtc"
URL="http://127.0.0.1:1984/dashboard.html"

if [ ! -x "$BIN" ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64)  ASSET="go2rtc_mac_arm64.zip" ;;
    x86_64) ASSET="go2rtc_mac_amd64.zip" ;;
    *) echo "Unsupported macOS architecture: $ARCH"; exit 1 ;;
  esac
  echo "First run: downloading go2rtc ${GO2RTC_VERSION} (${ASSET})…"
  curl -fL "${BASE}/${ASSET}" -o go2rtc.zip
  unzip -o go2rtc.zip >/dev/null
  rm -f go2rtc.zip
  chmod +x go2rtc
  # curl downloads are not quarantined, but strip the flag just in case:
  xattr -dr com.apple.quarantine ./go2rtc 2>/dev/null || true
fi

echo "Starting Camera Monitor…"
echo "  Dashboard: ${URL}"
echo "  (Close this window or press Ctrl+C to stop.)"
( sleep 2; open "$URL" >/dev/null 2>&1 || true ) &
exec "$BIN" -config go2rtc.yaml
