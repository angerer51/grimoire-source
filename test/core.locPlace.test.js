"use strict";
/* Where a card goes inside a location that has a sorting method (#293):
   G.locationLayouts() / buildLayout(), the neighbour and section/position
   maths behind Putaway's placement line and "Show where it goes" picture.
   Positions count physical copies; 1 = front of a box / first pocket of
   page 1. #295 reuses locate() for "where it is". */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const deq = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const SET_COLL = [{ field: "set", dir: "asc" }, { field: "collector", dir: "asc" }];
let nextId = 0;
const card = (set, collector, qty, name) =>
  ({ id: "r" + (++nextId), set, collector: String(collector), quantity: qty == null ? 1 : qty, name: name || set + " " + collector });
const box = (G, extra) => G.newLocation(Object.assign({ id: "box", name: "Box", type: "Box", sortMethod: SET_COLL }, extra));
const layoutOf = (G, rows, extra) => G.buildLayout(box(G, extra), rows);

test("empty location: the first card goes at #1 and starts a new section", () => {
  const G = freshCore();
  const p = layoutOf(G, []).place(card("ELD", 5, 3), 3);
  assert.equal(p.from, 1);
  assert.equal(p.to, 3);
  assert.equal(p.total, 3);
  assert.equal(p.prev, null);
  assert.equal(p.next, null);
  assert.equal(p.section.isNew, true);
  assert.equal(G.placementNeighbourText(p), "first card in here");
  assert.equal(G.placementSectionText(p), "new ELD section at #1–3");
  deq(p.sections(), [{ label: "ELD", from: 1, to: 3, cards: 3 }]);
});

test("before the first, after the last, and between two", () => {
  const G = freshCore();
  const lay = () => layoutOf(G, [card("ELD", 10, 2, "Bolt"), card("ELD", 30, 1, "Shock")]);
  const first = lay().place(card("AER", 1));
  assert.equal(first.from, 1);
  assert.equal(G.placementNeighbourText(first), "at the start, before Bolt · ELD #10");
  assert.equal(first.section.isNew, true);

  const last = lay().place(card("ZNR", 1));
  assert.equal(last.from, 4);
  assert.equal(G.placementNeighbourText(last), "at the end, after Shock · ELD #30");

  const mid = lay().place(card("ELD", 20, 1, "Opt"));
  assert.equal(mid.from, 3, "after both copies of ELD #10");
  assert.equal(G.placementNeighbourText(mid), "after Bolt · ELD #10");
  deq(mid.next, { name: "Shock", set: "ELD", collector: "30" });
  deq(mid.section, { label: "ELD", from: 1, to: 4, isNew: false }, "the section counts these copies too");
  assert.equal(G.placementSectionText(mid), "ELD section: cards 1–4, this one about #3");
});

test("a tie with an identical card already there goes right after it", () => {
  const G = freshCore();
  const rows = [card("ELD", 10, 2, "Bolt"), card("ELD", 10, 1, "Bolt"), card("ELD", 30, 1, "Shock")];
  const p = layoutOf(G, rows).place(card("ELD", 10, 1, "Bolt"));
  assert.equal(p.from, 4, "after all three Bolts");
  deq(p.prev, { name: "Bolt", set: "ELD", collector: "10" });
  deq(p.next, { name: "Shock", set: "ELD", collector: "30" });
});

test("several plan lines into one location count the earlier ones", () => {
  const G = freshCore();
  const lay = layoutOf(G, [card("ELD", 10), card("ELD", 30)]);
  const a = lay.place(card("ELD", 20, 2, "A"), 2);
  const b = lay.place(card("ELD", 20, 1, "B"));       // ties with A: goes after it
  const c = lay.place(card("ELD", 15, 1, "C"));       // before A
  const d = lay.place(card("AER", 1, 1, "D"));
  assert.equal(a.from, 2); assert.equal(a.to, 3);
  assert.equal(b.from, 4);
  assert.equal(G.placementNeighbourText(b), "after A · ELD #20", "the neighbour can be an earlier plan line");
  assert.equal(c.from, 2);
  assert.equal(d.from, 1);
  assert.equal(d.total, 7);
  deq(b.sections(), [{ label: "ELD", from: 1, to: 5, cards: 5 }], "as line B saw it, C and D not yet in");
  deq(d.sections(), [{ label: "AER", from: 1, to: 1, cards: 1 }, { label: "ELD", from: 2, to: 7, cards: 6 }]);
});

