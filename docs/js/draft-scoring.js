/**
 * Draft assistant — ADP first, with overstock penalties. Risk is display-only.
 *
 * Every pick:
 *  1. Predict opponent picks until you are on the clock (same score you use).
 *  2. Rank remaining: score = −ADP + NEED_K × need (need ≤ 0).
 *  3. Risk column: ADP vs the wait until your next pick. Not in the score.
 *
 * WR/RB: starter slots plus shared flex seats are "enough." Surplus beyond
 * that is overstock (a 4th RB while flex is already filled is penalized).
 * QB/TE: no boost while empty; after one, a hard surplus penalty (one of
 * each is a complete plan). TE does not fill flex.
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
const NEED_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];

/**
 * How many ADP picks one unit of overstock penalty is worth.
 */
const NEED_K = 12;

/**
 * Extra hit once a one-starter position (QB/TE) is filled. Owned < slots → 0
 * (compete on ADP). At/above slots → −this, plus −1 per extra copy.
 */
const SINGLETON_SURPLUS_PENALTY = 2;

/**
 * Cap opponent "gone before you" sim to this many most-draftable players.
 * Full boards are 400+; scanning them every simulated pick freezes the UI.
 */
const SIM_POOL_SIZE = 80;

/** Cap fully scored recommendation candidates (UI + search). */
const SCORE_POOL_SIZE = 48;

const ADP_MISSING = 9999;

/**
 * ADP is noisy, so risk uses a few picks past your next turn.
 */
const RISK_LOOKAHEAD_PICKS = 3;

/** Scoring formats for daily Sleeper ADP boards under docs/data/draft/. */
const SCORING_FORMATS = ["half_ppr", "full_ppr", "std"];

const FORMAT_LABELS = {
  half_ppr: "Half PPR",
  full_ppr: "Full PPR",
  std: "Standard",
};

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
 * Defaults to half_ppr.
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

/** Relative path under docs/data/ for the format ADP board. */
function adpPathForFormat(format = "half_ppr") {
  const key = SCORING_FORMATS.includes(format) ? format : "half_ppr";
  return `draft/adp-${key.replaceAll("_", "-")}.json`;
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
 * Starter holes (for display / flex accounting). Flex is filled by extra
 * WR/RB only — TE does not take a flex seat.
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
    Math.max(0, (counts.WR || 0) - slots.WR);
  const openFlex = Math.max(0, slots.FLEX - flexFilled);
  return { need, openFlex, counts, slots };
}

/** 0 until the starter is filled; then a hard surplus penalty. */
function singletonNeed(slots, owned) {
  const n = Number(owned || 0);
  const s = Number(slots || 0);
  if (n < s) return 0;
  return s - n - SINGLETON_SURPLUS_PENALTY;
}

function wrRbOverstock(surplus, flexCredit) {
  const extra = surplus - flexCredit;
  return extra > 0 ? -extra : 0;
}

/**
 * Need for ranking / opponent sim: never positive.
 *
 * Unfilled → 0 (ADP decides). Overstock → negative.
 * WR/RB surplus first fills shared flex; leftover surplus is the penalty.
 * QB/TE: 0 until you have the starter, then −SINGLETON_SURPLUS_PENALTY
 * (and worse for extra copies).
 */
