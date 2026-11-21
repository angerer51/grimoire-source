"use strict";
/* Warehouse Mode returns (#411), on the real core.js: the desk opens a return
   with what the order says should come back, the RF books each card as restock
   or damaged (held, like a receipt's), puts it away, and the desk's close puts
   the cost back on restock copies only and records an ordinary return. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");
const priceRules = require("../server/lib/priceRules");
const { moneyLeaks } = require("../test-lib/no-money");

const INFO = (name, num, price) => ({ name, collector: num || "1", setName: "Set", rarity: "common", tcgplayerId: "1", scryfallId: "s" + (num || "1"),
  price: price == null ? 2 : price, priceNote: "", note: "", meta: {}, card: { imageUrl: "https://img/normal/x.jpg" } });
async function setup(entries) {
  const user = { id: "u1", username: "sam", displayName: "sam" };
  const G = freshCore({ fetch: async url => {
    const u = String(url);
    const v = u.startsWith("/api/auth/me") ? { user } : u.startsWith("/api/collection/stamp") ? { stamp: "s" }
      : u.startsWith("/api/collection") ? { rev: 1, state: null } : { entries: entries || [], total: (entries || []).length };
    return { ok: true, status: 200, text: async () => JSON.stringify(v), json: async () => v };
  } });
  await G.load();
  G.state.locations.push(G.newLocation({ id: "tray", name: "Tray A", type: "Box", staging: true }));
  G.state.locations.push(G.newLocation({ id: "a", name: "A-1", type: "Box", sellFrom: true, walkSeq: 2 }));
  return G;
}
const plain = x => JSON.parse(JSON.stringify(x));
const EXP = (num, name, qty, unitCost) => ({ set: "tst", collector: num, lang: "en", finish: "nonfoil", condition: "NM", name, qty, unitCost });
const book = (G, rc, num, name, qty, disposition, expId, condition) => G.rfBookCard({ receivingId: rc.id, locationId: "tray", info: INFO(name, num), set: "tst",
  lang: "en", finish: "nonfoil", condition: condition || "NM", qty, disposition, expId });

test("a return is opened on the desk and never shows as a receipt", async () => {
  const G = await setup();
  const rc = G.openReturn({ orderLabel: "#1001", buyer: "Ann", refundTotal: 12.5, expected: [EXP("1", "Sol Ring", 2, 3), EXP("2", "Bolt", 1, 1)] });
  assert.match(rc.receiptId, /^RMA-\d{4}-0001$/);
  assert.equal(G.openReceivings().length, 0);
  assert.equal(G.openReturns().length, 1);
  assert.throws(() => G.openReturn({ returnId: rc.receiptId }), /already exists/);
  assert.equal(G.nextReturnId().slice(-4), "0002", "the open return's number is taken");
  assert.equal(G.rfReturnList()[0].expected, 3);
});

test("booked copies are held, restock and damaged apart, and the RF views carry no money or buyer", async () => {
  const G = await setup();
  const rc = G.openReturn({ orderLabel: "#1001", buyer: "Ann Buyer", refundTotal: 12.5, reason: "wrong card", expected: [EXP("1", "Sol Ring", 2, 3.21), EXP("2", "Bolt", 1, 1.11)] });
  const [e1, e2] = rc.expected;
  assert.ok(book(G, rc, "1", "Sol Ring", 1, "restock", e1.id).ok);
  assert.ok(book(G, rc, "1", "Sol Ring", 1, "damaged", e1.id).ok);
  assert.ok(book(G, rc, "9", "Extra", 1, "restock", "").ok, "a card that wasn't on the order");
  const held = G.state.cards.filter(r => r.held);
  assert.equal(held.length, 3, "restock and damaged of the same card are different stacks");
  for (const r of held) {
    assert.equal(G.availableQty(r), 0);
    assert.equal(priceRules.availableQty(plain(r)), 0, "the server agrees");
    assert.equal(G.shelfQty(r, G.totesByStack()), r.quantity);
    assert.match(G.heldOn(r), /^RMA-/);
  }
  assert.deepEqual(moneyLeaks([G.rfReturnList(), G.rfReturnView(rc.id)],
    { words: /Ann|wrong card|unitCost|refund|cost|price|market|buyer|reason/i, numbers: [3.21, 1.11, 12.5] }), []);
  const v = G.rfReturnView(rc.id);
  assert.deepEqual(plain(v.expected.map(e => [e.qty, e.got, e.left])), [[2, 2, 0], [1, 0, 1]]);
  assert.equal(v.booked, 3);
  // The put-away walk takes a held return stack like any held stack, and the hold travels.
  const stop = G.rfPutawayStops("tray").stops.find(s => s.name === "Extra");
  assert.ok(stop.held);
  assert.ok(G.rfPutaway("card", stop.id, "a", 1).ok);
  const moved = G.state.cards.find(r => r.name === "Extra");
  assert.equal(moved.locationId, "a");
  assert.equal(G.availableQty(moved), 0, "still held in its bin");
  // The receiver can undo their own booking until it's put away.
  const line = G.receivingLinesOf(rc.id).find(l => l.disposition === "damaged");
  assert.ok(G.rfUndoLine(line.id).ok);
  assert.equal(G.state.cards.filter(r => r.name === "Sol Ring").length, 1);
});

test("close puts the cost back on restock copies only, records one return, and frees the copies", async () => {
  const G = await setup();
  const rc = G.openReturn({ orderLabel: "#1001", refundTotal: 10, expected: [EXP("1", "Sol Ring", 3, 3), EXP("2", "Bolt", 1, 1)] });
  const [e1] = rc.expected;
  book(G, rc, "1", "Sol Ring", 2, "restock", e1.id);
  book(G, rc, "1", "Sol Ring", 1, "damaged", e1.id);
  book(G, rc, "9", "Extra", 1, "restock", "");
  const rows = G.returnCostRows(rc.id);
  assert.deepEqual(plain(rows.map(r => [r.name, r.qty, r.unitCost])), [["Sol Ring", 2, 3], ["Extra", 1, null]], "pre-filled from the expected line, blank for an extra");
  const s = G.returnSummary(rc.id);
  assert.equal(s.received, 4);
  assert.equal(s.damaged, 1);
  assert.equal(s.extras, 1);
  assert.equal(s.expectedQty, 4);
  const out = G.closeReturn(rc.id, { refundTotal: 9, unitCosts: { [rows[0].costKey]: 3, [rows[1].costKey]: 2 } });
  assert.equal(G.openReturns().length, 0);
  assert.equal(G.state.receivingLines.length, 0);
  assert.equal(G.state.cards.some(r => r.held), false, "no hold left");
  const sol = G.state.cards.filter(r => r.name === "Sol Ring");
  assert.equal(sol.length, 1, "restock and damaged copies of a card merge once free (same bin)");
  assert.equal(sol[0].quantity, 3);
  assert.equal(sol[0].costQty, 2, "only the restock copies carry a cost basis");
  assert.equal(sol[0].costTotal, 6);
  assert.equal(G.state.cards.find(r => r.name === "Extra").costTotal, 2);
  assert.equal(G.availableQty(sol[0]), 3);
  const ret = G.state.returns[0];
  assert.equal(ret, out.doc);
  assert.equal(ret.returnId, rc.receiptId);
  assert.equal(ret.refundTotal, 9);
  assert.equal(ret.totalQty, 4);
  assert.equal(ret.disposition, "restock");
  assert.equal(G.returnCostBack(ret), 8, "2 x 3 + 1 x 2; the damaged copy puts nothing back");
  assert.deepEqual(plain(ret.expected.map(e => [e.name, e.qty, e.got])), [["Sol Ring", 3, 3], ["Bolt", 1, 0]]);
  assert.ok(ret.lines.some(l => l.extra && l.name === "Extra"));
  assert.ok(ret.lines.some(l => l.disposition === "damaged" && l.unitCost == null));
});

test("a return of only damaged copies is a write-off, and an unopened return can be removed", async () => {
  const G = await setup();
  const rc = G.openReturn({ expected: [EXP("1", "Sol Ring", 1, 3)] });
  const gone = G.openReturn({});
  assert.ok(G.discardReturn(gone.id));
  book(G, rc, "1", "Sol Ring", 1, "damaged", rc.expected[0].id);
  assert.equal(G.discardReturn(rc.id), false, "something is booked");
  const out = G.closeReturn(rc.id, { unitCosts: { "tst|1|nonfoil": 3 } });
  assert.equal(out.doc.disposition, "damaged");
  assert.equal(G.returnCostBack(out.doc), 0);
  assert.equal(G.state.cards[0].costQty, 0);
  assert.equal(out.restock, false);
});

test("the returns page reads no financial field off anything", () => {
  const fs = require("fs"), path = require("path");
  const { APP_DIR } = require("../test-lib/core-shim");
  const code = fs.readFileSync(path.join(APP_DIR, "public/rf/returns.page.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(price|unitPrice|unitCost|avgCost|costTotal|costQty|refundTotal|revenue|cogs|fees?|earnings|orderPayment|shippingRevenue|buyer)\b/);
});

test("what the order sent: the ticket's cards are the expected lines, the cost comes from its pick entries", async () => {
  const pk = (cost, qty, note) => ({ id: "e" + Math.random(), action: "pick", set: "tst", collector: "1", finish: "nonfoil", qty, cost, note });
  const G = await setup([pk(-4, -1, "Picked for PICK-0001"), pk(-2, -1, "Picked for PICK-0001"), pk(-99, -1, "Picked for PICK-0010")]);
  const order = { id: "o1", label: "#1001", lines: [] };
  G.state.pickLists.push(Object.assign(G.newPickList({ source: "manapool", orderId: "o1", orderLabel: "#1001" }),
    { lines: [{ kind: "card", set: "tst", collector: "1", lang: "en", finish: "nonfoil", condition: "NM", name: "Sol Ring", qty: 2, unitPrice: 9 },
      { kind: "sealed", tcgplayerProductId: "5", name: "Box", qty: 1 }] }));
  const exp = G.returnExpectedFromOrder(order);
  assert.equal(exp.length, 1, "sealed isn't part of a card return");
  assert.equal(exp[0].qty, 2);
  assert.doesNotMatch(JSON.stringify(exp), /unitPrice|"9"/);
  G.pickListForOrder("o1").id = "PICK-0001";
  const costs = await G.returnSaleCosts("o1");
  assert.equal(costs.get("tst|1|nonfoil"), 3, "(4 + 2) over 2 copies; another ticket's entries don't count");
  assert.equal((await G.returnSaleCosts("nope")).size, 0);
});
