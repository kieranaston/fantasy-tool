const FORMAT_LABELS = {
  standard: "Standard",
  half_ppr: "Half-PPR",
  full_ppr: "Full-PPR",
  default: "Score",
};

const NEWS_TAG_MAX = 28;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function truncateLabel(text, max = NEWS_TAG_MAX) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Build player_id → status lookup (name fallback for older rows). */
function buildNewsIndex(summaries) {
  const byId = new Map();
  const byName = new Map();
  for (const player of summaries?.players || []) {
    if (!player?.player_id) continue;
    const designation = (player.current_designation || "").trim();
    const summary = String(player.diff_summary || "").trim();
    if (!designation && !summary) continue;
    const entry = {
      player_id: player.player_id,
      designation: designation || "update",
      label: truncateLabel(designation || "News"),
      summary: summary || designation || "News",
    };
    byId.set(player.player_id, entry);
    const key = normalizeName(player.player_name);
    if (key) byName.set(key, entry);
  }
  return { byId, byName };
}

function newsForRow(row, newsIndex) {
  if (!newsIndex) return null;
  if (row.player_id && newsIndex.byId.has(row.player_id)) {
    return newsIndex.byId.get(row.player_id);
  }
  return newsIndex.byName.get(normalizeName(row.player)) || null;
}

function playerCell(row, newsIndex) {
  const logoHtml = row.logo
    ? `<img class="team-logo" src="${row.logo}" alt="${row.team}">`
    : `<span style="font-weight:600;color:${row.team_color}">${row.team}</span>`;
  const teamChange = row.new_team
    ? `<span class="team-change" title="${row.new_team_season || "Upcoming"} team (stats from ${row.team})">→ ${row.new_team}</span>`
    : "";
  const news = newsForRow(row, newsIndex);
  const newsTag = news
    ? `<a class="news-tag" href="../index.html#player-${encodeURIComponent(news.player_id)}" data-news-summary="${escapeHtml(news.summary)}">${escapeHtml(news.label)}</a>`
    : "";
  return `
    <div class="player-cell">
      <div class="player-cell-top">
        ${logoHtml}
        <span class="player-cell-name">${row.player}</span>
        ${teamChange}
      </div>
      ${newsTag}
    </div>`;
}

export {
  FORMAT_LABELS,
  buildNewsIndex,
  playerCell,
  escapeHtml,
  normalizeName,
};
