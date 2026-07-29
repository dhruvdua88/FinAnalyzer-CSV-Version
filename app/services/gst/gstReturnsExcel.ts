// GST returns summary workbook.
//
// Sheets: Index (what was imported + coverage + warnings), then per financial year
// a summary sheet and three detail sheets. Styling comes entirely from excelStyles
// so this reads as the same document as the Schedule III statements.
//
// One convention runs through the whole workbook and matters for review:
//   • a figure of zero in a return that WAS supplied  → "Nil"
//   • a return that was NOT supplied for that month   → the words "Not supplied"
// They mean different things and are never rendered the same way.

import XLSX from 'xlsx-js-style';
import {
  ALIGN, NUMFMT, PALETTE, Sheet, columnHeaderStyle, errorBandStyle, font,
  grandTotalLabelStyle, grandTotalNumberStyle, internalLink, labelStyle, linkStyle,
  numberStyle, sectionHeaderStyle, subBandStyle, subtotalLabelStyle, subtotalNumberStyle,
  titleBandStyle,
} from '../excelStyles';
import { monthLabel, totalTax } from './gstReturnsIngest';
import type { Gstr1Period, Gstr2bPeriod, Gstr3bPeriod, TaxHeads, ValueWithTax } from './gstReturnsIngest';
import { coverageLabel } from './gstReturnsSummary';
import type { GstFySummary, GstMonthRow, GstOutwardCompareRow, GstSummaryModel } from './gstReturnsSummary';

const Z = NUMFMT.accounting;
const INDEX_SHEET = 'Index';

/** A difference worth a reviewer's attention: bold red. */
const diffStyle = (big: boolean) =>
  big
    ? { ...numberStyle(Z), font: font({ bold: true, color: PALETTE.error }) }
    : numberStyle(Z);
const mutedLabel = () => labelStyle({ italic: true, muted: true });
const isBig = (n: number | undefined): boolean => n !== undefined && Math.abs(n) > 0.5;

const summarySheetName = (fy: GstFySummary): string => fy.fy;                 // 'FY 2025-26'
const r1SheetName = (fy: GstFySummary): string => `R1 ${fy.fyShort}`;
const b3SheetName = (fy: GstFySummary): string => `3B ${fy.fyShort}`;
const b2SheetName = (fy: GstFySummary): string => `2B ${fy.fyShort}`;
const billsSheetName = (fy: GstFySummary): string => `Bills ${fy.fyShort}`;
const cmpSheetName = (fy: GstFySummary): string => `R1 vs 3B ${fy.fyShort}`;

const today = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
};

export const buildGstSummaryWorkbook = (model: GstSummaryModel): XLSX.WorkBook => {
  const wb = XLSX.utils.book_new();
  buildIndex(wb, model);
  for (const fy of model.fys) {
    buildFySummary(wb, model, fy);
    buildOutwardComparison(wb, model, fy);
    buildR1Detail(wb, model, fy);
    buildR1Bills(wb, model, fy);
    buildB3Detail(wb, model, fy);
    buildB2Detail(wb, model, fy);
  }
  return wb;
};

// ─── Index ───────────────────────────────────────────────────────────────────

const buildIndex = (wb: XLSX.WorkBook, model: GstSummaryModel): void => {
  const s = new Sheet();
  const LAST = 5;
  s.cols = [{ wch: 46 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 66 }];
  let r = 0;
  const band = (text: string, style = titleBandStyle(12)) => {
    s.merge(r, 0, LAST); s.set(r, 0, text, { s: style, num: false }); r++;
  };
  band(`GST RETURNS SUMMARY — ${model.gstin ?? 'GSTIN not identified'}`);
  band('GSTR-1 / IFF  ·  GSTR-3B  ·  GSTR-2B', subBandStyle());
  band(`Generated ${today()}  ·  ${model.reports.length} file(s) read  ·  ${model.fys.map((f) => f.fy).join(', ') || 'no periods'}`,
    subBandStyle(undefined, true));
  r++;

  const rejected = model.reports.filter((x) => x.status === 'rejected');
  if (model.warnings.length || rejected.length) {
    s.merge(r, 0, LAST);
    s.set(r, 0, 'Read before relying on these figures', { s: sectionHeaderStyle(), num: false });
    r++;
    if (rejected.length) {
      s.merge(r, 0, LAST);
      s.set(r, 0, `⚠  ${rejected.length} file(s) could not be read — see the file list below.`,
        { s: errorBandStyle(), num: false });
      r++;
    }
    for (const w of model.warnings) {
      s.merge(r, 0, LAST); s.set(r, 0, `•  ${w}`, { s: labelStyle(), num: false }); r++;
    }
    r++;
  }

  // Coverage — the answer to "what do I actually have?"
  s.merge(r, 0, LAST);
  s.set(r, 0, 'Coverage — which returns are present for each period', { s: sectionHeaderStyle(), num: false });
  r++;
  ['Period', 'GSTR-1 / IFF', 'GSTR-3B', 'GSTR-2B', '', ''].forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.left : ALIGN.center), num: false }));
  r++;
  const covStart = r;
  for (const fy of model.fys) {
    s.merge(r, 0, LAST);
    s.set(r, 0, fy.fy, { s: subtotalLabelStyle(), num: false });
    r++;
    for (const m of fy.months) {
      s.set(r, 0, m.label, { s: labelStyle(), num: false });
      (['r1', 'b3', 'b2'] as const).forEach((form, i) => {
        const text = coverageLabel(m, form);
        s.set(r, 1 + i, text, {
          s: text === '—' ? { ...mutedLabel(), alignment: ALIGN.center } : { ...labelStyle(), alignment: ALIGN.center },
          num: false,
        });
      });
      r++;
    }
  }
  if (r > covStart) s.applyZebra(covStart, r - 1, 0, 3);
  r++;

  // Sheet links
  s.merge(r, 0, LAST);
  s.set(r, 0, 'Sheets', { s: sectionHeaderStyle(), num: false });
  r++;
  for (const fy of model.fys) {
    for (const [label, name] of [
      [`${fy.fy} — summary and comparisons`, summarySheetName(fy)],
      [`${fy.fy} — GSTR-1 vs GSTR-3B`, cmpSheetName(fy)],
      [`${fy.fy} — GSTR-1 detail`, r1SheetName(fy)],
      [`${fy.fy} — GSTR-1 bill-wise`, billsSheetName(fy)],
      [`${fy.fy} — GSTR-3B detail`, b3SheetName(fy)],
      [`${fy.fy} — GSTR-2B detail`, b2SheetName(fy)],
    ] as Array<[string, string]>) {
      s.set(r, 0, label, { s: linkStyle(ALIGN.left), link: internalLink(name, 'A1', name), num: false });
      r++;
    }
  }
  r++;

  // Every file, including the ones that did not make it in.
  s.merge(r, 0, LAST);
  s.set(r, 0, 'Files imported', { s: sectionHeaderStyle(), num: false });
  r++;
  ['#', 'Source file', 'Detected as', 'Period', 'Status', 'Notes'].forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.center : ALIGN.left), num: false }));
  const fileHeader = r;
  r++;
  const fileStart = r;
  model.reports.forEach((rep, i) => {
    s.set(r, 0, i + 1, { s: { ...numberStyle(NUMFMT.plainInt), alignment: ALIGN.center }, num: true });
    s.set(r, 1, rep.sourceName, { s: labelStyle(), num: false });
    s.set(r, 2, rep.detectedAs ?? '—', { s: labelStyle(), num: false });
    s.set(r, 3, rep.period ? monthLabel(rep.period) : '—', { s: labelStyle(), num: false });
    const statusText = rep.status === 'ok' ? (rep.filed === false ? 'Saved (draft)' : 'Read')
      : rep.status === 'rejected' ? 'Rejected'
        : rep.status === 'superseded' ? 'Superseded' : 'Duplicate — ignored';
    s.set(r, 4, statusText, {
      s: rep.status === 'rejected'
        ? { ...labelStyle(), font: font({ bold: true, color: PALETTE.error }) }
        : rep.status === 'ok' ? labelStyle() : mutedLabel(),
      num: false,
    });
    s.set(r, 5, rep.reason ?? '', { s: mutedLabel(), num: false });
    r++;
  });
  if (r > fileStart) s.applyZebra(fileStart, r - 1, 0, LAST);
  s.autofilter = `A${fileHeader + 1}:F${r}`;
  s.freeze = { r: 3, c: 0 };
  XLSX.utils.book_append_sheet(wb, s.toWS(), INDEX_SHEET);
};

