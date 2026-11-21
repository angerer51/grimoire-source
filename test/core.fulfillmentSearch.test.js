"use strict";
/* Order Fulfillment's search (#198): the matchers in core.js. Case-
   insensitive, partial, every word must match somewhere in the row. The
   page wiring is in test/lists.search.page.test.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const ORDER = {
  id: "0d7c9e2a-1111-2222-3333-444455556666", label: "584368-2076788", buyer: "Dana Reyes",
  ship: { name: "Dana Reyes", company: "Reyes Games" },
  lines: [{ name: "Ragavan, Nimble Pilferer" }, { name: "Lightning Bolt" }]
};

test("searchTerms: lower-cased words, blanks dropped; no words matches everything", () => {
  const G = freshCore();
  assert.deepEqual([...G.searchTerms("  Bolt   DANA ")], ["bolt", "dana"]);
  assert.deepEqual([...G.searchTerms("")], []);
  assert.deepEqual([...G.searchTerms(null)], []);
  assert.equal(G.matchesTerms("anything", []), true);
});

test("orderSearchText: order number, id, buyer / ship-to, customer, card names and pick ticket", () => {
  const G = freshCore();
  const text = G.orderSearchText(ORDER, { id: "PICK-2026-0042" }, "Dana (regular)");
  const hit = q => G.matchesTerms(text, G.searchTerms(q));
  for (const q of ["584368", "2076788", "0d7c9e2a", "dana", "REYES", "reyes games", "regular", "ragavan", "bolt",
    "pick-2026-0042", "0042", "bolt dana", "nimble 584368"]) {
    assert.equal(hit(q), true, q + " should match");
  }
  for (const q of ["counterspell", "bolt counterspell", "PICK-2026-0043"]) {
    assert.equal(hit(q), false, q + " should not match");
  }
  // A word can't straddle two fields.
  assert.equal(hit("reyesragavan"), false);
});

test("orderSearchText: an order with no lines, ship-to or pick list still searches by number", () => {
  const G = freshCore();
  const text = G.orderSearchText({ id: "abc", label: "1-2" }, null, undefined);
  assert.equal(G.matchesTerms(text, G.searchTerms("1-2")), true);
  assert.equal(G.matchesTerms(text, G.searchTerms("undefined")), false);
  assert.equal(G.orderSearchText(null), "");
});

test("pickListSearchText: ticket number, saved or cached order number, customer and card names", () => {
  const G = freshCore();
  const p = { id: "PICK-2026-0007", orderId: ORDER.id, orderLabel: null, lines: [{ name: "Sol Ring" }] };
  const text = G.pickListSearchText(p, ORDER, "Dana R.");
  const hit = q => G.matchesTerms(text, G.searchTerms(q));
  for (const q of ["pick-2026-0007", "0007", "584368-2076788", "dana", "sol ring", "ring dana"]) {
    assert.equal(hit(q), true, q + " should match");
  }
  // Order lines aren't the ticket's: a card only on the order doesn't match.
  assert.equal(hit("ragavan"), false);
  // A manual pick list (no order) searches by its own number and cards.
  const manual = G.pickListSearchText({ id: "PICK-2026-0008", orderId: null, lines: [{ name: "Sol Ring" }] }, null, "");
  assert.equal(G.matchesTerms(manual, G.searchTerms("0008 sol")), true);
});

test("customerNameByOrder: each linked order maps to the customer's name as filed in Customers", () => {
  const G = freshCore();
  G.syncCustomersFromOrders([{ id: "o1", buyerId: "b1", buyer: "Dana Reyes" }, { id: "o2", buyerId: "b1", buyer: "Dana Reyes" }]);
  G.updateCustomer(G.state.customers[0].id, { name: "Dana (regular)" });
  const m = G.customerNameByOrder();
  assert.equal(m.get("o1"), "Dana (regular)");
  assert.equal(m.get("o2"), "Dana (regular)");
});
