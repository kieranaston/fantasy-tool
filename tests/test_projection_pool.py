"""Unit tests for Sleeper projection chart pools (no network)."""

from __future__ import annotations

from src.def_streamers.projection_pool import (
    canonical_team,
    composite_scores,
    match_stats_for_projected,
    norm_player_name,
    percentile_ranks,
    rank_by_chart,
    top_projected_players,
)


def test_percentile_ranks_spread_and_ties() -> None:
    assert percentile_ranks([]) == []
    assert percentile_ranks([5.0]) == [0.5]
    # Sorted values get evenly spaced percentiles; ties share the average rank.
    assert percentile_ranks([10.0, 20.0, 30.0]) == [0.0, 0.5, 1.0]
    assert percentile_ranks([1.0, 1.0, 2.0]) == [0.25, 0.25, 1.0]


def test_composite_scores_weight_usage_over_efficiency() -> None:
    # Player A is the usage monster with a bad efficiency game; B is the reverse.
    xs = [30.0, 10.0]
    ys = [-5.0, 5.0]
    usage_heavy = composite_scores(xs, ys, x_weight=0.8, y_weight=0.2)
    assert usage_heavy[0] > usage_heavy[1]
    even = composite_scores(xs, ys, x_weight=0.5, y_weight=0.5)
    assert even[0] == even[1]


def test_composite_scores_flips_bad_axis() -> None:
    # y_sign=-1: lower y is better (e.g. opponent implied total).
    scores = composite_scores(
        [1.0, 2.0], [10.0, 20.0], y_sign=-1, x_weight=0.0, y_weight=1.0
    )
    assert scores == [1.0, 0.0]


def test_rank_by_chart_stores_score_and_orders() -> None:
    rows = [
        {"player_id": "low", "xfpts": 8.0, "fpoe": 1.0},
        {"player_id": "high", "xfpts": 22.0, "fpoe": 0.0},
        {"player_id": "mid", "xfpts": 15.0, "fpoe": 2.0},
    ]
    ranked = rank_by_chart(
        rows, x_key="xfpts", y_key="fpoe", x_weight=0.8, y_weight=0.2
    )
    assert [r["player_id"] for r in ranked] == ["high", "mid", "low"]
    assert all(0.0 <= r["chart_score"] <= 1.0 for r in ranked)


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
