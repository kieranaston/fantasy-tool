"""Load FantasyPros draft rankings CSV and match rows to Sleeper ids."""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz, process

from src.loaders.sleeper_players import MATCH_THRESHOLD, PlayerRef, PlayerTables, load_player_tables

_POS_DIGITS = re.compile(r"\d+$")
_NAME_SUFFIX = re.compile(
    r"\b(jr\.?|sr\.?|ii|iii|iv|v|vi)\b\.?$",
    re.IGNORECASE,
)

# Common FantasyPros nicknames → Sleeper full names.
_NAME_ALIASES = {
    "hollywood brown": "Marquise Brown",
}

# FantasyPros occasionally uses alternate team abbreviations.
_TEAM_ALIASES = {
    "JAC": "JAX",
    "WSH": "WAS",
}


@dataclass(frozen=True)
class FpRankRow:
    rank: int
    tier: int | None
    name: str
    team: str | None
    position: str | None


def normalize_fp_position(raw: str | None) -> str | None:
    pos = str(raw or "").strip().upper()
    if not pos:
        return None
    pos = _POS_DIGITS.sub("", pos)
    if pos in {"DST", "DEF", "D/ST"}:
        return "DEF"
    if pos in {"PK", "K"}:
        return "K"
    return pos or None


def parse_rankings_csv(path: Path) -> list[FpRankRow]:
    """Parse FantasyPros ALL rankings export (RK, TIERS, PLAYER NAME, TEAM, POS)."""
    rows: list[FpRankRow] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for raw in reader:
            name = str(raw.get("PLAYER NAME") or "").strip()
            if not name:
                continue
            try:
                rank = int(str(raw.get("RK") or "").strip())
            except ValueError:
                continue
            tier_raw = str(raw.get("TIERS") or "").strip()
            try:
                tier = int(tier_raw) if tier_raw else None
            except ValueError:
                tier = None
            team_raw = str(raw.get("TEAM") or "").strip().upper() or None
            team = _TEAM_ALIASES.get(team_raw, team_raw) if team_raw else None
            position = normalize_fp_position(raw.get("POS"))
            rows.append(
                FpRankRow(
                    rank=rank,
                    tier=tier,
                    name=name,
                    team=team,
                    position=position,
                )
            )
    rows.sort(key=lambda r: r.rank)
    return rows


def _last_name(name: str) -> str:
    cleaned = _NAME_SUFFIX.sub("", name.strip()).strip()
    parts = cleaned.split()
    return parts[-1].lower() if parts else ""


def match_fp_row(
    row: FpRankRow,
    tables: PlayerTables,
    *,
    threshold: float = MATCH_THRESHOLD,
) -> tuple[PlayerRef | None, float, bool]:
    """Fuzzy-match a FP row; prefer same team then same position."""
    names = [ref.name for ref in tables.index]
    if not names:
        return None, 0.0, True

    query_name = _NAME_ALIASES.get(row.name.strip().lower(), row.name)
    hits = process.extract(
        query_name,
        names,
        scorer=fuzz.token_set_ratio,
        limit=8,
    )
    query_last = _last_name(query_name)
    candidates: list[tuple[PlayerRef, float]] = []
    for matched_name, score, _ in hits:
        if float(score) < threshold:
            continue
        if _last_name(matched_name) != query_last:
            continue
        ref = tables.by_name.get(matched_name)
        if ref is None:
            continue
        candidates.append((ref, float(score)))

    if not candidates:
        return None, float(hits[0][1]) if hits else 0.0, True

    def sort_key(item: tuple[PlayerRef, float]) -> tuple[int, int, float]:
        ref, score = item
        team_ok = 0 if row.team and ref.team and row.team == ref.team else 1
        pos_ok = (
            0 if row.position and ref.position and row.position == ref.position else 1
        )
        return (team_ok, pos_ok, -score)

    candidates.sort(key=sort_key)
    best, score = candidates[0]
    return best, score, False


def build_fp_rankings_payload(
    csv_path: Path,
    *,
    season: int,
    last_updated: str,
    tables: PlayerTables | None = None,
) -> dict[str, Any]:
    tables = tables or load_player_tables()
    parsed = parse_rankings_csv(csv_path)
    players: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for row in parsed:
        ref, score, needs_review = match_fp_row(row, tables)
        if ref is None or needs_review:
            unmatched.append(
                {
                    "rank": row.rank,
                    "player": row.name,
                    "team": row.team,
                    "position": row.position,
                    "match_score": round(score, 1),
                }
            )
            continue
        if ref.player_id in seen_ids:
            unmatched.append(
                {
                    "rank": row.rank,
                    "player": row.name,
                    "team": row.team,
                    "position": row.position,
                    "match_score": round(score, 1),
                    "reason": "duplicate_sleeper_id",
                    "sleeper_id": ref.player_id,
                }
            )
            continue
        seen_ids.add(ref.player_id)
        players.append(
            {
                "sleeper_id": ref.player_id,
                "player": ref.name,
                "team": ref.team or row.team or "",
                "position": ref.position or row.position or "",
                "rank": row.rank,
                "tier": row.tier,
            }
        )

    return {
        "season": season,
        "source": "fantasypros_csv",
        "file": csv_path.name,
        "last_updated": last_updated,
        "matched": len(players),
        "unmatched": unmatched,
        "players": players,
    }
