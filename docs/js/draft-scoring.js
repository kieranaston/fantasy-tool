/**
 * Draft assistant — one loop, repeated every pick:
 *
 *  1. Baseline: empty starter slots leaguewide → replacement = pts of the
 *     player who would fill the last one.
 *  2. VORP = pts − baseline[pos] (can be negative below replacement).
 *  3. Predict picks before you with −ADP + NEED_K × need[pos] (hard path).
 *  4. Risk to your next pick: soft opponent choices (softmax over the same
 *     score) → survival product → risk = 1 − survival.
 *  5. Blend VORP ↔ ADP from remaining above-replacement surplus. Both terms
 *     are min-max normalized against the scored remaining pool, then scaled
 *     back to the pool's VORP span so NEED_K / RISK_K stay in "points":
 *       surplus = Σ max(0, vorp) on the board you'll see
 *       T = SURPLUS_FULL × (teams/12) × (skill starters/7)
 *       w = min(VORP_WEIGHT_CAP, surplus / T)   // ADP-led shortlist; VORP capped
 *       vorpN, adpN ∈ [0,1]  (adpN inverted: lower ADP → higher;
 *         missing ADP excluded from the extent, then scored as adpN = 0;
 *         empty known-ADP sample → skip ADP norm, adpN = 0 for everyone;
 *         flat known-ADP sample (max ≈ min) → adpN = 1 for known, 0 missing)
 *       if VORP_span ≈ 0: skip blend → score = NEED_K·need + RISK_K·risk
 *       else score = (w·vorpN + (1−w)·adpN)·VORP_span + NEED_K·need + RISK_K·risk
 *     Early: still mostly ADP (w ≤ VORP_WEIGHT_CAP) so consensus guys aren't
 *     buried by projection noise; light VORP keeps true outliers visible.
 *     Late (surplus → 0): full ADP. Starter need can go negative when you
 *     overstock. Flex +1 applies to WR/RB only. Remaining roster picks add
 *     depth need to WR/RB only (not TE). Rank by score, then ADP.
 *
 * Need counts: starter holes per position. While flex is open, WR and RB each
 * get +1; filling flex clears that unit from both. TE never gets flex or
 * depth need — a 2nd TE goes negative.
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
const NEED_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/**
 * How much VORP you'll trade for one unit of positional need. Large enough
 * that a real hole usually beats a modest VORP edge elsewhere.
 */
const NEED_K = 12;

/** Soft nudge from P(gone before your next pick); keeps need as the main lever. */
const RISK_K = 3;

/**
 * Remaining above-replacement VORP at which the blend hits VORP_WEIGHT_CAP,
 * anchored to a 12-team / 7 skill-starter league. Scaled per draft via
 * surplusFullThreshold(). Below the threshold, weight falls linearly toward
 * full ADP as surplus → 0.
 */
const SURPLUS_FULL = 400;

/**
 * Cap on VORP's share of the value blend. Shortlists should stay ADP-led so
 * consensus guys aren't buried by projection quirks; VORP still nudges true
 * outliers and pairs with need for positional scarcity.
 */
const VORP_WEIGHT_CAP = 0.25;

/** Softmax over the top N opponent candidates each pick. */
const RISK_SOFTMAX_TOP = 12;

/** Temperature for opponent pick softmax (ADP-scale scores). */
const RISK_SOFTMAX_TEMP = 10;

/**
 * Cap opponent sim/risk work to this many most-draftable players (by ADP).
 * Full boards are 400+; scanning them every simulated pick freezes the UI.
 */
const SIM_POOL_SIZE = 100;

/** Cap fully scored recommendation candidates after sim (UI + search). */
const SCORE_POOL_SIZE = 80;

const ADP_MISSING = 9999;

/** Below this VORP range, treat the pool as flat and skip the VORP/ADP blend. */
const VORP_SPAN_EPS = 0.5;

/** Below this ADP pick spread, treat known ADP as flat (skip min-max). */
const ADP_SPAN_EPS = 1e-6;

/**
 * ADP is noisy, so include a few picks past your next turn so borderline
 * players still accumulate risk.
 */
const RISK_LOOKAHEAD_PICKS = 3;

