/**
 * Keeper Value — Sleeper league → keeper surplus rankings.
 *
 * Walks the league chain (previous_league_id), reads each season's draft picks
 * (keepers are recorded as is_keeper picks at their cost round), and combines
 * them with the published FantasyCalc values to rank keeper candidates by
 * surplus (value − cost round's pick value).
 *
 * Cost round = the round the player was drafted (waiver adds cost round 10),
 * escalated to the next-highest pick the team actually owns in the target
 * season when they lack the cost round.
 */

import { fetchJSON } from "./config.js";
import { escapeHtml } from "./shared.js";
import {
  buildKeeperRows,
  buildValueCurve,
  eligibleRows,
  expiringRows,
  keepersByTeam,
  rankBySurplus,
  resolveBaseRound,
} from "./keeper-scoring.js?v=1";

/** Couper Alum — used when the input is left blank. */
const DEFAULT_LEAGUE_ID = "1388966973332799488";
const LEAGUE_KEY = "ffb_keepers_league";
const TEAM_KEY = "ffb_keepers_team";
const MAX_SEASONS = 6;

async function sleeperGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const response = await fetch(
    `https://api.sleeper.app/v1${path}${sep}_=${Date.now()}`,
    { cache: "no-store" }
  );
  if (!response.ok) throw new Error(`Sleeper ${path}: ${response.status}`);
  return response.json();
}

