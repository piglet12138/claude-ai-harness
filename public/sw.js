const CACHE = "claude-shell-v1";
// /app is served by server.mjs as app.html — cache the actual route URL
const SHELL = [
  "/app",
  "/styles.css",
  "/logo.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never cache API calls
  if (url.pathname.startsWith("/api/")) return;

  // Cache-first for shell resources
  if (SHELL.some((s) => url.pathname === s)) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
  }
});
