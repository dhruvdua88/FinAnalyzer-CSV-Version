from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tsf_exporter.controller.export_controller import ExportController, ExportRequest
from tsf_exporter.model.runtime_paths import resolve_app_paths
from tsf_exporter.ui.main_window import launch_main_window


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Standalone TSF exporter")
    parser.add_argument("--from", dest="from_date", help="From Date in dd/mm/yyyy format")
    parser.add_argument("--to", dest="to_date", help="To Date in dd/mm/yyyy format")
    parser.add_argument("--out-dir", dest="out_dir", help="Output folder for the generated TSF")
    parser.add_argument("--company", dest="company", help="Optional Tally company override")
    parser.add_argument(
        "--source-dir",
        dest="source_dir",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--no-gui",
        action="store_true",
        help="Run in CLI mode even if no explicit arguments are supplied",
    )
    return parser


def run_cli(args: argparse.Namespace) -> int:
    controller = ExportController(resolve_app_paths())
    request = ExportRequest(
        from_date=args.from_date or "",
        to_date=args.to_date or "",
        out_dir=Path(args.out_dir).expanduser() if args.out_dir else None,
        company=args.company or "",
        source_dir=Path(args.source_dir).expanduser() if args.source_dir else None,
    )
    result = controller.run_export_sync(request, progress_callback=lambda message: print(message, flush=True))
    print(f"Export created: {result.output_path}")
    print(f"Log file: {result.log_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    should_run_cli = any(
        [
            args.no_gui,
            args.from_date,
            args.to_date,
            args.out_dir,
            args.company,
            args.source_dir,
        ]
    )

    if should_run_cli:
        return run_cli(args)

    launch_main_window(ExportController(resolve_app_paths()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
