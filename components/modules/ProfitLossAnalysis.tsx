import React, { useEffect, useMemo, useState } from 'react';
import { useTallyStore } from '../../services/tally';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  Layers,
  RefreshCcw,
  Sparkles,
} from 'lucide-react';
import { LedgerEntry } from '../../types';
import { isSqlBackendAvailable } from '../../services/sqlDataService';
import { fetchSqlAnalyticsMonths, fetchSqlPnlAnalytics, SqlPnlPrimaryBucket } from '../../services/sqlAnalyticsService';

type HeadId =
  | 'REVENUE'
  | 'OTHER_INCOME'
  | 'PURCHASES'
  | 'DIRECT_EXPENSES'
  | 'INDIRECT_EXPENSES'
  | 'EXCLUDED_BALANCE_SHEET';

type HeadConfig = {
  id: HeadId;
  label: string;
  description: string;
  statementLabel: string;
  badgeClass: string;
};

type ParentBreakup = {
  parent: string;
  total: number;
  ledgers: Array<{ ledger: string; total: number; entries: number }>;
};

type PrimaryBucket = {
  primary: string;
  total: number;
  entries: LedgerEntry[];
  parentSet: Set<string>;
  parentBreakup?: ParentBreakup[];
  revenueFlagCount: number;
  explicitPnlCount: number;
  explicitBsCount: number;
  likelyBalanceSheet: boolean;
  hasStockOrInventoryWord: boolean;
  autoHead: HeadId;
};

type NoteItem = {
  ref: string;
  headId: HeadId;
  headLabel: string;
  primary: string;
  total: number;
  sheetName: string;
  parentBreakup: ParentBreakup[];
};

const HEADS: HeadConfig[] = [
  {
    id: 'REVENUE',
    label: 'Revenue',
    description: 'Sales and operating revenue primaries',
    statementLabel: 'Revenue from operations',
    badgeClass: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  },
  {
    id: 'OTHER_INCOME',
    label: 'Other Income',
    description: 'Direct/indirect income and non-core income',
    statementLabel: 'Other income',
    badgeClass: 'bg-cyan-100 text-cyan-700 border border-cyan-200',
  },
  {
    id: 'PURCHASES',
    label: 'Purchases',
    description: 'Purchase-related primaries',
    statementLabel: 'Purchases',
    badgeClass: 'bg-amber-100 text-amber-700 border border-amber-200',
  },
  {
    id: 'DIRECT_EXPENSES',
    label: 'Direct Expenses',
    description: 'Direct cost primaries',
    statementLabel: 'Direct expenses',
    badgeClass: 'bg-orange-100 text-orange-700 border border-orange-200',
  },
  {
    id: 'INDIRECT_EXPENSES',
    label: 'Indirect Expenses',
    description: 'Indirect/administrative expense primaries',
    statementLabel: 'Indirect expenses',
    badgeClass: 'bg-rose-100 text-rose-700 border border-rose-200',
  },
  {
    id: 'EXCLUDED_BALANCE_SHEET',
    label: 'Balance Sheet / Excluded',
    description: 'Primaries excluded from P&L statement',
    statementLabel: 'Excluded',
    badgeClass: 'bg-slate-100 text-slate-700 border border-slate-200',
  },
];

const ACTIVE_HEADS = HEADS.filter((head) => head.id !== 'EXCLUDED_BALANCE_SHEET');
const ALLOCATION_STORAGE_KEY = 'finanalyzer_pnl_head_allocations_v3';

const BORDER_THIN = {
  top: { style: 'thin', color: { rgb: 'CBD5E1' } },
  right: { style: 'thin', color: { rgb: 'CBD5E1' } },
  bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
  left: { style: 'thin', color: { rgb: 'CBD5E1' } },
};

