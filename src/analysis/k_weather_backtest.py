"""Backtest kickoff weather as a kicker-chart input.

For each season and slate week ``W`` this builds, per team, the implied total
and a weather index from the game's actual wind/temperature/roof, then
rank-correlates (Spearman) with the kicker's points in week ``W``.

Findings that set ``K_CHART_*_WEIGHT`` (2024-2025, weeks 4-18):

* implied total alone: rho ~0.18
* weather index alone adds ~0.16 partial correlation beyond the total
* blend peaks near 50-60% total / 40-50% weather (rho ~0.23)
* tested and dropped (partial rho <= 0.05): FG attempts per game, FG attempts
  per drive, red-zone FG share, opponent FGs allowed, kicker accuracy

The backtest uses actual game weather; the live board uses the forecast, which
is noisier, so expect a somewhat smaller gain.

Run::

    python -m src.analysis.k_weather_backtest
"""

from __future__ import annotations

import argparse
from statistics import mean

import polars as pl

from src.analysis.chart_weight_backtest import (
    _implied_by_week,
    kicker_points_by_week_team,
    spearman,
)
from src.def_streamers.projection_pool import composite_scores
from src.loaders import nflverse
from src.loaders.weather import DOME_TEMP_F, DOME_WIND_MPH, kicker_weather_index

MIN_WEEK = 4
MAX_WEEK = 18


def _ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2
        i = j + 1
    return out


def _corr(a: list[float], b: list[float]) -> float:
    ma, mb = mean(a), mean(b)
    sa = sum((x - ma) ** 2 for x in a)
    sb = sum((y - mb) ** 2 for y in b)
    if not sa or not sb:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb) ** 0.5


def _residual(y: list[float], x: list[float]) -> list[float]:
    mx, my = mean(x), mean(y)
    slope = sum((a - mx) * (c - my) for a, c in zip(x, y)) / sum((a - mx) ** 2 for a in x)
    return [c - my - slope * (a - mx) for a, c in zip(x, y)]


def build_rows(season: int) -> list[list[dict]]:
    """One list of ``{imp, wx, y}`` team rows per slate week."""
    games = nflverse.fetch_schedules(seasons=[season])
    implied = _implied_by_week(games, season)
    kicker_pts = kicker_points_by_week_team(season)
    pbp = nflverse._load_reg_pbp([season], ["posteam", "roof", "temp", "wind"])
    weather = (
        pbp.filter(pl.col("posteam").is_not_null())
        .group_by(["week", "posteam"])
        .agg(
            pl.col("roof").first().alias("roof"),
            pl.col("temp").first().alias("temp"),
            pl.col("wind").first().alias("wind"),
        )
        .to_dicts()
    )
    by_week: dict[int, list[dict]] = {}
    for rec in weather:
        week, team = rec["week"], rec["posteam"]
        pts = kicker_pts.get((week, team))
        imp = implied.get(week, {}).get(team)
        if pts is None or imp is None or not MIN_WEEK <= week <= MAX_WEEK:
            continue
        indoors = (rec["roof"] or "") in ("dome", "closed")
        wind = DOME_WIND_MPH if indoors or rec["wind"] is None else float(rec["wind"])
        temp = DOME_TEMP_F if indoors or rec["temp"] is None else float(rec["temp"])
        by_week.setdefault(week, []).append(
            {"imp": float(imp), "wx": kicker_weather_index(wind, temp), "y": float(pts)}
        )
    return [rows for _, rows in sorted(by_week.items()) if len(rows) >= 5]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seasons", type=int, nargs="+", default=[2024, 2025])
    args = parser.parse_args()

    weeks: list[list[dict]] = []
    for season in args.seasons:
        weeks += build_rows(season)

    def week_rho(rows, scores):
        return spearman(scores, [r["y"] for r in rows]) or 0.0

    base = mean(week_rho(w, [r["imp"] for r in w]) for w in weeks)
    wx_only = mean(week_rho(w, [r["wx"] for r in w]) for w in weeks)
    ry, ri, rw = [], [], []
    for w in weeks:
        ry += _ranks([r["y"] for r in w])
        ri += _ranks([r["imp"] for r in w])
        rw += _ranks([r["wx"] for r in w])
    partial = _corr(_residual(ry, ri), _residual(rw, ri))
    print(f"Team-weeks: {sum(len(w) for w in weeks)}  slate-weeks: {len(weeks)}")
    print(f"Spearman(next-week K points): implied total {base:.3f}, weather {wx_only:.3f}")
    print(f"Weather partial correlation after the implied total: {partial:+.3f}\n")
    print("  wx(total share)   rho")
    for share in (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4):
        rho = mean(
            week_rho(
                w,
                composite_scores(
                    [r["imp"] for r in w],
                    [r["wx"] for r in w],
                    x_weight=share,
                    y_weight=1 - share,
                ),
            )
            for w in weeks
        )
        print(f"  {share:>14.1f}   {rho:.3f}")


if __name__ == "__main__":
    main()
