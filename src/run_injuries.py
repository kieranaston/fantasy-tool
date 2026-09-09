"""CLI: ingest Bluesky player news, update status, export JSON."""

from __future__ import annotations

import os
import time
from pathlib import Path

from src.config.env import load_dotenv
from src.export.json_writer import utc_now_iso
from src.injuries.detect import detect_changes, group_reports_by_player
from src.injuries.match import load_player_tables, pool_refs_for_ids
from src.injuries.serve import build_summaries
from src.injuries.store import (
    SOURCE_BEAT_REPORTER,
    append_reports,
    load_json,
    load_poll_state,
    write_json,
)
from src.injuries.summarize import (
    SUMMARY_METHOD,
    build_oneliners_batch,
    fallback_oneliner,
    gemini_available,
)
from src.loaders.bluesky import (
    extract_posts_by_pool_names,
    fetch_author_posts,
    posts_to_raw_reports,
)
from src.loaders.sleeper_adp import load_news_pool_ids

ROOT = Path(__file__).resolve().parents[1]
# Pipeline state stays off Pages; only summaries.json is published under docs/.
STATE_DIR = ROOT / "data" / "injuries"
PUBLIC_DIR = ROOT / "docs" / "data" / "injuries"

RAW_PATH = STATE_DIR / "raw_reports.json"
STATUS_PATH = STATE_DIR / "player_status_current.json"
POLL_PATH = STATE_DIR / "poll_state.json"
SUMMARIES_PATH = PUBLIC_DIR / "summaries.json"

NARRATIVE_CHUNK = 8
# Cap Gemini one-liners per run (free-tier RPM); rest retry next day.
MAX_NARRATIVE_PLAYERS = int(os.environ.get("MAX_NARRATIVE_PLAYERS", "24"))


def _newly_appended(before: list, after: list) -> list:
    before_ids = {r.get("id") for r in before}
    return [r for r in after if r.get("id") not in before_ids]


def ingest_bluesky(
    pool_refs: list,
    reports: list,
    poll_state: dict,
) -> tuple[list, list]:
    known = {r["url"] for r in reports if r.get("url")}
    # Also treat bare URLs as known when older rows used #player: fragments.
    known |= {u.split("#player:", 1)[0] for u in known if "#player:" in u}
    try:
        posts = fetch_author_posts(
            since_iso=poll_state.get("last_bluesky_at"),
            known_urls=known,
        )
    except Exception as exc:
        print(f"  Bluesky: fetch failed ({exc})")
        return reports, []

    if not posts:
        print("  Bluesky: no new posts since last poll")
        return reports, []

    print(f"  Bluesky: {len(posts)} new RotoWire posts (ADP name match)")
    extractions = extract_posts_by_pool_names(posts, pool_refs)
    new_rows = posts_to_raw_reports(posts, extractions)
    matched = [r for r in new_rows if r.get("player_id") and not r.get("needs_review")]
    matched_urls = {e.get("post_url") for e in extractions if e.get("post_url")}

    before = list(reports)
    reports = append_reports(RAW_PATH, reports, matched)
    added = _newly_appended(before, reports)
    print(
        f"  Bluesky: {len(extractions)} pool hit(s), "
        f"{len(added)} new report(s), "
        f"{len(posts) - len(matched_urls)} post(s) with no ADP name"
    )
    return reports, added


