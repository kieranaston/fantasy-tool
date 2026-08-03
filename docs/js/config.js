/** Format timestamp in US Eastern time (EST/EDT). */
function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
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

/** Show main content after async page data has rendered. */
function revealPage() {
  document.body.classList.remove("is-page-loading");
}

/** Load manifest and populate elements with data-manifest attributes. */
async function loadManifest() {
  const manifest = await fetchJSON("manifest.json");
  const summaryEls = document.querySelectorAll("[data-manifest='summary']");
  if (summaryEls.length) {
    let statusUpdated = null;
    try {
      const injuries = await fetchJSON("injuries/summaries.json");
      statusUpdated = injuries.last_updated || null;
    } catch {
      statusUpdated = null;
    }

    const parts = [`Based on ${manifest.season}`];
    if (manifest.last_updated) {
      parts.push(`Teams last updated ${formatTimestamp(manifest.last_updated)}`);
    }
    if (statusUpdated) {
      parts.push(`Player status updated ${formatTimestamp(statusUpdated)}`);
    }

    summaryEls.forEach((el) => {
      el.textContent = parts.join(" · ");
    });
  }

  document.querySelectorAll("[data-manifest]").forEach((el) => {
    const key = el.getAttribute("data-manifest");
    if (key === "summary") return;
    if (key in manifest) {
      el.textContent = manifest[key];
    }
  });
  return manifest;
}

export { dataPath, fetchJSON, showError, revealPage, formatTimestamp, loadManifest };
