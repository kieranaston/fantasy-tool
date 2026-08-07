"""Build draft-companion value board from Sleeper season projections + ADP."""

from __future__ import annotations

from typing import Any

import httpx

from src.loaders.nfl_data import (
    DEFAULT_TEAM_COLOR,
    attach_team_branding,
    player_media_index,
    team_branding,
)

POSITIONS = ("QB", "RB", "WR", "TE")
ADP_SENTINEL = 900.0
SLEEPER_PROJ_URL = (
    "https://api.sleeper.com/projections/nfl/{season}"
    "?season_type=regular"
    "&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
    "&order_by={order_by}"
)
SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"
PTS_FIELDS = {
    "half_ppr": "pts_half_ppr",
    "full_ppr": "pts_ppr",
    "std": "pts_std",
}

ADP_FIELDS = {
    "half_ppr": "adp_half_ppr",
    "full_ppr": "adp_ppr",
    "std": "adp_std",
}


def fetch_sleeper_value_rows(
    *,
    season: int,
    order_by: str = "adp_half_ppr",
    timeout: float = 60.0,
) -> list[dict[str, Any]]:
    url = SLEEPER_PROJ_URL.format(season=season, order_by=order_by)
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


def fetch_sleeper_players_map(*, timeout: float = 120.0) -> dict[str, dict[str, Any]]:
    """Full NFL players map (names/teams). Cached by caller if needed."""
    response = httpx.get(
        SLEEPER_PLAYERS_URL,
        headers={"User-Agent": "fantasy-tool/0.1"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"Unexpected Sleeper players payload: {type(payload)}")
    return payload


def _display_name(player: dict[str, Any], sleeper_id: str) -> str:
    full = (player.get("full_name") or "").strip()
    if full:
        return full
    first = (player.get("first_name") or "").strip()
    last = (player.get("last_name") or "").strip()
    name = f"{first} {last}".strip()
    return name or sleeper_id


def normalize_value_players(
    rows: list[dict[str, Any]],
    *,
    players_map: dict[str, dict[str, Any]] | None = None,
    season: int | None = None,
) -> list[dict[str, Any]]:
    """Collapse Sleeper projection rows into draft value records."""
    best: dict[str, dict[str, Any]] = {}
    players_map = players_map or {}
    branding = team_branding()
    media = player_media_index(season=season)
    by_sleeper = media["by_sleeper_id"]

    for item in rows:
        sleeper_id = str(item.get("player_id") or "").strip()
        if not sleeper_id:
            continue
        player = item.get("player") or {}
        meta = players_map.get(sleeper_id) or {}
        position = (
            player.get("position")
            or meta.get("position")
            or item.get("position")
            or ""
        ).upper()
        if position not in POSITIONS:
            continue

        stats = item.get("stats") or {}
        pts: dict[str, float] = {}
        adp: dict[str, float] = {}
        for fmt, field in PTS_FIELDS.items():
            raw = stats.get(field)
            if raw is None:
                continue
            try:
                pts[fmt] = float(raw)
            except (TypeError, ValueError):
                continue
        for fmt, field in ADP_FIELDS.items():
            raw = stats.get(field)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value >= ADP_SENTINEL:
                continue
            adp[fmt] = value
        if not pts:
            continue

        media_row = by_sleeper.get(sleeper_id) or {}
        team = (
            item.get("team")
            or player.get("team")
            or player.get("team_abbr")
            or meta.get("team")
            or meta.get("team_abbr")
            or media_row.get("team")
            or ""
        )
        team = str(team).upper() if team else ""
        brand = attach_team_branding(team, branding)

        existing = best.get(sleeper_id)
        if existing is None:
            best[sleeper_id] = {
                "player_id": f"sleeper:{sleeper_id}",
                "sleeper_id": sleeper_id,
                "player": _display_name(
                    {**player, **{k: v for k, v in meta.items() if v}},
                    sleeper_id,
                ),
                "team": team,
                "position": position,
                "logo": brand["logo"],
                "headshot": media_row.get("headshot"),
                "team_color": brand["team_color"] or DEFAULT_TEAM_COLOR,
                "pts": {k: round(v, 2) for k, v in pts.items()},
                "adp": {k: round(v, 1) for k, v in adp.items()},
                "source": "sleeper_rotowire",
            }
            continue

        for fmt, value in pts.items():
            prev = existing["pts"].get(fmt)
            if prev is None or value > prev:
                existing["pts"][fmt] = round(value, 2)
        for fmt, value in adp.items():
            prev = existing["adp"].get(fmt)
            if prev is None or value < prev:
                existing["adp"][fmt] = round(value, 1)
        if team and not existing.get("team"):
            existing["team"] = team
            existing["logo"] = brand["logo"]
            existing["team_color"] = brand["team_color"] or DEFAULT_TEAM_COLOR
        if not existing.get("headshot") and media_row.get("headshot"):
            existing["headshot"] = media_row.get("headshot")

    return list(best.values())


def build_projections_payload(
    *,
    season: int,
    format_key: str = "half_ppr",
    players: list[dict[str, Any]] | None = None,
    players_map: dict[str, dict[str, Any]] | None = None,
    bye_weeks: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Board used by the draft companion (projected pts + ADP)."""
    if format_key not in ("half_ppr", "full_ppr", "std"):
        raise ValueError(f"Unknown format: {format_key}")
    if players is None:
        raw = fetch_sleeper_value_rows(season=season)
        if players_map is None:
            players_map = fetch_sleeper_players_map()
        players = normalize_value_players(
            raw, players_map=players_map, season=season
        )

    bye_weeks = bye_weeks or {}
    ranked = sorted(
        (p for p in players if (p.get("pts") or {}).get(format_key) is not None),
        key=lambda p: (-float(p["pts"][format_key]), p["player"]),
    )
    out_players: list[dict[str, Any]] = []
    for index, player in enumerate(ranked, start=1):
        pts = player["pts"].get(format_key)
        adp = (player.get("adp") or {}).get(format_key)
        team = (player.get("team") or "").upper()
        bye = bye_weeks.get(team)
        out_players.append(
            {
                "player_id": player["player_id"],
                "sleeper_id": player["sleeper_id"],
                "player": player["player"],
                "team": player["team"],
                "position": player["position"],
                "logo": player.get("logo"),
                "headshot": player.get("headshot"),
                "team_color": player.get("team_color") or "#2563eb",
                "pts": round(float(pts), 2),
                "adp": round(float(adp), 1) if adp is not None else None,
                "proj_rank": index,
                "bye_week": bye,
            }
        )

    return {
        "season": season,
        "format": format_key,
        "formats": ["half_ppr", "full_ppr", "std"],
        "source": "sleeper_rotowire",
        "players": out_players,
    }
