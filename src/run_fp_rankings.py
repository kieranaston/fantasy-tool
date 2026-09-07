"""Publish FantasyPros draft rankings matched to Sleeper ids."""

from __future__ import annotations

from pathlib import Path

from src.export.json_writer import utc_now_iso, write_json
from src.loaders.fantasypros_rankings import build_fp_rankings_payload
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

ROOT = Path(__file__).resolve().parents[1]
DRAFT_DIR = ROOT / "docs" / "data" / "draft"
RANKINGS_DIR = ROOT / "data" / "fantasypros" / "rankings"


def _find_rankings_csv() -> Path:
    preferred = RANKINGS_DIR / "FantasyPros_2026_Draft_ALL_Rankings.csv"
    if preferred.exists():
        return preferred
    matches = sorted(RANKINGS_DIR.glob("FantasyPros_*_Draft_ALL_Rankings.csv"))
    if not matches:
        raise FileNotFoundError(
            f"No FantasyPros ALL rankings CSV under {RANKINGS_DIR}"
        )
    return matches[-1]


def main() -> None:
    csv_path = _find_rankings_csv()
    season = draft_season_from_sleeper_state()
    now = utc_now_iso()
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Matching FantasyPros rankings from {csv_path.name}…")
    payload = build_fp_rankings_payload(
        csv_path,
        season=season,
        last_updated=now,
    )
    write_json(
        DRAFT_DIR / "fp-rankings.json",
        payload,
        {
            "season",
            "source",
            "file",
            "last_updated",
            "matched",
            "unmatched",
            "players",
        },
    )
    print(
        f"  matched {payload['matched']} · unmatched {len(payload['unmatched'])}"
    )
    print("  wrote docs/data/draft/fp-rankings.json")
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
