"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const CARD_INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {}
};

test("nextReturnId: RMA-<year>-0001 for the first one, increments from there", () => {
  const G = freshCoreWithLocation();
  const year = new Date().getFullYear();
  assert.equal(G.nextReturnId(), "RMA-" + year + "-0001");
  G.recordReturn({ locationId: "loc1", lines: [] });
  assert.equal(G.nextReturnId(), "RMA-" + year + "-0002");
});

test("returns.page.js's flow: addCopies() puts the card back, recordReturn() logs the doc", () => {
  const G = freshCoreWithLocation();
  const rec = G.addCopies({
    set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: 3, info: CARD_INFO, unitCost: 0.25, action: "return", note: "Return RMA-test"
  });
  assert.equal(rec.quantity, 3);
  assert.equal(rec.avgCost, 0.25, "an optional cost basis restore is honoured when given");

  const doc = G.recordReturn({
    orderLabel: "1234-5678", buyer: "Jane", disposition: "restock", locationId: "loc1",
    reason: "wrong card sent", refundTotal: 1.5,
    lines: [{ set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM",
      name: "Lightning Bolt", scryfallId: "abc-123", qty: 3, unitCost: 0.25 }]
  });
  assert.equal(doc.totalQty, 3, "totalQty computed from the lines, not passed in");
  assert.equal(G.state.returns.length, 1);
  assert.equal(G.state.returns[0].returnId, doc.returnId);
});

test("recordReturn: a return with no cost basis given restores none - honest gap, not a guess", () => {
  const G = freshCoreWithLocation();
  const rec = G.addCopies({
    set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: 2, info: CARD_INFO, unitCost: null, action: "return", note: ""
  });
  assert.equal(rec.costQty, 0, "no cost basis fabricated when the staffer didn't enter one");
});

test("a second return of the same printing at the same location merges into the existing stack", () => {
  const G = freshCoreWithLocation();
  G.addCopies({
    set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: 3, info: CARD_INFO, unitCost: 0.25, action: "return", note: ""
  });
  const rec2 = G.addCopies({
    set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: 2, info: CARD_INFO, unitCost: null, action: "return", note: ""
  });
  assert.equal(rec2.quantity, 5, "folded into the one stack, not a duplicate row");
  assert.equal(rec2.costQty, 3, "cost basis from the first return carries, the no-cost second one doesn't dilute it away");
});

test("returnRestoresCost: only a restock (or a pre-disposition return) puts cost basis back", () => {
  const G = freshCoreWithLocation();
  assert.equal(G.returnRestoresCost("restock"), true);
  assert.equal(G.returnRestoresCost(undefined), true, "a return with no disposition predates the field and was a restock");
  assert.equal(G.returnRestoresCost(""), true);
  assert.equal(G.returnRestoresCost("damaged"), false);
  assert.equal(G.returnRestoresCost("other"), false);
});

test("returnRestoresCost agrees with returnCostBack for every disposition", () => {
  const G = freshCoreWithLocation();
  const lines = [{ qty: 2, unitCost: 1.5 }];
  for (const disposition of ["restock", undefined, "damaged", "other"]) {
    const back = G.returnCostBack({ disposition, lines });
    assert.equal(back > 0, G.returnRestoresCost(disposition), "disposition " + disposition);
  }
});

test("a damaged return goes back into the stack without changing its cost basis (#58)", () => {
  const G = freshCoreWithLocation();
  const base = { set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", info: CARD_INFO };
  G.addCopies({ ...base, qty: 4, unitCost: 2, action: "receive", note: "" });
  // The same choice returns.page.js's postReturn() makes for each line.
  const entered = 9;
  const rec = G.addCopies({ ...base, qty: 1,
    unitCost: G.returnRestoresCost("damaged") ? entered : null, action: "return", note: "Return RMA-test" });
  assert.equal(rec.quantity, 5, "the damaged copy still goes into the bin");
  assert.equal(rec.costQty, 4, "no cost basis added for the written-off copy");
  assert.equal(rec.costTotal, 8);
  assert.equal(rec.avgCost, 2, "average cost unchanged, so a later sale isn't charged the cost twice");

  const restocked = G.addCopies({ ...base, qty: 1,
    unitCost: G.returnRestoresCost("restock") ? entered : null, action: "return", note: "" });
  assert.equal(restocked.costQty, 5, "a restock still restores its cost basis");
});
