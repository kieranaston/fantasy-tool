"""Build a slim name → team/headshot lookup for the static site."""

from __future__ import annotations

import re
from typing import Any

from src.export.json_writer import utc_now_iso
from src.injuries.match import load_player_tables

_SKILL_POSITIONS = {"QB", "RB", "WR", "TE", "K", "PK", "DEF", "DST", "FB", "HB"}
_SUFFIX_RE = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def norm_name(name: str | None) -> str:
    return re.sub(r"\s+", " ", str(name or "").lower().replace(".", "")).strip()


def _name_keys(full_name: str) -> list[str]:
    """Full name plus suffix-stripped alias (RotoWire often drops Jr/III)."""
    base = norm_name(full_name)
    if not base:
        return []
    keys = [base]
    stripped = _SUFFIX_RE.sub("", base)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    if stripped and stripped not in keys:
        keys.append(stripped)
    return keys


def _skill_position(position: str | None) -> str | None:
    pos = str(position or "").upper()
    if pos == "PK":
        return "K"
    if pos == "DST":
        return "DEF"
    return pos if pos in _SKILL_POSITIONS else None


def build_player_lookup(*, season: int | None = None) -> dict[str, Any]:
    """Name-keyed team/headshot rows from nflverse rosters (same index as matching)."""
    tables = load_player_tables(season=season)
    by_gsis = tables.media.get("by_gsis_id") or {}
    players: dict[str, dict[str, str]] = {}

    for ref in tables.index:
        media_row = by_gsis.get(ref.player_id) or {}
        pos = _skill_position(ref.position or media_row.get("position"))
        if not pos:
            continue
        team = ref.team or media_row.get("team")
        row: dict[str, str] = {}
        if team:
            row["team"] = str(team).upper()
        headshot = media_row.get("headshot")
        if headshot:
            row["headshot"] = str(headshot)
        if not row:
            continue
        for key in _name_keys(ref.name):
            players.setdefault(key, row)

    return {
        "last_updated": utc_now_iso(),
        "players": players,
    }
