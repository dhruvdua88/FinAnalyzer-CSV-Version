# 🎥 Local Security Camera Monitor

Watch all your security cameras in one browser grid, on the same WiFi network — no
cloud account, no subscription. Everything runs on your own computer.

It uses [**go2rtc**](https://github.com/AlexxIT/go2rtc) (a small, open-source
streaming engine) to talk to your cameras and convert their video into something a
web browser can play, plus a simple dashboard to view and manage them.

> This tool is self-contained and has nothing to do with the FinAnalyzer app in the
> rest of this repository — it just lives here in its own folder.

---

## Quick start

1. Make sure your cameras and your computer are on the **same WiFi/LAN**.
2. Start the monitor:
   - **macOS** — double-click `start-mac.command`
     *(first time: right-click → Open to get past the security prompt).*
   - **Windows** — double-click `start-windows.bat`.
   - **Linux** — run `./start-linux.sh` in a terminal.
3. The first run downloads the engine automatically (~15 MB). Your browser opens at
   **http://127.0.0.1:1984/dashboard.html**.
4. Click **＋ Add camera**:
   - **Scan WiFi (ONVIF)** — finds most cameras automatically. Enter each camera's
     username & password, click **Add**.
   - **Paste a link** — for anything not auto-found, paste an `rtsp://` link.
   - **Find my camera's link** — a cheat sheet of link formats by brand.

Cameras you add are saved, so they come back the next time you start the monitor.

To stop: close the terminal/console window (or press `Ctrl+C`).

---

## Finding a camera's RTSP link

If a camera isn't found by the scan, find its IP address (in your router's device
list or the camera's phone app), then use the pattern for your brand. Replace
`USER`, `PASS`, and the IP:

| Brand | Typical RTSP link (main stream) |
|---|---|
| Reolink | `rtsp://USER:PASS@IP:554/h264Preview_01_main` |
| Hikvision / Annke | `rtsp://USER:PASS@IP:554/Streaming/Channels/101` |
| Dahua / Amcrest | `rtsp://USER:PASS@IP:554/cam/realmonitor?channel=1&subtype=0` |
| TP-Link Tapo | `rtsp://USER:PASS@IP:554/stream1` |
| Ubiquiti UniFi | `rtsp://IP:7447/<stream-id>` (enable RTSP per camera in UniFi Protect) |
| Wyze (RTSP firmware) | `rtsp://USER:PASS@IP/live` |
| Any ONVIF camera | `onvif://USER:PASS@IP:80` (the engine finds the RTSP link for you) |

Cameras usually also have a lighter low-res "sub" stream — handy if WiFi struggles
with several cameras (Hikvision `.../Channels/102`, Dahua `subtype=1`).

**Cloud-only cameras** (stock Ring, Nest, or Wyze without RTSP firmware) block local
access, so they generally can't be monitored this way.

---

## Watching from other devices on your WiFi (optional)

By default the monitor is **only reachable from the computer running it**
(`127.0.0.1`) — the safest setting. To also open it on your phone or another
computer on the same WiFi:

1. Edit `go2rtc.yaml` and change the `api.listen` line to:
   ```yaml
   api:
     listen: ":1984"
     static_dir: "www"
     username: "admin"        # pick your own
     password: "change-me"    # pick a strong one
   ```
   Setting a username/password matters here — otherwise anyone on your WiFi could
   view your cameras.
2. Restart the monitor.
3. On the other device, open `http://<this-computer's-IP>:1984/dashboard.html`
   (find the IP with `ipconfig` on Windows or `ifconfig`/`ip addr` on macOS/Linux).

---

## Removing a camera

Hover a camera tile and click the **✕** button. This removes it for good (it's also
deleted from `go2rtc.yaml`, so it won't come back on restart).

---

## Troubleshooting

- **"Can't reach the streaming engine" banner** — the engine isn't running. Start it
  with the launcher for your OS, then click **Refresh**.
- **A tile stays black / "error"** — usually a wrong username/password or link.
  Double-check the credentials and the RTSP path for your brand. Test the link in
  [VLC](https://www.videolan.org/) (`File → Open Network`) to confirm it works.
- **Choppy video with many cameras** — use each camera's low-res "sub" stream, or
  switch the layout to fewer columns. Wired (Ethernet) cameras are steadier than WiFi
  ones.
- **First-run download blocked** — check that the computer has internet access for
  the initial engine download (the cameras themselves stay fully local).

## What's in this folder

| File | Purpose |
|---|---|
| `start-mac.command` / `start-windows.bat` / `start-linux.sh` | One-click launchers (download the engine on first run, then start it). |
| `go2rtc.yaml` | Engine config + your saved cameras. |
| `www/dashboard.html` | The monitoring dashboard you view in the browser. |
| `www/video-stream.js`, `www/video-rtc.js` | The in-browser video player (vendored from go2rtc, MIT-licensed). |
| `go2rtc` / `go2rtc.exe` | The streaming engine binary (downloaded on first run; not committed). |

The player files in `www/` are from the [go2rtc project](https://github.com/AlexxIT/go2rtc)
and are licensed under the MIT License.
