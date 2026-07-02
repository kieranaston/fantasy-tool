"""Thin wrappers around nflreadpy."""

from __future__ import annotations

import nflreadpy as nfl
import polars as pl

from src.config.scoring import RECEPTION_PTS


def get_season_and_week() -> tuple[int, int]:
    """Return current NFL season and the latest week present in weekly stats."""
    season = nfl.get_current_season()
    stats = load_player_weekly_stats(season)
    week = _latest_regular_season_week(stats, season)
    return season, week


def load_player_weekly_stats(season: int) -> pl.DataFrame:
    """Load weekly player stats for a single season with half-PPR points."""
    df = nfl.load_player_stats(seasons=season, summary_level="week")
    return add_half_ppr_points(df)


def add_half_ppr_points(df: pl.DataFrame) -> pl.DataFrame:
    """Derive half-PPR fantasy points from standard points and receptions."""
    return df.with_columns(
        (pl.col("fantasy_points") + RECEPTION_PTS * pl.col("receptions").fill_null(0)).alias(
            "half_ppr_points"
        )
    )


def _latest_regular_season_week(stats: pl.DataFrame, season: int) -> int:
    season_stats = stats.filter(
        (pl.col("season") == season) & (pl.col("season_type") == "REG")
    )
    if season_stats.is_empty():
        return 0
    return int(season_stats.select(pl.col("week").max()).item())
