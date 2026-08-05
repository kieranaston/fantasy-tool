/**
 * Draft companion scoring: dynamic VORP + snipe regret.
 *
 * Regret(p) = P(gone before next pick) × (V(p) - V(replacement at position))
 * Then multiply by roster-fit (hard caps on extra QB/TE; prefer RB/WR depth).
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

function starterSlotsFromSettings(settings = {}) {
  return {
    QB: Number(settings.slots_qb || 0),
    RB: Number(settings.slots_rb || 0),
    WR: Number(settings.slots_wr || 0),
    TE: Number(settings.slots_te || 0),
    FLEX: Number(settings.slots_flex || 0),
  };
}

function rosterPositionCounts(players = []) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const p of players) {
    const pos = String(p.position || "").toUpperCase();
    if (pos in counts) counts[pos] += 1;
  }
  return counts;
}

/**
 * How many of each position are actually useful to draft.
 * 1QB / 1TE leagues: stop after the starter. RB/WR keep bench depth.
 */
function draftTargets(settings = {}) {
  const slots = starterSlotsFromSettings(settings);
  return {
    QB: Math.max(1, slots.QB),
    TE: Math.max(1, slots.TE),
    // starters + flex + a couple bench pieces
    RB: slots.RB + slots.FLEX + 2,
    WR: slots.WR + slots.FLEX + 2,
  };
}

/** How many starter holes remain for a roster (flex fills RB/WR/TE). */
function rosterNeeds(players, settings) {
  const slots = starterSlotsFromSettings(settings);
  const counts = rosterPositionCounts(players);
  const need = {
    QB: Math.max(0, slots.QB - counts.QB),
    RB: Math.max(0, slots.RB - counts.RB),
    WR: Math.max(0, slots.WR - counts.WR),
    TE: Math.max(0, slots.TE - counts.TE),
    FLEX: slots.FLEX,
  };
  let flexPool =
    Math.max(0, counts.RB - slots.RB) +
    Math.max(0, counts.WR - slots.WR) +
    Math.max(0, counts.TE - slots.TE);
  need.FLEX = Math.max(0, slots.FLEX - flexPool);
  return need;
}

/** Opponent snipe pressure — flex demand is mostly RB/WR in practice. */
function positionHungry(need, position) {
  if (need[position] > 0) return true;
  if (need.FLEX > 0 && (position === "RB" || position === "WR")) return true;
  return false;
}

/**
 * Strong roster construction prior.
 * Extra QBs/TEs are excluded once you have your starter.
 */
function fitMultiplier(counts, settings, position) {
  const slots = starterSlotsFromSettings(settings);
  const targets = draftTargets(settings);
  const have = counts[position] || 0;

  if (position === "QB" || position === "TE") {
    if (have >= targets[position]) return 0;
    return 1.3;
  }

  // RB / WR
  if (have < slots[position]) return 1.25;
  if (slots.FLEX > 0 && have < slots[position] + 1) return 1.12;
  if (have < targets[position]) return 1.0;
  return 0.25;
}

/**
 * Snake pick numbers owned by draft_slot across rounds.
 * pick_no is 1-indexed overall.
 */
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

/**
 * Crude survival model:
 * each hungry team ahead multiplies take-risk; ADP vs current pick adds heat.
 */
function survivalProbability({
  player,
  picksUntilNext,
  hungryTeamsAhead,
  currentPickNo,
}) {
  if (picksUntilNext <= 0) return 0;
  const adp = player.adp;
  let heat = 0.12 * hungryTeamsAhead;
  if (adp != null && Number.isFinite(adp)) {
    const windowEnd = currentPickNo + picksUntilNext - 1;
    if (adp <= currentPickNo) heat += 0.55;
    else if (adp <= windowEnd) heat += 0.35;
    else if (adp <= windowEnd + picksUntilNext) heat += 0.15;
  } else {
    heat += 0.08 * Math.min(picksUntilNext, 6);
  }
  const pGone = Math.max(0.02, Math.min(0.95, 1 - Math.exp(-heat)));
  const lengthBoost = 1 - Math.exp(-0.08 * picksUntilNext);
  return Math.max(0.02, Math.min(0.98, 1 - pGone * (0.65 + 0.35 * lengthBoost)));
}

