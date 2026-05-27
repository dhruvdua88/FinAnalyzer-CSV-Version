/**
 * Related Party (AS-18) Analysis — full rewrite.
 *
 * Mirrors the PartyLedgerMatrix architecture: a Web Worker computes the
 * heavy aggregation (transactions, the disclosure matrix, outstanding
 * balances by relationship category) off the main thread, the host
 * component renders the results, and a seven-sheet styled Excel export
 * produces a deliverable the auditor can attach directly to working
 * papers.
 *
 * Architecture decisions worth knowing about:
 *
 *   • Profile-driven. The user's relationship tags, per-ledger AS-18
 *     transaction-type overrides, materiality thresholds, and Section 188
 *     approval log all live in a `RelatedPartyProfile` that's persisted
 *     by the parent (App.tsx) via externalProfile/onProfileUpdate, and
 *     cached locally for resilience.
 *
 *   • Counter-ledger-driven classification. Voucher-type heuristics alone
 *     are too crude (a "Sales" voucher could be sale-of-goods, sale-of-
 *     services, even an inter-co recovery). The worker uses the largest
 *     non-party leg of each voucher as the signal for AS-18 transaction
 *     type, with a per-ledger user pin always winning over auto.
 *
 *   • The matrix is the deliverable. AS-18 paragraph 23 demands a
 *     transaction-type × relationship-category matrix as the principal
 *     disclosure; everything else (transaction detail, audit findings,
 *     materiality flags) hangs off that.
 *
 *   • Audit lens, not just a report. Year-end concentration, round-amount
 *     detection, journal-voucher flag, materiality threshold, and Section
 *     188 / Companies Act 2013 approval-tracking turn this from a
 *     compliance schedule into something the auditor can actually use to
 *     decide what to test.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  ClipboardCopy,
  Download,
  FileJson,
  FileText,
  Filter,
  Info,
  Loader2,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tag,
  Tags,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { LedgerEntry, RelatedPartyProfile, RPPartyTag } from '../../types';
import type {
  RPRelationshipCategory,
  RPTransactionType,
  RPPartyRow,
  RPTransactionDetail,
  RelatedPartyWorkerInput,
  RelatedPartyWorkerOutput,
} from '../../workers/relatedPartyWorker';
import {
  RELATIONSHIP_LABEL,
  RELATIONSHIP_ORDER,
  TX_TYPE_LABEL,
} from '../../workers/relatedPartyWorker';

interface Props {
  data: LedgerEntry[];
  externalProfile?: RelatedPartyProfile;
  onProfileUpdate?: (profile: RelatedPartyProfile) => void;
}

// ── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_THRESHOLDS = {
  materialityRupees: 1_000_000, // ₹10L single-txn flag
  yearEndDays: 30,
  roundAmountUnit: 100_000,     // ₹1L
  section188TurnoverPct: 10,
  annualTurnover: 0,            // 0 = disable Sec 188 SH-approval flag
};

const EMPTY_PROFILE: RelatedPartyProfile = {
  parties: {},
  ledgerTxType: {},
  thresholds: { ...DEFAULT_THRESHOLDS },
  approvals: {},
};

// Heuristic tokens we look for when pre-suggesting related parties from
// the master ledger list. Conservative: we only suggest, never auto-tag.
const RP_AUTO_KEYWORDS = [
  'director',
  'directors remuneration',
  'managerial remuneration',
  'kmp',
  'promoter',
  'subsidiary',
  'holding',
  'associate',
  'joint venture',
  'related party',
  'related parties',
  'partner',
  'proprietor',
];

// Relationship category visual styles (chip background, text color).
const REL_STYLES: Record<RPRelationshipCategory, { bg: string; text: string; chip: string }> = {
  'holding':                          { bg: 'bg-violet-50 border-violet-200', text: 'text-violet-700',   chip: 'bg-violet-600' },
  'subsidiary':                       { bg: 'bg-indigo-50 border-indigo-200', text: 'text-indigo-700',   chip: 'bg-indigo-600' },
  'fellow-subsidiary':                { bg: 'bg-blue-50 border-blue-200',     text: 'text-blue-700',     chip: 'bg-blue-600' },
  'associate-jv':                     { bg: 'bg-sky-50 border-sky-200',       text: 'text-sky-700',      chip: 'bg-sky-600' },
  'kmp':                              { bg: 'bg-rose-50 border-rose-200',     text: 'text-rose-700',     chip: 'bg-rose-600' },
  'kmp-relative':                     { bg: 'bg-pink-50 border-pink-200',     text: 'text-pink-700',     chip: 'bg-pink-600' },
  'kmp-enterprise':                   { bg: 'bg-fuchsia-50 border-fuchsia-200', text: 'text-fuchsia-700', chip: 'bg-fuchsia-600' },
  'individual-significant-influence': { bg: 'bg-amber-50 border-amber-200',   text: 'text-amber-700',    chip: 'bg-amber-600' },
  'other-rp':                         { bg: 'bg-slate-50 border-slate-200',   text: 'text-slate-700',    chip: 'bg-slate-600' },
};

// ── Utilities ───────────────────────────────────────────────────────────────
const inr = (n: number): string =>
  Math.round(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const inrSigned = (n: number): string => {
  const v = Math.round(Number(n) || 0);
  return v < 0 ? `(${Math.abs(v).toLocaleString('en-IN')})` : v.toLocaleString('en-IN');
};

const toDdMmYyyy = (iso: string): string => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
};

const sanitize = (xs: any): string[] =>
  Array.isArray(xs)
    ? Array.from(new Set(xs.map((s) => String(s || '').trim()).filter(Boolean)))
    : [];

// ── Multi-select party tagger (Step 1) ──────────────────────────────────────
//
// Built natively (not react-select) to keep the bundle small and to match
// PartyLedgerMatrix's tagger feel. Lets the user search the full ledger
// universe, auto-suggest from heuristics, bulk-add visible matches, and
// then assign each tagged party an AS-18 category + free-text notes.

interface TaggerProps {
  ledgers: string[];
  parties: Record<string, RPPartyTag>;
  onChange: (next: Record<string, RPPartyTag>) => void;
}

const PartyTagger: React.FC<TaggerProps> = ({ ledgers, parties, onChange }) => {
  const [query, setQuery] = useState('');
  const tagged = parties;
  const taggedNames = Object.keys(tagged);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ledgers.slice(0, 200); // cap for perf in initial render
    return ledgers.filter((l) => l.toLowerCase().includes(q)).slice(0, 200);
  }, [ledgers, query]);

  const toggle = (ledger: string) => {
    const next = { ...tagged };
    if (next[ledger]) delete next[ledger];
    else next[ledger] = { category: 'other-rp' };
    onChange(next);
  };

  const autoSuggest = () => {
    const next = { ...tagged };
    for (const l of ledgers) {
      const ll = l.toLowerCase();
      if (RP_AUTO_KEYWORDS.some((k) => ll.includes(k))) {
        if (!next[l]) next[l] = { category: 'other-rp' };
      }
    }
    onChange(next);
  };

  const updateOne = (name: string, patch: Partial<RPPartyTag>) => {
    const next = { ...tagged, [name]: { ...(tagged[name] || { category: 'other-rp' as const }), ...patch } };
    onChange(next);
  };

  const removeOne = (name: string) => {
    const next = { ...tagged };
    delete next[name];
    onChange(next);
  };

  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="bg-indigo-600 p-2.5 rounded-xl text-white shadow-md">
          <UserPlus size={20} />
        </div>
        <div className="flex-1 min-w-[260px]">
          <h3 className="text-lg font-black text-slate-800 tracking-tight">
            Tag related parties (AS-18 setup)
          </h3>
          <p className="text-xs text-slate-500">
            Identify each ledger as Holding / Subsidiary / KMP / Relative / etc. The disclosure
            schedule is built from these tags.
          </p>
        </div>
        <div className="text-sm font-bold text-slate-600">
          <span className="text-indigo-700">{taggedNames.length}</span> tagged
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-3 text-slate-400" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ledgers (typing 'director', 'kmp', 'holding'…)"
            className="w-full pl-9 pr-9 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-2.5 text-slate-400 hover:text-slate-600"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <button
          onClick={autoSuggest}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-50 text-indigo-700 text-sm font-bold border border-indigo-200 hover:bg-indigo-100"
        >
          <Sparkles size={14} /> Auto-suggest from keywords
        </button>
      </div>

      {/* Available ledger universe */}
      <div className="border border-slate-100 rounded-xl bg-slate-50/40 p-3 max-h-[260px] overflow-y-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {visible.map((l) => {
            const isTagged = !!tagged[l];
            return (
              <button
                key={l}
                onClick={() => toggle(l)}
                className={`text-left p-2.5 rounded-lg border-2 text-xs font-bold truncate transition-colors ${
                  isTagged
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-900'
                    : 'border-white bg-white text-slate-700 hover:border-slate-200'
                }`}
                title={l}
              >
                {isTagged && <CheckCircle2 size={11} className="inline-block mr-1 text-indigo-600" />}
                {l}
              </button>
            );
          })}
          {visible.length === 0 && (
            <div className="col-span-full text-center text-xs text-slate-400 py-6">
              No ledgers match. Try a different search term.
            </div>
          )}
        </div>
      </div>

      {/* Tagged-party assignment list */}
      {taggedNames.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-black text-slate-500 uppercase tracking-widest">
            <Tags size={12} /> Assign relationship category
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-[10px] uppercase tracking-widest text-slate-600 font-black">
                <tr>
                  <th className="px-3 py-2 text-left">Party</th>
                  <th className="px-3 py-2 text-left">AS-18 Category</th>
                  <th className="px-3 py-2 text-left">Notes (goes into the disclosure note)</th>
                  <th className="px-3 py-2 w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {taggedNames.sort().map((name) => {
                  const tag = tagged[name];
                  return (
                    <tr key={name} className="hover:bg-slate-50/50">
                      <td className="px-3 py-2 font-bold text-slate-800 truncate max-w-[260px]" title={name}>
                        {name}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={tag.category}
                          onChange={(e) =>
                            updateOne(name, {
                              category: e.target.value as RPRelationshipCategory,
                            })
                          }
                          className={`text-xs font-bold px-2 py-1 rounded-md border ${
                            REL_STYLES[tag.category].bg
                          } ${REL_STYLES[tag.category].text}`}
                        >
                          {RELATIONSHIP_ORDER.map((r) => (
                            <option key={r} value={r}>
                              {RELATIONSHIP_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={tag.notes || ''}
                          onChange={(e) => updateOne(name, { notes: e.target.value })}
                          placeholder='e.g., "Mrs. Priya Sharma — wife of Mr. Anil (Director)"'
                          className="w-full text-xs px-2 py-1 border border-slate-200 rounded-md focus:ring-1 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => removeOne(name)}
                          className="text-rose-500 hover:text-rose-700"
                          title="Remove tag"
                        >
                          <X size={14} />
                        </button>
                      </td>
                    </tr>
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

// ── Disclosure matrix ───────────────────────────────────────────────────────
//
// Renders the AS-18 paragraph 23 disclosure: rows = transaction types,
// columns = relationship categories that have at least one tagged party.

interface MatrixProps {
  matrix: RelatedPartyWorkerOutput['matrix'];
  outstanding: RelatedPartyWorkerOutput['outstandingMatrix'];
  totalVolume: number;
}

const DisclosureMatrix: React.FC<MatrixProps> = ({ matrix, outstanding, totalVolume }) => {
  // Only show columns that have any data.
  const activeCategories = useMemo(
    () => RELATIONSHIP_ORDER.filter((r) => matrix[r] && Object.keys(matrix[r]!).length > 0),
    [matrix]
  );

  // Only show rows that have any data.
  const activeTxTypes = useMemo(() => {
    const seen = new Set<RPTransactionType>();
    activeCategories.forEach((cat) => {
      Object.keys(matrix[cat]!).forEach((t) => seen.add(t as RPTransactionType));
    });
    const order: RPTransactionType[] = [
      'sale-goods', 'sale-services',
      'purchase-goods', 'purchase-services',
      'rendering-services', 'receiving-services',
      'agency-arrangements', 'leasing-hire-purchase',
      'rd-transfer', 'license-agreements',
      'finance-given', 'finance-received',
      'interest-paid', 'interest-received',
      'rent-paid', 'rent-received',
      'remuneration', 'reimbursement',
      'guarantees-given', 'guarantees-received',
      'management-contracts',
      'dividend-paid', 'dividend-received',
      'other',
    ];
    return order.filter((t) => seen.has(t));
  }, [matrix, activeCategories]);

  if (activeCategories.length === 0) {
    return (
      <div className="bg-white p-10 rounded-2xl border border-dashed border-slate-300 text-center">
        <FileText className="mx-auto text-slate-300" size={40} />
        <p className="mt-3 text-sm font-bold text-slate-500">
          Tag at least one related party above to generate the AS-18 disclosure.
        </p>
      </div>
    );
  }

  // Column totals
  const colTotals: Partial<Record<RPRelationshipCategory, number>> = {};
  activeCategories.forEach((cat) => {
    colTotals[cat] = activeTxTypes.reduce((s, t) => s + (matrix[cat]?.[t] || 0), 0);
  });

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-black tracking-tight text-slate-800 uppercase">
            AS-18 Disclosure Matrix (Para 23)
          </h3>
          <p className="text-xs text-slate-500">
            Transaction-type × relationship-category. Year-end balances summarised below.
          </p>
        </div>
        <div className="text-xs text-slate-500">
          Aggregate RP volume: <span className="font-mono font-black text-slate-800">₹{inr(totalVolume)}</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-900 text-white text-[10px] uppercase tracking-widest font-black">
              <th className="px-4 py-3 text-left sticky left-0 bg-slate-900 z-10">Nature of transaction</th>
              {activeCategories.map((cat) => (
                <th key={cat} className="px-4 py-3 text-right whitespace-nowrap min-w-[140px]">
                  {RELATIONSHIP_LABEL[cat]}
                </th>
              ))}
              <th className="px-4 py-3 text-right bg-slate-700">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {activeTxTypes.map((tx, idx) => {
              const rowTotal = activeCategories.reduce(
                (s, cat) => s + (matrix[cat]?.[tx] || 0),
                0
              );
              return (
                <tr key={tx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                  <td className="px-4 py-2.5 font-bold text-slate-700 sticky left-0 bg-inherit z-10">
                    {TX_TYPE_LABEL[tx]}
                  </td>
                  {activeCategories.map((cat) => {
                    const v = matrix[cat]?.[tx] || 0;
                    return (
                      <td
                        key={cat}
                        className={`px-4 py-2.5 text-right font-mono ${
                          v > 0 ? 'text-slate-800 font-bold' : 'text-slate-300'
                        }`}
                      >
                        {v > 0 ? inr(v) : '—'}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2.5 text-right font-mono font-black text-slate-900 bg-slate-100/80">
                    {rowTotal > 0 ? inr(rowTotal) : '—'}
                  </td>
                </tr>
              );
            })}
            {/* Totals row */}
            <tr className="bg-slate-900 text-white">
              <td className="px-4 py-3 font-black uppercase tracking-wider text-xs sticky left-0 bg-slate-900 z-10">
                Aggregate
              </td>
              {activeCategories.map((cat) => (
                <td key={cat} className="px-4 py-3 text-right font-mono font-black">
                  {inr(colTotals[cat] || 0)}
                </td>
              ))}
              <td className="px-4 py-3 text-right font-mono font-black bg-slate-700">
                {inr(totalVolume)}
              </td>
            </tr>
            {/* Outstanding row */}
            <tr className="bg-emerald-50 border-t-2 border-emerald-300">
              <td className="px-4 py-2.5 font-black text-emerald-900 sticky left-0 bg-emerald-50 z-10">
                Outstanding — receivable (Dr)
              </td>
              {activeCategories.map((cat) => (
                <td key={cat} className="px-4 py-2.5 text-right font-mono text-emerald-900 font-bold">
                  {outstanding[cat]?.receivable ? inr(outstanding[cat]!.receivable) : '—'}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right font-mono font-black text-emerald-900 bg-emerald-100">
                {inr(activeCategories.reduce((s, c) => s + (outstanding[c]?.receivable || 0), 0))}
              </td>
            </tr>
            <tr className="bg-rose-50">
              <td className="px-4 py-2.5 font-black text-rose-900 sticky left-0 bg-rose-50 z-10">
                Outstanding — payable (Cr)
              </td>
              {activeCategories.map((cat) => (
                <td key={cat} className="px-4 py-2.5 text-right font-mono text-rose-900 font-bold">
                  {outstanding[cat]?.payable ? inr(outstanding[cat]!.payable) : '—'}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right font-mono font-black text-rose-900 bg-rose-100">
                {inr(activeCategories.reduce((s, c) => s + (outstanding[c]?.payable || 0), 0))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

const RelatedPartyAnalysis: React.FC<Props> = ({ data, externalProfile, onProfileUpdate }) => {
  // ── Profile (parties, ledger overrides, thresholds, approvals) ───────────
  const [profile, setProfile] = useState<RelatedPartyProfile>(() => {
    if (externalProfile) {
      return {
        ...EMPTY_PROFILE,
        ...externalProfile,
        thresholds: { ...DEFAULT_THRESHOLDS, ...(externalProfile.thresholds || {}) },
      };
    }
    try {
      const cached = localStorage.getItem('related_party_profile');
      if (cached) {
        const parsed = JSON.parse(cached);
        return {
          ...EMPTY_PROFILE,
          ...parsed,
          thresholds: { ...DEFAULT_THRESHOLDS, ...(parsed.thresholds || {}) },
        };
      }
    } catch {
      // ignore
    }
    return { ...EMPTY_PROFILE };
  });

  // Persist profile to localStorage and bubble up to parent.
  useEffect(() => {
    try {
      localStorage.setItem('related_party_profile', JSON.stringify(profile));
    } catch {
      // quota exceeded etc.
    }
    onProfileUpdate?.(profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  // ── Derive transaction vs master rows from data ──────────────────────────
  const { txRows, mstRows } = useMemo(() => {
    const tx: LedgerEntry[] = [];
    const mst: LedgerEntry[] = [];
    for (const r of data) {
      if (Number(r?.is_master_ledger) === 1) mst.push(r);
      else tx.push(r);
    }
    return { txRows: tx, mstRows: mst };
  }, [data]);

  const allLedgers = useMemo(() => {
    const set = new Set<string>();
    for (const m of mstRows) {
      const n = String(m?.Ledger || m?.ledger || '').trim();
      if (n) set.add(n);
    }
    // Fall back to transaction ledgers if no master rows came through.
    if (set.size === 0) {
      for (const r of txRows) {
        const n = String(r?.Ledger || r?.ledger || '').trim();
        if (n) set.add(n);
      }
    }
    return Array.from(set).sort();
  }, [mstRows, txRows]);

  // ── Worker ───────────────────────────────────────────────────────────────
  const workerRef = useRef<Worker | null>(null);
  const [analysis, setAnalysis] = useState<RelatedPartyWorkerOutput>({
    parties: [],
    transactions: [],
    matrix: {},
    outstandingMatrix: {},
    totalRPTVolume: 0,
    totalRPTPartyCount: 0,
    partyUniverseCount: 0,
    unbalancedVoucherCount: 0,
  });
  const [computing, setComputing] = useState(false);

  useEffect(() => {
    const w = new Worker(new URL('../../workers/relatedPartyWorker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<RelatedPartyWorkerOutput>) => {
      setComputing(false);
      if (e.data.error) {
        console.error('[RelatedPartyAnalysis] worker error:', e.data.error);
        return;
      }
      setAnalysis(e.data);
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // Debounced re-compute when profile or data changes.
  useEffect(() => {
    if (!workerRef.current) return;
    if (Object.keys(profile.parties).length === 0) {
      setAnalysis({
        parties: [], transactions: [], matrix: {}, outstandingMatrix: {},
        totalRPTVolume: 0, totalRPTPartyCount: 0,
        partyUniverseCount: mstRows.length, unbalancedVoucherCount: 0,
      });
      return;
    }
    const handle = window.setTimeout(() => {
      setComputing(true);
      const payload: RelatedPartyWorkerInput = {
        txRows,
        mstRows,
        parties: profile.parties,
        ledgerTxType: profile.ledgerTxType,
        thresholds: profile.thresholds,
      };
      workerRef.current?.postMessage(payload);
    }, 220);
    return () => window.clearTimeout(handle);
  }, [txRows, mstRows, profile]);

  // ── View state ──────────────────────────────────────────────────────────
  const [step, setStep] = useState<'tag' | 'analyse'>(
    Object.keys(profile.parties).length === 0 ? 'tag' : 'analyse'
  );
  const [partyQ, setPartyQ] = useState('');
  const [relFilter, setRelFilter] = useState<'all' | RPRelationshipCategory>('all');
  const [findingsFilter, setFindingsFilter] = useState<
    'all' | 'year-end' | 'round' | 'high-value' | 'journal' | 'unbalanced'
  >('all');
  const [expandedParty, setExpandedParty] = useState<string | null>(null);
  const [view, setView] = useState<'matrix' | 'parties' | 'findings'>('matrix');
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState('');

  // ── Filtered party rows ─────────────────────────────────────────────────
  const filteredParties = useMemo(() => {
    return analysis.parties.filter((p) => {
      if (relFilter !== 'all' && p.category !== relFilter) return false;
      if (partyQ && !p.partyName.toLowerCase().includes(partyQ.toLowerCase())) return false;
      return true;
    });
  }, [analysis.parties, relFilter, partyQ]);

  // ── Findings list ───────────────────────────────────────────────────────
  const findings = useMemo(() => {
    const filterMatch = (t: RPTransactionDetail) => {
      switch (findingsFilter) {
        case 'year-end': return t.isYearEnd;
        case 'round': return t.isRoundAmount;
        case 'high-value': return t.isHighValue;
        case 'journal': return t.isJournalVoucher;
        case 'unbalanced': return false; // unbalanced is voucher-level, summarised separately
        default: return t.flagNotes.length > 0;
      }
    };
    return analysis.transactions.filter((t) => {
      if (!filterMatch(t)) return false;
      if (relFilter !== 'all') {
        const partyTag = profile.parties[t.partyName];
        if (!partyTag || partyTag.category !== relFilter) return false;
      }
      if (partyQ && !t.partyName.toLowerCase().includes(partyQ.toLowerCase())) return false;
      return true;
    });
  }, [analysis.transactions, findingsFilter, relFilter, partyQ, profile.parties]);

  // ── Profile import/export ───────────────────────────────────────────────
  const profileFileRef = useRef<HTMLInputElement | null>(null);

  const exportProfile = () => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Related_Party_Profile_${toDdMmYyyy(new Date().toISOString()).replace(/\//g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg('Profile exported.');
    setTimeout(() => setMsg(''), 1800);
  };

  const importProfile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result || '{}'));
        setProfile({
          ...EMPTY_PROFILE,
          ...p,
          thresholds: { ...DEFAULT_THRESHOLDS, ...(p.thresholds || {}) },
        });
        setMsg('Profile imported.');
        setTimeout(() => setMsg(''), 1800);
      } catch {
        window.alert('Invalid profile file.');
      }
    };
    reader.readAsText(file);
  };

  // ── Excel export ────────────────────────────────────────────────────────
  // Nine-sheet workbook:
  //   1. AS-18 Disclosure Note      — relationship × tx-type matrix + outstanding (analytical)
  //   2. Names & Relationships      — list of related parties with category + notes
  //   3. Party-wise Volumes         — per-party totals + tx-type breakdown
  //   4. Material Transactions      — every flagged transaction (Form AOC-2 ready)
  //   5. Outstanding Balances       — year-end balances by party
  //   6. Audit Findings             — anomalies grouped by type
  //   7. Schedule III Note          — Form 2: audit-paper layout grouped by relationship,
  //                                   per-party transaction lines with prev-year column.
  //                                   This is the sheet that pastes into Notes to Accounts.
  //   8. Per-Party Matrix           — Form 1: pivoted with each party as a column,
  //                                   transaction types as rows. Useful when there are
  //                                   few related parties.
  //   9. Profile Snapshot           — thresholds + ledger overrides for traceability
  const exportExcel = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const XLSX = await import('xlsx-js-style');
      const stamp = toDdMmYyyy(new Date().toISOString()).replace(/\//g, '-');

      const thinBorder = {
        top: { style: 'thin', color: { rgb: 'CBD5E1' } },
        right: { style: 'thin', color: { rgb: 'CBD5E1' } },
        bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
        left: { style: 'thin', color: { rgb: 'CBD5E1' } },
      } as const;
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
      const headerStyle = (bg: string) => ({
        font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: bg } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thinBorder,
      });
      const dataStyle = (row: number, rightAlign: boolean, bold = false, numFmt?: string) => {
        const s: any = {
          font: { name: 'Calibri', sz: 10, color: { rgb: '0F172A' }, bold },
          fill: { fgColor: { rgb: row % 2 === 0 ? 'FFFFFF' : 'F8FAFC' } },
          alignment: {
            horizontal: rightAlign ? 'right' : 'left',
            vertical: 'center',
            wrapText: !rightAlign,
          },
          border: thinBorder,
        };
        if (numFmt) s.numFmt = numFmt;
        return s;
      };
      const totalStyle = (numFmt?: string) => ({
        font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '0F766E' } },
        alignment: { horizontal: 'right' },
        border: thinBorder,
        numFmt,
      });
      const paint = (ws: any, r: number, c: number, style: any) => {
        const a = XLSX.utils.encode_cell({ r, c });
        if (ws[a]) ws[a].s = style;
      };

      const wb = XLSX.utils.book_new();
      const activeCategories = RELATIONSHIP_ORDER.filter(
        (r) => analysis.matrix[r] && Object.keys(analysis.matrix[r]!).length > 0
      );
      const activeTxTypes = (() => {
        const seen = new Set<RPTransactionType>();
        activeCategories.forEach((cat) => {
          Object.keys(analysis.matrix[cat]!).forEach((t) => seen.add(t as RPTransactionType));
        });
        const order: RPTransactionType[] = [
          'sale-goods','sale-services','purchase-goods','purchase-services',
          'rendering-services','receiving-services','agency-arrangements',
          'leasing-hire-purchase','rd-transfer','license-agreements',
          'finance-given','finance-received','interest-paid','interest-received',
          'rent-paid','rent-received','remuneration','reimbursement',
          'guarantees-given','guarantees-received','management-contracts',
          'dividend-paid','dividend-received','other',
        ];
        return order.filter((t) => seen.has(t));
      })();

      // ───── Sheet 1: AS-18 Disclosure Note ─────────────────────────────
      {
        const aoa: any[][] = [
          ['Related Party Disclosures (AS-18)'],
          [`Reporting period covers transactions tagged across ${analysis.parties.length} related parties.`],
          ['As required by Para 23, transactions are presented by relationship category × nature of transaction. Year-end outstanding balances follow.'],
          [''],
          ['Nature of transaction', ...activeCategories.map((c) => RELATIONSHIP_LABEL[c]), 'Total'],
        ];
        activeTxTypes.forEach((tx) => {
          const row: any[] = [TX_TYPE_LABEL[tx]];
          let total = 0;
          activeCategories.forEach((cat) => {
            const v = analysis.matrix[cat]?.[tx] || 0;
            row.push(v);
            total += v;
          });
          row.push(total);
          aoa.push(row);
        });
        // Aggregate row
        const aggRow: any[] = ['Aggregate volume'];
        activeCategories.forEach((cat) => {
          aggRow.push(activeTxTypes.reduce((s, t) => s + (analysis.matrix[cat]?.[t] || 0), 0));
        });
        aggRow.push(analysis.totalRPTVolume);
        aoa.push(aggRow);
        aoa.push([]);
        // Outstanding
        aoa.push(['Outstanding balances — year-end']);
        aoa.push(['', ...activeCategories.map((c) => RELATIONSHIP_LABEL[c]), 'Total']);
        const recRow: any[] = ['Receivable (Dr)'];
        const payRow: any[] = ['Payable (Cr)'];
        activeCategories.forEach((cat) => {
          recRow.push(analysis.outstandingMatrix[cat]?.receivable || 0);
          payRow.push(analysis.outstandingMatrix[cat]?.payable || 0);
        });
        recRow.push(activeCategories.reduce((s, c) => s + (analysis.outstandingMatrix[c]?.receivable || 0), 0));
        payRow.push(activeCategories.reduce((s, c) => s + (analysis.outstandingMatrix[c]?.payable || 0), 0));
        aoa.push(recRow);
        aoa.push(payRow);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = activeCategories.length + 1;
        ws['!cols'] = [{ wch: 38 }, ...activeCategories.map(() => ({ wch: 22 })), { wch: 18 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
          { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 1, ySplit: 5 };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 2, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 4, c, headerStyle('1E40AF'));
        // Body rows
        for (let r = 5; r < 5 + activeTxTypes.length; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          for (let c = 1; c <= lastCol; c++) paint(ws, r, c, dataStyle(r, true, false, '#,##0.00'));
        }
        // Aggregate row
        const aggR = 5 + activeTxTypes.length;
        for (let c = 0; c <= lastCol; c++) paint(ws, aggR, c, totalStyle('#,##0.00'));
        XLSX.utils.book_append_sheet(wb, ws, 'AS-18 Note');
      }

      // ───── Sheet 2: Names & Relationships ─────────────────────────────
      {
        const headers = ['Party', 'Category', 'Notes (per AS-18 Para 26)', 'Year-end balance', 'Volume'];
        const aoa: any[][] = [
          ['Names of related parties and nature of relationship'],
          ['Required by AS-18 Para 26. Listed in order of relationship priority.'],
          [''],
          headers,
        ];
        analysis.parties.forEach((p) => {
          aoa.push([
            p.partyName,
            RELATIONSHIP_LABEL[p.category],
            p.relationshipNotes || '',
            p.closing,
            p.totalVolume,
          ]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [{ wch: 36 }, { wch: 28 }, { wch: 60 }, { wch: 18 }, { wch: 18 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 0, ySplit: 4 };
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }) };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('075985'));
        for (let r = 4; r < 4 + analysis.parties.length; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          paint(ws, r, 1, dataStyle(r, false));
          paint(ws, r, 2, dataStyle(r, false));
          paint(ws, r, 3, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 4, dataStyle(r, true, false, '#,##0.00'));
        }
        XLSX.utils.book_append_sheet(wb, ws, 'Names & Relationships');
      }

      // ───── Sheet 3: Party-wise Volumes ────────────────────────────────
      {
        const headers = [
          'Party', 'Category', 'Voucher count', 'First date', 'Last date',
          'Opening', 'Net movement', 'Closing', 'Balance gap',
          'Total debits', 'Total credits', 'Total volume',
          'Year-end concentration %', 'Highest single tx', 'Unusual tx count',
          'Needs board approval', 'Needs SH approval',
        ];
        const aoa: any[][] = [
          ['Party-wise volume + audit metrics'],
          ['Year-end concentration is the % of |volume| in the last N days (configurable). Balance gap = closing − (opening + net movement); should be 0 if books are clean.'],
          [''],
          headers,
        ];
        analysis.parties.forEach((p) => {
          aoa.push([
            p.partyName,
            RELATIONSHIP_LABEL[p.category],
            p.voucherCount,
            p.firstDate ? toDdMmYyyy(p.firstDate) : '',
            p.lastDate ? toDdMmYyyy(p.lastDate) : '',
            p.opening, p.movementNet, p.closing, p.balanceGap,
            p.totalDebits, p.totalCredits, p.totalVolume,
            p.yearEndConcentrationPct,
            p.highestSingleTx,
            p.unusualTxCount,
            p.needsBoardApproval ? 'Yes' : 'No',
            p.needsShareholderApproval ? 'Yes' : 'No',
          ]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [
          { wch: 34 }, { wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
          { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
          { wch: 14 }, { wch: 14 }, { wch: 14 },
          { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
        ];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 1, ySplit: 4 };
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }) };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('111827'));
        for (let r = 4; r < 4 + analysis.parties.length; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          paint(ws, r, 1, dataStyle(r, false));
          paint(ws, r, 2, dataStyle(r, true));
          paint(ws, r, 3, dataStyle(r, true));
          paint(ws, r, 4, dataStyle(r, true));
          for (let c = 5; c <= 11; c++) paint(ws, r, c, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 12, dataStyle(r, true, false, '0.0"%"'));
          paint(ws, r, 13, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 14, dataStyle(r, true));
          paint(ws, r, 15, dataStyle(r, false));
          paint(ws, r, 16, dataStyle(r, false));
        }
        XLSX.utils.book_append_sheet(wb, ws, 'Party-wise Volumes');
      }

      // ───── Sheet 4: Material Transactions (Form AOC-2 ready) ──────────
      {
        const headers = [
          'Date', 'Party', 'Category', 'Voucher type', 'Voucher no', 'Invoice no',
          'AS-18 transaction type', 'Auto?',
          'Party amount (+Cr/-Dr)', 'Counter ledger', 'Counter amount',
          'Year-end?', 'Round?', 'Material?', 'Journal?',
          'Flag notes', 'Narration',
        ];
        const aoa: any[][] = [
          ['Material transactions detail (Form AOC-2 ready)'],
          ['Per-voucher slice for every related party. Pair with board-resolution references in the audit file. Sort/filter to identify items requiring Sec 188 disclosure.'],
          [''],
          headers,
        ];
        analysis.transactions.forEach((t) => {
          const cat = profile.parties[t.partyName]?.category || 'other-rp';
          aoa.push([
            t.date ? toDdMmYyyy(t.date) : '',
            t.partyName,
            RELATIONSHIP_LABEL[cat],
            t.voucher_type,
            t.voucher_number,
            t.invoice_number,
            TX_TYPE_LABEL[t.txType],
            t.txTypeAuto ? 'Auto' : 'Pinned',
            t.partyAmount,
            t.primaryCounterLedger,
            t.primaryCounterAmount,
            t.isYearEnd ? 'Yes' : '',
            t.isRoundAmount ? 'Yes' : '',
            t.isHighValue ? 'Yes' : '',
            t.isJournalVoucher ? 'Yes' : '',
            t.flagNotes.join(' • '),
            t.narration,
          ]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [
          { wch: 11 }, { wch: 32 }, { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 14 },
          { wch: 32 }, { wch: 8 },
          { wch: 16 }, { wch: 30 }, { wch: 16 },
          { wch: 9 }, { wch: 7 }, { wch: 9 }, { wch: 9 },
          { wch: 28 }, { wch: 60 },
        ];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 2, ySplit: 4 };
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }) };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('86198F'));
        for (let r = 4; r < 4 + analysis.transactions.length; r++) {
          paint(ws, r, 0, dataStyle(r, true));
          paint(ws, r, 1, dataStyle(r, false, true));
          paint(ws, r, 2, dataStyle(r, false));
          paint(ws, r, 3, dataStyle(r, false));
          paint(ws, r, 4, dataStyle(r, false));
          paint(ws, r, 5, dataStyle(r, false));
          paint(ws, r, 6, dataStyle(r, false));
          paint(ws, r, 7, dataStyle(r, false));
          paint(ws, r, 8, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 9, dataStyle(r, false));
          paint(ws, r, 10, dataStyle(r, true, false, '#,##0.00'));
          for (let c = 11; c <= 14; c++) paint(ws, r, c, dataStyle(r, false));
          paint(ws, r, 15, dataStyle(r, false));
          paint(ws, r, 16, dataStyle(r, false));
        }
        XLSX.utils.book_append_sheet(wb, ws, 'Material Transactions');
      }

      // ───── Sheet 5: Outstanding Balances ──────────────────────────────
      {
        const headers = ['Party', 'Category', 'Closing balance', 'Receivable (Dr)', 'Payable (Cr)', 'Notes'];
        const aoa: any[][] = [
          ['Year-end outstanding balances'],
          ['Party-wise closing balances split into receivable / payable. Use this as the disclosure note for AS-18 Para 23(iii) and Schedule III RP note.'],
          [''],
          headers,
        ];
        analysis.parties.forEach((p) => {
          aoa.push([
            p.partyName,
            RELATIONSHIP_LABEL[p.category],
            p.closing,
            p.closing > 0 ? p.closing : 0,
            p.closing < 0 ? Math.abs(p.closing) : 0,
            Math.abs(p.balanceGap) > 1
              ? `Balance gap ₹${inr(p.balanceGap)} — closing disagrees with opening + movement`
              : '',
          ]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [{ wch: 34 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 60 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 1, ySplit: 4 };
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }) };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('047857'));
        for (let r = 4; r < 4 + analysis.parties.length; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          paint(ws, r, 1, dataStyle(r, false));
          for (let c = 2; c <= 4; c++) paint(ws, r, c, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 5, dataStyle(r, false));
        }
        XLSX.utils.book_append_sheet(wb, ws, 'Outstanding Balances');
      }

      // ───── Sheet 6: Audit Findings ────────────────────────────────────
      {
        const flagged = analysis.transactions.filter((t) => t.flagNotes.length > 0);
        const headers = ['Type', 'Date', 'Party', 'Voucher no', 'Voucher type', 'Amount', 'Notes', 'Narration'];
        const aoa: any[][] = [
          ['Audit findings — items for review'],
          [`${flagged.length} flagged transactions. Year-end / round amounts / materiality / journal vouchers.`],
          [''],
          headers,
        ];
        flagged.forEach((t) => {
          aoa.push([
            t.flagNotes.join(' • ') || 'Flagged',
            t.date ? toDdMmYyyy(t.date) : '',
            t.partyName,
            t.voucher_number,
            t.voucher_type,
            t.partyAmount,
            t.flagNotes.join(' • '),
            t.narration,
          ]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!cols'] = [{ wch: 28 }, { wch: 11 }, { wch: 30 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 28 }, { wch: 60 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 0, ySplit: 4 };
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } }) };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('B91C1C'));
        for (let r = 4; r < 4 + flagged.length; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          paint(ws, r, 1, dataStyle(r, true));
          paint(ws, r, 2, dataStyle(r, false, true));
          paint(ws, r, 3, dataStyle(r, false));
          paint(ws, r, 4, dataStyle(r, false));
          paint(ws, r, 5, dataStyle(r, true, false, '#,##0.00'));
          paint(ws, r, 6, dataStyle(r, false));
          paint(ws, r, 7, dataStyle(r, false));
        }
        XLSX.utils.book_append_sheet(wb, ws, 'Audit Findings');
      }

      // ───── Sheet 8: Schedule III Note (Form 2 — audit paper layout) ──
      //
      // The conventional Indian audit-paper format. Three sections:
      //
      //   (a) Names of related parties grouped under category headings.
      //   (b) Transactions during the year — a flat 3-column block
      //       (Particulars / Current Year / Previous Year) where each
      //       relationship category is a header row, each party a sub-
      //       header, and each AS-18 transaction type a leaf row under
      //       its party.
      //   (c) Outstanding balances at year-end — same shape, with
      //       receivable/payable treated as separate leaf rows.
      //
      // The Previous Year column is left blank for the auditor to fill
      // in manually — the current dataset doesn't carry prior-year
      // information and we'd rather leave a clean cell than fabricate.
      // To pre-fill it later, plug values into profile.previousYearMatrix
      // (key shape `{partyName}|{txType}` → number).
      {
        const aoa: any[][] = [];
        aoa.push(['Note — Related Party Disclosures (Schedule III, AS-18)']);
        aoa.push(['Prepared per AS-18 read with Schedule III to the Companies Act 2013. Previous-year column to be completed by the auditor from the prior period working papers.']);
        aoa.push(['']);

        // Group parties by relationship category, preserving the canonical
        // order so the note reads top-to-bottom in the standard sequence.
        const partiesByCat = new Map<RPRelationshipCategory, typeof analysis.parties>();
        analysis.parties.forEach((p) => {
          const arr = partiesByCat.get(p.category) || [];
          arr.push(p);
          partiesByCat.set(p.category, arr);
        });

        // ── (a) Names and nature of relationship ──────────────────────
        aoa.push(['(a) Names of related parties and nature of relationship']);
        aoa.push(['']);
        aoa.push(['Sl', 'Particulars', '']);
        let sl = 1;
        RELATIONSHIP_ORDER.forEach((cat) => {
          const parties = partiesByCat.get(cat) || [];
          if (parties.length === 0) return;
          aoa.push([`(${sl++})`, RELATIONSHIP_LABEL[cat], '']);
          parties.forEach((p) => {
            const desc = p.relationshipNotes ? `${p.partyName} — ${p.relationshipNotes}` : p.partyName;
            aoa.push(['', desc, '']);
          });
        });
        aoa.push(['']);

        // ── (b) Transactions during the year ──────────────────────────
        aoa.push(['(b) Transactions during the year (₹)']);
        aoa.push(['']);
        aoa.push(['Particulars', 'Current Year', 'Previous Year']);
        const bStart = aoa.length;
        const sectionRowMarkers: number[] = [];     // rows we want to bold/colour as section headers
        const partyRowMarkers: number[] = [];       // rows we want to bold/italicise as party headers
        RELATIONSHIP_ORDER.forEach((cat) => {
          const parties = partiesByCat.get(cat) || [];
          if (parties.length === 0) return;
          // Skip categories with zero transaction volume entirely.
          const hasAny = parties.some((p) => Object.values(p.txByType).some((v) => Math.abs(Number(v) || 0) > 0));
          if (!hasAny) return;
          sectionRowMarkers.push(aoa.length);
          aoa.push([RELATIONSHIP_LABEL[cat], '', '']);
          parties.forEach((p) => {
            const types = (Object.entries(p.txByType) as [RPTransactionType, number][])
              .filter(([, v]) => Math.abs(Number(v) || 0) > 0)
              .sort((a, b) => Math.abs(Number(b[1]) || 0) - Math.abs(Number(a[1]) || 0));
            if (types.length === 0) return;
            partyRowMarkers.push(aoa.length);
            aoa.push([p.partyName, '', '']);
            types.forEach(([txType, v]) => {
              // Previous-year lookup: profile.previousYearMatrix[partyName][txType]
              // The nested shape is the existing type contract; if you want
              // to back-fill prior figures, edit the JSON profile directly
              // or use the import-profile button on the Tag step.
              const prev = profile.previousYearMatrix?.[p.partyName]?.[txType];
              aoa.push([
                `    ${TX_TYPE_LABEL[txType]}`,
                Math.round(Number(v) || 0),
                typeof prev === 'number' ? Math.round(prev) : '',
              ]);
            });
          });
        });
        aoa.push(['']);

        // ── (c) Outstanding balances ──────────────────────────────────
        aoa.push(['(c) Outstanding balances at year-end (₹)']);
        aoa.push(['']);
        aoa.push(['Particulars', 'Current Year', 'Previous Year']);
        RELATIONSHIP_ORDER.forEach((cat) => {
          const parties = partiesByCat.get(cat) || [];
          if (parties.length === 0) return;
          const hasOutstanding = parties.some((p) => Math.abs(p.closing) > 0);
          if (!hasOutstanding) return;
          sectionRowMarkers.push(aoa.length);
          aoa.push([RELATIONSHIP_LABEL[cat], '', '']);
          parties.forEach((p) => {
            if (Math.abs(p.closing) <= 0) return;
            partyRowMarkers.push(aoa.length);
            aoa.push([p.partyName, '', '']);
            if (p.closing > 0) {
              const prev = profile.previousYearMatrix?.[p.partyName]?.['receivable'];
              aoa.push([
                '    Receivable (Dr)',
                Math.round(p.closing),
                typeof prev === 'number' ? Math.round(prev) : '',
              ]);
            } else {
              const prev = profile.previousYearMatrix?.[p.partyName]?.['payable'];
              aoa.push([
                '    Payable (Cr)',
                Math.round(Math.abs(p.closing)),
                typeof prev === 'number' ? Math.round(prev) : '',
              ]);
            }
          });
        });
        aoa.push(['']);
        aoa.push(['Note — figures rounded to nearest rupee. Material individual transactions disclosed separately under Section 188 of the Companies Act 2013 / Form AOC-2 where applicable.']);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 60 }, { wch: 18 }, { wch: 18 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } },
        ];
        ws['!freeze'] = { xSplit: 0, ySplit: 3 };
        // Title + meta
        for (let c = 0; c <= 2; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= 2; c++) paint(ws, 1, c, metaStyle);
        // Style section heading rows
        const sectionHeadStyle = {
          font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '1E40AF' } },
          alignment: { horizontal: 'left' },
          border: thinBorder,
        };
        const partyHeadStyle = {
          font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: '1E3A8A' } },
          fill: { fgColor: { rgb: 'EFF6FF' } },
          alignment: { horizontal: 'left' },
          border: thinBorder,
        };
        sectionRowMarkers.forEach((r) => {
          for (let c = 0; c <= 2; c++) paint(ws, r, c, sectionHeadStyle);
        });
        partyRowMarkers.forEach((r) => {
          for (let c = 0; c <= 2; c++) paint(ws, r, c, partyHeadStyle);
        });
        XLSX.utils.book_append_sheet(wb, ws, 'Schedule III Note');
      }

      // ───── Sheet 9: Per-Party Matrix (Form 1 — analytical layout) ────
      //
      // Same data as Sheet 8 but pivoted: each individual related party
      // becomes a column (grouped under category sub-headers), AS-18
      // transaction types are rows. Useful when the entity has few
      // related parties and the auditor wants a single across-the-board
      // view rather than a long narrative note.
      {
        // Column layout: parties in canonical category order
        const partyOrder: { name: string; cat: RPRelationshipCategory }[] = [];
        RELATIONSHIP_ORDER.forEach((cat) => {
          const parties = analysis.parties.filter((p) => p.category === cat);
          parties.forEach((p) => partyOrder.push({ name: p.partyName, cat }));
        });

        // Active tx-types: only those with any volume across all parties
        const activeTxTypes: RPTransactionType[] = [];
        const txOrder: RPTransactionType[] = [
          'sale-goods','sale-services','purchase-goods','purchase-services',
          'rendering-services','receiving-services','agency-arrangements',
          'leasing-hire-purchase','rd-transfer','license-agreements',
          'finance-given','finance-received','interest-paid','interest-received',
          'rent-paid','rent-received','remuneration','reimbursement',
          'guarantees-given','guarantees-received','management-contracts',
          'dividend-paid','dividend-received','other',
        ];
        txOrder.forEach((tx) => {
          const hasAny = analysis.parties.some((p) => Math.abs(Number(p.txByType[tx]) || 0) > 0);
          if (hasAny) activeTxTypes.push(tx);
        });

        const aoa: any[][] = [];
        aoa.push(['Per-party related-party transaction matrix (₹)']);
        aoa.push(['Companion to the Schedule III Note. Each column is one party; the category sub-header above shows its AS-18 relationship.']);
        aoa.push(['']);
        // Sub-header row — category labels above each party column
        const subHead: any[] = [''];
        partyOrder.forEach((p) => subHead.push(RELATIONSHIP_LABEL[p.cat]));
        subHead.push('');
        aoa.push(subHead);
        // Header row — party names
        const head: any[] = ['Nature of transaction'];
        partyOrder.forEach((p) => head.push(p.name));
        head.push('Total');
        aoa.push(head);
        // Body
        activeTxTypes.forEach((tx) => {
          const row: any[] = [TX_TYPE_LABEL[tx]];
          let total = 0;
          partyOrder.forEach((p) => {
            const partyRow = analysis.parties.find((q) => q.partyName === p.name);
            const v = partyRow ? Math.round(Number(partyRow.txByType[tx]) || 0) : 0;
            row.push(v);
            total += v;
          });
          row.push(total);
          aoa.push(row);
        });
        // Outstanding balances rows
        aoa.push(['']);
        const recRow: any[] = ['Receivable at year-end (Dr)'];
        const payRow: any[] = ['Payable at year-end (Cr)'];
        let recTotal = 0, payTotal = 0;
        partyOrder.forEach((p) => {
          const partyRow = analysis.parties.find((q) => q.partyName === p.name);
          const closing = partyRow ? partyRow.closing : 0;
          if (closing > 0) {
            recRow.push(Math.round(closing));
            payRow.push(0);
            recTotal += closing;
          } else if (closing < 0) {
            recRow.push(0);
            payRow.push(Math.round(Math.abs(closing)));
            payTotal += Math.abs(closing);
          } else {
            recRow.push(0);
            payRow.push(0);
          }
        });
        recRow.push(Math.round(recTotal));
        payRow.push(Math.round(payTotal));
        aoa.push(recRow);
        aoa.push(payRow);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = partyOrder.length + 1;
        ws['!cols'] = [{ wch: 38 }, ...partyOrder.map(() => ({ wch: 22 })), { wch: 18 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
        ];
        ws['!freeze'] = { xSplit: 1, ySplit: 5 };
        for (let c = 0; c <= lastCol; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= lastCol; c++) paint(ws, 3, c, headerStyle('64748B')); // category subheader
        for (let c = 0; c <= lastCol; c++) paint(ws, 4, c, headerStyle('1E40AF')); // party name header
        for (let r = 5; r < 5 + activeTxTypes.length; r++) {
          paint(ws, r, 0, dataStyle(r, false, true));
          for (let c = 1; c <= lastCol; c++) paint(ws, r, c, dataStyle(r, true, false, '#,##0.00'));
        }
        // Outstanding rows styled as totals
        const recR = 5 + activeTxTypes.length + 1;
        for (let c = 0; c <= lastCol; c++) paint(ws, recR, c, totalStyle('#,##0.00'));
        for (let c = 0; c <= lastCol; c++) paint(ws, recR + 1, c, totalStyle('#,##0.00'));
        XLSX.utils.book_append_sheet(wb, ws, 'Per-Party Matrix');
      }

      // ───── Sheet 10: Profile Snapshot ─────────────────────────────────
      {
        const aoa: any[][] = [
          ['Profile snapshot — for reproducibility'],
          [`Exported on ${toDdMmYyyy(new Date().toISOString())}`],
          [''],
          ['Threshold', 'Value'],
          ['Materiality (₹)', profile.thresholds.materialityRupees],
          ['Year-end window (days)', profile.thresholds.yearEndDays],
          ['Round-amount unit (₹)', profile.thresholds.roundAmountUnit],
          ['Sec 188 turnover trigger %', profile.thresholds.section188TurnoverPct],
          ['Annual turnover used (₹)', profile.thresholds.annualTurnover],
          [''],
          ['Per-ledger AS-18 type pins'],
          ['Counter ledger', 'Pinned to'],
          ...Object.entries(profile.ledgerTxType).map(([l, t]) => [l, TX_TYPE_LABEL[t as RPTransactionType] || t]),
        ];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 36 }, { wch: 28 }];
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: 1 } },
        ];
        for (let c = 0; c <= 1; c++) paint(ws, 0, c, titleStyle);
        for (let c = 0; c <= 1; c++) paint(ws, 1, c, metaStyle);
        for (let c = 0; c <= 1; c++) paint(ws, 3, c, headerStyle('334155'));
        for (let c = 0; c <= 1; c++) paint(ws, 10, c, headerStyle('334155'));
        XLSX.utils.book_append_sheet(wb, ws, 'Profile Snapshot');
      }

      XLSX.writeFile(wb, `Related_Party_AS18_${stamp}.xlsx`, { compression: true });
      setMsg('AS-18 schedule exported.');
      setTimeout(() => setMsg(''), 1800);
    } catch (err: any) {
      console.error('[RelatedPartyAnalysis] Excel export failed:', err);
      const guard =
        analysis.parties.length === 0
          ? '\n\nHint: tag at least one related party first.'
          : '';
      window.alert(`AS-18 Excel export failed:\n  ${err?.name || 'Error'}: ${err?.message || err}${guard}\n\nFull stack in DevTools console.`);
    } finally {
      setExporting(false);
    }
  };

  // ── LLM markdown brief ──────────────────────────────────────────────────
  const buildLLMMarkdown = (): string => {
    const lines: string[] = [];
    const stamp = toDdMmYyyy(new Date().toISOString());
    lines.push('# Related Party (AS-18) Audit Brief');
    lines.push(`Generated on ${stamp}.`);
    lines.push('');
    lines.push('## Audit prompt');
    lines.push('Review the following AS-18 related-party data for the entity. Identify:');
    lines.push('1. Whether the relationship list looks complete (any obvious omissions: directors\' relatives, group entities, common-control parties).');
    lines.push('2. Transactions that warrant deeper testing — round amounts, year-end concentration, journal vouchers, or material values.');
    lines.push('3. Whether transaction classification under AS-18 Para 23 looks correct.');
    lines.push('4. Section 188 / Companies Act 2013 triggers — material contracts that may need shareholder approval.');
    lines.push('5. Any disclosures that appear incomplete relative to the standard.');
    lines.push('');
    lines.push('## 1. Names and relationships');
    lines.push('```csv');
    lines.push('Party,Category,Notes,Closing balance,Volume');
    analysis.parties.forEach((p) => {
      const csv = (v: any) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      lines.push(`${csv(p.partyName)},${csv(RELATIONSHIP_LABEL[p.category])},${csv(p.relationshipNotes)},${Math.round(p.closing)},${Math.round(p.totalVolume)}`);
    });
    lines.push('```');
    lines.push('');
    lines.push('## 2. AS-18 Disclosure Matrix (₹)');
    const activeCategories = RELATIONSHIP_ORDER.filter(
      (r) => analysis.matrix[r] && Object.keys(analysis.matrix[r]!).length > 0
    );
    lines.push('```csv');
    lines.push(['Nature of transaction', ...activeCategories.map((c) => RELATIONSHIP_LABEL[c]), 'Total'].join(','));
    const allTx = new Set<RPTransactionType>();
    activeCategories.forEach((cat) => Object.keys(analysis.matrix[cat]!).forEach((t) => allTx.add(t as RPTransactionType)));
    Array.from(allTx).forEach((tx) => {
      const cells = activeCategories.map((cat) => Math.round(analysis.matrix[cat]?.[tx] || 0));
      const total = cells.reduce((s, v) => s + v, 0);
      lines.push([`"${TX_TYPE_LABEL[tx]}"`, ...cells, total].join(','));
    });
    lines.push('```');
    lines.push('');
    lines.push('## 3. Outstanding balances');
    lines.push('```csv');
    lines.push('Category,Receivable,Payable');
    activeCategories.forEach((c) => {
      const o = analysis.outstandingMatrix[c] || { receivable: 0, payable: 0 };
      lines.push(`"${RELATIONSHIP_LABEL[c]}",${Math.round(o.receivable)},${Math.round(o.payable)}`);
    });
    lines.push('```');
    lines.push('');
    const flagged = analysis.transactions.filter((t) => t.flagNotes.length > 0).slice(0, 50);
    lines.push(`## 4. Top audit findings (first 50 of ${analysis.transactions.filter((t) => t.flagNotes.length > 0).length})`);
    lines.push('```csv');
    lines.push('Date,Party,Voucher,Type,Amount,Flags,Narration');
    flagged.forEach((t) => {
      const csv = (v: any) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      lines.push([
        toDdMmYyyy(t.date),
        csv(t.partyName),
        csv(t.voucher_number),
        csv(t.voucher_type),
        Math.round(t.partyAmount),
        csv(t.flagNotes.join(' | ')),
        csv(t.narration),
      ].join(','));
    });
    lines.push('```');
    lines.push('');
    lines.push('## Configuration');
    lines.push(`- Materiality threshold: ₹${inr(profile.thresholds.materialityRupees)}`);
    lines.push(`- Year-end window: last ${profile.thresholds.yearEndDays} days`);
    lines.push(`- Round-amount unit: ₹${inr(profile.thresholds.roundAmountUnit)}`);
    lines.push(`- Sec 188 trigger: ${profile.thresholds.section188TurnoverPct}% of turnover (₹${inr(profile.thresholds.annualTurnover)})`);
    return lines.join('\n');
  };

  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const copyLLMBrief = async () => {
    if (copyState !== 'idle') return;
    setCopyState('copying');
    try {
      const md = buildLLMMarkdown();
      await navigator.clipboard.writeText(md);
      setCopyState('copied');
      setMsg('LLM brief copied to clipboard.');
      setTimeout(() => {
        setCopyState('idle');
        setMsg('');
      }, 1800);
    } catch (e) {
      setCopyState('idle');
      window.alert('Could not copy to clipboard. Try the Download button instead.');
    }
  };

  const downloadLLMBrief = () => {
    const md = buildLLMMarkdown();
    const stamp = toDdMmYyyy(new Date().toISOString()).replace(/\//g, '-');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Related_Party_AS18_Brief_${stamp}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Step 1: tag ──────────────────────────────────────────────────────────
  if (step === 'tag') {
    return (
      <div className="space-y-4 animate-in fade-in duration-300">
        <PartyTagger
          ledgers={allLedgers}
          parties={profile.parties}
          onChange={(parties) => setProfile((p) => ({ ...p, parties }))}
        />
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportProfile}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 text-sm font-bold"
            >
              <FileJson size={14} /> Export profile
            </button>
            <button
              onClick={() => profileFileRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-bold"
            >
              <Upload size={14} /> Import profile
            </button>
            <input
              ref={profileFileRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => e.target.files?.[0] && importProfile(e.target.files[0])}
            />
          </div>
          <div className="flex-1 text-xs text-slate-500">
            {Object.keys(profile.parties).length === 0
              ? 'Select at least one ledger to enable analysis.'
              : `${Object.keys(profile.parties).length} parties tagged.`}
          </div>
          <button
            onClick={() => setStep('analyse')}
            disabled={Object.keys(profile.parties).length === 0}
            className="inline-flex items-center gap-2 px-6 py-2 rounded-lg bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Generate AS-18 schedule <ChevronRight size={16} />
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: analyse ──────────────────────────────────────────────────────
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* Top metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white p-4 rounded-xl border border-slate-200">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Tagged parties</p>
          <p className="text-2xl font-black text-slate-900">{analysis.parties.length}</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Aggregate volume</p>
          <p className="text-2xl font-black text-slate-900">₹{inr(analysis.totalRPTVolume)}</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Audit flags</p>
          <p className="text-2xl font-black text-rose-600">
            {analysis.transactions.filter((t) => t.flagNotes.length > 0).length}
          </p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Unbalanced vouchers</p>
          <p className={`text-2xl font-black ${analysis.unbalancedVoucherCount > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
            {analysis.unbalancedVoucherCount}
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm flex flex-wrap gap-2 items-center">
        <div className="flex bg-slate-100 p-1 rounded-lg">
          {([
            ['matrix', 'AS-18 Matrix'],
            ['parties', 'By Party'],
            ['findings', 'Audit Findings'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={`px-3 py-1.5 rounded-md text-xs font-black uppercase tracking-tight ${
                view === k ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={14} />
          <input
            value={partyQ}
            onChange={(e) => setPartyQ(e.target.value)}
            placeholder="Search party…"
            className="w-full pl-8 pr-3 py-2 text-xs border border-slate-300 rounded-lg"
          />
        </div>

        <select
          value={relFilter}
          onChange={(e) => setRelFilter(e.target.value as any)}
          className="text-xs px-3 py-2 border border-slate-300 rounded-lg font-bold"
        >
          <option value="all">All categories</option>
          {RELATIONSHIP_ORDER.map((r) => (
            <option key={r} value={r}>
              {RELATIONSHIP_LABEL[r]}
            </option>
          ))}
        </select>

        {view === 'findings' && (
          <select
            value={findingsFilter}
            onChange={(e) => setFindingsFilter(e.target.value as any)}
            className="text-xs px-3 py-2 border border-slate-300 rounded-lg font-bold"
          >
            <option value="all">All findings</option>
            <option value="high-value">Material only</option>
            <option value="year-end">Year-end only</option>
            <option value="round">Round amounts only</option>
            <option value="journal">Journal vouchers only</option>
          </select>
        )}

        <button
          onClick={() => setStep('tag')}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-slate-700 border border-slate-300 hover:bg-slate-50"
        >
          <Settings2 size={13} /> Edit tags / thresholds
        </button>

        <button
          onClick={exportExcel}
          disabled={exporting || analysis.parties.length === 0}
          title={
            analysis.parties.length === 0
              ? 'Tag at least one related party first.'
              : 'Download the seven-sheet AS-18 disclosure schedule.'
          }
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-black hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {exporting ? 'Exporting…' : 'Export AS-18 Schedule'}
        </button>

        <button
          onClick={copyLLMBrief}
          disabled={copyState !== 'idle' || analysis.parties.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 disabled:opacity-60"
        >
          <ClipboardCopy size={13} /> {copyState === 'copied' ? 'Copied' : 'Copy LLM brief'}
        </button>

        <button
          onClick={downloadLLMBrief}
          disabled={analysis.parties.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-60"
        >
          <FileText size={13} /> Download .md
        </button>
      </div>

      {msg && (
        <div className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
          {msg}
        </div>
      )}
      {computing && (
        <div className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-3 py-2 rounded-lg flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Re-computing AS-18 matrix…
        </div>
      )}

      {/* View body */}
      {view === 'matrix' && (
        <DisclosureMatrix
          matrix={analysis.matrix}
          outstanding={analysis.outstandingMatrix}
          totalVolume={analysis.totalRPTVolume}
        />
      )}

      {view === 'parties' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-white text-[10px] uppercase tracking-widest font-black">
              <tr>
                <th className="px-4 py-3 text-left">Party</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-right">Vouchers</th>
                <th className="px-4 py-3 text-right">Volume (₹)</th>
                <th className="px-4 py-3 text-right">Closing (₹)</th>
                <th className="px-4 py-3 text-right">Year-end %</th>
                <th className="px-4 py-3 text-right">Flags</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredParties.map((p) => {
                const isOpen = expandedParty === p.partyName;
                const partyTxs = analysis.transactions.filter((t) => t.partyName === p.partyName);
                return (
                  <React.Fragment key={p.partyName}>
                    <tr
                      className={`cursor-pointer hover:bg-slate-50 ${isOpen ? 'bg-slate-50' : ''}`}
                      onClick={() => setExpandedParty(isOpen ? null : p.partyName)}
                    >
                      <td className="px-4 py-2.5 font-bold text-slate-900">{p.partyName}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${REL_STYLES[p.category].bg} ${REL_STYLES[p.category].text}`}
                        >
                          {RELATIONSHIP_LABEL[p.category]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{p.voucherCount}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-bold">{inr(p.totalVolume)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono font-bold ${p.closing < 0 ? 'text-rose-700' : p.closing > 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
                        {inr(Math.abs(p.closing))} {p.closing < 0 ? 'Cr' : p.closing > 0 ? 'Dr' : ''}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-mono ${p.yearEndConcentrationPct > 50 ? 'text-amber-700 font-bold' : 'text-slate-600'}`}>
                        {p.yearEndConcentrationPct.toFixed(1)}%
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {p.unusualTxCount > 0 && (
                          <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-black">
                            {p.unusualTxCount}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-slate-400">
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50">
                        <td colSpan={8} className="p-4">
                          {p.relationshipNotes && (
                            <div className="mb-3 text-xs text-slate-600 italic flex items-start gap-2">
                              <Info size={13} className="text-indigo-500 mt-0.5 shrink-0" />
                              <span>{p.relationshipNotes}</span>
                            </div>
                          )}
                          {/* AS-18 type breakdown */}
                          <div className="mb-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                            {(Object.entries(p.txByType) as [RPTransactionType, number][])
                              .filter(([, v]) => Number(v || 0) > 0)
                              .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
                              .map(([txType, v]) => (
                                <div key={txType} className="bg-white p-2.5 rounded-lg border border-slate-200">
                                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-wider truncate">
                                    {TX_TYPE_LABEL[txType]}
                                  </p>
                                  <p className="font-mono font-bold text-slate-800">₹{inr(Number(v) || 0)}</p>
                                </div>
                              ))}
                          </div>
                          {/* Tx detail */}
                          <div className="overflow-x-auto rounded-lg border border-slate-200">
                            <table className="w-full text-xs">
                              <thead className="bg-slate-100 text-[10px] uppercase tracking-widest font-black text-slate-700">
                                <tr>
                                  <th className="px-3 py-2 text-left">Date</th>
                                  <th className="px-3 py-2 text-left">Voucher</th>
                                  <th className="px-3 py-2 text-left">AS-18 type</th>
                                  <th className="px-3 py-2 text-left">Counter ledger</th>
                                  <th className="px-3 py-2 text-right">Amount (+Cr/-Dr)</th>
                                  <th className="px-3 py-2 text-left">Flags</th>
                                </tr>
                              </thead>
                              <tbody>
                                {partyTxs.slice(0, 200).map((t, i) => (
                                  <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}>
                                    <td className="px-3 py-1.5">{toDdMmYyyy(t.date)}</td>
                                    <td className="px-3 py-1.5 font-bold text-slate-700">{t.voucher_number}</td>
                                    <td className="px-3 py-1.5 text-indigo-700">{TX_TYPE_LABEL[t.txType]} {t.txTypeAuto ? '' : '✱'}</td>
                                    <td className="px-3 py-1.5 truncate max-w-[200px]" title={t.primaryCounterLedger}>{t.primaryCounterLedger}</td>
                                    <td className={`px-3 py-1.5 text-right font-mono font-bold ${t.partyAmount < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                                      {inrSigned(t.partyAmount)}
                                    </td>
                                    <td className="px-3 py-1.5">
                                      {t.flagNotes.map((n) => (
                                        <span key={n} className="inline-block mr-1 px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[9px] font-bold">
                                          {n}
                                        </span>
                                      ))}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {partyTxs.length > 200 && (
                              <div className="px-3 py-2 text-[10px] text-slate-500 italic bg-slate-50">
                                Showing first 200 of {partyTxs.length} transactions. Use Excel export for full list.
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {filteredParties.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">
                    No parties match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'findings' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
            <AlertTriangle className="text-rose-500" size={16} />
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-700">
              Audit findings — {findings.length} item{findings.length === 1 ? '' : 's'}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-[10px] uppercase tracking-widest font-black text-slate-700">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Party</th>
                  <th className="px-3 py-2 text-left">Voucher</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">Flags</th>
                  <th className="px-3 py-2 text-left">Narration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {findings.slice(0, 500).map((t, i) => (
                  <tr key={i} className="hover:bg-rose-50/30">
                    <td className="px-3 py-1.5">{toDdMmYyyy(t.date)}</td>
                    <td className="px-3 py-1.5 font-bold">{t.partyName}</td>
                    <td className="px-3 py-1.5">{t.voucher_number}</td>
                    <td className="px-3 py-1.5 text-slate-600">{t.voucher_type}</td>
                    <td className={`px-3 py-1.5 text-right font-mono font-bold ${t.partyAmount < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                      {inrSigned(t.partyAmount)}
                    </td>
                    <td className="px-3 py-1.5">
                      {t.flagNotes.map((n) => (
                        <span key={n} className="inline-block mr-1 px-1.5 py-0.5 bg-rose-100 text-rose-700 rounded text-[9px] font-bold">
                          {n}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500 italic max-w-[300px] truncate" title={t.narration}>
                      {t.narration}
                    </td>
                  </tr>
                ))}
                {findings.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                      <ShieldCheck className="mx-auto mb-2 text-emerald-500" size={28} />
                      No flagged transactions. Adjust filters or thresholds.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {findings.length > 500 && (
              <div className="px-3 py-2 text-[11px] text-slate-500 italic bg-slate-50 border-t">
                Showing first 500 of {findings.length}. Use Excel export for full list.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Threshold quick-edit panel */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <Filter size={14} className="text-slate-500" />
          <h4 className="text-xs font-black uppercase tracking-widest text-slate-600">Audit thresholds</h4>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          <label className="text-xs">
            <span className="block font-bold text-slate-600 mb-1">Materiality (₹)</span>
            <input
              type="number"
              value={profile.thresholds.materialityRupees}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  thresholds: { ...p.thresholds, materialityRupees: Number(e.target.value) || 0 },
                }))
              }
              className="w-full px-2 py-1.5 border border-slate-300 rounded font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block font-bold text-slate-600 mb-1">Year-end window (days)</span>
            <input
              type="number"
              value={profile.thresholds.yearEndDays}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  thresholds: { ...p.thresholds, yearEndDays: Number(e.target.value) || 0 },
                }))
              }
              className="w-full px-2 py-1.5 border border-slate-300 rounded font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block font-bold text-slate-600 mb-1">Round-amount unit (₹)</span>
            <input
              type="number"
              value={profile.thresholds.roundAmountUnit}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  thresholds: { ...p.thresholds, roundAmountUnit: Number(e.target.value) || 0 },
                }))
              }
              className="w-full px-2 py-1.5 border border-slate-300 rounded font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block font-bold text-slate-600 mb-1">Annual turnover (₹)</span>
            <input
              type="number"
              value={profile.thresholds.annualTurnover}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  thresholds: { ...p.thresholds, annualTurnover: Number(e.target.value) || 0 },
                }))
              }
              className="w-full px-2 py-1.5 border border-slate-300 rounded font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block font-bold text-slate-600 mb-1">Sec 188 trigger %</span>
            <input
              type="number"
              value={profile.thresholds.section188TurnoverPct}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  thresholds: { ...p.thresholds, section188TurnoverPct: Number(e.target.value) || 0 },
                }))
              }
              className="w-full px-2 py-1.5 border border-slate-300 rounded font-mono"
            />
          </label>
        </div>
        <p className="text-[10px] text-slate-400 mt-2">
          Sec 188 trigger flags any party whose single AS-18 transaction-type total ≥ {profile.thresholds.section188TurnoverPct}% of annual turnover —
          requires shareholder approval per Companies Act 2013.
        </p>
      </div>
    </div>
  );
};

export default RelatedPartyAnalysis;
