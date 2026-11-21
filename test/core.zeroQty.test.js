"use strict";
/* #73: a card stack saved at quantity 0 used to load back as 1 copy
   (normalizeCard's `Number(q) || 1`). A stored number, 0 included, now loads
   as itself and a 0 row is dropped; only a missing or non-numeric quantity
   still defaults to 1. Plus #69's shared over-capacity check for moves. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");
const { merge } = require("../server/lib/merge");

// core.js runs in its own VM realm, so its arrays and objects fail
// deepStrictEqual on their prototype alone: compare plain copies.
const same = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

const LOC = { id: "L1", name: "Binder", type: "Binder" };
const card = (over) => Object.assign({
  id: "c1", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM",
  name: "Lightning Bolt", locationId: "L1", price: 1
}, over);
const adopt = (G, cards, extra) => {
  G.adoptState(Object.assign({ locations: [LOC], cards }, extra || {}));
  return G.state.cards;
};

test("#73 a stored quantity 0 loads as nothing, not as 1 copy", () => {
  const G = freshCore();
  same(adopt(G, [card({ quantity: 0 })]), []);
});

test("#73 a missing, null, empty or non-numeric quantity still loads as 1", () => {
  for (const q of [undefined, null, "", "abc", NaN]) {
    const G = freshCore();
    const c = card({});
    if (q !== undefined) c.quantity = q;
    const rows = adopt(G, [c]);
    assert.equal(rows.length, 1, "quantity " + String(q));
    assert.equal(rows[0].quantity, 1, "quantity " + String(q));
  }
});

test("#73 real quantities load unchanged, and a numeric string is read as its number", () => {
  const G = freshCore();
  const rows = adopt(G, [card({ id: "a", quantity: 3 }), card({ id: "b", collector: "142", quantity: "0" }),
    card({ id: "c", collector: "143", quantity: "4" }), card({ id: "d", collector: "144", quantity: -2 })]);
  same(rows.map(r => [r.id, r.quantity]), [["a", 3], ["c", 4]]);
});

test("#73 a 0 row loads as 0 even when its cost basis says otherwise, and is dropped", () => {
  const G = freshCore();
  const rows = adopt(G, [card({ quantity: 0, costQty: 2, costTotal: 4 }), card({ id: "c2", collector: "9", quantity: 2, costQty: 5, costTotal: 10 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].costQty, 2, "costQty is still capped at quantity");
});

test("#73 sealed rows at 0 still load and are kept (unchanged behaviour)", () => {
  const G = freshCore();
  adopt(G, [], { sealed: [{ id: "s1", tcgplayerProductId: "1", name: "Box", locationId: "L1", quantity: 0 }] });
  assert.equal(G.state.sealed.length, 1);
  assert.equal(G.state.sealed[0].quantity, 0);
});

test("#73 a three-way merge that lands a stack on 0 doesn't come back as 1 copy", () => {
  // Two browsers each sold one copy of a 2-copy stack: quantity is a delta
  // field in merge.js, so the merged document holds the stack at 0.
  const base = { locations: [LOC], cards: [card({ quantity: 2 })] };
  const mine = { locations: [LOC], cards: [card({ quantity: 1 })] };
  const theirs = { locations: [LOC], cards: [card({ quantity: 1 })] };
  const { merged } = merge(base, mine, theirs);
  assert.equal(merged.cards[0].quantity, 0);
  const G = freshCore();
  G.adoptState(merged);
  same(G.state.cards, []);
});

test("#73 chase pick 'found 0' removes the card stack instead of keeping it at 0", () => {
  const G = freshCore();
  adopt(G, [card({ quantity: 2, listedQty: 1 }), card({ id: "c2", collector: "9", quantity: 1 })]);
  G.chasePickAdjust("c1", 0, "test", "card");
  same(G.state.cards.map(r => r.id), ["c2"]);
  // and it stays gone across a save/reload round trip
  G.adoptState(JSON.parse(JSON.stringify(G.state)));
  same(G.state.cards.map(r => r.id), ["c2"]);
});

test("#73 chase pick that finds some copies keeps the stack at the found count", () => {
  const G = freshCore();
  adopt(G, [card({ quantity: 3 })]);
  G.chasePickAdjust("c1", 1, "test", "card");
  assert.equal(G.state.cards.length, 1);
  assert.equal(G.state.cards[0].quantity, 1);
});

test("#73 chase pick 'found 0' on a sealed row keeps the row at 0, as Sealed's own edit does", () => {
  const G = freshCore();
  adopt(G, [], { sealed: [{ id: "s1", tcgplayerProductId: "1", name: "Box", locationId: "L1", quantity: 2 }] });
  G.chasePickAdjust("s1", 0, "test", "sealed");
  assert.equal(G.state.sealed.length, 1);
  assert.equal(G.state.sealed[0].quantity, 0);
});

test("#73 transfer file: a 0 line is dropped, a missing or unreadable qty still means 1", () => {
  const G = freshCore();
  const line = (collector, qty) => {
    const l = { set: "a25", collector, name: "x" };
    if (qty !== undefined) l.qty = qty;
    return l;
  };
  const out = G.parseTransfer(JSON.stringify({ kind: "transfer", transferVersion: 1,
    lines: [line("1", 0), line("2"), line("3", "abc"), line("4", 3), line("5", -1), line("6", "2")] }));
  same(out.lines.map(l => [l.collector, l.qty]), [["2", 1], ["3", 1], ["4", 3], ["6", 2]]);
  assert.equal(out.totalCards, 7);
});

/* ---------- #69: shared over-capacity check for moves ---------- */
function capCore(maxCards) {
  const G = freshCore();
  G.adoptState({
    locations: [{ id: "src", name: "Src", type: "Box" }, { id: "dst", name: "Dst", type: "Binder", maxCards }],
    cards: [card({ id: "d1", locationId: "dst", quantity: 8 }),
      card({ id: "s1", collector: "1", locationId: "src", quantity: 2 }),
      card({ id: "s2", collector: "2", locationId: "src", quantity: 3 })]
  });
  return G;
}
const byId = (G, ids) => G.state.cards.filter(r => ids.includes(r.id));

test("#69 moveOverCapacity: within the ceiling is not over", () => {
  const G = capCore(10);
  const fit = G.moveOverCapacity("dst", byId(G, ["s1"]));
  same(fit, { moving: 2, cap: 10, free: 2, over: false });
});

test("#69 moveOverCapacity: past the ceiling reports the numbers", () => {
  const G = capCore(10);
  const fit = G.moveOverCapacity("dst", byId(G, ["s1", "s2"]));
  same(fit, { moving: 5, cap: 10, free: 2, over: true });
});

test("#69 moveOverCapacity: stacks already in the destination don't count", () => {
  const G = capCore(10);
  const fit = G.moveOverCapacity("dst", byId(G, ["d1", "s1"]));
  assert.equal(fit.moving, 2);
  assert.equal(fit.over, false);
});

test("#69 moveOverCapacity: no ceiling is never over", () => {
  const G = capCore(null);
  const fit = G.moveOverCapacity("dst", byId(G, ["s1", "s2"]));
  assert.equal(fit.cap, null);
  assert.equal(fit.over, false);
});
