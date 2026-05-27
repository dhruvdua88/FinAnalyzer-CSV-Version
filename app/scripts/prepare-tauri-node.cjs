const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceNodeExe = process.execPath;
const targetDir = path.join(projectRoot, 'src-tauri', 'resources', 'node');
const targetNodeExe = path.join(targetDir, process.platform === 'win32' ? 'node.exe' : 'node');

if (!sourceNodeExe || !fs.existsSync(sourceNodeExe)) {
  console.error('Unable to locate Node runtime for Tauri resources.');
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourceNodeExe, targetNodeExe);

console.log(`Prepared bundled Node runtime: ${targetNodeExe}`);
