"""Publish in-season FantasyPros ECR for the trade recommender.

Drop the weekly FantasyPros in-season rankings CSV into
``data/fantasypros/rankings/`` and run this to emit
``docs/data/trade/ecr.json`` (players matched to Sleeper ids, with
overall rank, positional rank, and tier).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from src.export.json_writer import utc_now_iso, write_json
from src.loaders.fantasypros_rankings import build_fp_rankings_payload
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

ROOT = Path(__file__).resolve().parents[1]
TRADE_DIR = ROOT / "docs" / "data" / "trade"
RANKINGS_DIR = ROOT / "data" / "fantasypros" / "rankings"

# Weekly in-season ECR export; pass a filename over it if it differs.
DEFAULT_CSV = "FantasyPros_2026_Season_ALL_Rankings.csv"
OUT_NAME = "ecr.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "csv",
        nargs="?",
        default=DEFAULT_CSV,
        help=f"CSV filename under {RANKINGS_DIR}",
    )
    args = parser.parse_args()

    csv_path = RANKINGS_DIR / args.csv
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Missing {csv_path}. Drop the FantasyPros ranking export here first."
        )

    season = draft_season_from_sleeper_state()
    now = utc_now_iso()
    TRADE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Matching {csv_path.name} → {OUT_NAME}…")
    payload = build_fp_rankings_payload(
        csv_path,
        season=season,
        last_updated=now,
        include_pos_rank=True,
        source="fantasypros_ecr",
    )
    write_json(
        TRADE_DIR / OUT_NAME,
        payload,
        {"season", "source", "file", "last_updated", "matched", "unmatched", "players"},
    )
    print(f"  matched {payload['matched']} · unmatched {len(payload['unmatched'])}")
    print(f"  wrote docs/data/trade/{OUT_NAME}")
    if payload["unmatched"][:8]:
        print("  sample unmatched:")
        for row in payload["unmatched"][:8]:
            print(
                f"    #{row.get('rank')} {row.get('player')} "
                f"({row.get('team')}/{row.get('position')})"
            )
    print("Done.")


if __name__ == "__main__":
    main()
