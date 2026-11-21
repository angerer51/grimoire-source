"use strict";
/* Warehouse Mode's receive and put-away (#388), on the real core.js: the desk
   opens a receipt, the RF books cards and sealed onto it (held: on the shelf,
   not free), put-away moves the hold with the copies, the receiver can undo
   their own booking until it's put away, and the desk's close spreads the
   money across everything booked and lets the copies go free. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");
const priceRules = require("../server/lib/priceRules");
const { merge } = require("../server/lib/merge");

const INFO = (name, num, price) => ({ name, collector: num || "1", setName: "Set", rarity: "common", tcgplayerId: "1", scryfallId: "s" + (num || "1"),
  price: price == null ? 2 : price, priceNote: "", note: "", meta: {}, card: { imageUrl: "https://img/normal/x.jpg" } });
/* Loaded through G.load with a signed-in user, as a phone is: a booking is the
   signed-in receiver's. as() switches who that is. */
async function setup(doc) {
  const user = { id: "u1", username: "sam", displayName: "sam" };
  const G = freshCore({ fetch: async url => {
    const u = String(url);
    const v = u.startsWith("/api/auth/me") ? { user } : u.startsWith("/api/collection/stamp") ? { stamp: "s" }
      : u.startsWith("/api/collection") ? { rev: 1, state: doc || null } : { entries: [], total: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(v), json: async () => v };
  } });
  await G.load();
  if (doc) return G;
  G.state.locations.push(G.newLocation({ id: "tray", name: "Tray A", type: "Box", staging: true }));
  G.state.locations.push(G.newLocation({ id: "a", name: "A-1", type: "Box", sellFrom: true, walkSeq: 2,
    putaway: { enabled: true, rules: { op: "all", children: [] } } }));
  G.state.locations.push(G.newLocation({ id: "b", name: "B-2", type: "Box", sellFrom: true, walkSeq: 1 }));
  return G;
}
const as = (G, id, name) => Object.assign(G.me, { id, username: name, displayName: name });
const book = (G, rc, qty, extra) => G.rfBookCard(Object.assign({ receivingId: rc.id, locationId: "tray", info: INFO("Sol Ring"), set: "tst",
  lang: "en", finish: "nonfoil", condition: "NM", qty }, extra));
const plain = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => assert.deepEqual(plain(a), b);
const BOX = { tcgplayerProductId: "99", name: "Box", setCode: "tst", marketPrice: 60 };

test("a booking is stock at once, held: on the shelf and movable, but not free to pick, list or trade", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "Craigslist", spend: 30, alloc: "market" });
  assert.match(rc.receiptId, /^LOT-\d{4}-0001$/);
  assert.equal(G.nextReceiptId("lot").slice(-4), "0002", "the open receipt's number is taken");
  // Free copies of the same card already in the tray stay their own stack.
  G.addCopies({ set: "tst", num: "1", lang: "en", finish: "nonfoil", condition: "NM", locationId: "tray", qty: 2, info: INFO("Sol Ring"), unitCost: 1 });
  assert.ok(book(G, rc, 3).ok);
  const held = G.state.cards.filter(r => r.held === rc.id);
  assert.equal(held.length, 1);
  assert.equal(held[0].quantity, 3);
  assert.equal(G.state.cards.filter(r => r.locationId === "tray").length, 2, "never merged with the free copies");
  assert.equal(G.availableQty(held[0]), 0);
  assert.equal(priceRules.availableQty(plain(held[0])), 0, "the server agrees");
  assert.equal(G.shelfQty(held[0], G.totesByStack()), 3, "they're on the shelf");
  assert.equal(held[0].costQty, 0, "no cost until close");
  // A second booking of the same card joins the held stack.
  book(G, rc, 1);
  assert.equal(G.state.cards.find(r => r.held === rc.id).quantity, 4);
  assert.equal(G.receivingLinesOf(rc.id).length, 2, "one row per booking");
  // The RF's views carry no money.
  const view = JSON.stringify([G.rfReceivingList(), G.rfReceiptView(rc.id), G.rfPutawayStops("tray"), G.rfPutawayTrays()]);
  assert.doesNotMatch(view, /market|spend|cost|price|"30"/i);
});

