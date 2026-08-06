/**
 * Draft assistant — one loop, repeated every pick:
 *
 *  1. Baseline: empty starter slots leaguewide → replacement = pts of the
 *     player who would fill the last one.
 *  2. VORP = max(0, pts − baseline[pos]) — never negative.
 *  3. Predict picks before you pick again, using ADP (need-aware).
 *  4. Those predicted picks are "at risk" (won't survive to your next turn),
 *     plus a small buffer past it so ADP-boundary players still count.
 *  5. Score = VORP + NEED_BONUS_K / (slack + 1), where slack is how many of
 *     your remaining picks could go elsewhere before a position can no longer
 *     reach its floor. Slack 0 is a hard override: take that position now.
 *     Rank the one list by score, then at-risk, then low ADP.
 *
 * Roster construction is min/max per position, not named starter slots. RB and
 * WR are one coupled constraint sharing a single budget, so you are choosing a
 * lean between them rather than two independent counts.
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
const NEED_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/**
 * Positions you draft exactly one of. They leave the board once filled.
 * K and DEF have no projections, so they never get recommended — they are
 * listed here only to reserve the roster spots they will consume.
 */
const SINGLE_SLOT_POSITIONS = ["QB", "TE", "K", "DEF"];

/** RB and WR split every pick the single-slot positions don't reserve. */
const RB_WR_FLOOR = 5;
const RB_WR_CAP = 7;

/**
 * How much VORP you'll trade to fix a shortage, sized to a typical gap between
 * tiers. A slack of 1 is then worth about one tier-reach, while comfortable
 * slack decays to noise and lets raw value decide.
 */
const NEED_BONUS_K = 4;

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

/** You get one pick per round, so the roster is as big as the draft is long. */
function rosterSize(settings = {}) {
  return Math.max(1, Number(settings.rounds) || 16);
}

/** Whatever the one-of-each positions don't reserve belongs to RB and WR. */
function rbWrBudget(settings = {}) {
  return Math.max(0, rosterSize(settings) - SINGLE_SLOT_POSITIONS.length);
}

function draftTargets(settings = {}) {
  return {
    total: rosterSize(settings),
    rbWrBudget: rbWrBudget(settings),
    rbWrFloor: RB_WR_FLOOR,
    rbWrCap: RB_WR_CAP,
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
 * Live slack per position: how many of your remaining picks could go somewhere
 * else before this position can no longer reach its floor.
 *
 * RB and WR share one budget, which makes them a single coupled constraint —
 * with a budget of 12 and floors of 5, the only legal endpoints are 5-7, 6-6
 * and 7-5, so spending on one directly squeezes the other. Slack 0 means every
 * pick you have left has to go here, and slack decays to noise when a position
 * is comfortable.
 *
 * Returns slack per position plus the positions that are done (at their max).
 */
function rosterPlan({ counts, settings, myPicksLeft }) {
  const slack = {};
  const done = new Set();

  const budget = rbWrBudget(settings);
  const rb = counts.RB || 0;
  const wr = counts.WR || 0;
  const remaining = budget - rb - wr;

  for (const [pos, count] of [
    ["RB", rb],
    ["WR", wr],
  ]) {
    // Budget spent, or this side is full — the math forces the other side.
    if (remaining <= 0 || count >= RB_WR_CAP) {
      done.add(pos);
      continue;
    }
    slack[pos] = Math.max(0, remaining - Math.max(0, RB_WR_FLOOR - count));
  }

  for (const pos of SINGLE_SLOT_POSITIONS) {
    if ((counts[pos] || 0) >= 1) {
      done.add(pos);
      continue;
    }
    // One pick has to be kept back for this position; the rest are free.
    slack[pos] = Math.max(0, myPicksLeft - 1);
  }

  return { slack, done, rbWrUsed: rb + wr, rbWrBudget: budget };
}

/** Bonus decays as slack grows, so only real shortages move the ranking. */
function needBonusFor(slack) {
  if (!Number.isFinite(slack)) return 0;
  return NEED_BONUS_K / (slack + 1);
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

  const plan = rosterPlan({ counts, settings, myPicksLeft: myPicks.length });

  // Positions still open to you, and of those the ones with no slack left.
  // A forced position overrides value entirely: take it now or miss the floor.
  // K/DEF can be forced but have no projections, so only force what we can
  // actually recommend, otherwise the board would come back empty.
  const openPositions = SKILL_POSITIONS.filter((pos) => !plan.done.has(pos));
  const forced = openPositions.filter(
    (pos) => plan.slack[pos] === 0 && (byPosAtPick[pos] || []).length > 0
  );
  const positions = forced.length ? forced : openPositions;

  const scored = [];
  for (const pos of positions) {
    const baseline = baselines.baselineValue[pos] || 0;
    const slack = plan.slack[pos];
    // Forced picks skip the formula — the override already decided.
    const needBonus = forced.length ? 0 : needBonusFor(slack);

    for (const player of byPosAtPick[pos] || []) {
      const pts = Number(player.pts) || 0;
      // Never rank/display below-replacement as negative — floor at 0.
      const vorp = Math.max(0, pts - baseline);

      scored.push({
        ...player,
        vorp: round1(vorp),
        need_bonus: round1(needBonus),
        slack,
        score: round1(vorp + needBonus),
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

  return {
    targets: draftTargets(settings),
    slack: plan.slack,
    forcedPositions: forced,
    rbWrUsed: plan.rbWrUsed,
    rbWrBudget: plan.rbWrBudget,
    recommendations: scored.slice(0, 12),
  };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

export {
  resolveLeagueSettings,
  rosterPositionCounts,
  draftTargets,
  nextPickNumbers,
  scoreCandidates,
  SKILL_POSITIONS,
};
