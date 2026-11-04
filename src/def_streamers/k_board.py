"""Build weekly fantasy kicker streamer board (Vegas points x kickoff weather)."""

from __future__ import annotations

from statistics import median
from typing import Any

from src.def_streamers.projection_pool import (
    K_CHART_X_WEIGHT,
    K_CHART_Y_WEIGHT,
    STREAMER_PROJ_LIMITS,
    canonical_team,
    rank_by_chart,
    top_projected_players,
)
from src.loaders.nflverse import (
    espn_logo_url,
    fetch_schedules,
    implied_team_totals,
    resolve_target_week,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state
from src.loaders.weather import game_weather

K_PROJ_LIMIT = STREAMER_PROJ_LIMITS["K"]


def build_k_board(
    *,
    season: int | None = None,
    week: int | None = None,
    games: list[dict[str, Any]] | None = None,
    weather: dict[str, dict[str, Any]] | None = None,
    projected_players: list[dict[str, Any]] | None = None,
    max_players: int = K_PROJ_LIMIT,
) -> dict[str, Any]:
    """Assemble the weekly kicker streamer payload for the static site.

    Inclusion uses the chart score (higher team total and kinder kickoff
    weather). ``weather`` maps ``game_id`` to a ``game_weather`` result; when
    omitted it is fetched from the forecast at build time. Sleeper only supplies
    the kicker name on each team.
    """
    if season is None:
        season = draft_season_from_sleeper_state()
    if games is None:
        games = fetch_schedules(seasons=[season - 1, season, season + 1])
    if week is None:
        week = resolve_target_week(games, season)
    if projected_players is None:
        projected_players = top_projected_players(
            "K",
            cap=False,
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

    if weather is None:
        forecasts: dict = {}
        weather = {
            str(g.get("game_id")): game_weather(g, forecasts=forecasts) for g in slate
        }

    teams: list[dict[str, Any]] = []
    for g in slate:
        away = str(g["away_team"])
        home = str(g["home_team"])
        wx = weather.get(str(g.get("game_id"))) or game_weather({})
        away_imp, home_imp = implied_team_totals(float(g["spread_line"]), float(g["total_line"]))
        for team, opp, is_home, team_points in (
            (home, away, True, home_imp),
            (away, home, False, away_imp),
        ):
            team_key = canonical_team(team)
            kicker = kickers_by_team.get(team_key)
            if not kicker:
                continue
            teams.append(
                {
                    "player_id": kicker.get("sleeper_id"),
                    "player_name": kicker.get("player"),
                    "last_name": kicker.get("last_name"),
                    "team": team_key or team,
                    "opponent": opp,
                    "home": is_home,
                    "matchup_label": f"vs {opp}" if is_home else f"@ {opp}",
                    "vegas_projected_points": round(team_points, 2),
                    "spread_line": float(g["spread_line"]),
                    "total_line": float(g["total_line"]),
                    "roof": wx.get("roof"),
                    "temp_f": wx.get("temp_f"),
                    "wind_mph": wx.get("wind_mph"),
                    "weather_index": wx.get("weather_index"),
                    "weather_source": wx.get("weather_source", "unavailable"),
                    "logo_url": espn_logo_url(team),
                }
            )

    if not teams:
        raise ValueError("No kicker rows built — no projected kickers on the slate")

    # Games without a forecast (neutral sites, API down) sit at the slate's
    # median weather so they are neither rewarded nor punished.
    known = [t["weather_index"] for t in teams if t["weather_index"] is not None]
    neutral = round(median(known), 3) if known else 0.0
    for t in teams:
        if t["weather_index"] is None:
            t["weather_index"] = neutral

    # Weighted percentiles: the team implied total is the strongest signal for
    # kicker scoring; kickoff weather (wind, cold, dome) is the second. See
    # src/analysis/k_weather_backtest.py.
    teams = rank_by_chart(
        teams,
        x_key="vegas_projected_points",
        y_key="weather_index",
        x_weight=K_CHART_X_WEIGHT,
        y_weight=K_CHART_Y_WEIGHT,
        limit=max_players,
    )
    med_x = median(r["vegas_projected_points"] for r in teams)
    med_y = median(r["weather_index"] for r in teams)
    return {
        "season": season,
        "week": week,
        "proj_limit": max_players,
        "weather_note": (
            f"Top {max_players} kickers by chart score "
            f"({K_CHART_X_WEIGHT:.0%} team implied total + "
            f"{K_CHART_Y_WEIGHT:.0%} kickoff weather); "
            "weather is the forecast at kickoff and is refreshed before games"
        ),
        "x_formula": "team implied total = (game total ± spread) / 2",
        "y_formula": (
            "kickoff weather score = -(wind mph / 10) - (degrees below 50°F / 10); "
            "0 is ideal, domes score 0"
        ),
        "source": "sleeper_projections_nflverse_schedules_open_meteo",
        "medians": {
            "vegas_projected_points": round(med_x, 2),
            "weather_index": round(med_y, 3),
        },
        "teams": teams,
    }
