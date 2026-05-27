/**
 * Party Ledger Matrix — Web Worker
 *
 * Offloads the voucher-walk + bucket-apportionment compute from the main
 * thread so the UI stays jank-free when the user tags ledgers, changes the
 * primary group, or loads large TSFs.
 *
 * Produces the row-level aggregates shown in the table AND the per-voucher
 * detail rows used by the multi-sheet Excel exporter.
 */

import type { LedgerEntry } from '../types';
import { voucherKey } from '../services/tally/helpers';

// ── Types shared with the host component ─────────────────────────────────────

export type Bucket =
  | 'sales'
  | 'purchase'
  | 'expense'
  | 'tds'
  | 'gst'
  | 'rcm'
  | 'bank'
  | 'others';

export interface CounterLedgerStat {
  ledger: string;
  bucket: Bucket;
  amount: number;
  voucherCount: number;
}

export interface PartyRow {
  partyName: string;
  totalSales: number;
  totalPurchase: number;
  totalExpenses: number;
  tdsDeducted: number;
  tdsExpensePct: number | null;
  gstAmount: number;
  gstSalesExpensePct: number | null;
  rcmAmount: number;
  bankAmount: number;
  others: number;
  debitTotal: number;
  creditTotal: number;
  movementNet: number;
  netBalance: number;
  balanceGap: number;
  counterLedgers: CounterLedgerStat[];
  voucherCount: number;
  firstDate: string;
  lastDate: string;
  expenseLedgerList: string; // comma-separated top expense/purchase ledgers
}

export interface VoucherDetailRow {
  partyName: string;
  date: string;
  voucher_type: string;
  voucher_number: string;
  partyAmount: number; // signed: credit positive, debit negative (matches table convention)
  counterLedgersText: string; // "Ledger A: 1234.00 | Ledger B: 567.00"
  expenseAmount: number;
  salesAmount: number;
  purchaseAmount: number;
  tdsAmount: number;
  gstAmount: number;
  rcmAmount: number;
  bankAmount: number;
  othersAmount: number;
}

export interface PartyMatrixWorkerInput {
  txRows: LedgerEntry[];
  mstRows: LedgerEntry[];
  primary: string;
  tdsLedgers: string[];
  gstLedgers: string[];
  rcmLedgers: string[];
}

export interface PartyMatrixWorkerOutput {
  rows: PartyRow[];
  voucherDetails: VoucherDetailRow[];
  partyUniverseCount: number;
  unbalancedVoucherCount: number;
  error?: string;
}

// ── Helpers (self-contained: workers cannot share runtime imports) ───────────

const toNum = (v: any): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const norm = (v: any) => String(v || '').trim().toLowerCase();

const classifyPrimary = (e: LedgerEntry): Bucket | null => {
  const t = norm(e.TallyPrimary);
  if (t.includes('sale') || t.includes('income')) return 'sales';
  if (t.includes('purchase') || t.includes('inward')) return 'purchase';
  if (t.includes('expense')) return 'expense';
  return null;
};

const isBank = (e: LedgerEntry) => {
  const t = `${e.Ledger} ${e.TallyPrimary} ${e.TallyParent} ${e.Group}`.toLowerCase();
  return t.includes('bank');
};

// ── Core computation ─────────────────────────────────────────────────────────

