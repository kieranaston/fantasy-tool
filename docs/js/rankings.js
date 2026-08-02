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
    if (!designation && !player.diff_summary) continue;
    const entry = {
      player_id: player.player_id,
      designation: designation || "update",
      label: truncateLabel(designation || "News"),
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

/** Build player_id → injury-history lookup. */
function buildHistoryIndex(history) {
  const byId = new Map();
  for (const player of history?.players || []) {
    if (!player?.player_id || !player.label) continue;
    byId.set(player.player_id, {
      player_id: player.player_id,
      label: truncateLabel(player.label, 36),
      summary: player.summary || player.label,
    });
  }
  return byId;
}

function historyForRow(row, historyIndex) {
  if (!historyIndex || !row.player_id) return null;
  return historyIndex.get(row.player_id) || null;
}

function playerCell(row, newsIndex, historyIndex) {
  const logoHtml = row.logo
    ? `<img class="team-logo" src="${row.logo}" alt="${row.team}">`
    : `<span style="font-weight:600;color:${row.team_color}">${row.team}</span>`;
  const teamChange = row.new_team
    ? `<span class="team-change" title="${row.new_team_season || "Upcoming"} team (stats from ${row.team})">→ ${row.new_team}</span>`
    : "";
  const news = newsForRow(row, newsIndex);
  const newsTag = news
    ? `<a class="news-tag" href="injuries.html#player-${encodeURIComponent(news.player_id)}" title="${escapeHtml(news.designation)}">${escapeHtml(news.label)}</a>`
    : "";
  const history = historyForRow(row, historyIndex);
  const historyTag = history
    ? `<a class="history-tag" href="injury-history.html#player-${encodeURIComponent(history.player_id)}" title="${escapeHtml(history.summary)}">${escapeHtml(history.label)}</a>`
    : "";
  return `
    <div class="player-cell">
      <div class="player-cell-top">
        ${logoHtml}
        <span class="player-cell-name">${row.player}</span>
        ${teamChange}
      </div>
      ${newsTag}
      ${historyTag}
    </div>`;
}

export {
  FORMAT_LABELS,
  buildNewsIndex,
  buildHistoryIndex,
  playerCell,
  escapeHtml,
  normalizeName,
};
