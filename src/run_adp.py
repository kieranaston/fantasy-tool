"""Refresh Sleeper ADP daily."""

from __future__ import annotations

from pathlib import Path

from src.export.json_writer import utc_now_iso, write_json
from src.loaders.nfl_data import load_team_bye_weeks
from src.loaders.sleeper_adp import (
    FORMATS,
    adp_board_for_format,
    draft_season_from_sleeper_state,
    fetch_sleeper_projections,
    normalize_adp_slim,
)

ROOT = Path(__file__).resolve().parents[1]
DRAFT_DIR = ROOT / "docs" / "data" / "draft"


def main() -> None:
    season = draft_season_from_sleeper_state()
    now = utc_now_iso()
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Refreshing Sleeper ADP for {season}…")
    raw = fetch_sleeper_projections(season=season, order_by="adp_half_ppr")
    players = normalize_adp_slim(raw)
    print(f"  {len(players)} players with ADP")

    try:
        byes = load_team_bye_weeks(season)
    except Exception as err:  # noqa: BLE001 — bye is optional enrichment
        print(f"  bye weeks unavailable ({err}); continuing without")
        byes = {}

    for format_key in FORMATS:
        board = adp_board_for_format(players, format_key=format_key, byes=byes)
        path = DRAFT_DIR / f"adp-{format_key.replace('_', '-')}.json"
        write_json(
            path,
            {
                "season": season,
                "format": format_key,
                "source": "sleeper_adp",
                "last_updated": now,
                "players": board,
            },
            {"season", "format", "source", "last_updated", "players"},
        )
        print(f"  wrote {path.relative_to(ROOT)} ({len(board)} players)")

    print("Done.")


if __name__ == "__main__":
    main()
