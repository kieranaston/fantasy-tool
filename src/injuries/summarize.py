"""Gemini grounded extraction (Step A) and narrative summaries (Step B)."""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime
from typing import Any

EXTRACT_SYSTEM = (
    "Extract only what is explicitly stated. No inference. No medical opinion."
)

BLUESKY_BATCH_INSTRUCTION = (
    "Identify posts that are player-related NFL news — anything about a specific "
    "player's situation that fantasy managers would care about. Include injuries, "
    "recovery/clearance, PUP/NFI/IR, practice participation, rest, suspensions, "
    "game-status designations, contracts/extensions/releases that affect a named "
    "player, trades involving named players, and similar player news. "
    "Ignore coaching hires, draft-class speculation with no named current player, "
    "and general team news that does not name a player. "
    "For each relevant post, extract: "
    "player_name, designation, date, direct_quote, post_url. "
    "designation should be a short phrase from the post (e.g. PUP, cleared, "
    "signed, released, traded) — never only a team name. "
    "direct_quote must be copied verbatim from the post text. "
    "If no player can be confidently matched, return player_name as null "
    "and set needs_review to true. Return one item per named player mentioned."
)

NARRATIVE_SYSTEM = (
    "You write concise fantasy-football player-news briefings for a reference site.\n"
    "Rules:\n"
    "- Facts about the player must come from the provided source posts "
    "(availability, injury, contract, trade, suspension, practice status, etc.).\n"
    "- Use Google Search when you need real-world context that the posts mention "
    "but do not date or define — e.g. when that team's training camp opens, "
    "when Week 1 is, what a league milestone means this season. "
    "Prefer official/reputable NFL sources. If search cannot confirm a date, "
    "omit it rather than guessing.\n"
    "- When multiple posts exist, connect them into one short narrative arc "
    "(what was reported earlier → what is known now).\n"
    "- 2–5 sentences max. Clear prose, not a bullet list.\n"
    "- Dates must use ordinal day forms: July 24th (never bare July 24).\n"
    "- When a later update follows an earlier one, state the gap using "
    "days_after_previous_update when provided "
    "(e.g. 'On July 24th, 66 days later, …').\n"
    "- Never copy emojis, hashtags, ALL-CAPS banners, or raw social formatting.\n"
    "- Paraphrase; short quoted phrases only when attribution matters.\n"
    "- ALWAYS expand acronyms every time they appear, with availability impact:\n"
    "  • OTAs / OTA = Organized Team Activities (voluntary spring practices).\n"
    "  • PUP = Physically Unable to Perform; at camp start, no practice/games "
    "for at least the first 4 regular-season weeks until activated.\n"
    "  • NFI = Non-Football Injury; similar restrictions to PUP.\n"
    "  • IR = Injured Reserve; typically out at least 4 games once placed.\n"
    "  • DNP = Did Not Practice.\n"
    "- Do not invent medical opinions or unconfirmed dates.\n"
    "- Do not write placeholders like 'N ago', 'None', or 'null'."
)

DEFAULT_MODEL = "gemini-2.5-flash-lite"

BLUESKY_ITEM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "player_name": {"type": "string", "nullable": True},
        "designation": {"type": "string"},
        "date": {"type": "string"},
        "direct_quote": {"type": "string"},
        "post_url": {"type": "string"},
        "needs_review": {"type": "boolean"},
    },
    "required": [
        "designation",
        "date",
        "direct_quote",
        "post_url",
        "needs_review",
    ],
}

BLUESKY_BATCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {"type": "array", "items": BLUESKY_ITEM_SCHEMA},
    },
    "required": ["items"],
}

NARRATIVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
}

BATCH_NARRATIVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "player_id": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["player_id", "summary"],
            },
        }
    },
    "required": ["results"],
}

_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F9FF"
    "\U00002600-\U000027BF"
    "\U0000FE00-\U0000FE0F"
    "\U0001F1E0-\U0001F1FF"
    "]+",
    flags=re.UNICODE,
)


def gemini_available() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


def _client():
    from google import genai

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return genai.Client(api_key=api_key)


def _model_name() -> str:
    return os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL


