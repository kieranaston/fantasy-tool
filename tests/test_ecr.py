from __future__ import annotations

from pathlib import Path

from src.loaders.fantasypros_rankings import build_fp_rankings_payload, parse_pos_rank
from src.loaders.sleeper_players import PlayerRef, PlayerTables


def _tables() -> PlayerTables:
    refs = [
        PlayerRef("1", "Ja'Marr Chase", "CIN", "WR"),
        PlayerRef("2", "Jahmyr Gibbs", "DET", "RB"),
        PlayerRef("3", "Bijan Robinson", "ATL", "RB"),
    ]
    return PlayerTables(
        index=refs,
        by_name={r.name: r for r in refs},
        by_id={r.player_id: r for r in refs},
    )


def test_parse_pos_rank() -> None:
    assert parse_pos_rank("WR12") == 12
    assert parse_pos_rank("DST3") == 3
    assert parse_pos_rank("rb1") == 1
    assert parse_pos_rank("K") is None
    assert parse_pos_rank(None) is None


def test_build_ecr_payload_includes_pos_rank(tmp_path: Path) -> None:
    csv_path = tmp_path / "ranks.csv"
    csv_path.write_text(
        '"RK",TIERS,"PLAYER NAME",TEAM,"POS"\n'
        '"1",1,"Ja\'Marr Chase",CIN,"WR1"\n'
        '"2",1,"Jahmyr Gibbs",DET,"RB1"\n'
        '"5",2,"Bijan Robinson",ATL,"RB3"\n',
        encoding="utf-8",
    )
    payload = build_fp_rankings_payload(
        csv_path,
        season=2026,
        last_updated="2026-01-01T00:00:00Z",
        tables=_tables(),
        include_pos_rank=True,
        source="fantasypros_ecr",
    )
    assert payload["source"] == "fantasypros_ecr"
    assert payload["matched"] == 3
    by_name = {p["player"]: p for p in payload["players"]}
    assert by_name["Ja'Marr Chase"]["pos_rank"] == 1
    assert by_name["Ja'Marr Chase"]["rank"] == 1
    assert by_name["Ja'Marr Chase"]["tier"] == 1
    assert by_name["Bijan Robinson"]["pos_rank"] == 3
    assert by_name["Bijan Robinson"]["rank"] == 5


def test_build_payload_omits_pos_rank_by_default(tmp_path: Path) -> None:
    csv_path = tmp_path / "ranks.csv"
    csv_path.write_text(
        '"RK",TIERS,"PLAYER NAME",TEAM,"POS"\n'
        '"1",1,"Ja\'Marr Chase",CIN,"WR1"\n',
        encoding="utf-8",
    )
    payload = build_fp_rankings_payload(
        csv_path,
        season=2026,
        last_updated="2026-01-01T00:00:00Z",
        tables=_tables(),
    )
    assert payload["source"] == "fantasypros_csv"
    assert "pos_rank" not in payload["players"][0]
