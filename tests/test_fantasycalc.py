from __future__ import annotations

from src.loaders.fantasycalc import normalize_fc_values


def _row(sleeper_id, name, position, value, **extra):
    player = {"sleeperId": sleeper_id, "name": name, "position": position, **extra}
    return {"player": player, "value": value}


def test_normalize_filters_and_dedupes() -> None:
    rows = [
        _row("9221", "Jahmyr Gibbs", "RB", 10573, maybeTeam="DET", team=None)
        | {"overallRank": 1, "positionRank": 1, "maybeTier": 1},
        _row("9488", "Jaxon Smith-Njigba", "WR", 9826.4, maybeTeam="SEA")
        | {"overallRank": 3, "positionRank": 1, "maybeTier": 2},
        _row("", "No Id", "RB", 10) | {"overallRank": 200, "positionRank": 60},
        _row("9221", "Duplicate", "RB", 1) | {"overallRank": 99, "positionRank": 9},
        _row("9999", "Some Kicker", "K", 5) | {"overallRank": 210, "positionRank": 1},
        _row("8888", "Bad Value", "WR", "abc") | {"overallRank": 5},
    ]
    out = normalize_fc_values(rows)
    assert [r["sleeper_id"] for r in out] == ["9221", "9488"]
    first = out[0]
    assert first["value"] == 10573.0
    assert first["rank"] == 1 and first["pos_rank"] == 1 and first["tier"] == 1
    assert first["team"] == "DET"
    assert out[1]["value"] == 9826.4 and out[1]["team"] == "SEA"


def test_normalize_tolerates_missing_optionals() -> None:
    out = normalize_fc_values([_row("1", "X", "RB", 5)])
    row = out[0]
    assert row["rank"] is None
    assert row["pos_rank"] is None
    assert row["tier"] is None
    assert row["team"] == ""
