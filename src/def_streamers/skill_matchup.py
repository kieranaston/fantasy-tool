"""Weekly QB/RB/WR/TE boards: usage (xFP/G) vs efficiency (FPOE/G)."""

from __future__ import annotations

from statistics import median
from typing import Any

from src.def_streamers.projection_pool import (
    SKILL_CHART_X_WEIGHT,
    SKILL_CHART_Y_WEIGHT,
    STREAMER_PROJ_LIMITS,
    canonical_team,
    rank_by_chart,
)
from src.loaders.nflverse import (
    chart_min_games,
    chart_weeks_available,
    espn_logo_url,
    fetch_schedules,
    load_roster_teams,
    position_season_xfp,
    resolve_target_week,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

# Rolling window for the skill charts. Swept against next-week points
# (2021-2024 train, 2025 holdout): 5 weeks beat 3 (test Spearman 0.51 vs 0.43).
# Longer windows kept helping but with diminishing returns, and a wider window
# stops reflecting current role — 5 is the balance. See
# src/analysis/chart_param_sweep.py.
SKILL_WINDOW_WEEKS = 5

# Minimum games played inside the window before a player can chart. The sweep
# found a one-game minimum predicts better than two (see
# src/analysis/chart_param_sweep.py); the top-N cut is the real selector.
SKILL_MIN_GAMES = {
    "QB": 1,
    "RB": 1,
    "WR": 1,
    "TE": 1,
}

# Reference total-points floors (half-PPR over a full 5-week window). These are
# deliberately disabled in production: testing showed the floor shrinks the
# candidate pool below the display limit, forcing weaker players onto the board
# and lowering the actual-point percentile of the displayed set (0.53 with the
# floor vs 0.66 without). The top-N cut already handles thin roles, and one-game
# players are only ~2% of the board (near-average outcomes). Kept for the
# gating experiment in src/analysis/matchup_signal_test.py.
SKILL_MIN_TOTAL_POINTS = {
    "QB": 37.5,
    "RB": 26.25,
    "WR": 26.25,
    "TE": 22.5,
}
SKILL_FLOOR_MULTIPLIER = 0.0


def build_skill_matchup_board(
    position: str,
    *,
    season: int | None = None,
    week: int | None = None,
    stats_season: int | None = None,
    games: list[dict[str, Any]] | None = None,
    player_rows: list[dict[str, Any]] | None = None,
    roster_teams: dict[str, str] | None = None,
    max_players: int | None = None,
) -> dict[str, Any]:
    """Assemble a weekly position board (QB/RB/WR/TE).

    Inclusion is the top N players by a composite of the chart axes
    (expected points per game and points over expected). Stats are the last
    ``SKILL_WINDOW_WEEKS`` calendar weeks this season before the slate, so a
    player who has not played recently ages off the chart.
    """
    position = position.upper()
    if max_players is None:
        max_players = STREAMER_PROJ_LIMITS.get(position, 30)

    if season is None:
        season = draft_season_from_sleeper_state()
    if stats_season is None:
        stats_season = season
    if games is None:
        games = fetch_schedules(seasons=[season - 1, season, season + 1])
    if week is None:
        week = resolve_target_week(games, season)
    if roster_teams is None:
        roster_teams = load_roster_teams(season)
    if player_rows is None:
        player_rows = position_season_xfp(
            stats_season,
            position,
            as_of_week=week,
            window=SKILL_WINDOW_WEEKS,
            roster_teams=roster_teams,
        )

    matchups: dict[str, tuple[str, bool, str]] = {}
    for g in games:
        if (
            g.get("season") != season
            or g.get("game_type") != "REG"
            or g.get("week") != week
        ):
            continue
        away = str(g["away_team"])
        home = str(g["home_team"])
        matchups[home] = (away, True, f"vs {away}")
        matchups[away] = (home, False, f"@ {home}")

    if not matchups:
        raise ValueError(f"No REG matchups for {season} week {week}")

    players: list[dict[str, Any]] = []
    for row in player_rows:
        team = canonical_team(row.get("team"))
        if not team:
            continue
        # Skill charts rank on recent performance, so bye-week players stay.
        opp, is_home, matchup_label = matchups.get(team, (None, None, ""))
        xfpts = round(float(row["xfpts"]), 2)
        actual = round(float(row["fantasy_points"]), 2)
        fpoe = round(float(row["fpoe"]) if "fpoe" in row else actual - xfpts, 2)
        players.append(
            {
                "player_id": row["player_id"],
                "player_name": row["player_name"],
                "last_name": row["last_name"],
                "team": team,
                "opponent": opp,
                "home": is_home,
                "matchup_label": matchup_label,
                "xfpts": xfpts,
                "fantasy_points": actual,
                "fpoe": fpoe,
                "games": int(row["games"]),
                "logo_url": espn_logo_url(team),
            }
        )

    # Keep anyone who has played; the top-N cut below is the real selector.
    # Early in the season count only the weeks the slate actually allows.
    weeks_available = chart_weeks_available(week, window=SKILL_WINDOW_WEEKS)
    min_games = chart_min_games(
        week,
        window=SKILL_WINDOW_WEEKS,
        floor=SKILL_MIN_GAMES.get(position, SKILL_WINDOW_WEEKS),
    )
    min_total_points = round(
        SKILL_MIN_TOTAL_POINTS.get(position, 0.0)
        * SKILL_FLOOR_MULTIPLIER
        * (weeks_available / SKILL_WINDOW_WEEKS),
        1,
    )
    players = [
        p
        for p in players
        if p["games"] >= min_games
        and p["fantasy_points"] * p["games"] >= min_total_points
    ]

    players = rank_by_chart(
        players,
        x_key="xfpts",
        y_key="fpoe",
        x_weight=SKILL_CHART_X_WEIGHT,
        y_weight=SKILL_CHART_Y_WEIGHT,
        limit=max_players,
    )
    if not players:
        raise ValueError(f"No {position} rows built for {season} before week {week}")

    med_x = round(median(r["xfpts"] for r in players), 2)
    med_y = round(median(r["fpoe"] for r in players), 2)

    stats_note = (
        f"Top {max_players} {position}s by chart score "
        f"({SKILL_CHART_X_WEIGHT:.0%} xFP/G + {SKILL_CHART_Y_WEIGHT:.0%} FPOE/G); "
        f"last {SKILL_WINDOW_WEEKS} weeks in {stats_season} before week {week}"
    )
    if min_games > 0:
        stats_note += f"; min {min_games} games"
    if min_total_points > 0:
        stats_note += f"; min {min_total_points:g} half-PPR points"

    return {
        "season": season,
        "week": week,
        "position": position,
        "stats_season": stats_season,
        "stat_seasons": [stats_season],
        "scoring": "half_ppr",
        "rolling_weeks": SKILL_WINDOW_WEEKS,
        "min_games": min_games,
        "min_total_points": min_total_points,
        "proj_limit": max_players,
        "stats_note": stats_note,
        "x_formula": (
            f"expected half-PPR per game, last {SKILL_WINDOW_WEEKS} weeks "
            f"this season before week {week}"
        ),
        "y_formula": (
            "points over expected per game = actual half-PPR/G − expected half-PPR/G"
        ),
        "source": "sleeper_projections_ffopportunity",
        "medians": {
            "xfpts": med_x,
            "fpoe": med_y,
        },
        "players": players,
        "teams": players,
    }


def build_qb_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("QB", **kwargs)


def build_rb_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("RB", **kwargs)


def build_wr_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("WR", **kwargs)


def build_te_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("TE", **kwargs)
