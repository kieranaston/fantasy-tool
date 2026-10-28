"""Backtest the streamer charts' axis composites against next-week points.

For each season, slate week ``W``, and board, the chart's two axes are computed
exactly as the live chart does, then rank-correlated (Spearman) with the score
the position actually produced in week ``W``:

* **skill** (QB/RB/WR/TE) — xFP/G and FPOE/G over the prior ``WINDOW`` weeks,
  target = the player's half-PPR points in week ``W``.
* **k** — the slate's team implied total and the team's FG attempts per game
  over the prior ``WINDOW`` weeks, target = the kicker's points in week ``W``
  (standard FG-distance scoring, see ``KICKER_SCORE``).
* **def** — the projected sack rate and the opponent implied total for the
  slate, target = a standard DST score in week ``W`` built from play-by-play
  (see ``dst_points_by_week_team``; the DST score is a documented proxy).

The x-axis weight that maximises the mean Spearman across positions is the one
the chart's ``*_WEIGHT`` constants should encode.

Run::

    python -m src.analysis.chart_weight_backtest            # skill (default)
    python -m src.analysis.chart_weight_backtest --target k
    python -m src.analysis.chart_weight_backtest --target def
"""

from __future__ import annotations

import argparse
from statistics import mean

import polars as pl

from src.def_streamers.projection_pool import composite_scores
from src.loaders.nflverse import (
    fetch_ff_opportunity,
    fetch_pbp_parquet,
    fetch_player_week_stats,
    fetch_schedules,
    implied_team_totals,
    summarize_season_xfp,
    team_fg_attempts_per_game,
    team_sack_rates,
)

POSITIONS = ["QB", "RB", "WR", "TE"]
WINDOW = 3
MIN_GAMES = 2
MIN_WEEK = 4
MAX_WEEK = 18
WEIGHT_STEP = 0.1

# Standard FG-distance kicker scoring (Sleeper default style): 3 pts inside 40,
# 4 from 40-49, 5 from 50+, 1 per PAT.
KICKER_BASE_XP = 3.0
KICKER_XP_40_49 = 4.0
KICKER_XP_50_PLUS = 5.0


def spearman(xs: list[float], ys: list[float]) -> float | None:
    """Spearman rank correlation, no scipy. None when a sample is too small."""
    n = len(xs)
    if n < 5:
        return None
    rx = _ranks(xs)
    ry = _ranks(ys)
    mx = mean(rx)
    my = mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def _ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(values):
        j = i
        while j + 1 < len(values) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def _weight_grid() -> list[float]:
    steps = round(1 / WEIGHT_STEP)
    return [round(i * WEIGHT_STEP, 2) for i in range(steps + 1)]


# --------------------------------------------------------------------------- #
# Targets
# --------------------------------------------------------------------------- #

DST_POINTS_ALLOWED = [(0, 10.0), (6, 7.0), (13, 4.0), (20, 1.0), (27, 0.0), (34, -1.0)]


def _points_allowed_score(points_allowed: float) -> float:
    if points_allowed <= 0:
        return 10.0
    for ceiling, value in DST_POINTS_ALLOWED:
        if points_allowed <= ceiling:
            return value
    return -4.0


def dst_points_by_week_team(season: int, games: list[dict]) -> dict[tuple[int, str], float]:
    """Standard DST fantasy score per (week, team), built from play-by-play.

    Components: sack 1, interception 2, fumble recovery 2, safety 2, defensive/
    return TD 6, plus the points-allowed bracket above. A documented proxy — the
    pipeline has no published team-DST scoring series.
    """
    pbp = pl.read_parquet(fetch_pbp_parquet(season)).filter(
        pl.col("season_type") == "REG"
    )
    agg = pbp.group_by(["week", "game_id", "defteam"]).agg(
        pl.col("sack").cast(pl.Int64).sum().alias("sacks"),
        pl.col("interception").cast(pl.Int64).sum().alias("ints"),
        (pl.col("fumble_recovery_1_team") == pl.col("defteam"))
        .cast(pl.Int64)
        .sum()
        .alias("fum"),
        pl.col("safety").cast(pl.Int64).sum().alias("safety"),
        (pl.col("td_team") == pl.col("defteam")).cast(pl.Int64).sum().alias("tds"),
    )

    allowed: dict[tuple[str, str], float] = {}
    for g in games:
        if g.get("season") != season or g.get("game_type") != "REG":
            continue
        if g.get("away_score") is None or g.get("home_score") is None:
            continue
        gid = str(g["game_id"])
        allowed[(gid, str(g["away_team"]))] = float(g["home_score"])
        allowed[(gid, str(g["home_team"]))] = float(g["away_score"])

    out: dict[tuple[int, str], float] = {}
    for row in agg.iter_rows(named=True):
        team = str(row["defteam"] or "")
        if not team:
            continue
        pa = allowed.get((str(row["game_id"]), team))
        if pa is None:
            continue
        score = (
            float(row["sacks"])
            + 2.0 * float(row["ints"])
            + 2.0 * float(row["fum"])
            + 2.0 * float(row["safety"])
            + 6.0 * float(row["tds"])
            + _points_allowed_score(pa)
        )
        out[(int(row["week"]), team)] = score
    return out


