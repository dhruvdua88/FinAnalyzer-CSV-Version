// Cash Flow Analysis workbook builder.
//
// Same styling layer as the Schedule III statements and the Trial Balance
// (services/excelStyles.ts), so every FinAnalyzer export reads as one
// document. The face — "Cash Flow Statement" — is laid out the way a cash
// flow statement is presented to management: activity sections, indented
// bucket lines, a bold subtotal per activity that CASTS through real Excel
// SUM formulas, and a closing reconciliation that must prove to Nil.
//
// Freeze panes / gridlines / page setup are NOT written by xlsx-js-style;
// cashFlowSheetPolish() feeds polishXlsx() which splices them in afterwards.

import XLSX from 'xlsx-js-style';
import {
  ALIGN,
  NUMFMT,
  PALETTE,
  Sheet,
  columnHeaderStyle,
  errorBandStyle,
  font,
  grandTotalLabelStyle,
  grandTotalNumberStyle,
  internalLink,
  labelStyle,
  linkStyle,
  numberStyle,
  sectionHeaderStyle,
  subBandStyle,
  subtotalLabelStyle,
  subtotalNumberStyle,
  titleBandStyle,
  type Style,
} from './excelStyles';

// ── Sheet names (single source of truth: builder + polish map + links) ──
export const SHEETS = {
  cover: 'Cover',
  statement: 'Cash Flow Statement',
  cashLedgers: 'Cash Ledger Movement',
  ledgerSummary: 'Ledger Flow Summary',
  activity: 'Activity Summary',
  monthly: 'Monthly Trend',
  basis: 'Basis & Assumptions',
} as const;

const Z = NUMFMT.accounting;
/** Share / percentage columns — one decimal is enough on a management pack. */
const ZPCT = '0.0"%";[Red](0.0"%");"-"';
const ZINT = '##,##0;[Red](##,##0);"-"';

type Activity = 'Operating' | 'Investing' | 'Financing';
const ACTIVITIES: Activity[] = ['Operating', 'Investing', 'Financing'];

export interface CashFlowExcelInput {
  companyTitle: string;
  fromDate: string; // dd-mm-yyyy, already formatted by the caller
  toDate: string;
  cashLedgers: string[];
  filters: { search: string; direction: string; minAmount: string };
  statement: {
    buckets: Array<{ activity: Activity; bucket: string; inflow: number; outflow: number; net: number }>;
    byActivity: Record<Activity, { inflow: number; outflow: number; net: number }>;
    adjustmentNet: number;
    opening: number;
    movement: number;
    closing: number;
  };
  cashPosition: {
    opening: number;
    periodMovement: number;
    closing: number;
    referenceClosing: number | null;
    reconciliationDiff: number | null;
  };
  cashLedgerDetail: Array<{
    ledger: string; opening: number; inflow: number; outflow: number;
    netMovement: number; closing: number; referenceClosing: number | null; diff: number | null;
  }>;
  ledgerDetailRows: Array<{
    label: string; activity: string; classificationRule: string; primary: string; parent: string;
    inflow: number; outflow: number; net: number; inflowShare: number; outflowShare: number; vouchers: number;
  }>;
  primaryRows: Array<{ label: string; inflow: number; outflow: number; net: number; vouchers: number }>;
  monthlySeries: Array<{ monthLabel: string; inflow: number; outflow: number }>;
  totals: { inflow: number; outflow: number; net: number; voucherCount: number; visibleRows: number; blockedCapitalOutflow: number };
}

/** Freeze rows/cols per sheet, applied by polishXlsx() after the file is written. */
export const cashFlowSheetPolish = (): Record<string, { freeze: { rows: number; cols: number } }> => ({
  [SHEETS.statement]: { freeze: { rows: 6, cols: 1 } },
  [SHEETS.cashLedgers]: { freeze: { rows: 6, cols: 1 } },
  [SHEETS.ledgerSummary]: { freeze: { rows: 6, cols: 1 } },
  [SHEETS.activity]: { freeze: { rows: 6, cols: 1 } },
  [SHEETS.monthly]: { freeze: { rows: 6, cols: 1 } },
});

const today = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
};

const periodLabel = (i: CashFlowExcelInput): string =>
  i.fromDate && i.toDate && i.fromDate !== '-' && i.toDate !== '-'
    ? `For the period ${i.fromDate} to ${i.toDate}`
    : 'All periods in the dataset';

