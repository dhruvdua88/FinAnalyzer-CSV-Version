// Schedule III Balance Sheet engine.
//
// A faithful TypeScript port of the balance-sheet logic in the companion
// project `tally-fin-statements` (financial_statements.py). It runs entirely
// client-side off a parsed TallyStore, so it works for plain-CSV ZIPs that
// never reach the SQL backend.
//
// Multi-branch: each uploaded ZIP is one branch (one company / division).
// Branches are built independently, tagged, then consolidated by concatenating
// ledgers and summing the P&L A/c — giving per-branch columns plus a
// Consolidated total, exactly like the reference app.
//
// Sign convention (Tally closing_balance / opening_balance):
//   negative -> debit balance  (normal for assets & expenses)
//   positive -> credit balance (normal for liabilities & income)
// On the face of the statement everything is shown POSITIVE, so:
//   asset display  = -closing   liability display = +closing

import type { TallyStore } from './tally';
import { nameKey } from './tally';

// ─── Schedule III primary-group classification ────────────────────────────────
// value = [side, scheduleHead]
type BsSide =
  | 'equity'
  | 'noncurrent_liab'
  | 'current_liab'
  | 'noncurrent_asset'
  | 'current_asset';

export const BS_MAP: Record<string, [BsSide, string]> = {
  // Assets
  'Fixed Assets': ['noncurrent_asset', 'Fixed Assets'],
  Investments: ['noncurrent_asset', 'Non-Current Investments'],
  'Deposits (Asset)': ['noncurrent_asset', 'Long-Term Loans & Advances'],
  'Loans & Advances (Asset)': ['noncurrent_asset', 'Long-Term Loans & Advances'],
  'Misc. Expenses (ASSET)': ['noncurrent_asset', 'Other Non-Current Assets'],
  'Stock-in-hand': ['current_asset', 'Inventories'],
  'Sundry Debtors': ['current_asset', 'Trade Receivables'],
  'Cash-in-hand': ['current_asset', 'Cash & Cash Equivalents'],
  'Bank Accounts': ['current_asset', 'Cash & Cash Equivalents'],
  'Current Assets': ['current_asset', 'Other Current Assets'],
  // Equity
  'Capital Account': ['equity', 'Share Capital'],
  'Reserves & Surplus': ['equity', 'Reserves & Surplus'],
  // Non-current liabilities
  'Secured Loans': ['noncurrent_liab', 'Long-Term Borrowings'],
  'Unsecured Loans': ['noncurrent_liab', 'Long-Term Borrowings'],
  'Loans (Liability)': ['noncurrent_liab', 'Long-Term Borrowings'],
  // Current liabilities
  'Bank OD A/c': ['current_liab', 'Short-Term Borrowings'],
  'Sundry Creditors': ['current_liab', 'Trade Payables'],
  'Current Liabilities': ['current_liab', 'Other Current Liabilities'],
  'Branch / Divisions': ['current_liab', 'Other Current Liabilities'],
  'Duties & Taxes': ['current_liab', 'Duties & Taxes (Net)'],
  Provisions: ['current_liab', 'Short-Term Provisions'],
  'Suspense A/c': ['current_liab', 'Other Current Liabilities'],
};

const PNL_PRIMARY_GROUPS = new Set([
  'Sales Accounts',
  'Direct Incomes',
  'Indirect Incomes',
  'Purchase Accounts',
  'Direct Expenses',
  'Indirect Expenses',
]);

// Heuristic keyword -> standard primary group, used when a Tally file carries a
// non-standard primary group (e.g. "Finance Cost", "Internet Sales"). Without
// inference these ledgers would be silently dropped, breaking the balance.
const INFER_KEYWORDS: Array<[string[], string]> = [
  // P&L — Revenue
  [['sales account', 'sales accounts', 'revenue', 'turnover'], 'Sales Accounts'],
  [['direct income', 'direct incomes'], 'Direct Incomes'],
  [['indirect income', 'indirect incomes', 'other income'], 'Indirect Incomes'],
  // P&L — Expenses
  [['purchase account', 'purchase accounts'], 'Purchase Accounts'],
  [['direct expense', 'direct expenses'], 'Direct Expenses'],
  [['finance cost', 'interest expense', 'interest paid'], 'Indirect Expenses'],
  [['indirect expense', 'indirect expenses'], 'Indirect Expenses'],
  [['expense', 'expenditure', 'cost', 'consumption'], 'Indirect Expenses'],
  // BS — Assets
  [['fixed asset', 'tangible asset', 'intangible asset', 'capital work', 'cwip'], 'Fixed Assets'],
  [['investment'], 'Investments'],
  [['stock', 'inventory', 'inventories'], 'Stock-in-hand'],
  [['sundry debtor', 'trade receivable', 'debtor'], 'Sundry Debtors'],
  [['cash-in-hand', 'cash in hand', 'petty cash'], 'Cash-in-hand'],
  [['bank account', 'bank'], 'Bank Accounts'],
  [['loan and advance', 'loans and advance', 'advance'], 'Loans & Advances (Asset)'],
  [['deposit'], 'Deposits (Asset)'],
  [['current asset'], 'Current Assets'],
  [['misc. expense', 'deferred expense', 'preliminary'], 'Misc. Expenses (ASSET)'],
  // BS — Equity
  [['share capital', 'equity capital', 'paid-up capital', 'capital account'], 'Capital Account'],
  [['reserve', 'surplus'], 'Reserves & Surplus'],
  // BS — Liabilities
  [['secured loan', 'term loan', 'vehicle loan'], 'Secured Loans'],
  [['unsecured loan'], 'Unsecured Loans'],
  [['bank od', 'overdraft', 'cc limit', 'cash credit', 'working capital loan'], 'Bank OD A/c'],
  [['sundry creditor', 'trade payable', 'creditor'], 'Sundry Creditors'],
  [['provision'], 'Provisions'],
  [['duties', 'taxes payable', 'gst', 'tds payable'], 'Duties & Taxes'],
  [['current liabilit', 'other liabilit'], 'Current Liabilities'],
  [['branch', 'division'], 'Branch / Divisions'],
  [['suspense'], 'Suspense A/c'],
];

