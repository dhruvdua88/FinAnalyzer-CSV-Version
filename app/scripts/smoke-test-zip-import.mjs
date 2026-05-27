#!/usr/bin/env node
// Smoke test: pipe a real Tally export ZIP through the parser modules and
// dump summary counts. Run: node scripts/smoke-test-zip-import.mjs <zip>
// Built directly against the .ts sources via tsx-style loader (no compile).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

// Register the on-the-fly TS loader. The repo doesn't ship tsx as a dep, so
// fall back to running a pre-built version of the entry — but for dev
// machines with tsx installed globally this just works.
try { register('tsx/esm', pathToFileURL('./')); } catch { /* fine */ }

const zipPath = process.argv[2];
if (!zipPath) {
  console.error('Usage: node scripts/smoke-test-zip-import.mjs <path-to-tally-export.zip>');
  process.exit(1);
}
if (!existsSync(zipPath)) {
  console.error(`File not found: ${zipPath}`);
  process.exit(1);
}

const { TallyStore } = await import(pathToFileURL(resolve(projectRoot, 'services/tally/index.ts')).href);

const buf = readFileSync(zipPath);
const blob = new Blob([buf]);
const store = await TallyStore.fromZip(blob);
const summary = store.summary();
const rows = store.getLedgerEntries();

const transactional = rows.filter((r) => !r.is_master_ledger);
const masters = rows.filter((r) => r.is_master_ledger);

console.log('── Tally Export Smoke Test ──────────────────────────────────────');
console.log('Company:        ', summary.companyName || '(not in config.xlsx)');
console.log('Period:         ', summary.periodFrom, '→', summary.periodTo);
console.log('Date range:     ', summary.minDate, '→', summary.maxDate);
console.log('Vouchers:       ', summary.vouchers);
console.log('Accounting lns: ', summary.accountingLines);
console.log('Ledgers:        ', summary.ledgers);
console.log('Stock items:    ', summary.stockItems);
console.log('');
console.log('Shim output:');
console.log('  Transactional rows: ', transactional.length);
console.log('  Master-only rows:   ', masters.length);
console.log('  Sample tx row:      ', JSON.stringify(transactional[0] || {}, null, 2).slice(0, 600));
console.log('');
console.log('Table counts in zip:');
for (const [k, v] of Object.entries(store.diagnostics.tableCounts).sort()) {
  console.log(`  ${k.padEnd(40)} ${String(v).padStart(6)}`);
}
