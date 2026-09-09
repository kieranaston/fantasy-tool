"""Gemini one-liner blurbs for player news cards."""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from src.injuries.validate import EMOJI_RE

DEFAULT_MODEL = "gemini-2.5-flash-lite"

ONELINER_SYSTEM = (
    "You write one-line fantasy-football player-news blurbs for a card UI.\n"
    "Rules:\n"
    "- Output exactly one short sentence or clause (aim ≤140 characters).\n"
    "- Do NOT include the player's name, initials, or 'Player X' — the name is "
    "already shown above the blurb.\n"
    "- Prefer he/she/they, a role ('the WR'), or an implied subject "
    "('Limited Wednesday; questionable for Sunday.').\n"
    "- Stay faithful to the source posts: paraphrase tightly; no medical "
    "opinion, no 'expected to' guesses, no invented facts.\n"
    "- Emphasize the newest material; older posts only if still relevant.\n"
    "- No bullets, emoji, hashtags, URLs, or ALL-CAPS banners.\n"
    "- Expand acronyms briefly on first use when helpful:\n"
    "  PUP, NFI, IR, DNP, OTAs.\n"
    "- Do not write placeholders like 'None' or 'null'."
)

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

SUMMARY_METHOD = "gemini_oneliner"
_URL_RE = re.compile(r"https?://\S+")


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
) -> dict[str, Any] | list[Any]:
    from google.genai import types

    client = _client()
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
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
                match = re.search(r"Please retry in ([0-9.]+)s", message)
                if match:
                    delay = max(delay, float(match.group(1)) + 1.0)
                else:
                    delay = max(delay, 25.0)
            time.sleep(delay)
    assert last_error is not None
    raise last_error


def _timeline_payload(reports: list[dict[str, Any]]) -> list[dict[str, str]]:
    ordered = sorted(reports, key=lambda r: r.get("timestamp") or "", reverse=True)
    payload: list[dict[str, str]] = []
    for r in ordered[:12]:
        text = _URL_RE.sub("", (r.get("source_text") or "").strip()).strip()
        if not text:
            continue
        payload.append(
            {
                "date": r.get("timestamp") or "",
                "text": text[:400],
            }
        )
    return payload


def strip_leading_player_name(summary: str, player_name: str | None) -> str:
    """Remove a leading 'Name:' / 'Name ' so the UI name isn't repeated."""
    text = (summary or "").strip()
    if not text or not player_name:
        return text
    name = player_name.strip()
    if not name:
        return text
    candidates = [name]
    parts = name.split()
    if len(parts) >= 2:
        candidates.append(parts[-1])
    for candidate in candidates:
        pattern = re.compile(
            rf"^\s*{re.escape(candidate)}\s*[:\-–—,]?\s+",
            re.IGNORECASE,
        )
        updated = pattern.sub("", text, count=1)
        if updated != text:
            return updated.strip()
    return text


def normalize_oneliner(summary: str, player_name: str | None = None) -> str:
    """Clean model/fallback text into a single blurb line."""
    text = (summary or "").strip()
    if not text:
        return text
    text = EMOJI_RE.sub("", text)
    text = re.sub(r"^[-*•]\s+", "", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"\s{2,}", " ", text).strip()
    text = strip_leading_player_name(text, player_name)
    if len(text) > 180:
        cut = text[:177].rsplit(" ", 1)[0].rstrip(" ,;:")
        text = f"{cut}…" if cut else text[:180]
    return text.strip()


def fallback_oneliner(
    *,
    player_name: str | None,
    reports: list[dict[str, Any]],
) -> str:
    """Deterministic blurb from the newest post when Gemini is unavailable."""
    if not reports:
        return ""
    newest = max(reports, key=lambda r: r.get("timestamp") or "")
    text = _URL_RE.sub("", (newest.get("source_text") or "").strip()).strip()
    if not text:
        designation = (newest.get("designation") or "").strip()
        return normalize_oneliner(designation, player_name)
    if ":" in text.split("\n", 1)[0]:
        head, _, body = text.partition(":")
        body = body.strip().split("\n")[0].strip(" -–—")
        last = (player_name or "").split()[-1].lower() if player_name else ""
        if body and (
            not player_name
            or player_name.lower() in head.lower()
            or (last and len(last) >= 3 and last in head.lower())
        ):
            return normalize_oneliner(body, player_name)
    return normalize_oneliner(text.split("\n")[0], player_name)


def build_player_oneliner(
    *,
    player_id: str,
    player_name: str | None,
    reports: list[dict[str, Any]],
) -> str:
    """Gemini one-liner for a single player's recent posts."""
    timeline = _timeline_payload(reports)
    if not timeline:
        return ""

    user = (
        f"Player (do not repeat this name in the blurb): {player_name or player_id}\n\n"
        f"Source posts (newest first):\n{json.dumps(timeline, indent=2)}\n\n"
        "Write one JSON field summary with the one-line blurb."
    )
    result = _generate_json(
        system=ONELINER_SYSTEM,
        user=user,
        schema=NARRATIVE_SCHEMA,
    )
    assert isinstance(result, dict)
    return normalize_oneliner(str(result.get("summary") or ""), player_name)


def build_oneliners_batch(
    items: list[dict[str, Any]],
) -> dict[str, str]:
    """One-liners for multiple players. Each item: player_id, player_name, reports."""
    if not items:
        return {}

    if len(items) == 1:
        only = items[0]
        return {
            only["player_id"]: build_player_oneliner(
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
        if item.get("reports")
    ]
    if not payload:
        return {}

    user = (
        "For each player, write one short blurb in JSON results[].summary. "
        "Do not include the player's name in the blurb.\n\n"
        f"{json.dumps(payload, indent=2)}"
    )
    result = _generate_json(
        system=ONELINER_SYSTEM,
        user=user,
        schema=BATCH_NARRATIVE_SCHEMA,
    )
    assert isinstance(result, dict)
    out: dict[str, str] = {}
    name_by_id = {item["player_id"]: item.get("player_name") for item in items}
    for row in result.get("results") or []:
        pid = row.get("player_id")
        if pid:
            out[str(pid)] = normalize_oneliner(
                str(row.get("summary") or ""),
                name_by_id.get(str(pid)),
            )
    return out
