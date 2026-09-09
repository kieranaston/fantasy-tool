# fantasy-tool

Personal fantasy football reference site with RotoWire player news and a live Sleeper draft assistant.

Data is pulled from [Sleeper](https://docs.sleeper.com/) and published as static JSON for a GitHub Pages site in `/docs`. Player news is ingested from RotoWire’s Bluesky account (`rotowirenfl.bsky.social`), matched to the ADP depth pool by first/last/full name, and given a short Gemini one-liner blurb (sources stay expandable underneath).

Draft recommendations blend **VORP and ADP** by default (per position, shifting toward ADP as a position thins out), with a need multiplier for backup QB/TE. Use the draft board **Sort** control for VORP, ADP, or FantasyPros ECR rankings. Risk % (when you're on the clock) uses plain ADP for opponent picks.

## Project structure

```
docs/           GitHub Pages site (HTML, JS, CSS, public JSON)
data/injuries/  Pipeline state (not published to Pages)
src/            Python pipeline (loaders, injuries, export)
.github/        Data refresh workflows
```

## Local development

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .

python -m src.run_injuries         # state → data/injuries/; summaries → docs/
python -m src.run_adp              # Sleeper ADP → docs/data/draft/adp-board.json (manual)
python -m src.run_streamers        # weekly DEF/K/QB/RB/WR → docs/data/streamers/
python -m src.run_fp_rankings      # FantasyPros CSV → docs/data/draft/fp-rankings.json
python -m http.server 8000 --directory docs
```

Open http://localhost:8000 to preview the site.

Requires Python 3.10+.

Draft recommendations default to a **VORP↔ADP blend**, with a need multiplier for backup QB/TE. On the draft board, use **Sort** to order remaining players by **VORP**, **ADP**, or FantasyPros **Rankings** (ECR). Drop an ALL rankings CSV in `data/fantasypros/rankings/` and run `python -m src.run_fp_rankings` to refresh.

**DEF**, **Kickers**, **QBs**, **RBs**, and **WRs** streamer pages use nflverse stats + Vegas/schedule lines. Rolling windows use prior+current data — as soon as the current season’s files appear (even week 1), those games enter the window and older prior-season games roll off.

### Env vars

Create a `.env` in the repo root (gitignored):

```bash
GEMINI_API_KEY=...             # one-liner blurbs on player news cards
GEMINI_MODEL=gemini-2.5-flash-lite   # optional override
# MAX_NARRATIVE_PLAYERS=24     # optional per-run Gemini cap
```

See `.env.example` for all supported variables.

### Tests

```bash
pip install -e ".[dev]"
ruff check src tests
pytest
```

CI runs the same checks on push via **Test** workflow.

## GitHub Pages

1. Push this repo to GitHub
2. Settings → Pages → Build from branch `main`, folder `/docs`
3. Site URL: `https://<username>.github.io/fantasy-tool/`

Player news refreshes daily via **Refresh injuries**. Streamer boards (DEF, kickers, QBs, RBs, WRs) refresh weekly via **Refresh streamers** (Tuesdays). ADP refresh is manual only (`workflow_dispatch`) now that the season has started.

Published news keeps players whose **newest** update is within the news window (default 28 days) and who still have a real team (drops FA/empty). Older source rows for those players are kept up to a per-player timeline cap.

Repository secrets:

- `GEMINI_API_KEY` — card one-liner blurbs (missing/quota fills retry on the next daily run)

## Adding a new view

1. Export JSON under `docs/data/` (from `src/run*.py` or a new module)
2. Add an HTML page under `docs/tables/`
3. Add a link in the top nav on each page
