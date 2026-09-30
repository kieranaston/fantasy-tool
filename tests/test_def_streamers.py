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


def test_summarize_season_xfp_is_half_ppr_this_season_only() -> None:
    """Full-PPR published totals become half-PPR; other seasons and the slate week drop."""
    import polars as pl

    from src.loaders.nflverse import summarize_season_xfp

    df = pl.DataFrame(
        {
            "player_id": ["p1", "p1", "p1", "p1"],
            "full_name": ["A Receiver", "A Receiver", "A Receiver", "A Receiver"],
            "position": ["WR", "WR", "WR", "WR"],
            "season": [2025, 2026, 2026, 2026],
            "week": [17, 1, 3, 4],
            "game_id": ["2025_17", "2026_01", "2026_03", "2026_04"],
            "posteam": ["SEA", "SEA", "SEA", "SEA"],
            # Full PPR totals. Half-PPR = total - 0.5 * receptions.
            # Week 1: 10 - 0.5*4 = 8 actual, 12 - 0.5*6 = 9 expected.
            # Week 3: 6 - 0.5*2 = 5 actual, 8 - 0.5*2 = 7 expected.
            # Week 4 is the slate and 2025 is a prior season.
            "total_fantasy_points": [20.0, 10.0, 6.0, 30.0],
            "total_fantasy_points_exp": [18.0, 12.0, 8.0, 28.0],
            "receptions": [8.0, 4.0, 2.0, 10.0],
            "receptions_exp": [7.0, 6.0, 2.0, 9.0],
        }
    )
    rows = summarize_season_xfp(df, "WR", season=2026, as_of_week=4)
    assert len(rows) == 1
    row = rows[0]
    assert row["games"] == 2
    assert abs(row["fantasy_points"] - 6.5) < 1e-9
    assert abs(row["xfpts"] - 8.0) < 1e-9
    assert abs(row["fpoe"] - (6.5 - 8.0)) < 1e-9


def test_summarize_season_xfp_uses_last_four_games() -> None:
    import polars as pl

    from src.loaders.nflverse import summarize_season_xfp

    df = pl.DataFrame(
        {
            "player_id": ["p1"] * 5,
            "full_name": ["A Receiver"] * 5,
            "position": ["WR"] * 5,
            "season": [2026] * 5,
            "week": [1, 2, 3, 4, 5],
            "game_id": ["g1", "g2", "g3", "g4", "g5"],
            "posteam": ["SEA"] * 5,
            # Week 1 is outside a 4-game window. Receptions are 0 so points are raw.
            "total_fantasy_points": [100.0, 10.0, 12.0, 14.0, 16.0],
            "total_fantasy_points_exp": [0.0, 8.0, 8.0, 8.0, 8.0],
            "receptions": [0.0] * 5,
            "receptions_exp": [0.0] * 5,
        }
    )
    row = summarize_season_xfp(df, "WR", season=2026, as_of_week=6, window=4)[0]
    assert row["games"] == 4
    assert abs(row["fantasy_points"] - 13.0) < 1e-9
    assert abs(row["xfpts"] - 8.0) < 1e-9
    assert abs(row["fpoe"] - 5.0) < 1e-9


def test_filter_chart_season_drops_other_years_and_slate_week() -> None:
    import polars as pl

    from src.loaders.nflverse import _filter_chart_season

    df = pl.DataFrame(
        {
            "season": [2025, 2026, 2026, 2026],
            "week": [17, 1, 3, 4],
        }
    )
    kept = _filter_chart_season(df, season=2026, as_of_week=4)
    assert kept["week"].to_list() == [1, 3]


def test_filter_before_slate_excludes_target_week_and_later() -> None:
    """Same-week box scores must not place players on that week's chart."""
    import polars as pl

    from src.loaders.nflverse import _filter_before_slate

    df = pl.DataFrame(
        {
            "season": [2025, 2026, 2026, 2026],
            "week": [17, 1, 2, 3],
            "player_id": ["price", "price", "price", "price"],
            "half_ppr": [0.0, 6.8, 8.0, 9.0],
        }
    )
    # Week 1 chart: prior season only — a Week-1 debut has no usable history.
    w1 = _filter_before_slate(df, as_of_season=2026, as_of_week=1)
    assert w1.height == 1
    assert w1["week"].to_list() == [17]

    # Week 2 chart: Week 1 game is fair prior history.
    w2 = _filter_before_slate(df, as_of_season=2026, as_of_week=2)
    assert w2["week"].to_list() == [17, 1]


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
    board = build_def_board(
        season=2026,
        week=1,
        sack_season=2025,
        pbp_seasons=[2025],
        games=games,
        rates=rates,
    )
    assert board["week"] == 1
    assert board["sack_season"] == 2025
    assert "before week 1" in board["sack_note"]
    assert board["proj_limit"] == 18
    assert len(board["teams"]) == 2
    sea = next(t for t in board["teams"] if t["team"] == "SEA")
    assert sea["matchup_label"] == "vs NE"
    assert sea["vegas_projected_points"] == 20.75
    assert abs(sea["projected_sack_rate"] - projected_sack_rate(0.08, 0.09)) < 1e-9


def test_build_def_board_keeps_best_chart_score() -> None:
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
        max_players=1,
    )
    # SEA: higher sack blend and a lower opponent total.
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
    assert "before week 1" in board["fg_note"]
    assert board["proj_limit"] == 18
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


