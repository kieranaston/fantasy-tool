"""Fetch Sleeper ADP and seed personal ranking order files."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.export.json_writer import write_json
from src.loaders.sleeper_adp import (
    FORMATS,
    POSITIONS,
    build_adp_payload,
    draft_season_from_sleeper_state,
    fetch_sleeper_projections,
    normalize_adp_players,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"
MANIFEST_PATH = DOCS_DATA / "manifest.json"

BOARD_POSITIONS = ("OVERALL", *POSITIONS)


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


def resolve_season() -> int:
    """Prefer Sleeper league season; fall back to manifest upcoming_season."""
    try:
        return draft_season_from_sleeper_state()
    except Exception:
        pass
    if MANIFEST_PATH.exists():
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        upcoming = manifest.get("upcoming_season")
        if upcoming:
            return int(upcoming)
        if manifest.get("season"):
            return int(manifest["season"]) + 1
    return datetime.now(timezone.utc).year


def _data_dir(position: str) -> Path:
    return DOCS_DATA / position.lower()


def _orders_from_adp(payload: dict[str, Any]) -> dict[str, list[str]]:
    orders: dict[str, list[str]] = {}
    for format_key in FORMATS:
        rows = payload.get("players", {}).get(format_key) or []
        orders[format_key] = [row["player_id"] for row in rows if row.get("player_id")]
    return orders


def seed_my_rankings(
    payloads: dict[str, dict[str, Any]],
    *,
    force: bool = False,
) -> list[Path]:
    """Create my-rankings.json from ADP order when missing (or forced)."""
    written: list[Path] = []
    now = utc_now_iso()
    for position, payload in payloads.items():
        path = _data_dir(position) / "my-rankings.json"
        if path.exists() and not force:
            continue
        orders = _orders_from_adp(payload)
        body = {
            "position": position.upper(),
            "formats": list(FORMATS.keys()),
            "orders": orders,
            "tier_breaks": {fmt: [] for fmt in FORMATS},
            "updated_at": now,
            "seed": "sleeper_adp",
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
        written.append(path)
        print(f"  Seeded {path.relative_to(ROOT)}")
    return written


def write_adp(season: int) -> dict[str, dict[str, Any]]:
    print(f"  Fetching Sleeper projections/ADP for {season}…")
    raw = fetch_sleeper_projections(season=season, order_by="adp_ppr")
    players = normalize_adp_players(raw)
    print(f"  Normalized {len(players)} players with ADP")

    payloads: dict[str, dict[str, Any]] = {}
    now = utc_now_iso()
    for position in BOARD_POSITIONS:
        payload = build_adp_payload(
            season=season,
            position=position,
            players=players,
        )
        path = _data_dir(position) / "adp.json"
        write_json(
            path,
            {
                **payload,
                "last_updated": now,
            },
            {"season", "position", "formats", "source", "players", "last_updated"},
        )
        counts = {
            fmt: len(payload["players"].get(fmt) or [])
            for fmt in FORMATS
        }
        print(f"    wrote {path.relative_to(ROOT)} {counts}")
        payloads[position] = payload
    return payloads


def main() -> None:
    _load_dotenv()
    season = resolve_season()
    print(f"Sleeper ADP season {season}…")
    payloads = write_adp(season)
    seeded = seed_my_rankings(payloads, force=False)
    if not seeded:
        print("  my-rankings.json files already present (not overwritten)")
    print("Done.")


if __name__ == "__main__":
    main()
