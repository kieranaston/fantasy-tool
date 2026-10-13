/**
 * Trade Recommender — Sleeper league → win-win trade suggestions.
 *
 * Fetches league/rosters/users plus the published FantasyCalc values, builds
 * each team's value profile, and lists trades where both sides gain.
 */

import { fetchJSON } from "./config.js";
import { escapeHtml } from "./shared.js";
import {
  buildTeamProfile,
  buildValueModel,
  compositeFor,
  recommendTrades,
  replacementValues,
  resolveSlots,
} from "./trade-scoring.js?v=3";

const LEAGUE_KEY = "ffb_trade_league";
const TEAM_KEY = "ffb_trade_team";
const SCORING_TYPE_LABELS = { 0: "1QB", 1: "Superflex", 2: "2QB" };

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

function signed(value) {
  const n = Math.round(Number(value) || 0);
  return `${n > 0 ? "+" : ""}${n}`;
}

function playerInline(player) {
  return `${escapeHtml(player.name)} <span class="player-label-team">${escapeHtml(player.pos)}</span>`;
}

function resultsHtml(recs, nameByRoster) {
  const thead =
    '<thead><tr><th>Partner</th><th>You send</th><th>You get</th>' +
    '<th class="num">You</th><th class="num">Them</th></tr></thead>';
  const body = recs
    .map((rec) => {
      const send = rec.send.map(playerInline).join(", ");
      const recv = rec.receive.map(playerInline).join(", ");
      const partner = nameByRoster.get(rec.partnerId) || rec.partnerId;
      return (
        `<tr><td>${escapeHtml(partner)}</td><td>${send}</td><td>${recv}</td>` +
        `<td class="num">${signed(rec.my_delta)}</td>` +
        `<td class="num">${signed(rec.partner_delta)}</td></tr>`
      );
    })
    .join("");
  return `<table class="draft-table">${thead}<tbody>${body}</tbody></table>`;
}

export async function mountTradePage() {
  const input = document.getElementById("trade-league-input");
  const connectBtn = document.getElementById("trade-connect");
  const teamSelect = document.getElementById("trade-team");
  const summaryEl = document.getElementById("trade-league-summary");
  const statusEl = document.getElementById("trade-status");
  const resultsEl = document.getElementById("trade-results");

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg || "";
  };

  let ctx = null;

  const savedLeague = localStorage.getItem(LEAGUE_KEY);
  if (savedLeague && input) input.value = savedLeague;

  function computeContext(league, rosters, users, values) {
    const model = buildValueModel(values.players || []);
    const slots = resolveSlots(league.roster_positions || []);
    const teams = Math.max(1, rosters.length);
    const replacementByPos = replacementValues(model, slots, teams);
    const playerMeta = new Map();
    for (const player of values.players || []) {
      playerMeta.set(String(player.sleeper_id), player);
    }
    const userById = new Map((users || []).map((u) => [u.user_id, u]));
    const nameByRoster = new Map();
    for (const roster of rosters) {
      const label = teamLabel(userById.get(roster.owner_id));
      nameByRoster.set(
        String(roster.roster_id),
        label || `Roster ${roster.roster_id}`
      );
    }
    return {
      league,
      rosters,
      users,
      values,
      model,
      slots,
      teams,
      replacementByPos,
      playerMeta,
      nameByRoster,
    };
  }

  function populateTeams() {
    if (!teamSelect || !ctx) return;
    const savedTeam = localStorage.getItem(TEAM_KEY);
    teamSelect.innerHTML = ctx.rosters
      .map((roster) => {
        const s = roster.settings || {};
        const label = ctx.nameByRoster.get(String(roster.roster_id));
        const record = `${s.wins || 0}-${s.losses || 0}`;
        return `<option value="${roster.roster_id}">${escapeHtml(
          label
        )} (${record})</option>`;
      })
      .join("");
    if (savedTeam && ctx.rosters.some((r) => String(r.roster_id) === savedTeam)) {
      teamSelect.value = savedTeam;
    }
    teamSelect.disabled = false;
  }

  function render() {
    if (!ctx || !teamSelect || !resultsEl) return;
    const myTeamId = teamSelect.value;
    if (!myTeamId) return;
    localStorage.setItem(TEAM_KEY, myTeamId);

    const roster = ctx.rosters.find((r) => String(r.roster_id) === myTeamId);
    const profile = buildTeamProfile({
      roster,
      playerMeta: ctx.playerMeta,
      slots: ctx.slots,
      replacementByPos: ctx.replacementByPos,
      model: ctx.model,
    });
    setStatus(
      `Lineup VORP ${Math.round(profile.lineupValue)} · depth ${Math.round(
        profile.depthValue
      )} · composite ${Math.round(compositeFor(profile))}`
    );

    const recs = recommendTrades({
      myTeamId,
      rosters: ctx.rosters,
      playerMeta: ctx.playerMeta,
      model: ctx.model,
      slots: ctx.slots,
      replacementByPos: ctx.replacementByPos,
      limit: 25,
    });
    if (!recs.length) {
      resultsEl.innerHTML =
        '<p class="meta">No win-win trades found for this roster right now.</p>';
      return;
    }
    resultsEl.innerHTML = resultsHtml(recs, ctx.nameByRoster);
  }

  async function connectLeague() {
    const leagueId = parseLeagueId(input?.value);
    if (!leagueId) {
      setStatus("Enter a Sleeper league link or ID.");
      return;
    }
    setStatus("Loading league…");
    if (connectBtn) connectBtn.disabled = true;
    try {
      const [league, rosters, users, values] = await Promise.all([
        sleeperGet(`/league/${leagueId}`),
        sleeperGet(`/league/${leagueId}/rosters`),
        sleeperGet(`/league/${leagueId}/users`),
        fetchJSON("trade/values.json"),
      ]);
      ctx = computeContext(league, rosters || [], users || [], values || { players: [] });
      localStorage.setItem(LEAGUE_KEY, leagueId);
      populateTeams();
      if (summaryEl) {
        const format = values.format || {};
        const sf = SCORING_TYPE_LABELS[format.num_qbs === 2 ? 1 : 0] || "1QB";
        summaryEl.hidden = false;
        summaryEl.textContent = `${league.name || "League"} · ${format.num_teams || ctx.teams}-team ${sf} · ${format.ppr ?? "?"} PPR`;
      }
      render();
      setStatus("");
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

  if (input?.value) connectLeague();
}
