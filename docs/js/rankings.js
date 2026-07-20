import { fetchJSON, loadManifest, showError } from "./config.js";
import { initColumnTooltips } from "./tables.js";

const FORMAT_LABELS = {
  standard: "Standard",
  half_ppr: "Half-PPR",
  full_ppr: "Full-PPR",
  default: "Score",
};

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

function playerCell(row) {
  const logoHtml = row.logo
    ? `<img class="team-logo" src="${row.logo}" alt="${row.team}">`
    : `<span style="font-weight:600;color:${row.team_color}">${row.team}</span>`;
  const teamChange = row.new_team
    ? `<span class="team-change" title="${row.new_team_season || "Upcoming"} team (stats from ${row.team})">→ ${row.new_team}</span>`
    : "";
  return `
    <div class="player-cell">
      ${logoHtml}
      <span>${row.player}</span>
      ${teamChange}
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
            <td>${playerCell(row)}</td>
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
    currentData = await fetchJSON(`${position}/rankings.json`);
    renderTable();
  } catch (err) {
    showError(container, err.message);
  }
}

export { mountRankingsPage, FORMAT_LABELS };
