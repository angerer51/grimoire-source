"use strict";
/* public/js/core.js - merging two customers into one (#196): "Merging
   customers" in core.js. The customer kept gains the other's orders, wants,
   matches and note; the other is removed and remembered as an alias
   (customerAliases) so an order sync routes that buyer to the customer kept
   and never recreates them, and a second tab that hadn't seen the merge
   can't undo it through server/lib/merge.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore, freshCoreSandbox } = require("../test-lib/core-shim");
const mergeLib = require("../server/lib/merge");

const plain = x => JSON.parse(JSON.stringify(x));
const order = (id, buyerId, name, total) => ({
  id, buyerId, buyer: name, label: "L-" + id, total: total == null ? 10 : total,
  placedAt: "2026-09-" + String(10 + Number(id.replace(/\D/g, "") || 0)).padStart(2, "0") + "T00:00:00Z",
  ship: { name, line1: "1 Secret St" }
});
const ids = G => plain(G.state.customers.map(c => c.id)).sort();
const byId = (G, id) => G.state.customers.find(c => c.id === id);
const CUSTOMER_ARRAYS = ["customers", "customerWants", "restockMatches", "customerTombstones", "customerAliases"];
const doc = G => plain(Object.fromEntries(CUSTOMER_ARRAYS.map(k => [k, G.state[k]])));
// A tab: a fresh core that adopted `d` (adoptState runs tidyCustomers, as
// a page load or a merged save does).
function tab(d) {
  const G = freshCore();
  G.adoptState(Object.assign({ cards: [], locations: [] }, plain(d)));
  return G;
}

// Dana has two Manapool accounts (b1, b2).
function twoDanas() {
  const G = freshCore();
  G.syncCustomersFromOrders([order("o1", "b1", "Dana Reyes", 20), order("o2", "b2", "D Reyes", 5),
    order("o3", "b1", "Dana Reyes", 7)]);
  return G;
}

/* ---------------- the merge itself ---------------- */

test("merge: the kept customer gains the other's orders, wants, matches and note; the other is gone", () => {
  const G = twoDanas();
  G.updateCustomer("mp-b1", { note: "regular" });
  G.updateCustomer("mp-b2", { note: "plays Mardu" });
  const w1 = G.addWant("mp-b2", { name: "Ragavan, Nimble Pilferer" });
  G.state.restockMatches.push(G.normalizeRestockMatch({ id: "m1", customerId: "mp-b2", wantId: w1.id, name: w1.name }));
  const keep = G.mergeCustomers("mp-b2", "mp-b1");
  assert.equal(keep.id, "mp-b1");
  assert.deepEqual(ids(G), ["mp-b1"]);
  assert.equal(keep.name, "Dana Reyes", "keeps its own name");
  assert.equal(keep.note, "regular · plays Mardu", "the other's note is appended");
  assert.deepEqual(plain(keep.orderRefs.map(r => r.id)), ["o1", "o3", "o2"]);
  assert.equal(G.state.customerWants[0].customerId, "mp-b1");
  assert.equal(G.state.restockMatches[0].customerId, "mp-b1");
  assert.deepEqual(plain(G.state.customerAliases.map(a => [a.id, a.keepId, a.buyerId, a.mpName])),
    [["mp-b2", "mp-b1", "b2", "D Reyes"]]);
  assert.equal(G.tidyCustomers(), false, "a clean merge leaves nothing to tidy");
});

test("merge: lifetime spend and the order list cover both buyers' orders", () => {
  const G = twoDanas();
  const cache = [order("o1", "b1", "Dana Reyes", 20), order("o2", "b2", "D Reyes", 5), order("o3", "b1", "Dana Reyes", 7)];
  G.state.returns.push({ orderId: "o2", refundTotal: 2 });
  const keep = G.mergeCustomers("mp-b2", "mp-b1");
  const h = G.customerOrders(keep, cache);
  assert.equal(h.count, 3);
  assert.equal(h.total, 32);
  assert.equal(h.refunds, 2, "a refund on the merged-away buyer's order comes off too");
  assert.equal(h.spend, 30);
  assert.deepEqual(plain(h.list.map(o => o.id)), ["o3", "o2", "o1"], "newest first, both buyers");
});

