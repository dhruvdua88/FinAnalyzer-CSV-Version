import path from 'path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as XLSX from 'xlsx';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const cjsRequire = createRequire(import.meta.url);
const {
  parse2BJson,
  normalizeBooks,
  reconcile,
  exportXlsx,
} = cjsRequire('./desktop-backend/services/gstr2bReconciliation.cjs');

// better-sqlite3 is loaded via createRequire because it's a CommonJS native
// addon and this file is ESM. The module exports a constructor function.
const Database = cjsRequire('better-sqlite3') as any;

// Shared schema/PRAGMA/hash helpers — see desktop-backend/services/auditDbCore.cjs.
// Single source of truth for the schema; both vite dev server and the SEA
// backend read from the same `audit.sqlite` file at the same path.
const {
  resolveAuditDbPath,
  applyAuditPragmas,
  initializeAuditSchema,
  hashRows,
  getLastImportHash,
  recordImport,
} = cjsRequire('./desktop-backend/services/auditDbCore.cjs') as {
  resolveAuditDbPath: () => string;
  applyAuditPragmas: (db: any) => void;
  initializeAuditSchema: (db: any) => void;
  hashRows: (rows: any[]) => string;
  getLastImportHash: (db: any) => { source_hash: string; row_count: number; imported_at: string } | null;
  recordImport: (db: any, sourceHash: string, rowCount: number) => void;
};

const DEFAULT_LOADER_ROOT_CANDIDATES = [
  path.resolve(__dirname, 'tally-database-loader-main (1)', 'tally-database-loader-main'),
  path.resolve(__dirname, 'tally-database-loader-main'),
];
const REQUIRED_TABLES = ['trn_accounting', 'trn_voucher'] as const;
const OPTIONAL_TABLES = ['mst_ledger', 'mst_group'] as const;

type TablePayload = {
  filename: string;
  content: string;
};

let loaderProcessRunning = false;
let loaderProcessRef: ReturnType<typeof spawn> | null = null;
let lastLoaderError = '';
let lastRunAt = '';
let preferredLoaderRoot = '';
let lastResolvedLoaderRoot = '';
const loaderLogs: string[] = [];

const appendLoaderLog = (message: string) => {
  const entry = `[${new Date().toISOString()}] ${message}`;
  loaderLogs.push(entry);
  if (loaderLogs.length > 500) loaderLogs.shift();
};

const sendJson = (res: any, statusCode: number, data: any) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
};

const parseDdMmYyyyToIso = (value: string): string | null => {
  const match = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const dd = Number(match[1]);
  const mm = Number(match[2]);
  const yyyy = Number(match[3]);
  const date = new Date(yyyy, mm - 1, dd);
  if (
    date.getFullYear() !== yyyy ||
    date.getMonth() !== mm - 1 ||
    date.getDate() !== dd
  ) {
    return null;
  }
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};

const normalizeLoaderDateInput = (value: any): string => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const fromDdMm = parseDdMmYyyyToIso(text);
  return fromDdMm || '';
};

const toLoaderCliDate = (isoDate: string): string => String(isoDate || '').replace(/-/g, '');
const newId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

let auditDb: any = null;
let auditLoadedRows = 0;
let gstr2bImports: any[] = [];
const gstr2bRowsByImport = new Map<string, any[]>();
let gstr2bRuns: any[] = [];

const toSafeNumber = (value: any): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toSafeText = (value: any): string => {
  if (value === null || value === undefined) return '';
  return String(value);
};

const toAccountingFlag = (value: any): number => {
  const text = toSafeText(value).trim().toLowerCase();
  if (!text) return 1;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return 1;
  if (text === '0' || text === 'false' || text === 'no' || text === 'n') return 0;
  return toSafeNumber(value) > 0 ? 1 : 0;
};

// Schema, indexes, and PRAGMA tuning live in desktop-backend/services/auditDbCore.cjs.
// Keep this file slim — single source of truth for DB layout.

const getAuditDb = (): any => {
  if (auditDb) return auditDb;

  // Persisted to ~/.finanalyzer/audit.sqlite (or $FINANALYZER_DATA_DIR).
  // Re-opening the same file across server restarts means the user does
  // not pay re-ingest cost on every reload.
  const dbPath = resolveAuditDbPath();
  auditDb = new Database(dbPath);
  applyAuditPragmas(auditDb);
  initializeAuditSchema(auditDb);
  return auditDb;
};

const getAuditSummary = () => {
  const db = getAuditDb();
  const summary = db
    .prepare(`
      SELECT
        COUNT(*) AS totalRows,
        COUNT(DISTINCT voucher_number) AS uniqueVouchers,
        COALESCE(MIN(date), '') AS minDate,
        COALESCE(MAX(date), '') AS maxDate
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
    `)
    .get() as any;

  return {
    totalRows: Number(summary?.totalRows || 0),
    uniqueVouchers: Number(summary?.uniqueVouchers || 0),
    minDate: String(summary?.minDate || ''),
    maxDate: String(summary?.maxDate || ''),
  };
};

const insertAuditRowsIntoDb = (db: any, rows: any[]) => {
  const stmt = db.prepare(`
    INSERT INTO ledger_entries (
      guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
      party_name, gstin, ledger, amount, group_name, opening_balance, closing_balance,
      tally_parent, tally_primary, is_revenue, is_accounting_voucher, is_master_ledger
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedRows = 0;
  rows.forEach((row) => {
    const isAccounting = toAccountingFlag(row?.is_accounting_voucher);
    if (isAccounting !== 1) return;

    stmt.run(
      toSafeText(row?.guid),
      toSafeText(row?.date),
      toSafeText(row?.voucher_type),
      toSafeText(row?.voucher_number),
      toSafeText(row?.invoice_number),
      toSafeText(row?.reference_number),
      toSafeText(row?.narration),
      toSafeText(row?.party_name),
      toSafeText(row?.gstin),
      toSafeText(row?.Ledger),
      toSafeNumber(row?.amount),
      toSafeText(row?.Group),
      toSafeNumber(row?.opening_balance),
      toSafeNumber(row?.closing_balance),
      toSafeText(row?.TallyParent),
      toSafeText(row?.TallyPrimary),
      toSafeNumber(row?.is_revenue) > 0 ? 1 : 0,
      1,
      toSafeNumber(row?.is_master_ledger) > 0 ? 1 : 0
    );
    insertedRows += 1;
  });

  return insertedRows;
};

const buildReferenceCollectionsForExport = (db: any) => {
  // Previously: three CREATE TABLE + DELETE + INSERT...SELECT cycles, plus a
  // correlated NOT EXISTS subquery inside ROW_NUMBER() that re-scanned
  // ledger_entries for every row (catastrophic on 200k+ rows).
  //
  // Now: three VIEWs. SELECT-time materialisation in SQLite is fine for the
  // export use case (a third-party reader opens the file once and SELECTs).
  // The "is there any master row?" check is hoisted into a CTE so it
  // evaluates once instead of per row.
  //
  // Drop any pre-existing physical tables from older export DBs so re-export
  // into the same path doesn't conflict with the view names.
  db.exec(`
    DROP TABLE IF EXISTS trn_accounting;
    DROP TABLE IF EXISTS mst_ledger;
    DROP TABLE IF EXISTS trial_balance_from_mst_ledger;
    DROP VIEW IF EXISTS trn_accounting;
    DROP VIEW IF EXISTS mst_ledger;
    DROP VIEW IF EXISTS trial_balance_from_mst_ledger;

    CREATE VIEW trn_accounting AS
      SELECT
        guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
        party_name, ledger, amount, group_name, tally_parent, tally_primary, gstin,
        is_revenue, is_accounting_voucher
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0;

    CREATE VIEW mst_ledger AS
      WITH master_present AS (
        SELECT EXISTS(
          SELECT 1 FROM ledger_entries WHERE COALESCE(is_master_ledger, 0) = 1
        ) AS has_master
      ),
      candidates AS (
        SELECT
          le.id,
          le.ledger,
          le.group_name,
          le.tally_parent,
          le.tally_primary,
          le.gstin,
          le.is_revenue,
          le.opening_balance,
          le.closing_balance,
          ROW_NUMBER() OVER (
            PARTITION BY le.ledger
            ORDER BY
              CASE WHEN ABS(COALESCE(le.closing_balance, 0)) > 0 THEN 0 ELSE 1 END,
              le.id ASC
          ) AS rn
        FROM ledger_entries le
        CROSS JOIN master_present mp
        WHERE TRIM(COALESCE(le.ledger, '')) <> ''
          AND (
            COALESCE(le.is_master_ledger, 0) = 1
            OR mp.has_master = 0
          )
      )
      SELECT ledger, group_name, tally_parent, tally_primary, gstin, is_revenue,
             opening_balance, closing_balance
      FROM candidates
      WHERE rn = 1;

    CREATE VIEW trial_balance_from_mst_ledger AS
      SELECT
        ledger,
        tally_primary,
        tally_parent,
        opening_balance,
        closing_balance,
        CASE WHEN opening_balance < 0 THEN ABS(opening_balance) ELSE 0 END AS opening_dr,
        CASE WHEN opening_balance > 0 THEN opening_balance ELSE 0 END AS opening_cr,
        CASE WHEN closing_balance < 0 THEN ABS(closing_balance) ELSE 0 END AS closing_dr,
        CASE WHEN closing_balance > 0 THEN closing_balance ELSE 0 END AS closing_cr
      FROM mst_ledger;
  `);
};

const loadAuditRows = (rows: any[]): { insertedRows: number; summary: ReturnType<typeof getAuditSummary> } => {
  const db = getAuditDb();

  // Hash-skip: if the incoming rows are byte-identical to the last successful
  // import, don't pay the DELETE+INSERT cost again. The audit DB is persisted
  // to disk, so the previous data is still there.
  const sourceHash = hashRows(rows);
  const lastImport = getLastImportHash(db);
  if (lastImport && lastImport.source_hash === sourceHash) {
    const summary = getAuditSummary();
    auditLoadedRows = summary.totalRows;
    return { insertedRows: summary.totalRows, summary };
  }

  // Single transaction wraps DELETE + bulk INSERT. better-sqlite3's
  // db.transaction() compiles to a savepoint and is dramatically faster
  // than driving BEGIN/COMMIT manually because it avoids per-statement
  // commit overhead.
  const runImport = db.transaction((batch: any[]) => {
    db.exec('DELETE FROM ledger_entries;');
    const inserted = insertAuditRowsIntoDb(db, batch);
    recordImport(db, sourceHash, inserted);
    return inserted;
  });

  const insertedRows = runImport(rows);
  auditLoadedRows = insertedRows;
  return {
    insertedRows,
    summary: getAuditSummary(),
  };
};

const fetchAuditRows = (): any[] => {
  const db = getAuditDb();
  return db
    .prepare(`
      SELECT
        guid,
        date,
        voucher_type,
        voucher_number,
        invoice_number,
        reference_number,
        narration,
        party_name,
        gstin,
        ledger AS Ledger,
        amount,
        group_name AS "Group",
        opening_balance,
        closing_balance,
        tally_parent AS TallyParent,
        tally_primary AS TallyPrimary,
        is_revenue,
        is_accounting_voucher,
        is_master_ledger
      FROM ledger_entries
      ORDER BY date ASC, voucher_number ASC, id ASC
    `)
    .all() as any[];
};

/**
 * Filter + paginate /api/data/rows.
 *
 * Returns { rows, total } where `total` is the count BEFORE pagination so
 * the client can render "Showing 100-200 of 12,345" affordances. All
 * filters are optional; passing none + no limit reproduces fetchAuditRows().
 *
 * Filters are pushed into SQL (not JS) so a 500k-row dataset doesn't
 * have to be serialised over HTTP just for the client to throw 99% of
 * it away. The parameterised query plus the indexes added in commit 1
 * (date, gstin, party_name, voucher_type+date) keeps these lookups
 * sub-ms even on large books.
 */
type RowsPageFilters = {
  from?: string;          // 'YYYY-MM-DD' inclusive
  to?: string;            // 'YYYY-MM-DD' inclusive
  voucherTypes?: string[];
  ledgers?: string[];
  parties?: string[];
  gstin?: string;
  search?: string;        // free-text against voucher_number / narration / party_name
  limit?: number;         // default 0 = no limit
  offset?: number;
};

const fetchAuditRowsPage = (filters: RowsPageFilters): { rows: any[]; total: number } => {
  const db = getAuditDb();
  const where: string[] = [];
  const params: any[] = [];

  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) {
    where.push('date >= ?');
    params.push(filters.from);
  }
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) {
    where.push('date <= ?');
    params.push(filters.to);
  }
  if (filters.voucherTypes && filters.voucherTypes.length) {
    where.push(`voucher_type IN (${filters.voucherTypes.map(() => '?').join(', ')})`);
    params.push(...filters.voucherTypes);
  }
  if (filters.ledgers && filters.ledgers.length) {
    where.push(`ledger IN (${filters.ledgers.map(() => '?').join(', ')})`);
    params.push(...filters.ledgers);
  }
  if (filters.parties && filters.parties.length) {
    where.push(`party_name IN (${filters.parties.map(() => '?').join(', ')})`);
    params.push(...filters.parties);
  }
  if (filters.gstin) {
    where.push('gstin = ?');
    params.push(filters.gstin);
  }
  if (filters.search) {
    // Free-text fallback. LIKE with leading-% can't use an index but the
    // dataset is already filtered by the params above, so this hits a
    // smaller subset.
    where.push('(voucher_number LIKE ? OR narration LIKE ? OR party_name LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Run the COUNT and the page in one transaction for a consistent snapshot.
  // Without this, an interleaved write between the two could give counts
  // that don't match the rows returned. With WAL + a single-writer model
  // this is largely theoretical, but cheap to do correctly.
  const limit = Math.max(0, Number(filters.limit) || 0);
  const offset = Math.max(0, Number(filters.offset) || 0);

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM ledger_entries ${whereClause}`)
    .get(...params) as any;
  const total = Number(totalRow?.total || 0);

  const limitClause = limit > 0 ? ` LIMIT ${limit} OFFSET ${offset}` : '';
  const rows = db
    .prepare(`
      SELECT
        guid,
        date,
        voucher_type,
        voucher_number,
        invoice_number,
        reference_number,
        narration,
        party_name,
        gstin,
        ledger AS Ledger,
        amount,
        group_name AS "Group",
        opening_balance,
        closing_balance,
        tally_parent AS TallyParent,
        tally_primary AS TallyPrimary,
        is_revenue,
        is_accounting_voucher,
        is_master_ledger
      FROM ledger_entries
      ${whereClause}
      ORDER BY date ASC, voucher_number ASC, id ASC
      ${limitClause}
    `)
    .all(...params) as any[];

  return { rows, total };
};

