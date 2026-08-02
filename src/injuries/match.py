"""Fuzzy-match extracted player names to GSIS player_ids."""

from __future__ import annotations

from dataclasses import dataclass

import nflreadpy as nfl
import polars as pl
from rapidfuzz import fuzz, process


@dataclass(frozen=True)
class PlayerRef:
    player_id: str
    name: str
    team: str | None = None
    position: str | None = None


@dataclass(frozen=True)
class MatchResult:
    player_id: str | None
    matched_name: str | None
    score: float
    needs_review: bool


# Minimum rapidfuzz token_set_ratio to accept an automatic match.
MATCH_THRESHOLD = 88.0


def load_player_index(season: int | None = None) -> list[PlayerRef]:
    """Build a name→GSIS index from current (or given) season rosters + IDs."""
    if season is None:
        season = int(nfl.get_current_season())

    try:
        rosters = nfl.load_rosters(seasons=season)
    except Exception:
        rosters = pl.DataFrame()

    refs: dict[str, PlayerRef] = {}

    if not rosters.is_empty():
        cleaned = rosters.filter(
            pl.col("gsis_id").is_not_null()
            & (pl.col("gsis_id").cast(pl.Utf8).str.len_chars() > 0)
            & pl.col("full_name").is_not_null()
        )
        for row in cleaned.iter_rows(named=True):
            pid = str(row["gsis_id"])
            refs[pid] = PlayerRef(
                player_id=pid,
                name=str(row["full_name"]),
                team=row.get("team"),
                position=row.get("position"),
            )

    ids = nfl.load_ff_playerids()
    mapped = ids.filter(
        pl.col("gsis_id").is_not_null()
        & pl.col("name").is_not_null()
        & pl.col("gsis_id").cast(pl.Utf8).str.starts_with("00-")
    )
    for row in mapped.iter_rows(named=True):
        pid = str(row["gsis_id"])
        if pid not in refs:
            refs[pid] = PlayerRef(
                player_id=pid,
                name=str(row["name"]),
                team=row.get("team"),
                position=row.get("position"),
            )

    return list(refs.values())


def sleeper_id_to_gsis() -> dict[str, str]:
    """Map Sleeper player id (str) → GSIS id."""
    ids = nfl.load_ff_playerids()
    mapped = ids.filter(
        pl.col("sleeper_id").is_not_null()
        & pl.col("gsis_id").is_not_null()
        & pl.col("gsis_id").cast(pl.Utf8).str.starts_with("00-")
    )
    return {
        str(row["sleeper_id"]): str(row["gsis_id"])
        for row in mapped.iter_rows(named=True)
    }


def match_player_name(
    player_name: str | None,
    index: list[PlayerRef],
    *,
    threshold: float = MATCH_THRESHOLD,
) -> MatchResult:
    """Fuzzy-match a free-text name to a GSIS id. Low confidence → review."""
    if not player_name or not player_name.strip():
        return MatchResult(
            player_id=None,
            matched_name=None,
            score=0.0,
            needs_review=True,
        )

    choices = {ref.name: ref for ref in index}
    hit = process.extractOne(
        player_name.strip(),
        choices.keys(),
        scorer=fuzz.token_set_ratio,
    )
    if hit is None:
        return MatchResult(
            player_id=None,
            matched_name=None,
            score=0.0,
            needs_review=True,
        )

    matched_name, score, _ = hit
    ref = choices[matched_name]
    query_last = player_name.strip().split()[-1].lower()
    matched_last = matched_name.split()[-1].lower()
    last_name_ok = query_last == matched_last
    if score < threshold or not last_name_ok:
        return MatchResult(
            player_id=None,
            matched_name=matched_name,
            score=float(score),
            needs_review=True,
        )
    return MatchResult(
        player_id=ref.player_id,
        matched_name=ref.name,
        score=float(score),
        needs_review=False,
    )
