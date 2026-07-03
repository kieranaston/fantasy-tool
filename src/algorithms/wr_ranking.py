"""WR predictive draft rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.predictive_ranking import (
    WR_METRICS,
    WR_MIN_AVG_TARGETS,
    build_predictive_rankings,
)


def build_wr_rankings(
    stats: pl.DataFrame,
    teams: pl.DataFrame,
    snaps: pl.DataFrame,
    season: int,
    week: int,
) -> dict:
    """Return predictive WR rankings for the static site."""
    return build_predictive_rankings(
        stats,
        teams,
        snaps,
        season,
        week,
        position="WR",
        volume_expr=pl.col("targets").fill_null(0),
        min_avg_volume=WR_MIN_AVG_TARGETS,
        metrics=WR_METRICS,
        title_label="WR",
        volume_label="targets",
    )
