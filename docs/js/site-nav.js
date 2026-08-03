/** Persistent site sidebar. Paths resolve for `/` and `/tables/`. */

const NAV_ITEMS = [
  { id: "home", label: "Player News", path: "index.html" },
  { id: "overall", label: "Overall", path: "tables/overall-rankings.html" },
  { id: "qb", label: "QB", path: "tables/qb-rankings.html" },
  { id: "rb", label: "RB", path: "tables/rb-rankings.html" },
  { id: "wr", label: "WR", path: "tables/wr-rankings.html" },
  { id: "te", label: "TE", path: "tables/te-rankings.html" },
];

function navBase() {
  const path = window.location.pathname.replace(/\\/g, "/");
  return path.includes("/tables/") ? "../" : "";
}

/**
 * @param {{ current: string }} options
 */
export function mountSiteNav({ current }) {
  const root = document.getElementById("site-nav");
  if (!root) return;

  const base = navBase();
  const links = NAV_ITEMS.map((item) => {
    const href = `${base}${item.path}`;
    const active = item.id === current ? ' aria-current="page" class="is-active"' : "";
    return `<a href="${href}"${active}>${item.label}</a>`;
  }).join("");

  root.innerHTML = `
    <a class="site-nav-brand" href="${base}index.html">Fantasy Football Reference</a>
    <nav class="site-nav-links" aria-label="Primary">
      ${links}
    </nav>
  `;
}
