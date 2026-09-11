"""Unit tests for DEF streamer board math (no network)."""

from __future__ import annotations

from src.def_streamers.board import build_def_board, projected_sack_rate
from src.loaders.nflverse import (
    implied_team_totals,
    resolve_sack_season,
    resolve_target_week,
)


def test_projected_sack_rate_blend() -> None:
    # 0.67 * 0.10 + 0.33 * 0.04 = 0.0802
    assert abs(projected_sack_rate(0.04, 0.10) - 0.0802) < 1e-9


def test_implied_team_totals_home_favored() -> None:
    away, home = implied_team_totals(3.0, 44.5)
    assert abs(home - 23.75) < 1e-9
    assert abs(away - 20.75) < 1e-9


def test_resolve_sack_season_uses_newest_pbp() -> None:
    assert resolve_sack_season([2025], 2026) == 2025
    assert resolve_sack_season([2025, 2026], 2026) == 2026


def test_resolve_target_week_prefers_unfinished() -> None:
    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": 10.0,
            "home_score": 17.0,
            "spread_line": 3.0,
            "total_line": 44.5,
        },
        {
            "season": 2026,
            "game_type": "REG",
            "week": 2,
            "away_team": "KC",
            "home_team": "BUF",
            "away_score": None,
            "home_score": None,
            "spread_line": -2.5,
            "total_line": 48.0,
        },
    ]
    assert resolve_target_week(games, 2026) == 2


def test_build_def_board_from_fixtures() -> None:
    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    rates = {
        "SEA": {"defense_sack_rate": 0.08, "offense_sack_rate": 0.05, "off_n": 1, "def_n": 1},
        "NE": {"defense_sack_rate": 0.06, "offense_sack_rate": 0.09, "off_n": 1, "def_n": 1},
    }
    projected = [
        {
            "sleeper_id": "SEA",
            "player": "Seattle Seahawks",
            "last_name": "Seahawks",
            "team": "SEA",
            "position": "DEF",
            "pts": 103.0,
        },
        {
            "sleeper_id": "NE",
            "player": "New England Patriots",
            "last_name": "Patriots",
            "team": "NE",
            "position": "DEF",
            "pts": 92.0,
        },
    ]
    board = build_def_board(
        season=2026,
        week=1,
        sack_season=2025,
        pbp_seasons=[2025],
        games=games,
        rates=rates,
        projected_players=projected,
    )
    assert board["week"] == 1
    assert board["sack_season"] == 2025
    assert board["sack_window_games"] == 17
    assert board["proj_limit"] == 14
    assert len(board["teams"]) == 2
    sea = next(t for t in board["teams"] if t["team"] == "SEA")
    assert sea["matchup_label"] == "vs NE"
    assert sea["vegas_projected_points"] == 20.75
    assert abs(sea["projected_sack_rate"] - projected_sack_rate(0.08, 0.09)) < 1e-9


def test_build_def_board_filters_to_projected() -> None:
    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    rates = {
        "SEA": {"defense_sack_rate": 0.08, "offense_sack_rate": 0.05, "off_n": 1, "def_n": 1},
        "NE": {"defense_sack_rate": 0.06, "offense_sack_rate": 0.09, "off_n": 1, "def_n": 1},
    }
    board = build_def_board(
        season=2026,
        week=1,
        sack_season=2025,
        pbp_seasons=[2025],
        games=games,
        rates=rates,
        projected_players=[
            {
                "sleeper_id": "SEA",
                "player": "Seattle Seahawks",
                "last_name": "Seahawks",
                "team": "SEA",
                "position": "DEF",
                "pts": 103.0,
            }
        ],
    )
    assert [t["team"] for t in board["teams"]] == ["SEA"]


def test_build_k_board_uses_own_team_total() -> None:
    from src.def_streamers.k_board import build_k_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    rates = {
        "SEA": {"fg_attempts_per_game": 2.8, "games": 17},
        "NE": {"fg_attempts_per_game": 1.9, "games": 17},
    }
    projected = [
        {
            "sleeper_id": "1",
            "player": "Jason Myers",
            "last_name": "Myers",
            "team": "SEA",
            "position": "K",
            "pts": 111.0,
        },
        {
            "sleeper_id": "2",
            "player": "Andy Borregales",
            "last_name": "Borregales",
            "team": "NE",
            "position": "K",
            "pts": 96.0,
        },
    ]
    board = build_k_board(
        season=2026,
        week=1,
        fg_season=2025,
        pbp_seasons=[2025],
        games=games,
        rates=rates,
        projected_players=projected,
    )
    assert board["fg_season"] == 2025
    assert board["fg_window_games"] == 17
    assert board["proj_limit"] == 14
    sea = next(t for t in board["teams"] if t["team"] == "SEA")
    ne = next(t for t in board["teams"] if t["team"] == "NE")
    # Kickers use their own implied total (home 23.75 / away 20.75), not opponent.
    assert sea["vegas_projected_points"] == 23.75
    assert ne["vegas_projected_points"] == 20.75
    assert sea["fg_attempts_per_game"] == 2.8
    assert sea["last_name"] == "Myers"


