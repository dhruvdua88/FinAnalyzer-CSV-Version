from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from tsf_exporter.model.date_utils import parse_ddmmyyyy
from tsf_exporter.model.loader_runner import LoaderRunRequest, LoaderRunner
from tsf_exporter.model.loader_tables import stage_loader_tables
from tsf_exporter.model.logging_service import RunLogger
from tsf_exporter.model.runtime_paths import AppPaths, ensure_runtime_directories
from tsf_exporter.model.tsf_writer import write_tsf_file


ProgressCallback = Callable[[str], None]


@dataclass
class ExportRequest:
    from_date: str = ""
    to_date: str = ""
    out_dir: Path | None = None
    company: str = ""
    source_dir: Path | None = None


@dataclass
class ExportResult:
    output_path: Path
    log_path: Path


class ExportController:
    def __init__(self, paths: AppPaths) -> None:
        self.paths = paths

    def _emit(self, callback: ProgressCallback | None, message: str) -> None:
        if callback:
            callback(message)

    def _validate_request(self, request: ExportRequest) -> tuple[str, str]:
        from_iso = parse_ddmmyyyy(request.from_date) if request.from_date.strip() else ""
        to_iso = parse_ddmmyyyy(request.to_date) if request.to_date.strip() else ""

        if bool(from_iso) != bool(to_iso):
            raise ValueError("Both From Date and To Date are required. Use dd/mm/yyyy.")
        if from_iso and to_iso and from_iso > to_iso:
            raise ValueError("From Date must be less than or equal to To Date.")
        return from_iso, to_iso

    def run_export_sync(
        self,
        request: ExportRequest,
        progress_callback: ProgressCallback | None = None,
    ) -> ExportResult:
        ensure_runtime_directories(self.paths)
        logger = RunLogger(self.paths.logs_dir)
        cleanup_paths: list[Path] = []

        try:
            from_iso, to_iso = self._validate_request(request)
            output_dir = (request.out_dir or self.paths.output_dir).expanduser().resolve()
            output_dir.mkdir(parents=True, exist_ok=True)

            self._emit(progress_callback, "Preparing runtime...")
            logger.log(f"Using app root: {self.paths.root_dir}")
            logger.log(f"Using output directory: {output_dir}")

            loader_runner = LoaderRunner(self.paths, logger, progress_callback)
            source = loader_runner.prepare_source(
                LoaderRunRequest(
                    from_date=from_iso,
                    to_date=to_iso,
                    company=request.company.strip(),
                    source_dir=request.source_dir,
                )
            )
            cleanup_paths.extend(source.cleanup_paths)

            self._emit(progress_callback, "Staging loader tables...")
            stage_db_path = self.paths.temp_dir / f"stage-{datetime.now().strftime('%Y%m%d%H%M%S%f')}.sqlite"
            cleanup_paths.append(stage_db_path)
            stage_loader_tables(source.tables_dir, stage_db_path, logger.log)

            stamp = datetime.now().strftime("%Y-%m-%d")
            output_path = output_dir / f"Tally_Source_File_{stamp}.tsf"

            self._emit(progress_callback, "Writing TSF file...")
            write_tsf_file(stage_db_path, output_path, logger.log)

            self._emit(progress_callback, f"Export completed: {output_path}")
            logger.log(f"Export completed successfully: {output_path}")
            return ExportResult(output_path=output_path, log_path=logger.path)
        except Exception as exc:
            logger.exception(exc)
            raise
        finally:
            for cleanup_path in cleanup_paths:
                try:
                    if cleanup_path.is_file():
                        cleanup_path.unlink(missing_ok=True)
                except OSError:
                    logger.log(f"Cleanup skipped for: {cleanup_path}")
