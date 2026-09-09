"""Match post text to Sleeper player ids (ADP pool name tokens + fuzzy)."""

from __future__ import annotations

import re
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
class PoolNameHit:
    """A pool player found via first/last/full name in post text."""

    ref: PlayerRef
    method: str  # full | last | first


@dataclass(frozen=True)
class PlayerTables:
    """Sleeper player index for Bluesky name matching and news pool."""

    index: list[PlayerRef]
    by_name: dict[str, PlayerRef]
    by_id: dict[str, PlayerRef]


# Minimum rapidfuzz token_set_ratio to accept an automatic match.
MATCH_THRESHOLD = 88.0

_NAME_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
_NAME_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv", "v"})
# Skip tiny tokens ("Bo") and noise that floods false positives.
_MIN_TOKEN_LEN = 3


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


def pool_refs_for_ids(
    tables: PlayerTables,
    player_ids: set[str],
) -> list[PlayerRef]:
    """Resolve ADP news-pool ids to PlayerRef rows."""
    refs: list[PlayerRef] = []
    for pid in player_ids:
        ref = tables.by_id.get(str(pid))
        if ref is not None:
            refs.append(ref)
    return refs


def _name_parts(full_name: str) -> tuple[str | None, str | None]:
    """Return (first, last) tokens, dropping Jr/III-style suffixes."""
    parts = [
        p
        for p in _NAME_TOKEN_RE.findall(full_name or "")
        if p.lower() not in _NAME_SUFFIXES
    ]
    if not parts:
        return None, None
    if len(parts) == 1:
        return None, parts[0]
    return parts[0], parts[-1]


def _token_in_text(token: str, text: str) -> bool:
    """Whole-token match (apostrophes/hyphens allowed inside the token)."""
    cleaned = (token or "").strip()
    if len(cleaned) < _MIN_TOKEN_LEN:
        return False
    pattern = re.compile(
        rf"(?<![A-Za-z']){re.escape(cleaned)}(?![A-Za-z'])",
        re.IGNORECASE,
    )
    return pattern.search(text or "") is not None


def _full_name_in_text(name: str, text: str) -> bool:
    parts = [
        p
        for p in _NAME_TOKEN_RE.findall(name or "")
        if p.lower() not in _NAME_SUFFIXES
    ]
    if len(parts) < 2:
        return _token_in_text(name, text)
    # Require contiguous first…last span so middle initials still match.
    first, last = parts[0], parts[-1]
    pattern = re.compile(
        rf"(?<![A-Za-z']){re.escape(first)}(?:\s+[A-Za-z][A-Za-z'-]*)*"
        rf"\s+{re.escape(last)}(?![A-Za-z'])",
        re.IGNORECASE,
    )
    return pattern.search(text or "") is not None


def match_pool_names_in_text(
    text: str,
    pool: list[PlayerRef],
) -> list[PoolNameHit]:
    """Find ADP-pool players by full name, then unique last, then unique first.

    Ambiguous tokens (e.g. several Johnsons) are ignored unless the full name
    appears. Short tokens under 3 chars are skipped.
    """
    if not text or not pool:
        return []

    by_first: dict[str, list[PlayerRef]] = {}
    by_last: dict[str, list[PlayerRef]] = {}
    for ref in pool:
        first, last = _name_parts(ref.name)
        if first and len(first) >= _MIN_TOKEN_LEN:
            by_first.setdefault(first.lower(), []).append(ref)
        if last and len(last) >= _MIN_TOKEN_LEN:
            by_last.setdefault(last.lower(), []).append(ref)

    hits: dict[str, PoolNameHit] = {}

    for ref in pool:
        if _full_name_in_text(ref.name, text):
            hits[ref.player_id] = PoolNameHit(ref=ref, method="full")

    for _key, refs in by_last.items():
        if len(refs) != 1:
            continue
        ref = refs[0]
        if ref.player_id in hits:
            continue
        _, last = _name_parts(ref.name)
        if last and _token_in_text(last, text):
            hits[ref.player_id] = PoolNameHit(ref=ref, method="last")

    for _key, refs in by_first.items():
        if len(refs) != 1:
            continue
        ref = refs[0]
        if ref.player_id in hits:
            continue
        first, _ = _name_parts(ref.name)
        if first and _token_in_text(first, text):
            hits[ref.player_id] = PoolNameHit(ref=ref, method="first")

    return list(hits.values())


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
