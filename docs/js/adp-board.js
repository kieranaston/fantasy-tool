import { fetchJSON, showError, revealPage } from "./config.js";
import {
  projectionsPathForFormat,
  formatAdpRoundPick,
  SKILL_POSITIONS,
} from "./draft-scoring.js?v=60";
import { loadLikedIds, toggleLikedId } from "./draft-liked.js?v=1";

const ADP_MISSING = 9999;

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

function playerMediaHtml(player) {
  const display = escapeHtml(player?.player || player?.name || "");
  const headshot = player?.headshot;
  const logo = player?.logo;
  const team = player?.team ? String(player.team).toUpperCase() : "";
  const headshotHtml = headshot
    ? `<img class="player-headshot" src="${escapeHtml(headshot)}" alt="" width="28" height="28" loading="lazy" decoding="async" />`
    : `<span class="player-headshot player-headshot--empty" aria-hidden="true"></span>`;
  const teamBits = [];
  if (logo) {
    teamBits.push(
      `<img class="team-logo" src="${escapeHtml(logo)}" alt="" width="14" height="14" loading="lazy" decoding="async" />`
    );
  }
  if (team) teamBits.push(`<span>${escapeHtml(team)}</span>`);
  const teamHtml = teamBits.length
    ? `<span class="player-media-team">${teamBits.join("")}</span>`
    : "";
  return `<span class="player-media">${headshotHtml}<span class="player-media-text"><span class="player-media-name">${display}</span>${teamHtml}</span></span>`;
}

function starButtonHtml(playerId, liked) {
  const id = escapeHtml(playerId);
  const on = Boolean(liked);
  return `<button type="button" class="draft-star${on ? " is-liked" : ""}" data-player-id="${id}" aria-label="${on ? "Unstar player" : "Star player"}" aria-pressed="${on ? "true" : "false"}">★</button>`;
}

async function loadBoardPlayers() {
  try {
    const custom = await fetchJSON("draft/projections-custom.json");
    if (custom?.players?.length) {
      return {
        players: custom.players,
        label: custom.league_name
          ? `${custom.league_name} · FantasyPros`
          : "FantasyPros · custom",
        source: custom.source || "fantasypros_csv",
      };
    }
  } catch {
    /* fall through */
  }
  const data = await fetchJSON(projectionsPathForFormat("half_ppr"));
  return {
    players: data.players || [],
    label: data.format || "Half PPR",
    source: data.source || "sleeper",
  };
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
  const root = document.querySelector(".container") || document.body;

  let players = [];
  let boardMeta = { label: "", source: "" };
  let position = "overall";
  let likedIds = loadLikedIds();

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
    return sortByAdp(players).filter((p) => {
      const pos = String(p.position || "").toUpperCase();
      if (!SKILL_POSITIONS.includes(pos)) return false;
      if (position !== "overall" && pos !== position) return false;
      const id = sleeperIdOf(p);
      if (onlyStarred && !likedIds.has(id)) return false;
      return matchesFilter(p, query);
    });
  }

  function updateSummary(visibleCount) {
    if (!summaryEl) return;
    const starred = likedIds.size;
    summaryEl.textContent = [
      boardMeta.label || "ADP",
      "12-team round.pick",
      `${visibleCount} players`,
      starred ? `${starred} starred` : "no stars yet",
      "Stars sync with Draft",
    ].join(" · ");
  }

  function render() {
    const rows = visiblePlayers();
    updateSummary(rows.length);
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
            <th>Proj</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((p, i) => {
              const id = sleeperIdOf(p);
              const liked = likedIds.has(id);
              const adp = adpNumber(p);
              const adpLabel = adp == null ? null : formatAdpRoundPick(adp, 12);
              return `<tr class="${liked ? "draft-liked" : ""}">
                <td>${i + 1}</td>
                <td><span class="draft-player-cell">${starButtonHtml(id, liked)}${playerMediaHtml(p)}</span></td>
                <td>${escapeHtml(p.position)}</td>
                <td>${adpLabel == null ? "—" : escapeHtml(adpLabel)}</td>
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

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setPosition(tab.dataset.pos || "overall"));
  });
  searchInput?.addEventListener("input", () => render());
  starredOnly?.addEventListener("change", () => render());

  root.addEventListener("click", (event) => {
    const btn = event.target.closest(".draft-star");
    if (!btn || !root.contains(btn)) return;
    event.preventDefault();
    likedIds = toggleLikedId(likedIds, btn.getAttribute("data-player-id"));
    render();
  });

  try {
    const board = await loadBoardPlayers();
    players = (board.players || []).filter((p) =>
      SKILL_POSITIONS.includes(String(p.position || "").toUpperCase())
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
