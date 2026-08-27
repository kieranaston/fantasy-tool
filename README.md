# fantasy-tool

Personal fantasy football reference site with RotoWire player news and a live Sleeper draft assistant.

Data is pulled from [nflverse](https://github.com/nflverse) via [nflreadpy](https://github.com/nflverse/nflreadpy) and [Sleeper](https://docs.sleeper.com/), then published as static JSON for a GitHub Pages site in `/docs`. Player news is ingested from RotoWire’s Bluesky account (`rotowirenfl.bsky.social`) and grounded-summarized with Gemini.

Draft recommendations are **ADP-based**: lower ADP wins, adjusted for your positional need and the risk a player is taken before your next pick.

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
python -m src.run_adp              # daily Sleeper ADP → docs/data/draft/adp-*.json
python -m http.server 8000 --directory docs
```

Open http://localhost:8000 to preview the site.

Requires Python 3.10+.

### Env vars

Create a `.env` in the repo root (gitignored):

```bash
GEMINI_API_KEY=...             # Bluesky triage + grounded summaries
GEMINI_MODEL=gemini-2.5-flash-lite   # optional override
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

Player news refreshes daily via **Refresh injuries**. Sleeper ADP refreshes daily via **Refresh ADP**. Trigger either workflow manually from the Actions tab.

Repository secrets:

- `GEMINI_API_KEY` — grounded summaries

Missing Gemini summaries from quota limits are retried automatically on the next daily run.

## Adding a new view

1. Export JSON under `docs/data/` (from `src/run*.py` or a new module)
2. Add an HTML page under `docs/tables/`
3. Add a link in the top nav on each page
