"""Sleeper NFL players index for name matching and team lookup."""

from __future__ import annotations

from typing import Any

import httpx

SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"


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
