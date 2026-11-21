"use strict";
/* #194: copies in a location with "Sell from this location" off are never
   listed, but still count toward a rule's keep (owner, 2026-10-11).

   - listingPlan gives such a stack a target of 0 (so copies listed there now
     are planned down), and ranks its copies as the kept ones FIRST.
   - A forced rule (opts.ruleId) can't list from there either.
   - A Listings push never sends a not-sold-from stack's copies to Manapool,
     whether it was ticked or folded in as a sibling.
   - Spreading a Manapool listed number back onto local stacks (Fetch
     listings, a push Manapool confirmed differently) fills sell-from stacks
     first. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshCore } = require("../test-lib/core-shim");

const INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {}
};
const KEY = "abc-123|en|nonfoil|NM";
const LIVE = qty => [{ kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: qty }];

// The owner's own example: a personal binder (Sell from off) and a sell box.
function store() {
  const G = freshCore();
  G.state.locations.push(G.newLocation({ id: "pink", name: "Pink Binder", type: "binder", sellFrom: false }));
  G.state.locations.push(G.newLocation({ id: "box1", name: "SELL BOX 1", type: "box", sellFrom: true }));
  G.state.locations.push(G.newLocation({ id: "tray", name: "1. SORTING TRAY", type: "tray", sellFrom: false, staging: true }));
  return G;
}
// `other`: a second printing of the same card (a different Manapool listing).
const OTHER = Object.assign({}, INFO, { collector: "142", scryfallId: "def-456" });
function receive(G, qty, locationId, price, other) {
  const r = G.addCopies({ set: "a25", num: other ? "142" : "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId, qty, info: other ? OTHER : INFO, action: "receipt", receiptId: "T1", note: "" });
  if (price !== undefined) r.price = price;
  return r;
}
const targetOf = (plan, rec) => {
  const line = plan.find(p => p.record.id === rec.id);
  assert.ok(line, "a plan line for " + rec.locationId);
  return line.target;
};
const keepOne = G => {
  const rule = G.normalizeListingRule({ name: "Keep one", priority: 0, keep: 1 });
  G.state.listingRules = [rule];
  return rule;
};

/* ---------------- listingPlan ---------------- */

test("keep 1, one copy in Pink Binder and two in SELL BOX 1: the binder copy fills keep, both box copies are listed (#194)", () => {
  const G = store();
  keepOne(G);
  // The binder copy is the DEAREST, so without #194 the cheapest box copy
  // would have been kept and only one box copy listed.
  const binder = receive(G, 1, "pink", 9);
  const box = receive(G, 2, "box1", 1);
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(targetOf(plan, binder), 0);
  assert.equal(targetOf(plan, box), 2);
});

test("the binder copy still counts toward keep when the box copies are split across stacks (#194)", () => {
  const G = store();
  G.state.locations.push(G.newLocation({ id: "box2", name: "SELL BOX 2", type: "box", sellFrom: true }));
  keepOne(G);
  const binder = receive(G, 1, "pink", 9);
  const a = receive(G, 1, "box1", 1);
  const b = receive(G, 1, "box2", 2);
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(targetOf(plan, binder), 0);
  assert.equal(targetOf(plan, a) + targetOf(plan, b), 2, "keep is used up by the binder copy");
});

test("keep 3 with one binder copy: the binder uses one keep unit, the two cheapest box copies take the rest (#194)", () => {
  const G = store();
  G.state.locations.push(G.newLocation({ id: "box2", name: "SELL BOX 2", type: "box", sellFrom: true }));
  G.state.listingRules = [G.normalizeListingRule({ name: "Keep three", keep: 3 })];
  const binder = receive(G, 1, "pink", 9);
  const cheap = receive(G, 2, "box1", 1);
  const dear = receive(G, 2, "box2", 5, true);   // another printing: #90 is across printings
  const plan = G.listingPlan({ includeUnchanged: true });
  assert.equal(targetOf(plan, binder), 0);
  assert.equal(targetOf(plan, cheap), 0, "both cheap copies kept");
  assert.equal(targetOf(plan, dear), 2, "the dearest are listed");
});

