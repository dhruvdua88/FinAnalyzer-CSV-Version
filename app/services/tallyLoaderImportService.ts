import { LedgerEntry } from '../types';
import Papa from 'papaparse';

type GenericRow = Record<string, any>;

const REQUIRED_TABLES = ['trn_accounting', 'trn_voucher'] as const;
const OPTIONAL_TABLES = ['mst_ledger', 'mst_group'] as const;
const SUPPORTED_EXTENSIONS = ['.json', '.csv'];

const stripBom = (text: string): string => text.replace(/^\uFEFF/, '');

const normalizeTableName = (name: string): string =>
  name.trim().toLowerCase().replace(/\.(json|csv)$/i, '');

const normalizeNameKey = (value: any): string =>
  toText(value).replace(/\s+/g, ' ').toLowerCase();

const normalizeRowKeys = (row: GenericRow): GenericRow => {
  const normalized: GenericRow = {};
  Object.keys(row || {}).forEach((key) => {
    normalized[key.trim().toLowerCase()] = row[key];
  });
  return normalized;
};

const toText = (value: any): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const toNumber = (value: any): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const asText = toText(value).replace(/,/g, '');
  if (!asText) return 0;
  const parsed = Number(asText);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toLogicalNumber = (value: any): number => {
  const text = toText(value).toLowerCase();
  if (text === 'true' || text === 'yes') return 1;
  if (text === 'false' || text === 'no') return 0;
  return toNumber(value) > 0 ? 1 : 0;
};

const toBoolean = (value: any): boolean => {
  const text = toText(value).toLowerCase();
  return text === 'true' || text === 'yes' || text === '1';
};

const toIsoDate = (value: any): string => {
  const text = toText(value);
  if (!text) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) {
    return `${text.substring(0, 4)}-${text.substring(4, 6)}-${text.substring(6, 8)}`;
  }

  const ddmmyyyy = text.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }

  const ddmmyy = text.match(/^(\d{2})[/-](\d{2})[/-](\d{2})$/);
  if (ddmmyy) {
    const year = Number(ddmmyy[3]) < 70 ? `20${ddmmyy[3]}` : `19${ddmmyy[3]}`;
    return `${year}-${ddmmyy[2]}-${ddmmyy[1]}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return text;
};

/**
 * Parse a CSV File directly via PapaParse in a Web Worker.
 *
 * Two wins versus the previous `await file.text()` → `Papa.parse(string)`
 * pattern that ran on the main thread:
 *
 *   1. worker: true — parse runs off the main thread, so the React UI
 *      stays responsive while a 100k+ row Tally loader CSV is parsed.
 *   2. Streaming the File directly — Papa pulls chunks via the File API
 *      instead of us materialising the entire CSV as a single string
 *      first. Roughly halves peak memory on big imports.
 *
 * Note on BOM: Papa handles UTF-8 BOM detection itself when reading from
 * a File, so the explicit stripBom() that wrapped file.text() is no
 * longer needed for the streaming path.
 */
const parseCsvFile = (file: File): Promise<GenericRow[]> => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      worker: true,
      complete: (results: any) => resolve((results?.data || []).map(normalizeRowKeys)),
      error: (err: any) => reject(err),
    });
  });
};

const parseTableFile = async (file: File): Promise<GenericRow[]> => {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

  if (extension === '.json') {
    // JSON has no streaming parser in the standard library, so we still
    // need to materialise the file into a string before JSON.parse.
    const content = stripBom(await file.text());
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error(`File ${file.name} is not a JSON array.`);
    }
    return parsed.map(normalizeRowKeys);
  }

  if (extension === '.csv') {
    return parseCsvFile(file);
  }

  throw new Error(`Unsupported file format for ${file.name}.`);
};

const pickPreferredFile = (existing: File | undefined, next: File): File => {
  if (!existing) return next;
  const existingExt = existing.name.slice(existing.name.lastIndexOf('.')).toLowerCase();
  const nextExt = next.name.slice(next.name.lastIndexOf('.')).toLowerCase();
  if (existingExt === '.csv' && nextExt === '.json') return next;
  return existing;
};

const buildTableFileMap = (files: File[]): Map<string, File> => {
  const tableFileMap = new Map<string, File>();
  files.forEach((file) => {
    const lower = file.name.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) return;
    const tableName = normalizeTableName(file.name);
    tableFileMap.set(tableName, pickPreferredFile(tableFileMap.get(tableName), file));
  });
  return tableFileMap;
};

const requireTables = (tableFileMap: Map<string, File>) => {
  const missing = REQUIRED_TABLES.filter((name) => !tableFileMap.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Tally Loader import requires ${missing.join(', ')} file(s) in CSV or JSON format.`
    );
  }
};

export const isTallyLoaderSelection = (inputFiles: FileList | File[]): boolean => {
  const files = Array.from(inputFiles as ArrayLike<File>);
  const tableNames = new Set(files.map((file) => normalizeTableName(file.name)));
  return REQUIRED_TABLES.every((requiredTable) => tableNames.has(requiredTable));
};

