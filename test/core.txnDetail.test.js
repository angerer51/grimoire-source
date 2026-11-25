"use strict";
/* G.txnDetail / G.txnLineExport (#528): the card lines behind an Accounting row
   and the line-by-line export. Rows are shaped like accountingRows() in
   accounting.page.js (row.src is the stored pick list / receipt / return). The
   point of each test: lines + order-level amounts add up to the row's figures. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const line = (name, qty, unitPrice, cogs, extra) => Object.assign({ name, set: "abc", collector: "1", finish: "nonfoil", condition: "NM", lang: "en",
  qty, unitPrice, pickedResult: { pulls: [{ qty }], cogs } }, extra || {});
const saleRow = (p, extra) => Object.assign({ date: "2026-11-02T15:00:00Z", type: "Sale", ref: p.id, order: "58-1", src: p, key: p.id,
  revenue: p.revenue, cogs: p.cogs, fees: p.fees, earnings: p.earnings, shipping: null, spend: null, refund: null }, extra || {});

test("a sale: lines plus shipping paid add up to the row's revenue and cost", () => {
  const G = freshCore();
  const p = { id: "P1", lines: [line("Echo", 2, 5, 3), line("Kilo", 1, 1.25, 0.5)], shippingRevenue: 2, revenue: 13.25, cogs: 3.5, fees: 1.1, earnings: 9 };
  const d = G.txnDetail(saleRow(p, { shipping: 1.5 }));
  assert.equal(d.lines.length, 2);
  assert.equal(d.lines[0].revenue, 10);
  assert.equal(d.lines[0].profit, 7);
  assert.deepEqual(Array.from(d.extras, e => e.kind), ["Shipping paid", "Fees", "Shipping cost", "Earnings"]);
  assert.equal(d.totals.revenue, 13.25);
  assert.equal(d.totals.cost, 3.5);
  assert.equal(d.costSplit, true);
});

test("a sale picked before per-line cost: cost is order-level only, not invented per card", () => {
  const G = freshCore();
  const old = line("Echo", 2, 5, 0);
  delete old.pickedResult.cogs;
  const p = { id: "P2", lines: [old], revenue: 10, cogs: 4 };
  const d = G.txnDetail(saleRow(p));
  assert.equal(d.costSplit, false);
  assert.equal(d.lines[0].cost, null);
  assert.equal(d.lines[0].profit, null);
  assert.equal(d.extras.find(e => e.kind === "Cost not split").value, 4);
  assert.equal(d.totals.cost, 4);
});

test("a counter sale has no fees row; a line with no sale price adds no revenue", () => {
  const G = freshCore();
  const p = { id: "P3", lines: [line("Echo", 1, 5, 2), line("Kilo", 1, null, 1)], revenue: 5, cogs: 3, fees: 0 };
  const d = G.txnDetail(saleRow(p, { counter: true, fees: 0 }));
  assert.equal(d.lines[1].revenue, null);
  assert.equal(d.extras.some(e => e.kind === "Fees"), false);
  assert.equal(d.totals.revenue, 5);
  assert.equal(d.totals.cost, 3);
});

test("the card filter keeps only that card's lines, and its shipping share closes the gap", () => {
  const G = freshCore();
  const p = { id: "P4", lines: [line("Echo", 1, 5, 2), line("Kilo", 3, 1, 0.5, { collector: "2" })], shippingRevenue: 2 };
  // Echo is 1 copy of 4: its row says revenue 5 + 0.50 of shipping, cost 2.
  const row = saleRow(p, { revenue: 5.5, cogs: 2, fees: null, shipping: 1 });
  const d = G.txnDetail(row, it => it.name === "Echo");
  assert.equal(d.lines.length, 1);
  assert.equal(d.totals.revenue, 5.5);
  assert.equal(d.totals.cost, 2);
  assert.equal(d.extras.find(e => e.kind === "Shipping paid").value, 0.5);
});

test("a receipt: card lines plus any unitemised spend equal the row's spend", () => {
  const G = freshCore();
  const src = { id: "r1", source: "Store", lines: [{ name: "Echo", set: "abc", collector: "1", qty: 3, unitCost: 1.5 }, { name: "Kilo", qty: 2, unitCost: 0.25 }] };
  const row = { date: "2026-11-03T12:00:00Z", type: "Receipt", ref: "R-1", order: "", src, key: "r1", revenue: null, cogs: null, spend: 5.5 };
  const d = G.txnDetail(row);
  assert.equal(d.lines[0].cost, 4.5);
  assert.equal(d.extras.find(e => e.kind === "Cost not itemised").value, 0.5);
  assert.equal(d.totals.cost, 5.5);
});

test("a return: restocked lines put cost back, damaged ones don't, and it matches returnCostBack", () => {
  const G = freshCore();
  const src = { id: "x1", disposition: "restock", refundTotal: 7, lines: [
    { name: "Echo", set: "abc", collector: "1", qty: 2, unitCost: 1.333 },
    { name: "Kilo", set: "abc", collector: "2", qty: 1, unitCost: 2, disposition: "damaged" }] };
  const costBack = G.returnCostBack(src);
  const row = { date: "2026-11-04T12:00:00Z", type: "Return", ref: "RET-1", order: "58-1", src, key: "x1", refund: 7, costBack };
  const d = G.txnDetail(row);
  assert.equal(d.lines[0].note, "Put back in stock");
  assert.equal(d.lines[1].costBack, 0);
  assert.equal(d.lines[1].note, "Damaged, written off");
  assert.equal(d.totals.costBack, costBack);
  assert.equal(d.extras.find(e => e.kind === "Refund").value, 7);
});

test("the line export sums to the transaction figures per column", () => {
  const G = freshCore();
  const p = { id: "P5", lines: [line("Echo", 2, 5, 3), line("Kilo", 1, 1.25, 0.5)], shippingRevenue: 2, revenue: 13.25, cogs: 3.5, fees: 1.1, earnings: 9 };
  const sale = saleRow(p, { shipping: 1.5 });
  const rcpt = { date: "2026-11-03T12:00:00Z", type: "Receipt", ref: "R-1", order: "", key: "r1", revenue: null, cogs: null, spend: 5.5,
    src: { id: "r1", lines: [{ name: "Echo", qty: 3, unitCost: 1.5 }] } };
  const out = G.txnLineExport([sale, rcpt], null, r => r.type);
  assert.equal(out.rows[0].length, out.head.length);
  const col = (name, kind) => { const i = out.head.indexOf(name), k = out.head.indexOf("Kind");
    return Math.round(out.rows.filter(r => !kind || r[k] === kind).reduce((s, r) => s + (Number(r[i]) || 0), 0) * 100) / 100; };
  assert.equal(col("Line revenue"), 13.25);
  assert.equal(col("Line cost"), 3.5 + 5.5);
  assert.equal(col("Amount", "Fees"), 1.1);
  assert.equal(col("Amount", "Shipping cost"), 1.5);
  const first = out.rows[0];
  assert.equal(first[out.head.indexOf("Kind")], "Card");
  assert.equal(first[out.head.indexOf("Local Date")].length, 10);
});
