/** Format timestamp for display. */
function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Resolve a path relative to docs/data/. */
function dataPath(relativePath) {
  const base =
    window.location.pathname.includes("/charts/") ||
    window.location.pathname.includes("/tables/")
      ? "../data"
      : "./data";
  return `${base}/${relativePath}`;
}

/** Fetch and parse a JSON file from docs/data/. */
async function fetchJSON(relativePath) {
  const response = await fetch(dataPath(relativePath), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${relativePath}: ${response.status}`);
  }
  return response.json();
}

/** Render an error message into a container element. */
function showError(container, message) {
  container.innerHTML = `<div class="error">${message}</div>`;
}

/** Load manifest and populate elements with data-manifest attributes. */
async function loadManifest() {
  const manifest = await fetchJSON("manifest.json");
  document.querySelectorAll("[data-manifest]").forEach((el) => {
    const key = el.getAttribute("data-manifest");
    if (key === "summary") {
      el.textContent = `Preseason composites · based on ${manifest.season} · Updated ${formatTimestamp(manifest.last_updated)}`;
    } else if (key in manifest) {
      el.textContent = manifest[key];
    }
  });
  return manifest;
}

export { dataPath, fetchJSON, showError, formatTimestamp, loadManifest };
