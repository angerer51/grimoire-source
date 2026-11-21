"use strict";
/* #117 / #118: Deck List's Build, through the real deck-list.page.js with a
   stand-in DOM (test-lib/page-shim.js). The allocation rules themselves are
   in core.deckPlan.test.js; this checks the page uses them for the chosen
   destination and that a cancelled Build leaves nothing behind. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

function deckPage() {
  const pg = loadPage("deck-list.page.js", { routes: () => ({}) });
  const G = pg.G;
  G.state.locations.push(G.newLocation({ id: "BOX", name: "Atraxa", type: "Deck Box" }));
  G.state.locations.push(G.newLocation({ id: "BINDER", name: "Binder", type: "binder" }));
  G.state.locations.push(G.newLocation({ id: "SELL", name: "Sell box", type: "bin", sellFrom: true }));
  const stack = (id, locationId, quantity, listedQty) => G.state.cards.push({ id, name: "Sol Ring", set: "c21", collector: "263",
    lang: "en", finish: "nonfoil", condition: "NM", quantity, listedQty: listedQty || 0, price: 2, locationId,
    costQty: 0, costTotal: 0, avgCost: null });
  stack("inBox", "BOX", 1);
  stack("inBinder", "BINDER", 1);
  G.state.deckList = [{ name: "Sol Ring", qty: 1 }];
  return { pg, G, stack };
}
const qtyAt = (G, loc) => G.state.cards.filter(r => r.locationId === loc && r.name === "Sol Ring").reduce((s, r) => s + r.quantity, 0);

test("Build into a box that already holds the card moves nothing more, as the preview said (#117)", async () => {
  const { pg, G } = deckPage();
  await pg.boot();
  pg.$("deckDest").value = "BOX";
  await pg.$("deckDest").fire("change");
  const row = pg.$("deckBody").children[0];
  assert.match(row.innerHTML, /Atraxa \(already there\): 1/);
  assert.match(row.innerHTML, /ok-tag">OK/);
  await pg.$("deckBuild").fire("click");
  assert.match(pg.ui.confirms[0], /1 card\(s\) already in "Atraxa" count toward the deck/);
  assert.equal(qtyAt(G, "BOX"), 1, "the box doesn't end up with 2");
  assert.equal(qtyAt(G, "BINDER"), 1);
});

test("Build names the other deck it would take cards from, and can leave those lines short (#334)", async () => {
  const { pg, G } = deckPage();
  G.state.cards = G.state.cards.filter(r => r.id !== "inBinder");   // the only copy is in the Atraxa deck
  await pg.boot();
  pg.$("deckDest").value = "SELL";
  pg.ui.confirmDialog = async (msg, opts) => { pg.ui.confirms.push(msg); return opts && opts.altLabel && /Leave them/.test(opts.altLabel) ? "alt" : false; };
  await pg.$("deckBuild").fire("click");
  assert.match(pg.ui.confirms[0], /out of those decks:\n\n- "Atraxa": Sol Ring ×1/);
  assert.match(pg.ui.confirms[1], /do not have enough copies/, "the leave-short plan moves nothing");
  assert.equal(qtyAt(G, "BOX"), 1, "the Atraxa deck keeps its card");
});

test("Leave them skips every other deck, not just the one the warning named (#334)", async () => {
  const { pg, G, stack } = deckPage();
  G.state.locations.push(G.newLocation({ id: "BOX2", name: "Golgari", type: "Deck Box" }));
  stack("inBox2", "BOX2", 1);
  G.state.cards = G.state.cards.filter(r => r.id !== "inBinder");   // Sol Ring only in two decks
  await pg.boot();
  pg.$("deckDest").value = "SELL";
  pg.ui.confirmDialog = async (msg, opts) => { pg.ui.confirms.push(msg); return opts && opts.altLabel && /Leave them/.test(opts.altLabel) ? "alt" : false; };
  await pg.$("deckBuild").fire("click");
  assert.match(pg.ui.confirms[1], /do not have enough copies/, "the second deck isn't raided after Leave them");
  assert.equal(qtyAt(G, "BOX"), 1);
  assert.equal(qtyAt(G, "BOX2"), 1);
});

test("Build takes a loose copy before one sitting in a deck (#334)", async () => {
  const { pg, G } = deckPage();   // Sol Ring: 1 in the Atraxa deck, 1 loose in the Binder
  await pg.boot();
  pg.$("deckDest").value = "SELL";
  pg.ui.confirmAnswer = false;
  await pg.$("deckBuild").fire("click");
  assert.doesNotMatch(pg.ui.confirms[0], /other decks/, "no warning when a loose copy covers it");
  const plan = G.deckPlan([{ name: "Sol Ring", qty: 1 }], "SELL");
  assert.equal(plan.lines[0].pulls[0].locationId, "BINDER");
});

test("changing Destination redraws the preview for it (#117)", async () => {
  const { pg } = deckPage();
  await pg.boot();
  pg.$("deckDest").value = "BOX";
  await pg.$("deckDest").fire("change");
  assert.match(pg.$("deckBody").children[0].innerHTML, /already there/);
  pg.$("deckDest").value = "SELL";
  await pg.$("deckDest").fire("change");
  const html = pg.$("deckBody").children[0].innerHTML;
  assert.doesNotMatch(html, /already there/);
  assert.match(html, /(Atraxa \(a deck\)<\/span>|Binder): 1/, "a copy from another location would move into the sell box");
});

test("the confirm says when listed copies will move (#117)", async () => {
  const { pg, G, stack } = deckPage();
  G.state.cards = [];
  stack("listed", "SELL", 2, 2);
  G.state.deckList = [{ name: "Sol Ring", qty: 1 }];
  await pg.boot();
  pg.$("deckDest").value = "BOX";
  pg.ui.confirmAnswer = false;
  await pg.$("deckBuild").fire("click");
  assert.match(pg.ui.confirms[0], /1 listed copy will move\. Push Listings afterwards to delist it\./);
});

test("cancelling Build to a new deck location leaves no location behind, and the retry works (#118)", async () => {
  const { pg, G } = deckPage();
  G.state.cards = G.state.cards.filter(r => r.id !== "inBox");   // no other deck to warn about
  await pg.boot();
  const before = G.state.locations.length;
  pg.$("deckDest").value = "__new";
  pg.$("deckNewName").value = "Krenko";
  pg.ui.confirmAnswer = false;
  await pg.$("deckBuild").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.equal(G.state.locations.length, before, "nothing created on Cancel");
  pg.ui.confirmAnswer = true;
  await pg.$("deckBuild").fire("click");
  assert.equal(pg.ui.confirms.length, 2, "the retry reached the confirm instead of 'already exists'");
  const made = G.state.locations.find(l => l.name === "Krenko");
  assert.ok(made, "created once the confirm was accepted");
  assert.equal(qtyAt(G, made.id), 1);
});

test("Build stops if the cards changed while the confirm was open", async () => {
  const { pg, G } = deckPage();
  G.state.cards = G.state.cards.filter(r => r.id !== "inBox");   // no other deck to warn about
  await pg.boot();
  pg.$("deckDest").value = "SELL";
  pg.ui.confirmDialog = async () => { G.state.cards.forEach(r => { r.quantity = 0; }); return true; };
  await pg.$("deckBuild").fire("click");
  assert.match(pg.$("deckProgress").innerHTML, /changed while the confirm was open/);
  assert.equal(G.state.deckList.length, 1, "nothing was built");
});

test("a burst of change events redraws the deck once (#118)", async () => {
  const { pg, G } = deckPage();
  await pg.boot();
  let draws = 0;
  const body = pg.$("deckBody");
  let html = "";
  Object.defineProperty(body, "innerHTML", { get: () => html, set: v => { html = v; draws++; } });
  for (let i = 0; i < 20; i++) G.emit("change");
  assert.equal(draws, 0, "nothing drawn synchronously per event");
  await settle(250);
  assert.equal(draws, 1);
});

/* #309: Build saves the deck; My decks lists saved decks and Deck Box
   locations; a deck's cards open in a slide-over with what's missing. */
