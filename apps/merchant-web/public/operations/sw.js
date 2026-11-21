/* global self, caches, fetch, URL, Response */
// Owner 2026-11-03 (operating continuity): a staff page opened while the connection is down shows
// what to do and each table's last bill instead of the browser's error page, also when the network
// is fine but the store system is down (the front page answers 503). Only that: nothing is
// queued or sent later (IDR-0039), and a staff page that can load always comes from the network.
// v5 (b18): a page is never blank. When the offline page is not in the cache (cleared storage, a
// worker that never finished installing) the store system's own answer is shown, and with no
// answer at all a short built-in page says what to do.
// v6 (b25): the offline page says "Wi-Fi" as the app does; a new cache makes tablets fetch it again.
const CACHE = "bop-merchant-offline-v6";
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

// The last resort when nothing else can be shown: plain words in both staff languages, no files.
const BUILT_IN = `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>BOP</title>
<style>body{margin:0;padding:24px;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#171717;background:#fff}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0 0 16px}a{color:#1f63e0}</style>
</head><body><main>
<h1>无法连接门店系统</h1>
<p>请检查网络。恢复后重新加载本页；如果刚才正在操作，重新加载后先核对再继续。</p>
<h1 lang="en">The store system can't be reached</h1>
<p lang="en">Check the connection. When it is back, reload this page; if you were in the middle of something, check it after reloading before doing it again.</p>
<p><a href="">重新加载 · Reload</a></p>
</main></body></html>`;

function builtInOffline() {
  return new Response(BUILT_IN, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// The cached offline page, else what the network said (a 503 page beats a blank one), else the
// built-in page.
function offlinePage(networkAnswer) {
  return caches
    .match(OFFLINE)
    .catch(() => undefined)
    .then((cached) => cached ?? networkAnswer ?? builtInOffline());
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).then(
        (response) => (response.status === 503 ? offlinePage(response) : response),
        () => offlinePage(undefined),
      ),
    );
  } else if (url.origin === self.location.origin && FILES.includes(url.pathname)) {
    // The outage page's own files: the system being down answers these with 503 too.
    event.respondWith(
      fetch(event.request).then(
        (response) =>
          response.ok
            ? response
            : caches
                .match(event.request)
                .catch(() => undefined)
                .then((cached) => cached ?? response),
        () =>
          caches
            .match(event.request)
            .catch(() => undefined)
            .then((cached) => cached ?? Response.error()),
      ),
    );
  }
});
