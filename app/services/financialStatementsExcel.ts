// Schedule III financial-statements workbook builder.
//
// Produces a polished multi-sheet workbook modelled on the companion
// tally-fin-statements project: Balance Sheet + Statement of P&L with a Note
// column that hyperlinks to per-head note schedules (N1–N14), a Notes index,
// and per-branch + Consolidated columns. Built with xlsx-js-style.

import * as XLSX from 'xlsx-js-style';
import {
  BranchData,
  BsLedger,
  bankOdInBankAccounts,
  cashAndBank,
  changesInInventories,
  closingStock,
  deferredTaxAsset,
  deferredTaxLiability,
  depreciationFromFA,
  directExpenses,
  dutiesAndTaxesNet,
  employeeCosts,
  financeCosts,
  fixedAssetsSchedule,
  ledgersFor,
  longTermBorrowings,
  longTermLoansAdvances,
  netFixedAssets,
  nonCurrentInvestments,
  otherCurrentAssets,
  otherCurrentLiabilities,
  otherIncome,
  otherIndirectExpenses,
  otherNonCurrentAssets,
  profitAfterTax,
  profitBeforeTax,
  purchases,
  reservesSurplus,
  revenueFromOps,
  shareCapital,
  shortTermBorrowings,
  shortTermProvisions,
  sumClosing,
  taxExpense,
  totalAssets,
  totalCurrentAssets,
  totalCurrentLiab,
  totalEquity,
  totalEquityLiabilities,
  totalExpenses,
  totalNonCurrentAssets,
  totalNonCurrentLiab,
  totalRevenue,
  tradePayables,
  tradeReceivables,
  bsReconciliation,
} from './balanceSheet';

// ── Palette (matches the reference) ──
const C = {
  dark: '1F3864',
  mid: '2F5496',
  light: 'D6E4F0',
  total: 'D9E1F2',
  white: 'FFFFFF',
  amberTxt: '6B6B6B',
  link: '1D4ED8',
  green: 'C6EFCE',
  greenTxt: '006100',
  red: 'C0392B',
};
const MONEY = '#,##0;(#,##0)';
const ACC = '#,##0;(#,##0);"–"';

type Style = Record<string, any>;
interface CellOpt {
  s?: Style;
  z?: string;
  link?: string;
  bold?: boolean;
  num?: boolean;
}

// A lightweight cell-addressed sheet that converts to a SheetJS worksheet.
class Sheet {
  private cells: Record<string, any> = {};
  private maxR = 0;
  private maxC = 0;
  merges: any[] = [];
  cols: Array<{ wch: number }> = [];
  freeze?: { r: number; c: number };

  set(r: number, c: number, v: any, opt: CellOpt = {}): void {
    const ref = XLSX.utils.encode_cell({ r, c });
    const isNum = opt.num ?? typeof v === 'number';
    const cell: any = { v, t: isNum ? 'n' : 's' };
    if (opt.z) cell.z = opt.z;
    if (opt.s) cell.s = opt.s;
    if (opt.link) cell.l = { Target: opt.link };
    this.cells[ref] = cell;
    if (r > this.maxR) this.maxR = r;
    if (c > this.maxC) this.maxC = c;
  }

  merge(r: number, c1: number, c2: number): void {
    this.merges.push({ s: { r, c: c1 }, e: { r, c: c2 } });
    if (c2 > this.maxC) this.maxC = c2;
  }

  toWS(): XLSX.WorkSheet {
    const ws: XLSX.WorkSheet = { ...this.cells };
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: this.maxR, c: this.maxC } });
    if (this.merges.length) ws['!merges'] = this.merges;
    if (this.cols.length) ws['!cols'] = this.cols;
    if (this.freeze) ws['!freeze'] = { xSplit: this.freeze.c, ySplit: this.freeze.r } as any;
    return ws;
  }
}

