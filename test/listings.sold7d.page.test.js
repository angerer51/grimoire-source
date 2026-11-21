"use strict";
/* #366: Listings' Evaluate table gets a Sold 7d column and a "Selling fast
   only" box, and ?fast=1 (from the Dashboard) opens on just those listings.
   Through the real listings.page.js with a stand-in DOM (test-lib/page-shim.js);
   soldOf / the SELLING FAST data itself are in core.soldMine.test.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const SALES = { historySince: "2026-10-18", historyDays: 19, window7Complete: true, comparable: true, hotNeedsDays: 14 };

function listingsPage(opts) {
  const o = opts || {};
  const pg = loadPage("listings.page.js", {
    routes: url => {
      if (url === "/api/manapool/orders/cached") return { orders: [] };
      if (url === "/api/prices/sold-mine") return o.soldMine;
      return {};
    }
  });
  if (o.search) pg.sandbox.location.search = o.search;
  const G = pg.G;
  G.state.locations.push(G.newLocation({ id: "SELL", name: "Sell box", type: "bin", sellFrom: true }));
  const card = (id, name, collector, listedQty) => ({ id, name, set: "a25", collector, lang: "en", finish: "nonfoil",
    condition: "NM", quantity: 3, listedQty, price: 0.5, locationId: "SELL", costQty: 0, costTotal: 0, avgCost: null });
  // Both already fully listed: unchanged, so only "Show unchanged too" shows them.
  G.state.cards.push(card("bolt", "Lightning Bolt", "141", 3), card("ring", "Sol Ring", "200", 3));
  return pg;
}

test("?fast=1 shows every listing that is SELLING FAST, unchanged ones too; unticking shows the rest", async () => {
  const pg = listingsPage({ search: "?fast=1", soldMine: { sold: { "a25|141": [9, 0, true], "a25|200": [2, 0, false] }, unmatched: [], sales: SALES } });
  await pg.boot();
  await settle(10);
  assert.ok(pg.net.some(n => n.url === "/api/prices/sold-mine"));
  assert.equal(pg.$("planFast").checked, true);
  assert.equal(pg.$("planShowAll").checked, true);
  assert.equal(pg.$("planFast").disabled, false);
  const body = pg.$("planBody").innerHTML;
  assert.match(body, /Lightning Bolt/);
  assert.doesNotMatch(body, /Sol Ring/, "sold, but at its usual pace");
  pg.$("planFast").checked = false;
  await pg.$("planFast").fire("change");
  assert.match(pg.$("planBody").innerHTML, /Sol Ring/);
});

test("too early to compare: the box is off and can't be ticked, and a ?fast=1 link shows everything", async () => {
  const pg = listingsPage({ search: "?fast=1", soldMine: { sold: {}, unmatched: [], sales: Object.assign({}, SALES, { comparable: false }) } });
  await pg.boot();
  await settle(10);
  assert.equal(pg.$("planFast").disabled, true);
  assert.equal(pg.$("planFast").checked, false);
  assert.match(pg.$("planFastWrap").title, /Too early: SELLING FAST needs 14 days/);
  assert.match(pg.$("planBody").innerHTML, /Sol Ring/);
  assert.match(pg.$("planBody").innerHTML, /Lightning Bolt/);
});

test("Days left (#368): ~N days with its market-wide tooltip, a dash when there are too few sales", async () => {
  const pg = listingsPage({ search: "?fast=1",
    soldMine: { sold: { "a25|141": [49, 0, true, 2, 14], "a25|200": [2, 0, true] }, unmatched: [], sales: Object.assign({ daysLeftMinSales: 5 }, SALES) } });
  await pg.boot();
  await settle(10);
  const rows = pg.$("planBody").innerHTML.split("</tr>");
  const bolt = rows.find(r => /Lightning Bolt/.test(r)), ring = rows.find(r => /Sol Ring/.test(r));
  assert.match(bolt, /<td class="num hide-sm" data-v="2" title="About 2 days of listings left: 14 copies listed[^"]*not a forecast for your own price\.">~2d<\/td>/);
  assert.match(ring, /data-v="" title="Too few separate sales in the last 7 days \(it needs 5\)[^"]*"><span class="faint">—/);
});
