"""TE preseason composite rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.common import attach_team_meta, sort_and_trim
from src.algorithms.normalize import format_scores, normalize_values
from src.config.scoring import FORMATS, TE_WEIGHTS


def build_te_rankings(
    season_stats: pl.DataFrame,
    route_counts: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
) -> dict:
    """Build TE rankings from per-game targets, yards/target, and YPRR."""
    title = f"TE Rankings — {season}"

    frame = (
        season_stats.filter(pl.col("position") == "TE")
        .select(
            "player_id",
            pl.col("player_display_name").alias("player"),
            pl.col("recent_team").alias("team"),
            pl.col("games").fill_null(0).cast(pl.Int32).alias("games_played"),
            pl.col("targets").fill_null(0).cast(pl.Float64),
            pl.col("receiving_yards").fill_null(0).cast(pl.Float64),
        )
        .join(route_counts, on="player_id", how="left")
        .filter((pl.col("games_played") > 0) & (pl.col("targets") > 0))
        .with_columns(
            pl.col("routes").fill_null(0).cast(pl.Float64),
            (pl.col("targets") / pl.col("games_played")).alias("targets_pg"),
            (pl.col("receiving_yards") / pl.col("targets")).alias("yards_per_target"),
        )
        .with_columns(
            pl.when(pl.col("routes") > 0)
            .then(pl.col("receiving_yards") / pl.col("routes"))
            .otherwise(pl.col("yards_per_target"))
            .alias("yprr"),
            (pl.col("routes") > 0).alias("yprr_from_routes"),
        )
    )

    if frame.is_empty():
        return {"title": title, "season": season, "position": "TE", "rows": []}

    raw = frame.sort("player").to_dicts()
    tgt = normalize_values([float(r["targets_pg"]) for r in raw])
    ypt = normalize_values([float(r["yards_per_target"]) for r in raw])
    yprr = normalize_values([float(r["yprr"]) for r in raw])

    rows: list[dict] = []
    for idx, player in enumerate(raw):
        components = {
            "targets_pg": round(tgt[idx], 1),
            "yards_per_target": round(ypt[idx], 1),
            "yprr": round(yprr[idx], 1),
        }
        rows.append({
            "player_id": player["player_id"],
            "player": player["player"],
            "team": player["team"] or "",
            "games_played": int(player["games_played"]),
            "metrics": {
                "targets_pg": round(float(player["targets_pg"]), 1),
                "yards_per_target": round(float(player["yards_per_target"]), 2),
                "yprr": round(float(player["yprr"]), 2),
                "yprr_from_routes": bool(player["yprr_from_routes"]),
            },
            "components": components,
            "scores": format_scores(components, TE_WEIGHTS),
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
        "position": "TE",
        "formats": list(FORMATS),
        "rows": rows,
    }
