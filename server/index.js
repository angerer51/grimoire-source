"use strict";
/* Grimoire v0.08 server.
   ---------------------
   Zero dependencies on purpose - `node server/index.js` and it runs.

   What it does:
     * serves the multi-page app out of public/
     * accounts, sessions, invites
     * one collection document per user, autosaved from the browser, with the
       last 30 revisions kept server-side
     * the card database: one daily Scryfall bulk download shared by everybody
     * a nightly price snapshot, which is what makes price history possible
     * Manapool and Pitney Bowes proxies, both off until configured

   Run `node server/index.js --help` for the command-line jobs. */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const readline = require("readline");

const httpu = require("./lib/http");
const store = require("./lib/store");
const auth = require("./lib/auth");
const cards = require("./lib/cards");
const sealed = require("./lib/sealed");
const mtgjson = require("./lib/mtgjson");
const orgs = require("./lib/orgs");
const prices = require("./lib/prices");
const mpSales = require("./lib/mpSales");
const auditStore = require("./lib/audit");
const integrations = require("./lib/integrations");
const mpAuth = require("./lib/mpAuth");
const priceRules = require("./lib/priceRules");
const mailer = require("./lib/mailer");
const digest = require("./lib/digest");
const github = require("./lib/github");
const trades = require("./lib/trades");
const sharing = require("./lib/sharing");
const friends = require("./lib/friends");
const actFrom = require("./lib/actFrom");
const pickInvite = require("./lib/pickInvite");
const orderEntryListing = require("./lib/orderEntryListing");
const kioskLib = require("./lib/kiosk");
const inviteRequests = require("./lib/inviteRequests");
const signupGuard = require("./lib/signupGuard");
const orderLabels = require("./lib/orderLabels");
const orderFees = require("./lib/orderFees");
const shipCostBackfill = require("./lib/shipCostBackfill");
const orderShip = require("./lib/orderShip");
const notifications = require("./lib/notifications");
const notifyEvents = require("./lib/notifyEvents");
const notifyJob = require("./lib/notifyJob");
const mpShipAnnounce = require("./lib/mpShipAnnounce");
const meta = require("./lib/meta");
const supervisor = require("./lib/supervisor");
const resetMailLib = require("./lib/resetMail");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
// Date-based, not semver: vYYYY.MM.DD-NN, NN a same-day release counter
// (reset to 01 each new day) rather than a stability/compatibility signal -
// this app has one operator making whatever changes are needed on their own
// schedule, so semver's "breaking change = major bump" promise doesn't
// really apply. Bump this by hand on every deploy; the nav badge (ui.js)
// and package.json both read/mirror this rather than hardcoding their own.
const VERSION = "2026.11.24-01";

/* ============================== Config ============================== */
const DEFAULTS = {
  port: 8787,
  host: "0.0.0.0",
  baseUrl: "",
  dataDir: "",
  registration: "invite",           // open | invite | closed
  // Open sign-up's guard (#506, server/lib/signupGuard.js): new accounts per
  // client address, and across the whole site, in any 24 hours. Only a
  // sign-up without an invite code is held to them; null turns one off.
  signup: { perIpPerDay: 3, dailyCap: 200 },
  sessionDays: 30,                  // password again at least this often (absolute, from sign-in)
  sessionIdleDays: 7,               // signed out after this many days without a request (#268)
  secureCookie: false,
  trustProxy: false,
  contactEmail: "",
  cards: { bulkType: "default_cards", refreshHourLocal: 4, liveFallback: true, requestsPerSecond: 8, keepOracleText: true },
  // mpSales* (#202, server/lib/mpSales.js): Manapool's public catalog is
  // regenerated ~21:10 UTC, so the daily sales pull waits until 18:00 local
  // (Eastern). TopupHours/TopupMax: re-poll at most that many fast, capped
  // printings that often, only with an admin's Manapool login; null = off.
  prices: { snapshotHourLocal: 5, keepDays: 400, mpSalesHourLocal: 18, mpSalesKeepDays: 90, mpSalesTopupHours: 4, mpSalesTopupMax: 300 },
  manapool: { enabled: false },
  pitneyBowes: { enabled: false },
  // Support tickets <-> GitHub issues (#40): minutes between checks of
  // linked issues; null/"off" stops the check. The repo and token are set
  // in Admin > GitHub (github.json in the data dir), not here.
  github: { syncMinutes: 15 }
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else out[k] = v;
  }
  return out;
}

function loadConfig() {
  const file = process.env.GRIMOIRE_CONFIG || path.join(ROOT, "config.json");
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
    log("config: " + file);
  } catch (e) {
    if (e.code === "ENOENT") log("config: none found at " + file + " - using defaults (copy config.example.json to config.json to change them)");
    else { console.error("config: " + file + " could not be read - " + e.message); process.exit(1); }
  }
  const cfg = deepMerge(DEFAULTS, raw);
  // Environment wins, so a service unit or container can override without editing a file.
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.GRIMOIRE_HOST) cfg.host = process.env.GRIMOIRE_HOST;
  if (process.env.GRIMOIRE_DATA_DIR) cfg.dataDir = process.env.GRIMOIRE_DATA_DIR;
  if (process.env.GRIMOIRE_REGISTRATION) cfg.registration = process.env.GRIMOIRE_REGISTRATION;
  return cfg;
}

/* Every other setting in config.json (manapool.enabled, pitneyBowes.enabled,
   ...) is deliberately file-edit-plus-restart only, with no live-toggle
   route anywhere in this app - see the "An administrator needs to set X in
   config.json, then restart" errors in integrations.js. cards.priceSource is
   the first exception: unlike those, cards.js already reads cfg.cards.
   priceSource fresh on every applyPriceSource() call rather than only at
   boot, so a live flip needs no restart to take effect - only a way to
   persist it so the choice survives one. Written by patching the on-disk
   file directly (read -> set one nested key -> write) rather than
   round-tripping the whole in-memory CFG back out, so an operator's own
   manual edits to any other part of config.json between restarts are never
   clobbered by this. */
async function writeConfigPriceSource(value) {
  const file = process.env.GRIMOIRE_CONFIG || path.join(ROOT, "config.json");
  let raw = {};
  try { raw = JSON.parse(await fsp.readFile(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  raw.cards = Object.assign({}, raw.cards, { priceSource: value });
  await fsp.writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
// BACKLOG.md #58: the visible "Grimoire Server" console window is a
// deliberate convention (CLAUDE.md) - this ADDS a file alongside it, never
// replaces the console output. Lives in dataDir (server.log), not the
// project folder - same "churn goes outside the repo" reasoning store.js's
// own header already gives for dataDir living outside the project in the
// first place. One previous rotation kept (server.log.1), same "cap it"
// simplicity as this app's other bounded caches - a real operator reads
// this after something just went wrong, not as a long-term archive.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
function appendLogFile(line) {
  let file;
  try { file = store.p("server.log"); }
  catch (e) { return; } // store.init() hasn't run yet - console-only until it has
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > LOG_MAX_BYTES) fs.renameSync(file, file + ".1");
    fs.appendFileSync(file, line + "\n");
  } catch (e) { /* best-effort - logging must never be why the server goes down */ }
}
function log(msg) {
  const line = stamp() + "  " + msg;
  console.log(line);
  appendLogFile(line);
}
const tagLog = tag => msg => log("[" + tag + "] " + msg);

/* ============================== Routing ============================== */
const routes = [];
function route(method, pattern, handler, opts) {
  // "/api/cards/:name" -> a regex plus the parameter names it captures.
  const names = [];
  const rx = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/:([A-Za-z_]+)/g, (m, n) => { names.push(n); return "/([^/]+)"; }) + "$");
  routes.push(Object.assign({ method, rx, names, handler }, opts || {}));
}

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.rx);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { r, params };
  }
  return null;
}

/* Pages that need a session. Everything under public/ is listed here rather than
   guessed, so adding a page cannot accidentally publish it. */
const PUBLIC_PAGES = new Set(["/welcome.html", "/login.html", "/business.html", "/favicon.ico", "/robots.txt"]);
/* #237: a signed-out visit to the site's front door shows the public landing
   page instead of the sign-in form. Only these two paths: a deep link to any
   other app page still goes to sign-in with ?next= so it lands back there. */
const LANDING_PATHS = new Set(["/", "/index.html"]);
const APP_PAGES = new Set([
  "/", "/index.html", "/help.html", "/receive.html", "/receive-sealed.html", "/inventory.html", "/sealed.html", "/locations.html",
  "/putaway.html", "/cycle-count.html", "/listings.html", "/movers.html", "/stats.html", "/lists.html", "/deck-list.html", "/audit-log.html", "/settings.html",
  "/inventory/bulk-price", "/admin.html", "/social.html", "/tutorial.html", "/buy-list.html", "/org.html", "/returns.html",
  "/accounting.html", "/trades.html", "/customers.html", "/walk-in.html", "/kiosk-setup.html", "/rf/", "/rf/index.html"
]);
/* The kiosk's own screen (#433): only a kiosk session opens it, and it's the
   only page a kiosk session opens (see handle()). */
const KIOSK_PAGES = new Set(["/kiosk.html"]);
const KIOSK_REFUSED = "That isn't available on the store's kiosk.";
/* Nested URL the rest of the app doesn't otherwise have - everything else is a
   flat file served straight off its own name. bulk-price.html is reachable
   ONLY through this alias (the .html path itself isn't in APP_PAGES, so the
   404 check below still catches a direct request for it). */
const PAGE_ALIASES = { "/inventory/bulk-price": "/bulk-price.html" };

/* ============================== Server ============================== */
let CFG = null;

/* ============================== Restart notice ==============================
   No cross-platform IPC/signal exists here (this runs on Windows too), so a
   pending restart is coordinated through a small file (store.js's
   restart.json) that both the admin API route and the `--restart-in` CLI
   one-shot write to. PENDING_RESTART is just an in-memory mirror of that file
   so GET /api/meta - already polled by every page - can report it without a
   disk read on every request. */
let PENDING_RESTART = null;
let restartWatchTimer = null;

async function checkRestartRequest(server) {
  const req = await store.readRestartRequest().catch(() => null);
  PENDING_RESTART = req;
  if (!req || Date.now() < Number(req.at)) return;

  log("[restart] countdown elapsed - restarting now" + (req.reason ? " (" + req.reason + ")" : ""));
  clearInterval(restartWatchTimer);
  // Clear the request BEFORE respawning, or the new process would see the
  // same past-due request on its very first check and loop forever.
  await store.clearRestartRequest().catch(() => {});
  cards.flushLive();
  // Release the SQLite handle before spawning a replacement that will try
  // to open the exact same file - see prices.js's closeDb() for the real
  // incident (a WAL-mode database, unlike the old flat-JSON archive, stays
  // open for this whole process's life; two processes touching it at once
  // failed outright on Windows the first time this was actually hit).
  // mpSales keeps its tables in that same file; stop() just aborts an
  // in-flight catalog download so it doesn't write after the close.
  mpSales.stop();
  prices.closeDb();
  // #503: under systemd nobody else is left to save "last active" (bye()
  // does this on a stop), and the exit below follows right after.
  const plan = supervisor.restartPlan(process.env);
  if (plan.mode === "exit") await auth.flushPresence().catch(() => {});

  // Close THIS process's server and actually wait for the port to be
  // released before spawning the replacement. The old order (spawn, then
  // close(), then exit 500ms later with nobody waiting on any of it) let the
  // child try to bind the same port while this process still held it -
  // confirmed twice in production to lose that race on Windows and leave
  // nobody listening at all for a couple of minutes. Bounded to 4s (same
  // fallback shape as the SIGINT/SIGTERM handler below) in case a lingering
  // keep-alive connection would otherwise stall close() indefinitely -
  // listenWithRetry() on the child's side is the remaining safety net for
  // whatever residual delay a forced move-on after that timeout leaves.
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (server) server.close(finish); else finish();
    setTimeout(finish, 4000).unref();
  });

  // #503: a supervisor (systemd) starts the new process itself. A spawned
  // child would sit in the same cgroup and be killed along with us.
  if (plan.mode === "exit") {
    log("[restart] exiting with code " + plan.code + " for " + plan.supervisor + " to start the new process");
    process.exit(plan.code);
  }

  // Was stdio: "inherit" so an admin watching a real console window
  // wouldn't go dark on self-restart - but that's the actual root cause of
  // two real production outages (2026-09-01, 2026-09-05): the child shared
  // the parent's console handle, and Windows tearing that console down as
  // part of the parent's own exit can deliver CTRL_CLOSE_EVENT to every
  // process still attached to it, including the just-spawned child, before
  // it finishes starting up. Redirect to server.log instead (#58) - stdout
  // is "ignore" since log() already appends every line there itself (this
  // would otherwise double-write), stderr goes to the same file so a
  // crash-on-boot message that bypasses log() (main()'s own top-level
  // catch) still lands somewhere. No shared console handle at all now, so
  // this specific failure mode cannot recur. Tradeoff, stated plainly: a
  // console window from the original launch stops receiving new output
  // after a self-restart - tail dataDir/server.log instead, same file
  // CLAUDE.md's own manual-recovery instructions already point at.
  let restartStdio = "ignore";
  try { restartStdio = ["ignore", "ignore", fs.openSync(store.p("server.log"), "a")]; } catch (e) {}
  const child = require("child_process").spawn(process.execPath, process.argv.slice(1), {
    detached: true, stdio: restartStdio, cwd: process.cwd(), env: process.env
  });
  child.unref();
  process.exit(0);
}

/* A one-off digest run asked for by `--send-digest` (see cliSendDigest()).
   Cleared BEFORE sending, so a crash or restart mid-run can never re-send
   the batch - a missed send is recoverable, a doubled one isn't. */
let digestRequestRunning = false;
async function checkDigestRequest() {
  // Card prices feed the collection value and movers - wait out boot.
  if (digestRequestRunning || !cards.ready) return;
  const req = await store.readDigestRequest().catch(() => null);
  if (!req) return;
  digestRequestRunning = true;
  try {
    await store.clearDigestRequest();
    log("[digest] one-off run requested for " + req.date + (req.force ? " (every subscriber, even quiet days)" : ""));
    await digest.runDaily({ date: req.date, bcc: req.bcc || undefined, force: !!req.force });
  } catch (e) { log("[digest] one-off run failed: " + (e.message || e)); }
  finally { digestRequestRunning = false; }
}

/* Defense in depth alongside checkRestartRequest()'s close-before-spawn fix
   above: if .listen() is ever attempted while something else (most likely a
   predecessor process mid-exit) still holds the port, retry with a short
   backoff instead of crashing outright. A handful of retries comfortably
   covers any residual OS-level delay after the old process has exited. */
function listenWithRetry(server, port, host, onListening, attemptsLeft) {
  const attempts = attemptsLeft == null ? 10 : attemptsLeft;
  const onError = err => {
    if (err.code === "EADDRINUSE" && attempts > 0) {
      log("port " + port + " still in use, retrying in 500ms... (" + attempts + " attempt(s) left)");
      setTimeout(() => listenWithRetry(server, port, host, onListening, attempts - 1), 500);
    } else {
      log("FATAL: could not bind " + host + ":" + port + " - " + err.message);
      process.exit(1);
    }
  };
  server.once("error", onError);
  server.listen(port, host, () => {
    server.removeListener("error", onError);
    onListening();
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = url.pathname;
  const method = (req.method || "GET").toUpperCase();

  // One deliberate exemption: the daily digest's one-click unsubscribe
  // (RFC 8058). Gmail/Outlook POST to it from their own servers with no
  // Origin or Referer, which sameOrigin() rightly refuses everywhere else.
  // Safe here and only here: that route takes its authority from the signed
  // per-account token in its own URL (digest.verifyToken), never from the
  // session cookie - and a cookie riding along is exactly what CSRF abuses.
  const oneClickUnsub = method === "POST" && pathname === "/api/digest/unsubscribe";
  if (!oneClickUnsub && !httpu.sameOrigin(req, CFG)) {
    httpu.sendError(res, 403, "Cross-origin request refused.");
    return;
  }

  // Set once per request, before any handler calls res.writeHead(): Node
  // merges headers set via res.setHeader() with the ones passed to
  // writeHead() (see server/lib/http.js's SECURITY_HEADERS comment), so this
  // reaches every response path (API, pages, static assets) without having
  // to thread req/cfg through every sendJson/sendRaw/serveStatic call site.
  // Only sent once isSecureRequest() confirms the connection is actually
  // HTTPS-terminated - telling a browser to force HTTPS on a plain-HTTP-only
  // deployment would just make the app unreachable on its next visit.
  if (httpu.isSecureRequest(req, CFG)) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }

  // A kiosk session (#433, server/lib/kiosk.js), re-checked on every request
  // that carries its cookie. Deny by default: it reaches only the routes
  // marked { kiosk: true } and the kiosk's own page, whatever else the
  // device's cookies say, so a route added later is closed to it unless
  // opened on purpose (test/kiosk.routes.test.js walks the route table).
  const kiosk = kioskLib.hasCookie(req) ? await kioskLib.sessionFromRequest(req) : null;

  // --- API ---
  if (pathname.startsWith("/api/")) {
    const hit = match(method, pathname);
    if (!hit) { httpu.sendError(res, 404, "No such endpoint: " + method + " " + pathname); return; }
    let user = null;
    let docOwner = null;
    if (kiosk || hit.r.kiosk) {
      if (!kiosk) { httpu.sendError(res, 401, "This screen isn't in kiosk mode."); return; }
      // kiosk: true tells a desk page still open on this device (another tab,
      // or a page back from the browser's history) to leave for the kiosk
      // screen at once (core.js api(), leaveForKiosk) instead of showing an error.
      if (!hit.r.kiosk) { httpu.sendJson(res, 403, { error: KIOSK_REFUSED, kiosk: true }); return; }
      docOwner = kiosk.ownerKey;
    } else if (!hit.r.open) {
      user = await auth.userFromRequest(req, CFG);
      if (!user) { httpu.sendError(res, 401, "Sign in first."); return; }
      if (hit.r.admin && user.role !== "admin") { httpu.sendError(res, 403, "Administrators only."); return; }
      if (hit.r.role && (auth.ROLE_RANK[user.role] || 0) < auth.ROLE_RANK[hit.r.role]) {
        httpu.sendError(res, 403, "You don't have permission to do that."); return;
      }
      if (hit.r.orgRole && !auth.hasOrgRole(user, hit.r.orgRole)) {
        httpu.sendError(res, 403, "You don't have permission to do that."); return;
      }
      auth.touchPresence(user.__sid, user.id);
      // The one chokepoint every collection-scoped route resolves its
      // storage key through, instead of user.id directly (BACKLOG.md #9) -
      // a personal account's own id, unchanged, or the Store its session is
      // currently acting on behalf of. Re-resolved on every request (not
      // cached on the session) so a role/store-assignment change taking
      // effect doesn't need a fresh login. null for an org member with no
      // store assigned yet - individual routes decide how to react to that
      // (see the collection routes below).
      docOwner = await orgs.resolveDocOwner(user);
    }
    try {
      await hit.r.handler({ req, res, url, params: hit.params, user, docOwner, kiosk });
    } catch (e) {
      // A deliberate application error (a bad password, a stale revision, a
      // config problem) always sets .status itself with a message that's
      // already meant to be shown - see auth.js/store.js/mailer.js etc. An
      // error with NO .status is an unexpected bug (a TypeError, a null
      // deref), and its raw .message can echo internal detail (a variable
      // name, a file path) that has no business reaching the client - full
      // detail still goes to the server log either way, just not the
      // response body.
      const hasStatus = typeof e.status === "number";
      const status = hasStatus ? e.status : 500;
      if (status >= 500) log("ERROR " + method + " " + pathname + " - " + (e.stack || e.message));
      httpu.sendError(res, status, hasStatus ? (e.message || "Server error") : "Server error");
    }
    return;
  }

  // --- Pages & assets ---
  if (method !== "GET" && method !== "HEAD") { httpu.sendError(res, 405, "Method not allowed"); return; }
  // Only the plain spelling of a page or asset gets past here (#253), so the
  // exact-match gate below sees the same name serveStatic() will open.
  // Warehouse Mode (#386) is its own installed app, scoped to the /rf/ folder.
  if (pathname === "/rf") { httpu.redirect(res, "/rf/"); return; }
  if (pathname !== "/rf/" && !httpu.isCanonicalStaticPath(pathname)) { httpu.sendError(res, 404, "Not found"); return; }

  // A kiosk sees its own screen and nothing else: every other page, signed
  // in or public, goes back to it. Scripts, styles and icons are served as
  // to anyone signed out; they hold no account data.
  const isKioskPage = KIOSK_PAGES.has(pathname);
  if (kiosk && !isKioskPage && (APP_PAGES.has(pathname) || pathname.endsWith(".html"))) { httpu.redirect(res, "/kiosk.html"); return; }
  if (isKioskPage && !kiosk) { httpu.redirect(res, "/login.html"); return; }

  const isAppPage = APP_PAGES.has(pathname);
  if (isAppPage) {
    const user = await auth.userFromRequest(req, CFG);
    if (!user) {
      httpu.redirect(res, LANDING_PATHS.has(pathname) ? "/welcome.html" : "/login.html?next=" + encodeURIComponent(pathname + url.search));
      return;
    }
  }
  if (pathname.endsWith(".html") && !isAppPage && !isKioskPage && !PUBLIC_PAGES.has(pathname)) {
    httpu.sendError(res, 404, "Not found");
    return;
  }

  const target = (pathname === "/") ? "/index.html" : (pathname === "/rf/") ? "/rf/index.html" : (PAGE_ALIASES[pathname] || pathname);
  const served = await httpu.serveStatic(req, res, PUBLIC, target);
  if (!served) {
    if (pathname === "/favicon.ico") { httpu.sendRaw(res, 204, { "Content-Length": 0 }, null); return; }
    httpu.sendText(res, 404, "Not found: " + pathname);
  }
}

/* ============================== Brute-force throttle ==============================
   The login page is reachable by anyone who can reach the site, so it needs a
   limit. In memory on purpose: this is one process, and losing the counters on
   restart is a fair trade for not adding a store. Counted per client IP AND per
   username, so one attacker cannot lock a victim out by guessing at their name
   from a thousand addresses, and cannot spread an attack over a thousand names
   from one address either. */
const FAIL_MAX = 8;                    // failures before the door closes
const FAIL_WINDOW = 15 * 60 * 1000;    // ...within this long
const FAIL_LOCK = 15 * 60 * 1000;      // ...and it stays closed this long
const failures = new Map();            // key -> {count, first, until}

function failState(key) {
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec) return null;
  if (rec.until && rec.until > now) return rec;
  // Window elapsed with no lock: forget it.
  if (now - rec.first > FAIL_WINDOW) { failures.delete(key); return null; }
  return rec;
}

function lockedFor(keys) {
  let worst = 0;
  for (const k of keys) {
    const rec = failState(k);
    if (rec && rec.until && rec.until > Date.now()) worst = Math.max(worst, rec.until);
  }
  return worst ? Math.ceil((worst - Date.now()) / 1000) : 0;
}

function noteFailure(keys) {
  const now = Date.now();
  for (const k of keys) {
    let rec = failState(k);
    if (!rec) { rec = { count: 0, first: now, until: 0 }; failures.set(k, rec); }
    rec.count++;
    if (rec.count >= FAIL_MAX) { rec.until = now + FAIL_LOCK; rec.count = 0; rec.first = now; }
  }
  // Opportunistic sweep so the map cannot grow without bound.
  if (failures.size > 5000) {
    for (const [k, v] of failures) {
      if ((!v.until || v.until < now) && now - v.first > FAIL_WINDOW) failures.delete(k);
    }
  }
}

function clearFailures(keys) { for (const k of keys) failures.delete(k); }

/* ============================== Auth routes ============================== */
/* Whether any account exists at all, so the sign-in page can offer to create
   the administrator instead of asking for a password nobody has set yet.
   #160: every open tab polls /api/meta every 5s, and this used to parse
   users.json each time. Accounts are never deleted, so once one exists the
   answer stays false and the file isn't read for it again; until then
   users.json is empty and cheap to check. */
let FIRST_RUN = true;
async function isFirstRun() {
  if (FIRST_RUN) FIRST_RUN = (await auth.listUsers()).length === 0;
  return FIRST_RUN;
}

route("GET", "/api/meta", async ({ req, res }) => {
  const mem = process.memoryUsage();
  // #161: signed out, only what the sign-in page and the restart banner
  // need (server/lib/meta.js). No cookie means no session read at all.
  const signedIn = !!(await auth.userFromRequest(req, CFG));
  httpu.sendJson(res, 200, meta.forViewer({
    app: "Grimoire", version: VERSION,
    registration: CFG.registration,
    firstRun: await isFirstRun(),
    manapool: integrations.manapoolEnabled(),
    shipping: integrations.shippingEnabled(),
    restart: PENDING_RESTART,
    // BACKLOG.md #61: this doubles as the app's /health endpoint - already
    // what every page polls and what CLAUDE.md's own restart-verification
    // curl check uses, so a process alive long enough to answer with a
    // believable uptime/memory reading is itself most of a health check.
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) }
  }, signedIn));
}, { open: true });

route("GET", "/api/auth/me", async ({ req, res }) => {
  const user = await auth.userFromRequest(req, CFG);
  if (!user) { httpu.sendJson(res, 200, { user: null }); return; }
  httpu.sendJson(res, 200, {
    // publicUser() deliberately omits email everywhere else (nobody else's
    // business - see the friends/sharing comment above) - this is the one
    // place it's safe to include it, since it's always the caller's own.
    user: Object.assign(auth.publicUser(user), { email: user.email || "" }),
    admin: user.role === "admin",
    // Org members' own Simple mode/chime (#159), from their own prefs.json;
    // a personal account keeps them in its collection document, so null.
    personalPrefs: user.orgId ? ((await store.readPrefs(user.id)).uiPrefs || {}) : null,
    // #499: the desk-wide "Reconnect Mana Pool" banner, or null. Never a token.
    mpBanner: integrations.manapoolEnabled() ? mpAuth.banner(await store.readPrefs(user.id)) : null,
    cards: cards.status()
  });
}, { open: true });

