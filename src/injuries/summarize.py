"""Gemini grounded extraction (Step A) and narrative summaries (Step B)."""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from src.injuries.validate import EMOJI_RE

EXTRACT_SYSTEM = (
    "Extract only what is explicitly stated. No inference. No medical opinion."
)

BLUESKY_BATCH_INSTRUCTION = (
    "These posts are from RotoWire's curated NFL news account. Treat every "
    "post as useful fantasy-player news — do not drop posts for relevance. "
    "For each post, extract one item per named player mentioned: "
    "player_name, designation, date, direct_quote, post_url. "
    "designation should be a short phrase from the post (e.g. PUP, cleared, "
    "full practice, season-ending IR, signed, released, traded, expanded role) "
    "— never only a team name. "
    "direct_quote must be copied verbatim from the post text. "
    "If no player can be confidently identified, return player_name as null "
    "and set needs_review to true. "
    "Return items for every post in the batch (one or more per post)."
)

NARRATIVE_SYSTEM = (
    "You write short, source-faithful fantasy-football player-news notes "
    "as bullet points.\n"
    "Rules:\n"
    "- Output ONLY a bullet list. Each line starts with '- '.\n"
    "- One bullet per distinct fact from the source posts. Newest first.\n"
    "- Stay close to the posts: paraphrase tightly; do not stitch a narrative "
    "or add interpretation, medical opinion, or 'expected to' guesses.\n"
    "- Skip fluff, hashtags, emojis, ALL-CAPS banners, and social formatting.\n"
    "- Keep each bullet to one short clause. 2–5 bullets typical; never more "
    "than 6. Drop older posts that add nothing new.\n"
    "- Include a date in a bullet only when the post states one "
    "(use July 24th style, not July 24).\n"
    "- Do not use Google Search. Do not invent facts.\n"
    "- Expand acronyms on first use only, briefly:\n"
    "  • OTAs = Organized Team Activities (voluntary).\n"
    "  • PUP = Physically Unable to Perform (no practice; typically out ≥4 weeks "
    "until activated).\n"
    "  • NFI = Non-Football Injury (similar to PUP).\n"
    "  • IR = Injured Reserve (typically out ≥4 games).\n"
    "  • DNP = Did Not Practice.\n"
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
            delay = 2 ** attempt
            if "429" in message or "RESOURCE_EXHAUSTED" in message:
                # Free tier is often ~10 RPM; honor RetryInfo when present.
                match = re.search(r"Please retry in ([0-9.]+)s", message)
                if match:
                    delay = max(delay, float(match.group(1)) + 1.0)
                else:
                    delay = max(delay, 25.0)
            time.sleep(delay)
    assert last_error is not None
    raise last_error


def extract_bluesky_batch(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Step A: extract player/designation fields from a RotoWire Bluesky batch."""
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
    text = EMOJI_RE.sub("", text)
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
    for r in ordered:
        text = (r.get("source_text") or "").strip()
        if not text:
            continue
        payload.append(
            {
                "date": r.get("timestamp") or "",
                "url": r.get("url") or "",
                "text": text,
            }
        )
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
        "Write a bullet-list player-news note as JSON field summary. "
        "Each line starts with '- '. Facts only from these posts."
    )
    result = _generate_json(
        system=NARRATIVE_SYSTEM,
        user=user,
        schema=NARRATIVE_SCHEMA,
        use_search=False,
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
        "For each player, write a bullet-list player-news note "
        "(each line starts with '- '; facts only from that player's posts; "
        "newest first; 2–5 bullets).\n\n"
        f"{json.dumps(payload, indent=2)}"
    )
    result = _generate_json(
        system=NARRATIVE_SYSTEM,
        user=user,
        schema=BATCH_NARRATIVE_SCHEMA,
        use_search=False,
    )
    assert isinstance(result, dict)
    out: dict[str, str] = {}
    for row in result.get("results") or []:
        pid = row.get("player_id")
        if pid:
            out[str(pid)] = normalize_summary(str(row.get("summary") or "").strip())
    return out
