from __future__ import annotations

from datetime import datetime
from pathlib import Path
import traceback


class RunLogger:
    def __init__(self, logs_dir: Path) -> None:
        logs_dir.mkdir(parents=True, exist_ok=True)
        self.path = logs_dir / f"tsf-export-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"

    def log(self, message: str) -> None:
        line = f"[{datetime.now().isoformat(timespec='seconds')}] {message.strip()}\n"
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(line)

    def exception(self, exc: Exception) -> None:
        self.log(f"ERROR: {exc}")
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(traceback.format_exc())
            handle.write("\n")
