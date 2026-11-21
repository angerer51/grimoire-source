"use strict";
/* Regression tests for the #64 page audit, group 1 (Stock): issues #68, #70,
   #71, #72, #74 and #75. Each block names the issue it guards. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

/* ---- #68: Locations' rule tester honours the Finish dropdown ---- */

const BOLT = {
  name: "Lightning Bolt", set: "2x2", collector: "117", rarity: "uncommon",
  typeLine: "Instant", colors: ["R"], colorIdentity: ["R"],
  usd: "1.00", usdFoil: "5.00", usdEtched: "9.00"
};

test("#68 shapeForRuleTest: the finish string drives both finish and price", () => {
  const G = freshCoreWithLocation();
  const foil = G.shapeForRuleTest(BOLT, "foil", 1);
  assert.equal(foil.finish, "foil");
  assert.equal(foil.price, 5);
  assert.equal(foil.quantity, 1);
  assert.equal(G.shapeForRuleTest(BOLT, "etched").price, 9);
  assert.equal(G.shapeForRuleTest(BOLT, "nonfoil").price, 1);
  assert.equal(G.shapeForRuleTest(BOLT, "").finish, "nonfoil", "an unknown value falls back to non-foil");
});

test("#68 shapeForRuleTest: a foil-only rule passes a foil and fails a non-foil; price rules see the foil price", () => {
  const G = freshCoreWithLocation();
  const foilOnly = { on: true, field: "finish", op: "is", value: "foil" };
  assert.equal(G.matchRule(G.shapeForRuleTest(BOLT, "foil"), foilOnly), true);
  assert.equal(G.matchRule(G.shapeForRuleTest(BOLT, "nonfoil"), foilOnly), false);
  const overFour = { on: true, field: "price", op: "gte", value: "4" };
  assert.equal(G.matchRule(G.shapeForRuleTest(BOLT, "foil"), overFour), true);
  assert.equal(G.matchRule(G.shapeForRuleTest(BOLT, "nonfoil"), overFour), false);
});

/* ---- #70: Refresh prices batches past the server's identifier cap ---- */

function stack(G, n, finish, locationId) {
  return G.addCopies({
    set: "tst", num: String(n), lang: "en", finish: finish || "nonfoil", condition: "NM",
    locationId: locationId || "loc1", qty: 1,
    info: { name: "Card " + n, collector: String(n), price: 0.1 }
  });
}

test("#70 refreshPrices: sends identifiers in batches no bigger than the cap and prices every stack", async () => {
  const G = freshCoreWithLocation();
  assert.equal(G.COLLECTION_BATCH, 20000, "matches the server's slice in POST /api/cards/collection");
  for (let n = 1; n <= 7; n++) stack(G, n);
  stack(G, 1, "foil"); // same printing, another finish: one identifier, not two
  const calls = [];
  G.cards.collection = async ids => {
    calls.push(ids.length);
    return { found: ids.map(i => ({ set: i.set, collector: i.collector, lang: "en", name: "Card " + i.collector, usd: "2.00", usdFoil: "3.00" })) };
  };
  const progress = [];
  const out = await G.refreshPrices(m => progress.push(m), { batchSize: 3 });
  assert.deepEqual(calls, [3, 3, 1], "7 distinct printings in batches of 3");
  assert.equal(out.missing, 0);
  assert.equal(out.updated, 8);
  assert.ok(G.state.cards.every(r => !r.lookupFail), "nothing flagged as a lookup failure");
  assert.equal(G.state.cards.find(r => r.collector === "7").price, 2);
  assert.equal(G.state.cards.find(r => r.finish === "foil").price, 3);
  assert.ok(progress.some(m => /batch 3 of 3/.test(m)), "progress reported per batch");
});

const answerAll = ids => ({ found: ids.map(i => ({ set: i.set, collector: i.collector, lang: "en", usd: "9.00" })) });
const priceOfStack = (G, n) => G.state.cards.find(r => r.collector === String(n)).price;

test("#70 refreshPrices: a batch that fails once is retried and applies", async () => {
  const G = freshCoreWithLocation();
  for (let n = 1; n <= 4; n++) stack(G, n);
  let call = 0;
  G.cards.collection = async ids => { if (++call === 2) throw new Error("blip"); return answerAll(ids); };
  const out = await G.refreshPrices(null, { batchSize: 2 });
  assert.equal(call, 3, "batch 1, batch 2 (fails), batch 2 retry");
  assert.equal(out.updated, 4);
  assert.equal(out.skipped, 0);
  assert.ok(G.state.cards.every(r => r.price === 9 && !r.lookupFail));
});

