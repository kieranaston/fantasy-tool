import { fetchJSON, loadManifest, showError, formatTimestamp } from "./config.js";
import { initColumnTooltips } from "./tables.js";
import {
  FORMAT_LABELS,
  buildNewsIndex,
  playerCell,
  escapeHtml,
} from "./rankings.js?v=helpers2";
import {
  isSyncConfigured,
  getSession,
  onAuthChange,
  signInWithEmail,
  signOut,
  fetchBoard,
  createDebouncedSaver,
  pickNewerBoard,
} from "./rankings-sync.js";

const BOARD_FORMATS = ["half_ppr", "full_ppr"];
const STORAGE_PREFIX = "adp-rankings:";

function storageKey(position) {
  return `${STORAGE_PREFIX}${String(position).toLowerCase()}`;
}

function cloneOrders(orders) {
  const out = {};
  for (const fmt of BOARD_FORMATS) {
    out[fmt] = [...(orders?.[fmt] || [])];
  }
  return out;
}

function cloneTier(tiers) {
  const out = {};
  for (const fmt of BOARD_FORMATS) {
    out[fmt] = [...(tiers?.[fmt] || [])].map(Number).filter((n) => !Number.isNaN(n));
  }
  return out;
}

function cloneExcluded(excluded) {
  return [...new Set((excluded || []).filter(Boolean))];
}

function adpLookup(adpPayload, format) {
  const map = new Map();
  for (const row of adpPayload?.players?.[format] || []) {
    if (row.player_id) map.set(row.player_id, row);
  }
  return map;
}

function formatAdp(adp) {
  if (adp == null || Number.isNaN(Number(adp))) return "—";
  return Number(adp).toFixed(1);
}

/** Per-player value: market − my rank. Positive = value vs ADP. */
function playerValue(myRank, marketRank) {
  if (marketRank == null || Number.isNaN(Number(marketRank))) return null;
  return Number(marketRank) - myRank;
}

function valueHtml(value, { title }) {
  if (value == null || Number.isNaN(value)) {
    return `<td class="draft-vs muted">—</td>`;
  }
  const rounded = Math.round(value * 10) / 10;
  // Positive = available later than your rank (value) → green.
  let color = "inherit";
  if (rounded > 0) color = "#15803d";
  else if (rounded < 0) color = "#64748b";
  const label =
    rounded === 0 ? "0" : rounded > 0 ? `+${rounded}` : String(rounded);
  return `<td class="draft-vs" style="color:${color};font-weight:600" title="${escapeHtml(title)}">${label}</td>`;
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

function mergeOrdersWithPool(orders, allIds) {
  const merged = {};
  for (const fmt of BOARD_FORMATS) {
    const existing = new Set(orders[fmt] || []);
    merged[fmt] = [
      ...(orders[fmt] || []).filter((id) => allIds.includes(id)),
      ...allIds.filter((id) => !existing.has(id)),
    ];
  }
  return merged;
}

function sanitizeTier(tiers, orders) {
  const cleaned = {};
  for (const fmt of BOARD_FORMATS) {
    const max = (orders[fmt] || []).length;
    const unique = [
      ...new Set(
        (tiers[fmt] || [])
          .map(Number)
          .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < max - 1)
      ),
    ].sort((a, b) => a - b);
    cleaned[fmt] = unique;
  }
  return cleaned;
}

/** Tier number for a 0-based index given break indices (after these rows). */
function tierForIndex(index, breaks) {
  let tier = 1;
  for (const breakIdx of breaks || []) {
    if (index > breakIdx) tier += 1;
    else break;
  }
  return tier;
}

function ordersFromAdp(adpPayload) {
  const built = {};
  for (const fmt of BOARD_FORMATS) {
    built[fmt] = (adpPayload?.players?.[fmt] || [])
      .map((row) => row.player_id)
      .filter(Boolean);
  }
  return built;
}

