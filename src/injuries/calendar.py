"""NFL calendar helpers for injury/player-news polling windows."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def second_sunday_of_february(year: int) -> datetime:
    """NFL Super Bowl date convention: second Sunday in February (UTC midnight)."""
    first = datetime(year, 2, 1, tzinfo=timezone.utc)
    days_until_sunday = (6 - first.weekday()) % 7
    first_sunday = first + timedelta(days=days_until_sunday)
    return first_sunday + timedelta(days=7)


def post_super_bowl_cutoff(now: datetime | None = None) -> datetime:
    """UTC start of the second day after the most recent Super Bowl.

    Skips Super Bowl game-day injury reports (often posted the following morning).
    """
    now = now or datetime.now(timezone.utc)
    sb = second_sunday_of_february(now.year)
    if now.date() <= sb.date():
        sb = second_sunday_of_february(now.year - 1)
    start = sb + timedelta(days=2)
    return start.replace(hour=0, minute=0, second=0, microsecond=0)
