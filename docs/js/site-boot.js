/** Shared boot: service worker + nav prefetch on hover. */

if ("serviceWorker" in navigator) {
  const swPath = window.location.pathname.includes("/tables/") ? "../sw.js" : "./sw.js";
  navigator.serviceWorker.register(swPath).catch(() => {});
}

function prefetchHref(href) {
  if (!href || document.querySelector(`link[rel="prefetch"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = href;
  document.head.appendChild(link);
}

for (const link of document.querySelectorAll(".site-nav a[href]")) {
  link.addEventListener("mouseenter", () => prefetchHref(link.getAttribute("href")), {
    passive: true,
  });
}
