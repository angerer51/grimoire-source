"use strict";
/* #370: the Buy List's Restock hints, core.js's side. restockCandidates()
   finds what the account sold through its Manapool orders (picked tickets)
   or has customers wanting, and has none of free to sell now; restockRows()
   joins POST /api/prices/restock's answer to them. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore, freshCoreWithLocation } = require("../test-lib/core-shim");

const plain = v => JSON.parse(JSON.stringify(v));
const stack = o => Object.assign({ id: "s" + Math.random(), name: "Card", set: "neo", collector: "1", lang: "en",
  finish: "nonfoil", condition: "NM", quantity: 1 }, o);
const line = o => Object.assign({ kind: "card", name: "Card", set: "neo", collector: "1", lang: "en", finish: "nonfoil", condition: "NM", qty: 1 }, o);
const ticket = (status, lines, o) => Object.assign({ id: "p" + Math.random(), orderId: "o" + Math.random(), source: "manapool",
  status, pickedAt: status === "open" ? null : "2026-10-20T10:00:00Z", lines }, o);

test("restockCandidates: sold printings and wanted cards you have none of free to sell; most sold first", () => {
  const G = freshCore();
  const lists = [
    ticket("shipped", [line({ name: "Sheoldred", set: "DMU", collector: "107", qty: 2 }), line({ name: "Bolt", set: "2x2", collector: "117" })]),
    ticket("picked", [line({ name: "Sheoldred", set: "dmu", collector: "107", finish: "foil", qty: 3 }), line({ kind: "sealed", name: "Box", qty: 9 })]),
    ticket("open", [line({ name: "Ragavan", set: "mh2", collector: "138", qty: 5 })]),                 // not picked yet: not a sale
    { id: "deck", source: "deck", status: "picked", pickedAt: "2026-10-20T10:00:00Z",
      lines: [line({ name: "Deck Pull", set: "one", collector: "5", qty: 4 })] }                        // no order: not a sale
  ];
  const cards = [
    stack({ name: "Bolt", set: "2x2", collector: "117", quantity: 2, loans: [{ qty: 2, to: "Sam" }] }),  // all lent: none free
    stack({ name: "Fable", set: "neo", collector: "141", quantity: 1 }),
    stack({ name: "Oko", set: "eld", collector: "197", quantity: 1, held: "rcpt1" })                      // on an open receipt
  ];
  const wants = [
    { id: "w1", customerId: "cu1", name: "Fable", set: "neo", collector: "141", lang: "en", finish: "nonfoil" },   // in stock: no
    { id: "w2", customerId: "cu1", name: "Sheoldred", set: "dmu", collector: "107", lang: "en", finish: "nonfoil" },
    { id: "w3", customerId: "cu2", name: "Sheoldred", set: "dmu", collector: "107", lang: "en", finish: "nonfoil" },
    { id: "w4", customerId: "cu1", name: "Oko, Thief of Crowns", set: "", collector: "" },                 // any printing
    { id: "w5", customerId: "cu3", name: "Oko, Thief of Crowns // Back", set: "", collector: "" },
    { id: "w6", customerId: "cu3", name: "Fable", set: "", collector: "" },
    { id: "w7", customerId: "cu2", name: "Sheoldred", set: "", collector: "" }
  ];
  cards.push(stack({ name: "Oko, Thief of Crowns", set: "eld", collector: "197", quantity: 0 }));
  const c = G.restockCandidates(cards, lists, wants, null);
  assert.deepEqual(plain(c.prints), [
    { key: "dmu|107", q: "dmu|107", set: "dmu", collector: "107", lang: "en", finish: "foil", name: "Sheoldred", setName: "", oracleId: "",
      sold: 5, wanted: 2 },
    { key: "2x2|117", q: "2x2|117", set: "2x2", collector: "117", lang: "en", finish: "nonfoil", name: "Bolt", setName: "", oracleId: "",
      sold: 1, wanted: 0 }
  ], "the foil sold most, so that's the finish to watch; lent copies aren't stock to sell");
  assert.deepEqual(plain(c.names), [
    { key: "Sheoldred", name: "Sheoldred", oracleId: "", sold: 5, wanted: 1 },
    { key: "Oko, Thief of Crowns", name: "Oko, Thief of Crowns", oracleId: "", sold: 0, wanted: 2 }
  ], "a held receipt's copies aren't free yet; a name want counts every printing; the front face matches");
  assert.deepEqual(plain(G.restockRequest(c)), { prints: ["dmu|107", "2x2|117"], names: ["Sheoldred", "Oko, Thief of Crowns"] });

  const nothing = G.restockCandidates([], [], [], null);
  assert.deepEqual(plain(nothing), { prints: [], names: [] });
});

test("restockCandidates: a printing in another language keeps it for the server; copies earmarked for an open ticket aren't stock", () => {
  const G = freshCore();
  const lists = [ticket("shipped", [line({ name: "Ulamog", set: "bfz", collector: "15", lang: "ja" }), line({ name: "Bolt", set: "m10", collector: "146" })])];
  const cards = [stack({ id: "b1", name: "Bolt", set: "m10", collector: "146", quantity: 1 })];
  const c = G.restockCandidates(cards, lists, [], new Map([["b1", 1]]));
  assert.deepEqual(plain(c.prints.map(e => e.q)), ["m10|146", "bfz|15|ja"], "a tie goes by name");
  assert.equal(G.restockCandidates(cards, lists, [], null).prints.length, 1, "unreserved, the one Bolt is stock");
});

test("restockHints: the account's own stock, tickets and wants, with an open ticket's earmark taken off", () => {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations[0].sellFrom = true;
  G.state.cards.push(stack({ id: "b1", name: "Bolt", set: "m10", collector: "146", quantity: 1, locationId: "loc1" }));
  G.state.pickLists = [ticket("shipped", [line({ name: "Bolt", set: "m10", collector: "146", qty: 3 })])];
  assert.equal(G.restockHints().prints.length, 0, "one free copy on the shelf");
  G.state.pickLists.push(ticket("open", [line({ name: "Bolt", set: "m10", collector: "146" })]));
  assert.deepEqual(plain(G.restockHints().prints.map(e => [e.key, e.sold])), [["m10|146", 3]], "the last copy is set aside for an order");
});

test("restockRows: only the qualifying candidates, SELLING FAST first, then Sold 7d; a name row watches its best-selling printing", () => {
  const G = freshCore();
  const c = {
    prints: [
      { key: "dmu|107", q: "dmu|107", set: "dmu", collector: "107", lang: "en", finish: "foil", name: "Sheoldred", setName: "Dominaria United", oracleId: "o1", sold: 5, wanted: 2 },
      { key: "2x2|117", q: "2x2|117", set: "2x2", collector: "117", lang: "en", finish: "nonfoil", name: "Bolt", setName: "", oracleId: "", sold: 1, wanted: 0 },
      { key: "bfz|15", q: "bfz|15|ja", set: "bfz", collector: "15", lang: "ja", finish: "nonfoil", name: "Ulamog", setName: "", oracleId: "", sold: 1, wanted: 0 }
    ],
    names: [{ key: "Oko", name: "Oko", oracleId: "", sold: 0, wanted: 2 }, { key: "Nope", name: "Nope", oracleId: "", sold: 0, wanted: 1 }]
  };
  const d = {
    topN: 100,
    prints: { "dmu|107": [40, 0, false, 3], "bfz|15|ja": [6, 1, true, 812] },
    names: { Oko: [55, 0, false, 2, { set: "eld", collector: "197", lang: "en", setName: "Throne of Eldraine", oracleId: "o2" }] },
    sales: { historySince: "2026-10-18", comparable: true }
  };
  const rows = G.restockRows(c, d);
  assert.deepEqual(plain(rows.map(r => [r.key, r.sold7, r.atLeast, r.hot, r.rank, r.ownSold, r.wanted])), [
    ["bfz|15", 6, true, true, 812, 1, 0],
    ["name:Oko", 55, false, false, 2, 0, 2],
    ["dmu|107", 40, false, false, 3, 5, 2]
  ]);
  const oko = rows[1];
  assert.equal(oko.printing, false);
  assert.deepEqual(plain([oko.set, oko.collector, oko.finish, oko.oracleId]), ["eld", "197", "nonfoil", "o2"]);
  assert.equal(rows[2].finish, "foil", "a printing row watches the finish it sold in");
  assert.equal(G.restockRows(c, { sales: { error: "down" } }).length, 0);
});
