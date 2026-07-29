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

// ─── Schedule III line registry (Division I, incl. 2021 amendments) ───────────
//
// The face of the statement is data, not code paths. Every ledger is assigned
// exactly one `lineId` here, so a Schedule III line is simply "the ledgers that
// landed on it". That is what makes the notes, the ledger index and the balance
// check derivable rather than hand-maintained.

export type StatementSide =
  | 'equity'
  | 'noncurrent_liab'
  | 'current_liab'
  | 'noncurrent_asset'
  | 'current_asset'
  | 'pnl_income'
  | 'pnl_expense';

export interface Sch3Line {
  id: string;
  label: string;
  side: StatementSide;
  /** +1 for credit-natured lines (equity/liability/income), −1 for debit-natured. */
  displaySign: 1 | -1;
}

const CR = 1 as const;
const DR = -1 as const;

export const SCH3_LINES: Sch3Line[] = [
  // Shareholders' funds
  { id: 'share_capital', label: 'Share Capital', side: 'equity', displaySign: CR },
  { id: 'reserves_surplus', label: 'Reserves & Surplus', side: 'equity', displaySign: CR },
  { id: 'share_application', label: 'Share Application Money Pending Allotment', side: 'equity', displaySign: CR },
  // Non-current liabilities
  { id: 'lt_borrowings', label: 'Long-Term Borrowings', side: 'noncurrent_liab', displaySign: CR },
  { id: 'dtl', label: 'Deferred Tax Liabilities (Net)', side: 'noncurrent_liab', displaySign: CR },
  { id: 'other_lt_liab', label: 'Other Long-Term Liabilities', side: 'noncurrent_liab', displaySign: CR },
  { id: 'lt_provisions', label: 'Long-Term Provisions', side: 'noncurrent_liab', displaySign: CR },
  // Current liabilities
  { id: 'st_borrowings', label: 'Short-Term Borrowings', side: 'current_liab', displaySign: CR },
  { id: 'trade_payables_msme', label: 'Trade Payables — Micro & Small Enterprises', side: 'current_liab', displaySign: CR },
  { id: 'trade_payables_other', label: 'Trade Payables — Other than Micro & Small Enterprises', side: 'current_liab', displaySign: CR },
  { id: 'duties_taxes_payable', label: 'Statutory Dues Payable', side: 'current_liab', displaySign: CR },
  { id: 'employee_dues', label: 'Employee Benefits Payable', side: 'current_liab', displaySign: CR },
  { id: 'advances_from_customers', label: 'Advances from Customers', side: 'current_liab', displaySign: CR },
  { id: 'other_current_liab', label: 'Other Current Liabilities', side: 'current_liab', displaySign: CR },
  { id: 'st_provisions', label: 'Short-Term Provisions', side: 'current_liab', displaySign: CR },
  { id: 'unclassified_cr', label: 'Unclassified — credit balances (REVIEW)', side: 'current_liab', displaySign: CR },
  // Non-current assets
  { id: 'ppe', label: 'Property, Plant and Equipment', side: 'noncurrent_asset', displaySign: DR },
  { id: 'intangibles', label: 'Intangible Assets', side: 'noncurrent_asset', displaySign: DR },
  { id: 'cwip', label: 'Capital Work-in-Progress', side: 'noncurrent_asset', displaySign: DR },
  { id: 'intangibles_dev', label: 'Intangible Assets under Development', side: 'noncurrent_asset', displaySign: DR },
  { id: 'nc_investments', label: 'Non-Current Investments', side: 'noncurrent_asset', displaySign: DR },
  { id: 'dta', label: 'Deferred Tax Assets (Net)', side: 'noncurrent_asset', displaySign: DR },
  { id: 'lt_loans_advances', label: 'Long-Term Loans & Advances', side: 'noncurrent_asset', displaySign: DR },
  { id: 'other_nc_assets', label: 'Other Non-Current Assets', side: 'noncurrent_asset', displaySign: DR },
  // Current assets
  { id: 'c_investments', label: 'Current Investments', side: 'current_asset', displaySign: DR },
  { id: 'inventories', label: 'Inventories', side: 'current_asset', displaySign: DR },
  { id: 'trade_receivables', label: 'Trade Receivables', side: 'current_asset', displaySign: DR },
  { id: 'cash_bank', label: 'Cash & Cash Equivalents', side: 'current_asset', displaySign: DR },
  { id: 'st_loans_advances', label: 'Short-Term Loans & Advances', side: 'current_asset', displaySign: DR },
  { id: 'other_current_assets', label: 'Other Current Assets', side: 'current_asset', displaySign: DR },
  { id: 'unclassified_dr', label: 'Unclassified — debit balances (REVIEW)', side: 'current_asset', displaySign: DR },
  // Statement of Profit & Loss
  { id: 'revenue_ops', label: 'Revenue from Operations', side: 'pnl_income', displaySign: CR },
  { id: 'other_income', label: 'Other Income', side: 'pnl_income', displaySign: CR },
  { id: 'purchases', label: 'Purchases of Stock-in-Trade', side: 'pnl_expense', displaySign: DR },
  { id: 'direct_expenses', label: 'Direct Expenses', side: 'pnl_expense', displaySign: DR },
  { id: 'employee_benefits', label: 'Employee Benefits Expense', side: 'pnl_expense', displaySign: DR },
  { id: 'finance_costs', label: 'Finance Costs', side: 'pnl_expense', displaySign: DR },
  { id: 'depreciation', label: 'Depreciation & Amortisation Expense', side: 'pnl_expense', displaySign: DR },
  { id: 'other_expenses', label: 'Other Expenses', side: 'pnl_expense', displaySign: DR },
];

