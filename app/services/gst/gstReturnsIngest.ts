// Ingestion + normalisation for GST return JSONs downloaded from the GST portal.
//
// Takes raw bytes (not browser File objects) so the headless validator can drive
// exactly the same code path the UI does. Handles portal ZIPs, ZIPs inside ZIPs,
// chunked downloads, duplicate periods and the QRMP overlap.
//
// Everything here is defensive by design: GSTN omits rather than zeroes, third-party
// tools emit quoted numbers, and several documented fields have no published
// enumeration. Unknown codes are carried through as raw strings — never rejected.

import JSZip from 'jszip';

// ─── numeric + period helpers ────────────────────────────────────────────────

/** GSTN emits int/float inconsistently; third-party tools sometimes quote numbers. */
const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

export interface TaxHeads { igst: number; cgst: number; sgst: number; cess: number }
export interface ValueWithTax extends TaxHeads { taxable: number }

export const zeroTax = (): TaxHeads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
export const zeroValue = (): ValueWithTax => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

/** GSTR-1/3B use iamt/camt/samt/csamt; GSTR-2B and supeco use the long names. */
const heads = (o: any): TaxHeads => ({
  igst: num(o?.iamt ?? o?.igst),
  cgst: num(o?.camt ?? o?.cgst),
  sgst: num(o?.samt ?? o?.sgst),
  cess: num(o?.csamt ?? o?.cess),
});

const addValue = (acc: ValueWithTax, taxable: number, h: TaxHeads): void => {
  acc.taxable += taxable; acc.igst += h.igst; acc.cgst += h.cgst; acc.sgst += h.sgst; acc.cess += h.cess;
};
export const addInto = (acc: ValueWithTax, v: ValueWithTax): void => addValue(acc, v.taxable, v);
export const sumValues = (vs: ValueWithTax[]): ValueWithTax =>
  vs.reduce((a, v) => { addInto(a, v); return a; }, zeroValue());
export const subValue = (a: ValueWithTax, b: ValueWithTax): ValueWithTax => ({
  taxable: a.taxable - b.taxable, igst: a.igst - b.igst, cgst: a.cgst - b.cgst,
  sgst: a.sgst - b.sgst, cess: a.cess - b.cess,
});
export const totalTax = (v: TaxHeads): number => v.igst + v.cgst + v.sgst + v.cess;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Return periods are always MMYYYY — month first. Never YYYYMM. */
export const parsePeriod = (p: unknown): { mm: number; yyyy: number } | null => {
  if (typeof p !== 'string' || !/^(0[1-9]|1[0-2])\d{4}$/.test(p)) return null;
  return { mm: Number(p.slice(0, 2)), yyyy: Number(p.slice(2)) };
};
/** Indian financial year starts in April. */
export const fyStartOf = (mm: number, yyyy: number): number => (mm >= 4 ? yyyy : yyyy - 1);
export const fyLabel = (start: number): string => `FY ${start}-${String(start + 1).slice(2)}`;
export const fyShort = (start: number): string => `FY${String(start).slice(2)}-${String(start + 1).slice(2)}`;
/** Apr = 0 … Mar = 11, so chronological sorting follows the financial year. */
export const monthIndexOf = (mm: number): number => (mm + 8) % 12;
export const monthLabel = (period: string): string => {
  const p = parsePeriod(period);
  return p ? `${MONTHS[p.mm - 1]} ${p.yyyy}` : period;
};
/** Quarter index within the FY: Apr-Jun = 0 … Jan-Mar = 3. */
export const quarterOf = (mm: number): number => Math.floor(monthIndexOf(mm) / 3);
export const QUARTER_LABELS = ['Q1 (Apr-Jun)', 'Q2 (Jul-Sep)', 'Q3 (Oct-Dec)', 'Q4 (Jan-Mar)'];
const QUARTER_END_MONTHS = new Set([3, 6, 9, 12]);

// ─── public types ────────────────────────────────────────────────────────────

export type GstFormKind = 'GSTR1' | 'GSTR3B' | 'GSTR2B';
export type Gstr1SectionKind = 'outward' | 'note' | 'advance' | 'advance-adj' | 'memo';

export interface Gstr1SectionTotal {
  key: string;
  label: string;
  kind: Gstr1SectionKind;
  total: ValueWithTax;   // raw sum exactly as stored — no sign flips
  cSum?: ValueWithTax;   // credit notes (ntty 'C')
  dSum?: ValueWithTax;   // debit notes  (ntty 'D')
  docCount: number;
}

export interface Gstr1Period {
  form: 'GSTR1';
  gstin: string;
  period: string;
  fyStart: number;
  fy: string;
  monthIndex: number;
  quarter: number;
  filingTyp?: string;
  filed: boolean;
  /** IFF cannot be identified from any key — this is a heuristic LABEL, never an arithmetic branch. */
  iffInferred: boolean;
  quarterly: boolean;
  sections: Gstr1SectionTotal[];
  netOutward: ValueWithTax;
  docIssue?: { issued: number; cancelled: number; net: number };
  nil?: { nilAmt: number; exptAmt: number; ngsupAmt: number };
  hsnTaxable?: number;
  b2bInvCount: number;
  cdnrNoteCount: number;
  qrmpDedupedDocs: number;
  warnings: string[];
  sourceFiles: string[];
}