export const parseTallyLoaderDump = async (inputFiles: FileList | File[]): Promise<LedgerEntry[]> => {
  const files = Array.from(inputFiles as ArrayLike<File>);
  const tableFileMap = buildTableFileMap(files);

  requireTables(tableFileMap);

  const tableNames = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
  const tableDataMap = new Map<string, GenericRow[]>();

  await Promise.all(
    tableNames.map(async (tableName) => {
      const file = tableFileMap.get(tableName);
      if (!file) return;
      tableDataMap.set(tableName, await parseTableFile(file));
    })
  );

  const voucherRows = tableDataMap.get('trn_voucher') || [];
  const accountingRows = tableDataMap.get('trn_accounting') || [];
  const ledgerRows = tableDataMap.get('mst_ledger') || [];
  const groupRows = tableDataMap.get('mst_group') || [];

  const voucherByGuid = new Map<string, GenericRow>();
  voucherRows.forEach((row) => {
    const guid = toText(row.guid).toLowerCase();
    if (guid) voucherByGuid.set(guid, row);
  });

  const ledgerByName = new Map<string, GenericRow>();
  ledgerRows.forEach((row) => {
    const name = normalizeNameKey(row.name);
    if (name) ledgerByName.set(name, row);
  });

  const groupByName = new Map<string, GenericRow>();
  groupRows.forEach((row) => {
    const name = normalizeNameKey(row.name);
    if (name) groupByName.set(name, row);
  });

  const now = Date.now();
  const syntheticVoucherByGuid = new Map<string, string>();
  let nextSyntheticVoucherCounter = 1;
  const getSyntheticVoucherNumber = (guidKey: string): string => {
    const key = toText(guidKey).toLowerCase() || '__unknown_guid__';
    if (!syntheticVoucherByGuid.has(key)) {
      syntheticVoucherByGuid.set(key, `UNKNOWN-${nextSyntheticVoucherCounter}`);
      nextSyntheticVoucherCounter += 1;
    }
    return syntheticVoucherByGuid.get(key)!;
  };

  const result: LedgerEntry[] = accountingRows.flatMap((accountingRow, index) => {
    const guid = toText(accountingRow.guid);
    const guidKey = guid.toLowerCase();
    const voucher = voucherByGuid.get(guidKey) || {};
    // Exclude non-accounting vouchers (e.g., Delivery Note) to avoid duplicate ledger impact.
    if (!toBoolean(voucher.is_accounting_voucher)) return [];

    const ledgerName = toText(accountingRow.ledger) || 'Unknown Ledger';
    const ledger = ledgerByName.get(normalizeNameKey(ledgerName)) || {};
    const groupName = toText(ledger.parent);
    const group = groupByName.get(normalizeNameKey(groupName)) || {};

    const date = toIsoDate(voucher.date);
    const voucherNumber =
      toText(voucher.voucher_number) || getSyntheticVoucherNumber(guidKey || `__row_${index + 1}`);
    const referenceNumber = toText(voucher.reference_number);

    return [{
      guid: guid ? `${guid}-${index}` : `loader-${now}-${index}`,
      date,
      voucher_type: toText(voucher.voucher_type),
      voucher_number: voucherNumber,
      invoice_number: referenceNumber,
      reference_number: referenceNumber,
      narration: toText(voucher.narration),
      party_name: toText(voucher.party_name),
      gstin: toText(ledger.gstn),
      Ledger: ledgerName,
      amount: toNumber(accountingRow.amount),
      Group: groupName,
      opening_balance: toNumber(ledger.opening_balance),
      closing_balance: toNumber(ledger.closing_balance),
      TallyParent: groupName,
      TallyPrimary: toText(group.primary_group),
      is_revenue: toLogicalNumber(ledger.is_revenue),
      is_accounting_voucher: 1,
      is_master_ledger: 0,
    }];
  });

  const ledgerSeenInAccounting = new Set(result.map((row) => normalizeNameKey(row.Ledger)));
  const masterOnlyRows: LedgerEntry[] = ledgerRows
    .map((ledgerRow, index) => {
      const ledgerName = toText(ledgerRow.name) || `Unknown Ledger ${index + 1}`;
      const key = normalizeNameKey(ledgerName);
      if (!key || ledgerSeenInAccounting.has(key)) return null;

      const parent = toText(ledgerRow.parent);
      const group = groupByName.get(normalizeNameKey(parent)) || {};
      return {
        guid: `ledger-master-${now}-${index}`,
        date: '',
        voucher_type: '__MASTER_LEDGER__',
        voucher_number: `__MASTER_LEDGER__${index + 1}`,
        invoice_number: '',
        reference_number: '',
        narration: 'Ledger master balance row',
        party_name: '',
        gstin: toText(ledgerRow.gstn),
        Ledger: ledgerName,
        amount: 0,
        Group: parent,
        opening_balance: toNumber(ledgerRow.opening_balance),
        closing_balance: toNumber(ledgerRow.closing_balance),
        TallyParent: parent,
        TallyPrimary: toText(group.primary_group),
        is_revenue: toLogicalNumber(ledgerRow.is_revenue),
        is_accounting_voucher: 1,
        is_master_ledger: 1,
      } as LedgerEntry;
    })
    .filter((row): row is LedgerEntry => !!row);

  result.push(...masterOnlyRows);

  if (result.length === 0) {
    throw new Error('No accounting rows found in trn_accounting file.');
  }

  return result;
};
