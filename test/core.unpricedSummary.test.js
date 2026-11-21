"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const info = (price, n) => ({
  name: "Card " + n, collector: n, setName: "S", rarity: "rare",
  tcgplayerId: "1", scryfallId: "x", price, priceNote: price == null ? "no-nonfoil-price" : "", note: "", meta: {}
});
const add = (G, num, price, qty) => G.addCopies({
  set: "tst", num, lang: "en", finish: "nonfoil", condition: "NM",
  locationId: "loc1", qty, info: info(price, num), unitCost: null, action: "add", note: ""
});

test("summary counts cards with no price so totals and averages can say so (#326)", () => {
  const G = freshCoreWithLocation();
  add(G, "1", 10, 2);
  add(G, "2", null, 3);
  const s = G.summary();
  assert.equal(s.cards, 5);
  assert.equal(s.value, 20);
  assert.equal(s.unpricedCards, 3);
  assert.equal(s.pricedCards, 2);
  assert.equal(s.value / s.pricedCards, 10);
  assert.equal(G.unpricedNote(3, false), "3 cards have no price and aren't counted");
  assert.equal(G.unpricedNote(1, false), "1 card has no price and isn't counted");
  assert.equal(G.unpricedNote(0), "");
});

test("fitFinish switches only when the printing does not come in the asked finish (#326)", () => {
  const G = freshCoreWithLocation();
  assert.equal(G.fitFinish({ finishes: ["foil"] }, "nonfoil"), "foil");
  assert.equal(G.fitFinish({ finishes: ["foil", "etched"] }, "etched"), "etched");
  assert.equal(G.fitFinish({ finishes: ["nonfoil", "foil"] }, "nonfoil"), "nonfoil");
  assert.equal(G.fitFinish({ finishes: [] }, "nonfoil"), "nonfoil");
  assert.equal(G.fitFinish(null, "foil"), "foil");
});
