# fantasy-tool

Personal fantasy football reference site with custom statistical rankings and charts.

Data is pulled from [nflverse](https://github.com/nflverse) via [nflreadpy](https://github.com/nflverse/nflreadpy), processed with custom algorithms, and published as static JSON consumed by a GitHub Pages site in `/docs`.

## Scoring

All metrics use **half-PPR** scoring:

```
half_ppr = fantasy_points + 0.5 × receptions
```

where `fantasy_points` is the nflverse standard (non-PPR) total.

## Project structure

```
docs/           GitHub Pages site (HTML, JS, CSS, generated JSON)
src/            Python pipeline (loaders, algorithms, export)
.github/        Weekly data refresh workflow
```

## Local development

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .

python -m src.run           # writes docs/data/
python -m http.server 8000 --directory docs
```

Open http://localhost:8000 to preview the site.

Requires Python 3.10+.

## GitHub Pages

1. Push this repo to GitHub
2. Settings → Pages → Build from branch `main`, folder `/docs`
3. Site URL: `https://<username>.github.io/fantasy-tool/`

Data refreshes automatically every Tuesday at 11:00 UTC via GitHub Actions. Trigger manually from the Actions tab with **workflow_dispatch**.

## Adding a new view

1. Add an algorithm module under `src/algorithms/`
2. Export JSON to `docs/data/<your-path>.json` from `src/run.py`
3. Add an HTML page under `docs/charts/` or `docs/tables/`
4. Link it from `docs/index.html`