export function compute(input: PartyMatrixWorkerInput): PartyMatrixWorkerOutput {
  const { txRows, mstRows, primary, tdsLedgers, gstLedgers, rcmLedgers } = input;

  if (!primary) {
    return { rows: [], voucherDetails: [], partyUniverseCount: 0, unbalancedVoucherCount: 0 };
  }

  const pNorm = norm(primary);
  const tdsSet = new Set(tdsLedgers);
  const gstSet = new Set(gstLedgers);
  const rcmSet = new Set(rcmLedgers);

  // Party universe + closing balance reference from both master + tx rows
  const parties = new Set<string>();
  const closeRef = new Map<string, number>();

  const scan = (r: LedgerEntry) => {
    if (norm(r.TallyPrimary) !== pNorm) return;
    const party = String(r.Ledger || '').trim();
    if (!party) return;
    parties.add(party);
    const c = toNum(r.closing_balance);
    if (!closeRef.has(party) || (closeRef.get(party) === 0 && c !== 0)) {
      closeRef.set(party, c);
    }
  };
  for (let i = 0; i < mstRows.length; i++) scan(mstRows[i]);
  for (let i = 0; i < txRows.length; i++) scan(txRows[i]);

  // Row accumulator + per-party counter-ledger map
  interface PartyAcc extends PartyRow {
    _counterMap: Map<string, { bucket: Bucket; amount: number; vouchers: Set<string> }>;
    _vouchers: Set<string>;
  }

  const rows = new Map<string, PartyAcc>();
  parties.forEach((party) => {
    rows.set(party, {
      partyName: party,
      totalSales: 0,
      totalPurchase: 0,
      totalExpenses: 0,
      tdsDeducted: 0,
      tdsExpensePct: null,
      gstAmount: 0,
      gstSalesExpensePct: null,
      rcmAmount: 0,
      bankAmount: 0,
      others: 0,
      debitTotal: 0,
      creditTotal: 0,
      movementNet: 0,
      netBalance: closeRef.get(party) ?? 0,
      balanceGap: 0,
      counterLedgers: [],
      voucherCount: 0,
      firstDate: '',
      lastDate: '',
      expenseLedgerList: '',
      _counterMap: new Map(),
      _vouchers: new Set(),
    });
  });

  // Index vouchers
  const vouchers = new Map<string, LedgerEntry[]>();
  for (let i = 0; i < txRows.length; i++) {
    const r = txRows[i];
    const k = voucherKey(r);
    let list = vouchers.get(k);
    if (!list) {
      list = [];
      vouchers.set(k, list);
    }
    list.push(r);
  }

  let unbalanced = 0;
  const voucherDetails: VoucherDetailRow[] = [];

  vouchers.forEach((entries) => {
    const vSum = entries.reduce((s, r) => s + toNum(r.amount), 0);
    if (Math.abs(vSum) > 0.01) unbalanced += 1;

    // Party-side entries (from the selected primary)
    const partyEntries: LedgerEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (norm(entries[i].TallyPrimary) === pNorm) partyEntries.push(entries[i]);
    }
    if (partyEntries.length === 0) return;

    const partySigned = new Map<string, number>();
    for (let i = 0; i < partyEntries.length; i++) {
      const e = partyEntries[i];
      const p = String(e.Ledger || '').trim();
      if (!p) continue;
      partySigned.set(p, (partySigned.get(p) || 0) + toNum(e.amount));
    }
    let absTotal = 0;
    partySigned.forEach((v) => {
      absTotal += Math.abs(v);
    });
    if (absTotal === 0) return;

    const partyGuids = new Set<string>();
    for (let i = 0; i < partyEntries.length; i++) partyGuids.add(partyEntries[i].guid);

    // Counterpart entries aggregated per-ledger for this voucher.
    //
    // Sign convention (preserved end-to-end so columns reconcile to the
    // underlying ledger movements):
    //   • Tally amount > 0  → debit  (asset / expense / purchase / bank inflow)
    //   • Tally amount < 0  → credit (liability / income / sales / bank outflow)
    //
    // Buckets and counter-ledger aggregates therefore carry the SIGN of
    // each entry. Sales bucket on a sales voucher = -10,000 (credit to
    // income); a sales return that day adds +10,000, netting to zero.
    // This means: sum_across_parties(totalSales) == net movement on the
    // sales-side ledgers for the period — which is what the user expects
    // when they reconcile the column total against the trial balance.
    //
    // The OLD behaviour (Math.abs before summing) silently treated returns
    // and credit notes as ADDITIONS to the bucket, breaking the reconcile.
    interface CounterAgg {
      ledger: string;
      bucket: Bucket;
      amount: number; // signed: + = debit-side accumulation, − = credit-side
    }
    const counterByLedger = new Map<string, CounterAgg>();
    const buckets: Record<Bucket, number> = {
      sales: 0,
      purchase: 0,
      expense: 0,
      tds: 0,
      gst: 0,
      rcm: 0,
      bank: 0,
      others: 0,
    };

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (partyGuids.has(e.guid)) continue;
      const amt = toNum(e.amount); // signed — see header note above
      if (amt === 0) continue;
      const ledger = String(e.Ledger || '').trim();
      let b: Bucket = 'others';
      if (tdsSet.has(ledger)) b = 'tds';
      else if (gstSet.has(ledger)) b = 'gst';
      else if (rcmSet.has(ledger)) b = 'rcm';
      else {
        const byPrimary = classifyPrimary(e);
        if (byPrimary) b = byPrimary;
        else if (isBank(e)) b = 'bank';
      }
      buckets[b] += amt;
      const existing = counterByLedger.get(ledger);
      if (existing) {
        existing.amount += amt;
      } else {
        counterByLedger.set(ledger, { ledger, bucket: b, amount: amt });
      }
    }

    // Sample voucher details (one row per party × voucher)
    const sample = partyEntries[0];
    const voucherDate = String(sample.date || '');
    const voucherType = String(sample.voucher_type || '');
    const voucherNumber = String(sample.voucher_number || '');
    const vk = voucherKey(sample); // computed once per voucher, reused below

    // Build counterpart label once per voucher. Sort by absolute magnitude
    // (sign-aware data, but the user reads "biggest legs first" intuitively).
    const counterLabel = Array.from(counterByLedger.values())
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .map((c) => `${c.ledger}: ${c.amount.toFixed(2)}`)
      .join(' | ');

    // Apportion to each party in the voucher by share of absolute flow
    partySigned.forEach((signedAmt, party) => {
      const row = rows.get(party);
      if (!row) return;
      const absFlow = Math.abs(signedAmt);
      const share = absFlow / absTotal;

      // Party row aggregates
      // NOTE: sign convention — party row `amount` in Tally is credit-positive
      // for creditors (liability) / debit-positive for debtors. We preserve the
      // table's "Credit positive / Debit negative" semantics.
      if (signedAmt < 0) row.debitTotal += absFlow;
      if (signedAmt > 0) row.creditTotal += absFlow;
      row.totalSales += share * buckets.sales;
      row.totalPurchase += share * buckets.purchase;
      row.totalExpenses += share * buckets.expense;
      row.tdsDeducted += share * buckets.tds;
      row.gstAmount += share * buckets.gst;
      row.rcmAmount += share * buckets.rcm;
      row.bankAmount += share * buckets.bank;
      row.others += share * buckets.others;

      // Counter-ledger stats (apportioned)
      counterByLedger.forEach((c) => {
        const key = c.ledger;
        let stat = row._counterMap.get(key);
        if (!stat) {
          stat = { bucket: c.bucket, amount: 0, vouchers: new Set() };
          row._counterMap.set(key, stat);
        }
        stat.amount += share * c.amount;
        stat.vouchers.add(vk);
      });

      // Voucher-level tracking
      if (!row._vouchers.has(vk)) {
        row._vouchers.add(vk);
        if (!row.firstDate || voucherDate < row.firstDate) row.firstDate = voucherDate;
        if (!row.lastDate || voucherDate > row.lastDate) row.lastDate = voucherDate;
      }

      // Voucher detail row (apportioned)
      voucherDetails.push({
        partyName: party,
        date: voucherDate,
        voucher_type: voucherType,
        voucher_number: voucherNumber,
        partyAmount: signedAmt,
        counterLedgersText: counterLabel,
        expenseAmount: share * buckets.expense,
        salesAmount: share * buckets.sales,
        purchaseAmount: share * buckets.purchase,
        tdsAmount: share * buckets.tds,
        gstAmount: share * buckets.gst,
        rcmAmount: share * buckets.rcm,
        bankAmount: share * buckets.bank,
        othersAmount: share * buckets.others,
      });
    });
  });

  // Finalize rows
  const out: PartyRow[] = [];
  rows.forEach((r) => {
    const movementNet = r.creditTotal - r.debitTotal;
    const netBalance = Number.isFinite(r.netBalance) ? r.netBalance : movementNet;
    // Ratios are reported as magnitudes (% positive). Bucket totals are
    // sign-preserved for reconciliation, so divide absolute values to
    // produce the figure auditors actually want to see.
    const tdsExpensePct = Math.abs(r.totalExpenses) > 0
      ? (Math.abs(r.tdsDeducted) / Math.abs(r.totalExpenses)) * 100
      : null;
    const gstDen = Math.abs(r.totalSales) + Math.abs(r.totalExpenses);
    const gstSalesExpensePct = gstDen > 0 ? (Math.abs(r.gstAmount) / gstDen) * 100 : null;

    const counterLedgers: CounterLedgerStat[] = Array.from(r._counterMap.entries())
      .map(([ledger, stat]) => ({
        ledger,
        bucket: stat.bucket,
        amount: stat.amount,
        voucherCount: stat.vouchers.size,
      }))
      // Sign-aware data — sort by magnitude so the "top counter ledgers"
      // list still surfaces the largest legs first regardless of side.
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const expenseList = counterLedgers
      .filter((c) => c.bucket === 'expense' || c.bucket === 'purchase')
      .slice(0, 6)
      .map((c) => c.ledger)
      .join(', ');

    out.push({
      partyName: r.partyName,
      totalSales: r.totalSales,
      totalPurchase: r.totalPurchase,
      totalExpenses: r.totalExpenses,
      tdsDeducted: r.tdsDeducted,
      tdsExpensePct,
      gstAmount: r.gstAmount,
      gstSalesExpensePct,
      rcmAmount: r.rcmAmount,
      bankAmount: r.bankAmount,
      others: r.others,
      debitTotal: r.debitTotal,
      creditTotal: r.creditTotal,
      movementNet,
      netBalance,
      balanceGap: netBalance - movementNet,
      counterLedgers,
      voucherCount: r._vouchers.size,
      firstDate: r.firstDate,
      lastDate: r.lastDate,
      expenseLedgerList: expenseList,
    });
  });

  out.sort((a, b) => a.partyName.localeCompare(b.partyName));

  return {
    rows: out,
    voucherDetails,
    partyUniverseCount: parties.size,
    unbalancedVoucherCount: unbalanced,
  };
}

// ── Worker message handler ───────────────────────────────────────────────────

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  self.addEventListener('message', (event: MessageEvent<PartyMatrixWorkerInput>) => {
    try {
      const result = compute(event.data);
      (self as any).postMessage(result);
    } catch (err: any) {
      (self as any).postMessage({
        rows: [],
        voucherDetails: [],
        partyUniverseCount: 0,
        unbalancedVoucherCount: 0,
        error: err?.message ?? 'Party Matrix worker failed',
      } satisfies PartyMatrixWorkerOutput);
    }
  });
}