function starterSlotsFromSettings(settings = {}) {
  return {
    QB: Number(settings.slots_qb ?? 1),
    RB: Number(settings.slots_rb ?? 2),
    WR: Number(settings.slots_wr ?? 2),
    TE: Number(settings.slots_te ?? 1),
    FLEX: Number(settings.slots_flex ?? 1),
    DEF: Number(settings.slots_def ?? 0),
    K: Number(settings.slots_k ?? 0),
  };
}

/** Projection board keys we ship under docs/data/draft/. */
const SCORING_FORMATS = ["half_ppr", "full_ppr", "std"];

const FORMAT_LABELS = {
  half_ppr: "Half PPR",
  full_ppr: "Full PPR",
  std: "Standard",
};

/**
 * Map Sleeper draft.metadata.scoring_type → board key.
 * Common values: ppr, half_ppr, std / standard.
 */
function formatFromScoringType(raw) {
  const key = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (!key) return null;
  if (
    key === "ppr" ||
    key === "full_ppr" ||
    key === "fullppr" ||
    key === "full"
  ) {
    return "full_ppr";
  }
  if (
    key === "half_ppr" ||
    key === "halfppr" ||
    key === "half" ||
    key === "0.5_ppr" ||
    key === "0_5_ppr"
  ) {
    return "half_ppr";
  }
  if (
    key === "std" ||
    key === "standard" ||
    key === "non_ppr" ||
    key === "nonppr" ||
    key === "zero_ppr" ||
    key === "0_ppr"
  ) {
    return "std";
  }
  return null;
}

/**
 * Map league.scoring_settings.rec (pts per reception) → board key.
 */
function formatFromReceptionPoints(rec) {
  if (rec == null || !Number.isFinite(Number(rec))) return null;
  const r = Number(rec);
  if (r >= 0.75) return "full_ppr";
  if (r >= 0.25) return "half_ppr";
  return "std";
}

/**
 * Prefer league reception points when present; else draft scoring_type.
 * Defaults to half_ppr (projections-half-ppr.json).
 */
function resolveScoringFormat(draft = {}, league = null) {
  const fromRec = formatFromReceptionPoints(league?.scoring_settings?.rec);
  if (fromRec) {
    return {
      format: fromRec,
      label: FORMAT_LABELS[fromRec],
      source: "league.rec",
      rec: Number(league.scoring_settings.rec),
    };
  }

  const rawType = draft?.metadata?.scoring_type;
  const fromType = formatFromScoringType(rawType);
  if (fromType) {
    return {
      format: fromType,
      label: FORMAT_LABELS[fromType],
      source: "draft.scoring_type",
      scoring_type: String(rawType),
    };
  }

  return {
    format: "half_ppr",
    label: FORMAT_LABELS.half_ppr,
    source: "default",
  };
}

/** Relative path under docs/data/ for the format board. */
function projectionsPathForFormat(format = "half_ppr") {
  if (format === "custom") return "draft/projections-custom.json";
  const key = SCORING_FORMATS.includes(format) ? format : "half_ppr";
  return `draft/projections-${key.replaceAll("_", "-")}.json`;
}

/** Daily-refreshed Sleeper ADP boards (independent of projection rebuilds). */
function adpPathForFormat(format = "half_ppr") {
  const key = SCORING_FORMATS.includes(format) ? format : "half_ppr";
  return `draft/adp-${key.replaceAll("_", "-")}.json`;
}

/** Prefer league-scored FantasyPros board when present. */
function projectionsPathForBoard(format = "half_ppr", { preferCustom = true } = {}) {
  if (preferCustom) return "draft/projections-custom.json";
  return projectionsPathForFormat(format);
}

/** FantasyPros / raw season stats → Sleeper scoring_settings keys. */
const STAT_SCORING_KEYS = {
  pass_yd: "pass_yd",
  pass_td: "pass_td",
  pass_int: "pass_int",
  pass_2pt: "pass_2pt",
  rush_yd: "rush_yd",
  rush_td: "rush_td",
  rush_2pt: "rush_2pt",
  rec: "rec",
  rec_yd: "rec_yd",
  rec_td: "rec_td",
  rec_2pt: "rec_2pt",
  fum_lost: "fum_lost",
  fum: "fum",
};

