/**
 * Shared SQLite helpers for the audit database.
 *
 * Owns:
 *   - DB file path resolution (cross-platform, env-overridable)
 *   - PRAGMA tuning applied on every open
 *   - Canonical schema (ledger_entries + imports + gstr2b_*)
 *   - Index definitions
 *   - Hash util used to skip re-ingest when source data is unchanged
 *
 * Used by both `vite.config.ts` (dev server) and `desktop-backend/backend.cjs`
 * (SEA-packaged desktop backend) so the two share a single DB on disk and a
 * single schema definition.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Resolve where the audit DB lives on disk.
 *
 * Override with FINANALYZER_DATA_DIR. Default: ~/.finanalyzer
 * Returns the absolute path to the SQLite file. Creates the directory if missing.
 */
const resolveAuditDbPath = () => {
  const override = process.env.FINANALYZER_DATA_DIR;
  const baseDir = override && override.trim()
    ? path.resolve(override.trim())
    : path.join(os.homedir(), '.finanalyzer');
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, 'audit.sqlite');
};

/**
 * Apply performance PRAGMAs.
 *
 * - WAL: lets readers and the single writer proceed concurrently and removes
 *   the per-commit journal rewrite that DELETE mode does.
 * - synchronous=NORMAL: WAL-safe and ~2x faster than FULL on bulk writes.
 * - cache_size: negative = KiB. -200000 = 200 MiB page cache.
 * - temp_store=MEMORY: keep ORDER BY / GROUP BY scratch in RAM.
 * - mmap_size: 256 MiB memory-mapped reads (helps the big SELECTs).
 * - foreign_keys: hygiene; cheap.
 */
const applyAuditPragmas = (db) => {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -200000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.pragma('foreign_keys = ON');
};

/**
 * Canonical schema. Indexes chosen for the modules that actually query them:
 *
 *   gstin                       → every GST module
 *   party_name                  → party ledger, ageing, sundries
 *   (is_master_ledger, ledger)  → master/transaction split, mst_ledger build
 *   (voucher_type, date)        → voucher books, date-range filters
 *
 * Existing indexes kept; the redundant single-column voucher index is dropped
 * because the (voucher_number, date, voucher_type) composite covers it.
 */