def kicker_points_by_week_team(season: int) -> dict[tuple[int, str], float]:
    """Standard kicker points per (week, team); starter = most attempts."""
    df = pl.read_parquet(fetch_player_week_stats(season)).filter(
        (pl.col("season_type") == "REG") & (pl.col("position") == "K")
    )
    if df.is_empty():
        return {}
    cols = [
        "fg_made_0_19",
        "fg_made_20_29",
        "fg_made_30_39",
        "fg_made_40_49",
        "fg_made_50_59",
        "fg_made_60_",
        "fg_att",
        "pat_made",
        "pat_att",
    ]
    df = df.with_columns(
        [pl.col(c).cast(pl.Float64, strict=False).fill_null(0.0) for c in cols]
    ).with_columns(
        (
            KICKER_BASE_XP
            * (pl.col("fg_made_0_19") + pl.col("fg_made_20_29") + pl.col("fg_made_30_39"))
            + KICKER_XP_40_49 * pl.col("fg_made_40_49")
            + KICKER_XP_50_PLUS * (pl.col("fg_made_50_59") + pl.col("fg_made_60_"))
            + pl.col("pat_made")
        ).alias("pts"),
        (pl.col("fg_att") + pl.col("pat_att")).alias("_att"),
    )
    df = df.sort("_att", descending=True).group_by(["week", "team"]).first()
    out: dict[tuple[int, str], float] = {}
    for row in df.iter_rows(named=True):
        team = str(row.get("team") or "")
        week = row.get("week")
        if team and week is not None:
            out[(int(week), team)] = float(row["pts"])
    return out


# --------------------------------------------------------------------------- #
# Sample builders (one list of (x, y, target) per week)
# --------------------------------------------------------------------------- #

def _implied_by_week(games: list[dict], season: int) -> dict[int, dict[str, float]]:
    out: dict[int, dict[str, float]] = {}
    for g in games:
        if (
            g.get("season") != season
            or g.get("game_type") != "REG"
            or g.get("total_line") is None
            or g.get("spread_line") is None
            or g.get("week") is None
        ):
            continue
        away_imp, home_imp = implied_team_totals(
            float(g["spread_line"]), float(g["total_line"])
        )
        week = int(g["week"])
        bucket = out.setdefault(week, {})
        bucket[str(g["away_team"])] = away_imp
        bucket[str(g["home_team"])] = home_imp
    return out


def skill_samples(df: pl.DataFrame, position: str, season: int, week: int):
    window = summarize_season_xfp(
        df, position, season=season, as_of_week=week, window=WINDOW
    )
    period = summarize_season_xfp(
        df, position, season=season, as_of_week=week + 1, window=1
    )
    target = {row["player_id"]: row["fantasy_points"] for row in period}
    rows = []
    for row in window:
        if row["games"] < MIN_GAMES:
            continue
        actual = target.get(row["player_id"])
        if actual is None:
            continue
        rows.append((row["xfpts"], row["fpoe"], actual))
    return rows


def k_samples(season: int, week: int, implied, kicker_pts, fg_rates) -> list:
    week_implied = implied.get(week, {})
    rows = []
    for team, implied_total in week_implied.items():
        pts = kicker_pts.get((week, team))
        rates = fg_rates.get(team)
        if pts is None or not rates:
            continue
        rows.append(
            (float(implied_total), float(rates["fg_attempts_per_game"]), float(pts))
        )
    return rows


