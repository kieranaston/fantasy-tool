"""CLI: ingest Bluesky player news, summarize changes, export JSON."""

from __future__ import annotations

import os
import time
from pathlib import Path

from src.config.env import load_dotenv
from src.export.json_writer import utc_now_iso
from src.export.player_lookup import build_player_lookup
from src.injuries.detect import detect_changes, group_reports_by_player
from src.injuries.match import load_player_tables
from src.injuries.serve import build_summaries
from src.injuries.store import (
    SOURCE_BEAT_REPORTER,
    append_reports,
    append_review_items,
    load_json,
    load_poll_state,
    write_json,
)
from src.injuries.summarize import (
    extract_bluesky_batch,
    gemini_available,
)
from src.injuries.validate import review_item, validate_extraction
from src.loaders.bluesky import (
    extract_rotowire_posts,
    fetch_author_posts,
    posts_to_raw_reports,
)
from src.loaders.nfl_data import get_current_season
from src.loaders.sleeper_adp import load_news_pool_ids

ROOT = Path(__file__).resolve().parents[1]
# Pipeline state stays off Pages; only summaries.json is published under docs/.
STATE_DIR = ROOT / "data" / "injuries"
PUBLIC_DIR = ROOT / "docs" / "data" / "injuries"
DATA_DIR = ROOT / "docs" / "data"

RAW_PATH = STATE_DIR / "raw_reports.json"
STATUS_PATH = STATE_DIR / "player_status_current.json"
POLL_PATH = STATE_DIR / "poll_state.json"
REVIEW_PATH = STATE_DIR / "review_queue.json"
SUMMARIES_PATH = PUBLIC_DIR / "summaries.json"
PLAYER_LOOKUP_PATH = DATA_DIR / "player-lookup.json"

EXTRACT_CHUNK = 8
# Cap Bluesky LLM matching only (no narrative generation).
MAX_BLUESKY_LLM_POSTS = int(os.environ.get("MAX_BLUESKY_LLM_POSTS", "16"))


def _newly_appended(before: list, after: list) -> list:
    before_ids = {r.get("id") for r in before}
    return [r for r in after if r.get("id") not in before_ids]


def _extract_bluesky_chunks(posts: list[dict]) -> list[dict]:
    """Extract in small batches with pacing for Gemini free-tier RPM limits."""
    extractions: list[dict] = []
    chunks = [
        posts[i : i + EXTRACT_CHUNK]
        for i in range(0, len(posts), EXTRACT_CHUNK)
    ]
    for index, chunk in enumerate(chunks):
        if index:
            # Stay under ~10 generateContent requests/minute on free tier.
            time.sleep(7.0)
        print(f"  Bluesky: extract batch {index + 1}/{len(chunks)} ({len(chunk)} posts)")
        extractions.extend(extract_bluesky_batch(chunk))
    return extractions


def _extract_from_posts(posts: list[dict]) -> list[dict]:
    """Pattern-extract, then LLM-fallback for posts that still lack a player."""
    extractions = extract_rotowire_posts(posts)
    parsed_urls = {
        e.get("post_url") for e in extractions if e.get("player_name")
    }
    needs_llm = [p for p in posts if p.get("url") not in parsed_urls]
    print(f"  Bluesky: parsed {len(posts) - len(needs_llm)}/{len(posts)} via RotoWire pattern")

    if needs_llm and gemini_available():
        if len(needs_llm) > MAX_BLUESKY_LLM_POSTS:
            print(
                f"  Bluesky: capping LLM fallback to {MAX_BLUESKY_LLM_POSTS}/"
                f"{len(needs_llm)} posts (rest next run)"
            )
            needs_llm = needs_llm[:MAX_BLUESKY_LLM_POSTS]
        try:
            print(f"  Bluesky: LLM fallback for {len(needs_llm)} unmatched post(s)")
            llm_items = _extract_bluesky_chunks(needs_llm)
            by_url = {e.get("post_url"): e for e in extractions}
            for item in llm_items:
                url = item.get("post_url")
                if url:
                    by_url[url] = item
            extractions = list(by_url.values())
        except Exception as exc:
            print(f"  Bluesky: LLM fallback failed ({exc}); keeping pattern parses")
    elif needs_llm and not gemini_available():
        print(f"  Bluesky: {len(needs_llm)} unmatched left for review (no GEMINI_API_KEY)")
    return extractions


