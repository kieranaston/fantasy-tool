import { fetchJSON, formatUpdated, showError, revealPage } from "./config.js?v=6";
import { escapeHtml, sleeperIdOf, playerCellHtml } from "./shared.js?v=7";
import {
  scoreCandidates,
  annotateScore,
  nextOwnedPickNumbers,
  filledPickNumbers,
  currentPickNo,
  unfilledPickCount,
  ownerSlotAtPick,
  resolveLeagueSettings,
  resolveScoringFormat,
  adpPathForFormat,
  playerAdpForFormat,
  formatFromReceptionPoints,
  formatAdpRoundPick,
  slotForOverallPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
  normalizePos,
} from "./draft-scoring.js?v=115";
import { createFavourites } from "./draft-liked.js?v=11";
import { loadHeadshots, attachHeadshots } from "./media.js?v=1";
import {
  ensureTableBody,
  showTableMessage,
  syncTableRows,
} from "./table-diff.js?v=1";

/** Fast on your turn / on deck; slower while waiting. */
const POLL_ON_CLOCK_MS = 1200;
const POLL_ON_DECK_MS = 1500;
const POLL_WAITING_MS = 2500;
const POLL_IDLE_MS = 5000;
/** How often to refresh draft status (not trades — those are fixed at connect). */
const DRAFT_META_EVERY = 12;
/** Score / recommend this many players; UI shows the same window. */
const SCORE_LIMIT = 24;
const SEARCH_LIMIT = 24;

const RECS_TABLE_HEAD = `<thead>
          <tr>
            <th>Player</th><th>Pos</th><th class="num">ADP</th>
            <th class="num col-wide">Need</th><th class="num">Score</th>
            <th class="num" title="Score minus the next player at this position">Δ</th>
            <th class="num" title="Chance taken before your next pick">Risk</th>
          </tr>
        </thead>`;
const PICKS_TABLE_HEAD = `<thead><tr><th>Pick</th><th>Player</th><th>Pos</th></tr></thead>`;
const SEARCH_TABLE_HEAD = `<thead>
          <tr>
            <th>Player</th><th>Pos</th><th class="num">ADP</th><th class="num">Score</th>
          </tr>
        </thead>`;

let riskWorker = null;
let riskJobSeq = 0;

function getRiskWorker() {
  if (!riskWorker) {
    riskWorker = new Worker(new URL("./draft-risk-worker.js", import.meta.url), {
      type: "module",
    });
  }
  return riskWorker;
}

function applyRiskToResult(result, goneProbById = {}) {
  const attach = (row) => {
    const id = sleeperIdOf(row);
    const raw = goneProbById[id];
    if (raw == null) return row;
    const p = Number(raw);
    return {
      ...row,
      risk: Number.isFinite(p) ? Math.round(p * 100) / 100 : null,
    };
  };
  return {
    ...result,
    scored: (result.scored || []).map(attach),
    recommendations: (result.recommendations || []).map(attach),
  };
}


function needBonusHtml(needBonus) {
  const m = Number(needBonus);
  if (!Number.isFinite(m) || m <= 1.001) return "—";
  return `<span class="need-penalty">×${escapeHtml(m)}</span>`;
}

function scoreRowCells(r, { liked = false, teams = 12 } = {}) {
  return `
    <td>${playerCellHtml(r, { liked })}</td>
    <td>${escapeHtml(r.position)}</td>
    <td class="num">${adpHtml(r.adp, teams)}</td>
    <td class="num col-wide">${needBonusHtml(r.need_bonus)}</td>
    <td class="num">${escapeHtml(r.score)}</td>
    <td class="num">${gapHtml(r.gap)}</td>
    <td class="num">${riskHtml(r)}</td>`;
}

/** Score minus the next same-position player still on the board. */
function withPosGaps(recs, scored) {
  const source = scored?.length ? scored : recs;
  const gapById = new Map();
  const nextScoreAtPos = {};
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const row = source[i];
    const pos = String(row.position || "").toUpperCase();
    const score = Number(row.score);
    const next = nextScoreAtPos[pos];
    const gap =
      next != null && Number.isFinite(score) && Number.isFinite(next)
        ? Math.round((score - next) * 10) / 10
        : null;
    gapById.set(sleeperIdOf(row), gap);
    if (Number.isFinite(score)) nextScoreAtPos[pos] = score;
  }
  return recs.map((r) => ({ ...r, gap: gapById.get(sleeperIdOf(r)) ?? null }));
}

