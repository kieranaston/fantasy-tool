"""CLI entry point: refresh site manifest for the static site."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from src.export.json_writer import MANIFEST_KEYS, write_json
from src.loaders.nfl_data import get_latest_completed_season
from src.loaders.sleeper_adp import FORMATS, POSITIONS

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"


def main() -> None:
    season = get_latest_completed_season()
    if season is None:
        raise SystemExit("No completed season found.")

    upcoming_season = season + 1
    manifest = {
        "season": season,
        "upcoming_season": upcoming_season,
        "formats": list(FORMATS.keys()),
        "positions": list(POSITIONS),
        "last_updated": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
    }
    write_json(DOCS_DATA / "manifest.json", manifest, MANIFEST_KEYS)
    print(f"Updated manifest (season {season}, upcoming {upcoming_season})")


if __name__ == "__main__":
    main()
