"""Unit tests for Sleeper projection chart pools (no network)."""

from __future__ import annotations

from src.def_streamers.projection_pool import (
    canonical_team,
    match_stats_for_projected,
    norm_player_name,
    top_projected_players,
)


def test_norm_player_name_strips_suffixes() -> None:
    assert norm_player_name("Kenneth Walker III") == "kennethwalker"
    assert norm_player_name("Kenneth Walker") == "kennethwalker"
    assert norm_player_name("Amon-Ra St. Brown") == "amonrastbrown"


def test_canonical_team_aliases() -> None:
    assert canonical_team("LAR") == "LA"
    assert canonical_team("WSH") == "WAS"
    assert canonical_team("SEA") == "SEA"


def test_top_projected_players_orders_and_caps() -> None:
    rows = [
        {
            "player_id": "1",
            "team": "DET",
            "player": {"first_name": "Jahmyr", "last_name": "Gibbs", "position": "RB"},
            "stats": {"pts_half_ppr": 299.9},
        },
        {
            "player_id": "2",
            "team": "ATL",
            "player": {"first_name": "Bijan", "last_name": "Robinson", "position": "RB"},
            "stats": {"pts_half_ppr": 292.9},
        },
        {
            "player_id": "3",
            "team": "SF",
            "player": {
                "first_name": "Christian",
                "last_name": "McCaffrey",
                "position": "RB",
            },
            "stats": {"pts_half_ppr": 256.0},
        },
        {
            "player_id": "9",
            "team": "BUF",
            "player": {"first_name": "Josh", "last_name": "Allen", "position": "QB"},
            "stats": {"pts_half_ppr": 361.5},
        },
    ]
    top = top_projected_players("RB", limit=2, season=2026, rows=rows)
    assert [r["player"] for r in top] == ["Jahmyr Gibbs", "Bijan Robinson"]
    assert top[0]["pts"] == 299.9


def test_match_stats_prefers_same_team() -> None:
    projected = [
        {
            "sleeper_id": "1",
            "player": "Kyren Williams",
            "team": "LAR",
            "position": "RB",
            "pts": 192.0,
        }
    ]
    stats = [
        {
            "player_id": "a",
            "player_name": "Kyren Williams",
            "team": "LA",
            "avg_half_ppr": 14.0,
        },
        {
            "player_id": "b",
            "player_name": "Kyren Williams",
            "team": "DAL",
            "avg_half_ppr": 99.0,
        },
    ]
    paired = match_stats_for_projected(projected, stats)
    assert len(paired) == 1
    assert paired[0][1]["player_id"] == "a"
