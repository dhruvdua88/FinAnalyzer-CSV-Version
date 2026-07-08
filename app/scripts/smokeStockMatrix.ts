/* Focused smoke test for the stock-item (194Q) additions to partyMatrixWorker.
 * Run: npx tsx scripts/smokeStockMatrix.ts
 * Tests the real compute() — Q1 base (amount+additional−discount), Q2 goods/
 * service split by HSN/SAC, Q7 voucher-wise sign, per-PAN key, apportionment. */
import { compute, type PartyMatrixWorkerInput } from '../workers/partyMatrixWorker';

const row = (o: any) => o; // LedgerEntry is structurally loose

const input: PartyMatrixWorkerInput = {
  primary: 'Creditors',
  tdsLedgers: [],
  gstLedgers: [],
  rcmLedgers: [],
  txRows: [
    // V1 — Purchase from Redington (single party → share = 1)
    row({ guid: 'V1', TallyPrimary: 'Creditors', Ledger: 'Redington Ltd.', amount: -120, date: '2026-04-10', voucher_type: 'Purchase', voucher_number: '1' }),
    row({ guid: 'V1', TallyPrimary: 'Purchase Accounts', Ledger: 'Purchase A/c', amount: 120, date: '2026-04-10', voucher_type: 'Purchase', voucher_number: '1' }),
    // V2 — Purchase Return to Redington (dir must be −1)
    row({ guid: 'V2', TallyPrimary: 'Creditors', Ledger: 'Redington Ltd.', amount: 10, date: '2026-04-20', voucher_type: 'Purchase Return', voucher_number: '2' }),
    row({ guid: 'V2', TallyPrimary: 'Purchase Accounts', Ledger: 'Purchase A/c', amount: -10, date: '2026-04-20', voucher_type: 'Purchase Return', voucher_number: '2' }),
  ],
  mstRows: [
    row({ guid: 'ledger-master-1', TallyPrimary: 'Creditors', Ledger: 'Redington Ltd.', pan: 'AAACR1234R', closing_balance: 0 }),
  ],
  inventoryLines: [
    // V1: Servers (goods, incl freight 5 − discount 3), Warranty (service). Export stores negatives.
    { guid: 'V1', item: 'Servers', quantity: -5, amount: -100, additional_amount: -5, discount_amount: -3 },
    { guid: 'V1', item: 'Warranty Support', quantity: -3, amount: -20, additional_amount: 0, discount_amount: 0 },
    // V2: Servers returned (qty 2, value 40)
    { guid: 'V2', item: 'Servers', quantity: 2, amount: 40, additional_amount: 0, discount_amount: 0 },
  ],
  stockMaster: [
    { name: 'Servers', hsn: '84715000', gstRate: 18 },
    { name: 'Warranty Support', hsn: '998713', gstRate: 18 },
  ],
};

const out = compute(input);
const red = out.rows.find((r) => r.partyName === 'Redington Ltd.');
if (!red) throw new Error('Redington row missing');

// Expected:
//  V1 Servers goods = |−100 + −5 − (−3)| = |−102| = 102 ; V2 Servers return = |40|×−1 = −40
//    → Servers net goods value = 102 − 40 = 62
//  V1 Warranty service = |−20| = 20
const servers = red.stockItems.find((s) => s.item === 'Servers')!;
const warranty = red.stockItems.find((s) => s.item === 'Warranty Support')!;

const approx = (a: number, b: number) => Math.abs(a - b) < 0.001;
const checks: [string, boolean][] = [
  ['panKey = AAACR1234R', red.panKey === 'AAACR1234R'],
  ['goodsValue = 62 (194Q base)', approx(red.goodsValue, 62)],
  ['serviceValue = 20', approx(red.serviceValue, 20)],
  ['Servers classified goods', servers.nature === 'goods'],
  ['Servers HSN 84715000', servers.hsn === '84715000'],
  ['Servers net value 62', approx(servers.value, 62)],
  ['Servers qty net 3 (5−2)', approx(servers.quantity, 3)],
  ['Warranty classified service (SAC 99..)', warranty.nature === 'service'],
  ['Warranty value 20', approx(warranty.value, 20)],
  ['Servers spans 2 vouchers', servers.voucherCount === 2],
];

// Per-PAN 194Q rollup
const pan = out.pan194q.find((p) => p.pan === 'AAACR1234R');
checks.push(['194Q rollup present for PAN', !!pan]);
if (pan) {
  checks.push(['PAN goods = 62', approx(pan.goodsValue, 62)]);
  checks.push(['PAN not over ₹50L (62 < 50L)', pan.over50L === false]);
  checks.push(['PAN excess = 0', approx(pan.excessOver50L, 0)]);
  checks.push(['PAN groups Redington ledger', pan.parties.includes('Redington Ltd.')]);
}

// Synthetic over-threshold check: scale Redington to > ₹50L and re-verify slab math
{
  const big = compute({
    ...input,
    inventoryLines: [{ guid: 'V1', item: 'Servers', quantity: -1, amount: -60000000, additional_amount: 0, discount_amount: 0 }],
  });
  const p = big.pan194q.find((x) => x.pan === 'AAACR1234R')!;
  checks.push(['Over ₹50L flagged (6Cr goods)', p.over50L === true]);
  checks.push(['Excess = 6Cr − 50L = 5.5Cr', approx(p.excessOver50L, 60000000 - 5000000)]);
  checks.push(['TDS @0.1% = 55,000', approx(p.tds194qAt01pct, (60000000 - 5000000) * 0.001)]);
}

let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) ok = false;
}
console.log(`\ngoodsValue=${red.goodsValue}  serviceValue=${red.serviceValue}  panKey=${red.panKey}`);
console.log('stockItems:', JSON.stringify(red.stockItems, null, 0));
if (!ok) { process.exit(1); }
console.log('\nALL STOCK CHECKS PASSED');
