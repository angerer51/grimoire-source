"use strict";
/* Listings / Manapool quantity bookkeeping (#86, #89, #90).

   #86: a card sold on Manapool but not yet picked must not be listed or
   pushed again, a price push never raises Manapool's quantity, and
   completing a Manapool order's pick list lowers listed by what it pulled
   (once - not again after a Fetch listings already did).
   #89: a confirmed Listings push lands on the stacks the plan chose.
   #90: keep holds back the cheapest copies (and unpriced ones), lists the
   dearest. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {}
};
const KEY = "abc-123|en|nonfoil|NM";
const LINE = { kind: "card", set: "a25", collector: "141", lang: "en", finish: "nonfoil",
  condition: "NM", name: "Lightning Bolt" };

function setup() {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations[0].sellFrom = true;
  return G;
}
// `other`: a second printing of the same card (a different Manapool listing).
const OTHER = Object.assign({}, INFO, { collector: "142", scryfallId: "def-456" });
function receive(G, qty, locationId, price, other) {
  const r = G.addCopies({ set: "a25", num: other ? "142" : "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: locationId || "loc1", qty, info: other ? OTHER : INFO, action: "receipt", receiptId: "T1", note: "" });
  if (price !== undefined) r.price = price;
  return r;
}
// An open pick list for a Manapool order selling `qty` copies.
function sell(G, qty, orderId) {
  const pl = G.newPickList({ source: "manapool", orderId: orderId || "order-1" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, Object.assign({}, LINE, { qty, unitPrice: 1 }));
  return pl;
}

/* ---------------- #86 path 1: Evaluate / Push ---------------- */

test("listingPlan: a copy sold on Manapool but not picked yet is not offered for listing again (#86)", () => {
  const G = setup();
  const r = receive(G, 1);
  r.listedQty = 1;
  sell(G, 1);
  // Fetch listings: Manapool already took it off.
  G.syncManapoolListings([]);
  assert.equal(r.listedQty, 0);

  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].reserved, 1);
  assert.equal(plan[0].target, 0, "keep 0, but the only copy is sold - it must not be listed again");
  assert.equal(G.listingPlan().length, 0, "so Evaluate shows no change for it");
});

test("listingPlan: before a Fetch, the sold copy is already off Manapool, so no row (#86, #487)", () => {
  const G = setup();
  const r = receive(G, 3);
  r.listedQty = 3;
  sell(G, 1);
  const [line] = G.listingPlan({ includeUnchanged: true });
  assert.equal(line.available, 2);
  assert.equal(line.target, 2);
  assert.equal(line.listedNow, 2, "Manapool already dropped the sold copy; a push never re-lists it");
  assert.equal(line.delta, 0);
});

test("applyListingPlan: never sets listed above the unreserved copies, even from a stale plan line (#86)", () => {
  const G = setup();
  const r = receive(G, 2);
  const stale = { record: r, target: 2 };   // planned before the sale came in
  sell(G, 1);
  G.applyListingPlan([stale], "test");
  assert.equal(r.listedQty, 1);
});

test("syncManapoolListings: Manapool's number lands on unreserved copies first (#86)", () => {
  const G = setup();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "Shelf B", type: "bin", sellFrom: true }));
  G.state.locations[0].pickPriority = 10;   // the order picks from loc1
  const a = receive(G, 1, "loc1");
  const b = receive(G, 1, "loc2");
  sell(G, 1);
  G.syncManapoolListings([{ kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 1 }]);
  assert.equal(a.listedQty, 0, "loc1's copy is the one sold");
  assert.equal(b.listedQty, 1);
  assert.equal(G.listingPlan().length, 0, "and Evaluate agrees nothing needs changing");
});

/* ---------------- #86: completing the pick ---------------- */

test("completePickList: a Manapool pick lowers listed by what it pulled, not just a cap (#86)", () => {
  const G = setup();
  const r = receive(G, 4);
  r.listedQty = 2;
  const pl = sell(G, 1);
  G.completePickList(pl.id);
  assert.equal(r.quantity, 3);
  assert.equal(r.listedQty, 1, "sold 1 of 4 with 2 listed leaves 1 listed, as on Manapool");
});

