"""Example ranking and chart exports for the static site scaffold."""

from __future__ import annotations

import polars as pl

from src.config.scoring import SKILL_POSITIONS

TOP_RANKINGS = 50
TOP_WR_OPPORTUNITY = 32


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


def build_wr_opportunity_chart(
    opportunity: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    week: int,
) -> dict:
    """Production versus expected opportunity for top wide receivers."""
    filtered = opportunity.filter(
        (pl.col("season").cast(pl.Int64) == season)
        & (pl.col("week") <= week)
        & (pl.col("position") == "WR")
    )

    if filtered.is_empty():
        return {
            "title": "WR Production vs Opportunity",
            "x_axis": "Expected Fantasy Points",
            "y_axis": "Actual Fantasy Points",
            "points": [],
        }

    team_lookup = teams.select(
        pl.col("team_abbr").alias("posteam"),
        "team_color",
        "team_color2",
        "team_logo_espn",
    )

    wrs = (
        filtered.group_by("player_id", "full_name", "posteam")
        .agg(
            pl.col("total_fantasy_points").sum().alias("production"),
            pl.col("total_fantasy_points_exp").sum().alias("opportunity"),
            pl.col("rec_attempt").sum().alias("targets"),
            pl.col("rec_air_yards").sum().alias("air_yards"),
        )
        .filter(pl.col("opportunity") > 0)
        .join(team_lookup, on="posteam", how="left")
        .sort("opportunity", descending=True)
        .head(TOP_WR_OPPORTUNITY)
    )

    points = []
    for row in wrs.iter_rows(named=True):
        points.append(
            {
                "player": row["full_name"],
                "team": row["posteam"],
                "x": round(row["opportunity"], 1),
                "y": round(row["production"], 1),
                "targets": int(row["targets"] or 0),
                "air_yards": int(row["air_yards"] or 0),
                "team_color": row["team_color"] or "#2563eb",
                "team_color2": row["team_color2"] or "#111827",
                "logo": row["team_logo_espn"],
            }
        )

    return {
        "title": f"WR Production vs Opportunity — Top {TOP_WR_OPPORTUNITY} by Expected Points",
        "x_axis": "Expected Fantasy Points",
        "y_axis": "Actual Fantasy Points",
        "points": points,
    }
