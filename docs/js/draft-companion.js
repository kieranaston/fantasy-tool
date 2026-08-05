import { fetchJSON, showError, revealPage, formatTimestamp } from "./config.js";
import { scoreCandidates } from "./draft-scoring.js?v=1";

const POLL_MS = 2500;

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
  let pollTimer = null;
  let draftId = null;
  let draft = null;
  let picks = [];
  let mySlot = 1;
  let paused = false;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function draftedIds(pickList) {
    return new Set(pickList.map((p) => String(p.player_id)));
  }

  function render() {
    if (!draft) return;
    const settings = draft.settings || {};
    const teams = Number(settings.teams || 12);
    const rounds = Number(settings.rounds || 15);
    const slotToRoster = draft.slot_to_roster_id || {};
    const bySlot = buildSlotRosters(picks, slotToRoster);
    const taken = draftedIds(picks);
    const available = projections.filter((p) => !taken.has(String(p.sleeper_id)));
    const pickNo = currentPickNo(picks);
    const result = scoreCandidates({
      available,
      myRoster: bySlot[mySlot] || [],
      opponentRosters: bySlot,
      settings,
      teams,
      mySlot,
      currentPickNo: pickNo,
      rounds,
    });

    if (metaEl) {
      const parts = [
        `${draft.metadata?.name || "Draft"}`,
        `${draft.status}`,
        `pick ${Math.min(pickNo, teams * rounds)}`,
        `you: slot ${mySlot}`,
        `next yours: ${result.nextPickNo}`,
      ];
      if (projections[0]?.source) parts.push(projections[0].source);
      metaEl.textContent = parts.join(" · ");
    }

    const needs = result.myNeeds;
    needsEl.innerHTML = `
      <div class="draft-needs-grid">
        ${["QB", "RB", "WR", "TE", "FLEX"]
          .map(
            (pos) =>
              `<div><strong>${pos}</strong> need ${escapeHtml(String(needs[pos] ?? 0))}</div>`
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

  function fillSeats() {
    const teams = Number(draft?.settings?.teams || 12);
    seatSelect.innerHTML = Array.from({ length: teams }, (_, i) => {
      const slot = i + 1;
      return `<option value="${slot}" ${slot === mySlot ? "selected" : ""}>Slot ${slot}</option>`;
    }).join("");
  }

  async function refreshLive() {
    if (!draftId || paused) return;
    const [detail, nextPicks] = await Promise.all([
      sleeperGet(`/draft/${draftId}`),
      sleeperGet(`/draft/${draftId}/picks`),
    ]);
    draft = detail;
    picks = nextPicks || [];
    setStatus(
      `Live · ${draft.status} · ${picks.length} picks · polled ${new Date().toLocaleTimeString()}`
    );
    render();
  }

  async function connectLive() {
    stopTimers();
    paused = false;
    if (pauseBtn) pauseBtn.textContent = "Pause";
    draftId = await resolveDraftId(input.value);
    draft = await sleeperGet(`/draft/${draftId}`);
    picks = (await sleeperGet(`/draft/${draftId}/picks`)) || [];
    fillSeats();
    setStatus(`Connected to draft ${draftId}`);
    render();
    pollTimer = setInterval(() => {
      refreshLive().catch((err) => setStatus(`Poll error: ${err.message}`));
    }, POLL_MS);
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
  });
  seatSelect?.addEventListener("change", () => {
    mySlot = Number(seatSelect.value) || 1;
    render();
  });

  try {
    const data = await fetchJSON("draft/projections.json");
    projections = (data.players || []).map((p) => ({
      ...p,
      source: data.source,
    }));
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