/* Saves the caller's own Simple mode / chime (#159). For an org member these
   used to live in the Store's document, so one person's Simple mode hid the
   advanced pages for every coworker. onlyIfUnset: core.js's one-time seed
   from the Store's old value, which must not overwrite a value the person
   already chose (another tab may have got there first). */
route("POST", "/api/prefs/personal", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const incoming = orgs.personalPrefsFrom(body);
  const prefs = await store.updatePrefs(user.id, p => {
    const cur = p.uiPrefs && typeof p.uiPrefs === "object" ? p.uiPrefs : {};
    for (const [k, v] of Object.entries(incoming)) {
      if (body.onlyIfUnset === true && cur[k] !== undefined) continue;
      // #455: finished "What's new" tutorials only ever add up, so a tab that
      // loaded before another tab finished one can't drop it.
      cur[k] = k === "whatsNewDone" ? orgs.whatsNewClean([].concat(cur[k] || [], v)) : v;
    }
    p.uiPrefs = cur;
  });
  httpu.sendJson(res, 200, { personalPrefs: prefs.uiPrefs });
});

route("POST", "/api/auth/login", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 8192);
  const ip = httpu.clientIp(req, CFG);
  const uname = String(body.username || "").toLowerCase().trim();
  const keys = ["ip:" + ip, "user:" + uname];

  const wait = lockedFor(keys);
  if (wait) {
    // Quoted and capped (#161): uname is whatever was typed, line breaks
    // included, and must not be able to forge lines in server.log.
    log("login throttled: " + auth.logName(uname) + " from " + ip + " (" + wait + "s left)");
    httpu.sendJson(res, 429, {
      error: "Too many failed sign-ins. Try again in " + Math.ceil(wait / 60) + " minute(s)."
    }, { "Retry-After": String(wait) });
    return;
  }

  const user = await auth.findUser(uname);
  const ok = user && !user.disabled && auth.verifyPassword(body.password, user.pwd);
  if (!ok) {
    // Same message and roughly the same cost either way - a wrong username must
    // not be distinguishable from a wrong password.
    if (!user) auth.verifyPassword(body.password || "x", auth.hashPassword("decoy-value-1"));
    noteFailure(keys);
    await new Promise(r => setTimeout(r, 250));
    httpu.sendError(res, 401, "Wrong username or password.");
    return;
  }
  // Two-factor (BACKLOG #51): a right password alone gets "now the code",
  // never a session. The client re-sends username+password WITH the code -
  // stateless, nothing half-signed-in held server-side. A wrong code counts
  // toward the same lockout as a wrong password, so 6 digits can't be
  // brute-forced through here.
  let recovery = null;
  if (auth.hasTwoFactor(user)) {
    if (!String(body.code || "").trim()) { httpu.sendJson(res, 200, { needs2fa: true }); return; }
    const r = await auth.checkSecondFactor(user.id, body.code);
    if (!r.ok) {
      noteFailure(keys);
      await new Promise(r2 => setTimeout(r2, 250));
      httpu.sendError(res, 401, "That code didn't work. Use the newest code from your authenticator app, or a recovery code.");
      return;
    }
    if (r.recoveryUsed) {
      recovery = { used: true, left: r.recoveryLeft };
      log("login used a 2FA recovery code: " + user.username + " (" + r.recoveryLeft + " left)");
    }
  }
  clearFailures(keys);
  const { sid, days } = await auth.createSession(user.id, CFG, req);
  await store.ensureUserDir(user.id);
  httpu.sendJson(res, 200, { user: auth.publicUser(user), recovery },
    { "Set-Cookie": auth.sessionCookie(sid, CFG, days, req) });
  log("login: " + user.username + " from " + ip + (auth.hasTwoFactor(user) ? " (2FA)" : ""));
}, { open: true });

route("POST", "/api/auth/logout", async ({ req, res }) => {
  const sid = httpu.parseCookies(req)[auth.COOKIE];
  await auth.destroySession(sid);
  httpu.sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie(CFG, req) });
}, { open: true });

/* Open sign-up's guard (#506): see server/lib/signupGuard.js. Made on first
   use, once CFG is loaded. */
let openSignupGuardState = null;
const openSignupGuard = () => openSignupGuardState || (openSignupGuardState = signupGuard.createGuard(CFG.signup));

/* A sign-up in open mode without an invite code. Resolves true with one of
   this address's sign-ups reserved (release it if the account isn't made),
   or false once it has answered the request itself. A filled-in honeypot
   gets the same 200 a bot would expect and nothing is created. Honeypot
   hits and refusals for this address count against the sign-in throttle
   under their own "signup:" key (not the invite code's "reg:"), so
   a script that keeps trying is locked out for a while; the site-wide cap
   doesn't, since tripping it isn't this visitor's doing. */
function logCapTripped() {
  const guard = openSignupGuard();
  if (!guard.shouldLogCap()) return;
  log("sign-up refused: the daily cap (" + guard.cap + " new accounts in 24 hours) is reached." +
    " Open sign-ups wait until it clears; invite codes still work. signup.dailyCap in config.json sets it.");
}
// createUser's opts.refuseIf for an open sign-up: the cap, on the current list.
function openSignupRefuseIf(db) {
  const why = openSignupGuard().capRefusal(db.users);
  if (why) logCapTripped();
  return why;
}

async function guardOpenSignup(res, body, ip, users) {
  // An IPv6 visitor is counted by its /64 (signupGuard.addressKey).
  const keys = ["signup:" + signupGuard.addressKey(ip)];
  const wait = lockedFor(keys);
  if (wait) {
    httpu.sendJson(res, 429, {
      error: "Too many attempts. Try again in " + Math.ceil(wait / 60) + " minute(s)."
    }, { "Retry-After": String(wait) });
    return false;
  }
  if (signupGuard.honeypotHit(body)) {
    noteFailure(keys);
    log("sign-up not made (honeypot) from " + ip);
    httpu.sendJson(res, 200, { ok: true });
    return false;
  }
  const guard = openSignupGuard();
  // A quick answer from the list read on arrival; createUser checks the cap
  // again inside its lock (openSignupRefuseIf), where a burst can't race it.
  if (guard.capReached(signupGuard.recentAccounts(users))) {
    logCapTripped();
    httpu.sendError(res, 503, signupGuard.REFUSE_CAP);
    return false;
  }
  if (!guard.take(ip)) {
    noteFailure(keys);
    log("sign-up refused: " + signupGuard.addressKey(ip) + " already made " + guard.perIp + " account(s) in 24 hours");
    httpu.sendError(res, 429, signupGuard.REFUSE_IP);
    return false;
  }
  return true;
}

route("POST", "/api/auth/register", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 8192);
  const ip = httpu.clientIp(req, CFG);
  const users = await auth.listUsers();
  const first = users.length === 0;
  let invite = null;
  let openSignup = false;
  // Every problem with the form in one answer (#242), not one per attempt.
  // Pure checks on what was typed, so listing them next to a wrong invite
  // tells a code guesser nothing; the throttle below is unchanged (one
  // failure per request with a missing or wrong code, blank included).
  const problems = auth.registrationProblems(body);
  const refuse = (status, list) => httpu.sendError(res, status, list.join(" "), { problems: list });

  if (!first) {
    if (CFG.registration === "closed") { httpu.sendError(res, 403, "Sign-ups are closed right now."); return; }
    // Open mode honours a code that is sent too (#135), through this same
    // consume, throttle and org re-check; only a blank code skips it there.
    if (auth.signupRedeemsInvite(CFG.registration, body.invite)) {
      // Invite codes are guessable in principle, so the same throttle applies.
      const wait = lockedFor(["reg:" + ip]);
      if (wait) {
        httpu.sendJson(res, 429, {
          error: "Too many failed attempts. Try again in " + Math.ceil(wait / 60) + " minute(s)."
        }, { "Retry-After": String(wait) });
        return;
      }
      invite = await auth.consumeInvite(body.invite);
      if (!invite) {
        noteFailure(["reg:" + ip]);
        const why = await auth.inviteStateByCode(body.invite);
        refuse(403, problems.concat(auth.inviteRefusal(CFG.registration, body.invite, why)));
        return;
      }
      clearFailures(["reg:" + ip]);
    } else {
      // Open mode, no code (#506): the honeypot, this address's daily limit
      // and the site-wide daily cap. Answered here, or one sign-up reserved.
      if (!(await guardOpenSignup(res, body, ip, users))) return;
      openSignup = true;
    }
  }
  if (problems.length) {
    // A good invite isn't spent on a form that can't be accepted yet.
    if (invite) await auth.releaseInvite(invite.code);
    if (openSignup) openSignupGuard().release(ip);
    refuse(400, problems);
    return;
  }
  // An org invite is re-checked now, not trusted as stored (#126): the org
  // must still exist, the inviter must still be entitled to send it, and
  // its stores are re-filtered to the org's current active ones.
  let orgMeta = null;
  if (invite && invite.orgMeta) {
    const chk = await orgs.checkOrgInviteAtUse(invite);
    if (chk.error) {
      await auth.releaseInvite(invite.code);
      httpu.sendError(res, 403, chk.error);
      return;
    }
    orgMeta = chk.orgMeta;
  }
  // A member's link (#337) is re-checked now too: the admin may have turned
  // member invites off, or the inviter may have been disabled, since it was made.
  let inviter = null;
  if (invite && invite.memberInvite) {
    const chk = await auth.checkMemberInviteAtUse(invite);
    if (!chk.inviter) {
      await auth.releaseInvite(invite.code);
      refuse(403, [auth.inviteRefusal(CFG.registration, body.invite, chk.state)]);
      return;
    }
    inviter = chk.inviter;
  }
  let user;
  try {
    user = await auth.createUser({
      username: body.username, password: body.password,
      displayName: body.displayName, email: body.email,
      refuseIf: openSignup ? openSignupRefuseIf : null
    });
  } catch (e) {
    if (invite) await auth.releaseInvite(invite.code);
    if (openSignup) openSignupGuard().release(ip);
    // The cap, caught inside the users lock: an answer, not a server error.
    if (openSignup && e.status === 503) { httpu.sendError(res, 503, e.message); return; }
    throw e;
  }
  if (invite) await auth.markInviteUsed(invite.code, user.id);
  // The account exists by now, so a failure here is logged, not a failed sign-up.
  if (inviter) {
    await friends.befriendInvited(user, inviter)
      .then(() => { notifyEvents.invitedFriendJoined(inviter, user); })
      .catch(e => log("[member invite] friending " + user.username + " and " + inviter.username + " failed: " + e.message));
  }
  // Sign-up asks about the daily digest (checkbox, unticked by default) -
  // an explicit "no" is recorded; anything else leaves the default (subscribed).
  if (body.digest === false) await digest.setSubscribed(user.id, false, "signup").catch(() => {});
  // An org employee invite (orgs.js's invite flow, BACKLOG.md #9) both
  // creates the account AND sets its org membership in one step, rather
  // than needing a second "now join this org" action after registering.
  let publicUser = auth.publicUser(user);
  if (orgMeta) {
    publicUser = await auth.setOrgMembership(user.id, orgMeta);
  }
  const { sid, days } = await auth.createSession(user.id, CFG, req);
  httpu.sendJson(res, 200, { user: publicUser, first },
    { "Set-Cookie": auth.sessionCookie(sid, CFG, days, req) });
  log("registered: " + user.username + (first ? " (first user - administrator)" : "") + (inviter ? " (invited by " + inviter.username + ")" : ""));
}, { open: true });

/* ============================== Daily digest ============================== */
/* See server/lib/digest.js. Subscription is per account, on by default. */
route("GET", "/api/digest/subscription", async ({ res, user }) => {
  const prefs = await store.readPrefs(user.id);
  httpu.sendJson(res, 200, {
    subscribed: digest.isSubscribed(prefs),
    hasEmail: String(user.email || "").includes("@"),
    emailConfigured: await mailer.configured(store)
  });
});

route("POST", "/api/digest/subscription", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  await digest.setSubscribed(user.id, !!body.subscribed, "settings");
  httpu.sendJson(res, 200, { subscribed: !!body.subscribed });
});

/* Your own digest for a day (default yesterday), rendered exactly as it
   would be emailed - Settings' "Preview" link. Never sends anything. */
route("GET", "/api/digest/preview", async ({ res, url, user }) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "") ? url.searchParams.get("date") : digest.yesterdayUtc();
  const d = await digest.build(user, date);
  httpu.sendRaw(res, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, Buffer.from(digest.renderHtml(d)));
});

/* Email yourself today's digest now, even on a quiet day - the "does this
   actually reach my inbox" check. Only ever to the signed-in account's own
   address. */
route("POST", "/api/digest/send-test", async ({ res, user }) => {
  if (!String(user.email || "").includes("@")) { httpu.sendError(res, 400, "Add an email address to your account first."); return; }
  await digest.sendOne(user, digest.yesterdayUtc(), { force: true });
  httpu.sendJson(res, 200, { ok: true, sentTo: user.email });
});

/* The email's unsubscribe link. GET only shows a confirm button - mail
   scanners and link previews fetch GETs, and must not unsubscribe anyone by
   looking. POST does it (the button, or a mail client's one-click). */
function unsubPage(title, bodyHtml) {
  return Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + title + ' · Grimoire</title><link rel="stylesheet" href="/css/app.css"></head><body class="auth"><div class="auth-card">' +
    '<div class="brand">Grimoire</div><h3 style="margin-top:14px">' + title + "</h3>" + bodyHtml + "</div></body></html>");
}
route("GET", "/api/digest/unsubscribe", async ({ res, url }) => {
  const u = url.searchParams.get("u") || "", t = url.searchParams.get("t") || "";
  const html = digest.verifyToken(u, t)
    ? unsubPage("Stop the daily digest?", '<p class="tag">You won\'t get Grimoire\'s daily email any more. You can turn it back on under Settings → Account.</p>' +
        '<form method="post" action="/api/digest/unsubscribe?u=' + encodeURIComponent(u) + "&t=" + encodeURIComponent(t) + '">' +
        '<button type="submit" class="primary" style="width:100%">Unsubscribe</button></form>')
    : unsubPage("Link not recognised", '<p class="tag">This unsubscribe link is incomplete or out of date. Sign in and use Settings → Account instead.</p>');
  httpu.sendRaw(res, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, html);
}, { open: true });
route("POST", "/api/digest/unsubscribe", async ({ res, url }) => {
  const u = url.searchParams.get("u") || "", t = url.searchParams.get("t") || "";
  if (!digest.verifyToken(u, t)) {
    httpu.sendRaw(res, 403, { "Content-Type": "text/html; charset=utf-8" },
      unsubPage("Link not recognised", '<p class="tag">Sign in and use Settings → Account instead.</p>'));
    return;
  }
  await digest.setSubscribed(u, false, "email-link");
  log("[digest] unsubscribed via email link: " + u);
  httpu.sendRaw(res, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    unsubPage("You're unsubscribed", '<p class="tag">No more daily digests. Changed your mind? Settings → Account turns it back on.</p>' +
      '<a href="/index.html"><button class="primary" style="width:100%">Open Grimoire</button></a>'));
}, { open: true });

/* ============================== Two-factor (BACKLOG #51) ============================== */
/* In-session re-checks (password before 2FA changes, a password change, an
   email change; the code before turning 2FA off) share the sign-in
   lockout's keys. Otherwise a stolen session cookie is an unthrottled
   oracle for the account's real password - and for its 2FA code. */
function reauthKeys(req, user) {
  return ["ip:" + httpu.clientIp(req, CFG), "user:" + String(user.username || "").toLowerCase()];
}
function reauthLocked(req, user, res) {
  const wait = lockedFor(reauthKeys(req, user));
  if (!wait) return false;
  log("re-auth throttled: " + user.username + " (" + wait + "s left)");
  httpu.sendJson(res, 429, { error: "Too many wrong attempts. Try again in " + Math.ceil(wait / 60) + " minute(s)." },
    { "Retry-After": String(wait) });
  return true;
}
async function reauthFailed(req, user, res, message) {
  noteFailure(reauthKeys(req, user));
  await new Promise(r => setTimeout(r, 250));
  httpu.sendError(res, 403, message);
}
async function requirePassword(req, user, password, res, message) {
  if (reauthLocked(req, user, res)) return false;
  if (auth.verifyPassword(password, user.pwd)) return true;
  await reauthFailed(req, user, res, message || "Your password is wrong.");
  return false;
}
route("GET", "/api/auth/2fa", async ({ res, user }) => {
  httpu.sendJson(res, 200, {
    enabled: auth.hasTwoFactor(user),
    recoveryLeft: Array.isArray(user.totpRecovery) ? user.totpRecovery.length : 0
  });
});
// Re-asks for the password even inside a session: turning 2FA on/off and
// minting recovery codes are exactly what a hijacked session would try.
route("POST", "/api/auth/2fa/begin", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  if (!(await requirePassword(req, user, body.password, res))) return;
  httpu.sendJson(res, 200, await auth.totpBegin(user.id));
});
route("POST", "/api/auth/2fa/confirm", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  const recoveryCodes = await auth.totpConfirm(user.id, body.code);
  log("2FA enabled: " + user.username);
  httpu.sendJson(res, 200, { ok: true, recoveryCodes });
});
route("POST", "/api/auth/2fa/disable", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  if (!(await requirePassword(req, user, body.password, res))) return;
  const r = await auth.checkSecondFactor(user.id, body.code);
  if (!r.ok) { await reauthFailed(req, user, res, "That code didn't work."); return; }
  await auth.totpDisable(user.id);
  log("2FA disabled: " + user.username);
  httpu.sendJson(res, 200, { ok: true });
});
route("POST", "/api/auth/2fa/recovery", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  if (!(await requirePassword(req, user, body.password, res))) return;
  httpu.sendJson(res, 200, { recoveryCodes: await auth.totpNewRecovery(user.id) });
});

route("POST", "/api/auth/password", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 8192);
  if (!(await requirePassword(req, user, body.current, res, "Your current password is wrong."))) return;
  await auth.setPassword(user.id, body.next);
  const n = await auth.destroyAllSessions(user.id);
  const { sid, days } = await auth.createSession(user.id, CFG, req);
  httpu.sendJson(res, 200, { ok: true, signedOutSessions: Math.max(0, n - 1) },
    { "Set-Cookie": auth.sessionCookie(sid, CFG, days, req) });
});

/* Always the same response whether or not the address is on file - same
   anti-enumeration posture as login (index.js's noFailure comment above) and
   as GET /api/share/:username below. Every call counts against the throttle
   regardless of outcome, on purpose: a real match is not "proof" of anything
   here (an attacker can guess a real email on the first try), so nothing
   should ever clear the counter early the way a correct login password does.
   #167: the reply goes out before the address is even looked up - the
   lookup and the sending happen afterwards in server/lib/resetMail.js's
   bounded queue, so the response time says nothing about whether the
   address is on file. That module also caps how many emails one request,
   and one address per window, can get. */
const resetMail = resetMailLib.createResetMail({ auth, mailer, store, log, baseUrl: () => (CFG && CFG.baseUrl) || "" });

route("POST", "/api/auth/forgot", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 2048);
  const ip = httpu.clientIp(req, CFG);
  const email = String(body.email || "").trim().toLowerCase();
  const keys = ["pwreset:ip:" + ip, "pwreset:email:" + email];
  const wait = lockedFor(keys);
  if (wait) {
    httpu.sendJson(res, 429, { error: "Too many requests. Try again in " + Math.ceil(wait / 60) + " minute(s)." },
      { "Retry-After": String(wait) });
    return;
  }
  noteFailure(keys);
  httpu.sendJson(res, 200, { ok: true, message: "If that email is on file, a reset link is on its way." });
  resetMail.forgot(email);
}, { open: true });

/* The sign-up page's "Request an invite" form (#238). Public, so it is
   throttled like Forgot password: every submission counts against the
   address, valid or not, and 8 in 15 minutes closes it for 15 minutes.
   A filled-in honeypot or an email that already has an open request gets
   the same answer as a stored request, so the form says nothing about who
   has asked. Nobody is emailed here; the request waits in Admin -> Invites.
   The store's own caps (server/lib/inviteRequests.js) keep it bounded,
   including MAX_OPEN_PER_IP waiting requests per address, so one address
   can't fill every waiting slot; both caps get the same 503.
   takeRequest() is shared with the business contact form (#249) below: the
   route decides the kind, and both kinds count against the same throttle
   key and the same caps, so the two forms together are bounded the same as
   one. */
async function takeRequest(req, res, kind) {
  const what = kind === "business" ? "business enquiry" : "invite request";
  const ip = httpu.clientIp(req, CFG);
  const keys = ["invreq:ip:" + ip];
  const wait = lockedFor(keys);
  if (wait) {
    httpu.sendJson(res, 429, { error: "Too many requests. Try again in " + Math.ceil(wait / 60) + " minute(s)." },
      { "Retry-After": String(wait) });
    return;
  }
  noteFailure(keys);
  const body = await httpu.readJsonBody(req, 8192);
  // The visitor never picks the kind: a business form can't post a personal
  // request or the other way round.
  const out = await inviteRequests.submit(Object.assign({}, body, { kind }), null, ip);
  if (out.result === "invalid") {
    httpu.sendError(res, 400, out.problems.join(" "), { problems: out.problems });
    return;
  }
  if (out.result === "full" || out.result === "ip-full") {
    log(out.result === "full"
      ? what + " refused: the open-request cap (" + inviteRequests.MAX_OPEN + ") is reached"
      : what + " refused: " + ip + " already has " + inviteRequests.MAX_OPEN_PER_IP + " waiting");
    httpu.sendError(res, 503, "We can't take new requests right now. Please try again in a few days.");
    return;
  }
  if (out.result === "stored") log(what + " received (" + out.request.kind + ") from " + ip);
  else log(what + " not stored (" + out.result + ") from " + ip);
  httpu.sendJson(res, 200, { ok: true });
}

route("POST", "/api/invite-requests", async ({ req, res }) => {
  if (CFG.registration !== "invite") { httpu.sendError(res, 404, "Invite requests aren't being taken right now."); return; }
  await takeRequest(req, res, "personal");
}, { open: true });

/* The landing page's business contact form (business.html, #249): a shop
   asking about using Grimoire. Taken whatever the sign-up mode, since it
   isn't a sign-up. Same throttle, caps, honeypot and silent duplicate as
   the invite request above; nobody is emailed. It waits in Admin -> Invites
   tagged business, for the admin to get in touch and mark it handled. */
route("POST", "/api/business-enquiries", async ({ req, res }) => {
  await takeRequest(req, res, "business");
}, { open: true });

route("POST", "/api/auth/reset", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 8192);
  const ip = httpu.clientIp(req, CFG);
  const keys = ["pwreset-use:" + ip];
  const wait = lockedFor(keys);
  if (wait) {
    httpu.sendJson(res, 429, { error: "Too many attempts. Try again in " + Math.ceil(wait / 60) + " minute(s)." },
      { "Retry-After": String(wait) });
    return;
  }
  // #155: a password that breaks the rules is refused before the token is
  // looked at, so the link still works for the next try - and it says
  // nothing about the token, so it doesn't count toward the throttle.
  const weak = auth.passwordProblem(body.password);
  if (weak) { httpu.sendError(res, 400, weak); return; }
  try {
    const user = await auth.consumePasswordResetToken(body.token, body.password);
    clearFailures(keys);
    // An emailed link proves the inbox, not the second factor - a 2FA
    // account sets its new password here but still signs in with its code.
    if (auth.hasTwoFactor(await auth.findUserById(user.id))) {
      httpu.sendJson(res, 200, { ok: true, needsSignIn: true });
      return;
    }
    const { sid, days } = await auth.createSession(user.id, CFG, req);
    httpu.sendJson(res, 200, { ok: true, user: auth.publicUser(user) },
      { "Set-Cookie": auth.sessionCookie(sid, CFG, days, req) });
  } catch (e) {
    noteFailure(keys);
    throw e;
  }
}, { open: true });

/* The email is where password resets and the digest go, so changing it is
   an account takeover step (new email, then "forgot password") - it needs
   the password, unlike the other account toggles. Re-saving the same
   address doesn't. */
route("POST", "/api/auth/email", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  const next = String(body.email == null ? "" : body.email).trim();
  if (next.toLowerCase() !== String(user.email || "").trim().toLowerCase() &&
      !(await requirePassword(req, user, body.password, res,
        body.password ? "Your password is wrong." : "Enter your password to change your email."))) return;
  await auth.setEmail(user.id, body.email);
  httpu.sendJson(res, 200, { ok: true, email: String(body.email == null ? "" : body.email).trim() });
});

route("POST", "/api/auth/signout-everywhere", async ({ req, res, user }) => {
  const n = await auth.destroyAllSessions(user.id);
  httpu.sendJson(res, 200, { ok: true, sessions: n }, { "Set-Cookie": auth.clearCookie(CFG, req) });
});

/* Presence-only ping. The route table's dispatcher already calls
   auth.touchPresence() for every non-open request (see `handle()` above), so
   this handler has nothing to do beyond replying - it exists purely so a
   page with no other API traffic still keeps "last active" fresh while it
   sits open and idle. */
route("POST", "/api/heartbeat", async ({ res }) => { httpu.sendJson(res, 200, { ok: true }); });

/* ============================== Notifications (#139) ==============================
   The header bell. Storage and bounds: server/lib/notifications.js; who is
   told what: server/lib/notifyEvents.js; the daily pass: notifyJob.js.
   GET ?unread=1 is the cheap poll every open tab makes about once a
   minute (an in-memory count, no file read once warm). The list never
   carries links: opening an item re-checks access first, then hands back
   the link, so a stale notification can't lead anywhere its reader can no
   longer see. */
route("GET", "/api/notifications", async ({ res, url, user }) => {
  const unread = await notifications.unreadCount(user.id);
  if (url.searchParams.get("unread") === "1") { httpu.sendJson(res, 200, { unread }); return; }
  httpu.sendJson(res, 200, { unread, items: await notifications.list(user.id) });
});

route("POST", "/api/notifications/read-all", async ({ res, user }) => {
  await notifications.markAllRead(user.id);
  httpu.sendJson(res, 200, { unread: 0 });
});

route("GET", "/api/notifications/settings", async ({ res, user }) => {
  httpu.sendJson(res, 200, { groups: await notifications.settings(user.id) });
});
route("POST", "/api/notifications/settings", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  httpu.sendJson(res, 200, { groups: await notifications.setGroup(user.id, String(body.group || ""), body.on !== false) });
});

