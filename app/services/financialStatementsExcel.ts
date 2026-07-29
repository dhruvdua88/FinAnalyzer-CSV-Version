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

// Default import, not `import * as`: xlsx-js-style is CommonJS, and under Node
// ESM a namespace import exposes no properties — which breaks the headless
// validator. The default import works in both Vite and Node.
import XLSX from 'xlsx-js-style';
import { AgeingResult, BUCKET_LABELS } from './ageingFifo';
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
  dutiesTaxesPayable,
  employeeDues,
  advancesFromCustomers,
  shortTermLoansAdvances,
  cwipTotal,
  intangibleAssets,
  intangiblesUnderDevelopment,
  tradePayablesMsme,
  tradePayablesOther,
  unclassifiedCr,
  unclassifiedDr,
  currentInvestments,
  otherLongTermLiabilities,
  longTermProvisions,
  shareApplicationMoney,
  depreciation,
  ledgersForLine,
  lineSum,
  surplusTransfer,
  LINE_BY_ID,
  isPnlLine,
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
  FINANCE_COST_PARENTS,
  EMPLOYEE_COST_PARENTS,
} from './balanceSheet';
import {
  ALIGN,
  NUMFMT,
  PALETTE,
  SIZE,
  Style,
  Sheet,
  columnHeaderStyle,
  errorBandStyle,
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
const LEDGER_INDEX_SHEET = 'Ledger Index';
const MAP_SHEET = 'Group Mapping';



const labelFor = (l: BsLedger, multi: boolean): string => (multi && l.branch ? `[${l.branch}] ${l.name}` : l.name);
const headFor = (primary: string): string => (primary in BS_MAP ? BS_MAP[primary][1] : 'Profit & Loss');

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
  /** FIFO ageing for Trade Payables (Sundry Creditors), consolidated/merged. */
  payablesAgeing?: AgeingResult;
  /** FIFO ageing for Trade Receivables (Sundry Debtors), consolidated/merged. */
  receivablesAgeing?: AgeingResult;
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

  // ───────────────────── Note schedules (numbered from the face) ─────────────
  //
  // Notes are DERIVED from the statement, not hand-numbered. Each face line that
  // has ledgers behind it gets a note; numbers are assigned in face order. So a
  // reclassification moves the money, the note and the cross-reference together
  // and the numbering can never go stale.

  interface NoteSpec {
    lineId: string;
    title: string;
    backTo: 'bs' | 'pl';
    total: number;
    /** Extra rows appended after the ledger listing (schedules, ageing, notes). */
    enrich?: (s: Sheet, rr: number) => number;
  }

  const faceNotes: NoteSpec[] = [];
  const addNote = (lineId: string, title: string, backTo: 'bs' | 'pl', enrich?: NoteSpec['enrich']) => {
    const ls = ledgersForLine(totalCol, lineId);
    const total = lineSum(totalCol, lineId);
    // A note exists only where the face shows a line. Nil lines are omitted from
    // the face, so emitting their notes would leave unreferenced note numbers.
    if (Math.round(total) === 0 && !ls.some((l) => Math.round(l.closing) !== 0)) return;
    faceNotes.push({ lineId, title, backTo, total, enrich });
  };

  // Declared in the order the lines appear on the face of each statement.
  addNote('share_capital', 'Share Capital', 'bs');
  addNote('reserves_surplus', 'Reserves & Surplus', 'bs', (s, rr) => {
    // The surplus carried from the P&L is not a ledger, so it is stated here.
    rr = noteRow(s, rr, 'Surplus in the Statement of Profit & Loss (net of transfers already booked)',
      Math.round(surplusTransfer(totalCol)));
    return rr;
  });
  addNote('share_application', 'Share Application Money Pending Allotment', 'bs');
  addNote('lt_borrowings', 'Long-Term Borrowings', 'bs');
  addNote('dtl', 'Deferred Tax Liabilities (Net)', 'bs');
  addNote('other_lt_liab', 'Other Long-Term Liabilities', 'bs');
  addNote('lt_provisions', 'Long-Term Provisions', 'bs');
  addNote('st_borrowings', 'Short-Term Borrowings', 'bs');
  addNote('trade_payables_msme', 'Trade Payables — Micro & Small Enterprises', 'bs', (s, rr) => {
    rr = noteRow(s, rr, 'Tally masters carry no MSME flag; ledgers are included here only where '
      + 'tagged by the preparer. Management to confirm MSMED Act status and disclose interest.', null, { bold: false });
    return rr;
  });
  addNote('trade_payables_other', 'Trade Payables — Other than Micro & Small Enterprises', 'bs', (s, rr) =>
    input.payablesAgeing ? renderAgeing(s, rr, input.payablesAgeing, 'Trade Payables') : rr);
  addNote('duties_taxes_payable', 'Statutory Dues Payable', 'bs');
  addNote('employee_dues', 'Employee Benefits Payable', 'bs');
  addNote('advances_from_customers', 'Advances from Customers', 'bs');
  addNote('other_current_liab', 'Other Current Liabilities', 'bs');
  addNote('st_provisions', 'Short-Term Provisions', 'bs');
  addNote('unclassified_cr', 'Unclassified — credit balances (REVIEW)', 'bs');
  addNote('ppe', 'Property, Plant and Equipment', 'bs', (s, rr) => renderFaSchedule(s, rr));
  addNote('intangibles', 'Intangible Assets', 'bs');
  addNote('cwip', 'Capital Work-in-Progress', 'bs');
  addNote('intangibles_dev', 'Intangible Assets under Development', 'bs');
  addNote('nc_investments', 'Non-Current Investments', 'bs');
  addNote('dta', 'Deferred Tax Assets (Net)', 'bs');
  addNote('lt_loans_advances', 'Long-Term Loans & Advances', 'bs');
  addNote('other_nc_assets', 'Other Non-Current Assets', 'bs');
  addNote('c_investments', 'Current Investments', 'bs');
  addNote('inventories', 'Inventories', 'bs');
  addNote('trade_receivables', 'Trade Receivables', 'bs', (s, rr) =>
    input.receivablesAgeing ? renderAgeing(s, rr, input.receivablesAgeing, 'Trade Receivables') : rr);
  addNote('cash_bank', 'Cash & Cash Equivalents', 'bs');
  addNote('st_loans_advances', 'Short-Term Loans & Advances', 'bs');
  addNote('other_current_assets', 'Other Current Assets', 'bs');
  addNote('unclassified_dr', 'Unclassified — debit balances (REVIEW)', 'bs');
  // Statement of Profit & Loss
  addNote('revenue_ops', 'Revenue from Operations', 'pl');
  addNote('other_income', 'Other Income', 'pl');
  addNote('purchases', 'Cost of Materials / Purchases', 'pl');
  addNote('direct_expenses', 'Direct Expenses', 'pl');
  addNote('employee_benefits', 'Employee Benefits Expense', 'pl');
  addNote('finance_costs', 'Finance Costs', 'pl');
  addNote('depreciation', 'Depreciation & Amortisation', 'pl', (s, rr) => {
    const derived = fixedAssetsSchedule(totalCol).reduce((a, r) => a + r.deprCharge, 0);
    const booked = lineSum(totalCol, 'depreciation');
    if (Math.abs(derived - booked) > 1)
      rr = noteRow(s, rr, `Movement in accumulated depreciation ledgers (for comparison): ${Math.round(derived).toLocaleString('en-IN')}`, null);
    return rr;
  });
  addNote('other_expenses', 'Other Expenses', 'pl');

  const noteNoByLineId = new Map<string, number>();
  faceNotes.forEach((n, i) => noteNoByLineId.set(n.lineId, i + 1));

  const shortTitle = (n: number, t: string): string => {
    const base = `N${n} ${t}`.replace(/[\\/?*\[\]:]/g, '-');
    return base.length <= 31 ? base : `${base.slice(0, 30)}…`;
  };
  const sheetNameFor = (n: NoteSpec): string => shortTitle(noteNoByLineId.get(n.lineId)!, n.title);


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

  // Schedule III sub-items are lettered a), b), c)... Nil lines are omitted, so
  // the letters are assigned as rows are actually emitted rather than hardcoded
  // — otherwise a hidden line leaves a gap like "c) d) g)".
  let subItem = 0;
  const subheader = (s: Sheet, text: string) => {
    s.merge(r, 0, lastCol);
    s.set(r, 0, text, { s: sectionHeaderStyle(), num: false });
    r++;
    subItem = 0;
  };
  const letter = (): string => String.fromCharCode(97 + subItem++);

  type Fn = (b: BranchData) => number;
  const line = (
    label: string,
    fn: Fn | null,
    opts: { lineId?: string; bold?: boolean; total?: boolean; grand?: boolean; muted?: boolean; italic?: boolean } = {},
  ) => {
    // Hide nil line items (every column rounds to zero) — keep subtotals/totals.
    if (fn && !opts.total && !opts.grand && columns.every((c) => Math.round(fn(c.data)) === 0)) return;
    const lblStyle = opts.grand
      ? grandTotalLabelStyle()
      : opts.total
      ? subtotalLabelStyle()
      : labelStyle({ bold: opts.bold, italic: opts.italic, muted: opts.muted });
    const text = label.startsWith('@ ') ? `  ${letter()})  ${label.slice(2)}` : label;
    bs.set(r, 0, text, { s: lblStyle, num: false });
    const noteNo = opts.lineId ? noteNoByLineId.get(opts.lineId) : undefined;
    if (noteNo) {
      const spec = faceNotes.find((n) => n.lineId === opts.lineId)!;
      bs.set(r, 1, noteNo, {
        s: linkStyle(ALIGN.center),
        link: internalLink(sheetNameFor(spec), 'A1', `Note ${noteNo}`),
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

  // A Schedule III balance sheet carries no balancing figure. If the statement
  // does not close on its own arithmetic, say so loudly instead of hiding it in
  // a plug line.
  const outOfBalance = columns.filter((c) => Math.abs(bsReconciliation(c.data)) > 0.5);
  if (outOfBalance.length > 0) {
    const detail = outOfBalance
      .map((c) => `${c.name}: ${Math.round(bsReconciliation(c.data)).toLocaleString('en-IN')}`)
      .join('   |   ');
    bs.merge(r, 0, lastCol);
    bs.set(
      r,
      0,
      `⚠  DOES NOT BALANCE — Assets − Equity & Liabilities ≠ 0   (${detail}).  ` +
        `Review ledger classification and excluded groups before issuing this statement.`,
      { s: errorBandStyle(), num: false },
    );
    r += 2;
  }

  subheader(bs, "I.  SHAREHOLDERS' FUNDS");
  line('@ Share Capital', shareCapital, { lineId: 'share_capital' });
  line('@ Reserves & Surplus', reservesSurplus, { lineId: 'reserves_surplus' });
  line('@ Share Application Money Pending Allotment', shareApplicationMoney, { lineId: 'share_application' });
  line('Total Shareholders’ Funds', totalEquity, { total: true });
  spacer();
  subheader(bs, 'II.  NON-CURRENT LIABILITIES');
  line('@ Long-Term Borrowings', longTermBorrowings, { lineId: 'lt_borrowings' });
  line('@ Deferred Tax Liability', deferredTaxLiability, { lineId: 'dtl' });
  line('@ Other Long-Term Liabilities', otherLongTermLiabilities, { lineId: 'other_lt_liab' });
  line('@ Long-Term Provisions', longTermProvisions, { lineId: 'lt_provisions' });
  line('Total Non-Current Liabilities', totalNonCurrentLiab, { total: true });
  spacer();
  subheader(bs, 'III.  CURRENT LIABILITIES');
  line('@ Short-Term Borrowings', shortTermBorrowings, { lineId: 'st_borrowings' });
  line('@ Trade Payables — Micro & Small Enterprises', tradePayablesMsme, { lineId: 'trade_payables_msme' });
  line('@ Trade Payables — Others', tradePayablesOther, { lineId: 'trade_payables_other' });
  line('@ Statutory Dues Payable', dutiesTaxesPayable, { lineId: 'duties_taxes_payable' });
  line('@ Employee Benefits Payable', employeeDues, { lineId: 'employee_dues' });
  line('@ Advances from Customers', advancesFromCustomers, { lineId: 'advances_from_customers' });
  line('@ Other Current Liabilities', otherCurrentLiabilities, { lineId: 'other_current_liab' });
  line('@ Short-Term Provisions', shortTermProvisions, { lineId: 'st_provisions' });
  line('@ Unclassified — credit balances (REVIEW)', unclassifiedCr, { lineId: 'unclassified_cr' });
  line('Total Current Liabilities', totalCurrentLiab, { total: true });
  spacer();
  line('TOTAL EQUITY & LIABILITIES', totalEquityLiabilities, { grand: true });
  spacer();
  spacer();
  subheader(bs, 'I.  NON-CURRENT ASSETS');
  line('@ Property, Plant and Equipment', netFixedAssets, { lineId: 'ppe' });
  line('@ Intangible Assets', intangibleAssets, { lineId: 'intangibles' });
  line('@ Capital Work-in-Progress', cwipTotal, { lineId: 'cwip' });
  line('@ Intangible Assets under Development', intangiblesUnderDevelopment, { lineId: 'intangibles_dev' });
  line('@ Non-Current Investments', nonCurrentInvestments, { lineId: 'nc_investments' });
  line('@ Deferred Tax Asset', deferredTaxAsset, { lineId: 'dta' });
  line('@ Long-Term Loans & Advances', longTermLoansAdvances, { lineId: 'lt_loans_advances' });
  line('@ Other Non-Current Assets', otherNonCurrentAssets, { lineId: 'other_nc_assets' });
  line('Total Non-Current Assets', totalNonCurrentAssets, { total: true });
  spacer();
  subheader(bs, 'II.  CURRENT ASSETS');
  line('@ Current Investments', currentInvestments, { lineId: 'c_investments' });
  line('@ Inventories (Closing Stock)', closingStock, { lineId: 'inventories' });
  line('@ Trade Receivables', tradeReceivables, { lineId: 'trade_receivables' });
  line('@ Cash & Cash Equivalents', cashAndBank, { lineId: 'cash_bank' });
  line('@ Short-Term Loans & Advances', shortTermLoansAdvances, { lineId: 'st_loans_advances' });
  line('@ Other Current Assets', otherCurrentAssets, { lineId: 'other_current_assets' });
  line('@ Unclassified — debit balances (REVIEW)', unclassifiedDr, { lineId: 'unclassified_dr' });
  line('Total Current Assets', totalCurrentAssets, { total: true });
  spacer();
  line('TOTAL ASSETS', totalAssets, { grand: true });

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
  pl.set(r, 1, 'Note', { s: columnHeaderStyle(ALIGN.center), num: false });
  columns.forEach((col, i) => pl.set(r, firstValCol + i, multi ? col.name : 'Current Year', { s: columnHeaderStyle(ALIGN.center), num: false }));
  const plHeaderRow = r;
  r++;

  const plLine = (label: string, fn: Fn | null, opts: { bold?: boolean; total?: boolean; grand?: boolean; italic?: boolean; lineId?: string } = {}) => {
    // Hide nil P&L line items (every column zero) — keep subtotals/totals/headers.
    if (fn && !opts.total && !opts.grand && columns.every((c) => Math.round(fn(c.data)) === 0)) return;
    const lblStyle = opts.grand
      ? grandTotalLabelStyle()
      : opts.total
      ? subtotalLabelStyle()
      : labelStyle({ bold: opts.bold, italic: opts.italic });
    const text = label.startsWith('@ ') ? `     ${letter()})  ${label.slice(2)}` : label;
    pl.set(r, 0, text, { s: lblStyle, num: false });
    const noteNo = opts.lineId ? noteNoByLineId.get(opts.lineId) : undefined;
    if (noteNo) {
      const spec = faceNotes.find((n) => n.lineId === opts.lineId)!;
      pl.set(r, 1, noteNo, {
        s: linkStyle(ALIGN.center),
        link: internalLink(sheetNameFor(spec), 'A1', `Note ${noteNo}`),
        num: true,
      });
    }
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
  plLine('I.   Revenue from Operations', revenueFromOps, { bold: true, lineId: 'revenue_ops' });
  plLine('II.  Other Income', otherIncome, { bold: true, lineId: 'other_income' });
  plLine('III. Total Revenue (I + II)', totalRevenue, { total: true });
  spacer();
  plLine('IV.  Expenses', null, { bold: true });
  subItem = 0;
  plLine('@ Cost of Materials / Purchases', purchases, { lineId: 'purchases' });
  plLine('@ Changes in Inventories', changesInInventories, { italic: true });
  plLine('@ Employee Benefits Expense', employeeCosts, { lineId: 'employee_benefits' });
  plLine('@ Finance Costs', financeCosts, { lineId: 'finance_costs' });
  plLine('@ Depreciation & Amortisation', depreciation, { lineId: 'depreciation' });
  plLine('@ Other Expenses', otherIndirectExpenses, { lineId: 'other_expenses' });
  plLine('@ Direct Expenses', directExpenses, { lineId: 'direct_expenses' });
  plLine('     Total Expenses', totalExpenses, { total: true });
  spacer();
  plLine('V.   Profit Before Tax', profitBeforeTax, { total: true });
  plLine('VI.  Tax Expense (not derivable from a Tally export — see note)', taxExpense);
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
  // Fixed-asset movement schedule (gross block, depreciation, net block).
  function renderFaSchedule(s: Sheet, startRow: number): number {
    const rows = fixedAssetsSchedule(totalCol);
    if (!rows.length) return startRow;
    let rr = startRow + 1;
    s.merge(rr, 0, 9);
    s.set(rr, 0, 'Movement in Gross Block, Depreciation and Net Block', { s: sectionHeaderStyle(), num: false });
    rr++;
    const heads = ['Asset Block', 'Gross — Opening', 'Additions', 'Disposals', 'Gross — Closing',
      'Depr — Opening', 'Charge for the year', 'Depr — Closing', 'Net — Opening', 'Net — Closing'];
    heads.forEach((h, c) => s.set(rr, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.left : ALIGN.center), num: false }));
    rr++;
    const first = rr;
    for (const row of rows) {
      s.set(rr, 0, row.name, { s: labelStyle(), num: false });
      [row.grossOpen, row.additions, row.disposals, row.grossClose, row.deprOpen, row.deprCharge,
        row.deprClose, row.netOpen, row.netClose].forEach((v, i) =>
          s.set(rr, 1 + i, Math.round(v), { s: numberStyle(Z), num: true }));
      rr++;
    }
    s.set(rr, 0, 'Total', { s: subtotalLabelStyle(), num: false });
    for (let c = 1; c <= 9; c++) {
      const col = XLSX.utils.encode_col(c);
      const cached = rows.reduce((a, r) => a + [r.grossOpen, r.additions, r.disposals, r.grossClose,
        r.deprOpen, r.deprCharge, r.deprClose, r.netOpen, r.netClose][c - 1], 0);
      s.setFormula(rr, c, `SUM(${col}${first + 1}:${col}${rr})`, Math.round(cached), subtotalNumberStyle(Z));
    }
    return rr + 1;
  }

  // FIFO ageing sub-schedule. Columns: Party | <buckets> | Outstanding | Advance.
  function renderAgeing(s: Sheet, startRow: number, ageing: AgeingResult, heading: string): number {
    let rr = startRow + 1; // blank spacer
    const lastC = 1 + BUCKET_LABELS.length;
    const advCol = lastC + 1;
    s.merge(rr, 0, advCol);
    s.set(rr, 0, `${heading} — FIFO Ageing (as at ${ageing.asOfIso})  ·  ageing buckets in days`, { s: sectionHeaderStyle(), num: false });
    rr++;
    s.set(rr, 0, 'Party', { s: columnHeaderStyle(ALIGN.left), num: false });
    BUCKET_LABELS.forEach((b, i) => s.set(rr, 1 + i, b, { s: columnHeaderStyle(ALIGN.center), num: false }));
    s.set(rr, lastC, 'Outstanding', { s: columnHeaderStyle(ALIGN.center), num: false });
    s.set(rr, advCol, 'Advance', { s: columnHeaderStyle(ALIGN.center), num: false });
    rr++;
    for (const pty of ageing.parties) {
      s.set(rr, 0, multi && pty.branch ? `[${pty.branch}] ${pty.party}` : pty.party, { s: labelStyle(), num: false });
      BUCKET_LABELS.forEach((b, i) => s.set(rr, 1 + i, Math.round(pty.buckets[b] || 0), { s: numberStyle(Z), num: true }));
      s.set(rr, lastC, Math.round(pty.outstanding), { s: numberStyle(Z), num: true });
      s.set(rr, advCol, Math.round(pty.advance), { s: numberStyle(Z), num: true });
      rr++;
    }
    s.set(rr, 0, 'Total', { s: subtotalLabelStyle(), num: false });
    BUCKET_LABELS.forEach((b, i) => s.set(rr, 1 + i, Math.round(ageing.totals[b] || 0), { s: subtotalNumberStyle(Z), num: true }));
    s.set(rr, lastC, Math.round(ageing.grandOutstanding), { s: subtotalNumberStyle(Z), num: true });
    s.set(rr, advCol, Math.round(ageing.grandAdvance), { s: subtotalNumberStyle(Z), num: true });
    return rr + 1;
  }

  for (const spec of faceNotes) {
    const num = noteNoByLineId.get(spec.lineId)!;
    const sheetName = sheetNameFor(spec);
    const ls = ledgersForLine(totalCol, spec.lineId);
    const sign = LINE_BY_ID[spec.lineId]?.displaySign ?? 1;
    const s = new Sheet();
    const branchCol = multi ? 1 : 0;
    const amtCol = 2 + branchCol;
    s.cols = multi
      ? [{ wch: 44 }, { wch: 28 }, { wch: 16 }, { wch: 20 }]
      : [{ wch: 44 }, { wch: 28 }, { wch: 20 }];

    s.merge(0, 0, amtCol);
    s.set(0, 0, `Note ${num}:  ${spec.title}`, { s: titleBandStyle(12), num: false });
    const backSheet = spec.backTo === 'pl' ? PL_SHEET : BS_SHEET;
    s.set(1, 0, spec.backTo === 'pl' ? '← Back to Statement of P&L' : '← Back to Balance Sheet',
      { s: linkStyle(ALIGN.left), link: internalLink(backSheet, 'A1', backSheet), num: false });
    s.set(1, 1, 'Notes Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Notes Index'), num: false });

    // Column headers make the ledger→line linkage explicit.
    let rr = 3;
    s.set(rr, 0, 'Ledger', { s: columnHeaderStyle(ALIGN.left), num: false });
    s.set(rr, 1, 'Tally Group', { s: columnHeaderStyle(ALIGN.left), num: false });
    if (multi) s.set(rr, 2, 'Branch', { s: columnHeaderStyle(ALIGN.left), num: false });
    s.set(rr, amtCol, `Amount ${unit}`, { s: columnHeaderStyle(ALIGN.right), num: false });
    rr++;
    const first = rr;

    const shown = ls.filter((l) => Math.round(l.closing) !== 0);
    const listed = shown.length ? shown : ls;
    for (const l of listed) {
      s.set(rr, 0, l.name, { s: labelStyle(), num: false });
      s.set(rr, 1, l.parent, { s: labelStyle({ muted: true }), num: false });
      if (multi) s.set(rr, 2, l.branch, { s: labelStyle({ muted: true }), num: false });
      s.set(rr, amtCol, Math.round(sign * l.closing), { s: numberStyle(Z), num: true });
      rr++;
    }
    const last = rr - 1;
    if (last >= first) s.applyZebra(first, last, 0, amtCol);

    // The note casts itself: a real SUM over its own detail rows.
    s.set(rr, 0, `Total — ${spec.title}`, { s: subtotalLabelStyle(), num: false });
    const ac = XLSX.utils.encode_col(amtCol);
    const listedTotal = listed.reduce((a, l) => a + Math.round(sign * l.closing), 0);
    if (last >= first) s.setFormula(rr, amtCol, `SUM(${ac}${first + 1}:${ac}${last + 1})`, listedTotal, subtotalNumberStyle(Z));
    else s.set(rr, amtCol, Math.round(spec.total), { s: subtotalNumberStyle(Z), num: true });
    rr++;

    if (spec.enrich) rr = spec.enrich(s, rr);

    s.freeze = { r: first, c: 1 };
    XLSX.utils.book_append_sheet(wb, s.toWS(), sheetName);
  }

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
  const idxSection = (text: string) => {
    idx.merge(ir, 0, 2);
    idx.set(ir, 0, text, { s: sectionHeaderStyle(), num: false });
    ir++;
  };
  let section: string | null = null;
  for (const spec of faceNotes) {
    const num = noteNoByLineId.get(spec.lineId)!;
    const want = spec.backTo === 'pl' ? 'Profit & Loss Notes' : 'Balance Sheet Notes';
    if (section !== want) { idxSection(want); section = want; }
    idx.set(ir, 0, num, {
      s: linkStyle(ALIGN.center),
      link: internalLink(sheetNameFor(spec), 'A1', `Note ${num}`),
      num: true,
    });
    idx.set(ir, 1, spec.title, { s: labelStyle(), num: false });
    idx.set(ir, 2, Math.round(spec.total), { s: numberStyle(Z), num: true });
    ir++;
  }
  idx.set(ir + 1, 1, 'Ledger Index (every ledger → its statement line)', {
    s: linkStyle(ALIGN.left), link: internalLink(LEDGER_INDEX_SHEET, 'A1'), num: false,
  });
  idx.set(ir + 2, 1,
    'Statutory narrative disclosures (promoter shareholding, title deeds, struck-off companies, '
    + 'CSR, ratios with variance explanations) require management input and are not generated.',
    { s: labelStyle({ italic: true, muted: true }), num: false });
  // Group Mapping link footer.
  idx.set(ir + 3, 1, 'Group Mapping (working schedule)', { s: linkStyle(ALIGN.left), link: internalLink(MAP_SHEET, 'A1'), num: false });
  XLSX.utils.book_append_sheet(wb, idx.toWS(), INDEX_SHEET);

  // ───────────────────── Ledger Index ─────────────────────
  // Every ledger in the books, and exactly where it landed. This is the audit
  // trail for the classification: any figure on the face can be traced down to
  // the ledgers behind it, and any ledger can be traced up to its line.
  {
    const li = new Sheet();
    const heads = ['Ledger', 'Tally Group', 'Tally Primary Group', ...(multi ? ['Branch'] : []),
      'Statement', 'Schedule III Line', 'Note', `Amount ${unit}`, 'Classified By'];
    li.cols = [{ wch: 42 }, { wch: 26 }, { wch: 24 }, ...(multi ? [{ wch: 14 }] : []),
      { wch: 15 }, { wch: 40 }, { wch: 7 }, { wch: 18 }, { wch: 24 }];
    li.merge(0, 0, heads.length - 1);
    li.set(0, 0, `${input.companyTitle} — Ledger Index (classification audit trail)`, { s: titleBandStyle(12), num: false });
    li.set(1, 0, '← Back to Notes Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1'), num: false });
    heads.forEach((h, c) => li.set(2, c, h, { s: columnHeaderStyle(c >= heads.length - 2 ? ALIGN.right : ALIGN.left), num: false }));

    const provenance = (l: BsLedger): string =>
      l.how === 'rule' || l.how === 'sign-rule' ? `${l.how} · ${l.ruleId ?? ''}` : l.how;

    let lr = 3;
    const sorted = [...totalCol.ledgers].sort((a, b2) =>
      (a.lineId || '').localeCompare(b2.lineId || '') || a.name.localeCompare(b2.name));
    for (const l of sorted) {
      const spec = faceNotes.find((n) => n.lineId === l.lineId);
      const num = noteNoByLineId.get(l.lineId);
      const sign = LINE_BY_ID[l.lineId]?.displaySign ?? 1;
      let c = 0;
      li.set(lr, c++, l.name, { s: labelStyle(), num: false });
      li.set(lr, c++, l.parent, { s: labelStyle({ muted: true }), num: false });
      li.set(lr, c++, l.rawPrimary, { s: labelStyle({ muted: true }), num: false });
      if (multi) li.set(lr, c++, l.branch, { s: labelStyle({ muted: true }), num: false });
      li.set(lr, c++, isPnlLine(l.lineId) ? 'P&L' : 'Balance Sheet', { s: labelStyle(), num: false });
      li.set(lr, c++, LINE_BY_ID[l.lineId]?.label ?? l.lineId, { s: labelStyle(), num: false });
      if (num && spec) {
        li.set(lr, c++, num, { s: linkStyle(ALIGN.center), link: internalLink(sheetNameFor(spec), 'A1', `Note ${num}`), num: true });
      } else {
        li.set(lr, c++, '', { s: labelStyle(), num: false });
      }
      li.set(lr, c++, Math.round(sign * l.closing), { s: numberStyle(Z), num: true });
      li.set(lr, c++, provenance(l), { s: labelStyle({ muted: true }), num: false });
      lr++;
    }
    if (lr > 3) li.applyZebra(3, lr - 1, 0, heads.length - 1);
    li.autofilter = `A3:${XLSX.utils.encode_col(heads.length - 1)}${lr}`;
    li.freeze = { r: 3, c: 1 };
    XLSX.utils.book_append_sheet(wb, li.toWS(), LEDGER_INDEX_SHEET);
  }

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
  // Hide nil ledger lines (keep bold group headers and total rows).
  if (amount !== null && Math.round(amount) === 0 && !opts.total && !opts.bold) return r;
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
