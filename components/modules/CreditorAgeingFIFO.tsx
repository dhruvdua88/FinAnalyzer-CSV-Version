
import React, { useEffect, useMemo, useState } from 'react';
import { LedgerEntry } from '../../types';
import {
  Download,
  Search,
  Wallet,
  Landmark,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

interface CreditorAgeingFIFOProps {
  data: LedgerEntry[];
}

interface OutstandingInvoice {
  voucherNumber: string;
  invoiceDate: string;
  ageDays: number;
  bucket: string;
  originalAmount: number;
  outstandingAmount: number;
}

interface PartyAgeing {
  party: string;
  openingBalance: number;
  closingBalance: number;
  closingPayable: number;
  advanceAmount: number;
  invoices: OutstandingInvoice[];
  bucketTotals: Record<string, number>;
}

const AGE_BUCKETS = [
  { label: '0-30', min: 0, max: 30 },
  { label: '31-60', min: 31, max: 60 },
  { label: '61-90', min: 61, max: 90 },
  { label: '91-180', min: 91, max: 180 },
  { label: '181-365', min: 181, max: 365 },
  { label: '>365', min: 366, max: Number.MAX_SAFE_INTEGER },
];

const formatAmount = (value: number): string =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const toNumber = (value: any): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const splitDrCr = (value: number) => ({
  dr: value < 0 ? Math.abs(value) : 0,
  cr: value > 0 ? value : 0,
});

const isoToDdMmYyyy = (value: string): string => {
  const raw = (value || '').trim().split('T')[0];
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  return `${match[3]}/${match[2]}/${match[1]}`;
};

const ddMmYyyyToIso = (value: string): string | null => {
  const match = (value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const dd = Number(match[1]);
  const mm = Number(match[2]);
  const yyyy = Number(match[3]);
  const dt = new Date(yyyy, mm - 1, dd);
  if (dt.getFullYear() !== yyyy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};

const computeBucket = (ageDays: number): string => {
  for (const bucket of AGE_BUCKETS) {
    if (ageDays >= bucket.min && ageDays <= bucket.max) return bucket.label;
  }
  return '>365';
};

const isSundryCreditorEntry = (entry: LedgerEntry): boolean => {
  const primary = (entry.TallyPrimary || '').toLowerCase();
  const parent = (entry.TallyParent || '').toLowerCase();
  return primary.includes('sundry creditor') || parent.includes('sundry creditor');
};

const initBucketTotals = () =>
  AGE_BUCKETS.reduce((acc, bucket) => {
    acc[bucket.label] = 0;
    return acc;
  }, {} as Record<string, number>);

const CreditorAgeingFIFO: React.FC<CreditorAgeingFIFOProps> = ({ data }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [bucketFilter, setBucketFilter] = useState<'all' | 'advance' | string>('all');
  const [collapsedParties, setCollapsedParties] = useState<Record<string, boolean>>({});

  const asOfDateDefault = useMemo(() => {
    const dates = data.map((d) => d.date).filter(Boolean).sort();
    const latest = dates.length > 0 ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
    return isoToDdMmYyyy(latest);
  }, [data]);

  const [asOfDateText, setAsOfDateText] = useState(asOfDateDefault);

  const partyResults = useMemo(() => {
    const asOfIso =
      ddMmYyyyToIso(asOfDateText) ||
      data
        .map((d) => d.date)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] ||
      new Date().toISOString().slice(0, 10);
    const asOfDate = new Date(`${asOfIso}T00:00:00`);

    const creditorEntries = data
      .filter(isSundryCreditorEntry)
      .filter((entry) => (entry.Ledger || '').trim().length > 0);

    const partyMap = new Map<string, LedgerEntry[]>();
    creditorEntries.forEach((entry) => {
      const party = entry.Ledger.trim();
      if (!partyMap.has(party)) partyMap.set(party, []);
      partyMap.get(party)!.push(entry);
    });

    const results: PartyAgeing[] = [];

    partyMap.forEach((entries, party) => {
      const sortedAll = [...entries].sort((a, b) => {
        if (a.date === b.date) return (a.voucher_number || '').localeCompare(b.voucher_number || '');
        return (a.date || '').localeCompare(b.date || '');
      });

      const sorted = sortedAll.filter((entry) => !entry.date || entry.date <= asOfIso);
      const firstDate = sorted.length > 0 ? sorted[0].date || asOfIso : asOfIso;
      const openingBalance = sortedAll.map((e) => toNumber(e.opening_balance)).find((v) => v !== 0) ?? 0;
      const periodMovement = sorted.reduce((acc, entry) => acc + toNumber(entry.amount), 0);
      const closingBalance = openingBalance + periodMovement;

      let carryDebit = 0;
      const payableQueue: Array<{
        voucherNumber: string;
        invoiceDate: string;
        originalAmount: number;
        outstandingAmount: number;
      }> = [];

      const applyDebit = (debitAmount: number) => {
        let remaining = debitAmount;
        for (let i = 0; i < payableQueue.length && remaining > 0; i++) {
          const item = payableQueue[i];
          if (item.outstandingAmount <= 0) continue;
          const used = Math.min(item.outstandingAmount, remaining);
          item.outstandingAmount -= used;
          remaining -= used;
        }
        if (remaining > 0) carryDebit += remaining;
      };

      const addCreditInvoice = (voucherNumber: string, invoiceDate: string, amount: number) => {
        let pending = amount;
        if (carryDebit > 0) {
          const offset = Math.min(carryDebit, pending);
          carryDebit -= offset;
          pending -= offset;
        }
        if (pending > 0) {
          payableQueue.push({
            voucherNumber,
            invoiceDate,
            originalAmount: amount,
            outstandingAmount: pending,
          });
        }
      };

      if (openingBalance > 0) addCreditInvoice('Opening Balance', firstDate, Math.abs(openingBalance));
      else if (openingBalance < 0) applyDebit(Math.abs(openingBalance));

      sorted.forEach((entry) => {
        const amount = toNumber(entry.amount);
        const invoiceDate = entry.date || firstDate;
        const voucherNumber = entry.invoice_number || entry.voucher_number || 'UNKNOWN';
        if (amount > 0) addCreditInvoice(voucherNumber, invoiceDate, Math.abs(amount));
        if (amount < 0) applyDebit(Math.abs(amount));
      });

      const invoices: OutstandingInvoice[] = payableQueue
        .filter((item) => item.outstandingAmount > 0.005)
        .map((item) => {
          const invoiceDate = new Date(`${item.invoiceDate}T00:00:00`);
          const ageDays = Math.max(
            0,
            Math.floor((asOfDate.getTime() - invoiceDate.getTime()) / (24 * 60 * 60 * 1000))
          );
          return {
            voucherNumber: item.voucherNumber,
            invoiceDate: item.invoiceDate,
            ageDays,
            bucket: computeBucket(ageDays),
            originalAmount: item.originalAmount,
            outstandingAmount: item.outstandingAmount,
          };
        });

      const bucketTotals = initBucketTotals();
      invoices.forEach((inv) => {
        bucketTotals[inv.bucket] += inv.outstandingAmount;
      });

      const closingPayable = invoices.reduce((acc, inv) => acc + inv.outstandingAmount, 0);
      results.push({
        party,
        openingBalance,
        closingBalance,
        closingPayable,
        advanceAmount: carryDebit,
        invoices,
        bucketTotals,
      });
    });

    return results.sort(
      (a, b) => b.closingPayable - b.advanceAmount - (a.closingPayable - a.advanceAmount)
    );
  }, [data, asOfDateText]);

  useEffect(() => {
    setCollapsedParties((prev) => {
      const next: Record<string, boolean> = {};
      partyResults.forEach((party) => {
        next[party.party] = prev[party.party] ?? false;
      });
      return next;
    });
  }, [partyResults]);

  const filteredPartyResults = useMemo(() => {
    const search = searchTerm.toLowerCase();

    return partyResults
      .map((party) => {
        let invoices = party.invoices;
        if (bucketFilter !== 'all' && bucketFilter !== 'advance') {
          invoices = invoices.filter((inv) => inv.bucket === bucketFilter);
        }
        return { ...party, invoices };
      })
      .filter((party) => {
        const matchesSearch =
          !search ||
          party.party.toLowerCase().includes(search) ||
          party.invoices.some((inv) => inv.voucherNumber.toLowerCase().includes(search));

        if (!matchesSearch) return false;
        if (bucketFilter === 'advance') return party.advanceAmount > 0;
        if (bucketFilter === 'all') return true;
        return party.invoices.length > 0;
      });
  }, [partyResults, searchTerm, bucketFilter]);

  const totals = useMemo(() => {
    return filteredPartyResults.reduce(
      (acc, party) => {
        const opening = splitDrCr(party.openingBalance);
        const closing = splitDrCr(party.closingBalance);
        acc.parties += 1;
        acc.totalOpeningDr += opening.dr;
        acc.totalOpeningCr += opening.cr;
        acc.totalClosingDr += closing.dr;
        acc.totalClosingCr += closing.cr;
        acc.totalPayable += party.closingPayable;
        acc.totalAdvance += party.advanceAmount;
        acc.invoiceCount += party.invoices.length;
        return acc;
      },
      {
        parties: 0,
        totalOpeningDr: 0,
        totalOpeningCr: 0,
        totalClosingDr: 0,
        totalClosingCr: 0,
        totalPayable: 0,
        totalAdvance: 0,
        invoiceCount: 0,
      }
    );
  }, [filteredPartyResults]);

  const reconciliation = useMemo(() => {
    const ledgerClosing = partyResults.reduce(
      (acc, party) => {
        const split = splitDrCr(party.closingBalance);
        acc.ledgerClosingDr += split.dr;
        acc.ledgerClosingCr += split.cr;
        acc.ledgerClosingSigned += party.closingBalance;
        acc.fifoPayable += party.closingPayable;
        acc.fifoAdvance += party.advanceAmount;
        return acc;
      },
      {
        ledgerClosingDr: 0,
        ledgerClosingCr: 0,
        ledgerClosingSigned: 0,
        fifoPayable: 0,
        fifoAdvance: 0,
      }
    );

    const diffCr = ledgerClosing.fifoPayable - ledgerClosing.ledgerClosingCr;
    const diffDr = ledgerClosing.fifoAdvance - ledgerClosing.ledgerClosingDr;
    const combinedFifo = ledgerClosing.fifoPayable + ledgerClosing.fifoAdvance;
    const combinedLedger = ledgerClosing.ledgerClosingDr + ledgerClosing.ledgerClosingCr;
    const diffCombined = combinedFifo - combinedLedger;
    const signedFifo = ledgerClosing.fifoPayable - ledgerClosing.fifoAdvance;
    const diffSigned = signedFifo - ledgerClosing.ledgerClosingSigned;

    const tolerance = 0.5;
    const within = (value: number) => Math.abs(value) <= tolerance;

    return {
      ...ledgerClosing,
      diffDr,
      diffCr,
      combinedFifo,
      combinedLedger,
      diffCombined,
      signedFifo,
      diffSigned,
      isPass: within(diffDr) && within(diffCr),
      tolerance,
    };
  }, [partyResults]);

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    filteredPartyResults.forEach((party) => {
      next[party.party] = false;
    });
    setCollapsedParties((prev) => ({ ...prev, ...next }));
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    filteredPartyResults.forEach((party) => {
      next[party.party] = true;
    });
    setCollapsedParties((prev) => ({ ...prev, ...next }));
  };

  const exportExcel = async () => {
    try {
      const XLSX = await import('xlsx');
      const asOn = asOfDateText;

    const summaryRows = filteredPartyResults.map((party) => {
      const opening = splitDrCr(party.openingBalance);
      const closing = splitDrCr(party.closingBalance);
      return {
        Party: party.party,
        'Opening Dr': opening.dr,
        'Opening Cr': opening.cr,
        'Closing Dr (Ledger)': closing.dr,
        'Closing Cr (Ledger)': closing.cr,
        'FIFO Closing Payable': party.closingPayable,
        'FIFO Advance': party.advanceAmount,
        'Net FIFO (Cr-Dr)': party.closingPayable - party.advanceAmount,
        Invoices: party.invoices.length,
        ...AGE_BUCKETS.reduce((acc, bucket) => {
          acc[bucket.label] = party.bucketTotals[bucket.label] || 0;
          return acc;
        }, {} as Record<string, number>),
      };
    });

    const detailRows: Record<string, any>[] = [];
    filteredPartyResults.forEach((party) => {
      if (party.invoices.length === 0) {
        detailRows.push({
          Party: party.party,
          'Voucher / Invoice': '',
          'Invoice Date': '',
          'Age (Days)': '',
          Bucket: '',
          'Original Amount': '',
          'Outstanding Amount': '',
          Remarks: party.advanceAmount > 0 ? `Advance ${formatAmount(party.advanceAmount)}` : 'No pending invoices',
        });
        return;
      }

      party.invoices.forEach((inv) => {
        detailRows.push({
          Party: party.party,
          'Voucher / Invoice': inv.voucherNumber,
          'Invoice Date': isoToDdMmYyyy(inv.invoiceDate),
          'Age (Days)': inv.ageDays,
          Bucket: inv.bucket,
          'Original Amount': inv.originalAmount,
          'Outstanding Amount': inv.outstandingAmount,
          Remarks: '',
        });
      });

      if (party.advanceAmount > 0) {
        detailRows.push({
          Party: party.party,
          'Voucher / Invoice': '',
          'Invoice Date': '',
          'Age (Days)': '',
          Bucket: 'Advance',
          'Original Amount': '',
          'Outstanding Amount': '',
          Remarks: `Advance ${formatAmount(party.advanceAmount)}`,
        });
      }
    });

      const wb = XLSX.utils.book_new();

    const summaryAoA: any[][] = [];
    const summaryHeaders = [
      'Creditor Ledger',
      'Opening Dr',
      'Opening Cr',
      'Closing Dr (Ledger)',
      'Closing Cr (Ledger)',
      'FIFO Closing Payable',
      'FIFO Advance',
      'Net FIFO (Cr-Dr)',
      'Invoices',
      ...AGE_BUCKETS.map((b) => b.label),
    ];

    summaryAoA.push(['Creditor FIFO Ageing Summary - Sundry Creditors']);
    summaryAoA.push([`As On: ${asOn}`]);
    summaryAoA.push(['Source: Ledgers under Sundry Creditors (TallyPrimary/TallyParent).']);
    summaryAoA.push([]);
    summaryAoA.push(summaryHeaders);

    summaryRows.forEach((row) => {
      summaryAoA.push([
        row.Party,
        row['Opening Dr'],
        row['Opening Cr'],
        row['Closing Dr (Ledger)'],
        row['Closing Cr (Ledger)'],
        row['FIFO Closing Payable'],
        row['FIFO Advance'],
        row['Net FIFO (Cr-Dr)'],
        row.Invoices,
        ...AGE_BUCKETS.map((b) => row[b.label] || 0),
      ]);
    });

    summaryAoA.push([]);
    summaryAoA.push([
      'TOTAL',
      totals.totalOpeningDr,
      totals.totalOpeningCr,
      totals.totalClosingDr,
      totals.totalClosingCr,
      totals.totalPayable,
      totals.totalAdvance,
      totals.totalPayable - totals.totalAdvance,
      totals.invoiceCount,
      ...AGE_BUCKETS.map((bucket) =>
        filteredPartyResults.reduce((acc, party) => acc + (party.bucketTotals[bucket.label] || 0), 0)
      ),
    ]);

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryAoA);
    wsSummary['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: summaryHeaders.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: summaryHeaders.length - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: summaryHeaders.length - 1 } },
    ];
    wsSummary['!cols'] = [
      { wch: 34 },
      { wch: 13 },
      { wch: 13 },
      { wch: 18 },
      { wch: 18 },
      { wch: 22 },
      { wch: 14 },
      { wch: 16 },
      { wch: 10 },
      ...AGE_BUCKETS.map(() => ({ wch: 12 })),
    ];
    wsSummary['!autofilter'] = { ref: `A5:O${summaryAoA.length}` };

    const detailsAoA: any[][] = [];
    detailsAoA.push(['Creditor FIFO Ageing Details']);
    detailsAoA.push([`As On: ${asOn}`]);
    detailsAoA.push(['Source: Sundry Creditors only']);
    detailsAoA.push([]);
    detailsAoA.push([
      'Creditor Ledger',
      'Voucher / Invoice',
      'Invoice Date',
      'Age (Days)',
      'Bucket',
      'Original Amount',
      'Outstanding Amount',
      'Remarks',
    ]);

    detailRows.forEach((row) => {
      detailsAoA.push([
        row.Party,
        row['Voucher / Invoice'],
        row['Invoice Date'],
        row['Age (Days)'],
        row.Bucket,
        row['Original Amount'],
        row['Outstanding Amount'],
        row.Remarks,
      ]);
    });

    const wsDetails = XLSX.utils.aoa_to_sheet(detailsAoA);
    wsDetails['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 7 } },
    ];
    wsDetails['!cols'] = [
      { wch: 34 },
      { wch: 22 },
      { wch: 14 },
      { wch: 10 },
      { wch: 12 },
      { wch: 16 },
      { wch: 18 },
      { wch: 28 },
    ];
    wsDetails['!autofilter'] = { ref: `A5:H${detailsAoA.length}` };

    const reconAoA: any[][] = [];
    reconAoA.push(['Reconciliation - Sundry Creditors Only']);
    reconAoA.push([`As On: ${asOn}`]);
    reconAoA.push([]);
    reconAoA.push(['Check', 'FIFO Value', 'Ledger Value', 'Difference', 'Status']);
    reconAoA.push([
      'Payable (Cr)',
      reconciliation.fifoPayable,
      reconciliation.ledgerClosingCr,
      reconciliation.diffCr,
      Math.abs(reconciliation.diffCr) <= reconciliation.tolerance ? 'PASS' : 'REVIEW',
    ]);
    reconAoA.push([
      'Advance (Dr)',
      reconciliation.fifoAdvance,
      reconciliation.ledgerClosingDr,
      reconciliation.diffDr,
      Math.abs(reconciliation.diffDr) <= reconciliation.tolerance ? 'PASS' : 'REVIEW',
    ]);
    reconAoA.push([
      'Combined (Dr + Cr)',
      reconciliation.combinedFifo,
      reconciliation.combinedLedger,
      reconciliation.diffCombined,
      Math.abs(reconciliation.diffCombined) <= reconciliation.tolerance ? 'PASS' : 'REVIEW',
    ]);
    reconAoA.push([
      'Signed Net (Cr - Dr)',
      reconciliation.signedFifo,
      reconciliation.ledgerClosingSigned,
      reconciliation.diffSigned,
      Math.abs(reconciliation.diffSigned) <= reconciliation.tolerance ? 'PASS' : 'REVIEW',
    ]);

    const wsRecon = XLSX.utils.aoa_to_sheet(reconAoA);
    wsRecon['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
    ];
    wsRecon['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 18 }, { wch: 15 }, { wch: 12 }];
    wsRecon['!autofilter'] = { ref: `A4:E${reconAoA.length}` };

      XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
      XLSX.utils.book_append_sheet(wb, wsDetails, 'Invoice FIFO');
      XLSX.utils.book_append_sheet(wb, wsRecon, 'Reconciliation');

      const dt = new Date();
      const stamp = `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
      XLSX.writeFile(wb, `Creditor_Ageing_FIFO_${stamp}.xlsx`, { compression: true });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export Creditor Ageing Excel. Please retry.');
    }
  };

  const bucketGrandTotals = useMemo(
    () =>
      AGE_BUCKETS.reduce((acc, bucket) => {
        acc[bucket.label] = filteredPartyResults.reduce(
          (sum, party) => sum + (party.bucketTotals[bucket.label] || 0),
          0
        );
        return acc;
      }, {} as Record<string, number>),
    [filteredPartyResults]
  );
  const agedOver180 = (bucketGrandTotals['181-365'] || 0) + (bucketGrandTotals['>365'] || 0);
  const netPayable = totals.totalPayable - totals.totalAdvance;
  const isAsOfDateValid = ddMmYyyyToIso(asOfDateText) !== null;
  const tableColumnCount = 16;

  return (
    <div className="relative isolate space-y-6 pb-8" style={{ fontFamily: "'Avenir Next', 'Segoe UI', sans-serif" }}>
      <div className="pointer-events-none absolute -top-20 -left-24 h-64 w-64 rounded-full bg-violet-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -top-12 right-0 h-56 w-56 rounded-full bg-blue-500/10 blur-3xl" />

      <div className="rounded-3xl border border-slate-700 bg-slate-950 text-slate-100 p-6 shadow-[0_30px_80px_-40px_rgba(15,23,42,0.95)]">
        <p className="text-xs uppercase tracking-[0.35em] text-slate-400">Boardroom View</p>
        <h2
          className="mt-2 text-3xl md:text-4xl text-white"
          style={{ fontFamily: "'Iowan Old Style', 'Palatino Linotype', serif", fontWeight: 700 }}
        >
          Creditor FIFO Command Center
        </h2>
        <p className="mt-2 text-sm text-slate-300">A/P ageing matrix with CFO-focused overdue visibility.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">As On</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{asOfDateText}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Creditors</p>
          <p className="mt-1 text-3xl font-black text-slate-900">{totals.parties}</p>
        </div>
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-600">FIFO Payable</p>
          <p className="mt-1 text-2xl font-black text-indigo-800">{formatAmount(totals.totalPayable)}</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-600">Advance</p>
          <p className="mt-1 text-2xl font-black text-emerald-800">{formatAmount(totals.totalAdvance)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Net Payable</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{formatAmount(netPayable)}</p>
        </div>
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-rose-600">Aged &gt;180</p>
          <p className="mt-1 text-2xl font-black text-rose-800">{formatAmount(agedOver180)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Open Invoices</p>
          <p className="mt-1 text-3xl font-black text-slate-900">{totals.invoiceCount}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 text-slate-100 p-5 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <p className="text-sm font-black">Sundry Creditors Reconciliation Check</p>
            <p className="text-xs text-slate-300 mt-1">
              Source scope: ledgers under Sundry Creditors by TallyPrimary/TallyParent.
            </p>
          </div>
          <div
            className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold border ${
              reconciliation.isPass
                ? 'bg-emerald-900/40 text-emerald-200 border-emerald-700'
                : 'bg-amber-900/40 text-amber-200 border-amber-700'
            }`}
          >
            {reconciliation.isPass ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            {reconciliation.isPass ? 'Reconciled' : 'Review Differences'}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-xs">
          <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <p className="uppercase tracking-wider text-slate-400">Payable (Cr)</p>
            <p className="mt-1">FIFO {formatAmount(reconciliation.fifoPayable)}</p>
            <p>Ledger {formatAmount(reconciliation.ledgerClosingCr)}</p>
            <p className="font-bold text-white mt-1">Diff {formatAmount(reconciliation.diffCr)}</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <p className="uppercase tracking-wider text-slate-400">Advance (Dr)</p>
            <p className="mt-1">FIFO {formatAmount(reconciliation.fifoAdvance)}</p>
            <p>Ledger {formatAmount(reconciliation.ledgerClosingDr)}</p>
            <p className="font-bold text-white mt-1">Diff {formatAmount(reconciliation.diffDr)}</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <p className="uppercase tracking-wider text-slate-400">Combined</p>
            <p className="mt-1">FIFO {formatAmount(reconciliation.combinedFifo)}</p>
            <p>Ledger {formatAmount(reconciliation.combinedLedger)}</p>
            <p className="font-bold text-white mt-1">Diff {formatAmount(reconciliation.diffCombined)}</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <p className="uppercase tracking-wider text-slate-400">Signed Net</p>
            <p className="mt-1">FIFO {formatAmount(reconciliation.signedFifo)}</p>
            <p>Ledger {formatAmount(reconciliation.ledgerClosingSigned)}</p>
            <p className="font-bold text-white mt-1">Diff {formatAmount(reconciliation.diffSigned)}</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-7 gap-3">
          <div className="relative lg:col-span-2">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search creditor ledger or voucher..."
              className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-900 focus:outline-none"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={asOfDateText}
              onChange={(e) => {
                const clean = e.target.value.replace(/[^\d]/g, '').slice(0, 8);
                if (clean.length <= 2) setAsOfDateText(clean);
                else if (clean.length <= 4) setAsOfDateText(`${clean.slice(0, 2)}/${clean.slice(2)}`);
                else setAsOfDateText(`${clean.slice(0, 2)}/${clean.slice(2, 4)}/${clean.slice(4)}`);
              }}
              className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-slate-900 focus:outline-none ${
                isAsOfDateValid ? 'border-slate-300' : 'border-amber-400'
              }`}
              placeholder="As On dd/mm/yyyy"
            />
          </div>
          <div>
            <select
              value={bucketFilter}
              onChange={(e) => setBucketFilter(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
            >
              <option value="all">All Buckets</option>
              {AGE_BUCKETS.map((b) => (
                <option key={b.label} value={b.label}>
                  {b.label}
                </option>
              ))}
              <option value="advance">Advance Only</option>
            </select>
          </div>
          <button
            onClick={expandAll}
            className="px-4 py-2 rounded-lg text-sm font-bold border border-slate-300 text-slate-700 bg-slate-100 hover:bg-slate-200"
          >
            Expand All
          </button>
          <button
            onClick={collapseAll}
            className="px-4 py-2 rounded-lg text-sm font-bold border border-slate-300 text-slate-700 bg-slate-100 hover:bg-slate-200"
          >
            Collapse All
          </button>
          <button
            onClick={exportExcel}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-bold hover:bg-slate-800 flex items-center justify-center gap-2"
          >
            <Download size={16} />
            Export Excel
          </button>
        </div>
        {!isAsOfDateValid && (
          <p className="text-xs text-amber-700">
            Invalid date format. Continue in `dd/mm/yyyy`; calculation currently falls back to latest available date.
          </p>
        )}
      </div>

      {filteredPartyResults.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-14 text-center text-slate-400 shadow-sm">
          No creditor ledgers match current filters.
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-900 bg-slate-950 text-slate-100 shadow-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 bg-slate-900">
            <h3 className="text-sm font-black">Creditor Ageing Matrix (FIFO)</h3>
            <p className="text-xs text-slate-400 mt-1">Bucket values are shown as columns for CFO-level review.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[1520px] w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-900 text-[11px] uppercase tracking-wider text-slate-300 border-b border-slate-800">
                  <th rowSpan={2} className="px-4 py-3 text-left font-bold">Creditor</th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">Opening Dr</th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">Opening Cr</th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">Ledger Dr</th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">Ledger Cr</th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">FIFO Payable</th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">FIFO Advance</th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">Net FIFO</th>
                  <th colSpan={AGE_BUCKETS.length} className="px-3 py-2 text-center font-bold text-blue-200 bg-slate-800">
                    Ageing Buckets
                  </th>
                  <th rowSpan={2} className="px-3 py-3 text-right font-bold">Invoices</th>
                  <th rowSpan={2} className="px-3 py-3 text-left font-bold">Details</th>
                </tr>
                <tr className="bg-slate-800 text-[11px] uppercase tracking-wide text-blue-200 border-b border-slate-700">
                  {AGE_BUCKETS.map((bucket) => (
                    <th key={bucket.label} className="px-3 py-2 text-right font-bold">
                      {bucket.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredPartyResults.map((party) => {
                  const opening = splitDrCr(party.openingBalance);
                  const closing = splitDrCr(party.closingBalance);
                  const isCollapsed = collapsedParties[party.party] ?? false;
                  const net = party.closingPayable - party.advanceAmount;

                  return (
                    <React.Fragment key={party.party}>
                      <tr className="hover:bg-slate-900/80">
                        <td className="px-4 py-3 font-semibold text-white">{party.party}</td>
                        <td className="px-3 py-3 text-right font-mono">{formatAmount(opening.dr)}</td>
                        <td className="px-3 py-3 text-right font-mono">{formatAmount(opening.cr)}</td>
                        <td className="px-3 py-3 text-right font-mono">{formatAmount(closing.dr)}</td>
                        <td className="px-3 py-3 text-right font-mono">{formatAmount(closing.cr)}</td>
                        <td className="px-3 py-3 text-right font-mono font-bold text-blue-200">
                          {formatAmount(party.closingPayable)}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-300">
                          {formatAmount(party.advanceAmount)}
                        </td>
                        <td className="px-3 py-3 text-right font-mono font-bold text-white">{formatAmount(net)}</td>
                        {AGE_BUCKETS.map((bucket) => (
                          <td key={`${party.party}-${bucket.label}`} className="px-3 py-3 text-right font-mono text-slate-300">
                            {formatAmount(party.bucketTotals[bucket.label] || 0)}
                          </td>
                        ))}
                        <td className="px-3 py-3 text-right font-semibold text-slate-200">{party.invoices.length}</td>
                        <td className="px-3 py-3">
                          <button
                            onClick={() =>
                              setCollapsedParties((prev) => ({
                                ...prev,
                                [party.party]: !isCollapsed,
                              }))
                            }
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-600 text-xs font-semibold text-slate-200 hover:bg-slate-800"
                          >
                            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            {isCollapsed ? 'Expand' : 'Collapse'}
                          </button>
                        </td>
                      </tr>
                      {!isCollapsed && (
                        <tr className="bg-slate-900/60">
                          <td colSpan={tableColumnCount} className="px-4 py-4">
                            <div className="rounded-xl border border-slate-700 bg-slate-950/70 overflow-hidden">
                              <div className="px-4 py-3 border-b border-slate-700 flex flex-wrap items-center gap-2 text-xs">
                                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 bg-blue-950 text-blue-200 border border-blue-700 font-semibold">
                                  <Wallet size={12} />
                                  Payable {formatAmount(party.closingPayable)}
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 bg-emerald-950 text-emerald-200 border border-emerald-700 font-semibold">
                                  <Wallet size={12} />
                                  Advance {formatAmount(party.advanceAmount)}
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 bg-slate-800 text-slate-200 border border-slate-600 font-semibold">
                                  <Landmark size={12} />
                                  Closing Dr {formatAmount(closing.dr)} / Cr {formatAmount(closing.cr)}
                                </span>
                              </div>
                              {party.invoices.length === 0 ? (
                                <div className="px-4 py-6 text-sm text-slate-300">
                                  No pending invoices.{' '}
                                  {party.advanceAmount > 0
                                    ? `Excess payment shown as advance: ${formatAmount(party.advanceAmount)}`
                                    : 'No advance balance.'}
                                </div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="min-w-[760px] w-full text-sm">
                                    <thead className="bg-slate-900 text-slate-300 text-[11px] font-bold uppercase border-b border-slate-700">
                                      <tr>
                                        <th className="px-4 py-3 text-left">Voucher / Invoice</th>
                                        <th className="px-4 py-3 text-left">Invoice Date</th>
                                        <th className="px-4 py-3 text-right">Age (Days)</th>
                                        <th className="px-4 py-3 text-left">Bucket</th>
                                        <th className="px-4 py-3 text-right">Original</th>
                                        <th className="px-4 py-3 text-right">Outstanding</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800">
                                      {party.invoices.map((inv, idx) => (
                                        <tr
                                          key={`${party.party}-${inv.voucherNumber}-${inv.invoiceDate}-${idx}`}
                                          className="hover:bg-slate-900/70"
                                        >
                                          <td className="px-4 py-3 font-semibold text-slate-100">{inv.voucherNumber}</td>
                                          <td className="px-4 py-3 text-slate-300">{isoToDdMmYyyy(inv.invoiceDate)}</td>
                                          <td className="px-4 py-3 text-right font-mono">{inv.ageDays}</td>
                                          <td className="px-4 py-3 text-slate-300">{inv.bucket}</td>
                                          <td className="px-4 py-3 text-right font-mono text-slate-300">
                                            {formatAmount(inv.originalAmount)}
                                          </td>
                                          <td className="px-4 py-3 text-right font-mono font-bold text-blue-200">
                                            {formatAmount(inv.outstandingAmount)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-900 border-t-2 border-slate-700">
                <tr className="text-[11px] uppercase tracking-wide text-slate-200 font-bold">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-3 py-3 text-right font-mono">{formatAmount(totals.totalOpeningDr)}</td>
                  <td className="px-3 py-3 text-right font-mono">{formatAmount(totals.totalOpeningCr)}</td>
                  <td className="px-3 py-3 text-right font-mono">{formatAmount(totals.totalClosingDr)}</td>
                  <td className="px-3 py-3 text-right font-mono">{formatAmount(totals.totalClosingCr)}</td>
                  <td className="px-3 py-3 text-right font-mono text-blue-200">{formatAmount(totals.totalPayable)}</td>
                  <td className="px-3 py-3 text-right font-mono text-emerald-300">{formatAmount(totals.totalAdvance)}</td>
                  <td className="px-3 py-3 text-right font-mono">{formatAmount(netPayable)}</td>
                  {AGE_BUCKETS.map((bucket) => (
                    <td key={`total-${bucket.label}`} className="px-3 py-3 text-right font-mono">
                      {formatAmount(bucketGrandTotals[bucket.label] || 0)}
                    </td>
                  ))}
                  <td className="px-3 py-3 text-right">{totals.invoiceCount}</td>
                  <td className="px-3 py-3">-</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default CreditorAgeingFIFO;