test("a card whose only copies are in Sell-from-off locations gets no listing (#194)", () => {
  const G = store();
  receive(G, 1, "pink", 3);
  receive(G, 4, "tray", 3);
  assert.equal(G.listingPlan().length, 0, "keep 0, but nothing is offered for listing");
  const all = G.listingPlan({ includeUnchanged: true });
  assert.equal(all.length, 2);
  for (const line of all) {
    assert.equal(line.target, 0);
    assert.equal(line.sellFrom, false, "the row says why its target is 0");
  }
});

test("copies listed now from a Sell-from-off location are offered at 0, and the row reads sensibly (#194)", () => {
  const G = store();
  const tray = receive(G, 4, "tray", 3);
  tray.listedQty = 3;
  const box = receive(G, 1, "box1", 3);
  box.listedQty = 1;
  const plan = G.listingPlan();
  assert.equal(plan.length, 1, "the box line already matches");
  const [line] = plan;
  assert.equal(line.record.id, tray.id);
  assert.equal(line.target, 0);
  assert.equal(line.delta, -3);
  assert.equal(line.listedNow, 3);
  assert.equal(line.have, 4);
  assert.equal(line.reserved, 0, "nothing sold there");
  assert.equal(line.available, 4, "all four still count toward keep");
  assert.equal(line.sellFrom, false);
  const boxLine = G.listingPlan({ includeUnchanged: true }).find(p => p.record.id === box.id);
  assert.equal(boxLine.sellFrom, true);
});

test("Evaluate never proposes a positive target for a Sell-from-off stack, whatever keep says (#194)", () => {
  const G = store();
  const tray = receive(G, 50, "tray", 20);
  const binder = receive(G, 5, "pink", 20);
  const box = receive(G, 1, "box1", 20);
  for (const line of G.listingPlan({ includeUnchanged: true })) {
    if (line.record.id !== box.id) assert.equal(line.target, 0, line.record.locationId);
  }
  assert.equal(targetOf(G.listingPlan({ includeUnchanged: true }), box), 1);
  assert.ok(tray && binder);
});

test("a forced rule (Evaluate with one rule) can't list from a Sell-from-off location either (#194)", () => {
  const G = store();
  const rule = keepOne(G);
  rule.on = false;   // forcing it is the deliberate override for the on/off toggle, not for Sell from
  const binder = receive(G, 1, "pink", 9);
  const tray = receive(G, 3, "tray", 9);
  const box = receive(G, 2, "box1", 1);
  const plan = G.listingPlan({ includeUnchanged: true, ruleId: rule.id });
  assert.equal(targetOf(plan, binder), 0);
  assert.equal(targetOf(plan, tray), 0);
  assert.equal(targetOf(plan, box), 2, "keep 1 is filled by the off-location copies");
});

test("a stack whose location no longer exists is not listed, the same as Manapool order picking (#194)", () => {
  const G = store();
  const r = receive(G, 2, "box1", 1);
  G.state.locations = G.state.locations.filter(l => l.id !== "box1");
  assert.equal(targetOf(G.listingPlan({ includeUnchanged: true }), r), 0);
});

test("applyListingPlan: a stale line for a location switched to Sell from off lists nothing (#194)", () => {
  const G = store();
  const r = receive(G, 3, "box1", 1);
  const [line] = G.listingPlan();
  assert.equal(line.target, 3);
  G.state.locations.find(l => l.id === "box1").sellFrom = false;
  G.applyListingPlan([line], "test");
  assert.equal(r.listedQty || 0, 0);
});

/* ---------------- Push ---------------- */

test("push: a Sell-from-off sibling's listed copies are never sent to Manapool, and are recorded as 0 (#194)", () => {
  const G = store();
  const tray = receive(G, 4, "tray", 2);
  tray.listedQty = 3;            // listed from the tray before #194
  const box = receive(G, 3, "box1", 2);
  box.listedQty = 1;
  // Tick only the box line (keep 0 lists all 3 box copies).
  const boxLine = G.listingPlan().find(p => p.record.id === box.id);
  assert.equal(boxLine.target, 3);
  const groups = G.manapoolPushGroups([boxLine]);
  const g = groups.get(KEY);
  assert.equal(g.targetSum, 3, "only the box copies go up");
  assert.equal(g.perStack.get(box.id), 3);
  assert.equal(g.perStack.get(tray.id), 0, "the tray's copies come off Manapool with this push");

  // Manapool confirms what was sent: local matches, and Evaluate settles.
  G.applyManapoolPushToStacks(KEY, g.perStack, g.targetSum, 3, "Manapool push");
  assert.equal(box.listedQty, 3);
  assert.equal(tray.listedQty, 0);
  assert.equal(G.listingPlan().length, 0, "Evaluate settles");
});

