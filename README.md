# fantasy-tool

Personal fantasy football reference site (GitHub Pages in `/docs`).

**Streamers** — DEF / K / QB / RB / WR / TE charts. Inclusion is top of the chart by a composite of its axes (QB·TE·DEF·K 18, RB·WR 30). QB/RB/WR/TE plot the last 4 games of expected points per game against points over expected. DEF and K keep sack rate and FG attempts against Vegas lines, also from this season only.  
**ADP / Draft** — Sleeper ADP board and live draft assistant (VORP↔ADP blend, optional FantasyPros ECR sort).

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
| Refresh ADP | manual only |