test("merge: an empty name or email is filled from the other; consent only comes with its own address", () => {
  const G = twoDanas();
  G.updateCustomer("mp-b2", { email: "dana@example.com", emailOk: true });
  const okAt = byId(G, "mp-b2").emailOkAt;
  G.state.customers.find(c => c.id === "mp-b1").name = "";
  const keep = G.mergeCustomers("mp-b2", "mp-b1");
  assert.equal(keep.name, "D Reyes");
  assert.equal(keep.email, "dana@example.com");
  assert.equal(keep.emailOk, true, "the address came over, so its consent did");
  assert.equal(keep.emailOkAt, okAt, "with its original time, not a new one");

  const H = twoDanas();
  H.updateCustomer("mp-b1", { email: "kept@example.com" });          // no consent
  H.updateCustomer("mp-b2", { email: "other@example.com", emailOk: true });
  const k2 = H.mergeCustomers("mp-b2", "mp-b1");
  assert.equal(k2.email, "kept@example.com", "keeps its own email");
  assert.equal(k2.emailOk, false, "the other address's consent is not invented for this one");
  assert.equal(k2.emailOkAt, null);

  const I = twoDanas();
  I.updateCustomer("mp-b2", { email: "other@example.com" });          // address, no consent
  const k3 = I.mergeCustomers("mp-b2", "mp-b1");
  assert.equal(k3.email, "other@example.com");
  assert.equal(k3.emailOk, false);
});

test("merge: identical wants fold into one (note kept), different printings stay apart, one untold match per want", () => {
  const G = twoDanas();
  const kAny = G.addWant("mp-b1", { name: "Ragavan, Nimble Pilferer" });
  const gAny = G.addWant("mp-b2", { name: "ragavan, nimble pilferer", note: "any copy" });
  const kFoil = G.addWant("mp-b1", { name: "Ragavan, Nimble Pilferer", set: "mh2", collector: "138", finish: "foil" });
  const gNonfoil = G.addWant("mp-b2", { name: "Ragavan, Nimble Pilferer", set: "MH2", collector: "138", finish: "nonfoil" });
  const gFoil = G.addWant("mp-b2", { name: "Ragavan, Nimble Pilferer", set: "mh2", collector: "138", finish: "foil" });
  const m = (id, customerId, wantId, toldAt) =>
    G.normalizeRestockMatch({ id, customerId, wantId, name: "Ragavan, Nimble Pilferer", toldAt: toldAt || null });
  G.state.restockMatches.push(m("mk", "mp-b1", kAny.id), m("mg", "mp-b2", gAny.id),
    m("mgTold", "mp-b2", gAny.id, "2026-10-01T00:00:00Z"), m("mgFoil", "mp-b2", gFoil.id));
  G.mergeCustomers("mp-b2", "mp-b1");
  const wants = G.state.customerWants;
  assert.deepEqual(plain(wants.map(w => w.id).sort()), [kAny.id, kFoil.id, gNonfoil.id].sort());
  assert.ok(wants.every(w => w.customerId === "mp-b1"));
  assert.equal(wants.find(w => w.id === kAny.id).note, "any copy", "the folded want's note fills an empty one");
  const matches = G.state.restockMatches;
  assert.ok(!matches.some(x => x.id === "mg"), "the kept want already had an untold match: no second row");
  assert.equal(matches.find(x => x.id === "mgTold").wantId, kAny.id, "told history moves to the kept want");
  assert.equal(matches.find(x => x.id === "mgFoil").wantId, kFoil.id, "the only untold match on that printing moves over");
  assert.ok(matches.every(x => x.customerId === "mp-b1"));
});

