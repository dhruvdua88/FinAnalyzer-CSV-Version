import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Info, Search } from 'lucide-react';
import { LedgerEntry } from '../../types';
import { isSqlBackendAvailable } from '../../services/sqlDataService';
import { fetchSqlModuleRows } from '../../services/sqlAnalyticsService';

// ─── Types ────────────────────────────────────────────────────────────────────

type ItcRow = {
  gstin: string;
  partyName: string;
  invoiceNo: string;
  date: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  tax: number;
  type: string;
  month3b: string;
  booksMonth: string;
};

type BooksVoucherRow = {
  invoiceNo: string;
  date: string;
  partyName: string;
  gstin: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  tax: number;
  booksMonth: string;
  voucherType: string;
  isRcm: boolean;
};

type RecoStatus =
  | 'Matched'
  | 'Rounding Diff'
  | 'Deferred Claim'
  | 'Amount Mismatch'
  | 'Only in ITC'
  | 'Only in Books'
  | 'Unfiled';

type RecoMode = 'b2b' | 'rcm';

type Tolerance = { pct: number; abs: number };
const DEFAULT_TOLERANCE: Tolerance = { pct: 0.5, abs: 20 };
const ROUND_TAX = 2;       // |ΔTax| ≤ ₹2
const ROUND_TAXABLE = 10;  // |ΔTaxable| ≤ ₹10

type RecoRow = {
  id: string;
  status: RecoStatus;
  matchTier?: 'exact' | 'invoice-only' | 'aggressive';
  itcGstin: string;
  itcPartyName: string;
  itcInvoiceNo: string;
  itcDate: string;
  itcTaxable: number;
  itcIgst: number;
  itcCgst: number;
  itcSgst: number;
  itcTax: number;
  itcMonth3b: string;
  itcBooksMonth: string;
  booksInvoiceNo: string;
  booksDate: string;
  booksPartyName: string;
  booksGstin: string;
  booksTaxable: number;
  booksIgst: number;
  booksCgst: number;
  booksSgst: number;
  booksTax: number;
  booksBooksMonth: string;
  diffTaxable: number;
  diffIgst: number;
  diffCgst: number;
  diffSgst: number;
  diffTax: number;
  reason?: string;
};

