/**
 * Trade recommender — pure model.
 *
 * Value is crowdsourced trade value (FantasyCalc), not scoring projections and
 * not a manufactured rank curve — the source already carries real magnitude.
 *
 *  1. Value: V(player) is the FantasyCalc value directly. K/DEF are ignored.
 *  2. Positional VORP = V(player) − V(replacement at that position), where
 *     replacement rank = teams × starters (+ flex share) from roster_positions.
 *  3. Team profile: optimal lineup assignment → lineup VORP, plus per-position
 *     depth VORP decayed by d^k (concave → rewards breadth, penalises hoarding).
 *  4. Surplus/deficit per position vs the league median → targeting vector.
 *  5. Recommendations: value-bucketed, need-first bundles. Both sides gain
 *     (win-win), and raw values roughly balance.
 */

const POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];

/** Depth decay per extra body at a position (1, d, d², …). */
const DEPTH_DECAY = 0.6;

/** Depth share of the team composite (fixed; no pressure component). */
const DEPTH_WEIGHT_BASE = 0.4;

/** Fairness floor: outgoing raw value must be at least this fraction of incoming. */
const PARITY_MIN = 0.75;

/** Largest bundle (player count) considered on either side of a trade. */
const MAX_BUNDLE = 3;

/** Partner must gain at least this multiple of your gain (realism gate). */
const MIN_PARTNER_RATIO = 0.7;

/** Partner must gain less than this multiple of your gain — you still gain more. */
const MAX_PARTNER_RATIO = 1.0;

/** Max difference in player count between the two sides (blocks 3-for-1). */
const MAX_SIZE_DIFF = 1;

