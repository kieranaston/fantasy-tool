import { fetchJSON, showError, revealPage } from "./config.js?v=2";
import {
  scoreCandidates,
  nextPickNumbers,
  resolveLeagueSettings,
  resolveScoringFormat,
  projectionsPathForFormat,
  rescoreProjectionBoard,
  overlayAdpFromPlayers,
  formatFromReceptionPoints,
  formatAdpRoundPick,
  SKILL_POSITIONS,
  SCORING_FORMATS,
  FORMAT_LABELS,
} from "./draft-scoring.js?v=66";
import {
  loadLikedIds,
  toggleLikedId,
} from "./draft-liked.js?v=1";

/** Fast on your turn / on deck; slower while waiting. */
const POLL_ON_CLOCK_MS = 1200;
const POLL_ON_DECK_MS = 1500;
const POLL_WAITING_MS = 2500;
const POLL_IDLE_MS = 5000;
const DRAFT_META_EVERY = 12;
const LS_LEAGUE = "draft-companion:league-id";
const LS_DRAFT = "draft-companion:draft-id";
const SEARCH_LIMIT = 24;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sleeperIdOf(player) {
  return String(player?.sleeper_id || player?.player_id || "");
}

function playerMediaHtml(player, { name, compact = false } = {}) {
  const display = escapeHtml(
    name || player?.player || player?.name || player?.player_name || ""
  );
  const headshot = player?.headshot;
  const logo = player?.logo;
  const team = player?.team ? String(player.team).toUpperCase() : "";
  const headshotHtml = headshot
    ? `<img class="player-headshot" src="${escapeHtml(headshot)}" alt="" width="28" height="28" loading="lazy" decoding="async" />`
    : `<span class="player-headshot player-headshot--empty" aria-hidden="true"></span>`;
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
  const mediaClass = compact ? "player-media player-media--compact" : "player-media";
  return `<span class="${mediaClass}">${headshotHtml}<span class="player-media-text"><span class="player-media-name">${display}</span>${teamHtml}</span></span>`;
}

function starButtonHtml(playerId, liked) {
  const id = escapeHtml(playerId);
  const on = Boolean(liked);
  return `<button type="button" class="draft-star${on ? " is-liked" : ""}" data-player-id="${id}" aria-label="${on ? "Unstar player" : "Star player"}" aria-pressed="${on ? "true" : "false"}">★</button>`;
}

function playerCellHtml(player, { name, compact = false, liked = false } = {}) {
  const id = sleeperIdOf(player);
  return `<span class="draft-player-cell">${starButtonHtml(id, liked)}${playerMediaHtml(player, { name, compact })}</span>`;
}

function needBonusHtml(needBonus) {
  if (needBonus > 0) return `+${escapeHtml(needBonus)}`;
  if (needBonus < 0) return `${escapeHtml(needBonus)}`;
  return "—";
}

function riskHtml(risk) {
  if (risk > 0.05) return `${escapeHtml(Math.round(risk * 100))}%`;
  return "—";
}

function adpHtml(adp) {
  const label = formatAdpRoundPick(adp, 12);
  return label == null ? "—" : escapeHtml(label);
}