/* Clicking an item: marks it read, re-checks that its reader may still see
   what it's about (notifyEvents.canOpen), then gives the page the link and,
   when the item is about another store, which store that is (switchTo).
   It does NOT switch the session: the page saves its own edits first, then
   switches through /api/store/switch (notifyEvents.openTarget says why). */
route("POST", "/api/notifications/:id/open", async ({ res, user, params, docOwner }) => {
  const item = await notifications.markRead(user.id, params.id);
  if (!item) { httpu.sendError(res, 404, "That notification is gone."); return; }
  const unread = await notifications.unreadCount(user.id);
  const t = await notifyEvents.openTarget(user, item, docOwner);
  if (!t.ok) {
    httpu.sendJson(res, 200, { link: null, unread,
      message: "This can't be opened any more: it was removed, or you no longer have access to it." });
    return;
  }
  httpu.sendJson(res, 200, { link: t.link, unread, switchTo: t.switchTo, from: t.from });
});

/* Get-or-create an invite tied to a pick ticket's promo footer, for any
   signed-in user (not admin-only, unlike /api/admin/invite below) - a
   warehouse packer printing a pick ticket has no admin access, but every
   printed ticket should still be able to carry the "get your own copy"
   invite link. Only for a real pick list in an inventory the caller can
   work right now (#138; see server/lib/pickInvite.js), and repeat prints
   of the SAME pick ticket return the invite already minted for it instead
   of creating a new one each time. Only the code goes back: the page
   needs nothing else from the invite record. */
route("POST", "/api/invite/pick-list", async ({ req, res, user, docOwner }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const out = await pickInvite.pickListInvite(user, docOwner, body.pickListId, body.note);
  if (out.error) { httpu.sendError(res, out.status, out.error); return; }
  const code = out.invite.code;
  httpu.sendJson(res, 200, { invite: { code }, url: (CFG.baseUrl || "") + "/login.html?invite=" + code });
});

/* ============================== Admin ============================== */
route("GET", "/api/admin/status", async ({ res }) => {
  httpu.sendJson(res, 200, {
    version: VERSION,
    dataDir: store.dir(),
    users: await auth.listUsers(),
    invites: await auth.listInvites(),
    cards: cards.status(),
    sealed: sealed.status(),
    prices: await prices.status(),
    mtgjson: mtgjson.status(),
    jobs: await store.readJobs(),
    registration: CFG.registration,
    node: process.version,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    uptimeMin: Math.round(process.uptime() / 60)
  });
}, { admin: true });

/* Paginated/searchable user list, gated to moderator+ (moderators need to see
   who they might be helping) rather than admin-only like the rest of this
   section - role/disable changes below stay admin-only. Presence merged in
   per row so the dashboard can show an online-now dot and a last-active time
   without a separate round trip. */
route("GET", "/api/admin/users", async ({ url, res, user }) => {
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const roleFilter = url.searchParams.get("role") || "";
  const statusFilter = url.searchParams.get("status") || ""; // "disabled" | "active" | ""

  const db = await store.readUsers();
  const presenceMap = await auth.presenceByUser();
  let list = db.users.map(u => Object.assign(auth.publicUser(u), {
    disabled: !!u.disabled,
    hasEmail: !!u.email,
    // Whether the viewer may set this account's email or send it a reset
    // link (#154) - the page hides those buttons otherwise. The two routes
    // check again; this is only so the page doesn't offer them.
    canManage: !auth.accountActionProblem(user, u),
    presence: presenceMap[u.id] || null
  }));
  if (q) list = list.filter(u => (u.username + " " + u.displayName).toLowerCase().includes(q));
  if (auth.ROLES.includes(roleFilter)) list = list.filter(u => u.role === roleFilter);
  if (statusFilter === "disabled") list = list.filter(u => u.disabled);
  else if (statusFilter === "active") list = list.filter(u => !u.disabled);

  const { items, total, page, pageSize } = httpu.sortAndPaginate(list, url.searchParams,
    { defaultSort: "createdAt", defaultPageSize: 50 });
  httpu.sendJson(res, 200, { users: items, total, page, pageSize });
}, { role: "moderator" });

route("POST", "/api/admin/users/:id/role", async ({ req, res, params }) => {
  const body = await httpu.readJsonBody(req, 1024);
  const u = await auth.setRole(params.id, String(body.role || ""));
  httpu.sendJson(res, 200, { ok: true, user: u });
}, { admin: true });

/* Last resort for someone who lost their phone AND their recovery codes:
   an admin turns their 2FA off (and signs them out everywhere) so they can
   sign in with just the password and set it up again. Admin-only, logged. */