const FLEX_ELIGIBLE = {
  FLEX: ["RB", "WR", "TE"],
  "W/R/T": ["RB", "WR", "TE"],
  WRRBTE: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  "W/R": ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  "W/T": ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  "Q/W/R/T": ["QB", "RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
};

/**
 * How a flex slot's starter demand spreads across eligible positions. Real
 * flex usage leans RB/WR, so FLEX is 40/40/20 rather than an even 1/3 split.
 */
const FLEX_WEIGHTS = {
  FLEX: { RB: 0.4, WR: 0.4, TE: 0.2 },
  "W/R/T": { RB: 0.4, WR: 0.4, TE: 0.2 },
  WRRBTE: { RB: 0.4, WR: 0.4, TE: 0.2 },
  WRRB_FLEX: { RB: 0.5, WR: 0.5 },
  "W/R": { RB: 0.5, WR: 0.5 },
  REC_FLEX: { WR: 0.6, TE: 0.4 },
  "W/T": { WR: 0.6, TE: 0.4 },
  SUPER_FLEX: { QB: 0.45, RB: 0.2, WR: 0.2, TE: 0.15 },
  "Q/W/R/T": { QB: 0.45, RB: 0.2, WR: 0.2, TE: 0.15 },
  SUPERFLEX: { QB: 0.45, RB: 0.2, WR: 0.2, TE: 0.15 },
};

function equalWeights(positions) {
  const w = {};
  for (const pos of positions) w[pos] = 1 / Math.max(1, positions.length);
  return w;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function median(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** All subsets of `items` from size 1 up to `cap` (order preserved). */
function subsetsUpTo(items, cap) {
  const out = [];
  const walk = (start, picked) => {
    if (picked.length) out.push([...picked]);
    if (picked.length >= cap) return;
    for (let i = start; i < items.length; i += 1) {
      picked.push(items[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

function normalizePos(position) {
  let pos = String(position || "").toUpperCase();
  if (pos === "DST") pos = "DEF";
  if (pos === "PK") pos = "K";
  return pos;
}

function playerIdOf(player) {
  return String(player?.sleeper_id ?? player?.player_id ?? "").trim();
}

/** roster_positions → mandatory counts per position plus flex slot eligibility. */
function resolveSlots(rosterPositions = []) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
  const flexSlots = [];
  for (const raw of rosterPositions) {
    const slot = String(raw || "").toUpperCase();
    if (slot in counts) {
      counts[slot] += 1;
    } else if (slot in FLEX_ELIGIBLE) {
      const eligible = FLEX_ELIGIBLE[slot];
      flexSlots.push({
        eligible,
        weights: FLEX_WEIGHTS[slot] || equalWeights(eligible),
      });
    } else if (slot === "D/ST") {
      counts.DEF += 1;
    }
  }
  return { counts, flexSlots };
}

/**
 * Replacement rank per position: teams × starters plus the flex share
 * (each flex slot contributes 1/n to each eligible position).
 */
function replacementRanks(slots, teams) {
  const t = Math.max(1, Number(teams) || 1);
  const flexShare = {};
  for (const pos of POSITIONS) flexShare[pos] = 0;
  for (const slot of slots.flexSlots) {
    const entries = Object.entries(slot.weights || {});
    const total = entries.reduce((sum, [, w]) => sum + w, 0) || 1;
    for (const [pos, weight] of entries) {
      flexShare[pos] = (flexShare[pos] || 0) + (t * weight) / total;
    }
  }
  const out = {};
  for (const pos of POSITIONS) {
    const startSlots = (slots.counts[pos] || 0) * t;
    out[pos] = Math.max(1, Math.ceil(startSlots + flexShare[pos]));
  }
  return out;
}

/**
 * Build the value model from FantasyCalc rows (needs `sleeper_id`, `value`,
 * `position`, `pos_rank`). `valueOf` reads a row's value; `replacementValue`
 * looks up the player at the league's replacement rank for a position.
 */
function buildValueModel(fcPlayers = []) {
  const byId = new Map();
  const byPosRank = new Map();
  for (const p of fcPlayers) {
    const id = playerIdOf(p);
    if (id) byId.set(id, p);
    const pos = normalizePos(p.position);
    const pr = Number(p.pos_rank);
    if (pos && Number.isFinite(pr)) {
      if (!byPosRank.has(pos)) byPosRank.set(pos, new Map());
      byPosRank.get(pos).set(pr, p);
    }
  }

  function valueOf(player) {
    if (player && Number.isFinite(Number(player.value))) {
      return Number(player.value);
    }
    const match = byId.get(playerIdOf(player));
    return match && Number.isFinite(Number(match.value))
      ? Number(match.value)
      : 0;
  }

  function replacementValue(pos, rank) {
    const table = byPosRank.get(pos);
    if (!table || !table.size) return 0;
    if (table.has(rank)) return valueOf(table.get(rank));
    const maxRank = Math.max(...table.keys());
    return valueOf(table.get(maxRank)) * Math.pow(0.85, Math.max(0, rank - maxRank));
  }

  return { valueOf, replacementValue, byId, byPosRank };
}

/** Replacement value per position for a league. */
function replacementValues(model, slots, teams) {
  const ranks = replacementRanks(slots, teams);
  const out = {};
  for (const pos of POSITIONS) out[pos] = model.replacementValue(pos, ranks[pos]);
  return out;
}

/**
 * Assign the optimal starting lineup: mandatory slots first, then flex slots
 * in order, greedily by value. Returns starters/bench and per-position sums.
 */
function assignLineup(players, counts, flexSlots) {
  const byPos = {};
  for (const pos of POSITIONS) byPos[pos] = [];
  for (const p of players) {
    if (byPos[p.pos]) byPos[p.pos].push(p);
  }

  const starterIds = new Set();
  const starterValueByPos = {};
  const starterVorpByPos = {};
  for (const pos of POSITIONS) {
    starterValueByPos[pos] = 0;
    starterVorpByPos[pos] = 0;
  }

  for (const pos of POSITIONS) {
    const need = counts[pos] || 0;
    const sorted = [...byPos[pos]].sort((a, b) => b.value - a.value);
    for (let i = 0; i < need && i < sorted.length; i += 1) {
      const p = sorted[i];
      starterIds.add(playerIdOf(p));
      starterValueByPos[pos] += p.value;
      starterVorpByPos[pos] += p.vorp;
    }
  }

  for (const slot of flexSlots) {
    const pool = players
      .filter((p) => !starterIds.has(playerIdOf(p)) && slot.eligible.includes(p.pos))
      .sort((a, b) => b.value - a.value);
    if (!pool.length) continue;
    const p = pool[0];
    starterIds.add(playerIdOf(p));
    starterValueByPos[p.pos] += p.value;
    starterVorpByPos[p.pos] += p.vorp;
  }

  const starters = players.filter((p) => starterIds.has(playerIdOf(p)));
  const bench = players.filter((p) => !starterIds.has(playerIdOf(p)));
  return { starterIds, starters, bench, starterValueByPos, starterVorpByPos };
}

/** Concave depth value per position: positive bench VORP decayed by d^k. */
function depthValueByPos(bench, decay = DEPTH_DECAY) {
  const byPos = {};
  for (const pos of POSITIONS) byPos[pos] = [];
  for (const p of bench) {
    if (byPos[p.pos] && p.vorp > 0) byPos[p.pos].push(p.vorp);
  }
  const out = {};
  for (const pos of POSITIONS) {
    const values = byPos[pos].sort((a, b) => b - a);
    let sum = 0;
    values.forEach((v, k) => {
      sum += v * Math.pow(decay, k);
    });
    out[pos] = sum;
  }
  return out;
}

/** Decorate a roster's players with value/VORP (trade-independent). */
function decorateRoster(roster, playerMeta, replacementByPos, model) {
  const players = [];
  for (const id of roster?.players || []) {
    const meta = playerMeta.get(String(id));
    if (!meta) continue;
    const pos = normalizePos(meta.position);
    const value = model.valueOf(meta);
    const vorp = pos ? value - (replacementByPos[pos] || 0) : 0;
    players.push({
      sleeper_id: playerIdOf(meta) || String(id),
      name: meta.player || meta.name || "",
      pos,
      value,
      vorp,
    });
  }
  return players;
}

/** Lineup + depth for an already-decorated player list. */
function buildTeamProfileFromPlayers(players, slots, decay = DEPTH_DECAY) {
  const lineup = assignLineup(players, slots.counts, slots.flexSlots);
  const depthByPos = depthValueByPos(lineup.bench, decay);
  const lineupValue = lineup.starters.reduce((sum, p) => sum + p.vorp, 0);
  const depthValue = POSITIONS.reduce((sum, pos) => sum + depthByPos[pos], 0);
  return { players, lineup, depthByPos, lineupValue, depthValue };
}

/** Decorate then evaluate one roster (convenience wrapper). */
function buildTeamProfile({
  roster,
  playerMeta,
  slots,
  replacementByPos,
  model,
  decay = DEPTH_DECAY,
}) {
  const players = decorateRoster(roster, playerMeta, replacementByPos, model);
  return buildTeamProfileFromPlayers(players, slots, decay);
}

/** Swap decorated players: drop `sendIds`, append each of `recvIds`. */
function swapPlayers(players, sendIds, recvIds, decoratedById) {
  const send = new Set(sendIds);
  const out = players.filter((p) => !send.has(p.sleeper_id));
  for (const rid of recvIds) {
    const p = decoratedById.get(String(rid));
    if (p) out.push(p);
  }
  return out;
}

/** Team composite = (1−wDepth)·lineupVORP + wDepth·depthVORP. */
function compositeFor(profile, opts = {}) {
  const wDepth = opts.depthWeight ?? DEPTH_WEIGHT_BASE;
  return (1 - wDepth) * profile.lineupValue + wDepth * profile.depthValue;
}

/** Per-position strength = starter VORP + depth VORP. */
function positionStrength(profile) {
  const out = {};
  for (const pos of POSITIONS) {
    out[pos] =
      (profile.lineup.starterVorpByPos[pos] || 0) + (profile.depthByPos[pos] || 0);
  }
  return out;
}

/** Surplus (+) / deficit (−) per position vs the league median. */
function surplusDeficit(profilesByTeam) {
  const strengths = new Map();
  for (const [id, profile] of profilesByTeam) {
    strengths.set(id, positionStrength(profile));
  }
  const medians = {};
  for (const pos of POSITIONS) {
    medians[pos] = median([...strengths.values()].map((s) => s[pos]));
  }
  const vectors = new Map();
  for (const [id, strength] of strengths) {
    const vector = {};
    for (const pos of POSITIONS) vector[pos] = strength[pos] - medians[pos];
    vectors.set(id, vector);
  }
  return { medians, vectors };
}

/** Anti-correlation of two surplus/deficit vectors: A's surplus × B's deficit. */
function compatibility(vectorA, vectorB) {
  let score = 0;
  for (const pos of POSITIONS) {
    score += Math.max(0, vectorA[pos]) * Math.max(0, -vectorB[pos]);
    score += Math.max(0, vectorB[pos]) * Math.max(0, -vectorA[pos]);
  }
  return score;
}

function bundleValue(bundle) {
  return bundle.reduce((sum, p) => sum + (p.value || 0), 0);
}

function bundleVorp(bundle) {
  return bundle.reduce((sum, p) => sum + (p.vorp || 0), 0);
}

function describeBundle(bundle) {
  return bundle.map((p) => ({
    sleeper_id: p.sleeper_id,
    name: p.name,
    pos: p.pos,
    value: p.value,
    vorp: p.vorp,
  }));
}

/**
 * Recommendations for `myTeamId`: value-bucketed, need-first bundles.
 *
 * Both sides may send 1..maxBundle pieces (bench depth or anyone at a surplus
 * position). Bundles are paired only when raw values are within `valueWindow`
 * (cheap pruning), then re-scored on optimal lineups: keep when my composite
 * rises and the partner's loss stays within a fraction of the trade's own VORP
 * size.
 */
function recommendTrades({
  myTeamId,
  rosters = [],
  playerMeta,
  model,
  slots,
  replacementByPos,
  limit = 12,
  parityMin = PARITY_MIN,
  maxBundle = MAX_BUNDLE,
  minPartnerRatio = MIN_PARTNER_RATIO,
  maxPartnerRatio = MAX_PARTNER_RATIO,
  maxSizeDiff = MAX_SIZE_DIFF,
  valueWindow = 1.5,
} = {}) {
  const id = String(myTeamId);
  const decoratedById = new Map();
  const basePlayers = new Map();
  const profiles = new Map();
  for (const roster of rosters) {
    const rid = String(roster.roster_id);
    const players = decorateRoster(roster, playerMeta, replacementByPos, model);
    basePlayers.set(rid, players);
    for (const p of players) decoratedById.set(p.sleeper_id, p);
    profiles.set(rid, buildTeamProfileFromPlayers(players, slots));
  }
  const me = profiles.get(id);
  if (!me) return [];
  const myPlayers = basePlayers.get(id);
  const { vectors } = surplusDeficit(profiles);
  const myVector = vectors.get(id) || {};
  const myBefore = compositeFor(me);

  const results = [];
  for (const partner of rosters) {
    const partnerId = String(partner.roster_id);
    if (partnerId === id) continue;
    const partnerVector = vectors.get(partnerId) || {};
    const partnerProfile = profiles.get(partnerId);
    if (!partnerProfile) continue;
    const partnerPlayers = basePlayers.get(partnerId);

    const myBench = new Set(me.lineup.bench.map((p) => p.sleeper_id));
    const theirBench = new Set(partnerProfile.lineup.bench.map((p) => p.sleeper_id));
    const chips = me.players.filter(
      (p) => p.vorp > 0 && (myBench.has(p.sleeper_id) || myVector[p.pos] > 0)
    );
    const targets = partnerProfile.players.filter(
      (p) =>
        p.vorp > 0 &&
        (theirBench.has(p.sleeper_id) || partnerVector[p.pos] > 0)
    );
    if (!chips.length || !targets.length) continue;

    const partnerBefore = compositeFor(partnerProfile);
    const sendBundles = subsetsUpTo(chips, maxBundle).map((b) => ({
      b,
      v: bundleValue(b),
    }));
    const recvBundles = subsetsUpTo(targets, maxBundle)
      .map((b) => ({ b, v: bundleValue(b) }))
      .sort((a, z) => a.v - z.v);

    for (const send of sendBundles) {
      const sendIds = send.b.map((p) => p.sleeper_id);
      const lo = send.v / valueWindow;
      const hi = send.v * valueWindow;

      for (const recv of recvBundles) {
        if (recv.v < lo) continue;
        if (recv.v > hi) break;
        if (send.v < parityMin * recv.v) continue;
        const recvIds = recv.b.map((p) => p.sleeper_id);
        if (recvIds.some((rid) => sendIds.includes(rid))) continue;
        if (Math.abs(send.b.length - recv.b.length) > maxSizeDiff) continue;

        const myAfter = buildTeamProfileFromPlayers(
          swapPlayers(myPlayers, sendIds, recvIds, decoratedById),
          slots
        );
        const partnerAfter = buildTeamProfileFromPlayers(
          swapPlayers(partnerPlayers, recvIds, sendIds, decoratedById),
          slots
        );
        const myDelta = compositeFor(myAfter) - myBefore;
        const partnerDelta = compositeFor(partnerAfter) - partnerBefore;
        const dealVorp = Math.abs(bundleVorp(send.b)) + Math.abs(bundleVorp(recv.b));
        if (myDelta <= 0 || partnerDelta <= 0) continue;
        if (partnerDelta < minPartnerRatio * myDelta) continue;
        if (partnerDelta >= maxPartnerRatio * myDelta) continue;

        results.push({
          partnerId,
          send: describeBundle(send.b),
          receive: describeBundle(recv.b),
          my_delta: myDelta,
          partner_delta: partnerDelta,
          deal_vorp: dealVorp,
        });
      }
    }
  }

  results.sort((a, b) => b.my_delta - a.my_delta);
  return results.slice(0, Math.max(1, limit));
}

export {
  POSITIONS,
  DEPTH_DECAY,
  DEPTH_WEIGHT_BASE,
  PARITY_MIN,
  MAX_BUNDLE,
  MIN_PARTNER_RATIO,
  MAX_PARTNER_RATIO,
  MAX_SIZE_DIFF,
  clamp,
  median,
  normalizePos,
  playerIdOf,
  resolveSlots,
  replacementRanks,
  buildValueModel,
  replacementValues,
  assignLineup,
  depthValueByPos,
  buildTeamProfile,
  compositeFor,
  positionStrength,
  surplusDeficit,
  compatibility,
  recommendTrades,
};