const font = (bold = false, sz = 10, color = '000000', italic = false) => ({ name: 'Calibri', bold, sz, color: { rgb: color }, italic });
const fill = (rgb: string) => ({ patternType: 'solid', fgColor: { rgb } });
const alignR = { horizontal: 'right', vertical: 'center' };
const alignC = { horizontal: 'center', vertical: 'center', wrapText: true };
const alignL = { horizontal: 'left', vertical: 'center' };

// ── Note registry: number → sheet name, title, and a detail builder ──
const noteSheetName = (n: number): string =>
  ({
    1: 'N1 Share Capital',
    2: 'N2 Reserves Surplus',
    3: 'N3 LT Borrowings',
    4: 'N4 ST Borrowings',
    5: 'N5 Trade Payables',
    6: 'N6 Other CL',
    7: 'N7 Provisions',
    8: 'N8 Fixed Assets',
    9: 'N9 NC Investments',
    10: 'N10 LT Loans',
    11: 'N11 Inventories',
    12: 'N12 Trade Receivables',
    13: 'N13 Cash & Bank',
    14: 'N14 Other CA',
  }[n] || `Note ${n}`);

const labelFor = (l: BsLedger, multi: boolean): string => (multi && l.branch ? `[${l.branch}] ${l.name}` : l.name);

interface ColumnSpec {
  name: string;
  data: BranchData;
  isTotal: boolean;
}

export interface FsWorkbookInput {
  branches: BranchData[];
  consolidated: BranchData | null;
  companyTitle: string;
  periodLabel: string;
}