function numStat(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Apply a Sleeper league's scoring_settings to a raw season-stat object.
 * Mirrors src/scoring/league_points.py.
 */
function projectedPoints(stats = {}, scoringSettings = {}, position = "") {
  let total = 0;
  for (const [statKey, scoringKey] of Object.entries(STAT_SCORING_KEYS)) {
    const weight = scoringSettings[scoringKey];
    if (weight == null) continue;
    total += numStat(stats[statKey]) * numStat(weight);
  }
  const pos = String(position || "").toUpperCase();
  if (scoringSettings.bonus_rec_te != null && pos === "TE") {
    total += numStat(stats.rec) * numStat(scoringSettings.bonus_rec_te);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Re-rank a FantasyPros custom board for a live league's scoring_settings.
 * Players without ``stats`` keep their baked-in pts.
 */
function rescoreProjectionBoard(players = [], scoringSettings = {}) {
  const scored = players.map((p) => {
    if (!p?.stats || !scoringSettings || !Object.keys(scoringSettings).length) {
      return { ...p };
    }
    return {
      ...p,
      pts: projectedPoints(p.stats, scoringSettings, p.position),
    };
  });
  scored.sort(
    (a, b) =>
      Number(b.pts) - Number(a.pts) ||
      String(a.player || "").localeCompare(String(b.player || ""))
  );
  return scored.map((p, i) => ({ ...p, proj_rank: i + 1 }));
}

/**
 * Replace ADP on a board from another format's projections (by sleeper_id).
 * Custom FantasyPros boards bake one ADP; PPR mocks need full_ppr ADP, etc.
 */
function overlayAdpFromPlayers(players = [], adpPlayers = []) {
  const byId = new Map();
  for (const p of adpPlayers || []) {
    const id = String(p?.sleeper_id || p?.player_id || "")
      .replace(/^sleeper:/, "")
      .trim();
    if (!id) continue;
    if (p.adp == null || p.adp === "") continue;
    const adp = Number(p.adp);
    if (!Number.isFinite(adp) || adp <= 0) continue;
    byId.set(id, adp);
  }
  if (!byId.size) return (players || []).map((p) => ({ ...p }));
  return (players || []).map((p) => {
    const id = String(p?.sleeper_id || p?.player_id || "")
      .replace(/^sleeper:/, "")
      .trim();
    if (!id || !byId.has(id)) return { ...p };
    return { ...p, adp: byId.get(id) };
  });
}

/**
 * Prefer league.roster_positions when available; else draft.settings slots_*.
 */
function resolveLeagueSettings(draft = {}, league = null) {
  const ds = draft.settings || {};
  const teams = Number(
    league?.total_rosters || ds.teams || draft.metadata?.teams || 12
  );
  const rounds = Number(ds.rounds || 15);

  if (Array.isArray(league?.roster_positions) && league.roster_positions.length) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DEF: 0, K: 0 };
    for (const raw of league.roster_positions) {
      const p = String(raw || "").toUpperCase();
      if (p === "QB") counts.QB += 1;
      else if (p === "RB") counts.RB += 1;
      else if (p === "WR") counts.WR += 1;
      else if (p === "TE") counts.TE += 1;
      else if (p === "FLEX" || p === "W/R/T" || p === "WRRBTE") counts.FLEX += 1;
      else if (p === "SUPER_FLEX" || p === "Q/W/R/T" || p === "SUPERFLEX") {
        counts.FLEX += 1;
      } else if (p === "DEF" || p === "DST") counts.DEF += 1;
      else if (p === "K" || p === "PK") counts.K += 1;
    }
    return {
      slots_qb: counts.QB,
      slots_rb: counts.RB,
      slots_wr: counts.WR,
      slots_te: counts.TE,
      slots_flex: counts.FLEX,
      slots_def: counts.DEF,
      slots_k: counts.K,
      teams,
      rounds,
      source: "league",
    };
  }

  return {
    slots_qb: Number(ds.slots_qb ?? 1),
    slots_rb: Number(ds.slots_rb ?? 2),
    slots_wr: Number(ds.slots_wr ?? 2),
    slots_te: Number(ds.slots_te ?? 1),
    slots_flex: Number(ds.slots_flex ?? 1),
    slots_def: Number(ds.slots_def ?? 1),
    slots_k: Number(ds.slots_k ?? 1),
    teams,
    rounds,
    source: "draft",
  };
}

function normalizePos(position) {
  let pos = String(position || "").toUpperCase();
  if (pos === "DST") pos = "DEF";
  if (pos === "PK") pos = "K";
  return pos;
}

function rosterPositionCounts(players = []) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
  for (const p of players) {
    const pos = normalizePos(p.position);
    if (pos in counts) counts[pos] += 1;
  }
  return counts;
}

