"""Build the public summaries.json payload for the static injuries page."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from src.injuries.calendar import parse_iso_datetime
from src.injuries.detect import group_reports_by_player

# Drop players whose newest post/status is older than this.
NEWS_MAX_AGE = timedelta(days=7)
# Cap published source history — UI only expands on demand.
TIMELINE_LIMIT = 4
# Card blurb only needs the start of the newest post; full text stays in pipeline.
TIMELINE_TEXT_MAX = 280


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
    """Slim source row — only fields the Sources expand UI needs."""
    item: dict[str, Any] = {}
    ts = report.get("timestamp")
    if ts:
        item["timestamp"] = ts
    text = (report.get("source_text") or "").strip()
    if text:
        item["source_text"] = text[:TIMELINE_TEXT_MAX]
    url = report.get("url")
    if url:
        item["url"] = url
    designation = (report.get("designation") or "").strip()
    if designation:
        item["designation"] = designation
    return item


def build_summaries(
    *,
    status_current: dict[str, Any],
    reports: list[dict[str, Any]],
    last_updated: str,
    allowed_player_ids: set[str] | None = None,
    teams_by_id: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Aggregate current status + report timeline per player."""
    grouped = group_reports_by_player(
        reports,
        allowed_player_ids=allowed_player_ids,
        skip_review=False,
        newest_first=True,
    )
    by_player: dict[str, list[dict[str, Any]]] = {}
    name_by_player: dict[str, str | None] = {}
    for pid, timeline in grouped.items():
        if timeline:
            name_by_player[pid] = timeline[0].get("player_name")
        by_player[pid] = [
            _timeline_item(report) for report in timeline[:TIMELINE_LIMIT]
        ]

    team_index = teams_by_id or {}

    def team_field(player_id: str, team: str | None) -> dict[str, Any]:
        resolved_team = (team or team_index.get(str(player_id)) or "") or None
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
        players.append(
            {
                "player_id": player_id,
                "player_name": status.get("player_name")
                or name_by_player.get(player_id),
                "last_updated": status.get("last_updated"),
                "timeline": timeline,
                **team_field(player_id, status.get("team")),
            }
        )

    # Also include matched players that only have timeline (no status yet)
    for player_id, timeline in by_player.items():
        if player_id in status_current:
            continue
        newest = timeline[0] if timeline else {}
        players.append(
            {
                "player_id": player_id,
                "player_name": name_by_player.get(player_id),
                "last_updated": newest.get("timestamp"),
                "timeline": timeline,
                **team_field(player_id, None),
            }
        )

    cutoff = (now or datetime.now(timezone.utc)) - NEWS_MAX_AGE
    before = len(players)
    players = [p for p in players if _player_is_fresh(p, cutoff=cutoff)]
    dropped = before - len(players)

    before_team = len(players)
    players = [
        p
        for p in players
        if str(p.get("team") or "").strip().upper() not in ("", "FA", "NONE")
    ]
    dropped += before_team - len(players)

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
