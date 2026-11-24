"use strict";
/* Chasing a short line after its ticket finished picking (#526): the copy is
   on the book in another bin, or the short was a mistake and the picker
   confirms the copy is in the bin. On the real core.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const INFO = name => ({ name, collector: "344", setName: "Set", rarity: "rare", tcgplayerId: "1", scryfallId: "s", price: 7.25, priceNote: "", note: "", meta: {} });
function setup() {
  const G = freshCore({ fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ entries: [], total: 0 }) }) });
  for (const [id, name, pr] of [["a", "Meth Deals 1", 5], ["b", "B-2", 3]]) G.state.locations.push(G.newLocation({ id, name, type: "Box", pickPriority: pr, sellFrom: true }));
  return G;
}
const stock = (G, loc, qty) => G.addCopies({ set: "ltr", num: "344", lang: "en", finish: "nonfoil", condition: "NM", locationId: loc, qty,
  info: INFO("Rivendell"), unitCost: 2, action: "receipt", receiptId: "T1", note: "" });
const onHand = (G, loc) => G.state.cards.filter(r => r.locationId === loc).reduce((n, r) => n + r.quantity, 0);
// A ticket with Rivendell short at bin a (found 0), picked.
function shortTicket(G) {
  const p = G.newPickList({ source: "manapool", orderId: "o-1", orderLabel: "#1" });
  G.pickLists().push(p);
  G.addToPickList(p.id, { kind: "card", set: "ltr", collector: "344", lang: "en", finish: "nonfoil", condition: "NM", name: "Rivendell", qty: 1, unitPrice: 12 });
  const rec = G.state.cards.find(r => r.locationId === "a");
  G.chasePickAdjust(rec.id, 0, "Short pick in Warehouse Mode on " + p.id);
  G.requestBinCount("a", "Short pick on " + p.id, "cards");
  G.completePickList(p.id, () => ({ pulls: [], shortfall: 1 }));
  return p;
}

test("the short was a mistake: the picker confirms the copy is in the bin", () => {
  const G = setup();
  stock(G, "a", 1);
  const p = shortTicket(G);
  assert.equal(p.status, "picked");
  assert.equal(G.pickListIsShort(p), true);
  assert.equal(onHand(G, "a"), 0, "the short deleted the stack");
  const key = G.pickKey(p.lines[0]);
  const opt = G.chaseShortOptions(p.id, key);
  assert.equal(opt.onBook.length, 0);
  assert.equal(opt.bins[0].locationId, "a", "the bin the short was in comes first");
  const out = G.chaseShortLine(p.id, key, { foundAt: "a" });
  assert.equal(out.ok, true);
  assert.equal(out.ticketShort, false);
  const res = p.lines[0].pickedResult;
  assert.equal(res.shortfall, 0);
  assert.equal(res.pulls.length, 1);
  assert.equal(res.pulls[0].qty, 1);
  assert.equal(res.value, 12, "no printing left to price it by: the order's price stands in");
  assert.equal(p.revenue, 12);
  assert.equal(G.pickListIsShort(p), false);
  assert.equal(onHand(G, "a"), 0, "on-hand stays 0: put back and taken off");
  assert.equal(G.locById("a").countWanted, null, "the count request the short made goes");
});

test("copies on the book in another bin are pulled from there", () => {
  const G = setup();
  stock(G, "a", 1);
  const p = shortTicket(G);
  stock(G, "b", 2);
  const out = G.chaseShortLine(p.id, G.pickKey(p.lines[0]), {});
  assert.equal(out.ok, true);
  assert.equal(onHand(G, "b"), 1);
  assert.equal(p.lines[0].pickedResult.pulls[0].locationId, "b");
  assert.equal(p.lines[0].pickedResult.cogs, 2);
  assert.equal(p.cogs, 2);
  assert.equal(G.pickListIsShort(p), false);
  assert.equal(G.chaseShortLine(p.id, G.pickKey(p.lines[0]), {}).ok, false, "nothing left to chase");
});

test("nothing on the book and no bin chosen: refused", () => {
  const G = setup();
  stock(G, "a", 1);
  const p = shortTicket(G);
  assert.equal(G.chaseShortLine(p.id, G.pickKey(p.lines[0]), {}).ok, false);
  assert.equal(G.pickListIsShort(p), true);
});

test("found in the bin keeps cost: other stack's average when the stack is gone, and copies that stay keep theirs", () => {
  const G = setup();
  stock(G, "a", 1);
  stock(G, "b", 2);   // $2 each
  const p = shortTicket(G);
  const out = G.chaseShortLine(p.id, G.pickKey(p.lines[0]), { foundAt: "a" });
  assert.equal(out.ok, true);
  assert.equal(p.lines[0].pickedResult.cogs, 2);
  assert.equal(p.cogs, 2);
  const b = G.state.cards.find(r => r.locationId === "b");
  assert.equal(b.costQty, 2, "an untouched bin keeps its cost");
  // The bin still holds a copy on the book: found-in-bin there leaves the others' cost alone.
  const G2 = setup();
  stock(G2, "a", 1);
  const p2 = shortTicket(G2);
  stock(G2, "b", 2);
  assert.equal(G2.chaseShortOptions(p2.id, G2.pickKey(p2.lines[0])).bins.some(x => x.locationId === "b"), false, "a stocked bin isn't offered");
  assert.equal(G2.chaseShortLine(p2.id, G2.pickKey(p2.lines[0]), { foundAt: "b" }).ok, false, "refused: take from that bin");
  const b2 = G2.state.cards.find(x => x.locationId === "b");
  assert.equal(b2.quantity, 2);
  assert.equal(b2.costQty, 2);
});

test("with no cost anywhere the cost stays none", () => {
  const G = setup();
  stock(G, "a", 1);
  const p = shortTicket(G);
  G.chaseShortLine(p.id, G.pickKey(p.lines[0]), { foundAt: "a" });
  assert.equal(p.cogs, 0);
});
