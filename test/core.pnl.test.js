"use strict";
/* G.pnlByMonth(): the Accounting page's monthly P&L roll-up (issue #48).
   Months are LOCAL calendar months, so these tests pin the process time zone
   (Node re-reads process.env.TZ on change) and build their range bounds the
   way accounting.page.js's acctRange() does: local midnight to 23:59:59. */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore, freshCoreWithLocation } = require("../test-lib/core-shim");

const ORIGINAL_TZ = process.env.TZ;
beforeEach(() => { process.env.TZ = "America/Chicago"; });
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

// Same shape as accountingRows() in accounting.page.js.
const sale = (date, revenue, cogs, fees) => ({ date, type: "Sale", ref: "PL", order: "",
  revenue, cogs, fees: fees === undefined ? null : fees, earnings: null, spend: null, refund: null });
const receipt = (date, spend) => ({ date, type: "Receipt", ref: "R", order: "",
  revenue: null, cogs: null, fees: null, earnings: null, spend, refund: null });
const ret = (date, refund, costBack) => ({ date, type: "Return", ref: "RMA", order: "",
  revenue: null, cogs: null, fees: null, earnings: null, spend: null, refund, costBack: costBack || 0 });
// acctRange(): "YYYY-MM-DD" + "T00:00:00" / "T23:59:59", parsed as local time.
// core.js runs in its own vm realm, so copy its arrays into this one before deepEqual.
const keys = months => Array.from(months, m => m.key);
const range = (from, to) => [new Date(from + "T00:00:00").getTime(), new Date(to + "T23:59:59").getTime()];

test("one row per month in the range, quiet months included as real $0 rows", () => {
  const G = freshCore();
  const [from, to] = range("2026-07-15", "2026-10-10");
  const { months, totals } = G.pnlByMonth([sale("2026-09-10T15:00:00Z", 10, 4, 1)], from, to);
  assert.deepEqual(keys(months), ["2026-07", "2026-08", "2026-09", "2026-10"]);
  for (const k of [0, 1, 3]) {
    const m = months[k];
    assert.equal(m.sales, 0);
    assert.equal(m.revenue, 0); assert.equal(m.cogs, 0); assert.equal(m.fees, 0);
    assert.equal(m.refunds, 0); assert.equal(m.gross, 0); assert.equal(m.net, 0);
  }
  assert.equal(months[2].net, 5);
  assert.equal(totals.net, 5);
});

test("partial first/last months are clipped to the range and flagged; whole months aren't", () => {
  const G = freshCore();
  const [from, to] = range("2026-07-15", "2026-09-30");
  const { months } = G.pnlByMonth([], from, to);
  assert.equal(months[0].partial, true);
  assert.equal(months[0].start, from);
  assert.equal(months[1].partial, false, "August is fully inside the range");
  assert.equal(months[1].start, new Date(2026, 7, 1).getTime());
  assert.equal(months[1].end, new Date(2026, 8, 1).getTime() - 1);
  assert.equal(months[2].partial, false, "a range ending 23:59:59 on the 30th covers September to the second");
  assert.equal(months[2].end, to);
});

test("line maths: gross = revenue - COGS; net = gross - fees - refunds; receipt spend left out", () => {
  const G = freshCore();
  const [from, to] = range("2026-10-01", "2026-10-31");
  const rows = [
    sale("2026-10-02T15:00:00Z", 20, 8, 2.5),
    sale("2026-10-05T15:00:00Z", 12.4, 3.1, 1.25),
    receipt("2026-10-06T15:00:00Z", 500),
    ret("2026-10-07T15:00:00Z", 4)
  ];
  const { months, totals } = G.pnlByMonth(rows, from, to);
  assert.equal(months.length, 1);
  const m = months[0];
  assert.equal(m.sales, 2);
  assert.equal(m.returns, 1);
  assert.equal(m.revenue, 32.4);
  assert.equal(m.cogs, 11.1);
  assert.equal(m.gross, 21.3);
  assert.equal(m.fees, 3.75);
  assert.equal(m.refunds, 4);
  assert.equal(m.net, 13.55, "21.30 - 3.75 - 4.00; the $500 receipt is stock, not an expense");
  assert.deepEqual(
    { revenue: totals.revenue, cogs: totals.cogs, gross: totals.gross, fees: totals.fees, refunds: totals.refunds, net: totals.net },
    { revenue: m.revenue, cogs: m.cogs, gross: m.gross, fees: m.fees, refunds: m.refunds, net: m.net });
});

