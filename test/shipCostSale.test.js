"use strict";
/* #457 part 3: a sale's packing + postage cost. Frozen on the sale when a
   Manapool order's pick list is completed (core.js), filled once onto older
   sales by the server's backfill (server/lib/shipCostBackfill.js), both
   through public/js/shipCost.js costSale, and taken off net profit in the
   P&L. Counter sales and hand-made picks never get one. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ShipCost = require(path.join(__dirname, "..", "public", "js", "shipCost"));
const { freshCoreWithLocation } = require("../test-lib/core-shim");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const backfill = lib("shipCostBackfill");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

/* ---------- the shared helpers ---------- */
test("saleOrder: copies actually pulled (or the line qty), value without the buyer's shipping", () => {
  const p = { revenue: 21.5, shippingRevenue: 1.5, lines: [
    { qty: 3, pickedResult: { pulls: [{ qty: 2 }] } },   // short one: 2 went out
    { qty: 4 }] };                                        // no pickedResult: its qty
  assert.deepEqual(ShipCost.saleOrder(p, true), { cards: 6, value: 20, tracked: true });
  assert.deepEqual(ShipCost.saleOrder({}, false), { cards: 0, value: 0, tracked: false });
});

test("costSale: frozen totals and the rule; null with no copies", () => {
  const p = { revenue: 10, shippingRevenue: 0, lines: [{ qty: 4 }] };
  const c = ShipCost.costSale(p, false, undefined, "2026-11-12T00:00:00.000Z");
  assert.deepEqual(c, { total: 1.06, supplies: 0.24, postage: 0.82, oz: 0.98, rule: "letter", ruleName: "Letter",
    kind: "letter", extraOunces: 0, fallback: false, at: "2026-11-12T00:00:00.000Z" });
  assert.equal(ShipCost.costSale(p, true).kind, "mailer", "a tracked order never goes as a letter");
  assert.equal(ShipCost.costSale({ lines: [] }, false), null);
});

test("needsShipCost: only a completed Manapool order's sale that never had one", () => {
  const sale = extra => Object.assign({ source: "manapool", orderId: "o1", pickedAt: "2026-09-01T00:00:00Z", status: "shipped" }, extra);
  assert.equal(ShipCost.needsShipCost(sale()), true);
  assert.equal(ShipCost.needsShipCost(sale({ status: "picked" })), true);
  assert.equal(ShipCost.needsShipCost(sale({ shipCost: null })), false, "worked out once already, even as none");
  assert.equal(ShipCost.needsShipCost(sale({ shipCost: { total: 1 } })), false);
  assert.equal(ShipCost.needsShipCost(sale({ status: "open" })), false);
  assert.equal(ShipCost.needsShipCost(sale({ pickedAt: null })), false, "no pickedAt: not a sale");
  assert.equal(ShipCost.needsShipCost(sale({ source: "walkin" })), false);
  assert.equal(ShipCost.needsShipCost(sale({ orderId: null })), false);
});

/* ---------- completion (core.js) + P&L ---------- */
const CARD_INFO = { name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {} };
function stocked() {
  const G = freshCoreWithLocation();
  G.state.locations.find(l => l.id === "loc1").sellFrom = true;
  G.addCopies({ set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM", locationId: "loc1", qty: 20,
    info: CARD_INFO, unitCost: 0.1, action: "receipt", receiptId: "T1", note: "" });
  return G;
}
function complete(G, listOpts, qty) {
  const pl = G.newPickList(listOpts);
  G.pickLists().push(pl);
  G.addToPickList(pl.id, { kind: "card", set: "a25", collector: "141", lang: "en", finish: "nonfoil",
    condition: "NM", name: "Lightning Bolt", qty, unitPrice: 2.5 });
  G.completePickList(pl.id);
  return pl;
}

test("completing a Manapool order's list freezes its shipping cost from Settings → Shipping", () => {
  const G = stocked();
  const pl = complete(G, { source: "manapool", orderId: "order-1" }, 4);
  assert.equal(pl.shipCost.rule, "letter");
  assert.equal(pl.shipCost.total, 1.06);
  assert.ok(pl.shipCost.at);

  // The account's own setup is used, and changing it later doesn't move this sale.
  const cfg = ShipCost.defaults();
  cfg.postage.stamp = 1;
  G.state.settings.shipping = cfg;
  const pl2 = complete(G, { source: "manapool", orderId: "order-2" }, 4);
  assert.equal(pl2.shipCost.postage, 1);
  assert.equal(pl.shipCost.postage, 0.82, "the first sale keeps what it was worked out with");
  assert.equal(G.saleShipCost(pl2), 1.24);
});

test("a counter sale or a hand-made pick gets no shipping cost", () => {
  const G = stocked();
  const manual = complete(G, { source: "manual" }, 2);
  assert.equal(manual.shipCost, undefined);
  assert.equal(G.saleShipCost(manual), 0);
});

