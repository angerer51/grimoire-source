"use strict";
/* HTTP plumbing: bodies, cookies, responses, static files.
   Deliberately dependency-free - the whole server runs on a stock Node install
   with no `npm install` step, which is the difference between "clone and run"
   and "fight a native build on Windows". */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const MAX_BODY = 64 * 1024 * 1024;      // a big collection is a few MB; 64 is headroom

/* Same escape core.js's client-side esc() uses. The one place server code
   builds HTML from user-submitted text is transactional email (ticket
   notifications - BACKLOG.md #29) - a ticket subject/body is arbitrary text
   from any signed-in user, so it has to be escaped before landing in an
   HTML email the same way it would before landing in the DOM. */
const escapeHtml = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* Same header set on every response, JSON or static file - serveStatic() writes
   its own headers directly rather than going through sendRaw(), so both read
   from here rather than keeping two copies of the policy in sync.
   script-src has no 'unsafe-inline': every page's own logic lives in an
   external .js file for exactly this reason. style-src keeps 'unsafe-inline'
   - inline style="" attributes are pervasive here and low-severity by
   comparison. img-src allows Scryfall's image CDN and TCGplayer's product-
   image CDN (sealed product previews, keyed by tcgplayer_product_id - see
   BACKLOG.md #16/#24), the two external hosts the app actually hotlinks
   images from. */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  // camera=(self): Warehouse Mode scans bin QR labels with the phone camera
  // (#386). Only this origin's own pages; nothing embedded can ask for it.
  "Permissions-Policy": "geolocation=(), camera=(self), microphone=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://cards.scryfall.io https://tcgplayer-cdn.tcgplayer.com data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join("; ")
};

/* Whether this request should be treated as HTTPS - used for the session
   cookie's Secure flag and for HSTS. The server itself only ever speaks plain
   HTTP (see server/index.js - http.createServer, never https.createServer),
   so "secure" always means a reverse proxy in front terminated TLS. Trusting
   the forwarded-proto header is gated behind cfg.trustProxy for the same
   reason clientIp() below only trusts CF-Connecting-IP: an attacker can
   otherwise just send the header themselves. cfg.secureCookie remains as an explicit
   manual override for setups where that detection doesn't apply. */
function isSecureRequest(req, cfg) {
  if (cfg && cfg.secureCookie) return true;
  if (cfg && cfg.trustProxy && String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https") return true;
  return false;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

/* Below this, gzip's own ~20-byte header/footer plus the compression call
   itself isn't worth it - most POST responses ({ok:true}, a single-record
   update) land under this anyway and pass through untouched. */
const GZIP_MIN_BYTES = 1024;

/* Gzips a response body when it's worth it: the client actually advertised
   support (every browser does, via fetch/XHR; a bare curl without
   --compressed does not, and gets the original bytes back exactly as
   before - this never assumes compression, it only offers it), the body
   clears GZIP_MIN_BYTES, nothing already claimed Content-Encoding, and the
   result is actually smaller (near-incompressible bytes - already-gzipped
   data, mostly - occasionally don't shrink; fall back rather than ship a
   bigger body). JSON is exactly the case this earns its keep on: highly
   repetitive key names and structure compress very well, and
   GET /api/collection - the biggest single response in the app, sent in
   full on every page load - is marked Cache-Control: no-store, so it can
   never lean on a 304 the way static assets already do (see serveStatic's
   ETag handling below) - it pays its full transfer cost every single time.
   Centralized here (not in sendJson/sendText individually) so every
   sendRaw-based response gets it automatically, and so the ~90 route
   handlers that call sendJson never had to change at all. */
function compressIfWorthwhile(req, body, headers) {
  const h = headers || {};
  if (!body || !Buffer.isBuffer(body) || body.length < GZIP_MIN_BYTES) return { body, headers: h };
  if (h["Content-Encoding"]) return { body, headers: h };
  const acceptsGzip = /\bgzip\b/i.test((req && req.headers && req.headers["accept-encoding"]) || "");
  if (!acceptsGzip) return { body, headers: h };
  const compressed = zlib.gzipSync(body);
  if (compressed.length >= body.length) return { body, headers: h };
  return {
    body: compressed,
    headers: Object.assign({}, h, {
      "Content-Encoding": "gzip",
      "Content-Length": compressed.length,
      // A shared cache (a CDN, a proxy) must not hand this response's
      // compressed bytes to a client that never said it could handle them.
      "Vary": h.Vary ? h.Vary + ", Accept-Encoding" : "Accept-Encoding"
    })
  };
}

function sendRaw(res, status, headers, body) {
  if (res.headersSent) return;
  const out = compressIfWorthwhile(res.req, body, headers);
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, out.headers));
  if (out.body == null) res.end();
  else res.end(out.body);
}

