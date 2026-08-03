"""CLI: ingest Bluesky player news, summarize changes, export JSON."""

from __future__ import annotations

import os
import time
from pathlib import Path

from src.injuries.detect import detect_changes
from src.injuries.match import load_player_index
from src.injuries.serve import build_summaries
from src.injuries.store import (
    SOURCE_BEAT_REPORTER,
    SOURCE_FANTASYPROS,
    append_reports,
    append_review_items,
    load_json,
    load_poll_state,
    new_report_id,
    utc_now_iso,
    write_json,
)
from src.injuries.summarize import (
    build_narratives_batch,
    extract_bluesky_batch,
    gemini_available,
)
from src.injuries.validate import review_item, validate_diff_summary, validate_extraction
from src.loaders.bluesky import (
    extract_rotowire_posts,
    fetch_author_posts,
    posts_to_raw_reports,
)

ROOT = Path(__file__).resolve().parents[1]
INJURIES_DIR = ROOT / "docs" / "data" / "injuries"

RAW_PATH = INJURIES_DIR / "raw_reports.json"
STATUS_PATH = INJURIES_DIR / "player_status_current.json"
POLL_PATH = INJURIES_DIR / "poll_state.json"
SUMMARIES_PATH = INJURIES_DIR / "summaries.json"
REVIEW_PATH = INJURIES_DIR / "review_queue.json"

EXTRACT_CHUNK = 8


