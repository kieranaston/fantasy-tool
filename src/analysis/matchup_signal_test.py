"""Test whether a current-week matchup signal adds predictive value for the
skill boards, and how the gating floor affects ranking quality.

Two experiments:

1. **Matchup signal.** For each player-week, compare rank correlation with the
   player's actual points for:
     * xFP alone (usage),
     * the current 0.9/0.1 usage/efficiency composite,
     * usage scaled by opponent points-allowed-to-position,
     * usage scaled by a Vegas environment factor (team implied total),
     * blends of the above.
   Opponent defense strength is computed only from prior weeks (as-of), so there
   is no leakage. Trains on earlier seasons and confirms on a holdout.

2. **Gating floor.** Re-run the skill ranking under different total-points-floor
   multipliers and report both rank correlation and how many players survive,
   because a stricter gate can raise correlation while shrinking the pool.

Run::

    python -m src.analysis.matchup_signal_test
"""

from __future__ import annotations

from statistics import mean

import polars as pl

from src.analysis.chart_param_sweep import SKILL_POSITIONS, _skill_cache
from src.analysis.chart_weight_backtest import spearman
from src.def_streamers.projection_pool import composite_scores
from src.def_streamers.skill_matchup import (
    SKILL_MIN_TOTAL_POINTS,
    SKILL_WINDOW_WEEKS,
)
from src.loaders.nflverse import (
    fetch_ff_opportunity,
    fetch_player_week_stats,
    fetch_schedules,
    implied_team_totals,
    summarize_season_xfp,
)

TRAIN_SEASONS = [2021, 2022, 2023, 2024]
TEST_SEASONS = [2025]
LOOKBACK = 5
MIN_WEEK = 6
MAX_WEEK = 18


def _implied_lookup(games: list[dict], season: int):
    """game_id -> {team: (team_implied, opp, opp_implied)}."""
    out: dict[str, dict] = {}
    for g in games:
        if (
            g.get("season") != season
            or g.get("game_type") != "REG"
            or g.get("total_line") is None
            or g.get("spread_line") is None
        ):
            continue
        away, home = str(g["away_team"]), str(g["home_team"])
        away_imp, home_imp = implied_team_totals(
            float(g["spread_line"]), float(g["total_line"])
        )
        out[str(g["game_id"])] = {
            away: (away_imp, home, home_imp),
            home: (home_imp, away, away_imp),
        }
    return out


def _defense_allowed(season: int) -> dict[tuple[int, str, str], float]:
    """(week, defense, position) -> total half-PPR allowed to that position."""
    pw = pl.read_parquet(fetch_player_week_stats(season))
    pw = pw.filter(pl.col("season_type") == "REG").with_columns(
        (pl.col("fantasy_points") + 0.5 * pl.col("receptions")).alias("half")
    )
    per_game = (
        pw.filter(pl.col("opponent_team").is_not_null())
        .group_by(["week", "game_id", "opponent_team", "position"])
        .agg(pl.col("half").sum().alias("allowed"))
    )
    out: dict[tuple[int, str, str], float] = {}
    for row in per_game.iter_rows(named=True):
        out[(int(row["week"]), str(row["opponent_team"]), str(row["position"]))] = (
            float(row["allowed"])
        )
    return out


def _defense_multipliers(allowed, season: int, week: int) -> dict[tuple[str, str], float]:
    """Position-defense multiplier from the prior LOOKBACK weeks (no leakage)."""
    lo, hi = week - LOOKBACK, week - 1
    totals: dict[tuple[str, str], list[float]] = {}
    league: dict[str, list[float]] = {}
    for (w, defteam, pos), val in allowed.items():
        if w < lo or w > hi:
            continue
        totals.setdefault((defteam, pos), []).append(val)
        league.setdefault(pos, []).append(val)
    lg_mean = {pos: mean(v) for pos, v in league.items() if v}
    out: dict[tuple[str, str], float] = {}
    for (defteam, pos), vals in totals.items():
        base = lg_mean.get(pos)
        if len(vals) >= 3 and base:
            out[(defteam, pos)] = mean(vals) / base
    return out


def _pct_composite(xs, ys, wx=0.9, wy=0.1):
    return composite_scores(xs, ys, x_weight=wx, y_weight=wy)


def _z(vals):
    m = mean(vals)
    sd = (mean((v - m) ** 2 for v in vals)) ** 0.5 or 1.0
    return [(v - m) / sd for v in vals]


