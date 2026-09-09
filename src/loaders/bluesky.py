"""Bluesky public author-feed ingestion for RotoWire NFL news."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import httpx

from src.injuries.calendar import parse_iso_datetime, post_super_bowl_cutoff
from src.injuries.match import PlayerRef, match_pool_names_in_text

BSKY_FEED_URL = (
    "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
)
DEFAULT_ACTOR = "rotowirenfl.bsky.social"
PAGE_LIMIT = 50
MAX_PAGES = 30

_URL_LINE = re.compile(r"https?://\S+")
_COLON_LINE = re.compile(
    r"^\s*(?P<head>[^:\n]{2,80}?)\s*:\s*(?P<body>.+?)\s*$",
    re.MULTILINE,
)


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

    RotoWire posts are curated player blurbs — matching to the ADP news pool
    happens later via first/last/full name scan (no LLM).
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


def _designation_for_player(text: str, player_name: str) -> str:
    """Pull the RotoWire ``Name: update`` body when the head mentions the player."""
    cleaned = _URL_LINE.sub("", text or "").strip()
    match = _COLON_LINE.search(cleaned)
    if not match:
        return ""
    head = match.group("head").strip()
    body = match.group("body").strip().split("\n")[0].strip(" -–—")
    name_l = (player_name or "").lower()
    head_l = head.lower()
    last = name_l.split()[-1] if name_l else ""
    if name_l and (name_l in head_l or head_l in name_l):
        return body
    if last and len(last) >= 3 and last in head_l:
        return body
    return ""


def extract_posts_by_pool_names(
    posts: list[dict[str, Any]],
    pool: list[PlayerRef],
) -> list[dict[str, Any]]:
    """Match posts to ADP-pool players via first/last/full name (no LLM).

    Posts with no pool hit are dropped. One extraction row per matched player
    (a post can mention more than one).
    """
    items: list[dict[str, Any]] = []
    for post in posts:
        text = (post.get("text") or "").strip()
        url = post.get("url") or ""
        created = post.get("created_at") or ""
        if not text or not url:
            continue

        hits = match_pool_names_in_text(text, pool)
        if not hits:
            continue

        for hit in hits:
            ref = hit.ref
            designation = _designation_for_player(text, ref.name)
            items.append(
                {
                    "player_id": ref.player_id,
                    "player_name": ref.name,
                    "designation": designation,
                    "date": created,
                    "direct_quote": text[:280],
                    "post_url": url,
                    "needs_review": False,
                    "extract_method": f"pool_{hit.method}",
                }
            )
    return items


def posts_to_raw_reports(
    posts: list[dict[str, Any]],
    extractions: list[dict[str, Any]],
    player_index: list[Any] | dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Join pool-name extractions rows back to posts as raw_reports.

    Prefer ``player_id`` already set by ADP name matching. Fall back to fuzzy
    name match when only ``player_name`` is present (legacy rows).
    """
    from src.injuries.match import match_player_name, name_choices
    from src.injuries.store import SOURCE_BEAT_REPORTER, new_report_id

    choices: dict[str, Any] | None = None
    if player_index is not None:
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
        player_id = item.get("player_id")
        needs_review = bool(item.get("needs_review"))

        if not player_id and choices is not None:
            match = match_player_name(player_name, choices)
            player_id = match.player_id
            player_name = match.matched_name or player_name
            needs_review = needs_review or match.needs_review or (
                player_name is None
            )
        elif not player_id:
            needs_review = True

        # Unique URL per player when one post matches multiple pool names.
        report_url = (
            post_url
            or (post or {}).get("url")
            or f"bsky:missing:{quote(str(player_name))}"
        )
        if player_id and any(
            e.get("post_url") == post_url and e.get("player_id") != player_id
            for e in extractions
            if e.get("post_url")
        ):
            report_url = f"{report_url}#player:{player_id}"

        reports.append(
            {
                "id": new_report_id(),
                "player_id": player_id,
                "player_name": player_name,
                "timestamp": timestamp,
                "designation": item.get("designation") or "",
                "source_text": source_text,
                "url": report_url,
                "source_type": SOURCE_BEAT_REPORTER,
                "needs_review": needs_review,
                "triaged": True,
            }
        )
    return reports
