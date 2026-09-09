# fantasy-tool

Personal fantasy football reference site (GitHub Pages in `/docs`).

**News** — RotoWire Bluesky posts matched to Sleeper players, with short Gemini blurbs.  
**Streamers** — DEF / K / QB / RB / WR matchup charts. Inclusion is top Sleeper half-PPR projections (QB 16, RB·WR 24, DEF·K 12); axes use nflverse stats + Vegas lines.  
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

python -m src.run_injuries
python -m src.run_streamers
python -m src.run_adp              # manual; season ADP is frozen unless needed
python -m src.run_fp_rankings      # optional: FantasyPros CSV → docs/data/draft/
python -m http.server 8000 --directory docs
```

Python 3.10+. Set `GEMINI_API_KEY` in `.env` (see `.env.example`).

```bash
pip install -e ".[dev]" && ruff check src tests && pytest
```

## Pages deploy

Branch `main`, folder `/docs` → `https://<username>.github.io/fantasy-tool/`

| Workflow | Schedule |
|----------|----------|
| Refresh injuries | daily |
| Refresh streamers | Tuesdays 15:00 UTC |
| Refresh ADP | manual only |

Repo secret: `GEMINI_API_KEY`.