export const LINE_BY_ID: Record<string, Sch3Line> = Object.fromEntries(SCH3_LINES.map((l) => [l.id, l]));
const ASSET_SIDES = new Set<StatementSide>(['noncurrent_asset', 'current_asset']);
const LIAB_SIDES = new Set<StatementSide>(['noncurrent_liab', 'current_liab']);
export const isPnlLine = (id: string): boolean => (LINE_BY_ID[id]?.side ?? '').startsWith('pnl');

/** Where a ledger lands when only its Tally primary group is known. */
const PRIMARY_DEFAULT_LINE: Record<string, string> = {
  'Fixed Assets': 'ppe',
  Investments: 'nc_investments',
  'Deposits (Asset)': 'lt_loans_advances',
  'Loans & Advances (Asset)': 'st_loans_advances',
  'Misc. Expenses (ASSET)': 'other_nc_assets',
  'Stock-in-hand': 'inventories',
  'Sundry Debtors': 'trade_receivables',
  'Cash-in-hand': 'cash_bank',
  'Bank Accounts': 'cash_bank',
  'Current Assets': 'other_current_assets',
  'Capital Account': 'share_capital',
  'Reserves & Surplus': 'reserves_surplus',
  'Secured Loans': 'lt_borrowings',
  'Unsecured Loans': 'lt_borrowings',
  'Loans (Liability)': 'lt_borrowings',
  'Bank OD A/c': 'st_borrowings',
  'Sundry Creditors': 'trade_payables_other',
  'Current Liabilities': 'other_current_liab',
  'Branch / Divisions': 'other_current_liab',
  'Duties & Taxes': 'duties_taxes_payable',
  Provisions: 'st_provisions',
  'Suspense A/c': 'other_current_liab',
  'Sales Accounts': 'revenue_ops',
  'Direct Incomes': 'revenue_ops',
  'Indirect Incomes': 'other_income',
  'Purchase Accounts': 'purchases',
  'Direct Expenses': 'direct_expenses',
  'Indirect Expenses': 'other_expenses',
};

/** Targets a user may map a group or ledger to, grouped for the picker. */
export const SCH3_LINE_OPTIONS: Array<{ group: string; options: Array<{ id: string; label: string }> }> = [
  { group: 'Equity', options: ['share_capital', 'reserves_surplus', 'share_application'] },
  { group: 'Non-Current Liabilities', options: ['lt_borrowings', 'dtl', 'other_lt_liab', 'lt_provisions'] },
  {
    group: 'Current Liabilities',
    options: ['st_borrowings', 'trade_payables_msme', 'trade_payables_other', 'duties_taxes_payable',
      'employee_dues', 'advances_from_customers', 'other_current_liab', 'st_provisions'],
  },
  {
    group: 'Non-Current Assets',
    options: ['ppe', 'intangibles', 'cwip', 'intangibles_dev', 'nc_investments', 'dta', 'lt_loans_advances', 'other_nc_assets'],
  },
  {
    group: 'Current Assets',
    options: ['c_investments', 'inventories', 'trade_receivables', 'cash_bank', 'st_loans_advances', 'other_current_assets'],
  },
  {
    group: 'Profit & Loss',
    options: ['revenue_ops', 'other_income', 'purchases', 'direct_expenses', 'employee_benefits',
      'finance_costs', 'depreciation', 'other_expenses'],
  },
].map((g) => ({ group: g.group, options: g.options.map((id) => ({ id, label: LINE_BY_ID[id].label })) }));

// ─── Classification pipeline ──────────────────────────────────────────────────

export interface LedgerCtx {
  name: string;
  parent: string;
  /** Full group chain from the ledger's own group up to the primary group. */
  chain: string[];
  primary: string;
  rawPrimary: string;
  isDeemedPositive: boolean;
  opening: number;
  closing: number;
}

export type ClassifyHow =
  | 'ledger-override'
  | 'group-override'
  | 'rule'
  | 'sign-rule'
  | 'primary-default'
  | 'unclassified';

export interface Classification {
  lineId: string;
  how: ClassifyHow;
  ruleId?: string;
  /** Contra ledger (accumulated depreciation) — stays on its line, nets within it. */
  isContra?: boolean;
}

export type LedgerOverrideMap = Record<string, string>; // nameKey(ledger) -> lineId

/** Lines that carry gross block and its accumulated depreciation together. */
const FA_FAMILY_LINES = new Set(['ppe', 'intangibles', 'cwip', 'intangibles_dev']);

const rx = (re: RegExp, ...vals: string[]) => vals.some((v) => re.test(v || ''));

/**
 * Ledgers whose Tally group is Fixed Assets but which carry a credit balance are
 * accumulated depreciation / amortisation. Sign is the test, not spelling — real
 * files contain "Acculmated Dep on Plant and Machinery" and worse.
 */
export const isContraFA = (l: { primary: string; closing: number; opening: number; name: string }): boolean =>
  l.primary === 'Fixed Assets' &&
  (l.closing > 0 || l.opening > 0 || /\bacc\w*\s*dep|deprec|amorti[sz]/i.test(l.name));

interface Rule {
  id: string;
  match: (c: LedgerCtx) => boolean;
  line: string;
  contra?: boolean;
}

const chainHas = (c: LedgerCtx, re: RegExp) => c.chain.some((g) => re.test(g));