const openDeckRow = async (pg, key) => {
  const body = pg.$("decksBody");
  body.closest = () => ({ dataset: { key } });   // the clicked row
  await body.fire("click");
  delete body.closest;
};

test("Build saves the deck with its whole list, missing cards included, and shows My decks (#309)", async () => {
  const { pg, G } = deckPage();
  G.state.deckList = [{ name: "Sol Ring", qty: 1, commander: true }, { name: "Mana Crypt", qty: 1 }];
  G.state.settings.deckFormat = "commander";
  await pg.boot();
  assert.equal(pg.$("paneNew").hidden, false, "a list in progress opens New deck");
  pg.$("deckDest").value = "__new";
  pg.$("deckNewName").value = "Krenko";
  await pg.$("deckBuild").fire("click");
  assert.equal(G.state.decks.length, 1);
  const d = G.state.decks[0];
  const made = G.state.locations.find(l => l.name === "Krenko");
  assert.equal(d.name, "Krenko");
  assert.equal(d.locationId, made.id);
  assert.equal(d.format, "commander");
  assert.equal(d.source, "build");
  assert.deepEqual(JSON.parse(JSON.stringify(d.lines)),
    [{ name: "Sol Ring", qty: 1, commander: true }, { name: "Mana Crypt", qty: 1, commander: false }]);
  assert.equal(pg.$("paneDecks").hidden, false, "switched to My decks");
  const rows = pg.$("decksBody").innerHTML;
  assert.match(rows, /Krenko/);
  assert.match(rows, /Atraxa/, "the Deck Box location shows as a deck too");
  assert.match(rows, /short-tag">1</, "Mana Crypt is missing");
});

/* Build into a box that already holds a saved deck asks each time: add to
   its list (the main button) or replace it (the second button, "alt"). */
async function buildIntoSavedDeck(answer) {
  const { pg, G } = deckPage();
  G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }, { name: "Mana Crypt", qty: 1 }] });
  G.state.deckList = [{ name: "Sol Ring", qty: 1 }, { name: "Arcane Signet", qty: 1 }];
  await pg.boot();
  pg.$("deckDest").value = "BOX";
  await pg.$("deckDest").fire("change");
  const asked = [];
  pg.ui.confirmDialog = async (msg, opts) => { asked.push({ msg, opts }); return answer; };
  await pg.$("deckBuild").fire("click");
  return { G, asked, lines: () => JSON.parse(JSON.stringify(G.state.decks[0].lines)) };
}