test("pick allocation and listings skip held copies until close; a move carries the hold", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "x", spend: 10 });
  book(G, rc, 2);
  const rec = G.state.cards.find(r => r.held);
  assert.ok(G.rfPutaway("card", rec.id, "a", 2, "a").ok);
  const there = G.state.cards.find(r => r.locationId === "a");
  assert.equal(there.held, rc.id, "the hold went with the copies");
  assert.equal(G.listableQty(there, new Map()), 0);
  const p = G.newPickList({ source: "manual", orderId: "o1", orderLabel: "#1" });
  G.pickLists().push(p);
  G.addToPickList(p.id, { kind: "card", set: "tst", collector: "1", lang: "en", finish: "nonfoil", condition: "NM", name: "Sol Ring", qty: 1 });
  const walk = G.rfPickWalk({ kind: "ticket", id: p.id });
  assert.equal(walk.rows.filter(r => r.need > 0).length, 0, "nothing to pick: " + JSON.stringify(walk.rows.map(r => [r.bin, r.qty])));
  // The desk's short line says why (owner, 2026-11-02).
  assert.equal(G.pickShortTote(p, p.lines[0]), "2 held on " + rc.receiptId + " until the desk closes it");
  G.closeReceiving(rc.id);
  assert.equal(G.pickShortTote(p, p.lines[0]), "");
  assert.equal(G.availableQty(G.state.cards.find(r => r.locationId === "a")), 2, "free once closed");
  assert.equal(G.rfPickWalk({ kind: "ticket", id: p.id }).rows.filter(r => r.need > 0).length, 1, "and the ticket can pick it");
});

test("close spreads the money across cards and sealed by market value, and the copies join their bin", async () => {
  const G = await setup();
  G.addCopies({ set: "tst", num: "1", lang: "en", finish: "nonfoil", condition: "NM", locationId: "a", qty: 1, info: INFO("Sol Ring"), unitCost: 5 });
  const rc = G.openReceiving({ source: "Shop", spend: 100, alloc: "market" });
  book(G, rc, 2, { info: INFO("Sol Ring", "1", 10) });                       // 20 of market
  book(G, rc, 1, { info: INFO("Bolt", "2", 20) });                           // 20
  as(G, "u2", "lee");
  const s = G.rfBookSealed({ receivingId: rc.id, locationId: "tray", qty: 1, product: BOX });   // 60
  assert.ok(s.ok);
  assert.equal(G.availableQty(s.stack), 0, "sealed is held too");
  // Sol Ring put away into A-1, next to the free copy, stays apart until close.
  const sol = G.state.cards.find(r => r.held && r.name === "Sol Ring");
  assert.ok(G.rfPutaway("card", sol.id, "a", 2, "a").ok);
  assert.equal(G.state.cards.filter(r => r.locationId === "a").length, 2);
  const sum = G.receivingSummary(rc.id);
  assert.equal(sum.cards, 3);
  assert.equal(sum.sealed, 1);
  assert.equal(sum.toPutAway, 2, "Bolt and the box are still in the tray");
  same(sum.receivers.sort(), ["lee", "sam"]);
  const out = G.closeReceiving(rc.id);
  assert.equal(out.toPutAway, 2);
  assert.equal(out.doc.receiptId, rc.receiptId);
  assert.equal(out.doc.kind, "lot");
  assert.equal(Math.round(out.doc.totalCost * 100), 10000, "the lines add up to the spend");
  const solA = G.state.cards.filter(r => r.locationId === "a");
  assert.equal(solA.length, 1, "joined the free copy");
  assert.equal(solA[0].quantity, 3);
  assert.equal(solA[0].costQty, 3);
  assert.equal(solA[0].costTotal, 25, "20 spread over its 2 copies, plus the 5 already there");
  const bolt = G.state.cards.find(r => r.name === "Bolt");
  assert.equal(bolt.held, undefined);
  assert.equal(bolt.costTotal, 20);
  const box = G.state.sealed.find(r => r.tcgplayerProductId === "99");
  assert.equal(box.held, undefined);
  assert.equal(box.costTotal, 60);
  assert.equal(G.state.receiving.length, 0);
  assert.equal(G.state.receivingLines.length, 0);
  assert.equal(G.state.receipts[0].receiptId, rc.receiptId);
});

