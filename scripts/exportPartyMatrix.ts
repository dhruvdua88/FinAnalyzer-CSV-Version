/**
 * Generates a Party Ledger Matrix Excel from a Tally export zip — the same
 * compute() the app's UI uses — so we can eyeball the output offline.
 *
 * Usage: npx tsx scripts/exportPartyMatrix.ts <zip> [outfile.xlsx]
 */
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx-js-style';
import { TallyStore } from '../services/tally';
import { compute, type PartyRow } from '../workers/partyMatrixWorker';
import type { LedgerEntry } from '../types';

const isMaster = (e: LedgerEntry) => {
  const t = String(e?.is_master_ledger ?? '').trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'y';
};
const ddmmyyyy = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

async function main() {
  const zipPath = process.argv[2];
  const out = process.argv[3] || 'party_matrix_smoke.xlsx';
  if (!zipPath) {
    console.error('Usage: npx tsx scripts/exportPartyMatrix.ts <zip> [out.xlsx]');
    process.exit(1);
  }

  const store = await TallyStore.fromZip(new Blob([readFileSync(zipPath)]));
  const rows = store.getLedgerEntries();
  const txRows = rows.filter((r) => !isMaster(r));
  const mstRows = rows.filter((r) => isMaster(r));

  // ledger -> its primary group, used to tag tax ledgers ONLY when they sit
  // under "Duties & Taxes" (so an income ledger named "...(IGST)" is NOT
  // misread as a GST ledger).
  const ledgerPrimary = new Map<string, string>();
  for (const r of rows) {
    const l = String(r.Ledger || '').trim();
    if (l && !ledgerPrimary.has(l)) ledgerPrimary.set(l, String(r.TallyPrimary || '').trim());
  }
  const allLedgers = Array.from(ledgerPrimary.keys());
  const underDuties = (l: string) => /duties\s*&\s*taxes|duties and taxes/i.test(ledgerPrimary.get(l) || '');
  const tdsLedgers = allLedgers.filter((l) => /\btds\b|194/i.test(l) && underDuties(l));
  const gstLedgers = allLedgers.filter((l) => /(igst|cgst|sgst|utgst|gst|cess)/i.test(l) && underDuties(l));
  const rcmLedgers = allLedgers.filter((l) => /(rcm|reverse charge)/i.test(l));

  console.log(`Tagged tax ledgers — TDS:${tdsLedgers.length} GST:${gstLedgers.length} RCM:${rcmLedgers.length}`);

  const wb = XLSX.utils.book_new();
  const groups = ['Sundry Debtors', 'Sundry Creditors'];

  const headers = [
    'Party', 'Vch', 'First', 'Last', 'Sales', 'Purchase', 'Expenses',
    'TDS', 'TDS/Exp %', 'GST', 'GST/(S+E) %', 'RCM', 'Bank', 'Others', 'Net Balance', 'Top Exp/Purch Ledgers',
  ];

  for (const primary of groups) {
    const res = compute({ txRows, mstRows, primary, tdsLedgers, gstLedgers, rcmLedgers });
    const active = res.rows
      .filter((r) =>
        Math.abs(r.totalSales) > 1 || Math.abs(r.totalPurchase) > 1 || Math.abs(r.totalExpenses) > 1 ||
        Math.abs(r.tdsDeducted) > 1 || Math.abs(r.gstAmount) > 1 || Math.abs(r.bankAmount) > 1 ||
        Math.abs(r.others) > 1 || Math.abs(r.netBalance) > 1)
      .sort((a, b) => Math.abs(b.totalSales + b.totalPurchase + b.totalExpenses) - Math.abs(a.totalSales + a.totalPurchase + a.totalExpenses));

    const aoa: any[][] = [
      [`Party Ledger Matrix — ${primary}`],
      [`Parties in group: ${res.partyUniverseCount} · active shown: ${active.length} · unbalanced vouchers: ${res.unbalancedVoucherCount}`],
      [],
      headers,
    ];
    const num = (n: number) => Math.round(n);
    active.forEach((r: PartyRow) => {
      aoa.push([
        r.partyName, r.voucherCount, ddmmyyyy(r.firstDate), ddmmyyyy(r.lastDate),
        num(r.totalSales), num(r.totalPurchase), num(r.totalExpenses),
        num(r.tdsDeducted), r.tdsExpensePct == null ? '' : Math.round(r.tdsExpensePct * 10) / 10,
        num(r.gstAmount), r.gstSalesExpensePct == null ? '' : Math.round(r.gstSalesExpensePct * 10) / 10,
        num(r.rcmAmount), num(r.bankAmount), num(r.others), num(r.netBalance),
        r.expenseLedgerList,
      ]);
    });
    const tot = active.reduce((s, r) => {
      s.sales += r.totalSales; s.pur += r.totalPurchase; s.exp += r.totalExpenses;
      s.tds += r.tdsDeducted; s.gst += r.gstAmount; s.rcm += r.rcmAmount; s.bank += r.bankAmount;
      s.oth += r.others; s.net += r.netBalance; return s;
    }, { sales: 0, pur: 0, exp: 0, tds: 0, gst: 0, rcm: 0, bank: 0, oth: 0, net: 0 });
    aoa.push(['TOTAL', '', '', '', num(tot.sales), num(tot.pur), num(tot.exp), num(tot.tds), '', num(tot.gst), '', num(tot.rcm), num(tot.bank), num(tot.oth), num(tot.net), '']);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 34 }, { wch: 6 }, { wch: 11 }, { wch: 11 }, ...Array(11).fill({ wch: 14 }), { wch: 50 }];
    const lastCol = headers.length - 1;
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    ];
    // basic styling
    const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '111827' } }, alignment: { horizontal: 'center', wrapText: true } };
    const titleStyle = { font: { bold: true, sz: 14, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1E3A8A' } } };
    for (let c = 0; c <= lastCol; c++) {
      const t = ws[XLSX.utils.encode_cell({ r: 0, c })]; if (t) t.s = titleStyle;
      const h = ws[XLSX.utils.encode_cell({ r: 3, c })]; if (h) h.s = headerStyle;
    }
    const totRow = 4 + active.length;
    for (let c = 0; c <= lastCol; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: totRow, c })];
      if (cell) cell.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0F766E' } } };
    }
    for (let r = 4; r < totRow; r++) {
      for (let c = 4; c <= 14; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell) cell.z = '#,##0';
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, primary.slice(0, 28));
    console.log(`  ${primary}: ${active.length} active parties, sales=${Math.round(tot.sales)} purchase=${Math.round(tot.pur)} expenses=${Math.round(tot.exp)}`);
  }

  XLSX.writeFile(wb, out);
  console.log(`\nWrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
