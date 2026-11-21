"use strict";
/* #366: Sold 7d and SELLING FAST on your own stock. core.js's side of
   /api/prices/sold-mine: one fetch per page, a stack's answer (soldOf), the
   query builder's "Selling fast" flag and the Dashboard's count of listed
   cards. The network is a canned response (core-shim's fetch). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const SALES = { historySince: "2026-10-18", historyDays: 19, window7Complete: true, comparable: true, hotNeedsDays: 14 };

function coreWith(body, calls) {
  return freshCore({
    fetch: async url => {
      if (calls) calls.push(url);
      if (url !== "/api/prices/sold-mine") throw new Error("unexpected " + url);
      if (body instanceof Error) return { status: 500, ok: false, text: async () => "{}", json: async () => ({}) };
      return { status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body };
    }
  });
}
const stack = (o) => Object.assign({ id: "c" + Math.random(), name: "Card", set: "neo", collector: "1", lang: "en",
  finish: "nonfoil", condition: "NM", quantity: 1, listedQty: 0 }, o);
const plain = v => JSON.parse(JSON.stringify(v));

test("soldOf: a printing that sold, one that didn't, one no printing was found for; every finish/language shares the number", async () => {
  const calls = [];
  const G = coreWith({ sold: { "neo|1": [12, 0, true], "neo|2": [3, 1, false] }, unmatched: ["tok|9"], sales: SALES }, calls);
  assert.equal(G.soldOf(stack()), null, "nothing until it's loaded");
  let heard = 0;
  G.on("sold", () => { heard++; });
  await Promise.all([G.loadSoldMine(), G.loadSoldMine()]);
  assert.equal(calls.length, 1, "one request per page");
  assert.equal(heard, 1, "tables hear once when it lands");
  assert.deepEqual(plain(G.soldOf(stack())), { n: 12, atLeast: false, hot: true, daysLeft: null, available: null });
  assert.deepEqual(plain(G.soldOf(stack({ finish: "foil", lang: "ja", condition: "LP" }))), { n: 12, atLeast: false, hot: true, daysLeft: null, available: null });
  assert.deepEqual(plain(G.soldOf(stack({ collector: "2" }))), { n: 3, atLeast: true, hot: false, daysLeft: null, available: null }, "≥ 3: a minimum");
  assert.deepEqual(plain(G.soldOf(stack({ collector: "7" }))), { n: 0, atLeast: false, hot: false, daysLeft: null, available: null }, "held but nothing sold");
  assert.equal(G.soldOf(stack({ set: "tok", collector: "9" })), null, "no printing matched: blank, not 0");
  await G.loadSoldMine(true);
  assert.equal(calls.length, 2, "force asks again");
});

test("soldOf: an incomplete week marks a 0 as a minimum; too early to compare leaves the flag unknown; no history or a failed load is blank", async () => {
  let G = coreWith({ sold: {}, unmatched: [], sales: Object.assign({}, SALES, { window7Complete: false, comparable: false }) });
  await G.loadSoldMine();
  assert.deepEqual(plain(G.soldOf(stack())), { n: 0, atLeast: true, hot: null, daysLeft: null, available: null });
  G = coreWith({ sold: {}, unmatched: [], sales: { historySince: null } });
  await G.loadSoldMine();
  assert.equal(G.soldOf(stack()), null);
  G = coreWith(new Error("down"));
  await G.loadSoldMine();
  assert.equal(G.soldOf(stack()), null);
  assert.match(G.soldSales().error, /couldn't be loaded/);
});

test("soldOf and daysLeftView (#368): days of listings left, rounded with ~, its tooltip saying it's market-wide", async () => {
  const G = coreWith({ sold: { "neo|1": [49, 0, true, 2, 14], "neo|2": [30, 1, false, 0.4, 2] }, unmatched: [], sales: SALES });
  await G.loadSoldMine();
  const x = G.soldOf(stack());
  assert.equal(x.daysLeft, 2);
  assert.equal(x.available, 14);
  const v = G.daysLeftView(x.daysLeft, x.available, x.n, x.atLeast);
  assert.equal(v.text, "~2d");
  assert.match(v.title, /^About 2 days of listings left: 14 copies listed on Manapool now \(every seller together\) ÷ about 7 sold a day/);
  assert.match(v.title, /not a forecast for your own price/);
  const y = G.soldOf(stack({ collector: "2" }));
  const w = G.daysLeftView(y.daysLeft, y.available, y.n, y.atLeast);
  assert.equal(w.text, "<1d");
  assert.match(w.title, /could run out sooner/, "a capped count: the days are a maximum");
  assert.equal(G.daysLeftView(0, 0, 12, false).text, "0d");
  assert.match(G.daysLeftView(0, 0, 12, false).title, /^None left/);
  assert.equal(G.daysLeftView(400, 400, 7, false).text, ">1y");
  assert.equal(G.daysLeftView(63.4, 63, 7, false).text, "~63d");
  assert.equal(G.daysLeftView(null, null, 0, false, "Too few sales").text, "—");
  assert.equal(G.daysLeftView(null, null, 0, false, "Too few sales").title, "Too few sales");
});

test("matchesQuery: Selling fast keeps only stacks whose printing is SELLING FAST, and counts as a query condition", async () => {
  const G = coreWith({ sold: { "neo|1": [12, 0, true], "neo|2": [30, 0, false] }, unmatched: [], sales: SALES });
  const q = Object.assign(G.emptyQuery(), { sellingFast: true });
  assert.equal(G.queryFieldCount(q), 1);
  assert.equal(G.emptyQuery().sellingFast, false);
  assert.equal(G.matchesQuery(stack(), q), false, "not loaded yet: nothing matches");
  await G.loadSoldMine();
  assert.equal(G.matchesQuery(stack(), q), true);
  assert.equal(G.matchesQuery(stack({ collector: "2" }), q), false, "sold plenty, but at its usual pace");
  assert.equal(G.matchesQuery(stack({ collector: "5" }), q), false);
  const listedFast = Object.assign(G.emptyQuery(), { sellingFast: true, listed: true });
  assert.equal(G.matchesQuery(stack({ listedQty: 1 }), listedFast), true);
  assert.equal(G.matchesQuery(stack({ listedQty: 0 }), listedFast), false, "the Dashboard link's view: listed ones only");
});

test("listedSellingFast: listed stacks of SELLING FAST printings, each printing once; null when there's nothing to say", async () => {
  const G = coreWith({ sold: { "neo|1": [12, 0, true], "neo|2": [9, 0, true], "neo|3": [4, 0, false] }, unmatched: [], sales: SALES });
  G.state.cards.push(
    stack({ collector: "1", listedQty: 2 }), stack({ collector: "1", listedQty: 1, finish: "foil" }),  // one printing, two stacks
    stack({ collector: "2", listedQty: 0 }),                                                           // fast, not listed
    stack({ collector: "3", listedQty: 4 }));                                                          // listed, not fast
  assert.equal(G.listedSellingFast(), null, "not loaded");
  await G.loadSoldMine();
  assert.equal(G.listedSellingFast(), 1);
  const early = coreWith({ sold: { "neo|1": [12, 0, null] }, unmatched: [], sales: Object.assign({}, SALES, { comparable: false }) });
  early.state.cards.push(stack({ listedQty: 1 }));
  await early.loadSoldMine();
  assert.equal(early.listedSellingFast(), null, "too early to compare: no line");
});