route("POST", "/api/admin/users/:id/2fa-reset", async ({ res, params, user }) => {
  await auth.totpDisable(params.id);
  await auth.destroyAllSessions(params.id);
  log("2FA reset by admin " + user.username + " for user " + params.id);
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

route("POST", "/api/admin/users/:id/disabled", async ({ req, res, params }) => {
  const body = await httpu.readJsonBody(req, 1024);
  const u = await auth.setDisabled(params.id, !!body.disabled);
  httpu.sendJson(res, 200, { ok: true, user: u });
}, { admin: true });

/* Attaches/updates a recovery email for an account that doesn't have one (or
   has a stale one) on file, and the matching "Send reset email" below.
   Without these there is no way to get an existing account (created before
   email was captured at signup, or left blank) into a state where
   self-service reset can reach it at all.
   #154/#167: setting an address and then sending it a reset link is an
   account takeover, so both are administrator-only (owner's decision,
   #167), and never on your own account (auth.accountActionProblem;
   Settings asks for the password there, these routes don't). Moderators
   still see the accounts list, without addresses. The old address is told
   when email is set up, and both sends are rate-limited per admin and per
   address (server/lib/resetMail.js). */
async function accountActionTarget(res, user, id) {
  const target = await auth.findUserById(id);
  if (!target) { httpu.sendError(res, 404, "No such user."); return null; }
  const why = auth.accountActionProblem(user, target);
  if (why) { httpu.sendError(res, 403, why); return null; }
  return target;
}

function sendTooMany(res, wait, what) {
  httpu.sendJson(res, 429, { error: "Too many " + what + " right now. Try again in " + Math.ceil(wait / 60) + " minute(s)." },
    { "Retry-After": String(wait) });
}

route("POST", "/api/admin/users/:id/email", async ({ req, res, params, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  const target = await accountActionTarget(res, user, params.id);
  if (!target) return;
  const before = String(target.email || "").trim();
  const after = String(body.email == null ? "" : body.email).trim();
  const changed = !!before && before.toLowerCase() !== after.toLowerCase();
  // A bad address is refused before it can use up a notice slot.
  const bad = auth.emailProblem(after);
  if (bad) { httpu.sendError(res, 400, bad); return; }
  // An email change whose notice to the old address can't go out (over the
  // limit) is refused, not made silently (#167). The notice is reserved -
  // checked and counted in one step - BEFORE the change is saved, so
  // concurrent changes can't all slip under the limit; a reserved notice is
  // always sent. If setEmail fails, the slot stays used (resetMail.js says
  // why that's the safe way round).
  let notice = false;
  if (changed) {
    const r = await resetMail.reserveNotice(user, before);
    if (r.wait) { sendTooMany(res, r.wait, "email changes"); return; }
    notice = r.reserved;
  }
  await auth.setEmail(target.id, body.email);
  log("email for " + target.username + " " + (after ? "changed" : "cleared") + " by " + user.role + " " + user.username);
  if (notice) resetMail.sendNotice(target, before, user);
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

/* The "help with password changes" action: re-triggers the same reset
   email a user could send themselves from the login page, for when they
   can't get to it (email trouble, account confusion, etc.). Does not set a
   password directly - nobody learns or chooses anyone else's password,
   only nudges the same self-service link out again. */
route("POST", "/api/admin/users/:id/reset-email", async ({ res, params, user }) => {
  // Same who-may-act rule as the email route above (#154, #167).
  const target = await accountActionTarget(res, user, params.id);
  if (!target) return;
  if (!target.email) { httpu.sendError(res, 400, target.username + " has no email address on file."); return; }
  // A disabled account can't finish a reset anyway (#155) - say so now.
  if (target.disabled) { httpu.sendError(res, 400, target.username + " is disabled."); return; }
  const { wait } = await resetMail.adminReset(user, target);
  if (wait) { sendTooMany(res, wait, "reset emails"); return; }
  log("reset email for " + target.username + " sent by " + user.role + " " + user.username);
  httpu.sendJson(res, 200, { ok: true, sentTo: auth.emailShownTo(user, target.email) });
}, { admin: true });

/* Instance-level email config (who password-reset mail is sent through) -
   admin-only, same "leave blank to keep the saved secret, never echo it
   back" shape as the per-user Manapool/Pitney Bowes credential routes. */
route("GET", "/api/admin/email", async ({ res }) => {
  const cfg = await store.readEmailConfig();
  httpu.sendJson(res, 200, {
    provider: cfg.provider || "", from: cfg.from || "", hasKey: !!cfg.apiKey,
    configured: !!(cfg.provider && cfg.apiKey && cfg.from)
  });
}, { admin: true });

route("POST", "/api/admin/email", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 4096);
  const cur = await store.readEmailConfig();
  await store.writeEmailConfig({
    provider: body.provider ? String(body.provider).trim() : (cur.provider || "resend"),
    from: body.from != null ? String(body.from).trim() : (cur.from || ""),
    apiKey: body.apiKey ? String(body.apiKey).trim() : (cur.apiKey || "")
  });
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

route("POST", "/api/admin/email/test", async ({ res, user }) => {
  if (!user.email) { httpu.sendError(res, 400, "Your own account has no email address on file to send a test to."); return; }
  await mailer.send(store, {
    to: user.email, subject: "Grimoire test email",
    html: "<p>If you're reading this, email is working. Sent to " + user.email + ".</p>"
  });
  httpu.sendJson(res, 200, { ok: true, sentTo: user.email });
}, { admin: true });

/* GitHub issue filing for support tickets (#40) - admin-only, same "blank
   keeps the saved secret, never echo it back" shape as /api/admin/email. */
route("GET", "/api/admin/github", async ({ res }) => {
  const cfg = await store.readGithubConfig();
  httpu.sendJson(res, 200, {
    repo: cfg.repo || "", hasToken: !!cfg.token, configured: github.configured(cfg),
    syncMinutes: githubSyncMinutes() || null, lastSync: lastGithubSync
  });
}, { admin: true });

route("POST", "/api/admin/github", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 4096);
  const cur = await store.readGithubConfig();
  const repo = body.repo != null ? String(body.repo).trim() : (cur.repo || "");
  if (repo && !github.validRepo(repo)) { httpu.sendError(res, 400, "The repository must look like owner/name."); return; }
  await store.writeGithubConfig({
    repo,
    token: body.token ? String(body.token).trim() : (cur.token || "")
  });
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

route("POST", "/api/admin/github/test", async ({ res }) => {
  const out = await github.testRepo(await store.readGithubConfig());
  httpu.sendJson(res, 200, Object.assign({ ok: true }, out));
}, { admin: true });

route("POST", "/api/admin/invite", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const inv = await auth.createInvite(user.id, body.note);
  httpu.sendJson(res, 200, { invite: inv, url: (CFG.baseUrl || "") + "/login.html?invite=" + inv.code });
}, { admin: true });

/* Cancels any invite that hasn't been used (#160): an admin-minted code,
   a pick ticket's, or an organization's. A used one can't be revoked. */
route("POST", "/api/admin/invites/:code/revoke", async ({ res, params, user }) => {
  const inv = await auth.revokeInvite(params.code, user.id);
  if (!inv) { httpu.sendError(res, 404, "No such invite, or it has already been used."); return; }
  log("invite revoked by admin " + user.username);
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

/* Member invites (#337; the rules are in server/lib/auth.js). Routes under
   /api/member-invites only ever read or change the signed-in account's own
   links. Admin -> Invites -> Member invites has the switch, the allowance and
   who invited whom. There is no admin audit log on this server, so these
   record to server.log the way the invite routes above do. */
const inviteLink = code => (CFG.baseUrl || "") + "/login.html?invite=" + code;

route("GET", "/api/member-invites", async ({ res, user }) => {
  const d = await auth.memberInvitesFor(user.id);
  d.signupsClosed = CFG.registration === "closed";
  d.invites.forEach(i => { if (i.status === "open") i.url = inviteLink(i.code); });
  httpu.sendJson(res, 200, d);
});

route("POST", "/api/member-invites", async ({ res, user }) => {
  if (CFG.registration === "closed") { httpu.sendError(res, 403, "Sign-ups are closed right now."); return; }
  let inv;
  try { inv = await auth.createMemberInvite(user.id); }
  catch (e) { httpu.sendError(res, e.status || 400, e.message); return; }
  log("member invite created by " + user.username);
  httpu.sendJson(res, 200, { invite: { code: inv.code, expiresAt: inv.expiresAt }, url: inviteLink(inv.code) });
});

route("POST", "/api/member-invites/:code/cancel", async ({ res, params, user }) => {
  if (!await auth.cancelMemberInvite(params.code, user.id)) {
    httpu.sendError(res, 404, "That link is already used or gone."); return;
  }
  log("member invite cancelled by " + user.username);
  httpu.sendJson(res, 200, { ok: true });
});

route("GET", "/api/admin/member-invites", async ({ res }) => {
  httpu.sendJson(res, 200, await auth.memberInviteOverview());
}, { admin: true });

route("POST", "/api/admin/member-invites", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  let s;
  try { s = await auth.setMemberInviteSettings({ enabled: body.enabled, allowance: body.allowance }); }
  catch (e) { httpu.sendError(res, e.status || 400, e.message); return; }
  log("member invites set to " + (s.enabled ? "on" : "off") + ", " + s.allowance + " each, by admin " + user.username);
  httpu.sendJson(res, 200, s);
}, { admin: true });

route("POST", "/api/admin/member-invites/allowance", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  let name;
  try { name = await auth.setMemberInviteAllowance(body.username, body.allowance === undefined ? null : body.allowance); }
  catch (e) { httpu.sendError(res, e.status || 400, e.message); return; }
  log("invite allowance of " + name + " set to " + (body.allowance == null ? "the usual" : body.allowance) + " by admin " + user.username);
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

/* Admin -> Invites -> Invite requests (#238). The list carries what the
   admin needs to decide and follow up: whether the email already belongs
   to an account, and how the invite sent for it stands now (open, used,
   expired, revoked). Admin-only, like everything else about invites. */
route("GET", "/api/admin/invite-requests", async ({ res }) => {
  const [rows, invites, db, emailOn] = await Promise.all([
    inviteRequests.list(), auth.listInvites(), store.readUsers(), mailer.configured(store)
  ]);
  const byCode = new Map(invites.filter(i => i.code).map(i => [i.code, i]));
  const emails = new Set(db.users.map(u => String(u.email || "").toLowerCase()).filter(Boolean));
  const inviteState = i => !i ? null : i.used ? "used" : i.revoked ? "revoked" : i.expired ? "expired" : "open";
  httpu.sendJson(res, 200, {
    emailConfigured: emailOn,
    requests: rows.map(r => Object.assign({}, r, {
      hasAccount: emails.has(r.email),
      inviteState: r.inviteCode ? inviteState(byCode.get(r.inviteCode)) : null,
      inviteUrl: r.inviteCode ? (CFG.baseUrl || "") + "/login.html?invite=" + r.inviteCode : null
    }))
  });
}, { admin: true });

/* One click: mint an invite for the request and email its link to the
   requester. The invite is tagged with the request (sourceRef), so a double
   click or a "Send again" reuses the same code while it still works rather
   than stacking up codes. When email isn't set up, or the provider refuses,
   the invite still exists and the request is marked sent with emailed:
   false; the answer carries the link for the admin to send by hand. */
route("POST", "/api/admin/invite-requests/:id/send", async ({ req, res, params, user }) => {
  const r = await inviteRequests.get(params.id);
  if (!r) { httpu.sendError(res, 404, "No such request."); return; }
  if (r.status === "dismissed") { httpu.sendError(res, 409, "That request was dismissed."); return; }
  if (r.kind === "business") { httpu.sendError(res, 409, "That's a business enquiry, not an invite request. Mark it handled once you've been in touch."); return; }
  const inv = await auth.createInvite(user.id, ("Requested by " + r.name).slice(0, 120), null, "invreq:" + r.id);
  const link = "/login.html?invite=" + inv.code;
  // The email needs a full address. baseUrl is the configured one; without
  // it, the address the admin is using the site at right now.
  const origin = CFG.baseUrl || ((httpu.isSecureRequest(req, CFG) ? "https://" : "http://") + (req.headers.host || "localhost:" + CFG.port));
  const emailOn = await mailer.configured(store);
  let emailed = false, emailError = null;
  if (emailOn) {
    try {
      const msg = inviteRequests.inviteEmail(r.name, origin + link);
      await mailer.send(store, Object.assign({ to: r.email }, msg));
      emailed = true;
    } catch (e) {
      emailError = e.message;
      log("[invite-request] email to request " + r.id + " failed: " + e.message);
    }
  }
  const updated = await inviteRequests.markSent(r.id, { inviteCode: inv.code, emailed, byUserId: user.id });
  if (!updated) { httpu.sendError(res, 409, "That request was dismissed."); return; }
  log("invite request " + r.id + " sent by admin " + user.username + (emailed ? " (emailed)" : " (not emailed)"));
  httpu.sendJson(res, 200, {
    request: updated, emailed, emailConfigured: emailOn, emailError,
    url: (CFG.baseUrl || "") + link
  });
}, { admin: true });

route("POST", "/api/admin/invite-requests/:id/dismiss", async ({ res, params, user }) => {
  const r = await inviteRequests.dismiss(params.id, user.id);
  if (!r) { httpu.sendError(res, 404, "No such open request."); return; }
  log("invite request " + r.id + " dismissed by admin " + user.username);
  httpu.sendJson(res, 200, { ok: true, request: r });
}, { admin: true });

/* A business enquiry (#249), once the admin has been in touch with the shop
   outside Grimoire. Nothing is sent from here. */
route("POST", "/api/admin/invite-requests/:id/handled", async ({ res, params, user }) => {
  const r = await inviteRequests.markHandled(params.id, user.id);
  if (!r) { httpu.sendError(res, 404, "No such open business enquiry."); return; }
  log("business enquiry " + r.id + " marked handled by admin " + user.username);
  httpu.sendJson(res, 200, { ok: true, request: r });
}, { admin: true });

route("POST", "/api/admin/cards/refresh", async ({ res }) => {
  const p = cards.refreshBulk({ force: true });
  p.catch(() => {});
  httpu.sendJson(res, 202, { started: true, note: "Refreshing in the background - poll /api/cards/status." });
}, { admin: true });

route("POST", "/api/admin/tags/refresh", async ({ res }) => {
  const p = cards.refreshTags({ force: true });
  p.catch(() => {});
  httpu.sendJson(res, 202, { started: true, note: "Refreshing in the background - poll /api/cards/tags-status." });
}, { admin: true });

route("POST", "/api/admin/prices/snapshot", async ({ res }) => {
  const result = await prices.snapshot({ force: true });
  httpu.sendJson(res, 200, result);
}, { admin: true });

route("POST", "/api/admin/cards/apply-price-source", async ({ res }) => {
  const result = await cards.applyPriceSource();
  httpu.sendJson(res, 200, result);
}, { admin: true });

route("POST", "/api/admin/cards/price-source", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const value = String(body.priceSource || "");
  if (value !== "scryfall" && value !== "manapool") {
    httpu.sendError(res, 400, 'priceSource must be "scryfall" or "manapool".'); return;
  }
  CFG.cards.priceSource = value;
  await writeConfigPriceSource(value);
  const result = await cards.applyPriceSource();
  httpu.sendJson(res, 200, Object.assign({ priceSource: value }, result));
}, { admin: true });

/* Admin-only status/refresh for the catalog itself (see BACKLOG.md #24/#16) -
   the non-admin search route below is what Receive's sealed intake actually
   reads from. */
route("GET", "/api/admin/sealed/status", async ({ res }) => {
  httpu.sendJson(res, 200, sealed.status());
}, { admin: true });

route("POST", "/api/admin/sealed/refresh", async ({ res }) => {
  // Unlike the card database's refresh (hundreds of MB, minutes, needs a
  // background job + poll), the sealed feed is one ~650KB request - fast
  // enough to just await and hand back the result directly, same as
  // apply-price-source does for its own single-request Manapool pull.
  const result = await sealed.refresh();
  httpu.sendJson(res, 200, result);
}, { admin: true });

/* Non-admin, unlike the two routes above - this is Receive's sealed-intake
   search, same "any signed-in account" gate as /api/cards/autocomplete. */
route("GET", "/api/sealed/search", async ({ res, url }) => {
  httpu.sendJson(res, 200, { data: sealed.search(url.searchParams.get("q"), 20) });
});

/* Batch re-read of the (already daily-refreshed, see sealed.init/runDueJobs)
   in-memory catalog by tcgplayer_product_id - backs the Sealed page's
   "Refresh prices" button. Not a live Manapool call itself, just exposing
   what the existing background refresh already pulled. */
route("GET", "/api/sealed/lookup", async ({ res, url }) => {
  const ids = String(url.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 500);
  const data = ids.map(id => sealed.one(id)).filter(Boolean);
  httpu.sendJson(res, 200, { data });
});

route("POST", "/api/admin/restart", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const delaySeconds = Math.min(600, Math.max(5, Number(body.delaySeconds) || 30));
  const at = Date.now() + delaySeconds * 1000;
  const reason = String(body.reason || "").slice(0, 1000);
  await store.writeRestartRequest({ at, reason, requestedBy: user.username });
  PENDING_RESTART = { at, reason, requestedBy: user.username };
  log("[restart] requested by " + user.username + " - restarting in " + delaySeconds + "s" + (reason ? " (" + reason + ")" : ""));
  httpu.sendJson(res, 200, { ok: true, at, reason });
}, { admin: true });

route("POST", "/api/admin/restart/cancel", async ({ res, user }) => {
  await store.clearRestartRequest();
  PENDING_RESTART = null;
  log("[restart] cancelled by " + user.username);
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

/* ============================== Support tickets ============================== */
/* One shared document (store.readTickets/writeTickets) - a ticket's own
   `messages` array IS the thread, no separate reply table. Anyone signed in
   can open a ticket and reply to their own; moderator+ can see every
   ticket, reply to any of them (through the same reply route below - the
   authorization check inside it is "owner OR staff", not a separate
   moderator-only route), and change status. */
const TICKET_CATEGORIES = ["bug", "support", "feature"];
const TICKET_STATUSES = ["open", "in-progress", "resolved", "closed"];
const isStaff = role => (auth.ROLE_RANK[role] || 0) >= auth.ROLE_RANK.moderator;

function ticketSummary(t) {
  return {
    id: t.id, category: t.category, subject: t.subject, status: t.status,
    createdBy: t.createdBy, createdByUsername: t.createdByUsername,
    createdAt: t.createdAt, updatedAt: t.updatedAt, messageCount: t.messages.length,
    github: t.github ? { number: t.github.number, url: t.github.url, state: t.github.state || "open" } : null
  };
}

/* The reporter's own view of a ticket: the GitHub link is staff-only (the
   repo is private, and reporters never see it), so it's dropped from every
   response a non-staff account gets. */
function forReporter(t, user) {
  if (!t || !t.github || isStaff(user.role)) return t;
  const out = Object.assign({}, t);
  delete out.github;
  return out;
}

/* ============================== Tickets -> GitHub issues (#40) ==============================
   Fire-and-forget like notifyNewTicket: GitHub not configured or down only
   logs, the ticket is already saved, and an admin can retry with Send to
   GitHub. The in-flight set stops a double click (or the auto-file racing
   a manual send) from opening two issues for one ticket. Flow:
   docs/flows/ticket-github-sync.dot. */
const githubFiling = new Set();
async function fileTicketOnGithub(ticketId, opts) {
  if (githubFiling.has(ticketId)) { const e = new Error("That ticket is already being sent to GitHub."); e.status = 409; throw e; }
  githubFiling.add(ticketId);
  try {
    const cfg = await store.readGithubConfig();
    if (!github.configured(cfg)) { const e = new Error("GitHub isn't connected yet - set it up in Admin > GitHub."); e.status = 400; throw e; }
    const db = await store.readTickets();
    const t = db.tickets.find(x => x.id === ticketId);
    if (!t) { const e = new Error("No such ticket."); e.status = 404; throw e; }
    if (t.github) { const e = new Error("That ticket is already linked to issue #" + t.github.number + "."); e.status = 409; throw e; }
    // A manual send first looks for an issue already carrying this
    // ticket's marker: an earlier create can have succeeded on GitHub's
    // side even though its answer never arrived (timeout, 5xx).
    let issue = opts && opts.searchFirst ? await github.findIssueForTicket(cfg, ticketId) : null;
    if (issue) log("[github] ticket " + ticketId + " already has issue #" + issue.number + " in " + issue.repo + " - linked it");
    else {
      issue = await github.createIssue(cfg, t);
      log("[github] ticket " + ticketId + " filed as issue #" + issue.number + " in " + issue.repo);
    }
    return await store.updateTickets(db2 => {
      const x = db2.tickets.find(y => y.id === ticketId);
      if (!x) return null;
      if (!x.github) x.github = { repo: issue.repo, number: issue.number, url: issue.url, state: issue.state, filedAt: new Date().toISOString() };
      return x;
    });
  } finally { githubFiling.delete(ticketId); }
}
async function autoFileTicket(t) {
  if (t.category !== "bug" && t.category !== "feature") return;
  try {
    if (!github.configured(await store.readGithubConfig())) { log("[github] not connected - ticket " + t.id + " not filed"); return; }
    await fileTicketOnGithub(t.id);
  } catch (e) { log("[github] filing ticket " + t.id + " failed: " + e.message); }
}

/* The 15-minute check (see the timer in main()). Not a daily job: it's
   cheap, bounded per run (github.SYNC_MAX_PER_RUN), and a reporter
   shouldn't wait a day to hear their fix is live. */
let lastGithubSync = null;
let githubSyncRunning = false;
function githubSyncMinutes() {
  const n = jobHour((CFG.github || {}).syncMinutes);
  return Number.isFinite(n) && n >= 1 ? n : 0;
}
async function runGithubSync() {
  if (githubSyncRunning) return;
  githubSyncRunning = true;
  try {
    const out = await github.syncTickets({
      store, cfg: await store.readGithubConfig(), notify: notifyTicketReply, log
    });
    lastGithubSync = Object.assign({ at: new Date().toISOString() }, out);
  } catch (e) {
    lastGithubSync = { at: new Date().toISOString(), error: e.message };
    log("[github] sync failed: " + e.message);
  } finally { githubSyncRunning = false; }
}

/* ============================== Ticket notifications (BACKLOG.md #29) ==============================
   Smallest version, per direct user decision (2026-09-05): no "assigned to"
   field, just reusing the roles that already exist -
     - a new ticket emails every admin
     - a staff reply emails the reporter (skipped if staff replied to their
       own ticket - can't happen today since only staff+ tickets have an
       admin/moderator as createdBy, but cheap to guard anyway)
     - a MODERATOR's reply (specifically, not an admin's) additionally
       emails every admin, on the theory that a moderator has less standing
       authority than an admin and this is the visibility that substitutes
       for a real assignee field
   Best-effort throughout: email not configured, no verified domain, a
   downed provider - none of that may ever fail the ticket action itself,
   so every failure here is caught and only logged. */
async function ticketAdminEmails() {
  const db = await store.readUsers();
  return db.users.filter(u => u.role === "admin" && !u.disabled && u.email).map(u => u.email);
}
async function notifyNewTicket(t) {
  try {
    if (!(await mailer.configured(store))) return;
    const emails = await ticketAdminEmails();
    if (!emails.length) return;
    const html = "<p><b>" + httpu.escapeHtml(t.createdByUsername) + "</b> opened a new " +
      httpu.escapeHtml(t.category) + " ticket: <b>" + httpu.escapeHtml(t.subject) + "</b></p>" +
      "<p>" + httpu.escapeHtml(t.messages[0].body).replace(/\n/g, "<br>") + "</p>" +
      '<p><a href="' + (CFG.baseUrl || "") + '/admin.html">Open in Admin</a></p>';
    for (const to of emails) {
      await mailer.send(store, { to, subject: "New Grimoire ticket: " + t.subject, html }).catch(e =>
        log("[ticket-notify] new-ticket email to " + to + " failed: " + e.message));
    }
  } catch (e) { log("[ticket-notify] new-ticket notification failed: " + e.message); }
}
async function notifyTicketReply(t, replier) {
  // In-app (#139) whether or not email is set up; never throws.
  await notifyEvents.ticketReplied(t, replier);
  try {
    if (!(await mailer.configured(store))) return;
    const msg = t.messages[t.messages.length - 1];
    const staff = isStaff(replier.role);
    if (staff && replier.id !== t.createdBy) {
      const reporter = await auth.findUserById(t.createdBy);
      if (reporter && reporter.email && !reporter.disabled) {
        const html = "<p><b>" + httpu.escapeHtml(replier.username) + "</b> replied to your ticket " +
          "<b>" + httpu.escapeHtml(t.subject) + "</b>:</p><p>" +
          httpu.escapeHtml(msg.body).replace(/\n/g, "<br>") + "</p>" +
          '<p><a href="' + (CFG.baseUrl || "") + '/help.html">View your ticket</a></p>';
        await mailer.send(store, { to: reporter.email, subject: "Re: " + t.subject, html }).catch(e =>
          log("[ticket-notify] reply email to reporter failed: " + e.message));
      }
    }
    if (replier.role === "moderator" && t.status !== "closed") {
      const emails = await ticketAdminEmails();
      const html = "<p><b>" + httpu.escapeHtml(replier.username) + "</b> (moderator) replied to " +
        "<b>" + httpu.escapeHtml(t.subject) + "</b>:</p><p>" +
        httpu.escapeHtml(msg.body).replace(/\n/g, "<br>") + "</p>" +
        '<p><a href="' + (CFG.baseUrl || "") + '/admin.html">Open in Admin</a></p>';
      for (const to of emails) {
        await mailer.send(store, { to, subject: "Moderator reply on ticket: " + t.subject, html }).catch(e =>
          log("[ticket-notify] moderator-reply email to " + to + " failed: " + e.message));
      }
    }
  } catch (e) { log("[ticket-notify] reply notification failed: " + e.message); }
}

route("GET", "/api/tickets", async ({ res, user }) => {
  const db = await store.readTickets();
  const mine = db.tickets.filter(t => t.createdBy === user.id)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  httpu.sendJson(res, 200, { tickets: mine.map(t => forReporter(t, user)) });
});

route("POST", "/api/tickets", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 8192);
  const category = TICKET_CATEGORIES.includes(body.category) ? body.category : "support";
  const subject = String(body.subject || "").trim().slice(0, 1000);
  const message = String(body.message || "").trim().slice(0, 8000);
  if (!subject) { httpu.sendError(res, 400, "Give the ticket a subject."); return; }
  if (!message) { httpu.sendError(res, 400, "Describe the issue."); return; }
  const now = new Date().toISOString();
  const ticket = {
    id: httpu.randomId(12),
    createdBy: user.id, createdByUsername: user.username,
    category, subject, status: "open",
    messages: [{ from: user.id, fromUsername: user.username, fromRole: user.role, body: message, at: now }],
    createdAt: now, updatedAt: now
  };
  await store.updateTickets(db => { db.tickets.push(ticket); });
  notifyNewTicket(ticket); // fire-and-forget - see notifyNewTicket's own doc comment
  autoFileTicket(ticket);  // fire-and-forget too - Bug/Feature only, see autoFileTicket
  httpu.sendJson(res, 200, { ticket: forReporter(ticket, user) });
});

route("POST", "/api/tickets/:id/reply", async ({ req, res, user, params }) => {
  const body = await httpu.readJsonBody(req, 8192);
  const message = String(body.message || "").trim().slice(0, 8000);
  if (!message) { httpu.sendError(res, 400, "Write a message first."); return; }
  let denied = false;
  const t = await store.updateTickets(db => {
    const t = db.tickets.find(x => x.id === params.id);
    if (!t) return null;
    const owner = t.createdBy === user.id;
    const staff = isStaff(user.role);
    if (!owner && !staff) { denied = true; return null; }
    const now = new Date().toISOString();
    t.messages.push({ from: user.id, fromUsername: user.username, fromRole: user.role, body: message, at: now });
    t.updatedAt = now;
    // A staff reply on an open ticket nudges it to "in-progress"; a reply from
    // the requester on one staff had marked "resolved" reopens it instead of
    // leaving a live conversation sitting under a "done" status.
    if (staff && t.status === "open") t.status = "in-progress";
    else if (owner && t.status === "resolved") t.status = "open";
    return t;
  });
  if (denied) { httpu.sendError(res, 403, "That isn't your ticket."); return; }
  if (!t) { httpu.sendError(res, 404, "No such ticket."); return; }
  notifyTicketReply(t, user); // fire-and-forget - see notifyTicketReply's own doc comment
  httpu.sendJson(res, 200, { ticket: forReporter(t, user) });
});

/* Self-service close/reopen for the ticket's own creator - moderator+ use
   the dedicated status route below instead, which allows any status. */
route("POST", "/api/tickets/:id/close", async ({ res, user, params }) => {
  let denied = false;
  const t = await store.updateTickets(db => {
    const t = db.tickets.find(x => x.id === params.id);
    if (!t) return null;
    if (t.createdBy !== user.id) { denied = true; return null; }
    t.status = t.status === "closed" ? "open" : "closed";
    t.updatedAt = new Date().toISOString();
    return t;
  });
  if (denied) { httpu.sendError(res, 403, "That isn't your ticket."); return; }
  if (!t) { httpu.sendError(res, 404, "No such ticket."); return; }
  httpu.sendJson(res, 200, { ticket: forReporter(t, user) });
});

route("GET", "/api/admin/tickets", async ({ url, res }) => {
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const statusFilter = url.searchParams.get("status") || "";
  const categoryFilter = url.searchParams.get("category") || "";

  const db = await store.readTickets();
  let list = db.tickets.map(ticketSummary);
  if (q) list = list.filter(t => (t.subject + " " + t.createdByUsername).toLowerCase().includes(q));
  if (TICKET_STATUSES.includes(statusFilter)) list = list.filter(t => t.status === statusFilter);
  if (TICKET_CATEGORIES.includes(categoryFilter)) list = list.filter(t => t.category === categoryFilter);

  const { items, total, page, pageSize } = httpu.sortAndPaginate(list, url.searchParams,
    { defaultSort: "updatedAt", defaultPageSize: 25 });
  httpu.sendJson(res, 200, { tickets: items, total, page, pageSize });
}, { role: "moderator" });

route("GET", "/api/admin/tickets/:id", async ({ res, params }) => {
  const db = await store.readTickets();
  const t = db.tickets.find(x => x.id === params.id);
  if (!t) { httpu.sendError(res, 404, "No such ticket."); return; }
  httpu.sendJson(res, 200, { ticket: t });
}, { role: "moderator" });

route("POST", "/api/admin/tickets/:id/status", async ({ req, res, params }) => {
  const body = await httpu.readJsonBody(req, 1024);
  const status = String(body.status || "");
  if (!TICKET_STATUSES.includes(status)) { httpu.sendError(res, 400, "Not a valid status."); return; }
  const t = await store.updateTickets(db => {
    const t = db.tickets.find(x => x.id === params.id);
    if (!t) return null;
    t.status = status;
    t.updatedAt = new Date().toISOString();
    return t;
  });
  if (!t) { httpu.sendError(res, 404, "No such ticket."); return; }
  httpu.sendJson(res, 200, { ticket: t });
}, { role: "moderator" });

/* Admin's Send to GitHub button, for a ticket with no linked issue yet
   (Support tickets, or a Bug/Feature whose automatic filing failed). */
route("POST", "/api/admin/tickets/:id/github", async ({ res, params }) => {
  const t = await fileTicketOnGithub(params.id, { searchFirst: true });
  if (!t) { httpu.sendError(res, 404, "No such ticket."); return; }
  httpu.sendJson(res, 200, { ticket: t });
}, { admin: true });

/* ============================== Collection ============================== */
/* Autosave target. The browser holds no localStorage copy in v0.08 - the server
   is the only home for a collection, which is what made multi-device and
   multi-user possible in the first place.

   Every route below reads/writes through `docOwner` (resolved once per
   request in handle(), BACKLOG.md #9) rather than user.id directly - a
   personal account's own id, unchanged, or the Store its session is acting
   on behalf of. docOwner is null only for an org member with no store
   assigned yet, handled explicitly below rather than letting store.js
   silently create a bogus "null"-keyed document. */
function requireDocOwner(docOwner, res) {
  if (docOwner) return true;
  httpu.sendError(res, 409, "Your account isn't assigned to a store yet - ask an organization owner or manager to assign you one.");
  return false;
}

// Top-level collection fields added by #50 (customer wantlists), and
// customerAliases by #196 (merged customers).
const CUSTOMER_FIELDS = ["customers", "customerWants", "restockMatches", "customerTombstones", "customerAliases"];
// Every top-level field a stale tab's save must not wipe: the customer
// fields, saved decks (#309) and the in-person trade history (#335).
const CARRY_FORWARD = CUSTOMER_FIELDS.concat(["decks", "trades", "receiving", "receivingLines"]);

/* #145: which inventory a page loaded. GET /api/collection says (`owner`),
   the page echoes it on every PUT /api/collection and POST /api/audit, and
   either is refused when the session has since moved to another inventory
   (the store switched in another tab): never merged, never written. A page
   still running the JS from before this (no `owner` sent) keeps the old
   behaviour, so a tab left open across the deploy doesn't fail every save
   until it is reloaded; core.js is network-first, so any reload ends that.
   The refusal names the inventory the page was showing, when this account
   can still tell which one that is. #185: Settings' Restore and its
   revision list carry the same check; `what` says what didn't happen. */
async function wrongOwnerReply(res, user, loaded, what) {
  const o = String(loaded || "");
  let label = "a different store";
  if (o.startsWith("store:")) {
    const s = await orgs.storeById(o.slice("store:".length)).catch(() => null);
    if (s && user.orgId && s.orgId === user.orgId && s.name) label = s.name;
  } else if (o === String(user.id)) {
    label = "your personal collection";
  }
  httpu.sendJson(res, 409, {
    error: "This tab was showing " + label + ", but you have switched to a different store since " +
      "(maybe in another tab), so " + (what || "your latest change here was not saved") + ". Reload to continue.",
    wrongOwner: true
  });
}

route("GET", "/api/collection", async ({ res, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const c = await store.readCollection(docOwner);
  // patch: this server takes patch saves (#181), so the page may send them.
  httpu.sendJson(res, 200, { rev: c.rev, savedAt: c.savedAt, state: c.state, owner: String(docOwner), patch: 1 });
});

/* A cheap "did anything change?" for a page that stays open all shift (Warehouse
   Mode, #386): no document read, so asking costs nothing next to GET /api/collection. */
route("GET", "/api/collection/stamp", async ({ res, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  httpu.sendJson(res, 200, { stamp: await store.collectionStamp(docOwner) });
});

const REPLACE_REFUSED = "Only a store manager or owner can erase, replace or restore the store's whole inventory.";

route("PUT", "/api/collection", async ({ req, res, user, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const body = await httpu.readJsonBody(req);
  // #181: {rev, patch} sends only what changed since rev (server/lib/patch.js);
  // writeCollection rebuilds the document, or answers 422 patchRefused and
  // the page sends {rev, state} instead.
  const patch = body && body.patch && typeof body.patch === "object" ? body.patch : null;
  if (!body || (!patch && (typeof body.state !== "object" || body.state === null))) {
    httpu.sendError(res, 400, "Send {rev, state}.");
    return;
  }
  const st = patch ? null : body.state;
  if (st && (!Array.isArray(st.cards) || !Array.isArray(st.locations))) {
    httpu.sendError(res, 400, "state.cards and state.locations must both be arrays.");
    return;
  }
  // archive: true marks the save that carries an Erase or a Replace import
  // (core.js saveNow({ archive: true })). It always keeps the version it
  // replaces as a revision (#157), and in a Store only a Manager or Owner
  // may send one (#159).
  const archive = body.archive === true;
  if (store.ownerMismatch(body.owner, docOwner)) { await wrongOwnerReply(res, user, body.owner); return; }
  if (archive && !orgs.canReplaceInventory(user, docOwner)) { httpu.sendError(res, 403, REPLACE_REFUSED); return; }
  try {
    // CARRY_FORWARD: a save from a stale tab (pre-#50, pre-#309) omits them entirely,
    // and must not wipe them (see store.writeCollection's carryForward).
    // #139: a "came in" match this save adds (or bumps) is told to everyone
    // who works in this inventory, once the save is on disk.
    // #175: saveId / afterSaveIds make a save that reaches the server twice
    // apply once (store.js "Idempotent saves"). loadedOwner is checked
    // again there, inside the save itself.
    // #216: a pick list completion's activity log lines ride on the save
    // (merge.js completionAudit); logged once it is written, unless it was
    // a repeat the merge undid. Stamped as POST /api/audit stamps them.
    let restocks = [], replaced = null, completionLines = [];
    const saved = await store.writeCollection(docOwner, st, body.rev == null ? -1 : Number(body.rev),
      { carryForward: CARRY_FORWARD, forceRevision: archive, lockSettings: orgs.lockedSettingKeys(user, docOwner),
        saveId: body.saveId, afterSaveIds: body.afterSaveIds, loadedOwner: body.owner, sentBytes: req.bodyBytes, patch,
        onWrite: (before, after) => { restocks = notifyEvents.newRestocks(before, after); replaced = [before, after]; },
        onAudit: lines => { completionLines = lines; } });
    if (restocks.length) notifyEvents.restocksSaved(docOwner, restocks); // fire-and-forget
    if (completionLines.length) {
      const by = user.displayName || user.username;
      await auditStore.append(docOwner, completionLines.map(e => Object.assign({}, e, { by, byUserId: user.id })))
        .catch(e => log("ERROR logging a pick list completion for " + docOwner + ": " + e.message));
    }
    // A Staff save that emptied most of the Store (owner's answer on #159):
    // allowed, kept as a revision (the outgoing rev), and logged here.
    const drop = replaced && orgs.staffBigDropEntry(user, docOwner, replaced[0], replaced[1], saved.rev - 1);
    if (drop) {
      await auditStore.append(docOwner, [drop])
        .catch(e => log("ERROR logging a Staff big drop for " + docOwner + ": " + e.message));
    }
    httpu.sendJson(res, 200, saved);
  } catch (e) {
    if (e.wrongOwner) { await wrongOwnerReply(res, user, e.loadedOwner); return; }
    if (e.patchRefused) { httpu.sendJson(res, 422, { error: e.message, patchRefused: true, serverRev: e.serverRev }); return; }
    if (e.status === 409) {
      const out = { error: e.message, serverRev: e.serverRev };
      if (e.alreadyCompleted) out.alreadyCompleted = e.alreadyCompleted; // #214
      httpu.sendJson(res, 409, out);
      return;
    }
    throw e;
  }
});

/* #185: Settings names the inventory it loaded (?owner=, the same `owner`
   as GET /api/collection), so a tab left on Store A doesn't list Store B's
   revisions after the session switched. No owner (a page from before
   this): listed as before. */
route("GET", "/api/collection/revisions", async ({ res, user, docOwner, url }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const loaded = url.searchParams.get("owner");
  if (store.ownerMismatch(loaded, docOwner)) {
    await wrongOwnerReply(res, user, loaded, "the revision list can't be shown here");
    return;
  }
  httpu.sendJson(res, 200, { revisions: await store.listRevisions(docOwner) });
});

route("GET", "/api/collection/revision/:rev", async ({ res, docOwner, params }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const doc = await store.readRevision(docOwner, params.rev);
  if (!doc) { httpu.sendError(res, 404, "No such revision."); return; }
  httpu.sendJson(res, 200, doc);
});

/* Restoring always keeps the version it replaces (#157), and in a Store
   only a Manager or Owner may do it (#159). #185: the page names the
   inventory it loaded (`owner`, as a save does); a restore from a tab
   whose session has since switched stores is refused before anything is
   read or written, since revision N of the other store is a different
   version from the one the page listed. No owner (a page from before
   this): restored as before. */
const RESTORE_REFUSED_WHAT = "the revision was not restored";
route("POST", "/api/collection/restore", async ({ req, res, user, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const body = (await httpu.readJsonBody(req, 8192)) || {};
  if (store.ownerMismatch(body.owner, docOwner)) { await wrongOwnerReply(res, user, body.owner, RESTORE_REFUSED_WHAT); return; }
  if (!orgs.canReplaceInventory(user, docOwner)) { httpu.sendError(res, 403, REPLACE_REFUSED); return; }
  const doc = await store.readRevision(docOwner, body.rev);
  if (!doc || !doc.state) { httpu.sendError(res, 404, "No such revision."); return; }
  try {
    const saved = await store.writeCollection(docOwner, doc.state, -1,
      { forceRevision: true, lockSettings: orgs.lockedSettingKeys(user, docOwner), loadedOwner: body.owner });
    httpu.sendJson(res, 200, Object.assign({ restoredFrom: doc.rev }, saved));
  } catch (e) {
    if (e.wrongOwner) { await wrongOwnerReply(res, user, e.loadedOwner, RESTORE_REFUSED_WHAT); return; }
    throw e;
  }
});

/* ============================== Organizations / Stores ============================== */
/* BACKLOG.md #9. Any account can create an org (becoming its Owner) as
   long as it isn't already in one - orgs.createOrg() enforces that and
   does the collection-import. Everything past creation is gated on
   orgRole via the same { orgRole: "..." } route option handle() already
   checks alongside role/admin (server/index.js's dispatcher). */
route("POST", "/api/orgs", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const result = await orgs.createOrg(user, body.name);
  httpu.sendJson(res, 200, result);
});

route("GET", "/api/orgs/mine", async ({ res, user, docOwner }) => {
  if (!user.orgId) { httpu.sendError(res, 404, "This account isn't in an organization."); return; }
  const org = await orgs.orgById(user.orgId);
  if (!org) { httpu.sendError(res, 404, "This account's organization no longer exists."); return; }
  const [allStores, members] = await Promise.all([orgs.storesOfOrg(user.orgId), orgs.membersOfOrg(user.orgId)]);
  httpu.sendJson(res, 200, {
    org, stores: allStores, members,
    // Only an Owner can restore one (#127), so only an Owner is sent them.
    archivedStores: orgs.isOrgOwner(user) ? await orgs.archivedStoresOfOrg(user.orgId) : [],
    // Just id -> name (#134), so a Manager sees "Name (archived)" in the
    // Employees table rather than a raw id.
    archivedStoreNames: orgs.isOrgManager(user)
      ? Object.fromEntries((await orgs.archivedStoresOfOrg(user.orgId)).map(s => [s.id, s.name])) : {},
    accessibleStoreIds: (await orgs.accessibleStores(user)).map(s => s.id),
    // docOwner is already "store:<id>" or null (resolveDocOwner, same
    // chokepoint /api/collection itself goes through) - the client's
    // store-switcher pre-selects this without needing its own copy of the
    // fallback-to-first-accessible-store logic.
    activeStoreId: docOwner ? docOwner.slice("store:".length) : null
  });
});

route("POST", "/api/orgs/stores", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const s = await orgs.addStore(user.orgId, body.name);
  httpu.sendJson(res, 200, { store: s });
}, { orgRole: "manager" });

route("POST", "/api/orgs/stores/:id/rename", async ({ req, res, user, params }) => {
  const target = await orgs.storeById(params.id);
  if (!target || target.orgId !== user.orgId) { httpu.sendError(res, 404, "No such store."); return; }
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const s = await orgs.renameStore(params.id, body.name);
  httpu.sendJson(res, 200, { store: s });
}, { orgRole: "manager" });

/* Archive and restore are Owner-only (#127): archiving takes a store's
   whole inventory offline for everyone. archiveStore() refuses the org's
   last active store (400). */
route("POST", "/api/orgs/stores/:id/archive", async ({ res, user, params }) => {
  const target = await orgs.storeById(params.id);
  if (!target || target.orgId !== user.orgId) { httpu.sendError(res, 404, "No such store."); return; }
  const s = await orgs.archiveStore(params.id, user.id);
  // #128: a store's open trade proposals (sent from it or addressed to it)
  // are withdrawn with it. Losing a manager doesn't do this; the store's
  // other managers keep handling them.
  await actFrom.withdrawStoreProposals(s, user);
  httpu.sendJson(res, 200, { store: s });
}, { orgRole: "owner" });

route("POST", "/api/orgs/stores/:id/restore", async ({ res, user, params }) => {
  const target = await orgs.storeById(params.id);
  if (!target || target.orgId !== user.orgId) { httpu.sendError(res, 404, "No such store."); return; }
  const s = await orgs.restoreStore(params.id, user.id);
  httpu.sendJson(res, 200, { store: s });
}, { orgRole: "owner" });

/* Invites an employee into the caller's own org - reuses the existing
   invite-code system (auth.createInvite/consumeInvite), just with
   orgMeta attached so accepting it both creates the account and sets its
   membership (see /api/auth/register above). Only an Owner can invite a
   new Owner or Manager; a Manager can only invite Staff - mirrors why
   Manager can't touch other Managers/Owners anywhere else in this
   section. */
route("POST", "/api/orgs/invite", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const orgRole = auth.ORG_ROLES.includes(body.orgRole) ? body.orgRole : "staff";
  if (orgRole !== "staff" && user.orgRole !== "owner") {
    httpu.sendError(res, 403, "Only an owner can invite another owner or manager."); return;
  }
  // Only this org's active stores (#126); junk or foreign ids are dropped.
  const storeIds = orgRole === "staff" ? await orgs.filterStoreIds(user.orgId, body.storeIds) : [];
  if (orgRole === "staff" && !storeIds.length) {
    httpu.sendError(res, 400, "Pick at least one of your organization's stores for a staff invite."); return;
  }
  const note = typeof body.note === "string" ? body.note : "";
  const inv = await auth.createInvite(user.id, note, { orgId: user.orgId, orgRole, storeIds });
  // Only what the page shows, not the stored record (creator id, sourceRef,
  // usedBy and the like stay server-side).
  httpu.sendJson(res, 200, {
    invite: { code: inv.code, note: inv.note, createdAt: inv.createdAt, expiresAt: inv.expiresAt, orgRole, storeIds },
    url: (CFG.baseUrl || "") + "/login.html?invite=" + inv.code
  });
}, { orgRole: "manager" });

/* Outstanding org invites (#126): an Owner sees every one for the org; a
   Manager sees only the Staff invites they made themselves. */
function canSeeOrgInvite(user, inv) {
  if (orgs.isOrgOwner(user)) return true;
  return user.orgRole === "manager" && inv.createdBy === user.id && inv.orgRole === "staff";
}

route("GET", "/api/orgs/invites", async ({ res, user }) => {
  const all = await auth.listOrgInvites(user.orgId);
  const mine = all.filter(i => canSeeOrgInvite(user, i)).map(i => Object.assign({}, i, {
    url: (CFG.baseUrl || "") + "/login.html?invite=" + i.code
  }));
  mine.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  httpu.sendJson(res, 200, { invites: mine, days: auth.ORG_INVITE_DAYS });
}, { orgRole: "manager" });

/* Revoke follows the same visibility: anything you can't see is a 404, so
   this can't be used to probe other orgs' codes. */
route("POST", "/api/orgs/invites/:code/revoke", async ({ res, user, params }) => {
  const all = await auth.listOrgInvites(user.orgId);
  const inv = all.find(i => i.code === params.code);
  if (!inv || !canSeeOrgInvite(user, inv)) { httpu.sendError(res, 404, "No such invite."); return; }
  const out = await auth.revokeInvite(inv.code, user.id);
  if (!out) { httpu.sendError(res, 404, "No such invite."); return; }
  httpu.sendJson(res, 200, { ok: true, code: inv.code });
}, { orgRole: "manager" });

/* Changes an existing member's role/store assignment, or removes them
   from the org entirely (body.remove: true) - the same last-owner
   protection auth.setOrgMembership() already enforces applies here too,
   so this can't strip the org's last Owner via either path. */
route("POST", "/api/orgs/members/:id", async ({ req, res, user, params }) => {
  const target = await auth.findUserById(params.id);
  if (!target || target.orgId !== user.orgId) { httpu.sendError(res, 404, "No such member."); return; }
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  // The target's CURRENT role counts too (#123): a Manager can't demote,
  // re-store or remove a fellow Manager or an Owner.
  const problem = orgs.memberChangeProblem(user, target, body);
  if (problem) { httpu.sendError(res, 403, problem); return; }
  const updated = body.remove
    ? await auth.setOrgMembership(target.id, { orgId: null }, { by: user.id })
    : await auth.setOrgMembership(target.id, {
        orgId: user.orgId,
        orgRole: auth.ORG_ROLES.includes(body.orgRole) ? body.orgRole : target.orgRole,
        // Store ids sent in the request are limited to this org's active
        // stores (#126); any archived store the member already has is kept
        // (#134), so it comes back to them if it's restored. Left out, the
        // member keeps what they have.
        storeIds: Array.isArray(body.storeIds) ? await orgs.memberStoreIds(user.orgId, body.storeIds, target.storeIds) : target.storeIds
      }, { by: user.id });
  httpu.sendJson(res, 200, { member: updated });
}, { orgRole: "manager" });

/* Sets which Store this session acts on behalf of - re-validated against
   current access, not just at switch time (see orgs.resolveDocOwner). */
route("POST", "/api/store/switch", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096).catch(() => ({}));
  const storeId = String(body.storeId || "");
  if (!(await orgs.canAccessStore(user, storeId))) { httpu.sendError(res, 403, "You don't have access to that store."); return; }
  await auth.setActiveStore(user.__sid, storeId);
  httpu.sendJson(res, 200, { ok: true, storeId });
});

/* Audit log: day-sharded per collection owner (server/lib/audit.js),
   separate from the collection document on purpose - see that file's
   header comment. Store-scoped the same way the collection itself is
   (BACKLOG.md #9): coworkers at the same store share one activity log,
   the same way they share the inventory it's a log of. */
route("POST", "/api/audit", async ({ req, res, user, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  // The normal per-save flush is a handful of entries, but this same route
  // also carries one-time bulk imports (the legacy-migration path, and a
  // v0.07 "replace" import's audit history) which can legitimately run into
  // the thousands - a cap sized for the former silently truncated the
  // latter. 20000 matches the ceiling GET /api/audit's query already uses.
  const body = await httpu.readJsonBody(req, 16 * 1024 * 1024);
  // #145: entries from a page that loaded another inventory don't belong
  // in this one's log (see wrongOwnerReply).
  if (store.ownerMismatch(body && body.owner, docOwner)) { await wrongOwnerReply(res, user, body.owner); return; }
  const entries = Array.isArray(body && body.entries) ? body.entries.slice(0, 20000) : [];
  // Who made this edit - stamped here from the authenticated session, not
  // trusted from whatever `by` the client sent (core.js's logAudit already
  // fills one in for immediate display before flush, but that's only ever
  // a best-effort echo of this same account's own name - this is the
  // record that actually persists). Matters once an Organization/Store has
  // more than one person editing the same collection (BACKLOG.md #9).
  const by = user.displayName || user.username;
  const stamped = entries.map(e => Object.assign({}, e, { by, byUserId: user.id }));
  const result = await auditStore.append(docOwner, stamped);
  httpu.sendJson(res, 200, result);
});

route("GET", "/api/audit", async ({ req, res, docOwner, url }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const qs = url.searchParams;
  const result = await auditStore.query(docOwner, {
    action: qs.get("action") || "",
    q: qs.get("q") || "",
    set: qs.get("set") || "",
    collector: qs.get("collector") || "",
    from: qs.get("from") || "",
    to: qs.get("to") || "",
    limit: qs.get("limit"),
    offset: qs.get("offset"),
    // total=0: skip counting every match (#178, the Dashboard); total is null.
    total: qs.get("total") !== "0"
  });
  httpu.sendJson(res, 200, result);
});

/* A Store's log is shared and is the trusted record of who did what, so only
   a manager or owner may wipe it (#76): the same rank the store-management
   routes above require. A personal account still clears its own. */
route("DELETE", "/api/audit", async ({ res, user, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  if (user.orgId && !auth.hasOrgRole(user, "manager")) {
    httpu.sendError(res, 403, "Only a store manager or owner can clear the activity log."); return;
  }
  await auditStore.clear(docOwner);
  httpu.sendJson(res, 200, { ok: true });
});

/* ============================== Cards ============================== */
route("GET", "/api/cards/status", async ({ res }) => {
  httpu.sendJson(res, 200, cards.status());
});

route("GET", "/api/cards/autocomplete", async ({ res, url }) => {
  httpu.sendJson(res, 200, { data: cards.autocomplete(url.searchParams.get("q"), 20) });
});

route("GET", "/api/cards/printings", async ({ res, url }) => {
  const name = url.searchParams.get("name") || "";
  const list = await cards.printings(name);
  httpu.sendJson(res, 200, { name, count: list.length, data: list });
});

/* Deck List format-legality flags (#80) - names in, one legality code per
   name out (see cards.legality()). POST because a full decklist's worth of
   names doesn't belong in a query string; capped well above any real deck. */
route("POST", "/api/cards/legality", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req);
  const names = Array.isArray(body.names) ? body.names.slice(0, 1000) : [];
  httpu.sendJson(res, 200, cards.legality(names));
});

route("GET", "/api/cards/one", async ({ res, url }) => {
  const set = url.searchParams.get("set") || "";
  const num = url.searchParams.get("num") || "";
  const lang = url.searchParams.get("lang") || "en";
  if (!set || !num) { httpu.sendError(res, 400, "set and num are required."); return; }
  const card = await cards.one(set, num, lang);
  if (!card) { httpu.sendError(res, 404, 'Not found: set "' + set + '" #' + num); return; }
  httpu.sendJson(res, 200, { card });
});

route("POST", "/api/cards/collection", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req);
  const ids = Array.isArray(body.identifiers) ? body.identifiers.slice(0, 20000) : [];
  const out = await cards.collection(ids);
  // out.found holds shallow copies, not the shared index objects (see
  // cards.collection(), #82), so the per-account fields below are safe to
  // add: at most 20000 copies (ids is capped above), dropped with the response.
  // Manapool prices, looked up live for just the printings in this batch (not
  // any kind of local copy of Manapool's whole catalog) and joined in by
  // scryfall id - deduped by printing same as everything else here, so both
  // foil variants and both condition tiers travel together and the browser
  // (which knows each row's own foil/condition) picks the right one, the
  // same way it already does for usd vs usdFoil. Silently skipped if this
  // account has no Manapool connection - askPrice rules just fall back to
  // Scryfall's market price for anyone who hasn't connected one.
  if (integrations.manapoolEnabled()) {
    const p = await store.readPrefs(user.id);
    const creds = mpAuth.credsFromPrefs(user.id, p);
    if (mpAuth.usable(creds)) {
      const scryfallIds = (out.found || []).map(c => c.id).filter(Boolean);
      if (scryfallIds.length) {
        try {
          const priced = await integrations.manapoolPrices(creds, scryfallIds);
          for (const c of out.found || []) {
            const mp = c.id && priced.get(c.id);
            if (mp) Object.assign(c, {
              mpLowNm: mp.nm, mpLowNmFoil: mp.nmFoil, mpLowOther: mp.lpPlus, mpLowOtherFoil: mp.lpPlusFoil,
              mpMarket: mp.market, mpMarketFoil: mp.marketFoil
            });
          }
        } catch (e) { /* Manapool prices are a bonus on top of Scryfall's, not required */ }
      }
    }
  }
  // Today's TCGplayer/Card Kingdom/Manapool prices from the local archive
  // (BACKLOG #78b price-rule bases), per finish, so the browser picks the
  // row's own like it does for usd/usdFoil. Local reads only, no account.
  try {
    const found = out.found || [];
    const FIN = ["nonfoil", "foil", "etched"];
    const vps = prices.vendorPricesFor(found.flatMap(c => FIN.map(finish => ({ set: c.set, collector: c.collector, lang: c.lang, finish }))));
    found.forEach((c, i) => {
      const v = {};
      FIN.forEach((f, j) => { if (vps[i * 3 + j]) v[f] = vps[i * 3 + j]; });
      if (Object.keys(v).length) c.vendor = v;
    });
  } catch (e) { /* a bonus, same as Manapool's above */ }
  httpu.sendJson(res, 200, out);
});

route("GET", "/api/cards/search", async ({ res, url }) => {
  const list = cards.search({
    q: url.searchParams.get("q"),
    set: url.searchParams.get("set"),
    rarity: url.searchParams.get("rarity"),
    limit: url.searchParams.get("limit")
  });
  httpu.sendJson(res, 200, { count: list.length, data: list });
});

route("GET", "/api/cards/sets", async ({ res }) => {
  httpu.sendJson(res, 200, { data: cards.sets() });
});

/* Oracle tag ("otag", e.g. "removal") or illustration tag ("art", e.g.
   "dragon") lookup, backing the Inventory Query builder's otag/art fields.
   Answered from the locally cached Tagger bulk files (see cards.tagSearch) -
   no live request per query, just a 503 while that cache is still loading
   for the first time. `found:false` means the typed text isn't a real tag
   slug/alias at all, as distinct from a real tag with zero matching cards. */
route("GET", "/api/cards/tag-search", async ({ res, url }) => {
  const kind = url.searchParams.get("kind") || "";
  const q = url.searchParams.get("q") || "";
  if (kind !== "otag" && kind !== "art") { httpu.sendError(res, 400, 'kind must be "otag" or "art".'); return; }
  try {
    const { ids, found } = cards.tagSearch(kind, q);
    httpu.sendJson(res, 200, { kind, q, found, count: ids.length, ids });
  } catch (e) {
    httpu.sendError(res, e.status || 502, e.message);
  }
});

route("GET", "/api/cards/tags-status", async ({ res }) => {
  httpu.sendJson(res, 200, cards.tagsStatus());
});

route("GET", "/api/cards/set/:code", async ({ res, params }) => {
  httpu.sendJson(res, 200, { data: cards.bySet(params.code) });
});

/* Per-set collector completion, for the Statistics "Collector view" -
   ownedKeys are "<set>|<oracleId>" strings the client already has in memory
   (G.state.cards), so this needs no per-user server-side collection lookup. */
route("POST", "/api/cards/set-completion", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 4 * 1024 * 1024);
  const owned = Array.isArray(body.owned) ? body.owned.slice(0, 50000) : [];
  httpu.sendJson(res, 200, { data: cards.setCompletion(owned) });
});

