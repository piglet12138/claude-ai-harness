// Bump this version whenever the caching strategy changes — the activate
// handler purges every cache that isn't the current one.
const CACHE = "claude-shell-v2";

// Offline fallbacks only. The HTML shell ("/app") is NOT served cache-first
// anymore (that caused stale app.html to render until a hard refresh).
const SHELL = [
  "/app",
  "/styles.css",
  "/logo.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return; // never cache API

  // HTML shell + any navigation: NETWORK-FIRST so the page is always fresh
  // when online; fall back to the cached shell only when the network fails.
  if (url.pathname === "/app" || req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/app", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/app").then((c) => c || caches.match(req)))
    );
    return;
  }

  // Other shell assets: stale-while-revalidate (fast paint, self-healing).
  if (SHELL.some((s) => url.pathname === s)) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