test("the owner's example: 233 cards before ELD, 50 ELD already there", () => {
  const G = freshCore();
  const rows = [card("AER", 1, 100), card("AFR", 1, 50), card("BLB", 1, 40), card("CLB", 1, 23), card("DMR", 1, 20)];
  for (let i = 1; i <= 50; i++) rows.push(card("ELD", i * 2));
  rows.push(card("KHM", 1, 30));
  const p = layoutOf(G, rows, { maxCards: 1000 }).place(card("ELD", 35));
  deq(p.section, { label: "ELD", from: 234, to: 284, isNew: false });
  assert.equal(p.from, 233 + 17 + 1, "after ELD #2..#34 (17 cards)");
  assert.equal(p.cap, 1000, "the card limit rides along for the picture");
  assert.equal(p.total, 314);
  assert.equal(G.placementSectionText(p), "ELD section: cards 234–284, this one about #251");
  assert.equal(layoutOf(G, rows).place(card("ELD", 35)).cap, null, "no limit set");
});

test("binder page maths: page size per binder, default 9; each side of a sheet is a page", () => {
  const G = freshCore();
  deq(G.binderSpot(1, 9), { page: 1, pocket: 1 });
  deq(G.binderSpot(9, 9), { page: 1, pocket: 9 });
  deq(G.binderSpot(10, 9), { page: 2, pocket: 1 });
  deq(G.binderSpot(251, 9), { page: 28, pocket: 8 });
  deq(G.binderSpot(13, 12), { page: 2, pocket: 1 });
  assert.equal(G.binderPageSize(G.newLocation({ type: "Binder" })), 9);
  assert.equal(G.binderPageSize(G.newLocation({ type: "Trade Binder", cardsPerPage: 12 })), 12);
  assert.equal(G.binderPageSize(G.newLocation({ type: "Box", cardsPerPage: 12 })), null, "not a binder");

  const rows = [card("AER", 1, 233)];
  for (let i = 1; i <= 50; i++) rows.push(card("ELD", i * 2));
  const p = G.buildLayout(G.newLocation({ id: "b", type: "Binder", sortMethod: SET_COLL }), rows).place(card("ELD", 35));
  assert.equal(p.perPage, 9);
  assert.equal(G.placementSectionText(p), "ELD section: pages 26–32, this one about page 28, pocket 8");
  const q = G.buildLayout(G.newLocation({ id: "b", type: "Binder", sortMethod: SET_COLL }), []).place(card("ELD", 1, 3), 3);
  assert.equal(G.placementSectionText(q), "new ELD section, page 1, pocket 1–3");
});

test("cardsPerPage is kept on save/load, dropped when invalid; older locations have none", () => {
  const G = freshCore();
  const l = G.newLocation({ id: "b1", name: "Binder", type: "Binder", cardsPerPage: 12 });
  assert.equal(G.newLocation(JSON.parse(JSON.stringify(l))).cardsPerPage, 12);
  assert.equal(G.newLocation({ cardsPerPage: "4" }).cardsPerPage, 4);
  assert.equal(G.newLocation({ cardsPerPage: 0 }).cardsPerPage, null);
  assert.equal(G.newLocation({ cardsPerPage: "x" }).cardsPerPage, null);
  assert.equal(G.newLocation({ id: "old" }).cardsPerPage, null);
  G.adoptState({ cards: [], locations: [JSON.parse(JSON.stringify(l)), { id: "b2", name: "Old", type: "Binder" }] });
  deq(G.state.locations.map(x => x.cardsPerPage), [12, null]);
  assert.equal(G.binderPageSize(G.state.locations[1]), 9);
});

test("section labels read as words: colors, rarity, mana value", () => {
  const G = freshCore();
  const lay = sm => G.buildLayout(G.newLocation({ id: "x", sortMethod: [{ field: sm, dir: "asc" }] }), []);
  assert.equal(lay("color").place({ id: "a", colors: ["R"], quantity: 1 }).section.label, "Red");
  assert.equal(lay("color").place({ id: "a", colors: ["U", "W"], quantity: 1 }).section.label, "WU");
  assert.equal(lay("color").place({ id: "a", colors: [], quantity: 1 }).section.label, "Colorless");
  assert.equal(lay("rarity").place({ id: "a", rarity: "mythic", quantity: 1 }).section.label, "Mythic");
  assert.equal(lay("cmc").place({ id: "a", cmc: 3, quantity: 1 }).section.label, "MV 3");
  assert.equal(lay("set").place({ id: "a", quantity: 1 }).section.label, "No set code");
});

