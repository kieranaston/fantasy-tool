"""CLI entry point: fetch NFL data, run algorithms, export JSON for the static site."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from src.algorithms.rb_ranking import build_rb_rankings
from src.algorithms.wr_ranking import build_wr_rankings
from src.config.scoring import SCORING
from src.export.json_writer import MANIFEST_KEYS, write_json
from src.loaders.nfl_data import (
    get_season_and_week,
    load_player_weekly_stats,
    load_snap_counts,
    load_teams,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"


def main() -> None:
    season, week = get_season_and_week()
    stats = load_player_weekly_stats(season)
    snaps = load_snap_counts(season)
    teams = load_teams()

    manifest = {
        "season": season,
        "week": week,
        "scoring": SCORING,
        "last_updated": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
    }

    wr_rankings = build_wr_rankings(stats, teams, snaps, season, week)
    rb_rankings = build_rb_rankings(stats, teams, snaps, season, week)

    write_json(DOCS_DATA / "manifest.json", manifest, MANIFEST_KEYS)
    write_json(DOCS_DATA / "wr" / "season-composite.json", wr_rankings, {"title", "rows"})
    write_json(DOCS_DATA / "rb" / "season-composite.json", rb_rankings, {"title", "rows"})

    print(f"Exported data for {season} through week {week} to {DOCS_DATA}")


if __name__ == "__main__":
    main()