def reprocess_pending_bluesky(pool_refs: list, reports: list) -> tuple[list, list]:
    """Resolve stored shells that never got a name-match pass (triaged=False)."""
    pending = [
        r
        for r in reports
        if r.get("source_type") == SOURCE_BEAT_REPORTER
        and r.get("source_text")
        and not r.get("triaged", True)
    ]
    if not pending:
        return reports, []

    posts = [
        {
            "url": r.get("url"),
            "created_at": r.get("timestamp"),
            "text": r.get("source_text"),
        }
        for r in pending
    ]
    print(f"  Bluesky: resolving {len(posts)} pending shell post(s)")

    extractions = extract_posts_by_pool_names(posts, pool_refs)
    new_rows = posts_to_raw_reports(posts, extractions)
    by_url = {r["url"].split("#player:", 1)[0]: r for r in new_rows if r.get("url")}
    # Prefer keyed by base url + player when fragments exist
    by_key = {
        (r["url"].split("#player:", 1)[0], r.get("player_id")): r
        for r in new_rows
        if r.get("url")
    }
    updated_for_changes: list = []

    for report in reports:
        url = report.get("url") or ""
        base = url.split("#player:", 1)[0]
        if not report.get("triaged", True) and base in {
            (p.get("url") or "").split("#player:", 1)[0] for p in posts
        }:
            refreshed = by_key.get((base, report.get("player_id"))) or by_url.get(base)
            if refreshed is None:
                report["triaged"] = True
                continue
            report["player_id"] = refreshed.get("player_id")
            report["player_name"] = refreshed.get("player_name")
            report["designation"] = refreshed.get("designation") or report.get(
                "designation"
            )
            report["needs_review"] = refreshed.get("needs_review", True)
            report["triaged"] = True
            if not report["needs_review"] and report.get("player_id"):
                updated_for_changes.append(report)

    write_json(RAW_PATH, reports)
    print(f"  Bluesky: resolved {len(updated_for_changes)} pending post(s)")
    return reports, updated_for_changes


def _write_status_row(
    status_current: dict,
    *,
    player_id: str,
    player_name: str | None,
    report: dict,
    blurb: str,
    summary_fallback: bool,
) -> None:
    source_text = report.get("source_text") or ""
    status_current[player_id] = {
        "player_name": player_name or report.get("player_name"),
        "current_designation": report.get("designation"),
        "last_updated": report.get("timestamp") or utc_now_iso(),
        "last_report_url": report.get("url"),
        "last_report_id": report.get("id"),
        "last_extraction": {
            "status": report.get("designation") or "",
            "designation": report.get("designation") or "",
            "date": report.get("timestamp") or "",
            "direct_quote": source_text[:280],
            "source_url": report.get("url") or "",
        },
        "last_diff_summary": blurb,
        "summary_method": SUMMARY_METHOD if not summary_fallback else "fallback",
        "summary_fallback": summary_fallback,
    }


def _generate_oneliners(
    items: list[dict],
) -> dict[str, str]:
    """Batch Gemini one-liners with free-tier pacing."""
    if not items:
        return {}
    if not gemini_available():
        print("  Gemini: no GEMINI_API_KEY; using post-text fallbacks")
        return {}

    out: dict[str, str] = {}
    chunks = [
        items[i : i + NARRATIVE_CHUNK]
        for i in range(0, len(items), NARRATIVE_CHUNK)
    ]
    for index, chunk in enumerate(chunks):
        if index:
            time.sleep(7.0)
        print(
            f"  Gemini: one-liner batch {index + 1}/{len(chunks)} "
            f"({len(chunk)} player(s))"
        )
        try:
            out.update(build_oneliners_batch(chunk))
        except Exception as exc:
            print(f"  Gemini: batch failed ({exc}); fallback for this chunk")
    return out


