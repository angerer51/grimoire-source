"use strict";
/* #309: saved decks (core.js "Saved decks"). A deck is a saved deck or a
   Deck Box location no saved deck lives in; a saved deck keeps its whole
   list, so what its location lacks shows as missing. merge.js keys the
   collection by id so two devices' saves merge. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { freshCore } = require("../test-lib/core-shim");
const merge = require(path.join(__dirname, "..", "server", "lib", "merge"));

function world() {
  const G = freshCore();
  G.state.locations.push(G.newLocation({ id: "BOX", name: "Atraxa", type: "Deck Box" }));
  G.state.locations.push(G.newLocation({ id: "KRENKO", name: "Krenko box", type: "Deck Box" }));
  G.state.locations.push(G.newLocation({ id: "BINDER", name: "Binder", type: "Binder" }));
  return G;
}
// Objects from core.js live in its own vm realm: compare their plain copies.
const plain = v => JSON.parse(JSON.stringify(v));
let n = 0;
function stack(G, locationId, name, quantity, price) {
  const r = { id: "r" + (++n), name, set: "c21", collector: String(n), lang: "en", finish: "nonfoil", condition: "NM",
    quantity, listedQty: 0, price: price == null ? 1 : price, locationId, costQty: 0, costTotal: 0, avgCost: null };
  G.state.cards.push(r);
  return r;
}

test("Build's deck record keeps the list with quantities and commander flags", () => {
  const G = world();
  const d = G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", format: "commander", source: "build",
    lines: [{ name: "Atraxa, Praetors' Voice", qty: 1, commander: true }, { name: "Sol Ring", qty: 1 }] });
  assert.equal(G.state.decks.length, 1);
  assert.equal(d.name, "Atraxa");
  assert.equal(d.locationId, "BOX");
  assert.equal(d.format, "commander");
  assert.equal(d.source, "build");
  assert.ok(d.id && d.createdAt && d.updatedAt);
  assert.deepEqual(plain(d.lines), [
    { name: "Atraxa, Praetors' Voice", qty: 1, commander: true },
    { name: "Sol Ring", qty: 1, commander: false }
  ]);
});

test("building into a saved deck's location in replace mode swaps its list, without a second deck", () => {
  const G = world();
  const first = G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }] });
  const again = G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", mode: "replace", lines: [{ name: "Arcane Signet", qty: 1 }] });
  assert.equal(G.state.decks.length, 1);
  assert.equal(again.id, first.id);
  assert.equal(G.deckByLocation("BOX").id, first.id);
  assert.deepEqual(plain(G.state.decks[0].lines.map(l => l.name)), ["Arcane Signet"]);
});

test("building into a saved deck's location in add mode adds to its list: same name sums, commander kept from either side", () => {
  const G = world();
  G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", format: "commander", lines: [
    { name: "Atraxa, Praetors' Voice", qty: 1, commander: true }, { name: "Sol Ring", qty: 1 }, { name: "Island", qty: 10 }] });
  const d = G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", mode: "add", lines: [
    { name: "island", qty: 2 }, { name: "Atraxa, Praetors' Voice", qty: 1 }, { name: "Sol Ring", qty: 1, commander: true },
    { name: "Arcane Signet", qty: 1 }] });
  assert.equal(G.state.decks.length, 1);
  assert.equal(d.format, "commander", "an add with no format picked keeps the deck's");
  assert.deepEqual(plain(d.lines), [
    { name: "Atraxa, Praetors' Voice", qty: 2, commander: true },
    { name: "Sol Ring", qty: 2, commander: true },
    { name: "Island", qty: 12, commander: false },
    { name: "Arcane Signet", qty: 1, commander: false }
  ]);
});

/* Add mode plans the moves for the deck's list plus the paste (owner,
   2026-10-18): copies already in the box count toward the bigger list, so
   adding a 4th copy of a card the box holds 3 of moves one in. */
