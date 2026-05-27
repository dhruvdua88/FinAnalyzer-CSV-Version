// Purchase Register — ITC format.
//
// Ported from purchase_register_itc.py / purchase_register_gui.py.
// Reads directly from the TallyStore so we get the proper group-chain walk
// and ledger-master classification instead of the old name-heuristic.
//
// Outputs the ITC sheet exactly (one row per eligible voucher) plus four
// in-app issue panels: RCM Review, CGST≠SGST, blank/invalid GSTIN, missing
// invoice number. ITC Summary / GL Control / Orphan GST / Ledger Audit are
// deferred to Stage 4 of the refactor.

import React, { useMemo, useState } from 'react';
import { Download, AlertCircle, AlertTriangle, FileWarning, ShieldAlert, Search } from 'lucide-react';
import { LedgerEntry } from '../../types';
import {
  getPurchaseITCRegister,
  deriveItcIssues,
  dateRangeOf,
  useTallyStore,
  type ItcRow,
  type ItcType,
} from '../../services/tally';

interface PurchaseGSTRegisterProps {
  // Already month-filtered by FileUpload; used only to derive the date
  // range that scopes the ITC query. The relational TallyStore is read
  // from context (TallyStoreProvider in App.tsx) — modules that need it
  // call useTallyStore() rather than receiving it as a prop, so future
  // module migrations don't all force a prop-signature change.
  data: LedgerEntry[];
}

const TYPE_BADGE_CLASS: Record<ItcType, string> = {
  B2B: 'bg-blue-50 text-blue-700 border-blue-200',
  'RCM-UR': 'bg-orange-50 text-orange-700 border-orange-200',
  IMPORTSERVICE: 'bg-purple-50 text-purple-700 border-purple-200',
};

const formatINR = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDDMMYYYY = (iso: string): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

// Spread an ItcRow into the column shape used by the Excel export. Keeping
// labels human-readable so the workbook is meaningful straight out of the
// download.
const toExcelRow = (r: ItcRow) => ({
  'Party GSTIN/UIN': r.partyGstinUin,
  'Party Name': r.partyName,
  'Vch No.': r.vchNo,
  'Date': formatDDMMYYYY(r.date),
  'Taxable': r.taxable,
  'IGST': r.igst,
  'CGST': r.cgst,
  'SGST': r.sgst,
  'Tax': r.tax,
  'Place of Supply': r.placeOfSupply,
  'Reverse Charge': r.reverseCharge,
  'ITC Availability': r.itcAvailability,
  'Type': r.type,
  '3B Month': r.m3b,
  'Books Month': r.booksMonth,
  'FY': r.fy,
  'Posting Date': formatDDMMYYYY(r.postingDate),
  'Expense Ledgers': r.expenseLedgers,
  'Voucher Type': r.voucherType,
  'Voucher Number': r.voucherNumber,
  'Primary Group': r.primaryGroup,
  'ITC Type': r.itcType,
  'Narration': r.narration,
  'Review Flag': r.reviewFlag,
  'GUID': r.guid,
});

