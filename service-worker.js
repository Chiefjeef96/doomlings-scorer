/*
 * service-worker.js  —  makes the app work fully offline (no wifi at the table).
 *
 * Strategy:
 *   • On install, precache the app shell + card data.
 *   • At runtime, serve same-origin GETs cache-first, and cache anything new
 *     (so a future expansion JSON gets cached automatically the first time the
 *     app loads it online — no service-worker edit needed).
 *
 * Bump CACHE_VERSION whenever you change app files so phones pick up the update.
 */
const CACHE_VERSION = "doomlings-v1";
const CORE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/styles.css",
  "js/effects.js",
  "js/scoring.js",
  "js/data-loader.js",
  "js/app.js",
  "data/sets.json",
  "data/base-game.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // stash a copy for offline next time
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached);
    })
  );
});