test("#70 refreshPrices: a batch that fails twice leaves its stacks alone, unflagged; the rest still apply", async () => {
  const G = freshCoreWithLocation();
  for (let n = 1; n <= 4; n++) stack(G, n);
  G.cards.collection = async ids => {
    if (ids.some(i => i.collector === "3")) throw new Error("network down");
    return answerAll(ids);
  };
  const out = await G.refreshPrices(null, { batchSize: 2 });
  assert.deepEqual({ updated: out.updated, skipped: out.skipped, missing: out.missing }, { updated: 2, skipped: 2, missing: 0 });
  assert.equal(priceOfStack(G, 1), 9);
  assert.equal(priceOfStack(G, 2), 9);
  assert.equal(priceOfStack(G, 3), 0.1, "kept its old price");
  assert.equal(priceOfStack(G, 4), 0.1);
  assert.ok(G.state.cards.every(r => !r.lookupFail), "a stack the server never answered for is not a lookup failure");
});

test("#70 refreshPrices: when every batch fails it throws with nothing changed", async () => {
  const G = freshCoreWithLocation();
  for (let n = 1; n <= 4; n++) stack(G, n);
  G.cards.collection = async () => { throw new Error("network down"); };
  await assert.rejects(G.refreshPrices(null, { batchSize: 2 }), /network down/);
  assert.ok(G.state.cards.every(r => r.price === 0.1 && !r.lookupFail));
});

test("#70 refreshPrices: prices land on the live list even if state.cards is replaced mid-refresh", async () => {
  const G = freshCoreWithLocation();
  for (let n = 1; n <= 4; n++) stack(G, n);
  let call = 0;
  G.cards.collection = async ids => {
    // A merged save / undo / import swaps state.cards for new objects while the request is in flight.
    if (++call === 1) G.adoptState(JSON.parse(JSON.stringify(G.state)));
    return answerAll(ids);
  };
  const out = await G.refreshPrices(null, { batchSize: 2 });
  assert.equal(out.updated, 4);
  for (let n = 1; n <= 4; n++) assert.equal(priceOfStack(G, n), 9, "stack " + n + " got the new price");
});

test("#70 refreshPrices: a stack added mid-refresh is skipped, not flagged", async () => {
  const G = freshCoreWithLocation();
  for (let n = 1; n <= 2; n++) stack(G, n);
  G.cards.collection = async ids => { if (!G.state.cards.some(r => r.collector === "77")) stack(G, 77); return answerAll(ids); };
  const out = await G.refreshPrices(null, { batchSize: 2 });
  assert.equal(out.updated, 2);
  assert.equal(out.skipped, 1);
  assert.equal(G.state.cards.find(r => r.collector === "77").lookupFail, null);
});

/* ---- #71: sealed listed quantity survives a merge and is capped by a full count ---- */

function withTwoBins() {
  const G = freshCoreWithLocation();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "Back room", type: "bin" }));
  return G;
}
function sealed(G, locationId, qty, listed) {
  const rec = G.addSealedCopies({
    tcgplayerProductId: "tcg-1", manapoolProductId: "mp-1", name: "Foundations Bundle", setCode: "fdn",
    locationId, qty, price: 50
  });
  if (listed) G.setSealedListedQty(rec.id, listed);
  return G.state.sealed.find(r => r.locationId === locationId);
}

test("#71 moveSealedLocation: merging onto the same product elsewhere adds the listed quantity", () => {
  const G = withTwoBins();
  const shelf = sealed(G, "loc1", 2, 0);
  const back = sealed(G, "loc2", 3, 3);
  G.moveSealedLocation(back.id, "loc1");
  assert.equal(G.state.sealed.length, 1);
  assert.equal(shelf.quantity, 5);
  assert.equal(shelf.listedQty, 3);
});

test("#71 moveAllSealedFromLocation: listed quantity is kept and never exceeds on-hand", () => {
  const G = withTwoBins();
  const shelf = sealed(G, "loc1", 2, 2);
  sealed(G, "loc2", 1, 1);
  G.moveAllSealedFromLocation("loc2", "loc1");
  assert.equal(shelf.quantity, 3);
  assert.equal(shelf.listedQty, 3);
  assert.ok(shelf.listedQty <= shelf.quantity);
});

test("#71 applySealedCycleCountAdjustments: a count below the listed quantity caps listed at on-hand", () => {
  const G = withTwoBins();
  const rec = sealed(G, "loc1", 3, 3);
  G.applySealedCycleCountAdjustments("loc1", [{ recordId: rec.id, countedQty: 1 }]);
  assert.equal(rec.quantity, 1);
  assert.equal(rec.listedQty, 1);
});

/* ---- #72: Apply full count is all-or-nothing when a card lookup fails ---- */