function boltDeck(G, inBinder) {
  stack(G, "BOX", "Lightning Bolt", 3, 1);
  if (inBinder) stack(G, "BINDER", "Lightning Bolt", inBinder, 1);
  return G.saveBuiltDeck({ name: "Burn", locationId: "BOX", lines: [{ name: "Lightning Bolt", qty: 3 }] });
}
test("add mode: 3 in the box + 1 more on the list plans 1 move, and the deck then misses nothing", () => {
  const G = world();
  const d = boltDeck(G, 2);
  const paste = [{ name: "Lightning Bolt", qty: 1 }];
  const plan = G.deckPlan(G.mergeDeckLines(d.lines, paste), "BOX");
  assert.equal(plan.moving, 1);
  assert.equal(plan.inDest, 3);
  assert.equal(plan.lines[0].pulls[0].locationId, "BINDER");
  assert.equal(plan.lines[0].shortfall, 0);
  assert.equal(G.deckPlan(paste, "BOX").moving, 0, "the paste alone would move nothing (the bug)");
  // Move it as Build does, then save the deck in add mode.
  const r = plan.lines[0].pulls[0].record;
  r.quantity -= 1;
  stack(G, "BOX", "Lightning Bolt", 1, 1);
  G.saveBuiltDeck({ name: "Burn", locationId: "BOX", mode: "add", lines: paste });
  const e = G.deckEntries().find(x => x.deck);
  assert.equal(e.listed, 4);
  assert.equal(e.have, 4);
  assert.equal(e.short, 0);
});
test("add mode with too few copies anywhere: the extra line is short and the deck shows it missing", () => {
  const G = world();
  const d = boltDeck(G, 0);
  const plan = G.deckPlan(G.mergeDeckLines(d.lines, [{ name: "Lightning Bolt", qty: 1 }]), "BOX");
  assert.equal(plan.moving, 0);
  assert.equal(plan.lines[0].shortfall, 1);
  G.saveBuiltDeck({ name: "Burn", locationId: "BOX", mode: "add", lines: [{ name: "Lightning Bolt", qty: 1 }] });
  assert.equal(G.deckEntries().find(x => x.deck).short, 1);
});

test("Deck Box locations show as decks; one with a saved deck in it shows once, as the saved deck", () => {
  const G = world();
  G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }] });
  const e = G.deckEntries();
  assert.deepEqual(plain(e.map(x => [x.name, !!x.deck]).sort()), [["Atraxa", true], ["Krenko box", false]]);
  assert.ok(!e.some(x => x.locationId === "BINDER"), "a binder isn't a deck");
  assert.equal(e.find(x => !x.deck).key, "loc:KRENKO");
});

test("a deck counts its cards, value and what its list is missing, across printings by name", () => {
  const G = world();
  stack(G, "BOX", "Sol Ring", 1, 2);
  stack(G, "BOX", "Lightning Bolt", 1, 0.5);
  stack(G, "BOX", "lightning bolt", 1, 0.5);   // another printing
  stack(G, "BINDER", "Lightning Bolt", 4, 0.5); // elsewhere: doesn't count
  stack(G, "BOX", "Island", 3, 0.1);           // not on the list: still in the deck
  G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [
    { name: "Sol Ring", qty: 1 }, { name: "Lightning Bolt", qty: 4 }, { name: "Mana Crypt", qty: 1 }] });
  const e = G.deckEntries().find(x => x.deck);
  assert.equal(e.have, 6);
  assert.equal(e.listed, 6);
  assert.equal(e.value, 3.3);
  assert.deepEqual(plain(e.missing), [
    { name: "Lightning Bolt", qty: 4, have: 2, short: 2 },
    { name: "Mana Crypt", qty: 1, have: 0, short: 1 }
  ]);
  assert.equal(e.short, 3);
  const box = G.deckEntries().find(x => !x.deck);
  assert.equal(box.listed, null);
  assert.equal(box.short, 0, "a plain Deck Box has no list, so nothing missing");
});

test("a saved deck whose location was deleted still lists, with no location and every card missing", () => {
  const G = world();
  stack(G, "BOX", "Sol Ring", 1);
  G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }] });
  G.state.locations = G.state.locations.filter(l => l.id !== "BOX");
  const e = G.deckEntries().find(x => x.deck);
  assert.equal(e.location, null);
  assert.equal(e.have, 0);
  assert.equal(e.short, 1);
});

