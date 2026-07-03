import { fetchJSON, showError } from "./config.js";

/** Wire column header info icons to a fixed-position tooltip. */
function initColumnTooltips() {
  let tip = document.getElementById("col-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "col-tooltip";
    tip.className = "col-tooltip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }

  const hide = () => {
    tip.hidden = true;
  };

  const show = (el) => {
    tip.textContent = el.dataset.tooltip;
    tip.hidden = false;

    const icon = el.getBoundingClientRect();
    const pad = 8;
    let left = icon.left + icon.width / 2 - tip.offsetWidth / 2;
    let top = icon.top - tip.offsetHeight - 6;

    left = Math.max(pad, Math.min(left, window.innerWidth - tip.offsetWidth - pad));
    if (top < pad) {
      top = icon.bottom + 6;
    }

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  document.querySelectorAll(".col-info").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("focus", () => show(el));
    el.addEventListener("mouseleave", hide);
    el.addEventListener("blur", hide);
  });

  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}

/** Load rankings JSON and render a DataTables table. */
async function renderRankingsTable(tableId, jsonPath) {
  const container = document.getElementById("table-container");
  try {
    const tableData = await fetchJSON(jsonPath);
    document.getElementById("table-title").textContent = tableData.title;

    const table = document.getElementById(tableId);
    const thead = table.querySelector("thead tr");
    const tbody = table.querySelector("tbody");

    thead.innerHTML = tableData.columns.map((col) => `<th>${col}</th>`).join("");

    tbody.innerHTML = tableData.rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`
      )
      .join("");

    $(table).DataTable({
      pageLength: 25,
      order: [[0, "asc"]],
    });
  } catch (err) {
    showError(container, err.message);
  }
}

export { initColumnTooltips, renderRankingsTable };
