"""Tests for ADP-pool name matching and news publish filters."""

from __future__ import annotations

from datetime import datetime, timezone

from src.injuries.match import PlayerRef, match_pool_names_in_text
from src.injuries.serve import NEWS_MAX_AGE, TIMELINE_LIMIT, build_summaries
from src.loaders.bluesky import extract_posts_by_pool_names, posts_to_raw_reports


def _ref(pid: str, name: str, team: str = "SEA") -> PlayerRef:
    return PlayerRef(player_id=pid, name=name, team=team, position="WR")


POOL = [
    _ref("1", "Justin Jefferson", "MIN"),
    _ref("2", "Ja'Marr Chase", "CIN"),
    _ref("3", "Chris Olave", "NO"),
    _ref("4", "Chris Godwin", "TB"),  # ambiguous first name
    _ref("5", "Kenneth Walker III", "SEA"),
]


def test_full_name_match():
    hits = match_pool_names_in_text(
        "Justin Jefferson: limited in practice Monday.",
        POOL,
    )
    assert len(hits) == 1
    assert hits[0].ref.player_id == "1"
    assert hits[0].method == "full"


def test_unique_last_name_match():
    hits = match_pool_names_in_text(
        "Jefferson was a full participant today.",
        POOL,
    )
    assert len(hits) == 1
    assert hits[0].ref.player_id == "1"
    assert hits[0].method == "last"


def test_ambiguous_first_name_skipped():
    hits = match_pool_names_in_text(
        "Chris is expected to play this week.",
        POOL,
    )
    assert hits == []


def test_unique_first_name_match():
    pool = [_ref("1", "Justin Jefferson"), _ref("2", "Ja'Marr Chase")]
    hits = match_pool_names_in_text("Justin practiced fully.", pool)
    assert len(hits) == 1
    assert hits[0].method == "first"


def test_suffix_name_still_matches_last():
    hits = match_pool_names_in_text("Walker III returns to practice.", POOL)
    assert any(h.ref.player_id == "5" for h in hits)


def test_extract_posts_drops_unmatched():
    posts = [
        {
            "url": "https://bsky.app/profile/x/post/1",
            "created_at": "2026-09-01T12:00:00Z",
            "text": "Justin Jefferson: questionable for Sunday.",
        },
        {
            "url": "https://bsky.app/profile/x/post/2",
            "created_at": "2026-09-01T13:00:00Z",
            "text": "Random coaching staff notes with no ADP names.",
        },
    ]
    items = extract_posts_by_pool_names(posts, POOL)
    assert len(items) == 1
    assert items[0]["player_id"] == "1"
    assert "questionable" in items[0]["designation"].lower()


def test_posts_to_raw_reports_uses_pool_player_id():
    posts = [
        {
            "url": "https://bsky.app/profile/x/post/1",
            "created_at": "2026-09-01T12:00:00Z",
            "text": "Jefferson: out this week.",
        }
    ]
    extractions = extract_posts_by_pool_names(posts, POOL)
    rows = posts_to_raw_reports(posts, extractions)
    assert len(rows) == 1
    assert rows[0]["player_id"] == "1"
    assert rows[0]["needs_review"] is False


def test_build_summaries_keeps_old_timeline_for_fresh_player():
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    status = {
        "1": {
            "player_name": "Justin Jefferson",
            "last_updated": "2026-09-07T12:00:00Z",
            "last_diff_summary": "recent",
        }
    }
    # One recent + many older updates — all should remain up to TIMELINE_LIMIT
    reports = []
    for i in range(TIMELINE_LIMIT + 5):
        day = 7 - min(i, 6)  # newest first-ish timestamps
        reports.append(
            {
                "id": str(i),
                "player_id": "1",
                "player_name": "Justin Jefferson",
                "timestamp": f"2026-09-{day:02d}T12:00:00Z",
                "designation": f"note-{i}",
                "source_text": f"update {i}",
                "url": f"https://example.com/{i}",
                "source_type": "beat_reporter",
                "needs_review": False,
            }
        )
    # Stale player with only old news — should drop
    reports.append(
        {
            "id": "stale",
            "player_id": "2",
            "player_name": "Ja'Marr Chase",
            "timestamp": "2026-01-01T12:00:00Z",
            "designation": "old",
            "source_text": "ancient update",
            "url": "https://example.com/stale",
            "source_type": "beat_reporter",
            "needs_review": False,
        }
    )
    status["2"] = {
        "player_name": "Ja'Marr Chase",
        "last_updated": "2026-01-01T12:00:00Z",
        "last_diff_summary": "old",
    }

    payload = build_summaries(
        status_current=status,
        reports=reports,
        last_updated="2026-09-08T00:00:00Z",
        allowed_player_ids={"1", "2"},
        teams_by_id={"1": "MIN", "2": "CIN"},
        now=now,
    )
    players = {p["player_id"]: p for p in payload["players"]}
    assert "1" in players
    assert "2" not in players
    assert len(players["1"]["timeline"]) == TIMELINE_LIMIT
    assert payload["news_max_age_days"] == NEWS_MAX_AGE.days


def test_build_summaries_drops_fa_team():
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    payload = build_summaries(
        status_current={
            "1": {
                "player_name": "Free Agent",
                "last_updated": "2026-09-07T12:00:00Z",
                "last_diff_summary": "signed",
            }
        },
        reports=[
            {
                "id": "a",
                "player_id": "1",
                "player_name": "Free Agent",
                "timestamp": "2026-09-07T12:00:00Z",
                "designation": "signed",
                "source_text": "picked up",
                "url": "https://example.com/a",
                "source_type": "beat_reporter",
                "needs_review": False,
            }
        ],
        last_updated="2026-09-08T00:00:00Z",
        allowed_player_ids={"1"},
        teams_by_id={"1": "FA"},
        now=now,
    )
    assert payload["players"] == []


def test_build_summaries_includes_summary_field():
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    payload = build_summaries(
        status_current={
            "1": {
                "player_name": "Justin Jefferson",
                "last_updated": "2026-09-07T12:00:00Z",
                "last_diff_summary": "Limited Wednesday; questionable for Sunday.",
            }
        },
        reports=[
            {
                "id": "a",
                "player_id": "1",
                "player_name": "Justin Jefferson",
                "timestamp": "2026-09-07T12:00:00Z",
                "designation": "questionable",
                "source_text": "Justin Jefferson: limited Wednesday.",
                "url": "https://example.com/a",
                "source_type": "beat_reporter",
                "needs_review": False,
            }
        ],
        last_updated="2026-09-08T00:00:00Z",
        allowed_player_ids={"1"},
        teams_by_id={"1": "MIN"},
        now=now,
    )
    assert payload["players"][0]["summary"].startswith("Limited")


def test_normalize_oneliner_strips_name():
    from src.injuries.summarize import fallback_oneliner, normalize_oneliner

    assert (
        normalize_oneliner(
            "Justin Jefferson: limited in practice.",
            "Justin Jefferson",
        )
        == "limited in practice."
    )
    blurb = fallback_oneliner(
        player_name="Justin Jefferson",
        reports=[
            {
                "timestamp": "2026-09-07T12:00:00Z",
                "source_text": "Justin Jefferson: questionable for Sunday. https://x.com/a",
                "designation": "questionable for Sunday.",
            }
        ],
    )
    assert "Jefferson" not in blurb
    assert "questionable" in blurb.lower()
