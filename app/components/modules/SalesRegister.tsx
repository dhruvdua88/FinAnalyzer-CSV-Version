import React, { useEffect, useMemo, useState } from 'react';
import { Download, Search, Info } from 'lucide-react';
import { LedgerEntry } from '../../types';
import { isSqlBackendAvailable } from '../../services/sqlDataService';
import { fetchSqlModuleRows } from '../../services/sqlAnalyticsService';

type RegRow = {
  monthKey: string;
  date: string;
  invoice: string;
  issue: string;
  jv: string;
  voucherType: string;
  party: string;
  gstin: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
  narration: string;
  // ── Enrichments from the relational store (via LedgerEntry shim) ──────
  // Sourced from mst_stock_item.gst_hsn_code / gst_rate and trn_voucher
  // .place_of_supply / .reference_date. Multi-HSN invoices show only the
  // first inventory item's HSN here; the deeper per-line breakdown is
  // available in the GST Rate Analysis module.
  hsn: string;
  gstRate: number;
  placeOfSupply: string;
  referenceDate: string;
};

type MonthlySummaryRow = {
  monthKey: string;
  monthLabel: string;
  voucherCount: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
};

const toDDMMYYYY = (value: string) => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const monthKeyFromDate = (d: string) => {
  const p = d.split('/');
  return p.length === 3 ? `${p[1]}/${p[2]}` : '';
};

const sanitizeInvoice = (s: string) => (s || '').replace(/\s+/g, '').trim();

const normalizeGstin = (s: string) => {
  const v = (s || '').trim().toUpperCase();
  return /^[0-9A-Z]{15}$/.test(v) ? v : '';
};

const isSalesOrIncome = (e: LedgerEntry) => {
  const primary = (e.TallyPrimary || '').toLowerCase();
  return primary.includes('sale') || primary.includes('income');
};

const gstHead = (ledger: string) => {
  const x = (ledger || '').toLowerCase();
  if (x.includes('igst')) return 'IGST';
  if (x.includes('cgst')) return 'CGST';
  if (x.includes('sgst') || x.includes('utgst')) return 'SGST';
  if (x.includes('cess')) return 'CESS';
  return 'OTHER';
};

const deriveSeries = (inv: string) => (inv.split('/')[0] || inv.split('-')[0] || 'DEFAULT') || 'DEFAULT';

const monthLabelFromKey = (monthKey: string) => {
  const [mm, yyyy] = monthKey.split('/').map(Number);
  if (!mm || !yyyy) return monthKey;
  const d = new Date(yyyy, mm - 1, 1);
  return d.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
};

const monthSortValue = (monthKey: string) => {
  const [mm, yyyy] = monthKey.split('/').map(Number);
  if (!mm || !yyyy) return 0;
  return yyyy * 100 + mm;
};

const signedAmount = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const groupVoucherRows = (entries: LedgerEntry[]) => {
  const map = new Map<
    string,
    { voucher_number: string; date: string; voucher_type: string; entries: LedgerEntry[] }
  >();

  entries.forEach((entry, index) => {
    const voucherNumber =
      String(entry.voucher_number || entry.invoice_number || '').trim() || `UNKNOWN-${index + 1}`;
    const date = String(entry.date || '').trim();
    const voucherType = String(entry.voucher_type || '').trim();
    const key = `${voucherNumber}__${date}__${voucherType}`;
    if (!map.has(key)) {
      map.set(key, {
        voucher_number: voucherNumber,
        date,
        voucher_type: voucherType,
        entries: [],
      });
    }
    map.get(key)!.entries.push(entry);
  });

  return Array.from(map.values());
};

const downloadTextFile = (content: string, fileName: string) => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

