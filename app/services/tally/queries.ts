// Pre-built typed query views over TallyStore.
//
// Each function takes a TallyStore and optional filters, returns plain
// typed rows. No React, no DOM, no Excel — pure data so anyone (UI, tests,
// workers, Excel export) can call them.
//
// Conventions
// -----------
// • Date filters are ISO ('YYYY-MM-DD'); both ends inclusive.
// • Amounts come back as plain numbers, signs as Tally stored them.
// • Names are case-significant but joins use nameKey() to be space-tolerant.

import { nameKey } from './helpers';
import type { TallyStore } from './store';
import type { Ledger } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Purchase Register / ITC — ported from purchase_register_itc.py
// ─────────────────────────────────────────────────────────────────────────────

// Primary groups whose ledger hits make a voucher eligible for the ITC
// register. Walk the parent chain in mst_group until one of these is hit.
export const TARGET_PRIMARIES = new Set([
  'Purchase Accounts',
  'Direct Expenses',
  'Indirect Expenses',
  'Fixed Assets',
]);

// Primary-group → GSTR-3B / ITC-3 schedule II category. Used as the "ITC Type"
// column on the register. If a voucher hits multiple primaries we use the
// mode (most-frequent) of its expense lines.
export const ITC_TYPE_MAP: Record<string, 'Inputs' | 'Input Services' | 'Capital Goods'> = {
  'Purchase Accounts': 'Inputs',
  'Direct Expenses':   'Input Services',
  'Indirect Expenses': 'Input Services',
  'Fixed Assets':      'Capital Goods',
};

export const GSTR3B_REF = {
  B2B:           '4(A)(5) All Other ITC',
  'RCM-UR':      '4(A)(3) Reverse Charge',
  IMPORTSERVICE: '4(A)(2) Import of Services',
} as const;

// Keywords in a ledger name that flip it from input GST to output GST. The
// list mirrors the Python rule exactly so the output reconciles.
const OUTPUT_GST_KEYWORDS = [
  'output', 'sales cgst', 'sales igst', 'sales sgst',
  'payable/c', 'gst payable', 'gst cash', 'accrued', 'accured',
];

// Voucher types that *normally* book GST without a purchase/expense line — we
// don't want them showing up as orphan GST. Kept here for future Orphan-GST
// query (Stage 5); not used in the ITC register itself.
export const SKIP_ORPHAN_TYPES = new Set([
  'sales', 'interstate sales', 'domestic sales', 'receipt', 'contra',
  'purchase order', 'purchase order (import)',
  'delivery note', 'sales order',
  'job work in order', 'job work out order',
]);

// Voucher types we treat as "standard" for purchase ITC. Anything else gets
// a Review flag so the auditor can sanity-check oddly-routed entries.
const STANDARD_VOUCHER_TYPES = new Set([
  'purchase', 'journal', 'journal-1', 'journal-2',
  'debit note', 'payment', 'receipt', 'credit note',
]);

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const monthNameOf = (iso: string): string => {
  if (!iso || iso.length < 7) return '';
  const m = Number(iso.slice(5, 7));
  return MONTH_NAMES[m - 1] || '';
};

const fyLabelOf = (iso: string): string => {
  if (!iso || iso.length < 7) return '';
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return '';
  return m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
};

const containsAny = (haystack: string, needles: string[]): boolean => {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n));
};

const classifyGstType = (name: string, dutyHead: string): 'IGST' | 'CGST' | 'SGST' | 'OTHER_GST' => {
  const dh = (dutyHead || '').toUpperCase();
  if (dh) {
    if (dh.includes('IGST')) return 'IGST';
    if (dh.includes('CGST')) return 'CGST';
    if (dh.includes('SGST') || dh.includes('UTGST')) return 'SGST';
  }
  const n = (name || '').toUpperCase();
  if (n.includes('IGST')) return 'IGST';
  if (n.includes('CGST')) return 'CGST';
  if (n.includes('SGST') || n.includes('UTGST')) return 'SGST';
  return 'OTHER_GST';
};

// "input GST ledger" gate from the Python — parent group has to be GST or
// (Duties & Taxes with a duty_head populated), AND name must not contain any
// output-tax keyword. Returns true for both regular and RCM input ledgers.
const isInputGstLedger = (ledger: Ledger): boolean => {
  const parent = ledger.parent || '';
  if (parent === 'GST') {
    // ok
  } else if (parent === 'Duties & Taxes' && (ledger.gst_duty_head || '').trim()) {
    // ok
  } else {
    return false;
  }
  return !containsAny(ledger.name || '', OUTPUT_GST_KEYWORDS);
};

const isRcmLedger = (name: string): boolean => (name || '').toUpperCase().includes('RCM');
const isRcmPayableLedger = (name: string): boolean => {
  const n = (name || '').toUpperCase();
  return n.includes('RCM') && n.includes('PAYABLE');
};

// 15-char GSTIN format check. Used by the Issues panel — accepts the
// official pattern: 2-digit state, 5-letter PAN-block, 4 digits, 1 letter,
// 1 alphanumeric, fixed Z, 1 alphanumeric.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const isValidGstin = (raw: string): boolean => {
  if (!raw) return false;
  return GSTIN_RE.test(String(raw).trim().toUpperCase());
};

// ── Row type ────────────────────────────────────────────────────────────────
//
// One row per eligible voucher — matches the columns of the Python ITC sheet
// 1:1 so the Excel export can dump straight into a workbook.

export type ItcType = 'B2B' | 'RCM-UR' | 'IMPORTSERVICE';

export interface ItcRow {
  partyGstinUin: string;
  partyName: string;
  vchNo: string;            // supplier invoice no. (reference_number preferred, else voucher_number)
  date: string;             // invoice date (reference_date preferred, else voucher date) — ISO
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  tax: number;
  placeOfSupply: string;
  reverseCharge: 'Y' | 'N';
  itcAvailability: 'Y' | 'N';
  type: ItcType;
  m3b: string;              // 3B Month — same as Books Month unless adjusted later
  booksMonth: string;
  fy: string;
  postingDate: string;      // voucher date (ISO)
  expenseLedgers: string;   // comma-separated, in voucher line order, deduped
  voucherType: string;
  voucherNumber: string;
  primaryGroup: string;     // most common primary group among expense lines
  itcType: 'Inputs' | 'Input Services' | 'Capital Goods' | '';
  narration: string;
  reviewFlag: 'Yes' | '';
  guid: string;
}

export interface ItcQueryOpts {
  dateFrom?: string;        // ISO, inclusive
  dateTo?: string;          // ISO, inclusive
  gstInputLedgers?: string[];  // extra ledger names to treat as GST input (supplements auto-detection)
  gstLedgerOverride?: string[]; // authoritative GST-input set — when present, EXACTLY these
                                // ledgers are treated as input GST (auto-detection ignored).
                                // Lets the UI both add missed ledgers and exclude auto-picked ones.
}