export interface Gstr3bPeriod {
  form: 'GSTR3B';
  gstin: string; period: string; fyStart: number; fy: string; monthIndex: number; quarter: number;
  filed: true;
  outwardTaxable: ValueWithTax;
  outwardZero: ValueWithTax;
  nilExempt: number;
  nonGst: number;
  inwardRcm: ValueWithTax;
  eco?: { ecoSup: ValueWithTax; ecoRegSupTaxable: number };
  itcAvail: Record<string, TaxHeads>;
  itcRev: Record<string, TaxHeads>;
  itcNet: TaxHeads;
  itcInelig: Record<string, TaxHeads>;
  interest: TaxHeads;
  lateFee: TaxHeads;
  ttVal?: { pay: number; cash: number; itc: number };
  warnings: string[];
  sourceFiles: string[];
}

export type B2Bucket = 'itcavl' | 'itcunavl' | 'itcrev' | 'itcRejected';
export interface Gstr2bSummRow { bucket: B2Bucket; group: string; section: string; total: ValueWithTax }

export interface Gstr2bPeriod {
  form: 'GSTR2B';
  gstin: string; period: string; fyStart: number; fy: string; monthIndex: number; quarter: number;
  filed: true;
  gendt?: string;
  rows: Gstr2bSummRow[];
  bucketTotals: Record<B2Bucket, ValueWithTax>;
  docCounts: { b2bAvl: number; b2bUnavl: number; cdnr: number; isd: number; impg: number; impgsez: number; other: number };
  unavailReasons: Record<string, number>;
  imsStatuses: Record<string, number>;
  docdataTaxable: number;
  crossCheckOk: boolean;
  crossCheckDelta: number;
  warnings: string[];
  sourceFiles: string[];
}

export interface GstFileReport {
  sourceName: string;
  status: 'ok' | 'rejected' | 'duplicate-ignored' | 'superseded';
  detectedAs?: string;
  period?: string;
  fy?: string;
  filed?: boolean;
  reason?: string;
  warnings: string[];
}

export interface GstDataset {
  gstin: string | null;
  r1: Gstr1Period[];
  b3: Gstr3bPeriod[];
  b2: Gstr2bPeriod[];
  reports: GstFileReport[];
  warnings: string[];
}

export interface GstSourceInput { name: string; bytes: Uint8Array }

// ─── GSTR-1 section catalogue ────────────────────────────────────────────────

interface SectionSpec { key: string; label: string; kind: Gstr1SectionKind }

const R1_SECTIONS: SectionSpec[] = [
  { key: 'b2b', label: 'B2B supplies (4A/4B/6B/6C)', kind: 'outward' },
  { key: 'b2ba', label: 'B2B amendments (9A)', kind: 'outward' },
  { key: 'b2cl', label: 'B2C large (5)', kind: 'outward' },
  { key: 'b2cla', label: 'B2C large amendments (10)', kind: 'outward' },
  { key: 'b2cs', label: 'B2C others (7)', kind: 'outward' },
  { key: 'b2csa', label: 'B2C others amendments (10)', kind: 'outward' },
  { key: 'exp', label: 'Exports (6A)', kind: 'outward' },
  { key: 'expa', label: 'Export amendments (9A)', kind: 'outward' },
  { key: 'cdnr', label: 'Credit/debit notes — registered (9B)', kind: 'note' },
  { key: 'cdnra', label: 'CDN registered amendments (9C)', kind: 'note' },
  { key: 'cdnur', label: 'Credit/debit notes — unregistered (9B)', kind: 'note' },
  { key: 'cdnura', label: 'CDN unregistered amendments (9C)', kind: 'note' },
  { key: 'at', label: 'Advances received (11A)', kind: 'advance' },
  { key: 'ata', label: 'Advances received — amendments', kind: 'advance' },
  { key: 'txpd', label: 'Advances adjusted (11B)', kind: 'advance-adj' },
  { key: 'txpda', label: 'Advances adjusted — amendments', kind: 'advance-adj' },
  { key: 'nil', label: 'Nil-rated / exempt / non-GST (8)', kind: 'memo' },
  { key: 'hsn', label: 'HSN summary (12)', kind: 'memo' },
  { key: 'doc_issue', label: 'Documents issued (13)', kind: 'memo' },
  { key: 'supeco', label: 'E-commerce operator supplies (14)', kind: 'memo' },
  { key: 'supecoa', label: 'E-commerce amendments (14A)', kind: 'memo' },
  { key: 'ecom', label: 'ECO reporting u/s 9(5) (15)', kind: 'memo' },
  { key: 'ecoma', label: 'ECO reporting amendments (15A)', kind: 'memo' },
];
const R1_SECTION_KEYS = new Set(R1_SECTIONS.map((s) => s.key));
/** The only sections an IFF can contain (Rule 59(2) — supplies to registered persons). */
const IFF_ALLOWED = new Set(['b2b', 'b2ba', 'cdnr', 'cdnra']);
const R1_HEADER_KEYS = new Set(['gstin', 'fp', 'filing_typ', 'gt', 'cur_gt', 'fil_dt', 'version', 'hash', 'chksum']);

