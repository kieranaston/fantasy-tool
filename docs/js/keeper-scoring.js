/**
 * Keeper value model.
 *
 * A keeper costs the round the player was most recently drafted in — or round
 * 10 if they were added off waivers and never drafted. Value is the published
 * FantasyCalc value. Keeper surplus is that value minus the value of the pick
 * you forfeit at the cost round, modelled as the midpoint pick of the round.
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
 * @param {Map} args.costById  Sleeper id → most recent draft round
 * @param {Map} args.valueById  Sleeper id → published value row
 * @param {Map} args.metaById   Sleeper id → {name, position, team} from drafts
 * @param {number} args.teams
 * @param {object} args.curve
 */
function buildKeeperRows({
  rosters = [],
  seasons = [],
  keeperBySeason = {},
  costById = new Map(),
  valueById = new Map(),
  metaById = new Map(),
  teams = 12,
  curve,
}) {
  const rows = [];
  for (const roster of rosters) {
    const rosterId = String(roster.roster_id);
    for (const raw of roster.players || []) {
      const playerId = String(raw || "");
      if (!playerId) continue;
      const info = valueById.get(playerId) || {};
      const meta = metaById.get(playerId) || {};
      const value = Number(info.value) || 0;
      const round = Number(costById.get(playerId) ?? WAIVER_ROUND);
      const cost = pickValueForRound(round, teams, curve);
      const used = keepStreak(playerId, seasons, keeperBySeason);
      rows.push({
        player_id: playerId,
        name: info.player || meta.name || `Player ${playerId}`,
        pos: normalizePos(info.position || meta.position),
        team: info.team || meta.team || "",
        value: info.value != null ? Number(info.value) : null,
        round,
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
  keepStreak,
  buildKeeperRows,
  rankBySurplus,
  eligibleRows,
  expiringRows,
  keepersByTeam,
};
