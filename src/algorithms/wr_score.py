"""WR preseason composite rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.common import attach_team_meta, sort_and_trim
from src.algorithms.normalize import format_scores, normalize_values
from src.config.scoring import FORMATS, WR_WEIGHTS


def build_wr_rankings(
    season_stats: pl.DataFrame,
    route_counts: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
) -> dict:
    """Build WR rankings from per-game targets, aDOT, and yards per route."""
    title = f"WR Rankings — {season}"

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
        .join(route_counts, on="player_id", how="left")
        .filter((pl.col("games_played") > 0) & (pl.col("targets") > 0))
        .with_columns(
            pl.col("routes").fill_null(0).cast(pl.Float64),
            (pl.col("targets") / pl.col("games_played")).alias("targets_pg"),
            (pl.col("receiving_air_yards") / pl.col("targets")).alias("adot"),
        )
        .with_columns(
            pl.when(pl.col("routes") > 0)
            .then(pl.col("receiving_yards") / pl.col("routes"))
            .otherwise(pl.col("receiving_yards") / pl.col("targets"))
            .alias("yprr"),
            (pl.col("routes") > 0).alias("yprr_from_routes"),
        )
    )

    if frame.is_empty():
        return {"title": title, "season": season, "position": "WR", "rows": []}

    raw = frame.sort("player").to_dicts()
    tgt = normalize_values([float(r["targets_pg"]) for r in raw])
    adot = normalize_values([float(r["adot"]) for r in raw])
    yprr = normalize_values([float(r["yprr"]) for r in raw])

    rows: list[dict] = []
    for idx, player in enumerate(raw):
        components = {
            "targets_pg": round(tgt[idx], 1),
            "adot": round(adot[idx], 1),
            "yprr": round(yprr[idx], 1),
        }
        rows.append({
            "player_id": player["player_id"],
            "player": player["player"],
            "team": player["team"] or "",
            "games_played": int(player["games_played"]),
            "metrics": {
                "targets_pg": round(float(player["targets_pg"]), 1),
                "adot": round(float(player["adot"]), 2),
                "yprr": round(float(player["yprr"]), 2),
                "yprr_from_routes": bool(player["yprr_from_routes"]),
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
