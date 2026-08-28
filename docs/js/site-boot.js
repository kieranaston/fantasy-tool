/** Shared boot: service worker + nav prefetch on hover. */

const isLocal =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

if ("serviceWorker" in navigator) {
  if (isLocal) {
    navigator.serviceWorker.getRegistrations().then((regs) =>
      Promise.all(regs.map((r) => r.unregister()))
    );
  } else {
    const swPath = window.location.pathname.includes("/tables/") ? "../sw.js" : "./sw.js";
    navigator.serviceWorker.register(swPath).catch(() => {});
  }
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
