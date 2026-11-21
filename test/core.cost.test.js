"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const CARD_INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {}
};
// No unitCost here on purpose - these tests drive applyCost/removeCost/
// setCostBasis directly afterward, so the stack starts with no cost basis
// of its own (addCopies' own unitCost path is covered by core.returns.test.js
// and core.pickLists.test.js instead).
function stack(G, qty) {
  return G.addCopies({
    set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: qty || 10, info: CARD_INFO, unitCost: null, action: "add", note: ""
  });
}

test("applyCost/removeCost: moving average across two lots", () => {
  const G = freshCoreWithLocation();
  const r = stack(G);
  G.applyCost(r, 4, 1.00);   // 4 @ $1.00
  G.applyCost(r, 6, 2.00);   // 6 @ $2.00
  assert.equal(r.costQty, 10);
  assert.equal(r.costTotal, 16);          // 4*1 + 6*2
  assert.equal(r.avgCost, 1.6);           // 16/10

  G.removeCost(r, 3);                     // remove 3 at the current average
  assert.equal(r.costQty, 7);
  assert.equal(r.costTotal, round2(16 - 3 * 1.6));
  assert.equal(r.avgCost, round2(r.costTotal / 7));

  function round2(n) { return Math.round(n * 100) / 100; }
});

test("removeCost: never goes negative and is a no-op below zero cost qty", () => {
  const G = freshCoreWithLocation();
  const r = stack(G);
  G.removeCost(r, 5); // nothing costed yet
  assert.equal(r.costQty, 0);
  assert.equal(r.costTotal, 0);

  G.applyCost(r, 2, 3);
  G.removeCost(r, 100); // remove more than exists
  assert.equal(r.costQty, 0);
  assert.equal(r.costTotal, 0, "cost basis floors at zero, never goes negative");
});

test("applyCost: a null unit cost or non-positive qty is a no-op", () => {
  const G = freshCoreWithLocation();
  const r = stack(G);
  G.applyCost(r, 5, null);
  assert.equal(r.costQty, 0, "no cost recorded when unitCost is null");
  G.applyCost(r, 0, 5);
  assert.equal(r.costQty, 0, "no cost recorded for zero quantity");
});

test("setCostBasis: overwrites the stack's cost basis directly, clamped to on-hand qty", () => {
  const G = freshCoreWithLocation();
  const r = stack(G, 5);
  G.setCostBasis(r, 2.5, 100); // asking to cost more copies than exist
  assert.equal(r.costQty, 5, "clamped to the 5 actually on hand");
  assert.equal(r.costTotal, 12.5);
  assert.equal(r.avgCost, 2.5);
});

test("allocateLotCost: market-weighted split gives the pricier card more of the spend", () => {
  const G = freshCoreWithLocation();
  const lines = [
    { qty: 1, market: 40 },  // a $40 rare
    { qty: 1, market: 0.10 } // a bulk common
  ];
  const [expensiveUnit, cheapUnit] = G.allocateLotCost(lines, 20, "market");
  assert.ok(expensiveUnit > cheapUnit, "the pricier card absorbs more of the lot spend");
  const total = round2(expensiveUnit * 1 + cheapUnit * 1);
  assert.equal(total, 20, "the allocation sums back to exactly what was spent");
  function round2(n) { return Math.round(n * 100) / 100; }
});

test("allocateLotCost: even split ignores market value entirely, by quantity only", () => {
  const G = freshCoreWithLocation();
  const lines = [{ qty: 3, market: 40 }, { qty: 1, market: 0.10 }];
  const [a, b] = G.allocateLotCost(lines, 40, "even");
  assert.equal(a, 10, "$40 / 4 total cards = $10/card regardless of market value");
  assert.equal(b, 10);
});

test("allocateLotCost: a line with no known market value absorbs the average of the known ones", () => {
  const G = freshCoreWithLocation();
  const lines = [{ qty: 1, market: 10 }, { qty: 1, market: null }];
  const [priced, unpriced] = G.allocateLotCost(lines, 10, "market");
  assert.ok(unpriced > 0, "an unpriced line still absorbs something, not nothing");
  assert.equal(round2(priced + unpriced), 10);
  function round2(n) { return Math.round(n * 100) / 100; }
});

test("allocateLotCost: zero spend or zero cards allocates nothing", () => {
  const G = freshCoreWithLocation();
  assert.deepEqual(G.allocateLotCost([{ qty: 1, market: 5 }], 0, "market"), [0]);
  assert.deepEqual(G.allocateLotCost([], 50, "market"), []);
});
