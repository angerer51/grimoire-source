"use strict";
/* A Manapool order replaced or cancelled after its ticket was picked (#489):
   the ticket is flagged in pick, pack and ship, can't be marked shipped or
   packed, and Cancel and put back puts its copies in a sorting tray with
   their cost and takes the sale off the books. On the real core.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");
const { moneyLeaks } = require("../test-lib/no-money");

const INFO = (name, num) => ({ name, collector: num, setName: "Set", rarity: "rare", tcgplayerId: "9", scryfallId: "sf-" + num,
  price: 20, priceNote: "", note: "", meta: { imageUrl: "https://img.test/" + num + ".jpg" } });

// The server's answers: an empty activity log, and `cancelled` for the orders route.
function setup(cancelled) {
  const G = freshCore({ fetch: async url => {
    const body = String(url).includes("/api/manapool/cancelled-orders") ? { orders: cancelled ? cancelled() : [] } : { entries: [], total: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  } });
  G.state.locations.push(G.newLocation({ id: "box", name: "SELL BOX 2", type: "Box", pickPriority: 5, sellFrom: true }));
  return G;
}
function stock(G, qty, unitCost, card) {
  const c = Object.assign({ num: "55", name: "Fierce Guardianship", locationId: "box", finish: "nonfoil" }, card);
  G.addCopies({ set: "slc", num: c.num, lang: "en", finish: c.finish, condition: "NM", locationId: c.locationId, qty,
    info: INFO(c.name, c.num), unitCost, action: "receipt", receiptId: "T1", note: "" });
}
function mpTicket(G, lines, orderId) {
  const p = G.newPickList({ source: "manapool", orderId: orderId || "776749-2723388", orderLabel: "776749-2723388" });
  G.pickLists().push(p);
  for (const l of lines) {
    G.addToPickList(p.id, Object.assign({ kind: "card", set: "slc", collector: "55", lang: "en", finish: "nonfoil", condition: "NM",
      name: "Fierce Guardianship", qty: 1, unitPrice: 30 }, l));
  }
  return p;
}
// A ticket picked before #489 kept no put-back record on its pulls.
const asOldPick = p => { for (const l of p.lines) for (const pu of l.pickedResult.pulls) delete pu.back; };
const tray = (G, name) => {
  const l = G.newLocation({ id: "tray-" + name.length, name, type: "Other", staging: true });
  G.state.locations.push(l);
  return l;
};
const inLoc = (G, id) => G.state.cards.filter(r => r.locationId === id);
const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);
const DAY = 864e5;

test("Manapool's replaced, cancelled, canceled and refunded flag an unshipped ticket; other statuses and shipped tickets don't", () => {
  const G = setup();
  const p = mpTicket(G, [{}], "o-1");
  assert.equal(G.pickOrderCancelled(p), "");
  G.noteOrderStatuses([{ id: "o-1", status: "processing" }]);
  assert.equal(G.pickOrderCancelled(p), "");
  G.noteOrderStatuses([{ id: "o-1", status: "Replaced" }]);
  assert.equal(G.pickOrderCancelled(p), "replaced");
  const q = mpTicket(G, [{}], "o-2");
  G.noteOrderStatuses([{ id: "o-2", status: "canceled" }]);
  assert.equal(G.pickOrderCancelled(q), "cancelled", "either spelling reads the same");
  for (const s of ["refunded", "cancelled"]) assert.equal(G.orderWasCancelled(s), true);
  for (const s of ["shipped", "delivered", "unfulfilled", "", null]) assert.equal(G.orderWasCancelled(s), false);
  q.status = "shipped";
  assert.equal(G.pickOrderCancelled(q), "", "already gone out: nothing to stop");
  const walkIn = G.newPickList({ source: "walkin", orderId: "o-1" });
  assert.equal(G.pickOrderCancelled(walkIn), "", "a counter sale is never a Manapool order");
});

test("the server's list is read, says whether anything changed, and orders a page loads add to it", async () => {
  let answer = [{ id: "o-1", status: "replaced" }];
  const G = setup(() => answer);
  const p = mpTicket(G, [{}], "o-1");
  assert.equal(await G.loadCancelledOrders(), true);
  assert.equal(G.pickOrderCancelled(p), "replaced");
  assert.equal(await G.loadCancelledOrders(), false, "same answer: no redraw");
  const q = mpTicket(G, [{}], "o-3");
  G.setManapoolOrders([{ id: "o-3", status: "refunded", lines: [] }]);
  assert.equal(G.pickOrderCancelled(q), "refunded");
  answer = [];
  await G.loadCancelledOrders();
  assert.equal(G.pickOrderCancelled(p), "replaced", "an order doesn't come back from replaced");
});

test("a flagged ticket can't be marked shipped or packed, and Warehouse Mode is told without any money", () => {
  const G = setup();
  stock(G, 2, 4);
  const p = mpTicket(G, [{}]);
  G.completePickList(p.id);
  p.rfPickedAt = p.pickedAt;
  G.noteOrderStatuses([{ id: p.orderId, status: "replaced" }]);
  assert.equal(G.markPickListPacked(p.id), null);
  assert.equal(p.packedAt, undefined);
  const t = { kind: "ticket", id: p.id };
  const view = G.rfPackView(t);
  assert.equal(view[0].cancelled, "replaced");
  same(moneyLeaks(view, { words: /price|cost|revenue|cogs|fee/i, numbers: [30, 4] }), []);
  assert.equal(G.rfPackOrder(p.id), null);
  assert.equal(G.rfPickQueue({ id: "u1", username: "sam" })[0].cancelled, true);
  assert.equal(G.markPickListShipped(p.id), null);
  assert.equal(p.status, "picked");
});

test("PICK-2026-0165's case: cancel a picked, packed ticket from before #489 into the one sorting tray, cost kept, sale gone", async () => {
  const G = setup();
  const t1 = tray(G, "1. SORTING TRAY");
  stock(G, 1, 6);                                              // the last copy: the stack goes at Finish
  stock(G, 2, 3, { num: "65", name: "Omniscience" });         // one of two: the stack stays
  const p = mpTicket(G, [{}, { collector: "65", name: "Omniscience", unitPrice: 12 }]);
  G.completePickList(p.id);
  asOldPick(p);
  p.packedAt = new Date().toISOString();
  G.noteOrderStatuses([{ id: p.orderId, status: "replaced" }]);
  const from = Date.now() - DAY, to = Date.now() + DAY;
  assert.equal(G.salesBetween(from, to).orders, 1);
  assert.equal(p.cogs, 9);

  const out = G.cancelPickedOrder(p.id);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.putBack, 2);
  assert.equal(out.tray.id, t1.id);
  const back = inLoc(G, t1.id).sort((a, b) => a.collector.localeCompare(b.collector));
  same(back.map(r => [r.collector, r.quantity, r.costQty, r.avgCost, r.listedQty, !!r.held]),
    [["55", 1, 1, 6, 0, false], ["65", 1, 1, 3, 0, false]], "free stock in the tray, each copy at its own cost");
  assert.equal(back[0].scryfallId, "", "the last copy's stack was gone: only what the line knew");
  assert.equal(back[1].scryfallId, "sf-65", "the printing's details from the stack still on the shelf");
  assert.equal(back[1].imageUrl, "https://img.test/65.jpg");
  assert.equal(inLoc(G, "box").reduce((n, r) => n + r.quantity, 0), 1, "nothing back on the shelf it came from");
  assert.equal(G.pickLists().length, 0, "the ticket is gone");
  assert.equal(G.state.history.some(h => h.title === "Completed " + p.id), false, "out of Statistics");
  assert.equal(G.salesBetween(from, to).orders, 0, "off the Dashboard");
  assert.equal(G.profitBetween(from, to).revenue, 0);
  const log = (await G.queryAudit({})).entries.filter(e => /cancelled on Manapool|Cancelled PICK/.test(e.note || ""));
  assert.equal(log.filter(e => e.action === "add").length, 2, "one entry per copy put back");
  assert.match(log.find(e => e.action === "edit").note, /Cancelled .*replaced on Manapool.*2 copies put in 1\. SORTING TRAY/);
});

test("an older pick whose card is gone everywhere takes the printing's details from the lookup", () => {
  const G = setup();
  tray(G, "1. SORTING TRAY");
  stock(G, 1, 2.5);
  const p = mpTicket(G, [{}]);
  G.completePickList(p.id);
  asOldPick(p);
  const out = G.cancelPickedOrder(p.id, { infoFor: l => (l.collector === "55" ? INFO("Fierce Guardianship", "55") : null) });
  assert.equal(out.ok, true);
  const r = G.state.cards[0];
  same([r.name, r.scryfallId, r.imageUrl, r.price, r.avgCost], ["Fierce Guardianship", "sf-55", "https://img.test/55.jpg", 20, 2.5]);
});

test("a pick made now keeps each pull's stack and cost, so even a foil's own details come back with no lookup", () => {
  const G = setup();
  stock(G, 1, 7.5, { num: "132", name: "Fated Firepower", finish: "foil" });
  const p = mpTicket(G, [{ collector: "132", name: "Fated Firepower", finish: "foil" }], "781077-2737772");
  G.completePickList(p.id);
  assert.ok(p.lines[0].pickedResult.pulls[0].back, "Manapool pulls record what puts them back");
  assert.equal(G.state.cards.length, 0);
  const out = G.cancelPickedOrder(p.id);
  assert.equal(out.ok, true);
  assert.equal(out.tray.name, "Sorting tray", "no tray yet: one is made");
  assert.equal(out.tray.staging, true);
  const r = G.state.cards[0];
  same([r.locationId, r.finish, r.scryfallId, r.quantity, r.avgCost], [out.tray.id, "foil", "sf-132", 1, 7.5]);
});

test("with several sorting trays it asks which; a stack already in that tray just grows", () => {
  const G = setup();
  tray(G, "1. SORTING TRAY");
  const t2 = tray(G, "Returns tray");
  stock(G, 3, 2);
  stock(G, 1, 2, { locationId: t2.id });
  const p = mpTicket(G, [{ qty: 2 }]);
  G.completePickList(p.id);
  const ask = G.cancelPickedOrder(p.id);
  assert.equal(ask.ok, false);
  assert.match(ask.error, /Choose which sorting tray/);
  assert.equal(G.pickLists().length, 1, "nothing changed");
  same(G.sortingTrays().map(l => l.name), ["1. SORTING TRAY", "Returns tray"]);
  const out = G.cancelPickedOrder(p.id, { trayId: t2.id });
  assert.equal(out.ok, true);
  same(inLoc(G, t2.id).map(r => [r.quantity, r.costQty, r.avgCost]), [[3, 3, 2]]);
});

test("refused once shipped, before it's picked, and for a ticket that isn't a Manapool order", () => {
  const G = setup();
  stock(G, 3, 1);
  const p = mpTicket(G, [{}]);
  assert.match(G.cancelPickedOrder(p.id).error, /discard the ticket/);
  G.completePickList(p.id);
  G.markPickListShipped(p.id);
  const out = G.cancelPickedOrder(p.id);
  assert.equal(out.ok, false);
  assert.match(out.error, /already shipped/);
  assert.equal(G.pickLists().length, 1);
  const manual = G.newPickList({ source: "manual" });
  manual.status = "picked";
  G.pickLists().push(manual);
  assert.equal(G.cancelPickedOrder(manual.id).ok, false);
});

test("refused while its batch has copies in a tote (reverse them in Warehouse Mode first)", () => {
  const G = setup();
  stock(G, 5, 1);
  const SAM = { id: "u1", username: "sam", displayName: "Sam" };
  const p1 = mpTicket(G, [{}], "o-1");
  const p2 = mpTicket(G, [{}], "o-2");
  G.createPickBatch([p1.id, p2.id], SAM);
  G.completePickList(p1.id);
  p2.rfPulls = [{ lineKey: G.pickKey(p2.lines[0]), recordId: G.state.cards[0].id, locationId: "box", qty: 1 }];
  assert.ok(G.pickListInHand(p1), "the batch has copies in hand");
  const out = G.cancelPickedOrder(p1.id);
  assert.equal(out.ok, false);
  assert.match(out.error, /Warehouse Mode/);
  assert.equal(G.pickLists().length, 2);
});

test("the desk won't complete an open ticket whose order is gone: it only set copies aside, so it's discarded", () => {
  const G = setup();
  stock(G, 3, 1);
  const p = mpTicket(G, [{ qty: 2 }], "o-1");
  G.noteOrderStatuses([{ id: "o-1", status: "cancelled" }]);
  const desk = G.completePickList(p.id);
  assert.equal(desk.cancelled, "cancelled");
  assert.equal(desk.shipped, 0);
  assert.equal(p.status, "open");
  assert.equal(inLoc(G, "box")[0].quantity, 3, "nothing came off the shelf");
});

const SAM = { id: "u1", username: "sam", displayName: "Sam" };
test("Warehouse Mode: copies already in hand for a gone order finish as picked, flagged, then go to the tray", () => {
  const G = setup();
  tray(G, "1. SORTING TRAY");
  stock(G, 3, 1.25);
  const p = mpTicket(G, [{ qty: 2 }], "o-1");
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, SAM);
  assert.equal(G.rfConfirmPull(t, G.rfPickWalk(t).next.id), true);
  G.noteOrderStatuses([{ id: "o-1", status: "replaced" }]);   // replaced mid-walk
  same(G.rfCancelledOrders(t), [{ tag: "#776749-2723388", held: 2 }]);
  const out = G.rfFinishPicking(t);
  assert.ok(!out.refused);
  assert.equal(p.status, "picked");
  assert.equal(G.pickOrderCancelled(p), "replaced", "still flagged");
  assert.equal(inLoc(G, "box")[0].quantity, 1, "what was in hand came off");
  assert.equal(G.rfPackOrder(p.id), null, "and isn't packed");
  const back = G.cancelPickedOrder(p.id);
  assert.equal(back.ok, true);
  same(inLoc(G, back.tray.id).map(r => [r.quantity, r.avgCost]), [[2, 1.25]]);
});

test("Warehouse Mode: a gone order with nothing in hand doesn't hold up its batch, and stays open for the desk", () => {
  const G = setup();
  stock(G, 4, 1);
  const p1 = mpTicket(G, [{ qty: 2 }], "o-1");
  const p2 = mpTicket(G, [{ qty: 1 }], "o-2");
  const b = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], SAM) };
  G.noteOrderStatuses([{ id: "o-1", status: "replaced" }]);
  const w = G.rfPickWalk(b);
  assert.equal(w.next.need, 1, "only the live order's copy is asked for");
  assert.equal(w.cardsShort, 0, "the gone order's lines aren't short either");
  assert.equal(G.rfConfirmPull(b, w.next.id), true);
  assert.equal(G.rfPickWalk(b).next, null);
  const out = G.rfFinishPicking(b);
  assert.equal(out.done, 1);
  same(out.setAside, ["#776749-2723388"]);
  same(out.rest, [p2.id]);
  assert.equal(p2.status, "picked");
  assert.equal(p1.status, "open", "the desk discards it");
  assert.equal(inLoc(G, "box")[0].quantity, 3);
  // Out of the batch and free of its picker, so nobody's locked out.
  assert.ok(!p1.batchId && !p1.batchAssignee && !p1.rfPicker);
  assert.equal(p2.batchId, undefined, "one ticket left is no batch");
  assert.equal(G.rfPickWalk({ kind: "ticket", id: p2.id }).stage, "pack");
  const LEE = { id: "u2", username: "lee", orgId: "org1", orgRole: "staff" };
  assert.equal(G.canWorkPickList(p1, LEE), true, "the desk can discard it without a reassign");
  assert.equal(G.pickListInHand(p1), null);

  const solo = mpTicket(G, [{}], "o-1");
  assert.equal(G.rfFinishPicking({ kind: "ticket", id: solo.id }).refused, true, "nothing in hand: nothing to finish");
  assert.equal(solo.status, "open");
});

test("a batch that loses a gone order to the desk still goes on to Pack as a batch", () => {
  const G = setup();
  stock(G, 6, 1);
  const SAM2 = { id: "u1", username: "sam", displayName: "Sam", orgId: "org1", orgRole: "staff" };
  const [p1, p2, p3] = ["o-1", "o-2", "o-3"].map(o => mpTicket(G, [{}], o));
  const b = { kind: "batch", id: G.createPickBatch([p1.id, p2.id, p3.id], SAM2) };
  G.rfStartWork(b, SAM2);
  G.noteOrderStatuses([{ id: "o-2", status: "refunded" }]);
  for (let w = G.rfPickWalk(b); w.next; w = G.rfPickWalk(b)) assert.equal(G.rfConfirmPull(b, w.next.id), true);
  const out = G.rfFinishPicking(b);
  assert.equal(out.done, 2);
  assert.equal(p2.batchId, undefined);
  assert.equal(p2.rfPicker, undefined);
  same(G.pickBatchLists(b.id).map(p => p.id), [p1.id, p3.id]);
  assert.equal(G.rfPickWalk(b).stage, "pack");
  assert.equal(G.canWorkPickList(p2, { id: "u9", username: "kim", orgId: "org1", orgRole: "staff" }), true);
});

test("a lone started ticket whose order is gone, with nothing picked, is left for the desk with no picker", () => {
  const G = setup();
  stock(G, 2, 1);
  const p = mpTicket(G, [{}], "o-1");
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, SAM);
  assert.ok(p.rfPicker);
  G.noteOrderStatuses([{ id: "o-1", status: "replaced" }]);
  assert.equal(G.rfPickWalk(t).rows.length, 0, "Nothing to pick");
  const out = G.rfFinishPicking(t);
  assert.equal(out.refused, true);
  same(out.setAside, ["#776749-2723388"]);
  assert.equal(p.rfPicker, undefined);
  assert.equal(p.status, "open");
  assert.equal(G.canWorkPickList(p, { id: "u9", username: "kim", orgId: "org1", orgRole: "staff" }), true);
});