def _load_dotenv() -> None:
    """Load .env from repo root if present (no extra dependency)."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(
            key.strip(),
            value.strip().strip("'").strip('"'),
        )


def _newly_appended(before: list, after: list) -> list:
    before_ids = {r.get("id") for r in before}
    return [r for r in after if r.get("id") not in before_ids]


def _shell_reports(posts: list[dict]) -> list[dict]:
    """Store raw posts for later triage without calling Gemini now."""
    return [
        {
            "id": new_report_id(),
            "player_id": None,
            "player_name": None,
            "timestamp": post.get("created_at") or utc_now_iso(),
            "designation": "",
            "source_text": post.get("text") or "",
            "url": post["url"],
            "source_type": SOURCE_BEAT_REPORTER,
            "needs_review": True,
            "triaged": False,
        }
        for post in posts
    ]


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


def purge_fantasypros(
    reports: list,
    status_current: dict,
) -> tuple[list, dict, int]:
    """Drop FantasyPros rows and status that depended on them."""
    kept = [r for r in reports if r.get("source_type") != SOURCE_FANTASYPROS]
    removed = len(reports) - len(kept)
    if removed == 0:
        return reports, status_current, 0

    matched_ids = {
        r["player_id"]
        for r in kept
        if r.get("player_id") and not r.get("needs_review")
    }
    new_status: dict = {}
    for pid, status in status_current.items():
        if pid not in matched_ids:
            continue
        url = status.get("last_report_url") or ""
        rid = str(status.get("last_report_id") or "")
        if "fantasypros.com" in url or rid.startswith("fp-"):
            # Clear so detect_changes retries from remaining Bluesky sources
            status = {
                **status,
                "last_report_url": None,
                "last_report_id": None,
                "last_diff_summary": None,
                "last_extraction": None,
            }
        new_status[pid] = status
    return kept, new_status, removed


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

    extractions = extract_rotowire_posts(posts)
    parsed = [e for e in extractions if e.get("player_name")]
    needs_llm = [p for p in posts if not any(
        (e.get("post_url") == p.get("url") and e.get("player_name"))
        for e in extractions
    )]
    print(f"  Bluesky: parsed {len(parsed)}/{len(posts)} via RotoWire pattern")

    if needs_llm and gemini_available():
        try:
            print(f"  Bluesky: LLM fallback for {len(needs_llm)} unmatched post(s)")
            llm_items = _extract_bluesky_chunks(needs_llm)
            # Replace null parses for those URLs
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
        if not ok and item.get("player_name"):
            # Pattern extracts use full post text as quote; still accept.
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

    extractions = extract_rotowire_posts(posts)
    needs_llm = [
        p
        for p in posts
        if not any(
            (e.get("post_url") == p.get("url") and e.get("player_name"))
            for e in extractions
        )
    ]
    if needs_llm and gemini_available():
        try:
            llm_items = _extract_bluesky_chunks(needs_llm)
            by_url = {e.get("post_url"): e for e in extractions}
            for item in llm_items:
                url = item.get("post_url")
                if url:
                    by_url[url] = item
            extractions = list(by_url.values())
        except Exception as exc:
            print(f"  Bluesky: pending LLM fallback failed ({exc})")

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


def _fallback_summary(player_name: str | None, report: dict) -> str:
    """Plain summary from RotoWire fields when Gemini quota is exhausted."""
    name = (player_name or report.get("player_name") or "Player").strip()
    designation = (report.get("designation") or "").strip()
    if not designation:
        text = (report.get("source_text") or "").strip()
        designation = text.split("\n")[0].strip()[:160]
    if not designation:
        return f"{name}: update reported."
    if designation.lower().startswith(name.lower() + ":"):
        return designation if designation.endswith(".") else f"{designation}."
    if designation.endswith((".", "!", "?")):
        return f"{name}: {designation}"
    return f"{name}: {designation}."


def process_changes(reports: list, status_current: dict) -> dict:
    """Summarize any matched player that is new or still missing a narrative."""
    changed = detect_changes(reports, status_current)
    print(f"  Change detection: {len(changed)} player(s) need summary")
    if not changed:
        return status_current

    narrative_inputs = []
    review_batch = []

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
        timeline = [
            r
            for r in reports
            if r.get("player_id") == pid and not r.get("needs_review")
        ]
        timeline.sort(key=lambda r: r.get("timestamp") or "")
        if not timeline:
            timeline = [report]

        narrative_inputs.append(
            {
                "player_id": pid,
                "player_name": item.get("player_name") or report.get("player_name"),
                "report": report,
                "current": extraction,
                "reports": timeline,
                "source_texts": [r.get("source_text") or "" for r in timeline],
            }
        )

    summaries: dict = {}
    if gemini_available():
        try:
            summaries = build_narratives_batch(
                [
                    {
                        "player_id": d["player_id"],
                        "player_name": d.get("player_name"),
                        "reports": d["reports"],
                    }
                    for d in narrative_inputs
                ]
            )
        except Exception as exc:
            print(f"  Narrative batch failed ({exc})")
            print("  Falling back to plain RotoWire summaries where needed")
            append_review_items(
                REVIEW_PATH,
                [review_item(reason=f"narrative_batch_error: {exc}")],
            )
            summaries = {}

        missing = [d for d in narrative_inputs if not summaries.get(d["player_id"])]
        if missing and summaries:
            try:
                summaries.update(
                    build_narratives_batch(
                        [
                            {
                                "player_id": d["player_id"],
                                "player_name": d.get("player_name"),
                                "reports": d["reports"],
                            }
                            for d in missing
                        ]
                    )
                )
            except Exception as exc:
                append_review_items(
                    REVIEW_PATH,
                    [review_item(reason=f"narrative_retry_error: {exc}")],
                )
    else:
        print("  Summarization without Gemini (plain RotoWire text)")

    summarized = 0
    still_pending = 0
    for d in narrative_inputs:
        pid = d["player_id"]
        summary = summaries.get(pid)
        used_fallback = not bool(summary)
        if summary:
            ok, failed = validate_diff_summary(summary, d["source_texts"])
            if not ok:
                review_batch.append(
                    review_item(
                        reason="narrative_validation_failed",
                        source=d["report"],
                        extraction={"summary": summary, **d["current"]},
                        failed_fields=failed,
                    )
                )
                summary = None
                used_fallback = True
        if not summary:
            summary = _fallback_summary(d.get("player_name"), d["report"])
            used_fallback = True
        if not summary:
            still_pending += 1
            continue

        status_current[pid] = {
            "player_name": d.get("player_name") or d["report"].get("player_name"),
            "current_designation": d["current"].get("designation")
            or d["report"].get("designation"),
            "last_updated": d["report"].get("timestamp") or utc_now_iso(),
            "last_report_url": d["report"].get("url"),
            "last_report_id": d["report"].get("id"),
            "last_extraction": d["current"],
            "last_diff_summary": summary,
            "summary_fallback": used_fallback,
        }
        summarized += 1

    if review_batch:
        append_review_items(REVIEW_PATH, review_batch)

    write_json(STATUS_PATH, status_current)
    write_json(RAW_PATH, reports)
    print(
        f"  Summarized {summarized} player(s); "
        f"{still_pending} still pending (retry next run); "
        f"{len(review_batch)} validation failures → review"
    )
    return status_current



def main() -> None:
    _load_dotenv()
    INJURIES_DIR.mkdir(parents=True, exist_ok=True)

    poll_state = load_poll_state(POLL_PATH)
    print("Player news pipeline…")
    reports = load_json(RAW_PATH, [])
    status_current = load_json(STATUS_PATH, {})
    if not isinstance(status_current, dict):
        status_current = {}

    reports, status_current, removed_fp = purge_fantasypros(reports, status_current)
    if removed_fp:
        write_json(RAW_PATH, reports)
        write_json(STATUS_PATH, status_current)
        print(f"  Removed {removed_fp} FantasyPros report(s)")

    # Backfill triaged flag so reprocess doesn't re-hit Gemini for old rows
    dirty = False
    for report in reports:
        if "triaged" not in report:
            report["triaged"] = True
            dirty = True
    if dirty:
        write_json(RAW_PATH, reports)

    print("  Loading player index…")
    player_index = load_player_index()
    print(f"  Player index: {len(player_index)} names")

    run_started = utc_now_iso()
    reports, bsky_new = ingest_bluesky(player_index, reports, poll_state)
    reports, _bsky_reprocessed = reprocess_pending_bluesky(player_index, reports)

    # Scan all matched reports each run so quota failures are filled next day
    status_current = process_changes(reports, status_current)

    now = utc_now_iso()
    summaries = build_summaries(
        status_current=status_current,
        reports=reports,
        last_updated=now,
    )
    write_json(SUMMARIES_PATH, summaries)

    watermark_times = [r.get("timestamp") for r in bsky_new if r.get("timestamp")]
    if watermark_times:
        newest = max(watermark_times)
        prev = poll_state.get("last_bluesky_at")
        if prev is None or newest > prev:
            poll_state["last_bluesky_at"] = newest
    poll_state.pop("last_fantasypros_at", None)
    poll_state["last_run_at"] = run_started
    write_json(POLL_PATH, poll_state)

    print(f"Exported {len(summaries.get('players', []))} players → {SUMMARIES_PATH}")


if __name__ == "__main__":
    main()
