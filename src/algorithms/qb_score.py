"""QB preseason composite rankings (format-invariant)."""

from __future__ import annotations

import polars as pl

from src.algorithms.common import attach_team_meta, safe_div, sort_and_trim
from src.algorithms.normalize import normalize_values, weighted_score
from src.config.scoring import (
    MIN_GAMES,
    QB_MIN_AVG_PASS_ATTEMPTS,
    QB_WEIGHTS,
)


def build_qb_rankings(
    season_stats: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
) -> dict:
    """Build QB rankings with a single fixed composite score."""
    title = f"QB Rankings — {season}"

    frame = (
        season_stats.filter(pl.col("position") == "QB")
        .select(
            "player_id",
            pl.col("player_display_name").alias("player"),
            pl.col("recent_team").alias("team"),
            pl.col("games").fill_null(0).cast(pl.Int32).alias("games_played"),
            pl.col("attempts").fill_null(0).cast(pl.Float64).alias("pass_attempts"),
            pl.col("carries").fill_null(0).cast(pl.Float64).alias("rush_attempts"),
            pl.col("passing_yards").fill_null(0).cast(pl.Float64),
            pl.col("passing_tds").fill_null(0).cast(pl.Float64),
            pl.col("rushing_tds").fill_null(0).cast(pl.Float64),
        )
        .with_columns(
            (pl.col("pass_attempts") / pl.col("games_played")).alias("pass_attempts_pg"),
            pl.when(pl.col("pass_attempts") > 0)
            .then(pl.col("passing_yards") / pl.col("pass_attempts"))
            .otherwise(0.0)
            .alias("yards_per_attempt"),
            pl.when((pl.col("pass_attempts") + pl.col("rush_attempts")) > 0)
            .then(
                (pl.col("passing_tds") + pl.col("rushing_tds"))
                / (pl.col("pass_attempts") + pl.col("rush_attempts"))
            )
            .otherwise(0.0)
            .alias("td_rate"),
        )
        .filter(
            (pl.col("games_played") >= MIN_GAMES)
            & (pl.col("pass_attempts_pg") >= QB_MIN_AVG_PASS_ATTEMPTS)
        )
    )

    if frame.is_empty():
        return {"title": title, "season": season, "position": "QB", "rows": []}

    raw = frame.sort("player").to_dicts()
    pass_n = normalize_values([float(r["pass_attempts"]) for r in raw])
    rush_n = normalize_values([float(r["rush_attempts"]) for r in raw])
    td_n = normalize_values([float(r["td_rate"]) for r in raw])
    ypa_n = normalize_values([float(r["yards_per_attempt"]) for r in raw])

    rows: list[dict] = []
    for idx, player in enumerate(raw):
        components = {
            "pass_attempts": round(pass_n[idx], 1),
            "rush_attempts": round(rush_n[idx], 1),
            "td_rate": round(td_n[idx], 1),
            "yards_per_attempt": round(ypa_n[idx], 1),
        }
        score = weighted_score(components, QB_WEIGHTS)
        rows.append({
            "player_id": player["player_id"],
            "player": player["player"],
            "team": player["team"] or "",
            "games_played": int(player["games_played"]),
            "metrics": {
                "pass_attempts": round(float(player["pass_attempts"]), 0),
                "rush_attempts": round(float(player["rush_attempts"]), 0),
                "td_rate": round(float(player["td_rate"]), 4),
                "yards_per_attempt": round(float(player["yards_per_attempt"]), 2),
                "pass_attempts_pg": round(
                    safe_div(float(player["pass_attempts"]), float(player["games_played"])),
                    1,
                ),
            },
            "components": components,
            "scores": {"default": score},
        })

    rows = sort_and_trim(rows, score_key="default")
    rows = attach_team_meta(
        rows,
        teams,
        upcoming_teams=upcoming_teams,
        upcoming_season=upcoming_season,
    )
    return {
        "title": title,
        "season": season,
        "position": "QB",
        "formats": ["default"],
        "rows": rows,
    }
