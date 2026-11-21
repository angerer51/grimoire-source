"use strict";
/* #377: "Delist unprofitable" and the "Never list cards at a loss" switch.
   Unprofitable = price at or below the average cost per copy. No cost entered
   (or no price) is never touched. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {}
};
const KEY = "abc-123|en|nonfoil|NM";

// One stack, listed at `ask`, bought at `cost` per copy (null = no cost entered).
function setup(cost, ask, market) {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations[0].sellFrom = true;
  const r = G.addCopies({ set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: 2, info: INFO, unitCost: null, action: "receipt", receiptId: "T1", note: "" });
  r.price = market == null ? 0.5 : market;
  r.listedQty = 2; r.askPrice = ask;
  if (cost != null) G.setCostBasis(r, cost, 2);
  return { G, r };
}
const live = (price) => [{ kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM",
  quantity: 2, price, name: "Lightning Bolt" }];
const targetOf = (G, r) => G.listingPlan({ includeUnchanged: true }).find(l => l.record === r);

test("delistUnprofitablePlan: a listing priced under cost is taken down", () => {
  const { G } = setup(1, 0.5);
  const p = G.delistUnprofitablePlan(live(0.5));
  assert.equal(p.cards.length, 1);
  assert.equal(p.items[0].cost, 1);
  assert.equal(p.items[0].profit, -0.5);
  assert.equal(p.items[0].pct, -50);
  assert.equal(G.delistUnprofitablePlan().items.length, 1, "local count agrees (no live read)");
});

test("delistUnprofitablePlan: a profitable listing stays up", () => {
  const { G } = setup(0.25, 0.5);
  assert.equal(G.delistUnprofitablePlan(live(0.5)).cards.length, 0);
});

test("delistUnprofitablePlan: break-even counts as unprofitable", () => {
  const { G } = setup(0.5, 0.5);
  assert.equal(G.delistUnprofitablePlan(live(0.5)).cards.length, 1);
});

test("delistUnprofitablePlan: no cost entered is never touched", () => {
  const { G } = setup(null, 0.01);
  assert.equal(G.delistUnprofitablePlan(live(0.01)).cards.length, 0);
  assert.equal(G.delistUnprofitablePlan().items.length, 0);
});

test("delistUnprofitablePlan: sealed and unidentifiable listings are left alone", () => {
  const { G } = setup(1, 0.5);
  const p = G.delistUnprofitablePlan([{ kind: "sealed", quantity: 1, price: 0.01, name: "Box" },
    { kind: "card", quantity: 1, price: 0.01, name: "Mystery" }]);
  assert.equal(p.cards.length, 0);
});

test("applyDelistUnprofitable: only the confirmed-down listing goes to 0 locally", () => {
  const { G, r } = setup(1, 0.5);
  assert.equal(G.applyDelistUnprofitable(new Set(["nope"]), "t").changed, 0);
  assert.equal(r.listedQty, 2);
  assert.equal(G.applyDelistUnprofitable(new Set([KEY]), "t").changed, 1);
  assert.equal(r.listedQty, 0);
});

test("switch off: an unprofitable stack is listed as the rule says", () => {
  const { G, r } = setup(1, 0.5);
  r.listedQty = 0;
  assert.equal(targetOf(G, r).target, 2);
});

test("switch on: an unprofitable stack gets target 0 and the Below cost rule", () => {
  const { G, r } = setup(1, 0.5);
  G.state.settings.neverListAtLoss = true;
  const line = targetOf(G, r);
  assert.equal(line.target, 0);
  assert.equal(line.rule.name, "Below minimum profit");
});

test("switch on: profitable, break-even-above and no-cost stacks are unaffected", () => {
  for (const [cost, market, listed] of [[0.25, 0.5, 2], [null, 0.01, 2]]) {
    const { G, r } = setup(cost, 0.5, market);
    r.listedQty = 0;
    G.state.settings.neverListAtLoss = true;
    const line = targetOf(G, r);
    assert.equal(line.target, listed);
    assert.notEqual(line.rule && line.rule.name, "Below minimum profit");
  }
});

test("switch on: break-even is unprofitable", () => {
  const { G, r } = setup(0.5, 0.5, 0.5);
  G.state.settings.neverListAtLoss = true;
  assert.equal(targetOf(G, r).rule.name, "Below minimum profit");
});

test("switch on: overrides a rule keep and a name exception keep", () => {
  const { G, r } = setup(1, 0.5);
  r.listedQty = 0;
  G.state.listingRules = [G.normalizeListingRule({ name: "List all", keep: 0 })];
  assert.equal(targetOf(G, r).target, 2, "rule lists them while the switch is off");
  G.state.settings.neverListAtLoss = true;
  assert.equal(targetOf(G, r).target, 0, "rule keep overridden");
  G.state.listingKeepExceptions = [G.normalizeKeepException({ name: "Lightning Bolt", keep: 0 })];
  const line = targetOf(G, r);
  assert.equal(line.target, 0, "exception keep overridden");
  assert.equal(line.rule.name, "Below minimum profit");
});

/* ---------------- rework: keep pool and multi-stack listings ---------------- */