const sanitizeMonthKeys = (months: any): string[] => {
  if (!Array.isArray(months)) return [];
  const out = new Set<string>();
  months.forEach((value) => {
    const text = String(value || '').trim();
    if (/^(0[1-9]|1[0-2])\/\d{4}$/.test(text)) out.add(text);
  });
  return Array.from(out);
};

const sanitizeTextList = (values: any): string[] => {
  if (!Array.isArray(values)) return [];
  const out = new Set<string>();
  values.forEach((value) => {
    const text = String(value || '').trim().toLowerCase();
    if (text) out.add(text);
  });
  return Array.from(out);
};

const buildMonthFilterSql = (monthKeys: string[]): { clause: string; params: any[] } => {
  const clean = sanitizeMonthKeys(monthKeys);
  if (!clean.length) return { clause: '', params: [] };
  const placeholders = clean.map(() => '?').join(', ');
  return {
    clause: ` AND (substr(date, 6, 2) || '/' || substr(date, 1, 4)) IN (${placeholders})`,
    params: clean,
  };
};

const getAvailableMonthKeys = (): string[] => {
  const db = getAuditDb();
  const rows = db
    .prepare(`
      SELECT DISTINCT (substr(date, 6, 2) || '/' || substr(date, 1, 4)) AS monthKey
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        AND date GLOB '????-??-??'
      ORDER BY monthKey ASC
    `)
    .all() as any[];
  return rows.map((row) => String(row?.monthKey || '')).filter(Boolean);
};

const fetchModuleScopedRows = (
  moduleType: 'sales' | 'purchase',
  monthKeys: string[],
  selectedLedgers: string[],
  selectedRcmLedgers: string[] = []
): any[] => {
  const db = getAuditDb();
  const ledgers = sanitizeTextList(selectedLedgers);
  const rcmLedgers = sanitizeTextList(selectedRcmLedgers);
  const monthFilterForCandidate = buildMonthFilterSql(monthKeys);
  const monthFilterForRows = buildMonthFilterSql(monthKeys);

  const conditionParts: string[] = [];
  const conditionParams: any[] = [];

  if (moduleType === 'sales') {
    conditionParts.push(`LOWER(COALESCE(tally_primary, '')) LIKE '%sale%'`);
    conditionParts.push(`LOWER(COALESCE(tally_primary, '')) LIKE '%income%'`);
    if (ledgers.length > 0) {
      conditionParts.push(`LOWER(COALESCE(ledger, '')) IN (${ledgers.map(() => '?').join(', ')})`);
      conditionParams.push(...ledgers);
    }
  } else {
    conditionParts.push(`LOWER(COALESCE(tally_primary, '')) LIKE '%purchase%'`);
    conditionParts.push(`LOWER(COALESCE(tally_primary, '')) LIKE '%expense%'`);
    conditionParts.push(`LOWER(COALESCE(tally_primary, '')) LIKE '%fixed asset%'`);
    const expenseLedgerTargets = Array.from(new Set([...ledgers, ...rcmLedgers]));
    if (expenseLedgerTargets.length > 0) {
      conditionParts.push(`LOWER(COALESCE(ledger, '')) IN (${expenseLedgerTargets.map(() => '?').join(', ')})`);
      conditionParams.push(...expenseLedgerTargets);
    }
  }

  const conditionSql = conditionParts.length ? conditionParts.map((part) => `(${part})`).join(' OR ') : '1=0';
  const query = `
    WITH candidate_vouchers AS (
      SELECT DISTINCT voucher_number
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        AND (${conditionSql})
        ${monthFilterForCandidate.clause}
    )
    SELECT
      guid,
      date,
      voucher_type,
      voucher_number,
      invoice_number,
      reference_number,
      narration,
      party_name,
      gstin,
      ledger AS Ledger,
      amount,
      group_name AS "Group",
      opening_balance,
      closing_balance,
      tally_parent AS TallyParent,
      tally_primary AS TallyPrimary,
      is_revenue,
      is_accounting_voucher,
      is_master_ledger
    FROM ledger_entries
    WHERE COALESCE(is_master_ledger, 0) = 0
      AND voucher_number IN (SELECT voucher_number FROM candidate_vouchers)
      ${monthFilterForRows.clause}
    ORDER BY date ASC, voucher_number ASC, id ASC
  `;

  return db
    .prepare(query)
    .all(
      ...conditionParams,
      ...monthFilterForCandidate.params,
      ...monthFilterForRows.params
    ) as any[];
};

const hasAnyWord = (text: string, words: string[]) => words.some((word) => text.includes(word));
const PNL_HINT_WORDS = [
  'sale',
  'sales',
  'revenue',
  'turnover',
  'income',
  'purchase',
  'expense',
  'expenditure',
  'consumption',
  'cost',
];
const BS_HINT_WORDS = [
  'sundry debtor',
  'sundry creditor',
  'debtor',
  'creditor',
  'bank account',
  'cash-in-hand',
  'cash in hand',
  'capital account',
  'capital',
  'fixed asset',
  'current asset',
  'current liabilities',
  'secured loan',
  'unsecured loan',
  'loan and advances',
  'duties & taxes',
  'duties and taxes',
  'provisions',
  'reserves',
  'branch/divisions',
  'branch divisions',
];

