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


def load_player_season_stats(season: int) -> pl.DataFrame:
    """Load regular-season player aggregates for a single season."""
    return nfl.load_player_stats(seasons=season, summary_level="reg")


def load_team_season_stats(season: int) -> pl.DataFrame:
    """Load regular-season team aggregates for a single season."""
    return nfl.load_team_stats(seasons=season, summary_level="reg")


def load_teams() -> pl.DataFrame:
    """Load team metadata including colors and logo URLs."""
    return nfl.load_teams()


def load_upcoming_roster_teams(ranking_season: int) -> tuple[dict[str, str], int | None]:
    """Map gsis player_id → team for the season after ``ranking_season``.

    Returns (player_id_to_team, upcoming_season). If that roster year is
    unavailable, returns an empty map and None.
    """
    upcoming_season = ranking_season + 1
    try:
        rosters = nfl.load_rosters(seasons=upcoming_season)
    except Exception:
        return {}, None

    if rosters.is_empty():
        return {}, None

    cleaned = (
        rosters.filter(
            pl.col("gsis_id").is_not_null()
            & (pl.col("gsis_id").cast(pl.Utf8).str.len_chars() > 0)
            & pl.col("team").is_not_null()
        )
        .select(
            pl.col("gsis_id").alias("player_id"),
            pl.col("team").alias("team"),
        )
        .unique(subset=["player_id"], keep="first")
    )
    return (
        {r["player_id"]: r["team"] for r in cleaned.iter_rows(named=True)},
        upcoming_season,
    )


def load_pfr_rush_yac(season: int) -> pl.DataFrame:
    """Load PFR rush advanced stats joined onto gsis player ids."""
    rush = nfl.load_pfr_advstats(
        seasons=season, stat_type="rush", summary_level="season"
    ).select(
        "pfr_id",
        pl.col("yac_att").cast(pl.Float64).alias("yac_per_attempt"),
    )

    ids = (
        nfl.load_ff_playerids()
        .select(
            pl.col("gsis_id").alias("player_id"),
            "pfr_id",
        )
        .filter(pl.col("player_id").is_not_null() & pl.col("pfr_id").is_not_null())
        .unique(subset=["pfr_id"], keep="first")
    )

    return rush.join(ids, on="pfr_id", how="inner").select(
        "player_id", "yac_per_attempt"
    )


def load_route_counts(season: int) -> pl.DataFrame:
    """Count pass-play skill-position appearances (proxy for routes run)."""
    participation = nfl.load_participation(seasons=season)
    pbp = nfl.load_pbp(seasons=season)

    pass_plays = pbp.filter(pl.col("pass") == 1).select(
        pl.col("old_game_id").cast(pl.Utf8),
        pl.col("play_id").cast(pl.Int64),
    )

    joined = participation.with_columns(
        pl.col("old_game_id").cast(pl.Utf8),
        pl.col("play_id").cast(pl.Int64),
    ).join(pass_plays, on=["old_game_id", "play_id"], how="inner")

    return (
        joined.select(
            pl.col("offense_players").str.split(";").alias("player_id"),
            pl.col("offense_positions").str.split(";").alias("pos"),
        )
        .explode(["player_id", "pos"])
        .filter(
            pl.col("player_id").is_not_null()
            & (pl.col("player_id").str.len_chars() > 0)
            & pl.col("pos").is_in(["WR", "TE", "RB", "FB"])
        )
        .group_by("player_id")
        .agg(pl.len().cast(pl.Int32).alias("routes"))
    )


def team_offensive_totals(team_stats: pl.DataFrame) -> pl.DataFrame:
    """Team pass attempts, rush attempts, and total offensive plays."""
    return team_stats.select(
        pl.col("team"),
        pl.col("attempts").fill_null(0).cast(pl.Int32).alias("team_pass_attempts"),
        pl.col("carries").fill_null(0).cast(pl.Int32).alias("team_rush_attempts"),
        (
            pl.col("attempts").fill_null(0) + pl.col("carries").fill_null(0)
        )
        .cast(pl.Int32)
        .alias("team_offensive_plays"),
    )


def _latest_regular_season_week(stats: pl.DataFrame, season: int) -> int:
    season_stats = stats.filter(
        (pl.col("season") == season) & (pl.col("season_type") == "REG")
    )
    if season_stats.is_empty():
        return 0
    return int(season_stats.select(pl.col("week").max()).item())
