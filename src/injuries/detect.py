"""Change detection: new report vs last summarized report for a player."""

from __future__ import annotations

from typing import Any


def group_reports_by_player(
    reports: list[dict[str, Any]],
    *,
    allowed_player_ids: set[str] | None = None,
    skip_review: bool = True,
    newest_first: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    """Group matched reports by player_id in one pass."""
    by_player: dict[str, list[dict[str, Any]]] = {}
    for report in reports:
        player_id = report.get("player_id")
        if not player_id:
            continue
        if skip_review and report.get("needs_review"):
            continue
        if allowed_player_ids is not None and player_id not in allowed_player_ids:
            continue
        by_player.setdefault(player_id, []).append(report)

    for timeline in by_player.values():
        timeline.sort(key=lambda r: r.get("timestamp") or "", reverse=newest_first)
    return by_player


def detect_changes(
    reports: list[dict[str, Any]],
    status_current: dict[str, Any],
    *,
    allowed_player_ids: set[str] | None = None,
    by_player: dict[str, list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    """Return players that need a (re)summary.

    Triggers when there is no status yet, the newest matched report differs
    from stored ``last_report_*``, or a status exists without
    ``last_diff_summary`` (so quota failures are filled on the next run).
    """
    grouped = by_player
    if grouped is None:
        grouped = group_reports_by_player(
            reports,
            allowed_player_ids=allowed_player_ids,
            skip_review=True,
        )

    changed: list[dict[str, Any]] = []
    for player_id, timeline in grouped.items():
        if not timeline:
            continue
        report = max(timeline, key=lambda r: r.get("timestamp") or "")
        stored = status_current.get(player_id) or {}
        if stored:
            has_summary = bool((stored.get("last_diff_summary") or "").strip())
            last_url = stored.get("last_report_url")
            last_id = stored.get("last_report_id")
            report_url = report.get("url")
            report_id = report.get("id")
            same_report = bool(
                (last_url and report_url and last_url == report_url)
                or (last_id and report_id and last_id == report_id)
            )
            if same_report and has_summary and not stored.get("summary_fallback"):
                continue
            if not last_url and not last_id and has_summary:
                if (report.get("timestamp") or "") <= (
                    stored.get("last_updated") or ""
                ):
                    continue

        changed.append(
            {
                "player_id": player_id,
                "player_name": report.get("player_name"),
                "report": report,
                "prior": stored or None,
            }
        )
    return changed