// ─── GSTR-1 section extraction ───────────────────────────────────────────────
//
// Each container has its own shape and several of them are genuine traps:
// cdnr uses `nt` not `inv`; exp's `itms` is flat with no `itm_det` wrapper;
// b2cs is flat rate-wise rows with no invoice at all; advances use `ad_amt`.

const itemDetInto = (acc: ValueWithTax, itms: any): void => {
  for (const it of Array.isArray(itms) ? itms : []) {
    // b2b-family nests amounts under itm_det; exp-family puts them straight on the item.
    const det = it?.itm_det ?? it;
    addValue(acc, num(det?.txval), heads(det));
  }
};

const extractSection = (key: string, raw: any, warn: (m: string) => void): Gstr1SectionTotal | null => {
  const spec = R1_SECTIONS.find((s) => s.key === key)!;
  const total = zeroValue();
  let docCount = 0;
  let cSum: ValueWithTax | undefined;
  let dSum: ValueWithTax | undefined;

  const noteInto = (ntty: unknown, itms: any): void => {
    const bucket = String(ntty ?? '').toUpperCase() === 'C'
      ? (cSum ??= zeroValue())
      : (dSum ??= zeroValue());
    itemDetInto(bucket, itms);
  };

  switch (key) {
    case 'b2b': case 'b2ba': case 'b2cl': case 'b2cla': {
      for (const grp of Array.isArray(raw) ? raw : []) {
        for (const inv of grp?.inv ?? []) { docCount++; itemDetInto(total, inv?.itms); }
      }
      break;
    }
    case 'b2cs': {
      // Flat rate-wise rows — no invoice wrapper, no `val`.
      for (const row of Array.isArray(raw) ? raw : []) { docCount++; addValue(total, num(row?.txval), heads(row)); }
      break;
    }
    case 'b2csa': {
      // Amendment variant moves the amounts into an itms[] array.
      for (const row of Array.isArray(raw) ? raw : []) {
        docCount++;
        if (Array.isArray(row?.itms)) itemDetInto(total, row.itms);
        else addValue(total, num(row?.txval), heads(row));
      }
      break;
    }
    case 'exp': case 'expa': {
      for (const grp of Array.isArray(raw) ? raw : []) {
        for (const inv of grp?.inv ?? []) { docCount++; itemDetInto(total, inv?.itms); }
      }
      break;
    }
    case 'cdnr': case 'cdnra': {
      for (const grp of Array.isArray(raw) ? raw : []) {
        for (const nt of grp?.nt ?? []) { docCount++; itemDetInto(total, nt?.itms); noteInto(nt?.ntty, nt?.itms); }
      }
      break;
    }
    case 'cdnur': case 'cdnura': {
      // Flat — no counterparty wrapper.
      for (const nt of Array.isArray(raw) ? raw : []) { docCount++; itemDetInto(total, nt?.itms); noteInto(nt?.ntty, nt?.itms); }
      break;
    }
    case 'at': case 'ata': case 'txpd': case 'txpda': {
      for (const grp of Array.isArray(raw) ? raw : []) {
        for (const it of grp?.itms ?? []) { docCount++; addValue(total, num(it?.ad_amt), heads(it)); }
      }
      break;
    }
    case 'nil': {
      // An object, not an array.
      for (const row of raw?.inv ?? []) {
        docCount++;
        total.taxable += num(row?.nil_amt) + num(row?.expt_amt) + num(row?.ngsup_amt);
      }
      break;
    }
    case 'hsn': {
      // Shape switched at period 05-2025: hsn_b2b/hsn_b2c replaced a single data[].
      const rows = [...(raw?.hsn_b2b ?? []), ...(raw?.hsn_b2c ?? []), ...(raw?.data ?? [])];
      for (const row of rows) { docCount++; addValue(total, num(row?.txval), heads(row)); }
      break;
    }
    case 'doc_issue': {
      for (const d of raw?.doc_det ?? []) {
        for (const doc of d?.docs ?? []) { docCount++; total.taxable += num(doc?.net_issue); }
      }
      break;
    }
    case 'supeco': case 'supecoa': {
      for (const arr of [raw?.clttx, raw?.paytx, raw?.clttxa, raw?.paytxa]) {
        for (const row of arr ?? []) { docCount++; addValue(total, num(row?.suppval), heads(row)); }
      }
      break;
    }
    case 'ecom': case 'ecoma': {
      let found = false;
      for (const sub of Object.values(raw ?? {})) {
        for (const grp of Array.isArray(sub) ? sub : []) {
          if (Array.isArray((grp as any)?.inv)) {
            for (const inv of (grp as any).inv) { docCount++; itemDetInto(total, inv?.itms); found = true; }
          } else if ((grp as any)?.txval !== undefined) {
            docCount++; addValue(total, num((grp as any).txval), heads(grp)); found = true;
          }
        }
      }
      if (!found && raw) warn(`section '${key}' had an unrecognised shape and contributed nothing`);
      break;
    }
    default:
      return null;
  }
  if (docCount === 0 && total.taxable === 0 && totalTax(total) === 0) return null;
  return { key, label: spec.label, kind: spec.kind, total, cSum, dSum, docCount };
};

