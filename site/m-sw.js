// Walkie on your phone: service worker (WALKIE-PWA-1). Caches the app shell only (the page, its script, style and
// icons) so the app opens offline and can say the computer is unreachable. It never sees private data: that travels
// over an end-to-end encrypted WebSocket, which a service worker doesn't intercept, and nothing else is cached.
//
// Versioned: bump VERSION with every deploy of the app so the old cache is dropped on activate. Kill switch: deploying
// this file with KILL = true makes every phone that checks for an update (the browser does, bypassing this worker,
// on navigation and at least daily) delete the caches, unregister the worker and reload from the network. After a
// compromised deploy also revoke every phone on the computers (walkie mobile revoke --all) and have people press
// "Reset this phone" at /m/reset (a deliberate button; nothing is cleared on load): docs/SECURITY.md threat 14.
const VERSION = "3";
const KILL = false;
const CACHE = `walkie-m-v${VERSION}`;
const SHELL = ["/m", "/m/app.js", "/m/app.css", "/m/manifest.webmanifest", "/m/icons/icon-192.png", "/m/icons/apple-touch-icon.png", "/assets/favicon.svg"];

self.addEventListener("install", (event) => {
  if (KILL) { event.waitUntil(self.skipWaiting()); return; }
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  if (KILL) {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.matchAll({ type: "window" }))
        .then((clients) => Promise.all(clients.map((c) => c.navigate(c.url)))),
    );
    return;
  }
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("walkie-m-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (KILL) return;
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const shell = url.pathname === "/m" ? "/m" : SHELL.includes(url.pathname) ? url.pathname : null;
  if (!shell) return;
  // Network first (a new release shows up at once), the cached shell when offline.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(shell, copy)); }
      return res;
    }).catch(() => caches.match(shell).then((hit) => hit || Response.error())),
  );
});