function scoreRowCells(r, { liked = false } = {}) {
  return `
    <td>${playerCellHtml(r, { liked })}</td>
    <td>${escapeHtml(r.position)}</td>
    <td>${r.bye_week == null ? "—" : escapeHtml(r.bye_week)}</td>
    <td>${escapeHtml(r.vorp)}</td>
    <td>${needBonusHtml(r.need_bonus)}</td>
    <td>${adpHtml(r.adp)}</td>
    <td>${riskHtml(r.risk)}</td>
    <td><strong>${escapeHtml(r.score)}</strong></td>`;
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

function buildSlotRosters(picks) {
  const bySlot = {};
  for (const pick of picks) {
    const slot = Number(pick.draft_slot);
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
  const metaEl = document.querySelector("[data-draft-live='summary']");
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

  let projections = [];
  let projectionsByPos = { QB: [], RB: [], WR: [], TE: [] };
  let projectionsById = new Map();
  let scoringFormat = resolveScoringFormat();
  /** Baked league.json fallback from the data pipeline. */
  let defaultLeague = null;
  /** Active league for scoring/slots (user league ID or default). */
  let configuredLeague = null;
  /** Raw FantasyPros custom board (with stats) before live re-score. */
  let customBoardRaw = null;
  /** Cached format boards used only for ADP overlays. */
  const adpBoardCache = new Map();

  async function loadAdpOverlayPlayers(formatKey) {
    const key = SCORING_FORMATS.includes(formatKey) ? formatKey : "half_ppr";
    if (adpBoardCache.has(key)) return adpBoardCache.get(key);
    try {
      const data = await fetchJSON(projectionsPathForFormat(key));
      const players = data?.players || [];
      adpBoardCache.set(key, players);
      return players;
    } catch {
      adpBoardCache.set(key, []);
      return [];
    }
  }

  function adpFormatKey(formatInfo, scoring = {}) {
    const fromInfo =
      formatInfo?.format && formatInfo.format !== "custom"
        ? formatInfo.format
        : null;
    if (fromInfo && SCORING_FORMATS.includes(fromInfo)) return fromInfo;
    return formatFromReceptionPoints(scoring.rec) || "half_ppr";
  }

  async function withFormatAdp(players, formatInfo, scoring) {
    const formatKey = adpFormatKey(formatInfo, scoring);
    const adpPlayers = await loadAdpOverlayPlayers(formatKey);
    return {
      players: overlayAdpFromPlayers(players, adpPlayers),
      adpFormat: formatKey,
    };
  }
  let takenIndex = new Set();
  let pollTimer = null;
  let draftId = null;
  let draft = null;
  let league = null;
  let leagueSettings = null;
  let picks = [];
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

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function isLiked(id) {
    return likedIds.has(String(id || ""));
  }

  function toggleLiked(id) {
    likedIds = toggleLikedId(likedIds, id);
    const key = String(id || "");
    const on = likedIds.has(key);
    rootEl?.querySelectorAll(`.draft-star[data-player-id="${CSS.escape(key)}"]`).forEach((btn) => {
      btn.classList.toggle("is-liked", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", on ? "Unstar player" : "Star player");
      const row = btn.closest("tr, li");
      if (row) row.classList.toggle("draft-liked", on);
    });
  }

  function persistInputs() {
    if (leagueInput) {
      localStorage.setItem(LS_LEAGUE, leagueInput.value.trim());
    }
    if (draftInput) {
      localStorage.setItem(LS_DRAFT, draftInput.value.trim());
    }
  }

  /** Prefer user/configured league over the draft's linked league. */
  function leagueForSettings() {
    return configuredLeague || league;
  }

  function refreshLeagueSettings() {
    const srcLeague = leagueForSettings();
    leagueSettings = resolveLeagueSettings(draft || {}, srcLeague);
    scoringFormat = resolveScoringFormat(draft || {}, srcLeague);
  }

  function indexProjections(players) {
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    const byId = new Map();
    for (const p of players) {
      if (byPos[p.position]) byPos[p.position].push(p);
      byId.set(String(p.sleeper_id), p);
    }
    for (const pos of SKILL_POSITIONS) {
      byPos[pos].sort((a, b) => Number(b.pts) - Number(a.pts));
    }
    projectionsByPos = byPos;
    projectionsById = byId;
  }

  function applyScoredPlayers(players, formatInfo, meta = {}) {
    projections = players;
    indexProjections(projections);
    const custom = Boolean(meta.custom);
    const adpFormat = meta.adp_format || formatInfo?.format || null;
    const adpLabel =
      adpFormat && FORMAT_LABELS[adpFormat] ? FORMAT_LABELS[adpFormat] : null;
    scoringFormat = {
      ...formatInfo,
      format: custom ? "custom" : meta.format || formatInfo.format,
      label: custom
        ? `${formatInfo?.label || "Custom"} · FantasyPros`
        : formatInfo?.label || meta.format || "Half PPR",
      board_source: meta.source || (custom ? "fantasypros_csv" : "sleeper"),
      adp_format: adpFormat,
      league_id:
        meta.league_id ||
        configuredLeague?.league_id ||
        defaultLeague?.league_id ||
        null,
    };
    if (custom && adpLabel) {
      scoringFormat.label = `${adpLabel} · FantasyPros`;
    }
  }

  async function loadProjectionsForFormat(formatInfo) {
    const scoring = leagueForSettings()?.scoring_settings || {};

    if (!customBoardRaw) {
      try {
        const data = await fetchJSON("draft/projections-custom.json");
        if (data?.players?.length) customBoardRaw = data;
      } catch {
        customBoardRaw = null;
      }
    }

    if (customBoardRaw?.players?.length) {
      const scored = rescoreProjectionBoard(customBoardRaw.players, scoring);
      // Drop bulky raw stats after pts are baked — keeps memory/GC lighter.
      for (const p of scored) {
        if (p.stats) delete p.stats;
      }
      const { players: withAdp, adpFormat } = await withFormatAdp(
        scored,
        formatInfo,
        scoring
      );
      applyScoredPlayers(withAdp, formatInfo, {
        custom: true,
        source: "fantasypros_csv",
        league_id: configuredLeague?.league_id || customBoardRaw.league_id,
        format: "custom",
        adp_format: adpFormat,
      });
      return;
    }

    const path = projectionsPathForFormat(formatInfo?.format);
    const data = await fetchJSON(path);
    applyScoredPlayers(data.players || [], formatInfo, {
      custom: false,
      source: data.source || "sleeper",
      format: data.format,
      league_id: configuredLeague?.league_id || null,
      adp_format: data.format,
    });
  }

  /**
   * Load scoring/slots from the league ID field (falls back to league.json).
   */
  async function loadConfiguredLeague({ required = false } = {}) {
    const raw = leagueInput?.value?.trim() || "";
    const leagueId = resolveLeagueIdInput(raw);
    if (leagueId) {
      try {
        configuredLeague = await fetchLeagueById(leagueId);
        if (leagueInput && !raw.includes(leagueId)) {
          leagueInput.value = leagueId;
        }
        return configuredLeague;
      } catch (err) {
        if (required) throw new Error(`League lookup failed: ${err.message}`);
        setStatus(`League lookup failed (${err.message}); using defaults`);
      }
    }
    configuredLeague = defaultLeague;
    if (!configuredLeague && required) {
      throw new Error("Enter a Sleeper league ID for custom scoring");
    }
    return configuredLeague;
  }

  function enrichRoster(roster = []) {
    return roster.map((p) => {
      const proj = projectionsById.get(String(p.player_id));
      return {
        ...p,
        pts: proj?.pts,
        bye_week: proj?.bye_week ?? p.bye_week ?? null,
      };
    });
  }

  function availableByPos() {
    const out = {};
    for (const pos of SKILL_POSITIONS) {
      out[pos] = (projectionsByPos[pos] || []).filter(
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

  function pickTiming() {
    const settings = leagueSettings || resolveLeagueSettings(draft || {}, leagueForSettings());
    const teams = Number(settings.teams || 12);
    const rounds = Number(settings.rounds || draft?.settings?.rounds || 15);
    const pickNo = currentPickNo(picks);
    const mine = nextPickNumbers(mySlot, teams, rounds, pickNo);
    const nextMine = mine[0] ?? pickNo;
    const until = Math.max(0, nextMine - pickNo);
    return { teams, rounds, pickNo, nextMine, until, settings };
  }

  function currentBySlot() {
    return buildSlotRosters(picks);
  }

  function updateMeta(timing, { onClock } = {}) {
    if (!metaEl || !draft) return;
    const src = configuredLeague
      ? configuredLeague.name || "league settings"
      : timing.settings?.source === "league"
        ? "league slots"
        : "draft slots";
    const slots = timing.settings;
    const parts = [
      `${draft.metadata?.name || league?.name || "Draft"}`,
      `${draft.status}`,
      scoringFormat?.label || "Half PPR",
      `pick ${Math.min(timing.pickNo, timing.teams * timing.rounds)}`,
      `you: slot ${mySlot}`,
      `next yours: ${timing.nextMine}`,
      `${src}: QB${slots.slots_qb}/RB${slots.slots_rb}/WR${slots.slots_wr}/TE${slots.slots_te}/FLEX${slots.slots_flex}`,
    ];
    if (!onClock) {
      parts.push(
        timing.until === 1 ? "on deck" : `waiting (${timing.until} picks)`
      );
    } else {
      parts.push("your pick");
    }
    metaEl.textContent = parts.join(" · ");
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
                    const proj =
                      projectionsById.get(id) || p;
                    return `<li class="${liked ? "draft-liked" : ""}">${playerCellHtml(proj, {
                      name: p.name || proj.player || p.player_id,
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
              const proj = projectionsById.get(id) || {
                sleeper_id: id,
                player: name,
                team: meta.team || meta.team_abbr,
                position: meta.position,
              };
              return `<tr class="${liked ? "draft-liked" : ""}">
                <td>${escapeHtml(p.pick_no)}</td>
                <td>${escapeHtml(p.draft_slot)}</td>
                <td>${playerCellHtml(proj, { name, compact: true, liked })}</td>
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
    const recs = (result.recommendations || []).slice(0, 8);
    if (!recs.length) {
      recEl.innerHTML = `<p class="meta">No skill players left on the board.</p>`;
      return;
    }
    const vorpPct = Math.round((Number(result.vorp_weight) || 0) * 100);
    recEl.innerHTML = `
      <p class="meta">Blend: ${vorpPct}% VORP / ${100 - vorpPct}% ADP</p>
      <table class="draft-table cell-border">
        <thead>
          <tr>
            <th>#</th><th>Player</th><th>Pos</th><th>Bye</th>
            <th>VORP</th><th>Need</th><th>ADP</th><th>Risk</th><th>Score</th>
          </tr>
        </thead>
        <tbody>
          ${recs
            .map((r, i) => {
              const liked = isLiked(sleeperIdOf(r));
              return `
            <tr class="${liked ? "draft-liked" : ""}">
              <td>${i + 1}</td>
              ${scoreRowCells(r, { liked })}
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
      searchEl.innerHTML = `<p class="meta">Type to search players and see live scores.</p>`;
      return;
    }

    const available = [];
    const taken = [];
    for (const p of projections) {
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
          sortScore: scored?.score ?? (Number(p.pts) || 0),
        };
      })
      .sort((a, b) => b.sortScore - a.sortScore)
      .slice(0, SEARCH_LIMIT);

    const rankedTaken = taken
      .slice()
      .sort((a, b) => (Number(b.pts) || 0) - (Number(a.pts) || 0))
      .slice(0, Math.max(0, SEARCH_LIMIT - rankedAvailable.length))
      .map((p) => ({ player: p, scored: null, taken: true }));

    const rows = [...rankedAvailable, ...rankedTaken];
    if (!rows.length) {
      searchEl.innerHTML = `<p class="meta">No players match “${escapeHtml(searchInput.value.trim())}”.</p>`;
      return;
    }

    const live = Boolean(draft && lastScoreById.size);
    searchEl.innerHTML = `
      <table class="draft-table cell-border">
        <thead>
          <tr>
            <th>Player</th><th>Pos</th><th>Bye</th>
            <th>VORP</th><th>Need</th><th>ADP</th><th>Risk</th><th>Score</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(({ player, scored, taken: isTaken }) => {
              const id = sleeperIdOf(player);
              const liked = isLiked(id);
              const row = scored || {
                ...player,
                vorp: "—",
                need_bonus: 0,
                adp: player.adp,
                risk: 0,
                score: live ? "—" : player.pts != null ? player.pts : "—",
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
                <td>${scored ? escapeHtml(scored.vorp) : "—"}</td>
                <td>${scored ? needBonusHtml(scored.need_bonus) : "—"}</td>
                <td>${adpHtml(player.adp)}</td>
                <td>${scored ? riskHtml(scored.risk) : "—"}</td>
                ${scoreCell}
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  function renderLikedSurfaces() {
    renderRosterCounts(lastRosterForRender);
    renderRecentPicks();
    renderRecommendationsFromCache();
    renderSearchResults();
  }

  function renderScores() {
    if (!draft) return;
    const timing = pickTiming();
    const settings = timing.settings;
    const onClock = timing.until <= 0;
    const bySlot = currentBySlot();
    const myRoster = enrichRoster(bySlot[mySlot] || []);
    updateMeta(timing, { onClock });
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
        const prevFormat = scoringFormat?.format;
        const wasCustom =
          scoringFormat?.board_source === "fantasypros_csv" ||
          scoringFormat?.format === "custom";
        refreshLeagueSettings();
        if (wasCustom) {
          scoringFormat = {
            ...scoringFormat,
            format: "custom",
            label: `${scoringFormat.label} · FantasyPros`,
            board_source: "fantasypros_csv",
          };
        } else if (scoringFormat.format !== prevFormat) {
          await loadProjectionsForFormat(scoringFormat);
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
        updateMeta(pickTiming(), { onClock: pickTiming().until <= 0 });
      }
      const timing = pickTiming();
      setStatus(
        `Live · ${draft?.status || "?"} · ${picks.length} picks · ${scoringFormat.label}` +
          (timing.until === 0 ? " · YOUR PICK" : ` · yours in ${timing.until}`) +
          ` · ${new Date().toLocaleTimeString()}`
      );
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
    persistInputs();

    await loadConfiguredLeague({ required: false });
    if (!draftInput?.value?.trim()) {
      throw new Error("Enter a Sleeper draft id or draft URL");
    }
    draftId = await resolveDraftId(draftInput.value);
    draft = await sleeperGet(`/draft/${draftId}`);
    league = await fetchLeagueForDraft(draft);

    // If no league ID entered, adopt the draft's league when available.
    if (!resolveLeagueIdInput(leagueInput?.value || "") && league) {
      configuredLeague = league;
      if (leagueInput && league.league_id) {
        leagueInput.value = String(league.league_id);
        persistInputs();
      }
    }

    refreshLeagueSettings();
    await loadProjectionsForFormat(scoringFormat);
    picks = (await sleeperGet(`/draft/${draftId}/picks`)) || [];
    lastFingerprint = picksFingerprint(picks);
    rebuildTaken();
    fillSeats();
    const leagueName = configuredLeague?.name || "draft settings";
    setStatus(
      `Connected · ${draft.status} · ${picks.length} picks · ${scoringFormat.label} · ${leagueName}`
    );
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
    setStatus(paused ? "Paused" : "Live");
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

  function bindPersist(el) {
    el?.addEventListener("change", persistInputs);
    el?.addEventListener("blur", persistInputs);
  }
  bindPersist(leagueInput);
  bindPersist(draftInput);

  leagueInput?.addEventListener("change", () => {
    loadConfiguredLeague({ required: false })
      .then(() => {
        refreshLeagueSettings();
        return loadProjectionsForFormat(scoringFormat);
      })
      .then(() => {
        const name = configuredLeague?.name || "default";
        setStatus(`League · ${name} · ${scoringFormat.label}`);
        if (draftId) queueScoreRender({ force: true });
        else renderSearchResults();
      })
      .catch((err) => setStatus(err.message));
  });

  try {
    try {
      defaultLeague = await fetchJSON("draft/league.json");
    } catch {
      defaultLeague = null;
    }

    const savedLeague =
      localStorage.getItem(LS_LEAGUE) ||
      defaultLeague?.league_id ||
      "";
    const savedDraft =
      localStorage.getItem(LS_DRAFT) ||
      localStorage.getItem("draft-companion:last-id") ||
      "";
    if (leagueInput && savedLeague) leagueInput.value = savedLeague;
    if (draftInput && savedDraft) draftInput.value = savedDraft;

    await loadConfiguredLeague({ required: false });
    refreshLeagueSettings();
    await loadProjectionsForFormat(scoringFormat);
    const leagueLabel = configuredLeague?.name
      ? `${configuredLeague.name} · ${scoringFormat.label}`
      : `${scoringFormat.label} board`;
    setStatus(`Ready · ${leagueLabel}`);
    renderSearchResults();
    revealPage();
  } catch (err) {
    showError(recEl, err.message);
    revealPage();
  }
}

export { mountDraftCompanionPage };
