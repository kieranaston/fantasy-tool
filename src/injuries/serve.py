"""Build the public summaries.json payload for the static injuries page."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from src.loaders.nfl_data import (
    DEFAULT_TEAM_COLOR,
    attach_team_branding,
    player_media_index,
    team_branding,
)

# Drop players whose newest post/status is older than this.
NEWS_MAX_AGE = timedelta(days=14)


def _parse_timestamp(raw: Any) -> datetime | None:
    if not raw:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _player_is_fresh(player: dict[str, Any], *, cutoff: datetime) -> bool:
    """Keep players whose most recent update is on/after cutoff."""
    ts = _parse_timestamp(player.get("last_updated"))
    if ts is None:
        timeline = player.get("timeline") or []
        if timeline:
            ts = _parse_timestamp(timeline[0].get("timestamp"))
    if ts is None:
        return False
    return ts >= cutoff


def build_summaries(
    *,
    status_current: dict[str, Any],
    reports: list[dict[str, Any]],
    last_updated: str,
    allowed_player_ids: set[str] | None = None,
    season: int | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Aggregate current status + report timeline per player."""
    by_player: dict[str, list[dict[str, Any]]] = {}
    for report in reports:
        pid = report.get("player_id")
        if not pid:
            continue
        if allowed_player_ids is not None and pid not in allowed_player_ids:
            continue
        by_player.setdefault(pid, []).append(
            {
                "id": report.get("id"),
                "timestamp": report.get("timestamp"),
                "designation": report.get("designation"),
                "source_text": report.get("source_text"),
                "url": report.get("url"),
                "source_type": report.get("source_type"),
                "player_name": report.get("player_name"),
            }
        )

    for timeline in by_player.values():
        timeline.sort(key=lambda r: r.get("timestamp") or "", reverse=True)

    branding = team_branding()
    media = player_media_index(season=season)
    by_gsis = media["by_gsis_id"]

    def enrich(player_id: str, team: str | None) -> dict[str, Any]:
        media_row = by_gsis.get(str(player_id)) or {}
        resolved_team = (team or media_row.get("team") or "") or None
        if resolved_team:
            resolved_team = str(resolved_team).upper()
        brand = attach_team_branding(resolved_team, branding)
        return {
            "team": resolved_team,
            "logo": brand["logo"],
            "headshot": media_row.get("headshot"),
            "team_color": brand["team_color"] or DEFAULT_TEAM_COLOR,
        }

    players: list[dict[str, Any]] = []
    for player_id, status in status_current.items():
        if allowed_player_ids is not None and player_id not in allowed_player_ids:
            continue
        timeline = by_player.get(player_id, [])
        if not timeline and not status.get("last_diff_summary"):
            continue
        media_fields = enrich(player_id, status.get("team"))
        players.append(
            {
                "player_id": player_id,
                "player_name": status.get("player_name")
                or (timeline[0].get("player_name") if timeline else None),
                "current_designation": status.get("current_designation"),
                "last_updated": status.get("last_updated"),
                "diff_summary": status.get("last_diff_summary"),
                "timeline": timeline,
                **media_fields,
            }
        )

    # Also include matched players that only have timeline (no status yet)
    for player_id, timeline in by_player.items():
        if player_id in status_current:
            continue
        newest = timeline[0] if timeline else {}
        media_fields = enrich(player_id, None)
        players.append(
            {
                "player_id": player_id,
                "player_name": newest.get("player_name"),
                "current_designation": newest.get("designation"),
                "last_updated": newest.get("timestamp"),
                "diff_summary": None,
                "timeline": timeline,
                **media_fields,
            }
        )

    cutoff = (now or datetime.now(timezone.utc)) - NEWS_MAX_AGE
    before = len(players)
    players = [p for p in players if _player_is_fresh(p, cutoff=cutoff)]
    dropped = before - len(players)

    players.sort(
        key=lambda p: p.get("last_updated") or "",
        reverse=True,
    )

    return {
        "title": "Player News",
        "last_updated": last_updated,
        "players": players,
        "news_max_age_days": NEWS_MAX_AGE.days,
        "dropped_stale": dropped,
    }
