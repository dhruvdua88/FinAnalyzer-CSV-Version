#!/usr/bin/env node
// Smoke-test the Trial Balance query against a real export.
// Run: npx tsx scripts/smoke-test-tb.mjs <zip>

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const zipPath = process.argv[2];

if (!zipPath || !existsSync(zipPath)) {
  console.error('Usage: npx tsx scripts/smoke-test-tb.mjs <path-to-tally-export.zip>');
  process.exit(1);
}

const { TallyStore, getTrialBalance } =
  await import(pathToFileURL(resolve(root, 'services/tally/index.ts')).href);

const store = await TallyStore.fromZip(new Blob([readFileSync(zipPath)]));
const tb = getTrialBalance(store);

const fmt = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log('── Balance Check ───────────────────────────────────────────────');
console.log(`Opening  Dr ${fmt(tb.balanceCheck.opening.dr).padStart(20)}   Cr ${fmt(tb.balanceCheck.opening.cr).padStart(20)}   delta ${fmt(tb.balanceCheck.opening.delta).padStart(10)}   ${tb.balanceCheck.opening.ok ? '✓' : '✗'}`);
console.log(`During   Dr ${fmt(tb.balanceCheck.during.dr).padStart(20)}   Cr ${fmt(tb.balanceCheck.during.cr).padStart(20)}   delta ${fmt(tb.balanceCheck.during.delta).padStart(10)}   ${tb.balanceCheck.during.ok ? '✓' : '✗'}`);
console.log(`Closing  Dr ${fmt(tb.balanceCheck.closing.dr).padStart(20)}   Cr ${fmt(tb.balanceCheck.closing.cr).padStart(20)}   delta ${fmt(tb.balanceCheck.closing.delta).padStart(10)}   ${tb.balanceCheck.closing.ok ? '✓' : '✗'}`);

console.log('');
console.log('── Activity Counts ────────────────────────────────────────────');
for (const [k, v] of Object.entries(tb.activityCounts)) console.log(`  ${k.padEnd(12)} ${v}`);

console.log('');
console.log('── Reconciliation Failures ────────────────────────────────────');
console.log(`  Total ledgers:        ${tb.flatLedgers.length}`);
console.log(`  Recon failures:       ${tb.reconciliationFailures.length}`);
if (tb.reconciliationFailures.length > 0) {
  for (const r of tb.reconciliationFailures.slice(0, 10)) {
    console.log(`    ${r.ledger.slice(0, 40).padEnd(40)} opening ${fmt(r.openingSigned).padStart(14)}  + during ${fmt(r.duringNet).padStart(14)}  = calc ${fmt(r.closingCalculated).padStart(14)}  vs master ${fmt(r.closingSigned).padStart(14)}  Δ ${fmt(r.reconDelta).padStart(10)}`);
  }
}

console.log('');
console.log('── Group Tree (top level) ─────────────────────────────────────');
const dumpTree = (node, indent = 0) => {
  const pad = '  '.repeat(indent);
  const ledgerCount = node.ledgerCount ? `(${node.ledgerCount} L)`.padEnd(8) : ''.padEnd(8);
  console.log(`${pad}${node.name.padEnd(36 - indent * 2)} ${ledgerCount}  Op Dr ${fmt(node.openingDr).padStart(14)}  Op Cr ${fmt(node.openingCr).padStart(14)}  Dur Dr ${fmt(node.duringDr).padStart(12)}  Dur Cr ${fmt(node.duringCr).padStart(12)}  Cl Dr ${fmt(node.closingDr).padStart(14)}  Cl Cr ${fmt(node.closingCr).padStart(14)}`);
  for (const sub of node.childGroups.slice(0, 5)) dumpTree(sub, indent + 1);
  if (indent === 0) {
    for (const lr of node.childLedgers.slice(0, 3)) {
      const pp = '  '.repeat(indent + 1);
      console.log(`${pp}${'L: ' + lr.ledger.slice(0, 32)}`);
    }
  }
};
for (const root of tb.tree.slice(0, 12)) dumpTree(root);

console.log('');
console.log('── Sample dormant + new + closed ledgers ──────────────────────');
for (const tag of ['dormant', 'new', 'closed']) {
  const samples = tb.flatLedgers.filter((r) => r.activity === tag).slice(0, 3);
  for (const r of samples) {
    console.log(`  ${tag.padEnd(8)} ${r.ledger.slice(0, 36).padEnd(36)} group=${r.group.slice(0, 18).padEnd(18)} opening ${fmt(r.openingSigned).padStart(14)} during ${fmt(r.duringNet).padStart(14)} closing ${fmt(r.closingSigned).padStart(14)}`);
  }
}