function downloadCsv({
  position,
  format,
  rows,
  isOverall,
  breaks,
  excludedIds,
}) {
  const header = isOverall
    ? ["My Rank", "Tier", "Player", "Pos", "Team", "ADP", "Value", "Excluded", "Format"]
    : ["My Rank", "Tier", "Player", "Team", "ADP", "ADP Rank", "Value", "Excluded", "Format", "Position"];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach((row, index) => {
    const myRank = index + 1;
    const tier = tierForIndex(index, breaks);
    const market = isOverall ? row.adp : row.adp_rank;
    const value = playerValue(myRank, market);
    const cols = isOverall
      ? [
          myRank,
          tier,
          row.player,
          row.position || "",
          row.team || "",
          row.adp ?? "",
          value ?? "",
          excludedIds?.has(row.player_id) ? "yes" : "",
          formatLabel(format),
        ]
      : [
          myRank,
          tier,
          row.player,
          row.team || "",
          row.adp ?? "",
          row.adp_rank ?? "",
          value ?? "",
          excludedIds?.has(row.player_id) ? "yes" : "",
          formatLabel(format),
          position.toUpperCase(),
        ];
    lines.push(cols.map(csvEscape).join(","));
  });
  const blob = new Blob([lines.join("\n") + "\n"], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${String(position).toLowerCase()}-rankings-${format}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {object} options
 * @param {string} options.position  overall|qb|rb|wr|te
 * @param {string} options.tableId
 */
async function mountAdpRankingsPage(options) {
  const { position, tableId } = options;
  const isOverall = String(position).toLowerCase() === "overall";
  const container = document.getElementById("table-container");
  const formatToggle = document.getElementById("format-toggle");
  const downloadCsvBtn = document.getElementById("draft-download-csv");
  const resetBtn = document.getElementById("draft-reset");

  let adp = null;
  let newsIndex = null;
  let orders = { half_ppr: [], full_ppr: [] };
  let tierBreaks = { half_ppr: [], full_ppr: [] };
  let excluded = [];
  let currentFormat = "half_ppr";
  let dragFromIndex = null;
  let allIds = [];
  let syncStatus = isSyncConfigured() ? "Checking sync…" : "Local only";
  let signedInEmail = null;
  const remoteSaver = createDebouncedSaver({
    onSuccess: () => {
      if (signedInEmail) setSyncStatus("Synced across devices");
    },
    onError: (err) => {
      setSyncStatus(err.message || "Sync failed");
    },
  });

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && signedInEmail) {
      remoteSaver.flush().catch(() => {});
    }
  });
  window.addEventListener("pagehide", () => {
    if (signedInEmail) remoteSaver.flush().catch(() => {});
  });

  try {
    await loadManifest();
  } catch (err) {
    showError(container, err.message);
    return;
  }

  function boardPayload() {
    return {
      position: String(position).toUpperCase(),
      formats: [...BOARD_FORMATS],
      orders: cloneOrders(orders),
      tier_breaks: cloneTier(tierBreaks),
      excluded: cloneExcluded(excluded),
      updated_at: new Date().toISOString(),
    };
  }

  function isExcluded(playerId) {
    return excluded.includes(playerId);
  }

  function toggleExcluded(playerId) {
    if (!playerId) return;
    if (isExcluded(playerId)) {
      excluded = excluded.filter((id) => id !== playerId);
    } else {
      excluded = [...excluded, playerId];
    }
    persist();
    renderTable();
  }

  function setSyncStatus(text) {
    syncStatus = text;
    const el = document.querySelector("[data-sync-status]");
    if (el) el.textContent = text;
  }

  function renderSyncBar() {
    const host = document.querySelector(".draft-controls");
    if (!host) return;
    let bar = document.getElementById("sync-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "sync-bar";
      bar.className = "sync-bar";
      host.appendChild(bar);
    }

    if (!isSyncConfigured()) {
      bar.innerHTML = `
        <span class="sync-status" data-sync-status>Local only — add Supabase keys in sync-config.js for multi-device sync</span>`;
      return;
    }

    if (signedInEmail) {
      bar.innerHTML = `
        <span class="sync-status" data-sync-status>${escapeHtml(syncStatus)}</span>
        <span class="sync-user">${escapeHtml(signedInEmail)}</span>
        <button type="button" class="draft-btn" data-sync-signout>Sign out</button>`;
      bar.querySelector("[data-sync-signout]")?.addEventListener("click", async () => {
        try {
          await signOut();
          signedInEmail = null;
          setSyncStatus("Signed out — local only until you sign in");
          renderSyncBar();
        } catch (err) {
          setSyncStatus(err.message || "Sign out failed");
        }
      });
      return;
    }

    bar.innerHTML = `
      <span class="sync-status" data-sync-status>${escapeHtml(syncStatus)}</span>
      <form class="sync-login" data-sync-login>
        <input type="email" name="email" required placeholder="Email for magic link" autocomplete="email" />
        <button type="submit" class="draft-btn">Sign in to sync</button>
      </form>`;
    bar.querySelector("[data-sync-login]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = new FormData(event.target).get("email");
      try {
        setSyncStatus("Sending magic link…");
        await signInWithEmail(email);
        setSyncStatus("Check your email for the sign-in link");
      } catch (err) {
        setSyncStatus(err.message || "Sign-in failed");
      }
    });
  }

  function persist() {
    const payload = boardPayload();
    localStorage.setItem(storageKey(position), JSON.stringify(payload));
    if (isSyncConfigured() && signedInEmail) {
      setSyncStatus("Saving…");
      remoteSaver.schedule(payload);
    }
  }

  function applyBoard(board) {
    if (!board?.orders) return;
    orders = mergeOrdersWithPool(cloneOrders(board.orders), allIds);
    tierBreaks = sanitizeTier(cloneTier(board.tier_breaks), orders);
    excluded = cloneExcluded(board.excluded).filter((id) => allIds.includes(id));
    orders = mergeOrdersWithPool(orders, allIds);
  }

  function orderedRows() {
    const byId = adpLookup(adp, currentFormat);
    const order = orders[currentFormat] || [];
    const seen = new Set();
    const rows = [];
    for (const id of order) {
      const row = byId.get(id);
      if (!row || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
    for (const row of adp?.players?.[currentFormat] || []) {
      if (!seen.has(row.player_id)) rows.push(row);
    }
    return rows;
  }

  function renderTable() {
    const rows = orderedRows();
    const breaks = tierBreaks[currentFormat] || [];
    const tbody = document.querySelector(`#${tableId} tbody`);
    const parts = [];

    rows.forEach((row, index) => {
      const myRank = index + 1;
      const tier = tierForIndex(index, breaks);
      const market = isOverall ? row.adp : row.adp_rank;
      const value = playerValue(myRank, market);
      const valueTitle = isOverall
        ? "ADP minus my overall rank. Positive = value (market later than you)."
        : "Positional ADP rank minus my rank. Positive = value.";
      const crossedOut = isExcluded(row.player_id);

      const adpCell = `<td class="num">${formatAdp(row.adp)}</td>`;
      const marketCell = isOverall
        ? ""
        : row.adp_rank != null
          ? `<td class="num">${row.adp_rank}</td>`
          : `<td class="num muted">—</td>`;
      const posCell = isOverall
        ? `<td class="pos-cell">${escapeHtml(row.position || "")}</td>`
        : "";

      parts.push(`
        <tr draggable="true" class="${crossedOut ? "player-excluded" : ""}" data-player-id="${escapeHtml(row.player_id)}" data-index="${index}">
          <td class="draft-rank-cell">
            <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
            <span class="draft-rank">${myRank}</span>
          </td>
          <td class="num tier-num" title="Tier ${tier}">T${tier}</td>
          <td>${playerCell(row, newsIndex)}</td>
          ${posCell}
          ${adpCell}
          ${marketCell}
          ${valueHtml(value, { title: valueTitle })}
          <td class="tier-actions">
            <button type="button" class="exclude-btn${crossedOut ? " is-excluded" : ""}" data-exclude-id="${escapeHtml(row.player_id)}" title="${crossedOut ? "Restore player" : "Cross out (won't consider)"}" aria-label="${crossedOut ? "Restore player" : "Cross out player"}">${crossedOut ? "↩" : "×"}</button>
            <button type="button" class="tier-break-btn" data-break-after="${index}" title="Toggle tier break below this player">+</button>
          </td>
        </tr>`);

      if (breaks.includes(index) && index < rows.length - 1) {
        parts.push(`
          <tr class="tier-break-row" data-break-index="${index}">
            <td colspan="${isOverall ? 7 : 7}">
              <div class="tier-break-line">
                <span>Tier ${tier + 1}</span>
                <button type="button" class="tier-break-remove" data-break-after="${index}" title="Remove tier break">Remove</button>
              </div>
            </td>
          </tr>`);
      }
    });

    tbody.innerHTML = parts.join("");
    initColumnTooltips();
    bindDrag(tbody);
    bindTierButtons(tbody);
    bindExcludeButtons(tbody);
  }

  function bindExcludeButtons(tbody) {
    tbody.querySelectorAll("[data-exclude-id]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleExcluded(btn.dataset.excludeId);
      });
    });
  }

  function toggleBreak(afterIndex) {
    const current = new Set(tierBreaks[currentFormat] || []);
    if (current.has(afterIndex)) current.delete(afterIndex);
    else current.add(afterIndex);
    tierBreaks[currentFormat] = [...current].sort((a, b) => a - b);
    tierBreaks = sanitizeTier(tierBreaks, orders);
    persist();
    renderTable();
  }

  function bindTierButtons(tbody) {
    tbody.querySelectorAll("[data-break-after]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const idx = Number(btn.dataset.breakAfter);
        if (Number.isNaN(idx)) return;
        toggleBreak(idx);
      });
    });
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
        persist();
        renderTable();
      });
    });
  }

  if (formatToggle) {
    formatToggle.innerHTML = BOARD_FORMATS.map(
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
        isOverall,
        breaks: tierBreaks[currentFormat] || [],
        excludedIds: new Set(excluded),
      });
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (
        !window.confirm(
          "Reset this board to Sleeper ADP order, clear tier breaks, and restore all crossed-out players?"
        )
      ) {
        return;
      }
      orders = mergeOrdersWithPool(ordersFromAdp(adp), allIds);
      tierBreaks = { half_ppr: [], full_ppr: [] };
      excluded = [];
      persist();
      renderTable();
    });
  }

  async function hydrateFromSources(seedData) {
    let local = null;
    try {
      local = JSON.parse(localStorage.getItem(storageKey(position)) || "null");
    } catch {
      local = null;
    }

    let remote = null;
    if (isSyncConfigured()) {
      try {
        const session = await getSession();
        signedInEmail = session?.user?.email || null;
        if (signedInEmail) {
          remote = await fetchBoard(position);
        }
      } catch (err) {
        setSyncStatus(err.message || "Sync unavailable");
      }
    }

    const seedBoard = seedData?.orders
      ? {
          orders: seedData.orders,
          tier_breaks: seedData.tier_breaks || {},
          updated_at: seedData.updated_at || null,
        }
      : null;

    const { source, board } = pickNewerBoard(local, remote);
    if (board?.orders) {
      applyBoard(board);
      if (source === "remote") {
        localStorage.setItem(
          storageKey(position),
          JSON.stringify({
            position: String(position).toUpperCase(),
            formats: [...BOARD_FORMATS],
            orders: cloneOrders(orders),
            tier_breaks: cloneTier(tierBreaks),
            excluded: cloneExcluded(excluded),
            updated_at: board.updated_at || new Date().toISOString(),
          })
        );
        setSyncStatus("Loaded synced rankings");
      } else if (source === "local" && signedInEmail) {
        // Local is newer — push up so other devices catch up.
        persist();
        setSyncStatus("Synced local rankings to cloud");
      } else if (!signedInEmail && isSyncConfigured()) {
        setSyncStatus("Sign in to sync across devices");
      } else if (!isSyncConfigured()) {
        setSyncStatus("Local only");
      }
    } else if (seedBoard) {
      applyBoard(seedBoard);
      persist();
    } else {
      orders = mergeOrdersWithPool(ordersFromAdp(adp), allIds);
      tierBreaks = { half_ppr: [], full_ppr: [] };
      excluded = [];
      persist();
    }

    orders = mergeOrdersWithPool(orders, allIds);
    renderSyncBar();
  }

  try {
    const posKey = String(position).toLowerCase();
    const [adpData, seedData, summaries] = await Promise.all([
      fetchJSON(`${posKey}/adp.json`),
      fetchJSON(`${posKey}/my-rankings.json`).catch(() => null),
      fetchJSON("injuries/summaries.json").catch(() => null),
    ]);

    adp = adpData;
    newsIndex = buildNewsIndex(summaries);

    allIds = (adp.players?.[currentFormat] || [])
      .map((r) => r.player_id)
      .filter(Boolean);
    const idSet = new Set(allIds);
    for (const fmt of BOARD_FORMATS) {
      for (const row of adp.players?.[fmt] || []) {
        if (row.player_id) idSet.add(row.player_id);
      }
    }
    allIds = [...idSet];

    await hydrateFromSources(seedData);

    if (isSyncConfigured()) {
      onAuthChange(async (session) => {
        const email = session?.user?.email || null;
        const wasSignedIn = Boolean(signedInEmail);
        signedInEmail = email;
        renderSyncBar();
        if (email && !wasSignedIn) {
          try {
            const remote = await fetchBoard(position);
            let local = null;
            try {
              local = JSON.parse(localStorage.getItem(storageKey(position)) || "null");
            } catch {
              local = null;
            }
            const { source, board } = pickNewerBoard(local, remote);
            if (board?.orders) {
              applyBoard(board);
              if (source === "remote") {
                localStorage.setItem(storageKey(position), JSON.stringify({
                  ...boardPayload(),
                  updated_at: board.updated_at || new Date().toISOString(),
                }));
                setSyncStatus("Loaded synced rankings");
              } else {
                persist();
                setSyncStatus("Synced local rankings to cloud");
              }
              renderTable();
            } else {
              persist();
              setSyncStatus("Synced across devices");
            }
          } catch (err) {
            setSyncStatus(err.message || "Sync failed");
          }
        } else if (!email) {
          setSyncStatus("Sign in to sync across devices");
        }
      });
    } else {
      renderSyncBar();
    }

    const meta = document.querySelector("[data-draft='summary']");
    if (meta) {
      const parts = [`Sleeper ADP ${adp.season}`];
      if (adp.last_updated) {
        parts.push(`updated ${formatTimestamp(adp.last_updated)}`);
      }
      parts.push("Drag to rank · × crosses out · + adds a tier break");
      meta.textContent = parts.join(" · ");
    }

    renderTable();
  } catch (err) {
    showError(container, err.message);
  }
}

export { mountAdpRankingsPage };
