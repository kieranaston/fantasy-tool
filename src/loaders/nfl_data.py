"""Thin wrappers around nflreadpy."""

from __future__ import annotations

from typing import Any

import nflreadpy as nfl
import polars as pl

# nflverse and Sleeper disagree on some abbreviations — notably nflverse calls
# the Rams "LA" while Sleeper calls them "LAR", which silently dropped every
# Rams bye week. Historical relocations are included so old seasons resolve too.
TEAM_ABBR_ALIASES: dict[str, tuple[str, ...]] = {
    "LA": ("LAR",),
    "LAR": ("LA",),
    "STL": ("LA", "LAR"),
    "OAK": ("LV",),
    "SD": ("LAC",),
    "WSH": ("WAS",),
    "JAC": ("JAX",),
}


def get_current_season() -> int:
    """Return the NFL season year nflverse considers current."""
    return int(nfl.get_current_season())


def _roster_seasons(preferred: int | None) -> list[int]:
    current = get_current_season()
    seasons: list[int] = []
    for season in (preferred, current, current - 1, current + 1):
        if season is None:
            continue
        s = int(season)
        if s not in seasons and s >= 1999:
            seasons.append(s)
    return seasons


def player_media_index(
    *,
    season: int | None = None,
) -> dict[str, dict[str, dict[str, Any]]]:
    """Name / team / position lookups keyed by sleeper_id and gsis_id.

    Tries preferred season first, then nearby seasons, keeping the first hit.
    """
    by_sleeper: dict[str, dict[str, Any]] = {}
    by_gsis: dict[str, dict[str, Any]] = {}

    for season_year in _roster_seasons(season):
        try:
            rosters = nfl.load_rosters(seasons=season_year)
        except Exception:
            continue
        if rosters.is_empty():
            continue
        cols = [
            c
            for c in (
                "full_name",
                "team",
                "sleeper_id",
                "gsis_id",
                "position",
            )
            if c in rosters.columns
        ]
        for row in rosters.select(cols).iter_rows(named=True):
            team = str(row.get("team") or "").upper() or None
            payload = {
                "team": team,
                "player": row.get("full_name"),
                "position": row.get("position"),
            }
            sleeper_id = row.get("sleeper_id")
            if sleeper_id is not None and str(sleeper_id).strip():
                sid = str(sleeper_id).strip()
                existing = by_sleeper.get(sid)
                if existing is None:
                    by_sleeper[sid] = payload
                elif team and not existing.get("team"):
                    existing["team"] = team
            gsis_id = row.get("gsis_id")
            if gsis_id is not None and str(gsis_id).strip():
                gid = str(gsis_id).strip()
                existing = by_gsis.get(gid)
                if existing is None:
                    by_gsis[gid] = payload
                elif team and not existing.get("team"):
                    existing["team"] = team

    return {"by_sleeper_id": by_sleeper, "by_gsis_id": by_gsis}


def load_team_bye_weeks(season: int) -> dict[str, int]:
    """Map team abbreviation → bye week for a regular season.

    Derived from nflverse schedules: the unique week in 1–18 with no game.
    Keys are emitted under both the nflverse and Sleeper spellings so callers
    can look up by either.
    """
    schedules = nfl.load_schedules([season]).filter(pl.col("game_type") == "REG")
    if schedules.is_empty():
        return {}
    teams = set(schedules["home_team"].to_list()) | set(
        schedules["away_team"].to_list()
    )
    byes: dict[str, int] = {}
    for team in teams:
        played = set(
            schedules.filter(
                (pl.col("home_team") == team) | (pl.col("away_team") == team)
            )["week"].to_list()
        )
        missing = sorted(set(range(1, 19)) - played)
        if len(missing) == 1:
            key = str(team).upper()
            byes[key] = int(missing[0])
            for alias in TEAM_ABBR_ALIASES.get(key, ()):
                byes[alias] = int(missing[0])
    return byes