/** Indented bucket label — Excel has no per-cell indent in this style layer, so pad. */
const indent = (text: string, level = 1) => `${'    '.repeat(level)}${text}`;

/** A cell style that turns red when the figure is a live reconciliation break. */
const breakStyle = (bad: boolean, z: string = Z): Style =>
  bad
    ? { font: font({ bold: true, color: PALETTE.error }), alignment: ALIGN.right, numFmt: z }
    : numberStyle(z, { muted: true });

// ── Shared page furniture ─────────────────────────────────────────────────
/**
 * Title band + statement title + period + unit, then a back-link to the cover.
 * Returns the next free row. Every data sheet opens the same way so the pack
 * reads as one document.
 */
const header = (s: Sheet, i: CashFlowExcelInput, title: string, lastCol: number): number => {
  let r = 0;
  const band = (text: string, style: Style) => {
    s.merge(r, 0, lastCol);
    s.set(r, 0, text, { s: style, num: false });
    r++;
  };
  band(i.companyTitle, titleBandStyle(14));
  band(title, subBandStyle());
  band(periodLabel(i), subBandStyle(undefined, true));
  band('Amounts in Rupees (Rs.)', subBandStyle(undefined, true));
  s.set(r, 0, '‹ Back to Cover', { s: linkStyle(ALIGN.left), link: internalLink(SHEETS.cover), num: false });
  r++;
  return r;
};

const columnHeaders = (s: Sheet, r: number, heads: string[]): number => {
  heads.forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.left : ALIGN.center), num: false }));
  return r + 1;
};

// Notes are written unmerged so long text spills across the empty cells to its
// right; a merged cell would clip it at the merge boundary.
const noteRow = (s: Sheet, r: number, _lastCol: number, text: string): number => {
  s.set(r, 0, text, { s: labelStyle({ italic: true, muted: true }), num: false });
  return r + 1;
};

/** Fill the trailing columns of a banded row so the band runs the full width. */
const padRow = (s: Sheet, r: number, cols: number[], style: Style): void => {
  cols.forEach((c) => s.set(r, c, '', { s: style, num: false }));
};