test("a booked stack regraded or refinished at the desk before close still carries its share: the stock always gets the whole spend", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "x", spend: 100, alloc: "market" });
  book(G, rc, 1, { info: INFO("Big Card", "1", 90) });
  book(G, rc, 10, { info: INFO("Bulk", "2", 1) });
  book(G, rc, 2, { info: INFO("Foil Card", "3", 5) });
  // The desk corrects two bookings before close: a regrade and a finish fix.
  G.state.cards.find(r => r.name === "Big Card").condition = "LP";
  G.state.cards.find(r => r.name === "Foil Card").finish = "foil";
  assert.match(G.heldOn(G.state.cards.find(r => r.name === "Big Card")), /^LOT-/);
  const out = G.closeReceiving(rc.id);
  const landed = G.state.cards.reduce((n, r) => n + (Number(r.costTotal) || 0), 0);
  assert.equal(Math.round(landed * 100), 10000, "all of the spend is on the stock");
  assert.equal(Math.round(out.doc.totalCost * 100), 10000, "and the receipt agrees");
  const big = G.state.cards.find(r => r.name === "Big Card");
  assert.ok(big.costTotal > 80, "the regraded card kept its market-weighted share: " + big.costTotal);
  assert.equal(G.heldOn(big), "");
});

test("an even spread, and a receipt with nothing spent records no cost", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "x", spend: 9, alloc: "even" });
  book(G, rc, 2, { info: INFO("Sol Ring", "1", 100) });
  book(G, rc, 1, { info: INFO("Bolt", "2", 1) });
  G.closeReceiving(rc.id);
  assert.equal(G.state.cards.find(r => r.name === "Sol Ring").costTotal, 6);
  assert.equal(G.state.cards.find(r => r.name === "Bolt").costTotal, 3);
  const free = G.openReceiving({ source: "gift", spend: 0 });
  book(G, free, 1, { info: INFO("Gift", "3") });
  G.closeReceiving(free.id);
  const gift = G.state.cards.find(r => r.name === "Gift");
  assert.equal(gift.costQty, 0);
  assert.equal(gift.held, undefined);
});

test("a receiver can undo their own booking until it's put away; nobody else's", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "x", spend: 0 });
  const mine = book(G, rc, 2).line;
  as(G, "u2", "lee");
  assert.equal(G.rfLineUndoable(mine.id).problem, "not-yours");
  book(G, rc, 1, { condition: "LP" });
  as(G, "u1", "sam");
  assert.ok(G.rfLineUndoable(mine.id).ok);
  assert.ok(G.rfUndoLine(mine.id).ok);
  assert.equal(G.state.cards.filter(r => r.held && r.condition === "NM").length, 0, "the copies are gone");
  assert.equal(G.receivingLinesOf(rc.id).length, 1);
  // Put away: too late.
  const again = book(G, rc, 1).line;
  const rec = G.state.cards.find(r => r.held && r.condition === "NM");
  G.rfPutaway("card", rec.id, "b", 1, "a");
  assert.equal(G.rfLineUndoable(again.id).problem, "put-away");
  G.closeReceiving(rc.id);
  assert.equal(G.rfLineUndoable(again.id).problem, "gone");
});