const styleTabularSheet = (
  XLSX: any,
  worksheet: any,
  options: { cols?: Array<{ wch: number }>; numberHeaders?: string[]; headerRow?: number }
) => {
  const range = worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']) : null;
  if (!range) return;

  if (Array.isArray(options.cols)) worksheet['!cols'] = options.cols;

  const headerRow = options.headerRow ?? 0;
  const numberHeaders = new Set(options.numberHeaders || []);
  const numberColumns = new Set<number>();

  for (let c = range.s.c; c <= range.e.c; c++) {
    const ref = XLSX.utils.encode_cell({ r: headerRow, c });
    const cell = worksheet[ref];
    if (!cell) continue;
    if (numberHeaders.has(String(cell.v || ''))) numberColumns.add(c);
  }

  const border = {
    top: { style: 'thin', color: { rgb: 'D1D5DB' } },
    right: { style: 'thin', color: { rgb: 'D1D5DB' } },
    bottom: { style: 'thin', color: { rgb: 'D1D5DB' } },
    left: { style: 'thin', color: { rgb: 'D1D5DB' } },
  };

  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = worksheet[ref];
      if (!cell) continue;
      const isHeader = r === headerRow;
      const isNumberCell = numberColumns.has(c) && typeof cell.v === 'number';
      cell.s = {
        border,
        alignment: { horizontal: isHeader ? 'center' : isNumberCell ? 'right' : 'left', vertical: 'center' },
        font: { name: 'Calibri', sz: isHeader ? 11 : 10, bold: isHeader, color: { rgb: '0F172A' } },
        fill: { fgColor: { rgb: isHeader ? 'E2E8F0' : 'FFFFFF' } },
        ...(isNumberCell ? { numFmt: '#,##0.00' } : {}),
      };
    }
  }
};

