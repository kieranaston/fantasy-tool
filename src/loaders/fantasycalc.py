"""FantasyCalc trade values for the trade recommender.

FantasyCalc publishes crowdsourced trade values from real leagues. Unlike
FantasyPros ECR, every row carries a Sleeper id, so no name matching is needed.
Values are format-aware (dynasty/redraft, superflex, teams, PPR).
"""

from __future__ import annotations

from typing import Any

import httpx

FANTASYCALC_URL = "https://api.fantasycalc.com/values/current"

# FantasyCalc omits K/DEF; the trade model ignores them anyway.
POSITIONS = ("QB", "RB", "WR", "TE")


def fetch_fantasycalc_values(
    *,
    is_dynasty: bool = False,
    num_qbs: int = 1,
    num_teams: int = 12,
    ppr: float = 1,
    tep: str = "none",
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """Fetch current FantasyCalc value rows for one league format."""
    response = httpx.get(
        FANTASYCALC_URL,
        params={
            "isDynasty": str(bool(is_dynasty)).lower(),
            "numQbs": num_qbs,
            "numTeams": num_teams,
            "ppr": ppr,
            "tep": tep,
        },
        headers={"User-Agent": "fantasy-tool/0.1"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected FantasyCalc payload: {type(payload)}")
    return payload


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_fc_values(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Slim value rows keyed by Sleeper id (deduped, skill positions only)."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in rows:
        player = item.get("player") or {}
        sleeper_id = str(player.get("sleeperId") or "").strip()
        if not sleeper_id or sleeper_id in seen:
            continue
        position = str(player.get("position") or "").upper()
        if position not in POSITIONS:
            continue
        try:
            value = float(item.get("value"))
        except (TypeError, ValueError):
            continue
        seen.add(sleeper_id)
        out.append(
            {
                "sleeper_id": sleeper_id,
                "player": str(player.get("name") or "").strip(),
                "position": position,
                "team": str(player.get("maybeTeam") or "").upper(),
                "value": round(value, 1),
                "rank": _to_int(item.get("overallRank")),
                "pos_rank": _to_int(item.get("positionRank")),
                "tier": _to_int(item.get("maybeTier")),
            }
        )
    return out
