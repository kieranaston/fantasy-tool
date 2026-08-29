/**
 * Draft assistant — VORP rankings, ADP risk.
 *
 * Your rankings (scoreCandidates):
 *  1. Baseline: empty starter slots leaguewide → replacement pts per position.
 *  2. VORP = pts − baseline[pos].
 *  3. Blend VORP ↔ ADP from remaining above-replacement surplus (see SURPLUS_FULL).
 *     Surplus, threshold, and VORP weight are per position (not global).
 *     Normalize VORP and ADP within each position, then blend on a 0–1 scale.
 *  4. score = blend / M. M is the positional need multiplier (×1 or ×1.5).
 *     Same M for every player at that position (backup QB/TE → 1.5).
 *
 * Risk (display-only, on the clock): same filtered board and sim pool as rankings.
 * Pool = top 60 ADP ∪ top 60 need-ADP ∪ top 10 VORP per position (deduped).
 * Opponent picks use plain ADP (no backup QB/TE need penalty); filled DEF/K stay excluded.
 *
 * Live picks come from Sleeper — not simulated for rankings.
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];
const NEED_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/** Backup QB/TE multiplier for your rankings only (not opponent risk sim). */
const QB_TE_BACKUP_M = 1.5;

/**
 * Remaining above-replacement VORP at which a position's blend is still 100% VORP.
 * Anchored to 12-team / 7 skill-starter league; split across starter demand
 * (FLEX shared equally among RB/WR/TE).
 */
const SURPLUS_FULL = 400;

/** Below this VORP range, fall back to ADP×M ranking (no blend). */
const VORP_SPAN_EPS = 0.5;

/** DEF/K stay off the board until this draft round (inclusive). */
const DEF_K_MIN_ROUND = 13;

/** Top N from each ranking leg (ADP, need-ADP) before union. */
const SIM_POOL_RANK_DEPTH = 60;

/** Always include top N available by VORP at each position (catches mid-ADP TEs, etc.). */
const SIM_POOL_VORP_PER_POS = 10;

const ADP_MISSING = 9999;

/** Softmax temperature for opponent pick sim (ADP-scale scores). */
const SOFTMAX_TEMPERATURE = 4;

/** Scoring formats for daily Sleeper ADP boards under docs/data/draft/. */
const SCORING_FORMATS = ["half_ppr", "full_ppr", "std"];

const FORMAT_LABELS = {
  half_ppr: "Half PPR",
  full_ppr: "Full PPR",
  std: "Standard",
};

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

function formatFromReceptionPoints(rec) {
  if (rec == null || !Number.isFinite(Number(rec))) return null;
  const r = Number(rec);
  if (r >= 0.75) return "full_ppr";
  if (r >= 0.25) return "half_ppr";
  return "std";
}

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

const ADP_BOARD_PATH = "draft/adp-board.json";

function adpPathForFormat(_format = "half_ppr") {
  return ADP_BOARD_PATH;
}

function playerAdpForFormat(player, format = "half_ppr") {
  const raw = player?.adp;
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") {
    const key = SCORING_FORMATS.includes(format) ? format : "half_ppr";
    const value = raw[key];
    return value == null ? null : Number(value);
  }
  return Number(raw);
}

