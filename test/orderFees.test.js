"use strict";
/* One-time backfill of Manapool fees and shipping on old sales (#452),
   server/lib/orderFees.js. Against a scratch dataDir via store.init(),
   never the live one; Manapool itself is a stub passed as fetchOrder. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const orderFees = lib("orderFees");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const UUID = n => "0000000" + n + "-aaaa-bbbb-cccc-dddddddddddd";
const PAY = n => ({ subtotal: 10 * n, shipping: 1.5, total: 10 * n + 1.5, fee: n, net: 9 * n + 1.5 });
const line = [{ name: "Lightning Bolt", qty: 1 }];
const sale = (id, orderId, extra) => Object.assign({ id, source: "manapool", orderId, orderLabel: "L-" + id,
  orderPayment: null, status: "shipped", pickedAt: "2026-09-05T12:00:00.000Z",
  revenue: 10, cogs: 4, shippingRevenue: null, fees: null, earnings: null, lines: [] }, extra);

/* alice: sale 1's order is cached with payment; sale 2's has lines but no
   payment (fetched from Manapool through alice's connection); sale 3's is
   gone at Manapool (404); sale 4 already has its fees; an open list; a
   counter sale; a sale whose order is in no cache. Store s1: a sale whose
   order is in bob's cache, so it goes through bob's connection. */
async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-orderfees-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const alice = await auth.createUser({ username: "alice", password: "correct-horse-1" });
  const bob = await auth.createUser({ username: "bob", password: "correct-horse-1" });
  await store.updatePrefs(alice.id, p => { p.manapool = { email: "a@example.com", accessToken: "tok-a" }; });
  await store.updatePrefs(bob.id, p => { p.manapool = { email: "b@example.com", accessToken: "tok-b" }; });
  await store.writeStoreList({ stores: [{ id: "s1", orgId: "org1", name: "One", archived: false }] });
  await store.writeOrders(alice.id, { orders: [
    { id: UUID(1), status: "shipped", lines: line, payment: PAY(1) },
    { id: UUID(2), status: "shipped", lines: line, payment: null },
    { id: UUID(3), status: "shipped", lines: line, payment: null },
    { id: UUID(4), status: "shipped", lines: line, payment: PAY(4) }] });
  await store.writeOrders(bob.id, { orders: [{ id: UUID(5), status: "delivered", lines: line }] });
  await store.writeCollection(alice.id, { cards: [{ id: "c1" }], locations: [], pickLists: [
    sale("PICK-1", UUID(1)),
    sale("PICK-2", UUID(2)),
    sale("PICK-3", UUID(3)),
    sale("PICK-4", UUID(4), { fees: 4, earnings: 37.5, shippingRevenue: 1.5, revenue: 11.5, orderPayment: PAY(4) }),
    sale("PICK-5", UUID(1), { status: "open", pickedAt: null, revenue: null, cogs: null }),
    sale("PICK-6", null, { source: "counter" }),
    sale("PICK-9", UUID(9))] });
  await store.writeCollection("store:s1", { cards: [], locations: [], pickLists: [sale("PICK-1", UUID(5))] });
  return { alice, bob };
}

/* Manapool stub: knows orders 2 and 5, says 404 for anything else. */
function stub(calls, opts) {
  return async (creds, id) => {
    calls.push({ token: creds.accessToken, id });
    if (opts && opts.down) throw Object.assign(new Error("The request timed out."), { status: 504 });
    if (id === UUID(2)) return { id, status: "shipped", lines: line, payment: PAY(2) };
    if (id === UUID(5)) return { id, status: "delivered", lines: line, payment: PAY(5) };
    throw Object.assign(new Error("HTTP 404"), { status: 502, upstream: 404 });
  };
}
const lists = async key => (await store.readCollection(key)).state.pickLists;
const byId = (arr, id) => arr.find(p => p.id === id);

