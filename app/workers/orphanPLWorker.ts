/**
 * Orphan P&L Vouchers — Web Worker
 *
 * Objective:
 *   Surface vouchers where a Profit & Loss ledger moves but NO Sundry
 *   Creditor / Sundry Debtor is on the counter side. These are the bypasses
 *   of the normal "book an invoice against a party" workflow — typical signals:
 *     • Expense paid straight from Bank/Cash (no vendor master)
 *     • Journal adjusting an expense against a director's loan / capital
 *     • Cash sale (no debtor master)
 *     • Inter-ledger hack that should have hit a party but didn't
 *
 * Classification relies on `TallyPrimary` — the raw primary-group name Tally
 * exports for every ledger. Case-insensitive exact match with a small alias
 * map covers the usual Tally variants.
 *
 * Message in:  OrphanPLWorkerInput
 * Message out: OrphanPLWorkerOutput
 */

import type { LedgerEntry } from '../types';
import { voucherFamilyKey } from '../services/tally/helpers';

// ── Buckets ───────────────────────────────────────────────────────────────────
export type PLBucket =
  | 'sales'
  | 'purchase'
  | 'direct_income'
  | 'indirect_income'
  | 'direct_expense'
  | 'indirect_expense';

export type RoutedBucket =
  | 'bank'
  | 'cash'
  | 'loan'
  | 'capital'
  | 'tax'
  | 'current_asset'
  | 'current_liability'
  | 'fixed_asset'
  | 'investment'
  | 'stock'
  | 'other';

// ── Row shapes ────────────────────────────────────────────────────────────────
export interface OrphanPLLeg {
  ledger: string;
  primaryGroup: string;
  amount: number; // signed
  plBucket?: PLBucket;        // only set on P&L legs
  routedBucket?: RoutedBucket; // only set on counter legs
}

export interface OrphanPLVoucher {
  guid: string;
  date: string;             // ISO (yyyy-mm-dd)
  voucher_number: string;
  voucher_type: string;
  narration: string;
  plLegs: OrphanPLLeg[];
  counterLegs: OrphanPLLeg[];
  plAmount: number;         // absolute sum of P&L legs
  counterAmount: number;    // absolute sum of counter legs
  dominantPLBucket: PLBucket;        // bucket of largest P&L leg
  dominantRoutedBucket: RoutedBucket; // bucket of largest counter leg
  isCashBankOnly: boolean;  // true if every counter leg is Bank or Cash
}

export interface OrphanPLFilters {
  fromDate: string | null;     // ISO
  toDate: string | null;       // ISO
  voucherTypeFilter: string;   // 'all' or specific voucher type
  plBucketFilter: PLBucket | 'all';
  routedBucketFilter: RoutedBucket | 'all';
  minAmount: number;           // orphan amount cutoff
  hideCashBankOnly: boolean;   // suppress cash/bank-only vouchers
  search: string;              // free-text match against narration/ledgers/voucher#
}

export interface OrphanPLWorkerInput {
  rows: LedgerEntry[];
  filters: OrphanPLFilters;
}

export interface OrphanPLBucketStat {
  count: number;
  amount: number;
}

export interface OrphanPLWorkerOutput {
  vouchers: OrphanPLVoucher[];
  stats: {
    totalVouchersScanned: number;
    totalFlagged: number;
    totalOrphanAmount: number;
    cashBankOnlyCount: number;
    cashBankOnlyAmount: number;
    byPLBucket: Record<PLBucket, OrphanPLBucketStat>;
    byRoutedBucket: Record<RoutedBucket, OrphanPLBucketStat>;
    distinctVoucherTypes: string[];
  };
  // Total before filters (for "X of Y" counts in UI)
  totalsUnfiltered: {
    flagged: number;
    amount: number;
  };
}

// ── Group classification ──────────────────────────────────────────────────────

