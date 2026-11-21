"use strict";
/* #336: lending. Lent copies stay in `quantity` (owned, in the total) and
   `loans` says who has them; everything asking what's free uses availableQty. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");
const priceRules = require("../server/lib/priceRules");

// core.js runs in its own VM realm: compare plain copies.
const plain = v => JSON.parse(JSON.stringify(v));

const L1 = { id: "L1", name: "Binder", type: "Binder", sellFrom: true };
const L2 = { id: "L2", name: "Box", type: "Box", sellFrom: true };
const card = over => Object.assign({
  id: "c1", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM",
  name: "Lightning Bolt", locationId: "L1", price: 2, quantity: 4, scryfallId: "sf1"
}, over);
const core = (cards, extra) => {
  const G = freshCore();
  G.adoptState(Object.assign({ locations: [L1, L2], cards }, extra || {}));
  return G;
};
const loan = (qty, to, due) => ({ id: "l-" + to + qty, qty, to, due: due || "", at: "2026-10-01T00:00:00.000Z" });
const openList = lines => ({ pickLists: [{ id: "P1", status: "open", source: "manual", created: "2026-10-01T00:00:00.000Z", lines }] });
const BOLT_LINE = { set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM", name: "Lightning Bolt" };

test("lent copies stay in the total and value but leave the available count", () => {
  const G = core([card()]);
  const r = G.state.cards[0];
  G.lendCopies(r, { qty: 3, to: "Sam" });
  assert.equal(r.quantity, 4);
  assert.equal(G.lentQty(r), 3);
  assert.equal(G.availableQty(r), 1);
  const s = G.summary(G.state.cards);
  assert.equal(s.cards, 4);
  assert.equal(s.value, 8);
});

test("a stack with no loans has no loans key, so saves don't grow", () => {
  const G = core([card()]);
  assert.equal("loans" in G.state.cards[0], false);
});

test("lending checks the name, the count and what's free", () => {
  const G = core([card({ quantity: 2, loans: [loan(1, "Ann")] })]);
  const r = G.state.cards[0];
  assert.throws(() => G.lendCopies(r, { qty: 1, to: "  " }), /who/);
  assert.throws(() => G.lendCopies(r, { qty: 0, to: "Sam" }), /at least 1/);
  assert.throws(() => G.lendCopies(r, { qty: 2, to: "Sam" }), /Only 1 free to lend, 1 already lent/);
  G.lendCopies(r, { qty: 1, to: "Sam" });
  assert.equal(G.availableQty(r), 0);
});

test("a copy an open pick list set aside can't be lent", () => {
  const G = core([card({ quantity: 2 })], openList([Object.assign({ qty: 2 }, BOLT_LINE)]));
  assert.throws(() => G.lendCopies(G.state.cards[0], { qty: 1, to: "Sam" }), /set aside for an open pick list/);
});

test("the pick allocation skips lent copies and reports the shortfall", () => {
  const G = core([card({ loans: [loan(3, "Sam")] })]);
  const out = plain(G.allocatePick(Object.assign({ qty: 2 }, BOLT_LINE)));
  assert.deepEqual(out.pulls.map(p => p.take), [1]);
  assert.equal(out.shortfall, 1);
});

test("open pick lists reserve only free copies, and a fully lent stack holds none", () => {
  const G = core([card({ id: "a", quantity: 2, loans: [loan(2, "Sam")] }), card({ id: "b", locationId: "L2", quantity: 2 })],
    openList([Object.assign({ qty: 1 }, BOLT_LINE)]));
  const m = G.pickAllocations();
  assert.equal(m.get("a") || 0, 0);
  assert.equal(m.get("b"), 1);
});

test("a lent copy is not listable, and a price push never lists it", () => {
  const G = core([card({ listedQty: 4, loans: [loan(3, "Sam")] })]);
  const r = G.state.cards[0];
  assert.equal(G.listableQty(r, new Map()), 1);
  assert.equal(G.pricePushQuantity(G.manapoolIdentityKey(r), 4, new Map()), 1);
});

test("the listing plan shows a lent copy as neither held nor sold, and takes it down", () => {
  const G = core([card({ listedQty: 4, loans: [loan(3, "Sam")] })]);
  const line = G.listingPlan({ includeUnchanged: true })[0];
  assert.deepEqual([line.have, line.reserved, line.available, line.target, line.delta], [1, 0, 1, 1, -3]);
});

test("the server's scheduled price push leaves lent copies out too", () => {
  const c = card({ loans: [loan(3, "Sam")] });
  const state = { locations: [L1], pickLists: [], cards: [c] };
  assert.equal(priceRules.availableQty(c), 1);
  const key = core([c]).manapoolIdentityKey(c);
  assert.equal(priceRules.freeToListByIdentity(state, new Set([key])).get(key), 1);
});

test("the Deck List plan pulls only free copies", () => {
  const G = core([card({ loans: [loan(3, "Sam")] })]);
  const line = plain(G.deckPlan([{ name: "Lightning Bolt", qty: 4 }], null)).lines[0];
  assert.equal(line.pulls.reduce((s, p) => s + p.take, 0), 1);
  assert.equal(line.shortfall, 3);
});

test("wanted-card availability leaves lent copies out", () => {
  const G = core([card({ loans: [loan(3, "Sam")] })]);
  assert.equal(G.wantAvailability([{ id: "w1", name: "Lightning Bolt" }], G.state.cards).get("w1"), 1);
});

test("merging stacks keeps both sets of loans, whichever record wins, and counts the copies", () => {
  const G = core([card()]);
  G.state.cards = [
    card({ id: "a", quantity: 2, listedQty: 0, loans: [loan(1, "Sam")] }),
    // The fuller record wins the card data; its loans must not replace the other's.
    card({ id: "b", quantity: 3, listedQty: 0, imageUrl: "x", typeLine: "Instant", oracleId: "o", loans: [loan(2, "Ann")] }),
    card({ id: "c", quantity: 1, listedQty: 0 })
  ];
  G.normalizeMerge({ silent: true });
  assert.equal(G.state.cards.length, 1);
  const r = G.state.cards[0];
  assert.equal(r.quantity, 6);
  assert.deepEqual(plain(r.loans).map(l => [l.to, l.qty]), [["Sam", 1], ["Ann", 2]]);
  assert.equal(G.availableQty(r), 3);
});

test("two loans to one person with one date read as a single line", () => {
  const G = core([card()]);
  const r = G.state.cards[0];
  G.lendCopies(r, { qty: 1, to: "Sam", due: "2026-12-01" });
  G.lendCopies(r, { qty: 1, to: "sam", due: "2026-12-01" });
  G.lendCopies(r, { qty: 1, to: "Sam" });
  assert.deepEqual(plain(r.loans).map(l => [l.to, l.qty, l.due]), [["Sam", 2, "2026-12-01"], ["Sam", 1, ""]]);
});

test("a stack moved whole merges into the destination with its loans", () => {
  const G = core([card({ id: "a", quantity: 2, loans: [loan(1, "Sam")] }), card({ id: "b", locationId: "L2", quantity: 1 })]);
  G.state.cards[0].locationId = "L2";
  G.normalizeMerge({ silent: true });
  assert.equal(G.state.cards.length, 1);
  assert.equal(G.state.cards[0].quantity, 3);
  assert.equal(G.lentQty(G.state.cards[0]), 1);
});

test("a split takes the free copies first; only overflow carries a loan", () => {
  const G = core([card({ quantity: 4, loans: [loan(2, "Sam")] })]);
  const rec = G.state.cards[0];
  const move = n => {
    const clone = Object.assign({}, rec, { id: "x" + n, quantity: n });
    rec.quantity -= n;
    G.splitLoans(rec, clone);
    return clone;
  };
  const a = move(2);
  assert.equal("loans" in a, false);
  assert.equal(G.lentQty(rec), 2);
  const b = move(1);                    // rec keeps 1, so one lent copy goes along
  assert.equal(G.lentQty(rec), 1);
  assert.equal(G.lentQty(b), 1);
  assert.equal(plain(b.loans)[0].to, "Sam");
});

test("putaway splitting a stack doesn't duplicate its loans", () => {
  const G = core([card({ quantity: 3, loans: [loan(1, "Sam")] })]);
  G.applyPutawayLines([{ record: G.state.cards[0], picks: [{ locationId: "L2", name: "Box", take: 2, reason: [] }], shortfall: 0 }], "Putaway");
  assert.equal(G.state.cards.reduce((s, r) => s + G.lentQty(r), 0), 1);
  assert.equal(G.state.cards.reduce((s, r) => s + r.quantity, 0), 3);
});

test("mark returned: part of a loan, then the rest", () => {
  const G = core([card({ loans: [loan(3, "Sam")] })]);
  const r = G.state.cards[0];
  const id = r.loans[0].id;
  assert.deepEqual(plain(G.returnLoan(r, id, 1)), { qty: 1, to: "Sam" });
  assert.equal(G.lentQty(r), 2);
  assert.equal(G.availableQty(r), 2);
  assert.deepEqual(plain(G.returnLoan(r, id)), { qty: 2, to: "Sam" });
  assert.equal("loans" in r, false);
  assert.equal(r.quantity, 4);
  assert.equal(G.returnLoan(r, id), null);
});

test("overdue starts the day after the give-back date; no date is never overdue", () => {
  const G = core([card()]);
  assert.equal(G.loanOverdue({ due: "2026-10-30" }, "2026-10-31"), true);
  assert.equal(G.loanOverdue({ due: "2026-10-31" }, "2026-10-31"), false);
  assert.equal(G.loanOverdue({ due: "2026-11-01" }, "2026-10-31"), false);
  assert.equal(G.loanOverdue({ due: "" }, "2026-10-31"), false);
});

test("the Lent out list puts overdue first, then soonest date, then no date", () => {
  const G = core([card({ loans: [loan(1, "NoDate"), loan(1, "Soon", "2999-01-01"), loan(1, "Later", "2999-06-01"), loan(1, "Late", "2000-01-01")] })]);
  assert.deepEqual(plain(G.allLoans()).map(x => [x.loan.to, x.overdue]),
    [["Late", true], ["Soon", false], ["Later", false], ["NoDate", false]]);
});

test("name suggestions put friends first, then past borrowers, without repeats", () => {
  const G = core([card({ loans: [loan(1, "Sam"), loan(1, "Zed")] })]);
  assert.deepEqual(plain(G.loanNameSuggestions(["Ann", "sam"])), ["Ann", "sam", "Zed"]);
});

test("loans round trip through a save and a reload", () => {
  const G = core([card()]);
  G.lendCopies(G.state.cards[0], { qty: 2, to: "Sam", due: "2026-12-01" });
  const back = core(plain(G.state.cards)).state.cards[0];
  assert.deepEqual(plain(back.loans), plain(G.state.cards[0].loans));
  assert.equal(back.quantity, 4);
  assert.equal(G.availableQty(back), 2);
});

test("a bad or too-big loan on load is cleaned up, never more lent than owned", () => {
  const G = core([card({ quantity: 2, loans: [{ qty: 5, to: "Sam", due: "soon" }, { qty: 1, to: "" }, { qty: 0, to: "Ann" }, "junk"] })]);
  const r = plain(G.state.cards[0].loans);
  assert.equal(r.length, 1);
  assert.equal(r[0].qty, 2);
  assert.equal(r[0].due, "");
});

test("a transfer file carries only free copies and no loans", () => {
  const G = core([card({ loans: [loan(3, "Sam")] })]);
  const doc = plain(G.buildTransfer(G.state.cards, { qtyOf: G.availableQty }));
  assert.equal(doc.totalCards, 1);
  assert.equal("loans" in doc.lines[0], false);
});

test("a recorded trade can't give away a lent copy", async () => {
  const G = core([card({ quantity: 2, loans: [loan(2, "Sam")] })]);
  await assert.rejects(async () => G.recordTrade({ gave: [{ id: "c1", qty: 1 }], got: [], locationId: "L1" }),
    /You only have 0 of Lightning Bolt that aren't lent out/);
});

test("a recount counts the shelf: lent copies aren't found missing, and stay owned", async () => {
  const G = core([card({ quantity: 4, loans: [loan(3, "Sam")] })]);
  await G.applyCycleCountAdjustments("L1", [{ recordId: "c1", countedQty: 1 }]);
  assert.equal(G.state.cards[0].quantity, 4);
  await G.applyCycleCountAdjustments("L1", [{ recordId: "c1", countedQty: 0 }]);
  assert.equal(G.state.cards[0].quantity, 3);
  assert.equal(G.lentQty(G.state.cards[0]), 3);
});

test("a chase pick that finds nothing keeps the lent copies", () => {
  const G = core([card({ quantity: 3, loans: [loan(2, "Sam")] })]);
  G.chasePickAdjust("c1", 0, "test");
  assert.equal(G.state.cards[0].quantity, 2);
  assert.equal(G.lentQty(G.state.cards[0]), 2);
});

test("undoing an add can't take back a lent copy", () => {
  const G = core([card({ quantity: 2, loans: [loan(2, "Sam")] })]);
  const out = G.undoAuditEntry({ action: "add", to: "Binder", qty: 1, name: "Lightning Bolt", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM" });
  assert.equal(out.ok, false);
  assert.equal(G.state.cards[0].quantity, 2);
});

test("the TCGplayer listing file never offers a lent copy", () => {
  const G = core([card({ listedQty: 4, loans: [loan(4, "Sam")] })]);
  assert.throws(() => G.exportTcgCsv(), /No cards are listed/);
});

test("a batched pull sheet pulls only free copies and shows the later order short", () => {
  const list = id => ({ id, status: "open", source: "manual", created: "2026-10-01T00:00:00.000Z", lines: [Object.assign({ qty: 1 }, BOLT_LINE)] });
  const G = core([card({ loans: [loan(3, "Sam")] })], { pickLists: [list("P1"), list("P2")] });
  const id = G.createPickBatch(["P1", "P2"]);
  const rows = plain(G.pickBatchSheet(id).rows);
  assert.deepEqual(rows.filter(r => r.kind === "pull").map(r => r.qty), [1]);
  assert.deepEqual(rows.filter(r => r.kind === "short").map(r => r.qty), [1]);
});

test("a card lent out of a built deck shows the deck as short, and it stays owned", () => {
  const box = { id: "D1", name: "Deck box", type: "Deck Box" };
  const G = core([card({ locationId: "D1", quantity: 4, loans: [loan(1, "Sam")] })], {
    locations: [L1, box],
    decks: [{ id: "deck1", name: "Burn", locationId: "D1", lines: [{ name: "Lightning Bolt", qty: 4 }] }]
  });
  const e = G.deckEntries().find(x => x.deck);
  assert.equal(e.short, 1);
  assert.equal(e.have, 3);
  assert.deepEqual(plain(e.missing), [{ name: "Lightning Bolt", qty: 4, have: 3, short: 1 }]);
  assert.equal(G.state.cards[0].quantity, 4);
  G.returnLoan(G.state.cards[0], G.state.cards[0].loans[0].id);
  assert.equal(G.deckEntries().find(x => x.deck).short, 0);
});