test("put-away walks a tray in walk order, the desk's own tray copies too, sealed to where it already sits", async () => {
  const G = await setup();
  G.addSealedCopies({ tcgplayerProductId: "99", name: "Box", setCode: "tst", locationId: "b", qty: 1, price: 50, unitCost: null });
  G.addCopies({ set: "tst", num: "3", lang: "en", finish: "nonfoil", condition: "NM", locationId: "tray", qty: 1, info: INFO("Desk Card", "3"), unitCost: 1 });
  const rc = G.openReceiving({ source: "x", spend: 5 });
  book(G, rc, 2);
  G.rfBookSealed({ receivingId: rc.id, locationId: "tray", qty: 2, product: BOX });
  same(G.rfPutawayTrays().map(t => [t.name, t.items, t.held]), [["Tray A", 5, 4]]);
  const t = G.rfPutawayStops("tray");
  same(t.stops.map(s => [s.name, s.toName, s.take]), [["Box", "B-2", 2], ["Desk Card", "A-1", 1], ["Sol Ring", "A-1", 2]]);
  // Any bin is accepted; sealed carries its hold and splits.
  const box = t.stops[0];
  assert.ok(G.rfPutaway("sealed", box.id, "a", 1, box.toId).ok);
  assert.equal(G.state.sealed.filter(r => r.held === rc.id).length, 2);
  assert.ok(G.rfPutaway("sealed", box.id, "b", 1, box.toId).ok);
  same(G.state.sealed.filter(r => r.locationId === "b").map(r => [r.quantity, !!r.held]).sort(), [[1, false], [1, true]]);
  G.closeReceiving(rc.id);
  same(G.state.sealed.filter(r => r.locationId === "b").map(r => r.quantity), [2]);
  assert.equal(G.rfPutawayStops("tray").stops.length, 2, "the cards are still to file");
});

test("two phones booking the same card into the same tray at once both count", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "x", spend: 0 });
  book(G, rc, 1);
  const base = plain(G.state);
  const A = await setup(base), B = await setup(base);
  as(A, "u1", "sam"); as(B, "u2", "lee");
  book(A, A.receivingById(rc.id), 2);
  book(B, B.receivingById(rc.id), 3);
  const out = merge(base, plain(A.state), plain(B.state));
  assert.equal(out.merged.cards.filter(r => r.held === rc.id).reduce((n, r) => n + r.quantity, 0), 6);
  assert.equal(out.merged.receivingLines.length, 3);
  // Only the add's own timestamps can differ (theirs wins, harmlessly); never the count or the hold.
  assert.deepEqual(out.conflicts.filter(c => !/^(priceUpdated|acquiredAt)$/.test(c.field)), [], JSON.stringify(out.conflicts));
});

test("a hold whose receipt closed elsewhere comes off on load", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "x", spend: 0 });
  book(G, rc, 1);
  const doc = plain(G.state);
  doc.receiving = [];
  G.adoptState(doc);
  assert.equal(G.state.cards.filter(r => r.held).length, 0);
  assert.equal(G.state.receivingLines.length, 0);
  assert.equal(G.state.cards.length, 1, "the copies stay");
});

test("an open receipt with nothing on it can be removed; one with bookings can't", async () => {
  const G = await setup();
  const rc = G.openReceiving({ source: "x", spend: 0 });
  const other = G.openReceiving({ source: "y", spend: 0 });
  book(G, other, 1);
  assert.equal(G.discardReceiving(other.id), false);
  assert.equal(G.discardReceiving(rc.id), true);
  assert.equal(G.state.receiving.length, 1);
  assert.throws(() => G.openReceiving({ receiptId: other.receiptId }), /already exists/);
  assert.equal(G.rfBookCard({ receivingId: rc.id, locationId: "tray", info: INFO("X"), set: "tst", qty: 1 }).problem, "closed");
  assert.equal(book(G, other, 1, { locationId: "a" }).problem, "no-tray", "books into a receiving location only");
});
