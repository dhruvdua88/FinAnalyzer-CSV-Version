// Trial Balance — store-driven.
//
// Replaces the legacy 2-level (Primary → Parent → Ledger) TB with a full
// recursive tree built from mst_group, plus three new audit-grade checks:
//
//   • Section 1: 3-way balance check banner (Opening / During / Closing)
//   • Section 2: deep group hierarchy honouring mst_group.sort_position
//   • Section 3: per-ledger reconciliation (opening + during == master closing)
//   • Section 4: activity classification (dormant / active / new / closed)
//
// Data layer lives in services/tally/queries.ts (getTrialBalance). This
// component is pure presentation + filtering + Excel export.

import React, { useMemo, useState } from 'react';
import {
  Download, Search, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle2, XCircle, Activity, Info,
} from 'lucide-react';
import { LedgerEntry } from '../../types';
import {
  useTallyStore,
  getTrialBalance,
  type TrialBalanceResult,
  type TbGroupNode,
  type TbLedgerRow,
  type TbActivity,
  type TbBalanceCheck,
  type TbActivityCounts,
} from '../../services/tally';

interface TrialBalanceAnalysisProps {
  // Kept for backward compatibility with App.tsx prop wiring, but the new
  // module reads everything from the TallyStore (via context).
  data: LedgerEntry[];
}

type ActivityFilter = 'all' | TbActivity;

