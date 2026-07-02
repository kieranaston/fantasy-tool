import { fetchJSON, showError } from "./config.js";

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

export { renderRankingsTable };
