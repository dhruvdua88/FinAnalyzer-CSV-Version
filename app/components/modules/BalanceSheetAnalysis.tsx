import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { AlertTriangle, Building2, CheckCircle2, Download, FileSpreadsheet, Loader2, Scale, Sliders, Trash2, Upload } from 'lucide-react';
import { TallyStore, useTallyStore } from '../../services/tally';
import {
  BS_MAP,
  BsLineDef,
  BranchData,
  buildBranchFromStore,
  buildReport,
  collectPrimaryGroups,
  EXCLUDE_TARGET,
  PNL_LINE_DEFS,
  ReclassifyMap,
  STANDARD_PRIMARY_OPTIONS,
} from '../../services/balanceSheet';
import { buildFinancialStatementsWorkbook } from '../../services/financialStatementsExcel';

interface BranchEntry {
  id: string;
  store: TallyStore;
  branchName: string;
  source: 'loaded' | 'upload';
}

const fmt = (n: number): string => {
  const v = Math.round(n);
  if (v === 0) return '-';
  const abs = Math.abs(v).toLocaleString('en-IN');
  return v < 0 ? `(${abs})` : abs;
};

const headFor = (primary: string): string =>
  primary in BS_MAP ? BS_MAP[primary][1] : 'Profit & Loss';

let uid = 0;
const nextId = () => `br-${++uid}`;

