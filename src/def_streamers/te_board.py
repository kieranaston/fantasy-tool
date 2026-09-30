"""Weekly TE board (this-season expected vs actual half-PPR)."""

from __future__ import annotations

from typing import Any

from src.def_streamers.skill_matchup import build_skill_matchup_board


def build_te_board(**kwargs: Any) -> dict[str, Any]:
    return build_skill_matchup_board("TE", **kwargs)