test("merge: hand-added into Manapool and Manapool into hand-added both work", () => {
  const G = twoDanas();
  const walkIn = G.addCustomer({ name: "Dana (walk-in)", email: "d@example.com", emailOk: true });
  G.addWant(walkIn.id, { name: "Sol Ring" });
  const keep = G.mergeCustomers(walkIn.id, "mp-b1");
  assert.equal(keep.source, "manapool");
  assert.equal(keep.email, "d@example.com");
  assert.equal(keep.emailOk, true);
  assert.equal(G.state.customerWants[0].customerId, "mp-b1");

  const H = twoDanas();
  const shop = H.addCustomer({ name: "Dana at the shop" });
  const k2 = H.mergeCustomers("mp-b2", shop.id);
  assert.equal(k2.id, shop.id);
  assert.equal(k2.source, "manual");
  assert.equal(k2.name, "Dana at the shop");
  assert.deepEqual(plain(k2.orderRefs.map(r => r.id)), ["o2"]);
  // Her next Manapool order (and a name-only one) lands on the hand-added customer.
  const r = H.syncCustomersFromOrders([order("o5", "b2", "D Reyes"), order("o6", "", "D Reyes")]);
  assert.deepEqual(plain(r), { created: 0, linked: 2 });
  assert.deepEqual(plain(k2.orderRefs.map(r => r.id)), ["o2", "o5", "o6"]);
  assert.deepEqual(ids(H).sort(), ["mp-b1", shop.id].sort());
});

test("merge: refuses itself or a customer that isn't there", () => {
  const G = twoDanas();
  assert.equal(G.mergeCustomers("mp-b1", "mp-b1"), null);
  assert.equal(G.mergeCustomers("nope", "mp-b1"), null);
  assert.equal(G.mergeCustomers("mp-b1", "nope"), null);
  assert.equal(G.state.customers.length, 2);
  assert.equal(G.state.customerAliases.length, 0);
});

/* ---------------- order sync after a merge ---------------- */

test("sync after a merge: the merged buyer's new orders go to the kept customer, never a new one", () => {
  const G = twoDanas();
  G.mergeCustomers("mp-b2", "mp-b1");
  const all = [order("o1", "b1", "Dana Reyes"), order("o2", "b2", "D Reyes"), order("o3", "b1", "Dana Reyes"),
    order("o4", "b2", "D Reyes"), order("o7", "", "d reyes")];
  const r = G.syncCustomersFromOrders(all);
  assert.deepEqual(plain(r), { created: 0, linked: 2 }, "o4 by buyer id, o7 by the merged buyer's name");
  assert.deepEqual(ids(G), ["mp-b1"]);
  assert.deepEqual(plain(byId(G, "mp-b1").orderRefs.map(x => [x.id, x.by])),
    [["o1", "buyer"], ["o3", "buyer"], ["o2", "buyer"], ["o4", "buyer"], ["o7", "name"]]);
  assert.deepEqual(plain(G.syncCustomersFromOrders(all)), { created: 0, linked: 0 }, "idempotent");
});

test("a chain of merges (b2 into b1, then b1 into a walk-in) routes both buyers to the last one kept", () => {
  const G = twoDanas();
  const walkIn = G.addCustomer({ name: "Dana" });
  G.mergeCustomers("mp-b2", "mp-b1");
  G.mergeCustomers("mp-b1", walkIn.id);
  assert.deepEqual(plain(G.state.customerAliases.map(a => [a.id, a.keepId]).sort()),
    [["mp-b1", walkIn.id], ["mp-b2", walkIn.id]]);
  const r = G.syncCustomersFromOrders([order("o8", "b1", "Dana Reyes"), order("o9", "b2", "D Reyes")]);
  assert.deepEqual(plain(r), { created: 0, linked: 2 });
  assert.deepEqual(plain(walkIn.orderRefs.map(x => x.id)), ["o1", "o3", "o2", "o8", "o9"]);
});