const fetchPnlAnalytics = (monthKeys: string[]) => {
  const db = getAuditDb();
  const monthFilter = buildMonthFilterSql(monthKeys);
  const rows = db
    .prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(tally_primary), ''), 'Unspecified Primary') AS primaryName,
        COALESCE(NULLIF(TRIM(tally_parent), ''), COALESCE(NULLIF(TRIM(group_name), ''), 'Unspecified Parent')) AS parentName,
        COALESCE(NULLIF(TRIM(ledger), ''), 'Unknown Ledger') AS ledgerName,
        SUM(COALESCE(amount, 0)) AS totalAmount,
        COUNT(*) AS entryCount,
        SUM(CASE WHEN COALESCE(is_revenue, 0) > 0 THEN 1 ELSE 0 END) AS revenueFlagCount
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        ${monthFilter.clause}
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, ABS(totalAmount) DESC
    `)
    .all(...monthFilter.params) as any[];

  const primaryMap = new Map<
    string,
    {
      primary: string;
      total: number;
      revenueFlagCount: number;
      explicitPnlCount: number;
      explicitBsCount: number;
      likelyBalanceSheet: boolean;
      hasStockOrInventoryWord: boolean;
      parentMap: Map<string, { total: number; ledgers: Map<string, { total: number; entries: number }> }>;
    }
  >();

  rows.forEach((row) => {
    const primary = String(row?.primaryName || 'Unspecified Primary');
    const parent = String(row?.parentName || 'Unspecified Parent');
    const ledger = String(row?.ledgerName || 'Unknown Ledger');
    const totalAmount = Number(row?.totalAmount || 0);
    const entryCount = Number(row?.entryCount || 0);
    const revenueFlagCount = Number(row?.revenueFlagCount || 0);

    if (!primaryMap.has(primary)) {
      primaryMap.set(primary, {
        primary,
        total: 0,
        revenueFlagCount: 0,
        explicitPnlCount: 0,
        explicitBsCount: 0,
        likelyBalanceSheet: false,
        hasStockOrInventoryWord: false,
        parentMap: new Map(),
      });
    }
    const bucket = primaryMap.get(primary)!;
    bucket.total += totalAmount;
    bucket.revenueFlagCount += revenueFlagCount;

    const combinedText = `${primary} ${parent}`.toLowerCase();
    if (combinedText.includes('stock') || combinedText.includes('inventory')) {
      bucket.hasStockOrInventoryWord = true;
    }
    if (hasAnyWord(combinedText, BS_HINT_WORDS) && !hasAnyWord(combinedText, PNL_HINT_WORDS)) {
      bucket.likelyBalanceSheet = true;
    }

    if (!bucket.parentMap.has(parent)) {
      bucket.parentMap.set(parent, { total: 0, ledgers: new Map() });
    }
    const parentNode = bucket.parentMap.get(parent)!;
    parentNode.total += totalAmount;

    if (!parentNode.ledgers.has(ledger)) {
      parentNode.ledgers.set(ledger, { total: 0, entries: 0 });
    }
    const ledgerNode = parentNode.ledgers.get(ledger)!;
    ledgerNode.total += totalAmount;
    ledgerNode.entries += entryCount;
  });

  const primaryBuckets = Array.from(primaryMap.values())
    .map((bucket) => {
      const parentBreakup = Array.from(bucket.parentMap.entries())
        .map(([parent, node]) => ({
          parent,
          total: node.total,
          ledgers: Array.from(node.ledgers.entries())
            .map(([ledger, ledgerNode]) => ({
              ledger,
              total: ledgerNode.total,
              entries: ledgerNode.entries,
            }))
            .sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
        }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

      return {
        primary: bucket.primary,
        total: bucket.total,
        revenueFlagCount: bucket.revenueFlagCount,
        explicitPnlCount: bucket.explicitPnlCount,
        explicitBsCount: bucket.explicitBsCount,
        likelyBalanceSheet: bucket.likelyBalanceSheet,
        hasStockOrInventoryWord: bucket.hasStockOrInventoryWord,
        parentNames: parentBreakup.map((p) => p.parent),
        parentBreakup,
      };
    })
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  const stockRows = db
    .prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(ledger), ''), 'Unknown Ledger') AS ledgerName,
        SUM(COALESCE(amount, 0)) AS totalAmount
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        ${monthFilter.clause}
        AND (
          LOWER(COALESCE(tally_primary, '')) LIKE '%stock%'
          OR LOWER(COALESCE(tally_primary, '')) LIKE '%inventory%'
          OR LOWER(COALESCE(tally_parent, '')) LIKE '%stock%'
          OR LOWER(COALESCE(tally_parent, '')) LIKE '%inventory%'
          OR LOWER(COALESCE(ledger, '')) LIKE '%stock%'
          OR LOWER(COALESCE(ledger, '')) LIKE '%inventory%'
        )
      GROUP BY 1
      ORDER BY ABS(totalAmount) DESC
    `)
    .all(...monthFilter.params) as any[];

  const stockLedgerTotals = stockRows.map((row) => ({
    ledger: String(row?.ledgerName || 'Unknown Ledger'),
    amount: Number(row?.totalAmount || 0),
  }));

  const openingStockRow = db
    .prepare(`
      SELECT SUM(COALESCE(amount, 0)) AS totalAmount
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        ${monthFilter.clause}
        AND LOWER(
          COALESCE(tally_primary, '') || ' ' ||
          COALESCE(tally_parent, '') || ' ' ||
          COALESCE(ledger, '')
        ) LIKE '%opening stock%'
    `)
    .get(...monthFilter.params) as any;

  const closingStockRow = db
    .prepare(`
      SELECT SUM(COALESCE(amount, 0)) AS totalAmount
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        ${monthFilter.clause}
        AND LOWER(
          COALESCE(tally_primary, '') || ' ' ||
          COALESCE(tally_parent, '') || ' ' ||
          COALESCE(ledger, '')
        ) LIKE '%closing stock%'
    `)
    .get(...monthFilter.params) as any;

  const openingTotal = Number(openingStockRow?.totalAmount || 0);
  const closingTotal = Number(closingStockRow?.totalAmount || 0);

  return {
    months: getAvailableMonthKeys(),
    primaryBuckets,
    stockLedgerTotals,
    defaultOpeningStock: openingTotal !== 0 ? openingTotal : Number(stockLedgerTotals[0]?.amount || 0),
    defaultClosingStock:
      closingTotal !== 0
        ? closingTotal
        : Number(stockLedgerTotals[1]?.amount || stockLedgerTotals[0]?.amount || 0),
  };
};

const VOUCHER_NUMBER_SQL = `COALESCE(NULLIF(TRIM(voucher_number), ''), COALESCE(NULLIF(TRIM(invoice_number), ''), 'UNKNOWN'))`;
const VOUCHER_DATE_SQL = `COALESCE(NULLIF(TRIM(date), ''), '')`;
const VOUCHER_TYPE_SQL = `COALESCE(NULLIF(TRIM(voucher_type), ''), '')`;

const normalizePage = (value: any): number => {
  const page = Number(value);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
};

const normalizePageSize = (value: any): number => {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return 50;
  return Math.min(250, Math.max(10, Math.floor(size)));
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
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};

const parseOptionalNumber = (value: any): number | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveVoucherParty = (entries: any[]): string => {
  const byPartyName = entries.map((entry) => String(entry.party_name || '').trim()).find((value) => value.length > 0);
  if (byPartyName) return byPartyName;
  const likely = entries.find((entry) => {
    const primary = String(entry.TallyPrimary || '').toLowerCase();
    const parent = String(entry.TallyParent || '').toLowerCase();
    return primary.includes('debtor') || parent.includes('debtor') || primary.includes('creditor') || parent.includes('creditor');
  });
  if (likely?.Ledger && String(likely.Ledger).trim()) return String(likely.Ledger).trim();
  return '-';
};

const isSyntheticUnknownVoucher = (voucherNumber: string): boolean =>
  /^unknown(?:-\d+)?$/i.test(String(voucherNumber || '').trim());

const getGuidFamilyKey = (guid: string): string => {
  const text = String(guid || '').trim();
  if (!text) return '';
  if (!/-\d+$/.test(text)) return text;
  return text.replace(/-\d+$/, '');
};

const normalizeVoucherIdentity = (row: any) => {
  const voucherNumber = String(row?.voucher_number || row?.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN';
  const date = String(row?.date || '').trim();
  const voucherType = String(row?.voucher_type || '').trim();
  const guidFamily = getGuidFamilyKey(String(row?.guid || ''));
  const voucherFamily = isSyntheticUnknownVoucher(voucherNumber) && guidFamily ? `UNKNOWN_GUID::${guidFamily}` : voucherNumber;
  const groupKey = `${voucherFamily}__${date}__${voucherType}`;
  return { voucherNumber, date, voucherType, voucherFamily, groupKey };
};

const fetchEntriesForVoucherKeys = (
  keys: Array<{ voucherNumber: string; date: string; voucherType: string }>
): any[] => {
  const db = getAuditDb();
  if (!keys.length) return [];
  const placeholders = keys.map(() => '(?, ?, ?)').join(', ');
  const params = keys.flatMap((key) => [key.voucherNumber, key.date, key.voucherType]);

  return db
    .prepare(`
      WITH selected(voucher_number, date, voucher_type) AS (
        VALUES ${placeholders}
      )
      SELECT
        ${VOUCHER_NUMBER_SQL} AS voucherNumber,
        ${VOUCHER_DATE_SQL} AS date,
        ${VOUCHER_TYPE_SQL} AS voucherType,
        guid,
        date AS rawDate,
        voucher_type,
        voucher_number,
        invoice_number,
        reference_number,
        narration,
        party_name,
        gstin,
        ledger AS Ledger,
        amount,
        group_name AS "Group",
        opening_balance,
        closing_balance,
        tally_parent AS TallyParent,
        tally_primary AS TallyPrimary,
        is_revenue,
        is_accounting_voucher,
        is_master_ledger,
        id
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        AND (${VOUCHER_NUMBER_SQL}, ${VOUCHER_DATE_SQL}, ${VOUCHER_TYPE_SQL}) IN (
          SELECT voucher_number, date, voucher_type FROM selected
        )
      ORDER BY rawDate ASC, voucher_number ASC, id ASC
    `)
    .all(...params) as any[];
};

const fetchVoucherBookPage = (search: string, page: number, pageSize: number) => {
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
  const q = String(search || '').trim().toLowerCase();
  const db = getAuditDb();
  const sourceRows = db
    .prepare(`
      SELECT
        id,
        guid,
        date,
        voucher_type,
        voucher_number,
        invoice_number,
        reference_number,
        narration,
        party_name,
        gstin,
        ledger AS Ledger,
        amount,
        group_name AS "Group",
        opening_balance,
        closing_balance,
        tally_parent AS TallyParent,
        tally_primary AS TallyPrimary,
        is_revenue,
        is_accounting_voucher,
        is_master_ledger
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
      ORDER BY date ASC, id ASC
    `)
    .all() as any[];

  const groupedMap = new Map<string, any>();
  sourceRows.forEach((row) => {
    if (Number(row?.is_master_ledger || 0) > 0) return;
    const identity = normalizeVoucherIdentity(row);
    if (!groupedMap.has(identity.groupKey)) {
      groupedMap.set(identity.groupKey, {
        key: identity.groupKey,
        voucherNumber: identity.voucherNumber,
        date: identity.date,
        voucherType: identity.voucherType,
        firstId: Number(row?.id || 0),
        entries: [],
        totalDr: 0,
        totalCr: 0,
      });
    }
    const node = groupedMap.get(identity.groupKey)!;
    const candidateVoucher = identity.voucherNumber;
    if (
      isSyntheticUnknownVoucher(node.voucherNumber) &&
      candidateVoucher &&
      (!isSyntheticUnknownVoucher(candidateVoucher) || candidateVoucher.localeCompare(node.voucherNumber) < 0)
    ) {
      node.voucherNumber = candidateVoucher;
    }
    node.entries.push(row);
    const amount = Number(row?.amount || 0);
    if (amount < 0) node.totalDr += Math.abs(amount);
    if (amount > 0) node.totalCr += amount;
    if (!node.firstId || Number(row?.id || 0) < node.firstId) node.firstId = Number(row?.id || 0);
  });

  const grouped = Array.from(groupedMap.values())
    .map((row) => {
      const bucketEntries = row.entries || [];
      const narration =
        bucketEntries.map((entry: any) => String(entry?.narration || '').trim()).find((value: string) => value.length > 0) ||
        '';
      return {
        ...row,
        party: resolveVoucherParty(bucketEntries),
        narration,
        lineCount: bucketEntries.length,
      };
    })
    .sort((a, b) => {
      const d = parseDateTs(String(b.date || '')) - parseDateTs(String(a.date || ''));
      if (d !== 0) return d;
      const v = String(a.voucherNumber || '').localeCompare(String(b.voucherNumber || ''));
      if (v !== 0) return v;
      return Number(a.firstId || 0) - Number(b.firstId || 0);
    });

  const filtered = q
    ? grouped.filter((row) => {
        return (
          String(row.voucherNumber || '').toLowerCase().includes(q) ||
          String(row.voucherType || '').toLowerCase().includes(q) ||
          String(row.party || '').toLowerCase().includes(q) ||
          String(row.narration || '').toLowerCase().includes(q)
        );
      })
    : grouped;

  const totalRows = filtered.length;
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / safePageSize) : 1;
  const clampedPage = Math.min(safePage, totalPages);
  const start = (clampedPage - 1) * safePageSize;
  const rows = filtered.slice(start, start + safePageSize);

  const totals = filtered.reduce(
    (acc, row) => {
      acc.vouchers += 1;
      acc.lines += Number(row.lineCount || 0);
      acc.dr += Number(row.totalDr || 0);
      acc.cr += Number(row.totalCr || 0);
      return acc;
    },
    { vouchers: 0, lines: 0, dr: 0, cr: 0 }
  );

  return {
    page: clampedPage,
    pageSize: safePageSize,
    totalRows,
    totalPages,
    totals,
    rows,
  };
};