function sendJson(res, status, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj));
  sendRaw(res, status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  }, headers || {}), body);
}

function sendText(res, status, text, type) {
  const body = Buffer.from(String(text));
  sendRaw(res, status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  }, body);
}

function sendError(res, status, message, extra) {
  sendJson(res, status, Object.assign({ error: message || "Request failed" }, extra || {}));
}

function redirect(res, to) {
  sendRaw(res, 302, { Location: to, "Cache-Control": "no-store", "Content-Length": 0 }, null);
}

/* Shared sort+paginate for an already-filtered list, used by every
   admin-facing search/list route (accounts, tickets, ...) so they can't
   quietly drift into different clamping/sort behavior from each other.
   `list` is sorted in place. `params` is a URLSearchParams (or anything
   with a matching .get()). */
function sortAndPaginate(list, params, opts) {
  const o = opts || {};
  const sort = params.get("sort") || o.defaultSort;
  const dir = params.get("dir") === "asc" ? 1 : -1;
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(params.get("pageSize"), 10) || o.defaultPageSize || 50));
  list.sort((a, b) => {
    const av = a[sort], bv = b[sort];
    if (av == null && bv == null) return 0;
    if (av == null) return 1; if (bv == null) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  });
  const total = list.length;
  const start = (page - 1) * pageSize;
  return { items: list.slice(start, start + pageSize), total, page, pageSize };
}

/* Read a JSON body. Rejects with an .status so callers can pass the code straight
   through instead of turning every malformed body into a 500.
   A gzip Content-Encoding is decompressed before parsing - the autosave PUT
   is the one body big enough for this to matter, and the browser only ever
   sends it when it actually compressed the payload.
   req.bodyBytes is set to the JSON's size once read (after gunzip): the
   autosave keeps some saves in memory and budgets them by it (#187). */
function readJsonBody(req, limit) {
  const cap = limit || MAX_BODY;
  const gzipped = String(req.headers["content-encoding"] || "").toLowerCase() === "gzip";
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (status, msg) => {
      if (done) return;
      done = true;
      const e = new Error(msg);
      e.status = status;
      reject(e);
    };
    const finish = (buf) => {
      req.bodyBytes = buf.length;
      const text = buf.toString("utf8");
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) {
        const err = new Error("Body is not valid JSON");
        err.status = 400;
        reject(err);
      }
    };
    req.on("data", c => {
      if (done) return;
      size += c.length;
      if (size > cap) { fail(413, "Request body too large"); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const buf = Buffer.concat(chunks);
      if (!gzipped) { finish(buf); return; }
      zlib.gunzip(buf, (e, out) => {
        if (e) { const err = new Error("Body is not valid gzip"); err.status = 400; reject(err); return; }
        finish(out);
      });
    });
    req.on("error", e => { if (!done) { done = true; reject(e); } });
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch (e) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function cookieHeader(name, value, opts) {
  const o = opts || {};
  const bits = [name + "=" + encodeURIComponent(value)];
  bits.push("Path=" + (o.path || "/"));
  if (o.maxAge != null) bits.push("Max-Age=" + Math.floor(o.maxAge));
  if (o.expires) bits.push("Expires=" + o.expires.toUTCString());
  bits.push("HttpOnly");
  bits.push("SameSite=" + (o.sameSite || "Lax"));
  if (o.secure) bits.push("Secure");
  return bits.join("; ");
}

/* Cookie sessions plus a same-origin check is enough CSRF protection here: a
   cross-site form post cannot forge an Origin header, and every mutating route
   below goes through this.

   Tightened 2026-09-16 (BACKLOG #77, direct decision): a missing Origin used
   to be let through unconditionally, reasoned as "a non-browser client (curl,
   script)" - real, but also exactly what a browser old enough to omit both
   SameSite-cookie support and Origin on a cross-origin POST (e.g. IE11) would
   look like, so the fallback covered a legacy-browser CSRF path along with the
   legitimate script case, with no way to tell them apart from Origin alone.
   Referer is the fallback instead of an outright refusal: a real same-origin
   browser request still sends *something* identifying its origin (Origin,
   or Referer, or both - a request truly missing both is unusual for any
   browser, old or new), so a personal script only needs to send one of the
   two headers to keep working, not rearchitect around a full token scheme. */
function sameOrigin(req, cfg) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const host = (cfg.trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "";
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === host; } catch (e) { return false; }
  }
  const referer = req.headers.referer;
  if (referer) {
    try { return new URL(referer).host === host; } catch (e) { return false; }
  }
  return false;                                    // neither header present - refuse, don't assume safe
}

