/**
 * Draft assistant — one loop, repeated every pick:
 *
 *  1. Baseline: empty starter slots leaguewide → replacement = pts of the
 *     player who would fill the last one.
 *  2. VBD = projected pts − baseline[pos].
 *  3. Predict picks before you pick again, using ADP (need-aware).
 *  4. Those predicted picks are "at risk" (won't survive to your next turn).
 *  5. Take highest-VBD among at-risk; if none, bank highest VBD overall.
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
const NEED_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/** Soft personal caps so the board doesn't recommend a 5th QB. */
const DRAFT_CAPS = {
  QB: 2,
  RB: 6,
  WR: 6,
  TE: 2,
  total: 16,
};

const BYE_STARTER_PTS_FLOOR = 110;
const ADP_MISSING = 9999;

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

function draftTargets(settings = {}) {
  const slots = starterSlotsFromSettings(settings);
  return {
    QB: DRAFT_CAPS.QB,
    RB: DRAFT_CAPS.RB,
    WR: DRAFT_CAPS.WR,
    TE: DRAFT_CAPS.TE,
    total: DRAFT_CAPS.total,
    min: {
      QB: slots.QB,
      RB: slots.RB,
      WR: slots.WR,
      TE: slots.TE,
    },
    slots,
  };
}

/** Empty mandatory starters + open flex for one roster. */
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
  return { need, openFlex, counts };
}

function hasEmptyStarters(state) {
  if (!state) return false;
  if (NEED_POSITIONS.some((pos) => (state.need[pos] || 0) > 0)) return true;
  return state.openFlex > 0;
}

function neededPositions(state) {
  const set = new Set();
  if (!state) return set;
  for (const pos of NEED_POSITIONS) {
    if ((state.need[pos] || 0) > 0) set.add(pos);
  }
  if (state.openFlex > 0) {
    for (const pos of FLEX_POSITIONS) set.add(pos);
  }
  return set;
}

function isHardCapped(counts, position) {
  const cap = DRAFT_CAPS[position];
  if (cap != null && (counts[position] || 0) >= cap) return true;
  const skillTotal =
    (counts.QB || 0) + (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0);
  return skillTotal >= DRAFT_CAPS.total;
}

function byeStackMateCount(myRoster = [], candidate = {}) {
  const bye = Number(candidate.bye_week);
  if (!Number.isFinite(bye) || bye <= 0) return 0;
  return myRoster.filter((p) => {
    if (Number(p.bye_week) !== bye) return false;
    const pts = Number(p.pts);
    if (!Number.isFinite(pts)) return true;
    return pts >= BYE_STARTER_PTS_FLOOR;
  }).length;
}

function ownsStarter(player, myRoster = []) {
  const starterId = player?.starter_sleeper_id;
  if (!starterId) return false;
  const sid = String(starterId);
  return myRoster.some((p) => String(p.player_id || "") === sid);
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
  const adp = Number(player?.adp);
  return Number.isFinite(adp) ? adp : ADP_MISSING;
}

function bestByAdp(players) {
  if (!players?.length) return null;
  let best = players[0];
  let bestAdp = adpValue(best);
  for (let i = 1; i < players.length; i += 1) {
    const adp = adpValue(players[i]);
    if (adp < bestAdp) {
      best = players[i];
      bestAdp = adp;
    }
  }
  return best;
}