// Ordered; first match wins. Deliberately small — anything speculative belongs
// in a user override, not in a rule that silently moves other people's money.
const RULES: Rule[] = [
  {
    id: 'cwip',
    match: (c) => c.primary === 'Fixed Assets' && chainHas(c, /capital\s*work|work[-\s]*in[-\s]*progress|\bcwip\b/i),
    line: 'cwip',
  },
  {
    id: 'intangible_dev',
    match: (c) => chainHas(c, /intangible.*(development|progress)/i),
    line: 'intangibles_dev',
  },
  {
    id: 'intangible',
    match: (c) =>
      c.primary === 'Fixed Assets' &&
      (chainHas(c, /intangible/i) || rx(/software|website|licen[cs]e|goodwill|trademark|patent/i, c.name)),
    line: 'intangibles',
  },
  {
    // Accumulated depreciation stays inside PPE (net block presentation); the
    // flag drives the fixed-asset schedule.
    id: 'accum_depr',
    match: (c) => isContraFA(c),
    line: 'ppe',
    contra: true,
  },
  {
    id: 'employee_dues',
    match: (c) =>
      PRIMARY_DEFAULT_LINE[c.primary] === 'trade_payables_other' &&
      chainHas(c, /staff|employee|salar|wages|payroll/i),
    line: 'employee_dues',
  },
  {
    id: 'tds_receivable',
    match: (c) =>
      ASSET_SIDES.has(LINE_BY_ID[PRIMARY_DEFAULT_LINE[c.primary] ?? '']?.side as StatementSide) &&
      rx(/\btds\b.*rec|advance\s*tax|income\s*tax\s*refund|self\s*assessment/i, c.name),
    line: 'st_loans_advances',
  },
  {
    id: 'interest_payable',
    match: (c) =>
      PRIMARY_DEFAULT_LINE[c.primary] === 'lt_borrowings' && rx(/interest\s*(payable|accrued)/i, c.name),
    line: 'other_current_liab',
  },
  {
    id: 'credit_card',
    match: (c) => PRIMARY_DEFAULT_LINE[c.primary] === 'lt_borrowings' && rx(/credit\s*card/i, c.name),
    line: 'other_current_liab',
  },
  // ── Statement of Profit & Loss ──
  {
    id: 'employee_benefits',
    match: (c) =>
      isPnlLine(PRIMARY_DEFAULT_LINE[c.primary] ?? '') &&
      LINE_BY_ID[PRIMARY_DEFAULT_LINE[c.primary]]?.side === 'pnl_expense' &&
      (rx(/salar|wage|bonus|\bepfo?\b|provident|\bpf\b|\besic?\b|gratuit|staff|employee|recruit|remuneration/i, c.name) ||
        chainHas(c, /salar|wage|employee\s*benefit|provident|payroll|staff/i)),
    line: 'employee_benefits',
  },
  {
    id: 'finance_costs',
    match: (c) =>
      LINE_BY_ID[PRIMARY_DEFAULT_LINE[c.primary] ?? '']?.side === 'pnl_expense' &&
      (rx(/\binterest\b|finance\s*(cost|charge)|loan\s*processing|bank\s*guarantee\s*comm/i, c.name) ||
        chainHas(c, /finance\s*cost|interest/i)),
    line: 'finance_costs',
  },
  {
    id: 'depreciation',
    match: (c) =>
      LINE_BY_ID[PRIMARY_DEFAULT_LINE[c.primary] ?? '']?.side === 'pnl_expense' &&
      rx(/deprec|amorti[sz]/i, c.name),
    line: 'depreciation',
  },
];

// Deferred tax is netted across the branch (Schedule III requires net
// presentation), so it is resolved after the per-ledger pass.
const isDeferredTax = (c: { name: string }) => /deferred\s*tax/i.test(c.name);

/**
 * Sign-based reclassification. Each entry MOVES a whole ledger from one line to
 * another — amounts are never split or netted — so the balance-sheet identity is
 * preserved by construction.
 */
const applySignRules = (
  lineId: string,
  c: LedgerCtx,
): { lineId: string; ruleId: string } | null => {
  const line = LINE_BY_ID[lineId];
  if (!line) return null;

  // Schedule III forbids netting debit-balance creditors against payables.
  if ((lineId === 'trade_payables_other' || lineId === 'trade_payables_msme') && c.closing < 0)
    return { lineId: 'st_loans_advances', ruleId: 'debit_creditor' };
  if (lineId === 'trade_receivables' && c.closing > 0)
    return { lineId: 'advances_from_customers', ruleId: 'credit_debtor' };
  if (lineId === 'employee_dues' && c.closing < 0)
    return { lineId: 'st_loans_advances', ruleId: 'debit_employee' };

  // Statutory dues: debit balances are recoverable from the authority.
  if (lineId === 'duties_taxes_payable' && c.closing < 0)
    return { lineId: 'st_loans_advances', ruleId: 'statutory_dues_debit' };

  // Bank accounts running in credit are overdrafts, i.e. short-term borrowings.
  if (lineId === 'cash_bank' && c.closing > 0)
    return { lineId: 'st_borrowings', ruleId: 'bank_overdraft' };

  // A credit balance in an asset group is a liability whatever group it sits in
  // (and vice versa). Presenting it as a negative asset is a Schedule III breach.
  if (ASSET_SIDES.has(line.side) && c.closing > 0 && !FA_FAMILY_LINES.has(lineId))
    return { lineId: 'other_current_liab', ruleId: 'credit_in_asset_group' };
  if (LIAB_SIDES.has(line.side) && c.closing < 0 && lineId !== 'unclassified_cr')
    return { lineId: 'other_current_assets', ruleId: 'debit_in_liability_group' };

  return null;
};

