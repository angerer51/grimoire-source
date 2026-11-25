"use strict";
/* Accounting's Order column and transactions CSV show Manapool's readable
   order number for a sale, never the internal UUID (#197). Through the real
   accounting.page.js with a stand-in DOM (test-lib/page-shim.js). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const UUID = n => n + "0000000-aaaa-bbbb-cccc-dddddddddddd";
const sale = (id, orderId, orderLabel) => ({ id, source: "manapool", orderId, orderLabel, status: "shipped",
  pickedAt: new Date(Date.now() - 86400000).toISOString(), revenue: 10, cogs: 4, fees: 1, earnings: 9, lines: [] });

async function accountingPage(lists, cached) {
  const pg = loadPage("accounting.page.js", { routes: url =>
    url === "/api/manapool/orders/cached" ? { orders: cached || [] } : {} });
  pg.G.state.pickLists.push(...lists);
  await pg.boot();
  await settle(10);
  return pg;
}
const ordersFetched = pg => pg.net.filter(r => r.url === "/api/manapool/orders/cached").length;

test("a sale shows its saved readable order number, and no orders are fetched when every sale has one", async () => {
  const pg = await accountingPage([sale("PICK-2026-0001", UUID(1), "584368-1")]);
  const html = pg.$("acctBody").innerHTML;
  assert.match(html, /<td>584368-1<\/td>/);
  assert.doesNotMatch(html, new RegExp(UUID(1)));
  assert.equal(ordersFetched(pg), 0);
});

test("a sale saved without one (or with the UUID) gets it from the orders cache; none there: the id shortened", async () => {
  const pg = await accountingPage([
    sale("PICK-2026-0001", UUID(1), null),
    sale("PICK-2026-0002", UUID(2), UUID(2)),
    sale("PICK-2026-0003", UUID(3), null)
  ], [{ id: UUID(1), label: "584368-1" }, { id: UUID(2), label: "584368-2" }]);
  assert.equal(ordersFetched(pg), 1);
  const html = pg.$("acctBody").innerHTML;
  assert.match(html, /<td>584368-1<\/td>/);
  assert.match(html, /<td>584368-2<\/td>/);
  assert.match(html, /<td>30000000…<\/td>/);
  assert.doesNotMatch(html, /aaaa-bbbb/, "no whole UUID in the table");
});

test("the CSV's Order column has the readable number too; with none to find, the whole id", async () => {
  const pg = await accountingPage([
    sale("PICK-2026-0001", UUID(1), null),
    sale("PICK-2026-0003", UUID(3), null)
  ], [{ id: UUID(1), label: "584368-1" }]);
  let csv = "";
  pg.sandbox.Blob = class { constructor(parts) { csv = parts.join(""); } };
  pg.G.downloadBlob = () => {};
  await pg.$("acctCsv").fire("click");
  const rows = csv.split("\r\n").slice(1).map(r => r.split(",")[3]);
  assert.deepEqual(rows.sort(), ["584368-1", UUID(3)].sort());
});

/* #457 (owner, "net of both"): one card's sales carry that card's share of each order's
   shipping, split by copies: what the buyer paid in revenue, the frozen cost off profit. */
test("one card's view: its share of shipping by copies, paid into revenue and cost off profit", async () => {
  const filter = { name: "Echo", set: "abc", collector: "1" };
  const line = (name, collector, qty, unitPrice, cogs) => ({ name, set: "abc", collector, qty, unitPrice,
    pickedResult: { pulls: [{ qty }], cogs } });
  const shipped = (id, lines, shipCost) => Object.assign(sale(id, UUID(id.slice(-1)), "58-" + id.slice(-1)),
    { lines, shipCost });
  const pg = loadPage("accounting.page.js", { routes: () => ({}), ui: { cardFilterFromUrl: () => filter, cardFilterMatches:
    (f, x) => x.set === f.set && x.collector === f.collector } });
  pg.G.state.pickLists.push(
    // 1 Echo of 4 copies: a quarter of $4.00 cost, and of the $2.00 the buyer paid.
    Object.assign(shipped("PICK-1", [line("Echo", "1", 1, 5, 2), line("Kilo", "2", 3, 1, 0.5)], { total: 4, ruleName: "Small bubble mailer" }), { shippingRevenue: 2 }),
    // 2 Echo of 3 copies: two thirds of $1.00, rounded to the cent.
    shipped("PICK-2", [line("Echo", "1", 2, 5, 4), line("Kilo", "2", 1, 1, 0.5)], { total: 1, ruleName: "Letter" }),
    // Shipped before costs were frozen: no share.
    shipped("PICK-3", [line("Echo", "1", 1, 5, 2)], null)
  );
  await pg.boot();
  await settle(10);
  const html = pg.$("acctBody").innerHTML;
  assert.match(html, /\$1\.00<\/td>/, "PICK-1: a quarter of $4.00");
  assert.match(html, /\$0\.67<\/td>/, "PICK-2: two thirds of $1.00");
  const tiles = pg.$("acctTiles").innerHTML;
  // Revenue 20 + 0.50 paid, COGS 8, gross 12.50, shipping cost 1.67 -> 10.83.
  assert.match(html, /\$5\.50<\/td>/, "PICK-1's revenue has its 50c share of what the buyer paid");
  assert.match(tiles, /\$20\.50<\/span><span class="lbl">Revenue/);
  assert.match(tiles, /\$1\.67<\/span><span class="lbl">Shipping share/);
  assert.match(tiles, /\$10\.83<\/span><span class="lbl">Profit after shipping/);
  assert.match(pg.$("acctIntro").textContent, /split by copies/);
});

/* #528: the card-lines export covers the same rows as Export CSV, and a sale's lines add up to its row. */
test("Export card lines CSV: one row per card plus the order's shipping, adding up to the transactions CSV", async () => {
  const line = { name: "Echo", set: "abc", collector: "1", finish: "nonfoil", qty: 2, unitPrice: 5, pickedResult: { pulls: [{ qty: 2 }], cogs: 3 } };
  const pg = await accountingPage([Object.assign(sale("PICK-2026-0001", UUID(1), "584368-1"),
    { lines: [line], revenue: 12, cogs: 3, shippingRevenue: 2 })]);
  const csv = {};
  let which = "";
  pg.sandbox.Blob = class { constructor(parts) { csv[which] = parts.join(""); } };
  pg.G.downloadBlob = () => {};
  which = "txns"; await pg.$("acctCsv").fire("click");
  which = "lines"; await pg.$("acctLinesCsv").fire("click");
  const rows = csv.lines.split("\r\n");
  const head = rows[0].split(",");
  assert.equal(head[0], "Date");
  assert.ok(head.includes("Line revenue") && head.includes("Kind"));
  const ri = head.indexOf("Line revenue");
  const rev = rows.slice(1).reduce((s, r) => s + (Number(r.split(",")[ri]) || 0), 0);
  assert.equal(rev, 12);
  assert.match(csv.lines, /Shipping paid/);
  assert.equal(csv.txns.split("\r\n").length, 2);
});
