"""Build weekly fantasy DEF streamer board (sack rate × Vegas points)."""

from __future__ import annotations

from statistics import median
from typing import Any

from src.loaders.nflverse import (
    STATS_WINDOW_GAMES,
    espn_logo_url,
    fetch_schedules,
    implied_team_totals,
    resolve_pbp_seasons,
    resolve_sack_season,
    resolve_target_week,
    team_sack_rates,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

# Hayden Winks / PPRRankings-style blend.
OPP_OFFENSE_WEIGHT = 0.67
DEFENSE_WEIGHT = 0.33


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
) -> dict[str, Any]:
    """Assemble the weekly DEF streamer payload for the static site."""
    if season is None:
        season = draft_season_from_sleeper_state()
    if games is None:
        games = fetch_schedules(seasons=[season - 1, season, season + 1])
    if week is None:
        week = resolve_target_week(games, season)
    if pbp_seasons is None:
        pbp_seasons = resolve_pbp_seasons(season)
    if sack_season is None:
        sack_season = resolve_sack_season(pbp_seasons, season)
    if rates is None:
        rates = team_sack_rates(pbp_seasons, window=STATS_WINDOW_GAMES)

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
            team_rates = rates.get(team)
            opp_rates = rates.get(opp)
            if not team_rates or not opp_rates:
                continue
            def_sr = float(team_rates["defense_sack_rate"])
            opp_off_sr = float(opp_rates["offense_sack_rate"])
            proj = projected_sack_rate(def_sr, opp_off_sr)
            teams.append(
                {
                    "team": team,
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

    teams.sort(key=lambda r: (-r["projected_sack_rate"], r["vegas_projected_points"]))
    med_x = median(r["projected_sack_rate"] for r in teams)
    med_y = median(r["vegas_projected_points"] for r in teams)

    return {
        "season": season,
        "week": week,
        "sack_season": sack_season,
        "pbp_seasons": pbp_seasons,
        "sack_window_games": STATS_WINDOW_GAMES,
        "sack_formula": (
            f"{OPP_OFFENSE_WEIGHT:.0%} opponent offense sack rate + "
            f"{DEFENSE_WEIGHT:.0%} defense sack rate"
        ),
        "sack_note": f"Rolling {STATS_WINDOW_GAMES}-game projected sack rates",
        "x_formula": (
            f"{OPP_OFFENSE_WEIGHT:.0%} × opponent offense sack rate + "
            f"{DEFENSE_WEIGHT:.0%} × this DEF sack rate "
            f"(last {STATS_WINDOW_GAMES} games)"
        ),
        "y_formula": (
            "opponent implied team total = (game total ± spread) / 2"
        ),
        "source": "nflverse_pbp_schedules",
        "medians": {
            "projected_sack_rate": round(med_x, 6),
            "vegas_projected_points": round(med_y, 2),
        },
        "teams": teams,
    }
