import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTallyStore, isPlPrimaryGroup } from '../../services/tally';
import { LedgerEntry, PartyMatrixProfile } from '../../types';
import {
  Download,
  Upload,
  FileJson,
  Search,
  Filter,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronRight,
  Settings2,
  ArrowUp,
  ArrowDown,
  Loader2,
  X,
  Sparkles,
  ListChecks,
  MinusSquare,
  ClipboardCopy,
  FileText,
} from 'lucide-react';
import type {
  PartyRow,
  CounterLedgerStat,
  Bucket,
  PartyMatrixWorkerInput,
  PartyMatrixWorkerOutput,
  VoucherDetailRow,
} from '../../workers/partyMatrixWorker';

interface Props {
  data: LedgerEntry[];
  externalProfile?: PartyMatrixProfile;
  onProfileUpdate?: (profile: PartyMatrixProfile) => void;
}

type SortKey =
  | 'partyName'
  | 'totalSales'
  | 'totalPurchase'
  | 'totalExpenses'
  | 'tdsDeducted'
  | 'tdsExpensePct'
  | 'gstAmount'
  | 'gstSalesExpensePct'
  | 'rcmAmount'
  | 'bankAmount'
  | 'others'
  | 'netBalance';

type AnomalyFilter = 'all' | 'zero_tds' | 'zero_gst' | 'balance_gap' | 'high_others';

const MAX_VISIBLE_ROWS_DEFAULT = 400;

// ── utility formatters ────────────────────────────────────────────────────────
const toNum = (value: any): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const sanitizeList = (v: any) =>
  Array.isArray(v) ? Array.from(new Set(v.map((x) => String(x || '').trim()).filter(Boolean))) : [];