// ─── per-FY summary ──────────────────────────────────────────────────────────

const buildFySummary = (wb: XLSX.WorkBook, model: GstSummaryModel, fy: GstFySummary): void => {
  const s = new Sheet();
  const LAST = 9;
  s.cols = [{ wch: 16 }, { wch: 20 }, ...Array.from({ length: 8 }, () => ({ wch: 18 }))];
  let r = 0;
  s.merge(r, 0, LAST);
  s.set(r, 0, `${model.gstin ?? ''} — ${fy.fy}`, { s: titleBandStyle(12), num: false });
  r++;
  s.set(r, 0, '← Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Index'), num: false });
  r += 2;

  const notSupplied = (row: number, from: number, to: number, text = 'Not supplied') => {
    s.merge(row, from, to);
    s.set(row, from, text, { s: { ...mutedLabel(), alignment: ALIGN.center }, num: false });
  };
  /** Total row that sums only the rows that actually carried figures. */
  const totalRow = (label: string, cols: number[], rowsUsed: number[], values: (c: number) => number) => {
    s.set(r, 0, label, { s: grandTotalLabelStyle(), num: false });
    for (const c of cols) {
      const col = XLSX.utils.encode_col(c);
      const refs = rowsUsed.map((rr) => `${col}${rr + 1}`);
      if (refs.length) s.setFormula(r, c, `SUM(${refs.join(',')})`, values(c), grandTotalNumberStyle(Z));
      else s.set(r, c, 0, { s: grandTotalNumberStyle(Z), num: true });
    }
    r++;
  };

  // ── Block A: outward per GSTR-1 ──
  s.merge(r, 0, LAST);
  s.set(r, 0, 'A.  Outward supplies as per GSTR-1 / IFF', { s: sectionHeaderStyle(), num: false });
  r++;
  ['Month', 'Return', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess', 'Documents', 'Status'].forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c <= 1 ? ALIGN.left : ALIGN.center), num: false }));
  r++;
  const aRows: number[] = [];
  const aVals: Record<number, number> = {};
  for (const m of fy.months) {
    s.set(r, 0, m.label, { s: labelStyle(), num: false });
    if (!m.r1) {
      s.set(r, 1, '—', { s: mutedLabel(), num: false });
      notSupplied(r, 2, 8);
    } else {
      const kind = m.r1.iffInferred ? 'IFF (inferred)' : m.r1.quarterly ? 'GSTR-1 (quarterly)' : 'GSTR-1';
      s.set(r, 1, kind, { s: labelStyle(), num: false });
      const v = m.r1.netOutward;
      [v.taxable, v.igst, v.cgst, v.sgst, v.cess].forEach((n, i) => {
        s.set(r, 2 + i, n, { s: numberStyle(Z), num: true });
        aVals[2 + i] = (aVals[2 + i] ?? 0) + n;
      });
      const docs = m.r1.sections.reduce((a, x) => a + (x.kind === 'memo' ? 0 : x.docCount), 0);
      s.set(r, 7, docs, { s: numberStyle(NUMFMT.plainInt), num: true });
      aVals[7] = (aVals[7] ?? 0) + docs;
      s.set(r, 8, m.r1.filed ? 'Filed' : 'Saved (draft)', { s: m.r1.filed ? labelStyle() : mutedLabel(), num: false });
      aRows.push(r);
    }
    r++;
  }
  totalRow('Total', [2, 3, 4, 5, 6, 7], aRows, (c) => aVals[c] ?? 0);
  r++;

  // ── Block B: liability per GSTR-3B ──
  s.merge(r, 0, LAST);
  s.set(r, 0, 'B.  Liability as per GSTR-3B', { s: sectionHeaderStyle(), num: false });
  r++;
  ['Month', '3.1(a) Taxable', 'IGST', 'CGST', 'SGST', '3.1(b) Zero-rated', '3.1(c) Nil / exempt', '3.1(d) RCM inward', 'Interest', 'Late fee'].forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.left : ALIGN.center), num: false }));
  r++;
  const bRows: number[] = [];
  const bVals: Record<number, number> = {};
  for (const m of fy.months) {
    s.set(r, 0, m.label, { s: labelStyle(), num: false });
    if (!m.b3) { notSupplied(r, 1, 9); r++; continue; }
    const b = m.b3;
    const cells = [b.outwardTaxable.taxable, b.outwardTaxable.igst, b.outwardTaxable.cgst, b.outwardTaxable.sgst,
      b.outwardZero.taxable, b.nilExempt, b.inwardRcm.taxable, totalTax(b.interest), totalTax(b.lateFee)];
    cells.forEach((n, i) => {
      s.set(r, 1 + i, n, { s: numberStyle(Z), num: true });
      bVals[1 + i] = (bVals[1 + i] ?? 0) + n;
    });
    bRows.push(r); r++;
  }
  totalRow('Total', [1, 2, 3, 4, 5, 6, 7, 8, 9], bRows, (c) => bVals[c] ?? 0);
  r++;

  // ── Block C: outward comparison, on the basis the taxpayer filed on ──
  s.merge(r, 0, LAST);
  s.set(r, 0, 'C.  Outward supplies — GSTR-1 / IFF compared with GSTR-3B', { s: sectionHeaderStyle(), num: false });
  r++;
  ['Period', 'Basis', 'GSTR-1 taxable', 'GSTR-3B taxable', 'Difference', 'GSTR-1 tax', 'GSTR-3B tax', 'Difference', 'Status'].forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c <= 1 ? ALIGN.left : ALIGN.center), num: false }));
  r++;
  for (const row of fy.outwardCompare) {
    s.set(r, 0, row.label, { s: labelStyle(), num: false });
    s.set(r, 1, row.basis === 'quarter' ? 'Quarter' : 'Month', { s: mutedLabel(), num: false });
    const r1Tax = row.r1 ? totalTax(row.r1) : undefined;
    const b3Tax = row.b3 ? totalTax(row.b3) : undefined;
    s.set(r, 2, row.r1?.taxable ?? '', row.r1 ? { s: numberStyle(Z), num: true } : { s: mutedLabel(), num: false });
    s.set(r, 3, row.b3?.taxable ?? '', row.b3 ? { s: numberStyle(Z), num: true } : { s: mutedLabel(), num: false });
    if (row.diff) {
      // A live formula so the difference survives someone editing a figure.
      s.setFormula(r, 4, `D${r + 1}-C${r + 1}`, row.diff.taxable, diffStyle(isBig(row.diff.taxable)));
    } else s.set(r, 4, '—', { s: mutedLabel(), num: false });
    s.set(r, 5, r1Tax ?? '', r1Tax !== undefined ? { s: numberStyle(Z), num: true } : { s: mutedLabel(), num: false });
    s.set(r, 6, b3Tax ?? '', b3Tax !== undefined ? { s: numberStyle(Z), num: true } : { s: mutedLabel(), num: false });
    if (row.diff) {
      s.setFormula(r, 7, `G${r + 1}-F${r + 1}`, totalTax(row.diff), diffStyle(isBig(totalTax(row.diff))));
    } else s.set(r, 7, '—', { s: mutedLabel(), num: false });
    const statusText = row.status === 'match' ? 'Agrees'
      : row.status === 'mismatch' ? 'Difference — review'
        : row.status === 'r1-only' ? 'GSTR-1 only — no 3B' : 'GSTR-3B only — no GSTR-1';
    s.set(r, 8, statusText, {
      s: row.status === 'mismatch' ? { ...labelStyle(), font: font({ bold: true, color: PALETTE.error }) } : labelStyle(),
      num: false,
    });
    r++;
  }
  const qrmp = fy.outwardCompare.some((x) => x.basis === 'quarter');
  s.merge(r, 0, LAST);
  s.set(r, 0,
    'Difference = GSTR-3B less GSTR-1. The GSTR-1 figure is net outward: B2B, B2C, exports and amendments, '
    + 'plus debit notes and advances received, less credit notes and advances adjusted. Nil-rated, HSN, '
    + 'documents issued and e-commerce tables are memoranda and are not included.'
    + (qrmp ? '  Quarters filed under QRMP are compared for the quarter, because the IFF months and the quarterly '
      + 'GSTR-1 together correspond to one quarterly GSTR-3B.' : ''),
    { s: mutedLabel(), num: false });
  r += 2;

  // ── Block D: ITC comparison ──
  s.merge(r, 0, LAST);
  s.set(r, 0, 'D.  Input tax credit — GSTR-2B compared with GSTR-3B', { s: sectionHeaderStyle(), num: false });
  r++;
  ['Month', '2B IGST', '2B CGST', '2B SGST', '3B IGST', '3B CGST', '3B SGST', 'Δ IGST', 'Δ CGST', 'Δ SGST'].forEach((h, c) =>
    s.set(r, c, h, { s: columnHeaderStyle(c === 0 ? ALIGN.left : ALIGN.center), num: false }));
  r++;
  for (const m of fy.months) {
    s.set(r, 0, m.label, { s: labelStyle(), num: false });
    const cmp = m.itcCompare;
    if (!cmp || (!m.b2 && !m.b3)) { notSupplied(r, 1, 9); r++; continue; }
    if (!m.b2) { notSupplied(r, 1, 3, 'GSTR-2B not supplied'); } else {
      [cmp.b2.igst, cmp.b2.cgst, cmp.b2.sgst].forEach((n, i) => s.set(r, 1 + i, n, { s: numberStyle(Z), num: true }));
    }
    if (!m.b3) { notSupplied(r, 4, 6, 'GSTR-3B not supplied'); } else {
      [cmp.b3.igst, cmp.b3.cgst, cmp.b3.sgst].forEach((n, i) => s.set(r, 4 + i, n, { s: numberStyle(Z), num: true }));
    }
    if (m.b2 && m.b3) {
      (['igst', 'cgst', 'sgst'] as const).forEach((k, i) => {
        const col = XLSX.utils.encode_col(1 + i);
        const col3 = XLSX.utils.encode_col(4 + i);
        s.setFormula(r, 7 + i, `${col}${r + 1}-${col3}${r + 1}`, cmp.diff[k], diffStyle(isBig(cmp.diff[k])));
      });
    } else {
      for (let i = 0; i < 3; i++) s.set(r, 7 + i, '—', { s: mutedLabel(), num: false });
    }
    r++;
  }
  s.merge(r, 0, LAST);
  s.set(r, 0,
    'Δ = GSTR-2B less GSTR-3B. The GSTR-2B figure is the ITC-available bucket as the portal presents it '
    + '(inclusive of credit notes). The GSTR-3B figure is Table 4(C) net ITC. Amounts shown in GSTR-2B as '
    + 'not available, and documents rejected in IMS, are on the GSTR-2B detail sheet and are excluded here.',
    { s: mutedLabel(), num: false });

  s.freeze = { r: 3, c: 1 };
  XLSX.utils.book_append_sheet(wb, s.toWS(), summarySheetName(fy));
};

