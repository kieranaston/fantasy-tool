"""Sleeper projected-points pools for streamer chart inclusion."""

from __future__ import annotations

import re
from typing import Any

from src.loaders.sleeper_adp import (
    PTS_FORMATS,
    _display_name,
    draft_season_from_sleeper_state,
    fetch_sleeper_projections,
)

# Chart inclusion caps by Sleeper half-PPR projected points.
STREAMER_PROJ_LIMITS = {
    "QB": 18,
    "RB": 30,
    "WR": 30,
    "TE": 18,
    "DEF": 14,
    "K": 14,
}

# Sleeper / ESPN / nflverse team code aliases → nflverse schedule codes.
_TEAM_ALIASES = {
    "LAR": "LA",
    "WSH": "WAS",
    "JAC": "JAX",
}

_NAME_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\.?\s*$", re.IGNORECASE)
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def canonical_team(team: str | None) -> str:
    """Normalize team abbreviations to nflverse schedule codes."""
    raw = str(team or "").strip().upper()
    if not raw:
        return ""
    return _TEAM_ALIASES.get(raw, raw)


def norm_player_name(name: str | None) -> str:
    """Lowercase alphanumeric name key (drops Jr/III-style suffixes)."""
    cleaned = _NAME_SUFFIX.sub("", str(name or "").strip()).strip()
    return _NON_ALNUM.sub("", cleaned.lower())


def _last_name(full_name: str) -> str:
    parts = [p for p in full_name.replace(".", " ").split() if p]
    skip = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}
    while len(parts) > 1 and parts[-1].lower().rstrip(".") in skip:
        parts.pop()
    return parts[-1] if parts else full_name


def top_projected_players(
    position: str,
    *,
    limit: int | None = None,
    season: int | None = None,
    format_key: str = "half_ppr",
    rows: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Top-N players at ``position`` by Sleeper projected points (desc)."""
    position = position.upper()
    if position == "DST":
        position = "DEF"
    if position == "PK":
        position = "K"
    if limit is None:
        limit = STREAMER_PROJ_LIMITS.get(position)
    if not limit or limit <= 0:
        raise ValueError(f"No streamer projection limit for {position}")

    pts_field = PTS_FORMATS.get(format_key)
    if not pts_field:
        raise ValueError(f"Unknown scoring format: {format_key}")

    if season is None:
        season = draft_season_from_sleeper_state()
    if rows is None:
        rows = fetch_sleeper_projections(season=season, order_by=pts_field)

    ranked: list[dict[str, Any]] = []
    for item in rows:
        player = item.get("player") or {}
        pos = (player.get("position") or item.get("position") or "").upper()
        if pos == "DST":
            pos = "DEF"
        if pos == "PK":
            pos = "K"
        if pos != position:
            continue
        sleeper_id = str(item.get("player_id") or "").strip()
        if not sleeper_id:
            continue
        stats = item.get("stats") or {}
        raw_pts = stats.get(pts_field)
        try:
            pts = float(raw_pts)
        except (TypeError, ValueError):
            continue
        if pts <= 0:
            continue
        name = _display_name(player, sleeper_id)
        team = canonical_team(item.get("team") or player.get("team") or player.get("team_abbr"))
        ranked.append(
            {
                "sleeper_id": sleeper_id,
                "player": name,
                "last_name": _last_name(name),
                "team": team,
                "position": position,
                "pts": round(pts, 1),
            }
        )

    ranked.sort(key=lambda r: (-r["pts"], r["player"]))
    # Dedupe by sleeper id, keeping highest pts.
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in ranked:
        sid = row["sleeper_id"]
        if sid in seen:
            continue
        seen.add(sid)
        out.append(row)
        if len(out) >= limit:
            break
    return out


def match_stats_for_projected(
    projected: list[dict[str, Any]],
    stat_rows: list[dict[str, Any]],
    *,
    name_key: str = "player_name",
    team_key: str = "team",
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Pair projected players to stat rows (projection order).

    Prefers same canonical team when multiple name matches exist.
    """
    by_name: dict[str, list[dict[str, Any]]] = {}
    for row in stat_rows:
        key = norm_player_name(row.get(name_key))
        if not key:
            continue
        by_name.setdefault(key, []).append(row)

    paired: list[tuple[dict[str, Any], dict[str, Any]]] = []
    used_ids: set[str] = set()
    for proj in projected:
        key = norm_player_name(proj.get("player"))
        candidates = [
            c
            for c in by_name.get(key, [])
            if str(c.get("player_id") or "") not in used_ids
        ]
        if not candidates:
            continue
        proj_team = canonical_team(proj.get("team"))
        team_hits = [
            c
            for c in candidates
            if proj_team and canonical_team(c.get(team_key)) == proj_team
        ]
        pick = team_hits[0] if team_hits else candidates[0]
        used_ids.add(str(pick.get("player_id") or ""))
        paired.append((proj, pick))
    return paired
