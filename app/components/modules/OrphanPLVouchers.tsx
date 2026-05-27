import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LedgerEntry } from '../../types';
import {
  AlertTriangle,
  Search,
  Download,
  Loader2,
  X,
  ChevronRight,
  ChevronDown,
  Banknote,
  Wallet,
  Landmark,
  PiggyBank,
  Receipt,
  FileText,
  Boxes,
  ArrowUp,
  ArrowDown,
  EyeOff,
  Eye,
  Filter,
} from 'lucide-react';
import type {
  OrphanPLVoucher,
  OrphanPLWorkerInput,
  OrphanPLWorkerOutput,
  PLBucket,
  RoutedBucket,
  OrphanPLFilters,
} from '../../workers/orphanPLWorker';
import { useTallyStore } from '../../services/tally';

interface Props {
  data: LedgerEntry[];
}

// ── Formatters ────────────────────────────────────────────────────────────────
const CRORE = 1_00_00_000;
const LAKH = 1_00_000;

const moneyFull = (v: number) =>
  Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Indian compact — Cr and L only. Below 1 L shows the full number. This
// matches how a CA actually reads the amount ("ten-point-one Cr" vs
// "three-eighty-four thousand" which nobody says).
const compact = (v: number): string => {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a < 0.005) return '—';
  const sign = n < 0 ? '−' : '';
  if (a >= CRORE) return `${sign}${(a / CRORE).toFixed(2)} Cr`;
  if (a >= LAKH) return `${sign}${(a / LAKH).toFixed(2)} L`;
  return `${sign}${a.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};

const toDdMmYyyy = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

// ── Bucket display metadata ───────────────────────────────────────────────────
const PL_BUCKET_META: Record<PLBucket, { label: string; short: string; bg: string; text: string; border: string }> = {
  sales:             { label: 'Sales Accounts',      short: 'Sales',      bg: 'bg-emerald-50',  text: 'text-emerald-700',  border: 'border-emerald-200' },
  purchase:          { label: 'Purchase Accounts',   short: 'Purchase',   bg: 'bg-violet-50',   text: 'text-violet-700',   border: 'border-violet-200' },
  direct_income:     { label: 'Direct Incomes',      short: 'D.Income',   bg: 'bg-teal-50',     text: 'text-teal-700',     border: 'border-teal-200' },
  indirect_income:   { label: 'Indirect Incomes',    short: 'I.Income',   bg: 'bg-green-50',    text: 'text-green-700',    border: 'border-green-200' },
  direct_expense:    { label: 'Direct Expenses',     short: 'D.Expense',  bg: 'bg-amber-50',    text: 'text-amber-700',    border: 'border-amber-200' },
  indirect_expense:  { label: 'Indirect Expenses',   short: 'I.Expense',  bg: 'bg-orange-50',   text: 'text-orange-700',   border: 'border-orange-200' },
};

const ROUTED_BUCKET_META: Record<
  RoutedBucket,
  { label: string; short: string; bg: string; text: string; border: string; Icon: any }
> = {
  bank:              { label: 'Bank Accounts',         short: 'Bank',      bg: 'bg-sky-50',      text: 'text-sky-700',      border: 'border-sky-200',      Icon: Landmark },
  cash:              { label: 'Cash-in-Hand',          short: 'Cash',      bg: 'bg-lime-50',     text: 'text-lime-700',     border: 'border-lime-200',     Icon: Wallet },
  loan:              { label: 'Loans',                 short: 'Loan',      bg: 'bg-rose-50',     text: 'text-rose-700',     border: 'border-rose-200',     Icon: Banknote },
  capital:           { label: 'Capital / Partners',    short: 'Capital',   bg: 'bg-purple-50',   text: 'text-purple-700',   border: 'border-purple-200',   Icon: PiggyBank },
  tax:               { label: 'Duties & Taxes',        short: 'Tax',       bg: 'bg-slate-100',   text: 'text-slate-700',    border: 'border-slate-300',    Icon: Receipt },
  current_asset:     { label: 'Current Assets',        short: 'Cur.Asset', bg: 'bg-cyan-50',     text: 'text-cyan-700',     border: 'border-cyan-200',     Icon: FileText },
  current_liability: { label: 'Current Liabilities',   short: 'Cur.Liab',  bg: 'bg-fuchsia-50',  text: 'text-fuchsia-700',  border: 'border-fuchsia-200',  Icon: FileText },
  fixed_asset:       { label: 'Fixed Assets',          short: 'Fix.Asset', bg: 'bg-indigo-50',   text: 'text-indigo-700',   border: 'border-indigo-200',   Icon: Landmark },
  investment:        { label: 'Investments',           short: 'Invest.',   bg: 'bg-blue-50',     text: 'text-blue-700',     border: 'border-blue-200',     Icon: Landmark },
  stock:             { label: 'Stock-in-Hand',         short: 'Stock',     bg: 'bg-yellow-50',   text: 'text-yellow-700',   border: 'border-yellow-200',   Icon: Boxes },
  other:             { label: 'Other',                 short: 'Other',     bg: 'bg-slate-50',    text: 'text-slate-600',    border: 'border-slate-200',    Icon: FileText },
};

// ── Sort keys ─────────────────────────────────────────────────────────────────
type SortKey = 'date' | 'amount' | 'voucher_type' | 'voucher_number';

// ── Component ─────────────────────────────────────────────────────────────────
const OrphanPLVouchers: React.FC<Props> = ({ data }) => {
  // P&L universe per mst_group.is_revenue — the authoritative scope check.
  // The worker classifies P&L hits from TallyPrimary (which the shim
  // already populates from store.primaryGroupFor), but here we surface the
  // ground-truth count so the auditor can validate the scope at a glance.
  const store = useTallyStore();
  const plLedgerCount = useMemo(() => {
    if (!store) return null;
    let n = 0;
    for (const l of store.ledgers.values()) {
      const g = store.group(l.parent);
      if (g?.is_revenue) n += 1;
    }
    return n;
  }, [store]);
  // Filters
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [voucherTypeFilter, setVoucherTypeFilter] = useState<string>('all');
  const [plBucketFilter, setPLBucketFilter] = useState<PLBucket | 'all'>('all');
  const [routedBucketFilter, setRoutedBucketFilter] = useState<RoutedBucket | 'all'>('all');
  const [minAmount, setMinAmount] = useState<number>(0);
  const [hideCashBankOnly, setHideCashBankOnly] = useState<boolean>(false);

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>('amount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Expand state
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Worker
  const workerRef = useRef<Worker | null>(null);
  const [computing, setComputing] = useState<boolean>(false);
  const [result, setResult] = useState<OrphanPLWorkerOutput | null>(null);
  const [exporting, setExporting] = useState<boolean>(false);

  // Boot the worker once
  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../../workers/orphanPLWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current.addEventListener('message', (ev: MessageEvent<OrphanPLWorkerOutput>) => {
      setResult(ev.data);
      setComputing(false);
    });
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Debounce filter changes → worker
  const filtersSnapshot = useMemo<OrphanPLFilters>(
    () => ({
      fromDate: fromDate || null,
      toDate: toDate || null,
      voucherTypeFilter,
      plBucketFilter,
      routedBucketFilter,
      minAmount,
      hideCashBankOnly,
      search,
    }),
    [fromDate, toDate, voucherTypeFilter, plBucketFilter, routedBucketFilter, minAmount, hideCashBankOnly, search],
  );

  useEffect(() => {
    if (!workerRef.current) return;
    if (!data || data.length === 0) {
      setResult({
        vouchers: [],
        stats: {
          totalVouchersScanned: 0,
          totalFlagged: 0,
          totalOrphanAmount: 0,
          cashBankOnlyCount: 0,
          cashBankOnlyAmount: 0,
          byPLBucket: {
            sales: { count: 0, amount: 0 },
            purchase: { count: 0, amount: 0 },
            direct_income: { count: 0, amount: 0 },
            indirect_income: { count: 0, amount: 0 },
            direct_expense: { count: 0, amount: 0 },
            indirect_expense: { count: 0, amount: 0 },
          },
          byRoutedBucket: {
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
          },
          distinctVoucherTypes: [],
        },
        totalsUnfiltered: { flagged: 0, amount: 0 },
      });
      return;
    }
    setComputing(true);
    const t = setTimeout(() => {
      const payload: OrphanPLWorkerInput = { rows: data, filters: filtersSnapshot };
      workerRef.current?.postMessage(payload);
    }, 180);
    return () => clearTimeout(t);
  }, [data, filtersSnapshot]);

  // Sort client-side (cheap; the worker already sorts by amount DESC)
  const sortedVouchers = useMemo(() => {
    if (!result) return [];
    const arr = result.vouchers.slice();
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'amount':
          cmp = a.plAmount - b.plAmount;
          break;
        case 'date':
          cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
          break;
        case 'voucher_type':
          cmp = a.voucher_type.localeCompare(b.voucher_type);
          break;
        case 'voucher_number':
          cmp = a.voucher_number.localeCompare(b.voucher_number, undefined, { numeric: true });
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [result, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir(k === 'amount' ? 'desc' : 'asc');
    }
  };

  const toggleExpand = (guid: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(guid)) n.delete(guid);
      else n.add(guid);
      return n;
    });
  };

  const clearAllFilters = () => {
    setFromDate('');
    setToDate('');
    setSearch('');
    setVoucherTypeFilter('all');
    setPLBucketFilter('all');
    setRoutedBucketFilter('all');
    setMinAmount(0);
    setHideCashBankOnly(false);
  };

  const anyFilterActive =
    !!fromDate ||
    !!toDate ||
    !!search.trim() ||
    voucherTypeFilter !== 'all' ||
    plBucketFilter !== 'all' ||
    routedBucketFilter !== 'all' ||
    minAmount > 0 ||
    hideCashBankOnly;

  // ── Excel Export ─────────────────────────────────────────────────────────────
  const exportExcel = async () => {
    if (!result) return;
    try {
      setExporting(true);
      const XLSX = await import('xlsx-js-style');

      const thinBorder = {
        top: { style: 'thin', color: { rgb: 'D1D5DB' } },
        bottom: { style: 'thin', color: { rgb: 'D1D5DB' } },
        left: { style: 'thin', color: { rgb: 'D1D5DB' } },
        right: { style: 'thin', color: { rgb: 'D1D5DB' } },
      };
      const headerStyle = {
        font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '111827' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thinBorder,
      };
      const bodyStyle = (right: boolean, bold = false, numFmt?: string) => ({
        font: { name: 'Calibri', sz: 10, bold },
        alignment: { horizontal: right ? 'right' : 'left', vertical: 'center' },
        border: thinBorder,
        numFmt,
      });
      const totalStyle = (right: boolean, numFmt?: string) => ({
        font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '0F766E' } },
        alignment: { horizontal: right ? 'right' : 'left' },
        border: thinBorder,
        numFmt,
      });
      const paint = (ws: any, r: number, c: number, style: any) => {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (cell) cell.s = style;
      };

      const wb = XLSX.utils.book_new();

      // ═════════ Sheet 1: Summary ═════════
      {
        const s = result.stats;
        const aoa: any[][] = [
          ['Orphan P&L Vouchers — Audit Exception Report'],
          [
            `Vouchers scanned: ${s.totalVouchersScanned.toLocaleString('en-IN')} · Flagged: ${s.totalFlagged.toLocaleString('en-IN')} · Orphan amount: ₹${moneyFull(s.totalOrphanAmount)}`,
          ],
          [
            `Cash/Bank-only vouchers: ${s.cashBankOnlyCount.toLocaleString('en-IN')} (₹${moneyFull(s.cashBankOnlyAmount)})`,
          ],
          [''],
          ['By P&L bucket'],
          ['Bucket', 'Voucher Count', 'Orphan Amount'],
        ];
        (Object.keys(PL_BUCKET_META) as PLBucket[]).forEach((k) => {
          const b = s.byPLBucket[k];
          aoa.push([PL_BUCKET_META[k].label, b.count, b.amount]);
        });
        aoa.push([''], ['By Routed-Through bucket'], ['Bucket', 'Voucher Count', 'Orphan Amount']);
        (Object.keys(ROUTED_BUCKET_META) as RoutedBucket[]).forEach((k) => {
          const b = s.byRoutedBucket[k];
          aoa.push([ROUTED_BUCKET_META[k].label, b.count, b.amount]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 22 }];
        // title
        paint(ws, 0, 0, {
          font: { bold: true, sz: 14, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '7C2D12' } },
          alignment: { horizontal: 'left' },
        });
        ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
        XLSX.utils.book_append_sheet(wb, ws, 'Summary');
      }

      // ═════════ Sheet 2: Flagged Vouchers ═════════
      {
        const headers = [
          'Date',
          'Voucher Type',
          'Voucher #',
          'Narration',
          'P&L Bucket',
          'P&L Ledgers',
          'P&L Amount',
          'Routed-Through',
          'Counter Ledgers',
          'Counter Amount',
          'Cash/Bank Only?',
        ];
        const aoa: any[][] = [
          ['Flagged Orphan Vouchers — sorted by orphan amount DESC'],
          [''],
          headers,
        ];
        sortedVouchers.forEach((v) => {
          aoa.push([
            toDdMmYyyy(v.date),
            v.voucher_type,
            v.voucher_number,
            v.narration,
            PL_BUCKET_META[v.dominantPLBucket].label,
            v.plLegs.map((l) => `${l.ledger} [${moneyFull(Math.abs(l.amount))}]`).join(' | '),
            v.plAmount,
            ROUTED_BUCKET_META[v.dominantRoutedBucket].label,
            v.counterLegs.map((l) => `${l.ledger} [${moneyFull(Math.abs(l.amount))}]`).join(' | '),
            v.counterAmount,
            v.isCashBankOnly ? 'YES' : '',
          ]);
        });
        // totals
        const totalAmt = sortedVouchers.reduce((s, v) => s + v.plAmount, 0);
        const totalCounter = sortedVouchers.reduce((s, v) => s + v.counterAmount, 0);
        aoa.push(['TOTALS', '', '', '', '', '', totalAmt, '', '', totalCounter, '']);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [
          { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 40 }, { wch: 22 },
          { wch: 60 }, { wch: 16 }, { wch: 22 }, { wch: 60 }, { wch: 16 }, { wch: 14 },
        ];
        ws['!freeze'] = { xSplit: 0, ySplit: 3 };
        // Header row styling
        for (let c = 0; c < headers.length; c++) paint(ws, 2, c, headerStyle);
        // Body rows
        for (let r = 3; r < 3 + sortedVouchers.length; r++) {
          for (let c = 0; c < headers.length; c++) {
            const isNumeric = c === 6 || c === 9;
            paint(ws, r, c, bodyStyle(isNumeric, false, isNumeric ? '#,##0.00' : undefined));
          }
        }
        // Totals row
        const totalRow = 3 + sortedVouchers.length;
        for (let c = 0; c < headers.length; c++) {
          const isNumeric = c === 6 || c === 9;
          paint(ws, totalRow, c, totalStyle(isNumeric, isNumeric ? '#,##0.00' : undefined));
        }
        ws['!autofilter'] = {
          ref: XLSX.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: 2, c: headers.length - 1 } }),
        };
        XLSX.utils.book_append_sheet(wb, ws, 'Flagged Vouchers');
      }

      // ═════════ Sheet 3: Leg-level detail (one row per ledger hit) ═════════
      {
        const headers = [
          'Voucher Date', 'Voucher Type', 'Voucher #', 'Role', 'Ledger',
          'Primary Group', 'Bucket', 'Amount',
        ];
        const aoa: any[][] = [['Leg-level detail for every flagged voucher'], [''], headers];
        sortedVouchers.forEach((v) => {
          v.plLegs.forEach((l) =>
            aoa.push([
              toDdMmYyyy(v.date),
              v.voucher_type,
              v.voucher_number,
              'P&L',
              l.ledger,
              l.primaryGroup,
              l.plBucket ? PL_BUCKET_META[l.plBucket].label : '',
              l.amount,
            ]),
          );
          v.counterLegs.forEach((l) =>
            aoa.push([
              toDdMmYyyy(v.date),
              v.voucher_type,
              v.voucher_number,
              'Counter',
              l.ledger,
              l.primaryGroup,
              l.routedBucket ? ROUTED_BUCKET_META[l.routedBucket].label : '',
              l.amount,
            ]),
          );
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [
          { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 40 },
          { wch: 26 }, { wch: 22 }, { wch: 16 },
        ];
        ws['!freeze'] = { xSplit: 0, ySplit: 3 };
        for (let c = 0; c < headers.length; c++) paint(ws, 2, c, headerStyle);
        for (let r = 3; r < aoa.length; r++) {
          for (let c = 0; c < headers.length; c++) {
            const isNumeric = c === 7;
            paint(ws, r, c, bodyStyle(isNumeric, false, isNumeric ? '#,##0.00' : undefined));
          }
        }
        ws['!autofilter'] = {
          ref: XLSX.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: 2, c: headers.length - 1 } }),
        };
        XLSX.utils.book_append_sheet(wb, ws, 'Leg Detail');
      }

      const ts = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `Orphan-PL-Vouchers-${ts}.xlsx`);
    } catch (e) {
      console.error('Orphan PL export failed', e);
    } finally {
      setExporting(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const stats = result?.stats;
  const totalsUnfiltered = result?.totalsUnfiltered;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Module</p>
            <h3 className="text-xl font-black text-slate-900 flex items-center gap-2">
              <AlertTriangle size={20} className="text-amber-600" /> Orphan P&L Vouchers
            </h3>
            <p className="text-sm text-slate-500 mt-1 max-w-3xl">
              Vouchers where a Profit & Loss ledger moves but <span className="font-semibold">no Sundry Creditor / Sundry Debtor</span> is on the counter side.
              These bypass the normal party-invoice workflow — direct bank payments, journal adjustments against loans/capital, cash sales, and inter-ledger hacks.
              {plLedgerCount !== null && (
                <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 text-[10px] font-bold uppercase tracking-wider"
                      title="P&L universe sourced from mst_group.is_revenue=true (authoritative). Worker classifies hits via TallyPrimary which the shim populates from this same group flag.">
                  {plLedgerCount} P&L ledgers in scope
                </span>
              )}
              {computing && (
                <span className="ml-3 inline-flex items-center gap-1 text-indigo-600 font-semibold">
                  <Loader2 size={12} className="animate-spin" /> Computing…
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportExcel}
              disabled={exporting || !result || result.vouchers.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-60"
            >
              {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
        </div>

        {/* KPI cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="Vouchers Flagged"
              value={stats.totalFlagged.toLocaleString('en-IN')}
              sub={totalsUnfiltered ? `of ${totalsUnfiltered.flagged.toLocaleString('en-IN')} total orphans` : ''}
              tone="rose"
            />
            <KpiCard
              label="Orphan Amount"
              value={compact(stats.totalOrphanAmount)}
              sub={`₹${moneyFull(stats.totalOrphanAmount)}`}
              tone="orange"
            />
            <KpiCard
              label="Cash / Bank Only"
              value={stats.cashBankOnlyCount.toLocaleString('en-IN')}
              sub={`${compact(stats.cashBankOnlyAmount)} paid direct`}
              tone="sky"
            />
            <KpiCard
              label="Vouchers Scanned"
              value={stats.totalVouchersScanned.toLocaleString('en-IN')}
              sub={`${(stats.totalFlagged && stats.totalVouchersScanned
                ? ((stats.totalFlagged / stats.totalVouchersScanned) * 100).toFixed(2)
                : '0.00')}% are orphans`}
              tone="slate"
            />
          </div>
        )}

        {/* Bucket breakdown — clickable filters */}
        {stats && (
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                By P&L Bucket
              </p>
              <div className="flex flex-wrap gap-1.5">
                <BucketChip
                  active={plBucketFilter === 'all'}
                  onClick={() => setPLBucketFilter('all')}
                  label="All"
                  count={stats.totalFlagged}
                  amount={stats.totalOrphanAmount}
                  tone="slate"
                />
                {(Object.keys(PL_BUCKET_META) as PLBucket[]).map((k) => {
                  const b = stats.byPLBucket[k];
                  if (b.count === 0) return null;
                  const meta = PL_BUCKET_META[k];
                  return (
                    <BucketChip
                      key={k}
                      active={plBucketFilter === k}
                      onClick={() => setPLBucketFilter(plBucketFilter === k ? 'all' : k)}
                      label={meta.short}
                      count={b.count}
                      amount={b.amount}
                      bgCls={meta.bg}
                      textCls={meta.text}
                      borderCls={meta.border}
                    />
                  );
                })}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                By Routed-Through
              </p>
              <div className="flex flex-wrap gap-1.5">
                <BucketChip
                  active={routedBucketFilter === 'all'}
                  onClick={() => setRoutedBucketFilter('all')}
                  label="All"
                  count={stats.totalFlagged}
                  amount={stats.totalOrphanAmount}
                  tone="slate"
                />
                {(Object.keys(ROUTED_BUCKET_META) as RoutedBucket[]).map((k) => {
                  const b = stats.byRoutedBucket[k];
                  if (b.count === 0) return null;
                  const meta = ROUTED_BUCKET_META[k];
                  return (
                    <BucketChip
                      key={k}
                      active={routedBucketFilter === k}
                      onClick={() => setRoutedBucketFilter(routedBucketFilter === k ? 'all' : k)}
                      label={meta.short}
                      count={b.count}
                      amount={b.amount}
                      bgCls={meta.bg}
                      textCls={meta.text}
                      borderCls={meta.border}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Filters row */}
        <div className="pt-2 border-t border-slate-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-2">
          <div className="relative col-span-2">
            <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search narration, ledger, voucher #"
              className="w-full pl-8 pr-8 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-2 p-0.5 text-slate-400 hover:text-slate-700"
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">Voucher Type</label>
            <select
              value={voucherTypeFilter}
              onChange={(e) => setVoucherTypeFilter(e.target.value)}
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="all">All ({stats?.distinctVoucherTypes.length ?? 0})</option>
              {(stats?.distinctVoucherTypes ?? []).map((vt) => (
                <option key={vt} value={vt}>
                  {vt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">
              Min Orphan Amt
            </label>
            <input
              type="number"
              min={0}
              step={1000}
              value={minAmount || ''}
              onChange={(e) => setMinAmount(Number(e.target.value) || 0)}
              placeholder="e.g. 10000"
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg tabular-nums"
            />
          </div>
        </div>

        {/* Cash/Bank-only chip + clear-all */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={() => setHideCashBankOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
              hideCashBankOnly
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
            title="Hide vouchers where the counter-leg is only Bank / Cash — useful for focusing on journal-to-loan / capital cases"
          >
            {hideCashBankOnly ? <EyeOff size={12} /> : <Eye size={12} />}
            {hideCashBankOnly ? 'Showing only non-cash/bank orphans' : 'Hide Cash/Bank-only vouchers'}
            {stats && !hideCashBankOnly && stats.cashBankOnlyCount > 0 && (
              <span className="text-[10px] opacity-70">({stats.cashBankOnlyCount} would hide)</span>
            )}
          </button>
          {anyFilterActive && (
            <button
              onClick={clearAllFilters}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100"
            >
              <X size={12} /> Clear all filters
            </button>
          )}
          <span className="text-[11px] text-slate-500 ml-auto inline-flex items-center gap-1">
            <Filter size={11} /> {sortedVouchers.length.toLocaleString('en-IN')} voucher
            {sortedVouchers.length === 1 ? '' : 's'} in view
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-auto max-h-[72vh]">
        <table
          className="w-full text-sm border-separate border-spacing-0"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          <colgroup>
            <col style={{ width: 32 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 280 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 280 }} />
            <col style={{ width: 140 }} />
          </colgroup>
          <thead className="bg-slate-100 text-slate-600 text-[11px] font-bold uppercase tracking-wider sticky top-0 z-20">
            <tr>
              <th className="px-2 py-2 border-b border-slate-200 bg-slate-100"></th>
              <SortableHeader
                label="Date"
                k="date"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={() => toggleSort('date')}
                align="left"
              />
              <SortableHeader
                label="Type"
                k="voucher_type"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={() => toggleSort('voucher_type')}
                align="left"
              />
              <SortableHeader
                label="Voucher #"
                k="voucher_number"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={() => toggleSort('voucher_number')}
                align="left"
              />
              <th className="px-3 py-2 border-b border-slate-200 bg-slate-100 text-left">
                P&L Bucket
              </th>
              <th className="px-3 py-2 border-b border-slate-200 bg-slate-100 text-left">
                P&L Ledger(s)
              </th>
              <SortableHeader
                label="Orphan Amount"
                k="amount"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={() => toggleSort('amount')}
                align="right"
              />
              <th className="px-3 py-2 border-b border-slate-200 bg-slate-100 text-left">
                Routed-Through
              </th>
              <th className="px-3 py-2 border-b border-slate-200 bg-slate-100 text-left">
                Counter Ledger(s)
              </th>
              <th className="px-3 py-2 border-b border-slate-200 bg-slate-100 text-left">
                Flags
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedVouchers.map((v, idx) => {
              const isOpen = expanded.has(v.guid);
              const stripe = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60';
              const plMeta = PL_BUCKET_META[v.dominantPLBucket];
              const rMeta = ROUTED_BUCKET_META[v.dominantRoutedBucket];
              const RIcon = rMeta.Icon;
              return (
                <React.Fragment key={v.guid}>
                  <tr
                    onClick={() => toggleExpand(v.guid)}
                    className={`cursor-pointer hover:bg-indigo-50/40 transition-colors ${stripe} ${
                      isOpen ? 'ring-1 ring-inset ring-indigo-200' : ''
                    }`}
                    style={{ contentVisibility: 'auto', containIntrinsicSize: '42px' } as any}
                  >
                    <td className="px-2 py-2 text-slate-400 border-b border-slate-100 text-center">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-slate-700">
                      {toDdMmYyyy(v.date)}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-slate-600 text-[12px]">
                      {v.voucher_type}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 font-mono text-[12px] text-slate-800">
                      {v.voucher_number}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10.5px] font-semibold ${plMeta.bg} ${plMeta.text} ${plMeta.border}`}
                      >
                        {plMeta.short}
                      </span>
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <LedgerStack legs={v.plLegs} />
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-right font-mono tabular-nums font-bold text-rose-700" title={moneyFull(v.plAmount)}>
                      {compact(v.plAmount)}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10.5px] font-semibold ${rMeta.bg} ${rMeta.text} ${rMeta.border}`}
                      >
                        <RIcon size={11} />
                        {rMeta.short}
                      </span>
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <LedgerStack legs={v.counterLegs} muted />
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      {v.isCashBankOnly ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-50 border border-sky-200 text-sky-700 text-[10px] font-semibold">
                          Cash/Bank only
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50/50">
                      <td colSpan={10} className="px-6 py-3 border-b border-slate-200">
                        <VoucherDetail voucher={v} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {sortedVouchers.length === 0 && !computing && (
              <tr>
                <td className="px-4 py-10 text-center text-slate-400" colSpan={10}>
                  {stats && stats.totalVouchersScanned === 0
                    ? 'No data loaded.'
                    : stats && stats.totalFlagged === 0 && !anyFilterActive
                    ? 'No orphan P&L vouchers — every P&L ledger is routed through a Sundry party. ✅'
                    : 'No vouchers match the current filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-900 text-sm">
        <p className="font-bold mb-1 flex items-center gap-1.5">
          <AlertTriangle size={14} /> How to read this module
        </p>
        <p className="text-[13px]">
          Every voucher listed here hits a Profit & Loss ledger but has{' '}
          <span className="font-semibold">no Sundry Creditor or Sundry Debtor</span> on the counter side.
          Typical patterns: expense paid direct from bank (no vendor invoice), journal adjusting expense
          against a loan/capital ledger, cash sales, or inter-ledger workarounds.
        </p>
        <p className="text-[12px] mt-2 text-amber-800">
          Click a row to see every leg of the voucher with its primary group.
          Use <span className="font-semibold">Hide Cash/Bank-only</span> to surface the weirder journal
          adjustments first — those are the highest-audit-interest cases.
        </p>
      </div>
    </div>
  );
};

// ═══════════════ Sub-components ═══════════════════════════════════════════════

const KpiCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  tone: 'rose' | 'orange' | 'sky' | 'slate';
}> = ({ label, value, sub, tone }) => {
  const tones = {
    rose:   'from-rose-50 to-rose-100 border-rose-200 text-rose-900',
    orange: 'from-orange-50 to-orange-100 border-orange-200 text-orange-900',
    sky:    'from-sky-50 to-sky-100 border-sky-200 text-sky-900',
    slate:  'from-slate-50 to-slate-100 border-slate-200 text-slate-800',
  } as const;
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-3 ${tones[tone]}`}>
      <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">{label}</p>
      <p className="text-xl font-black tabular-nums mt-1">{value}</p>
      {sub && <p className="text-[10.5px] opacity-75 mt-0.5 tabular-nums">{sub}</p>}
    </div>
  );
};