/* ---------- Static files ---------- */

/* #253: the page sign-in gate in server/index.js decides by exact string
   (APP_PAGES / PUBLIC_PAGES / ".html"), but the file lookup below is far
   looser: it decodes %XX, and the OS forgives a trailing slash, letter case,
   an 8.3 short name (ADMIN~1.HTM) and an NTFS stream suffix (::$DATA). Every
   one of those let a signed-out visitor fetch an app page's HTML under a
   name the gate didn't recognise. So a page or asset URL must already be in
   its one plain spelling: "/", or "/"-separated names of letters, digits,
   "-", "_" and inner dots. No %-escapes, no empty segment (doubled or
   trailing slash), no leading or trailing dot, no ":", "~", "\" or space.
   Every file under public/ is named this way. The gate and serveStatic()
   both check it, so the name the gate approves is the name that's read. */
const STATIC_SEGMENT_RE = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
function isCanonicalStaticPath(p) {
  if (p === "/") return true;
  if (typeof p !== "string" || p[0] !== "/") return false;
  return p.slice(1).split("/").every(seg => STATIC_SEGMENT_RE.test(seg));
}

/* realpath() of each static root, cached: one lookup per root per process. */
const realRoots = new Map();
async function realRoot(root) {
  if (!realRoots.has(root)) realRoots.set(root, await fsp.realpath(root));
  return realRoots.get(root);
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = path.normalize(decoded).replace(/^([/\\])+/, "");
  const full = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

/* Matches a same-origin script/stylesheet/icon reference - /js/core.js, the
   root-level *.page.js files, /css/app.css, /icons/icon-192.png - but not the
   data: URI the favicon uses. png is here alongside js/css for the same
   reason: Cloudflare was found overriding this server's "no-cache" with its
   own multi-hour default for .png requests too, the exact same way it
   already did for .js/.css (see the block comment on serveHtml below) -
   caught when a just-fixed broken app icon kept showing up broken until the
   URL itself changed. webp joined with #237 (the landing page's cover and
   screenshots), so a re-taken screenshot shows up on the next page load. */
const ASSET_REF_RE = /((?:src|href)=")(\/[^"]+?\.(?:js|css|png|webp))(")/g;

/* manifest.webmanifest's icon "src" values are the one other place an
   unversioned asset URL lives - JSON, not an HTML attribute, so the rewrite
   above can't reach them. Small and hand-written rather than a general JSON
   rewriter, since there's exactly one file and two known fields. */
const MANIFEST_ICON_RE = /("src"\s*:\s*")(\/[^"]+\.png)(")/g;

/* Some intermediate cache (a CDN in front of this server, a corporate proxy,
   the browser itself) may ignore Cache-Control on a .js/.css response and
   hang onto it far longer than intended - happened in practice, with
   Cloudflare overriding this server's own "no-cache" with its own multi-hour
   default for those two extensions specifically. Nothing server-side can
   force a cache that's already decided to ignore the header to reconsider.
   What DOES work regardless: change the URL. Every asset reference inside an
   HTML page gets ?v=<that asset file's own mtime> appended, and the HTML's
   own ETag is derived from every version it embeds - not just the HTML
   file's - so editing ui.js changes login.html's ETag too, without editing
   login.html itself. HTML is already served no-cache and never cached by
   Cloudflare (confirmed: cf-cache-status comes back DYNAMIC for it), so this
   takes effect on the very next ordinary page load, no hard refresh or
   cache-clear needed - a stale intermediate copy of an OLD asset URL just
   stops being requested at all. */
async function serveHtml(req, res, root, full, st, opts) {
  const o = opts || {};
  let raw;
  try { raw = await fsp.readFile(full, "utf8"); }
  catch (e) { sendError(res, 500, "Could not read " + path.basename(full)); return true; }

  const versionParts = [String(Math.floor(st.mtimeMs))];
  const html = raw.replace(ASSET_REF_RE, (m, pre, assetPath, post) => {
    let v = 0;
    try { v = Math.floor(fs.statSync(path.join(root, assetPath.replace(/^\/+/, ""))).mtimeMs); } catch (e) {}
    versionParts.push(assetPath + ":" + v);
    return pre + assetPath + "?v=" + v + post;
  });

  const etag = '"' + crypto.createHash("sha1").update(versionParts.join("|")).digest("hex").slice(0, 20) + '"';
  if (req.headers["if-none-match"] === etag) {
    sendRaw(res, 304, { ETag: etag }, null);
    return true;
  }
  const body = Buffer.from(html, "utf8");
  const headers = Object.assign({}, SECURITY_HEADERS, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    ETag: etag,
    // Must never be cached or a deploy leaves people on the old page - see
    // the block comment above for what that's actually defending against.
    "Cache-Control": "no-cache"
  });
  if (o.headers) Object.assign(headers, o.headers);
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

/* Same reasoning and mechanism as serveHtml's ASSET_REF_RE rewrite, just for
   MANIFEST_ICON_RE inside a JSON file instead of an HTML attribute - see the
   block comment above serveHtml for why this exists at all. */
async function serveManifest(req, res, root, full, st, opts) {
  const o = opts || {};
  let raw;
  try { raw = await fsp.readFile(full, "utf8"); }
  catch (e) { sendError(res, 500, "Could not read " + path.basename(full)); return true; }

  const versionParts = [String(Math.floor(st.mtimeMs))];
  const json = raw.replace(MANIFEST_ICON_RE, (m, pre, assetPath, post) => {
    let v = 0;
    try { v = Math.floor(fs.statSync(path.join(root, assetPath.replace(/^\/+/, ""))).mtimeMs); } catch (e) {}
    versionParts.push(assetPath + ":" + v);
    return pre + assetPath + "?v=" + v + post;
  });

  const etag = '"' + crypto.createHash("sha1").update(versionParts.join("|")).digest("hex").slice(0, 20) + '"';
  if (req.headers["if-none-match"] === etag) {
    sendRaw(res, 304, { ETag: etag }, null);
    return true;
  }
  const body = Buffer.from(json, "utf8");
  const headers = Object.assign({}, SECURITY_HEADERS, {
    "Content-Type": MIME[".webmanifest"],
    "Content-Length": body.length,
    ETag: etag,
    "Cache-Control": "no-cache"
  });
  if (o.headers) Object.assign(headers, o.headers);
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

async function serveStatic(req, res, root, urlPath, opts) {
  const o = opts || {};
  // A spelling the caller's gate may not have recognised: treat as missing.
  if (!isCanonicalStaticPath(urlPath.split("?")[0])) return false;
  const full = safeJoin(root, urlPath);
  if (!full) { sendError(res, 400, "Bad path"); return true; }
  let st;
  try { st = await fsp.stat(full); }
  catch (e) { return false; }
  if (st.isDirectory()) return false;
  // The file on disk must carry exactly the requested name. On Windows (and
  // macOS) /ADMIN.HTML would otherwise open admin.html; realpath() returns
  // the name as stored, so any case difference reads as "not found" (#253).
  try {
    const rel = path.relative(await realRoot(root), await fsp.realpath(full));
    if (rel !== path.relative(path.resolve(root), full)) return false;
  } catch (e) { return false; }

  const ext = path.extname(full).toLowerCase();
  if (ext === ".html") return serveHtml(req, res, root, full, st, o);
  if (ext === ".webmanifest") return serveManifest(req, res, root, full, st, o);

  // ?v=<mtime> on a .js/.css request is only ever a cache key, generated by
  // serveHtml above and matching this exact file's own mtime already - safe
  // to ignore for the purposes of finding the file on disk.
  const etag = '"' + st.size.toString(16) + "-" + Math.floor(st.mtimeMs).toString(16) + '"';
  if (req.headers["if-none-match"] === etag) {
    sendRaw(res, 304, { ETag: etag }, null);
    return true;
  }
  const headers = Object.assign({}, SECURITY_HEADERS, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": st.size,
    ETag: etag,
    // sw.js specifically gets no-store, not the generic no-cache every other
    // static file gets - it's fetched directly by the browser
    // (navigator.serviceWorker.register), never referenced by an HTML <script
    // src=...> tag, so it can never pick up the ?v=<mtime> cache-busting
    // serveHtml's ASSET_REF_RE gives every other .js file (BACKLOG.md #52).
    // no-store means "don't even consider a cached copy, ever" - stronger
    // than no-cache's "revalidate first" - the best this server can promise
    // on its own; whether Cloudflare's edge (which has overridden this
    // server's Cache-Control for .js files before - see serveHtml's own
    // comment above) actually honors it needs a live check past Cloudflare,
    // not something confirmable from here.
    "Cache-Control": urlPath === "/sw.js" ? "no-store" : "no-cache"
  });
  if (o.headers) Object.assign(headers, o.headers);
  res.writeHead(200, headers);
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(full);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  }).catch(() => { try { res.destroy(); } catch (e) {} });
  return true;
}

