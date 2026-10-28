"""Sweep the streamer chart's other parameters (window, min-games, blend,
normalisation, axis weight) against next-week points, with a train/test split.

Objective: pooled Spearman of the chart composite vs the score the player
actually posted the following week. Trains on earlier seasons, then confirms the
winning config on a held-out season so the choices aren't pure in-sample fits.

Run::

    python -m src.analysis.chart_param_sweep
"""

from __future__ import annotations

from statistics import mean

import polars as pl

from src.analysis.chart_weight_backtest import (
    dst_points_by_week_team,
    kicker_points_by_week_team,
    spearman,
)
from src.def_streamers.projection_pool import composite_scores
from src.loaders.nflverse import (
    fetch_ff_opportunity,
    fetch_schedules,
    implied_team_totals,
    summarize_season_xfp,
    team_fg_attempts_per_game,
    team_sack_rates,
)

SKILL_POSITIONS = ["QB", "RB", "WR", "TE"]
WINDOWS = [2, 3, 4, 5]
MIN_GAMES_OPTIONS = [1, 2, 3]
WEIGHTS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
BLENDS = [0.5, 0.6, 0.67, 0.75, 0.85, 1.0]
NORMALIZATIONS = ["minmax", "percentile"]

TRAIN_SEASONS = [2021, 2022, 2023, 2024]
TEST_SEASONS = [2025]


def _minmax(xs: list[float], ys: list[float], x_sign=1.0, y_sign=1.0, w=0.5):
    x0, xM = min(xs), max(xs)
    y0, yM = min(ys), max(ys)
    xsp = (xM - x0) or 1.0
    ysp = (yM - y0) or 1.0
    out = []
    for x, y in zip(xs, ys):
        gx = (x - x0) / xsp if x_sign >= 0 else 1 - (x - x0) / xsp
        gy = (y - y0) / ysp if y_sign >= 0 else 1 - (y - y0) / ysp
        out.append(w * gx + (1 - w) * gy)
    return out


def _composite(norm, xs, ys, x_sign, y_sign, w):
    if norm == "minmax":
        return _minmax(xs, ys, x_sign, y_sign, w)
    return composite_scores(
        xs, ys, x_sign=x_sign, y_sign=y_sign, x_weight=w, y_weight=1 - w
    )


def _pooled(vals):
    return mean(vals) if vals else None


# --------------------------------------------------------------------------- #
# Skill cache: (season, week, pos, window) -> rows before the min-games gate
# --------------------------------------------------------------------------- #

def _skill_cache(seasons):
    cache: dict[tuple, list] = {}
    for season in seasons:
        df = pl.read_parquet(fetch_ff_opportunity(season))
        for pos in SKILL_POSITIONS:
            for week in range(3, 19):
                target_rows = summarize_season_xfp(
                    df, pos, season=season, as_of_week=week + 1, window=1
                )
                target = {r["player_id"]: r["fantasy_points"] for r in target_rows}
                for w in WINDOWS:
                    rows = summarize_season_xfp(
                        df, pos, season=season, as_of_week=week, window=w
                    )
                    kept = []
                    for r in rows:
                        t = target.get(r["player_id"])
                        if t is None:
                            continue
                        kept.append((r["xfpts"], r["fpoe"], r["games"], t))
                    cache[(season, week, pos, w)] = kept
    return cache


def sweep_skill(seasons, cache):
    # key -> list of per-(week,pos) rho
    results: dict[tuple, list] = {}
    for window in WINDOWS:
        min_week = window + 1
        for min_games in [g for g in MIN_GAMES_OPTIONS if g <= window]:
            for norm in NORMALIZATIONS:
                for weight in WEIGHTS:
                    key = (window, min_games, norm, weight)
                    results[key] = []
            for season in seasons:
                for week in range(min_week, 19):
                    for pos in SKILL_POSITIONS:
                        rows = [
                            (x, y, t)
                            for (x, y, games, t) in cache[(season, week, pos, window)]
                            if games >= min_games
                        ]
                        if len(rows) < 5:
                            continue
                        xs = [r[0] for r in rows]
                        ys = [r[1] for r in rows]
                        tgt = [r[2] for r in rows]
                        for norm in NORMALIZATIONS:
                            for weight in WEIGHTS:
                                scores = _composite(norm, xs, ys, 1.0, 1.0, weight)
                                r = spearman(scores, tgt)
                                if r is not None:
                                    results[(window, min_games, norm, weight)].append(r)
    return {k: _pooled(v) for k, v in results.items()}


# --------------------------------------------------------------------------- #
# DEF / K caches
# --------------------------------------------------------------------------- #

def _rates_cache(seasons, target):
    cache: dict[tuple, dict] = {}
    for season in seasons:
        for week in range(4, 19):
            try:
                if target == "def":
                    cache[(season, week)] = team_sack_rates(
                        [season], as_of_season=season, as_of_week=week
                    )
                else:
                    cache[(season, week)] = team_fg_attempts_per_game(
                        [season], as_of_season=season, as_of_week=week
                    )
            except (ValueError, FileNotFoundError):
                cache[(season, week)] = None
    return cache


