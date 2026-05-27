/**
 * Related Party (AS-18) analytics worker.
 *
 * Off-main-thread aggregation that produces the data the Related Party
 * Analysis module needs to render and to export the AS-18 disclosure note.
 *
 * Consumes: the audit dataset (LedgerEntry[]) + a profile that tells the
 * worker which parties are related and how each ledger should be classified
 * under AS-18 paragraph 23.
 *
 * Produces:
 *   - parties[]            One row per tagged related party with totals,
 *                          year-end balances, transaction-type breakdown,
 *                          and audit flags.
 *   - transactions[]       One row per voucher slice that hit a tagged
 *                          party — the source-of-truth for the "Material
 *                          transactions" sheet of the export.
 *   - matrix               relationship × tx-type → amount. This is the
 *                          AS-18 disclosure table that goes into the note.
 *   - outstandingMatrix    relationship → {receivable, payable}. Year-end
 *                          balances grouped by category.
 *   - totals
 *
 * Workers can't share runtime imports with the host app, so AS-18
 * relationship/tx-type definitions are duplicated here as plain string
 * literal unions. Keep these in lockstep with types.ts.
 */

import type { LedgerEntry } from '../types';

// ── Shared types (duplicated string unions for worker isolation) ─────────────

export type RPRelationshipCategory =
  | 'holding'
  | 'subsidiary'
  | 'fellow-subsidiary'
  | 'associate-jv'
  | 'kmp'
  | 'kmp-relative'
  | 'kmp-enterprise'
  | 'individual-significant-influence'
  | 'other-rp';

export type RPTransactionType =
  | 'sale-goods'
  | 'sale-services'
  | 'purchase-goods'
  | 'purchase-services'
  | 'rendering-services'
  | 'receiving-services'
  | 'agency-arrangements'
  | 'leasing-hire-purchase'
  | 'rd-transfer'
  | 'license-agreements'
  | 'finance-given'
  | 'finance-received'
  | 'interest-paid'
  | 'interest-received'
  | 'rent-paid'
  | 'rent-received'
  | 'remuneration'
  | 'reimbursement'
  | 'guarantees-given'
  | 'guarantees-received'
  | 'management-contracts'
  | 'dividend-paid'
  | 'dividend-received'
  | 'other';

export interface RPPartyTag {
  category: RPRelationshipCategory;
  notes?: string;
  isMaterial?: boolean;
}

export interface RPThresholds {
  materialityRupees: number;
  yearEndDays: number;
  roundAmountUnit: number;
  section188TurnoverPct: number;
  annualTurnover: number;
}

export interface RPCounterLedgerStat {
  ledger: string;
  amount: number;          // signed: +ve = ledger amount on credit side of voucher
  voucherCount: number;
  txType: RPTransactionType;
}

export interface RPTransactionDetail {
  partyName: string;
  date: string;            // ISO yyyy-mm-dd
  voucher_type: string;
  voucher_number: string;
  invoice_number: string;
  // Net amount on the party ledger, signed.
  // +ve = credit (party amount due to us / liability cleared); -ve = debit.
  partyAmount: number;
  // Dominant counter-ledger (the largest non-party leg by absolute amount).
  primaryCounterLedger: string;
  primaryCounterAmount: number;
  // All counter-ledgers + their share, used by the detail drill-down.
  counterLedgers: { ledger: string; amount: number }[];
  // AS-18 classification — auto-derived unless user override pinned it.
  txType: RPTransactionType;
  txTypeAuto: boolean;
  narration: string;

  // Audit flags
  isYearEnd: boolean;       // within thresholds.yearEndDays of dataset max
  isRoundAmount: boolean;
  isHighValue: boolean;     // |partyAmount| >= materialityRupees
  isJournalVoucher: boolean;
  flagNotes: string[];
}

export interface RPPartyRow {
  partyName: string;
  category: RPRelationshipCategory;
  relationshipNotes: string;

  opening: number;
  closing: number;
  // Sum of party-amount across all transactions (signed).
  movementNet: number;
  // closing - (opening + movementNet). Should be 0 if books are clean.
  balanceGap: number;