test("locate: where a stack already in the location sits, in the same order Inventory lists it", () => {
  const G = freshCore();
  const rows = [card("ELD", 30, 1, "Shock"), card("AER", 1, 4, "Opt"), card("ELD", 10, 2, "Bolt")];
  const lay = layoutOf(G, rows);
  const p = lay.locate(rows[2]);
  assert.equal(p.mode, "here");
  assert.equal(p.from, 5); assert.equal(p.to, 6);
  deq(p.section, { label: "ELD", from: 5, to: 7, isNew: false });
  assert.equal(G.placementNeighbourText(p), "after Opt · AER #1");
  assert.equal(lay.locate({ id: "nope" }), null);
  deq(G.sortInLocationOrder(rows, SET_COLL).map(r => r.name), ["Opt", "Bolt", "Shock"]);
});

test("locate (#295): first, last, middle, a stack of four, and the same printing in two stacks", () => {
  const G = freshCore();
  const aer = card("AER", 1, 3, "Opt"), eldA = card("ELD", 5, 2, "Bolt"), eldB = card("ELD", 9, 4, "Shock");
  const eldB2 = card("ELD", 9, 1, "Shock"); // same printing, another stack in this location
  const zen = card("ZEN", 2, 1, "Zed");
  const lay = layoutOf(G, [zen, eldB2, eldB, aer, eldA]);
  const at = r => { const p = lay.locate(r); return [p.from, p.to, p.total]; };
  deq(at(aer), [1, 3, 11], "first");
  deq(at(eldA), [4, 5, 11], "middle, after the 3 AER");
  deq(at(eldB), [7, 10, 11], "a stack of 4 occupies 7-10");
  deq(at(eldB2), [6, 6, 11], "same printing in another stack counts, in collection order");
  deq(at(zen), [11, 11, 11], "last");
  deq(lay.locate(eldB).section, { label: "ELD", from: 4, to: 10, isNew: false });
});

test("binPlan: a pick into a sorted location says where; an unsorted one doesn't", () => {
  const G = freshCore();
  const CATCH_ALL = { combinator: "ALL", not: false, conditions: [], groups: [] };
  G.state.locations.push(G.newLocation({ id: "tray", name: "Tray", staging: true }));
  G.state.locations.push(G.newLocation({ id: "binder", name: "Binder", type: "Binder", priority: 5, maxPerName: 1, sortMethod: SET_COLL,
    putaway: { enabled: true, rules: CATCH_ALL } }));
  G.state.locations.push(G.newLocation({ id: "bulk", name: "Bulk", priority: 1, putaway: { enabled: true, rules: CATCH_ALL } }));
  const mk = (id, loc, set, coll, qty, price) => ({ id, locationId: loc, name: id, set, collector: coll, quantity: qty, price, finish: "nonfoil", condition: "NM", lang: "en" });
  G.state.cards.push(mk("old", "binder", "ELD", "20", 1, 1));
  G.state.cards.push(mk("pricey", "tray", "ELD", "30", 2, 10));
  G.state.cards.push(mk("cheap", "tray", "ELD", "10", 1, 1));
  const plan = G.binPlan("tray");
  const pricey = plan.lines.find(l => l.record.id === "pricey");
  const toBinder = pricey.picks.find(p => p.locationId === "binder");
  const toBulk = pricey.picks.find(p => p.locationId === "bulk");
  assert.equal(toBinder.take, 1);
  assert.equal(toBinder.spot.from, 2, "after the ELD #20 already there");
  assert.equal(toBulk.spot, undefined, "Bulk has no sorting method");
  const cheap = plan.lines.find(l => l.record.id === "cheap").picks[0];
  assert.equal(cheap.spot.from, 1, "planned after pricey, before both");
  assert.equal(cheap.spot.total, 3, "counts the copy pricey's line sends there");
});

