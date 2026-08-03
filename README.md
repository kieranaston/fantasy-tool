# fantasy-tool

Personal fantasy football reference site with editable rankings vs Sleeper ADP and RotoWire player news on the home page.

Data is pulled from [nflverse](https://github.com/nflverse) via [nflreadpy](https://github.com/nflverse/nflreadpy) and [Sleeper](https://docs.sleeper.com/) ADP, then published as static JSON for a GitHub Pages site in `/docs`. Player news is ingested from RotoWire’s Bluesky account (`rotowirenfl.bsky.social`) and grounded-summarized with Gemini.

## Rankings vs ADP

Boards are seeded from **Sleeper ADP** (includes rookies). Drag to set your ranks and insert tier breaks. Value is computed per player:

| Board | Value |
| --- | --- |
| Overall | `ADP − myOverallRank` (positive = market later than you → value) |
| QB / RB / WR / TE | `posAdpRank − myPosRank` (positional ADP rank vs your rank) |

Half-PPR and PPR keep independent orders/tiers in this browser (`localStorage`).

## Project structure

```
docs/           GitHub Pages site (HTML, JS, CSS, generated JSON)
src/            Python pipeline (loaders, injuries, export)
.github/        Data refresh workflows
```

## Local development

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .

python -m src.run                  # site manifest
python -m src.run_injuries         # writes docs/data/injuries/
python -m src.run_adp              # Sleeper ADP + seeds my-rankings.json if missing
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

### Personal rankings

- Pages: **Overall / QB / RB / WR / TE Rankings**
- Pool: Sleeper ADP depth (QB/TE top 25; RB/WR top 45; Overall = those players only)
- Drag rows to reorder
- **×** on a row crosses out a player you won't consider (shared across Overall and position boards; syncs when signed in)
- **+** on a row toggles a tier break below it; drag across tier lines to move players between tiers
- **Reset to ADP** restores ADP order and clears tiers for both formats
- **Download spreadsheet** exports the current format as CSV
- Without sync configured, order is saved in this browser only

### Multi-device sync (Supabase)

Site stays on GitHub Pages (no server for you to run). Rankings sync through a free Supabase project.

1. Create a project at [supabase.com](https://supabase.com)
2. SQL Editor → run [`supabase/schema.sql`](supabase/schema.sql) (re-run after updates to pick up new columns)
3. Authentication → Providers → enable **Email**
4. Authentication → URL Configuration → add your site URL to **Redirect URLs**  
   (local: `http://localhost:8000/*`, Pages: `https://<user>.github.io/fantasy-tool/*`)
5. Project Settings → API → copy **Project URL** and **anon public** key into [`docs/js/sync-config.js`](docs/js/sync-config.js)
6. On any rankings page, enter your email → **Sign in to sync** → open the magic link
7. Reorder on one device; other signed-in devices load the newer board

The anon key is safe to commit when RLS from `schema.sql` is enabled.

## GitHub Pages

1. Push this repo to GitHub
2. Settings → Pages → Build from branch `main`, folder `/docs`
3. Site URL: `https://<username>.github.io/fantasy-tool/`

Manifest refresh on the first Tuesday of each month. Player news + Sleeper ADP refresh daily via **Refresh injuries**. Trigger either workflow manually from the Actions tab.

Repository secrets:

- `GEMINI_API_KEY` — grounded summaries

Missing Gemini summaries from quota limits are retried automatically on the next daily run.

## Adding a new view

1. Export JSON under `docs/data/` (from `src/run*.py` or a new module)
2. Add an HTML page under `docs/tables/`
3. Add a link in the top nav on each page