test("#72 applyCycleCountAdjustments: a failing lookup throws naming the card and changes nothing", async () => {
  const G = freshCoreWithLocation();
  const a = stack(G, 1);
  const b = stack(G, 2);
  const before = JSON.stringify(G.state.cards);
  const stampBefore = G.locById("loc1").lastCycleCountAt;
  G.cards.one = async (set, num) => { if (num === "99") throw new Error("timed out"); return { set, collector: num, name: "Found " + num, usd: "1" }; };
  await assert.rejects(
    G.applyCycleCountAdjustments("loc1", [
      { recordId: a.id, countedQty: 0 },          // would be removed
      { recordId: b.id, countedQty: 4 },          // would be bumped
      { recordId: null, set: "tst", collector: "50", lang: "en", finish: "nonfoil", condition: "NM", countedQty: 1 },
      { recordId: null, set: "tst", collector: "99", lang: "en", finish: "nonfoil", condition: "NM", countedQty: 1 }
    ]),
    err => /TST #99/.test(err.message) && /Nothing was changed/.test(err.message));
  assert.equal(JSON.stringify(G.state.cards), before, "state.cards untouched");
  assert.equal(G.locById("loc1").lastCycleCountAt, stampBefore, "not stamped as counted");
});

test("#72 applyCycleCountAdjustments: with every lookup good, the whole count applies", async () => {
  const G = freshCoreWithLocation();
  const a = stack(G, 1);
  const b = stack(G, 2);
  G.cards.one = async (set, num) => ({ set, collector: num, name: "Found " + num, usd: "1" });
  const out = await G.applyCycleCountAdjustments("loc1", [
    { recordId: a.id, countedQty: 0 },
    { recordId: b.id, countedQty: 4 },
    { recordId: null, set: "tst", collector: "50", lang: "en", finish: "nonfoil", condition: "NM", countedQty: 2 }
  ]);
  assert.deepEqual({ adjusted: out.adjusted, added: out.added }, { adjusted: 2, added: 1 });
  assert.equal(G.state.cards.find(r => r.collector === "1"), undefined);
  assert.equal(G.state.cards.find(r => r.collector === "2").quantity, 4);
  assert.equal(G.state.cards.find(r => r.collector === "50").quantity, 2);
  assert.ok(G.locById("loc1").lastCycleCountAt);
});

/* ---- #74: a location's last sealed count date survives a reload ---- */

test("#74 adoptState keeps lastSealedCycleCountAt (and lastCycleCountAt) on every location", () => {
  const G = withTwoBins();
  sealed(G, "loc1", 2, 0);
  G.applySealedCycleCountAdjustments("loc1", []);
  const stamp = G.locById("loc1").lastSealedCycleCountAt;
  assert.ok(stamp, "a sealed full count stamps the bin");
  G.locById("loc1").lastCycleCountAt = "2026-10-01T00:00:00.000Z";
  // A reload / merged save / undo all run the saved document back through adoptState.
  G.adoptState(JSON.parse(JSON.stringify(G.state)));
  assert.equal(G.locById("loc1").lastSealedCycleCountAt, stamp);
  assert.equal(G.locById("loc1").lastCycleCountAt, "2026-10-01T00:00:00.000Z");
  assert.equal(G.locById("loc2").lastSealedCycleCountAt, null, "a never-counted bin stays null");
});

test("#74 pickSealedCycleCountBin: a just-counted bin is never offered over an uncounted one after a reload", () => {
  const G = withTwoBins();
  // Pool is max(3, 25%) of eligible bins, so use enough bins that the pool is smaller than the set.
  for (let i = 3; i <= 6; i++) G.state.locations.push(G.newLocation({ id: "loc" + i, name: "Bin " + i, type: "bin" }));
  for (let i = 1; i <= 6; i++) sealed(G, "loc" + i, 1, 0);
  for (let i = 1; i <= 3; i++) G.applySealedCycleCountAdjustments("loc" + i, []);
  G.adoptState(JSON.parse(JSON.stringify(G.state)));
  for (let k = 0; k < 40; k++) {
    const pick = G.pickSealedCycleCountBin();
    assert.ok(["loc4", "loc5", "loc6"].includes(pick.id), "picked " + pick.id + ", which was just counted");
  }
});

/* ---- #75: Floor -> Book's Sample size box drives the progress line ---- */

test("#75 cycleSampleProgress: counts toward the Sample size box, falling back to Settings then 10", () => {
  const G = freshCoreWithLocation();
  const p = G.cycleSampleProgress(3, "10");
  assert.deepEqual({ count: p.count, target: p.target, done: p.done }, { count: 3, target: 10, done: false });
  assert.match(p.text, /^3 of 10 sampled - add 7 more/);
  assert.equal(G.cycleSampleProgress(5, 5).done, true);
  assert.match(G.cycleSampleProgress(6, "5").text, /ready to check/);
  G.state.settings.cycleCountSampleSize = 25;
  assert.equal(G.cycleSampleProgress(0, "").target, 25, "blank box uses the Settings value");
  G.state.settings.cycleCountSampleSize = null;
  assert.equal(G.cycleSampleProgress(0, "abc").target, 10);
  assert.equal(G.cycleSampleProgress(0, "-4").target, 1, "never below 1");
});
