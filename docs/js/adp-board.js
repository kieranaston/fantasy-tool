import {
  fetchJSON,
  formatUpdated,
  showError,
  revealPage,
} from "./config.js?v=4";
import { escapeHtml, sleeperIdOf, playerCellHtml } from "./shared.js?v=6";
import { FORMAT_LABELS, SCORING_FORMATS, SKILL_POSITIONS, adpPathForFormat, formatAdpRoundPick } from "./draft-scoring.js?v=112";
import { createFavourites } from "./draft-liked.js?v=10";

const ADP_MISSING = 9999;
/** Roughly 10 rounds in a 12-team draft (overall tab). */
const ADP_BOARD_LIMIT = 120;
const ADP_POS_LIMITS = { QB: 32, TE: 32, DEF: 32, K: 32 };

function boardLimit(pos) {
  if (pos === "overall") return ADP_BOARD_LIMIT;
  return ADP_POS_LIMITS[pos] ?? ADP_BOARD_LIMIT;
}

const boardCache = new Map();

function adpNumber(player) {
  const n = Number(player?.adp);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function slimPlayers(players) {
  return (players || []).map((p) => ({
    sleeper_id: sleeperIdOf(p),
    player: p.player || p.name || "",
    team: p.team || "",
    position: String(p.position || "").toUpperCase(),
    adp: p.adp,
    bye_week: p.bye_week ?? null,
    headshot: p.headshot || null,
  }));
}

async function loadBoardPlayers(formatKey = "half_ppr") {
  const key = SCORING_FORMATS.includes(formatKey) ? formatKey : "half_ppr";
  if (boardCache.has(key)) return boardCache.get(key);
  const data = await fetchJSON(adpPathForFormat(key));
  const players = slimPlayers(data.players || []).filter(
    (p) => adpNumber(p) != null
  );
  const board = {
    players,
    label: FORMAT_LABELS[key] || data.format || "Half PPR",
    source: data.source || "sleeper_adp",
    format: key,
    last_updated: data.last_updated || null,
  };
  boardCache.set(key, board);
  return board;
}

function sortByAdp(players) {
  return [...players].sort((a, b) => {
    const aa = adpNumber(a) ?? ADP_MISSING;
    const bb = adpNumber(b) ?? ADP_MISSING;
    return aa - bb || String(a.player || "").localeCompare(String(b.player || ""));
  });
}

async function mountAdpBoardPage() {
  const boardEl = document.getElementById("adp-board");
  const summaryEl = document.getElementById("adp-summary");
  const searchInput = document.getElementById("adp-search");
  const teamSelect = document.getElementById("adp-team");
  const tabs = [...document.querySelectorAll(".adp-tab")];
  const formatTabs = [...document.querySelectorAll(".adp-format-tab")];
  const root = document.querySelector(".container") || document.body;

  let playersSorted = [];
  let boardMeta = { label: "", source: "", format: "half_ppr" };
  let position = "overall";
  let formatKey = "half_ppr";
  let searchTimer = null;
  let loadGen = 0;

  const favs = createFavourites({
    host: document.getElementById("sync-bar"),
    onChange: () => render(),
  });

  function matchesFilter(player, query) {
    if (!query) return true;
    const name = String(player.player || "").toLowerCase();
    const team = String(player.team || "").toLowerCase();
    const pos = String(player.position || "").toLowerCase();
    return name.includes(query) || team.includes(query) || pos === query;
  }

  function fillTeamOptions() {
    if (!teamSelect) return;
    const selected = teamSelect.value;
    const teams = [
      ...new Set(
        playersSorted
          .map((p) => String(p.team || "").trim())
          .filter(Boolean)
      ),
    ].sort((a, b) => a.localeCompare(b));
    teamSelect.innerHTML =
      `<option value="">All teams</option>` +
      teams
        .map(
          (team) =>
            `<option value="${escapeHtml(team)}">${escapeHtml(team)}</option>`
        )
        .join("");
    teamSelect.value = teams.includes(selected) ? selected : "";
  }

  function visiblePlayers() {
    const query = String(searchInput?.value || "")
      .trim()
      .toLowerCase();
    const team = String(teamSelect?.value || "").trim();
    let list = playersSorted.filter((p) => {
      if (adpNumber(p) == null) return false;
      if (!SKILL_POSITIONS.includes(p.position)) return false;
      if (team && p.team !== team) return false;
      return matchesFilter(p, query);
    });
    if (position !== "overall") {
      list = list.filter((p) => p.position === position);
    }
    if (!query) {
      list = list.slice(0, boardLimit(position));
    }
    return list;
  }

  function updateSummary() {
    if (!summaryEl) return;
    summaryEl.textContent = formatUpdated(boardMeta.last_updated);
  }

  function render() {
    const rows = visiblePlayers();
    updateSummary();
    if (!rows.length) {
      boardEl.innerHTML = `<p class="meta">No players match.</p>`;
      return;
    }
    boardEl.innerHTML = `
      <table class="draft-table adp-table">
        <thead>
          <tr>
            <th class="num col-wide">#</th>
            <th>Player</th>
            <th>Pos</th>
            <th class="num">ADP</th>
            <th class="num col-wide">Bye</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((p, i) => {
              const liked = favs.has(p.sleeper_id);
              const adp = adpNumber(p);
              const overall = adp == null ? null : Number(adp).toFixed(1);
              const roundPick = adp == null ? null : formatAdpRoundPick(adp, 12);
              const adpCell =
                overall == null
                  ? "—"
                  : roundPick
                    ? `<span class="adp-overall">${escapeHtml(
                        roundPick
                      )}</span><span class="adp-round-pick">${escapeHtml(
                        overall
                      )}</span>`
                    : `<span class="adp-overall">${escapeHtml(overall)}</span>`;
              return `<tr class="${liked ? "draft-liked" : ""}">
                <td class="num col-wide">${i + 1}</td>
                <td>${playerCellHtml(p, { liked })}</td>
                <td>${escapeHtml(p.position)}</td>
                <td class="num">${adpCell}</td>
                <td class="num col-wide">${p.bye_week == null ? "—" : escapeHtml(p.bye_week)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  function setPosition(next) {
    position = next;
    for (const tab of tabs) {
      const active = tab.dataset.pos === position;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
    render();
  }

  async function setFormat(next) {
    if (!SCORING_FORMATS.includes(next) || next === formatKey) return;
    formatKey = next;
    for (const tab of formatTabs) {
      const active = tab.dataset.format === formatKey;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
    const gen = ++loadGen;
    if (summaryEl) summaryEl.textContent = "Loading…";
    try {
      const board = await loadBoardPlayers(formatKey);
      if (gen !== loadGen) return;
      playersSorted = sortByAdp(
        (board.players || []).filter((p) =>
          SKILL_POSITIONS.includes(p.position)
        )
      );
      boardMeta = board;
      fillTeamOptions();
      render();
    } catch (err) {
      if (gen !== loadGen) return;
      showError(boardEl, err.message);
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setPosition(tab.dataset.pos || "overall"));
  });
  formatTabs.forEach((tab) => {
    tab.addEventListener("click", () => setFormat(tab.dataset.format || "half_ppr"));
  });
  searchInput?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(), 120);
  });
  teamSelect?.addEventListener("change", () => render());

  root.addEventListener("click", (event) => {
    const btn = event.target.closest(".draft-star");
    if (!btn || !root.contains(btn)) return;
    event.preventDefault();
    event.stopPropagation();
    const id = btn.getAttribute("data-player-id");
    favs.toggle(id);
  });

  try {
    await favs.hydrate();
    const board = await loadBoardPlayers(formatKey);
    playersSorted = sortByAdp(
      (board.players || []).filter((p) => SKILL_POSITIONS.includes(p.position))
    );
    boardMeta = board;
    fillTeamOptions();
    render();
    revealPage();
  } catch (err) {
    showError(boardEl, err.message);
    if (summaryEl) summaryEl.textContent = "Updated: —";
    revealPage();
  }
}

export { mountAdpBoardPage };
