#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SEA_DIR = path.resolve(ROOT_DIR, 'sea');
const OUT_DIR = path.resolve(SEA_DIR, 'out');
const BUNDLE_DIR = path.resolve(OUT_DIR, 'FinAnalyzer');
const APP_DIR = path.resolve(BUNDLE_DIR, 'app');
const SEA_WORK_DIR = path.resolve(OUT_DIR, 'sea-work');
const SEA_CONFIG_PATH = path.resolve(SEA_WORK_DIR, 'sea-config.json');
const SEA_BLOB_PATH = path.resolve(SEA_WORK_DIR, 'sea-prep.blob');
const BOOTSTRAP_PATH = path.resolve(SEA_DIR, 'bootstrap.cjs');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const BIN_NAME = process.platform === 'win32' ? 'FinAnalyzer.exe' : 'FinAnalyzer';
const BIN_PATH = path.resolve(BUNDLE_DIR, BIN_NAME);

const args = new Set(process.argv.slice(2));
const options = {
  withLoader: args.has('--with-loader'),
  skipBuild: args.has('--skip-build'),
  skipInstall: args.has('--skip-install'),
  stageOnly: args.has('--stage-only'),
};

const printHelpAndExit = () => {
  process.stdout.write(
    [
      'Node SEA packager (isolated from app code)',
      '',
      'Usage:',
      '  node sea/build-sea.cjs [options]',
      '',
      'Options:',
      '  --skip-build     Do not run `npm run build` before staging.',
      '  --skip-install   Do not run runtime `npm install` in staged app.',
      '  --stage-only     Prepare distributable folder only (no SEA injection).',
      '  --with-loader    Include `tally-database-loader-main*` folders if present.',
      '  --help           Show this help.',
      '',
    ].join('\n')
  );
  process.exit(0);
};

if (args.has('--help')) {
  printHelpAndExit();
}

// On Windows, npm/npx are .cmd shims. Node >=18.20/20.12/22 refuse to spawn
// .cmd/.bat via execFile* unless shell:true (CVE-2024-27980), and execFile
// also does no PATHEXT resolution — so run npm/npx through the shell there.
// Other commands (node, lipo, codesign) run directly on all platforms.
const isNpmLike = (command) => command === 'npm' || command === 'npx';
const useShellFor = (command) => process.platform === 'win32' && isNpmLike(command);

const run = (command, commandArgs, cwd = ROOT_DIR) => {
  process.stdout.write(`\n> ${command} ${commandArgs.join(' ')}\n`);
  execFileSync(command, commandArgs, { stdio: 'inherit', cwd, shell: useShellFor(command) });
};

const runCapture = (command, commandArgs, cwd = ROOT_DIR) =>
  execFileSync(command, commandArgs, { cwd, encoding: 'utf8', shell: useShellFor(command) });

const ensureDir = (dirPath) => fs.mkdirSync(dirPath, { recursive: true });

const cleanDir = (dirPath) => {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
};

const copyDir = (source, target) => {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, target, { recursive: true });
};

const copyFile = (source, target) => {
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
};

const writeFile = (target, content, mode) => {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content, 'utf8');
  if (typeof mode === 'number') fs.chmodSync(target, mode);
};

const requireExists = (target, message) => {
  if (!fs.existsSync(target)) {
    throw new Error(message || `Missing required file/folder: ${target}`);
  }
};

const createLaunchers = () => {
  const commandPath = path.resolve(BUNDLE_DIR, 'Run FinAnalyzer.command');
  const shellPath = path.resolve(BUNDLE_DIR, 'run-finanalyzer.sh');
  const batPath = path.resolve(BUNDLE_DIR, 'Run-FinAnalyzer.bat');

  writeFile(
    commandPath,
    '#!/bin/zsh\nset -e\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\ncd "$SCRIPT_DIR"\nexec "./' +
      BIN_NAME +
      '"\n',
    0o755
  );

  writeFile(
    shellPath,
    '#!/usr/bin/env bash\nset -euo pipefail\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\ncd "$SCRIPT_DIR"\nexec "./' +
      BIN_NAME +
      '"\n',
    0o755
  );

  writeFile(
    batPath,
    '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"' + BIN_NAME + '"\r\n',
    0o644
  );
};