function playerAtRank(pool, rank) {
  if (!pool?.length || rank <= 0) return 0;
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
 * Step 3: one opponent pick via ADP.
 * Empty starters → best ADP at a needed position; full lineup → best ADP overall.
 */
function predictAdpPick(roster, settings, pool) {
  if (!pool.length) return null;
  const state = teamNeed(roster, settings);
  let candidates = pool;
  if (hasEmptyStarters(state)) {
    const needed = neededPositions(state);
    const filtered = pool.filter((p) => needed.has(normalizePos(p.position)));
    if (filtered.length) candidates = filtered;
  }
  return bestByAdp(candidates);
}

function cloneRosters(rosters, teams) {
  const out = {};
  for (let slot = 1; slot <= teams; slot += 1) {
    out[slot] = [...(rosters[slot] || [])];
  }
  return out;
}

/**
 * Simulate ADP picks in [startPick, endPick) and return taken players.
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
  skipSlots = null,
}) {
  const taken = [];
  if (!(endPick > startPick)) return taken;

  for (let pickNo = startPick; pickNo < endPick; pickNo += 1) {
    const slot = slotForOverallPick(pickNo, teams);
    if (slot === mySlot) continue;
    if (skipSlots?.has(slot)) continue;
    if (!pool.length) break;

    const pick = predictAdpPick(rosters[slot] || [], settings, pool);
    if (!pick) break;

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
    taken.push(pick);
  }
  return taken;
}

function flattenAvailable(availableByPos) {
  const out = [];
  for (const pos of SKILL_POSITIONS) {
    for (const p of availableByPos[pos] || []) out.push(p);
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
    out[pos].sort((a, b) => Number(b.pts) - Number(a.pts));
  }
  return out;
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
  const myState = teamNeed(myRoster, settings);
  const myPicks = nextPickNumbers(mySlot, teams, rounds, currentPickNo);
  const myPick = myPicks[0] ?? currentPickNo;
  const myPickAfter = myPicks[1] ?? null;
  const picksUntilNext = Math.max(0, myPick - currentPickNo);

  let availableByPos = availableByPosIn;
  if (!availableByPos) {
    availableByPos = {};
    for (const pos of SKILL_POSITIONS) {
      availableByPos[pos] = (available || [])
        .filter((p) => normalizePos(p.position) === pos)
        .sort((a, b) => Number(b.pts) - Number(a.pts));
    }
  }
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

  const pool = flattenAvailable(availableByPos);
  const simRosters = cloneRosters(opponentRosters, teams);
  // Ensure your current roster is present for need math during sim.
  simRosters[mySlot] = [...(myRoster || [])];

  // Arrive at your upcoming pick: remove ADP predictions before you.
  const beforeYou = simulateAdpPicks({
    startPick: currentPickNo,
    endPick: myPick,
    teams,
    mySlot,
    settings,
    pool,
    rosters: simRosters,
  });

  // Step 3–4: who won't survive until you pick again after this one.
  const atRiskTaken = myPickAfter
    ? simulateAdpPicks({
        startPick: myPick + 1,
        endPick: myPickAfter,
        teams,
        mySlot,
        settings,
        pool,
        rosters: simRosters,
      })
    : [];

  const atRiskIds = new Set(atRiskTaken.map((p) => playerId(p)));
  const goneBeforeYou = new Set(beforeYou.map((p) => playerId(p)));

  // Pool you'll actually see on the clock for this pick.
  const availableAtPick = flattenAvailable(availableByPos).filter(
    (p) => !goneBeforeYou.has(playerId(p))
  );
  const byPosAtPick = groupByPos(availableAtPick);

  const scored = [];
  for (const pos of SKILL_POSITIONS) {
    if (isHardCapped(counts, pos)) continue;
    const baseline = baselines.baselineValue[pos] || 0;

    for (const player of byPosAtPick[pos] || []) {
      const pts = Number(player.pts) || 0;
      const vbd = pts - baseline;
      const id = playerId(player);
      const atRisk = atRiskIds.has(id);
      const byeMates = byeStackMateCount(myRoster, player);

      scored.push({
        ...player,
        vbd: round1(vbd),
        vorp: round1(vbd),
        replacement: round1(baseline),
        baseline_rank: round1(baselines.baselineRank[pos] || 0),
        at_risk: atRisk,
        risk_flag: atRisk ? "AT_RISK" : "SAFE",
        combined: round1(vbd),
        regret: round1(vbd),
        picks_until_next: picksUntilNext,
        need_fit: 1,
        bye_stack: byeMates > 0,
        bye_stack_mates: byeMates,
        owns_starter: ownsStarter(player, myRoster),
        mode: "vbd",
      });
    }
  }

  scored.sort(
    (a, b) =>
      b.vbd - a.vbd ||
      (Number(a.adp) || ADP_MISSING) - (Number(b.adp) || ADP_MISSING) ||
      b.pts - a.pts
  );

  const atRiskSorted = scored.filter((p) => p.at_risk);
  const topPick = atRiskSorted[0] || scored[0] || null;

  // Lead with the pick the loop chose; then other at-risk; then rest by VBD.
  const recommendations = [];
  const seen = new Set();
  const push = (p) => {
    if (!p) return;
    const id = playerId(p);
    if (seen.has(id)) return;
    seen.add(id);
    recommendations.push(p);
  };
  push(topPick);
  for (const p of atRiskSorted) push(p);
  for (const p of scored) push(p);

  for (let i = 0; i < recommendations.length; i += 1) {
    const next = recommendations[i + 1];
    recommendations[i].gap = next
      ? round1(recommendations[i].vbd - next.vbd)
      : round1(recommendations[i].vbd);
  }

  return {
    myNeeds: myState.need,
    myOpenFlex: myState.openFlex,
    myCounts: counts,
    targets: draftTargets(settings),
    nextPickNo: myPick,
    pickAfterNext: myPickAfter,
    picksUntilNext,
    mode: "vbd",
    predictedBeforeYou: beforeYou.map(summarizePredicted),
    predictedAtRisk: atRiskTaken.map(summarizePredicted),
    baselines: {
      totalNeed: baselines.totalNeed,
      openFlexSlots: baselines.openFlexSlots,
      flexShare: round1(baselines.flexShare),
      baselineRank: mapRound1(baselines.baselineRank),
      baselineValue: mapRound1(baselines.baselineValue),
    },
    topPick,
    recommendations: recommendations.slice(0, 12),
    scored,
  };
}

function summarizePredicted(player) {
  return {
    sleeper_id: playerId(player),
    player: player.player,
    position: normalizePos(player.position),
    adp: player.adp ?? null,
    pts: player.pts ?? null,
  };
}

function mapRound1(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = round1(v);
  return out;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function fitMultiplier(counts, settings, position) {
  return isHardCapped(counts, position) ? 0 : 1;
}

function softFitPreference(counts, settings, position) {
  return fitMultiplier(counts, settings, position);
}

function rosterNeeds(players, settings) {
  return teamNeed(players, settings).need;
}

export {
  starterSlotsFromSettings,
  resolveLeagueSettings,
  rosterNeeds,
  rosterPositionCounts,
  draftTargets,
  fitMultiplier,
  softFitPreference,
  isHardCapped,
  pickNumbersForSlot,
  nextPickNumbers,
  scoreCandidates,
  computeBaselines,
  predictAdpPick,
  simulateAdpPicks,
  byeStackMateCount,
  teamNeed,
  SKILL_POSITIONS,
  NEED_POSITIONS,
  FLEX_POSITIONS,
  DRAFT_CAPS,
};