def _parse_json_text(text: str) -> dict[str, Any] | list[Any]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def _generate_json(
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    retries: int = 4,
    use_search: bool = False,
) -> dict[str, Any] | list[Any]:
    from google.genai import types

    client = _client()
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            if use_search:
                response = client.models.generate_content(
                    model=_model_name(),
                    contents=(
                        user
                        + "\n\nRespond with ONLY valid JSON matching this schema:\n"
                        + json.dumps(schema)
                    ),
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        temperature=0.2,
                        tools=[types.Tool(google_search=types.GoogleSearch())],
                    ),
                )
            else:
                response = client.models.generate_content(
                    model=_model_name(),
                    contents=user,
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        response_mime_type="application/json",
                        response_schema=schema,
                        temperature=0.2,
                    ),
                )
            text = (response.text or "").strip()
            if not text:
                raise RuntimeError("Gemini returned empty response")
            return _parse_json_text(text)
        except Exception as exc:
            last_error = exc
            message = str(exc)
            retryable = any(
                token in message
                for token in (
                    "503",
                    "UNAVAILABLE",
                    "429",
                    "RESOURCE_EXHAUSTED",
                    "high demand",
                )
            )
            if not retryable or attempt == retries - 1:
                break
            time.sleep(2 ** attempt)
    assert last_error is not None
    raise last_error


def extract_bluesky_batch(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Step A: triage + extract player-related posts from a Bluesky batch."""
    if not posts:
        return []
    payload = [
        {
            "post_url": p.get("url"),
            "created_at": p.get("created_at"),
            "text": p.get("text"),
        }
        for p in posts
    ]
    result = _generate_json(
        system=EXTRACT_SYSTEM,
        user=f"{BLUESKY_BATCH_INSTRUCTION}\n\nPosts JSON:\n{json.dumps(payload, indent=2)}",
        schema=BLUESKY_BATCH_SCHEMA,
    )
    assert isinstance(result, dict)
    return list(result.get("items") or [])


def normalize_summary(summary: str) -> str:
    """Strip leftover social formatting from a model summary."""
    text = (summary or "").strip()
    if not text:
        return text
    text = _EMOJI_RE.sub("", text)
    text = re.sub(
        r"^(?:N|\d+)\s*ago:\s*(?:None|null|n/a)?\s*\.?\s*Now:\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def _timeline_payload(reports: list[dict[str, Any]]) -> list[dict[str, str]]:
    ordered = sorted(reports, key=lambda r: r.get("timestamp") or "")
    payload: list[dict[str, str]] = []
    prev_dt: datetime | None = None
    for r in ordered:
        text = (r.get("source_text") or "").strip()
        if not text:
            continue
        ts = r.get("timestamp") or ""
        days_after_previous = ""
        cur = None
        if ts:
            try:
                cur = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                cur = None
        if cur is not None and prev_dt is not None:
            days_after_previous = str((cur.date() - prev_dt.date()).days)
        payload.append(
            {
                "date": ts,
                "days_after_previous_update": days_after_previous,
                "url": r.get("url") or "",
                "text": text,
            }
        )
        if cur is not None:
            prev_dt = cur
    return payload


def build_player_narrative(
    *,
    player_id: str,
    player_name: str | None,
    reports: list[dict[str, Any]],
) -> str:
    """Step B: multi-source narrative via Gemini (+ Google Search when needed)."""
    timeline = _timeline_payload(reports)
    if not timeline:
        return ""

    user = (
        f"Player: {player_name or player_id}\n\n"
        f"Source posts (chronological):\n{json.dumps(timeline, indent=2)}\n\n"
        "Write one concise player-news briefing as JSON field summary."
    )
    result = _generate_json(
        system=NARRATIVE_SYSTEM,
        user=user,
        schema=NARRATIVE_SCHEMA,
        use_search=True,
    )
    assert isinstance(result, dict)
    return normalize_summary(str(result.get("summary") or "").strip())


def build_narratives_batch(
    items: list[dict[str, Any]],
) -> dict[str, str]:
    """Step B for multiple players. Each item: {player_id, player_name, reports}."""
    if not items:
        return {}

    if len(items) == 1:
        only = items[0]
        return {
            only["player_id"]: build_player_narrative(
                player_id=only["player_id"],
                player_name=only.get("player_name"),
                reports=only.get("reports") or [],
            )
        }

    payload = [
        {
            "player_id": item["player_id"],
            "player_name": item.get("player_name"),
            "sources": _timeline_payload(item.get("reports") or []),
        }
        for item in items
    ]
    user = (
        "For each player, write one concise player-news briefing.\n\n"
        f"{json.dumps(payload, indent=2)}"
    )
    result = _generate_json(
        system=NARRATIVE_SYSTEM,
        user=user,
        schema=BATCH_NARRATIVE_SCHEMA,
        use_search=True,
    )
    assert isinstance(result, dict)
    out: dict[str, str] = {}
    for row in result.get("results") or []:
        pid = row.get("player_id")
        if pid:
            out[str(pid)] = normalize_summary(str(row.get("summary") or "").strip())
    return out