test("totals reconcile with the page's tiles, computed the tiles' way over the same rows", () => {
  const G = freshCore();
  const [from, to] = range("2026-08-20", "2026-10-08");
  const rows = [
    sale("2026-08-21T15:00:00Z", 10.1, 3.3, 1.01),
    sale("2026-09-03T15:00:00Z", 0.2, 0.1, null),
    sale("2026-09-30T15:00:00Z", 7.7, 2.2, 0.77),
    ret("2026-09-12T15:00:00Z", 1.1),
    ret("2026-10-01T15:00:00Z", null), // a return with no refund on file
    receipt("2026-10-02T15:00:00Z", 30),
    sale("2026-10-07T15:00:00Z", 99.99, 45.45, 9.99)
  ];
  // renderAccounting()'s tile sums.
  const revenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
  const cogs = rows.reduce((s, r) => s + (r.cogs || 0), 0);
  const refund = rows.reduce((s, r) => s + (r.refund || 0), 0);
  const { months, totals } = G.pnlByMonth(rows, from, to);
  assert.equal(totals.revenue, G.round2(revenue));
  assert.equal(totals.cogs, G.round2(cogs));
  assert.equal(totals.gross, G.round2(revenue - cogs));
  assert.equal(totals.refunds, G.round2(refund));
  // ...and the CSV's Fees column summed (blank cells skipped).
  assert.equal(totals.fees, G.round2(rows.reduce((s, r) => s + (r.fees == null ? 0 : r.fees), 0)));
  // The month rows add up to the total, to the cent.
  for (const k of ["revenue", "cogs", "gross", "fees", "refunds", "net"]) {
    assert.equal(G.round2(months.reduce((s, m) => s + m[k], 0)), totals[k], k);
  }
  assert.equal(totals.sales, 4);
  assert.equal(totals.returns, 2);
});

test("a sale with no fee breakdown counts $0 fees and is flagged, not guessed", () => {
  const G = freshCore();
  const [from, to] = range("2026-10-01", "2026-10-31");
  const { months, totals } = G.pnlByMonth([
    sale("2026-10-02T15:00:00Z", 10, 4),         // never fetched: fees null
    sale("2026-10-03T15:00:00Z", 10, 4, 0)       // fetched, genuinely $0 fee
  ], from, to);
  assert.equal(months[0].fees, 0);
  assert.equal(months[0].salesMissingFees, 1);
  assert.equal(totals.salesMissingFees, 1);
  assert.equal(totals.net, 12);
});

test("refunds: a month with only a refund shows a loss", () => {
  const G = freshCore();
  const [from, to] = range("2026-09-01", "2026-10-31");
  const { months } = G.pnlByMonth([
    sale("2026-09-10T15:00:00Z", 30, 10, 3),
    ret("2026-10-04T15:00:00Z", 12.5)
  ], from, to);
  assert.equal(months[0].net, 17);
  assert.equal(months[1].revenue, 0);
  assert.equal(months[1].refunds, 12.5);
  assert.equal(months[1].gross, 0, "a refund isn't netted into gross, so gross still matches the tile");
  assert.equal(months[1].net, -12.5);
});

test("month boundary is local time: 10pm Oct 31 in Chicago is October, though it's Nov 1 in UTC", () => {
  const G = freshCore();
  const [from, to] = range("2026-10-01", "2026-11-30");
  const lateHalloween = "2026-11-01T03:00:00.000Z"; // 22:00 CDT on Oct 31
  const { months } = G.pnlByMonth([sale(lateHalloween, 10, 4, 1)], from, to);
  assert.equal(months[0].key, "2026-10");
  assert.equal(months[0].sales, 1);
  assert.equal(months[1].sales, 0);
});

test("month boundary is local time east of UTC too: 1am Nov 1 in Tokyo is November", () => {
  process.env.TZ = "Asia/Tokyo";
  const G = freshCore();
  const [from, to] = range("2026-10-01", "2026-11-30");
  const tokyoEarlyNov1 = "2026-10-31T16:00:00.000Z"; // 01:00 JST on Nov 1
  const { months } = G.pnlByMonth([sale(tokyoEarlyNov1, 10, 4, 1)], from, to);
  assert.equal(months[0].sales, 0);
  assert.equal(months[1].key, "2026-11");
  assert.equal(months[1].sales, 1);
});