test("fills fees, earnings and shipping from the cache or a fresh fetch; adds shipping into revenue once", async () => {
  const { alice, bob } = await seed();
  const calls = [];
  const out = await orderFees.backfillFeesOnce({ fetchOrder: stub(calls) });
  const a = await lists(alice.id);
  // From alice's cache, no fetch.
  assert.deepEqual(byId(a, "PICK-1"), Object.assign(sale("PICK-1", UUID(1)), {
    orderPayment: PAY(1), fees: 1, earnings: 10.5, shippingRevenue: 1.5, revenue: 11.5 }));
  // Fetched through alice's own connection.
  const p2 = byId(a, "PICK-2");
  assert.equal(p2.fees, 2); assert.equal(p2.earnings, 19.5); assert.equal(p2.shippingRevenue, 1.5); assert.equal(p2.revenue, 11.5);
  // 404 at Manapool and not in any cache: left null for the Accounting note.
  for (const id of ["PICK-3", "PICK-9"]) { const p = byId(a, id); assert.equal(p.fees, null); assert.equal(p.revenue, 10); }
  // Already right, an open list, a counter sale: untouched.
  assert.equal(byId(a, "PICK-4").revenue, 11.5);
  assert.equal(byId(a, "PICK-5").fees, null);
  assert.equal(byId(a, "PICK-6").fees, null);
  // The store's sale went through bob, whose cache holds that order.
  const s = byId(await lists("store:s1"), "PICK-1");
  assert.equal(s.fees, 5); assert.equal(s.revenue, 11.5);
  assert.deepEqual(calls.map(c => c.token + " " + c.id).sort(), ["tok-a " + UUID(2), "tok-a " + UUID(3), "tok-b " + UUID(5)].sort());
  // The orders caches are fixed too, so Fetch orders stops re-asking.
  const ao = (await store.readOrders(alice.id)).orders;
  assert.deepEqual(ao.find(o => o.id === UUID(2)).payment, PAY(2));
  assert.equal(ao.find(o => o.id === UUID(2)).paymentUnavailable, false);
  assert.deepEqual((await store.readOrders(bob.id)).orders[0].payment, PAY(5));
  assert.equal(out.filled, 3); assert.equal(out.owners, 2); assert.equal(out.fetched, 2); assert.equal(out.retry, false);
  assert.ok((await store.readMigrations())[orderFees.MARKER], "marked done");
  assert.equal(await orderFees.backfillFeesOnce({ fetchOrder: stub(calls) }), null, "once per data directory");
});

test("a second run changes nothing: no shipping added twice, no new rev", async () => {
  const { alice } = await seed();
  await orderFees.backfillFees({ fetchOrder: stub([]) });
  const rev = (await store.readCollection(alice.id)).rev;
  const before = await lists(alice.id);
  const out = await orderFees.backfillFees({ fetchOrder: stub([]) });
  assert.equal(out.filled, 0);
  assert.equal((await store.readCollection(alice.id)).rev, rev);
  assert.deepEqual(await lists(alice.id), before);
});

test("a sale with shipping already counted only gets its fees", () => {
  const state = { pickLists: [sale("PICK-1", UUID(1), { shippingRevenue: 1.5, revenue: 11.5 })] };
  const r = orderFees.fillFees(state, new Map([[UUID(1), PAY(1)]]));
  assert.deepEqual(r, { filled: 1, missing: 0 });
  assert.equal(state.pickLists[0].revenue, 11.5);
  assert.equal(state.pickLists[0].fees, 1);
});

test("a payment kept only under raw (fetched before payment was normalized) is used without a fetch", () => {
  const order = { id: UUID(1), lines: line, raw: { id: UUID(1), payment: { subtotal_cents: 1000, shipping_cents: 150, total_cents: 1150, fee_cents: 100, net_cents: 1050 } } };
  assert.deepEqual(orderFees.paymentOf(order), { subtotal: 10, shipping: 1.5, total: 11.5, fee: 1, net: 10.5 });
  assert.equal(orderFees.paymentOf({ id: UUID(1), raw: { id: UUID(1) } }), null);
});