function randomId(bytes) {
  return crypto.randomBytes(bytes || 24).toString("base64url");
}

/* The real client address.
   Behind a reverse proxy or a Cloudflare Tunnel every connection arrives from
   127.0.0.1, so socket.remoteAddress is the same for the whole internet and any
   per-IP limit built on it would lock out everybody at once. trustProxy is only
   ever documented/set up for the Cloudflare Tunnel deployment (README "tell
   Grimoire it is behind a proxy") - CF-Connecting-IP is the one header
   Cloudflare's edge sets itself and a client can't override by sending it.
   X-Forwarded-For/X-Real-IP do NOT have that guarantee: Cloudflare only
   *appends* to an existing X-Forwarded-For rather than replacing it, and never
   sets X-Real-IP at all, so a client that sends either directly stays in full
   control of it end to end - trusting them here let an attacker spoof their way
   past the login/registration brute-force lockout. Only CF-Connecting-IP is
   trusted; anything else falls back to the (possibly-shared) socket address
   rather than an easily-forged header. */
function clientIp(req, cfg) {
  if (cfg && cfg.trustProxy) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
  }
  const addr = (req.socket && req.socket.remoteAddress) || "";
  return String(addr).replace(/^::ffff:/, "");
}

module.exports = {
  MAX_BODY, MIME, SECURITY_HEADERS,
  sendRaw, sendJson, sendText, sendError, redirect,
  readJsonBody, parseCookies, cookieHeader, sameOrigin,
  serveStatic, safeJoin, isCanonicalStaticPath, randomId, clientIp, isSecureRequest, sortAndPaginate, escapeHtml
};
