"""Season-long WR ranking system using production and opportunity percentiles.

Outputs:
  season_composite – top-40 WRs (min 8 games) ranked by consistency-adjusted
                     composite score, with team logo and colours for display.
"""

from __future__ import annotations

import polars as pl

MIN_GAMES = 8
TOP_RANKINGS = 40
# Penalty per point of week-to-week MAD on the composite (0–100 scale).
CONSISTENCY_WEIGHT = 1.25


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _percentile_rank(series: pl.Series) -> pl.Series:
    """Return 0-100 percentile rank for each value (higher value → higher pct)."""
    n = len(series)
    if n <= 1:
        return pl.Series([100.0] * n)
    ranks = series.rank(method="average")
    return ((ranks - 1) / (n - 1) * 100).round(1)


def _median_abs_deviation(values: list[float]) -> float:
    """Median absolute deviation — robust measure of week-to-week volatility."""
    if len(values) < 2:
        return 0.0
    series = pl.Series(values)
    med = series.median()
    return float((series - med).abs().median())


# ---------------------------------------------------------------------------
# Weekly games
# ---------------------------------------------------------------------------

def _build_weekly_games(stats: pl.DataFrame, season: int, week: int) -> pl.DataFrame:
    """Per-week prod/opp percentiles from load_player_stats.

    Opportunity = WOPR (0 when targets = 0). Production = half-PPR points.
    """
    empty_schema = {
        "player_id": pl.Utf8,
        "player_name": pl.Utf8,
        "week": pl.Int32,
        "team": pl.Utf8,
        "prod_pct": pl.Float64,
        "opp_pct": pl.Float64,
        "weekly_composite": pl.Float64,
    }

    wrs = (
        stats.filter(
            (pl.col("season") == season)
            & (pl.col("season_type") == "REG")
            & (pl.col("week") <= week)
            & (pl.col("position") == "WR")
        )
        .select(
            "player_id",
            pl.col("player_display_name").alias("player_name"),
            pl.col("week").cast(pl.Int32),
            "team",
            "half_ppr_points",
            pl.col("targets").fill_null(0).alias("targets"),
            pl.col("wopr").fill_null(0.0).alias("wopr"),
        )
        .with_columns(
            pl.col("half_ppr_points").fill_null(0.0).alias("half_ppr_points"),
            pl.when(pl.col("targets") == 0)
            .then(0.0)
            .otherwise(pl.col("wopr"))
            .alias("wopr"),
        )
    )

    if wrs.is_empty():
        return pl.DataFrame(schema=empty_schema)

    rows: list[dict] = []
    for wk in sorted(wrs["week"].unique().to_list()):
        wk_df = wrs.filter(pl.col("week") == wk)
        prod_pcts = _percentile_rank(wk_df["half_ppr_points"])
        opp_pcts = _percentile_rank(wk_df["wopr"])

        for i, row in enumerate(wk_df.iter_rows(named=True)):
            prod = float(prod_pcts[i])
            opp = float(opp_pcts[i])
            rows.append({
                "player_id": row["player_id"],
                "player_name": row["player_name"],
                "week": int(wk),
                "team": row["team"],
                "prod_pct": prod,
                "opp_pct": opp,
                "weekly_composite": round((prod + opp) / 2, 1),
            })

    return pl.DataFrame(rows)


# ---------------------------------------------------------------------------
# Season composite
# ---------------------------------------------------------------------------

def _build_season_composite(
    weekly: pl.DataFrame,
    teams: pl.DataFrame,
) -> pl.DataFrame:
    """Consistency-adjusted composite → top-40 with ≥8 games played.

    Score = mean(weekly_composite) − CONSISTENCY_WEIGHT × MAD(weekly_composite).
    """
    if weekly.is_empty():
        return pl.DataFrame()

    composite = (
        weekly.group_by("player_id", "player_name")
        .agg(
            pl.col("prod_pct").mean().round(1).alias("avg_production_pct"),
            pl.col("opp_pct").mean().round(1).alias("avg_opportunity_pct"),
            pl.col("weekly_composite").mean().round(1).alias("mean_composite"),
            pl.col("weekly_composite").alias("weekly_composites"),
            pl.col("week").n_unique().cast(pl.Int32).alias("games_played"),
        )
        .with_columns(
            pl.col("weekly_composites")
            .map_elements(_median_abs_deviation, return_dtype=pl.Float64)
            .round(1)
            .alias("composite_mad"),
        )
        .with_columns(
            (pl.col("mean_composite") - CONSISTENCY_WEIGHT * pl.col("composite_mad"))
            .round(1)
            .alias("composite_score"),
        )
        .filter(pl.col("games_played") >= MIN_GAMES)
        .sort("composite_score", descending=True)
        .head(TOP_RANKINGS)
    )

    composite = composite.with_row_index(name="rank", offset=1).with_columns(
        pl.col("rank").cast(pl.Int32)
    )

    player_team = (
        weekly.group_by("player_id", "team")
        .agg(pl.len().alias("n"))
        .sort("n", descending=True)
        .group_by("player_id")
        .agg(pl.col("team").first().alias("team"))
    )

    team_lookup = teams.select(
        pl.col("team_abbr").alias("team"),
        "team_logo_espn",
        "team_color",
    )

    return (
        composite
        .join(player_team, on="player_id", how="left")
        .join(team_lookup, on="team", how="left")
        .select(
            "rank", "player_name", "team",
            pl.col("team_logo_espn").alias("logo"),
            pl.col("team_color").fill_null("#2563eb"),
            "games_played",
            "avg_production_pct", "avg_opportunity_pct", "composite_score",
        )
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def build_wr_rankings(
    stats: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    week: int,
) -> dict:
    """Return the season composite table payload for the rankings page."""
    weekly = _build_weekly_games(stats, season, week)
    season_comp = _build_season_composite(weekly, teams)

    rows = []
    for r in season_comp.iter_rows(named=True):
        rows.append({
            "rank":             int(r["rank"]),
            "player":           r["player_name"],
            "team":             r["team"] or "",
            "logo":             r["logo"],
            "team_color":       r["team_color"],
            "games_played":     int(r["games_played"]),
            "avg_prod_pct":     round(float(r["avg_production_pct"]), 1),
            "avg_opp_pct":      round(float(r["avg_opportunity_pct"]), 1),
            "composite_score":  round(float(r["composite_score"]), 1),
        })

    return {
        "title":   f"WR Rankings — {season} Season (through Week {week}, min {MIN_GAMES} games)",
        "rows":    rows,
    }
