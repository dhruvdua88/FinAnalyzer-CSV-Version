// Schedule III financial-statements workbook builder.
//
// Produces a polished, audit-grade multi-sheet workbook:
//   • Balance Sheet           — per-branch + Consolidated columns, Note links
//   • Statement of P&L        — per-branch + Consolidated columns
//   • N1..N14 note schedules  — each with "Back to BS" + "Index" nav links
//   • Notes Index             — hyperlinked contents
//   • Group Mapping           — working/analysis tab (autofilter + zebra +
//                               optional source-colour coding)
//
// Single Excel-write engine: xlsx-js-style. All visual choices come from the
// shared ./excelStyles helper so the BS, P&L and every note share one theme.
//
// The builder returns a WorkBook; the React component triggers the download
// with XLSX.writeFile (synchronous Blob+anchor) — see exportExcel docs at the
// bottom of this file.

import * as XLSX from 'xlsx-js-style';
import {
  BranchData,
  BsLedger,
  PrimaryGroupInfo,
  bankOdInBankAccounts,
  cashAndBank,
  changesInInventories,
  closingStock,
  currentYearProfit,
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
  taxExpense,
  bsReconciliation,
  BS_MAP,
} from './balanceSheet';
import {
  ALIGN,
  NUMFMT,
  PALETTE,
  SIZE,
  Style,
  columnHeaderStyle,
  font,
  fill,
  grandTotalLabelStyle,
  grandTotalNumberStyle,
  internalLink,
  labelStyle,
  linkStyle,
  numberStyle,
  sectionHeaderStyle,
  sourceColor,
  subBandStyle,
  subtotalLabelStyle,
  subtotalNumberStyle,
  titleBandStyle,
  zebra,
} from './excelStyles';

// ── Sheet names ──
const BS_SHEET = 'Balance Sheet';
const PL_SHEET = 'P&L Statement';
const INDEX_SHEET = 'Notes Index';
const MAP_SHEET = 'Group Mapping';

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
const headFor = (primary: string): string => (primary in BS_MAP ? BS_MAP[primary][1] : 'Profit & Loss');

// A lightweight cell-addressed sheet that converts to a SheetJS worksheet.
interface CellOpt {
  s?: Style;
  z?: string;
  link?: { Target: string; Tooltip?: string };
  num?: boolean;
}

class Sheet {
  private cells: Record<string, any> = {};
  private maxR = 0;
  private maxC = 0;
  merges: any[] = [];
  cols: Array<{ wch: number }> = [];
  freeze?: { r: number; c: number };
  autofilter?: string;

  set(r: number, c: number, v: any, opt: CellOpt = {}): void {
    const ref = XLSX.utils.encode_cell({ r, c });
    const isNum = opt.num ?? typeof v === 'number';
    const cell: any = { v, t: isNum ? 'n' : 's' };
    if (opt.s) cell.s = opt.s;
    // Mirror the style's numFmt onto cell.z so the value renders even in
    // viewers that read .z rather than .s.numFmt.
    const z = opt.z ?? (opt.s && opt.s.numFmt);
    if (z) cell.z = z;
    if (opt.link) cell.l = opt.link;
    this.cells[ref] = cell;
    if (r > this.maxR) this.maxR = r;
    if (c > this.maxC) this.maxC = c;
  }

  merge(r: number, c1: number, c2: number): void {
    this.merges.push({ s: { r, c: c1 }, e: { r, c: c2 } });
    if (c2 > this.maxC) this.maxC = c2;
  }

  // Expose the raw cell store + encoder so excelStyles mutators (zebra) work.
  applyZebra(startRow: number, endRow: number, firstCol: number, lastCol: number): void {
    zebra(this.cells, (a) => XLSX.utils.encode_cell(a), startRow, endRow, firstCol, lastCol);
  }

  toWS(): XLSX.WorkSheet {
    const ws: XLSX.WorkSheet = { ...this.cells };
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: this.maxR, c: this.maxC } });
    if (this.merges.length) ws['!merges'] = this.merges;
    if (this.cols.length) ws['!cols'] = this.cols;
    if (this.freeze) ws['!freeze'] = { xSplit: this.freeze.c, ySplit: this.freeze.r } as any;
    if (this.autofilter) ws['!autofilter'] = { ref: this.autofilter };
    return ws;
  }
}

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
  /** Optional Group Mapping working-schedule data (from collectPrimaryGroups). */
  primaryGroups?: PrimaryGroupInfo[];
  /** Unit shown once in the title block. Defaults to "(Rs.)". */
  unitLabel?: string;
}

