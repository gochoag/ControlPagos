const CACHE_NAME = "controlpagos-shell-v5";
const SHELL_FILES = [
  "/offline.html",
  "/static/images/favicon.svg",
  "/static/images/icon-192.png",
  "/static/images/icon-512.png",
  "/manifest.webmanifest",
  "/static/css/style.css",
  "/static/vendor/fontawesome/css/all.min.css",
  "/static/vendor/fontawesome/webfonts/fa-solid-900.woff2",
  "/static/vendor/fontawesome/webfonts/fa-regular-400.woff2",
  "/static/js/domain/reportFormatter.js",
  "/static/js/domain/receivableData.js",
  "/static/js/core/app.js",
  "/static/js/core/api.js",
  "/static/js/mobile/native-bridge.js",
  "/static/js/mobile/mobile-auth.js",
  "/static/js/ui/navigation.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/") || url.pathname === "/" || url.pathname === "/login") {
    if (event.request.mode === "navigate") {
      event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
    }
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
