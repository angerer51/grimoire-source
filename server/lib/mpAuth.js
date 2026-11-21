"use strict";
/* Mana Pool sign-in (#499): each seller connects Grimoire to their Mana Pool
   account through Mana Pool's own consent page (OAuth 2.0 authorization code
   + PKCE), instead of pasting an email and full-access API token.

   - The app's client ID + secret are entered by an admin (Admin -> Mana
     Pool), kept in manapool-app.json with the secret sealed (store.js).
   - startUrl() makes a fresh PKCE verifier and `state` per attempt, kept in
     memory here, bound to the signed-in account, for 10 minutes. finish()
     checks the state and the account, then trades the code (single use, 60 s)
     at the token endpoint with HTTP Basic client_id:client_secret.
   - prefs.json `manapoolAuth`: { accessToken, refreshToken (both sealed),
     expiresAt, scopes, connectedAt } or, once Mana Pool refuses a refresh,
     { dead: { at, reason } }. Never sent to a browser: status() reports
     facts about it, not the values.
   - credsFor()/credsFromPrefs() give integrations.js a `creds` object whose
     oauth.token() hands out a current access token. Tokens last about an
     hour; one is renewed shortly before it runs out, one renewal at a time
     per account (Mana Pool rotates the refresh token on every use, so two
     racing renewals would burn it), and the new refresh token is always
     saved. A refusal (seller disconnected the app, or the 30-day rule)
     marks the connection dead, and screens say Reconnect.
   - The old pasted email + token (prefs.manapool) keep working for 7 days
     from when this release could first be used (the admin saving the app's
     credentials: before that nobody can connect), then sweepLegacy() deletes
     them. Connecting deletes them at once. No new paste-a-token path exists.

   The auth server, its paths and the scopes are config values
   (config.manapool.oauth) with defaults, since Mana Pool's scope list is
   behind their login. */

const crypto = require("crypto");
const store = require("./store");

let cfg = {};
let log = () => {};
let app = {};           // manapool-app.json as last read (clientId, hasSecret, graceStartAt)
let fetchImpl = (...a) => fetch(...a);

const CALLBACK_PATH = "/api/manapool/oauth/callback";
const GRACE_MS = 7 * 86400000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;   // renew this long before the access token runs out
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;
/* Mana Pool's real scope names (its app registration form, 2026-11-21, #501):
   inventory:read/write, orders:read/write, reports:read/write,
   settings:seller:write, buyer_orders:read, decks:read. Ask only for what
   Grimoire uses; an unknown name makes Mana Pool refuse with invalid_scope. */
const DEFAULT_SCOPES = ["offline_access", "inventory:read", "inventory:write", "orders:read", "orders:write",
  "buyer_orders:read"];
const RECONNECT = "Reconnect Mana Pool in Settings → Integrations.";

function init(config, opts) {
  cfg = config || {};
  if (opts && opts.log) log = opts.log;
  if (opts && opts.fetch) fetchImpl = opts.fetch;
}
/* Reads the app record into memory (boot, and after every admin save). */
async function load() {
  const a = await store.readManapoolApp();
  app = { clientId: a.clientId || "", hasSecret: !!a.clientSecret, graceStartAt: a.graceStartAt || null,
    legacySweptAt: a.legacySweptAt || null, savedAt: a.savedAt || null };
  return app;
}

const mp = () => (cfg && cfg.manapool) || {};
const oa = () => mp().oauth || {};
const featureOn = () => !!mp().enabled;
const authBase = () => String(oa().authBase || "https://auth.manapool.com").replace(/\/+$/, "");
const authUrl = key => authBase() + (oa()[key + "Path"] || { authorize: "/oauth2/auth", token: "/oauth2/token", revoke: "/oauth2/revoke" }[key]);
function scopes() {
  const s = oa().scopes;
  if (Array.isArray(s) && s.length) return s.map(String);
  if (typeof s === "string" && s.trim()) return s.trim().split(/\s+/);
  return DEFAULT_SCOPES.slice();
}
const inventoryWriteScope = () => String(oa().inventoryWriteScope || "inventory:write");
function redirectUri() {
  return oa().redirectUri || (String((cfg && cfg.baseUrl) || "").replace(/\/+$/, "") + CALLBACK_PATH);
}
const appReady = () => !!(app.clientId && app.hasSecret);

/* When the old pasted tokens stop working: 7 days after graceStartAt. */
function cutoffAt() {
  const t = Date.parse(app.graceStartAt || "");
  return Number.isFinite(t) ? new Date(t + GRACE_MS).toISOString() : null;
}
function legacyCutOff(now) {
  const c = cutoffAt();
  return !!c && (now || Date.now()) >= Date.parse(c);
}
const hasLegacy = prefs => !!(prefs && prefs.manapool && prefs.manapool.email && prefs.manapool.accessToken);
const liveAuth = prefs => {
  const a = prefs && prefs.manapoolAuth;
  return a && !a.dead && a.refreshToken ? a : null;
};

