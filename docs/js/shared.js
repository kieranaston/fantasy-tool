/** Shared DOM / ID helpers for draft + ADP + news pages. */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Bare Sleeper player id (strips optional sleeper: prefix). */
function sleeperIdOf(player) {
  return String(player?.sleeper_id || player?.player_id || "")
    .replace(/^sleeper:/, "")
    .trim();
}

const TEAM_CANONICAL = {
  AZ: "ARI",
  LA: "LAR",
  STL: "LAR",
  JAC: "JAX",
  WSH: "WAS",
  OAK: "LV",
  SD: "LAC",
};

function normalizeTeamAbbrev(team) {
  const raw = String(team || "")
    .trim()
    .toUpperCase();
  if (!raw || raw === "FA" || raw === "NONE") return "";
  return TEAM_CANONICAL[raw] || raw;
}

function playerDisplayName(player, name) {
  return escapeHtml(
    name || player?.player || player?.name || player?.player_name || "Unknown"
  );
}

function playerLabelHtml(player, { name } = {}) {
  const team = normalizeTeamAbbrev(player?.team);
  const teamLine = team
    ? `<span class="player-label-team">${escapeHtml(team)}</span>`
    : "";
  return `<span class="player-label"><span class="player-label-name">${playerDisplayName(player, name)}</span>${teamLine}</span>`;
}

function starButtonHtml(playerId, liked) {
  const id = escapeHtml(playerId);
  const on = Boolean(liked);
  return `<button type="button" class="draft-star${on ? " is-liked" : ""}" data-player-id="${id}" aria-label="${on ? "Remove from favourites" : "Add to favourites"}" aria-pressed="${on ? "true" : "false"}">★</button>`;
}

function playerCellHtml(player, { name, liked = false } = {}) {
  const id = sleeperIdOf(player);
  const star = id ? starButtonHtml(id, liked) : "";
  return `<span class="draft-player-cell">${star}${playerLabelHtml(player, { name })}</span>`;
}

function updatePlayerCellLike(cell, liked) {
  const star = cell?.querySelector(".draft-star");
  if (!star) return;
  star.classList.toggle("is-liked", liked);
  star.setAttribute("aria-pressed", liked ? "true" : "false");
  star.setAttribute(
    "aria-label",
    liked ? "Remove from favourites" : "Add to favourites"
  );
}

/** Bind player label once per cell; later calls only update the star. */
function bindPlayerCell(cell, player, { name, liked = false } = {}) {
  if (!cell) return;
  if (!cell.dataset.bound) {
    cell.innerHTML = playerCellHtml(player, { name, liked });
    cell.dataset.bound = "1";
    return;
  }
  updatePlayerCellLike(cell, liked);
}

function matchesPlayerQuery(player, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return false;
  const name = String(
    player.player || player.name || player.player_name || ""
  ).toLowerCase();
  return name.includes(q);
}

export {
  escapeHtml,
  sleeperIdOf,
  playerLabelHtml,
  playerCellHtml,
  bindPlayerCell,
  updatePlayerCellLike,
  matchesPlayerQuery,
};
