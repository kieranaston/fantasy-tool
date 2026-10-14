/**
 * Keeper value model.
 *
 * A keeper costs the draft round the player was acquired in — the round they
 * were drafted, or round 10 if they were added off waivers. Value is the
 * published FantasyCalc value. Keeper surplus is that value minus the value of
 * the pick you forfeit at the cost round, modelled as the midpoint pick of the
 * round.
 *
 * Two wrinkles the model handles:
 *  - Pick availability: if the team does not own a pick in the cost round, it
 *    pays with the next-highest pick it does own (a 7th-round cost becomes a
 *    6th). Applied per team using that season's pick ownership.
 *  - Waiver resets: a recorded keeper round that disagrees with the player's
 *    draft round + escalation means they were dropped and re-signed, so the
 *    cost resets to the waiver round.
 *
 * Players kept two seasons in a row are expiring: they cannot be kept again and
 * return to the draft pool.
 */

const WAIVER_ROUND = 10;
const MAX_KEEP_YEARS = 2;

function normalizePos(position) {
  let pos = String(position || "").toUpperCase();
  if (pos === "DST") pos = "DEF";
  if (pos === "PK") pos = "K";
  return pos;
}

/** Overall-rank → value curve from published FantasyCalc rows. */
function buildValueCurve(players = []) {
  const ranked = players
    .filter((p) => Number.isFinite(Number(p.rank)) && Number(p.rank) > 0)
    .sort((a, b) => Number(a.rank) - Number(b.rank));
  const values = ranked.map((p) => Number(p.value) || 0);
  return {
    size: values.length,
    valueAtRank(rank) {
      const r = Math.round(Number(rank));
      if (!Number.isFinite(r) || r < 1 || r > values.length) return 0;
      return values[r - 1];
    },
  };
}

/** FantasyCalc value of the midpoint pick of a round (snake, `teams` wide). */
function pickValueForRound(round, teams, curve) {
  const t = Math.max(1, Number(teams) || 12);
  const r = Math.max(1, Number(round) || 1);
  const midpoint = (r - 1) * t + (t + 1) / 2;
  return curve.valueAtRank(midpoint);
}

/** If the round's pick is not owned, pay the next-highest owned pick. */
function escalateRound(round, owned) {
  const r = Math.max(1, Math.round(Number(round) || 1));
  if (!owned || owned.has(r)) return r;
  let best = null;
  for (const o of owned) {
    if (o < r && (best === null || o > best)) best = o;
  }
  return best ?? r;
}

/**
 * Base acquisition round before pick-availability escalation.
 *
 * Uses the original draft round (waiver → R10). When a recorded keeper round
 * disagrees with draft + escalation, the player was re-signed off waivers, so
 * the recorded round wins.
 */
function resolveBaseRound({ draftRound, keeperRound, currentOwned }) {
  const draft = Number.isFinite(Number(draftRound)) ? Number(draftRound) : null;
  const kept = Number.isFinite(Number(keeperRound)) ? Number(keeperRound) : null;
  if (kept == null) return draft ?? WAIVER_ROUND;
  const origin = draft ?? WAIVER_ROUND;
  const expected = escalateRound(origin, currentOwned);
  return kept === expected ? origin : kept;
}

/** Consecutive seasons (ending at the current season) a player was kept. */
function keepStreak(playerId, seasons, keeperBySeason) {
  let years = 0;
  for (const season of seasons) {
    if (keeperBySeason[season]?.has(playerId)) years += 1;
    else break;
  }
  return years;
}

/**
 * One row per rostered player across all rosters.
 *
 * @param {object} args
 * @param {Array} args.rosters  Sleeper rosters ({roster_id, players:[ids]})
 * @param {string[]} args.seasons  Seasons newest → oldest
 * @param {Object<string,Map>} args.keeperBySeason  season → (playerId → round)
 * @param {Map} args.baseById  Sleeper id → base acquisition round
 * @param {Map} args.ownedByTeam  roster id → Set of owned rounds (target season)
 * @param {Map} args.valueById  Sleeper id → published value row
 * @param {Map} args.metaById   Sleeper id → {name, position, team} from drafts
 * @param {number} args.teams
 * @param {object} args.curve
 */
function buildKeeperRows({
  rosters = [],
  seasons = [],
  keeperBySeason = {},
  baseById = new Map(),
  ownedByTeam = new Map(),
  valueById = new Map(),
  metaById = new Map(),
  teams = 12,
  curve,
}) {
  const rows = [];
  for (const roster of rosters) {
    const rosterId = String(roster.roster_id);
    const owned = ownedByTeam.get(rosterId);
    for (const raw of roster.players || []) {
      const playerId = String(raw || "");
      if (!playerId) continue;
      const info = valueById.get(playerId) || {};
      const meta = metaById.get(playerId) || {};
      const value = Number(info.value) || 0;
      const base = Number(baseById.get(playerId) ?? WAIVER_ROUND);
      const round = escalateRound(base, owned);
      const cost = pickValueForRound(round, teams, curve);
      const used = keepStreak(playerId, seasons, keeperBySeason);
      rows.push({
        player_id: playerId,
        name: info.player || meta.name || `Player ${playerId}`,
        pos: normalizePos(info.position || meta.position),
        team: info.team || meta.team || "",
        value: info.value != null ? Number(info.value) : null,
        base_round: base,
        round,
        escalated: round !== base,
        cost: Math.round(cost),
        surplus: Math.round(value - cost),
        used,
        expiring: used >= MAX_KEEP_YEARS,
        roster_id: rosterId,
      });
    }
  }
  return rows;
}

/** Eligible rows (not expiring) sorted by surplus, best first. */
function rankBySurplus(rows = []) {
  return [...rows].sort(
    (a, b) => b.surplus - a.surplus || a.name.localeCompare(b.name)
  );
}

function eligibleRows(rows = []) {
  return rows.filter((row) => !row.expiring);
}

function expiringRows(rows = []) {
  return rows.filter((row) => row.expiring);
}

/** Per roster: best ``perTeam`` keepers plus the first one left out. */
function keepersByTeam(rows = [], perTeam = 2) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.roster_id)) grouped.set(row.roster_id, []);
    grouped.get(row.roster_id).push(row);
  }
  const out = new Map();
  for (const [rosterId, list] of grouped) {
    const ranked = rankBySurplus(eligibleRows(list));
    out.set(rosterId, {
      keepers: ranked.slice(0, perTeam),
      bubble: ranked[perTeam] || null,
      expiring: rankBySurplus(expiringRows(list)),
    });
  }
  return out;
}

export {
  WAIVER_ROUND,
  MAX_KEEP_YEARS,
  normalizePos,
  buildValueCurve,
  pickValueForRound,
  escalateRound,
  resolveBaseRound,
  keepStreak,
  buildKeeperRows,
  rankBySurplus,
  eligibleRows,
  expiringRows,
  keepersByTeam,
};