  totalDebits: number;      // |sum of -ve partyAmounts|  (purchases / payments)
  totalCredits: number;     // sum of +ve partyAmounts    (sales / receipts)
  totalVolume: number;      // totalDebits + totalCredits

  txByType: Partial<Record<RPTransactionType, number>>; // amount sum, absolute

  voucherCount: number;
  firstDate: string;
  lastDate: string;

  // Audit metrics
  yearEndConcentrationPct: number;  // % of |volume| in last yearEndDays
  highestSingleTx: number;
  unusualTxCount: number;

  // Section 188 awareness — derived from txByType totals + thresholds.
  needsBoardApproval: boolean;       // any RP txn → board minutes expected
  needsShareholderApproval: boolean; // crosses Sec 188 percent threshold
}

export interface RelatedPartyWorkerInput {
  txRows: LedgerEntry[];
  mstRows: LedgerEntry[];
  parties: Record<string, RPPartyTag>;
  ledgerTxType: Record<string, RPTransactionType>;
  thresholds: RPThresholds;
}

export interface RelatedPartyWorkerOutput {
  parties: RPPartyRow[];
  transactions: RPTransactionDetail[];

  // Disclosure matrix: relationship → tx-type → absolute amount.
  // Only categories with at least one tagged party appear as outer keys.
  matrix: Partial<Record<RPRelationshipCategory, Partial<Record<RPTransactionType, number>>>>;

  // Outstanding balances grouped by relationship category (closing balances).
  outstandingMatrix: Partial<Record<RPRelationshipCategory, { receivable: number; payable: number }>>;

  totalRPTVolume: number;
  totalRPTPartyCount: number;
  partyUniverseCount: number;        // master-ledger universe scanned
  unbalancedVoucherCount: number;
  error?: string;
}

// ── Helpers (worker-local; no imports beyond types) ──────────────────────────

const toNum = (v: any): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const norm = (v: any): string => String(v || '').trim().toLowerCase();

const voucherKey = (e: LedgerEntry): string =>
  `${e.voucher_number || ''}|${e.date || ''}|${e.voucher_type || ''}`;

const isJournalVoucher = (vt: string): boolean => {
  const t = norm(vt);
  return t === 'journal' || t.includes('journal') || t === 'jv';
};

