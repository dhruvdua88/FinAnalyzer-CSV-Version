import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Building2, Download, Loader2, Scale, Trash2, Upload } from 'lucide-react';
import { TallyStore, useTallyStore } from '../../services/tally';
import {
  BranchData,
  buildBranchFromStore,
  buildReport,
} from '../../services/balanceSheet';

interface BranchEntry {
  id: string;
  data: BranchData;
  source: 'loaded' | 'upload';
}

const fmt = (n: number): string => {
  const v = Math.round(n);
  if (v === 0) return '-';
  const abs = Math.abs(v).toLocaleString('en-IN');
  return v < 0 ? `(${abs})` : abs;
};

let uid = 0;
const nextId = () => `br-${++uid}`;

const BalanceSheetAnalysis: React.FC = () => {
  const store = useTallyStore();
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Seed branch 1 from the currently-loaded dataset (if any).
  useEffect(() => {
    if (!store) return;
    setBranches((prev) => {
      if (prev.some((b) => b.source === 'loaded')) return prev;
      try {
        const data = buildBranchFromStore(store, store.meta?.companyName || 'Branch 1');
        return [{ id: nextId(), data, source: 'loaded' }, ...prev];
      } catch {
        return prev;
      }
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
        added.push({ id: nextId(), data: buildBranchFromStore(parsed, label), source: 'upload' });
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

  const report = useMemo(
    () => (branches.length ? buildReport(branches.map((b) => b.data)) : null),
    [branches],
  );

  const exportCsv = () => {
    if (!report) return;
    const head = ['Particulars', ...report.columns.map((c) => c.branchName)];
    const rows = report.lines
      .filter((l) => l.def.kind !== 'header')
      .map((l) => [l.def.label, ...l.values.map((v) => Math.round(v))]);
    const csv = [head, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'balance-sheet-schedule-iii.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const materialPlug = report
    ? report.lines.find((l) => l.def.key === 'plug')?.values.some((v, i) => {
        const ta = Math.abs(report.lines.find((x) => x.def.key === 'total_assets')!.values[i]);
        return ta < 1 ? Math.abs(v) > 1 : (Math.abs(v) / ta) * 100 > 1;
      })
    : false;

  const allUnclassified = useMemo(
    () => branches.flatMap((b) => b.data.unclassified.map((u) => ({ ...u, branch: b.data.branchName }))),
    [branches],
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
            branch — add more to get per-branch columns plus a Consolidated total.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            Add branch ZIP
          </button>
          {report && (
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <Download size={16} /> Export CSV
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Branch chips */}
      {branches.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {branches.map((b, i) => (
            <span
              key={b.id}
              className="inline-flex items-center gap-2 rounded-full bg-slate-100 dark:bg-slate-700 px-3 py-1 text-sm text-slate-700 dark:text-slate-200"
            >
              <Building2 size={14} />
              {b.data.branchName}
              {b.data.periodTo ? <span className="text-slate-400">· {b.data.periodLabel}</span> : null}
              {i > 0 || b.source === 'upload' ? (
                <button onClick={() => removeBranch(b.id)} className="text-slate-400 hover:text-red-500">
                  <Trash2 size={13} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      )}

      {!branches.length && (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-600 p-10 text-center text-slate-500 dark:text-slate-400">
          <Scale size={32} className="mx-auto mb-3 opacity-60" />
          <p className="font-medium">No data loaded.</p>
          <p className="text-sm mt-1">
            Import a Tally export ZIP from the main screen, or click <b>Add branch ZIP</b> above to load
            one or more company / branch exports.
          </p>
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

      {report && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 text-left">
                <th className="px-4 py-3 font-semibold text-slate-700 dark:text-slate-200">Particulars</th>
                {report.columns.map((c) => (
                  <th
                    key={c.branchName}
                    className={`px-4 py-3 text-right font-semibold ${
                      c.branchName === 'Consolidated'
                        ? 'text-indigo-700 dark:text-indigo-300'
                        : 'text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {c.branchName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.lines.map(({ def, values }) => {
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
                const allZero = values.every((v) => Math.round(v) === 0);
                if (isPlug && allZero) return null;
                return (
                  <tr
                    key={def.key}
                    className={`border-t border-slate-100 dark:border-slate-700/60 ${
                      isTotal
                        ? 'bg-slate-50 dark:bg-slate-800 font-bold'
                        : isSub
                        ? 'font-semibold'
                        : isPlug
                        ? 'text-amber-700 dark:text-amber-400 italic'
                        : ''
                    }`}
                  >
                    <td
                      className="px-4 py-2 text-slate-700 dark:text-slate-200"
                      style={{ paddingLeft: `${1 + (def.indent || 0) * 0.75}rem` }}
                    >
                      {def.label}
                    </td>
                    {values.map((v, i) => (
                      <td
                        key={i}
                        className={`px-4 py-2 text-right tabular-nums ${
                          report.columns[i].branchName === 'Consolidated'
                            ? 'text-indigo-700 dark:text-indigo-300'
                            : 'text-slate-800 dark:text-slate-100'
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
            These ledgers had a primary group that did not map to a Schedule III head and could not be
            inferred. Their balances are excluded from the face and absorbed by the reconciliation plug.
          </p>
          <div className="mt-2 max-h-48 overflow-y-auto text-xs">
            <table className="min-w-full">
              <tbody>
                {allUnclassified.slice(0, 100).map((u, i) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-slate-700/60">
                    <td className="px-2 py-1 text-slate-700 dark:text-slate-200">{u.name}</td>
                    <td className="px-2 py-1 text-slate-500">{u.rawPrimary}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {fmt(u.closing)}
                    </td>
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