def def_samples(
    season: int, week: int, implied, dst_pts, sack_rates, games: list[dict]
) -> list:
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
        away = str(g["away_team"])
        home = str(g["home_team"])
        away_imp, home_imp = implied_team_totals(
            float(g["spread_line"]), float(g["total_line"])
        )
        for team, opp, opp_imp in (
            (home, away, away_imp),
            (away, home, home_imp),
        ):
            pts = dst_pts.get((week, team))
            team_rates = sack_rates.get(team)
            opp_rates = sack_rates.get(opp)
            if pts is None or not team_rates or not opp_rates:
                continue
            proj = 0.67 * float(opp_rates["offense_sack_rate"]) + 0.33 * float(
                team_rates["defense_sack_rate"]
            )
            rows.append((proj, float(opp_imp), float(pts)))
    return rows


# --------------------------------------------------------------------------- #
# Sweep
# --------------------------------------------------------------------------- #

def _sweep(samples_by_week: dict[int, list], x_sign: float, weights: list[float]):
    base_x: list[float] = []
    base_y: list[float] = []
    acc: dict[float, list[float]] = {w: [] for w in weights}
    for rows in samples_by_week.values():
        if len(rows) < 5:
            continue
        xs = [r[0] for r in rows]
        ys = [r[1] for r in rows]
        target = [r[2] for r in rows]
        rx = spearman(xs, target)
        ry = spearman(ys, target)
        if rx is None or ry is None:
            continue
        base_x.append(rx)
        base_y.append(ry)
        for w in weights:
            scores = composite_scores(xs, ys, x_sign=x_sign, x_weight=w, y_weight=1 - w)
            r = spearman(scores, target)
            if r is not None:
                acc[w].append(r)
    return base_x, base_y, acc


def run_skill(seasons: list[int], weights: list[float], verbose: bool = True) -> dict:
    base_x: dict[str, list] = {p: [] for p in POSITIONS}
    base_y: dict[str, list] = {p: [] for p in POSITIONS}
    acc: dict[float, dict[str, list]] = {w: {p: [] for p in POSITIONS} for w in weights}
    for season in seasons:
        df = pl.read_parquet(fetch_ff_opportunity(season))
        for week in range(MIN_WEEK, MAX_WEEK + 1):
            for position in POSITIONS:
                rows = skill_samples(df, position, season, week)
                if len(rows) < 5:
                    continue
                xs = [r[0] for r in rows]
                ys = [r[1] for r in rows]
                target = [r[2] for r in rows]
                rx = spearman(xs, target)
                ry = spearman(ys, target)
                if rx is None or ry is None:
                    continue
                base_x[position].append(rx)
                base_y[position].append(ry)
                for w in weights:
                    scores = composite_scores(xs, ys, x_weight=w, y_weight=1 - w)
                    r = spearman(scores, target)
                    if r is not None:
                        acc[w][position].append(r)

    def avg(v):
        return mean(v) if v else None

    result: dict = {
        "x_label": "xFP/G (usage)",
        "y_label": "FPOE/G (efficiency)",
        "baseline_x": {p: avg(base_x[p]) for p in POSITIONS},
        "baseline_y": {p: avg(base_y[p]) for p in POSITIONS},
        "groups": POSITIONS,
    }
    grid = {}
    for w in weights:
        per = {p: avg(acc[w][p]) for p in POSITIONS}
        pooled = [v for v in per.values() if v is not None]
        per["pooled"] = mean(pooled) if pooled else None
        grid[w] = per
    result["grid"] = grid
    if verbose:
        _print_report(result, weights)
    return result


