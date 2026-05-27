#!/usr/bin/env node
/**
 * FinAnalyzer — Unified Cross-Platform Launcher
 * Works on Windows, macOS, and Linux.
 *
 * Usage:
 *   node start.js          — start on default port 5173
 *   node start.js --port 8080
 *   node start.js --host 0.0.0.0   (expose to LAN)
 *
 * No other tools required beyond Node.js LTS (v18+).
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const APP_DIR  = __dirname;
const ARGS     = process.argv.slice(2);
const PORT     = Number(getArg('--port') || 5173);
const HOST     = getArg('--host') || '127.0.0.1';
const APP_URL  = `http://${HOST}:${PORT}`;
const IS_WIN   = process.platform === 'win32';
const MIN_NODE = 18;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getArg(name) {
  const idx = ARGS.indexOf(name);
  return idx !== -1 && ARGS[idx + 1] ? ARGS[idx + 1] : null;
}

function log(msg)  { console.log(`[FinAnalyzer] ${msg}`); }
function warn(msg) { console.warn(`[FinAnalyzer] ⚠  ${msg}`); }
function die(msg)  { console.error(`[FinAnalyzer] ✗  ${msg}`); process.exit(1); }

// ─── Node version check ───────────────────────────────────────────────────────
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < MIN_NODE) {
  die(`Node.js v${MIN_NODE}+ required (you have ${process.version}). Download from https://nodejs.org`);
}

// ─── Kill whatever is on the target port ────────────────────────────────────
function killPort(port) {
  try {
    if (IS_WIN) {
      const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf8', stdio: 'pipe' });
      const pids = [...new Set(out.trim().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))];
      pids.forEach((pid) => {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
      });
    } else {
      execSync(`lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore', shell: true });
    }
  } catch { /* ignore: nothing was listening */ }
}

// ─── Dependency check / install ──────────────────────────────────────────────
function ensureDeps() {
  const viteCmd = IS_WIN ? 'node_modules\\.bin\\vite.cmd' : 'node_modules/.bin/vite';
  const vitePath = path.join(APP_DIR, viteCmd);
  if (fs.existsSync(vitePath)) return;

  log('Installing app dependencies (first run — this takes ~1 min)…');
  try {
    execSync('npm install --no-audit --no-fund', { cwd: APP_DIR, stdio: 'inherit' });
  } catch {
    die('npm install failed. Make sure npm is available and you have an internet connection.');
  }
  if (!fs.existsSync(vitePath)) {
    die('Dependency install incomplete — vite binary not found. Try deleting node_modules and running again.');
  }
}

// ─── Open browser ────────────────────────────────────────────────────────────
function openBrowser(url) {
  try {
    if (IS_WIN)                         execSync(`start "" "${url}"`,         { stdio: 'ignore' });
    else if (process.platform === 'darwin') execSync(`open "${url}"`,         { stdio: 'ignore' });
    else                                execSync(`xdg-open "${url}" 2>/dev/null || true`, { stdio: 'ignore', shell: true });
  } catch { /* non-fatal */ }
}

// ─── Wait for HTTP to respond ─────────────────────────────────────────────────
function waitForServer(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const probe = () => {
      http.get(url, (res) => {
        res.destroy();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`Server at ${url} did not respond within ${timeoutMs / 1000}s`));
        setTimeout(probe, 800);
      });
    };
    probe();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  log(`Starting FinAnalyzer on ${APP_URL} …`);
  log(`Platform: ${process.platform} | Node: ${process.version}`);

  killPort(PORT);
  ensureDeps();

  // Build the npm run dev command with explicit host / port / strictPort
  const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';
  const viteArgs = ['run', 'dev', '--', '--host', HOST, '--port', String(PORT), '--strictPort'];

  const child = spawn(npmCmd, viteArgs, {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--no-deprecation', FORCE_COLOR: '1' },
    shell: IS_WIN,   // Windows requires shell:true for .cmd scripts
  });

  child.on('error', (err) => die(`Failed to start dev server: ${err.message}`));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) warn(`Dev server exited with code ${code}`);
    process.exit(code ?? 0);
  });

  // Forward Ctrl+C cleanly
  process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });

  log('Waiting for server to be ready…');
  try {
    await waitForServer(APP_URL);
    log(`Ready → opening ${APP_URL}`);
    openBrowser(APP_URL);
  } catch (err) {
    warn(`${err.message} — check the output above for errors.`);
  }
})();