// ─── GSTR-1 detail ───────────────────────────────────────────────────────────
//
// Laid out the same way as the GSTR-3B sheet: particulars down the left, one
// column per month, a Total column on the right. Reading the two side by side is
// the whole point, so they must not have different orientations.

const HEAD_ROWS: Array<[string, keyof ValueWithTax]> = [
  ['Taxable value', 'taxable'], ['IGST', 'igst'], ['CGST', 'cgst'], ['SGST/UTGST', 'sgst'], ['Cess', 'cess'],
];

const buildR1Detail = (wb: XLSX.WorkBook, model: GstSummaryModel, fy: GstFySummary): void => {
  const s = new Sheet();
  const cols = fy.months.filter((m) => m.r1);
  const LAST = 1 + cols.length;
  s.cols = [{ wch: 52 }, ...cols.map(() => ({ wch: 18 })), { wch: 18 }];
  let r = 0;
  s.merge(r, 0, LAST);
  s.set(r, 0, `${model.gstin ?? ''} — GSTR-1 / IFF detail — ${fy.fy}`, { s: titleBandStyle(12), num: false });
  r++;
  s.set(r, 0, '← Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Index'), num: false });
  s.set(r, 1, 'Bill-wise detail →', {
    s: linkStyle(ALIGN.left), link: internalLink(billsSheetName(fy), 'A1', 'Bill-wise'), num: false,
  });
  r += 2;
  if (!cols.length) {
    s.set(r, 0, 'No GSTR-1 or IFF returns were supplied for this year.', { s: mutedLabel(), num: false });
    XLSX.utils.book_append_sheet(wb, s.toWS(), r1SheetName(fy));
    return;
  }

  s.set(r, 0, 'Particulars', { s: columnHeaderStyle(ALIGN.left), num: false });
  cols.forEach((m, i) => s.set(r, 1 + i, m.label, { s: columnHeaderStyle(ALIGN.center), num: false }));
  s.set(r, 1 + cols.length, 'Total', { s: columnHeaderStyle(ALIGN.center), num: false });
  const headerRow = r;
  r++;

  // Return type, so a quarterly column is never mistaken for a single month.
  s.set(r, 0, 'Return filed', { s: labelStyle({ bold: true }), num: false });
  cols.forEach((m, i) => {
    const g = m.r1!;
    s.set(r, 1 + i, g.iffInferred ? 'IFF (inferred)' : g.quarterly ? 'GSTR-1 (quarterly)' : 'GSTR-1',
      { s: { ...mutedLabel(), alignment: ALIGN.center }, num: false });
  });
  s.set(r, 1 + cols.length, '', { s: mutedLabel(), num: false });
  r++;

  const totalCol = 1 + cols.length;
  const rowTotal = (cached: number) => {
    const first = XLSX.utils.encode_col(1);
    const last = XLSX.utils.encode_col(cols.length);
    s.setFormula(r, totalCol, `SUM(${first}${r + 1}:${last}${r + 1})`, cached, subtotalNumberStyle(Z));
  };
  const group = (title: string) => {
    s.merge(r, 0, LAST);
    s.set(r, 0, title, { s: sectionHeaderStyle(), num: false });
    r++;
  };

  // One block per section actually present anywhere in the year, each with its
  // five tax-head rows, so every month lines up on the same rows.
  const sectionKeys: string[] = [];
  for (const m of cols) for (const sec of m.r1!.sections) if (!sectionKeys.includes(sec.key)) sectionKeys.push(sec.key);

  const pickSection = (m: GstMonthRow, key: string, head: keyof ValueWithTax, part?: 'c' | 'd'): number => {
    const sec = m.r1!.sections.find((x) => x.key === key);
    if (!sec) return 0;
    const v = part === 'c' ? sec.cSum : part === 'd' ? sec.dSum : sec.total;
    return v ? v[head] : 0;
  };
  const emitRows = (label: string, key: string, part?: 'c' | 'd') => {
    for (const [headLabel, head] of HEAD_ROWS) {
      s.set(r, 0, `${label} — ${headLabel}`, { s: labelStyle(), num: false });
      let sum = 0;
      cols.forEach((m, i) => {
        const v = pickSection(m, key, head, part);
        sum += v;
        s.set(r, 1 + i, v, { s: numberStyle(Z), num: true });
      });
      rowTotal(sum);
      r++;
    }
  };

  for (const kind of ['outward', 'note', 'advance', 'advance-adj', 'memo'] as const) {
    const keys = sectionKeys.filter((k) => {
      const anySec = cols.map((m) => m.r1!.sections.find((x) => x.key === k)).find(Boolean);
      return anySec?.kind === kind;
    });
    if (!keys.length) continue;
    group({
      outward: 'Outward supplies', note: 'Credit and debit notes',
      advance: 'Advances received', 'advance-adj': 'Advances adjusted',
      memo: 'Memoranda — not included in the net outward figure',
    }[kind]);
    for (const key of keys) {
      const anySec = cols.map((m) => m.r1!.sections.find((x) => x.key === key)).find(Boolean)!;
      if (kind === 'note') {
        const hasD = cols.some((m) => m.r1!.sections.find((x) => x.key === key)?.dSum);
        const hasC = cols.some((m) => m.r1!.sections.find((x) => x.key === key)?.cSum);
        if (hasD) emitRows(`${anySec.label} — debit notes (added)`, key, 'd');
        if (hasC) emitRows(`${anySec.label} — credit notes (deducted)`, key, 'c');
        if (!hasD && !hasC) emitRows(anySec.label, key);
      } else {
        emitRows(anySec.label, key);
      }
    }
  }

  // The figure that is compared with GSTR-3B.
  group('Net outward supplies');
  for (const [headLabel, head] of HEAD_ROWS) {
    s.set(r, 0, `Net outward — ${headLabel}`, { s: subtotalLabelStyle(), num: false });
    let sum = 0;
    cols.forEach((m, i) => {
      const v = m.r1!.netOutward[head];
      sum += v;
      s.set(r, 1 + i, v, { s: subtotalNumberStyle(Z), num: true });
    });
    rowTotal(sum);
    r++;
  }
  // Total tax per month — the row the reviewer adds up across I, C, S and cess.
  s.set(r, 0, 'Net outward — total tax (IGST + CGST + SGST + Cess)', { s: grandTotalLabelStyle(), num: false });
  let taxSum = 0;
  cols.forEach((m, i) => {
    const col = XLSX.utils.encode_col(1 + i);
    const v = totalTax(m.r1!.netOutward);
    taxSum += v;
    s.setFormula(r, 1 + i, `SUM(${col}${r - 3}:${col}${r})`, v, grandTotalNumberStyle(Z));
  });
  const firstC = XLSX.utils.encode_col(1);
  const lastC = XLSX.utils.encode_col(cols.length);
  s.setFormula(r, totalCol, `SUM(${firstC}${r + 1}:${lastC}${r + 1})`, taxSum, grandTotalNumberStyle(Z));
  r++;

  s.freeze = { r: headerRow + 1, c: 1 };
  XLSX.utils.book_append_sheet(wb, s.toWS(), r1SheetName(fy));
};

