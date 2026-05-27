import React, { useEffect, useMemo, useState } from 'react';
import { LedgerEntry } from '../../types';
import { Download, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchSqlVoucherBookPage } from '../../services/sqlAnalyticsService';
import { voucherFamilyKey } from '../../services/tally';

interface VoucherBookViewProps {
  data: LedgerEntry[];
}

interface VoucherGroupRow {
  key: string;
  voucherNumber: string;
  date: string;
  voucherType: string;
  party: string;
  narration: string;
  entries: LedgerEntry[];
  totalDr: number;
  totalCr: number;
  lineCount: number;
}

const toDDMMYYYY = (value: string) => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const toNumber = (value: any): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isSyntheticUnknownVoucher = (voucherNumber: string) => /^unknown(?:-\d+)?$/i.test(String(voucherNumber || '').trim());

const getVoucherGroupKey = (entry: LedgerEntry) => {
  const voucherNumber = String(entry.voucher_number || entry.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN';
  const date = String(entry.date || '').trim();
  const voucherType = String(entry.voucher_type || '').trim();
  const guidFamily = voucherFamilyKey(entry.guid);
  const voucherFamily = isSyntheticUnknownVoucher(voucherNumber) && guidFamily ? `UNKNOWN_GUID::${guidFamily}` : voucherNumber;
  return {
    voucherNumber,
    date,
    voucherType,
    key: `${voucherFamily}__${date}__${voucherType}`,
  };
};

const getDrCr = (amount: number) => {
  if (amount < 0) return { dr: Math.abs(amount), cr: 0 };
  if (amount > 0) return { dr: 0, cr: amount };
  return { dr: 0, cr: 0 };
};

const formatAmount = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const toDateTs = (value: string): number => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};