def ingest_bluesky(player_index, reports: list, poll_state: dict) -> tuple[list, list]:
    known = {r["url"] for r in reports if r.get("url")}
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

    print(f"  Bluesky: {len(posts)} new RotoWire posts (extracting players)")

    extractions = _extract_from_posts(posts)

    post_by_url = {p["url"]: p for p in posts if p.get("url")}
    valid_extractions = []
    review_batch = []
    for item in extractions:
        url = item.get("post_url") or ""
        post = post_by_url.get(url)
        source_text = (post or {}).get("text") or ""
        ok, failed = validate_extraction(
            {"status": "", "designation": "", "direct_quote": item.get("direct_quote")},
            source_text,
        )
        if not ok and item.get("extract_method") == "pattern":
            quote = str(item.get("direct_quote") or "")
            if quote and source_text.startswith(quote):
                ok = True
                failed = []
        if not ok:
            review_batch.append(
                review_item(
                    reason="bluesky_validation_failed",
                    source=post,
                    extraction=item,
                    failed_fields=failed,
                )
            )
            continue
        valid_extractions.append(item)

    if review_batch:
        append_review_items(REVIEW_PATH, review_batch)

    new_rows = posts_to_raw_reports(posts, valid_extractions, player_index)
    unmatched = [r for r in new_rows if r.get("needs_review")]
    if unmatched:
        append_review_items(
            REVIEW_PATH,
            [review_item(reason="unmatched_player_name", source=r) for r in unmatched],
        )

    before = list(reports)
    reports = append_reports(RAW_PATH, reports, new_rows)
    added = _newly_appended(before, reports)
    print(
        f"  Bluesky: {len(valid_extractions)} extractions, "
        f"{len(added)} new reports ({len(unmatched)} need review)"
    )
    return reports, added


def reprocess_pending_bluesky(player_index, reports: list) -> tuple[list, list]:
    """Resolve stored shells that never got an extraction pass (triaged=False)."""
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

    extractions = _extract_from_posts(posts)

    new_rows = posts_to_raw_reports(posts, extractions, player_index)
    by_url = {r["url"]: r for r in new_rows if r.get("url")}
    updated_for_changes: list = []

    for report in reports:
        url = report.get("url")
        if url not in by_url:
            if not report.get("triaged", True) and any(
                p.get("url") == url for p in posts
            ):
                report["triaged"] = True
            continue
        refreshed = by_url[url]
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


def _latest_post_blurb(report: dict) -> str:
    """Use the newest post body as the card blurb (no Gemini narrative)."""
    text = (report.get("source_text") or "").strip()
    if text:
        return text
    designation = (report.get("designation") or "").strip()
    name = (report.get("player_name") or "").strip()
    if designation and name and not designation.lower().startswith(name.lower()):
        return f"{name}: {designation}"
    return designation or name or ""


def process_changes(
    reports: list,
    status_current: dict,
    *,
    allowed_player_ids: set[str] | None = None,
) -> dict:
    """Update player status from new matched reports; blurb = latest post text."""
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

    updated = 0
    for item in changed:
        report = item["report"]
        pid = item["player_id"]
        source_text = report.get("source_text") or ""
        extraction = {
            "status": report.get("designation") or "",
            "designation": report.get("designation") or "",
            "date": report.get("timestamp") or "",
            "direct_quote": source_text[:280],
            "source_url": report.get("url") or "",
        }
        blurb = _latest_post_blurb(report)
        if not blurb:
            continue
        status_current[pid] = {
            "player_name": item.get("player_name") or report.get("player_name"),
            "current_designation": report.get("designation"),
            "last_updated": report.get("timestamp") or utc_now_iso(),
            "last_report_url": report.get("url"),
            "last_report_id": report.get("id"),
            "last_extraction": extraction,
            "last_diff_summary": blurb,
            "summary_fallback": False,
        }
        updated += 1

    write_json(STATUS_PATH, status_current)
    write_json(RAW_PATH, reports)
    print(f"  Updated {updated} player status row(s) from latest posts")
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

    # Backfill triaged flag so reprocess doesn't re-hit Gemini for old rows
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

    pool_ids = load_news_pool_ids(sleeper_to_gsis=tables.sleeper_to_gsis)
    print(f"  News pool: {len(pool_ids)} players")

    run_started = utc_now_iso()
    reports, bsky_new = ingest_bluesky(tables.by_name, reports, poll_state)
    reports, _bsky_reprocessed = reprocess_pending_bluesky(tables.by_name, reports)

    # Keep status only for news-pool players (site news is pool-scoped)
    status_current = {
        pid: status
        for pid, status in status_current.items()
        if pid in pool_ids
    }

    # Refresh status when the newest matched report changes (blurb = post text)
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
        season=get_current_season(),
        media=tables.media,
    )
    write_json(SUMMARIES_PATH, summaries)
    write_json(
        PLAYER_LOOKUP_PATH,
        build_player_lookup(
            season=get_current_season(),
            allowed_player_ids=pool_ids,
        ),
    )

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
        print(f"  Dropped {dropped} stale player(s) older than news window")


if __name__ == "__main__":
    main()