// ── 1. Cover & index ──────────────────────────────────────────────────────
const buildCover = (wb: XLSX.WorkBook, i: CashFlowExcelInput): void => {
  const s = new Sheet();
  const LAST = 3;
  s.cols = [{ wch: 38 }, { wch: 26 }, { wch: 26 }, { wch: 26 }];

  let r = 0;
  const band = (text: string, style: Style) => {
    s.merge(r, 0, LAST);
    s.set(r, 0, text, { s: style, num: false });
    r++;
  };
  band(i.companyTitle, titleBandStyle(14));
  band('CASH FLOW ANALYSIS', subBandStyle());
  band(periodLabel(i), subBandStyle(undefined, true));
  band(`Prepared on ${today()}  •  Amounts in Rupees (Rs.)`, subBandStyle(undefined, true));
  r++;

  // Headline figures — the three numbers management looks for first.
  s.merge(r, 0, LAST);
  s.set(r, 0, 'CASH POSITION', { s: sectionHeaderStyle(), num: false });
  r++;
  const kpi: Array<[string, number, boolean]> = [
    ['Opening cash & cash equivalents', i.cashPosition.opening, false],
    ['Total inflow during the period', i.totals.inflow, false],
    ['Total outflow during the period', i.totals.outflow, false],
    ['Net increase / (decrease) in cash', i.cashPosition.periodMovement, true],
    ['Closing cash & cash equivalents', i.cashPosition.closing, true],
  ];
  kpi.forEach(([label, value, strong]) => {
    s.set(r, 0, label, { s: strong ? subtotalLabelStyle() : labelStyle(), num: false });
    s.merge(r, 1, LAST);
    s.set(r, 1, value, { s: strong ? subtotalNumberStyle(Z) : numberStyle(Z), num: true });
    r++;
  });

  // Reconciliation against the closing balances Tally itself reports.
  if (i.cashPosition.referenceClosing !== null) {
    const diff = i.cashPosition.reconciliationDiff ?? 0;
    const bad = Math.abs(diff) >= 0.005;
    s.set(r, 0, 'Closing per Tally ledger balances', { s: labelStyle(), num: false });
    s.merge(r, 1, LAST);
    s.set(r, 1, i.cashPosition.referenceClosing, { s: numberStyle(Z, { muted: true }), num: true });
    r++;
    s.set(r, 0, 'Difference — must be Nil', { s: subtotalLabelStyle(), num: false });
    s.merge(r, 1, LAST);
    s.set(r, 1, diff, { s: bad ? breakStyle(true) : subtotalNumberStyle(Z), num: true });
    r++;
    if (bad) {
      s.merge(r, 0, LAST);
      s.set(r, 0,
        `⚠  The computed closing cash does not agree with the ledger closing balances by ${diff.toFixed(2)}. `
        + 'Investigate before circulating this pack.',
        { s: errorBandStyle(), num: false });
      r++;
    }
  }
  r++;

  // Index — one clickable row per sheet.
  s.merge(r, 0, LAST);
  s.set(r, 0, 'CONTENTS', { s: sectionHeaderStyle(), num: false });
  r++;
  const contents: Array<[string, string]> = [
    [SHEETS.statement, 'Cash flow statement by Operating / Investing / Financing activity'],
    [SHEETS.cashLedgers, 'Movement in each cash & bank ledger, reconciled to its closing balance'],
    [SHEETS.ledgerSummary, 'Every counter-party ledger the cash moved against, with share of flow'],
    [SHEETS.activity, 'Roll-up by Tally primary group and by activity'],
    [SHEETS.monthly, 'Month-by-month inflow, outflow and running cash balance'],
    [SHEETS.basis, 'Cash ledgers selected, filters applied and the classification rules used'],
  ];
  contents.forEach(([name, desc]) => {
    s.set(r, 0, name, { s: linkStyle(ALIGN.left), link: internalLink(name), num: false });
    s.merge(r, 1, LAST);
    s.set(r, 1, desc, { s: labelStyle({ muted: true }), num: false });
    r++;
  });
  r++;

  s.merge(r, 0, LAST);
  s.set(r, 0, 'SCOPE OF THIS PACK', { s: sectionHeaderStyle(), num: false });
  r++;
  const scope: Array<[string, string | number]> = [
    ['Cash & bank ledgers included', i.cashLedgers.length ? i.cashLedgers.join(', ') : 'None selected'],
    ['Vouchers analysed', i.totals.voucherCount],
    ['Counter-party ledger lines', i.totals.visibleRows],
  ];
  scope.forEach(([label, value]) => {
    s.set(r, 0, label, { s: labelStyle(), num: false });
    s.merge(r, 1, LAST);
    s.set(r, 1, value, {
      s: typeof value === 'number' ? numberStyle(ZINT) : labelStyle(),
      num: typeof value === 'number',
    });
    r++;
  });
  r++;
  noteRow(s, r, LAST,
    'Prepared from the imported Tally data by FinAnalyzer. Figures are as extracted; '
    + 'classification of each flow is rule-based and should be reviewed before publication.');

  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEETS.cover);
};