const normalize = (s: string): string =>
  (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Aliases normalise Tally's occasional spelling variants to a canonical key.
const PL_GROUP_ALIASES: Record<string, PLBucket> = {
  'sales accounts': 'sales',
  'sales account': 'sales',
  'purchase accounts': 'purchase',
  'purchase account': 'purchase',
  'direct incomes': 'direct_income',
  'direct income': 'direct_income',
  'indirect incomes': 'indirect_income',
  'indirect income': 'indirect_income',
  'direct expenses': 'direct_expense',
  'direct expense': 'direct_expense',
  'indirect expenses': 'indirect_expense',
  'indirect expense': 'indirect_expense',
};

const PARTY_GROUPS = new Set([
  'sundry creditors',
  'sundry creditor',
  'sundry debtors',
  'sundry debtor',
]);

const classifyPLBucket = (primaryGroup: string): PLBucket | null => {
  const key = normalize(primaryGroup);
  return PL_GROUP_ALIASES[key] ?? null;
};

const isPartyGroup = (primaryGroup: string): boolean =>
  PARTY_GROUPS.has(normalize(primaryGroup));

const classifyRoutedBucket = (primaryGroup: string): RoutedBucket => {
  const p = normalize(primaryGroup);
  if (!p) return 'other';
  if (p === 'bank accounts' || p === 'bank ocd a/c' || p.startsWith('bank '))
    return 'bank';
  if (p === 'cash-in-hand' || p.includes('cash')) return 'cash';
  if (
    p.includes('loan') ||
    p === 'unsecured loans' ||
    p === 'secured loans' ||
    p === 'loans (liability)' ||
    p === 'loans & advances (asset)' ||
    p === 'loans and advances (asset)'
  )
    return 'loan';
  if (p === 'capital account' || p.includes('capital') || p.includes('reserves'))
    return 'capital';
  if (p === 'duties & taxes' || p === 'duties and taxes' || p.includes('tax'))
    return 'tax';
  if (p.includes('investment')) return 'investment';
  if (p === 'fixed assets' || p.includes('fixed asset')) return 'fixed_asset';
  if (p.includes('stock')) return 'stock';
  if (p === 'current assets' || p.includes('current asset'))
    return 'current_asset';
  if (p === 'current liabilities' || p.includes('current liabilit'))
    return 'current_liability';
  return 'other';
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const toNum = (value: any): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const tallyPrimaryOf = (row: LedgerEntry): string =>
  String(
    row.TallyPrimary ??
      (row as any).primary_group ??
      (row as any).primaryGroup ??
      (row as any).Primary ??
      '',
  );

const ledgerOf = (row: LedgerEntry): string =>
  String(row.Ledger ?? (row as any).ledger ?? '').trim();

// ── Core computation ──────────────────────────────────────────────────────────

function computeOrphanVouchers(input: OrphanPLWorkerInput): OrphanPLWorkerOutput {
  const { rows, filters } = input;

  // Group rows by voucher (family) key — legs of one voucher share a base guid
  // with a per-leg `-<n>` suffix, so we must strip it; grouping by the raw guid
  // would put every leg in its own group and flag all P&L rows as orphans.
  const voucherMap = new Map<string, LedgerEntry[]>();
  rows.forEach((r) => {
    const g = voucherFamilyKey(r.guid);
    if (!g) return;
    if (!voucherMap.has(g)) voucherMap.set(g, []);
    voucherMap.get(g)!.push(r);
  });

  const flaggedAll: OrphanPLVoucher[] = [];
  const voucherTypeSet = new Set<string>();

  voucherMap.forEach((entries, guid) => {
    // Classify every row's primary group once
    let hasParty = false;
    const plLegs: OrphanPLLeg[] = [];
    const counterLegs: OrphanPLLeg[] = [];

    entries.forEach((row) => {
      const primary = tallyPrimaryOf(row);
      if (isPartyGroup(primary)) {
        hasParty = true;
        return;
      }
      const plBucket = classifyPLBucket(primary);
      const amount = toNum(row.amount);
      if (plBucket) {
        plLegs.push({
          ledger: ledgerOf(row),
          primaryGroup: primary,
          amount,
          plBucket,
        });
      } else {
        // Skip zero-amount noise legs entirely
        if (Math.abs(amount) < 0.005) return;
        counterLegs.push({
          ledger: ledgerOf(row),
          primaryGroup: primary,
          amount,
          routedBucket: classifyRoutedBucket(primary),
        });
      }
    });

    // Rule: flag only if P&L hit AND no party anywhere on voucher
    if (hasParty) return;
    if (plLegs.length === 0) return;

    // Aggregate amounts
    const plAmount = plLegs.reduce((s, l) => s + Math.abs(l.amount), 0);
    const counterAmount = counterLegs.reduce((s, l) => s + Math.abs(l.amount), 0);
    if (plAmount < 0.005) return;

    // Dominant buckets (by largest absolute leg)
    const dominantPLBucket = plLegs
      .slice()
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0].plBucket!;

    const dominantRoutedBucket: RoutedBucket =
      counterLegs.length === 0
        ? 'other'
        : counterLegs
            .slice()
            .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0]
            .routedBucket!;

    const isCashBankOnly =
      counterLegs.length > 0 &&
      counterLegs.every(
        (l) => l.routedBucket === 'bank' || l.routedBucket === 'cash',
      );

    // Take any row for voucher-level meta
    const sample = entries[0];
    const voucher: OrphanPLVoucher = {
      guid,
      date: String(sample.date ?? ''),
      voucher_number: String(sample.voucher_number ?? ''),
      voucher_type: String(sample.voucher_type ?? ''),
      narration: String(sample.narration ?? ''),
      plLegs,
      counterLegs,
      plAmount,
      counterAmount,
      dominantPLBucket,
      dominantRoutedBucket,
      isCashBankOnly,
    };
    flaggedAll.push(voucher);
    voucherTypeSet.add(voucher.voucher_type);
  });

  // ── Filters ────────────────────────────────────────────────────────────────
  const searchLower = (filters.search || '').trim().toLowerCase();
  const fromMs = filters.fromDate ? new Date(filters.fromDate).getTime() : null;
  const toMs = filters.toDate ? new Date(filters.toDate).getTime() : null;

  const vouchers = flaggedAll.filter((v) => {
    if (filters.hideCashBankOnly && v.isCashBankOnly) return false;
    if (v.plAmount < filters.minAmount) return false;
    if (filters.voucherTypeFilter !== 'all' && v.voucher_type !== filters.voucherTypeFilter)
      return false;
    if (filters.plBucketFilter !== 'all' && v.dominantPLBucket !== filters.plBucketFilter)
      return false;
    if (
      filters.routedBucketFilter !== 'all' &&
      v.dominantRoutedBucket !== filters.routedBucketFilter
    )
      return false;
    if (fromMs !== null && new Date(v.date).getTime() < fromMs) return false;
    if (toMs !== null && new Date(v.date).getTime() > toMs) return false;
    if (searchLower) {
      const blob = [
        v.voucher_number,
        v.voucher_type,
        v.narration,
        ...v.plLegs.map((l) => l.ledger),
        ...v.counterLegs.map((l) => l.ledger),
      ]
        .join(' ')
        .toLowerCase();
      if (!blob.includes(searchLower)) return false;
    }
    return true;
  });

  // Sort by orphan amount DESC so biggest exposures surface first.
  vouchers.sort((a, b) => b.plAmount - a.plAmount);

  // ── Stats (computed on post-filter set) ────────────────────────────────────
  const emptyPLStat = (): Record<PLBucket, OrphanPLBucketStat> => ({
    sales: { count: 0, amount: 0 },
    purchase: { count: 0, amount: 0 },
    direct_income: { count: 0, amount: 0 },
    indirect_income: { count: 0, amount: 0 },
    direct_expense: { count: 0, amount: 0 },
    indirect_expense: { count: 0, amount: 0 },
  });
  const emptyRoutedStat = (): Record<RoutedBucket, OrphanPLBucketStat> => ({
    bank: { count: 0, amount: 0 },
    cash: { count: 0, amount: 0 },
    loan: { count: 0, amount: 0 },
    capital: { count: 0, amount: 0 },
    tax: { count: 0, amount: 0 },
    current_asset: { count: 0, amount: 0 },
    current_liability: { count: 0, amount: 0 },
    fixed_asset: { count: 0, amount: 0 },
    investment: { count: 0, amount: 0 },
    stock: { count: 0, amount: 0 },
    other: { count: 0, amount: 0 },
  });

  const byPLBucket = emptyPLStat();
  const byRoutedBucket = emptyRoutedStat();
  let totalOrphanAmount = 0;
  let cashBankOnlyCount = 0;
  let cashBankOnlyAmount = 0;

  vouchers.forEach((v) => {
    totalOrphanAmount += v.plAmount;
    byPLBucket[v.dominantPLBucket].count += 1;
    byPLBucket[v.dominantPLBucket].amount += v.plAmount;
    byRoutedBucket[v.dominantRoutedBucket].count += 1;
    byRoutedBucket[v.dominantRoutedBucket].amount += v.plAmount;
    if (v.isCashBankOnly) {
      cashBankOnlyCount += 1;
      cashBankOnlyAmount += v.plAmount;
    }
  });

  const totalsUnfiltered = {
    flagged: flaggedAll.length,
    amount: flaggedAll.reduce((s, v) => s + v.plAmount, 0),
  };

  return {
    vouchers,
    stats: {
      totalVouchersScanned: voucherMap.size,
      totalFlagged: vouchers.length,
      totalOrphanAmount,
      cashBankOnlyCount,
      cashBankOnlyAmount,
      byPLBucket,
      byRoutedBucket,
      distinctVoucherTypes: Array.from(voucherTypeSet).sort(),
    },
    totalsUnfiltered,
  };
}

// ── Worker message handler ────────────────────────────────────────────────────
self.addEventListener('message', (event: MessageEvent<OrphanPLWorkerInput>) => {
  try {
    const out = computeOrphanVouchers(event.data);
    self.postMessage(out satisfies OrphanPLWorkerOutput);
  } catch (err: any) {
    self.postMessage({ error: err?.message ?? 'Orphan P&L computation failed' });
  }
});