export const inferStandardGroup = (primary: string, parents: Iterable<string>): string | null => {
  const text = `${primary} ${Array.from(parents).join(' ')}`.toLowerCase();
  for (const [keywords, target] of INFER_KEYWORDS) {
    if (keywords.some((kw) => text.includes(kw))) return target;
  }
  return null;
};

// Case-insensitive lookup from any Tally primary-group spelling to the canonical
// standard key used by BS_MAP / the P&L set. Tally exports vary in case
// ("Cash-in-Hand" vs "Cash-in-hand"), so we never match on exact case.
const CANONICAL_BY_LOWER: Record<string, string> = {};
for (const k of Object.keys(BS_MAP)) CANONICAL_BY_LOWER[k.toLowerCase()] = k;
for (const k of PNL_PRIMARY_GROUPS) CANONICAL_BY_LOWER[k.toLowerCase()] = k;

/** The special "drop this group from the statements" reclassification target. */
export const EXCLUDE_TARGET = '(exclude)';

/** Standard targets a user can map a primary group to, grouped for the picker. */
export const STANDARD_PRIMARY_OPTIONS: Array<{ group: string; options: string[] }> = [
  { group: 'Equity', options: ['Capital Account', 'Reserves & Surplus'] },
  { group: 'Borrowings', options: ['Secured Loans', 'Unsecured Loans', 'Loans (Liability)', 'Bank OD A/c'] },
  {
    group: 'Current Liabilities',
    options: ['Sundry Creditors', 'Duties & Taxes', 'Provisions', 'Current Liabilities', 'Branch / Divisions', 'Suspense A/c'],
  },
  {
    group: 'Non-Current Assets',
    options: ['Fixed Assets', 'Investments', 'Deposits (Asset)', 'Loans & Advances (Asset)', 'Misc. Expenses (ASSET)'],
  },
  {
    group: 'Current Assets',
    options: ['Stock-in-hand', 'Sundry Debtors', 'Cash-in-hand', 'Bank Accounts', 'Current Assets'],
  },
  {
    group: 'Profit & Loss',
    options: ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes', 'Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'],
  },
  { group: 'Other', options: [EXCLUDE_TARGET] },
];

export type ReclassifyMap = Record<string, string>; // key: rawPrimary.toLowerCase() -> standard primary

export type PrimaryResolution =
  | { primary: string; how: 'mapped' | 'inferred' | 'reclassified'; classified: true; bsOrPnl: 'bs' | 'pnl' }
  | { primary: string; how: 'unmapped' | 'excluded'; classified: false; bsOrPnl: null };

/** Resolve a raw Tally primary group to a standard key, honouring user overrides. */
export const resolvePrimary = (
  rawPrimary: string,
  parents: Iterable<string>,
  reclassify?: ReclassifyMap,
): PrimaryResolution => {
  const lk = rawPrimary.trim().toLowerCase();
  const override = reclassify?.[lk];
  if (override === EXCLUDE_TARGET) return { primary: rawPrimary, how: 'excluded', classified: false, bsOrPnl: null };
  if (override) {
    const canon = CANONICAL_BY_LOWER[override.toLowerCase()] || override;
    return { primary: canon, how: 'reclassified', classified: true, bsOrPnl: canon in BS_MAP ? 'bs' : 'pnl' };
  }
  const direct = CANONICAL_BY_LOWER[lk];
  if (direct) return { primary: direct, how: 'mapped', classified: true, bsOrPnl: direct in BS_MAP ? 'bs' : 'pnl' };
  const inferred = inferStandardGroup(rawPrimary, parents);
  if (inferred) return { primary: inferred, how: 'inferred', classified: true, bsOrPnl: inferred in BS_MAP ? 'bs' : 'pnl' };
  return { primary: rawPrimary, how: 'unmapped', classified: false, bsOrPnl: null };
};