// ── 2. Cash flow statement (the face) ─────────────────────────────────────
const buildStatement = (wb: XLSX.WorkBook, i: CashFlowExcelInput): void => {
  const s = new Sheet();
  const LAST = 3; // Particulars | Inflow | Outflow | Net
  s.cols = [{ wch: 56 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];

  let r = header(s, i, 'CASH FLOW STATEMENT', LAST);
  r = columnHeaders(s, r, ['Particulars', 'Inflow', 'Outflow', 'Net']);

  const activityTotalRows: number[] = [];

  ACTIVITIES.forEach((activity) => {
    const buckets = i.statement.buckets.filter((b) => b.activity === activity);

    s.merge(r, 0, LAST);
    s.set(r, 0, `CASH FLOW FROM ${activity.toUpperCase()} ACTIVITIES`, { s: sectionHeaderStyle(), num: false });
    r++;

    const firstBucketRow = r;
    if (buckets.length === 0) {
      s.set(r, 0, indent('No flows classified to this activity'), { s: labelStyle({ italic: true, muted: true }), num: false });
      [1, 2, 3].forEach((c) => s.set(r, c, '', { s: numberStyle(Z), num: false }));
      r++;
    } else {
      buckets.forEach((b) => {
        s.set(r, 0, indent(b.bucket), { s: labelStyle(), num: false });
        s.set(r, 1, b.inflow, { s: numberStyle(Z), num: true });
        s.set(r, 2, b.outflow, { s: numberStyle(Z), num: true });
        s.set(r, 3, b.net, { s: numberStyle(Z), num: true });
        r++;
      });
    }
    const lastBucketRow = r - 1;

    // Subtotal as a live SUM so the statement casts inside Excel, not just here.
    s.set(r, 0, `Net cash from / (used in) ${activity.toLowerCase()} activities`,
      { s: subtotalLabelStyle(), num: false });
    const t = i.statement.byActivity[activity];
    ([[1, t.inflow], [2, t.outflow], [3, t.net]] as Array<[number, number]>).forEach(([c, cached]) => {
      const col = XLSX.utils.encode_col(c);
      s.setFormula(r, c, `SUM(${col}${firstBucketRow + 1}:${col}${lastBucketRow + 1})`,
        Math.round(cached * 100) / 100, subtotalNumberStyle(Z), Z);
    });
    activityTotalRows.push(r);
    r += 2;
  });

  // Unclassified / contra plug: the gap between the classified net and the
  // actual movement in the cash ledgers. A large plug is a review point.
  s.set(r, 0, 'Unclassified / contra adjustment', { s: labelStyle({ italic: true }), num: false });
  padRow(s, r, [1, 2], numberStyle(Z, { italic: true }));
  s.set(r, 3, i.statement.adjustmentNet, { s: numberStyle(Z, { italic: true }), num: true });
  const adjustmentRow = r;
  r++;

  s.set(r, 0, 'NET INCREASE / (DECREASE) IN CASH & CASH EQUIVALENTS', { s: grandTotalLabelStyle(), num: false });
  padRow(s, r, [1, 2], grandTotalNumberStyle(Z));
  s.setFormula(r, 3,
    `${activityTotalRows.map((x) => `D${x + 1}`).join('+')}+D${adjustmentRow + 1}`,
    Math.round(i.statement.movement * 100) / 100, grandTotalNumberStyle(Z), Z);
  const movementRow = r;
  r++;

  s.set(r, 0, 'Opening cash & cash equivalents', { s: labelStyle(), num: false });
  padRow(s, r, [1, 2], numberStyle(Z));
  s.set(r, 3, i.statement.opening, { s: numberStyle(Z), num: true });
  const openingRow = r;
  r++;

  s.set(r, 0, 'CLOSING CASH & CASH EQUIVALENTS', { s: grandTotalLabelStyle(), num: false });
  padRow(s, r, [1, 2], grandTotalNumberStyle(Z));
  s.setFormula(r, 3, `D${movementRow + 1}+D${openingRow + 1}`,
    Math.round(i.statement.closing * 100) / 100, grandTotalNumberStyle(Z), Z);
  const closingRow = r;
  r += 2;

  // The proof. Without this a cash flow statement is just a pretty table.
  if (i.cashPosition.referenceClosing !== null) {
    const diff = i.cashPosition.reconciliationDiff ?? 0;
    const bad = Math.abs(diff) >= 0.005;
    s.set(r, 0, 'Closing cash per Tally ledger balances', { s: labelStyle(), num: false });
    padRow(s, r, [1, 2], numberStyle(Z, { muted: true }));
    s.set(r, 3, i.cashPosition.referenceClosing, { s: numberStyle(Z, { muted: true }), num: true });
    const refRow = r;
    r++;
    s.set(r, 0, 'Difference — must be Nil', { s: subtotalLabelStyle(), num: false });
    padRow(s, r, [1, 2], subtotalNumberStyle(Z));
    s.setFormula(r, 3, `D${closingRow + 1}-D${refRow + 1}`, Math.round(diff * 100) / 100,
      bad ? breakStyle(true) : subtotalNumberStyle(Z), Z);
    r += 2;
  }

  r = noteRow(s, r, LAST,
    'Prepared on the direct method from the movement in the selected cash & bank ledgers. '
    + 'Each flow is classified from the counter-party ledger\'s Tally primary group; see Basis & Assumptions.');
  noteRow(s, r, LAST,
    'Inflow and outflow are shown gross. The unclassified / contra adjustment reconciles the classified '
    + 'flows to the actual movement in the cash ledgers (cash-to-bank transfers and unmapped groups sit here).');

  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEETS.statement);
};

