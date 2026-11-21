"use strict";
/* Order Entry, part 1 (#431): a walk-in order at the counter. It is an
   ordinary pick ticket (source "walkin") with a sale price on every line, so
   its stock comes off through completePickList and its revenue and cost land
   on the ticket like a Manapool sale's. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore, freshCoreWithLocation } = require("../test-lib/core-shim");

const INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 2.5, priceNote: "", note: "", meta: {}
};
// loc1 sells (the counter draws from sell-from locations only, owner 2026-11-07); any other location doesn't.
function receive(G, qty, unitCost, loc) {
  const l1 = G.state.locations.find(l => l.id === "loc1");
  if (l1) l1.sellFrom = true;
  return G.addCopies({ set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: loc || "loc1", qty, info: INFO, unitCost, action: "receipt", receiptId: "T1", note: "" });
}
const bolt = (qty, unitPrice) => ({ set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM",
  name: "Lightning Bolt", qty, unitPrice, marketPrice: 2.5 });
const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b); // across the VM boundary
const onHand = G => G.state.cards.reduce((s, r) => s + r.quantity, 0);

test("search finds stock by name with its market price, copies on hand and copies free to sell", () => {
  const G = freshCoreWithLocation();
  receive(G, 4, 1);
  const found = G.counterFindCards("bolt");
  assert.equal(found.rows.length, 1);
  const r = found.rows[0];
  assert.equal(r.name, "Lightning Bolt");
  assert.equal(r.price, 2.5);
  assert.equal(r.onHand, 4);
  assert.equal(r.free, 4);
  assert.equal(G.counterFindCards("bolt", [bolt(3, 2)]).rows[0].free, 1, "what the order being built takes is not free");
  assert.equal(G.counterFindCards("a25 141").rows.length, 1, "set code and number match too");
  assert.equal(G.counterFindCards("").rows.length, 0);
});

test("copies set aside for another open ticket aren't free to sell at the counter", () => {
  const G = freshCoreWithLocation();
  receive(G, 4, 1);
  const pl = G.newPickList({ source: "manapool", orderId: "o-1" });
  G.state.locations[0].sellFrom = true;
  G.pickLists().push(pl);
  G.addToPickList(pl.id, Object.assign(bolt(3), { kind: "card", unitPrice: 2 }));
  assert.equal(G.counterFindCards("bolt").rows[0].free, 1);
  const out = G.enterWalkInOrder({ lines: [bolt(2, 2.5)], mode: "pick" });
  assert.equal(out.ok, false);
  assert.match(out.error, /Only 1 copy of Lightning Bolt/);
});

test("send to be picked: an open Walk-in ticket that reserves its copies, with the customer and line prices", () => {
  const G = freshCoreWithLocation();
  receive(G, 4, 1);
  const out = G.enterWalkInOrder({ lines: [bolt(2, 2.25)], customer: { id: "c1", name: "Sam" }, mode: "pick" });
  assert.equal(out.ok, true);
  const p = out.pickList;
  assert.equal(p.source, "walkin");
  assert.equal(p.status, "open");
  same(p.customer, { id: "c1", name: "Sam" });
  assert.equal(p.lines[0].unitPrice, 2.25);
  assert.equal(onHand(G), 4, "nothing comes off until it's picked");
  assert.equal(G.counterFindCards("bolt").rows[0].free, 2, "its copies are set aside");
  assert.equal(G.counterSaleTotal(p), 4.5);
  assert.equal(G.pickListTag(p), "Walk-in " + p.id);
  assert.ok(G.pickListSearchText(p).includes("sam"));
});

test("picked, then handed over: revenue and cost on the ticket, payment recorded, ticket closed", () => {
  const G = freshCoreWithLocation();
  receive(G, 4, 1);
  const p = G.enterWalkInOrder({ lines: [bolt(2, 3)], mode: "pick" }).pickList;
  G.completePickList(p.id);
  assert.equal(p.status, "picked");
  assert.equal(onHand(G), 2);
  assert.equal(p.revenue, 6);
  assert.equal(p.cogs, 2);
  assert.equal(G.handOverCounterSale(p.id, "bitcoin"), null, "only cash, card or other");
  G.handOverCounterSale(p.id, "card");
  assert.equal(p.status, "shipped");
  same(p.payment, { method: "card", total: 6 });
  assert.ok(p.handedOverAt);
});

test("finish on the spot: stock off at once, paid, done; it needs a payment method", () => {
  const G = freshCoreWithLocation();
  receive(G, 4, 1);
  assert.equal(G.enterWalkInOrder({ lines: [bolt(1, 2.5)], mode: "now" }).ok, false);
  const out = G.enterWalkInOrder({ lines: [bolt(3, 2)], mode: "now", payment: "cash" });
  assert.equal(out.ok, true);
  const p = out.pickList;
  assert.equal(p.status, "shipped");
  assert.equal(onHand(G), 1);
  same(p.payment, { method: "cash", total: 6 });
  assert.equal(p.cogs, 3);
  assert.equal(p.customer, null, "anonymous walk-in");
  const ev = G.state.history.find(h => h.title === "Completed " + p.id);
  assert.ok(ev, "the sale is on the ship history Statistics reads");
  assert.equal(ev.lines[0].unitPrice, 2);
});

// Bolt x2 in a sell-from bin, x1 in a personal binder, a Manapool order for 2 (the reviewer's example).
function splitStock() {
  const G = freshCoreWithLocation();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "Binder", type: "binder" }));
  receive(G, 2, 1, "loc1");
  receive(G, 1, 1, "loc2");
  const mp = G.newPickList({ source: "manapool", orderId: "o-1" });
  G.pickLists().push(mp);
  G.addToPickList(mp.id, Object.assign(bolt(2), { kind: "card", unitPrice: 2 }));
  return { G, mp };
}

test("the counter sells from sell-from locations only: a binder copy isn't offered, so the online order keeps its two", () => {
  const { G, mp } = splitStock();
  const row = G.counterFindCards("bolt").rows[0];
  assert.equal(row.onHand, 2, "only the sell-from bin's copies");
  assert.equal(row.free, 0, "both are the Manapool order's");
  const out = G.enterWalkInOrder({ lines: [bolt(1, 2)], mode: "pick" });
  assert.equal(out.ok, false);
  assert.match(out.error, /Only 0 copies/);
  assert.equal(G.allocatePickLine(mp, mp.lines[0]).shortfall, 0);
});

test("a walk-in sent to be picked, and one finished now, pull from sell-from locations only", () => {
  const G = freshCoreWithLocation();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "Binder", type: "binder" }));
  G.state.locations.find(l => l.id === "loc2").pickPriority = 9;   // the binder would win on priority
  receive(G, 3, 1, "loc1");
  receive(G, 3, 1, "loc2");
  const p = G.enterWalkInOrder({ lines: [bolt(1, 2)], mode: "pick" }).pickList;
  same(G.pickListAllocOpts(p), { sellFromOnly: true });
  assert.equal(G.allocatePickLine(p, p.lines[0]).pulls[0].locationId, "loc1", "the desk and the floor allocate through this");
  G.completePickList(p.id);
  G.enterWalkInOrder({ lines: [bolt(1, 2)], mode: "now", payment: "cash" });
  assert.equal(G.state.cards.find(r => r.locationId === "loc1").quantity, 1);
  assert.equal(G.state.cards.find(r => r.locationId === "loc2").quantity, 3, "the binder is untouched");
});

test("Dashboard sales and profit count a walk-in once handed over, dated then; it is never an order to ship", () => {
  const G = freshCoreWithLocation();
  receive(G, 5, 1);
  const picked = G.enterWalkInOrder({ lines: [bolt(2, 3)], mode: "pick" }).pickList;
  G.completePickList(picked.id);
  const from = Date.now() - 864e5, to = Date.now() + 864e5;
  assert.equal(G.salesBetween(from, to).orders, 0, "picked but not handed over: not a sale yet");
  assert.equal(G.profitBetween(from, to).revenue, 0);
  assert.equal(G.awaitsShip(picked), false);
  assert.equal(G.saleDate(picked), null);
  G.enterWalkInOrder({ lines: [bolt(1, 4)], mode: "now", payment: "card" });
  const s = G.salesBetween(from, to);
  assert.equal(s.orders, 1);
  assert.equal(s.copies, 1);
  assert.equal(s.revenue, 4);
  const t = G.profitBetween(from, to);
  assert.equal(t.revenue, 4);
  assert.equal(t.net, 3, "revenue less its cost; no fees on a counter sale");
  assert.equal(t.salesMissingFees, 0);
  G.handOverCounterSale(picked.id, "cash");
  assert.equal(G.saleDate(picked), picked.handedOverAt);
  assert.equal(G.salesBetween(from, to).orders, 2);
  const mp = G.newPickList({ source: "manapool", orderId: "o-9" });
  mp.status = "picked";
  assert.equal(G.awaitsShip(mp), true);
});

test("a line with no price is refused; a typed price of 0 is allowed", () => {
  const G = freshCoreWithLocation();
  receive(G, 2, 1);
  const out = G.enterWalkInOrder({ lines: [bolt(1, "")], mode: "pick" });
  assert.equal(out.ok, false);
  assert.match(out.error, /no market price/);
  assert.equal(G.enterWalkInOrder({ lines: [bolt(1, 0)], mode: "pick" }).ok, true);
  assert.equal(G.enterWalkInOrder({ lines: [], mode: "pick" }).ok, false);
});

test("cancelling an open walk-in frees its copies; nothing was taken", () => {
  const G = freshCoreWithLocation();
  receive(G, 4, 1);
  const p = G.enterWalkInOrder({ lines: [bolt(2, 2)], mode: "pick" }).pickList;
  const out = G.cancelCounterSale(p.id);
  assert.equal(out.ok, true);
  assert.equal(out.putBack, 0);
  assert.equal(G.pickLists().length, 0);
  assert.equal(G.counterFindCards("bolt").rows[0].free, 4);
});

test("cancelling a picked walk-in puts each copy back where it came from, cost and all, and drops the sale", () => {
  const G = freshCoreWithLocation();
  receive(G, 2, 1.5);
  const p = G.enterWalkInOrder({ lines: [bolt(2, 3)], mode: "pick" }).pickList;
  G.completePickList(p.id);
  assert.equal(G.state.cards.length, 0, "the stack emptied and is gone");
  const out = G.cancelCounterSale(p.id);
  assert.equal(out.ok, true);
  assert.equal(out.putBack, 2);
  const r = G.state.cards[0];
  assert.equal(r.quantity, 2);
  assert.equal(r.locationId, "loc1");
  assert.equal(r.scryfallId, "abc-123");
  assert.equal(r.costQty, 2);
  assert.equal(r.avgCost, 1.5);
  assert.equal(G.pickLists().length, 0);
  assert.equal(G.state.history.some(h => h.title === "Completed " + p.id), false, "out of Statistics");
});

test("a handed-over sale can't be cancelled", () => {
  const G = freshCoreWithLocation();
  receive(G, 2, 1);
  const p = G.enterWalkInOrder({ lines: [bolt(1, 3)], mode: "now", payment: "other" }).pickList;
  assert.equal(G.cancelCounterSale(p.id).ok, false);
  assert.equal(G.pickLists().length, 1);
});

/* #432: the Manapool listing follows the order. The server does the Manapool
   calls with the inventory owner's connection, from the ticket as saved
   (test/orderEntryListing.test.js); here it's a fake that saves, and answers
   the sync with `reply(body)`. */
