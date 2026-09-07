"""Publish FantasyPros draft rankings matched to Sleeper ids."""

from __future__ import annotations

from pathlib import Path

from src.export.json_writer import utc_now_iso, write_json
from src.loaders.fantasypros_rankings import build_fp_rankings_payload
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

ROOT = Path(__file__).resolve().parents[1]
DRAFT_DIR = ROOT / "docs" / "data" / "draft"
RANKINGS_DIR = ROOT / "data" / "fantasypros" / "rankings"

# Local CSV → published JSON used by the draft Sort dropdown.
RANKING_SOURCES = (
    {
        "csv": "FantasyPros_2026_Draft_ALL_Rankings.csv",
        "out": "fp-rankings.json",
        "label": "FantasyPros ECR",
    },
    {
        "csv": "FantasyPros_2026_Draft_ALL_Rankings_hayden_josh.csv",
        "out": "winks-rankings.json",
        "label": "Winks",
    },
)


def _publish_one(csv_path: Path, out_name: str, *, season: int, now: str) -> None:
    print(f"Matching {csv_path.name} → {out_name}…")
    payload = build_fp_rankings_payload(
        csv_path,
        season=season,
        last_updated=now,
    )
    write_json(
        DRAFT_DIR / out_name,
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
    print(f"  wrote docs/data/draft/{out_name}")
    if payload["unmatched"][:8]:
        print("  sample unmatched:")
        for row in payload["unmatched"][:8]:
            print(
                f"    #{row.get('rank')} {row.get('player')} "
                f"({row.get('team')}/{row.get('position')})"
            )


def main() -> None:
    season = draft_season_from_sleeper_state()
    now = utc_now_iso()
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)

    published = 0
    for src in RANKING_SOURCES:
        csv_path = RANKINGS_DIR / src["csv"]
        if not csv_path.exists():
            print(f"  skip {src['label']}: missing {csv_path.name}")
            continue
        _publish_one(csv_path, src["out"], season=season, now=now)
        published += 1

    if published == 0:
        raise FileNotFoundError(
            f"No FantasyPros rankings CSVs found under {RANKINGS_DIR}"
        )
    print("Done.")


if __name__ == "__main__":
    main()
