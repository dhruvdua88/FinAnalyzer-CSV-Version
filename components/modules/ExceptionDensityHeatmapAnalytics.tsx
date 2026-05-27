import React, { useMemo, useState } from 'react';
import { AlertTriangle, Download, Filter, Search, ShieldAlert } from 'lucide-react';
import { LedgerEntry } from '../../types';
import { useTallyStore, voucherFamilyKey } from '../../services/tally';

type Severity = 'High' | 'Medium' | 'Low';

type ExceptionTypeId =
  | 'UNBALANCED_VOUCHER'
  | 'SINGLE_SIDED_VOUCHER'
  | 'MISSING_PARTY_NAME'
  | 'MISSING_INVOICE_NUMBER'
  | 'GST_WITHOUT_GSTIN'
  | 'ROUND_OFF_SPIKE'
  | 'DUPLICATE_INVOICE';

interface ExceptionTypeConfig {
  id: ExceptionTypeId;
  label: string;
  severity: Severity;
  description: string;
}

interface VoucherProfile {
  voucherKey: string;
  voucherNumber: string;
  voucherType: string;
  date: string;
  monthKey: string;
  totalDr: number;
  totalCr: number;
  netAmount: number;
  partyName: string;
  invoiceNumber: string;
  gstin: string;
  hasGstLedger: boolean;
  hasLargeRoundOff: boolean;
  entryCount: number;
}

interface ExceptionRecord {
  id: string;
  voucherKey: string;
  voucherNumber: string;
  voucherType: string;
  date: string;
  monthKey: string;
  exceptionType: ExceptionTypeId;
  exceptionLabel: string;
  severity: Severity;
  reason: string;
  partyName: string;
  invoiceNumber: string;
  netAmount: number;
  entryCount: number;
}

interface ExceptionDensityHeatmapAnalyticsProps {
  data: LedgerEntry[];
}

const EXCEPTION_TYPES: ExceptionTypeConfig[] = [
  {
    id: 'UNBALANCED_VOUCHER',
    label: 'Unbalanced Voucher',
    severity: 'High',
    description: 'Debit and credit totals do not net to zero.',
  },
  {
    id: 'SINGLE_SIDED_VOUCHER',
    label: 'Single-Sided Voucher',
    severity: 'High',
    description: 'Voucher has only debit or only credit lines.',
  },
  {
    id: 'GST_WITHOUT_GSTIN',
    label: 'GST Without GSTIN',
    severity: 'High',
    description: 'Tax line exists but GSTIN is missing.',
  },
  {
    id: 'MISSING_PARTY_NAME',
    label: 'Missing Party Name',
    severity: 'Medium',
    description: 'Sales/purchase style voucher has blank party.',
  },
  {
    id: 'MISSING_INVOICE_NUMBER',
    label: 'Missing Invoice Number',
    severity: 'Medium',
    description: 'Sales/purchase style voucher has blank invoice.',
  },
  {
    id: 'DUPLICATE_INVOICE',
    label: 'Duplicate Invoice',
    severity: 'Medium',
    description: 'Same invoice repeats for same party in same month.',
  },
  {
    id: 'ROUND_OFF_SPIKE',
    label: 'Round-Off Spike',
    severity: 'Low',
    description: 'Round-off line exceeds expected small value.',
  },
];

