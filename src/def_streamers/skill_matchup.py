"""Weekly skill-position matchup boards (avg FPs × opponent SOS)."""

from __future__ import annotations

from statistics import median
from typing import Any

from src.def_streamers.projection_pool import (
    STREAMER_PROJ_LIMITS,
    canonical_team,
    match_stats_for_projected,
    top_projected_players,
)
from src.loaders.nflverse import (
    STATS_WINDOW_GAMES,
    defense_position_half_ppr_sos,
    espn_logo_url,
    fetch_schedules,
    load_roster_teams,
    position_avg_half_ppr,
    resolve_player_stat_seasons,
    resolve_sack_season,
    resolve_target_week,
)
from src.loaders.sleeper_adp import draft_season_from_sleeper_state

GUIDE_SOS = 0.0

# Fixed X guide for RB charts (Hayden-style ~RB1/flex line). WR/TE use median.
_POSITION_GUIDE_AVG: dict[str, float | None] = {
    "RB": 10.0,
    "WR": None,
    "TE": None,
}


def build_skill_matchup_board(
    position: str,
    *,
    season: int | None = None,
    week: int | None = None,
    stats_season: int | None = None,
    stat_seasons: list[int] | None = None,
    games: list[dict[str, Any]] | None = None,
    player_avgs: list[dict[str, Any]] | None = None,
    defense_sos: dict[str, dict[str, float]] | None = None,
    roster_teams: dict[str, str] | None = None,
    projected_players: list[dict[str, Any]] | None = None,
    guide_avg_fp: float | None | object = ...,
    max_players: int | None = None,
) -> dict[str, Any]:
    """Assemble a weekly position matchup payload (RB/WR/…).

    Inclusion is the top N Sleeper projected half-PPR players at the position.
    Chart placement still uses rolling half-PPR avg × opponent SOS.
    """
    position = position.upper()
    allowed_key = f"{position.lower()}_half_ppr_allowed"
    if max_players is None:
        max_players = STREAMER_PROJ_LIMITS.get(position, 30)

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
    if projected_players is None:
        projected_players = top_projected_players(
            position,
            limit=max_players,
            season=season,
        )
    if player_avgs is None:
        # Relax thresholds so projected names still place early in the season.
        # Exclude the slate week so same-week box scores cannot place rookies.
        player_avgs = position_avg_half_ppr(
            stat_seasons,
            position,
            window=STATS_WINDOW_GAMES,
            roster_teams=roster_teams,
            min_games=1,
            min_avg=0.0,
            as_of_season=season,
            as_of_week=week,
        )
    if defense_sos is None:
        defense_sos = defense_position_half_ppr_sos(stat_seasons, position)
    if guide_avg_fp is ...:
        guide_avg_fp = _POSITION_GUIDE_AVG.get(position)

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
    for proj, row in match_stats_for_projected(projected_players, player_avgs):
        team = canonical_team(row.get("team")) or canonical_team(proj.get("team"))
        if not team or team not in matchups:
            continue
        opp, is_home, matchup_label = matchups[team]
        sos = defense_sos.get(opp)
        if not sos:
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
                "avg_half_ppr": round(float(row["avg_half_ppr"]), 2),
                "games": int(row["games"]),
                "sos_adj": round(float(sos["sos_adj"]), 3),
                allowed_key: round(float(sos.get(allowed_key) or 0), 2),
                "proj_half_ppr": proj.get("pts"),
                "logo_url": espn_logo_url(team),
            }
        )

    players.sort(key=lambda r: (-r["avg_half_ppr"], -r["sos_adj"]))
    if not players:
        raise ValueError(f"No {position} rows built for slate")

    med_x = round(median(r["avg_half_ppr"] for r in players), 2)
    med_y = round(median(r["sos_adj"] for r in players), 3)
    guides: dict[str, float] = {"sos_adj": GUIDE_SOS}
    if guide_avg_fp is not None:
        guides["avg_half_ppr"] = float(guide_avg_fp)
    else:
        guides["avg_half_ppr"] = med_x

    return {
        "season": season,
        "week": week,
        "position": position,
        "stats_season": stats_season,
        "stat_seasons": stat_seasons,
        "stats_window_games": STATS_WINDOW_GAMES,
        "scoring": "half_ppr",
        "proj_limit": max_players,
        "stats_note": (
            f"Top {max_players} Sleeper projected {position}s; "
            f"rolling {STATS_WINDOW_GAMES}-game half-PPR avg vs opponent "
            f"{position} FPs allowed (SOS adj)"
        ),
        "x_formula": (
            f"player half-PPR avg (last {STATS_WINDOW_GAMES} games)"
        ),
        "y_formula": (
            f"opponent SOS adj = opp {position} half-PPR allowed − league average"
        ),
        "source": "sleeper_projections_nflverse_player_stats",
        "guides": guides,
        "medians": {
            "avg_half_ppr": med_x,
            "sos_adj": med_y,
        },
        "players": players,
        "teams": players,
    }


def build_rb_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("RB", **kwargs)


def build_wr_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("WR", **kwargs)


def build_te_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("TE", **kwargs)
