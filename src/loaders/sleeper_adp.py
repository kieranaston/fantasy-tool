"""Sleeper ADP helpers used to scope player-news to a draft-relevant pool.

ADP is not a projection — Sleeper attaches draft ADP fields on the same
player-season payload that also carries RotoWire projections.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx

from src.config.scoring import FORMATS as FORMAT_KEYS
from src.config.scoring import SKILL_POSITIONS

SLEEPER_ADP_URL = (
    "https://api.sleeper.com/projections/nfl/{season}"
    "?season_type=regular"
    "&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
    "&position[]=DEF&position[]=K"
    "&order_by={order_by}"
)

FORMATS = {
    "half_ppr": "adp_half_ppr",
    "full_ppr": "adp_ppr",
    "std": "adp_std",
}

POSITIONS = SKILL_POSITIONS

# Published draft/ADP board depth: top overall OR enough per position so
# late DEF/K still appear for search and position tabs.
ADP_BOARD_OVERALL = 280
ADP_BOARD_POS_LIMITS = {
    "QB": 32,
    "RB": 72,
    "WR": 72,
    "TE": 28,
    "DEF": 24,
    "K": 24,
}

# News-pool depth by position ADP rank.
POSITION_LIMITS = {
    "QB": 25,
    "RB": 45,
    "WR": 45,
    "TE": 25,
    "DEF": 32,
    "K": 32,
}

# Sleeper uses ~999 as a sentinel for "no ADP".
ADP_SENTINEL = 900.0


def fetch_sleeper_projections(
    *,
    season: int,
    order_by: str = "adp_ppr",
    timeout: float = 60.0,
) -> list[dict[str, Any]]:
    """Fetch season projection rows (includes ADP fields) for skill positions."""
    url = SLEEPER_ADP_URL.format(season=season, order_by=order_by)
    response = httpx.get(
        url,
        headers={"User-Agent": "fantasy-tool/0.1"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected Sleeper projections payload: {type(payload)}")
    return payload


def _display_name(player: dict[str, Any], sleeper_id: str) -> str:
    full = (player.get("full_name") or "").strip()
    if full:
        return full
    first = (player.get("first_name") or "").strip()
    last = (player.get("last_name") or "").strip()
    name = f"{first} {last}".strip()
    return name or sleeper_id


def draft_season_from_sleeper_state() -> int:
    """Read current fantasy season from Sleeper state (fallback: calendar)."""
    response = httpx.get(
        "https://api.sleeper.app/v1/state/nfl",
        headers={"User-Agent": "fantasy-tool/0.1"},
        timeout=30.0,
    )
    response.raise_for_status()
    state = response.json()
    season = state.get("league_season") or state.get("season")
    return int(season)


def normalize_adp_slim(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """ADP-only records from Sleeper projection rows (no nflverse / media)."""
    best: dict[str, dict[str, Any]] = {}
    for item in rows:
        sleeper_id = str(item.get("player_id") or "").strip()
        if not sleeper_id:
            continue
        player = item.get("player") or {}
        position = (player.get("position") or item.get("position") or "").upper()
        if position == "DST":
            position = "DEF"
        if position == "PK":
            position = "K"
        if position not in POSITIONS:
            continue

        stats = item.get("stats") or {}
        adp_values: dict[str, float] = {}
        for format_key, field in FORMATS.items():
            raw = stats.get(field)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value >= ADP_SENTINEL:
                continue
            adp_values[format_key] = value
        if not adp_values:
            continue

        team = (item.get("team") or player.get("team") or player.get("team_abbr") or "")
        team = str(team).upper() if team else ""
        existing = best.get(sleeper_id)
        if existing is None:
            best[sleeper_id] = {
                "sleeper_id": sleeper_id,
                "player": _display_name(player, sleeper_id),
                "team": team,
                "position": position,
                "adp": adp_values,
            }
            continue

        for format_key, value in adp_values.items():
            prev = existing["adp"].get(format_key)
            if prev is None or value < prev:
                existing["adp"][format_key] = value
        if not existing.get("team") and team:
            existing["team"] = team

    return list(best.values())


def adp_board_for_format(
    players: list[dict[str, Any]],
    *,
    format_key: str,
    byes: dict[str, int] | None = None,
    headshots: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Slim public ADP rows for one scoring format.

    Logos are omitted — the client builds them from team abbrev. Headshots are
    optional enrichment. Depth is capped so Pages stays small while still
    covering a full draft + late DEF/K.
    """
    bye_map = byes or {}
    ranked: list[dict[str, Any]] = []
    for player in players:
        adp = (player.get("adp") or {}).get(format_key)
        if adp is None:
            continue
        team = player.get("team") or ""
        sleeper_id = player["sleeper_id"]
        media = (headshots or {}).get(str(sleeper_id)) or {}
        row: dict[str, Any] = {
            "sleeper_id": sleeper_id,
            "player": player["player"],
            "team": team,
            "position": player["position"],
            "adp": round(float(adp), 1),
        }
        # Prefer pipeline headshot; fall back to anything already on the player.
        headshot = media.get("headshot") or player.get("headshot")
        if headshot:
            row["headshot"] = headshot
        bye = bye_map.get(str(team).upper()) if team else None
        if bye is not None:
            row["bye_week"] = int(bye)
        ranked.append(row)

    ranked.sort(key=lambda row: (row["adp"], row["player"]))

    kept: list[dict[str, Any]] = []
    seen: set[str] = set()
    pos_counts = {pos: 0 for pos in ADP_BOARD_POS_LIMITS}
    for index, row in enumerate(ranked):
        sid = str(row["sleeper_id"])
        if sid in seen:
            continue
        pos = row.get("position")
        pos_limit = ADP_BOARD_POS_LIMITS.get(pos)
        keep = index < ADP_BOARD_OVERALL or (
            pos_limit is not None and pos_counts.get(pos, 0) < pos_limit
        )
        if not keep:
            continue
        seen.add(sid)
        if pos in pos_counts:
            pos_counts[pos] += 1
        kept.append(row)
    return kept


