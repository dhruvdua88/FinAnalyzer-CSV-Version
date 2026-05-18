#!/usr/bin/env node
// Smoke test the ITC register query against a real Tally export ZIP.
// Run: npx tsx scripts/smoke-test-itc.mjs <zip>

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const zipPath = process.argv[2];
if (!zipPath || !existsSync(zipPath)) {
  console.error('Usage: npx tsx scripts/smoke-test-itc.mjs <path-to-tally-export.zip>');
  process.exit(1);
}

const { TallyStore, getPurchaseITCRegister, deriveItcIssues } =
  await import(pathToFileURL(resolve(projectRoot, 'services/tally/index.ts')).href);

const store = await TallyStore.fromZip(new Blob([readFileSync(zipPath)]));
const rows = getPurchaseITCRegister(store);
const issues = deriveItcIssues(rows);

console.log('── Purchase Register / ITC ─────────────────────────────────────');
console.log('Eligible vouchers:', rows.length);
console.log('');

const fmt = (n) => n.toFixed(2).padStart(12);
const head = ['Date', 'Party', 'VchNo', 'Taxable', 'IGST', 'CGST', 'SGST', 'Tax', 'Type'];
console.log(head.join(' | '));
console.log('-'.repeat(160));
for (const r of rows.slice(0, 25)) {
  console.log([
    r.date,
    (r.partyName || '').slice(0, 30).padEnd(30),
    (r.vchNo || '').slice(0, 15).padEnd(15),
    fmt(r.taxable),
    fmt(r.igst),
    fmt(r.cgst),
    fmt(r.sgst),
    fmt(r.tax),
    r.type,
  ].join(' | '));
}

console.log('');
console.log('── Issues ─────────────────────────────────────────────────────');
console.log('RCM Review (Tax=0):       ', issues.rcmReview.length);
console.log('CGST ≠ SGST:              ', issues.cgstSgstMismatch.length);
console.log('Blank/Invalid GSTIN:      ', issues.blankInvalidGstin.length);
console.log('Missing Invoice Number:   ', issues.noInvoiceNumber.length);

console.log('');
console.log('── Type breakdown ─────────────────────────────────────────────');
const byType = new Map();
for (const r of rows) byType.set(r.type, (byType.get(r.type) || 0) + 1);
for (const [k, v] of byType.entries()) console.log(`  ${k.padEnd(15)} ${v}`);

console.log('');
console.log('── Totals ─────────────────────────────────────────────────────');
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
console.log('Taxable:   ', sum('taxable').toFixed(2));
console.log('IGST:      ', sum('igst').toFixed(2));
console.log('CGST:      ', sum('cgst').toFixed(2));
console.log('SGST:      ', sum('sgst').toFixed(2));
console.log('Tax:       ', sum('tax').toFixed(2));