def test_build_k_board_filters_to_projected_teams() -> None:
    from src.def_streamers.k_board import build_k_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    rates = {
        "SEA": {"fg_attempts_per_game": 2.8, "games": 17},
        "NE": {"fg_attempts_per_game": 1.9, "games": 17},
    }
    board = build_k_board(
        season=2026,
        week=1,
        fg_season=2025,
        pbp_seasons=[2025],
        games=games,
        rates=rates,
        projected_players=[
            {
                "sleeper_id": "1",
                "player": "Jason Myers",
                "last_name": "Myers",
                "team": "SEA",
                "position": "K",
                "pts": 111.0,
            }
        ],
    )
    assert [t["team"] for t in board["teams"]] == ["SEA"]
    assert board["teams"][0]["player_name"] == "Jason Myers"


def test_build_rb_board_sos_and_labels() -> None:
    from src.def_streamers.rb_board import build_rb_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    player_avgs = [
        {
            "player_id": "1",
            "player_name": "Kenneth Walker III",
            "last_name": "Walker",
            "team": "SEA",
            "avg_half_ppr": 12.5,
            "games": 17,
        }
    ]
    defense_sos = {
        "NE": {"rb_half_ppr_allowed": 8.0, "sos_adj": 1.2, "n": 50},
    }
    board = build_rb_board(
        season=2026,
        week=1,
        stats_season=2025,
        stat_seasons=[2025],
        games=games,
        player_avgs=player_avgs,
        defense_sos=defense_sos,
        projected_players=[
            {
                "sleeper_id": "s1",
                "player": "Kenneth Walker",
                "last_name": "Walker",
                "team": "SEA",
                "position": "RB",
                "pts": 200.0,
            }
        ],
    )
    assert len(board["players"]) == 1
    row = board["players"][0]
    assert row["last_name"] == "Walker"
    assert row["opponent"] == "NE"
    assert row["sos_adj"] == 1.2
    assert row["avg_half_ppr"] == 12.5
    assert board["guides"]["avg_half_ppr"] == 10.0
    assert board["proj_limit"] == 30


def test_skill_board_keeps_projected_players_only() -> None:
    from src.def_streamers.rb_board import build_rb_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    player_avgs = [
        {
            "player_id": "1",
            "player_name": "Kenneth Walker III",
            "last_name": "Walker",
            "team": "SEA",
            "avg_half_ppr": 14.0,
            "games": 17,
        },
        {
            "player_id": "2",
            "player_name": "Zach Charbonnet",
            "last_name": "Charbonnet",
            "team": "SEA",
            "avg_half_ppr": 9.0,
            "games": 17,
        },
        {
            "player_id": "3",
            "player_name": "Rhamondre Stevenson",
            "last_name": "Stevenson",
            "team": "NE",
            "avg_half_ppr": 11.0,
            "games": 17,
        },
    ]
    defense_sos = {
        "NE": {"rb_half_ppr_allowed": 8.0, "sos_adj": 1.2, "n": 50},
        "SEA": {"rb_half_ppr_allowed": 7.0, "sos_adj": 0.2, "n": 50},
    }
    board = build_rb_board(
        season=2026,
        week=1,
        stats_season=2025,
        stat_seasons=[2025],
        games=games,
        player_avgs=player_avgs,
        defense_sos=defense_sos,
        projected_players=[
            {
                "sleeper_id": "s1",
                "player": "Kenneth Walker",
                "last_name": "Walker",
                "team": "SEA",
                "position": "RB",
                "pts": 220.0,
            },
            {
                "sleeper_id": "s3",
                "player": "Rhamondre Stevenson",
                "last_name": "Stevenson",
                "team": "NE",
                "position": "RB",
                "pts": 150.0,
            },
        ],
    )
    names = {p["last_name"] for p in board["players"]}
    assert names == {"Walker", "Stevenson"}
    assert "Charbonnet" not in names


