"""WR preseason composite rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.common import attach_team_meta, safe_div, sort_and_trim
from src.algorithms.normalize import format_scores, mean_pair, normalize_values
from src.config.scoring import (
    FORMATS,
    MIN_GAMES,
    WR_MIN_AVG_TARGETS,
    WR_WEIGHTS,
)
from src.loaders.nfl_data import team_offensive_totals


def build_wr_rankings(
    season_stats: pl.DataFrame,
    team_stats: pl.DataFrame,
    route_counts: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
) -> dict:
    """Build WR rankings with Standard / Half-PPR / Full-PPR scores."""
    title = f"WR Rankings — {season}"
    team_totals = team_offensive_totals(team_stats)

    frame = (
        season_stats.filter(pl.col("position") == "WR")
        .select(
            "player_id",
            pl.col("player_display_name").alias("player"),
            pl.col("recent_team").alias("team"),
            pl.col("games").fill_null(0).cast(pl.Int32).alias("games_played"),
            pl.col("targets").fill_null(0).cast(pl.Float64),
            pl.col("receiving_yards").fill_null(0).cast(pl.Float64),
            pl.col("receiving_air_yards").fill_null(0).cast(pl.Float64),
        )
        .join(team_totals, on="team", how="left")
        .join(route_counts, on="player_id", how="left")
        .with_columns(
            pl.col("routes").fill_null(0).cast(pl.Float64),
            pl.col("team_pass_attempts").fill_null(0),
            (pl.col("targets") / pl.col("games_played")).alias("targets_pg"),
        )
        .with_columns(
            pl.when(pl.col("team_pass_attempts") > 0)
            .then(pl.col("targets") / pl.col("team_pass_attempts"))
            .otherwise(0.0)
            .alias("target_share"),
            pl.when(pl.col("targets") > 0)
            .then(pl.col("receiving_air_yards") / pl.col("targets"))
            .otherwise(0.0)
            .alias("adot"),
            pl.when(pl.col("routes") > 0)
            .then(pl.col("receiving_yards") / pl.col("routes"))
            .otherwise(
                pl.when(pl.col("targets") > 0)
                .then(pl.col("receiving_yards") / pl.col("targets"))
                .otherwise(0.0)
            )
            .alias("yprr"),
            (pl.col("routes") > 0).alias("yprr_from_routes"),
        )
        .filter(
            (pl.col("games_played") >= MIN_GAMES)
            & (pl.col("targets_pg") >= WR_MIN_AVG_TARGETS)
        )
    )

    if frame.is_empty():
        return {"title": title, "season": season, "position": "WR", "rows": []}

    raw = frame.sort("player").to_dicts()
    tgt = normalize_values([float(r["target_share"]) for r in raw])
    air = normalize_values([float(r["receiving_air_yards"]) for r in raw])
    adot = normalize_values([float(r["adot"]) for r in raw])
    air_adot = mean_pair(air, adot)
    yprr = normalize_values([float(r["yprr"]) for r in raw])

    rows: list[dict] = []
    for idx, player in enumerate(raw):
        components = {
            "target_share": round(tgt[idx], 1),
            "air_adot": round(air_adot[idx], 1),
            "yprr": round(yprr[idx], 1),
        }
        rows.append({
            "player_id": player["player_id"],
            "player": player["player"],
            "team": player["team"] or "",
            "games_played": int(player["games_played"]),
            "metrics": {
                "target_share": round(float(player["target_share"]), 4),
                "air_yards": round(float(player["receiving_air_yards"]), 1),
                "adot": round(float(player["adot"]), 2),
                "yprr": round(float(player["yprr"]), 2),
                "yprr_from_routes": bool(player["yprr_from_routes"]),
                "targets_pg": round(
                    safe_div(float(player["targets"]), float(player["games_played"])),
                    1,
                ),
            },
            "components": components,
            "scores": format_scores(components, WR_WEIGHTS),
        })

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
        "position": "WR",
        "formats": list(FORMATS),
        "rows": rows,
    }
