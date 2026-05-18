/**
 * TDSAnalysis.tsx  — FinAnalyzer
 *
 * Improvements shipped in this version:
 *  B1 – Party-based threshold accumulation (YTD per party, per section)
 *  B2 – Optional TDS section mapping (ledger → 194C / 194J / etc.)
 *  B3 – SQL-backed data fetch when backend is available
 *  B4 – Annual accumulation column in the detail table
 *  B5 – Rate deviation alerts (actual vs expected rate)
 *  B6 – "Short Deducted" status (TDS deducted but <95% of expected)
 *  C1 – Lazy data load (only TDS-relevant rows via /api/data/tds-query)
 *  C2 – Computation offloaded to a Web Worker
 *  C4 – Background Excel export with progress toast
 *  D1 – Filters persisted to localStorage
 *  D2 – Per-voucher audit annotations
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  AlertOctagon,
  BookOpen,
  Calculator,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Download,
  Info,
  Layers,
  MessageSquare,
  Percent,
  Search,
  Shield,
  SlidersHorizontal,
  Tag,
  Users,
  X,
} from 'lucide-react';

import type { LedgerEntry, TDSThresholdConfig, TDSSectionMapping, AuditAnnotation } from '../../types';
import { TDS_SECTION_DEFAULTS } from '../../types';
import { getUniqueLedgers } from '../../services/dataService';
import { useTallyStore } from '../../services/tally';
import type {
  TdsRawRow,
  TDSVoucherDetail,
  TDSSummaryGroup,
  TDSWorkerFilters,
  TDSWorkerOutput,
} from '../../workers/tdsWorker';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────
interface TDSAnalysisProps {
  data: LedgerEntry[];
  externalSelectedLedgers?: string[];
  onLedgersUpdate?: (ledgers: string[]) => void;
  thresholdConfig?: TDSThresholdConfig;
  onThresholdConfigUpdate?: (cfg: TDSThresholdConfig) => void;
  annotations?: AuditAnnotation[];
  onAnnotationsUpdate?: (notes: AuditAnnotation[]) => void;
  /** Pass true when the parent loaded data via SQL (enables /api/data/tds-query) */
  isSqlMode?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const toNumber = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const isExpenseOrPurchase = (entry: LedgerEntry): boolean => {
  const p = String(entry.TallyPrimary || '').toLowerCase();
  return p.includes('expense') || p.includes('purchase');
};

const resolvePartyName = (entries: LedgerEntry[]): string => {
  const fromField = entries.map((e) => String(e.party_name || '').trim()).find((n) => n.length > 0);
  if (fromField) return fromField;
  const fallback = entries.find((e) => {
    const p = String(e.TallyPrimary || '').toLowerCase();
    const pr = String(e.TallyParent || '').toLowerCase();
    return p.includes('creditor') || p.includes('debtor') || pr.includes('creditor') || pr.includes('debtor');
  });
  return String(fallback?.Ledger || 'N/A').trim() || 'N/A';
};

const buildVoucherKey = (e: LedgerEntry): string =>
  `${String(e.voucher_number || e.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN'}__${String(e.date || '').trim()}__${String(e.voucher_type || '').trim()}`;