// Heuristic: classify a single counter-ledger into an AS-18 transaction type
// based on its name + group + voucher type + sign of the party amount.
//
// We deliberately keep this conservative — when the signal is weak we fall
// back to 'other'. The user can pin a definitive type per-ledger via the
// profile's `ledgerTxType` map and that always wins (handled by caller).
const classifyByLedgerName = (
  ledger: string,
  group: string,
  primary: string,
  voucherType: string,
  partyAmountSign: 1 | -1
): RPTransactionType => {
  const l = norm(ledger);
  const g = norm(group);
  const p = norm(primary);
  const vt = norm(voucherType);

  // Compensation / remuneration — strongest signal first
  if (
    /\b(director.*remuneration|managerial remuneration|salary|salaries|wages|bonus|commission to (director|kmp)|sitting fee)\b/.test(l)
  ) {
    return 'remuneration';
  }

  // Interest
  if (/\binterest (paid|on (loan|borrowing|debenture|deposit))\b/.test(l)) return 'interest-paid';
  if (/\binterest (income|received|earned)\b/.test(l)) return 'interest-received';
  if (/\binterest\b/.test(l)) {
    // sign-based fallback: party is creditor (-ve = we paid them) → interest-paid
    return partyAmountSign < 0 ? 'interest-paid' : 'interest-received';
  }

  // Rent
  if (/\brent (paid|expense|on building|on premises)\b/.test(l)) return 'rent-paid';
  if (/\brent (income|received|recovery)\b/.test(l)) return 'rent-received';
  if (/\brent\b/.test(l)) return partyAmountSign < 0 ? 'rent-paid' : 'rent-received';

  // Sales (income side)
  if (/\bsale(s)? (of services|service|consultancy|professional)\b/.test(l)) return 'sale-services';
  if (/\bservice (income|fee|charges)\b/.test(l)) return 'sale-services';
  if (/\bsales?\b/.test(l) || /\brevenue\b/.test(l) || p === 'income' || g.includes('sales accounts'))
    return 'sale-goods';

  // Purchase (expense side)
  if (/\bpurchase (of services|service|consultancy|professional fees)\b/.test(l)) return 'purchase-services';
  if (/\bprofessional (fee|charges|services)\b/.test(l)) return 'receiving-services';
  if (/\bpurchases?\b/.test(l) || g.includes('purchase accounts')) return 'purchase-goods';

  // Loans / finance
  if (/\bloan (given|advance)\b/.test(l) || /loans? & advances/.test(l)) return 'finance-given';
  if (/\bloan (taken|received|from)\b/.test(l) || /unsecured loan/.test(l) || /borrowing/.test(l))
    return 'finance-received';
  if (g.includes('loans (liability)') || g.includes('unsecured loan')) return 'finance-received';
  if (g.includes('loans & advances')) return 'finance-given';

  // Investments / dividends
  if (/\bdividend (paid|distributed)\b/.test(l)) return 'dividend-paid';
  if (/\bdividend (income|received)\b/.test(l)) return 'dividend-received';

  // Reimbursement
  if (/\b(reimbursement|reimburse|out of pocket|opex recovery)\b/.test(l)) return 'reimbursement';

  // Royalty / licence
  if (/\b(royalty|licen[cs]e fee)\b/.test(l)) return 'license-agreements';

  // Lease / hire purchase
  if (/\b(lease|hire purchase)\b/.test(l)) return 'leasing-hire-purchase';

  // Management contracts (deputation, secondment)
  if (/\b(management (fee|charges)|deputation|secondment)\b/.test(l)) return 'management-contracts';

  // Voucher-type fallback when ledger name is generic
  if (vt === 'sales' || vt === 'sales order') return 'sale-goods';
  if (vt === 'purchase' || vt === 'purchase order') return 'purchase-goods';
  if (vt === 'receipt') {
    return partyAmountSign < 0 ? 'finance-received' : 'other';
  }
  if (vt === 'payment') {
    return partyAmountSign > 0 ? 'finance-given' : 'other';
  }

  return 'other';
};

// Reverse map: tx-type label per the AS-18 standard. Used by the host
// component for human-readable labels in the matrix and the export.
export const TX_TYPE_LABEL: Record<RPTransactionType, string> = {
  'sale-goods': 'Sale of goods',
  'sale-services': 'Sale of services',
  'purchase-goods': 'Purchase of goods',
  'purchase-services': 'Purchase of services',
  'rendering-services': 'Rendering of services',
  'receiving-services': 'Receiving of services',
  'agency-arrangements': 'Agency arrangements',
  'leasing-hire-purchase': 'Leasing / hire purchase',
  'rd-transfer': 'Transfer of research & development',
  'license-agreements': 'Licence / royalty arrangements',
  'finance-given': 'Finance — loans / equity given',
  'finance-received': 'Finance — loans / equity received',
  'interest-paid': 'Interest paid',
  'interest-received': 'Interest received',
  'rent-paid': 'Rent paid',
  'rent-received': 'Rent received',
  'remuneration': 'Remuneration to KMP / Directors',
  'reimbursement': 'Reimbursement of expenses',
  'guarantees-given': 'Guarantees / collaterals given',
  'guarantees-received': 'Guarantees / collaterals received',
  'management-contracts': 'Management contracts (incl. deputation)',
  'dividend-paid': 'Dividend paid',
  'dividend-received': 'Dividend received',
  'other': 'Other',
};

export const RELATIONSHIP_LABEL: Record<RPRelationshipCategory, string> = {
  'holding': 'Holding company',
  'subsidiary': 'Subsidiary',
  'fellow-subsidiary': 'Fellow subsidiary',
  'associate-jv': 'Associate / Joint venture',
  'kmp': 'Key Managerial Personnel',
  'kmp-relative': 'Relative of KMP',
  'kmp-enterprise': 'Enterprise where KMP has significant influence',
  'individual-significant-influence': 'Individual with control / SI',
  'other-rp': 'Other related parties',
};

