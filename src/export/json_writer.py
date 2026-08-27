"""Write JSON artifacts for the static site and pipeline state."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def write_json(
    path: Path,
    payload: Any,
    required_keys: set[str] | None = None,
    *,
    compact: bool = True,
) -> None:
    """Write JSON to disk. If ``required_keys`` is set, payload must be a dict."""
    if required_keys:
        if not isinstance(payload, dict):
            raise TypeError(
                f"required_keys given but payload is {type(payload).__name__}"
            )
        missing = required_keys - payload.keys()
        if missing:
            raise ValueError(
                f"Missing required keys for {path.name}: {sorted(missing)}"
            )

    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(payload, separators=(",", ":"))
    else:
        text = json.dumps(payload, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")