test("Build into a saved deck's box offers Add or Replace, with real card counts (#309)", async () => {
  const { asked } = await buildIntoSavedDeck(false);
  assert.equal(asked.length, 1);
  assert.match(asked[0].msg, /already holds the saved deck "Atraxa" \(2 cards in its list\)/);
  assert.equal(asked[0].opts.okLabel, "Add these cards to Atraxa's list");
  assert.equal(asked[0].opts.altLabel, "Replace its list (2 cards → 2)");
});

test("Add (the main button) adds the built cards to the saved deck's list (#309)", async () => {
  const { G, lines } = await buildIntoSavedDeck(true);
  assert.equal(G.state.decks.length, 1);
  assert.deepEqual(lines(), [{ name: "Sol Ring", qty: 2, commander: false }, { name: "Mana Crypt", qty: 1, commander: false },
    { name: "Arcane Signet", qty: 1, commander: false }]);
});

test("Replace swaps the saved deck's list for the built one (#309)", async () => {
  const { G, lines } = await buildIntoSavedDeck("alt");
  assert.equal(G.state.decks.length, 1);
  assert.deepEqual(lines(), [{ name: "Sol Ring", qty: 1, commander: false }, { name: "Arcane Signet", qty: 1, commander: false }]);
});

test("Cancel on that choice changes neither the deck nor the cards (#309)", async () => {
  const { G, lines } = await buildIntoSavedDeck(false);
  assert.deepEqual(lines().map(l => l.name), ["Sol Ring", "Mana Crypt"]);
  assert.equal(G.state.deckList.length, 2, "nothing was built");
});

/* Add plans the moves for the deck's list plus the paste: a box holding 3
   Lightning Bolt (its list says 3) + "1 Lightning Bolt" moves 1 more in. */
