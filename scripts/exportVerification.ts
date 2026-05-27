/**
 * Verification export: runs the real backends against a Tally zip and writes a
 * multi-sheet Excel (Trial Balance, Purchase ITC, Orphan P&L, TDS) so the
 * numbers can be eyeballed. Also prints the Trial Balance reconciliation
 * breakdown to explain any closing-side imbalance.
 *
 * Usage: npx tsx scripts/exportVerification.ts <zip> [out.xlsx]
 */
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx-js-style';
import { TallyStore } from '../services/tally';
import { getTrialBalance, getPurchaseITCRegister } from '../services/tally/queries';
import type { LedgerEntry } from '../types';

// worker shim
let captured: ((e: { data: any }) => void) | null = null;
let lastOutput: any = null;
(globalThis as any).self = {
  addEventListener: (_t: string, cb: any) => { captured = cb; },
  postMessage: (x: any) => { lastOutput = x; },
};
async function runWorker(mod: string, input: any) {
  captured = null; lastOutput = null;
  await import(mod);
  captured!({ data: input });
  return lastOutput;
}

const isMaster = (e: LedgerEntry) => /^(1|true|yes|y)$/i.test(String(e?.is_master_ledger ?? '').trim());
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const inr = (v: number) => (v < 0 ? '-' : '') + Math.abs(Math.round(v)).toLocaleString('en-IN');

const title = { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1E3A8A' } } };
const head = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '111827' } }, alignment: { horizontal: 'center', wrapText: true } };
const totalStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0F766E' } } };

function sheet(wb: any, name: string, titleText: string, headers: string[], rows: any[][], totalRow?: any[]) {
  const aoa: any[][] = [[titleText], [], headers, ...rows];
  if (totalRow) aoa.push(totalRow);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const last = headers.length - 1;
  ws['!cols'] = headers.map((h, i) => ({ wch: i === 0 ? 36 : Math.max(10, Math.min(22, h.length + 4)) }));
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: last } }];
  for (let c = 0; c <= last; c++) {
    const t = ws[XLSX.utils.encode_cell({ r: 0, c })]; if (t) t.s = title;
    const h = ws[XLSX.utils.encode_cell({ r: 2, c })]; if (h) h.s = head;
  }
  if (totalRow) {
    const tr = 3 + rows.length;
    for (let c = 0; c <= last; c++) { const cell = ws[XLSX.utils.encode_cell({ r: tr, c })]; if (cell) cell.s = totalStyle; }
  }
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