// ── 3. Cash ledger movement ───────────────────────────────────────────────
const buildCashLedgers = (wb: XLSX.WorkBook, i: CashFlowExcelInput): void => {
  const s = new Sheet();
  const LAST = 7;
  s.cols = [{ wch: 40 }, ...Array.from({ length: 7 }, () => ({ wch: 18 }))];

  let r = header(s, i, 'MOVEMENT IN CASH & BANK LEDGERS', LAST);
  const headRow = r;
  r = columnHeaders(s, r, ['Cash / Bank Ledger', 'Opening', 'Inflow', 'Outflow', 'Net Movement', 'Closing', 'Closing per Tally', 'Difference']);

  const firstRow = r;
  i.cashLedgerDetail.forEach((row) => {
    const bad = row.diff !== null && Math.abs(row.diff) >= 0.005;
    s.set(r, 0, row.ledger, { s: labelStyle(), num: false });
    s.set(r, 1, row.opening, { s: numberStyle(Z), num: true });
    s.set(r, 2, row.inflow, { s: numberStyle(Z), num: true });
    s.set(r, 3, row.outflow, { s: numberStyle(Z), num: true });
    s.set(r, 4, row.netMovement, { s: numberStyle(Z), num: true });
    s.set(r, 5, row.closing, { s: numberStyle(Z), num: true });
    if (row.referenceClosing === null) s.set(r, 6, '', { s: numberStyle(Z, { muted: true }), num: false });
    else s.set(r, 6, row.referenceClosing, { s: numberStyle(Z, { muted: true }), num: true });
    if (row.diff === null) s.set(r, 7, '', { s: numberStyle(Z, { muted: true }), num: false });
    else s.set(r, 7, row.diff, { s: breakStyle(bad), num: true });
    r++;
  });
  const lastRow = r - 1;
  if (i.cashLedgerDetail.length) s.applyZebra(firstRow, lastRow, 0, LAST);

  s.set(r, 0, 'TOTAL', { s: grandTotalLabelStyle(), num: false });
  for (let c = 1; c <= LAST; c++) {
    const col = XLSX.utils.encode_col(c);
    const cached = i.cashLedgerDetail.reduce((sum, row) => {
      const v = [row.opening, row.inflow, row.outflow, row.netMovement, row.closing, row.referenceClosing ?? 0, row.diff ?? 0][c - 1];
      return sum + v;
    }, 0);
    if (i.cashLedgerDetail.length) {
      s.setFormula(r, c, `SUM(${col}${firstRow + 1}:${col}${lastRow + 1})`,
        Math.round(cached * 100) / 100, grandTotalNumberStyle(Z), Z);
    } else {
      s.set(r, c, 0, { s: grandTotalNumberStyle(Z), num: true });
    }
  }
  r += 2;

  noteRow(s, r, LAST,
    'Closing = Opening + Net Movement, computed from the vouchers in the period. "Closing per Tally" is the '
    + 'balance the ledger itself reports; any difference is a data or cut-off issue and is shown in red.');

  if (i.cashLedgerDetail.length) s.autofilter = `A${headRow + 1}:${XLSX.utils.encode_col(LAST)}${lastRow + 1}`;
  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEETS.cashLedgers);
};