// ─── Data model ───────────────────────────────────────────────────────────────

export interface BsLedger {
  name: string;
  parent: string; // Tally sub-group
  primary: string; // standard primary group (after inference)
  rawPrimary: string; // the original Tally primary group, pre-inference
  opening: number;
  closing: number;
  isDeemedPositive: boolean;
  branch: string;
}

export interface BsStockItem {
  openingValue: number; // Tally sign: stock-on-hand stored NEGATIVE
  closingValue: number;
  branch: string;
}

export interface BranchData {
  branchName: string;
  company: string;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  ledgers: BsLedger[];
  pnlBalance: number; // P&L A/c closing (cumulative) -> Reserves & Surplus
  pnlOpening: number; // P&L A/c opening (prior-year retained)
  stockItems: BsStockItem[];
  openingStockOverride: number | null;
  closingStockOverride: number | null;
  // Diagnostics surfaced to the UI
  unclassified: Array<{ name: string; rawPrimary: string; closing: number }>;
}

const safeNum = (v: any): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const ordinalDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getUTCDate();
  const suffix = day >= 11 && day <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
  const month = d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `${day}${suffix} ${month} ${d.getUTCFullYear()}`;
};

// ─── Build one branch from a parsed TallyStore ─────────────────────────────────

export const buildBranchFromStore = (
  store: TallyStore,
  branchName: string,
  reclassify?: ReclassifyMap,
): BranchData => {
  // Voucher-driven closing balances are the double-entry ground truth:
  //   closing(ledger) = opening(ledger) + Σ amount where voucher is_accounting_voucher
  // This sums to ₹0 across the trial balance, unlike Tally's presentation-layer
  // closing_balance which can carry stock / P&L synthesis adjustments.
  const movements = new Map<string, number>();
  for (const line of store.accountingLines) {
    const v = store.vouchers.get(line.guid);
    if (!v || !v.is_accounting_voucher) continue;
    const key = nameKey(line.ledger);
    movements.set(key, (movements.get(key) || 0) + safeNum(line.amount));
  }

  // P&L A/c — Tally synthesises it; read its balances directly.
  let pnlBalance = 0;
  let pnlOpening = 0;
  const pnlLedger = store.ledgers.get(nameKey('Profit & Loss A/c'));
  if (pnlLedger) {
    pnlBalance = safeNum(pnlLedger.closing_balance);
    pnlOpening = safeNum(pnlLedger.opening_balance);
  }

  // First pass: collect the parent sub-groups seen under each raw primary group,
  // so inference can look at the whole context (primary + parents).
  const rawPrimaryParents = new Map<string, Set<string>>();
  for (const ledger of store.ledgers.values()) {
    const group = store.groups.get(nameKey(ledger.parent));
    const rawPrimary = (group?.primary_group || group?.name || '').trim();
    if (!rawPrimary) continue;
    if (!rawPrimaryParents.has(rawPrimary)) rawPrimaryParents.set(rawPrimary, new Set());
    rawPrimaryParents.get(rawPrimary)!.add((ledger.parent || '').trim());
  }

  const ledgers: BsLedger[] = [];
  const unclassified: BranchData['unclassified'] = [];

  for (const ledger of store.ledgers.values()) {
    const name = (ledger.name || '').trim();
    if (!name || nameKey(name) === nameKey('Profit & Loss A/c')) continue;
    const group = store.groups.get(nameKey(ledger.parent));
    const rawPrimary = (group?.primary_group || group?.name || '').trim();
    if (!rawPrimary) continue; // no resolvable group -> outside BS/P&L

    const res = resolvePrimary(rawPrimary, rawPrimaryParents.get(rawPrimary) || [], reclassify);

    const opening = safeNum(ledger.opening_balance);
    const mvKey = nameKey(name);
    const closing = movements.has(mvKey)
      ? opening + (movements.get(mvKey) || 0)
      : safeNum(ledger.closing_balance);

    // Excluded groups are dropped from the statement entirely (absorbed by the plug).
    if (res.how === 'excluded') continue;

    ledgers.push({
      name,
      parent: (ledger.parent || '').trim(),
      primary: res.primary,
      rawPrimary,
      opening,
      closing,
      isDeemedPositive: Boolean(group?.is_deemedpositive),
      branch: branchName,
    });

    // A balance-sheet-natured ledger that still isn't classified is a balance risk.
    if (!res.classified && Math.abs(closing) > 0.5) {
      unclassified.push({ name, rawPrimary, closing });
    }
  }

  const stockItems: BsStockItem[] = [];
  for (const si of store.stockItems.values()) {
    stockItems.push({
      openingValue: safeNum(si.opening_value),
      closingValue: safeNum(si.closing_value),
      branch: branchName,
    });
  }

  const company = (store.meta?.companyName || branchName || 'Company')
    .replace('(from', '')
    .replace(')', '')
    .trim();
  const periodTo = store.meta?.periodTo || '';

  const branch: BranchData = {
    branchName,
    company,
    periodFrom: store.meta?.periodFrom || '',
    periodTo,
    periodLabel: ordinalDate(periodTo),
    ledgers,
    pnlBalance,
    pnlOpening,
    stockItems,
    openingStockOverride: null,
    closingStockOverride: null,
    unclassified,
  };

  resolveOpeningStockSource(branch);
  return branch;
};

