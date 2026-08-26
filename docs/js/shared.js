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

/** ESPN scoreboard slug when it differs from the Sleeper/nflverse abbrev. */
const TEAM_CANONICAL = {
  AZ: "ARI",
  LA: "LAR",
  STL: "LAR",
  JAC: "JAX",
  WSH: "WAS",
  OAK: "LV",
  SD: "LAC",
};

const TEAM_LOGO_SLUG = {
  WAS: "wsh",
  WSH: "wsh",
  LA: "lar",
  LAR: "lar",
  JAC: "jax",
  JAX: "jax",
  AZ: "ari",
  ARI: "ari",
};

function normalizeTeamAbbrev(team) {
  const raw = String(team || "")
    .trim()
    .toUpperCase();
  if (!raw || raw === "FA" || raw === "NONE") return "";
  return TEAM_CANONICAL[raw] || raw;
}

/** Build a team logo URL from abbrev (no per-player logo field needed). */
function teamLogoUrl(team) {
  const canon = normalizeTeamAbbrev(team);
  if (!canon) return null;
  const slug = TEAM_LOGO_SLUG[canon] || canon.toLowerCase();
  if (slug === "car") {
    return "https://a.espncdn.com/i/teamlogos/nfl/500-dark/car.png";
  }
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${slug}.png`;
}

function starButtonHtml(playerId, liked) {
  const id = escapeHtml(playerId);
  const on = Boolean(liked);
  return `<button type="button" class="draft-star${on ? " is-liked" : ""}" data-player-id="${id}" aria-label="${on ? "Remove from favourites" : "Add to favourites"}" aria-pressed="${on ? "true" : "false"}">★</button>`;
}

function playerMediaHtml(player, { name, compact = false } = {}) {
  const display = escapeHtml(
    name ||
      player?.player ||
      player?.name ||
      player?.player_name ||
      "Unknown"
  );
  const headshot = player?.headshot;
  const headshotHtml = headshot
    ? `<img class="player-headshot" src="${escapeHtml(headshot)}" alt="" width="28" height="28" loading="lazy" decoding="async" />`
    : `<span class="player-headshot player-headshot--empty" aria-hidden="true"></span>`;

  const logo = player?.logo || teamLogoUrl(player?.team);
  const team = normalizeTeamAbbrev(player?.team);
  let teamHtml = "";
  if (!compact) {
    const teamBits = [];
    if (logo) {
      teamBits.push(
        `<img class="team-logo" src="${escapeHtml(logo)}" alt="" width="14" height="14" loading="lazy" decoding="async" />`
      );
    }
    if (team) teamBits.push(`<span>${escapeHtml(team)}</span>`);
    teamHtml = teamBits.length
      ? `<span class="player-media-team">${teamBits.join("")}</span>`
      : "";
  }

  const mediaClass = compact
    ? "player-media player-media--compact"
    : "player-media";
  return `<span class="${mediaClass}">${headshotHtml}<span class="player-media-text"><span class="player-media-name">${display}</span>${teamHtml}</span></span>`;
}

function playerCellHtml(player, { name, liked = false, compact = false } = {}) {
  const id = sleeperIdOf(player);
  const star = id ? starButtonHtml(id, liked) : "";
  return `<span class="draft-player-cell">${star}${playerMediaHtml(player, { name, compact })}</span>`;
}

export {
  escapeHtml,
  sleeperIdOf,
  normalizeTeamAbbrev,
  teamLogoUrl,
  starButtonHtml,
  playerMediaHtml,
  playerCellHtml,
};