test("deleting a saved deck never touches cards", () => {
  const G = world();
  stack(G, "BOX", "Sol Ring", 1);
  const d = G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }] });
  assert.equal(G.deleteDeck(d.id), true);
  assert.equal(G.state.decks.length, 0);
  assert.equal(G.state.cards.length, 1);
  assert.equal(G.state.cards[0].locationId, "BOX");
  assert.equal(G.deleteDeck(d.id), false);
});

test("saved decks are part of the saved document: a load keeps them and Undo brings a deleted one back", () => {
  const G = world();
  const d = G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }] });
  G.persist("seed");
  G.deleteDeck(d.id);
  G.persist("Delete deck");
  assert.equal(G.state.decks.length, 0);
  G.undo();
  assert.deepEqual(JSON.parse(JSON.stringify(G.state.decks)), [JSON.parse(JSON.stringify(d))]);
  const G2 = freshCore();
  G2.adoptState({ decks: [d, { name: "No id yet", lines: [{ name: "Sol Ring", qty: "2" }, { name: "", qty: 1 }] }] });
  assert.equal(G2.state.decks[0].id, d.id);
  assert.ok(G2.state.decks[1].id, "a record without an id gets one");
  assert.deepEqual(plain(G2.state.decks[1].lines), [{ name: "Sol Ring", qty: 2, commander: false }]);
  assert.equal(G2.PATCH_KEYS.decks, "id", "patch saves send decks row by row, keyed as merge.js keys them");
});

test("merge.js: two devices each saving a deck keep both, and an edit and a delete of different decks both apply", () => {
  assert.equal(merge.MERGE_ARRAYS.decks.key, "id");
  const a = { id: "dA", name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1, commander: false }] };
  const b = { id: "dB", name: "Krenko", locationId: "KRENKO", lines: [] };
  const c = { id: "dC", name: "Edgar", locationId: "X", lines: [] };
  let r = merge.merge({ decks: [] }, { decks: [a] }, { decks: [b] });
  assert.deepEqual(r.merged.decks.map(d => d.id).sort(), ["dA", "dB"]);
  const a2 = Object.assign({}, a, { lines: [{ name: "Arcane Signet", qty: 1, commander: false }] });
  r = merge.merge({ decks: [a, c] }, { decks: [a2, c] }, { decks: [a] });
  assert.deepEqual(r.merged.decks.map(d => d.id), ["dA"], "their delete of dC stands");
  assert.equal(r.merged.decks[0].lines[0].name, "Arcane Signet", "my edit to dA stands");
});

/* #310: Add a deck I got, and the Manapool helpers. */
const info = (name, collector) => ({ name, collector, setName: 'Set', rarity: 'rare', tcgplayerId: '', scryfallId: 'sf-' + collector,
  price: 2, priceNote: '', note: '', meta: {} });
const entry = (name, set, collector, qty, extra) => Object.assign({ name, set, collector, lang: 'en', finish: 'nonfoil', qty, info: info(name, collector) }, extra || {});
const inBox = (G, loc) => G.state.cards.filter(r => r.locationId === loc).reduce((s, r) => s + r.quantity, 0);

test('gotDeckPlan: lines add the copies their printings cover; the rest has no printing and is left out', () => {
  const G = world();
  G.addToDeckList('Sol Ring', 1, { set: 'C21', collector: '0263' });
  G.addToDeckList('Sol Ring', 1);
  G.addToDeckList('Mana Crypt', 1);
  G.addToDeckList('Ragavan, Nimble Pilferer', 2, { set: 'mh2', collector: '138', finish: 'foil', commander: true });
  const plan = plain(G.gotDeckPlan(G.state.deckList));
  assert.deepEqual(plan.printed, [
    { name: 'Sol Ring', set: 'c21', collector: '0263', finish: 'nonfoil', qty: 1, commander: false },
    { name: 'Ragavan, Nimble Pilferer', set: 'mh2', collector: '138', finish: 'foil', qty: 2, commander: true }]);
  assert.deepEqual(plan.loose, [{ name: 'Sol Ring', qty: 1 }, { name: 'Mana Crypt', qty: 1 }]);
});