const stageRuntimeApp = () => {
  const distDir = path.resolve(ROOT_DIR, 'dist');
  const backendDir = path.resolve(ROOT_DIR, 'desktop-backend');
  const backendEntry = path.resolve(backendDir, 'backend.cjs');
  const backendServices = path.resolve(backendDir, 'services');

  requireExists(distDir, 'dist directory missing. Run `npm run build` first.');
  requireExists(path.resolve(distDir, 'index.html'), 'dist/index.html missing. Build did not complete.');
  requireExists(backendEntry, 'desktop-backend/backend.cjs missing.');
  requireExists(backendServices, 'desktop-backend/services missing.');

  copyDir(distDir, path.resolve(APP_DIR, 'dist'));
  copyFile(backendEntry, path.resolve(APP_DIR, 'desktop-backend', 'backend.cjs'));
  copyDir(backendServices, path.resolve(APP_DIR, 'desktop-backend', 'services'));

  if (options.withLoader) {
    const loaderCandidates = [
      path.resolve(ROOT_DIR, 'tally-database-loader-main'),
      path.resolve(ROOT_DIR, 'tally-database-loader-main (1)'),
    ];
    loaderCandidates.forEach((candidate) => {
      if (fs.existsSync(candidate)) {
        copyDir(candidate, path.resolve(APP_DIR, path.basename(candidate)));
      }
    });
  }

  const rootPackage = JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, 'package.json'), 'utf8'));
  // Runtime deps for the SEA-bundled backend. better-sqlite3 is a native
  // addon: `npm install --omit=dev` below pulls the prebuilt .node binary
  // for the platform/Node-ABI we're packaging on. Ship for the same
  // platform you build on, or build inside CI matching the target.
  const runtimePackage = {
    name: 'finanalyzer-runtime',
    private: true,
    version: rootPackage.version || '1.0.0',
    description: 'Runtime dependencies for FinAnalyzer SEA package.',
    dependencies: {
      xlsx: rootPackage?.dependencies?.xlsx || '^0.18.5',
      'xlsx-js-style': rootPackage?.dependencies?.['xlsx-js-style'] || '^1.2.0',
      'better-sqlite3': rootPackage?.dependencies?.['better-sqlite3'] || '^12.4.1',
    },
  };

  writeFile(path.resolve(APP_DIR, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  writeFile(path.resolve(APP_DIR, '.npmrc'), 'fund=false\naudit=false\n');
};

const buildSeaBinary = () => {
  cleanDir(SEA_WORK_DIR);

  const seaConfig = {
    main: BOOTSTRAP_PATH,
    output: SEA_BLOB_PATH,
    disableExperimentalSEAWarning: true,
  };
  writeFile(SEA_CONFIG_PATH, `${JSON.stringify(seaConfig, null, 2)}\n`);

  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG_PATH]);
  requireExists(SEA_BLOB_PATH, 'SEA blob generation failed.');

  copyFile(process.execPath, BIN_PATH);
  fs.chmodSync(BIN_PATH, 0o755);

  if (process.platform === 'darwin') {
    try {
      const info = runCapture('lipo', ['-info', BIN_PATH]).trim();
      const isFat = info.includes(' are: ');
      if (isFat) {
        const thinPath = `${BIN_PATH}.thin`;
        run('lipo', ['-thin', process.arch, BIN_PATH, '-output', thinPath]);
        fs.renameSync(thinPath, BIN_PATH);
      }
    } catch {
      // If lipo is unavailable, continue with the copied binary.
    }
  }

  if (process.platform === 'darwin') {
    try {
      run('codesign', ['--remove-signature', BIN_PATH]);
    } catch {
      // Unsigned binaries can throw here. Ignore.
    }
  }

  const postjectArgs = ['--yes', 'postject', BIN_PATH, 'NODE_SEA_BLOB', SEA_BLOB_PATH, '--sentinel-fuse', FUSE];
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  run('npx', postjectArgs);

  if (process.platform === 'darwin') {
    run('codesign', ['--sign', '-', BIN_PATH]);
  }
};

const main = () => {
  cleanDir(BUNDLE_DIR);
  ensureDir(APP_DIR);

  if (!options.skipBuild) {
    run('npm', ['run', 'build']);
  }

  stageRuntimeApp();

  if (!options.skipInstall) {
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], APP_DIR);
  }

  if (!options.stageOnly) {
    buildSeaBinary();
  } else {
    copyFile(process.execPath, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
  }

  createLaunchers();

  process.stdout.write(
    [
      '',
      'SEA packaging completed.',
      `Output folder: ${BUNDLE_DIR}`,
      `Executable: ${BIN_PATH}`,
      '',
      'Send this folder to end users:',
      `- ${BIN_NAME}`,
      '- app/ (dist + backend + runtime node_modules)',
      '- launcher scripts (optional)',
      '',
    ].join('\n')
  );
};

try {
  main();
} catch (error) {
  process.stderr.write(`\nSEA packaging failed: ${error?.message || String(error)}\n`);
  process.exit(1);
}
