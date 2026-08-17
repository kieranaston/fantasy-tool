import { fetchJSON, showError, revealPage } from "./config.js?v=2";
import { escapeHtml, sleeperIdOf, starButtonHtml } from "./shared.js?v=1";
import {
  scoreCandidates,
  nextOwnedPickNumbers,
  resolveLeagueSettings,
  resolveScoringFormat,
  adpPathForFormat,
  formatFromReceptionPoints,
  formatAdpRoundPick,
  slotForOverallPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
} from "./draft-scoring.js?v=86";
import {
  loadLikedIds,
  toggleLikedId,
  mountStarSync,
} from "./draft-liked.js?v=5";

/** Fast on your turn / on deck; slower while waiting. */
const POLL_ON_CLOCK_MS = 1200;
const POLL_ON_DECK_MS = 1500;
const POLL_WAITING_MS = 2500;
const POLL_IDLE_MS = 5000;
const DRAFT_META_EVERY = 12;
const SEARCH_LIMIT = 24;

function playerMediaHtml(player, { name, compact = false } = {}) {
  const display = escapeHtml(
    name || player?.player || player?.name || player?.player_name || ""
  );
  const logo = player?.logo;
  const team = player?.team ? String(player.team).toUpperCase() : "";
  let teamHtml = "";
  if (!compact) {
    const teamBits = [];
    if (logo) {
      teamBits.push(
        `<img class="team-logo" src="${escapeHtml(logo)}" alt="" width="14" height="14" loading="lazy" decoding="async" />`
      );
    }
    if (team) teamBits.push(`<span>${escapeHtml(team)}</span>`);
    teamHtml = teamBits.length
      ? `<span class="player-media-team">${teamBits.join("")}</span>`
      : "";
  }
  const mediaClass = compact
    ? "player-media player-media--compact player-media--text"
    : "player-media player-media--text";
  return `<span class="${mediaClass}"><span class="player-media-text"><span class="player-media-name">${display}</span>${teamHtml}</span></span>`;
}

function playerCellHtml(player, { name, compact = false, liked = false } = {}) {
  const id = sleeperIdOf(player);
  return `<span class="draft-player-cell">${starButtonHtml(id, liked)}${playerMediaHtml(player, { name, compact })}</span>`;
}

function needBonusHtml(needBonus) {
  if (needBonus > 0) {
    return `<span class="need-boost">+${escapeHtml(needBonus)}</span>`;
  }
  if (needBonus < 0) {
    return `<span class="need-penalty">${escapeHtml(needBonus)}</span>`;
  }
  return "—";
}

function gapHtml(gap) {
  if (gap == null || !Number.isFinite(Number(gap))) return "—";
  const n = Number(gap);
  const label = n > 0 ? `+${n}` : String(n);
  const tight = Math.abs(n) < 2;
  return `<span class="${tight ? "score-gap is-tight" : "score-gap"}" title="Score difference vs the next player on this list">${escapeHtml(label)}</span>`;
}

function jumpHtml(jump) {
  const n = Number(jump);
  if (!Number.isFinite(n) || n === 0) {
    return `<span class="score-jump is-flat" title="Same order as ADP on this list">—</span>`;
  }
  if (n > 0) {
    return `<span class="score-jump is-up" title="Ranked ${n} spot${n === 1 ? "" : "s"} above ADP order because other positions are penalized">${escapeHtml(`↑${n}`)}</span>`;
  }
  const down = Math.abs(n);
  return `<span class="score-jump is-down" title="Ranked ${down} spot${down === 1 ? "" : "s"} below ADP order (this position is penalized)">${escapeHtml(`↓${down}`)}</span>`;
}

function withListContext(recs) {
  const adpOrder = recs
    .map((r, i) => ({ i, adp: Number(r.adp) }))
    .sort((a, b) => {
      const aa = Number.isFinite(a.adp) && a.adp > 0 ? a.adp : 9999;
      const ba = Number.isFinite(b.adp) && b.adp > 0 ? b.adp : 9999;
      return aa - ba || a.i - b.i;
    });
  const adpRankAt = [];
  adpOrder.forEach((row, rank) => {
    adpRankAt[row.i] = rank + 1;
  });
  return recs.map((r, i) => {
    const score = Number(r.score);
    const nextScore = Number(recs[i + 1]?.score);
    const gap =
      recs[i + 1] != null && Number.isFinite(score) && Number.isFinite(nextScore)
        ? Math.round((score - nextScore) * 10) / 10
        : null;
    const adpRank = adpRankAt[i];
    const jump = adpRank - (i + 1);
    return { ...r, gap, jump };
  });
}

function riskHtml(risk) {
  if (risk > 0.05) return `${escapeHtml(Math.round(risk * 100))}%`;
  return "—";
}

/**
 * Show overall ADP (Sleeper pick number) as the primary value.
 * Round.pick is secondary so it isn't mistaken for overall ADP.
 */