function needCounts(roster, settings) {
  const { slots, counts, openFlex } = teamNeed(roster, settings);

  const surplusRB = Math.max(0, (counts.RB || 0) - slots.RB);
  const surplusWR = Math.max(0, (counts.WR || 0) - slots.WR);
  const surplusTotal = surplusRB + surplusWR;
  const flexSeats = Math.max(0, slots.FLEX);
  const flexCredit = { RB: 0, WR: 0 };
  if (surplusTotal > 0 && flexSeats > 0) {
    const absorbed = Math.min(flexSeats, surplusTotal);
    flexCredit.RB = (absorbed * surplusRB) / surplusTotal;
    flexCredit.WR = (absorbed * surplusWR) / surplusTotal;
  }

  const need_count = {
    QB: singletonNeed(slots.QB, counts.QB),
    TE: singletonNeed(slots.TE, counts.TE),
    DEF: Math.min(0, slots.DEF - (counts.DEF || 0)),
    K: Math.min(0, slots.K - (counts.K || 0)),
    RB: wrRbOverstock(surplusRB, flexCredit.RB),
    WR: wrRbOverstock(surplusWR, flexCredit.WR),
  };
  return {
    need_count,
    openFlex,
    counts,
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

/** Draft slot that owns this overall pick (traded picks override snake). */
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
  ownerSlotByPick
) {
  if (!ownerSlotByPick) {
    return nextPickNumbers(mySlot, teams, rounds, currentPickNo);
  }
  const last = teams * rounds;
  const out = [];
  const start = Math.max(1, Number(currentPickNo) || 1);
  for (let n = start; n <= last; n += 1) {
    if (ownerSlotAtPick(n, teams, ownerSlotByPick) === mySlot) out.push(n);
  }
  return out;
}

function adpValue(player) {
  // Number(null) === 0 — treat missing ADP as undrafted, not 1.01.
  const raw = player?.adp;
  if (raw == null || raw === "") return ADP_MISSING;
  const adp = Number(raw);
  return Number.isFinite(adp) && adp > 0 ? adp : ADP_MISSING;
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

function playerId(player) {
  return String(player?.sleeper_id || player?.player_id || "").replace(
    /^sleeper:/,
    ""
  );
}

/**
 * One opponent pick: best ADP unless that roster is overstocked at the position.
 * `pool` must be sorted by ADP ascending. Need is ≤ 0, so we can stop once
 * remaining ADP cannot beat the current best.
 */
function predictNeedAdpPick(roster, settings, pool) {
  if (!pool.length) return null;
  const { need_count } = needState(roster, settings);
  let best = null;
  let bestScore = -Infinity;
  for (const player of pool) {
    const adp = adpValue(player);
    if (-adp < bestScore) break;
    const pos = normalizePos(player.position);
    const score = -adp + NEED_K * (need_count[pos] || 0);
    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
  }
  return best;
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
  const idx = pool.indexOf(pick);
  if (idx >= 0) pool.splice(idx, 1);

  rosters[slot] = rosters[slot] || [];
  rosters[slot].push({
    player_id: id,
    position: normalizePos(pick.position),
    team: pick.team,
    name: pick.player,
  });
  return id;
}

/**
 * Simulate hard need+ADP picks in [startPick, endPick) and return taken players.
 * Mutates pool + rosters. `pool` must stay ADP-sorted.
 */
function simulateAdpPicks({
  startPick,
  endPick,
  teams,
  mySlot,
  settings,
  pool,
  rosters,
  ownerSlotByPick,
}) {
  const taken = [];
  if (!(endPick > startPick)) return taken;

  for (let pickNo = startPick; pickNo < endPick; pickNo += 1) {
    const slot = ownerSlotAtPick(pickNo, teams, ownerSlotByPick);
    if (slot === mySlot) continue;
    if (!pool.length) break;

    const pick = predictNeedAdpPick(rosters[slot] || [], settings, pool);
    if (!pick) break;

    applyPickToSim(rosters, slot, pick, pool);
    taken.push(pick);
  }
  return taken;
}

/** Display-only: 1 if ADP is due now, 0 if ADP is after the wait window. */
function adpWindowRisk(adp, windowStart, windowEnd) {
  if (!(windowEnd > windowStart)) return 0;
  if (!Number.isFinite(adp) || adp <= 0 || adp >= ADP_MISSING) return 0;
  if (adp <= windowStart) return 1;
  if (adp >= windowEnd) return 0;
  return (windowEnd - adp) / (windowEnd - windowStart);
}

function flattenAvailable(availableByPos) {
  const out = [];
  for (const pos of SKILL_POSITIONS) {
    for (const p of availableByPos[pos] || []) out.push(p);
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
  ownerSlotByPick = null,
}) {
  const myPicks = nextOwnedPickNumbers(
    mySlot,
    teams,
    rounds,
    currentPickNo,
    ownerSlotByPick
  );
  const myPick = myPicks[0] ?? currentPickNo;
  const myPickAfter = myPicks[1] ?? null;

  const sortedAvailable = flattenAvailable(availableByPosIn).sort(
    (a, b) => adpValue(a) - adpValue(b)
  );
  const pool = sortedAvailable.slice(0, SIM_POOL_SIZE);

  let goneBeforeYou = new Set();
  if (myPick > currentPickNo) {
    const simRosters = cloneRosters(opponentRosters, teams);
    simRosters[mySlot] = [...(myRoster || [])];
    const beforeYou = simulateAdpPicks({
      startPick: currentPickNo,
      endPick: myPick,
      teams,
      mySlot,
      settings,
      pool,
      rosters: simRosters,
      ownerSlotByPick,
    });
    goneBeforeYou = new Set(beforeYou.map((p) => playerId(p)));
  }

  const lastPickNo = teams * rounds;
  const riskStart = myPick + 1;
  const riskEnd = myPickAfter
    ? Math.min(lastPickNo + 1, myPickAfter + RISK_LOOKAHEAD_PICKS)
    : null;

  const myNeed = needState(myRoster, settings);
  const scored = [];
  for (const player of sortedAvailable) {
    if (goneBeforeYou.has(playerId(player))) continue;
    const pos = normalizePos(player.position);
    const need = myNeed.need_count[pos] || 0;
    const needBonus = NEED_K * need;
    const adp = adpValue(player);
    const risk = riskEnd ? adpWindowRisk(adp, riskStart, riskEnd) : 0;
    scored.push({
      ...player,
      need_bonus: round1(needBonus),
      need_count: need,
      risk: round1(risk),
      score: round1(-adp + needBonus),
    });
    if (scored.length >= SCORE_POOL_SIZE) break;
  }

  scored.sort((a, b) => b.score - a.score || adpValue(a) - adpValue(b));

  const capped =
    limit == null || !Number.isFinite(Number(limit))
      ? scored
      : scored.slice(0, Math.max(0, Number(limit)));

  return {
    targets: draftTargets(settings),
    need_count: myNeed.need_count,
    openFlex: myNeed.openFlex,
    recommendations: capped,
  };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

export {
  resolveLeagueSettings,
  resolveScoringFormat,
  adpPathForFormat,
  formatFromReceptionPoints,
  rosterPositionCounts,
  draftTargets,
  needCounts,
  needState,
  nextPickNumbers,
  nextOwnedPickNumbers,
  slotForOverallPick,
  scoreCandidates,
  formatAdpRoundPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
};
