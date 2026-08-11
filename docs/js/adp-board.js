import { fetchJSON, formatTimestamp, showError, revealPage } from "./config.js?v=2";
import { loadLikedIds, toggleLikedId, mountStarSync } from "./draft-liked.js?v=4";

const ADP_MISSING = 9999;
const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
/** Roughly 10 rounds in a 12-team draft. */
const ADP_BOARD_LIMIT = 120;
const FORMAT_PATHS = {
  half_ppr: "draft/projections-half-ppr.json",
  full_ppr: "draft/projections-full-ppr.json",
  std: "draft/projections-std.json",
};
const ADP_PATHS = {
  half_ppr: "draft/adp-half-ppr.json",
  full_ppr: "draft/adp-full-ppr.json",
  std: "draft/adp-std.json",
};
const FORMAT_LABELS = {
  half_ppr: "Half PPR",
  full_ppr: "Full PPR",
  std: "Standard",
};

const SOURCE_LABELS = {
  sleeper_adp: "Sleeper",
  sleeper_rotowire: "Sleeper / Rotowire",
  fantasypros_csv: "FantasyPros",
  sleeper: "Sleeper",
};

const boardCache = new Map();

function sourceLabel(raw) {
  const key = String(raw || "").trim();
  if (!key) return null;
  return SOURCE_LABELS[key] || key.replaceAll("_", " ");
}

function stampLabel(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return formatTimestamp(iso);
}

/** Projection freshness as calendar date (US Eastern). */
function projectionDateLabel(iso) {
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sleeperIdOf(player) {
  return String(player?.sleeper_id || player?.player_id || "").replace(
    /^sleeper:/,
    ""
  );
}

function adpNumber(player) {
  const n = Number(player?.adp);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Format overall ADP as round.pick for a 12-team league. */
function formatAdpRoundPick(adp, teams = 12) {
  const overall = Number(adp);
  if (!Number.isFinite(overall) || overall <= 0) return null;
  const t = Math.max(1, Math.round(Number(teams) || 12));
  let round = Math.floor((overall - 1) / t) + 1;
  let pick = Math.round(((overall - 1) % t) + 1);
  if (pick > t) {
    pick = 1;
    round += 1;
  }
  if (pick < 1) pick = 1;
  return `${round}.${String(pick).padStart(2, "0")}`;
}

function starButtonHtml(playerId, liked) {
  const id = escapeHtml(playerId);
  const on = Boolean(liked);
  return `<button type="button" class="draft-star${on ? " is-liked" : ""}" data-player-id="${id}" aria-label="${on ? "Remove from favourites" : "Add to favourites"}" aria-pressed="${on ? "true" : "false"}">★</button>`;
}

function playerCellHtml(player, liked) {
  const name = escapeHtml(player?.player || player?.name || "");
  const team = player?.team ? String(player.team).toUpperCase() : "";
  const teamHtml = team
    ? `<span class="adp-player-team">${escapeHtml(team)}</span>`
    : "";
  return `<span class="draft-player-cell">${starButtonHtml(sleeperIdOf(player), liked)}<span class="adp-player-text"><span class="adp-player-name">${name}</span>${teamHtml}</span></span>`;
}

function slimPlayers(players) {
  return (players || []).map((p) => ({
    sleeper_id: sleeperIdOf(p),
    player: p.player || p.name || "",
    team: p.team || "",
    position: String(p.position || "").toUpperCase(),
    adp: p.adp,
    bye_week: p.bye_week ?? null,
    pts: p.pts,
  }));
}

function overlayAdp(players, adpPlayers) {
  const byId = new Map();
  for (const p of adpPlayers || []) {
    const id = sleeperIdOf(p);
    const adp = adpNumber(p);
    if (!id || adp == null) continue;
    byId.set(id, adp);
  }
  if (!byId.size) return players;
  return (players || []).map((p) => {
    const id = sleeperIdOf(p);
    if (!id || !byId.has(id)) return p;
    return { ...p, adp: byId.get(id) };
  });
}

async function loadBoardPlayers(formatKey = "half_ppr") {
  const key = FORMAT_PATHS[formatKey] ? formatKey : "half_ppr";
  if (boardCache.has(key)) return boardCache.get(key);
  const data = await fetchJSON(FORMAT_PATHS[key]);
  let players = slimPlayers(data.players || []);
  let adpUpdated = data.adp_updated || null;
  let adpSource = null;
  try {
    const adpData = await fetchJSON(ADP_PATHS[key]);
    players = overlayAdp(players, adpData.players || []);
    adpUpdated = adpData.last_updated || adpUpdated;
    adpSource = adpData.source || null;
  } catch {
    // Fall back to ADP baked into the projection board.
  }
  // ADP board is ADP-first: drop anyone without a real ADP value.
  players = players.filter((p) => adpNumber(p) != null);
  const board = {
    players,
    label: FORMAT_LABELS[key] || data.format || "Half PPR",
    source: data.source || "sleeper",
    format: key,
    adp_source: adpSource || "sleeper_adp",
    adp_updated: adpUpdated,
    projections_updated: data.last_updated || null,
  };
  boardCache.set(key, board);
  return board;
}

function sortByAdp(players) {
  return [...players].sort((a, b) => {
    const aa = adpNumber(a) ?? ADP_MISSING;
    const bb = adpNumber(b) ?? ADP_MISSING;
    return aa - bb || (Number(b.pts) || 0) - (Number(a.pts) || 0);
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
    const adpSrc = sourceLabel(boardMeta.adp_source) || "Sleeper";
    const adpWhen = stampLabel(boardMeta.adp_updated);
    const projSrc = sourceLabel(boardMeta.source) || "Projections";
    const projWhen = projectionDateLabel(boardMeta.projections_updated);
    const adp = adpWhen ? `ADP · ${adpSrc} · ${adpWhen}` : `ADP · ${adpSrc}`;
    const projections = projWhen
      ? `${projSrc}: ${projWhen}`
      : projSrc;
    summaryEl.textContent = [adp, projections].join(" · ");
  }

  function render() {
    const rows = visiblePlayers();
    updateSummary();
    if (!rows.length) {
      boardEl.innerHTML = `<p class="meta">No players match.</p>`;
      return;
    }
    // Text-only rows (no headshots) keep tab/filter switches snappy.
    boardEl.innerHTML = `
      <table class="draft-table cell-border adp-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Pos</th>
            <th>ADP</th>
            <th>Bye</th>
            <th>Proj</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((p, i) => {
              const liked = likedIds.has(p.sleeper_id);
              const adp = adpNumber(p);
              const overall =
                adp == null ? null : Number(adp).toFixed(1);
              const roundPick =
                adp == null ? null : formatAdpRoundPick(adp, 12);
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
                <td>${p.pts == null ? "—" : escapeHtml(Number(p.pts).toFixed(1))}</td>
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
    if (!FORMAT_PATHS[next] || next === formatKey) return;
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