const normaliseGstr1 = (j: any, sourceFiles: string[]): Gstr1Period => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const p = parsePeriod(j.fp)!;
  const fyStart = fyStartOf(p.mm, p.yyyy);

  const sections: Gstr1SectionTotal[] = [];
  for (const key of Object.keys(j)) {
    if (R1_HEADER_KEYS.has(key)) continue;
    if (!R1_SECTION_KEYS.has(key)) { warn(`unrecognised section '${key}' ignored`); continue; }
    const s = extractSection(key, j[key], warn);
    if (s) sections.push(s);
  }
  sections.sort((a, b) => R1_SECTIONS.findIndex((s) => s.key === a.key) - R1_SECTIONS.findIndex((s) => s.key === b.key));

  const by = (k: string) => sections.find((s) => s.key === k);
  const outward = sections.filter((s) => s.kind === 'outward').map((s) => s.total);
  const net = sumValues(outward);
  // Debit notes increase the liability, credit notes reduce it.
  for (const s of sections.filter((x) => x.kind === 'note')) {
    if (s.dSum) addInto(net, s.dSum);
    if (s.cSum) { const c = s.cSum; net.taxable -= c.taxable; net.igst -= c.igst; net.cgst -= c.cgst; net.sgst -= c.sgst; net.cess -= c.cess; }
  }
  for (const s of sections.filter((x) => x.kind === 'advance')) addInto(net, s.total);
  for (const s of sections.filter((x) => x.kind === 'advance-adj')) {
    const t = s.total;
    net.taxable -= t.taxable; net.igst -= t.igst; net.cgst -= t.cgst; net.sgst -= t.sgst; net.cess -= t.cess;
  }

  const present = new Set(sections.map((s) => s.key));
  const quarterEnd = QUARTER_END_MONTHS.has(p.mm);
  // No key identifies an IFF. This is the safest available inference and is used
  // only as a label — the arithmetic is identical to a GSTR-1.
  const iffInferred = !quarterEnd
    && present.size > 0
    && [...present].every((k) => IFF_ALLOWED.has(k))
    && j.filing_typ !== 'M';

  const nilSec = by('nil');
  const nilTotals = nilSec ? { nilAmt: 0, exptAmt: 0, ngsupAmt: 0 } : undefined;
  if (nilTotals) {
    for (const row of j.nil?.inv ?? []) {
      nilTotals.nilAmt += num(row?.nil_amt);
      nilTotals.exptAmt += num(row?.expt_amt);
      nilTotals.ngsupAmt += num(row?.ngsup_amt);
    }
  }

  let docIssue: Gstr1Period['docIssue'];
  if (j.doc_issue) {
    docIssue = { issued: 0, cancelled: 0, net: 0 };
    for (const d of j.doc_issue?.doc_det ?? []) {
      for (const doc of d?.docs ?? []) {
        docIssue.issued += num(doc?.totnum);
        docIssue.cancelled += num(doc?.cancel);
        docIssue.net += num(doc?.net_issue);
      }
    }
  }

  return {
    form: 'GSTR1',
    gstin: String(j.gstin ?? ''),
    period: j.fp,
    fyStart, fy: fyLabel(fyStart), monthIndex: monthIndexOf(p.mm), quarter: quarterOf(p.mm),
    filingTyp: typeof j.filing_typ === 'string' ? j.filing_typ : undefined,
    filed: 'fil_dt' in j && !!j.fil_dt,
    iffInferred,
    quarterly: j.filing_typ === 'Q' && quarterEnd,
    sections,
    netOutward: net,
    docIssue,
    nil: nilTotals,
    hsnTaxable: by('hsn')?.total.taxable,
    b2bInvCount: (by('b2b')?.docCount ?? 0) + (by('b2ba')?.docCount ?? 0),
    cdnrNoteCount: (by('cdnr')?.docCount ?? 0) + (by('cdnra')?.docCount ?? 0),
    qrmpDedupedDocs: 0,
    warnings,
    sourceFiles,
  };
};

// ─── GSTR-3B ─────────────────────────────────────────────────────────────────

const valueOf = (o: any): ValueWithTax => ({ taxable: num(o?.txval), ...heads(o) });