const getLedgerList = (): string[] => {
  const db = getAuditDb();
  const rows = db
    .prepare(`
      SELECT DISTINCT TRIM(ledger) AS ledger
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        AND TRIM(COALESCE(ledger, '')) <> ''
      ORDER BY ledger ASC
    `)
    .all() as any[];
  return rows.map((row) => String(row?.ledger || '')).filter(Boolean);
};

const fetchLedgerVoucherPage = (params: {
  ledger: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}) => {
  const ledger = String(params.ledger || '').trim();
  const selectedLower = ledger.toLowerCase();
  if (!ledger) {
    return {
      ledger: '',
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
      pageSize: normalizePageSize(params.pageSize),
      totalPages: 1,
      rows: [],
    };
  }

  const db = getAuditDb();
  const sourceRows = db
    .prepare(`
      SELECT
        id,
        guid,
        date,
        voucher_type,
        voucher_number,
        invoice_number,
        reference_number,
        narration,
        party_name,
        gstin,
        ledger AS Ledger,
        amount,
        group_name AS "Group",
        opening_balance,
        closing_balance,
        tally_parent AS TallyParent,
        tally_primary AS TallyPrimary,
        is_revenue,
        is_accounting_voucher,
        is_master_ledger
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
      ORDER BY date ASC, id ASC
    `)
    .all() as any[];

  const voucherMap = new Map<string, any>();
  sourceRows.forEach((row) => {
    if (Number(row?.is_master_ledger || 0) > 0) return;
    const identity = normalizeVoucherIdentity(row);
    if (!voucherMap.has(identity.groupKey)) {
      voucherMap.set(identity.groupKey, {
        key: identity.groupKey,
        voucherNumber: identity.voucherNumber,
        date: identity.date,
        voucherType: identity.voucherType,
        firstId: Number(row?.id || 0),
        ledgerAmount: 0,
        partyHint: '',
        narrationHint: '',
        entries: [],
      });
    }
    const node = voucherMap.get(identity.groupKey)!;
    const candidateVoucher = identity.voucherNumber;
    if (
      isSyntheticUnknownVoucher(node.voucherNumber) &&
      candidateVoucher &&
      (!isSyntheticUnknownVoucher(candidateVoucher) || candidateVoucher.localeCompare(node.voucherNumber) < 0)
    ) {
      node.voucherNumber = candidateVoucher;
    }
    node.entries.push(row);
    if (!node.firstId || Number(row?.id || 0) < node.firstId) node.firstId = Number(row?.id || 0);
    if (String(row?.Ledger || '').trim().toLowerCase() === selectedLower) {
      node.ledgerAmount += Number(row?.amount || 0);
      if (!node.partyHint) node.partyHint = String(row?.party_name || '').trim();
      if (!node.narrationHint) node.narrationHint = String(row?.narration || '').trim();
    }
  });

  const groupedRows = Array.from(voucherMap.values())
    .filter((row) => Math.abs(Number(row.ledgerAmount || 0)) > 0.0000001)
    .sort((a, b) => {
      const d = parseDateTs(String(a.date || '')) - parseDateTs(String(b.date || ''));
      if (d !== 0) return d;
      const v = String(a.voucherNumber || '').localeCompare(String(b.voucherNumber || ''));
      if (v !== 0) return v;
      return Number(a.firstId || 0) - Number(b.firstId || 0);
    });

  const ledgerBalanceRows = sourceRows
    .filter((row) => Number(row?.is_master_ledger || 0) === 0)
    .filter((row) => String(row?.Ledger || '').trim().toLowerCase() === selectedLower)
    .sort((a, b) => parseDateTs(String(a?.date || '')) - parseDateTs(String(b?.date || '')));

  let openingBalance: number | null = null;
  for (const row of ledgerBalanceRows) {
    const parsed = parseOptionalNumber(row?.opening_balance);
    if (parsed !== null) {
      openingBalance = parsed;
      break;
    }
  }
  let closingBalance: number | null = null;
  for (let i = ledgerBalanceRows.length - 1; i >= 0; i -= 1) {
    const parsed = parseOptionalNumber(ledgerBalanceRows[i]?.closing_balance);
    if (parsed !== null) {
      closingBalance = parsed;
      break;
    }
  }

  const rows = groupedRows.map((row) => {
    const ledgerAmount = Number(row?.ledgerAmount || 0);
    const ledgerDr = ledgerAmount < 0 ? Math.abs(ledgerAmount) : 0;
    const ledgerCr = ledgerAmount > 0 ? ledgerAmount : 0;
    return {
      key: String(row?.key || ''),
      voucherNumber: String(row?.voucherNumber || ''),
      date: String(row?.date || ''),
      dateTs: parseDateTs(String(row?.date || '')),
      voucherType: String(row?.voucherType || ''),
      partyHint: String(row?.partyHint || ''),
      narrationHint: String(row?.narrationHint || ''),
      ledgerAmount,
      ledgerDr,
      ledgerCr,
      entries: Array.isArray(row?.entries) ? row.entries : [],
    };
  });

  const periodFrom = rows[0]?.date || '';
  const periodTo = rows[rows.length - 1]?.date || '';
  const fromTsRaw = params.fromDate ? parseDateTs(String(params.fromDate)) : Number.NEGATIVE_INFINITY;
  const toTsRaw = params.toDate ? parseDateTs(String(params.toDate)) : Number.POSITIVE_INFINITY;
  const fromTs = Number.isFinite(fromTsRaw) ? fromTsRaw : Number.NEGATIVE_INFINITY;
  const toTs = Number.isFinite(toTsRaw) ? toTsRaw + 86399999 : Number.POSITIVE_INFINITY;

  const openingMovementBeforeRange = rows
    .filter((row) => row.dateTs && row.dateTs < fromTs)
    .reduce((sum, row) => sum + row.ledgerAmount, 0);
  const movementAfterRange = rows
    .filter((row) => row.dateTs && row.dateTs > toTs)
    .reduce((sum, row) => sum + row.ledgerAmount, 0);

  const periodRows = rows.filter((row) => {
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

  const openingAtRangeStart = Number(openingBalance || 0) + openingMovementBeforeRange;
  const closingAtRangeEnd = openingAtRangeStart + periodTotals.net;
  const referenceClosingAtRangeEnd =
    closingBalance === null ? null : Number(closingBalance) - movementAfterRange;
  const reconciliationDiff =
    referenceClosingAtRangeEnd === null ? null : closingAtRangeEnd - referenceClosingAtRangeEnd;

  let running = openingAtRangeStart;
  const runningBalanceByKey = new Map<string, number>();
  periodRows.forEach((row) => {
    running += row.ledgerAmount;
    runningBalanceByKey.set(row.key, running);
  });

  const q = String(params.search || '').trim().toLowerCase();
  const visibleRows = q
    ? periodRows.filter((row) => {
        return (
          row.voucherNumber.toLowerCase().includes(q) ||
          row.voucherType.toLowerCase().includes(q) ||
          row.partyHint.toLowerCase().includes(q) ||
          row.narrationHint.toLowerCase().includes(q)
        );
      })
    : periodRows;

  const safePageSize = normalizePageSize(params.pageSize);
  const safePage = normalizePage(params.page);
  const totalRows = visibleRows.length;
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / safePageSize) : 1;
  const page = Math.min(safePage, totalPages);
  const start = (page - 1) * safePageSize;
  const end = start + safePageSize;
  const pageRows = visibleRows.slice(start, end);

  const resultRows = pageRows.map((row) => {
    const key = row.key;
    const bucketEntries = Array.isArray(row.entries) ? row.entries : [];
    const narration =
      row.narrationHint ||
      bucketEntries.map((entry) => String(entry.narration || '').trim()).find((value) => value.length > 0) ||
      '';
    return {
      ...row,
      party: row.partyHint || resolveVoucherParty(bucketEntries),
      narration,
      balance: runningBalanceByKey.get(key) ?? openingAtRangeStart,
      entries: bucketEntries,
    };
  });

  return {
    ledger,
    periodFrom,
    periodTo,
    hasOpening: openingBalance !== null,
    hasClosing: closingBalance !== null,
    openingAtRangeStart,
    closingAtRangeEnd,
    referenceClosingAtRangeEnd,
    reconciliationDiff,
    periodTotals,
    periodRowsCount: periodRows.length,
    visibleRowsCount: visibleRows.length,
    page,
    pageSize: safePageSize,
    totalPages,
    rows: resultRows,
  };
};

const clearAuditData = () => {
  const db = getAuditDb();
  db.exec('DELETE FROM ledger_entries;');
  auditLoadedRows = 0;
};

const tempDataDir = path.join(__dirname, '.tally-source-temp');

const ensureTempDataDir = () => {
  if (!fs.existsSync(tempDataDir)) fs.mkdirSync(tempDataDir, { recursive: true });
};

const exportAuditSourceBuffer = (): Buffer => {
  const rows = fetchAuditRows();
  if (rows.length === 0) {
    throw new Error('No dataset loaded. Import data before exporting source file.');
  }

  ensureTempDataDir();
  const filePath = path.join(tempDataDir, `export-${Date.now()}.sqlite`);
  const exportDb = new Database(filePath);
  applyAuditPragmas(exportDb);
  initializeAuditSchema(exportDb);
  // Single transaction for the whole export: DELETE+INSERT into trn_accounting,
  // mst_ledger, trial_balance_from_mst_ledger inside buildReferenceCollections.
  const runExport = exportDb.transaction(() => {
    insertAuditRowsIntoDb(exportDb, rows);
    buildReferenceCollectionsForExport(exportDb);
  });
  try {
    runExport();
  } finally {
    exportDb.close?.();
  }

  const buffer = fs.readFileSync(filePath);
  fs.unlinkSync(filePath);
  return buffer;
};

const importAuditSourceBuffer = (buffer: Buffer): { insertedRows: number; summary: ReturnType<typeof getAuditSummary> } => {
  const rows = readNormalizedAuditSourceRowsBuffer(buffer);
  return loadAuditRows(rows);
};

const readNormalizedAuditSourceRowsBuffer = (buffer: Buffer): any[] => {
  ensureTempDataDir();
  const filePath = path.join(tempDataDir, `parse-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  fs.writeFileSync(filePath, buffer);

  let sourceDb: any = null;
  try {
    // Read-only: the TSF file is provided by the user; we never write to it.
    // readonly mode also lets better-sqlite3 skip WAL setup.
    sourceDb = new Database(filePath, { readonly: true });
    const tableExists = sourceDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_entries'")
      .get() as any;
    if (!tableExists?.name) {
      throw new Error('Invalid Tally source file: ledger_entries table not found.');
    }

    const masterFlagColumn = sourceDb
      .prepare(`
        SELECT name FROM pragma_table_info('ledger_entries') WHERE name = 'is_master_ledger'
      `)
      .get() as any;
    const hasMasterFlag = !!masterFlagColumn?.name;

    return sourceDb
      .prepare(`
        SELECT
          guid,
          date,
          voucher_type,
          voucher_number,
          invoice_number,
          reference_number,
          narration,
          party_name,
          gstin,
          ledger AS Ledger,
          amount,
          group_name AS "Group",
          opening_balance,
          closing_balance,
          tally_parent AS TallyParent,
          tally_primary AS TallyPrimary,
          is_revenue,
          is_accounting_voucher,
          ${hasMasterFlag ? 'is_master_ledger' : '0 AS is_master_ledger'}
        FROM ledger_entries
      `)
      .all() as any[];
  } finally {
    (sourceDb as any)?.close?.();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
};

const readAuditSourceRowsBuffer = (buffer: Buffer): { columns: string[]; rows: any[] } => {
  ensureTempDataDir();
  const filePath = path.join(tempDataDir, `convert-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  fs.writeFileSync(filePath, buffer);

  let sourceDb: any = null;
  try {
    sourceDb = new Database(filePath, { readonly: true });
    const tableExists = sourceDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_entries'")
      .get() as any;
    if (!tableExists?.name) {
      throw new Error('Invalid Tally source file: ledger_entries table not found.');
    }

    const cols = sourceDb
      .prepare("SELECT name FROM pragma_table_info('ledger_entries') ORDER BY cid ASC")
      .all() as any[];
    const columns = cols.map((c) => String(c?.name || '')).filter(Boolean);
    if (columns.length === 0) {
      throw new Error('Invalid Tally source file: ledger_entries has no columns.');
    }

    const selectColumns = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
    const rows = sourceDb.prepare(`SELECT ${selectColumns} FROM ledger_entries`).all() as any[];
    return { columns, rows };
  } finally {
    (sourceDb as any)?.close?.();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
};

const convertAuditSourceBufferToExcel = (buffer: Buffer): Buffer => {
  const payload = readAuditSourceRowsBuffer(buffer);
  const worksheet = XLSX.utils.json_to_sheet(payload.rows, { header: payload.columns });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'TSF Raw Data');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
};

const compareAuditSourcesByGuid = (newSourceBuffer: Buffer) => {
  const currentRows = fetchAuditRows();
  if (!Array.isArray(currentRows) || currentRows.length === 0) {
    throw new Error('No dataset loaded. Import a base TSF file first.');
  }

  const newRows = readNormalizedAuditSourceRowsBuffer(newSourceBuffer);

  const createComparableRow = (row: any) => ({
    guid: toSafeText(row?.guid).trim(),
    date: toSafeText(row?.date).trim(),
    voucher_type: toSafeText(row?.voucher_type).trim(),
    voucher_number: toSafeText(row?.voucher_number).trim(),
    invoice_number: toSafeText(row?.invoice_number).trim(),
    reference_number: toSafeText(row?.reference_number).trim(),
    narration: toSafeText(row?.narration),
    party_name: toSafeText(row?.party_name).trim(),
    gstin: toSafeText(row?.gstin).trim(),
    ledger: toSafeText(row?.Ledger ?? row?.ledger).trim(),
    amount: toSafeNumber(row?.amount),
    group_name: toSafeText(row?.Group ?? row?.group_name).trim(),
    opening_balance: toSafeNumber(row?.opening_balance),
    closing_balance: toSafeNumber(row?.closing_balance),
    tally_parent: toSafeText(row?.TallyParent ?? row?.tally_parent).trim(),
    tally_primary: toSafeText(row?.TallyPrimary ?? row?.tally_primary).trim(),
    is_revenue: toSafeNumber(row?.is_revenue) > 0 ? 1 : 0,
    is_accounting_voucher: toAccountingFlag(row?.is_accounting_voucher),
    is_master_ledger: toSafeNumber(row?.is_master_ledger) > 0 ? 1 : 0,
  });

  const compareFields = [
    { key: 'date', label: 'Date', type: 'string' },
    { key: 'voucher_type', label: 'Voucher Type', type: 'string' },
    { key: 'voucher_number', label: 'Voucher Number', type: 'string' },
    { key: 'invoice_number', label: 'Invoice Number', type: 'string' },
    { key: 'reference_number', label: 'Reference Number', type: 'string' },
    { key: 'narration', label: 'Narration', type: 'string' },
    { key: 'party_name', label: 'Party Name', type: 'string' },
    { key: 'gstin', label: 'GSTIN', type: 'string' },
    { key: 'ledger', label: 'Ledger', type: 'string' },
    { key: 'group_name', label: 'Group', type: 'string' },
    { key: 'tally_parent', label: 'Tally Parent', type: 'string' },
    { key: 'tally_primary', label: 'Tally Primary', type: 'string' },
    { key: 'amount', label: 'Amount', type: 'number' },
    { key: 'opening_balance', label: 'Opening Balance', type: 'number' },
    { key: 'closing_balance', label: 'Closing Balance', type: 'number' },
    { key: 'is_revenue', label: 'Is Revenue', type: 'number' },
    { key: 'is_accounting_voucher', label: 'Is Accounting Voucher', type: 'number' },
    { key: 'is_master_ledger', label: 'Is Master Ledger', type: 'number' },
  ];

  const buildIndex = (rows: any[]) => {
    const grouped = new Map<string, any[]>();
    const duplicates: Array<{ guid: string; count: number }> = [];
    const uniqueByGuid = new Map<string, any>();
    const blankGuidRows: any[] = [];
    const allComparableRows: any[] = [];
    const voucherTotals = new Map<string, number>();
    const ledgerTotals = new Map<string, number>();
    let amountTotal = 0;

    rows.forEach((raw) => {
      const row = createComparableRow(raw);
      if (row.is_accounting_voucher !== 1 || row.is_master_ledger === 1) return;
      allComparableRows.push(row);
      amountTotal += row.amount;

      const voucherKey = `${row.voucher_number}__${row.date}__${row.voucher_type}`;
      voucherTotals.set(voucherKey, (voucherTotals.get(voucherKey) || 0) + row.amount);
      const ledgerKey = row.ledger || '(Blank Ledger)';
      ledgerTotals.set(ledgerKey, (ledgerTotals.get(ledgerKey) || 0) + row.amount);

      if (!row.guid) {
        blankGuidRows.push(row);
        return;
      }
      if (!grouped.has(row.guid)) grouped.set(row.guid, []);
      grouped.get(row.guid)!.push(row);
    });

    grouped.forEach((rowsForGuid, guid) => {
      if (rowsForGuid.length === 1) {
        uniqueByGuid.set(guid, rowsForGuid[0]);
        return;
      }
      duplicates.push({ guid, count: rowsForGuid.length });
    });

    return {
      uniqueByGuid,
      duplicates: duplicates.sort((a, b) => b.count - a.count || a.guid.localeCompare(b.guid)),
      blankGuidRows,
      allComparableRows,
      voucherTotals,
      ledgerTotals,
      amountTotal,
    };
  };

  const formatForOutput = (row: any) => ({
    guid: row.guid,
    date: row.date,
    voucher_type: row.voucher_type,
    voucher_number: row.voucher_number,
    invoice_number: row.invoice_number,
    reference_number: row.reference_number,
    narration: row.narration,
    party_name: row.party_name,
    gstin: row.gstin,
    ledger: row.ledger,
    amount: row.amount,
    group_name: row.group_name,
    tally_parent: row.tally_parent,
    tally_primary: row.tally_primary,
    opening_balance: row.opening_balance,
    closing_balance: row.closing_balance,
    is_revenue: row.is_revenue,
    is_accounting_voucher: row.is_accounting_voucher,
    is_master_ledger: row.is_master_ledger,
  });

  const currentIndex = buildIndex(currentRows);
  const newIndex = buildIndex(newRows);

  const addedRows: any[] = [];
  const removedRows: any[] = [];
  const modifiedRows: any[] = [];
  let unchangedRows = 0;
  let modifiedAmountDelta = 0;

  const allGuids = new Set([
    ...Array.from(currentIndex.uniqueByGuid.keys()),
    ...Array.from(newIndex.uniqueByGuid.keys()),
  ]);

  Array.from(allGuids).sort().forEach((guid) => {
    const currentRow = currentIndex.uniqueByGuid.get(guid);
    const newRow = newIndex.uniqueByGuid.get(guid);

    if (!currentRow && newRow) {
      addedRows.push(formatForOutput(newRow));
      return;
    }
    if (currentRow && !newRow) {
      removedRows.push(formatForOutput(currentRow));
      return;
    }
    if (!currentRow || !newRow) return;

    const differences: Array<{ field: string; label: string; currentValue: any; newValue: any }> = [];
    compareFields.forEach((field) => {
      const a = currentRow[field.key];
      const b = newRow[field.key];
      const different = field.type === 'number' ? a !== b : String(a) !== String(b);
      if (!different) return;
      differences.push({
        field: field.key,
        label: field.label,
        currentValue: a,
        newValue: b,
      });
    });

    if (differences.length === 0) {
      unchangedRows += 1;
      return;
    }

    const amountDelta = newRow.amount - currentRow.amount;
    modifiedAmountDelta += amountDelta;
    modifiedRows.push({
      guid,
      amountDelta,
      currentRow: formatForOutput(currentRow),
      newRow: formatForOutput(newRow),
      differences,
    });
  });

  const toVoucherImpactRows = (currentTotals: Map<string, number>, nextTotals: Map<string, number>) => {
    const keys = new Set([...Array.from(currentTotals.keys()), ...Array.from(nextTotals.keys())]);
    return Array.from(keys)
      .map((voucherKey) => {
        const currentAmount = toSafeNumber(currentTotals.get(voucherKey) || 0);
        const newAmount = toSafeNumber(nextTotals.get(voucherKey) || 0);
        const delta = newAmount - currentAmount;
        const [voucher_number, date, voucher_type] = String(voucherKey).split('__');
        return {
          voucherKey,
          voucher_number: voucher_number || '',
          date: date || '',
          voucher_type: voucher_type || '',
          currentAmount,
          newAmount,
          delta,
        };
      })
      .filter((row) => row.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  };

  const toLedgerImpactRows = (currentTotals: Map<string, number>, nextTotals: Map<string, number>) => {
    const keys = new Set([...Array.from(currentTotals.keys()), ...Array.from(nextTotals.keys())]);
    return Array.from(keys)
      .map((ledger) => {
        const currentAmount = toSafeNumber(currentTotals.get(ledger) || 0);
        const newAmount = toSafeNumber(nextTotals.get(ledger) || 0);
        const delta = newAmount - currentAmount;
        return {
          ledger,
          currentAmount,
          newAmount,
          delta,
        };
      })
      .filter((row) => row.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  };

  const addedAmount = addedRows.reduce((sum, row) => sum + toSafeNumber(row.amount), 0);
  const removedAmount = removedRows.reduce((sum, row) => sum + toSafeNumber(row.amount), 0);
  const ledgerImpact = toLedgerImpactRows(currentIndex.ledgerTotals, newIndex.ledgerTotals);
  const voucherImpact = toVoucherImpactRows(currentIndex.voucherTotals, newIndex.voucherTotals);

  return {
    strictMatchBy: 'guid',
    comparedAt: new Date().toISOString(),
    summary: {
      currentRows: currentIndex.allComparableRows.length,
      newRows: newIndex.allComparableRows.length,
      unchangedRows,
      addedRows: addedRows.length,
      removedRows: removedRows.length,
      modifiedRows: modifiedRows.length,
      duplicateGuidsCurrent: currentIndex.duplicates.length,
      duplicateGuidsNew: newIndex.duplicates.length,
      blankGuidRowsCurrent: currentIndex.blankGuidRows.length,
      blankGuidRowsNew: newIndex.blankGuidRows.length,
      currentAmountTotal: currentIndex.amountTotal,
      newAmountTotal: newIndex.amountTotal,
      addedAmount,
      removedAmount,
      modifiedAmountDelta,
      netAmountDelta: newIndex.amountTotal - currentIndex.amountTotal,
      impactedLedgers: ledgerImpact.length,
      impactedVouchers: voucherImpact.length,
    },
    addedRows,
    removedRows,
    modifiedRows,
    ledgerImpact,
    voucherImpact,
    duplicateGuids: {
      current: currentIndex.duplicates,
      new: newIndex.duplicates,
    },
    blankGuidRows: {
      current: currentIndex.blankGuidRows.map(formatForOutput),
      new: newIndex.blankGuidRows.map(formatForOutput),
    },
  };
};

const ensureAbsolutePath = (inputPath: string): string => {
  const trimmed = String(inputPath || '').trim();
  if (!trimmed) return '';
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(__dirname, trimmed);
};

const isValidLoaderRoot = (rootPath: string): boolean => {
  if (!rootPath || !fs.existsSync(rootPath)) return false;
  const executablePath = path.join(rootPath, 'dist', 'index.mjs');
  const configPath = path.join(rootPath, 'config.json');
  return fs.existsSync(executablePath) && fs.existsSync(configPath);
};

const findLoaderRootRecursively = (startDir: string, maxDepth = 4): string => {
  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: startDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDir = current.dir;
    const depth = current.depth;

    if (visited.has(currentDir)) continue;
    visited.add(currentDir);

    if (isValidLoaderRoot(currentDir)) return currentDir;
    if (depth >= maxDepth) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => {
        const lowerName = entry.name.toLowerCase();
        if (lowerName === 'node_modules' || lowerName === '.git' || lowerName === 'dist') return;
        queue.push({ dir: path.join(currentDir, entry.name), depth: depth + 1 });
      });
  }

  return '';
};

const resolveLoaderRoot = (requestedPath?: string): string => {
  const requestPath = ensureAbsolutePath(requestedPath || '');
  if (requestPath) {
    if (isValidLoaderRoot(requestPath)) {
      preferredLoaderRoot = requestPath;
      lastResolvedLoaderRoot = requestPath;
      return requestPath;
    }
    throw new Error(
      `Configured loader path is invalid: ${requestPath}. It must contain dist/index.mjs and config.json.`
    );
  }

  const envPath = ensureAbsolutePath(process.env.TALLY_LOADER_ROOT || '');
  if (envPath && isValidLoaderRoot(envPath)) {
    preferredLoaderRoot = envPath;
    lastResolvedLoaderRoot = envPath;
    return envPath;
  }

  if (preferredLoaderRoot && isValidLoaderRoot(preferredLoaderRoot)) {
    lastResolvedLoaderRoot = preferredLoaderRoot;
    return preferredLoaderRoot;
  }

  for (const candidate of DEFAULT_LOADER_ROOT_CANDIDATES) {
    if (isValidLoaderRoot(candidate)) {
      preferredLoaderRoot = candidate;
      lastResolvedLoaderRoot = candidate;
      return candidate;
    }
  }

  const discovered = findLoaderRootRecursively(__dirname);
  if (discovered) {
    preferredLoaderRoot = discovered;
    lastResolvedLoaderRoot = discovered;
    return discovered;
  }

  throw new Error(
    'Tally loader utility not found. Keep the bundled loader folder next to the app, or set TALLY_LOADER_ROOT environment variable.'
  );
};

const readJsonBody = (req: any, maxBytes = 1024 * 1024): Promise<any> => {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      if (raw.length > maxBytes) {
        reject(new Error('Request body too large.'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
};

const readRawBody = (req: any, maxBytes = 200 * 1024 * 1024): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Uploaded file is too large.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
};

const runCommand = (
  command: string,
  args: string[],
  cwd: string,
  onStdout?: (line: string) => void,
  onStderr?: (line: string) => void
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> => {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      onStderr?.(text);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
};

const ensureLoaderDependencies = async (loaderRoot: string) => {
  const nodeModulesPath = path.join(loaderRoot, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) return;

  appendLoaderLog('Installing loader utility dependencies (npm install)...');
  if (process.platform === 'win32') {
    const installResult = await runCommand('cmd.exe', ['/c', 'npm install'], loaderRoot, appendLoaderLog, appendLoaderLog);
    if (installResult.code !== 0) {
      throw new Error(`Failed to install loader dependencies. ${installResult.stderr || installResult.stdout}`);
    }
    return;
  }

  const installResult = await runCommand('npm', ['install'], loaderRoot, appendLoaderLog, appendLoaderLog);
  if (installResult.code !== 0) {
    throw new Error(`Failed to install loader dependencies. ${installResult.stderr || installResult.stdout}`);
  }
};

const getPreferredOutputFile = (tableName: string, files: string[]): string | null => {
  const jsonFile = `${tableName}.json`;
  const csvFile = `${tableName}.csv`;
  const normalized = files.map((f) => f.toLowerCase());
  const jsonIndex = normalized.indexOf(jsonFile);
  if (jsonIndex >= 0) return files[jsonIndex];
  const csvIndex = normalized.indexOf(csvFile);
  if (csvIndex >= 0) return files[csvIndex];
  return null;
};

const clearLoaderOutputDir = (loaderRoot: string) => {
  const outputDir = path.join(loaderRoot, 'csv');
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
};

const collectLoaderOutputTables = (
  loaderRoot: string,
  stdout: string,
  stderr: string,
  startedAt: number
): Record<string, TablePayload> => {
  const outputDir = path.join(loaderRoot, 'csv');

  if (!fs.existsSync(outputDir)) {
    const combinedOutput = `${stdout}\n${stderr}`.toLowerCase();
    if (combinedOutput.includes('unable to connect with tally')) {
      throw new Error(
        'Loader could not connect to Tally XML server. Open Tally, enable XML port (default 9000), and retry.'
      );
    }
    throw new Error(
      `Loader output folder not found at ${outputDir}. Check loader logs in /api/loader/status for exact failure.`
    );
  }

  const files = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const tables = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
  const payload: Record<string, TablePayload> = {};

  tables.forEach((tableName) => {
    const selectedFile = getPreferredOutputFile(tableName, files);
    if (!selectedFile) return;
    const fullPath = path.join(outputDir, selectedFile);
    const stat = fs.statSync(fullPath);
    // Reject stale outputs from older runs.
    if (stat.mtimeMs < startedAt - 2000) return;
    payload[tableName] = {
      filename: selectedFile,
      content: fs.readFileSync(fullPath, 'utf8'),
    };
  });

  const missingRequired = REQUIRED_TABLES.filter((name) => !payload[name]);
  if (missingRequired.length > 0) {
    throw new Error(`Loader finished, but output is missing: ${missingRequired.join(', ')}`);
  }

  return payload;
};

const summarizeLoaderOutput = (tables: Record<string, TablePayload>) => {
  const voucherTable = tables['trn_voucher'];
  const accountingTable = tables['trn_accounting'];
  const summary = {
    voucherRows: 0,
    accountingRows: 0,
    minDate: '',
    maxDate: '',
  };
  if (!voucherTable && !accountingTable) return summary;

  const parseJsonRows = (text: string): any[] => {
    try {
      const parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const voucherRows = voucherTable ? parseJsonRows(voucherTable.content) : [];
  const accountingRows = accountingTable ? parseJsonRows(accountingTable.content) : [];
  summary.voucherRows = voucherRows.length;
  summary.accountingRows = accountingRows.length;

  const dates = voucherRows
    .map((row) => String(row?.date || '').slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  if (dates.length > 0) {
    summary.minDate = dates[0];
    summary.maxDate = dates[dates.length - 1];
  }

  return summary;
};

const normalizeDateLikeIso = (value: any): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const head = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return '';
};

const applyDateRangeFilterOnLoaderTables = (
  tables: Record<string, TablePayload>,
  fromDateIso: string,
  toDateIso: string
): Record<string, TablePayload> => {
  if (!fromDateIso || !toDateIso) return tables;
  const voucherTable = tables['trn_voucher'];
  const accountingTable = tables['trn_accounting'];
  if (!voucherTable || !accountingTable) return tables;

  const parseRows = (txt: string): any[] => {
    try {
      const parsed = JSON.parse(String(txt || '').replace(/^\uFEFF/, ''));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const voucherRows = parseRows(voucherTable.content);
  if (voucherRows.length === 0) return tables;
  const filteredVouchers = voucherRows.filter((row) => {
    const dateIso = normalizeDateLikeIso(row?.date);
    if (!dateIso) return false;
    return dateIso >= fromDateIso && dateIso <= toDateIso;
  });
  const voucherGuidSet = new Set(
    filteredVouchers.map((row) => String(row?.guid || '').trim().toLowerCase()).filter(Boolean)
  );
  const accountingRows = parseRows(accountingTable.content);
  const filteredAccounting = accountingRows.filter((row) => {
    const guid = String(row?.guid || '').trim().toLowerCase();
    return guid && voucherGuidSet.has(guid);
  });

  return {
    ...tables,
    trn_voucher: {
      ...voucherTable,
      content: JSON.stringify(filteredVouchers),
    },
    trn_accounting: {
      ...accountingTable,
      content: JSON.stringify(filteredAccounting),
    },
  };
};

const runLoaderWithOverrides = async (body: any): Promise<{
  durationMs: number;
  tables: Record<string, TablePayload>;
  requestedFromDate: string;
  requestedToDate: string;
  outputSummary: ReturnType<typeof summarizeLoaderOutput>;
}> => {
  const loaderRoot = resolveLoaderRoot(body?.loaderRoot);

  await ensureLoaderDependencies(loaderRoot);
  clearLoaderOutputDir(loaderRoot);

  const args = ['./dist/index.mjs', '--database-technology', 'json'];
  const fromDate = normalizeLoaderDateInput(body?.fromDate);
  const toDate = normalizeLoaderDateInput(body?.toDate);
  const company = body?.company ? String(body.company) : '';

  if ((fromDate && !toDate) || (!fromDate && toDate)) {
    throw new Error('Both From Date and To Date are required. Use dd/mm/yyyy format.');
  }
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error('From Date must be less than or equal to To Date.');
  }

  if (fromDate) args.push('--tally-fromdate', toLoaderCliDate(fromDate));
  if (toDate) args.push('--tally-todate', toLoaderCliDate(toDate));
  if (company) args.push('--tally-company', company);

  appendLoaderLog(`Using loader root: ${loaderRoot}`);
  if (fromDate && toDate) {
    appendLoaderLog(`Requested period: ${fromDate} to ${toDate}`);
  } else {
    appendLoaderLog('Requested period: loader config/default (auto)');
  }
  appendLoaderLog(`Starting loader: node ${args.join(' ')}`);
  const started = Date.now();
  loaderProcessRunning = true;
  lastLoaderError = '';
  lastRunAt = new Date().toISOString();

  const runner = spawn(process.execPath, args, {
    cwd: loaderRoot,
    windowsHide: true,
  });
  loaderProcessRef = runner;

  let stdout = '';
  let stderr = '';

  await new Promise<void>((resolve, reject) => {
    runner.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      appendLoaderLog(text.trim());
    });
    runner.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      appendLoaderLog(text.trim());
    });
    runner.on('error', reject);
    runner.on('close', (code) => {
      loaderProcessRef = null;
      loaderProcessRunning = false;
      if (code !== 0) {
        lastLoaderError = stderr || stdout || `Loader exited with code ${code}`;
        reject(new Error(lastLoaderError));
        return;
      }
      resolve();
    });
  });

  const rawTables = collectLoaderOutputTables(loaderRoot, stdout, stderr, started);
  const tables = applyDateRangeFilterOnLoaderTables(rawTables, fromDate, toDate);
  const outputSummary = summarizeLoaderOutput(tables);
  appendLoaderLog('Loader completed successfully and output tables collected.');
  appendLoaderLog(
    `Output summary: vouchers=${outputSummary.voucherRows}, accounting=${outputSummary.accountingRows}, range=${outputSummary.minDate || 'n/a'} to ${outputSummary.maxDate || 'n/a'}`
  );

  return {
    durationMs: Date.now() - started,
    tables,
    requestedFromDate: fromDate,
    requestedToDate: toDate,
    outputSummary,
  };
};

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    // When deploying the static build to GitHub Pages, assets must resolve
    // under the repo-name subpath (https://<user>.github.io/<repo>/). The
    // deploy-pages workflow sets DEPLOY_TARGET=gh-pages so production builds
    // for Tauri / SEA / dev all continue to serve from "/" unchanged.
    const isGhPagesBuild = process.env.DEPLOY_TARGET === 'gh-pages';
    return {
      base: isGhPagesBuild ? '/finanalyzer/' : '/',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        {
          name: 'tally-loader-bridge',
          configureServer(server) {
            server.middlewares.use(async (req: any, res: any, next: any) => {
              try {
                const rawUrl = req.url || '';
                if (!rawUrl.startsWith('/api/')) {
                  next();
                  return;
                }

                const [pathname] = rawUrl.split('?');

                if (req.method === 'GET' && pathname === '/api/data/health') {
                  sendJson(res, 200, {
                    ok: true,
                    sqlite: true,
                    loadedRows: auditLoadedRows,
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/data/load') {
                  const body = await readJsonBody(req, 250 * 1024 * 1024);
                  const rows = Array.isArray(body?.rows) ? body.rows : [];
                  const result = loadAuditRows(rows);
                  sendJson(res, 200, {
                    ok: true,
                    insertedRows: result.insertedRows,
                    summary: result.summary,
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/data/import-source') {
                  const rawFile = await readRawBody(req, 300 * 1024 * 1024);
                  const result = importAuditSourceBuffer(rawFile);
                  sendJson(res, 200, {
                    ok: true,
                    insertedRows: result.insertedRows,
                    summary: result.summary,
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/data/compare-source') {
                  const rawFile = await readRawBody(req, 300 * 1024 * 1024);
                  const result = compareAuditSourcesByGuid(rawFile);
                  sendJson(res, 200, { ok: true, ...result });
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/data/export-source') {
                  const fileBuffer = exportAuditSourceBuffer();
                  const stamp = new Date().toISOString().slice(0, 10);
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/octet-stream');
                  res.setHeader('Content-Disposition', `attachment; filename=\"Tally_Source_File_${stamp}.tsf\"`);
                  res.end(fileBuffer);
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/data/source-to-excel') {
                  const rawFile = await readRawBody(req, 300 * 1024 * 1024);
                  const excelBuffer = convertAuditSourceBufferToExcel(rawFile);
                  const stamp = new Date().toISOString().slice(0, 10);
                  res.statusCode = 200;
                  res.setHeader(
                    'Content-Type',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  );
                  res.setHeader('Content-Disposition', `attachment; filename=\"Tally_Source_Raw_${stamp}.xlsx\"`);
                  res.end(excelBuffer);
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/data/summary') {
                  sendJson(res, 200, {
                    ok: true,
                    summary: getAuditSummary(),
                  });
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/data/rows') {
                  // Backward-compat: a bare /api/data/rows still returns
                  // every row (used by the SQL→memory-mode fallback in
                  // App.tsx). When the client passes any filter or paging
                  // param, we switch to the indexed paginated path.
                  const queryStart = rawUrl.indexOf('?');
                  const sp = queryStart >= 0
                    ? new URLSearchParams(rawUrl.slice(queryStart + 1))
                    : new URLSearchParams();

                  const hasParams = sp.toString().length > 0;
                  if (!hasParams) {
                    const rows = fetchAuditRows();
                    sendJson(res, 200, { ok: true, rows });
                    return;
                  }

                  const csv = (key: string) =>
                    sp.getAll(key).flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
                  const filters: RowsPageFilters = {
                    from: sp.get('from') || undefined,
                    to: sp.get('to') || undefined,
                    voucherTypes: csv('voucherType'),
                    ledgers: csv('ledger'),
                    parties: csv('party'),
                    gstin: sp.get('gstin') || undefined,
                    search: sp.get('search') || undefined,
                    limit: Number(sp.get('limit') || 0),
                    offset: Number(sp.get('offset') || 0),
                  };
                  const page = fetchAuditRowsPage(filters);
                  sendJson(res, 200, {
                    ok: true,
                    rows: page.rows,
                    total: page.total,
                    limit: filters.limit || 0,
                    offset: filters.offset || 0,
                  });
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/analytics/months') {
                  sendJson(res, 200, {
                    ok: true,
                    months: getAvailableMonthKeys(),
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/analytics/pnl') {
                  const body = await readJsonBody(req, 4 * 1024 * 1024);
                  const months = sanitizeMonthKeys(body?.months);
                  const analytics = fetchPnlAnalytics(months);
                  sendJson(res, 200, {
                    ok: true,
                    ...analytics,
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/analytics/module-rows') {
                  const body = await readJsonBody(req, 16 * 1024 * 1024);
                  const moduleType = String(body?.module || '').trim().toLowerCase();
                  if (moduleType !== 'sales' && moduleType !== 'purchase') {
                    sendJson(res, 400, { ok: false, error: 'Invalid module. Use "sales" or "purchase".' });
                    return;
                  }
                  const months = sanitizeMonthKeys(body?.months);
                  const selectedLedgers = sanitizeTextList(body?.selectedLedgers);
                  const selectedRcmLedgers = sanitizeTextList(body?.selectedRcmLedgers);
                  const rows = fetchModuleScopedRows(
                    moduleType as 'sales' | 'purchase',
                    months,
                    selectedLedgers,
                    selectedRcmLedgers
                  );
                  sendJson(res, 200, {
                    ok: true,
                    rows,
                  });
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/analytics/ledgers') {
                  sendJson(res, 200, {
                    ok: true,
                    ledgers: getLedgerList(),
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/analytics/voucher-book/page') {
                  const body = await readJsonBody(req, 8 * 1024 * 1024);
                  const payload = fetchVoucherBookPage(
                    String(body?.search || ''),
                    Number(body?.page || 1),
                    Number(body?.pageSize || 50)
                  );
                  sendJson(res, 200, { ok: true, ...payload });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/analytics/ledger-voucher/page') {
                  const body = await readJsonBody(req, 8 * 1024 * 1024);
                  const payload = fetchLedgerVoucherPage({
                    ledger: String(body?.ledger || ''),
                    fromDate: String(body?.fromDate || ''),
                    toDate: String(body?.toDate || ''),
                    search: String(body?.search || ''),
                    page: Number(body?.page || 1),
                    pageSize: Number(body?.pageSize || 50),
                  });
                  sendJson(res, 200, { ok: true, ...payload });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/data/clear') {
                  clearAuditData();
                  sendJson(res, 200, { ok: true });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/data/tds-query') {
                  const body = await readJsonBody(req, 1 * 1024 * 1024);
                  const rawLedgers: any[] = Array.isArray(body?.tdsLedgers) ? body.tdsLedgers : [];
                  const tdsLedgers: string[] = rawLedgers.map(toSafeText).filter(Boolean);
                  const minVoucherAmount = toSafeNumber(body?.minVoucherAmount);

                  if (tdsLedgers.length === 0) {
                    sendJson(res, 200, { ok: true, rows: [] });
                    return;
                  }

                  try {
                    const db = getAuditDb();
                    const placeholders = tdsLedgers.map(() => '?').join(', ');

                    const sql = `
                      WITH voucher_tds AS (
                        SELECT
                          voucher_number,
                          date,
                          voucher_type,
                          ABS(SUM(amount))                                   AS total_tds,
                          GROUP_CONCAT(DISTINCT ledger, '||')                AS tds_ledger_names
                        FROM ledger_entries
                        WHERE ledger IN (${placeholders})
                          AND COALESCE(is_accounting_voucher, 1) = 1
                        GROUP BY voucher_number, date, voucher_type
                      ),
                      voucher_party AS (
                        SELECT
                          voucher_number,
                          date,
                          voucher_type,
                          MAX(COALESCE(NULLIF(TRIM(party_name),''), ''))     AS party_name,
                          MAX(COALESCE(NULLIF(TRIM(narration),''), ''))      AS narration
                        FROM ledger_entries
                        WHERE COALESCE(is_accounting_voucher, 1) = 1
                        GROUP BY voucher_number, date, voucher_type
                      ),
                      expense_entries AS (
                        SELECT
                          voucher_number,
                          date,
                          voucher_type,
                          ledger                                             AS expense_ledger,
                          SUM(amount)                                        AS net_amount
                        FROM ledger_entries
                        WHERE (tally_primary LIKE '%xpense%' OR tally_primary LIKE '%urchase%')
                          AND COALESCE(is_accounting_voucher, 1) = 1
                        GROUP BY voucher_number, date, voucher_type, ledger
                        HAVING ABS(SUM(amount)) >= ?
                      )
                      SELECT
                        ee.voucher_number,
                        ee.date,
                        ee.voucher_type,
                        ee.expense_ledger,
                        ee.net_amount,
                        COALESCE(vp.party_name, '')       AS party_name,
                        COALESCE(vp.narration, '')        AS narration,
                        COALESCE(vt.total_tds, 0)        AS total_tds,
                        COALESCE(vt.tds_ledger_names, '') AS tds_ledger_names
                      FROM expense_entries ee
                      LEFT JOIN voucher_party vp
                        ON ee.voucher_number = vp.voucher_number
                       AND ee.date          = vp.date
                       AND ee.voucher_type  = vp.voucher_type
                      LEFT JOIN voucher_tds vt
                        ON ee.voucher_number = vt.voucher_number
                       AND ee.date          = vt.date
                       AND ee.voucher_type  = vt.voucher_type
                      ORDER BY ee.date ASC, ee.voucher_number ASC
                    `;

                    const rows = db.prepare(sql).all(...tdsLedgers, ...tdsLedgers, minVoucherAmount);
                    sendJson(res, 200, { ok: true, rows });
                  } catch (err: any) {
                    sendJson(res, 500, { ok: false, error: toSafeText(err?.message) });
                  }
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/gstr2b/import') {
                  const body = await readJsonBody(req, 80 * 1024 * 1024);
                  const sourceName = toSafeText(body?.sourceName || 'gstr2b.json');
                  const candidatePayload =
                    typeof body?.jsonText === 'string' && body.jsonText.trim()
                      ? body.jsonText
                      : body?.payload || body?.json || body;
                  const parsed = parse2BJson(candidatePayload, { sourceName });
                  const importId = newId('imp2b');
                  const uploadedAt = new Date().toISOString();
                  const importRecord = {
                    importId,
                    sourceName,
                    uploadedAt,
                    rtnprd: toSafeText(parsed?.metadata?.rtnprd || ''),
                    entityGstin: toSafeText(parsed?.metadata?.entityGstin || ''),
                    version: toSafeText(parsed?.metadata?.version || ''),
                    generatedAt: toSafeText(parsed?.metadata?.generatedAt || ''),
                    counts: {
                      totalDocuments: Number(parsed?.counts?.totalDocuments || 0),
                      b2bDocuments: Number(parsed?.counts?.b2bDocuments || 0),
                      cdnrDocuments: Number(parsed?.counts?.cdnrDocuments || 0),
                      b2baDocuments: Number(parsed?.counts?.b2baDocuments || 0),
                    },
                    totals: parsed?.totals || {},
                  };
                  gstr2bImports = [importRecord, ...gstr2bImports];
                  gstr2bRowsByImport.set(importId, Array.isArray(parsed?.rows) ? parsed.rows : []);
                  sendJson(res, 200, { ok: true, import: importRecord });
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/gstr2b/imports') {
                  sendJson(res, 200, { ok: true, imports: gstr2bImports });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/gstr2b/imports/clear') {
                  const body = await readJsonBody(req, 2 * 1024 * 1024);
                  const importIds = Array.isArray(body?.importIds)
                    ? body.importIds.map((x: any) => toSafeText(x)).filter(Boolean)
                    : [];
                  const clearAll = importIds.length === 0;
                  const idSet = new Set(importIds);
                  const prevImportCount = gstr2bImports.length;
                  const prevRowCount = Array.from(gstr2bRowsByImport.values()).reduce((acc, rows) => acc + (rows?.length || 0), 0);
                  const prevRunCount = gstr2bRuns.length;

                  if (clearAll) {
                    gstr2bImports = [];
                    gstr2bRowsByImport.clear();
                    gstr2bRuns = [];
                    sendJson(res, 200, {
                      ok: true,
                      importsCleared: prevImportCount,
                      rowsCleared: prevRowCount,
                      runsCleared: prevRunCount,
                      clearedAll: true,
                    });
                    return;
                  }

                  gstr2bImports = gstr2bImports.filter((row) => !idSet.has(toSafeText(row.importId)));
                  importIds.forEach((id) => gstr2bRowsByImport.delete(id));
                  gstr2bRuns = gstr2bRuns.filter((run) => {
                    const runImports = Array.isArray(run.importIds)
                      ? run.importIds.map((id: any) => toSafeText(id))
                      : [toSafeText(run.importId)].filter(Boolean);
                    return !runImports.some((id: string) => idSet.has(id));
                  });

                  const nextRowCount = Array.from(gstr2bRowsByImport.values()).reduce((acc, rows) => acc + (rows?.length || 0), 0);
                  sendJson(res, 200, {
                    ok: true,
                    importsCleared: prevImportCount - gstr2bImports.length,
                    rowsCleared: prevRowCount - nextRowCount,
                    runsCleared: prevRunCount - gstr2bRuns.length,
                    clearedAll: false,
                  });
                  return;
                }

                const importMatch = pathname.match(/^\/api\/gstr2b\/imports\/([^/]+)$/);
                if (req.method === 'GET' && importMatch) {
                  const importId = decodeURIComponent(importMatch[1]);
                  const importRecord = gstr2bImports.find((item) => item.importId === importId);
                  if (!importRecord) {
                    sendJson(res, 404, { ok: false, error: 'Import not found.' });
                    return;
                  }
                  sendJson(res, 200, {
                    ok: true,
                    import: importRecord,
                    rows: gstr2bRowsByImport.get(importId) || [],
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/gstr2b/reconcile') {
                  const body = await readJsonBody(req, 300 * 1024 * 1024);
                  const importIds = Array.isArray(body?.importIds)
                    ? body.importIds.map((x: any) => toSafeText(x)).filter(Boolean)
                    : [toSafeText(body?.importId)].filter(Boolean);
                  if (!importIds.length) {
                    sendJson(res, 400, { ok: false, error: 'At least one importId is required.' });
                    return;
                  }

                  const importRecords = importIds
                    .map((id) => ({ id, record: gstr2bImports.find((item) => item.importId === id) }))
                    .filter((item) => !!item.record);
                  if (importRecords.length !== importIds.length) {
                    sendJson(res, 404, { ok: false, error: 'One or more selected GSTR-2B imports were not found.' });
                    return;
                  }

                  const importRows = importRecords.flatMap(({ id, record }) =>
                    (gstr2bRowsByImport.get(id) || []).map((row: any) => ({
                      ...row,
                      sourceImportId: id,
                      sourceRtnprd: toSafeText(record?.rtnprd || ''),
                      sourceImportName: toSafeText(record?.sourceName || ''),
                    }))
                  );
                  if (!importRows.length) {
                    sendJson(res, 400, { ok: false, error: 'No parsed GSTR-2B invoices found for selected imports.' });
                    return;
                  }

                  const booksRows =
                    Array.isArray(body?.booksRows) && body.booksRows.length > 0
                      ? body.booksRows
                      : fetchAuditRows();
                  const scopeMonths = Array.isArray(body?.scope?.months)
                    ? body.scope.months.map((m: any) => toSafeText(m)).filter(Boolean)
                    : [toSafeText(body?.scope?.month || 'All')].filter(Boolean);
                  const primaryImport = importRecords[0]?.record;
                  const scope = {
                    month: scopeMonths.includes('All') ? 'All' : (scopeMonths[0] || 'All'),
                    months: scopeMonths.length ? scopeMonths : ['All'],
                    entityGstin: body?.scope?.entityGstin || primaryImport?.entityGstin || '',
                    branch: body?.scope?.branch || '',
                  };
                  const config = {
                    enableDateTolerance: body?.config?.enableDateTolerance !== false,
                    dateToleranceDays: Number(body?.config?.dateToleranceDays ?? 2),
                    invTolerance: Number(body?.config?.invTolerance ?? 10),
                    gstTolerance: Number(body?.config?.gstTolerance ?? 50),
                  };

                  const normalizedBooks = normalizeBooks(booksRows, {
                    months: scope.months,
                    entityGstin: scope.entityGstin,
                    branch: scope.branch,
                    selectedGstLedgers: Array.isArray(body?.selectedGstLedgers)
                      ? body.selectedGstLedgers
                      : [],
                    selectedRcmLedgers: Array.isArray(body?.selectedRcmLedgers)
                      ? body.selectedRcmLedgers
                      : [],
                    requireNonZeroTax: true,
                    nonZeroTaxMin: 0.005,
                  });

                  const result = reconcile(normalizedBooks, importRows, { scope, ...config });
                  const runId = newId('run2b');
                  const createdAt = new Date().toISOString();
                  const enrichedResult = {
                    ...result,
                    importId: importIds[0] || '',
                    importIds,
                    importMeta: importRecords.map((x) => x.record),
                    generatedAt: createdAt,
                  };

                  gstr2bRuns = [
                    {
                      runId,
                      importId: importIds[0] || '',
                      importIds,
                      createdAt,
                      scope,
                      config,
                      result: enrichedResult,
                      counts: enrichedResult?.counts || {},
                      summary: enrichedResult?.summary || {},
                    },
                    ...gstr2bRuns,
                  ];

                  sendJson(res, 200, {
                    ok: true,
                    runId,
                    createdAt,
                    result: enrichedResult,
                  });
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/gstr2b/runs') {
                  const runs = gstr2bRuns.map((run) => ({
                    runId: run.runId,
                    importId: run.importId,
                    importIds: Array.isArray(run.importIds) ? run.importIds : [run.importId].filter(Boolean),
                    createdAt: run.createdAt,
                    scope: run.scope,
                    counts: run.counts || {},
                    summary: run.summary || {},
                  }));
                  sendJson(res, 200, { ok: true, runs });
                  return;
                }

                const runDetailMatch = pathname.match(/^\/api\/gstr2b\/runs\/([^/]+)$/);
                if (req.method === 'GET' && runDetailMatch) {
                  const runId = decodeURIComponent(runDetailMatch[1]);
                  const run = gstr2bRuns.find((item) => item.runId === runId);
                  if (!run) {
                    sendJson(res, 404, { ok: false, error: 'Reconciliation run not found.' });
                    return;
                  }
                  sendJson(res, 200, { ok: true, run });
                  return;
                }

                const runXlsxMatch = pathname.match(/^\/api\/gstr2b\/runs\/([^/]+)\/export-xlsx$/);
                if (req.method === 'GET' && runXlsxMatch) {
                  const runId = decodeURIComponent(runXlsxMatch[1]);
                  const run = gstr2bRuns.find((item) => item.runId === runId);
                  if (!run) {
                    sendJson(res, 404, { ok: false, error: 'Reconciliation run not found.' });
                    return;
                  }
                  const buffer = exportXlsx(run.result || {});
                  const stamp = new Date().toISOString().slice(0, 10);
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                  res.setHeader('Content-Disposition', `attachment; filename=\"GSTR2B_Reconciliation_${stamp}.xlsx\"`);
                  res.end(buffer);
                  return;
                }

                const runJsonMatch = pathname.match(/^\/api\/gstr2b\/runs\/([^/]+)\/export-json$/);
                if (req.method === 'GET' && runJsonMatch) {
                  const runId = decodeURIComponent(runJsonMatch[1]);
                  const run = gstr2bRuns.find((item) => item.runId === runId);
                  if (!run) {
                    sendJson(res, 404, { ok: false, error: 'Reconciliation run not found.' });
                    return;
                  }
                  const stamp = new Date().toISOString().slice(0, 10);
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.setHeader('Content-Disposition', `attachment; filename=\"GSTR2B_Reconciliation_${stamp}.json\"`);
                  res.end(JSON.stringify(run.result || {}, null, 2));
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/loader/check') {
                  let available = false;
                  try { resolveLoaderRoot(); available = true; } catch { available = false; }
                  sendJson(res, 200, { available });
                  return;
                }

                if (req.method === 'GET' && pathname === '/api/loader/status') {
                  sendJson(res, 200, {
                    running: loaderProcessRunning,
                    lastRunAt,
                    lastError: lastLoaderError,
                    logs: loaderLogs.slice(-100),
                    loaderRoot: lastResolvedLoaderRoot || preferredLoaderRoot,
                  });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/loader/abort') {
                  if (loaderProcessRef && loaderProcessRunning) {
                    loaderProcessRef.kill();
                    loaderProcessRef = null;
                    loaderProcessRunning = false;
                    appendLoaderLog('Loader process aborted via API.');
                    sendJson(res, 200, { ok: true, aborted: true });
                    return;
                  }
                  sendJson(res, 200, { ok: true, aborted: false });
                  return;
                }

                if (req.method === 'POST' && pathname === '/api/loader/run-and-export') {
                  if (loaderProcessRunning) {
                    sendJson(res, 409, { ok: false, error: 'Loader sync is already running.' });
                    return;
                  }
                  const body = await readJsonBody(req);
                  const result = await runLoaderWithOverrides(body);
                  sendJson(res, 200, {
                    ok: true,
                    durationMs: result.durationMs,
                    tables: result.tables,
                    requestedFromDate: result.requestedFromDate,
                    requestedToDate: result.requestedToDate,
                    outputSummary: result.outputSummary,
                  });
                  return;
                }

                sendJson(res, 404, { ok: false, error: 'API route not found.' });
              } catch (error: any) {
                const message = error?.message || 'Unexpected loader API error.';
                if ((req?.url || '').startsWith('/api/loader/')) {
                  loaderProcessRef = null;
                  loaderProcessRunning = false;
                  appendLoaderLog(`API error: ${message}`);
                }
                sendJson(res, 500, { ok: false, error: message });
              }
            });
          },
        },
      ],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      build: {
        chunkSizeWarningLimit: 1400,
        rollupOptions: {
          output: {
            manualChunks: {
              charts: ['recharts'],
              excel: ['xlsx', 'xlsx-js-style'],
              parsing: ['papaparse', 'dayjs'],
            },
          },
        },
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
