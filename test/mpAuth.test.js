"use strict";
/* Mana Pool sign-in (#499): server/lib/mpAuth.js against a real store in a
   scratch dataDir (never the live one) and a fake auth server + API in
   fetch, so nothing reaches Mana Pool. Covers PKCE + state, the code
   exchange, tokens sealed at rest, one renewal at a time with the rotated
   refresh token saved, a refused renewal -> Reconnect, disconnect (revoke),
   "another app manages your listings", and the old token's grace week. */
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const mpAuth = lib("mpAuth");
const integrations = lib("integrations");

const dirs = [];
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

const CFG = { baseUrl: "https://grimoire.test", manapool: { enabled: true, baseUrl: "https://mp.test/api/v1/",
  paths: { orders: "seller/orders", createListing: "seller/inventory/scryfall_id" },
  oauth: { authBase: "https://auth.mp.test" } } };
integrations.init(CFG, { log: () => {} });

/* The fake: every request kept; tokens numbered so rotation is visible. */
let sent, n, onToken, onApi;
beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-mpauth-test-"));
  dirs.push(dir);
  store.init({ dataDir: dir });
  mpAuth._pending.clear();
  sent = []; n = 0;
  onToken = form => {
    n++;
    return { status: 200, body: { access_token: "at-" + n, refresh_token: "rt-" + n, expires_in: 3600, token_type: "bearer",
      scope: form.get("grant_type") === "authorization_code" ? "offline_access inventory:read inventory:write orders:read orders:write" : undefined } };
  };
  onApi = () => ({ status: 200, body: { inventory: [] } });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const req = { url: u, method: init.method, headers: init.headers || {}, body: init.body };
    sent.push(req);
    let a;
    if (u.host === "auth.mp.test" && u.pathname === "/oauth2/token") a = onToken(new URLSearchParams(init.body), req);
    else if (u.host === "auth.mp.test" && u.pathname === "/oauth2/revoke") a = { status: 200, body: {} };
    else a = onApi(req);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  };
  mpAuth.init(CFG, { log: () => {}, fetch: (...a) => globalThis.fetch(...a) });
  await mpAuth.load();
});

const setApp = () => mpAuth.saveApp({ clientId: "grimoire-client", clientSecret: "s3cret" });
async function connect(userId) {
  const url = new URL(await mpAuth.startUrl(userId));
  const out = await mpAuth.finish(userId, new URLSearchParams({ state: url.searchParams.get("state"), code: "code-1" }));
  return { url, out };
}

test("startUrl: Mana Pool's consent page with S256 PKCE, a fresh state, the scopes and the exact redirect URI", async () => {
  await assert.rejects(mpAuth.startUrl("u1"), /isn't registered with Mana Pool/, "no app: nobody can connect");
  await setApp();
  const u = new URL(await mpAuth.startUrl("u1"));
  assert.equal(u.origin + u.pathname, "https://auth.mp.test/oauth2/auth");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "grimoire-client");
  assert.equal(u.searchParams.get("redirect_uri"), "https://grimoire.test/api/manapool/oauth/callback");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("scope").split(" ").includes("offline_access"));
  const entry = mpAuth._pending.get(u.searchParams.get("state"));
  assert.equal(entry.userId, "u1");
  const challenge = crypto.createHash("sha256").update(entry.verifier).digest("base64url");
  assert.equal(u.searchParams.get("code_challenge"), challenge);
  const again = new URL(await mpAuth.startUrl("u1"));
  assert.notEqual(again.searchParams.get("state"), u.searchParams.get("state"), "a new state per attempt");
});

test("finish: trades the code with Basic auth + verifier, seals the tokens, deletes the old pasted token", async () => {
  await setApp();
  await store.writePrefs("u1", { manapool: { email: "me@x.test", accessToken: "old-token" } });
  const { url, out } = await connect("u1");
  assert.equal(out.result, "connected");
  assert.equal(out.redirect, "/settings.html?mp=connected#tab=integrations");
  const tok = sent.find(r => r.url.pathname === "/oauth2/token");
  assert.equal(tok.headers.Authorization, "Basic " + Buffer.from("grimoire-client:s3cret").toString("base64"));
  const form = new URLSearchParams(tok.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "code-1");
  assert.equal(form.get("redirect_uri"), url.searchParams.get("redirect_uri"));
  assert.ok(form.get("code_verifier"));
  const raw = fs.readFileSync(path.join(store.dir(), "users", "u1", "prefs.json"), "utf8");
  assert.doesNotMatch(raw, /at-1|rt-1|old-token|s3cret/, "nothing readable at rest");
  assert.match(raw, /gcm1:/);
  const p = await store.readPrefs("u1");
  assert.equal(p.manapool, undefined, "old token gone at once");
  assert.equal(p.manapoolAuth.refreshToken, "rt-1");
  const s = mpAuth.status(p);
  assert.equal(s.connected, true);
  assert.equal(s.hasToken, true);
  assert.equal(JSON.stringify(s).includes("rt-1") || JSON.stringify(s).includes("at-1"), false, "status never carries a token");
  const appRaw = fs.readFileSync(path.join(store.dir(), "manapool-app.json"), "utf8");
  assert.doesNotMatch(appRaw, /s3cret/);
  assert.equal(JSON.stringify(mpAuth.appStatus()).includes("s3cret"), false);
});