test("deleting the kept customer deletes the merged one too: neither comes back from orders", () => {
  const G = twoDanas();
  G.mergeCustomers("mp-b2", "mp-b1");
  G.deleteCustomer("mp-b1");
  assert.equal(G.state.customers.length, 0);
  assert.equal(G.state.customerAliases.length, 0);
  assert.deepEqual(plain(G.state.customerTombstones.map(t => t.buyerId).sort()), ["b1", "b2"]);
  assert.ok(!JSON.stringify(G.state.customerTombstones).includes("Reyes"), "tombstones hold no name");
  const r = G.syncCustomersFromOrders([order("o1", "b1", "Dana Reyes"), order("o2", "b2", "D Reyes"),
    order("o5", "b2", "D Reyes")]);
  assert.deepEqual(plain(r), { created: 0, linked: 0 });
});

test("undo straight after a merge brings both customers back as they were", () => {
  const G = twoDanas();
  G.addWant("mp-b2", { name: "Sol Ring" });
  G.persist("Add want");
  G.mergeCustomers("mp-b2", "mp-b1");
  G.persist("Merge customers");
  assert.deepEqual(ids(G), ["mp-b1"]);
  G.undo();
  assert.deepEqual(ids(G), ["mp-b1", "mp-b2"]);
  assert.equal(G.state.customerAliases.length, 0);
  assert.equal(G.state.customerWants[0].customerId, "mp-b2");
  assert.deepEqual(plain(byId(G, "mp-b1").orderRefs.map(r => r.id)), ["o1", "o3"]);
});

test("a merge writes nothing to the audit log", async () => {
  const G = freshCore({ fetch: async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ entries: [], total: 0 }), json: async () => ({ entries: [], total: 0 }) }) });
  G.syncCustomersFromOrders([order("o1", "b1", "Dana Reyes"), order("o2", "b2", "D Reyes")]);
  G.persist("Customers from orders");
  G.mergeCustomers("mp-b2", "mp-b1");
  G.persist("Merge customers");
  const { entries } = await G.queryAudit({});
  assert.equal(entries.length, 0);
  const label = String(G.undoInfo().undoLabel || "");
  assert.match(label, /Merge customers/);
  assert.doesNotMatch(label, /Dana|Reyes/, "the undo label is generic, never a name");
});

/* ---------------- two tabs, through server/lib/merge.js ----------------
   Tab A merges mp-b2 into mp-b1. Tab B, still on the document from before
   the merge, does something to mp-b2. Each case is run both ways round (B
   saved first, or A first), since merge.js's tiebreak favours whichever
   is already on disk. */

function race(bAction) {
  const base = twoDanas();
  base.addWant("mp-b2", { name: "Sol Ring", note: "for the cube" });
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers("mp-b2", "mp-b1");
  bAction(b);
  const results = [];
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const { merged } = mergeLib.merge(baseDoc, doc(mine), doc(theirs));
    results.push(tab(merged));   // what the next page load or merged save adopts
  }
  return results;
}

test("two tabs: B links a new order to the merged-away buyer -> one customer, holding it", () => {
  for (const G of race(b => b.syncCustomersFromOrders([order("o4", "b2", "D Reyes")]))) {
    assert.deepEqual(ids(G), ["mp-b1"], "mp-b2 not resurrected");
    assert.deepEqual(plain(byId(G, "mp-b1").orderRefs.map(r => r.id).sort()), ["o1", "o2", "o3", "o4"]);
    assert.ok(G.state.customerWants.every(w => w.customerId === "mp-b1"));
    assert.equal(G.state.customerWants.length, 1);
    assert.deepEqual(plain(G.syncCustomersFromOrders([order("o4", "b2", "D Reyes"), order("o5", "b2", "D Reyes")])),
      { created: 0, linked: 1 });
    assert.equal(G.tidyCustomers(), false, "settled");
  }
});