/* ============================== Prices ============================== */
route("GET", "/api/prices/movers", async ({ res, url, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const ownedOnly = url.searchParams.get("ownedOnly") === "1";
  const skipMA = url.searchParams.get("skipMA") === "1";
  const heldOnly = url.searchParams.get("heldOnly") === "1";
  const vendor = url.searchParams.get("vendor") || "";
  // top=N (the header ticker): only the N owned rows with the biggest value
  // change, cached per account per snapshot date (prices.movers clamps it).
  const top = Number(url.searchParams.get("top")) || 0;
  const out = await prices.movers(docOwner, url.searchParams.get("days"), { ownedOnly, skipMA, heldOnly, vendor, top });
  // #209: the Movers table's Sold 7d column - each row's copies sold on
  // Manapool in the last 7 days, attached per request (one batched lookup;
  // see mpSales.attachSold) so it's never staler than the sales history.
  // The header ticker (top / ownedOnly / skipMA) never shows it.
  if (!top && !ownedOnly && !skipMA && Array.isArray(out.rows) && out.rows.length) {
    try {
      const sold = mpSales.attachSold(out.rows, moversMpId);
      out.rows = sold.rows;
      out.sales = sold.sales;
    } catch (e) {
      log("[mpSales] Sold 7d lookup failed: " + e.message);
      out.sales = { error: "Manapool sales couldn't be read just now." };
    }
  }
  httpu.sendJson(res, 200, out);
});
/* Golden cross (#352): catalog printings whose 30-day trend line crossed
   above the 60-day one in the last `days` snapshot days (1-30, default 7)
   and sit at least `minGap`% above it now (0-100, default 5), with the
   caller's owned copies marked; mine=1 keeps only those. The
   catalog-wide part is computed once per snapshot day and cached
   (prices.goldenCrosses); this only filters it. */
route("GET", "/api/prices/golden-cross", async ({ res, url, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  httpu.sendJson(res, 200, await prices.goldenCrosses(docOwner, {
    days: url.searchParams.get("days"),
    minGap: url.searchParams.get("minGap"),   // percent, 0-100, default 5
    vendor: url.searchParams.get("vendor") || "",
    mine: url.searchParams.get("mine") === "1"
  }));
});
// Manapool keys its sales by the printing's scryfall id. A Movers row is a
// set/collector/language; Manapool's id is the English printing's, falling
// back to the row's own language for a printing that has no English version.
function moversMpCard(r) {
  return cards.cardByKey(r.set, r.collector, "en") || (r.lang && r.lang !== "en" ? cards.cardByKey(r.set, r.collector, r.lang) : null);
}
function moversMpId(r) {
  const c = moversMpCard(r);
  return c ? c.id : null;
}

/* Sold 7d on your own stock (#366): copies sold on Manapool in the last 7
   days and the SELLING FAST flag for every printing the account holds, for
   Listings, Card Inventory and the Dashboard. The printings come from the
   account's saved collection here, not from the browser, so the request is
   a plain GET at any size (70k stacks is a real account). One entry per
   set + collector number, matched to Manapool the way Movers is
   (moversMpId); see mpSales.soldByKey for the compact answer.
   Parsing a big collection isn't free, so the answer is kept per account
   until the collection is saved again or the sales history moves on
   (mpSales.dataKey); SOLD_MINE_MAX accounts at most. */
const soldMineCache = new Map();   // docOwner -> { key, body }
const SOLD_MINE_MAX = 20;
route("GET", "/api/prices/sold-mine", async ({ res, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  let body;
  try {
    const key = (await store.collectionStamp(docOwner)) + "|" + mpSales.dataKey();
    const hit = soldMineCache.get(docOwner);
    if (hit && hit.key === key) { httpu.sendJson(res, 200, hit.body); return; }
    const coll = await store.readCollection(docOwner);
    const sids = new Map();   // "set|collector" -> scryfall id or null
    for (const r of (coll.state && coll.state.cards) || []) {
      if (!r || !r.set || !r.collector) continue;
      const k = r.set + "|" + r.collector;
      if (!sids.has(k)) sids.set(k, moversMpId(r));
    }
    body = mpSales.soldByKey([...sids].map(([k, sid]) => ({ key: k, sid })));
    soldMineCache.delete(docOwner);
    if (soldMineCache.size >= SOLD_MINE_MAX) soldMineCache.delete(soldMineCache.keys().next().value);
    soldMineCache.set(docOwner, { key, body });
  } catch (e) {
    log("[mpSales] Sold 7d on own stock failed: " + e.message);
    body = { sold: {}, unmatched: [], sales: { error: "Manapool sales couldn't be read just now." } };
  }
  httpu.sendJson(res, 200, body);
});

/* Restock hints on the Buy List (#370): of the printings ("set|collector",
   or "set|collector|lang" for one with no English printing) and card names
   the account sold before or has customers wanting and now has none of
   (the browser works that out from its own document: stock, pick tickets,
   wants), the ones selling well on Manapool this week. See
   mpSales.restockFor; a name's answer also names its best-selling printing,
   so the page can watch it. Bounded by RESTOCK_PRINTS_MAX / RESTOCK_NAMES_MAX
   per request; the sales lookup is memoised per printing. */
const RESTOCK_PRINTS_MAX = 20000, RESTOCK_NAMES_MAX = 2000;
route("POST", "/api/prices/restock", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 1 << 20);
  const keys = Array.isArray(body.prints) ? body.prints.slice(0, RESTOCK_PRINTS_MAX) : [];
  const names = Array.isArray(body.names) ? body.names.slice(0, RESTOCK_NAMES_MAX) : [];
  let out;
  try {
    const prints = keys.map(k => {
      const [set, collector, lang] = String(k).split("|");
      const c = set && collector ? moversMpCard({ set, collector, lang: lang || "en" }) : null;
      return { key: String(k), sid: c ? c.id : null, name: c ? c.name : "" };
    });
    out = mpSales.restockFor(prints, names.map(n => ({ key: String(n), name: String(n) })));
    for (const k of Object.keys(out.names)) {
      const e = out.names[k], c = e[4] ? cards.cardById(e[4]) : null;
      e[4] = c ? { set: c.set, collector: c.collector, lang: c.lang || "en", setName: c.setName || "", oracleId: c.oracleId || "" } : null;
    }
  } catch (e) {
    log("[mpSales] restock hints failed: " + e.message);
    out = { prints: {}, names: {}, sales: { error: "Manapool sales couldn't be read just now." } };
  }
  httpu.sendJson(res, 200, out);
});

route("GET", "/api/prices/history", async ({ res, url }) => {
  const key = url.searchParams.get("key") || "";
  if (!key) { httpu.sendError(res, 400, "key is required, e.g. neo|123|en"); return; }
  const vendor = url.searchParams.get("vendor") || "";
  httpu.sendJson(res, 200, await prices.history(key, { vendor }));
});

route("GET", "/api/prices/portfolio", async ({ res, url, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const vendor = url.searchParams.get("vendor") || "";
  httpu.sendJson(res, 200, await prices.portfolio(docOwner, url.searchParams.get("days"), { vendor }));
});

/* Buy List watch list: price stats for an explicit set of printings the
   caller names directly, ownership-independent (unlike movers, which sweeps
   the whole catalog and separately marks what the user owns). */
route("POST", "/api/prices/watch", async ({ req, res }) => {
  const body = await httpu.readJsonBody(req, 65536);
  const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  const out = await prices.watchPrices(items, body.days, { vendor: body.vendor });
  // #369: the "set|collector" of every watched printing that's SELLING FAST
  // on Manapool, the same flag the daily pass notifies on.
  const flags = sellingFastFor(items);
  out.fast = [...new Set(items.filter((x, i) => flags[i] === true).map(x => String(x.set).toLowerCase() + "|" + x.collector))];
  httpu.sendJson(res, 200, out);
});

/* SELLING FAST for each of a list of printings ({ set, collector, lang }),
   same order: true / false, or null when there's too little history to
   compare paces, or no sale or no Manapool match on record (#369: the Buy
   List watch list and the daily pass). Matched the way Movers is
   (moversMpId); mpSales memoises per printing, so this is cheap. Never
   throws: no sales archive means all null. */
function sellingFastFor(items) {
  try {
    const sids = items.map(x => x && x.set && x.collector ? moversMpId({ set: String(x.set), collector: String(x.collector), lang: x.lang || "en" }) : null);
    const { bySid } = mpSales.soldFor(sids);
    return sids.map(sid => { const v = sid ? bySid.get(sid) : null; return v ? v.hot : null; });
  } catch (e) {
    log("[mpSales] SELLING FAST lookup failed: " + e.message);
    return items.map(() => null);
  }
}

route("GET", "/api/prices/status", async ({ res }) => {
  httpu.sendJson(res, 200, await prices.status());
});

/* Selling fast (#202): cards ranked by copies sold on Manapool in the last 7
   days, from our own accumulated sales history (server/lib/mpSales.js).
   Catalog-wide, not per account, so any signed-in user. limit = top N cards
   (default 100, max 500). The response carries its own coverage notes.
   q = a card name search (#231) across every card that sold, not just the
   top N: up to 50 best-selling matches, each with its overall rank.
   offset = skip that many ranked cards first (#233's "Show 500 more"): the
   cards ranked offset+1 .. offset+limit, detail built on demand past the top 500. */
route("GET", "/api/prices/selling-fast", async ({ res, url }) => {
  const q = (url.searchParams.get("q") || "").trim();
  httpu.sendJson(res, 200, q ? mpSales.sellingSearch({ q })
    : mpSales.sellingFast({ limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") }));
});

/* Admin: run today's catalog pull now (background: a ~222MB download and a
   few minutes), and its status. force re-reads a catalog already seen; the
   sale de-duplication makes that harmless. */
route("POST", "/api/admin/selling-fast/refresh", async ({ res }) => {
  if (mpSales.busy()) { httpu.sendError(res, 409, "Already running (" + mpSales.busy() + ")."); return; }
  mpSales.refreshCatalog({ force: true }).catch(e => log("[mpSales] catalog pull failed: " + e.message));
  httpu.sendJson(res, 202, { started: true, note: "Running in the background - poll /api/admin/selling-fast/status." });
}, { admin: true });

route("GET", "/api/admin/selling-fast/status", async ({ res }) => {
  httpu.sendJson(res, 200, mpSales.status());
}, { admin: true });

/* MTGJSON identifier map + 90-day backfill - admin-only, both potentially
   long-running (a 147-229MB compressed streamed download apiece), so these
   kick a background operation off and the client polls status rather than
   holding the HTTP request open. */
route("POST", "/api/admin/mtgjson/refresh-identifiers", async ({ res }) => {
  mtgjson.refreshIdentifiers({ force: true }).catch(e => log("[mtgjson] identifier refresh failed: " + e.message));
  httpu.sendJson(res, 200, { started: true });
}, { admin: true });

route("POST", "/api/admin/mtgjson/backfill", async ({ res }) => {
  if (!mtgjson.status().idsReady) {
    httpu.sendError(res, 400, "Refresh the MTGJSON identifier map first - it hasn't finished building yet.");
    return;
  }
  prices.backfillFromMtgjson().catch(e => log("[mtgjson] backfill failed: " + e.message));
  httpu.sendJson(res, 200, { started: true });
}, { admin: true });

route("GET", "/api/admin/mtgjson/status", async ({ res }) => {
  httpu.sendJson(res, 200, mtgjson.status());
}, { admin: true });

/* ============================== Bulk price schedule ==============================
   The rules themselves and the schedule's on/off/frequency/hour live in the
   collection document (state.priceRules, state.settings.bulkPriceSchedule) and
   round-trip through the ordinary GET/PUT /api/collection like everything
   else. This is just the bookkeeping the *server* keeps about its own
   unattended runs - when one last happened and what it did - plus a way to
   trigger one on demand instead of waiting for the schedule. */
route("GET", "/api/bulk-price/status", async ({ res, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const prefs = await store.readPrefs(docOwner);
  httpu.sendJson(res, 200, prefs.bulkPriceJobs || {});
});

route("POST", "/api/bulk-price/run-now", async ({ res, user, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  let label = user.username;
  if (user.orgId) {
    const s = await orgs.storeById(docOwner.slice("store:".length));
    label = (s && s.name) || docOwner;
  }
  const result = await priceRules.runForUser(docOwner, label);
  await store.updatePrefs(docOwner, prefs => {
    prefs.bulkPriceJobs = Object.assign({}, prefs.bulkPriceJobs || {}, {
      lastRunAt: new Date().toISOString(), lastResult: result, manual: true
    });
  });
  httpu.sendJson(res, 200, result);
});

/* ============================== Friends & sharing ============================== */
/* Sharing is one-way and read-only: you decide, per friend, whether they see a
   summary or the whole list. There is no write path into anybody else's
   collection, by design. Since #140 a friend is someone who accepted a
   friend request (server/lib/friends.js); a personal share counts only
   between friends, and "everyone else on this server" covers the rest. */
async function readSharing(userId) {
  const prefs = await store.readPrefs(userId);
  return {
    friends: Array.isArray(prefs.friends) ? prefs.friends : [],
    defaultShare: prefs.defaultShare || "off",
    prefs
  };
}

/* #128: what an account shares is whichever inventory it acts from - its
   personal collection, or a store for that store's Owners/Managers.
   actFrom.resolve() re-checks the rank on every call, so a share never
   outlives a demotion or an archived store. `s` is readSharing()'s result,
   to save a second prefs read inside the per-account loops. */
async function sharedSource(account, s) {
  return actFrom.resolve(account, s && s.prefs);
}

/* #142: the level `viewer` gets of `owner`'s share. A disabled account
   shares nothing, personal or store: Off for every viewer, whatever its own
   settings say, so it also drops out of everyone's "Shared with me".
   `owner` is a raw account or a listUsers({ withDisabled }) row. #140: a
   personal share counts only between friends; `fdoc` is friends.read(),
   passed in by the routes that loop over accounts so it's read once. */
async function shareLevel(owner, s, viewer, fdoc) {
  if (await actFrom.isDisabled(owner)) return "off";
  return friends.levelBetween(fdoc || await friends.read(), owner, s, viewer);
}
// What a viewer is told about a store-backed share: its name and org,
// never its id.
const storeLabel = src => src && src.kind === "store" ? { name: src.storeName, orgName: src.orgName } : null;

route("GET", "/api/friends", async ({ res, user }) => {
  const s = await readSharing(user.id);
  const all = await auth.listUsers({ withDisabled: true });
  const byName = new Map(all.map(u => [u.username, u]));
  const byId = new Map(all.map(u => [u.id, u]));
  const fdoc = await friends.read();
  // Who has shared with me, so both directions are visible on one page.
  const sharedWithMe = [];
  for (const other of all) {
    if (other.id === user.id) continue;
    const os = await readSharing(other.id);
    const level = await shareLevel(other, os, user, fdoc);
    if (level && level !== "off") {
      const src = await sharedSource(other, os);
      if (!src.owner) continue;
      sharedWithMe.push({ username: other.username, displayName: other.displayName, share: level,
        store: storeLabel(src) });
    }
  }
  // #140: my friends (accepted requests), each with what I set for them
  // (`share`, null when I set nothing, so they get "everyone else") and
  // what they actually see (`sees`); then any sharing-list entry for
  // someone who isn't a friend (an Off left by Unfriend or Stop sharing,
  // or a name with no account), which only ever means Off.
  const mine = friends.friendIds(fdoc, user.id);
  const entryOf = uname => s.friends.find(f => f && f.username === uname) || null;
  const rows = [];
  for (const id of mine) {
    const u = byId.get(id);
    if (!u) continue;
    const e = entryOf(u.username);
    rows.push({ username: u.username, displayName: u.displayName || u.username, exists: true, friend: true,
      share: e && sharing.LEVELS.includes(e.share) ? e.share : null,
      sees: sharing.levelFor(s, u.username, true) });
  }
  for (const e of s.friends) {
    if (!e || typeof e.username !== "string") continue;
    const u = byName.get(e.username);
    if (u && mine.has(u.id)) continue;
    rows.push({ username: e.username, displayName: (u && u.displayName) || e.username, exists: !!u, friend: false,
      share: sharing.LEVELS.includes(e.share) ? e.share : "off", sees: sharing.levelFor(s, e.username, false) });
  }
  rows.sort((a, b) => (b.friend - a.friend) || a.displayName.localeCompare(b.displayName));
  httpu.sendJson(res, 200, {
    friends: rows,
    requests: await friends.requestsFor(user, fdoc, byId),
    defaultShare: s.defaultShare,
    sharedWithMe
    // Deliberately no full-roster "users" list here anymore - it let any
    // signed-in account enumerate every username/display name on the server
    // regardless of any friend relationship. A friend request names a
    // typed-in username exactly (POST /api/friends/requests).
  });
});

/* Sets one person's level (`username` + `share`) and/or the server-wide
   level (`defaultShare`). #140: Summary or Full only for a friend; Off for
   anyone with an account. An unknown name, and a disabled account that
   isn't a friend, get the same "No user named X" as before. */
route("POST", "/api/friends", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 8192);
  let uname = null, isFriend = false, share = null;
  if (body.username) {
    uname = String(body.username).toLowerCase().trim().slice(0, 64);
    if (uname === user.username) { httpu.sendError(res, 400, "That is you."); return; }
    const target = await auth.findUser(uname);
    isFriend = !!target && friends.areFriends(await friends.read(), user.id, target.id);
    if (!target || (target.disabled && !isFriend)) { httpu.sendError(res, 404, "No user named " + uname + " on this server."); return; }
    share = ["off", "summary", "full"].includes(body.share) ? body.share : "summary";
    if (share !== "off" && !isFriend) {
      httpu.sendError(res, 403, "You can share with friends only. Send " + uname + " a friend request first."); return;
    }
  }
  // #139: the person added at Summary/Full who saw nothing before is told.
  // Levels are read inside the same lock as the change.
  let started = null;
  const prefs = await store.updatePrefs(user.id, async prefs => {
    const was = uname ? sharing.levelFor(prefs, uname, isFriend) : "off";
    prefs.friends = Array.isArray(prefs.friends) ? prefs.friends : [];
    if (body.defaultShare != null) prefs.defaultShare = ["off", "summary", "full"].includes(body.defaultShare) ? body.defaultShare : "off";
    if (uname) {
      const ex = prefs.friends.find(f => f.username === uname);
      if (ex) { ex.share = share; }
      else prefs.friends.push({ username: uname, share, addedAt: new Date().toISOString() });
      started = { uname, was, now: sharing.levelFor(prefs, uname, isFriend) };
    }
  });
  if (started) notifyEvents.shareStarted(user, started.uname, started.was, started.now); // fire-and-forget
  httpu.sendJson(res, 200, { ok: true, friends: prefs.friends, defaultShare: prefs.defaultShare || "off" });
});

/* ============================== Friend requests (#140) ==============================
   Send, accept, decline, cancel, unfriend. The rules live in
   server/lib/friends.js (and docs/flows/friend-requests.dot); these routes
   only call it and say who to tell. */
const FRIEND_SENT_TEXT = {
  sent: u => "Friend request sent to " + u + ".",
  pending: u => "You've already asked " + u + ". It's waiting for their answer.",
  friends: u => "You and " + u + " are now friends: they had already asked you.",
  already: u => "You and " + u + " are already friends."
};
route("POST", "/api/friends/requests", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  let r;
  try { r = await friends.send(user, body.username); }
  catch (e) { httpu.sendError(res, e.status || 400, e.message); return; }
  // Fire-and-forget (never throw).
  if (r.status === "sent") notifyEvents.friendRequested(user, r.target);
  if (r.status === "friends") notifyEvents.friendAccepted(user, r.target.id);
  httpu.sendJson(res, 200, { ok: true, status: r.status, message: FRIEND_SENT_TEXT[r.status](r.target.username) });
});

route("POST", "/api/friends/requests/:id/respond", async ({ req, res, user, params }) => {
  const body = await httpu.readJsonBody(req, 1024);
  const action = typeof body.action === "string" ? body.action : "";
  let r;
  try { r = await friends.respond(user, params.id, action); }
  catch (e) { httpu.sendError(res, e.status || 400, e.message); return; }
  const name = r.other ? r.other.username : "them";
  if (r.status === "accepted") notifyEvents.friendAccepted(user, r.request.from);
  else if (r.status === "declined") notifyEvents.friendRequestClosed(r.request.from, user.id);
  else notifyEvents.friendRequestClosed(user.id, r.request.to);
  httpu.sendJson(res, 200, { ok: true, status: r.status, message:
    r.status === "accepted" ? "You and " + name + " are now friends."
      : r.status === "declined" ? "Declined. " + name + " isn't told."
        : "Request to " + name + " cancelled." });
});

route("POST", "/api/friends/unfriend", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  let r;
  try { r = await friends.unfriend(user, body.username); }
  catch (e) { httpu.sendError(res, e.status || 400, e.message); return; }
  httpu.sendJson(res, 200, { ok: true, message: "You and " + r.target.username + " are no longer friends. Neither of you sees the other's collection." });
});

/* "Stop sharing" (#124). Deleting the friend's entry used to drop them back
   to defaultShare ("Everyone else on this server sees"), which could leave
   them with the same access or MORE. So by default this keeps the entry and
   sets it to "off", which beats defaultShare everywhere the level is
   resolved. Only an explicit { forget: true } deletes the entry; the page
   offers that separately and says the person then falls back to the
   server-wide setting. */
route("POST", "/api/friends/remove", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  const uname = typeof body.username === "string" ? body.username.toLowerCase().trim() : "";
  if (!uname) { httpu.sendError(res, 400, "Which friend?"); return; }
  const prefs = await store.updatePrefs(user.id, prefs => {
    prefs.friends = sharing.stopSharing(prefs.friends, uname, { forget: body.forget === true });
  });
  httpu.sendJson(res, 200, { ok: true, friends: prefs.friends, defaultShare: prefs.defaultShare || "off" });
});

/* Bulk "does a friend already own this?" for the Buy List page - one request
   covers every card on screen instead of one GET /api/share/:username per
   friend per card. Only friends sharing at "full" are consulted: "summary"
   only ever exposes a top-15 slice, which can't answer a want-list lookup.
   Response carries per-friend printing detail (set/collector/lang/finish/qty),
   not just a name - the Buy List's "which versions does my friend have"
   popup (2026-09-06 ask) needs that, not just a yes/no. */
route("POST", "/api/friends/have", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 65536);
  const wanted = new Set((Array.isArray(body.oracleIds) ? body.oracleIds : []).slice(0, 2000).filter(Boolean));
  const out = {};
  if (!wanted.size) { httpu.sendJson(res, 200, { data: out }); return; }
  // Same "who shares with ME, and at what level" computation GET /api/friends
  // already does for sharedWithMe - readSharing(user.id) is the wrong
  // direction here, since that's who *I* share *my* collection with.
  const all = await auth.listUsers({ withDisabled: true });
  const fdoc = await friends.read();
  for (const other of all) {
    if (other.id === user.id) continue;
    const os = await readSharing(other.id);
    const level = await shareLevel(other, os, user, fdoc);
    if (level !== "full") continue;
    const src = await sharedSource(other, os);
    if (!src.owner) continue;
    const coll = await store.readCollection(src.owner);
    const list = (coll.state && coll.state.cards) || [];
    let printingsByKey = null;
    for (const c of list) {
      // Copies lent out aren't there to trade (#336).
      const free = priceRules.availableQty(c);
      if (!c.oracleId || !wanted.has(c.oracleId) || !(free > 0)) continue;
      if (!printingsByKey) printingsByKey = new Map();
      const oKey = c.oracleId;
      let byPrint = printingsByKey.get(oKey);
      if (!byPrint) { byPrint = new Map(); printingsByKey.set(oKey, byPrint); }
      const pKey = [c.set, c.collector, c.lang, c.finish].join("|");
      const prev = byPrint.get(pKey);
      if (prev) prev.qty += free;
      else byPrint.set(pKey, { set: c.set, collector: c.collector, lang: c.lang, finish: c.finish, qty: free });
    }
    if (!printingsByKey) continue;
    for (const [oracleId, byPrint] of printingsByKey) {
      (out[oracleId] || (out[oracleId] = [])).push({ username: other.username, store: storeLabel(src), printings: [...byPrint.values()] });
    }
  }
  httpu.sendJson(res, 200, { data: out });
});