test("stepping months survives DST changes and the year boundary", () => {
  const G = freshCore();
  // US DST ends Nov 1 2026 and starts Mar 8 2027.
  const [from, to] = range("2026-10-31", "2027-03-31");
  const { months } = G.pnlByMonth([sale("2027-01-01T06:30:00Z", 5, 1, 0)], from, to); // 00:30 CST Jan 1
  assert.deepEqual(keys(months), ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  assert.equal(months[2].sales, 0, "00:30 local on Jan 1 is January, not December");
  assert.equal(months[3].sales, 1);
  assert.equal(months[4].end, new Date(2027, 2, 1).getTime() - 1, "February ends at local midnight Mar 1");
});

test("rows outside the range are ignored entirely", () => {
  const G = freshCore();
  const [from, to] = range("2026-10-01", "2026-10-31");
  const { months, totals } = G.pnlByMonth([
    sale("2026-09-30T12:00:00Z", 100, 1, 1),
    sale("2026-10-15T12:00:00Z", 10, 4, 1),
    sale("2026-11-02T12:00:00Z", 100, 1, 1)
  ], from, to);
  assert.equal(months.length, 1);
  assert.equal(totals.revenue, 10);
});

test("cent amounts don't pick up float noise (0.1 + 0.2)", () => {
  const G = freshCore();
  const [from, to] = range("2026-10-01", "2026-10-31");
  const { totals } = G.pnlByMonth([
    sale("2026-10-02T15:00:00Z", 0.1, 0, 0), sale("2026-10-03T15:00:00Z", 0.2, 0, 0)
  ], from, to);
  assert.equal(totals.revenue, 0.3);
  assert.equal(totals.net, 0.3);
});

test("no range: months come from the rows' own first and last dates; no rows means no months", () => {
  const G = freshCore();
  const { months } = G.pnlByMonth([
    sale("2026-06-10T15:00:00Z", 1, 0, 0), ret("2026-08-10T15:00:00Z", 1)
  ], null, null);
  assert.deepEqual(keys(months), ["2026-06", "2026-07", "2026-08"]);
  assert.equal(months[0].partial, true, "starts Jun 10");
  const fromFirst = G.pnlByMonth([sale("2026-06-01T20:00:00Z", 1, 0, 0), sale("2026-06-30T20:00:00Z", 1, 0, 0)], null, null);
  assert.equal(fromFirst.months[0].partial, false, "rows on the 1st and the 30th cover June by whole days");
  const empty = G.pnlByMonth([], null, null);
  assert.equal(empty.months.length, 0);
  assert.equal(empty.totals.net, 0);
  const onlyFrom = G.pnlByMonth([], range("2026-10-01", "2026-10-01")[0], null);
  assert.deepEqual(keys(onlyFrom.months), ["2026-10"]);
});

test("a To date before the From date gives no months rather than a negative span", () => {
  const G = freshCore();
  const [, to] = range("2026-09-01", "2026-09-01");
  const [from] = range("2026-10-01", "2026-10-01");
  assert.equal(G.pnlByMonth([sale("2026-09-15T15:00:00Z", 1, 0, 0)], from, to).months.length, 0);
});

/* ---------- Returned stock (cost back) ---------- */

test("returnCostBack: qty x unitCost of a restocked return's costed lines; write-offs and uncosted lines add nothing", () => {
  const G = freshCore();
  const lines = [{ qty: 2, unitCost: 1.5 }, { qty: 1, unitCost: 0.25 }, { qty: 3, unitCost: null }, { qty: 1 }];
  assert.equal(G.returnCostBack({ disposition: "restock", lines }), 3.25);
  assert.equal(G.returnCostBack({ lines }), 3.25, "a return with no disposition predates the field and was a restock");
  assert.equal(G.returnCostBack({ disposition: "damaged", lines }), 0, "written off: the original COGS stays charged");
  assert.equal(G.returnCostBack({ disposition: "other", lines }), 0);
  assert.equal(G.returnCostBack({ disposition: "restock", lines: [] }), 0);
  assert.equal(G.returnCostBack(null), 0);
});

test("sell, refund and restock, resell: the card's cost is charged once, not twice", () => {
  const G = freshCoreWithLocation();
  G.state.locations[0].sellFrom = true; // a Manapool order only pulls from sell-from stock (#91)
  const card = { set: "a25", lang: "en", finish: "nonfoil", condition: "NM" };
  const info = { name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
    tcgplayerId: "123", scryfallId: "abc-123", price: 10, priceNote: "", note: "", meta: {} };
  G.addCopies(Object.assign({ num: "141", locationId: "loc1", qty: 1, info, unitCost: 4,
    action: "receipt", receiptId: "T1", note: "" }, card));
  const sell = (orderId, pickedAt) => {
    const pl = G.newPickList({ source: "manapool", orderId });
    G.pickLists().push(pl);
    G.addToPickList(pl.id, Object.assign({ kind: "card", collector: "141", name: "Lightning Bolt", qty: 1, unitPrice: 10 }, card));
    G.completePickList(pl.id);
    pl.pickedAt = pickedAt; // pin the sale to a month
    return pl;
  };
  // October: sell it for $10 (cost $4).
  const first = sell("o1", "2026-10-10T15:00:00.000Z");
  assert.equal(first.cogs, 4);
  // October: buyer returns it, refunded $10, restocked at its $4 cost - the way returns.page.js posts it.
  G.addCopies(Object.assign({ num: "141", locationId: "loc1", qty: 1, info, unitCost: 4, action: "return", note: "" }, card));
  const doc = G.recordReturn({ disposition: "restock", locationId: "loc1", refundTotal: 10,
    lines: [Object.assign({ collector: "141", name: "Lightning Bolt", qty: 1, unitCost: 4 }, card)] });
  doc.ts = "2026-10-20T15:00:00.000Z";
  // November: sells again for $10, and its restored $4 basis is charged to COGS again.
  const second = sell("o2", "2026-11-05T15:00:00.000Z");
  assert.equal(second.cogs, 4, "the restocked cost really does hit COGS a second time");

  // accountingRows()'s shape.
  const rows = G.state.pickLists.map(p => sale(p.pickedAt, p.revenue, p.cogs, 0))
    .concat(G.state.returns.map(r => ret(r.ts, r.refundTotal, G.returnCostBack(r))));
  const [from, to] = range("2026-10-01", "2026-11-30");
  const { months, totals } = G.pnlByMonth(rows, from, to);
  assert.equal(months[0].costBack, 4);
  assert.equal(months[0].net, 0, "Oct: 10 - 4 - 10 refunded + 4 back in stock");
  assert.equal(months[1].net, 6, "Nov: 10 - 4");
  assert.equal(totals.net, 6, "one $4 card sold once for $10 overall: $6, not $2");
  assert.equal(totals.cogs, 8, "COGS still equals the tile (both sales' cost)");
  assert.equal(totals.gross, 12);
});

test("a written-off return's cost is not added back: its original COGS is the loss", () => {
  const G = freshCore();
  const [from, to] = range("2026-10-01", "2026-10-31");
  const r = { disposition: "damaged", refundTotal: 10, lines: [{ qty: 1, unitCost: 4 }] };
  const { totals } = G.pnlByMonth([sale("2026-10-10T15:00:00Z", 10, 4, 0),
    ret("2026-10-20T15:00:00Z", 10, G.returnCostBack(r))], from, to);
  assert.equal(totals.costBack, 0);
  assert.equal(totals.net, -4);
});

/* ---------- Date presets ---------- */

test("presets use the LOCAL date: late evening west of UTC stays today", () => {
  const G = freshCore();
  const now = new Date(2026, 9, 8, 22, 0).getTime(); // 10pm Oct 8 in Chicago = Oct 9 UTC
  assert.deepEqual(Object.assign({}, G.accountingPresetRange("month", now)), { from: "2026-10-01", to: "2026-10-08" });
});

test("presets use the LOCAL date: early morning east of UTC doesn't slip into last month", () => {
  process.env.TZ = "Asia/Tokyo";
  const G = freshCore();
  const now = new Date(2026, 9, 1, 5, 0).getTime(); // 5am Oct 1 in Tokyo = Sep 30 UTC
  assert.deepEqual(Object.assign({}, G.accountingPresetRange("month", now)), { from: "2026-10-01", to: "2026-10-01" });
});

test("day-count presets step by calendar day across a DST change", () => {
  const G = freshCore();
  // US DST starts Mar 14 2027. 00:30 on Mar 20 minus 7 x 24h is 23:30 on Mar 12.
  const now = new Date(2027, 2, 20, 0, 30).getTime();
  assert.equal(G.accountingPresetRange("7", now).from, "2027-03-13");
  // ...and the 30-day default range, across the same change.
  assert.equal(G.accountingPresetRange("30", new Date(2027, 3, 1, 0, 30).getTime()).from, "2027-03-02");
});

test("month, quarter and year presets, including the year boundary; unknown key is null", () => {
  const G = freshCore();
  const jan = new Date(2027, 0, 15, 12).getTime();
  const plain = k => Object.assign({}, G.accountingPresetRange(k, jan));
  assert.deepEqual(plain("lastMonth"), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(plain("quarter"), { from: "2027-01-01", to: "2027-01-15" });
  assert.deepEqual(plain("ytd"), { from: "2027-01-01", to: "2027-01-15" });
  assert.deepEqual(plain("30"), { from: "2026-12-16", to: "2027-01-15" });
  assert.equal(G.accountingPresetRange("bogus", jan), null);
});
