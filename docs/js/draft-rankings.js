import { fetchJSON, loadManifest, showError, formatTimestamp } from "./config.js";
import { initColumnTooltips } from "./tables.js";
import {
  FORMAT_LABELS,
  buildNewsIndex,
  buildHistoryIndex,
  playerCell,
  escapeHtml,
} from "./rankings.js?v=history3";

const DRAFT_FORMATS = ["half_ppr", "full_ppr"];
const STORAGE_PREFIX = "draft-rankings:";

function storageKey(position) {
  return `${STORAGE_PREFIX}${position}`;
}

function cloneOrders(orders) {
  return {
    half_ppr: [...(orders?.half_ppr || [])],
    full_ppr: [...(orders?.full_ppr || [])],
  };
}

function ecrLookup(consensus, format) {
  const map = new Map();
  for (const row of consensus?.players?.[format] || []) {
    if (row.player_id) map.set(row.player_id, row);
  }
  return map;
}

function vsEcrHtml(myRank, ecr) {
  if (ecr == null || Number.isNaN(ecr)) {
    return `<td class="draft-vs muted">—</td>`;
  }
  const diff = myRank - ecr;
  let cls = "draft-vs";
  if (diff < 0) cls += " draft-vs-higher";
  else if (diff > 0) cls += " draft-vs-lower";
  const label = diff === 0 ? "0" : diff > 0 ? `+${diff}` : String(diff);
  return `<td class="${cls}" title="My rank minus FP ECR">${label}</td>`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatLabel(format) {
  return FORMAT_LABELS[format] || format;
}

function downloadCsv({
  position,
  format,
  rows,
  ecrMap,
}) {
  const header = [
    "My Rank",
    "Player",
    "Team",
    "New Team",
    "FP ECR",
    "vs ECR",
    "Format",
    "Position",
  ];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach((row, index) => {
    const myRank = index + 1;
    const ecr = ecrMap.get(row.player_id)?.ecr;
    const vs = ecr == null ? "" : myRank - ecr;
    lines.push(
      [
        myRank,
        row.player,
        row.team || "",
        row.new_team || "",
        ecr ?? "",
        vs,
        formatLabel(format),
        position.toUpperCase(),
      ]
        .map(csvEscape)
        .join(",")
    );
  });
  const blob = new Blob([lines.join("\n") + "\n"], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${position}-draft-${format}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function mergeOrdersWithPool(orders, allIds) {
  const merged = {};
  for (const fmt of DRAFT_FORMATS) {
    const existing = new Set(orders[fmt] || []);
    merged[fmt] = [
      ...(orders[fmt] || []).filter((id) => allIds.includes(id)),
      ...allIds.filter((id) => !existing.has(id)),
    ];
  }
  return merged;
}

function scoreForFormat(row, format) {
  const scores = row?.scores || {};
  if (format in scores) return Number(scores[format]);
  if ("default" in scores) return Number(scores.default);
  const first = Object.values(scores)[0];
  return first == null ? 0 : Number(first);
}

/** Rebuild draft order from composite rankings scores (per format). */
function ordersFromComposite(rankingsRows, allIds) {
  const built = {};
  for (const fmt of DRAFT_FORMATS) {
    built[fmt] = [...(rankingsRows || [])]
      .sort((a, b) => scoreForFormat(b, fmt) - scoreForFormat(a, fmt))
      .map((row) => row.player_id)
      .filter(Boolean);
  }
  return mergeOrdersWithPool(built, allIds);
}

/**
 * @param {object} options
 * @param {string} options.position  qb|rb|wr|te
 * @param {string} options.tableId
 */
async function mountDraftRankingsPage(options) {
  const { position, tableId } = options;
  const container = document.getElementById("table-container");
  const formatToggle = document.getElementById("format-toggle");
  const downloadCsvBtn = document.getElementById("draft-download-csv");
  const resetBtn = document.getElementById("draft-reset");

  let rankings = null;
  let consensus = null;
  let newsIndex = null;
  let historyIndex = null;
  let orders = { half_ppr: [], full_ppr: [] };
  let currentFormat = "half_ppr";
  let dragFromIndex = null;
  let allIds = [];

  try {
    await loadManifest();
  } catch (err) {
    showError(container, err.message);
    return;
  }

  function persistLocal() {
    const payload = {
      position: position.toUpperCase(),
      formats: [...DRAFT_FORMATS],
      orders: cloneOrders(orders),
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem(storageKey(position), JSON.stringify(payload));
  }

  function orderedRows() {
    const byId = new Map(
      (rankings?.rows || []).map((row) => [row.player_id, row])
    );
    const order = orders[currentFormat] || [];
    const seen = new Set();
    const rows = [];
    for (const id of order) {
      const row = byId.get(id);
      if (!row || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
    for (const row of rankings?.rows || []) {
      if (!seen.has(row.player_id)) rows.push(row);
    }
    return rows;
  }

  function renderTable() {
    const rows = orderedRows();
    const ecrMap = ecrLookup(consensus, currentFormat);
    const tbody = document.querySelector(`#${tableId} tbody`);
    tbody.innerHTML = rows
      .map((row, index) => {
        const myRank = index + 1;
        const ecrRow = ecrMap.get(row.player_id);
        const ecr = ecrRow?.ecr;
        const ecrCell =
          ecr != null
            ? `<td class="num">${ecr}</td>`
            : `<td class="num muted">—</td>`;
        return `
          <tr draggable="true" data-player-id="${escapeHtml(row.player_id)}" data-index="${index}">
            <td class="draft-rank-cell">
              <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
              <span class="draft-rank">${myRank}</span>
            </td>
            <td>${playerCell(row, newsIndex, historyIndex)}</td>
            ${ecrCell}
            ${vsEcrHtml(myRank, ecr)}
          </tr>`;
      })
      .join("");

    initColumnTooltips();
    bindDrag(tbody);
  }

  function bindDrag(tbody) {
    tbody.querySelectorAll("tr[draggable='true']").forEach((tr) => {
      tr.addEventListener("dragstart", (event) => {
        dragFromIndex = Number(tr.dataset.index);
        tr.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", tr.dataset.playerId);
      });
      tr.addEventListener("dragend", () => {
        tr.classList.remove("dragging");
        dragFromIndex = null;
        tbody.querySelectorAll("tr.drag-over").forEach((el) => {
          el.classList.remove("drag-over");
        });
      });
      tr.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        tr.classList.add("drag-over");
      });
      tr.addEventListener("dragleave", () => {
        tr.classList.remove("drag-over");
      });
      tr.addEventListener("drop", (event) => {
        event.preventDefault();
        tr.classList.remove("drag-over");
        const toIndex = Number(tr.dataset.index);
        if (
          dragFromIndex == null ||
          Number.isNaN(toIndex) ||
          dragFromIndex === toIndex
        ) {
          return;
        }
        const displayIds = orderedRows().map((r) => r.player_id);
        const [moved] = displayIds.splice(dragFromIndex, 1);
        displayIds.splice(toIndex, 0, moved);
        orders[currentFormat] = displayIds;
        persistLocal();
        renderTable();
      });
    });
  }

  if (formatToggle) {
    formatToggle.innerHTML = DRAFT_FORMATS.map(
      (fmt) =>
        `<button type="button" data-format="${fmt}" class="${fmt === currentFormat ? "active" : ""}">${FORMAT_LABELS[fmt] || fmt}</button>`
    ).join("");
    formatToggle.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-format]");
      if (!button) return;
      currentFormat = button.dataset.format;
      formatToggle.querySelectorAll("button").forEach((el) => {
        el.classList.toggle("active", el.dataset.format === currentFormat);
      });
      renderTable();
    });
  }

  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener("click", () => {
      downloadCsv({
        position,
        format: currentFormat,
        rows: orderedRows(),
        ecrMap: ecrLookup(consensus, currentFormat),
      });
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (
        !window.confirm(
          "Reset this draft board to your composite rankings? Saved drag order for both formats will be replaced."
        )
      ) {
        return;
      }
      orders = ordersFromComposite(rankings?.rows || [], allIds);
      persistLocal();
      renderTable();
    });
  }

  try {
    const [rankingsData, draftData, consensusData, summaries, history] =
      await Promise.all([
        fetchJSON(`${position}/rankings.json`),
        fetchJSON(`${position}/draft-rankings.json`).catch(() => null),
        fetchJSON(`${position}/consensus.json`).catch(() => null),
        fetchJSON("injuries/summaries.json").catch(() => null),
        fetchJSON("injuries/history.json").catch(() => null),
      ]);

    rankings = rankingsData;
    consensus = consensusData;
    newsIndex = buildNewsIndex(summaries);
    historyIndex = buildHistoryIndex(history);

    allIds = (rankings.rows || [])
      .map((r) => r.player_id)
      .filter(Boolean);

    let local = null;
    try {
      local = JSON.parse(localStorage.getItem(storageKey(position)) || "null");
    } catch {
      local = null;
    }

    // Prefer saved browser order; seed once from committed file / composite.
    if (local?.orders) {
      orders = mergeOrdersWithPool(cloneOrders(local.orders), allIds);
    } else if (draftData?.orders) {
      orders = mergeOrdersWithPool(cloneOrders(draftData.orders), allIds);
      persistLocal();
    } else {
      orders = ordersFromComposite(rankings.rows || [], allIds);
      persistLocal();
    }

    const meta = document.querySelector("[data-draft='summary']");
    if (meta) {
      const parts = [`Based on ${rankings.season}`];
      if (consensus?.last_updated) {
        parts.push(
          `FP ECR updated ${formatTimestamp(consensus.last_updated)}`
        );
      }
      meta.textContent = parts.join(" · ");
    }

    renderTable();
  } catch (err) {
    showError(container, err.message);
  }
}

export { mountDraftRankingsPage };
