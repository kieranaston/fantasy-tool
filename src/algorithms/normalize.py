"""Min-max normalization and weighted composite scoring."""

from __future__ import annotations


def normalize_values(values: list[float]) -> list[float]:
    """Scale values to 0–100 within the pool. Constant pool → 50."""
    if not values:
        return []
    min_value = min(values)
    max_value = max(values)
    if max_value == min_value:
        return [50.0] * len(values)
    span = max_value - min_value
    return [(value - min_value) / span * 100.0 for value in values]


def mean_pair(a: list[float], b: list[float]) -> list[float]:
    """Element-wise average of two equal-length series."""
    return [(x + y) / 2.0 for x, y in zip(a, b, strict=True)]


def weighted_score(components: dict[str, float], weights: dict[str, float]) -> float:
    """Weighted sum of named normalized components."""
    total = 0.0
    for key, weight in weights.items():
        total += weight * components[key]
    return round(total, 1)


def format_scores(
    components: dict[str, float],
    weights_by_format: dict[str, dict[str, float]],
) -> dict[str, float]:
    """Compute a score for each scoring format."""
    return {
        fmt: weighted_score(components, weights)
        for fmt, weights in weights_by_format.items()
    }
