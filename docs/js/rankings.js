import { fetchJSON, loadManifest, showError } from "./config.js";
import { initColumnTooltips } from "./tables.js";

const FORMAT_LABELS = {
  standard: "Standard",
  half_ppr: "Half-PPR",
  full_ppr: "Full-PPR",
  default: "Score",
};

const NEWS_TAG_MAX = 28;

function scoreStyle(score, min, max) {
  if (max === min) {
    return "background:rgb(217,246,232)";
  }
  const t = Math.max(0, Math.min(1, (score - min) / (max - min)));
  const r = Math.round(255 + t * (180 - 255));
  const g = Math.round(255 + t * (236 - 255));
  const b = Math.round(255 + t * (210 - 255));
  return `background:rgb(${r},${g},${b})`;
}

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

function activeScore(row, format) {
  return row.scores[format] ?? row.scores.default;
}

function sortedRows(rows, format) {
  return [...rows]
    .sort((a, b) => activeScore(b, format) - activeScore(a, format))
    .map((row, idx) => ({ ...row, rank: idx + 1 }));
}

/**
 * Mount a position rankings page with optional format controls.
 *
 * @param {object} options
 * @param {string} options.position  lowercase position key (qb/rb/wr/te)
 * @param {string} options.tableId
 * @param {boolean} [options.showFormat=true]
 * @param {(row: object) => string} options.metricCells  extra <td> HTML for metric cols
 * @param {number[]} options.numericTargets  DataTables column indexes that are numeric
 */
async function mountRankingsPage(options) {
  const {
    position,
    tableId,
    showFormat = true,
    metricCells,
    numericTargets,
  } = options;

  const container = document.getElementById("table-container");
  const formatToggle = document.getElementById("format-toggle");

  let manifest;
  let currentData = null;
  let newsIndex = null;
  let historyIndex = null;
  let currentFormat = showFormat ? "half_ppr" : "default";
  let dataTable = null;

  try {
    manifest = await loadManifest();
  } catch (err) {
    showError(container, err.message);
    return;
  }

  if (showFormat && formatToggle) {
    formatToggle.innerHTML = (manifest.formats || ["standard", "half_ppr", "full_ppr"])
      .map(
        (fmt) =>
          `<button type="button" data-format="${fmt}" class="${fmt === currentFormat ? "active" : ""}">${FORMAT_LABELS[fmt] || fmt}</button>`
      )
      .join("");

    formatToggle.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-format]");
      if (!button) return;
      currentFormat = button.dataset.format;
      formatToggle.querySelectorAll("button").forEach((el) => {
        el.classList.toggle("active", el.dataset.format === currentFormat);
      });
      renderTable();
    });
  } else if (formatToggle) {
    const formatGroup = formatToggle.parentElement;
    if (formatGroup) {
      formatGroup.hidden = true;
    }
  }

  function renderTable() {
    if (!currentData) return;
    const rows = sortedRows(currentData.rows, currentFormat);
    const scores = rows.map((r) => activeScore(r, currentFormat));
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);

    if (dataTable) {
      dataTable.destroy();
      dataTable = null;
    }

    const tbody = document.querySelector(`#${tableId} tbody`);
    tbody.innerHTML = rows
      .map((row) => {
        const score = activeScore(row, currentFormat);
        const cellStyle = scoreStyle(score, minScore, maxScore);
        return `
          <tr>
            <td>${row.rank}</td>
            <td>${playerCell(row, newsIndex, historyIndex)}</td>
            <td>${row.games_played}</td>
            ${metricCells(row)}
            <td class="score-cell" style="${cellStyle}">${score.toFixed(1)}</td>
          </tr>`;
      })
      .join("");

    dataTable = $(`#${tableId}`).DataTable({
      paging: false,
      searching: false,
      info: false,
      order: [],
      autoWidth: false,
      dom: "t",
      columnDefs: [
        { targets: 0, type: "num" },
        { targets: numericTargets, type: "num" },
        { targets: 1, orderable: false },
      ],
    });

    initColumnTooltips();
  }

  try {
    const [rankings, summaries, history] = await Promise.all([
      fetchJSON(`${position}/rankings.json`),
      fetchJSON("injuries/summaries.json").catch(() => null),
      fetchJSON("injuries/history.json").catch(() => null),
    ]);
    currentData = rankings;
    newsIndex = buildNewsIndex(summaries);
    historyIndex = buildHistoryIndex(history);
    renderTable();
  } catch (err) {
    showError(container, err.message);
  }
}

export {
  mountRankingsPage,
  FORMAT_LABELS,
  buildNewsIndex,
  buildHistoryIndex,
  playerCell,
  escapeHtml,
  normalizeName,
};