test("two tabs: B adds a want to the merged-away customer -> the want moves to the kept one", () => {
  for (const G of race(b => b.addWant("mp-b2", { name: "Ragavan, Nimble Pilferer" }))) {
    assert.deepEqual(ids(G), ["mp-b1"]);
    assert.deepEqual(plain(G.state.customerWants.map(w => [w.name, w.customerId]).sort()),
      [["Ragavan, Nimble Pilferer", "mp-b1"], ["Sol Ring", "mp-b1"]], "not orphaned, not dropped");
  }
});

test("two tabs: B adds the same want the merge already moved -> folded into one", () => {
  for (const G of race(b => b.addWant("mp-b2", { name: "Sol Ring" }))) {
    assert.deepEqual(plain(G.state.customerWants.map(w => [w.name, w.customerId, w.note])),
      [["Sol Ring", "mp-b1", "for the cube"]]);
  }
});

test("two tabs: B edits the merged-away customer's note -> folded back, the note not doubled", () => {
  for (const G of race(b => b.updateCustomer("mp-b2", { note: "pays cash" }))) {
    assert.deepEqual(ids(G), ["mp-b1"]);
    assert.equal(byId(G, "mp-b1").note, "pays cash");
  }
  const base = twoDanas();
  base.updateCustomer("mp-b2", { note: "plays Mardu" });
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers("mp-b2", "mp-b1");
  b.syncCustomersFromOrders([order("o4", "b2", "D Reyes")]);
  const G = tab(mergeLib.merge(baseDoc, doc(b), doc(a)).merged);
  assert.equal(byId(G, "mp-b1").note, "plays Mardu", "appended once by the merge, not again by the fold");
});

test("two tabs: two different customers merged into the same one at once -> both stay merged", () => {
  const base = twoDanas();
  base.syncCustomersFromOrders([order("o6", "b3", "Dana R")]);
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers("mp-b2", "mp-b1");
  b.mergeCustomers("mp-b3", "mp-b1");
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const G = tab(mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged);
    assert.deepEqual(ids(G), ["mp-b1"]);
    assert.equal(G.state.customerAliases.length, 2, "both aliases survive the merge");
    // mp-b1's order list was edited by both tabs (theirs wins that field);
    // the next sync links whatever the losing side had added, to mp-b1.
    G.syncCustomersFromOrders([order("o1", "b1", "Dana Reyes"), order("o2", "b2", "D Reyes"),
      order("o3", "b1", "Dana Reyes"), order("o6", "b3", "Dana R")]);
    assert.deepEqual(ids(G), ["mp-b1"]);
    assert.deepEqual(plain(byId(G, "mp-b1").orderRefs.map(r => r.id).sort()), ["o1", "o2", "o3", "o6"]);
  }
});

test("two tabs: merged both ways (b2 into b1 here, b1 into b2 there) -> one customer with everything", () => {
  const base = twoDanas();
  base.addWant("mp-b1", { name: "Sol Ring" });
  base.addWant("mp-b2", { name: "Mana Crypt" });
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers("mp-b2", "mp-b1");
  b.mergeCustomers("mp-b1", "mp-b2");
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const G = tab(mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged);
    assert.equal(G.state.customers.length, 1);
    const c = G.state.customers[0];
    assert.deepEqual(plain(c.orderRefs.map(r => r.id).sort()), ["o1", "o2", "o3"]);
    assert.deepEqual(plain(G.state.customerWants.map(w => [w.name, w.customerId]).sort()),
      [["Mana Crypt", c.id], ["Sol Ring", c.id]]);
    assert.deepEqual(plain(G.state.customerAliases.map(a => a.keepId)), [c.id], "no alias loop left behind");
    assert.equal(G.syncCustomersFromOrders([order("o8", "b1", "x"), order("o9", "b2", "y")]).created, 0);
    assert.equal(G.tidyCustomers(), false);
  }
});