const AUDIT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT,
    date TEXT,
    voucher_type TEXT,
    voucher_number TEXT,
    invoice_number TEXT,
    reference_number TEXT,
    narration TEXT,
    party_name TEXT,
    gstin TEXT,
    ledger TEXT,
    amount REAL,
    group_name TEXT,
    opening_balance REAL,
    closing_balance REAL,
    tally_parent TEXT,
    tally_primary TEXT,
    is_revenue INTEGER,
    is_accounting_voucher INTEGER,
    is_master_ledger INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON ledger_entries(date);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_ledger ON ledger_entries(ledger);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_primary ON ledger_entries(tally_primary);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_parent ON ledger_entries(tally_parent);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_voucher_date_type ON ledger_entries(voucher_number, date, voucher_type);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_ledger_primary ON ledger_entries(ledger, tally_primary);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_gstin ON ledger_entries(gstin);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_party_name ON ledger_entries(party_name);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_master_ledger ON ledger_entries(is_master_ledger, ledger);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_voucher_type_date ON ledger_entries(voucher_type, date);

  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_hash TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_imports_imported_at ON imports(imported_at);

  CREATE TABLE IF NOT EXISTS gstr2b_imports (
    import_id TEXT PRIMARY KEY,
    source_name TEXT,
    uploaded_at TEXT,
    rtnprd TEXT,
    entity_gstin TEXT,
    version TEXT,
    generated_at TEXT,
    count_total INTEGER,
    count_b2b INTEGER,
    count_cdnr INTEGER,
    count_b2ba INTEGER,
    totals_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gstr2b_imports_uploaded_at ON gstr2b_imports(uploaded_at);

  CREATE TABLE IF NOT EXISTS gstr2b_import_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id TEXT,
    section TEXT,
    supplier_gstin TEXT,
    supplier_name TEXT,
    invoice_no TEXT,
    invoice_no_norm TEXT,
    invoice_date TEXT,
    taxable REAL,
    igst REAL,
    cgst REAL,
    sgst REAL,
    cess REAL,
    total_tax REAL,
    total_value REAL,
    reverse_charge INTEGER,
    type TEXT,
    itc_availability TEXT,
    pos TEXT,
    entity_gstin TEXT,
    branch TEXT,
    is_amended INTEGER,
    is_isd INTEGER,
    raw_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gstr2b_rows_import_id ON gstr2b_import_rows(import_id);
  CREATE INDEX IF NOT EXISTS idx_gstr2b_rows_supplier_invoice ON gstr2b_import_rows(supplier_gstin, invoice_no_norm, invoice_date);

  CREATE TABLE IF NOT EXISTS gstr2b_reco_runs (
    run_id TEXT PRIMARY KEY,
    import_id TEXT,
    created_at TEXT,
    scope_month TEXT,
    scope_entity_gstin TEXT,
    scope_branch TEXT,
    config_json TEXT,
    result_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gstr2b_runs_created_at ON gstr2b_reco_runs(created_at);
`;

/**
 * Apply the canonical schema. Idempotent.
 *
 * Also runs a defensive ALTER for `is_master_ledger` so that DBs created
 * by older versions (which lacked the column) get migrated forward.
 */
const initializeAuditSchema = (db) => {
  db.exec(AUDIT_SCHEMA_SQL);
  try {
    db.exec('ALTER TABLE ledger_entries ADD COLUMN is_master_ledger INTEGER DEFAULT 0;');
  } catch {
    // duplicate column — already migrated
  }
};

/**
 * Hash a row array deterministically. Used to decide whether to skip a
 * DELETE+INSERT cycle when the user re-imports identical source data.
 *
 * Stable JSON: keys are not sorted (rows are produced by the same code
 * path each time, so key order is consistent), but row order matters
 * because two different orderings represent different inputs to the
 * downstream pipeline. If you want order-independence, sort first.
 */
const hashRows = (rows) => {
  const hash = crypto.createHash('sha256');
  hash.update(`${Array.isArray(rows) ? rows.length : 0}\n`);
  if (Array.isArray(rows)) {
    for (const row of rows) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
};

/**
 * Open and configure an audit DB. Caller decides path (use
 * `resolveAuditDbPath()` for the canonical location, or pass a temp file
 * for export/parse helpers). Applies PRAGMAs and schema unconditionally;
 * both ops are idempotent.
 *
 * `Database` is the better-sqlite3 constructor — passed in by the caller
 * so this module doesn't have to know whether it was loaded via require()
 * or createRequire() (vite.config.ts is ESM).
 */
const openAuditDb = (Database, filePath, options = {}) => {
  const db = new Database(filePath, options);
  applyAuditPragmas(db);
  initializeAuditSchema(db);
  return db;
};

/**
 * Look up the most recent import hash, if any. Used to short-circuit
 * `loadAuditRows` when the incoming source data is byte-identical to
 * what's already in the DB.
 */
const getLastImportHash = (db) => {
  const row = db
    .prepare('SELECT source_hash, row_count, imported_at FROM imports ORDER BY id DESC LIMIT 1')
    .get();
  return row || null;
};

/**
 * Record an import. Caller is responsible for the actual data write —
 * this just bookkeeps the hash so we can skip identical re-imports.
 */
const recordImport = (db, sourceHash, rowCount) => {
  db.prepare('INSERT INTO imports (source_hash, row_count, imported_at) VALUES (?, ?, ?)')
    .run(String(sourceHash || ''), Number(rowCount || 0), new Date().toISOString());
};

module.exports = {
  resolveAuditDbPath,
  applyAuditPragmas,
  AUDIT_SCHEMA_SQL,
  initializeAuditSchema,
  hashRows,
  openAuditDb,
  getLastImportHash,
  recordImport,
};