export const classifyLedger = (
  c: LedgerCtx,
  reclassify?: ReclassifyMap,
  ledgerOverrides?: LedgerOverrideMap,
  msmeLedgers?: Set<string>,
): Classification => {
  // 1. Ledger-level user override — the most specific instruction there is.
  const lo = ledgerOverrides?.[nameKey(c.name)];
  if (lo && LINE_BY_ID[lo]) return { lineId: lo, how: 'ledger-override' };

  // 2. Group-level user override, nearest ancestor first.
  for (const g of c.chain) {
    const ov = reclassify?.[g.trim().toLowerCase()];
    if (!ov) continue;
    if (LINE_BY_ID[ov]) return { lineId: ov, how: 'group-override' };
    // Backward compatibility: older overrides name a standard primary group.
    const legacy = PRIMARY_DEFAULT_LINE[CANONICAL_BY_LOWER[ov.toLowerCase()] ?? ov];
    if (legacy) return { lineId: legacy, how: 'group-override' };
  }

  // 3. Deferred tax — netted branch-wide, resolved in a later pass.
  if (isDeferredTax(c)) return { lineId: 'dta', how: 'rule', ruleId: 'deferred_tax' };

  // 4. Built-in sub-group / ledger rules.
  let lineId: string | null = null;
  let how: ClassifyHow = 'rule';
  let ruleId: string | undefined;
  let isContra = false;
  for (const r of RULES) {
    if (!r.match(c)) continue;
    lineId = r.line;
    ruleId = r.id;
    isContra = Boolean(r.contra);
    break;
  }

  // 5. Primary-group default.
  if (!lineId) {
    const def = PRIMARY_DEFAULT_LINE[c.primary];
    if (def) {
      lineId = def;
      how = 'primary-default';
      ruleId = undefined;
    }
  }

  // 6. Nothing matched — park it visibly. Never dropped, never plugged.
  if (!lineId) {
    return { lineId: c.closing < 0 ? 'unclassified_dr' : 'unclassified_cr', how: 'unclassified' };
  }

  // MSME tagging happens before the sign rules so a debit-balance MSME vendor
  // still reclassifies to advances.
  if (lineId === 'trade_payables_other' && msmeLedgers?.has(nameKey(c.name))) lineId = 'trade_payables_msme';

  // Any credit balance on a fixed-asset-family line is accumulated depreciation /
  // amortisation. Sign is the test, not spelling: real charts of accounts contain
  // "Acculmated Dep on Plant and Machinery". It nets inside its own line rather
  // than moving to liabilities.
  if (FA_FAMILY_LINES.has(lineId) && (c.closing > 0 || c.opening > 0)) isContra = true;

  // 7. Sign-based reclassification (contra fixed assets are exempt).
  if (!isContra) {
    const moved = applySignRules(lineId, c);
    if (moved) return { lineId: moved.lineId, how: 'sign-rule', ruleId: moved.ruleId };
  }

  return { lineId, how, ruleId, isContra };
};

// ─── Data model ───────────────────────────────────────────────────────────────

export interface BsLedger {
  name: string;
  parent: string; // Tally sub-group
  primary: string; // standard primary group (after inference)
  rawPrimary: string; // the original Tally primary group, pre-inference
  /** Full Tally group chain, ledger's own group first, primary group last. */
  chain: string[];
  opening: number;
  closing: number;
  isDeemedPositive: boolean;
  branch: string;
  /** The Schedule III line this ledger lands on. Every ledger has exactly one. */
  lineId: string;
  how: ClassifyHow;
  ruleId?: string;
  /** Accumulated depreciation: nets inside PPE rather than moving line. */
  isContra?: boolean;
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
  diagnostics: BsDiagnostic[];
}