const PurchaseGSTRegister: React.FC<PurchaseGSTRegisterProps> = ({ data }) => {
  const store = useTallyStore();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ItcType | 'ALL'>('ALL');
  const [activeIssue, setActiveIssue] = useState<null | 'rcm' | 'cgstSgst' | 'gstin' | 'noInv'>(null);
  const [isExporting, setIsExporting] = useState(false);

  // The query operates on the store's full date span by default; we narrow
  // it to the months the user selected at import time so the on-screen view
  // matches the rest of the app.
  const { dateFrom, dateTo } = useMemo(() => dateRangeOf(data), [data]);

  const allRows = useMemo<ItcRow[]>(() => {
    if (!store) return [];
    return getPurchaseITCRegister(store, { dateFrom, dateTo });
  }, [store, dateFrom, dateTo]);

  const issues = useMemo(() => deriveItcIssues(allRows), [allRows]);

  // Which rows the table renders: type filter ∩ search ∩ optional issue
  const visibleRows = useMemo<ItcRow[]>(() => {
    let rows = allRows;
    if (typeFilter !== 'ALL') rows = rows.filter((r) => r.type === typeFilter);
    if (activeIssue === 'rcm') rows = issues.rcmReview.filter((r) => rows.includes(r));
    else if (activeIssue === 'cgstSgst') rows = issues.cgstSgstMismatch.filter((r) => rows.includes(r));
    else if (activeIssue === 'gstin') rows = issues.blankInvalidGstin.filter((r) => rows.includes(r));
    else if (activeIssue === 'noInv') rows = issues.noInvoiceNumber.filter((r) => rows.includes(r));
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        r.partyName.toLowerCase().includes(q) ||
        r.partyGstinUin.toLowerCase().includes(q) ||
        r.vchNo.toLowerCase().includes(q) ||
        r.voucherNumber.toLowerCase().includes(q) ||
        r.expenseLedgers.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [allRows, typeFilter, activeIssue, issues, search]);

  // Footer totals reflect what's on screen, not the whole register — matches
  // user expectations when filtering.
  const totals = useMemo(() => {
    let taxable = 0, igst = 0, cgst = 0, sgst = 0, tax = 0;
    for (const r of visibleRows) {
      taxable += r.taxable; igst += r.igst; cgst += r.cgst; sgst += r.sgst; tax += r.tax;
    }
    return { taxable, igst, cgst, sgst, tax, count: visibleRows.length };
  }, [visibleRows]);

  const handleExport = async () => {
    if (allRows.length === 0) return;
    setIsExporting(true);
    try {
      const XLSX = await import('xlsx');
      const exportRows = allRows.map(toExcelRow);
      const ws = XLSX.utils.json_to_sheet(exportRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ITC');
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `Purchase_Register_ITC_${stamp}.xlsx`, { compression: true });
    } finally {
      setIsExporting(false);
    }
  };

  // ── Empty / fallback states ────────────────────────────────────────────────
  if (!store) {
    return (
      <div className="bg-white border border-amber-200 rounded-2xl p-8 shadow-sm">
        <div className="flex gap-4 items-start">
          <div className="shrink-0 w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
            <AlertCircle size={24} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Tally Excel Export (ZIP) required</h2>
            <p className="text-sm text-slate-600 mt-1 leading-relaxed">
              The Purchase Register builds the ITC schedule by walking <code>mst_group</code> parent chains
              and reading <code>mst_ledger.gst_duty_head</code> — fields only the Tally Excel Export ZIP
              carries. The legacy live-loader import doesn't expose them.
            </p>
            <p className="text-sm text-slate-600 mt-2">
              Return to the file picker and choose <strong>Import Tally Excel Export (ZIP)</strong>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-500">
        No eligible purchase / expense / fixed-asset vouchers found in the selected period.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Issue panels ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <IssueCard
          icon={<AlertTriangle size={18} />} accent="orange"
          title="RCM Review" subtitle="Tax = ₹ 0"
          count={issues.rcmReview.length}
          active={activeIssue === 'rcm'}
          onClick={() => setActiveIssue((p) => (p === 'rcm' ? null : 'rcm'))}
        />
        <IssueCard
          icon={<ShieldAlert size={18} />} accent="red"
          title="CGST ≠ SGST" subtitle="Data entry error"
          count={issues.cgstSgstMismatch.length}
          active={activeIssue === 'cgstSgst'}
          onClick={() => setActiveIssue((p) => (p === 'cgstSgst' ? null : 'cgstSgst'))}
        />
        <IssueCard
          icon={<FileWarning size={18} />} accent="yellow"
          title="Blank / Invalid GSTIN" subtitle="Tax > 0"
          count={issues.blankInvalidGstin.length}
          active={activeIssue === 'gstin'}
          onClick={() => setActiveIssue((p) => (p === 'gstin' ? null : 'gstin'))}
        />
        <IssueCard
          icon={<FileWarning size={18} />} accent="yellow"
          title="Missing Invoice No." subtitle="Tax > 0"
          count={issues.noInvoiceNumber.length}
          active={activeIssue === 'noInv'}
          onClick={() => setActiveIssue((p) => (p === 'noInv' ? null : 'noInv'))}
        />
      </div>

      {/* ── Filter / search / export bar ──────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-3 shadow-sm">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search party, GSTIN, invoice, voucher#, ledger…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs font-semibold">
          {(['ALL', 'B2B', 'RCM-UR', 'IMPORTSERVICE'] as const).map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                typeFilter === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}>
              {t === 'IMPORTSERVICE' ? 'IMPORT-SVC' : t}
            </button>
          ))}
        </div>
        {activeIssue && (
          <button onClick={() => setActiveIssue(null)}
            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100">
            Clear issue filter
          </button>
        )}
        <button onClick={handleExport} disabled={isExporting}
          className="px-4 py-2 inline-flex items-center gap-2 text-sm font-bold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 transition-colors shadow-sm">
          <Download size={16} />
          {isExporting ? 'Exporting…' : 'Export Excel'}
        </button>
      </div>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto max-h-[640px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 font-semibold">
              <tr>
                <Th>Date</Th>
                <Th>Party</Th>
                <Th>GSTIN</Th>
                <Th>Vch No.</Th>
                <Th numeric>Taxable</Th>
                <Th numeric>IGST</Th>
                <Th numeric>CGST</Th>
                <Th numeric>SGST</Th>
                <Th numeric>Tax</Th>
                <Th>Type</Th>
                <Th>RC</Th>
                <Th>Books</Th>
                <Th>Primary Group</Th>
                <Th>ITC Type</Th>
                <Th>Expense Ledgers</Th>
                <Th>Voucher#</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleRows.map((r) => (
                <tr key={r.guid} className={`hover:bg-slate-50 ${r.tax === 0 ? 'bg-orange-50/30' : ''}`}>
                  <Td>{formatDDMMYYYY(r.date)}</Td>
                  <Td className="font-medium text-slate-800">{r.partyName}</Td>
                  <Td className="font-mono text-[11px]">{r.partyGstinUin}</Td>
                  <Td>{r.vchNo}</Td>
                  <Td numeric>{formatINR(r.taxable)}</Td>
                  <Td numeric>{r.igst ? formatINR(r.igst) : '—'}</Td>
                  <Td numeric>{r.cgst ? formatINR(r.cgst) : '—'}</Td>
                  <Td numeric>{r.sgst ? formatINR(r.sgst) : '—'}</Td>
                  <Td numeric className="font-bold">{formatINR(r.tax)}</Td>
                  <Td>
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${TYPE_BADGE_CLASS[r.type]}`}>
                      {r.type === 'IMPORTSERVICE' ? 'IMPORT-SVC' : r.type}
                    </span>
                  </Td>
                  <Td className={`text-center ${r.reverseCharge === 'Y' ? 'text-orange-700 font-bold' : 'text-slate-400'}`}>
                    {r.reverseCharge}
                  </Td>
                  <Td>{r.booksMonth}</Td>
                  <Td>{r.primaryGroup}</Td>
                  <Td>{r.itcType}</Td>
                  <Td className="max-w-[220px] truncate" title={r.expenseLedgers}>{r.expenseLedgers}</Td>
                  <Td>{r.voucherNumber}</Td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={16} className="py-8 text-center text-slate-400 text-sm">
                    No rows match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
            {visibleRows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-900 text-white font-bold text-[11px]">
                <tr>
                  <td colSpan={4} className="px-3 py-2">
                    {totals.count} {totals.count === 1 ? 'voucher' : 'vouchers'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.taxable)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.igst)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.cgst)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.sgst)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.tax)}</td>
                  <td colSpan={7}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ── Footnote: classification rules ───────────────────────────────── */}
      <details className="bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 group">
        <summary className="px-4 py-2.5 cursor-pointer font-semibold text-slate-700 hover:bg-slate-100 rounded-xl select-none">
          How vouchers are classified
        </summary>
        <div className="px-4 pb-4 pt-2 space-y-1 leading-relaxed">
          <p><strong>Eligible voucher:</strong> <code>is_accounting_voucher = 1</code> AND has at least one accounting line under Purchase Accounts / Direct Expenses / Indirect Expenses / Fixed Assets (parent-chain walk).</p>
          <p><strong>GST input ledger:</strong> parent group = <code>GST</code> OR (parent = <code>Duties &amp; Taxes</code> AND <code>gst_duty_head</code> populated), AND name does <em>not</em> contain output-tax keywords (<code>output</code>, <code>sales cgst/igst/sgst</code>, <code>payable/c</code>, <code>gst payable</code>, <code>gst cash</code>, <code>accrued</code>).</p>
          <p><strong>RCM input:</strong> GST input ledger with <code>RCM</code> in name; excludes <code>RCM Payable</code>.</p>
          <p><strong>Type:</strong> <code>RCM-UR</code> if any RCM line; else <code>IMPORTSERVICE</code> if no supplier GSTIN AND IGST&gt;0 AND CGST=0; else <code>B2B</code>.</p>
          <p><strong>Invoice number:</strong> <code>reference_number</code> (supplier inv#) if present, else <code>voucher_number</code>. <strong>Invoice date:</strong> <code>reference_date</code> if present, else voucher date.</p>
        </div>
      </details>
    </div>
  );
};

// ── Sub-components ─────────────────────────────────────────────────────────

const IssueCard: React.FC<{
  icon: React.ReactNode;
  accent: 'orange' | 'red' | 'yellow';
  title: string;
  subtitle: string;
  count: number;
  active: boolean;
  onClick: () => void;
}> = ({ icon, accent, title, subtitle, count, active, onClick }) => {
  const accentMap = {
    orange: { ring: 'ring-orange-400', border: 'border-orange-200', text: 'text-orange-700', bg: 'bg-orange-50' },
    red:    { ring: 'ring-red-400',    border: 'border-red-200',    text: 'text-red-700',    bg: 'bg-red-50' },
    yellow: { ring: 'ring-yellow-400', border: 'border-yellow-200', text: 'text-yellow-700', bg: 'bg-yellow-50' },
  } as const;
  const c = accentMap[accent];
  const okState = count === 0;

  return (
    <button onClick={onClick} disabled={okState && !active}
      className={`text-left p-3 rounded-xl border bg-white shadow-sm transition-all ${
        active ? `ring-2 ${c.ring} ${c.border}` : 'border-slate-200 hover:border-slate-300'
      } ${okState ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}>
      <div className="flex items-start gap-2">
        <div className={`shrink-0 w-8 h-8 rounded-lg ${c.bg} ${c.text} flex items-center justify-center`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-slate-900 truncate">{title}</p>
          <p className="text-[10px] text-slate-500 truncate">{subtitle}</p>
        </div>
        <div className={`text-xl font-black ${okState ? 'text-emerald-600' : c.text}`}>
          {okState ? '✓' : count}
        </div>
      </div>
    </button>
  );
};

const Th: React.FC<{ children: React.ReactNode; numeric?: boolean }> = ({ children, numeric }) => (
  <th className={`px-3 py-2 ${numeric ? 'text-right' : 'text-left'} whitespace-nowrap`}>{children}</th>
);

const Td: React.FC<{ children: React.ReactNode; numeric?: boolean; className?: string; title?: string }> =
  ({ children, numeric, className = '', title }) => (
    <td title={title} className={`px-3 py-1.5 ${numeric ? 'text-right font-mono tabular-nums' : ''} ${className}`}>
      {children}
    </td>
  );

export default PurchaseGSTRegister;
