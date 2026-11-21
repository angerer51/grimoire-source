"use strict";
/* #227: Listings → Evaluate shows one row per Manapool listing (same
   printing, language, finish, condition), never one per location, and
   Grimoire decides which locations' copies are the listed ones by pick
   priority (owner, 2026-10-14).

   - listingPlanRows merges a whole plan by listing; totals include stacks
     whose own number isn't changing, so a row adds up.
   - listingPlan spreads a listing's listed copies over its "Sell from"
     stacks, highest pick priority first. How many are listed still follows
     #90 (cheapest printing kept), #194 (not-sold-from kept first, never
     listed) and #86 (sold copies not listable).
   - A push of a row's lines sends one entry priced from the row's record. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const INFO = {
  name: "Prophetic Prism", collector: "335", setName: "Battle for Baldur's Gate", rarity: "common",
  tcgplayerId: "1", scryfallId: "prism-clb", price: 0.2, priceNote: "", note: "", meta: {}
};
const OTHER = Object.assign({}, INFO, { collector: "336", scryfallId: "prism-other" });
const KEY = "prism-clb|en|nonfoil|NM";
const LINE = { kind: "card", set: "clb", collector: "335", lang: "en", finish: "nonfoil", condition: "NM", name: "Prophetic Prism" };

function store() {
  const G = freshCore();
  const loc = (id, name, pickPriority, sellFrom) =>
    G.state.locations.push(G.newLocation({ id, name, type: "box", sellFrom: sellFrom !== false, pickPriority }));
  loc("lo", "Low box", 1);
  loc("mid", "Mid box", 5);
  loc("hi", "High box", 9);
  loc("binder", "Pink Binder", 20, false);
  return G;
}
function receive(G, qty, locationId, price, other) {
  const r = G.addCopies({ set: "clb", num: other ? "336" : "335", lang: "en", finish: "nonfoil", condition: "NM",
    locationId, qty, info: other ? OTHER : INFO, action: "receipt", receiptId: "T1", note: "" });
  if (price !== undefined) r.price = price;
  return r;
}
// Core runs in its own realm: copy its arrays before deepEqual.
const plain = x => JSON.parse(JSON.stringify(x));
const keep = (G, n) => { G.state.settings.listingDefaultKeep = n; };
const targetOf = (plan, rec) => plan.find(p => p.record.id === rec.id).target;
const rowsOf = (G, opts) => G.listingPlanRows(G.listingPlan({ includeUnchanged: true }), opts);

/* ---------------- one row per listing ---------------- */

test("three stacks of one listing make one row whose totals include the unchanged stack (#227)", () => {
  const G = store();
  keep(G, 0);
  const a = receive(G, 2, "lo");
  const b = receive(G, 5, "mid");
  const c = receive(G, 1, "hi");
  a.listedQty = 2;                       // already right: its own line doesn't change
  const rows = rowsOf(G);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.key, KEY);
  assert.equal(row.lines.length, 3, "every stack of the listing, changing or not");
  assert.equal(row.have, 8);
  assert.equal(row.listedNow, 2);
  assert.equal(row.target, 8);
  assert.equal(row.delta, 6);
  assert.ok(row.changed);
  assert.deepEqual(plain(row.lines.map(l => l.record.id)), [c.id, b.id, a.id], "pick order, highest first");
  assert.equal(row.record.id, c.id);
});

test("a listing where nothing changes is hidden unless unchanged rows are asked for (#227)", () => {
  const G = store();
  keep(G, 0);
  const a = receive(G, 1, "lo");
  const b = receive(G, 1, "hi");
  a.listedQty = 1; b.listedQty = 1;
  assert.equal(rowsOf(G).length, 0);
  assert.equal(rowsOf(G, { includeUnchanged: true }).length, 1);
});

test("a listing whose stacks swap copies with no change in total still shows, so Apply can move them (#227)", () => {
  const G = store();
  keep(G, 1);
  const lo = receive(G, 1, "lo");
  const hi = receive(G, 1, "hi");
  lo.listedQty = 1;                      // listed from the low box today
  const [row] = rowsOf(G);
  assert.equal(row.delta, 0);
  assert.ok(row.changed);
  assert.equal(targetOf(row.lines, hi), 1, "the high-priority box is the listed one");
  assert.equal(targetOf(row.lines, lo), 0);
});

test("different printings, languages or conditions are different rows (#227)", () => {
  const G = store();
  keep(G, 0);
  receive(G, 1, "lo");
  receive(G, 1, "lo", undefined, true);
  const ja = receive(G, 1, "mid");
  ja.lang = "ja";
  const lp = receive(G, 1, "mid");
  lp.condition = "LP";
  const keys = plain(rowsOf(G).map(r => r.key)).sort();
  assert.deepEqual(keys, ["prism-clb|en|nonfoil|LP", "prism-clb|en|nonfoil|NM", "prism-clb|ja|nonfoil|NM", "prism-other|en|nonfoil|NM"]);
});

test("stacks with no Scryfall id are never merged with each other (#227)", () => {
  const G = store();
  keep(G, 0);
  const a = receive(G, 1, "lo");
  const b = receive(G, 1, "hi", undefined, true);
  a.scryfallId = ""; b.scryfallId = "";
  assert.equal(rowsOf(G).length, 2);
});

