# fantasy-tool

Personal fantasy football reference site with custom statistical rankings, personal draft boards, and a player-news summarizer.

Data is pulled from [nflverse](https://github.com/nflverse) via [nflreadpy](https://github.com/nflverse/nflreadpy), processed into preseason composite rankings, and published as static JSON consumed by a GitHub Pages site in `/docs`. Player news is ingested from Bluesky (`news.optimusfantasy.com`) and grounded-summarized with Gemini when status changes. FantasyPros expert consensus rankings (ECR) power the “vs ECR” column on personal draft pages.

## Strategy

Rankings are built from the **latest completed season** using position-specific metrics that tend to stick year to year. Raw stats are min-max normalized within each position pool, then weighted into a composite score.

RB, WR, and TE composite pages include a **Standard | Half-PPR | Full-PPR** selector. Personal draft pages use **Half-PPR | PPR** with drag-and-drop reordering.

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

python -m src.run            # writes docs/data/{qb,rb,wr,te}/rankings.json
python -m src.run_injuries   # writes docs/data/injuries/
python -m src.run_consensus  # FantasyPros ECR + seeds draft-rankings.json if missing
python -m http.server 8000 --directory docs
```

Open http://localhost:8000 to preview the site.

Requires Python 3.10+.

### Env vars

Create a `.env` in the repo root (gitignored):

```bash
GEMINI_API_KEY=...             # Bluesky triage + grounded summaries
GEMINI_MODEL=gemini-2.5-flash-lite   # optional override
FANTASYPROS_API_KEY=...        # consensus ECR for draft pages (public API; free tier returns a limited top list)
```

### Personal draft rankings

- Pages: **My QB / RB / WR / TE Draft**
- Pool: same top-40 composite players per position
- Drag rows to reorder — order is saved in this browser (`localStorage`) and survives reloads
- Half-PPR and PPR keep independent orders
- **Download spreadsheet** exports the current format as CSV (opens in Excel/Sheets)
- Does not sync across devices/browsers (GitHub Pages cannot write the repo from the page)

## GitHub Pages

1. Push this repo to GitHub
2. Settings → Pages → Build from branch `main`, folder `/docs`
3. Site URL: `https://<username>.github.io/fantasy-tool/`

Rankings refresh automatically on the first Tuesday of each month. Player news + FantasyPros ECR refresh daily via **Refresh injuries**. Trigger either workflow manually from the Actions tab.

Repository secrets:

- `GEMINI_API_KEY` — grounded summaries
- `FANTASYPROS_API_KEY` — consensus rankings (optional; skipped if unset)

Missing Gemini summaries from quota limits are retried automatically on the next daily run.

## Adding a new view

1. Add an algorithm module under `src/algorithms/`
2. Export JSON to `docs/data/<your-path>.json` from `src/run.py`
3. Add an HTML page under `docs/charts/` or `docs/tables/`
4. Link it from `docs/index.html`