def _run_team_board(
    target: str, seasons: list[int], weights: list[float], verbose: bool = True
) -> dict:
    acc = {w: [] for w in weights}
    base_x: list[float] = []
    base_y: list[float] = []
    for season in seasons:
        games = fetch_schedules(seasons=[season])
        implied = _implied_by_week(games, season)
        # x-axis is "higher is better" on both team boards; the DEF y-axis is the
        # opponent implied total, where lower is better.
        x_sign = 1.0
        y_sign = -1.0 if target == "def" else 1.0
        if target == "def":
            dst_pts = dst_points_by_week_team(season, games)
        else:
            dst_pts = kicker_points_by_week_team(season)
        for week in range(MIN_WEEK, MAX_WEEK + 1):
            if target == "def":
                try:
                    sack_rates = team_sack_rates(
                        [season], as_of_season=season, as_of_week=week
                    )
                except (ValueError, FileNotFoundError):
                    continue
                rows = def_samples(season, week, implied, dst_pts, sack_rates, games)
            else:
                try:
                    fg_rates = team_fg_attempts_per_game(
                        [season], as_of_season=season, as_of_week=week
                    )
                except (ValueError, FileNotFoundError):
                    continue
                rows = k_samples(season, week, implied, dst_pts, fg_rates)
            if len(rows) < 5:
                continue
            xs = [r[0] for r in rows]
            ys = [r[1] for r in rows]
            target_v = [r[2] for r in rows]
            rx = spearman(xs, target_v)
            ry = spearman(ys, target_v)
            if rx is None or ry is None:
                continue
            base_x.append(rx)
            base_y.append(ry)
            for w in weights:
                scores = composite_scores(
                    xs, ys, x_sign=x_sign, y_sign=y_sign, x_weight=w, y_weight=1 - w
                )
                r = spearman(scores, target_v)
                if r is not None:
                    acc[w].append(r)

    def avg(v):
        return mean(v) if v else None

    result: dict = {
        "x_label": (
            "projected sack rate" if target == "def" else "team implied total"
        ),
        "y_label": (
            "opponent implied total" if target == "def" else "FG attempts/G"
        ),
        "baseline_x": avg(base_x),
        "baseline_y": avg(base_y),
        "groups": [target.upper()],
    }
    grid = {}
    for w in weights:
        grid[w] = {"pooled": avg(acc[w])}
    result["grid"] = grid
    if verbose:
        _print_report(result, weights)
    return result


def _print_report(result, weights) -> None:
    groups = result["groups"]
    print(f"Spearman(next-week points) — {result['x_label']} vs {result['y_label']}")
    if isinstance(result["baseline_x"], dict):
        print(f"{'pos':>4} {'x-axis':>8} {'y-axis':>8}")
        for p in groups:
            x = result["baseline_x"][p]
            y = result["baseline_y"][p]
            xs = f"{x:.3f}" if x is not None else "  n/a"
            ys = f"{y:.3f}" if y is not None else "  n/a"
            print(f"{p:>4} {xs:>8} {ys:>8}")
    else:
        x = result["baseline_x"]
        y = result["baseline_y"]
        print(f"  x-axis {x:.3f}   y-axis {y:.3f}" if x is not None else "  n/a")

    print(f"\nComposite by x-axis weight ({result['x_label']} share)")
    header = "  wx  " + "".join(f"{p:>8}" for p in groups) + f"{'pooled':>8}"
    print(header)
    for w in weights:
        row = result["grid"][w]
        cells = "".join(
            f"{row[p]:>8.3f}" if row.get(p) is not None else f"{'n/a':>8}"
            for p in groups
        )
        pooled = (
            f"{row['pooled']:>8.3f}" if row.get("pooled") is not None else f"{'n/a':>8}"
        )
        print(f"{w:>4.1f}  {cells}{pooled}")

    valid = [w for w in weights if result["grid"][w].get("pooled") is not None]
    if not valid:
        print("\nNo usable samples.")
        return
    best = max(valid, key=lambda w: result["grid"][w]["pooled"])
    print(
        f"\nBest pooled x-axis weight: {best:.1f} "
        f"(pooled rho {result['grid'][best]['pooled']:.3f})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        choices=["skill", "k", "def"],
        default="skill",
        help="Which board to backtest (default: skill)",
    )
    parser.add_argument(
        "--seasons",
        type=int,
        nargs="+",
        default=[2024, 2025],
        help="Seasons to backtest (default: 2024 2025)",
    )
    args = parser.parse_args()
    weights = _weight_grid()
    if args.target == "skill":
        run_skill(args.seasons, weights)
    else:
        _run_team_board(args.target, args.seasons, weights)


if __name__ == "__main__":
    main()