const ACTIVITY_BADGE: Record<TbActivity, { label: string; cls: string }> = {
  dormant:      { label: 'Dormant',      cls: 'bg-slate-100 text-slate-700 border-slate-300' },
  active:       { label: 'Active',       cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  new:          { label: 'New',          cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  closed:       { label: 'Closed',       cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  'never-used': { label: 'Never used',   cls: 'bg-slate-50 text-slate-400 border-slate-200' },
};

const formatINR = (n: number, opts?: { allowDash?: boolean }): string => {
  if ((opts?.allowDash ?? true) && Math.abs(n) < 0.005) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatDDMMYYYY = (iso: string): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

// Recursive filter helper. Returns a copy of the tree where each node only
// contains ledgers/sub-groups that match. A node with no matching descendants
// is dropped entirely.
const filterTree = (
  nodes: TbGroupNode[],
  predicate: (row: TbLedgerRow) => boolean,
): TbGroupNode[] => {
  const out: TbGroupNode[] = [];
  for (const node of nodes) {
    const childLedgers = node.childLedgers.filter(predicate);
    const childGroups = filterTree(node.childGroups, predicate);
    if (childLedgers.length === 0 && childGroups.length === 0) continue;
    // Rebuild rolled-up totals from kept children (so subtotals always reconcile)
    const filtered: TbGroupNode = {
      ...node,
      childLedgers,
      childGroups,
      openingDr: 0, openingCr: 0,
      duringDr: 0, duringCr: 0,
      closingDr: 0, closingCr: 0,
      ledgerCount: childLedgers.length + childGroups.reduce((s, g) => s + g.ledgerCount, 0),
    };
    for (const l of childLedgers) {
      filtered.openingDr += l.openingDr; filtered.openingCr += l.openingCr;
      filtered.duringDr  += l.duringDr;  filtered.duringCr  += l.duringCr;
      filtered.closingDr += l.closingDr; filtered.closingCr += l.closingCr;
    }
    for (const sg of childGroups) {
      filtered.openingDr += sg.openingDr; filtered.openingCr += sg.openingCr;
      filtered.duringDr  += sg.duringDr;  filtered.duringCr  += sg.duringCr;
      filtered.closingDr += sg.closingDr; filtered.closingCr += sg.closingCr;
    }
    out.push(filtered);
  }
  return out;
};

const TrialBalanceAnalysis: React.FC<TrialBalanceAnalysisProps> = () => {
  const store = useTallyStore();

  const [searchTerm, setSearchTerm] = useState('');
  const [primaryFilter, setPrimaryFilter] = useState<string>('all');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [reconFailOnly, setReconFailOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const tb = useMemo<TrialBalanceResult | null>(() => {
    if (!store) return null;
    return getTrialBalance(store);
  }, [store]);

  const primaries = useMemo<string[]>(
    () => (tb ? tb.tree.map((n) => n.name) : []),
    [tb],
  );

  const filteredTree = useMemo<TbGroupNode[]>(() => {
    if (!tb) return [];
    const q = searchTerm.trim().toLowerCase();
    const predicate = (row: TbLedgerRow): boolean => {
      if (activityFilter !== 'all' && row.activity !== activityFilter) return false;
      if (reconFailOnly && row.reconPass) return false;
      if (!q) return true;
      return (
        row.ledger.toLowerCase().includes(q) ||
        row.group.toLowerCase().includes(q) ||
        row.primaryGroup.toLowerCase().includes(q) ||
        row.gstin.toLowerCase().includes(q) ||
        row.pan.toLowerCase().includes(q)
      );
    };
    let tree = filterTree(tb.tree, predicate);
    if (primaryFilter !== 'all') tree = tree.filter((n) => n.name === primaryFilter);
    return tree;
  }, [tb, searchTerm, primaryFilter, activityFilter, reconFailOnly]);

  const toggleNode = (path: string) =>
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));

  const collapseAll = () => {
    if (!tb) return;
    const next: Record<string, boolean> = {};
    const walk = (nodes: TbGroupNode[], prefix: string) => {
      for (const n of nodes) {
        const path = prefix ? `${prefix}::${n.name}` : n.name;
        next[path] = true;
        walk(n.childGroups, path);
      }
    };
    walk(tb.tree, '');
    setCollapsed(next);
  };
  const expandAll = () => setCollapsed({});

  const handleExport = async () => {
    if (!tb) return;
    const XLSX = await import('xlsx-js-style');
    const aoa: any[][] = [];
    const periodLabel = tb.periodFrom && tb.periodTo ? `${formatDDMMYYYY(tb.periodFrom)} to ${formatDDMMYYYY(tb.periodTo)}` : 'All periods';

    aoa.push(['Trial Balance']);
    aoa.push([`Period: ${periodLabel}`]);
    aoa.push([`Generated: ${new Date().toLocaleString('en-IN')}`]);
    aoa.push([]);

    // Balance check
    aoa.push(['Balance Check', '', 'Dr', 'Cr', 'Delta', 'Status']);
    for (const [k, v] of [
      ['Opening', tb.balanceCheck.opening],
      ['During',  tb.balanceCheck.during],
      ['Closing', tb.balanceCheck.closing],
    ] as const) {
      aoa.push([k, '', v.dr, v.cr, v.delta, v.ok ? 'PASS' : 'REVIEW']);
    }
    aoa.push([]);

    // Activity counts
    aoa.push(['Activity Summary']);
    for (const [k, v] of Object.entries(tb.activityCounts)) aoa.push([k, '', v]);
    aoa.push([]);

    // Detail tree
    aoa.push(['Level', 'Group / Ledger', 'Activity', 'Recon', 'Opening Dr', 'Opening Cr', 'During Dr', 'During Cr', 'Closing Dr', 'Closing Cr']);
    const walk = (nodes: TbGroupNode[]) => {
      for (const n of nodes) {
        aoa.push([
          n.level === 0 ? 'PRIMARY' : `L${n.level}`,
          `${'  '.repeat(n.level)}${n.name}  (${n.ledgerCount})`,
          '', '',
          n.openingDr, n.openingCr, n.duringDr, n.duringCr, n.closingDr, n.closingCr,
        ]);
        walk(n.childGroups);
        for (const l of n.childLedgers) {
          aoa.push([
            `L${n.level + 1}`,
            `${'  '.repeat(n.level + 1)}${l.ledger}`,
            l.activity,
            l.reconPass ? 'PASS' : `FAIL Δ${l.reconDelta.toFixed(2)}`,
            l.openingDr, l.openingCr, l.duringDr, l.duringCr, l.closingDr, l.closingCr,
          ]);
        }
      }
    };
    walk(filteredTree);

    aoa.push([]);
    aoa.push([
      'GRAND TOTAL', '', '', '',
      tb.grandTotals.openingDr, tb.grandTotals.openingCr,
      tb.grandTotals.duringDr,  tb.grandTotals.duringCr,
      tb.grandTotals.closingDr, tb.grandTotals.closingCr,
    ]);

    if (tb.reconciliationFailures.length > 0) {
      aoa.push([]);
      aoa.push([`Reconciliation Failures (${tb.reconciliationFailures.length})`]);
      aoa.push(['Ledger', 'Group', 'Opening', 'During Net', 'Calc Closing', 'Master Closing', 'Delta']);
      for (const r of tb.reconciliationFailures) {
        aoa.push([r.ledger, r.group, r.openingSigned, r.duringNet, r.closingCalculated, r.closingSigned, r.reconDelta]);
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 40 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Trial Balance');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Trial_Balance_${stamp}.xlsx`, { compression: true, cellStyles: true });
  };

  // ── Empty / fallback states ────────────────────────────────────────────────
  if (!store) {
    return (
      <div className="bg-white border border-amber-200 rounded-2xl p-8 shadow-sm flex gap-4 items-start">
        <div className="shrink-0 w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
          <Info size={24} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">Tally Excel Export (ZIP) required</h2>
          <p className="text-sm text-slate-600 mt-1 leading-relaxed">
            The Trial Balance reads <code>mst_group</code>, <code>mst_ledger</code> and{' '}
            <code>trn_accounting</code> directly so it can run the balance-equation check, walk the
            full group hierarchy and reconcile every ledger to its master closing balance. Import
            via <strong>Import Tally Excel Export (ZIP)</strong> from the upload screen.
          </p>
        </div>
      </div>
    );
  }
  if (!tb) return null;

  return (
    <div className="space-y-5">
      {/* ── Section 1: Balance check banner ───────────────────────────── */}
      <BalanceCheckBanner check={tb.balanceCheck} period={[tb.periodFrom, tb.periodTo]} />

      {/* ── Section 4: Activity summary chips + recon chip ────────────── */}
      <SummaryChips
        counts={tb.activityCounts}
        active={activityFilter}
        onSelect={(a) => setActivityFilter(a === activityFilter ? 'all' : a)}
        reconFailures={tb.reconciliationFailures.length}
        reconActive={reconFailOnly}
        onReconToggle={() => setReconFailOnly((p) => !p)}
      />

      {/* ── Filter / search / export bar ──────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-3 shadow-sm">
        <div className="relative flex-1 min-w-[280px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search ledger, group, GSTIN, PAN…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
        </div>
        <select value={primaryFilter} onChange={(e) => setPrimaryFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none">
          <option value="all">All primary groups</option>
          {primaries.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={expandAll} className="px-3 py-2 text-xs font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">
          Expand all
        </button>
        <button onClick={collapseAll} className="px-3 py-2 text-xs font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">
          Collapse all
        </button>
        <button onClick={handleExport}
          className="ml-auto px-4 py-2 inline-flex items-center gap-2 text-sm font-bold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm">
          <Download size={15} />
          Export Excel
        </button>
      </div>

      {/* ── Section 2 + 3: Group tree with recon column ──────────────── */}
      {filteredTree.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-400 text-sm">
          No ledgers match the current filters.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTree.map((node) => (
            <GroupTreeNode
              key={node.name} node={node}
              collapsed={collapsed} onToggle={toggleNode} path={node.name}
            />
          ))}
        </div>
      )}

      {/* Grand total footer */}
      <div className="bg-slate-900 text-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-xs">
          <tbody>
            <tr className="font-bold">
              <td className="px-4 py-3 w-[280px]">GRAND TOTAL — All Filtered Groups</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatINR(tb.grandTotals.openingDr)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatINR(tb.grandTotals.openingCr)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatINR(tb.grandTotals.duringDr)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatINR(tb.grandTotals.duringCr)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatINR(tb.grandTotals.closingDr)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatINR(tb.grandTotals.closingCr)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Reconciliation failures detail (Section 3) */}
      {tb.reconciliationFailures.length > 0 && (
        <ReconFailuresPanel rows={tb.reconciliationFailures} />
      )}
    </div>
  );
};

// ─── Section 1: Balance Check Banner ──────────────────────────────────────────

const BalanceCheckBanner: React.FC<{ check: TbBalanceCheck; period: [string, string] }> = ({ check, period }) => {
  const allOk = check.opening.ok && check.during.ok && check.closing.ok;
  const periodLabel = period[0] && period[1] ? `${formatDDMMYYYY(period[0])} → ${formatDDMMYYYY(period[1])}` : 'All periods loaded';

  return (
    <div className={`rounded-2xl border-2 shadow-sm overflow-hidden ${allOk ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
      <div className={`px-5 py-3 flex items-center justify-between ${allOk ? 'bg-emerald-100' : 'bg-amber-100'}`}>
        <div className="flex items-center gap-3">
          {allOk ? <CheckCircle2 size={22} className="text-emerald-700" />
                 : <AlertTriangle size={22} className="text-amber-700" />}
          <div>
            <h3 className={`font-black text-sm ${allOk ? 'text-emerald-900' : 'text-amber-900'}`}>
              {allOk ? 'Trial Balance reconciles end-to-end' : 'Trial Balance has unbalanced sections — review below'}
            </h3>
            <p className={`text-[11px] ${allOk ? 'text-emerald-700' : 'text-amber-700'}`}>
              Period: {periodLabel} · Tolerance ₹{check.tolerance.toFixed(2)}
            </p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3">
        {(['opening', 'during', 'closing'] as const).map((k) => {
          const c = check[k];
          return (
            <div key={k} className={`p-4 border-t md:border-t-0 md:border-l first:md:border-l-0 border-slate-200 bg-white`}>
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{k}</p>
                {c.ok ? <CheckCircle2 size={14} className="text-emerald-600" />
                      : <XCircle size={14} className="text-red-600" />}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <p className="text-[10px] text-slate-400 font-semibold">Dr</p>
                  <p className="text-sm font-bold tabular-nums">{formatINR(c.dr, { allowDash: false })}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-400 font-semibold">Cr</p>
                  <p className="text-sm font-bold tabular-nums">{formatINR(c.cr, { allowDash: false })}</p>
                </div>
              </div>
              <p className={`text-[11px] mt-2 font-bold tabular-nums ${c.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                Δ {c.delta >= 0 ? '+' : ''}{formatINR(c.delta, { allowDash: false })}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Section 4: Activity + Recon summary chips ────────────────────────────────

const SummaryChips: React.FC<{
  counts: TbActivityCounts;
  active: ActivityFilter;
  onSelect: (a: ActivityFilter) => void;
  reconFailures: number;
  reconActive: boolean;
  onReconToggle: () => void;
}> = ({ counts, active, onSelect, reconFailures, reconActive, onReconToggle }) => {
  const items: Array<{ key: TbActivity | 'all'; label: string; n: number; cls: string }> = [
    { key: 'all',        label: 'All',        n: counts.dormant + counts.active + counts.new + counts.closed + counts['never-used'], cls: 'bg-slate-100 text-slate-700 border-slate-300' },
    { key: 'active',     label: 'Active',     n: counts.active,        cls: ACTIVITY_BADGE.active.cls },
    { key: 'new',        label: 'New',        n: counts.new,           cls: ACTIVITY_BADGE.new.cls },
    { key: 'dormant',    label: 'Dormant',    n: counts.dormant,       cls: ACTIVITY_BADGE.dormant.cls },
    { key: 'closed',     label: 'Closed',     n: counts.closed,        cls: ACTIVITY_BADGE.closed.cls },
    { key: 'never-used', label: 'Never used', n: counts['never-used'], cls: ACTIVITY_BADGE['never-used'].cls },
  ];

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-2 shadow-sm">
      <div className="flex items-center gap-1.5 mr-2 text-slate-500">
        <Activity size={14} />
        <span className="text-[11px] font-bold uppercase tracking-wider">Activity</span>
      </div>
      {items.map((i) => (
        <button key={i.key} onClick={() => onSelect(i.key as ActivityFilter)}
          className={`px-3 py-1.5 rounded-full border text-xs font-bold transition-all ${i.cls} ${active === i.key ? 'ring-2 ring-offset-1 ring-indigo-400' : 'opacity-80 hover:opacity-100'}`}>
          {i.label} · {i.n}
        </button>
      ))}
      <button onClick={onReconToggle}
        className={`ml-auto px-3 py-1.5 rounded-full border text-xs font-bold transition-all ${
          reconFailures === 0
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 opacity-80 cursor-default'
            : reconActive
              ? 'bg-red-600 text-white border-red-700'
              : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
        }`}
        disabled={reconFailures === 0}>
        {reconFailures === 0 ? '✓ Recon clean' : `⚠ ${reconFailures} recon failure${reconFailures === 1 ? '' : 's'}`}
      </button>
    </div>
  );
};

// ─── Section 2: Recursive group node ──────────────────────────────────────────

const GroupTreeNode: React.FC<{
  node: TbGroupNode;
  path: string;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
}> = ({ node, path, collapsed, onToggle }) => {
  const isCollapsed = collapsed[path] ?? (node.level >= 2); // auto-collapse deep nodes
  const hasChildren = node.childGroups.length > 0 || node.childLedgers.length > 0;

  const headerBg = node.level === 0
    ? 'bg-indigo-50 border-indigo-100'
    : node.level === 1
      ? 'bg-slate-100 border-slate-200'
      : 'bg-slate-50 border-slate-100';
  const headerText = node.level === 0 ? 'text-indigo-900 font-black' : 'text-slate-800 font-bold';
  const indent = node.level * 16;

  return (
    <div className={`rounded-lg border ${node.level === 0 ? 'border-slate-200 shadow-sm' : 'border-transparent'} overflow-hidden`}>
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${headerBg}`} style={{ paddingLeft: 12 + indent }}>
        <button onClick={() => onToggle(path)} className="flex items-center gap-1.5">
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className={`text-xs ${headerText}`}>{node.name}</span>
          {node.isReserved && <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">system</span>}
        </button>
        <span className="text-[10px] text-slate-500">
          {node.ledgerCount} ledger{node.ledgerCount === 1 ? '' : 's'}
          {node.childGroups.length > 0 && ` · ${node.childGroups.length} sub-group${node.childGroups.length === 1 ? '' : 's'}`}
        </span>
        <div className="ml-auto flex items-center gap-4 text-[11px] font-mono tabular-nums">
          <span title="Opening Dr / Cr">
            <span className="text-slate-500">Op</span>{' '}
            <span className="text-rose-600">{formatINR(node.openingDr)}</span>{' / '}
            <span className="text-emerald-600">{formatINR(node.openingCr)}</span>
          </span>
          <span title="During Dr / Cr">
            <span className="text-slate-500">Dur</span>{' '}
            <span className="text-rose-600">{formatINR(node.duringDr)}</span>{' / '}
            <span className="text-emerald-600">{formatINR(node.duringCr)}</span>
          </span>
          <span title="Closing Dr / Cr" className="font-bold">
            <span className="text-slate-500 font-semibold">Cl</span>{' '}
            <span className="text-rose-700">{formatINR(node.closingDr)}</span>{' / '}
            <span className="text-emerald-700">{formatINR(node.closingCr)}</span>
          </span>
        </div>
      </div>

      {!isCollapsed && hasChildren && (
        <div>
          {/* Sub-groups first (recursive) */}
          {node.childGroups.map((sg) => (
            <GroupTreeNode key={sg.name} node={sg} path={`${path}::${sg.name}`} collapsed={collapsed} onToggle={onToggle} />
          ))}

          {/* Ledger leaves */}
          {node.childLedgers.length > 0 && (
            <div className="overflow-x-auto bg-white">
              <table className="w-full text-xs">
                <thead className="text-slate-500 text-[10px] font-bold uppercase border-b border-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left" style={{ paddingLeft: 24 + indent }}>Ledger</th>
                    <th className="px-3 py-2 text-left">Activity</th>
                    <th className="px-3 py-2 text-left">Recon</th>
                    <th className="px-3 py-2 text-right">Opening Dr</th>
                    <th className="px-3 py-2 text-right">Opening Cr</th>
                    <th className="px-3 py-2 text-right">During Dr</th>
                    <th className="px-3 py-2 text-right">During Cr</th>
                    <th className="px-3 py-2 text-right">Closing Dr</th>
                    <th className="px-3 py-2 text-right">Closing Cr</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {node.childLedgers.map((row) => (
                    <LedgerRowView key={row.ledger} row={row} indent={indent} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const LedgerRowView: React.FC<{ row: TbLedgerRow; indent: number }> = ({ row, indent }) => {
  const badge = ACTIVITY_BADGE[row.activity];
  return (
    <tr className={`hover:bg-slate-50 ${row.activity === 'never-used' ? 'opacity-50' : ''}`}>
      <td className="px-4 py-2 font-medium text-slate-800" style={{ paddingLeft: 24 + indent }}>
        <div>{row.ledger}</div>
        {(row.gstin || row.pan) && (
          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
            {row.gstin && <span>GSTIN: {row.gstin}</span>}
            {row.gstin && row.pan && <span> · </span>}
            {row.pan && <span>PAN: {row.pan}</span>}
            {row.mailingState && <span> · {row.mailingState}</span>}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${badge.cls}`}>
          {badge.label}
        </span>
      </td>
      <td className="px-3 py-2">
        {row.reconPass
          ? <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700">
              <CheckCircle2 size={11} /> PASS
            </span>
          : <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700" title={`Calc closing ${row.closingCalculated.toFixed(2)} vs master ${row.closingSigned.toFixed(2)}`}>
              <XCircle size={11} /> FAIL Δ{row.reconDelta >= 0 ? '+' : ''}{row.reconDelta.toFixed(2)}
            </span>
        }
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatINR(row.openingDr)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatINR(row.openingCr)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-rose-600">{formatINR(row.duringDr)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{formatINR(row.duringCr)}</td>
      <td className="px-3 py-2 text-right tabular-nums font-bold">{formatINR(row.closingDr)}</td>
      <td className="px-3 py-2 text-right tabular-nums font-bold">{formatINR(row.closingCr)}</td>
    </tr>
  );
};

// ─── Section 3: Reconciliation failures detail panel ──────────────────────────

const ReconFailuresPanel: React.FC<{ rows: TbLedgerRow[] }> = ({ rows }) => (
  <details className="bg-red-50 border border-red-200 rounded-xl overflow-hidden" open>
    <summary className="px-4 py-3 cursor-pointer flex items-center gap-3">
      <AlertTriangle size={18} className="text-red-700" />
      <div>
        <p className="font-bold text-red-900 text-sm">{rows.length} ledger{rows.length === 1 ? '' : 's'} failed reconciliation</p>
        <p className="text-[11px] text-red-700">Opening + (Cr − Dr) does not equal master closing balance — investigate before signing off the TB.</p>
      </div>
    </summary>
    <div className="overflow-x-auto bg-white border-t border-red-200">
      <table className="w-full text-xs">
        <thead className="bg-red-50 text-red-700 font-bold text-[10px] uppercase">
          <tr>
            <th className="px-3 py-2 text-left">Ledger</th>
            <th className="px-3 py-2 text-left">Group</th>
            <th className="px-3 py-2 text-right">Opening (signed)</th>
            <th className="px-3 py-2 text-right">During Net</th>
            <th className="px-3 py-2 text-right">Calc Closing</th>
            <th className="px-3 py-2 text-right">Master Closing</th>
            <th className="px-3 py-2 text-right">Delta</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-red-100">
          {rows.map((r) => (
            <tr key={r.ledger}>
              <td className="px-3 py-2 font-medium">{r.ledger}</td>
              <td className="px-3 py-2 text-slate-600">{r.group}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.openingSigned.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.duringNet.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.closingCalculated.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.closingSigned.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td className="px-3 py-2 text-right tabular-nums font-bold text-red-700">
                {r.reconDelta >= 0 ? '+' : ''}{r.reconDelta.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </details>
);

export default TrialBalanceAnalysis;
