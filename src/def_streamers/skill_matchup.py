"""Weekly QB/RB/WR/TE boards: usage (xFP/G) vs efficiency (FPOE/G)."""

from __future__ import annotations

from statistics import median
from typing import Any

from src.def_streamers.projection_pool import (
    STREAMER_PROJ_LIMITS,
    canonical_team,
    rank_by_chart,
)
from src.loaders.nflverse import (
    espn_logo_url,
    fetch_schedules,
    load_roster_teams,
    position_season_xfp,
    resolve_target_week,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

# Last few games capture the current role without a one-game spike.
SKILL_ROLLING_GAMES = 4

# Minimum games played in the rolling window before a player can chart.
# Filters small samples whose per-game average is inflated by one big game.
SKILL_MIN_GAMES = {
    "QB": 3,
    "RB": 3,
    "WR": 3,
    "TE": 3,
}


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
    ``SKILL_ROLLING_GAMES`` games this season before the slate.
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
            window=SKILL_ROLLING_GAMES,
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

    # Drop small samples so one big game can't top the chart on average.
    # Early in the season count only the games the slate actually allows.
    min_games = min(
        SKILL_MIN_GAMES.get(position, SKILL_ROLLING_GAMES),
        max(0, week - 1),
    )
    players = [p for p in players if p["games"] >= min_games]

    players = rank_by_chart(
        players,
        x_key="xfpts",
        y_key="fpoe",
        limit=max_players,
    )
    if not players:
        raise ValueError(f"No {position} rows built for {season} before week {week}")

    med_x = round(median(r["xfpts"] for r in players), 2)
    med_y = round(median(r["fpoe"] for r in players), 2)

    stats_note = (
        f"Top {max_players} {position}s by chart score "
        f"(xFP/G + FPOE/G); last {SKILL_ROLLING_GAMES} games "
        f"in {stats_season} before week {week}"
    )
    if min_games > 0:
        stats_note += f"; min {min_games} games"

    return {
        "season": season,
        "week": week,
        "position": position,
        "stats_season": stats_season,
        "stat_seasons": [stats_season],
        "scoring": "half_ppr",
        "rolling_games": SKILL_ROLLING_GAMES,
        "min_games": min_games,
        "proj_limit": max_players,
        "stats_note": stats_note,
        "x_formula": (
            f"expected half-PPR per game, last {SKILL_ROLLING_GAMES} games "
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