async function addOneBolt(spareInBinder) {
  const { pg, G } = deckPage();
  const bolt = (id, locationId, quantity) => G.state.cards.push({ id, name: "Lightning Bolt", set: "m10", collector: "146",
    lang: "en", finish: "nonfoil", condition: "NM", quantity, listedQty: 0, price: 1, locationId, costQty: 0, costTotal: 0, avgCost: null });
  G.state.cards = [];
  bolt("boxBolts", "BOX", 3);
  if (spareInBinder) bolt("binderBolts", "BINDER", spareInBinder);
  G.saveBuiltDeck({ name: "Burn", locationId: "BOX", lines: [{ name: "Lightning Bolt", qty: 3 }] });
  G.state.deckList = [{ name: "Lightning Bolt", qty: 1 }];
  await pg.boot();
  pg.$("deckDest").value = "BOX";
  await pg.$("deckDest").fire("change");
  pg.ui.confirmAnswer = true;   // Add
  await pg.$("deckBuild").fire("click");
  const boltsIn = loc => G.state.cards.filter(r => r.locationId === loc && r.name === "Lightning Bolt").reduce((s, r) => s + r.quantity, 0);
  return { pg, G, boltsIn, deck: G.deckEntries().find(x => x.deck) };
}

test("Add with 3 already in the box and 1 more pasted moves 1 in: list 4, nothing missing (#309)", async () => {
  const { pg, G, boltsIn, deck } = await addOneBolt(2);
  assert.match(pg.ui.confirms[0], /Add these cards to its list: its list becomes 4 cards and 1 card moves in\./);
  assert.match(pg.ui.confirms[0], /Replace its list: its list becomes 1 card and 0 cards move in\./);
  assert.equal(boltsIn("BOX"), 4);
  assert.equal(boltsIn("BINDER"), 1);
  assert.equal(deck.listed, 4);
  assert.equal(deck.short, 0);
  assert.equal(G.state.history[0].totalCards, 1);
  assert.match(pg.ui.toasts.at(-1), /moved 1 card in\. /);
});

test("Add with no spare copy anywhere moves nothing and shows the 4th as missing (#309)", async () => {
  const { pg, boltsIn, deck } = await addOneBolt(0);
  assert.match(pg.ui.confirms[0], /its list becomes 4 cards and 0 cards move in, 1 line short\./);
  assert.equal(boltsIn("BOX"), 3);
  assert.equal(deck.listed, 4);
  assert.equal(deck.short, 1);
  assert.match(pg.ui.toasts.at(-1), /moved 0 cards in, 1 line\(s\) short/);
});

test("Build into a box with no saved deck asks the plain question (#309)", async () => {
  const { pg } = deckPage();
  await pg.boot();
  pg.$("deckDest").value = "BOX";
  let opts = null;
  pg.ui.confirmDialog = async (msg, o) => { opts = o; return false; };
  await pg.$("deckBuild").fire("click");
  assert.equal(opts.altLabel, undefined);
  assert.equal(opts.okLabel, undefined);
});

test("cancelling Build saves no deck (#309)", async () => {
  const { pg, G } = deckPage();
  await pg.boot();
  pg.$("deckDest").value = "BOX";
  pg.ui.confirmAnswer = false;
  await pg.$("deckBuild").fire("click");
  assert.equal(G.state.decks.length, 0);
});

test("a deck's slide-over lists its cards and what's missing, and Delete keeps the cards (#309)", async () => {
  const { pg, G } = deckPage();
  G.state.deckList = [];
  G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }, { name: "Mana Crypt", qty: 2 }] });
  await pg.boot();
  assert.equal(pg.$("paneDecks").hidden, false, "no list in progress: My decks");
  await openDeckRow(pg, G.state.decks[0].id);
  assert.match(pg.$("deckDetail").innerHTML, /1 of 3 cards/);
  assert.match(pg.$("deckDetail").innerHTML, /2 missing/);
  const shown = pg.$("dpBody").children.map(tr => tr.innerHTML).join("\n");
  assert.match(shown, /Mana Crypt .*not here.*short-tag">short 2/);
  assert.match(shown, /Sol Ring/);
  await pg.$("dpDelete").fire("click");
  assert.match(pg.ui.confirms[0], /cards stay where they are/);
  assert.match(pg.ui.confirms[0], /"Atraxa" is a Deck Box location, so it will still show under My decks/,
    "says why the deck doesn't vanish from the list");
  assert.equal(G.state.decks.length, 0);
  assert.equal(qtyAt(G, "BOX"), 1, "the card is still in the box");
});