// ── 4. Ledger flow summary ────────────────────────────────────────────────
const buildLedgerSummary = (wb: XLSX.WorkBook, i: CashFlowExcelInput): void => {
  const s = new Sheet();
  const LAST = 9;
  s.cols = [{ wch: 42 }, { wch: 13 }, { wch: 24 }, { wch: 24 }, { wch: 24 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }];

  let r = header(s, i, 'FLOW BY COUNTER-PARTY LEDGER', LAST);
  const headRow = r;
  r = columnHeaders(s, r, ['Counter-party Ledger', 'Activity', 'Classification Rule', 'Primary Group',
    'Parent Group', 'Inflow', 'Outflow', 'Net', 'Inflow %', 'Outflow %']);

  const firstRow = r;
  i.ledgerDetailRows.forEach((row) => {
    s.set(r, 0, row.label, { s: labelStyle(), num: false });
    s.set(r, 1, row.activity, { s: labelStyle(), num: false });
    s.set(r, 2, row.classificationRule, { s: labelStyle({ muted: true }), num: false });
    s.set(r, 3, row.primary, { s: labelStyle({ muted: true }), num: false });
    s.set(r, 4, row.parent, { s: labelStyle({ muted: true }), num: false });
    s.set(r, 5, row.inflow, { s: numberStyle(Z), num: true });
    s.set(r, 6, row.outflow, { s: numberStyle(Z), num: true });
    s.set(r, 7, row.net, { s: numberStyle(Z), num: true });
    s.set(r, 8, row.inflowShare, { s: numberStyle(ZPCT, { muted: true }), num: true });
    s.set(r, 9, row.outflowShare, { s: numberStyle(ZPCT, { muted: true }), num: true });
    r++;
  });
  const lastRow = r - 1;
  if (i.ledgerDetailRows.length) s.applyZebra(firstRow, lastRow, 0, LAST);

  s.set(r, 0, 'TOTAL', { s: grandTotalLabelStyle(), num: false });
  [1, 2, 3, 4].forEach((c) => s.set(r, c, '', { s: grandTotalLabelStyle(), num: false }));
  ([[5, i.totals.inflow], [6, i.totals.outflow], [7, i.totals.net]] as Array<[number, number]>).forEach(([c, cached]) => {
    const col = XLSX.utils.encode_col(c);
    if (i.ledgerDetailRows.length) {
      s.setFormula(r, c, `SUM(${col}${firstRow + 1}:${col}${lastRow + 1})`,
        Math.round(cached * 100) / 100, grandTotalNumberStyle(Z), Z);
    } else {
      s.set(r, c, 0, { s: grandTotalNumberStyle(Z), num: true });
    }
  });
  [8, 9].forEach((c) => s.set(r, c, 100, { s: grandTotalNumberStyle(ZPCT), num: true }));
  r += 2;

  noteRow(s, r, LAST,
    'Sorted by absolute net flow — the ledgers that moved the most cash sit at the top. '
    + '"Mixed" activity means the same ledger carried flows classified to more than one activity.');

  if (i.ledgerDetailRows.length) s.autofilter = `A${headRow + 1}:${XLSX.utils.encode_col(LAST)}${lastRow + 1}`;
  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEETS.ledgerSummary);
};

// ── 5. Activity summary ───────────────────────────────────────────────────
const buildActivity = (wb: XLSX.WorkBook, i: CashFlowExcelInput): void => {
  const s = new Sheet();
  const LAST = 4;
  s.cols = [{ wch: 46 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 14 }];

  let r = header(s, i, 'SUMMARY BY ACTIVITY AND PRIMARY GROUP', LAST);

  // Activity roll-up first — the three numbers that drive the statement.
  s.merge(r, 0, LAST);
  s.set(r, 0, 'BY ACTIVITY', { s: sectionHeaderStyle(), num: false });
  r++;
  r = columnHeaders(s, r, ['Activity', 'Inflow', 'Outflow', 'Net', 'Vouchers']);
  const actFirst = r;
  ACTIVITIES.forEach((a) => {
    const t = i.statement.byActivity[a];
    s.set(r, 0, a, { s: labelStyle(), num: false });
    s.set(r, 1, t.inflow, { s: numberStyle(Z), num: true });
    s.set(r, 2, t.outflow, { s: numberStyle(Z), num: true });
    s.set(r, 3, t.net, { s: numberStyle(Z), num: true });
    s.set(r, 4, '', { s: numberStyle(ZINT), num: false });
    r++;
  });
  s.set(r, 0, 'Total classified', { s: subtotalLabelStyle(), num: false });
  [1, 2, 3].forEach((c) => {
    const col = XLSX.utils.encode_col(c);
    const cached = ACTIVITIES.reduce((sum, a) =>
      sum + [i.statement.byActivity[a].inflow, i.statement.byActivity[a].outflow, i.statement.byActivity[a].net][c - 1], 0);
    s.setFormula(r, c, `SUM(${col}${actFirst + 1}:${col}${r})`, Math.round(cached * 100) / 100,
      subtotalNumberStyle(Z), Z);
  });
  s.set(r, 4, '', { s: subtotalNumberStyle(ZINT), num: false });
  r += 2;

  s.merge(r, 0, LAST);
  s.set(r, 0, 'BY TALLY PRIMARY GROUP', { s: sectionHeaderStyle(), num: false });
  r++;
  const headRow = r;
  r = columnHeaders(s, r, ['Primary Group', 'Inflow', 'Outflow', 'Net', 'Vouchers']);
  const firstRow = r;
  i.primaryRows.forEach((row) => {
    s.set(r, 0, row.label, { s: labelStyle(), num: false });
    s.set(r, 1, row.inflow, { s: numberStyle(Z), num: true });
    s.set(r, 2, row.outflow, { s: numberStyle(Z), num: true });
    s.set(r, 3, row.net, { s: numberStyle(Z), num: true });
    s.set(r, 4, row.vouchers, { s: numberStyle(ZINT, { muted: true }), num: true });
    r++;
  });
  const lastRow = r - 1;
  if (i.primaryRows.length) s.applyZebra(firstRow, lastRow, 0, LAST);

  s.set(r, 0, 'TOTAL', { s: grandTotalLabelStyle(), num: false });
  for (let c = 1; c <= LAST; c++) {
    const col = XLSX.utils.encode_col(c);
    const cached = i.primaryRows.reduce((sum, row) =>
      sum + [row.inflow, row.outflow, row.net, row.vouchers][c - 1], 0);
    if (i.primaryRows.length) {
      s.setFormula(r, c, `SUM(${col}${firstRow + 1}:${col}${lastRow + 1})`, Math.round(cached * 100) / 100,
        grandTotalNumberStyle(c === LAST ? ZINT : Z), c === LAST ? ZINT : Z);
    } else {
      s.set(r, c, 0, { s: grandTotalNumberStyle(c === LAST ? ZINT : Z), num: true });
    }
  }
  r += 2;
  noteRow(s, r, LAST,
    'Voucher counts are distinct vouchers touching the group; a voucher hitting two groups is counted in each, '
    + 'so the total can exceed the voucher count on the Cover.');

  if (i.primaryRows.length) s.autofilter = `A${headRow + 1}:${XLSX.utils.encode_col(LAST)}${lastRow + 1}`;
  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEETS.activity);
};

