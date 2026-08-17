"""Fuzzy-match extracted player names to GSIS player_ids."""

from __future__ import annotations

from dataclasses import dataclass

import nflreadpy as nfl
import polars as pl
from rapidfuzz import fuzz, process

from src.loaders.nfl_data import player_media_index


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


@dataclass(frozen=True)
class PlayerTables:
    """Roster index, Sleeper→GSIS map, and media from one nflverse load."""

    index: list[PlayerRef]
    sleeper_to_gsis: dict[str, str]
    by_name: dict[str, PlayerRef]
    media: dict[str, dict[str, dict]]


# Minimum rapidfuzz token_set_ratio to accept an automatic match.
MATCH_THRESHOLD = 88.0


def _sleeper_map_from_ids(ids: pl.DataFrame) -> dict[str, str]:
    mapped = ids.filter(
        pl.col("sleeper_id").is_not_null()
        & pl.col("gsis_id").is_not_null()
        & pl.col("gsis_id").cast(pl.Utf8).str.starts_with("00-")
    )
    return {
        str(row["sleeper_id"]): str(row["gsis_id"])
        for row in mapped.iter_rows(named=True)
    }


def load_player_tables(*, season: int | None = None) -> PlayerTables:
    """Load rosters + ID map once for matching, news-pool GSIS, and media."""
    media = player_media_index(season=season)
    ids = nfl.load_ff_playerids()
    sleeper_to_gsis = _sleeper_map_from_ids(ids)

    refs: dict[str, PlayerRef] = {}
    for gid, row in (media.get("by_gsis_id") or {}).items():
        pid = str(gid)
        name = row.get("player")
        if not pid.startswith("00-") or not name:
            continue
        refs[pid] = PlayerRef(
            player_id=pid,
            name=str(name),
            team=row.get("team"),
            position=row.get("position"),
        )

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

    index = list(refs.values())
    by_name = {ref.name: ref for ref in index}
    return PlayerTables(
        index=index,
        sleeper_to_gsis=sleeper_to_gsis,
        by_name=by_name,
        media=media,
    )


def load_player_index(season: int | None = None) -> list[PlayerRef]:
    """Build a name→GSIS index from current (or given) season rosters + IDs."""
    return load_player_tables(season=season).index


def sleeper_id_to_gsis() -> dict[str, str]:
    """Map Sleeper player id (str) → GSIS id."""
    return _sleeper_map_from_ids(nfl.load_ff_playerids())


def name_choices(index: list[PlayerRef]) -> dict[str, PlayerRef]:
    return {ref.name: ref for ref in index}


def match_player_name(
    player_name: str | None,
    choices: dict[str, PlayerRef] | list[PlayerRef],
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

    lookup = choices if isinstance(choices, dict) else name_choices(choices)
    hit = process.extractOne(
        player_name.strip(),
        lookup.keys(),
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
    ref = lookup[matched_name]
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