function gapHtml(gap) {
  if (gap == null || !Number.isFinite(Number(gap))) return "—";
  return Number(gap).toFixed(1);
}

function riskHtml(r) {
  if (r?.risk == null) return "—";
  const raw = Number(r.risk);
  if (!Number.isFinite(raw) || raw <= 0) {
    return `<span class="risk-low" title="Chance taken before your next pick">0%</span>`;
  }
  const pct = raw < 0.005 ? 1 : Math.round(raw * 100);
  const cls = pct >= 70 ? "risk-high" : pct >= 40 ? "risk-mid" : "risk-low";
  return `<span class="${cls}" title="Chance taken before your next pick">${pct}%</span>`;
}

/**
 * Round.pick first (same as recent picks); overall ADP is secondary.
 */
function adpHtml(adp, teams = 12) {
  const overall = Number(adp);
  if (!Number.isFinite(overall) || overall <= 0) return "—";
  const overallLabel = overall.toFixed(1);
  const roundPick = formatAdpRoundPick(overall, teams);
  if (!roundPick) return escapeHtml(overallLabel);
  return `<span class="adp-overall">${escapeHtml(
    roundPick
  )}</span><span class="adp-round-pick">${escapeHtml(overallLabel)}</span>`;
}

function formatRosterSpots(settings = {}) {
  const parts = [];
  const add = (n, label) => {
    const count = Number(n) || 0;
    if (count <= 0) return;
    parts.push(count === 1 ? `1 ${label}` : `${count} ${label}`);
  };
  add(settings.slots_qb, "QB");
  add(settings.slots_rb, "RB");
  add(settings.slots_wr, "WR");
  add(settings.slots_te, "TE");
  add(settings.slots_flex, "FLEX");
  add(settings.slots_super_flex, "SF");
  add(settings.slots_def, "DEF");
  add(settings.slots_k, "K");
  return parts.join(" · ");
}

