"""Bluesky public author-feed ingestion for RotoWire NFL news."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import httpx

from src.injuries.calendar import parse_iso_datetime, post_super_bowl_cutoff

BSKY_FEED_URL = (
    "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
)
DEFAULT_ACTOR = "rotowirenfl.bsky.social"
PAGE_LIMIT = 50
MAX_PAGES = 30

# RotoWire blurbs are almost always "Player Name: update …"
_ROTOWIRE_LINE = re.compile(
    r"^\s*(?P<player>[^:\n]{2,80}?)\s*:\s*(?P<designation>.+?)\s*$",
    re.MULTILINE,
)
_URL_LINE = re.compile(r"https?://\S+")


def at_uri_to_web_url(uri: str, handle: str) -> str:
    """Convert at://did/.../app.bsky.feed.post/rkey → bsky.app URL."""
    rkey = uri.rstrip("/").split("/")[-1]
    return f"https://bsky.app/profile/{handle}/post/{rkey}"


def fetch_author_posts(
    *,
    actor: str = DEFAULT_ACTOR,
    since_iso: str | None = None,
    known_urls: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Pull posts newer than ``since_iso`` (or post-Super-Bowl on first run).

    RotoWire posts are curated player blurbs — every post is ingested; Gemini
    extracts player/designation fields rather than relevance-filtering.
    """
    known_urls = known_urls or set()
    since = parse_iso_datetime(since_iso)
    if since is None:
        since = post_super_bowl_cutoff()

    posts: list[dict[str, Any]] = []
    cursor: str | None = None

    with httpx.Client(timeout=30.0) as client:
        for _ in range(MAX_PAGES):
            params: dict[str, Any] = {
                "actor": actor,
                "limit": PAGE_LIMIT,
                "filter": "posts_no_replies",
            }
            if cursor:
                params["cursor"] = cursor

            response = client.get(BSKY_FEED_URL, params=params)
            response.raise_for_status()
            payload = response.json()
            feed = payload.get("feed") or []
            if not feed:
                break

            stop = False
            for entry in feed:
                post = entry.get("post") or {}
                record = post.get("record") or {}
                created_at = record.get("createdAt") or post.get("indexedAt")
                created_dt = parse_iso_datetime(created_at)
                if created_dt is not None and created_dt <= since:
                    stop = True
                    continue

                uri = post.get("uri") or ""
                author = (post.get("author") or {}).get("handle") or actor
                url = at_uri_to_web_url(uri, author) if uri else ""
                if url and url in known_urls:
                    continue

                text = record.get("text") or ""
                if not text.strip():
                    continue

                posts.append(
                    {
                        "uri": uri,
                        "url": url,
                        "created_at": created_at,
                        "text": text,
                        "handle": author,
                    }
                )

            if stop:
                break
            cursor = payload.get("cursor")
            if not cursor:
                break

    posts.sort(key=lambda p: p.get("created_at") or "")
    return posts


def extract_rotowire_posts(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministic extract for RotoWire ``Player: update`` posts (no LLM)."""
    items: list[dict[str, Any]] = []
    for post in posts:
        text = (post.get("text") or "").strip()
        url = post.get("url") or ""
        created = post.get("created_at") or ""
        if not text or not url:
            continue

        cleaned = _URL_LINE.sub("", text).strip()
        match = _ROTOWIRE_LINE.search(cleaned)
        if not match:
            items.append(
                {
                    "player_name": None,
                    "designation": "",
                    "date": created,
                    "direct_quote": text[:280],
                    "post_url": url,
                    "needs_review": True,
                    "extract_method": "pattern",
                }
            )
            continue

        player = match.group("player").strip()
        designation = match.group("designation").strip()
        # Drop trailing orphan punctuation / blank leftovers
        designation = designation.split("\n")[0].strip(" -–—")
        items.append(
            {
                "player_name": player,
                "designation": designation,
                "date": created,
                "direct_quote": text[:280],
                "post_url": url,
                "needs_review": False,
                "extract_method": "pattern",
            }
        )
    return items


def posts_to_raw_reports(
    posts: list[dict[str, Any]],
    extractions: list[dict[str, Any]],
    player_index: list[Any],
) -> list[dict[str, Any]]:
    """Join Gemini Bluesky extractions back to posts as raw_reports rows."""
    from src.injuries.match import match_player_name, name_choices
    from src.injuries.store import SOURCE_BEAT_REPORTER, new_report_id

    choices = (
        player_index
        if isinstance(player_index, dict)
        else name_choices(player_index)
    )
    by_url = {p["url"]: p for p in posts if p.get("url")}
    reports: list[dict[str, Any]] = []

    for item in extractions:
        post_url = item.get("post_url") or ""
        post = by_url.get(post_url)
        if post is None and post_url:
            for url, candidate in by_url.items():
                if post_url in url or url in post_url:
                    post = candidate
                    post_url = url
                    break

        source_text = (post or {}).get("text") or item.get("direct_quote") or ""
        timestamp = (post or {}).get("created_at") or item.get("date") or ""
        player_name = item.get("player_name")
        match = match_player_name(player_name, choices)
        needs_review = bool(item.get("needs_review")) or match.needs_review or (
            player_name is None
        )

        reports.append(
            {
                "id": new_report_id(),
                "player_id": match.player_id,
                "player_name": match.matched_name or player_name,
                "timestamp": timestamp,
                "designation": item.get("designation") or "",
                "source_text": source_text,
                "url": post_url
                or (post or {}).get("url")
                or f"bsky:missing:{quote(str(player_name))}",
                "source_type": SOURCE_BEAT_REPORTER,
                "needs_review": needs_review,
                "triaged": True,
            }
        )
    return reports
