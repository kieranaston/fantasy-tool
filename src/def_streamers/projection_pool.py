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
    "RB": 32,
    "WR": 32,
    "TE": 18,
    "DEF": 18,
    "K": 18,
}

# Composite axis weights for the skill charts (QB/RB/WR/TE). Usage (xFP/G) is
# far more predictive of next-week scoring than the efficiency residual
# (FPOE/G), which mean-reverts, so the usage axis carries most of the weight.
# From src/analysis/chart_weight_backtest.py and chart_param_sweep.py
# (2021-2024 train / 2025 holdout): FPOE alone scores ~0.05-0.10, xFP alone
# ~0.30-0.58, and the 0.8-1.0 weight plateau is flat, peaking near 0.9.
SKILL_CHART_X_WEIGHT = 0.9
SKILL_CHART_Y_WEIGHT = 0.1

# DEF board: x = projected sack rate, y = opponent implied total (lower better).
# The backtest shows the opponent implied total carries almost all the signal
# (rho ~0.36 vs ~0.14 for sack rate), so the total is weighted heavily.
DEF_CHART_X_WEIGHT = 0.2
DEF_CHART_Y_WEIGHT = 0.8

# K board: x = team implied total, y = team FG attempts per game. Again the
# Vegas total dominates (rho ~0.18 vs ~0.03 for FG rate).
K_CHART_X_WEIGHT = 0.8
K_CHART_Y_WEIGHT = 0.2

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


def percentile_ranks(values: list[float]) -> list[float]:
    """Average-rank percentile in 0–1 (higher value → higher rank, ties share).

    Used instead of min–max so a single 3-game outlier can't compress every
    other player toward zero.
    """
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [0.5]
    order = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        pr = ((i + j) / 2.0) / (n - 1)
        for k in range(i, j + 1):
            ranks[order[k]] = pr
        i = j + 1
    return ranks


def composite_scores(
    xs: list[float],
    ys: list[float],
    *,
    x_sign: float = 1.0,
    y_sign: float = 1.0,
    x_weight: float = 1.0,
    y_weight: float = 1.0,
) -> list[float]:
    """Weighted percentile composite toward the good corner of the chart (0–1).

    Each axis is ranked to a percentile, flipped so the favorable direction is
    high, then blended with ``x_weight``/``y_weight`` (normalised to sum to 1).
    """
    n = len(xs)
    if n == 0:
        return []
    total = (abs(x_weight) + abs(y_weight)) or 1.0
    wx = abs(x_weight) / total
    wy = abs(y_weight) / total
    px = percentile_ranks(xs)
    py = percentile_ranks(ys)
    out: list[float] = []
    for i in range(n):
        gx = px[i] if x_sign >= 0 else 1.0 - px[i]
        gy = py[i] if y_sign >= 0 else 1.0 - py[i]
        out.append(round(wx * gx + wy * gy, 6))
    return out


def rank_by_chart(
    rows: list[dict[str, Any]],
    *,
    x_key: str,
    y_key: str,
    x_sign: float = 1.0,
    y_sign: float = 1.0,
    x_weight: float = 1.0,
    y_weight: float = 1.0,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Sort by a weighted percentile composite toward the good corner.

    The stored ``chart_score`` is the single source of truth for both board
    inclusion and the on-page rank list, so the two can never disagree.
    """
    if not rows:
        return []
    xs = [float(row[x_key]) for row in rows]
    ys = [float(row[y_key]) for row in rows]
    scores = composite_scores(
        xs,
        ys,
        x_sign=x_sign,
        y_sign=y_sign,
        x_weight=x_weight,
        y_weight=y_weight,
    )
    scored: list[dict[str, Any]] = []
    for row, score in zip(rows, scores):
        copy = dict(row)
        copy["chart_score"] = score
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
