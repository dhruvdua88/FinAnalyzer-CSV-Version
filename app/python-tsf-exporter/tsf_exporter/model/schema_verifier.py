from __future__ import annotations

import re
import sqlite3

from tsf_exporter.model.contracts import load_frozen_contract_fixture


def _normalize_sql(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def introspect_contract(connection: sqlite3.Connection) -> dict:
    creation_order = [
        row[0]
        for row in connection.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY rootpage ASC, name ASC
            """
        )
    ]

    tables: dict[str, dict] = {}
    for table_name in creation_order:
        columns = []
        for row in connection.execute(f"PRAGMA table_info('{table_name}')"):
            columns.append(
                {
                    "name": row[1],
                    "type": row[2],
                    "notnull": row[3],
                    "default": row[4],
                    "pk": row[5],
                }
            )

        indexes = []
        for index_row in connection.execute(f"PRAGMA index_list('{table_name}')"):
            index_name = index_row[1]
            if index_name.startswith("sqlite_autoindex"):
                continue
            sql_row = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
                (index_name,),
            ).fetchone()
            columns_for_index = [
                info_row[2]
                for info_row in connection.execute(f"PRAGMA index_info('{index_name}')")
            ]
            indexes.append(
                {
                    "name": index_name,
                    "columns": columns_for_index,
                    "sql": _normalize_sql(sql_row[0] if sql_row else ""),
                }
            )
        indexes.sort(key=lambda item: item["name"])

        create_sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        tables[table_name] = {
            "create_sql": _normalize_sql(create_sql[0] if create_sql else ""),
            "columns": columns,
            "indexes": indexes,
        }

    return {"creation_order": creation_order, "tables": tables}


def verify_contract(connection: sqlite3.Connection) -> None:
    expected = load_frozen_contract_fixture()
    actual = introspect_contract(connection)
    if actual != expected:
        raise ValueError("Generated TSF structure does not match the frozen contract.")