// ── Per-line annotation ────────────────────────────────────────────────────
//
// One pass over trn_accounting builds the same enrichment the Python
// annotate_lines() does: primary group via parent-chain walk, GST input
// flag, RCM flag, GST sub-type (IGST/CGST/SGST). All lookups go through
// the store's prebuilt indexes so this stays O(N) over accounting lines.

interface AnnotatedLine {
  guid: string;
  ledger: string;
  amount: number;
  primary: string | null;           // one of TARGET_PRIMARIES, or null
  isGst: boolean;
  isRcm: boolean;
  isRcmPayable: boolean;
  gstType: 'IGST' | 'CGST' | 'SGST' | 'OTHER_GST' | null;
}

const annotateLines = (store: TallyStore, extraGstNames?: Set<string>, overrideSet?: Set<string>): AnnotatedLine[] => {
  const out: AnnotatedLine[] = [];
  for (const line of store.accountingLines) {
    const ledger = store.ledger(line.ledger);
    if (!ledger) {
      // Unknown ledger — push a stub so totals stay reconcilable. Won't be
      // eligible for any classification.
      out.push({
        guid: line.guid, ledger: line.ledger, amount: line.amount,
        primary: null, isGst: false, isRcm: false, isRcmPayable: false, gstType: null,
      });
      continue;
    }
    // When the UI supplies an explicit override set, it is authoritative —
    // a ledger counts as input GST iff it's in that set. Otherwise fall back
    // to auto-detection plus any extra ledgers the user added.
    const isGst = overrideSet
      ? overrideSet.has(nameKey(ledger.name))
      : (isInputGstLedger(ledger) || (extraGstNames != null && extraGstNames.has(nameKey(ledger.name))));
    const isRcm = isGst && isRcmLedger(ledger.name);
    const isRcmPayable = isRcm && isRcmPayableLedger(ledger.name);
    const gstType = isGst ? classifyGstType(ledger.name, ledger.gst_duty_head) : null;

    // Walk parent chain via the store's groups Map. primaryGroupFor()
    // returns the ledger's direct group's primary_group — which is what we
    // want for top-level primary classification.
    const primaryRaw = store.primaryGroupFor(ledger.name);
    const primary = TARGET_PRIMARIES.has(primaryRaw) ? primaryRaw : null;

    out.push({
      guid: line.guid,
      ledger: line.ledger,
      amount: line.amount,
      primary,
      isGst,
      isRcm,
      isRcmPayable,
      gstType,
    });
  }
  return out;
};

// Resolve annotated lines honouring the query's GST-ledger options (explicit
// override wins; else auto-detection + extra-added ledgers).
const annotateFor = (store: TallyStore, opts: ItcQueryOpts): AnnotatedLine[] => {
  const extra = opts.gstInputLedgers?.length ? new Set(opts.gstInputLedgers.map(nameKey)) : undefined;
  const override = opts.gstLedgerOverride?.length ? new Set(opts.gstLedgerOverride.map(nameKey)) : undefined;
  return annotateLines(store, extra, override);
};

// ── Main query ──────────────────────────────────────────────────────────────

export const getPurchaseITCRegister = (
  store: TallyStore,
  opts: ItcQueryOpts = {},
): ItcRow[] => {
  const { dateFrom, dateTo } = opts;
  const annotated = annotateFor(store, opts);

  // Group annotated lines by voucher guid for O(1) lookup
  const linesByGuid = new Map<string, AnnotatedLine[]>();
  for (const a of annotated) {
    const list = linesByGuid.get(a.guid);
    if (list) list.push(a); else linesByGuid.set(a.guid, [a]);
  }

  // GUIDs of vouchers with at least one eligible expense/purchase/FA line
  const eligibleGuids = new Set<string>();
  for (const [guid, lines] of linesByGuid.entries()) {
    if (lines.some((l) => l.primary != null)) eligibleGuids.add(guid);
  }

  const out: ItcRow[] = [];

  for (const voucher of store.vouchers.values()) {
    if (!voucher.is_accounting_voucher) continue;
    if (!eligibleGuids.has(voucher.guid)) continue;
    if (dateFrom && voucher.date && voucher.date < dateFrom) continue;
    if (dateTo && voucher.date && voucher.date > dateTo) continue;

    const lines = linesByGuid.get(voucher.guid) || [];
    const gstLines = lines.filter((l) => l.isGst && !l.isRcm);
    const rcmInputs = lines.filter((l) => l.isRcm && !l.isRcmPayable);
    const expLines = lines.filter((l) => l.primary != null);

    const sumOfType = (rows: AnnotatedLine[], kind: 'IGST' | 'CGST' | 'SGST') =>
      Math.abs(rows.filter((l) => l.gstType === kind).reduce((s, l) => s + l.amount, 0));

    const igst = sumOfType(gstLines, 'IGST') + sumOfType(rcmInputs, 'IGST');
    const cgst = sumOfType(gstLines, 'CGST') + sumOfType(rcmInputs, 'CGST');
    const sgst = sumOfType(gstLines, 'SGST') + sumOfType(rcmInputs, 'SGST');
    const tax = igst + cgst + sgst;

    const taxable = Math.abs(expLines.reduce((s, l) => s + l.amount, 0));

    // Deduped expense-ledger list in source order
    const seen = new Set<string>();
    const expLedgerNames: string[] = [];
    for (const l of expLines) {
      if (l.ledger && !seen.has(l.ledger)) {
        seen.add(l.ledger);
        expLedgerNames.push(l.ledger);
      }
    }

    // Primary group = mode of expense lines' primaries
    const primaryCounts = new Map<string, number>();
    for (const l of expLines) if (l.primary) primaryCounts.set(l.primary, (primaryCounts.get(l.primary) || 0) + 1);
    let primaryGroup = '';
    let bestCount = 0;
    for (const [k, v] of primaryCounts.entries()) {
      if (v > bestCount) { primaryGroup = k; bestCount = v; }
    }

    const partyLedger = store.ledger(voucher.party_name);
    const partyGstin = partyLedger?.gstn || '';

    const hasRcm = lines.some((l) => l.isRcm);
    let type: ItcType;
    if (hasRcm) type = 'RCM-UR';
    else if (!partyGstin && igst > 0 && cgst === 0) type = 'IMPORTSERVICE';
    else type = 'B2B';

    const invoiceNo = (voucher.reference_number || voucher.voucher_number || '').trim();
    const invoiceDate = voucher.reference_date || voucher.date;
    const booksMonth = monthNameOf(voucher.date);
    const vt = (voucher.voucher_type || '').toLowerCase();

    out.push({
      partyGstinUin: partyGstin,
      partyName: voucher.party_name || '',
      vchNo: invoiceNo,
      date: invoiceDate,
      taxable: Math.round(taxable * 100) / 100,
      igst: Math.round(igst * 100) / 100,
      cgst: Math.round(cgst * 100) / 100,
      sgst: Math.round(sgst * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      placeOfSupply: voucher.place_of_supply || '',
      reverseCharge: hasRcm ? 'Y' : 'N',
      itcAvailability: 'Y',
      type,
      m3b: booksMonth,
      booksMonth,
      fy: fyLabelOf(voucher.date),
      postingDate: voucher.date,
      expenseLedgers: expLedgerNames.join(', '),
      voucherType: voucher.voucher_type || '',
      voucherNumber: voucher.voucher_number || '',
      primaryGroup,
      itcType: primaryGroup ? (ITC_TYPE_MAP[primaryGroup] || '') : '',
      narration: voucher.narration || '',
      reviewFlag: STANDARD_VOUCHER_TYPES.has(vt) ? '' : 'Yes',
      guid: voucher.guid,
    });
  }

  out.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.voucherNumber.localeCompare(b.voucherNumber);
  });

  return out;
};

