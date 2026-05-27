from __future__ import annotations

import csv
import json
import sqlite3
from pathlib import Path


REQUIRED_TABLES = ("trn_accounting", "trn_voucher")
OPTIONAL_TABLES = ("mst_ledger", "mst_group")
SUPPORTED_SUFFIXES = (".json", ".csv")


def _to_text(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_name_key(value: object) -> str:
    return " ".join(_to_text(value).split()).lower()


def _normalize_row_keys(row: dict[str, object]) -> dict[str, object]:
    return {str(key).strip().lower(): value for key, value in row.items()}


def _iter_json_array(path: Path):
    decoder = json.JSONDecoder()
    buffer = ""
    started = False
    eof = False
    with path.open("r", encoding="utf-8-sig") as handle:
        while True:
            chunk = handle.read(65536)
            if chunk:
                buffer += chunk
            else:
                eof = True
            index = 0
            length = len(buffer)
            while True:
                while index < length and buffer[index].isspace():
                    index += 1
                if not started:
                    if index >= length:
                        break
                    if buffer[index] != "[":
                        raise ValueError(f"File is not a JSON array: {path}")
                    started = True
                    index += 1
                    continue
                while index < length and buffer[index].isspace():
                    index += 1
                if index >= length:
                    break
                if buffer[index] == "]":
                    return
                try:
                    row, next_index = decoder.raw_decode(buffer, index)
                except ValueError:
                    if eof:
                        raise ValueError(f"Malformed JSON array payload in {path}")
                    break
                yield _normalize_row_keys(row)
                index = next_index
                while index < length and buffer[index].isspace():
                    index += 1
                if index < length and buffer[index] == ",":
                    index += 1
                    continue
                if index < length and buffer[index] == "]":
                    return
                if index >= length:
                    break
                raise ValueError(f"Malformed JSON array payload in {path}")
            buffer = buffer[index:]
            if eof:
                if buffer.strip():
                    raise ValueError(f"Unexpected trailing JSON content in {path}")
                break


def _iter_csv_rows(path: Path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            yield _normalize_row_keys(dict(row))


def _iter_table_rows(path: Path):
    suffix = path.suffix.lower()
    if suffix == ".json":
        yield from _iter_json_array(path)
        return
    if suffix == ".csv":
        yield from _iter_csv_rows(path)
        return
    raise ValueError(f"Unsupported table file: {path}")


def _pick_preferred(existing: Path | None, candidate: Path) -> Path:
    if existing is None:
        return candidate
    if existing.suffix.lower() == ".csv" and candidate.suffix.lower() == ".json":
        return candidate
    return existing


def _discover_table_files(source_dir: Path) -> dict[str, Path]:
    table_files: dict[str, Path] = {}
    for path in sorted(source_dir.iterdir()):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
            continue
        table_name = path.stem.strip().lower()
        table_files[table_name] = _pick_preferred(table_files.get(table_name), path)
    missing = [name for name in REQUIRED_TABLES if name not in table_files]
    if missing:
        raise FileNotFoundError(
            f"Tally loader input requires {', '.join(missing)} in CSV or JSON format at {source_dir}"
        )
    return table_files


def stage_loader_tables(source_dir: Path, staging_db_path: Path, log) -> None:
    table_files = _discover_table_files(source_dir)
    if staging_db_path.exists():
        staging_db_path.unlink()

    connection = sqlite3.connect(staging_db_path)
    try:
        connection.executescript(
            """
            CREATE TABLE stg_trn_accounting (
              row_idx INTEGER PRIMARY KEY,
              guid TEXT,
              guid_key TEXT,
              ledger TEXT,
              amount TEXT
            );
            CREATE INDEX idx_stg_trn_accounting_guid_key ON stg_trn_accounting(guid_key);

            CREATE TABLE stg_trn_voucher (
              row_idx INTEGER PRIMARY KEY,
              guid TEXT,
              guid_key TEXT,
              date TEXT,
              voucher_number TEXT,
              reference_number TEXT,
              voucher_type TEXT,
              narration TEXT,
              party_name TEXT,
              is_accounting_voucher TEXT
            );
            CREATE INDEX idx_stg_trn_voucher_guid_key ON stg_trn_voucher(guid_key);

            CREATE TABLE stg_mst_ledger (
              row_idx INTEGER PRIMARY KEY,
              name TEXT,
              parent TEXT,
              gstn TEXT,
              opening_balance TEXT,
              closing_balance TEXT,
              is_revenue TEXT,
              name_key TEXT
            );
            CREATE INDEX idx_stg_mst_ledger_name_key ON stg_mst_ledger(name_key);

            CREATE TABLE stg_mst_group (
              row_idx INTEGER PRIMARY KEY,
              name TEXT,
              primary_group TEXT,
              name_key TEXT
            );
            CREATE INDEX idx_stg_mst_group_name_key ON stg_mst_group(name_key);
            """
        )

        for table_name in REQUIRED_TABLES + OPTIONAL_TABLES:
            source_path = table_files.get(table_name)
            if source_path is None:
                log(f"Optional table missing: {table_name}")
                continue
            log(f"Staging table: {source_path.name}")
            _stage_table(connection, table_name, source_path)

        connection.commit()
    finally:
        connection.close()


def _stage_table(connection: sqlite3.Connection, table_name: str, source_path: Path) -> None:
    buffer: list[tuple] = []
    flush_size = 500

    if table_name == "trn_accounting":
        sql = "INSERT INTO stg_trn_accounting (row_idx, guid, guid_key, ledger, amount) VALUES (?, ?, ?, ?, ?)"
        for row_idx, row in enumerate(_iter_table_rows(source_path), start=1):
            guid = _to_text(row.get("guid"))
            buffer.append((row_idx, guid, guid.lower(), _to_text(row.get("ledger")), _to_text(row.get("amount"))))
            if len(buffer) >= flush_size:
                connection.executemany(sql, buffer)
                buffer.clear()
    elif table_name == "trn_voucher":
        sql = """
        INSERT INTO stg_trn_voucher (
          row_idx, guid, guid_key, date, voucher_number, reference_number, voucher_type, narration, party_name, is_accounting_voucher
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        for row_idx, row in enumerate(_iter_table_rows(source_path), start=1):
            guid = _to_text(row.get("guid"))
            buffer.append(
                (
                    row_idx,
                    guid,
                    guid.lower(),
                    _to_text(row.get("date")),
                    _to_text(row.get("voucher_number")),
                    _to_text(row.get("reference_number")),
                    _to_text(row.get("voucher_type")),
                    _to_text(row.get("narration")),
                    _to_text(row.get("party_name")),
                    _to_text(row.get("is_accounting_voucher")),
                )
            )
            if len(buffer) >= flush_size:
                connection.executemany(sql, buffer)
                buffer.clear()
    elif table_name == "mst_ledger":
        sql = """
        INSERT INTO stg_mst_ledger (
          row_idx, name, parent, gstn, opening_balance, closing_balance, is_revenue, name_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """
        for row_idx, row in enumerate(_iter_table_rows(source_path), start=1):
            name = _to_text(row.get("name"))
            buffer.append(
                (
                    row_idx,
                    name,
                    _to_text(row.get("parent")),
                    _to_text(row.get("gstn")),
                    _to_text(row.get("opening_balance")),
                    _to_text(row.get("closing_balance")),
                    _to_text(row.get("is_revenue")),
                    _normalize_name_key(name),
                )
            )
            if len(buffer) >= flush_size:
                connection.executemany(sql, buffer)
                buffer.clear()
    elif table_name == "mst_group":
        sql = "INSERT INTO stg_mst_group (row_idx, name, primary_group, name_key) VALUES (?, ?, ?, ?)"
        for row_idx, row in enumerate(_iter_table_rows(source_path), start=1):
            name = _to_text(row.get("name"))
            buffer.append((row_idx, name, _to_text(row.get("primary_group")), _normalize_name_key(name)))
            if len(buffer) >= flush_size:
                connection.executemany(sql, buffer)
                buffer.clear()
    else:
        return

    if buffer:
        connection.executemany(sql, buffer)
