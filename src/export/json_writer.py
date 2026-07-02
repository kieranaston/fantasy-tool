"""Write validated JSON artifacts for the static site."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MANIFEST_KEYS = {"season", "week", "scoring", "last_updated"}
RANKINGS_KEYS = {"title", "columns", "rows"}
CHART_KEYS = {"title", "labels", "datasets"}


def write_json(path: Path, payload: dict[str, Any], required_keys: set[str]) -> None:
    """Write JSON to disk after validating required top-level keys."""
    missing = required_keys - payload.keys()
    if missing:
        raise ValueError(f"Missing required keys for {path.name}: {sorted(missing)}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
