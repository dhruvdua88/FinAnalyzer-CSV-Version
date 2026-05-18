import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTallyStore } from '../../services/tally';
import { LedgerEntry } from '../../types';
import { Download, Search, CheckSquare, ChevronDown, ChevronUp, Wallet } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
} from 'recharts';

interface CashFlowAnalysisProps {
  data: LedgerEntry[];
}

interface CashFlowRow {
  key: string;
  voucherKey: string;
  date: string;
  dateTs: number;
  monthKey: string;
  monthLabel: string;
  voucherType: string;
  voucherNumber: string;
  cashLedgers: string;
  oppositeLedger: string;
  oppositePrimary: string;
  oppositeParent: string;
  party: string;
  narration: string;
  inflow: number;
  outflow: number;
  net: number;
  activity: CashFlowActivity;
  classificationRule: string;
  classificationReason: string;
}

interface BucketRow {
  key: string;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  vouchers: number;
}

interface CashLedgerDetailRow {
  ledger: string;
  opening: number;
  inflow: number;
  outflow: number;
  netMovement: number;
  closing: number;
  referenceClosing: number | null;
  diff: number | null;
}

type CashFlowActivity = 'Operating' | 'Investing' | 'Financing';

interface CashFlowClassification {
  activity: CashFlowActivity;
  rule: string;
  reason: string;
}

interface StatementBucket {
  activity: CashFlowActivity;
  bucket: string;
  inflow: number;
  outflow: number;
  net: number;
}

interface CashFlowStatementModel {
  buckets: StatementBucket[];
  byActivity: Record<CashFlowActivity, { inflow: number; outflow: number; net: number }>;
  classifiedNet: number;
  adjustmentNet: number;
  opening: number;
  movement: number;
  closing: number;
}

interface CashPosition {
  opening: number;
  periodMovement: number;
  closing: number;
  referenceClosing: number | null;
  reconciliationDiff: number | null;
}

