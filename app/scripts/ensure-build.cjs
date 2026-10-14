#!/usr/bin/env node
/**
 * Build dist/ only when the UI sources changed since the last build.
 *
 * Used by run_software.bat so a normal launch serves the prebuilt UI from the
 * desktop backend instead of booting the Vite dev server. The fingerprint
 * (path + size + mtime of every UI source file) is stored in dist/.build-stamp;
 * a mismatch or a missing dist/index.html triggers `npm run build`.
 *
 * Usage: node scripts/ensure-build.cjs [--force]
 * Exit code 0 = dist is current, non-zero = build failed.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(APP_DIR, 'dist', 'index.html');
const STAMP_PATH = path.join(APP_DIR, 'dist', '.build-stamp');

const SOURCE_FILES = [
  'index.html',
  'index.tsx',
  'App.tsx',
  'types.ts',
  'metadata.json',
  'vite.config.ts',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
];
const SOURCE_DIRS = ['components', 'services', 'workers', 'public'];

const collect = (dir, out) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile()) out.push(full);
  }
};

const fingerprint = () => {
  const files = [];
  SOURCE_FILES.forEach((f) => {
    const full = path.join(APP_DIR, f);
    if (fs.existsSync(full)) files.push(full);
  });
  SOURCE_DIRS.forEach((d) => collect(path.join(APP_DIR, d), files));
  files.sort();

  const hash = crypto.createHash('sha1');
  for (const file of files) {
    const stat = fs.statSync(file);
    hash.update(`${path.relative(APP_DIR, file)}|${stat.size}|${Math.floor(stat.mtimeMs)}\n`);
  }
  return hash.digest('hex');
};

const readStamp = () => {
  try {
    return fs.readFileSync(STAMP_PATH, 'utf8').trim();
  } catch {
    return '';
  }
};

const current = fingerprint();
const force = process.argv.includes('--force');

if (!force && fs.existsSync(DIST_INDEX) && readStamp() === current) {
  console.log('[FinAnalyzer] UI build is up to date.');
  process.exit(0);
}

console.log('[FinAnalyzer] Building the interface (first run or after an update, ~1 min)...');
try {
  execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
} catch {
  console.error('[FinAnalyzer] UI build failed.');
  process.exit(1);
}

if (!fs.existsSync(DIST_INDEX)) {
  console.error('[FinAnalyzer] UI build finished but dist/index.html is missing.');
  process.exit(1);
}

fs.writeFileSync(STAMP_PATH, `${current}\n`, 'utf8');
console.log('[FinAnalyzer] UI build complete.');