test("a tab on an older core.js recreates the merged buyer from an order -> folded back on the next load", () => {
  const G = twoDanas();
  G.addWant("mp-b2", { name: "Sol Ring" });
  G.mergeCustomers("mp-b2", "mp-b1");
  const d = doc(G);
  // What an old sync would do: no alias index, so a fresh mp-b2 with o4.
  d.customers.push(plain(G.normalizeCustomer({ id: "mp-b2", name: "D Reyes", source: "manapool", buyerId: "b2",
    mpName: "D Reyes", orderRefs: [{ id: "o4" }] })));
  const H = tab(d);
  assert.deepEqual(ids(H), ["mp-b1"]);
  assert.deepEqual(plain(byId(H, "mp-b1").orderRefs.map(r => r.id)), ["o1", "o3", "o2", "o4"]);
});

test("an alias whose kept customer is gone is dropped, and that buyer can come back as a customer", () => {
  const G = twoDanas();
  G.mergeCustomers("mp-b2", "mp-b1");
  const d = doc(G);
  d.customers = d.customers.filter(c => c.id !== "mp-b1");   // deleted elsewhere, with no tombstone for b2
  const H = tab(d);
  assert.equal(H.state.customerAliases.length, 0);
  assert.equal(H.syncCustomersFromOrders([order("o4", "b2", "D Reyes")]).created, 1);
});

/* ---------------- review round 1 ---------------- */

// Two walk-ins with no orders and no note: the merge brings nothing onto
// the kept record but wants, which live in their own array.
function twoWalkIns() {
  const G = freshCore();
  const mike = G.addCustomer({ name: "Mike Long" });
  const michael = G.addCustomer({ name: "Michael Long" });
  G.addWant(mike.id, { name: "Sol Ring" });
  G.addWant(michael.id, { name: "Mana Crypt" });
  return { G, mike: mike.id, michael: michael.id };
}

test("every merge edits the kept customer (mergedAt), even when the other brings nothing onto it", () => {
  const { G, mike, michael } = twoWalkIns();
  const before = JSON.stringify(byId(G, mike));
  G.mergeCustomers(michael, mike);
  assert.notEqual(JSON.stringify(byId(G, mike)), before);
  assert.ok(byId(G, mike).mergedAt);
  assert.equal(G.normalizeCustomer(plain(byId(G, mike))).mergedAt, byId(G, mike).mergedAt, "kept by normalizeCustomer");
});

test("two tabs: two walk-ins merged opposite ways -> one customer with both wants, either save order", () => {
  const { G: base, mike, michael } = twoWalkIns();
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers(michael, mike);
  b.mergeCustomers(mike, michael);
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const G = tab(mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged);
    assert.equal(G.state.customers.length, 1, "not both deleted");
    const c = G.state.customers[0];
    assert.ok([mike, michael].includes(c.id));
    assert.deepEqual(plain(G.state.customerWants.map(w => [w.name, w.customerId]).sort()),
      [["Mana Crypt", c.id], ["Sol Ring", c.id]]);
    assert.deepEqual(plain(G.state.customerAliases.map(x => x.keepId)), [c.id]);
    assert.equal(G.tidyCustomers(), false);
  }
});

test("two tabs: a stale tab deletes the kept customer while the merge lands -> the merged-in customer's wants survive", () => {
  const { G: base, mike, michael } = twoWalkIns();
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers(michael, mike);   // Michael into Mike
  b.deleteCustomer(mike);            // the other tab, never having seen that, deletes Mike
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const G = tab(mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged);
    assert.deepEqual(ids(G), [mike], "the merge (an edit to Mike) beats the stale delete");
    assert.deepEqual(plain(G.state.customerWants.map(w => [w.name, w.customerId])), [["Mana Crypt", mike]],
      "Michael's want, moved by the merge, is kept; Mike's own want went with the delete");
  }
});