/* One friend's watch list - the Buy List's "Offer trade" suggestion
   (2026-09-06 ask) needs to know what a specific friend actually wants, not
   just whether they own the card being viewed. Same "full" share gate as
   /api/friends/have, since a watch list is less sensitive than the whole
   collection that gate already exposes. */
route("POST", "/api/friends/watchlist", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  const uname = String(body.username || "").toLowerCase().trim();
  const other = uname ? await auth.findUser(uname) : null;
  if (!other) { httpu.sendError(res, 404, "No such user."); return; }
  const os = await readSharing(other.id);
  const level = await shareLevel(other, os, user);
  if (level !== "full") { httpu.sendJson(res, 200, { data: [] }); return; }
  const src = await sharedSource(other, os);
  if (!src.owner) { httpu.sendJson(res, 200, { data: [] }); return; }
  const coll = await store.readCollection(src.owner);
  const list = (coll.state && coll.state.watchList) || [];
  httpu.sendJson(res, 200, { store: storeLabel(src), data: list.map(w => ({
    oracleId: w.oracleId || null, name: w.name, set: w.set, collector: w.collector, lang: w.lang,
    finish: w.finish, setName: w.setName
  })) });
});

/* A friend's full priced, owned collection - the Buy List's "Offer trade"
   (2026-09-06 ask: filler can come from EITHER side of a trade, not just
   the person proposing it) needs this to pick filler from the other
   person's stock when their side of the trade needs padding, not just
   the proposer's. Same "full" share gate as /have and /watchlist above -
   a filler pool is no more sensitive than the whole collection that level
   already exposes wholesale. */
route("POST", "/api/friends/collection", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  const uname = String(body.username || "").toLowerCase().trim();
  const other = uname ? await auth.findUser(uname) : null;
  if (!other) { httpu.sendError(res, 404, "No such user."); return; }
  const os = await readSharing(other.id);
  const level = await shareLevel(other, os, user);
  if (level !== "full") { httpu.sendJson(res, 200, { data: [] }); return; }
  const src = await sharedSource(other, os);
  if (!src.owner) { httpu.sendJson(res, 200, { data: [] }); return; }
  const coll = await store.readCollection(src.owner);
  httpu.sendJson(res, 200, { store: storeLabel(src), data: tradePool((coll.state && coll.state.cards) || []) });
});

/* The fields a trade line can be built from: priced, owned stacks only,
   never location, cost basis or notes. Shared by a friend's pool above and
   my own pool below. */
function tradePool(list) {
  return list
    .filter(c => priceRules.availableQty(c) > 0 && c.price > 0)   // a lent copy isn't there to offer (#336)
    .map(c => ({
      oracleId: c.oracleId || null, name: c.name, set: c.set, collector: c.collector, lang: c.lang,
      finish: c.finish, setName: c.setName, price: c.price, quantity: priceRules.availableQty(c),
      edhrecRank: c.edhrecRank == null ? null : c.edhrecRank, imageUrl: c.imageUrl || ""
    }));
}

/* ============================== Share and trade from (#128) ==============================
   Which inventory this account's sharing and trades use. GET says what it
   is now and what may be picked; POST changes it. A store is offered, and
   accepted, only for its Owners/Managers (actFrom.storeChoiceProblem).
   #147: personalCards (an Owner/Manager's personal card count, for the
   picker label and the "your personal cards are empty" offer; null for
   anyone who can't pick a store) and notice (why a saved store choice was
   cleared, until dismissed or a new pick; read after resolve(), which may
   have just cleared one). */
async function actFromView(user) {
  const cur = await actFrom.resolve(user);
  const canChooseStore = !!user.orgId && orgs.isOrgManager(user);
  return {
    current: { kind: cur.kind, storeId: cur.storeId, storeName: cur.storeName, orgName: cur.orgName },
    stores: await actFrom.choices(user),
    inOrg: !!user.orgId,
    canChooseStore,
    personalCards: canChooseStore ? await actFrom.personalCardCount(user.id) : null,
    notice: await actFrom.clearedNotice(user.id)
  };
}
route("GET", "/api/sharing/act-from", async ({ res, user }) => {
  httpu.sendJson(res, 200, await actFromView(user));
});
route("POST", "/api/sharing/act-from", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024);
  try { await actFrom.choose(user, body.storeId); }
  catch (e) { httpu.sendError(res, e.status || 400, e.message); return; }
  httpu.sendJson(res, 200, await actFromView(user));
});
// #147: the person has read the "you're back on your personal cards" note.
route("POST", "/api/sharing/act-from/dismiss", async ({ res, user }) => {
  await actFrom.dismissClearedNotice(user.id);
  httpu.sendJson(res, 200, { ok: true });
});

/* The trade composer's "You give" pool: the inventory this account acts
   from, re-resolved here rather than taken from whichever store the page
   has open, so the composer offers exactly what friends are shown.
   #147: also what the composer needs to say WHY the pool is empty and to
   offer a store: personalCards (counted from the file already read, when
   acting from personal), whether a store may be picked and which, and the
   cleared-choice notice. */
route("GET", "/api/trades/my-pool", async ({ res, user }) => {
  const src = await actFrom.resolve(user);
  const coll = await store.readCollection(src.owner);
  const cards = (coll.state && coll.state.cards) || [];
  const canChooseStore = !!user.orgId && orgs.isOrgManager(user);
  httpu.sendJson(res, 200, {
    actFrom: { kind: src.kind, storeId: src.storeId, storeName: src.storeName, orgName: src.orgName },
    data: tradePool(cards),
    personalCards: src.kind === "personal" ? actFrom.countCards(cards) : null,
    canChooseStore,
    stores: canChooseStore ? await actFrom.choices(user) : [],
    notice: await actFrom.clearedNotice(user.id)
  });
});

/* ============================== Trade proposals ==============================
   A trade proposal is its own mailbox-like record, never part of either
   account's collection document - same reasoning as support tickets
   (server/lib/store.js) having their own file rather than living inside a
   user's data. This is the first user-to-user WRITE this app has ever had
   (Friends sharing up to here is deliberately one-way and read-only,
   README §11) - kept safe by being additive-only and outside anyone's
   actual collection: proposing or responding to a trade never touches
   either side's real inventory, cost basis, or anything else that
   matters. Grimoire still has no way to actually execute a trade - this
   is a real, visible handoff between two accounts, not an automatic
   exchange of cards. */
/* Every sender-controlled line field is coerced to a bounded string,
   number or null by server/lib/trades.js (#125); see its header for why. */
const sanitizeTradeLines = trades.sanitizeTradeLines;

route("POST", "/api/trades/propose", async ({ req, res, user }) => {
  // 64 KB, so a full 50 + 50 offer fits (#137). Other routes keep theirs.
  const body = await httpu.readJsonBody(req, trades.PROPOSE_BODY_LIMIT);
  const uname = (trades.safeStr(body.toUsername, 64) || "").toLowerCase();
  if (uname === user.username) { httpu.sendError(res, 400, "That is you."); return; }
  const target = uname ? await auth.findUser(uname) : null;
  // A disabled account takes no offers, and is told apart from an unknown
  // name nowhere (#142).
  const noTarget = actFrom.recipientProblem(target);
  if (noTarget) { httpu.sendError(res, 404, noTarget); return; }
  const offering = sanitizeTradeLines(body.offering);
  const requesting = sanitizeTradeLines(body.requesting);
  if (!offering.length || !requesting.length) {
    httpu.sendError(res, 400, "A trade needs at least one card on each side."); return;
  }
  // #128: both sides' stores are worked out here from each account's
  // current, re-checked choice. The page says which inventory its "You
  // give" lines came from (fromStoreId); it must match, and a store this
  // account can't act from is refused outright. Any toStoreId in the body
  // is ignored: the recipient's side is never the sender's to say.
  const from = await actFrom.resolve(user);
  const claimed = body.fromStoreId == null || body.fromStoreId === "" ? null : trades.safeStr(body.fromStoreId, 64);
  if (claimed !== from.storeId) {
    if (claimed && await actFrom.storeChoiceProblem(user, claimed)) {
      httpu.sendError(res, 403, "You can't trade from that store."); return;
    }
    httpu.sendError(res, 409, "You now trade from " + (from.storeName || "your personal cards") +
      ". Close this offer and start it again."); return;
  }
  const to = await actFrom.resolve(target);
  const pairProblem = await actFrom.proposalProblem(user, from, target, to);
  if (pairProblem) { httpu.sendError(res, 400, pairProblem); return; }
  const now = new Date().toISOString();
  const proposal = {
    id: httpu.randomId(12),
    fromUserId: user.id, fromUsername: user.username,
    toUserId: target.id, toUsername: target.username,
    fromStoreId: from.storeId, fromStoreName: from.storeName,
    toStoreId: to.storeId, toStoreName: to.storeName,
    // Whether the sender could see the recipient's share when sending. If
    // not, the sender is never told the offer landed with a store.
    toStoreShown: !!to.storeId && await shareLevel(target, await readSharing(target.id), user) !== "off",
    offering, requesting,
    note: trades.safeStr(body.note, 1000) || "",
    status: "open",
    createdAt: now, updatedAt: now
  };
  // Re-checked inside the lock: archive's withdraw sweep takes this same
  // lock, so an offer resolved just before an archive can't land after
  // the sweep as an open offer to or from an archived store.
  let archived = null;
  await store.updateTradeProposals(async db => {
    archived = await actFrom.archivedSideProblem(from, to);
    if (!archived) db.proposals.push(proposal);
  });
  if (archived) { httpu.sendError(res, 409, archived); return; }
  notifyEvents.tradeProposed(proposal); // #139, fire-and-forget (never throws)
  httpu.sendJson(res, 200, { proposal: actFrom.viewerCopy(proposal, user, await actFrom.managedStoreIds(user)) });
});

/* Everything sent by or addressed to me - one inbox-shaped list rather
   than separate sent/received endpoints, same as how Friends already
   folds "who shares with me" and "who I share with" into one response. */
route("GET", "/api/trades", async ({ res, user }) => {
  const db = await store.readTradeProposals();
  // Mine: sent by or to me, or from / to a store I manage (#128; the
  // managed set is worked out now, so a lost rank shows at once).
  // Cleaned on the way out as well (#125), so a proposal stored before the
  // inbound sanitising can't hand the page an object where it expects text.
  const managed = await actFrom.managedStoreIds(user);
  // Cheap id test first, so only this viewer's proposals get cleaned: the
  // file holds everyone's trade history.
  const mine = [];
  for (const p of db.proposals) {
    if (!actFrom.concernsViewer(p, user, managed)) continue;
    const v = actFrom.viewerCopy(p, user, managed);
    if (v.incoming || v.outgoing) mine.push(v);
  }
  mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  httpu.sendJson(res, 200, { data: mine });
});

/* Accept / decline (the recipient, or any Owner/Manager of the store it was
   sent to) and withdraw (the sender of a personal offer, or any
   Owner/Manager of the store it was sent from). actFrom.proposalRoles
   decides, against ranks re-read for this request; the status itself
   changes only in trades.changeStatus. */
route("POST", "/api/trades/:id/respond", async ({ req, res, user, params }) => {
  const body = await httpu.readJsonBody(req, 1024);
  const status = typeof body.status === "string" ? body.status : "";
  const managed = await actFrom.managedStoreIds(user);
  let denied = false, notFound = false;
  const p = await store.updateTradeProposals(db => {
    const p = db.proposals.find(x => x && x.id === params.id);
    if (!p) { notFound = true; return null; }
    // Roles come from the cleaned copy, so a damaged record can't smuggle
    // an object into an id comparison. A status the page doesn't recognise
    // reads as Open, so the recipient of a damaged record can still
    // decline it.
    const roles = actFrom.proposalRoles(trades.sanitizeProposal(p), user, managed);
    const allowed = status === "withdrawn" ? roles.canWithdraw
      : status === "accepted" || status === "declined" ? roles.canRespond : false;
    if (!allowed) { denied = true; return null; }
    return trades.changeStatus(p, status, { id: user.id, username: user.username }, null);
  });
  if (notFound) { httpu.sendError(res, 404, "No such trade proposal."); return; }
  if (denied || !p) { httpu.sendError(res, 403, "You can't do that to this proposal."); return; }
  httpu.sendJson(res, 200, { proposal: actFrom.viewerCopy(p, user, managed) });
});

route("GET", "/api/share/:username", async ({ res, params, user }) => {
  const owner = await auth.findUser(params.username);
  // Same message and status whether the account doesn't exist or exists but
  // isn't sharing - both mean "nothing to see here" to the requester, and
  // distinguishing them just hands out a free way to enumerate every
  // username on the server.
  const NOTHING_SHARED = () => { httpu.sendError(res, 403, "That user isn't sharing a collection with you."); };
  if (!owner) { NOTHING_SHARED(); return; }
  const s = await readSharing(owner.id);
  const level = owner.id === user.id ? "full" : await shareLevel(owner, s, user);
  if (!level || level === "off") { NOTHING_SHARED(); return; }

  const src = await sharedSource(owner, s);
  if (!src.owner) { NOTHING_SHARED(); return; }
  const coll = await store.readCollection(src.owner);
  const st = coll.state || { cards: [], locations: [] };
  const list = st.cards || [];
  const value = list.reduce((sum, c) => sum + (c.price == null ? 0 : c.price * (Number(c.quantity) || 0)), 0);
  const summary = {
    username: owner.username,
    displayName: owner.displayName || owner.username,
    store: storeLabel(src),
    level,
    savedAt: coll.savedAt,
    stacks: list.length,
    cards: list.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0),
    distinctNames: new Set(list.map(c => String(c.name || "").toLowerCase())).size,
    totalValue: value,
    listedForSale: list.reduce((sum, c) => sum + (Number(c.listedQty) || 0), 0),
    top: sharing.summaryTop(list)
      .map(c => ({
        name: c.name, set: c.set, collector: c.collector, finish: c.finish || (c.foil ? "foil" : "nonfoil"),
        quantity: c.quantity, price: c.price
      }))
  };
  if (level !== "full") { httpu.sendJson(res, 200, { summary }); return; }
  // Full share is the card list only. Locations, cost basis, audit trail, pick
  // lists and orders are never shared - they are nobody else's business.
  httpu.sendJson(res, 200, {
    summary,
    cards: list.map(c => ({
      name: c.name, set: c.set, setName: c.setName, collector: c.collector, lang: c.lang,
      finish: c.finish || (c.foil ? "foil" : "nonfoil"), rarity: c.rarity, quantity: c.quantity, listedQty: c.listedQty || 0,
      price: c.price, scryfallId: c.scryfallId || "", imageUrl: c.imageUrl || "", oracleId: c.oracleId || ""
    }))
  });
});

/* ============================== Integrations (per-account credentials) ==============================
   Manapool/Pitney Bowes credentials live in each user's prefs.json (store.js
   readPrefs/writePrefs) - never in the collection document, so they can't round
   trip to the browser via GET /api/collection, an export or a friend share. */
route("GET", "/api/integrations", async ({ res, user }) => {
  const p = await store.readPrefs(user.id);
  const pbc = p.pitneyBowes || {};
  httpu.sendJson(res, 200, {
    // Facts about the Mana Pool connection, never a token (mpAuth.status).
    manapool: mpAuth.status(p),
    pitneyBowes: {
      featureOn: integrations.shippingEnabled(), shipperId: pbc.shipperId || "",
      hasKey: !!pbc.apiKey, hasSecret: !!pbc.apiSecret
    }
  });
});

/* Mana Pool sign-in (#499, server/lib/mpAuth.js). There is no paste-a-token
   route any more: Connect sends the seller to Mana Pool's consent page, and
   Mana Pool sends them back to the callback with a one-time code. */
route("POST", "/api/manapool/oauth/start", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 1024).catch(() => ({}));
  httpu.sendJson(res, 200, { url: await mpAuth.startUrl(user.id, { withoutInventory: !!(body && body.withoutInventory) }) });
});

// Open so a signed-out visit lands on the sign-in page, not a JSON error.
// Must match the redirect URI registered with Mana Pool exactly.
route("GET", mpAuth.CALLBACK_PATH, async ({ req, res, url }) => {
  const user = await auth.userFromRequest(req, CFG);
  if (!user) { httpu.redirect(res, "/login.html?next=" + encodeURIComponent("/settings.html#tab=integrations")); return; }
  const out = await mpAuth.finish(user.id, url.searchParams);
  log("manapool connect by " + user.username + ": " + out.result);
  httpu.redirect(res, out.redirect);
}, { open: true });

route("POST", "/api/manapool/oauth/disconnect", async ({ res, user }) => {
  httpu.sendJson(res, 200, await mpAuth.disconnect(user.id));
});

/* Grimoire's own Mana Pool app registration (#499): admin-only, same "blank
   keeps the saved secret, never echo it back" shape as /api/admin/github. */
route("GET", "/api/admin/manapool-app", async ({ res }) => {
  await mpAuth.load();
  httpu.sendJson(res, 200, Object.assign({ featureOn: integrations.manapoolEnabled() }, mpAuth.appStatus()));
}, { admin: true });

route("POST", "/api/admin/manapool-app", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  await mpAuth.saveApp({ clientId: body.clientId, clientSecret: body.clientSecret });
  log("Mana Pool app credentials saved by " + user.username);
  httpu.sendJson(res, 200, { ok: true });
}, { admin: true });

route("POST", "/api/integrations/pitneybowes", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 4096);
  await store.updatePrefs(user.id, p => {
    const cur = p.pitneyBowes || {};
    p.pitneyBowes = {
      shipperId: body.shipperId != null ? String(body.shipperId).trim() : (cur.shipperId || ""),
      apiKey: body.apiKey ? String(body.apiKey).trim() : (cur.apiKey || ""),
      apiSecret: body.apiSecret ? String(body.apiSecret).trim() : (cur.apiSecret || "")
    };
  });
  httpu.sendJson(res, 200, { ok: true });
});

