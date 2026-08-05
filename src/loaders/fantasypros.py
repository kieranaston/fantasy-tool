"""FantasyPros consensus projections (official public API).

Free-tier keys are capped (currently ~10 players per request), which is too
shallow for draft VORP. Prefer an HOF/production key, or use Sleeper values.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

FP_PUBLIC_BASE = "https://api.fantasypros.com/public/v2/json"
POSITIONS = ("QB", "RB", "WR", "TE")
SCORING_FIELDS = {
    "half_ppr": "points_half",
    "full_ppr": "points_ppr",
    "std": "points",
}


class FantasyProsLimitedError(RuntimeError):
    """Raised when the API key tier returns too few players for drafting."""


def _api_key() -> str:
    key = (os.environ.get("FANTASYPROS_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("FANTASYPROS_API_KEY is not set")
    return key


def fetch_position_projections(
    *,
    season: int,
    position: str,
    scoring: str = "HALF",
    week: int = 0,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Fetch draft/preseason projections for one position."""
    url = (
        f"{FP_PUBLIC_BASE}/nfl/{season}/projections"
        f"?position={position.upper()}&scoring={scoring}&week={week}"
    )
    response = httpx.get(
        url,
        headers={
            "x-api-key": _api_key(),
            "User-Agent": "fantasy-tool/0.1",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"Unexpected FantasyPros payload: {type(payload)}")
    return payload


def fetch_all_skill_projections(
    *,
    season: int,
    scoring: str = "HALF",
    week: int = 0,
    min_per_position: int = 25,
) -> list[dict[str, Any]]:
    """Fetch QB/RB/WR/TE projections; error if free-tier depth is too shallow."""
    players: list[dict[str, Any]] = []
    limited = False
    for position in POSITIONS:
        payload = fetch_position_projections(
            season=season,
            position=position,
            scoring=scoring,
            week=week,
        )
        limited = limited or bool(payload.get("public_api_limited"))
        batch = payload.get("players") or []
        if not isinstance(batch, list):
            raise RuntimeError(f"FantasyPros {position} players is not a list")
        if len(batch) < min_per_position:
            raise FantasyProsLimitedError(
                f"FantasyPros returned only {len(batch)} {position}s "
                f"(need ≥{min_per_position}). Free tier limit="
                f"{payload.get('limit')}; upgrade the API key or use Sleeper "
                "projections for Value."
            )
        for row in batch:
            if isinstance(row, dict):
                players.append(row)
    if limited:
        # Still usable if depth cleared the threshold (HOF may still flag limited).
        pass
    return players


def normalize_fp_players(
    rows: list[dict[str, Any]],
    *,
    fp_to_sleeper: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Normalize FantasyPros rows to sleeper-keyed projection records."""
    fp_to_sleeper = fp_to_sleeper or {}
    out: list[dict[str, Any]] = []
    for row in rows:
        fpid = row.get("fpid")
        if fpid is None:
            continue
        fpid_s = str(fpid)
        stats = row.get("stats") or {}
        pts: dict[str, float] = {}
        for fmt, field in SCORING_FIELDS.items():
            raw = stats.get(field)
            if raw is None:
                continue
            try:
                pts[fmt] = round(float(raw), 2)
            except (TypeError, ValueError):
                continue
        if not pts:
            continue
        sleeper_id = fp_to_sleeper.get(fpid_s)
        out.append(
            {
                "fantasypros_id": fpid_s,
                "sleeper_id": sleeper_id,
                "player": row.get("name") or fpid_s,
                "team": str(row.get("team_id") or "").upper(),
                "position": str(row.get("position_id") or "").upper(),
                "pts": pts,
                "source": "fantasypros",
            }
        )
    return out
