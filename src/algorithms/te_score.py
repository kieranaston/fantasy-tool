"""TE preseason composite rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.common import attach_team_meta, safe_div, sort_and_trim
from src.algorithms.normalize import format_scores, normalize_values
from src.config.scoring import (
    FORMATS,
    MIN_GAMES,
    TE_MIN_AVG_TARGETS,
    TE_WEIGHTS,
)
from src.loaders.nfl_data import team_offensive_totals


def build_te_rankings(
    season_stats: pl.DataFrame,
    team_stats: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
) -> dict:
    """Build TE rankings with Standard / Half-PPR / Full-PPR scores."""
    title = f"TE Rankings — {season}"
    team_totals = team_offensive_totals(team_stats)

    frame = (
        season_stats.filter(pl.col("position") == "TE")
        .select(
            "player_id",
            pl.col("player_display_name").alias("player"),
            pl.col("recent_team").alias("team"),
            pl.col("games").fill_null(0).cast(pl.Int32).alias("games_played"),
            pl.col("targets").fill_null(0).cast(pl.Float64),
            pl.col("receiving_yards").fill_null(0).cast(pl.Float64),
            pl.col("receiving_tds").fill_null(0).cast(pl.Float64),
        )
        .join(team_totals, on="team", how="left")
        .with_columns(
            pl.col("team_pass_attempts").fill_null(0),
            (pl.col("targets") / pl.col("games_played")).alias("targets_pg"),
            (pl.col("receiving_yards") / pl.col("games_played")).alias("receiving_ypg"),
        )
        .with_columns(
            pl.when(pl.col("team_pass_attempts") > 0)
            .then(pl.col("targets") / pl.col("team_pass_attempts"))
            .otherwise(0.0)
            .alias("target_share"),
            pl.when(pl.col("targets") > 0)
            .then(pl.col("receiving_tds") / pl.col("targets"))
            .otherwise(0.0)
            .alias("td_rate"),
        )
        .filter(
            (pl.col("games_played") >= MIN_GAMES)
            & (pl.col("targets_pg") >= TE_MIN_AVG_TARGETS)
        )
    )

    if frame.is_empty():
        return {"title": title, "season": season, "position": "TE", "rows": []}

    raw = frame.sort("player").to_dicts()
    ypg = normalize_values([float(r["receiving_ypg"]) for r in raw])
    tgt = normalize_values([float(r["target_share"]) for r in raw])
    td = normalize_values([float(r["td_rate"]) for r in raw])

    rows: list[dict] = []
    for idx, player in enumerate(raw):
        components = {
            "receiving_ypg": round(ypg[idx], 1),
            "target_share": round(tgt[idx], 1),
            "td_rate": round(td[idx], 1),
        }
        rows.append({
            "player_id": player["player_id"],
            "player": player["player"],
            "team": player["team"] or "",
            "games_played": int(player["games_played"]),
            "metrics": {
                "receiving_ypg": round(float(player["receiving_ypg"]), 1),
                "target_share": round(float(player["target_share"]), 4),
                "td_rate": round(float(player["td_rate"]), 4),
                "targets_pg": round(
                    safe_div(float(player["targets"]), float(player["games_played"])),
                    1,
                ),
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
