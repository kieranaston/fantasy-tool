"""Sleeper ADP helpers used to scope player-news to a draft-relevant pool.

ADP is not a projection — Sleeper attaches draft ADP fields on the same
player-season payload that also carries RotoWire projections.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx

from src.config.scoring import FORMATS as FORMAT_KEYS
from src.config.scoring import SKILL_POSITIONS

SLEEPER_ADP_URL = (
    "https://api.sleeper.com/projections/nfl/{season}"
    "?season_type=regular"
    "&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
    "&position[]=DEF&position[]=K"
    "&order_by={order_by}"
)

FORMATS = {
    "half_ppr": "adp_half_ppr",
    "full_ppr": "adp_ppr",
    "std": "adp_std",
}

POSITIONS = SKILL_POSITIONS

# News-pool depth by position ADP rank.
POSITION_LIMITS = {
    "QB": 25,
    "RB": 45,
    "WR": 45,
    "TE": 25,
    "DEF": 32,
    "K": 32,
}

# Sleeper uses ~999 as a sentinel for "no ADP".
ADP_SENTINEL = 900.0


def fetch_sleeper_projections(
    *,
    season: int,
    order_by: str = "adp_ppr",
    timeout: float = 60.0,
) -> list[dict[str, Any]]:
    """Fetch season projection rows (includes ADP fields) for skill positions."""
    url = SLEEPER_ADP_URL.format(season=season, order_by=order_by)
    response = httpx.get(
        url,
        headers={"User-Agent": "fantasy-tool/0.1"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected Sleeper projections payload: {type(payload)}")
    return payload


def _display_name(player: dict[str, Any], sleeper_id: str) -> str:
    full = (player.get("full_name") or "").strip()
    if full:
        return full
    first = (player.get("first_name") or "").strip()
    last = (player.get("last_name") or "").strip()
    name = f"{first} {last}".strip()
    return name or sleeper_id


def draft_season_from_sleeper_state() -> int:
    """Read current fantasy season from Sleeper state (fallback: calendar)."""
    response = httpx.get(
        "https://api.sleeper.app/v1/state/nfl",
        headers={"User-Agent": "fantasy-tool/0.1"},
        timeout=30.0,
    )
    response.raise_for_status()
    state = response.json()
    season = state.get("league_season") or state.get("season")
    return int(season)


def normalize_adp_slim(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """ADP-only records from Sleeper projection rows (no nflverse / media)."""
    best: dict[str, dict[str, Any]] = {}
    for item in rows:
        sleeper_id = str(item.get("player_id") or "").strip()
        if not sleeper_id:
            continue
        player = item.get("player") or {}
        position = (player.get("position") or item.get("position") or "").upper()
        if position == "DST":
            position = "DEF"
        if position == "PK":
            position = "K"
        if position not in POSITIONS:
            continue

        stats = item.get("stats") or {}
        adp_values: dict[str, float] = {}
        for format_key, field in FORMATS.items():
            raw = stats.get(field)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value >= ADP_SENTINEL:
                continue
            adp_values[format_key] = value
        if not adp_values:
            continue

        team = (item.get("team") or player.get("team") or player.get("team_abbr") or "")
        team = str(team).upper() if team else ""
        existing = best.get(sleeper_id)
        if existing is None:
            best[sleeper_id] = {
                "sleeper_id": sleeper_id,
                "player": _display_name(player, sleeper_id),
                "team": team,
                "position": position,
                "adp": adp_values,
            }
            continue

        for format_key, value in adp_values.items():
            prev = existing["adp"].get(format_key)
            if prev is None or value < prev:
                existing["adp"][format_key] = value
        if not existing.get("team") and team:
            existing["team"] = team

    return list(best.values())


def adp_board_for_format(
    players: list[dict[str, Any]],
    *,
    format_key: str,
    byes: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    """Slim public ADP rows for one scoring format."""
    bye_map = byes or {}
    out: list[dict[str, Any]] = []
    for player in players:
        adp = (player.get("adp") or {}).get(format_key)
        if adp is None:
            continue
        team = player.get("team") or ""
        row: dict[str, Any] = {
            "sleeper_id": player["sleeper_id"],
            "player": player["player"],
            "team": team,
            "position": player["position"],
            "adp": round(float(adp), 1),
        }
        bye = bye_map.get(str(team).upper()) if team else None
        if bye is not None:
            row["bye_week"] = int(bye)
        out.append(row)
    out.sort(key=lambda row: (row["adp"], row["player"]))
    return out


def _default_adp_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "docs" / "data" / "draft"


def _load_published_boards(adp_dir: Path) -> dict[str, list[dict[str, Any]]] | None:
    boards: dict[str, list[dict[str, Any]]] = {}
    for format_key in FORMAT_KEYS:
        path = adp_dir / f"adp-{format_key.replace('_', '-')}.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        players = payload.get("players") if isinstance(payload, dict) else None
        if not isinstance(players, list):
            return None
        boards[format_key] = players
    return boards


def _position_pool_ids_from_board(
    players: list[dict[str, Any]],
    sleeper_to_gsis: dict[str, str],
) -> set[str]:
    """Player IDs in the per-position ADP caps (board is already ADP-sorted)."""
    allowed: set[str] = set()
    taken = {pos: 0 for pos in POSITION_LIMITS}
    for row in players:
        position = row.get("position")
        limit = POSITION_LIMITS.get(position) if position else None
        if limit is None or taken[position] >= limit:
            continue
        taken[position] += 1
        sid = str(row.get("sleeper_id") or "").strip()
        if not sid:
            continue
        allowed.add(sleeper_to_gsis.get(sid) or f"sleeper:{sid}")
    return allowed


def load_news_pool_ids(
    *,
    season: int | None = None,
    sleeper_to_gsis: dict[str, str] | None = None,
    adp_dir: Path | None = None,
) -> set[str]:
    """Player IDs in the ADP depth caps (overall union of position pools)."""
    if sleeper_to_gsis is None:
        from src.injuries.match import sleeper_id_to_gsis

        sleeper_to_gsis = sleeper_id_to_gsis()

    boards = _load_published_boards(adp_dir or _default_adp_dir())
    if boards is None:
        if season is None:
            season = draft_season_from_sleeper_state()
        raw = fetch_sleeper_projections(season=season, order_by="adp_ppr")
        slim = normalize_adp_slim(raw)
        boards = {
            format_key: adp_board_for_format(slim, format_key=format_key)
            for format_key in FORMAT_KEYS
        }

    ids: set[str] = set()
    for players in boards.values():
        ids |= _position_pool_ids_from_board(players, sleeper_to_gsis)
    return ids
