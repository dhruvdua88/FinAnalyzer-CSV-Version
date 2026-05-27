import React, { useState, useMemo, useRef, useEffect } from 'react';
import { AlertCircle, Calendar, CheckCircle2, ChevronRight, Database, FileArchive, ListFilter, Filter, CheckSquare, Square } from 'lucide-react';
import { parseTallyLoaderDump } from '../services/tallyLoaderImportService';
import { importTallyZip, TallyStore } from '../services/tally';
import { LedgerEntry } from '../types';

interface FileUploadProps {
  // Relational store is the primary handoff; the flat row array is kept for
  // legacy modules that still consume LedgerEntry[]. New modules should read
  // from `store` directly.
  onDataLoaded: (data: LedgerEntry[], store: TallyStore | null) => void;
}

type UploadStep = 'upload' | 'loading' | 'filter';

const FileUpload: React.FC<FileUploadProps> = ({ onDataLoaded }) => {
  const [step, setStep] = useState<UploadStep>('upload');
  const [error, setError] = useState<string | null>(null);
  const [zipStatus, setZipStatus] = useState<string>('');
  const [rawParsedData, setRawParsedData] = useState<LedgerEntry[]>([]);
  const [loadedStore, setLoadedStore] = useState<TallyStore | null>(null);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [isOneClickRunning, setIsOneClickRunning] = useState(false);
  const [loaderAvailable, setLoaderAvailable] = useState<boolean | null>(null);
  const [oneClickStatus, setOneClickStatus] = useState<string>('');
  const [oneClickProgress, setOneClickProgress] = useState<number>(0);
  const [oneClickDetail, setOneClickDetail] = useState<string>('');
  const [oneClickRangeNote, setOneClickRangeNote] = useState<string>('');
  const [loaderFromDate, setLoaderFromDate] = useState('');
  const [loaderToDate, setLoaderToDate] = useState('');
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const parseDdMmYyyyToIso = (value: string): string | null => {
    const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    const dd = Number(match[1]);
    const mm = Number(match[2]);
    const yyyy = Number(match[3]);
    const date = new Date(yyyy, mm - 1, dd);
    if (date.getFullYear() !== yyyy || date.getMonth() !== mm - 1 || date.getDate() !== dd) return null;
    return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  };

  const onDateInputChange = (setter: (v: string) => void, value: string) => {
    const cleaned = value.replace(/[^\d]/g, '').slice(0, 8);
    if (cleaned.length <= 2) { setter(cleaned); return; }
    if (cleaned.length <= 4) { setter(`${cleaned.slice(0, 2)}/${cleaned.slice(2)}`); return; }
    setter(`${cleaned.slice(0, 2)}/${cleaned.slice(2, 4)}/${cleaned.slice(4)}`);
  };

  const isoToDdMmYyyy = (value: string): string => {
    if (!value) return '';
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return value;
    return `${m[3]}/${m[2]}/${m[1]}`;
  };

  useEffect(() => {
    if (!isOneClickRunning) return;
    let isDisposed = false;

    const deriveProgress = (logs: string[]): number => {
      const normalized = logs.map((l) => l.toLowerCase());
      let progress = 10;
      if (normalized.some((l) => l.includes('installing loader utility dependencies'))) progress = Math.max(progress, 18);
      if (normalized.some((l) => l.includes('starting loader'))) progress = Math.max(progress, 30);
      const savedTables = normalized.filter((l) => l.includes('saving file')).length;
      if (savedTables > 0) progress = Math.max(progress, Math.min(82, 30 + savedTables * 3));
      if (normalized.some((l) => l.includes('error in importing data'))) progress = Math.max(progress, 45);
      if (normalized.some((l) => l.includes('loader completed successfully'))) progress = Math.max(progress, 95);
      return progress;
    };

    const tick = async () => {
      try {
        const response = await fetch('/api/loader/status');
        if (!response.ok) return;
        const payload = await response.json();
        if (isDisposed) return;
        const logs = Array.isArray(payload?.logs) ? payload.logs : [];
        const lastLog = logs.length > 0 ? String(logs[logs.length - 1]).replace(/^\[[^\]]+\]\s*/, '') : '';
        if (lastLog) setOneClickDetail(lastLog);
        const target = deriveProgress(logs);
        setOneClickProgress((prev) => {
          const nudged = prev < 88 ? prev + 1 : prev;
          return Math.max(prev, nudged, target);
        });
      } catch { /* transient polling failure */ }
    };

    tick();
    const timer = window.setInterval(tick, 1200);
    return () => { isDisposed = true; window.clearInterval(timer); };
  }, [isOneClickRunning]);

  useEffect(() => {
    fetch('/api/loader/check')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLoaderAvailable(d?.available === true))
      .catch(() => setLoaderAvailable(false));
  }, []);

  const availableMonths = useMemo(() => {
    const monthsMap = new Map<string, { label: string; count: number; sortKey: string }>();
    rawParsedData.forEach((entry) => {
      if (!entry.date) return;
      const date = new Date(entry.date);
      if (isNaN(date.getTime())) return;
      const monthKey = entry.date.substring(0, 7);
      const label = date.toLocaleString('default', { month: 'long', year: 'numeric' });
      const existing = monthsMap.get(monthKey);
      if (existing) existing.count++;
      else monthsMap.set(monthKey, { label, count: 1, sortKey: monthKey });
    });
    return Array.from(monthsMap.values()).sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [rawParsedData]);

  const isAccountingVoucherEntry = (entry: LedgerEntry): boolean => {
    const raw = entry?.is_accounting_voucher;
    if (raw === undefined || raw === null || String(raw).trim() === '') return true;
    const text = String(raw).trim().toLowerCase();
    if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return true;
    if (text === '0' || text === 'false' || text === 'no' || text === 'n') return false;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed > 0 : false;
  };

  const isMasterLedgerEntry = (entry: LedgerEntry): boolean => {
    const raw = entry?.is_master_ledger;
    if (raw === undefined || raw === null || String(raw).trim() === '') return false;
    const text = String(raw).trim().toLowerCase();
    if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return true;
    if (text === '0' || text === 'false' || text === 'no' || text === 'n') return false;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed > 0 : false;
  };

  const continueWithParsedData = (data: LedgerEntry[], store: TallyStore | null) => {
    const accountingOnly = data.filter(isAccountingVoucherEntry);
    if (accountingOnly.length === 0) {
      throw new Error('No accounting voucher rows found in selected source.');
    }
    setRawParsedData(accountingOnly);
    setLoadedStore(store);
    const allMonthKeys = Array.from(new Set(accountingOnly.map((d) => d.date.substring(0, 7)))).filter(Boolean);
    setSelectedMonths(allMonthKeys);
    setStep('filter');
  };

  const processTallyZip = async (file: File) => {
    setStep('loading');
    setError(null);
    setZipStatus(`Reading Tally export: ${file.name}`);
    try {
      const store = await importTallyZip(file);
      const rows = store.getLedgerEntries();
      const summary = store.summary();
      setZipStatus(
        `Loaded ${summary.vouchers.toLocaleString()} vouchers, ${summary.accountingLines.toLocaleString()} accounting lines, ` +
        `${summary.ledgers.toLocaleString()} ledgers, ${summary.stockItems.toLocaleString()} stock items` +
        (summary.minDate ? ` (${summary.minDate} → ${summary.maxDate})` : '')
      );
      continueWithParsedData(rows, store);
    } catch (err: any) {
      console.error(err);
      setError(err?.message || 'Failed to import Tally export ZIP.');
      setZipStatus('');
      setStep('upload');
    }
  };

  const runLoaderAndImport = async () => {
    setError(null);
    setIsOneClickRunning(true);
    setOneClickProgress(8);
    setOneClickStatus('Running Tally Database Loader utility...');
    setOneClickDetail('');
    setOneClickRangeNote('');
    setStep('loading');

    try {
      const hasFrom = loaderFromDate.trim().length > 0;
      const hasTo = loaderToDate.trim().length > 0;
      if (hasFrom !== hasTo) {
        throw new Error('Please enter both From Date and To Date in dd/mm/yyyy format.');
      }
      let fromDateIso: string | undefined;
      let toDateIso: string | undefined;
      if (hasFrom && hasTo) {
        fromDateIso = parseDdMmYyyyToIso(loaderFromDate) || undefined;
        toDateIso = parseDdMmYyyyToIso(loaderToDate) || undefined;
        if (!fromDateIso || !toDateIso) {
          throw new Error('Invalid date format. Use dd/mm/yyyy (example: 01/04/2025).');
        }
        if (fromDateIso > toDateIso) {
          throw new Error('From Date must be less than or equal to To Date.');
        }
        setOneClickStatus(`Running Tally Database Loader for ${loaderFromDate} to ${loaderToDate}...`);
      }

      const response = await fetch('/api/loader/run-and-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromDate: fromDateIso, toDate: toDateIso }),
      });

      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await response.json()
        : { ok: false, error: await response.text() };

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Unable to run loader utility from app.');
      }

      const requestedFromIso = typeof payload?.requestedFromDate === 'string' ? payload.requestedFromDate : '';
      const requestedToIso = typeof payload?.requestedToDate === 'string' ? payload.requestedToDate : '';
      const actualMinIso = typeof payload?.outputSummary?.minDate === 'string' ? payload.outputSummary.minDate : '';
      const actualMaxIso = typeof payload?.outputSummary?.maxDate === 'string' ? payload.outputSummary.maxDate : '';
      const voucherRows = Number(payload?.outputSummary?.voucherRows || 0);
      const accountingRows = Number(payload?.outputSummary?.accountingRows || 0);

      if (actualMinIso && actualMaxIso) {
        setOneClickRangeNote(
          `Loader returned ${voucherRows.toLocaleString()} vouchers (${accountingRows.toLocaleString()} accounting rows) for ${isoToDdMmYyyy(actualMinIso)} to ${isoToDdMmYyyy(actualMaxIso)}.`
        );
      }
      if (requestedFromIso && requestedToIso && actualMaxIso && actualMaxIso < requestedToIso) {
        setOneClickRangeNote(
          `Requested ${isoToDdMmYyyy(requestedFromIso)} to ${isoToDdMmYyyy(requestedToIso)}, but Tally returned data only up to ${isoToDdMmYyyy(actualMaxIso)}.`
        );
      }

      const tableFiles = Object.values(payload.tables || {}).map((table: any) => {
        const fileName = table?.filename || 'table.json';
        const mimeType = fileName.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/json';
        return new File([table?.content || ''], fileName, { type: mimeType });
      });

      if (tableFiles.length === 0) {
        throw new Error('Loader completed, but no output tables were returned.');
      }

      setOneClickStatus('Importing loader output...');
      setOneClickProgress((prev) => Math.max(prev, 92));
      const data = await parseTallyLoaderDump(tableFiles);
      setOneClickProgress(100);
      setOneClickDetail('Import completed successfully.');
      // Live-loader path produces a subset of tables — no stock items or
      // GST effective rates — so we hand a null store. New modules that
      // require those tables will gracefully degrade.
      continueWithParsedData(data, null);
      setOneClickStatus('');
    } catch (err: any) {
      console.error(err);
      setError(err?.message || 'One-click import failed.');
      setOneClickProgress(0);
      setOneClickDetail('');
      setOneClickRangeNote('');
      setStep('upload');
      setOneClickStatus('');
    } finally {
      setIsOneClickRunning(false);
    }
  };

  const handleProceed = () => {
    const filteredData = rawParsedData.filter((d) => {
      if (isMasterLedgerEntry(d)) return true;
      return selectedMonths.includes(d.date.substring(0, 7));
    });
    onDataLoaded(filteredData, loadedStore);
  };

  const toggleMonth = (monthKey: string) => {
    setSelectedMonths((prev) => prev.includes(monthKey) ? prev.filter((m) => m !== monthKey) : [...prev, monthKey]);
  };

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processTallyZip(file);
    e.target.value = '';
  };

  const LoadingSkeleton = () => (
    <div className="max-w-4xl mx-auto mt-10 space-y-6 animate-pulse">
      <div className="h-10 bg-slate-200 rounded-lg w-1/3 mx-auto"></div>
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex gap-4">
          <div className="h-4 bg-slate-200 rounded w-20"></div>
          <div className="h-4 bg-slate-200 rounded w-32"></div>
          <div className="h-4 bg-slate-200 rounded w-24"></div>
        </div>
        <div className="p-6 space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-4">
              <div className="h-8 bg-slate-100 rounded w-full"></div>
              <div className="h-8 bg-slate-100 rounded w-24"></div>
              <div className="h-8 bg-slate-100 rounded w-32"></div>
            </div>
          ))}
        </div>
      </div>
      <div className="text-center">
        <p className="text-slate-400 text-sm font-medium">Unpacking Tally export, joining vouchers, building relational store...</p>
      </div>
    </div>
  );

  const LoaderProgressView = () => (
    <div className="max-w-2xl mx-auto mt-20 bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-14 h-14 bg-emerald-100 text-emerald-700 rounded-full mb-4">
          <Database size={28} />
        </div>
        <h2 className="text-2xl font-black text-slate-900">Running Tally Loader</h2>
        <p className="text-sm text-slate-500 mt-1">{oneClickStatus || 'Processing...'}</p>
      </div>
      <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden border border-slate-200">
        <div className="h-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${Math.max(0, Math.min(100, oneClickProgress))}%` }} />
      </div>
      <div className="flex items-center justify-between mt-3 text-xs font-semibold">
        <span className="text-slate-500">Progress</span>
        <span className="text-emerald-700">{Math.max(0, Math.min(100, oneClickProgress))}%</span>
      </div>
      {oneClickDetail && (
        <div className="mt-6 p-3 rounded-lg bg-slate-50 border border-slate-200">
          <p className="text-xs text-slate-600 break-words">{oneClickDetail}</p>
        </div>
      )}
      {(loaderFromDate || loaderToDate) && (
        <p className="text-[11px] text-slate-400 mt-4 text-center">
          Requested Date Range: {loaderFromDate || '--/--/----'} to {loaderToDate || '--/--/----'}
        </p>
      )}
      {oneClickRangeNote && (
        <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <p className="text-xs text-amber-800">{oneClickRangeNote}</p>
        </div>
      )}
    </div>
  );

  if (step === 'loading') {
    if (isOneClickRunning) return <LoaderProgressView />;
    return <LoadingSkeleton />;
  }

  if (step === 'filter') {
    return (
      <div className="max-w-4xl mx-auto mt-10 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 bg-green-100 text-green-700 rounded-full mb-2">
            <CheckCircle2 size={32} />
          </div>
          <h2 className="text-2xl font-bold text-slate-800">File Parsed Successfully!</h2>
          <p className="text-slate-500">We found {rawParsedData.length.toLocaleString()} records. Select the period you wish to analyze.</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
          <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Calendar className="text-blue-600" size={24} />
              <div>
                <h3 className="font-bold text-slate-900">Analysis Period</h3>
                <p className="text-xs text-slate-500">Select months for the current audit session</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setSelectedMonths(availableMonths.map((m) => m.sortKey))}
                className="px-4 py-2 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 flex items-center gap-2 transition-colors">
                <CheckSquare size={14} /> Select All
              </button>
              <button onClick={() => setSelectedMonths([])}
                className="px-4 py-2 text-xs font-bold text-slate-600 bg-white hover:bg-slate-50 rounded-lg border border-slate-200 flex items-center gap-2 transition-colors">
                <Square size={14} /> Clear All
              </button>
            </div>
          </div>

          <div className="p-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[400px] overflow-y-auto">
            {availableMonths.map((month) => {
              const isSelected = selectedMonths.includes(month.sortKey);
              return (
                <div key={month.sortKey} onClick={() => toggleMonth(month.sortKey)}
                  className={`relative p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 group ${
                    isSelected ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500/10' : 'border-slate-100 bg-slate-50 hover:border-slate-300 hover:bg-white'
                  }`}>
                  <div className="flex justify-between items-start mb-1">
                    <span className={`text-sm font-bold ${isSelected ? 'text-blue-900' : 'text-slate-700'}`}>{month.label}</span>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                      isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300 group-hover:border-slate-400'
                    }`}>
                      {isSelected && <CheckCircle2 size={12} className="text-white" />}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <Database size={12} className={isSelected ? 'text-blue-400' : 'text-slate-400'} />
                    <span className={`text-[11px] font-semibold ${isSelected ? 'text-blue-600' : 'text-slate-500'}`}>
                      {month.count.toLocaleString()} Entries
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="p-6 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
            <div className="text-sm">
              <span className="font-bold text-slate-900">{selectedMonths.length}</span>
              <span className="text-slate-500 ml-1">months selected</span>
            </div>
            <button onClick={handleProceed} disabled={selectedMonths.length === 0}
              className={`px-8 py-3 rounded-xl font-bold flex items-center gap-3 transition-all shadow-lg ${
                selectedMonths.length > 0 ? 'bg-blue-600 text-white hover:bg-blue-700 translate-y-0 active:scale-95' : 'bg-slate-300 text-slate-500 cursor-not-allowed'
              }`}>
              Proceed to Dashboard
              <ChevronRight size={20} />
            </button>
          </div>
        </div>

        <button onClick={() => setStep('upload')}
          className="mx-auto block text-sm font-medium text-slate-400 hover:text-slate-600 transition-colors underline underline-offset-4">
          Upload a different file
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto mt-20 space-y-6">
      <div className="text-center mb-6 space-y-2">
        <h1 className="text-4xl font-black text-slate-900 tracking-tight">FinAnalyzer Pro</h1>
        <p className="text-slate-500 text-lg">Import a Tally Export (ZIP) to begin</p>
      </div>

      {/* ── Primary: Tally Excel Export ZIP ──────────────────────────────── */}
      <div className="p-6 bg-white rounded-2xl border-2 border-blue-200 shadow-md">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="inline-flex items-center gap-2 mb-2">
              <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 bg-blue-600 text-white rounded">
                Primary
              </span>
            </div>
            <p className="text-base font-bold text-slate-900">Import Tally Export (ZIP)</p>
            <p className="text-sm text-slate-500 mt-1">
              Drop the ZIP produced by your Tally exporter. Contains masters and transactions
              as CSV (or legacy Excel) tables — ledgers, groups, voucher types, stock items,
              GST effective rates, vouchers, accounting lines, inventory, batches, bills.
            </p>
          </div>
          <button type="button" onClick={() => zipInputRef.current?.click()}
            className="inline-flex shrink-0 items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-colors shadow-sm">
            <FileArchive size={18} />
            Import ZIP
          </button>
        </div>
        {zipStatus && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 text-blue-800 text-xs font-medium">
            {zipStatus}
          </div>
        )}
        <input ref={zipInputRef} type="file" className="hidden"
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={handleZipChange} />
      </div>

      {/* ── Secondary: One-click Tally live import ───────────────────────── */}
      <div className="p-5 bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-slate-800">Import from Tally (Live)</p>
            <p className="text-xs text-slate-500 mt-1">
              Runs the bundled <code>tally-database-loader</code> against a running Tally Prime instance.
              Produces a subset of tables — no stock items or GST effective rates.
            </p>
          </div>
          <button type="button" onClick={runLoaderAndImport}
            disabled={isOneClickRunning || loaderAvailable === false}
            title={loaderAvailable === false ? 'Loader utility not installed — place the tally-database-loader-main folder next to the app.' : undefined}
            className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-colors shadow-sm ${
              isOneClickRunning ? 'bg-emerald-300 text-white cursor-not-allowed'
              : loaderAvailable === false ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
            }`}>
            <Database size={16} />
            {isOneClickRunning ? 'Running Utility...' : loaderAvailable === false ? 'Loader Not Installed' : 'Import from Tally'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">From Date (dd/mm/yyyy)</label>
            <input type="text" inputMode="numeric" maxLength={10} placeholder="01/04/2025"
              value={loaderFromDate} onChange={(e) => onDateInputChange(setLoaderFromDate, e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">To Date (dd/mm/yyyy)</label>
            <input type="text" inputMode="numeric" maxLength={10} placeholder="31/03/2026"
              value={loaderToDate} onChange={(e) => onDateInputChange(setLoaderToDate, e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none" />
          </div>
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          Date fields are optional. Leave both blank to use loader default period from <code>config.json</code>.
        </p>
        {loaderAvailable === false && (
          <p className="text-[11px] text-amber-600 mt-2 font-medium">
            Loader utility not found. Place the <code>tally-database-loader-main</code> folder next to the app folder and restart to enable this feature.
          </p>
        )}
      </div>

      {oneClickStatus && (
        <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold">
          {oneClickStatus}
        </div>
      )}
      {oneClickRangeNote && (
        <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm font-semibold">
          {oneClickRangeNote}
        </div>
      )}
      {error && (
        <div className="mt-2 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-700 animate-in fade-in slide-in-from-top-2">
          <div className="bg-red-100 p-2 rounded-lg"><AlertCircle size={20} /></div>
          <span className="font-semibold text-sm">{error}</span>
        </div>
      )}

      <div className="mt-6 grid grid-cols-3 gap-6 opacity-40">
        <div className="text-center space-y-2">
          <div className="mx-auto w-10 h-10 border border-slate-300 rounded-lg flex items-center justify-center"><FileArchive size={20} /></div>
          <p className="text-[10px] font-bold uppercase tracking-widest">Excel Export</p>
        </div>
        <div className="text-center space-y-2">
          <div className="mx-auto w-10 h-10 border border-slate-300 rounded-lg flex items-center justify-center"><ListFilter size={20} /></div>
          <p className="text-[10px] font-bold uppercase tracking-widest">Period Filter</p>
        </div>
        <div className="text-center space-y-2">
          <div className="mx-auto w-10 h-10 border border-slate-300 rounded-lg flex items-center justify-center"><Filter size={20} /></div>
          <p className="text-[10px] font-bold uppercase tracking-widest">Audit Ready</p>
        </div>
      </div>
    </div>
  );
};

export default FileUpload;
