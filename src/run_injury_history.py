"""Build comprehensive season injury-history JSON for the ranking pool."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from src.export.json_writer import write_json
from src.injuries.history import aggregate_injury_history, load_ranking_pool
from src.loaders.nfl_data import get_latest_completed_season

ROOT = Path(__file__).resolve().parents[1]
DOCS_DATA = ROOT / "docs" / "data"
HISTORY_PATH = DOCS_DATA / "injuries" / "history.json"

HISTORY_KEYS = {
    "season",
    "title",
    "last_updated",
    "player_count",
    "players",
}


def _load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(
            key.strip(),
            value.strip().strip("'").strip('"'),
        )


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def build_history_payload(*, season: int) -> dict:
    pool = load_ranking_pool(DOCS_DATA)
    print(f"  Ranking pool: {len(pool)} players")
    records = aggregate_injury_history(season=season, pool=pool)
    print(f"  With availability history: {len(records)}")

    public_players = []
    for r in records:
        public_players.append({
            "player_id": r["player_id"],
            "player_name": r["player_name"],
            "position": r["position"],
            "team": r["team"],
            "logo": r.get("logo"),
            "games_played": r["games_played"],
            "team_games": r.get("team_games"),
            "bye_weeks": r.get("bye_weeks") or [],
            "missed_weeks": r.get("missed_weeks") or [],
            "ir_weeks": r.get("ir_weeks") or [],
            "inactive_weeks": r.get("inactive_weeks") or [],
            "out_weeks": r.get("out_weeks") or [],
            "doubtful_weeks": r.get("doubtful_weeks") or [],
            "primary_injuries": r.get("primary_injuries") or [],
            "roster_spans": r.get("roster_spans") or [],
            "injury_spans": r.get("injury_spans") or [],
            "label": r["label"],
            "overview": r.get("overview") or r.get("summary") or "",
            "summary": r.get("summary") or r.get("overview") or "",
            "weeks": r.get("weeks") or [],
        })

    return {
        "season": season,
        "title": f"Season Injury History — {season}",
        "last_updated": utc_now_iso(),
        "player_count": len(public_players),
        "players": public_players,
    }


def export_injury_history(*, season: int | None = None, enhance: bool = False) -> Path:
    """Write history.json. ``enhance`` kept for CLI compat; unused (structured overview)."""
    del enhance  # structured overview replaces Gemini one-liners
    _load_dotenv()
    if season is None:
        season = get_latest_completed_season()
    if season is None:
        raise SystemExit("No completed season found for injury history.")

    print(f"Building {season} injury history…")
    payload = build_history_payload(season=season)
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    write_json(HISTORY_PATH, payload, HISTORY_KEYS)
    print(f"  Wrote {HISTORY_PATH.relative_to(ROOT)} ({payload['player_count']} players)")
    return HISTORY_PATH


def main() -> None:
    export_injury_history()


if __name__ == "__main__":
    main()