/** Convert in-memory LedgerEntry[] → TdsRawRow[] (used when SQL mode unavailable) */
const convertToRawRows = (data: LedgerEntry[], selectedTaxLedgers: Set<string>): TdsRawRow[] => {
  // Group by voucher key
  const voucherMap = new Map<string, { entries: LedgerEntry[]; number: string; date: string; type: string }>();
  data.forEach((entry) => {
    const key = buildVoucherKey(entry);
    if (!voucherMap.has(key)) {
      voucherMap.set(key, {
        entries: [],
        number: String(entry.voucher_number || entry.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN',
        date: String(entry.date || '').trim(),
        type: String(entry.voucher_type || '').trim(),
      });
    }
    voucherMap.get(key)!.entries.push(entry);
  });

  const out: TdsRawRow[] = [];
  voucherMap.forEach((voucher) => {
    // TDS entries in this voucher
    const tdsEntries = voucher.entries.filter((e) => selectedTaxLedgers.has(String(e.Ledger || '')));
    const totalTds = Math.abs(tdsEntries.reduce((s, e) => s + toNumber(e.amount), 0));
    const tdsLedgerNames = Array.from(new Set(tdsEntries.map((e) => String(e.Ledger || '').trim()).filter(Boolean))).join('||');

    const partyName = resolvePartyName(voucher.entries);
    const narration = voucher.entries.map((e) => String(e.narration || '').trim()).find((t) => t.length > 0) || '';

    // One row per expense ledger
    const expenseMap = new Map<string, number>();
    voucher.entries.forEach((e) => {
      if (!isExpenseOrPurchase(e)) return;
      const ledger = String(e.Ledger || 'Unknown').trim();
      expenseMap.set(ledger, (expenseMap.get(ledger) || 0) + toNumber(e.amount));
    });

    expenseMap.forEach((netAmt, expLedger) => {
      out.push({
        voucher_number: voucher.number,
        date: voucher.date,
        voucher_type: voucher.type,
        expense_ledger: expLedger,
        net_amount: netAmt,
        party_name: partyName,
        narration,
        total_tds: totalTds,
        tds_ledger_names: tdsLedgerNames,
      });
    });
  });
  return out;
};

const STATUS_CONFIG: Record<
  string,
  { label: string; bgClass: string; textClass: string; borderClass: string; Icon: React.ElementType }
> = {
  deducted:         { label: 'Deducted',       bgClass: 'bg-green-50',  textClass: 'text-green-700',  borderClass: 'border-green-200', Icon: CheckCircle2 },
  short_deducted:   { label: 'Short Deducted', bgClass: 'bg-amber-50',  textClass: 'text-amber-700',  borderClass: 'border-amber-200', Icon: AlertTriangle },
  missed:           { label: 'Missed',          bgClass: 'bg-red-50',    textClass: 'text-red-700',    borderClass: 'border-red-200',   Icon: AlertOctagon },
  below_threshold:  { label: 'Below Limit',     bgClass: 'bg-slate-50',  textClass: 'text-slate-500',  borderClass: 'border-slate-200', Icon: Shield },
};

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

// ─────────────────────────────────────────────────────────────────────────────
// Annotation modal
// ─────────────────────────────────────────────────────────────────────────────
const NoteModal: React.FC<{
  voucherKey: string;
  existingNote: string;
  onSave: (key: string, note: string) => void;
  onClose: () => void;
}> = ({ voucherKey, existingNote, onSave, onClose }) => {
  const [text, setText] = useState(existingNote);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <MessageSquare size={16} /> Audit Note
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-2 font-mono truncate">{voucherKey}</p>
        <textarea
          autoFocus
          className="w-full border border-slate-300 rounded-lg p-3 text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:outline-none"
          rows={4}
          placeholder="Add an audit note, client explanation, or exception justification…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">
            Cancel
          </button>
          <button
            onClick={() => { onSave(voucherKey, text); onClose(); }}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700"
          >
            Save Note
          </button>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'finanalyzer_tds_filters';

const defaultThresholdConfig = (): TDSThresholdConfig => ({
  enabled: false,
  sectionMappings: [],
});

const TDSAnalysis: React.FC<TDSAnalysisProps> = ({
  data,
  externalSelectedLedgers,
  onLedgersUpdate,
  thresholdConfig: externalThresholdConfig,
  onThresholdConfigUpdate,
  annotations: externalAnnotations,
  onAnnotationsUpdate,
  isSqlMode = false,
}) => {
  // ── Party master attributes from mst_ledger (for PAN-on-file checks) ──────
  // Section 206AA: when a deductee's PAN is not on file, TDS must be deducted
  // at the higher of 20% / twice the prescribed rate / actual rate. Surfacing
  // the real PAN from mst_ledger.it_pan lets auditors spot 206AA exposure
  // immediately in the per-voucher table.
  const store = useTallyStore();
  const partyMasterByName = useMemo(() => {
    const map = new Map<string, { pan: string; gstin: string; regType: string }>();
    if (!store) return map;
    for (const l of store.ledgers.values()) {
      map.set(l.name.trim().toLowerCase(), {
        pan: (l.it_pan || '').trim(),
        gstin: (l.gstn || '').trim(),
        regType: (l.gst_registration_type || '').trim(),
      });
    }
    return map;
  }, [store]);

  // ── Ledger selection ──────────────────────────────────────────────────────
  const [internalLedgers, setInternalLedgers] = useState<string[]>([]);
  const selectedTaxLedgers = externalSelectedLedgers ?? internalLedgers;
  const setSelectedTaxLedgers = useCallback(
    (updater: string[] | ((p: string[]) => string[])) => {
      const next = typeof updater === 'function' ? updater(selectedTaxLedgers) : updater;
      onLedgersUpdate ? onLedgersUpdate(next) : setInternalLedgers(next);
    },
    [selectedTaxLedgers, onLedgersUpdate],
  );

  // ── Threshold config ──────────────────────────────────────────────────────
  const [internalThresholdConfig, setInternalThresholdConfig] = useState<TDSThresholdConfig>(defaultThresholdConfig);
  const thresholdConfig = externalThresholdConfig ?? internalThresholdConfig;
  const setThresholdConfig = useCallback(
    (cfg: TDSThresholdConfig) => {
      onThresholdConfigUpdate ? onThresholdConfigUpdate(cfg) : setInternalThresholdConfig(cfg);
    },
    [onThresholdConfigUpdate],
  );

  // ── Annotations ───────────────────────────────────────────────────────────
  const [internalAnnotations, setInternalAnnotations] = useState<AuditAnnotation[]>([]);
  const annotations = externalAnnotations ?? internalAnnotations;
  const setAnnotations = useCallback(
    (notes: AuditAnnotation[]) => {
      onAnnotationsUpdate ? onAnnotationsUpdate(notes) : setInternalAnnotations(notes);
    },
    [onAnnotationsUpdate],
  );
  const annotationMap = useMemo(() => {
    const m = new Map<string, string>();
    annotations.forEach((a) => m.set(a.key, a.note));
    return m;
  }, [annotations]);

  const handleSaveNote = useCallback(
    (key: string, note: string) => {
      const updated = annotations.filter((a) => a.key !== key);
      if (note.trim()) updated.push({ key, note: note.trim(), updatedAt: new Date().toISOString() });
      setAnnotations(updated);
    },
    [annotations, setAnnotations],
  );

  // ── UI state ──────────────────────────────────────────────────────────────
  const [isSelectionExpanded, setIsSelectionExpanded] = useState(true);
  const [isSectionPanelOpen, setIsSectionPanelOpen] = useState(false);
  const [isThresholdPanelOpen, setIsThresholdPanelOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [activeNoteKey, setActiveNoteKey] = useState<string | null>(null);
  const [taxLedgerSearch, setTaxLedgerSearch] = useState('');

  // ── Filters (persisted in localStorage) ──────────────────────────────────
  const [viewMode, setViewMode] = useState<'ledger' | 'party'>('ledger');
  const [mainSearch, setMainSearch] = useState('');
  const [minLedgerThreshold, setMinLedgerThreshold] = useState('0');
  const [minVoucherThreshold, setMinVoucherThreshold] = useState('0');
  const [statusFilter, setStatusFilter] = useState<TDSWorkerFilters['statusFilter']>('all');
  const [rateFilter, setRateFilter] = useState('all');

  // Load persisted filters on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.viewMode) setViewMode(saved.viewMode);
      if (saved.minLedgerThreshold !== undefined) setMinLedgerThreshold(saved.minLedgerThreshold);
      if (saved.minVoucherThreshold !== undefined) setMinVoucherThreshold(saved.minVoucherThreshold);
      if (saved.statusFilter) setStatusFilter(saved.statusFilter);
      if (saved.rateFilter) setRateFilter(saved.rateFilter);
    } catch {}
  }, []);

  // Persist filters whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ viewMode, minLedgerThreshold, minVoucherThreshold, statusFilter, rateFilter }),
      );
    } catch {}
  }, [viewMode, minLedgerThreshold, minVoucherThreshold, statusFilter, rateFilter]);

  // ── Raw rows ──────────────────────────────────────────────────────────────
  const [sqlRows, setSqlRows] = useState<TdsRawRow[] | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);

  const selectedTaxLedgerSet = useMemo(() => new Set(selectedTaxLedgers), [selectedTaxLedgers]);

  // B3/C1: Fetch focused rows from SQL backend when available
  useEffect(() => {
    if (!isSqlMode || selectedTaxLedgers.length === 0) {
      setSqlRows(null);
      return;
    }
    let cancelled = false;
    setSqlLoading(true);
    fetch('/api/data/tds-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tdsLedgers: selectedTaxLedgers,
        minVoucherAmount: parseFloat(minVoucherThreshold || '0') || 0,
      }),
    })
      .then((r) => r.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.ok && Array.isArray(payload.rows)) {
          setSqlRows(payload.rows as TdsRawRow[]);
        } else {
          setSqlRows(null);
        }
      })
      .catch(() => { if (!cancelled) setSqlRows(null); })
      .finally(() => { if (!cancelled) setSqlLoading(false); });
    return () => { cancelled = true; };
  }, [isSqlMode, selectedTaxLedgers, minVoucherThreshold]);

  // Derive raw rows (SQL or in-memory)
  const rawRows = useMemo<TdsRawRow[]>(() => {
    if (isSqlMode && sqlRows !== null) return sqlRows;
    if (selectedTaxLedgers.length === 0) return [];
    return convertToRawRows(data, selectedTaxLedgerSet);
  }, [isSqlMode, sqlRows, data, selectedTaxLedgers, selectedTaxLedgerSet]);

  // ── Web Worker ────────────────────────────────────────────────────────────
  const workerRef = useRef<Worker | null>(null);
  const [groups, setGroups] = useState<TDSSummaryGroup[]>([]);
  const [workerBusy, setWorkerBusy] = useState(false);

  useEffect(() => {
    workerRef.current = new Worker(new URL('../../workers/tdsWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current.onmessage = (e: MessageEvent<TDSWorkerOutput & { error?: string }>) => {
      setWorkerBusy(false);
      if (e.data.error) {
        console.error('TDS worker error:', e.data.error);
        return;
      }
      setGroups(e.data.groups);
    };
    return () => { workerRef.current?.terminate(); };
  }, []);

  // Dispatch to worker whenever inputs change
  useEffect(() => {
    if (!workerRef.current || selectedTaxLedgers.length === 0) {
      setGroups([]);
      return;
    }
    setWorkerBusy(true);
    const filters: TDSWorkerFilters = {
      viewMode,
      minVoucherAmount: parseFloat(minVoucherThreshold || '0') || 0,
      minLedgerAmount: parseFloat(minLedgerThreshold || '0') || 0,
      statusFilter,
      rateFilter,
    };
    workerRef.current.postMessage({ rows: rawRows, thresholdConfig, filters });
  }, [rawRows, thresholdConfig, viewMode, minVoucherThreshold, minLedgerThreshold, statusFilter, rateFilter, selectedTaxLedgers.length]);

  // ── Summary search filter ─────────────────────────────────────────────────
  const filteredGroups = useMemo(() => {
    if (!mainSearch.trim()) return groups;
    const term = mainSearch.toLowerCase();
    return groups.filter((g) => g.key.toLowerCase().includes(term));
  }, [groups, mainSearch]);

  // ── All ledger list ───────────────────────────────────────────────────────
  const allLedgers = useMemo(() => getUniqueLedgers(data), [data]);

  // ── Section mapping helpers ───────────────────────────────────────────────
  const getLedgerSection = (ledger: string): string => {
    return thresholdConfig.sectionMappings.find((m) => m.ledger === ledger)?.sectionCode ?? '';
  };

  const setLedgerSection = (ledger: string, sectionCode: string) => {
    const mappings: TDSSectionMapping[] = thresholdConfig.sectionMappings.filter((m) => m.ledger !== ledger);
    if (sectionCode) mappings.push({ ledger, sectionCode });
    setThresholdConfig({ ...thresholdConfig, sectionMappings: mappings });
  };

  // ── Excel export (C4 – non-blocking with progress toast) ──────────────────
  const [exportBusy, setExportBusy] = useState(false);
  const handleExport = useCallback(async () => {
    if (exportBusy) return;
    setExportBusy(true);
    try {
      // yield to browser before heavy work
      await new Promise((r) => setTimeout(r, 0));
      const { utils, writeFile } = await import('xlsx');
      const rows: object[] = [];
      filteredGroups.forEach((g) => {
        g.vouchers.forEach((v) => {
          const note = annotationMap.get(v.voucher_key) ?? '';
          rows.push({
            [viewMode === 'ledger' ? 'Ledger Name' : 'Party Name']: g.key,
            'Date': v.date,
            'Voucher Type': v.voucher_type,
            'Voucher No': v.voucher_number,
            'Party Name': v.party_name,
            'Expense Ledger': v.expenseLedger,
            'Ledger Hit (₹)': v.netAmount,
            'Status': STATUS_CONFIG[v.tdsStatus]?.label ?? v.tdsStatus,
            'TDS Deducted (₹)': v.tdsAmount,
            'Applied Rate (%)': v.calculatedRate,
            'Expected Rate (%)': v.expectedRate ?? '',
            'Rate Deviation (%)': v.rateDeviation ?? '',
            'Shortfall (₹)': v.shortfallAmount ?? '',
            'Section': v.sectionCode ?? '',
            'Party YTD Before (₹)': v.partyYtdBefore,
            'Party YTD After (₹)': v.partyYtdAfter,
            'Threshold Crossed': v.isThresholdCrossed ? 'Yes' : 'No',
            'TDS Ledgers': v.tdsLedgers.join(', '),
            'Narration': v.narration,
            'Audit Note': note,
          });
        });
      });
      const ws = utils.json_to_sheet(rows);
      const wb = utils.book_new();
      utils.book_append_sheet(wb, ws, 'TDS Analysis');
      writeFile(wb, `TDS_Analysis_${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
    } catch (err) {
      alert('Export failed. Please try again.');
      console.error(err);
    } finally {
      setExportBusy(false);
    }
  }, [filteredGroups, viewMode, annotationMap, exportBusy]);

  const toggleTaxLedger = (ledger: string) => {
    setSelectedTaxLedgers((prev) =>
      prev.includes(ledger) ? prev.filter((l) => l !== ledger) : [...prev, ledger],
    );
  };

  const isBusy = workerBusy || sqlLoading;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Note modal ── */}
      {activeNoteKey !== null && (
        <NoteModal
          voucherKey={activeNoteKey}
          existingNote={annotationMap.get(activeNoteKey) ?? ''}
          onSave={handleSaveNote}
          onClose={() => setActiveNoteKey(null)}
        />
      )}

      {/* ── Step 1: Select TDS Ledgers ── */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div
          className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer"
          onClick={() => setIsSelectionExpanded((p) => !p)}
        >
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg text-white shadow-sm">
              <Calculator size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Step 1: Configure TDS Tax Ledgers</h2>
              <p className="text-xs text-slate-500">Select ledgers where TDS liability is booked (e.g., 194C, 194J)</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold bg-blue-100 text-blue-700 px-3 py-1 rounded-full">
              {selectedTaxLedgers.length} selected
            </span>
            {isSelectionExpanded ? <ChevronUp size={20} className="text-slate-400" /> : <ChevronDown size={20} className="text-slate-400" />}
          </div>
        </div>

        {isSelectionExpanded && (
          <div className="p-6">
            <div className="flex flex-col md:flex-row gap-4 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="Search TDS tax ledgers…"
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  value={taxLedgerSearch}
                  onChange={(e) => setTaxLedgerSearch(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    setSelectedTaxLedgers(
                      allLedgers.filter((l) => {
                        const v = l.toLowerCase();
                        return v.includes('tds') && !v.includes('nontds') && !v.includes('non tds');
                      }),
                    )
                  }
                  className="px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 border border-blue-200"
                >
                  Auto-Select 'TDS'
                </button>
                <button
                  onClick={() => setSelectedTaxLedgers([])}
                  className="px-4 py-2 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 border border-slate-200"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="max-h-[150px] overflow-y-auto border border-slate-200 rounded-lg bg-slate-50 p-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                {allLedgers
                  .filter((l) => !taxLedgerSearch || l.toLowerCase().includes(taxLedgerSearch.toLowerCase()))
                  .map((ledger) => {
                    const isSelected = selectedTaxLedgers.includes(ledger);
                    return (
                      <div
                        key={ledger}
                        onClick={() => toggleTaxLedger(ledger)}
                        className={`flex items-center gap-3 p-2 rounded-md cursor-pointer border transition-all select-none ${isSelected ? 'bg-blue-50 border-blue-300' : 'bg-white border-slate-200'}`}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>
                          {isSelected && <CheckSquare size={12} className="text-white" />}
                        </div>
                        <span className={`text-sm truncate ${isSelected ? 'text-blue-900 font-medium' : 'text-slate-600'}`} title={ledger}>
                          {ledger}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Step 2 (Optional): Section Mapping ── */}
      {selectedTaxLedgers.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div
            className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer"
            onClick={() => setIsSectionPanelOpen((p) => !p)}
          >
            <div className="flex items-center gap-3">
              <div className="bg-indigo-600 p-2 rounded-lg text-white shadow-sm">
                <Tag size={18} />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-800">
                  Step 2 (Optional): Map TDS Sections
                </h2>
                <p className="text-xs text-slate-500">
                  Tag each TDS ledger with its section (194C, 194J…) to unlock threshold rules and rate alerts
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {thresholdConfig.sectionMappings.length > 0 && (
                <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-semibold">
                  {thresholdConfig.sectionMappings.length} mapped
                </span>
              )}
              {isSectionPanelOpen ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
            </div>
          </div>

          {isSectionPanelOpen && (
            <div className="p-5 space-y-2">
              <p className="text-xs text-slate-500 mb-3">
                Mapping enables statutory threshold checks and expected-rate comparison per section.
              </p>
              <div className="space-y-2">
                {selectedTaxLedgers.map((ledger) => (
                  <div key={ledger} className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm font-medium text-slate-700 w-64 truncate shrink-0" title={ledger}>
                      {ledger}
                    </span>
                    <select
                      className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                      value={getLedgerSection(ledger)}
                      onChange={(e) => setLedgerSection(ledger, e.target.value)}
                    >
                      <option value="">— Not mapped —</option>
                      {TDS_SECTION_DEFAULTS.filter((s) => s.code !== 'OTHER').map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.code} — {s.label} (default {s.defaultRate}%)
                        </option>
                      ))}
                    </select>
                    {getLedgerSection(ledger) && (
                      <span className="text-xs bg-indigo-50 text-indigo-600 border border-indigo-100 px-2 py-0.5 rounded-full">
                        {getLedgerSection(ledger)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 3 (Optional): Threshold Rules ── */}
      {selectedTaxLedgers.length > 0 && thresholdConfig.sectionMappings.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div
            className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer"
            onClick={() => setIsThresholdPanelOpen((p) => !p)}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg text-white shadow-sm ${thresholdConfig.enabled ? 'bg-emerald-600' : 'bg-slate-400'}`}>
                <Shield size={18} />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-800">Step 3 (Optional): Threshold Rules</h2>
                <p className="text-xs text-slate-500">
                  Party-level YTD accumulation — only flag "Missed" when statutory limit is actually crossed
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                <div
                  className={`relative inline-flex w-10 h-5 rounded-full transition-colors ${thresholdConfig.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
                  onClick={() => setThresholdConfig({ ...thresholdConfig, enabled: !thresholdConfig.enabled })}
                >
                  <span
                    className={`inline-block w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5 ${thresholdConfig.enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'}`}
                  />
                </div>
                <span className="text-xs font-semibold text-slate-600">{thresholdConfig.enabled ? 'On' : 'Off'}</span>
              </label>
              {isThresholdPanelOpen ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
            </div>
          </div>

          {isThresholdPanelOpen && (
            <div className="p-5">
              {thresholdConfig.enabled ? (
                <>
                  <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg p-3 text-xs mb-4">
                    <Info size={14} className="mt-0.5 shrink-0" />
                    <span>
                      Threshold mode is <strong>ON</strong>. Vouchers below statutory single-transaction and annual
                      limits are marked <strong>Below Limit</strong> (not "Missed"). Accumulation is tracked{' '}
                      <strong>per party</strong> in date order.
                    </span>
                  </div>
                  <div className="space-y-3">
                    {TDS_SECTION_DEFAULTS.filter((s) =>
                      thresholdConfig.sectionMappings.some((m) => m.sectionCode === s.code),
                    ).map((s) => (
                      <div key={s.code} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-bold text-slate-800 text-sm">{s.code}</span>
                          <span className="text-xs text-slate-500">{s.label}</span>
                        </div>
                        <div className="grid grid-cols-3 gap-4 text-xs text-slate-600">
                          <div>
                            <span className="font-semibold">Per-txn limit:</span>{' '}
                            ₹{s.singleTxnLimit > 0 ? s.singleTxnLimit.toLocaleString('en-IN') : '—'}
                          </div>
                          <div>
                            <span className="font-semibold">Annual limit:</span>{' '}
                            ₹{s.annualLimit > 0 ? s.annualLimit.toLocaleString('en-IN') : '—'}
                          </div>
                          <div>
                            <span className="font-semibold">Default rate:</span> {s.defaultRate}%
                            {s.rates.length > 1 && (
                              <span className="ml-1 text-slate-400">
                                ({s.rates.map((r) => `${r.label}: ${r.rate}%`).join(', ')})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Threshold mode is <strong>OFF</strong>. Every expense voucher without TDS will be flagged as
                    "Missed", regardless of amount. Enable to apply statutory thresholds per section.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {selectedTaxLedgers.length === 0 ? (
        <div className="bg-slate-100 border-2 border-dashed border-slate-300 rounded-xl p-16 text-center text-slate-500">
          <AlertTriangle size={56} className="mx-auto text-slate-300 mb-4" />
          <h3 className="text-xl font-bold text-slate-700">TDS Configuration Required</h3>
          <p className="max-w-md mx-auto mt-2">
            Select your TDS tax ledgers in Step 1 to start analyzing expenses for compliance.
          </p>
        </div>
      ) : (
        <>
          {/* ── Main Controls ── */}
          <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200 space-y-5">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
              {/* View toggle */}
              <div className="flex bg-slate-100 p-1 rounded-xl w-full lg:w-auto">
                <button
                  onClick={() => setViewMode('ledger')}
                  className={`flex-1 lg:flex-none px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-2 ${viewMode === 'ledger' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  <Layers size={16} /> By Ledger
                </button>
                <button
                  onClick={() => setViewMode('party')}
                  className={`flex-1 lg:flex-none px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-2 ${viewMode === 'party' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  <Users size={16} /> By Party
                </button>
              </div>

              <div className="flex flex-wrap gap-3 w-full lg:w-auto">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
                  <input
                    type="text"
                    placeholder={`Search ${viewMode === 'ledger' ? 'Ledgers' : 'Parties'}…`}
                    className="w-full pl-9 pr-4 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 shadow-sm"
                    value={mainSearch}
                    onChange={(e) => setMainSearch(e.target.value)}
                  />
                </div>
                <button
                  onClick={handleExport}
                  disabled={exportBusy || isBusy}
                  className={`px-5 py-2 rounded-lg text-sm font-bold flex items-center gap-2 shadow-sm transition-colors ${exportBusy || isBusy ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-green-600 text-white hover:bg-green-700'}`}
                >
                  <Download size={16} />
                  {exportBusy ? 'Exporting…' : 'Export'}
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-4 border-t border-slate-100">
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">
                  Min. Ledger Vol (₹)
                </label>
                <input
                  type="number"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 shadow-sm"
                  value={minLedgerThreshold}
                  onChange={(e) => setMinLedgerThreshold(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">
                  Min. Voucher Dr (₹)
                </label>
                <input
                  type="number"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 shadow-sm"
                  value={minVoucherThreshold}
                  onChange={(e) => setMinVoucherThreshold(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">
                  Audit Status
                </label>
                <select
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 shadow-sm"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as TDSWorkerFilters['statusFilter'])}
                >
                  <option value="all">Show All</option>
                  <option value="deducted">✓ Deducted Only</option>
                  <option value="short_deducted">⚠ Short Deducted</option>
                  <option value="missed">✗ Missed Only</option>
                  <option value="below_threshold">○ Below Threshold</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">
                  Applied TDS Rate
                </label>
                <select
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 shadow-sm"
                  value={rateFilter}
                  onChange={(e) => setRateFilter(e.target.value)}
                >
                  <option value="all">All Rates</option>
                  <option value="0.1">0.1% (194Q Goods)</option>
                  <option value="1">1% (194C Ind/HUF)</option>
                  <option value="2">2% (194C Others / 194I(a))</option>
                  <option value="5">5% (194H Commission)</option>
                  <option value="10">10% (194J / 194I(b))</option>
                  <option value="20">20% (Non-PAN)</option>
                </select>
              </div>
            </div>
          </div>

          {/* ── Loading indicator ── */}
          {isBusy && (
            <div className="bg-blue-50 border border-blue-100 text-blue-700 text-sm px-4 py-3 rounded-xl flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              {sqlLoading ? 'Fetching TDS data from SQL backend…' : 'Computing analysis…'}
            </div>
          )}

          {/* ── Results header ── */}
          {!isBusy && (
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2 text-xs text-slate-400 font-bold uppercase tracking-wider">
                <SlidersHorizontal size={14} />
                {filteredGroups.length} {viewMode}s matched
              </div>
              <div className="text-[10px] text-slate-400">
                * Compliance = Deducted ÷ (Deducted + Short Deducted + Missed)
              </div>
            </div>
          )}

          {/* ── Groups list ── */}
          <div className="space-y-4">
            {filteredGroups.map((group) => {
              const isOpen = expandedKey === group.key;
              const applicableCount = group.deductedCount + group.shortDeductedCount + group.missedCount;
              const compColor =
                group.complianceRate === 100
                  ? 'text-green-600'
                  : group.complianceRate > 50
                  ? 'text-amber-600'
                  : 'text-red-600';
              const compBarColor =
                group.complianceRate === 100
                  ? 'bg-green-500'
                  : group.complianceRate > 50
                  ? 'bg-amber-500'
                  : 'bg-red-500';

              return (
                <div key={group.key} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                  {/* Group header */}
                  <div
                    className={`p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer hover:bg-slate-50 transition-colors ${isOpen ? 'bg-slate-50 border-b border-slate-100' : ''}`}
                    onClick={() => setExpandedKey(isOpen ? null : group.key)}
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div
                        className={`p-3 rounded-xl shrink-0 ${
                          group.complianceRate === 100
                            ? 'bg-green-100 text-green-700'
                            : group.complianceRate > 50
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {viewMode === 'ledger' ? <Layers size={22} /> : <Users size={22} />}
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-extrabold text-slate-900 truncate text-lg">{group.key}</h3>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                          {applicableCount > 0 && (
                            <>
                              <span className="text-xs text-green-600 font-medium">{group.deductedCount} Deducted</span>
                              {group.shortDeductedCount > 0 && (
                                <span className="text-xs text-amber-600 font-medium">{group.shortDeductedCount} Short</span>
                              )}
                              {group.missedCount > 0 && (
                                <span className="text-xs text-red-600 font-medium">{group.missedCount} Missed</span>
                              )}
                            </>
                          )}
                          {group.belowThresholdCount > 0 && (
                            <span className="text-xs text-slate-400 font-medium">{group.belowThresholdCount} Below Limit</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-8 shrink-0 flex-wrap">
                      <div className="text-right">
                        <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Total Hit</p>
                        <p className={`font-mono font-bold text-base ${group.totalLedgerHit < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                          ₹{fmt(group.totalLedgerHit)}
                        </p>
                      </div>
                      {viewMode === 'party' && (
                        <div className="text-right hidden sm:block">
                          <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Party YTD</p>
                          <p className="font-mono font-bold text-base text-indigo-600">
                            ₹{fmt(group.partyYtdTotal)}
                          </p>
                        </div>
                      )}
                      <div className="text-right hidden sm:block">
                        <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Avg Rate</p>
                        <p className="font-mono font-bold text-base text-blue-600 flex items-center justify-end gap-1">
                          <Percent size={13} />
                          {group.avgAppliedRate.toFixed(2)}%
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Compliance</p>
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-2 bg-slate-200 rounded-full overflow-hidden hidden lg:block">
                            <div
                              className={`h-full rounded-full transition-all ${compBarColor}`}
                              style={{ width: `${group.complianceRate}%` }}
                            />
                          </div>
                          <p className={`font-bold text-base ${compColor}`}>
                            {group.complianceRate.toFixed(0)}%
                          </p>
                        </div>
                      </div>
                      <div className="text-slate-400 bg-white p-1 rounded-full border border-slate-100 shadow-sm">
                        {isOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                      </div>
                    </div>
                  </div>

                  {/* Detail table */}
                  {isOpen && (
                    <div className="border-t border-slate-100 bg-white overflow-x-auto">
                      <table className="w-full text-sm text-left border-collapse">
                        <thead className="bg-slate-50 text-slate-500 font-bold uppercase tracking-tighter border-b border-slate-200">
                          <tr>
                            <th className="px-4 py-3">Date</th>
                            <th className="px-4 py-3">Voucher</th>
                            <th className="px-4 py-3">{viewMode === 'ledger' ? 'Party' : 'Expense Ledger'}</th>
                            <th className="px-4 py-3 text-right bg-slate-100/50">Hit (₹)</th>
                            <th className="px-4 py-3 text-center">Status</th>
                            <th className="px-4 py-3 text-center">Rate %</th>
                            <th className="px-4 py-3 text-right">TDS (₹)</th>
                            <th className="px-4 py-3 text-right" title="Party YTD accumulated expense">YTD (₹)</th>
                            {thresholdConfig.enabled && <th className="px-4 py-3 text-center">Section</th>}
                            <th className="px-4 py-3">TDS Ledgers</th>
                            <th className="px-4 py-3">Narration</th>
                            <th className="px-4 py-3 text-center">Note</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {group.vouchers.map((v, idx) => {
                            const sc = STATUS_CONFIG[v.tdsStatus];
                            const hasNote = !!annotationMap.get(v.voucher_key);
                            return (
                              <tr
                                key={`${v.voucher_key}-${v.expenseLedger}-${idx}`}
                                className="hover:bg-slate-50/80 transition-colors"
                              >
                                <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{v.date}</td>
                                <td className="px-4 py-3 font-bold text-slate-900 whitespace-nowrap text-xs">
                                  <div>{v.voucher_number}</div>
                                  <div className="font-normal text-slate-400">{v.voucher_type}</div>
                                </td>
                                <td className="px-4 py-3 text-slate-700 font-medium truncate max-w-[200px]"
                                    title={viewMode === 'ledger' ? v.party_name : v.expenseLedger}>
                                  <div className="truncate">{viewMode === 'ledger' ? v.party_name : v.expenseLedger}</div>
                                  {viewMode === 'ledger' && (() => {
                                    const m = partyMasterByName.get((v.party_name || '').trim().toLowerCase());
                                    if (!m) return null;
                                    // Section 206AA flag: PAN missing AND TDS was deducted (or
                                    // should have been) → highlight in red.
                                    const panMissing = !m.pan && v.tdsAmount > 0;
                                    return (
                                      <div className="text-[10px] mt-0.5 truncate font-mono"
                                           title={`GSTIN ${m.gstin || '—'} · PAN ${m.pan || 'MISSING'} · ${m.regType || ''}`}>
                                        {m.pan
                                          ? <span className="text-slate-400">PAN {m.pan}</span>
                                          : panMissing
                                            ? <span className="text-red-600 font-bold">⚠ PAN MISSING · 206AA</span>
                                            : <span className="text-slate-300">PAN —</span>}
                                      </div>
                                    );
                                  })()}
                                </td>
                                <td className={`px-4 py-3 text-right font-mono font-extrabold bg-slate-50/50 ${v.netAmount < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                                  ₹{fmt(v.netAmount)}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase border-2 ${sc.bgClass} ${sc.textClass} ${sc.borderClass}`}>
                                    <sc.Icon size={11} />
                                    {sc.label}
                                  </span>
                                  {/* Rate deviation badge (B5) */}
                                  {v.rateDeviation !== null && Math.abs(v.rateDeviation) > 0.5 && v.tdsAmount > 0 && (
                                    <span className={`block mt-0.5 text-[9px] font-bold ${v.rateDeviation < 0 ? 'text-red-500' : 'text-blue-500'}`}>
                                      {v.rateDeviation > 0 ? '+' : ''}{v.rateDeviation.toFixed(2)}% vs expected
                                    </span>
                                  )}
                                  {/* Shortfall (B6) */}
                                  {v.shortfallAmount !== null && v.shortfallAmount > 0 && (
                                    <span className="block mt-0.5 text-[9px] font-bold text-amber-600">
                                      ₹{fmt(v.shortfallAmount)} short
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <div className={`font-mono font-bold text-xs px-1.5 py-0.5 rounded border ${v.tdsAmount > 0 ? 'text-blue-700 bg-blue-50 border-blue-100' : 'text-slate-400 bg-slate-100 border-slate-200'}`}>
                                    {v.calculatedRate.toFixed(2)}%
                                    {v.expectedRate !== null && (
                                      <span className="block text-[9px] text-slate-400 font-normal">
                                        exp {v.expectedRate}%
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-slate-500 font-semibold whitespace-nowrap">
                                  ₹{fmt(v.tdsAmount)}
                                </td>
                                {/* B4: Party YTD */}
                                <td className="px-4 py-3 text-right font-mono text-xs text-indigo-600 whitespace-nowrap">
                                  ₹{fmt(v.partyYtdAfter)}
                                  {v.isThresholdCrossed && (
                                    <span className="block text-[9px] font-bold text-emerald-600">↑ crossed</span>
                                  )}
                                </td>
                                {thresholdConfig.enabled && (
                                  <td className="px-4 py-3 text-center">
                                    {v.sectionCode ? (
                                      <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded border border-indigo-100 font-bold">
                                        {v.sectionCode}
                                      </span>
                                    ) : (
                                      <span className="text-slate-300 text-[10px]">—</span>
                                    )}
                                  </td>
                                )}
                                <td className="px-4 py-3 text-slate-500 text-[11px] max-w-[180px] truncate" title={v.tdsLedgers.join(', ') || '—'}>
                                  {v.tdsLedgers.join(', ') || '—'}
                                </td>
                                <td className="px-4 py-3 text-slate-400 italic max-w-[180px] truncate text-[11px]" title={v.narration}>
                                  {v.narration}
                                </td>
                                {/* D2: Note button */}
                                <td className="px-4 py-3 text-center">
                                  <button
                                    title={hasNote ? 'Edit note' : 'Add note'}
                                    onClick={(e) => { e.stopPropagation(); setActiveNoteKey(v.voucher_key); }}
                                    className={`p-1.5 rounded-lg border transition-colors ${hasNote ? 'bg-yellow-50 border-yellow-300 text-yellow-600 hover:bg-yellow-100' : 'bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100'}`}
                                  >
                                    <MessageSquare size={13} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!isBusy && filteredGroups.length === 0 && (
            <div className="p-24 text-center text-slate-400 bg-white rounded-2xl border-2 border-dashed border-slate-200">
              <BookOpen size={64} className="mx-auto mb-4 opacity-10" />
              <p className="text-lg font-medium">No audit results found.</p>
              <p className="text-sm mt-1">Try relaxing thresholds or changing the status filter.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TDSAnalysis;