/** You get one pick per round, so the roster is as big as the draft is long. */
function rosterSize(settings = {}) {
  return Math.max(1, Number(settings.rounds) || 16);
}

function draftTargets(settings = {}) {
  return { total: rosterSize(settings) };
}

/**
 * Empty mandatory starters + open flex for one roster.
 * Used for VORP baselines (league-wide replacement), not pick ranking need.
 */
function teamNeed(roster, settings) {
  const slots = starterSlotsFromSettings(settings);
  const counts = rosterPositionCounts(roster);
  const need = {
    QB: Math.max(0, slots.QB - (counts.QB || 0)),
    RB: Math.max(0, slots.RB - (counts.RB || 0)),
    WR: Math.max(0, slots.WR - (counts.WR || 0)),
    TE: Math.max(0, slots.TE - (counts.TE || 0)),
    DEF: Math.max(0, slots.DEF - (counts.DEF || 0)),
    K: Math.max(0, slots.K - (counts.K || 0)),
  };
  const flexFilled =
    Math.max(0, (counts.RB || 0) - slots.RB) +
    Math.max(0, (counts.WR || 0) - slots.WR) +
    Math.max(0, (counts.TE || 0) - slots.TE);
  const openFlex = Math.max(0, slots.FLEX - flexFilled);
  return { need, openFlex, counts, slots };
}

/**
 * Positional need for ranking / opponent sim.
 *
 * Starter need = slots − owned (negative when overstocked).
 * Flex: while open, +1 to WR and RB only; when filled, split flex-seat credit
 * across WR/RB in proportion to their surplus (so 4 WR + 4 RB stay symmetric).
 * TE never gets flex credit — a 2nd TE is need −1.
 * Depth: remaining picks after mandatory singles and WR/RB starter+flex holes
 * are split evenly onto WR and RB only (TE/QB get no bench depth need).
 */
function needCounts(roster, settings) {
  const state = teamNeed(roster, settings);
  const { slots, counts, openFlex } = state;

  const surplusRB = Math.max(0, (counts.RB || 0) - slots.RB);
  const surplusWR = Math.max(0, (counts.WR || 0) - slots.WR);
  const flexSeatsFilled = Math.max(0, slots.FLEX - openFlex);
  const surplusTotal = surplusRB + surplusWR;
  // Split filled flex seats across WR/RB surplus so equal stacks stay even.
  const flexCredit = { RB: 0, WR: 0 };
  if (flexSeatsFilled > 0 && surplusTotal > 0) {
    flexCredit.RB = (flexSeatsFilled * surplusRB) / surplusTotal;
    flexCredit.WR = (flexSeatsFilled * surplusWR) / surplusTotal;
  }

  const flexUnit = openFlex > 0 ? 1 : 0;

  const hole = (pos) => Math.max(0, slots[pos] - (counts[pos] || 0));
  const picksLeft = Math.max(0, rosterSize(settings) - (roster?.length || 0));
  const mustFillSingles =
    hole("QB") + hole("TE") + hole("DEF") + hole("K");
  const wrRbCore = hole("RB") + hole("WR") + openFlex;
  const wrRbPicksAvailable = Math.max(0, picksLeft - mustFillSingles);
  const depthPool = Math.max(0, wrRbPicksAvailable - wrRbCore);
  const depthEach = depthPool / 2;

  const need_count = {
    QB: slots.QB - (counts.QB || 0),
    TE: slots.TE - (counts.TE || 0),
    DEF: slots.DEF - (counts.DEF || 0),
    K: slots.K - (counts.K || 0),
    RB: slots.RB - (counts.RB || 0) + flexUnit + flexCredit.RB + depthEach,
    WR: slots.WR - (counts.WR || 0) + flexUnit + flexCredit.WR + depthEach,
  };
  return {
    need_count,
    openFlex,
    counts,
    flexUnit,
    depthEach,
  };
}

function needState(roster, settings) {
  return needCounts(roster, settings);
}

function pickNumbersForSlot(slot, teams, rounds) {
  const picks = [];
  for (let round = 1; round <= rounds; round += 1) {
    const inRound = round % 2 === 1 ? slot : teams - slot + 1;
    picks.push((round - 1) * teams + inRound);
  }
  return picks;
}

function nextPickNumbers(mySlot, teams, rounds, currentPickNo) {
  return pickNumbersForSlot(mySlot, teams, rounds).filter((n) => n >= currentPickNo);
}