/* ---------------- pick-priority allocation ---------------- */

test("listed copies come from the highest pick-priority Sell from stacks first (#227)", () => {
  const G = store();
  keep(G, 2);
  const lo = receive(G, 2, "lo", 0.5);   // dearest, but lowest priority
  const mid = receive(G, 2, "mid", 0.1);
  const hi = receive(G, 1, "hi", 0.1);
  const plan = G.listingPlan({ includeUnchanged: true });
  // 5 copies, keep 2: 3 listed - the high box's 1, then the mid box's 2.
  assert.equal(targetOf(plan, hi), 1);
  assert.equal(targetOf(plan, mid), 2);
  assert.equal(targetOf(plan, lo), 0);
});

test("pick-priority allocation never lists more than a stack has free (#86)", () => {
  const G = store();
  keep(G, 0);
  const hi = receive(G, 2, "hi");
  const lo = receive(G, 2, "lo");
  const pl = G.newPickList({ source: "manapool", orderId: "o-1" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, Object.assign({}, LINE, { qty: 1, unitPrice: 1 }));
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(targetOf(plan, hi) + targetOf(plan, lo), 3, "the sold copy is not listable");
  assert.ok(targetOf(plan, hi) <= 2 - (plan.find(p => p.record.id === hi.id).reserved));
  const [row] = G.listingPlanRows(plan);
  assert.equal(row.reserved, 1);
  assert.equal(row.target, 3);
});

test("a Sell from off stack in the listing is kept first and never listed, and the row counts it (#194)", () => {
  const G = store();
  keep(G, 1);
  const binder = receive(G, 1, "binder");   // highest pick priority, but not sold from
  const lo = receive(G, 1, "lo");
  const hi = receive(G, 1, "hi");
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(targetOf(plan, binder), 0);
  assert.equal(targetOf(plan, hi) + targetOf(plan, lo), 2, "the binder copy fills keep");
  const [row] = G.listingPlanRows(plan);
  assert.equal(row.offQty, 1);
  assert.deepEqual(plain(row.offLocations), ["Pink Binder"]);
  assert.equal(row.target, 2);
});

test("across different printings the cheapest is still kept, wherever it sits (#90)", () => {
  const G = store();
  keep(G, 1);
  const cheap = receive(G, 1, "hi", 0.1);
  const dear = receive(G, 1, "lo", 3, true);
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(targetOf(plan, cheap), 0);
  assert.equal(targetOf(plan, dear), 1);
});

/* ---------------- push ---------------- */

test("pushing a row's lines sends one entry with the row's total, priced from the row's record (#227)", () => {
  const G = store();
  keep(G, 0);
  receive(G, 2, "lo", 0.17);
  receive(G, 1, "hi", 0.21);
  const [row] = rowsOf(G);
  const groups = G.manapoolPushGroups(row.lines);
  assert.equal(groups.size, 1);
  const g = groups.get(KEY);
  assert.equal(g.targetSum, row.target);
  assert.equal(g.sample, row.record, "the Price column and the push use the same stack");
});

test("the row's record is a priced stack when the listing has one, so a push never sends no price (#227)", () => {
  const G = store();
  keep(G, 0);
  receive(G, 1, "hi", null);
  const priced = receive(G, 1, "lo", 0.3);
  const [row] = rowsOf(G);
  assert.equal(row.record.id, priced.id);
  assert.equal(G.manapoolListPrice(row.record), 0.3);
});

test("the row's record is never a Sell from off stack, so a push prices from a sell-from copy (#227 review)", () => {
  const G = store();
  keep(G, 0);
  receive(G, 1, "binder", 0.5);          // highest pick priority, but not sold from
  const box = receive(G, 2, "lo", 0.2);
  const [row] = rowsOf(G);
  assert.equal(row.record.id, box.id);
  assert.equal(G.manapoolListPrice(row.record), 0.2);
  assert.equal(G.manapoolPushGroups(row.lines).get(KEY).sample, row.record);
});

test("the pick-priority spread never moves listed copies from one rule's stacks to another's (#227 review)", () => {
  const G = store();
  const box = conds => ({ combinator: "ALL", not: false, groups: [],
    conditions: conds.map(([field, op, value]) => ({ on: true, field, op, value })) });
  // The high box keeps everything; the rest falls to a keep-0 default.
  G.state.listingRules = [G.normalizeListingRule({ name: "Keep the high box", priority: 5, keep: 5,
    criteria: box([["location", "is", "High box"]]) })];
  keep(G, 0);
  const hi = receive(G, 2, "hi");
  const lo = receive(G, 2, "lo");
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(plan.find(p => p.record.id === hi.id).rule.name, "Keep the high box");
  assert.equal(targetOf(plan, hi), 0, "its rule keeps both, even though it has the higher pick priority");
  assert.equal(targetOf(plan, lo), 2, "the default lists the low box's own copies");
  const [row] = G.listingPlanRows(plan);
  assert.equal(row.target, 2);
  assert.equal(row.rules.length, 2);
});