test("push: a ticked Sell-from-off line sends 0 even from a stale plan (#194)", () => {
  const G = store();
  const binder = receive(G, 2, "pink", 2);
  const groups = G.manapoolPushGroups([{ record: binder, target: 2, rule: null }]);
  assert.equal(groups.get(KEY).targetSum, 0);
  assert.equal(groups.get(KEY).perStack.get(binder.id), 0);
});

test("push: a rule that matches the binder still doesn't fold the binder's copies in (#194)", () => {
  const G = store();
  keepOne(G);   // catch-all rule: matches every location
  const binder = receive(G, 1, "pink", 9);
  binder.listedQty = 1;
  const box = receive(G, 2, "box1", 1);
  const boxLine = G.listingPlan().find(p => p.record.id === box.id);
  const g = G.manapoolPushGroups([boxLine]).get(KEY);
  assert.equal(g.perStack.get(binder.id), 0);
  assert.equal(g.targetSum, 2);
});

test("push: a sell-from sibling's listed copies are still folded in (#89 unchanged)", () => {
  const G = store();
  G.state.locations.push(G.newLocation({ id: "box2", name: "SELL BOX 2", type: "box", sellFrom: true }));
  const a = receive(G, 2, "box1", 1);
  const b = receive(G, 2, "box2", 1);
  b.listedQty = 2;
  const g = G.manapoolPushGroups([{ record: a, target: 2, rule: null }]).get(KEY);
  assert.equal(g.perStack.get(b.id), 2);
  assert.equal(g.targetSum, 4);
});

/* ---------------- Spreading a Manapool number back ---------------- */

test("Fetch listings puts Manapool's number on sell-from stacks first, even ahead of a higher pick priority (#194)", () => {
  const G = store();
  G.state.locations.find(l => l.id === "tray").pickPriority = 99;   // would be filled first before #194
  const tray = receive(G, 4, "tray", 2);
  const box = receive(G, 2, "box1", 2);
  G.syncManapoolListings(LIVE(2));
  assert.equal(box.listedQty, 2);
  assert.equal(tray.listedQty, 0);
});

test("Fetch listings puts only the overflow on a Sell-from-off stack, and Evaluate offers to take it down (#194)", () => {
  const G = store();
  const tray = receive(G, 4, "tray", 2);
  const box = receive(G, 2, "box1", 2);
  G.syncManapoolListings(LIVE(3));
  assert.equal(box.listedQty, 2);
  assert.equal(tray.listedQty, 1, "nowhere else to put the third copy");
  const [line] = G.listingPlan();
  assert.equal(line.record.id, tray.id);
  assert.equal(line.target, 0);
});

test("a push Manapool confirms differently falls back to the same sell-from-first fill (#194)", () => {
  const G = store();
  G.state.locations.find(l => l.id === "pink").pickPriority = 99;
  const binder = receive(G, 2, "pink", 2);
  const box = receive(G, 3, "box1", 2);
  G.applyManapoolPushToStacks(KEY, new Map([[box.id, 2], [binder.id, 0]]), 2, 3, "Manapool push");
  assert.equal(box.listedQty, 3);
  assert.equal(binder.listedQty || 0, 0);
});

test("copies sold to an open Manapool order still go last, after Sell-from-off stacks (#86, #194)", () => {
  const G = store();
  const box = receive(G, 2, "box1", 2);
  const tray = receive(G, 1, "tray", 2);
  const pl = G.newPickList({ source: "manapool", orderId: "o-1" });
  G.pickLists().push(pl);
  G.addToPickList(pl.id, { kind: "card", set: "a25", collector: "141", lang: "en", finish: "nonfoil",
    condition: "NM", name: "Lightning Bolt", qty: 1, unitPrice: 1 });
  G.syncManapoolListings(LIVE(2));
  assert.equal(box.listedQty, 1, "the box's one free copy");
  assert.equal(tray.listedQty, 1, "then the tray, before the sold copy");
});

/* ---------------- Inventory -> Storefront + / - (#194 review) ---------------- */

