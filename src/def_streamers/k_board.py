"""Build weekly fantasy kicker streamer board (FG attempts × Vegas points)."""

from __future__ import annotations

from statistics import median
from typing import Any

from src.def_streamers.projection_pool import (
    STREAMER_PROJ_LIMITS,
    canonical_team,
    top_projected_players,
)
from src.loaders.nflverse import (
    STATS_WINDOW_GAMES,
    espn_logo_url,
    fetch_schedules,
    implied_team_totals,
    resolve_pbp_seasons,
    resolve_sack_season,
    resolve_target_week,
    team_fg_attempts_per_game,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

K_PROJ_LIMIT = STREAMER_PROJ_LIMITS["K"]


def build_k_board(
    *,
    season: int | None = None,
    week: int | None = None,
    fg_season: int | None = None,
    pbp_seasons: list[int] | None = None,
    games: list[dict[str, Any]] | None = None,
    rates: dict[str, dict[str, float]] | None = None,
    projected_players: list[dict[str, Any]] | None = None,
    max_players: int = K_PROJ_LIMIT,
) -> dict[str, Any]:
    """Assemble the weekly kicker streamer payload for the static site.

    Inclusion is the top N Sleeper projected kickers (by team). Placement still
    uses team implied total × rolling FG attempts per game.
    """
    if season is None:
        season = draft_season_from_sleeper_state()
    if games is None:
        games = fetch_schedules(seasons=[season - 1, season, season + 1])
    if week is None:
        week = resolve_target_week(games, season)
    if pbp_seasons is None:
        pbp_seasons = resolve_pbp_seasons(season)
    if fg_season is None:
        fg_season = resolve_sack_season(pbp_seasons, season)
    if rates is None:
        rates = team_fg_attempts_per_game(pbp_seasons, window=STATS_WINDOW_GAMES)
    if projected_players is None:
        projected_players = top_projected_players(
            "K",
            limit=max_players,
            season=season,
        )

    # One kicker per team — first (highest projected) wins if duplicates.
    kickers_by_team: dict[str, dict[str, Any]] = {}
    for proj in projected_players:
        team = canonical_team(proj.get("team"))
        if not team or team in kickers_by_team:
            continue
        kickers_by_team[team] = proj

    slate = [
        g
        for g in games
        if g.get("season") == season
        and g.get("game_type") == "REG"
        and g.get("week") == week
        and g.get("total_line") is not None
        and g.get("spread_line") is not None
    ]
    if not slate:
        raise ValueError(f"No lined REG games for {season} week {week}")

    teams: list[dict[str, Any]] = []
    for g in slate:
        away = str(g["away_team"])
        home = str(g["home_team"])
        away_imp, home_imp = implied_team_totals(float(g["spread_line"]), float(g["total_line"]))
        for team, opp, is_home, team_points in (
            (home, away, True, home_imp),
            (away, home, False, away_imp),
        ):
            team_key = canonical_team(team)
            kicker = kickers_by_team.get(team_key)
            if not kicker:
                continue
            team_rates = rates.get(team) or rates.get(team_key)
            if not team_rates:
                continue
            fg_pg = float(team_rates["fg_attempts_per_game"])
            teams.append(
                {
                    "player_id": kicker.get("sleeper_id"),
                    "player_name": kicker.get("player"),
                    "last_name": kicker.get("last_name"),
                    "team": team_key or team,
                    "opponent": opp,
                    "home": is_home,
                    "matchup_label": f"vs {opp}" if is_home else f"@ {opp}",
                    "fg_attempts_per_game": round(fg_pg, 4),
                    "fg_games": int(team_rates.get("games") or 0),
                    "vegas_projected_points": round(team_points, 2),
                    "spread_line": float(g["spread_line"]),
                    "total_line": float(g["total_line"]),
                    "proj_half_ppr": kicker.get("pts"),
                    "logo_url": espn_logo_url(team),
                }
            )

    if not teams:
        raise ValueError("No kicker rows built — FG-rate teams missing for slate")

    teams.sort(key=lambda r: (-r["vegas_projected_points"], -r["fg_attempts_per_game"]))
    med_x = median(r["vegas_projected_points"] for r in teams)
    med_y = median(r["fg_attempts_per_game"] for r in teams)
    return {
        "season": season,
        "week": week,
        "fg_season": fg_season,
        "pbp_seasons": pbp_seasons,
        "fg_window_games": STATS_WINDOW_GAMES,
        "proj_limit": max_players,
        "fg_note": (
            f"Top {max_players} Sleeper projected kickers; "
            f"team implied total vs. rolling {STATS_WINDOW_GAMES}-game "
            "FG attempts per game"
        ),
        "x_formula": "team implied total = (game total ± spread) / 2",
        "y_formula": (
            f"team FG attempts per game (last {STATS_WINDOW_GAMES} games)"
        ),
        "source": "sleeper_projections_nflverse_pbp_schedules",
        "medians": {
            "vegas_projected_points": round(med_x, 2),
            "fg_attempts_per_game": round(med_y, 4),
        },
        "teams": teams,
    }
