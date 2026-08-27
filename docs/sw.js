const CACHE = "fantasy-tool-v2";
const PRECACHE = ["./css/site.css"];

function isPublishedDataJson(pathname) {
  return pathname.includes("/data/") && pathname.endsWith(".json");
}

function isStaticAsset(pathname) {
  return pathname.endsWith(".js") || pathname.endsWith(".css");
}

async function networkFirst(cache, req) {
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw new Error("Offline and no cached copy");
  }
}

async function cacheFirst(cache, req) {
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (!isPublishedDataJson(path) && !isStaticAsset(path) && !path.endsWith(".html")) return;

  event.respondWith(
    caches.open(CACHE).then((cache) => {
      // Daily CI updates JSON under docs/data/; always prefer the network.
      if (isPublishedDataJson(path) || path.endsWith(".html")) {
        return networkFirst(cache, req);
      }
      // JS/CSS use ?v= query params for deploy busting; cache-first is fine.
      return cacheFirst(cache, req);
    })
  );
});
