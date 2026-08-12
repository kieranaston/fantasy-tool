/** Shared DOM / ID helpers for draft + ADP pages. */

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

export { escapeHtml, sleeperIdOf, starButtonHtml };
