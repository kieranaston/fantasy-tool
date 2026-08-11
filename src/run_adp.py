"""Refresh Sleeper ADP daily — independent of FantasyPros projection rebuilds."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from src.export.json_writer import write_json
from src.loaders.sleeper_adp import (
    FORMATS,
    adp_board_for_format,
    adp_by_sleeper_id,
    draft_season_from_sleeper_state,
    fetch_sleeper_projections,
    normalize_adp_slim,
)

ROOT = Path(__file__).resolve().parents[1]
DRAFT_DIR = ROOT / "docs" / "data" / "draft"


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _sleeper_id(player: dict) -> str:
    return (
        str(player.get("sleeper_id") or player.get("player_id") or "")
        .replace("sleeper:", "")
        .strip()
    )


def patch_board_adp(path: Path, adp_map: dict[str, float], *, now: str) -> int:
    """Overwrite ``adp`` on an existing projection board. Returns rows updated."""
    if not path.exists():
        return 0
    data = json.loads(path.read_text(encoding="utf-8"))
    players = data.get("players") or []
    updated = 0
    for player in players:
        sid = _sleeper_id(player)
        if not sid or sid not in adp_map:
            continue
        new_adp = adp_map[sid]
        if player.get("adp") != new_adp:
            updated += 1
        player["adp"] = new_adp
    data["adp_updated"] = now
    # Preserve existing schema; only require keys already on the board.
    required = set(data.keys())
    write_json(path, data, required)
    return updated


def main() -> None:
    season = draft_season_from_sleeper_state()
    now = utc_now_iso()
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Refreshing Sleeper ADP for {season}…")
    raw = fetch_sleeper_projections(season=season, order_by="adp_half_ppr")
    players = normalize_adp_slim(raw)
    print(f"  {len(players)} players with ADP")

    for format_key in FORMATS:
        board = adp_board_for_format(players, format_key=format_key)
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

        adp_map = adp_by_sleeper_id(players, format_key=format_key)
        proj_name = f"projections-{format_key.replace('_', '-')}.json"
        n = patch_board_adp(DRAFT_DIR / proj_name, adp_map, now=now)
        if n or (DRAFT_DIR / proj_name).exists():
            print(f"  patched ADP on {proj_name} ({n} changed)")

    # Custom FantasyPros board keeps FP pts; overlay still uses adp-*.json,
    # but keep baked ADP fresh for any fallback readers.
    custom = DRAFT_DIR / "projections-custom.json"
    if custom.exists():
        # Prefer half-PPR ADP as the baked default on custom boards.
        half_map = adp_by_sleeper_id(players, format_key="half_ppr")
        n = patch_board_adp(custom, half_map, now=now)
        print(f"  patched ADP on projections-custom.json ({n} changed)")

    print("Done.")


if __name__ == "__main__":
    main()
