// FIFO ageing for Trade Receivables (Sundry Debtors) and Trade Payables
// (Sundry Creditors). Ported from the DebtorAgeingFIFO / CreditorAgeingFIFO
// modules so the Schedule III notes age consistently with those screens.
//
// Method: per party, walk dated entries oldest-first. An "invoice" opens a
// layer; a "payment" consumes the oldest open layers (FIFO). Unapplied payments
// become an advance. Remaining open layers are aged by their own date vs the
// as-of date and bucketed.
//
// Sign convention (LedgerEntry.amount): negative = debit, positive = credit.
//   Debtor:   invoice = debit (amount < 0), payment = credit (amount > 0)
//   Creditor: invoice = credit (amount > 0), payment = debit (amount < 0)

import { LedgerEntry } from '../types';

export type AgeingSide = 'debtor' | 'creditor';

export const AGE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '0-30', min: 0, max: 30 },
  { label: '31-60', min: 31, max: 60 },
  { label: '61-90', min: 61, max: 90 },
  { label: '91-180', min: 91, max: 180 },
  { label: '181-365', min: 181, max: 365 },
  { label: '>365', min: 366, max: Number.MAX_SAFE_INTEGER },
];
export const BUCKET_LABELS = AGE_BUCKETS.map((b) => b.label);

const computeBucket = (ageDays: number): string => {
  for (const b of AGE_BUCKETS) if (ageDays >= b.min && ageDays <= b.max) return b.label;
  return '>365';
};
const initBuckets = (): Record<string, number> =>
  AGE_BUCKETS.reduce((a, b) => ((a[b.label] = 0), a), {} as Record<string, number>);

const toNumber = (v: any): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const isSide = (e: LedgerEntry, side: AgeingSide): boolean => {
  const kw = side === 'debtor' ? 'sundry debtor' : 'sundry creditor';
  return (
    String((e as any).TallyPrimary || '').toLowerCase().includes(kw) ||
    String((e as any).TallyParent || '').toLowerCase().includes(kw)
  );
};

export interface PartyAgeingRow {
  party: string;
  branch?: string;
  outstanding: number;
  advance: number;
  buckets: Record<string, number>;
}

export interface AgeingResult {
  side: AgeingSide;
  asOfIso: string;
  parties: PartyAgeingRow[];
  totals: Record<string, number>; // bucket -> sum
  grandOutstanding: number;
  grandAdvance: number;
}

/** Run FIFO ageing for one side over a flat LedgerEntry[] (one branch). */
export const ageParties = (
  entries: LedgerEntry[],
  side: AgeingSide,
  asOfIso?: string,
  branch?: string,
): AgeingResult => {
  const rows = entries.filter((e) => isSide(e, side)).filter((e) => String((e as any).Ledger || '').trim());
  const asOf =
    asOfIso ||
    rows.map((e) => (e as any).date).filter(Boolean).sort().slice(-1)[0] ||
    new Date().toISOString().slice(0, 10);
  const asOfDate = new Date(`${asOf}T00:00:00`);
  const invoiceIsNeg = side === 'debtor'; // debtor invoice is a debit (negative)

  const partyMap = new Map<string, LedgerEntry[]>();
  for (const e of rows) {
    const p = String((e as any).Ledger).trim();
    if (!partyMap.has(p)) partyMap.set(p, []);
    partyMap.get(p)!.push(e);
  }

  const parties: PartyAgeingRow[] = [];
  const totals = initBuckets();

  partyMap.forEach((es, party) => {
    const sortedAll = [...es].sort((a, b) => {
      const ad = String((a as any).date || ''), bd = String((b as any).date || '');
      if (ad === bd) return String((a as any).voucher_number || '').localeCompare(String((b as any).voucher_number || ''));
      return ad.localeCompare(bd);
    });
    const sorted = sortedAll.filter((e) => !(e as any).date || (e as any).date <= asOf);
    const firstDate = sorted.length ? (sorted[0] as any).date || asOf : asOf;
    const opening = sortedAll.map((e) => toNumber((e as any).opening_balance)).find((v) => v !== 0) ?? 0;

    let carry = 0; // unapplied payments => advance
    const queue: Array<{ date: string; out: number }> = [];
    const applyPayment = (amt: number) => {
      let rem = amt;
      for (const it of queue) {
        if (rem <= 0) break;
        if (it.out <= 0) continue;
        const used = Math.min(it.out, rem);
        it.out -= used;
        rem -= used;
      }
      if (rem > 0) carry += rem;
    };
    const addInvoice = (date: string, amt: number) => {
      let pend = amt;
      if (carry > 0) {
        const off = Math.min(carry, pend);
        carry -= off;
        pend -= off;
      }
      if (pend > 0) queue.push({ date, out: pend });
    };

    const openingIsInvoice = invoiceIsNeg ? opening < 0 : opening > 0;
    if (opening !== 0) {
      if (openingIsInvoice) addInvoice(firstDate, Math.abs(opening));
      else applyPayment(Math.abs(opening));
    }
    for (const e of sorted) {
      const amt = toNumber((e as any).amount);
      if (amt === 0) continue;
      const isInvoice = invoiceIsNeg ? amt < 0 : amt > 0;
      if (isInvoice) addInvoice((e as any).date || firstDate, Math.abs(amt));
      else applyPayment(Math.abs(amt));
    }

    const buckets = initBuckets();
    let outstanding = 0;
    for (const it of queue) {
      if (it.out <= 0.005) continue;
      const age = Math.max(0, Math.floor((asOfDate.getTime() - new Date(`${it.date}T00:00:00`).getTime()) / 86400000));
      buckets[computeBucket(age)] += it.out;
      outstanding += it.out;
    }
    if (outstanding > 0.5 || carry > 0.5) {
      parties.push({ party, branch, outstanding, advance: carry, buckets });
      for (const k of BUCKET_LABELS) totals[k] += buckets[k];
    }
  });

  parties.sort((a, b) => b.outstanding - a.outstanding);
  return {
    side,
    asOfIso: asOf,
    parties,
    totals,
    grandOutstanding: parties.reduce((s, p) => s + p.outstanding, 0),
    grandAdvance: parties.reduce((s, p) => s + p.advance, 0),
  };
};

/** Merge per-branch ageing results into one (for the Consolidated note). */
export const mergeAgeing = (results: AgeingResult[], side: AgeingSide): AgeingResult => {
  const present = results.filter(Boolean);
  const parties = present.flatMap((r) => r.parties);
  const totals = initBuckets();
  for (const p of parties) for (const k of BUCKET_LABELS) totals[k] += p.buckets[k];
  parties.sort((a, b) => b.outstanding - a.outstanding);
  return {
    side,
    asOfIso: present[0]?.asOfIso || '',
    parties,
    totals,
    grandOutstanding: parties.reduce((s, p) => s + p.outstanding, 0),
    grandAdvance: parties.reduce((s, p) => s + p.advance, 0),
  };
};