function slotForOverallPick(pickNo, teams) {
  const round = Math.ceil(pickNo / teams);
  const posInRound = ((pickNo - 1) % teams) + 1;
  return round % 2 === 1 ? posInRound : teams - posInRound + 1;
}

function adpValue(player) {
  // Number(null) === 0 — treat missing ADP as undrafted, not 1.01.
  const raw = player?.adp;
  if (raw == null || raw === "") return ADP_MISSING;
  const adp = Number(raw);
  return Number.isFinite(adp) && adp > 0 ? adp : ADP_MISSING;
}

/** True when the player has a usable ADP sample (excludes undrafted sentinels). */
function hasKnownAdp(player) {
  return adpValue(player) < ADP_MISSING;
}

/** Min/max/span over finite numbers; empty → zero extent. */
function numericExtent(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const raw of values) {
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { lo: 0, hi: 0, span: 0 };
  }
  return { lo, hi, span: hi - lo };
}

/** Map value → [0, 1] within extent; mid-point if no spread. */
function unitNormalize(value, extent) {
  if (!(extent.span > 0)) return 0.5;
  return (Number(value) - extent.lo) / extent.span;
}

/**
 * Known ADP → [0, 1] (lower ADP higher).
 * - Missing ADP → 0 (worst / no sample for that player).
 * - Empty known-ADP sample → 0 for everyone (no information).
 * - Flat non-empty sample (adpMax ≈ adpMin) → 1 for known ADP so real
 *   data still ranks above missing, without dividing by a ~0 span.
 */
function adpUnitNormalize(player, extent, { emptySample = false, flatSample = false } = {}) {
  if (emptySample || !hasKnownAdp(player)) return 0;
  if (flatSample || !(extent.span > ADP_SPAN_EPS)) return 1;
  return (extent.hi - adpValue(player)) / extent.span;
}

/** Format overall ADP as round.pick for a fixed team count (default 12). */
function formatAdpRoundPick(adp, teams = 12) {
  const overall = Number(adp);
  if (!Number.isFinite(overall) || overall <= 0) return null;
  const t = Math.max(1, Math.round(Number(teams) || 12));
  let round = Math.floor((overall - 1) / t) + 1;
  let pick = Math.round(((overall - 1) % t) + 1);
  if (pick > t) {
    pick = 1;
    round += 1;
  }
  if (pick < 1) pick = 1;
  return `${round}.${String(pick).padStart(2, "0")}`;
}

/**
 * Scale the VORP→ADP surplus cutoff with league size and skill-starter count.
 * Anchored so a default 12-team / 7-starter league uses SURPLUS_FULL as-is.
 */
function surplusFullThreshold(settings = {}, teams = 12) {
  const slots = starterSlotsFromSettings(settings);
  const starters =
    (slots.QB || 0) +
    (slots.RB || 0) +
    (slots.WR || 0) +
    (slots.TE || 0) +
    (slots.FLEX || 0);
  const scale =
    (Math.max(1, Number(teams) || 12) / 12) * (Math.max(1, starters) / 7);
  return SURPLUS_FULL * scale;
}

/** w∈[0, VORP_WEIGHT_CAP]: capped VORP share; remainder is ADP. */
function vorpWeightFromSurplus(surplus, threshold = SURPLUS_FULL) {
  const s = Math.max(0, Number(surplus) || 0);
  const t = Math.max(0, Number(threshold) || 0);
  if (t <= 0) return 0;
  return Math.min(VORP_WEIGHT_CAP, s / t);
}

function playerAtRank(pool, rank) {
  if (!pool?.length) return 0;
  // Rank 0 means nobody in the league needs a starter here, so the best player
  // left IS freely available — replacement level, not zero.
  const idx = Math.min(pool.length, Math.max(1, Math.round(rank))) - 1;
  return Number(pool[idx].pts) || 0;
}

function playerId(player) {
  return String(player?.sleeper_id || player?.player_id || "");
}

/**
 * Step 1: league-wide empty starter slots → replacement level per position.
 * Open flex is split evenly across RB/WR/TE (simple share of the last seats).
 */
