"use strict";
/* Mark shipped also marks the order shipped on Manapool (#454):
   integrations.js's request (PUT /seller/orders/{id}/fulfillment), the
   tracking-required rule, 409 as done, and server/lib/orderShip.js finding
   whose connection to send it through. Real store against a scratch dataDir
   (never the live one); fetch is a local fake, so nothing reaches Manapool. */
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const integrations = lib("integrations");
const orderShip = lib("orderShip");

const tmpDirs = [];
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});
integrations.init({ manapool: { enabled: true, baseUrl: "https://mp.test/api/v1/" } }, { log: () => {} });

/* The fake Manapool: every request is kept; `answer` says what comes back. */
let sent = [];
let answer = () => ({ status: 200, body: { fulfillment: { status: "shipped" } } });
beforeEach(() => {
  sent = [];
  answer = () => ({ status: 200, body: { fulfillment: { status: "shipped" } } });
  globalThis.fetch = async (url, init) => {
    const req = { url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    sent.push(req);
    const a = answer(req);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  };
});

const OID = n => "f4b3b9c5-250e-4c3a-815d-6e41577f28e" + n;
const CREDS = who => ({ email: who + "@example.com", accessToken: "token-" + who });

/* ---------------- The request ---------------- */

test("mpFulfillmentBody: status shipped; tracking only with a number; USPS gets its tracking link", () => {
  assert.deepEqual(integrations.mpFulfillmentBody(null), { status: "shipped" });
  assert.deepEqual(integrations.mpFulfillmentBody({ company: "USPS", number: "  " }), { status: "shipped" });
  assert.deepEqual(integrations.mpFulfillmentBody({ company: "USPS", number: " 9400 1 " }), {
    status: "shipped", tracking_number: "9400 1", tracking_company: "USPS",
    tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201"
  });
  assert.deepEqual(integrations.mpFulfillmentBody({ company: "UPS", number: "1Z9" }),
    { status: "shipped", tracking_number: "1Z9", tracking_company: "UPS" }, "no made-up link for other carriers");
  assert.equal(integrations.mpFulfillmentBody({ company: "UPS", number: "1Z9", url: "https://ups.test/t/1Z9" }).tracking_url,
    "https://ups.test/t/1Z9");
  assert.equal(integrations.mpFulfillmentBody({ company: "UPS", number: "1Z9", url: "javascript:alert(1)" }).tracking_url,
    undefined, "only http/https links");
});

test("orderNeedsTracking: ground_advantage needs it, first_class and unknown don't; reads an older cache's raw", () => {
  assert.equal(integrations.orderNeedsTracking({ shippingMethod: "ground_advantage" }), true);
  assert.equal(integrations.orderNeedsTracking({ raw: { shipping_method: "ground_advantage" } }), true);
  assert.equal(integrations.orderNeedsTracking({ shippingMethod: "first_class" }), false);
  assert.equal(integrations.orderNeedsTracking({ raw: {} }), false);
  assert.equal(integrations.orderNeedsTracking(null), false);
  assert.equal(integrations.normalizeOrder({ id: "x", shipping_method: "ground_advantage" }).shippingMethod, "ground_advantage");
});

test("manapoolMarkShipped: one PUT to the order's fulfillment, with the account's own headers", async () => {
  const out = await integrations.manapoolMarkShipped(CREDS("ann"), OID(1), { company: "USPS", number: "9400" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "PUT");
  assert.equal(sent[0].url, "https://mp.test/api/v1/seller/orders/" + OID(1) + "/fulfillment");
  assert.equal(sent[0].headers["X-ManaPool-Email"], "ann@example.com");
  assert.equal(sent[0].headers["X-ManaPool-Access-Token"], "token-ann");
  assert.deepEqual(sent[0].body, { status: "shipped", tracking_number: "9400", tracking_company: "USPS",
    tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400" });
  assert.deepEqual(out, { ok: true, alreadyDone: false, sent: sent[0].body, status: "shipped" });
});

test("manapoolMarkShipped: 409 (already shipped / released) counts as done, not an error", async () => {
  answer = () => ({ status: 409, body: { status: 409, message: "Order already released" } });
  const out = await integrations.manapoolMarkShipped(CREDS("ann"), OID(1), null);
  assert.equal(out.ok, true);
  assert.equal(out.alreadyDone, true);
  assert.equal(sent.length, 1, "not retried");
});

test("manapoolMarkShipped: any other refusal throws, and reads as plain words", async () => {
  answer = () => ({ status: 400, body: { status: 400, message: "Invalid request", details: ["tracking_url must be a URL"] } });
  const e = await integrations.manapoolMarkShipped(CREDS("ann"), OID(1), null).then(() => null, x => x);
  assert.ok(e, "threw");
  assert.equal(integrations.mpShipFailure(e), "Manapool refused it: Invalid request: tracking_url must be a URL");
  assert.match(integrations.mpShipFailure({ upstream: 401 }), /Reconnect Mana Pool in Settings → Integrations/);
  assert.equal(integrations.mpShipFailure({ upstream: 404 }), "Manapool has no such order on this account.");
  assert.equal(integrations.mpShipFailure(new TypeError("fetch failed")), "Couldn't reach Manapool.");
  assert.doesNotMatch(integrations.mpShipFailure(e), /https?:|token-/, "no URL or token in what the owner reads");
});

/* ---------------- Whose connection, and what's recorded ---------------- */

/* alice: personal account with her own cache and connection. In org1's store
   s1: owen (owner, no orders of his own, no connection), sam (staff on s1,
   holds the store's orders and the connection), and tess (staff on s2 only,
   holds an order too). carol is in another org. */
async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-ordership-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const mk = n => auth.createUser({ username: n, password: "correct-horse-1" });
  const [alice, owen, sam, tess, carol] = [await mk("alice"), await mk("owen"), await mk("sam"), await mk("tess"), await mk("carol")];
  await store.writeStoreList({ stores: [{ id: "s1", orgId: "org1", name: "One", archived: false },
    { id: "s2", orgId: "org1", name: "Two", archived: false }, { id: "s9", orgId: "org9", name: "Nine", archived: false }] });
  const db = await store.readUsers();
  const set = (u, f) => Object.assign(db.users.find(x => x.id === u.id), f);
  set(owen, { orgId: "org1", orgRole: "owner", storeIds: [] });
  set(sam, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  set(tess, { orgId: "org1", orgRole: "staff", storeIds: ["s2"] });
  set(carol, { orgId: "org9", orgRole: "owner", storeIds: [] });
  await store.writeUsers(db);
  const users = (await store.readUsers()).users;
  const u = x => users.find(y => y.id === x.id);
  await store.writePrefs(alice.id, { manapool: CREDS("alice") });
  await store.writePrefs(sam.id, { manapool: CREDS("sam") });
  await store.writePrefs(tess.id, { manapool: CREDS("tess") });
  await store.writePrefs(carol.id, { manapool: CREDS("carol") });
  await store.writeOrders(alice.id, { orders: [
    { id: OID(1), status: "unfulfilled", shippingMethod: "first_class" },
    { id: OID(2), status: "processing", raw: { shipping_method: "ground_advantage" } }] });
  await store.writeOrders(sam.id, { orders: [{ id: OID(3), status: "unfulfilled", raw: { shipping_method: "first_class" } }] });
  await store.writeOrders(tess.id, { orders: [{ id: OID(4), status: "unfulfilled", shippingMethod: "first_class" }] });
  await store.writeOrders(carol.id, { orders: [{ id: OID(5), status: "unfulfilled", shippingMethod: "first_class" }] });
  return { alice: u(alice), owen: u(owen), sam: u(sam), tess: u(tess), carol: u(carol) };
}
const cached = async (user, id) => (await store.readOrders(user.id)).orders.find(o => o.id === id);

test("pushShipped: a first-class order goes with no tracking, and its cache shows it shipped", async () => {
  const { alice } = await seed();
  const rec = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(1), tracking: null });
  assert.equal(rec.ok, true);
  assert.equal(rec.alreadyDone, false);
  assert.equal(rec.tracking, null);
  assert.ok(rec.at);
  assert.deepEqual(sent.map(r => r.body), [{ status: "shipped" }]);
  assert.equal(sent[0].headers["X-ManaPool-Email"], "alice@example.com");
  const o = await cached(alice, OID(1));
  assert.equal(o.status, "shipped");
  assert.equal(o.grimoire.manapoolShippedAt, rec.at);
});

test("pushShipped: a Ground Advantage order with no tracking number is refused here, nothing sent", async () => {
  const { alice } = await seed();
  const rec = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(2), tracking: { company: "USPS", number: " " } });
  assert.equal(rec.ok, false);
  assert.equal(rec.needsTracking, true);
  assert.match(rec.error, /tracking number/);
  assert.equal(sent.length, 0);
  assert.equal((await cached(alice, OID(2))).status, "processing");
});