def process_changes(
    reports: list,
    status_current: dict,
    *,
    allowed_player_ids: set[str] | None = None,
) -> dict:
    """Update status from new reports; card blurb = Gemini one-liner."""
    by_player = group_reports_by_player(
        reports,
        allowed_player_ids=allowed_player_ids,
        skip_review=True,
    )
    changed = detect_changes(
        reports,
        status_current,
        allowed_player_ids=allowed_player_ids,
        by_player=by_player,
    )
    print(f"  Change detection: {len(changed)} player(s) need status update")
    if not changed:
        return status_current

    # Newest first so the published top of the feed gets blurbs first.
    changed.sort(
        key=lambda item: item["report"].get("timestamp") or "",
        reverse=True,
    )
    if len(changed) > MAX_NARRATIVE_PLAYERS:
        print(
            f"  Gemini: capping one-liners to {MAX_NARRATIVE_PLAYERS}/"
            f"{len(changed)} players (rest next run)"
        )
        changed = changed[:MAX_NARRATIVE_PLAYERS]

    narrative_items = []
    for item in changed:
        pid = item["player_id"]
        timeline = by_player.get(pid) or [item["report"]]
        narrative_items.append(
            {
                "player_id": pid,
                "player_name": item.get("player_name")
                or item["report"].get("player_name"),
                "reports": timeline,
            }
        )

    gemini_blurbs = _generate_oneliners(narrative_items)

    updated = 0
    fallbacks = 0
    for item in narrative_items:
        pid = item["player_id"]
        report = max(item["reports"], key=lambda r: r.get("timestamp") or "")
        name = item.get("player_name")
        blurb = (gemini_blurbs.get(pid) or "").strip()
        used_fallback = False
        if not blurb:
            blurb = fallback_oneliner(player_name=name, reports=item["reports"])
            used_fallback = True
        if not blurb:
            continue
        _write_status_row(
            status_current,
            player_id=pid,
            player_name=name,
            report=report,
            blurb=blurb,
            summary_fallback=used_fallback,
        )
        updated += 1
        if used_fallback:
            fallbacks += 1

    write_json(STATUS_PATH, status_current)
    write_json(RAW_PATH, reports)
    print(
        f"  Updated {updated} player status row(s) "
        f"({updated - fallbacks} Gemini, {fallbacks} fallback)"
    )
    return status_current


def main() -> None:
    load_dotenv()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    poll_state = load_poll_state(POLL_PATH)
    print("Player news pipeline…")
    reports = load_json(RAW_PATH, [])
    status_current = load_json(STATUS_PATH, {})
    if not isinstance(status_current, dict):
        status_current = {}

    dirty = False
    for report in reports:
        if "triaged" not in report:
            report["triaged"] = True
            dirty = True
    if dirty:
        write_json(RAW_PATH, reports)

    print("  Loading player tables…")
    tables = load_player_tables()
    print(f"  Player index: {len(tables.index)} names")

    pool_ids = load_news_pool_ids()
    pool_refs = pool_refs_for_ids(tables, pool_ids)
    print(f"  News pool: {len(pool_refs)} players")

    run_started = utc_now_iso()
    reports, bsky_new = ingest_bluesky(pool_refs, reports, poll_state)
    reports, _bsky_reprocessed = reprocess_pending_bluesky(pool_refs, reports)

    # Keep status only for news-pool players (site news is pool-scoped)
    status_current = {
        pid: status
        for pid, status in status_current.items()
        if pid in pool_ids
    }

    status_current = process_changes(
        reports,
        status_current,
        allowed_player_ids=pool_ids,
    )

    now = utc_now_iso()
    summaries = build_summaries(
        status_current=status_current,
        reports=reports,
        last_updated=now,
        allowed_player_ids=pool_ids,
        teams_by_id={
            ref.player_id: ref.team
            for ref in tables.index
            if ref.team
        },
    )
    write_json(SUMMARIES_PATH, summaries)

    watermark_times = [r.get("timestamp") for r in bsky_new if r.get("timestamp")]
    if watermark_times:
        newest = max(watermark_times)
        prev = poll_state.get("last_bluesky_at")
        if prev is None or newest > prev:
            poll_state["last_bluesky_at"] = newest
    poll_state["last_run_at"] = run_started
    write_json(POLL_PATH, poll_state)

    print(f"Exported {len(summaries.get('players', []))} players → {SUMMARIES_PATH}")
    dropped = summaries.get("dropped_stale")
    if dropped:
        print(f"  Dropped {dropped} stale/no-team player(s)")


if __name__ == "__main__":
    main()
