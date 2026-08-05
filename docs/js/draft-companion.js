import { fetchJSON, showError, revealPage, formatTimestamp } from "./config.js";
import {
  scoreCandidates,
  nextPickNumbers,
  SKILL_POSITIONS,
} from "./draft-scoring.js?v=3";

/** Fast while you're on the clock; slower while waiting (picks board still updates). */
const POLL_ON_CLOCK_MS = 700;
const POLL_WAITING_MS = 2000;
const POLL_IDLE_MS = 4000;
const DRAFT_META_EVERY = 12;
/** Only recompute recommendations when it's your turn. */
const SCORE_WHEN_PICKS_UNTIL_MINE = 0;

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

function buildSlotRosters(picks, slotToRoster) {
  const rosterToSlot = {};
  for (const [slot, rosterId] of Object.entries(slotToRoster || {})) {
    rosterToSlot[String(rosterId)] = Number(slot);
  }
  const bySlot = {};
  for (const pick of picks) {
    const rosterId = String(pick.roster_id ?? "");
    const slot = rosterToSlot[rosterId] || Number(pick.draft_slot);
    if (!slot) continue;
    const meta = pick.metadata || {};
    bySlot[slot] = bySlot[slot] || [];
    bySlot[slot].push({
      player_id: String(pick.player_id || ""),
      position: String(meta.position || "").toUpperCase(),
      name: `${meta.first_name || ""} ${meta.last_name || ""}`.trim(),
    });
  }
  return bySlot;
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
  let takenIndex = new Set();
  let pollTimer = null;
  let draftId = null;
  let draft = null;
  let picks = [];
  let lastFingerprint = "";
  let mySlot = 1;
  let paused = false;
  let inFlight = false;
  let pollTick = 0;
  let scoreGen = 0;
  let lastScoredFingerprint = "";
  let hasScoredOnce = false;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function indexProjections(players) {
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    for (const p of players) {
      if (byPos[p.position]) byPos[p.position].push(p);
    }
    for (const pos of SKILL_POSITIONS) {
      byPos[pos].sort((a, b) => Number(b.pts) - Number(a.pts));
    }
    projectionsByPos = byPos;
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
    return pickTiming().until <= SCORE_WHEN_PICKS_UNTIL_MINE
      ? POLL_ON_CLOCK_MS
      : POLL_WAITING_MS;
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
    const settings = draft?.settings || {};
    const teams = Number(settings.teams || 12);
    const rounds = Number(settings.rounds || 15);
    const pickNo = currentPickNo(picks);
    const mine = nextPickNumbers(mySlot, teams, rounds, pickNo);
    const nextMine = mine[0] ?? pickNo;
    const until = Math.max(0, nextMine - pickNo);
    return { teams, rounds, pickNo, nextMine, until };
  }

  function shouldScoreNow() {
    return pickTiming().until <= SCORE_WHEN_PICKS_UNTIL_MINE;
  }

  function updateMeta(timing, { onClock } = {}) {
    if (!metaEl || !draft) return;
    const parts = [
      `${draft.metadata?.name || "Draft"}`,
      `${draft.status}`,
      `pick ${Math.min(timing.pickNo, timing.teams * timing.rounds)}`,
      `you: slot ${mySlot}`,
      `next yours: ${timing.nextMine}`,
    ];
    if (!onClock) {
      parts.push(
        timing.until === 1
          ? "on deck"
          : `waiting (${timing.until} picks) · recs refresh on your turn`
      );
    } else {
      parts.push("your pick");
    }
    metaEl.textContent = parts.join(" · ");
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

  function renderScores() {
    if (!draft) return;
    const settings = draft.settings || {};
    const timing = pickTiming();
    const onClock = timing.until <= SCORE_WHEN_PICKS_UNTIL_MINE;
    updateMeta(timing, { onClock });

    if (!onClock) {
      // Keep prior recommendations visible; only update needs lightly from last score path.
      if (!hasScoredOnce) {
        needsEl.innerHTML = `<p class="meta">Recommendations appear when it’s your pick.</p>`;
        recEl.innerHTML = "";
      }
      return;
    }

    const slotToRoster = draft.slot_to_roster_id || {};
    const bySlot = buildSlotRosters(picks, slotToRoster);
    const byPos = availableByPos();
    const result = scoreCandidates({
      available: null,
      availableByPos: byPos,
      myRoster: bySlot[mySlot] || [],
      opponentRosters: bySlot,
      settings,
      teams: timing.teams,
      mySlot,
      currentPickNo: timing.pickNo,
      rounds: timing.rounds,
    });

    hasScoredOnce = true;
    lastScoredFingerprint = picksFingerprint(picks);

    const needs = result.myNeeds;
    const counts = result.myCounts || {};
    needsEl.innerHTML = `
      <div class="draft-needs-grid">
        ${["QB", "RB", "WR", "TE", "FLEX"]
          .map(
            (pos) =>
              `<div><strong>${pos}</strong> need ${escapeHtml(String(needs[pos] ?? 0))}${
                pos !== "FLEX" ? ` · have ${escapeHtml(String(counts[pos] ?? 0))}` : ""
              }</div>`
          )
          .join("")}
      </div>`;

    const recs = result.recommendations.slice(0, 8);
    recEl.innerHTML = `
      <table class="draft-table cell-border">
        <thead>
          <tr>
            <th>#</th><th>Player</th><th>Pos</th><th>Pts</th><th>VORP</th>
            <th>ADP</th><th>P(survive)</th><th>Regret</th>
          </tr>
        </thead>
        <tbody>
          ${recs
            .map(
              (r, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${escapeHtml(r.player)}</td>
              <td>${escapeHtml(r.position)}</td>
              <td>${escapeHtml(r.pts)}</td>
              <td>${escapeHtml(r.vorp)}</td>
              <td>${r.adp == null ? "—" : escapeHtml(r.adp)}</td>
              <td>${escapeHtml(Math.round(r.p_survive * 100))}%</td>
              <td><strong>${escapeHtml(r.regret)}</strong></td>
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
    const onClock = timing ? timing.until <= SCORE_WHEN_PICKS_UNTIL_MINE : false;
    if (!force && !onClock) {
      if (timing) updateMeta(timing, { onClock: false });
      return;
    }
    // Avoid duplicate scoring for the same board while you're still on the clock.
    const fp = picksFingerprint(picks);
    if (!force && onClock && fp === lastScoredFingerprint && hasScoredOnce) {
      if (timing) updateMeta(timing, { onClock: true });
      return;
    }
    const gen = ++scoreGen;
    requestAnimationFrame(() => {
      if (gen !== scoreGen) return;
      renderScores();
    });
  }

  function fillSeats() {
    const teams = Number(draft?.settings?.teams || 12);
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
        // Still refresh the waiting/on-clock meta while polling.
        updateMeta(pickTiming(), { onClock: shouldScoreNow() });
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
    if (pauseBtn) pauseBtn.textContent = "Pause";
    draftId = await resolveDraftId(input.value);
    draft = await sleeperGet(`/draft/${draftId}`);
    picks = (await sleeperGet(`/draft/${draftId}/picks`)) || [];
    lastFingerprint = picksFingerprint(picks);
    rebuildTaken();
    fillSeats();
    setStatus(`Connected · ${draft.status} · ${picks.length} picks`);
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
    queueScoreRender({ force: true });
  });

  try {
    const data = await fetchJSON("draft/projections.json");
    projections = data.players || [];
    indexProjections(projections);
    if (metaEl) {
      metaEl.textContent = data.last_updated
        ? `Projections ready · ${projections.length} players · updated ${formatTimestamp(data.last_updated)}`
        : `Projections ready · ${projections.length} players`;
    }
    setStatus("Paste a Sleeper league/draft link and connect live");
    const saved = localStorage.getItem("draft-companion:last-id");
    if (saved && input) input.value = saved;
    input?.addEventListener("change", () => {
      localStorage.setItem("draft-companion:last-id", input.value.trim());
    });
    revealPage();
  } catch (err) {
    showError(recEl, err.message);
    setStatus(err.message);
    revealPage();
  }
}

export { mountDraftCompanionPage };
