from __future__ import annotations

import json
from pathlib import Path


AUDIT_SCHEMA_SQL = """
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
CREATE INDEX IF NOT EXISTS idx_ledger_entries_voucher ON ledger_entries(voucher_number);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_ledger ON ledger_entries(ledger);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_primary ON ledger_entries(tally_primary);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_parent ON ledger_entries(tally_parent);

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
""".strip()


REFERENCE_COLLECTIONS_SQL = """
CREATE TABLE IF NOT EXISTS trn_accounting (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT,
  date TEXT,
  voucher_type TEXT,
  voucher_number TEXT,
  invoice_number TEXT,
  reference_number TEXT,
  narration TEXT,
  party_name TEXT,
  ledger TEXT,
  amount REAL,
  group_name TEXT,
  tally_parent TEXT,
  tally_primary TEXT,
  gstin TEXT,
  is_revenue INTEGER,
  is_accounting_voucher INTEGER
);
DELETE FROM trn_accounting;
INSERT INTO trn_accounting (
  guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
  party_name, ledger, amount, group_name, tally_parent, tally_primary, gstin, is_revenue, is_accounting_voucher
)
SELECT
  guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
  party_name, ledger, amount, group_name, tally_parent, tally_primary, gstin, is_revenue, is_accounting_voucher
FROM ledger_entries
WHERE COALESCE(is_master_ledger, 0) = 0;

CREATE TABLE IF NOT EXISTS mst_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger TEXT,
  group_name TEXT,
  tally_parent TEXT,
  tally_primary TEXT,
  gstin TEXT,
  is_revenue INTEGER,
  opening_balance REAL,
  closing_balance REAL
);
DELETE FROM mst_ledger;
INSERT INTO mst_ledger (
  ledger, group_name, tally_parent, tally_primary, gstin, is_revenue, opening_balance, closing_balance
)
SELECT
  ledger, group_name, tally_parent, tally_primary, gstin, is_revenue, opening_balance, closing_balance
FROM (
  SELECT
    ledger, group_name, tally_parent, tally_primary, gstin, is_revenue, opening_balance, closing_balance,
    ROW_NUMBER() OVER (
      PARTITION BY ledger
      ORDER BY
        CASE WHEN ABS(COALESCE(closing_balance, 0)) > 0 THEN 0 ELSE 1 END,
        id ASC
    ) AS rn
  FROM ledger_entries
  WHERE TRIM(COALESCE(ledger, '')) <> ''
    AND (
      COALESCE(is_master_ledger, 0) = 1
      OR NOT EXISTS (
        SELECT 1 FROM ledger_entries master_probe WHERE COALESCE(master_probe.is_master_ledger, 0) = 1
      )
    )
) ranked
WHERE rn = 1;

CREATE TABLE IF NOT EXISTS trial_balance_from_mst_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger TEXT,
  tally_primary TEXT,
  tally_parent TEXT,
  opening_balance REAL,
  closing_balance REAL,
  opening_dr REAL,
  opening_cr REAL,
  closing_dr REAL,
  closing_cr REAL
);
DELETE FROM trial_balance_from_mst_ledger;
INSERT INTO trial_balance_from_mst_ledger (
  ledger, tally_primary, tally_parent, opening_balance, closing_balance, opening_dr, opening_cr, closing_dr, closing_cr
)
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
""".strip()


def load_frozen_contract_fixture() -> dict:
    fixture_path = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "tsf_contract.json"
    with fixture_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)