// Opening-stock source self-correction.
// Tally's Stock-in-Hand ledger opening_balance (the trial-balance figure) can be
// stale relative to the stock register's opening_value. When the rest of the
// opening trial balance only ties to zero if opening stock equals the register
// figure, the ledger opening leaves a one-sided opening difference (the plug).
// So: try the register opening; keep it ONLY if it strictly shrinks the
// auto-balance plug, otherwise fall back to the ledger (trial-balance) opening.
// Closing stock is never touched here.
const resolveOpeningStockSource = (b: BranchData): void => {
  if (b.stockItems.length === 0) return;
  const ledgerOpen = -sumOpening(b, 'Stock-in-hand');
  const registerOpen = stockItemsOpeningTotal(b);
  if (Math.abs(registerOpen - ledgerOpen) < 0.5) return; // same source — nothing to decide

  b.openingStockOverride = ledgerOpen;
  const plugLedger = Math.abs(bsReconciliation(b));
  b.openingStockOverride = registerOpen;
  const plugRegister = Math.abs(bsReconciliation(b));

  // Register wins only when it brings the BS materially closer to balancing;
  // null restores the default ledger-first resolution in openingStock().
  b.openingStockOverride = plugRegister < plugLedger - 0.5 ? registerOpen : null;
};

// ─── Primary-group catalogue (drives the mapping UI) ───────────────────────────

export interface PrimaryGroupInfo {
  rawPrimary: string;
  count: number; // ledgers under this primary across all branches
  closingSum: number; // indicative magnitude (sum of mst_ledger closing_balance)
  branches: string[]; // which branches contain it
  resolution: PrimaryResolution;
}

/**
 * Enumerate every distinct Tally primary group across the given stores, with its
 * current resolution under `reclassify`. Reads stores directly (not built
 * BranchData) so excluded groups still appear and remain re-mappable.
 */
export const collectPrimaryGroups = (
  stores: Array<{ store: TallyStore; branchName: string }>,
  reclassify?: ReclassifyMap,
): PrimaryGroupInfo[] => {
  const agg = new Map<string, { count: number; closing: number; parents: Set<string>; branches: Set<string> }>();
  for (const { store, branchName } of stores) {
    for (const ledger of store.ledgers.values()) {
      if (nameKey(ledger.name || '') === nameKey('Profit & Loss A/c')) continue;
      const group = store.groups.get(nameKey(ledger.parent));
      const rawPrimary = ((group?.primary_group || group?.name) || '').trim();
      if (!rawPrimary) continue;
      let a = agg.get(rawPrimary);
      if (!a) {
        a = { count: 0, closing: 0, parents: new Set(), branches: new Set() };
        agg.set(rawPrimary, a);
      }
      a.count += 1;
      a.closing += safeNum(ledger.closing_balance);
      a.parents.add((ledger.parent || '').trim());
      a.branches.add(branchName);
    }
  }
  return Array.from(agg.entries())
    .map(([rawPrimary, a]) => ({
      rawPrimary,
      count: a.count,
      closingSum: a.closing,
      branches: Array.from(a.branches),
      resolution: resolvePrimary(rawPrimary, a.parents, reclassify),
    }))
    .sort((x, y) => Math.abs(y.closingSum) - Math.abs(x.closingSum));
};

// ─── Multi-branch consolidation ────────────────────────────────────────────────

export const consolidateBranches = (branches: BranchData[]): BranchData => {
  if (branches.length === 0) throw new Error('No branches to consolidate.');
  if (branches.length === 1) return branches[0];

  // Stock is non-linear: each branch may source it from a Stock-in-hand ledger
  // OR the inventory module. Concatenating ledgers would let one branch's large
  // stock ledger mask another's inventory-module stock. So consolidate stock by
  // SUMMING each branch's already-resolved figure (pinned as an override).
  const openingStockSum = branches.reduce((a, b) => a + openingStock(b), 0);
  const closingStockSum = branches.reduce((a, b) => a + closingStock(b), 0);

  return {
    branchName: 'Consolidated',
    company: branches.map((b) => b.company).join(' + '),
    periodFrom: branches[0].periodFrom,
    periodTo: branches[0].periodTo,
    periodLabel: branches[0].periodLabel,
    ledgers: branches.flatMap((b) => b.ledgers),
    pnlBalance: branches.reduce((a, b) => a + b.pnlBalance, 0),
    pnlOpening: branches.reduce((a, b) => a + b.pnlOpening, 0),
    stockItems: branches.flatMap((b) => b.stockItems),
    openingStockOverride: openingStockSum,
    closingStockOverride: closingStockSum,
    unclassified: branches.flatMap((b) =>
      b.unclassified.map((u) => ({ ...u, name: `${u.name} (${b.branchName})` })),
    ),
  };
};