/* ------------------------------ creds ------------------------------ */
function notConnected(dead) {
  return Object.assign(new Error(dead
    ? "Mana Pool ended Grimoire's connection to your account. " + RECONNECT
    : "Mana Pool isn't connected. Connect it in Settings → Integrations, then try again."), { status: 501, reconnect: true });
}

/* What integrations.js takes as `creds` for this account: an OAuth
   connection ({ oauth: { token }, scopes }), the old pasted token during the
   grace week ({ email, accessToken, legacy: true }), or nothing usable
   ({ dead } when Mana Pool ended the connection). Server-side only. */
function credsFromPrefs(userId, prefs) {
  const a = liveAuth(prefs);
  if (a) {
    return { userId: String(userId), scopes: Array.isArray(a.scopes) ? a.scopes.slice() : [],
      oauth: { token: stale => accessToken(userId, stale) } };
  }
  if (hasLegacy(prefs) && !legacyCutOff()) {
    return { email: prefs.manapool.email, accessToken: prefs.manapool.accessToken, legacy: true };
  }
  const d = prefs && prefs.manapoolAuth && prefs.manapoolAuth.dead;
  return d ? { dead: d.reason || "refused" } : {};
}
async function credsFor(userId) {
  return credsFromPrefs(userId, await store.readPrefs(userId));
}
/* Does this account have a working Mana Pool connection (either kind)? */
function connected(prefs) { return usable(credsFromPrefs("", prefs)); }
const usable = c => !!(c && (c.oauth || c.legacy));
/* False only when the connection is known to lack the inventory-write scope:
   another tool manages this seller's listings on Mana Pool. */
function canWriteInventory(creds) {
  if (!creds || !creds.oauth) return true;
  return !creds.scopes || !creds.scopes.length || creds.scopes.includes(inventoryWriteScope());
}

/* ------------------------------ token endpoint ------------------------------ */
async function tokenRequest(url, form) {
  const full = await store.readManapoolApp();
  if (!full.clientId || !full.clientSecret) {
    throw Object.assign(new Error("Grimoire isn't registered with Mana Pool yet. An administrator needs to enter the " +
      "Mana Pool app's client ID and secret on the Admin page."), { status: 501 });
  }
  // RFC 6749 2.3.1: each part form-encoded, then Basic.
  const basic = Buffer.from(encodeURIComponent(full.clientId) + ":" + encodeURIComponent(full.clientSecret)).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res, text;
  try {
    // A plain fetch, never retried: a refresh token is spent on first use, so
    // resending one whose answer was lost would be refused (and may end the chain).
    res = await fetchImpl(url, {
      method: "POST", signal: controller.signal,
      headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString()
    });
    text = await res.text();
  } catch (e) {
    throw Object.assign(new Error(e.name === "AbortError" ? "Mana Pool's sign-in server didn't answer in time." :
      "Couldn't reach Mana Pool's sign-in server: " + e.message), { status: 502, network: true });
  } finally { clearTimeout(timer); }
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
  if (!res.ok) {
    const e = new Error("Mana Pool's sign-in server said " + (data.error || "HTTP " + res.status) +
      (data.error_description ? ": " + String(data.error_description).slice(0, 200) : ""));
    e.status = 502; e.oauthError = data.error || ""; e.httpStatus = res.status;
    throw e;
  }
  return data;
}
const splitScopes = s => String(s || "").trim().split(/\s+/).filter(Boolean);
const tokenFields = (t, prev) => ({
  accessToken: String(t.access_token || ""),
  refreshToken: String(t.refresh_token || (prev && prev.refreshToken) || ""),
  expiresAt: Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000,
  scopes: t.scope ? splitScopes(t.scope) : ((prev && prev.scopes) || [])
});

/* ------------------------------ access tokens ------------------------------ */
const inflight = new Map();   // user id -> the one renewal in progress
async function markDead(userId, usedRefresh, reason) {
  await store.updatePrefs(userId, p => {
    const cur = p.manapoolAuth;
    if (!cur || cur.refreshToken !== usedRefresh) return;   // reconnected meanwhile
    p.manapoolAuth = { dead: { at: new Date().toISOString(), reason }, scopes: cur.scopes || [], connectedAt: cur.connectedAt || null };
  });
  log("Mana Pool connection of " + userId + " ended (" + reason + ")");
}
/* A current access token for this account. `stale`: the token Mana Pool just
   turned down (a 401), so a fresh one is fetched even if it hasn't run out. */
