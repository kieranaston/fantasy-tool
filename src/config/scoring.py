"""Scoring formats and shared ranking constants."""

FORMATS = ("standard", "half_ppr", "full_ppr")
FORMAT_LABELS = {
    "standard": "Standard",
    "half_ppr": "Half-PPR",
    "full_ppr": "Full-PPR",
}

SKILL_POSITIONS = ("QB", "RB", "WR", "TE")

TOP_RANKINGS = 40
MIN_REG_WEEKS = 18

# Format weights applied to already-normalized 0–100 rate components.
# Prefer per-game opportunity + efficiency rates (injury-fair vs season totals/shares).
RB_WEIGHTS = {
    "standard": {"touches_pg": 0.5, "yards_per_touch": 0.35, "targets_pg": 0.15},
    "half_ppr": {"touches_pg": 0.4, "yards_per_touch": 0.25, "targets_pg": 0.35},
    "full_ppr": {"touches_pg": 0.3, "yards_per_touch": 0.2, "targets_pg": 0.5},
}

WR_WEIGHTS = {
    "standard": {"targets_pg": 0.4, "adot": 0.3, "yprr": 0.3},
    "half_ppr": {"targets_pg": 0.5, "adot": 0.25, "yprr": 0.25},
    "full_ppr": {"targets_pg": 0.6, "adot": 0.2, "yprr": 0.2},
}

TE_WEIGHTS = {
    "standard": {"targets_pg": 0.45, "yards_per_target": 0.35, "yprr": 0.2},
    "half_ppr": {"targets_pg": 0.55, "yards_per_target": 0.25, "yprr": 0.2},
    "full_ppr": {"targets_pg": 0.65, "yards_per_target": 0.2, "yprr": 0.15},
}

QB_WEIGHTS = {
    "pass_attempts_pg": 0.4,
    "rush_attempts_pg": 0.35,
    "yards_per_attempt": 0.25,
}
