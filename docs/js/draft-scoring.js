/**
 * Draft companion scoring: dynamic VORP + snipe regret + contingent upside.
 *
 * Base regret ≈ P(sniped before your next pick) × VORP × roster-fit
 * Upside ≈ P(gone) × contingent-role VORP × P(opportunity) × fit
 * Combined = (1−w)·regret + w·upside_score  (w ramps late)
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

/** Your roster construction baseline (K/DEF ignored). */
const ROSTER_BASELINE = {
  QB: { min: 1, max: 1 },
  RB: { min: 6, max: 8 },
  WR: { min: 6, max: 8 },
  TE: { min: 1, max: 1 },
  rbWrCombinedMax: 14,
};

/**
 * After starters are filled, opponents still show soft depth demand
 * for RB/WR toward these counts. QB/TE stop after Phase 1.
 */
const OPPONENT_DEPTH_MINS = {
  QB: 1,
  TE: 1,
  RB: 4,
  WR: 4,
};

const PHASE2_WEIGHT = 0.45;

/** Base P(role opens) by position for contingent upside. */
const P_OPP_BASE = {
  RB: 0.28,
  WR: 0.12,
  TE: 0.15,
  QB: 0.18,
};

const UPSIDE_ROLE_SET = new Set(["handcuff", "committee", "rookie_path", "depth"]);

/**
 * Contingent upside VORP is a full-season gap; regret is P(gone)×VORP.
 * Scale upside into roughly comparable units before blending.
 */
const UPSIDE_SCORE_SCALE = 0.2;

/**
 * Only count roster mates likely to start when measuring bye clustering.
 * Tunable: half-PPR season projection floor for "starter mass".
 */
const BYE_STARTER_PTS_FLOOR = 110;

/**
 * Fit multipliers by how many existing starter-caliber teammates share the
 * candidate's bye. Index = mate count. Tunable by hand.
 */
const BYE_FIT_BY_MATES = [1.0, 0.88, 0.7, 0.52];

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

function draftTargets() {
  return {
    QB: ROSTER_BASELINE.QB.max,
    RB: ROSTER_BASELINE.RB.max,
    WR: ROSTER_BASELINE.WR.max,
    TE: ROSTER_BASELINE.TE.max,
    min: {
      QB: ROSTER_BASELINE.QB.min,
      RB: ROSTER_BASELINE.RB.min,
      WR: ROSTER_BASELINE.WR.min,
      TE: ROSTER_BASELINE.TE.min,
    },
    rbWrCombinedMax: ROSTER_BASELINE.rbWrCombinedMax,
  };
}

/** Phase 1 needs from league starter slots (flex fills RB/WR/TE). */
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

function phase1Hungry(need, position) {
  if (need[position] > 0) return true;
  if (need.FLEX > 0 && (position === "RB" || position === "WR" || position === "TE")) {
    return true;
  }
  return false;
}

/**
 * Two-phase opponent demand for snipe pressure.
 * Phase 1: starter holes (strong, weight 1).
 * Phase 2: depth mins, RB/WR only (soft, weight PHASE2_WEIGHT).
 */
function opponentDemand(roster, settings, position) {
  const need = rosterNeeds(roster, settings);
  if (phase1Hungry(need, position)) {
    return { phase: 1, weight: 1 };
  }
  if (position !== "RB" && position !== "WR") {
    return { phase: 0, weight: 0 };
  }
  const counts = rosterPositionCounts(roster);
  const depthMin = OPPONENT_DEPTH_MINS[position] || 0;
  if ((counts[position] || 0) < depthMin) {
    return { phase: 2, weight: PHASE2_WEIGHT };
  }
  return { phase: 0, weight: 0 };
}

function unmetMinimums(counts) {
  return SKILL_POSITIONS.filter(
    (pos) => (counts[pos] || 0) < ROSTER_BASELINE[pos].min
  );
}

/**
 * Roster-fit prior from the fixed baseline.
 * Fill mins first; hard-stop at maxes; RB+WR combined ≤ 12.
 */