const SalesRegister: React.FC<{ data: LedgerEntry[]; externalSelectedLedgers?: string[] }> = ({
  data,
  externalSelectedLedgers = [],
}) => {
  const [search, setSearch] = useState('');
  const [monthFilter, setMonthFilter] = useState('All');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [sqlRows, setSqlRows] = useState<LedgerEntry[]>([]);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const loadSqlRows = async () => {
      if (data.length > 0) {
        setSqlRows([]);
        setSqlError('');
        setSqlLoading(false);
        return;
      }

      setSqlLoading(true);
      setSqlError('');
      try {
        const sqlAvailable = await isSqlBackendAvailable();
        if (!sqlAvailable) {
          if (!cancelled) setSqlLoading(false);
          return;
        }
        const rows = await fetchSqlModuleRows({
          module: 'sales',
          selectedLedgers: externalSelectedLedgers,
        });
        if (cancelled) return;
        setSqlRows(rows);
      } catch (error: any) {
        if (cancelled) return;
        setSqlError(error?.message || 'Unable to load optimized SQL sales dataset.');
      } finally {
        if (!cancelled) setSqlLoading(false);
      }
    };

    loadSqlRows();
    return () => {
      cancelled = true;
    };
  }, [data.length, externalSelectedLedgers.join('|')]);

  const sourceData = data.length > 0 ? data : sqlRows;

  const rows = useMemo(() => {
    const selected = new Set(externalSelectedLedgers);

    let out = groupVoucherRows(sourceData)
      .map((voucher) => {
        const entries = voucher.entries || [];
        const salesEntries = entries.filter(isSalesOrIncome);
        const selectedLedgerHits = entries.filter((e: LedgerEntry) => selected.has(e.Ledger));

        // Include voucher only if it hits selected Sales GST ledgers OR belongs to Sales/Income primary.
        if (salesEntries.length === 0 && selectedLedgerHits.length === 0) return null;

        const taxable = salesEntries.reduce((a: number, e: LedgerEntry) => a + signedAmount(e.amount), 0);

        let igst = 0;
        let cgst = 0;
        let sgst = 0;
        let cess = 0;
        selectedLedgerHits.forEach((e: LedgerEntry) => {
          const amt = signedAmount(e.amount);
          const head = gstHead(e.Ledger);
          if (head === 'IGST') igst += amt;
          else if (head === 'CGST') cgst += amt;
          else if (head === 'SGST') sgst += amt;
          else if (head === 'CESS') cess += amt;
        });

        const invoice = sanitizeInvoice(
          entries.find((e: LedgerEntry) => e.invoice_number)?.invoice_number || voucher.voucher_number || ''
        );
        const gstinRaw =
          entries
            .map((e: LedgerEntry) => String((e as any).gstn || (e as any).GSTN || e.gstin || ''))
            .find((x: string) => x.trim()) || '';
        const date = toDDMMYYYY(voucher.date);

        // Enrichments from LedgerEntry shim — find the first entry that has
        // each populated, since not every accounting line carries them.
        const hsn = entries.find((e: LedgerEntry) => e.gst_hsn_code)?.gst_hsn_code || '';
        const gstRate = entries.find((e: LedgerEntry) => (e.gst_rate || 0) > 0)?.gst_rate || 0;
        const placeOfSupply = entries.find((e: LedgerEntry) => e.place_of_supply)?.place_of_supply || '';
        const referenceDate = entries.find((e: LedgerEntry) => e.reference_date)?.reference_date || '';

        return {
          monthKey: monthKeyFromDate(date),
          date,
          invoice,
          issue: '',
          jv: /journal|jv/i.test(voucher.voucher_type || '') ? sanitizeInvoice(voucher.voucher_number) : '',
          voucherType: voucher.voucher_type || '',
          party:
            entries.find((e: LedgerEntry) => e.party_name)?.party_name ||
            entries.find((e: LedgerEntry) => /debtor|creditor/i.test(e.TallyPrimary || ''))?.Ledger ||
            'Unknown Party',
          gstin: normalizeGstin(gstinRaw),
          taxable,
          igst,
          cgst,
          sgst,
          cess,
          hsn,
          gstRate,
          placeOfSupply,
          referenceDate,
          total: taxable + igst + cgst + sgst + cess,
          narration: entries.find((e: LedgerEntry) => e.narration)?.narration || '',
        } as RegRow;
      })
      .filter((x): x is RegRow => !!x);

    const counts = new Map<string, number>();
    out.forEach((row) => {
      const key = `${row.monthKey}|${row.invoice}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    out = out.map((row) => {
      const issues: string[] = [];
      if (!row.invoice) issues.push('Blank invoice/JV');
      if (row.invoice.length > 16) issues.push('Length > 16');
      if ((counts.get(`${row.monthKey}|${row.invoice}`) || 0) > 1) issues.push('Duplicate');
      return { ...row, issue: issues.join(' | ') };
    });

    return out.sort((a, b) => {
      const [ad, am, ay] = a.date.split('/').map(Number);
      const [bd, bm, by] = b.date.split('/').map(Number);
      return new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime();
    });
  }, [sourceData, externalSelectedLedgers]);

  const months = useMemo(() => Array.from(new Set(rows.map((r) => r.monthKey))).sort(), [rows]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (monthFilter !== 'All' && row.monthKey !== monthFilter) return false;
      if (onlyIssues && !row.issue) return false;
      if (!q) return true;
      return (
        row.invoice.toLowerCase().includes(q) ||
        row.party.toLowerCase().includes(q) ||
        row.gstin.toLowerCase().includes(q) ||
        row.voucherType.toLowerCase().includes(q)
      );
    });
  }, [rows, search, monthFilter, onlyIssues]);

  const docsSummary = useMemo(() => {
    const map = new Map<string, { voucherType: string; series: string; total: number; cancelled: number }>();
    rows.forEach((row) => {
      const key = `${row.voucherType}|${deriveSeries(row.invoice)}`;
      const current = map.get(key) || {
        voucherType: row.voucherType || 'UNKNOWN',
        series: deriveSeries(row.invoice),
        total: 0,
        cancelled: 0,
      };
      current.total += 1;
      if ((`${row.voucherType} ${row.narration}`).toLowerCase().includes('cancel')) current.cancelled += 1;
      map.set(key, current);
    });
    return Array.from(map.values()).map((x) => ({ ...x, net: x.total - x.cancelled }));
  }, [rows]);

  const monthSummaryRows = useMemo(() => {
    const source = rows.filter((row) => (monthFilter === 'All' ? true : row.monthKey === monthFilter));
    const map = new Map<string, MonthlySummaryRow>();

    source.forEach((row) => {
      if (!map.has(row.monthKey)) {
        map.set(row.monthKey, {
          monthKey: row.monthKey,
          monthLabel: monthLabelFromKey(row.monthKey),
          voucherCount: 0,
          taxable: 0,
          igst: 0,
          cgst: 0,
          sgst: 0,
          cess: 0,
          total: 0,
        });
      }
      const bucket = map.get(row.monthKey)!;
      bucket.voucherCount += 1;
      bucket.taxable += row.taxable;
      bucket.igst += row.igst;
      bucket.cgst += row.cgst;
      bucket.sgst += row.sgst;
      bucket.cess += row.cess;
      bucket.total += row.total;
    });

    return Array.from(map.values()).sort((a, b) => monthSortValue(a.monthKey) - monthSortValue(b.monthKey));
  }, [rows, monthFilter]);

  const exportRegister = async () => {
    if (!visibleRows.length) return;
    try {
      const XLSX = await import('xlsx');
      const exportRows = visibleRows.map((r) => ({
        'Invoice Date': r.date,
        'Reference Date': r.referenceDate ? toDDMMYYYY(r.referenceDate) : '',
        'Invoice/JV No': r.invoice,
        'Invoice Number Issue': r.issue,
        'JV No': r.jv,
        'Voucher Type': r.voucherType,
        'Party Name': r.party,
        GSTIN: r.gstin,
        'Place of Supply': r.placeOfSupply,
        'HSN/SAC': r.hsn,
        'GST Rate %': r.gstRate || '',
        'Taxable Value': r.taxable,
        IGST: r.igst,
        CGST: r.cgst,
        SGST: r.sgst,
        CESS: r.cess,
        'Invoice Value': r.total,
      }));

      const worksheet = XLSX.utils.json_to_sheet(exportRows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sales Register');
      XLSX.writeFile(workbook, `Sales_Register_${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export Sales Register Excel. Please retry.');
    }
  };

  const exportMonthSummaryExcel = async () => {
    if (!monthSummaryRows.length) return;
    try {
      const XLSX = await import('xlsx-js-style');
      const exportRows = monthSummaryRows.map((row) => ({
        Month: row.monthLabel,
        Vouchers: row.voucherCount,
        Taxable: row.taxable,
        IGST: row.igst,
        CGST: row.cgst,
        SGST: row.sgst,
        CESS: row.cess,
        Total: row.total,
      }));
      const sheet = XLSX.utils.json_to_sheet(exportRows);
      styleTabularSheet(XLSX, sheet, {
        cols: [{ wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }],
        numberHeaders: ['Vouchers', 'Taxable', 'IGST', 'CGST', 'SGST', 'CESS', 'Total'],
      });
      sheet['!autofilter'] = { ref: `A1:H${Math.max(1, exportRows.length + 1)}` };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, 'Monthly Sales Summary');
      XLSX.writeFile(wb, `Sales_Register_Monthly_Summary_${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true, cellStyles: true });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export monthly sales summary Excel. Please retry.');
    }
  };

  const exportMonthSummaryMarkdown = () => {
    if (!monthSummaryRows.length) return;
    const lines: string[] = [];
    lines.push('# Sales Register Month-wise Summary');
    lines.push('');
    lines.push(`Generated: ${toDDMMYYYY(new Date().toISOString().slice(0, 10))}`);
    lines.push(`Month Filter: ${monthFilter === 'All' ? 'All Months' : monthFilter}`);
    lines.push('');
    lines.push('| Month | Vouchers | Taxable | IGST | CGST | SGST | CESS | Total |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    monthSummaryRows.forEach((row) => {
      lines.push(
        `| ${row.monthLabel} | ${row.voucherCount} | ${row.taxable.toFixed(2)} | ${row.igst.toFixed(2)} | ${row.cgst.toFixed(2)} | ${row.sgst.toFixed(2)} | ${row.cess.toFixed(2)} | ${row.total.toFixed(2)} |`
      );
    });
    downloadTextFile(lines.join('\n'), `Sales_Register_Monthly_Summary_${new Date().toISOString().slice(0, 10)}.md`);
  };

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-800 text-sm flex items-start gap-3">
        <Info size={16} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-bold">Before using Sales Register, first select GST ledgers in Sales GST Analysis.</p>
          <p className="text-xs mt-1">
            This register includes only vouchers that hit selected Sales GST ledgers or belong to TallyPrimary Sales/Income.
          </p>
        </div>
      </div>

      {sqlLoading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800">
          Loading optimized SQL sales dataset...
        </div>
      )}
      {sqlError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
          {sqlError}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap gap-2 items-center">
        <button
          onClick={exportRegister}
          className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-2"
        >
          <Download size={15} />
          Export Register
        </button>
        <button
          onClick={exportMonthSummaryExcel}
          className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm flex items-center gap-2"
        >
          <Download size={15} />
          Month Summary Excel
        </button>
        <button
          onClick={exportMonthSummaryMarkdown}
          className="px-3 py-2 bg-slate-700 text-white rounded-lg text-sm flex items-center gap-2"
        >
          <Download size={15} />
          Month Summary Markdown
        </button>
        <div className="relative">
          <Search size={14} className="absolute left-2 top-2.5 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoice/party/gstin/type"
            className="pl-7 pr-3 py-2 border border-slate-300 rounded text-sm w-72"
          />
        </div>
        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="px-2 py-2 border border-slate-300 rounded text-sm"
        >
          <option value="All">All Months</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          onClick={() => setOnlyIssues((v) => !v)}
          className={`px-3 py-2 rounded-lg text-sm border ${
            onlyIssues ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-slate-300 text-slate-600'
          }`}
        >
          {onlyIssues ? 'Issues Only: ON' : 'Issues Only: OFF'}
        </button>
        <div className="ml-auto text-xs text-slate-500">Rows: {visibleRows.length}</div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-auto">
        <div className="p-3 font-semibold text-sm">Sales Register Month-wise Summary</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-2 text-left">Month</th>
              <th className="p-2 text-right">Vouchers</th>
              <th className="p-2 text-right">Taxable</th>
              <th className="p-2 text-right">IGST</th>
              <th className="p-2 text-right">CGST</th>
              <th className="p-2 text-right">SGST</th>
              <th className="p-2 text-right">CESS</th>
              <th className="p-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {monthSummaryRows.map((row) => (
              <tr key={row.monthKey} className="border-t">
                <td className="p-2">{row.monthLabel}</td>
                <td className="p-2 text-right">{row.voucherCount.toLocaleString('en-IN')}</td>
                <td className="p-2 text-right">{row.taxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="p-2 text-right">{row.igst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="p-2 text-right">{row.cgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="p-2 text-right">{row.sgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="p-2 text-right">{row.cess.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="p-2 text-right font-semibold">{row.total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
            ))}
            {monthSummaryRows.length === 0 && (
              <tr>
                <td className="p-8 text-center text-slate-400" colSpan={8}>
                  No month summary rows for current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-auto">
        <div className="p-3 font-semibold text-sm">Sales Register</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-2 text-left">Date</th>
              <th className="p-2 text-left">Invoice/JV No</th>
              <th className="p-2 text-left">Invoice Issue</th>
              <th className="p-2 text-left">Party</th>
              <th className="p-2 text-left">GSTIN</th>
              <th className="p-2 text-left">PoS</th>
              <th className="p-2 text-left">HSN</th>
              <th className="p-2 text-right">Rate %</th>
              <th className="p-2 text-right">Taxable</th>
              <th className="p-2 text-right">IGST</th>
              <th className="p-2 text-right">CGST</th>
              <th className="p-2 text-right">SGST</th>
              <th className="p-2 text-right">CESS</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, i) => (
              <tr key={`${r.invoice}-${i}`} className="border-t">
                <td className="p-2">{r.date}</td>
                <td className={`p-2 font-medium ${r.issue ? 'text-red-600' : ''}`}>{r.invoice}</td>
                <td className={`p-2 text-xs ${r.issue ? 'text-red-600' : 'text-slate-400'}`}>{r.issue || '-'}</td>
                <td className="p-2">{r.party}</td>
                <td className="p-2 font-mono text-xs">{r.gstin || '-'}</td>
                <td className="p-2 text-xs">{r.placeOfSupply || '-'}</td>
                <td className="p-2 font-mono text-xs">{r.hsn || '-'}</td>
                <td className="p-2 text-right text-xs">{r.gstRate ? `${r.gstRate}%` : '-'}</td>
                <td className="p-2 text-right">{r.taxable.toLocaleString('en-IN')}</td>
                <td className="p-2 text-right">{r.igst.toLocaleString('en-IN')}</td>
                <td className="p-2 text-right">{r.cgst.toLocaleString('en-IN')}</td>
                <td className="p-2 text-right">{r.sgst.toLocaleString('en-IN')}</td>
                <td className="p-2 text-right">{r.cess.toLocaleString('en-IN')}</td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td className="p-8 text-center text-slate-400" colSpan={13}>
                  No sales register rows for current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {docsSummary.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-auto">
          <div className="p-3 font-semibold text-sm">Documents Issued During Tax Period (Summary)</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-2 text-left">Voucher Type</th>
                <th className="p-2 text-left">Series</th>
                <th className="p-2 text-right">Total Issued</th>
                <th className="p-2 text-right">Cancelled</th>
                <th className="p-2 text-right">Net Issued</th>
              </tr>
            </thead>
            <tbody>
              {docsSummary.map((d, i) => (
                <tr key={i} className="border-t">
                  <td className="p-2">{d.voucherType}</td>
                  <td className="p-2">{d.series}</td>
                  <td className="p-2 text-right">{d.total}</td>
                  <td className="p-2 text-right">{d.cancelled}</td>
                  <td className="p-2 text-right">{d.net}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SalesRegister;
