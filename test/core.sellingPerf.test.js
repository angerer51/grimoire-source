"use strict";
/* #99: Listings and Bulk Price Evaluate at 70k stacks. A plan sorts the
   active rules once (not once per stack), the page's filter box searches a
   plan built once (core's planView) instead of rebuilding it per keystroke,
   and Apply looks stacks up by id instead of scanning the collection per line.
   #103: Buy List keeps only the newest overlapping search (latestOnly) and
   reads owned counts from one index (ownedIndex) instead of a scan per row. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const box = conds => ({ combinator: "ALL", not: false, groups: [],
  conditions: conds.map(([field, op, value]) => ({ on: true, field, op, value })) });

function collection(n) {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations[0].sellFrom = true;   // a shelf that is listed from (#194)
  const rarities = ["common", "uncommon", "rare", "mythic"];
  for (let i = 0; i < n; i++) {
    const name = "Card " + (i % 17);
    const r = G.addCopies({ set: "tst", num: String(i + 1), lang: "en", finish: "nonfoil", condition: "NM",
      locationId: "loc1", qty: 1 + (i % 5),
      info: { name, collector: String(i + 1), setName: "Test Set", rarity: rarities[i % 4], tcgplayerId: "1",
        scryfallId: "sid-" + i, price: 0.1 * (i % 23), priceNote: "", note: "", meta: { oracleId: "oid-" + (i % 17) } },
      action: "receipt", receiptId: "T1", note: "" });
    r.listedQty = i % 3;
  }
  return G;
}

// Count how many times a plan filters the rule list (once per sort).
function countFilters(arr) {
  let calls = 0;
  const orig = arr.filter;
  arr.filter = function () { calls++; return orig.apply(this, arguments); };
  return () => calls;
}

test("listingPlan sorts the active rules once per plan, not once per stack (#99)", () => {
  const G = collection(60);
  G.state.listingRules = [
    G.normalizeListingRule({ name: "Rares", priority: 5, keep: 1, criteria: box([["rarity", "is", "rare"]]) }),
    G.normalizeListingRule({ name: "All", priority: 0, keep: 2 }),
    G.normalizeListingRule({ name: "Off", on: false, priority: 9, keep: 9 })
  ];
  const calls = countFilters(G.state.listingRules);
  G.listingPlan({ includeUnchanged: true });
  assert.equal(calls(), 1, "one sort for 60 stacks");
});

test("listingPlan's shared rule list and exception index give every stack the same rule as before (#99)", () => {
  const G = collection(60);
  G.state.listingRules = [
    G.normalizeListingRule({ name: "Rares", priority: 5, keep: 1, criteria: box([["rarity", "is", "rare"]]) }),
    G.normalizeListingRule({ name: "Cheap", priority: 5, keep: 3, criteria: box([["price", "lt", "1"]]) }),
    G.normalizeListingRule({ name: "All", priority: 0, keep: 2 })
  ];
  // Two overrides for the same name: the first one wins, as find() did.
  G.state.listingKeepExceptions = [
    G.normalizeKeepException({ name: "Card 3", keep: 7 }),
    G.normalizeKeepException({ name: " card 3 ", keep: 1 })
  ];
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(plan.length, 60);
  for (const line of plan) {
    const solo = G.listingTarget(line.record);          // no shared context: worked out fresh
    assert.equal(line.keep, solo.keep, line.record.name);
    assert.equal(line.rule && line.rule.id, solo.rule && solo.rule.id, line.record.name);
  }
  assert.ok(plan.some(l => l.record.name === "Card 3" && l.keep === 7));
});

test("bulkPricePlan sorts the active price rules once per plan (#99)", () => {
  const G = collection(60);
  G.state.priceRules = [
    G.normalizePriceRule({ name: "Rares", on: true, priority: 5, mode: "fixed", fixed: 2, criteria: box([["rarity", "is", "rare"]]) }),
    G.normalizePriceRule({ name: "All", on: true, priority: 0, mode: "percent", percent: 0.9 })
  ];
  const calls = countFilters(G.state.priceRules);
  const plan = G.bulkPricePlan({ includeUnchanged: true });
  assert.equal(calls(), 1);
  for (const line of plan) assert.equal(line.rule.id, G.ruleForPriceRecord(line.record).id);
});

test("planView: the filter box searches the built plan without recomputing it per keystroke (#99)", () => {
  const lines = [{ n: "Lightning Bolt" }, { n: "Shock" }, { n: "Bolt Bend" }, { n: "Opt" }];
  let hayCalls = 0;
  const view = require("../test-lib/core-shim").freshCore().planView(lines, l => { hayCalls++; return l.n; });
  assert.equal(hayCalls, 4, "search text worked out once per line, at build");
  assert.deepEqual(Array.from(view.filter("bolt"), l => l.n), ["Lightning Bolt", "Bolt Bend"], "plan order kept");
  assert.deepEqual(Array.from(view.filter("  BOLT "), l => l.n), ["Lightning Bolt", "Bolt Bend"], "trimmed, any case");
  assert.equal(view.filter(""), lines, "no filter is the whole plan");
  assert.equal(view.filter("zzz").length, 0);
  assert.equal(hayCalls, 4, "filtering never recomputes it");
});

test("applyListingPlan with many lines still writes each stack once, found by id (#99)", () => {
  const G = collection(30);
  G.state.listingRules = [G.normalizeListingRule({ name: "All", priority: 0, keep: 0 })];
  const plan = G.listingPlan();
  assert.ok(plan.length > 1);
  const out = G.applyListingPlan(plan, "test");
  assert.equal(out.changed, plan.length);
  for (const line of plan) assert.equal(line.record.listedQty, line.target);
  assert.equal(G.listingPlan().length, 0, "nothing left to change");
});

test("ownedIndex counts owned copies per card across printings and knows which sets you have it in (#103)", () => {
  const G = collection(34);   // oid-0 .. oid-16, two stacks each
  const idx = G.ownedIndex();
  for (let o = 0; o < 17; o++) {
    const id = "oid-" + o;
    const scan = G.state.cards.filter(r => r.oracleId === id).reduce((n, r) => n + r.quantity, 0);
    assert.equal(idx.qty(id), scan, id);
  }
  assert.equal(idx.qty("nope"), 0);
  assert.equal(idx.qty(""), 0);
  assert.equal(idx.inSet("tst", "oid-0"), true);
  assert.equal(idx.inSet("other", "oid-0"), false);
  // qtyInSet: copies of the card within one set only.
  const inTst = G.state.cards.filter(r => r.oracleId === "oid-0" && r.set === "tst").reduce((n, r) => n + r.quantity, 0);
  assert.equal(idx.qtyInSet("tst", "oid-0"), inTst);
  assert.ok(inTst > 0);
  assert.equal(idx.qtyInSet("other", "oid-0"), 0);
  assert.equal(idx.qtyInSet("tst", ""), 0);
  // A stack at 0 copies still counts as "in that set", as the old scan did.
  G.state.cards[0].quantity = 0;
  assert.equal(G.ownedIndex().inSet("tst", G.state.cards[0].oracleId), true);
});

test("latestOnly: a slow older search can't render over the newer one typed after it (#103)", async () => {
  const G = require("../test-lib/core-shim").freshCore();
  const begin = G.latestOnly();
  const drawn = [];
  const search = async (q, ms) => {
    const isCurrent = begin();
    await new Promise(r => setTimeout(r, ms));
    if (!isCurrent()) return;
    drawn.push(q);
  };
  await Promise.all([search("bol", 30), search("bolt", 5)]);
  assert.deepEqual(drawn, ["bolt"], "the 'bol' result arrived last and was dropped");
  await search("bolts", 1);
  assert.deepEqual(drawn, ["bolt", "bolts"], "a request with nothing newer still renders");
});

test("sortRows orders a whole plan the way a column click orders drawn rows (#99 review)", () => {
  const G = require("../test-lib/core-shim").freshCore();
  const rows = [{ n: "b", v: 3 }, { n: "a", v: null }, { n: "C", v: 1 }, { n: "a2", v: 3 }, { n: "a10", v: "" }];
  const by = (key, dir) => Array.from(G.sortRows(rows, key, dir), r => r.n);
  assert.deepEqual(by(r => r.v, 1), ["C", "b", "a2", "a", "a10"], "numbers ascending, ties keep order, blanks last");
  // Descending flips ties too, exactly as ui.js sortTable does, so the drawn
  // rows it re-sorts come out in the same order as the plan.
  assert.deepEqual(by(r => r.v, -1), ["a2", "b", "C", "a10", "a"], "blanks still last when descending");
  assert.deepEqual(by(r => r.n, 1), ["a", "a2", "a10", "b", "C"], "text: case-insensitive, natural order");
  assert.equal(rows[0].n, "b", "the input array is left alone");
});

test("planFingerprint: a kept plan is caught once the stacks under it change (#99 review)", () => {
  const G = collection(12);
  G.state.listingRules = [G.normalizeListingRule({ name: "All", priority: 0, keep: 0 })];
  const kept = G.listingPlan({ includeUnchanged: true });
  const fp = lines => G.planFingerprint(lines, l => l.record.price);
  assert.equal(fp(G.listingPlan({ includeUnchanged: true })), fp(kept), "nothing changed: same fingerprint");

  // Copies leave a stack (an order picked elsewhere, an undo, another
  // device's save): the kept plan would push more than is now on hand.
  const line = kept.find(l => l.target >= 2);
  const rec = G.state.cards.find(r => r.id === line.record.id);
  rec.quantity = 1;
  assert.ok(line.target > G.listableQty(rec, G.manapoolReservations()), "the kept plan is stale");
  assert.notEqual(fp(G.listingPlan({ includeUnchanged: true })), fp(kept), "a rebuild shows it");

  // Whole-state replacement (undo, a merged save) gives new record objects
  // with the same numbers: that is not a change.
  const G2 = collection(12);
  G2.state.listingRules = [G2.normalizeListingRule({ name: "All", priority: 0, keep: 0 })];
  const before = G2.listingPlan({ includeUnchanged: true });
  G2.state.cards = G2.state.cards.map(r => Object.assign({}, r));
  assert.equal(fp(G2.listingPlan({ includeUnchanged: true })), fp(before));
});
