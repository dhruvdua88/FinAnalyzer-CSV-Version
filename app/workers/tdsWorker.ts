/**
 * TDS Analysis Web Worker
 * Runs party-based threshold computation off the main thread so the UI
 * stays responsive for large datasets.
 *
 * Message in:  TDSWorkerInput
 * Message out: TDSWorkerOutput
 */

import type { TDSThresholdConfig, TDSSectionDef, TDSVoucherStatus } from '../types';
import { TDS_SECTION_DEFAULTS } from '../types';

// ── Shared lightweight types (copied here to keep the worker self-contained) ──

export interface TdsRawRow {
  voucher_number: string;
  date: string;
  voucher_type: string;
  expense_ledger: string;
  net_amount: number;       // signed (may be negative)
  party_name: string;
  narration: string;
  total_tds: number;        // absolute TDS amount for this voucher
  tds_ledger_names: string; // '||'-separated
}

export interface TDSVoucherDetail {
  voucher_key: string;
  date: string;
  voucher_type: string;
  voucher_number: string;
  party_name: string;
  expenseLedger: string;
  netAmount: number;
  tdsStatus: TDSVoucherStatus;
  tdsAmount: number;
  calculatedRate: number;    // actual applied rate %
  expectedRate: number | null;
  rateDeviation: number | null; // actual – expected (positive = over-deducted)
  shortfallAmount: number | null;
  sectionCode: string | null;
  partyYtdBefore: number;   // party's accumulated base BEFORE this voucher
  partyYtdAfter: number;    // party's accumulated base AFTER this voucher
  isThresholdCrossed: boolean; // true if this voucher is the one that crossed the annual limit
  tdsLedgers: string[];
  narration: string;
}

export interface TDSSummaryGroup {
  key: string;
  totalLedgerHit: number;
  totalBase: number;
  totalTDS: number;
  vouchers: TDSVoucherDetail[];
  complianceRate: number;
  avgAppliedRate: number;
  deductedCount: number;
  shortDeductedCount: number;
  missedCount: number;
  belowThresholdCount: number;
  partyYtdTotal: number;
}

export interface TDSWorkerFilters {
  viewMode: 'ledger' | 'party';
  minVoucherAmount: number;
  minLedgerAmount: number;
  statusFilter: 'all' | 'deducted' | 'short_deducted' | 'missed' | 'below_threshold';
  rateFilter: string; // 'all' or numeric string like '2'
}

export interface TDSWorkerInput {
  rows: TdsRawRow[];
  thresholdConfig: TDSThresholdConfig;
  filters: TDSWorkerFilters;
}

