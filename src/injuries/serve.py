"""Build the public summaries.json payload for the static injuries page."""

from __future__ import annotations

from typing import Any


def build_summaries(
    *,
    status_current: dict[str, Any],
    reports: list[dict[str, Any]],
    last_updated: str,
    allowed_player_ids: set[str] | None = None,
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
                or (timeline[0].get("player_name") if timeline else None),
                "team": status.get("team"),
                "current_designation": status.get("current_designation"),
                "last_updated": status.get("last_updated"),
                "diff_summary": status.get("last_diff_summary"),
                "extraction": status.get("last_extraction"),
                "timeline": timeline,
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
                "player_name": newest.get("player_name"),
                "team": None,
                "current_designation": newest.get("designation"),
                "last_updated": newest.get("timestamp"),
                "diff_summary": None,
                "extraction": None,
                "timeline": timeline,
            }
        )

    players.sort(
        key=lambda p: p.get("last_updated") or "",
        reverse=True,
    )

    return {
        "title": "Player News",
        "last_updated": last_updated,
        "players": players,
    }