def run_matchup(seasons, verbose=True):
    """Return {candidate: pooled Spearman} for the matchup experiment."""
    cands = [
        "xfp",
        "current_composite",
        "xfp_x_defmult",
        "xfp_x_teampimp",
        "xfp_x_defmult_x_teampimp",
        "xfp_x_defmult_plus_env",
        "teampimp_only",
    ]
    acc = {c: [] for c in cands}
    for season in seasons:
        df = pl.read_parquet(fetch_ff_opportunity(season))
        games = fetch_schedules(seasons=[season])
        implied = _implied_lookup(games, season)
        allowed = _defense_allowed(season)
        for week in range(MIN_WEEK, MAX_WEEK + 1):
            mult = _defense_multipliers(allowed, season, week)
            for pos in SKILL_POSITIONS:
                window = summarize_season_xfp(
                    df, pos, season=season, as_of_week=week, window=SKILL_WINDOW_WEEKS
                )
                period = summarize_season_xfp(
                    df, pos, season=season, as_of_week=week + 1, window=1
                )
                target = {r["player_id"]: r["fantasy_points"] for r in period}
                xs, fp, tm, am, tgt = [], [], [], [], []
                for r in window:
                    actual = target.get(r["player_id"])
                    if actual is None or r["games"] < 1:
                        continue
                    game = None
                    for gid, teams in implied.items():
                        if r["team"] in teams and gid.startswith(
                            f"{season}_{week:02d}_"
                        ):
                            game = teams[r["team"]]
                            break
                    if game is None:
                        continue
                    team_imp, opp, _opp_imp = game
                    xs.append(r["xfpts"])
                    fp.append(r["fpoe"])
                    tm.append(team_imp)
                    am.append(mult.get((opp, pos), 1.0))
                    tgt.append(actual)
                if len(xs) < 5:
                    continue
                cand_vals = {
                    "xfp": xs,
                    "current_composite": _pct_composite(xs, fp),
                    "xfp_x_defmult": [a * b for a, b in zip(xs, am)],
                    "xfp_x_teampimp": [a * b for a, b in zip(xs, tm)],
                    "xfp_x_defmult_x_teampimp": [
                        a * b * c for a, b, c in zip(xs, am, tm)
                    ],
                    "xfp_x_defmult_plus_env": [
                        a * b for a, b in zip(xs, am)
                    ],
                    "teampimp_only": tm,
                }
                # "plus_env": take usage*defmult rank and nudge by environment rank.
                base = [a * b for a, b in zip(xs, am)]
                cand_vals["xfp_x_defmult_plus_env"] = [
                    0.9 * u + 0.1 * e for u, e in zip(_z(base), _z(tm))
                ]
                for name, vals in cand_vals.items():
                    r = spearman(vals, tgt)
                    if r is not None:
                        acc[name].append(r)
    result = {c: (mean(v) if v else None) for c, v in acc.items()}
    if verbose:
        print("Matchup experiment — pooled Spearman vs next-week points")
        for c, v in sorted(result.items(), key=lambda kv: -(kv[1] or -9)):
            print(f"  {c:32s} {v:.3f}" if v is not None else f"  {c:32s} n/a")
    return result


def run_gating(seasons, verbose=True):
    """Floor multiplier vs rank quality and surviving pool size."""
    floors = [0.0, 0.5, 1.0, 1.5, 2.0]
    cache = _skill_cache(seasons)
    rows = []
    for mult in floors:
        rhos = []
        counts = []
        for (season, week, pos, window) in cache:
            if window != SKILL_WINDOW_WEEKS or week < SKILL_WINDOW_WEEKS + 1:
                continue
            threshold = SKILL_MIN_TOTAL_POINTS.get(pos, 0.0) * mult
            vals = [
                (x, y, t)
                for (x, y, games, t) in cache[(season, week, pos, window)]
                if (x + y) * games >= threshold
            ]
            if len(vals) < 5:
                continue
            xs = [v[0] for v in vals]
            ys = [v[1] for v in vals]
            tgt = [v[2] for v in vals]
            r = spearman(_pct_composite(xs, ys), tgt)
            if r is not None:
                rhos.append(r)
                counts.append(len(vals))
        rows.append((mult, mean(rhos) if rhos else None, mean(counts) if counts else 0))
    if verbose:
        print("\nGating floor experiment (window 5, min_games 1)")
        print("  floor x   pooled rho   avg pool size")
        for mult, rho, n in rows:
            rs = f"{rho:.3f}" if rho is not None else "n/a"
            print(f"  {mult:>5.1f}     {rs:>10}   {n:>12.1f}")
    return rows


def main() -> None:
    print("== MATCHUP: train", TRAIN_SEASONS)
    run_matchup(TRAIN_SEASONS)
    print("\n== MATCHUP: holdout", TEST_SEASONS)
    run_matchup(TEST_SEASONS)

    print("\n== GATING: train", TRAIN_SEASONS)
    run_gating(TRAIN_SEASONS)
    print("\n== GATING: holdout", TEST_SEASONS)
    run_gating(TEST_SEASONS)


if __name__ == "__main__":
    main()
