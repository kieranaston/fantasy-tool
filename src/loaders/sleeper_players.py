"""Sleeper NFL players index for name matching and team lookup."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"

# Minimum rapidfuzz token_set_ratio to accept an automatic match.
MATCH_THRESHOLD = 88.0


@dataclass(frozen=True)
class PlayerRef:
    player_id: str
    name: str
    team: str | None = None
    position: str | None = None


@dataclass(frozen=True)
class PlayerTables:
    index: list[PlayerRef]
    by_name: dict[str, PlayerRef]
    by_id: dict[str, PlayerRef]


def display_name(player: dict[str, Any]) -> str:
    first = str(player.get("first_name") or "").strip()
    last = str(player.get("last_name") or "").strip()
    full = f"{first} {last}".strip()
    if full:
        return full
    return str(player.get("full_name") or player.get("search_full_name") or "").strip()


def fetch_sleeper_players(*, timeout: float = 90.0) -> dict[str, dict[str, Any]]:
    """Full Sleeper player id → metadata map."""
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


def _normalize_position(raw: str | None) -> str | None:
    pos = str(raw or "").upper()
    if pos == "DST":
        return "DEF"
    if pos == "PK":
        return "K"
    return pos or None


def load_player_tables() -> PlayerTables:
    """Build a name index from Sleeper's NFL players dump."""
    players = fetch_sleeper_players()
    refs: list[PlayerRef] = []
    by_name: dict[str, PlayerRef] = {}
    by_id: dict[str, PlayerRef] = {}

    for sleeper_id, row in players.items():
        if not isinstance(row, dict):
            continue
        name = display_name(row)
        if not name:
            continue
        sid = str(sleeper_id).strip()
        team = str(row.get("team") or "").strip().upper() or None
        ref = PlayerRef(
            player_id=sid,
            name=name,
            team=team,
            position=_normalize_position(row.get("position")),
        )
        refs.append(ref)
        by_name[name] = ref
        by_id[sid] = ref

    return PlayerTables(index=refs, by_name=by_name, by_id=by_id)