function parseLeagueId(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fromUrl = text.match(/leagues\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  return /^\d+$/.test(text) ? text : null;
}

function teamLabel(user) {
  return user?.metadata?.team_name || user?.display_name || null;
}

function fmtInt(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}

function signed(value) {
  const n = Math.round(Number(value) || 0);
  return `${n > 0 ? "+" : ""}${n.toLocaleString("en-US")}`;
}

function playerCell(row) {
  const detail = [row.team, row.pos].filter(Boolean).join(" ");
  const chip = detail
    ? ` <span class="player-label-team">${escapeHtml(detail)}</span>`
    : "";
  return `<span class="player-label"><span class="player-label-name">${escapeHtml(
    row.name
  )}</span>${chip}</span>`;
}

function keepLabel(row) {
  return row.escalated
    ? `R${row.base_round}→R${row.round}`
    : `R${row.round}`;
}

/** Fetch the league and every ancestor league (newest → oldest). */
async function loadLeagueChain(leagueId) {
  const chain = [];
  let current = leagueId;
  while (current && chain.length < MAX_SEASONS) {
    const league = await sleeperGet(`/league/${current}`);
    chain.push(league);
    current = league.previous_league_id;
  }
  return chain;
}

/** Every pick from every draft a league held, plus the draft round count. */
async function loadLeagueDrafts(leagueId) {
  const drafts = await sleeperGet(`/league/${leagueId}/drafts`);
  const picks = [];
  let rounds = 0;
  for (const draft of drafts || []) {
    rounds = Math.max(rounds, Number(draft?.settings?.rounds) || 0);
    const rows = await sleeperGet(`/draft/${draft.draft_id}/picks`);
    picks.push(...(rows || []));
  }
  return { picks, rounds };
}

function rangeRounds(rounds) {
  const set = new Set();
  for (let r = 1; r <= rounds; r += 1) set.add(r);
  return set;
}

/** Season → (playerId → round) for drafted and kept picks. */
function buildSeasonMaps(chain, picksBySeason) {
  const seasons = chain.map((league) => String(league.season));
  const draftBySeason = {};
  const keeperBySeason = {};
  const metaById = new Map();
  const draftRoundById = new Map();
  // Oldest → newest so later drafts overwrite earlier ones for a player.
  for (const season of [...seasons].reverse()) {
    const drafted = new Map();
    const keepers = new Map();
    for (const pick of picksBySeason[season] || []) {
      const playerId = pick.player_id ? String(pick.player_id) : "";
      if (!playerId) continue;
      const meta = pick.metadata || {};
      const name = `${meta.first_name || ""} ${meta.last_name || ""}`.trim();
      if (name) {
        metaById.set(playerId, {
          name,
          position: meta.position || "",
          team: meta.team || "",
        });
      }
      const round = Number(pick.round);
      if (!Number.isFinite(round)) continue;
      if (pick.is_keeper) {
        keepers.set(playerId, round);
      } else {
        drafted.set(playerId, round);
        draftRoundById.set(playerId, round);
      }
    }
    draftBySeason[season] = drafted;
    keeperBySeason[season] = keepers;
  }
  return {
    seasons,
    current: seasons[0],
    draftBySeason,
    keeperBySeason,
    keeperRoundCurrent: keeperBySeason[seasons[0]] || new Map(),
    draftRoundById,
    metaById,
  };
}

/** Rounds each roster owns in a season, from defaults plus traded picks. */
function ownedRoundsForSeason(rosters, rounds, tradedPicks, season, userToRoster) {
  const owned = new Map();
  for (const roster of rosters) {
    owned.set(String(roster.roster_id), rangeRounds(rounds));
  }
  for (const pick of tradedPicks || []) {
    if (String(pick.season) !== String(season)) continue;
    const from = String(pick.roster_id);
    let to = String(pick.owner_id);
    if (!owned.has(to) && userToRoster.has(to)) to = userToRoster.get(to);
    const round = Number(pick.round);
    if (!Number.isFinite(round)) continue;
    owned.get(from)?.delete(round);
    if (!owned.has(to)) owned.set(to, new Set());
    owned.get(to).add(round);
  }
  return owned;
}

/** Rounds each roster actually drafted in a season (realized ownership). */
function ownedRoundsFromPicks(picks, rosters, rounds) {
  const owned = new Map();
  for (const roster of rosters) {
    owned.set(String(roster.roster_id), new Set());
  }
  for (const pick of picks || []) {
    const rosterId = String(pick.roster_id);
    const round = Number(pick.round);
    if (!Number.isFinite(round)) continue;
    if (!owned.has(rosterId)) owned.set(rosterId, new Set());
    owned.get(rosterId).add(round);
  }
  for (const [rosterId, set] of owned) {
    if (!set.size) owned.set(rosterId, rangeRounds(rounds));
  }
  return owned;
}

function buildBaseRounds(rosters, maps, currentOwnedByTeam) {
  const baseById = new Map();
  for (const roster of rosters) {
    const owned = currentOwnedByTeam.get(String(roster.roster_id));
    for (const raw of roster.players || []) {
      const playerId = String(raw || "");
      if (!playerId) continue;
      baseById.set(
        playerId,
        resolveBaseRound({
          draftRound: maps.draftRoundById.get(playerId),
          keeperRound: maps.keeperRoundCurrent.get(playerId),
          currentOwned: owned,
        })
      );
    }
  }
  return baseById;
}

function leaderboardHtml(rows, nameByRoster) {
  const thead =
    "<thead><tr><th>#</th><th>Player</th><th>Owner</th>" +
    '<th class="num">Value</th><th>Keep</th><th class="num">Pick value</th>' +
    '<th class="num">Surplus</th><th class="num">Kept</th></tr></thead>';
  const body = rows
    .map((row, i) => {
      const owner = nameByRoster.get(row.roster_id) || `Roster ${row.roster_id}`;
      const kept = row.used > 0 ? `${row.used}y` : "—";
      return (
        `<tr><td class="num">${i + 1}</td>` +
        `<td>${playerCell(row)}</td>` +
        `<td>${escapeHtml(owner)}</td>` +
        `<td class="num">${fmtInt(row.value)}</td>` +
        `<td>${escapeHtml(keepLabel(row))}</td>` +
        `<td class="num">${fmtInt(row.cost)}</td>` +
        `<td class="num">${signed(row.surplus)}</td>` +
        `<td class="num">${kept}</td></tr>`
      );
    })
    .join("");
  return `<table class="draft-table">${thead}<tbody>${body}</tbody></table>`;
}

function byTeamHtml(rosters, nameByRoster, rows) {
  const grouped = keepersByTeam(rows, 2);
  const ordered = [...rosters].sort((a, b) =>
    (nameByRoster.get(String(a.roster_id)) || "").localeCompare(
      nameByRoster.get(String(b.roster_id)) || ""
    )
  );
  const thead =
    "<thead><tr><th>Team</th><th>Player</th><th>Keep</th>" +
    '<th class="num">Value</th><th class="num">Surplus</th></tr></thead>';
  const body = [];
  for (const roster of ordered) {
    const rosterId = String(roster.roster_id);
    const group = grouped.get(rosterId) || { keepers: [], bubble: null };
    const name = nameByRoster.get(rosterId) || `Roster ${rosterId}`;
    const listed = [...group.keepers];
    if (group.bubble) listed.push({ ...group.bubble, _bubble: true });
    if (!listed.length) {
      body.push(
        `<tr><td>${escapeHtml(name)}</td><td colspan="4"><span class="meta">No eligible keepers</span></td></tr>`
      );
      continue;
    }
    listed.forEach((row, idx) => {
      const teamCell =
        idx === 0
          ? `<td rowspan="${listed.length}">${escapeHtml(name)}</td>`
          : "";
      const marker = row._bubble ? ' <span class="meta">(bubble)</span>' : "";
      body.push(
        `<tr${row._bubble ? ' class="keeper-bubble"' : ""}>${teamCell}` +
          `<td>${playerCell(row)}${marker}</td>` +
          `<td>${escapeHtml(keepLabel(row))}</td>` +
          `<td class="num">${fmtInt(row.value)}</td>` +
          `<td class="num">${signed(row.surplus)}</td></tr>`
      );
    });
  }
  return `<table class="draft-table">${thead}<tbody>${body.join("")}</tbody></table>`;
}

function expiringHtml(rows, nameByRoster) {
  const thead =
    "<thead><tr><th>Player</th><th>Owner</th><th>Keep</th>" +
    '<th class="num">Value</th><th>Status</th></tr></thead>';
  const body = rows
    .map((row) => {
      const owner = nameByRoster.get(row.roster_id) || `Roster ${row.roster_id}`;
      return (
        `<tr><td>${playerCell(row)}</td>` +
        `<td>${escapeHtml(owner)}</td>` +
        `<td>${escapeHtml(keepLabel(row))}</td>` +
        `<td class="num">${fmtInt(row.value)}</td>` +
        `<td><span class="meta">2 yrs — back to pool</span></td></tr>`
      );
    })
    .join("");
  return `<table class="draft-table">${thead}<tbody>${body}</tbody></table>`;
}

export async function mountKeepersPage() {
  const input = document.getElementById("keepers-league-input");
  const connectBtn = document.getElementById("keepers-connect");
  const teamSelect = document.getElementById("keepers-team");
  const summaryEl = document.getElementById("keepers-league-summary");
  const statusEl = document.getElementById("keepers-status");
  const resultsEl = document.getElementById("keepers-results");

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg || "";
  };

  let ctx = null;

  const savedLeague = localStorage.getItem(LEAGUE_KEY);
  if (input && savedLeague) input.value = savedLeague;

  function populateTeams() {
    if (!teamSelect || !ctx) return;
    const savedTeam = localStorage.getItem(TEAM_KEY);
    const options = ctx.rosters
      .map((roster) => {
        const label = ctx.nameByRoster.get(String(roster.roster_id));
        return `<option value="${roster.roster_id}">${escapeHtml(
          label || `Roster ${roster.roster_id}`
        )}</option>`;
      })
      .join("");
    teamSelect.innerHTML = `<option value="">All teams</option>${options}`;
    if (savedTeam && ctx.rosters.some((r) => String(r.roster_id) === savedTeam)) {
      teamSelect.value = savedTeam;
    }
    teamSelect.disabled = false;
  }

  function render() {
    if (!ctx || !resultsEl) return;
    const filter = teamSelect?.value || "";
    localStorage.setItem(TEAM_KEY, filter);
    const eligible = rankBySurplus(eligibleRows(ctx.rows));
    const shown = filter
      ? eligible.filter((row) => row.roster_id === filter)
      : eligible;
    const expiring = rankBySurplus(expiringRows(ctx.rows));

    const sections = [];
    sections.push(
      `<section class="draft-panel"><h2 class="draft-section-title">Keeper leaderboard</h2>` +
        `<div class="table-wrap">${
          shown.length
            ? leaderboardHtml(shown, ctx.nameByRoster)
            : '<p class="meta">No eligible keepers for this filter.</p>'
        }</div></section>`
    );
    sections.push(
      `<section class="draft-panel"><h2 class="draft-section-title">Keepers by team</h2>` +
        `<div class="table-wrap">${byTeamHtml(ctx.rosters, ctx.nameByRoster, ctx.rows)}</div></section>`
    );
    if (expiring.length) {
      sections.push(
        `<section class="draft-panel"><h2 class="draft-section-title">Expiring — back to the draft pool</h2>` +
          `<div class="table-wrap">${expiringHtml(expiring, ctx.nameByRoster)}</div></section>`
      );
    }
    resultsEl.innerHTML = sections.join("");
  }

  async function connectLeague() {
    const leagueId = parseLeagueId(input?.value) || DEFAULT_LEAGUE_ID;
    if (input && !input.value) input.value = leagueId;
    setStatus("Loading league…");
    if (connectBtn) connectBtn.disabled = true;
    try {
      const [chain, values, rosters, users, tradedPicks] = await Promise.all([
        loadLeagueChain(leagueId),
        fetchJSON("trade/values.json"),
        sleeperGet(`/league/${leagueId}/rosters`),
        sleeperGet(`/league/${leagueId}/users`),
        sleeperGet(`/league/${leagueId}/traded_picks`),
      ]);
      if (!chain.length) throw new Error("League not found.");

      const picksBySeason = {};
      const roundsBySeason = {};
      await Promise.all(
        chain.map(async (league) => {
          const season = String(league.season);
          const { picks, rounds } = await loadLeagueDrafts(league.league_id);
          picksBySeason[season] = picks;
          roundsBySeason[season] = rounds;
        })
      );

      const rosterList = rosters || [];
      const teams = Math.max(1, rosterList.length);
      const maps = buildSeasonMaps(chain, picksBySeason);
      const rounds =
        Math.max(
          roundsBySeason[maps.current] || 0,
          ...Object.values(roundsBySeason)
        ) || 16;

      const userToRoster = new Map();
      for (const roster of rosterList) {
        if (roster.owner_id) userToRoster.set(String(roster.owner_id), String(roster.roster_id));
      }

      const currentOwned = ownedRoundsFromPicks(
        picksBySeason[maps.current] || [],
        rosterList,
        rounds
      );
      const baseById = buildBaseRounds(rosterList, maps, currentOwned);

      const targetSeason = String(Number(maps.current) + 1);
      const ownedByTeam = ownedRoundsForSeason(
        rosterList,
        rounds,
        tradedPicks,
        targetSeason,
        userToRoster
      );

      const valueById = new Map();
      for (const player of values.players || []) {
        valueById.set(String(player.sleeper_id), player);
      }
      const userById = new Map((users || []).map((u) => [u.user_id, u]));
      const nameByRoster = new Map();
      for (const roster of rosterList) {
        nameByRoster.set(
          String(roster.roster_id),
          teamLabel(userById.get(roster.owner_id)) || `Roster ${roster.roster_id}`
        );
      }

      const curve = buildValueCurve(values.players || []);
      const rows = buildKeeperRows({
        rosters: rosterList,
        seasons: maps.seasons,
        keeperBySeason: maps.keeperBySeason,
        baseById,
        ownedByTeam,
        valueById,
        metaById: maps.metaById,
        teams,
        curve,
      });

      ctx = {
        chain,
        seasons: maps.seasons,
        targetSeason,
        rosters: rosterList,
        nameByRoster,
        rows,
        teams,
      };

      localStorage.setItem(LEAGUE_KEY, leagueId);
      populateTeams();
      if (summaryEl) {
        const league = chain[0];
        summaryEl.hidden = false;
        summaryEl.textContent = `${league.name || "League"} · ${teams}-team · keepers for ${targetSeason} · scanned ${maps.seasons.join(", ")}`;
      }
      render();
      setStatus(`${eligibleRows(ctx.rows).length} eligible keeper candidates`);
    } catch (err) {
      setStatus(err?.message || String(err));
    } finally {
      if (connectBtn) connectBtn.disabled = false;
    }
  }

  if (connectBtn) connectBtn.addEventListener("click", connectLeague);
  if (input) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") connectLeague();
    });
  }
  if (teamSelect) teamSelect.addEventListener("change", render);

  connectLeague();
}
