# Node SEA Packaging (Isolated Path)

This packaging flow is intentionally separate from the existing app code/runtime.
It only adds files under `sea/`.

## What it produces

`sea/out/FinAnalyzer/`
- `FinAnalyzer` (or `FinAnalyzer.exe`)
- `app/`
  - `dist/` (built frontend)
  - `desktop-backend/` (backend + services)
  - `node_modules/` (runtime deps only: `xlsx`, `xlsx-js-style`)
- launchers:
  - `Run FinAnalyzer.command`
  - `run-finanalyzer.sh`
  - `Run-FinAnalyzer.bat`

## Build commands

1. Full build + SEA injection:
```bash
node sea/build-sea.cjs
```

2. Stage only (no SEA injection, useful for quick verification):
```bash
node sea/build-sea.cjs --stage-only
```

3. Include loader folders (if present):
```bash
node sea/build-sea.cjs --with-loader
```

4. Skip frontend build:
```bash
node sea/build-sea.cjs --skip-build
```

## Platform rule (important)

SEA output is platform-specific because the packager embeds the current Node runtime (`process.execPath`):
- Build on macOS -> macOS binary (`FinAnalyzer`, Mach-O)
- Build on Windows -> Windows binary (`FinAnalyzer.exe`, PE)

If you need a Windows `.exe`, run the build on Windows.

## Windows `.exe` build flow

1. Copy project source to a Windows machine.
2. Do not reuse macOS `sea/out/` binaries.
3. Install dependencies:
```bash
npm install
```
4. Build SEA:
```bash
node sea/build-sea.cjs
```
5. Collect output from:
`sea\out\FinAnalyzer\`

Minimum distributable for end users:
- `FinAnalyzer.exe`
- `app\` (required: `dist`, `desktop-backend`, runtime `node_modules`)
- launcher scripts (optional)

## Runtime behavior

The executable starts the backend server and opens:
`http://127.0.0.1:<port>`

Environment controls:
- `FINANALYZER_PORT` (default `5173`)
- `FINANALYZER_NO_OPEN=1` to disable browser auto-open

## Distribution

Send only the generated `sea/out/FinAnalyzer/` folder to users.
