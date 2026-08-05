"""Export draft-companion projection board from Sleeper values."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from src.config.env import load_dotenv
from src.export.json_writer import write_json
from src.loaders.nfl_data import load_team_bye_weeks
from src.loaders.sleeper_values import (
    build_projections_payload,
    fetch_sleeper_players_map,
    fetch_sleeper_value_rows,
    normalize_value_players,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"
DRAFT_DIR = DOCS_DATA / "draft"
MANIFEST_PATH = DOCS_DATA / "manifest.json"


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def resolve_season() -> int:
    try:
        response = httpx.get(
            "https://api.sleeper.app/v1/state/nfl",
            headers={"User-Agent": "fantasy-tool/0.1"},
            timeout=30.0,
        )
        response.raise_for_status()
        state = response.json()
        season = state.get("league_season") or state.get("season")
        if season:
            return int(season)
    except Exception:
        pass
    if MANIFEST_PATH.exists():
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        upcoming = manifest.get("upcoming_season")
        if upcoming:
            return int(upcoming)
    return datetime.now(timezone.utc).year


def write_projections(season: int) -> Path:
    print(f"  Fetching Sleeper RotoWire projections for {season}…")
    raw = fetch_sleeper_value_rows(season=season, order_by="adp_half_ppr")
    print("  Fetching Sleeper players map (depth charts)…")
    players_map = fetch_sleeper_players_map()
    players = normalize_value_players(raw, players_map=players_map)
    print(f"  Normalized {len(players)} players with projected points")
    print(f"  Loading {season} team bye weeks…")
    bye_weeks = load_team_bye_weeks(season)
    print(f"  Bye weeks for {len(bye_weeks)} teams")

    now = utc_now_iso()
    for format_key in ("half_ppr", "full_ppr", "std"):
        payload = build_projections_payload(
            season=season,
            format_key=format_key,
            players=players,
            players_map=players_map,
            bye_weeks=bye_weeks,
        )
        path = DRAFT_DIR / f"projections-{format_key.replace('_', '-')}.json"
        write_json(
            path,
            {**payload, "last_updated": now},
            {
                "season",
                "format",
                "formats",
                "source",
                "players",
                "last_updated",
            },
        )
        print(f"    wrote {path.relative_to(ROOT)} ({len(payload['players'])} players)")

    half = DRAFT_DIR / "projections-half-ppr.json"
    alias = DRAFT_DIR / "projections.json"
    alias.write_text(half.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"    wrote {alias.relative_to(ROOT)} (alias → half-ppr)")
    return alias


def main() -> None:
    load_dotenv()
    season = resolve_season()
    print(f"Draft companion data for season {season}…")
    write_projections(season)
    league = (os.environ.get("SLEEPER_LEAGUE_ID") or "").strip()
    if league:
        print(f"  SLEEPER_LEAGUE_ID configured ({league})")
    print("Done.")


if __name__ == "__main__":
    main()