const OTHER = Object.assign({}, INFO, { collector: "142", scryfallId: "def-456" });

test("switch on: a below-cost printing still counts as the kept copy, so a profitable one keeps its listing", () => {
  const { G, r: cheap } = setup(0.25, 0.1, 0.1);      // $0.10, cost $0.25: a loss
  cheap.quantity = 1; cheap.listedQty = 0; cheap.costQty = 1; cheap.costTotal = 0.25; cheap.avgCost = 0.25;
  const dear = G.addCopies({ set: "a25", num: "142", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: 1, info: OTHER, unitCost: null, action: "receipt", receiptId: "T2", note: "" });
  dear.price = 8; dear.listedQty = 1;
  G.state.listingRules = [G.normalizeListingRule({ name: "Keep one", keep: 1 })];
  assert.equal(targetOf(G, dear).target, 1, "keep 1 holds the cheap copy, the $8 one is listed");
  G.state.settings.neverListAtLoss = true;
  assert.equal(targetOf(G, dear).target, 1, "still listed with the switch on");
  const c = targetOf(G, cheap);
  assert.equal(c.target, 0);
  assert.equal(c.rule.name, "Below minimum profit");
});

// A second, unlisted stack of the same printing in another location.
function binder(G, qty, price, cost) {
  G.state.locations.push(G.newLocation({ id: "loc2", name: "Binder", type: "binder" }));
  const b = G.addCopies({ set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc2", qty, info: INFO, unitCost: null, action: "receipt", receiptId: "T3", note: "" });
  b.price = price;
  if (cost != null) G.setCostBasis(b, cost, qty);
  return b;
}

test("delistUnprofitablePlan: unlisted stacks of the printing don't drag a profitable listing's cost up", () => {
  const { G } = setup(0.1, 1, 1);
  binder(G, 4, 10, 10);
  assert.equal(G.delistUnprofitablePlan(live(1)).cards.length, 0);
  assert.equal(G.delistUnprofitablePlan().items.length, 0);
});

test("delistUnprofitablePlan: an unlisted stack with no cost doesn't protect an unprofitable listing", () => {
  const { G } = setup(5, 1, 1);
  binder(G, 1, 10, null);
  const p = G.delistUnprofitablePlan(live(1));
  assert.equal(p.cards.length, 1);
  assert.equal(p.items[0].cost, 5);
});

test("delistUnprofitablePlan: with no stack listed locally, all stacks are judged", () => {
  const { G, r } = setup(5, 1, 1);
  r.listedQty = 0;
  assert.equal(G.delistUnprofitablePlan(live(1)).cards.length, 1);
});

test("delistUnprofitablePlan: two listed stacks, only one with a cost, stay up", () => {
  const { G } = setup(5, 1, 1);
  const b = binder(G, 1, 1, null);
  b.listedQty = 1;
  assert.equal(G.delistUnprofitablePlan(live(1)).cards.length, 0);
});

/* ---------------- rework 2: the whole keep-and-spread path ---------------- */

// Build a store from stack specs { print: "141"|"142", loc: "loc1"|"loc2", qty, price, cost }.
// loc2 has the higher pick priority. All stacks are listed, in sell-from locations.
function build(specs, keep, noLoss) {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations.push(G.newLocation({ id: "loc2", name: "Shelf B", type: "bin" }));
  for (const l of G.state.locations) l.sellFrom = true;
  G.state.locations.find(l => l.id === "loc2").pickPriority = 5;
  G.state.listingRules = [G.normalizeListingRule({ name: "Keep", keep })];
  G.state.settings.neverListAtLoss = noLoss;
  const recs = specs.map((s, i) => {
    const r = G.addCopies({ set: "a25", num: s.print, lang: "en", finish: "nonfoil", condition: "NM",
      locationId: s.loc, qty: s.qty, info: s.print === "141" ? INFO : OTHER, unitCost: null,
      action: "receipt", receiptId: "T" + i, note: "" });
    r.price = s.price; r.listedQty = s.qty; r.askPrice = s.price;
    if (s.cost != null) G.setCostBasis(r, s.cost, s.qty);
    return r;
  });
  return { G, recs };
}
const tgt = (G, r) => G.listingPlan({ includeUnchanged: true }).find(l => l.record === r);

test("switch on, keep 1: a below-cost printing uses up the keep, the profitable listing stays up", () => {
  const { G, recs } = build([
    { print: "141", loc: "loc1", qty: 1, price: 2, cost: 1 },
    { print: "142", loc: "loc1", qty: 1, price: 8, cost: 10 }], 1, true);
  assert.equal(tgt(G, recs[0]).target, 1, "the profitable $2 listing is still listed");
  const loss = tgt(G, recs[1]);
  assert.equal(loss.target, 0);
  assert.equal(loss.rule.name, "Below minimum profit");
});

test("switch on: the spread never moves copies onto a below-cost stack", () => {
  const { G, recs } = build([
    { print: "141", loc: "loc2", qty: 2, price: 1, cost: 5 },     // higher pick priority, a loss
    { print: "141", loc: "loc1", qty: 2, price: 1, cost: 0.1 }], 0, true);
  // The two stacks are one Manapool listing at one ask; judged as a listing, each stack is
  // judged on its own cost, so the dear-cost one is "Below minimum profit" and the cheap-cost one lists.
  assert.equal(tgt(G, recs[0]).target, 0);
  assert.equal(tgt(G, recs[1]).target, 2);
});

test("switch on: Below cost never ends above 0, and no profitable stack loses copies because of one", () => {
  const combos = [
    [{ print: "141", loc: "loc1", qty: 2, price: 1, cost: 5 }, { print: "141", loc: "loc2", qty: 2, price: 1, cost: 0.1 }],
    [{ print: "141", loc: "loc1", qty: 1, price: 1, cost: 5 }, { print: "142", loc: "loc2", qty: 3, price: 6, cost: 2 }],
    [{ print: "141", loc: "loc2", qty: 3, price: 1, cost: 5 }, { print: "141", loc: "loc1", qty: 1, price: 1, cost: 0.1 },
     { print: "142", loc: "loc1", qty: 2, price: 9, cost: 1 }],
    [{ print: "141", loc: "loc1", qty: 2, price: 2, cost: 1 }, { print: "142", loc: "loc1", qty: 2, price: 8, cost: 10 },
     { print: "142", loc: "loc2", qty: 1, price: 8, cost: 1 }],
    [{ print: "141", loc: "loc1", qty: 2, price: 3, cost: null }, { print: "142", loc: "loc2", qty: 2, price: 1, cost: 4 }]
  ];
  for (const specs of combos) for (const keep of [0, 1, 2, 3]) {
    const { G, recs } = build(specs, keep, true);
    const lines = recs.map(r => tgt(G, r));
    const losers = new Set(lines.filter(l => l.rule && l.rule.name === "Below minimum profit").map(l => l.record));
    for (const l of lines) if (losers.has(l.record)) assert.equal(l.target, 0, "below cost stays at 0");
    // Baseline: the same store without the below-cost stacks. Every profitable stack must list at least as much.
    const keepSpecs = specs.filter((s, i) => !losers.has(recs[i]));
    const base = build(keepSpecs, keep, true);
    const total = (G2, rs) => rs.reduce((n, r) => n + tgt(G2, r).target, 0);
    const kept = recs.filter(r => !losers.has(r));
    assert.ok(total(G, kept) >= total(base.G, base.recs), "a profitable stack lost copies, keep " + keep + " " + JSON.stringify(specs));
  }
});

/* ---------------- #390: per-account minimum profit ---------------- */

test("minimum profit: no default is merged into settings, so 'none stored' is still told apart (#390)", () => {
  const { G } = setup(1, 0.5);
  assert.ok(!("minProfitPct" in G.state.settings), "a fresh account stores no minimum");
  assert.equal(G.minProfitPct(), 25, "none stored, switch off: 25%");
  G.state.settings.neverListAtLoss = true;
  assert.equal(G.minProfitPct(), 0, "none stored, switch on: 0%, the rule it had before");
  G.state.settings.minProfitPct = 40;
  assert.equal(G.minProfitPct(), 40, "a stored value wins");
});

test("minimum profit: Delist unprofitable takes down a profitable card under the minimum, and says its profit % (#390)", () => {
  // Cost $1.00, listed $1.10: 10% profit. Switch off, none stored: 25%.
  const { G } = setup(1, 1.1);
  const p = G.delistUnprofitablePlan(live(1.1));
  assert.equal(p.cards.length, 1);
  assert.equal(p.minPct, 25);
  assert.deepEqual([p.items[0].price, p.items[0].cost, p.items[0].profit, p.items[0].pct], [1.1, 1, 0.1, 10]);
  assert.equal(G.delistUnprofitablePlan().items.length, 1, "the button's count agrees");
  G.state.settings.minProfitPct = 10;
  assert.equal(G.delistUnprofitablePlan(live(1.1)).cards.length, 0, "exactly at the minimum stays up");
  G.state.settings.minProfitPct = 0;
  assert.equal(G.delistUnprofitablePlan(live(1.1)).cards.length, 0, "0%: only at or below cost, as before");
  assert.equal(G.delistUnprofitablePlan(live(1)).cards.length, 1, "0%: break-even still comes down");
});

test("minimum profit: $1.00 at 25% must list at $1.25 or more (#390)", () => {
  for (const [ask, down] of [[1.24, true], [1.25, false], [1.26, false]]) {
    const { G } = setup(1, ask);
    assert.equal(G.delistUnprofitablePlan(live(ask)).cards.length, down ? 1 : 0, "listed " + ask);
  }
});

test("minimum profit: a $0 cost with a price is never under it; no cost entered is never touched (#390)", () => {
  let { G } = setup(0, 0.05);
  G.state.settings.minProfitPct = 500;
  assert.equal(G.delistUnprofitablePlan(live(0.05)).cards.length, 0, "$0 cost: unbounded %");
  ({ G } = setup(null, 0.01));
  G.state.settings.minProfitPct = 500;
  assert.equal(G.delistUnprofitablePlan(live(0.01)).cards.length, 0, "no cost entered");
});

test("minimum profit: Evaluate with the switch on lists a card under the minimum at 0, one at or over it as the rule says (#390)", () => {
  // Market $0.50 is the price a push would send (no Bulk Price rule).
  for (const [cost, minPct, listed] of [[0.45, 25, 0], [0.4, 25, 2], [0.38, 25, 2], [0.45, undefined, 2]]) {
    const { G, r } = setup(cost, 0.5, 0.5);
    r.listedQty = 0;
    G.state.settings.neverListAtLoss = true;
    if (minPct !== undefined) G.state.settings.minProfitPct = minPct;
    const line = targetOf(G, r);
    assert.equal(line.target, listed, "cost " + cost + ", minimum " + minPct);
    assert.equal(!!line.rule && line.rule.name === "Below minimum profit", listed === 0);
  }
});
