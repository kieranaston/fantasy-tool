"""Refresh Sleeper ADP daily."""

from __future__ import annotations

from pathlib import Path

from src.export.json_writer import utc_now_iso, write_json
from src.loaders.sleeper_adp import (
    adp_merged_board,
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

    merged = adp_merged_board(players)
    write_json(
        DRAFT_DIR / "adp-board.json",
        {
            "season": season,
            "source": "sleeper_adp",
            "last_updated": now,
            "players": merged,
        },
        {"season", "source", "last_updated", "players"},
    )
    print(f"  wrote docs/data/draft/adp-board.json ({len(merged)} players)")

    print("Done.")


if __name__ == "__main__":
    main()