test("All deck cards lists every card in every deck, with search (#309)", async () => {
  const { pg, G } = deckPage();
  G.state.deckList = [];
  G.saveBuiltDeck({ name: "Binder deck", locationId: "BINDER", lines: [{ name: "Sol Ring", qty: 1 }] });
  await pg.boot();
  await pg.$("tabCards").fire("click");
  const body = pg.$("deckCardsBody");
  const decksOf = () => body.children.map(tr => (tr.innerHTML.match(/<td>([^<]*)<\/td>$/) || [])[1]).sort();
  assert.deepEqual(decksOf(), ["Atraxa", "Binder deck"], "the box's card and the saved deck's card; the sell box isn't a deck");
  pg.$("deckCardsSearch").value = "binder";
  await pg.$("deckCardsSearch").fire("input");
  assert.deepEqual(decksOf(), ["Binder deck"]);
});

/* #310: "Add a deck I got" adds the pasted cards as NEW stock (the Receive
   lookup + add path) and saves the deck with source "got". A line with no
   printing gets a picker with no default; the owner chooses. */
const CARDS = { "c21/263": "Sol Ring", "m10/146": "Lightning Bolt", "c16/28": "Atraxa, Praetors' Voice" };
const PRINTINGS = { "mana crypt": [
  { name: "Mana Crypt", set: "lea", collector: "1", setName: "Alpha", lang: "en", releasedAt: "1993-08-05", usd: "900.00" },
  { name: "Mana Crypt", set: "2xm", collector: "270", setName: "Double Masters", lang: "en", releasedAt: "2020-08-07", usd: "180.00" }] };
function gotPage(opts) {
  const pg = loadPage("deck-list.page.js", { routes: url => {
    const p = /\/api\/cards\/printings\?name=(.+)$/.exec(url);
    if (p && opts && opts.failPrintings) return { __status: 500, error: "Server restarting" };
    if (p) return { data: PRINTINGS[decodeURIComponent(p[1]).toLowerCase()] || [] };
    const m = /\/api\/cards\/one\?set=([^&]+)&num=([^&]+)/.exec(url);
    if (!m) return {};
    const key = m[1] + "/" + m[2];
    const name = CARDS[key] || (PRINTINGS["mana crypt"].find(c => c.set + "/" + c.collector === key) || {}).name;
    return name ? { card: { id: "sf-" + m[1] + m[2], name, set: m[1], collector: m[2], setName: m[1].toUpperCase(), rarity: "rare", usd: "2.00", usdFoil: "5.00" } }
      : { __status: 404, error: "Not found" };
  } });
  const G = pg.G;
  G.state.locations.push(G.newLocation({ id: "BOX", name: "Atraxa", type: "Deck Box" }));
  G.state.locations.push(G.newLocation({ id: "BINDER", name: "Binder", type: "binder" }));
  G.state.cards.push({ id: "mine", name: "Sol Ring", set: "c21", collector: "263", lang: "en", finish: "nonfoil", condition: "NM",
    quantity: 3, listedQty: 0, price: 2, locationId: "BINDER", costQty: 0, costTotal: 0, avgCost: null });
  G.state.deckList = [];
  return { pg, G };
}
async function pasteGot(pg, text) {
  await pg.boot();
  await pg.$("tabNew").fire("click");
  await pg.$("modeGot").fire("click");
  pg.$("deckPaste").value = text;
  await pg.$("deckAdd").fire("click");
  pg.$("deckDest").value = "BOX";
  await settle(20);   // the printing checks and picker lists load
}
const PASTE = "1 Sol Ring (C21) 263\n2 Lightning Bolt (M10) 146 *F*";
const qtyIn = (G, loc) => G.state.cards.filter(r => r.locationId === loc).reduce((s, r) => s + r.quantity, 0);
const rowsHtml = pg => pg.$("deckBody").children.map(tr => tr.innerHTML).join("\n");
// Act on a <select> in the preview as the person would.
const choose = async (pg, attr, name, value) => {
  const box = pg.$("deckBody");
  box.closest = () => ({ dataset: { [attr]: name }, value });
  await box.fire("change");
  delete box.closest;
  await settle(20);
};
const removeLine = async (pg, i) => {
  const tr = pg.$("deckBody").children[i];
  const td = tr.children[tr.children.length - 1];
  await td.children[td.children.length - 1].onclick();
};

