import { LedgerEntry } from '../types';

const NETWORK_HINT =
  'Cannot reach local API server. Start/restart using run_software.bat and open http://127.0.0.1:5173.';

const parseJsonSafe = async (response: Response): Promise<any> => {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { ok: false, error: await response.text() };
};

const postJson = async (url: string, body: any) => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch {
    throw new Error(NETWORK_HINT);
  }
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Failed to call ${url}.`);
  }
  return payload;
};

export const fetchSqlAnalyticsMonths = async (): Promise<string[]> => {
  let response: Response;
  try {
    response = await fetch('/api/analytics/months');
  } catch {
    throw new Error(NETWORK_HINT);
  }
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to fetch available analytics months.');
  }
  return Array.isArray(payload?.months) ? payload.months.map((m: any) => String(m || '')).filter(Boolean) : [];
};

export interface SqlPnlParentLedger {
  ledger: string;
  total: number;
  entries: number;
}

export interface SqlPnlParentBreakup {
  parent: string;
  total: number;
  ledgers: SqlPnlParentLedger[];
}

export interface SqlPnlPrimaryBucket {
  primary: string;
  total: number;
  revenueFlagCount: number;
  explicitPnlCount: number;
  explicitBsCount: number;
  likelyBalanceSheet: boolean;
  hasStockOrInventoryWord: boolean;
  parentNames: string[];
  parentBreakup: SqlPnlParentBreakup[];
}

export interface SqlPnlAnalyticsPayload {
  months: string[];
  primaryBuckets: SqlPnlPrimaryBucket[];
  stockLedgerTotals: Array<{ ledger: string; amount: number }>;
  defaultOpeningStock: number;
  defaultClosingStock: number;
}

export const fetchSqlPnlAnalytics = async (months: string[]): Promise<SqlPnlAnalyticsPayload> => {
  const payload = await postJson('/api/analytics/pnl', { months: Array.isArray(months) ? months : [] });
  return {
    months: Array.isArray(payload?.months) ? payload.months.map((m: any) => String(m || '')).filter(Boolean) : [],
    primaryBuckets: Array.isArray(payload?.primaryBuckets) ? payload.primaryBuckets : [],
    stockLedgerTotals: Array.isArray(payload?.stockLedgerTotals) ? payload.stockLedgerTotals : [],
    defaultOpeningStock: Number(payload?.defaultOpeningStock || 0),
    defaultClosingStock: Number(payload?.defaultClosingStock || 0),
  };
};

export const fetchSqlModuleRows = async (params: {
  module: 'sales' | 'purchase';
  months?: string[];
  selectedLedgers?: string[];
  selectedRcmLedgers?: string[];
}): Promise<LedgerEntry[]> => {
  const payload = await postJson('/api/analytics/module-rows', {
    module: params.module,
    months: Array.isArray(params.months) ? params.months : [],
    selectedLedgers: Array.isArray(params.selectedLedgers) ? params.selectedLedgers : [],
    selectedRcmLedgers: Array.isArray(params.selectedRcmLedgers) ? params.selectedRcmLedgers : [],
  });
  return Array.isArray(payload?.rows) ? payload.rows : [];
};

export interface SqlVoucherBookPageRow {
  key: string;
  voucherNumber: string;
  date: string;
  voucherType: string;
  party: string;
  narration: string;
  entries: LedgerEntry[];
  totalDr: number;
  totalCr: number;
  lineCount: number;
}

export interface SqlVoucherBookPagePayload {
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  totals: { vouchers: number; lines: number; dr: number; cr: number };
  rows: SqlVoucherBookPageRow[];
}

export const fetchSqlVoucherBookPage = async (params: {
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<SqlVoucherBookPagePayload> => {
  const payload = await postJson('/api/analytics/voucher-book/page', {
    search: String(params.search || ''),
    page: Number(params.page || 1),
    pageSize: Number(params.pageSize || 50),
  });

  return {
    page: Number(payload?.page || 1),
    pageSize: Number(payload?.pageSize || 50),
    totalRows: Number(payload?.totalRows || 0),
    totalPages: Number(payload?.totalPages || 1),
    totals: {
      vouchers: Number(payload?.totals?.vouchers || 0),
      lines: Number(payload?.totals?.lines || 0),
      dr: Number(payload?.totals?.dr || 0),
      cr: Number(payload?.totals?.cr || 0),
    },
    rows: Array.isArray(payload?.rows) ? payload.rows : [],
  };
};

export const fetchSqlLedgerList = async (): Promise<string[]> => {
  let response: Response;
  try {
    response = await fetch('/api/analytics/ledgers');
  } catch {
    throw new Error(NETWORK_HINT);
  }
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to fetch ledger list.');
  }
  return Array.isArray(payload?.ledgers) ? payload.ledgers.map((value: any) => String(value || '')).filter(Boolean) : [];
};

export interface SqlLedgerVoucherPageRow {
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
  balance: number;
  entries: LedgerEntry[];
}

export interface SqlLedgerVoucherPagePayload {
  ledger: string;
  periodFrom: string;
  periodTo: string;
  hasOpening: boolean;
  hasClosing: boolean;
  openingAtRangeStart: number;
  closingAtRangeEnd: number;
  referenceClosingAtRangeEnd: number | null;
  reconciliationDiff: number | null;
  periodTotals: { dr: number; cr: number; net: number };
  periodRowsCount: number;
  visibleRowsCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  rows: SqlLedgerVoucherPageRow[];
}

export const fetchSqlLedgerVoucherPage = async (params: {
  ledger: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<SqlLedgerVoucherPagePayload> => {
  const payload = await postJson('/api/analytics/ledger-voucher/page', {
    ledger: String(params.ledger || ''),
    fromDate: String(params.fromDate || ''),
    toDate: String(params.toDate || ''),
    search: String(params.search || ''),
    page: Number(params.page || 1),
    pageSize: Number(params.pageSize || 50),
  });

  return {
    ledger: String(payload?.ledger || ''),
    periodFrom: String(payload?.periodFrom || ''),
    periodTo: String(payload?.periodTo || ''),
    hasOpening: !!payload?.hasOpening,
    hasClosing: !!payload?.hasClosing,
    openingAtRangeStart: Number(payload?.openingAtRangeStart || 0),
    closingAtRangeEnd: Number(payload?.closingAtRangeEnd || 0),
    referenceClosingAtRangeEnd:
      payload?.referenceClosingAtRangeEnd === null || payload?.referenceClosingAtRangeEnd === undefined
        ? null
        : Number(payload?.referenceClosingAtRangeEnd),
    reconciliationDiff:
      payload?.reconciliationDiff === null || payload?.reconciliationDiff === undefined
        ? null
        : Number(payload?.reconciliationDiff),
    periodTotals: {
      dr: Number(payload?.periodTotals?.dr || 0),
      cr: Number(payload?.periodTotals?.cr || 0),
      net: Number(payload?.periodTotals?.net || 0),
    },
    periodRowsCount: Number(payload?.periodRowsCount || 0),
    visibleRowsCount: Number(payload?.visibleRowsCount || 0),
    page: Number(payload?.page || 1),
    pageSize: Number(payload?.pageSize || 50),
    totalPages: Number(payload?.totalPages || 1),
    rows: Array.isArray(payload?.rows) ? payload.rows : [],
  };
};
