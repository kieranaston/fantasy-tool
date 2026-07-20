"""Shared helpers for season composite ranking payloads."""

from __future__ import annotations

import polars as pl

from src.config.scoring import TOP_RANKINGS


def attach_team_meta(
    rows: list[dict],
    teams: pl.DataFrame,
    *,
    upcoming_teams: dict[str, str] | None = None,
    upcoming_season: int | None = None,
    team_key: str = "team",
) -> list[dict]:
    """Attach logo/color and optional offseason team-change annotation.

    Ranking-season team stays on ``team`` (stats context). When a player's
    upcoming roster team differs, set ``new_team`` / ``new_team_season``.
    Logo reflects the upcoming team when available, otherwise the ranking team.
    """
    team_meta = {
        r["team"]: {
            "logo": r["team_logo_espn"],
            "team_color": r["team_color"] or "#2563eb",
        }
        for r in teams.select(
            pl.col("team_abbr").alias("team"),
            "team_logo_espn",
            "team_color",
        ).iter_rows(named=True)
    }
    upcoming_teams = upcoming_teams or {}

    for row in rows:
        ranking_team = row.get(team_key, "") or ""
        player_id = row.pop("player_id", None)
        new_team = upcoming_teams.get(player_id) if player_id else None

        if new_team and new_team != ranking_team:
            row["new_team"] = new_team
            if upcoming_season is not None:
                row["new_team_season"] = upcoming_season
        else:
            row.pop("new_team", None)
            row.pop("new_team_season", None)

        # Logo reflects ranking-season team (where the metrics came from).
        meta = team_meta.get(ranking_team, {"logo": None, "team_color": "#2563eb"})
        row["logo"] = meta["logo"]
        row["team_color"] = meta["team_color"]

    return rows


def sort_and_trim(
    rows: list[dict],
    *,
    score_key: str,
    limit: int = TOP_RANKINGS,
) -> list[dict]:
    """Sort by a score descending and keep the top N (no rank assigned yet)."""
    rows = sorted(rows, key=lambda row: row["scores"][score_key], reverse=True)
    return rows[:limit]


def safe_div(numerator: float, denominator: float) -> float:
    """Division that returns 0 when the denominator is 0."""
    if denominator == 0:
        return 0.0
    return numerator / denominator
