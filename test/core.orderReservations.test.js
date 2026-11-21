"use strict";
/* #107: copies on a fetched, unfinished Manapool order are taken for
   Listings (Evaluate, Apply, Push) even before the order has a pick list,
   and never counted twice once it has one. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {}
};
// An order line as the server's normalizeOrderLine gives it.
const ORDER_LINE = { kind: "card", name: "Lightning Bolt", set: "a25", collector: "141", lang: "en",
  finish: "nonfoil", condition: "NM", qty: 1, unitPrice: 1 };

function setup() {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations[0].sellFrom = true;
  return G;
}
function receive(G, qty, locationId) {
  return G.addCopies({ set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: locationId || "loc1", qty, info: INFO, action: "receipt", receiptId: "T1", note: "" });
}
const order = (id, qty, status, placedAt) => ({ id, label: "L-" + id, status: status || "unfulfilled",
  placedAt: placedAt || "2026-10-20T10:00:00Z", lines: [Object.assign({}, ORDER_LINE, { qty })] });
const reservedOf = (G, r) => G.manapoolReservations().get(r.id) || 0;

test("a fetched order with no pick list yet reserves its copies for Evaluate and Apply (#107)", () => {
  const G = setup();
  const r = receive(G, 3);
  r.listedQty = 3;
  assert.equal(reservedOf(G, r), 0, "nothing known about the order yet");
  G.setManapoolOrders([order("o1", 2)]);
  assert.equal(reservedOf(G, r), 2);

  const [line] = G.listingPlan({ includeUnchanged: true });
  assert.equal(line.reserved, 2);
  assert.equal(line.target, 1, "only the unsold copy is listable");
  assert.equal(line.listedNow, 1, "the 2 sold copies are already off Manapool (#487)");
  assert.equal(line.delta, 0);
  // Apply from a stale line that still says 3 never lists the sold copies.
  G.applyListingPlan([Object.assign({}, line, { target: 3 })], "test");
  assert.equal(r.listedQty, 1);
});

test("an order with an open pick list is not counted twice (#107)", async () => {
  const G = setup();
  const r = receive(G, 3);
  const o = order("o1", 2);
  G.setManapoolOrders([o]);
  const before = G.manapoolReservations();
  const { created } = await G.ensureOrderPickList(o);
  assert.ok(created);
  assert.equal(reservedOf(G, r), 2, "the open list's 2, not 2 + 2");
  assert.deepEqual([...G.manapoolReservations()], [...before], "the same stacks before and after the list exists");
});

test("an order whose pick list is completed holds nothing back (#107)", async () => {
  const G = setup();
  const r = receive(G, 3);
  const o = order("o1", 2);
  G.setManapoolOrders([o]);
  const { pickList } = await G.ensureOrderPickList(o);
  // Completed: the copies left the shelf; the order may still read unfulfilled.
  pickList.status = "picked";
  r.quantity = 1;
  assert.equal(reservedOf(G, r), 0);
  assert.equal(G.listingPlan({ includeUnchanged: true })[0].available, 1);
});

test("shipped, cancelled and refunded orders reserve nothing; unfulfilled, processing and error do (#107)", () => {
  for (const status of ["shipped", "delivered", "cancelled", "Canceled", "refunded", "completed"]) {
    const G = setup();
    const r = receive(G, 2);
    G.setManapoolOrders([order("o1", 1, status)]);
    assert.equal(reservedOf(G, r), 0, status);
  }
  for (const status of ["unfulfilled", "processing", "error", ""]) {
    const G = setup();
    const r = receive(G, 2);
    G.setManapoolOrders([order("o1", 1, status)]);
    assert.equal(reservedOf(G, r), 1, status || "(blank)");
  }
});

test("an order reserves the stacks its pick list will pull: sell-from only, highest pick priority first (#107)", () => {
  const G = setup();
  G.state.locations.push(G.newLocation({ id: "hi", name: "Front bin", type: "bin", sellFrom: true, pickPriority: 5 }));
  G.state.locations.push(G.newLocation({ id: "binder", name: "Binder", type: "binder", sellFrom: false, pickPriority: 9 }));
  const low = receive(G, 2, "loc1"), high = receive(G, 1, "hi"), personal = receive(G, 4, "binder");
  // Two orders and a pick list share the stock: no copy is claimed twice.
  G.setManapoolOrders([order("o2", 1, "unfulfilled", "2026-10-21T00:00:00Z"), order("o1", 1)]);
  const pl = G.newPickList({ source: "manapool", orderId: "older" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, Object.assign({}, ORDER_LINE, { condition: "NM", qty: 1 }));
  const res = G.manapoolReservations();
  assert.equal(res.get(high.id), 1, "the pick list takes the front bin first");
  assert.equal(res.get(low.id), 2, "then both orders come from the shelf");
  assert.equal(res.get(personal.id) || 0, 0, "never a stack in a location not sold from");
});

test("an order with no lines on file, or one already listed twice, is handled (#107)", () => {
  const G = setup();
  const r = receive(G, 5);
  const bare = { id: "o9", status: "unfulfilled", placedAt: "2026-10-20T00:00:00Z" };
  G.setManapoolOrders([bare, order("o1", 2), order("o1", 2)]);
  assert.equal(reservedOf(G, r), 2, "the summary-only order adds nothing; the duplicate is one order");
  G.setManapoolOrders(null);
  assert.equal(reservedOf(G, r), 0, "no orders loaded = pick lists only, as before");
});

test("reservations for many orders over a big collection index the stacks once (#107)", () => {
  const G = setup();
  for (let i = 0; i < 5000; i++) {
    G.state.cards.push({ id: "c" + i, name: "Card " + i, set: "tst", collector: String(i), lang: "en", finish: "nonfoil",
      condition: "NM", quantity: 1, listedQty: 0, locationId: "loc1" });
  }
  const orders = [];
  for (let i = 0; i < 200; i++) {
    orders.push({ id: "o" + i, status: "unfulfilled", placedAt: "2026-10-20T00:00:00Z",
      lines: [{ kind: "card", name: "Card " + i, set: "tst", collector: String(i), lang: "en", finish: "nonfoil", condition: "NM", qty: 1 }] });
  }
  G.setManapoolOrders(orders);
  let visits = 0;
  const orig = G.state.cards.filter;
  G.state.cards.filter = function () { visits++; return orig.apply(this, arguments); };
  const res = G.manapoolReservations();
  G.state.cards.filter = orig;
  assert.equal(res.size, 200);
  assert.equal(res.get("c7"), 1);
  assert.equal(visits, 0, "no per-line scan of the collection");
});

test("loadManapoolOrders reads the cache, or fetches fresh, and throws on a failed request (#107)", async () => {
  const { freshCoreSandbox } = require("../test-lib/core-shim");
  const urls = [];
  let fail = false;
  const fetch = async url => {
    urls.push(url);
    if (fail) return { status: 502, ok: false, text: async () => JSON.stringify({ error: "Manapool is down" }), json: async () => ({ error: "Manapool is down" }) };
    const body = { orders: [order("o1", 1)] };
    return { status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body };
  };
  const { G } = freshCoreSandbox({ fetch });
  await G.loadManapoolOrders();
  await G.loadManapoolOrders({ fresh: true });
  assert.deepEqual(urls, ["/api/manapool/orders/cached", "/api/manapool/orders"]);
  fail = true;
  await assert.rejects(G.loadManapoolOrders({ fresh: true }), /Manapool is down/);
});
