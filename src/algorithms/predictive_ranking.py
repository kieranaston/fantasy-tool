"""Predictive draft rankings from prior-season sticky usage metrics.

Volume metrics (targets, touches, WOPR) drive the score. Phase 1 additions:
  - TD-regressed half-PPR (adj_ppg) — pulls noisy touchdown spikes toward average
  - Snap share — moderate weight as a role-security signal

Score = weighted sum of within-position z-scores, scaled to ~0–100.
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

MIN_GAMES = 8
TOP_RANKINGS = 40
SCORE_BASE = 50.0
SCORE_SCALE = 10.0
TD_REGRESSION = 0.5

RB_MIN_AVG_TOUCHES = 10.0
WR_MIN_AVG_TARGETS = 5.0


@dataclass(frozen=True)
class MetricWeight:
    column: str
    weight: float
    label: str


WR_METRICS = (
    MetricWeight("wopr_avg", 0.22, "WOPR"),
    MetricWeight("target_share_avg", 0.21, "Tgt Share"),
    MetricWeight("targets_pg", 0.18, "Tgt/G"),
    MetricWeight("rec_yards_pg", 0.12, "Rec Yds/G"),
    MetricWeight("receptions_pg", 0.06, "Rec/G"),
    MetricWeight("snap_pct_avg", 0.09, "Snap%"),
    MetricWeight("adj_ppg", 0.12, "Adj Pts/G"),
)

RB_METRICS = (
    MetricWeight("touches_pg", 0.22, "Tch/G"),
    MetricWeight("carries_pg", 0.18, "Car/G"),
    MetricWeight("targets_pg", 0.22, "Tgt/G"),
    MetricWeight("receptions_pg", 0.11, "Rec/G"),
    MetricWeight("rec_yards_pg", 0.06, "Rec Yds/G"),
    MetricWeight("snap_pct_avg", 0.09, "Snap%"),
    MetricWeight("adj_ppg", 0.12, "Adj Pts/G"),
)


def _z_scores(values: list[float]) -> list[float]:
    series = pl.Series(values)
    std = series.std()
    if std is None or std == 0:
        return [0.0] * len(values)
    mean = series.mean()
    return [float((v - mean) / std) for v in values]


def _weighted_z_score(
    row: dict,
    metrics: tuple[MetricWeight, ...],
    z_by_col: dict[str, list[float]],
    idx: int,
) -> float:
    total = 0.0
    for metric in metrics:
        total += metric.weight * z_by_col[metric.column][idx]
    return total


def _scale_score(z: float) -> float:
    return round(SCORE_BASE + SCORE_SCALE * z, 1)


def _weekly_frame(
    stats: pl.DataFrame,
    snaps: pl.DataFrame,
    season: int,
    week: int,
    position: str,
    volume_expr: pl.Expr,
) -> pl.DataFrame:
    """Player-week rows with volume, snap share, and TD-regressed half-PPR."""
    weekly = (
        stats.filter(
            (pl.col("season") == season)
            & (pl.col("season_type") == "REG")
            & (pl.col("week") <= week)
            & (pl.col("position") == position)
        )
        .select(
            "player_id",
            pl.col("player_display_name").alias("player_name"),
            "team",
            pl.col("week").cast(pl.Int32),
            pl.col("half_ppr_points").fill_null(0.0).alias("half_ppr_points"),
            pl.col("rushing_tds").fill_null(0).alias("rushing_tds"),
            pl.col("receiving_tds").fill_null(0).alias("receiving_tds"),
            pl.col("targets").fill_null(0).alias("targets"),
            pl.col("receptions").fill_null(0).alias("receptions"),
            pl.col("receiving_yards").fill_null(0).alias("receiving_yards"),
            pl.col("carries").fill_null(0).alias("carries"),
            pl.col("target_share").fill_null(0.0).alias("target_share"),
            pl.col("wopr").fill_null(0.0).alias("wopr"),
            volume_expr.alias("volume"),
        )
        .with_columns(
            ((pl.col("rushing_tds") + pl.col("receiving_tds")) * 6.0).alias("td_pts"),
        )
    )

    snap_weekly = (
        snaps.filter(
            (pl.col("season") == season)
            & (pl.col("game_type") == "REG")
            & (pl.col("week") <= week)
            & (pl.col("position") == position)
        )
        .select(
            pl.col("player").alias("player_name"),
            pl.col("week").cast(pl.Int32),
            "team",
            pl.col("offense_pct").fill_null(0.0).alias("snap_pct"),
        )
    )

    weekly = weekly.join(snap_weekly, on=["player_name", "team", "week"], how="left").with_columns(
        pl.col("snap_pct").fill_null(0.0),
    )

    mean_td_pts = float(weekly.select(pl.col("td_pts").mean()).item())
    return weekly.with_columns(
        (
            pl.col("half_ppr_points")
            - TD_REGRESSION * (pl.col("td_pts") - mean_td_pts)
        ).alias("adj_points"),
    )


def _season_frame(
    stats: pl.DataFrame,
    snaps: pl.DataFrame,
    season: int,
    week: int,
    position: str,
    volume_expr: pl.Expr,
) -> pl.DataFrame:
    weekly = _weekly_frame(stats, snaps, season, week, position, volume_expr)
    return (
        weekly.group_by("player_id", "player_name")
        .agg(
            pl.col("week").n_unique().cast(pl.Int32).alias("games_played"),
            pl.col("volume").mean().alias("avg_volume"),
            pl.col("volume").mean().alias("volume_pg"),
            pl.col("targets").mean().alias("targets_pg"),
            pl.col("receptions").mean().alias("receptions_pg"),
            pl.col("receiving_yards").mean().alias("rec_yards_pg"),
            pl.col("carries").mean().alias("carries_pg"),
            pl.col("target_share").mean().alias("target_share_avg"),
            pl.col("wopr").mean().alias("wopr_avg"),
            (pl.col("carries").mean() + pl.col("targets").mean()).alias("touches_pg"),
            pl.col("snap_pct").mean().alias("snap_pct_avg"),
            pl.col("adj_points").mean().alias("adj_ppg"),
        )
    )


def build_predictive_rankings(
    stats: pl.DataFrame,
    teams: pl.DataFrame,
    snaps: pl.DataFrame,
    season: int,
    week: int,
    *,
    position: str,
    volume_expr: pl.Expr,
    min_avg_volume: float,
    metrics: tuple[MetricWeight, ...],
    title_label: str,
    volume_label: str,
) -> dict:
    """Return predictive draft-ranking payload for a skill position."""
    title = (
        f"{title_label} Rankings — {season} Predictive Profile "
        f"(through Week {week}, min {MIN_GAMES} games, avg {min_avg_volume:g}+ {volume_label})"
    )

    season_stats = _season_frame(stats, snaps, season, week, position, volume_expr)
    if season_stats.is_empty():
        return {"title": title, "rows": []}

    qualified = season_stats.filter(
        (pl.col("games_played") >= MIN_GAMES)
        & (pl.col("avg_volume") >= min_avg_volume)
    )
    if qualified.is_empty():
        return {"title": title, "rows": []}

    rows_raw = qualified.sort("player_name").to_dicts()
    z_by_col: dict[str, list[float]] = {}
    for metric in metrics:
        z_by_col[metric.column] = _z_scores([float(row[metric.column]) for row in rows_raw])

    scored: list[dict] = []
    for idx, row in enumerate(rows_raw):
        z = _weighted_z_score(row, metrics, z_by_col, idx)
        scored.append({
            **row,
            "draft_z": z,
            "draft_score": _scale_score(z),
        })

    scored.sort(key=lambda row: row["draft_z"], reverse=True)
    scored = scored[:TOP_RANKINGS]

    player_team = (
        stats.filter(
            (pl.col("season") == season)
            & (pl.col("season_type") == "REG")
            & (pl.col("week") <= week)
            & (pl.col("position") == position)
        )
        .group_by("player_id", "team")
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
    team_by_player = {r["player_id"]: r["team"] for r in player_team.iter_rows(named=True)}
    team_meta = {
        r["team"]: {
            "logo": r["team_logo_espn"],
            "team_color": r["team_color"] or "#2563eb",
        }
        for r in team_lookup.iter_rows(named=True)
    }

    rows = []
    for rank, player in enumerate(scored, start=1):
        team = team_by_player.get(player["player_id"], "")
        meta = team_meta.get(team, {"logo": None, "team_color": "#2563eb"})
        rows.append({
            "rank": rank,
            "player": player["player_name"],
            "team": team or "",
            "logo": meta["logo"],
            "team_color": meta["team_color"],
            "games_played": int(player["games_played"]),
            "volume_pg": round(float(player["volume_pg"]), 1),
            "snap_pct": round(float(player["snap_pct_avg"]) * 100, 1),
            "adj_ppg": round(float(player["adj_ppg"]), 1),
            "draft_score": player["draft_score"],
        })

    return {"title": title, "rows": rows}