function playerPtsForFormat(player, format = "half_ppr") {
  const raw = player?.pts;
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") {
    const key = SCORING_FORMATS.includes(format) ? format : "half_ppr";
    const value = raw[key];
    return value == null ? null : Number(value);
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function resolveLeagueSettings(draft = {}, league = null) {
  const ds = draft.settings || {};
  const teams = Number(
    league?.total_rosters || ds.teams || draft.metadata?.teams || 12
  );
  const rounds = Number(ds.rounds || 15);

  if (Array.isArray(league?.roster_positions) && league.roster_positions.length) {
    const counts = {
      QB: 0,
      RB: 0,
      WR: 0,
      TE: 0,
      FLEX: 0,
      SUPER_FLEX: 0,
      DEF: 0,
      K: 0,
    };
    for (const raw of league.roster_positions) {
      const p = String(raw || "").toUpperCase();
      if (p === "QB") counts.QB += 1;
      else if (p === "RB") counts.RB += 1;
      else if (p === "WR") counts.WR += 1;
      else if (p === "TE") counts.TE += 1;
      else if (p === "FLEX" || p === "W/R/T" || p === "WRRBTE") counts.FLEX += 1;
      else if (p === "SUPER_FLEX" || p === "Q/W/R/T" || p === "SUPERFLEX") {
        counts.SUPER_FLEX += 1;
      } else if (p === "DEF" || p === "DST") counts.DEF += 1;
      else if (p === "K" || p === "PK") counts.K += 1;
    }
    return {
      slots_qb: counts.QB,
      slots_rb: counts.RB,
      slots_wr: counts.WR,
      slots_te: counts.TE,
      slots_flex: counts.FLEX,
      slots_super_flex: counts.SUPER_FLEX,
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
    slots_super_flex: Number(ds.slots_super_flex ?? ds.slots_superflex ?? 0),
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

function rosterSize(settings = {}) {
  return Math.max(1, Number(settings.rounds) || 16);
}

function draftTargets(settings = {}) {
  return { total: rosterSize(settings) };
}

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

function qbTeMultiplier(owned) {
  return Number(owned || 0) >= 1 ? QB_TE_BACKUP_M : 1;
}

/**
 * Per-position multiplier M for your rankings. RB/WR stay 1.
 * QB/TE go to 1.5 after the first copy. DEF/K are 0 when filled (also used by risk).
 */
function needCounts(roster, settings = {}) {
  const counts = rosterPositionCounts(roster);
  const slotsDef = Math.max(0, Number(settings.slots_def) || 0);
  const slotsK = Math.max(0, Number(settings.slots_k) || 0);
  const need_count = {
    QB: qbTeMultiplier(counts.QB),
    RB: 1,
    WR: 1,
    TE: qbTeMultiplier(counts.TE),
    DEF: slotsDef === 0 || counts.DEF >= slotsDef ? 0 : 1,
    K: slotsK === 0 || counts.K >= slotsK ? 0 : 1,
  };
  return {
    need_count,
    openFlex: 0,
    counts,
  };
}

/** Empty mandatory starters + open flex — used for VORP baselines. */
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

function filterFilledSlots(availableByPos, settings, myRoster) {
  const filtered = {};
  for (const pos of SKILL_POSITIONS) {
    filtered[pos] = [...(availableByPos[pos] || [])];
  }
  const { need_count } = needCounts(myRoster, settings);
  for (const pos of ["DEF", "K"]) {
    if (!need_count[pos]) filtered[pos] = [];
  }
  return filtered;
}

function pickRound(pickNo, teams) {
  const t = Math.max(1, Number(teams) || 12);
  const n = Math.max(1, Number(pickNo) || 1);
  return Math.ceil(n / t);
}

/** Rankings + risk: hide filled DEF/K slots and all DEF/K before round 13. */
function filterDraftBoard(
  availableByPos,
  settings,
  myRoster,
  currentPickNo,
  teams
) {
  const filtered = filterFilledSlots(availableByPos, settings, myRoster);
  if (pickRound(currentPickNo, teams) < DEF_K_MIN_ROUND) {
    return { ...filtered, DEF: [], K: [] };
  }
  return filtered;
}

function pickNumbersForSlot(slot, teams, rounds) {
  const picks = [];
  for (let round = 1; round <= rounds; round += 1) {
    const inRound = round % 2 === 1 ? slot : teams - slot + 1;
    picks.push((round - 1) * teams + inRound);
  }
  return picks;
}

function nextPickNumbers(mySlot, teams, rounds, currentPickNo, filledPickNos) {
  return pickNumbersForSlot(mySlot, teams, rounds).filter(
    (n) => n >= currentPickNo && !filledPickNos?.has(n)
  );
}

function filledPickNumbers(picks, last) {
  const taken = new Set();
  const cap = Math.max(1, Number(last) || 0);
  for (const pick of picks || []) {
    const n = Number(pick?.pick_no);
    if (Number.isFinite(n) && n >= 1 && n <= cap) taken.add(n);
  }
  return taken;
}

function currentPickNo(picks, teams = 12, rounds = 15) {
  const last = Math.max(1, Number(teams) * Number(rounds) || 1);
  const taken = filledPickNumbers(picks, last);
  for (let n = 1; n <= last; n += 1) {
    if (!taken.has(n)) return n;
  }
  return last + 1;
}

function unfilledPickCount(fromInclusive, toExclusive, filledPickNos) {
  const start = Math.max(1, Number(fromInclusive) || 1);
  const end = Number(toExclusive);
  if (!Number.isFinite(end) || end <= start) return 0;
  let n = 0;
  for (let i = start; i < end; i += 1) {
    if (!filledPickNos?.has(i)) n += 1;
  }
  return n;
}

function slotForOverallPick(pickNo, teams) {
  const round = Math.ceil(pickNo / teams);
  const posInRound = ((pickNo - 1) % teams) + 1;
  return round % 2 === 1 ? posInRound : teams - posInRound + 1;
}

function ownerSlotAtPick(pickNo, teams, ownerSlotByPick) {
  const mapped = Number(
    ownerSlotByPick?.[pickNo] ?? ownerSlotByPick?.[String(pickNo)]
  );
  if (Number.isFinite(mapped) && mapped > 0) return mapped;
  return slotForOverallPick(pickNo, teams);
}

function nextOwnedPickNumbers(
  mySlot,
  teams,
  rounds,
  currentPickNo,
  ownerSlotByPick,
  filledPickNos = null
) {
  const slot = Number(mySlot);
  if (!ownerSlotByPick) {
    return nextPickNumbers(slot, teams, rounds, currentPickNo, filledPickNos);
  }
  const last = teams * rounds;
  const out = [];
  const start = Math.max(1, Number(currentPickNo) || 1);
  for (let n = start; n <= last; n += 1) {
    if (filledPickNos?.has(n)) continue;
    if (Number(ownerSlotAtPick(n, teams, ownerSlotByPick)) === slot) out.push(n);
  }
  return out;
}

function adpValue(player) {
  const raw = player?.adp;
  if (raw == null || raw === "") return ADP_MISSING;
  const adp = Number(raw);
  return Number.isFinite(adp) && adp > 0 ? adp : ADP_MISSING;
}

function hasKnownAdp(player) {
  return adpValue(player) < ADP_MISSING;
}

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

function unitNormalize(value, extent) {
  if (!(extent.span > 0)) return 0.5;
  return (Number(value) - extent.lo) / extent.span;
}

function adpUnitNormalize(player, extent, { emptySample = false } = {}) {
  if (emptySample || !hasKnownAdp(player)) return 0;
  if (!(extent.span > 0)) return 0.5;
  return (extent.hi - adpValue(player)) / extent.span;
}

/** Per-position VORP/ADP ranges for pool-local normalization. */
function positionExtents(pending) {
  const byPos = {};
  for (const row of pending) {
    const pos = row.pos;
    if (!byPos[pos]) byPos[pos] = { vorps: [], adps: [] };
    byPos[pos].vorps.push(row.vorp);
    if (hasKnownAdp(row.player)) byPos[pos].adps.push(adpValue(row.player));
  }
  const out = {};
  for (const [pos, { vorps, adps }] of Object.entries(byPos)) {
    const emptyAdp = adps.length === 0;
    out[pos] = {
      vorp: numericExtent(vorps),
      adp: emptyAdp ? { lo: 0, hi: 0, span: 0 } : numericExtent(adps),
      emptyAdp,
    };
  }
  return out;
}

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

/** Per-position surplus thresholds (share of SURPLUS_FULL by starter demand). */
function surplusFullThresholdByPos(settings = {}, teams = 12) {
  const slots = starterSlotsFromSettings(settings);
  const t = Math.max(1, Number(teams) || 12);
  const flexEach = Math.max(0, Number(slots.FLEX) || 0) / FLEX_POSITIONS.length;
  const demand = {
    QB: Math.max(0, Number(slots.QB) || 0),
    RB: Math.max(0, Number(slots.RB) || 0) + flexEach,
    WR: Math.max(0, Number(slots.WR) || 0) + flexEach,
    TE: Math.max(0, Number(slots.TE) || 0) + flexEach,
    DEF: Math.max(0, Number(slots.DEF) || 0),
    K: Math.max(0, Number(slots.K) || 0),
  };
  const perSlot = SURPLUS_FULL / 7;
  const teamScale = t / 12;
  const out = {};
  for (const pos of NEED_POSITIONS) {
    out[pos] = perSlot * demand[pos] * teamScale;
  }
  return out;
}

function vorpWeightFromSurplus(surplus, threshold = SURPLUS_FULL) {
  const s = Math.max(0, Number(surplus) || 0);
  const t = Math.max(0, Number(threshold) || 0);
  if (t <= 0) return 0;
  return Math.min(1, s / t);
}

function playerAtRank(pool, rank) {
  if (!pool?.length) return 0;
  const idx = Math.min(pool.length, Math.max(1, Math.round(rank))) - 1;
  return Number(pool[idx].pts) || 0;
}

function playerId(player) {
  return String(player?.sleeper_id || player?.player_id || "").replace(
    /^sleeper:/,
    ""
  );
}

function sortAvailableByPts(availableByPos) {
  const out = {};
  for (const pos of NEED_POSITIONS) {
    out[pos] = [...(availableByPos[pos] || [])].sort(
      (a, b) =>
        (Number(b.pts) || 0) - (Number(a.pts) || 0) ||
        adpValue(a) - adpValue(b)
    );
  }
  return out;
}

/** Pre-draft starter demand per position (teams × slots + flex share). */
function leagueStarterDemand(settings = {}, teams = 12) {
  const slots = starterSlotsFromSettings(settings);
  const t = Math.max(1, Number(teams) || 12);
  const totalNeed = {
    QB: t * Math.max(0, slots.QB),
    RB: t * Math.max(0, slots.RB),
    WR: t * Math.max(0, slots.WR),
    TE: t * Math.max(0, slots.TE),
    DEF: t * Math.max(0, slots.DEF),
    K: t * Math.max(0, slots.K),
  };
  const openFlexSlots = t * Math.max(0, slots.FLEX);
  const flexShare =
    openFlexSlots > 0 ? openFlexSlots / FLEX_POSITIONS.length : 0;
  return { totalNeed, openFlexSlots, flexShare };
}

function draftedPositionCounts(rosters, teams) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
  const t = Math.max(1, Number(teams) || 12);
  for (let slot = 1; slot <= t; slot += 1) {
    for (const player of rosters?.[slot] || []) {
      const pos = normalizePos(player.position);
      if (pos in counts) counts[pos] += 1;
    }
  }
  return counts;
}

/**
 * Replacement level per position: pre-draft rank minus players already drafted
 * there, then the undrafted player at that remaining-slot index (by pts).
 */
function computeBaselines({ availableByPos, rosters, settings, teams }) {
  const { totalNeed, openFlexSlots, flexShare } = leagueStarterDemand(
    settings,
    teams
  );
  const drafted = draftedPositionCounts(rosters, teams);
  const baselineRank = {};
  const baselineValue = {};
  const remainingSlots = {};
  for (const pos of NEED_POSITIONS) {
    const initial =
      (totalNeed[pos] || 0) +
      (FLEX_POSITIONS.includes(pos) ? flexShare : 0);
    const remaining = Math.max(0, initial - (drafted[pos] || 0));
    remainingSlots[pos] = remaining;
    const rank = Math.max(1, remaining);
    baselineRank[pos] = rank;
    baselineValue[pos] = playerAtRank(availableByPos[pos] || [], rank);
  }

  return {
    totalNeed,
    openFlexSlots,
    flexShare,
    drafted,
    remainingSlots,
    baselineRank,
    baselineValue,
  };
}

function needAdpScore(player, need_count) {
  const pos = normalizePos(player.position);
  const m = Number(need_count[pos]);
  // M≤0 (filled DEF/K): −ADP×0 would rank above every −ADP×M candidate.
  if (Number.isFinite(m) && m <= 0) return -Infinity;
  const multiplier = Number.isFinite(m) && m > 0 ? m : 1;
  return -adpValue(player) * multiplier;
}

/** Opponent risk sim: plain ADP, still skip filled DEF/K (M≤0). */
function riskAdpScore(player, need_count) {
  const pos = normalizePos(player.position);
  const m = Number(need_count[pos]);
  if (Number.isFinite(m) && m <= 0) return -Infinity;
  return -adpValue(player);
}

function cloneRosters(rosters, teams) {
  const out = {};
  for (let slot = 1; slot <= teams; slot += 1) {
    out[slot] = [...(rosters[slot] || [])];
  }
  return out;
}

function simulateGoneProbabilities({
  startPick,
  endPick,
  teams,
  mySlot,
  settings,
  pool,
  rosters,
  ownerSlotByPick,
  filledPickNos = null,
}) {
  const n = pool.length;
  const out = new Map();
  for (const player of pool) out.set(playerId(player), 0);
  if (!(endPick > startPick) || !n) return out;

  const mass = new Float64Array(n).fill(1);
  const localRosters = cloneRosters(rosters, teams);
  const invT = 1 / Math.max(1e-9, SOFTMAX_TEMPERATURE);

  for (let pickNo = startPick; pickNo < endPick; pickNo += 1) {
    if (filledPickNos?.has(pickNo)) continue;
    const slot = ownerSlotAtPick(pickNo, teams, ownerSlotByPick);
    if (Number(slot) === Number(mySlot)) continue;

    const { need_count } = needCounts(localRosters[slot] || [], settings);
    const scores = new Array(n);
    let maxS = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (mass[i] <= 1e-12) {
        scores[i] = -Infinity;
        continue;
      }
      const s = riskAdpScore(pool[i], need_count);
      scores[i] = s;
      if (s > maxS) maxS = s;
    }
    if (!Number.isFinite(maxS)) break;

    let sumW = 0;
    const weights = new Array(n);
    for (let i = 0; i < n; i += 1) {
      if (mass[i] <= 1e-12 || !Number.isFinite(scores[i])) {
        weights[i] = 0;
        continue;
      }
      const w = mass[i] * Math.exp((scores[i] - maxS) * invT);
      weights[i] = w;
      sumW += w;
    }
    if (sumW <= 0) break;

    let bestI = 0;
    let bestP = -1;
    for (let i = 0; i < n; i += 1) {
      const pPick = weights[i] / sumW;
      mass[i] = Math.max(0, mass[i] - pPick);
      if (pPick > bestP) {
        bestP = pPick;
        bestI = i;
      }
    }

    const pick = pool[bestI];
    localRosters[slot] = localRosters[slot] || [];
    localRosters[slot].push({
      player_id: playerId(pick),
      position: normalizePos(pick.position),
      team: pick.team,
      name: pick.player,
    });
  }

  for (let i = 0; i < n; i += 1) {
    out.set(playerId(pool[i]), Math.min(1, Math.max(0, 1 - mass[i])));
  }
  return out;
}

function topVorpByPosition(availableByPos, baselines, perPos = SIM_POOL_VORP_PER_POS) {
  const depth = Math.max(1, Number(perPos) || SIM_POOL_VORP_PER_POS);
  const out = [];
  for (const pos of NEED_POSITIONS) {
    const baseline = baselines.baselineValue[pos] || 0;
    const ranked = [...(availableByPos[pos] || [])]
      .map((player) => ({
        player,
        vorp: (Number(player.pts) || 0) - baseline,
      }))
      .sort(
        (a, b) =>
          b.vorp - a.vorp ||
          adpValue(a.player) - adpValue(b.player)
      )
      .slice(0, depth)
      .map((row) => row.player);
    out.push(...ranked);
  }
  return out;
}

/** Union top by ADP, top by need-ADP, and top VORP per position (deduped). */
function buildSimPool(
  sortedAvailable,
  myNeed,
  availableByPos,
  baselines,
  rankDepth = SIM_POOL_RANK_DEPTH
) {
  const cap = Math.max(1, Number(rankDepth) || SIM_POOL_RANK_DEPTH);
  const topByAdp = sortedAvailable.slice(0, cap);
  const topByNeed = sortedAvailable
    .slice()
    .sort((a, b) => {
      const scoreA = needAdpScore(a, myNeed.need_count);
      const scoreB = needAdpScore(b, myNeed.need_count);
      return scoreB - scoreA || adpValue(a) - adpValue(b);
    })
    .slice(0, cap);
  const topByVorp = topVorpByPosition(availableByPos, baselines);

  const seen = new Set();
  const pool = [];
  for (const player of [...topByAdp, ...topByNeed, ...topByVorp]) {
    const id = playerId(player);
    if (seen.has(id)) continue;
    seen.add(id);
    pool.push(player);
  }
  return pool;
}

function flattenAvailable(availableByPos, maxOut = Infinity) {
  const lists = SKILL_POSITIONS.map((pos) => availableByPos[pos] || []);
  const heads = lists.map(() => 0);
  const total = lists.reduce((n, arr) => n + arr.length, 0);
  const cap = Math.max(0, Number(maxOut));
  const limit = Number.isFinite(cap) ? Math.min(total, cap) : total;
  const out = [];
  while (out.length < limit) {
    let bestI = -1;
    let bestAdp = Infinity;
    for (let i = 0; i < lists.length; i += 1) {
      const arr = lists[i];
      const h = heads[i];
      if (h >= arr.length) continue;
      const adp = adpValue(arr[h]);
      if (adp < bestAdp) {
        bestAdp = adp;
        bestI = i;
      }
    }
    if (bestI < 0) break;
    out.push(lists[bestI][heads[bestI]]);
    heads[bestI] += 1;
  }
  return out;
}

function groupByPos(players) {
  const out = { QB: [], RB: [], WR: [], TE: [], DEF: [], K: [] };
  for (const p of players) {
    const pos = normalizePos(p.position);
    if (!out[pos]) out[pos] = [];
    out[pos].push(p);
  }
  for (const pos of Object.keys(out)) {
    out[pos].sort(
      (a, b) =>
        (Number(b.pts) || 0) - (Number(a.pts) || 0) ||
        adpValue(a) - adpValue(b)
    );
  }
  return out;
}

/** Fallback for players outside the scored pool (filter / search). */
function annotateScore(player, need_count, { risk = null } = {}) {
  const pos = normalizePos(player.position);
  const m = Number(need_count[pos]);
  const p = risk == null ? null : Number(risk);
  const riskOut =
    p == null || !Number.isFinite(p) ? null : Math.round(p * 100) / 100;
  // M≤0 (filled DEF/K): −ADP×0 would outrank every −ADP×M candidate.
  if (Number.isFinite(m) && m <= 0) {
    return {
      ...player,
      need_bonus: 0,
      need_count: 0,
      vorp: null,
      risk: riskOut,
      score: -Infinity,
    };
  }
  const multiplier = Number.isFinite(m) && m > 0 ? m : 1;
  return {
    ...player,
    need_bonus: round1(multiplier),
    need_count: multiplier,
    vorp: null,
    risk: riskOut,
    score: round1(-adpValue(player) * multiplier),
  };
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
  ownerSlotByPick = null,
  filledPickNos = null,
}) {
  const recLimit = Math.max(1, Number(limit) || 12);
  const filteredAvailable = filterDraftBoard(
    availableByPosIn,
    settings,
    myRoster,
    currentPickNo,
    teams
  );
  const ptsSorted = sortAvailableByPts(filteredAvailable);

  const baselines = computeBaselines({
    availableByPos: ptsSorted,
    rosters: opponentRosters,
    settings,
    teams,
  });

  const availableAtPick = flattenAvailable(filteredAvailable);
  const myNeed = needCounts(myRoster, settings);
  const simPool = buildSimPool(
    availableAtPick,
    myNeed,
    filteredAvailable,
    baselines,
    SIM_POOL_RANK_DEPTH
  );
  const scoreFocus = new Set(simPool.map((p) => playerId(p)));

  const pending = [];
  const surplusByPos = {};
  for (const pos of NEED_POSITIONS) surplusByPos[pos] = 0;

  for (const pos of NEED_POSITIONS) {
    const multiplier = myNeed.need_count[pos];
    if (!(Number(multiplier) > 0)) continue;

    const baseline = baselines.baselineValue[pos] || 0;

    for (const player of groupByPos(availableAtPick)[pos] || []) {
      const pts = Number(player.pts) || 0;
      const vorp = pts - baseline;
      if (vorp > 0) surplusByPos[pos] += vorp;
      if (!scoreFocus.has(playerId(player))) continue;
      pending.push({ player, pos, vorp, multiplier });
    }
  }

  const thresholdByPos = surplusFullThresholdByPos(settings, teams);
  const vorpWeightByPos = {};
  let surplusTotal = 0;
  let weightMass = 0;
  let weightSum = 0;
  for (const pos of NEED_POSITIONS) {
    const w = vorpWeightFromSurplus(surplusByPos[pos], thresholdByPos[pos]);
    vorpWeightByPos[pos] = w;
    const s = surplusByPos[pos] || 0;
    surplusTotal += s;
    if (Number(myNeed.need_count[pos]) > 0) {
      weightMass += s;
      weightSum += w * s;
    }
  }
  const vorpWeightAvg = weightMass > 0 ? weightSum / weightMass : 0;
  const posExtents = positionExtents(pending);

  const scored = [];
  for (const row of pending) {
    const m =
      Number.isFinite(Number(row.multiplier)) && Number(row.multiplier) > 0
        ? Number(row.multiplier)
        : 1;
    const ext = posExtents[row.pos] || {
      vorp: { lo: 0, hi: 0, span: 0 },
      adp: { lo: 0, hi: 0, span: 0 },
      emptyAdp: true,
    };
    const flatVorp = !(ext.vorp.span > VORP_SPAN_EPS);
    const adpN = adpUnitNormalize(row.player, ext.adp, {
      emptySample: ext.emptyAdp,
    });
    const vorpWeight = vorpWeightByPos[row.pos] ?? 0;
    const adpWeight = 1 - vorpWeight;
    let blend;
    if (flatVorp) {
      blend = adpN;
    } else {
      const vorpN = unitNormalize(row.vorp, ext.vorp);
      blend = vorpWeight * vorpN + adpWeight * adpN;
    }
    const score = blend / m;

    scored.push({
      ...row.player,
      vorp: round1(row.vorp),
      need_bonus: round1(m),
      need_count: m,
      risk: null,
      adp_score: round2(adpN),
      vorp_weight: round2(vorpWeight),
      score: round2(score),
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      adpValue(a) - adpValue(b) ||
      (Number(b.pts) || 0) - (Number(a.pts) || 0)
  );

  const capped = scored.slice(0, recLimit);

  const surplusRounded = {};
  const thresholdRounded = {};
  const weightRounded = {};
  for (const pos of NEED_POSITIONS) {
    surplusRounded[pos] = round1(surplusByPos[pos] || 0);
    thresholdRounded[pos] = round1(thresholdByPos[pos] || 0);
    weightRounded[pos] = round2(vorpWeightByPos[pos] || 0);
  }

  return {
    targets: draftTargets(settings),
    need_count: myNeed.need_count,
    openFlex: myNeed.openFlex,
    vorp_surplus: round1(surplusTotal),
    vorp_surplus_by_pos: surplusRounded,
    vorp_surplus_full: thresholdRounded,
    vorp_weight: round2(vorpWeightAvg),
    vorp_weight_by_pos: weightRounded,
    recommendations: capped,
    scored,
  };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function computeRiskProbabilities({
  availableByPos: availableByPosIn,
  myRoster,
  opponentRosters,
  settings,
  teams,
  mySlot,
  currentPickNo,
  rounds,
  limit = 12,
  ownerSlotByPick = null,
  filledPickNos = null,
}) {
  const myPicks = nextOwnedPickNumbers(
    mySlot,
    teams,
    rounds,
    currentPickNo,
    ownerSlotByPick,
    filledPickNos
  );
  const myPick = myPicks[0] ?? currentPickNo;
  const myPickAfter = myPicks[1] ?? null;
  const onClock = Number(myPick) === Number(currentPickNo);
  if (!onClock || !myPickAfter || myPickAfter <= myPick + 1) {
    return new Map();
  }

  const filteredAvailable = filterDraftBoard(
    availableByPosIn,
    settings,
    myRoster,
    currentPickNo,
    teams
  );
  const ptsSorted = sortAvailableByPts(filteredAvailable);
  const baselines = computeBaselines({
    availableByPos: ptsSorted,
    rosters: opponentRosters,
    settings,
    teams,
  });
  const sortedForRisk = flattenAvailable(filteredAvailable);
  const myNeed = needCounts(myRoster, settings);
  const pool = buildSimPool(
    sortedForRisk,
    myNeed,
    filteredAvailable,
    baselines,
    SIM_POOL_RANK_DEPTH
  );
  const simRosters = cloneRosters(opponentRosters, teams);
  simRosters[mySlot] = [...(myRoster || [])];
  return simulateGoneProbabilities({
    startPick: myPick + 1,
    endPick: myPickAfter,
    teams,
    mySlot,
    settings,
    pool,
    rosters: simRosters,
    ownerSlotByPick,
    filledPickNos,
  });
}

export {
  resolveLeagueSettings,
  resolveScoringFormat,
  adpPathForFormat,
  playerAdpForFormat,
  playerPtsForFormat,
  formatFromReceptionPoints,
  formatFromScoringType,
  rosterPositionCounts,
  draftTargets,
  needCounts,
  normalizePos,
  nextPickNumbers,
  nextOwnedPickNumbers,
  filledPickNumbers,
  currentPickNo,
  unfilledPickCount,
  ownerSlotAtPick,
  slotForOverallPick,
  scoreCandidates,
  computeRiskProbabilities,
  annotateScore,
  formatAdpRoundPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
};