// ── Issues (derived from the ITC register) ──────────────────────────────────

export interface ItcIssues {
  rcmReview: ItcRow[];          // Tax === 0 → check whether RCM should apply
  cgstSgstMismatch: ItcRow[];   // |CGST - SGST| > 0.005 → data entry error
  blankInvalidGstin: ItcRow[];  // Tax > 0 AND GSTIN blank/invalid → ITC at risk under Rule 36
  noInvoiceNumber: ItcRow[];    // Tax > 0 AND vchNo blank → mandatory under Rule 36(4)
}

export const deriveItcIssues = (rows: ItcRow[]): ItcIssues => {
  const rcmReview: ItcRow[] = [];
  const cgstSgstMismatch: ItcRow[] = [];
  const blankInvalidGstin: ItcRow[] = [];
  const noInvoiceNumber: ItcRow[] = [];

  for (const r of rows) {
    if (r.tax === 0) rcmReview.push(r);
    if (Math.abs(r.cgst - r.sgst) > 0.005) cgstSgstMismatch.push(r);
    if (r.tax > 0 && !isValidGstin(r.partyGstinUin)) blankInvalidGstin.push(r);
    if (r.tax > 0 && !r.vchNo.trim()) noInvoiceNumber.push(r);
  }

  return { rcmReview, cgstSgstMismatch, blankInvalidGstin, noInvoiceNumber };
};

// ── ITC Summary ─────────────────────────────────────────────────────────────

export interface ItcSummaryRow {
  month: string;           // 'January', 'February', …, or 'Section Total' / 'BLOCK GRAND TOTAL'
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  tax: number;
  count: number;
  isTotal: boolean;
  isGrandTotal: boolean;
}

export interface ItcSummarySection {
  block: 'Books Month' | '3B Month';
  type: ItcType;
  rows: ItcSummaryRow[];   // month rows + Section Total + BLOCK GRAND TOTAL
}

const sumItcRows = (rows: ItcRow[]): Omit<ItcSummaryRow, 'month' | 'isTotal' | 'isGrandTotal'> => {
  let taxable = 0, igst = 0, cgst = 0, sgst = 0, tax = 0;
  for (const r of rows) { taxable += r.taxable; igst += r.igst; cgst += r.cgst; sgst += r.sgst; tax += r.tax; }
  return { taxable: Math.round(taxable * 100) / 100, igst: Math.round(igst * 100) / 100, cgst: Math.round(cgst * 100) / 100, sgst: Math.round(sgst * 100) / 100, tax: Math.round(tax * 100) / 100, count: rows.length };
};

export const buildItcSummary = (rows: ItcRow[]): ItcSummarySection[] => {
  const types: ItcType[] = ['B2B', 'RCM-UR', 'IMPORTSERVICE'];
  const blocks: Array<{ block: 'Books Month' | '3B Month'; key: 'booksMonth' | 'm3b' }> = [
    { block: 'Books Month', key: 'booksMonth' },
    { block: '3B Month',    key: 'm3b' },
  ];

  const out: ItcSummarySection[] = [];

  for (const { block, key } of blocks) {
    const blockRows: ItcSummaryRow[] = [];
    for (const type of types) {
      const typed = rows.filter((r) => r.type === type);
      const byMonth = new Map<string, ItcRow[]>();
      for (const r of typed) {
        const m = r[key];
        const list = byMonth.get(m); if (list) list.push(r); else byMonth.set(m, [r]);
      }
      const monthOrder = MONTH_NAMES.filter((m) => byMonth.has(m));
      const sectionRows: ItcSummaryRow[] = [];
      for (const m of monthOrder) {
        const s = sumItcRows(byMonth.get(m)!);
        sectionRows.push({ month: m, ...s, isTotal: false, isGrandTotal: false });
      }
      const sectionTotal = sumItcRows(typed);
      sectionRows.push({ month: 'Section Total', ...sectionTotal, isTotal: true, isGrandTotal: false });

      out.push({ block, type, rows: sectionRows });
      blockRows.push(...sectionRows);
    }
    // BLOCK GRAND TOTAL across all types for this block
    const blockData = rows;
    const gt = sumItcRows(blockData);
    const lastSection = out[out.length - 1];
    lastSection.rows.push({ month: 'BLOCK GRAND TOTAL', ...gt, isTotal: false, isGrandTotal: true });
  }

  return out;
};

// ── GL Control ───────────────────────────────────────────────────────────────

export interface GlControlRow {
  primaryGroup: string;
  glVouchers: number;
  glTaxable: number;
  itcVouchers: number;
  itcTaxable: number;
  itcIgst: number;
  itcCgst: number;
  itcSgst: number;
  itcTotalGst: number;
  noGstVouchers: number;
  noGstTaxable: number;
  itcCoverage: number;   // percentage
  isGrandTotal: boolean;
}

