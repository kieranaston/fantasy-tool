"""Build weekly fantasy DEF streamer board (sack rate × Vegas points)."""

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
    implied_team_totals,
    resolve_target_week,
    team_sack_rates,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

# Hayden Winks / PPRRankings-style blend.
OPP_OFFENSE_WEIGHT = 0.67
DEFENSE_WEIGHT = 0.33
DEF_PROJ_LIMIT = STREAMER_PROJ_LIMITS["DEF"]


def projected_sack_rate(defense_sack_rate: float, opponent_offense_sack_rate: float) -> float:
    return OPP_OFFENSE_WEIGHT * opponent_offense_sack_rate + DEFENSE_WEIGHT * defense_sack_rate


def build_def_board(
    *,
    season: int | None = None,
    week: int | None = None,
    sack_season: int | None = None,
    pbp_seasons: list[int] | None = None,
    games: list[dict[str, Any]] | None = None,
    rates: dict[str, dict[str, float]] | None = None,
    max_players: int = DEF_PROJ_LIMIT,
) -> dict[str, Any]:
    """Assemble the weekly DEF streamer payload for the static site.

    Inclusion is the top N defenses by chart score: higher projected sack rate
    and a lower opponent implied total.
    """
    if season is None:
        season = draft_season_from_sleeper_state()
    if games is None:
        games = fetch_schedules(seasons=[season - 1, season, season + 1])
    if week is None:
        week = resolve_target_week(games, season)
    if pbp_seasons is None:
        pbp_seasons = [season]
    if sack_season is None:
        sack_season = season
    if rates is None:
        rates = team_sack_rates(
            [season],
            as_of_season=season,
            as_of_week=week,
        )

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
        for team, opp, is_home, opp_points in (
            (home, away, True, away_imp),
            (away, home, False, home_imp),
        ):
            team_key = canonical_team(team)
            team_rates = rates.get(team) or rates.get(team_key)
            opp_rates = rates.get(opp) or rates.get(canonical_team(opp))
            if not team_rates or not opp_rates:
                continue
            def_sr = float(team_rates["defense_sack_rate"])
            opp_off_sr = float(opp_rates["offense_sack_rate"])
            proj = projected_sack_rate(def_sr, opp_off_sr)
            teams.append(
                {
                    "team": team_key or team,
                    "opponent": opp,
                    "home": is_home,
                    "matchup_label": f"vs {opp}" if is_home else f"@ {opp}",
                    "projected_sack_rate": round(proj, 6),
                    "defense_sack_rate": round(def_sr, 6),
                    "opponent_offense_sack_rate": round(opp_off_sr, 6),
                    "vegas_projected_points": round(opp_points, 2),
                    "spread_line": float(g["spread_line"]),
                    "total_line": float(g["total_line"]),
                    "logo_url": espn_logo_url(team),
                }
            )

    if not teams:
        raise ValueError("No DEF rows built — sack-rate teams missing for slate")

    teams = rank_by_chart(
        teams,
        x_key="projected_sack_rate",
        y_key="vegas_projected_points",
        y_sign=-1,
        limit=max_players,
    )
    med_x = median(r["projected_sack_rate"] for r in teams)
    med_y = median(r["vegas_projected_points"] for r in teams)

    return {
        "season": season,
        "week": week,
        "sack_season": sack_season,
        "pbp_seasons": pbp_seasons,
        "proj_limit": max_players,
        "sack_formula": (
            f"{OPP_OFFENSE_WEIGHT:.0%} opponent offense sack rate + "
            f"{DEFENSE_WEIGHT:.0%} defense sack rate"
        ),
        "sack_note": (
            f"Top {max_players} defenses by chart score "
            f"(sack rate, lower opponent total); "
            f"{season} regular-season games before week {week}"
        ),
        "x_formula": (
            f"{OPP_OFFENSE_WEIGHT:.0%} × opponent offense sack rate + "
            f"{DEFENSE_WEIGHT:.0%} × this DEF sack rate "
            f"({season} regular season, before week {week})"
        ),
        "y_formula": (
            "opponent implied team total = (game total ± spread) / 2"
        ),
        "source": "sleeper_projections_nflverse_pbp_schedules",
        "medians": {
            "projected_sack_rate": round(med_x, 6),
            "vegas_projected_points": round(med_y, 2),
        },
        "teams": teams,
    }
