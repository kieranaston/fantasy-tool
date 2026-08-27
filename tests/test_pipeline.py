from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.export.json_writer import utc_now_iso, write_json
from src.injuries.validate import claim_supported, validate_diff_summary, validate_extraction
from src.loaders.sleeper_adp import adp_merged_board, build_headshot_sidecar

ROOT = Path(__file__).resolve().parents[1]
DRAFT_DIR = ROOT / "docs" / "data" / "draft"


def test_utc_now_iso_is_zulu() -> None:
    value = utc_now_iso()
    assert value.endswith("Z")
    assert "T" in value


def test_write_json_requires_keys(tmp_path: Path) -> None:
    path = tmp_path / "out.json"
    write_json(path, {"a": 1, "b": 2}, {"a", "b"})
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {"a": 1, "b": 2}


def test_write_json_rejects_missing_keys(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Missing required keys"):
        write_json(tmp_path / "out.json", {"a": 1}, {"a", "b", "c"})


def test_claim_supported_substring() -> None:
    source = "Patrick Mahomes (knee) limited in practice."
    assert claim_supported("limited in practice", source)


def test_validate_extraction_rejects_ungrounded_quote() -> None:
    ok, failed = validate_extraction(
        {"status": "", "designation": "", "direct_quote": "made up quote"},
        "Patrick Mahomes limited in practice.",
    )
    assert ok is False
    assert "direct_quote" in failed


def test_validate_diff_summary_rejects_emoji() -> None:
    ok, failed = validate_diff_summary("Great news 🔥", ["source text"])
    assert ok is False
    assert "emoji" in failed


def test_adp_merged_board_shape() -> None:
    players = [
        {
            "sleeper_id": "1234",
            "player": "Test Player",
            "team": "KC",
            "position": "QB",
            "adp": {"half_ppr": 12.5, "full_ppr": 13.0, "std": 14.0},
        }
    ]
    board = adp_merged_board(players, byes={"KC": 10})
    assert len(board) == 1
    row = board[0]
    assert row["sleeper_id"] == "1234"
    assert row["adp"]["half_ppr"] == 12.5
    assert row["bye_week"] == 10


def test_build_headshot_sidecar() -> None:
    sidecar = build_headshot_sidecar(
        {"99": {"headshot": "https://example.com/a.jpg"}, "100": {"headshot": ""}},
        last_updated="2026-01-01T00:00:00Z",
    )
    assert sidecar["last_updated"] == "2026-01-01T00:00:00Z"
    assert sidecar["by_sleeper_id"] == {"99": "https://example.com/a.jpg"}


def test_published_adp_board_json_shape() -> None:
    path = DRAFT_DIR / "adp-board.json"
    if not path.exists():
        pytest.skip("adp-board.json not generated locally")
    payload = json.loads(path.read_text(encoding="utf-8"))
    for key in ("season", "source", "last_updated", "players"):
        assert key in payload
    assert isinstance(payload["players"], list)
    if payload["players"]:
        row = payload["players"][0]
        assert "sleeper_id" in row
        assert "adp" in row
