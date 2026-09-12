"""Sleeper ADP helpers.

ADP is not a projection — Sleeper attaches draft ADP fields on the same
player-season payload that also carries RotoWire projections.
"""

from __future__ import annotations

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

PTS_FORMATS = {
    "half_ppr": "pts_half_ppr",
    "full_ppr": "pts_ppr",
    "std": "pts_std",
}

POSITIONS = SKILL_POSITIONS

# Published draft/ADP board depth: top overall OR enough per position so
# late DEF/K still appear for search and position tabs.
ADP_BOARD_OVERALL = 280
ADP_BOARD_POS_LIMITS = {
    "QB": 32,
    "RB": 72,
    "WR": 72,
    "TE": 28,
    "DEF": 24,
    "K": 24,
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

        pts_values: dict[str, float] = {}
        for format_key, field in PTS_FORMATS.items():
            raw = stats.get(field)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value > 0:
                pts_values[format_key] = round(value, 1)

        if not adp_values:
            continue

        team = (item.get("team") or player.get("team") or player.get("team_abbr") or "")
        team = str(team).upper() if team else ""
        existing = best.get(sleeper_id)
        if existing is None:
            row: dict[str, Any] = {
                "sleeper_id": sleeper_id,
                "player": _display_name(player, sleeper_id),
                "team": team,
                "position": position,
                "adp": adp_values,
            }
            if pts_values:
                row["pts"] = pts_values
            best[sleeper_id] = row
            continue

        for format_key, value in adp_values.items():
            prev = existing["adp"].get(format_key)
            if prev is None or value < prev:
                existing["adp"][format_key] = value
        for format_key, value in pts_values.items():
            prev = (existing.get("pts") or {}).get(format_key)
            if prev is None or value > prev:
                existing.setdefault("pts", {})[format_key] = value
        if not existing.get("team") and team:
            existing["team"] = team

    return list(best.values())


def adp_board_for_format(
    players: list[dict[str, Any]],
    *,
    format_key: str,
) -> list[dict[str, Any]]:
    """Slim public ADP rows for one scoring format."""
    ranked: list[dict[str, Any]] = []
    for player in players:
        adp = (player.get("adp") or {}).get(format_key)
        if adp is None:
            continue
        row: dict[str, Any] = {
            "sleeper_id": player["sleeper_id"],
            "player": player["player"],
            "team": player.get("team") or "",
            "position": player["position"],
            "adp": round(float(adp), 1),
        }
        pts_map = player.get("pts") or {}
        pts = pts_map.get(format_key)
        if pts is not None:
            row["pts"] = round(float(pts), 1)
        ranked.append(row)

    ranked.sort(key=lambda row: (row["adp"], row["player"]))

    kept: list[dict[str, Any]] = []
    seen: set[str] = set()
    pos_counts = {pos: 0 for pos in ADP_BOARD_POS_LIMITS}
    for index, row in enumerate(ranked):
        sid = str(row["sleeper_id"])
        if sid in seen:
            continue
        pos = row.get("position")
        pos_limit = ADP_BOARD_POS_LIMITS.get(pos)
        keep = index < ADP_BOARD_OVERALL or (
            pos_limit is not None and pos_counts.get(pos, 0) < pos_limit
        )
        if not keep:
            continue
        seen.add(sid)
        if pos in pos_counts:
            pos_counts[pos] += 1
        kept.append(row)
    return kept


def adp_merged_board(
    players: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """One row per player with all format ADPs."""
    half = adp_board_for_format(players, format_key="half_ppr")
    by_id = {str(p["sleeper_id"]): p for p in players}
    merged: list[dict[str, Any]] = []
    for row in half:
        sid = str(row["sleeper_id"])
        src = by_id.get(sid) or {}
        adp_values = src.get("adp") or {}
        adp_out: dict[str, float] = {}
        for format_key in FORMAT_KEYS:
            raw = adp_values.get(format_key)
            if raw is None:
                continue
            adp_out[format_key] = round(float(raw), 1)
        if not adp_out:
            continue
        out: dict[str, Any] = {
            "sleeper_id": sid,
            "player": row["player"],
            "team": row.get("team") or "",
            "position": row["position"],
            "adp": adp_out,
        }
        pts_map = src.get("pts") or {}
        if pts_map:
            pts_out: dict[str, float] = {}
            for format_key in FORMAT_KEYS:
                raw = pts_map.get(format_key)
                if raw is None:
                    continue
                pts_out[format_key] = round(float(raw), 1)
            if pts_out:
                out["pts"] = pts_out
        merged.append(out)
    return merged