test("Add a deck I got adds new stock in the destination and saves a deck with source got (#310)", async () => {
  const { pg, G } = gotPage();
  await pasteGot(pg, PASTE);
  assert.equal(pg.$("modeGot").classList.contains("active"), true);
  assert.equal(pg.$("deckGot").hidden, false);
  assert.equal(pg.$("deckBuild").hidden, true);
  assert.equal(pg.$("deckGot").disabled, false, "every line has a printing");
  await pg.$("deckGot").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /Add 3 cards \(2 printings\) to your stock as new copies in "Atraxa"/);
  assert.doesNotMatch(pg.ui.confirms[0], /Skipped/);
  assert.equal(qtyIn(G, "BOX"), 3, "new copies in the box");
  assert.equal(qtyIn(G, "BINDER"), 3, "the person's other copies are untouched");
  const foil = G.state.cards.find(r => r.locationId === "BOX" && r.name === "Lightning Bolt");
  assert.equal(foil.finish, "foil");
  assert.equal(foil.price, 5);
  const d = G.state.decks[0];
  assert.equal(d.source, "got");
  assert.equal(d.locationId, "BOX");
  assert.deepEqual(JSON.parse(JSON.stringify(d.lines)),
    [{ name: "Sol Ring", qty: 1, commander: false }, { name: "Lightning Bolt", qty: 2, commander: false }]);
  assert.equal(G.state.deckList.length, 0);
  assert.equal(pg.$("paneDecks").hidden, false, "switched to My decks");
  assert.match(pg.ui.toasts[pg.ui.toasts.length - 1], /Added "Atraxa": 3 new cards in stock\. It's saved under My decks/);
});

test("a line with no printing gets a picker with no default; Add waits until it is picked (#310)", async () => {
  const { pg, G } = gotPage();
  await pasteGot(pg, PASTE + "\n1 Mana Crypt");
  assert.match(rowsHtml(pg), /<option value="">Choose printing…<\/option>/);
  assert.match(rowsHtml(pg), /Alpha/);
  assert.doesNotMatch(rowsHtml(pg), /<option value="d+" selected>/, "nothing is chosen for them");
  assert.equal(pg.$("deckGot").disabled, true);
  assert.equal(pg.$("gotNote").hidden, false);
  assert.equal(pg.$("gotNote").textContent, "1 card still needs a printing");
  await pg.$("deckGot").fire("click");
  assert.equal(pg.ui.confirms.length, 0, "can't add yet");
  await choose(pg, "pick", "Mana Crypt", "1");   // the 2XM printing
  assert.equal(pg.$("deckGot").disabled, false);
  assert.equal(pg.$("gotNote").hidden, true);
  assert.match(rowsHtml(pg), /<option value="1" selected>/, "the pick survives the redraw");
  await pg.$("deckGot").fire("click");
  const crypt = G.state.cards.find(r => r.locationId === "BOX" && r.name === "Mana Crypt");
  assert.equal(crypt.set, "2xm", "the printing that was picked is the one added");
  assert.equal(crypt.finish, "nonfoil");
  assert.deepEqual(JSON.parse(JSON.stringify(G.state.decks[0].lines.map(l => [l.name, l.qty]))),
    [["Sol Ring", 1], ["Lightning Bolt", 2], ["Mana Crypt", 1]]);
});

test("a picked printing can be changed, and a line's foil mark is the finish unless changed (#310)", async () => {
  const { pg, G } = gotPage();
  await pasteGot(pg, "1 Mana Crypt *F*");
  await choose(pg, "pick", "Mana Crypt", "0");
  assert.match(rowsHtml(pg), /<option value="foil" selected>/);
  await choose(pg, "pick", "Mana Crypt", "1");
  assert.equal(G.state.deckList[0].prints.length, 1, "the new pick replaces the old one");
  await choose(pg, "finish", "Mana Crypt", "etched");
  await pg.$("deckGot").fire("click");
  const crypt = G.state.cards.find(r => r.name === "Mana Crypt");
  assert.equal(crypt.set, "2xm");
  assert.equal(crypt.finish, "etched");
});

test("a printing that isn't in the card database must be re-chosen, and a line can be removed instead (#310)", async () => {
  const { pg, G } = gotPage();
  await pasteGot(pg, "1 Sol Ring (C21) 263\n1 Mana Crypt (ZZZ) 9");
  assert.equal(pg.$("deckGot").disabled, true);
  assert.equal(pg.$("gotNote").textContent, "1 card still needs a printing");
  await removeLine(pg, 1);
  await settle(20);
  assert.equal(G.state.deckList.length, 1);
  assert.equal(pg.$("deckGot").disabled, false);
});

