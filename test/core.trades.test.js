"use strict";
/* #335: recording a trade made in person (core.js "Trades made in person").
   One step takes the given copies out and adds the received ones; the
   received cards' cost basis is the market value given, split by value;
   unpriced cards aren't counted; the record is part of the saved document,
   merged by id. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { freshCore } = require("../test-lib/core-shim");
const merge = require(path.join(__dirname, "..", "server", "lib", "merge"));

const plain = v => JSON.parse(JSON.stringify(v));
let n = 0;
function world() {
  const G = freshCore();
  G.state.locations.push(G.newLocation({ id: "BINDER", name: "Trade binder", type: "Binder" }));
  return G;
}
function stack(G, name, quantity, price, extra) {
  const r = Object.assign({ id: "r" + (++n), name, set: "mh2", collector: String(n), lang: "en", finish: "nonfoil", condition: "NM",
    quantity, listedQty: 0, price, locationId: "BINDER", costQty: 0, costTotal: 0, avgCost: null, imageUrl: "" }, extra || {});
  G.state.cards.push(r);
  return r;
}
const info = (name, collector, price) => ({ name, collector, setName: "Set", rarity: "rare", tcgplayerId: "", scryfallId: "sf-" + collector,
  price, priceNote: "", note: "", meta: {} });
const got = (name, collector, qty, price) => ({ set: "neo", num: collector, lang: "en", finish: "nonfoil", condition: "NM", qty, info: info(name, collector, price) });
const owned = (G, name) => G.state.cards.filter(r => r.name === name).reduce((s, r) => s + r.quantity, 0);

test("a trade takes the given copies out and adds the received ones, valued at market", () => {
  const G = world();
  const path = stack(G, "Path to Exile", 3, 4);
  const bolt = stack(G, "Lightning Bolt", 1, 2);
  const rec = G.recordTrade({
    date: "2026-10-23", who: " Sam at FNM ", note: "Friday",
    locationId: "BINDER",
    gave: [{ id: path.id, qty: 2 }, { id: bolt.id, qty: 1 }],
    got: [got("Ragavan", "1", 1, 6), got("Fable", "2", 2, 1.5)]
  });
  assert.equal(owned(G, "Path to Exile"), 1);
  assert.equal(owned(G, "Lightning Bolt"), 0, "a stack given away whole is gone");
  assert.ok(!G.state.cards.some(r => r.id === bolt.id));
  assert.equal(owned(G, "Ragavan"), 1);
  assert.equal(owned(G, "Fable"), 2);
  assert.equal(rec.who, "Sam at FNM");
  assert.equal(rec.date, "2026-10-23");
  assert.equal(rec.gaveValue, 10);
  assert.equal(rec.gotValue, 9);
  assert.equal(rec.gave.length, 2);
  assert.deepEqual(plain(rec.gave.map(l => [l.name, l.qty, l.price])), [["Path to Exile", 2, 4], ["Lightning Bolt", 1, 2]]);
  assert.equal(G.state.trades[0].id, rec.id);
});

test("the cards received take the value given as their cost, split by market value", () => {
  const G = world();
  const a = stack(G, "Path to Exile", 2, 6);
  G.recordTrade({ locationId: "BINDER", gave: [{ id: a.id, qty: 2 }], got: [got("Ragavan", "1", 1, 30), got("Fable", "2", 2, 5)] });
  const rag = G.state.cards.find(r => r.name === "Ragavan"), fab = G.state.cards.find(r => r.name === "Fable");
  // $12 given, weighted 30 : 10 -> $9 and $3 ($1.50 each).
  assert.equal(rag.costTotal, 9);
  assert.equal(rag.costQty, 1);
  assert.equal(fab.costTotal, 3);
  assert.equal(fab.avgCost, 1.5);
  const rec = G.state.trades[0];
  assert.equal(rec.costTotal, 12);
  assert.deepEqual(plain(rec.got.map(l => l.unitCost)), [9, 1.5]);
});

test("unpriced cards aren't counted; nothing priced given means no cost for the cards received", () => {
  const G = world();
  const a = stack(G, "Odd promo", 1, null);
  const rec = G.recordTrade({ locationId: "BINDER", gave: [{ id: a.id, qty: 1 }], got: [got("Fable", "2", 1, 5), got("Token", "3", 2, null)] });
  assert.equal(rec.gaveValue, 0);
  assert.equal(rec.gaveUnpriced, 1);
  assert.equal(rec.gotValue, 5);
  assert.equal(rec.gotUnpriced, 2);
  assert.equal(rec.costTotal, null);
  const fab = G.state.cards.find(r => r.name === "Fable");
  assert.equal(fab.costQty, 0, "no made-up $0 cost");
  assert.equal(fab.avgCost, null);
});

test("the given copies take their own cost basis with them", () => {
  const G = world();
  const a = stack(G, "Path to Exile", 4, 4, { costQty: 4, costTotal: 8, avgCost: 2 });
  G.recordTrade({ locationId: "BINDER", gave: [{ id: a.id, qty: 1 }], got: [] });
  assert.equal(a.quantity, 3);
  assert.equal(a.costQty, 3);
  assert.equal(a.costTotal, 6);
  assert.equal(a.avgCost, 2);
});

test("a trade that can't be done changes nothing", () => {
  const G = world();
  const a = stack(G, "Path to Exile", 1, 4);
  const before = JSON.stringify(G.state.cards);
  assert.throws(() => G.recordTrade({ locationId: "BINDER", gave: [{ id: a.id, qty: 2 }], got: [got("Fable", "2", 1, 5)] }), /only have 1/);
  assert.throws(() => G.recordTrade({ locationId: "NOWHERE", gave: [{ id: a.id, qty: 1 }], got: [got("Fable", "2", 1, 5)] }), /where the cards you got go/);
  assert.throws(() => G.recordTrade({ gave: [], got: [] }), /Add the cards/);
  assert.equal(JSON.stringify(G.state.cards), before);
  assert.equal(G.state.trades.length, 0);
});

test("trades are part of the saved document: a load keeps them and Undo takes a whole trade back", () => {
  const G = world();
  const a = stack(G, "Path to Exile", 2, 4);
  G.persist("seed");
  G.recordTrade({ locationId: "BINDER", who: "Sam", gave: [{ id: a.id, qty: 2 }], got: [got("Fable", "2", 1, 5)] });
  G.persist("trade with Sam");
  assert.equal(G.state.trades.length, 1);
  assert.equal(G.undo(), "trade with Sam");
  assert.equal(G.state.trades.length, 0);
  assert.equal(owned(G, "Path to Exile"), 2);
  assert.equal(owned(G, "Fable"), 0);
  G.redo();
  const G2 = freshCore();
  G2.adoptState(plain({ locations: G.state.locations, cards: G.state.cards, trades: G.state.trades.concat([{ who: "Old", gave: [{ name: "X", qty: "2", price: "1.5" }] }]) }));
  assert.equal(G2.state.trades.length, 2);
  assert.equal(G2.state.trades[0].who, "Sam");
  assert.ok(G2.state.trades[1].id, "a record without an id gets one");
  assert.equal(G2.state.trades[1].gaveValue, 3);
  assert.equal(G2.PATCH_KEYS.trades, "id", "patch saves send trades row by row, keyed as merge.js keys them");
});

test("deleting a record leaves the cards alone", () => {
  const G = world();
  const a = stack(G, "Path to Exile", 2, 4);
  const rec = G.recordTrade({ locationId: "BINDER", gave: [{ id: a.id, qty: 1 }], got: [got("Fable", "2", 1, 5)] });
  G.deleteTrade(rec.id);
  assert.equal(G.state.trades.length, 0);
  assert.equal(owned(G, "Path to Exile"), 1);
  assert.equal(owned(G, "Fable"), 1);
});

test("merge.js: two devices each recording a trade keep both", () => {
  assert.equal(merge.MERGE_ARRAYS.trades.key, "id");
  const a = { id: "tA", who: "Sam", gave: [], got: [] }, b = { id: "tB", who: "Ana", gave: [], got: [] };
  const r = merge.merge({ trades: [] }, { trades: [a] }, { trades: [b] });
  assert.deepEqual(r.merged.trades.map(t => t.id).sort(), ["tA", "tB"]);
});

test("a save merged with another device's lands out of order; the history is drawn newest first", () => {
  const old = { id: "tOld", date: "2026-10-20", ts: "2026-10-20T18:00:00.000Z", who: "Sam", gave: [], got: [] };
  const bob = { id: "tBob", date: "2026-10-27", ts: "2026-10-27T18:00:00.000Z", who: "Bob", gave: [], got: [] };
  const ana = { id: "tAna", date: "2026-10-27", ts: "2026-10-27T19:30:00.000Z", who: "Ana", gave: [], got: [] };
  // Both devices start from [old]; each records a trade at the front.
  const r = merge.merge({ trades: [old] }, { trades: [ana, old] }, { trades: [bob, old] });
  const merged = r.merged.trades.map(t => t.id);
  assert.equal(merged[0], "tOld", "the merge keeps the base's rows first");
  const G = freshCore();
  assert.deepEqual(G.tradesNewestFirst(r.merged.trades).map(t => t.id), ["tAna", "tBob", "tOld"]);
  assert.deepEqual(r.merged.trades.map(t => t.id), merged, "sorting draws a copy");
  // A trade dated earlier but recorded later sits by its date.
  const back = { id: "tBack", date: "2026-10-22", ts: "2026-10-28T09:00:00.000Z" };
  assert.deepEqual(G.tradesNewestFirst([old, back, ana]).map(t => t.id), ["tAna", "tBack", "tOld"]);
});

test("the cap keeps the newest trades by date, not by position", () => {
  const G = world();
  const a = stack(G, "Path to Exile", 2, 4);
  // A full history out of order (as merges leave it): newest first except
  // the newest of all, which is last, where trimming by position would drop
  // it and keep the oldest.
  const day = i => new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  G.state.trades = [];
  for (let i = 0; i < G.TRADES_MAX; i++) G.state.trades.push(G.normalizeTrade({ id: "t" + i, date: day(i), ts: day(i) + "T12:00:00.000Z" }));
  G.state.trades.reverse();
  const newest = G.state.trades.splice(0, 1)[0];
  G.state.trades.push(newest); // newest now last
  const rec = G.recordTrade({ locationId: "BINDER", gave: [{ id: a.id, qty: 1 }], got: [] });
  assert.equal(G.state.trades.length, G.TRADES_MAX);
  assert.equal(G.state.trades[0].id, rec.id);
  const ids = new Set(G.state.trades.map(t => t.id));
  assert.ok(ids.has(newest.id), "the newest older trade is kept even though it was last in the array");
  assert.ok(!ids.has("t0"), "the oldest trade is the one dropped");
});
