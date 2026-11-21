"use strict";
/* Bagging order (#406): Mana Pool order number, highest first. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

test("sortBagOrders: highest order number first, numerically; no-order tickets stay last in place", () => {
  const G = freshCore();
  const t = (id, orderId, orderLabel) => ({ id, orderId, orderLabel });
  const out = G.sortBagOrders([t("m1"), t("a", "o1", "#9"), t("b", "o2", "#120"), t("m2"), t("c", "o3", "45")]);
  assert.equal(out.map(p => p.id).join(","), "b,c,a,m1,m2");
});

test("sortBagOrders: real Mana Pool labels like 584368-2076788 sort by their number, highest first", () => {
  const G = freshCore();
  const t = (id, orderLabel) => ({ id, orderId: "x" + id, orderLabel });
  const out = G.sortBagOrders([t("a", "584368-2076788"), t("b", "584368-2076790"), t("c", "584368-999999")]);
  assert.equal(out.map(p => p.id).join(","), "b,a,c");
});