const SEVERITY_WEIGHT: Record<Severity, number> = {
  High: 3,
  Medium: 2,
  Low: 1,
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatAmount = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const toDdMmYyyy = (value: string): string => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const iso = String(value).trim().split('T')[0];
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const dd = String(parsed.getDate()).padStart(2, '0');
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const yyyy = parsed.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

const toMonthKey = (value: string): string => {
  if (!value) return 'Unknown';
  const iso = String(value).trim().split('T')[0];
  let year = '';
  let month = '';

  const isoMatch = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    year = isoMatch[1];
    month = isoMatch[2];
    return `${month}/${year}`;
  }

  const dmyMatch = iso.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmyMatch) {
    year = dmyMatch[3];
    month = dmyMatch[2];
    return `${month}/${year}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return `${String(parsed.getMonth() + 1).padStart(2, '0')}/${parsed.getFullYear()}`;
};

const monthSortValue = (monthKey: string) => {
  const [mm, yyyy] = monthKey.split('/').map(Number);
  if (!mm || !yyyy) return 0;
  return yyyy * 100 + mm;
};

const isSyntheticUnknownVoucher = (voucherNumber: string) => /^unknown(?:-\d+)?$/i.test(String(voucherNumber || '').trim());

const getVoucherIdentity = (entry: LedgerEntry) => {
  const voucherNumber = String(entry.voucher_number || entry.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN';
  const date = String(entry.date || '').trim();
  const voucherType = String(entry.voucher_type || '').trim() || 'Unknown Type';
  const guidFamily = voucherFamilyKey(entry.guid);
  const voucherFamily = isSyntheticUnknownVoucher(voucherNumber) && guidFamily ? `UNKNOWN_GUID::${guidFamily}` : voucherNumber;
  return {
    voucherNumber,
    date,
    voucherType,
    voucherKey: `${voucherFamily}||${date}||${voucherType}`,
  };
};

const isSalesPurchaseLikeVoucher = (voucherType: string) => {
  const text = voucherType.toLowerCase();
  return (
    text.includes('sale') ||
    text.includes('purchase') ||
    text.includes('credit note') ||
    text.includes('debit note') ||
    text.includes('sales return') ||
    text.includes('purchase return')
  );
};

const isGstLine = (entry: LedgerEntry) => {
  const text = `${entry.Ledger || ''} ${entry.TallyPrimary || ''} ${entry.TallyParent || ''}`.toLowerCase();
  return (
    text.includes('gst') ||
    text.includes('igst') ||
    text.includes('cgst') ||
    text.includes('sgst') ||
    text.includes('utgst') ||
    text.includes('tax')
  );
};

const isLargeRoundOffLine = (entry: LedgerEntry) => {
  const text = `${entry.Ledger || ''} ${entry.TallyPrimary || ''} ${entry.TallyParent || ''}`.toLowerCase();
  return text.includes('round off') && Math.abs(toNumber(entry.amount)) > 100;
};

const ExceptionDensityHeatmapAnalytics: React.FC<ExceptionDensityHeatmapAnalyticsProps> = ({ data }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [exceptionTypeFilter, setExceptionTypeFilter] = useState<'all' | ExceptionTypeId>('all');
  const [monthFilter, setMonthFilter] = useState<string>('all');

  // mst_ledger GSTIN by party — used to upgrade the GST_WITHOUT_GSTIN
  // exception reason when the master *does* have a GSTIN on file but the
  // voucher booking didn't carry it through. That subtle "master OK,
  // voucher dropped it" pattern is what auditors actually want to fix
  // (the master GSTIN can be propagated into all future bookings).
  const store = useTallyStore();
  const partyGstinByName = useMemo(() => {
    const map = new Map<string, string>();
    if (!store) return map;
    for (const l of store.ledgers.values()) {
      const g = (l.gstn || '').trim();
      if (g) map.set(l.name.trim().toLowerCase(), g);
    }
    return map;
  }, [store]);

  const { vouchers, exceptions, months, matrix, maxCellCount } = useMemo(() => {
    const voucherMap = new Map<string, LedgerEntry[]>();

    data.forEach((entry) => {
      const identity = getVoucherIdentity(entry);
      const voucherKey = identity.voucherKey;
      if (!voucherMap.has(voucherKey)) voucherMap.set(voucherKey, []);
      voucherMap.get(voucherKey)!.push(entry);
    });

    const voucherProfiles: VoucherProfile[] = [];

    voucherMap.forEach((entries, voucherKey) => {
      const sample = entries[0];
      const identity = getVoucherIdentity(sample || ({} as LedgerEntry));
      const date = identity.date;
      const voucherType = identity.voucherType || 'Unknown Type';
      let voucherNumber = identity.voucherNumber || 'Unknown Voucher';

      let totalDr = 0;
      let totalCr = 0;
      let netAmount = 0;

      const partyName =
        entries
          .map((row) => String(row.party_name || '').trim())
          .find((name) => name.length > 0) || '';

      const invoiceNumber =
        entries
          .map((row) => String(row.invoice_number || '').trim())
          .find((invoice) => invoice.length > 0) || '';

      const gstin =
        entries
          .map((row) => String(row.gstin || '').trim())
          .find((value) => value.length > 0) || '';

      let hasGstLedger = false;
      let hasLargeRoundOff = false;

      entries.forEach((row) => {
        const rowIdentity = getVoucherIdentity(row);
        if (
          isSyntheticUnknownVoucher(voucherNumber) &&
          rowIdentity.voucherNumber &&
          (!isSyntheticUnknownVoucher(rowIdentity.voucherNumber) ||
            rowIdentity.voucherNumber.localeCompare(voucherNumber) < 0)
        ) {
          voucherNumber = rowIdentity.voucherNumber;
        }
        const amount = toNumber(row.amount);
        netAmount += amount;
        if (amount < 0) totalDr += Math.abs(amount);
        if (amount > 0) totalCr += amount;

        if (isGstLine(row)) hasGstLedger = true;
        if (isLargeRoundOffLine(row)) hasLargeRoundOff = true;
      });

      voucherProfiles.push({
        voucherKey,
        voucherNumber,
        voucherType,
        date,
        monthKey: toMonthKey(date),
        totalDr,
        totalCr,
        netAmount,
        partyName,
        invoiceNumber,
        gstin,
        hasGstLedger,
        hasLargeRoundOff,
        entryCount: entries.length,
      });
    });

    const invoiceKeyMap = new Map<string, VoucherProfile[]>();

    voucherProfiles.forEach((voucher) => {
      if (!voucher.invoiceNumber) return;
      const party = voucher.partyName || 'UNKNOWN_PARTY';
      const key = `${voucher.monthKey}||${party.toLowerCase()}||${voucher.invoiceNumber.toLowerCase()}`;
      if (!invoiceKeyMap.has(key)) invoiceKeyMap.set(key, []);
      invoiceKeyMap.get(key)!.push(voucher);
    });

    const duplicateVoucherKeySet = new Set<string>();
    invoiceKeyMap.forEach((bucket) => {
      if (bucket.length <= 1) return;
      bucket.forEach((voucher) => duplicateVoucherKeySet.add(voucher.voucherKey));
    });

    const computedExceptions: ExceptionRecord[] = [];

    const pushException = (
      voucher: VoucherProfile,
      type: ExceptionTypeId,
      reason: string,
      severityOverride?: Severity
    ) => {
      const config = EXCEPTION_TYPES.find((item) => item.id === type);
      if (!config) return;
      const severity = severityOverride || config.severity;
      computedExceptions.push({
        id: `${voucher.voucherKey}||${type}`,
        voucherKey: voucher.voucherKey,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        date: voucher.date,
        monthKey: voucher.monthKey,
        exceptionType: type,
        exceptionLabel: config.label,
        severity,
        reason,
        partyName: voucher.partyName,
        invoiceNumber: voucher.invoiceNumber,
        netAmount: voucher.netAmount,
        entryCount: voucher.entryCount,
      });
    };

    voucherProfiles.forEach((voucher) => {
      const imbalance = Math.abs(voucher.netAmount);
      const salesPurchaseLike = isSalesPurchaseLikeVoucher(voucher.voucherType);

      if (imbalance > 1) {
        pushException(
          voucher,
          'UNBALANCED_VOUCHER',
          `Voucher net is ${formatAmount(voucher.netAmount)} instead of 0.00.`,
          imbalance > 10 ? 'High' : 'Medium'
        );
      }

      if ((voucher.totalDr === 0 || voucher.totalCr === 0) && voucher.totalDr + voucher.totalCr > 0) {
        pushException(voucher, 'SINGLE_SIDED_VOUCHER', 'Voucher has only debit or only credit postings.');
      }

      if (salesPurchaseLike && !voucher.partyName) {
        pushException(voucher, 'MISSING_PARTY_NAME', 'Sales/purchase style voucher has blank party name.');
      }

      if (salesPurchaseLike && !voucher.invoiceNumber) {
        pushException(voucher, 'MISSING_INVOICE_NUMBER', 'Sales/purchase style voucher has blank invoice number.');
      }

      if (voucher.hasGstLedger && !voucher.gstin) {
        const masterGstin = partyGstinByName.get((voucher.partyName || '').trim().toLowerCase());
        const reason = masterGstin
          ? `GST ledger present but voucher GSTIN is blank. Master has GSTIN ${masterGstin} — update voucher to carry it.`
          : 'GST ledger present but GSTIN is blank.';
        pushException(voucher, 'GST_WITHOUT_GSTIN', reason);
      }

      if (voucher.hasLargeRoundOff) {
        pushException(voucher, 'ROUND_OFF_SPIKE', 'Round-off line exceeds INR 100, review classification.');
      }

      if (duplicateVoucherKeySet.has(voucher.voucherKey)) {
        pushException(voucher, 'DUPLICATE_INVOICE', 'Invoice repeats for same party in same month.');
      }
    });

    const monthSet = new Set<string>();
    const monthTypeMatrix = new Map<string, Map<ExceptionTypeId, number>>();

    computedExceptions.forEach((row) => {
      monthSet.add(row.monthKey);
      if (!monthTypeMatrix.has(row.monthKey)) monthTypeMatrix.set(row.monthKey, new Map());
      const bucket = monthTypeMatrix.get(row.monthKey)!;
      bucket.set(row.exceptionType, (bucket.get(row.exceptionType) || 0) + 1);
    });

    const sortedMonths = Array.from(monthSet).sort((a, b) => monthSortValue(a) - monthSortValue(b));

    let maxCount = 0;
    monthTypeMatrix.forEach((byType) => {
      byType.forEach((count) => {
        if (count > maxCount) maxCount = count;
      });
    });

    return {
      vouchers: voucherProfiles,
      exceptions: computedExceptions,
      months: sortedMonths,
      matrix: monthTypeMatrix,
      maxCellCount: maxCount,
    };
  }, [data, partyGstinByName]);

  const filteredExceptions = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return exceptions
      .filter((row) => {
        if (severityFilter !== 'all' && row.severity !== severityFilter) return false;
        if (exceptionTypeFilter !== 'all' && row.exceptionType !== exceptionTypeFilter) return false;
        if (monthFilter !== 'all' && row.monthKey !== monthFilter) return false;
        if (!query) return true;
        return (
          row.voucherNumber.toLowerCase().includes(query) ||
          row.voucherType.toLowerCase().includes(query) ||
          row.partyName.toLowerCase().includes(query) ||
          row.invoiceNumber.toLowerCase().includes(query) ||
          row.reason.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        const severityDelta = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
        if (severityDelta !== 0) return severityDelta;
        return Math.abs(b.netAmount) - Math.abs(a.netAmount);
      });
  }, [exceptions, searchTerm, severityFilter, exceptionTypeFilter, monthFilter]);

  const summary = useMemo(() => {
    const uniqueVoucherWithExceptions = new Set(exceptions.map((row) => row.voucherKey));
    const weightedPoints = exceptions.reduce((sum, row) => sum + SEVERITY_WEIGHT[row.severity], 0);
    const density = vouchers.length === 0 ? 0 : (weightedPoints / vouchers.length) * 100;

    return {
      vouchersScanned: vouchers.length,
      vouchersFlagged: uniqueVoucherWithExceptions.size,
      totalExceptions: exceptions.length,
      highSeverityCount: exceptions.filter((item) => item.severity === 'High').length,
      weightedDensity: density,
    };
  }, [exceptions, vouchers]);

  const byExceptionType = useMemo(() => {
    const map = new Map<ExceptionTypeId, number>();
    exceptions.forEach((row) => map.set(row.exceptionType, (map.get(row.exceptionType) || 0) + 1));
    return EXCEPTION_TYPES.map((type) => ({ ...type, count: map.get(type.id) || 0 }));
  }, [exceptions]);

  const handleExport = async () => {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();

      const summaryRows = [
        { Metric: 'Vouchers Scanned', Value: summary.vouchersScanned },
        { Metric: 'Vouchers Flagged', Value: summary.vouchersFlagged },
        { Metric: 'Total Exceptions', Value: summary.totalExceptions },
        { Metric: 'High Severity Exceptions', Value: summary.highSeverityCount },
        { Metric: 'Weighted Density (per 100 vouchers)', Value: Number(summary.weightedDensity.toFixed(2)) },
      ];
      const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

      const heatmapAoA: Array<Array<string | number>> = [
        ['Month', ...EXCEPTION_TYPES.map((type) => type.label)],
      ];
      months.forEach((month) => {
        const row: Array<string | number> = [month];
        EXCEPTION_TYPES.forEach((type) => {
          row.push(matrix.get(month)?.get(type.id) || 0);
        });
        heatmapAoA.push(row);
      });
      const heatmapSheet = XLSX.utils.aoa_to_sheet(heatmapAoA);
      XLSX.utils.book_append_sheet(workbook, heatmapSheet, 'Heatmap');

      const detailRows = filteredExceptions.map((row) => ({
        Date: toDdMmYyyy(row.date),
        Month: row.monthKey,
        'Voucher No': row.voucherNumber,
        'Voucher Type': row.voucherType,
        'Exception Type': row.exceptionLabel,
        Severity: row.severity,
        Reason: row.reason,
        Party: row.partyName || '-',
        'Invoice No': row.invoiceNumber || '-',
        'Net Amount': Number(row.netAmount.toFixed(2)),
        'Entry Count': row.entryCount,
      }));
      const detailSheet = XLSX.utils.json_to_sheet(detailRows);
      XLSX.utils.book_append_sheet(workbook, detailSheet, 'Exceptions');

      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `Exception_Density_Heatmap_${stamp}.xlsx`, { compression: true });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export Excel. Please retry.');
    }
  };

  const getSeverityBadgeClass = (severity: Severity) => {
    if (severity === 'High') return 'bg-rose-100 text-rose-700 border border-rose-200';
    if (severity === 'Medium') return 'bg-amber-100 text-amber-700 border border-amber-200';
    return 'bg-slate-100 text-slate-700 border border-slate-200';
  };

  const isEmpty = vouchers.length === 0;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <ShieldAlert className="text-rose-600" size={20} />
              Exception Density Heatmap Analytics
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Month-wise exception concentration across voucher quality checks.
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

      {isEmpty ? (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center text-slate-500">
          No voucher data found for exception analytics.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Vouchers Scanned</p>
              <p className="text-2xl font-black text-slate-900 mt-1">{summary.vouchersScanned.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Flagged Vouchers</p>
              <p className="text-2xl font-black text-amber-700 mt-1">{summary.vouchersFlagged.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Total Exceptions</p>
              <p className="text-2xl font-black text-rose-700 mt-1">{summary.totalExceptions.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">High Severity</p>
              <p className="text-2xl font-black text-rose-700 mt-1">{summary.highSeverityCount.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Weighted Density</p>
              <p className="text-2xl font-black text-indigo-700 mt-1">{summary.weightedDensity.toFixed(2)}</p>
              <p className="text-[11px] text-slate-500">points per 100 vouchers</p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-bold text-slate-800 mb-3">Exception Heatmap (Month x Exception Type)</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-600">
                    <th className="px-3 py-2 text-left border border-slate-200 font-semibold">Month</th>
                    {EXCEPTION_TYPES.map((type) => (
                      <th key={type.id} className="px-3 py-2 text-center border border-slate-200 font-semibold min-w-[160px]">
                        <div>{type.label}</div>
                        <div className="text-[10px] font-normal text-slate-500">{type.description}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {months.map((month) => (
                    <tr key={month}>
                      <td className="px-3 py-2 border border-slate-200 font-semibold text-slate-700">{month}</td>
                      {EXCEPTION_TYPES.map((type) => {
                        const count = matrix.get(month)?.get(type.id) || 0;
                        const ratio = maxCellCount <= 0 ? 0 : count / maxCellCount;
                        const background = count === 0 ? '#ffffff' : `rgba(239, 68, 68, ${0.12 + ratio * 0.68})`;
                        const textColor = ratio > 0.45 ? '#ffffff' : '#111827';
                        const active = monthFilter === month && exceptionTypeFilter === type.id;

                        return (
                          <td key={`${month}_${type.id}`} className="px-2 py-2 border border-slate-200 text-center">
                            <button
                              onClick={() => {
                                if (count <= 0) return;
                                setMonthFilter(month);
                                setExceptionTypeFilter(type.id);
                              }}
                              title={count > 0 ? 'Click to filter detail table' : 'No exceptions'}
                              className={`w-full rounded-md px-2 py-1 text-sm font-semibold transition ${
                                count > 0 ? 'hover:scale-[1.02]' : 'cursor-default'
                              } ${active ? 'ring-2 ring-indigo-500' : ''}`}
                              style={{ backgroundColor: background, color: textColor }}
                            >
                              {count}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-4">
              <h3 className="text-sm font-bold text-slate-800">Exception Detail Register</h3>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                  <input
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Search voucher, party, invoice, reason"
                    className="pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm w-full sm:w-72"
                  />
                </div>
                <div className="relative">
                  <Filter size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                  <select
                    value={severityFilter}
                    onChange={(event) => setSeverityFilter(event.target.value as 'all' | Severity)}
                    className="pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm"
                  >
                    <option value="all">All Severities</option>
                    <option value="High">High</option>
                    <option value="Medium">Medium</option>
                    <option value="Low">Low</option>
                  </select>
                </div>
                <select
                  value={exceptionTypeFilter}
                  onChange={(event) => setExceptionTypeFilter(event.target.value as 'all' | ExceptionTypeId)}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm"
                >
                  <option value="all">All Exception Types</option>
                  {EXCEPTION_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <select
                  value={monthFilter}
                  onChange={(event) => setMonthFilter(event.target.value)}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm"
                >
                  <option value="all">All Months</option>
                  {months.map((month) => (
                    <option key={month} value={month}>
                      {month}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    setMonthFilter('all');
                    setExceptionTypeFilter('all');
                    setSeverityFilter('all');
                    setSearchTerm('');
                  }}
                  className="px-3 py-2 text-sm rounded-lg border border-slate-300 hover:bg-slate-50"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              {byExceptionType.map((item) => (
                <span
                  key={item.id}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${getSeverityBadgeClass(item.severity)}`}
                >
                  {item.label}: {item.count.toLocaleString('en-IN')}
                </span>
              ))}
            </div>

            {filteredExceptions.length === 0 ? (
              <div className="border border-dashed border-slate-300 rounded-lg p-8 text-center text-slate-500">
                No exceptions match current filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600">
                      <th className="px-3 py-2 border border-slate-200 text-left">Date</th>
                      <th className="px-3 py-2 border border-slate-200 text-left">Voucher No</th>
                      <th className="px-3 py-2 border border-slate-200 text-left">Voucher Type</th>
                      <th className="px-3 py-2 border border-slate-200 text-left">Exception</th>
                      <th className="px-3 py-2 border border-slate-200 text-left">Severity</th>
                      <th className="px-3 py-2 border border-slate-200 text-left">Reason</th>
                      <th className="px-3 py-2 border border-slate-200 text-right">Net Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExceptions.map((row) => (
                      <tr key={row.id} className="odd:bg-white even:bg-slate-50/50">
                        <td className="px-3 py-2 border border-slate-200 text-slate-700 whitespace-nowrap">
                          {toDdMmYyyy(row.date) || '-'}
                        </td>
                        <td className="px-3 py-2 border border-slate-200 text-slate-900 font-semibold whitespace-nowrap">
                          {row.voucherNumber}
                        </td>
                        <td className="px-3 py-2 border border-slate-200 text-slate-700">{row.voucherType}</td>
                        <td className="px-3 py-2 border border-slate-200 text-slate-700">{row.exceptionLabel}</td>
                        <td className="px-3 py-2 border border-slate-200">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${getSeverityBadgeClass(row.severity)}`}>
                            {row.severity === 'High' && <AlertTriangle size={12} />}
                            {row.severity}
                          </span>
                        </td>
                        <td className="px-3 py-2 border border-slate-200 text-slate-600">{row.reason}</td>
                        <td className="px-3 py-2 border border-slate-200 text-right font-mono text-slate-900 whitespace-nowrap">
                          {formatAmount(row.netAmount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default ExceptionDensityHeatmapAnalytics;