/* ============================== Manapool ============================== */
route("GET", "/api/manapool/status", async ({ res, user }) => {
  const p = await store.readPrefs(user.id);
  httpu.sendJson(res, 200, await integrations.manapoolStatus(mpAuth.credsFromPrefs(user.id, p)));
});

route("GET", "/api/manapool/orders", async ({ res, url, user }) => {
  const p = await store.readPrefs(user.id);
  const cached = await store.readOrders(user.id);
  // Incremental by default: ask Manapool for orders placed since the newest
  // one already cached (the cache is kept sorted newest-first below), so a
  // routine refresh only has to page through however many orders are
  // genuinely new - not a seller's entire history every time. A first-ever
  // fetch for this account (nothing cached yet) has no anchor to give, so it
  // pages back through full history instead - bounded, see
  // integrations.manapoolOrders()'s own page cap.
  const since = url.searchParams.get("since") || (cached.orders && cached.orders[0] && cached.orders[0].placedAt) || undefined;
  // `since` only ever surfaces orders PLACED after the anchor - it can never
  // tell us an already-cached order's status changed (still "unfulfilled"
  // forever from this call's point of view, even after it actually ships)
  // or backfill its shipping address (the list endpoint never carries one at
  // all - see manapoolOrderDetails). needs_shipping re-lists every order
  // still open regardless of placement date, so a routine "Fetch orders"
  // click catches those up too, not just genuinely-new orders. Reported live
  // symptom this fixes: pressing Fetch orders never changed an order's
  // status, only opening it (which always hits the single-order endpoint)
  // did; and the Ship-to column showed just the "US" default until clicked.
  const [newOrders, openOrders] = await Promise.all([
    integrations.manapoolOrders(mpAuth.credsFromPrefs(user.id, p), {
      status: url.searchParams.get("status") || undefined,
      since
    }),
    integrations.manapoolOrders(mpAuth.credsFromPrefs(user.id, p), { needs_shipping: "true" })
  ]);
  // Manapool's needs_shipping=true above catches an unfulfilled/processing
  // order that's still open BY THEIR reckoning - but the moment an order
  // actually ships, it no longer needs shipping and silently drops out of
  // that list on the very next call. Our own cache doesn't know that yet, so
  // without this it would keep showing the order as unfulfilled/processing
  // forever, and only opening it by hand (the single-order endpoint, always
  // fresh) would ever catch the ship. Re-check every order OUR cache still
  // considers unshipped too, unioned with whatever Manapool's live filter
  // returns - reported live symptom this fixes: Fetch orders picked up an
  // unfulfilled -> processing move (needs_shipping still true for both) but
  // never processing -> shipped. Finished orders (delivered, refunded, ...)
  // whose details are already cached are left alone (#93): see
  // integrations.ordersToRecheck.
  const openIds = integrations.ordersToRecheck(cached.orders, openOrders);
  const openOrdersById = new Map(openOrders.map(o => [o.id, o]));
  const cachedById = new Map((cached.orders || []).map(o => [o.id, o]));
  // Full detail (lines, buyer, real ship-to address) for the still-open set -
  // the operationally relevant orders for this page - fetched here so the
  // table has a real address up front instead of just "US" until someone
  // opens each order individually. Bounded to however many orders are
  // actually awaiting shipment (by either reckoning above), not the
  // seller's whole history.
  const details = await integrations.manapoolOrderDetails(mpAuth.credsFromPrefs(user.id, p), [...openIds]);
  const live = [
    ...newOrders,
    ...[...openIds].map(id => details.get(id) || openOrdersById.get(id) || cachedById.get(id)).filter(Boolean)
  ];
  // Cache them per user so a picklist can be rebuilt (and a label reprinted)
  // without another round trip. Respond with the full merged set, not just
  // this fetch's (usually small, incremental) batch - the browser replaces
  // its whole orders list with the response, so returning only `live` here
  // would make every previously-seen order not touched by this refresh
  // vanish from the table.
  const merged = await store.updateOrders(user.id, store0 => {
    const byId = new Map((store0.orders || []).map(o => [o.id, o]));
    for (const o of live) {
      const stamp = { fetchedAt: new Date().toISOString() };
      // A full detail with no payment breakdown isn't re-asked for on every
      // refresh (#452, integrations.ordersToRecheck).
      if (details.get(o.id) === o) stamp.paymentUnavailable = !o.payment;
      byId.set(o.id, Object.assign({}, byId.get(o.id) || {}, o, stamp));
    }
    store0.orders = [...byId.values()].sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt))).slice(0, 500);
    return store0.orders;
  });
  httpu.sendJson(res, 200, { orders: merged });
});

route("GET", "/api/manapool/orders/cached", async ({ res, user }) => {
  httpu.sendJson(res, 200, await store.readOrders(user.id));
});

/* Live, not cached - unlike orders there's no buyer PII to keep server-side,
   so this is a plain passthrough each time, same as manapoolStatus. */
route("GET", "/api/manapool/listings", async ({ res, user }) => {
  const p = await store.readPrefs(user.id);
  httpu.sendJson(res, 200, { listings: await integrations.manapoolInventory(mpAuth.credsFromPrefs(user.id, p), {}) });
});

route("GET", "/api/manapool/order/:id", async ({ res, params, user }) => {
  const p = await store.readPrefs(user.id);
  const order = await integrations.manapoolOrder(mpAuth.credsFromPrefs(user.id, p), params.id);
  await store.updateOrders(user.id, doc => {
    const i = doc.orders.findIndex(o => o.id === order.id);
    if (i >= 0) doc.orders[i] = Object.assign({}, doc.orders[i], order);
    else doc.orders.unshift(order);
  });
  httpu.sendJson(res, 200, { order });
});

route("POST", "/api/manapool/list", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 65536);
  if (!body.card) { httpu.sendError(res, 400, "Send {card, quantity, price, condition}."); return; }
  const p = await store.readPrefs(user.id);
  httpu.sendJson(res, 200, await integrations.manapoolList(mpAuth.credsFromPrefs(user.id, p), body.card, body));
});

/* Bulk version of the above - accepts a "list these cards" request of any
   size ({items: [{card, quantity, price, condition}, ...]}) and internally
   loops it through Manapool in batches, verifying each batch before moving
   to the next (see manapoolListBulk). Response lines up 1:1 with the
   request's items, plus a summary so a caller doesn't have to count. */
route("POST", "/api/manapool/list-bulk", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req);
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || !items.length) { httpu.sendError(res, 400, "Send {items: [{card, quantity, price, condition}, ...]}."); return; }
  for (const it of items) {
    if (!it || !it.card) { httpu.sendError(res, 400, "Every item needs a {card, quantity, price, condition}."); return; }
  }
  const p = await store.readPrefs(user.id);
  const results = await integrations.manapoolListBulk(mpAuth.credsFromPrefs(user.id, p), items);
  const succeeded = results.filter(r => r.ok).length;
  httpu.sendJson(res, 200, { results, succeeded, failed: results.length - succeeded });
});

/* Sealed's counterpart to /api/manapool/list-bulk above - a separate route
   rather than a branch in the same one, since the request/identity shape
   genuinely differs (product_id, not a card) - see
   integrations.manapoolListBulkSealed. */
route("POST", "/api/manapool/list-bulk-sealed", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req);
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || !items.length) { httpu.sendError(res, 400, "Send {items: [{item, quantity, price}, ...]}."); return; }
  for (const it of items) {
    if (!it || !it.item) { httpu.sendError(res, 400, "Every item needs a {item, quantity, price}."); return; }
  }
  const p = await store.readPrefs(user.id);
  const results = await integrations.manapoolListBulkSealed(mpAuth.credsFromPrefs(user.id, p), items);
  const succeeded = results.filter(r => r.ok).length;
  httpu.sendJson(res, 200, { results, succeeded, failed: results.length - succeeded });
});

/* An Order Entry order went in or was cancelled (#432): lower (or raise
   again) its cards' Manapool listings, quantity only, through the
   connection of the account that owns this inventory (owner, 2026-11-07),
   so a Staff login updates the store's listings. Body { event:
   "entered"|"cancelled", ticketId, createdAt, owner }. The cards and copies
   come from that ticket as saved in the caller's own inventory (docOwner:
   membership and Staff storeIds already checked), never from the request;
   see server/lib/orderEntryListing.js. The order itself is already saved, so
   this never fails it: each card reports its own result, and the owning
   account having no connection answers { connected: false }. The kiosk's
   server-side submit and cancel (#433) call orderEntrySync too. */
route("POST", "/api/manapool/order-entry-sync", async ({ req, res, user, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  const body = await httpu.readJsonBody(req, 4096);
  if (store.ownerMismatch(body.owner, docOwner)) { await wrongOwnerReply(res, user, body.owner, "Manapool wasn't updated"); return; }
  const createdAt = typeof body.createdAt === "string" ? body.createdAt.slice(0, 40) : null;
  httpu.sendJson(res, 200, await orderEntryListing.orderEntrySync(docOwner, body.event, body.ticketId, createdAt));
});

/* The Manapool orders already fetched for this inventory, whoever fetched
   them (#433, owner 2026-11-08): Walk-in Order holds their copies as soon as
   an order is fetched, before its pick list is made, the same as the kiosk
   does server-side. A Staff login has no orders cache of its own, so this
   reads the one of the account the inventory sells through. Card lines and
   status only: no buyer, address or money. */
route("GET", "/api/order-entry/fetched-orders", async ({ res, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  httpu.sendJson(res, 200, { orders: (await orderEntryListing.fetchedOrders(docOwner)).orders });
});

/* ============================== The store's kiosk (#433) ==============================
   server/lib/kiosk.js. The Kiosk page (a Manager or Owner, or a personal
   account) sets the staff PIN, switches the device it's on into kiosk mode
   and ends kiosks. The kiosk screen itself reaches only the four routes
   marked { kiosk: true } below; handle() refuses it everywhere else, and
   refuses those four to anyone who isn't a kiosk. */
async function kioskManager(user, docOwner, res) {
  if (!requireDocOwner(docOwner, res)) return false;
  if (await kioskLib.canRun(user, docOwner)) return true;
  httpu.sendError(res, 403, "Only a store manager or owner can set up the kiosk.");
  return false;
}

route("GET", "/api/kiosk/setup", async ({ res, user, docOwner }) => {
  if (!(await kioskManager(user, docOwner, res))) return;
  httpu.sendJson(res, 200, {
    storeName: await kioskLib.inventoryName(docOwner),
    pinSet: await kioskLib.hasPin(docOwner),
    kiosks: await kioskLib.listSessions(docOwner),
    limits: await kioskLib.limits(docOwner)
  });
});

route("POST", "/api/kiosk/pin", async ({ req, res, user, docOwner }) => {
  if (!(await kioskManager(user, docOwner, res))) return;
  const body = await httpu.readJsonBody(req, 4096);
  await kioskLib.setPin(docOwner, body.pin, user);
  log("kiosk PIN set by " + auth.logName(user.username) + " for " + (await kioskLib.pinOwner(docOwner)));
  httpu.sendJson(res, 200, { ok: true });
});

/* The account's kiosk limits (owner, 2026-11-08): most cards in one order
   and most orders waiting per store. Body { maxCards, maxWaiting }: a whole
   number of 1 or more, or blank / null for no limit. */
route("POST", "/api/kiosk/limits", async ({ req, res, user, docOwner }) => {
  if (!(await kioskManager(user, docOwner, res))) return;
  const body = await httpu.readJsonBody(req, 4096);
  const limits = await kioskLib.setLimits(docOwner, body, user);
  log("kiosk limits set by " + auth.logName(user.username) + " for " + (await kioskLib.pinOwner(docOwner)) + ": " + JSON.stringify(limits));
  httpu.sendJson(res, 200, { ok: true, limits });
});

/* Switches THIS device into kiosk mode: the caller's own session ends here
   and now (the public never gets it back, owner's answer on #402), and the
   kiosk cookie takes its place. body.owner: the inventory the page loaded,
   so a store switched in another tab can't put the wrong store's stock on
   the kiosk. */
route("POST", "/api/kiosk/start", async ({ req, res, user, docOwner }) => {
  if (!(await kioskManager(user, docOwner, res))) return;
  const body = await httpu.readJsonBody(req, 4096);
  if (typeof body.owner !== "string") { httpu.sendError(res, 400, "Reload the page and try again."); return; }
  if (store.ownerMismatch(body.owner, docOwner)) { await wrongOwnerReply(res, user, body.owner, "The kiosk wasn't started"); return; }
  if (!(await kioskLib.hasPin(docOwner))) { httpu.sendError(res, 409, "Set the staff PIN first: it's what takes this screen out of kiosk mode."); return; }
  const k = await kioskLib.startSession(user, docOwner, CFG, req);
  await auth.destroySession(user.__sid);
  log("kiosk started by " + auth.logName(user.username) + " on " + docOwner + " (" + k.id + ")");
  httpu.sendJson(res, 200, { ok: true, id: k.id },
    { "Set-Cookie": [auth.clearCookie(CFG, req), kioskLib.cookie(k.sid, CFG, k.days, req)] });
});

route("POST", "/api/kiosk/:id/end", async ({ res, user, docOwner, params }) => {
  if (!(await kioskManager(user, docOwner, res))) return;
  if (!(await kioskLib.endSessionById(docOwner, params.id))) { httpu.sendError(res, 404, "That kiosk has already ended."); return; }
  log("kiosk " + params.id + " ended by " + auth.logName(user.username));
  httpu.sendJson(res, 200, { ok: true });
});

// The kiosk screen's own routes. docOwner is the kiosk's store (handle()).
route("GET", "/api/kiosk/info", async ({ res, kiosk }) => {
  // maxCards: the account's most cards per order (null = no limit), so the screen can say so before sending.
  httpu.sendJson(res, 200, { storeName: await kioskLib.inventoryName(kiosk.ownerKey), maxCards: (await kioskLib.limits(kiosk.ownerKey)).maxCards });
}, { kiosk: true });

/* Search and browse (#438): q may be empty (the whole offer, a page at a
   time); set / colors / type / rarity / min / max narrow it, page pages it,
   facets=1 and popular=1 add the filter choices and the Popular row
   (kioskLib.filtersFrom). The customer's fields only, plus a "popular" flag. */
route("GET", "/api/kiosk/search", async ({ res, url, kiosk }) => {
  httpu.sendJson(res, 200, await kioskLib.search(kiosk.ownerKey, url.searchParams.get("q") || "", kioskLib.filtersFrom(url.searchParams)));
}, { kiosk: true });

/* The customer sends their order: written as an open ticket under the
   inventory's lock (the copies are set aside at once) and answered. Then
   Manapool comes down (part 2's sync, through the store owner's
   connection) and the people who work there are told. A Manapool failure
   never undoes the order: it goes on the ticket as a warning for staff. */
route("POST", "/api/kiosk/order", async ({ req, res, kiosk }) => {
  // No cap on an order's size (owner, 2026-11-08); 1 MB is only a request-size guard (~15k different cards).
  const body = await httpu.readJsonBody(req, 1048576);
  let ticket;
  try {
    ({ ticket } = await kioskLib.placeOrder(kiosk.ownerKey, body));
  } catch (e) {
    // Which field to fix, or what's left of each card that sold out, for the screen to show.
    if (typeof e.status === "number" && (e.field || e.short)) { httpu.sendJson(res, e.status, { error: e.message, field: e.field, short: e.short }); return; }
    throw e;
  }
  httpu.sendJson(res, 200, kioskLib.receipt(ticket));
  log("kiosk order " + ticket.id + " on " + kiosk.ownerKey + " (" + kiosk.id + ")");
  (async () => {
    let warning = "";
    try {
      warning = kioskLib.listingWarning(await orderEntryListing.orderEntrySync(kiosk.ownerKey, "entered", ticket.id, ticket.createdAt));
    } catch (e) {
      warning = kioskLib.listingWarning({ connected: true, results: ticket.lines.map(card => ({ card, ok: false })) });
      log("kiosk order " + ticket.id + ": Manapool not updated - " + e.message);
    }
    await kioskLib.noteListingWarning(kiosk.ownerKey, ticket, warning);
    await notifyEvents.kioskOrderPlaced(kiosk.ownerKey, ticket);
  })().catch(e => log("kiosk order " + ticket.id + " follow-up failed - " + (e.stack || e.message)));
}, { kiosk: true });

/* Leaving kiosk mode takes the staff PIN, throttled like sign-in (per
   device and per address), and ends at the sign-in page: never back in the
   account that started it. */
route("POST", "/api/kiosk/exit", async ({ req, res, kiosk }) => {
  const body = await httpu.readJsonBody(req, 4096);
  const keys = ["kiosk-ip:" + httpu.clientIp(req, CFG), "kiosk:" + kiosk.id];
  const wait = lockedFor(keys);
  if (wait) {
    httpu.sendJson(res, 429, { error: "Too many wrong PINs. Try again in " + Math.ceil(wait / 60) + " minute(s)." }, { "Retry-After": String(wait) });
    return;
  }
  if (!(await kioskLib.checkPin(kiosk.ownerKey, body.pin))) {
    noteFailure(keys);
    await new Promise(r => setTimeout(r, 250));
    httpu.sendError(res, 403, "That PIN isn't right.");
    return;
  }
  clearFailures(keys);
  await kioskLib.endSession(kiosk.key);
  log("kiosk " + kiosk.id + " left with the staff PIN");
  httpu.sendJson(res, 200, { ok: true }, { "Set-Cookie": kioskLib.clearCookie(CFG, req) });
}, { kiosk: true });

route("POST", "/api/manapool/order/:id/shipped", async ({ req, res, params, user }) => {
  const body = await httpu.readJsonBody(req, 8192).catch(() => ({}));
  const o = await store.updateOrders(user.id, doc => {
    const o = doc.orders.find(x => x.id === params.id);
    if (!o) return null;
    if (orderShip.orderWasCancelled(o.status)) return { cancelled: o.status };   // #489: never shipped
    o.grimoire = Object.assign({}, o.grimoire, {
      shippedAt: new Date().toISOString(),
      tracking: body.tracking || (o.grimoire && o.grimoire.tracking) || "",
      note: body.note || ""
    });
    return o;
  });
  if (!o) { httpu.sendError(res, 404, "That order is not in the local cache - fetch it first."); return; }
  if (o.cancelled) {
    httpu.sendError(res, 409, "Manapool has this order as " + orderShip.cancelledWord(o.cancelled) + ", so it can't be marked shipped.");
    return;
  }
  httpu.sendJson(res, 200, { ok: true, order: o });
});

/* Orders Manapool replaced, cancelled or refunded (#489), as [{ id, status }]
   from the orders caches of everyone working this inventory (the same ones
   the ship call below reads), so the desk and Warehouse Mode can flag their
   tickets. Ids and statuses only. */
route("GET", "/api/manapool/cancelled-orders", async ({ res, user, docOwner }) => {
  if (!requireDocOwner(docOwner, res)) return;
  httpu.sendJson(res, 200, { orders: await orderShip.cancelledOrders(user, docOwner) });
});

/* Marks the order shipped ON MANAPOOL (#454), right after the browser marks
   its ticket shipped. A write to the seller's account, through the
   connection of whoever's orders cache holds the order (orderShip.js). A
   Manapool refusal still answers 200 { ok: false, error }: the ticket keeps
   it and offers Retry. */
route("POST", "/api/manapool/order/:id/fulfillment", async ({ req, res, params, user, docOwner }) => {
  const body = await httpu.readJsonBody(req, 8192);
  const out = await orderShip.pushShipped({ user, docOwner, orderId: params.id, tracking: body && body.tracking });
  log("manapool ship " + params.id + " by " + user.username + ": " + (out.ok ? (out.alreadyDone ? "already shipped there" : "sent") : "not sent - " + out.error));
  httpu.sendJson(res, 200, out);
});

/* Stamped once the browser has auto-matched this order's lines against
   sell-from stock and queued them on the pick list - bookkeeping only, same
   shape as /shipped above, so a reload doesn't re-queue the same order. */
route("POST", "/api/manapool/order/:id/dispatched", async ({ req, res, params, user }) => {
  const body = await httpu.readJsonBody(req, 8192).catch(() => ({}));
  const o = await store.updateOrders(user.id, doc => {
    const o = doc.orders.find(x => x.id === params.id);
    if (!o) return null;
    o.grimoire = Object.assign({}, o.grimoire, {
      dispatchedAt: new Date().toISOString(),
      dispatchShortfall: !!body.shortfall
    });
    return o;
  });
  if (!o) { httpu.sendError(res, 404, "That order is not in the local cache - fetch it first."); return; }
  httpu.sendJson(res, 200, { ok: true, order: o });
});

/* Purchases: orders this account BOUGHT on Manapool (#353), for Receive's
   "Mana Pool order" source. Live passthrough, nothing cached server-side:
   the receipt the browser posts is the record of what came in. */
route("GET", "/api/manapool/purchases", async ({ res, url, user }) => {
  const p = await store.readPrefs(user.id);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const orders = await integrations.manapoolBuyerOrders(mpAuth.credsFromPrefs(user.id, p), { limit, offset });
  httpu.sendJson(res, 200, { orders, offset, limit, more: orders.length >= limit });
});

/* One purchase with its items, each matched to Grimoire's own catalog: a
   card to its printing by scryfall id (Manapool's set/number stay as the
   fallback), a sealed product to the sealed catalog by Manapool product id.
   `matched: false` lines are shown to the user as unmatched, never dropped. */
route("GET", "/api/manapool/purchase/:id", async ({ res, params, user }) => {
  const p = await store.readPrefs(user.id);
  const order = await integrations.manapoolBuyerOrder(mpAuth.credsFromPrefs(user.id, p), params.id);
  for (const pkg of order.packages) {
    for (const l of pkg.items) {
      if (l.kind === "sealed") {
        const s = l.manapoolProductId ? sealed.byManapool(l.manapoolProductId) : null;
        l.matched = !!s;
        if (s) Object.assign(l, { tcgplayerProductId: s.tcgplayerProductId, setCode: s.setCode || l.setCode,
          name: s.name || l.name, market: s.marketPrice == null ? null : s.marketPrice });
      } else {
        const c = l.scryfallId ? cards.cardById(l.scryfallId) : null;
        if (c) { l.set = c.set; l.collector = c.collector; }
        l.matched = !!(l.set && l.collector);
      }
    }
  }
  httpu.sendJson(res, 200, { order });
});

/* Marks one seller's package received ON MANAPOOL - a write to the user's
   account, sent only when they tick "Also mark received on Mana Pool". */
route("POST", "/api/manapool/purchase-package/:id/received", async ({ res, params, user }) => {
  const p = await store.readPrefs(user.id);
  httpu.sendJson(res, 200, Object.assign({ ok: true },
    await integrations.manapoolMarkReceived(mpAuth.credsFromPrefs(user.id, p), params.id)));
});

/* ============================== Shipping labels ============================== */
route("GET", "/api/shipping/status", async ({ res, user }) => {
  const p = await store.readPrefs(user.id);
  httpu.sendJson(res, 200, await integrations.shippingStatus(p.pitneyBowes || {}, user.id));
});

route("POST", "/api/shipping/label", async ({ req, res, user }) => {
  const body = await httpu.readJsonBody(req, 65536);
  let to = body.to;
  let orderRef = body.orderId || "";
  if (!to && orderRef) {
    const doc = await store.readOrders(user.id);
    const o = doc.orders.find(x => x.id === orderRef);
    if (!o) { httpu.sendError(res, 404, "That order is not cached - fetch it from Manapool first."); return; }
    to = o.ship;
  }
  const p = await store.readPrefs(user.id);
  const label = await integrations.createLabel(p.pitneyBowes || {}, user.id, Object.assign({}, body, { to, reference: orderRef }));
  if (orderRef) {
    await store.updateOrders(user.id, doc => {
      const o = doc.orders.find(x => x.id === orderRef);
      if (o) {
        o.grimoire = Object.assign({}, o.grimoire, {
          labelUrl: label.labelUrl, tracking: label.tracking, labelAt: new Date().toISOString()
        });
      }
    });
  }
  httpu.sendJson(res, 200, label);
});

/* ============================== Daily jobs ============================== */
/* No cron dependency: check every ten minutes whether today's work has run.
   Recording it in jobs.json means a restart does not re-run a finished job, and
   a machine that was switched off overnight picks the job up when it comes back. */
/* A job hour from config.json: null, "", false or "off" mean "never run
   this job" - Number(null) is 0, which used to read as "midnight" and run
   a job the config said to switch off. */
function jobHour(v) {
  if (v === null || v === false || v === "" || String(v).toLowerCase() === "off") return NaN;
  return Number(v);
}

async function runDueJobs() {
  const jobs = await store.readJobs();
  const day = prices.today();

  const cardHour = jobHour((CFG.cards || {}).refreshHourLocal);
  if (Number.isFinite(cardHour) && new Date().getHours() >= cardHour && jobs.cardsDay !== day) {
    jobs.cardsDay = day;
    await store.writeJobs(jobs);
    log("[job] daily card refresh");
    try { await cards.refreshBulk({}); } catch (e) { log("[job] card refresh failed: " + e.message); }
  }

  // Same daily slot as the card database - no separate config knob, since
  // Tagger's data changes at the same kind of cadence and there's no reason
  // to make anyone configure a second hour for it.
  if (Number.isFinite(cardHour) && new Date().getHours() >= cardHour && jobs.tagsDay !== day) {
    jobs.tagsDay = day;
    await store.writeJobs(jobs);
    log("[job] daily tag index refresh");
    try { await cards.refreshTags({}); } catch (e) { log("[job] tag refresh failed: " + e.message); }
  }

  // Re-read the hour rather than reusing one captured before the card refresh
  // above: that download+index can run long, and using a stale hour here would
  // make the price snapshot wait for the next 10-minute tick instead of firing
  // the moment it's actually due.
  const priceHour = jobHour((CFG.prices || {}).snapshotHourLocal);
  const now = new Date();
  // MTGJSON's own daily price file isn't published until ~9am Eastern -
  // this server's local time already IS Eastern (confirmed 2026-09-03), so
  // "local" and "Eastern" are the same clock here. A snapshot fired at the
  // OLD shared priceHour (5am) would have been fetching yesterday's file,
  // not today's - given a real minute-of-day dependency like this, that's
  // its own schedule slot, not just a later version of the shared one
  // (jobs.mpPricesDay's Manapool overlay and jobs.sealedDay's sealed
  // catalog have no such dependency and would gain nothing from waiting
  // this long too). Minute-level, not just hour-level, since a 9am-sharp
  // publish time with only hour granularity would mean either firing too
  // early (9:00, likely still stale) or waiting a full extra hour (10:00)
  // for no reason.
  const mtgjsonHour = jobHour((CFG.prices || {}).mtgjsonHourLocal);
  const mtgjsonMinute = Number((CFG.prices || {}).mtgjsonMinuteLocal) || 0;
  const mtgjsonDue = Number.isFinite(mtgjsonHour) &&
    (now.getHours() > mtgjsonHour || (now.getHours() === mtgjsonHour && now.getMinutes() >= mtgjsonMinute));

  // Refreshes the LIVE current price (cards.priceSource - Listings,
  // Inventory value, the Manage dialog) from Manapool's own feed, which
  // has no MTGJSON-style publish-time dependency, so this stays on the
  // original priceHour rather than moving with the MTGJSON-specific
  // snapshot job below (they used to share a slot when this ALSO used to
  // gate the price snapshot's data source - it doesn't anymore, snapshot()
  // reads MTGJSON directly). Cheap local no-op on priceSource:"scryfall"
  // (see cards.applyPriceSource) - this exists so Manapool's own prices
  // get refreshed daily even on a day refreshBulk() itself was skipped
  // (Scryfall bulk file unchanged), not because this deployment
  // necessarily switched.
  if (Number.isFinite(priceHour) && now.getHours() >= priceHour && jobs.mpPricesDay !== day && cards.ready) {
    jobs.mpPricesDay = day;
    await store.writeJobs(jobs);
    log("[job] daily price source apply");
    try { await cards.applyPriceSource(); } catch (e) { log("[job] price source apply failed: " + e.message); }
  }

  // Same slot, right after the price-source apply above so this reads
  // whichever source (Scryfall or Manapool) just finished writing to
  // card.usd/usdFoil/usdEtched. Pushes that current number onto every
  // inventory row's own `price` field, for every collection - not just
  // rows a bulk-price schedule happens to touch (priceRules.runDue below is
  // opt-in and listedQty-gated; this isn't). Without this, `price` only
  // ever changed when someone clicked "Refresh prices", which could sit
  // stale for weeks and drift from the Movers tab's always-current numbers.
  if (Number.isFinite(priceHour) && now.getHours() >= priceHour && jobs.rowPricesDay !== day && cards.ready) {
    jobs.rowPricesDay = day;
    await store.writeJobs(jobs);
    log("[job] daily inventory row price refresh");
    try { await priceRules.runDailyPriceRefresh(auth, orgs); } catch (e) { log("[job] daily row price refresh failed: " + e.message); }
  }

  // Same slot as the card refresh above, and must complete before the price
  // snapshot below - snapshot() needs the uuid->scryfallId map already on
  // disk to make any sense of AllPricesToday.json. Set/printing identifiers
  // don't churn faster than the card catalog itself does, so this rides the
  // card refresh's own hour rather than getting a separate config knob.
  if (Number.isFinite(cardHour) && now.getHours() >= cardHour && jobs.mtgjsonIdsDay !== day) {
    jobs.mtgjsonIdsDay = day;
    await store.writeJobs(jobs);
    log("[job] daily MTGJSON identifier map refresh");
    try { await mtgjson.refreshIdentifiers({}); } catch (e) { log("[job] MTGJSON identifier refresh failed: " + e.message); }
  }

  if (mtgjsonDue && jobs.pricesDay !== day && cards.ready) {
    jobs.pricesDay = day;
    await store.writeJobs(jobs);
    log("[job] daily price snapshot");
    try { await prices.snapshot({}); } catch (e) { log("[job] price snapshot failed: " + e.message); }
  }

  // Same daily slot as the Manapool singles price overlay above - the sealed
  // catalog is a small, standalone fetch with nothing else in the app
  // depending on it yet (see BACKLOG.md #24), so it just rides the same
  // cadence rather than getting its own config knob.
  if (Number.isFinite(priceHour) && now.getHours() >= priceHour && jobs.sealedDay !== day) {
    jobs.sealedDay = day;
    await store.writeJobs(jobs);
    log("[job] daily sealed catalog refresh");
    try { await sealed.refresh(); } catch (e) { log("[job] sealed catalog refresh failed: " + e.message); }
  }

  // Per-user, unlike the two jobs above - each account has its own rules and
  // its own schedule, checked against bookkeeping in that user's prefs.json
  // rather than the single global jobs.json.
  try { await priceRules.runDue(auth, orgs); } catch (e) { log("[job] bulk price schedule failed: " + e.message); }

  // Daily digest email (server/lib/digest.js) - gated on jobs.pricesDay, so
  // it waits for today's MTGJSON price snapshot (mtgjsonHourLocal/Minute,
  // 9:30 here) and "since last snapshot" is fresh. In practice that makes
  // the send ~9:30, not digest.hourLocal - that's only the earliest hour.
  // digest.hourLocal (default 7); set it to null/"off" in config.json to
  // stop the job entirely without touching anyone's subscription.
  const digestCfg = CFG.digest || {};
  const digestHour = digestCfg.hourLocal === undefined ? 7 : jobHour(digestCfg.hourLocal);
  if (Number.isFinite(digestHour) && now.getHours() >= digestHour && jobs.digestDay !== day && jobs.pricesDay === day) {
    jobs.digestDay = day;
    await store.writeJobs(jobs);
    log("[job] daily digest email");
    try { await digest.runDaily({}); } catch (e) { log("[job] daily digest failed: " + e.message); }
  }

  // In-app notifications' daily pass (#139, server/lib/notifyJob.js):
  // watch-list targets hit, a watched card starting to sell fast on
  // Manapool (#369, the sales history as of its last daily pull) and "a
  // friend has a card on your watch list".
  // Same gate as the digest: today's price snapshot must be in. One
  // collection read at a time. jobs.notifyDay is set BEFORE running, like
  // every job here, and notify()'s day stamp makes a same-day re-run add
  // nothing, so a restart can't send a second burst. notifications.
  // hourLocal (default 0 = as soon as prices are in); null/"off" stops it.
  const notifyCfg = CFG.notifications || {};
  const notifyHour = notifyCfg.hourLocal === undefined ? 0 : jobHour(notifyCfg.hourLocal);
  if (Number.isFinite(notifyHour) && now.getHours() >= notifyHour && jobs.notifyDay !== day && jobs.pricesDay === day && cards.ready) {
    const prevDay = jobs.notifyDay || null;
    jobs.notifyDay = day;
    await store.writeJobs(jobs);
    log("[job] daily notification pass");
    try {
      const r = await notifyJob.runDaily({ day, prevDay, priceNow: priceNowFor, fastNow: async items => sellingFastFor(items) });
      log("[job] notification pass: " + r.collectionsRead + " inventories read, " + r.priceAlerts + " price alert(s), " +
        r.fastAlerts + " selling-fast alert(s), " + r.friendHas + " friend-has notification(s)");
    } catch (e) { log("[job] notification pass failed: " + e.message); }
  }

  // Selling fast (#202, server/lib/mpSales.js): stream Manapool's public
  // catalog (~222MB gz) once a day and count new sales. Never alongside a
  // card index rebuild (that already doubles the index in memory): a
  // building tick leaves the Day unset, so the next tick tries again.
  const salesHour = jobHour((CFG.prices || {}).mpSalesHourLocal);
  if (Number.isFinite(salesHour) && now.getHours() >= salesHour && jobs.mpSalesDay !== day && cards.ready &&
      !cards.status().building && !mpSales.busy()) {
    jobs.mpSalesDay = day;
    await store.writeJobs(jobs);
    log("[job] daily Manapool sales pull");
    try { await mpSales.refreshCatalog({}); } catch (e) { log("[job] Manapool sales pull failed: " + e.message); }
  }

  // The 20-sale cap top-up: every mpSalesTopupHours, re-poll the most
  // overdue fast-selling capped printings through the API with an admin's
  // Manapool login. No login: daily only, and the Selling fast API says so.
  const topupHours = Number((CFG.prices || {}).mpSalesTopupHours);
  if (topupHours > 0) {
    const creds = await adminManapoolCreds().catch(() => null);
    mpSales.setTopupMode(!!creds, creds ? "" : (integrations.manapoolEnabled()
      ? "No admin account has Mana Pool connected in Settings, so sales are collected once a day."
      : "Manapool is turned off on this server, so sales are collected once a day."));
    const lastTopup = Date.parse(jobs.mpSalesTopupAt || "") || 0;
    if (creds && !mpSales.busy() && Date.now() - lastTopup >= topupHours * 3600000) {
      jobs.mpSalesTopupAt = new Date().toISOString();
      await store.writeJobs(jobs);
      try { await mpSales.topup(creds); } catch (e) { log("[job] Manapool sales top-up failed: " + e.message); }
    }
  } else mpSales.setTopupMode(false, "The cap top-up is turned off on this server, so sales are collected once a day.");
}

/* The Manapool login the Selling fast cap top-up polls with: the first
   admin account that has one saved (the server owner's), or null. */
async function adminManapoolCreds() {
  if (!integrations.manapoolEnabled()) return null;
  for (const u of await auth.listUsers({ withDisabled: true })) {
    if (u.role !== "admin" || u.disabled) continue;
    const p = await store.readPrefs(u.id);
    const c = mpAuth.credsFromPrefs(u.id, p);
    if (mpAuth.usable(c)) return c;
  }
  return null;
}

/* Today's price for each watch item, same source and keying as the Buy
   List's watch table (POST /api/prices/watch) and the digest's target hits. */
async function priceNowFor(items) {
  const w = await prices.watchPrices(items.map(x => ({ set: x.set, collector: x.collector, lang: x.lang, finish: x.finish })), 1, {});
  const byKey = new Map((w.rows || []).map(r => [r.key + "|" + r.finish, r.now]));
  return items.map(x => {
    const v = byKey.get(cards.printKey(x.set, x.collector, x.lang || "en") + "|" + (x.finish || "nonfoil"));
    return v == null ? null : v;
  });
}

/* ============================== CLI ============================== */
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}
const hasArg = name => process.argv.includes(name);

function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo is suppressed so a password never lands in the terminal scrollback.
      process.stdout.write(question);
      rl._writeToOutput = s => { if (String(s).indexOf("\n") >= 0) rl.output.write("\n"); };
      rl.question("", a => { rl.close(); resolve(a); });
      return;
    }
    rl.question(question, a => { rl.close(); resolve(a); });
  });
}

