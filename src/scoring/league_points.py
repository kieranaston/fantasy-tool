"""Score raw season stats with a Sleeper league's scoring_settings."""

from __future__ import annotations

from typing import Any, Mapping

# FantasyPros skill-player stats we know how to map → Sleeper scoring keys.
STAT_SCORING_KEYS: dict[str, str] = {
    "pass_yd": "pass_yd",
    "pass_td": "pass_td",
    "pass_int": "pass_int",
    "pass_2pt": "pass_2pt",
    "rush_yd": "rush_yd",
    "rush_td": "rush_td",
    "rush_2pt": "rush_2pt",
    "rec": "rec",
    "rec_yd": "rec_yd",
    "rec_td": "rec_td",
    "rec_2pt": "rec_2pt",
    "fum_lost": "fum_lost",
    "fum": "fum",
}


def _num(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def projected_points(
    stats: Mapping[str, Any],
    scoring_settings: Mapping[str, Any],
    *,
    position: str | None = None,
) -> float:
    """Apply league scoring weights to a player season-stat dict.

    Unknown scoring keys are ignored. Stats missing from ``stats`` count as 0.
    TE reception premiums (``bonus_rec_te``) are applied when present.
    """
    settings = scoring_settings or {}
    total = 0.0

    for stat_key, scoring_key in STAT_SCORING_KEYS.items():
        weight = settings.get(scoring_key)
        if weight is None:
            continue
        total += _num(stats.get(stat_key)) * _num(weight)

    pos = (position or "").upper()
    bonus_te = settings.get("bonus_rec_te")
    if bonus_te is not None and pos == "TE":
        total += _num(stats.get("rec")) * _num(bonus_te)

    return round(total, 2)