const BalanceSheetAnalysis: React.FC = () => {
  const store = useTallyStore();
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [reclassify, setReclassify] = useState<ReclassifyMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showMapping, setShowMapping] = useState(false);
  const [view, setView] = useState<'bs' | 'pnl'>('bs');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Seed branch 1 from the currently-loaded dataset (if any).
  useEffect(() => {
    if (!store) return;
    setBranches((prev) => {
      if (prev.some((b) => b.source === 'loaded')) return prev;
      return [{ id: nextId(), store, branchName: store.meta?.companyName || 'Branch 1', source: 'loaded' }, ...prev];
    });
  }, [store]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLoading(true);
    setError('');
    try {
      const added: BranchEntry[] = [];
      for (const file of Array.from(files)) {
        const parsed = await TallyStore.fromZip(file);
        const label = parsed.meta?.companyName || file.name.replace(/\.zip$/i, '');
        added.push({ id: nextId(), store: parsed, branchName: label, source: 'upload' });
      }
      setBranches((prev) => [...prev, ...added]);
    } catch (e: any) {
      setError(e?.message || 'Failed to read one or more branch ZIP files.');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const removeBranch = (id: string) => setBranches((prev) => prev.filter((b) => b.id !== id));

  // Build per-branch financials (re-runs when branches or the mapping change).
  const branchData: BranchData[] = useMemo(
    () => branches.map((b) => buildBranchFromStore(b.store, b.branchName, reclassify)),
    [branches, reclassify],
  );

  const report = useMemo(() => (branchData.length ? buildReport(branchData) : null), [branchData]);

  // Lines for whichever statement is on screen.
  const shownLines = useMemo<Array<{ def: BsLineDef; values: number[] }>>(() => {
    if (!report) return [];
    if (view === 'bs') return report.lines;
    return PNL_LINE_DEFS.map((def) => ({
      def,
      values: def.fn ? report.columns.map((c) => def.fn!(c)) : report.columns.map(() => 0),
    }));
  }, [report, view]);

  const primaryGroups = useMemo(
    () => (branches.length ? collectPrimaryGroups(branches.map((b) => ({ store: b.store, branchName: b.branchName })), reclassify) : []),
    [branches, reclassify],
  );
  const unmappedCount = primaryGroups.filter((g) => g.resolution.how === 'unmapped').length;

  const setMapping = (rawPrimary: string, value: string) => {
    const key = rawPrimary.trim().toLowerCase();
    setReclassify((prev) => {
      const next = { ...prev };
      if (!value) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  // ── Build the statement AoA used by both CSV and Excel export ──
  const buildAoa = (): (string | number)[][] => {
    if (!report) return [];
    const head = ['Particulars', ...report.columns.map((c) => c.branchName)];
    const rows: (string | number)[][] = [head];
    for (const { def, values } of report.lines) {
      if (def.kind === 'plug' && values.every((v) => Math.round(v) === 0)) continue;
      const indent = '   '.repeat(def.indent || 0);
      rows.push([
        indent + def.label,
        ...(def.kind === 'header' ? values.map(() => '') : values.map((v) => Math.round(v))),
      ]);
    }
    return rows;
  };

  const exportCsv = () => {
    const aoa = buildAoa();
    if (!aoa.length) return;
    const csv = aoa.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'balance-sheet-schedule-iii.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = () => {
    if (!report) return;
    const companyTitle = report.consolidated
      ? `${report.branches.length} Branches — Consolidated`
      : branchData[0]?.company || branchData[0]?.branchName || 'Company';
    const wb = buildFinancialStatementsWorkbook({
      branches: branchData,
      consolidated: report.consolidated,
      companyTitle,
      periodLabel: report.columns[0]?.periodLabel || '',
      primaryGroups,
    });

    const stamp = (report.columns[0]?.periodTo || '').replace(/-/g, '') || 'export';
    const co = (report.consolidated ? 'Consolidated' : report.columns[0]?.branchName || 'FS')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .slice(0, 40);
    XLSX.writeFile(wb, `Financial_Statements_${co}_${stamp}.xlsx`, { compression: true, cellStyles: true });
  };

  const materialPlug = report
    ? report.lines.find((l) => l.def.key === 'plug')?.values.some((v, i) => {
        const ta = Math.abs(report.lines.find((x) => x.def.key === 'total_assets')!.values[i]);
        return ta < 1 ? Math.abs(v) > 1 : (Math.abs(v) / ta) * 100 > 1;
      })
    : false;

  const allUnclassified = useMemo(
    () => branchData.flatMap((b) => b.unclassified.map((u) => ({ ...u, branch: b.branchName }))),
    [branchData],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Scale size={22} /> Balance Sheet (Schedule III)
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            Multi-branch Companies Act 2013 Schedule III balance sheet. Each Tally export ZIP is one
            branch — add more to get per-branch columns plus a Consolidated total. Use{' '}
            <b>Map groups</b> to assign any non-standard Tally primary group to the right head.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileInputRef} type="file" accept=".zip" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            Add branch ZIP
          </button>
          {branches.length > 0 && (
            <button
              onClick={() => setShowMapping((s) => !s)}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${
                unmappedCount > 0
                  ? 'border-amber-400 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20'
                  : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              <Sliders size={16} /> Map groups
              {unmappedCount > 0 && (
                <span className="ml-1 rounded-full bg-amber-500 text-white text-xs px-1.5">{unmappedCount}</span>
              )}
            </button>
          )}
          {report && (
            <>
              <button
                onClick={exportExcel}
                className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              >
                <FileSpreadsheet size={16} /> Export Excel
              </button>
              <button
                onClick={exportCsv}
                className="inline-flex items-center gap-2 rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
              >
                <Download size={16} /> CSV
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {branches.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {branches.map((b, i) => (
            <span key={b.id} className="inline-flex items-center gap-2 rounded-full bg-slate-100 dark:bg-slate-700 px-3 py-1 text-sm text-slate-700 dark:text-slate-200">
              <Building2 size={14} />
              {b.branchName}
              {b.store.meta?.periodTo ? <span className="text-slate-400">· {branchData[i]?.periodLabel}</span> : null}
              <button onClick={() => removeBranch(b.id)} className="text-slate-400 hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      {!branches.length && (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-600 p-10 text-center text-slate-500 dark:text-slate-400">
          <Scale size={32} className="mx-auto mb-3 opacity-60" />
          <p className="font-medium">No data loaded.</p>
          <p className="text-sm mt-1">
            Import a Tally export ZIP from the main screen, or click <b>Add branch ZIP</b> to load one or
            more company / branch exports.
          </p>
        </div>
      )}

      {/* Mapping panel */}
      {showMapping && branches.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
              <Sliders size={15} /> Tally Primary Group → Schedule III Head
            </h3>
            <span className={`text-xs ${unmappedCount ? 'text-amber-600' : 'text-emerald-600'}`}>
              {unmappedCount ? `${unmappedCount} group(s) need mapping` : 'All groups mapped'}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Auto-detected mappings are shown. Override any row for non-standard groups; choose{' '}
            <i>(exclude)</i> to drop a group from the statement. Changes recompute the balance sheet
            instantly.
          </p>
          <div className="max-h-80 overflow-y-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200 dark:border-slate-700">
                  <th className="px-2 py-1">Tally Primary Group</th>
                  <th className="px-2 py-1 text-right">Ledgers</th>
                  <th className="px-2 py-1 text-right">Closing</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Map to</th>
                </tr>
              </thead>
              <tbody>
                {primaryGroups.map((g) => {
                  const r = g.resolution;
                  const key = g.rawPrimary.trim().toLowerCase();
                  const current = reclassify[key] || '';
                  const badge =
                    r.how === 'unmapped'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      : r.how === 'reclassified'
                      ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300'
                      : r.how === 'excluded'
                      ? 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
                  return (
                    <tr key={g.rawPrimary} className="border-b border-slate-100 dark:border-slate-700/60">
                      <td className="px-2 py-1 text-slate-700 dark:text-slate-200">{g.rawPrimary}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-500">{g.count}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmt(g.closingSum)}</td>
                      <td className="px-2 py-1">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${badge}`}>
                          {r.how}
                          {r.classified ? ` → ${headFor(r.primary)}` : ''}
                        </span>
                      </td>
                      <td className="px-2 py-1">
                        <select
                          value={current}
                          onChange={(e) => setMapping(g.rawPrimary, e.target.value)}
                          className="rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs px-1 py-0.5 text-slate-700 dark:text-slate-200"
                        >
                          <option value="">Auto ({r.classified ? r.primary : 'unmapped'})</option>
                          {STANDARD_PRIMARY_OPTIONS.map((grp) => (
                            <optgroup key={grp.group} label={grp.group}>
                              {grp.options.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt === EXCLUDE_TARGET ? 'Exclude from statement' : opt}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {report && !report.periodsMatch && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 flex gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Branches cover different periods, so a Consolidated column is not shown. Re-export each
            branch for the same financial year to consolidate.
          </span>
        </div>
      )}

      {materialPlug && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 flex gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            A material year-end reconciliation plug (&gt;1% of total assets) was needed to balance.
            This usually means Tally booked year-end adjustments (stock revaluation, forex, rounding)
            outside the accounting vouchers. The figure is shown on the face below.
          </span>
        </div>
      )}

      {report && unmappedCount === 0 && !materialPlug && report.periodsMatch && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-700 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300 flex gap-2 items-center">
          <CheckCircle2 size={16} /> All groups mapped and the balance sheet balances.
        </div>
      )}

      {report && (
        <div className="inline-flex rounded-md border border-slate-300 dark:border-slate-600 overflow-hidden text-sm">
          {(['bs', 'pnl'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-4 py-1.5 font-medium ${
                view === v
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              {v === 'bs' ? 'Balance Sheet' : 'Statement of P&L'}
            </button>
          ))}
        </div>
      )}

      {report && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 text-left">
                <th className="px-4 py-3 font-semibold text-slate-700 dark:text-slate-200">
                  {view === 'bs' ? 'Particulars' : `Statement of P&L — for the year ended ${report.columns[0]?.periodLabel || ''}`}
                </th>
                {report.columns.map((c) => (
                  <th
                    key={c.branchName}
                    className={`px-4 py-3 text-right font-semibold ${
                      c.branchName === 'Consolidated' ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {c.branchName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownLines.map(({ def, values }) => {
                if (def.kind === 'header') {
                  return (
                    <tr key={def.key} className="bg-slate-100/70 dark:bg-slate-800/70">
                      <td
                        colSpan={report.columns.length + 1}
                        className="px-4 py-2 font-bold uppercase tracking-wide text-xs text-slate-600 dark:text-slate-300"
                        style={{ paddingLeft: `${1 + (def.indent || 0) * 0.75}rem` }}
                      >
                        {def.label}
                      </td>
                    </tr>
                  );
                }
                const isTotal = def.kind === 'total';
                const isSub = def.kind === 'subtotal';
                const isPlug = def.kind === 'plug';
                if (isPlug && values.every((v) => Math.round(v) === 0)) return null;
                return (
                  <tr
                    key={def.key}
                    className={`border-t border-slate-100 dark:border-slate-700/60 ${
                      isTotal ? 'bg-slate-50 dark:bg-slate-800 font-bold' : isSub ? 'font-semibold' : isPlug ? 'text-amber-700 dark:text-amber-400 italic' : ''
                    }`}
                  >
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200" style={{ paddingLeft: `${1 + (def.indent || 0) * 0.75}rem` }}>
                      {def.label}
                    </td>
                    {values.map((v, i) => (
                      <td
                        key={i}
                        className={`px-4 py-2 text-right tabular-nums ${
                          report.columns[i].branchName === 'Consolidated' ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-800 dark:text-slate-100'
                        }`}
                      >
                        {fmt(v)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {allUnclassified.length > 0 && (
        <div className="rounded-md border border-slate-200 dark:border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-500" />
            Unclassified ledgers ({allUnclassified.length})
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            These ledgers' primary group did not map to a Schedule III head. Map the group above, or
            their balances stay out of the face and are absorbed by the reconciliation plug.
          </p>
          <div className="mt-2 max-h-48 overflow-y-auto text-xs">
            <table className="min-w-full">
              <tbody>
                {allUnclassified.slice(0, 100).map((u, i) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-slate-700/60">
                    <td className="px-2 py-1 text-slate-700 dark:text-slate-200">{u.name}</td>
                    <td className="px-2 py-1 text-slate-500">{u.rawPrimary}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmt(u.closing)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default BalanceSheetAnalysis;
