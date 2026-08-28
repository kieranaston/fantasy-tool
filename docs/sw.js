const CACHE = "fantasy-tool-v7";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Offline fallback for published JSON only; JS/CSS use normal browser caching. */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.includes("/data/") || !url.pathname.endsWith(".json")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
        }
        return res;
      })
      .catch(() => caches.open(CACHE).then((cache) => cache.match(req)))
  );
});
