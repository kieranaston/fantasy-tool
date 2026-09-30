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
    "RB": 36,
    "WR": 36,
    "TE": 18,
    "DEF": 18,
    "K": 18,
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
    cap: bool = True,
) -> list[dict[str, Any]]:
    """Players at ``position`` from Sleeper projections.

    With ``cap``, keep the top ``limit`` by projected points. Without it,
    return every player at the position so chart scoring can choose who appears.
    """
    position = position.upper()
    if position == "DST":
        position = "DEF"
    if position == "PK":
        position = "K"
    if limit is None:
        limit = STREAMER_PROJ_LIMITS.get(position)
    if cap and (not limit or limit <= 0):
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
        if cap and limit is not None and len(out) >= limit:
            break
    return out


def rank_by_chart(
    rows: list[dict[str, Any]],
    *,
    x_key: str,
    y_key: str,
    x_sign: float = 1.0,
    y_sign: float = 1.0,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Sort by a min–max composite toward the good corner of the chart.

    Same idea as the on-page rank list: each axis is scaled to 0–1 across
    ``rows``, then signed so the favorable direction scores higher.
    """
    if not rows:
        return []
    xs = [float(row[x_key]) for row in rows]
    ys = [float(row[y_key]) for row in rows]
    x_span = (max(xs) - min(xs)) or 1.0
    y_span = (max(ys) - min(ys)) or 1.0
    x0 = min(xs)
    y0 = min(ys)
    scored: list[dict[str, Any]] = []
    for row in rows:
        copy = dict(row)
        norm_x = (float(row[x_key]) - x0) / x_span
        norm_y = (float(row[y_key]) - y0) / y_span
        copy["chart_score"] = round(x_sign * norm_x + y_sign * norm_y, 6)
        scored.append(copy)
    scored.sort(
        key=lambda row: (
            -float(row["chart_score"]),
            str(row.get("player_id") or row.get("team") or ""),
        )
    )
    if limit is not None:
        return scored[:limit]
    return scored


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