export interface BsDiagnostic {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  ledger?: string;
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

/** Walk a ledger's group up to its primary group. Cycle-safe. */
const groupChain = (store: TallyStore, parent: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  let g = (parent || '').trim();
  while (g && !seen.has(nameKey(g))) {
    seen.add(nameKey(g));
    out.push(g);
    const node = store.groups.get(nameKey(g));
    const next = (node?.parent || '').trim();
    if (!next) {
      const prim = (node?.primary_group || '').trim();
      if (prim && !seen.has(nameKey(prim))) out.push(prim);
      break;
    }
    g = next;
  }
  return out;
};

export const buildBranchFromStore = (
  store: TallyStore,
  branchName: string,
  reclassify?: ReclassifyMap,
  ledgerOverrides?: LedgerOverrideMap,
  msmeLedgers?: Set<string>,
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

  // P&L A/c — Tally leaves closing_balance at 0 for this synthesised ledger, so
  // read it the same way as every other ledger: opening + voucher movements.
  // This ledger carries the contra of the year-end transfer JV when the client
  // has posted one, and it is the sole reason a raw Tally trial balance appears
  // not to sum to zero.
  let pnlBalance = 0;
  let pnlOpening = 0;
  const pnlLedger = store.ledgers.get(nameKey('Profit & Loss A/c'));
  if (pnlLedger) {
    pnlOpening = safeNum(pnlLedger.opening_balance);
    pnlBalance = pnlOpening + (movements.get(nameKey('Profit & Loss A/c')) || 0);
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

    // Excluded groups leave the statement entirely; this CAN unbalance it, which
    // is why every exclusion is reported as a diagnostic.
    if (res.how === 'excluded') continue;

    const chain = groupChain(store, (ledger.parent || '').trim());
    const ctx: LedgerCtx = {
      name,
      parent: (ledger.parent || '').trim(),
      chain,
      primary: res.primary,
      rawPrimary,
      isDeemedPositive: Boolean(group?.is_deemedpositive),
      opening,
      closing,
    };
    const cls = classifyLedger(ctx, reclassify, ledgerOverrides, msmeLedgers);

    ledgers.push({
      name,
      parent: (ledger.parent || '').trim(),
      primary: res.primary,
      rawPrimary,
      chain,
      opening,
      closing,
      isDeemedPositive: Boolean(group?.is_deemedpositive),
      branch: branchName,
      lineId: cls.lineId,
      how: cls.how,
      ruleId: cls.ruleId,
      isContra: cls.isContra,
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
    diagnostics: [],
  };

  resolveDeferredTaxSide(branch);
  reportClassificationDiagnostics(branch);
  reportStockRegisterMismatch(branch);
  assertBranchInvariants(branch);
  return branch;
};

/**
 * Schedule III requires deferred tax to be presented NET, as either an asset or
 * a liability. Every deferred-tax ledger is provisionally put on `dta`; here the
 * branch-wide net decides the side and all of them move together, so the two
 * lines are never both populated.
 */
const resolveDeferredTaxSide = (b: BranchData): void => {
  const dt = b.ledgers.filter((l) => l.ruleId === 'deferred_tax');
  if (dt.length === 0) return;
  const net = dt.reduce((s, l) => s + l.closing, 0);
  const target = net > 0 ? 'dtl' : 'dta';
  for (const l of dt) l.lineId = target;
};

/** Report anything a human needs to look at before signing the statement. */
const reportClassificationDiagnostics = (b: BranchData): void => {
  for (const l of b.ledgers) {
    if (Math.abs(l.closing) <= 0.5) continue;
    if (l.lineId === 'unclassified_dr' || l.lineId === 'unclassified_cr') {
      b.diagnostics.push({
        severity: 'error',
        code: 'UNCLASSIFIED_LEDGER',
        ledger: l.name,
        message:
          `"${l.name}" (group "${l.parent}", primary "${l.rawPrimary}") did not match any ` +
          `Schedule III line. It is shown under Unclassified so the statement still balances — ` +
          `map its group or the ledger itself before issuing.`,
      });
    } else if (l.ruleId === 'credit_in_asset_group') {
      b.diagnostics.push({
        severity: 'warn',
        code: 'CREDIT_IN_ASSET_GROUP',
        ledger: l.name,
        message:
          `"${l.name}" sits in the asset group "${l.parent}" but carries a credit balance of ` +
          `${l.closing.toFixed(2)}; presented under Other Current Liabilities. Confirm its nature.`,
      });
    } else if (l.ruleId === 'debit_in_liability_group') {
      b.diagnostics.push({
        severity: 'warn',
        code: 'DEBIT_IN_LIABILITY_GROUP',
        ledger: l.name,
        message:
          `"${l.name}" sits in the liability group "${l.parent}" but carries a debit balance of ` +
          `${Math.abs(l.closing).toFixed(2)}; presented under Other Current Assets. Confirm its nature.`,
      });
    }
  }

  // The P&L depreciation charge must come from the books. If the fixed-asset
  // schedule implies a different figure, that is a finding, not a substitution.
  const booked = lineSum(b, 'depreciation');
  const derived = fixedAssetsSchedule(b).reduce((s, r) => s + r.deprCharge, 0);
  if (Math.abs(booked - derived) > 1) {
    b.diagnostics.push({
      severity: 'warn',
      code: 'DEPR_MISMATCH',
      message:
        `Depreciation charged in the P&L (${booked.toFixed(2)}) differs from the movement in the ` +
        `accumulated-depreciation ledgers (${derived.toFixed(2)}). The P&L figure is used.`,
    });
  }
};

// The stock register is a memorandum record. Where it disagrees with the
// Stock-in-Hand ledger, report it — never silently substitute one for the other,
// which would put a one-sided amount on the balance sheet.
const reportStockRegisterMismatch = (b: BranchData): void => {
  if (b.stockItems.length === 0) return;
  for (const [label, register, ledger] of [
    ['Opening', stockItemsOpeningTotal(b), openingStock(b)],
    ['Closing', stockItemsClosingTotal(b), closingStock(b)],
  ] as Array<[string, number, number]>) {
    if (Math.abs(register - ledger) <= 0.5) continue;
    b.diagnostics.push({
      severity: 'warn',
      code: 'STOCK_REGISTER_MISMATCH',
      message:
        `${label} stock per the stock register (${register.toFixed(2)}) does not agree with the ` +
        `Stock-in-Hand ledger (${ledger.toFixed(2)}); difference ${(register - ledger).toFixed(2)}. ` +
        `The balance sheet uses the ledger figure.`,
    });
  }
};

/**
 * The balance sheet must close on its own arithmetic. A non-zero difference is a
 * classification or data defect to be surfaced, never a figure to be plugged.
 */
export const assertBranchInvariants = (b: BranchData): void => {
  const diff = bsReconciliation(b);
  if (Math.abs(diff) > 0.005) {
    b.diagnostics.push({
      severity: 'error',
      code: 'BALANCE_BROKEN',
      message:
        `Balance sheet does not balance: Assets − Equity & Liabilities = ${diff.toFixed(2)}. ` +
        `Review ledger classification and any excluded groups before issuing this statement.`,
    });
  }
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

  const consolidated: BranchData = {
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
    diagnostics: branches.flatMap((b) =>
      b.diagnostics.map((d) => ({ ...d, message: `[${b.branchName}] ${d.message}` })),
    ),
  };

  assertBranchInvariants(consolidated);
  return consolidated;
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

// Inventory on the balance sheet comes from the Stock-in-Hand LEDGER only.
// The stock register is a memorandum record: when it disagrees with the ledger
// that is an audit finding (emitted as STOCK_REGISTER_MISMATCH), not an input.
// Taking the register figure whenever the ledger was nil used to inject a
// one-sided amount into assets with no matching credit.
export const closingStock = (b: BranchData): number =>
  b.closingStockOverride !== null ? b.closingStockOverride : lineSum(b, 'inventories');
export const openingStock = (b: BranchData): number =>
  b.openingStockOverride !== null ? b.openingStockOverride : lineOpening(b, 'inventories');

// Equity
export const shareCapital = (b: BranchData): number => lineSum(b, 'share_capital');
/** Net closing of every ledger that belongs to the P&L (credit positive). */
const pnlLedgerSum = (b: BranchData): number =>
  b.ledgers.reduce((s, l) => (isPnlLine(l.lineId) ? s + l.closing : s), 0);

/**
 * The amount of surplus that still has to be carried into Reserves.
 *
 *   surplusTransfer = Σ(P&L-group ledger closings) + P&L A/c ledger balance
 *
 * Because every ledger closing sums to zero across the trial balance, this one
 * formula is correct whether or not the client posted the year-end transfer JV:
 *
 *   • JV posted     — the revenue ledgers still carry the profit and the P&L A/c
 *                     ledger carries its exact contra, so the two cancel and we
 *                     add 0; the Reserves ledger already holds the profit.
 *   • JV not posted — the P&L A/c ledger is nil (or holds only prior-year
 *                     retained earnings) and we carry the profit in.
 *
 * The previous code added `pnlOpening + currentYearProfit` unconditionally,
 * which double-counted the profit for every client who had posted the JV.
 * Do NOT add `pnlOpening` here — `pnlBalance` already includes it.
 */
export const surplusTransfer = (b: BranchData): number => pnlLedgerSum(b) + b.pnlBalance;

export const reservesSurplus = (b: BranchData): number => lineSum(b, 'reserves_surplus') + surplusTransfer(b);

// ─── Line aggregation ─────────────────────────────────────────────────────────
// Every figure on the face is "the ledgers that landed on this line", signed for
// display. Nothing is computed from a Tally primary group any more, so a
// reclassification automatically moves the money and the notes together.

export const ledgersForLine = (b: BranchData, lineId: string): BsLedger[] =>
  b.ledgers.filter((l) => l.lineId === lineId);

export const lineSum = (b: BranchData, lineId: string): number => {
  const sign = LINE_BY_ID[lineId]?.displaySign ?? 1;
  return sign * ledgersForLine(b, lineId).reduce((s, l) => s + l.closing, 0);
};

const lineOpening = (b: BranchData, lineId: string): number => {
  const sign = LINE_BY_ID[lineId]?.displaySign ?? 1;
  return sign * ledgersForLine(b, lineId).reduce((s, l) => s + l.opening, 0);
};

// Liabilities
export const longTermBorrowings = (b: BranchData): number => lineSum(b, 'lt_borrowings');
export const deferredTaxLiability = (b: BranchData): number => lineSum(b, 'dtl');
export const shortTermBorrowings = (b: BranchData): number => lineSum(b, 'st_borrowings');
/** Bank accounts in credit are now classified straight to short-term borrowings. */
export const bankOdInBankAccounts = (_b: BranchData): number => 0;
export const tradePayablesMsme = (b: BranchData): number => lineSum(b, 'trade_payables_msme');
export const tradePayablesOther = (b: BranchData): number => lineSum(b, 'trade_payables_other');
export const tradePayables = (b: BranchData): number => tradePayablesMsme(b) + tradePayablesOther(b);
export const dutiesTaxesPayable = (b: BranchData): number => lineSum(b, 'duties_taxes_payable');
export const employeeDues = (b: BranchData): number => lineSum(b, 'employee_dues');
export const advancesFromCustomers = (b: BranchData): number => lineSum(b, 'advances_from_customers');
export const otherCurrentLiabilities = (b: BranchData): number => lineSum(b, 'other_current_liab');
export const shortTermProvisions = (b: BranchData): number => lineSum(b, 'st_provisions');
export const otherLongTermLiabilities = (b: BranchData): number => lineSum(b, 'other_lt_liab');
export const longTermProvisions = (b: BranchData): number => lineSum(b, 'lt_provisions');
export const shareApplicationMoney = (b: BranchData): number => lineSum(b, 'share_application');
export const unclassifiedCr = (b: BranchData): number => lineSum(b, 'unclassified_cr');

// Assets
export const netFixedAssets = (b: BranchData): number => lineSum(b, 'ppe');
export const intangibleAssets = (b: BranchData): number => lineSum(b, 'intangibles');
export const cwipTotal = (b: BranchData): number => lineSum(b, 'cwip');
export const intangiblesUnderDevelopment = (b: BranchData): number => lineSum(b, 'intangibles_dev');
export const nonCurrentInvestments = (b: BranchData): number => lineSum(b, 'nc_investments');
export const currentInvestments = (b: BranchData): number => lineSum(b, 'c_investments');
export const longTermLoansAdvances = (b: BranchData): number => lineSum(b, 'lt_loans_advances');
export const shortTermLoansAdvances = (b: BranchData): number => lineSum(b, 'st_loans_advances');
export const otherNonCurrentAssets = (b: BranchData): number => lineSum(b, 'other_nc_assets');
export const deferredTaxAsset = (b: BranchData): number => lineSum(b, 'dta');
export const tradeReceivables = (b: BranchData): number => lineSum(b, 'trade_receivables');
export const cashAndBank = (b: BranchData): number => lineSum(b, 'cash_bank');
export const otherCurrentAssets = (b: BranchData): number => lineSum(b, 'other_current_assets');
export const unclassifiedDr = (b: BranchData): number => lineSum(b, 'unclassified_dr');

// Totals
export const totalEquity = (b: BranchData): number =>
  shareCapital(b) + reservesSurplus(b) + shareApplicationMoney(b);
export const totalNonCurrentLiab = (b: BranchData): number =>
  longTermBorrowings(b) + deferredTaxLiability(b) + otherLongTermLiabilities(b) + longTermProvisions(b);
export const totalCurrentLiab = (b: BranchData): number =>
  shortTermBorrowings(b) +
  tradePayables(b) +
  dutiesTaxesPayable(b) +
  employeeDues(b) +
  advancesFromCustomers(b) +
  otherCurrentLiabilities(b) +
  shortTermProvisions(b) +
  unclassifiedCr(b);
export const totalNonCurrentAssets = (b: BranchData): number =>
  netFixedAssets(b) +
  intangibleAssets(b) +
  cwipTotal(b) +
  intangiblesUnderDevelopment(b) +
  nonCurrentInvestments(b) +
  deferredTaxAsset(b) +
  longTermLoansAdvances(b) +
  otherNonCurrentAssets(b);
export const totalCurrentAssets = (b: BranchData): number =>
  currentInvestments(b) +
  closingStock(b) +
  tradeReceivables(b) +
  cashAndBank(b) +
  shortTermLoansAdvances(b) +
  otherCurrentAssets(b) +
  unclassifiedDr(b);
export const totalAssets = (b: BranchData): number => totalNonCurrentAssets(b) + totalCurrentAssets(b);
export const totalEquityLiabilities = (b: BranchData): number =>
  totalEquity(b) + totalNonCurrentLiab(b) + totalCurrentLiab(b);

// The balance check: Assets − Equity & Liabilities. MUST be 0. A non-zero value
// means a classification or data defect and is surfaced as an error — it is
// never shown as a balancing figure on the face of the statement.
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
export const FINANCE_COST_PARENTS = new Set(['Finance Costs', 'Finance Cost', 'Interest & Late Filing Fees']);
export const EMPLOYEE_COST_PARENTS = new Set([
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
  for (const l of b.ledgers.filter((x) => FA_FAMILY_LINES.has(x.lineId))) {
    const sg = l.parent;
    by[sg] = by[sg] || { go: 0, gc: 0, do_: 0, dc: 0 };
    const isDepr = Boolean(l.isContra);
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

export const revenueFromOps = (b: BranchData): number => lineSum(b, 'revenue_ops');
export const otherIncome = (b: BranchData): number => lineSum(b, 'other_income');
export const purchases = (b: BranchData): number => lineSum(b, 'purchases');
export const directExpenses = (b: BranchData): number => lineSum(b, 'direct_expenses');
export const financeCosts = (b: BranchData): number => lineSum(b, 'finance_costs');
export const employeeCosts = (b: BranchData): number => lineSum(b, 'employee_benefits');
/** Depreciation implied by the movement in the accumulated-depreciation ledgers. */
export const depreciationFromFA = (b: BranchData): number =>
  fixedAssetsSchedule(b).reduce((s, r) => s + r.deprCharge, 0);
/**
 * The charge as booked in the P&L. Deliberately NOT the fixed-asset-schedule
 * figure: the statement must tie to the ledgers. A difference between the two is
 * reported as DEPR_MISMATCH instead of being silently substituted.
 */
export const depreciation = (b: BranchData): number => lineSum(b, 'depreciation');
export const otherIndirectExpenses = (b: BranchData): number => lineSum(b, 'other_expenses');
export const changesInInventories = (b: BranchData): number => openingStock(b) - closingStock(b);
export const totalExpenses = (b: BranchData): number =>
  purchases(b) +
  directExpenses(b) +
  employeeCosts(b) +
  financeCosts(b) +
  depreciation(b) +
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

export type LineKind = 'header' | 'line' | 'subtotal' | 'total';

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
  { key: 'share_application', label: 'Share Application Money Pending Allotment', kind: 'line', fn: shareApplicationMoney, indent: 2 },
  { key: 'total_equity', label: "Total Shareholders' Funds", kind: 'subtotal', fn: totalEquity, indent: 1 },

  { key: 'NCL_HEAD', label: 'Non-Current Liabilities', kind: 'header', indent: 1 },
  { key: 'ltb', label: 'Long-Term Borrowings', kind: 'line', fn: longTermBorrowings, indent: 2 },
  { key: 'dtl', label: 'Deferred Tax Liabilities (Net)', kind: 'line', fn: deferredTaxLiability, indent: 2 },
  { key: 'oltl', label: 'Other Long-Term Liabilities', kind: 'line', fn: otherLongTermLiabilities, indent: 2 },
  { key: 'ltp', label: 'Long-Term Provisions', kind: 'line', fn: longTermProvisions, indent: 2 },
  { key: 'total_ncl', label: 'Total Non-Current Liabilities', kind: 'subtotal', fn: totalNonCurrentLiab, indent: 1 },

  { key: 'CL_HEAD', label: 'Current Liabilities', kind: 'header', indent: 1 },
  { key: 'stb', label: 'Short-Term Borrowings', kind: 'line', fn: shortTermBorrowings, indent: 2 },
  { key: 'payables_msme', label: 'Trade Payables — Micro & Small Enterprises', kind: 'line', fn: tradePayablesMsme, indent: 2 },
  { key: 'payables_other', label: 'Trade Payables — Other than Micro & Small Enterprises', kind: 'line', fn: tradePayablesOther, indent: 2 },
  { key: 'statutory_dues', label: 'Statutory Dues Payable', kind: 'line', fn: dutiesTaxesPayable, indent: 2 },
  { key: 'employee_dues', label: 'Employee Benefits Payable', kind: 'line', fn: employeeDues, indent: 2 },
  { key: 'adv_customers', label: 'Advances from Customers', kind: 'line', fn: advancesFromCustomers, indent: 2 },
  { key: 'ocl', label: 'Other Current Liabilities', kind: 'line', fn: otherCurrentLiabilities, indent: 2 },
  { key: 'provisions', label: 'Short-Term Provisions', kind: 'line', fn: shortTermProvisions, indent: 2 },
  { key: 'unclassified_cr', label: 'Unclassified — credit balances (REVIEW)', kind: 'line', fn: unclassifiedCr, indent: 2 },
  { key: 'total_cl', label: 'Total Current Liabilities', kind: 'subtotal', fn: totalCurrentLiab, indent: 1 },

  { key: 'total_el', label: 'TOTAL EQUITY & LIABILITIES', kind: 'total', fn: totalEquityLiabilities, indent: 0 },

  { key: 'A_HEAD', label: 'ASSETS', kind: 'header' },
  { key: 'NCA_HEAD', label: 'Non-Current Assets', kind: 'header', indent: 1 },
  { key: 'ppe', label: 'Property, Plant and Equipment', kind: 'line', fn: netFixedAssets, indent: 2 },
  { key: 'intangibles', label: 'Intangible Assets', kind: 'line', fn: intangibleAssets, indent: 2 },
  { key: 'cwip', label: 'Capital Work-in-Progress', kind: 'line', fn: cwipTotal, indent: 2 },
  { key: 'intangibles_dev', label: 'Intangible Assets under Development', kind: 'line', fn: intangiblesUnderDevelopment, indent: 2 },
  { key: 'nci', label: 'Non-Current Investments', kind: 'line', fn: nonCurrentInvestments, indent: 2 },
  { key: 'dta', label: 'Deferred Tax Assets (Net)', kind: 'line', fn: deferredTaxAsset, indent: 2 },
  { key: 'ltla', label: 'Long-Term Loans & Advances', kind: 'line', fn: longTermLoansAdvances, indent: 2 },
  { key: 'onca', label: 'Other Non-Current Assets', kind: 'line', fn: otherNonCurrentAssets, indent: 2 },
  { key: 'total_nca', label: 'Total Non-Current Assets', kind: 'subtotal', fn: totalNonCurrentAssets, indent: 1 },

  { key: 'CA_HEAD', label: 'Current Assets', kind: 'header', indent: 1 },
  { key: 'cinv', label: 'Current Investments', kind: 'line', fn: currentInvestments, indent: 2 },
  { key: 'inventories', label: 'Inventories', kind: 'line', fn: closingStock, indent: 2 },
  { key: 'receivables', label: 'Trade Receivables', kind: 'line', fn: tradeReceivables, indent: 2 },
  { key: 'cash', label: 'Cash & Cash Equivalents', kind: 'line', fn: cashAndBank, indent: 2 },
  { key: 'stla', label: 'Short-Term Loans & Advances', kind: 'line', fn: shortTermLoansAdvances, indent: 2 },
  { key: 'oca', label: 'Other Current Assets', kind: 'line', fn: otherCurrentAssets, indent: 2 },
  { key: 'unclassified_dr', label: 'Unclassified — debit balances (REVIEW)', kind: 'line', fn: unclassifiedDr, indent: 2 },
  { key: 'total_ca', label: 'Total Current Assets', kind: 'subtotal', fn: totalCurrentAssets, indent: 1 },

  { key: 'total_assets', label: 'TOTAL ASSETS', kind: 'total', fn: totalAssets, indent: 0 },
];

/** Face line key -> the Schedule III line id whose ledgers back it. */
export const FACE_LINE_TO_ID: Record<string, string> = {
  share_capital: 'share_capital', reserves: 'reserves_surplus', share_application: 'share_application',
  ltb: 'lt_borrowings', dtl: 'dtl', oltl: 'other_lt_liab', ltp: 'lt_provisions',
  stb: 'st_borrowings', payables_msme: 'trade_payables_msme', payables_other: 'trade_payables_other',
  statutory_dues: 'duties_taxes_payable', employee_dues: 'employee_dues',
  adv_customers: 'advances_from_customers', ocl: 'other_current_liab', provisions: 'st_provisions',
  unclassified_cr: 'unclassified_cr',
  ppe: 'ppe', intangibles: 'intangibles', cwip: 'cwip', intangibles_dev: 'intangibles_dev',
  nci: 'nc_investments', dta: 'dta', ltla: 'lt_loans_advances', onca: 'other_nc_assets',
  cinv: 'c_investments', inventories: 'inventories', receivables: 'trade_receivables',
  cash: 'cash_bank', stla: 'st_loans_advances', oca: 'other_current_assets',
  unclassified_dr: 'unclassified_dr',
};

export const PNL_LINE_DEFS: BsLineDef[] = [
  { key: 'rev', label: 'Revenue from Operations', kind: 'line', fn: revenueFromOps, indent: 1 },
  { key: 'oi', label: 'Other Income', kind: 'line', fn: otherIncome, indent: 1 },
  { key: 'total_rev', label: 'Total Revenue', kind: 'subtotal', fn: totalRevenue, indent: 0 },
  { key: 'EXP_HEAD', label: 'Expenses', kind: 'header' },
  { key: 'purch', label: 'Cost of Materials / Purchases', kind: 'line', fn: purchases, indent: 2 },
  { key: 'chg', label: 'Changes in Inventories', kind: 'line', fn: changesInInventories, indent: 2 },
  { key: 'emp', label: 'Employee Benefits Expense', kind: 'line', fn: employeeCosts, indent: 2 },
  { key: 'fin', label: 'Finance Costs', kind: 'line', fn: financeCosts, indent: 2 },
  { key: 'dep', label: 'Depreciation & Amortisation', kind: 'line', fn: depreciation, indent: 2 },
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
