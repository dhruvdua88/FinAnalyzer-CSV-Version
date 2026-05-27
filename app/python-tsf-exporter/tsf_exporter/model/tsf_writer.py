from __future__ import annotations

from datetime import datetime
from pathlib import Path
import sqlite3

from tsf_exporter.model.contracts import AUDIT_SCHEMA_SQL, REFERENCE_COLLECTIONS_SQL
from tsf_exporter.model.schema_verifier import verify_contract


def _normalize_name_key(value) -> str:
    if value is None:
        return ""
    return " ".join(str(value).strip().split()).lower()


def _to_number(value) -> float:
    if value is None:
        return 0.0
    text = str(value).strip().replace(",", "")
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def _to_logical_number(value) -> int:
    text = str(value or "").strip().lower()
    if text in {"true", "yes"}:
        return 1
    if text in {"false", "no"}:
        return 0
    return 1 if _to_number(value) > 0 else 0


def _to_boolean(value) -> int:
    text = str(value or "").strip().lower()
    return 1 if text in {"true", "yes", "1"} else 0


def _to_iso_date(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return text
    if len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    if len(text) == 10 and text[2] in {"/", "-"} and text[5] in {"/", "-"}:
        return f"{text[6:10]}-{text[3:5]}-{text[0:2]}"
    if len(text) == 8 and text[2] in {"/", "-"} and text[5] in {"/", "-"}:
        year = int(text[6:8])
        year = 2000 + year if year < 70 else 1900 + year
        return f"{year:04d}-{text[3:5]}-{text[0:2]}"
    try:
        return datetime.fromisoformat(text).date().isoformat()
    except ValueError:
        return text


def _register_functions(connection: sqlite3.Connection) -> None:
    connection.create_function("normalize_name_key", 1, _normalize_name_key)
    connection.create_function("js_to_number", 1, _to_number)
    connection.create_function("js_to_logical_number", 1, _to_logical_number)
    connection.create_function("js_to_boolean", 1, _to_boolean)
    connection.create_function("js_to_iso_date", 1, _to_iso_date)


def write_tsf_file(staging_db_path: Path, output_path: Path, log) -> None:
    now_ms = int(datetime.now().timestamp() * 1000)
    if output_path.exists():
        output_path.unlink()

    connection = sqlite3.connect(output_path)
    try:
        _register_functions(connection)
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.executescript(AUDIT_SCHEMA_SQL)
        connection.execute("ATTACH DATABASE ? AS stage", (str(staging_db_path),))

        connection.execute("BEGIN")
        _insert_accounting_rows(connection, now_ms)
        _insert_master_rows(connection, now_ms)
        connection.executescript(REFERENCE_COLLECTIONS_SQL)
        connection.commit()

        verify_contract(connection)
        log(f"TSF structure verified successfully: {output_path}")
    except Exception:
        connection.rollback()
        raise
    finally:
        try:
            connection.execute("DETACH DATABASE stage")
        except sqlite3.Error:
            pass
        connection.close()


def _insert_accounting_rows(connection: sqlite3.Connection, now_ms: int) -> None:
    connection.execute(
        """
        WITH latest_voucher AS (
          SELECT v.*
          FROM stage.stg_trn_voucher v
          JOIN (
            SELECT guid_key, MAX(row_idx) AS row_idx
            FROM stage.stg_trn_voucher
            GROUP BY guid_key
          ) latest
            ON v.guid_key = latest.guid_key
           AND v.row_idx = latest.row_idx
        ),
        latest_ledger AS (
          SELECT l.*
          FROM stage.stg_mst_ledger l
          JOIN (
            SELECT name_key, MAX(row_idx) AS row_idx
            FROM stage.stg_mst_ledger
            GROUP BY name_key
          ) latest
            ON l.name_key = latest.name_key
           AND l.row_idx = latest.row_idx
        ),
        latest_group AS (
          SELECT g.*
          FROM stage.stg_mst_group g
          JOIN (
            SELECT name_key, MAX(row_idx) AS row_idx
            FROM stage.stg_mst_group
            GROUP BY name_key
          ) latest
            ON g.name_key = latest.name_key
           AND g.row_idx = latest.row_idx
        ),
        base AS (
          SELECT
            a.row_idx,
            a.guid,
            a.guid_key,
            CASE WHEN TRIM(COALESCE(a.ledger, '')) <> '' THEN TRIM(a.ledger) ELSE 'Unknown Ledger' END AS ledger_name,
            js_to_number(a.amount) AS amount_value,
            v.date AS voucher_date,
            v.voucher_number AS voucher_number,
            v.reference_number AS reference_number,
            v.voucher_type AS voucher_type,
            v.narration AS narration,
            v.party_name AS party_name,
            l.parent AS ledger_parent,
            l.gstn AS ledger_gstn,
            l.opening_balance AS ledger_opening_balance,
            l.closing_balance AS ledger_closing_balance,
            l.is_revenue AS ledger_is_revenue,
            g.primary_group AS group_primary,
            CASE
              WHEN TRIM(COALESCE(v.voucher_number, '')) <> '' THEN ''
              WHEN TRIM(COALESCE(a.guid, '')) <> '' THEN a.guid_key
              ELSE '__row_' || CAST(a.row_idx AS TEXT)
            END AS synth_key
          FROM stage.stg_trn_accounting a
          LEFT JOIN latest_voucher v
            ON a.guid_key = v.guid_key
          LEFT JOIN latest_ledger l
            ON normalize_name_key(CASE WHEN TRIM(COALESCE(a.ledger, '')) <> '' THEN TRIM(a.ledger) ELSE 'Unknown Ledger' END) = l.name_key
          LEFT JOIN latest_group g
            ON normalize_name_key(TRIM(COALESCE(l.parent, ''))) = g.name_key
          WHERE js_to_boolean(v.is_accounting_voucher) = 1
        ),
        missing_keys AS (
          SELECT
            synth_key,
            ROW_NUMBER() OVER (ORDER BY MIN(row_idx)) AS synthetic_number
          FROM base
          WHERE synth_key <> ''
          GROUP BY synth_key
        )
        INSERT INTO ledger_entries (
          guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
          party_name, gstin, ledger, amount, group_name, opening_balance, closing_balance,
          tally_parent, tally_primary, is_revenue, is_accounting_voucher, is_master_ledger
        )
        SELECT
          CASE
            WHEN TRIM(COALESCE(b.guid, '')) <> '' THEN TRIM(b.guid) || '-' || CAST(b.row_idx - 1 AS TEXT)
            ELSE 'loader-' || ? || '-' || CAST(b.row_idx - 1 AS TEXT)
          END AS guid,
          js_to_iso_date(b.voucher_date) AS date,
          TRIM(COALESCE(b.voucher_type, '')) AS voucher_type,
          CASE
            WHEN TRIM(COALESCE(b.voucher_number, '')) <> '' THEN TRIM(b.voucher_number)
            ELSE 'UNKNOWN-' || CAST(m.synthetic_number AS TEXT)
          END AS voucher_number,
          TRIM(COALESCE(b.reference_number, '')) AS invoice_number,
          TRIM(COALESCE(b.reference_number, '')) AS reference_number,
          TRIM(COALESCE(b.narration, '')) AS narration,
          TRIM(COALESCE(b.party_name, '')) AS party_name,
          TRIM(COALESCE(b.ledger_gstn, '')) AS gstin,
          b.ledger_name AS ledger,
          b.amount_value AS amount,
          TRIM(COALESCE(b.ledger_parent, '')) AS group_name,
          js_to_number(b.ledger_opening_balance) AS opening_balance,
          js_to_number(b.ledger_closing_balance) AS closing_balance,
          TRIM(COALESCE(b.ledger_parent, '')) AS tally_parent,
          TRIM(COALESCE(b.group_primary, '')) AS tally_primary,
          CASE WHEN js_to_logical_number(b.ledger_is_revenue) > 0 THEN 1 ELSE 0 END AS is_revenue,
          1 AS is_accounting_voucher,
          0 AS is_master_ledger
        FROM base b
        LEFT JOIN missing_keys m
          ON b.synth_key = m.synth_key
        ORDER BY b.row_idx
        """,
        (str(now_ms),),
    )


def _insert_master_rows(connection: sqlite3.Connection, now_ms: int) -> None:
    connection.execute(
        """
        WITH latest_voucher AS (
          SELECT v.*
          FROM stage.stg_trn_voucher v
          JOIN (
            SELECT guid_key, MAX(row_idx) AS row_idx
            FROM stage.stg_trn_voucher
            GROUP BY guid_key
          ) latest
            ON v.guid_key = latest.guid_key
           AND v.row_idx = latest.row_idx
        ),
        latest_group AS (
          SELECT g.*
          FROM stage.stg_mst_group g
          JOIN (
            SELECT name_key, MAX(row_idx) AS row_idx
            FROM stage.stg_mst_group
            GROUP BY name_key
          ) latest
            ON g.name_key = latest.name_key
           AND g.row_idx = latest.row_idx
        ),
        seen_ledgers AS (
          SELECT DISTINCT normalize_name_key(CASE WHEN TRIM(COALESCE(a.ledger, '')) <> '' THEN TRIM(a.ledger) ELSE 'Unknown Ledger' END) AS ledger_key
          FROM stage.stg_trn_accounting a
          LEFT JOIN latest_voucher v
            ON a.guid_key = v.guid_key
          WHERE js_to_boolean(v.is_accounting_voucher) = 1
        ),
        master_candidates AS (
          SELECT
            l.row_idx,
            CASE WHEN TRIM(COALESCE(l.name, '')) <> '' THEN TRIM(l.name) ELSE 'Unknown Ledger ' || CAST(l.row_idx AS TEXT) END AS ledger_name,
            l.parent,
            l.gstn,
            l.opening_balance,
            l.closing_balance,
            l.is_revenue,
            g.primary_group
          FROM stage.stg_mst_ledger l
          LEFT JOIN latest_group g
            ON normalize_name_key(TRIM(COALESCE(l.parent, ''))) = g.name_key
          LEFT JOIN seen_ledgers s
            ON normalize_name_key(CASE WHEN TRIM(COALESCE(l.name, '')) <> '' THEN TRIM(l.name) ELSE 'Unknown Ledger ' || CAST(l.row_idx AS TEXT) END) = s.ledger_key
          WHERE s.ledger_key IS NULL
        )
        INSERT INTO ledger_entries (
          guid, date, voucher_type, voucher_number, invoice_number, reference_number, narration,
          party_name, gstin, ledger, amount, group_name, opening_balance, closing_balance,
          tally_parent, tally_primary, is_revenue, is_accounting_voucher, is_master_ledger
        )
        SELECT
          'ledger-master-' || ? || '-' || CAST(m.row_idx - 1 AS TEXT) AS guid,
          '' AS date,
          '__MASTER_LEDGER__' AS voucher_type,
          '__MASTER_LEDGER__' || CAST(m.row_idx AS TEXT) AS voucher_number,
          '' AS invoice_number,
          '' AS reference_number,
          'Ledger master balance row' AS narration,
          '' AS party_name,
          TRIM(COALESCE(m.gstn, '')) AS gstin,
          m.ledger_name AS ledger,
          0 AS amount,
          TRIM(COALESCE(m.parent, '')) AS group_name,
          js_to_number(m.opening_balance) AS opening_balance,
          js_to_number(m.closing_balance) AS closing_balance,
          TRIM(COALESCE(m.parent, '')) AS tally_parent,
          TRIM(COALESCE(m.primary_group, '')) AS tally_primary,
          CASE WHEN js_to_logical_number(m.is_revenue) > 0 THEN 1 ELSE 0 END AS is_revenue,
          1 AS is_accounting_voucher,
          1 AS is_master_ledger
        FROM master_candidates m
        ORDER BY m.row_idx
        """,
        (str(now_ms),),
    )