function computeBaselines({ availableByPos, opponentRosters, settings, teams }) {
  const totalNeed = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
  let openFlexSlots = 0;

  for (let slot = 1; slot <= teams; slot += 1) {
    const state = teamNeed(opponentRosters[slot] || [], settings);
    openFlexSlots += state.openFlex;
    for (const pos of NEED_POSITIONS) {
      totalNeed[pos] += state.need[pos] || 0;
    }
  }

  const flexShare = openFlexSlots > 0 ? openFlexSlots / FLEX_POSITIONS.length : 0;
  const baselineRank = {};
  const baselineValue = {};
  for (const pos of NEED_POSITIONS) {
    const rank = (totalNeed[pos] || 0) + (FLEX_POSITIONS.includes(pos) ? flexShare : 0);
    baselineRank[pos] = rank;
    baselineValue[pos] = playerAtRank(availableByPos[pos] || [], rank);
  }

  return { totalNeed, openFlexSlots, flexShare, baselineRank, baselineValue };
}

/**
 * One opponent pick score: −ADP + NEED_K × need[pos]. When need = 0, best ADP.
 */
function opponentPickScore(player, need_count) {
  const pos = normalizePos(player.position);
  return -adpValue(player) + NEED_K * (need_count[pos] || 0);
}

/**
 * One opponent pick: max(−ADP + NEED_K × need[pos]). When all need = 0, best ADP.
 */
function predictNeedAdpPick(roster, settings, pool) {
  if (!pool.length) return null;
  const { need_count } = needState(roster, settings);
  let best = null;
  let bestScore = -Infinity;
  for (const player of pool) {
    const score = opponentPickScore(player, need_count);
    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
  }
  return best;
}

/**
 * Softmax pick probabilities for one opponent over the top candidates.
 * Returns Map<playerId, probability> (sums to ~1 over the top set).
 */