test("P&L: shipping is its own column and comes off net profit", () => {
  const G = stocked();
  const sale = (date, revenue, cogs, fees, shipping) => ({ date, type: "Sale", revenue, cogs, fees, shipping });
  const from = Date.parse("2026-09-01T00:00:00Z"), to = Date.parse("2026-09-30T23:59:59Z");
  const { totals } = G.pnlByMonth([sale("2026-09-10T12:00:00Z", 20, 5, 2, 1.06), sale("2026-09-11T12:00:00Z", 10, 2, 1)], from, to);
  assert.equal(totals.shipping, 1.06);
  assert.equal(totals.gross, 23);
  assert.equal(totals.net, 18.94, "30 - 7 cogs - 3 fees - 1.06 shipping");

  // profitBetween (the Dashboard's tile) reads the frozen cost off each sale.
  const pl = complete(G, { source: "manapool", orderId: "order-9" }, 4);
  const t = G.profitBetween(Date.now() - 60000, Date.now() + 60000);
  assert.equal(t.shipping, pl.shipCost.total);
  assert.equal(t.net, Math.round((pl.revenue - pl.cogs - pl.shipCost.total) * 100) / 100, "no fees fetched: counted as $0");
});

/* ---------- the one-time backfill (server) ---------- */
const sale = (id, extra) => Object.assign({ id, source: "manapool", orderId: "o-" + id, status: "shipped",
  pickedAt: "2026-09-05T12:00:00.000Z", revenue: 11.5, cogs: 4, shippingRevenue: 1.5, fees: 1,
  lines: [{ qty: 4, pickedResult: { pulls: [{ qty: 4 }] } }] }, extra);

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-shipcost-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const alice = await auth.createUser({ username: "alice", password: "correct-horse-1" });
  await store.writeStoreList({ stores: [{ id: "s1", orgId: "org1", name: "One", archived: false }] });
  const stampTwo = ShipCost.defaults();
  stampTwo.postage.stamp = 2;
  await store.writeCollection(alice.id, { cards: [], locations: [], pickLists: [
    sale("PICK-1"),
    sale("PICK-2", { shippingMethod: "ground_advantage" }),
    sale("PICK-3", { shipCost: { total: 9 } }),
    sale("PICK-4", { status: "open", pickedAt: null }),
    sale("PICK-5", { source: "walkin", orderId: null }),
    sale("PICK-6", { pickedAt: null }),
    sale("PICK-7"),                                         // older ticket: no shippingMethod, its cached order is tracked
    sale("PICK-8", { shippingMethod: "first_class" })] });  // the ticket's own method wins over the cache
  // Orders caches (one per signed-in user), shaped both ways the cache has kept them.
  await store.writeOrders(alice.id, { orders: [
    { id: "o-PICK-7", raw: { shipping_method: "ground_advantage" } },
    { id: "o-PICK-8", shippingMethod: "ground_advantage" },
    { id: "o-PICK-1", shippingMethod: "first_class" }] });
  await store.writeCollection("store:s1", { cards: [], locations: [], settings: { shipping: stampTwo }, pickLists: [sale("PICK-1")] });
  return { alice };
}
const lists = async key => (await store.readCollection(key)).state.pickLists;
const byId = (arr, id) => arr.find(p => p.id === id);

test("backfill: every older Manapool sale gets today's cost once, from its own account's setup", async () => {
  const { alice } = await seed();
  const out = await backfill.backfillShipCostsOnce({ at: "2026-11-12T00:00:00.000Z" });
  assert.equal(out.filled, 5);
  assert.equal(out.owners, 2);
  const a = await lists(alice.id);
  assert.equal(byId(a, "PICK-1").shipCost.rule, "letter", "suggested setup: 4 cards, $10 of goods");
  assert.equal(byId(a, "PICK-1").shipCost.total, 1.06);
  assert.equal(byId(a, "PICK-2").shipCost.kind, "mailer", "ground_advantage needs tracking");
  assert.equal(byId(a, "PICK-7").shipCost.kind, "mailer", "an older ticket's tracked order, from the orders cache");
  assert.equal(byId(a, "PICK-8").shipCost.kind, "letter", "the ticket's own shipping method wins");
  assert.deepEqual(byId(a, "PICK-3").shipCost, { total: 9 }, "one already there is left alone");
  for (const id of ["PICK-4", "PICK-5", "PICK-6"]) assert.equal(byId(a, id).shipCost, undefined, id + " isn't a Manapool sale");
  const s = await lists("store:s1");
  assert.equal(s[0].shipCost.postage, 2, "the store's own Settings → Shipping");

  assert.ok((await store.readMigrations())[backfill.MARKER], "marked done");
  assert.equal(await backfill.backfillShipCostsOnce(), null, "once per data directory");
  const again = await backfill.backfillShipCosts();
  assert.equal(again.filled, 0, "a second run changes nothing");
});

test("backfill: an unreadable orders cache waits for a later boot instead of guessing letters", async () => {
  const { alice } = await seed();
  fs.mkdirSync(store.p("orders/bad.json"));   // a read error (a corrupt file is moved aside and reads as empty instead)
  const first = await backfill.backfillShipCostsOnce();
  assert.equal(first.filled, 0);
  assert.equal(first.skipped, 1);
  assert.equal((await store.readMigrations())[backfill.MARKER], undefined, "not done: tries again next boot");
  assert.equal(byId(await lists(alice.id), "PICK-1").shipCost, undefined, "nothing filled on a guess");
  await backfill.backfillShipCostsOnce();
  const last = await backfill.backfillShipCostsOnce();   // the last try fills with what it could read
  assert.equal(last.tries, backfill.MAX_TRIES);
  assert.equal(last.filled, 5);
  assert.ok((await store.readMigrations())[backfill.MARKER]);
});