// ── 6. Monthly trend ──────────────────────────────────────────────────────
const buildMonthly = (wb: XLSX.WorkBook, i: CashFlowExcelInput): void => {
  const s = new Sheet();
  const LAST = 4;
  s.cols = [{ wch: 22 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 22 }];

  let r = header(s, i, 'MONTHLY CASH FLOW TREND', LAST);
  const headRow = r;
  r = columnHeaders(s, r, ['Month', 'Inflow', 'Outflow', 'Net Movement', 'Running Cash Balance']);

  const firstRow = r;
  let running = i.statement.opening;
  i.monthlySeries.forEach((row) => {
    const net = row.inflow - row.outflow;
    running += net;
    s.set(r, 0, row.monthLabel, { s: labelStyle(), num: false });
    s.set(r, 1, row.inflow, { s: numberStyle(Z), num: true });
    s.set(r, 2, row.outflow, { s: numberStyle(Z), num: true });
    s.set(r, 3, net, { s: numberStyle(Z), num: true });
    s.set(r, 4, running, { s: numberStyle(Z, { bold: true }), num: true });
    r++;
  });
  const lastRow = r - 1;
  if (i.monthlySeries.length) s.applyZebra(firstRow, lastRow, 0, LAST);

  s.set(r, 0, 'TOTAL', { s: grandTotalLabelStyle(), num: false });
  [1, 2, 3].forEach((c) => {
    const col = XLSX.utils.encode_col(c);
    const cached = i.monthlySeries.reduce((sum, row) =>
      sum + [row.inflow, row.outflow, row.inflow - row.outflow][c - 1], 0);
    if (i.monthlySeries.length) {
      s.setFormula(r, c, `SUM(${col}${firstRow + 1}:${col}${lastRow + 1})`, Math.round(cached * 100) / 100,
        grandTotalNumberStyle(Z), Z);
    } else {
      s.set(r, c, 0, { s: grandTotalNumberStyle(Z), num: true });
    }
  });
  s.set(r, 4, i.monthlySeries.length ? running : i.statement.opening, { s: grandTotalNumberStyle(Z), num: true });
  r += 2;

  noteRow(s, r, LAST,
    'The running balance starts at the opening cash position and rolls each month\'s net movement forward; '
    + 'the final figure agrees with closing cash on the Cash Flow Statement.');

  if (i.monthlySeries.length) s.autofilter = `A${headRow + 1}:${XLSX.utils.encode_col(LAST)}${lastRow + 1}`;
  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEETS.monthly);
};