test("Storefront +: a card whose only copies are in Sell-from-off locations is refused, nothing to send (#194)", () => {
  const G = store();
  receive(G, 1, "pink", 3);
  receive(G, 4, "tray", 3);
  const plan = G.storefrontListedPush(KEY, 1);
  assert.equal(plan.refused, "noSellFrom");
  assert.equal(plan.name, "Lightning Bolt", "for the message");
  assert.equal(plan.perStack, undefined, "no push is built");
  assert.equal(plan.offTakenDown, 0, "nothing listed there, so no take-down hint (#204)");
});

test("Storefront +: the refusal carries the count still listed from off locations, and the toast names it (#204)", () => {
  const G = store();
  const a = receive(G, 1, "pink", 3);
  a.listedQty = 2;
  const plan = G.storefrontListedPush(KEY, 1);
  assert.equal(plan.refused, "noSellFrom");
  assert.equal(plan.offTakenDown, 2);
  const ui = fs.readFileSync(path.join(__dirname, "../public/js/ui.js"), "utf8");
  assert.match(ui, /Press \\u2212 to take down the " \+ plan\.offTakenDown \+ " listed there\./);
});

test("Storefront +: with the off location sorting first, the copy is listed from the sell-from stack (#194)", () => {
  const G = store();
  G.state.locations.find(l => l.id === "tray").pickPriority = 99;   // "1. SORTING TRAY" also sorts first by name
  const tray = receive(G, 4, "tray", 2);
  const box = receive(G, 2, "box1", 2);
  const plan = G.storefrontListedPush(KEY, 1);
  assert.equal(plan.sample.id, box.id);
  assert.equal(plan.quantity, 1);
  assert.equal(plan.perStack.get(box.id), 1);
  assert.equal(plan.perStack.get(tray.id), 0);
  G.applyManapoolPushToStacks(KEY, plan.perStack, plan.quantity, 1, "Manapool push");
  assert.equal(box.listedQty, 1);
  assert.equal(tray.listedQty || 0, 0);
});

test("Storefront +: copies listed from an off location come down with the push and are reported (#194)", () => {
  const G = store();
  const tray = receive(G, 4, "tray", 2);
  tray.listedQty = 3;
  receive(G, 2, "box1", 2);
  const plan = G.storefrontListedPush(KEY, 1);
  assert.equal(plan.quantity, 1, "only the box copy goes up");
  assert.equal(plan.perStack.get(tray.id), 0);
  assert.equal(plan.offTakenDown, 3);
});

test("Storefront +: fills the next sell-from stack once the first is fully listed", () => {
  const G = store();
  G.state.locations.push(G.newLocation({ id: "box2", name: "SELL BOX 2", type: "box", sellFrom: true }));
  const a = receive(G, 1, "box1", 2);
  a.listedQty = 1;
  const b = receive(G, 1, "box2", 2);
  const plan = G.storefrontListedPush(KEY, 1);
  assert.equal(plan.quantity, 2);
  assert.equal(plan.perStack.get(a.id), 1);
  assert.equal(plan.perStack.get(b.id), 1);
});

test("Storefront -: takes down copies listed from off locations first, then one sell-from copy at a time (#194)", () => {
  const G = store();
  const tray = receive(G, 4, "tray", 2);
  tray.listedQty = 3;
  const box = receive(G, 2, "box1", 2);
  box.listedQty = 2;
  let plan = G.storefrontListedPush(KEY, -1);
  assert.equal(plan.offTakenDown, 3);
  assert.equal(plan.quantity, 2, "the box copies stay up");
  assert.equal(plan.perStack.get(tray.id), 0);
  G.applyManapoolPushToStacks(KEY, plan.perStack, plan.quantity, plan.quantity, "Manapool push");
  assert.equal(tray.listedQty, 0);
  plan = G.storefrontListedPush(KEY, -1);
  assert.equal(plan.offTakenDown, 0);
  assert.equal(plan.quantity, 1);
  assert.equal(plan.perStack.get(box.id), 1);
});

test("Storefront -: still works when every copy is in an off location (#194)", () => {
  const G = store();
  const tray = receive(G, 4, "tray", 2);
  tray.listedQty = 2;
  const plan = G.storefrontListedPush(KEY, -1);
  assert.equal(plan.refused, undefined);
  assert.equal(plan.quantity, 0);
  assert.equal(plan.perStack.get(tray.id), 0);
  G.applyManapoolPushToStacks(KEY, plan.perStack, 0, 0, "Manapool push");
  assert.equal(tray.listedQty, 0);
});
