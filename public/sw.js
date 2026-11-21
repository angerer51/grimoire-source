"use strict";
/* Grimoire service worker - minimal, app-shell only.
   Precaches the shared shell (index.html, the shared js/css, manifest,
   icons) so the app opens instantly instead of a blank tab on a slow
   connection. Everything else (other pages, page-local *.page.js) is
   cached at runtime instead of listed here, so this file doesn't have to
   be kept in sync with every new page. Page HTML and every /*.page.js are
   network-first (see isNetworkFirst below) so a page and its script never
   come from two different deploys.

   Never caches /api/** - inventory/price data must always be live. */

// v3: 2026-10-08 restyle - drop every v2 copy of the old app.css.
// v4: #62 - *.page.js went network-first; drop the stale-while-revalidate
// copies (an old customers.page.js next to the new customers.html drew an
// empty list until a second reload).
// v5: #301 - new shared /js/glossary.js (network-first, below).
// v6: #386 - Warehouse Mode's /rf/*.page.js and rf.css joined network-first.
const CACHE_NAME = "grimoire-shell-v6";
const SHELL = [
  "/index.html",
  "/css/app.css",
  "/icons/sprite.svg",
  "/js/core.js",
  "/js/ui.js",
  "/js/priceRuleEngine.js",
  "/js/shipCost.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

/* These three are app logic, not cosmetic assets - a stale copy here means
   running old code against a new server (or a new page against old code),
   not just an outdated icon for a few hours. A real incident (2026-08-27)
   traced back to exactly this: the stale-while-revalidate strategy below
   served an old cached core.js on the very first load after a deploy,
   guaranteed, every time, regardless of the ?v= cache-buster (which this
   worker's cache key deliberately ignores - see the fetch handler). These
   three go network-first instead: try the network, fall back to cache only
   if the network is actually down. */
// app.css + the icon sprite joined these on 2026-10-08: page markup now
// references sprite symbols and restyled classes, so a stale stylesheet or
// sprite next to fresh HTML renders broken icons, not just old colours.
// moversPicks.js joined them with #6: shared rule logic movers.page.js
// destructures at load, so a stale copy next to a fresh page is a mismatch,
// not just old output. Not in SHELL (one page uses it), so the shell's shape
// and CACHE_NAME are unchanged.
// Every page-local /*.page.js joined them with #62: the page HTML is already
// network-first, so serving its script stale-while-revalidate meant the
// first load after a deploy paired new markup with the previous script
// (Customers' old script writing into a list element the new page no longer
// has). Page and script now always come from the same deploy.
// tradeCompose.js joined with #62 too: the shared trade composer three
// pages call into, so a stale copy next to fresh pages is the same mismatch.
// Every shared /js/*.js is listed here; only /js/vendor/* libs aren't.
// tradeRecord.js (#335) is new and not in SHELL, so CACHE_NAME stays.
const NETWORK_FIRST = new Set(["/js/core.js", "/js/ui.js", "/js/priceRuleEngine.js", "/js/shipCost.js", "/js/moversPicks.js",
  "/js/tradeCompose.js", "/js/tradeRecord.js", "/js/glossary.js", "/css/app.css", "/icons/sprite.svg", "/rf/rf.css"]);
const isNetworkFirst = path => NETWORK_FIRST.has(path) || /^\/(?:rf\/)?[^/]+\.page\.js$/.test(path);

/* Warehouse Mode is live-only (owner, 2026-10-31): opened with no signal it says
   so, rather than falling back to the cached Dashboard below. */
const RF_OFFLINE_PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>No signal</title></head>' +
  '<body style="margin:0;padding:32px 20px;background:#0f1011;color:#e6e5e0;font:600 24px/1.3 system-ui,sans-serif">' +
  'No signal.<br>Warehouse Mode needs Wi-Fi.<p><a href="/rf/" style="color:#f26b1d">Try again</a></p></body></html>';

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(SHELL.map(url =>
        fetch(url, { cache: "reload" }).then(res => res.ok && cache.put(url, res)).catch(() => {})
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // always live, never cached

  if (req.mode === "navigate" && url.pathname.startsWith("/rf/")) {
    event.respondWith(fetch(req).catch(() => new Response(RF_OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
    return;
  }

  if (req.mode === "navigate") {
    // HTML: try the network first (freshest), fall back to whatever shell
    // page is cached if the connection drops mid-session.
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then(hit => hit || caches.match("/index.html")))
    );
    return;
  }

  // Static assets (js/css/icons/manifest): serve from cache immediately if
  // present, refresh the cache in the background either way.
  //
  // Real pages never request these bare paths, though - server/lib/http.js
  // rewrites every src=/href= to append a cache-busting ?v=<mtime>, so a
  // page actually asks for e.g. /js/core.js?v=1737... Matching on the full
  // request (the default) meant that never matched the unversioned entries
  // precached above, silently making the precache dead weight for anything
  // but the HTML navigation itself. Keying on pathname alone (dropping the
  // query) keeps exactly one cache entry per asset regardless of which
  // version string requested it, refreshed on every successful fetch.
  const cacheKey = url.origin + url.pathname;

  if (isNetworkFirst(url.pathname)) {
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, res.clone()));
        return res;
      }).catch(() => caches.match(cacheKey))
    );
    return;
  }

  event.respondWith(
    caches.match(cacheKey).then(hit => {
      const network = fetch(req).then(res => {
        if (res.ok) caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