function fitMultiplier(counts, _settings, position) {
  const base = ROSTER_BASELINE[position];
  if (!base) return 0;
  const have = counts[position] || 0;

  if (have >= base.max) return 0;
  if (
    (position === "RB" || position === "WR") &&
    (counts.RB || 0) + (counts.WR || 0) >= ROSTER_BASELINE.rbWrCombinedMax
  ) {
    return 0;
  }

  if (have < base.min) return 1.4;

  // Depth between min and max (RB/WR only — QB/TE max === min).
  if (position === "RB" || position === "WR") {
    const missing = unmetMinimums(counts);
    if (missing.some((pos) => pos === "QB" || pos === "TE")) return 0.85;
    return 1.0;
  }
  return 0;
}

/**
 * Penalize stacking many starter-caliber players on the same bye week.
 * myRoster entries should include bye_week + pts when available.
 */
function byeFitMultiplier(myRoster = [], candidate = {}) {
  const bye = Number(candidate.bye_week);
  if (!Number.isFinite(bye) || bye <= 0) return 1;

  const mates = myRoster.filter((p) => {
    if (Number(p.bye_week) !== bye) return false;
    const pts = Number(p.pts);
    // Missing pts: still count (unknown quality on that bye).
    if (!Number.isFinite(pts)) return true;
    return pts >= BYE_STARTER_PTS_FLOOR;
  });
  const n = mates.length;
  return BYE_FIT_BY_MATES[Math.min(n, BYE_FIT_BY_MATES.length - 1)];
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
  const pool = availableByPos[position] || [];
  const idx = Math.min(pool.length, replacementIndex) - 1;
  if (idx < 0) return 0;
  return Number(pool[idx].pts) || 0;
}

/**
 * Ramp upside weight: early = mean VORP; late / mins met = handcuffs & rookies.
 * Kept deliberately low — upside units are larger than P(gone)×VORP regret.
 */
function upsideBlendWeight({ counts, settings, currentPickNo, teams, myNeeds }) {
  const slots = starterSlotsFromSettings(settings);
  const starterHoles =
    Math.max(0, slots.QB - (counts.QB || 0)) +
    Math.max(0, slots.RB - (counts.RB || 0)) +
    Math.max(0, slots.WR - (counts.WR || 0)) +
    Math.max(0, slots.TE - (counts.TE || 0)) +
    Number(myNeeds?.FLEX || 0);
  const minsMet = unmetMinimums(counts).length === 0;
  const round = Math.max(1, Math.ceil(Number(currentPickNo || 1) / Math.max(1, teams)));

  if (starterHoles >= 3) return 0.05;
  if (!minsMet && starterHoles >= 1) return 0.08;
  if (!minsMet) return 0.12;
  if (round >= 10) return 0.3;
  if (round >= 7) return 0.22;
  return 0.15;
}

function ownsStarter(player, myRoster = []) {
  const starterId = player?.starter_sleeper_id;
  if (!starterId) return false;
  const sid = String(starterId);
  return myRoster.some((p) => String(p.player_id || "") === sid);
}

/**
 * Prior that the bigger role opens (injury / committee shift / rookie leap).
 * Boosted when you already rostered that team's starter (true handcuff).
 */
function opportunityPrior(player, myRoster = []) {
  const pos = String(player.position || "").toUpperCase();
  let p = P_OPP_BASE[pos] ?? 0.1;
  const role = player.role || "depth";
  if (role === "committee") p *= 0.7;
  else if (role === "depth") p *= 0.35;
  else if (role === "handcuff") p *= 1.05;
  else if (role === "rookie_path") p *= 1.1;

  if (player.is_rookie || role === "rookie_path") p += 0.08;
  if (ownsStarter(player, myRoster)) p = Math.min(0.85, p + 0.35);
  return Math.max(0, Math.min(0.9, p));
}

/**
 * Extra VORP from inheriting the starter role, beyond standalone mean VORP.
 */
