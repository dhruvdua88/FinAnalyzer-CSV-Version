const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const XLSX = require('xlsx');
const {
  parse2BJson,
  normalizeBooks,
  reconcile,
  exportXlsx,
} = require('./services/gstr2bReconciliation.cjs');

// better-sqlite3 is a CommonJS native addon. If the native binary is missing
// for the current platform/Node version, fall back to the in-memory JS path
// (memoryRows etc.) so the app still launches; the user gets a SQL-disabled
// experience rather than a hard crash.
let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const {
  resolveAuditDbPath,
  applyAuditPragmas,
  initializeAuditSchema,
  hashRows,
  getLastImportHash,
  recordImport,
} = require('./services/auditDbCore.cjs');

const REQUIRED_TABLES = ['trn_accounting', 'trn_voucher'];
const OPTIONAL_TABLES = ['mst_ledger', 'mst_group'];

const sendJson = (res, statusCode, data) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
};

const toSafeNumber = (value) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toSafeText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value);
};

const toAccountingFlag = (value) => {
  const text = toSafeText(value).trim().toLowerCase();
  if (!text) return 1;
  if (['1', 'true', 'yes', 'y'].includes(text)) return 1;
  if (['0', 'false', 'no', 'n'].includes(text)) return 0;
  return toSafeNumber(value) > 0 ? 1 : 0;
};

const parseDdMmYyyyToIso = (value) => {
  const match = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const dd = Number(match[1]);
  const mm = Number(match[2]);
  const yyyy = Number(match[3]);
  const dt = new Date(yyyy, mm - 1, dd);
  if (dt.getFullYear() !== yyyy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};

const normalizeLoaderDateInput = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return parseDdMmYyyyToIso(text) || '';
};

const toLoaderCliDate = (isoDate) => String(isoDate || '').replace(/-/g, '');

const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const newId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const toJsonText = (value) => JSON.stringify(value ?? {});
const parseJsonText = (value, fallback = null) => {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
};

