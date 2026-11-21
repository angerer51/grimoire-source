"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

test("nextReceiptId: prefix depends on kind, numbered independently per prefix", () => {
  const G = freshCore();
  const year = new Date().getFullYear();
  assert.equal(G.nextReceiptId("lot"), "LOT-" + year + "-0001");
  assert.equal(G.nextReceiptId("transfer"), "XFR-" + year + "-0001");
  assert.equal(G.nextReceiptId("collection"), "COL-" + year + "-0001");

  G.recordReceipt({ receiptId: G.nextReceiptId("lot"), kind: "lot", lines: [] });
  assert.equal(G.nextReceiptId("lot"), "LOT-" + year + "-0002", "lot count advanced");
  assert.equal(G.nextReceiptId("transfer"), "XFR-" + year + "-0001", "transfer prefix untouched by a lot receipt");
});

test("recordReceipt: totalCards/totalCost are computed from the lines, not trusted from the caller", () => {
  const G = freshCore();
  const doc = G.recordReceipt({
    kind: "lot", receiptId: "LOT-TEST-0001", spend: 20, allocation: "market",
    lines: [{ qty: 2, unitCost: 5 }, { qty: 3, unitCost: 3.333333 }]
  });
  assert.equal(doc.totalCards, 5);
  assert.equal(doc.totalCost, 20, "rounded to the cent, 2*5 + 3*3.333333 = 20.00");
  assert.equal(G.state.receipts[0], doc, "unshifted onto the front of the list");
});

test("recordReceipt: the receipts list is capped so it cannot grow without bound", () => {
  const G = freshCore();
  for (let i = 0; i < 2005; i++) G.recordReceipt({ receiptId: "R" + i, kind: "collection", lines: [] });
  assert.equal(G.state.receipts.length, 2000);
  assert.equal(G.state.receipts[0].receiptId, "R2004", "newest stays at the front, oldest fall off the back");
});
