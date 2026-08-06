import { fetchJSON, showError, revealPage } from "./config.js";
import {
  scoreCandidates,
  nextPickNumbers,
  rosterPositionCounts,
  draftTargets,
  resolveLeagueSettings,
  SKILL_POSITIONS,
} from "./draft-scoring.js?v=34";

/** Fast on your turn / on deck; slower while waiting. */
const POLL_ON_CLOCK_MS = 500;
const POLL_ON_DECK_MS = 800;
const POLL_WAITING_MS = 1500;
const POLL_IDLE_MS = 4000;
const DRAFT_META_EVERY = 12;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sleeperGet(path) {
  const response = await fetch(`https://api.sleeper.app/v1${path}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Sleeper ${path}: ${response.status}`);
  return response.json();
}

function parseDraftInput(raw) {
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
  if (/^\d+$/.test(text)) return { type: "unknown", id: text };
  return null;
}

async function resolveDraftId(raw) {
  const parsed = parseDraftInput(raw);
  if (!parsed) throw new Error("Enter a Sleeper league id, draft id, or URL");
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
    /* fall through */
  }
  const drafts = await sleeperGet(`/league/${parsed.id}/drafts`);
  if (!drafts?.length) throw new Error("Could not resolve draft id");
  return String(drafts[0].draft_id);
}

function leagueIdFromDraft(draft) {
  if (!draft) return null;
  if (draft.league_id) return String(draft.league_id);
  const metaId = draft.metadata?.league_id;
  if (metaId) return String(metaId);
  return null;
}

async function fetchLeagueForDraft(draft) {
  const id = leagueIdFromDraft(draft);
  if (!id) return null;
  try {
    return await sleeperGet(`/league/${id}`);
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
  const connectBtn = document.getElementById("draft-connect");
  const pauseBtn = document.getElementById("draft-pause");
  const input = document.getElementById("draft-id-input");
  const seatSelect = document.getElementById("draft-seat");

  let projections = [];
  let projectionsByPos = { QB: [], RB: [], WR: [], TE: [] };
  let projectionsById = new Map();
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

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function refreshLeagueSettings() {
    leagueSettings = resolveLeagueSettings(draft || {}, league);
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
    const settings = leagueSettings || resolveLeagueSettings(draft || {}, league);
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
    const src = timing.settings?.source === "league" ? "league slots" : "draft slots";
    const slots = timing.settings;
    const parts = [
      `${draft.metadata?.name || league?.name || "Draft"}`,
      `${draft.status}`,
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

  function renderRosterCounts(roster, result = null) {
    const counts = rosterPositionCounts(roster);
    const targets = result?.targets || draftTargets(leagueSettings || {});
    const total =
      (counts.QB || 0) + (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0);
    needsEl.innerHTML = `
      <div class="draft-needs-grid">
        ${["QB", "RB", "WR", "TE"]
          .map((pos) => {
            const have = counts[pos] || 0;
            return `<div><strong>${pos}</strong> ${escapeHtml(String(have))}</div>`;
          })
          .join("")}
        <div><strong>FLEX open</strong> ${escapeHtml(
          String(result?.myOpenFlex ?? "—")
        )}</div>
        <div><strong>Total</strong> ${escapeHtml(String(total))} / ${escapeHtml(
          String(targets.total)
        )}</div>
      </div>`;
  }

  function renderRecentPicks() {
    const recent = [...picks].slice(-12).reverse();
    boardEl.innerHTML = `
      <table class="draft-table cell-border">
        <thead><tr><th>Pick</th><th>Slot</th><th>Player</th><th>Pos</th></tr></thead>
        <tbody>
          ${recent
            .map((p) => {
              const meta = p.metadata || {};
              const name = `${meta.first_name || ""} ${meta.last_name || ""}`.trim();
              return `<tr>
                <td>${escapeHtml(p.pick_no)}</td>
                <td>${escapeHtml(p.draft_slot)}</td>
                <td>${escapeHtml(name)}</td>
                <td>${escapeHtml(meta.position || "")}</td>
              </tr>`;
            })
            .join("") || `<tr><td colspan="4">No picks yet</td></tr>`}
        </tbody>
      </table>`;
  }

  function roleTags(r) {
    if (!r.is_rookie) return "";
    return `<span class="draft-tag">rookie</span>`;
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
    });

    hasScoredOnce = true;
    lastScoredFingerprint = picksFingerprint(picks);

    renderRosterCounts(myRoster, result);

    const recs = result.recommendations.slice(0, 8);
    if (!recs.length) {
      recEl.innerHTML = `<p class="meta">No players left under your roster caps.</p>`;
      return;
    }

    const atRiskCount = result.predictedAtRisk?.length || 0;
    const beforeCount = result.predictedBeforeYou?.length || 0;
    let tip;
    if (result.topPick?.score > 0) {
      tip = result.topPick.at_risk
        ? `Take ${result.topPick.player} — best score among players predicted gone before your next turn.`
        : `No urgency — bank ${result.topPick.player} (best score available).`;
    } else {
      tip = result.topPick?.at_risk
        ? `No value over replacement left — take ${result.topPick.player} (at risk, best ADP).`
        : `No value over replacement left — bank ${result.topPick?.player || "best ADP"} (lowest ADP available).`;
    }

    recEl.innerHTML = `
      <p class="meta">${escapeHtml(tip)} · ADP sim: ${escapeHtml(
        String(beforeCount)
      )} before you, ${escapeHtml(String(atRiskCount))} at risk until next turn.</p>
      <table class="draft-table cell-border">
        <thead>
          <tr>
            <th>#</th><th>Player</th><th>Pos</th><th>Bye</th><th>Score</th>
            <th>VORP</th><th>Need</th><th>ADP</th><th>At risk</th>
          </tr>
        </thead>
        <tbody>
          ${recs
            .map(
              (r, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>
                <div class="draft-player-cell">
                  <span>${escapeHtml(r.player)}</span>
                  ${roleTags(r)}
                </div>
              </td>
              <td>${escapeHtml(r.position)}</td>
              <td>${r.bye_week == null ? "—" : escapeHtml(r.bye_week)}</td>
              <td><strong>${escapeHtml(r.score)}</strong></td>
              <td>${escapeHtml(r.vorp)}</td>
              <td>${r.need_bonus ? `+${escapeHtml(r.need_bonus)}` : "—"}</td>
              <td>${r.adp == null ? "—" : escapeHtml(r.adp)}</td>
              <td>${r.at_risk ? "yes" : "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
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
        refreshLeagueSettings();
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
        `Live · ${draft?.status || "?"} · ${picks.length} picks` +
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
    draftId = await resolveDraftId(input.value);
    draft = await sleeperGet(`/draft/${draftId}`);
    league = await fetchLeagueForDraft(draft);
    refreshLeagueSettings();
    picks = (await sleeperGet(`/draft/${draftId}/picks`)) || [];
    lastFingerprint = picksFingerprint(picks);
    rebuildTaken();
    fillSeats();
    const src = leagueSettings?.source || "draft";
    setStatus(
      `Connected · ${draft.status} · ${picks.length} picks · slots from ${src}`
    );
    renderAll();
    schedulePoll();
  }

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

  try {
    const data = await fetchJSON("draft/projections.json");
    projections = data.players || [];
    indexProjections(projections);
    const saved = localStorage.getItem("draft-companion:last-id");
    if (saved && input) input.value = saved;
    input?.addEventListener("change", () => {
      localStorage.setItem("draft-companion:last-id", input.value.trim());
    });
    revealPage();
  } catch (err) {
    showError(recEl, err.message);
    revealPage();
  }
}

export { mountDraftCompanionPage };