/** True when all branches cover the same period; consolidation is only sound then. */
export const branchPeriodsMatch = (branches: BranchData[]): boolean => {
  if (branches.length <= 1) return true;
  const { periodFrom, periodTo } = branches[0];
  return branches.every((b) => b.periodFrom === periodFrom && b.periodTo === periodTo);
};

// ─── Balance-sheet computation (all return display-positive amounts) ────────────

export const ledgersFor = (b: BranchData, primary: string) => b.ledgers.filter((l) => l.primary === primary);
export const sumClosing = (b: BranchData, primary: string) =>
  ledgersFor(b, primary).reduce((s, l) => s + l.closing, 0);
const sumOpening = (b: BranchData, primary: string) =>
  ledgersFor(b, primary).reduce((s, l) => s + l.opening, 0);

// Sum (not first-match) so multiple deferred-tax ledgers — e.g. across
// consolidated branches — are all captured.
const deferredTax = (b: BranchData): number =>
  b.ledgers.filter((l) => l.name.toLowerCase().includes('deferred tax')).reduce((s, l) => s + l.closing, 0);

// Inventory
const stockItemsClosingTotal = (b: BranchData) =>
  b.stockItems.reduce((s, si) => s + -si.closingValue, 0);
const stockItemsOpeningTotal = (b: BranchData) =>
  b.stockItems.reduce((s, si) => s + -si.openingValue, 0);

export const closingStock = (b: BranchData): number => {
  if (b.closingStockOverride !== null) return b.closingStockOverride;
  const fromLedgers = -sumClosing(b, 'Stock-in-hand');
  if (Math.abs(fromLedgers) > 0.5 || b.stockItems.length === 0) return fromLedgers;
  return stockItemsClosingTotal(b);
};
export const openingStock = (b: BranchData): number => {
  if (b.openingStockOverride !== null) return b.openingStockOverride;
  const fromLedgers = -sumOpening(b, 'Stock-in-hand');
  if (Math.abs(fromLedgers) > 0.5 || b.stockItems.length === 0) return fromLedgers;
  return stockItemsOpeningTotal(b);
};

// Fixed assets net (gross debit balances less accumulated depreciation credit)
export const netFixedAssets = (b: BranchData): number => {
  let grossClose = 0;
  let deprClose = 0;
  for (const l of ledgersFor(b, 'Fixed Assets')) {
    const isDepr = l.name.toLowerCase().includes('depreciation') || l.name.toLowerCase().includes('accumulated');
    if (isDepr) deprClose += l.closing; // credit positive
    else grossClose += -l.closing; // debit negative -> negate
  }
  return grossClose - deprClose;
};

// Equity
export const shareCapital = (b: BranchData): number => {
  let total = 0;
  for (const l of ledgersFor(b, 'Capital Account')) {
    const lc = l.name.toLowerCase();
    if (!lc.includes('reserve') && !lc.includes('profit')) total += l.closing; // credit positive
  }
  return total;
};
export const reservesSurplus = (b: BranchData): number => {
  let res = sumClosing(b, 'Reserves & Surplus');
  for (const l of ledgersFor(b, 'Capital Account')) {
    if (l.name.toLowerCase().includes('reserve')) res += l.closing;
  }
  // Prior-year retained earnings (P&L A/c opening) + THIS year's voucher-derived
  // profit. We deliberately use the transaction-derived profit (income − expense
  // + change in inventory) rather than Tally's synthesised P&L A/c closing
  // balance: Tally auto-computes that closing without a voucher and it can fail
  // to reconcile to the underlying transactions, opening a gap on the BS. Using
  // the voucher-backed profit keeps the P&L tied to the BS, so the only residual
  // left is a genuine opening-balance difference.
  res += b.pnlOpening + currentYearProfit(b);
  return res;
};

// Liabilities
export const longTermBorrowings = (b: BranchData): number =>
  sumClosing(b, 'Secured Loans') + sumClosing(b, 'Unsecured Loans') + sumClosing(b, 'Loans (Liability)');
export const deferredTaxLiability = (b: BranchData): number => Math.max(0, deferredTax(b));
export const shortTermBorrowings = (b: BranchData): number => sumClosing(b, 'Bank OD A/c');
export const bankOdInBankAccounts = (b: BranchData): number =>
  ledgersFor(b, 'Bank Accounts').filter((l) => l.closing > 0).reduce((s, l) => s + l.closing, 0);
export const tradePayables = (b: BranchData): number => sumClosing(b, 'Sundry Creditors');
export const dutiesAndTaxesNet = (b: BranchData): number => sumClosing(b, 'Duties & Taxes');
export const otherCurrentLiabilities = (b: BranchData): number => {
  const cl = sumClosing(b, 'Current Liabilities');
  const branch = sumClosing(b, 'Branch / Divisions');
  const susp = sumClosing(b, 'Suspense A/c');
  return cl + branch + susp - deferredTax(b);
};
export const shortTermProvisions = (b: BranchData): number => sumClosing(b, 'Provisions');

