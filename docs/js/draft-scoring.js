/**
 * Draft assistant — ADP first, with a QB/TE backup multiplier.
 *
 * On the clock:
 *  1. Score = −ADP × M (higher is better). RB/WR always M = 1 (pure ADP).
 *     QB/TE: M = 1 until you have one, then M = 1.5 (treat ADP as 50% later).
 *  2. Risk uses the same score. Each opponent pick is a softmax; M updates
 *     after each team's most likely pick.
 *
 * League roster settings are not used. Scoring format is still detected so
 * the ADP board matches the league.
 *
 * Live picks before you're on the clock come from Sleeper — not simulated here.
 */

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

/** Backup QB/TE are ranked as if their ADP were this times later. */
const QB_TE_BACKUP_M = 1.5;

const ADP_MISSING = 9999;

/**
 * Softmax temperature in score units (1 unit ≈ 1 ADP pick). Smaller → closer
 * to greedy; larger → more ADP noise. 4 means a 3-pick ADP gap is about 2:1
 * and a 10-pick gap is about 12:1, so close players swap but reaches are rare.
 */
const SOFTMAX_TEMPERATURE = 4;

/** Max players in the risk sim pool (ADP ∪ your top recommendations). */
const RISK_POOL_CAP = 80;

/** Scoring formats for daily Sleeper ADP boards under docs/data/draft/. */
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

/** You get one pick per round, so the roster is as big as the draft is long. */
function rosterSize(settings = {}) {
  return Math.max(1, Number(settings.rounds) || 16);
}

function draftTargets(settings = {}) {
  return { total: rosterSize(settings) };
}

function qbTeMultiplier(owned) {
  return Number(owned || 0) >= 1 ? QB_TE_BACKUP_M : 1;
}

/**
 * Per-position multiplier M for ranking / opponent sim. Same M for every
 * available player at that position. RB/WR (and DEF/K) stay 1. QB/TE go to
 * 1.5 after the first copy.
 */
function needCounts(roster) {
  const counts = rosterPositionCounts(roster);
  const need_count = {
    QB: qbTeMultiplier(counts.QB),
    RB: 1,
    WR: 1,
    TE: qbTeMultiplier(counts.TE),
    DEF: 1,
    K: 1,
  };
  return {
    need_count,
    openFlex: 0,
    counts,
  };
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

function needAdpScore(player, need_count) {
  const pos = normalizePos(player.position);
  const m = Number(need_count[pos]);
  const multiplier = Number.isFinite(m) && m > 0 ? m : 1;
  return -adpValue(player) * multiplier;
}

function cloneRosters(rosters, teams) {
  const out = {};
  for (let slot = 1; slot <= teams; slot += 1) {
    out[slot] = [...(rosters[slot] || [])];
  }
  return out;
}

/**
 * P(player taken in [startPick, endPick)) under sequential softmax picks.
 *
 * Same score you rank with: s = −ADP × M. Each opponent converts
 * those scores to pick probabilities (softmax). A player's remaining "still
 * available" mass is reduced by that pick probability, so later teams draft
 * from what's left (without-replacement). Roster need then follows the most
 * likely pick so a team that picks twice does not treat both the same.
 */
function simulateGoneProbabilities({
  startPick,
  endPick,
  teams,
  mySlot,
  settings,
  pool,
  rosters,
  ownerSlotByPick,
}) {
  const n = pool.length;
  const out = new Map();
  for (const player of pool) out.set(playerId(player), 0);
  if (!(endPick > startPick) || !n) return out;

  const mass = new Float64Array(n).fill(1);
  const localRosters = cloneRosters(rosters, teams);
  const invT = 1 / Math.max(1e-9, SOFTMAX_TEMPERATURE);

  for (let pickNo = startPick; pickNo < endPick; pickNo += 1) {
    const slot = ownerSlotAtPick(pickNo, teams, ownerSlotByPick);
    if (slot === mySlot) continue;

    const { need_count } = needCounts(localRosters[slot] || []);
    const scores = new Array(n);
    let maxS = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (mass[i] <= 1e-12) {
        scores[i] = -Infinity;
        continue;
      }
      const s = needAdpScore(pool[i], need_count);
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

/**
 * Opponents draft from ADP value; your board ranks by score. Union both top-N
 * sets so every recommended player gets a risk estimate (≤ RISK_POOL_CAP).
 */
function buildRiskSimPool(sortedAvailable, myNeed, limit = 40) {
  const recCap = Math.max(1, Number(limit) || 40);
  const topByAdp = sortedAvailable.slice(0, recCap);
  const topByScore = sortedAvailable
    .slice()
    .sort((a, b) => {
      const scoreA = needAdpScore(a, myNeed.need_count);
      const scoreB = needAdpScore(b, myNeed.need_count);
      return scoreB - scoreA || adpValue(a) - adpValue(b);
    })
    .slice(0, recCap);

  const seen = new Set();
  const pool = [];
  for (const player of [...topByAdp, ...topByScore]) {
    const id = playerId(player);
    if (seen.has(id)) continue;
    seen.add(id);
    pool.push(player);
    if (pool.length >= RISK_POOL_CAP) break;
  }
  return pool;
}

/** Merge ADP-sorted per-position lists (caller keeps each list sorted). */
function flattenAvailable(availableByPos) {
  const lists = SKILL_POSITIONS.map((pos) => availableByPos[pos] || []);
  const heads = lists.map(() => 0);
  const total = lists.reduce((n, arr) => n + arr.length, 0);
  const out = [];
  while (out.length < total) {
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

function annotateScore(player, need_count, { risk = null } = {}) {
  const pos = normalizePos(player.position);
  const m = Number(need_count[pos]);
  const multiplier = Number.isFinite(m) && m > 0 ? m : 1;
  const adp = adpValue(player);
  const p = risk == null ? null : Number(risk);
  return {
    ...player,
    need_bonus: round1(multiplier),
    need_count: multiplier,
    risk: p == null || !Number.isFinite(p) ? null : Math.round(p * 100) / 100,
    score: round1(-adp * multiplier),
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
  const onClock = myPick === currentPickNo;

  const sortedAvailable = flattenAvailable(availableByPosIn);
  const myNeed = needCounts(myRoster);
  const pool = buildRiskSimPool(sortedAvailable, myNeed, limit);
  const simRosters = cloneRosters(opponentRosters, teams);
  simRosters[mySlot] = [...(myRoster || [])];

  let goneProbById = new Map();
  if (onClock && myPickAfter && myPickAfter > myPick + 1) {
    goneProbById = simulateGoneProbabilities({
      startPick: myPick + 1,
      endPick: myPickAfter,
      teams,
      mySlot,
      settings,
      pool,
      rosters: simRosters,
      ownerSlotByPick,
    });
  }

  const scored = [];
  for (const player of sortedAvailable) {
    const id = playerId(player);
    const risk = goneProbById.has(id) ? goneProbById.get(id) : null;
    scored.push(annotateScore(player, myNeed.need_count, { risk }));
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
    scored,
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
  nextPickNumbers,
  nextOwnedPickNumbers,
  slotForOverallPick,
  scoreCandidates,
  annotateScore,
  formatAdpRoundPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
};