export const buildGLControl = (store: TallyStore, opts: ItcQueryOpts = {}): GlControlRow[] => {
  const { dateFrom, dateTo } = opts;
  const annotated = annotateFor(store, opts);
  const linesByGuid = new Map<string, AnnotatedLine[]>();
  for (const a of annotated) {
    const list = linesByGuid.get(a.guid); if (list) list.push(a); else linesByGuid.set(a.guid, [a]);
  }

  // Per primary group accumulators
  const acc = new Map<string, {
    glVouchers: Set<string>; glTaxable: number;
    itcVouchers: Set<string>; itcTaxable: number;
    itcIgst: number; itcCgst: number; itcSgst: number;
    noGstVouchers: Set<string>; noGstTaxable: number;
  }>();

  const ensure = (pg: string) => {
    if (!acc.has(pg)) acc.set(pg, {
      glVouchers: new Set(), glTaxable: 0,
      itcVouchers: new Set(), itcTaxable: 0,
      itcIgst: 0, itcCgst: 0, itcSgst: 0,
      noGstVouchers: new Set(), noGstTaxable: 0,
    });
    return acc.get(pg)!;
  };

  for (const voucher of store.vouchers.values()) {
    if (!voucher.is_accounting_voucher) continue;
    if (dateFrom && voucher.date && voucher.date < dateFrom) continue;
    if (dateTo && voucher.date && voucher.date > dateTo) continue;

    const lines = linesByGuid.get(voucher.guid) || [];
    const expLines = lines.filter((l) => l.primary != null);
    if (expLines.length === 0) continue;

    // Primary group = mode of expense lines
    const primaryCounts = new Map<string, number>();
    for (const l of expLines) if (l.primary) primaryCounts.set(l.primary, (primaryCounts.get(l.primary) || 0) + 1);
    let primaryGroup = ''; let bestCount = 0;
    for (const [k, v] of primaryCounts.entries()) { if (v > bestCount) { primaryGroup = k; bestCount = v; } }
    if (!primaryGroup) continue;

    const a = ensure(primaryGroup);
    const taxable = Math.abs(expLines.reduce((s, l) => s + l.amount, 0));
    a.glVouchers.add(voucher.guid);
    a.glTaxable += taxable;

    const gstLines = lines.filter((l) => l.isGst && !l.isRcm);
    const rcmInputs = lines.filter((l) => l.isRcm && !l.isRcmPayable);
    const allGstLines = [...gstLines, ...rcmInputs];
    const igst = Math.abs(allGstLines.filter((l) => l.gstType === 'IGST').reduce((s, l) => s + l.amount, 0));
    const cgst = Math.abs(allGstLines.filter((l) => l.gstType === 'CGST').reduce((s, l) => s + l.amount, 0));
    const sgst = Math.abs(allGstLines.filter((l) => l.gstType === 'SGST').reduce((s, l) => s + l.amount, 0));

    if (igst + cgst + sgst > 0) {
      a.itcVouchers.add(voucher.guid);
      a.itcTaxable += taxable;
      a.itcIgst += igst; a.itcCgst += cgst; a.itcSgst += sgst;
    } else {
      a.noGstVouchers.add(voucher.guid);
      a.noGstTaxable += taxable;
    }
  }

  const out: GlControlRow[] = [];
  let gtGlV = 0, gtGlT = 0, gtItcV = 0, gtItcT = 0, gtIgst = 0, gtCgst = 0, gtSgst = 0, gtNoV = 0, gtNoT = 0;

  for (const pg of TARGET_PRIMARIES) {
    const a = acc.get(pg);
    if (!a) continue;
    const r2 = Math.round;
    const totalGst = r2((a.itcIgst + a.itcCgst + a.itcSgst) * 100) / 100;
    const coverage = a.glTaxable > 0 ? Math.round((a.itcTaxable / a.glTaxable) * 10000) / 100 : 0;
    out.push({
      primaryGroup: pg,
      glVouchers: a.glVouchers.size,
      glTaxable: r2(a.glTaxable * 100) / 100,
      itcVouchers: a.itcVouchers.size,
      itcTaxable: r2(a.itcTaxable * 100) / 100,
      itcIgst: r2(a.itcIgst * 100) / 100,
      itcCgst: r2(a.itcCgst * 100) / 100,
      itcSgst: r2(a.itcSgst * 100) / 100,
      itcTotalGst: totalGst,
      noGstVouchers: a.noGstVouchers.size,
      noGstTaxable: r2(a.noGstTaxable * 100) / 100,
      itcCoverage: coverage,
      isGrandTotal: false,
    });
    gtGlV += a.glVouchers.size; gtGlT += a.glTaxable;
    gtItcV += a.itcVouchers.size; gtItcT += a.itcTaxable;
    gtIgst += a.itcIgst; gtCgst += a.itcCgst; gtSgst += a.itcSgst;
    gtNoV += a.noGstVouchers.size; gtNoT += a.noGstTaxable;
  }

  const r2 = Math.round;
  out.push({
    primaryGroup: 'GRAND TOTAL',
    glVouchers: gtGlV, glTaxable: r2(gtGlT * 100) / 100,
    itcVouchers: gtItcV, itcTaxable: r2(gtItcT * 100) / 100,
    itcIgst: r2(gtIgst * 100) / 100, itcCgst: r2(gtCgst * 100) / 100, itcSgst: r2(gtSgst * 100) / 100,
    itcTotalGst: r2((gtIgst + gtCgst + gtSgst) * 100) / 100,
    noGstVouchers: gtNoV, noGstTaxable: r2(gtNoT * 100) / 100,
    itcCoverage: gtGlT > 0 ? Math.round((gtItcT / gtGlT) * 10000) / 100 : 0,
    isGrandTotal: true,
  });

  return out;
};

// ── Orphan GST ───────────────────────────────────────────────────────────────

export interface OrphanGstRow {
  date: string;
  voucherType: string;
  voucherNumber: string;
  invoiceNo: string;
  partyName: string;
  partyGstin: string;
  placeOfSupply: string;
  igst: number;
  cgst: number;
  sgst: number;
  totalGst: number;
  allLedgers: string;
  narration: string;
  issue: string;
}