const BucketChip: React.FC<{
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  amount: number;
  tone?: 'slate';
  bgCls?: string;
  textCls?: string;
  borderCls?: string;
}> = ({ active, onClick, label, count, amount, tone, bgCls, textCls, borderCls }) => {
  const base = tone === 'slate' ? 'bg-slate-100 text-slate-700 border-slate-300' : `${bgCls} ${textCls} ${borderCls}`;
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-shadow ${base} ${
        active ? 'shadow-md ring-2 ring-offset-1 ring-indigo-400' : 'hover:shadow-sm'
      }`}
    >
      <span>{label}</span>
      <span className="opacity-70 tabular-nums">· {count}</span>
      <span className="opacity-80 tabular-nums font-mono">{compact(amount)}</span>
    </button>
  );
};

const SortableHeader: React.FC<{
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onClick: () => void;
  align: 'left' | 'right';
}> = ({ label, k, sortKey, sortDir, onClick, align }) => {
  const isActive = sortKey === k;
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 border-b border-slate-200 bg-slate-100 cursor-pointer select-none whitespace-nowrap ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      <span
        className={`inline-flex items-center gap-1 ${
          align === 'right' ? 'justify-end' : ''
        }`}
      >
        {label}
        {isActive ? (
          sortDir === 'asc' ? (
            <ArrowUp size={10} className="text-indigo-600" />
          ) : (
            <ArrowDown size={10} className="text-indigo-600" />
          )
        ) : (
          <span className="opacity-30 text-[9px]">⇅</span>
        )}
      </span>
    </th>
  );
};

const LedgerStack: React.FC<{
  legs: OrphanPLVoucher['plLegs'];
  muted?: boolean;
}> = ({ legs, muted }) => {
  if (legs.length === 0) return <span className="text-[10px] italic text-slate-400">—</span>;
  const visible = legs.slice(0, 2);
  const extra = legs.length - visible.length;
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      {visible.map((l, i) => (
        <div key={`${l.ledger}-${i}`} className="flex items-center gap-1.5 min-w-0">
          <span
            className={`truncate text-[12px] ${muted ? 'text-slate-600' : 'font-semibold text-slate-800'}`}
            title={`${l.ledger} · ${l.primaryGroup} · ${moneyFull(Math.abs(l.amount))}`}
          >
            {l.ledger}
          </span>
          <span className="shrink-0 text-[10.5px] font-mono tabular-nums text-slate-500">
            {compact(Math.abs(l.amount))}
          </span>
        </div>
      ))}
      {extra > 0 && (
        <span className="text-[10px] text-slate-400">+{extra} more leg{extra === 1 ? '' : 's'}</span>
      )}
    </div>
  );
};

const VoucherDetail: React.FC<{ voucher: OrphanPLVoucher }> = ({ voucher: v }) => {
  const total = v.plAmount + v.counterAmount; // purely diagnostic
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          Voucher legs
        </span>
        <span className="text-[10px] text-slate-400">
          {v.plLegs.length} P&L · {v.counterLegs.length} counter
        </span>
        {v.narration && (
          <span className="text-[11px] text-slate-600 italic truncate max-w-xl" title={v.narration}>
            "{v.narration}"
          </span>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <LegTable title="P&L legs" legs={v.plLegs} palette="pl" />
        <LegTable title="Counter legs" legs={v.counterLegs} palette="counter" />
      </div>

      <p className="text-[10px] text-slate-400 italic">
        Orphan amount: {compact(v.plAmount)} · Counter total: {compact(v.counterAmount)}
        {Math.abs(v.plAmount - v.counterAmount) > 1 && total > 0 && (
          <span className="text-rose-600 font-semibold ml-2">
            · Imbalance of {compact(Math.abs(v.plAmount - v.counterAmount))}
          </span>
        )}
      </p>
    </div>
  );
};

const LegTable: React.FC<{
  title: string;
  legs: OrphanPLVoucher['plLegs'];
  palette: 'pl' | 'counter';
}> = ({ title, legs, palette }) => (
  <div className="border border-slate-200 rounded-lg overflow-hidden">
    <div
      className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${
        palette === 'pl' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'
      }`}
    >
      {title}
    </div>
    <table className="w-full text-[12px]">
      <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
        <tr>
          <th className="px-3 py-1.5 text-left font-semibold">Ledger</th>
          <th className="px-3 py-1.5 text-left font-semibold">Primary Group</th>
          <th className="px-3 py-1.5 text-right font-semibold">Amount</th>
        </tr>
      </thead>
      <tbody>
        {legs.length === 0 ? (
          <tr>
            <td colSpan={3} className="px-3 py-2 text-slate-400 italic">
              None
            </td>
          </tr>
        ) : (
          legs.map((l, i) => (
            <tr key={`${l.ledger}-${i}`} className="border-t border-slate-100">
              <td className="px-3 py-1.5 text-slate-800 font-medium">{l.ledger}</td>
              <td className="px-3 py-1.5 text-slate-600">{l.primaryGroup}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums" title={moneyFull(Math.abs(l.amount))}>
                {compact(Math.abs(l.amount))}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

export default OrphanPLVouchers;
