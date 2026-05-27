/**
 * Smoke test for the Party Ledger Matrix.
 *
 * Drives the SAME import pipeline the web app uses:
 *   zip → TallyStore.fromZip → store.getLedgerEntries() → matrix compute()
 *
 * Then prints, for every Tally primary group found, the party-matrix bucket
 * totals — and flags which group the current UI auto-selects by default.
 *
 * Usage:  npx tsx scripts/smokePartyMatrix.ts <path-to-tally-export.zip>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { TallyStore } from '../services/tally';
import { compute } from '../workers/partyMatrixWorker';
import type { LedgerEntry } from '../types';

// ── mirror of PartyLedgerMatrix.tsx helpers ──────────────────────────────────
const isMaster = (entry: LedgerEntry): boolean => {
  const t = String(entry?.is_master_ledger ?? '').trim().toLowerCase();
  if (!t) return false;
  if (['1', 'true', 'yes', 'y'].includes(t)) return true;
  if (['0', 'false', 'no', 'n'].includes(t)) return false;
  const n = Number(t);
  return Number.isFinite(n) ? n > 0 : false;
};

const inr = (v: number) =>
  (v < 0 ? '-' : '') +
  Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('Usage: npx tsx scripts/smokePartyMatrix.ts <zip>');
    process.exit(1);
  }

  const buf = readFileSync(zipPath);
  const blob = new Blob([buf]);
  console.log(`\n=== Party Matrix smoke test ===`);
  console.log(`zip: ${basename(zipPath)}  (${(buf.length / 1024).toFixed(0)} KB)\n`);

  const store = await TallyStore.fromZip(blob);
  const rows = store.getLedgerEntries();

  // Split exactly like the component does.
  const txRows: LedgerEntry[] = [];
  const mstRows: LedgerEntry[] = [];
  const primarySet = new Set<string>();
  for (const r of rows) {
    if (String(r.TallyPrimary || '').trim()) primarySet.add(String(r.TallyPrimary).trim());
    if (isMaster(r)) mstRows.push(r);
    else txRows.push(r);
  }
  const primaries = Array.from(primarySet).sort((a, b) => a.localeCompare(b));
  const suggested = primaries.filter((x) => /(debtor|creditor)/i.test(x));

  // Current UI default-selection logic (PartyLedgerMatrix.tsx:475/508).
  const uiDefault = suggested[0] || primaries[0] || '';

  console.log(`rows: ${rows.length}  (tx ${txRows.length} / master ${mstRows.length})`);
  console.log(`distinct TallyPrimary values: ${primaries.length}`);
  console.log(primaries.map((p) => `   • ${p}`).join('\n'));
  console.log(`\nsuggestedPrimaries (regex /debtor|creditor/): ${suggested.length ? suggested.join(', ') : '(none)'}`);
  console.log(`>>> UI auto-selects by default: "${uiDefault}"\n`);

  // Auto-detect TDS / GST / RCM ledgers the same way the component suggests them.
  const allLedgers = Array.from(new Set(rows.map((r) => String(r.Ledger || '').trim()).filter(Boolean)));
  const tdsLedgers = allLedgers.filter((x) => /(tds|194)/i.test(x));
  const gstLedgers = allLedgers.filter((x) => /(igst|cgst|sgst|utgst|gst|cess)/i.test(x));
  const rcmLedgers = allLedgers.filter((x) => /(rcm|reverse charge)/i.test(x));

  // Run compute() for EVERY primary group and tabulate.
  const header = ['PrimaryGroup', 'Parties', 'Sales', 'Purchase', 'Expenses', 'TDS', 'GST', 'Bank', 'Others'];
  const widths = [28, 8, 14, 14, 14, 12, 12, 14, 14];
  const pad = (s: string, w: number, right = false) =>
    right ? s.padStart(w) : s.padEnd(w);
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i], i > 1)).join(' ');

  console.log(line(header));
  console.log('-'.repeat(widths.reduce((a, b) => a + b + 1, 0)));

  for (const primary of primaries) {
    const out = compute({ txRows, mstRows, primary, tdsLedgers, gstLedgers, rcmLedgers });
    const t = out.rows.reduce(
      (s, r) => ({
        sales: s.sales + r.totalSales,
        purchase: s.purchase + r.totalPurchase,
        expenses: s.expenses + r.totalExpenses,
        tds: s.tds + r.tdsDeducted,
        gst: s.gst + r.gstAmount,
        bank: s.bank + r.bankAmount,
        others: s.others + r.others,
      }),
      { sales: 0, purchase: 0, expenses: 0, tds: 0, gst: 0, bank: 0, others: 0 },
    );
    const activeParties = out.rows.filter(
      (r) =>
        Math.abs(r.totalSales) > 1 ||
        Math.abs(r.totalPurchase) > 1 ||
        Math.abs(r.totalExpenses) > 1 ||
        Math.abs(r.others) > 1,
    ).length;
    const flag = primary === uiDefault ? '  <== UI DEFAULT' : '';
    console.log(
      line([
        primary.slice(0, 28),
        String(activeParties),
        inr(t.sales),
        inr(t.purchase),
        inr(t.expenses),
        inr(t.tds),
        inr(t.gst),
        inr(t.bank),
        inr(t.others),
      ]) + flag,
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED:', e);
  process.exit(1);
});