function adpHtml(adp, teams = 12) {
  const overall = Number(adp);
  if (!Number.isFinite(overall) || overall <= 0) return "—";
  const overallLabel = overall.toFixed(1);
  const roundPick = formatAdpRoundPick(overall, teams);
  if (!roundPick) return escapeHtml(overallLabel);
  return `<span class="adp-overall" title="${escapeHtml(
    String(teams)
  )}-team round.pick ${escapeHtml(roundPick)}">${escapeHtml(
    overallLabel
  )}</span><span class="adp-round-pick">${escapeHtml(roundPick)}</span>`;
}

function stampLabel(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function scoreRowCells(r, { liked = false, teams = 12 } = {}) {
  return `
    <td>${playerCellHtml(r, { liked })}</td>
    <td>${escapeHtml(r.position)}</td>
    <td>${r.bye_week == null ? "—" : escapeHtml(r.bye_week)}</td>
    <td>${needBonusHtml(r.need_bonus)}</td>
    <td>${adpHtml(r.adp, teams)}</td>
    <td>${riskHtml(r.risk)}</td>
    <td>${gapHtml(r.gap)}</td>
    <td>${jumpHtml(r.jump)}</td>
    <td><strong class="${
      r.jump > 0 ? "score-value is-up" : r.jump < 0 ? "score-value is-down" : ""
    }">${escapeHtml(r.score)}</strong></td>`;
}

async function sleeperGet(path) {
  const response = await fetch(`https://api.sleeper.app/v1${path}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Sleeper ${path}: ${response.status}`);
  return response.json();
}

function parseSleeperIdInput(raw, { prefer = "unknown" } = {}) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parts = text.replaceAll("?", "/").split("/").filter(Boolean);
  if (parts.includes("draft")) {
    const idx = parts.indexOf("draft");
    const id = parts.slice(idx + 1).find((p) => /^\d+$/.test(p));
    if (id) return { type: "draft", id };
  }
  if (parts.includes("leagues") || parts.includes("league")) {
    const key = parts.includes("leagues") ? "leagues" : "league";
    const idx = parts.indexOf(key);
    const id = parts.slice(idx + 1).find((p) => /^\d+$/.test(p));
    if (id) return { type: "league", id };
  }
  if (/^\d+$/.test(text)) return { type: prefer, id: text };
  return null;
}

async function resolveDraftId(raw) {
  const parsed = parseSleeperIdInput(raw, { prefer: "draft" });
  if (!parsed) throw new Error("Enter a Sleeper draft id or draft URL");
  if (parsed.type === "draft") return parsed.id;
  if (parsed.type === "league") {
    const drafts = await sleeperGet(`/league/${parsed.id}/drafts`);
    if (!drafts?.length) throw new Error("No drafts found for that league");
    return String(drafts[0].draft_id);
  }
  try {
    const draft = await sleeperGet(`/draft/${parsed.id}`);
    if (draft?.draft_id) return String(draft.draft_id);
  } catch {
    /* fall through — maybe they pasted a league id in the draft box */
  }
  const drafts = await sleeperGet(`/league/${parsed.id}/drafts`);
  if (!drafts?.length) throw new Error("Could not resolve draft id");
  return String(drafts[0].draft_id);
}

function resolveLeagueIdInput(raw) {
  const parsed = parseSleeperIdInput(raw, { prefer: "league" });
  if (!parsed) return null;
  if (parsed.type === "league" || parsed.type === "unknown") return parsed.id;
  return null;
}

function leagueIdFromDraft(draft) {
  if (!draft) return null;
  if (draft.league_id) return String(draft.league_id);
  const metaId = draft.metadata?.league_id;
  if (metaId) return String(metaId);
  return null;
}

async function fetchLeagueById(leagueId) {
  if (!leagueId) return null;
  return sleeperGet(`/league/${leagueId}`);
}

async function fetchLeagueForDraft(draft) {
  const id = leagueIdFromDraft(draft);
  if (!id) return null;
  try {
    return await fetchLeagueById(id);
  } catch {
    return null;
  }
}

function slotToRosterMaps(draft, rosters = []) {
  const slotToRoster = {};
  const rosterToSlot = {};
  const raw = draft?.slot_to_roster_id;
  if (raw && typeof raw === "object") {
    for (const [slot, rid] of Object.entries(raw)) {
      const s = Number(slot);
      const r = Number(rid);
      if (!s || !Number.isFinite(r) || r <= 0) continue;
      slotToRoster[s] = r;
      rosterToSlot[r] = s;
    }
  }
  const userToSlot = userToSlotMap(draft);
  for (const row of rosters || []) {
    const rid = Number(row?.roster_id);
    const slot = userToSlot[String(row?.owner_id || "")];
    if (!rid || !slot) continue;
    if (!rosterToSlot[rid]) rosterToSlot[rid] = slot;
    if (!slotToRoster[slot]) slotToRoster[slot] = rid;
  }
  return { slotToRoster, rosterToSlot };
}

