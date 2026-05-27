import React, { useEffect, useMemo, useState } from 'react';
import { LedgerEntry } from '../../types';
import { ChevronDown, ChevronRight, Download, Search } from 'lucide-react';
import { fetchSqlLedgerList, fetchSqlLedgerVoucherPage } from '../../services/sqlAnalyticsService';
import { voucherFamilyKey } from '../../services/tally';

interface LedgerVoucherViewProps {
  data: LedgerEntry[];
}

interface LedgerVoucherRow {
  key: string;
  voucherNumber: string;
  date: string;
  dateTs: number;
  voucherType: string;
  party: string;
  narration: string;
  ledgerAmount: number;
  ledgerDr: number;
  ledgerCr: number;
  balance?: number;
  entries: LedgerEntry[];
}

interface StatementTableRow {
  key: string;
  kind: 'opening' | 'voucher' | 'closing';
  date: string;
  particulars: string;
  voucherType: string;
  voucherNumber: string;
  dr: number;
  cr: number;
  balance: number;
  sourceRow?: LedgerVoucherRow;
}

const toNumber = (value: any): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseOptionalNumber = (value: any): number | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const parseDateTs = (value: string): number => {
  if (!value) return 0;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    const [dd, mm, yyyy] = value.split('/').map(Number);
    const d = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  if (/^\d{2}\/\d{2}\/\d{2}$/.test(value)) {
    const [dd, mm, yy] = value.split('/').map(Number);
    const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
    const d = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};

const toISODate = (ts: number): string => {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const toDDMMYYYY = (value: string) => {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const ts = parseDateTs(value);
  if (!ts) return value;
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const getDrCr = (amount: number) => {
  if (amount < 0) return { dr: Math.abs(amount), cr: 0 };
  if (amount > 0) return { dr: 0, cr: amount };
  return { dr: 0, cr: 0 };
};

const isSyntheticUnknownVoucher = (voucherNumber: string) => /^unknown(?:-\d+)?$/i.test(String(voucherNumber || '').trim());

const getVoucherGroupIdentity = (entry: LedgerEntry) => {
  const voucherNumber = String(entry.voucher_number || entry.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN';
  const date = String(entry.date || '').trim();
  const voucherType = String(entry.voucher_type || '').trim();
  const guidFamily = voucherFamilyKey(entry.guid);
  const voucherFamily = isSyntheticUnknownVoucher(voucherNumber) && guidFamily ? `UNKNOWN_GUID::${guidFamily}` : voucherNumber;
  return {
    voucherNumber,
    date,
    voucherType,
    key: `${voucherFamily}__${date}__${voucherType}`,
  };
};

const formatAmount = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatBalance = (value: number) => {
  const absValue = formatAmount(Math.abs(value));
  if (value < 0) return `${absValue} Dr`;
  if (value > 0) return `${absValue} Cr`;
  return `${absValue}`;
};

const resolveParty = (entries: LedgerEntry[]): string => {
  const byPartyName = entries.map((e) => String(e.party_name || '').trim()).find((v) => v.length > 0);
  if (byPartyName) return byPartyName;

  const likelyParty = entries.find((e) => {
    const primary = String(e.TallyPrimary || '').toLowerCase();
    const parent = String(e.TallyParent || '').toLowerCase();
    return primary.includes('debtor') || parent.includes('debtor') || primary.includes('creditor') || parent.includes('creditor');
  });
  if (likelyParty?.Ledger && String(likelyParty.Ledger).trim()) return String(likelyParty.Ledger).trim();

  return '-';
};

const LedgerVoucherView: React.FC<LedgerVoucherViewProps> = ({ data }) => {
  const [selectedLedger, setSelectedLedger] = useState('');
  const [search, setSearch] = useState('');
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sqlLedgers, setSqlLedgers] = useState<string[]>([]);
  const [sqlRows, setSqlRows] = useState<LedgerVoucherRow[]>([]);
  const [sqlMeta, setSqlMeta] = useState({
    periodFrom: '',
    periodTo: '',
    hasOpening: false,
    hasClosing: false,
    openingAtRangeStart: 0,
    closingAtRangeEnd: 0,
    referenceClosingAtRangeEnd: null as number | null,
    reconciliationDiff: null as number | null,
    periodTotals: { dr: 0, cr: 0, net: 0 },
    periodRowsCount: 0,
    visibleRowsCount: 0,
    page: 1,
    pageSize: 50,
    totalPages: 1,
  });
  const [sqlPage, setSqlPage] = useState(1);
  const [sqlPageSize, setSqlPageSize] = useState(50);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState('');
  const isSqlQueryMode = data.length === 0;

  const allLedgers = useMemo(
    () =>
      isSqlQueryMode
        ? sqlLedgers
        : Array.from(new Set(data.map((entry) => String(entry.Ledger || '').trim()).filter((value) => value.length > 0))).sort(),
    [data, isSqlQueryMode, sqlLedgers]
  );

  useEffect(() => {
    let cancelled = false;

    const loadLedgers = async () => {
      if (!isSqlQueryMode) {
        setSqlLedgers([]);
        return;
      }
      setSqlLoading(true);
      setSqlError('');
      try {
        const ledgers = await fetchSqlLedgerList();
        if (cancelled) return;
        setSqlLedgers(ledgers);
      } catch (error: any) {
        if (cancelled) return;
        setSqlError(error?.message || 'Unable to load ledger list from SQL.');
      } finally {
        if (!cancelled) setSqlLoading(false);
      }
    };

    loadLedgers();
    return () => {
      cancelled = true;
    };
  }, [isSqlQueryMode]);

  useEffect(() => {
    if (!isSqlQueryMode) return;
    setSqlPage(1);
  }, [isSqlQueryMode, selectedLedger, search, fromDate, toDate, sqlPageSize]);

  useEffect(() => {
    if (allLedgers.length === 0) {
      setSelectedLedger('');
      return;
    }
    if (!selectedLedger || !allLedgers.includes(selectedLedger)) {
      setSelectedLedger(allLedgers[0]);
    }
  }, [allLedgers, selectedLedger]);

  useEffect(() => {
    let cancelled = false;

    const loadSqlPage = async () => {
      if (!isSqlQueryMode || !selectedLedger) {
        setSqlRows([]);
        setSqlMeta((prev) => ({
          ...prev,
          periodFrom: '',
          periodTo: '',
          openingAtRangeStart: 0,
          closingAtRangeEnd: 0,
          referenceClosingAtRangeEnd: null,
          reconciliationDiff: null,
          periodTotals: { dr: 0, cr: 0, net: 0 },
          periodRowsCount: 0,
          visibleRowsCount: 0,
          page: 1,
          totalPages: 1,
        }));
        return;
      }

      setSqlLoading(true);
      setSqlError('');
      try {
        const payload = await fetchSqlLedgerVoucherPage({
          ledger: selectedLedger,
          fromDate,
          toDate,
          search,
          page: sqlPage,
          pageSize: sqlPageSize,
        });
        if (cancelled) return;
        const rows: LedgerVoucherRow[] = (payload.rows || []).map((row: any) => ({
          key: String(row.key || ''),
          voucherNumber: String(row.voucherNumber || ''),
          date: String(row.date || ''),
          dateTs: Number(row.dateTs || parseDateTs(String(row.date || ''))),
          voucherType: String(row.voucherType || ''),
          party: String(row.party || '-'),
          narration: String(row.narration || ''),
          ledgerAmount: Number(row.ledgerAmount || 0),
          ledgerDr: Number(row.ledgerDr || 0),
          ledgerCr: Number(row.ledgerCr || 0),
          balance: Number(row.balance || 0),
          entries: Array.isArray(row.entries) ? row.entries : [],
        }));
        setSqlRows(rows);
        setSqlMeta({
          periodFrom: String(payload.periodFrom || ''),
          periodTo: String(payload.periodTo || ''),
          hasOpening: !!payload.hasOpening,
          hasClosing: !!payload.hasClosing,
          openingAtRangeStart: Number(payload.openingAtRangeStart || 0),
          closingAtRangeEnd: Number(payload.closingAtRangeEnd || 0),
          referenceClosingAtRangeEnd:
            payload.referenceClosingAtRangeEnd === null || payload.referenceClosingAtRangeEnd === undefined
              ? null
              : Number(payload.referenceClosingAtRangeEnd),
          reconciliationDiff:
            payload.reconciliationDiff === null || payload.reconciliationDiff === undefined
              ? null
              : Number(payload.reconciliationDiff),
          periodTotals: {
            dr: Number(payload.periodTotals?.dr || 0),
            cr: Number(payload.periodTotals?.cr || 0),
            net: Number(payload.periodTotals?.net || 0),
          },
          periodRowsCount: Number(payload.periodRowsCount || 0),
          visibleRowsCount: Number(payload.visibleRowsCount || 0),
          page: Number(payload.page || 1),
          pageSize: Number(payload.pageSize || sqlPageSize),
          totalPages: Number(payload.totalPages || 1),
        });
        setSqlPage(Number(payload.page || 1));
      } catch (error: any) {
        if (cancelled) return;
        setSqlError(error?.message || 'Unable to load ledger statement page from SQL.');
      } finally {
        if (!cancelled) setSqlLoading(false);
      }
    };

    loadSqlPage();
    return () => {
      cancelled = true;
    };
  }, [isSqlQueryMode, selectedLedger, fromDate, toDate, search, sqlPage, sqlPageSize]);

  const inMemoryLedgerRows = useMemo(() => {
    if (isSqlQueryMode) return [] as LedgerVoucherRow[];
    if (!selectedLedger) return [] as LedgerVoucherRow[];

    const selectedLower = selectedLedger.toLowerCase();
    const voucherMap = new Map<string, LedgerVoucherRow>();

    data.forEach((entry) => {
      const normalized = getVoucherGroupIdentity(entry);
      const { voucherNumber, date, voucherType, key } = normalized;

      if (!voucherMap.has(key)) {
        voucherMap.set(key, {
          key,
          voucherNumber,
          date,
          dateTs: parseDateTs(date),
          voucherType,
          party: '-',
          narration: '',
          ledgerAmount: 0,
          ledgerDr: 0,
          ledgerCr: 0,
          entries: [],
        });
      }

      const node = voucherMap.get(key)!;
      if (
        isSyntheticUnknownVoucher(node.voucherNumber) &&
        voucherNumber &&
        (!isSyntheticUnknownVoucher(voucherNumber) || voucherNumber.localeCompare(node.voucherNumber) < 0)
      ) {
        node.voucherNumber = voucherNumber;
      }
      node.entries.push(entry);
    });

    const rows: LedgerVoucherRow[] = [];
    voucherMap.forEach((row) => {
      const selectedEntries = row.entries.filter(
        (entry) => String(entry.Ledger || '').trim().toLowerCase() === selectedLower
      );
      if (selectedEntries.length === 0) return;

      row.party = resolveParty(row.entries);
      row.narration =
        selectedEntries.map((entry) => String(entry.narration || '').trim()).find((value) => value.length > 0) ||
        row.entries.map((entry) => String(entry.narration || '').trim()).find((value) => value.length > 0) ||
        '';

      const ledgerAmount = selectedEntries.reduce((sum, entry) => sum + toNumber(entry.amount), 0);
      const { dr, cr } = getDrCr(ledgerAmount);
      row.ledgerAmount = ledgerAmount;
      row.ledgerDr = dr;
      row.ledgerCr = cr;

      rows.push(row);
    });

    return rows.sort((a, b) => {
      const dateDiff = a.dateTs - b.dateTs;
      if (dateDiff !== 0) return dateDiff;
      const voucherDiff = a.voucherNumber.localeCompare(b.voucherNumber);
      if (voucherDiff !== 0) return voucherDiff;
      return a.voucherType.localeCompare(b.voucherType);
    });
  }, [data, selectedLedger, isSqlQueryMode]);

  const ledgerRows = useMemo(
    () => (isSqlQueryMode ? sqlRows : inMemoryLedgerRows),
    [isSqlQueryMode, sqlRows, inMemoryLedgerRows]
  );

  const ledgerEntryBalances = useMemo(() => {
    if (isSqlQueryMode) {
      return {
        openingBalance: sqlMeta.openingAtRangeStart,
        closingBalance: sqlMeta.closingAtRangeEnd,
        hasOpening: sqlMeta.hasOpening,
        hasClosing: sqlMeta.hasClosing,
      };
    }
    if (!selectedLedger) {
      return { openingBalance: 0, closingBalance: 0, hasOpening: false, hasClosing: false };
    }

    const selectedLower = selectedLedger.toLowerCase();
    const selectedLedgerEntries = data
      .filter((entry) => String(entry.Ledger || '').trim().toLowerCase() === selectedLower)
      .sort((a, b) => parseDateTs(String(a.date || '')) - parseDateTs(String(b.date || '')));

    let openingBalance: number | null = null;
    for (const entry of selectedLedgerEntries) {
      const parsed = parseOptionalNumber(entry.opening_balance);
      if (parsed !== null) {
        openingBalance = parsed;
        break;
      }
    }

    let closingBalance: number | null = null;
    for (let i = selectedLedgerEntries.length - 1; i >= 0; i--) {
      const parsed = parseOptionalNumber(selectedLedgerEntries[i].closing_balance);
      if (parsed !== null) {
        closingBalance = parsed;
        break;
      }
    }

    return {
      openingBalance: openingBalance ?? 0,
      closingBalance: closingBalance ?? 0,
      hasOpening: openingBalance !== null,
      hasClosing: closingBalance !== null,
    };
  }, [data, selectedLedger, isSqlQueryMode, sqlMeta]);

  useEffect(() => {
    if (!isSqlQueryMode) return;
    setExpandedRows({});
    setSearch('');
    setFromDate('');
    setToDate('');
  }, [selectedLedger, isSqlQueryMode]);

  useEffect(() => {
    if (isSqlQueryMode) return;
    if (ledgerRows.length === 0) {
      setFromDate('');
      setToDate('');
      return;
    }
    const firstTs = ledgerRows[0].dateTs;
    const lastTs = ledgerRows[ledgerRows.length - 1].dateTs;
    setFromDate(toISODate(firstTs));
    setToDate(toISODate(lastTs));
    setExpandedRows({});
    setSearch('');
  }, [selectedLedger, isSqlQueryMode, ledgerRows]);

  useEffect(() => {
    if (!isSqlQueryMode) return;
    if (!fromDate && sqlMeta.periodFrom) setFromDate(sqlMeta.periodFrom);
    if (!toDate && sqlMeta.periodTo) setToDate(sqlMeta.periodTo);
  }, [isSqlQueryMode, sqlMeta.periodFrom, sqlMeta.periodTo, fromDate, toDate]);

  const statementData = useMemo(() => {
    if (isSqlQueryMode) {
      const runningBalanceByKey = new Map<string, number>();
      sqlRows.forEach((row) => {
        runningBalanceByKey.set(row.key, Number(row.balance ?? 0));
      });
      return {
        openingAtRangeStart: sqlMeta.openingAtRangeStart,
        closingAtRangeEnd: sqlMeta.closingAtRangeEnd,
        referenceClosingAtRangeEnd: sqlMeta.referenceClosingAtRangeEnd,
        reconciliationDiff: sqlMeta.reconciliationDiff,
        periodTotals: sqlMeta.periodTotals,
        periodRows: sqlRows,
        visibleRows: sqlRows,
        runningBalanceByKey,
      };
    }

    const fromTsRaw = fromDate ? parseDateTs(fromDate) : Number.NEGATIVE_INFINITY;
    const toTsRaw = toDate ? parseDateTs(toDate) : Number.POSITIVE_INFINITY;
    const fromTs = Number.isFinite(fromTsRaw) ? fromTsRaw : Number.NEGATIVE_INFINITY;
    const toTs = Number.isFinite(toTsRaw) ? toTsRaw + 86399999 : Number.POSITIVE_INFINITY;

    const openingMovementBeforeRange = ledgerRows
      .filter((row) => row.dateTs && row.dateTs < fromTs)
      .reduce((sum, row) => sum + row.ledgerAmount, 0);
    const movementAfterRange = ledgerRows
      .filter((row) => row.dateTs && row.dateTs > toTs)
      .reduce((sum, row) => sum + row.ledgerAmount, 0);

    const openingAtRangeStart = ledgerEntryBalances.openingBalance + openingMovementBeforeRange;

    const periodRows = ledgerRows.filter((row) => {
      if (!row.dateTs) return true;
      return row.dateTs >= fromTs && row.dateTs <= toTs;
    });

    const periodTotals = periodRows.reduce(
      (acc, row) => {
        acc.dr += row.ledgerDr;
        acc.cr += row.ledgerCr;
        acc.net += row.ledgerAmount;
        return acc;
      },
      { dr: 0, cr: 0, net: 0 }
    );

    const closingAtRangeEnd = openingAtRangeStart + periodTotals.net;

    const referenceClosingAtRangeEnd = ledgerEntryBalances.hasClosing
      ? ledgerEntryBalances.closingBalance - movementAfterRange
      : null;
    const reconciliationDiff =
      referenceClosingAtRangeEnd === null ? null : closingAtRangeEnd - referenceClosingAtRangeEnd;

    const runningBalanceByKey = new Map<string, number>();
    let running = openingAtRangeStart;
    periodRows.forEach((row) => {
      running += row.ledgerAmount;
      runningBalanceByKey.set(row.key, running);
    });

    const q = search.trim().toLowerCase();
    const visibleRows = q
      ? periodRows.filter((row) => {
          return (
            row.voucherNumber.toLowerCase().includes(q) ||
            row.voucherType.toLowerCase().includes(q) ||
            row.party.toLowerCase().includes(q) ||
            row.narration.toLowerCase().includes(q)
          );
        })
      : periodRows;

    return {
      openingAtRangeStart,
      closingAtRangeEnd,
      referenceClosingAtRangeEnd,
      reconciliationDiff,
      periodTotals,
      periodRows,
      visibleRows,
      runningBalanceByKey,
    };
  }, [ledgerRows, ledgerEntryBalances, fromDate, toDate, search, isSqlQueryMode, sqlRows, sqlMeta]);

  const tableRows = useMemo(() => {
    const rows: StatementTableRow[] = [];
    const openingDate =
      fromDate ? toDDMMYYYY(fromDate) : statementData.periodRows[0] ? toDDMMYYYY(statementData.periodRows[0].date) : '-';
    const closingDate =
      toDate
        ? toDDMMYYYY(toDate)
        : statementData.periodRows[statementData.periodRows.length - 1]
          ? toDDMMYYYY(statementData.periodRows[statementData.periodRows.length - 1].date)
          : '-';

    rows.push({
      key: 'opening-bf',
      kind: 'opening',
      date: openingDate,
      particulars: 'Opening Balance b/f',
      voucherType: '-',
      voucherNumber: '-',
      dr: 0,
      cr: 0,
      balance: statementData.openingAtRangeStart,
    });

    statementData.visibleRows.forEach((row) => {
      rows.push({
        key: `voucher-${row.key}`,
        kind: 'voucher',
        date: toDDMMYYYY(row.date),
        particulars: row.party || '-',
        voucherType: row.voucherType || '-',
        voucherNumber: row.voucherNumber,
        dr: row.ledgerDr,
        cr: row.ledgerCr,
        balance: statementData.runningBalanceByKey.get(row.key) ?? statementData.openingAtRangeStart,
        sourceRow: row,
      });
    });

    rows.push({
      key: 'closing-cf',
      kind: 'closing',
      date: closingDate,
      particulars: 'Closing Balance c/f',
      voucherType: '-',
      voucherNumber: '-',
      dr: 0,
      cr: 0,
      balance: statementData.closingAtRangeEnd,
    });

    return rows;
  }, [fromDate, toDate, statementData]);

  useEffect(() => {
    setExpandedRows((prev) => {
      const next: Record<string, boolean> = {};
      tableRows.forEach((row) => {
        if (row.kind !== 'voucher' || !row.sourceRow) return;
        next[row.sourceRow.key] = prev[row.sourceRow.key] ?? false;
      });
      return next;
    });
  }, [tableRows]);

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    statementData.visibleRows.forEach((row) => {
      next[row.key] = true;
    });
    setExpandedRows((prev) => ({ ...prev, ...next }));
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    statementData.visibleRows.forEach((row) => {
      next[row.key] = false;
    });
    setExpandedRows((prev) => ({ ...prev, ...next }));
  };

  const resetPeriod = () => {
    if (isSqlQueryMode) {
      setFromDate(sqlMeta.periodFrom || '');
      setToDate(sqlMeta.periodTo || '');
      setSqlPage(1);
      return;
    }
    if (ledgerRows.length === 0) {
      setFromDate('');
      setToDate('');
      return;
    }
    setFromDate(toISODate(ledgerRows[0].dateTs));
    setToDate(toISODate(ledgerRows[ledgerRows.length - 1].dateTs));
  };

  const exportExcel = async () => {
    if (!selectedLedger) return;

    try {
      const XLSX = await import('xlsx');
      let exportRows = statementData.visibleRows as LedgerVoucherRow[];
      let exportOpening = statementData.openingAtRangeStart;
      let exportClosing = statementData.closingAtRangeEnd;
      let exportReferenceClosing = statementData.referenceClosingAtRangeEnd;
      let exportDiff = statementData.reconciliationDiff;
      let exportPeriodTotals = statementData.periodTotals;
      let exportPeriodRowsCount = statementData.periodRows.length;

      if (isSqlQueryMode) {
        const mapSqlRows = (rows: any[]): LedgerVoucherRow[] =>
          rows.map((row) => ({
            key: String(row.key || ''),
            voucherNumber: String(row.voucherNumber || ''),
            date: String(row.date || ''),
            dateTs: Number(row.dateTs || parseDateTs(String(row.date || ''))),
            voucherType: String(row.voucherType || ''),
            party: String(row.party || '-'),
            narration: String(row.narration || ''),
            ledgerAmount: Number(row.ledgerAmount || 0),
            ledgerDr: Number(row.ledgerDr || 0),
            ledgerCr: Number(row.ledgerCr || 0),
            balance: Number(row.balance || 0),
            entries: Array.isArray(row.entries) ? row.entries : [],
          }));

        const first = await fetchSqlLedgerVoucherPage({
          ledger: selectedLedger,
          fromDate,
          toDate,
          search,
          page: 1,
          pageSize: sqlPageSize,
        });
        const allRows: LedgerVoucherRow[] = [...mapSqlRows(first.rows || [])];
        const pages = Math.max(1, Number(first.totalPages || 1));
        for (let p = 2; p <= pages; p += 1) {
          const payload = await fetchSqlLedgerVoucherPage({
            ledger: selectedLedger,
            fromDate,
            toDate,
            search,
            page: p,
            pageSize: sqlPageSize,
          });
          allRows.push(...mapSqlRows(payload.rows || []));
        }

        exportRows = allRows;
        exportOpening = Number(first.openingAtRangeStart || 0);
        exportClosing = Number(first.closingAtRangeEnd || 0);
        exportReferenceClosing =
          first.referenceClosingAtRangeEnd === null || first.referenceClosingAtRangeEnd === undefined
            ? null
            : Number(first.referenceClosingAtRangeEnd);
        exportDiff =
          first.reconciliationDiff === null || first.reconciliationDiff === undefined
            ? null
            : Number(first.reconciliationDiff);
        exportPeriodTotals = {
          dr: Number(first.periodTotals?.dr || 0),
          cr: Number(first.periodTotals?.cr || 0),
          net: Number(first.periodTotals?.net || 0),
        };
        exportPeriodRowsCount = Number(first.periodRowsCount || 0);
      }

      if (exportRows.length === 0) return;

      const summaryRows = [
        {
          Ledger: selectedLedger,
          'Period From': fromDate ? toDDMMYYYY(fromDate) : '-',
          'Period To': toDate ? toDDMMYYYY(toDate) : '-',
          'Opening Balance': exportOpening,
          'Total Dr': exportPeriodTotals.dr,
          'Total Cr': exportPeriodTotals.cr,
          'Net Movement': exportPeriodTotals.net,
          'Computed Closing': exportClosing,
          'Reference Closing': exportReferenceClosing ?? '',
          'Reconciliation Diff': exportDiff ?? '',
          'Rows In Period': exportPeriodRowsCount,
          'Rows Exported': exportRows.length,
        },
      ];

      const statementRows: Record<string, any>[] = [
        {
          Date: fromDate ? toDDMMYYYY(fromDate) : '-',
          Particulars: 'Opening Balance b/f',
          'Voucher Number': '-',
          'Voucher Type': '-',
          Dr: '',
          Cr: '',
          'Net Hit': '',
          Balance: exportOpening,
        },
      ];

      exportRows.forEach((row) => {
        statementRows.push({
          Date: toDDMMYYYY(row.date),
          Particulars: row.party || '-',
          'Voucher Number': row.voucherNumber,
          'Voucher Type': row.voucherType || '-',
          Narration: row.narration || '-',
          Dr: row.ledgerDr || '',
          Cr: row.ledgerCr || '',
          'Net Hit': row.ledgerAmount,
          Balance: Number(row.balance ?? exportOpening),
        });
      });

      statementRows.push({
        Date: toDate ? toDDMMYYYY(toDate) : '-',
        Particulars: 'Closing Balance c/f',
        'Voucher Number': '-',
        'Voucher Type': '-',
        Dr: '',
        Cr: '',
        'Net Hit': '',
        Balance: exportClosing,
      });

      const detailRows: Record<string, any>[] = [];
      exportRows.forEach((row) => {
        row.entries.forEach((entry) => {
          const amount = toNumber(entry.amount);
          const { dr, cr } = getDrCr(amount);
          detailRows.push({
            'Voucher Number': row.voucherNumber,
            Date: toDDMMYYYY(row.date),
            'Voucher Type': row.voucherType || '-',
            Ledger: entry.Ledger || '-',
            Group: entry.Group || '-',
            Primary: entry.TallyPrimary || '-',
            Narration: entry.narration || row.narration || '-',
            Dr: dr,
            Cr: cr,
            'Selected Ledger': selectedLedger,
            'Is Selected Ledger': String(entry.Ledger || '').trim().toLowerCase() === selectedLedger.toLowerCase() ? 'Yes' : 'No',
          });
        });
      });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Statement Summary');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(statementRows), 'Ledger Statement');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), 'Voucher Entries');
      const dt = new Date();
      const stamp = `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
      XLSX.writeFile(wb, `Ledger_Statement_${stamp}.xlsx`, { compression: true });
    } catch (error) {
      console.error(error);
      window.alert('Unable to export ledger statement Excel. Please retry.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm lg:col-span-2">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Selected Ledger</p>
          <p className="text-base font-black text-slate-900 mt-1 truncate" title={selectedLedger || '-'}>
            {selectedLedger || '-'}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Opening</p>
          <p className={`text-xl font-black mt-1 ${statementData.openingAtRangeStart < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
            {formatBalance(statementData.openingAtRangeStart)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Period Net</p>
          <p className={`text-xl font-black mt-1 ${statementData.periodTotals.net < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
            {formatBalance(statementData.periodTotals.net)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Closing</p>
          <p className={`text-xl font-black mt-1 ${statementData.closingAtRangeEnd < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
            {formatBalance(statementData.closingAtRangeEnd)}
          </p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-3">
          <div className="xl:col-span-3">
            <select
              value={selectedLedger}
              onChange={(e) => setSelectedLedger(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            >
              {allLedgers.length === 0 && <option value="">No ledgers found</option>}
              {allLedgers.map((ledger) => (
                <option key={ledger} value={ledger}>
                  {ledger}
                </option>
              ))}
            </select>
          </div>

          <div className="xl:col-span-2">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div className="xl:col-span-2">
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div className="relative xl:col-span-3">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search voucher / type / party / narration"
              className="w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <button
            onClick={resetPeriod}
            className="xl:col-span-1 px-3 py-2 rounded-lg text-sm font-bold border border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            Reset
          </button>

          <button
            onClick={exportExcel}
            className="xl:col-span-1 px-4 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2"
          >
            <Download size={15} />
            XLS
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
            <p className="text-slate-500">Rows (Period)</p>
            <p className="font-bold text-slate-900">
              {isSqlQueryMode ? sqlMeta.periodRowsCount : statementData.periodRows.length}
            </p>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
            <p className="text-slate-500">Rows (Shown)</p>
            <p className="font-bold text-slate-900">
              {isSqlQueryMode ? sqlMeta.visibleRowsCount : statementData.visibleRows.length}
            </p>
          </div>
          <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2">
            <p className="text-rose-600">Period Dr</p>
            <p className="font-bold text-rose-700">{formatAmount(statementData.periodTotals.dr)}</p>
          </div>
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
            <p className="text-emerald-600">Period Cr</p>
            <p className="font-bold text-emerald-700">{formatAmount(statementData.periodTotals.cr)}</p>
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <p className="text-amber-700">Reconciliation Diff</p>
            <p className={`font-bold ${statementData.reconciliationDiff && Math.abs(statementData.reconciliationDiff) > 0.01 ? 'text-red-700' : 'text-emerald-700'}`}>
              {statementData.reconciliationDiff === null ? 'N/A' : formatAmount(statementData.reconciliationDiff)}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={expandAll}
            className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            Expand All
          </button>
          <button
            onClick={collapseAll}
            className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            Collapse All
          </button>
        </div>

        {isSqlQueryMode && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3 text-xs">
            <div className="flex items-center gap-2 text-slate-600">
              <span>Rows per page</span>
              <select
                value={sqlPageSize}
                onChange={(event) => setSqlPageSize(Number(event.target.value))}
                className="rounded border border-slate-300 px-2 py-1 text-xs"
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
              <span>
                Page {sqlMeta.page} of {Math.max(1, sqlMeta.totalPages)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSqlPage((prev) => Math.max(1, prev - 1))}
                disabled={sqlMeta.page <= 1 || sqlLoading}
                className={`px-3 py-1.5 rounded border font-semibold ${
                  sqlMeta.page <= 1 || sqlLoading
                    ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                Prev
              </button>
              <button
                onClick={() => setSqlPage((prev) => Math.min(Math.max(1, sqlMeta.totalPages), prev + 1))}
                disabled={sqlMeta.page >= Math.max(1, sqlMeta.totalPages) || sqlLoading}
                className={`px-3 py-1.5 rounded border font-semibold ${
                  sqlMeta.page >= Math.max(1, sqlMeta.totalPages) || sqlLoading
                    ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {sqlLoading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-800">
          Loading ledger statement page from SQL...
        </div>
      )}
      {sqlError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">
          {sqlError}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {statementData.visibleRows.length === 0 && (
          <div className="px-4 py-3 text-sm text-amber-700 bg-amber-50 border-b border-amber-200">
            No voucher rows in current period/search. Showing Opening and Closing balances only.
          </div>
        )}
        
          <div className="overflow-x-auto">
            <table className="min-w-[1250px] w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left font-bold">Date</th>
                  <th className="px-4 py-3 text-left font-bold">Particulars</th>
                  <th className="px-4 py-3 text-left font-bold">Voucher Type</th>
                  <th className="px-4 py-3 text-left font-bold">Voucher Number</th>
                  <th className="px-4 py-3 text-right font-bold">Dr</th>
                  <th className="px-4 py-3 text-right font-bold">Cr</th>
                  <th className="px-4 py-3 text-right font-bold">Balance</th>
                  <th className="px-4 py-3 text-left font-bold">Entries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tableRows.map((row) => {
                  const sourceRow = row.sourceRow;
                  const isVoucherRow = row.kind === 'voucher' && !!sourceRow;
                  const isExpanded = isVoucherRow ? expandedRows[sourceRow.key] ?? false : false;
                  const isBoundaryRow = row.kind === 'opening' || row.kind === 'closing';

                  return (
                    <React.Fragment key={row.key}>
                      <tr
                        className={isBoundaryRow ? 'bg-blue-50/40' : 'hover:bg-slate-50'}
                        style={{ contentVisibility: 'auto', containIntrinsicSize: '52px' }}
                      >
                        <td className="px-4 py-3">{row.date}</td>
                        <td className={`px-4 py-3 ${isBoundaryRow ? 'font-bold text-slate-900' : 'text-slate-800'}`}>
                          <div className="max-w-[280px] truncate" title={row.particulars}>
                            {row.particulars}
                          </div>
                          {isVoucherRow && sourceRow?.narration && (
                            <div className="text-xs text-slate-400 max-w-[280px] truncate" title={sourceRow.narration}>
                              {sourceRow.narration}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">{row.voucherType}</td>
                        <td className="px-4 py-3 font-semibold text-slate-900">{row.voucherNumber}</td>
                        <td className="px-4 py-3 text-right font-mono text-rose-700">{row.dr ? formatAmount(row.dr) : '-'}</td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-700">{row.cr ? formatAmount(row.cr) : '-'}</td>
                        <td className={`px-4 py-3 text-right font-mono font-semibold ${row.balance < 0 ? 'text-rose-700' : row.balance > 0 ? 'text-emerald-700' : 'text-slate-600'}`}>
                          {formatBalance(row.balance)}
                        </td>
                        <td className="px-4 py-3">
                          {isVoucherRow ? (
                            <button
                              onClick={() =>
                                setExpandedRows((prev) => ({
                                  ...prev,
                                  [sourceRow.key]: !isExpanded,
                                }))
                              }
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                            >
                              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              {isExpanded ? 'Hide' : 'Show'}
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400">-</span>
                          )}
                        </td>
                      </tr>

                      {isVoucherRow && isExpanded && sourceRow && (
                        <tr className="bg-slate-50">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                              <table className="w-full text-xs">
                                <thead className="bg-slate-100 text-slate-600 uppercase tracking-wide">
                                  <tr>
                                    <th className="px-3 py-2 text-left">Ledger</th>
                                    <th className="px-3 py-2 text-left">Group</th>
                                    <th className="px-3 py-2 text-left">Primary</th>
                                    <th className="px-3 py-2 text-left">Narration</th>
                                    <th className="px-3 py-2 text-right">Dr</th>
                                    <th className="px-3 py-2 text-right">Cr</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {sourceRow.entries.map((entry, idx) => {
                                    const { dr, cr } = getDrCr(toNumber(entry.amount));
                                    const isSelectedLedgerEntry =
                                      String(entry.Ledger || '').trim().toLowerCase() === selectedLedger.toLowerCase();
                                    return (
                                      <tr key={`${sourceRow.key}-${idx}`} className={isSelectedLedgerEntry ? 'bg-blue-50/60' : 'hover:bg-slate-50'}>
                                        <td className="px-3 py-2 font-medium">
                                          {entry.Ledger || '-'}
                                          {isSelectedLedgerEntry && (
                                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-200">
                                              Selected
                                            </span>
                                          )}
                                        </td>
                                        <td className="px-3 py-2">{entry.Group || '-'}</td>
                                        <td className="px-3 py-2">{entry.TallyPrimary || '-'}</td>
                                        <td className="px-3 py-2 max-w-[260px] truncate" title={entry.narration || '-'}>
                                          {entry.narration || '-'}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-rose-700">{dr ? formatAmount(dr) : '-'}</td>
                                        <td className="px-3 py-2 text-right font-mono text-emerald-700">{cr ? formatAmount(cr) : '-'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
    </div>
  );
};

export default LedgerVoucherView;
