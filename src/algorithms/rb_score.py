"""RB preseason composite rankings."""

from __future__ import annotations

import polars as pl

from src.algorithms.common import attach_team_meta, sort_and_trim
from src.algorithms.normalize import format_scores, normalize_values
from src.config.scoring import FORMATS, RB_WEIGHTS


def build_rb_rankings(
    season_stats: pl.DataFrame,
    teams: pl.DataFrame,
    season: int,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
) -> dict:
    """Build RB rankings from per-game opportunity and efficiency rates."""
    title = f"RB Rankings — {season}"

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
        .with_columns(
            (pl.col("carries") + pl.col("targets")).alias("touches"),
            (pl.col("rushing_yards") + pl.col("receiving_yards")).alias(
                "yards_from_scrimmage"
            ),
        )
        .filter((pl.col("games_played") > 0) & (pl.col("touches") > 0))
        .with_columns(
            (pl.col("touches") / pl.col("games_played")).alias("touches_pg"),
            (pl.col("targets") / pl.col("games_played")).alias("targets_pg"),
            (pl.col("yards_from_scrimmage") / pl.col("touches")).alias(
                "yards_per_touch"
            ),
        )
    )

    if frame.is_empty():
        return {"title": title, "season": season, "position": "RB", "rows": []}

    raw = frame.sort("player").to_dicts()
    touches_n = normalize_values([float(r["touches_pg"]) for r in raw])
    ypt_n = normalize_values([float(r["yards_per_touch"]) for r in raw])
    targets_n = normalize_values([float(r["targets_pg"]) for r in raw])

    rows: list[dict] = []
    for idx, player in enumerate(raw):
        components = {
            "touches_pg": round(touches_n[idx], 1),
            "yards_per_touch": round(ypt_n[idx], 1),
            "targets_pg": round(targets_n[idx], 1),
        }
        rows.append({
            "player_id": player["player_id"],
            "player": player["player"],
            "team": player["team"] or "",
            "games_played": int(player["games_played"]),
            "metrics": {
                "touches_pg": round(float(player["touches_pg"]), 1),
                "yards_per_touch": round(float(player["yards_per_touch"]), 2),
                "targets_pg": round(float(player["targets_pg"]), 1),
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
