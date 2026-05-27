// Shared coercion helpers for parsing Tally XLSX rows. The exporter writes
// every cell as text-ish (numbers come as quoted strings, booleans as "1"/"0"),
// so every typed field flows through one of these.

export const toText = (value: any): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

export const toNumber = (value: any): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const asText = toText(value).replace(/,/g, '');
  if (!asText) return 0;
  const parsed = Number(asText);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const toBool = (value: any): boolean => {
  const t = toText(value).toLowerCase();
  if (t === '1' || t === 'true' || t === 'yes' || t === 'y') return true;
  if (t === '0' || t === 'false' || t === 'no' || t === 'n' || t === '') return false;
  const n = Number(t);
  return Number.isFinite(n) ? n > 0 : false;
};

export const toBoolNum = (value: any): 0 | 1 => (toBool(value) ? 1 : 0);

// Tally XLSX dates arrive in three flavours: ISO ("2025-12-25"), DD/MM/YYYY,
// or Excel serial numbers. We canonicalise to ISO so every downstream module
// can compare with `string < string`.
export const toIsoDate = (value: any): string => {
  if (value === null || value === undefined || value === '') return '';
  // Excel serial-number date (rare in xlsx-js output but possible)
  if (typeof value === 'number' && Number.isFinite(value) && value > 30000) {
    const ms = (value - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = toText(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ddmmyyyy = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  const ddmmyy = s.match(/^(\d{2})[/-](\d{2})[/-](\d{2})$/);
  if (ddmmyy) {
    const yy = Number(ddmmyy[3]);
    const yyyy = yy < 70 ? `20${ddmmyy[3]}` : `19${ddmmyy[3]}`;
    return `${yyyy}-${ddmmyy[2]}-${ddmmyy[1]}`;
  }
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return s;
};

// Tally ledger / group / item names are case-significant but space-noisy
// (trailing newlines, double spaces). Joins must use this normalised key.
export const nameKey = (value: any): string =>
  toText(value).replace(/\s+/g, ' ').toLowerCase();

// Lowercases header keys so a row produced by xlsx-js (which preserves
// original column case) can be indexed predictably.
export const lowercaseKeys = (row: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const k of Object.keys(row || {})) out[k.trim().toLowerCase()] = row[k];
  return out;
};

// ── Voucher identity ─────────────────────────────────────────────────────────
// getLedgerEntries() mints one row per accounting leg with a row-unique id of
// the form `<voucherGuid>-<txIndex>`. To regroup a voucher's legs, strip the
// single trailing `-<n>`. This is the ONE place that encodes that format — every
// module (workers + views) must use it rather than re-implementing the regex,
// since a divergence here silently shatters vouchers into single-line groups.
export const voucherFamilyKey = (guid: any): string => {
  const v = toText(guid);
  if (!v) return '';
  if (!/-\d+$/.test(v)) return v;
  return v.replace(/-\d+$/, '');
};

// Single-string voucher key for a flat LedgerEntry-shaped row: prefer the guid
// family; fall back to date|type|number when the guid is absent or synthetic
// (master-ledger rows carry a `ledger-master-…` guid that must not be stripped).
export const voucherKey = (e: {
  guid?: any;
  date?: any;
  voucher_type?: any;
  voucher_number?: any;
}): string => {
  const g = String(e?.guid || '');
  if (g && !g.startsWith('ledger-master-')) return voucherFamilyKey(g);
  return `${toText(e?.date)}|${toText(e?.voucher_type)}|${toText(e?.voucher_number)}`;
};

// ── Ledger classification ──────────────────────────────────────────────────────
// True when a ledger's Tally primary group is a P&L head (sales / income /
// purchase / expense). A genuine TDS/GST/RCM tax ledger never lives under a P&L
// head, so tax-ledger auto-suggest uses this to reject income/expense ledgers
// that merely mention a tax in their NAME (e.g. "Service Charges Collected
// (IGST)" under Sales Accounts), which would otherwise swallow real revenue.
export const isPlPrimaryGroup = (primary: any): boolean =>
  /(sale|income|purchase|inward|expense)/i.test(toText(primary));

// First-seen ledger-name → Tally primary-group map, for the auto-suggest guard.
export const buildLedgerPrimaryMap = (
  rows: Array<{ Ledger?: any; TallyPrimary?: any }>,
): Map<string, string> => {
  const m = new Map<string, string>();
  for (const r of rows) {
    const l = toText(r?.Ledger);
    const p = toText(r?.TallyPrimary);
    if (l && p && !m.has(l)) m.set(l, p);
  }
  return m;
};
