from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import sys


@dataclass(frozen=True)
class AppPaths:
    root_dir: Path
    vendor_dir: Path
    loader_dir: Path
    node_dir: Path
    config_dir: Path
    runtime_root: Path
    logs_dir: Path
    temp_dir: Path
    output_dir: Path


def _default_runtime_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "TSFExporter"
    return Path.home() / ".tsf-exporter"


def resolve_app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def resolve_app_paths() -> AppPaths:
    root_dir = resolve_app_root()
    runtime_root = _default_runtime_root()
    return AppPaths(
        root_dir=root_dir,
        vendor_dir=root_dir / "vendor",
        loader_dir=root_dir / "vendor" / "tally-loader",
        node_dir=root_dir / "vendor" / "node",
        config_dir=root_dir / "config",
        runtime_root=runtime_root,
        logs_dir=runtime_root / "logs",
        temp_dir=runtime_root / "temp",
        output_dir=runtime_root / "output",
    )


def ensure_runtime_directories(paths: AppPaths) -> None:
    for folder in (paths.runtime_root, paths.logs_dir, paths.temp_dir, paths.output_dir):
        folder.mkdir(parents=True, exist_ok=True)