def adp_merged_board(
    players: list[dict[str, Any]],
    *,
    byes: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    """One row per player with all format ADPs (no headshots — use sidecar)."""
    half = adp_board_for_format(
        players,
        format_key="half_ppr",
        byes=byes,
        headshots=None,
    )
    by_id = {str(p["sleeper_id"]): p for p in players}
    merged: list[dict[str, Any]] = []
    for row in half:
        sid = str(row["sleeper_id"])
        src = by_id.get(sid) or {}
        adp_values = src.get("adp") or {}
        adp_out: dict[str, float] = {}
        for format_key in FORMAT_KEYS:
            raw = adp_values.get(format_key)
            if raw is None:
                continue
            adp_out[format_key] = round(float(raw), 1)
        if not adp_out:
            continue
        out: dict[str, Any] = {
            "sleeper_id": sid,
            "player": row["player"],
            "team": row.get("team") or "",
            "position": row["position"],
            "adp": adp_out,
        }
        if row.get("bye_week") is not None:
            out["bye_week"] = row["bye_week"]
        merged.append(out)
    return merged


def build_headshot_sidecar(
    headshots: dict[str, dict[str, Any]] | None,
    *,
    last_updated: str,
) -> dict[str, Any]:
    """Sleeper id → headshot URL sidecar for ADP/draft pages."""
    by_id: dict[str, str] = {}
    for sid, row in (headshots or {}).items():
        url = (row or {}).get("headshot")
        if url:
            by_id[str(sid)] = str(url)
    return {"last_updated": last_updated, "by_sleeper_id": by_id}


def _default_adp_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "docs" / "data" / "draft"


def _load_published_boards(adp_dir: Path) -> dict[str, list[dict[str, Any]]] | None:
    merged_path = adp_dir / "adp-board.json"
    if merged_path.exists():
        try:
            payload = json.loads(merged_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        rows = payload.get("players") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return None
        boards: dict[str, list[dict[str, Any]]] = {key: [] for key in FORMAT_KEYS}
        for row in rows:
            if not isinstance(row, dict):
                continue
            adp_map = row.get("adp") or {}
            if not isinstance(adp_map, dict):
                continue
            base = {
                "sleeper_id": row.get("sleeper_id"),
                "player": row.get("player"),
                "team": row.get("team"),
                "position": row.get("position"),
                "bye_week": row.get("bye_week"),
            }
            for format_key in FORMAT_KEYS:
                adp = adp_map.get(format_key)
                if adp is None:
                    continue
                boards[format_key].append({**base, "adp": adp})
        for format_key in FORMAT_KEYS:
            boards[format_key].sort(
                key=lambda r: (float(r["adp"]), str(r.get("player") or ""))
            )
        return boards

    boards: dict[str, list[dict[str, Any]]] = {}
    for format_key in FORMAT_KEYS:
        path = adp_dir / f"adp-{format_key.replace('_', '-')}.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        players = payload.get("players") if isinstance(payload, dict) else None
        if not isinstance(players, list):
            return None
        boards[format_key] = players
    return boards


def _position_pool_ids_from_board(
    players: list[dict[str, Any]],
    sleeper_to_gsis: dict[str, str],
) -> set[str]:
    """Player IDs in the per-position ADP caps (board is already ADP-sorted)."""
    allowed: set[str] = set()
    taken = {pos: 0 for pos in POSITION_LIMITS}
    for row in players:
        position = row.get("position")
        limit = POSITION_LIMITS.get(position) if position else None
        if limit is None or taken[position] >= limit:
            continue
        taken[position] += 1
        sid = str(row.get("sleeper_id") or "").strip()
        if not sid:
            continue
        allowed.add(sleeper_to_gsis.get(sid) or f"sleeper:{sid}")
    return allowed


def load_news_pool_ids(
    *,
    season: int | None = None,
    sleeper_to_gsis: dict[str, str] | None = None,
    adp_dir: Path | None = None,
) -> set[str]:
    """Player IDs in the ADP depth caps (overall union of position pools)."""
    if sleeper_to_gsis is None:
        from src.injuries.match import sleeper_id_to_gsis

        sleeper_to_gsis = sleeper_id_to_gsis()

    boards = _load_published_boards(adp_dir or _default_adp_dir())
    if boards is None:
        if season is None:
            season = draft_season_from_sleeper_state()
        raw = fetch_sleeper_projections(season=season, order_by="adp_ppr")
        slim = normalize_adp_slim(raw)
        boards = {
            format_key: adp_board_for_format(slim, format_key=format_key)
            for format_key in FORMAT_KEYS
        }

    ids: set[str] = set()
    for players in boards.values():
        ids |= _position_pool_ids_from_board(players, sleeper_to_gsis)
    return ids
