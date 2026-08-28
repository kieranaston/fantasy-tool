"""Fuzzy-match extracted player names to Sleeper player ids."""

from __future__ import annotations

from dataclasses import dataclass

from rapidfuzz import fuzz, process

from src.loaders.sleeper_players import display_name, fetch_sleeper_players


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
    """Sleeper player index for Bluesky name matching and news pool."""

    index: list[PlayerRef]
    by_name: dict[str, PlayerRef]
    by_id: dict[str, PlayerRef]


# Minimum rapidfuzz token_set_ratio to accept an automatic match.
MATCH_THRESHOLD = 88.0


def _normalize_position(raw: str | None) -> str | None:
    pos = str(raw or "").upper()
    if pos == "DST":
        return "DEF"
    if pos == "PK":
        return "K"
    return pos or None


def load_player_tables() -> PlayerTables:
    """Build a name index from Sleeper's NFL players dump."""
    players = fetch_sleeper_players()
    refs: list[PlayerRef] = []
    by_name: dict[str, PlayerRef] = {}
    by_id: dict[str, PlayerRef] = {}

    for sleeper_id, row in players.items():
        if not isinstance(row, dict):
            continue
        name = display_name(row)
        if not name:
            continue
        sid = str(sleeper_id).strip()
        team = str(row.get("team") or "").strip().upper() or None
        ref = PlayerRef(
            player_id=sid,
            name=name,
            team=team,
            position=_normalize_position(row.get("position")),
        )
        refs.append(ref)
        by_name[name] = ref
        by_id[sid] = ref

    return PlayerTables(index=refs, by_name=by_name, by_id=by_id)


def load_player_index() -> list[PlayerRef]:
    return load_player_tables().index


def name_choices(index: list[PlayerRef]) -> dict[str, PlayerRef]:
    return {ref.name: ref for ref in index}


def match_player_name(
    player_name: str | None,
    choices: dict[str, PlayerRef] | list[PlayerRef],
    *,
    threshold: float = MATCH_THRESHOLD,
) -> MatchResult:
    """Fuzzy-match a free-text name to a Sleeper id. Low confidence → review."""
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
