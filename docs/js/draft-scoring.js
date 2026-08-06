/**
 * Draft assistant — one loop, repeated every pick:
 *
 *  1. Baseline: empty starter slots leaguewide → replacement = pts of the
 *     player who would fill the last one.
 *  2. VORP = max(0, pts − baseline[pos]) — never negative.
 *  3. Predict picks before you pick again, using ADP (need-aware).
 *  4. Those predicted picks are "at risk" (won't survive to your next turn),
 *     plus a small buffer past it so ADP-boundary players still count.
 *  5. Score = VORP + need bonus, where the bonus is the VORP this player has
 *     over what you'd still get at that position next turn — counted only if
 *     you need the spot (halved when it only fills flex).
 *     Rank by score, then at-risk, then low ADP.
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

const ADP_MISSING = 9999;

/**
 * ADP is noisy, so a player predicted to survive by one or two picks is really
 * a coin flip. Simulate this many picks past your next turn so borderline
 * players count as at risk.
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

/**
 * How much YOU need this position right now.
 *  2 = fills an empty mandatory starter
 *  1 = can fill an open flex
 *  0 = bench / already covered
 */
function myNeedPriority(position, state) {
  const pos = normalizePos(position);
  if ((state?.need?.[pos] || 0) > 0) return 2;
  if ((state?.openFlex || 0) > 0 && FLEX_POSITIONS.includes(pos)) return 1;
  return 0;
}

/** Share of a position's wait cost applied as a need bonus. */
function needWeightFor(priority) {
  if (priority >= 2) return 1;
  if (priority === 1) return 0.5;
  return 0;
}

function isHardCapped(counts, position) {
  const cap = DRAFT_CAPS[position];
  if (cap != null && (counts[position] || 0) >= cap) return true;
  const skillTotal =
    (counts.QB || 0) + (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0);
  return skillTotal >= DRAFT_CAPS.total;
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
  if (!pool?.length) return 0;
  // Rank 0 means nobody in the league needs a starter here, so the best player
  // left IS freely available — replacement level, not zero.
  const idx = Math.min(pool.length, Math.max(1, Math.round(rank))) - 1;
  return Number(pool[idx].pts) || 0;
}

function playerId(player) {
  return String(player?.sleeper_id || player?.player_id || "");
}

function bestVorpForPos(players, baseline) {
  let best = 0;
  for (const p of players || []) {
    const vorp = Math.max(0, (Number(p.pts) || 0) - baseline);
    if (vorp > best) best = vorp;
  }
  return best;
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
}) {
  const taken = [];
  if (!(endPick > startPick)) return taken;

  for (let pickNo = startPick; pickNo < endPick; pickNo += 1) {
    const slot = slotForOverallPick(pickNo, teams);
    if (slot === mySlot) continue;
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
  const lastPickNo = teams * rounds;
  const riskWindowEnd = myPickAfter
    ? Math.min(lastPickNo + 1, myPickAfter + RISK_LOOKAHEAD_PICKS)
    : null;
  const atRiskTaken = riskWindowEnd
    ? simulateAdpPicks({
        startPick: myPick + 1,
        endPick: riskWindowEnd,
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

  // Fallback level per position: best VORP that survives the risk window.
  // Skipping a position you need costs you the gap above that fallback.
  const fallbackVorp = {};
  const waitCost = {};
  for (const pos of SKILL_POSITIONS) {
    const baseline = baselines.baselineValue[pos] || 0;
    const bestNow = bestVorpForPos(byPosAtPick[pos], baseline);
    const bestLater = bestVorpForPos(
      pool.filter((p) => normalizePos(p.position) === pos),
      baseline
    );
    fallbackVorp[pos] = bestLater;
    waitCost[pos] = Math.max(0, bestNow - bestLater);
  }

  const scored = [];
  for (const pos of SKILL_POSITIONS) {
    if (isHardCapped(counts, pos)) continue;
    const baseline = baselines.baselineValue[pos] || 0;
    const needPriority = myNeedPriority(pos, myState);
    const weight = needWeightFor(needPriority);
    const fallback = fallbackVorp[pos] || 0;

    for (const player of byPosAtPick[pos] || []) {
      const pts = Number(player.pts) || 0;
      // Never rank/display below-replacement as negative — floor at 0.
      const vorp = Math.max(0, pts - baseline);
      // Only the value this player captures over the wait-a-turn fallback.
      const needBonus = weight * Math.max(0, vorp - fallback);

      scored.push({
        ...player,
        vorp: round1(vorp),
        need_bonus: round1(needBonus),
        need_priority: needPriority,
        score: round1(vorp + needBonus),
        replacement: round1(baseline),
        at_risk: atRiskIds.has(playerId(player)),
      });
    }
  }

  // Score = VORP + need bonus. No hard gate: a big value edge can outrank need.
  // Once nothing scores above replacement, at-risk and low ADP decide.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.at_risk) - Number(a.at_risk) ||
      adpValue(a) - adpValue(b) ||
      b.pts - a.pts
  );

  const topPick =
    scored.find((p) => p.at_risk && p.score > 0) || scored[0] || null;

  return {
    myNeeds: myState.need,
    myOpenFlex: myState.openFlex,
    myCounts: counts,
    targets: draftTargets(settings),
    nextPickNo: myPick,
    pickAfterNext: myPickAfter,
    picksUntilNext,
    predictedBeforeYou: beforeYou.map(summarizePredicted),
    predictedAtRisk: atRiskTaken.map(summarizePredicted),
    baselines: {
      totalNeed: baselines.totalNeed,
      openFlexSlots: baselines.openFlexSlots,
      flexShare: round1(baselines.flexShare),
      baselineRank: mapRound1(baselines.baselineRank),
      baselineValue: mapRound1(baselines.baselineValue),
    },
    waitCost: mapRound1(waitCost),
    fallbackVorp: mapRound1(fallbackVorp),
    topPick,
    recommendations: scored.slice(0, 12),
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

export {
  starterSlotsFromSettings,
  resolveLeagueSettings,
  rosterPositionCounts,
  draftTargets,
  isHardCapped,
  pickNumbersForSlot,
  nextPickNumbers,
  scoreCandidates,
  computeBaselines,
  predictAdpPick,
  simulateAdpPicks,
  teamNeed,
  myNeedPriority,
  needWeightFor,
  SKILL_POSITIONS,
  NEED_POSITIONS,
  FLEX_POSITIONS,
  DRAFT_CAPS,
  RISK_LOOKAHEAD_PICKS,
};