// ── 7. Basis & assumptions ────────────────────────────────────────────────
const buildBasis = (wb: XLSX.WorkBook, i: CashFlowExcelInput): void => {
  const s = new Sheet();
  const LAST = 2;
  s.cols = [{ wch: 40 }, { wch: 62 }, { wch: 40 }];

  let r = header(s, i, 'BASIS OF PREPARATION & ASSUMPTIONS', LAST);

  const section = (title: string) => {
    s.merge(r, 0, LAST);
    s.set(r, 0, title, { s: sectionHeaderStyle(), num: false });
    r++;
  };
  const line = (label: string, value: string) => {
    s.set(r, 0, label, { s: labelStyle({ bold: true }), num: false });
    s.merge(r, 1, LAST);
    s.set(r, 1, value, { s: labelStyle(), num: false });
    r++;
  };

  section('SCOPE');
  line('Period covered', periodLabel(i).replace(/^For the period /, ''));
  line('Cash & bank ledgers treated as cash equivalents',
    i.cashLedgers.length ? i.cashLedgers.join(', ') : 'None selected');
  line('Method', 'Direct method — built from actual voucher movement in the cash & bank ledgers.');
  line('Source', 'Vouchers imported into FinAnalyzer from the Tally export.');
  r++;

  section('FILTERS APPLIED TO THE DETAIL SHEETS');
  line('Search text', i.filters.search || 'None');
  line('Direction', i.filters.direction === 'all' ? 'All flows' : i.filters.direction);
  line('Minimum amount', i.filters.minAmount ? i.filters.minAmount : 'None');
  r++;
  noteRow(s, r, LAST,
    'Filters affect the Ledger Flow Summary only. The Cash Flow Statement, Cash Ledger Movement and Monthly '
    + 'Trend are always built from the full unfiltered period so the statement continues to cast.');
  r += 2;

  section('CLASSIFICATION RULES');
  r = columnHeaders(s, r, ['Activity', 'Ledgers classified here', 'Basis']);
  const rules: Array<[string, string, string]> = [
    ['Operating', 'Debtors, creditors, sales, purchases, direct and indirect income and expenses, duties & taxes, current assets and liabilities',
      'Tally primary group of the counter-party ledger'],
    ['Investing', 'Fixed assets, capital work-in-progress, investments, loans & advances (asset)',
      'Tally primary group of the counter-party ledger'],
    ['Financing', 'Capital account, reserves, secured and unsecured loans, borrowings, interest and dividend paid',
      'Tally primary group of the counter-party ledger'],
    ['Unclassified / contra', 'Transfers between the selected cash & bank ledgers, and ledgers whose group could not be resolved',
      'Balancing figure — reconciles classified flows to actual cash movement'],
  ];
  rules.forEach(([a, l, b]) => {
    s.set(r, 0, a, { s: labelStyle({ bold: true }), num: false });
    s.set(r, 1, l, { s: labelStyle(), num: false });
    s.set(r, 2, b, { s: labelStyle({ muted: true }), num: false });
    r++;
  });
  r += 2;

  section('POINTS FOR REVIEW');
  const points: string[] = [
    'Classification is rule-based on the Tally group of the counter-party ledger. Ledgers grouped incorrectly in Tally will be classified incorrectly here.',
    'A large unclassified / contra adjustment usually means cash-to-bank transfers or ledgers sitting under a group the rules do not recognise. Review before publication.',
    'Inflow and outflow are gross; no netting has been applied within a bucket.',
  ];
  if (Math.abs(i.totals.blockedCapitalOutflow) >= 0.005) {
    points.push(`Outflow of ${i.totals.blockedCapitalOutflow.toFixed(2)} sits in ledgers flagged as blocked capital — confirm the classification.`);
  }
  if (i.cashPosition.reconciliationDiff !== null && Math.abs(i.cashPosition.reconciliationDiff) >= 0.005) {
    points.push(`Computed closing cash differs from the Tally ledger closing balances by ${i.cashPosition.reconciliationDiff.toFixed(2)}. Resolve before the pack is circulated.`);
  }
  points.forEach((p, n) => {
    s.set(r, 0, `${n + 1}.`, { s: labelStyle({ bold: true }), num: false });
    s.merge(r, 1, LAST);
    s.set(r, 1, p, { s: labelStyle(), num: false });
    r++;
  });
  r++;
  noteRow(s, r, LAST, `Generated by FinAnalyzer on ${today()}.`);

  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEETS.basis);
};

export const buildCashFlowWorkbook = (input: CashFlowExcelInput): XLSX.WorkBook => {
  const wb = XLSX.utils.book_new();
  buildCover(wb, input);
  buildStatement(wb, input);
  buildCashLedgers(wb, input);
  buildLedgerSummary(wb, input);
  buildActivity(wb, input);
  buildMonthly(wb, input);
  buildBasis(wb, input);
  return wb;
};
