"""Build weekly fantasy QB board (implied total × rush yards)."""

from __future__ import annotations

from statistics import median
from typing import Any

from src.loaders.nflverse import (
    espn_logo_url,
    fetch_schedules,
    implied_team_totals,
    load_depth_chart_starters,
    load_roster_teams,
    qb_rush_yards_per_game,
    resolve_player_stat_seasons,
    resolve_sack_season,
    resolve_target_week,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

QB_RUSH_WINDOW = 8


def build_qb_board(
    *,
    season: int | None = None,
    week: int | None = None,
    stats_season: int | None = None,
    stat_seasons: list[int] | None = None,
    games: list[dict[str, Any]] | None = None,
    qb_rates: list[dict[str, Any]] | None = None,
    roster_teams: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Assemble the weekly QB streamer payload for the static site."""
    if season is None:
        season = draft_season_from_sleeper_state()
    if games is None:
        games = fetch_schedules(seasons=[season - 1, season, season + 1])
    if week is None:
        week = resolve_target_week(games, season)
    if stat_seasons is None:
        stat_seasons = resolve_player_stat_seasons(season)
    if stats_season is None:
        stats_season = resolve_sack_season(stat_seasons, season)
    if roster_teams is None:
        roster_teams = load_roster_teams(season)
    if qb_rates is None:
        qb_rates = qb_rush_yards_per_game(
            stat_seasons,
            window=QB_RUSH_WINDOW,
            roster_teams=roster_teams,
            depth_starters=load_depth_chart_starters(season, "QB"),
        )

    # team -> (opponent, home?, matchup_label, implied_team_total)
    matchups: dict[str, tuple[str, bool, str, float]] = {}
    for g in games:
        if (
            g.get("season") != season
            or g.get("game_type") != "REG"
            or g.get("week") != week
            or g.get("total_line") is None
            or g.get("spread_line") is None
        ):
            continue
        away = str(g["away_team"])
        home = str(g["home_team"])
        away_imp, home_imp = implied_team_totals(
            float(g["spread_line"]), float(g["total_line"])
        )
        matchups[home] = (away, True, f"vs {away}", home_imp)
        matchups[away] = (home, False, f"@ {home}", away_imp)

    if not matchups:
        raise ValueError(f"No lined REG matchups for {season} week {week}")

    by_team = {row["team"]: row for row in qb_rates if row.get("team")}
    players: list[dict[str, Any]] = []
    for team, (opp, is_home, matchup_label, implied) in matchups.items():
        row = by_team.get(team)
        if not row:
            continue
        players.append(
            {
                "player_id": row["player_id"],
                "player_name": row["player_name"],
                "last_name": row["last_name"],
                "team": team,
                "opponent": opp,
                "home": is_home,
                "matchup_label": matchup_label,
                "implied_team_total": round(float(implied), 2),
                "rush_yards_per_game": round(float(row["rush_yards_per_game"]), 2),
                "games": int(row["games"]),
                "logo_url": espn_logo_url(team),
            }
        )

    players.sort(key=lambda r: (-r["implied_team_total"], -r["rush_yards_per_game"]))
    if not players:
        raise ValueError("No QB rows built for slate")

    med_x = median(r["implied_team_total"] for r in players)
    med_y = median(r["rush_yards_per_game"] for r in players)

    return {
        "season": season,
        "week": week,
        "position": "QB",
        "stats_season": stats_season,
        "stat_seasons": stat_seasons,
        "rush_window_games": QB_RUSH_WINDOW,
        "stats_note": (
            f"Team implied total vs. rolling {QB_RUSH_WINDOW}-game "
            "QB rushing yards per game"
        ),
        "x_formula": "team implied total = (game total ± spread) / 2",
        "y_formula": (
            f"QB rushing yards per game (last {QB_RUSH_WINDOW} games)"
        ),
        "source": "nflverse_player_stats_schedules",
        "guides": {
            "implied_team_total": round(med_x, 2),
            "rush_yards_per_game": round(med_y, 2),
        },
        "medians": {
            "implied_team_total": round(med_x, 2),
            "rush_yards_per_game": round(med_y, 2),
        },
        "players": players,
        "teams": players,
    }