test("tidy follows a chain folded in one pass (X into Y, then Y into Z): X's new want reaches Z, in any customer order", () => {
  const base = freshCore();
  base.syncCustomersFromOrders([order("o1", "x", "Xena"), order("o2", "y", "Yuri"), order("o3", "z", "Zed")]);
  base.addWant("mp-y", { name: "Old want" });
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers("mp-x", "mp-y");
  b.syncCustomersFromOrders([order("o4", "x", "Xena")]);   // mp-x edited: it comes back
  b.addWant("mp-x", { name: "New want from tab B" });
  b.mergeCustomers("mp-y", "mp-z");
  const orders = [["mp-x", "mp-y", "mp-z"], ["mp-y", "mp-x", "mp-z"], ["mp-z", "mp-y", "mp-x"], ["mp-x", "mp-z", "mp-y"]];
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const merged = mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged;
    for (const seq of orders) {
      const d = plain(merged);
      d.customers.sort((p, q) => seq.indexOf(p.id) - seq.indexOf(q.id));
      const G = tab(d);
      const at = seq.join(",");
      assert.deepEqual(ids(G), ["mp-z"], at);
      assert.deepEqual(plain(G.state.customerWants.map(w => [w.name, w.customerId]).sort()),
        [["New want from tab B", "mp-z"], ["Old want", "mp-z"]], at);
      assert.deepEqual(plain(byId(G, "mp-z").orderRefs.map(r => r.id).sort()), ["o1", "o2", "o3", "o4"], at);
      assert.equal(G.tidyCustomers(), false, at);
    }
  }
});

/* ---------------- #201: two races left over from #196 ---------------- */

// A tab whose clock reads `iso`, so two tabs that tidy the same document
// really do it at different times (a real race is seconds apart).
function tabAt(d, iso) {
  const { G, sandbox } = freshCoreSandbox();
  sandbox.Date = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(iso); }
    static now() { return Date.parse(iso); }
  };
  G.adoptState(Object.assign({ cards: [], locations: [] }, plain(d)));
  return G;
}

test("#201: two tabs that both tidy the same race result stamp the same mergedAt -> no conflict, either save order", () => {
  const base = twoDanas();
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers("mp-b2", "mp-b1");
  b.syncCustomersFromOrders([order("o4", "b2", "D Reyes")]);   // mp-b2 edited: it comes back
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const M = mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged;
    assert.ok(M.customers.some(c => c.id === "mp-b2"), "the race brought mp-b2 back");
    const A = tabAt(M, "2026-10-12T10:00:00.000Z"), B = tabAt(M, "2026-10-12T10:07:00.000Z");
    assert.deepEqual(ids(A), ["mp-b1"]);
    assert.deepEqual(doc(A), doc(B), "both tabs tidied it to the same document");
    assert.notEqual(byId(A, "mp-b1").mergedAt, M.customers.find(c => c.id === "mp-b1").mergedAt,
      "the fold is still an edit to the kept customer");
    // Each tab then saves an unrelated edit, in either order.
    A.addWant("mp-b1", { name: "Sol Ring" });
    B.addWant("mp-b1", { name: "Mana Crypt" });
    for (const [x, y] of [[A, B], [B, A]]) {
      const r = mergeLib.merge(M, doc(x), doc(y));
      assert.deepEqual(plain(r.conflicts), [], "nothing to warn about");
      const G = tab(r.merged);
      assert.deepEqual(ids(G), ["mp-b1"]);
      assert.deepEqual(plain(byId(G, "mp-b1").orderRefs.map(o => o.id).sort()), ["o1", "o2", "o3", "o4"]);
      assert.equal(G.state.customerWants.length, 2);
      assert.equal(G.tidyCustomers(), false);
    }
  }
});

test("#201: a merged-in want identical to one the kept customer has folds into the kept customer's own", () => {
  const G = twoDanas();
  const gone = G.addWant("mp-b2", { name: "Sol Ring", note: "for the cube" });   // first in the list
  const own = G.addWant("mp-b1", { name: "Sol Ring" });
  G.mergeCustomers("mp-b2", "mp-b1");
  assert.deepEqual(plain(G.state.customerWants.map(w => w.id)), [own.id], "the kept customer's own want stays");
  assert.equal(G.state.customerWants[0].note, "for the cube", "and takes the other's note");
  assert.ok(!G.state.customerWants.some(w => w.id === gone.id));
});