const VoucherBookView: React.FC<VoucherBookViewProps> = ({ data }) => {
  const [search, setSearch] = useState('');
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sqlRows, setSqlRows] = useState<VoucherGroupRow[]>([]);
  const [sqlTotals, setSqlTotals] = useState({ vouchers: 0, lines: 0, dr: 0, cr: 0 });
  const [sqlTotalPages, setSqlTotalPages] = useState(1);
  const [sqlTotalRows, setSqlTotalRows] = useState(0);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState('');
  const isSqlQueryMode = data.length === 0;

  const voucherRows = useMemo(() => {
    if (isSqlQueryMode) return [] as VoucherGroupRow[];
    const map = new Map<string, VoucherGroupRow>();

    data.forEach((entry) => {
      const normalized = getVoucherGroupKey(entry);
      const { voucherNumber, date, voucherType, key } = normalized;

      if (!map.has(key)) {
        map.set(key, {
          key,
          voucherNumber,
          date,
          voucherType,
          party: '',
          narration: '',
          entries: [],
          totalDr: 0,
          totalCr: 0,
          lineCount: 0,
        });
      }

      const bucket = map.get(key)!;
      if (
        isSyntheticUnknownVoucher(bucket.voucherNumber) &&
        voucherNumber &&
        (!isSyntheticUnknownVoucher(voucherNumber) || voucherNumber.localeCompare(bucket.voucherNumber) < 0)
      ) {
        bucket.voucherNumber = voucherNumber;
      }
      bucket.entries.push(entry);
      bucket.lineCount += 1;
      const { dr, cr } = getDrCr(toNumber(entry.amount));
      bucket.totalDr += dr;
      bucket.totalCr += cr;

      if (!bucket.party) {
        const partyFromName = String(entry.party_name || '').trim();
        const primary = String(entry.TallyPrimary || '').toLowerCase();
        const parent = String(entry.TallyParent || '').toLowerCase();
        const likelyParty = primary.includes('debtor') || parent.includes('debtor') || primary.includes('creditor') || parent.includes('creditor');
        bucket.party = partyFromName || (likelyParty ? String(entry.Ledger || '').trim() : '') || '-';
      }
      if (!bucket.narration) {
        bucket.narration = String(entry.narration || '').trim();
      }
    });

    return Array.from(map.values()).sort((a, b) => {
      const dtDiff = toDateTs(b.date) - toDateTs(a.date);
      if (dtDiff !== 0) return dtDiff;
      return a.voucherNumber.localeCompare(b.voucherNumber);
    });
  }, [data, isSqlQueryMode]);

  useEffect(() => {
    setPage(1);
  }, [search, isSqlQueryMode]);

  useEffect(() => {
    let cancelled = false;

    const loadSqlPage = async () => {
      if (!isSqlQueryMode) {
        setSqlRows([]);
        setSqlTotals({ vouchers: 0, lines: 0, dr: 0, cr: 0 });
        setSqlTotalRows(0);
        setSqlTotalPages(1);
        setSqlLoading(false);
        setSqlError('');
        return;
      }

      setSqlLoading(true);
      setSqlError('');
      try {
        const payload = await fetchSqlVoucherBookPage({ search, page, pageSize });
        if (cancelled) return;
        const rows: VoucherGroupRow[] = (payload.rows || []).map((row: any) => ({
          key: String(row.key || ''),
          voucherNumber: String(row.voucherNumber || ''),
          date: String(row.date || ''),
          voucherType: String(row.voucherType || ''),
          party: String(row.party || '-'),
          narration: String(row.narration || ''),
          entries: Array.isArray(row.entries) ? row.entries : [],
          totalDr: Number(row.totalDr || 0),
          totalCr: Number(row.totalCr || 0),
          lineCount: Number(row.lineCount || (Array.isArray(row.entries) ? row.entries.length : 0)),
        }));
        setSqlRows(rows);
        setSqlTotals({
          vouchers: Number(payload.totals?.vouchers || 0),
          lines: Number(payload.totals?.lines || 0),
          dr: Number(payload.totals?.dr || 0),
          cr: Number(payload.totals?.cr || 0),
        });
        setSqlTotalRows(Number(payload.totalRows || 0));
        setSqlTotalPages(Number(payload.totalPages || 1));
      } catch (error: any) {
        if (cancelled) return;
        setSqlError(error?.message || 'Unable to load voucher page from SQL.');
      } finally {
        if (!cancelled) setSqlLoading(false);
      }
    };

    loadSqlPage();
    return () => {
      cancelled = true;
    };
  }, [isSqlQueryMode, search, page, pageSize]);

  useEffect(() => {
    setExpandedRows((prev) => {
      const next: Record<string, boolean> = {};
      const sourceRows = isSqlQueryMode ? sqlRows : voucherRows;
      sourceRows.forEach((row) => {
        next[row.key] = prev[row.key] ?? false;
      });
      return next;
    });
  }, [voucherRows, sqlRows, isSqlQueryMode]);

  const filteredRows = useMemo(() => {
    if (isSqlQueryMode) return [] as VoucherGroupRow[];
    const q = search.trim().toLowerCase();
    if (!q) return voucherRows;
    return voucherRows.filter((row) => row.voucherNumber.toLowerCase().includes(q));
  }, [voucherRows, search, isSqlQueryMode]);

  const displayRows = useMemo(() => {
    return isSqlQueryMode ? sqlRows : filteredRows;
  }, [isSqlQueryMode, sqlRows, filteredRows]);

  const totals = useMemo(
    () => {
      if (isSqlQueryMode) return sqlTotals;
      return filteredRows.reduce(
        (acc, row) => {
          acc.vouchers += 1;
          acc.lines += row.entries.length;
          acc.dr += row.totalDr;
          acc.cr += row.totalCr;
          return acc;
        },
        { vouchers: 0, lines: 0, dr: 0, cr: 0 }
      );
    },
    [filteredRows, isSqlQueryMode, sqlTotals]
  );

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    displayRows.forEach((row) => {
      next[row.key] = true;
    });
    setExpandedRows((prev) => ({ ...prev, ...next }));
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    displayRows.forEach((row) => {
      next[row.key] = false;
    });
    setExpandedRows((prev) => ({ ...prev, ...next }));
  };

  const exportExcel = async () => {
    if (displayRows.length === 0 && !(isSqlQueryMode && sqlTotalRows > 0)) return;
    try {
      const XLSX = await import('xlsx');
      let exportRows: VoucherGroupRow[] = displayRows;

      if (isSqlQueryMode) {
        const allRows: VoucherGroupRow[] = [];
        const pages = Math.max(1, sqlTotalPages);
        for (let p = 1; p <= pages; p += 1) {
          const payload = await fetchSqlVoucherBookPage({ search, page: p, pageSize });
          const pageRows = (payload.rows || []).map((row: any) => ({
            key: String(row.key || ''),
            voucherNumber: String(row.voucherNumber || ''),
            date: String(row.date || ''),
            voucherType: String(row.voucherType || ''),
            party: String(row.party || '-'),
            narration: String(row.narration || ''),
            entries: Array.isArray(row.entries) ? row.entries : [],
            totalDr: Number(row.totalDr || 0),
            totalCr: Number(row.totalCr || 0),
            lineCount: Number(row.lineCount || (Array.isArray(row.entries) ? row.entries.length : 0)),
          }));
          allRows.push(...pageRows);
        }
        exportRows = allRows;
      }

      const summaryRows = exportRows.map((row) => ({
        'Voucher Number': row.voucherNumber,
        Date: toDDMMYYYY(row.date),
        'Voucher Type': row.voucherType || '-',
        Party: row.party || '-',
        Narration: row.narration || '-',
        'Total Dr': row.totalDr,
        'Total Cr': row.totalCr,
        Lines: row.entries.length,
      }));

      const detailRows: Record<string, any>[] = [];
      exportRows.forEach((row) => {
        row.entries.forEach((entry) => {
          const amount = toNumber(entry.amount);
          const { dr, cr } = getDrCr(amount);
          detailRows.push({
            'Voucher Number': row.voucherNumber,
            Date: toDDMMYYYY(row.date),
            'Voucher Type': row.voucherType || '-',
            Ledger: entry.Ledger || '-',
            Group: entry.Group || '-',
            Primary: entry.TallyPrimary || '-',
            Narration: entry.narration || row.narration || '-',
            Dr: dr,
            Cr: cr,
          });
        });
      });

      const wb = XLSX.utils.book_new();
      const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
      const wsDetails = XLSX.utils.json_to_sheet(detailRows);
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Voucher Summary');
      XLSX.utils.book_append_sheet(wb, wsDetails, 'Voucher Entries');

      const dt = new Date();
      const stamp = `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
      XLSX.writeFile(wb, `Voucher_Book_View_${stamp}.xlsx`, { compression: true });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export voucher view Excel. Please retry.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Vouchers</p>
          <p className="text-3xl font-black text-slate-900 mt-1">{totals.vouchers}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Entries</p>
          <p className="text-3xl font-black text-slate-900 mt-1">{totals.lines}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Total Dr</p>
          <p className="text-2xl font-black text-rose-700 mt-1">{formatAmount(totals.dr)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Total Cr</p>
          <p className="text-2xl font-black text-emerald-700 mt-1">{formatAmount(totals.cr)}</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-1 lg:grid-cols-6 gap-3">
          <div className="relative lg:col-span-3">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search voucher number..."
              className="w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>
          <button
            onClick={expandAll}
            className="px-4 py-2 rounded-lg text-sm font-bold border border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            Expand All
          </button>
          <button
            onClick={collapseAll}
            className="px-4 py-2 rounded-lg text-sm font-bold border border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            Collapse All
          </button>
          <button
            onClick={exportExcel}
            className="px-4 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2"
          >
            <Download size={15} />
            Export Excel
          </button>
        </div>

        {isSqlQueryMode && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <span>Rows per page</span>
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                className="rounded border border-slate-300 px-2 py-1 text-xs"
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
              <span className="ml-2">
                Page {page} of {Math.max(1, sqlTotalPages)}
              </span>
              <span className="ml-2 text-slate-500">Total vouchers: {sqlTotalRows}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page <= 1 || sqlLoading}
                className={`px-3 py-1.5 rounded border text-xs font-semibold ${
                  page <= 1 || sqlLoading
                    ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                Prev
              </button>
              <button
                onClick={() => setPage((prev) => Math.min(Math.max(1, sqlTotalPages), prev + 1))}
                disabled={page >= Math.max(1, sqlTotalPages) || sqlLoading}
                className={`px-3 py-1.5 rounded border text-xs font-semibold ${
                  page >= Math.max(1, sqlTotalPages) || sqlLoading
                    ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {sqlLoading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-800">
          Loading voucher page from SQL...
        </div>
      )}
      {sqlError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">
          {sqlError}
        </div>
      )}

      {displayRows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500">
          {sqlLoading ? 'Loading vouchers...' : 'No vouchers found for current search.'}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left font-bold">Voucher Number</th>
                  <th className="px-4 py-3 text-left font-bold">Date</th>
                  <th className="px-4 py-3 text-left font-bold">Voucher Type</th>
                  <th className="px-4 py-3 text-left font-bold">Party</th>
                  <th className="px-4 py-3 text-left font-bold">Narration</th>
                  <th className="px-4 py-3 text-right font-bold">Dr</th>
                  <th className="px-4 py-3 text-right font-bold">Cr</th>
                  <th className="px-4 py-3 text-right font-bold">Lines</th>
                  <th className="px-4 py-3 text-left font-bold">Entries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayRows.map((row) => {
                  const isExpanded = expandedRows[row.key] ?? false;
                  return (
                    <React.Fragment key={row.key}>
                      <tr className="hover:bg-slate-50" style={{ contentVisibility: 'auto', containIntrinsicSize: '52px' }}>
                        <td className="px-4 py-3 font-semibold text-slate-900">{row.voucherNumber}</td>
                        <td className="px-4 py-3">{toDDMMYYYY(row.date)}</td>
                        <td className="px-4 py-3">{row.voucherType || '-'}</td>
                        <td className="px-4 py-3">{row.party || '-'}</td>
                        <td className="px-4 py-3 max-w-[260px] truncate" title={row.narration || '-'}>
                          {row.narration || '-'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-rose-700 font-semibold">{formatAmount(row.totalDr)}</td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-700 font-semibold">{formatAmount(row.totalCr)}</td>
                        <td className="px-4 py-3 text-right">{row.lineCount || row.entries.length}</td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() =>
                              setExpandedRows((prev) => ({
                                ...prev,
                                [row.key]: !isExpanded,
                              }))
                            }
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            {isExpanded ? 'Hide' : 'Show'}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-slate-50">
                          <td colSpan={9} className="px-4 py-3">
                            <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                              <table className="w-full text-xs">
                                <thead className="bg-slate-100 text-slate-600 uppercase tracking-wide">
                                  <tr>
                                    <th className="px-3 py-2 text-left">Ledger</th>
                                    <th className="px-3 py-2 text-left">Group</th>
                                    <th className="px-3 py-2 text-left">Primary</th>
                                    <th className="px-3 py-2 text-left">Narration</th>
                                    <th className="px-3 py-2 text-right">Dr</th>
                                    <th className="px-3 py-2 text-right">Cr</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {row.entries.map((entry, idx) => {
                                    const { dr, cr } = getDrCr(toNumber(entry.amount));
                                    return (
                                      <tr key={`${row.key}-${idx}`} className="hover:bg-slate-50">
                                        <td className="px-3 py-2">{entry.Ledger || '-'}</td>
                                        <td className="px-3 py-2">{entry.Group || '-'}</td>
                                        <td className="px-3 py-2">{entry.TallyPrimary || '-'}</td>
                                        <td className="px-3 py-2 max-w-[260px] truncate" title={entry.narration || '-'}>
                                          {entry.narration || '-'}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-rose-700">
                                          {dr ? formatAmount(dr) : '-'}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-emerald-700">
                                          {cr ? formatAmount(cr) : '-'}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default VoucherBookView;
