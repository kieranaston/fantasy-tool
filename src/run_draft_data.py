"""Export draft-companion projection boards (Sleeper + FantasyPros custom)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from src.config.env import load_dotenv
from src.export.json_writer import write_json
from src.loaders.fantasypros_board import build_custom_projections_board
from src.loaders.fantasypros_csv import available_positions, projections_dir
from src.loaders.nfl_data import load_team_bye_weeks
from src.loaders.sleeper_draft import fetch_league
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
    print("  Fetching Sleeper players map…")
    players_map = fetch_sleeper_players_map()
    players = normalize_value_players(
        raw, players_map=players_map, season=season
    )
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


def write_league_settings(league_id: str | None = None) -> tuple[Path | None, dict | None]:
    """Export league settings for the draft companion. Returns (path, payload)."""
    league_id = (league_id or os.environ.get("SLEEPER_LEAGUE_ID") or "").strip()
    if not league_id:
        print("  SLEEPER_LEAGUE_ID not set — skipping league.json")
        return None, None

    print(f"  Fetching Sleeper league {league_id}…")
    league = fetch_league(league_id)
    now = utc_now_iso()
    payload = {
        "league_id": str(league.get("league_id") or league_id),
        "name": league.get("name"),
        "season": league.get("season"),
        "status": league.get("status"),
        "sport": league.get("sport"),
        "total_rosters": league.get("total_rosters"),
        "draft_id": league.get("draft_id"),
        "roster_positions": league.get("roster_positions") or [],
        "scoring_settings": league.get("scoring_settings") or {},
        "settings": league.get("settings") or {},
        "source": "sleeper_league",
        "last_updated": now,
    }
    path = DRAFT_DIR / "league.json"
    write_json(
        path,
        payload,
        {
            "league_id",
            "name",
            "season",
            "status",
            "total_rosters",
            "roster_positions",
            "scoring_settings",
            "settings",
            "source",
            "last_updated",
        },
    )
    rec = (payload["scoring_settings"] or {}).get("rec")
    print(
        f"    wrote {path.relative_to(ROOT)} "
        f"({payload['name']}, rec={rec}, "
        f"{len(payload['scoring_settings'])} scoring keys)"
    )
    return path, payload


def write_custom_projections(
    season: int,
    *,
    league: dict | None = None,
    league_id: str | None = None,
) -> Path | None:
    """Score FantasyPros CSVs with league settings → projections-custom.json."""
    positions = available_positions(season)
    if not positions:
        print(
            f"  No FantasyPros CSVs in {projections_dir(season).relative_to(ROOT)} "
            "— skipping custom board"
        )
        return None

    if league is None:
        _, league = write_league_settings(league_id)
    if league is None:
        print("  No league settings available — skipping custom board")
        return None

    print(
        f"  Building FantasyPros custom board for {league.get('name')} "
        f"({', '.join(positions)} CSVs)…"
    )
    print("  Fetching Sleeper players map for name matching…")
    players_map = fetch_sleeper_players_map()
    bye_weeks = load_team_bye_weeks(season)
    board = build_custom_projections_board(
        season=season,
        league=league,
        players_map=players_map,
        bye_weeks=bye_weeks,
        include_adp=True,
    )
    now = utc_now_iso()
    # Keep unmatched out of the published companion payload (still logged).
    unmatched = board.pop("unmatched", [])
    board.pop("unmatched_count", None)
    path = DRAFT_DIR / "projections-custom.json"
    write_json(
        path,
        {**board, "last_updated": now},
        {
            "season",
            "format",
            "formats",
            "source",
            "league_id",
            "scoring_settings",
            "players",
            "last_updated",
        },
    )
    print(
        f"    wrote {path.relative_to(ROOT)} "
        f"({board['matched_count']} matched, {len(unmatched)} unmatched)"
    )
    if unmatched[:8]:
        sample = ", ".join(
            f"{u['player']} ({u['position']})" for u in unmatched[:8]
        )
        print(f"    unmatched sample: {sample}")
    return path


def main() -> None:
    load_dotenv()
    season = resolve_season()
    print(f"Draft companion data for season {season}…")
    write_projections(season)
    _, league = write_league_settings()
    write_custom_projections(season, league=league)
    print("Done.")


if __name__ == "__main__":
    main()
