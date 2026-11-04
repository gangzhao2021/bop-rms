/* global self, caches, fetch, URL */
// Owner 2026-11-03 (operating continuity): a staff page opened while the connection is down shows
// what to do and each table's last bill instead of the browser's error page. Only that: nothing is
// queued or sent later (IDR-0039), and a staff page that can load always comes from the network.
const CACHE = "bop-merchant-offline-v1";
const OFFLINE = "/operations/offline.html";
const FILES = [OFFLINE, "/operations/offline.js", "/operations/offline.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
  } else if (url.origin === self.location.origin && FILES.includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
