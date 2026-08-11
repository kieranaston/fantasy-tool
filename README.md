# fantasy-tool

Personal fantasy football reference site with RotoWire player news and a live Sleeper draft assistant.

Data is pulled from [nflverse](https://github.com/nflverse) via [nflreadpy](https://github.com/nflverse/nflreadpy) and [Sleeper](https://docs.sleeper.com/), then published as static JSON for a GitHub Pages site in `/docs`. Player news is ingested from RotoWire’s Bluesky account (`rotowirenfl.bsky.social`) and grounded-summarized with Gemini.

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

python -m src.run                  # site manifest
python -m src.run_injuries         # state → data/injuries/; summaries → docs/
python -m src.run_adp              # daily Sleeper ADP → docs/data/draft/adp-*.json
python -m src.run_draft_data       # draft projections (+ custom FP board)
python -m http.server 8000 --directory docs
```

Open http://localhost:8000 to preview the site.

Requires Python 3.10+.

### Env vars

Create a `.env` in the repo root (gitignored):

```bash
GEMINI_API_KEY=...             # Bluesky triage + grounded summaries
GEMINI_MODEL=gemini-2.5-flash-lite   # optional override
SLEEPER_LEAGUE_ID=...          # your league → docs/data/draft/league.json
FANTASYPROS_API_KEY=...        # optional
```

### FantasyPros custom projections

Drop per-position CSVs under `data/fantasypros/projections/{season}/` (gitignored), e.g.:

```
data/fantasypros/projections/2026/FantasyPros_Fantasy_Football_Projections_QB.csv
..._RB.csv / ..._WR.csv / ..._TE.csv
```

`run_draft_data` loads `SLEEPER_LEAGUE_ID` scoring settings, scores each player's raw stats, matches names to Sleeper IDs, and writes `docs/data/draft/projections-custom.json`. The draft companion prefers that board when present. **ADP is refreshed daily** from Sleeper into `docs/data/draft/adp-*.json` and overlaid at load time (not tied to the FantasyPros CSV rebuild).

## GitHub Pages

1. Push this repo to GitHub
2. Settings → Pages → Build from branch `main`, folder `/docs`
3. Site URL: `https://<username>.github.io/fantasy-tool/`

Manifest refresh on the first Tuesday of each month. Player news refreshes daily via **Refresh injuries**. Sleeper ADP refreshes daily via **Refresh ADP** (independent of FantasyPros projection rebuilds). Trigger either workflow manually from the Actions tab.

Repository secrets:

- `GEMINI_API_KEY` — grounded summaries

Missing Gemini summaries from quota limits are retried automatically on the next daily run.

## Adding a new view

1. Export JSON under `docs/data/` (from `src/run*.py` or a new module)
2. Add an HTML page under `docs/tables/`
3. Add a link in the top nav on each page