export const buildFinancialStatementsWorkbook = (input: FsWorkbookInput): XLSX.WorkBook => {
  const multi = input.branches.length > 1 && !!input.consolidated;
  const columns: ColumnSpec[] = multi
    ? [...input.branches.map((b) => ({ name: b.branchName, data: b, isTotal: false })), { name: 'Consolidated', data: input.consolidated!, isTotal: true }]
    : [{ name: `As at ${input.periodLabel}`, data: input.branches[0], isTotal: true }];
  const totalCol = columns[columns.length - 1].data; // consolidated or single branch
  const nVal = columns.length;
  const firstValCol = 2; // A=0 Particulars, B=1 Note, values start at C=2

  const wb = XLSX.utils.book_new();

  // ───────────────────────── Balance Sheet ─────────────────────────
  const bs = new Sheet();
  bs.cols = [{ wch: 56 }, { wch: 6 }, ...columns.map(() => ({ wch: 20 }))];
  let r = 0;
  const lastCol = firstValCol + nVal - 1;

  const banner = (text: string, bg: string, fg: string, sz: number, bold = true) => {
    bs.merge(r, 0, lastCol);
    bs.set(r, 0, text, { s: { font: font(bold, sz, fg), fill: fill(bg), alignment: alignC } });
    r++;
  };
  banner(input.companyTitle.toUpperCase(), C.dark, C.white, 14);
  banner(`BALANCE SHEET${multi ? '  (Branch-wise + Consolidated)' : ''}`, C.dark, C.white, 12);
  banner(`As at ${input.periodLabel}`, C.mid, C.white, 10);
  banner('(All amounts in ₹  ·  negatives in parentheses)', C.light, '000000', 9, false);

  // Column header row
  bs.set(r, 0, 'Particulars', { s: { font: font(true, 9, C.white), fill: fill(C.mid), alignment: alignL } });
  bs.set(r, 1, 'Note', { s: { font: font(true, 9, C.white), fill: fill(C.mid), alignment: alignC } });
  columns.forEach((col, i) => bs.set(r, firstValCol + i, col.name, { s: { font: font(true, 9, C.white), fill: fill(C.mid), alignment: alignC }, num: false }));
  const headerRow = r;
  r++;

  const subheader = (text: string) => {
    bs.merge(r, 0, lastCol);
    bs.set(r, 0, text, { s: { font: font(true, 10, C.white), fill: fill(C.mid), alignment: alignL } });
    r++;
  };

  type Fn = (b: BranchData) => number;
  const line = (label: string, fn: Fn | null, opts: { note?: number; bold?: boolean; total?: boolean; grand?: boolean; muted?: boolean; z?: string } = {}) => {
    const strong = opts.bold || opts.total || opts.grand;
    const aStyle: Style = { font: font(strong, opts.grand ? 11 : 10, opts.grand ? C.white : opts.muted ? C.amberTxt : '000000', opts.muted), alignment: alignL };
    if (opts.total) aStyle.fill = fill(C.total);
    if (opts.grand) aStyle.fill = fill(C.dark);
    bs.set(r, 0, label, { s: aStyle, num: false });
    if (opts.note) {
      bs.set(r, 1, opts.note, { s: { font: { ...font(false, 9, C.link), underline: true }, alignment: alignC }, link: `#'${noteSheetName(opts.note)}'!A1`, num: true });
    }
    if (fn) {
      columns.forEach((col, i) => {
        const vStyle: Style = { font: font(strong, opts.grand ? 11 : 10, opts.grand ? C.white : opts.muted ? C.amberTxt : '000000', opts.muted), alignment: alignR };
        if (opts.total) vStyle.fill = fill(C.total);
        if (opts.grand) vStyle.fill = fill(C.dark);
        bs.set(r, firstValCol + i, Math.round(fn(col.data)), { s: vStyle, z: opts.z || ACC, num: true });
      });
    }
    r++;
  };
  const spacer = () => { r++; };

  subheader("I.  SHAREHOLDERS' FUNDS");
  line('  a)  Share Capital', shareCapital, { note: 1 });
  line('  b)  Reserves & Surplus', reservesSurplus, { note: 2 });
  line('Total Shareholders’ Funds', totalEquity, { total: true });
  spacer();
  subheader('II.  NON-CURRENT LIABILITIES');
  line('  a)  Long-Term Borrowings', longTermBorrowings, { note: 3 });
  line('  b)  Deferred Tax Liability', deferredTaxLiability);
  line('Total Non-Current Liabilities', totalNonCurrentLiab, { total: true });
  spacer();
  subheader('III.  CURRENT LIABILITIES');
  line('  a)  Short-Term Borrowings', (b) => shortTermBorrowings(b) + bankOdInBankAccounts(b), { note: 4 });
  line('  b)  Trade Payables', tradePayables, { note: 5 });
  line('  c)  Duties & Taxes (Net)', dutiesAndTaxesNet);
  line('  d)  Other Current Liabilities', otherCurrentLiabilities, { note: 6 });
  line('  e)  Short-Term Provisions', shortTermProvisions, { note: 7 });
  line('Total Current Liabilities', totalCurrentLiab, { total: true });
  spacer();
  line('  f)  Year-end Reconciliation  (auto-balance)', bsReconciliation, { muted: true });
  spacer();
  line('TOTAL EQUITY & LIABILITIES', (b) => totalEquityLiabilities(b) + bsReconciliation(b), { grand: true });
  spacer();
  spacer();
  subheader('I.  NON-CURRENT ASSETS');
  line('  a)  Fixed Assets (Net Block)', netFixedAssets, { note: 8 });
  line('  b)  Non-Current Investments', nonCurrentInvestments, { note: 9 });
  line('  c)  Long-Term Loans & Advances', longTermLoansAdvances, { note: 10 });
  line('  d)  Deferred Tax Asset', deferredTaxAsset);
  line('  e)  Other Non-Current Assets', otherNonCurrentAssets);
  line('Total Non-Current Assets', totalNonCurrentAssets, { total: true });
  spacer();
  subheader('II.  CURRENT ASSETS');
  line('  a)  Inventories (Closing Stock)', closingStock, { note: 11 });
  line('  b)  Trade Receivables', tradeReceivables, { note: 12 });
  line('  c)  Cash & Cash Equivalents', cashAndBank, { note: 13 });
  line('  d)  Other Current Assets', otherCurrentAssets, { note: 14 });
  line('Total Current Assets', totalCurrentAssets, { total: true });
  spacer();
  line('TOTAL ASSETS', totalAssets, { grand: true });
  spacer();
  line('Balance Sheet Difference  (Assets − Equity & Liabilities)', (b) => totalAssets(b) - totalEquityLiabilities(b) - bsReconciliation(b), { z: ACC });
  // green/red flag on the diff row
  {
    const diffRow = r - 1;
    columns.forEach((col, i) => {
      const v = Math.round(totalAssets(col.data) - totalEquityLiabilities(col.data) - bsReconciliation(col.data));
      const ok = Math.abs(v) <= 1;
      bs.set(diffRow, firstValCol + i, v, { s: { font: font(true, 10, ok ? C.greenTxt : C.white), fill: fill(ok ? C.green : C.red), alignment: alignR }, z: ACC, num: true });
    });
  }
  bs.freeze = { r: headerRow + 1, c: firstValCol };
  XLSX.utils.book_append_sheet(wb, bs.toWS(), 'Balance Sheet');

  // ───────────────────────── Statement of P&L ─────────────────────────
  const pl = new Sheet();
  pl.cols = [{ wch: 52 }, { wch: 8 }, ...columns.map(() => ({ wch: 18 }))];
  r = 0;
  const plLast = lastCol;
  const plBanner = (text: string, bg: string, fg: string, sz: number, bold = true) => {
    pl.merge(r, 0, plLast);
    pl.set(r, 0, text, { s: { font: font(bold, sz, fg), fill: fill(bg), alignment: alignC } });
    r++;
  };
  plBanner(input.companyTitle.toUpperCase(), C.dark, C.white, 13);
  plBanner(`STATEMENT OF PROFIT & LOSS${multi ? '  (Branch-wise + Consolidated)' : ''}`, C.dark, C.white, 11);
  plBanner(`For the Year Ended ${input.periodLabel}`, C.mid, C.white, 10);
  plBanner('(Amount in ₹)', C.light, '000000', 9, false);
  pl.set(r, 0, 'Particulars', { s: { font: font(true, 9, C.white), fill: fill(C.mid), alignment: alignL } });
  columns.forEach((col, i) => pl.set(r, firstValCol + i, multi ? col.name : 'Current Year', { s: { font: font(true, 9, C.white), fill: fill(C.mid), alignment: alignC }, num: false }));
  const plHeaderRow = r;
  r++;

  const plLine = (label: string, fn: Fn | null, opts: { bold?: boolean; total?: boolean; grand?: boolean; italic?: boolean } = {}) => {
    const strong = opts.bold || opts.total || opts.grand;
    const aStyle: Style = { font: font(strong, opts.grand ? 11 : 10, opts.grand ? C.white : '000000', opts.italic), alignment: alignL };
    if (opts.total) aStyle.fill = fill(C.total);
    if (opts.grand) aStyle.fill = fill(C.dark);
    pl.set(r, 0, label, { s: aStyle, num: false });
    if (fn) {
      columns.forEach((col, i) => {
        const vStyle: Style = { font: font(strong, opts.grand ? 11 : 10, opts.grand ? C.white : '000000', opts.italic), alignment: alignR };
        if (opts.total) vStyle.fill = fill(C.total);
        if (opts.grand) vStyle.fill = fill(C.dark);
        pl.set(r, firstValCol + i, Math.round(fn(col.data)), { s: vStyle, z: MONEY, num: true });
      });
    }
    r++;
  };
  plLine('I.   Revenue from Operations', revenueFromOps, { bold: true });
  plLine('II.  Other Income', otherIncome, { bold: true });
  plLine('III. Total Revenue (I + II)', totalRevenue, { total: true });
  r++;
  plLine('IV.  Expenses', null, { bold: true });
  plLine('     a)  Cost of Materials / Purchases', purchases);
  plLine('     b)  Changes in Inventories', changesInInventories, { italic: true });
  plLine('     c)  Employee Benefits Expense', employeeCosts);
  plLine('     d)  Finance Costs', financeCosts);
  plLine('     e)  Depreciation & Amortisation', depreciationFromFA);
  plLine('     f)  Other Expenses', (b) => otherIndirectExpenses(b) + directExpenses(b));
  plLine('     Total Expenses', totalExpenses, { total: true });
  r++;
  plLine('V.   Profit Before Tax', profitBeforeTax, { total: true });
  plLine('VI.  Tax Expense (balancing to Tally P&L A/c)', taxExpense);
  plLine('VII. Profit After Tax', profitAfterTax, { grand: true });
  r++;
  // Key ratios (consolidated/total column)
  pl.merge(r, 0, plLast);
  pl.set(r, 0, 'KEY FINANCIAL RATIOS', { s: { font: font(true, 10, C.white), fill: fill(C.mid), alignment: alignL } });
  r++;
  const rev = revenueFromOps(totalCol);
  const gp = rev - purchases(totalCol) + (closingStock(totalCol) - openingStockSafe(totalCol));
  const ebitda = profitBeforeTax(totalCol) + financeCosts(totalCol) + depreciationFromFA(totalCol);
  const ratios: Array<[string, number, string]> = [
    ['Gross Profit', gp, rev ? `${((gp / rev) * 100).toFixed(1)}% of Revenue` : 'N/A'],
    ['EBITDA', ebitda, rev ? `${((ebitda / rev) * 100).toFixed(1)}% of Revenue` : 'N/A'],
    ['PBT', profitBeforeTax(totalCol), rev ? `${((profitBeforeTax(totalCol) / rev) * 100).toFixed(1)}% of Revenue` : 'N/A'],
    ['PAT', profitAfterTax(totalCol), rev ? `${((profitAfterTax(totalCol) / rev) * 100).toFixed(1)}% of Revenue` : 'N/A'],
  ];
  for (const [lbl, amt, note] of ratios) {
    pl.set(r, 0, `  ${lbl}`, { s: { font: font(false, 10), alignment: alignL }, num: false });
    pl.set(r, 1, note, { s: { font: font(false, 8, '595959'), alignment: alignC }, num: false });
    pl.set(r, firstValCol + nVal - 1, Math.round(amt), { s: { font: font(false, 10), alignment: alignR }, z: MONEY, num: true });
    r++;
  }
  pl.freeze = { r: plHeaderRow + 1, c: firstValCol };
  XLSX.utils.book_append_sheet(wb, pl.toWS(), 'P&L Statement');

  // ───────────────────────── Note sheets ─────────────────────────
  const noteIndex: Array<[number, string, number]> = [];

  const noteSheet = (num: number, title: string, build: (s: Sheet, startRow: number) => number, total: number) => {
    const s = new Sheet();
    s.cols = [{ wch: 48 }, { wch: 20 }, { wch: 20 }];
    s.merge(0, 0, 2);
    s.set(0, 0, `Note ${num}:  ${title}`, { s: { font: font(true, 11, C.white), fill: fill(C.dark), alignment: alignC }, num: false });
    s.merge(1, 0, 2);
    s.set(1, 0, '← Back to Balance Sheet', { s: { font: { ...font(false, 9, C.link), underline: true }, alignment: alignL }, link: "#'Balance Sheet'!A1", num: false });
    let rr = build(s, 2);
    rr = noteRow(s, rr, `Total ${title}`, total, { total: true });
    XLSX.utils.book_append_sheet(wb, s.toWS(), noteSheetName(num));
    noteIndex.push([num, title, total]);
  };

  // list ledgers for a head (with sign) onto a note sheet
  const listLedgers = (s: Sheet, startRow: number, primaries: string[], sign: number, opts: { groupByPrimary?: boolean } = {}): number => {
    let rr = startRow;
    for (const pg of primaries) {
      const ls = ledgersFor(totalCol, pg);
      if (!ls.length) continue;
      if (opts.groupByPrimary && primaries.length > 1) rr = noteRow(s, rr, pg, null, { bold: true });
      for (const l of ls) rr = noteRow(s, rr, labelFor(l, multi), Math.round(sign * l.closing), { indent: opts.groupByPrimary && primaries.length > 1 ? 1 : 0 });
    }
    return rr;
  };

  noteSheet(1, 'Share Capital', (s, rr) => {
    for (const l of ledgersFor(totalCol, 'Capital Account')) {
      const lc = l.name.toLowerCase();
      if (!lc.includes('reserve') && !lc.includes('profit')) rr = noteRow(s, rr, labelFor(l, multi), Math.round(l.closing));
    }
    return rr;
  }, shareCapital(totalCol));

  noteSheet(2, 'Reserves & Surplus', (s, rr) => {
    for (const l of ledgersFor(totalCol, 'Capital Account')) if (l.name.toLowerCase().includes('reserve')) rr = noteRow(s, rr, labelFor(l, multi), Math.round(l.closing));
    for (const l of ledgersFor(totalCol, 'Reserves & Surplus')) rr = noteRow(s, rr, labelFor(l, multi), Math.round(l.closing));
    rr = noteRow(s, rr, 'Profit for the year (P&L A/c, cumulative)', Math.round(totalCol.pnlBalance));
    return rr;
  }, reservesSurplus(totalCol));

  noteSheet(3, 'Long-Term Borrowings', (s, rr) => listLedgers(s, rr, ['Secured Loans', 'Unsecured Loans', 'Loans (Liability)'], 1, { groupByPrimary: true }), longTermBorrowings(totalCol));
  noteSheet(4, 'Short-Term Borrowings', (s, rr) => {
    rr = listLedgers(s, rr, ['Bank OD A/c'], 1);
    for (const l of ledgersFor(totalCol, 'Bank Accounts')) if (l.closing > 0) rr = noteRow(s, rr, labelFor(l, multi) + ' (credit balance / OD)', Math.round(l.closing));
    return rr;
  }, shortTermBorrowings(totalCol) + bankOdInBankAccounts(totalCol));
  noteSheet(5, 'Trade Payables', (s, rr) => listLedgers(s, rr, ['Sundry Creditors'], 1), tradePayables(totalCol));
  noteSheet(6, 'Other Current Liabilities', (s, rr) => listLedgers(s, rr, ['Current Liabilities', 'Branch / Divisions', 'Suspense A/c'], 1, { groupByPrimary: true }), otherCurrentLiabilities(totalCol));
  noteSheet(7, 'Short-Term Provisions', (s, rr) => listLedgers(s, rr, ['Provisions'], 1), shortTermProvisions(totalCol));

  noteSheet(8, 'Fixed Assets', (s, rr) => {
    // schedule table header
    const heads = ['Asset Block', 'Gross Block', 'Accum. Depr.', 'Net Block'];
    heads.forEach((h, c) => s.set(rr, c, h, { s: { font: font(true, 9, C.white), fill: fill(C.mid), alignment: c === 0 ? alignL : alignR }, num: false }));
    rr++;
    for (const row of fixedAssetsSchedule(totalCol)) {
      s.set(rr, 0, row.name, { s: { font: font(false, 9), alignment: alignL }, num: false });
      s.set(rr, 1, Math.round(row.grossClose), { s: { font: font(false, 9), alignment: alignR }, z: MONEY, num: true });
      s.set(rr, 2, Math.round(row.deprClose), { s: { font: font(false, 9), alignment: alignR }, z: MONEY, num: true });
      s.set(rr, 3, Math.round(row.netClose), { s: { font: font(false, 9), alignment: alignR }, z: MONEY, num: true });
      rr++;
    }
    return rr;
  }, netFixedAssets(totalCol));

  noteSheet(9, 'Non-Current Investments', (s, rr) => listLedgers(s, rr, ['Investments'], -1), nonCurrentInvestments(totalCol));
  noteSheet(10, 'Long-Term Loans & Advances', (s, rr) => listLedgers(s, rr, ['Deposits (Asset)', 'Loans & Advances (Asset)'], -1, { groupByPrimary: true }), longTermLoansAdvances(totalCol));
  noteSheet(11, 'Inventories', (s, rr) => {
    rr = noteRow(s, rr, 'Closing Stock (Inventories)', Math.round(closingStock(totalCol)));
    return rr;
  }, closingStock(totalCol));
  noteSheet(12, 'Trade Receivables', (s, rr) => listLedgers(s, rr, ['Sundry Debtors'], -1), tradeReceivables(totalCol));
  noteSheet(13, 'Cash & Cash Equivalents', (s, rr) => {
    rr = listLedgers(s, rr, ['Cash-in-hand'], -1);
    for (const l of ledgersFor(totalCol, 'Bank Accounts')) if (l.closing < 0) rr = noteRow(s, rr, labelFor(l, multi), Math.round(-l.closing));
    return rr;
  }, cashAndBank(totalCol));
  noteSheet(14, 'Other Current Assets', (s, rr) => listLedgers(s, rr, ['Current Assets'], -1), otherCurrentAssets(totalCol));

  // Notes index
  const idx = new Sheet();
  idx.cols = [{ wch: 8 }, { wch: 36 }, { wch: 22 }];
  idx.merge(0, 0, 2);
  idx.set(0, 0, `${input.companyTitle} — Notes to the Financial Statements`, { s: { font: font(true, 12, C.white), fill: fill(C.dark), alignment: alignC }, num: false });
  ['Note', 'Particulars', 'Amount (₹)'].forEach((h, c) => idx.set(1, c, h, { s: { font: font(true, 9, C.white), fill: fill(C.mid), alignment: c === 2 ? alignR : alignL }, num: false }));
  let ir = 2;
  for (const [num, title, amt] of noteIndex) {
    idx.set(ir, 0, num, { s: { font: { ...font(false, 10, C.link), underline: true }, alignment: alignC }, link: `#'${noteSheetName(num)}'!A1`, num: true });
    idx.set(ir, 1, title, { s: { font: font(false, 10), alignment: alignL }, num: false });
    idx.set(ir, 2, Math.round(amt), { s: { font: font(false, 10), alignment: alignR }, z: MONEY, num: true });
    ir++;
  }
  XLSX.utils.book_append_sheet(wb, idx.toWS(), 'Notes Index');

  return wb;
};

// helper: a generic note data row (label + amount in col B)
function noteRow(s: Sheet, r: number, label: string, amount: number | null, opts: { bold?: boolean; total?: boolean; indent?: number } = {}): number {
  const strong = opts.bold || opts.total;
  const aStyle: Style = { font: font(strong, 9), alignment: alignL };
  if (opts.total) aStyle.fill = fill(C.total);
  s.set(r, 0, '    '.repeat(opts.indent || 0) + label, { s: aStyle, num: false });
  if (amount !== null) {
    const vStyle: Style = { font: font(strong, 9), alignment: alignR };
    if (opts.total) vStyle.fill = fill(C.total);
    s.set(r, 1, amount, { s: vStyle, z: MONEY, num: true });
  }
  return r + 1;
}

// openingStock isn't re-exported with a short alias; thin wrapper for ratios.
function openingStockSafe(b: BranchData): number {
  // changesInInventories = openingStock - closingStock  ⇒  openingStock = changes + closing
  return changesInInventories(b) + closingStock(b);
}