function accessToken(userId, stale) {
  const key = String(userId);
  if (inflight.has(key)) return inflight.get(key);
  const run = (async () => {
    const a = liveAuth(await store.readPrefs(userId));
    if (!a) throw notConnected(true);
    if (a.accessToken && a.accessToken !== stale && Number(a.expiresAt) - REFRESH_SKEW_MS > Date.now()) return a.accessToken;
    let t;
    try { t = await tokenRequest(authUrl("token"), { grant_type: "refresh_token", refresh_token: a.refreshToken }); }
    catch (e) {
      if (e.oauthError === "invalid_grant") { await markDead(userId, a.refreshToken, "refused"); throw notConnected(true); }
      if (e.oauthError === "invalid_client") {
        throw Object.assign(new Error("Mana Pool turned down Grimoire's app credentials. An administrator needs to check " +
          "them on the Admin page (Mana Pool tab)."), { status: 502 });
      }
      throw e;
    }
    if (!t.access_token) throw Object.assign(new Error("Mana Pool's sign-in server sent no access token."), { status: 502 });
    await store.updatePrefs(userId, p => {
      const cur = p.manapoolAuth;
      if (!cur || cur.refreshToken !== a.refreshToken) return;
      p.manapoolAuth = Object.assign({}, cur, tokenFields(t, cur), { refreshedAt: new Date().toISOString() });
    });
    return String(t.access_token);
  })();
  inflight.set(key, run);
  const clear = () => { if (inflight.get(key) === run) inflight.delete(key); };
  run.then(clear, clear);
  return run;
}

/* ------------------------------ connect ------------------------------ */
const pending = new Map();   // state -> { userId, verifier, scopes, at }
const b64url = buf => Buffer.from(buf).toString("base64url");
function prunePending(now) {
  for (const [k, v] of pending) if (now - v.at > STATE_TTL_MS) pending.delete(k);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
}
/* The Mana Pool consent page's address for this account, with a fresh PKCE
   pair and state. withoutInventory: ask without the inventory-write scope
   (another tool manages this seller's listings). */