test("finish: an unknown, reused or other account's state is refused; Deny comes back as denied", async () => {
  await setApp();
  const u = new URL(await mpAuth.startUrl("u1"));
  const state = u.searchParams.get("state");
  assert.equal((await mpAuth.finish("u2", new URLSearchParams({ state, code: "c" }))).result, "expired", "another account");
  assert.equal((await mpAuth.finish("u1", new URLSearchParams({ state, code: "c" }))).result, "expired", "single use");
  assert.equal((await mpAuth.finish("u1", new URLSearchParams({ state: "made-up", code: "c" }))).result, "expired");
  const v = new URL(await mpAuth.startUrl("u1"));
  const denied = await mpAuth.finish("u1", new URLSearchParams({ state: v.searchParams.get("state"), error: "access_denied",
    error_description: "The resource owner denied the request" }));
  assert.equal(denied.result, "denied");
  assert.equal(denied.redirect, "/settings.html?mp=denied&inv=offer#tab=integrations",
    "any refusal of a request asking for listing rights offers Connect without listing changes");
  const w = new URL(await mpAuth.startUrl("u1", { withoutInventory: true }));
  assert.equal((await mpAuth.finish("u1", new URLSearchParams({ state: w.searchParams.get("state"), error: "access_denied" }))).redirect,
    "/settings.html?mp=denied#tab=integrations", "no offer when listing rights weren't asked for");
  assert.equal(sent.filter(r => r.url.pathname === "/oauth2/token").length, 0, "no code was traded");
});

test("another tool manages the listings: asks again without inventory:write, then listing writes say so", async () => {
  await setApp();
  const u = new URL(await mpAuth.startUrl("u1"));
  const out = await mpAuth.finish("u1", new URLSearchParams({ state: u.searchParams.get("state"), error: "access_denied",
    error_description: "Another integration already manages this seller's inventory" }));
  assert.equal(out.result, "retry-without-inventory");
  const retry = new URL(out.redirect);
  assert.ok(!retry.searchParams.get("scope").split(" ").includes("inventory:write"));
  assert.ok(retry.searchParams.get("scope").split(" ").includes("orders:write"));
  onToken = () => ({ status: 200, body: { access_token: "at-x", refresh_token: "rt-x", expires_in: 3600, scope: "offline_access inventory:read orders:read orders:write" } });
  const done = await mpAuth.finish("u1", new URLSearchParams({ state: retry.searchParams.get("state"), code: "c2" }));
  assert.equal(done.redirect, "/settings.html?mp=connected&inv=other#tab=integrations");
  const p = await store.readPrefs("u1");
  assert.equal(mpAuth.status(p).otherInventoryApp, true);
  const creds = mpAuth.credsFromPrefs("u1", p);
  await assert.rejects(integrations.manapoolList(creds, { scryfallId: "s1" }, { quantity: 1, price: 1 }),
    e => e.status === 409 && /Another app manages your Mana Pool listings/.test(e.message));
  await integrations.manapoolOrders(creds, {});   // reading orders still works
  assert.equal(sent.at(-1).headers.Authorization, "Bearer at-x");
});

test("access tokens: reused while fresh; renewed once for many callers; the rotated refresh token is saved", async () => {
  await setApp();
  await connect("u1");
  const creds = await mpAuth.credsFor("u1");
  await integrations.manapoolOrders(creds, {});
  assert.equal(sent.at(-1).headers.Authorization, "Bearer at-1");
  assert.equal(sent.filter(r => r.url.pathname === "/oauth2/token").length, 1, "still fresh: no renewal");
  await store.updatePrefs("u1", p => { p.manapoolAuth.expiresAt = Date.now() + 30000; });   // about to run out
  const toks = await Promise.all([1, 2, 3, 4].map(() => mpAuth.accessToken("u1")));
  assert.deepEqual(toks, ["at-2", "at-2", "at-2", "at-2"]);
  const renewals = sent.filter(r => r.url.pathname === "/oauth2/token").slice(1);
  assert.equal(renewals.length, 1, "one renewal at a time");
  assert.equal(new URLSearchParams(renewals[0].body).get("refresh_token"), "rt-1");
  const p = await store.readPrefs("u1");
  assert.equal(p.manapoolAuth.refreshToken, "rt-2");
  assert.equal(p.manapoolAuth.accessToken, "at-2");
  assert.deepEqual(p.manapoolAuth.scopes.includes("orders:write"), true, "scopes kept when a renewal doesn't list them");
});

