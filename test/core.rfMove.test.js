"use strict";
/* Warehouse Mode's find and move (#387), on the real core.js: the lookup adds
   up the book, a move is the desk's own move, copies in a tote or lent never
   move, copies set aside for a ticket do (and the picker's walk follows), and
   a full bin warns rather than refuses. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");
const { moneyLeaks } = require("../test-lib/no-money");

const INFO = name => ({ name, collector: "1", setName: "Set", rarity: "common", tcgplayerId: "1", scryfallId: "s", price: 7.25, priceNote: "", note: "", meta: {} });
function setup(bins) {
  const G = freshCore({ fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ entries: [], total: 0 }) }) });
  for (const [id, name, maxCards] of bins || [["a", "A-1"], ["b", "B-2"], ["c", "C-3", 5]]) {
    G.state.locations.push(G.newLocation({ id, name, type: "Box", sellFrom: true, maxCards: maxCards == null ? null : maxCards }));
  }
  return G;
}
function stock(G, locationId, qty, card) {
  const c = Object.assign({ set: "tst", num: "1", name: "Sol Ring", lang: "en", finish: "nonfoil", condition: "NM" }, card);
  G.addCopies({ set: c.set, num: c.num, lang: c.lang, finish: c.finish, condition: c.condition, locationId, qty, info: Object.assign(INFO(c.name), { collector: c.num }),
    unitCost: 1.5, action: "receipt", receiptId: "T1", note: "" });
}
function ticket(G, lines) {
  const p = G.newPickList({ source: "manual", orderId: "o-" + G.pickLists().length, orderLabel: "#10" + G.pickLists().length });
  G.pickLists().push(p);
  for (const l of lines) G.addToPickList(p.id, Object.assign({ kind: "card", set: "tst", collector: "1", lang: "en", finish: "nonfoil", condition: "NM", name: "Sol Ring", qty: 1, unitPrice: 9.99 }, l));
  return p;
}
const ME = { id: "u1", username: "sam" };
const at = (G, id) => G.state.cards.filter(r => r.locationId === id).reduce((n, r) => n + r.quantity, 0);
const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);
const stackAt = (G, id, extra) => G.state.cards.find(r => r.locationId === id && (!extra || extra(r)));

test("a lookup lists each bin by condition, finish and language, and the rest of the book beside it", () => {
  const G = setup();
  stock(G, "a", 5);
  stock(G, "a", 2, { condition: "LP", finish: "foil" });
  stock(G, "b", 3, { lang: "de" });
  stock(G, "a", 1, { num: "2", name: "Sol Ring" });   // another printing, not this one
  const found = G.rfFindCards("sol ring");
  assert.equal(found.printings.length, 2, "two printings");
  const key = found.printings[0].printing;
  const where = G.rfCardWhere(key);
  assert.equal(where.stacks.length, 3);
  same(where.stacks.map(s => [s.bin, s.condition, s.finish, s.lang, s.onShelf]),
    [["A-1", "LP", "foil", "en", 2], ["A-1", "NM", "nonfoil", "en", 5], ["B-2", "NM", "nonfoil", "de", 3]]);

  // One lent, two in a tote: the shelf is the rest, and the three add up to the book.
  const nm = stackAt(G, "a", r => r.condition === "NM" && r.collector === "1");
  nm.loans = [{ id: "l1", qty: 1, to: "Pat", at: "2026-10-01" }];
  const p = ticket(G, [{ qty: 2 }]);
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, ME);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  const row = G.rfCardWhere(key).stacks.find(s => s.id === nm.id);
  assert.equal(row.onShelf, 2);
  assert.equal(row.lent, 1);
  assert.equal(row.inTote, 2);
  assert.match(row.toteWords, /^2 in a tote, pulled by/);
  assert.equal(row.onShelf + row.lent + row.inTote, row.book);
});

test("a name search needs every word, and says when there are more than it shows", () => {
  const G = setup();
  stock(G, "a", 1, { name: "Sol Ring", num: "1" });
  stock(G, "a", 1, { name: "Sol Talisman", num: "2" });
  assert.equal(G.rfFindCards("sol").printings.length, 2);
  assert.equal(G.rfFindCards("sol ring").printings.length, 1);
  assert.equal(G.rfFindCards("   ").printings.length, 0);
  assert.equal(G.rfFindCards("zzz").printings.length, 0);
  for (let i = 0; i < 45; i++) stock(G, "b", 1, { name: "Bear " + i, num: String(100 + i) });
  const many = G.rfFindCards("bear");
  assert.equal(many.printings.length, 40);
  assert.equal(many.more, true);
});

test("a move is the desk's move: splits the stack, carries cost, joins a matching stack, and writes the audit entry", async () => {
  const G = setup();
  stock(G, "a", 5);
  const rec = stackAt(G, "a");
  const costBefore = rec.costTotal;
  const out = G.rfMoveCards(rec.id, "b", 2);
  assert.equal(out.ok, true);
  assert.equal(out.moved, 2);
  assert.equal(at(G, "a"), 3);
  assert.equal(at(G, "b"), 2);
  const moved = stackAt(G, "b");
  assert.equal(Math.round((rec.costTotal + moved.costTotal) * 100), Math.round(costBefore * 100), "a move never invents or destroys cost");
  // The rest joins what's already there.
  assert.equal(G.rfMoveCards(rec.id, "b", 3).merged, true);
  assert.equal(G.state.cards.length, 1, "one stack in B-2");
  assert.equal(at(G, "b"), 5);
  const log = (await G.queryAudit({ limit: 10 })).entries.filter(e => e.action === "move");
  assert.equal(log.length, 2);
  assert.equal(log[0].from, "A-1");
  assert.equal(log[0].to, "B-2");
  assert.match(log[0].note, /Warehouse Mode/);
  // Locations' own count and the bin view agree.
  assert.equal(G.locStats("b").cards, 5);
  assert.equal(G.rfBinView("b").cards, 5);
});

test("copies in a tote and lent copies can never move; the rest can", () => {
  const G = setup();
  stock(G, "a", 6);
  const rec = stackAt(G, "a");
  rec.loans = [{ id: "l1", qty: 1, to: "Pat", at: "2026-10-01" }];
  const p = ticket(G, [{ qty: 2 }]);
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, ME);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  assert.equal(G.rfMoveCheck(rec.id, "b", 4).ok, false, "6 - 1 lent - 2 in the tote leaves 3");
  assert.equal(G.rfMoveCheck(rec.id, "b", 4).problem, "too-many");
  assert.equal(G.rfMoveCheck(rec.id, "b", 4).movable, 3);
  assert.equal(G.rfMoveCards(rec.id, "b", 4).ok, false);
  assert.equal(at(G, "b"), 0, "a refused move changes nothing");
  assert.equal(G.rfMoveCards(rec.id, "b", 3).ok, true);
  const left = stackAt(G, "a");
  assert.equal(left.quantity, 3);
  assert.equal(G.lentQty(left), 1, "the loan stays with the copies still here");
  assert.equal(G.lentQty(stackAt(G, "b")), 0, "and doesn't follow the moved ones");
  assert.equal(G.rfMoveCheck(left.id, "b", 1).ok, false, "all that's left is in the tote or lent");
  assert.equal(G.rfMoveCheck(left.id, "b", 0).ok, false);
  assert.equal(G.rfMoveCheck(left.id, "a", 1).problem, "same-bin");
  assert.equal(G.rfMoveCheck("gone", "b", 1).problem, "gone");
  assert.equal(G.rfMoveCheck(left.id, "nowhere", 1).problem, "no-bin");
});

test("copies set aside for a ticket but not pulled move, and the ticket's walk goes to the new bin", () => {
  const G = setup();
  stock(G, "a", 3);
  const p = ticket(G, [{ qty: 2 }]);
  const t = { kind: "ticket", id: p.id };
  assert.equal(G.rfPickWalk(t).next.bin, "A-1");
  const rec = stackAt(G, "a");
  assert.equal(G.rfMoveCards(rec.id, "b", 3).ok, true, "all of it, allocated or not");
  const w = G.rfPickWalk(t);
  assert.equal(w.next.bin, "B-2");
  assert.equal(w.next.need, 2);
  assert.equal(w.shorts.length, 0);
  // A part-move splits the line across both bins, in walk order.
  const G2 = setup();
  stock(G2, "a", 3);
  const p2 = ticket(G2, [{ qty: 3 }]);
  G2.rfMoveCards(stackAt(G2, "a").id, "b", 1);
  same(G2.rfPickWalk({ kind: "ticket", id: p2.id }).rows.map(r => [r.bin, r.qty]), [["A-1", 2], ["B-2", 1]]);
});

test("a bin over its limit warns with the room left, and the move still goes ahead", () => {
  const G = setup();   // C-3 holds 5
  stock(G, "a", 4);
  stock(G, "c", 3, { num: "9", name: "Other" });
  const rec = stackAt(G, "a");
  const check = G.rfMoveCheck(rec.id, "c", 4);
  assert.equal(check.ok, true, "a warning, not a refusal");
  assert.equal(check.over, true);
  assert.equal(check.free, 2);
  assert.equal(check.cap, 5);
  assert.equal(G.rfMoveCheck(rec.id, "c", 2).over, false);
  assert.equal(G.rfMoveCards(rec.id, "c", 4).ok, true);
  assert.equal(at(G, "c"), 7);
  assert.equal(G.rfMoveCheck(stackAt(G, "c", r => r.name === "Sol Ring").id, "b", 1).over, false, "no limit at all");
});

test("bins: the list is in walk order and filters by name; a bin view shows its room and its stacks", () => {
  const G = setup();
  stock(G, "c", 2);
  stock(G, "c", 1, { num: "2", name: "Mox" });
  same(G.rfBinList("").map(b => b.name), ["A-1", "B-2", "C-3"]);
  same(G.rfBinList("b-").map(b => [b.name, b.cards]), [["B-2", 0]]);
  same(G.rfBinList("c").map(b => [b.name, b.cards]), [["C-3", 3]]);
  const v = G.rfBinView("c");
  assert.equal(v.cap, 5);
  assert.equal(v.free, 2);
  same(v.stacks.map(s => s.name), ["Mox", "Sol Ring"]);
  assert.equal(G.rfBinView("nope"), null);
});

test("a name search ignores apostrophes, hyphens and accents", () => {
  const G = setup();
  stock(G, "a", 1, { name: "Urza's Tower", num: "1" });
  stock(G, "a", 1, { name: "Lim-Dûl's Vault", num: "2" });
  stock(G, "a", 1, { name: "José Card", num: "3" });
  assert.equal(G.rfFindCards("urzas").printings.length, 1);
  assert.equal(G.rfFindCards("Urza's tow").printings.length, 1);
  assert.equal(G.rfFindCards("lim-dul").printings.length, 1);
  assert.equal(G.rfFindCards("limdul vault").printings.length, 1);
  assert.equal(G.rfFindCards("jose").printings.length, 1);
  assert.equal(G.rfFindCards("josé").printings.length, 1);
  assert.equal(G.rfFindCards("'").printings.length, 0, "punctuation alone isn't a search");
});

test("a big bin returns only its first stacks and says how many there are; a card name narrows it", () => {
  const G = setup();
  for (let i = 0; i < 120; i++) stock(G, "a", 1, { name: "Card " + String(i).padStart(3, "0"), num: String(100 + i) });
  const v = G.rfBinView("a");
  assert.equal(v.stacks.length, 40);
  assert.equal(v.stackCount, 120);
  assert.equal(v.matching, 120);
  assert.equal(v.more, true);
  assert.equal(v.stacks[0].name, "Card 000");
  const narrow = G.rfBinView("a", "card 07");
  assert.equal(narrow.matching, 12);   // 007, 070-079, 107
  assert.equal(narrow.more, false);
  assert.equal(narrow.stackCount, 120);
});

test("a bin's view says how much sealed product is in it, and the bin list does too", () => {
  const G = setup();
  stock(G, "b", 2);
  G.addSealedCopies({ tcgplayerProductId: "777", name: "Booster Box", setCode: "tst", locationId: "a", qty: 4, price: 120 });
  G.addSealedCopies({ tcgplayerProductId: "778", name: "Bundle", setCode: "tst", locationId: "b", qty: 1, price: 40 });
  assert.equal(G.rfBinView("a").sealed, 4);
  assert.equal(G.rfBinView("a").stackCount, 0);
  assert.equal(G.rfBinView("b").sealed, 1);
  assert.equal(G.rfBinView("c").sealed, 0);
  same(G.rfBinList("").map(b => [b.name, b.cards, b.sealed]), [["A-1", 0, 4], ["B-2", 2, 1], ["C-3", 0, 0]]);
});

test("no financial field reaches the find and move views", () => {
  const G = setup();
  stock(G, "a", 3, { name: "Rich Card" });
  G.state.cards[0].imageUrl = "https://cards.scryfall.io/normal/front/a/b/ab.jpg";
  const MONEY = { words: /price|cost|revenue|cogs|fee|earning|payment|margin|profit|value|net\b|\$/i, numbers: [9.99, 7.25, 1.5] };
  const no = (what, v) => assert.deepEqual(moneyLeaks(v, MONEY), [], what + " carries a financial field");
  const rec = G.state.cards[0];
  assert.ok(rec.avgCost > 0 && rec.price > 0, "the source really has money in it");
  no("rfFindCards", G.rfFindCards("rich"));
  no("rfCardWhere", G.rfCardWhere(G.rfFindCards("rich").printings[0].printing));
  no("rfBinList", G.rfBinList(""));
  no("rfBinView", G.rfBinView("a"));
  no("rfStack", G.rfStack(rec.id));
  no("rfMoveCheck", G.rfMoveCheck(rec.id, "b", 1));
  no("rfMoveCards", G.rfMoveCards(rec.id, "b", 1));
});
