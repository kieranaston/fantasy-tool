"""Build a draft-companion projection board from FantasyPros CSVs + league scoring."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from rapidfuzz import fuzz, process

from src.loaders.fantasypros_csv import load_season_csvs
from src.loaders.nfl_data import (
    DEFAULT_TEAM_COLOR,
    attach_team_branding,
    player_media_index,
    team_branding,
)
from src.loaders.sleeper_values import (
    ADP_FIELDS,
    fetch_sleeper_players_map,
    fetch_sleeper_value_rows,
)
from src.scoring.league_points import projected_points

POSITIONS = ("QB", "RB", "WR", "TE")
MATCH_THRESHOLD = 90.0

_SUFFIX_RE = re.compile(
    r"\b(jr\.?|sr\.?|ii|iii|iv|v)\b",
    re.IGNORECASE,
)


def normalize_player_name(name: str) -> str:
    text = unicodedata.normalize("NFKD", name or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("'", "").replace(".", " ")
    text = _SUFFIX_RE.sub("", text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _display_name(meta: dict[str, Any], sleeper_id: str) -> str:
    full = (meta.get("full_name") or "").strip()
    if full:
        return full
    first = (meta.get("first_name") or "").strip()
    last = (meta.get("last_name") or "").strip()
    name = f"{first} {last}".strip()
    return name or sleeper_id


def build_sleeper_name_index(
    players_map: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """norm_name → candidate sleeper player records (skill positions)."""
    index: dict[str, list[dict[str, Any]]] = {}
    for sleeper_id, meta in players_map.items():
        if not isinstance(meta, dict):
            continue
        pos = str(meta.get("position") or "").upper()
        if pos not in POSITIONS:
            continue
        # Skip non-players / practice squad noise when inactive forever — keep all.
        name = _display_name(meta, sleeper_id)
        key = normalize_player_name(name)
        if not key:
            continue
        index.setdefault(key, []).append(
            {
                "sleeper_id": str(sleeper_id),
                "player": name,
                "team": str(meta.get("team") or "").upper(),
                "position": pos,
                "meta": meta,
            }
        )
    return index


def match_to_sleeper(
    *,
    player: str,
    team: str,
    position: str,
    index: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    """Match FantasyPros row → Sleeper player (name + pos, prefer team)."""
    pos = position.upper()
    key = normalize_player_name(player)
    team_u = (team or "").upper()

    candidates = [
        c for c in (index.get(key) or []) if c["position"] == pos
    ]
    if candidates:
        if team_u:
            team_hits = [c for c in candidates if c["team"] == team_u]
            if len(team_hits) == 1:
                return team_hits[0]
            if len(team_hits) > 1:
                return team_hits[0]
        if len(candidates) == 1:
            return candidates[0]
        # Same name/pos, different teams — prefer listed team else first.
        return candidates[0]

    # Fuzzy fallback within same position.
    pool: dict[str, dict[str, Any]] = {}
    for group in index.values():
        for c in group:
            if c["position"] != pos:
                continue
            pool[c["player"]] = c
    if not pool:
        return None
    hit = process.extractOne(
        player,
        pool.keys(),
        scorer=fuzz.token_set_ratio,
    )
    if not hit or hit[1] < MATCH_THRESHOLD:
        return None
    matched = pool[hit[0]]
    if team_u and matched["team"] and matched["team"] != team_u:
        # Soft prefer team agreement; still accept high-confidence name match.
        if hit[1] < 95:
            return None
    return matched


def _adp_by_sleeper(
    *,
    season: int,
    format_hint: str = "half_ppr",
) -> dict[str, float]:
    """Optional ADP overlay from Sleeper projections (not FantasyPros)."""
    order_by = ADP_FIELDS.get(format_hint, "adp_half_ppr")
    try:
        rows = fetch_sleeper_value_rows(season=season, order_by=order_by)
    except Exception:
        return {}
    adp_field = ADP_FIELDS.get(format_hint, "adp_half_ppr")
    out: dict[str, float] = {}
    for item in rows:
        sleeper_id = str(item.get("player_id") or "").strip()
        if not sleeper_id:
            continue
        stats = item.get("stats") or {}
        raw = stats.get(adp_field)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value <= 0 or value >= 900:
            continue
        prev = out.get(sleeper_id)
        if prev is None or value < prev:
            out[sleeper_id] = value
    return out


def format_key_from_scoring(scoring_settings: dict[str, Any]) -> str:
    rec = scoring_settings.get("rec")
    try:
        r = float(rec) if rec is not None else 0.5
    except (TypeError, ValueError):
        r = 0.5
    if r >= 0.75:
        return "full_ppr"
    if r >= 0.25:
        return "half_ppr"
    return "std"


def build_custom_projections_board(
    *,
    season: int,
    league: dict[str, Any],
    players_map: dict[str, dict[str, Any]] | None = None,
    bye_weeks: dict[str, int] | None = None,
    include_adp: bool = True,
) -> dict[str, Any]:
    """Score FantasyPros CSVs with ``league['scoring_settings']`` for the draft UI.

    Output shape matches ``projections-*.json`` so the companion can swap boards.
    """
    scoring = league.get("scoring_settings") or {}
    if not scoring:
        raise ValueError("League payload missing scoring_settings")

    fp_rows = load_season_csvs(season)
    if players_map is None:
        players_map = fetch_sleeper_players_map()
    index = build_sleeper_name_index(players_map)
    format_key = format_key_from_scoring(scoring)
    adp_map = _adp_by_sleeper(season=season, format_hint=format_key) if include_adp else {}
    bye_weeks = bye_weeks or {}
    branding = team_branding()
    media = player_media_index(season=season)
    by_sleeper = media["by_sleeper_id"]

    matched: list[dict[str, Any]] = []
    unmatched: list[dict[str, str]] = []

    for row in fp_rows:
        hit = match_to_sleeper(
            player=row["player"],
            team=row.get("team") or "",
            position=row["position"],
            index=index,
        )
        if not hit:
            unmatched.append(
                {
                    "player": row["player"],
                    "team": row.get("team") or "",
                    "position": row["position"],
                }
            )
            continue

        sleeper_id = hit["sleeper_id"]
        meta = hit.get("meta") or players_map.get(sleeper_id) or {}
        media_row = by_sleeper.get(sleeper_id) or {}
        team = (
            hit.get("team")
            or row.get("team")
            or media_row.get("team")
            or meta.get("team")
            or ""
        ).upper()
        brand = attach_team_branding(team, branding)
        pts = projected_points(row["stats"], scoring, position=row["position"])
        adp = adp_map.get(sleeper_id)
        matched.append(
            {
                "player_id": f"sleeper:{sleeper_id}",
                "sleeper_id": sleeper_id,
                "player": hit["player"] or row["player"],
                "team": team,
                "position": row["position"],
                "logo": brand["logo"],
                "headshot": media_row.get("headshot"),
                "team_color": brand["team_color"] or DEFAULT_TEAM_COLOR,
                "pts": pts,
                "adp": round(float(adp), 1) if adp is not None else None,
                "bye_week": bye_weeks.get(team),
                "stats": row["stats"],
            }
        )

    matched.sort(key=lambda p: (-float(p["pts"]), p["player"]))
    for i, player in enumerate(matched, start=1):
        player["proj_rank"] = i

    return {
        "season": season,
        "format": "custom",
        "format_hint": format_key,
        "formats": ["custom"],
        "source": "fantasypros_csv",
        "league_id": str(league.get("league_id") or ""),
        "league_name": league.get("name"),
        "scoring_settings": scoring,
        "players": matched,
        "unmatched": unmatched,
        "matched_count": len(matched),
        "unmatched_count": len(unmatched),
    }