// Gus (g) is merged into Kim (k) in tab A and into Lee (l) in tab B.
const GKL_ORDERS = [order("o1", "g", "Gus", 10), order("o2", "k", "Kim", 20), order("o3", "l", "Lee", 30),
  order("o4", "g", "Gus", 5)];
function gIntoKAndL() {
  const base = freshCore();
  base.syncCustomersFromOrders(GKL_ORDERS);
  const gSol = base.addWant("mp-g", { name: "Sol Ring", note: "Gus's" });   // ahead of Lee's own copy in the list
  base.addWant("mp-l", { name: "Sol Ring" });
  base.addWant("mp-g", { name: "Mana Crypt" });
  base.state.restockMatches.push(base.normalizeRestockMatch({ id: "mg", customerId: "mp-g", wantId: gSol.id, name: "Sol Ring" }));
  const baseDoc = doc(base);
  const a = tab(baseDoc), b = tab(baseDoc);
  a.mergeCustomers("mp-g", "mp-k");
  b.mergeCustomers("mp-g", "mp-l");
  return { baseDoc, a, b };
}

test("#201: one customer merged into two at once -> its orders count once, on the customer its alias leads to", () => {
  const { baseDoc, a, b } = gIntoKAndL();
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const M = mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged;
    const G = tab(M);
    assert.deepEqual(ids(G), ["mp-k", "mp-l"]);
    const winner = G.state.customerAliases.find(x => x.id === "mp-g").keepId;
    const other = winner === "mp-k" ? "mp-l" : "mp-k";
    const refs = id => plain(byId(G, id).orderRefs.map(r => r.id).sort());
    assert.deepEqual(refs(winner), winner === "mp-k" ? ["o1", "o2", "o4"] : ["o1", "o3", "o4"]);
    assert.deepEqual(refs(other), other === "mp-k" ? ["o2"] : ["o3"], "Gus's orders are not on both");
    const spend = G.state.customers.reduce((t, c) => t + G.customerOrders(c, GKL_ORDERS).spend, 0);
    assert.equal(spend, 65, "lifetime spend counts each order once");
    // Gus's next order goes where his old ones are.
    G.syncCustomersFromOrders(GKL_ORDERS.concat([order("o5", "g", "Gus", 1)]));
    assert.ok(refs(winner).includes("o5"));
    assert.equal(G.tidyCustomers(), false, "settled");
    // Two tabs tidying the same race result agree, whatever their clocks.
    assert.deepEqual(doc(tabAt(M, "2026-10-12T10:00:00.000Z")), doc(tabAt(M, "2026-10-12T11:00:00.000Z")));
  }
});

test("#201: one customer merged into two at once -> the kept customers keep their own wants, none lost", () => {
  const { baseDoc, a, b } = gIntoKAndL();
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const G = tab(mergeLib.merge(baseDoc, doc(mine), doc(theirs)).merged);
    const wants = G.state.customerWants;
    assert.ok(wants.some(w => w.customerId === "mp-l" && w.name === "Sol Ring"), "Lee keeps his own Sol Ring");
    assert.ok(wants.some(w => w.name === "Sol Ring" && (w.customerId === "mp-k" || w.note === "Gus's")),
      "Gus's Sol Ring survives: on Kim, or folded into Lee's");
    assert.ok(wants.some(w => w.name === "Mana Crypt"), "Gus's other want survives");
    assert.ok(wants.every(w => ["mp-k", "mp-l"].includes(w.customerId)));
    // Gus's "came in" survives, on the customer that now has its want.
    const m = G.state.restockMatches.find(x => x.id === "mg");
    assert.ok(m, "the match survives");
    assert.equal(m.customerId, wants.find(w => w.id === m.wantId).customerId, "on its want's customer");
    assert.equal(G.tidyCustomers(), false);
  }
});