/**
 * Build the complete Schedule III financial-statements workbook.
 * Returns a populated xlsx-js-style WorkBook. The caller writes/downloads it
 * with `XLSX.writeFile(wb, name, { compression: true })` (synchronous).
 */
export const buildFinancialStatementsWorkbook = (input: FsWorkbookInput): XLSX.WorkBook => {
  const multi = input.branches.length > 1 && !!input.consolidated;
  const unit = input.unitLabel || '(Rs.)';
  const columns: ColumnSpec[] = multi
    ? [...input.branches.map((b) => ({ name: b.branchName, data: b, isTotal: false })), { name: 'Consolidated', data: input.consolidated!, isTotal: true }]
    : [{ name: `As at ${input.periodLabel}`, data: input.branches[0], isTotal: true }];
  const totalCol = columns[columns.length - 1].data; // consolidated or single branch
  const nVal = columns.length;
  const firstValCol = 2; // A=Particulars, B=Note, values start at C
  const lastCol = firstValCol + nVal - 1;
  const Z = NUMFMT.accounting;

  const wb = XLSX.utils.book_new();

  // ───────────────────────── Balance Sheet ─────────────────────────
  const bs = new Sheet();
  bs.cols = [{ wch: 56 }, { wch: 7 }, ...columns.map(() => ({ wch: 22 }))];
  let r = 0;

  const band = (s: Sheet, text: string, style: Style) => {
    s.merge(r, 0, lastCol);
    s.set(r, 0, text, { s: style, num: false });
    r++;
  };
  band(bs, input.companyTitle.toUpperCase(), titleBandStyle());
  band(bs, `BALANCE SHEET${multi ? '  (Branch-wise + Consolidated)' : ''}`, subBandStyle(12));
  band(bs, `As at ${input.periodLabel}`, subBandStyle(11));
  band(bs, unit, subBandStyle(11, true));

  // Navigation links to Index (row, right side).
  bs.set(r, 0, 'Particulars', { s: columnHeaderStyle(ALIGN.left) });
  bs.set(r, 1, 'Note', { s: columnHeaderStyle(ALIGN.center) });
  columns.forEach((col, i) => bs.set(r, firstValCol + i, col.name, { s: columnHeaderStyle(ALIGN.center), num: false }));
  const headerRow = r;
  r++;

  const subheader = (s: Sheet, text: string) => {
    s.merge(r, 0, lastCol);
    s.set(r, 0, text, { s: sectionHeaderStyle(), num: false });
    r++;
  };

  type Fn = (b: BranchData) => number;
  const line = (
    label: string,
    fn: Fn | null,
    opts: { note?: number; bold?: boolean; total?: boolean; grand?: boolean; muted?: boolean; italic?: boolean } = {},
  ) => {
    const lblStyle = opts.grand
      ? grandTotalLabelStyle()
      : opts.total
      ? subtotalLabelStyle()
      : labelStyle({ bold: opts.bold, italic: opts.italic, muted: opts.muted });
    bs.set(r, 0, label, { s: lblStyle, num: false });
    if (opts.note) {
      bs.set(r, 1, opts.note, {
        s: linkStyle(ALIGN.center),
        link: internalLink(noteSheetName(opts.note), 'A1', `Note ${opts.note}`),
        num: true,
      });
    }
    if (fn) {
      columns.forEach((col, i) => {
        const numS = opts.grand
          ? grandTotalNumberStyle(Z)
          : opts.total
          ? subtotalNumberStyle(Z)
          : numberStyle(Z, { bold: opts.bold, italic: opts.italic, muted: opts.muted });
        bs.set(r, firstValCol + i, Math.round(fn(col.data)), { s: numS, num: true });
      });
    }
    r++;
  };
  const spacer = () => { r++; };

  subheader(bs, "I.  SHAREHOLDERS' FUNDS");
  line('  a)  Share Capital', shareCapital, { note: 1 });
  line('  b)  Reserves & Surplus', reservesSurplus, { note: 2 });
  line('Total Shareholders’ Funds', totalEquity, { total: true });
  spacer();
  subheader(bs, 'II.  NON-CURRENT LIABILITIES');
  line('  a)  Long-Term Borrowings', longTermBorrowings, { note: 3 });
  line('  b)  Deferred Tax Liability', deferredTaxLiability);
  line('Total Non-Current Liabilities', totalNonCurrentLiab, { total: true });
  spacer();
  subheader(bs, 'III.  CURRENT LIABILITIES');
  line('  a)  Short-Term Borrowings', (b) => shortTermBorrowings(b) + bankOdInBankAccounts(b), { note: 4 });
  line('  b)  Trade Payables', tradePayables, { note: 5 });
  line('  c)  Duties & Taxes (Net)', dutiesAndTaxesNet);
  line('  d)  Other Current Liabilities', otherCurrentLiabilities, { note: 6 });
  line('  e)  Short-Term Provisions', shortTermProvisions, { note: 7 });
  line('Total Current Liabilities', totalCurrentLiab, { total: true });
  spacer();
  line('  f)  Opening Balance Difference  (pre-existing / auto-balance)', bsReconciliation, { muted: true, italic: true });
  spacer();
  line('TOTAL EQUITY & LIABILITIES', (b) => totalEquityLiabilities(b) + bsReconciliation(b), { grand: true });
  spacer();
  spacer();
  subheader(bs, 'I.  NON-CURRENT ASSETS');
  line('  a)  Fixed Assets (Net Block)', netFixedAssets, { note: 8 });
  line('  b)  Non-Current Investments', nonCurrentInvestments, { note: 9 });
  line('  c)  Long-Term Loans & Advances', longTermLoansAdvances, { note: 10 });
  line('  d)  Deferred Tax Asset', deferredTaxAsset);
  line('  e)  Other Non-Current Assets', otherNonCurrentAssets);
  line('Total Non-Current Assets', totalNonCurrentAssets, { total: true });
  spacer();
  subheader(bs, 'II.  CURRENT ASSETS');
  line('  a)  Inventories (Closing Stock)', closingStock, { note: 11 });
  line('  b)  Trade Receivables', tradeReceivables, { note: 12 });
  line('  c)  Cash & Cash Equivalents', cashAndBank, { note: 13 });
  line('  d)  Other Current Assets', otherCurrentAssets, { note: 14 });
  line('Total Current Assets', totalCurrentAssets, { total: true });
  spacer();
  line('TOTAL ASSETS', totalAssets, { grand: true });
  spacer();
  line('Balance Sheet Difference  (Assets − Equity & Liabilities)', (b) => totalAssets(b) - totalEquityLiabilities(b) - bsReconciliation(b), { muted: true, italic: true });

  bs.freeze = { r: headerRow + 1, c: firstValCol };
  XLSX.utils.book_append_sheet(wb, bs.toWS(), BS_SHEET);

  // ───────────────────────── Statement of P&L ─────────────────────────
  const pl = new Sheet();
  pl.cols = [{ wch: 52 }, { wch: 18 }, ...columns.map(() => ({ wch: 20 }))];
  r = 0;
  band(pl, input.companyTitle.toUpperCase(), titleBandStyle(13));
  band(pl, `STATEMENT OF PROFIT & LOSS${multi ? '  (Branch-wise + Consolidated)' : ''}`, subBandStyle(12));
  band(pl, `For the Year Ended ${input.periodLabel}`, subBandStyle(11));
  band(pl, unit, subBandStyle(11, true));
  pl.set(r, 0, 'Particulars', { s: columnHeaderStyle(ALIGN.left) });
  pl.set(r, 1, '', { s: columnHeaderStyle(ALIGN.center), num: false });
  columns.forEach((col, i) => pl.set(r, firstValCol + i, multi ? col.name : 'Current Year', { s: columnHeaderStyle(ALIGN.center), num: false }));
  const plHeaderRow = r;
  r++;

  const plLine = (label: string, fn: Fn | null, opts: { bold?: boolean; total?: boolean; grand?: boolean; italic?: boolean } = {}) => {
    const lblStyle = opts.grand
      ? grandTotalLabelStyle()
      : opts.total
      ? subtotalLabelStyle()
      : labelStyle({ bold: opts.bold, italic: opts.italic });
    pl.set(r, 0, label, { s: lblStyle, num: false });
    if (fn) {
      columns.forEach((col, i) => {
        const numS = opts.grand
          ? grandTotalNumberStyle(Z)
          : opts.total
          ? subtotalNumberStyle(Z)
          : numberStyle(Z, { bold: opts.bold, italic: opts.italic });
        pl.set(r, firstValCol + i, Math.round(fn(col.data)), { s: numS, num: true });
      });
    }
    r++;
  };
  plLine('I.   Revenue from Operations', revenueFromOps, { bold: true });
  plLine('II.  Other Income', otherIncome, { bold: true });
  plLine('III. Total Revenue (I + II)', totalRevenue, { total: true });
  spacer();
  plLine('IV.  Expenses', null, { bold: true });
  plLine('     a)  Cost of Materials / Purchases', purchases);
  plLine('     b)  Changes in Inventories', changesInInventories, { italic: true });
  plLine('     c)  Employee Benefits Expense', employeeCosts);
  plLine('     d)  Finance Costs', financeCosts);
  plLine('     e)  Depreciation & Amortisation', depreciationFromFA);
  plLine('     f)  Other Expenses', (b) => otherIndirectExpenses(b) + directExpenses(b));
  plLine('     Total Expenses', totalExpenses, { total: true });
  spacer();
  plLine('V.   Profit Before Tax', profitBeforeTax, { total: true });
  plLine('VI.  Tax Expense (balancing to Tally P&L A/c)', taxExpense);
  plLine('VII. Profit After Tax', profitAfterTax, { grand: true });
  spacer();

  // Key ratios (consolidated / total column).
  pl.merge(r, 0, lastCol);
  pl.set(r, 0, 'KEY FINANCIAL RATIOS', { s: sectionHeaderStyle(), num: false });
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
    pl.set(r, 0, `  ${lbl}`, { s: labelStyle(), num: false });
    pl.set(r, 1, note, { s: { font: font({ sz: 9, color: PALETTE.muted }), alignment: ALIGN.center }, num: false });
    pl.set(r, lastCol, Math.round(amt), { s: numberStyle(Z), num: true });
    r++;
  }
  pl.freeze = { r: plHeaderRow + 1, c: firstValCol };
  XLSX.utils.book_append_sheet(wb, pl.toWS(), PL_SHEET);

  // ───────────────────────── Note sheets ─────────────────────────
  const noteIndex: Array<[number, string, number]> = [];

  // A note sheet: title band, nav links, builder body, then a Total row.
  // `dense` flags schedules that get zebra striping on the data body.
  const noteSheet = (
    num: number,
    title: string,
    build: (s: Sheet, startRow: number) => number,
    total: number,
    opts: { dense?: boolean; cols?: number } = {},
  ) => {
    const s = new Sheet();
    const dataCols = opts.cols ?? 2; // label + 1 value column by default
    s.cols = [{ wch: 48 }, ...Array.from({ length: dataCols - 1 }, () => ({ wch: 20 }))];
    const wide = dataCols - 1;
    s.merge(0, 0, wide);
    s.set(0, 0, `Note ${num}:  ${title}`, { s: titleBandStyle(12), num: false });
    // Nav links row.
    s.set(1, 0, '← Back to Balance Sheet', { s: linkStyle(ALIGN.left), link: internalLink(BS_SHEET, 'A1', 'Balance Sheet'), num: false });
    s.set(1, 1, 'Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Notes Index'), num: false });
    const bodyStart = 2;
    let rr = build(s, bodyStart);
    const bodyEnd = rr - 1;
    rr = noteRow(s, rr, `Total ${title}`, total, { total: true });
    if (opts.dense && bodyEnd >= bodyStart) s.applyZebra(bodyStart, bodyEnd, 0, dataCols - 1);
    // Freeze below the nav row so the body scrolls under it.
    s.freeze = { r: bodyStart, c: 1 };
    XLSX.utils.book_append_sheet(wb, s.toWS(), noteSheetName(num));
    noteIndex.push([num, title, total]);
  };

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
    rr = noteRow(s, rr, 'Retained earnings — opening (prior years)', Math.round(totalCol.pnlOpening));
    rr = noteRow(s, rr, 'Profit for the year (transaction-derived)', Math.round(currentYearProfit(totalCol)));
    return rr;
  }, reservesSurplus(totalCol));

  noteSheet(3, 'Long-Term Borrowings', (s, rr) => listLedgers(s, rr, ['Secured Loans', 'Unsecured Loans', 'Loans (Liability)'], 1, { groupByPrimary: true }), longTermBorrowings(totalCol), { dense: true });
  noteSheet(4, 'Short-Term Borrowings', (s, rr) => {
    rr = listLedgers(s, rr, ['Bank OD A/c'], 1);
    for (const l of ledgersFor(totalCol, 'Bank Accounts')) if (l.closing > 0) rr = noteRow(s, rr, labelFor(l, multi) + ' (credit balance / OD)', Math.round(l.closing));
    return rr;
  }, shortTermBorrowings(totalCol) + bankOdInBankAccounts(totalCol));
  noteSheet(5, 'Trade Payables', (s, rr) => listLedgers(s, rr, ['Sundry Creditors'], 1), tradePayables(totalCol), { dense: true });
  noteSheet(6, 'Other Current Liabilities', (s, rr) => listLedgers(s, rr, ['Current Liabilities', 'Branch / Divisions', 'Suspense A/c'], 1, { groupByPrimary: true }), otherCurrentLiabilities(totalCol), { dense: true });
  noteSheet(7, 'Short-Term Provisions', (s, rr) => listLedgers(s, rr, ['Provisions'], 1), shortTermProvisions(totalCol), { dense: true });

  noteSheet(8, 'Fixed Assets', (s, rr) => {
    const heads = ['Asset Block', 'Gross Block', 'Accum. Depr.', 'Net Block'];
    heads.forEach((h, c) => s.set(rr, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.left : ALIGN.right), num: false }));
    rr++;
    for (const row of fixedAssetsSchedule(totalCol)) {
      s.set(rr, 0, row.name, { s: labelStyle(), num: false });
      s.set(rr, 1, Math.round(row.grossClose), { s: numberStyle(Z), num: true });
      s.set(rr, 2, Math.round(row.deprClose), { s: numberStyle(Z), num: true });
      s.set(rr, 3, Math.round(row.netClose), { s: numberStyle(Z), num: true });
      rr++;
    }
    return rr;
  }, netFixedAssets(totalCol), { dense: true, cols: 4 });

  noteSheet(9, 'Non-Current Investments', (s, rr) => listLedgers(s, rr, ['Investments'], -1), nonCurrentInvestments(totalCol), { dense: true });
  noteSheet(10, 'Long-Term Loans & Advances', (s, rr) => listLedgers(s, rr, ['Deposits (Asset)', 'Loans & Advances (Asset)'], -1, { groupByPrimary: true }), longTermLoansAdvances(totalCol), { dense: true });
  noteSheet(11, 'Inventories', (s, rr) => {
    rr = noteRow(s, rr, 'Closing Stock (Inventories)', Math.round(closingStock(totalCol)));
    return rr;
  }, closingStock(totalCol));
  noteSheet(12, 'Trade Receivables', (s, rr) => listLedgers(s, rr, ['Sundry Debtors'], -1), tradeReceivables(totalCol), { dense: true });
  noteSheet(13, 'Cash & Cash Equivalents', (s, rr) => {
    rr = listLedgers(s, rr, ['Cash-in-hand'], -1);
    for (const l of ledgersFor(totalCol, 'Bank Accounts')) if (l.closing < 0) rr = noteRow(s, rr, labelFor(l, multi), Math.round(-l.closing));
    return rr;
  }, cashAndBank(totalCol), { dense: true });
  noteSheet(14, 'Other Current Assets', (s, rr) => listLedgers(s, rr, ['Current Assets'], -1), otherCurrentAssets(totalCol), { dense: true });

  // ───────────────────────── Notes Index ─────────────────────────
  const idx = new Sheet();
  idx.cols = [{ wch: 8 }, { wch: 40 }, { wch: 22 }];
  idx.merge(0, 0, 2);
  idx.set(0, 0, `${input.companyTitle} — Notes to the Financial Statements`, { s: titleBandStyle(12), num: false });
  // Statement links.
  idx.set(1, 0, '', { s: { fill: fill(PALETTE.section) } });
  idx.set(1, 1, 'Balance Sheet', { s: linkStyle(ALIGN.left), link: internalLink(BS_SHEET, 'A1'), num: false });
  idx.set(1, 2, 'Statement of P&L', { s: linkStyle(ALIGN.left), link: internalLink(PL_SHEET, 'A1'), num: false });
  ['Note', 'Particulars', `Amount ${unit}`].forEach((h, c) => idx.set(2, c, h, { s: columnHeaderStyle(c === 2 ? ALIGN.right : ALIGN.left), num: false }));
  let ir = 3;
  for (const [num, title, amt] of noteIndex) {
    idx.set(ir, 0, num, { s: linkStyle(ALIGN.center), link: internalLink(noteSheetName(num), 'A1', `Note ${num}`), num: true });
    idx.set(ir, 1, title, { s: labelStyle(), num: false });
    idx.set(ir, 2, Math.round(amt), { s: numberStyle(Z), num: true });
    ir++;
  }
  // Group Mapping link footer.
  idx.set(ir + 1, 1, 'Group Mapping (working schedule)', { s: linkStyle(ALIGN.left), link: internalLink(MAP_SHEET, 'A1'), num: false });
  XLSX.utils.book_append_sheet(wb, idx.toWS(), INDEX_SHEET);

  // ───────────────────── Group Mapping (working tab) ─────────────────────
  // Analysis-layer schedule: autofilter + zebra + source-colour coding.
  // Blue = hardcoded input (Tally raw values), black = derived/formula text,
  // green = cross-sheet link (Schedule III head shown on the statement face).
  if (input.primaryGroups && input.primaryGroups.length) {
    const gm = new Sheet();
    gm.cols = [{ wch: 30 }, { wch: 9 }, { wch: 20 }, { wch: 24 }, { wch: 26 }, { wch: 14 }, { wch: 30 }];
    gm.merge(0, 0, 6);
    gm.set(0, 0, 'GROUP MAPPING — Tally Primary Group → Schedule III Head (working schedule)', { s: titleBandStyle(12), num: false });
    const heads = ['Tally Primary Group', 'Ledgers', 'Closing (indicative)', 'Mapped To', 'Schedule III Head', 'How', 'Branches'];
    heads.forEach((h, c) => gm.set(1, c, h, { s: columnHeaderStyle(c === 1 || c === 2 ? ALIGN.right : ALIGN.left), num: false }));
    const dataStart = 2;
    let gr = dataStart;
    for (const g of input.primaryGroups) {
      const classified = g.resolution.classified;
      // Source-colour: raw inputs = blue, derived text = black, cross-sheet head = green.
      gm.set(gr, 0, g.rawPrimary, { s: { font: font({ color: sourceColor('input') }), alignment: ALIGN.left }, num: false });
      gm.set(gr, 1, g.count, { s: { font: font({ color: sourceColor('input') }), alignment: ALIGN.right }, num: true });
      gm.set(gr, 2, Math.round(g.closingSum), { s: { font: font({ color: sourceColor('input') }), alignment: ALIGN.right, numFmt: NUMFMT.accountingInt }, num: true });
      gm.set(gr, 3, classified ? g.resolution.primary : '(unmapped — excluded)', { s: { font: font({ color: sourceColor('formula') }), alignment: ALIGN.left }, num: false });
      gm.set(gr, 4, classified ? headFor(g.resolution.primary) : '-', { s: { font: font({ color: sourceColor('link') }), alignment: ALIGN.left }, num: false });
      gm.set(gr, 5, g.resolution.how, { s: { font: font({ color: sourceColor('formula') }), alignment: ALIGN.left }, num: false });
      gm.set(gr, 6, g.branches.join(', '), { s: { font: font({ color: sourceColor('formula') }), alignment: ALIGN.left }, num: false });
      gr++;
    }
    if (gr - 1 >= dataStart) gm.applyZebra(dataStart, gr - 1, 0, 6);
    gm.autofilter = `${XLSX.utils.encode_cell({ r: 1, c: 0 })}:${XLSX.utils.encode_cell({ r: gr - 1, c: 6 })}`;
    gm.freeze = { r: dataStart, c: 1 };
    XLSX.utils.book_append_sheet(wb, gm.toWS(), MAP_SHEET);
  }

  return wb;
};

// helper: a generic note data row (label + amount in col B).
function noteRow(s: Sheet, r: number, label: string, amount: number | null, opts: { bold?: boolean; total?: boolean; indent?: number } = {}): number {
  const lblStyle = opts.total ? subtotalLabelStyle() : labelStyle({ bold: opts.bold });
  s.set(r, 0, '    '.repeat(opts.indent || 0) + label, { s: lblStyle, num: false });
  if (amount !== null) {
    const numS = opts.total ? subtotalNumberStyle(NUMFMT.accounting) : numberStyle(NUMFMT.accounting, { bold: opts.bold });
    s.set(r, 1, amount, { s: numS, num: true });
  }
  return r + 1;
}

// openingStock isn't re-exported with a short alias; thin wrapper for ratios.
function openingStockSafe(b: BranchData): number {
  // changesInInventories = openingStock - closingStock  =>  openingStock = changes + closing
  return changesInInventories(b) + closingStock(b);
}