function replacementPts(availableByPos, position, settings, teams) {
  const slots = starterSlotsFromSettings(settings);
  let replacementIndex = Math.max(1, teams * (slots[position] || 0));
  if (position === "RB" || position === "WR") {
    replacementIndex += Math.ceil((teams * (slots.FLEX || 0)) / 2);
  }
  // QB/TE replacement stays at starter count — extras aren't valuable.
  const pool = availableByPos[position] || [];
  const idx = Math.min(pool.length, replacementIndex) - 1;
  if (idx < 0) return 0;
  return Number(pool[idx].pts) || 0;
}

function scoreCandidates({
  available,
  availableByPos: availableByPosIn,
  myRoster,
  opponentRosters,
  settings,
  teams,
  mySlot,
  currentPickNo,
  rounds,
}) {
  const counts = rosterPositionCounts(myRoster);
  const myNeeds = rosterNeeds(myRoster, settings);
  const myPicks = nextPickNumbers(mySlot, teams, rounds, currentPickNo);
  const nextMine = myPicks[0] ?? currentPickNo;
  const picksUntilNext = Math.max(0, nextMine - currentPickNo);

  const slotsAhead = [];
  for (let p = currentPickNo; p < nextMine; p += 1) {
    const round = Math.ceil(p / teams);
    const posInRound = ((p - 1) % teams) + 1;
    const slot = round % 2 === 1 ? posInRound : teams - posInRound + 1;
    if (slot !== mySlot) slotsAhead.push(slot);
  }

  let availableByPos = availableByPosIn;
  if (!availableByPos) {
    availableByPos = {};
    for (const pos of SKILL_POSITIONS) {
      availableByPos[pos] = available
        .filter((p) => p.position === pos)
        .sort((a, b) => Number(b.pts) - Number(a.pts));
    }
  }

  const needsBySlot = {};
  for (const slot of new Set(slotsAhead)) {
    needsBySlot[slot] = rosterNeeds(opponentRosters[slot] || [], settings);
  }

  // Skip scoring QB/TE pools once those starters are filled.
  const SCORE_CAPS = {
    QB: counts.QB >= draftTargets(settings).QB ? 0 : 10,
    TE: counts.TE >= draftTargets(settings).TE ? 0 : 10,
    RB: 40,
    WR: 40,
  };
  const toScore = [];
  for (const pos of SKILL_POSITIONS) {
    const cap = SCORE_CAPS[pos];
    if (cap <= 0) continue;
    toScore.push(...(availableByPos[pos] || []).slice(0, cap));
  }

  const scored = [];
  for (const player of toScore) {
    const pos = player.position;
    const fit = fitMultiplier(counts, settings, pos);
    if (fit <= 0) continue;

    const repl = replacementPts(availableByPos, pos, settings, teams);
    const vorp = Number(player.pts) - repl;
    let hungry = 0;
    for (const slot of slotsAhead) {
      if (positionHungry(needsBySlot[slot], pos)) hungry += 1;
    }
    const pSurvive = survivalProbability({
      player,
      picksUntilNext: picksUntilNext || 1,
      hungryTeamsAhead: hungry,
      currentPickNo,
    });
    const pGone = 1 - pSurvive;
    const regret = pGone * Math.max(0, vorp) * fit;
    scored.push({
      ...player,
      vorp: round1(vorp),
      replacement: round1(repl),
      p_survive: round2(pSurvive),
      p_gone: round2(pGone),
      regret: round1(regret),
      hungry_teams_ahead: hungry,
      picks_until_next: picksUntilNext,
      need_fit: fit,
    });
  }

  scored.sort((a, b) => b.regret - a.regret || b.vorp - a.vorp || b.pts - a.pts);
  return {
    myNeeds,
    myCounts: counts,
    targets: draftTargets(settings),
    nextPickNo: nextMine,
    picksUntilNext,
    recommendations: scored.slice(0, 12),
    scored,
  };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export {
  starterSlotsFromSettings,
  rosterNeeds,
  draftTargets,
  fitMultiplier,
  pickNumbersForSlot,
  nextPickNumbers,
  scoreCandidates,
  SKILL_POSITIONS,
};
