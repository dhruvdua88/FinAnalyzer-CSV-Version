const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const APP_HOST = '127.0.0.1';
const DEFAULT_PORT = 5173;
const RUNTIME_DIR = path.join(path.dirname(process.execPath), 'app');
const BACKEND_ENTRY = path.join(RUNTIME_DIR, 'desktop-backend', 'backend.cjs');

const toSafePort = (value, fallback = DEFAULT_PORT) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const openExternal = (url) => {
  const common = { detached: true, stdio: 'ignore' };

  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], common).unref();
      return;
    }
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], common).unref();
      return;
    }
    spawn('xdg-open', [url], common).unref();
  } catch {
    // Browser auto-open failure should not stop backend startup.
  }
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (!fs.existsSync(BACKEND_ENTRY)) {
  fail(`Missing backend entry: ${BACKEND_ENTRY}`);
}

let createBackendServer = null;
try {
  const diskRequire = createRequire(path.join(RUNTIME_DIR, 'package.json'));
  ({ createBackendServer } = diskRequire(BACKEND_ENTRY));
} catch (error) {
  fail(`Unable to load backend module: ${error?.message || String(error)}`);
}

if (typeof createBackendServer !== 'function') {
  fail('Backend module did not expose createBackendServer.');
}

const start = async () => {
  const preferredPort = toSafePort(process.env.FINANALYZER_PORT, DEFAULT_PORT);
  const tempDir = path.join(os.homedir(), '.finanalyzer-temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const server = await createBackendServer({
    appRoot: RUNTIME_DIR,
    resourcesRoot: RUNTIME_DIR,
    tempDir,
    port: preferredPort,
  });

  const appUrl = `http://${APP_HOST}:${server.port}`;
  process.stdout.write(`FinAnalyzer running at ${appUrl}\n`);

  if (process.env.FINANALYZER_NO_OPEN !== '1') {
    openExternal(appUrl);
  }

  const shutdown = async () => {
    try {
      await server.stop();
    } catch {
      // best effort shutdown
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((error) => {
  fail(`Failed to start FinAnalyzer: ${error?.message || String(error)}`);
});
