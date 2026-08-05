/**
 * Draft companion scoring: dynamic VORP + snipe regret.
 *
 * Regret(p) = P(gone before next pick) × (V(p) - V(replacement at position))
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
  // Remaining flex after mandatory RB/WR/TE starters are filled from surplus.
  let flexPool =
    Math.max(0, counts.RB - slots.RB) +
    Math.max(0, counts.WR - slots.WR) +
    Math.max(0, counts.TE - slots.TE);
  need.FLEX = Math.max(0, slots.FLEX - flexPool);
  return need;
}

function positionHungry(need, position) {
  if (need[position] > 0) return true;
  if (need.FLEX > 0 && (position === "RB" || position === "WR" || position === "TE")) {
    return true;
  }
  return false;
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
    // If ADP is before the next stretch of picks, more likely gone.
    const windowEnd = currentPickNo + picksUntilNext - 1;
    if (adp <= currentPickNo) heat += 0.55;
    else if (adp <= windowEnd) heat += 0.35;
    else if (adp <= windowEnd + picksUntilNext) heat += 0.15;
  } else {
    heat += 0.08 * Math.min(picksUntilNext, 6);
  }
  const pGone = Math.max(0.02, Math.min(0.95, 1 - Math.exp(-heat)));
  // Soften with path length: more picks ⇒ higher gone chance.
  const lengthBoost = 1 - Math.exp(-0.08 * picksUntilNext);
  return Math.max(0.02, Math.min(0.98, 1 - pGone * (0.65 + 0.35 * lengthBoost)));
}

function replacementPts(availableByPos, position, settings, teams) {
  const slots = starterSlotsFromSettings(settings);
  let replacementIndex = Math.max(1, teams * (slots[position] || 0));
  if (position === "RB" || position === "WR") {
    // Share flex roughly evenly across RB/WR/TE.
    replacementIndex += Math.ceil((teams * (slots.FLEX || 0)) / 3);
  } else if (position === "TE") {
    replacementIndex += Math.floor((teams * (slots.FLEX || 0)) / 3);
  }
  const pool = availableByPos[position] || [];
  const idx = Math.min(pool.length, replacementIndex) - 1;
  if (idx < 0) return 0;
  return Number(pool[idx].pts) || 0;
}

function scoreCandidates({
  available,
  myRoster,
  opponentRosters,
  settings,
  teams,
  mySlot,
  currentPickNo,
  rounds,
}) {
  const myNeeds = rosterNeeds(myRoster, settings);
  const myPicks = nextPickNumbers(mySlot, teams, rounds, currentPickNo);
  const nextMine = myPicks[0] ?? currentPickNo;
  const picksUntilNext = Math.max(0, nextMine - currentPickNo);
  // Teams picking before your next pick (by draft slots in between).
  const slotsAhead = [];
  for (let p = currentPickNo; p < nextMine; p += 1) {
    const round = Math.ceil(p / teams);
    const posInRound = ((p - 1) % teams) + 1;
    const slot = round % 2 === 1 ? posInRound : teams - posInRound + 1;
    if (slot !== mySlot) slotsAhead.push(slot);
  }

  const availableByPos = {};
  for (const pos of SKILL_POSITIONS) {
    availableByPos[pos] = available
      .filter((p) => p.position === pos)
      .sort((a, b) => Number(b.pts) - Number(a.pts));
  }

  const scored = available.map((player) => {
    const pos = player.position;
    const repl = replacementPts(availableByPos, pos, settings, teams);
    const vorp = Number(player.pts) - repl;
    let hungry = 0;
    for (const slot of slotsAhead) {
      // Map slot → roster via caller-provided opponentRosters keyed by draft_slot when possible.
      const opp = opponentRosters[slot] || [];
      const need = rosterNeeds(opp, settings);
      if (positionHungry(need, pos)) hungry += 1;
    }
    const pSurvive = survivalProbability({
      player,
      picksUntilNext: picksUntilNext || 1,
      hungryTeamsAhead: hungry,
      currentPickNo,
    });
    const pGone = 1 - pSurvive;
    const regret = pGone * Math.max(0, vorp);
    const fit =
      myNeeds[pos] > 0 ? 1.15 : myNeeds.FLEX > 0 && pos !== "QB" ? 1.05 : 0.9;
    return {
      ...player,
      vorp: round1(vorp),
      replacement: round1(repl),
      p_survive: round2(pSurvive),
      p_gone: round2(pGone),
      regret: round1(regret * fit),
      hungry_teams_ahead: hungry,
      picks_until_next: picksUntilNext,
      need_fit: fit,
    };
  });

  scored.sort((a, b) => b.regret - a.regret || b.vorp - a.vorp || b.pts - a.pts);
  return {
    myNeeds,
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
  pickNumbersForSlot,
  nextPickNumbers,
  scoreCandidates,
  SKILL_POSITIONS,
};
