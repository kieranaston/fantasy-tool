import { escapeHtml } from "./shared.js?v=7";

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

/** Page header: "Updated: Aug 17". */
function formatUpdated(isoString) {
  if (!isoString) return "Updated: —";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Updated: —";
  const day = date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
  return `Updated: ${day}`;
}

/** Resolve a path relative to docs/data/. */
function dataPath(relativePath) {
  const base = window.location.pathname.includes("/tables/")
    ? "../data"
    : "./data";
  return `${base}/${relativePath}`;
}

/**
 * Fetch and parse a JSON file from docs/data/.
 * Default no-cache revalidates against GitHub Pages ETags on each load.
 * Pass cache: "no-store" for live/volatile fetches (e.g. Bluesky).
 */
async function fetchJSON(
  relativePath,
  { cache = "no-cache", timeoutMs = 12000, version = null } = {}
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url = dataPath(relativePath);
    if (version != null && version !== "") {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}v=${encodeURIComponent(String(version))}`;
    }
    const response = await fetch(url, {
      cache,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to load ${relativePath}: ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Timed out loading ${relativePath}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Render an error message into a container element. */
function showError(container, message) {
  container.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
}

/** Top-level mount wrapper: reveal page and show escaped errors on failure. */
function mountPage(mountFn, containerId) {
  return mountFn().catch((err) => {
    document.body.classList.remove("is-page-loading");
    const el = document.getElementById(containerId);
    if (el) showError(el, err?.message || String(err));
  });
}

/** Show main content after async page data has rendered. */
function revealPage() {
  document.body.classList.remove("is-page-loading");
}

export {
  dataPath,
  fetchJSON,
  showError,
  mountPage,
  revealPage,
  formatTimestamp,
  formatUpdated,
};
