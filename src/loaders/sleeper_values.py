"""Build draft-companion value board from Sleeper season projections + ADP."""

from __future__ import annotations

from typing import Any

import httpx

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

# Inherited-role share of the depth-chart #1 projection.
INHERIT_SHARE: dict[tuple[str, str], float] = {
    ("RB", "handcuff"): 0.80,
    ("RB", "committee"): 0.50,
    ("RB", "rookie_path"): 0.70,
    ("RB", "depth"): 0.40,
    ("WR", "handcuff"): 0.55,
    ("WR", "committee"): 0.45,
    ("WR", "rookie_path"): 0.60,
    ("WR", "depth"): 0.30,
    ("TE", "handcuff"): 0.65,
    ("TE", "committee"): 0.50,
    ("TE", "rookie_path"): 0.60,
    ("TE", "depth"): 0.35,
    ("QB", "handcuff"): 0.75,
    ("QB", "committee"): 0.55,
    ("QB", "rookie_path"): 0.70,
    ("QB", "depth"): 0.40,
}

# Depth-2 with standalone pts ≥ this share of starter → committee, else handcuff.
COMMITTEE_PTS_RATIO = 0.55


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
    """Full NFL players map (depth chart + years_exp). Cached by caller if needed."""
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


def _parse_int(raw: Any) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def normalize_value_players(
    rows: list[dict[str, Any]],
    *,
    players_map: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Collapse Sleeper projection rows into draft value records."""
    best: dict[str, dict[str, Any]] = {}
    players_map = players_map or {}

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

        team = (
            item.get("team")
            or player.get("team")
            or player.get("team_abbr")
            or meta.get("team")
            or meta.get("team_abbr")
            or ""
        )
        team = str(team).upper() if team else ""

        years_exp = _parse_int(meta.get("years_exp"))
        if years_exp is None:
            years_exp = _parse_int(player.get("years_exp"))
        depth_order = _parse_int(meta.get("depth_chart_order"))
        if depth_order is None:
            depth_order = _parse_int(player.get("depth_chart_order"))

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
                "logo": None,
                "team_color": "#2563eb",
                "pts": {k: round(v, 2) for k, v in pts.items()},
                "adp": {k: round(v, 1) for k, v in adp.items()},
                "years_exp": years_exp,
                "depth_chart_order": depth_order,
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
        if years_exp is not None and existing.get("years_exp") is None:
            existing["years_exp"] = years_exp
        if depth_order is not None and existing.get("depth_chart_order") is None:
            existing["depth_chart_order"] = depth_order

    return list(best.values())


def _classify_role(
    *,
    depth_order: int | None,
    is_rookie: bool,
    pts: float,
    starter_pts: float | None,
    is_starter: bool,
) -> str:
    if is_starter:
        return "starter"
    if is_rookie and depth_order is not None and depth_order <= 2:
        return "rookie_path"
    if depth_order == 2 and starter_pts and starter_pts > 0:
        ratio = pts / starter_pts
        return "committee" if ratio >= COMMITTEE_PTS_RATIO else "handcuff"
    if depth_order is not None and depth_order >= 3:
        return "depth"
    if depth_order == 2:
        return "handcuff"
    return "depth"


def attach_role_upside(
    players: list[dict[str, Any]],
    *,
    format_key: str,
) -> list[dict[str, Any]]:
    """Assign depth role, starter link, and contingent upside_pts for one format."""
    # Group by team + position for starter lookup.
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for player in players:
        team = (player.get("team") or "").upper()
        pos = (player.get("position") or "").upper()
        if not team or pos not in POSITIONS:
            continue
        groups.setdefault((team, pos), []).append(player)

    starters: dict[tuple[str, str], dict[str, Any]] = {}
    for key, group in groups.items():
        with_depth = [p for p in group if p.get("depth_chart_order") is not None]
        if with_depth:
            starter = min(with_depth, key=lambda p: int(p["depth_chart_order"]))
        else:
            starter = max(
                group,
                key=lambda p: float((p.get("pts") or {}).get(format_key) or 0),
            )
        starters[key] = starter

    enriched: list[dict[str, Any]] = []
    for player in players:
        team = (player.get("team") or "").upper()
        pos = (player.get("position") or "").upper()
        pts = float((player.get("pts") or {}).get(format_key) or 0)
        years_exp = player.get("years_exp")
        is_rookie = years_exp == 0
        depth_order = player.get("depth_chart_order")
        key = (team, pos)
        starter = starters.get(key) if team and pos in POSITIONS else None
        is_starter = bool(
            starter and starter.get("sleeper_id") == player.get("sleeper_id")
        )
        starter_pts = None
        starter_sleeper_id = None
        starter_name = None
        if starter and not is_starter:
            starter_pts = float((starter.get("pts") or {}).get(format_key) or 0) or None
            starter_sleeper_id = starter.get("sleeper_id")
            starter_name = starter.get("player")

        role = _classify_role(
            depth_order=depth_order if isinstance(depth_order, int) else None,
            is_rookie=is_rookie,
            pts=pts,
            starter_pts=starter_pts,
            is_starter=is_starter,
        )

        if is_starter or starter_pts is None:
            upside_pts = round(pts, 2)
        else:
            share = INHERIT_SHARE.get((pos, role), 0.45)
            upside_pts = round(float(starter_pts) * share, 2)

        row = {
            **player,
            "is_rookie": is_rookie,
            "role": role,
            "starter_sleeper_id": starter_sleeper_id,
            "starter_name": starter_name,
            "starter_pts": round(starter_pts, 2) if starter_pts is not None else None,
            "upside_pts": upside_pts,
        }
        enriched.append(row)
    return enriched


def build_projections_payload(
    *,
    season: int,
    format_key: str = "half_ppr",
    players: list[dict[str, Any]] | None = None,
    players_map: dict[str, dict[str, Any]] | None = None,
    bye_weeks: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Board used by the draft companion (value + ADP + upside role)."""
    if format_key not in ("half_ppr", "full_ppr", "std"):
        raise ValueError(f"Unknown format: {format_key}")
    if players is None:
        raw = fetch_sleeper_value_rows(season=season)
        if players_map is None:
            players_map = fetch_sleeper_players_map()
        players = normalize_value_players(raw, players_map=players_map)

    bye_weeks = bye_weeks or {}
    with_roles = attach_role_upside(players, format_key=format_key)
    ranked = sorted(
        (p for p in with_roles if (p.get("pts") or {}).get(format_key) is not None),
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
                "team_color": player.get("team_color") or "#2563eb",
                "pts": round(float(pts), 2),
                "adp": round(float(adp), 1) if adp is not None else None,
                "proj_rank": index,
                "bye_week": bye,
                "years_exp": player.get("years_exp"),
                "depth_chart_order": player.get("depth_chart_order"),
                "is_rookie": bool(player.get("is_rookie")),
                "role": player.get("role") or "depth",
                "starter_sleeper_id": player.get("starter_sleeper_id"),
                "starter_name": player.get("starter_name"),
                "starter_pts": player.get("starter_pts"),
                "upside_pts": player.get("upside_pts"),
            }
        )

    return {
        "season": season,
        "format": format_key,
        "formats": ["half_ppr", "full_ppr", "std"],
        "source": "sleeper_rotowire",
        "players": out_players,
    }
