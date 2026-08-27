/** Incremental table body sync — keeps stable rows (e.g. headshot imgs) when keyed. */

export function ensureTableBody(container, { tableClass, theadHtml, emptyHtml }) {
  if (!container) return null;
  let table = container.querySelector("table");
  if (!table) {
    container.innerHTML = `<table class="${tableClass}">${theadHtml}<tbody></tbody></table>`;
    return container.querySelector("tbody");
  }
  const thead = table.querySelector("thead");
  if (!thead && theadHtml) {
    table.insertAdjacentHTML("afterbegin", theadHtml);
  }
  let tbody = table.querySelector("tbody");
  if (!tbody) {
    table.insertAdjacentHTML("beforeend", "<tbody></tbody>");
    tbody = table.querySelector("tbody");
  }
  return tbody;
}

export function showTableMessage(container, html) {
  if (!container) return;
  container.innerHTML = html;
}

/**
 * Sync tbody rows by key. createRow/updateRow receive (item, tr?).
 * updateRow should only touch cells that changed when possible.
 */
export function syncTableRows(tbody, items, { key, createRow, updateRow }) {
  if (!tbody) return;
  const existing = new Map();
  for (const tr of [...tbody.querySelectorAll("tr[data-row-key]")]) {
    existing.set(tr.dataset.rowKey, tr);
  }
  const seen = new Set();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const k = String(key(item, i));
    seen.add(k);
    let tr = existing.get(k);
    if (!tr) {
      tr = createRow(item, i);
      tr.dataset.rowKey = k;
      frag.appendChild(tr);
    } else {
      updateRow(tr, item, i);
      frag.appendChild(tr);
    }
    existing.delete(k);
  }
  tbody.replaceChildren(frag);
  for (const tr of existing.values()) tr.remove();
}
