# fantasy-tool

Personal fantasy football reference site (GitHub Pages in `/docs`).

**Streamers** — DEF / K / QB / RB / WR / TE charts. Inclusion is top of the chart by a weighted percentile composite of its axes (QB·TE·DEF·K 18, RB·WR 32). Weights and windows come from `src/analysis/chart_weight_backtest.py` + `chart_param_sweep.py` (next-week Spearman, 2021–24 train / 2025 holdout): QB/RB/WR/TE plot the last 5 weeks of expected points per game against points over expected (usage 90% / efficiency 10%, ≥1 game); DEF plots projected sack rate against the opponent implied total (opponent total 80% / sack rate 20%); K plots team implied total against team FG attempts per game (implied total 80% / FG rate 20%), both from the last 3 weeks. The top-N cut (not a volume floor) selects the board — testing showed a points floor shrank the pool and surfaced weaker players. A recency gate drops anyone who has not played in the last 2 weeks, so an injured player can't chart on a stale game inside the 5-week window.
**ADP / Draft** — Sleeper ADP board and live draft assistant (VORP↔ADP blend, optional FantasyPros ECR sort).  
**Keepers** — Sleeper league keeper rankings: FantasyCalc value − pick value at the cost round (most recent draft round, or R10 for waivers), with two-year eligibility.

```
docs/           published site + JSON
data/           pipeline state (not on Pages)
src/            Python loaders / builders
.github/        refresh workflows
```

## Local

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e .

python -m src.run_streamers
python -m src.run_adp              # manual; season ADP is frozen unless needed
python -m src.run_fp_rankings      # optional: FantasyPros CSV → docs/data/draft/
python -m src.run_trade_values     # FantasyCalc trade values → docs/data/trade/
python -m http.server 8000 --directory docs
```

Python 3.10+.

```bash
pip install -e ".[dev]" && ruff check src tests && pytest
```

## Pages deploy

Branch `main`, folder `/docs` → `https://<username>.github.io/fantasy-tool/`

| Workflow | Schedule |
|----------|----------|
| Refresh streamers | Daily 15:00 UTC |
| Refresh player values | Daily 14:00 UTC |
| Refresh ADP | manual only |
