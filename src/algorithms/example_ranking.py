"""Example ranking and trend chart exports for the static site scaffold."""

from __future__ import annotations

import polars as pl

from src.config.scoring import SKILL_POSITIONS

TOP_RANKINGS = 50
TOP_WR_TREND = 5


def build_rankings(stats: pl.DataFrame, season: int, week: int) -> dict:
    """Top skill players by season half-PPR points with a placeholder custom score."""
    filtered = stats.filter(
        (pl.col("season") == season)
        & (pl.col("season_type") == "REG")
        & (pl.col("week") <= week)
        & pl.col("position").is_in(SKILL_POSITIONS)
    )

    season_totals = filtered.group_by(
        "player_id",
        "player_display_name",
        "team",
        "position",
    ).agg(
        pl.col("half_ppr_points").sum().alias("half_ppr_pts"),
        pl.col("target_share").mean().alias("avg_target_share"),
    )

    if season_totals.is_empty():
        return {
            "title": f"Example Rankings — Half-PPR (through Week {week})",
            "columns": ["rank", "player", "team", "position", "half_ppr_pts", "custom_score"],
            "rows": [],
        }

    max_pts = season_totals.select(pl.col("half_ppr_pts").max()).item()
    ranked = (
        season_totals.with_columns(
            (
                (pl.col("half_ppr_pts") / max_pts)
                * (1 + pl.col("avg_target_share").fill_null(0))
            )
            .round(3)
            .alias("custom_score")
        )
        .sort("half_ppr_pts", descending=True)
        .head(TOP_RANKINGS)
    )

    rows = []
    for rank, row in enumerate(ranked.iter_rows(named=True), start=1):
        rows.append(
            [
                rank,
                row["player_display_name"],
                row["team"],
                row["position"],
                round(row["half_ppr_pts"], 1),
                row["custom_score"],
            ]
        )

    return {
        "title": f"Example Rankings — Half-PPR (through Week {week})",
        "columns": ["rank", "player", "team", "position", "half_ppr_pts", "custom_score"],
        "rows": rows,
    }


def build_trend_chart(stats: pl.DataFrame, season: int, week: int) -> dict:
    """Weekly half-PPR points for the top WRs by season total."""
    filtered = stats.filter(
        (pl.col("season") == season)
        & (pl.col("season_type") == "REG")
        & (pl.col("week") <= week)
        & (pl.col("position") == "WR")
    )

    if filtered.is_empty():
        return {
            "title": "Weekly Half-PPR Points — Top WRs",
            "labels": [],
            "datasets": [],
        }

    top_wrs = (
        filtered.group_by("player_display_name")
        .agg(pl.col("half_ppr_points").sum().alias("total_pts"))
        .sort("total_pts", descending=True)
        .head(TOP_WR_TREND)
        .select("player_display_name")
        .to_series()
        .to_list()
    )

    labels = [f"W{w}" for w in range(1, week + 1)]
    datasets = []

    for player in top_wrs:
        weekly = (
            filtered.filter(pl.col("player_display_name") == player)
            .sort("week")
            .select("week", "half_ppr_points")
        )
        points_by_week = {row["week"]: row["half_ppr_points"] for row in weekly.iter_rows(named=True)}
        datasets.append(
            {
                "label": player,
                "data": [round(points_by_week.get(w, 0), 1) for w in range(1, week + 1)],
            }
        )

    return {
        "title": "Weekly Half-PPR Points — Top WRs",
        "labels": labels,
        "datasets": datasets,
    }
