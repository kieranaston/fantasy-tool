"""Build the public summaries.json payload for the static injuries page."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from src.injuries.calendar import parse_iso_datetime
from src.injuries.detect import group_reports_by_player
from src.loaders.nfl_data import player_media_index

# Drop players whose newest post/status is older than this.
NEWS_MAX_AGE = timedelta(days=14)


def _player_is_fresh(player: dict[str, Any], *, cutoff: datetime) -> bool:
    """Keep players whose most recent update is on/after cutoff."""
    ts = parse_iso_datetime(player.get("last_updated"))
    if ts is None:
        timeline = player.get("timeline") or []
        if timeline:
            ts = parse_iso_datetime(timeline[0].get("timestamp"))
    if ts is None:
        return False
    return ts >= cutoff


def _timeline_item(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": report.get("id"),
        "timestamp": report.get("timestamp"),
        "designation": report.get("designation"),
        "source_text": report.get("source_text"),
        "url": report.get("url"),
        "source_type": report.get("source_type"),
        "player_name": report.get("player_name"),
    }


def _latest_post_text(timeline: list[dict[str, Any]], status: dict[str, Any] | None = None) -> str | None:
    """Card blurb is the newest source post, not an LLM writeup."""
    if timeline:
        text = (timeline[0].get("source_text") or "").strip()
        if text:
            return text
        designation = (timeline[0].get("designation") or "").strip()
        if designation:
            return designation
    if status:
        text = (status.get("last_diff_summary") or "").strip()
        if text:
            return text
    return None


def build_summaries(
    *,
    status_current: dict[str, Any],
    reports: list[dict[str, Any]],
    last_updated: str,
    allowed_player_ids: set[str] | None = None,
    season: int | None = None,
    now: datetime | None = None,
    media: dict[str, dict[str, dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Aggregate current status + report timeline per player."""
    grouped = group_reports_by_player(
        reports,
        allowed_player_ids=allowed_player_ids,
        skip_review=False,
        newest_first=True,
    )
    by_player = {
        pid: [_timeline_item(report) for report in timeline]
        for pid, timeline in grouped.items()
    }

    media = media if media is not None else player_media_index(season=season)
    by_gsis = media["by_gsis_id"]

    def enrich(player_id: str, team: str | None) -> dict[str, Any]:
        media_row = by_gsis.get(str(player_id)) or {}
        resolved_team = (team or media_row.get("team") or "") or None
        if resolved_team:
            resolved_team = str(resolved_team).upper()
        return {"team": resolved_team}

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
                "diff_summary": _latest_post_text(timeline, status),
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
                "diff_summary": _latest_post_text(timeline),
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
