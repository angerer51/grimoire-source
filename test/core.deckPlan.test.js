"use strict";
/* #117 / #118: which copies Deck List's "Build the deck" takes. The preview
   and Build both read G.deckPlan(list, destId), so these rules are what the
   user sees and what moves. The owner's answers (2026-10-09):
   A. copies already in the destination count; only the rest move;
   B. copies reserved for an open Manapool order are never moved;
   C. non-sell-from and unlisted copies first, listed copies last, and the
      plan says how many listed copies move (the confirm warns);
   D. destination ceilings are ignored for deck builds. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const SOL = { name: "Sol Ring", collector: "263", setName: "Commander 2021", rarity: "uncommon",
  tcgplayerId: "1", scryfallId: "sol", price: 2, priceNote: "", note: "", meta: { oracleId: "o-sol" } };

function world() {
  const G = freshCore();
  G.state.locations.push(G.newLocation({ id: "BOX", name: "Atraxa", type: "Deck Box" }));
  G.state.locations.push(G.newLocation({ id: "BINDER", name: "Binder", type: "binder", sellFrom: false }));
  G.state.locations.push(G.newLocation({ id: "SELL", name: "Sell box", type: "bin", sellFrom: true, pickPriority: 1 }));
  return G;
}
function put(G, locationId, qty, opts) {
  const o = opts || {};
  const info = Object.assign({}, SOL, o.info || {});
  const r = G.addCopies({ set: o.set || "c21", num: info.collector, lang: "en", finish: "nonfoil", condition: o.condition || "NM",
    locationId, qty, info, action: "receipt", receiptId: "T1", note: "" });
  if (o.listed) r.listedQty = o.listed;
  return r;
}
// Spread first: the plan comes from core.js's own VM realm, whose arrays
// deepStrictEqual would not match against an array made here.
const pullsAt = a => [...a.pulls].map(p => p.locationId + ":" + p.take);

test("skipLocs: a location the owner chose not to take from is never a source, so the line stays short (#334)", () => {
  const G = world();
  put(G, "BINDER", 1);
  put(G, "SELL", 1);
  const a = G.deckPlan([{ name: "Sol Ring", qty: 2 }], "BOX", new Set(["BINDER"])).lines[0];
  assert.deepEqual(pullsAt(a), ["SELL:1"]);
  assert.equal(a.shortfall, 1);
});

test("A: a copy already in the destination counts, so Build into it moves nothing more (#117)", () => {
  const G = world();
  put(G, "BOX", 1);
  put(G, "BINDER", 1);
  const list = [{ name: "Sol Ring", qty: 1 }];
  const into = G.deckPlan(list, "BOX");
  assert.equal(into.lines[0].inDest, 1);
  assert.equal(into.lines[0].pulls.length, 0, "the binder's copy stays put; the box doesn't end up with 2");
  assert.equal(into.lines[0].shortfall, 0);
  assert.equal(into.moving, 0);
  // A different destination recomputes: both copies are sources there.
  const elsewhere = G.deckPlan([{ name: "Sol Ring", qty: 2 }], "SELL");
  assert.equal(elsewhere.lines[0].inDest, 0);
  assert.equal(elsewhere.moving, 2);
});

test("A: only the copies still missing from the destination move (#117)", () => {
  const G = world();
  put(G, "BOX", 1);
  put(G, "BINDER", 3);
  const a = G.deckPlan([{ name: "sol ring", qty: 3 }], "BOX").lines[0];
  assert.equal(a.inDest, 1);
  assert.deepEqual(pullsAt(a), ["BINDER:2"]);
});

test("no destination yet (a new deck location) plans every stack as a source", () => {
  const G = world();
  put(G, "BOX", 1);
  put(G, "BINDER", 1);
  const a = G.deckPlan([{ name: "Sol Ring", qty: 2 }], null).lines[0];
  assert.equal(a.inDest, 0);
  assert.equal(a.pulls.reduce((s, p) => s + p.take, 0), 2);
});

test("B: a fetched Manapool order with no pick list yet reserves its copies too (#107)", () => {
  const G = world();
  put(G, "SELL", 2);
  G.setManapoolOrders([{ id: "order-1", status: "processing", placedAt: "2026-10-20T00:00:00Z",
    lines: [{ kind: "card", set: "c21", collector: "263", lang: "en", finish: "nonfoil", condition: "NM", name: "Sol Ring", qty: 1 }] }]);
  const a = G.deckPlan([{ name: "Sol Ring", qty: 2 }], "BOX").lines[0];
  assert.deepEqual(pullsAt(a), ["SELL:1"]);
  assert.equal(a.reserved, 1);
  assert.equal(a.shortfall, 1);
});

test("B: copies reserved for an open Manapool order are never moved; the line shows short (#117)", () => {
  const G = world();
  put(G, "SELL", 2);
  const pl = G.newPickList({ source: "manapool", orderId: "order-1" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, { kind: "card", set: "c21", collector: "263", lang: "en", finish: "nonfoil",
    condition: "NM", name: "Sol Ring", qty: 1 });
  const a = G.deckPlan([{ name: "Sol Ring", qty: 2 }], "BOX").lines[0];
  assert.deepEqual(pullsAt(a), ["SELL:1"], "one copy is sold on Manapool and stays for the pick");
  assert.equal(a.shortfall, 1);
  assert.equal(a.reserved, 1);
  // Reserved copies sitting in the destination don't count toward the deck
  // either: the order's pick takes them out again.
  const inSell = G.deckPlan([{ name: "Sol Ring", qty: 2 }], "SELL").lines[0];
  assert.equal(inSell.inDest, 1);
  assert.equal(inSell.shortfall, 1);
});

test("B: a manual pick list reserves nothing, so it doesn't block a deck build", () => {
  const G = world();
  put(G, "SELL", 2);
  const pl = G.newPickList({ source: "manual" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, { kind: "card", set: "c21", collector: "263", lang: "en", finish: "nonfoil",
    condition: "NM", name: "Sol Ring", qty: 1 });
  assert.equal(G.deckPlan([{ name: "Sol Ring", qty: 2 }], "BOX").lines[0].shortfall, 0);
});

test("C: non-sell-from copies go before sell-from stock, even when the sell-from stack is bigger (#117)", () => {
  const G = world();
  put(G, "SELL", 5);
  put(G, "BINDER", 1);
  const a = G.deckPlan([{ name: "Sol Ring", qty: 1 }], "BOX").lines[0];
  assert.deepEqual(pullsAt(a), ["BINDER:1"]);
  const b = G.deckPlan([{ name: "Sol Ring", qty: 3 }], "BOX").lines[0];
  assert.deepEqual(pullsAt(b), ["BINDER:1", "SELL:2"]);
});

test("C: unlisted copies go first, listed copies last, and the plan counts the listed ones that move (#117)", () => {
  const G = world();
  put(G, "SELL", 3, { listed: 2 });          // 1 unlisted, 2 listed
  put(G, "SELL", 2, { condition: "LP" });    // 2 unlisted, a second stack
  put(G, "BINDER", 1);
  let plan = G.deckPlan([{ name: "Sol Ring", qty: 4 }], "BOX");
  assert.equal(plan.listedMoving, 0, "4 unlisted copies exist: none of the listed ones move");
  assert.equal(plan.lines[0].shortfall, 0);
  plan = G.deckPlan([{ name: "Sol Ring", qty: 5 }], "BOX");
  assert.equal(plan.listedMoving, 1);
  const listedPull = plan.lines[0].pulls.find(p => p.listedTake > 0);
  assert.equal(listedPull.record.listedQty, 2, "the listed copy comes off the listed stack");
  assert.equal(listedPull.take, 2, "one pull per stack: its unlisted copy plus one listed copy");
  assert.equal(listedPull.listedTake, 1);
});

test("C: listed copies in a non-sell-from location go before listed sell-from copies", () => {
  const G = world();
  put(G, "SELL", 4, { listed: 4 });
  put(G, "BINDER", 1, { listed: 1 });
  const a = G.deckPlan([{ name: "Sol Ring", qty: 1 }], "BOX").lines[0];
  assert.deepEqual(pullsAt(a), ["BINDER:1"]);
  assert.equal(a.listedTake, 1);
});

test("D: a full destination doesn't stop or shrink a deck build (#117)", () => {
  const G = world();
  G.locById("BOX").maxCards = 0;
  put(G, "BINDER", 2);
  const a = G.deckPlan([{ name: "Sol Ring", qty: 2 }], "BOX").lines[0];
  assert.equal(a.shortfall, 0);
  assert.deepEqual(pullsAt(a), ["BINDER:2"]);
});

test("two lines for the same card share the stock instead of both claiming the same copies", () => {
  const G = world();
  put(G, "BINDER", 3);
  const plan = G.deckPlan([{ name: "Sol Ring", qty: 2 }, { name: "Sol Ring", qty: 2 }], "BOX");
  assert.equal(plan.lines[0].shortfall, 0);
  assert.equal(plan.lines[1].shortfall, 1);
  assert.equal(plan.moving, 3);
});

test("the fingerprint changes when the collection changes under a plan (Build re-checks after the confirm)", () => {
  const G = world();
  const r = put(G, "BINDER", 2);
  const list = [{ name: "Sol Ring", qty: 2 }];
  const before = G.deckPlan(list, "BOX").fingerprint;
  assert.equal(G.deckPlan(list, "BOX").fingerprint, before, "same data, same fingerprint");
  r.quantity = 1;
  assert.notEqual(G.deckPlan(list, "BOX").fingerprint, before);
});

test("the fingerprint also catches what the confirm text depends on: a stack moved into the destination, a listing change", () => {
  const G = world();
  const r = put(G, "BINDER", 2);
  const list = [{ name: "Sol Ring", qty: 2 }];
  const before = G.deckPlan(list, "BOX").fingerprint;
  r.locationId = "BOX";   // same record, same count, but now "already there" instead of "will move"
  assert.notEqual(G.deckPlan(list, "BOX").fingerprint, before);
  r.locationId = "BINDER";
  assert.equal(G.deckPlan(list, "BOX").fingerprint, before);
  r.listedQty = 2;        // the same copies move, but now the confirm should warn they're listed
  assert.notEqual(G.deckPlan(list, "BOX").fingerprint, before);
});

test("#118: a 100-line list over 70,000 stacks plans in one pass, not a collection scan per line", () => {
  const G = world();
  for (let i = 0; i < 70000; i++) {
    G.state.cards.push({ id: "s" + i, name: "Card " + (i % 5000), set: "tst", collector: String(i), lang: "en",
      finish: "nonfoil", condition: "NM", quantity: 1 + (i % 3), listedQty: i % 2, locationId: i % 2 ? "SELL" : "BINDER", price: 1 });
  }
  const list = Array.from({ length: 100 }, (_, i) => ({ name: "Card " + (i * 7), qty: 1 }));
  // Count how often the plan walks the whole collection: once for its name
  // index. The old per-line allocateDeck filtered state.cards per line.
  let walks = 0;
  const cards = G.state.cards;
  const orig = cards[Symbol.iterator];
  cards[Symbol.iterator] = function () { walks++; return orig.call(this); };
  const origFilter = cards.filter;
  cards.filter = function () { walks++; return origFilter.apply(this, arguments); };
  const t0 = process.hrtime.bigint();
  const plan = G.deckPlan(list, "BOX");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(walks, 1, "one pass over the stacks for the whole list");
  assert.equal(plan.lines.length, 100);
  assert.ok(plan.lines.every(l => l.shortfall === 0));
  assert.ok(ms < 1000, "planned in " + ms.toFixed(0) + " ms");
});