function softmaxPickProbs(roster, settings, pool) {
  const probs = new Map();
  if (!pool.length) return probs;

  const { need_count } = needState(roster, settings);
  const ranked = pool
    .map((player) => ({
      id: playerId(player),
      score: opponentPickScore(player, need_count),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(RISK_SOFTMAX_TOP, pool.length));

  if (!ranked.length) return probs;

  const maxScore = ranked[0].score;
  let weightSum = 0;
  const weights = ranked.map((row) => {
    const w = Math.exp((row.score - maxScore) / RISK_SOFTMAX_TEMP);
    weightSum += w;
    return { id: row.id, w };
  });
  if (!(weightSum > 0)) return probs;

  for (const { id, w } of weights) {
    probs.set(id, w / weightSum);
  }
  return probs;
}

function cloneRosters(rosters, teams) {
  const out = {};
  for (let slot = 1; slot <= teams; slot += 1) {
    out[slot] = [...(rosters[slot] || [])];
  }
  return out;
}

function applyPickToSim(rosters, slot, pick, pool) {
  const id = playerId(pick);
  const idx = pool.findIndex((p) => playerId(p) === id);
  if (idx >= 0) pool.splice(idx, 1);

  rosters[slot] = rosters[slot] || [];
  rosters[slot].push({
    player_id: id,
    position: normalizePos(pick.position),
    team: pick.team,
    name: pick.player,
    pts: pick.pts,
  });
  return id;
}

/**
 * Simulate hard need+ADP picks in [startPick, endPick) and return taken players.
 * Mutates pool + rosters.
 */
function simulateAdpPicks({
  startPick,
  endPick,
  teams,
  mySlot,
  settings,
  pool,
  rosters,
}) {
  const taken = [];
  if (!(endPick > startPick)) return taken;

  for (let pickNo = startPick; pickNo < endPick; pickNo += 1) {
    const slot = slotForOverallPick(pickNo, teams);
    if (slot === mySlot) continue;
    if (!pool.length) break;

    const pick = predictNeedAdpPick(rosters[slot] || [], settings, pool);
    if (!pick) break;

    applyPickToSim(rosters, slot, pick, pool);
    taken.push(pick);
  }
  return taken;
}

/**
 * Soft risk over [startPick, endPick): at each opponent pick, apply softmax
 * take-probabilities to survival, then advance the board along the hard path.
 * Returns Map<playerId, risk> with risk in [0, 1].
 */
function computeRiskScores({
  startPick,
  endPick,
  teams,
  mySlot,
  settings,
  pool,
  rosters,
}) {
  const survival = new Map();
  for (const player of pool) {
    survival.set(playerId(player), 1);
  }
  if (!(endPick > startPick) || !pool.length) {
    return new Map([...survival.keys()].map((id) => [id, 0]));
  }

  const workPool = [...pool];
  const workRosters = cloneRosters(rosters, teams);

  for (let pickNo = startPick; pickNo < endPick; pickNo += 1) {
    const slot = slotForOverallPick(pickNo, teams);
    if (slot === mySlot) continue;
    if (!workPool.length) break;

    const probs = softmaxPickProbs(workRosters[slot] || [], settings, workPool);
    for (const [id, surv] of survival) {
      const pTaken = probs.get(id) || 0;
      survival.set(id, surv * (1 - pTaken));
    }

    const pick = predictNeedAdpPick(workRosters[slot] || [], settings, workPool);
    if (!pick) break;
    const takenId = applyPickToSim(workRosters, slot, pick, workPool);
    // Most-likely path took them — treat as gone for risk purposes.
    survival.set(takenId, 0);
  }

  const risk = new Map();
  for (const [id, surv] of survival) {
    risk.set(id, Math.max(0, Math.min(1, 1 - surv)));
  }
  return risk;
}

function flattenAvailable(availableByPos) {
  const out = [];
  for (const pos of SKILL_POSITIONS) {
    for (const p of availableByPos[pos] || []) out.push(p);
  }
  return out;
}

/** Most draftable available players — used for opponent sim/risk only. */
function simPoolFromAvailable(availableByPos, size = SIM_POOL_SIZE) {
  return flattenAvailable(availableByPos)
    .slice()
    .sort(
      (a, b) =>
        adpValue(a) - adpValue(b) ||
        (Number(b.pts) || 0) - (Number(a.pts) || 0)
    )
    .slice(0, Math.max(1, size));
}

function groupByPos(players) {
  const out = { QB: [], RB: [], WR: [], TE: [], DEF: [], K: [] };
  for (const p of players) {
    const pos = normalizePos(p.position);
    if (!out[pos]) out[pos] = [];
    out[pos].push(p);
  }
  for (const pos of Object.keys(out)) {
    out[pos].sort((a, b) => Number(b.pts) - Number(a.pts));
  }
  return out;
}

function scoreCandidates({
  availableByPos: availableByPosIn,
  myRoster,
  opponentRosters,
  settings,
  teams,
  mySlot,
  currentPickNo,
  rounds,
  limit = 12,
}) {
  const myPicks = nextPickNumbers(mySlot, teams, rounds, currentPickNo);
  const myPick = myPicks[0] ?? currentPickNo;
  const myPickAfter = myPicks[1] ?? null;

  const availableByPos = { ...availableByPosIn };
  for (const pos of NEED_POSITIONS) {
    if (!availableByPos[pos]) availableByPos[pos] = [];
  }

  // Steps 1–2 on the live board.
  const baselines = computeBaselines({
    availableByPos,
    opponentRosters,
    settings,
    teams,
  });

  // Opponent modeling only needs the ADP-relevant pool — not 400+ deep sleepers.
  const pool = simPoolFromAvailable(availableByPos, SIM_POOL_SIZE);
  const simRosters = cloneRosters(opponentRosters, teams);
  // Ensure your current roster is present for need math during sim.
  simRosters[mySlot] = [...(myRoster || [])];

  // Arrive at your upcoming pick: remove hard need+ADP predictions before you.
  const beforeYou = simulateAdpPicks({
    startPick: currentPickNo,
    endPick: myPick,
    teams,
    mySlot,
    settings,
    pool,
    rosters: simRosters,
  });

  // Soft risk: P(gone before your next pick), with a small ADP-noise buffer.
  const lastPickNo = teams * rounds;
  const riskWindowEnd = myPickAfter
    ? Math.min(lastPickNo + 1, myPickAfter + RISK_LOOKAHEAD_PICKS)
    : null;
  const riskById = riskWindowEnd
    ? computeRiskScores({
        startPick: myPick + 1,
        endPick: riskWindowEnd,
        teams,
        mySlot,
        settings,
        pool,
        rosters: simRosters,
      })
    : new Map();

  const goneBeforeYou = new Set(beforeYou.map((p) => playerId(p)));

  // Pool you'll actually see on the clock for this pick.
  const availableAtPick = flattenAvailable(availableByPos).filter(
    (p) => !goneBeforeYou.has(playerId(p))
  );
  // Prefer scoring the same ADP-relevant slice; keeps UI/search fast.
  const scoreFocus = new Set(
    availableAtPick
      .slice()
      .sort(
        (a, b) =>
          adpValue(a) - adpValue(b) ||
          (Number(b.pts) || 0) - (Number(a.pts) || 0)
      )
      .slice(0, SCORE_POOL_SIZE)
      .map((p) => playerId(p))
  );

  const myNeed = needState(myRoster, settings);

  // Surplus uses the full board you'll see; only the focus set gets scored rows.
  const pending = [];
  let surplus = 0;
  for (const pos of SKILL_POSITIONS) {
    const baseline = baselines.baselineValue[pos] || 0;
    const need = myNeed.need_count[pos] || 0;
    const needBonus = NEED_K * need;

    for (const player of groupByPos(availableAtPick)[pos] || []) {
      const pts = Number(player.pts) || 0;
      const vorp = pts - baseline;
      if (vorp > 0) surplus += vorp;
      if (!scoreFocus.has(playerId(player))) continue;
      pending.push({ player, pos, vorp, need, needBonus });
    }
  }

  const surplusThreshold = surplusFullThreshold(settings, teams);
  const vorpWeight = vorpWeightFromSurplus(surplus, surplusThreshold);
  const adpWeight = 1 - vorpWeight;

  // Put VORP and ADP on one unit interval, then rescale by the pool's VORP
  // span so NEED_K / RISK_K stay comparable to blended value late-draft.
  // Flat / near-flat VORP → skip blend (need + risk only). Missing ADP is
  // kept out of the ADP extent so 9999 sentinels don't crush the scale.
  // Empty known-ADP sample → adpN = 0 for everyone. Flat known sample
  // (zero variance) → adpN = 1 for known ADP, 0 for missing — no /0.
  const vorpExtent = numericExtent(pending.map((row) => row.vorp));
  const knownAdpValues = pending
    .filter((row) => hasKnownAdp(row.player))
    .map((row) => adpValue(row.player));
  const emptyAdpSample = knownAdpValues.length === 0;
  const adpExtent = emptyAdpSample
    ? { lo: 0, hi: 0, span: 0 }
    : numericExtent(knownAdpValues);
  const flatAdpSample = !emptyAdpSample && !(adpExtent.span > ADP_SPAN_EPS);
  const flatVorp = !(vorpExtent.span > VORP_SPAN_EPS);

  const scored = [];
  for (const row of pending) {
    const risk = riskById.get(playerId(row.player)) || 0;
    const riskBonus = RISK_K * risk;
    let blend = 0;
    let adpTerm = 0;
    if (!flatVorp) {
      const vorpN = unitNormalize(row.vorp, vorpExtent);
      const adpN = adpUnitNormalize(row.player, adpExtent, {
        emptySample: emptyAdpSample,
        flatSample: flatAdpSample,
      });
      blend = (vorpWeight * vorpN + adpWeight * adpN) * vorpExtent.span;
      adpTerm = adpN * vorpExtent.span;
    }
    const score = blend + row.needBonus + riskBonus;

    scored.push({
      ...row.player,
      vorp: round1(row.vorp),
      need_bonus: round1(row.needBonus),
      need_count: row.need,
      risk: round1(risk),
      risk_bonus: round1(riskBonus),
      adp_score: round1(adpTerm),
      vorp_weight: round2(vorpWeight),
      score: round1(score),
    });
  }

  // Early: VORP-led. Late (surplus → 0): ADP-led. Need + risk always apply.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      adpValue(a) - adpValue(b) ||
      b.pts - a.pts
  );

  const capped =
    limit == null || !Number.isFinite(Number(limit))
      ? scored
      : scored.slice(0, Math.max(0, Number(limit)));

  return {
    targets: draftTargets(settings),
    need_count: myNeed.need_count,
    openFlex: myNeed.openFlex,
    vorp_surplus: round1(surplus),
    vorp_surplus_full: round1(surplusThreshold),
    vorp_weight: round2(vorpWeight),
    recommendations: capped,
  };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export {
  resolveLeagueSettings,
  resolveScoringFormat,
  projectionsPathForFormat,
  projectionsPathForBoard,
  adpPathForFormat,
  projectedPoints,
  rescoreProjectionBoard,
  overlayAdpFromPlayers,
  formatFromReceptionPoints,
  rosterPositionCounts,
  draftTargets,
  needCounts,
  needState,
  nextPickNumbers,
  scoreCandidates,
  formatAdpRoundPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
};
