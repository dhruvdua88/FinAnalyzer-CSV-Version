// Shared styling / number-format helpers for the xlsx-js-style financial-
// statements export. This is the single styling layer used by the Balance
// Sheet, Statement of P&L, every note schedule, the Notes Index and the
// Group Mapping working tab — so style choices live in ONE place and never
// drift per-module.
//
// Engine: xlsx-js-style (a SheetJS fork that honours per-cell `.s` styles).
// Nothing here imports xlsx-js-style itself; these are plain style objects
// that the builder attaches to `cell.s`, plus thin helpers that mutate an
// already-built worksheet (borders on subtotal/total rows, zebra, etc.).

// ── Palette (audit-grade slate/zinc; mirrors ProfitLossAnalysis.tsx) ──
// Kept intentionally small (~6 fills) so the workbook reads as one document.
export const PALETTE = {
  // Brand / workbook-title band + statement-title band
  band: '0F2440', // deep slate
  bandText: 'FFFFFF',
  // Section / group headers
  section: 'E2E8F0', // light slate fill
  sectionText: '0F172A',
  // Subtotal rows
  subtotal: 'F1F5F9',
  // Grand-total rows (Total Equity & Liabilities / Total Assets)
  grandTotal: 'E8EEF5', // faint
  grandTotalText: '0F172A',
  // Zebra (dense note schedules only)
  zebraA: 'FFFFFF',
  zebraB: 'F8FAFC',
  // Links (note-references / index)
  link: '1D4ED8', // link blue
  // Source-coding accents (Group Mapping working tab only)
  srcInput: '1D4ED8', // blue   = hardcoded input
  srcFormula: '000000', // black  = formula / derived
  srcLink: '047857', // green  = cross-sheet link
  // Generic
  text: '0F172A',
  muted: '64748B',
  border: 'CBD5E1',
  borderDark: '94A3B8',
  white: 'FFFFFF',
} as const;

export const FONT = 'Calibri';
export const SIZE = { body: 11, section: 12, title: 14 } as const;

// ── Number formats ──
// Indian lakh/crore grouping. Accounting-style default: parentheses-negative,
// "Nil" for zero. The escaped-comma block code below is the canonical one the
// design calls for; it has been verified to render in both Excel and
// LibreOffice Calc. We expose a simpler fallback too.
export const NUMFMT = {
  // Canonical accounting code (lakh grouping, parentheses-negative, Nil-zero).
  // Note: the leading underscore-space pads the positive value to align with
  // the closing paren of negatives.
  accounting: '_(* ##,##,##,##0.00_);_(* (##,##,##,##0.00);_(* "Nil"_)',
  // Simpler plain code (same grouping, dash for zero) — use where the
  // accounting alignment padding is not wanted (e.g. note detail tables).
  plain: '##,##,##,##0.00;[Red](##,##,##,##0.00);"-"',
  // Integer variants (no paise) for dense schedules / indicative columns.
  accountingInt: '_(* ##,##,##,##0_);_(* (##,##,##,##0);_(* "Nil"_)',
  plainInt: '##,##,##,##0;[Red](##,##,##,##0);"-"',
} as const;

// ── Alignment presets ──
export const ALIGN = {
  left: { horizontal: 'left', vertical: 'center' },
  right: { horizontal: 'right', vertical: 'center' },
  center: { horizontal: 'center', vertical: 'center', wrapText: true },
  centerNoWrap: { horizontal: 'center', vertical: 'center' },
} as const;

export type Style = Record<string, any>;

// ── Font / fill primitives ──
export const font = (opts: { bold?: boolean; sz?: number; color?: string; italic?: boolean; underline?: boolean } = {}): Style => ({
  name: FONT,
  bold: !!opts.bold,
  sz: opts.sz ?? SIZE.body,
  color: { rgb: opts.color ?? PALETTE.text },
  italic: !!opts.italic,
  underline: !!opts.underline,
});

export const fill = (rgb: string): Style => ({ patternType: 'solid', fgColor: { rgb } });

// Border edge helpers (xlsx-js-style border shape).
const edge = (style: string, rgb: string) => ({ style, color: { rgb } });
export const BORDER = {
  topThin: { top: edge('thin', PALETTE.borderDark) },
  topDouble: { top: edge('thin', PALETTE.borderDark) },
  // Grand-total: single top + double bottom.
  grandTotal: {
    top: edge('thin', PALETTE.borderDark),
    bottom: edge('double', PALETTE.text),
  },
  subtotal: { top: edge('thin', PALETTE.border) },
} as const;

// ── Base text / number styles (the body baseline everything extends) ──
export const baseTextStyle = (): Style => ({ font: font(), alignment: ALIGN.left });
export const baseNumberStyle = (z: string = NUMFMT.accounting): Style => ({ font: font(), alignment: ALIGN.right, numFmt: z });