export interface TDSWorkerOutput {
  groups: TDSSummaryGroup[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const getSectionDef = (sectionCode: string | null): TDSSectionDef | null => {
  if (!sectionCode) return null;
  return TDS_SECTION_DEFAULTS.find((s) => s.code === sectionCode) ?? null;
};

const classifyStatus = (
  tdsAmount: number,
  expenseAmount: number,
  expectedRate: number | null,
  tdsApplicable: boolean,
): { status: TDSVoucherStatus; shortfall: number | null; rateDeviation: number | null } => {
  if (!tdsApplicable) {
    return { status: 'below_threshold', shortfall: null, rateDeviation: null };
  }
  if (tdsAmount <= 0) {
    return { status: 'missed', shortfall: null, rateDeviation: null };
  }
  const actualRate = expenseAmount > 0 ? (tdsAmount / expenseAmount) * 100 : 0;
  if (expectedRate !== null && expectedRate > 0) {
    const expectedAmt = (expectedRate / 100) * expenseAmount;
    const deviation = actualRate - expectedRate;
    if (tdsAmount < expectedAmt * 0.95) {
      return { status: 'short_deducted', shortfall: expectedAmt - tdsAmount, rateDeviation: deviation };
    }
    return { status: 'deducted', shortfall: null, rateDeviation: deviation };
  }
  return { status: 'deducted', shortfall: null, rateDeviation: null };
};

// ── Core computation ───────────────────────────────────────────────────────────

function computeTdsGroups(input: TDSWorkerInput): TDSSummaryGroup[] {
  const { rows, thresholdConfig, filters } = input;
  const { viewMode, minVoucherAmount, minLedgerAmount, statusFilter, rateFilter } = filters;
  const targetRate = rateFilter !== 'all' ? parseFloat(rateFilter) : null;

  // Build section mapping lookup: ledger → sectionCode
  const ledgerToSection = new Map<string, string>();
  if (thresholdConfig.enabled) {
    thresholdConfig.sectionMappings.forEach((m) => {
      if (m.ledger && m.sectionCode) ledgerToSection.set(m.ledger, m.sectionCode);
    });
  }

  // ── Step 1: group raw rows by voucher key ──────────────────────────────────
  // rows already have one row per (voucher × expense_ledger) from the SQL join,
  // but we need to group by party first for YTD tracking.

  // partyVouchers: party_name → sorted list of {date, voucherKey, expLedger, netAmt, tds, tdsLedgers}
  type VEntry = {
    voucher_number: string;
    date: string;
    voucher_type: string;
    expense_ledger: string;
    netAmount: number;
    total_tds: number;
    tds_ledger_names: string;
    narration: string;
    party_name: string;
    sectionCode: string | null;
    expectedRate: number | null;
  };

  const partyVoucherMap = new Map<string, VEntry[]>();

  rows.forEach((row) => {
    const absAmt = Math.abs(row.net_amount);
    if (absAmt < minVoucherAmount) return;

    const sectionCode = ledgerToSection.get(row.expense_ledger) ?? null;
    const sectionDef = getSectionDef(sectionCode);
    const expectedRate = sectionDef ? sectionDef.defaultRate : null;
    const party = row.party_name || row.expense_ledger || 'Unknown';

    const entry: VEntry = {
      voucher_number: row.voucher_number,
      date: row.date,
      voucher_type: row.voucher_type,
      expense_ledger: row.expense_ledger,
      netAmount: row.net_amount,
      total_tds: row.total_tds,
      tds_ledger_names: row.tds_ledger_names,
      narration: row.narration,
      party_name: party,
      sectionCode,
      expectedRate,
    };

    if (!partyVoucherMap.has(party)) partyVoucherMap.set(party, []);
    partyVoucherMap.get(party)!.push(entry);
  });

  // ── Step 2: party-level YTD accumulation + status classification ──────────
  const detailRows: TDSVoucherDetail[] = [];

  partyVoucherMap.forEach((entries, _party) => {
    // Sort by date ASC so YTD runs forward in time
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let ytd = 0;

    entries.forEach((e) => {
      const absExpense = Math.abs(e.netAmount);
      const ytdBefore = ytd;
      ytd += absExpense;
      const ytdAfter = ytd;

      let tdsApplicable = true;
      let isThresholdCrossed = false;

      if (thresholdConfig.enabled && e.sectionCode) {
        const def = getSectionDef(e.sectionCode);
        if (def && (def.singleTxnLimit > 0 || def.annualLimit > 0)) {
          const meetsPerTxn = def.singleTxnLimit <= 0 || absExpense >= def.singleTxnLimit;
          const meetsAnnual = def.annualLimit <= 0 || ytdAfter >= def.annualLimit;
          tdsApplicable = meetsPerTxn || meetsAnnual;
          // Mark if this specific voucher crossed the annual threshold
          if (meetsAnnual && ytdBefore < def.annualLimit && def.annualLimit > 0) {
            isThresholdCrossed = true;
          }
        }
      }

      const { status, shortfall, rateDeviation } = classifyStatus(
        e.total_tds,
        absExpense,
        e.expectedRate,
        tdsApplicable,
      );

      const actualRate = absExpense > 0 ? (e.total_tds / absExpense) * 100 : 0;
      const voucherKey = `${e.voucher_number}__${e.date}__${e.voucher_type}`;

      detailRows.push({
        voucher_key: voucherKey,
        date: e.date,
        voucher_type: e.voucher_type,
        voucher_number: e.voucher_number,
        party_name: e.party_name,
        expenseLedger: e.expense_ledger,
        netAmount: e.netAmount,
        tdsStatus: status,
        tdsAmount: e.total_tds,
        calculatedRate: Number(actualRate.toFixed(2)),
        expectedRate: e.expectedRate,
        rateDeviation: rateDeviation !== null ? Number(rateDeviation.toFixed(2)) : null,
        shortfallAmount: shortfall !== null ? Number(shortfall.toFixed(2)) : null,
        sectionCode: e.sectionCode,
        partyYtdBefore: Number(ytdBefore.toFixed(2)),
        partyYtdAfter: Number(ytdAfter.toFixed(2)),
        isThresholdCrossed,
        tdsLedgers: e.tds_ledger_names
          ? e.tds_ledger_names.split('||').filter(Boolean)
          : [],
        narration: e.narration,
      });
    });
  });

  // ── Step 3: apply view-level filters + group ───────────────────────────────
  const groupsMap = new Map<string, TDSSummaryGroup>();

  detailRows.forEach((v) => {
    // Status filter
    if (statusFilter !== 'all' && v.tdsStatus !== statusFilter) return;

    // Rate filter: only applicable when TDS was actually deducted
    if (targetRate !== null) {
      if (v.tdsAmount <= 0) return;
      if (Math.abs(v.calculatedRate - targetRate) > 0.5) return;
    }

    const groupKey = viewMode === 'ledger' ? v.expenseLedger : v.party_name;

    let g = groupsMap.get(groupKey);
    if (!g) {
      g = {
        key: groupKey,
        totalLedgerHit: 0,
        totalBase: 0,
        totalTDS: 0,
        vouchers: [],
        complianceRate: 0,
        avgAppliedRate: 0,
        deductedCount: 0,
        shortDeductedCount: 0,
        missedCount: 0,
        belowThresholdCount: 0,
        partyYtdTotal: 0,
      };
      groupsMap.set(groupKey, g);
    }

    g.totalLedgerHit += v.netAmount;
    g.totalBase += Math.abs(v.netAmount);
    g.totalTDS += v.tdsAmount;
    g.partyYtdTotal = Math.max(g.partyYtdTotal, v.partyYtdAfter);

    if (v.tdsStatus === 'deducted') g.deductedCount++;
    else if (v.tdsStatus === 'short_deducted') g.shortDeductedCount++;
    else if (v.tdsStatus === 'missed') g.missedCount++;
    else if (v.tdsStatus === 'below_threshold') g.belowThresholdCount++;

    g.vouchers.push(v);
  });

  return Array.from(groupsMap.values())
    .map((g) => {
      const applicableCount = g.deductedCount + g.shortDeductedCount + g.missedCount;
      return {
        ...g,
        complianceRate: applicableCount > 0 ? (g.deductedCount / applicableCount) * 100 : 100,
        avgAppliedRate:
          g.vouchers.length > 0
            ? g.vouchers.reduce((s, v) => s + v.calculatedRate, 0) / g.vouchers.length
            : 0,
      };
    })
    .filter((g) => Math.abs(g.totalLedgerHit) >= minLedgerAmount)
    .sort((a, b) => Math.abs(b.totalLedgerHit) - Math.abs(a.totalLedgerHit));
}

// ── Worker message handler ─────────────────────────────────────────────────────
self.addEventListener('message', (event: MessageEvent<TDSWorkerInput>) => {
  try {
    const groups = computeTdsGroups(event.data);
    self.postMessage({ groups } satisfies TDSWorkerOutput);
  } catch (err: any) {
    self.postMessage({ error: err?.message ?? 'Worker computation failed' });
  }
});
