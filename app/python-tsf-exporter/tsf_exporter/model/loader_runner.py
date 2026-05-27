from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import os
import shutil
import subprocess

from tsf_exporter.model.date_utils import to_loader_cli_date
from tsf_exporter.model.logging_service import RunLogger
from tsf_exporter.model.runtime_paths import AppPaths


@dataclass
class LoaderRunRequest:
    from_date: str = ""
    to_date: str = ""
    company: str = ""
    source_dir: Path | None = None


@dataclass
class LoaderSource:
    tables_dir: Path
    cleanup_paths: list[Path] = field(default_factory=list)


class LoaderRunner:
    def __init__(self, paths: AppPaths, logger: RunLogger, progress_callback=None) -> None:
        self.paths = paths
        self.logger = logger
        self.progress_callback = progress_callback

    def _emit(self, message: str) -> None:
        self.logger.log(message)
        if self.progress_callback:
            self.progress_callback(message)

    def prepare_source(self, request: LoaderRunRequest) -> LoaderSource:
        if request.source_dir:
            tables_dir = request.source_dir.expanduser().resolve()
            if not tables_dir.exists():
                raise FileNotFoundError(f"Source tables folder not found: {tables_dir}")
            self._emit(f"Using existing loader tables at: {tables_dir}")
            return LoaderSource(tables_dir=tables_dir)

        loader_root = self._resolve_loader_root()
        node_executable = self._resolve_node_executable()
        runtime_root, cleanup_paths = self._ensure_loader_runtime(loader_root)
        csv_dir = runtime_root / "csv"

        if csv_dir.exists():
            shutil.rmtree(csv_dir)
        csv_dir.mkdir(parents=True, exist_ok=True)

        args = [str(node_executable), "dist/index.mjs", "--database-technology", "json"]
        if request.from_date:
            args.extend(["--tally-fromdate", to_loader_cli_date(request.from_date)])
        if request.to_date:
            args.extend(["--tally-todate", to_loader_cli_date(request.to_date)])
        if request.company:
            args.extend(["--tally-company", request.company])

        self._emit(f"Using loader root: {runtime_root}")
        self._emit(f"Starting hidden loader: {' '.join(args)}")

        process = subprocess.Popen(
            args,
            cwd=runtime_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        combined_output: list[str] = []
        assert process.stdout is not None
        for line in process.stdout:
            cleaned = line.rstrip()
            if cleaned:
                combined_output.append(cleaned)
                self._emit(cleaned)

        code = process.wait()
        if code != 0:
            combined = "\n".join(combined_output).lower()
            if "unable to connect with tally" in combined:
                raise RuntimeError("Loader could not connect to Tally XML server. Open Tally and enable XML port 9000.")
            raise RuntimeError(f"Hidden loader exited with code {code}.")

        if not csv_dir.exists():
            raise RuntimeError(f"Loader output folder not found at {csv_dir}")

        self._emit(f"Loader output captured at: {csv_dir}")
        return LoaderSource(tables_dir=csv_dir, cleanup_paths=cleanup_paths)

    def _resolve_loader_root(self) -> Path:
        root = self.paths.loader_dir
        if not (root / "dist" / "index.mjs").exists() or not (root / "config.json").exists():
            raise FileNotFoundError(
                f"Bundled loader not found or incomplete at {root}. Expected dist/index.mjs and config.json."
            )
        return root

    def _resolve_node_executable(self) -> Path:
        candidates = [
            self.paths.node_dir / "node.exe",
            self.paths.node_dir / "node",
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate

        system_node = shutil.which("node")
        if system_node:
            return Path(system_node)
        raise FileNotFoundError(
            f"Bundled Node runtime not found at {self.paths.node_dir} and no system node executable is available."
        )

    def _ensure_loader_runtime(self, loader_root: Path) -> tuple[Path, list[Path]]:
        cleanup_paths: list[Path] = []
        probe_dir = self.paths.temp_dir / "write-probe"
        try:
            probe_dir.mkdir(parents=True, exist_ok=False)
            probe_dir.rmdir()
        except FileExistsError:
            pass

        if os.access(loader_root, os.W_OK):
            return loader_root, cleanup_paths

        runtime_root = self.paths.temp_dir / "loader-runtime"
        cleanup_paths.append(runtime_root / ".runtime-stamp")
        if runtime_root.exists():
            shutil.rmtree(runtime_root)

        shutil.copytree(
            loader_root,
            runtime_root,
            ignore=shutil.ignore_patterns("csv", ".git", ".github"),
        )
        self._emit(f"Bundled loader is read-only. Using runtime copy: {runtime_root}")
        return runtime_root, cleanup_paths