function pickNoHtml(pickNo, teams = 12) {
  const n = Number(pickNo);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const overall = String(Math.round(n));
  const roundPick = formatAdpRoundPick(n, teams);
  if (!roundPick) return escapeHtml(overall);
  return `<span class="adp-overall">${escapeHtml(
    roundPick
  )}</span><span class="adp-round-pick">${escapeHtml(overall)}</span>`;
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
  return { slotToRoster, rosterToSlot, userToSlot };
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
function slotForCompletedPick(pick, ownerSlotByPick, maps) {
  const draftSlot = Number(pick?.draft_slot) || 0;
  const pickNo = Number(pick?.pick_no);
  const rosterToSlot = maps?.rosterToSlot || {};
  const userToSlot = maps?.userToSlot || {};

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
  const maps = slotToRosterMaps(draft, rosters);
  const bySlot = {};
  for (const pick of picks) {
    const slot = slotForCompletedPick(pick, ownerSlotByPick, maps);
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

function isKeeperPick(pick) {
  return Boolean(pick?.is_keeper);
}

/** Live selections already made on the clock — not pre-draft keepers. */
function liveRecentPicks(picks, clockPickNo, limit = 10) {
  const clock = Number(clockPickNo) || 0;
  return (picks || [])
    .filter((p) => {
      if (isKeeperPick(p)) return false;
      const n = Number(p?.pick_no);
      return Number.isFinite(n) && n >= 1 && n < clock;
    })
    .sort((a, b) => Number(b.pick_no) - Number(a.pick_no))
    .slice(0, limit);
}

function picksFingerprint(pickList, teams = 12, rounds = 15) {
  const clock = currentPickNo(pickList, teams, rounds);
  const live = liveRecentPicks(pickList, clock, Infinity);
  const last = live[0];
  return `${clock}:${live.length}:${last?.player_id || ""}:${last?.pick_no || ""}`;
}

async function mountDraftCompanionPage() {
  const statusEl = document.querySelector("[data-draft-live='status']");
  const leagueSummaryEl = document.getElementById("draft-league-summary");
  const recEl = document.getElementById("draft-recommendations");
  const boardEl = document.getElementById("draft-board");
  const needsEl = document.getElementById("draft-needs");
  const searchInput = document.getElementById("draft-player-search");
  const searchEl = document.getElementById("draft-search-results");
  const favsOnlyInput = document.getElementById("draft-favs-only");
  const posFilterSelect = document.getElementById("draft-pos-filter");
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
  let lastScoreResult = null;
  let lastScoreById = new Map();
  let searchTimer = null;
  let lastRosterForRender = [];

  const favs = createFavourites({
    host: document.getElementById("sync-bar"),
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

  function pickTiming() {
    const settings =
      leagueSettings || resolveLeagueSettings(draft || {}, leagueForSettings());
    const teams = Number(settings.teams || 12);
    const rounds = Number(settings.rounds || draft?.settings?.rounds || 15);
    const last = teams * rounds;
    const filledPickNos = filledPickNumbers(picks, last);
    const pickNo = currentPickNo(picks, teams, rounds);
    const slot = Number(mySlot) || 1;
    const clockSlot = Number(
      ownerSlotAtPick(pickNo, teams, ownerSlotByPick)
    );
    const onClock = clockSlot === slot;
    const mine = nextOwnedPickNumbers(
      slot,
      teams,
      rounds,
      pickNo,
      ownerSlotByPick,
      filledPickNos
    );
    const nextMine = onClock ? mine[1] ?? null : mine[0] ?? pickNo;
    const until = onClock
      ? 0
      : unfilledPickCount(pickNo, mine[0] ?? pickNo, filledPickNos);
    const thisOwned = mine[0] ?? null;
    const afterOwned = mine[1] ?? null;
    const between =
      thisOwned && afterOwned
        ? unfilledPickCount(thisOwned + 1, afterOwned, filledPickNos)
        : null;
    return {
      teams,
      rounds,
      pickNo,
      nextMine,
      until,
      between,
      afterOwned,
      mine,
      settings,
      filledPickNos,
      onClock,
    };
  }

  function pickStatusLabel(n, teams) {
    const overall = Number(n);
    if (!Number.isFinite(overall) || overall <= 0) return "—";
    const roundPick = formatAdpRoundPick(overall, teams);
    const suffix = ` (${Math.round(overall)})`;
    return roundPick ? `${roundPick}${suffix}` : `${Math.round(overall)}`;
  }

  function betweenPicksLabel(n) {
    if (n == null || !Number.isFinite(Number(n))) return "";
    const count = Number(n);
    if (count <= 0) return " · consecutive";
    return count === 1 ? " · 1 pick between" : ` · ${count} picks between`;
  }

  /** Top meta: ADP freshness, current pick, and your next pick. */
  function refreshHeader() {
    const updated = formatUpdated(scoringFormat?.last_updated);
    if (!draft) {
      setStatus(updated);
      return;
    }
    if (draft.status === "complete") {
      setStatus(`${updated} · Complete`);
      return;
    }
    const { teams, pickNo, nextMine, until, between, afterOwned, mine, onClock } =
      pickTiming();
    const currentLabel = pickStatusLabel(pickNo, teams);
    const gap = betweenPicksLabel(between);
    if (onClock) {
      const after = mine[1];
      const nextBit = after
        ? ` · Next ${pickStatusLabel(after, teams)}${gap}`
        : "";
      setStatus(`${updated} · On the clock · ${currentLabel}${nextBit}`);
      return;
    }
    const thenBit =
      afterOwned && afterOwned !== nextMine
        ? ` · Then ${pickStatusLabel(afterOwned, teams)}${gap}`
        : gap && nextMine
          ? gap
          : "";
    setStatus(
      `${updated} · Pick ${currentLabel} · Next ${pickStatusLabel(nextMine, teams)} · ${until} away${thenBit}`
    );
  }

  function isLiked(id) {
    return favs.has(id);
  }

  function boardFilters() {
    const pos = String(posFilterSelect?.value || "").toUpperCase();
    return {
      favsOnly: Boolean(favsOnlyInput?.checked),
      position: SKILL_POSITIONS.includes(pos) ? pos : "",
    };
  }

  function matchesBoardFilters(player, { favsOnly, position } = boardFilters()) {
    if (favsOnly && !isLiked(sleeperIdOf(player))) return false;
    if (position && normalizePos(player.position) !== position) return false;
    return true;
  }

  function filteredRecommendationRows(result) {
    const filters = boardFilters();
    const { favsOnly, position } = filters;
    const needCount = result.need_count || {};

    let list;
    if (favsOnly || position) {
      const scoredById = new Map(
        (result.scored || result.recommendations || []).map((r) => [
          sleeperIdOf(r),
          r,
        ])
      );
      list = [];
      for (const p of boardPlayers) {
        const id = sleeperIdOf(p);
        if (!id || takenIndex.has(id)) continue;
        if (!matchesBoardFilters(p, filters)) continue;
        list.push(
          scoredById.get(id) ||
            lastScoreById.get(id) ||
            annotateScore(p, needCount)
        );
      }
      list.sort(
        (a, b) =>
          Number(b.score) - Number(a.score) ||
          Number(a.adp) - Number(b.adp) ||
          String(a.player || "").localeCompare(String(b.player || ""))
      );
    } else {
      list = (result.recommendations || []).slice();
    }
    return list.slice(0, SCORE_LIMIT);
  }

  /** Prefer user/configured league over the draft's linked league. */
  function leagueForSettings() {
    return configuredLeague || league;
  }

  function refreshLeagueSummary() {
    if (!leagueSummaryEl) return;
    if (!draft) {
      leagueSummaryEl.hidden = true;
      leagueSummaryEl.textContent = "";
      return;
    }
    const srcLeague = leagueForSettings();
    const name = String(srcLeague?.name || "").trim() || "League";
    const format =
      scoringFormat?.format_label || scoringFormat?.label || "Half PPR";
    const settings =
      leagueSettings || resolveLeagueSettings(draft || {}, srcLeague);
    const spots = formatRosterSpots(settings);
    leagueSummaryEl.textContent = spots
      ? `${name} · ${format} · ${spots}`
      : `${name} · ${format}`;
    leagueSummaryEl.hidden = false;
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
    refreshLeagueSummary();
  }

  function indexBoard(players) {
    const byPos = { QB: [], RB: [], WR: [], TE: [], DEF: [], K: [] };
    const byId = new Map();
    for (const p of players) {
      const pos = normalizePos(p.position);
      const row = pos === p.position ? p : { ...p, position: pos };
      if (byPos[pos]) byPos[pos].push(row);
      byId.set(String(p.sleeper_id), row);
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
    if (adpBoardCache.has("merged")) {
      data = adpBoardCache.get("merged");
    } else {
      data = await fetchJSON(adpPathForFormat(formatKey), {
        version: null,
      });
      adpBoardCache.set("merged", data);
      await loadHeadshots(data.last_updated);
    }
    const players = attachHeadshots(
      (data.players || []).map((p) => ({
        ...p,
        sleeper_id: sleeperIdOf(p),
        adp: playerAdpForFormat(p, formatKey),
      }))
    );
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
    const timing = pickTiming();
    if (timing.onClock) return POLL_ON_CLOCK_MS;
    if (timing.until === 1) return POLL_ON_DECK_MS;
    if (Number(timing.until) > 5) return POLL_IDLE_MS;
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

  function currentBySlot() {
    return buildSlotRosters(picks, draft, ownerSlotByPick, leagueRosters);
  }

  function updateMeta() {
    refreshHeader();
  }

  function cacheScoreResult(result) {
    lastScoreResult = result;
    const rows = result?.scored || result?.recommendations || [];
    lastScoreById = new Map(rows.map((r) => [sleeperIdOf(r), r]));
  }

  function renderRosterCounts(roster = lastRosterForRender) {
    lastRosterForRender = roster;
    const byPos = {};
    for (const p of roster) {
      const pos = normalizePos(p.position);
      (byPos[pos] = byPos[pos] || []).push(p);
    }
    const rosterPositions = ["QB", "RB", "WR", "TE", "DEF", "K"].filter((pos) => {
      if (pos === "DEF") return Number(leagueSettings?.slots_def ?? 1) > 0;
      if (pos === "K") return Number(leagueSettings?.slots_k ?? 1) > 0;
      return true;
    });
    needsEl.innerHTML = `
      <div class="draft-roster-grid">
        ${rosterPositions
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

  function pickRowData(p) {
    const meta = p.metadata || {};
    const name = `${meta.first_name || ""} ${meta.last_name || ""}`.trim();
    const id = String(p.player_id || "");
    const board = boardById.get(id) || {
      sleeper_id: id,
      player: name,
      team: meta.team || meta.team_abbr,
      position: meta.position,
    };
    return { pick: p, meta, name, id, board };
  }

  function updatePickRow(tr, row, teams) {
    const liked = isLiked(row.id);
    tr.className = liked ? "draft-liked" : "";
    tr.children[0].innerHTML = pickNoHtml(row.pick.pick_no, teams);
    if (!tr.dataset.playerBound) {
      tr.children[1].innerHTML = playerCellHtml(row.board, {
        name: row.name,
        liked,
      });
      tr.dataset.playerBound = "1";
    } else {
      tr.classList.toggle("draft-liked", liked);
      const star = tr.querySelector(".draft-star");
      if (star) {
        star.classList.toggle("is-liked", liked);
        star.setAttribute("aria-pressed", liked ? "true" : "false");
      }
    }
    tr.children[2].textContent = row.meta.position || "";
  }

  function renderRecentPicks() {
    const clock = pickTiming().pickNo;
    const recent = liveRecentPicks(picks, clock, 10);
    const teams = leagueTeamCount();
    if (!recent.length) {
      showTableMessage(boardEl, `<p class="meta">No picks yet</p>`);
      return;
    }
    const tbody = ensureTableBody(boardEl, {
      tableClass: "draft-table",
      theadHtml: PICKS_TABLE_HEAD,
    });
    const rows = recent.map((p) => pickRowData(p));
    syncTableRows(tbody, rows, {
      key: (row) => String(row.pick.pick_no),
      createRow: (row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td class="num"></td><td></td><td></td>`;
        updatePickRow(tr, row, teams);
        return tr;
      },
      updateRow: (tr, row) => updatePickRow(tr, row, teams),
    });
  }

  function updateRecRow(tr, r, teams) {
    const liked = isLiked(sleeperIdOf(r));
    tr.className = liked ? "draft-liked" : "";
    if (!tr.dataset.playerBound) {
      tr.innerHTML = scoreRowCells(r, { liked, teams });
      tr.dataset.playerBound = "1";
      return;
    }
    tr.classList.toggle("draft-liked", liked);
    const star = tr.querySelector(".draft-star");
    if (star) {
      star.classList.toggle("is-liked", liked);
      star.setAttribute("aria-pressed", liked ? "true" : "false");
    }
    tr.children[1].textContent = r.position || "";
    tr.children[2].innerHTML = adpHtml(r.adp, teams);
    tr.children[3].innerHTML = needBonusHtml(r.need_bonus);
    tr.children[4].textContent = String(r.score ?? "—");
    tr.children[5].innerHTML = gapHtml(r.gap);
    tr.children[6].innerHTML = riskHtml(r);
  }

  function renderRecommendationsFromCache() {
    if (!recEl) return;
    if (!draft) return;
    if (draft.status === "complete") {
      showTableMessage(recEl, `<p class="meta">Draft complete.</p>`);
      return;
    }
    const result = lastScoreResult;
    if (!result) return;
    const filters = boardFilters();
    const recs = filteredRecommendationRows(result);
    if (!recs.length) {
      const emptyMsg =
        filters.favsOnly || filters.position
          ? "No players match the current filters."
          : "No draftable players left on the board.";
      showTableMessage(recEl, `<p class="meta">${emptyMsg}</p>`);
      return;
    }
    const teams = leagueTeamCount();
    const gapSource =
      filters.favsOnly || filters.position ? recs : result.scored || recs;
    const rows = withPosGaps(recs, gapSource);
    const tbody = ensureTableBody(recEl, {
      tableClass: "draft-table",
      theadHtml: RECS_TABLE_HEAD,
    });
    syncTableRows(tbody, rows, {
      key: (r) => sleeperIdOf(r),
      createRow: (r) => {
        const tr = document.createElement("tr");
        updateRecRow(tr, r, teams);
        return tr;
      },
      updateRow: (tr, r) => updateRecRow(tr, r, teams),
    });
  }

  function matchesSearch(player, query) {
    if (!query) return false;
    const name = String(player.player || player.name || "").toLowerCase();
    const team = String(player.team || "").toLowerCase();
    const pos = String(player.position || "").toLowerCase();
    return name.includes(query) || team.includes(query) || pos === query;
  }

  function updateSearchRow(tr, entry, teams) {
    const { player, scored, taken: isTaken } = entry;
    const id = sleeperIdOf(player);
    const liked = isLiked(id);
    tr.className = [liked ? "draft-liked" : "", isTaken ? "draft-taken" : ""]
      .filter(Boolean)
      .join(" ");
    if (!tr.dataset.playerBound) {
      tr.innerHTML = `<td></td><td></td><td class="num"></td><td class="num"></td>`;
      tr.dataset.playerBound = "1";
      tr.children[0].innerHTML = playerCellHtml(player, { liked });
    } else {
      tr.classList.toggle("draft-liked", liked);
      const star = tr.querySelector(".draft-star");
      if (star) {
        star.classList.toggle("is-liked", liked);
        star.setAttribute("aria-pressed", liked ? "true" : "false");
      }
    }
    tr.children[1].textContent = player.position || "";
    tr.children[2].innerHTML = adpHtml(player.adp, teams);
    tr.children[3].innerHTML = isTaken
      ? `<span class="draft-taken-label">Taken</span>`
      : escapeHtml(String((scored || {}).score ?? "—"));
    if (!isTaken) tr.children[3].className = "num";
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

    const filters = boardFilters();
    const available = [];
    const taken = [];
    for (const p of boardPlayers) {
      if (!matchesSearch(p, query)) continue;
      if (!matchesBoardFilters(p, filters)) continue;
      const id = sleeperIdOf(p);
      if (takenIndex.has(id)) taken.push(p);
      else available.push(p);
    }

    const rankedAvailable = available
      .map((p) => {
        const scored =
          lastScoreById.get(sleeperIdOf(p)) ||
          (lastScoreResult
            ? annotateScore(p, lastScoreResult.need_count || {})
            : null);
        return {
          player: p,
          scored,
          sortScore: scored?.score ?? -Number(p.adp || 9999),
          taken: false,
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
      showTableMessage(
        searchEl,
        `<p class="meta">No players match “${escapeHtml(searchInput.value.trim())}”.</p>`
      );
      return;
    }

    const teams = leagueTeamCount();
    const tbody = ensureTableBody(searchEl, {
      tableClass: "draft-table",
      theadHtml: SEARCH_TABLE_HEAD,
    });
    syncTableRows(tbody, rows, {
      key: (entry) => `${sleeperIdOf(entry.player)}:${entry.taken ? "t" : "a"}`,
      createRow: (entry) => {
        const tr = document.createElement("tr");
        updateSearchRow(tr, entry, teams);
        return tr;
      },
      updateRow: (tr, entry) => updateSearchRow(tr, entry, teams),
    });
  }

  function scoreContext() {
    const timing = pickTiming();
    const bySlot = currentBySlot();
    const myRoster = enrichRoster(bySlot[mySlot] || []);
    return {
      timing,
      bySlot,
      myRoster,
      fp: picksFingerprint(picks, timing.teams, timing.rounds),
      myFp: myRosterFingerprint(myRoster),
    };
  }

  function renderScores(ctx) {
    if (!draft) return;
    const timing = ctx?.timing || pickTiming();
    const settings = timing.settings;
    const bySlot = ctx?.bySlot || currentBySlot();
    const myRoster = ctx?.myRoster || enrichRoster(bySlot[mySlot] || []);
    updateMeta();
    lastMyRosterFp = ctx?.myFp || myRosterFingerprint(myRoster);

    const byPos = availableByPos();
    const scoreArgs = {
      availableByPos: byPos,
      myRoster,
      opponentRosters: bySlot,
      settings,
      teams: timing.teams,
      mySlot,
      currentPickNo: timing.pickNo,
      rounds: timing.rounds,
      limit: SCORE_LIMIT,
      ownerSlotByPick,
      filledPickNos: timing.filledPickNos,
    };

    // Paint rankings immediately; risk sim is the slow part and only matters
    // on the clock for comparing pass-vs-take.
    const result = scoreCandidates({ ...scoreArgs, includeRisk: false });

    hasScoredOnce = true;
    lastScoredFingerprint = picksFingerprint(
      picks,
      timing.teams,
      timing.rounds
    );
    cacheScoreResult(result);

    renderRosterCounts(myRoster);
    renderRecommendationsFromCache();
    renderSearchResults();

    if (!timing.onClock) return;

    const gen = scoreGen;
    const jobId = ++riskJobSeq;
    const worker = getRiskWorker();
    const onMessage = (event) => {
      if (event.data?.jobId !== jobId || gen !== scoreGen) return;
      worker.removeEventListener("message", onMessage);
      if (!event.data?.ok) return;
      const base = scoreCandidates({ ...scoreArgs, includeRisk: false });
      const withRisk = applyRiskToResult(base, event.data.goneProbById || {});
      if (gen !== scoreGen) return;
      cacheScoreResult(withRisk);
      renderRecommendationsFromCache();
      renderSearchResults();
    };
    worker.addEventListener("message", onMessage);
    requestAnimationFrame(() => {
      worker.postMessage({ jobId, args: scoreArgs });
    });
  }

  function renderAll() {
    renderRecentPicks();
    renderScores();
  }

  function queueScoreRender({ force = false } = {}) {
    const ctx = draft ? scoreContext() : null;
    const timing = ctx?.timing || null;

    if (
      !force &&
      ctx &&
      ctx.fp === lastScoredFingerprint &&
      ctx.myFp === lastMyRosterFp &&
      hasScoredOnce
    ) {
      if (timing) updateMeta();
      return;
    }

    const gen = ++scoreGen;
    requestAnimationFrame(() => {
      if (gen !== scoreGen) return;
      renderScores(ctx);
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
        // Status only — pick owners / trades were loaded at connect and do not
        // change mid-draft.
        draft = await sleeperGet(`/draft/${draftId}`);
      }
      const next = nextPicks || [];
      const teams = Number(leagueSettings?.teams || draft?.settings?.teams || 12);
      const rounds = Number(draft?.settings?.rounds || leagueSettings?.rounds || 15);
      const fingerprint = picksFingerprint(next, teams, rounds);
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
    const [draftData, picksData] = await Promise.all([
      sleeperGet(`/draft/${draftId}`),
      sleeperGet(`/draft/${draftId}/picks`),
    ]);
    draft = draftData;
    league = await fetchLeagueForDraft(draft);
    await Promise.all([
      loadLeagueRosters().catch(() => {
        leagueRosters = [];
      }),
      loadTradedPicks().catch(() => {
        tradedPicks = [];
      }),
      loadAdpBoard(scoringFormat),
    ]);
    picks = picksData || [];

    if (!resolveLeagueIdInput(leagueInput?.value || "") && league) {
      configuredLeague = league;
    }

    refreshLeagueSettings();
    rebuildPickOwners();
    lastFingerprint = picksFingerprint(
      picks,
      Number(leagueSettings?.teams || draft?.settings?.teams || 12),
      Number(draft?.settings?.rounds || leagueSettings?.rounds || 15)
    );
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
    favs.toggle(btn.getAttribute("data-player-id"));
  });

  searchInput?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderSearchResults(), 120);
  });

  function onBoardFilterChange() {
    if (lastScoreResult) renderRecommendationsFromCache();
    renderSearchResults();
  }
  favsOnlyInput?.addEventListener("change", onBoardFilterChange);
  posFilterSelect?.addEventListener("change", onBoardFilterChange);

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
    await favs.hydrate();

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