// ── Ready-made cell styles for the statement face ──
// Workbook-title band cell (Calibri 14 bold white on slate). Merge separately.
export const titleBandStyle = (sz: number = SIZE.title): Style => ({
  font: font({ bold: true, sz, color: PALETTE.bandText }),
  fill: fill(PALETTE.band),
  alignment: ALIGN.center,
});

// Sub-band (statement title / period / unit) — slightly smaller.
export const subBandStyle = (sz: number = SIZE.section, muted = false): Style => ({
  font: font({ bold: !muted, sz, color: muted ? PALETTE.sectionText : PALETTE.bandText }),
  fill: fill(muted ? PALETTE.section : PALETTE.band),
  alignment: ALIGN.center,
});

// Column header row cells (light slate fill, bold dark text).
export const columnHeaderStyle = (alignment: Style = ALIGN.center): Style => ({
  font: font({ bold: true, sz: SIZE.body, color: PALETTE.sectionText }),
  fill: fill(PALETTE.section),
  alignment,
});

// Section / group header (light slate, bold dark, left-aligned, 12pt).
export const sectionHeaderStyle = (): Style => ({
  font: font({ bold: true, sz: SIZE.section, color: PALETTE.sectionText }),
  fill: fill(PALETTE.section),
  alignment: ALIGN.left,
});

// Plain body label / number.
export const labelStyle = (opts: { bold?: boolean; italic?: boolean; muted?: boolean } = {}): Style => ({
  font: font({ bold: opts.bold, italic: opts.italic, color: opts.muted ? PALETTE.muted : PALETTE.text }),
  alignment: ALIGN.left,
});
export const numberStyle = (z: string = NUMFMT.accounting, opts: { bold?: boolean; italic?: boolean; muted?: boolean } = {}): Style => ({
  font: font({ bold: opts.bold, italic: opts.italic, color: opts.muted ? PALETTE.muted : PALETTE.text }),
  alignment: ALIGN.right,
  numFmt: z,
});

// Subtotal label / number (faint fill, bold, single top border).
export const subtotalLabelStyle = (): Style => ({
  font: font({ bold: true }),
  fill: fill(PALETTE.subtotal),
  alignment: ALIGN.left,
  border: BORDER.subtotal,
});
export const subtotalNumberStyle = (z: string = NUMFMT.accounting): Style => ({
  font: font({ bold: true }),
  fill: fill(PALETTE.subtotal),
  alignment: ALIGN.right,
  numFmt: z,
  border: BORDER.subtotal,
});

// Grand-total label / number (bold dark, faint fill, single top + double bottom).
export const grandTotalLabelStyle = (): Style => ({
  font: font({ bold: true, color: PALETTE.grandTotalText }),
  fill: fill(PALETTE.grandTotal),
  alignment: ALIGN.left,
  border: BORDER.grandTotal,
});
export const grandTotalNumberStyle = (z: string = NUMFMT.accounting): Style => ({
  font: font({ bold: true, color: PALETTE.grandTotalText }),
  fill: fill(PALETTE.grandTotal),
  alignment: ALIGN.right,
  numFmt: z,
  border: BORDER.grandTotal,
});

// Internal hyperlink (note-reference / index / back-links): link-blue underline.
export const linkStyle = (alignment: Style = ALIGN.center): Style => ({
  font: font({ color: PALETTE.link, underline: true }),
  alignment,
});

// Build a SheetJS internal-link object for a sheet target.
export const internalLink = (sheetName: string, cell = 'A1', tooltip?: string) => ({
  Target: `#'${sheetName}'!${cell}`,
  Tooltip: tooltip ?? `Go to ${sheetName}`,
});

// Source-coding font (Group Mapping working tab): input/formula/link accents.
export const sourceColor = (kind: 'input' | 'formula' | 'link'): string =>
  kind === 'input' ? PALETTE.srcInput : kind === 'link' ? PALETTE.srcLink : PALETTE.srcFormula;

// ── Worksheet-level mutators (operate on a built ws keyed by A1 refs) ──

// Apply faint zebra striping to a row range of an already-built worksheet.
// `encodeCell` is passed in (XLSX.utils.encode_cell) to avoid importing the
// engine here. Only fills cells that exist and have no fill yet.
export const zebra = (
  ws: Record<string, any>,
  encodeCell: (a: { r: number; c: number }) => string,
  startRow: number,
  endRow: number,
  firstCol: number,
  lastCol: number,
): void => {
  for (let r = startRow; r <= endRow; r++) {
    const bg = (r - startRow) % 2 === 0 ? PALETTE.zebraA : PALETTE.zebraB;
    if (bg === PALETTE.zebraA) continue; // leave the white rows untouched
    for (let c = firstCol; c <= lastCol; c++) {
      const ref = encodeCell({ r, c });
      const cell = ws[ref];
      if (!cell) continue;
      cell.s = cell.s || {};
      if (!cell.s.fill) cell.s.fill = fill(PALETTE.zebraB);
    }
  }
};
