/**
 * Keeper Value — Sleeper league → keeper surplus rankings.
 *
 * Walks the league chain (previous_league_id), reads each season's draft picks,
 * and combines them with the published FantasyCalc values to rank keeper
 * candidates by surplus (value − cost round's pick value).
 *
 * Cost round = the round the player was most recently drafted in, or round 10
 * if they were added off waivers and never drafted. Players kept two seasons in
 * a row are expiring and return to the draft pool.
 */

import { fetchJSON } from "./config.js";
import { escapeHtml } from "./shared.js";
import {
  buildKeeperRows,
  buildValueCurve,
  eligibleRows,
  expiringRows,
  rankBySurplus,
} from "./keeper-scoring.js?v=3";

/** Couper Alum — used when the input is left blank. */
const DEFAULT_LEAGUE_ID = "1388966973332799488";
const LEAGUE_KEY = "ffb_keepers_league";
const TEAM_KEY = "ffb_keepers_team";
const MAX_SEASONS = 6;
/** Leaderboard cap; the by-team view is not capped. */
const LEADERBOARD_LIMIT = 50;

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

/** Cost cell: the round, plus a warning when the owner lacks that pick. */
function costCell(row) {
  const base = `R${row.round}`;
  if (row.has_pick) return base;
  return (
    `${base} <span class="keeper-warn">no R${row.round} → pays R${row.pay_round}</span>`
  );
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
async function loadLeaguePicks(leagueId) {
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

/** Rounds each roster owns in a season: defaults minus/plus traded picks. */
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

/**
 * Per season: keeper rounds (playerId → round) and, for the whole chain, the
 * most recent round each player was actually drafted in (non-keeper picks).
 */
function buildSeasonMaps(chain, picksBySeason) {
  const seasons = chain.map((league) => String(league.season));
  const keeperBySeason = {};
  const costById = new Map();
  const metaById = new Map();
  // Oldest → newest so later drafts overwrite earlier ones for a player.
  for (const season of [...seasons].reverse()) {
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
      if (pick.is_keeper) keepers.set(playerId, round);
      else costById.set(playerId, round);
    }
    keeperBySeason[season] = keepers;
  }
  return { seasons, keeperBySeason, costById, metaById };
}

function leaderboardHtml(rows, nameByRoster) {
  const thead =
    "<thead><tr><th>#</th><th>Player</th><th>Owner</th>" +
    '<th class="num">Value</th><th>Cost</th><th class="num">Pick value</th>' +
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
        `<td>${costCell(row)}</td>` +
        `<td class="num">${fmtInt(row.cost)}</td>` +
        `<td class="num">${signed(row.surplus)}</td>` +
        `<td class="num">${kept}</td></tr>`
      );
    })
    .join("");
  return `<table class="draft-table">${thead}<tbody>${body}</tbody></table>`;
}

function byTeamHtml(rosters, nameByRoster, rows, filter = "") {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.roster_id)) grouped.set(row.roster_id, []);
    grouped.get(row.roster_id).push(row);
  }
  const ordered = [...rosters]
    .filter((roster) => !filter || String(roster.roster_id) === filter)
    .sort((a, b) =>
      (nameByRoster.get(String(a.roster_id)) || "").localeCompare(
        nameByRoster.get(String(b.roster_id)) || ""
      )
    );
  const thead =
    "<thead><tr><th>Team</th><th>Player</th><th>Cost</th>" +
    '<th class="num">Value</th><th class="num">Surplus</th></tr></thead>';
  const body = [];
  for (const roster of ordered) {
    const rosterId = String(roster.roster_id);
    const name = nameByRoster.get(rosterId) || `Roster ${rosterId}`;
    const eligible = rankBySurplus(eligibleRows(grouped.get(rosterId) || []));
    if (!eligible.length) {
      body.push(
        `<tr><td>${escapeHtml(name)}</td><td colspan="4"><span class="meta">No eligible keepers</span></td></tr>`
      );
      continue;
    }
    // The two keep slots, then everything else as alternates (unrestricted).
    const keepers = eligible.slice(0, 2);
    const alternates = eligible.slice(2);
    const total = keepers.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
    const span = eligible.length + (alternates.length ? 1 : 0);
    const teamCell =
      `<td rowspan="${span}">${escapeHtml(name)}` +
      `<div class="meta">Total value ${fmtInt(total)}</div></td>`;
    const cells = [];
    eligible.forEach((row, idx) => {
      if (idx === 2 && alternates.length) {
        cells.push(
          `<tr class="keeper-divider"><td colspan="4"><span class="meta">Alternates</span></td></tr>`
        );
      }
      cells.push(
        `<tr>${idx === 0 ? teamCell : ""}` +
          `<td>${playerCell(row)}</td>` +
          `<td>${costCell(row)}</td>` +
          `<td class="num">${fmtInt(row.value)}</td>` +
          `<td class="num">${signed(row.surplus)}</td></tr>`
      );
    });
    body.push(...cells);
  }
  return `<table class="draft-table">${thead}<tbody>${body.join("")}</tbody></table>`;
}