/** Sleeper draft_order is user_id → slot (occasionally inverted). */
function userToSlotMap(draft) {
  const order = draft?.draft_order;
  if (!order || typeof order !== "object") return {};
  const keys = Object.keys(order);
  if (!keys.length) return {};
  const keysLookLikeSlots = keys.every((k) => {
    const n = Number(k);
    return Number.isInteger(n) && n >= 1 && n <= 24;
  });
  const userToSlot = {};
  if (keysLookLikeSlots) {
    for (const [slot, userId] of Object.entries(order)) {
      if (userId) userToSlot[String(userId)] = Number(slot);
    }
  } else {
    for (const [userId, slot] of Object.entries(order)) {
      const s = Number(slot);
      if (userId && s > 0) userToSlot[String(userId)] = s;
    }
  }
  return userToSlot;
}

/**
 * Assign a completed pick to a draft seat.
 * Ownership of that overall pick (snake + trades) wins. Board column
 * (draft_slot) is last resort — traded picks stay in the original column.
 */
function slotForCompletedPick(pick, draft, ownerSlotByPick, rosters = []) {
  const draftSlot = Number(pick?.draft_slot) || 0;
  const pickNo = Number(pick?.pick_no);
  const { rosterToSlot } = slotToRosterMaps(draft, rosters);
  const userToSlot = userToSlotMap(draft);

  const tradeSlot = Number(
    ownerSlotByPick?.[pickNo] ?? ownerSlotByPick?.[String(pickNo)]
  );
  if (tradeSlot > 0 && draftSlot && tradeSlot !== draftSlot) return tradeSlot;

  const rosterSlot = rosterToSlot[Number(pick?.roster_id)] || 0;
  if (rosterSlot && draftSlot && rosterSlot !== draftSlot) return rosterSlot;

  const userSlot = userToSlot[String(pick?.picked_by || "").trim()] || 0;
  if (userSlot && draftSlot && userSlot !== draftSlot) return userSlot;

  if (tradeSlot > 0) return tradeSlot;
  if (rosterSlot) return rosterSlot;
  if (userSlot) return userSlot;
  return draftSlot;
}

/** Overall pick → draft slot of the team that currently owns that pick. */
function buildOwnerSlotByPick(draft, tradedPicks, teams, rounds, rosters = []) {
  const { rosterToSlot } = slotToRosterMaps(draft, rosters);
  const byPick = {};
  const last = teams * rounds;
  for (let n = 1; n <= last; n += 1) {
    byPick[n] = slotForOverallPick(n, teams);
  }
  const season = String(draft?.season || "");
  for (const t of tradedPicks || []) {
    if (season && t.season != null && String(t.season) !== season) continue;
    const origSlot = rosterToSlot[Number(t.roster_id)];
    const newSlot = rosterToSlot[Number(t.owner_id)];
    const round = Number(t.round);
    if (!origSlot || !newSlot || !(round > 0) || origSlot === newSlot) continue;
    const inRound = round % 2 === 1 ? origSlot : teams - origSlot + 1;
    const pickNo = (round - 1) * teams + inRound;
    if (pickNo >= 1 && pickNo <= last) byPick[pickNo] = newSlot;
  }
  return byPick;
}

function buildSlotRosters(picks, draft, ownerSlotByPick, rosters = []) {
  const bySlot = {};
  for (const pick of picks) {
    const slot = slotForCompletedPick(pick, draft, ownerSlotByPick, rosters);
    if (!slot) continue;
    const meta = pick.metadata || {};
    bySlot[slot] = bySlot[slot] || [];
    bySlot[slot].push({
      player_id: String(pick.player_id || ""),
      position: String(meta.position || "").toUpperCase(),
      team: String(meta.team || meta.team_abbr || "").toUpperCase(),
      name: `${meta.first_name || ""} ${meta.last_name || ""}`.trim(),
    });
  }
  return bySlot;
}

function myRosterFingerprint(roster = []) {
  return roster
    .map((p) => `${p.player_id}:${p.position}`)
    .sort()
    .join("|");
}

function currentPickNo(picks) {
  return (picks?.length || 0) + 1;
}

function picksFingerprint(pickList) {
  const n = pickList?.length || 0;
  if (!n) return "0";
  const last = pickList[n - 1];
  return `${n}:${last?.player_id || ""}:${last?.pick_no || ""}`;
}

