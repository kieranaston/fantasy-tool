"""CLI entry point: fetch NFL data, run algorithms, export JSON for the static site."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from src.algorithms.example_ranking import build_rankings, build_trend_chart
from src.config.scoring import SCORING
from src.export.json_writer import CHART_KEYS, MANIFEST_KEYS, RANKINGS_KEYS, write_json
from src.loaders.nfl_data import get_season_and_week, load_player_weekly_stats

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"


def main() -> None:
    season, week = get_season_and_week()
    stats = load_player_weekly_stats(season)

    manifest = {
        "season": season,
        "week": week,
        "scoring": SCORING,
        "last_updated": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
    }
    rankings = build_rankings(stats, season, week)
    trend_chart = build_trend_chart(stats, season, week)

    write_json(DOCS_DATA / "manifest.json", manifest, MANIFEST_KEYS)
    write_json(DOCS_DATA / "examples" / "rankings.json", rankings, RANKINGS_KEYS)
    write_json(DOCS_DATA / "examples" / "trend-chart.json", trend_chart, CHART_KEYS)

    print(f"Exported data for {season} through week {week} to {DOCS_DATA}")


if __name__ == "__main__":
    main()