test("Manapool down: fills what the caches have, stops asking, retries on later boots up to the limit", async () => {
  const { alice } = await seed();
  const calls = [];
  const out = await orderFees.backfillFeesOnce({ fetchOrder: stub(calls, { down: true }) });
  assert.equal(out.retry, true);
  assert.equal(byId(await lists(alice.id), "PICK-1").fees, 1, "cached payment filled anyway");
  assert.equal(byId(await lists(alice.id), "PICK-2").fees, null);
  assert.ok(calls.filter(c => c.token === "tok-a").length <= 3, "stops asking on alice's behalf after the first failures");
  assert.equal((await store.readMigrations())[orderFees.MARKER], undefined, "not done: tries again next boot");
  // Back up on the next boot: the rest is filled and it's done.
  const out2 = await orderFees.backfillFeesOnce({ fetchOrder: stub([]) });
  assert.equal(out2.retry, false);
  assert.equal(byId(await lists(alice.id), "PICK-2").fees, 2);
  assert.ok((await store.readMigrations())[orderFees.MARKER]);
});

test("still down after the last try: marked done with the rest left null", async () => {
  await seed();
  for (let i = 1; i < orderFees.MAX_TRIES; i++) await orderFees.backfillFeesOnce({ fetchOrder: stub([], { down: true }) });
  assert.equal((await store.readMigrations())[orderFees.MARKER], undefined);
  const last = await orderFees.backfillFeesOnce({ fetchOrder: stub([], { down: true }) });
  assert.equal(last.tries, orderFees.MAX_TRIES);
  assert.ok((await store.readMigrations())[orderFees.MARKER]);
});

test("an account with no Manapool connection: its sales are left null and the run still finishes", async () => {
  const { alice } = await seed();
  await store.updatePrefs(alice.id, p => { delete p.manapool; });
  const fetchOrder = async (creds, id) => {
    if (!creds.accessToken) throw Object.assign(new Error("Manapool is not connected."), { status: 501 });
    return stub([])(creds, id);
  };
  const out = await orderFees.backfillFeesOnce({ fetchOrder });
  assert.equal(out.retry, false);
  assert.equal(byId(await lists(alice.id), "PICK-2").fees, null);
  assert.equal(byId(await lists("store:s1"), "PICK-1").fees, 5);
  assert.ok((await store.readMigrations())[orderFees.MARKER]);
});

test("a tab still holding the old rev merges its next save instead of wiping the fees", async () => {
  const { alice } = await seed();
  const open = await store.readCollection(alice.id); // what an open tab loaded
  await orderFees.backfillFees({ fetchOrder: stub([]) });
  open.state.cards.push({ id: "c2" }); // the tab's own edit
  const r = await store.writeCollection(alice.id, open.state, open.rev);
  assert.equal(r.merged, true);
  const a = await lists(alice.id);
  assert.equal(byId(a, "PICK-1").fees, 1);
  assert.equal(byId(a, "PICK-1").revenue, 11.5);
  assert.deepEqual((await store.readCollection(alice.id)).state.cards.map(c => c.id), ["c1", "c2"]);
});

test("a list shipped before sales were recorded (no pickedAt, no revenue) is left untouched", () => {
  const old = sale("PICK-0", UUID(1), { pickedAt: null, revenue: null, cogs: null });
  const state = { pickLists: [old] };
  assert.equal(orderFees.needsFees(old), false);
  assert.deepEqual(orderFees.fillFees(state, new Map([[UUID(1), PAY(1)]])), { filled: 0, missing: 0 });
  assert.deepEqual(state.pickLists[0], sale("PICK-0", UUID(1), { pickedAt: null, revenue: null, cogs: null }));
});
