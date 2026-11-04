"""Kickoff weather for the kicker board."""

from __future__ import annotations

import json

from src.loaders.weather import (
    game_weather,
    kicker_weather_index,
    kickoff_utc,
)


def _game(**overrides):
    game = {
        "game_id": "2026_09_GB_CHI",
        "home_team": "CHI",
        "away_team": "GB",
        "gameday": "2026-11-08",
        "gametime": "13:00",
        "roof": "outdoors",
        "location": "Home",
    }
    game.update(overrides)
    return game


def _fake_forecast(temp: float, wind: float):
    def http_get(url, timeout=30):
        times = [f"2026-11-08T{h:02d}:00" for h in range(24)]
        return json.dumps(
            {
                "hourly": {
                    "time": times,
                    "temperature_2m": [temp] * 24,
                    "wind_speed_10m": [wind] * 24,
                }
            }
        ).encode()

    return http_get


def test_weather_index_penalises_wind_and_cold() -> None:
    assert kicker_weather_index(0, 70) == 0
    assert kicker_weather_index(10, 70) == -1.0
    assert kicker_weather_index(0, 30) == -2.0
    assert kicker_weather_index(15, 20) == -4.5


def test_kickoff_converts_eastern_to_utc() -> None:
    # 13:00 ET on 2026-11-08 (after the clocks go back) is 18:00 UTC.
    assert kickoff_utc(_game()).strftime("%Y-%m-%d %H:%M") == "2026-11-08 18:00"
    assert kickoff_utc(_game(gametime="")) is None


def test_dome_games_use_ideal_conditions_without_a_forecast() -> None:
    def boom(*args, **kwargs):
        raise AssertionError("forecast should not be fetched for a dome")

    wx = game_weather(_game(home_team="DET", roof="dome"), http_get=boom)
    assert wx["weather_source"] == "indoors"
    assert wx["weather_index"] == 0


def test_retractable_roof_defaults_closed_unless_schedule_says_open() -> None:
    closed = game_weather(_game(home_team="DAL", roof=""), http_get=_fake_forecast(30, 20))
    assert closed["weather_source"] == "indoors"
    opened = game_weather(_game(home_team="DAL", roof="open"), http_get=_fake_forecast(30, 20))
    assert opened["weather_source"] == "forecast"


def test_outdoor_game_uses_forecast_at_kickoff() -> None:
    wx = game_weather(_game(), http_get=_fake_forecast(temp=30.0, wind=15.0))
    assert wx["weather_source"] == "forecast"
    assert wx["wind_mph"] == 15.0
    assert wx["temp_f"] == 30.0
    # -(15/10) - (20/10)
    assert wx["weather_index"] == -3.5


def test_forecast_failure_is_unavailable_not_an_error() -> None:
    def down(url, timeout=30):
        raise OSError("network down")

    wx = game_weather(_game(), http_get=down)
    assert wx["weather_source"] == "unavailable"
    assert wx["weather_index"] is None


def test_neutral_site_has_no_forecast() -> None:
    wx = game_weather(_game(location="Neutral"), http_get=_fake_forecast(30, 15))
    assert wx["weather_source"] == "unavailable"


def test_k_board_ranks_good_weather_ahead_and_neutral_fills_unknown() -> None:
    from src.def_streamers.k_board import build_k_board

    def game(gid, away, home):
        return {
            "season": 2026,
            "game_type": "REG",
            "week": 1,
            "away_team": away,
            "home_team": home,
            "away_score": None,
            "home_score": None,
            "spread_line": 0.0,
            "total_line": 44.0,
            "game_id": gid,
        }

    games = [game("g1", "NE", "SEA"), game("g2", "GB", "CHI"), game("g3", "DEN", "KC")]
    weather = {
        "g1": {
            "roof": "closed",
            "temp_f": 70.0,
            "wind_mph": 0.0,
            "weather_index": 0.0,
            "weather_source": "indoors",
        },
        "g2": {
            "roof": "open",
            "temp_f": 20.0,
            "wind_mph": 20.0,
            "weather_index": -5.0,
            "weather_source": "forecast",
        },
        "g3": {
            "roof": None,
            "temp_f": None,
            "wind_mph": None,
            "weather_index": None,
            "weather_source": "unavailable",
        },
    }
    projected = [
        {
            "sleeper_id": str(i),
            "player": f"K{i}",
            "last_name": f"K{i}",
            "team": t,
            "position": "K",
            "pts": 100.0,
        }
        for i, t in enumerate(["SEA", "NE", "CHI", "GB", "KC", "DEN"])
    ]
    board = build_k_board(
        season=2026, week=1, games=games, weather=weather, projected_players=projected
    )
    by_team = {t["team"]: t for t in board["teams"]}
    # Unknown weather is filled with the slate median of the known games.
    assert by_team["KC"]["weather_index"] == by_team["DEN"]["weather_index"]
    assert by_team["KC"]["weather_source"] == "unavailable"
    # Same implied totals everywhere, so the dome kickers lead and the windy ones trail.
    order = [t["team"] for t in board["teams"]]
    assert set(order[:2]) == {"SEA", "NE"}
    assert set(order[-2:]) == {"CHI", "GB"}