function expiringHtml(rows, nameByRoster) {
  const thead =
    "<thead><tr><th>Player</th><th>Owner</th><th>Cost</th>" +
    '<th class="num">Value</th><th>Status</th></tr></thead>';
  const body = rows
    .map((row) => {
      const owner = nameByRoster.get(row.roster_id) || `Roster ${row.roster_id}`;
      return (
        `<tr><td>${playerCell(row)}</td>` +
        `<td>${escapeHtml(owner)}</td>` +
        `<td>${costCell(row)}</td>` +
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

  const VIEWS = [
    { key: "leaderboard", label: "Leaderboard" },
    { key: "team", label: "By team" },
    { key: "expiring", label: "Expiring" },
  ];
  let activeView = "leaderboard";

  function render() {
    if (!ctx || !resultsEl) return;
    const filter = teamSelect?.value || "";
    localStorage.setItem(TEAM_KEY, filter);

    const eligible = rankBySurplus(eligibleRows(ctx.rows));
    const shown = filter
      ? eligible.filter((row) => row.roster_id === filter)
      : eligible;
    const leaderboard = shown.slice(0, LEADERBOARD_LIMIT);
    const expiring = rankBySurplus(expiringRows(ctx.rows)).filter(
      (row) => !filter || row.roster_id === filter
    );

    const tabs = `<div class="toolbar-pills keeper-tabs" role="tablist">${VIEWS.map(
      (view) =>
        `<button type="button" class="adp-tab${
          activeView === view.key ? " is-active" : ""
        }" data-view="${view.key}" role="tab" aria-selected="${
          activeView === view.key
        }">${view.label}</button>`
    ).join("")}</div>`;

    const panels = {
      leaderboard: shown.length
        ? leaderboardHtml(leaderboard, ctx.nameByRoster) +
          (shown.length > leaderboard.length
            ? `<p class="meta">Showing top ${leaderboard.length} of ${shown.length}.</p>`
            : "")
        : '<p class="meta">No eligible keepers for this filter.</p>',
      team: byTeamHtml(ctx.rosters, ctx.nameByRoster, ctx.rows, filter),
      expiring: expiring.length
        ? expiringHtml(expiring, ctx.nameByRoster)
        : '<p class="meta">No expiring keepers.</p>',
    };

    resultsEl.innerHTML =
      tabs +
      VIEWS.map(
        (view) =>
          `<div class="keeper-panel" role="tabpanel" data-view-panel="${view.key}"${
            activeView === view.key ? "" : " hidden"
          }><div class="table-wrap">${panels[view.key]}</div></div>`
      ).join("");
  }

  if (resultsEl) {
    resultsEl.addEventListener("click", (event) => {
      const btn = event.target.closest?.(".adp-tab[data-view]");
      if (!btn || !ctx) return;
      activeView = btn.dataset.view;
      render();
    });
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
          const { picks, rounds } = await loadLeaguePicks(league.league_id);
          picksBySeason[season] = picks;
          roundsBySeason[season] = rounds;
        })
      );

      const rosterList = rosters || [];
      const teams = Math.max(1, rosterList.length);
      const maps = buildSeasonMaps(chain, picksBySeason);
      const rounds = Math.max(...Object.values(roundsBySeason), 0) || 16;
      const current = Number(maps.seasons[0]);
      const targetSeason = String(current + 1);
      const userToRoster = new Map();
      for (const roster of rosterList) {
        if (roster.owner_id) {
          userToRoster.set(String(roster.owner_id), String(roster.roster_id));
        }
      }
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
        costById: maps.costById,
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
        summaryEl.textContent = `${league.name || "League"} · ${teams}-team · keepers for ${ctx.targetSeason} · scanned ${maps.seasons.join(", ")}`;
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
