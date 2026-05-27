from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tsf_exporter.model.loader_tables import stage_loader_tables
from tsf_exporter.model.schema_verifier import introspect_contract
from tsf_exporter.model.tsf_writer import write_tsf_file


FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures"
LOADER_DUMP = FIXTURE_ROOT / "loader_dump"
FROZEN_CONTRACT = json.loads((FIXTURE_ROOT / "tsf_contract.json").read_text(encoding="utf-8"))


class TsfWriterTests(unittest.TestCase):
    def _build_export(self) -> tuple[Path, sqlite3.Connection]:
        temp_dir = Path(tempfile.mkdtemp(prefix="tsf-writer-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(temp_dir, ignore_errors=True))

        stage_db = temp_dir / "stage.sqlite"
        output_db = temp_dir / "output.tsf"
        stage_loader_tables(LOADER_DUMP, stage_db, lambda _message: None)
        write_tsf_file(stage_db, output_db, lambda _message: None)
        connection = sqlite3.connect(output_db)
        self.addCleanup(connection.close)
        return output_db, connection

    def test_generated_schema_matches_frozen_contract(self) -> None:
        _output_path, connection = self._build_export()
        actual = introspect_contract(connection)
        self.assertEqual(actual, FROZEN_CONTRACT)

    def test_reference_tables_match_expected_rows(self) -> None:
        _output_path, connection = self._build_export()

        ledger_count = connection.execute("SELECT COUNT(*) FROM ledger_entries").fetchone()[0]
        accounting_count = connection.execute("SELECT COUNT(*) FROM trn_accounting").fetchone()[0]
        mst_count = connection.execute("SELECT COUNT(*) FROM mst_ledger").fetchone()[0]
        tb_count = connection.execute("SELECT COUNT(*) FROM trial_balance_from_mst_ledger").fetchone()[0]

        self.assertEqual(ledger_count, 6)
        self.assertEqual(accounting_count, 4)
        self.assertEqual(mst_count, 1)
        self.assertEqual(tb_count, 1)

        voucher_numbers = [
            row[0]
            for row in connection.execute(
                "SELECT voucher_number FROM ledger_entries WHERE is_master_ledger = 0 ORDER BY id"
            )
        ]
        self.assertEqual(voucher_numbers, ["PV-001", "PV-001", "UNKNOWN-1", "UNKNOWN-1"])

        mst_row = connection.execute(
            """
            SELECT ledger, group_name, tally_parent, tally_primary, opening_balance, closing_balance
            FROM mst_ledger
            """
        ).fetchone()
        self.assertEqual(
            mst_row,
            ("Closing Stock", "Current Assets", "Current Assets", "Assets", 0.0, 1200.0),
        )

        tb_row = connection.execute(
            """
            SELECT ledger, opening_balance, closing_balance, opening_dr, opening_cr, closing_dr, closing_cr
            FROM trial_balance_from_mst_ledger
            """
        ).fetchone()
        self.assertEqual(tb_row, ("Closing Stock", 0.0, 1200.0, 0.0, 0.0, 0.0, 1200.0))

    def test_export_is_deterministic_for_same_input(self) -> None:
        _output_a, connection_a = self._build_export()
        _output_b, connection_b = self._build_export()

        contract_a = introspect_contract(connection_a)
        contract_b = introspect_contract(connection_b)
        self.assertEqual(contract_a, contract_b)

        rows_a = connection_a.execute(
            "SELECT voucher_number, ledger, amount, is_master_ledger FROM ledger_entries ORDER BY id"
        ).fetchall()
        rows_b = connection_b.execute(
            "SELECT voucher_number, ledger, amount, is_master_ledger FROM ledger_entries ORDER BY id"
        ).fetchall()
        self.assertEqual(rows_a, rows_b)


if __name__ == "__main__":
    unittest.main()