function contingentUpsideVorp(player, standaloneVorp, replacement) {
  const role = player.role || "starter";
  if (role === "starter" || !UPSIDE_ROLE_SET.has(role)) return 0;
  const inherited =
    Number(player.upside_pts) ||
    (player.starter_pts != null ? Number(player.starter_pts) * 0.7 : 0);
  if (!inherited) return 0;
  const contingentVorp = Math.max(0, inherited - Number(replacement || 0));
  return Math.max(0, contingentVorp - Math.max(0, standaloneVorp));
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

  const targets = draftTargets();
  const SCORE_CAPS = {
    QB: counts.QB >= targets.QB ? 0 : 8,
    TE: counts.TE >= targets.TE ? 0 : 8,
    RB:
      counts.RB >= targets.RB ||
      counts.RB + counts.WR >= targets.rbWrCombinedMax
        ? 0
        : 45,
    WR:
      counts.WR >= targets.WR ||
      counts.RB + counts.WR >= targets.rbWrCombinedMax
        ? 0
        : 45,
  };
  const toScore = [];
  for (const pos of SKILL_POSITIONS) {
    const cap = SCORE_CAPS[pos];
    if (cap <= 0) continue;
    const pool = availableByPos[pos] || [];
    const primary = pool.slice(0, cap);
    const ids = new Set(primary.map((p) => String(p.sleeper_id)));
    // Pull handcuffs / rookies that sit below the mean-pts cap.
    const extras = pool
      .filter((p) => {
        if (ids.has(String(p.sleeper_id))) return false;
        const role = p.role || "";
        return (
          role === "handcuff" ||
          role === "rookie_path" ||
          role === "committee" ||
          (p.is_rookie && Number(p.depth_chart_order || 99) <= 2)
        );
      })
      .slice(0, 15);
    toScore.push(...primary, ...extras);
  }

  const blendW = upsideBlendWeight({
    counts,
    settings,
    currentPickNo,
    teams,
    myNeeds,
  });

  const scored = [];
  for (const player of toScore) {
    const pos = player.position;
    let fit = fitMultiplier(counts, settings, pos);
    if (fit <= 0) continue;
    // True handcuff insurance: slight fit boost when you own their starter.
    if (ownsStarter(player, myRoster) && (pos === "RB" || pos === "WR")) {
      fit = Math.min(1.55, fit * 1.15);
    }
    const byeFit = byeFitMultiplier(myRoster, player);
    fit *= byeFit;

    const repl = replacementPts(availableByPos, pos, settings, teams);
    const vorp = Number(player.pts) - repl;
    let hungry = 0;
    for (const slot of slotsAhead) {
      const demand = opponentDemand(opponentRosters[slot] || [], settings, pos);
      hungry += demand.weight;
    }
    // On the clock: regret is pure value (you lose the player if you pass).
    // Do NOT fake picksUntilNext=1 — that zeros regret for anyone not ADP-due now.
    const onClock = picksUntilNext <= 0;
    const pSurvive = onClock
      ? 0
      : survivalProbability({
          player,
          picksUntilNext,
          hungryTeamsAhead: hungry,
          currentPickNo,
        });
    const pGone = onClock ? 1 : 1 - pSurvive;
    const regret = pGone * Math.max(0, vorp) * fit;

    const upsideVorp = contingentUpsideVorp(player, vorp, repl);
    const pOpp = opportunityPrior(player, myRoster);
    // Upside is role-contingent EV only — scarcity stays on regret (no P(gone) reuse).
    const upsideScore = UPSIDE_SCORE_SCALE * upsideVorp * pOpp * fit;
    const combined = (1 - blendW) * regret + blendW * upsideScore;

    scored.push({
      ...player,
      vorp: round1(vorp),
      replacement: round1(repl),
      p_survive: round2(pSurvive),
      p_gone: round2(pGone),
      regret: round1(regret),
      upside_vorp: round1(upsideVorp),
      p_opp: round2(pOpp),
      upside: round1(upsideScore),
      combined: round1(combined),
      upside_weight: round2(blendW),
      hungry_teams_ahead: round2(hungry),
      picks_until_next: picksUntilNext,
      need_fit: round2(fit),
      bye_fit: round2(byeFit),
      owns_starter: ownsStarter(player, myRoster),
    });
  }

  scored.sort(
    (a, b) =>
      b.combined - a.combined ||
      b.regret - a.regret ||
      b.upside - a.upside ||
      b.vorp - a.vorp ||
      b.pts - a.pts
  );
  return {
    myNeeds,
    myCounts: counts,
    targets: draftTargets(),
    nextPickNo: nextMine,
    picksUntilNext,
    upsideWeight: blendW,
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
  rosterPositionCounts,
  draftTargets,
  fitMultiplier,
  opponentDemand,
  pickNumbersForSlot,
  nextPickNumbers,
  scoreCandidates,
  upsideBlendWeight,
  opportunityPrior,
  contingentUpsideVorp,
  byeFitMultiplier,
  SKILL_POSITIONS,
  ROSTER_BASELINE,
  OPPONENT_DEPTH_MINS,
};