const toNumber = (value: any): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseOptionalNumber = (value: any): number | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const parseDateTs = (value: string): number => {
  if (!value) return 0;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    const [dd, mm, yyyy] = value.split('/').map(Number);
    const d = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  if (/^\d{2}\/\d{2}\/\d{2}$/.test(value)) {
    const [dd, mm, yy] = value.split('/').map(Number);
    const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
    const d = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};

const toISODate = (ts: number): string => {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const toDDMMYYYY = (value: string) => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const ts = parseDateTs(value);
  if (!ts) return value;
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const formatAmount = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatMonthKey = (ts: number) => {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${month}`;
};

const formatMonthLabel = (ts: number) => {
  const d = new Date(ts);
  return d.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
};

const resolveParty = (entries: LedgerEntry[]): string => {
  const byPartyName = entries.map((e) => String(e.party_name || '').trim()).find((name) => name.length > 0);
  if (byPartyName) return byPartyName;

  const fallback = entries.find((entry) => {
    const primary = String(entry.TallyPrimary || '').toLowerCase();
    const parent = String(entry.TallyParent || '').toLowerCase();
    return primary.includes('creditor') || primary.includes('debtor') || parent.includes('creditor') || parent.includes('debtor');
  });
  return String(fallback?.Ledger || 'N/A').trim() || 'N/A';
};

const buildVoucherKey = (entry: LedgerEntry) => {
  const voucherNumber = String(entry.voucher_number || entry.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN';
  const date = String(entry.date || '').trim();
  const voucherType = String(entry.voucher_type || '').trim();
  return `${voucherNumber}__${date}__${voucherType}`;
};

const isBlockedCapitalLedger = (value: string) => {
  const text = value.toLowerCase();
  return (
    text.includes('debtor') ||
    text.includes('receivable') ||
    text.includes('advance') ||
    text.includes('stock') ||
    text.includes('inventory') ||
    text.includes('loan and advance')
  );
};

const normalizeClassifierText = (...parts: string[]) =>
  parts
    .map((part) => String(part || '').toLowerCase())
    .join(' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const includesAny = (text: string, keys: string[]) => keys.some((key) => text.includes(key));

// Deterministic mapping from Tally's standard primary groups to AS-3 cash
// flow activities. Used when a ZIP-imported store gives us the authoritative
// primary; falls through to the text-heuristic matcher when the store hint
// isn't conclusive. Keys are lowercased mst_group.primary_group values.
const PRIMARY_GROUP_ACTIVITY: Record<string, CashFlowActivity> = {
  // Working capital + revenue cycle → Operating
  'sundry debtors':         'Operating',
  'sundry creditors':       'Operating',
  'sales accounts':         'Operating',
  'purchase accounts':      'Operating',
  'direct incomes':         'Operating',
  'direct expenses':        'Operating',
  'indirect incomes':       'Operating',
  'indirect expenses':      'Operating',
  'duties & taxes':         'Operating',
  'provisions':             'Operating',
  'current assets':         'Operating',  // (non-cash within current — bank/cash filtered out elsewhere)
  'current liabilities':    'Operating',
  'stock-in-hand':          'Operating',
  'cash-in-hand':           'Operating',  // (the cash itself; routed differently when selected)
  'bank accounts':          'Operating',
  'bank od a/c':            'Operating',
  // Long-term asset side → Investing
  'fixed assets':           'Investing',
  'investments':            'Investing',
  // Capital structure → Financing
  'capital account':        'Financing',
  'reserves & surplus':     'Financing',
  'loans (liability)':      'Financing',
  'secured loans':          'Financing',
  'unsecured loans':        'Financing',
  // Suspense / misc — keep as operating (default-like behaviour)
  'suspense a/c':           'Operating',
  'misc. expenses (asset)': 'Operating',
  'branch / divisions':     'Operating',
  'loans & advances (asset)': 'Investing',
  'deposits (asset)':       'Investing',
};

const classifyActivity = (ledger: string, primary: string, parent: string): CashFlowClassification => {
  const ledgerText = normalizeClassifierText(ledger);
  const primaryText = normalizeClassifierText(primary);
  const parentText = normalizeClassifierText(parent);
  const text = normalizeClassifierText(ledger, primary, parent);

  // Store-driven primary match (mst_group.primary_group is authoritative)
  const primaryLookup = primary.trim().toLowerCase();
  const mapped = PRIMARY_GROUP_ACTIVITY[primaryLookup];
  if (mapped) {
    return {
      activity: mapped,
      rule: 'STORE_PRIMARY_MAP',
      reason: `mst_group.primary_group = "${primary}" maps to ${mapped} per AS-3.`,
    };
  }

  // Rule priority is intentional: working-capital party ledgers should stay in Operating
  // even when the ledger name incidentally contains terms like "capital".
  const workingCapitalKeys = [
    'sundry debtor',
    'sundry creditor',
    'trade receivable',
    'trade payable',
    'debtor',
    'creditor',
    'receivable',
    'payable',
    'customer',
    'vendor',
    'supplier',
  ];
  if (
    includesAny(primaryText, workingCapitalKeys) ||
    includesAny(parentText, workingCapitalKeys) ||
    includesAny(ledgerText, workingCapitalKeys)
  ) {
    return {
      activity: 'Operating',
      rule: 'WORKING_CAPITAL_PARTY',
      reason: 'Debtor/Creditor/Receivable/Payable movement is treated as operating cash flow.',
    };
  }

  const operatingKeys = [
    'purchase',
    'sales',
    'expense',
    'indirect expense',
    'direct expense',
    'income',
    'revenue',
    'duties taxes',
    'duty tax',
    'current asset',
    'current liability',
    'provision',
  ];
  if (includesAny(primaryText, operatingKeys) || includesAny(parentText, operatingKeys)) {
    return {
      activity: 'Operating',
      rule: 'OPERATING_PRIMARY_PARENT',
      reason: 'Primary/parent group indicates routine business operations.',
    };
  }

  const financingKeys = [
    'secured loan',
    'unsecured loan',
    'term loan',
    'working capital loan',
    'cash credit',
    'bank overdraft',
    'od account',
    'share capital',
    'equity share',
    'preference share',
    'partner capital',
    'proprietor capital',
    'capital account',
    'debenture',
    'borrowings',
    'dividend',
    'finance lease',
    'interest on loan',
  ];
  if (includesAny(text, financingKeys)) {
    return {
      activity: 'Financing',
      rule: 'FINANCING_CAPITAL_STRUCTURE',
      reason: 'Loan, borrowing, capital or equity terms indicate financing cash flow.',
    };
  }

  const investingKeys = [
    'fixed asset',
    'property plant equipment',
    'plant machinery',
    'capital work in progress',
    'cwip',
    'investment',
    'intangible asset',
    'non current asset',
    'long term investment',
  ];
  if (includesAny(text, investingKeys)) {
    return {
      activity: 'Investing',
      rule: 'INVESTING_LONG_TERM_ASSET',
      reason: 'Long-term asset or investment terms indicate investing cash flow.',
    };
  }

  return {
    activity: 'Operating',
    rule: 'DEFAULT_OPERATING',
    reason: 'No financing/investing signal found; defaulted to operating.',
  };
};

const CashFlowAnalysis: React.FC<CashFlowAnalysisProps> = ({ data }) => {
  const store = useTallyStore();
  // Per-ledger bank attributes from mst_ledger. Surfaced inline alongside
  // the cash-ledger selector so the auditor can sanity-check that the
  // ledger they're treating as "cash" actually has a bank account on file
  // (and which one).
  const bankAttrsByLedger = useMemo(() => {
    const map = new Map<string, { accountNumber: string; ifsc: string; bankName: string; branch: string; holder: string }>();
    if (!store) return map;
    for (const l of store.ledgers.values()) {
      if (l.bank_account_number || l.bank_ifsc || l.bank_name) {
        map.set(l.name, {
          accountNumber: l.bank_account_number || '',
          ifsc: l.bank_ifsc || '',
          bankName: l.bank_name || '',
          branch: l.bank_branch || '',
          holder: l.bank_account_holder || '',
        });
      }
    }
    return map;
  }, [store]);
  const [selectedCashLedgers, setSelectedCashLedgers] = useState<string[]>([]);
  const [isSelectionExpanded, setIsSelectionExpanded] = useState(true);
  const [cashLedgerSearch, setCashLedgerSearch] = useState('');
  const [mainSearch, setMainSearch] = useState('');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'inflow' | 'outflow'>('all');
  const [minAmount, setMinAmount] = useState('0');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const initSelectionRef = useRef(false);
  const initPeriodRef = useRef(false);

  const ledgerMetaMap = useMemo(() => {
    const map = new Map<string, { primary: string; parent: string }>();
    data.forEach((entry) => {
      const ledger = String(entry.Ledger || '').trim();
      if (!ledger || map.has(ledger)) return;
      map.set(ledger, {
        primary: String(entry.TallyPrimary || ''),
        parent: String(entry.TallyParent || ''),
      });
    });
    return map;
  }, [data]);

  const allLedgers = useMemo(() => Array.from(ledgerMetaMap.keys()).sort(), [ledgerMetaMap]);

  const autoCashLedgers = useMemo(() => {
    return allLedgers.filter((ledger) => {
      const meta = ledgerMetaMap.get(ledger);
      const primary = String(meta?.primary || '').toLowerCase();
      return primary.includes('bank') || primary.includes('cash');
    });
  }, [allLedgers, ledgerMetaMap]);

  useEffect(() => {
    if (initSelectionRef.current) return;
    setSelectedCashLedgers(autoCashLedgers);
    initSelectionRef.current = true;
  }, [autoCashLedgers]);

  const datedRows = useMemo(
    () =>
      data
        .map((entry) => ({ entry, ts: parseDateTs(String(entry.date || '')) }))
        .filter((item) => item.ts > 0)
        .sort((a, b) => a.ts - b.ts),
    [data]
  );

  useEffect(() => {
    if (initPeriodRef.current) return;
    if (datedRows.length === 0) return;
    setFromDate(toISODate(datedRows[0].ts));
    setToDate(toISODate(datedRows[datedRows.length - 1].ts));
    initPeriodRef.current = true;
  }, [datedRows]);

  const filteredCashLedgers = useMemo(() => {
    const q = cashLedgerSearch.trim().toLowerCase();
    if (!q) return allLedgers;
    return allLedgers.filter((ledger) => {
      const meta = ledgerMetaMap.get(ledger);
      const primary = String(meta?.primary || '');
      const parent = String(meta?.parent || '');
      return (
        ledger.toLowerCase().includes(q) ||
        primary.toLowerCase().includes(q) ||
        parent.toLowerCase().includes(q)
      );
    });
  }, [allLedgers, cashLedgerSearch, ledgerMetaMap]);

  const flowModel = useMemo(() => {
    if (selectedCashLedgers.length === 0) {
      return {
        rows: [] as CashFlowRow[],
        monthlySeries: [] as Array<{ monthKey: string; monthLabel: string; inflow: number; outflow: number }>,
        byOppositeLedger: [] as BucketRow[],
        byOppositePrimary: [] as BucketRow[],
        voucherCount: 0,
        cashPosition: {
          opening: 0,
          periodMovement: 0,
          closing: 0,
          referenceClosing: null,
          reconciliationDiff: null,
        } as CashPosition,
        blockedCapitalOutflow: 0,
      };
    }

    const selectedSet = new Set(selectedCashLedgers);
    const fromTs = fromDate ? parseDateTs(fromDate) : Number.NEGATIVE_INFINITY;
    const toTsRaw = toDate ? parseDateTs(toDate) : Number.POSITIVE_INFINITY;
    const toTs = Number.isFinite(toTsRaw) ? toTsRaw + 86399999 : Number.POSITIVE_INFINITY;

    const rowsInPeriod = data.filter((entry) => {
      const ts = parseDateTs(String(entry.date || ''));
      if (!ts) return false;
      return ts >= fromTs && ts <= toTs;
    });

    const voucherMap = new Map<string, LedgerEntry[]>();
    rowsInPeriod.forEach((entry) => {
      const key = buildVoucherKey(entry);
      if (!voucherMap.has(key)) voucherMap.set(key, []);
      voucherMap.get(key)!.push(entry);
    });

    const flows: CashFlowRow[] = [];

    voucherMap.forEach((entries, voucherKey) => {
      const cashEntries = entries.filter((entry) => selectedSet.has(String(entry.Ledger || '').trim()));
      if (cashEntries.length === 0) return;

      const oppositeEntries = entries.filter((entry) => !selectedSet.has(String(entry.Ledger || '').trim()));
      if (oppositeEntries.length === 0) return;

      const voucherDate = String(entries[0]?.date || '').trim();
      const voucherDateTs = parseDateTs(voucherDate);
      const voucherNumber = String(entries[0]?.voucher_number || entries[0]?.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN';
      const voucherType = String(entries[0]?.voucher_type || '').trim();
      const party = resolveParty(entries);
      const narration =
        entries.map((entry) => String(entry.narration || '').trim()).find((text) => text.length > 0) || '';

      const cashLedgers = Array.from(
        new Set(cashEntries.map((entry) => String(entry.Ledger || '').trim()).filter((text) => text.length > 0))
      ).join(', ');

      const oppositeAgg = new Map<string, { ledger: string; primary: string; parent: string; amount: number }>();
      oppositeEntries.forEach((entry) => {
        const ledger = String(entry.Ledger || 'Unknown Ledger').trim() || 'Unknown Ledger';
        const primary = String(entry.TallyPrimary || 'Unclassified').trim() || 'Unclassified';
        const parent = String(entry.TallyParent || 'Unclassified').trim() || 'Unclassified';
        const key = `${ledger}__${primary}__${parent}`;
        if (!oppositeAgg.has(key)) {
          oppositeAgg.set(key, { ledger, primary, parent, amount: 0 });
        }
        oppositeAgg.get(key)!.amount += toNumber(entry.amount);
      });

      oppositeAgg.forEach((bucket) => {
        if (!bucket.amount) return;
        const inflow = bucket.amount > 0 ? bucket.amount : 0;
        const outflow = bucket.amount < 0 ? Math.abs(bucket.amount) : 0;
        const net = inflow - outflow;
        const classification = classifyActivity(bucket.ledger, bucket.primary, bucket.parent);

        flows.push({
          key: `${voucherKey}__${bucket.ledger}`,
          voucherKey,
          date: voucherDate,
          dateTs: voucherDateTs,
          monthKey: voucherDateTs ? formatMonthKey(voucherDateTs) : '',
          monthLabel: voucherDateTs ? formatMonthLabel(voucherDateTs) : '-',
          voucherType,
          voucherNumber,
          cashLedgers,
          oppositeLedger: bucket.ledger,
          oppositePrimary: bucket.primary,
          oppositeParent: bucket.parent,
          party,
          narration,
          inflow,
          outflow,
          net,
          activity: classification.activity,
          classificationRule: classification.rule,
          classificationReason: classification.reason,
        });
      });
    });

    flows.sort((a, b) => {
      const dateDiff = a.dateTs - b.dateTs;
      if (dateDiff !== 0) return dateDiff;
      return a.voucherNumber.localeCompare(b.voucherNumber);
    });

    const monthMap = new Map<string, { monthKey: string; monthLabel: string; inflow: number; outflow: number }>();
    flows.forEach((row) => {
      if (!row.monthKey) return;
      if (!monthMap.has(row.monthKey)) {
        monthMap.set(row.monthKey, { monthKey: row.monthKey, monthLabel: row.monthLabel, inflow: 0, outflow: 0 });
      }
      const bucket = monthMap.get(row.monthKey)!;
      bucket.inflow += row.inflow;
      bucket.outflow += row.outflow;
    });

    const monthlySeries = Array.from(monthMap.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey));

    const buildBuckets = (selector: (row: CashFlowRow) => string): BucketRow[] => {
      const map = new Map<string, BucketRow & { voucherSet: Set<string> }>();

      flows.forEach((row) => {
        const key = selector(row) || 'Unclassified';
        if (!map.has(key)) {
          map.set(key, {
            key,
            label: key,
            inflow: 0,
            outflow: 0,
            net: 0,
            vouchers: 0,
            voucherSet: new Set<string>(),
          });
        }
        const bucket = map.get(key)!;
        bucket.inflow += row.inflow;
        bucket.outflow += row.outflow;
        bucket.net += row.net;
        bucket.voucherSet.add(row.voucherKey);
      });

      return Array.from(map.values())
        .map((row) => ({
          key: row.key,
          label: row.label,
          inflow: row.inflow,
          outflow: row.outflow,
          net: row.net,
          vouchers: row.voucherSet.size,
        }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    };

    const byOppositeLedger = buildBuckets((row) => row.oppositeLedger);
    const byOppositePrimary = buildBuckets((row) => row.oppositePrimary);

    const blockedCapitalOutflow = flows.reduce((sum, row) => {
      const descriptor = `${row.oppositeLedger} ${row.oppositePrimary} ${row.oppositeParent}`;
      return isBlockedCapitalLedger(descriptor) ? sum + row.outflow : sum;
    }, 0);

    const selectedCashEntries = data.filter((entry) => selectedSet.has(String(entry.Ledger || '').trim()));

    const openingByLedger = new Map<string, number>();
    const closingByLedger = new Map<string, number>();

    selectedCashEntries
      .slice()
      .sort((a, b) => parseDateTs(String(a.date || '')) - parseDateTs(String(b.date || '')))
      .forEach((entry) => {
        const ledger = String(entry.Ledger || '').trim();
        if (!ledger) return;
        if (!openingByLedger.has(ledger)) {
          const opening = parseOptionalNumber(entry.opening_balance);
          if (opening !== null) openingByLedger.set(ledger, opening);
        }
      });

    selectedCashEntries
      .slice()
      .sort((a, b) => parseDateTs(String(b.date || '')) - parseDateTs(String(a.date || '')))
      .forEach((entry) => {
        const ledger = String(entry.Ledger || '').trim();
        if (!ledger || closingByLedger.has(ledger)) return;
        const closing = parseOptionalNumber(entry.closing_balance);
        if (closing !== null) closingByLedger.set(ledger, closing);
      });

    const totalOpening = selectedCashLedgers.reduce((sum, ledger) => sum + (openingByLedger.get(ledger) || 0), 0);
    const totalClosing = selectedCashLedgers.reduce((sum, ledger) => sum + (closingByLedger.get(ledger) || 0), 0);
    const hasReferenceClosing = selectedCashLedgers.some((ledger) => closingByLedger.has(ledger));

    const movementBefore = selectedCashEntries
      .filter((entry) => {
        const ts = parseDateTs(String(entry.date || ''));
        return ts && ts < fromTs;
      })
      .reduce((sum, entry) => sum + toNumber(entry.amount), 0);

    const movementAfter = selectedCashEntries
      .filter((entry) => {
        const ts = parseDateTs(String(entry.date || ''));
        return ts && ts > toTs;
      })
      .reduce((sum, entry) => sum + toNumber(entry.amount), 0);

    const periodMovement = selectedCashEntries
      .filter((entry) => {
        const ts = parseDateTs(String(entry.date || ''));
        return ts && ts >= fromTs && ts <= toTs;
      })
      .reduce((sum, entry) => sum + toNumber(entry.amount), 0);

    const openingAtPeriod = totalOpening + movementBefore;
    const closingAtPeriod = openingAtPeriod + periodMovement;
    const referenceClosingAtPeriod = hasReferenceClosing ? totalClosing - movementAfter : null;

    const cashPosition: CashPosition = {
      opening: openingAtPeriod,
      periodMovement,
      closing: closingAtPeriod,
      referenceClosing: referenceClosingAtPeriod,
      reconciliationDiff:
        referenceClosingAtPeriod === null ? null : closingAtPeriod - referenceClosingAtPeriod,
    };

    return {
      rows: flows,
      monthlySeries,
      byOppositeLedger,
      byOppositePrimary,
      voucherCount: new Set(flows.map((row) => row.voucherKey)).size,
      cashPosition,
      blockedCapitalOutflow,
    };
  }, [data, selectedCashLedgers, fromDate, toDate]);

  const filteredRows = useMemo(() => {
    const q = mainSearch.trim().toLowerCase();
    const amountThreshold = parseFloat(minAmount || '0') || 0;

    return flowModel.rows.filter((row) => {
      if (directionFilter === 'inflow' && row.inflow <= 0) return false;
      if (directionFilter === 'outflow' && row.outflow <= 0) return false;

      const amountToCheck = directionFilter === 'inflow' ? row.inflow : directionFilter === 'outflow' ? row.outflow : Math.max(row.inflow, row.outflow);
      if (amountToCheck < amountThreshold) return false;

      if (!q) return true;
      return (
        row.voucherNumber.toLowerCase().includes(q) ||
        row.voucherType.toLowerCase().includes(q) ||
        row.cashLedgers.toLowerCase().includes(q) ||
        row.oppositeLedger.toLowerCase().includes(q) ||
        row.oppositePrimary.toLowerCase().includes(q) ||
        row.party.toLowerCase().includes(q) ||
        row.narration.toLowerCase().includes(q)
      );
    });
  }, [flowModel.rows, mainSearch, directionFilter, minAmount]);

  const ledgerDetailRows = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        primarySet: Set<string>;
        parentSet: Set<string>;
        activitySet: Set<CashFlowActivity>;
        ruleSet: Set<string>;
        inflow: number;
        outflow: number;
        net: number;
        voucherSet: Set<string>;
      }
    >();

    filteredRows.forEach((row) => {
      const key = row.oppositeLedger || 'Unclassified';
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: key,
          primarySet: new Set<string>(),
          parentSet: new Set<string>(),
          activitySet: new Set<CashFlowActivity>(),
          ruleSet: new Set<string>(),
          inflow: 0,
          outflow: 0,
          net: 0,
          voucherSet: new Set<string>(),
        });
      }

      const bucket = map.get(key)!;
      if (row.oppositePrimary) bucket.primarySet.add(row.oppositePrimary);
      if (row.oppositeParent) bucket.parentSet.add(row.oppositeParent);
      bucket.activitySet.add(row.activity);
      if (row.classificationRule) bucket.ruleSet.add(row.classificationRule);
      bucket.inflow += row.inflow;
      bucket.outflow += row.outflow;
      bucket.net += row.net;
      bucket.voucherSet.add(row.voucherKey);
    });

    const totalInflow = Array.from(map.values()).reduce((sum, item) => sum + item.inflow, 0);
    const totalOutflow = Array.from(map.values()).reduce((sum, item) => sum + item.outflow, 0);

    return Array.from(map.values())
      .map((item) => ({
        key: item.key,
        label: item.label,
        activity:
          item.activitySet.size === 1
            ? Array.from(item.activitySet)[0]
            : item.activitySet.size > 1
              ? 'Mixed'
              : 'Operating',
        classificationRule:
          item.ruleSet.size === 1
            ? Array.from(item.ruleSet)[0]
            : item.ruleSet.size > 1
              ? 'MULTI_RULE'
              : 'DEFAULT_OPERATING',
        primary: Array.from(item.primarySet).join(', ') || '-',
        parent: Array.from(item.parentSet).join(', ') || '-',
        inflow: item.inflow,
        outflow: item.outflow,
        net: item.net,
        vouchers: item.voucherSet.size,
        inflowShare: totalInflow > 0 ? (item.inflow / totalInflow) * 100 : 0,
        outflowShare: totalOutflow > 0 ? (item.outflow / totalOutflow) * 100 : 0,
      }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  }, [filteredRows]);

  const topOppositeLedgerFlows = useMemo(() => {
    return ledgerDetailRows.slice(0, 12);
  }, [ledgerDetailRows]);

  const cashLedgerDetail = useMemo(() => {
    if (selectedCashLedgers.length === 0) return [] as CashLedgerDetailRow[];

    const fromTs = fromDate ? parseDateTs(fromDate) : Number.NEGATIVE_INFINITY;
    const toTsRaw = toDate ? parseDateTs(toDate) : Number.POSITIVE_INFINITY;
    const toTs = Number.isFinite(toTsRaw) ? toTsRaw + 86399999 : Number.POSITIVE_INFINITY;

    return selectedCashLedgers
      .map((ledger): CashLedgerDetailRow => {
        const rows = data
          .filter((entry) => String(entry.Ledger || '').trim() === ledger)
          .sort((a, b) => parseDateTs(String(a.date || '')) - parseDateTs(String(b.date || '')));

        let baseOpening: number | null = null;
        rows.forEach((entry) => {
          if (baseOpening !== null) return;
          const parsed = parseOptionalNumber(entry.opening_balance);
          if (parsed !== null) baseOpening = parsed;
        });

        let baseClosing: number | null = null;
        for (let i = rows.length - 1; i >= 0; i--) {
          const parsed = parseOptionalNumber(rows[i].closing_balance);
          if (parsed !== null) {
            baseClosing = parsed;
            break;
          }
        }

        const movementBefore = rows
          .filter((entry) => {
            const ts = parseDateTs(String(entry.date || ''));
            return ts && ts < fromTs;
          })
          .reduce((sum, entry) => sum + toNumber(entry.amount), 0);

        const movementAfter = rows
          .filter((entry) => {
            const ts = parseDateTs(String(entry.date || ''));
            return ts && ts > toTs;
          })
          .reduce((sum, entry) => sum + toNumber(entry.amount), 0);

        const inPeriodRows = rows.filter((entry) => {
          const ts = parseDateTs(String(entry.date || ''));
          return ts && ts >= fromTs && ts <= toTs;
        });

        const inflow = inPeriodRows
          .filter((entry) => toNumber(entry.amount) > 0)
          .reduce((sum, entry) => sum + toNumber(entry.amount), 0);
        const outflow = inPeriodRows
          .filter((entry) => toNumber(entry.amount) < 0)
          .reduce((sum, entry) => sum + Math.abs(toNumber(entry.amount)), 0);
        const netMovement = inflow - outflow;

        const opening = (baseOpening || 0) + movementBefore;
        const closing = opening + netMovement;
        const referenceClosing = baseClosing === null ? null : baseClosing - movementAfter;
        const diff = referenceClosing === null ? null : closing - referenceClosing;

        return {
          ledger,
          opening,
          inflow,
          outflow,
          netMovement,
          closing,
          referenceClosing,
          diff,
        };
      })
      .sort((a, b) => Math.abs(b.netMovement) - Math.abs(a.netMovement));
  }, [data, selectedCashLedgers, fromDate, toDate]);

  const cashFlowStatement = useMemo((): CashFlowStatementModel => {
    const bucketMap = new Map<string, StatementBucket>();

    flowModel.rows.forEach((row) => {
      const activity = row.activity;
      const bucketName = row.oppositePrimary || row.oppositeLedger || 'Unclassified';
      const key = `${activity}__${bucketName}`;
      if (!bucketMap.has(key)) {
        bucketMap.set(key, {
          activity,
          bucket: bucketName,
          inflow: 0,
          outflow: 0,
          net: 0,
        });
      }

      const bucket = bucketMap.get(key)!;
      bucket.inflow += row.inflow;
      bucket.outflow += row.outflow;
      bucket.net += row.net;
    });

    const buckets = Array.from(bucketMap.values()).sort((a, b) => {
      if (a.activity !== b.activity) return a.activity.localeCompare(b.activity);
      return Math.abs(b.net) - Math.abs(a.net);
    });

    const byActivity: Record<CashFlowActivity, { inflow: number; outflow: number; net: number }> = {
      Operating: { inflow: 0, outflow: 0, net: 0 },
      Investing: { inflow: 0, outflow: 0, net: 0 },
      Financing: { inflow: 0, outflow: 0, net: 0 },
    };

    buckets.forEach((bucket) => {
      byActivity[bucket.activity].inflow += bucket.inflow;
      byActivity[bucket.activity].outflow += bucket.outflow;
      byActivity[bucket.activity].net += bucket.net;
    });

    const classifiedNet = byActivity.Operating.net + byActivity.Investing.net + byActivity.Financing.net;
    const movement = flowModel.cashPosition.periodMovement;
    const adjustmentNet = movement - classifiedNet;

    return {
      buckets,
      byActivity,
      classifiedNet,
      adjustmentNet,
      opening: flowModel.cashPosition.opening,
      movement,
      closing: flowModel.cashPosition.closing,
    };
  }, [flowModel]);

  const topOutflowPrimaries = useMemo(
    () => flowModel.byOppositePrimary.filter((row) => row.outflow > 0).sort((a, b) => b.outflow - a.outflow).slice(0, 8),
    [flowModel.byOppositePrimary]
  );

  const topInflowPrimaries = useMemo(
    () => flowModel.byOppositePrimary.filter((row) => row.inflow > 0).sort((a, b) => b.inflow - a.inflow).slice(0, 8),
    [flowModel.byOppositePrimary]
  );

  const summary = useMemo(() => {
    const totals = flowModel.rows.reduce(
      (acc, row) => {
        acc.inflow += row.inflow;
        acc.outflow += row.outflow;
        return acc;
      },
      { inflow: 0, outflow: 0 }
    );

    return {
      inflow: totals.inflow,
      outflow: totals.outflow,
      net: totals.inflow - totals.outflow,
      blockedCapitalOutflow: flowModel.blockedCapitalOutflow,
      voucherCount: flowModel.voucherCount,
      visibleRows: filteredRows.length,
    };
  }, [flowModel, filteredRows.length]);

  const toggleCashLedger = (ledger: string) => {
    setSelectedCashLedgers((prev) =>
      prev.includes(ledger) ? prev.filter((item) => item !== ledger) : [...prev, ledger]
    );
  };

  const applyAutoCashLedgers = () => {
    setSelectedCashLedgers(autoCashLedgers);
  };

  const clearCashLedgers = () => {
    setSelectedCashLedgers([]);
  };

  const exportExcel = async () => {
    if (filteredRows.length === 0) return;

    try {
      const XLSX = await import('xlsx');

      const summaryRows = ledgerDetailRows.map((row) => ({
        'Opposite Ledger': row.label,
        Activity: row.activity,
        'Classification Rule': row.classificationRule,
        'Opposite Primary': row.primary,
        'Opposite Parent': row.parent,
        Inflow: row.inflow,
        Outflow: row.outflow,
        Net: row.net,
        'Inflow Share %': row.inflowShare,
        'Outflow Share %': row.outflowShare,
        Vouchers: row.vouchers,
      }));

      const primaryRows = flowModel.byOppositePrimary.map((row) => ({
        'Opposite Primary': row.label,
        Inflow: row.inflow,
        Outflow: row.outflow,
        Net: row.net,
        Vouchers: row.vouchers,
      }));

      const monthRows = flowModel.monthlySeries.map((row) => ({
        Month: row.monthLabel,
        Inflow: row.inflow,
        Outflow: row.outflow,
        Net: row.inflow - row.outflow,
      }));

      const cashPositionRows = [
        {
          'Period From': fromDate ? toDDMMYYYY(fromDate) : '-',
          'Period To': toDate ? toDDMMYYYY(toDate) : '-',
          'Opening Cash Position': flowModel.cashPosition.opening,
          'Period Cash Movement': flowModel.cashPosition.periodMovement,
          'Computed Closing Cash': flowModel.cashPosition.closing,
          'Reference Closing Cash': flowModel.cashPosition.referenceClosing ?? '',
          'Reconciliation Difference': flowModel.cashPosition.reconciliationDiff ?? '',
        },
      ];

      const statementRows: Record<string, any>[] = [];
      const activities: CashFlowActivity[] = ['Operating', 'Investing', 'Financing'];

      activities.forEach((activity) => {
        statementRows.push({
          Line: `${activity} Activities`,
          Inflow: '',
          Outflow: '',
          Net: '',
        });

        cashFlowStatement.buckets
          .filter((bucket) => bucket.activity === activity)
          .forEach((bucket) => {
            statementRows.push({
              Line: bucket.bucket,
              Inflow: bucket.inflow,
              Outflow: bucket.outflow,
              Net: bucket.net,
            });
          });

        statementRows.push({
          Line: `Net Cash From ${activity} Activities`,
          Inflow: cashFlowStatement.byActivity[activity].inflow,
          Outflow: cashFlowStatement.byActivity[activity].outflow,
          Net: cashFlowStatement.byActivity[activity].net,
        });
      });

      statementRows.push({
        Line: 'Unclassified/Contra Adjustment',
        Inflow: '',
        Outflow: '',
        Net: cashFlowStatement.adjustmentNet,
      });
      statementRows.push({
        Line: 'Net Increase/(Decrease) in Cash',
        Inflow: '',
        Outflow: '',
        Net: cashFlowStatement.movement,
      });
      statementRows.push({
        Line: 'Opening Cash & Cash Equivalents',
        Inflow: '',
        Outflow: '',
        Net: cashFlowStatement.opening,
      });
      statementRows.push({
        Line: 'Closing Cash & Cash Equivalents',
        Inflow: '',
        Outflow: '',
        Net: cashFlowStatement.closing,
      });

      const cashLedgerRows = cashLedgerDetail.map((row) => ({
        'Cash Ledger': row.ledger,
        Opening: row.opening,
        Inflow: row.inflow,
        Outflow: row.outflow,
        'Net Movement': row.netMovement,
        Closing: row.closing,
        'Reference Closing': row.referenceClosing ?? '',
        Diff: row.diff ?? '',
      }));

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'Ledger Flow Summary');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(cashLedgerRows), 'Cash Ledger Movement');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(statementRows), 'Cash Flow Statement');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(primaryRows), 'Opposite Primary Summary');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(monthRows), 'Monthly Trend');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(cashPositionRows), 'Cash Position');

      XLSX.writeFile(workbook, `Cash_Flow_Analysis_${new Date().toISOString().slice(0, 10)}.xlsx`, {
        compression: true,
      });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export Cash Flow analysis. Please retry.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div
          className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between cursor-pointer"
          onClick={() => setIsSelectionExpanded((prev) => !prev)}
        >
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg text-white shadow-sm">
              <Wallet size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Step 1: Configure Cash/Bank Ledger Pool</h2>
              <p className="text-xs text-slate-500">Auto-detected from TallyPrimary containing "bank" or "cash". Add cash-equivalent ledgers manually.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold bg-blue-100 text-blue-700 px-3 py-1 rounded-full">
              {selectedCashLedgers.length} selected
            </span>
            {isSelectionExpanded ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
          </div>
        </div>

        {isSelectionExpanded && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-1 lg:grid-cols-6 gap-3">
              <div className="relative lg:col-span-3">
                <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
                <input
                  value={cashLedgerSearch}
                  onChange={(e) => setCashLedgerSearch(e.target.value)}
                  placeholder="Search ledgers / primary / parent"
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <button
                onClick={applyAutoCashLedgers}
                className="px-3 py-2 rounded-lg text-sm font-semibold border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
              >
                Apply Auto Selection
              </button>
              <button
                onClick={clearCashLedgers}
                className="px-3 py-2 rounded-lg text-sm font-semibold border border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
              >
                Clear
              </button>
              <div className="text-xs text-slate-500 self-center lg:text-right">
                Auto detected: {autoCashLedgers.length}
              </div>
            </div>

            <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg p-2 bg-slate-50">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                {filteredCashLedgers.map((ledger) => {
                  const isSelected = selectedCashLedgers.includes(ledger);
                  const meta = ledgerMetaMap.get(ledger);
                  const bank = bankAttrsByLedger.get(ledger);
                  return (
                    <div
                      key={ledger}
                      onClick={() => toggleCashLedger(ledger)}
                      className={`p-2 rounded-md border cursor-pointer ${isSelected ? 'bg-blue-50 border-blue-300' : 'bg-white border-slate-200'}`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>
                          {isSelected && <CheckSquare size={12} className="text-white" />}
                        </div>
                        <p className={`text-sm truncate ${isSelected ? 'font-semibold text-blue-900' : 'text-slate-700'}`} title={ledger}>
                          {ledger}
                        </p>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1 truncate" title={`${meta?.primary || '-'} | ${meta?.parent || '-'}`}>
                        {meta?.primary || '-'} | {meta?.parent || '-'}
                      </p>
                      {bank && (bank.accountNumber || bank.ifsc || bank.bankName) && (
                        <p className="text-[10px] text-slate-500 mt-1 truncate font-mono"
                           title={[bank.bankName, bank.branch, bank.accountNumber, bank.ifsc].filter(Boolean).join(' · ')}>
                          {bank.bankName || 'Bank'}
                          {bank.accountNumber && ` · A/C ${bank.accountNumber}`}
                          {bank.ifsc && ` · ${bank.ifsc}`}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {selectedCashLedgers.length === 0 ? (
        <div className="bg-slate-100 border-2 border-dashed border-slate-300 rounded-xl p-16 text-center text-slate-500">
          Select at least one cash/bank ledger to run cash flow analysis.
        </div>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-3">
              <div className="xl:col-span-2">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <div className="xl:col-span-2">
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <div className="relative xl:col-span-3">
                <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  value={mainSearch}
                  onChange={(e) => setMainSearch(e.target.value)}
                  placeholder="Search voucher / opposite ledger / party"
                  className="w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <div className="xl:col-span-2">
                <select
                  value={directionFilter}
                  onChange={(e) => setDirectionFilter(e.target.value as 'all' | 'inflow' | 'outflow')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                >
                  <option value="all">All Directions</option>
                  <option value="inflow">Only Inflow</option>
                  <option value="outflow">Only Outflow</option>
                </select>
              </div>
              <div className="xl:col-span-1">
                <input
                  type="number"
                  value={minAmount}
                  onChange={(e) => setMinAmount(e.target.value)}
                  placeholder="Min"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <button
                onClick={exportExcel}
                className="xl:col-span-2 px-4 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2"
              >
                <Download size={15} />
                Export Excel
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Opening Cash</p>
              <p className={`text-lg font-black mt-1 ${flowModel.cashPosition.opening < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                {formatAmount(flowModel.cashPosition.opening)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Closing Cash</p>
              <p className={`text-lg font-black mt-1 ${flowModel.cashPosition.closing < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                {formatAmount(flowModel.cashPosition.closing)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Total Inflow</p>
              <p className="text-lg font-black text-emerald-700 mt-1">{formatAmount(summary.inflow)}</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Total Outflow</p>
              <p className="text-lg font-black text-rose-700 mt-1">{formatAmount(summary.outflow)}</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Net Cash Generated</p>
              <p className={`text-lg font-black mt-1 ${summary.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {formatAmount(summary.net)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Blocked Capital Outflow</p>
              <p className="text-lg font-black text-amber-700 mt-1">{formatAmount(summary.blockedCapitalOutflow)}</p>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <h3 className="font-bold text-slate-800 text-sm">Cash Flow Statement (Direct Method)</h3>
              <p className="text-xs text-slate-500 mt-1">Based on selected cash-ledger pool and period.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[980px] w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-bold">Line Item</th>
                    <th className="px-4 py-3 text-right font-bold">Inflow</th>
                    <th className="px-4 py-3 text-right font-bold">Outflow</th>
                    <th className="px-4 py-3 text-right font-bold">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(['Operating', 'Investing', 'Financing'] as CashFlowActivity[]).map((activity) => (
                    <React.Fragment key={activity}>
                      <tr className="bg-slate-100/70">
                        <td className="px-4 py-3 font-bold text-slate-800">{activity} Activities</td>
                        <td className="px-4 py-3 text-right">-</td>
                        <td className="px-4 py-3 text-right">-</td>
                        <td className="px-4 py-3 text-right">-</td>
                      </tr>
                      {cashFlowStatement.buckets
                        .filter((bucket) => bucket.activity === activity)
                        .map((bucket) => (
                          <tr key={`${activity}-${bucket.bucket}`} className="hover:bg-slate-50">
                            <td className="px-4 py-3 text-slate-700">{bucket.bucket}</td>
                            <td className="px-4 py-3 text-right font-mono text-emerald-700">{bucket.inflow ? formatAmount(bucket.inflow) : '-'}</td>
                            <td className="px-4 py-3 text-right font-mono text-rose-700">{bucket.outflow ? formatAmount(bucket.outflow) : '-'}</td>
                            <td className={`px-4 py-3 text-right font-mono font-semibold ${bucket.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                              {formatAmount(bucket.net)}
                            </td>
                          </tr>
                        ))}
                      <tr className="bg-blue-50/60">
                        <td className="px-4 py-3 font-semibold text-slate-800">Net Cash From {activity} Activities</td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-700">
                          {formatAmount(cashFlowStatement.byActivity[activity].inflow)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-rose-700">
                          {formatAmount(cashFlowStatement.byActivity[activity].outflow)}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${cashFlowStatement.byActivity[activity].net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {formatAmount(cashFlowStatement.byActivity[activity].net)}
                        </td>
                      </tr>
                    </React.Fragment>
                  ))}

                  <tr className="bg-amber-50/70">
                    <td className="px-4 py-3 font-semibold text-slate-800">Unclassified/Contra Adjustment</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className={`px-4 py-3 text-right font-mono font-semibold ${cashFlowStatement.adjustmentNet >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {formatAmount(cashFlowStatement.adjustmentNet)}
                    </td>
                  </tr>
                  <tr className="bg-slate-100">
                    <td className="px-4 py-3 font-bold text-slate-900">Net Increase/(Decrease) in Cash</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className={`px-4 py-3 text-right font-mono font-bold ${cashFlowStatement.movement >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {formatAmount(cashFlowStatement.movement)}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-slate-700">Opening Cash & Cash Equivalents</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className="px-4 py-3 text-right font-mono">{formatAmount(cashFlowStatement.opening)}</td>
                  </tr>
                  <tr className="bg-green-50/70">
                    <td className="px-4 py-3 font-bold text-slate-900">Closing Cash & Cash Equivalents</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className="px-4 py-3 text-right">-</td>
                    <td className={`px-4 py-3 text-right font-mono font-bold ${cashFlowStatement.closing >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {formatAmount(cashFlowStatement.closing)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-3">Monthly Inflow vs Outflow</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={flowModel.monthlySeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="monthLabel" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={(v) => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11 }} />
                    <RechartsTooltip formatter={(value: any) => formatAmount(Number(value || 0))} />
                    <Legend />
                    <Bar dataKey="inflow" fill="#059669" name="Inflow" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="outflow" fill="#dc2626" name="Outflow" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-3">Top Outflow Primaries (Where Capital Is Used)</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topOutflowPrimaries} layout="vertical" margin={{ left: 20, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tickFormatter={(v) => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="label" width={160} tick={{ fontSize: 11 }} />
                    <RechartsTooltip formatter={(value: any) => formatAmount(Number(value || 0))} />
                    <Bar dataKey="outflow" fill="#b91c1c" name="Outflow" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-3">Top Inflow Primaries (Where Funds Are Generated)</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topInflowPrimaries} layout="vertical" margin={{ left: 20, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tickFormatter={(v) => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="label" width={160} tick={{ fontSize: 11 }} />
                    <RechartsTooltip formatter={(value: any) => formatAmount(Number(value || 0))} />
                    <Bar dataKey="inflow" fill="#15803d" name="Inflow" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-3">Cash Position Reconciliation</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">Period Opening Cash</span>
                  <span className="font-mono font-semibold text-slate-800">{formatAmount(flowModel.cashPosition.opening)}</span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">Period Cash Movement</span>
                  <span className={`font-mono font-semibold ${flowModel.cashPosition.periodMovement >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {formatAmount(flowModel.cashPosition.periodMovement)}
                  </span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">Computed Closing Cash</span>
                  <span className="font-mono font-semibold text-slate-800">{formatAmount(flowModel.cashPosition.closing)}</span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">Reference Closing (from ledgers)</span>
                  <span className="font-mono font-semibold text-slate-800">
                    {flowModel.cashPosition.referenceClosing === null ? 'N/A' : formatAmount(flowModel.cashPosition.referenceClosing)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Reconciliation Diff</span>
                  <span className={`font-mono font-semibold ${flowModel.cashPosition.reconciliationDiff && Math.abs(flowModel.cashPosition.reconciliationDiff) > 0.01 ? 'text-rose-700' : 'text-emerald-700'}`}>
                    {flowModel.cashPosition.reconciliationDiff === null ? 'N/A' : formatAmount(flowModel.cashPosition.reconciliationDiff)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-3">Top Opposite Ledgers (Ledger-Level Flow)</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topOppositeLedgerFlows} layout="vertical" margin={{ left: 20, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tickFormatter={(v) => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 11 }} />
                    <RechartsTooltip formatter={(value: any) => formatAmount(Number(value || 0))} />
                    <Legend />
                    <Bar dataKey="inflow" fill="#15803d" name="Inflow" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="outflow" fill="#b91c1c" name="Outflow" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
                <h3 className="font-bold text-slate-800 text-sm">Cash Ledger Movement (Selected Pool)</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-[900px] w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 text-left font-bold">Cash Ledger</th>
                      <th className="px-4 py-3 text-right font-bold">Opening</th>
                      <th className="px-4 py-3 text-right font-bold">Inflow</th>
                      <th className="px-4 py-3 text-right font-bold">Outflow</th>
                      <th className="px-4 py-3 text-right font-bold">Net Movement</th>
                      <th className="px-4 py-3 text-right font-bold">Closing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {cashLedgerDetail.map((row) => (
                      <tr key={row.ledger} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-800">{row.ledger}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatAmount(row.opening)}</td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-700">{row.inflow ? formatAmount(row.inflow) : '-'}</td>
                        <td className="px-4 py-3 text-right font-mono text-rose-700">{row.outflow ? formatAmount(row.outflow) : '-'}</td>
                        <td className={`px-4 py-3 text-right font-mono font-semibold ${row.netMovement >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {formatAmount(row.netMovement)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">{formatAmount(row.closing)}</td>
                      </tr>
                    ))}
                    {cashLedgerDetail.length === 0 && (
                      <tr>
                        <td className="p-8 text-center text-slate-500" colSpan={6}>
                          No cash ledger movement rows available.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-slate-800 text-sm">Ledger-Level Fund Flow Detail (Filtered)</h3>
              <p className="text-xs text-slate-500">
                Vouchers covered: {summary.voucherCount} | Ledger rows: {ledgerDetailRows.length}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1200px] w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-bold">Opposite Ledger</th>
                    <th className="px-4 py-3 text-left font-bold">Activity</th>
                    <th className="px-4 py-3 text-left font-bold">Rule</th>
                    <th className="px-4 py-3 text-left font-bold">Primary</th>
                    <th className="px-4 py-3 text-left font-bold">Parent</th>
                    <th className="px-4 py-3 text-right font-bold">Inflow</th>
                    <th className="px-4 py-3 text-right font-bold">Outflow</th>
                    <th className="px-4 py-3 text-right font-bold">Net</th>
                    <th className="px-4 py-3 text-right font-bold">Inflow Share</th>
                    <th className="px-4 py-3 text-right font-bold">Outflow Share</th>
                    <th className="px-4 py-3 text-right font-bold">Vouchers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledgerDetailRows.map((row) => (
                    <tr key={row.key} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800">{row.label}</td>
                      <td className="px-4 py-3 text-slate-700">{row.activity}</td>
                      <td className="px-4 py-3 text-slate-600 font-mono text-[11px]">{row.classificationRule}</td>
                      <td className="px-4 py-3 text-slate-600 max-w-[220px] truncate" title={row.primary}>
                        {row.primary}
                      </td>
                      <td className="px-4 py-3 text-slate-600 max-w-[220px] truncate" title={row.parent}>
                        {row.parent}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-700">{row.inflow ? formatAmount(row.inflow) : '-'}</td>
                      <td className="px-4 py-3 text-right font-mono text-rose-700">{row.outflow ? formatAmount(row.outflow) : '-'}</td>
                      <td className={`px-4 py-3 text-right font-mono font-semibold ${row.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {formatAmount(row.net)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{row.inflowShare.toFixed(2)}%</td>
                      <td className="px-4 py-3 text-right font-mono">{row.outflowShare.toFixed(2)}%</td>
                      <td className="px-4 py-3 text-right font-semibold">{row.vouchers}</td>
                    </tr>
                  ))}
                  {ledgerDetailRows.length === 0 && (
                    <tr>
                      <td className="p-10 text-center text-slate-500" colSpan={11}>
                        No ledger-level rows found for current period and filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default CashFlowAnalysis;
