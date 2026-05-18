import React, { useMemo, useState } from 'react';
import { Download, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { LedgerEntry } from '../../types';
import { useTallyStore } from '../../services/tally';

type LedgerClass = 'Asset' | 'Liability' | 'Balance Sheet' | 'P&L' | 'Unknown';
type Severity = 'High' | 'Medium' | 'Low';

type IssueTypeId =
  | 'RECON_GAP'
  | 'STALE_BALANCE'
  | 'SIGN_FLIP'
  | 'ONE_SIDED_MOVEMENT'
  | 'NATURAL_SIGN_BREACH'
  | 'NO_RECENT_MOVEMENT';

interface LedgerIssue {
  issueType: IssueTypeId;
  issueLabel: string;
  severity: Severity;
  details: string;
}

interface LedgerSnapshot {
  ledger: string;
  primary: string;
  parent: string;
  ledgerClass: LedgerClass;
  opening: number;
  duringDr: number;
  duringCr: number;
  movementNet: number;
  expectedClosing: number;
  closing: number;
  reconGap: number;
  movementAbs: number;
  txnCount: number;
  firstTxnDate: string;
  lastTxnDate: string;
  issues: LedgerIssue[];
  riskScore: number;
}

interface BalanceSheetCleanlinessAnalyticsProps {
  data: LedgerEntry[];
}

const ISSUE_LABELS: Record<IssueTypeId, string> = {
  RECON_GAP: 'Reconciliation Gap',
  STALE_BALANCE: 'Stale Balance',
  SIGN_FLIP: 'Sign Flip',
  ONE_SIDED_MOVEMENT: 'One-Sided Movement',
  NATURAL_SIGN_BREACH: 'Natural Sign Breach',
  NO_RECENT_MOVEMENT: 'No Recent Movement',
};

const ISSUE_ORDER: IssueTypeId[] = [
  'RECON_GAP',
  'NATURAL_SIGN_BREACH',
  'SIGN_FLIP',
  'STALE_BALANCE',
  'NO_RECENT_MOVEMENT',
  'ONE_SIDED_MOVEMENT',
];

const SEVERITY_WEIGHT: Record<Severity, number> = {
  High: 3,
  Medium: 2,
  Low: 1,
};

const ASSET_KEYWORDS = [
  'debtor',
  'debtors',
  'bank',
  'cash',
  'asset',
  'advance',
  'advances',
  'receivable',
  'deposit',
  'stock',
  'inventory',
  'input tax',
  'gst receivable',
  'loan and advances',
];

const LIABILITY_KEYWORDS = [
  'creditor',
  'creditors',
  'liabilit',
  'loan',
  'capital',
  'reserve',
  'provision',
  'payable',
  'output tax',
  'tax payable',
  'duties & taxes',
  'duties and taxes',
  'secured',
  'unsecured',
];

const BS_COMMON_KEYWORDS = [
  'sundry',
  'current asset',
  'current liabilities',
  'fixed asset',
  'branch/divisions',
  'branch divisions',
  'bank account',
  'cash-in-hand',
  'cash in hand',
];

const PNL_KEYWORDS = ['sale', 'sales', 'purchase', 'expense', 'income', 'revenue', 'cost', 'consumption'];

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatAmount = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const toDdMmYyyy = (value: string): string => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const safe = String(value).trim().split('T')[0];
  const iso = safe.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const dd = String(parsed.getDate()).padStart(2, '0');
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const yyyy = parsed.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

const dateSortValue = (value: string): number => {
  if (!value) return 0;
  const safe = String(value).trim().split('T')[0];
  const iso = safe.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return Number(`${iso[1]}${iso[2]}${iso[3]}`);

  const dmy = safe.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return Number(`${dmy[3]}${dmy[2]}${dmy[1]}`);

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 0;
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  return Number(`${yyyy}${mm}${dd}`);
};

const daysBetween = (fromDate: string, toDate: string) => {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  const delta = to.getTime() - from.getTime();
  return Math.floor(delta / (1000 * 60 * 60 * 24));
};

// Hint sourced from mst_group.is_revenue / is_deemedpositive when a ZIP
// store is available. When provided, it pre-empts the keyword scan with
// Tally's authoritative classification — is_revenue=true is unambiguously
// P&L, is_revenue=false with is_deemedpositive=true is an Asset (Dr side),
// is_revenue=false with is_deemedpositive=false is a Liability (Cr side).
interface StoreClassHint {
  isRevenue: boolean;
  isDeemedPositive: boolean;
}

const detectLedgerClass = (primary: string, parent: string, hint?: StoreClassHint): LedgerClass => {
  if (hint) {
    if (hint.isRevenue) return 'P&L';
    return hint.isDeemedPositive ? 'Asset' : 'Liability';
  }
  const combined = `${primary} ${parent}`.toLowerCase();

  if (ASSET_KEYWORDS.some((key) => combined.includes(key))) return 'Asset';
  if (LIABILITY_KEYWORDS.some((key) => combined.includes(key))) return 'Liability';
  if (BS_COMMON_KEYWORDS.some((key) => combined.includes(key))) return 'Balance Sheet';
  if (PNL_KEYWORDS.some((key) => combined.includes(key))) return 'P&L';
  return 'Unknown';
};

const severityBadgeClass = (severity: Severity) => {
  if (severity === 'High') return 'bg-rose-100 text-rose-700 border border-rose-200';
  if (severity === 'Medium') return 'bg-amber-100 text-amber-700 border border-amber-200';
  return 'bg-slate-100 text-slate-700 border border-slate-200';
};

const BalanceSheetCleanlinessAnalytics: React.FC<BalanceSheetCleanlinessAnalyticsProps> = ({ data }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [issueFilter, setIssueFilter] = useState<'all' | IssueTypeId>('all');
  const [onlyFlagged, setOnlyFlagged] = useState(true);

  // Per-ledger classification hints from mst_group via the store.
  const store = useTallyStore();
  const classHintByLedger = useMemo(() => {
    const map = new Map<string, StoreClassHint>();
    if (!store) return map;
    for (const l of store.ledgers.values()) {
      const g = store.group(l.parent);
      if (!g) continue;
      map.set(l.name.trim().toLowerCase(), {
        isRevenue: g.is_revenue,
        isDeemedPositive: g.is_deemedpositive,
      });
    }
    return map;
  }, [store]);

  const { ledgerSnapshots, issueRows, periodEndDate } = useMemo(() => {
    const ledgerMap = new Map<string, LedgerEntry[]>();

    data.forEach((row) => {
      const ledger = String(row.Ledger || '').trim();
      if (!ledger) return;
      if (!ledgerMap.has(ledger)) ledgerMap.set(ledger, []);
      ledgerMap.get(ledger)!.push(row);
    });

    let maxDate = '';

    data.forEach((row) => {
      const date = String(row.date || '').trim();
      if (!date) return;
      if (!maxDate || dateSortValue(date) > dateSortValue(maxDate)) maxDate = date;
    });

    const snapshots: LedgerSnapshot[] = [];

    ledgerMap.forEach((rows, ledger) => {
      const sample = rows[0];
      const primary = String(sample?.TallyPrimary || 'Unclassified').trim() || 'Unclassified';
      const parent = String(sample?.TallyParent || sample?.Group || 'Ungrouped').trim() || 'Ungrouped';
      const hint = classHintByLedger.get(ledger.trim().toLowerCase());
      const ledgerClass = detectLedgerClass(primary, parent, hint);

      let opening = 0;
      let closing = 0;
      let openingSet = false;
      let closingSet = false;

      let duringDr = 0;
      let duringCr = 0;
      let movementNet = 0;
      let txnCount = 0;
      let firstTxnDate = '';
      let lastTxnDate = '';

      rows.forEach((row) => {
        const openingValue = toNumber(row.opening_balance);
        const closingValue = toNumber(row.closing_balance);
        const isMaster = toNumber(row.is_master_ledger) > 0;

        if (isMaster) {
          opening = openingValue;
          closing = closingValue;
          openingSet = true;
          closingSet = true;
        } else {
          if (!openingSet && openingValue !== 0) {
            opening = openingValue;
            openingSet = true;
          }
          if (!closingSet && closingValue !== 0) {
            closing = closingValue;
            closingSet = true;
          }

          const amount = toNumber(row.amount);
          movementNet += amount;
          if (amount < 0) duringDr += Math.abs(amount);
          if (amount > 0) duringCr += amount;
          txnCount += 1;

          const entryDate = String(row.date || '').trim();
          if (entryDate) {
            if (!firstTxnDate || dateSortValue(entryDate) < dateSortValue(firstTxnDate)) firstTxnDate = entryDate;
            if (!lastTxnDate || dateSortValue(entryDate) > dateSortValue(lastTxnDate)) lastTxnDate = entryDate;
          }
        }
      });

      const movementAbs = duringDr + duringCr;
      const expectedClosing = opening + movementNet;
      const reconGap = closing - expectedClosing;

      const issues: LedgerIssue[] = [];

      if (Math.abs(reconGap) > 1) {
        const severity: Severity = Math.abs(reconGap) > 1000 ? 'High' : Math.abs(reconGap) > 100 ? 'Medium' : 'Low';
        issues.push({
          issueType: 'RECON_GAP',
          issueLabel: ISSUE_LABELS.RECON_GAP,
          severity,
          details: `Closing differs from opening + movement by ${formatAmount(reconGap)}.`,
        });
      }

      if (Math.abs(closing) >= 10000 && movementAbs < 1) {
        issues.push({
          issueType: 'STALE_BALANCE',
          issueLabel: ISSUE_LABELS.STALE_BALANCE,
          severity: 'Medium',
          details: 'Large closing balance exists with almost no period movement.',
        });
      }

      if (Math.abs(opening) > 1 && Math.abs(closing) > 1 && opening * closing < 0) {
        issues.push({
          issueType: 'SIGN_FLIP',
          issueLabel: ISSUE_LABELS.SIGN_FLIP,
          severity: 'Medium',
          details: 'Opening and closing balances have opposite signs.',
        });
      }

      if ((duringDr === 0 || duringCr === 0) && movementAbs >= 50000 && txnCount >= 3) {
        issues.push({
          issueType: 'ONE_SIDED_MOVEMENT',
          issueLabel: ISSUE_LABELS.ONE_SIDED_MOVEMENT,
          severity: 'Low',
          details: 'High movement posted only on one side (Dr or Cr) during period.',
        });
      }

      if (ledgerClass === 'Asset' && closing > 1) {
        issues.push({
          issueType: 'NATURAL_SIGN_BREACH',
          issueLabel: ISSUE_LABELS.NATURAL_SIGN_BREACH,
          severity: 'High',
          details: 'Asset ledger has credit (positive) closing balance.',
        });
      }

      if (ledgerClass === 'Liability' && closing < -1) {
        issues.push({
          issueType: 'NATURAL_SIGN_BREACH',
          issueLabel: ISSUE_LABELS.NATURAL_SIGN_BREACH,
          severity: 'High',
          details: 'Liability ledger has debit (negative) closing balance.',
        });
      }

      if (lastTxnDate && maxDate && daysBetween(lastTxnDate, maxDate) >= 120 && Math.abs(closing) >= 10000) {
        issues.push({
          issueType: 'NO_RECENT_MOVEMENT',
          issueLabel: ISSUE_LABELS.NO_RECENT_MOVEMENT,
          severity: 'Low',
          details: 'No movement for over 120 days despite significant balance.',
        });
      }

      const riskScore = issues.reduce((sum, issue) => sum + SEVERITY_WEIGHT[issue.severity], 0);

      const includeLedger =
        ledgerClass === 'Asset' ||
        ledgerClass === 'Liability' ||
        ledgerClass === 'Balance Sheet' ||
        (ledgerClass === 'Unknown' && (Math.abs(opening) > 0 || Math.abs(closing) > 0 || movementAbs > 0));

      if (!includeLedger) return;

      snapshots.push({
        ledger,
        primary,
        parent,
        ledgerClass,
        opening,
        duringDr,
        duringCr,
        movementNet,
        expectedClosing,
        closing,
        reconGap,
        movementAbs,
        txnCount,
        firstTxnDate,
        lastTxnDate,
        issues,
        riskScore,
      });
    });

    snapshots.sort((a, b) => {
      if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
      return Math.abs(b.closing) - Math.abs(a.closing);
    });

    const flatIssueRows = snapshots.flatMap((snapshot) =>
      snapshot.issues.map((issue) => ({
        ledger: snapshot.ledger,
        issueType: issue.issueType,
        issueLabel: issue.issueLabel,
        severity: issue.severity,
        details: issue.details,
        opening: snapshot.opening,
        closing: snapshot.closing,
        reconGap: snapshot.reconGap,
        lastTxnDate: snapshot.lastTxnDate,
      }))
    );

    return {
      ledgerSnapshots: snapshots,
      issueRows: flatIssueRows,
      periodEndDate: maxDate,
    };
  }, [data, classHintByLedger]);

  const visibleRows = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return ledgerSnapshots.filter((row) => {
      if (onlyFlagged && row.issues.length === 0) return false;
      if (issueFilter !== 'all' && !row.issues.some((issue) => issue.issueType === issueFilter)) return false;
      if (!query) return true;
      return (
        row.ledger.toLowerCase().includes(query) ||
        row.primary.toLowerCase().includes(query) ||
        row.parent.toLowerCase().includes(query)
      );
    });
  }, [ledgerSnapshots, searchTerm, issueFilter, onlyFlagged]);

  const summary = useMemo(() => {
    const flagged = ledgerSnapshots.filter((row) => row.issues.length > 0);
    const weightedPoints = issueRows.reduce((sum, issue) => sum + SEVERITY_WEIGHT[issue.severity], 0);
    const denominator = ledgerSnapshots.length === 0 ? 1 : ledgerSnapshots.length;
    const qualityScore = Math.max(0, Math.min(100, 100 - (weightedPoints / denominator) * 10));

    const issueDistribution = ISSUE_ORDER.map((issueType) => ({
      issueType,
      label: ISSUE_LABELS[issueType],
      count: issueRows.filter((issue) => issue.issueType === issueType).length,
    }));

    return {
      totalLedgers: ledgerSnapshots.length,
      flaggedLedgers: flagged.length,
      totalIssues: issueRows.length,
      totalReconGap: ledgerSnapshots.reduce((sum, row) => sum + Math.abs(row.reconGap), 0),
      qualityScore,
      issueDistribution,
    };
  }, [ledgerSnapshots, issueRows]);

  const handleExport = async () => {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();

      const summaryRows = [
        { Metric: 'Balance Sheet Ledgers', Value: summary.totalLedgers },
        { Metric: 'Ledgers with Issues', Value: summary.flaggedLedgers },
        { Metric: 'Total Issues', Value: summary.totalIssues },
        { Metric: 'Quality Score (0-100)', Value: Number(summary.qualityScore.toFixed(2)) },
        { Metric: 'Absolute Reconciliation Gap', Value: Number(summary.totalReconGap.toFixed(2)) },
        { Metric: 'Period End Date', Value: toDdMmYyyy(periodEndDate) || '-' },
      ];
      const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

      const issueDistributionRows = summary.issueDistribution.map((row) => ({
        'Issue Type': row.label,
        Count: row.count,
      }));
      const issueDistributionSheet = XLSX.utils.json_to_sheet(issueDistributionRows);
      XLSX.utils.book_append_sheet(workbook, issueDistributionSheet, 'Issue Distribution');

      const ledgerRows = ledgerSnapshots.map((row) => ({
        Ledger: row.ledger,
        Primary: row.primary,
        Parent: row.parent,
        Class: row.ledgerClass,
        Opening: Number(row.opening.toFixed(2)),
        'During Dr': Number(row.duringDr.toFixed(2)),
        'During Cr': Number(row.duringCr.toFixed(2)),
        'Movement Net': Number(row.movementNet.toFixed(2)),
        'Expected Closing': Number(row.expectedClosing.toFixed(2)),
        Closing: Number(row.closing.toFixed(2)),
        'Recon Gap': Number(row.reconGap.toFixed(2)),
        'Txn Count': row.txnCount,
        'Last Txn Date': toDdMmYyyy(row.lastTxnDate) || '-',
        'Issue Count': row.issues.length,
        Issues: row.issues.map((issue) => `${issue.issueLabel} (${issue.severity})`).join(' | ') || '-',
      }));
      const ledgerSheet = XLSX.utils.json_to_sheet(ledgerRows);
      XLSX.utils.book_append_sheet(workbook, ledgerSheet, 'Ledger Snapshot');

      const issueRowsExport = issueRows.map((row) => ({
        Ledger: row.ledger,
        'Issue Type': row.issueLabel,
        Severity: row.severity,
        Details: row.details,
        Opening: Number(row.opening.toFixed(2)),
        Closing: Number(row.closing.toFixed(2)),
        'Recon Gap': Number(row.reconGap.toFixed(2)),
        'Last Txn Date': toDdMmYyyy(row.lastTxnDate) || '-',
      }));
      const issueSheet = XLSX.utils.json_to_sheet(issueRowsExport);
      XLSX.utils.book_append_sheet(workbook, issueSheet, 'Issue Detail');

      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `Balance_Sheet_Cleanliness_${stamp}.xlsx`, { compression: true });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export Excel. Please retry.');
    }
  };

  if (ledgerSnapshots.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center text-slate-500">
        No balance sheet ledger data available for cleanliness analytics.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <ShieldCheck className="text-indigo-600" size={20} />
              Balance Sheet Cleanliness Analytics
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Ledger-level hygiene checks for reconciliation, sign logic, and stale balances.
            </p>
          </div>
          <button
            onClick={handleExport}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <Download size={16} />
            Export Excel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">BS Ledgers</p>
          <p className="text-2xl font-black text-slate-900 mt-1">{summary.totalLedgers.toLocaleString('en-IN')}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Flagged Ledgers</p>
          <p className="text-2xl font-black text-amber-700 mt-1">{summary.flaggedLedgers.toLocaleString('en-IN')}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total Issues</p>
          <p className="text-2xl font-black text-rose-700 mt-1">{summary.totalIssues.toLocaleString('en-IN')}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Quality Score</p>
          <p className="text-2xl font-black text-indigo-700 mt-1">{summary.qualityScore.toFixed(2)}</p>
          <p className="text-[11px] text-slate-500">Higher is cleaner</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Absolute Recon Gap</p>
          <p className="text-2xl font-black text-rose-700 mt-1">{formatAmount(summary.totalReconGap)}</p>
          <p className="text-[11px] text-slate-500">Period end: {toDdMmYyyy(periodEndDate) || '-'}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="text-sm font-bold text-slate-800 mb-3">Issue Distribution</h3>
        <div className="flex flex-wrap gap-2">
          {summary.issueDistribution.map((row) => (
            <span key={row.issueType} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
              {row.label}: {row.count.toLocaleString('en-IN')}
            </span>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-800">Ledger Cleanliness Register</h3>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search ledger / parent / primary"
                className="pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm w-full sm:w-72"
              />
            </div>
            <select
              value={issueFilter}
              onChange={(event) => setIssueFilter(event.target.value as 'all' | IssueTypeId)}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm"
            >
              <option value="all">All Issue Types</option>
              {ISSUE_ORDER.map((issueType) => (
                <option key={issueType} value={issueType}>
                  {ISSUE_LABELS[issueType]}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700">
              <input
                type="checkbox"
                checked={onlyFlagged}
                onChange={(event) => setOnlyFlagged(event.target.checked)}
              />
              Show only flagged
            </label>
          </div>
        </div>

        {visibleRows.length === 0 ? (
          <div className="border border-dashed border-slate-300 rounded-lg p-8 text-center text-slate-500">
            No ledgers match the active filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-600">
                  <th className="px-3 py-2 border border-slate-200 text-left">Ledger</th>
                  <th className="px-3 py-2 border border-slate-200 text-left">Class</th>
                  <th className="px-3 py-2 border border-slate-200 text-right">Opening</th>
                  <th className="px-3 py-2 border border-slate-200 text-right">During Dr</th>
                  <th className="px-3 py-2 border border-slate-200 text-right">During Cr</th>
                  <th className="px-3 py-2 border border-slate-200 text-right">Closing</th>
                  <th className="px-3 py-2 border border-slate-200 text-right">Recon Gap</th>
                  <th className="px-3 py-2 border border-slate-200 text-left">Last Txn</th>
                  <th className="px-3 py-2 border border-slate-200 text-left">Issues</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.ledger} className={row.riskScore >= 6 ? 'bg-rose-50/40' : 'odd:bg-white even:bg-slate-50/50'}>
                    <td className="px-3 py-2 border border-slate-200 align-top">
                      <p className="font-semibold text-slate-900">{row.ledger}</p>
                      <p className="text-xs text-slate-500">{row.primary} | {row.parent}</p>
                    </td>
                    <td className="px-3 py-2 border border-slate-200 align-top text-slate-700">{row.ledgerClass}</td>
                    <td className="px-3 py-2 border border-slate-200 align-top text-right font-mono">{formatAmount(row.opening)}</td>
                    <td className="px-3 py-2 border border-slate-200 align-top text-right font-mono text-rose-700">{formatAmount(row.duringDr)}</td>
                    <td className="px-3 py-2 border border-slate-200 align-top text-right font-mono text-emerald-700">{formatAmount(row.duringCr)}</td>
                    <td className="px-3 py-2 border border-slate-200 align-top text-right font-mono">{formatAmount(row.closing)}</td>
                    <td className="px-3 py-2 border border-slate-200 align-top text-right font-mono">
                      <span className={Math.abs(row.reconGap) > 1 ? 'text-rose-700 font-semibold' : 'text-slate-600'}>
                        {formatAmount(row.reconGap)}
                      </span>
                    </td>
                    <td className="px-3 py-2 border border-slate-200 align-top text-slate-700 whitespace-nowrap">
                      {toDdMmYyyy(row.lastTxnDate) || '-'}
                    </td>
                    <td className="px-3 py-2 border border-slate-200 align-top">
                      {row.issues.length === 0 ? (
                        <span className="text-xs text-emerald-700 font-semibold">Clean</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5 max-w-[420px]">
                          {row.issues.map((issue, index) => (
                            <span
                              key={`${row.ledger}_${issue.issueType}_${index}`}
                              title={issue.details}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${severityBadgeClass(issue.severity)}`}
                            >
                              {issue.severity === 'High' && <TriangleAlert size={11} />}
                              {issue.issueLabel}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default BalanceSheetCleanlinessAnalytics;
