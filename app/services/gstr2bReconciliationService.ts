import { LedgerEntry } from '../types';

export interface Gstr2BImportMeta {
  importId: string;
  sourceName: string;
  uploadedAt: string;
  rtnprd: string;
  entityGstin: string;
  version: string;
  generatedAt: string;
  counts: {
    totalDocuments: number;
    b2bDocuments: number;
    cdnrDocuments: number;
    b2baDocuments: number;
  };
  totals: {
    taxable?: number;
    igst?: number;
    cgst?: number;
    sgst?: number;
    cess?: number;
    totalTax?: number;
    totalValue?: number;
  };
}

export interface Gstr2BRunRef {
  runId: string;
  importId: string;
  importIds?: string[];
  createdAt: string;
  scope: {
    month: string;
    months?: string[];
    entityGstin: string;
    branch: string;
  };
  counts: Record<string, number>;
  summary: Record<string, any>;
}

export interface Gstr2BRunPayload {
  importId?: string;
  importIds?: string[];
  scope: {
    month?: string;
    months?: string[];
    entityGstin?: string;
    branch?: string;
  };
  config: {
    enableDateTolerance: boolean;
    dateToleranceDays: number;
    invTolerance: number;
    gstTolerance: number;
  };
  booksRows: LedgerEntry[];
  selectedGstLedgers: string[];
  selectedRcmLedgers: string[];
}

const parseJsonSafe = async (response: Response): Promise<any> => {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return { ok: false, error: await response.text() };
};

const ensureOk = async (response: Response, fallbackMessage: string) => {
  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || fallbackMessage);
  }
  return payload;
};

export const importGstr2BJson = async (jsonText: string, sourceName = 'gstr2b.json'): Promise<Gstr2BImportMeta> => {
  const response = await fetch('/api/gstr2b/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonText, sourceName }),
  });
  const payload = await ensureOk(response, 'Unable to import GSTR-2B JSON.');
  return payload.import as Gstr2BImportMeta;
};

export const listGstr2BImports = async (): Promise<Gstr2BImportMeta[]> => {
  const response = await fetch('/api/gstr2b/imports');
  const payload = await ensureOk(response, 'Unable to fetch GSTR-2B imports.');
  return Array.isArray(payload.imports) ? payload.imports : [];
};

export const clearGstr2BImports = async (importIds: string[] = []): Promise<{ importsCleared: number; rowsCleared: number; runsCleared: number; clearedAll: boolean }> => {
  const response = await fetch('/api/gstr2b/imports/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ importIds }),
  });
  const payload = await ensureOk(response, 'Unable to clear GSTR-2B imports.');
  return {
    importsCleared: Number(payload.importsCleared || 0),
    rowsCleared: Number(payload.rowsCleared || 0),
    runsCleared: Number(payload.runsCleared || 0),
    clearedAll: !!payload.clearedAll,
  };
};

export const getGstr2BImport = async (importId: string): Promise<{ import: Gstr2BImportMeta; rows: any[] }> => {
  const response = await fetch(`/api/gstr2b/imports/${encodeURIComponent(importId)}`);
  const payload = await ensureOk(response, 'Unable to fetch GSTR-2B import details.');
  return {
    import: payload.import as Gstr2BImportMeta,
    rows: Array.isArray(payload.rows) ? payload.rows : [],
  };
};

export const runGstr2BReconciliation = async (payload: Gstr2BRunPayload): Promise<{ runId: string; createdAt: string; result: any }> => {
  const response = await fetch('/api/gstr2b/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await ensureOk(response, 'Unable to run GSTR-2B reconciliation.');
  return {
    runId: String(parsed.runId || ''),
    createdAt: String(parsed.createdAt || ''),
    result: parsed.result,
  };
};

export const listGstr2BRuns = async (): Promise<Gstr2BRunRef[]> => {
  const response = await fetch('/api/gstr2b/runs');
  const payload = await ensureOk(response, 'Unable to fetch reconciliation runs.');
  return Array.isArray(payload.runs) ? payload.runs : [];
};

export const getGstr2BRun = async (runId: string): Promise<any> => {
  const response = await fetch(`/api/gstr2b/runs/${encodeURIComponent(runId)}`);
  const payload = await ensureOk(response, 'Unable to fetch reconciliation run details.');
  return payload.run;
};

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
};

export const downloadGstr2BRunXlsx = async (runId: string) => {
  const response = await fetch(`/api/gstr2b/runs/${encodeURIComponent(runId)}/export-xlsx`);
  if (!response.ok) {
    const payload = await parseJsonSafe(response);
    throw new Error(payload?.error || 'Unable to export Excel report.');
  }
  const blob = await response.blob();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `GSTR2B_Reconciliation_${stamp}.xlsx`);
};

export const downloadGstr2BRunJson = async (runId: string) => {
  const response = await fetch(`/api/gstr2b/runs/${encodeURIComponent(runId)}/export-json`);
  if (!response.ok) {
    const payload = await parseJsonSafe(response);
    throw new Error(payload?.error || 'Unable to export JSON report.');
  }
  const blob = await response.blob();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `GSTR2B_Reconciliation_${stamp}.json`);
};
