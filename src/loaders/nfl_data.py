"""Thin wrappers around nflreadpy."""

from __future__ import annotations

import nflreadpy as nfl
import polars as pl

from src.config.scoring import MIN_REG_WEEKS


def get_current_season() -> int:
    """Return the NFL season year nflverse considers current."""
    return int(nfl.get_current_season())


def get_latest_completed_season() -> int | None:
    """Return the most recent completed REG season, or None if none found."""
    current = get_current_season()
    for season in range(current, current - 5, -1):
        if season < 1999:
            break
        if _is_completed_season(season, current):
            return season
    return None


def _is_completed_season(season: int, current_season: int) -> bool:
    if season < current_season:
        return True
    stats = load_player_weekly_stats(season)
    week = _latest_regular_season_week(stats, season)
    return week >= MIN_REG_WEEKS


def load_player_weekly_stats(season: int) -> pl.DataFrame:
    """Load weekly player stats for a single season."""
    return nfl.load_player_stats(seasons=season, summary_level="week")


def load_teams() -> pl.DataFrame:
    """Load team metadata including colors and logo URLs."""
    return nfl.load_teams()


def load_team_bye_weeks(season: int) -> dict[str, int]:
    """Map team abbreviation → bye week for a regular season.

    Derived from nflverse schedules: the unique week in 1–18 with no game.
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
            byes[str(team).upper()] = int(missing[0])
    return byes


def _latest_regular_season_week(stats: pl.DataFrame, season: int) -> int:
    season_stats = stats.filter(
        (pl.col("season") == season) & (pl.col("season_type") == "REG")
    )
    if season_stats.is_empty():
        return 0
    return int(season_stats.select(pl.col("week").max()).item())
