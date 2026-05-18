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

const annotateLines = (store: TallyStore): AnnotatedLine[] => {
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
    const isGst = isInputGstLedger(ledger);
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

// ── Main query ──────────────────────────────────────────────────────────────

export const getPurchaseITCRegister = (
  store: TallyStore,
  opts: ItcQueryOpts = {},
): ItcRow[] => {
  const { dateFrom, dateTo } = opts;
  const annotated = annotateLines(store);

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