const normaliseGstr3b = (j: any, sourceFiles: string[]): Gstr3bPeriod => {
  const warnings: string[] = [];
  const p = parsePeriod(j.ret_period)!;
  const fyStart = fyStartOf(p.mm, p.yyyy);
  const sup = j.sup_details ?? {};

  // Always key these by `ty` — the array order is not guaranteed.
  const byTy = (arr: any, known: string[], what: string): Record<string, TaxHeads> => {
    const out: Record<string, TaxHeads> = {};
    for (const row of Array.isArray(arr) ? arr : []) {
      const ty = String(row?.ty ?? '').toUpperCase();
      if (!ty) continue;
      if (!known.includes(ty)) warnings.push(`unrecognised ${what} type '${ty}' carried through`);
      out[ty] = heads(row);
    }
    return out;
  };

  const eco = j.eco_dtls
    ? { ecoSup: valueOf(j.eco_dtls.eco_sup), ecoRegSupTaxable: num(j.eco_dtls.eco_reg_sup?.txval) }
    : undefined;

  return {
    form: 'GSTR3B',
    gstin: String(j.gstin ?? ''),
    period: j.ret_period,
    fyStart, fy: fyLabel(fyStart), monthIndex: monthIndexOf(p.mm), quarter: quarterOf(p.mm),
    filed: true,
    outwardTaxable: valueOf(sup.osup_det),
    outwardZero: valueOf(sup.osup_zero),
    nilExempt: num(sup.osup_nil_exmp?.txval),
    nonGst: num(sup.osup_nongst?.txval),
    inwardRcm: valueOf(sup.isup_rev),
    eco,
    itcAvail: byTy(j.itc_elg?.itc_avl, ['IMPG', 'IMPS', 'ISRC', 'ISD', 'OTH'], 'ITC available'),
    itcRev: byTy(j.itc_elg?.itc_rev, ['RUL', 'OTH'], 'ITC reversal'),
    itcNet: heads(j.itc_elg?.itc_net),
    itcInelig: byTy(j.itc_elg?.itc_inelg, ['RUL', 'OTH'], 'ITC ineligible'),
    interest: heads(j.intr_ltfee?.intr_details),
    lateFee: heads(j.intr_ltfee?.ltfee_details),
    ttVal: j.tt_val
      ? { pay: num(j.tt_val.tt_pay), cash: num(j.tt_val.tt_csh_pd), itc: num(j.tt_val.tt_itc_pd) }
      : undefined,
    warnings,
    sourceFiles,
  };
};

// ─── GSTR-2B ─────────────────────────────────────────────────────────────────

const B2_BUCKETS: B2Bucket[] = ['itcavl', 'itcunavl', 'itcrev', 'itcRejected'];

/** Container key → the array property holding its documents. */
const B2_CONTAINERS: Record<string, string> = {
  b2b: 'inv', b2ba: 'inv', ecom: 'inv', ecoma: 'inv',
  cdnr: 'nt', cdnra: 'nt',
  isd: 'doclist', isda: 'doclist',
  impgsez: 'boe',
};

const normaliseGstr2b = (j: any, sourceFiles: string[]): Gstr2bPeriod => {
  const warnings: string[] = [];
  const d = j.data ?? {};
  const p = parsePeriod(d.rtnprd)!;
  const fyStart = fyStartOf(p.mm, p.yyyy);

  // itcsumm: taxable value lives on the SECTION child, never on the group node.
  // Reading it at group level silently yields zero.
  const rows: Gstr2bSummRow[] = [];
  for (const bucket of B2_BUCKETS) {
    const b = d.itcsumm?.[bucket];
    if (!b || typeof b !== 'object') continue;
    for (const [group, g] of Object.entries<any>(b)) {
      if (!g || typeof g !== 'object') continue;
      for (const [section, s] of Object.entries<any>(g)) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
        rows.push({ bucket, group, section, total: { taxable: num(s.txval), ...heads(s) } });
      }
    }
  }

  const bucketTotals = Object.fromEntries(B2_BUCKETS.map((b) => [b, zeroValue()])) as Record<B2Bucket, ValueWithTax>;
  // ponytail: additive including credit notes, which is how the portal's own summary
  // presents it and what the comparison column needs. Section rows stay visible so a
  // reviewer can see the composition; flip to signed only if a client case demands it.
  for (const r of rows) addInto(bucketTotals[r.bucket], r.total);

  // docdata is folded to counts and sums here — a large 2B must not be held per-document.
  const docCounts = { b2bAvl: 0, b2bUnavl: 0, cdnr: 0, isd: 0, impg: 0, impgsez: 0, other: 0 };
  const unavailReasons: Record<string, number> = {};
  const imsStatuses: Record<string, number> = {};
  let docdataTaxable = 0;

  const countDoc = (section: string, doc: any): void => {
    // Modern files put amounts flat on the document; older ones nest an items[].
    if (Array.isArray(doc?.items) && doc.items.length) {
      for (const it of doc.items) docdataTaxable += num(it?.txval);
    } else {
      docdataTaxable += num(doc?.txval);
    }
    const avl = String(doc?.itcavl ?? '').toUpperCase();
    if (section.startsWith('b2b')) {
      if (avl === 'N') docCounts.b2bUnavl++; else docCounts.b2bAvl++;
    } else if (section.startsWith('cdnr')) docCounts.cdnr++;
    else if (section.startsWith('isd')) docCounts.isd++;
    else if (section === 'impg') docCounts.impg++;
    else if (section === 'impgsez') docCounts.impgsez++;
    else docCounts.other++;

    if (avl === 'N' || avl === 'T') {
      const rsn = String(doc?.rsn ?? '').trim() || '(no reason given)';
      unavailReasons[rsn] = (unavailReasons[rsn] ?? 0) + 1;
    }
    const ims = String(doc?.imsStatus ?? '').trim();
    if (ims) imsStatuses[ims] = (imsStatuses[ims] ?? 0) + 1;
  };

  const walkDocData = (container: any, rejected: boolean): void => {
    for (const [section, val] of Object.entries<any>(container ?? {})) {
      if (!Array.isArray(val)) continue;
      const docKey = B2_CONTAINERS[section];
      for (const entry of val) {
        if (!docKey) { countDoc(section, entry); continue; }        // impg: flat, no supplier wrapper
        const docs = entry?.[docKey];
        if (Array.isArray(docs)) for (const doc of docs) countDoc(section, doc);
        else countDoc(section, entry);
      }
      if (rejected) imsStatuses['Rejected (IMS)'] = (imsStatuses['Rejected (IMS)'] ?? 0) + val.length;
    }
  };
  walkDocData(d.docdata, false);
  const rejectedBefore = docdataTaxable;
  walkDocData(d.docRejdata, true);
  // IMS-rejected documents carry no ITC, so they must not inflate the cross-check.
  docdataTaxable = rejectedBefore;

  const summTaxable = rows.reduce((s, r) => s + r.total.taxable, 0);
  const crossCheckDelta = docdataTaxable - summTaxable;
  const crossCheckOk = Math.abs(crossCheckDelta) <= 1;
  if (!crossCheckOk) {
    warnings.push(
      `GSTR-2B ${monthLabel(d.rtnprd)}: documents total ${docdataTaxable.toFixed(2)} but the ITC summary ` +
      `totals ${summTaxable.toFixed(2)} (difference ${crossCheckDelta.toFixed(2)}).`,
    );
  }

  return {
    form: 'GSTR2B',
    gstin: String(d.gstin ?? ''),
    period: d.rtnprd,
    fyStart, fy: fyLabel(fyStart), monthIndex: monthIndexOf(p.mm), quarter: quarterOf(p.mm),
    filed: true,
    gendt: typeof d.gendt === 'string' ? d.gendt : undefined,
    rows, bucketTotals, docCounts, unavailReasons, imsStatuses,
    docdataTaxable, crossCheckOk, crossCheckDelta,
    warnings, sourceFiles,
  };
};