// ─── GSTR-1 bill-wise ────────────────────────────────────────────────────────

const buildR1Bills = (wb: XLSX.WorkBook, model: GstSummaryModel, fy: GstFySummary): void => {
  const s = new Sheet();
  const LAST = 12;
  s.cols = [{ wch: 13 }, { wch: 18 }, { wch: 20 }, { wch: 22 }, { wch: 13 }, { wch: 16 },
    { wch: 7 }, { wch: 8 }, { wch: 16 }, { wch: 15 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
  let r = 0;
  s.merge(r, 0, LAST);
  s.set(r, 0, `${model.gstin ?? ''} — GSTR-1 / IFF bill-wise detail — ${fy.fy}`, { s: titleBandStyle(12), num: false });
  r++;
  s.merge(r, 0, LAST);
  s.set(r, 0, 'Every document reported in the GSTR-1 and IFF returns supplied, for the periods supplied. '
    + 'Credit notes and advances adjusted are shown with a negative sign so the column totals agree with the '
    + 'net outward figure on the summary.', { s: subBandStyle(undefined, true), num: false });
  r++;
  s.set(r, 0, '← Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Index'), num: false });
  s.set(r, 1, 'Period summary →', { s: linkStyle(ALIGN.left), link: internalLink(r1SheetName(fy), 'A1', 'GSTR-1 detail'), num: false });
  r += 2;

  const heads = ['Period', 'Return', 'Table', 'Counterparty GSTIN', 'Document no.', 'Document date',
    'PoS', 'Rate %', 'Document value', 'Taxable value', 'IGST', 'CGST', 'SGST'];
  heads.forEach((h, c) => s.set(r, c, h, { s: columnHeaderStyle(c <= 6 ? ALIGN.left : ALIGN.center), num: false }));
  const headerRow = r;
  r++;

  const start = r;
  const dataRows: number[] = [];
  const totals = { value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  for (const m of fy.months.filter((x) => x.r1)) {
    const g = m.r1!;
    const kind = g.iffInferred ? 'IFF' : g.quarterly ? 'GSTR-1 (Q)' : 'GSTR-1';
    for (const d of g.documents) {
      const sec = g.sections.find((x) => x.key === d.section);
      s.set(r, 0, m.label, { s: labelStyle(), num: false });
      s.set(r, 1, kind, { s: mutedLabel(), num: false });
      s.set(r, 2, sec?.label ?? d.section, { s: labelStyle(), num: false });
      s.set(r, 3, d.ctin ?? '', { s: labelStyle(), num: false });
      s.set(r, 4, d.docNo, { s: labelStyle(), num: false });
      s.set(r, 5, d.docDate, { s: labelStyle(), num: false });
      s.set(r, 6, d.pos ?? '', { s: { ...labelStyle(), alignment: ALIGN.center }, num: false });
      if (d.rate !== undefined) s.set(r, 7, d.rate, { s: numberStyle(NUMFMT.plainInt), num: true });
      else s.set(r, 7, '', { s: mutedLabel(), num: false });
      const vals = [d.invoiceValue * d.sign, d.taxable * d.sign, d.igst * d.sign, d.cgst * d.sign, d.sgst * d.sign];
      vals.forEach((v, i) => s.set(r, 8 + i, v, { s: numberStyle(Z), num: true }));
      totals.value += vals[0]; totals.taxable += vals[1];
      totals.igst += vals[2]; totals.cgst += vals[3]; totals.sgst += vals[4];
      dataRows.push(r);
      r++;
    }
  }
  if (!dataRows.length) {
    s.set(r, 0, 'No GSTR-1 or IFF documents were supplied for this year.', { s: mutedLabel(), num: false });
    XLSX.utils.book_append_sheet(wb, s.toWS(), billsSheetName(fy));
    return;
  }
  s.applyZebra(start, r - 1, 0, LAST);

  s.set(r, 0, 'Total', { s: grandTotalLabelStyle(), num: false });
  for (let c = 1; c <= 7; c++) s.set(r, c, '', { s: grandTotalLabelStyle(), num: false });
  [totals.value, totals.taxable, totals.igst, totals.cgst, totals.sgst].forEach((cached, i) => {
    const col = XLSX.utils.encode_col(8 + i);
    s.setFormula(r, 8 + i, `SUM(${col}${start + 1}:${col}${r})`, cached, grandTotalNumberStyle(Z));
  });
  r++;

  s.autofilter = `A${headerRow + 1}:M${r - 1}`;
  s.freeze = { r: headerRow + 1, c: 1 };
  XLSX.utils.book_append_sheet(wb, s.toWS(), billsSheetName(fy));
};

// ─── GSTR-1 vs GSTR-3B, on its own sheet ─────────────────────────────────────

const buildOutwardComparison = (wb: XLSX.WorkBook, model: GstSummaryModel, fy: GstFySummary): void => {
  const s = new Sheet();
  const LAST = 8;
  s.cols = [{ wch: 20 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
    { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 26 }];
  let r = 0;
  s.merge(r, 0, LAST);
  s.set(r, 0, `${model.gstin ?? ''} — outward supplies: GSTR-1 / IFF vs GSTR-3B — ${fy.fy}`,
    { s: titleBandStyle(12), num: false });
  r++;
  s.set(r, 0, '← Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Index'), num: false });
  r += 2;

  // Only rows where both returns exist can be compared; the rest are listed
  // afterwards so a missing return is visible rather than implied.
  const both = fy.outwardCompare.filter((x) => x.r1 && x.b3);
  const oneSided = fy.outwardCompare.filter((x) => !x.r1 || !x.b3);

  s.merge(r, 0, LAST);
  s.set(r, 0, 'Periods where both returns were supplied', { s: sectionHeaderStyle(), num: false });
  r++;
  ['Period', 'Basis', 'GSTR-1 taxable', 'GSTR-3B taxable', 'Difference',
    'GSTR-1 tax', 'GSTR-3B tax', 'Difference', 'Status'].forEach((h, c) =>
      s.set(r, c, h, { s: columnHeaderStyle(c <= 1 ? ALIGN.left : ALIGN.center), num: false }));
  const headerRow = r;
  r++;
  const start = r;
  const t = { r1: 0, b3: 0, r1t: 0, b3t: 0 };
  for (const row of both) {
    s.set(r, 0, row.label, { s: labelStyle(), num: false });
    s.set(r, 1, row.basis === 'quarter' ? 'Quarter' : 'Month', { s: mutedLabel(), num: false });
    const r1t = totalTax(row.r1!); const b3t = totalTax(row.b3!);
    s.set(r, 2, row.r1!.taxable, { s: numberStyle(Z), num: true });
    s.set(r, 3, row.b3!.taxable, { s: numberStyle(Z), num: true });
    s.setFormula(r, 4, `D${r + 1}-C${r + 1}`, row.diff!.taxable, diffStyle(isBig(row.diff!.taxable)));
    s.set(r, 5, r1t, { s: numberStyle(Z), num: true });
    s.set(r, 6, b3t, { s: numberStyle(Z), num: true });
    s.setFormula(r, 7, `G${r + 1}-F${r + 1}`, b3t - r1t, diffStyle(isBig(b3t - r1t)));
    s.set(r, 8, row.status === 'match' ? 'Agrees' : 'Difference — review', {
      s: row.status === 'match' ? labelStyle() : { ...labelStyle(), font: font({ bold: true, color: PALETTE.error }) },
      num: false,
    });
    t.r1 += row.r1!.taxable; t.b3 += row.b3!.taxable; t.r1t += r1t; t.b3t += b3t;
    r++;
  }
  if (r > start) {
    s.applyZebra(start, r - 1, 0, LAST);
    s.set(r, 0, 'Total', { s: grandTotalLabelStyle(), num: false });
    s.set(r, 1, '', { s: grandTotalLabelStyle(), num: false });
    ([[2, t.r1], [3, t.b3], [5, t.r1t], [6, t.b3t]] as Array<[number, number]>).forEach(([c, cached]) => {
      const col = XLSX.utils.encode_col(c);
      s.setFormula(r, c, `SUM(${col}${start + 1}:${col}${r})`, cached, grandTotalNumberStyle(Z));
    });
    s.setFormula(r, 4, `D${r + 1}-C${r + 1}`, t.b3 - t.r1, { ...grandTotalNumberStyle(Z), font: font({ bold: true, color: isBig(t.b3 - t.r1) ? PALETTE.error : PALETTE.text }) });
    s.setFormula(r, 7, `G${r + 1}-F${r + 1}`, t.b3t - t.r1t, { ...grandTotalNumberStyle(Z), font: font({ bold: true, color: isBig(t.b3t - t.r1t) ? PALETTE.error : PALETTE.text }) });
    s.set(r, 8, '', { s: grandTotalLabelStyle(), num: false });
    r += 2;
  } else {
    s.set(r, 0, 'No period has both a GSTR-1 and a GSTR-3B.', { s: mutedLabel(), num: false });
    r += 2;
  }

  if (oneSided.length) {
    s.merge(r, 0, LAST);
    s.set(r, 0, 'Periods that cannot be compared', { s: sectionHeaderStyle(), num: false });
    r++;
    ['Period', 'Basis', 'GSTR-1 taxable', 'GSTR-3B taxable', '', '', '', '', 'Reason'].forEach((h, c) =>
      s.set(r, c, h, { s: columnHeaderStyle(c <= 1 ? ALIGN.left : ALIGN.center), num: false }));
    r++;
    for (const row of oneSided) {
      s.set(r, 0, row.label, { s: labelStyle(), num: false });
      s.set(r, 1, row.basis === 'quarter' ? 'Quarter' : 'Month', { s: mutedLabel(), num: false });
      if (row.r1) s.set(r, 2, row.r1.taxable, { s: numberStyle(Z), num: true });
      else s.set(r, 2, 'Not supplied', { s: { ...mutedLabel(), alignment: ALIGN.center }, num: false });
      if (row.b3) s.set(r, 3, row.b3.taxable, { s: numberStyle(Z), num: true });
      else s.set(r, 3, 'Not supplied', { s: { ...mutedLabel(), alignment: ALIGN.center }, num: false });
      s.set(r, 8, row.r1 ? 'No GSTR-3B for this period' : 'No GSTR-1 for this period', { s: mutedLabel(), num: false });
      r++;
    }
    r++;
  }

  s.merge(r, 0, LAST);
  s.set(r, 0,
    'Difference = GSTR-3B less GSTR-1. The GSTR-1 figure is net outward: B2B, B2C, exports and amendments, '
    + 'plus debit notes and advances received, less credit notes and advances adjusted. '
    + (both.some((x) => x.basis === 'quarter')
      ? 'Quarters filed under QRMP are compared for the quarter, because the IFF months and the quarterly '
        + 'GSTR-1 together correspond to one quarterly GSTR-3B; comparing them month by month would show '
        + 'differences that do not exist.'
      : ''),
    { s: mutedLabel(), num: false });

  s.freeze = { r: headerRow + 1, c: 1 };
  XLSX.utils.book_append_sheet(wb, s.toWS(), cmpSheetName(fy));
};