async function mountDraftCompanionPage() {
  const statusEl = document.querySelector("[data-draft-live='status']");
  const recEl = document.getElementById("draft-recommendations");
  const boardEl = document.getElementById("draft-board");
  const needsEl = document.getElementById("draft-needs");
  const searchInput = document.getElementById("draft-player-search");
  const searchEl = document.getElementById("draft-search-results");
  const connectBtn = document.getElementById("draft-connect");
  const pauseBtn = document.getElementById("draft-pause");
  const draftInput = document.getElementById("draft-id-input");
  const leagueInput = document.getElementById("draft-league-input");
  const seatSelect = document.getElementById("draft-seat");
  const rootEl = document.querySelector(".container") || document.body;

  let boardPlayers = [];
  let boardByPos = { QB: [], RB: [], WR: [], TE: [] };
  let boardById = new Map();
  let scoringFormat = resolveScoringFormat();
  /** Active league for slots (entered league ID or draft-linked league). */
  let configuredLeague = null;
  const adpBoardCache = new Map();

  let takenIndex = new Set();
  let pollTimer = null;
  let draftId = null;
  let draft = null;
  let league = null;
  let leagueSettings = null;
  let picks = [];
  let tradedPicks = [];
  let leagueRosters = [];
  let ownerSlotByPick = null;
  let lastFingerprint = "";
  let mySlot = 1;
  let paused = false;
  let inFlight = false;
  let pollTick = 0;
  let scoreGen = 0;
  let lastScoredFingerprint = "";
  let lastMyRosterFp = "";
  let hasScoredOnce = false;
  let likedIds = loadLikedIds();
  let lastScoreResult = null;
  let lastScoreById = new Map();
  let searchTimer = null;
  let lastRosterForRender = [];

  const starSync = mountStarSync({
    host: document.getElementById("sync-bar"),
    getIds: () => likedIds,
    setIds: (ids) => {
      likedIds = ids;
    },
    onChange: () => {
      if (lastScoreResult) renderRecommendationsFromCache();
      renderSearchResults();
      renderRosterCounts();
      if (picks?.length) renderRecentPicks();
    },
  });

  function leagueTeamCount() {
    const fromSettings = Number(leagueSettings?.teams);
    if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
    const fromLeague = Number(
      leagueForSettings()?.total_rosters || draft?.settings?.teams
    );
    if (Number.isFinite(fromLeague) && fromLeague > 0) return fromLeague;
    return 12;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function leagueDisplayName() {
    const enteredId = resolveLeagueIdInput(leagueInput?.value || "");
    if (enteredId && configuredLeague?.name) return configuredLeague.name;
    if (league?.name) return league.name;
    if (configuredLeague?.name) return configuredLeague.name;
    return null;
  }

  /** Top meta: League name · format · ADP freshness */
  function refreshHeader() {
    const leagueName = leagueDisplayName() || "—";
    const formatLabel =
      scoringFormat?.format_label ||
      FORMAT_LABELS[scoringFormat?.format] ||
      scoringFormat?.label ||
      "Half PPR";
    const when = stampLabel(scoringFormat?.last_updated);
    const adp = when ? `Sleeper ADP: ${when}` : "Sleeper ADP";
    setStatus([`League: ${leagueName}`, formatLabel, adp].join(" · "));
  }

  function isLiked(id) {
    return likedIds.has(String(id || ""));
  }

  function toggleLiked(id) {
    likedIds = toggleLikedId(likedIds, id);
    starSync.persistLocalAndMaybeRemote();
  }

  /** Prefer user/configured league over the draft's linked league. */
  function leagueForSettings() {
    return configuredLeague || league;
  }

  function refreshLeagueSettings() {
    const srcLeague = leagueForSettings();
    leagueSettings = resolveLeagueSettings(draft || {}, srcLeague);
    scoringFormat = {
      ...resolveScoringFormat(draft || {}, srcLeague),
      last_updated: scoringFormat?.last_updated || null,
      format_label: null,
    };
    const key = scoringFormat.format;
    scoringFormat.format_label = FORMAT_LABELS[key] || scoringFormat.label;
    scoringFormat.label = scoringFormat.format_label;
  }

  function indexBoard(players) {
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    const byId = new Map();
    for (const p of players) {
      if (byPos[p.position]) byPos[p.position].push(p);
      byId.set(String(p.sleeper_id), p);
    }
    for (const pos of SKILL_POSITIONS) {
      byPos[pos].sort(
        (a, b) =>
          Number(a.adp) - Number(b.adp) ||
          String(a.player || "").localeCompare(String(b.player || ""))
      );
    }
    boardByPos = byPos;
    boardById = byId;
  }

  function applyBoardPlayers(players, formatInfo, meta = {}) {
    boardPlayers = players;
    indexBoard(boardPlayers);
    const formatKey = meta.format || formatInfo?.format || "half_ppr";
    const formatLabel =
      FORMAT_LABELS[formatKey] || formatInfo?.label || "Half PPR";
    scoringFormat = {
      ...formatInfo,
      format: formatKey,
      format_label: formatLabel,
      last_updated: meta.last_updated || null,
      label: formatLabel,
      board_source: meta.source || "sleeper_adp",
      league_id: meta.league_id || configuredLeague?.league_id || null,
    };
    refreshHeader();
  }

  function adpFormatKey(formatInfo, scoring = {}) {
    const fromInfo =
      formatInfo?.format && SCORING_FORMATS.includes(formatInfo.format)
        ? formatInfo.format
        : null;
    if (fromInfo) return fromInfo;
    return formatFromReceptionPoints(scoring.rec) || "half_ppr";
  }

  async function loadAdpBoard(formatInfo) {
    const scoring = leagueForSettings()?.scoring_settings || {};
    const formatKey = adpFormatKey(formatInfo, scoring);
    let data;
    if (adpBoardCache.has(formatKey)) {
      data = adpBoardCache.get(formatKey);
    } else {
      data = await fetchJSON(adpPathForFormat(formatKey));
      adpBoardCache.set(formatKey, data);
    }
    const players = (data.players || []).map((p) => ({
      ...p,
      sleeper_id: sleeperIdOf(p),
    }));
    applyBoardPlayers(players, formatInfo, {
      source: data.source || "sleeper_adp",
      format: formatKey,
      league_id: configuredLeague?.league_id || null,
      last_updated: data.last_updated || null,
    });
  }

  /**
   * Load slots from the league ID field (else draft-linked league / defaults).
   */
  async function loadConfiguredLeague({ required = false } = {}) {
    const raw = leagueInput?.value?.trim() || "";
    const leagueId = resolveLeagueIdInput(raw);
    if (leagueId) {
      try {
        configuredLeague = await fetchLeagueById(leagueId);
        return configuredLeague;
      } catch (err) {
        if (required) throw new Error(`League lookup failed: ${err.message}`);
        setStatus(`League lookup failed (${err.message}); using defaults`);
      }
    }
    configuredLeague = null;
    if (required) {
      throw new Error("Enter a Sleeper league ID for roster settings");
    }
    return configuredLeague;
  }

  function enrichRoster(roster = []) {
    return roster.map((p) => {
      const board = boardById.get(String(p.player_id));
      return {
        ...p,
        bye_week: board?.bye_week ?? p.bye_week ?? null,
      };
    });
  }

  function availableByPos() {
    const out = {};
    for (const pos of SKILL_POSITIONS) {
      out[pos] = (boardByPos[pos] || []).filter(
        (p) => !takenIndex.has(String(p.sleeper_id))
      );
    }
    return out;
  }

  function stopTimers() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function pollDelay() {
    const status = draft?.status;
    if (status !== "drafting" && status !== "pre_draft") return POLL_IDLE_MS;
    if (!draft) return POLL_WAITING_MS;
    const until = pickTiming().until;
    if (until <= 0) return POLL_ON_CLOCK_MS;
    if (until === 1) return POLL_ON_DECK_MS;
    return POLL_WAITING_MS;
  }

  function schedulePoll() {
    stopTimers();
    pollTimer = setTimeout(() => {
      refreshLive()
        .catch((err) => setStatus(`Poll error: ${err.message}`))
        .finally(() => {
          if (draftId && !paused) schedulePoll();
        });
    }, pollDelay());
  }

  function rebuildTaken() {
    takenIndex = new Set(picks.map((p) => String(p.player_id)));
  }

  function rebuildPickOwners() {
    if (!draft) {
      ownerSlotByPick = null;
      return;
    }
    const teams = Number(leagueSettings?.teams || draft?.settings?.teams || 12);
    const rounds = Number(draft?.settings?.rounds || leagueSettings?.rounds || 15);
    ownerSlotByPick = buildOwnerSlotByPick(
      draft,
      tradedPicks,
      teams,
      rounds,
      leagueRosters
    );
  }

  function activeLeagueId() {
    return (
      leagueIdFromDraft(draft) ||
      resolveLeagueIdInput(leagueInput?.value || "") ||
      league?.league_id ||
      configuredLeague?.league_id ||
      null
    );
  }

  async function loadLeagueRosters() {
    const leagueId = activeLeagueId();
    if (!leagueId) {
      leagueRosters = [];
      return;
    }
    try {
      leagueRosters = (await sleeperGet(`/league/${leagueId}/rosters`)) || [];
    } catch {
      leagueRosters = [];
    }
  }

  async function loadTradedPicks() {
    const bags = [];
    if (draftId) {
      try {
        bags.push(...((await sleeperGet(`/draft/${draftId}/traded_picks`)) || []));
      } catch {
        /* some drafts 404 this endpoint */
      }
    }
    const leagueId = activeLeagueId();
    if (leagueId) {
      try {
        bags.push(...((await sleeperGet(`/league/${leagueId}/traded_picks`)) || []));
      } catch {
        /* optional */
      }
    }
    const season = String(draft?.season || "");
    const seen = new Set();
    tradedPicks = [];
    for (const t of bags) {
      if (season && t.season != null && String(t.season) !== season) continue;
      const key = `${t.round}:${t.roster_id}:${t.owner_id}:${t.season}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tradedPicks.push(t);
    }
  }

  function pickTiming() {
    const settings =
      leagueSettings || resolveLeagueSettings(draft || {}, leagueForSettings());
    const teams = Number(settings.teams || 12);
    const rounds = Number(settings.rounds || draft?.settings?.rounds || 15);
    const pickNo = currentPickNo(picks);
    const mine = nextOwnedPickNumbers(
      mySlot,
      teams,
      rounds,
      pickNo,
      ownerSlotByPick
    );
    const nextMine = mine[0] ?? pickNo;
    const until = Math.max(0, nextMine - pickNo);
    return { teams, rounds, pickNo, nextMine, until, settings };
  }

  function currentBySlot() {
    return buildSlotRosters(picks, draft, ownerSlotByPick, leagueRosters);
  }

  function updateMeta() {
    refreshHeader();
  }

  function cacheScoreResult(result) {
    lastScoreResult = result;
    lastScoreById = new Map(
      (result?.recommendations || []).map((r) => [sleeperIdOf(r), r])
    );
  }

  function renderRosterCounts(roster = lastRosterForRender) {
    lastRosterForRender = roster;
    const byPos = {};
    for (const p of roster) {
      const pos = String(p.position || "").toUpperCase();
      const key = pos === "DEF" || pos === "DST" ? "DST" : pos;
      (byPos[key] = byPos[key] || []).push(p);
    }
    needsEl.innerHTML = `
      <div class="draft-roster-grid">
        ${["QB", "RB", "WR", "TE"]
          .map((pos) => {
            const players = byPos[pos] || [];
            const body = players.length
              ? `<ul class="draft-roster-players">${players
                  .map((p) => {
                    const id = String(p.player_id || "");
                    const liked = isLiked(id);
                    const board = boardById.get(id) || p;
                    return `<li class="${liked ? "draft-liked" : ""}">${playerCellHtml(board, {
                      name: p.name || board.player || p.player_id,
                      liked,
                    })}</li>`;
                  })
                  .join("")}</ul>`
              : `<span class="draft-roster-empty">—</span>`;
            return `<div class="draft-roster-slot"><strong>${pos}</strong>${body}</div>`;
          })
          .join("")}
      </div>`;
  }

  function renderRecentPicks() {
    const recent = [...picks].slice(-10).reverse();
    boardEl.innerHTML = `
      <table class="draft-table cell-border">
        <thead><tr><th>Pick</th><th>Slot</th><th>Player</th><th>Pos</th></tr></thead>
        <tbody>
          ${recent
            .map((p) => {
              const meta = p.metadata || {};
              const name = `${meta.first_name || ""} ${meta.last_name || ""}`.trim();
              const id = String(p.player_id || "");
              const liked = isLiked(id);
              const board = boardById.get(id) || {
                sleeper_id: id,
                player: name,
                team: meta.team || meta.team_abbr,
                position: meta.position,
              };
              return `<tr class="${liked ? "draft-liked" : ""}">
                <td>${escapeHtml(p.pick_no)}</td>
                <td>${escapeHtml(p.draft_slot)}</td>
                <td>${playerCellHtml(board, { name, compact: true, liked })}</td>
                <td>${escapeHtml(meta.position || "")}</td>
              </tr>`;
            })
            .join("") || `<tr><td colspan="4">No picks yet</td></tr>`}
        </tbody>
      </table>`;
  }

  function renderRecommendationsFromCache() {
    if (!recEl) return;
    if (!draft) return;
    if (draft.status === "complete") {
      recEl.innerHTML = `<p class="meta">Draft complete.</p>`;
      return;
    }
    const result = lastScoreResult;
    if (!result) return;
    const recs = (result.recommendations || []).slice(0, 24);
    if (!recs.length) {
      recEl.innerHTML = `<p class="meta">No skill players left on the board.</p>`;
      return;
    }
    const teams = leagueTeamCount();
    const rows = withListContext(recs);
    recEl.innerHTML = `
      <p class="meta">Score = −ADP + need (need is 0 or a penalty). Gap = vs next on this list. vs ADP = spots moved by need — empty QB/TE are not boosted. Risk ≈ ADP gone before your next pick (not in the score). ADP = overall pick (${teams}-team r.pk in gray)</p>
      <table class="draft-table cell-border">
        <thead>
          <tr>
            <th>#</th><th>Player</th><th>Pos</th><th>Bye</th>
            <th>Need</th><th>ADP</th><th>Risk</th><th>Gap</th><th>vs ADP</th><th>Score</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((r, i) => {
              const liked = isLiked(sleeperIdOf(r));
              const jumpClass =
                r.jump > 0 ? "is-need-up" : r.jump < 0 ? "is-need-down" : "";
              return `
            <tr class="${[liked ? "draft-liked" : "", jumpClass].filter(Boolean).join(" ")}">
              <td>${i + 1}</td>
              ${scoreRowCells(r, { liked, teams })}
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  function matchesSearch(player, query) {
    if (!query) return false;
    const name = String(player.player || player.name || "").toLowerCase();
    const team = String(player.team || "").toLowerCase();
    const pos = String(player.position || "").toLowerCase();
    return name.includes(query) || team.includes(query) || pos === query;
  }

  function renderSearchResults() {
    if (!searchEl) return;
    const query = String(searchInput?.value || "")
      .trim()
      .toLowerCase();
    if (!query) {
      searchEl.innerHTML = "";
      return;
    }

    const available = [];
    const taken = [];
    for (const p of boardPlayers) {
      if (!matchesSearch(p, query)) continue;
      const id = sleeperIdOf(p);
      if (takenIndex.has(id)) taken.push(p);
      else available.push(p);
    }

    const rankedAvailable = available
      .map((p) => {
        const scored = lastScoreById.get(sleeperIdOf(p));
        return {
          player: p,
          scored,
          sortScore: scored?.score ?? -Number(p.adp || 9999),
        };
      })
      .sort((a, b) => b.sortScore - a.sortScore)
      .slice(0, SEARCH_LIMIT);

    const rankedTaken = taken
      .slice()
      .sort((a, b) => Number(a.adp) - Number(b.adp))
      .slice(0, Math.max(0, SEARCH_LIMIT - rankedAvailable.length))
      .map((p) => ({ player: p, scored: null, taken: true }));

    const rows = [...rankedAvailable, ...rankedTaken];
    if (!rows.length) {
      searchEl.innerHTML = `<p class="meta">No players match “${escapeHtml(searchInput.value.trim())}”.</p>`;
      return;
    }

    const live = Boolean(draft && lastScoreById.size);
    const teams = leagueTeamCount();
    searchEl.innerHTML = `
      <table class="draft-table cell-border">
        <thead>
          <tr>
            <th>Player</th><th>Pos</th><th>Bye</th>
            <th>Need</th><th>ADP</th><th>Risk</th><th>Score</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(({ player, scored, taken: isTaken }) => {
              const id = sleeperIdOf(player);
              const liked = isLiked(id);
              const row = scored || {
                ...player,
                need_bonus: 0,
                adp: player.adp,
                risk: 0,
                score: live ? "—" : "—",
              };
              const classes = [
                liked ? "draft-liked" : "",
                isTaken ? "draft-taken" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const scoreCell = isTaken
                ? `<td><span class="draft-taken-label">Taken</span></td>`
                : `<td><strong>${escapeHtml(row.score)}</strong></td>`;
              return `<tr class="${classes}">
                <td>${playerCellHtml(player, { liked })}</td>
                <td>${escapeHtml(player.position)}</td>
                <td>${player.bye_week == null ? "—" : escapeHtml(player.bye_week)}</td>
                <td>${scored ? needBonusHtml(scored.need_bonus) : "—"}</td>
                <td>${adpHtml(player.adp, teams)}</td>
                <td>${scored ? riskHtml(scored.risk) : "—"}</td>
                ${scoreCell}
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  function renderScores() {
    if (!draft) return;
    const timing = pickTiming();
    const settings = timing.settings;
    const bySlot = currentBySlot();
    const myRoster = enrichRoster(bySlot[mySlot] || []);
    updateMeta(timing);
    lastMyRosterFp = myRosterFingerprint(myRoster);

    const byPos = availableByPos();
    const result = scoreCandidates({
      availableByPos: byPos,
      myRoster,
      opponentRosters: bySlot,
      settings,
      teams: timing.teams,
      mySlot,
      currentPickNo: timing.pickNo,
      rounds: timing.rounds,
      limit: 40,
      ownerSlotByPick,
    });

    hasScoredOnce = true;
    lastScoredFingerprint = picksFingerprint(picks);
    cacheScoreResult(result);

    renderRosterCounts(myRoster);
    renderRecommendationsFromCache();
    renderSearchResults();
  }

  function renderAll() {
    renderRecentPicks();
    renderScores();
  }

  function queueScoreRender({ force = false } = {}) {
    const timing = draft ? pickTiming() : null;
    const bySlot = currentBySlot();
    const myRoster = enrichRoster(bySlot[mySlot] || []);
    const myFp = myRosterFingerprint(myRoster);
    const onClock = timing ? timing.until <= 0 : false;

    const fp = picksFingerprint(picks);
    if (
      !force &&
      fp === lastScoredFingerprint &&
      myFp === lastMyRosterFp &&
      hasScoredOnce
    ) {
      if (timing) updateMeta(timing, { onClock });
      return;
    }

    const gen = ++scoreGen;
    requestAnimationFrame(() => {
      if (gen !== scoreGen) return;
      renderScores();
    });
  }

  function fillSeats() {
    const teams = Number(leagueSettings?.teams || draft?.settings?.teams || 12);
    seatSelect.innerHTML = Array.from({ length: teams }, (_, i) => {
      const slot = i + 1;
      return `<option value="${slot}" ${slot === mySlot ? "selected" : ""}>Slot ${slot}</option>`;
    }).join("");
  }

  async function refreshLive() {
    if (!draftId || paused || inFlight) return;
    inFlight = true;
    try {
      pollTick += 1;
      const wantMeta = pollTick === 1 || pollTick % DRAFT_META_EVERY === 0;
      const nextPicks = await sleeperGet(`/draft/${draftId}/picks`);
      if (wantMeta) {
        draft = await sleeperGet(`/draft/${draftId}`);
        if (!league) league = await fetchLeagueForDraft(draft);
        try {
          await loadLeagueRosters();
          await loadTradedPicks();
        } catch {
          tradedPicks = tradedPicks || [];
        }
        rebuildPickOwners();
        const prevFormat = scoringFormat?.format;
        refreshLeagueSettings();
        if (scoringFormat.format !== prevFormat) {
          await loadAdpBoard(scoringFormat);
          hasScoredOnce = false;
          lastScoredFingerprint = "";
          lastMyRosterFp = "";
          queueScoreRender({ force: true });
        }
      }
      const next = nextPicks || [];
      const fingerprint = picksFingerprint(next);
      const changed = fingerprint !== lastFingerprint;
      picks = next;
      if (changed) {
        lastFingerprint = fingerprint;
        rebuildTaken();
        renderRecentPicks();
        queueScoreRender();
      } else if (draft) {
        refreshHeader();
      }
    } finally {
      inFlight = false;
    }
  }

  async function connectLive() {
    stopTimers();
    paused = false;
    inFlight = false;
    pollTick = 0;
    hasScoredOnce = false;
    lastScoredFingerprint = "";
    lastMyRosterFp = "";
    if (pauseBtn) pauseBtn.textContent = "Pause";

    await loadConfiguredLeague({ required: false });
    if (!draftInput?.value?.trim()) {
      throw new Error("Enter a Sleeper draft id or draft URL");
    }
    draftId = await resolveDraftId(draftInput.value);
    draft = await sleeperGet(`/draft/${draftId}`);
    league = await fetchLeagueForDraft(draft);
    try {
      await loadLeagueRosters();
      await loadTradedPicks();
    } catch {
      tradedPicks = [];
    }

    if (!resolveLeagueIdInput(leagueInput?.value || "") && league) {
      configuredLeague = league;
    }

    refreshLeagueSettings();
    rebuildPickOwners();
    await loadAdpBoard(scoringFormat);
    picks = (await sleeperGet(`/draft/${draftId}/picks`)) || [];
    lastFingerprint = picksFingerprint(picks);
    rebuildTaken();
    fillSeats();
    refreshHeader();
    renderAll();
    schedulePoll();
  }

  rootEl?.addEventListener("click", (event) => {
    const btn = event.target.closest(".draft-star");
    if (!btn || !rootEl.contains(btn)) return;
    event.preventDefault();
    toggleLiked(btn.getAttribute("data-player-id"));
  });

  searchInput?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderSearchResults(), 120);
  });

  connectBtn?.addEventListener("click", () => {
    connectLive().catch((err) => {
      showError(recEl, err.message);
      setStatus(err.message);
    });
  });
  pauseBtn?.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    if (!paused && draftId) schedulePoll();
    if (paused) stopTimers();
  });
  seatSelect?.addEventListener("change", () => {
    mySlot = Number(seatSelect.value) || 1;
    hasScoredOnce = false;
    lastScoredFingerprint = "";
    lastMyRosterFp = "";
    queueScoreRender({ force: true });
  });

  leagueInput?.addEventListener("change", () => {
    loadConfiguredLeague({ required: false })
      .then(() => {
        refreshLeagueSettings();
        return loadAdpBoard(scoringFormat);
      })
      .then(() => {
        refreshHeader();
        if (draftId) queueScoreRender({ force: true });
        else renderSearchResults();
      })
      .catch((err) => setStatus(err.message));
  });

  try {
    await starSync.hydrate();

    if (leagueInput) leagueInput.value = "";
    if (draftInput) draftInput.value = "";

    await loadConfiguredLeague({ required: false });
    refreshLeagueSettings();
    await loadAdpBoard(scoringFormat);
    refreshHeader();
    renderSearchResults();
    revealPage();
  } catch (err) {
    showError(recEl, err.message);
    revealPage();
  }
}

export { mountDraftCompanionPage };