type DoubleClaim = {
  key: string;
  gstin: string;
  partyName: string;
  invoiceNo: string;
  occurrences: Array<{ month3b: string; taxable: number; tax: number; date: string }>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const FY_MONTH_ORDER: Record<string, number> = {
  April: 1, May: 2, June: 3, July: 4, August: 5, September: 6,
  October: 7, November: 8, December: 9, January: 10, February: 11, March: 12,
};

const STATUS_CFG: Record<RecoStatus, { label: string; rowBg: string; pill: string }> = {
  'Matched':         { label: 'Matched',        rowBg: '',                pill: 'bg-green-100 text-green-800 border border-green-200' },
  'Rounding Diff':   { label: 'Rounding Diff',  rowBg: 'bg-emerald-50',   pill: 'bg-emerald-100 text-emerald-800 border border-emerald-200' },
  'Deferred Claim':  { label: 'Deferred Claim', rowBg: 'bg-blue-50',      pill: 'bg-blue-100 text-blue-800 border border-blue-200' },
  'Amount Mismatch': { label: 'Amt Mismatch',   rowBg: 'bg-amber-50',     pill: 'bg-amber-100 text-amber-800 border border-amber-200' },
  'Only in ITC':     { label: 'Only in ITC',    rowBg: 'bg-red-50',       pill: 'bg-red-100 text-red-800 border border-red-200' },
  'Only in Books':   { label: 'Only in Books',  rowBg: 'bg-indigo-50',    pill: 'bg-indigo-100 text-indigo-800 border border-indigo-200' },
  'Unfiled':         { label: 'Unfiled / NA',   rowBg: 'bg-slate-50',     pill: 'bg-slate-100 text-slate-600 border border-slate-200' },
};

const UNFILED_KEY = 'Unfiled (NA)';

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

const normalizeInv = (s: string) => (s || '').replace(/\s+/g, '').toUpperCase();
const normalizeGstin = (s: string) => (s || '').trim().toUpperCase();
const aggressiveNorm = (s: string) => (s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
// last 6 trailing digits of invoice, for fuzzy Tier-5 match (e.g. "PO/2025-26/0001234" ↔ "1234" ↔ "001234")
const lastDigits = (s: string, n = 6): string => {
  const digits = (s || '').replace(/\D/g, '');
  if (digits.length < 3) return '';
  return digits.slice(-n);
};

const isUnfiledMonth = (m: string) => {
  const v = (m || '').trim().toLowerCase();
  return v === '' || v === 'na' || v === 'n/a' || v === 'any' || v === '-' || v === 'nil' || v === 'not filed';
};

const signedAmt = (v: unknown) => { const n = Number(v ?? 0); return isFinite(n) ? n : 0; };

const toDDMMYYYY = (value: string) => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const monthFromDate = (d: string) => {
  const p = d.split('/');
  if (p.length !== 3) return '';
  const mm = Number(p[1]);
  return isFinite(mm) && mm >= 1 && mm <= 12 ? MONTH_NAMES[mm - 1] : '';
};

const fmtAmt = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const getEffectiveMonth = (r: RecoRow): string => {
  if (r.status === 'Unfiled') return UNFILED_KEY;
  if (r.status === 'Only in Books') return r.booksBooksMonth || '';
  return r.itcMonth3b || r.itcBooksMonth || r.booksBooksMonth || '';
};

// ─── CSV Parser ───────────────────────────────────────────────────────────────

const parseCSVLine = (line: string): string[] => {
  const result: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
};

const parseNum = (s: string) => {
  const n = parseFloat((s || '').replace(/,/g, '').trim());
  return isFinite(n) ? n : 0;
};

const parseItcCsv = (text: string): ItcRow[] => {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const rows: ItcRow[] = [];
  let headerPassed = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    if (!headerPassed) {
      const c0 = (cols[0] || '').toLowerCase();
      const c1 = (cols[1] || '').toLowerCase();
      if (c0.includes('gstin') || c0.includes('party') || c1.includes('party') || c1.includes('name')) {
        headerPassed = true;
      }
      continue;
    }
    if (cols.length < 13) continue;
    if (!cols[2]?.trim()) continue;
    rows.push({
      gstin: (cols[0] || '').trim(),
      partyName: (cols[1] || '').trim(),
      invoiceNo: (cols[2] || '').trim(),
      date: (cols[3] || '').trim(),
      taxable: parseNum(cols[4]),
      igst: parseNum(cols[5]),
      cgst: parseNum(cols[6]),
      sgst: parseNum(cols[7]),
      tax: parseNum(cols[8]),
      type: (cols[12] || '').trim(),
      month3b: (cols[13] || '').trim(),
      booksMonth: (cols[14] || '').trim(),
    });
  }
  return rows;
};

// ─── Books Row Builder ────────────────────────────────────────────────────────

const isPEFA = (e: LedgerEntry) => {
  const p = (e.TallyPrimary || '').toLowerCase();
  return p.includes('purchase') || p.includes('expense') || p.includes('fixed asset');
};

const isAccVoucher = (e: LedgerEntry): boolean => {
  const raw = e?.is_accounting_voucher;
  if (raw == null || String(raw).trim() === '') return true;
  const t = String(raw).trim().toLowerCase();
  if (t === '1' || t === 'true' || t === 'yes') return true;
  if (t === '0' || t === 'false' || t === 'no') return false;
  const n = Number(t);
  return isFinite(n) ? n > 0 : false;
};

const gstHead = (ledger: string) => {
  const x = (ledger || '').toLowerCase();
  if (x.includes('igst')) return 'IGST';
  if (x.includes('cgst')) return 'CGST';
  if (x.includes('sgst') || x.includes('utgst')) return 'SGST';
  return 'OTHER';
};

const buildBooksRows = (
  entries: LedgerEntry[],
  selectedLedgers: string[],
  rcmLedgers: string[] = [],
): BooksVoucherRow[] => {
  const selected = new Set(selectedLedgers);
  const rcmSet = new Set(rcmLedgers);
  const accounting = entries.filter(isAccVoucher);

  const map = new Map<string, LedgerEntry[]>();
  accounting.forEach((entry, idx) => {
    const vn = String(entry.voucher_number || entry.invoice_number || '').trim() || `UNKNOWN-${idx}`;
    const dt = String(entry.date || '').trim();
    const vt = String(entry.voucher_type || '').trim();
    const key = `${vn}__${dt}__${vt}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(entry);
  });

  const result: BooksVoucherRow[] = [];
  map.forEach((vEntries) => {
    const primaryEntries = vEntries.filter(isPEFA);
    const isRcm = rcmSet.size > 0 && vEntries.some((e) => rcmSet.has(e.Ledger));
    // For RCM vouchers, the "ITC" sits in the RCM tax ledgers; for normal B2B, in the selected purchase GST ledgers.
    const gstHits = vEntries.filter((e) => (isRcm ? rcmSet.has(e.Ledger) : selected.has(e.Ledger)));
    if (primaryEntries.length === 0 && gstHits.length === 0) return;

    const taxable = primaryEntries.reduce((a, e) => a + signedAmt(e.amount), 0);
    let igst = 0, cgst = 0, sgst = 0;
    gstHits.forEach((e) => {
      const amt = signedAmt(e.amount);
      const h = gstHead(e.Ledger);
      if (h === 'IGST') igst += amt;
      else if (h === 'CGST') cgst += amt;
      else if (h === 'SGST') sgst += amt;
    });

    const fe = vEntries[0];
    const invoiceNo = String(fe.voucher_number || fe.invoice_number || '').trim();
    const date = toDDMMYYYY(String(fe.date || '').trim());
    const gstinRaw = vEntries.map((e) => String((e as any).gstn || (e as any).GSTN || e.gstin || '')).find((x) => x.trim()) || '';
    const partyName =
      vEntries.map((e) => String(e.party_name || '').trim()).find((x) => x) ||
      vEntries.find((e) => {
        const p = (e.TallyPrimary || '').toLowerCase();
        return p.includes('creditor') || (e.TallyParent || '').toLowerCase().includes('creditor');
      })?.Ledger || '';

    result.push({
      invoiceNo,
      date,
      partyName,
      gstin: normalizeGstin(gstinRaw),
      taxable,
      igst,
      cgst,
      sgst,
      tax: igst + cgst + sgst,
      booksMonth: monthFromDate(date),
      voucherType: String(fe.voucher_type || '').trim(),
      isRcm,
    });
  });
  return result;
};

// ─── Reconciliation Engine ────────────────────────────────────────────────────

// Classify a matched row into Matched / Rounding Diff / Amount Mismatch using configurable tolerance.
const classifyMatched = (
  dTaxable: number,
  dTax: number,
  baseTaxable: number,
  baseTax: number,
  tol: Tolerance,
): { status: 'Matched' | 'Rounding Diff' | 'Amount Mismatch'; reason: string } => {
  const aDt = Math.abs(dTaxable);
  const aDx = Math.abs(dTax);
  // near-zero
  if (aDt < 1 && aDx < 1) return { status: 'Matched', reason: '' };
  // rounding band
  if (aDt <= ROUND_TAXABLE && aDx <= ROUND_TAX) {
    return { status: 'Rounding Diff', reason: `Round-off Δ₹${aDx.toFixed(2)}` };
  }
  // configurable tolerance (absolute OR percentage of larger base value)
  const tolTaxable = Math.max(tol.abs, (tol.pct / 100) * Math.abs(baseTaxable));
  const tolTax = Math.max(tol.abs, (tol.pct / 100) * Math.abs(baseTax));
  if (aDt <= tolTaxable && aDx <= tolTax) {
    return { status: 'Matched', reason: `Within ${tol.pct}% tolerance` };
  }
  // mismatch — describe which side has the overage
  const bits: string[] = [];
  if (aDt > tolTaxable) bits.push(`Taxable ${dTaxable > 0 ? '+' : ''}₹${dTaxable.toFixed(0)}`);
  if (aDx > tolTax) bits.push(`Tax ${dTax > 0 ? '+' : ''}₹${dTax.toFixed(0)}`);
  return { status: 'Amount Mismatch', reason: bits.join(' · ') };
};

const runReconciliation = (
  allItcRows: ItcRow[],
  booksRows: BooksVoucherRow[],
  mode: RecoMode,
  tolerance: Tolerance,
): { recoRows: RecoRow[]; doubleClaims: DoubleClaim[] } => {
  // Segregate ITC rows by type — B2B goes to normal tab, RCM types go to RCM tab.
  const isRcmType = (t: string) => {
    const u = (t || '').toUpperCase();
    return u.includes('RCM') || u.includes('REVERSE') || u.includes('IMPORT');
  };
  const itcScope = mode === 'rcm'
    ? allItcRows.filter((r) => isRcmType(r.type))
    : allItcRows.filter((r) => r.type.toUpperCase() === 'B2B');

  // Books side: in RCM mode only RCM vouchers; in B2B mode only non-RCM.
  const booksScope = mode === 'rcm'
    ? booksRows.filter((b) => b.isRcm)
    : booksRows.filter((b) => !b.isRcm);

  const map1 = new Map<string, number>();
  const map2 = new Map<string, number[]>();
  const map3 = new Map<string, number>();
  const mapDigits = new Map<string, number[]>(); // Tier-5: last-6-digits → [idx,…]

  booksScope.forEach((br, idx) => {
    const k1 = normalizeInv(br.invoiceNo) + '|' + normalizeGstin(br.gstin);
    if (!map1.has(k1)) map1.set(k1, idx);
    const k2 = normalizeInv(br.invoiceNo);
    map2.set(k2, [...(map2.get(k2) || []), idx]);
    const k3 = aggressiveNorm(br.invoiceNo) + '|' + normalizeGstin(br.gstin);
    if (!map3.has(k3)) map3.set(k3, idx);
    const ld = lastDigits(br.invoiceNo);
    if (ld) mapDigits.set(ld, [...(mapDigits.get(ld) || []), idx]);
  });

  const matchedBooksIdx = new Set<number>();
  const recoRows: RecoRow[] = [];

  for (let i = 0; i < itcScope.length; i++) {
    const itc = itcScope[i];
    const invN = normalizeInv(itc.invoiceNo);
    const gstN = normalizeGstin(itc.gstin);

    let matchedIdx = -1;
    let matchTier: RecoRow['matchTier'];

    // Tier 1: exact normalize
    const k1 = invN + '|' + gstN;
    if (map1.has(k1)) { matchedIdx = map1.get(k1)!; matchTier = 'exact'; }

    // Tier 2: compound invoice — try each "/" segment
    if (matchedIdx === -1 && itc.invoiceNo.includes('/')) {
      for (const part of itc.invoiceNo.split('/')) {
        const pk = normalizeInv(part) + '|' + gstN;
        if (map1.has(pk)) { matchedIdx = map1.get(pk)!; matchTier = 'exact'; break; }
      }
    }

    // Tier 3: aggressive normalize (strip non-alphanumeric) + gstin
    if (matchedIdx === -1) {
      const k3 = aggressiveNorm(itc.invoiceNo) + '|' + gstN;
      if (map3.has(k3)) { matchedIdx = map3.get(k3)!; matchTier = 'aggressive'; }
    }

    // Tier 4: invoice-only when GSTIN absent on ITC side
    if (matchedIdx === -1 && gstN === '') {
      const candidates = map2.get(invN) || [];
      if (candidates.length === 1) { matchedIdx = candidates[0]; matchTier = 'invoice-only'; }
    }

    // Tier 5: last-6-digits fuzzy match — unique-digit + matching GSTIN (prevents wrong-party pairing)
    if (matchedIdx === -1) {
      const ld = lastDigits(itc.invoiceNo);
      if (ld) {
        const cands = (mapDigits.get(ld) || []).filter((idx) => !matchedBooksIdx.has(idx));
        const gstinMatching = gstN
          ? cands.filter((idx) => normalizeGstin(booksScope[idx].gstin) === gstN)
          : cands;
        if (gstinMatching.length === 1) { matchedIdx = gstinMatching[0]; matchTier = 'aggressive'; }
      }
    }

    if (matchedIdx >= 0) {
      matchedBooksIdx.add(matchedIdx);
      const br = booksScope[matchedIdx];
      const diffTaxable = itc.taxable + br.taxable;
      const diffIgst = itc.igst + br.igst;
      const diffCgst = itc.cgst + br.cgst;
      const diffSgst = itc.sgst + br.sgst;
      const diffTax = itc.tax + br.tax;
      const unfiled = isUnfiledMonth(itc.month3b);
      let status: RecoStatus;
      let reason = '';
      if (unfiled) {
        status = 'Unfiled';
      } else {
        const cls = classifyMatched(diffTaxable, diffTax, itc.taxable || br.taxable, itc.tax || br.tax, tolerance);
        if (cls.status === 'Amount Mismatch') {
          status = 'Amount Mismatch';
          reason = cls.reason;
        } else if (itc.month3b !== br.booksMonth) {
          status = 'Deferred Claim';
          reason = `Claimed ${itc.month3b}, booked ${br.booksMonth}`;
        } else {
          status = cls.status;
          reason = cls.reason;
        }
      }
      recoRows.push({
        id: `itc-${i}`, status, matchTier, reason,
        itcGstin: itc.gstin, itcPartyName: itc.partyName, itcInvoiceNo: itc.invoiceNo,
        itcDate: itc.date, itcTaxable: itc.taxable, itcIgst: itc.igst, itcCgst: itc.cgst,
        itcSgst: itc.sgst, itcTax: itc.tax, itcMonth3b: itc.month3b, itcBooksMonth: itc.booksMonth,
        booksInvoiceNo: br.invoiceNo, booksDate: br.date, booksPartyName: br.partyName,
        booksGstin: br.gstin, booksTaxable: br.taxable, booksIgst: br.igst, booksCgst: br.cgst,
        booksSgst: br.sgst, booksTax: br.tax, booksBooksMonth: br.booksMonth,
        diffTaxable, diffIgst, diffCgst, diffSgst, diffTax,
      });
    } else {
      const unfiled = isUnfiledMonth(itc.month3b);
      recoRows.push({
        id: `itc-${i}`, status: unfiled ? 'Unfiled' : 'Only in ITC', matchTier: undefined,
        reason: unfiled ? 'ITC row with no 3B month filed' : 'No match found in books',
        itcGstin: itc.gstin, itcPartyName: itc.partyName, itcInvoiceNo: itc.invoiceNo,
        itcDate: itc.date, itcTaxable: itc.taxable, itcIgst: itc.igst, itcCgst: itc.cgst,
        itcSgst: itc.sgst, itcTax: itc.tax, itcMonth3b: itc.month3b, itcBooksMonth: itc.booksMonth,
        booksInvoiceNo: '', booksDate: '', booksPartyName: '', booksGstin: '',
        booksTaxable: 0, booksIgst: 0, booksCgst: 0, booksSgst: 0, booksTax: 0, booksBooksMonth: '',
        diffTaxable: itc.taxable, diffIgst: itc.igst, diffCgst: itc.cgst, diffSgst: itc.sgst, diffTax: itc.tax,
      });
    }
  }

  booksScope.forEach((br, idx) => {
    if (matchedBooksIdx.has(idx)) return;
    recoRows.push({
      id: `books-${idx}`, status: 'Only in Books', matchTier: undefined,
      reason: 'Booked but not claimed in 3B',
      itcGstin: '', itcPartyName: '', itcInvoiceNo: '', itcDate: '',
      itcTaxable: 0, itcIgst: 0, itcCgst: 0, itcSgst: 0, itcTax: 0, itcMonth3b: '', itcBooksMonth: '',
      booksInvoiceNo: br.invoiceNo, booksDate: br.date, booksPartyName: br.partyName,
      booksGstin: br.gstin, booksTaxable: br.taxable, booksIgst: br.igst, booksCgst: br.cgst,
      booksSgst: br.sgst, booksTax: br.tax, booksBooksMonth: br.booksMonth,
      diffTaxable: br.taxable, diffIgst: br.igst, diffCgst: br.cgst, diffSgst: br.sgst, diffTax: br.tax,
    });
  });

  // Double claim detection
  const itcGroups = new Map<string, ItcRow[]>();
  for (const row of itcScope) {
    if (isUnfiledMonth(row.month3b)) continue;
    const k = normalizeInv(row.invoiceNo) + '|' + normalizeGstin(row.gstin);
    if (!itcGroups.has(k)) itcGroups.set(k, []);
    itcGroups.get(k)!.push(row);
  }
  const doubleClaims: DoubleClaim[] = [];
  itcGroups.forEach((rows, key) => {
    if (rows.length > 1) {
      doubleClaims.push({
        key,
        gstin: rows[0].gstin,
        partyName: rows[0].partyName,
        invoiceNo: rows[0].invoiceNo,
        occurrences: rows.map((r) => ({ month3b: r.month3b, taxable: r.taxable, tax: r.tax, date: r.date })),
      });
    }
  });

  return { recoRows, doubleClaims };
};

// ─── Excel Export ─────────────────────────────────────────────────────────────

const STATUS_EXCEL_COLORS: Record<RecoStatus, string> = {
  'Matched':         'FFFFFF',
  'Rounding Diff':   'D1FAE5',
  'Deferred Claim':  'DBEAFE',
  'Amount Mismatch': 'FEF3C7',
  'Only in ITC':     'FEE2E2',
  'Only in Books':   'E0E7FF',
  'Unfiled':         'F1F5F9',
};

type ExportFilters = {
  status?: RecoStatus | 'All';
  month?: string;
  search?: string;
};

const describeFilters = (f?: ExportFilters): string[] => {
  if (!f) return [];
  const parts: string[] = [];
  if (f.status && f.status !== 'All') parts.push(`Status=${STATUS_CFG[f.status as RecoStatus]?.label || f.status}`);
  if (f.month && f.month !== 'All') parts.push(`Month=${f.month === UNFILED_KEY ? 'Unfiled (NA)' : f.month}`);
  if (f.search && f.search.trim()) parts.push(`Search="${f.search.trim()}"`);
  return parts;
};

const filterFilenameTag = (f?: ExportFilters): string => {
  if (!f) return '';
  const bits: string[] = [];
  if (f.status && f.status !== 'All') bits.push(String(f.status).replace(/[^A-Za-z0-9]/g, ''));
  if (f.month && f.month !== 'All') bits.push(String(f.month).replace(/[^A-Za-z0-9]/g, ''));
  if (f.search && f.search.trim()) bits.push('Search');
  return bits.length ? '_' + bits.join('-') : '';
};

const exportToExcel = async (
  recoRows: RecoRow[],
  doubleClaims: DoubleClaim[],
  csvFileName: string,
  mode: RecoMode = 'b2b',
  filters?: ExportFilters,
) => {
  const XLSX = await import('xlsx-js-style');

  const border = {
    top: { style: 'thin', color: { rgb: 'CBD5E1' } },
    right: { style: 'thin', color: { rgb: 'CBD5E1' } },
    bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
    left: { style: 'thin', color: { rgb: 'CBD5E1' } },
  };
  const hdrStyle = {
    fill: { fgColor: { rgb: '1E293B' } },
    font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border,
  };
  const makeCell = (v: any, rgb: string, isNum = false): any => ({
    v,
    t: isNum ? 'n' : 's',
    s: {
      fill: { fgColor: { rgb } },
      font: { name: 'Calibri', sz: 10, color: { rgb: '0F172A' } },
      alignment: { horizontal: isNum ? 'right' : 'left', vertical: 'center' },
      border,
      ...(isNum && v !== '' ? { numFmt: '#,##0.00' } : {}),
    },
  });
  const makeDiffCell = (v: number, rgb: string): any => ({
    v,
    t: 'n',
    s: {
      fill: { fgColor: { rgb } },
      font: { name: 'Calibri', sz: 10, bold: Math.abs(v) > 20, color: { rgb: Math.abs(v) > 20 ? 'B91C1C' : '15803D' } },
      alignment: { horizontal: 'right', vertical: 'center' },
      border,
      numFmt: '#,##0.00',
    },
  });
  const makeBlockHeader = (label: string, bgRgb: string, fgRgb = 'FFFFFF'): any => ({
    v: label,
    t: 's',
    s: {
      fill: { fgColor: { rgb: bgRgb } },
      font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: fgRgb } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border,
    },
  });
  const makeSubtotalCell = (v: any, rgb: string, isNum = false, bold = true): any => ({
    v,
    t: isNum ? 'n' : 's',
    s: {
      fill: { fgColor: { rgb } },
      font: { name: 'Calibri', sz: 10, bold, color: { rgb: '0F172A' } },
      alignment: { horizontal: isNum ? 'right' : 'left', vertical: 'center' },
      border: {
        top: { style: 'medium', color: { rgb: '64748B' } },
        bottom: { style: 'thin', color: { rgb: '94A3B8' } },
        left: { style: 'thin', color: { rgb: 'CBD5E1' } },
        right: { style: 'thin', color: { rgb: 'CBD5E1' } },
      },
      ...(isNum && v !== '' ? { numFmt: '#,##0.00' } : {}),
    },
  });

  // ── Sheet 1: Summary ──
  const filterDesc = describeFilters(filters);
  const titleText = filterDesc.length > 0
    ? `ITC vs 3B Reconciliation — Position Summary  (Filtered: ${filterDesc.join(' · ')})`
    : 'ITC vs 3B Reconciliation — Position Summary';
  const summaryAoa: any[][] = [
    [{ v: titleText, s: { font: { name: 'Calibri', sz: 13, bold: true, color: { rgb: '1E293B' } }, alignment: { horizontal: 'left' } } }],
    [],
    [{ v: 'Category', s: hdrStyle }, { v: 'Count', s: hdrStyle }, { v: 'Taxable (₹)', s: hdrStyle }, { v: 'Tax (₹)', s: hdrStyle }],
  ];
  const posGroups: Array<{ label: string; filter: (r: RecoRow) => boolean; taxableField: keyof RecoRow; taxField: keyof RecoRow; rgb: string }> = [
    { label: '✅ Filed & Clean (Matched + Rounding + Deferred)', filter: (r) => r.status === 'Matched' || r.status === 'Rounding Diff' || r.status === 'Deferred Claim', taxableField: 'itcTaxable', taxField: 'itcTax', rgb: 'DCFCE7' },
    { label: '⚠️ Needs Review (Mismatch + Only ITC)', filter: (r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC', taxableField: 'itcTaxable', taxField: 'itcTax', rgb: 'FEE2E2' },
    { label: '📚 Unclaimed ITC (Only in Books)', filter: (r) => r.status === 'Only in Books', taxableField: 'booksTaxable', taxField: 'booksTax', rgb: 'E0E7FF' },
    { label: '⏳ Pending / Unfiled (3B Month = NA)', filter: (r) => r.status === 'Unfiled', taxableField: 'itcTaxable', taxField: 'itcTax', rgb: 'F1F5F9' },
  ];
  posGroups.forEach(({ label, filter, taxableField, taxField, rgb }) => {
    const rows = recoRows.filter(filter);
    const taxable = rows.reduce((a, r) => a + (r[taxableField] as number), 0);
    const tax = rows.reduce((a, r) => a + (r[taxField] as number), 0);
    summaryAoa.push([makeCell(label, rgb), makeCell(rows.length, rgb, true), makeCell(taxable, rgb, true), makeCell(tax, rgb, true)]);
  });

  summaryAoa.push([]);
  summaryAoa.push([{ v: 'Month-wise Summary', s: { font: { name: 'Calibri', sz: 11, bold: true } } }]);
  summaryAoa.push([
    { v: 'Month', s: hdrStyle }, { v: '3B Count', s: hdrStyle }, { v: '3B Taxable', s: hdrStyle }, { v: '3B Tax', s: hdrStyle },
    { v: 'Tally Count', s: hdrStyle }, { v: 'Tally Taxable', s: hdrStyle }, { v: 'Tally Tax', s: hdrStyle },
    { v: 'Matched', s: hdrStyle }, { v: 'Exceptions', s: hdrStyle }, { v: 'Δ Tax (3B-Tally)', s: hdrStyle },
  ]);

  const monthMap = new Map<string, { ic: number; it: number; ita: number; bc: number; bt: number; bta: number; m: number; ex: number }>();
  recoRows.forEach((r) => {
    const mo = getEffectiveMonth(r);
    if (!monthMap.has(mo)) monthMap.set(mo, { ic: 0, it: 0, ita: 0, bc: 0, bt: 0, bta: 0, m: 0, ex: 0 });
    const b = monthMap.get(mo)!;
    if (r.status !== 'Only in Books') { b.ic++; b.it += r.itcTaxable; b.ita += r.itcTax; }
    if (r.status !== 'Only in ITC' && r.status !== 'Unfiled') { b.bc++; b.bt += r.booksTaxable; b.bta += r.booksTax; }
    if (r.status === 'Matched' || r.status === 'Rounding Diff' || r.status === 'Deferred Claim') b.m++;
    if (r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books') b.ex++;
  });

  Array.from(monthMap.entries())
    .sort(([a], [b]) => {
      if (a === UNFILED_KEY) return 1; if (b === UNFILED_KEY) return -1;
      return (FY_MONTH_ORDER[a] || 99) - (FY_MONTH_ORDER[b] || 99);
    })
    .forEach(([mo, d]) => {
      const rgb = d.ex > 0 ? 'FEF9C3' : 'F0FDF4';
      summaryAoa.push([
        makeCell(mo === UNFILED_KEY ? 'Unfiled (NA)' : mo, rgb),
        makeCell(d.ic, rgb, true), makeCell(d.it, rgb, true), makeCell(d.ita, rgb, true),
        makeCell(d.bc, rgb, true), makeCell(d.bt, rgb, true), makeCell(d.bta, rgb, true),
        makeCell(d.m, rgb, true), makeCell(d.ex, d.ex > 0 ? 'FEE2E2' : rgb, true),
        makeDiffCell(d.ita - d.bta, rgb),
      ]);
    });

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryAoa);
  summarySheet['!cols'] = [{ wch: 44 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 18 }];
  summarySheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];

  // ── Main reconciliation sheet — mirrors the app's tri-block layout with
  //    party grouping (Excel outline), AutoFilter, and frozen panes. ──
  //
  //   Columns: 23 total
  //   A..D  Identity  (Status | Reason | Party | GSTIN)
  //   E..L  GSTR-3B   (Inv | Date | Month | Taxable | IGST | CGST | SGST | Tax)
  //   M..T  Tally     (Inv | Date | Month | Taxable | IGST | CGST | SGST | Tax)
  //   U..V  Δ         (Δ Taxable | Δ Tax)
  //   W     Match Tier
  const HEADERS = [
    'Status', 'Reason', 'Party Name', 'GSTIN',
    '3B Invoice No.', '3B Date', '3B Month', '3B Taxable', '3B IGST', '3B CGST', '3B SGST', '3B Tax',
    'Tally Invoice No.', 'Tally Date', 'Tally Month', 'Tally Taxable', 'Tally IGST', 'Tally CGST', 'Tally SGST', 'Tally Tax',
    'Δ Taxable', 'Δ Tax', 'Match Tier',
  ];
  const COL_COUNT = HEADERS.length; // 23
  const COL_WIDTHS = [
    { wch: 15 }, { wch: 28 }, { wch: 28 }, { wch: 18 },
    { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 15 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 14 },
    { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 15 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 12 },
  ];

  // Status sort priority (exceptions first, then deferred/unfiled, then clean)
  const STATUS_ORDER: Record<RecoStatus, number> = {
    'Amount Mismatch': 0, 'Only in ITC': 1, 'Only in Books': 2,
    'Deferred Claim': 3, 'Unfiled': 4, 'Rounding Diff': 5, 'Matched': 6,
  };
  const sortedAll = [...recoRows].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  // Group by GSTIN+Party (same logic as the on-screen grouping).
  const groupMap = new Map<string, { gstin: string; partyName: string; rows: RecoRow[] }>();
  sortedAll.forEach((r) => {
    const gstin = r.itcGstin || r.booksGstin || '';
    const party = r.itcPartyName || r.booksPartyName || '';
    const gk = normalizeGstin(gstin) || party.trim().toUpperCase() || 'UNKNOWN';
    if (!groupMap.has(gk)) groupMap.set(gk, { gstin, partyName: party, rows: [] });
    groupMap.get(gk)!.rows.push(r);
  });
  // Sort groups: parties with exceptions first, then by absolute Δ Tax desc.
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    const aHasEx = a.rows.some((r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books');
    const bHasEx = b.rows.some((r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books');
    if (aHasEx !== bHasEx) return aHasEx ? -1 : 1;
    const aDiff = a.rows.reduce((s, r) => s + Math.abs(r.diffTax), 0);
    const bDiff = b.rows.reduce((s, r) => s + Math.abs(r.diffTax), 0);
    return bDiff - aDiff;
  });

  const aoa: any[][] = [];
  const rowProps: any[] = [];

  // ── Row 1: tri-block super-header with colour-coded spans ──
  const superRow: any[] = new Array(COL_COUNT).fill(null);
  superRow[0] = makeBlockHeader('Identity', '1E293B');     // A:D
  superRow[4] = makeBlockHeader('GSTR-3B  (ITC Claimed)', '4338CA');   // E:L — indigo
  superRow[12] = makeBlockHeader('Tally / Books', '475569');            // M:T — slate
  superRow[20] = makeBlockHeader('Δ  (3B + Books)', 'B45309');          // U:V — amber
  superRow[22] = makeBlockHeader('Match Tier', '1E293B');  // W
  // pad non-leader positions with empty styled cells so merges paint uniformly
  for (let c = 0; c < COL_COUNT; c++) {
    if (!superRow[c]) {
      const rgb = c >= 4 && c <= 11 ? '4338CA' : c >= 12 && c <= 19 ? '475569' : c >= 20 && c <= 21 ? 'B45309' : '1E293B';
      superRow[c] = makeBlockHeader('', rgb);
    }
  }
  aoa.push(superRow);
  rowProps.push({ hpx: 28 });

  // ── Row 2: column labels (AutoFilter anchors here) ──
  aoa.push(HEADERS.map((h) => ({ v: h, s: hdrStyle })));
  rowProps.push({ hpx: 34 });

  const buildDetailRow = (r: RecoRow, rgb: string): any[] => [
    { v: STATUS_CFG[r.status].label, t: 's', s: { ...makeCell(STATUS_CFG[r.status].label, rgb).s, font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: '0F172A' } } } },
    makeCell(r.reason || '', rgb),
    makeCell(r.itcPartyName || r.booksPartyName || '', rgb),
    makeCell(r.itcGstin || r.booksGstin || '', rgb),
    makeCell(r.itcInvoiceNo || '', rgb),
    makeCell(r.itcDate || '', rgb),
    makeCell(r.itcMonth3b || '', rgb),
    makeCell(r.itcTaxable || '', rgb, r.itcTaxable !== 0),
    makeCell(r.itcIgst || '', rgb, r.itcIgst !== 0),
    makeCell(r.itcCgst || '', rgb, r.itcCgst !== 0),
    makeCell(r.itcSgst || '', rgb, r.itcSgst !== 0),
    makeCell(r.itcTax || '', rgb, r.itcTax !== 0),
    makeCell(r.booksInvoiceNo || '', rgb),
    makeCell(r.booksDate || '', rgb),
    makeCell(r.booksBooksMonth || '', rgb),
    makeCell(r.booksTaxable || '', rgb, r.booksTaxable !== 0),
    makeCell(r.booksIgst || '', rgb, r.booksIgst !== 0),
    makeCell(r.booksCgst || '', rgb, r.booksCgst !== 0),
    makeCell(r.booksSgst || '', rgb, r.booksSgst !== 0),
    makeCell(r.booksTax || '', rgb, r.booksTax !== 0),
    makeDiffCell(r.diffTaxable, rgb),
    makeDiffCell(r.diffTax, rgb),
    makeCell(r.matchTier || (r.status === 'Only in ITC' || r.status === 'Only in Books' ? '—' : ''), rgb),
  ];

  // ── Grouped body: one party-summary row (level 0) + N detail rows (level 1) ──
  const GROUP_BG = 'F1F5F9'; // slate-100, mirrors the UI group header
  let grand = { itcTax: 0, itcTaxable: 0, booksTax: 0, booksTaxable: 0, dTax: 0, dTaxable: 0, count: 0, exCount: 0 };

  groups.forEach((g) => {
    const sum = g.rows.reduce(
      (a, r) => ({
        itcTax: a.itcTax + r.itcTax,
        itcTaxable: a.itcTaxable + r.itcTaxable,
        booksTax: a.booksTax + r.booksTax,
        booksTaxable: a.booksTaxable + r.booksTaxable,
        dTax: a.dTax + r.diffTax,
        dTaxable: a.dTaxable + r.diffTaxable,
      }),
      { itcTax: 0, itcTaxable: 0, booksTax: 0, booksTaxable: 0, dTax: 0, dTaxable: 0 },
    );
    const exCount = g.rows.filter((r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books').length;
    grand.itcTax += sum.itcTax;
    grand.itcTaxable += sum.itcTaxable;
    grand.booksTax += sum.booksTax;
    grand.booksTaxable += sum.booksTaxable;
    grand.dTax += sum.dTax;
    grand.dTaxable += sum.dTaxable;
    grand.count += g.rows.length;
    grand.exCount += exCount;

    const summaryLabel = `▸ ${g.partyName || 'UNKNOWN'}  ·  ${g.rows.length} row${g.rows.length > 1 ? 's' : ''}${exCount > 0 ? `  ·  ${exCount} exception${exCount > 1 ? 's' : ''}` : ''}`;
    const summaryRow: any[] = [
      makeSubtotalCell('', GROUP_BG),                              // Status
      makeSubtotalCell(summaryLabel, GROUP_BG),                    // Reason slot → carries the label
      makeSubtotalCell(g.partyName || '', GROUP_BG),               // Party
      makeSubtotalCell(g.gstin || '', GROUP_BG),                   // GSTIN
      makeSubtotalCell('', GROUP_BG),                              // 3B Inv
      makeSubtotalCell('', GROUP_BG),                              // 3B Date
      makeSubtotalCell('', GROUP_BG),                              // 3B Month
      makeSubtotalCell(sum.itcTaxable, GROUP_BG, true),
      makeSubtotalCell('', GROUP_BG), makeSubtotalCell('', GROUP_BG), makeSubtotalCell('', GROUP_BG),
      makeSubtotalCell(sum.itcTax, GROUP_BG, true),
      makeSubtotalCell('', GROUP_BG),                              // Tally Inv
      makeSubtotalCell('', GROUP_BG),                              // Tally Date
      makeSubtotalCell('', GROUP_BG),                              // Tally Month
      makeSubtotalCell(sum.booksTaxable, GROUP_BG, true),
      makeSubtotalCell('', GROUP_BG), makeSubtotalCell('', GROUP_BG), makeSubtotalCell('', GROUP_BG),
      makeSubtotalCell(sum.booksTax, GROUP_BG, true),
      makeSubtotalCell(sum.dTaxable, GROUP_BG, true),
      makeSubtotalCell(sum.dTax, GROUP_BG, true),
      makeSubtotalCell('', GROUP_BG),                              // Match Tier
    ];
    aoa.push(summaryRow);
    rowProps.push({ level: 0 });

    g.rows.forEach((r) => {
      const rgb = STATUS_EXCEL_COLORS[r.status];
      aoa.push(buildDetailRow(r, rgb));
      rowProps.push({ level: 1 });
    });
  });

  // ── Grand total row ──
  const TOTAL_BG = '0F172A';
  const makeTotalCell = (v: any, isNum = false): any => ({
    v,
    t: isNum ? 'n' : 's',
    s: {
      fill: { fgColor: { rgb: TOTAL_BG } },
      font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
      alignment: { horizontal: isNum ? 'right' : 'left', vertical: 'center' },
      border: {
        top: { style: 'medium', color: { rgb: '0F172A' } },
        bottom: { style: 'medium', color: { rgb: '0F172A' } },
        left: { style: 'thin', color: { rgb: '334155' } },
        right: { style: 'thin', color: { rgb: '334155' } },
      },
      ...(isNum && v !== '' ? { numFmt: '#,##0.00' } : {}),
    },
  });
  aoa.push([
    makeTotalCell('GRAND TOTAL'),
    makeTotalCell(`${grand.count} rows · ${grand.exCount} exceptions`),
    makeTotalCell(''), makeTotalCell(''),
    makeTotalCell(''), makeTotalCell(''), makeTotalCell(''),
    makeTotalCell(grand.itcTaxable, true),
    makeTotalCell(''), makeTotalCell(''), makeTotalCell(''),
    makeTotalCell(grand.itcTax, true),
    makeTotalCell(''), makeTotalCell(''), makeTotalCell(''),
    makeTotalCell(grand.booksTaxable, true),
    makeTotalCell(''), makeTotalCell(''), makeTotalCell(''),
    makeTotalCell(grand.booksTax, true),
    makeTotalCell(grand.dTaxable, true),
    makeTotalCell(grand.dTax, true),
    makeTotalCell(''),
  ]);
  rowProps.push({ level: 0, hpx: 24 });

  const recoSheet = XLSX.utils.aoa_to_sheet(aoa);
  recoSheet['!cols'] = COL_WIDTHS;
  recoSheet['!rows'] = rowProps;
  // Merge the super-header spans so the tri-block reads as single cells.
  recoSheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },     // Identity
    { s: { r: 0, c: 4 }, e: { r: 0, c: 11 } },    // GSTR-3B
    { s: { r: 0, c: 12 }, e: { r: 0, c: 19 } },   // Tally
    { s: { r: 0, c: 20 }, e: { r: 0, c: 21 } },   // Δ
    // col 22 stands alone
  ];
  // AutoFilter on the column-label row — user can filter Status (Matched / Only in Books / Only in ITC / etc.), month, party.
  const lastColLetter = XLSX.utils.encode_col(COL_COUNT - 1);
  recoSheet['!autofilter'] = { ref: `A2:${lastColLetter}${aoa.length}` };
  // Freeze top 2 header rows and the left 4 identity columns.
  recoSheet['!views'] = [{ state: 'frozen', xSplit: 4, ySplit: 2 }];
  // Emit <outlinePr summaryBelow="0"/> so Excel puts expand arrows next to the party row, not below its details.
  (recoSheet as any)['!outline'] = { summaryBelow: false };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'ITC Position Summary');
  XLSX.utils.book_append_sheet(wb, recoSheet, `Reconciliation (${mode === 'rcm' ? 'RCM' : 'B2B'})`);

  if (doubleClaims.length > 0) {
    const dcAoa: any[][] = [
      [{ v: 'Invoice No.', s: hdrStyle }, { v: 'GSTIN', s: hdrStyle }, { v: 'Party', s: hdrStyle },
       { v: 'Occurrence #', s: hdrStyle }, { v: '3B Month', s: hdrStyle }, { v: 'Date', s: hdrStyle },
       { v: 'Taxable', s: hdrStyle }, { v: 'Tax', s: hdrStyle }],
    ];
    doubleClaims.forEach((dc) => {
      dc.occurrences.forEach((occ, oi) => {
        dcAoa.push([
          makeCell(oi === 0 ? dc.invoiceNo : '', 'FEE2E2'),
          makeCell(oi === 0 ? dc.gstin : '', 'FEE2E2'),
          makeCell(oi === 0 ? dc.partyName : '', 'FEE2E2'),
          makeCell(oi + 1, 'FEE2E2', true),
          makeCell(occ.month3b, 'FEE2E2'),
          makeCell(occ.date, 'FEE2E2'),
          makeCell(occ.taxable, 'FEE2E2', true),
          makeCell(occ.tax, 'FEE2E2', true),
        ]);
      });
    });
    const dcSheet = XLSX.utils.aoa_to_sheet(dcAoa);
    dcSheet['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, dcSheet, 'Double Claims');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const modeTag = mode === 'rcm' ? 'RCM' : 'B2B';
  const fTag = filterFilenameTag(filters);
  XLSX.writeFile(wb, `ITC_3B_Reconciliation_${modeTag}${fTag}_${stamp}.xlsx`, { compression: true });
};

// ─── Component ────────────────────────────────────────────────────────────────

interface ITC3BReconciliationProps {
  data: LedgerEntry[];
  externalSelectedLedgers?: string[];
  externalRcmLedgers?: string[];
  onLedgersUpdate?: (ledgers: string[]) => void;
}

const ITC3BReconciliation: React.FC<ITC3BReconciliationProps> = ({
  data,
  externalSelectedLedgers,
  externalRcmLedgers,
  onLedgersUpdate,
}) => {
  const [sqlRows, setSqlRows] = useState<LedgerEntry[]>([]);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState('');

  const selectedLedgers = externalSelectedLedgers ?? [];
  const rcmLedgers = externalRcmLedgers ?? [];

  const [itcRows, setItcRows] = useState<ItcRow[]>([]);
  const [csvFileName, setCsvFileName] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<RecoStatus | 'All'>('All');
  const [monthFilter, setMonthFilter] = useState('All');
  const [showMonthSummary, setShowMonthSummary] = useState(true);
  const [mode, setMode] = useState<RecoMode>('b2b');
  const [tolerance, setTolerance] = useState<Tolerance>(DEFAULT_TOLERANCE);
  const [includeNilTax, setIncludeNilTax] = useState(false);
  const [showTaxSplit, setShowTaxSplit] = useState(false);
  const [actionMenuFor, setActionMenuFor] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sourceData = data.length > 0 ? data : sqlRows;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (data.length > 0) { setSqlRows([]); setSqlLoading(false); return; }
      setSqlLoading(true);
      try {
        const avail = await isSqlBackendAvailable();
        if (!avail) { if (!cancelled) setSqlLoading(false); return; }
        const rows = await fetchSqlModuleRows({ module: 'purchase', selectedLedgers, selectedRcmLedgers: [] });
        if (!cancelled) setSqlRows(rows);
      } catch (e: any) {
        if (!cancelled) setSqlError(e?.message || 'Unable to load purchase data.');
      } finally {
        if (!cancelled) setSqlLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [data.length, selectedLedgers.join('|')]);

  const booksRows = useMemo(
    () => buildBooksRows(sourceData, selectedLedgers, rcmLedgers),
    [sourceData, selectedLedgers, rcmLedgers],
  );

  const rawReco = useMemo(
    () => (itcRows.length > 0 ? runReconciliation(itcRows, booksRows, mode, tolerance) : { recoRows: [], doubleClaims: [] }),
    [itcRows, booksRows, mode, tolerance],
  );

  // Nil-tax filter: drop rows where BOTH sides have ~zero tax (pure nil-rated noise).
  // Kept as a toggle — switching on brings those rows back.
  const { recoRows, doubleClaims, nilTaxHidden } = useMemo(() => {
    const dropped = includeNilTax
      ? []
      : rawReco.recoRows.filter((r) => Math.abs(r.itcTax) < 0.5 && Math.abs(r.booksTax) < 0.5);
    const kept = includeNilTax
      ? rawReco.recoRows
      : rawReco.recoRows.filter((r) => Math.abs(r.itcTax) >= 0.5 || Math.abs(r.booksTax) >= 0.5);
    return { recoRows: kept, doubleClaims: rawReco.doubleClaims, nilTaxHidden: dropped.length };
  }, [rawReco, includeNilTax]);

  // Row counts per mode (for tab badge). Compute both always using the current ITC CSV + books.
  const modeCounts = useMemo(() => {
    if (itcRows.length === 0) return { b2b: 0, rcm: 0 };
    return {
      b2b: runReconciliation(itcRows, booksRows, 'b2b', tolerance).recoRows.length,
      rcm: runReconciliation(itcRows, booksRows, 'rcm', tolerance).recoRows.length,
    };
  }, [itcRows, booksRows, tolerance]);

  const netPosition = useMemo(() => {
    const sum = (rows: RecoRow[], tf: 'itcTaxable' | 'itcTax' | 'booksTaxable' | 'booksTax') =>
      rows.reduce((a, r) => a + r[tf], 0);
    const clean = recoRows.filter((r) => r.status === 'Matched' || r.status === 'Deferred Claim');
    const review = recoRows.filter((r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC');
    const unclaimed = recoRows.filter((r) => r.status === 'Only in Books');
    const unfiled = recoRows.filter((r) => r.status === 'Unfiled');
    return {
      clean: { count: clean.length, taxable: sum(clean, 'itcTaxable'), tax: sum(clean, 'itcTax') },
      review: { count: review.length, taxable: sum(review, 'itcTaxable'), tax: sum(review, 'itcTax') },
      unclaimed: { count: unclaimed.length, taxable: sum(unclaimed, 'booksTaxable'), tax: sum(unclaimed, 'booksTax') },
      unfiled: { count: unfiled.length, taxable: sum(unfiled, 'itcTaxable'), tax: sum(unfiled, 'itcTax') },
    };
  }, [recoRows]);

  const monthSummaryRows = useMemo(() => {
    const map = new Map<string, { ic: number; it: number; ita: number; bc: number; bt: number; bta: number; m: number; ex: number }>();
    recoRows.forEach((r) => {
      const mo = getEffectiveMonth(r);
      if (!map.has(mo)) map.set(mo, { ic: 0, it: 0, ita: 0, bc: 0, bt: 0, bta: 0, m: 0, ex: 0 });
      const b = map.get(mo)!;
      if (r.status !== 'Only in Books') { b.ic++; b.it += r.itcTaxable; b.ita += r.itcTax; }
      if (r.status !== 'Only in ITC' && r.status !== 'Unfiled') { b.bc++; b.bt += r.booksTaxable; b.bta += r.booksTax; }
      if (r.status === 'Matched' || r.status === 'Rounding Diff' || r.status === 'Deferred Claim') b.m++;
      if (r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books') b.ex++;
    });
    return Array.from(map.entries())
      .map(([mo, d]) => ({ mo, ...d, diff: d.ita - d.bta }))
      .sort((a, b) => {
        if (a.mo === UNFILED_KEY) return 1; if (b.mo === UNFILED_KEY) return -1;
        return (FY_MONTH_ORDER[a.mo] || 99) - (FY_MONTH_ORDER[b.mo] || 99);
      });
  }, [recoRows]);

  const monthOptions = useMemo(() => {
    const s = new Set<string>(recoRows.map(getEffectiveMonth).filter(Boolean) as string[]);
    return Array.from(s).sort((a, b) => {
      if (a === UNFILED_KEY) return 1; if (b === UNFILED_KEY) return -1;
      return (FY_MONTH_ORDER[a] || 99) - (FY_MONTH_ORDER[b] || 99);
    });
  }, [recoRows]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    recoRows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    return counts;
  }, [recoRows]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recoRows.filter((r) => {
      if (statusFilter !== 'All' && r.status !== statusFilter) return false;
      if (monthFilter !== 'All' && getEffectiveMonth(r) !== monthFilter) return false;
      if (!q) return true;
      return (
        r.itcInvoiceNo.toLowerCase().includes(q) ||
        r.booksInvoiceNo.toLowerCase().includes(q) ||
        r.itcPartyName.toLowerCase().includes(q) ||
        r.booksPartyName.toLowerCase().includes(q) ||
        r.itcGstin.toLowerCase().includes(q) ||
        r.booksGstin.toLowerCase().includes(q)
      );
    });
  }, [recoRows, statusFilter, monthFilter, search]);

  useEffect(() => {
    if (!actionMenuFor) return;
    const close = () => setActionMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [actionMenuFor]);

  // Running totals for the currently visible (filtered) rows — shown in the Δ strip.
  const visibleTotals = useMemo(() => {
    let itcTax = 0, booksTax = 0, dTax = 0;
    let overclaim = 0, unclaimed = 0;
    for (const r of visibleRows) {
      itcTax += r.itcTax;
      booksTax += r.booksTax;
      dTax += r.diffTax;
      if (r.diffTax > 0) overclaim += r.diffTax;
      if (r.diffTax < 0) unclaimed += -r.diffTax;
    }
    return { itcTax, booksTax, dTax, overclaim, unclaimed };
  }, [visibleRows]);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const groupedRows = useMemo(() => {
    const groups = new Map<string, { key: string; gstin: string; partyName: string; rows: RecoRow[] }>();
    visibleRows.forEach((r) => {
      const gstin = r.itcGstin || r.booksGstin || '';
      const party = r.itcPartyName || r.booksPartyName || '';
      const gk = normalizeGstin(gstin) || party.trim().toUpperCase() || 'UNKNOWN';
      if (!groups.has(gk)) groups.set(gk, { key: gk, gstin, partyName: party, rows: [] });
      groups.get(gk)!.rows.push(r);
    });
    return Array.from(groups.values()).sort((a, b) => {
      const aHasEx = a.rows.some((r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books');
      const bHasEx = b.rows.some((r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books');
      if (aHasEx !== bHasEx) return aHasEx ? -1 : 1;
      const aDiff = a.rows.reduce((s, r) => s + Math.abs(r.diffTax), 0);
      const bDiff = b.rows.reduce((s, r) => s + Math.abs(r.diffTax), 0);
      return bDiff - aDiff;
    });
  }, [visibleRows]);

  const handleCSVUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseItcCsv(text);
      setItcRows(parsed);
      setStatusFilter('All');
      setMonthFilter('All');
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  const handleExport = async () => {
    try {
      const visibleKeys = new Set<string>();
      visibleRows.forEach((r) => {
        const inv = r.itcInvoiceNo || r.booksInvoiceNo || '';
        const gstin = r.itcGstin || r.booksGstin || '';
        if (inv) visibleKeys.add(normalizeInv(inv) + '|' + normalizeGstin(gstin));
      });
      const filteredDoubleClaims = doubleClaims.filter((dc) =>
        visibleKeys.has(normalizeInv(dc.invoiceNo) + '|' + normalizeGstin(dc.gstin)),
      );
      await exportToExcel(visibleRows, filteredDoubleClaims, csvFileName, mode, {
        status: statusFilter,
        month: monthFilter,
        search,
      });
    } catch (err) {
      console.error(err);
      window.alert('Export failed. Please retry.');
    }
  };

  return (
    <div className="space-y-5">
      {/* Info + ledger status */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-blue-800 text-sm flex items-start gap-3">
        <Info size={15} className="mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">ITC vs 3B Reconciliation — B2B & RCM (tabbed)</p>
          <p className="text-xs">Full outer join across the year: every ITC line in your tracker matched against every Tally purchase voucher on invoice + GSTIN. B2B and RCM are reconciled separately — switch tabs below. Matching uses 5 tiers including last-6-digits fuzzy.</p>
          <p className="text-xs mt-1">
            {selectedLedgers.length > 0
              ? <span className="text-green-700 font-medium">✓ Using {selectedLedgers.length} purchase GST ledger{selectedLedgers.length > 1 ? 's' : ''} from your Purchase GST Register configuration.</span>
              : <span className="text-amber-700 font-medium">⚠ No purchase GST ledgers configured. Go to Purchase GST Register and select your input tax ledgers first — books-side IGST/CGST/SGST will show as 0 until then.</span>
            }
          </p>
          {sqlLoading && <p className="text-xs text-blue-600">Loading purchase data…</p>}
          {sqlError && <p className="text-xs text-red-600">{sqlError}</p>}
        </div>
      </div>

      {/* CSV Upload */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-700 mb-3">Upload ITC Tracker CSV</p>
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            {csvFileName ? 'Replace CSV' : 'Upload ITC Tracker CSV'}
          </button>
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleCSVUpload} />
          {csvFileName && (
            <span className="text-sm text-slate-600 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
              {csvFileName} — <span className="font-semibold text-indigo-700">{itcRows.filter((r) => r.type.toUpperCase() === 'B2B').length} B2B rows</span> loaded
            </span>
          )}
          {itcRows.length > 0 && (
            <span className="text-xs text-slate-400">
              ({itcRows.length} total rows in CSV; {itcRows.filter((r) => isUnfiledMonth(r.month3b)).length} unfiled)
            </span>
          )}
        </div>
      </div>

      {/* Mode tabs — visible whenever the CSV is loaded, even if current tab has 0 rows */}
      {itcRows.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-1 flex gap-1 w-fit">
          {([
            { key: 'b2b' as RecoMode, label: 'B2B (non-RCM)', count: modeCounts.b2b },
            { key: 'rcm' as RecoMode, label: 'Reverse Charge (RCM)', count: modeCounts.rcm },
          ]).map(({ key, label, count }) => {
            const active = mode === key;
            return (
              <button
                key={key}
                onClick={() => { setMode(key); setStatusFilter('All'); setMonthFilter('All'); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {label}
                <span className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded ${active ? 'bg-white/20' : 'bg-slate-200 text-slate-600'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {mode === 'rcm' && itcRows.length > 0 && rcmLedgers.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-800 text-xs flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>RCM tab active but no RCM tax ledgers are configured. Go to the RCM Analysis module and select your RCM tax ledgers — otherwise books-side RCM vouchers and tax totals will be empty.</span>
        </div>
      )}

      {/* ─── Results ─── */}
      {recoRows.length > 0 ? (
        <>
          {/* Double Claim Alert */}
          {doubleClaims.length > 0 && (
            <div className="bg-red-50 border border-red-300 rounded-xl p-4">
              <div className="flex items-center gap-2 text-red-800 font-semibold text-sm mb-3">
                <AlertTriangle size={16} />
                {doubleClaims.length} Double Claim{doubleClaims.length > 1 ? 's' : ''} Detected — Same invoice filed in multiple 3B months
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-red-100">
                      <th className="p-2 text-left">Invoice No.</th>
                      <th className="p-2 text-left">GSTIN</th>
                      <th className="p-2 text-left">Party</th>
                      <th className="p-2 text-left">3B Month</th>
                      <th className="p-2 text-right">Taxable</th>
                      <th className="p-2 text-right">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doubleClaims.map((dc) =>
                      dc.occurrences.map((occ, oi) => (
                        <tr key={`${dc.key}-${oi}`} className="border-t border-red-200">
                          <td className="p-2 font-mono font-semibold text-red-900">{oi === 0 ? dc.invoiceNo : ''}</td>
                          <td className="p-2 font-mono">{oi === 0 ? dc.gstin : ''}</td>
                          <td className="p-2">{oi === 0 ? dc.partyName : ''}</td>
                          <td className="p-2 font-semibold text-red-700">{occ.month3b}</td>
                          <td className="p-2 text-right">{fmtAmt(occ.taxable)}</td>
                          <td className="p-2 text-right font-semibold">{fmtAmt(occ.tax)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Net ITC Position */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Filed & Clean', sub: 'Matched + Deferred', d: netPosition.clean, bg: 'bg-green-50 border-green-200', hdr: 'text-green-800', amt: 'text-green-700' },
              { label: 'Needs Review', sub: 'Amt Mismatch + Only in ITC', d: netPosition.review, bg: 'bg-red-50 border-red-200', hdr: 'text-red-800', amt: 'text-red-700' },
              { label: 'Unclaimed ITC', sub: 'In Books, not in 3B', d: netPosition.unclaimed, bg: 'bg-indigo-50 border-indigo-200', hdr: 'text-indigo-800', amt: 'text-indigo-700' },
              { label: 'Unfiled / Pending', sub: '3B Month = NA', d: netPosition.unfiled, bg: 'bg-slate-100 border-slate-200', hdr: 'text-slate-700', amt: 'text-slate-600' },
            ].map(({ label, sub, d, bg, hdr, amt }) => (
              <div key={label} className={`rounded-xl border p-4 ${bg}`}>
                <p className={`text-xs font-semibold uppercase tracking-wide ${hdr}`}>{label}</p>
                <p className="text-xs text-slate-500 mt-0.5">{sub}</p>
                <p className={`text-2xl font-bold mt-2 ${hdr}`}>{d.count.toLocaleString('en-IN')}</p>
                <p className="text-xs text-slate-500 mt-1">invoices</p>
                <div className="mt-2 pt-2 border-t border-white/50 space-y-0.5">
                  <p className={`text-xs font-medium ${amt}`}>Taxable ₹{fmtAmt(d.taxable)}</p>
                  <p className={`text-xs font-semibold ${amt}`}>Tax ₹{fmtAmt(d.tax)}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Month Summary */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <button onClick={() => setShowMonthSummary((v) => !v)}
              className="w-full flex items-center justify-between p-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              Month-wise Summary
              <span className="text-xs text-slate-400 font-normal">{showMonthSummary ? 'hide ▲' : 'show ▼'}</span>
            </button>
            {showMonthSummary && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-t border-slate-200">
                    <tr>
                      <th className="p-2 text-left">Month</th>
                      <th className="p-2 text-right">3B Rows</th>
                      <th className="p-2 text-right">3B Taxable</th>
                      <th className="p-2 text-right">3B Tax</th>
                      <th className="p-2 text-right">Tally Rows</th>
                      <th className="p-2 text-right">Tally Taxable</th>
                      <th className="p-2 text-right">Tally Tax</th>
                      <th className="p-2 text-right">Matched</th>
                      <th className="p-2 text-right">Exceptions</th>
                      <th className="p-2 text-right">Δ Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthSummaryRows.map(({ mo, ic, it, ita, bc, bt, bta, m, ex, diff }) => (
                      <tr key={mo} className={`border-t ${ex > 0 ? 'bg-amber-50' : ''}`}>
                        <td className="p-2 font-medium">{mo === UNFILED_KEY ? 'Unfiled (NA)' : mo}</td>
                        <td className="p-2 text-right">{ic}</td>
                        <td className="p-2 text-right">{fmtAmt(it)}</td>
                        <td className="p-2 text-right font-medium">{fmtAmt(ita)}</td>
                        <td className="p-2 text-right">{bc}</td>
                        <td className="p-2 text-right">{fmtAmt(bt)}</td>
                        <td className="p-2 text-right font-medium">{fmtAmt(bta)}</td>
                        <td className="p-2 text-right text-green-700">{m}</td>
                        <td className={`p-2 text-right font-semibold ${ex > 0 ? 'text-red-700' : 'text-slate-400'}`}>{ex}</td>
                        <td className={`p-2 text-right font-semibold ${Math.abs(diff) > 1 ? (diff > 0 ? 'text-red-700' : 'text-indigo-700') : 'text-slate-400'}`}>
                          {diff > 0.005 ? '+' : ''}{fmtAmt(diff)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Filters + Export Bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-2 items-center">
            <button onClick={handleExport} className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-2 font-medium" title={
              (statusFilter !== 'All' || monthFilter !== 'All' || search.trim())
                ? `Exports only the ${visibleRows.length} visible rows matching current filters`
                : 'Exports all reconciliation rows'
            }>
              <Download size={14} /> Export Excel
              {(statusFilter !== 'All' || monthFilter !== 'All' || search.trim()) && (
                <span className="text-[10px] bg-white/25 px-1.5 py-0.5 rounded font-semibold">Filtered · {visibleRows.length}</span>
              )}
            </button>
            <div className="relative">
              <Search size={13} className="absolute left-2 top-2.5 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party / invoice / GSTIN" className="pl-7 pr-3 py-2 border border-slate-300 rounded text-sm w-64" />
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="px-2 py-2 border border-slate-300 rounded text-sm">
              <option value="All">All Statuses</option>
              {(Object.keys(STATUS_CFG) as RecoStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_CFG[s].label} ({statusCounts[s] || 0})</option>
              ))}
            </select>
            <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="px-2 py-2 border border-slate-300 rounded text-sm">
              <option value="All">All Months</option>
              {monthOptions.map((m) => <option key={m} value={m}>{m === UNFILED_KEY ? 'Unfiled (NA)' : m}</option>)}
            </select>
            <div className="flex items-center gap-1 px-2 py-1.5 border border-slate-300 rounded text-xs" title="Match tolerance — differences within this band are treated as Matched.">
              <span className="text-slate-500">Tol</span>
              <input
                type="number" min={0} step={0.1}
                value={tolerance.pct}
                onChange={(e) => setTolerance({ ...tolerance, pct: Math.max(0, Number(e.target.value) || 0) })}
                className="w-12 px-1 py-0.5 border border-slate-200 rounded text-right"
              />
              <span className="text-slate-400">%</span>
              <span className="text-slate-300 mx-0.5">/</span>
              <span className="text-slate-500">min ₹</span>
              <input
                type="number" min={0} step={1}
                value={tolerance.abs}
                onChange={(e) => setTolerance({ ...tolerance, abs: Math.max(0, Number(e.target.value) || 0) })}
                className="w-14 px-1 py-0.5 border border-slate-200 rounded text-right"
              />
            </div>
            <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer px-2 py-1.5 border border-slate-300 rounded" title="Include rows where both 3B and books tax are near zero (nil-rated / exempt purchases).">
              <input type="checkbox" checked={includeNilTax} onChange={(e) => setIncludeNilTax(e.target.checked)} />
              Include nil-tax rows
              {!includeNilTax && nilTaxHidden > 0 && (
                <span className="text-[10px] text-slate-400">({nilTaxHidden} hidden)</span>
              )}
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer px-2 py-1.5 border border-slate-300 rounded" title="Show IGST/CGST/SGST breakup alongside the combined Tax column.">
              <input type="checkbox" checked={showTaxSplit} onChange={(e) => setShowTaxSplit(e.target.checked)} />
              Show tax split
            </label>
            <button
              onClick={() => setExpandedGroups(expandedGroups.size === groupedRows.length ? new Set() : new Set(groupedRows.map((g) => g.key)))}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50"
            >
              {expandedGroups.size === groupedRows.length && groupedRows.length > 0 ? 'Collapse All' : 'Expand All'}
            </button>
            <span className="ml-auto text-xs text-slate-500">{groupedRows.length} parties · {visibleRows.length} invoices</span>
          </div>

          {/* Δ legend + filtered totals strip */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 flex flex-wrap gap-4 items-center text-xs">
            <span className="text-slate-400 font-semibold uppercase tracking-wide">Filtered totals</span>
            <span className="text-slate-600">3B Tax <span className="font-semibold text-rose-800">₹{fmtAmt(visibleTotals.itcTax)}</span></span>
            <span className="text-slate-600">Books Tax <span className="font-semibold text-sky-800">₹{fmtAmt(visibleTotals.booksTax)}</span></span>
            <span className="text-slate-600">Δ Tax <span className={`font-bold ${Math.abs(visibleTotals.dTax) < 1 ? 'text-slate-500' : visibleTotals.dTax > 0 ? 'text-red-700' : 'text-indigo-700'}`}>{visibleTotals.dTax > 0 ? '+' : ''}₹{fmtAmt(visibleTotals.dTax)}</span></span>
            <span className="ml-auto flex gap-3">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-600 inline-block" /><span className="text-slate-500">3B &gt; Books → potential overclaim ₹{fmtAmt(visibleTotals.overclaim)}</span></span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-indigo-600 inline-block" /><span className="text-slate-500">Books &gt; 3B → unclaimed ITC ₹{fmtAmt(visibleTotals.unclaimed)}</span></span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-slate-300 inline-block" /><span className="text-slate-500">within tolerance</span></span>
            </span>
          </div>

          {/* Main Reconciliation Table — grouped by GSTIN / Party */}
          {(() => {
            const splitCols = showTaxSplit ? 3 : 0;         // extra cols per side when IGST/CGST/SGST shown
            const threeBCols = 5 + splitCols;               // Invoice, Date, Month, Taxable [IGST CGST SGST] Tax + Action
            const tallyCols = 5 + splitCols;
            const totalCols = 3 /*sticky*/ + threeBCols + tallyCols + 2 /*Δ*/ + 1 /*action*/;
            return (
          <div className="bg-white border border-slate-200 rounded-xl overflow-auto">
            <table className={`w-full text-xs ${showTaxSplit ? 'min-w-[2000px]' : 'min-w-[1600px]'}`}>
              <thead className="bg-slate-900 text-white sticky top-0 z-10">
                <tr className="text-[10px] uppercase tracking-wide">
                  <th className="p-1 text-left" colSpan={3}></th>
                  <th className="p-1 text-center bg-rose-900/40 border-l border-r border-slate-700" colSpan={threeBCols}>GSTR-3B / 2B (ITC claimed)</th>
                  <th className="p-1 text-center bg-sky-900/40 border-r border-slate-700" colSpan={tallyCols}>Tally / Books (ITC recorded)</th>
                  <th className="p-1 text-center bg-amber-900/40" colSpan={2}>Δ (3B − Books)</th>
                  <th className="p-1"></th>
                </tr>
                <tr>
                  <th className="p-2 text-left whitespace-nowrap sticky left-0 bg-slate-900 z-20" style={{ minWidth: 200 }}>Status / Reason</th>
                  <th className="p-2 text-left whitespace-nowrap">Party Name</th>
                  <th className="p-2 text-left whitespace-nowrap">GSTIN</th>
                  <th className="p-2 text-left whitespace-nowrap border-l border-slate-700">3B Invoice</th>
                  <th className="p-2 text-left whitespace-nowrap">3B Date</th>
                  <th className="p-2 text-left whitespace-nowrap">3B Month</th>
                  <th className="p-2 text-right whitespace-nowrap">3B Taxable</th>
                  {showTaxSplit && <><th className="p-2 text-right whitespace-nowrap">3B IGST</th><th className="p-2 text-right whitespace-nowrap">3B CGST</th><th className="p-2 text-right whitespace-nowrap">3B SGST</th></>}
                  <th className="p-2 text-right whitespace-nowrap">3B Tax</th>
                  <th className="p-2 text-left whitespace-nowrap border-l border-slate-700">Tally Invoice</th>
                  <th className="p-2 text-left whitespace-nowrap">Tally Date</th>
                  <th className="p-2 text-left whitespace-nowrap" title="Tally Month = the month in which the voucher is posted in TallyPrime">Tally Month ⓘ</th>
                  <th className="p-2 text-right whitespace-nowrap">Tally Taxable</th>
                  {showTaxSplit && <><th className="p-2 text-right whitespace-nowrap">Tally IGST</th><th className="p-2 text-right whitespace-nowrap">Tally CGST</th><th className="p-2 text-right whitespace-nowrap">Tally SGST</th></>}
                  <th className="p-2 text-right whitespace-nowrap">Tally Tax</th>
                  <th className="p-2 text-right whitespace-nowrap border-l border-slate-700">Δ Taxable</th>
                  <th className="p-2 text-right whitespace-nowrap">Δ Tax</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map((grp) => {
                  const grpHasEx = grp.rows.some((r) => r.status === 'Amount Mismatch' || r.status === 'Only in ITC' || r.status === 'Only in Books');
                  const grpTaxable3b = grp.rows.reduce((s, r) => s + r.itcTaxable, 0);
                  const grpTax3b = grp.rows.reduce((s, r) => s + r.itcTax, 0);
                  const grpTaxableTally = grp.rows.reduce((s, r) => s + r.booksTaxable, 0);
                  const grpTaxTally = grp.rows.reduce((s, r) => s + r.booksTax, 0);
                  const grpDiffTaxable = grp.rows.reduce((s, r) => s + r.diffTaxable, 0);
                  const grpDiffTax = grp.rows.reduce((s, r) => s + r.diffTax, 0);
                  const isExp = expandedGroups.has(grp.key);
                  const grpBg = grpHasEx ? 'bg-amber-50 hover:bg-amber-100' : 'bg-slate-50 hover:bg-slate-100';
                  const stickyGrpBg = grpHasEx ? 'bg-amber-50' : 'bg-slate-50';
                  const stCounts: Partial<Record<RecoStatus, number>> = {};
                  grp.rows.forEach((r) => { stCounts[r.status] = (stCounts[r.status] || 0) + 1; });
                  const diffClr = (v: number) => Math.abs(v) > 20 ? (v > 0 ? 'text-red-700' : 'text-indigo-700') : 'text-slate-400';
                  return (
                    <React.Fragment key={grp.key}>
                      {/* Group header */}
                      <tr className={`border-t border-slate-200 cursor-pointer ${grpBg} font-medium`} onClick={() => toggleGroup(grp.key)}>
                        <td className={`p-2 whitespace-nowrap sticky left-0 z-10 ${stickyGrpBg}`}>
                          <div className="flex items-center gap-2">
                            <span className="text-slate-400 text-[10px] w-3">{isExp ? '▼' : '▶'}</span>
                            <span className="font-mono text-[10px] text-slate-600">{grp.gstin || '—'}</span>
                            <span className="font-semibold text-slate-800 text-xs truncate max-w-[200px]">{grp.partyName || '—'}</span>
                            <span className="text-[10px] text-slate-400 shrink-0">({grp.rows.length})</span>
                          </div>
                        </td>
                        <td className="p-2" colSpan={2}>
                          <div className="flex flex-wrap gap-1">
                            {(Object.entries(stCounts) as [RecoStatus, number][]).map(([st, cnt]) => (
                              <span key={st} className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${STATUS_CFG[st].pill}`}>{cnt} {STATUS_CFG[st].label}</span>
                            ))}
                          </div>
                        </td>
                        <td className="p-2 border-l border-slate-200" colSpan={3}></td>
                        <td className="p-2 text-right font-semibold text-rose-900">{fmtAmt(grpTaxable3b)}</td>
                        {showTaxSplit && <><td></td><td></td><td></td></>}
                        <td className="p-2 text-right font-semibold text-rose-900">{fmtAmt(grpTax3b)}</td>
                        <td className="p-2 border-l border-slate-200" colSpan={3}></td>
                        <td className="p-2 text-right font-semibold text-sky-900">{fmtAmt(grpTaxableTally)}</td>
                        {showTaxSplit && <><td></td><td></td><td></td></>}
                        <td className="p-2 text-right font-semibold text-sky-900">{fmtAmt(grpTaxTally)}</td>
                        <td className={`p-2 text-right font-bold border-l border-slate-200 ${diffClr(grpDiffTaxable)}`}>
                          {grpDiffTaxable > 0.005 ? '+' : ''}{fmtAmt(grpDiffTaxable)}
                        </td>
                        <td className={`p-2 text-right font-bold ${diffClr(grpDiffTax)}`}>
                          {grpDiffTax > 0.005 ? '+' : ''}{fmtAmt(grpDiffTax)}
                        </td>
                        <td></td>
                      </tr>
                      {/* Detail rows (when expanded) */}
                      {isExp && grp.rows.map((r) => {
                        const cfg = STATUS_CFG[r.status];
                        const monthMismatch = r.status === 'Deferred Claim';
                        const diffColor = (v: number) =>
                          Math.abs(v) <= 20 ? '' : v > 0 ? 'text-red-700 font-semibold' : 'text-indigo-700 font-semibold';
                        const invMismatch = r.booksInvoiceNo && r.itcInvoiceNo && r.booksInvoiceNo !== r.itcInvoiceNo;
                        const stickyBg = cfg.rowBg || 'bg-white';
                        return (
                          <tr key={r.id} className={`border-t border-slate-100 ${cfg.rowBg}`}>
                            <td className={`p-2 pl-7 whitespace-nowrap sticky left-0 z-10 ${stickyBg}`}>
                              <div className="flex flex-col gap-0.5">
                                <span className="flex items-center gap-1">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${cfg.pill}`}>{cfg.label}</span>
                                  {r.matchTier === 'aggressive' && <span className="text-[9px] text-slate-400" title="Fuzzy match (aggressive normalize or last-6-digits)">~</span>}
                                  {r.matchTier === 'invoice-only' && <span className="text-[9px] text-amber-500" title="Matched on invoice only — GSTIN missing in 3B">GSTIN?</span>}
                                </span>
                                {r.reason && <span className="text-[9px] text-slate-500 truncate max-w-[240px]" title={r.reason}>{r.reason}</span>}
                              </div>
                            </td>
                            <td className="p-2 max-w-[140px] truncate text-[10px] text-slate-400" title={r.itcPartyName || r.booksPartyName || ''}>{r.itcPartyName || r.booksPartyName || '—'}</td>
                            <td className="p-2 font-mono text-[10px] text-slate-400">{r.itcGstin || r.booksGstin || '—'}</td>
                            {/* 3B block */}
                            <td className="p-2 font-mono text-[10px] border-l border-slate-200">{r.itcInvoiceNo || '—'}</td>
                            <td className="p-2 whitespace-nowrap">{r.itcDate || '—'}</td>
                            <td className="p-2 whitespace-nowrap">{r.itcMonth3b || '—'}</td>
                            <td className="p-2 text-right">{r.itcTaxable ? fmtAmt(r.itcTaxable) : '—'}</td>
                            {showTaxSplit && <>
                              <td className="p-2 text-right">{r.itcIgst ? fmtAmt(r.itcIgst) : '—'}</td>
                              <td className="p-2 text-right">{r.itcCgst ? fmtAmt(r.itcCgst) : '—'}</td>
                              <td className="p-2 text-right">{r.itcSgst ? fmtAmt(r.itcSgst) : '—'}</td>
                            </>}
                            <td className="p-2 text-right font-medium" title={!showTaxSplit ? `IGST ${fmtAmt(r.itcIgst)} / CGST ${fmtAmt(r.itcCgst)} / SGST ${fmtAmt(r.itcSgst)}` : ''}>{r.itcTax ? fmtAmt(r.itcTax) : '—'}</td>
                            {/* Tally / Books block */}
                            <td className={`p-2 font-mono text-[10px] border-l border-slate-200 ${invMismatch ? 'text-amber-700' : ''}`}>{r.booksInvoiceNo || '—'}</td>
                            <td className="p-2 whitespace-nowrap">{r.booksDate || '—'}</td>
                            <td className={`p-2 whitespace-nowrap ${monthMismatch ? 'text-blue-700 font-semibold' : ''}`}>{r.booksBooksMonth || '—'}</td>
                            <td className="p-2 text-right">{r.booksTaxable ? fmtAmt(r.booksTaxable) : '—'}</td>
                            {showTaxSplit && <>
                              <td className="p-2 text-right">{r.booksIgst ? fmtAmt(r.booksIgst) : '—'}</td>
                              <td className="p-2 text-right">{r.booksCgst ? fmtAmt(r.booksCgst) : '—'}</td>
                              <td className="p-2 text-right">{r.booksSgst ? fmtAmt(r.booksSgst) : '—'}</td>
                            </>}
                            <td className="p-2 text-right font-medium" title={!showTaxSplit ? `IGST ${fmtAmt(r.booksIgst)} / CGST ${fmtAmt(r.booksCgst)} / SGST ${fmtAmt(r.booksSgst)}` : ''}>{r.booksTax ? fmtAmt(r.booksTax) : '—'}</td>
                            {/* Δ block */}
                            <td className={`p-2 text-right border-l border-slate-200 ${diffColor(r.diffTaxable)}`}>
                              {r.status === 'Matched' ? '—' : (r.diffTaxable > 0.005 ? '+' : '') + fmtAmt(r.diffTaxable)}
                            </td>
                            <td className={`p-2 text-right ${diffColor(r.diffTax)}`}>
                              {r.status === 'Matched' ? '—' : (r.diffTax > 0.005 ? '+' : '') + fmtAmt(r.diffTax)}
                            </td>
                            {/* Row action menu */}
                            <td className="p-1 text-right relative">
                              <button
                                className="px-1.5 py-0.5 rounded hover:bg-slate-200 text-slate-400 text-xs"
                                onClick={(e) => { e.stopPropagation(); setActionMenuFor(actionMenuFor === r.id ? null : r.id); }}
                                title="Row actions"
                              >⋯</button>
                              {actionMenuFor === r.id && (
                                <div className="absolute right-2 top-6 z-30 bg-white border border-slate-200 rounded-lg shadow-lg text-left text-xs w-56 py-1" onClick={(e) => e.stopPropagation()}>
                                  <button className="w-full px-3 py-1.5 hover:bg-slate-50 block text-slate-700"
                                    onClick={() => {
                                      const txt = [r.itcGstin, r.itcPartyName, r.itcInvoiceNo, r.itcDate, r.itcMonth3b, r.itcTaxable, r.itcIgst, r.itcCgst, r.itcSgst, r.itcTax].join('\t');
                                      navigator.clipboard?.writeText(txt); setActionMenuFor(null);
                                    }}>Copy 3B row (TSV)</button>
                                  <button className="w-full px-3 py-1.5 hover:bg-slate-50 block text-slate-700"
                                    onClick={() => {
                                      const txt = [r.booksGstin, r.booksPartyName, r.booksInvoiceNo, r.booksDate, r.booksBooksMonth, r.booksTaxable, r.booksIgst, r.booksCgst, r.booksSgst, r.booksTax].join('\t');
                                      navigator.clipboard?.writeText(txt); setActionMenuFor(null);
                                    }}>Copy Books row (TSV)</button>
                                  <button className="w-full px-3 py-1.5 hover:bg-slate-50 block text-slate-700"
                                    onClick={() => {
                                      navigator.clipboard?.writeText(r.itcInvoiceNo || r.booksInvoiceNo || ''); setActionMenuFor(null);
                                    }}>Copy invoice number</button>
                                  <button className="w-full px-3 py-1.5 hover:bg-slate-50 block text-slate-700"
                                    onClick={() => {
                                      navigator.clipboard?.writeText(r.itcGstin || r.booksGstin || ''); setActionMenuFor(null);
                                    }}>Copy GSTIN</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
                {groupedRows.length === 0 && (
                  <tr><td colSpan={totalCols} className="p-10 text-center text-slate-400">No rows match current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
            );
          })()}
        </>
      ) : (
        itcRows.length > 0 && (
          <div className="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-10 text-center text-slate-400 text-sm">
            No {mode === 'rcm' ? 'Reverse Charge (RCM)' : 'B2B (non-RCM)'} rows in this reconciliation.
            {mode === 'rcm' && ' Your ITC CSV has no RCM-type rows and your books have no RCM vouchers for the selected RCM ledgers.'}
          </div>
        )
      )}

      {itcRows.length === 0 && (
        <div className="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-10 text-center text-slate-400 text-sm">
          Upload your ITC tracker CSV above to start the reconciliation.
        </div>
      )}
    </div>
  );
};

export default ITC3BReconciliation;