test("a name that matches no card can only be removed (#310)", async () => {
  const { pg, G } = gotPage();
  await pasteGot(pg, "1 Sol Ring (C21) 263\n1 Sol Rnig");
  assert.match(rowsHtml(pg), /No card by this name — check the spelling or remove the line/);
  assert.doesNotMatch(rowsHtml(pg), /data-pick="Sol Rnig"/, "no picker for it");
  assert.equal(pg.$("deckGot").disabled, true);
  await pg.$("deckGot").fire("click");
  assert.equal(pg.ui.confirms.length, 0);
  await removeLine(pg, 1);
  await settle(20);
  assert.equal(pg.$("deckGot").disabled, false);
  await pg.$("deckGot").fire("click");
  assert.equal(G.state.decks[0].lines.length, 1);
});

test("cancelling Add a deck I got changes nothing (#310)", async () => {
  const { pg, G } = gotPage();
  await pasteGot(pg, PASTE);
  pg.ui.confirmAnswer = false;
  await pg.$("deckGot").fire("click");
  assert.equal(qtyIn(G, "BOX"), 0);
  assert.equal(G.state.decks.length, 0);
  assert.equal(G.state.deckList.length, 2, "the list is still there");
});

test("Add a deck I got into a box with a saved deck asks Add or Replace (#310)", async () => {
  for (const [answer, want] of [[true, [["Sol Ring", 2], ["Mana Crypt", 1]]], ["alt", [["Sol Ring", 1]]]]) {
    const { pg, G } = gotPage();
    G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }, { name: "Mana Crypt", qty: 1 }] });
    await pasteGot(pg, "1 Sol Ring (C21) 263");
    const asked = [];
    pg.ui.confirmDialog = async (msg, opts) => { asked.push({ msg, opts }); return answer; };
    await pg.$("deckGot").fire("click");
    assert.match(asked[0].msg, /already holds the saved deck "Atraxa" \(2 cards in its list\)/);
    assert.equal(asked[0].opts.okLabel, "Add these cards to Atraxa's list");
    assert.equal(asked[0].opts.altLabel, "Replace its list (2 cards → 1)");
    assert.equal(G.state.decks.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(G.state.decks[0].lines.map(l => [l.name, l.qty]))), want);
    assert.equal(qtyIn(G, "BOX"), 1, "the card is added to stock either way");
  }
});

/* #310: missing cards get a Manapool link and a tick box; Buy copies the
   ticked ones and opens Manapool's paste page. */
function buyPage(clipboard) {
  const { pg, G } = gotPage();
  const copied = [], opened = [];
  pg.sandbox.navigator.clipboard = clipboard || { writeText: async t => { copied.push(t); } };
  pg.sandbox.open = (...a) => { opened.push(a); };
  return { pg, G, copied, opened };
}
const tick = async (box, name, checked) => {
  box.closest = () => ({ dataset: { tick: name }, checked });
  await box.fire("change");
  delete box.closest;
};

test("the New deck preview links missing cards to Manapool and Buy copies the ticked ones (#310)", async () => {
  const { pg, G, copied, opened } = buyPage();
  G.state.deckList = [{ name: "Sol Ring", qty: 5 }, { name: "Mana Crypt", qty: 1 }, { name: "Arcane Signet", qty: 2 }];
  await pg.boot();
  const rows = pg.$("deckBody").children.map(tr => tr.innerHTML).join("\n");
  assert.match(rows, /href="https:\/\/manapool\.com\/cards\?q=Mana%20Crypt"/);
  assert.match(rows, /data-tick="Arcane Signet"/);
  assert.equal(pg.$("deckBuy").disabled, true, "nothing ticked");
  await tick(pg.$("deckBody"), "Mana Crypt", true);
  await tick(pg.$("deckBody"), "Sol Ring", true);
  assert.equal(pg.$("deckBuy").disabled, false);
  await pg.$("deckBuy").fire("click");
  assert.deepEqual(copied, ["2 Sol Ring\n1 Mana Crypt"], "the missing amount per ticked line (3 Sol Ring owned, 5 wanted)");
  assert.equal(opened[0][0], "https://manapool.com/add-deck");
  assert.equal(opened[0][1], "_blank");
  assert.equal(opened[0][2], "noopener");
  assert.equal(pg.ui.toasts[pg.ui.toasts.length - 1], "Copied 3 cards. Paste them into Manapool's Mass Entry box.");
  await tick(pg.$("deckBody"), "Mana Crypt", false);
  await tick(pg.$("deckBody"), "Sol Ring", false);
  assert.equal(pg.$("deckBuy").disabled, true);
});