const createBackendServer = async (options) => {
  const appRoot = options.appRoot;
  const resourcesRoot = options.resourcesRoot || '';
  const tempDirBase = options.tempDir || appRoot;
  const preferredPort = Number(options.port || 5173);

  const loaderLogs = [];
  let loaderProcessRunning = false;
  let loaderProcessRef = null;
  let lastLoaderError = '';
  let lastRunAt = '';
  let preferredLoaderRoot = '';
  let lastResolvedLoaderRoot = '';

  const appendLoaderLog = (message) => {
    const entry = `[${new Date().toISOString()}] ${String(message || '').trim()}`;
    loaderLogs.push(entry);
    if (loaderLogs.length > 500) loaderLogs.shift();
  };

  const tempDataDir = path.join(tempDirBase, 'tally-source-temp');
  const ensureTempDataDir = () => {
    if (!fs.existsSync(tempDataDir)) fs.mkdirSync(tempDataDir, { recursive: true });
  };

  // Schema, PRAGMAs, and indexes are owned by ./services/auditDbCore.cjs.
  // Imported at the top of this file; both the dev server (vite.config.ts)
  // and this backend share the same definition.

  let auditDb = null;
  let memoryRows = [];
  let loadedRows = 0;
  let memoryGstr2bImports = [];
  let memoryGstr2bImportRows = [];
  let memoryGstr2bRuns = [];
  // If the better-sqlite3 native binary isn't available for this platform/Node
  // combo, the backend falls through to in-memory JS arrays. That path is
  // slow but keeps the app functional.
  const sqliteAvailable = !!Database;

  const getAuditDb = () => {
    if (!sqliteAvailable) return null;
    if (auditDb) return auditDb;
    // Persist to ~/.finanalyzer/audit.sqlite so the data survives server
    // restarts and is shared with the vite dev server (same file path).
    const dbPath = resolveAuditDbPath();
    auditDb = new Database(dbPath);
    applyAuditPragmas(auditDb);
    initializeAuditSchema(auditDb);
    return auditDb;
  };

  const summarizeRowsArray = (rows) => {
    const transactional = rows.filter((row) => toSafeNumber(row?.is_master_ledger) === 0);
    const vouchers = new Set();
    let minDate = '';
    let maxDate = '';
    transactional.forEach((r) => {
      const v = toSafeText(r.voucher_number);
      if (v) vouchers.add(v);
      const d = toSafeText(r.date);
      if (d) {
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
      }
    });
    return {
      totalRows: transactional.length,
      uniqueVouchers: vouchers.size,
      minDate,
      maxDate,
    };
  };

  const fetchAuditRows = () => {
    if (!sqliteAvailable) {
      return memoryRows.slice().sort((a, b) => {
        const da = toSafeText(a.date);
        const db = toSafeText(b.date);
        if (da !== db) return da.localeCompare(db);
        return toSafeText(a.voucher_number).localeCompare(toSafeText(b.voucher_number));
      });
    }
    const db = getAuditDb();
    return db.prepare(`
      SELECT
        guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
        party_name, gstin, ledger AS Ledger, amount, group_name AS "Group",
        opening_balance, closing_balance, tally_parent AS TallyParent, tally_primary AS TallyPrimary,
        is_revenue, is_accounting_voucher, is_master_ledger
      FROM ledger_entries
      ORDER BY date ASC, voucher_number ASC, id ASC
    `).all();
  };

  /**
   * Filter + paginate ledger_entries from a query-string. Returns
   * { rows, total } with `total` = pre-pagination count. See vite.config.ts
   * fetchAuditRowsPage for the SQL-mode rationale; here we also handle the
   * memory-mode fallback with the same filter shape.
   */
  const fetchAuditRowsPage = (filters) => {
    const safe = filters || {};
    const from = typeof safe.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(safe.from) ? safe.from : '';
    const to = typeof safe.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(safe.to) ? safe.to : '';
    const voucherTypes = Array.isArray(safe.voucherTypes) ? safe.voucherTypes.filter(Boolean) : [];
    const ledgers = Array.isArray(safe.ledgers) ? safe.ledgers.filter(Boolean) : [];
    const parties = Array.isArray(safe.parties) ? safe.parties.filter(Boolean) : [];
    const gstin = typeof safe.gstin === 'string' && safe.gstin.trim() ? safe.gstin.trim() : '';
    const search = typeof safe.search === 'string' && safe.search.trim() ? safe.search.trim() : '';
    const limit = Math.max(0, Number(safe.limit) || 0);
    const offset = Math.max(0, Number(safe.offset) || 0);

    if (!sqliteAvailable) {
      // Memory fallback: same filter semantics, but JS-side. Slow but
      // functionally identical so the client doesn't have to branch.
      let pool = memoryRows;
      if (from) pool = pool.filter((r) => toSafeText(r.date) >= from);
      if (to) pool = pool.filter((r) => toSafeText(r.date) <= to);
      if (voucherTypes.length) {
        const set = new Set(voucherTypes);
        pool = pool.filter((r) => set.has(toSafeText(r.voucher_type)));
      }
      if (ledgers.length) {
        const set = new Set(ledgers);
        pool = pool.filter((r) => set.has(toSafeText(r.ledger || r.Ledger)));
      }
      if (parties.length) {
        const set = new Set(parties);
        pool = pool.filter((r) => set.has(toSafeText(r.party_name)));
      }
      if (gstin) pool = pool.filter((r) => toSafeText(r.gstin) === gstin);
      if (search) {
        const needle = search.toLowerCase();
        pool = pool.filter((r) =>
          toSafeText(r.voucher_number).toLowerCase().includes(needle) ||
          toSafeText(r.narration).toLowerCase().includes(needle) ||
          toSafeText(r.party_name).toLowerCase().includes(needle)
        );
      }
      const total = pool.length;
      pool = pool.slice().sort((a, b) => toSafeText(a.date).localeCompare(toSafeText(b.date)) ||
        toSafeText(a.voucher_number).localeCompare(toSafeText(b.voucher_number)));
      const sliced = limit > 0 ? pool.slice(offset, offset + limit) : pool.slice(offset);
      return { rows: sliced, total };
    }

    const db = getAuditDb();
    const where = [];
    const params = [];
    if (from) { where.push('date >= ?'); params.push(from); }
    if (to) { where.push('date <= ?'); params.push(to); }
    if (voucherTypes.length) {
      where.push(`voucher_type IN (${voucherTypes.map(() => '?').join(', ')})`);
      params.push(...voucherTypes);
    }
    if (ledgers.length) {
      where.push(`ledger IN (${ledgers.map(() => '?').join(', ')})`);
      params.push(...ledgers);
    }
    if (parties.length) {
      where.push(`party_name IN (${parties.map(() => '?').join(', ')})`);
      params.push(...parties);
    }
    if (gstin) { where.push('gstin = ?'); params.push(gstin); }
    if (search) {
      where.push('(voucher_number LIKE ? OR narration LIKE ? OR party_name LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM ledger_entries ${whereSql}`).get(...params)?.c || 0);
    const limitClause = limit > 0 ? ` LIMIT ${limit} OFFSET ${offset}` : '';
    const rows = db.prepare(`
      SELECT guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
             party_name, gstin, ledger AS Ledger, amount, group_name AS "Group",
             opening_balance, closing_balance, tally_parent AS TallyParent, tally_primary AS TallyPrimary,
             is_revenue, is_accounting_voucher, is_master_ledger
      FROM ledger_entries
      ${whereSql}
      ORDER BY date ASC, voucher_number ASC, id ASC
      ${limitClause}
    `).all(...params);
    return { rows, total };
  };

  const getAuditSummary = () => {
    if (!sqliteAvailable) return summarizeRowsArray(memoryRows);
    const db = getAuditDb();
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS totalRows,
        COUNT(DISTINCT voucher_number) AS uniqueVouchers,
        COALESCE(MIN(date), '') AS minDate,
        COALESCE(MAX(date), '') AS maxDate
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
    `).get();
    return {
      totalRows: Number(summary?.totalRows || 0),
      uniqueVouchers: Number(summary?.uniqueVouchers || 0),
      minDate: String(summary?.minDate || ''),
      maxDate: String(summary?.maxDate || ''),
    };
  };

  const insertAuditRows = (db, rows) => {
    const stmt = db.prepare(`
      INSERT INTO ledger_entries (
        guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
        party_name, gstin, ledger, amount, group_name, opening_balance, closing_balance,
        tally_parent, tally_primary, is_revenue, is_accounting_voucher, is_master_ledger
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    rows.forEach((row) => {
      if (toAccountingFlag(row?.is_accounting_voucher) !== 1) return;
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
      inserted += 1;
    });
    return inserted;
  };

  const buildReferenceCollectionsForExport = (db) => {
    // See vite.config.ts for the full rationale. Three VIEWs replacing three
    // CREATE TABLE+DELETE+INSERT cycles. The correlated NOT EXISTS that used
    // to re-scan ledger_entries per row is hoisted into a CTE so it
    // evaluates exactly once.
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

  const loadAuditRows = (rows) => {
    if (!sqliteAvailable) {
      memoryRows = (Array.isArray(rows) ? rows : []).filter((r) => toAccountingFlag(r?.is_accounting_voucher) === 1);
      loadedRows = memoryRows.length;
      return { insertedRows: loadedRows, summary: getAuditSummary() };
    }
    const db = getAuditDb();

    // Hash-skip: identical re-imports return immediately. The DB is persisted
    // to disk so the previous data is still there.
    const safeRows = Array.isArray(rows) ? rows : [];
    const sourceHash = hashRows(safeRows);
    const lastImport = getLastImportHash(db);
    if (lastImport && lastImport.source_hash === sourceHash) {
      const summary = getAuditSummary();
      loadedRows = summary.totalRows;
      return { insertedRows: summary.totalRows, summary };
    }

    // db.transaction(fn) is the better-sqlite3 fast path. It wraps DELETE +
    // bulk INSERT in a single savepoint; on throw it rolls back automatically.
    const runImport = db.transaction((batch) => {
      db.exec('DELETE FROM ledger_entries;');
      const n = insertAuditRows(db, batch);
      recordImport(db, sourceHash, n);
      return n;
    });

    const inserted = runImport(safeRows);
    loadedRows = inserted;
    return { insertedRows: inserted, summary: getAuditSummary() };
  };

  const sanitizeMonthKeys = (months) => {
    if (!Array.isArray(months)) return [];
    const out = new Set();
    months.forEach((value) => {
      const text = String(value || '').trim();
      if (/^(0[1-9]|1[0-2])\/\d{4}$/.test(text)) out.add(text);
    });
    return Array.from(out);
  };

  const sanitizeTextList = (values) => {
    if (!Array.isArray(values)) return [];
    const out = new Set();
    values.forEach((value) => {
      const text = String(value || '').trim().toLowerCase();
      if (text) out.add(text);
    });
    return Array.from(out);
  };

  const monthKeyFromDate = (dateValue) => {
    const date = String(dateValue || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    return `${date.slice(5, 7)}/${date.slice(0, 4)}`;
  };

  const buildMonthFilterSql = (monthKeys) => {
    const clean = sanitizeMonthKeys(monthKeys);
    if (!clean.length) return { clause: '', params: [] };
    const placeholders = clean.map(() => '?').join(', ');
    return {
      clause: ` AND (substr(date, 6, 2) || '/' || substr(date, 1, 4)) IN (${placeholders})`,
      params: clean,
    };
  };

  const getAvailableMonthKeys = () => {
    if (!sqliteAvailable) {
      return Array.from(new Set(memoryRows.map((row) => monthKeyFromDate(row?.date)).filter(Boolean))).sort();
    }
    const db = getAuditDb();
    const rows = db.prepare(`
      SELECT DISTINCT (substr(date, 6, 2) || '/' || substr(date, 1, 4)) AS monthKey
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        AND date GLOB '????-??-??'
      ORDER BY monthKey ASC
    `).all();
    return rows.map((row) => String(row?.monthKey || '')).filter(Boolean);
  };

  const fetchModuleScopedRows = (moduleType, monthKeys, selectedLedgers, selectedRcmLedgers = []) => {
    const cleanMonths = sanitizeMonthKeys(monthKeys);
    const ledgers = sanitizeTextList(selectedLedgers);
    const rcmLedgers = sanitizeTextList(selectedRcmLedgers);

    if (!sqliteAvailable) {
      const source = memoryRows.filter((row) => toSafeNumber(row?.is_master_ledger) === 0);
      const monthSet = new Set(cleanMonths);
      const isWithinMonth = (row) => !monthSet.size || monthSet.has(monthKeyFromDate(row?.date));
      const ledgerMatches = (row, targets) => targets.includes(String(row?.Ledger || '').trim().toLowerCase());
      const primaryText = (row) => String(row?.TallyPrimary || '').toLowerCase();

      const candidates = source.filter((row) => {
        if (!isWithinMonth(row)) return false;
        const primary = primaryText(row);
        if (moduleType === 'sales') {
          return primary.includes('sale') || primary.includes('income') || ledgerMatches(row, ledgers);
        }
        const expenseTargets = Array.from(new Set([...ledgers, ...rcmLedgers]));
        return (
          primary.includes('purchase') ||
          primary.includes('expense') ||
          primary.includes('fixed asset') ||
          ledgerMatches(row, expenseTargets)
        );
      });
      const voucherSet = new Set(candidates.map((row) => String(row?.voucher_number || '')).filter(Boolean));
      return source.filter((row) => isWithinMonth(row) && voucherSet.has(String(row?.voucher_number || '')));
    }

    const db = getAuditDb();
    const monthFilterForCandidate = buildMonthFilterSql(cleanMonths);
    const monthFilterForRows = buildMonthFilterSql(cleanMonths);
    const conditionParts = [];
    const conditionParams = [];

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
      const expenseTargets = Array.from(new Set([...ledgers, ...rcmLedgers]));
      if (expenseTargets.length > 0) {
        conditionParts.push(`LOWER(COALESCE(ledger, '')) IN (${expenseTargets.map(() => '?').join(', ')})`);
        conditionParams.push(...expenseTargets);
      }
    }

    const conditionSql = conditionParts.length ? conditionParts.map((part) => `(${part})`).join(' OR ') : '1=0';
    const rows = db.prepare(`
      WITH candidate_vouchers AS (
        SELECT DISTINCT voucher_number
        FROM ledger_entries
        WHERE COALESCE(is_master_ledger, 0) = 0
          AND (${conditionSql})
          ${monthFilterForCandidate.clause}
      )
      SELECT
        guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
        party_name, gstin, ledger AS Ledger, amount, group_name AS "Group",
        opening_balance, closing_balance, tally_parent AS TallyParent, tally_primary AS TallyPrimary,
        is_revenue, is_accounting_voucher, is_master_ledger
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        AND voucher_number IN (SELECT voucher_number FROM candidate_vouchers)
        ${monthFilterForRows.clause}
      ORDER BY date ASC, voucher_number ASC, id ASC
    `).all(
      ...conditionParams,
      ...monthFilterForCandidate.params,
      ...monthFilterForRows.params
    );
    return rows;
  };

  const hasAnyWord = (text, words) => words.some((word) => text.includes(word));
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

  const fetchPnlAnalytics = (monthKeys) => {
    const cleanMonths = sanitizeMonthKeys(monthKeys);
    const monthSet = new Set(cleanMonths);

    let rows;
    if (!sqliteAvailable) {
      rows = memoryRows.filter((row) => {
        if (toSafeNumber(row?.is_master_ledger) > 0) return false;
        if (!monthSet.size) return true;
        return monthSet.has(monthKeyFromDate(row?.date));
      }).map((row) => ({
        primaryName: toSafeText(row?.TallyPrimary || 'Unspecified Primary'),
        parentName: toSafeText(row?.TallyParent || row?.Group || 'Unspecified Parent'),
        ledgerName: toSafeText(row?.Ledger || 'Unknown Ledger'),
        totalAmount: toSafeNumber(row?.amount),
        entryCount: 1,
        revenueFlagCount: toSafeNumber(row?.is_revenue) > 0 ? 1 : 0,
      }));
    } else {
      const db = getAuditDb();
      const monthFilter = buildMonthFilterSql(cleanMonths);
      rows = db.prepare(`
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
      `).all(...monthFilter.params);
    }

    const primaryMap = new Map();
    rows.forEach((row) => {
      const primary = toSafeText(row?.primaryName || 'Unspecified Primary');
      const parent = toSafeText(row?.parentName || 'Unspecified Parent');
      const ledger = toSafeText(row?.ledgerName || 'Unknown Ledger');
      const totalAmount = toSafeNumber(row?.totalAmount);
      const entryCount = toSafeNumber(row?.entryCount);
      const revenueFlagCount = toSafeNumber(row?.revenueFlagCount);

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
      const bucket = primaryMap.get(primary);
      bucket.total += totalAmount;
      bucket.revenueFlagCount += revenueFlagCount;

      const combinedText = `${primary} ${parent}`.toLowerCase();
      if (combinedText.includes('stock') || combinedText.includes('inventory')) bucket.hasStockOrInventoryWord = true;
      if (hasAnyWord(combinedText, BS_HINT_WORDS) && !hasAnyWord(combinedText, PNL_HINT_WORDS)) bucket.likelyBalanceSheet = true;

      if (!bucket.parentMap.has(parent)) {
        bucket.parentMap.set(parent, { total: 0, ledgers: new Map() });
      }
      const parentNode = bucket.parentMap.get(parent);
      parentNode.total += totalAmount;

      if (!parentNode.ledgers.has(ledger)) {
        parentNode.ledgers.set(ledger, { total: 0, entries: 0 });
      }
      const ledgerNode = parentNode.ledgers.get(ledger);
      ledgerNode.total += totalAmount;
      ledgerNode.entries += entryCount;
    });

    const primaryBuckets = Array.from(primaryMap.values()).map((bucket) => {
      const parentBreakup = Array.from(bucket.parentMap.entries()).map(([parent, node]) => ({
        parent,
        total: node.total,
        ledgers: Array.from(node.ledgers.entries()).map(([ledger, ledgerNode]) => ({
          ledger,
          total: ledgerNode.total,
          entries: ledgerNode.entries,
        })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
      })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

      return {
        primary: bucket.primary,
        total: bucket.total,
        revenueFlagCount: bucket.revenueFlagCount,
        explicitPnlCount: bucket.explicitPnlCount,
        explicitBsCount: bucket.explicitBsCount,
        likelyBalanceSheet: bucket.likelyBalanceSheet,
        hasStockOrInventoryWord: bucket.hasStockOrInventoryWord,
        parentNames: parentBreakup.map((row) => row.parent),
        parentBreakup,
      };
    }).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

    let stockLedgerTotals = [];
    let openingStockTotal = 0;
    let closingStockTotal = 0;

    if (!sqliteAvailable) {
      const stockMap = new Map();
      memoryRows.forEach((row) => {
        if (toSafeNumber(row?.is_master_ledger) > 0) return;
        if (monthSet.size && !monthSet.has(monthKeyFromDate(row?.date))) return;
        const text = `${toSafeText(row?.TallyPrimary)} ${toSafeText(row?.TallyParent)} ${toSafeText(row?.Ledger)}`.toLowerCase();
        if (text.includes('opening stock')) openingStockTotal += toSafeNumber(row?.amount);
        if (text.includes('closing stock')) closingStockTotal += toSafeNumber(row?.amount);
        if (!(text.includes('stock') || text.includes('inventory'))) return;
        const ledger = toSafeText(row?.Ledger || 'Unknown Ledger');
        stockMap.set(ledger, (stockMap.get(ledger) || 0) + toSafeNumber(row?.amount));
      });
      stockLedgerTotals = Array.from(stockMap.entries())
        .map(([ledger, amount]) => ({ ledger, amount }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    } else {
      const db = getAuditDb();
      const monthFilter = buildMonthFilterSql(cleanMonths);
      const stockRows = db.prepare(`
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
      `).all(...monthFilter.params);
      stockLedgerTotals = stockRows.map((row) => ({
        ledger: toSafeText(row?.ledgerName || 'Unknown Ledger'),
        amount: toSafeNumber(row?.totalAmount),
      }));

      const openingRow = db.prepare(`
        SELECT SUM(COALESCE(amount, 0)) AS totalAmount
        FROM ledger_entries
        WHERE COALESCE(is_master_ledger, 0) = 0
          ${monthFilter.clause}
          AND LOWER(
            COALESCE(tally_primary, '') || ' ' ||
            COALESCE(tally_parent, '') || ' ' ||
            COALESCE(ledger, '')
          ) LIKE '%opening stock%'
      `).get(...monthFilter.params);
      const closingRow = db.prepare(`
        SELECT SUM(COALESCE(amount, 0)) AS totalAmount
        FROM ledger_entries
        WHERE COALESCE(is_master_ledger, 0) = 0
          ${monthFilter.clause}
          AND LOWER(
            COALESCE(tally_primary, '') || ' ' ||
            COALESCE(tally_parent, '') || ' ' ||
            COALESCE(ledger, '')
          ) LIKE '%closing stock%'
      `).get(...monthFilter.params);
      openingStockTotal = toSafeNumber(openingRow?.totalAmount);
      closingStockTotal = toSafeNumber(closingRow?.totalAmount);
    }

    return {
      months: getAvailableMonthKeys(),
      primaryBuckets,
      stockLedgerTotals,
      defaultOpeningStock: openingStockTotal !== 0 ? openingStockTotal : toSafeNumber(stockLedgerTotals[0]?.amount),
      defaultClosingStock:
        closingStockTotal !== 0
          ? closingStockTotal
          : toSafeNumber(stockLedgerTotals[1]?.amount || stockLedgerTotals[0]?.amount),
    };
  };

  const VOUCHER_NUMBER_SQL = `COALESCE(NULLIF(TRIM(voucher_number), ''), COALESCE(NULLIF(TRIM(invoice_number), ''), 'UNKNOWN'))`;
  const VOUCHER_DATE_SQL = `COALESCE(NULLIF(TRIM(date), ''), '')`;
  const VOUCHER_TYPE_SQL = `COALESCE(NULLIF(TRIM(voucher_type), ''), '')`;

  const normalizePage = (value) => {
    const page = Number(value);
    if (!Number.isFinite(page) || page < 1) return 1;
    return Math.floor(page);
  };

  const normalizePageSize = (value) => {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return 50;
    return Math.min(250, Math.max(10, Math.floor(size)));
  };

  const parseDateTs = (value) => {
    if (!value) return 0;
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const d = new Date(`${text}T00:00:00`);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
      const [dd, mm, yyyy] = text.split('/').map(Number);
      const d = new Date(yyyy, mm - 1, dd);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  };

  const parseOptionalNumber = (value) => {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    const parsed = Number(text.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const resolveVoucherParty = (entries) => {
    const byPartyName = entries.map((entry) => toSafeText(entry?.party_name).trim()).find((v) => v.length > 0);
    if (byPartyName) return byPartyName;
    const likely = entries.find((entry) => {
      const primary = toSafeText(entry?.TallyPrimary).toLowerCase();
      const parent = toSafeText(entry?.TallyParent).toLowerCase();
      return primary.includes('debtor') || parent.includes('debtor') || primary.includes('creditor') || parent.includes('creditor');
    });
    if (likely?.Ledger && toSafeText(likely.Ledger).trim()) return toSafeText(likely.Ledger).trim();
    return '-';
  };

  const isSyntheticUnknownVoucher = (voucherNumber) => /^unknown(?:-\d+)?$/i.test(toSafeText(voucherNumber).trim());

  const getGuidFamilyKey = (guid) => {
    const text = toSafeText(guid).trim();
    if (!text) return '';
    if (!/-\d+$/.test(text)) return text;
    return text.replace(/-\d+$/, '');
  };

  const normalizeVoucherIdentity = (row) => {
    const voucherNumber = toSafeText(row?.voucher_number || row?.invoice_number || 'UNKNOWN').trim() || 'UNKNOWN';
    const date = toSafeText(row?.date).trim();
    const voucherType = toSafeText(row?.voucher_type).trim();
    const guidFamily = getGuidFamilyKey(row?.guid);
    const voucherFamily = isSyntheticUnknownVoucher(voucherNumber) && guidFamily
      ? `UNKNOWN_GUID::${guidFamily}`
      : voucherNumber;
    const groupKey = `${voucherFamily}__${date}__${voucherType}`;
    return { voucherNumber, date, voucherType, voucherFamily, groupKey };
  };

  const mapEntryLikeLedgerRow = (row) => ({
    guid: toSafeText(row?.guid),
    date: toSafeText(row?.rawDate || row?.date),
    voucher_type: toSafeText(row?.voucher_type),
    voucher_number: toSafeText(row?.voucher_number),
    invoice_number: toSafeText(row?.invoice_number),
    reference_number: toSafeText(row?.reference_number),
    narration: toSafeText(row?.narration),
    party_name: toSafeText(row?.party_name),
    gstin: toSafeText(row?.gstin),
    Ledger: toSafeText(row?.Ledger),
    amount: toSafeNumber(row?.amount),
    Group: toSafeText(row?.Group),
    opening_balance: toSafeNumber(row?.opening_balance),
    closing_balance: toSafeNumber(row?.closing_balance),
    TallyParent: toSafeText(row?.TallyParent),
    TallyPrimary: toSafeText(row?.TallyPrimary),
    is_revenue: toSafeNumber(row?.is_revenue),
    is_accounting_voucher: toSafeNumber(row?.is_accounting_voucher),
    is_master_ledger: toSafeNumber(row?.is_master_ledger),
  });

  const fetchEntriesForVoucherKeys = (keys) => {
    if (!keys.length) return [];
    if (!sqliteAvailable) {
      const keySet = new Set(keys.map((k) => `${k.voucherNumber}__${k.date}__${k.voucherType}`));
      return memoryRows
        .filter((row) => toSafeNumber(row?.is_master_ledger) === 0)
        .filter((row) => {
          const normalized = normalizeVoucherIdentity(row);
          return keySet.has(`${normalized.voucherNumber}__${normalized.date}__${normalized.voucherType}`);
        })
        .map((row) => {
          const normalized = normalizeVoucherIdentity(row);
          return {
            voucherNumber: normalized.voucherNumber,
            date: normalized.date,
            voucherType: normalized.voucherType,
            ...mapEntryLikeLedgerRow(row),
          };
        });
    }

    const db = getAuditDb();
    const placeholders = keys.map(() => '(?, ?, ?)').join(', ');
    const params = keys.flatMap((key) => [key.voucherNumber, key.date, key.voucherType]);

    return db.prepare(`
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
    `).all(...params).map((row) => ({
      ...row,
      ...mapEntryLikeLedgerRow(row),
    }));
  };

  const fetchVoucherBookPage = (search, page, pageSize) => {
    const safePage = normalizePage(page);
    const safePageSize = normalizePageSize(pageSize);
    const q = toSafeText(search).trim().toLowerCase();

    const sourceRows = !sqliteAvailable
      ? memoryRows.slice()
      : getAuditDb().prepare(`
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
        `).all();

    const groupedMap = new Map();
    sourceRows.forEach((row) => {
      if (toSafeNumber(row?.is_master_ledger) > 0) return;
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
      const node = groupedMap.get(identity.groupKey);
      const candidateVoucher = identity.voucherNumber;
      if (
        isSyntheticUnknownVoucher(node.voucherNumber) &&
        candidateVoucher &&
        (!isSyntheticUnknownVoucher(candidateVoucher) || candidateVoucher.localeCompare(node.voucherNumber) < 0)
      ) {
        node.voucherNumber = candidateVoucher;
      }
      const entry = mapEntryLikeLedgerRow(row);
      node.entries.push(entry);
      if (entry.amount < 0) node.totalDr += Math.abs(entry.amount);
      if (entry.amount > 0) node.totalCr += entry.amount;
      if (!node.firstId || Number(row?.id || 0) < node.firstId) node.firstId = Number(row?.id || 0);
    });

    const grouped = Array.from(groupedMap.values())
      .map((row) => ({
        ...row,
        party: resolveVoucherParty(row.entries),
        narration: row.entries.map((entry) => toSafeText(entry.narration).trim()).find((v) => v.length > 0) || '',
        lineCount: row.entries.length,
      }))
      .sort((a, b) => {
        const d = parseDateTs(b.date) - parseDateTs(a.date);
        if (d !== 0) return d;
        const v = a.voucherNumber.localeCompare(b.voucherNumber);
        if (v !== 0) return v;
        return Number(a.firstId || 0) - Number(b.firstId || 0);
      });

    const filtered = q
      ? grouped.filter((row) => {
          return (
            row.voucherNumber.toLowerCase().includes(q) ||
            row.voucherType.toLowerCase().includes(q) ||
            row.party.toLowerCase().includes(q) ||
            row.narration.toLowerCase().includes(q)
          );
        })
      : grouped;

    const totalRows = filtered.length;
    const totalPages = totalRows > 0 ? Math.ceil(totalRows / safePageSize) : 1;
    const currentPage = Math.min(safePage, totalPages);
    const start = (currentPage - 1) * safePageSize;
    const rows = filtered.slice(start, start + safePageSize);

    const totals = filtered.reduce(
      (acc, row) => {
        acc.vouchers += 1;
        acc.lines += row.lineCount;
        acc.dr += row.totalDr;
        acc.cr += row.totalCr;
        return acc;
      },
      { vouchers: 0, lines: 0, dr: 0, cr: 0 }
    );

    return {
      page: currentPage,
      pageSize: safePageSize,
      totalRows,
      totalPages,
      totals,
      rows,
    };
  };

  const getLedgerList = () => {
    if (!sqliteAvailable) {
      return Array.from(
        new Set(
          memoryRows
            .map((row) => toSafeText(row?.Ledger).trim())
            .filter((value) => value.length > 0)
        )
      ).sort();
    }
    const db = getAuditDb();
    const rows = db.prepare(`
      SELECT DISTINCT TRIM(ledger) AS ledger
      FROM ledger_entries
      WHERE COALESCE(is_master_ledger, 0) = 0
        AND TRIM(COALESCE(ledger, '')) <> ''
      ORDER BY ledger ASC
    `).all();
    return rows.map((row) => toSafeText(row?.ledger)).filter(Boolean);
  };

  const fetchLedgerVoucherPage = (params) => {
    const ledger = toSafeText(params?.ledger).trim();
    const selectedLower = ledger.toLowerCase();
    if (!ledger) {
      return {
        ledger: '',
        periodFrom: '',
        periodTo: '',
        hasOpening: false,
        hasClosing: false,
        openingAtRangeStart: 0,
        closingAtRangeEnd: 0,
        referenceClosingAtRangeEnd: null,
        reconciliationDiff: null,
        periodTotals: { dr: 0, cr: 0, net: 0 },
        periodRowsCount: 0,
        visibleRowsCount: 0,
        page: 1,
        pageSize: normalizePageSize(params?.pageSize),
        totalPages: 1,
        rows: [],
      };
    }

    const sourceRows = !sqliteAvailable
      ? memoryRows.slice()
      : getAuditDb().prepare(`
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
        `).all();

    const voucherMap = new Map();
    sourceRows.forEach((row) => {
      if (toSafeNumber(row?.is_master_ledger) > 0) return;
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
      const node = voucherMap.get(identity.groupKey);
      const candidateVoucher = identity.voucherNumber;
      if (
        isSyntheticUnknownVoucher(node.voucherNumber) &&
        candidateVoucher &&
        (!isSyntheticUnknownVoucher(candidateVoucher) || candidateVoucher.localeCompare(node.voucherNumber) < 0)
      ) {
        node.voucherNumber = candidateVoucher;
      }

      const entry = mapEntryLikeLedgerRow(row);
      node.entries.push(entry);
      if (!node.firstId || Number(row?.id || 0) < node.firstId) node.firstId = Number(row?.id || 0);
      if (toSafeText(row?.Ledger).trim().toLowerCase() === selectedLower) {
        node.ledgerAmount += toSafeNumber(row?.amount);
        if (!node.partyHint) node.partyHint = toSafeText(row?.party_name).trim();
        if (!node.narrationHint) node.narrationHint = toSafeText(row?.narration).trim();
      }
    });

    const groupedRows = Array.from(voucherMap.values())
      .filter((row) => Math.abs(toSafeNumber(row.ledgerAmount)) > 0.0000001)
      .sort((a, b) => {
        const d = parseDateTs(a.date) - parseDateTs(b.date);
        if (d !== 0) return d;
        const v = a.voucherNumber.localeCompare(b.voucherNumber);
        if (v !== 0) return v;
        return Number(a.firstId || 0) - Number(b.firstId || 0);
      });

    const ledgerBalanceRows = sourceRows
      .filter((row) => toSafeNumber(row?.is_master_ledger) === 0)
      .filter((row) => toSafeText(row?.Ledger).trim().toLowerCase() === selectedLower)
      .sort((a, b) => parseDateTs(toSafeText(a?.date)) - parseDateTs(toSafeText(b?.date)));

    let openingBalance = null;
    for (const row of ledgerBalanceRows) {
      const parsed = parseOptionalNumber(row?.opening_balance);
      if (parsed !== null) {
        openingBalance = parsed;
        break;
      }
    }
    let closingBalance = null;
    for (let i = ledgerBalanceRows.length - 1; i >= 0; i -= 1) {
      const parsed = parseOptionalNumber(ledgerBalanceRows[i]?.closing_balance);
      if (parsed !== null) {
        closingBalance = parsed;
        break;
      }
    }

    const rows = groupedRows.map((row) => {
      const ledgerAmount = toSafeNumber(row?.ledgerAmount);
      const ledgerDr = ledgerAmount < 0 ? Math.abs(ledgerAmount) : 0;
      const ledgerCr = ledgerAmount > 0 ? ledgerAmount : 0;
      return {
        key: toSafeText(row?.key),
        voucherNumber: toSafeText(row?.voucherNumber),
        date: toSafeText(row?.date),
        dateTs: parseDateTs(toSafeText(row?.date)),
        voucherType: toSafeText(row?.voucherType),
        partyHint: toSafeText(row?.partyHint),
        narrationHint: toSafeText(row?.narrationHint),
        ledgerAmount,
        ledgerDr,
        ledgerCr,
        entries: Array.isArray(row?.entries) ? row.entries : [],
      };
    });

    const periodFrom = rows[0]?.date || '';
    const periodTo = rows[rows.length - 1]?.date || '';
    const fromTsRaw = params?.fromDate ? parseDateTs(toSafeText(params.fromDate)) : Number.NEGATIVE_INFINITY;
    const toTsRaw = params?.toDate ? parseDateTs(toSafeText(params.toDate)) : Number.POSITIVE_INFINITY;
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

    const openingAtRangeStart = toSafeNumber(openingBalance || 0) + openingMovementBeforeRange;
    const closingAtRangeEnd = openingAtRangeStart + periodTotals.net;
    const referenceClosingAtRangeEnd =
      closingBalance === null ? null : toSafeNumber(closingBalance) - movementAfterRange;
    const reconciliationDiff =
      referenceClosingAtRangeEnd === null ? null : closingAtRangeEnd - referenceClosingAtRangeEnd;

    let running = openingAtRangeStart;
    const runningBalanceByKey = new Map();
    periodRows.forEach((row) => {
      running += row.ledgerAmount;
      runningBalanceByKey.set(row.key, running);
    });

    const q = toSafeText(params?.search).trim().toLowerCase();
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

    const safePageSize = normalizePageSize(params?.pageSize);
    const safePage = normalizePage(params?.page);
    const totalRows = visibleRows.length;
    const totalPages = totalRows > 0 ? Math.ceil(totalRows / safePageSize) : 1;
    const page = Math.min(safePage, totalPages);
    const start = (page - 1) * safePageSize;
    const pageRows = visibleRows.slice(start, start + safePageSize);

    const resultRows = pageRows.map((row) => {
      const bucketEntries = Array.isArray(row.entries) ? row.entries : [];
      const narration =
        row.narrationHint ||
        bucketEntries.map((entry) => toSafeText(entry.narration).trim()).find((v) => v.length > 0) ||
        '';
      return {
        ...row,
        party: row.partyHint || resolveVoucherParty(bucketEntries),
        narration,
        balance: runningBalanceByKey.get(row.key) ?? openingAtRangeStart,
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

  const clearAuditRows = () => {
    if (!sqliteAvailable) {
      memoryRows = [];
      loadedRows = 0;
      return;
    }
    const db = getAuditDb();
    db.exec('DELETE FROM ledger_entries;');
    loadedRows = 0;
  };

  const saveGstr2bImport = ({ parsed, sourceName }) => {
    const importId = newId('imp2b');
    const uploadedAt = new Date().toISOString();
    const metadata = parsed?.metadata || {};
    const counts = parsed?.counts || {};
    const totals = parsed?.totals || {};
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];

    const importRecord = {
      importId,
      sourceName: toSafeText(sourceName || metadata.sourceName || ''),
      uploadedAt,
      rtnprd: toSafeText(metadata.rtnprd || ''),
      entityGstin: toSafeText(metadata.entityGstin || ''),
      version: toSafeText(metadata.version || ''),
      generatedAt: toSafeText(metadata.generatedAt || ''),
      counts: {
        totalDocuments: Number(counts.totalDocuments || 0),
        b2bDocuments: Number(counts.b2bDocuments || 0),
        cdnrDocuments: Number(counts.cdnrDocuments || 0),
        b2baDocuments: Number(counts.b2baDocuments || 0),
      },
      totals,
    };

    if (!sqliteAvailable) {
      memoryGstr2bImports.unshift(importRecord);
      const preparedRows = rows.map((row) => ({ ...row, importId }));
      memoryGstr2bImportRows.push(...preparedRows);
      return importRecord;
    }

    const db = getAuditDb();
    // Single transaction wraps the import header insert plus all row inserts.
    // Better-sqlite3 rolls back automatically on throw inside the transaction fn.
    const persistImport = db.transaction(() => {
      db.prepare(`
        INSERT INTO gstr2b_imports (
          import_id, source_name, uploaded_at, rtnprd, entity_gstin, version, generated_at,
          count_total, count_b2b, count_cdnr, count_b2ba, totals_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        importId,
        importRecord.sourceName,
        importRecord.uploadedAt,
        importRecord.rtnprd,
        importRecord.entityGstin,
        importRecord.version,
        importRecord.generatedAt,
        importRecord.counts.totalDocuments,
        importRecord.counts.b2bDocuments,
        importRecord.counts.cdnrDocuments,
        importRecord.counts.b2baDocuments,
        toJsonText(importRecord.totals)
      );

      const stmt = db.prepare(`
        INSERT INTO gstr2b_import_rows (
          import_id, section, supplier_gstin, supplier_name, invoice_no, invoice_no_norm,
          invoice_date, taxable, igst, cgst, sgst, cess, total_tax, total_value,
          reverse_charge, type, itc_availability, pos, entity_gstin, branch, is_amended, is_isd, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of rows) {
        stmt.run(
          importId,
          toSafeText(row.section),
          toSafeText(row.supplierGstin),
          toSafeText(row.supplierName),
          toSafeText(row.invoiceNo),
          toSafeText(row.invoiceNoNorm),
          toSafeText(row.invoiceDate),
          toSafeNumber(row.taxable),
          toSafeNumber(row.igst),
          toSafeNumber(row.cgst),
          toSafeNumber(row.sgst),
          toSafeNumber(row.cess),
          toSafeNumber(row.totalTax),
          toSafeNumber(row.totalValue),
          row.reverseCharge ? 1 : 0,
          toSafeText(row.type),
          toSafeText(row.itcAvailability),
          toSafeText(row.pos),
          toSafeText(row.entityGstin),
          toSafeText(row.branch),
          row.isAmended ? 1 : 0,
          row.isISD ? 1 : 0,
          toJsonText(row.raw || {})
        );
      }
    });

    persistImport();
    return importRecord;
  };

  const listGstr2bImports = () => {
    if (!sqliteAvailable) return memoryGstr2bImports.slice();
    const db = getAuditDb();
    const rows = db.prepare(`
      SELECT
        import_id, source_name, uploaded_at, rtnprd, entity_gstin, version, generated_at,
        count_total, count_b2b, count_cdnr, count_b2ba, totals_json
      FROM gstr2b_imports
      ORDER BY uploaded_at DESC, import_id DESC
    `).all();
    return rows.map((row) => ({
      importId: toSafeText(row.import_id),
      sourceName: toSafeText(row.source_name),
      uploadedAt: toSafeText(row.uploaded_at),
      rtnprd: toSafeText(row.rtnprd),
      entityGstin: toSafeText(row.entity_gstin),
      version: toSafeText(row.version),
      generatedAt: toSafeText(row.generated_at),
      counts: {
        totalDocuments: Number(row.count_total || 0),
        b2bDocuments: Number(row.count_b2b || 0),
        cdnrDocuments: Number(row.count_cdnr || 0),
        b2baDocuments: Number(row.count_b2ba || 0),
      },
      totals: parseJsonText(row.totals_json, {}) || {},
    }));
  };

  const getGstr2bImportById = (importId) => listGstr2bImports().find((row) => row.importId === importId) || null;

  const getGstr2bImportRows = (importId) => {
    if (!sqliteAvailable) {
      return memoryGstr2bImportRows
        .filter((row) => toSafeText(row.importId) === toSafeText(importId))
        .map((row) => ({ ...row }));
    }
    const db = getAuditDb();
    const rows = db.prepare(`
      SELECT
        section, supplier_gstin, supplier_name, invoice_no, invoice_no_norm, invoice_date,
        taxable, igst, cgst, sgst, cess, total_tax, total_value, reverse_charge, type,
        itc_availability, pos, entity_gstin, branch, is_amended, is_isd
      FROM gstr2b_import_rows
      WHERE import_id = ?
    `).all(importId);

    return rows.map((row) => ({
      section: toSafeText(row.section),
      supplierGstin: toSafeText(row.supplier_gstin),
      supplierName: toSafeText(row.supplier_name),
      invoiceNo: toSafeText(row.invoice_no),
      invoiceNoNorm: toSafeText(row.invoice_no_norm),
      invoiceDate: toSafeText(row.invoice_date),
      taxable: toSafeNumber(row.taxable),
      igst: toSafeNumber(row.igst),
      cgst: toSafeNumber(row.cgst),
      sgst: toSafeNumber(row.sgst),
      cess: toSafeNumber(row.cess),
      totalTax: toSafeNumber(row.total_tax),
      totalValue: toSafeNumber(row.total_value),
      reverseCharge: toSafeNumber(row.reverse_charge) > 0,
      type: toSafeText(row.type),
      itcAvailability: toSafeText(row.itc_availability),
      pos: toSafeText(row.pos),
      entityGstin: toSafeText(row.entity_gstin),
      branch: toSafeText(row.branch),
      isAmended: toSafeNumber(row.is_amended) > 0,
      isISD: toSafeNumber(row.is_isd) > 0,
    }));
  };

  const clearGstr2bImports = (importIds = []) => {
    const normalizedImportIds = Array.isArray(importIds)
      ? Array.from(new Set(importIds.map((id) => toSafeText(id)).filter(Boolean)))
      : [];

    if (!sqliteAvailable) {
      const shouldClearAll = normalizedImportIds.length === 0;
      const idSet = new Set(normalizedImportIds);
      const prevImports = memoryGstr2bImports.length;
      const prevRows = memoryGstr2bImportRows.length;
      const prevRuns = memoryGstr2bRuns.length;

      if (shouldClearAll) {
        memoryGstr2bImports = [];
        memoryGstr2bImportRows = [];
        memoryGstr2bRuns = [];
        return {
          importsCleared: prevImports,
          rowsCleared: prevRows,
          runsCleared: prevRuns,
          clearedAll: true,
        };
      }

      memoryGstr2bImports = memoryGstr2bImports.filter((row) => !idSet.has(toSafeText(row.importId)));
      memoryGstr2bImportRows = memoryGstr2bImportRows.filter((row) => !idSet.has(toSafeText(row.importId)));
      memoryGstr2bRuns = memoryGstr2bRuns.filter((run) => {
        const runImports = Array.isArray(run.importIds)
          ? run.importIds.map((id) => toSafeText(id))
          : [toSafeText(run.importId)].filter(Boolean);
        return !runImports.some((id) => idSet.has(id));
      });

      return {
        importsCleared: prevImports - memoryGstr2bImports.length,
        rowsCleared: prevRows - memoryGstr2bImportRows.length,
        runsCleared: prevRuns - memoryGstr2bRuns.length,
        clearedAll: false,
      };
    }

    const db = getAuditDb();
    const countValue = (query, params = []) => Number(db.prepare(query).get(...params)?.cnt || 0);

    if (normalizedImportIds.length === 0) {
      const importsCleared = countValue('SELECT COUNT(*) AS cnt FROM gstr2b_imports');
      const rowsCleared = countValue('SELECT COUNT(*) AS cnt FROM gstr2b_import_rows');
      const runsCleared = countValue('SELECT COUNT(*) AS cnt FROM gstr2b_reco_runs');
      const clearAll = db.transaction(() => {
        db.exec('DELETE FROM gstr2b_import_rows;');
        db.exec('DELETE FROM gstr2b_imports;');
        db.exec('DELETE FROM gstr2b_reco_runs;');
      });
      clearAll();
      return { importsCleared, rowsCleared, runsCleared, clearedAll: true };
    }

    const placeholders = normalizedImportIds.map(() => '?').join(', ');
    const importsCleared = countValue(
      `SELECT COUNT(*) AS cnt FROM gstr2b_imports WHERE import_id IN (${placeholders})`,
      normalizedImportIds
    );
    const rowsCleared = countValue(
      `SELECT COUNT(*) AS cnt FROM gstr2b_import_rows WHERE import_id IN (${placeholders})`,
      normalizedImportIds
    );
    const runsCleared = countValue(
      `SELECT COUNT(*) AS cnt FROM gstr2b_reco_runs WHERE import_id IN (${placeholders})`,
      normalizedImportIds
    );

    const clearByIds = db.transaction(() => {
      db.prepare(`DELETE FROM gstr2b_import_rows WHERE import_id IN (${placeholders})`).run(...normalizedImportIds);
      db.prepare(`DELETE FROM gstr2b_imports WHERE import_id IN (${placeholders})`).run(...normalizedImportIds);
      db.prepare(`DELETE FROM gstr2b_reco_runs WHERE import_id IN (${placeholders})`).run(...normalizedImportIds);
    });
    clearByIds();

    return { importsCleared, rowsCleared, runsCleared, clearedAll: false };
  };

  const saveGstr2bRun = ({ importId, importIds, scope, config, result }) => {
    const runId = newId('run2b');
    const createdAt = new Date().toISOString();
    const normalizedImportIds = Array.isArray(importIds)
      ? importIds.map((id) => toSafeText(id)).filter(Boolean)
      : [toSafeText(importId)].filter(Boolean);
    const primaryImportId = normalizedImportIds[0] || '';
    const scopeMonths = Array.isArray(scope?.months)
      ? scope.months.map((m) => toSafeText(m || '')).filter(Boolean)
      : [toSafeText(scope?.month || 'All')].filter(Boolean);
    const dedupScopeMonths = Array.from(new Set(scopeMonths.length ? scopeMonths : ['All']));
    const scopeMonth = dedupScopeMonths.includes('All') ? 'All' : dedupScopeMonths.join(',');
    const scopeEntityGstin = toSafeText(scope?.entityGstin || '');
    const scopeBranch = toSafeText(scope?.branch || '');
    const payload = {
      runId,
      importId: primaryImportId,
      importIds: normalizedImportIds,
      createdAt,
      scope: { month: scopeMonth, months: dedupScopeMonths, entityGstin: scopeEntityGstin, branch: scopeBranch },
      config: config || {},
      result: result || {},
      summary: result?.summary || {},
      counts: result?.counts || {},
    };

    if (!sqliteAvailable) {
      memoryGstr2bRuns.unshift(payload);
      return payload;
    }

    const db = getAuditDb();
    db.prepare(`
      INSERT INTO gstr2b_reco_runs (
        run_id, import_id, created_at, scope_month, scope_entity_gstin, scope_branch, config_json, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      primaryImportId,
      createdAt,
      scopeMonth,
      scopeEntityGstin,
      scopeBranch,
      toJsonText(config || {}),
      toJsonText(result || {})
    );

    return payload;
  };

  const listGstr2bRuns = () => {
    if (!sqliteAvailable) {
      return memoryGstr2bRuns.map((run) => ({
        runId: run.runId,
        importId: run.importId,
        importIds: Array.isArray(run.importIds) ? run.importIds : [run.importId].filter(Boolean),
        createdAt: run.createdAt,
        scope: run.scope,
        counts: run.counts || {},
        summary: run.summary || {},
      }));
    }

    const db = getAuditDb();
    const rows = db.prepare(`
      SELECT
        run_id, import_id, created_at, scope_month, scope_entity_gstin, scope_branch, result_json
      FROM gstr2b_reco_runs
      ORDER BY created_at DESC, run_id DESC
    `).all();

    return rows.map((row) => {
      const result = parseJsonText(row.result_json, {}) || {};
      return {
        runId: toSafeText(row.run_id),
        importId: toSafeText(row.import_id),
        importIds: Array.isArray(result?.importIds)
          ? result.importIds
          : [toSafeText(row.import_id)].filter(Boolean),
        createdAt: toSafeText(row.created_at),
        scope: {
          month: toSafeText(row.scope_month || 'All'),
          months: Array.isArray(result?.scope?.months)
            ? result.scope.months
            : [toSafeText(row.scope_month || 'All')],
          entityGstin: toSafeText(row.scope_entity_gstin),
          branch: toSafeText(row.scope_branch),
        },
        counts: result?.counts || {},
        summary: result?.summary || {},
      };
    });
  };

  const getGstr2bRun = (runId) => {
    if (!sqliteAvailable) return memoryGstr2bRuns.find((run) => run.runId === runId) || null;
    const db = getAuditDb();
    const row = db.prepare(`
      SELECT
        run_id, import_id, created_at, scope_month, scope_entity_gstin, scope_branch, config_json, result_json
      FROM gstr2b_reco_runs
      WHERE run_id = ?
    `).get(runId);
    if (!row) return null;
    const parsedResult = parseJsonText(row.result_json, {}) || {};
    return {
      runId: toSafeText(row.run_id),
      importId: toSafeText(row.import_id),
      importIds: Array.isArray(parsedResult?.importIds)
        ? parsedResult.importIds
        : [toSafeText(row.import_id)].filter(Boolean),
      createdAt: toSafeText(row.created_at),
      scope: {
        month: toSafeText(row.scope_month || 'All'),
        months: Array.isArray(parsedResult?.scope?.months)
          ? parsedResult.scope.months
          : [toSafeText(row.scope_month || 'All')],
        entityGstin: toSafeText(row.scope_entity_gstin),
        branch: toSafeText(row.scope_branch),
      },
      config: parseJsonText(row.config_json, {}) || {},
      result: parsedResult,
    };
  };

  const exportAuditSourceBuffer = () => {
    if (!sqliteAvailable) {
      throw new Error('Tally Source File export requires SQLite runtime.');
    }
    const rows = fetchAuditRows();
    if (rows.length === 0) throw new Error('No dataset loaded. Import data before exporting source file.');

    ensureTempDataDir();
    const filePath = path.join(tempDataDir, `export-${Date.now()}.sqlite`);
    const db = new Database(filePath);
    applyAuditPragmas(db);
    initializeAuditSchema(db);
    const runExport = db.transaction(() => {
      insertAuditRows(db, rows);
      buildReferenceCollectionsForExport(db);
    });
    try {
      runExport();
    } finally {
      db.close?.();
    }
    const buffer = fs.readFileSync(filePath);
    fs.unlinkSync(filePath);
    return buffer;
  };

  const importAuditSourceBuffer = (buffer) => {
    if (!sqliteAvailable) {
      throw new Error('Tally Source File import requires SQLite runtime.');
    }
    const rows = readNormalizedAuditSourceRowsBuffer(buffer);
    return loadAuditRows(rows);
  };

  const readNormalizedAuditSourceRowsBuffer = (buffer) => {
    if (!sqliteAvailable) {
      throw new Error('Tally source parsing requires SQLite runtime.');
    }
    ensureTempDataDir();
    const filePath = path.join(tempDataDir, `parse-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    fs.writeFileSync(filePath, buffer);

    let srcDb = null;
    try {
      // User-provided TSF file: open read-only.
      srcDb = new Database(filePath, { readonly: true });
      const exists = srcDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_entries'").get();
      if (!exists?.name) throw new Error('Invalid Tally source file: ledger_entries table not found.');
      const col = srcDb.prepare("SELECT name FROM pragma_table_info('ledger_entries') WHERE name = 'is_master_ledger'").get();
      const hasMaster = !!col?.name;
      return srcDb.prepare(`
        SELECT
          guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
          party_name, gstin, ledger AS Ledger, amount, group_name AS "Group",
          opening_balance, closing_balance, tally_parent AS TallyParent, tally_primary AS TallyPrimary,
          is_revenue, is_accounting_voucher,
          ${hasMaster ? 'is_master_ledger' : '0 AS is_master_ledger'}
        FROM ledger_entries
      `).all();
    } finally {
      srcDb?.close?.();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  };

  const readAuditSourceRowsBuffer = (buffer) => {
    if (!sqliteAvailable) {
      throw new Error('Tally source conversion requires SQLite runtime.');
    }
    ensureTempDataDir();
    const filePath = path.join(tempDataDir, `convert-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    fs.writeFileSync(filePath, buffer);

    let srcDb = null;
    try {
      srcDb = new Database(filePath, { readonly: true });
      const exists = srcDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_entries'").get();
      if (!exists?.name) throw new Error('Invalid Tally source file: ledger_entries table not found.');

      const cols = srcDb.prepare("SELECT name FROM pragma_table_info('ledger_entries') ORDER BY cid ASC").all();
      const columns = cols.map((c) => String(c?.name || '')).filter(Boolean);
      if (columns.length === 0) throw new Error('Invalid Tally source file: ledger_entries has no columns.');

      const selectColumns = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
      const rows = srcDb.prepare(`SELECT ${selectColumns} FROM ledger_entries`).all();
      return { columns, rows };
    } finally {
      srcDb?.close?.();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  };

  const convertAuditSourceBufferToExcel = (buffer) => {
    const payload = readAuditSourceRowsBuffer(buffer);
    const worksheet = XLSX.utils.json_to_sheet(payload.rows, { header: payload.columns });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'TSF Raw Data');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  };

  const compareAuditSourcesByGuid = (newSourceBuffer) => {
    const currentRows = fetchAuditRows();
    if (!Array.isArray(currentRows) || currentRows.length === 0) {
      throw new Error('No dataset loaded. Import a base TSF file first.');
    }

    const newRows = readNormalizedAuditSourceRowsBuffer(newSourceBuffer);
    const createComparableRow = (row) => ({
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

    const buildIndex = (rows) => {
      const grouped = new Map();
      const duplicates = [];
      const uniqueByGuid = new Map();
      const blankGuidRows = [];
      const allComparableRows = [];
      const voucherTotals = new Map();
      const ledgerTotals = new Map();
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
        grouped.get(row.guid).push(row);
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

    const formatForOutput = (row) => ({
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

    const addedRows = [];
    const removedRows = [];
    const modifiedRows = [];
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

      const differences = [];
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

    const toVoucherImpactRows = (currentTotals, newTotals) => {
      const keys = new Set([...Array.from(currentTotals.keys()), ...Array.from(newTotals.keys())]);
      return Array.from(keys).map((voucherKey) => {
        const currentAmount = toSafeNumber(currentTotals.get(voucherKey) || 0);
        const newAmount = toSafeNumber(newTotals.get(voucherKey) || 0);
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
      }).filter((row) => row.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    };

    const toLedgerImpactRows = (currentTotals, newTotals) => {
      const keys = new Set([...Array.from(currentTotals.keys()), ...Array.from(newTotals.keys())]);
      return Array.from(keys).map((ledger) => {
        const currentAmount = toSafeNumber(currentTotals.get(ledger) || 0);
        const newAmount = toSafeNumber(newTotals.get(ledger) || 0);
        const delta = newAmount - currentAmount;
        return {
          ledger,
          currentAmount,
          newAmount,
          delta,
        };
      }).filter((row) => row.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
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

  const ensureAbsolutePath = (inputPath) => {
    const t = String(inputPath || '').trim();
    if (!t) return '';
    if (path.isAbsolute(t)) return path.normalize(t);
    return path.resolve(appRoot, t);
  };

  const isValidLoaderRoot = (root) => {
    if (!root || !fs.existsSync(root)) return false;
    return fs.existsSync(path.join(root, 'dist', 'index.mjs')) && fs.existsSync(path.join(root, 'config.json'));
  };

  const DEFAULT_LOADER_ROOT_CANDIDATES = [
    path.resolve(appRoot, 'tally-database-loader-main (1)', 'tally-database-loader-main'),
    path.resolve(appRoot, 'tally-database-loader-main'),
    path.resolve(resourcesRoot, 'tally-database-loader-main (1)', 'tally-database-loader-main'),
    path.resolve(resourcesRoot, 'tally-database-loader-main'),
  ];

  const resolveLoaderRoot = (requestedPath) => {
    const reqPath = ensureAbsolutePath(requestedPath || '');
    if (reqPath) {
      if (isValidLoaderRoot(reqPath)) {
        preferredLoaderRoot = reqPath;
        lastResolvedLoaderRoot = reqPath;
        return reqPath;
      }
      throw new Error(`Configured loader path is invalid: ${reqPath}`);
    }
    if (preferredLoaderRoot && isValidLoaderRoot(preferredLoaderRoot)) {
      lastResolvedLoaderRoot = preferredLoaderRoot;
      return preferredLoaderRoot;
    }
    for (const p of DEFAULT_LOADER_ROOT_CANDIDATES) {
      if (isValidLoaderRoot(p)) {
        preferredLoaderRoot = p;
        lastResolvedLoaderRoot = p;
        return p;
      }
    }
    throw new Error('Tally loader utility not found. Keep bundled loader folder with the app.');
  };

  const getLoaderSourceStamp = (root) => {
    const distStat = fs.statSync(path.join(root, 'dist', 'index.mjs'));
    const configStat = fs.statSync(path.join(root, 'config.json'));
    return `${distStat.size}:${Math.floor(distStat.mtimeMs)}:${configStat.size}:${Math.floor(configStat.mtimeMs)}`;
  };

  const isDirectoryWritable = (dirPath) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const probeDir = path.join(dirPath, `.write-probe-${process.pid}-${Date.now()}`);
      fs.mkdirSync(probeDir, { recursive: false });
      fs.rmdirSync(probeDir);
      return true;
    } catch {
      return false;
    }
  };

  const ensureWritableLoaderRoot = (sourceRoot) => {
    if (isDirectoryWritable(sourceRoot)) return sourceRoot;

    ensureTempDataDir();
    const runtimeRoot = path.join(tempDataDir, 'loader-runtime');
    const stampFile = path.join(runtimeRoot, '.loader-source-stamp');
    const sourceStamp = getLoaderSourceStamp(sourceRoot);
    const existingStamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8') : '';
    const shouldRefresh = !isValidLoaderRoot(runtimeRoot) || existingStamp !== sourceStamp;

    if (shouldRefresh) {
      appendLoaderLog(`Preparing writable loader workspace at: ${runtimeRoot}`);
      if (fs.existsSync(runtimeRoot)) fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.mkdirSync(runtimeRoot, { recursive: true });

      fs.cpSync(sourceRoot, runtimeRoot, {
        recursive: true,
        force: true,
        filter: (src) => {
          const relative = path.relative(sourceRoot, src);
          if (!relative) return true;
          const normalized = relative.split(path.sep).join('/').toLowerCase();
          if (normalized.startsWith('csv/')) return false;
          if (normalized.startsWith('.git/')) return false;
          if (normalized.startsWith('.github/')) return false;
          return true;
        },
      });
      fs.writeFileSync(stampFile, sourceStamp, 'utf8');
    }

    return runtimeRoot;
  };

  const ensureLoaderDependencies = async (loaderRoot) => {
    const nm = path.join(loaderRoot, 'node_modules');
    if (fs.existsSync(nm)) return;
    appendLoaderLog('Installing loader utility dependencies (npm install)...');
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const args = process.platform === 'win32' ? ['/c', 'npm install'] : ['install'];
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: loaderRoot, windowsHide: true });
      let stderr = '';
      child.stdout.on('data', (d) => appendLoaderLog(d.toString('utf8')));
      child.stderr.on('data', (d) => {
        const t = d.toString('utf8');
        stderr += t;
        appendLoaderLog(t);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`Failed to install loader dependencies. ${stderr}`));
        else resolve();
      });
    });
  };

  const getPreferredOutputFile = (tableName, files) => {
    const jsonFile = `${tableName}.json`;
    const csvFile = `${tableName}.csv`;
    const lowered = files.map((f) => f.toLowerCase());
    const iJson = lowered.indexOf(jsonFile);
    if (iJson >= 0) return files[iJson];
    const iCsv = lowered.indexOf(csvFile);
    if (iCsv >= 0) return files[iCsv];
    return null;
  };

  const clearLoaderOutputDir = (loaderRoot) => {
    const outputDir = path.join(loaderRoot, 'csv');
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });
  };

  const collectLoaderOutputTables = (loaderRoot, stdout, stderr, startedAt) => {
    const outputDir = path.join(loaderRoot, 'csv');
    if (!fs.existsSync(outputDir)) {
      const combined = `${stdout}\n${stderr}`.toLowerCase();
      if (combined.includes('unable to connect with tally')) {
        throw new Error('Loader could not connect to Tally XML server. Open Tally and enable XML port 9000.');
      }
      throw new Error(`Loader output folder not found at ${outputDir}`);
    }
    const files = fs.readdirSync(outputDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    const tables = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
    const payload = {};
    tables.forEach((table) => {
      const file = getPreferredOutputFile(table, files);
      if (!file) return;
      const full = path.join(outputDir, file);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < startedAt - 2000) return;
      payload[table] = { filename: file, content: fs.readFileSync(full, 'utf8') };
    });
    const missing = REQUIRED_TABLES.filter((t) => !payload[t]);
    if (missing.length > 0) throw new Error(`Loader finished, but output missing: ${missing.join(', ')}`);
    return payload;
  };

  const summarizeLoaderOutput = (tables) => {
    const voucherTable = tables?.trn_voucher;
    const accountingTable = tables?.trn_accounting;
    const parseRows = (txt) => {
      try {
        const parsed = JSON.parse(String(txt || '').replace(/^\uFEFF/, ''));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const vouchers = voucherTable ? parseRows(voucherTable.content) : [];
    const accounting = accountingTable ? parseRows(accountingTable.content) : [];
    const dates = vouchers.map((r) => String(r?.date || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    return {
      voucherRows: vouchers.length,
      accountingRows: accounting.length,
      minDate: dates[0] || '',
      maxDate: dates[dates.length - 1] || '',
    };
  };

  const normalizeDateLikeIso = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const head = raw.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
    if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return '';
  };

  const applyDateRangeFilterOnLoaderTables = (tables, fromDateIso, toDateIso) => {
    if (!fromDateIso || !toDateIso) return tables;
    const voucherTable = tables?.trn_voucher;
    const accountingTable = tables?.trn_accounting;
    if (!voucherTable || !accountingTable) return tables;

    const parseRows = (txt) => {
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

  const runLoaderWithOverrides = async (body) => {
    const sourceLoaderRoot = resolveLoaderRoot(body?.loaderRoot);
    const loaderRoot = ensureWritableLoaderRoot(sourceLoaderRoot);
    lastResolvedLoaderRoot = loaderRoot;
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
    if (loaderRoot !== sourceLoaderRoot) {
      appendLoaderLog(`Bundled loader path is read-only. Using writable runtime copy.`);
    }
    appendLoaderLog(fromDate && toDate ? `Requested period: ${fromDate} to ${toDate}` : 'Requested period: loader config/default (auto)');
    appendLoaderLog(`Starting loader: node ${args.join(' ')}`);

    const started = Date.now();
    loaderProcessRunning = true;
    lastLoaderError = '';
    lastRunAt = new Date().toISOString();

    const runner = spawn(process.execPath, args, { cwd: loaderRoot, windowsHide: true });
    loaderProcessRef = runner;
    let stdout = '';
    let stderr = '';

    await new Promise((resolve, reject) => {
      runner.stdout.on('data', (chunk) => {
        const t = chunk.toString('utf8');
        stdout += t;
        appendLoaderLog(t);
      });
      runner.stderr.on('data', (chunk) => {
        const t = chunk.toString('utf8');
        stderr += t;
        appendLoaderLog(t);
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
    appendLoaderLog(`Output summary: vouchers=${outputSummary.voucherRows}, accounting=${outputSummary.accountingRows}, range=${outputSummary.minDate || 'n/a'} to ${outputSummary.maxDate || 'n/a'}`);
    appendLoaderLog('Loader completed successfully and output tables collected.');

    return {
      durationMs: Date.now() - started,
      tables,
      requestedFromDate: fromDate,
      requestedToDate: toDate,
      outputSummary,
    };
  };

  const readJsonBody = (req, maxBytes = 1024 * 1024) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString('utf8');
        if (raw.length > maxBytes) reject(new Error('Request body too large.'));
      });
      req.on('end', () => {
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Invalid JSON body.'));
        }
      });
      req.on('error', reject);
    });

  const readRawBody = (req, maxBytes = 300 * 1024 * 1024) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
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

  const distDirCandidates = [
    path.resolve(appRoot, 'dist'),
    path.resolve(resourcesRoot, 'dist'),
    path.resolve(process.cwd(), 'dist'),
  ];
  const distDir = distDirCandidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (!distDir) {
    throw new Error('Could not locate dist/index.html for desktop backend.');
  }

  const serveStatic = (pathname, res) => {
    let relative = decodeURIComponent(pathname || '/');
    if (relative === '/') relative = '/index.html';
    const directPath = path.normalize(path.join(distDir, relative));
    const safeDirect = directPath.startsWith(path.normalize(distDir));
    let filePath = safeDirect ? directPath : path.join(distDir, 'index.html');
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeByExt[ext] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.end(fs.readFileSync(filePath));
  };

  const handleApi = async (req, res, pathname) => {
    if (req.method === 'GET' && pathname === '/api/data/health') {
      sendJson(res, 200, { ok: true, sqlite: sqliteAvailable, loadedRows });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/data/load') {
      const body = await readJsonBody(req, 250 * 1024 * 1024);
      const rows = Array.isArray(body?.rows) ? body.rows : [];
      const result = loadAuditRows(rows);
      sendJson(res, 200, { ok: true, insertedRows: result.insertedRows, summary: result.summary });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/data/rows') {
      // Bare /api/data/rows preserves the legacy "give me everything"
      // behaviour for the in-memory fallback path. With any query string,
      // we run the indexed paginated query.
      const queryStart = (req.url || '').indexOf('?');
      const sp = queryStart >= 0
        ? new URLSearchParams((req.url || '').slice(queryStart + 1))
        : new URLSearchParams();
      if (sp.toString().length === 0) {
        sendJson(res, 200, { ok: true, rows: fetchAuditRows() });
        return true;
      }
      const csv = (key) =>
        sp.getAll(key).flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
      const page = fetchAuditRowsPage({
        from: sp.get('from') || '',
        to: sp.get('to') || '',
        voucherTypes: csv('voucherType'),
        ledgers: csv('ledger'),
        parties: csv('party'),
        gstin: sp.get('gstin') || '',
        search: sp.get('search') || '',
        limit: Number(sp.get('limit') || 0),
        offset: Number(sp.get('offset') || 0),
      });
      sendJson(res, 200, {
        ok: true,
        rows: page.rows,
        total: page.total,
        limit: Number(sp.get('limit') || 0),
        offset: Number(sp.get('offset') || 0),
      });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/analytics/months') {
      sendJson(res, 200, { ok: true, months: getAvailableMonthKeys() });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/analytics/pnl') {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const analytics = fetchPnlAnalytics(body?.months);
      sendJson(res, 200, { ok: true, ...analytics });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/analytics/module-rows') {
      const body = await readJsonBody(req, 16 * 1024 * 1024);
      const moduleType = String(body?.module || '').trim().toLowerCase();
      if (moduleType !== 'sales' && moduleType !== 'purchase') {
        sendJson(res, 400, { ok: false, error: 'Invalid module. Use "sales" or "purchase".' });
        return true;
      }
      const rows = fetchModuleScopedRows(
        moduleType,
        body?.months,
        body?.selectedLedgers,
        body?.selectedRcmLedgers
      );
      sendJson(res, 200, { ok: true, rows });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/analytics/ledgers') {
      sendJson(res, 200, { ok: true, ledgers: getLedgerList() });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/analytics/voucher-book/page') {
      const body = await readJsonBody(req, 8 * 1024 * 1024);
      const payload = fetchVoucherBookPage(
        toSafeText(body?.search || ''),
        Number(body?.page || 1),
        Number(body?.pageSize || 50)
      );
      sendJson(res, 200, { ok: true, ...payload });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/analytics/ledger-voucher/page') {
      const body = await readJsonBody(req, 8 * 1024 * 1024);
      const payload = fetchLedgerVoucherPage({
        ledger: toSafeText(body?.ledger || ''),
        fromDate: toSafeText(body?.fromDate || ''),
        toDate: toSafeText(body?.toDate || ''),
        search: toSafeText(body?.search || ''),
        page: Number(body?.page || 1),
        pageSize: Number(body?.pageSize || 50),
      });
      sendJson(res, 200, { ok: true, ...payload });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/data/summary') {
      sendJson(res, 200, { ok: true, summary: getAuditSummary() });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/data/clear') {
      clearAuditRows();
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/data/tds-query') {
      const body = await readJsonBody(req, 1 * 1024 * 1024);
      const rawLedgers = Array.isArray(body?.tdsLedgers) ? body.tdsLedgers : [];
      const tdsLedgers = rawLedgers.map(toSafeText).filter(Boolean);
      const minVoucherAmount = toSafeNumber(body?.minVoucherAmount);

      if (tdsLedgers.length === 0) {
        sendJson(res, 200, { ok: true, rows: [] });
        return true;
      }

      if (!sqliteAvailable || !getAuditDb()) {
        // Fallback: return empty so frontend falls back to in-memory path
        sendJson(res, 200, { ok: true, rows: [] });
        return true;
      }

      try {
        const db = getAuditDb();
        const placeholders = tdsLedgers.map(() => '?').join(', ');

        // Build the focused TDS query:
        // 1. voucher_tds – total TDS per voucher from selected TDS ledgers
        // 2. voucher_party – party_name + narration per voucher
        // 3. expense_entries – one row per (voucher × expense_ledger)
        // Join 3 with 1 and 2 to produce compact rows for the frontend.
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
            COALESCE(vp.party_name, '')    AS party_name,
            COALESCE(vp.narration, '')     AS narration,
            COALESCE(vt.total_tds, 0)     AS total_tds,
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

        // Parameters: tdsLedgers × 2 (for voucher_tds CTE placeholders) + minVoucherAmount
        const rows = db.prepare(sql).all(...tdsLedgers, ...tdsLedgers, minVoucherAmount);
        sendJson(res, 200, { ok: true, rows });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: toSafeText(err?.message) });
      }
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/data/import-source') {
      const raw = await readRawBody(req, 300 * 1024 * 1024);
      const result = importAuditSourceBuffer(raw);
      sendJson(res, 200, { ok: true, insertedRows: result.insertedRows, summary: result.summary });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/data/compare-source') {
      const raw = await readRawBody(req, 300 * 1024 * 1024);
      const result = compareAuditSourcesByGuid(raw);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/data/export-source') {
      const buffer = exportAuditSourceBuffer();
      const stamp = new Date().toISOString().slice(0, 10);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="Tally_Source_File_${stamp}.tsf"`);
      res.end(buffer);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/data/source-to-excel') {
      const raw = await readRawBody(req, 300 * 1024 * 1024);
      const excel = convertAuditSourceBufferToExcel(raw);
      const stamp = new Date().toISOString().slice(0, 10);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Tally_Source_Raw_${stamp}.xlsx"`);
      res.end(excel);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/gstr2b/import') {
      const body = await readJsonBody(req, 80 * 1024 * 1024);
      const sourceName = toSafeText(body?.sourceName || 'gstr2b.json');
      const candidatePayload = typeof body?.jsonText === 'string' && body.jsonText.trim()
        ? body.jsonText
        : body?.payload || body?.json || body;
      const parsed = parse2BJson(candidatePayload, { sourceName });
      const importRecord = saveGstr2bImport({ parsed, sourceName });
      sendJson(res, 200, { ok: true, import: importRecord });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/gstr2b/imports') {
      sendJson(res, 200, { ok: true, imports: listGstr2bImports() });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/gstr2b/imports/clear') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const importIds = Array.isArray(body?.importIds)
        ? body.importIds.map((x) => toSafeText(x)).filter(Boolean)
        : [];
      const clearResult = clearGstr2bImports(importIds);
      sendJson(res, 200, { ok: true, ...clearResult });
      return true;
    }
    const gstr2bImportMatch = pathname.match(/^\/api\/gstr2b\/imports\/([^/]+)$/);
    if (req.method === 'GET' && gstr2bImportMatch) {
      const importId = decodeURIComponent(gstr2bImportMatch[1]);
      const importRecord = getGstr2bImportById(importId);
      if (!importRecord) {
        sendJson(res, 404, { ok: false, error: 'Import not found.' });
        return true;
      }
      sendJson(res, 200, { ok: true, import: importRecord, rows: getGstr2bImportRows(importId) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/gstr2b/reconcile') {
      const body = await readJsonBody(req, 300 * 1024 * 1024);
      const importIds = Array.isArray(body?.importIds)
        ? body.importIds.map((x) => toSafeText(x)).filter(Boolean)
        : [toSafeText(body?.importId)].filter(Boolean);

      if (!importIds.length) {
        sendJson(res, 400, { ok: false, error: 'At least one importId is required.' });
        return true;
      }

      const importRecords = importIds
        .map((id) => ({ id, record: getGstr2bImportById(id) }))
        .filter((item) => !!item.record);

      if (importRecords.length !== importIds.length) {
        sendJson(res, 404, { ok: false, error: 'One or more selected GSTR-2B imports were not found.' });
        return true;
      }

      const importRows = importRecords.flatMap(({ id, record }) =>
        getGstr2bImportRows(id).map((row) => ({
          ...row,
          sourceImportId: id,
          sourceRtnprd: toSafeText(record?.rtnprd || ''),
          sourceImportName: toSafeText(record?.sourceName || ''),
        }))
      );

      if (!importRows.length) {
        sendJson(res, 400, { ok: false, error: 'No parsed GSTR-2B invoices found for selected imports.' });
        return true;
      }

      const booksRows = Array.isArray(body?.booksRows) && body.booksRows.length > 0 ? body.booksRows : fetchAuditRows();
      const scopeMonths = Array.isArray(body?.scope?.months)
        ? body.scope.months.map((m) => toSafeText(m)).filter(Boolean)
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
        selectedGstLedgers: Array.isArray(body?.selectedGstLedgers) ? body.selectedGstLedgers : [],
        selectedRcmLedgers: Array.isArray(body?.selectedRcmLedgers) ? body.selectedRcmLedgers : [],
        requireNonZeroTax: true,
        nonZeroTaxMin: 0.005,
      });

      const result = reconcile(normalizedBooks, importRows, { scope, ...config });
      const enrichedResult = {
        ...result,
        importId: importIds[0] || '',
        importIds,
        importMeta: importRecords.map((x) => x.record),
        generatedAt: new Date().toISOString(),
      };

      const run = saveGstr2bRun({
        importId: importIds[0] || '',
        importIds,
        scope,
        config,
        result: enrichedResult,
      });

      sendJson(res, 200, {
        ok: true,
        runId: run.runId,
        createdAt: run.createdAt,
        result: enrichedResult,
      });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/gstr2b/runs') {
      sendJson(res, 200, { ok: true, runs: listGstr2bRuns() });
      return true;
    }
    const runDetailMatch = pathname.match(/^\/api\/gstr2b\/runs\/([^/]+)$/);
    if (req.method === 'GET' && runDetailMatch) {
      const runId = decodeURIComponent(runDetailMatch[1]);
      const run = getGstr2bRun(runId);
      if (!run) {
        sendJson(res, 404, { ok: false, error: 'Reconciliation run not found.' });
        return true;
      }
      sendJson(res, 200, { ok: true, run });
      return true;
    }
    const runXlsxMatch = pathname.match(/^\/api\/gstr2b\/runs\/([^/]+)\/export-xlsx$/);
    if (req.method === 'GET' && runXlsxMatch) {
      const runId = decodeURIComponent(runXlsxMatch[1]);
      const run = getGstr2bRun(runId);
      if (!run) {
        sendJson(res, 404, { ok: false, error: 'Reconciliation run not found.' });
        return true;
      }
      const buffer = exportXlsx(run.result || {});
      const stamp = new Date().toISOString().slice(0, 10);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="GSTR2B_Reconciliation_${stamp}.xlsx"`);
      res.end(buffer);
      return true;
    }
    const runJsonMatch = pathname.match(/^\/api\/gstr2b\/runs\/([^/]+)\/export-json$/);
    if (req.method === 'GET' && runJsonMatch) {
      const runId = decodeURIComponent(runJsonMatch[1]);
      const run = getGstr2bRun(runId);
      if (!run) {
        sendJson(res, 404, { ok: false, error: 'Reconciliation run not found.' });
        return true;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="GSTR2B_Reconciliation_${stamp}.json"`);
      res.end(JSON.stringify(run.result || {}, null, 2));
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/loader/check') {
      let available = false;
      try { resolveLoaderRoot(); available = true; } catch { available = false; }
      sendJson(res, 200, { available });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/loader/status') {
      sendJson(res, 200, {
        running: loaderProcessRunning,
        lastRunAt,
        lastError: lastLoaderError,
        logs: loaderLogs.slice(-100),
        loaderRoot: lastResolvedLoaderRoot || preferredLoaderRoot,
      });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/loader/abort') {
      if (loaderProcessRef && loaderProcessRunning) {
        loaderProcessRef.kill();
        loaderProcessRef = null;
        loaderProcessRunning = false;
        appendLoaderLog('Loader process aborted via API.');
        sendJson(res, 200, { ok: true, aborted: true });
      } else {
        sendJson(res, 200, { ok: true, aborted: false });
      }
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/loader/run-and-export') {
      if (loaderProcessRunning) {
        sendJson(res, 409, { ok: false, error: 'Loader sync is already running.' });
        return true;
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
      return true;
    }
    return false;
  };

  const tryListen = (port) =>
    new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const parsed = new URL(req.url || '/', `http://127.0.0.1:${port}`);
          const pathname = parsed.pathname;
          if (pathname.startsWith('/api/')) {
            const handled = await handleApi(req, res, pathname);
            if (!handled) sendJson(res, 404, { ok: false, error: 'API route not found.' });
            return;
          }
          serveStatic(pathname, res);
        } catch (error) {
          const message = error?.message || 'Unexpected backend error.';
          if ((req.url || '').startsWith('/api/loader/')) {
            loaderProcessRef = null;
            loaderProcessRunning = false;
            appendLoaderLog(`API error: ${message}`);
          }
          sendJson(res, 500, { ok: false, error: message });
        }
      });
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
    });

  let activeServer = null;
  let finalPort = preferredPort;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const p = preferredPort + attempt;
    try {
      activeServer = await tryListen(p);
      finalPort = p;
      break;
    } catch (err) {
      if (attempt === 9) throw err;
    }
  }

  return {
    port: finalPort,
    stop: () =>
      new Promise((resolve) => {
        if (loaderProcessRef && loaderProcessRunning) {
          loaderProcessRef.kill();
          loaderProcessRef = null;
          loaderProcessRunning = false;
        }
        if (!activeServer) {
          resolve();
          return;
        }
        activeServer.close(() => resolve());
      }),
  };
};

module.exports = { createBackendServer };

const parseArgValue = (args, key) => {
  const index = args.indexOf(key);
  if (index < 0) return '';
  return String(args[index + 1] || '').trim();
};

const hasFlag = (args, key) => args.includes(key);

if (require.main === module) {
  const args = process.argv.slice(2);
  const standalone = hasFlag(args, '--standalone');
  if (standalone) {
    const appRoot = parseArgValue(args, '--app-root') || process.cwd();
    const resourcesRoot = parseArgValue(args, '--resources-root') || appRoot;
    const tempDir = parseArgValue(args, '--temp-dir') || appRoot;
    const portRaw = parseArgValue(args, '--port');
    const preferredPort = Number(portRaw || 5173);

    createBackendServer({
      appRoot,
      resourcesRoot,
      tempDir,
      port: Number.isFinite(preferredPort) ? preferredPort : 5173,
    })
      .then((server) => {
        process.stdout.write(`BACKEND_PORT=${server.port}\n`);
        const shutdown = async () => {
          try {
            await server.stop();
          } catch {
            // best effort
          } finally {
            process.exit(0);
          }
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      })
      .catch((error) => {
        process.stderr.write(`BACKEND_START_ERROR=${error?.message || String(error)}\n`);
        process.exit(1);
      });
  }
}