test("locationLayouts: stacks a plan moves out aren't counted (or named) where they sit now", () => {
  const G = freshCore();
  G.state.locations.push(box(G));
  const mk = (id, coll) => ({ id, locationId: "box", name: id, set: "ELD", collector: String(coll), quantity: 1 });
  G.state.cards.push(mk("a", 10), mk("b", 20), mk("c", 30));
  const incoming = { id: "new", name: "New", set: "ELD", collector: "25", quantity: 1 };
  const all = G.locationLayouts().get("box").place(incoming);
  assert.equal(G.placementNeighbourText(all), "after b · ELD #20");
  const p = G.locationLayouts({ leaving: new Set(["b"]) }).get("box").place(incoming);
  assert.equal(G.placementNeighbourText(p), "after a · ELD #10");
  assert.equal(p.from, 2);
  assert.equal(G.locationLayouts().get("nope"), null);
});

test("scale: a 70k-stack location sorts once and places 2,000 lines quickly", () => {
  const G = freshCore();
  const sets = ["AER", "AFR", "BLB", "CLB", "DMR", "ELD", "KHM", "MOM", "NEO", "ONE", "SNC", "WOE"];
  const rows = [];
  for (let i = 0; i < 70000; i++) rows.push(card(sets[i % sets.length], (i * 7) % 400, 1 + (i % 3)));
  const t = Date.now();
  const lay = layoutOf(G, rows);
  let last;
  for (let i = 0; i < 2000; i++) last = lay.place(card(sets[(i * 5) % sets.length], i % 400, 1));
  const secs = last.sections();
  const ms = Date.now() - t;
  assert.equal(secs.length, sets.length);
  assert.equal(secs[secs.length - 1].to, last.total);
  assert.ok(ms < 4000, "took " + ms + " ms");
});

test("many lines into one location match a plain recount (past the run size)", () => {
  const G = freshCore();
  const sets = ["AER", "ELD", "KHM", "ZNR"];
  const baseRows = [card("ELD", 50, 3), card("KHM", 7, 2)];
  const lay = layoutOf(G, baseRows);
  const cmp = G.locSortComparator(SET_COLL);
  const all = G.sortInLocationOrder(baseRows, SET_COLL).map(r => ({ r, q: r.quantity }));
  let seed = 7;
  const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 0; i < 1500; i++) {
    const r = card(sets[rnd(4)], rnd(60), 1 + rnd(3));
    const p = lay.place(r, r.quantity);
    let at = all.length;
    for (let j = 0; j < all.length; j++) if (cmp(all[j].r, r) > 0) { at = j; break; }
    const before = all.slice(0, at).reduce((t, x) => t + x.q, 0);
    assert.equal(p.from, before + 1, "line " + i);
    assert.equal(p.prev ? p.prev.name : null, at > 0 ? all[at - 1].r.name : null, "prev, line " + i);
    assert.equal(p.next ? p.next.name : null, at < all.length ? all[at].r.name : null, "next, line " + i);
    all.splice(at, 0, { r, q: r.quantity });
    const sec = all.filter(x => x.r.set === r.set);
    const secFrom = all.slice(0, all.indexOf(sec[0])).reduce((t, x) => t + x.q, 0) + 1;
    assert.equal(p.section.from, secFrom, "section start, line " + i);
    assert.equal(p.section.to, secFrom - 1 + sec.reduce((t, x) => t + x.q, 0), "section end, line " + i);
  }
});

test("scale: 70k lines into one empty sorted box (Fill a bin, no ceiling)", () => {
  // Checks how placement time GROWS, not a wall-clock budget (#312): 70k
  // placements cost ~9x what 10k do when chunks split; chunks that never
  // split give ~28x. An 18x line separates them on any machine or load.
  // Best of 3 tries absorbs a load spike.
  const G = freshCore();
  const fill = n => {
    const lay = layoutOf(G, []);
    const t = process.hrtime.bigint();
    let last;
    for (let i = 0; i < n; i++) last = lay.place(card("S" + (i % 300), (i * 13) % 500, 1));
    return { ms: Number(process.hrtime.bigint() - t) / 1e6, last };
  };
  fill(3000); // warm-up, so JIT start-up is not in the 10k timing
  let best = Infinity, big;
  for (let attempt = 0; attempt < 3 && best >= 18; attempt++) {
    const small = fill(10000);
    big = fill(70000);
    best = Math.min(best, big.ms / Math.max(small.ms, 1));
  }
  assert.equal(big.last.total, 70000);
  assert.ok(best < 18, "70k took " + best.toFixed(1) + "x the time of 10k (healthy ~9x, no chunk splitting ~28x)");
});