export const buildOrphanGST = (store: TallyStore, opts: ItcQueryOpts = {}): OrphanGstRow[] => {
  const { dateFrom, dateTo } = opts;
  const annotated = annotateFor(store, opts);
  const linesByGuid = new Map<string, AnnotatedLine[]>();
  for (const a of annotated) {
    const list = linesByGuid.get(a.guid); if (list) list.push(a); else linesByGuid.set(a.guid, [a]);
  }

  const out: OrphanGstRow[] = [];

  for (const voucher of store.vouchers.values()) {
    if (!voucher.is_accounting_voucher) continue;
    const vt = (voucher.voucher_type || '').toLowerCase();
    if (SKIP_ORPHAN_TYPES.has(vt)) continue;
    if (dateFrom && voucher.date && voucher.date < dateFrom) continue;
    if (dateTo && voucher.date && voucher.date > dateTo) continue;

    const lines = linesByGuid.get(voucher.guid) || [];
    const hasExpense = lines.some((l) => l.primary != null);
    if (hasExpense) continue;   // normal ITC voucher, not orphan

    const gstLines = lines.filter((l) => l.isGst && !l.isRcm);
    const rcmInputs = lines.filter((l) => l.isRcm && !l.isRcmPayable);
    const allGst = [...gstLines, ...rcmInputs];
    if (allGst.length === 0) continue;  // no GST at all

    const igst = Math.abs(allGst.filter((l) => l.gstType === 'IGST').reduce((s, l) => s + l.amount, 0));
    const cgst = Math.abs(allGst.filter((l) => l.gstType === 'CGST').reduce((s, l) => s + l.amount, 0));
    const sgst = Math.abs(allGst.filter((l) => l.gstType === 'SGST').reduce((s, l) => s + l.amount, 0));
    const totalGst = igst + cgst + sgst;
    if (totalGst === 0) continue;

    const partyLedger = store.ledger(voucher.party_name);
    const allLedgerNames = [...new Set(lines.map((l) => l.ledger).filter(Boolean))].join(', ');

    const issues: string[] = [];
    if (!isValidGstin(partyLedger?.gstn || '')) issues.push('Blank/Invalid GSTIN');
    if (!(voucher.reference_number || voucher.voucher_number || '').trim()) issues.push('No Invoice No.');
    if (Math.abs(cgst - sgst) > 0.005) issues.push('CGST≠SGST');

    out.push({
      date: voucher.date,
      voucherType: voucher.voucher_type || '',
      voucherNumber: voucher.voucher_number || '',
      invoiceNo: (voucher.reference_number || voucher.voucher_number || '').trim(),
      partyName: voucher.party_name || '',
      partyGstin: partyLedger?.gstn || '',
      placeOfSupply: voucher.place_of_supply || '',
      igst: Math.round(igst * 100) / 100,
      cgst: Math.round(cgst * 100) / 100,
      sgst: Math.round(sgst * 100) / 100,
      totalGst: Math.round(totalGst * 100) / 100,
      allLedgers: allLedgerNames,
      narration: voucher.narration || '',
      issue: issues.join('; '),
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
};

// ── Ledger Audit ─────────────────────────────────────────────────────────────
//
// Self-documents which ledgers are in scope as GST *input*. Mirrors the Python
// build_ledger_audit() exactly so the Excel sheet reconciles 1:1:
//   • Only candidate ledgers are considered — parent = 'GST', or parent =
//     'Duties & Taxes' with a duty_head. Everything else is skipped UNLESS the
//     name carries a GST keyword (then it's flagged 'Potential Miss').
//   • Expense ledgers are NOT audited here — this sheet is GST-input only.

export type LedgerAuditCategory = 'Selected' | 'Excluded' | 'Potential Miss';

// Keywords that suggest a ledger might be a GST input even outside the standard
// 'GST' / 'Duties & Taxes' groups. Mirrors Python _POTENTIAL_MISS_KEYWORDS.
const POTENTIAL_MISS_KEYWORDS = [
  'igst', 'cgst', 'sgst', 'utgst', 'gst input', 'input tax credit', 'itc',
];

export interface LedgerAuditRow {
  ledgerName: string;
  parentGroup: string;
  primaryGroup: string;       // kept for the in-app picker; not in the Excel sheet
  gstDutyHead: string;
  category: LedgerAuditCategory;
  reason: string;             // Exclusion / Note
  gstComponent: '' | 'IGST' | 'CGST' | 'SGST' | 'OTHER_GST';
  isRcmInput: 'Yes' | '';
  isRcmPayable: 'Yes' | '';
  firedInPeriod: 'Yes' | '';
  ledgerGstin: string;
  gstRegType: string;
}

export const buildLedgerAudit = (store: TallyStore, opts: ItcQueryOpts = {}): LedgerAuditRow[] => {
  const { dateFrom, dateTo } = opts;

  // "Fired in Period" = ledger appeared in an accounting line whose voucher
  // falls inside the date window. Build the set once.
  const guidDate = new Map<string, string>();
  for (const v of store.vouchers.values()) guidDate.set(v.guid, v.date || '');
  const fired = new Set<string>();
  for (const line of store.accountingLines) {
    const d = guidDate.get(line.guid) || '';
    if (dateFrom && d && d < dateFrom) continue;
    if (dateTo && d && d > dateTo) continue;
    if (line.ledger) fired.add(line.ledger);
  }

  const out: LedgerAuditRow[] = [];

  for (const ledger of store.ledgers.values()) {
    const name = ledger.name || '';
    const parent = ledger.parent || '';
    const dutyHead = (ledger.gst_duty_head || '').trim();

    // Candidate gate — same as isInputGstLedger's group test (direct parent).
    const isGstGroup = parent === 'GST';
    const isDutiesWithHead = parent === 'Duties & Taxes' && !!dutyHead;
    const isCandidate = isGstGroup || isDutiesWithHead;

    const nameLower = name.toLowerCase();

    let category: LedgerAuditCategory;
    let reason: string;

    if (isCandidate) {
      const outputHit = OUTPUT_GST_KEYWORDS.find((kw) => nameLower.includes(kw));
      if (outputHit) {
        category = 'Excluded';
        reason = `Output keyword matched: '${outputHit}'`;
      } else {
        category = 'Selected';
        reason = '';
      }
    } else {
      const hasGstKw = POTENTIAL_MISS_KEYWORDS.some((kw) => nameLower.includes(kw));
      if (!hasGstKw) continue; // unrelated ledger — skip, exactly like Python
      category = 'Potential Miss';
      reason = `Name contains GST keyword but parent group is '${parent}' `
        + `(not 'GST'/'Duties & Taxes') — confirm whether this is an input ledger`;
    }

    // Component + RCM flags are meaningful only for Selected ledgers.
    const selected = category === 'Selected';
    const gstComponent = selected ? classifyGstType(name, ledger.gst_duty_head) : '';
    const isRcmInput: 'Yes' | '' = selected && isRcmLedger(name) ? 'Yes' : '';
    const isRcmPayable: 'Yes' | '' = selected && isRcmPayableLedger(name) ? 'Yes' : '';

    out.push({
      ledgerName: name,
      parentGroup: parent,
      primaryGroup: store.primaryGroupFor(name),
      gstDutyHead: dutyHead,
      category,
      reason,
      gstComponent,
      isRcmInput,
      isRcmPayable,
      firedInPeriod: fired.has(name) ? 'Yes' : '',
      ledgerGstin: ledger.gstn || '',
      gstRegType: ledger.gst_registration_type || '',
    });
  }

  out.sort((a, b) => {
    const order: Record<LedgerAuditCategory, number> = { 'Selected': 0, 'Excluded': 1, 'Potential Miss': 2 };
    const diff = order[a.category] - order[b.category];
    if (diff !== 0) return diff;
    return a.ledgerName.localeCompare(b.ledgerName);
  });

  return out;
};

// ── Available periods ─────────────────────────────────────────────────────────
//
// Distinct YYYY-MM months present in the store's vouchers, in chronological
// (= fiscal, Apr→Mar) order. Drives the in-app period dropdown.

export interface PeriodOption {
  key: string;    // 'YYYY-MM'
  label: string;  // 'April 2025'
  from: string;   // 'YYYY-MM-01'
  to: string;     // 'YYYY-MM-<last>'
}

export const availablePeriods = (store: TallyStore): PeriodOption[] => {
  const set = new Set<string>();
  for (const v of store.vouchers.values()) {
    if (v.date && v.date.length >= 7) set.add(v.date.slice(0, 7));
  }
  return [...set].sort().map((k) => {
    const y = Number(k.slice(0, 4));
    const m = Number(k.slice(5, 7));
    const last = new Date(y, m, 0).getDate();
    return { key: k, label: `${MONTH_NAMES[m - 1]} ${y}`, from: `${k}-01`, to: `${k}-${String(last).padStart(2, '0')}` };
  });
};

// ── Input-GST ledger movement / reconciliation ────────────────────────────────
//
// The ITC register only captures GST from EXPENSE vouchers. The same input-GST
// ledgers (IGST/CGST/SGST/RCM-input) also move through payments, set-offs,
// journals and ITC reversals. This view shows, per input ledger, the full
// Opening → movement → Closing reconciliation, splitting movement into the part
// captured in the ITC register vs. everything else — plus a tagged line-level
// detail of every voucher that touched an input ledger.
//
// Balances are shown Debit-positive (input GST is an asset). Tally stores debit
// balances as negative, so the display value is the negated signed balance.

export interface LedgerMovementSummary {
  ledgerName: string;
  component: '' | 'IGST' | 'CGST' | 'SGST' | 'OTHER_GST';
  isRcm: boolean;
  opening: number;        // Dr-positive
  itcDr: number; itcCr: number;       // movement via ITC-register (expense) vouchers
  otherDr: number; otherCr: number;   // movement via payment/journal/adjustment vouchers
  totalDr: number; totalCr: number;
  closing: number;        // computed Dr-positive (opening + movement)
  closingBooks: number;   // ledger's stored closing (Dr-positive) — exact only for full period
  recoDelta: number;      // closing − closingBooks
  isTotal: boolean;
}

export interface LedgerMovementLine {
  ledgerName: string;
  component: string;
  date: string;
  voucherType: string;
  voucherNumber: string;
  party: string;
  debit: number;
  credit: number;
  bucket: 'ITC' | 'Other';
  narration: string;
}

export interface InputLedgerMovement {
  summary: LedgerMovementSummary[];
  lines: LedgerMovementLine[];
  fullPeriod: boolean;    // no date filter → the closingBooks reconciliation is exact
}

export const buildInputLedgerMovement = (store: TallyStore, opts: ItcQueryOpts = {}): InputLedgerMovement => {
  const { dateFrom, dateTo } = opts;
  const annotated = annotateFor(store, opts);

  // Eligible ITC vouchers = accounting voucher, in-window, with an expense line.
  const linesByGuid = new Map<string, AnnotatedLine[]>();
  for (const a of annotated) { const l = linesByGuid.get(a.guid); if (l) l.push(a); else linesByGuid.set(a.guid, [a]); }
  const eligibleGuids = new Set<string>();
  for (const v of store.vouchers.values()) {
    if (!v.is_accounting_voucher) continue;
    if (dateFrom && v.date && v.date < dateFrom) continue;
    if (dateTo && v.date && v.date > dateTo) continue;
    const ls = linesByGuid.get(v.guid);
    if (ls && ls.some((l) => l.primary != null)) eligibleGuids.add(v.guid);
  }

  interface Acc {
    component: AnnotatedLine['gstType']; isRcm: boolean;
    preSigned: number; periodSigned: number;
    itcDr: number; itcCr: number; otherDr: number; otherCr: number;
  }
  const acc = new Map<string, Acc>();
  const lines: LedgerMovementLine[] = [];

  for (const a of annotated) {
    if (!a.isGst || a.isRcmPayable) continue;   // input ledgers only (drop RCM payable liability)
    const led = store.ledger(a.ledger);
    const ledgerName = led?.name || a.ledger;
    const v = store.vouchers.get(a.guid);
    const vdate = v?.date || '';

    let e = acc.get(ledgerName);
    if (!e) { e = { component: a.gstType, isRcm: false, preSigned: 0, periodSigned: 0, itcDr: 0, itcCr: 0, otherDr: 0, otherCr: 0 }; acc.set(ledgerName, e); }
    if (a.gstType && (!e.component || e.component === 'OTHER_GST')) e.component = a.gstType;
    if (a.isRcm) e.isRcm = true;

    if (dateFrom && vdate && vdate < dateFrom) { e.preSigned += a.amount; continue; } // pre-window → opening
    if (dateTo && vdate && vdate > dateTo) continue;                                   // after window → ignore

    e.periodSigned += a.amount;
    const dr = a.amount < 0 ? -a.amount : 0;
    const cr = a.amount > 0 ? a.amount : 0;
    const isItc = eligibleGuids.has(a.guid);
    if (isItc) { e.itcDr += dr; e.itcCr += cr; } else { e.otherDr += dr; e.otherCr += cr; }

    lines.push({
      ledgerName, component: a.gstType || '',
      date: vdate, voucherType: v?.voucher_type || '', voucherNumber: v?.voucher_number || '',
      party: v?.party_name || '',
      debit: Math.round(dr * 100) / 100, credit: Math.round(cr * 100) / 100,
      bucket: isItc ? 'ITC' : 'Other', narration: v?.narration || '',
    });
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const summary: LedgerMovementSummary[] = [];
  let tOpen = 0, tItcDr = 0, tItcCr = 0, tOthDr = 0, tOthCr = 0, tClose = 0, tBooks = 0;

  for (const name of [...acc.keys()].sort((a, b) => a.localeCompare(b))) {
    const e = acc.get(name)!;
    const led = store.ledger(name);
    const openSigned = (led?.opening_balance || 0) + e.preSigned;
    const closeSigned = openSigned + e.periodSigned;
    const openDisp = -openSigned;
    const closeDisp = -closeSigned;
    const closeBooksDisp = -(led?.closing_balance || 0);
    summary.push({
      ledgerName: name, component: e.component || '', isRcm: e.isRcm,
      opening: r2(openDisp), itcDr: r2(e.itcDr), itcCr: r2(e.itcCr),
      otherDr: r2(e.otherDr), otherCr: r2(e.otherCr),
      totalDr: r2(e.itcDr + e.otherDr), totalCr: r2(e.itcCr + e.otherCr),
      closing: r2(closeDisp), closingBooks: r2(closeBooksDisp),
      recoDelta: r2(closeDisp - closeBooksDisp), isTotal: false,
    });
    tOpen += openDisp; tItcDr += e.itcDr; tItcCr += e.itcCr; tOthDr += e.otherDr; tOthCr += e.otherCr;
    tClose += closeDisp; tBooks += closeBooksDisp;
  }
  if (summary.length) summary.push({
    ledgerName: 'TOTAL', component: '', isRcm: false,
    opening: r2(tOpen), itcDr: r2(tItcDr), itcCr: r2(tItcCr), otherDr: r2(tOthDr), otherCr: r2(tOthCr),
    totalDr: r2(tItcDr + tOthDr), totalCr: r2(tItcCr + tOthCr),
    closing: r2(tClose), closingBooks: r2(tBooks), recoDelta: r2(tClose - tBooks), isTotal: true,
  });

  lines.sort((a, b) => (a.ledgerName !== b.ledgerName ? a.ledgerName.localeCompare(b.ledgerName) : a.date.localeCompare(b.date)));
  return { summary, lines, fullPeriod: !dateFrom && !dateTo };
};

// Date range helper for components that have a month-filtered LedgerEntry[]
// and want to ask the query for "just those months".
export const dateRangeOf = (rows: { date: string }[]): { dateFrom: string; dateTo: string } => {
  let dateFrom = '';
  let dateTo = '';
  for (const r of rows) {
    if (!r.date) continue;
    if (!dateFrom || r.date < dateFrom) dateFrom = r.date;
    if (!dateTo || r.date > dateTo) dateTo = r.date;
  }
  return { dateFrom, dateTo };
};

// ─────────────────────────────────────────────────────────────────────────────
// Trial Balance — store-driven
// ─────────────────────────────────────────────────────────────────────────────
//
// One walk over mst_group, mst_ledger and trn_accounting builds:
//   • A full recursive group tree (Sections 1+2)
//   • Per-ledger reconciliation: opening + during net vs master closing (Section 3)
//   • Activity classification: dormant / active / new / closed (Section 4)
//   • Aggregated Dr/Cr totals at every node + grand totals + balance check
//
// Sign convention
// ----------------
// trn_accounting.amount keeps Tally's convention — *negative* means Dr,
// *positive* means Cr. mst_ledger.opening_balance / .closing_balance keep
// the same convention. We surface both signed and Dr/Cr-split views.

export type TbActivity = 'dormant' | 'active' | 'new' | 'closed' | 'never-used';

export interface TbDrCr {
  openingDr: number;
  openingCr: number;
  duringDr: number;
  duringCr: number;
  closingDr: number;
  closingCr: number;
}

export interface TbLedgerRow extends TbDrCr {
  ledger: string;
  group: string;                 // immediate parent group
  primaryGroup: string;          // top-level walked primary
  openingSigned: number;         // raw signed balance (Tally convention)
  duringNet: number;             // duringCr - duringDr
  closingSigned: number;
  closingCalculated: number;     // opening + duringNet
  reconDelta: number;            // closingCalculated - closingSigned (master)
  reconPass: boolean;
  activity: TbActivity;
  pan: string;
  gstin: string;
  mailingState: string;
  isRevenue: boolean;
  isReserved: boolean;
}

export interface TbGroupNode extends TbDrCr {
  name: string;                  // group name
  parent: string;                // group's parent (empty for primary)
  primaryGroup: string;
  level: number;                 // depth from root (0 = primary)
  isPrimary: boolean;
  isRevenue: boolean;
  isReserved: boolean;
  sortPosition: number;
  childGroups: TbGroupNode[];
  childLedgers: TbLedgerRow[];
  ledgerCount: number;           // including all descendant groups
}

export interface TbBalanceCheck {
  // Each pair must equal within `tolerance`. `delta` is signed
  // (positive = excess Dr, negative = excess Cr).
  opening: { dr: number; cr: number; delta: number; ok: boolean };
  during:  { dr: number; cr: number; delta: number; ok: boolean };
  closing: { dr: number; cr: number; delta: number; ok: boolean };
  tolerance: number;
}

export interface TbActivityCounts {
  dormant: number;
  active: number;
  new: number;
  closed: number;
  'never-used': number;
}

export interface TrialBalanceResult {
  tree: TbGroupNode[];                  // top-level (primary) group nodes
  flatLedgers: TbLedgerRow[];           // every ledger row, for table / search views
  reconciliationFailures: TbLedgerRow[]; // ledgers whose recon failed
  activityCounts: TbActivityCounts;
  balanceCheck: TbBalanceCheck;
  grandTotals: TbDrCr;
  periodFrom: string;                   // ISO, earliest voucher date
  periodTo: string;                     // ISO, latest voucher date
}

export interface TbOpts {
  // ISO date range; lines outside this window aren't counted in `during`
  // and don't affect the calculated closing. Default: all dates.
  dateFrom?: string;
  dateTo?: string;
  // Tolerance for "PASS" status — both the balance equation and per-ledger
  // reconciliation use this. Default: ₹0.50.
  tolerance?: number;
}

const splitSigned = (signed: number): { dr: number; cr: number } => ({
  dr: signed < 0 ? -signed : 0,
  cr: signed > 0 ? signed : 0,
});

const zeroDrCr = (): TbDrCr => ({
  openingDr: 0, openingCr: 0, duringDr: 0, duringCr: 0, closingDr: 0, closingCr: 0,
});

const addDrCr = (target: TbDrCr, source: TbDrCr): void => {
  target.openingDr += source.openingDr;
  target.openingCr += source.openingCr;
  target.duringDr  += source.duringDr;
  target.duringCr  += source.duringCr;
  target.closingDr += source.closingDr;
  target.closingCr += source.closingCr;
};

const classifyActivity = (
  opening: number,
  duringDr: number,
  duringCr: number,
  closing: number,
  tolerance: number,
): TbActivity => {
  const hasOpening = Math.abs(opening) > tolerance;
  const hasMovement = duringDr > tolerance || duringCr > tolerance;
  const hasClosing = Math.abs(closing) > tolerance;
  if (!hasOpening && !hasMovement && !hasClosing) return 'never-used';
  if (!hasOpening && hasMovement) return 'new';
  if (hasOpening && !hasMovement && hasClosing) return 'dormant';
  if (hasOpening && hasMovement && !hasClosing) return 'closed';
  return 'active';
};

export const getTrialBalance = (
  store: TallyStore,
  opts: TbOpts = {},
): TrialBalanceResult => {
  const tolerance = opts.tolerance ?? 0.5;
  const { dateFrom, dateTo } = opts;

  // ── Pass 1: aggregate transactional movement per ledger ──────────────────
  // Only accounting-voucher lines; date filter applied per voucher.
  const accByLedger = new Map<string, { dr: number; cr: number }>();
  let periodFrom = '';
  let periodTo = '';

  for (const line of store.accountingLines) {
    const v = store.voucher(line.guid);
    if (!v || !v.is_accounting_voucher) continue;
    if (dateFrom && v.date && v.date < dateFrom) continue;
    if (dateTo && v.date && v.date > dateTo) continue;

    const key = nameKey(line.ledger);
    let entry = accByLedger.get(key);
    if (!entry) { entry = { dr: 0, cr: 0 }; accByLedger.set(key, entry); }
    if (line.amount < 0) entry.dr += -line.amount;
    else if (line.amount > 0) entry.cr += line.amount;

    if (v.date) {
      if (!periodFrom || v.date < periodFrom) periodFrom = v.date;
      if (!periodTo || v.date > periodTo) periodTo = v.date;
    }
  }

  // ── Pass 2: build per-ledger TB rows ─────────────────────────────────────
  const flatLedgers: TbLedgerRow[] = [];
  for (const ledger of store.ledgers.values()) {
    const groupName = ledger.parent || '';
    const primary = store.primaryGroupFor(ledger.name);
    const movement = accByLedger.get(nameKey(ledger.name)) || { dr: 0, cr: 0 };

    const openingSigned = ledger.opening_balance || 0;
    const closingSigned = ledger.closing_balance || 0;
    const opening = splitSigned(openingSigned);
    const closing = splitSigned(closingSigned);
    const duringNet = movement.cr - movement.dr;
    const closingCalculated = openingSigned + duringNet;
    const reconDelta = closingCalculated - closingSigned;

    flatLedgers.push({
      ledger: ledger.name,
      group: groupName,
      primaryGroup: primary,
      openingDr: opening.dr, openingCr: opening.cr,
      duringDr: movement.dr, duringCr: movement.cr,
      closingDr: closing.dr, closingCr: closing.cr,
      openingSigned,
      duringNet,
      closingSigned,
      closingCalculated,
      reconDelta,
      reconPass: Math.abs(reconDelta) <= tolerance,
      activity: classifyActivity(openingSigned, movement.dr, movement.cr, closingSigned, tolerance),
      pan: ledger.it_pan || '',
      gstin: ledger.gstn || '',
      mailingState: ledger.mailing_state || '',
      isRevenue: ledger.is_revenue,
      isReserved: false,            // ledgers don't carry is_reserved; groups do
    });
  }

  // ── Pass 3: build group tree ──────────────────────────────────────────────
  // mst_group.parent forms a forest. Build child-by-parent index, walk
  // recursively. sort_position drives sibling ordering so output matches
  // Tally's Group of Groups view.
  const childGroupsByParent = new Map<string, string[]>();
  const rootNames: string[] = [];
  for (const g of store.groups.values()) {
    if (!g.parent) rootNames.push(g.name);
    else {
      const list = childGroupsByParent.get(nameKey(g.parent));
      if (list) list.push(g.name); else childGroupsByParent.set(nameKey(g.parent), [g.name]);
    }
  }

  const ledgersByGroup = new Map<string, TbLedgerRow[]>();
  for (const r of flatLedgers) {
    const k = nameKey(r.group);
    const list = ledgersByGroup.get(k);
    if (list) list.push(r); else ledgersByGroup.set(k, [r]);
  }

  const sortGroupsBy = (names: string[]): string[] =>
    names.slice().sort((a, b) => {
      const ga = store.group(a);
      const gb = store.group(b);
      const sa = ga?.sort_position ?? 9999;
      const sb = gb?.sort_position ?? 9999;
      if (sa !== sb) return sa - sb;
      return a.localeCompare(b);
    });

  const buildNode = (groupName: string, level: number, isPrimary: boolean): TbGroupNode => {
    const g = store.group(groupName);
    const node: TbGroupNode = {
      name: groupName,
      parent: g?.parent || '',
      primaryGroup: g?.primary_group || (isPrimary ? groupName : ''),
      level,
      isPrimary,
      isRevenue: g?.is_revenue ?? false,
      isReserved: g?.is_reserved ?? false,
      sortPosition: g?.sort_position ?? 9999,
      childGroups: [],
      childLedgers: (ledgersByGroup.get(nameKey(groupName)) || []).slice().sort((a, b) => a.ledger.localeCompare(b.ledger)),
      ledgerCount: 0,
      ...zeroDrCr(),
    };

    const childNames = sortGroupsBy(childGroupsByParent.get(nameKey(groupName)) || []);
    for (const childName of childNames) {
      node.childGroups.push(buildNode(childName, level + 1, false));
    }

    // Roll up Dr/Cr totals from ledger leaves + sub-group nodes
    for (const lr of node.childLedgers) addDrCr(node, lr);
    for (const sub of node.childGroups) addDrCr(node, sub);

    node.ledgerCount = node.childLedgers.length + node.childGroups.reduce((s, sg) => s + sg.ledgerCount, 0);
    return node;
  };

  const tree: TbGroupNode[] = sortGroupsBy(rootNames).map((name) => buildNode(name, 0, true));

  // ── Grand totals + balance check ─────────────────────────────────────────
  const grandTotals = zeroDrCr();
  for (const lr of flatLedgers) addDrCr(grandTotals, lr);

  const balanceCheck: TbBalanceCheck = {
    opening: {
      dr: grandTotals.openingDr,
      cr: grandTotals.openingCr,
      delta: grandTotals.openingDr - grandTotals.openingCr,
      ok: Math.abs(grandTotals.openingDr - grandTotals.openingCr) <= tolerance,
    },
    during: {
      dr: grandTotals.duringDr,
      cr: grandTotals.duringCr,
      delta: grandTotals.duringDr - grandTotals.duringCr,
      ok: Math.abs(grandTotals.duringDr - grandTotals.duringCr) <= tolerance,
    },
    closing: {
      dr: grandTotals.closingDr,
      cr: grandTotals.closingCr,
      delta: grandTotals.closingDr - grandTotals.closingCr,
      ok: Math.abs(grandTotals.closingDr - grandTotals.closingCr) <= tolerance,
    },
    tolerance,
  };

  const activityCounts: TbActivityCounts = {
    dormant: 0, active: 0, new: 0, closed: 0, 'never-used': 0,
  };
  for (const r of flatLedgers) activityCounts[r.activity] += 1;

  const reconciliationFailures = flatLedgers.filter((r) => !r.reconPass);

  return {
    tree,
    flatLedgers,
    reconciliationFailures,
    activityCounts,
    balanceCheck,
    grandTotals,
    periodFrom,
    periodTo,
  };
};

