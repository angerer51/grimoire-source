"use strict";
/* Warehouse Mode's cycle count (#389), on the real core.js: the list of what's
   waiting, the blind view, the one-recount rule's yes/no, and the post through
   the desk's own full count. No number from the book and no money on a view. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshCore, APP_DIR } = require("../test-lib/core-shim");
const { moneyLeaks } = require("../test-lib/no-money");

const INFO = (name, num) => ({ name, collector: num || "1", setName: "Set", rarity: "common", tcgplayerId: "1", scryfallId: "s", price: 7.25, priceNote: "", note: "", meta: {} });
const FOUND_CARD = { name: "Found Thing", collector: "9", setName: "Set", rarity: "common", set: "tst", prices: { usd: "1.5" } };
function setup() {
  const G = freshCore({ fetch: async url => {
    const u = String(url);
    const body = u.startsWith("/api/cards/one") ? { card: FOUND_CARD } : { entries: [], total: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  } });
  for (const [id, name] of [["a", "A-1"], ["b", "B-2"], ["c", "C-3"]]) G.state.locations.push(G.newLocation({ id, name, type: "Box", sellFrom: true }));
  return G;
}
function stock(G, locationId, qty, card) {
  const c = Object.assign({ set: "tst", num: "1", name: "Sol Ring", lang: "en", finish: "nonfoil", condition: "NM" }, card);
  G.addCopies({ set: c.set, num: c.num, lang: c.lang, finish: c.finish, condition: c.condition, locationId, qty, info: Object.assign(INFO(c.name, c.num), { collector: c.num }),
    unitCost: 1.5, action: "receipt", receiptId: "T1", note: "" });
}
const plain = x => JSON.parse(JSON.stringify(x));
const countsOf = (bin, n) => bin.stacks.map(s => ({ recordId: s.id, sig: s.sig, counted: typeof n === "function" ? n(s) : n }));
const qtyOf = (G, name) => G.state.cards.filter(r => r.name === name).reduce((s, r) => s + r.quantity, 0);

test("the list: short-pick bins first, then bins the desk sent, each oldest first", () => {
  const G = setup();
  stock(G, "a", 2); stock(G, "b", 2, { num: "2", name: "Two" }); stock(G, "c", 2, { num: "3", name: "Three" });
  G.requestBinCount("a", "Sent from the desk", "cards", "desk");
  G.state.locations.find(l => l.id === "a").countWanted.at = "2026-11-01T00:00:00Z";
  G.requestBinCount("b", "Short pick on #1", "cards");
  G.state.locations.find(l => l.id === "b").countWanted.at = "2026-11-03T00:00:00Z";
  G.requestBinCount("c", "Short pick on #2", "sealed");
  G.state.locations.find(l => l.id === "c").countWantedSealed.at = "2026-11-02T00:00:00Z";
  const t = plain(G.rfCountTasks());
  assert.deepEqual(t.map(x => x.id), ["c|sealed", "b|cards", "a|cards"]);
  assert.deepEqual(t.map(x => x.desk), [false, false, true]);
  assert.doesNotMatch(JSON.stringify(t), /Short pick on|Sent from|reason/, "no reason text, no names of tickets");
});

test("Count next bin is the desk's own rotation pick, most overdue bin first", () => {
  const G = setup();
  stock(G, "a", 1); stock(G, "b", 1, { num: "2", name: "Two" });
  assert.equal(G.rfCountNext("cards") && ["a", "b"].includes(G.rfCountNext("cards").locationId), true);
  assert.equal(G.rfCountNext("sealed"), null, "no sealed anywhere");
  G.addSealedCopies({ tcgplayerProductId: "7", name: "Box", setCode: "tst", locationId: "c", qty: 1, price: 9 });
  assert.equal(G.rfCountNext("sealed").locationId, "c");
  assert.equal(G.rfCountNext("sealed").kind, "sealed");
});

test("the blind view names each stack and never carries the book's number or a price", () => {
  const G = setup();
  stock(G, "a", 4, { name: "Sol Ring" });
  stock(G, "a", 3, { name: "Sol Ring", finish: "foil" });
  stock(G, "a", 5, { name: "Arcane", num: "5" });
  G.state.cards[0].imageUrl = "https://cards.scryfall.io/normal/front/a/b/ab.jpg";
  const bin = G.rfCountBin("a", "cards");
  assert.deepEqual(plain(bin.stacks.map(s => s.name + "/" + s.finish)), ["Arcane/nonfoil", "Sol Ring/foil", "Sol Ring/nonfoil"]);
  assert.ok(bin.stacks.every(s => s.condition === "NM" && s.set === "TST"));
  const keys = [...new Set(bin.stacks.flatMap(s => Object.keys(s)))].sort();
  assert.deepEqual(keys, ["collector", "condition", "finish", "id", "image", "lang", "name", "sealed", "set", "sig"]);
  const text = JSON.stringify(plain(bin));
  assert.doesNotMatch(text, /price|cost|value|7\.25|1\.5\b|quantity|book|onShelf/i);
  assert.doesNotMatch(text.replace(/"sig":"[^"]*"/g, ""), /[:"]\s*[345][,}]/, "none of the stack quantities (4, 3, 5) is on it");
});

test("a copy in a tote or lent out isn't asked about; a stack with nothing on the shelf is left out", () => {
  const G = setup();
  stock(G, "a", 2, { name: "Lent" });
  stock(G, "a", 1, { name: "Here", num: "2" });
  const rec = G.state.cards.find(r => r.name === "Lent");
  rec.loans = [{ id: "l1", qty: 2, to: "Pat", at: "2026-11-01T00:00:00Z" }];
  assert.deepEqual(plain(G.rfCountBin("a", "cards").stacks.map(s => s.name)), ["Here"]);
});

test("rfCountMatches answers yes or no and nothing more", () => {
  const G = setup();
  stock(G, "a", 4);
  const id = G.state.cards[0].id;
  assert.equal(G.rfCountMatches("cards", id, 4), true);
  assert.equal(G.rfCountMatches("cards", id, "4"), true);
  assert.equal(G.rfCountMatches("cards", id, 3), false);
  assert.equal(G.rfCountMatches("cards", "nope", 4), false);
});

test("posting: a differing count adjusts the stack and logs it; a matching one touches nothing; the bin is stamped and leaves the list", async () => {
  const G = setup();
  stock(G, "a", 4, { name: "Off" });
  stock(G, "a", 2, { name: "Right", num: "2" });
  G.requestBinCount("a", "Short pick on #1", "cards");
  G.requestBinCount("a", "Short pick on #1", "sealed");
  const bin = G.rfCountBin("a", "cards");
  const res = await G.rfCountPost({ locationId: "a", kind: "cards", counts: countsOf(bin, s => (s.name === "Off" ? 3 : 2)) });
  assert.equal(res.ok, true);
  assert.equal(res.adjusted, 1);
  assert.equal(res.clean, false);
  assert.equal(qtyOf(G, "Off"), 3);
  assert.equal(qtyOf(G, "Right"), 2);
  const loc = G.state.locations.find(l => l.id === "a");
  assert.ok(loc.lastCycleCountAt, "stamped counted");
  assert.equal(loc.countWanted, null, "the card task closes");
  assert.ok(loc.countWantedSealed, "the sealed task is a separate one");
  assert.ok(!loc.lastSealedCycleCountAt);
  const q = await G.queryAudit({ limit: 20 });
  assert.ok(q.entries.some(e => /Cycle count adjustment/.test(e.note || "")), "logged");
  assert.equal(G.state.history.filter(h => h.type === "cycle-count-full").pop().via, "rf");
});

test("a clean count and an empty bin both close the task and stamp the bin", async () => {
  const G = setup();
  stock(G, "a", 4);
  G.requestBinCount("a", "Sent from the desk", "cards", "desk");
  G.requestBinCount("b", "Sent from the desk", "cards", "desk");
  const clean = await G.rfCountPost({ locationId: "a", kind: "cards", counts: countsOf(G.rfCountBin("a", "cards"), 4) });
  assert.deepEqual([clean.ok, clean.clean, clean.adjusted, clean.added], [true, true, 0, 0]);
  const empty = await G.rfCountPost({ locationId: "b", kind: "cards", counts: [] });
  assert.deepEqual([empty.ok, empty.clean], [true, true]);
  for (const id of ["a", "b"]) {
    const l = G.state.locations.find(x => x.id === id);
    assert.ok(l.lastCycleCountAt); assert.equal(l.countWanted, null);
  }
  assert.equal(G.rfCountTasks().length, 0);
});

test("a card found that the book doesn't have is added to the bin, logged as found, with a cost of nothing", async () => {
  const G = setup();
  stock(G, "a", 1);
  const res = await G.rfCountPost({ locationId: "a", kind: "cards", counts: countsOf(G.rfCountBin("a", "cards"), 1),
    found: [{ set: "tst", collector: "9", lang: "en", finish: "nonfoil", condition: "LP", qty: 2 }] });
  assert.deepEqual([res.ok, res.added], [true, 1]);
  const f = G.state.cards.find(r => r.name === "Found Thing");
  assert.equal(f.quantity, 2);
  assert.equal(f.locationId, "a");
  assert.equal(f.condition, "LP");
  assert.ok(!(f.costTotal > 0), "no cost invented");
  const q = await G.queryAudit({ limit: 20 });
  assert.ok(q.entries.some(e => /Found during cycle count/.test(e.note || "")));
});

test("copies in a tote stay on the book: the count is of the shelf, as at the desk", async () => {
  const G = setup();
  stock(G, "a", 5);
  const p = G.newPickList({ source: "manual", orderId: "o1", orderLabel: "#1" });
  G.pickLists().push(p);
  G.addToPickList(p.id, { kind: "card", set: "tst", collector: "1", lang: "en", finish: "nonfoil", condition: "NM", name: "Sol Ring", qty: 2 });
  const rec = G.state.cards[0];
  p.rfPulls = [{ key: "k", recordId: rec.id, locationId: "a", name: "Sol Ring", qty: 2 }];
  const bin = G.rfCountBin("a", "cards");
  assert.equal(G.rfCountMatches("cards", rec.id, 3), true, "3 on the shelf is right");
  const res = await G.rfCountPost({ locationId: "a", kind: "cards", counts: countsOf(bin, 3) });
  assert.equal(res.ok, true);
  assert.equal(res.clean, true);
  assert.equal(rec.quantity, 5, "the 2 in the tote are still on the book");
});

test("stock that moved while counting refuses the post and changes nothing", async () => {
  const G = setup();
  stock(G, "a", 4);
  const bin = G.rfCountBin("a", "cards");
  G.state.cards[0].quantity = 6;                       // the desk edited it meanwhile
  const res = await G.rfCountPost({ locationId: "a", kind: "cards", counts: countsOf(bin, 4) });
  assert.deepEqual([res.ok, res.problem], [false, "changed"]);
  assert.equal(G.state.cards[0].quantity, 6);
  const fresh = G.rfCountBin("a", "cards");
  stock(G, "a", 1, { name: "Late", num: "7" });        // a new stack appeared
  const res2 = await G.rfCountPost({ locationId: "a", kind: "cards", counts: countsOf(fresh, 6) });
  assert.equal(res2.problem, "changed");
});

test("sealed is counted apart: its own list, its own stamp, found product added", async () => {
  const G = setup();
  stock(G, "a", 3);
  G.addSealedCopies({ tcgplayerProductId: "7", name: "Box", setCode: "tst", locationId: "a", qty: 4, price: 120 });
  G.requestBinCount("a", "Short pick on #5", "sealed");
  const bin = G.rfCountBin("a", "sealed");
  assert.equal(bin.kind, "sealed");
  assert.deepEqual(plain(bin.stacks.map(s => [s.name, s.sealed])), [["Box", true]]);
  assert.match(bin.stacks[0].image, /tcgplayer-cdn.*7_200w/);
  assert.deepEqual(moneyLeaks(bin, { words: /price/i, numbers: [120] }), []);
  const res = await G.rfCountPost({ locationId: "a", kind: "sealed", counts: countsOf(bin, 3),
    found: [{ tcgplayerProductId: "8", manapoolProductId: "", name: "Bundle", setCode: "tst", marketPrice: 30, qty: 2 }] });
  assert.deepEqual([res.ok, res.adjusted, res.added], [true, 1, 1]);
  assert.equal(G.state.sealed.find(r => r.name === "Box").quantity, 3);
  assert.equal(G.state.sealed.find(r => r.name === "Bundle").quantity, 2);
  const loc = G.state.locations.find(l => l.id === "a");
  assert.ok(loc.lastSealedCycleCountAt);
  assert.ok(!loc.lastCycleCountAt, "the card count date is untouched");
  assert.equal(loc.countWantedSealed, null);
  assert.equal(G.state.history.filter(h => h.type === "cycle-count-full-sealed").length, 1);
});

test("a picker's Finish landing mid-count doesn't stop the post: the shelf didn't change", async () => {
  const G = setup();
  stock(G, "a", 5);
  const p = G.newPickList({ source: "manual", orderId: "o1", orderLabel: "#1" });
  G.pickLists().push(p);
  G.addToPickList(p.id, { kind: "card", set: "tst", collector: "1", lang: "en", finish: "nonfoil", condition: "NM", name: "Sol Ring", qty: 2 });
  const rec = G.state.cards[0];
  p.rfPulls = [{ key: "k", recordId: rec.id, locationId: "a", name: "Sol Ring", qty: 2 }];
  const bin = G.rfCountBin("a", "cards");
  rec.quantity = 3;                                    // Finish: the book drops by what was in the tote...
  p.rfPulls = [];                                      // ...and the tote empties
  const res = await G.rfCountPost({ locationId: "a", kind: "cards", counts: countsOf(bin, 3) });
  assert.deepEqual([res.ok, res.clean], [true, true]);
  assert.equal(rec.quantity, 3);
});

test("a stack whose shelf really changed mid-count is the only one whose tag moves", () => {
  const G = setup();
  stock(G, "a", 5, { name: "One", num: "1" });
  stock(G, "a", 2, { name: "Two", num: "2" });
  const before = G.rfCountBin("a", "cards");
  G.state.cards.find(r => r.name === "Two").quantity = 1;
  const after = G.rfCountBin("a", "cards");
  const sigs = bin => Object.fromEntries(plain(bin.stacks).map(s => [s.name, s.sig]));
  assert.equal(sigs(before).One, sigs(after).One);
  assert.notEqual(sigs(before).Two, sigs(after).Two);
});

test("the count page reads no financial field off anything", () => {
  const code = fs.readFileSync(path.join(APP_DIR, "public/rf/count.page.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(price|unitPrice|avgCost|costTotal|costQty|revenue|cogs|fees?|earnings|orderPayment|shippingRevenue)\b/);
});
