"""Sleeper draft + league helpers (public read API)."""

from __future__ import annotations

from typing import Any

import httpx

SLEEPER_API = "https://api.sleeper.app/v1"
UA = {"User-Agent": "fantasy-tool/0.1"}


def _get(path: str, *, timeout: float = 30.0) -> Any:
    response = httpx.get(f"{SLEEPER_API}{path}", headers=UA, timeout=timeout)
    response.raise_for_status()
    return response.json()


def fetch_league(league_id: str) -> dict[str, Any]:
    data = _get(f"/league/{league_id}")
    if not isinstance(data, dict):
        raise RuntimeError("Unexpected league payload")
    return data


def fetch_league_users(league_id: str) -> list[dict[str, Any]]:
    data = _get(f"/league/{league_id}/users")
    return data if isinstance(data, list) else []


def fetch_league_drafts(league_id: str) -> list[dict[str, Any]]:
    data = _get(f"/league/{league_id}/drafts")
    return data if isinstance(data, list) else []


def fetch_draft(draft_id: str) -> dict[str, Any]:
    data = _get(f"/draft/{draft_id}")
    if not isinstance(data, dict):
        raise RuntimeError("Unexpected draft payload")
    return data


def fetch_draft_picks(draft_id: str) -> list[dict[str, Any]]:
    data = _get(f"/draft/{draft_id}/picks")
    return data if isinstance(data, list) else []


def fetch_traded_picks(draft_id: str) -> list[dict[str, Any]]:
    data = _get(f"/draft/{draft_id}/traded_picks")
    return data if isinstance(data, list) else []


def resolve_draft_id(league_or_draft: str) -> str:
    """Accept a raw id or Sleeper URL and return a draft_id."""
    text = (league_or_draft or "").strip()
    if not text:
        raise ValueError("Empty league/draft id")
    # URLs like https://sleeper.com/draft/nfl/<id> or /leagues/<id>
    parts = [p for p in text.replace("?", "/").split("/") if p]
    if "draft" in parts:
        idx = parts.index("draft")
        for token in parts[idx + 1 :]:
            if token.isdigit():
                return token
    if "leagues" in parts or "league" in parts:
        key = "leagues" if "leagues" in parts else "league"
        idx = parts.index(key)
        for token in parts[idx + 1 :]:
            if token.isdigit():
                drafts = fetch_league_drafts(token)
                if not drafts:
                    raise RuntimeError(f"No drafts for league {token}")
                return str(drafts[0]["draft_id"])
    if text.isdigit():
        # Prefer draft lookup; fall back to league drafts.
        try:
            draft = fetch_draft(text)
            if draft.get("draft_id"):
                return str(draft["draft_id"])
        except Exception:
            drafts = fetch_league_drafts(text)
            if drafts:
                return str(drafts[0]["draft_id"])
        return text
    raise ValueError(f"Could not parse league/draft id from: {text}")


def build_roster_map(picks: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Group picks by roster_id for need evaluation."""
    rosters: dict[str, list[dict[str, Any]]] = {}
    for pick in picks:
        roster_id = str(pick.get("roster_id") or "")
        if not roster_id:
            continue
        meta = pick.get("metadata") or {}
        rosters.setdefault(roster_id, []).append(
            {
                "player_id": str(pick.get("player_id") or ""),
                "position": str(meta.get("position") or "").upper(),
                "name": f"{meta.get('first_name') or ''} {meta.get('last_name') or ''}".strip(),
                "round": pick.get("round"),
                "pick_no": pick.get("pick_no"),
                "draft_slot": pick.get("draft_slot"),
            }
        )
    return rosters


def snapshot_draft(draft_id: str) -> dict[str, Any]:
    """Full draft snapshot for live UI or mock replay fixtures."""
    draft = fetch_draft(draft_id)
    picks = fetch_draft_picks(draft_id)
    traded = fetch_traded_picks(draft_id)
    league_id = draft.get("league_id")
    users = fetch_league_users(str(league_id)) if league_id else []
    return {
        "draft": draft,
        "picks": picks,
        "traded_picks": traded,
        "users": users,
        "rosters": build_roster_map(picks),
    }
