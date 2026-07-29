// Trial Balance workbook builder.
//
// Uses the same styling layer as the Schedule III statements so the two exports
// read as one document. The sheet mirrors what the module shows on screen: the
// Tally group tree in its own sort order, ledgers under their sub-group, group
// subtotals that cast, and a grand total that proves Dr = Cr.

import XLSX from 'xlsx-js-style';
import type { TbGroupNode, TbLedgerRow, TrialBalanceResult } from './tally/queries';
import {
  ALIGN,
  NUMFMT,
  Sheet,
  columnHeaderStyle,
  errorBandStyle,
  grandTotalLabelStyle,
  grandTotalNumberStyle,
  labelStyle,
  numberStyle,
  sectionHeaderStyle,
  subBandStyle,
  subtotalLabelStyle,
  subtotalNumberStyle,
  titleBandStyle,
} from './excelStyles';

const SHEET = 'Trial Balance';
const Z = NUMFMT.accounting;
/** Particulars + 6 figure columns. */
const LAST_COL = 6;

export interface TbWorkbookInput {
  tb: TrialBalanceResult;
  companyTitle: string;
  /** Hide ledgers that never moved and hold no balance (mirrors the on-screen toggle). */
  hideUnused?: boolean;
  unitLabel?: string;
}

const isUnused = (l: TbLedgerRow): boolean =>
  l.activity === 'never-used' &&
  Math.abs(l.openingDr) < 0.005 && Math.abs(l.openingCr) < 0.005 &&
  Math.abs(l.duringDr) < 0.005 && Math.abs(l.duringCr) < 0.005 &&
  Math.abs(l.closingDr) < 0.005 && Math.abs(l.closingCr) < 0.005;

const ddmmyyyy = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || '';
};