// ─── detection ───────────────────────────────────────────────────────────────

type Detected =
  | { kind: 'GSTR1'; gstin: string; period: string }
  | { kind: 'GSTR3B'; gstin: string; period: string }
  | { kind: 'GSTR2B'; gstin: string; period: string }
  | { kind: 'reject'; reason: string };

/** Identify by CONTENT only — portal filenames carry the download date, not the period. */
const detect = (j: any): Detected => {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { kind: 'reject', reason: 'not a JSON object' };

  if (j.data && typeof j.data === 'object' && typeof j.data.rtnprd === 'string'
    && (j.data.itcsumm || j.data.docdata)) {
    if (!parsePeriod(j.data.rtnprd)) return { kind: 'reject', reason: `GSTR-2B with an unreadable period '${j.data.rtnprd}'` };
    return { kind: 'GSTR2B', gstin: String(j.data.gstin ?? ''), period: j.data.rtnprd };
  }
  if (typeof j.ret_period === 'string' && (j.sup_details || j.itc_elg)) {
    if (!parsePeriod(j.ret_period)) return { kind: 'reject', reason: `GSTR-3B with an unreadable period '${j.ret_period}'` };
    return { kind: 'GSTR3B', gstin: String(j.gstin ?? ''), period: j.ret_period };
  }
  if (typeof j.fp === 'string' && parsePeriod(j.fp)
    && (Object.keys(j).some((k) => R1_SECTION_KEYS.has(k)) || typeof j.filing_typ === 'string')) {
    return { kind: 'GSTR1', gstin: String(j.gstin ?? ''), period: j.fp };
  }
  const keys = Object.keys(j).slice(0, 8).join(', ');
  return { kind: 'reject', reason: `not a recognised GSTR-1/IFF/GSTR-3B/GSTR-2B JSON (top-level keys: ${keys || 'none'})` };
};

// ─── ZIP expansion ───────────────────────────────────────────────────────────

interface Leaf { sourceName: string; text: string }

const isZip = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

const decode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');