def _def_sample_rows(season, week, games, implied, dst_pts, rates, blend):
    rows = []
    for g in games:
        if (
            g.get("season") != season
            or g.get("game_type") != "REG"
            or g.get("week") != week
            or g.get("total_line") is None
            or g.get("spread_line") is None
        ):
            continue
        away, home = str(g["away_team"]), str(g["home_team"])
        away_imp, home_imp = implied_team_totals(
            float(g["spread_line"]), float(g["total_line"])
        )
        for team, opp, opp_imp in ((home, away, away_imp), (away, home, home_imp)):
            pts = dst_pts.get((week, team))
            tr = rates.get(team)
            opr = rates.get(opp)
            if pts is None or not tr or not opr:
                continue
            proj = blend * float(opr["offense_sack_rate"]) + (1 - blend) * float(
                tr["defense_sack_rate"]
            )
            rows.append((proj, float(opp_imp), float(pts)))
    return rows


def _k_sample_rows(week, implied, kicker_pts, rates):
    rows = []
    for team, implied_total in implied.get(week, {}).items():
        pts = kicker_pts.get((week, team))
        r = rates.get(team)
        if pts is None or not r:
            continue
        rows.append((float(implied_total), float(r["fg_attempts_per_game"]), float(pts)))
    return rows


def sweep_team(target, seasons):
    rate_cache = _rates_cache(seasons, target)
    results: dict[tuple, list] = {}
    meta = {}
    for season in seasons:
        games = fetch_schedules(seasons=[season])
        implied = {}
        for g in games:
            if (
                g.get("season") != season
                or g.get("game_type") != "REG"
                or g.get("total_line") is None
                or g.get("spread_line") is None
                or g.get("week") is None
            ):
                continue
            aw, hm = implied_team_totals(
                float(g["spread_line"]), float(g["total_line"])
            )
            implied.setdefault(int(g["week"]), {})[str(g["away_team"])] = aw
            implied.setdefault(int(g["week"]), {})[str(g["home_team"])] = hm
        meta[season] = (games, implied)
        if target == "def":
            ydat = dst_points_by_week_team(season, games)
        else:
            ydat = kicker_points_by_week_team(season)
        for week in range(4, 19):
            rates = rate_cache.get((season, week))
            if not rates:
                continue
            blends = BLENDS if target == "def" else [None]
            for blend in blends:
                if target == "def":
                    rows = _def_sample_rows(
                        season, week, games, implied, ydat, rates, blend
                    )
                else:
                    rows = _k_sample_rows(week, implied, ydat, rates)
                if len(rows) < 5:
                    continue
                xs = [r[0] for r in rows]
                ys = [r[1] for r in rows]
                tgt = [r[2] for r in rows]
                y_sign = -1.0 if target == "def" else 1.0
                for norm in NORMALIZATIONS:
                    for weight in WEIGHTS:
                        key = (blend, norm, weight)
                        scores = _composite(norm, xs, ys, 1.0, y_sign, weight)
                        r = spearman(scores, tgt)
                        if r is not None:
                            results.setdefault(key, []).append(r)
    return {k: _pooled(v) for k, v in results.items()}


def _top(results, n=8):
    ranked = [(k, v) for k, v in results.items() if v is not None]
    ranked.sort(key=lambda kv: -kv[1])
    return ranked[:n]


def main() -> None:
    print("== SKILL: sweep on train", TRAIN_SEASONS)
    train_cache = _skill_cache(TRAIN_SEASONS)
    train = sweep_skill(TRAIN_SEASONS, train_cache)
    print("top configs (window, min_games, norm, weight) -> pooled rho")
    for k, v in _top(train):
        print(f"  {k}  {v:.3f}")

    print("\n== SKILL: top-3 on held-out", TEST_SEASONS)
    test_cache = _skill_cache(TEST_SEASONS)
    test = sweep_skill(TEST_SEASONS, test_cache)
    for k, _ in _top(train, 3):
        print(f"  {k}  test rho {test.get(k, float('nan')):.3f}")
    # current production config for reference
    cur = (3, 2, "percentile", 0.8)
    print(
        f"  current {cur}  train {train.get(cur, float('nan')):.3f}  "
        f"test {test.get(cur, float('nan')):.3f}"
    )

    for target in ["k", "def"]:
        print(f"\n== {target.upper()}: sweep on train")
        tr = sweep_team(target, TRAIN_SEASONS)
        for k, v in _top(tr, 6):
            print(f"  {k}  {v:.3f}")
        print(f"== {target.upper()}: top-2 on held-out {TEST_SEASONS}")
        te = sweep_team(target, TEST_SEASONS)
        for k, _ in _top(tr, 2):
            print(f"  {k}  test rho {te.get(k, float('nan')):.3f}")


if __name__ == "__main__":
    main()
