// Service worker for the driver PWA. Scope is "/pwa/" only (see
// server.js's comment on the /pwa static mount) — this never touches the
// office app.
//
// Two caches, two very different lifetimes:
//  - SHELL_CACHE: the app's own files (HTML/CSS/JS/icons + the MapLibre
//    library). Versioned by SHELL_CACHE_NAME — bump it whenever a shell
//    file changes, so an old cached copy never sticks around forever.
//  - TILE_CACHE: map tiles/style JSON from the OpenFreeMap-style host.
//    Cache-first and NEVER cleared by a version bump — tiles for a given
//    coordinate don't change, and re-downloading a whole country's worth
//    of tiles after every deploy would defeat the entire point of
//    caching them (staying usable in a signal dead zone).
//
// /api/* is deliberately never touched here: those calls need a real
// answer (or a real failure the app's own sync queue can react to), not
// a stale cached one.

const SHELL_CACHE_NAME = "rt-pwa-shell-v1";
const TILE_CACHE_NAME = "rt-pwa-tiles-v1";

const SHELL_FILES = [
  "/pwa/",
  "/pwa/index.html",
  "/pwa/manifest.json",
  "/pwa/css/pwa.css",
  "/pwa/js/config.js",
  "/pwa/js/db.js",
  "/pwa/js/sync.js",
  "/pwa/js/scanner.js",
  "/pwa/js/list.js",
  "/pwa/js/map.js",
  "/pwa/js/app.js",
  "/pwa/icons/icon-192.png",
  "/pwa/icons/icon-512.png",
  "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== SHELL_CACHE_NAME && name !== TILE_CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

// The style/tile host is a config value on the client (RTConfig), not
// something this static file can import — matched by hostname instead,
// which covers both the style JSON and every tile it references without
// needing to know the exact URL shape either uses.
function isTileRequest(url) {
  return url.hostname.endsWith("openfreemap.org") || url.hostname.endsWith("maptiler.com");
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return; // never cache a POST (stop status updates)
  if (isApiRequest(url)) return; // let it hit the network untouched

  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(event.request, TILE_CACHE_NAME));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