async function cliAddUser(cfg) {
  const username = argValue("--add-user") || await ask("Username: ");
  let password = argValue("--password");
  if (!password) {
    password = await ask("Password (min 10 chars, needs a letter and a number): ", true);
    const again = await ask("Repeat password: ", true);
    if (password !== again) { console.error("Passwords did not match."); process.exit(1); }
  }
  const role = hasArg("--admin") ? "admin" : undefined;
  const user = await auth.createUser({ username, password, role });
  console.log("Created " + user.username + " (" + user.role + "), id " + user.id);
}

async function cliInvite() {
  const inv = await auth.createInvite("cli", argValue("--invite") || "created from the command line");
  console.log("Invite code: " + inv.code);
  console.log("Sign-up link: " + (CFG.baseUrl || "http://localhost:" + CFG.port) + "/login.html?invite=" + inv.code);
}

/* One-shot, same shape as cliInvite() above: touches the store directly
   rather than calling the running server's admin API, so it works with no
   session and needs nothing but filesystem access to the same data
   directory. The running process (if any) picks this up on its own poll -
   see checkRestartRequest(). */
async function cliRestartIn() {
  const seconds = Math.max(5, Number(argValue("--restart-in")) || 30);
  const reason = argValue("--message") || "";
  await store.writeRestartRequest({ at: Date.now() + seconds * 1000, reason, requestedBy: "cli" });
  console.log("Restart requested: a running server on this data directory will restart in " + seconds + "s" +
    (reason ? " (" + reason + ")" : "") + ".");
  console.log("If no server is currently running, this takes effect the next time one starts and then idles past the deadline.");
}

/* Queue a digest run for a past day on the RUNNING server - it, not this
   one-shot process, holds the card index and price archive build() needs.
  --send-digest [YYYY-MM-DD]  default yesterday (UTC), same as the daily job
  --bcc ADDRESS               copy every email to ADDRESS (this run only)
  --only-newsworthy           keep the daily job's "skip quiet days" rule;
                              without it every subscriber gets one */
async function cliSendDigest() {
  const raw = argValue("--send-digest");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw || "") ? raw : digest.yesterdayUtc();
  const bcc = argValue("--bcc") || "";
  if (bcc && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bcc)) { console.error("--bcc must be one email address."); process.exitCode = 1; return; }
  const req = { date, bcc, force: !hasArg("--only-newsworthy"), requestedAt: new Date().toISOString(), requestedBy: "cli" };
  await store.writeDigestRequest(req);
  console.log("Digest run queued for " + date + (bcc ? ", bcc " + bcc : "") + (req.force ? ", every subscriber" : ", newsworthy only") +
    ". A running server picks it up within a few seconds; watch server.log for the [digest] summary line.");
}

function help() {
  console.log([
    "Grimoire " + VERSION,
    "",
    "  node server/index.js                    start the server",
    "  node server/index.js --refresh-cards    download and index the Scryfall bulk file now, then exit",
    "  node server/index.js --snapshot-prices  take today's price snapshot now, then exit",
    "  node server/index.js --migrate-prices-to-sqlite  one-time: migrate the legacy day/series JSON price archive into prices.db, then exit",
    "  node server/index.js --add-user NAME    create an account (add --admin for an administrator)",
    "  node server/index.js --invite           mint an invite code",
    "  node server/index.js --restart-in N     warn connected users, then restart the running server in N seconds",
    "                                           (add --message \"...\" to customize the banner text)",
    "  node server/index.js --send-digest [DATE] have the running server email the digest for DATE (default yesterday)",
    "                                           to every subscriber (add --bcc ADDRESS, --only-newsworthy)",
    "  node server/index.js --where            print the data directory and exit",
    "  node server/index.js --help",
    ""
  ].join("\n"));
}

/* ============================== Boot ============================== */
async function main() {
  if (hasArg("--help") || hasArg("-h")) { help(); return; }

  CFG = loadConfig();
  const dataDir = store.init(CFG);
  log("data directory: " + dataDir);

  if (hasArg("--where")) {
    console.log(dataDir);
    return;
  }

  prices.init(CFG, { log: tagLog("prices") });
  mpSales.init(CFG, { log: tagLog("mpSales") });
  await mtgjson.init(CFG, { log: tagLog("mtgjson") });
  auditStore.init(CFG);
  digest.init({ store, prices, audit: auditStore, mailer, cards, orgs, cfg: CFG, log: tagLog("digest") });
  integrations.init(CFG, { log: tagLog("integrations") });
  mpAuth.init(CFG, { log: tagLog("manapool-auth") });
  await mpAuth.load().catch(e => log("Mana Pool app settings unreadable: " + e.message));
  github.init(CFG);
  priceRules.init({ log: tagLog("priceRules") });
  notifyEvents.init({ log });

  if (hasArg("--add-user")) { await cards.init(CFG, { log: () => {} }).catch(() => {}); await cliAddUser(CFG); return; }
  if (hasArg("--invite")) { await cliInvite(); return; }
  if (hasArg("--restart-in")) { await cliRestartIn(); return; }
  if (hasArg("--send-digest")) { await cliSendDigest(); return; }

  if (hasArg("--refresh-cards")) {
    await cards.init(CFG, { log: tagLog("cards") });
    await cards.refreshBulk({ force: true });
    cards.flushLive();
    return;
  }
  if (hasArg("--snapshot-prices")) {
    await cards.init(CFG, { log: tagLog("cards") });
    console.log(JSON.stringify(await prices.snapshot({ force: true }), null, 2));
    return;
  }
  if (hasArg("--migrate-prices-to-sqlite")) {
    console.log(JSON.stringify(await prices.migrateFromLegacyFiles(), null, 2));
    return;
  }

  await cards.init(CFG, { log: tagLog("cards") });
  sealed.init(CFG, { log: tagLog("sealed") });
  store.sweepTmp().then(n => { if (n) log("removed " + n + " leftover tmp file(s) from failed writes"); }).catch(() => {});

  // Org invites made before they had an expiry (#126) get 7 days from the
  // first boot that sees them. No-op (no write) once they're all stamped.
  await auth.stampLegacyOrgInviteExpiry()
    .then(n => { if (n) log("gave " + n + " older organization invite(s) a " + auth.ORG_INVITE_DAYS + "-day expiry"); })
    .catch(e => log("org invite expiry backfill failed: " + e.message));

  // Finished invites (#160): expired/revoked ones go 30 days after they
  // stopped working; used pick-ticket ones lose code and note after 90.
  // Also done whenever an invite is made. No write when nothing is due.
  await auth.pruneInvites()
    .then(r => { if (r.dropped || r.trimmed) log("invite cleanup: removed " + r.dropped + " finished invite(s), trimmed " + r.trimmed + " used pick-ticket code(s)"); })
    .catch(e => log("invite cleanup failed: " + e.message));

  // One-time (done-marker in migrations.json, #140): every existing sharing
  // entry becomes an accepted friendship, both ways, so nobody loses access
  // now that a personal share needs one. Awaited, unlike the cleanup below:
  // until it has run, personal shares would count for nothing. It reads
  // each account's small prefs file once.
  await friends.migrateSharesOnce()
    .then(r => { if (r) log("friendships from existing shares: " + r.entries + " sharing entries, " + r.created + " friendship(s) made" + (r.unknown ? ", " + r.unknown + " entr(ies) naming no account left as they are" : "") + (r.skipped ? ", " + r.skipped + " account(s) unreadable; runs again next boot" : "")); })
    .catch(e => log("friendships from existing shares failed (will retry next boot): " + e.message));

  // One-time (done-marker in migrations.json, #197): write the readable
  // Manapool order number onto pick lists saved without one, from the
  // orders caches. Awaited, so no browser save is in flight while it
  // writes; it reads one collection at a time and only writes the few
  // that need it. See server/lib/orderLabels.js.
  await orderLabels.backfillOrderLabelsOnce({ log })
    .then(r => { if (r && (r.filled || r.unresolved || r.skipped)) log("order numbers on old pick lists: filled " + r.filled + " in " + r.owners + " collection(s)" + (r.unresolved ? ", " + r.unresolved + " not in any orders cache (left as they are)" : "") + (r.skipped ? ", " + r.skipped + " collection(s)/file(s) unreadable; runs again next boot" : "")); })
    .catch(e => log("order numbers on old pick lists failed (will retry next boot): " + e.message));

  // One-time (done-marker in migrations.json): revoke unused pick-ticket
  // join codes whose pick list doesn't exist (PR #143). Reads one
  // inventory at a time; runs alongside startup rather than delaying it.
  pickInvite.revokeOrphanPickCodesOnce()
    .then(r => { if (r) log("pick-ticket code cleanup: checked " + r.checked + ", revoked " + r.revoked + (r.skipped ? ", left " + r.skipped + " alone (inventory unreadable; runs again next boot)" : "")); })
    .catch(e => log("pick-ticket code cleanup failed (will retry next boot): " + e.message));

  // One-time (done-marker in migrations.json, #452): Manapool fees, payout
  // and shipping onto sales completed before the orders cache kept them,
  // fetching missing order details through each account's own Manapool
  // connection. Not awaited, and started a minute in, so its Manapool calls
  // never hold up boot or the restart handshake; it writes each collection
  // under its lock with a new rev (open tabs merge). A failure that could
  // pass retries on a later boot. See server/lib/orderFees.js.
  setTimeout(() => {
    orderFees.backfillFeesOnce({ log })
      .then(r => { if (r && (r.filled || r.unfetchable || r.skipped || r.retry)) log("Manapool fees on older sales: filled " + r.filled + " in " + r.owners + " collection(s), fetched " + r.fetched + " order(s)" + (r.unfetchable ? ", " + r.unfetchable + " order(s) Manapool couldn't return (left as they are)" : "") + (r.skipped || r.retry ? (r.tries >= orderFees.MAX_TRIES ? "; gave up after " + r.tries + " tries" : "; runs again next boot") : "")); })
      .catch(e => log("Manapool fees on older sales failed (will retry next boot): " + e.message));
  }, 60 * 1000).unref();

  // One-time (done-marker in migrations.json, #457): packing + postage cost
  // onto sales completed before shipping costs existed, from each account's
  // Settings → Shipping as it is now (the suggested setup if never set).
  // No network. Started after the fees backfill above, since a sale's value
  // (revenue less the buyer's shipping) is read from what that fills.
  // Each collection is written under its lock with a new rev (open tabs
  // merge). See server/lib/shipCostBackfill.js.
  setTimeout(() => {
    shipCostBackfill.backfillShipCostsOnce({ log })
      .then(r => { if (r && (r.filled || r.skipped)) log("Shipping costs on older sales: filled " + r.filled + " in " + r.owners + " collection(s)" + (r.skipped ? "; " + r.skipped + " collection(s) couldn't be updated" + (r.tries >= shipCostBackfill.MAX_TRIES ? ", gave up after " + r.tries + " tries" : ", runs again next boot") : "")); })
      .catch(e => log("Shipping costs on older sales failed (will retry next boot): " + e.message));
  }, 3 * 60 * 1000).unref();

  // One-time EMAIL (done-marker in migrations.json, #456): tells each
  // account with its own Manapool connection that Mark shipped now tells
  // Manapool (#454). Started five minutes in, so a release that's rolled
  // straight back mails nobody. Every account is claimed before its send,
  // so a crash never emails anyone twice. Sends nothing without email
  // settings (a scratch server), with Manapool off, or with
  // `"announcements": { "enabled": false }`. See server/lib/mpShipAnnounce.js.
  setTimeout(() => {
    mpShipAnnounce.announceOnce({
      mailer, log, baseUrl: CFG.baseUrl || "",
      enabled: !(CFG.announcements && CFG.announcements.enabled === false),
      manapoolOn: integrations.manapoolEnabled(),
      featureShipped: fs.existsSync(path.join(__dirname, "lib", "orderShip.js"))
    })
      .then(r => { if (r) log("Manapool shipping email: " + (r.skipped ? "not sent - " + r.skipped : r.sent + " sent of " + r.recipients + " eligible" + (r.already ? ", " + r.already + " already done" : "") + (r.unsure ? ", " + r.unsure + " timed out (not retried)" : "") + (r.failed ? ", " + r.failed + " failed" + (r.tries >= mpShipAnnounce.MAX_TRIES ? " (gave up after " + r.tries + " tries)" : " (retried next boot)") : ""))); })
      .catch(e => log("Manapool shipping email failed (will retry next boot): " + e.message));
  }, 5 * 60 * 1000).unref();

  const users = await auth.listUsers();
  FIRST_RUN = !users.length; // isFirstRun() only re-reads while this is true
  if (!users.length) {
    log("no accounts yet - the first person to register at /login.html becomes the administrator");
  }

  const server = http.createServer((req, res) => {
    // Lets http.js's sendRaw() gzip a response body based on this request's
    // own Accept-Encoding, without threading `req` through every individual
    // route handler's sendJson/sendError call - one touch point here instead
    // of ~90 call sites across the route table.
    res.req = req;
    handle(req, res).catch(e => {
      log("UNHANDLED " + req.method + " " + req.url + " - " + (e.stack || e.message));
      try { httpu.sendError(res, 500, "Server error"); } catch (e2) {}
    });
  });
  server.headersTimeout = 120000;
  server.requestTimeout = 300000;

  listenWithRetry(server, CFG.port, CFG.host, () => {
    log("Grimoire " + VERSION + " listening on http://" + (CFG.host === "0.0.0.0" ? "localhost" : CFG.host) + ":" + CFG.port);
    log("registration mode: " + CFG.registration);
    if (!cards.ready) log("card database still loading - autocomplete will be thin until it finishes");
  });

  runDueJobs().catch(e => log("job check failed: " + e.message));
  setInterval(() => runDueJobs().catch(e => log("job check failed: " + e.message)), 10 * 60 * 1000);

  // #499: once the grace week is over, the old pasted Mana Pool tokens are
  // deleted (once; nothing can save a new one). Not a daily job and sends no
  // email: a no-op until the cut-off, and after its one sweep.
  const sweepMp = () => mpAuth.sweepLegacy(() => auth.listUsers({ withDisabled: true }))
    .catch(e => log("Mana Pool old-token sweep failed: " + e.message));
  sweepMp();
  setInterval(sweepMp, 60 * 60 * 1000).unref();

  // Support tickets <-> GitHub issues (#40). Deliberately NOT run at boot:
  // a restart shouldn't be what emails reporters - the first check is one
  // interval after start. Off when github.syncMinutes is null/"off" (the
  // scratch server turns it off).
  const ghMinutes = githubSyncMinutes();
  if (ghMinutes) setInterval(() => runGithubSync(), ghMinutes * 60 * 1000);

  // Folds the in-memory presence map (touched on every authenticated
  // request) into sessions.json so "last active" survives a restart.
  setInterval(() => auth.flushPresence().catch(e => log("presence flush failed: " + e.message)), 60 * 1000);

  // Every 3s rather than piggybacking on the 10-minute job loop above - a
  // restart countdown needs to be noticed promptly, not up to 10 minutes late.
  // The same tick also picks up a `--send-digest` request.
  checkRestartRequest(server).catch(e => log("[restart] check failed: " + e.message));
  restartWatchTimer = setInterval(() => {
    checkRestartRequest(server).catch(e => log("[restart] check failed: " + e.message));
    checkDigestRequest().catch(e => log("[digest] request check failed: " + e.message));
  }, 3000);

  const bye = sig => {
    log("shutting down (" + sig + ")");
    clearInterval(restartWatchTimer);
    cards.flushLive();
    mpSales.stop();
    prices.closeDb();
    auth.flushPresence().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));
}

main().catch(e => {
  console.error("Grimoire failed to start: " + (e.stack || e.message));
  process.exit(1);
});