async function withServer(reply, opts) {
  const sent = [], puts = [];
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  let rev = 1;
  const G = freshCore({ fetch: async (url, init) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/auth/me") return json(200, { user: { id: "u1", username: "staff", orgId: "o1", orgRole: "staff" },
      personalPrefs: { simpleMode: false, chime: true, chimeMin: 20 } });
    if (url === "/api/collection" && method === "GET") return json(200, { rev, savedAt: null, state: null, owner: "store:s1" });
    if (url === "/api/collection" && method === "PUT") {
      if (opts && opts.saveFails) return json(500, { error: "disk full" });
      puts.push(JSON.parse(init.body)); rev++;
      return json(200, { rev, savedAt: new Date().toISOString() });
    }
    if (url === "/api/manapool/order-entry-sync") {
      const body = JSON.parse(init.body);
      sent.push({ body, savedBefore: puts.length });
      const r = reply(body);
      return json(r.status, r.body);
    }
    return json(200, {});
  } });
  await G.load();
  G.state.locations.push(G.newLocation({ id: "loc1", name: "Test bin", type: "bin" }));
  return { G, sent, puts };
}
const card = { scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", name: "Lightning Bolt", set: "a25", collector: "141" };
const answer = results => () => ({ status: 200, body: { connected: true, store: true, results } });

test("entering saves first, then asks the server by ticket, and sets the listed count from Manapool's", async () => {
  const { G, sent } = await withServer(answer([{ card, qty: 2, ok: true, listed: true, before: 4, quantity: 2, change: -2 }]));
  receive(G, 4, 1);
  G.state.cards[0].listedQty = 4;
  const p = G.enterWalkInOrder({ lines: [bolt(2, 2.5)], mode: "pick" }).pickList;
  G.persist("Walk-in order");
  same(await G.orderEntryListingSync("entered", p), { warnings: [] });
  same(sent[0].body, { event: "entered", ticketId: p.id, createdAt: p.createdAt, owner: "store:s1" });
  assert.ok(sent[0].savedBefore > 0, "the order was saved before the server was asked");
  assert.equal(G.state.cards[0].listedQty, 2, "listed count follows Manapool");
  // Its copies are set aside for the counter: Listings must not list them again.
  assert.equal(G.manapoolReservations().get(G.state.cards[0].id), 2);
});

test("a store whose owner hasn't connected Manapool says so; a personal account without it stays quiet", async () => {
  const shop = await withServer(() => ({ status: 200, body: { connected: false, store: true, reason: "not-connected", results: [] } }));
  receive(shop.G, 2, 1);
  const p = shop.G.enterWalkInOrder({ lines: [bolt(1, 2.5)], mode: "pick" }).pickList;
  same(await shop.G.orderEntryListingSync("entered", p),
    { warnings: ["Manapool wasn't updated: the store isn't connected to Manapool. The store's owner can connect it in Settings → Integrations."] });

  const personal = await withServer(() => ({ status: 200, body: { connected: false, store: false, reason: "not-connected", results: [] } }));
  receive(personal.G, 2, 1);
  const q = personal.G.enterWalkInOrder({ lines: [bolt(1, 2.5)], mode: "pick" }).pickList;
  same(await personal.G.orderEntryListingSync("entered", q), { warnings: [] });
});

test("cancelling saves the cancel, then asks the server to raise what it recorded", async () => {
  const { G, sent } = await withServer(b => answer(b.event === "cancelled"
    ? [{ card, qty: 1, ok: true, listed: true, before: 3, quantity: 4, change: 1 }] : [])());
  receive(G, 4, 1);
  const p = G.enterWalkInOrder({ lines: [bolt(3, 2.5)], mode: "pick" }).pickList;
  const out = G.cancelCounterSale(p.id);
  G.persist("Cancel");
  same(await G.orderEntryListingSync("cancelled", out.pickList), { warnings: [] });
  same([sent[0].body.event, sent[0].body.ticketId], ["cancelled", p.id]);
  assert.ok(sent[0].savedBefore > 0, "the cancel was saved first");
});

test("a failed update, a refused request or a save that didn't land keeps the order and warns naming the card", async () => {
  const bad = await withServer(answer([{ card, qty: 1, ok: false, error: "HTTP 500" }]));
  receive(bad.G, 2, 1);
  const p = bad.G.enterWalkInOrder({ lines: [bolt(1, 2.5)], mode: "pick" }).pickList;
  const out = await bad.G.orderEntryListingSync("entered", p);
  assert.match(out.warnings[0], /^Manapool wasn't lowered for Lightning Bolt \(A25 #141\)\. Lower that listing on Manapool by hand/);
  assert.equal(bad.G.pickLists().length, 1, "the order stands");

  const refused = await withServer(() => ({ status: 404, body: { error: "That order isn't saved yet, so Manapool wasn't updated." } }));
  receive(refused.G, 2, 1);
  const q = refused.G.enterWalkInOrder({ lines: [bolt(1, 2.5)], mode: "pick" }).pickList;
  assert.match((await refused.G.orderEntryListingSync("entered", q)).warnings[0], /Lightning Bolt/);

  const unsaved = await withServer(answer([]), { saveFails: true });
  receive(unsaved.G, 2, 1);
  const r = unsaved.G.enterWalkInOrder({ lines: [bolt(1, 2.5)], mode: "pick" }).pickList;
  unsaved.G.persist("Walk-in order");
  assert.match((await unsaved.G.orderEntryListingSync("entered", r)).warnings[0], /Lightning Bolt/);
  assert.equal(unsaved.sent.length, 0, "never asked before the order is saved");
});