async function main() {
  const zip = process.argv[2];
  const out = process.argv[3] || 'module_verification.xlsx';
  if (!zip) { console.error('Usage: npx tsx scripts/exportVerification.ts <zip> [out.xlsx]'); process.exit(1); }

  const store = await TallyStore.fromZip(new Blob([readFileSync(zip)]));
  const rows = store.getLedgerEntries();
  const txRows = rows.filter((r) => !isMaster(r));
  const mstRows = rows.filter((r) => isMaster(r));
  const wb = XLSX.utils.book_new();

  // ─────────── Trial Balance ───────────
  const tb: any = getTrialBalance(store);
  const fl = tb.flatLedgers as any[];
  const tbRows = fl
    .filter((r) => r.openingDr || r.openingCr || r.duringDr || r.duringCr || r.closingDr || r.closingCr)
    .sort((a, b) => Math.abs(b.closingSigned) - Math.abs(a.closingSigned))
    .map((r) => [r.ledger, r.primaryGroup, r2(r.openingDr), r2(r.openingCr), r2(r.duringDr), r2(r.duringCr),
      r2(r.closingDr), r2(r.closingCr), r2(r.reconDelta), r.reconPass ? '' : 'RECON FAIL']);
  const gt = tb.grandTotals;
  sheet(wb, 'Trial Balance', `Trial Balance  (${tb.periodFrom} → ${tb.periodTo})`,
    ['Ledger', 'Primary', 'Opening Dr', 'Opening Cr', 'During Dr', 'During Cr', 'Closing Dr', 'Closing Cr', 'Recon Δ', 'Flag'],
    tbRows,
    ['GRAND TOTAL', '', r2(gt.openingDr), r2(gt.openingCr), r2(gt.duringDr), r2(gt.duringCr), r2(gt.closingDr), r2(gt.closingCr), '', '']);

  // TB diagnostics sheet — balance check + worst recon offenders
  const offenders = fl.filter((r) => !r.reconPass)
    .sort((a, b) => Math.abs(b.reconDelta) - Math.abs(a.reconDelta));
  const bc = tb.balanceCheck;
  const diagRows: any[][] = [
    ['Opening', r2(bc.opening.dr), r2(bc.opening.cr), r2(bc.opening.delta), bc.opening.ok ? 'OK' : 'IMBALANCED'],
    ['During (transactions)', r2(bc.during.dr), r2(bc.during.cr), r2(bc.during.delta), bc.during.ok ? 'OK' : 'IMBALANCED'],
    ['Closing', r2(bc.closing.dr), r2(bc.closing.cr), r2(bc.closing.delta), bc.closing.ok ? 'OK' : 'IMBALANCED'],
    [], ['Top reconciliation failures (opening + movement ≠ master closing):', '', '', '', ''],
    ['Ledger', 'Opening', 'During Net', 'Closing (calc)', 'Closing (master) / Δ'],
    ...offenders.slice(0, 30).map((r) => [r.ledger, r2(r.openingSigned), r2(r.duringNet), r2(r.closingCalculated), `${r2(r.closingSigned)}  (Δ ${r2(r.reconDelta)})`]),
  ];
  sheet(wb, 'TB Diagnostics', 'Trial Balance — Balance Check & Recon', ['Check', 'Dr', 'Cr', 'Delta', 'Status'], diagRows);

  // ─────────── Purchase ITC ───────────
  const itc = getPurchaseITCRegister(store);
  const itcRows = itc.map((r) => [r.date, r.partyName, r.partyGstinUin, r.vchNo, r2(r.taxable), r2(r.igst), r2(r.cgst), r2(r.sgst), r2(r.tax), r.reverseCharge, r.itcAvailability, r.expenseLedgers]);
  const itcTot = itc.reduce((s, r) => ({ t: s.t + r.taxable, i: s.i + r.igst, c: s.c + r.cgst, sg: s.sg + r.sgst, tx: s.tx + r.tax }), { t: 0, i: 0, c: 0, sg: 0, tx: 0 });
  sheet(wb, 'Purchase ITC', 'Purchase ITC Register', ['Date', 'Party', 'GSTIN', 'Inv No', 'Taxable', 'IGST', 'CGST', 'SGST', 'Tax', 'RCM', 'ITC?', 'Expense Ledgers'],
    itcRows, ['TOTAL', '', '', '', r2(itcTot.t), r2(itcTot.i), r2(itcTot.c), r2(itcTot.sg), r2(itcTot.tx), '', '', '']);

  // ─────────── Orphan P&L ───────────
  const orphanFilters = { fromDate: null, toDate: null, voucherTypeFilter: 'all', plBucketFilter: 'all', routedBucketFilter: 'all', minAmount: 0, hideCashBankOnly: false, search: '' };
  const orphan = await runWorker('../workers/orphanPLWorker.ts', { rows: txRows, filters: orphanFilters });
  const oRows = orphan.vouchers.map((v: any) => [v.date, v.voucher_type, v.voucher_number, r2(v.plAmount), v.dominantPLBucket, v.dominantRoutedBucket, v.isCashBankOnly ? 'Y' : '', (v.plLegs || []).map((l: any) => l.ledger).join(', '), (v.narration || '').slice(0, 80)]);
  sheet(wb, 'Orphan P&L', `Orphan P&L Vouchers (flagged ${orphan.stats.totalFlagged} of ${orphan.stats.totalVouchersScanned})`,
    ['Date', 'Vch Type', 'Vch No', 'P&L Amt', 'P&L Bucket', 'Routed To', 'Cash/Bank only', 'P&L Ledgers', 'Narration'], oRows);

  // ─────────── TDS ───────────
  const ledgerPrimary = new Map<string, string>();
  for (const r of rows) { const l = String(r.Ledger || '').trim(); if (l && !ledgerPrimary.has(l)) ledgerPrimary.set(l, String(r.TallyPrimary || '')); }
  const tdsLedgers = new Set([...ledgerPrimary.keys()].filter((l) => (/\btds\b|194/i.test(l)) && /duties/i.test(ledgerPrimary.get(l) || '')));
  const isExp = (e: LedgerEntry) => /expense|purchase/i.test(String(e.TallyPrimary || ''));
  const vmap = new Map<string, LedgerEntry[]>();
  txRows.forEach((e) => { const k = `${String(e.voucher_number || e.invoice_number || 'UNK').trim()}__${e.date}__${e.voucher_type}`; (vmap.get(k) || vmap.set(k, []).get(k)!).push(e); });
  const raw: any[] = [];
  vmap.forEach((entries) => {
    const tds = entries.filter((e) => tdsLedgers.has(String(e.Ledger || '')));
    const totalTds = Math.abs(tds.reduce((s, e) => s + Number(e.amount || 0), 0));
    const tdsNames = [...new Set(tds.map((e) => String(e.Ledger || '').trim()))].join('||');
    const party = entries.find((e) => e.party_name)?.party_name || '';
    const expMap = new Map<string, number>();
    entries.forEach((e) => { if (isExp(e)) expMap.set(String(e.Ledger || ''), (expMap.get(String(e.Ledger || '')) || 0) + Number(e.amount || 0)); });
    expMap.forEach((amt, led) => raw.push({ voucher_number: '', date: '', voucher_type: '', expense_ledger: led, net_amount: amt, party_name: party, narration: '', total_tds: totalTds, tds_ledger_names: tdsNames }));
  });
  const tdsOut = await runWorker('../workers/tdsWorker.ts', { rows: raw, thresholdConfig: { enabled: false, sectionMappings: [] }, filters: { viewMode: 'ledger', minVoucherAmount: 0, minLedgerAmount: 0, statusFilter: 'all', rateFilter: 'all' } });
  const tdsRows = (tdsOut.groups || []).sort((a: any, b: any) => b.totalBase - a.totalBase)
    .map((g: any) => [g.key, r2(g.totalBase), r2(g.totalTDS), `${r2(g.avgAppliedRate)}%`, g.deductedCount, g.shortDeductedCount, g.missedCount, `${r2(g.complianceRate)}%`]);
  sheet(wb, 'TDS', 'TDS Analysis (by expense ledger)', ['Ledger', 'Base', 'TDS', 'Avg Rate', 'Deducted', 'Short', 'Missed', 'Compliance'], tdsRows);

  XLSX.writeFile(wb, out);

  // ── console investigation output ──
  console.log(`\n=== Trial Balance reconciliation ===`);
  console.log(`opening  Dr ${inr(bc.opening.dr)}  Cr ${inr(bc.opening.cr)}  Δ ${inr(bc.opening.delta)}  ${bc.opening.ok ? 'OK' : 'IMBALANCED'}`);
  console.log(`during   Dr ${inr(bc.during.dr)}  Cr ${inr(bc.during.cr)}  Δ ${inr(bc.during.delta)}  ${bc.during.ok ? 'OK' : 'IMBALANCED'}`);
  console.log(`closing  Dr ${inr(bc.closing.dr)}  Cr ${inr(bc.closing.cr)}  Δ ${inr(bc.closing.delta)}  ${bc.closing.ok ? 'OK' : 'IMBALANCED'}`);
  console.log(`recon failures: ${offenders.length}, sum of their reconΔ = ${inr(offenders.reduce((s, r) => s + r.reconDelta, 0))}`);
  console.log(`\nWorst recon offenders:`);
  offenders.slice(0, 8).forEach((r) => console.log(`  ${r.ledger.padEnd(40)} open ${inr(r.openingSigned).padStart(14)}  during ${inr(r.duringNet).padStart(14)}  calc ${inr(r.closingCalculated).padStart(14)}  master ${inr(r.closingSigned).padStart(14)}  Δ ${inr(r.reconDelta).padStart(14)}`));
  console.log(`\nWrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