const expand = async (
  name: string, bytes: Uint8Array, depth: number,
  leaves: Leaf[], reports: GstFileReport[],
): Promise<void> => {
  if (isZip(bytes)) {
    if (depth >= 3) {
      reports.push({ sourceName: name, status: 'rejected', reason: 'ZIP nested more than 3 levels deep', warnings: [] });
      return;
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      reports.push({ sourceName: name, status: 'rejected', reason: 'could not be opened as a ZIP (corrupt or unsupported)', warnings: [] });
      return;
    }
    const entries = Object.values(zip.files).filter((f) => !f.dir);
    if (entries.length === 0) {
      reports.push({ sourceName: name, status: 'rejected', reason: 'ZIP is empty', warnings: [] });
      return;
    }
    const before = leaves.length;
    for (const entry of entries) {
      const inner = await entry.async('uint8array');
      await expand(`${name}!${entry.name}`, inner, depth + 1, leaves, reports);
    }
    if (leaves.length === before && !reports.some((r) => r.sourceName.startsWith(`${name}!`) && r.status !== 'rejected')) {
      // Nothing usable came out; make sure the user is told about the ZIP itself.
      if (!reports.some((r) => r.sourceName.startsWith(`${name}!`))) {
        reports.push({ sourceName: name, status: 'rejected', reason: 'ZIP contains no JSON files', warnings: [] });
      }
    }
    return;
  }
  const text = decode(bytes);
  if (!/^\s*[{[]/.test(text)) {
    reports.push({ sourceName: name, status: 'rejected', reason: 'not a JSON file', warnings: [] });
    return;
  }
  leaves.push({ sourceName: name, text });
};

// ─── ingestion ───────────────────────────────────────────────────────────────

interface Pending { report: GstFileReport; json: any; det: Detected & { kind: GstFormKind }; leafName: string }

const chunkIndexOf = (leafName: string): number | null => {
  const m = /_offline_others_(\d+)\.json$/i.exec(leafName);
  return m ? Number(m[1]) : null;
};

/** Merge the chunks of a single download: every section array is concatenated. */
const mergeChunks = (payloads: any[], warn: (m: string) => void): any => {
  const base = { ...payloads[0] };
  for (const next of payloads.slice(1)) {
    for (const [k, v] of Object.entries(next)) {
      if (R1_HEADER_KEYS.has(k)) continue;
      if (Array.isArray(v)) base[k] = [...(Array.isArray(base[k]) ? base[k] : []), ...v];
      else if (v && typeof v === 'object') {
        if (!base[k]) base[k] = v;
        else if (JSON.stringify(base[k]) !== JSON.stringify(v)) warn(`conflicting '${k}' across chunks — kept the first`);
      }
    }
  }
  return base;
};

export async function ingestGstFiles(inputs: GstSourceInput[]): Promise<GstDataset> {
  const reports: GstFileReport[] = [];
  const warnings: string[] = [];
  const leaves: Leaf[] = [];

  for (const input of inputs) await expand(input.name, input.bytes, 0, leaves, reports);

  // Identical bytes arriving twice (e.g. a ZIP plus its already-extracted copy).
  const seen = new Map<string, string>();
  const unique: Leaf[] = [];
  for (const leaf of leaves) {
    const key = `${leaf.text.length}:${leaf.text.slice(0, 200)}:${leaf.text.slice(-200)}`;
    const first = seen.get(key);
    if (first !== undefined) {
      reports.push({ sourceName: leaf.sourceName, status: 'duplicate-ignored', reason: `identical content already loaded from ${first}`, warnings: [] });
      continue;
    }
    seen.set(key, leaf.sourceName);
    unique.push(leaf);
  }

  let gstin: string | null = null;
  const pending: Pending[] = [];
  for (const leaf of unique) {
    let json: any;
    try {
      json = JSON.parse(leaf.text);
    } catch (e: any) {
      reports.push({ sourceName: leaf.sourceName, status: 'rejected', reason: `invalid JSON — ${e?.message ?? 'parse failed'}`, warnings: [] });
      continue;
    }
    const det = detect(json);
    if (det.kind === 'reject') {
      reports.push({ sourceName: leaf.sourceName, status: 'rejected', reason: det.reason, warnings: [] });
      continue;
    }
    if (gstin === null) gstin = det.gstin || null;
    else if (det.gstin && det.gstin !== gstin) {
      reports.push({
        sourceName: leaf.sourceName, status: 'rejected',
        reason: `GSTIN mismatch — this file is for ${det.gstin} but the batch is for ${gstin}. Load one GSTIN at a time.`,
        warnings: [],
      });
      continue;
    }
    const p = parsePeriod(det.period)!;
    const report: GstFileReport = {
      sourceName: leaf.sourceName, status: 'ok',
      detectedAs: det.kind, period: det.period, fy: fyLabel(fyStartOf(p.mm, p.yyyy)),
      warnings: [],
    };
    // Every accepted file gets a row too — the import table must account for all of them.
    reports.push(report);
    pending.push({ json, det: det as any, leafName: leaf.sourceName, report });
  }

  // ── GSTR-1: merge chunks, then resolve duplicate periods ──
  const r1: Gstr1Period[] = [];
  const r1ByPeriod = new Map<string, Pending[]>();
  for (const p of pending.filter((x) => x.det.kind === 'GSTR1')) {
    const list = r1ByPeriod.get(p.det.period) ?? [];
    list.push(p); r1ByPeriod.set(p.det.period, list);
  }
  for (const [period, group] of r1ByPeriod) {
    const indices = group.map((g) => chunkIndexOf(g.leafName));
    const distinct = new Set(indices.filter((i) => i !== null));
    let winners: Pending[];
    if (group.length > 1 && distinct.size === group.length && distinct.size > 1) {
      // Chunks of one download — merge rather than choose.
      const ordered = [...group].sort((a, b) => (chunkIndexOf(a.leafName) ?? 0) - (chunkIndexOf(b.leafName) ?? 0));
      const merged = mergeChunks(ordered.map((o) => o.json), (m) => warnings.push(m));
      ordered[0].json = merged;
      winners = [ordered[0]];
      for (const other of ordered.slice(1)) other.report.status = 'ok';
      warnings.push(`GSTR-1 for ${monthLabel(period)} arrived as ${group.length} chunked files and was merged.`);
    } else {
      // Duplicate downloads: a filed copy beats a saved one, otherwise the last wins.
      const filed = group.filter((g) => 'fil_dt' in g.json && g.json.fil_dt);
      const pool = filed.length ? filed : group;
      const winner = pool[pool.length - 1];
      winners = [winner];
      for (const loser of group) {
        if (loser === winner) continue;
        const why = filed.length && !('fil_dt' in loser.json && loser.json.fil_dt)
          ? 'a saved (unfiled) copy superseded by the filed copy'
          : 'an earlier copy of the same period superseded by a later one';
        loser.report.status = 'superseded';
        loser.report.reason = why;
        warnings.push(`GSTR-1 for ${monthLabel(period)}: ${why}.`);
      }
    }
    for (const w of winners) {
      const norm = normaliseGstr1(w.json, [w.leafName]);
      w.report.detectedAs = norm.iffInferred ? 'IFF (inferred)' : norm.quarterly ? 'GSTR-1 (quarterly)' : 'GSTR-1';
      w.report.filed = norm.filed;
      if (!norm.filed) warnings.push(`GSTR-1 for ${monthLabel(period)} is a saved draft — it carries no filing date.`);
      r1.push(norm);
    }
  }

  // ── QRMP: a quarterly GSTR-1 can re-contain invoices already filed in the M1/M2 IFFs ──
  for (const qtr of r1.filter((x) => QUARTER_END_MONTHS.has(parsePeriod(x.period)!.mm))) {
    const siblings = r1.filter((o) => o !== qtr && o.fyStart === qtr.fyStart && o.quarter === qtr.quarter);
    if (siblings.length === 0) continue;
    const already = new Set<string>();
    for (const s of siblings) {
      const raw = pending.find((p) => p.leafName === s.sourceFiles[0])?.json;
      for (const grp of raw?.b2b ?? []) for (const inv of grp?.inv ?? []) already.add(`b2b|${grp.ctin}|${inv.inum}`);
      for (const grp of raw?.cdnr ?? []) for (const nt of grp?.nt ?? []) already.add(`cdnr|${grp.ctin}|${nt.nt_num}`);
    }
    if (already.size === 0) continue;
    const raw = pending.find((p) => p.leafName === qtr.sourceFiles[0])?.json;
    if (!raw) continue;
    let removed = 0;
    for (const grp of raw.b2b ?? []) {
      const keep = (grp.inv ?? []).filter((inv: any) => !already.has(`b2b|${grp.ctin}|${inv.inum}`));
      removed += (grp.inv?.length ?? 0) - keep.length; grp.inv = keep;
    }
    for (const grp of raw.cdnr ?? []) {
      const keep = (grp.nt ?? []).filter((nt: any) => !already.has(`cdnr|${grp.ctin}|${nt.nt_num}`));
      removed += (grp.nt?.length ?? 0) - keep.length; grp.nt = keep;
    }
    if (removed > 0) {
      const fresh = normaliseGstr1(raw, qtr.sourceFiles);
      fresh.qrmpDedupedDocs = removed;
      Object.assign(qtr, fresh);
      warnings.push(
        `QRMP de-duplication: ${removed} document(s) in the ${monthLabel(qtr.period)} quarterly GSTR-1 had ` +
        `already been reported in that quarter's IFF and were counted once, in the IFF month.`,
      );
    }
  }

  // ── 3B and 2B: duplicate period → last wins ──
  const pickLast = <T,>(items: Pending[], make: (j: any, src: string[]) => T, label: string): T[] => {
    const byPeriod = new Map<string, Pending[]>();
    for (const p of items) {
      const list = byPeriod.get(p.det.period) ?? [];
      list.push(p); byPeriod.set(p.det.period, list);
    }
    const out: T[] = [];
    for (const [period, group] of byPeriod) {
      const winner = group[group.length - 1];
      for (const loser of group) {
        if (loser === winner) continue;
        loser.report.status = 'superseded';
        loser.report.reason = 'an earlier copy of the same period superseded by a later one';
        warnings.push(`${label} for ${monthLabel(period)}: an earlier copy was superseded by a later one.`);
      }
      out.push(make(winner.json, [winner.leafName]));
    }
    return out;
  };
  const b3 = pickLast(pending.filter((x) => x.det.kind === 'GSTR3B'), normaliseGstr3b, 'GSTR-3B');
  const b2 = pickLast(pending.filter((x) => x.det.kind === 'GSTR2B'), normaliseGstr2b, 'GSTR-2B');

  for (const set of [r1, b3, b2] as Array<Array<{ warnings: string[] }>>) {
    for (const item of set) warnings.push(...item.warnings);
  }

  const bySort = (a: { fyStart: number; monthIndex: number }, b: { fyStart: number; monthIndex: number }) =>
    a.fyStart - b.fyStart || a.monthIndex - b.monthIndex;
  r1.sort(bySort); b3.sort(bySort); b2.sort(bySort);

  const rejected = reports.filter((r) => r.status === 'rejected').length;
  if (rejected > 0) warnings.unshift(`${rejected} file(s) could not be read — see the file list.`);

  const fys = new Set([...r1, ...b3, ...b2].map((x) => x.fy));
  if (fys.size > 1) warnings.push(`Periods span ${fys.size} financial years — one summary sheet per year.`);

  return { gstin, r1, b3, b2, reports, warnings };
}