test("a 401 on a live token gets one fresh token and one more try", async () => {
  await setApp();
  await connect("u1");
  let calls = 0;
  onApi = req => (++calls === 1 ? { status: 401, body: { message: "token expired" } } : { status: 200, body: { orders: [] } });
  await integrations.manapoolOrders(await mpAuth.credsFor("u1"), {});
  const api = sent.filter(r => r.url.host === "mp.test");
  assert.deepEqual(api.map(r => r.headers.Authorization), ["Bearer at-1", "Bearer at-2"]);
});

test("Mana Pool refuses a renewal: the connection is dead, screens say Reconnect, no loop of retries", async () => {
  await setApp();
  await connect("u1");
  await store.updatePrefs("u1", p => { p.manapoolAuth.expiresAt = 0; });
  onToken = () => ({ status: 400, body: { error: "invalid_grant", error_description: "token revoked" } });
  await assert.rejects(integrations.manapoolOrders(await mpAuth.credsFor("u1"), {}), /Reconnect Mana Pool in Settings/);
  const p = await store.readPrefs("u1");
  assert.equal(p.manapoolAuth.dead.reason, "refused");
  assert.equal(p.manapoolAuth.refreshToken, undefined, "dead tokens dropped");
  const creds = mpAuth.credsFromPrefs("u1", p);
  assert.equal(creds.dead, "refused");
  assert.equal(integrations.manapoolReady(creds), false);
  const before = sent.length;
  await assert.rejects(integrations.manapoolOrders(creds, {}), /ended Grimoire's connection.*Reconnect Mana Pool/);
  assert.equal(sent.length, before, "nothing sent once it's dead");
  assert.deepEqual(mpAuth.banner(p), { kind: "dead" });
});

test("disconnect: revokes the refresh token at Mana Pool, then forgets everything", async () => {
  await setApp();
  await connect("u1");
  const out = await mpAuth.disconnect("u1");
  assert.deepEqual(out, { ok: true, revoked: true, error: "" });
  const rev = sent.find(r => r.url.pathname === "/oauth2/revoke");
  assert.equal(new URLSearchParams(rev.body).get("token"), "rt-1");
  assert.match(rev.headers.Authorization, /^Basic /);
  const p = await store.readPrefs("u1");
  assert.equal(p.manapoolAuth, undefined);
  assert.equal(mpAuth.connected(p), false);
});

test("the old pasted token: works with no banner until the app is saved, then a 7-day grace, then it's deleted", async () => {
  const legacy = { manapool: { email: "me@x.test", accessToken: "old-token" } };
  await store.writePrefs("u1", legacy);
  await store.writePrefs("u2", { theme: "dark" });
  let p = await store.readPrefs("u1");
  assert.equal(mpAuth.credsFromPrefs("u1", p).legacy, true);
  assert.equal(mpAuth.banner(p), null, "nobody can connect yet, so no reminder");
  await setApp();
  const start = Date.parse(mpAuth.appStatus().graceStartAt);
  assert.equal(Date.parse(mpAuth.cutoffAt()) - start, 7 * 86400000);
  await mpAuth.saveApp({ clientId: "grimoire-client" });
  assert.equal(Date.parse(mpAuth.appStatus().graceStartAt), start, "a later save doesn't restart the week");
  const b = mpAuth.banner(p);
  assert.equal(b.kind, "grace");
  assert.equal(b.cutoffAt, mpAuth.cutoffAt());
  assert.equal((await mpAuth.sweepLegacy(async () => [{ id: "u1" }, { id: "u2" }])).skipped, true, "not before the cut-off");
  // The legacy headers still go out during the week.
  await integrations.manapoolOrders(mpAuth.credsFromPrefs("u1", p), {});
  assert.equal(sent.at(-1).headers["X-ManaPool-Access-Token"], "old-token");

  await store.updateManapoolApp(cur => { cur.graceStartAt = new Date(Date.now() - 8 * 86400000).toISOString(); });
  await mpAuth.load();
  p = await store.readPrefs("u1");
  assert.deepEqual(mpAuth.credsFromPrefs("u1", p), {}, "past the cut-off it stops at once, before any sweep");
  assert.equal(mpAuth.connected(p), false);
  const out = await mpAuth.sweepLegacy(async () => [{ id: "u1" }, { id: "u2" }]);
  assert.equal(out.swept, 1);
  p = await store.readPrefs("u1");
  assert.equal(p.manapool, undefined);
  assert.equal(p.manapoolAuth.dead.reason, "old-token-removed");
  assert.deepEqual(mpAuth.banner(p), { kind: "removed" });
  assert.deepEqual(await store.readPrefs("u2"), { theme: "dark" });
  assert.equal((await mpAuth.sweepLegacy(async () => { throw new Error("not again"); })).skipped, true, "only once");
});
