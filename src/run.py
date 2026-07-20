"""CLI entry point: fetch NFL data, run algorithms, export JSON for the static site."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from src.algorithms.qb_score import build_qb_rankings
from src.algorithms.rb_score import build_rb_rankings
from src.algorithms.te_score import build_te_rankings
from src.algorithms.wr_score import build_wr_rankings
from src.config.scoring import FORMATS
from src.export.json_writer import MANIFEST_KEYS, RANKINGS_KEYS, write_json
from src.loaders.nfl_data import (
    get_latest_completed_season,
    load_player_season_stats,
    load_pfr_rush_yac,
    load_route_counts,
    load_team_season_stats,
    load_teams,
    load_upcoming_roster_teams,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"


def main() -> None:
    season = get_latest_completed_season()
    if season is None:
        raise SystemExit("No completed season found to rank.")

    teams = load_teams()
    upcoming_teams, upcoming_season = load_upcoming_roster_teams(season)
    print(f"Building rankings from {season}…")
    if upcoming_season:
        print(f"  Offseason roster overlay: {upcoming_season} ({len(upcoming_teams)} players)")

    season_stats = load_player_season_stats(season)
    team_stats = load_team_season_stats(season)
    rush_yac = load_pfr_rush_yac(season)
    routes = load_route_counts(season)

    team_kwargs = {
        "upcoming_teams": upcoming_teams,
        "upcoming_season": upcoming_season,
    }
    payloads = {
        "qb": build_qb_rankings(season_stats, teams, season, **team_kwargs),
        "rb": build_rb_rankings(season_stats, team_stats, rush_yac, teams, season, **team_kwargs),
        "wr": build_wr_rankings(season_stats, team_stats, routes, teams, season, **team_kwargs),
        "te": build_te_rankings(season_stats, team_stats, teams, season, **team_kwargs),
    }

    manifest = {
        "season": season,
        "upcoming_season": upcoming_season,
        "formats": list(FORMATS),
        "positions": ["QB", "RB", "WR", "TE"],
        "last_updated": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
    }
    write_json(DOCS_DATA / "manifest.json", manifest, MANIFEST_KEYS)

    for position, payload in payloads.items():
        changed = sum(1 for row in payload["rows"] if row.get("new_team"))
        write_json(DOCS_DATA / position / "rankings.json", payload, RANKINGS_KEYS)
        print(f"  {position.upper()}: {len(payload['rows'])} players ({changed} team changes)")

    print(f"Exported preseason composites for {season} to {DOCS_DATA}")


if __name__ == "__main__":
    main()
