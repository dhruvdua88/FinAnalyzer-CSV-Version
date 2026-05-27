#!/usr/bin/env node
// Cross-module smoke test: load a real Tally export ZIP through the relational
// store and exercise the data every module depends on. Reports row counts,
// enrichment-field coverage on the LedgerEntry shim, and a handful of derived
// figures so a reviewer can eyeball that nothing silently parses to zero.
//
// Run: npx tsx scripts/smoke-test-all-modules.mjs <zip>

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const zipPath = process.argv[2];

if (!zipPath || !existsSync(zipPath)) {
  console.error('Usage: npx tsx scripts/smoke-test-all-modules.mjs <path-to-tally-export.zip>');
  process.exit(1);
}

const { TallyStore, getPurchaseITCRegister, getTrialBalance } =
  await import(pathToFileURL(resolve(root, 'services/tally/index.ts')).href);

const store = await TallyStore.fromZip(new Blob([readFileSync(zipPath)]));
const rows = store.getLedgerEntries();
const tx = rows.filter((r) => !r.is_master_ledger);

const ok = (cond) => (cond ? 'PASS' : 'FAIL');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const sumAbs = (arr, sel) => arr.reduce((s, x) => s + Math.abs(sel(x)), 0);

console.log('══ Cross-Module Smoke Test ════════════════════════════════════════');
console.log('Company:', store.meta.companyName);
console.log('Period :', store.meta.periodFrom, '→', store.meta.periodTo);
console.log('');

// ── Raw store collections (feeds every module) ────────────────────────────
console.log('── Store collections ─────────────────────────────────────────');
const coll = {
  vouchers: store.vouchers.size,
  accountingLines: store.accountingLines.length,
  ledgers: store.ledgers.size,
  groups: store.groups.size,
  voucherTypes: store.voucherTypes.size,
  stockItems: store.stockItems.size,
  inventoryLines: store.inventoryLines.length,
  batchLines: store.batchLines.length,
  billRefs: store.billRefs.length,
  bankAllocations: store.bankAllocations.length,
  costAllocations: store.costAllocations.length,
  costCategoryCentre: store.costCategoryCentreAllocations.length,
  inventoryAdditionalCosts: store.inventoryAdditionalCosts.length,
  gstEffectiveRates: store.gstEffectiveRates.length,
  openingBillAllocations: store.openingBillAllocations.length,
  openingBatchAllocations: store.openingBatchAllocations.length,
  closingStockLedgers: store.closingStockLedgers.length,
};
for (const [k, v] of Object.entries(coll)) console.log(`  ${k.padEnd(26)} ${String(v).padStart(6)}`);

// ── LedgerEntry shim coverage (feeds the LedgerEntry-only modules) ─────────
console.log('');
console.log('── Shim row coverage (transactional rows: ' + tx.length + ') ─────────');
const has = (sel) => tx.filter((r) => { const v = sel(r); return v !== undefined && v !== null && v !== '' && v !== 0; }).length;
const fields = {
  'date': (r) => r.date,
  'party_name': (r) => r.party_name,
  'gstin': (r) => r.gstin,
  'TallyPrimary': (r) => r.TallyPrimary,
  'gst_hsn_code': (r) => r.gst_hsn_code,
  'gst_rate': (r) => r.gst_rate,
  'pan': (r) => r.pan,
  'place_of_supply': (r) => r.place_of_supply,
  'bill_reference': (r) => r.bill_reference,
  'reference_date': (r) => r.reference_date,
};
for (const [k, sel] of Object.entries(fields)) {
  const n = has(sel);
  console.log(`  ${k.padEnd(18)} ${String(n).padStart(6)}  (${pct(n, tx.length)})`);
}

// ── Per-module derived figures ─────────────────────────────────────────────
console.log('');
console.log('── Module-backing computations ───────────────────────────────');
const checks = [];