async function startUrl(userId, opts) {
  if (!featureOn()) throw Object.assign(new Error("Mana Pool is turned off on this server."), { status: 501 });
  await load();
  if (!appReady()) {
    throw Object.assign(new Error("Grimoire isn't registered with Mana Pool yet. An administrator needs to enter the " +
      "Mana Pool app's client ID and secret on the Admin page."), { status: 501 });
  }
  const o = opts || {};
  const want = o.withoutInventory ? scopes().filter(s => s !== inventoryWriteScope()) : scopes();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  const now = Date.now();
  prunePending(now);
  pending.set(state, { userId: String(userId), verifier, scopes: want, at: now });
  const u = new URL(authUrl("authorize"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", app.clientId);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("scope", want.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/* Mana Pool sent the seller back. Returns { redirect } (where the browser
   goes next) and { result } for the log. Never throws for a bad visit. */
const SETTINGS = "/settings.html";
const back = (result, extra) => ({ result, redirect: SETTINGS + "?mp=" + result + (extra || "") + "#tab=integrations" });
async function finish(userId, query) {
  const state = String(query.get("state") || "");
  const entry = state ? pending.get(state) : null;
  if (entry) pending.delete(state);
  if (!entry || Date.now() - entry.at > STATE_TTL_MS) return back("expired");
  if (entry.userId !== String(userId)) return back("expired");
  const error = String(query.get("error") || "");
  if (error) {
    const why = String(query.get("error_description") || "");
    // One inventory integration per seller: another tool has it, so ask again without it.
    if (error === "access_denied" && entry.scopes.includes(inventoryWriteScope()) && /inventory/i.test(why)) {
      try { return { result: "retry-without-inventory", redirect: await startUrl(userId, { withoutInventory: true }) }; }
      catch (e) { return back("error"); }
    }
    // Any other refusal of a request that asked for listing rights: Settings offers
    // "Connect without listing changes" (the wording above is Mana Pool's, unverified).
    if (error === "access_denied" && entry.scopes.includes(inventoryWriteScope())) return back("denied", "&inv=offer");
    return back(error === "access_denied" ? "denied" : error === "invalid_scope" ? "scope" : "error");
  }
  const code = String(query.get("code") || "");
  if (!code) return back("error");
  let t;
  try {
    t = await tokenRequest(authUrl("token"), { grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: entry.verifier });
  } catch (e) {
    log("Mana Pool connect of " + userId + " failed at the token step: " + e.message);
    return back("error");
  }
  if (!t.access_token || !t.refresh_token) {
    log("Mana Pool connect of " + userId + ": no " + (t.access_token ? "refresh" : "access") + " token came back");
    return back("error");
  }
  const rec = Object.assign(tokenFields(t, { scopes: entry.scopes }), { connectedAt: new Date().toISOString() });
  await store.updatePrefs(userId, p => {
    p.manapoolAuth = rec;
    delete p.manapool;   // the old pasted token goes at once
  });
  log("Mana Pool connected for " + userId + " (" + rec.scopes.join(" ") + ")");
  return back("connected", rec.scopes.includes(inventoryWriteScope()) ? "" : "&inv=other");
}

/* Disconnect: revoke at Mana Pool, then forget the tokens either way.
   { ok, revoked, error } - a failed revoke still disconnects here. */
async function disconnect(userId) {
  const prefs = await store.readPrefs(userId);
  const a = prefs.manapoolAuth;
  let revoked = false, error = "";
  if (a && !a.dead && a.refreshToken) {
    try {
      await tokenRequest(authUrl("revoke"), { token: a.refreshToken, token_type_hint: "refresh_token" });
      revoked = true;
    } catch (e) { error = e.message; log("Mana Pool revoke for " + userId + " failed: " + e.message); }
  }
  await store.updatePrefs(userId, p => { delete p.manapoolAuth; delete p.manapool; });
  inflight.delete(String(userId));
  log("Mana Pool disconnected for " + userId + (revoked ? " (revoked)" : ""));
  return { ok: true, revoked, error };
}

/* ------------------------------ status ------------------------------ */
/* What Settings and the banner may know: facts, never a token. */
function status(prefs) {
  const a = prefs && prefs.manapoolAuth;
  const live = liveAuth(prefs);
  const legacy = hasLegacy(prefs) && !legacyCutOff();
  return {
    featureOn: featureOn(), appReady: appReady(),
    connected: !!live, connectedAt: live ? live.connectedAt || null : null,
    scopes: live ? (live.scopes || []) : [],
    otherInventoryApp: !!live && !canWriteInventory({ oauth: {}, scopes: live.scopes || [] }),
    dead: !!(a && a.dead), deadReason: a && a.dead ? a.dead.reason || "refused" : null,
    legacy, legacyEmail: legacy ? prefs.manapool.email : "",
    cutoffAt: legacy ? cutoffAt() : null,
    // Kept for the pages that only ask "is there a working connection?"
    hasToken: !!live || legacy
  };
}
/* The desk banner (/api/auth/me): null, or what to say. */
function banner(prefs) {
  if (!featureOn()) return null;
  const s = status(prefs);
  if (s.connected) return null;
  if (s.legacy && s.appReady) return { kind: "grace", cutoffAt: s.cutoffAt };
  if (s.dead) return { kind: s.deadReason === "old-token-removed" ? "removed" : "dead" };
  return null;
}

/* ------------------------------ admin ------------------------------ */
async function saveApp(body) {
  const out = await store.updateManapoolApp(cur => {
    if (body.clientId != null) cur.clientId = String(body.clientId).trim().slice(0, 200);
    if (body.clientSecret) cur.clientSecret = String(body.clientSecret).trim().slice(0, 500);
    cur.savedAt = new Date().toISOString();
    // The grace week starts the first time sellers can actually connect.
    if (!cur.graceStartAt && cur.clientId && cur.clientSecret) cur.graceStartAt = cur.savedAt;
  });
  await load();
  return out;
}
function appStatus() {
  return { clientId: app.clientId || "", hasSecret: !!app.hasSecret, ready: appReady(), redirectUri: redirectUri(),
    scopes: scopes(), graceStartAt: app.graceStartAt || null, cutoffAt: cutoffAt() };
}

/* After the grace week: delete every old pasted token (once; nothing can
   make a new one). The account is told why on its next page load. */
async function sweepLegacy(listUsers) {
  if (!legacyCutOff() || app.legacySweptAt) return { swept: 0, skipped: true };
  let swept = 0;
  for (const u of await listUsers()) {
    const prefs = await store.readPrefs(u.id).catch(() => null);
    if (!hasLegacy(prefs)) continue;
    await store.updatePrefs(u.id, p => {
      if (!hasLegacy(p)) return;
      delete p.manapool;
      if (!liveAuth(p)) p.manapoolAuth = { dead: { at: new Date().toISOString(), reason: "old-token-removed" } };
    });
    swept++;
  }
  await store.updateManapoolApp(cur => { cur.legacySweptAt = new Date().toISOString(); });
  await load();
  if (swept) log("removed " + swept + " old pasted Mana Pool token" + (swept === 1 ? "" : "s") + " (the grace week is over)");
  return { swept };
}

module.exports = {
  init, load, credsFor, credsFromPrefs, connected, usable, canWriteInventory, accessToken,
  startUrl, finish, disconnect, status, banner, saveApp, appStatus, sweepLegacy, cutoffAt, legacyCutOff,
  CALLBACK_PATH, RECONNECT, DEFAULT_SCOPES, GRACE_MS,
  _pending: pending
};
