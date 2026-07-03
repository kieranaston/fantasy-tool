"""RB predictive draft rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.predictive_ranking import (
    RB_METRICS,
    RB_MIN_AVG_TOUCHES,
    build_predictive_rankings,
)


def build_rb_rankings(
    stats: pl.DataFrame,
    teams: pl.DataFrame,
    snaps: pl.DataFrame,
    season: int,
    week: int,
) -> dict:
    """Return predictive RB rankings for the static site."""
    return build_predictive_rankings(
        stats,
        teams,
        snaps,
        season,
        week,
        position="RB",
        volume_expr=pl.col("carries").fill_null(0) + pl.col("targets").fill_null(0),
        min_avg_volume=RB_MIN_AVG_TOUCHES,
        metrics=RB_METRICS,
        title_label="RB",
        volume_label="touches",
    )