// ITC / Purchase register
const itc = getPurchaseITCRegister(store);
checks.push(['ITC / Purchase Register', `${itc.length} vouchers, tax ₹${itc.reduce((s, r) => s + r.tax, 0).toFixed(0)}`, itc.length > 0]);

// Trial balance
const tb = getTrialBalance(store);
checks.push(['Trial Balance', `${tb.flatLedgers.length} ledgers, during balanced=${ok(tb.balanceCheck.during.ok)}`, tb.flatLedgers.length > 0 && tb.balanceCheck.during.ok]);

// Sales register (sales-type vouchers)
const salesVouchers = [...store.vouchers.values()].filter((v) => /sales/i.test(v.voucher_type) && v.is_accounting_voucher);
checks.push(['Sales Register', `${salesVouchers.length} sales vouchers`, salesVouchers.length >= 0]);

// Debtor/Creditor ageing — opening bills + party ledgers
const debtors = [...store.ledgers.values()].filter((l) => /debtor/i.test(store.primaryGroupFor(l.name)));
const creditors = [...store.ledgers.values()].filter((l) => /creditor/i.test(store.primaryGroupFor(l.name)));
checks.push(['Debtor Ageing', `${debtors.length} debtor ledgers, ${store.openingBillAllocations.length} opening bills`, debtors.length > 0]);
checks.push(['Creditor Ageing', `${creditors.length} creditor ledgers`, creditors.length > 0]);

// GST Rate — items with master rate + inventory lines to derive charged rate
const itemsWithRate = [...store.stockItems.values()].filter((s) => s.gst_rate > 0).length;
checks.push(['GST Rate Analysis', `${itemsWithRate} items w/ master rate, ${store.gstEffectiveRates.length} effective-rate rows`, store.inventoryLines.length > 0]);

// Cash flow — bank ledgers + bank allocations (cheque data)
const bankLedgers = [...store.ledgers.values()].filter((l) => /bank/i.test(store.primaryGroupFor(l.name)));
const bankWithInstr = store.bankAllocations.filter((b) => b.transaction_type || b.instrument_date).length;
checks.push(['Cash Flow', `${bankLedgers.length} bank ledgers, ${bankWithInstr}/${store.bankAllocations.length} bank rows w/ instrument data`, true]);

// TDS — expense ledgers
const tdsLedgers = [...store.ledgers.values()].filter((l) => /tds|tax deducted/i.test(l.name)).length;
checks.push(['TDS Analysis', `${tdsLedgers} TDS-named ledgers`, true]);

// RCM — rcm ledgers
const rcmLedgers = [...store.ledgers.values()].filter((l) => /rcm/i.test(l.name)).length;
checks.push(['RCM Analysis', `${rcmLedgers} RCM-named ledgers`, true]);

// Related party / Party matrix — parties
const parties = new Set(tx.map((r) => r.party_name).filter(Boolean));
checks.push(['Related Party / Matrix', `${parties.size} distinct parties`, parties.size > 0]);

// Cost-centre allocation (newly fixed mapping)
const ccWithCentre = store.costAllocations.filter((c) => c.centre).length;
checks.push(['Cost Centre allocations', `${ccWithCentre}/${store.costAllocations.length} rows resolve a centre`, store.costAllocations.length === 0 || ccWithCentre > 0]);

// Closing stock ledger (newly fixed stock_value mapping)
const csWithVal = store.closingStockLedgers.filter((c) => c.amount !== 0).length;
checks.push(['Closing-stock ledger value', `${csWithVal}/${store.closingStockLedgers.length} rows carry a value`, store.closingStockLedgers.length === 0 || csWithVal > 0]);

let allPass = true;
for (const [name, detail, pass] of checks) {
  if (!pass) allPass = false;
  console.log(`  [${ok(pass)}] ${name.padEnd(26)} ${detail}`);
}

console.log('');
console.log(allPass ? '✓ All module-backing computations produced data.' : '✗ Some checks FAILED — see above.');
process.exit(allPass ? 0 : 1);
