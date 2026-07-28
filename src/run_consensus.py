"""Fetch FantasyPros ECR consensus and seed personal draft order files."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.export.json_writer import write_json
from src.loaders.fantasypros_consensus import (
    POSITIONS,
    SCORING_MAP,
    build_position_consensus,
    fantasypros_available,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"
MANIFEST_PATH = DOCS_DATA / "manifest.json"

DRAFT_FORMATS = list(SCORING_MAP.keys())


def _load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(
            key.strip(),
            value.strip().strip("'").strip('"'),
        )


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def draft_season() -> int:
    """Season year for draft ECR (prefer upcoming_season from manifest)."""
    if MANIFEST_PATH.exists():
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        upcoming = manifest.get("upcoming_season")
        if upcoming:
            return int(upcoming)
        if manifest.get("season"):
            return int(manifest["season"]) + 1
    return datetime.now(timezone.utc).year


def _order_from_rankings(position: str, format_key: str) -> list[str]:
    path = DOCS_DATA / position.lower() / "rankings.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = list(payload.get("rows") or [])

    def score(row: dict[str, Any]) -> float:
        scores = row.get("scores") or {}
        if format_key in scores:
            return float(scores[format_key])
        if "default" in scores:
            return float(scores["default"])
        # Fallback any score
        if scores:
            return float(next(iter(scores.values())))
        return 0.0

    rows.sort(key=score, reverse=True)
    return [r["player_id"] for r in rows if r.get("player_id")]


def seed_draft_rankings(*, force: bool = False) -> list[Path]:
    """Create draft-rankings.json from composite order when missing (or forced)."""
    written: list[Path] = []
    now = utc_now_iso()
    for position in POSITIONS:
        path = DOCS_DATA / position.lower() / "draft-rankings.json"
        if path.exists() and not force:
            continue
        orders = {
            fmt: _order_from_rankings(position, fmt) for fmt in DRAFT_FORMATS
        }
        payload = {
            "position": position.upper(),
            "formats": list(DRAFT_FORMATS),
            "orders": orders,
            "updated_at": now,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        written.append(path)
        print(f"  Seeded {path.relative_to(ROOT)}")
    return written


def write_consensus(season: int) -> list[Path]:
    written: list[Path] = []
    for position in POSITIONS:
        print(f"  {position}…")
        payload = build_position_consensus(season=season, position=position)
        path = DOCS_DATA / position.lower() / "consensus.json"
        write_json(
            path,
            {
                **payload,
                "last_updated": utc_now_iso(),
            },
            {"season", "position", "formats", "players", "last_updated"},
        )
        counts = {
            fmt: len(payload["players"].get(fmt) or [])
            for fmt in DRAFT_FORMATS
        }
        print(f"    wrote {path.relative_to(ROOT)} {counts}")
        written.append(path)
        time.sleep(1.5)
    return written


def main() -> None:
    _load_dotenv()
    season = draft_season()
    print(f"Draft consensus season {season}…")

    seeded = seed_draft_rankings(force=False)
    if not seeded:
        print("  Draft order files already present (not overwritten)")

    if not fantasypros_available():
        print("  FantasyPros: skipped (FANTASYPROS_API_KEY not set)")
        return

    write_consensus(season)
    print("Done.")


if __name__ == "__main__":
    main()