def test_build_wr_board_uses_median_x_guide() -> None:
    from src.def_streamers.wr_board import build_wr_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    player_avgs = [
        {
            "player_id": "2",
            "player_name": "Jaxon Smith-Njigba",
            "last_name": "Smith-Njigba",
            "team": "SEA",
            "avg_half_ppr": 13.5,
            "games": 17,
        }
    ]
    defense_sos = {
        "NE": {"wr_half_ppr_allowed": 9.1, "sos_adj": 0.8, "n": 80},
    }
    board = build_wr_board(
        season=2026,
        week=1,
        stats_season=2025,
        stat_seasons=[2025],
        games=games,
        player_avgs=player_avgs,
        defense_sos=defense_sos,
        projected_players=[
            {
                "sleeper_id": "s2",
                "player": "Jaxon Smith-Njigba",
                "last_name": "Smith-Njigba",
                "team": "SEA",
                "position": "WR",
                "pts": 235.0,
            }
        ],
    )
    assert board["position"] == "WR"
    row = board["players"][0]
    assert row["last_name"] == "Smith-Njigba"
    assert row["sos_adj"] == 0.8
    # WR guide X falls back to the board median.
    assert board["guides"]["avg_half_ppr"] == board["medians"]["avg_half_ppr"]


def test_build_te_board_sos_matchup() -> None:
    from src.def_streamers.te_board import build_te_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    player_avgs = [
        {
            "player_id": "4",
            "player_name": "AJ Barner",
            "last_name": "Barner",
            "team": "SEA",
            "avg_half_ppr": 8.2,
            "games": 12,
        }
    ]
    defense_sos = {
        "NE": {"te_half_ppr_allowed": 7.4, "sos_adj": 0.6, "n": 40},
    }
    board = build_te_board(
        season=2026,
        week=1,
        stats_season=2025,
        stat_seasons=[2025],
        games=games,
        player_avgs=player_avgs,
        defense_sos=defense_sos,
        projected_players=[
            {
                "sleeper_id": "s4",
                "player": "AJ Barner",
                "last_name": "Barner",
                "team": "SEA",
                "position": "TE",
                "pts": 120.0,
            }
        ],
    )
    assert board["position"] == "TE"
    row = board["players"][0]
    assert row["last_name"] == "Barner"
    assert row["sos_adj"] == 0.6
    assert row["te_half_ppr_allowed"] == 7.4
    # TE guide X falls back to the board median (same as WR).
    assert board["guides"]["avg_half_ppr"] == board["medians"]["avg_half_ppr"]


def test_build_qb_board_implied_and_rush() -> None:
    from src.def_streamers.qb_board import build_qb_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    qb_rates = [
        {
            "player_id": "3",
            "player_name": "Sam Darnold",
            "last_name": "Darnold",
            "team": "SEA",
            "rush_yards_per_game": 12.5,
            "pass_attempts": 200,
            "games": 8,
        }
    ]
    board = build_qb_board(
        season=2026,
        week=1,
        stats_season=2025,
        stat_seasons=[2025],
        games=games,
        qb_rates=qb_rates,
        projected_players=[
            {
                "sleeper_id": "s3",
                "player": "Sam Darnold",
                "last_name": "Darnold",
                "team": "SEA",
                "position": "QB",
                "pts": 260.0,
            }
        ],
    )
    assert board["position"] == "QB"
    assert board["rush_window_games"] == 8
    assert board["proj_limit"] == 18
    assert "Top 18 Sleeper projected QBs" in board["stats_note"]
    row = board["players"][0]
    assert row["last_name"] == "Darnold"
    assert row["implied_team_total"] == 23.75
    assert row["rush_yards_per_game"] == 12.5


def test_qb_roster_remap_picks_current_team() -> None:
    from src.def_streamers.qb_board import build_qb_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": "CHI",
            "home_team": "MIN",
            "away_score": None,
            "home_score": None,
            "spread_line": -3.0,
            "total_line": 44.0,
        }
    ]
    # Stats still say ARI; roster override maps to MIN.
    qb_rates = [
        {
            "player_id": "00-0035228",
            "player_name": "Kyler Murray",
            "last_name": "Murray",
            "team": "MIN",
            "rush_yards_per_game": 35.0,
            "pass_attempts": 250,
            "games": 8,
        }
    ]
    board = build_qb_board(
        season=2026,
        week=1,
        stats_season=2025,
        stat_seasons=[2025],
        games=games,
        qb_rates=qb_rates,
        roster_teams={},
        projected_players=[
            {
                "sleeper_id": "s4",
                "player": "Kyler Murray",
                "last_name": "Murray",
                "team": "MIN",
                "position": "QB",
                "pts": 280.0,
            }
        ],
    )
    murray = next(p for p in board["players"] if p["last_name"] == "Murray")
    assert murray["team"] == "MIN"
    # spread_line=-3 → away favored by 3; MIN home implied = (44-3)/2 = 20.5
    assert murray["implied_team_total"] == 20.5
