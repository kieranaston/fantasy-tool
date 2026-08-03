"""Change detection: new report vs last summarized report for a player."""

from __future__ import annotations

from typing import Any


def detect_changes(
    reports: list[dict[str, Any]],
    status_current: dict[str, Any],
) -> list[dict[str, Any]]:
    """Return players that need a (re)summary.

    Triggers when there is no status yet, the newest matched report differs
    from stored ``last_report_*``, or a status exists without
    ``last_diff_summary`` (so quota failures are filled on the next run).
    """
    newest_by_player: dict[str, dict[str, Any]] = {}

    for report in reports:
        player_id = report.get("player_id")
        if not player_id or report.get("needs_review"):
            continue
        prev = newest_by_player.get(player_id)
        if prev is None or (report.get("timestamp") or "") > (
            prev.get("timestamp") or ""
        ):
            newest_by_player[player_id] = report

    changed: list[dict[str, Any]] = []
    for player_id, report in newest_by_player.items():
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
