"""Sleeper ADP from the undocumented projections endpoint.

ADP is not a projection — Sleeper attaches draft ADP fields on the same
player-season payload that also carries RotoWire projections.
"""

from __future__ import annotations

from typing import Any

import httpx

from src.injuries.match import sleeper_id_to_gsis
from src.loaders.nfl_data import load_teams

SLEEPER_ADP_URL = (
    "https://api.sleeper.com/projections/nfl/{season}"
    "?season_type=regular"
    "&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
    "&order_by={order_by}"
)

FORMATS = {
    "half_ppr": "adp_half_ppr",
    "full_ppr": "adp_ppr",
}

POSITIONS = ("QB", "RB", "WR", "TE")

# Draft-board depth by position ADP rank.
POSITION_LIMITS = {
    "QB": 25,
    "RB": 45,
    "WR": 45,
    "TE": 25,
}


def load_ranking_pool_ids(docs_data) -> set[str]:
    """Player IDs currently on any rankings ADP board (overall ∪ positions)."""
    import json
    from pathlib import Path

    root = Path(docs_data)
    ids: set[str] = set()
    for position in ("overall", *POSITIONS):
        path = root / position.lower() / "adp.json"
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        players = payload.get("players") or {}
        for rows in players.values():
            if not isinstance(rows, list):
                continue
            for row in rows:
                pid = row.get("player_id") if isinstance(row, dict) else None
                if pid:
                    ids.add(str(pid))
    return ids


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


def _team_meta() -> dict[str, dict[str, str | None]]:
    teams = load_teams()
    return {
        str(row["team_abbr"]): {
            "logo": row.get("team_logo_espn"),
            "team_color": row.get("team_color") or "#2563eb",
        }
        for row in teams.select(
            "team_abbr",
            "team_logo_espn",
            "team_color",
        ).iter_rows(named=True)
    }


def normalize_adp_players(
    rows: list[dict[str, Any]],
    *,
    sleeper_to_gsis: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Collapse projection rows to one player record with ADP by format."""
    if sleeper_to_gsis is None:
        sleeper_to_gsis = sleeper_id_to_gsis()
    logos = _team_meta()

    best: dict[str, dict[str, Any]] = {}
    for item in rows:
        sleeper_id = str(item.get("player_id") or "").strip()
        if not sleeper_id:
            continue
        player = item.get("player") or {}
        position = (player.get("position") or item.get("position") or "").upper()
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

        gsis = sleeper_to_gsis.get(sleeper_id)
        player_id = gsis or f"sleeper:{sleeper_id}"
        team = (item.get("team") or player.get("team") or player.get("team_abbr") or "")
        team = str(team).upper() if team else ""
        meta = logos.get(team, {"logo": None, "team_color": "#2563eb"})

        existing = best.get(player_id)
        if existing is None:
            best[player_id] = {
                "player_id": player_id,
                "sleeper_id": sleeper_id,
                "player": _display_name(player, sleeper_id),
                "team": team,
                "position": position,
                "logo": meta["logo"],
                "team_color": meta["team_color"],
                "adp": adp_values,
            }
            continue

        # Keep the lowest ADP seen per format (dedupe weekly rows).
        for format_key, value in adp_values.items():
            prev = existing["adp"].get(format_key)
            if prev is None or value < prev:
                existing["adp"][format_key] = value
        if not existing.get("team") and team:
            existing["team"] = team
            existing["logo"] = meta["logo"]
            existing["team_color"] = meta["team_color"]

    return list(best.values())


def _ranked_for_format(
    players: list[dict[str, Any]],
    *,
    format_key: str,
    position: str | None = None,
    limit: int,
) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for player in players:
        if position and player["position"] != position:
            continue
        adp = (player.get("adp") or {}).get(format_key)
        if adp is None:
            continue
        filtered.append(player)

    filtered.sort(key=lambda row: (row["adp"][format_key], row["player"]))
    out: list[dict[str, Any]] = []
    for index, player in enumerate(filtered[:limit], start=1):
        out.append(
            {
                "player_id": player["player_id"],
                "sleeper_id": player["sleeper_id"],
                "player": player["player"],
                "team": player["team"],
                "position": player["position"],
                "logo": player.get("logo"),
                "team_color": player.get("team_color") or "#2563eb",
                "adp": round(float(player["adp"][format_key]), 1),
                "adp_rank": index,
            }
        )
    return out


def _position_pool_ids(
    players: list[dict[str, Any]],
    *,
    format_key: str,
) -> set[str]:
    """Player IDs in the per-position ADP caps for this scoring format."""
    allowed: set[str] = set()
    for position, limit in POSITION_LIMITS.items():
        ranked = _ranked_for_format(
            players,
            format_key=format_key,
            position=position,
            limit=limit,
        )
        for row in ranked:
            if row.get("player_id"):
                allowed.add(row["player_id"])
    return allowed


def build_adp_payload(
    *,
    season: int,
    position: str,
    players: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build ADP JSON for OVERALL or a single position.

    OVERALL is the union of the position pools (QB/TE top 25, RB/WR top 45),
    ordered by overall ADP for each format.
    """
    position = position.upper()
    if players is None:
        raw = fetch_sleeper_projections(season=season, order_by="adp_ppr")
        players = normalize_adp_players(raw)

    by_format: dict[str, list[dict[str, Any]]] = {}
    for format_key in FORMATS:
        if position == "OVERALL":
            pool_ids = _position_pool_ids(players, format_key=format_key)
            pool_players = [p for p in players if p.get("player_id") in pool_ids]
            by_format[format_key] = _ranked_for_format(
                pool_players,
                format_key=format_key,
                position=None,
                limit=len(pool_players),
            )
        else:
            limit = POSITION_LIMITS.get(position)
            if limit is None:
                raise ValueError(f"Unknown position: {position}")
            by_format[format_key] = _ranked_for_format(
                players,
                format_key=format_key,
                position=position,
                limit=limit,
            )

    return {
        "season": season,
        "position": position,
        "formats": list(FORMATS.keys()),
        "source": "sleeper",
        "players": by_format,
    }


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
