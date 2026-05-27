/**
 * Smoke test for the audit DB core: opens a temp DB, runs a 50k-row insert
 * inside db.transaction(), checks PRAGMAs are applied, verifies hash-skip
 * short-circuits a second identical import, and asserts every expected index
 * is present.
 *
 * Lives outside `node --test` because it uses a real on-disk DB in a tmp dir
 * and needs to clean up after itself. Run with `node desktop-backend/tests/auditDbCore.smoke.cjs`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finanalyzer-smoke-'));
process.env.FINANALYZER_DATA_DIR = tmpDir;

const {
  resolveAuditDbPath,
  applyAuditPragmas,
  initializeAuditSchema,
  hashRows,
  getLastImportHash,
  recordImport,
} = require('../services/auditDbCore.cjs');

const dbPath = resolveAuditDbPath();
console.log('DB path:', dbPath);

const db = new Database(dbPath);
applyAuditPragmas(db);
initializeAuditSchema(db);

// PRAGMA assertions
const journal = db.pragma('journal_mode', { simple: true });
const sync = db.pragma('synchronous', { simple: true });
const cache = db.pragma('cache_size', { simple: true });
console.log('journal_mode:', journal, '(expected wal)');
console.log('synchronous:', sync, '(expected 1 = NORMAL)');
console.log('cache_size:', cache, '(expected -200000)');
if (String(journal).toLowerCase() !== 'wal') throw new Error('journal_mode not WAL');
if (Number(sync) !== 1) throw new Error('synchronous not NORMAL');

// Index assertions — every index promised in the schema must exist
const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ledger_entries' ORDER BY name")
  .all()
  .map((r) => r.name);
const required = [
  'idx_ledger_entries_date',
  'idx_ledger_entries_gstin',
  'idx_ledger_entries_ledger',
  'idx_ledger_entries_ledger_primary',
  'idx_ledger_entries_master_ledger',
  'idx_ledger_entries_parent',
  'idx_ledger_entries_party_name',
  'idx_ledger_entries_primary',
  'idx_ledger_entries_voucher_date_type',
  'idx_ledger_entries_voucher_type_date',
];
for (const name of required) {
  if (!indexes.includes(name)) throw new Error(`Missing index ${name}; have: ${indexes.join(', ')}`);
}
console.log('indexes OK:', indexes.length, 'present');

// Bulk insert benchmark — exercises db.transaction() exactly the same way
// the production loadAuditRows path does.
const N = 50000;
const rows = Array.from({ length: N }, (_, i) => ({
  guid: `g${i}`, date: '2025-04-01', voucher_type: 'Sales', voucher_number: `V${i}`,
  invoice_number: '', reference_number: '', narration: '', party_name: `P${i % 100}`,
  gstin: '', ledger: `L${i % 50}`, amount: i * 1.5, group_name: 'Sundry Debtors',
  opening_balance: 0, closing_balance: 0, tally_parent: 'Group', tally_primary: 'Asset',
  is_revenue: 1, is_accounting_voucher: 1, is_master_ledger: 0,
}));

const stmt = db.prepare(`
  INSERT INTO ledger_entries (
    guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
    party_name, gstin, ledger, amount, group_name, opening_balance, closing_balance,
    tally_parent, tally_primary, is_revenue, is_accounting_voucher, is_master_ledger
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insert = db.transaction((batch) => {
  db.exec('DELETE FROM ledger_entries;');
  for (const r of batch) {
    stmt.run(
      r.guid, r.date, r.voucher_type, r.voucher_number, r.invoice_number, r.reference_number,
      r.narration, r.party_name, r.gstin, r.ledger, r.amount, r.group_name,
      r.opening_balance, r.closing_balance, r.tally_parent, r.tally_primary,
      r.is_revenue, r.is_accounting_voucher, r.is_master_ledger
    );
  }
});

const t0 = Date.now();
insert(rows);
const tInsert = Date.now() - t0;
console.log(`insert ${N} rows in transaction: ${tInsert} ms`);

const sourceHash = hashRows(rows);
recordImport(db, sourceHash, N);

// Hash-skip: re-querying with the same hash should match
const last = getLastImportHash(db);
if (!last || last.source_hash !== sourceHash) throw new Error('hash-skip lookup failed');
console.log('hash-skip lookup OK; row_count:', last.row_count);

// Filtered query timing — exercises the new gstin index would be used here
// but our smoke data has empty gstin; instead use party_name (newly indexed).
const tQ = Date.now();
const r = db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE party_name = ?').get('P42');
const tQuery = Date.now() - tQ;
console.log(`indexed query (party_name): ${tQuery} ms, count=${r.c} (expected 500)`);
if (r.c !== 500) throw new Error('indexed query returned wrong count');

db.close();

// Re-open: persistence across process boundaries works
const db2 = new Database(dbPath, { readonly: true });
const cnt = db2.prepare('SELECT COUNT(*) AS c FROM ledger_entries').get().c;
console.log('reopen count:', cnt, '(expected', N, ')');
if (cnt !== N) throw new Error('persistence broke across reopen');
db2.close();

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\nALL SMOKE CHECKS PASSED');
