import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import XLSX from 'xlsx-js-style';
import { AlertTriangle, Download, FileSpreadsheet, Loader2, Trash2, Upload } from 'lucide-react';
import { ingestGstFiles, monthLabel, totalTax } from '../../services/gst/gstReturnsIngest';
import type { GstDataset } from '../../services/gst/gstReturnsIngest';
import { buildGstSummary, coverageLabel } from '../../services/gst/gstReturnsSummary';
import { buildGstSummaryWorkbook, gstSheetPolish } from '../../services/gst/gstReturnsExcel';
import { downloadPolished, polishXlsx } from '../../services/xlsxPolish';

interface Source { id: string; name: string; bytes: ArrayBuffer }

let uid = 0;
const nextId = () => `gst-${++uid}`;

const fmt = (n: number | undefined): string => {
  if (n === undefined) return '—';
  const v = Math.round(n);
  if (v === 0) return 'Nil';
  const abs = Math.abs(v).toLocaleString('en-IN');
  return v < 0 ? `(${abs})` : abs;
};

const GstReturnsSummary: React.FC = () => {
  const [sources, setSources] = useState<Source[]>([]);
  const [dataset, setDataset] = useState<GstDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError('');
    try {
      const added: Source[] = [];
      for (const file of Array.from(files)) {
        added.push({ id: nextId(), name: file.name, bytes: await file.arrayBuffer() });
      }
      setSources((prev) => [...prev, ...added]);
    } catch (e: any) {
      setError(e?.message || 'Could not read one or more of those files.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  // Re-reading everything on each change is deliberate: de-duplication and the QRMP
  // overlap rule are batch-wide, so adding one file can legitimately change an
  // earlier one's treatment. The file count is tiny.
  useEffect(() => {
    let cancelled = false;
    if (sources.length === 0) { setDataset(null); return; }
    setLoading(true);
    ingestGstFiles(sources.map((s) => ({ name: s.name, bytes: new Uint8Array(s.bytes) })))
      .then((d) => { if (!cancelled) setDataset(d); })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Could not read the returns.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sources]);

  const model = useMemo(() => (dataset ? buildGstSummary(dataset) : null), [dataset]);

  const exportExcel = async () => {
    if (!model) return;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const raw = XLSX.write(buildGstSummaryWorkbook(model),
      { type: 'array', bookType: 'xlsx', cellStyles: true }) as ArrayBuffer;
    // Freeze panes, gridlines and page setup are spliced in after the write —
    // xlsx-js-style accepts them and then drops them.
    const polished = await polishXlsx(raw, gstSheetPolish(model),
      { showGridLines: false, landscape: true, fitToWidth: true });
    downloadPolished(polished, `GST_Returns_Summary_${model.gstin ?? 'unknown'}_${stamp}.xlsx`);
  };

  const yieldFor = (name: string): { text: string; bad: boolean } => {
    const rows = dataset?.reports.filter((r) => r.sourceName === name || r.sourceName.startsWith(`${name}!`)) ?? [];
    if (!rows.length) return { text: '…', bad: false };
    const ok = rows.filter((r) => r.status === 'ok').length;
    if (ok === 0) return { text: rows[0].status === 'rejected' ? 'rejected' : rows[0].status, bad: true };
    return { text: `${ok} return${ok > 1 ? 's' : ''}`, bad: false };
  };

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); },
  };

  return (
    <div className="space-y-6" {...dropProps}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">GST Returns Summary</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">
            Upload GSTR-1 / IFF, GSTR-3B and GSTR-2B JSONs, or the ZIPs straight from the portal —
            any months, in any mix. Add them one at a time or all at once; the summary covers
            whatever you supply and tells you what is missing.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.zip"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            Add return files
          </button>
          <button
            onClick={exportExcel}
            disabled={!model || model.totalPeriods === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold"
          >
            <FileSpreadsheet size={16} />
            Export Excel
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-4 py-3 text-sm text-red-800 dark:text-red-300 flex gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {sources.length === 0 && (
        <div
          className={`rounded-2xl border-2 border-dashed p-10 text-center ${
            dragging ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-900/20' : 'border-slate-300 dark:border-slate-600'
          }`}
        >
          <Download size={28} className="mx-auto text-slate-400" />
          <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Drop your GST return files here
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            A portal ZIP, several JSONs, or one file at a time. GSTR-1 downloads are usually ZIPs —
            that is fine, including a ZIP of ZIPs.
          </p>
        </div>
      )}

      {sources.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {sources.map((s) => {
            const y = yieldFor(s.name);
            return (
              <span
                key={s.id}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 pl-3 pr-2 py-1 text-xs"
              >
                <span className="font-medium text-slate-700 dark:text-slate-200">{s.name}</span>
                <span className={y.bad ? 'text-red-600 dark:text-red-400 font-bold' : 'text-slate-400'}>{y.text}</span>
                <button
                  onClick={() => setSources((prev) => prev.filter((x) => x.id !== s.id))}
                  className="text-slate-400 hover:text-red-600"
                  aria-label={`Remove ${s.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {model && model.warnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2 font-bold">
            <AlertTriangle size={15} />
            Read before relying on these figures
          </div>
          <ul className="mt-2 space-y-1 text-xs list-disc pl-5">
            {model.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {model && model.reports.some((r) => r.status !== 'ok') && (
        <div className="rounded-md border border-slate-200 dark:border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Files not included</h3>
          <table className="mt-2 min-w-full text-xs">
            <tbody>
              {model.reports.filter((r) => r.status !== 'ok').map((r, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-700/60">
                  <td className="py-1 pr-3 text-slate-600 dark:text-slate-300">{r.sourceName}</td>
                  <td className={`py-1 pr-3 font-bold ${r.status === 'rejected' ? 'text-red-600 dark:text-red-400' : 'text-slate-400'}`}>
                    {r.status}
                  </td>
                  <td className="py-1 text-slate-500 dark:text-slate-400">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {model?.fys.map((fy) => (
        <div key={fy.fy} className="space-y-4">
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">{fy.fy}</h3>

          <div className="rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300">
              Coverage
            </div>
            <table className="min-w-full text-xs">
              <thead className="text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Period</th>
                  <th className="px-4 py-2 text-left font-semibold">GSTR-1 / IFF</th>
                  <th className="px-4 py-2 text-left font-semibold">GSTR-3B</th>
                  <th className="px-4 py-2 text-left font-semibold">GSTR-2B</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {fy.months.map((m) => (
                  <tr key={m.period}>
                    <td className="px-4 py-1.5 text-slate-700 dark:text-slate-200">{m.label}</td>
                    {(['r1', 'b3', 'b2'] as const).map((form) => {
                      const text = coverageLabel(m, form);
                      return (
                        <td key={form} className={`px-4 py-1.5 ${text === '—' ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-slate-300'}`}>
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300">
              Outward supplies — GSTR-1 / IFF compared with GSTR-3B
            </div>
            <table className="min-w-full text-xs tabular-nums">
              <thead className="text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Period</th>
                  <th className="px-4 py-2 text-left font-semibold">Basis</th>
                  <th className="px-4 py-2 text-right font-semibold">GSTR-1</th>
                  <th className="px-4 py-2 text-right font-semibold">GSTR-3B</th>
                  <th className="px-4 py-2 text-right font-semibold">Difference</th>
                  <th className="px-4 py-2 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {fy.outwardCompare.map((row, i) => {
                  const big = row.diff && Math.abs(row.diff.taxable) > 0.5;
                  return (
                    <tr key={i}>
                      <td className="px-4 py-1.5 text-slate-700 dark:text-slate-200">{row.label}</td>
                      <td className="px-4 py-1.5 text-slate-400">{row.basis === 'quarter' ? 'Quarter' : 'Month'}</td>
                      <td className="px-4 py-1.5 text-right text-slate-600 dark:text-slate-300">{fmt(row.r1?.taxable)}</td>
                      <td className="px-4 py-1.5 text-right text-slate-600 dark:text-slate-300">{fmt(row.b3?.taxable)}</td>
                      <td className={`px-4 py-1.5 text-right ${big ? 'font-bold text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300'}`}>
                        {fmt(row.diff?.taxable)}
                      </td>
                      <td className={`px-4 py-1.5 ${row.status === 'mismatch' ? 'font-bold text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>
                        {row.status === 'match' ? 'Agrees'
                          : row.status === 'mismatch' ? 'Difference — review'
                            : row.status === 'r1-only' ? 'GSTR-1 only' : 'GSTR-3B only'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {fy.outwardCompare.some((x) => x.basis === 'quarter') && (
              <p className="px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-700/60">
                Quarters filed under QRMP are compared for the quarter — the IFF months and the quarterly
                GSTR-1 together correspond to one quarterly GSTR-3B.
              </p>
            )}
          </div>

          <div className="rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300">
              Input tax credit — GSTR-2B compared with GSTR-3B
            </div>
            <table className="min-w-full text-xs tabular-nums">
              <thead className="text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Month</th>
                  <th className="px-4 py-2 text-right font-semibold">2B total</th>
                  <th className="px-4 py-2 text-right font-semibold">3B net ITC</th>
                  <th className="px-4 py-2 text-right font-semibold">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {fy.months.filter((m) => m.itcCompare).map((m) => {
                  const c = m.itcCompare!;
                  const d = totalTax(c.diff);
                  const big = Math.abs(d) > 0.5;
                  return (
                    <tr key={m.period}>
                      <td className="px-4 py-1.5 text-slate-700 dark:text-slate-200">{m.label}</td>
                      <td className="px-4 py-1.5 text-right text-slate-600 dark:text-slate-300">{m.b2 ? fmt(totalTax(c.b2)) : '—'}</td>
                      <td className="px-4 py-1.5 text-right text-slate-600 dark:text-slate-300">{m.b3 ? fmt(totalTax(c.b3)) : '—'}</td>
                      <td className={`px-4 py-1.5 text-right ${big ? 'font-bold text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300'}`}>
                        {m.b2 && m.b3 ? fmt(d) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {model && model.totalPeriods === 0 && sources.length > 0 && !loading && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          None of those files contained a GSTR-1, GSTR-3B or GSTR-2B return. See the list above for why.
        </div>
      )}
    </div>
  );
};

export default GstReturnsSummary;