const toDisplayDate = (value: string) => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const matchIso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (matchIso) return `${matchIso[3]}/${matchIso[2]}/${matchIso[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const monthKeyFromDate = (value: string) => {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.slice(5, 7)}/${value.slice(0, 4)}`;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return `${value.slice(3, 5)}/${value.slice(6, 10)}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const monthSortValue = (monthKey: string) => {
  const [mm, yyyy] = monthKey.split('/').map(Number);
  if (!mm || !yyyy) return 0;
  return yyyy * 100 + mm;
};

const monthLabel = (monthKey: string) => {
  const [mm, yyyy] = monthKey.split('/').map(Number);
  if (!mm || !yyyy) return monthKey;
  const d = new Date(yyyy, mm - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
};

const formatMoney = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPercent = (value: number) => `${value.toFixed(2)}%`;

const parseFlexibleBoolean = (value: unknown): boolean | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (['1', 'true', 'yes', 'y'].includes(text)) return true;
  if (['0', 'false', 'no', 'n'].includes(text)) return false;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric > 0;
  return null;
};

const readRowBoolean = (row: LedgerEntry, keys: string[]): boolean | null => {
  for (const key of keys) {
    const result = parseFlexibleBoolean((row as any)?.[key]);
    if (result !== null) return result;
  }
  return null;
};

const containsAny = (text: string, words: string[]) => words.some((word) => text.includes(word));

const PNL_TRUE_KEYS = [
  'is_pnl',
  'is_profit_and_loss',
  'is_profit_loss',
  'is_revenue_expense',
  'is_revenue',
  'is_pl',
];
const BS_TRUE_KEYS = ['is_balance_sheet', 'is_bs', 'is_balancesheet', 'is_balance'];

const PNL_HINT_WORDS = [
  'sale',
  'sales',
  'revenue',
  'turnover',
  'income',
  'purchase',
  'expense',
  'expenditure',
  'consumption',
  'cost',
];
const BS_HINT_WORDS = [
  'sundry debtor',
  'sundry creditor',
  'debtor',
  'creditor',
  'bank account',
  'cash-in-hand',
  'cash in hand',
  'capital account',
  'capital',
  'fixed asset',
  'current asset',
  'current liabilities',
  'secured loan',
  'unsecured loan',
  'loan and advances',
  'duties & taxes',
  'duties and taxes',
  'provisions',
  'reserves',
  'branch/divisions',
  'branch divisions',
];

const isStockOrInventoryGroup = (text: string) => text.includes('stock') || text.includes('inventory');

// Hint sourced from mst_group when a ZIP-imported store is available. When
// provided, this takes precedence over the text-keyword heuristics below —
// the flags are Tally's authoritative classification of a group as P&L vs
// BS, direct vs indirect, income vs expense. Without it inferAutoHead
// behaves exactly as before.
interface StoreGroupHint {
  isRevenue: boolean;            // mst_group.is_revenue (P&L group)
  affectsGrossProfit: boolean;   // mst_group.affects_gross_profit (above-the-line)
  isDeemedPositive: boolean;     // mst_group.is_deemedpositive (expense side)
}

const inferAutoHead = (bucket: PrimaryBucket, hint?: StoreGroupHint): HeadId => {
  const primary = bucket.primary.toLowerCase();
  const parentText = Array.from(bucket.parentSet).join(' ').toLowerCase();
  const combinedText = `${primary} ${parentText}`;
  const hasIncomeWord = combinedText.includes('income');
  const hasSalesWord = containsAny(combinedText, ['sale', 'sales', 'revenue', 'turnover']);
  const hasPurchaseWord = combinedText.includes('purchase');
  const hasDirectExpenseWord = containsAny(combinedText, ['direct expense', 'direct expenses']);
  const hasIndirectExpenseWord = containsAny(combinedText, ['indirect expense', 'indirect expenses']);
  const hasExpenseWord = containsAny(combinedText, ['expense', 'expenditure', 'consumption', 'cost']);
  const likelyPnlByText = containsAny(combinedText, PNL_HINT_WORDS);
  const likelyBsByText = containsAny(combinedText, BS_HINT_WORDS);

  if (bucket.hasStockOrInventoryWord) return 'EXCLUDED_BALANCE_SHEET';
  if (bucket.explicitBsCount > 0 && bucket.explicitPnlCount === 0) return 'EXCLUDED_BALANCE_SHEET';

  // Store-driven classification (when hint present, mst_group flags are
  // authoritative — Tally itself tells us whether the group sits in P&L
  // or BS and which side of the gross-profit line it's on).
  if (hint) {
    if (!hint.isRevenue) return 'EXCLUDED_BALANCE_SHEET';
    // is_revenue = true → P&L. Discriminate by sign + above-the-line flag.
    if (hint.isDeemedPositive) {
      // Expense side
      if (hasPurchaseWord) return 'PURCHASES';
      return hint.affectsGrossProfit ? 'DIRECT_EXPENSES' : 'INDIRECT_EXPENSES';
    }
    // Income side
    if (hasSalesWord || hint.affectsGrossProfit) return 'REVENUE';
    return 'OTHER_INCOME';
  }

  if (hasSalesWord) return 'REVENUE';
  if (hasIncomeWord) return 'OTHER_INCOME';
  if (hasPurchaseWord) return 'PURCHASES';
  if (hasDirectExpenseWord) return 'DIRECT_EXPENSES';
  if (hasIndirectExpenseWord) return 'INDIRECT_EXPENSES';
  if (hasExpenseWord) return 'INDIRECT_EXPENSES';
  if (bucket.revenueFlagCount > 0) return 'REVENUE';
  if (bucket.explicitPnlCount > 0 || likelyPnlByText) return 'INDIRECT_EXPENSES';
  if (bucket.likelyBalanceSheet || likelyBsByText) return 'EXCLUDED_BALANCE_SHEET';
  return 'INDIRECT_EXPENSES';
};

const buildParentBreakup = (entries: LedgerEntry[]): ParentBreakup[] => {
  const parentMap = new Map<string, Map<string, { total: number; entries: number }>>();
  entries.forEach((entry) => {
    const parent = String(entry.TallyParent || entry.Group || 'Unspecified Parent').trim() || 'Unspecified Parent';
    const ledger = String(entry.Ledger || 'Unknown Ledger').trim() || 'Unknown Ledger';
    if (!parentMap.has(parent)) parentMap.set(parent, new Map());
    const ledgerMap = parentMap.get(parent)!;
    if (!ledgerMap.has(ledger)) ledgerMap.set(ledger, { total: 0, entries: 0 });
    const node = ledgerMap.get(ledger)!;
    node.total += Number(entry.amount || 0);
    node.entries += 1;
  });

  return Array.from(parentMap.entries())
    .map(([parent, ledgerMap]) => {
      const ledgers = Array.from(ledgerMap.entries())
        .map(([ledger, value]) => ({ ledger, total: value.total, entries: value.entries }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      return {
        parent,
        total: ledgers.reduce((sum, ledger) => sum + ledger.total, 0),
        ledgers,
      };
    })
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
};

const sanitizeSheetName = (raw: string) => raw.replace(/[\\/*?:[\]]/g, '').trim();

const mapSqlBucketToPrimaryBucket = (bucket: SqlPnlPrimaryBucket): PrimaryBucket => {
  const parentSet = new Set<string>(Array.isArray(bucket.parentNames) ? bucket.parentNames : []);
  const normalized: PrimaryBucket = {
    primary: String(bucket.primary || 'Unspecified Primary'),
    total: Number(bucket.total || 0),
    entries: [],
    parentSet,
    parentBreakup: Array.isArray(bucket.parentBreakup) ? bucket.parentBreakup : [],
    revenueFlagCount: Number(bucket.revenueFlagCount || 0),
    explicitPnlCount: Number(bucket.explicitPnlCount || 0),
    explicitBsCount: Number(bucket.explicitBsCount || 0),
    likelyBalanceSheet: !!bucket.likelyBalanceSheet,
    hasStockOrInventoryWord: !!bucket.hasStockOrInventoryWord,
    autoHead: 'INDIRECT_EXPENSES',
  };
  normalized.autoHead = inferAutoHead(normalized);
  return normalized;
};

const ProfitLossAnalysis: React.FC<{ data: LedgerEntry[] }> = ({ data }) => {
  const store = useTallyStore();
  // Pre-build a primary-group → mst_group flags lookup once per store load.
  // Keyed by lowercased primary name so spelling/whitespace mismatches
  // between the bucket name and mst_group.name don't drop the hint.
  const storeHintByPrimary = useMemo(() => {
    const map = new Map<string, StoreGroupHint>();
    if (!store) return map;
    for (const g of store.groups.values()) {
      // mst_group.primary_group is the top-level Tally primary this group
      // rolls up into; using it as the key means children inherit their
      // primary's flags.
      const primaryName = g.primary_group || g.name;
      if (!primaryName || map.has(primaryName.toLowerCase())) continue;
      // Look up the primary's own row when this row is a sub-group so we
      // use the *primary's* flags (children may override; we want the head
      // classification).
      const primaryGroup = store.group(primaryName) || g;
      map.set(primaryName.toLowerCase(), {
        isRevenue: primaryGroup.is_revenue,
        affectsGrossProfit: primaryGroup.affects_gross_profit,
        isDeemedPositive: primaryGroup.is_deemedpositive,
      });
    }
    return map;
  }, [store]);
  const [groupSearch, setGroupSearch] = useState('');
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [openingStockSourceLedger, setOpeningStockSourceLedger] = useState('__AUTO__');
  const [closingStockSourceLedger, setClosingStockSourceLedger] = useState('__AUTO__');
  const [openingStock, setOpeningStock] = useState(0);
  const [closingStock, setClosingStock] = useState(0);
  const [expandedHeads, setExpandedHeads] = useState<Record<string, boolean>>({
    REVENUE: true,
    OTHER_INCOME: true,
    PURCHASES: true,
    DIRECT_EXPENSES: true,
    INDIRECT_EXPENSES: true,
  });
  const [expandedPrimaries, setExpandedPrimaries] = useState<Record<string, boolean>>({});
  const [allocations, setAllocations] = useState<Record<string, HeadId>>(() => {
    try {
      const raw = localStorage.getItem(ALLOCATION_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch {
      return {};
    }
  });
  const [sqlAvailable, setSqlAvailable] = useState(false);
  const [sqlMonths, setSqlMonths] = useState<string[]>([]);
  const [sqlPrimaryBuckets, setSqlPrimaryBuckets] = useState<PrimaryBucket[]>([]);
  const [sqlStockLedgerTotals, setSqlStockLedgerTotals] = useState<Array<{ ledger: string; amount: number }>>([]);
  const [sqlDefaultOpeningStock, setSqlDefaultOpeningStock] = useState(0);
  const [sqlDefaultClosingStock, setSqlDefaultClosingStock] = useState(0);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState('');
  const useSqlAnalytics = data.length === 0;

  const accountingRows = useMemo(() => {
    return data.filter((row) => {
      const raw = row?.is_accounting_voucher;
      if (raw === undefined || raw === null || String(raw).trim() === '') return true;
      const text = String(raw).trim().toLowerCase();
      if (['1', 'true', 'yes', 'y'].includes(text)) return true;
      if (['0', 'false', 'no', 'n'].includes(text)) return false;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed > 0 : false;
    });
  }, [data]);

  const inMemoryMonths = useMemo(() => {
    const keys: string[] = [];
    for (const row of accountingRows) {
      const k = monthKeyFromDate(String(row.date || ''));
      if (k) keys.push(k);
    }
    return Array.from(new Set(keys)).sort((a, b) => monthSortValue(a) - monthSortValue(b));
  }, [accountingRows]);

  useEffect(() => {
    let cancelled = false;

    const loadSqlMonths = async () => {
      if (!useSqlAnalytics) {
        setSqlAvailable(false);
        setSqlMonths([]);
        setSqlError('');
        return;
      }

      setSqlLoading(true);
      setSqlError('');
      try {
        const available = await isSqlBackendAvailable();
        if (cancelled) return;
        setSqlAvailable(available);
        if (!available) {
          setSqlLoading(false);
          return;
        }
        const months = await fetchSqlAnalyticsMonths();
        if (cancelled) return;
        setSqlMonths(months.sort((a, b) => monthSortValue(a) - monthSortValue(b)));
      } catch (error: any) {
        if (cancelled) return;
        setSqlError(error?.message || 'Unable to load SQL P&L months.');
      } finally {
        if (!cancelled) setSqlLoading(false);
      }
    };

    loadSqlMonths();
    return () => {
      cancelled = true;
    };
  }, [useSqlAnalytics]);

  const allMonths = useMemo(() => {
    return useSqlAnalytics ? sqlMonths : inMemoryMonths;
  }, [useSqlAnalytics, sqlMonths, inMemoryMonths]);

  useEffect(() => {
    setSelectedMonths((previous) => {
      if (allMonths.length === 0) return [];
      if (!previous.length) return [...allMonths];
      const next = previous.filter((month) => allMonths.includes(month));
      return next.length ? next : [...allMonths];
    });
  }, [allMonths.join('|')]);

  const selectedMonthSet = useMemo(() => new Set(selectedMonths), [selectedMonths]);

  const periodRows = useMemo(() => {
    if (useSqlAnalytics) return [];
    if (!selectedMonths.length) return accountingRows;
    return accountingRows.filter((row) => selectedMonthSet.has(monthKeyFromDate(row.date)));
  }, [useSqlAnalytics, accountingRows, selectedMonths.join('|'), selectedMonthSet]);

  useEffect(() => {
    let cancelled = false;

    const loadSqlPnl = async () => {
      if (!useSqlAnalytics || !sqlAvailable) {
        setSqlPrimaryBuckets([]);
        setSqlStockLedgerTotals([]);
        setSqlDefaultOpeningStock(0);
        setSqlDefaultClosingStock(0);
        return;
      }
      if (allMonths.length === 0) {
        setSqlPrimaryBuckets([]);
        setSqlStockLedgerTotals([]);
        setSqlDefaultOpeningStock(0);
        setSqlDefaultClosingStock(0);
        return;
      }

      setSqlLoading(true);
      setSqlError('');
      try {
        const monthsForQuery = selectedMonths.length ? selectedMonths : allMonths;
        const payload = await fetchSqlPnlAnalytics(monthsForQuery);
        if (cancelled) return;
        setSqlPrimaryBuckets((payload.primaryBuckets || []).map(mapSqlBucketToPrimaryBucket));
        setSqlStockLedgerTotals(
          (payload.stockLedgerTotals || []).map((row) => ({
            ledger: String(row?.ledger || 'Unknown Ledger'),
            amount: Number(row?.amount || 0),
          }))
        );
        setSqlDefaultOpeningStock(Number(payload.defaultOpeningStock || 0));
        setSqlDefaultClosingStock(Number(payload.defaultClosingStock || 0));
      } catch (error: any) {
        if (cancelled) return;
        setSqlError(error?.message || 'Unable to load SQL P&L analytics.');
      } finally {
        if (!cancelled) setSqlLoading(false);
      }
    };

    loadSqlPnl();
    return () => {
      cancelled = true;
    };
  }, [useSqlAnalytics, sqlAvailable, allMonths.join('|'), selectedMonths.join('|')]);

  const stockLedgerTotals = useMemo(() => {
    if (useSqlAnalytics) return sqlStockLedgerTotals;
    const map = new Map<string, number>();
    periodRows.forEach((row) => {
      const primary = String(row.TallyPrimary || '').toLowerCase();
      const parent = String(row.TallyParent || row.Group || '').toLowerCase();
      const ledger = String(row.Ledger || '').trim();
      const combined = `${primary} ${parent} ${ledger.toLowerCase()}`;
      if (!isStockOrInventoryGroup(combined)) return;
      const key = ledger || 'Unknown Ledger';
      map.set(key, (map.get(key) || 0) + Number(row.amount || 0));
    });
    return Array.from(map.entries())
      .map(([ledger, amount]) => ({ ledger, amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }, [useSqlAnalytics, sqlStockLedgerTotals, periodRows]);

  const defaultOpeningStock = useMemo(() => {
    if (useSqlAnalytics) return sqlDefaultOpeningStock;
    const total = periodRows.reduce((sum, row) => {
      const text = `${row.TallyPrimary || ''} ${row.TallyParent || ''} ${row.Ledger || ''}`.toLowerCase();
      if (!text.includes('opening stock')) return sum;
      return sum + Number(row.amount || 0);
    }, 0);
    if (total !== 0) return total;
    return stockLedgerTotals[0]?.amount || 0;
  }, [useSqlAnalytics, sqlDefaultOpeningStock, periodRows, stockLedgerTotals]);

  const defaultClosingStock = useMemo(() => {
    if (useSqlAnalytics) return sqlDefaultClosingStock;
    const total = periodRows.reduce((sum, row) => {
      const text = `${row.TallyPrimary || ''} ${row.TallyParent || ''} ${row.Ledger || ''}`.toLowerCase();
      if (!text.includes('closing stock')) return sum;
      return sum + Number(row.amount || 0);
    }, 0);
    if (total !== 0) return total;
    return stockLedgerTotals[1]?.amount || stockLedgerTotals[0]?.amount || 0;
  }, [useSqlAnalytics, sqlDefaultClosingStock, periodRows, stockLedgerTotals]);

  const stockSourceSignature = useMemo(() => {
    return `${defaultOpeningStock}|${defaultClosingStock}|${stockLedgerTotals
      .map((item) => `${item.ledger}:${item.amount}`)
      .join(';')}`;
  }, [defaultOpeningStock, defaultClosingStock, stockLedgerTotals]);

  useEffect(() => {
    setOpeningStockSourceLedger('__AUTO__');
    setClosingStockSourceLedger('__AUTO__');
    setOpeningStock(defaultOpeningStock);
    setClosingStock(defaultClosingStock);
  }, [stockSourceSignature]);

  const inMemoryPrimaryBuckets = useMemo(() => {
    if (useSqlAnalytics) return [] as PrimaryBucket[];
    const map = new Map<string, PrimaryBucket>();
    periodRows.forEach((row) => {
      const primary = String(row.TallyPrimary || 'Unspecified Primary').trim() || 'Unspecified Primary';
      if (!map.has(primary)) {
        map.set(primary, {
          primary,
          total: 0,
          entries: [],
          parentSet: new Set<string>(),
          revenueFlagCount: 0,
          explicitPnlCount: 0,
          explicitBsCount: 0,
          likelyBalanceSheet: false,
          hasStockOrInventoryWord: false,
          autoHead: 'INDIRECT_EXPENSES',
        });
      }
      const bucket = map.get(primary)!;
      bucket.total += Number(row.amount || 0);
      bucket.entries.push(row);
      bucket.parentSet.add(String(row.TallyParent || row.Group || 'Unspecified Parent').trim() || 'Unspecified Parent');

      const isRevenue = parseFlexibleBoolean((row as any).is_revenue);
      if (isRevenue) bucket.revenueFlagCount += 1;

      const explicitPnl = readRowBoolean(row, PNL_TRUE_KEYS);
      const explicitBs = readRowBoolean(row, BS_TRUE_KEYS);
      if (explicitPnl) bucket.explicitPnlCount += 1;
      if (explicitBs) bucket.explicitBsCount += 1;

      const text = `${primary} ${row.TallyParent || ''}`.toLowerCase();
      if (isStockOrInventoryGroup(text)) bucket.hasStockOrInventoryWord = true;
      if (containsAny(text, BS_HINT_WORDS) && !containsAny(text, PNL_HINT_WORDS)) bucket.likelyBalanceSheet = true;
    });

    const buckets = Array.from(map.values()).map((bucket) => ({
      ...bucket,
      autoHead: inferAutoHead(bucket, storeHintByPrimary.get(bucket.primary.toLowerCase())),
    }));

    return buckets.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [useSqlAnalytics, periodRows, storeHintByPrimary]);

  const primaryBuckets = useMemo(() => {
    return useSqlAnalytics ? sqlPrimaryBuckets : inMemoryPrimaryBuckets;
  }, [useSqlAnalytics, sqlPrimaryBuckets, inMemoryPrimaryBuckets]);

  const activePrimaryBuckets = useMemo(
    () => primaryBuckets.filter((bucket) => !bucket.hasStockOrInventoryWord),
    [primaryBuckets]
  );

  const allocationSignature = useMemo(
    () => activePrimaryBuckets.map((bucket) => `${bucket.primary}:${bucket.autoHead}`).join('|'),
    [activePrimaryBuckets]
  );

  useEffect(() => {
    setAllocations((previous) => {
      const next: Record<string, HeadId> = {};
      activePrimaryBuckets.forEach((bucket) => {
        next[bucket.primary] = previous[bucket.primary] || bucket.autoHead;
      });
      if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
      return next;
    });
  }, [allocationSignature]);

  useEffect(() => {
    localStorage.setItem(ALLOCATION_STORAGE_KEY, JSON.stringify(allocations));
  }, [allocations]);

  const groupedByHead = useMemo(() => {
    const result: Record<HeadId, PrimaryBucket[]> = {
      REVENUE: [],
      OTHER_INCOME: [],
      PURCHASES: [],
      DIRECT_EXPENSES: [],
      INDIRECT_EXPENSES: [],
      EXCLUDED_BALANCE_SHEET: [],
    };

    activePrimaryBuckets.forEach((bucket) => {
      const head = allocations[bucket.primary];
      if (head) result[head].push(bucket);
    });

    (Object.keys(result) as HeadId[]).forEach((head) => {
      result[head].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    });

    return result;
  }, [activePrimaryBuckets, allocations]);

  const unassignedGroups = useMemo(
    () => activePrimaryBuckets.filter((bucket) => !allocations[bucket.primary]),
    [activePrimaryBuckets, allocations]
  );

  const totalsByHead = useMemo(() => {
    const totals: Record<HeadId, number> = {
      REVENUE: 0,
      OTHER_INCOME: 0,
      PURCHASES: 0,
      DIRECT_EXPENSES: 0,
      INDIRECT_EXPENSES: 0,
      EXCLUDED_BALANCE_SHEET: 0,
    };
    (Object.keys(groupedByHead) as HeadId[]).forEach((head) => {
      totals[head] = groupedByHead[head].reduce((sum, row) => sum + row.total, 0);
    });
    return totals;
  }, [groupedByHead]);

  const openingStockSigned = -Math.abs(Number(openingStock || 0));
  const closingStockSigned = Math.abs(Number(closingStock || 0));
  const totalIncome = totalsByHead.REVENUE + totalsByHead.OTHER_INCOME;
  const totalExpensesBeforeStockSigned =
    totalsByHead.PURCHASES + totalsByHead.DIRECT_EXPENSES + totalsByHead.INDIRECT_EXPENSES;
  const totalExpenses = totalExpensesBeforeStockSigned + openingStockSigned + closingStockSigned;
  const netProfit = totalIncome + totalExpenses;
  const netMargin = totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0;
  const revenueFromOperations = totalsByHead.REVENUE;
  const otherIncome = totalsByHead.OTHER_INCOME;
  const coreDirectCost =
    totalsByHead.PURCHASES + totalsByHead.DIRECT_EXPENSES + openingStockSigned + closingStockSigned;
  const grossProfit = revenueFromOperations + coreDirectCost;
  const operatingProfit = grossProfit + totalsByHead.INDIRECT_EXPENSES;
  const revenueBase = Math.abs(revenueFromOperations);
  const incomeBase = Math.abs(totalIncome);
  const grossProfitRatio = revenueBase > 0 ? (grossProfit / revenueBase) * 100 : 0;
  const operatingProfitRatio = revenueBase > 0 ? (operatingProfit / revenueBase) * 100 : 0;
  const netProfitRatio = revenueBase > 0 ? (netProfit / revenueBase) * 100 : 0;
  const directCostRatio = revenueBase > 0 ? (Math.abs(coreDirectCost) / revenueBase) * 100 : 0;
  const indirectExpenseRatio = revenueBase > 0 ? (Math.abs(totalsByHead.INDIRECT_EXPENSES) / revenueBase) * 100 : 0;
  const expenseToIncomeRatio = incomeBase > 0 ? (Math.abs(totalExpenses) / incomeBase) * 100 : 0;

  const pnlAnalyticsCards = [
    { label: 'Gross Profit / (Loss)', kind: 'amount' as const, value: grossProfit },
    { label: 'Operating Profit / (Loss)', kind: 'amount' as const, value: operatingProfit },
    { label: 'Net Profit Ratio (on Revenue)', kind: 'percent' as const, value: netProfitRatio },
    { label: 'Gross Profit Ratio', kind: 'percent' as const, value: grossProfitRatio },
    { label: 'Operating Profit Ratio', kind: 'percent' as const, value: operatingProfitRatio },
    { label: 'Direct Cost Ratio', kind: 'percent' as const, value: directCostRatio },
    { label: 'Indirect Expense Ratio', kind: 'percent' as const, value: indirectExpenseRatio },
    { label: 'Expense to Income Ratio', kind: 'percent' as const, value: expenseToIncomeRatio },
  ];

  const noteItems = useMemo(() => {
    const notes: NoteItem[] = [];
    const usedSheetNames = new Set<string>();

    ACTIVE_HEADS.forEach((head, headIndex) => {
      const headBuckets = groupedByHead[head.id];
      headBuckets.forEach((bucket, index) => {
        const noteRef = `N${headIndex + 1}.${String(index + 1).padStart(2, '0')}`;
        const cleanName = sanitizeSheetName(`${noteRef}_${bucket.primary}`).slice(0, 31);
        let sheetName = cleanName || `${noteRef}_Note`;
        let i = 1;
        while (usedSheetNames.has(sheetName)) {
          const suffix = `_${i}`;
          sheetName = `${cleanName.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
          i += 1;
        }
        usedSheetNames.add(sheetName);
        notes.push({
          ref: noteRef,
          headId: head.id,
          headLabel: head.label,
          primary: bucket.primary,
          total: bucket.total,
          sheetName,
          parentBreakup: bucket.parentBreakup || buildParentBreakup(bucket.entries),
        });
      });
    });

    return notes;
  }, [groupedByHead]);

  const noteRefByPrimary = useMemo(() => {
    const map = new Map<string, NoteItem>();
    noteItems.forEach((note) => map.set(`${note.headId}::${note.primary}`, note));
    return map;
  }, [noteItems]);

  const periodLabel = useMemo(() => {
    if (!selectedMonths.length || selectedMonths.length === allMonths.length) return 'All selected months';
    const labels = selectedMonths
      .slice()
      .sort((a, b) => monthSortValue(a) - monthSortValue(b))
      .map(monthLabel);
    return labels.join(', ');
  }, [selectedMonths, allMonths]);

  const resetAllocationsToAuto = () => {
    const next: Record<string, HeadId> = {};
    activePrimaryBuckets.forEach((bucket) => {
      next[bucket.primary] = bucket.autoHead;
    });
    setAllocations(next);
  };

  const toggleMonth = (month: string) => {
    setSelectedMonths((previous) =>
      previous.includes(month) ? previous.filter((m) => m !== month) : [...previous, month]
    );
  };

  const selectAllMonths = () => setSelectedMonths([...allMonths]);
  const clearMonthSelection = () => setSelectedMonths([]);

  const updateAllocation = (primary: string, head: HeadId, checked: boolean) => {
    setAllocations((previous) => {
      const next = { ...previous };
      if (checked) next[primary] = head;
      else delete next[primary];
      return next;
    });
  };

  const availableForHead = (head: HeadId) => {
    const q = groupSearch.trim().toLowerCase();
    return activePrimaryBuckets.filter((bucket) => {
      const current = allocations[bucket.primary];
      if (current && current !== head) return false;
      if (!q) return true;
      const parentText = Array.from(bucket.parentSet).join(' ').toLowerCase();
      return bucket.primary.toLowerCase().includes(q) || parentText.includes(q);
    });
  };

  const onOpeningSourceChange = (value: string) => {
    setOpeningStockSourceLedger(value);
    if (value === '__AUTO__') {
      setOpeningStock(defaultOpeningStock);
      return;
    }
    const selected = stockLedgerTotals.find((item) => item.ledger === value);
    setOpeningStock(selected?.amount || 0);
  };

  const onClosingSourceChange = (value: string) => {
    setClosingStockSourceLedger(value);
    if (value === '__AUTO__') {
      setClosingStock(defaultClosingStock);
      return;
    }
    const selected = stockLedgerTotals.find((item) => item.ledger === value);
    setClosingStock(selected?.amount || 0);
  };

  const exportExcel = async () => {
    try {
      const XLSX = await import('xlsx-js-style');
      const workbook = XLSX.utils.book_new();

      const statementRows: any[][] = [];
      const rowTypeByIndex = new Map<number, string>();
      const noteLinks: Array<{ row: number; col: number; target: string }> = [];

      const pushStatementRow = (cells: any[], type: string) => {
        statementRows.push(cells);
        rowTypeByIndex.set(statementRows.length - 1, type);
      };

      pushStatementRow(['Schedule III - Profit and Loss Statement', '', ''], 'title');
      pushStatementRow(
        [
          `Period: ${periodLabel}`,
          '',
          `Generated: ${toDisplayDate(new Date().toISOString().slice(0, 10))}`,
        ],
        'meta'
      );
      pushStatementRow([], 'blank');
      pushStatementRow(['Particulars', 'Note', 'Amount'], 'header');

      pushStatementRow(['I. Income', '', ''], 'sectionIncome');

      const writeHeadBlock = (head: HeadConfig) => {
        const headRows = groupedByHead[head.id];
        pushStatementRow([head.statementLabel, '', totalsByHead[head.id]], 'headTotal');
        headRows.forEach((bucket) => {
          const note = noteRefByPrimary.get(`${head.id}::${bucket.primary}`);
          const rowIndex = statementRows.length;
          pushStatementRow([`   ${bucket.primary}`, note?.ref || '', bucket.total], 'detail');
          if (note) {
            noteLinks.push({
              row: rowIndex,
              col: 1,
              target: `#'${note.sheetName}'!A1`,
            });
          }
        });
      };

      writeHeadBlock(HEADS.find((head) => head.id === 'REVENUE')!);
      writeHeadBlock(HEADS.find((head) => head.id === 'OTHER_INCOME')!);
      pushStatementRow(['Total Income', '', totalIncome], 'grandTotal');
      pushStatementRow([], 'blank');

      pushStatementRow(['II. Expenses', '', ''], 'sectionExpense');
      writeHeadBlock(HEADS.find((head) => head.id === 'PURCHASES')!);
      writeHeadBlock(HEADS.find((head) => head.id === 'DIRECT_EXPENSES')!);
      writeHeadBlock(HEADS.find((head) => head.id === 'INDIRECT_EXPENSES')!);
      pushStatementRow(['Opening Stock (Deemed Debit)', '', openingStockSigned], 'stockLine');
      pushStatementRow(['Closing Stock (Deemed Credit)', '', closingStockSigned], 'stockLine');
      pushStatementRow(['Total Expenses', '', totalExpenses], 'grandTotal');
      pushStatementRow([], 'blank');
      pushStatementRow([netProfit >= 0 ? 'Net Profit' : 'Net Loss', '', netProfit], 'net');

      const statementSheet = XLSX.utils.aoa_to_sheet(statementRows);
      statementSheet['!cols'] = [{ wch: 58 }, { wch: 14 }, { wch: 20 }];
      statementSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];

      const baseTextStyle = {
        font: { name: 'Calibri', sz: 11, color: { rgb: '0F172A' } },
        alignment: { vertical: 'center', horizontal: 'left' },
        border: BORDER_THIN,
      };
      const baseNumberStyle = {
        ...baseTextStyle,
        alignment: { vertical: 'center', horizontal: 'right' },
        numFmt: '#,##0.00',
      };

      const applyRowStyle = (row: number, fill: string, bold = false, color = '0F172A') => {
        [0, 1, 2].forEach((col) => {
          const ref = XLSX.utils.encode_cell({ r: row, c: col });
          if (!statementSheet[ref]) statementSheet[ref] = { t: 's', v: '' };
          const current = statementSheet[ref];
          const isNumber = col === 2 && typeof current.v === 'number';
          current.s = {
            ...(isNumber ? baseNumberStyle : baseTextStyle),
            font: { ...(isNumber ? baseNumberStyle.font : baseTextStyle.font), bold, color: { rgb: color } },
            fill: { fgColor: { rgb: fill } },
          };
        });
      };

      for (let r = 0; r < statementRows.length; r += 1) {
        const type = rowTypeByIndex.get(r) || 'detail';
        if (type === 'title') applyRowStyle(r, '0F172A', true, 'FFFFFF');
        else if (type === 'meta') applyRowStyle(r, 'E2E8F0', false, '334155');
        else if (type === 'header') applyRowStyle(r, 'CBD5E1', true);
        else if (type === 'sectionIncome') applyRowStyle(r, 'DCFCE7', true, '166534');
        else if (type === 'sectionExpense') applyRowStyle(r, 'FEE2E2', true, '991B1B');
        else if (type === 'headTotal') applyRowStyle(r, 'F8FAFC', true, '0F172A');
        else if (type === 'grandTotal') applyRowStyle(r, 'E2E8F0', true, '0F172A');
        else if (type === 'stockLine') applyRowStyle(r, 'FFF7ED', true, '9A3412');
        else if (type === 'net') applyRowStyle(r, netProfit >= 0 ? 'DCFCE7' : 'FEE2E2', true);
        else if (type === 'blank') {
          [0, 1, 2].forEach((col) => {
            const ref = XLSX.utils.encode_cell({ r, c: col });
            if (!statementSheet[ref]) statementSheet[ref] = { t: 's', v: '' };
            statementSheet[ref].s = {
              ...baseTextStyle,
              border: {
                top: { style: 'none' },
                right: { style: 'none' },
                bottom: { style: 'none' },
                left: { style: 'none' },
              },
            };
          });
        } else applyRowStyle(r, 'FFFFFF');
      }

      noteLinks.forEach((link) => {
        const ref = XLSX.utils.encode_cell({ r: link.row, c: link.col });
        if (!statementSheet[ref]) return;
        statementSheet[ref].l = { Target: link.target, Tooltip: 'Open note detail' };
        statementSheet[ref].s = {
          ...(statementSheet[ref].s || baseTextStyle),
          font: {
            ...((statementSheet[ref].s && statementSheet[ref].s.font) || baseTextStyle.font),
            color: { rgb: '1D4ED8' },
            underline: true,
          },
          alignment: { horizontal: 'center', vertical: 'center' },
        };
      });

      XLSX.utils.book_append_sheet(workbook, statementSheet, 'P&L Statement');

      const keyStatsRows = [
        ['Key Statistic', 'Value'],
        ['Period Filter', periodLabel],
        ['Revenue from Operations', revenueFromOperations],
        ['Other Income', otherIncome],
        ['Total Income', totalIncome],
        ['Total Expenses', totalExpenses],
        ['Gross Profit / (Loss)', grossProfit],
        ['Operating Profit / (Loss)', operatingProfit],
        [netProfit >= 0 ? 'Net Profit' : 'Net Loss', netProfit],
        ['Net Margin on Total Income (%)', formatPercent(netMargin)],
        ['Gross Profit Ratio (%)', formatPercent(grossProfitRatio)],
        ['Operating Profit Ratio (%)', formatPercent(operatingProfitRatio)],
        ['Net Profit Ratio (on Revenue) (%)', formatPercent(netProfitRatio)],
        ['Direct Cost Ratio (%)', formatPercent(directCostRatio)],
        ['Indirect Expense Ratio (%)', formatPercent(indirectExpenseRatio)],
        ['Expense to Income Ratio (%)', formatPercent(expenseToIncomeRatio)],
        ['Opening Stock Used (Deemed Debit)', openingStockSigned],
        ['Closing Stock Used (Deemed Credit)', closingStockSigned],
        ['Revenue Primary Groups', groupedByHead.REVENUE.length],
        ['Other Income Primary Groups', groupedByHead.OTHER_INCOME.length],
        ['Purchase Primary Groups', groupedByHead.PURCHASES.length],
        ['Direct Expense Primary Groups', groupedByHead.DIRECT_EXPENSES.length],
        ['Indirect Expense Primary Groups', groupedByHead.INDIRECT_EXPENSES.length],
        ['Excluded/Balance Sheet Primary Groups', groupedByHead.EXCLUDED_BALANCE_SHEET.length],
      ];

      const keyStatsSheet = XLSX.utils.aoa_to_sheet(keyStatsRows);
      keyStatsSheet['!cols'] = [{ wch: 40 }, { wch: 24 }];
      for (let r = 0; r < keyStatsRows.length; r += 1) {
        for (let c = 0; c <= 1; c += 1) {
          const ref = XLSX.utils.encode_cell({ r, c });
          if (!keyStatsSheet[ref]) continue;
          const isHeader = r === 0;
          const isNumeric = c === 1 && typeof keyStatsSheet[ref].v === 'number';
          keyStatsSheet[ref].s = {
            ...(isNumeric ? baseNumberStyle : baseTextStyle),
            font: {
              ...(isNumeric ? baseNumberStyle.font : baseTextStyle.font),
              bold: isHeader,
              color: { rgb: isHeader ? 'FFFFFF' : '0F172A' },
            },
            fill: { fgColor: { rgb: isHeader ? '334155' : r % 2 === 0 ? 'F8FAFC' : 'FFFFFF' } },
          };
        }
      }
      XLSX.utils.book_append_sheet(workbook, keyStatsSheet, 'Key Statistics');

      const analyticsRows = [
        ['P&L Analytics', 'Value'],
        ['Period Filter', periodLabel],
        ['Revenue from Operations', revenueFromOperations],
        ['Other Income', otherIncome],
        ['Core Direct Cost (Purchases + Direct + Opening + Closing)', coreDirectCost],
        ['Opening Stock Used (Deemed Debit)', openingStockSigned],
        ['Closing Stock Used (Deemed Credit)', closingStockSigned],
        ['Gross Profit / (Loss)', grossProfit],
        ['Operating Profit / (Loss)', operatingProfit],
        [netProfit >= 0 ? 'Net Profit' : 'Net Loss', netProfit],
        ['Gross Profit Ratio', formatPercent(grossProfitRatio)],
        ['Operating Profit Ratio', formatPercent(operatingProfitRatio)],
        ['Net Profit Ratio (on Revenue)', formatPercent(netProfitRatio)],
        ['Direct Cost Ratio', formatPercent(directCostRatio)],
        ['Indirect Expense Ratio', formatPercent(indirectExpenseRatio)],
        ['Expense to Income Ratio', formatPercent(expenseToIncomeRatio)],
        ['Net Margin on Total Income', formatPercent(netMargin)],
      ];

      const analyticsSheet = XLSX.utils.aoa_to_sheet(analyticsRows);
      analyticsSheet['!cols'] = [{ wch: 58 }, { wch: 22 }];
      for (let r = 0; r < analyticsRows.length; r += 1) {
        for (let c = 0; c <= 1; c += 1) {
          const ref = XLSX.utils.encode_cell({ r, c });
          if (!analyticsSheet[ref]) continue;
          const isHeader = r === 0;
          const isNumeric = c === 1 && typeof analyticsSheet[ref].v === 'number';
          analyticsSheet[ref].s = {
            ...(isNumeric ? baseNumberStyle : baseTextStyle),
            font: {
              ...(isNumeric ? baseNumberStyle.font : baseTextStyle.font),
              bold: isHeader,
              color: { rgb: isHeader ? 'FFFFFF' : '0F172A' },
            },
            fill: { fgColor: { rgb: isHeader ? '1E293B' : r % 2 === 0 ? 'F8FAFC' : 'FFFFFF' } },
          };
        }
      }
      XLSX.utils.book_append_sheet(workbook, analyticsSheet, 'P&L Analytics');

      const notesIndexRows = noteItems.map((note) => [
        note.ref,
        note.headLabel,
        note.primary,
        note.total,
        'Open Note',
      ]);
      const notesIndexSheet = XLSX.utils.aoa_to_sheet([['Note Ref', 'Head', 'Tally Primary Group', 'Amount', 'Detail']] );
      XLSX.utils.sheet_add_aoa(notesIndexSheet, notesIndexRows, { origin: 'A2' });
      notesIndexSheet['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 40 }, { wch: 18 }, { wch: 16 }];

      const notesIndexRange = notesIndexSheet['!ref']
        ? XLSX.utils.decode_range(notesIndexSheet['!ref'])
        : null;
      if (notesIndexRange) {
        for (let r = notesIndexRange.s.r; r <= notesIndexRange.e.r; r += 1) {
          for (let c = notesIndexRange.s.c; c <= notesIndexRange.e.c; c += 1) {
            const ref = XLSX.utils.encode_cell({ r, c });
            const cell = notesIndexSheet[ref];
            if (!cell) continue;
            const isHeader = r === 0;
            const isNumeric = c === 3 && typeof cell.v === 'number';
            cell.s = {
              ...(isNumeric ? baseNumberStyle : baseTextStyle),
              font: {
                ...(isNumeric ? baseNumberStyle.font : baseTextStyle.font),
                bold: isHeader,
                color: { rgb: isHeader ? 'FFFFFF' : '0F172A' },
              },
              fill: { fgColor: { rgb: isHeader ? '1E293B' : r % 2 === 0 ? 'F8FAFC' : 'FFFFFF' } },
            };
          }
        }
      }

      noteItems.forEach((note, index) => {
        const detailRef = XLSX.utils.encode_cell({ r: index + 1, c: 4 });
        if (notesIndexSheet[detailRef]) {
          notesIndexSheet[detailRef].l = { Target: `#'${note.sheetName}'!A1`, Tooltip: 'Open note detail sheet' };
          notesIndexSheet[detailRef].s = {
            ...(notesIndexSheet[detailRef].s || baseTextStyle),
            alignment: { horizontal: 'center', vertical: 'center' },
            font: {
              ...((notesIndexSheet[detailRef].s && notesIndexSheet[detailRef].s.font) || baseTextStyle.font),
              color: { rgb: '1D4ED8' },
              underline: true,
            },
          };
        }
      });

      XLSX.utils.book_append_sheet(workbook, notesIndexSheet, 'Notes Index');

      noteItems.forEach((note) => {
        const rows: any[][] = [];
        rows.push([`${note.ref} - ${note.primary}`, '', '', '']);
        rows.push([`Head: ${note.headLabel}`, '', '', '']);
        rows.push([`Period: ${periodLabel}`, '', '', '']);
        rows.push(['Parent Group', 'Ledger', 'Entries', 'Amount']);

        const rowLevels: Array<{ level?: number }> = [{}, {}, {}, {}];

        note.parentBreakup.forEach((parent) => {
          rows.push([parent.parent, '', '', parent.total]);
          rowLevels.push({ level: 0 });
          parent.ledgers.forEach((ledger) => {
            rows.push(['', ledger.ledger, ledger.entries, ledger.total]);
            rowLevels.push({ level: 1 });
          });
        });

        const sheet = XLSX.utils.aoa_to_sheet(rows);
        sheet['!cols'] = [{ wch: 28 }, { wch: 40 }, { wch: 12 }, { wch: 20 }];
        sheet['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
          { s: { r: 2, c: 0 }, e: { r: 2, c: 3 } },
        ];
        sheet['!rows'] = rowLevels;

        for (let r = 0; r < rows.length; r += 1) {
          for (let c = 0; c <= 3; c += 1) {
            const ref = XLSX.utils.encode_cell({ r, c });
            if (!sheet[ref]) sheet[ref] = { t: 's', v: '' };
            const isNumeric = (c === 2 || c === 3) && typeof sheet[ref].v === 'number';
            const isTitle = r === 0;
            const isMeta = r === 1 || r === 2;
            const isHeader = r === 3;
            const isParentSubtotal = r > 3 && c === 0 && rows[r][0];

            sheet[ref].s = {
              ...(isNumeric ? baseNumberStyle : baseTextStyle),
              font: {
                ...(isNumeric ? baseNumberStyle.font : baseTextStyle.font),
                bold: isTitle || isHeader || isParentSubtotal,
                color: { rgb: isTitle ? 'FFFFFF' : '0F172A' },
              },
              fill: {
                fgColor: {
                  rgb: isTitle
                    ? '0F172A'
                    : isMeta
                    ? 'E2E8F0'
                    : isHeader
                    ? 'CBD5E1'
                    : isParentSubtotal
                    ? 'EFF6FF'
                    : 'FFFFFF',
                },
              },
              alignment: {
                vertical: 'center',
                horizontal: isNumeric ? 'right' : c === 2 ? 'center' : 'left',
                indent: c === 1 && r > 3 ? 1 : 0,
              },
              border: BORDER_THIN,
            };
          }
        }

        sheet['A2'].l = { Target: "#'P&L Statement'!A1", Tooltip: 'Back to statement' };
        sheet['A2'].s = {
          ...(sheet['A2'].s || baseTextStyle),
          font: { ...((sheet['A2'].s && sheet['A2'].s.font) || baseTextStyle.font), color: { rgb: '1D4ED8' }, underline: true },
        };

        XLSX.utils.book_append_sheet(workbook, sheet, note.sheetName);
      });

      XLSX.writeFile(workbook, `Profit_Loss_Statement_${new Date().toISOString().slice(0, 10)}.xlsx`, {
        compression: true,
        cellStyles: true,
      });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export formatted P&L Excel. Please retry.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-900 via-slate-800 to-blue-900 p-6 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-300">Profit and Loss Workspace</p>
            <h2 className="mt-2 text-2xl font-black">Structured P&L With Manual Allocation Control</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-200">
              P&L heads are auto-allocated from Tally primary groups using flags first and keyword heuristics next.
              You can re-map any primary through checkbox multiselect. Stock/Inventory primaries are removed and handled
              via manual opening/closing stock controls.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={resetAllocationsToAuto}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-400/40 bg-slate-800/40 px-3 py-2 text-xs font-bold hover:bg-slate-700/70"
            >
              <RefreshCcw size={14} />
              Reset Auto Allocation
            </button>
            <button
              onClick={exportExcel}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-emerald-950 hover:bg-emerald-400"
            >
              <Download size={14} />
              Export P&L Excel (Notes + Links)
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-3">
            <p className="text-[11px] text-slate-300">Total Income</p>
            <p className="mt-1 text-lg font-black">{formatMoney(totalIncome)}</p>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-3">
            <p className="text-[11px] text-slate-300">Total Expenses</p>
            <p className="mt-1 text-lg font-black">{formatMoney(totalExpenses)}</p>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-3">
            <p className="text-[11px] text-slate-300">{netProfit >= 0 ? 'Net Profit' : 'Net Loss'}</p>
            <p className={`mt-1 text-lg font-black ${netProfit >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {formatMoney(netProfit)}
            </p>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-3">
            <p className="text-[11px] text-slate-300">Net Margin</p>
            <p className={`mt-1 text-lg font-black ${netMargin >= 0 ? 'text-cyan-300' : 'text-amber-300'}`}>
              {netMargin.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>

      {sqlLoading && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Loading optimized SQL P&L analytics...
        </div>
      )}
      {sqlError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {sqlError}
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3">
          <h3 className="text-sm font-bold text-slate-800">Profitability Analytics</h3>
          <p className="text-xs text-slate-500">
            Gross profit, net profit ratio, and key P&L efficiency analytics for the selected period.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {pnlAnalyticsCards.map((metric) => {
            const valueText = metric.kind === 'percent' ? formatPercent(metric.value) : formatMoney(metric.value);
            const highlight =
              metric.label.includes('Gross Profit') ||
              metric.label.includes('Operating Profit') ||
              metric.label.includes('Net Profit Ratio');
            const valueClass =
              highlight && metric.value < 0 ? 'text-rose-700' : highlight ? 'text-emerald-700' : 'text-slate-900';
            return (
              <div key={metric.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] text-slate-500">{metric.label}</p>
                <p className={`mt-1 text-lg font-black ${valueClass}`}>{valueText}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Filter size={15} className="text-slate-600" />
            <p className="text-sm font-bold text-slate-800">Month Filter (Period)</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={selectAllMonths}
              className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              Select All
            </button>
            <button
              onClick={clearMonthSelection}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {allMonths.map((month) => {
            const selected = selectedMonths.includes(month);
            return (
              <button
                key={month}
                onClick={() => toggleMonth(month)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  selected
                    ? 'border-blue-300 bg-blue-100 text-blue-800'
                    : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                {monthLabel(month)}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-slate-500">Current filter: {periodLabel}</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles size={16} className="text-indigo-600" />
          <h3 className="text-sm font-bold text-slate-800">Opening / Closing Stock (Manual Override)</h3>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-amber-700">Opening Stock</p>
            <select
              value={openingStockSourceLedger}
              onChange={(event) => onOpeningSourceChange(event.target.value)}
              className="mb-2 w-full rounded-lg border border-amber-300 bg-white px-2 py-2 text-sm"
            >
              <option value="__AUTO__">Auto Detection</option>
              {stockLedgerTotals.map((item) => (
                <option key={item.ledger} value={item.ledger}>
                  {item.ledger}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={Number.isFinite(openingStock) ? openingStock : 0}
              onChange={(event) => setOpeningStock(Number(event.target.value || 0))}
              className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold"
            />
            <p className="mt-2 text-[11px] text-amber-700">Default: {formatMoney(defaultOpeningStock)}</p>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-700">Closing Stock</p>
            <select
              value={closingStockSourceLedger}
              onChange={(event) => onClosingSourceChange(event.target.value)}
              className="mb-2 w-full rounded-lg border border-emerald-300 bg-white px-2 py-2 text-sm"
            >
              <option value="__AUTO__">Auto Detection</option>
              {stockLedgerTotals.map((item) => (
                <option key={item.ledger} value={item.ledger}>
                  {item.ledger}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={Number.isFinite(closingStock) ? closingStock : 0}
              onChange={(event) => setClosingStock(Number(event.target.value || 0))}
              className="w-full rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold"
            />
            <p className="mt-2 text-[11px] text-emerald-700">Default: {formatMoney(defaultClosingStock)}</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-slate-700" />
            <h3 className="text-sm font-bold text-slate-800">P&L Head Allocation Board (Multi-select)</h3>
          </div>
          <input
            value={groupSearch}
            onChange={(event) => setGroupSearch(event.target.value)}
            placeholder="Search primary/parent groups"
            className="w-72 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-3">
          {HEADS.map((head) => {
            const options = availableForHead(head.id);
            return (
              <div key={head.id} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 p-3 lg:grid-cols-[260px,1fr]">
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="text-sm font-black text-slate-800">{head.label}</p>
                  <p className="mt-1 text-xs text-slate-600">{head.description}</p>
                  <p className="mt-2 text-xs text-slate-500">Assigned: {(groupedByHead[head.id] || []).length}</p>
                </div>
                <div className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-white p-2">
                  <div className="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
                    {options.map((bucket) => {
                      const checked = allocations[bucket.primary] === head.id;
                      return (
                        <label
                          key={`${head.id}-${bucket.primary}`}
                          className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
                            checked
                              ? 'border-blue-300 bg-blue-50 text-blue-900'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => updateAllocation(bucket.primary, head.id, event.target.checked)}
                          />
                          <span className="truncate" title={bucket.primary}>
                            {bucket.primary}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {unassignedGroups.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-800">
              Unassigned Primary Groups ({unassignedGroups.length}) - allocate these in any head.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {unassignedGroups.slice(0, 20).map((group) => (
                <span key={group.primary} className="rounded-full bg-white px-2 py-1 text-[11px] text-amber-800 border border-amber-300">
                  {group.primary}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-800">Profit and Loss Statement (Expandable)</h3>
          <p className="text-xs text-slate-500">Click any head to expand/collapse primary and ledger break-up</p>
        </div>

        <div className="space-y-2">
          {ACTIVE_HEADS.map((head) => {
            const headRows = groupedByHead[head.id];
            const isExpanded = expandedHeads[head.id];
            return (
              <div key={head.id} className="rounded-xl border border-slate-200 overflow-hidden">
                <button
                  onClick={() => setExpandedHeads((prev) => ({ ...prev, [head.id]: !prev[head.id] }))}
                  className="w-full flex items-center justify-between bg-slate-50 px-4 py-3"
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className="font-semibold text-slate-800">{head.statementLabel}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${head.badgeClass}`}>
                      {headRows.length} groups
                    </span>
                  </div>
                  <span className="text-sm font-bold text-slate-900">{formatMoney(totalsByHead[head.id])}</span>
                </button>

                {isExpanded && (
                  <div className="divide-y divide-slate-100">
                    {headRows.map((bucket) => {
                      const primaryKey = `${head.id}::${bucket.primary}`;
                      const primaryExpanded = !!expandedPrimaries[primaryKey];
                      const note = noteRefByPrimary.get(primaryKey);
                      return (
                        <div key={primaryKey} className="bg-white">
                          <button
                            onClick={() => setExpandedPrimaries((prev) => ({ ...prev, [primaryKey]: !prev[primaryKey] }))}
                            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-50"
                          >
                            <div className="flex items-center gap-2">
                              {primaryExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              <span className="text-sm text-slate-700">{bucket.primary}</span>
                              {note && <span className="rounded bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">{note.ref}</span>}
                            </div>
                            <span className="text-sm font-semibold text-slate-900">{formatMoney(bucket.total)}</span>
                          </button>

                          {primaryExpanded && (
                            <div className="px-4 pb-3">
                              {(bucket.parentBreakup || buildParentBreakup(bucket.entries)).map((parent) => (
                                <div key={`${primaryKey}-${parent.parent}`} className="mb-2 rounded-lg border border-slate-200 bg-slate-50">
                                  <div className="flex items-center justify-between border-b border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700">
                                    <span>{parent.parent}</span>
                                    <span>{formatMoney(parent.total)}</span>
                                  </div>
                                  <div className="divide-y divide-slate-100">
                                    {parent.ledgers.map((ledger) => (
                                      <div key={`${primaryKey}-${parent.parent}-${ledger.ledger}`} className="flex items-center justify-between px-3 py-1.5 text-xs">
                                        <span className="text-slate-600">{ledger.ledger}</span>
                                        <span className="font-semibold text-slate-800">{formatMoney(ledger.total)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {headRows.length === 0 && (
                      <div className="px-4 py-3 text-xs text-slate-400">No primary groups mapped to this head.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Total Income</span>
              <span className="font-bold text-slate-900">{formatMoney(totalIncome)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Total Expenses</span>
              <span className="font-bold text-slate-900">{formatMoney(totalExpenses)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">{netProfit >= 0 ? 'Net Profit' : 'Net Loss'}</span>
              <span className={`font-bold ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {formatMoney(netProfit)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Excluded (Balance Sheet)</span>
              <span className="font-bold text-slate-900">{formatMoney(totalsByHead.EXCLUDED_BALANCE_SHEET)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfitLossAnalysis;