test("pushShipped: a Ground Advantage order with its tracking number sends it", async () => {
  const { alice } = await seed();
  const rec = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(2), tracking: { company: "USPS", number: "9400111" } });
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.tracking, { company: "USPS", number: "9400111", url: "" });
  assert.equal(sent[0].body.tracking_number, "9400111");
  assert.equal(sent[0].body.tracking_company, "USPS");
  assert.equal((await cached(alice, OID(2))).grimoire.tracking, "9400111");
});

test("pushShipped: 409 is recorded as done", async () => {
  const { alice } = await seed();
  answer = () => ({ status: 409, body: { status: 409, message: "already released" } });
  const rec = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(1) });
  assert.equal(rec.ok, true);
  assert.equal(rec.alreadyDone, true);
});

test("pushShipped: a refusal is recorded with its reason, the cache untouched; a retry that works records ok", async () => {
  const { alice } = await seed();
  answer = () => ({ status: 401, body: { status: 401, message: "Unauthorized" } });
  const rec = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(1) });
  assert.equal(rec.ok, false);
  assert.match(rec.error, /Settings → Integrations/);
  assert.equal((await cached(alice, OID(1))).status, "unfulfilled");
  answer = () => ({ status: 200, body: { fulfillment: { status: "shipped" } } });
  const again = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(1) });
  assert.equal(again.ok, true);
  assert.equal(sent.length, 2);
  assert.equal((await cached(alice, OID(1))).status, "shipped");
});

