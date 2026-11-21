"use strict";
// test-lib/no-money.js, the RF views' "no money" check (#421).
const test = require("node:test");
const assert = require("node:assert/strict");
const { moneyLeaks } = require("../test-lib/no-money");

const MONEY = { words: /price|cost|fee|net\b|Ann|\$/i, numbers: [1.11, 7.25, 12.5] };

test("times and generated ids are never money, whatever digits or letters they hold", () => {
  // Each of these failed the old one-regex-over-the-JSON check.
  const view = [{ id: "cmw5ycebhannee", at: "2026-11-07T05:17:41.118Z", bin: "Tray A", by: "sam" },
    { id: "x", stackId: "cfee0net1cost", when: "2026-11-07T05:17:17.254Z", ref: "cmw5ycebhfee12" },
    { savedAt: "2026-11-07T00:12:12.500Z", qty: 2, image: "https://img/normal/x.jpg" }];
  assert.deepEqual(moneyLeaks(view, MONEY), []);
});

test("money is caught as a key, a number or text", () => {
  assert.deepEqual(moneyLeaks({ rows: [{ unitPrice: 4 }] }, MONEY), ["unitPrice"]);
  assert.deepEqual(moneyLeaks({ rows: [{ qty: 7.25 }] }, MONEY), ["qty: 7.25"]);
  assert.deepEqual(moneyLeaks({ note: "refund 12.50 to the buyer" }, MONEY), ["note: refund 12.50 to the buyer"]);
  assert.deepEqual(moneyLeaks({ note: "$3" }, MONEY), ["note: $3"]);
  assert.deepEqual(moneyLeaks({ buyerName: "Ann Buyer" }, MONEY), ["buyerName: Ann Buyer"]);
  assert.deepEqual(moneyLeaks({ orderPayment: { net: 41 } }, MONEY), ["net"]);
  // Keys ending in "id" aren't all ids: paid amounts are still read.
  assert.deepEqual(moneyLeaks({ amountPaid: "$12.50", paid: "$9.99", prepaid: "12.5" }, MONEY),
    ["amountPaid: $12.50", "paid: $9.99", "prepaid: 12.5"]);
  assert.deepEqual(moneyLeaks({ id: "$1", locationId: "$1", record_id: "$1", returnID: "$1" }, MONEY), [], "real id keys are skipped");
});

test("a number only matches whole: 11.11 and 1.115 aren't 1.11", () => {
  assert.deepEqual(moneyLeaks({ a: "11.11", b: "1.115", c: 11.11 }, MONEY), []);
});
