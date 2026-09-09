"""Build the public summaries.json payload for the static injuries page."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from src.injuries.calendar import parse_iso_datetime
from src.injuries.detect import group_reports_by_player

# Drop a player only when their *newest* update is older than this.
# Older timeline rows for still-fresh players are kept (up to TIMELINE_LIMIT).
NEWS_MAX_AGE = timedelta(days=28)
# Max source rows published per player (newest first). Not an age filter.
TIMELINE_LIMIT = 20
# Card blurb / source preview length; full text stays in pipeline state.
TIMELINE_TEXT_MAX = 280


def _player_is_fresh(player: dict[str, Any], *, cutoff: datetime) -> bool:
    """True when the player's most recent update is on/after cutoff."""
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
        # Keep history for active players; only cap count (not age per row).
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
        summary = (status.get("last_diff_summary") or "").strip()
        if not timeline and not summary:
            continue
        players.append(
            {
                "player_id": player_id,
                "player_name": status.get("player_name")
                or name_by_player.get(player_id),
                "last_updated": status.get("last_updated"),
                "summary": summary or None,
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
                "summary": None,
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
