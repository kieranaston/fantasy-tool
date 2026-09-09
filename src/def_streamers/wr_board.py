"""Build weekly fantasy WR matchup board (avg FPs × opponent SOS)."""

from __future__ import annotations

from typing import Any

from src.def_streamers.skill_matchup import build_skill_matchup_board


def build_wr_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("WR", **kwargs)
