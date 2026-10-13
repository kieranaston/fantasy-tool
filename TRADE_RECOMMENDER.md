# Trade Recommender — Design Spec

In-season trade recommendations for a Sleeper league. Given a selected team,
surface trades that **improve that team** and are **plausible for the partner**.

The engine is positive-sum by design: fantasy trades can make both sides better
because talent is *misallocated* — a player benched on a deep roster still scores
for a team that would start him. The model hunts that gap. It does **not** require
filling a hole.

## 1. Data sources

**Sleeper API** (same pattern as `docs/js/draft-companion.js:217`):

| Endpoint | Use |
|---|---|
| `/state/nfl` | season + current week |
| `/league/{id}` | `roster_positions`, `scoring_settings`, `total_rosters`, `settings.playoff_teams`, `settings.playoff_week_start` |
| `/league/{id}/rosters` | `players`, `starters`, `settings.wins/losses/ties/fpts`, `owner_id` |
| `/league/{id}/users` | team / owner display names |

`roster_positions` (list of slot codes, e.g. `QB, RB, RB, WR, WR, TE, FLEX, K, DEF, BN…`)
is the authoritative starter shape — not the `slots_*` helpers. Handle `FLEX`
(RB/WR/TE) and `SUPER_FLEX` (QB/RB/WR/TE) if present.

**FantasyCalc trade values** (auto-pulled, `docs/data/trade/values.json`):
- `GET https://api.fantasycalc.com/values/current` — public, no key, updated hourly.
- Crowdsourced from real leagues; every row carries a **`sleeperId`**, so no
  name matching is needed.
- Fields used: `value`, `overallRank`, `positionRank`, `maybeTier`, `maybeTeam`.
- Format-aware via `isDynasty`, `numQbs`, `numTeams`, `ppr`, `tep` — derivable
  from the Sleeper league settings. (FantasyCalc currently only accepts
  `tep=none`.)
- **No K/DEF** — the model ignores them.
- Loader: `src/run_trade_values.py --league <id>` derives teams / 1QB-superflex /
  PPR from the Sleeper league and writes `docs/data/trade/values.json`. Refresh
  ≤ hourly.

## 2. Value

`V(player)` **is the FantasyCalc value directly** — a real, cross-position,
market-calibrated magnitude. The earlier rank-based curve (tier anchors +
geometric ladder) existed only because FantasyPros ECR gave ranks with no
magnitude; with a real value that machinery is unnecessary and would be
arbitrarily steep across 38 tiers.

- Cross-position comparability comes free: FantasyCalc values are global.
- No fuzzy matching, no `q`, no `tier` interpolation.

## 3. Positional VORP

Replacement comes from the league's `roster_positions`:

```
replacementRank(pos) = teams × starters(pos) + flexShare(pos)
V(player)            = FantasyCalc value
VORP(player)         = V(player) − V(player at replacementRank(pos))
```

`flexShare` splits each flex slot across its eligible positions with real
usage weights, not evenly: `FLEX` → RB 0.4 / WR 0.4 / TE 0.2 (and similar per
flex type).

## 4. Team strength — per position, lineup-relative

Value is **per team**, not one league-wide number per player.

- Compute each team's **optimal starting lineup** (starters + flex assignment),
  which is what makes concentration matter — you can only start so many.
- `value_to_team(T, p)` = p's **marginal contribution to T's optimal lineup**,
  plus the weighted depth term. The same RB can be ~0 to a stacked team
  (benched) and a real gain to another — that gap *is* the trade.
- **Starter strength(pos)** = VORP of that position's optimal starter.
- **Depth strength(pos)** = sum of above-replacement VORP for the position's
  non-starters, each weighted **`d^k`** for the k-th best (1, then `d`, `d²`, …),
  summed across positions. **Default `d = 0.6`.**
- Concave per body *and* rewards breadth: the same total spread across positions
  outscores depth stacked in one — the "all my depth is WR is bad" effect, with
  no separate balance term. League-wide scarcity is **not** here; it lives in
  matching (§5).
- **Team composite** = `w_lineup · lineupValue + w_depth · depthValue`, both on
  the same V scale.

## 5. Surplus / deficit vector (targeting)

- Reference = **league median**, position by position (robust to a single
  superteam yanking the mean).
- `surplus(pos)` / `deficit(pos)` = deviation from that median.
- This is a **targeting heuristic, not a filter** — it suggests who is likely to
  hold something you'd start, and what they'd want back.
- **Compatibility(A, B)** = anti-correlation of the two vectors (A surplus where
  B deficits, and vice versa).
- Accept the lopsidedness: median deviations don't sum to zero, so surplus may
  exceed deficit (concentrated positions). That's real — some surplus simply has
  no buyer.

## 6. Composite weights (fixed)

No pressure component. Every team's composite is `0.6·lineupVORP + 0.4·depthVORP`
— the depth share is a single constant (`DEPTH_WEIGHT_BASE = 0.4`), the same for
everyone.

## 7. Trade generation & acceptance

For the selected team ("you"), generate **value-bucketed, need-first bundles**:

- Candidate pieces per side = bench depth (VORP > 0) plus anyone at a position
  where that team runs a surplus. Bundles of 1..`MAX_BUNDLE` pieces per side.
- **Prune cheaply first**: pair only bundles whose raw values are within a factor
  (`valueWindow`), then enforce the parity floor (`sentRaw ≥ PARITY_MIN × receivedRaw`).
- Re-score survivors on optimal lineups.

**Acceptance bar:**
- **You gain** — Δ > 0 on your composite.
- **Partner gains a solid share but less than you** — `MIN_PARTNER_RATIO` ≤
  Δ_partner/Δ_you < `MAX_PARTNER_RATIO` (0.7 … 1.0). You gain more; they still
  do well.
- **No 2-piece imbalance** — `|sent − received| ≤ MAX_SIZE_DIFF` (1), so 3-for-1
  is blocked.

No hole required. Archetypes: consolidate, depth-for-starter, depth-for-depth.

Rank by your gain.

## 8. Architecture

Static site, client-side (matches the GitHub Pages setup):

```
src/run_trade_values.py     FantasyCalc → docs/data/trade/values.json
docs/js/trade-scoring.js    pure model (V, VORP, lineup, surplus, bundles)
docs/js/trade-companion.js  Sleeper fetch + UI
docs/tables/trade.html      page
docs/data/trade/values.json served values
```

Reuse: Sleeper client + league/roster fetch (`draft-companion.js`), league
settings parsing and `leagueStarterDemand` (`draft-scoring.js`).

## 9. Tunables & deferred

- `d = 0.6` (depth decay), `DEPTH_WEIGHT_BASE = 0.4`, `PARITY_MIN = 0.75`,
  `MAX_BUNDLE = 3`, `valueWindow = 1.5`, `MIN_PARTNER_RATIO = 0.7`,
  `MAX_PARTNER_RATIO = 1.0`, `MAX_SIZE_DIFF = 1` are defaults, not final.
- Acceptance is win-win with a partner-benefit gate; there is no partner-loss band.
- No K/DEF (FantasyCalc omits them; the model ignores them).
- Injury / bye weights (Sleeper player metadata) — v2.
- No scoring projections anywhere; value is FantasyCalc trade value only.