// Assets
export const nonCurrentInvestments = (b: BranchData): number => -sumClosing(b, 'Investments');
export const longTermLoansAdvances = (b: BranchData): number =>
  -sumClosing(b, 'Deposits (Asset)') + -sumClosing(b, 'Loans & Advances (Asset)');
export const otherNonCurrentAssets = (b: BranchData): number => -sumClosing(b, 'Misc. Expenses (ASSET)');
export const deferredTaxAsset = (b: BranchData): number => Math.max(0, -deferredTax(b));
export const tradeReceivables = (b: BranchData): number => -sumClosing(b, 'Sundry Debtors');
export const cashAndBank = (b: BranchData): number => {
  const cash = -sumClosing(b, 'Cash-in-hand');
  const bankAsset = ledgersFor(b, 'Bank Accounts')
    .filter((l) => l.closing < 0)
    .reduce((s, l) => s + -l.closing, 0);
  return cash + bankAsset;
};
export const otherCurrentAssets = (b: BranchData): number => -sumClosing(b, 'Current Assets');

// Totals
export const totalEquity = (b: BranchData): number => shareCapital(b) + reservesSurplus(b);
export const totalNonCurrentLiab = (b: BranchData): number => longTermBorrowings(b) + deferredTaxLiability(b);
export const totalCurrentLiab = (b: BranchData): number =>
  shortTermBorrowings(b) +
  bankOdInBankAccounts(b) +
  tradePayables(b) +
  dutiesAndTaxesNet(b) +
  otherCurrentLiabilities(b) +
  shortTermProvisions(b);
export const totalNonCurrentAssets = (b: BranchData): number =>
  netFixedAssets(b) +
  nonCurrentInvestments(b) +
  longTermLoansAdvances(b) +
  otherNonCurrentAssets(b) +
  deferredTaxAsset(b);
export const totalCurrentAssets = (b: BranchData): number =>
  closingStock(b) + tradeReceivables(b) + cashAndBank(b) + otherCurrentAssets(b);
export const totalAssets = (b: BranchData): number => totalNonCurrentAssets(b) + totalCurrentAssets(b);
export const totalEquityLiabilities = (b: BranchData): number =>
  totalEquity(b) + totalNonCurrentLiab(b) + totalCurrentLiab(b);

// Auto-balance plug, shown on the face so the BS always closes.
export const bsReconciliation = (b: BranchData): number =>
  totalAssets(b) - totalEquityLiabilities(b);
// Tally's own booked current-year profit = the movement in the synthesised
// P&L A/c. Kept for reference / validation only — NOT used in the statements,
// because Tally computes it without a voucher and it can fail to reconcile to
// the transactions (see reservesSurplus / currentYearProfit).
export const bookedCurrentYearProfit = (b: BranchData): number => b.pnlBalance - b.pnlOpening;
// Voucher-backed current-year profit (income − expense + change in inventory).
// Defined as profit before tax; ties the P&L to the BS for every dataset.
export const currentYearProfit = (b: BranchData): number => profitBeforeTax(b);

// ─── Statement of Profit & Loss (uses ledger closing_balance, matches Tally) ────
// Sub-groups of Indirect Expenses carved out on the face of the P&L.
const FINANCE_COST_PARENTS = new Set(['Finance Costs', 'Finance Cost', 'Interest & Late Filing Fees']);
const EMPLOYEE_COST_PARENTS = new Set([
  'Employee benefit expenses',
  'Contribution to Provident Funds & Others',
  'Salary',
  'Salaries',
  'Staff Salary',
]);

const pnlByParent = (b: BranchData, primary: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const l of ledgersFor(b, primary)) out[l.parent] = (out[l.parent] || 0) + l.closing;
  return out;
};

export interface FaScheduleRow {
  name: string;
  grossOpen: number;
  additions: number;
  disposals: number;
  grossClose: number;
  deprOpen: number;
  deprCharge: number;
  deprClose: number;
  netOpen: number;
  netClose: number;
}

