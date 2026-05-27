import { LedgerEntry } from '../types';

export interface SqlLoadSummary {
  totalRows: number;
  uniqueVouchers: number;
  minDate: string;
  maxDate: string;
}

const jsonHeaders = { 'Content-Type': 'application/json' };
const NETWORK_HINT =
  'Cannot reach local API server. Start/restart using run_software.bat and open http://127.0.0.1:5173.';

const parseJsonSafe = async (response: Response): Promise<any> => {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { ok: false, error: await response.text() };
};

export const isSqlBackendAvailable = async (): Promise<boolean> => {
  try {
    const response = await fetch('/api/data/health');
    if (!response.ok) return false;
    const payload = await parseJsonSafe(response);
    return !!payload?.ok;
  } catch {
    return false;
  }
};

export const loadRowsIntoSql = async (rows: LedgerEntry[]): Promise<SqlLoadSummary> => {
  let response: Response;
  try {
    response = await fetch('/api/data/load', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ rows }),
    });
  } catch {
    throw new Error(NETWORK_HINT);
  }
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to load dataset into SQL backend.');
  }
  return payload.summary as SqlLoadSummary;
};

export const fetchRowsFromSql = async (): Promise<LedgerEntry[]> => {
  let response: Response;
  try {
    response = await fetch('/api/data/rows');
  } catch {
    throw new Error(NETWORK_HINT);
  }
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to fetch rows from SQL backend.');
  }
  return Array.isArray(payload.rows) ? payload.rows : [];
};

/**
 * Filtered + paginated row fetch. Pushes the WHERE/LIMIT/OFFSET into SQL
 * (using the indexes added in the perf overhaul) so we don't ship the
 * full ledger over HTTP just for the client to throw most of it away.
 *
 * Pass any subset of filters; pass `limit > 0` to enable pagination.
 * Returns { rows, total } where `total` is pre-pagination count.
 */
export type RowsPageFilters = {
  from?: string;
  to?: string;
  voucherTypes?: string[];
  ledgers?: string[];
  parties?: string[];
  gstin?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export type RowsPageResponse = {
  rows: LedgerEntry[];
  total: number;
  limit: number;
  offset: number;
};

export const fetchRowsPage = async (filters: RowsPageFilters): Promise<RowsPageResponse> => {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.voucherTypes?.length) params.set('voucherType', filters.voucherTypes.join(','));
  if (filters.ledgers?.length) params.set('ledger', filters.ledgers.join(','));
  if (filters.parties?.length) params.set('party', filters.parties.join(','));
  if (filters.gstin) params.set('gstin', filters.gstin);
  if (filters.search) params.set('search', filters.search);
  if (filters.limit && filters.limit > 0) params.set('limit', String(filters.limit));
  if (filters.offset && filters.offset > 0) params.set('offset', String(filters.offset));

  // Always send at least one param so the backend takes the paginated
  // branch — bare /api/data/rows preserves legacy behaviour and would
  // ignore filters we set above.
  if (params.toString().length === 0) {
    params.set('limit', '0');
  }

  let response: Response;
  try {
    response = await fetch(`/api/data/rows?${params.toString()}`);
  } catch {
    throw new Error(NETWORK_HINT);
  }
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to fetch rows page from SQL backend.');
  }
  return {
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    total: Number(payload.total || 0),
    limit: Number(payload.limit || 0),
    offset: Number(payload.offset || 0),
  };
};

export const fetchSqlSummary = async (): Promise<SqlLoadSummary> => {
  let response: Response;
  try {
    response = await fetch('/api/data/summary');
  } catch {
    throw new Error(NETWORK_HINT);
  }
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to fetch SQL dataset summary.');
  }
  return payload.summary as SqlLoadSummary;
};

export const clearSqlData = async (): Promise<void> => {
  try {
    await fetch('/api/data/clear', {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
  } catch {
    // Best-effort cleanup.
  }
};

