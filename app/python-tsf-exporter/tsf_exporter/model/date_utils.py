from __future__ import annotations

from datetime import date


def parse_ddmmyyyy(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    day, month, year = raw.split("/")
    parsed = date(int(year), int(month), int(day))
    return parsed.isoformat()


def iso_to_ddmmyyyy(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    year, month, day = raw.split("-")
    return f"{day}/{month}/{year}"


def to_loader_cli_date(value: str) -> str:
    return value.replace("-", "")
