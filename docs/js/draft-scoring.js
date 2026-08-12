/**
 * Draft assistant — ADP + positional need + draft-risk.
 *
 * Every pick:
 *  1. Predict picks before you with −ADP + NEED_K × need[pos].
 *  2. Soft risk to your next pick: softmax over the same opponent score →
 *     survival product → risk = 1 − survival.
 *  3. Rank available players:
 *       score = −ADP + NEED_K × need + RISK_K × risk
 *     Lower ADP wins when need/risk are equal. Need can go negative when you
 *     overstock. Flex +1 applies to WR/RB only. Remaining roster picks add
 *     depth need to WR/RB only (not TE). Tie-break: better ADP.
 *
 * Need counts: starter holes per position. While flex is open, WR and RB each
 * get +1; filling flex clears that unit from both. TE never gets flex or
 * depth need — a 2nd TE goes negative.
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
const NEED_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];

/**
 * How many ADP picks one unit of positional need is worth. Large enough that
 * a real hole usually beats a modest ADP edge elsewhere.
 */
const NEED_K = 12;

/**
 * Max ADP-pick boost when risk ≈ 1 (likely gone before your next pick).
 * Soft nudge — need stays the main lever after ADP.
 */
const RISK_K = 8;

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
 * Empty mandatory starters + open flex for one roster.
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
 * ADP is noisy, so include a few picks past your next turn so borderline
 * players still accumulate risk.
 */
const RISK_LOOKAHEAD_PICKS = 3;

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
    .sort((a, b) => adpValue(a) - adpValue(b))
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
    out[pos].sort((a, b) => adpValue(a) - adpValue(b));
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

  const pool = simPoolFromAvailable(availableByPos, SIM_POOL_SIZE);
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
  });

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

  const availableAtPick = flattenAvailable(availableByPos).filter(
    (p) => !goneBeforeYou.has(playerId(p))
  );
  const scoreFocus = new Set(
    availableAtPick
      .slice()
      .sort((a, b) => adpValue(a) - adpValue(b))
      .slice(0, SCORE_POOL_SIZE)
      .map((p) => playerId(p))
  );

  const myNeed = needState(myRoster, settings);

  const scored = [];
  for (const pos of SKILL_POSITIONS) {
    const need = myNeed.need_count[pos] || 0;
    const needBonus = NEED_K * need;

    for (const player of groupByPos(availableAtPick)[pos] || []) {
      if (!scoreFocus.has(playerId(player))) continue;
      const adp = adpValue(player);
      const risk = riskById.get(playerId(player)) || 0;
      const riskBonus = RISK_K * risk;
      const score = -adp + needBonus + riskBonus;

      scored.push({
        ...player,
        need_bonus: round1(needBonus),
        need_count: need,
        risk: round1(risk),
        risk_bonus: round1(riskBonus),
        score: round1(score),
      });
    }
  }

  scored.sort(
    (a, b) => b.score - a.score || adpValue(a) - adpValue(b)
  );

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
  scoreCandidates,
  formatAdpRoundPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
};