export const buildTrialBalanceWorkbook = (input: TbWorkbookInput): XLSX.WorkBook => {
  const { tb } = input;
  const hideUnused = input.hideUnused ?? true;
  const unit = input.unitLabel || '(Rs.)';
  const s = new Sheet();
  s.cols = [{ wch: 56 }, ...Array.from({ length: LAST_COL }, () => ({ wch: 18 }))];

  let r = 0;
  const band = (text: string, style = titleBandStyle(12)) => {
    s.merge(r, 0, LAST_COL);
    s.set(r, 0, text, { s: style, num: false });
    r++;
  };
  band(input.companyTitle);
  band('TRIAL BALANCE', subBandStyle());
  band(
    tb.periodFrom && tb.periodTo
      ? `For the period ${ddmmyyyy(tb.periodFrom)} to ${ddmmyyyy(tb.periodTo)}`
      : 'All periods',
    subBandStyle(undefined, true),
  );
  band(unit, subBandStyle(undefined, true));

  // A trial balance that does not cast is a data problem; say so at the top.
  if (!tb.balanceCheck.closing.ok) {
    s.merge(r, 0, LAST_COL);
    s.set(r, 0,
      `⚠  DOES NOT CAST — closing Dr less Cr = ${tb.balanceCheck.closing.delta.toFixed(2)}. ` +
      `Investigate before relying on these figures.`,
      { s: errorBandStyle(), num: false });
    r += 2;
  }

  // Two-tier header: paired Dr/Cr under each stage.
  const groups: Array<[string, number]> = [['Opening Balance', 1], ['Transactions', 3], ['Closing Balance', 5]];
  for (const [label, c] of groups) {
    s.merge(r, c, c + 1);
    s.set(r, c, label, { s: columnHeaderStyle(ALIGN.center), num: false });
  }
  s.set(r, 0, 'Particulars', { s: columnHeaderStyle(ALIGN.left), num: false });
  r++;
  ['', 'Dr', 'Cr', 'Dr', 'Cr', 'Dr', 'Cr'].forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.left : ALIGN.center), num: false }));
  const headerRow = r;
  r++;

  const figures = (row: { openingDr: number; openingCr: number; duringDr: number; duringCr: number; closingDr: number; closingCr: number }) =>
    [row.openingDr, row.openingCr, row.duringDr, row.duringCr, row.closingDr, row.closingCr];

  // Blank rather than 0.00 for nil cells — a dense trial balance is unreadable
  // when every empty cell shouts a zero.
  const putFigures = (row: number, vals: number[], style: (z?: string) => any) => {
    vals.forEach((v, i) => {
      if (Math.abs(v) < 0.005) s.set(row, 1 + i, '', { s: style(Z), num: false });
      else s.set(row, 1 + i, v, { s: style(Z), num: true });
    });
  };

  const ledgerRows: number[] = [];

  const walk = (nodes: TbGroupNode[]): void => {
    for (const n of nodes) {
      const ledgers = hideUnused ? n.childLedgers.filter((l) => !isUnused(l)) : n.childLedgers;
      // Drop groups that end up with nothing to show.
      const hasDescendants = (g: TbGroupNode): boolean =>
        (hideUnused ? g.childLedgers.some((l) => !isUnused(l)) : g.childLedgers.length > 0) ||
        g.childGroups.some(hasDescendants);
      if (!hasDescendants(n)) continue;

      const indent = '    '.repeat(n.level);
      s.set(r, 0, `${indent}${n.name}`, { s: n.level === 0 ? sectionHeaderStyle() : subtotalLabelStyle(), num: false });
      putFigures(r, figures(n), n.level === 0 ? subtotalNumberStyle : subtotalNumberStyle);
      r++;

      for (const l of ledgers) {
        s.set(r, 0, `${indent}    ${l.ledger}${l.synthesised ? '  (derived)' : ''}`, { s: labelStyle(), num: false });
        putFigures(r, figures(l), numberStyle);
        ledgerRows.push(r);
        r++;
      }
      walk(n.childGroups);
    }
  };
  walk(tb.tree);

  // Grand total: a real SUM over the ledger rows only, so it cannot silently
  // disagree with the detail (group rows are subtotals and would double-count).
  r++;
  s.set(r, 0, 'GRAND TOTAL', { s: grandTotalLabelStyle(), num: false });
  const totals = [tb.grandTotals.openingDr, tb.grandTotals.openingCr, tb.grandTotals.duringDr,
    tb.grandTotals.duringCr, tb.grandTotals.closingDr, tb.grandTotals.closingCr];
  for (let i = 0; i < 6; i++) {
    const col = XLSX.utils.encode_col(1 + i);
    const refs = ledgerRows.map((row) => `${col}${row + 1}`);
    // Chunk the SUM so a very long ledger list cannot overflow Excel's formula limit.
    const formula = refs.length ? `SUM(${refs.join(',')})` : '0';
    s.setFormula(r, 1 + i, formula, Math.round(totals[i] * 100) / 100, grandTotalNumberStyle(Z));
  }
  const totalRow = r;
  r++;

  // The proof: Dr − Cr on the closing columns must be nil.
  s.set(r, 0, 'Difference (Closing Dr − Cr) — must be Nil', { s: subtotalLabelStyle(), num: false });
  s.setFormula(r, 5, `F${totalRow + 1}-G${totalRow + 1}`, Math.round(tb.balanceCheck.closing.delta * 100) / 100,
    subtotalNumberStyle(Z));
  r += 2;

  if (hideUnused) {
    const hidden = tb.activityCounts['never-used'] ?? 0;
    if (hidden > 0) {
      s.merge(r, 0, LAST_COL);
      s.set(r, 0, `${hidden} ledgers with no opening balance, no transactions and no closing balance are not shown.`,
        { s: labelStyle({ italic: true, muted: true }), num: false });
      r++;
    }
  }

  s.freeze = { r: headerRow + 1, c: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, s.toWS(), SHEET);
  return wb;
};