test("completePickList: after a Fetch listings, completing the pick doesn't lower listed a second time (#86)", () => {
  const G = setup();
  const r = receive(G, 4);
  r.listedQty = 2;
  const pl = sell(G, 1);
  // Manapool shows 1 now; the fetch already brought local in line.
  G.syncManapoolListings([{ kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 1 }]);
  assert.equal(r.listedQty, 1);
  assert.equal(pl.listedSettled, true);
  G.completePickList(pl.id);
  assert.equal(r.quantity, 3);
  assert.equal(r.listedQty, 1, "still 1, not 0");
});

test("completePickList: a manual pick list doesn't touch the listed count beyond the old cap", () => {
  const G = setup();
  const r = receive(G, 4);
  r.listedQty = 2;
  const pl = G.newPickList({ source: "manual" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, Object.assign({}, LINE, { qty: 1 }));
  G.completePickList(pl.id);
  assert.equal(r.listedQty, 2, "a manual pick never lowered anything on Manapool");
});

test("ensureOrderPickList: an order placed before the last Fetch listings is marked settled, a newer one isn't (#86)", async () => {
  const G = setup();
  receive(G, 4);
  G.state.settings.manapoolSyncedAt = "2026-10-09T12:00:00.000Z";
  const older = { id: "o1", placedAt: "2026-10-09T11:00:00.000Z", lines: [Object.assign({}, LINE, { qty: 1 })] };
  const newer = { id: "o2", placedAt: "2026-10-09T13:00:00.000Z", lines: [Object.assign({}, LINE, { qty: 1 })] };
  assert.equal((await G.ensureOrderPickList(older)).pickList.listedSettled, true);
  assert.notEqual((await G.ensureOrderPickList(newer)).pickList.listedSettled, true);
});

/* ---------------- #86 path 2: price push quantity cap ---------------- */

test("pricePushQuantity: never more than Manapool lists right now, even if local listed is stale (#86)", () => {
  const G = setup();
  const r = receive(G, 4);
  r.listedQty = 2;               // stale: one sold since the last Fetch
  assert.equal(G.pricePushQuantity(KEY, 1), 1);
});

test("pricePushQuantity: never more than on hand minus copies sold to an open Manapool order (#86)", () => {
  const G = setup();
  receive(G, 2);
  sell(G, 1);
  assert.equal(G.pricePushQuantity(KEY, 2), 1, "Manapool says 2, but only 1 copy is really free");
  assert.equal(G.pricePushQuantity(KEY, 0), 0, "nothing listed stays nothing");
});

test("manapoolListingTotals: sums live card listings by identity, ignoring sealed", () => {
  const G = setup();
  const t = G.manapoolListingTotals([
    { kind: "card", scryfallId: "abc-123", lang: "EN", finish: "nonfoil", condition: "NM", quantity: 2 },
    { kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 1 },
    { kind: "sealed", tcgplayerProductId: "9", quantity: 5 }
  ]);
  assert.equal(t.get(KEY), 3);
  assert.equal(t.size, 1);
});

test("sealedPricePushQuantity: same cap for sealed product (#86)", () => {
  const G = setup();
  G.addSealedCopies({ tcgplayerProductId: "tcg-1", name: "Box", setCode: "fdn", locationId: "loc1", qty: 3, price: 100 });
  const pl = G.newPickList({ source: "manapool", orderId: "o-s" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, { kind: "sealed", tcgplayerProductId: "tcg-1", name: "Box", setCode: "fdn", qty: 1, unitPrice: 90 });
  const totals = G.manapoolSealedListingTotals([{ kind: "sealed", tcgplayerProductId: "tcg-1", quantity: 3 }]);
  assert.equal(G.sealedPricePushQuantity("tcg-1", totals.get("tcg-1")), 2);
});

/* ---------------- #89: two-bin push ---------------- */

test("applyManapoolPushToStacks: a confirmed push lands on the stacks the plan chose, and the plan settles (#89)", () => {
  const G = setup();
  G.state.locations[0].pickPriority = 10;
  G.state.locations[0].name = "HI";
  G.state.locations.push(G.newLocation({ id: "loc2", name: "LO", type: "bin", sellFrom: true, pickPriority: 1 }));
  G.state.settings.listingDefaultKeep = 2;
  const hi = receive(G, 2, "loc1", 4);
  const lo = receive(G, 2, "loc2", 5);

  // One listing in two bins: the listed pair comes from the higher pick
  // priority bin, whatever each stack's own price (#227).
  const plan = G.listingPlan();
  assert.deepEqual(JSON.parse(JSON.stringify(plan.map(p => [p.record.id, p.target]))), [[hi.id, 2]], "list from HI, keep the LO pair");

  const perStack = new Map([[hi.id, 2], [lo.id, 0]]);
  G.applyManapoolPushToStacks(KEY, perStack, 2, 2, "Manapool push");
  assert.equal(hi.listedQty, 2);
  assert.equal(lo.listedQty, 0);
  assert.equal(G.listingPlan().length, 0, "re-evaluating right after the push shows no changes");
});

test("applyManapoolPushToStacks: if Manapool confirms a different total, falls back to the greedy fill (#89)", () => {
  const G = setup();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "LO", type: "bin", sellFrom: true }));
  const a = receive(G, 2, "loc1");
  const b = receive(G, 2, "loc2");
  G.applyManapoolPushToStacks(KEY, new Map([[b.id, 2]]), 2, 3, "Manapool push");
  assert.equal(a.listedQty + b.listedQty, 3, "the local total still matches what Manapool confirmed");
});