// Order used by the matrix renderer.
export const RELATIONSHIP_ORDER: RPRelationshipCategory[] = [
  'holding',
  'subsidiary',
  'fellow-subsidiary',
  'associate-jv',
  'kmp',
  'kmp-relative',
  'kmp-enterprise',
  'individual-significant-influence',
  'other-rp',
];

// ── Core compute ─────────────────────────────────────────────────────────────

const compute = (input: RelatedPartyWorkerInput): RelatedPartyWorkerOutput => {
  const { txRows, mstRows, parties, ledgerTxType, thresholds } = input;
  const partyKeys = Object.keys(parties);
  const tagged = new Set(partyKeys);

  // Empty profile? Return a clean empty output so the host component can
  // render the "tag your parties" empty state without branching.
  if (tagged.size === 0) {
    return {
      parties: [],
      transactions: [],
      matrix: {},
      outstandingMatrix: {},
      totalRPTVolume: 0,
      totalRPTPartyCount: 0,
      partyUniverseCount: mstRows.length,
      unbalancedVoucherCount: 0,
    };
  }

  // Group transaction rows by voucher key so we can compute per-voucher
  // counter-ledger breakdowns.
  const byVoucher = new Map<string, LedgerEntry[]>();
  for (const r of txRows) {
    if (toNum(r?.is_master_ledger) === 1) continue;
    const k = voucherKey(r);
    let arr = byVoucher.get(k);
    if (!arr) {
      arr = [];
      byVoucher.set(k, arr);
    }
    arr.push(r);
  }

  // Determine dataset year-end for "year-end concentration" + flag.
  let datasetMaxDate = '';
  for (const r of txRows) {
    const d = String(r?.date || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > datasetMaxDate) datasetMaxDate = d;
  }
  const yearEndCutoffMs = datasetMaxDate
    ? new Date(datasetMaxDate).getTime() - thresholds.yearEndDays * 86400000
    : 0;

  const partyAccum = new Map<string, RPPartyRow>();
  // Seed accumulators for all tagged parties (so even zero-activity
  // parties still appear in the disclosure with their relationship).
  for (const partyName of partyKeys) {
    const tag = parties[partyName];
    partyAccum.set(partyName, {
      partyName,
      category: tag.category,
      relationshipNotes: tag.notes || '',
      opening: 0,
      closing: 0,
      movementNet: 0,
      balanceGap: 0,
      totalDebits: 0,
      totalCredits: 0,
      totalVolume: 0,
      txByType: {},
      voucherCount: 0,
      firstDate: '',
      lastDate: '',
      yearEndConcentrationPct: 0,
      highestSingleTx: 0,
      unusualTxCount: 0,
      needsBoardApproval: false,
      needsShareholderApproval: false,
    });
  }

  // Pull opening/closing balances from the master ledger rows.
  for (const m of mstRows) {
    const lname = String(m?.Ledger || m?.ledger || '');
    if (!tagged.has(lname)) continue;
    const acc = partyAccum.get(lname);
    if (!acc) continue;
    acc.opening = toNum(m?.opening_balance);
    acc.closing = toNum(m?.closing_balance);
  }

  const transactions: RPTransactionDetail[] = [];
  const yearEndVolumeByParty = new Map<string, number>();
  let unbalancedVoucherCount = 0;

  // Walk each voucher; for any voucher that hit a tagged party, build a
  // detail row with the chosen primary counter-ledger and AS-18 type.
  byVoucher.forEach((entries, vk) => {
    // Sum-check: a voucher should net to zero. If not, flag the voucher.
    let voucherSum = 0;
    for (const e of entries) voucherSum += toNum(e?.amount);
    if (Math.abs(voucherSum) > 1) unbalancedVoucherCount++;

    // Identify which (if any) entries hit a tagged party. A voucher could
    // touch multiple tagged parties — we emit one detail row per party.
    const partyEntriesByName = new Map<string, LedgerEntry[]>();
    for (const e of entries) {
      const lname = String(e?.Ledger || e?.ledger || '');
      if (tagged.has(lname)) {
        let arr = partyEntriesByName.get(lname);
        if (!arr) {
          arr = [];
          partyEntriesByName.set(lname, arr);
        }
        arr.push(e);
      }
    }
    if (partyEntriesByName.size === 0) return;

    // Counter-ledgers = entries whose ledger is NOT a tagged party.
    const counterEntries = entries.filter((e) => {
      const lname = String(e?.Ledger || e?.ledger || '');
      return !tagged.has(lname);
    });

    partyEntriesByName.forEach((partyEntries, partyName) => {
      const partyAmount = partyEntries.reduce((s, e) => s + toNum(e?.amount), 0);
      const sample = partyEntries[0];
      const date = String(sample?.date || '');
      const vt = String(sample?.voucher_type || '');
      const vn = String(sample?.voucher_number || '');
      const inv = String(sample?.invoice_number || '');
      const narration = String(sample?.narration || '');

      // Pick the primary counter-ledger: the non-party leg with the largest
      // absolute amount on the opposite sign of the party leg.
      const counterAggByLedger = new Map<string, number>();
      for (const e of counterEntries) {
        const lname = String(e?.Ledger || e?.ledger || '');
        counterAggByLedger.set(lname, (counterAggByLedger.get(lname) || 0) + toNum(e?.amount));
      }
      let primaryCounterLedger = '';
      let primaryCounterAmount = 0;
      let bestAbs = -1;
      counterAggByLedger.forEach((amt, lname) => {
        if (Math.abs(amt) > bestAbs) {
          bestAbs = Math.abs(amt);
          primaryCounterLedger = lname;
          primaryCounterAmount = amt;
        }
      });

      // Classify this transaction. User pin (ledgerTxType[primary]) wins;
      // else fall back to heuristics.
      let txType: RPTransactionType;
      let txTypeAuto = true;
      if (primaryCounterLedger && ledgerTxType[primaryCounterLedger]) {
        txType = ledgerTxType[primaryCounterLedger];
        txTypeAuto = false;
      } else {
        // Find the master row of the primary counter-ledger to read group/primary.
        const counterMaster = mstRows.find(
          (m) => String(m?.Ledger || m?.ledger || '') === primaryCounterLedger
        );
        const cgroup = String(counterMaster?.Group || counterMaster?.group_name || '');
        const cprimary = String(counterMaster?.TallyPrimary || counterMaster?.tally_primary || '');
        const sign: 1 | -1 = partyAmount >= 0 ? 1 : -1;
        txType = classifyByLedgerName(primaryCounterLedger, cgroup, cprimary, vt, sign);
      }

      // Audit flags
      const isYearEnd = !!date && datasetMaxDate
        ? new Date(date).getTime() >= yearEndCutoffMs
        : false;
      const absAmt = Math.abs(partyAmount);
      const isRoundAmount =
        thresholds.roundAmountUnit > 0 && absAmt > 0 && absAmt % thresholds.roundAmountUnit === 0;
      const isHighValue = absAmt >= thresholds.materialityRupees;
      const isJV = isJournalVoucher(vt);
      const flagNotes: string[] = [];
      if (isYearEnd) flagNotes.push('Year-end');
      if (isRoundAmount) flagNotes.push('Round amount');
      if (isHighValue) flagNotes.push('Material');
      if (isJV) flagNotes.push('Journal voucher');

      transactions.push({
        partyName,
        date,
        voucher_type: vt,
        voucher_number: vn,
        invoice_number: inv,
        partyAmount,
        primaryCounterLedger,
        primaryCounterAmount,
        counterLedgers: Array.from(counterAggByLedger.entries()).map(([ledger, amount]) => ({
          ledger,
          amount,
        })),
        txType,
        txTypeAuto,
        narration,
        isYearEnd,
        isRoundAmount,
        isHighValue,
        isJournalVoucher: isJV,
        flagNotes,
      });

      // Accumulate per-party stats
      const acc = partyAccum.get(partyName)!;
      acc.movementNet += partyAmount;
      if (partyAmount > 0) acc.totalCredits += partyAmount;
      else acc.totalDebits += Math.abs(partyAmount);
      acc.totalVolume = acc.totalDebits + acc.totalCredits;
      acc.voucherCount += 1;
      acc.txByType[txType] = (acc.txByType[txType] || 0) + absAmt;
      if (absAmt > acc.highestSingleTx) acc.highestSingleTx = absAmt;
      if (flagNotes.length > 0 && (isHighValue || isRoundAmount || isYearEnd || isJV)) {
        acc.unusualTxCount += 1;
      }
      if (!acc.firstDate || (date && date < acc.firstDate)) acc.firstDate = date;
      if (!acc.lastDate || (date && date > acc.lastDate)) acc.lastDate = date;
      if (isYearEnd) {
        yearEndVolumeByParty.set(partyName, (yearEndVolumeByParty.get(partyName) || 0) + absAmt);
      }
    });
  });

  // Finalise per-party fields
  partyAccum.forEach((acc) => {
    acc.balanceGap = acc.closing - (acc.opening + acc.movementNet);
    const yeVol = yearEndVolumeByParty.get(acc.partyName) || 0;
    acc.yearEndConcentrationPct = acc.totalVolume > 0 ? (yeVol / acc.totalVolume) * 100 : 0;

    // Section 188 / Companies Act 2013 awareness:
    //   - Any transaction with an RP needs a board minute → board approval
    //     required if there's any volume.
    //   - Shareholder approval is required if any single category of
    //     transactions crosses the prescribed % of turnover. We use
    //     `section188TurnoverPct` as a proxy threshold (default 10%).
    acc.needsBoardApproval = acc.totalVolume > 0;
    if (thresholds.annualTurnover > 0 && thresholds.section188TurnoverPct > 0) {
      const limit = thresholds.annualTurnover * (thresholds.section188TurnoverPct / 100);
      acc.needsShareholderApproval = Object.values(acc.txByType).some(
        (v) => (v || 0) >= limit
      );
    }
  });

  // Build the disclosure matrix
  const matrix: Partial<Record<RPRelationshipCategory, Partial<Record<RPTransactionType, number>>>> = {};
  const outstandingMatrix: Partial<Record<RPRelationshipCategory, { receivable: number; payable: number }>> = {};
  partyAccum.forEach((acc) => {
    const cat = acc.category;
    if (!matrix[cat]) matrix[cat] = {};
    const cell = matrix[cat]!;
    Object.entries(acc.txByType).forEach(([txType, amt]) => {
      cell[txType as RPTransactionType] =
        (cell[txType as RPTransactionType] || 0) + (amt || 0);
    });

    if (!outstandingMatrix[cat]) outstandingMatrix[cat] = { receivable: 0, payable: 0 };
    const ob = outstandingMatrix[cat]!;
    if (acc.closing > 0) ob.receivable += acc.closing;        // Dr balance — receivable from RP
    else if (acc.closing < 0) ob.payable += Math.abs(acc.closing); // Cr balance — payable to RP
  });

  const partiesList = Array.from(partyAccum.values()).sort((a, b) => {
    // Sort by relationship order, then by absolute volume desc within each.
    const aIdx = RELATIONSHIP_ORDER.indexOf(a.category);
    const bIdx = RELATIONSHIP_ORDER.indexOf(b.category);
    if (aIdx !== bIdx) return aIdx - bIdx;
    return b.totalVolume - a.totalVolume;
  });

  const totalRPTVolume = partiesList.reduce((s, p) => s + p.totalVolume, 0);

  return {
    parties: partiesList,
    transactions: transactions.sort((a, b) => {
      if (a.partyName !== b.partyName) return a.partyName.localeCompare(b.partyName);
      return a.date.localeCompare(b.date);
    }),
    matrix,
    outstandingMatrix,
    totalRPTVolume,
    totalRPTPartyCount: partiesList.length,
    partyUniverseCount: mstRows.length,
    unbalancedVoucherCount,
  };
};

// ── Worker entry ─────────────────────────────────────────────────────────────

self.addEventListener('message', (event: MessageEvent<RelatedPartyWorkerInput>) => {
  try {
    const result = compute(event.data);
    (self as any).postMessage(result);
  } catch (err: any) {
    (self as any).postMessage({
      parties: [],
      transactions: [],
      matrix: {},
      outstandingMatrix: {},
      totalRPTVolume: 0,
      totalRPTPartyCount: 0,
      partyUniverseCount: 0,
      unbalancedVoucherCount: 0,
      error: err?.message || String(err),
    } as RelatedPartyWorkerOutput);
  }
});
