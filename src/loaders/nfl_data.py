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


def _latest_regular_season_week(stats: pl.DataFrame, season: int) -> int:
    season_stats = stats.filter(
        (pl.col("season") == season) & (pl.col("season_type") == "REG")
    )
    if season_stats.is_empty():
        return 0
    return int(season_stats.select(pl.col("week").max()).item())
