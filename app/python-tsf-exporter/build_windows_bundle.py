from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "dist"
BUILD_DIR = ROOT / "build"
VENDOR_DIR = ROOT / "vendor"
CONFIG_DIR = ROOT / "config"


def require_path(path: Path, label: str) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {label}: {path}")


def main() -> int:
    require_path(VENDOR_DIR / "tally-loader", "bundled loader folder")
    require_path(CONFIG_DIR, "config folder")

    pyinstaller_args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--windowed",
        "--name",
        "TSF Exporter",
        "--paths",
        str(ROOT),
        str(ROOT / "main.py"),
    ]

    subprocess.run(pyinstaller_args, cwd=ROOT, check=True)

    app_dir = DIST_DIR / "TSF Exporter"
    if not app_dir.exists():
        raise SystemExit(f"PyInstaller output not found: {app_dir}")

    for sidecar in ("vendor", "config"):
        src = ROOT / sidecar
        dst = app_dir / sidecar
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)

    readme_src = ROOT / "README.md"
    if readme_src.exists():
        shutil.copy2(readme_src, app_dir / "README_staff.md")

    print(f"Bundle created at: {app_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
