# fantasy-tool

Personal fantasy football reference site with custom statistical rankings.

Data is pulled from [nflverse](https://github.com/nflverse) via [nflreadpy](https://github.com/nflverse/nflreadpy), processed into preseason composite rankings, and published as static JSON consumed by a GitHub Pages site in `/docs`.

## Strategy

Rankings are built from the **latest completed season** using position-specific metrics that tend to stick year to year. Raw stats are min-max normalized within each position pool, then weighted into a composite score.

RB, WR, and TE pages include a **Standard | Half-PPR | Full-PPR** selector (re-sorts by format weights). QB uses a single fixed formula.

## Project structure

```
docs/           GitHub Pages site (HTML, JS, CSS, generated JSON)
src/            Python pipeline (loaders, algorithms, export)
.github/        Monthly data refresh workflow
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

Data refreshes automatically on the first Tuesday of each month via GitHub Actions. Trigger manually from the Actions tab with **workflow_dispatch**.

## Adding a new view

1. Add an algorithm module under `src/algorithms/`
2. Export JSON to `docs/data/<your-path>.json` from `src/run.py`
3. Add an HTML page under `docs/charts/` or `docs/tables/`
4. Link it from `docs/index.html`
