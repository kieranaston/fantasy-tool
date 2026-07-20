"""Scoring formats and shared ranking constants."""

FORMATS = ("standard", "half_ppr", "full_ppr")
FORMAT_LABELS = {
    "standard": "Standard",
    "half_ppr": "Half-PPR",
    "full_ppr": "Full-PPR",
}

SKILL_POSITIONS = ("QB", "RB", "WR", "TE")

MIN_GAMES = 8
TOP_RANKINGS = 40
MIN_REG_WEEKS = 18

RB_MIN_AVG_TOUCHES = 10.0
WR_MIN_AVG_TARGETS = 5.0
TE_MIN_AVG_TARGETS = 3.0
QB_MIN_AVG_PASS_ATTEMPTS = 20.0

# Format weights applied to already-normalized 0–100 components.
RB_WEIGHTS = {
    "standard": {"opportunity_share": 0.4, "yards_from_scrimmage": 0.4, "efficiency": 0.2},
    "half_ppr": {"opportunity_share": 0.5, "yards_from_scrimmage": 0.3, "efficiency": 0.2},
    "full_ppr": {"opportunity_share": 0.6, "yards_from_scrimmage": 0.2, "efficiency": 0.2},
}

WR_WEIGHTS = {
    "standard": {"target_share": 0.4, "air_adot": 0.35, "yprr": 0.25},
    "half_ppr": {"target_share": 0.5, "air_adot": 0.3, "yprr": 0.2},
    "full_ppr": {"target_share": 0.6, "air_adot": 0.25, "yprr": 0.15},
}

TE_WEIGHTS = {
    "standard": {"receiving_ypg": 0.5, "target_share": 0.3, "td_rate": 0.2},
    "half_ppr": {"receiving_ypg": 0.4, "target_share": 0.4, "td_rate": 0.2},
    "full_ppr": {"receiving_ypg": 0.3, "target_share": 0.5, "td_rate": 0.2},
}

QB_WEIGHTS = {
    "pass_attempts": 0.4,
    "rush_attempts": 0.3,
    "td_rate": 0.2,
    "yards_per_attempt": 0.1,
}