// Accounting-style number formatter: positives render normally, negatives
// wrap in parentheses (the convention CAs read at a glance). Bucket totals
// in this module are SIGN-PRESERVED — sales/income credits sum negative,
// purchase/expense debits sum positive — so reversal-heavy parties surface
// visually instead of being silently absorbed into a "looks fine" total.
const money = (v: number) => {
  const n = Number(v || 0);
  if (n < 0) {
    return `(${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  }
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Compact Indian abbreviation — turns 1,00,12,36,934.75 into "10.01 Cr" so
// the number columns stop being unreadable snakes of digits. Full precision
// remains available on hover via the `title` attribute.
//
// Native Indian ladder only: Cr (≥1 Crore) → L (≥1 Lakh) → full number with
// en-IN grouping. "K" is dropped — no accountant says "thirty-eight K" when
// they can say "thirty-eight thousand".
const CRORE = 1_00_00_000;
const LAKH = 1_00_000;
const MINUS = '−'; // en-dash style minus — visually lines up better in a column

const splitCompact = (
  v: number,
): { value: string; unit: '' | 'Cr' | 'L'; neg: boolean; zero: boolean } => {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a < 0.005) return { value: '—', unit: '', neg: false, zero: true };
  const neg = n < 0;
  if (a >= CRORE) return { value: (a / CRORE).toFixed(2), unit: 'Cr', neg, zero: false };
  if (a >= LAKH) return { value: (a / LAKH).toFixed(2), unit: 'L', neg, zero: false };
  return {
    value: a.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
    unit: '',
    neg,
    zero: false,
  };
};

const compact = (v: number): string => {
  const { value, unit, neg, zero } = splitCompact(v);
  if (zero) return '—';
  const sign = neg ? MINUS : '';
  return unit ? `${sign}${value} ${unit}` : `${sign}${value}`;
};
const signedCompact = (v: number): string => {
  const { value, unit, neg, zero } = splitCompact(v);
  if (zero) return '—';
  const sign = neg ? MINUS : '+';
  return unit ? `${sign}${value} ${unit}` : `${sign}${value}`;
};

// React cell renderer for compact numbers: the main number is bold-prominent,
// the unit ("Cr" / "L") tints muted. Gives that "pro financial dashboard" feel
// and stops units from competing with digits for attention.
const CompactCell: React.FC<{
  v: number;
  signed?: boolean;
  tone?: 'pos' | 'neg' | 'neutral';
  title?: string;
  className?: string;
}> = ({ v, signed = false, tone = 'neutral', title, className = '' }) => {
  const { value, unit, neg, zero } = splitCompact(v);
  if (zero) return <span className={`text-slate-300 ${className}`}>—</span>;
  const sign = signed ? (neg ? MINUS : '+') : neg ? MINUS : '';
  const toneCls =
    tone === 'pos' ? 'text-emerald-700' : tone === 'neg' ? 'text-rose-700' : '';
  return (
    <span className={`inline-flex items-baseline justify-end gap-1 ${toneCls} ${className}`} title={title}>
      <span className="tabular-nums font-semibold">
        {sign}
        {value}
      </span>
      {unit && <span className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">{unit}</span>}
    </span>
  );
};
const pct = (v: number | null) =>
  v === null || !Number.isFinite(v)
    ? '—'
    : `${v.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const signed = (v: number) => (Math.abs(v) < 0.005 ? '0.00' : `${v >= 0 ? '+' : ''}${money(v)}`);

const isMaster = (entry: LedgerEntry): boolean => {
  const raw = entry?.is_master_ledger;
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (['1', 'true', 'yes', 'y'].includes(t)) return true;
  if (['0', 'false', 'no', 'n'].includes(t)) return false;
  const n = Number(t);
  return Number.isFinite(n) ? n > 0 : false;
};

const toDdMmYyyy = (dateIso: string) => {
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

// ── bucket -> visual tag colors for drill-down chips ─────────────────────────
const BUCKET_STYLES: Record<Bucket, { bg: string; text: string; label: string }> = {
  sales:    { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', label: 'Sales' },
  purchase: { bg: 'bg-violet-50 border-violet-200',   text: 'text-violet-700',  label: 'Purchase' },
  expense:  { bg: 'bg-amber-50 border-amber-200',     text: 'text-amber-700',   label: 'Expense' },
  tds:      { bg: 'bg-rose-50 border-rose-200',       text: 'text-rose-700',    label: 'TDS' },
  gst:      { bg: 'bg-sky-50 border-sky-200',         text: 'text-sky-700',     label: 'GST' },
  rcm:      { bg: 'bg-fuchsia-50 border-fuchsia-200', text: 'text-fuchsia-700', label: 'RCM' },
  bank:     { bg: 'bg-indigo-50 border-indigo-200',   text: 'text-indigo-700',  label: 'Bank' },
  others:   { bg: 'bg-slate-50 border-slate-200',     text: 'text-slate-600',   label: 'Other' },
};

// ── Ledger multi-select ──────────────────────────────────────────────────────
// Modern multi-select with:
//   • chip stack of current selections (click × to remove)
//   • live search filter with clear button
//   • "Select all visible" / "Unselect visible" bulk ops (act only on the
//     currently-filtered subset — so you can type "tds" and bulk-tag 20
//     ledgers in one click)
//   • "Auto Suggest" to pre-populate from regex heuristics
//   • Keyboard: Enter toggles the first visible row
// Built natively (no react-select dep) to keep the bundle small.
interface SelectorProps {
  title: string;
  accentText: string;
  accentBg: string;
  ledgers: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
}

const Selector: React.FC<SelectorProps> = ({
  title,
  accentText,
  accentBg,
  ledgers,
  selected,
  onChange,
  suggestions,
}) => {
  const [q, setQ] = useState('');
  const qLower = q.trim().toLowerCase();

  const shown = useMemo(
    () => (!qLower ? ledgers : ledgers.filter((x) => x.toLowerCase().includes(qLower))),
    [ledgers, qLower],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Derived: which visible items are already selected?
  const visibleSelected = useMemo(
    () => shown.filter((x) => selectedSet.has(x)),
    [shown, selectedSet],
  );
  const visibleUnselected = shown.length - visibleSelected.length;
  const allVisibleSelected = shown.length > 0 && visibleUnselected === 0;

  const toggle = (ledger: string) => {
    if (selectedSet.has(ledger)) onChange(selected.filter((x) => x !== ledger));
    else onChange([...selected, ledger]);
  };

  const selectAllVisible = () => {
    const merged = new Set(selected);
    shown.forEach((x) => merged.add(x));
    onChange(Array.from(merged));
  };

  const unselectVisible = () => {
    const visibleSet = new Set(shown);
    onChange(selected.filter((x) => !visibleSet.has(x)));
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'Enter' && shown.length > 0) {
      e.preventDefault();
      toggle(shown[0]);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2.5 flex flex-col">
      {/* Title + count */}
      <div className="flex items-center justify-between">
        <p className={`text-xs font-bold uppercase tracking-wider ${accentText}`}>{title}</p>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${accentBg} ${accentText}`}>
          {selected.length} selected
        </span>
      </div>

      {/* Chip stack of current selections */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 max-h-24 overflow-auto p-1.5 bg-slate-50 border border-slate-200 rounded-lg">
          {selected.map((ledger) => (
            <span
              key={ledger}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 bg-white border border-slate-300 rounded-full text-[11px] text-slate-700 shadow-sm"
            >
              <span className="truncate max-w-[160px]">{ledger}</span>
              <button
                onClick={() => toggle(ledger)}
                aria-label={`Remove ${ledger}`}
                className="p-0.5 rounded-full hover:bg-rose-100 hover:text-rose-700 text-slate-400 transition-colors"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search box with clear-X */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400 pointer-events-none" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search ledger — Enter to toggle first match"
          className="w-full pl-8 pr-8 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
        />
        {q && (
          <button
            onClick={() => setQ('')}
            aria-label="Clear search"
            className="absolute right-2 top-2 p-0.5 text-slate-400 hover:text-slate-700"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded-lg bg-indigo-50 border-indigo-300 text-indigo-700 font-bold hover:bg-indigo-100"
          onClick={() => onChange(Array.from(new Set([...selected, ...suggestions])))}
          title={`Tag ${suggestions.length} auto-detected candidates`}
        >
          <Sparkles size={11} /> Auto Suggest ({suggestions.length})
        </button>
        {shown.length > 0 && shown.length < ledgers.length && (
          allVisibleSelected ? (
            <button
              onClick={unselectVisible}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded-lg bg-amber-50 border-amber-300 text-amber-700 font-bold hover:bg-amber-100"
              title="Unselect everything matching the current search"
            >
              <MinusSquare size={11} /> Unselect {shown.length} visible
            </button>
          ) : (
            <button
              onClick={selectAllVisible}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded-lg bg-emerald-50 border-emerald-300 text-emerald-700 font-bold hover:bg-emerald-100"
              title="Add every ledger matching the current search"
            >
              <ListChecks size={11} /> Select {visibleUnselected} visible
            </button>
          )
        )}
        {selected.length > 0 && (
          <button
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded-lg bg-white border-slate-300 text-slate-600 font-bold hover:bg-slate-50 ml-auto"
            onClick={() => onChange([])}
            title="Remove every selection"
          >
            <X size={11} /> Clear all
          </button>
        )}
      </div>

      {/* Scrollable list */}
      <div className="max-h-56 overflow-auto bg-slate-50 border border-slate-200 rounded-lg p-1">
        {shown.length === 0 ? (
          <p className="text-[11px] text-slate-400 italic text-center py-4">
            No ledgers match "{q}"
          </p>
        ) : (
          shown.map((ledger) => {
            const chosen = selectedSet.has(ledger);
            const isSuggested = suggestions.includes(ledger);
            return (
              <button
                key={ledger}
                className={`w-full px-2 py-1.5 text-left text-xs rounded flex items-center gap-2 transition-colors ${
                  chosen
                    ? 'bg-indigo-50 border border-indigo-200 text-indigo-800'
                    : 'hover:bg-white border border-transparent'
                }`}
                onClick={() => toggle(ledger)}
              >
                {chosen ? (
                  <CheckSquare size={12} className="shrink-0 text-indigo-600" />
                ) : (
                  <Square size={12} className="shrink-0 text-slate-400" />
                )}
                <span className="truncate flex-1">{ledger}</span>
                {isSuggested && !chosen && (
                  <span className="shrink-0 text-[9px] font-bold text-indigo-500 uppercase tracking-wider">
                    suggest
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      <p className="text-[10px] text-slate-400">
        {shown.length === ledgers.length
          ? `${ledgers.length.toLocaleString('en-IN')} total ledgers`
          : `${shown.length.toLocaleString('en-IN')} of ${ledgers.length.toLocaleString('en-IN')} visible`}
      </p>
    </div>
  );
};

// ── KPI tile ─────────────────────────────────────────────────────────────────
const Kpi: React.FC<{ label: string; value: string | number; tone?: 'default' | 'warn' | 'danger' | 'ok' }> = ({
  label,
  value,
  tone = 'default',
}) => {
  const toneCls =
    tone === 'danger'
      ? 'bg-rose-50 border-rose-200 text-rose-700'
      : tone === 'warn'
      ? 'bg-amber-50 border-amber-200 text-amber-700'
      : tone === 'ok'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
      : 'bg-white border-slate-200 text-slate-700';
  return (
    <div className={`border rounded-xl px-3 py-2 ${toneCls}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-lg font-black leading-tight mt-0.5">{value}</p>
    </div>
  );
};

const PartyLedgerMatrix: React.FC<Props> = ({ data, externalProfile, onProfileUpdate }) => {
  const store = useTallyStore();
  // Per-party master attributes from mst_ledger (when the ZIP store is
  // loaded). Surfaced as a metadata strip under each party name so the
  // auditor sees real GSTIN / PAN / state / GST registration type — fields
  // that drive in-state vs inter-state tax decisions and Sec 194Q PAN
  // verification. Lookup is case-insensitive on ledger name to survive
  // whitespace and case drift between transaction rows and master rows.
  const partyMasterByName = useMemo(() => {
    const map = new Map<string, { gstin: string; pan: string; state: string; gstRegType: string; mobile: string; email: string }>();
    if (!store) return map;
    for (const l of store.ledgers.values()) {
      const key = l.name.trim().toLowerCase();
      if (!key) continue;
      map.set(key, {
        gstin: (l.gstn || '').trim(),
        pan: (l.it_pan || '').trim(),
        state: (l.mailing_state || '').trim(),
        gstRegType: (l.gst_registration_type || '').trim(),
        mobile: (l.mobile || '').trim(),
        email: (l.email || '').trim(),
      });
    }
    return map;
  }, [store]);
  const [partyQ, setPartyQ] = useState('');
  const [msg, setMsg] = useState('');
  const profileFileRef = useRef<HTMLInputElement | null>(null);
  const lastSentRef = useRef('');
  // One-shot: only auto-collapse the tag panel on the FIRST external-profile
  // application. Every subsequent re-hydration (caused by our own
  // onProfileUpdate bouncing back through the parent) must leave the panel
  // open — otherwise every checkbox click closes the panel.
  const didInitialCollapseRef = useRef(false);
  const [hideZeroActivity, setHideZeroActivity] = useState(true);

  // ── Preprocess data on the main thread (fast: one pass) ────────────────────
  const { primaries, suggestedPrimaries, allLedgers, ledgerPrimary, txRows, mstRows } = useMemo(() => {
    const p = new Set<string>();
    const l = new Set<string>();
    const lp = new Map<string, string>(); // ledger → its Tally primary group
    const tx: LedgerEntry[] = [];
    const ms: LedgerEntry[] = [];
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const primary = String(r.TallyPrimary || '').trim();
      const ledger = String(r.Ledger || '').trim();
      if (primary) p.add(primary);
      if (ledger) {
        l.add(ledger);
        if (!lp.has(ledger) && primary) lp.set(ledger, primary);
      }
      if (isMaster(r)) ms.push(r);
      else tx.push(r);
    }
    const allP = Array.from(p).sort((a, b) => a.localeCompare(b));
    return {
      primaries: allP,
      suggestedPrimaries: allP.filter((x) => /(debtor|creditor)/i.test(x)),
      allLedgers: Array.from(l).sort((a, b) => a.localeCompare(b)),
      ledgerPrimary: lp,
      txRows: tx,
      mstRows: ms,
    };
  }, [data]);

  // ── Selection state ────────────────────────────────────────────────────────
  const [selectedPrimary, setSelectedPrimary] = useState('');
  const [tdsLedgers, setTdsLedgers] = useState<string[]>([]);
  const [gstLedgers, setGstLedgers] = useState<string[]>([]);
  const [rcmLedgers, setRcmLedgers] = useState<string[]>([]);

  // Collapsible tag panel — collapsed when any tag list is non-empty
  const [tagPanelOpen, setTagPanelOpen] = useState(true);

  useEffect(() => {
    if (selectedPrimary) return;
    const fallback = externalProfile?.selectedPrimaryGroup || suggestedPrimaries[0] || primaries[0] || '';
    if (fallback) setSelectedPrimary(fallback);
  }, [externalProfile, primaries, selectedPrimary, suggestedPrimaries]);

  useEffect(() => {
    if (!externalProfile) return;
    const p: PartyMatrixProfile = {
      selectedPrimaryGroup: String(externalProfile.selectedPrimaryGroup || '').trim(),
      tdsLedgers: sanitizeList(externalProfile.tdsLedgers),
      gstLedgers: sanitizeList(externalProfile.gstLedgers),
      rcmLedgers: sanitizeList(externalProfile.rcmLedgers),
    };
    const incoming = JSON.stringify(p);
    // Skip the echo of our own update — the parent has just handed back what
    // we sent up, and re-applying would be a no-op that still re-runs any
    // side-effects below (and previously re-collapsed the tag panel).
    if (incoming === lastSentRef.current) return;
    lastSentRef.current = incoming;
    setSelectedPrimary(p.selectedPrimaryGroup);
    setTdsLedgers(p.tdsLedgers);
    setGstLedgers(p.gstLedgers);
    setRcmLedgers(p.rcmLedgers);
    // Only auto-collapse once, the first time a populated profile arrives.
    if (
      !didInitialCollapseRef.current &&
      (p.tdsLedgers.length || p.gstLedgers.length || p.rcmLedgers.length)
    ) {
      setTagPanelOpen(false);
      didInitialCollapseRef.current = true;
    }
  }, [externalProfile]);

  const effectivePrimary = useMemo(
    () => (primaries.includes(selectedPrimary) ? selectedPrimary : suggestedPrimaries[0] || primaries[0] || ''),
    [primaries, selectedPrimary, suggestedPrimaries],
  );

  useEffect(() => {
    if (!onProfileUpdate) return;
    const p: PartyMatrixProfile = {
      selectedPrimaryGroup: effectivePrimary || '',
      tdsLedgers: sanitizeList(tdsLedgers),
      gstLedgers: sanitizeList(gstLedgers),
      rcmLedgers: sanitizeList(rcmLedgers),
    };
    const s = JSON.stringify(p);
    if (s === lastSentRef.current) return;
    lastSentRef.current = s;
    onProfileUpdate(p);
  }, [effectivePrimary, gstLedgers, onProfileUpdate, rcmLedgers, tdsLedgers]);

  // A genuine TDS/GST/RCM ledger lives under Duties & Taxes / a liability head —
  // never under a P&L head. So exclude ledgers whose primary group reads as
  // sales/income/purchase/expense; otherwise an income ledger that merely
  // mentions a tax in its name (e.g. "Service Charges Collected (IGST)") gets
  // mis-suggested as GST and swallows real sales into the GST bucket.
  const isPlPrimary = (ledger: string) => isPlPrimaryGroup(ledgerPrimary.get(ledger));
  const suggestedTds = useMemo(
    () => allLedgers.filter((x) => /(tds|194)/i.test(x) && !isPlPrimary(x)),
    [allLedgers, ledgerPrimary],
  );
  const suggestedGst = useMemo(
    () => allLedgers.filter((x) => /(igst|cgst|sgst|utgst|gst|cess)/i.test(x) && !isPlPrimary(x)),
    [allLedgers, ledgerPrimary],
  );
  const suggestedRcm = useMemo(
    () => allLedgers.filter((x) => /(rcm|reverse charge)/i.test(x) && !isPlPrimary(x)),
    [allLedgers, ledgerPrimary],
  );

  // ── Web Worker ─────────────────────────────────────────────────────────────
  const workerRef = useRef<Worker | null>(null);
  const [analysis, setAnalysis] = useState<{
    rows: PartyRow[];
    voucherDetails: VoucherDetailRow[];
    partyUniverseCount: number;
    unbalancedVoucherCount: number;
  }>({ rows: [], voucherDetails: [], partyUniverseCount: 0, unbalancedVoucherCount: 0 });
  const [computing, setComputing] = useState(false);

  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../../workers/partyMatrixWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current.onmessage = (e: MessageEvent<PartyMatrixWorkerOutput>) => {
      setComputing(false);
      if (e.data.error) {
        console.error('Party Matrix worker error:', e.data.error);
        return;
      }
      setAnalysis({
        rows: e.data.rows,
        voucherDetails: e.data.voucherDetails,
        partyUniverseCount: e.data.partyUniverseCount,
        unbalancedVoucherCount: e.data.unbalancedVoucherCount,
      });
    };
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Debounced dispatch — avoids recomputing on every checkbox click
  useEffect(() => {
    if (!workerRef.current) return;
    if (!effectivePrimary) {
      setAnalysis({ rows: [], voucherDetails: [], partyUniverseCount: 0, unbalancedVoucherCount: 0 });
      return;
    }
    const handle = window.setTimeout(() => {
      setComputing(true);
      const payload: PartyMatrixWorkerInput = {
        txRows,
        mstRows,
        primary: effectivePrimary,
        tdsLedgers,
        gstLedgers,
        rcmLedgers,
      };
      workerRef.current!.postMessage(payload);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [effectivePrimary, txRows, mstRows, tdsLedgers, gstLedgers, rcmLedgers]);

  // ── Search + anomaly + sort ────────────────────────────────────────────────
  const [anomaly, setAnomaly] = useState<AnomalyFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('partyName');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Compact (default) renders 1,00,12,36,934 as "10.01 Cr" — full precision
  // still available on cell hover.
  const [numberMode, setNumberMode] = useState<'compact' | 'full'>('compact');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const fmt = (v: number) => (numberMode === 'compact' ? compact(v) : money(v));
  const fmtSigned = (v: number) => (numberMode === 'compact' ? signedCompact(v) : signed(v));

  // Full-precision hover text for every numeric cell
  const fullMoney = (v: number) =>
    Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fullSigned = (v: number) =>
    Math.abs(v) < 0.005 ? '0.00' : `${v >= 0 ? '+' : '−'}${fullMoney(Math.abs(v))}`;

  // Render helper: in compact mode returns a split cell (number + muted unit);
  // in full mode returns plain text. Always right-aligned, tabular-numed.
  const num = (
    v: number,
    opts?: { signed?: boolean; tone?: 'pos' | 'neg' | 'neutral' },
  ): React.ReactNode => {
    const title = opts?.signed ? fullSigned(v) : fullMoney(v);
    if (numberMode === 'compact') {
      return <CompactCell v={v} signed={opts?.signed} tone={opts?.tone} title={title} />;
    }
    const text = opts?.signed ? signed(v) : money(v);
    const toneCls =
      opts?.tone === 'pos' ? 'text-emerald-700' : opts?.tone === 'neg' ? 'text-rose-700' : '';
    return (
      <span className={`tabular-nums ${toneCls}`} title={title}>
        {text}
      </span>
    );
  };

  // ── Per-column filter row (below the sort header) ─────────────────────────
  // `colMin[k]` is a minimum-value threshold for the numeric column `k`.
  // A row passes when Math.abs(r[k]) >= colMin[k]. Empty/0 = no filter.
  const [colMin, setColMin] = useState<Record<string, number>>({});
  // Counter-Ledger Hits filter: which buckets must the row contain at least
  // one of? Empty set = no filter.
  const [counterBuckets, setCounterBuckets] = useState<Set<Bucket>>(new Set());
  const setColMinValue = (k: string, v: number) =>
    setColMin((prev) => {
      const next = { ...prev };
      if (!v || v <= 0) delete next[k];
      else next[k] = v;
      return next;
    });
  const toggleCounterBucket = (b: Bucket) =>
    setCounterBuckets((prev) => {
      const n = new Set(prev);
      if (n.has(b)) n.delete(b);
      else n.add(b);
      return n;
    });
  const clearColFilters = () => {
    setColMin({});
    setCounterBuckets(new Set());
  };
  const anyColFilterActive =
    Object.keys(colMin).length > 0 || counterBuckets.size > 0;

  // A party counts as "active" only if it moved money in the period — filters
  // out 100s of dormant masters that otherwise dominate the view.
  const isActive = (r: PartyRow) =>
    Math.abs(r.totalSales) > 0.01 ||
    Math.abs(r.totalPurchase) > 0.01 ||
    Math.abs(r.totalExpenses) > 0.01 ||
    Math.abs(r.tdsDeducted) > 0.01 ||
    Math.abs(r.gstAmount) > 0.01 ||
    Math.abs(r.rcmAmount) > 0.01 ||
    Math.abs(r.bankAmount) > 0.01 ||
    Math.abs(r.others) > 0.01 ||
    Math.abs(r.movementNet) > 0.01;

  const tdsTagged = tdsLedgers.length > 0;
  const gstTagged = gstLedgers.length > 0;

  const filteredRows = useMemo(() => {
    const q = partyQ.trim().toLowerCase();
    let base = analysis.rows;

    if (hideZeroActivity) base = base.filter(isActive);

    if (q) {
      base = base.filter(
        (r) =>
          r.partyName.toLowerCase().includes(q) ||
          r.counterLedgers.some((c) => c.ledger.toLowerCase().includes(q)),
      );
    }

    // Anomaly filters — only apply when the relevant tag list is populated.
    // Otherwise "Zero TDS" would flag every party in the book.
    //
    // Bucket totals are SIGN-PRESERVED (income-side ledgers carry credit
    // sign, expense-side carry debit sign — see partyMatrixWorker header
    // note). So all magnitude tests below use Math.abs() rather than
    // ">0 / <1" comparisons that previously assumed positive-only data.
    if (anomaly === 'zero_tds' && tdsTagged) {
      base = base.filter((r) => Math.abs(r.totalExpenses) > 0 && Math.abs(r.tdsDeducted) < 1);
    } else if (anomaly === 'zero_gst' && gstTagged) {
      base = base.filter(
        (r) =>
          Math.abs(r.totalSales) + Math.abs(r.totalExpenses) > 0 &&
          Math.abs(r.gstAmount) < 1
      );
    } else if (anomaly === 'balance_gap') {
      base = base.filter((r) => Math.abs(r.balanceGap) > 1);
    } else if (anomaly === 'high_others') {
      const denom = (r: PartyRow) =>
        Math.abs(r.totalSales) + Math.abs(r.totalPurchase) + Math.abs(r.totalExpenses) + Math.abs(r.others);
      base = base.filter((r) => {
        const d = denom(r);
        return d > 0 && Math.abs(r.others) / d > 0.25;
      });
    }

    // Per-column minimum thresholds (filter row under header)
    const colMinEntries = (Object.entries(colMin) as [string, number][]).filter(
      ([, v]) => v > 0,
    );
    if (colMinEntries.length > 0) {
      base = base.filter((r) =>
        colMinEntries.every(
          ([k, min]) => Math.abs(toNum((r as any)[k])) >= min,
        ),
      );
    }

    // Counter-Ledger bucket filter
    if (counterBuckets.size > 0) {
      base = base.filter((r) =>
        r.counterLedgers.some((c) => counterBuckets.has(c.bucket)),
      );
    }

    const sorted = [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = toNum(av);
      const bn = toNum(bv);
      return sortDir === 'asc' ? an - bn : bn - an;
    });

    return sorted;
  }, [analysis.rows, partyQ, anomaly, sortKey, sortDir, hideZeroActivity, tdsTagged, gstTagged, colMin, counterBuckets]);

  const visibleRows = useMemo(
    () => (showAll ? filteredRows : filteredRows.slice(0, MAX_VISIBLE_ROWS_DEFAULT)),
    [filteredRows, showAll],
  );

  // ── Totals (across the filtered — not truncated — set) ─────────────────────
  const totals = useMemo(() => {
    const a = filteredRows.reduce(
      (s, r) => ({
        sales: s.sales + r.totalSales,
        purchase: s.purchase + r.totalPurchase,
        expenses: s.expenses + r.totalExpenses,
        tds: s.tds + r.tdsDeducted,
        gst: s.gst + r.gstAmount,
        rcm: s.rcm + r.rcmAmount,
        bank: s.bank + r.bankAmount,
        others: s.others + r.others,
        net: s.net + r.netBalance,
      }),
      { sales: 0, purchase: 0, expenses: 0, tds: 0, gst: 0, rcm: 0, bank: 0, others: 0, net: 0 },
    );
    // Ratios are reported as positive percentages regardless of bucket
    // sign convention — TDS-to-expense ratio is meaningful as a magnitude.
    const tdsExpensePct = Math.abs(a.expenses) > 0 ? (Math.abs(a.tds) / Math.abs(a.expenses)) * 100 : null;
    const gstDen = Math.abs(a.sales) + Math.abs(a.expenses);
    const gstSalesExpensePct = gstDen > 0 ? (Math.abs(a.gst) / gstDen) * 100 : null;
    return { ...a, tdsExpensePct, gstSalesExpensePct };
  }, [filteredRows]);

  // ── KPI computations ───────────────────────────────────────────────────────
  // Anomaly KPIs (Zero TDS / Zero GST) are only meaningful once the user has
  // tagged the corresponding ledger class — otherwise every row trivially has
  // "zero TDS" because nothing is being classified as TDS yet.
  const kpis = useMemo(() => {
    const rows = analysis.rows.filter(isActive);
    // Bucket totals are sign-preserved; use absolute magnitude for KPI tests.
    const withExpense = rows.filter((r) => Math.abs(r.totalExpenses) > 0);
    const zeroTds = tdsTagged
      ? withExpense.filter((r) => Math.abs(r.tdsDeducted) < 1).length
      : null;
    const zeroGst = gstTagged
      ? rows.filter(
          (r) =>
            Math.abs(r.totalSales) + Math.abs(r.totalExpenses) > 0 &&
            Math.abs(r.gstAmount) < 1
        ).length
      : null;
    const balanceGaps = analysis.rows.filter((r) => Math.abs(r.balanceGap) > 1).length;
    return {
      partyUniverse: analysis.partyUniverseCount,
      activeParties: rows.length,
      filtered: filteredRows.length,
      zeroTds,
      zeroGst,
      balanceGaps,
      unbalanced: analysis.unbalancedVoucherCount,
    };
  }, [analysis, filteredRows.length, tdsTagged, gstTagged]);

  const needsSelection = tdsLedgers.length === 0 || gstLedgers.length === 0 || rcmLedgers.length === 0;

  // ── Sort helper ────────────────────────────────────────────────────────────
  const setSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'partyName' ? 'asc' : 'desc');
    }
  };
  const SortIcon: React.FC<{ k: SortKey }> = ({ k }) => {
    if (sortKey !== k) return <span className="opacity-20">↕</span>;
    return sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
  };

  // ── Profile import/export ──────────────────────────────────────────────────
  const exportProfile = () => {
    const payload = {
      profileType: 'party-matrix',
      version: 1,
      exportedOn: toDdMmYyyy(new Date().toISOString()),
      partyMatrixProfile: {
        selectedPrimaryGroup: effectivePrimary || '',
        tdsLedgers: sanitizeList(tdsLedgers),
        gstLedgers: sanitizeList(gstLedgers),
        rcmLedgers: sanitizeList(rcmLedgers),
      },
    };
    const uri = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
    const a = document.createElement('a');
    a.href = uri;
    a.download = `Party_Matrix_Profile_${toDdMmYyyy(new Date().toISOString()).replace(/\//g, '-')}.json`;
    a.click();
    setMsg('Profile exported successfully.');
    setTimeout(() => setMsg(''), 1800);
  };

  const importProfile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.target?.result || '{}'));
        const src = parsed?.partyMatrixProfile ? parsed.partyMatrixProfile : parsed;
        setSelectedPrimary(String(src?.selectedPrimaryGroup || '').trim());
        setTdsLedgers(sanitizeList(src?.tdsLedgers));
        setGstLedgers(sanitizeList(src?.gstLedgers));
        setRcmLedgers(sanitizeList(src?.rcmLedgers));
        setMsg('Profile imported successfully.');
      } catch {
        setMsg('Invalid profile file.');
      }
      setTimeout(() => setMsg(''), 2200);
    };
    r.readAsText(file);
    e.target.value = '';
  };

  // ── Multi-sheet Excel exporter ─────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);

  const exportExcel = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const XLSX = await import('xlsx-js-style');
      const stamp = toDdMmYyyy(new Date().toISOString()).replace(/\//g, '-');

      const thinBorder = {
        top:    { style: 'thin', color: { rgb: 'CBD5E1' } },
        right:  { style: 'thin', color: { rgb: 'CBD5E1' } },
        bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
        left:   { style: 'thin', color: { rgb: 'CBD5E1' } },
      } as const;

      const headerStyle = (bg: string) => ({
        font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: bg } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thinBorder,
      });

      const titleStyle = {
        font: { name: 'Calibri', sz: 16, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '1E3A8A' } },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: thinBorder,
      };

      const metaStyle = {
        font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: '1E40AF' } },
        fill: { fgColor: { rgb: 'EFF6FF' } },
        alignment: { horizontal: 'left' },
        border: thinBorder,
      };

      const dataStyle = (row: number, rightAlign: boolean, bold: boolean = false, numFmt?: string) => {
        const s: any = {
          font: { name: 'Calibri', sz: 10, color: { rgb: '0F172A' }, bold },
          fill: { fgColor: { rgb: row % 2 === 0 ? 'FFFFFF' : 'F8FAFC' } },
          alignment: { horizontal: rightAlign ? 'right' : 'left', vertical: 'center', wrapText: !rightAlign },
          border: thinBorder,
        };
        if (numFmt) s.numFmt = numFmt;
        return s;
      };

      const totalStyle = (rightAlign: boolean, numFmt?: string) => ({
        font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '0F766E' } },
        alignment: { horizontal: rightAlign ? 'right' : 'left' },
        border: thinBorder,
        numFmt,
      });

      const paint = (ws: any, r: number, c: number, style: any) => {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (cell) cell.s = style;
      };

      const wb = XLSX.utils.book_new();

      // ═══════════════ Sheet 1: Summary ═══════════════
      {
        const headers = [
          'Party/Ledger Name',
          'Voucher Count',
          'First Date',
          'Last Date',
          'Total Sales',
          'Total Purchase',
          'Total Expenses',
          'TDS Deducted',
          'TDS / Expense %',
          'GST',
          'GST / (Sales+Exp) %',
          'RCM',
          'Bank',
          'Others/Adj',
          'Net Balance (+Cr / -Dr)',
          'Top Expense/Purchase Ledgers',
        ];
        const aoa: any[][] = [
          ['Party Ledger Matrix — Summary'],
          [`Selected Tally Primary Group: ${effectivePrimary || 'N/A'}`],
          [
            `TDS Ledgers: ${tdsLedgers.length} · GST Ledgers: ${gstLedgers.length} · RCM Ledgers: ${rcmLedgers.length}`,
          ],
          ['Net Balance Convention: Credit is positive (+), Debit is negative (-).'],
          [''],
          headers,
        ];
        filteredRows.forEach((r) =>
          aoa.push([
            r.partyName,
            r.voucherCount,
            r.firstDate ? toDdMmYyyy(r.firstDate) : '',
            r.lastDate ? toDdMmYyyy(r.lastDate) : '',
            r.totalSales,
            r.totalPurchase,
            r.totalExpenses,
            r.tdsDeducted,
            r.tdsExpensePct,
            r.gstAmount,
            r.gstSalesExpensePct,
            r.rcmAmount,
            r.bankAmount,
            r.others,
            r.netBalance,
            r.expenseLedgerList,
          ]),
        );
        aoa.push([
          'TOTAL',
          '',
          '',
          '',
          totals.sales,
          totals.purchase,
          totals.expenses,
          totals.tds,
          totals.tdsExpensePct,
          totals.gst,
          totals.gstSalesExpensePct,
          totals.rcm,
          totals.bank,
          totals.others,
          totals.net,
          '',
        ]);
        aoa.push([]);
        aoa.push(['Observations']);
        aoa.push([`Parties in selected group: ${analysis.partyUniverseCount}`]);
        aoa.push([`Parties in current filter: ${filteredRows.length}`]);
        aoa.push([`Vouchers with debit/credit imbalance: ${analysis.unbalancedVoucherCount}`]);
        aoa.push([`Parties with movement vs closing gap > 1.00: ${kpis.balanceGaps}`]);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [
          { wch: 34 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
          { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
          { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 60 },
        ];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
          { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
          { s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 1, ySplit: 6 };
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 5, c: 0 }, e: { r: 5, c: lastCol } }) };

        // Paint title / meta / header
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let r = 1; r <= 3; r++) for (let c = 0; c <= lastCol; c++) paint(ws, r, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 5, c, headerStyle('111827'));

        const firstData = 6;
        const lastData = firstData + filteredRows.length - 1;
        for (let r = firstData; r <= lastData; r++) {
          const row = filteredRows[r - firstData];
          // columns: 0 name | 1 voucher count | 2 first | 3 last | 4..14 numbers | 15 ledger list
          paint(ws, r, 0, dataStyle(r, false, true));
          paint(ws, r, 1, dataStyle(r, true, false, '#,##0'));
          paint(ws, r, 2, dataStyle(r, true));
          paint(ws, r, 3, dataStyle(r, true));
          for (let c = 4; c <= 14; c++) {
            let fmt = '#,##0.00';
            if (c === 8 || c === 10) fmt = '0.00"%"';
            const style = dataStyle(r, true, false, fmt);
            // Conditional shading
            if (c === 8 && row.totalExpenses > 0 && row.tdsDeducted < 1) {
              style.fill = { fgColor: { rgb: 'FEE2E2' } };
              style.font = { ...style.font, color: { rgb: '9F1239' }, bold: true };
            } else if (c === 10 && (row.totalSales + row.totalExpenses) > 0 && row.gstAmount < 1) {
              style.fill = { fgColor: { rgb: 'FEF3C7' } };
              style.font = { ...style.font, color: { rgb: '92400E' }, bold: true };
            } else if (c === 14 && Math.abs(row.balanceGap) > 1) {
              style.fill = { fgColor: { rgb: 'FFEDD5' } };
              style.font = { ...style.font, color: { rgb: '9A3412' }, bold: true };
            }
            paint(ws, r, c, style);
          }
          paint(ws, r, 15, dataStyle(r, false));
        }

        const totalRow = firstData + filteredRows.length;
        paint(ws, totalRow, 0, totalStyle(false));
        for (let c = 1; c <= 3; c++) paint(ws, totalRow, c, totalStyle(true));
        for (let c = 4; c <= 14; c++) {
          let fmt = '#,##0.00';
          if (c === 8 || c === 10) fmt = '0.00"%"';
          paint(ws, totalRow, c, totalStyle(true, fmt));
        }
        paint(ws, totalRow, 15, totalStyle(false));

        // Observations block
        const obsRow = totalRow + 2;
        for (let c = 0; c <= lastCol; c++)
          paint(ws, obsRow, c, {
            font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: '92400E' } },
            fill: { fgColor: { rgb: 'FEF3C7' } },
            alignment: { horizontal: 'left' },
            border: thinBorder,
          });
        for (let r = obsRow + 1; r <= obsRow + 4; r++)
          for (let c = 0; c <= lastCol; c++)
            paint(ws, r, c, {
              font: { name: 'Calibri', sz: 10, color: { rgb: '78350F' } },
              fill: { fgColor: { rgb: 'FFFBEB' } },
              alignment: { horizontal: 'left' },
              border: thinBorder,
            });

        XLSX.utils.book_append_sheet(wb, ws, 'Summary');
      }

      // ═══════════════ Sheet 2: Party × Ledger pivot ═══════════════
      {
        // Collect unique counter-ledgers across filtered rows
        const ledgerTotals = new Map<string, { bucket: Bucket; total: number }>();
        filteredRows.forEach((r) => {
          r.counterLedgers.forEach((c) => {
            const existing = ledgerTotals.get(c.ledger);
            if (existing) existing.total += c.amount;
            else ledgerTotals.set(c.ledger, { bucket: c.bucket, total: c.amount });
          });
        });
        const ledgerList = Array.from(ledgerTotals.entries())
          .sort((a, b) => b[1].total - a[1].total)
          .map(([ledger, info]) => ({ ledger, bucket: info.bucket }));

        const headers = ['Party', 'Bucket Tag →', ...ledgerList.map((l) => l.ledger)];
        const bucketRow = ['', '', ...ledgerList.map((l) => BUCKET_STYLES[l.bucket].label)];

        const aoa: any[][] = [
          [`Party × Counter-Ledger Pivot (Primary: ${effectivePrimary || 'N/A'})`],
          [`Values are apportioned per-voucher; ${filteredRows.length} parties × ${ledgerList.length} ledgers.`],
          [''],
          headers,
          bucketRow,
        ];

        filteredRows.forEach((r) => {
          const map = new Map(r.counterLedgers.map((c) => [c.ledger, c.amount]));
          aoa.push([r.partyName, '', ...ledgerList.map((l) => map.get(l.ledger) || 0)]);
        });

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [{ wch: 34 }, { wch: 12 }, ...ledgerList.map(() => ({ wch: 16 }))];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 1, ySplit: 5 };
        if (ledgerList.length > 0) {
          ws['!autofilter'] = {
            ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }),
          };
        }

        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('111827'));

        // Bucket tag row — colored per bucket
        for (let i = 0; i < ledgerList.length; i++) {
          const b = ledgerList[i].bucket;
          const bg =
            b === 'sales' ? 'D1FAE5' : b === 'purchase' ? 'EDE9FE' : b === 'expense' ? 'FEF3C7'
            : b === 'tds' ? 'FECDD3' : b === 'gst' ? 'E0F2FE' : b === 'rcm' ? 'FAE8FF'
            : b === 'bank' ? 'E0E7FF' : 'F1F5F9';
          paint(ws, 4, i + 2, {
            font: { name: 'Calibri', sz: 9, bold: true, color: { rgb: '334155' } },
            fill: { fgColor: { rgb: bg } },
            alignment: { horizontal: 'center' },
            border: thinBorder,
          });
        }
        paint(ws, 4, 0, metaStyle);
        paint(ws, 4, 1, metaStyle);

        const firstData = 5;
        const lastData = firstData + filteredRows.length - 1;
        for (let r = firstData; r <= lastData; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          paint(ws, r, 1, dataStyle(r, true));
          for (let c = 2; c <= lastCol; c++) {
            paint(ws, r, c, dataStyle(r, true, false, '#,##0.00'));
          }
        }

        XLSX.utils.book_append_sheet(wb, ws, 'Party x Ledger');
      }

      // ═══════════════ Sheet 3: Voucher Detail ═══════════════
      {
        const partySet = new Set(filteredRows.map((r) => r.partyName));
        const rowsFiltered = analysis.voucherDetails.filter((v) => partySet.has(v.partyName));

        const headers = [
          'Party', 'Date', 'Voucher Type', 'Voucher No', 'Party Amount (+Cr/-Dr)',
          'Expense', 'Sales', 'Purchase', 'TDS', 'GST', 'RCM', 'Bank', 'Others',
          'Counter-Ledger Breakdown',
        ];
        const aoa: any[][] = [
          ['Voucher-Level Detail (apportioned per-party)'],
          [`Rows: ${rowsFiltered.length}. Each row is one party's slice of one voucher.`],
          [''],
          headers,
        ];
        rowsFiltered.forEach((v) =>
          aoa.push([
            v.partyName,
            v.date ? toDdMmYyyy(v.date) : '',
            v.voucher_type,
            v.voucher_number,
            v.partyAmount,
            v.expenseAmount,
            v.salesAmount,
            v.purchaseAmount,
            v.tdsAmount,
            v.gstAmount,
            v.rcmAmount,
            v.bankAmount,
            v.othersAmount,
            v.counterLedgersText,
          ]),
        );
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [
          { wch: 30 }, { wch: 11 }, { wch: 18 }, { wch: 14 }, { wch: 18 },
          { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
          { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 80 },
        ];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 1, ySplit: 4 };
        ws['!autofilter'] = {
          ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }),
        };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('111827'));
        for (let r = 4; r <= 4 + rowsFiltered.length - 1; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          paint(ws, r, 1, dataStyle(r, true));
          paint(ws, r, 2, dataStyle(r, false));
          paint(ws, r, 3, dataStyle(r, true));
          for (let c = 4; c <= 12; c++) paint(ws, r, c, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 13, dataStyle(r, false));
        }
        XLSX.utils.book_append_sheet(wb, ws, 'Voucher Detail');
      }

      // ═══════════════ Sheet 4: Anomalies ═══════════════
      {
        const anomalies: {
          type: string;
          partyName: string;
          metric: string;
          value: number | string;
          note: string;
        }[] = [];
        analysis.rows.forEach((r) => {
          if (r.totalExpenses > 0 && r.tdsDeducted < 1) {
            anomalies.push({
              type: 'Zero TDS',
              partyName: r.partyName,
              metric: 'Expense Hit',
              value: r.totalExpenses,
              note: 'Expense recorded but no TDS withheld — verify section applicability.',
            });
          }
          if ((r.totalSales + r.totalExpenses) > 0 && r.gstAmount < 1) {
            anomalies.push({
              type: 'Zero GST',
              partyName: r.partyName,
              metric: 'Sales+Expense',
              value: r.totalSales + r.totalExpenses,
              note: 'Taxable activity with zero GST tagged — check ITC/output GST.',
            });
          }
          if (Math.abs(r.balanceGap) > 1) {
            anomalies.push({
              type: 'Balance Gap',
              partyName: r.partyName,
              metric: 'Closing − Movement',
              value: r.balanceGap,
              note: 'Master closing balance disagrees with computed movement net.',
            });
          }
          const denom =
            Math.abs(r.totalSales) + Math.abs(r.totalPurchase) + Math.abs(r.totalExpenses) + Math.abs(r.others);
          if (denom > 0 && r.others / denom > 0.25) {
            anomalies.push({
              type: 'High Others',
              partyName: r.partyName,
              metric: 'Others Share',
              value: (r.others / denom) * 100,
              note: '>25% of activity is untagged/Others — tag more ledgers for precision.',
            });
          }
        });

        const headers = ['Anomaly', 'Party', 'Metric', 'Value', 'Note'];
        const aoa: any[][] = [
          ['Anomalies — audit review candidates'],
          [`Total flagged: ${anomalies.length}`],
          [''],
          headers,
        ];
        anomalies.forEach((a) =>
          aoa.push([a.type, a.partyName, a.metric, a.value, a.note]),
        );

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 20 }, { wch: 16 }, { wch: 70 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 0, ySplit: 4 };
        ws['!autofilter'] = {
          ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }),
        };

        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('B91C1C'));

        for (let r = 4; r <= 4 + anomalies.length - 1; r++) {
          const a = anomalies[r - 4];
          const tagColor =
            a.type === 'Zero TDS' ? 'FEE2E2'
            : a.type === 'Zero GST' ? 'FEF3C7'
            : a.type === 'Balance Gap' ? 'FFEDD5'
            : 'F1F5F9';
          paint(ws, r, 0, {
            ...dataStyle(r, false, true),
            fill: { fgColor: { rgb: tagColor } },
          });
          paint(ws, r, 1, dataStyle(r, false, true));
          paint(ws, r, 2, dataStyle(r, false));
          paint(ws, r, 3, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 4, dataStyle(r, false));
        }

        XLSX.utils.book_append_sheet(wb, ws, 'Anomalies');
      }

      // ═══════════════ Sheet 5: Tagged Ledgers (reproducibility) ═══════════════
      {
        const maxLen = Math.max(tdsLedgers.length, gstLedgers.length, rcmLedgers.length, 1);
        const aoa: any[][] = [
          ['Tagged Ledgers — profile snapshot'],
          [`Exported on ${toDdMmYyyy(new Date().toISOString())}`],
          [''],
          ['TDS Ledgers', 'GST Ledgers', 'RCM Ledgers'],
        ];
        for (let i = 0; i < maxLen; i++) {
          aoa.push([tdsLedgers[i] || '', gstLedgers[i] || '', rcmLedgers[i] || '']);
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 40 }, { wch: 40 }, { wch: 40 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } },
        ];
        for (let c = 0; c <= 2; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= 2; c++) paint(ws, 1, c, metaStyle);
        paint(ws, 3, 0, headerStyle('9F1239'));
        paint(ws, 3, 1, headerStyle('075985'));
        paint(ws, 3, 2, headerStyle('86198F'));
        for (let r = 4; r <= 3 + maxLen; r++) {
          for (let c = 0; c <= 2; c++) paint(ws, r, c, dataStyle(r, false));
        }
        XLSX.utils.book_append_sheet(wb, ws, 'Tagged Ledgers');
      }

      XLSX.writeFile(wb, `Party_Ledger_Matrix_${stamp}.xlsx`, { compression: true });
      setMsg('Excel exported successfully.');
      setTimeout(() => setMsg(''), 1800);
    } catch (err: any) {
      // Surface the actual error so failures are diagnosable instead of
      // disappearing behind a generic "please retry" message. Shape:
      //   "Excel export failed:\n  TypeError: ws[addr] is undefined"
      // The full stack still lands in the dev console for deeper inspection.
      console.error('[PartyLedgerMatrix] Excel export failed:', err);
      const name = err?.name || 'Error';
      const message = err?.message || String(err) || 'Unknown error';
      const guardHint =
        analysis.rows.length === 0
          ? '\n\nHint: no analysis rows are loaded. Select a Tally Primary Group (and import data) before exporting.'
          : filteredRows.length === 0
            ? '\n\nHint: current filters yielded zero rows. Clear filters and retry.'
            : '';
      window.alert(`Excel export failed:\n  ${name}: ${message}${guardHint}\n\nFull stack in DevTools console.`);
    } finally {
      setExporting(false);
    }
  };

  // ── Markdown-for-LLM export ────────────────────────────────────────────────
  // Produces a single self-contained markdown document that can be pasted into
  // ChatGPT / Claude / Gemini for a party-level audit review. The document
  // carries (a) a narrative header explaining the data, (b) an embedded audit
  // prompt covering TDS / GST / RCM, and (c) fenced CSV tables for the top
  // parties, anomalies, and counter-ledger detail.
  //
  // Key design decisions:
  //   • Per-party rows include comma-separated TDS / GST / RCM ledger NAMES
  //     actually hit by that party — names in Tally commonly encode the TDS
  //     section ("TDS 194C — Contractors") or GST rate ("CGST Input 18%"), so
  //     the LLM can infer applicability without us having to guess.
  //   • Numbers are emitted as full en-IN integers (no decimals, no Cr/L
  //     abbreviations) — LLMs parse digits more reliably than mixed-unit.
  //   • CSV, not Markdown tables, because fenced CSV survives ChatGPT's
  //     table rendering and keeps rows aligned no matter how wide the content.
  const [copyingMd, setCopyingMd] = useState<'idle' | 'copying' | 'copied'>('idle');

  const buildLLMMarkdown = (): string => {
    const rows = filteredRows;
    const enInt = (v: number) =>
      Math.round(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    const pct1 = (v: number | null) =>
      v === null || !Number.isFinite(v) ? '' : v.toFixed(1);
    // CSV field escaping: wrap in quotes if contains comma, quote, or newline; escape internal quotes.
    const csv = (v: any): string => {
      const s = String(v ?? '');
      if (s === '') return '';
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    // Active filter summary
    const activeFilters: string[] = [];
    if (partyQ.trim()) activeFilters.push(`Search: "${partyQ.trim()}"`);
    if (anomaly !== 'all') activeFilters.push(`Anomaly: ${anomaly}`);
    if (counterBuckets.size > 0)
      activeFilters.push(`Counter buckets: ${Array.from(counterBuckets).join(', ')}`);
    const colMinActive = (Object.entries(colMin) as [string, number][])
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}≥${enInt(v)}`);
    if (colMinActive.length) activeFilters.push(`Column thresholds: ${colMinActive.join(', ')}`);
    if (hideZeroActivity) activeFilters.push('Hide zero-activity rows');

    // Period — min/max of firstDate/lastDate across rows
    const dates = rows.flatMap((r) => [r.firstDate, r.lastDate]).filter(Boolean).sort();
    const periodFrom = dates[0] ? toDdMmYyyy(dates[0]) : '';
    const periodTo = dates[dates.length - 1] ? toDdMmYyyy(dates[dates.length - 1]) : '';

    // Per-party ledger-name helpers — these are the key addition: the LLM
    // reads "TDS 194C" from the ledger NAME and infers the section.
    const namesByBucket = (r: PartyRow, bucket: Bucket) =>
      r.counterLedgers.filter((c) => c.bucket === bucket).map((c) => c.ledger);

    // Flag helpers (reused across the brief)
    const flagsFor = (r: PartyRow): string[] => {
      const f: string[] = [];
      if (tdsTagged && r.totalExpenses > 0 && r.tdsDeducted < 1) f.push('Z-TDS');
      if (gstTagged && r.totalSales + r.totalExpenses > 0 && r.gstAmount < 1) f.push('Z-GST');
      if (Math.abs(r.balanceGap) > 1) f.push('BAL');
      const denom =
        Math.abs(r.totalSales) +
        Math.abs(r.totalPurchase) +
        Math.abs(r.totalExpenses) +
        Math.abs(r.others);
      if (denom > 0 && r.others / denom > 0.25) f.push('OTH');
      return f;
    };

    // Row activity score (used to rank top 100)
    const activity = (r: PartyRow) =>
      Math.abs(r.totalSales) +
      Math.abs(r.totalPurchase) +
      Math.abs(r.totalExpenses) +
      Math.abs(r.tdsDeducted) +
      Math.abs(r.gstAmount) +
      Math.abs(r.rcmAmount);

    // Top 100 by activity
    const topN = [...rows].sort((a, b) => activity(b) - activity(a)).slice(0, 100);

    // Anomalous rows (union of flags; excludes those already in top 100)
    const topSet = new Set(topN.map((r) => r.partyName));
    const anomalous = rows.filter((r) => !topSet.has(r.partyName) && flagsFor(r).length > 0);

    const partyCsvHeader = [
      'Party',
      'Sales',
      'Purchase',
      'Expenses',
      'TDS',
      'TDS % Exp',
      'GST',
      'GST % S+E',
      'RCM',
      'Bank',
      'Others',
      'Net Balance',
      'Vouchers',
      'First Date',
      'Last Date',
      'TDS Ledgers Hit',
      'GST Ledgers Hit',
      'RCM Ledgers Hit',
      'Top Counter-Ledgers',
      'Flags',
    ];

    const topCounterLabel = (r: PartyRow) => {
      const top = r.counterLedgers
        .filter(
          (c) =>
            c.bucket === 'expense' ||
            c.bucket === 'purchase' ||
            c.bucket === 'sales' ||
            c.bucket === 'others',
        )
        .slice(0, 3)
        .map((c) => `${c.ledger}: ${enInt(c.amount)}`);
      return top.join(' | ');
    };

    const partyCsvRow = (r: PartyRow): string =>
      [
        r.partyName,
        enInt(r.totalSales),
        enInt(r.totalPurchase),
        enInt(r.totalExpenses),
        enInt(r.tdsDeducted),
        pct1(r.tdsExpensePct),
        enInt(r.gstAmount),
        pct1(r.gstSalesExpensePct),
        enInt(r.rcmAmount),
        enInt(r.bankAmount),
        enInt(r.others),
        enInt(r.netBalance),
        r.voucherCount,
        r.firstDate ? toDdMmYyyy(r.firstDate) : '',
        r.lastDate ? toDdMmYyyy(r.lastDate) : '',
        namesByBucket(r, 'tds').join(', '),
        namesByBucket(r, 'gst').join(', '),
        namesByBucket(r, 'rcm').join(', '),
        topCounterLabel(r),
        flagsFor(r).join(';'),
      ]
        .map(csv)
        .join(',');

    // Counter-ledger detail (top 5 non-tax-non-bank per party, amount ≥ 1000)
    const detailHeader = ['Party', 'Counter Ledger', 'Bucket', 'Amount', 'Vouchers'];
    const detailLines: string[] = [];
    topN.forEach((r) => {
      const top5 = r.counterLedgers
        .filter(
          (c) =>
            (c.bucket === 'expense' ||
              c.bucket === 'purchase' ||
              c.bucket === 'sales' ||
              c.bucket === 'others') &&
            Math.abs(c.amount) >= 1000,
        )
        .slice(0, 5);
      top5.forEach((c) => {
        detailLines.push(
          [r.partyName, c.ledger, c.bucket, enInt(c.amount), c.voucherCount]
            .map(csv)
            .join(','),
        );
      });
    });

    // ── Compose markdown ──
    const lines: string[] = [];
    lines.push('# Party Ledger Matrix — LLM Audit Brief');
    lines.push('');
    lines.push('## Context');
    lines.push(`- Entity primary group: **${effectivePrimary || '(not selected)'}**`);
    if (periodFrom && periodTo) lines.push(`- Period covered: ${periodFrom} → ${periodTo}`);
    lines.push(
      `- Parties in scope: **${rows.length.toLocaleString('en-IN')}** (universe: ${analysis.partyUniverseCount.toLocaleString('en-IN')})`,
    );
    lines.push(`- Top-activity parties included: ${topN.length}`);
    lines.push(`- Anomalous parties included (outside top set): ${anomalous.length}`);
    lines.push(
      `- Active filters: ${activeFilters.length ? activeFilters.join(' | ') : '(none)'}`,
    );
    lines.push(
      '- Amounts are in **Indian Rupees**, shown as full integers (no decimals, no Cr/L abbreviations).',
    );
    lines.push(
      '- Sign convention: **Credit positive (+)**, **Debit negative (−)**. Net Balance is the closing balance from Tally master (credit-positive for creditors, debit-positive for debtors).',
    );
    lines.push(
      '- Apportionment: within each voucher, counter-ledger amounts are split across parties by the party\'s share of absolute flow.',
    );
    lines.push('');
    lines.push('## Ledger tags used in this run');
    lines.push(
      `- **TDS ledgers tagged (${tdsLedgers.length})**: ${tdsLedgers.length ? tdsLedgers.map((x) => `\`${x}\``).join(', ') : '_(none — TDS-related flags disabled)_'}`,
    );
    lines.push(
      `- **GST ledgers tagged (${gstLedgers.length})**: ${gstLedgers.length ? gstLedgers.map((x) => `\`${x}\``).join(', ') : '_(none — GST-related flags disabled)_'}`,
    );
    lines.push(
      `- **RCM ledgers tagged (${rcmLedgers.length})**: ${rcmLedgers.length ? rcmLedgers.map((x) => `\`${x}\``).join(', ') : '_(none)_'}`,
    );
    lines.push('');
    lines.push('## How to read each row');
    lines.push('- `Sales` / `Purchase` / `Expenses`: total amount routed through this party\'s vouchers to counter-ledgers of that bucket (apportioned).');
    lines.push('- `TDS` / `GST` / `RCM`: apportioned tax-ledger totals on this party.');
    lines.push('- `TDS % Exp` = TDS ÷ Expenses × 100. `GST % S+E` = GST ÷ (Sales + Expenses) × 100.');
    lines.push('- `TDS Ledgers Hit`: the **specific TDS ledger names** hit by this party. Tally names commonly encode the section — e.g. `TDS 194C — Contractors` → Section **194C**, `TDS 194J` → **194J**, `TDS 194I` → **194I**, etc. Use these to confirm / challenge applicability.');
    lines.push('- `GST Ledgers Hit`: specific GST ledger names — e.g. `CGST Input 18%`, `IGST Output 5%` — often encode the **rate**. Use to infer rate applied.');
    lines.push('- `RCM Ledgers Hit`: specific RCM ledger names.');
    lines.push('- `Top Counter-Ledgers`: top 3 non-tax non-bank ledgers hit, each with apportioned amount.');
    lines.push('- `Flags`: `Z-TDS` (expense booked but zero TDS), `Z-GST` (taxable activity but zero GST), `BAL` (closing disagrees with movement), `OTH` (>25% activity in untagged "Others" — tag precision issue).');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Audit request — please produce');
    lines.push('');
    lines.push('You are acting as an Indian **Chartered Accountant / tax auditor**. Review the party-level matrix below and produce a prioritised audit punchlist. Reason from the **ledger names** (TDS / GST / RCM) in each row — they carry the section / rate signal. Keep the response concise but specific: name the party, cite the evidence in the row, and quantify the exposure in ₹.');
    lines.push('');
    lines.push('### 1. TDS (Sections 194C / 194J / 194H / 194I / 194A / 194Q / 194M / 194O, etc.)');
    lines.push('- For every party with `Z-TDS` flag: infer the **most likely applicable section** from the `Top Counter-Ledgers` column (Rent → 194I, Contractor/Job Work → 194C, Professional / Technical → 194J, Commission / Brokerage → 194H, Interest → 194A, Goods > ₹50L → 194Q, E-commerce → 194O).');
    lines.push('- For parties with non-zero TDS: cross-check `TDS Ledgers Hit` against the nature of expense. Flag **section mismatch** (e.g. contractor expense but only 194J ledger hit).');
    lines.push('- Flag **under-deduction**: TDS < expected rate × applicable expense (2% for 194C, 10% for 194J/I, etc.). Note if the party may have given a lower-deduction certificate.');
    lines.push('- Call out parties near the **annual threshold** (₹1,00,000 for 194C aggregate, ₹30,000 per payment, etc.) where YTD expense is close enough that a future booking will trigger applicability.');
    lines.push('');
    lines.push('### 2. GST');
    lines.push('- Use `GST Ledgers Hit` to infer the rate applied (names usually contain 5, 12, 18, 28).');
    lines.push('- For sales: flag parties with sales but **no output GST** (Z-GST on sales). List as potential missed output liability unless the supply is genuinely exempt (exports, NIL-rated).');
    lines.push('- For expenses / purchases: flag parties with spend but **no input GST captured** — could be missed ITC, exempt supply, or unregistered vendor (then RCM).');
    lines.push('- Flag **unusual rate combinations** — e.g. CGST but no SGST (interstate with wrong tax), or 28% on a non-luxury ledger.');
    lines.push('');
    lines.push('### 3. RCM (Reverse Charge)');
    lines.push('- Identify parties where RCM likely applies but `RCM Ledgers Hit` is blank. Canonical RCM triggers:');
    lines.push('  - GTA (Goods Transport Agency) — "transport", "freight", "GTA" in name');
    lines.push('  - Advocate / legal services (individual lawyer or firm)');
    lines.push('  - Director sitting fees / remuneration (non-employee)');
    lines.push('  - Import of services (foreign vendor)');
    lines.push('  - Rent from unregistered landlord');
    lines.push('  - Security services from non-corporate provider');
    lines.push('- Cross-check party name and counter-ledger name; if either signals an RCM trigger but `RCM` column is 0, flag it.');
    lines.push('');
    lines.push('### Output format requested');
    lines.push('- A **prioritised punchlist** (high / medium / low risk).');
    lines.push('- Columns: Party | Issue | Evidence | Estimated ₹ exposure | Recommended action.');
    lines.push('- Group by TDS / GST / RCM.');
    lines.push('- End with a one-paragraph overall assessment.');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`## Table A — Top ${topN.length} parties by activity`);
    lines.push('');
    lines.push('```csv');
    lines.push(partyCsvHeader.join(','));
    topN.forEach((r) => lines.push(partyCsvRow(r)));
    lines.push('```');
    lines.push('');
    if (anomalous.length > 0) {
      lines.push(`## Table B — Additional anomalous parties (outside top ${topN.length})`);
      lines.push('');
      lines.push('```csv');
      lines.push(partyCsvHeader.join(','));
      anomalous.forEach((r) => lines.push(partyCsvRow(r)));
      lines.push('```');
      lines.push('');
    }
    if (detailLines.length > 0) {
      lines.push('## Table C — Counter-ledger detail (top 5 per top-activity party, amount ≥ ₹1,000)');
      lines.push('');
      lines.push('```csv');
      lines.push(detailHeader.join(','));
      detailLines.forEach((l) => lines.push(l));
      lines.push('```');
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push(
      `_Generated from FinAnalyzer · ${toDdMmYyyy(new Date().toISOString())} · Primary group: ${effectivePrimary || '—'} · ${rows.length} parties in view._`,
    );
    return lines.join('\n');
  };

  const copyLLMMarkdown = async () => {
    if (copyingMd !== 'idle') return;
    setCopyingMd('copying');
    try {
      const md = buildLLMMarkdown();
      await navigator.clipboard.writeText(md);
      setCopyingMd('copied');
      setMsg('LLM markdown copied to clipboard — paste into ChatGPT / Claude / Gemini.');
      setTimeout(() => {
        setCopyingMd('idle');
        setMsg('');
      }, 2400);
    } catch (err) {
      console.error(err);
      setCopyingMd('idle');
      window.alert('Copy failed. Your browser may block clipboard access — try the Download button instead.');
    }
  };

  const downloadLLMMarkdown = () => {
    try {
      const md = buildLLMMarkdown();
      const stamp = toDdMmYyyy(new Date().toISOString()).replace(/\//g, '-');
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Party_Matrix_LLM_Brief_${stamp}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMsg('LLM markdown downloaded.');
      setTimeout(() => setMsg(''), 1800);
    } catch (err) {
      console.error(err);
      window.alert('Download failed. Please retry.');
    }
  };

  // ── Drill-down toggle ──────────────────────────────────────────────────────
  const toggleExpanded = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // ── Anomaly highlighting helpers for table ─────────────────────────────────
  // Cell-level anomaly shading — gated on the corresponding tag class being
  // populated, otherwise the entire table lights up red on first load.
  const isZeroTdsCell = (r: PartyRow) => tdsTagged && r.totalExpenses > 0 && r.tdsDeducted < 1;
  const isZeroGstCell = (r: PartyRow) =>
    gstTagged && (r.totalSales + r.totalExpenses) > 0 && r.gstAmount < 1;
  const hasBalanceGap = (r: PartyRow) => Math.abs(r.balanceGap) > 1;

  // Helper: comma-separated counter-ledger list (used for Excel export +
  // tooltip on the chip row in the table).
  const counterHitsLine = (r: PartyRow, limit = 6) => {
    const relevant = r.counterLedgers.filter(
      (c) => c.bucket === 'expense' || c.bucket === 'purchase' || c.bucket === 'sales' || c.bucket === 'others',
    );
    if (relevant.length === 0) return '';
    const shown = relevant.slice(0, limit).map((c) => c.ledger);
    const extra = relevant.length - shown.length;
    return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
  };

  // Helper: compact counter-ledger chip list for the table column.
  // Returns the top-N non-tax non-bank ledgers as small coloured tags.
  const counterHitsChips = (r: PartyRow, limit = 3): CounterLedgerStat[] =>
    r.counterLedgers
      .filter(
        (c) =>
          c.bucket === 'expense' ||
          c.bucket === 'purchase' ||
          c.bucket === 'sales' ||
          c.bucket === 'others',
      )
      .slice(0, limit);

  // Density-driven paddings. Memoised strings keep Tailwind JIT happy.
  const rowPadY = density === 'compact' ? 'py-1.5' : 'py-3';
  const hdrPadY = density === 'compact' ? 'py-2' : 'py-3';
  const expandPadY = density === 'compact' ? 'py-2' : 'py-3';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Module</p>
            <h3 className="text-xl font-black text-slate-900">Party Ledger Matrix</h3>
            <p className="text-sm text-slate-500 mt-1">
              Net Balance shown as <span className="font-semibold">Credit positive (+)</span> and{' '}
              <span className="font-semibold">Debit negative (-)</span>.
              {computing && (
                <span className="ml-3 inline-flex items-center gap-1 text-indigo-600 font-semibold">
                  <Loader2 size={12} className="animate-spin" /> Computing…
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportProfile}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 text-sm font-bold"
            >
              <FileJson size={14} /> Export Profile
            </button>
            <button
              onClick={() => profileFileRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-bold"
            >
              <Upload size={14} /> Import Profile
            </button>
            <button
              onClick={exportExcel}
              // Block the export when there is nothing to export. Without this
              // guard the user could click before the worker has produced any
              // analysis rows (no primary group selected, or import not yet
              // run) and end up looking at a generic "export failed" message.
              disabled={exporting || analysis.rows.length === 0 || filteredRows.length === 0}
              title={
                analysis.rows.length === 0
                  ? 'Select a Tally Primary Group and load data before exporting.'
                  : filteredRows.length === 0
                    ? 'Current filters yield zero rows. Clear filters to enable export.'
                    : 'Export the multi-sheet styled Excel workbook.'
              }
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}{' '}
              {exporting ? 'Exporting…' : 'Export Beautiful Excel'}
            </button>
            <button
              onClick={copyLLMMarkdown}
              disabled={copyingMd !== 'idle' || filteredRows.length === 0}
              title="Copy a self-contained markdown brief (header + audit prompt + CSV tables) to paste into ChatGPT / Claude / Gemini for TDS / GST / RCM review."
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-60"
            >
              <ClipboardCopy size={15} />
              {copyingMd === 'copied' ? 'Copied ✓' : copyingMd === 'copying' ? 'Copying…' : 'Copy LLM Markdown'}
            </button>
            <button
              onClick={downloadLLMMarkdown}
              disabled={filteredRows.length === 0}
              title="Download the same markdown brief as a .md file."
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-indigo-300 bg-white text-indigo-700 text-sm font-bold hover:bg-indigo-50 disabled:opacity-60"
            >
              <FileText size={15} /> Download .md
            </button>
            <input
              ref={profileFileRef}
              type="file"
              className="hidden"
              accept=".json"
              onChange={importProfile}
            />
          </div>
        </div>

        {msg && (
          <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-semibold">
            {msg}
          </div>
        )}
        {needsSelection && (
          <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            Select TDS, GST and RCM ledgers for accurate classification.
          </div>
        )}

        {/* KPI STRIP */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          <Kpi label="Group Parties" value={kpis.partyUniverse} />
          <Kpi label="Active" value={kpis.activeParties} />
          <Kpi label="In View" value={kpis.filtered} />
          <Kpi
            label={tdsTagged ? 'Zero TDS' : 'Zero TDS (tag TDS)'}
            value={kpis.zeroTds === null ? '—' : kpis.zeroTds}
            tone={kpis.zeroTds && kpis.zeroTds > 0 ? 'danger' : 'ok'}
          />
          <Kpi
            label={gstTagged ? 'Zero GST' : 'Zero GST (tag GST)'}
            value={kpis.zeroGst === null ? '—' : kpis.zeroGst}
            tone={kpis.zeroGst && kpis.zeroGst > 0 ? 'warn' : 'ok'}
          />
          <Kpi label="Balance Gaps" value={kpis.balanceGaps} tone={kpis.balanceGaps > 0 ? 'warn' : 'ok'} />
          <Kpi label="Unbalanced Vchs" value={kpis.unbalanced} tone={kpis.unbalanced > 0 ? 'warn' : 'ok'} />
        </div>

        {/* PRIMARY GROUP + SEARCH (always visible) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Select Tally Primary Group
            </label>
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-slate-400" />
              <select
                value={effectivePrimary}
                onChange={(e) => setSelectedPrimary(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                {primaries.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Search Party / Counter-Ledger
            </label>
            <div className="relative">
              <Search size={13} className="absolute left-2 top-2.5 text-slate-400" />
              <input
                value={partyQ}
                onChange={(e) => setPartyQ(e.target.value)}
                placeholder="e.g. Acme, Printing, Professional Fees"
                className="w-full pl-7 pr-2 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Anomaly Filter
            </label>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  { k: 'all', label: 'All', disabled: false },
                  { k: 'zero_tds', label: 'Zero TDS', disabled: !tdsTagged },
                  { k: 'zero_gst', label: 'Zero GST', disabled: !gstTagged },
                  { k: 'balance_gap', label: 'Balance Gap', disabled: false },
                  { k: 'high_others', label: 'High Others', disabled: false },
                ] as { k: AnomalyFilter; label: string; disabled: boolean }[]
              ).map((x) => (
                <button
                  key={x.k}
                  onClick={() => !x.disabled && setAnomaly(x.k)}
                  disabled={x.disabled}
                  title={x.disabled ? 'Tag ledgers first to enable this filter' : undefined}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                    anomaly === x.k
                      ? 'bg-slate-900 text-white border-slate-900'
                      : x.disabled
                      ? 'bg-slate-50 text-slate-300 border-slate-200 cursor-not-allowed'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {x.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* SECONDARY CONTROL ROW */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-slate-300"
                checked={hideZeroActivity}
                onChange={(e) => setHideZeroActivity(e.target.checked)}
              />
              Hide dormant parties
            </label>
            {/* Number-format toggle */}
            <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button
                onClick={() => setNumberMode('compact')}
                className={`px-2 py-1 text-[10px] font-bold rounded ${
                  numberMode === 'compact' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
                title="Show amounts as 10.01 Cr / 12.50 L"
              >
                Cr / L
              </button>
              <button
                onClick={() => setNumberMode('full')}
                className={`px-2 py-1 text-[10px] font-bold rounded ${
                  numberMode === 'full' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
                title="Show full Indian-format amounts"
              >
                Full
              </button>
            </div>
            {/* Density toggle */}
            <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button
                onClick={() => setDensity('comfortable')}
                className={`px-2 py-1 text-[10px] font-bold rounded ${
                  density === 'comfortable' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                Roomy
              </button>
              <button
                onClick={() => setDensity('compact')}
                className={`px-2 py-1 text-[10px] font-bold rounded ${
                  density === 'compact' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                Dense
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] text-slate-500">
              Showing <span className="font-bold text-slate-700">{filteredRows.length.toLocaleString('en-IN')}</span> of{' '}
              <span className="font-bold text-slate-700">{analysis.partyUniverseCount.toLocaleString('en-IN')}</span> parties
              {hideZeroActivity && kpis.activeParties < analysis.partyUniverseCount
                ? ` · ${(analysis.partyUniverseCount - kpis.activeParties).toLocaleString('en-IN')} dormant hidden`
                : ''}
            </p>
            {anyColFilterActive && (
              <button
                onClick={clearColFilters}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100"
                title="Clear all per-column filters"
              >
                <X size={10} /> Clear column filters ({Object.keys(colMin).length + (counterBuckets.size > 0 ? 1 : 0)})
              </button>
            )}
          </div>
        </div>

        {/* TAG PANEL — collapsed chip summary by default */}
        <div className="rounded-xl border border-slate-200">
          <button
            onClick={() => setTagPanelOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100 rounded-t-xl"
          >
            <div className="flex items-center gap-2 text-sm font-bold text-slate-700 flex-wrap">
              <Settings2 size={14} /> Tag Ledgers
              <span className="ml-2 inline-flex gap-1">
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    tdsLedgers.length > 0 ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  TDS {tdsLedgers.length}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    gstLedgers.length > 0 ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  GST {gstLedgers.length}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    rcmLedgers.length > 0 ? 'bg-fuchsia-100 text-fuchsia-700' : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  RCM {rcmLedgers.length}
                </span>
              </span>
              {tdsLedgers.length === 0 && gstLedgers.length === 0 && rcmLedgers.length === 0 && (
                <span className="ml-2 text-[11px] font-normal text-amber-700">
                  ← click to tag your TDS / GST / RCM ledgers
                </span>
              )}
            </div>
            {tagPanelOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {tagPanelOpen && (
            <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
              <Selector
                title="TDS Ledgers"
                accentText="text-rose-700"
                accentBg="bg-rose-100"
                ledgers={allLedgers}
                selected={tdsLedgers}
                onChange={setTdsLedgers}
                suggestions={suggestedTds}
              />
              <Selector
                title="GST Ledgers"
                accentText="text-sky-700"
                accentBg="bg-sky-100"
                ledgers={allLedgers}
                selected={gstLedgers}
                onChange={setGstLedgers}
                suggestions={suggestedGst}
              />
              <Selector
                title="RCM Ledgers"
                accentText="text-fuchsia-700"
                accentBg="bg-fuchsia-100"
                ledgers={allLedgers}
                selected={rcmLedgers}
                onChange={setRcmLedgers}
                suggestions={suggestedRcm}
              />
            </div>
          )}
        </div>
      </div>

      {/* TABLE */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-auto max-h-[72vh] relative">
        <table
          className="text-sm border-separate border-spacing-0"
          style={{ minWidth: 1680, fontVariantNumeric: 'tabular-nums' }}
        >
          <colgroup>
            <col style={{ width: 280 }} />{/* Party / Ledger          */}
            <col style={{ width: 230 }} />{/* Counter-Ledger chips    */}
            <col style={{ width: 130 }} />{/* Sales                   */}
            <col style={{ width: 130 }} />{/* Purchase                */}
            <col style={{ width: 130 }} />{/* Expenses                */}
            <col style={{ width: 115 }} />{/* TDS                     */}
            <col style={{ width: 85 }}  />{/* TDS %                   */}
            <col style={{ width: 115 }} />{/* GST                     */}
            <col style={{ width: 85 }}  />{/* GST %                   */}
            <col style={{ width: 110 }} />{/* RCM                     */}
            <col style={{ width: 115 }} />{/* Bank                    */}
            <col style={{ width: 115 }} />{/* Others                  */}
            <col style={{ width: 145 }} />{/* Net                     */}
          </colgroup>
          <thead className="bg-slate-100 text-slate-600 text-[11px] font-bold uppercase tracking-wider sticky top-0 z-20">
            <tr>
              <th
                onClick={() => setSort('partyName')}
                className={`px-4 ${hdrPadY} text-left cursor-pointer bg-slate-100 sticky left-0 z-30 border-b border-slate-200`}
              >
                <span className="inline-flex items-center gap-1 whitespace-nowrap">Party / Ledger <SortIcon k="partyName" /></span>
              </th>
              <th className={`px-3 ${hdrPadY} text-left border-b border-slate-200 bg-slate-100 whitespace-nowrap`}>
                Counter-Ledger Hits
              </th>
              {(
                [
                  ['totalSales', 'Sales'],
                  ['totalPurchase', 'Purchase'],
                  ['totalExpenses', 'Expenses'],
                  ['tdsDeducted', 'TDS'],
                  ['tdsExpensePct', 'TDS %'],
                  ['gstAmount', 'GST'],
                  ['gstSalesExpensePct', 'GST %'],
                  ['rcmAmount', 'RCM'],
                  ['bankAmount', 'Bank'],
                  ['others', 'Others'],
                  ['netBalance', 'Net (+Cr / −Dr)'],
                ] as [SortKey, string][]
              ).map(([k, label]) => (
                <th
                  key={k}
                  onClick={() => setSort(k)}
                  className={`px-3 ${hdrPadY} text-right cursor-pointer select-none border-b border-slate-200 bg-slate-100 whitespace-nowrap`}
                >
                  <span className="inline-flex items-center gap-1 justify-end">
                    {label} <SortIcon k={k} />
                  </span>
                </th>
              ))}
            </tr>
            {/* Filter row — sticky right under the sort header. Each cell
                carries its own control: text search for party, bucket-chip
                toggles for counter-ledger, ≥-threshold for amount columns,
                ≥-threshold for percentages. */}
            <tr className="bg-white sticky top-[38px] z-20">
              <th className={`px-3 py-1.5 bg-white border-b border-slate-200 sticky left-0 z-30`}>
                <div className="relative">
                  <Search size={11} className="absolute left-2 top-1.5 text-slate-400 pointer-events-none" />
                  <input
                    value={partyQ}
                    onChange={(e) => setPartyQ(e.target.value)}
                    placeholder="Search party / ledger"
                    className="w-full pl-6 pr-6 py-1 text-[11px] border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                  {partyQ && (
                    <button
                      onClick={() => setPartyQ('')}
                      className="absolute right-1 top-1 p-0.5 text-slate-400 hover:text-slate-700"
                      aria-label="Clear party search"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              </th>
              <th className="px-3 py-1.5 bg-white border-b border-slate-200 text-left">
                <div className="flex items-center gap-1">
                  {(['sales', 'purchase', 'expense', 'others'] as Bucket[]).map((b) => {
                    const s = BUCKET_STYLES[b];
                    const on = counterBuckets.has(b);
                    return (
                      <button
                        key={b}
                        onClick={() => toggleCounterBucket(b)}
                        title={`Only parties with ${s.label} counter-ledgers`}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-shadow ${
                          on
                            ? `${s.bg} ${s.text} ${s.bg.replace('bg-', 'border-')} shadow-sm ring-1 ring-inset ring-indigo-300`
                            : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {s.label.slice(0, 1)}
                      </button>
                    );
                  })}
                </div>
              </th>
              {(
                [
                  'totalSales',
                  'totalPurchase',
                  'totalExpenses',
                  'tdsDeducted',
                  'tdsExpensePct',
                  'gstAmount',
                  'gstSalesExpensePct',
                  'rcmAmount',
                  'bankAmount',
                  'others',
                  'netBalance',
                ] as string[]
              ).map((k) => {
                const isPct = k === 'tdsExpensePct' || k === 'gstSalesExpensePct';
                return (
                  <th key={k} className="px-2 py-1.5 bg-white border-b border-slate-200">
                    <input
                      type="number"
                      min={0}
                      step={isPct ? 0.5 : 1000}
                      value={colMin[k] ?? ''}
                      onChange={(e) => setColMinValue(k, Number(e.target.value) || 0)}
                      placeholder={isPct ? '≥ %' : '≥ min'}
                      className="w-full px-1.5 py-1 text-[11px] text-right tabular-nums border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      title={
                        isPct
                          ? 'Show rows where this percentage is ≥ value'
                          : 'Show rows where |value| is ≥ this amount (raw rupees)'
                      }
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((r, idx) => {
              const isOpen = expanded.has(r.partyName);
              const stripe = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60';
              const chips = counterHitsChips(r, 3);
              const chipsExtra = r.counterLedgers.filter(
                (c) =>
                  c.bucket === 'expense' ||
                  c.bucket === 'purchase' ||
                  c.bucket === 'sales' ||
                  c.bucket === 'others',
              ).length - chips.length;
              const hitsTooltip = counterHitsLine(r, 20);
              const numCls = `px-3 ${rowPadY} text-right border-b border-slate-100`;
              return (
                <React.Fragment key={r.partyName}>
                  <tr
                    onClick={() => toggleExpanded(r.partyName)}
                    className={`group cursor-pointer hover:bg-indigo-50/40 transition-colors ${stripe} ${
                      isOpen ? 'ring-1 ring-inset ring-indigo-200' : ''
                    }`}
                    style={{ contentVisibility: 'auto', containIntrinsicSize: '44px' } as any}
                    title="Click row to toggle counter-ledger breakdown"
                  >
                    <td
                      className={`px-4 ${rowPadY} font-semibold text-slate-800 sticky left-0 z-10 ${stripe} border-b border-slate-100 ${
                        isOpen ? 'border-l-2 border-l-indigo-500' : 'border-l-2 border-l-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="truncate group-hover:text-indigo-700"
                          title={r.partyName}
                        >
                          {r.partyName}
                        </span>
                        {r.voucherCount > 0 && (
                          <span className="shrink-0 text-[10px] text-slate-400 font-medium tabular-nums">
                            {r.voucherCount.toLocaleString('en-IN')} vch
                          </span>
                        )}
                      </div>
                      {/* Master attributes strip from mst_ledger — hidden in
                          compact density to keep table height tight. */}
                      {(() => {
                        const meta = partyMasterByName.get(r.partyName.trim().toLowerCase());
                        if (!meta || density === 'compact') return null;
                        const bits: React.ReactNode[] = [];
                        if (meta.gstin)
                          bits.push(<span key="g" className="font-mono">GSTIN {meta.gstin}</span>);
                        if (meta.pan)
                          bits.push(<span key="p" className="font-mono">PAN {meta.pan}</span>);
                        if (meta.state)
                          bits.push(<span key="s">{meta.state}</span>);
                        if (meta.gstRegType)
                          bits.push(<span key="rt" className="italic">{meta.gstRegType}</span>);
                        if (bits.length === 0) return null;
                        return (
                          <div className="text-[10px] text-slate-500 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 truncate"
                               title={[meta.gstin, meta.pan, meta.state, meta.gstRegType, meta.mobile, meta.email].filter(Boolean).join(' · ')}>
                            {bits.flatMap((b, i) => i === 0 ? [b] : [<span key={`sep-${i}`} className="text-slate-300">·</span>, b])}
                          </div>
                        );
                      })()}
                    </td>
                    <td
                      className={`px-3 ${rowPadY} border-b border-slate-100 overflow-hidden`}
                      title={hitsTooltip || undefined}
                    >
                      {chips.length === 0 ? (
                        <span className="text-[11px] italic text-slate-300">—</span>
                      ) : (
                        <div className="flex items-center gap-1 overflow-hidden">
                          {chips.map((c: CounterLedgerStat) => {
                            const s = BUCKET_STYLES[c.bucket];
                            return (
                              <span
                                key={c.ledger}
                                className={`inline-flex items-center max-w-[110px] px-1.5 py-0.5 rounded-md border text-[10.5px] ${s.bg} ${s.text}`}
                              >
                                <span className="truncate font-semibold">{c.ledger}</span>
                              </span>
                            );
                          })}
                          {chipsExtra > 0 && (
                            <span className="shrink-0 text-[10.5px] text-slate-500 font-medium">
                              +{chipsExtra}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className={numCls}>{num(r.totalSales)}</td>
                    <td className={numCls}>{num(r.totalPurchase)}</td>
                    <td className={numCls}>{num(r.totalExpenses)}</td>
                    <td className={numCls}>{num(r.tdsDeducted)}</td>
                    <td
                      className={`${numCls} tabular-nums ${isZeroTdsCell(r) ? 'bg-rose-50 text-rose-700 font-bold' : ''}`}
                    >
                      {pct(r.tdsExpensePct)}
                    </td>
                    <td className={numCls}>{num(r.gstAmount)}</td>
                    <td
                      className={`${numCls} tabular-nums ${isZeroGstCell(r) ? 'bg-amber-50 text-amber-700 font-bold' : ''}`}
                    >
                      {pct(r.gstSalesExpensePct)}
                    </td>
                    <td className={numCls}>{num(r.rcmAmount)}</td>
                    <td className={numCls}>{num(r.bankAmount)}</td>
                    <td className={numCls}>{num(r.others)}</td>
                    <td
                      className={`${numCls} font-bold ${
                        hasBalanceGap(r) ? 'bg-orange-50 text-orange-700' : ''
                      }`}
                      title={fullSigned(r.netBalance)}
                    >
                      {num(r.netBalance, {
                        signed: true,
                        tone: hasBalanceGap(r) ? 'neutral' : r.netBalance >= 0 ? 'pos' : 'neg',
                      })}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50/50">
                      <td colSpan={13} className={`px-6 ${expandPadY} border-b border-slate-200`}>
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-2 items-center">
                            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                              Counter-Ledger Breakdown
                            </span>
                            <span className="text-[10px] text-slate-400">
                              Sorted by apportioned amount (top 30 shown)
                            </span>
                            {r.firstDate && (
                              <span className="text-[10px] text-slate-500">
                                · {toDdMmYyyy(r.firstDate)} → {toDdMmYyyy(r.lastDate)}
                              </span>
                            )}
                          </div>
                          {r.counterLedgers.length === 0 ? (
                            <p className="text-xs text-slate-400 italic">No counter-ledgers found.</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {r.counterLedgers.slice(0, 30).map((c: CounterLedgerStat) => {
                                const s = BUCKET_STYLES[c.bucket];
                                return (
                                  <span
                                    key={c.ledger}
                                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] ${s.bg} ${s.text}`}
                                    title={fullMoney(c.amount)}
                                  >
                                    <span className="font-bold uppercase tracking-wide text-[9px] opacity-80">
                                      {s.label}
                                    </span>
                                    <span className="font-semibold">{c.ledger}</span>
                                    <span className="font-mono tabular-nums">{fmt(c.amount)}</span>
                                    <span className="text-[9px] opacity-60">({c.voucherCount})</span>
                                  </span>
                                );
                              })}
                              {r.counterLedgers.length > 30 && (
                                <span className="text-[11px] text-slate-400 italic self-center">
                                  + {r.counterLedgers.length - 30} more (see Excel export)
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {filteredRows.length === 0 && !computing && (
              <tr>
                <td className="px-4 py-8 text-center text-slate-400" colSpan={13}>
                  No parties found for selected group/filter.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-slate-900 text-white text-sm font-bold sticky bottom-0">
            <tr>
              <td className={`px-4 ${rowPadY} sticky left-0 bg-slate-900 z-10`}>Totals</td>
              <td className={`px-3 ${rowPadY} text-left text-slate-300 font-normal text-[11px]`}>
                {filteredRows.length.toLocaleString('en-IN')} parties in view
              </td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.sales)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.purchase)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.expenses)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.tds)}</td>
              <td className={`px-3 ${rowPadY} text-right tabular-nums`}>{pct(totals.tdsExpensePct)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.gst)}</td>
              <td className={`px-3 ${rowPadY} text-right tabular-nums`}>{pct(totals.gstSalesExpensePct)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.rcm)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.bank)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.others)}</td>
              <td className={`px-3 ${rowPadY} text-right`}>{num(totals.net, { signed: true })}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {filteredRows.length > visibleRows.length && (
        <div className="flex items-center justify-center">
          <button
            onClick={() => setShowAll(true)}
            className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-bold hover:bg-slate-50"
          >
            Show all {filteredRows.length.toLocaleString('en-IN')} rows (currently showing {visibleRows.length.toLocaleString('en-IN')})
          </button>
        </div>
      )}

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-900 text-sm">
        <p className="font-bold mb-2">Summary / Observations</p>
        <p>
          Selected Tally Primary Group: <span className="font-semibold">{effectivePrimary || 'N/A'}</span>
        </p>
        <p>
          Vouchers with debit/credit imbalance:{' '}
          <span className="font-semibold">{analysis.unbalancedVoucherCount}</span>
        </p>
        <p>
          Parties where movement and net balance differ by more than 1.00:{' '}
          <span className="font-semibold">{kpis.balanceGaps}</span>
        </p>
        <p className="mt-2 text-[12px] text-amber-800">
          Tip: click any row to expand the counter-ledger breakdown. Use the anomaly chips above to
          narrow the view before exporting.
        </p>
      </div>
    </div>
  );
};

export default PartyLedgerMatrix;
