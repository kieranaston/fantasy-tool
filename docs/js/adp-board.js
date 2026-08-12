import {
  fetchJSON,
  formatTimestamp,
  showError,
  revealPage,
} from "./config.js?v=2";
import { escapeHtml, sleeperIdOf, starButtonHtml } from "./shared.js?v=1";
import { loadLikedIds, toggleLikedId, mountStarSync } from "./draft-liked.js?v=4";
import { FORMAT_LABELS, SCORING_FORMATS, formatAdpRoundPick } from "./draft-scoring.js?v=80";

const ADP_MISSING = 9999;
const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
/** Roughly 10 rounds in a 12-team draft. */
const ADP_BOARD_LIMIT = 120;
const ADP_PATHS = {
  half_ppr: "draft/adp-half-ppr.json",
  full_ppr: "draft/adp-full-ppr.json",
  std: "draft/adp-std.json",
};

const boardCache = new Map();

function stampLabel(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return formatTimestamp(iso);
}

function playerCellHtml(player, liked) {
  const name = escapeHtml(player?.player || player?.name || "");
  const team = player?.team ? String(player.team).toUpperCase() : "";
  const teamHtml = team
    ? `<span class="adp-player-team">${escapeHtml(team)}</span>`
    : "";
  return `<span class="draft-player-cell">${starButtonHtml(sleeperIdOf(player), liked)}<span class="adp-player-text"><span class="adp-player-name">${name}</span>${teamHtml}</span></span>`;
}

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
  }));
}

async function loadBoardPlayers(formatKey = "half_ppr") {
  const key = SCORING_FORMATS.includes(formatKey) ? formatKey : "half_ppr";
  if (boardCache.has(key)) return boardCache.get(key);
  const data = await fetchJSON(ADP_PATHS[key]);
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
  const starredOnly = document.getElementById("adp-starred-only");
  const tabs = [...document.querySelectorAll(".adp-tab")];
  const formatTabs = [...document.querySelectorAll(".adp-format-tab")];
  const root = document.querySelector(".container") || document.body;

  let playersSorted = [];
  let boardMeta = { label: "", source: "", format: "half_ppr" };
  let position = "overall";
  let formatKey = "half_ppr";
  let likedIds = loadLikedIds();
  let searchTimer = null;
  let loadGen = 0;

  const starSync = mountStarSync({
    host: document.getElementById("sync-bar"),
    getIds: () => likedIds,
    setIds: (ids) => {
      likedIds = ids;
    },
    onChange: () => render(),
  });

  function matchesFilter(player, query) {
    if (!query) return true;
    const name = String(player.player || "").toLowerCase();
    const team = String(player.team || "").toLowerCase();
    const pos = String(player.position || "").toLowerCase();
    return name.includes(query) || team.includes(query) || pos === query;
  }

  function visiblePlayers() {
    const query = String(searchInput?.value || "")
      .trim()
      .toLowerCase();
    const onlyStarred = Boolean(starredOnly?.checked);
    let list = playersSorted.filter((p) => {
      if (adpNumber(p) == null) return false;
      if (!SKILL_POSITIONS.includes(p.position)) return false;
      if (onlyStarred && !likedIds.has(p.sleeper_id)) return false;
      return matchesFilter(p, query);
    });
    if (!onlyStarred && !query) {
      list = list
        .slice(0, ADP_BOARD_LIMIT)
        .filter((p) => position === "overall" || p.position === position);
    } else if (position !== "overall") {
      list = list.filter((p) => p.position === position);
    }
    return list;
  }

  function updateSummary() {
    if (!summaryEl) return;
    const when = stampLabel(boardMeta.last_updated);
    const label = boardMeta.label || FORMAT_LABELS[formatKey] || "Half PPR";
    summaryEl.textContent = when
      ? `Sleeper ADP · ${label} · ${when}`
      : `Sleeper ADP · ${label}`;
  }

  function render() {
    const rows = visiblePlayers();
    updateSummary();
    if (!rows.length) {
      boardEl.innerHTML = `<p class="meta">No players match.</p>`;
      return;
    }
    boardEl.innerHTML = `
      <table class="draft-table cell-border adp-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Pos</th>
            <th>ADP</th>
            <th>Bye</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((p, i) => {
              const liked = likedIds.has(p.sleeper_id);
              const adp = adpNumber(p);
              const overall = adp == null ? null : Number(adp).toFixed(1);
              const roundPick = adp == null ? null : formatAdpRoundPick(adp, 12);
              const adpCell =
                overall == null
                  ? "—"
                  : `<span class="adp-overall">${escapeHtml(
                      overall
                    )}</span>${
                      roundPick
                        ? `<span class="adp-round-pick">${escapeHtml(
                            roundPick
                          )}</span>`
                        : ""
                    }`;
              return `<tr class="${liked ? "draft-liked" : ""}">
                <td>${i + 1}</td>
                <td>${playerCellHtml(p, liked)}</td>
                <td>${escapeHtml(p.position)}</td>
                <td>${adpCell}</td>
                <td>${p.bye_week == null ? "—" : escapeHtml(p.bye_week)}</td>
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
  starredOnly?.addEventListener("change", () => render());

  root.addEventListener("click", (event) => {
    const btn = event.target.closest(".draft-star");
    if (!btn || !root.contains(btn)) return;
    event.preventDefault();
    event.stopPropagation();
    const id = btn.getAttribute("data-player-id");
    likedIds = toggleLikedId(likedIds, id);
    starSync.persistLocalAndMaybeRemote();
  });

  try {
    await starSync.hydrate();
    const board = await loadBoardPlayers(formatKey);
    playersSorted = sortByAdp(
      (board.players || []).filter((p) => SKILL_POSITIONS.includes(p.position))
    );
    boardMeta = board;
    render();
    revealPage();
  } catch (err) {
    showError(boardEl, err.message);
    if (summaryEl) summaryEl.textContent = "Failed to load ADP board";
    revealPage();
  }
}

export { mountAdpBoardPage };
