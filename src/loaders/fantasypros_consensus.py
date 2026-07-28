"""FantasyPros expert consensus (ECR) draft rankings."""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

from src.injuries.match import fantasypros_id_to_gsis, load_player_index, match_player_name

FP_CONSENSUS_URL = (
    "https://api.fantasypros.com/public/v2/json/nfl/{season}/consensus-rankings"
)

# Our format keys → FantasyPros scoring query values
SCORING_MAP = {
    "half_ppr": "HALF",
    "full_ppr": "PPR",
}

POSITIONS = ("QB", "RB", "WR", "TE")


def fantasypros_available() -> bool:
    return bool(os.environ.get("FANTASYPROS_API_KEY"))


def fetch_consensus(
    *,
    season: int,
    position: str,
    scoring: str,
    retries: int = 4,
) -> list[dict[str, Any]]:
    """Fetch ECR for one position/scoring. ``scoring`` is HALF or PPR."""
    api_key = os.environ.get("FANTASYPROS_API_KEY")
    if not api_key:
        raise RuntimeError("FANTASYPROS_API_KEY is not set")

    url = FP_CONSENSUS_URL.format(season=season)
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = httpx.get(
                url,
                params={
                    "position": position.upper(),
                    "scoring": scoring.upper(),
                    "type": "draft",
                    "week": 0,
                },
                headers={"x-api-key": api_key},
                timeout=45.0,
            )
            if response.status_code == 403:
                raise RuntimeError(
                    "FantasyPros consensus returned 403 Forbidden. "
                    "Confirm FANTASYPROS_API_KEY is active."
                )
            if response.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            response.raise_for_status()
            payload = response.json()
            return list(payload.get("players") or [])
        except Exception as exc:
            last_error = exc
            if attempt == retries - 1:
                break
            time.sleep(2 ** attempt)
    assert last_error is not None
    raise last_error


def normalize_consensus_players(
    players: list[dict[str, Any]],
    *,
    fp_to_gsis: dict[str, str] | None = None,
    player_index: list | None = None,
) -> list[dict[str, Any]]:
    """Map FP consensus rows to GSIS ids with ECR."""
    if fp_to_gsis is None:
        fp_to_gsis = fantasypros_id_to_gsis()
    if player_index is None:
        player_index = load_player_index()

    out: list[dict[str, Any]] = []
    for item in players:
        fpid = item.get("player_id") or item.get("fpid")
        name = (
            item.get("player_name")
            or item.get("player")
            or ""
        ).strip()
        ecr = item.get("rank_ecr")
        if ecr is None:
            continue
        try:
            ecr_int = int(ecr)
        except (TypeError, ValueError):
            continue

        player_id: str | None = None
        if fpid is not None and str(fpid) in fp_to_gsis:
            player_id = fp_to_gsis[str(fpid)]
        else:
            match = match_player_name(name, player_index)
            if not match.needs_review:
                player_id = match.player_id
                name = match.matched_name or name

        if not player_id:
            continue

        out.append(
            {
                "player_id": player_id,
                "player": name,
                "ecr": ecr_int,
                "pos_rank": item.get("pos_rank") or "",
            }
        )
    return out


def build_position_consensus(
    *,
    season: int,
    position: str,
) -> dict[str, Any]:
    """Build consensus.json payload for one position (half_ppr + full_ppr)."""
    fp_to_gsis = fantasypros_id_to_gsis()
    player_index = load_player_index()
    by_format: dict[str, list[dict[str, Any]]] = {}

    for format_key, scoring in SCORING_MAP.items():
        raw = fetch_consensus(
            season=season,
            position=position,
            scoring=scoring,
        )
        by_format[format_key] = normalize_consensus_players(
            raw,
            fp_to_gsis=fp_to_gsis,
            player_index=player_index,
        )
        time.sleep(1.0)

    return {
        "season": season,
        "position": position.upper(),
        "formats": list(SCORING_MAP.keys()),
        "players": by_format,
    }