// ─── GSTR-3B detail ──────────────────────────────────────────────────────────

const buildB3Detail = (wb: XLSX.WorkBook, model: GstSummaryModel, fy: GstFySummary): void => {
  const s = new Sheet();
  const cols = fy.months.filter((m) => m.b3);
  const LAST = 1 + cols.length;
  s.cols = [{ wch: 52 }, ...cols.map(() => ({ wch: 18 })), { wch: 18 }];
  let r = 0;
  s.merge(r, 0, LAST);
  s.set(r, 0, `${model.gstin ?? ''} — GSTR-3B detail — ${fy.fy}`, { s: titleBandStyle(12), num: false });
  r++;
  s.set(r, 0, '← Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Index'), num: false });
  r += 2;
  if (!cols.length) {
    s.set(r, 0, 'No GSTR-3B returns were supplied for this year.', { s: mutedLabel(), num: false });
    XLSX.utils.book_append_sheet(wb, s.toWS(), b3SheetName(fy));
    return;
  }

  s.set(r, 0, 'Particulars', { s: columnHeaderStyle(ALIGN.left), num: false });
  cols.forEach((m, i) => s.set(r, 1 + i, m.label, { s: columnHeaderStyle(ALIGN.center), num: false }));
  s.set(r, 1 + cols.length, 'Total', { s: columnHeaderStyle(ALIGN.center), num: false });
  const headerRow = r;
  r++;

  const group = (title: string) => {
    s.merge(r, 0, LAST);
    s.set(r, 0, title, { s: sectionHeaderStyle(), num: false });
    r++;
  };
  const line = (label: string, pick: (b: Gstr3bPeriod) => number, sub = false) => {
    s.set(r, 0, label, { s: sub ? subtotalLabelStyle() : labelStyle(), num: false });
    cols.forEach((m, i) => s.set(r, 1 + i, pick(m.b3!), { s: sub ? subtotalNumberStyle(Z) : numberStyle(Z), num: true }));
    const first = XLSX.utils.encode_col(1);
    const last = XLSX.utils.encode_col(cols.length);
    s.setFormula(r, 1 + cols.length, `SUM(${first}${r + 1}:${last}${r + 1})`,
      cols.reduce((a, m) => a + pick(m.b3!), 0), subtotalNumberStyle(Z));
    r++;
  };

  group('3.1  Outward supplies and inward supplies liable to reverse charge');
  line('3.1(a)  Outward taxable supplies — taxable value', (b) => b.outwardTaxable.taxable);
  line('             IGST', (b) => b.outwardTaxable.igst);
  line('             CGST', (b) => b.outwardTaxable.cgst);
  line('             SGST/UTGST', (b) => b.outwardTaxable.sgst);
  line('             Cess', (b) => b.outwardTaxable.cess);
  line('3.1(b)  Zero-rated supplies — taxable value', (b) => b.outwardZero.taxable);
  line('3.1(c)  Nil-rated and exempt — taxable value', (b) => b.nilExempt);
  line('3.1(d)  Inward liable to reverse charge — taxable value', (b) => b.inwardRcm.taxable);
  line('3.1(e)  Non-GST outward — taxable value', (b) => b.nonGst);
  if (cols.some((m) => m.b3!.eco)) {
    group('3.1.1  Supplies through an e-commerce operator (section 9(5))');
    line('3.1.1(i)   ECO pays the tax — taxable value', (b) => b.eco?.ecoSup.taxable ?? 0);
    line('3.1.1(ii)  Registered supplier through an ECO — taxable value', (b) => b.eco?.ecoRegSupTaxable ?? 0);
  }

  group('4(A)  ITC available');
  const AVAIL: Array<[string, string]> = [
    ['IMPG', 'Import of goods'], ['IMPS', 'Import of services'], ['ISRC', 'Inward supplies liable to reverse charge'],
    ['ISD', 'Input service distributor'], ['OTH', 'All other ITC'],
  ];
  for (const [ty, label] of AVAIL) {
    for (const [head, key] of [['IGST', 'igst'], ['CGST', 'cgst'], ['SGST/UTGST', 'sgst']] as Array<[string, keyof TaxHeads]>) {
      line(`4(A)  ${label} — ${head}`, (b) => b.itcAvail[ty]?.[key] ?? 0);
    }
  }
  group('4(B)  ITC reversed');
  line('4(B)(1)  As per rules 38, 42 and 43 and section 17(5) — IGST', (b) => b.itcRev['RUL']?.igst ?? 0);
  line('4(B)(1)  — CGST', (b) => b.itcRev['RUL']?.cgst ?? 0);
  line('4(B)(1)  — SGST/UTGST', (b) => b.itcRev['RUL']?.sgst ?? 0);
  line('4(B)(2)  Others — IGST', (b) => b.itcRev['OTH']?.igst ?? 0);
  line('4(B)(2)  — CGST', (b) => b.itcRev['OTH']?.cgst ?? 0);
  line('4(B)(2)  — SGST/UTGST', (b) => b.itcRev['OTH']?.sgst ?? 0);

  group('4(C)  Net ITC available');
  line('Net ITC — IGST', (b) => b.itcNet.igst, true);
  line('Net ITC — CGST', (b) => b.itcNet.cgst, true);
  line('Net ITC — SGST/UTGST', (b) => b.itcNet.sgst, true);
  line('Net ITC — Cess', (b) => b.itcNet.cess, true);

  // These two rows changed meaning in the September 2022 restructuring while keeping
  // their JSON keys, so the pre-2022 wording would be wrong here.
  group('4(D)  Other details');
  line('4(D)(1)  ITC reclaimed, previously reversed — IGST', (b) => b.itcInelig['RUL']?.igst ?? 0);
  line('4(D)(1)  — CGST', (b) => b.itcInelig['RUL']?.cgst ?? 0);
  line('4(D)(1)  — SGST/UTGST', (b) => b.itcInelig['RUL']?.sgst ?? 0);
  line('4(D)(2)  Ineligible u/s 16(4) and restricted by place-of-supply rules — IGST', (b) => b.itcInelig['OTH']?.igst ?? 0);
  line('4(D)(2)  — CGST', (b) => b.itcInelig['OTH']?.cgst ?? 0);
  line('4(D)(2)  — SGST/UTGST', (b) => b.itcInelig['OTH']?.sgst ?? 0);

  group('5.1  Interest and late fee');
  line('Interest', (b) => totalTax(b.interest));
  line('Late fee', (b) => totalTax(b.lateFee));
  if (cols.some((m) => m.b3!.ttVal)) {
    group('6.1  Payment of tax');
    line('Total payable', (b) => b.ttVal?.pay ?? 0);
    line('Paid in cash', (b) => b.ttVal?.cash ?? 0);
    line('Paid through ITC', (b) => b.ttVal?.itc ?? 0);
  }

  s.freeze = { r: headerRow + 1, c: 1 };
  XLSX.utils.book_append_sheet(wb, s.toWS(), b3SheetName(fy));
};