test('addGotDeck adds new stock in the destination, audits it, and saves a deck with source got', async () => {
  const G = freshCore({ fetch: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ entries: [], total: 0 }) }) });
  G.state.locations.push(G.newLocation({ id: 'BOX', name: 'Atraxa', type: 'Deck Box' }));
  G.state.locations.push(G.newLocation({ id: 'BINDER', name: 'Binder', type: 'Binder' }));
  stack(G, 'BINDER', 'Sol Ring', 3);   // the person's own copies elsewhere are untouched
  const out = G.addGotDeck({ name: 'Atraxa', locationId: 'BOX', format: 'commander', mode: 'add', entries: [
    entry('Sol Ring', 'c21', '263', 1), entry('Sol Ring', 'c21', '264', 1), entry("Atraxa, Praetors' Voice", 'c16', '28', 1, { commander: true })] });
  assert.equal(out.added, 3);
  assert.equal(inBox(G, 'BOX'), 3);
  assert.equal(inBox(G, 'BINDER'), 3);
  const d = G.state.decks[0];
  assert.equal(d.source, 'got');
  assert.equal(d.locationId, 'BOX');
  assert.equal(d.format, 'commander');
  assert.deepEqual(plain(d.lines), [{ name: 'Sol Ring', qty: 2, commander: false }, { name: "Atraxa, Praetors' Voice", qty: 1, commander: true }]);
  const e = G.deckEntries().find(x => x.deck === d);
  assert.equal(e.short, 0, 'nothing missing: the cards are really in the box');
  const adds = (await G.queryAudit({})).entries.filter(a => a.action === 'add' && a.to === 'Atraxa');
  assert.equal(adds.length, 3, 'one audit entry per stack added, as Receive writes');
});

test('addGotDeck into a box with a saved deck: add keeps its list and sums, replace swaps it', () => {
  const run = mode => {
    const G = world();
    G.saveBuiltDeck({ name: 'Atraxa', locationId: 'BOX', lines: [{ name: 'Sol Ring', qty: 1 }, { name: 'Mana Crypt', qty: 1 }] });
    G.addGotDeck({ name: 'Atraxa', locationId: 'BOX', mode, entries: [entry('Sol Ring', 'c21', '263', 1), entry('Arcane Signet', 'c21', '250', 1)] });
    assert.equal(G.state.decks.length, 1);
    assert.equal(inBox(G, 'BOX'), 2, 'new stock either way');
    return plain(G.state.decks[0].lines);
  };
  assert.deepEqual(run('add'), [{ name: 'Sol Ring', qty: 2, commander: false }, { name: 'Mana Crypt', qty: 1, commander: false },
    { name: 'Arcane Signet', qty: 1, commander: false }]);
  assert.deepEqual(run('replace'), [{ name: 'Sol Ring', qty: 1, commander: false }, { name: 'Arcane Signet', qty: 1, commander: false }]);
});

test('manapoolUrl is shared: a printing page, a name search, and the paste text', () => {
  const G = world();
  assert.equal(G.manapoolUrl('mh2', '138', 'Ragavan, Nimble Pilferer'), 'https://manapool.com/card/mh2/138/ragavan-nimble-pilferer');
  assert.equal(G.manapoolUrl('c16', '28', "Atraxa, Praetors' Voice"), 'https://manapool.com/card/c16/28/atraxa-praetors-voice');
  assert.equal(G.manapoolUrl('afr', '1', "Lim-D" + String.fromCharCode(251) + "l"), 'https://manapool.com/card/afr/1/lim-dul');
  assert.equal(G.manapoolSearchUrl('Lightning Bolt'), 'https://manapool.com/cards?q=Lightning%20Bolt');
  assert.equal(G.MANAPOOL_ADD_DECK, 'https://manapool.com/add-deck');
  assert.equal(G.manapoolPasteText([{ name: 'Lightning Bolt', qty: 2 }, { name: 'Sol Ring', qty: 1 }]), "2 Lightning Bolt\n1 Sol Ring");
});