test("tick all ticks every missing line, and Buy shows the list when the copy is blocked (#310)", async () => {
  const { pg, G, opened } = buyPage({ writeText: async () => { throw new Error("blocked"); } });
  G.state.deckList = [{ name: "Mana Crypt", qty: 1 }, { name: "Arcane Signet", qty: 2 }];
  await pg.boot();
  pg.$("deckTickAll").checked = true;
  await pg.$("deckTickAll").fire("change");
  assert.equal(pg.$("deckBuy").disabled, false);
  await pg.$("deckBuy").fire("click");
  assert.equal(pg.$("deckBuyFallback").hidden, false);
  assert.equal(pg.$("deckBuyText").value, "1 Mana Crypt\n2 Arcane Signet");
  assert.equal(opened.length, 1, "the Manapool page still opens");
  assert.match(pg.ui.toasts[pg.ui.toasts.length - 1], /Couldn't copy automatically/);
});

test("a saved deck's slide-over has Manapool links, tick boxes and the Buy button (#310)", async () => {
  const { pg, G, copied, opened } = buyPage();
  G.state.cards.push({ id: "inbox", name: "Sol Ring", set: "c21", collector: "263", lang: "en", finish: "nonfoil", condition: "NM",
    quantity: 1, listedQty: 0, price: 2, locationId: "BOX", costQty: 0, costTotal: 0, avgCost: null });
  G.saveBuiltDeck({ name: "Atraxa", locationId: "BOX", lines: [{ name: "Sol Ring", qty: 1 }, { name: "Mana Crypt", qty: 2 }] });
  await pg.boot();
  await openDeckRow(pg, G.state.decks[0].id);
  const shown = pg.$("dpBody").children.map(tr => tr.innerHTML).join("\n");
  assert.match(shown, /data-tick="Mana Crypt"/);
  assert.match(shown, /href="https:\/\/manapool\.com\/cards\?q=Mana%20Crypt"/);
  assert.doesNotMatch(shown, /data-tick="Sol Ring"/, "only missing lines");
  assert.equal(pg.$("dpBuy").disabled, true);
  await tick(pg.$("deckDetail"), "Mana Crypt", true);
  assert.equal(pg.$("dpBuy").disabled, false);
  await pg.$("dpBuy").onclick();
  assert.deepEqual(copied, ["2 Mana Crypt"]);
  assert.equal(opened[0][0], "https://manapool.com/add-deck");
});

/* #314: lookups that finish never close the picker in use; a failed load is
   not remembered and can be retried. */
test("a lookup that finishes while a picker has focus waits for it to lose focus (#314)", async () => {
  const { pg } = gotPage();
  pg.sandbox.document.activeElement = { dataset: { pick: "Mana Crypt" } };
  await pasteGot(pg, "1 Mana Crypt");
  assert.match(rowsHtml(pg), /Loading printings/, "no redraw under the owner's hands");
  pg.sandbox.document.activeElement = null;
  await pg.$("deckBody").fire("focusout");
  await settle(60);
  assert.match(rowsHtml(pg), /<option value="">Choose printing…<\/option>/);
});

test("a failed printings load is not remembered: Retry loads it (#314)", async () => {
  const opts = { failPrintings: true };
  const { pg } = gotPage(opts);
  await pasteGot(pg, "1 Mana Crypt");
  assert.match(rowsHtml(pg), /Couldn't load printings/);
  assert.match(rowsHtml(pg), /data-retry="Mana Crypt"/);
  assert.equal(pg.$("deckGot").disabled, true);
  opts.failPrintings = false;
  const box = pg.$("deckBody");
  box.closest = () => ({ dataset: { retry: "Mana Crypt" } });
  await box.fire("click");
  delete box.closest;
  await settle(60);
  assert.match(rowsHtml(pg), /<option value="">Choose printing…<\/option>/);
  assert.doesNotMatch(rowsHtml(pg), /Couldn't load printings/);
});