// ─── GSTR-2B detail ──────────────────────────────────────────────────────────

const BUCKET_LABELS: Record<string, string> = {
  itcavl: 'ITC available',
  itcunavl: 'ITC not available',
  itcrev: 'ITC reversal (rule 37A)',
  itcRejected: 'Rejected in IMS — no ITC',
};
const GROUP_LABELS: Record<string, string> = {
  nonrevsup: 'Other than reverse charge',
  revsup: 'Liable to reverse charge',
  isdsup: 'Input service distributor',
  imports: 'Imports',
  othersup: 'Other supplies / amendments',
};

const buildB2Detail = (wb: XLSX.WorkBook, model: GstSummaryModel, fy: GstFySummary): void => {
  const s = new Sheet();
  const LAST = 7;
  s.cols = [{ wch: 26 }, { wch: 30 }, { wch: 14 }, ...Array.from({ length: 5 }, () => ({ wch: 18 }))];
  let r = 0;
  s.merge(r, 0, LAST);
  s.set(r, 0, `${model.gstin ?? ''} — GSTR-2B detail — ${fy.fy}`, { s: titleBandStyle(12), num: false });
  r++;
  s.set(r, 0, '← Index', { s: linkStyle(ALIGN.left), link: internalLink(INDEX_SHEET, 'A1', 'Index'), num: false });
  r += 2;

  const periods = fy.months.filter((m) => m.b2);
  if (!periods.length) {
    s.set(r, 0, 'No GSTR-2B statements were supplied for this year.', { s: mutedLabel(), num: false });
  }
  for (const m of periods) {
    const b = m.b2!;
    s.merge(r, 0, LAST);
    s.set(r, 0, `${m.label} — GSTR-2B${b.gendt ? ` (generated ${b.gendt})` : ''}`, { s: sectionHeaderStyle(), num: false });
    r++;
    ['Bucket', 'Group', 'Section', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'].forEach((h, c) =>
      s.set(r, c, h, { s: columnHeaderStyle(c <= 2 ? ALIGN.left : ALIGN.center), num: false }));
    r++;
    const start = r;
    for (const bucket of ['itcavl', 'itcunavl', 'itcrev', 'itcRejected'] as const) {
      const rows = b.rows.filter((x) => x.bucket === bucket);
      if (!rows.length) continue;
      const used: number[] = [];
      for (const row of rows) {
        s.set(r, 0, BUCKET_LABELS[row.bucket] ?? row.bucket, { s: labelStyle(), num: false });
        s.set(r, 1, GROUP_LABELS[row.group] ?? row.group, { s: labelStyle(), num: false });
        s.set(r, 2, row.section, { s: labelStyle(), num: false });
        [row.total.taxable, row.total.igst, row.total.cgst, row.total.sgst, row.total.cess]
          .forEach((n, i) => s.set(r, 3 + i, n, { s: numberStyle(Z), num: true }));
        used.push(r); r++;
      }
      s.set(r, 0, `Total — ${BUCKET_LABELS[bucket] ?? bucket}`, { s: subtotalLabelStyle(), num: false });
      s.set(r, 1, '', { s: subtotalLabelStyle(), num: false });
      s.set(r, 2, '', { s: subtotalLabelStyle(), num: false });
      for (let c = 3; c <= 7; c++) {
        const col = XLSX.utils.encode_col(c);
        const cached = rows.reduce((a, x) => a + [x.total.taxable, x.total.igst, x.total.cgst, x.total.sgst, x.total.cess][c - 3], 0);
        s.setFormula(r, c, `SUM(${used.map((rr) => `${col}${rr + 1}`).join(',')})`, cached, subtotalNumberStyle(Z));
      }
      r++;
    }
    if (r > start) s.applyZebra(start, r - 1, 0, LAST);

    const dc = b.docCounts;
    const bits = [
      `${dc.b2bAvl} B2B document(s) with ITC`,
      dc.b2bUnavl ? `${dc.b2bUnavl} B2B document(s) with ITC NOT available` : '',
      dc.cdnr ? `${dc.cdnr} credit/debit note(s)` : '',
      dc.isd ? `${dc.isd} ISD document(s)` : '',
      dc.impg + dc.impgsez ? `${dc.impg + dc.impgsez} import document(s)` : '',
    ].filter(Boolean);
    s.merge(r, 0, LAST);
    s.set(r, 0, `Documents: ${bits.join(' · ')}`, { s: labelStyle(), num: false });
    r++;
    if (Object.keys(b.unavailReasons).length) {
      const txt = Object.entries(b.unavailReasons)
        .map(([code, n]) => `${code === 'P' ? 'P (place-of-supply rule)' : code} × ${n}`).join(' · ');
      s.merge(r, 0, LAST);
      s.set(r, 0, `ITC not available — reason code(s): ${txt}`,
        { s: { ...labelStyle(), font: font({ bold: true, color: PALETTE.error }) }, num: false });
      r++;
    }
    const ims = Object.entries(b.imsStatuses).filter(([k]) => k !== 'N');
    if (ims.length) {
      s.merge(r, 0, LAST);
      s.set(r, 0, `Invoice Management System status: ${ims.map(([k, n]) => `${k} × ${n}`).join(' · ')}`, { s: mutedLabel(), num: false });
      r++;
    }
    if (b.crossCheckOk) {
      s.set(r, 0, 'Documents agree with the ITC summary', { s: subtotalLabelStyle(), num: false });
      s.set(r, 3, b.docdataTaxable, { s: subtotalNumberStyle(Z), num: true });
      r++;
    } else {
      s.merge(r, 0, LAST);
      s.set(r, 0,
        `⚠  Documents total ${b.docdataTaxable.toFixed(2)} but the ITC summary totals `
        + `${(b.docdataTaxable - b.crossCheckDelta).toFixed(2)} — difference ${b.crossCheckDelta.toFixed(2)}.`,
        { s: errorBandStyle(), num: false });
      r++;
    }
    r++;
  }
  s.freeze = { r: 3, c: 1 };
  XLSX.utils.book_append_sheet(wb, s.toWS(), b2SheetName(fy));
};
