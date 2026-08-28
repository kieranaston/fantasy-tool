import {
  fetchJSON,
  formatUpdated,
  showError,
  revealPage,
} from "./config.js";
import { escapeHtml, sleeperIdOf, bindPlayerCell, matchesPlayerQuery } from "./shared.js";
import {
  FORMAT_LABELS,
  SCORING_FORMATS,
  SKILL_POSITIONS,
  adpPathForFormat,
  playerAdpForFormat,
  formatAdpRoundPick,
} from "./draft-scoring.js";
import { createFavourites } from "./draft-liked.js";
import {
  ensureTableBody,
  showTableMessage,
  syncTableRows,
} from "./table-diff.js";

const ADP_MISSING = 9999;
const ADP_BOARD_LIMIT = 120;
const ADP_POS_LIMITS = { QB: 32, TE: 32, DEF: 32, K: 32 };

const REC_TABLE_HEAD = `<thead>
          <tr>
            <th class="num col-wide">#</th>
            <th>Player</th>
            <th>Pos</th>
            <th class="num">ADP</th>
            <th class="num col-wide">Bye</th>
          </tr>
        </thead>`;

function boardLimit(pos) {
  if (pos === "overall") return ADP_BOARD_LIMIT;
  return ADP_POS_LIMITS[pos] ?? ADP_BOARD_LIMIT;
}

let mergedPlayers = [];
let boardMeta = { label: "", source: "", format: "half_ppr", last_updated: null };

function adpNumber(player, formatKey) {
  const n = playerAdpForFormat(player, formatKey);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function playersForFormat(formatKey) {
  return mergedPlayers
    .map((p) => ({
      ...p,
      adp: adpNumber(p, formatKey),
    }))
    .filter((p) => p.adp != null && SKILL_POSITIONS.includes(p.position));
}

function sortByAdp(players) {
  return [...players].sort((a, b) => {
    const aa = Number(a.adp) ?? ADP_MISSING;
    const bb = Number(b.adp) ?? ADP_MISSING;
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
  let position = "overall";
  let formatKey = "half_ppr";
  let searchTimer = null;

  const favs = createFavourites({
    host: document.getElementById("sync-bar"),
    onChange: () => render(),
  });

  function matchesFilter(player, query) {
    if (!query) return true;
    return matchesPlayerQuery(player, query);
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
      if (p.adp == null) return false;
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

  function adpCellHtml(adp) {
    const overall = adp == null ? null : Number(adp).toFixed(1);
    const roundPick = adp == null ? null : formatAdpRoundPick(adp, 12);
    if (overall == null) return "—";
    if (roundPick) {
      return `<span class="adp-overall">${escapeHtml(roundPick)}</span><span class="adp-round-pick">${escapeHtml(overall)}</span>`;
    }
    return `<span class="adp-overall">${escapeHtml(overall)}</span>`;
  }

  function createAdpRow(p, index) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num col-wide">${index + 1}</td>
      <td></td>
      <td></td>
      <td class="num"></td>
      <td class="num col-wide"></td>`;
    updateAdpRow(tr, p, index);
    return tr;
  }

  function updateAdpRow(tr, p, index) {
    const liked = favs.has(p.sleeper_id);
    tr.className = liked ? "draft-liked" : "";
    tr.children[0].textContent = String(index + 1);
    bindPlayerCell(tr.children[1], p, { liked });
    tr.children[2].textContent = p.position || "";
    tr.children[3].innerHTML = adpCellHtml(p.adp);
    tr.children[4].textContent = p.bye_week == null ? "—" : String(p.bye_week);
  }

  function render() {
    const rows = visiblePlayers();
    updateSummary();
    if (!rows.length) {
      showTableMessage(boardEl, `<p class="meta">No players match.</p>`);
      return;
    }
    const tbody = ensureTableBody(boardEl, {
      tableClass: "draft-table adp-table",
      theadHtml: REC_TABLE_HEAD,
    });
    syncTableRows(tbody, rows, {
      key: (p) => sleeperIdOf(p),
      createRow: (p, i) => createAdpRow(p, i),
      updateRow: (tr, p, i) => updateAdpRow(tr, p, i),
    });
  }

  function setPosition(next) {
    position = next;
    for (const tab of tabs) {
      const active = tab.dataset.pos === position;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", active ? "true" : "false");
    }
    render();
  }

  function setFormat(next) {
    if (!SCORING_FORMATS.includes(next) || next === formatKey) return;
    formatKey = next;
    for (const tab of formatTabs) {
      const active = tab.dataset.format === formatKey;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", active ? "true" : "false");
    }
    boardMeta = {
      ...boardMeta,
      format: formatKey,
      label: FORMAT_LABELS[formatKey] || formatKey,
    };
    playersSorted = sortByAdp(playersForFormat(formatKey));
    fillTeamOptions();
    render();
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
    favs.toggle(btn.getAttribute("data-player-id"));
  });

  try {
    await favs.hydrate();
    const [data] = await Promise.all([
      fetchJSON(adpPathForFormat(formatKey)),
    ]);
    mergedPlayers = data.players || [];
    boardMeta = {
      players: mergedPlayers,
      label: FORMAT_LABELS[formatKey] || "Half PPR",
      source: data.source || "sleeper_adp",
      format: formatKey,
      last_updated: data.last_updated || null,
    };
    playersSorted = sortByAdp(playersForFormat(formatKey));
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
