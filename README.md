# fantasy-tool

Personal fantasy football reference site with custom statistical rankings and an injury status summarizer.

Data is pulled from [nflverse](https://github.com/nflverse) via [nflreadpy](https://github.com/nflverse/nflreadpy), processed into preseason composite rankings, and published as static JSON consumed by a GitHub Pages site in `/docs`. Player news is ingested from Bluesky (`news.optimusfantasy.com`) and grounded-summarized with Gemini when status changes.

## Strategy

Rankings are built from the **latest completed season** using position-specific metrics that tend to stick year to year. Raw stats are min-max normalized within each position pool, then weighted into a composite score.

RB, WR, and TE pages include a **Standard | Half-PPR | Full-PPR** selector (re-sorts by format weights). QB uses a single fixed formula.

## Project structure

```
docs/           GitHub Pages site (HTML, JS, CSS, generated JSON)
src/            Python pipeline (loaders, algorithms, injuries, export)
.github/        Data refresh workflows
```

## Local development

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .

python -m src.run           # writes docs/data/{qb,rb,wr,te}/
python -m src.run_injuries  # writes docs/data/injuries/
python -m http.server 8000 --directory docs
```

Open http://localhost:8000 to preview the site.

Requires Python 3.10+.

### Injury pipeline env vars

Create a `.env` in the repo root (gitignored):

```bash
GEMINI_API_KEY=...        # optional; without it, Bluesky posts are stored for later triage and summaries are skipped
GEMINI_MODEL=gemini-2.5-flash-lite   # optional override
```

## GitHub Pages

1. Push this repo to GitHub
2. Settings → Pages → Build from branch `main`, folder `/docs`
3. Site URL: `https://<username>.github.io/fantasy-tool/`

Rankings refresh automatically on the first Tuesday of each month. Player news refreshes daily via **Refresh injuries**. Trigger either workflow manually from the Actions tab.

For player news, add repository secret `GEMINI_API_KEY` (for grounded summaries). Missing summaries from quota limits are retried automatically on the next daily run.

## Adding a new view

1. Add an algorithm module under `src/algorithms/`
2. Export JSON to `docs/data/<your-path>.json` from `src/run.py`
3. Add an HTML page under `docs/charts/` or `docs/tables/`
4. Link it from `docs/index.html`