test("applyManapoolPushToStacks: Manapool confirming 0 of the copies sent leaves nothing listed locally (#225)", () => {
  const G = setup();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "LO", type: "bin", sellFrom: true }));
  const a = receive(G, 2, "loc1");
  const b = receive(G, 2, "loc2");
  a.listedQty = 1;
  G.applyManapoolPushToStacks(KEY, new Map([[a.id, 2], [b.id, 1]]), 3, 0, "Manapool push");
  assert.equal(a.listedQty, 0, "not the 2 the push meant to list");
  assert.equal(b.listedQty, 0);
});

/* ---------------- #90: keep order ---------------- */

// #90 is about different printings of a card; within one listing, pick
// priority decides (#227, tests below).
test("listingPlan: keep holds back the cheapest copies and lists the dearest, across printings (#90)", () => {
  const G = setup();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "A", type: "bin", sellFrom: true, pickPriority: 9 }));
  G.state.settings.listingDefaultKeep = 1;
  const cheap = receive(G, 1, "loc2", 1);
  const dear = receive(G, 1, "loc1", 8, true);
  const plan = G.listingPlan({ includeUnchanged: true });
  const t = id => plan.find(p => p.record.id === id).target;
  assert.equal(t(cheap.id), 0);
  assert.equal(t(dear.id), 1);
});

test("listingPlan: an unpriced printing is kept, not listed first (#90)", () => {
  const G = setup();
  G.state.locations.push(G.newLocation({ id: "loc2", name: "B", type: "bin", sellFrom: true, pickPriority: 9 }));
  G.state.settings.listingDefaultKeep = 1;
  const priced = receive(G, 1, "loc1", 1);
  const unpriced = receive(G, 1, "loc2", null, true);
  const plan = G.listingPlan({ includeUnchanged: true });
  const t = id => plan.find(p => p.record.id === id).target;
  assert.equal(t(unpriced.id), 0, "Manapool won't list it without a price anyway");
  assert.equal(t(priced.id), 1);
});

/* ---------------- #86: no double-lower after a push ---------------- */

test("completePickList: after a price push confirmed Manapool's post-sale number, completing doesn't lower again (#86)", () => {
  const G = setup();
  const r = receive(G, 2);
  r.listedQty = 2;                       // stale: Manapool dropped to 1 when the order came in
  const pl = sell(G, 1);
  // Bulk Price push: live 1, free 1 -> sends 1, Manapool confirms 1.
  assert.equal(G.pricePushQuantity(KEY, 1), 1);
  G.applyManapoolQuantity(KEY, 1, "Manapool price push");
  assert.equal(r.listedQty, 1);
  G.completePickList(pl.id);
  assert.equal(r.quantity, 1);
  assert.equal(r.listedQty, 1, "Manapool still lists 1 of the 1 left - not 0");
});

test("completePickList: after a Listings push for that listing, completing doesn't lower again (#86, #89)", () => {
  const G = setup();
  const r = receive(G, 3);
  r.listedQty = 3;
  const pl = sell(G, 1);
  const [line] = G.listingPlan({ includeUnchanged: true });
  assert.equal(line.target, 2);
  G.applyManapoolPushToStacks(KEY, new Map([[r.id, 2]]), 2, 2, "Manapool push");
  G.completePickList(pl.id);
  assert.equal(r.quantity, 2);
  assert.equal(r.listedQty, 2);
});