def test_build_rb_board_xfp_and_labels() -> None:
    from src.def_streamers.rb_board import build_rb_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 4,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    player_rows = [
        {
            "player_id": "1",
            "player_name": "Kenneth Walker III",
            "last_name": "Walker",
            "team": "SEA",
            "xfpts": 32.5,
            "fantasy_points": 38.0,
            "games": 3,
        }
    ]
    board = build_rb_board(
        season=2026,
        week=4,
        stats_season=2026,
        games=games,
        player_rows=player_rows,
    )
    assert len(board["players"]) == 1
    row = board["players"][0]
    assert row["last_name"] == "Walker"
    assert row["opponent"] == "NE"
    assert row["xfpts"] == 32.5
    assert row["fantasy_points"] == 38.0
    assert board["stat_seasons"] == [2026]
    assert "before week 4" in board["stats_note"]
    assert board["proj_limit"] == 30


def test_skill_board_keeps_best_chart_scores() -> None:
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
    player_rows = [
        {
            "player_id": "1",
            "player_name": "Kenneth Walker III",
            "last_name": "Walker",
            "team": "SEA",
            "xfpts": 30.0,
            "fantasy_points": 36.0,
            "games": 3,
        },
        {
            "player_id": "2",
            "player_name": "Zach Charbonnet",
            "last_name": "Charbonnet",
            "team": "SEA",
            "xfpts": 12.0,
            "fantasy_points": 10.0,
            "games": 3,
        },
        {
            "player_id": "3",
            "player_name": "Rhamondre Stevenson",
            "last_name": "Stevenson",
            "team": "NE",
            "xfpts": 22.0,
            "fantasy_points": 24.0,
            "games": 3,
        },
    ]
    board = build_rb_board(
        season=2026,
        week=1,
        stats_season=2026,
        games=games,
        player_rows=player_rows,
        max_players=2,
    )
    names = {p["last_name"] for p in board["players"]}
    assert names == {"Walker", "Stevenson"}
    assert "Charbonnet" not in names


def test_build_wr_board_uses_this_season_xfp() -> None:
    from src.def_streamers.wr_board import build_wr_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 4,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    player_rows = [
        {
            "player_id": "2",
            "player_name": "Jaxon Smith-Njigba",
            "last_name": "Smith-Njigba",
            "team": "SEA",
            "xfpts": 48.2,
            "fantasy_points": 55.0,
            "games": 3,
        }
    ]
    board = build_wr_board(
        season=2026,
        week=4,
        games=games,
        player_rows=player_rows,
    )
    assert board["position"] == "WR"
    assert board["stats_season"] == 2026
    assert board["stat_seasons"] == [2026]
    row = board["players"][0]
    assert row["last_name"] == "Smith-Njigba"
    assert row["xfpts"] == 48.2
    assert row["fantasy_points"] == 55.0
    assert board["medians"]["xfpts"] == 48.2
    assert board["medians"]["fpoe"] == 6.8


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
    player_rows = [
        {
            "player_id": "4",
            "player_name": "AJ Barner",
            "last_name": "Barner",
            "team": "SEA",
            "xfpts": 18.4,
            "fantasy_points": 21.0,
            "games": 3,
        }
    ]
    board = build_te_board(
        season=2026,
        week=1,
        games=games,
        player_rows=player_rows,
    )
    assert board["position"] == "TE"
    row = board["players"][0]
    assert row["last_name"] == "Barner"
    assert row["xfpts"] == 18.4
    assert row["fantasy_points"] == 21.0
    assert board["stats_season"] == 2026


def test_build_qb_board_xfp() -> None:
    from src.def_streamers.qb_board import build_qb_board

    games = [
        {
            "season": 2026,
            "game_type": "REG",
            "week": 4,
            "away_team": "NE",
            "home_team": "SEA",
            "away_score": None,
            "home_score": None,
            "spread_line": 3.0,
            "total_line": 44.5,
        }
    ]
    player_rows = [
        {
            "player_id": "3",
            "player_name": "Sam Darnold",
            "last_name": "Darnold",
            "team": "SEA",
            "xfpts": 52.0,
            "fantasy_points": 61.5,
            "games": 3,
        }
    ]
    board = build_qb_board(
        season=2026,
        week=4,
        games=games,
        player_rows=player_rows,
    )
    assert board["position"] == "QB"
    assert board["proj_limit"] == 18
    assert board["stat_seasons"] == [2026]
    assert "chart score" in board["stats_note"]
    row = board["players"][0]
    assert row["last_name"] == "Darnold"
    assert row["xfpts"] == 52.0
    assert row["fantasy_points"] == 61.5


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
    player_rows = [
        {
            "player_id": "00-0035228",
            "player_name": "Kyler Murray",
            "last_name": "Murray",
            "team": "MIN",
            "xfpts": 48.0,
            "fantasy_points": 44.0,
            "games": 3,
        }
    ]
    board = build_qb_board(
        season=2026,
        week=1,
        games=games,
        player_rows=player_rows,
        roster_teams={},
    )
    murray = next(p for p in board["players"] if p["last_name"] == "Murray")
    assert murray["team"] == "MIN"
    assert murray["matchup_label"] == "vs CHI"
