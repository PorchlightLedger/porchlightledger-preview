/* Porchlight Ledger Debt Planner service worker.
   Cache-first app shell, same-origin only, no network calls to anyone else. All paths are relative to this file,
   so it works under any subfolder. Bump CACHE_VERSION (tools/stamp) when files change. */
var CACHE_VERSION = "51d72e8480";
var CACHE = "pl-ledger-" + CACHE_VERSION;
var SHELL = [
  "./", "index.html", "app.css", "app.js", "payoff.js", "progress.js", "store.js", "plan.js",
  "manifest.webmanifest", "apple-touch-icon.png",
  "icons/favicon.svg", "icons/icon-32.png", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-192.png", "icons/maskable-512.png",
  "fonts/dm-serif-display.woff2", "fonts/source-sans-400.woff2", "fonts/source-sans-600.woff2",
  "fonts/dm-serif-display.woff", "fonts/source-sans-400.woff", "fonts/source-sans-600.woff"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return fetch(new Request(u, { cache: "reload" })).then(function (r) {
        if (!r.ok) throw new Error("Could not cache " + u);
        return c.put(new Request(u), r);
      });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("pl-ledger-") === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch other origins
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      if (req.mode === "navigate") return caches.match("index.html");
      return new Response("", { status: 504, statusText: "Offline" });
    });
  }));
});
