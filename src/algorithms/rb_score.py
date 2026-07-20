"""RB preseason composite rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.common import attach_team_meta, safe_div, sort_and_trim
from src.algorithms.normalize import format_scores, mean_pair, normalize_values
from src.config.scoring import (
    FORMATS,
    MIN_GAMES,
    RB_MIN_AVG_TOUCHES,
    RB_WEIGHTS,
)
from src.loaders.nfl_data import team_offensive_totals


def build_rb_rankings(
    season_stats: pl.DataFrame,
    team_stats: pl.DataFrame,
    rush_yac: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
) -> dict:
    """Build RB rankings with Standard / Half-PPR / Full-PPR scores."""
    title = f"RB Rankings — {season}"
    team_totals = team_offensive_totals(team_stats)

    frame = (
        season_stats.filter(pl.col("position") == "RB")
        .select(
            "player_id",
            pl.col("player_display_name").alias("player"),
            pl.col("recent_team").alias("team"),
            pl.col("games").fill_null(0).cast(pl.Int32).alias("games_played"),
            pl.col("carries").fill_null(0).cast(pl.Float64),
            pl.col("targets").fill_null(0).cast(pl.Float64),
            pl.col("rushing_yards").fill_null(0).cast(pl.Float64),
            pl.col("receiving_yards").fill_null(0).cast(pl.Float64),
        )
        .join(team_totals, on="team", how="left")
        .join(rush_yac, on="player_id", how="left")
        .with_columns(
            (pl.col("carries") + pl.col("targets")).alias("touches"),
            (pl.col("rushing_yards") + pl.col("receiving_yards")).alias(
                "yards_from_scrimmage"
            ),
            pl.when(pl.col("carries") > 0)
            .then(pl.col("rushing_yards") / pl.col("carries"))
            .otherwise(0.0)
            .alias("ypc"),
            pl.col("yac_per_attempt").fill_null(0.0),
            pl.col("team_offensive_plays").fill_null(0),
        )
        .with_columns(
            pl.when(pl.col("team_offensive_plays") > 0)
            .then(pl.col("touches") / pl.col("team_offensive_plays"))
            .otherwise(0.0)
            .alias("opportunity_share"),
            (pl.col("touches") / pl.col("games_played")).alias("touches_pg"),
        )
        .filter(
            (pl.col("games_played") >= MIN_GAMES)
            & (pl.col("touches_pg") >= RB_MIN_AVG_TOUCHES)
        )
    )

    if frame.is_empty():
        return {"title": title, "season": season, "position": "RB", "rows": []}

    raw = frame.sort("player").to_dicts()
    opp = normalize_values([float(r["opportunity_share"]) for r in raw])
    yfs = normalize_values([float(r["yards_from_scrimmage"]) for r in raw])
    ypc_n = normalize_values([float(r["ypc"]) for r in raw])
    yac_n = normalize_values([float(r["yac_per_attempt"]) for r in raw])
    efficiency = mean_pair(ypc_n, yac_n)

    rows: list[dict] = []
    for idx, player in enumerate(raw):
        components = {
            "opportunity_share": round(opp[idx], 1),
            "yards_from_scrimmage": round(yfs[idx], 1),
            "efficiency": round(efficiency[idx], 1),
        }
        rows.append({
            "player_id": player["player_id"],
            "player": player["player"],
            "team": player["team"] or "",
            "games_played": int(player["games_played"]),
            "metrics": {
                "opportunity_share": round(float(player["opportunity_share"]), 4),
                "yards_from_scrimmage": round(float(player["yards_from_scrimmage"]), 1),
                "ypc": round(float(player["ypc"]), 2),
                "yac_per_attempt": round(float(player["yac_per_attempt"]), 2),
                "touches_pg": round(safe_div(float(player["touches"]), float(player["games_played"])), 1),
            },
            "components": components,
            "scores": format_scores(components, RB_WEIGHTS),
        })

    # Trim using half-PPR as the canonical ranking pool order for export size;
    # the site re-sorts by the active format.
    rows = sort_and_trim(rows, score_key="half_ppr")
    rows = attach_team_meta(
        rows,
        teams,
        upcoming_teams=upcoming_teams,
        upcoming_season=upcoming_season,
    )
    return {
        "title": title,
        "season": season,
        "position": "RB",
        "formats": list(FORMATS),
        "rows": rows,
    }
