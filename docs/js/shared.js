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

function starButtonHtml(playerId, liked) {
  const id = escapeHtml(playerId);
  const on = Boolean(liked);
  return `<button type="button" class="draft-star${on ? " is-liked" : ""}" data-player-id="${id}" aria-label="${on ? "Remove from favourites" : "Add to favourites"}" aria-pressed="${on ? "true" : "false"}">★</button>`;
}

function playerMediaHtml(player, { name } = {}) {
  const display = escapeHtml(
    name ||
      player?.player ||
      player?.name ||
      player?.player_name ||
      "Unknown"
  );
  const team = player?.team ? String(player.team).toUpperCase() : "";
  const teamHtml = team
    ? `<span class="player-media-team">${escapeHtml(team)}</span>`
    : "";
  return `<span class="player-media player-media--text"><span class="player-media-text"><span class="player-media-name">${display}</span>${teamHtml}</span></span>`;
}

function playerCellHtml(player, { name, liked = false } = {}) {
  const id = sleeperIdOf(player);
  const star = id ? starButtonHtml(id, liked) : "";
  return `<span class="draft-player-cell">${star}${playerMediaHtml(player, { name })}</span>`;
}

export {
  escapeHtml,
  sleeperIdOf,
  starButtonHtml,
  playerMediaHtml,
  playerCellHtml,
};
