"use strict";
/* #353: a Mana Pool purchase -> a lot receipt (core.js). What was paid,
   spread by price paid, adds up to the order's total; refunds come off;
   cards already owned are found and can just take the cost; a package
   already on a receipt is known as received. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const card = (id, collector, qty, unitPrice, extra) => Object.assign({
  kind: "card", orderItemId: id, set: "neo", collector, lang: "en", finish: "nonfoil", condition: "NM",
  name: "Card " + collector, qty, unitPrice, matched: true
}, extra || {});

// Two sellers. $30 of goods, $5 shipping (2 + 3), $2.40 tax: $37.40 paid.
const ORDER = {
  id: "o1", orderNumber: "1234-5678", createdAt: "2026-10-20T15:00:00Z",
  subtotal: 30, tax: 2.4, shipping: 5, total: 37.4,
  packages: [
    { id: "pkg-a", seller: "alice", shipping: 2, items: [card("i1", "10", 2, 5), card("i2", "11", 1, 3)] },
    { id: "pkg-b", seller: "bob", shipping: 3, items: [
      { kind: "sealed", orderItemId: "i3", name: "Box", setCode: "fdn", manapoolProductId: "mp-box", qty: 1, unitPrice: 10, matched: true },
      card("i4", "12", 3, 1.25, { finish: "foil" }), card("i5", "13", 1, 3.25)] }
  ]
};

// What Receive does with a draft: allocateLotCost weighted by price paid.
const spread = (G, lot) => G.allocateLotCost(lot.lines.map(l => ({ qty: l.qty, market: l.paid })), lot.spend, "market");
const cents = (lines, unit) => Math.round(lines.reduce((s, l, i) => s + unit[i] * l.qty, 0) * 100);

test("whole order: the receipt's money is exactly what was paid, each line its price plus a share", () => {
  const G = freshCoreWithLocation();
  const lot = G.mpPurchaseLot(ORDER);
  assert.equal(lot.lines.length, 5);
  assert.deepEqual([lot.goods, lot.shipping, lot.tax, lot.spend], [30, 5, 2.4, 37.4]);
  const unit = spread(G, lot);
  assert.equal(cents(lot.lines, unit), 3740, "lines add up to the total paid");
  // Shipping and tax are 7.40 on 30.00 of goods: every line pays 24.67% over its price.
  lot.lines.forEach((l, i) => assert.ok(Math.abs(unit[i] - l.paid * 37.4 / 30) < 0.02, l.name));
  assert.deepEqual([...new Set(Array.from(lot.lines, l => l.packageId))], ["pkg-a", "pkg-b"]);
});

test("one seller's package: its own goods and shipping plus its share of the tax", () => {
  const G = freshCoreWithLocation();
  const lot = G.mpPurchaseLot(ORDER, ["pkg-a"]);
  assert.equal(lot.lines.length, 2);
  assert.deepEqual(Array.from(lot.packages, p => p.id), ["pkg-a"]);
  // 13.00 of the 30.00 goods -> 13/30 of the 2.40 tax = 1.04.
  assert.deepEqual([lot.goods, lot.shipping, lot.tax, lot.spend], [13, 2, 1.04, 16.04]);
  assert.equal(cents(lot.lines, spread(G, lot)), 1604);
  // Both packages received separately still add up to the order.
  const b = G.mpPurchaseLot(ORDER, ["pkg-b"]);
  assert.equal(Math.round((lot.spend + b.spend) * 100), 3740);
});

test("refunds: a quantity of 0 drops the line, and the money for it isn't spent", () => {
  const G = freshCoreWithLocation();
  // The server already took refunded copies off qty: i1 had 2 ordered, both refunded.
  const refunded = Object.assign({}, ORDER, { packages: [Object.assign({}, ORDER.packages[0],
    { items: [card("i1", "10", 0, 5), card("i2", "11", 1, 3)] })] });
  const lot = G.mpPurchaseLot(refunded);
  assert.deepEqual(Array.from(lot.lines, l => l.orderItemId), ["i2"]);
  assert.equal(lot.goods, 3);
  assert.equal(lot.tax, 0.24, "tax only on what is kept");
  assert.equal(lot.spend, 5.24);
});

test("sealed lines come through as sealed, with their price paid", () => {
  const G = freshCoreWithLocation();
  const box = G.mpPurchaseLot(ORDER, ["pkg-b"]).lines.find(l => l.kind === "sealed");
  assert.equal(box.paid, 10);
  assert.equal(box.manapoolProductId, "mp-box");
});

function own(G, qty, acquiredAt, extra) {
  const rec = G.addCopies(Object.assign({
    set: "neo", num: "10", lang: "en", finish: "nonfoil", condition: "NM", locationId: "loc1", qty,
    info: { name: "Card 10", collector: "10", setName: "Neon", rarity: "rare", tcgplayerId: "", scryfallId: "sf",
      price: 4, priceNote: "", note: "", meta: {} },
    unitCost: null, action: "add", acquiredAt
  }, extra || {}));
  return rec;
}
const line = { set: "neo", collector: "10", lang: "en", finish: "nonfoil", condition: "NM" };

test("duplicates: matched by printing, finish, condition and language; the default depends on when they were added", () => {
  const G = freshCoreWithLocation();
  assert.equal(G.mpDupeDefault(line, ORDER.createdAt), null, "nothing owned: no marker");
  own(G, 2, "2026-10-01T00:00:00Z");
  assert.equal(G.ownedCopies(line).qty, 2);
  assert.equal(G.ownedCopies(Object.assign({}, line, { finish: "foil" })).qty, 0, "another finish isn't the same card");
  assert.equal(G.ownedCopies(Object.assign({}, line, { condition: "LP" })).qty, 0, "another condition isn't either");
  assert.equal(G.ownedCopies(Object.assign({}, line, { lang: "ja" })).qty, 0, "nor another language");
  assert.equal(G.mpDupeDefault(line, ORDER.createdAt), "new", "owned before the order: add as new copies");
  own(G, 1, "2026-10-24T00:00:00Z");
  assert.equal(G.mpDupeDefault(line, ORDER.createdAt), "cost", "added on or after the order date: already have it");
});

test("duplicates: copies added after the order WITH a cost don't count as these cards", () => {
  const G = freshCoreWithLocation();
  own(G, 2, "2026-10-24T00:00:00Z", { unitCost: 3, receiptId: "PULL-1" });
  assert.equal(G.mpDupeDefault(line, ORDER.createdAt, "o1"), "new");
});

test("two sellers, same card, one order: seller B's line adds new copies after seller A's package is posted", () => {
  const G = freshCoreWithLocation();
  // Seller A's package posted first: its copies arrive costed, on a receipt for this order.
  own(G, 2, "2026-10-24T00:00:00Z", { unitCost: 5.5, receiptId: "LOT-2026-0001", action: "receipt" });
  G.recordReceipt({ kind: "lot", receiptId: "LOT-2026-0001", lines: [], manapool: { orderId: "o1", packageIds: ["pkg-a"] } });
  assert.equal(G.mpDupeDefault(line, ORDER.createdAt, "o1"), "new", "B's copies are added, A's cost is left alone");
  // Even merged into a stack that already held old uncosted copies.
  const G2 = freshCoreWithLocation();
  own(G2, 1, "2026-01-01T00:00:00Z");
  own(G2, 2, "2026-10-24T00:00:00Z", { unitCost: 5.5, receiptId: "LOT-2026-0001", action: "receipt" });
  G2.recordReceipt({ kind: "lot", receiptId: "LOT-2026-0001", lines: [], manapool: { orderId: "o1", packageIds: ["pkg-a"] } });
  assert.equal(G2.state.cards.length, 1, "one merged stack");
  assert.equal(G2.state.cards[0].lastReceiptId, "LOT-2026-0001", "the newest add's receipt travels with its date");
  assert.equal(G2.mpDupeDefault(line, ORDER.createdAt, "o1"), "new");
});

test("'Already have it, just set the cost': copies with no cost take it first, nothing is added", () => {
  const G = freshCoreWithLocation();
  const rec = own(G, 3, "2026-10-24T00:00:00Z");
  const n = G.costOwnedCopies(Object.assign({}, line, { qty: 2, unitCost: 6.2, receiptId: "LOT-1" }));
  assert.equal(n, 2);
  assert.equal(rec.quantity, 3, "no copies added");
  assert.deepEqual([rec.costQty, rec.costTotal, rec.avgCost], [2, 12.4, 6.2]);
});

test("'Already have it' on copies that already carry a cost: the new cost replaces theirs; fewer owned than bought", () => {
  const G = freshCoreWithLocation();
  const rec = own(G, 2, "2026-10-24T00:00:00Z", { unitCost: 1 });
  assert.deepEqual([rec.costQty, rec.costTotal], [2, 2]);
  const n = G.costOwnedCopies(Object.assign({}, line, { qty: 3, unitCost: 5 }));
  assert.equal(n, 2, "only 2 owned: the page adds the third as a new copy");
  assert.deepEqual([rec.quantity, rec.costQty, rec.costTotal, rec.avgCost], [2, 2, 10, 5]);
});

test("received once: a package on a posted receipt is known as received", () => {
  const G = freshCoreWithLocation();
  assert.equal(G.mpReceivedPackages().size, 0);
  G.recordReceipt({ kind: "lot", receiptId: "LOT-2026-0001", lines: [],
    manapool: { orderId: "o1", orderNumber: "1234-5678", packageIds: ["pkg-a"] } });
  G.recordReceipt({ kind: "lot", receiptId: "LOT-2026-0002", lines: [] });
  const done = G.mpReceivedPackages();
  assert.equal(done.get("pkg-a"), "LOT-2026-0001");
  assert.equal(done.has("pkg-b"), false);
});
