"""Append-only JSON storage for injury reports and derived status."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SOURCE_BEAT_REPORTER = "beat_reporter"

RAW_REPORT_KEYS = {
    "id",
    "player_id",
    "player_name",
    "timestamp",
    "designation",
    "source_text",
    "url",
    "source_type",
    "needs_review",
}

DEFAULT_POLL_STATE: dict[str, Any] = {
    "last_bluesky_at": None,
    "last_run_at": None,
}


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def new_report_id() -> str:
    return str(uuid.uuid4())


def existing_urls(reports: list[dict[str, Any]]) -> set[str]:
    return {r["url"] for r in reports if r.get("url")}


def append_reports(
    path: Path,
    existing: list[dict[str, Any]],
    new_reports: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Append new reports, skipping duplicate URLs. Returns the full list."""
    seen = existing_urls(existing)
    appended: list[dict[str, Any]] = []
    for report in new_reports:
        url = report.get("url")
        if url and url in seen:
            continue
        if "id" not in report:
            report["id"] = new_report_id()
        missing = RAW_REPORT_KEYS - report.keys()
        if missing:
            raise ValueError(f"Raw report missing keys: {sorted(missing)}")
        existing.append(report)
        if url:
            seen.add(url)
        appended.append(report)
    if appended:
        write_json(path, existing)
    return existing


def load_poll_state(path: Path) -> dict[str, Any]:
    state = load_json(path, dict(DEFAULT_POLL_STATE))
    for key, value in DEFAULT_POLL_STATE.items():
        state.setdefault(key, value)
    return state


REVIEW_QUEUE_MAX = 50


def append_review_items(
    path: Path,
    items: list[dict[str, Any]],
) -> None:
    """Append review items, keeping only the newest REVIEW_QUEUE_MAX entries."""
    if not items:
        return
    queue = load_json(path, [])
    if not isinstance(queue, list):
        queue = []
    queue.extend(items)
    if len(queue) > REVIEW_QUEUE_MAX:
        queue = queue[-REVIEW_QUEUE_MAX:]
    write_json(path, queue)