test("pushShipped: a store's order goes through the teammate whose cache holds it", async () => {
  const { owen, sam } = await seed();
  const rec = await orderShip.pushShipped({ user: owen, docOwner: "store:s1", orderId: OID(3) });
  assert.equal(rec.ok, true);
  assert.equal(sent[0].headers["X-ManaPool-Email"], "sam@example.com");
  assert.equal((await cached(sam, OID(3))).status, "shipped");
});

test("pushShipped: never through someone outside the caller's cache and current store", async () => {
  const { owen, alice, sam } = await seed();
  // tess holds OID(4) but only works store s2; owen is acting for s1.
  for (const [user, docOwner, id] of [[owen, "store:s1", OID(4)], [owen, "store:s1", OID(5)], [alice, alice.id, OID(3)],
    [sam, "store:s1", OID(5)]]) {
    const rec = await orderShip.pushShipped({ user, docOwner, orderId: id });
    assert.equal(rec.ok, false, user.username + " -> " + id);
    assert.match(rec.error, /Fetch orders/);
  }
  assert.equal(sent.length, 0);
});

test("pushShipped: Manapool turned off on the server sends nothing", async () => {
  const { alice } = await seed();
  integrations.init({ manapool: { enabled: false } }, { log: () => {} });
  try {
    const rec = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(1) });
    assert.equal(rec.ok, false);
    assert.equal(sent.length, 0);
  } finally {
    integrations.init({ manapool: { enabled: true, baseUrl: "https://mp.test/api/v1/" } }, { log: () => {} });
  }
});

/* ---------------- An order Manapool replaced or cancelled (#489) ---------------- */

test("pushShipped: an order its cache has as replaced is refused, nothing sent; cancelledOrders lists it for the whole store", async () => {
  const { alice, owen, sam } = await seed();
  await store.updateOrders(alice.id, doc => { doc.orders[0].status = "replaced"; });
  const rec = await orderShip.pushShipped({ user: alice, docOwner: alice.id, orderId: OID(1), tracking: null });
  assert.equal(rec.ok, false);
  assert.equal(rec.cancelled, "replaced");
  assert.match(rec.error, /as replaced/);
  assert.equal(sent.length, 0);
  assert.equal((await cached(alice, OID(1))).status, "replaced", "the cache keeps Manapool's word");
  assert.deepEqual(await orderShip.cancelledOrders(alice, alice.id), [{ id: OID(1), status: "replaced" }]);

  await store.updateOrders(sam.id, doc => { doc.orders[0].status = "Canceled"; });
  assert.deepEqual(await orderShip.cancelledOrders(owen, "store:s1"), [{ id: OID(3), status: "canceled" }],
    "a teammate's cache counts, read again once it changes");
  const viaStore = await orderShip.pushShipped({ user: owen, docOwner: "store:s1", orderId: OID(3) });
  assert.equal(viaStore.ok, false);
  assert.match(viaStore.error, /as cancelled/);
  assert.equal(sent.length, 0);
});