export const fixedAssetsSchedule = (b: BranchData): FaScheduleRow[] => {
  const by: Record<string, { go: number; gc: number; do_: number; dc: number }> = {};
  for (const l of ledgersFor(b, 'Fixed Assets')) {
    const sg = l.parent;
    by[sg] = by[sg] || { go: 0, gc: 0, do_: 0, dc: 0 };
    const isDepr = l.name.toLowerCase().includes('depreciation') || l.name.toLowerCase().includes('accumulated');
    if (isDepr) {
      by[sg].do_ += l.opening; // credit positive
      by[sg].dc += l.closing;
    } else {
      by[sg].go += -l.opening; // debit negative -> negate
      by[sg].gc += -l.closing;
    }
  }
  return Object.entries(by)
    .map(([name, d]) => ({
      name,
      grossOpen: d.go,
      additions: Math.max(0, d.gc - d.go),
      disposals: Math.max(0, d.go - d.gc),
      grossClose: d.gc,
      deprOpen: d.do_,
      deprCharge: Math.max(0, d.dc - d.do_),
      deprClose: d.dc,
      netOpen: d.go - d.do_,
      netClose: d.gc - d.dc,
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
};

export const revenueFromOps = (b: BranchData): number => sumClosing(b, 'Sales Accounts') + sumClosing(b, 'Direct Incomes');
export const otherIncome = (b: BranchData): number => sumClosing(b, 'Indirect Incomes');
export const purchases = (b: BranchData): number => -sumClosing(b, 'Purchase Accounts');
export const directExpenses = (b: BranchData): number => -sumClosing(b, 'Direct Expenses');
export const financeCosts = (b: BranchData): number => {
  const ibd = pnlByParent(b, 'Indirect Expenses');
  return Object.entries(ibd).reduce((s, [k, v]) => (FINANCE_COST_PARENTS.has(k) ? s - v : s), 0);
};
export const employeeCosts = (b: BranchData): number => {
  const ibd = pnlByParent(b, 'Indirect Expenses');
  return Object.entries(ibd).reduce((s, [k, v]) => (EMPLOYEE_COST_PARENTS.has(k) ? s - v : s), 0);
};
export const depreciationFromFA = (b: BranchData): number =>
  fixedAssetsSchedule(b).reduce((s, r) => s + r.deprCharge, 0);
export const otherIndirectExpenses = (b: BranchData): number => {
  const ibd = pnlByParent(b, 'Indirect Expenses');
  return Object.entries(ibd).reduce(
    (s, [k, v]) => (FINANCE_COST_PARENTS.has(k) || EMPLOYEE_COST_PARENTS.has(k) ? s : s - v),
    0,
  );
};
export const changesInInventories = (b: BranchData): number => openingStock(b) - closingStock(b);
export const totalExpenses = (b: BranchData): number =>
  purchases(b) +
  directExpenses(b) +
  employeeCosts(b) +
  financeCosts(b) +
  depreciationFromFA(b) +
  otherIndirectExpenses(b) +
  openingStock(b) -
  closingStock(b);
export const totalRevenue = (b: BranchData): number => revenueFromOps(b) + otherIncome(b);
export const profitBeforeTax = (b: BranchData): number => totalRevenue(b) - totalExpenses(b);
// We no longer plug tax to force PAT to Tally's synthesised figure (that masked
// the real reconciliation gap as "tax"). Current tax cannot be reliably isolated
// from a generic Tally export, so it is shown as nil; PAT = PBT (pre-tax result).
export const taxExpense = (_b: BranchData): number => 0;
export const profitAfterTax = (b: BranchData): number => profitBeforeTax(b) - taxExpense(b);

// ─── Statement line definitions (drive both single & multi-branch display) ──────

export type LineKind = 'header' | 'line' | 'subtotal' | 'total' | 'plug';

export interface BsLineDef {
  key: string;
  label: string;
  kind: LineKind;
  /** undefined for pure headers */
  fn?: (b: BranchData) => number;
  indent?: number;
}

export const BS_LINE_DEFS: BsLineDef[] = [
  { key: 'EL_HEAD', label: 'EQUITY AND LIABILITIES', kind: 'header' },
  { key: 'EQUITY_HEAD', label: "Shareholders' Funds", kind: 'header', indent: 1 },
  { key: 'share_capital', label: 'Share Capital', kind: 'line', fn: shareCapital, indent: 2 },
  { key: 'reserves', label: 'Reserves & Surplus', kind: 'line', fn: reservesSurplus, indent: 2 },
  { key: 'total_equity', label: "Total Shareholders' Funds", kind: 'subtotal', fn: totalEquity, indent: 1 },

  { key: 'NCL_HEAD', label: 'Non-Current Liabilities', kind: 'header', indent: 1 },
  { key: 'ltb', label: 'Long-Term Borrowings', kind: 'line', fn: longTermBorrowings, indent: 2 },
  { key: 'dtl', label: 'Deferred Tax Liabilities (Net)', kind: 'line', fn: deferredTaxLiability, indent: 2 },
  { key: 'total_ncl', label: 'Total Non-Current Liabilities', kind: 'subtotal', fn: totalNonCurrentLiab, indent: 1 },

  { key: 'CL_HEAD', label: 'Current Liabilities', kind: 'header', indent: 1 },
  { key: 'stb', label: 'Short-Term Borrowings', kind: 'line', fn: (b) => shortTermBorrowings(b) + bankOdInBankAccounts(b), indent: 2 },
  { key: 'payables', label: 'Trade Payables', kind: 'line', fn: tradePayables, indent: 2 },
  { key: 'dt_net', label: 'Duties & Taxes (Net)', kind: 'line', fn: dutiesAndTaxesNet, indent: 2 },
  { key: 'ocl', label: 'Other Current Liabilities', kind: 'line', fn: otherCurrentLiabilities, indent: 2 },
  { key: 'provisions', label: 'Short-Term Provisions', kind: 'line', fn: shortTermProvisions, indent: 2 },
  { key: 'total_cl', label: 'Total Current Liabilities', kind: 'subtotal', fn: totalCurrentLiab, indent: 1 },

  { key: 'plug', label: 'Opening Balance Difference (pre-existing / auto-balance)', kind: 'plug', fn: bsReconciliation, indent: 1 },
  { key: 'total_el', label: 'TOTAL EQUITY & LIABILITIES', kind: 'total', fn: (b) => totalEquityLiabilities(b) + bsReconciliation(b), indent: 0 },

  { key: 'A_HEAD', label: 'ASSETS', kind: 'header' },
  { key: 'NCA_HEAD', label: 'Non-Current Assets', kind: 'header', indent: 1 },
  { key: 'nfa', label: 'Fixed Assets (Net)', kind: 'line', fn: netFixedAssets, indent: 2 },
  { key: 'nci', label: 'Non-Current Investments', kind: 'line', fn: nonCurrentInvestments, indent: 2 },
  { key: 'ltla', label: 'Long-Term Loans & Advances', kind: 'line', fn: longTermLoansAdvances, indent: 2 },
  { key: 'onca', label: 'Other Non-Current Assets', kind: 'line', fn: otherNonCurrentAssets, indent: 2 },
  { key: 'dta', label: 'Deferred Tax Assets (Net)', kind: 'line', fn: deferredTaxAsset, indent: 2 },
  { key: 'total_nca', label: 'Total Non-Current Assets', kind: 'subtotal', fn: totalNonCurrentAssets, indent: 1 },

  { key: 'CA_HEAD', label: 'Current Assets', kind: 'header', indent: 1 },
  { key: 'inventories', label: 'Inventories', kind: 'line', fn: closingStock, indent: 2 },
  { key: 'receivables', label: 'Trade Receivables', kind: 'line', fn: tradeReceivables, indent: 2 },
  { key: 'cash', label: 'Cash & Cash Equivalents', kind: 'line', fn: cashAndBank, indent: 2 },
  { key: 'oca', label: 'Other Current Assets', kind: 'line', fn: otherCurrentAssets, indent: 2 },
  { key: 'total_ca', label: 'Total Current Assets', kind: 'subtotal', fn: totalCurrentAssets, indent: 1 },

  { key: 'total_assets', label: 'TOTAL ASSETS', kind: 'total', fn: totalAssets, indent: 0 },
];

export const PNL_LINE_DEFS: BsLineDef[] = [
  { key: 'rev', label: 'Revenue from Operations', kind: 'line', fn: revenueFromOps, indent: 1 },
  { key: 'oi', label: 'Other Income', kind: 'line', fn: otherIncome, indent: 1 },
  { key: 'total_rev', label: 'Total Revenue', kind: 'subtotal', fn: totalRevenue, indent: 0 },
  { key: 'EXP_HEAD', label: 'Expenses', kind: 'header' },
  { key: 'purch', label: 'Cost of Materials / Purchases', kind: 'line', fn: purchases, indent: 2 },
  { key: 'chg', label: 'Changes in Inventories', kind: 'line', fn: changesInInventories, indent: 2 },
  { key: 'emp', label: 'Employee Benefits Expense', kind: 'line', fn: employeeCosts, indent: 2 },
  { key: 'fin', label: 'Finance Costs', kind: 'line', fn: financeCosts, indent: 2 },
  { key: 'dep', label: 'Depreciation & Amortisation', kind: 'line', fn: depreciationFromFA, indent: 2 },
  { key: 'oexp', label: 'Other Expenses', kind: 'line', fn: (b) => otherIndirectExpenses(b) + directExpenses(b), indent: 2 },
  { key: 'total_exp', label: 'Total Expenses', kind: 'subtotal', fn: totalExpenses, indent: 0 },
  { key: 'pbt', label: 'Profit Before Tax', kind: 'subtotal', fn: profitBeforeTax, indent: 0 },
  { key: 'tax', label: 'Tax Expense', kind: 'line', fn: taxExpense, indent: 1 },
  { key: 'pat', label: 'Profit After Tax', kind: 'total', fn: profitAfterTax, indent: 0 },
];

export interface BsReport {
  branches: BranchData[]; // per-branch (excludes consolidated)
  consolidated: BranchData | null; // null when single branch
  columns: BranchData[]; // what the table renders: branches [+ consolidated]
  periodsMatch: boolean;
  lines: Array<{ def: BsLineDef; values: number[] }>; // values aligned to columns
}

export const buildReport = (branches: BranchData[]): BsReport => {
  const periodsMatch = branchPeriodsMatch(branches);
  const consolidated = branches.length > 1 && periodsMatch ? consolidateBranches(branches) : null;
  const columns = consolidated ? [...branches, consolidated] : [...branches];
  const lines = BS_LINE_DEFS.map((def) => ({
    def,
    values: def.fn ? columns.map((c) => def.fn!(c)) : columns.map(() => 0),
  }));
  return { branches, consolidated, columns, periodsMatch, lines };
};