test("completePickList: a push for a DIFFERENT listing doesn't stop this order's lowering (#86)", () => {
  const G = setup();
  const r = receive(G, 4);
  r.listedQty = 2;
  const other = G.addCopies({ set: "a25", num: "141", lang: "en", finish: "foil", condition: "NM",
    locationId: "loc1", qty: 1, info: INFO, action: "receipt", receiptId: "T2", note: "" });
  const pl = sell(G, 1);
  G.applyManapoolQuantity(G.manapoolIdentityKey(other), 1, "Manapool price push");
  assert.equal((pl.listedSettledKeys || []).length, 0, "the foil listing isn't one this order's lines draw from");
  G.completePickList(pl.id);
  assert.equal(r.listedQty, 1);
});

/* ---------------- #487: Evaluate's "Listed now" is what's on Manapool ---------------- */

test("listingPlan: a copy sold on an unpicked, unsettled order is already off Manapool - no row (#487)", () => {
  const G = setup();
  const r = receive(G, 1);
  r.listedQty = 1;
  sell(G, 1);
  const [line] = G.listingPlan({ includeUnchanged: true });
  assert.equal(line.listedNow, 0, "Manapool took the sold copy off the listing");
  assert.equal(line.delta, 0);
  assert.equal(G.listingPlan().length, 0);
});

test("listingPlan: Have 5, 1 sold, listed 5 (unsettled) needs no change (#487)", () => {
  const G = setup();
  const r = receive(G, 5);
  r.listedQty = 5;
  sell(G, 1);
  const [line] = G.listingPlan({ includeUnchanged: true });
  assert.equal(line.target, 4);
  assert.equal(line.listedNow, 4);
  assert.equal(G.listingPlan().length, 0);
});

test("listingPlan: a sold order with no pick list yet is also already off Manapool (#487)", () => {
  const G = setup();
  const r = receive(G, 1);
  r.listedQty = 1;
  G.setManapoolOrders([{ id: "o9", status: "pending", placedAt: "2026-11-14T10:00:00.000Z", lines: [Object.assign({}, LINE, { qty: 1 })] }]);
  assert.equal(G.listingPlan().length, 0);
});

test("listingPlan: a settled listing that Manapool lists above the free copies still shows down (#487)", () => {
  const G = setup();
  const r = receive(G, 3);
  r.listedQty = 3;
  const pl = sell(G, 1);
  pl.listedSettled = true; // Fetch listings since the order: 3 is Manapool's own number
  const [line] = G.listingPlan();
  assert.equal(line.listedNow, 3);
  assert.equal(line.delta, -1);
});

test("listingPlan: still no row after the pick list completes and listed drops (#487)", () => {
  const G = setup();
  const r = receive(G, 2);
  r.listedQty = 2;
  const pl = sell(G, 1);
  assert.equal(G.listingPlan().length, 0);
  G.completePickList(pl.id);
  assert.equal(r.listedQty, 1);
  assert.equal(G.listingPlan().length, 0);
});

test("listingPlan: after a push for that listing, an order with no pick list yet is not subtracted twice (#487)", () => {
  const G = setup();
  const r = receive(G, 3);
  r.listedQty = 3;
  G.setManapoolOrders([{ id: "o7", status: "pending", placedAt: "2020-01-01T00:00:00.000Z", lines: [Object.assign({}, LINE, { qty: 1 })] }]);
  assert.equal(G.listingPlan().length, 0, "before the push: 3 listed, 1 sold, 2 free");
  G.applyManapoolQuantity(KEY, 2, "Manapool price push"); // Manapool confirms 2, already without the sold copy
  const [line] = G.listingPlan({ includeUnchanged: true });
  assert.equal(line.listedNow, 2);
  assert.equal(line.delta, 0);
});

test("completePickList: a list made after a push for that listing doesn't lower listed again (#487)", async () => {
  const G = setup();
  const r = receive(G, 3);
  r.listedQty = 3;
  const order = { id: "o8", status: "pending", placedAt: "2020-01-01T00:00:00.000Z", lines: [Object.assign({}, LINE, { qty: 1 })] };
  G.applyManapoolQuantity(KEY, 2, "Manapool price push");
  assert.equal(r.listedQty, 2);
  const { pickList } = await G.ensureOrderPickList(order);
  assert.equal(pickList.listedSettledKeys.length, 1);
  G.completePickList(pickList.id);
  assert.equal(r.quantity, 2);
  assert.equal(r.listedQty, 2, "Manapool's number already excluded the sale");
});
