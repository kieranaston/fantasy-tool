"""Grounding validator: claims/quotes must appear in source text."""

from __future__ import annotations

import re
from typing import Any

from rapidfuzz import fuzz

# Minimum fuzzy ratio when exact substring match fails.
FUZZY_CLAIM_THRESHOLD = 86.0

EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F9FF"
    "\U00002600-\U000027BF"
    "\U0000FE00-\U0000FE0F"
    "\U0001F1E0-\U0001F1FF"
    "]+",
    flags=re.UNICODE,
)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def claim_supported(claim: str | None, source_text: str) -> bool:
    """Return True if claim is empty, substring, or high-ratio fuzzy match."""
    if claim is None:
        return True
    claim = claim.strip()
    if not claim:
        return True
    source = source_text or ""
    if not source:
        return False

    if claim in source:
        return True

    norm_claim = _normalize(claim)
    norm_source = _normalize(source)
    if norm_claim and norm_claim in norm_source:
        return True

    claim_len = len(norm_claim)
    if claim_len < 8:
        return fuzz.partial_ratio(norm_claim, norm_source) >= FUZZY_CLAIM_THRESHOLD

    best = fuzz.partial_ratio(norm_claim, norm_source)
    return best >= FUZZY_CLAIM_THRESHOLD


def validate_extraction(
    extraction: dict[str, Any],
    source_text: str,
) -> tuple[bool, list[str]]:
    """Validate Step A fields against source. Returns (ok, failed_fields)."""
    failed: list[str] = []
    for field in ("status", "designation", "direct_quote"):
        value = extraction.get(field)
        if value and not claim_supported(str(value), source_text):
            failed.append(field)
    return (len(failed) == 0, failed)


def validate_diff_summary(
    summary: str | None,
    source_texts: list[str],
) -> tuple[bool, list[str]]:
    """Validate a narrative summary.

    Rejects emoji dumps and ungrounded quoted spans. Allows search-backed
    context (camp dates, etc.) beyond the raw posts, so overlap checks are
    limited to explicit quotes from the briefing.
    """
    if not summary or not summary.strip():
        return True, []

    failed: list[str] = []
    if EMOJI_RE.search(summary):
        failed.append("emoji")

    stripped = re.sub(r"\([^)]{0,120}\)", " ", summary)
    combined = "\n".join(source_texts)

    quotes = re.findall(r'"([^"]{8,})"', stripped)
    for quote in quotes:
        if not claim_supported(quote, combined):
            failed.append(f"quote:{quote[:60]}")

    return (len(failed) == 0, failed)


def review_item(
    *,
    reason: str,
    source: dict[str, Any] | None = None,
    extraction: dict[str, Any] | None = None,
    failed_fields: list[str] | None = None,
) -> dict[str, Any]:
    from src.export.json_writer import utc_now_iso

    return {
        "timestamp": utc_now_iso(),
        "reason": reason,
        "failed_fields": failed_fields or [],
        "source": source,
        "extraction": extraction,
    }
