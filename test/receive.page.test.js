"use strict";
/* Receive through its real script (public/receive.page.js) with the
   page-shim's stand-in DOM. Not a browser.
   #235: a personal account with no location opening Receive gets "My
   Collection" made and selected, with a real link to Locations; an
   organization member's document is the Store's, so nothing is created;
   the "create a location" message is a link, not "the menu above". */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const PRINTINGS = [
  { name: "Sol Ring", set: "lea", setName: "Limited Edition Alpha", collector: "269", lang: "en", releasedAt: "1993-08-05", usd: 9000 },
  { name: "Sol Ring", set: "c21", setName: "Commander 2021", collector: "263", lang: "en", releasedAt: "2021-04-23", usd: 1.5 }
];

const BOX = { name: "Foundations Play Booster Box", setCode: "fdn", tcgplayerProductId: 555, manapoolProductId: "mp5", marketPrice: 20, lowPrice: 18 };

async function open(o) {
  o = o || {};
  const page = loadPage("receive.page.js", {
    routes: (url, init) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/auth/me") {
        return { user: { id: "u1", username: "u", orgId: o.org ? "o1" : null, orgRole: o.org ? "owner" : null },
          personalPrefs: o.org ? { simpleMode: false } : null };
      }
      if (url === "/api/collection" && method === "GET") {
        return { rev: 1, savedAt: null, owner: o.org ? "store:st1" : "u1",
          state: { cards: [], sealed: o.sealed || [], locations: o.locations || [],
            settings: Object.assign({ tutorialSeen: true, simpleMode: !!o.simple }, o.settings || {}) } };
      }
      if (url === "/api/collection" && method === "PUT") return { rev: 2, savedAt: "2026-10-16T00:00:00Z" };
      if (url.startsWith("/api/cards/printings")) return { data: PRINTINGS };
      if (url.startsWith("/api/sealed/search")) return { data: [BOX] };
      return {};
    }
  });
  if (o.search) page.sandbox.location.search = o.search;
  if (o.store) page.sandbox.localStorage = { getItem: k => (k in o.store ? o.store[k] : null), setItem: (k, v) => { o.store[k] = String(v); } };
  page.ui.Autocomplete = (id, list, pick) => { page.pickName = pick; };
  page.ui.CardPanel = () => ({ showCard() {}, message() {}, clear() {}, bump() {}, async showBySetNumber() { return null; } });
  page.ui.fillLocationSelect = (sel, cur) => {
    sel.innerHTML = page.G.state.locations.map(l => '<option value="' + l.id + '">' + l.name + "</option>").join("");
    if (cur) sel.value = cur; else if (page.G.state.locations.length) sel.value = page.G.state.locations[0].id;
  };
  await page.G.load();
  await page.boot();
  await settle(30);
  return page;
}

test("#235: no locations on a personal account -> My Collection made, selected, linked", async () => {
  const page = await open({ simple: true });
  const locs = page.G.state.locations;
  assert.deepEqual(Array.from(locs, l => l.name), ["My Collection"]);
  assert.equal(locs[0].type, "Other");
  assert.equal(page.$("inLoc").value, locs[0].id);
  const st = page.$("entryStatus");
  assert.match(st.innerHTML, /My Collection/);
  assert.match(st.innerHTML, /<a href="\/locations\.html">Locations page<\/a>/);
  assert.doesNotMatch(st.innerHTML, /menu above/);
  assert.equal(page.G.hasUnsaved(), true, "queued for the normal save");
});

test("#235: an account that already has a location is left alone", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "Box" }] });
  assert.deepEqual(Array.from(page.G.state.locations, l => l.name), ["Box"]);
  assert.doesNotMatch(page.$("entryStatus").innerHTML, /My Collection/);
});

test("#235: an organization member gets nothing created, and a link instead", async () => {
  const page = await open({ org: true });
  assert.equal(page.G.state.locations.length, 0);
  assert.match(page.$("entryStatus").innerHTML, /<a href="\/locations\.html">Locations page<\/a>/);
  assert.doesNotMatch(page.$("entryStatus").innerHTML, /menu above/);
});

test("#236: a name search starts on 'Choose a printing' with Add disabled until one is picked", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "Box" }] });
  await page.pickName("Sol Ring");
  await settle(10);
  const sel = page.$("inPrinting");
  assert.equal(sel.value, "", "no printing preselected (first is the Alpha one)");
  assert.match(sel.innerHTML, /Choose a printing…/);
  assert.equal(page.$("btnAdd").disabled, true);
  // each option says set name, year and price
  assert.match(sel.innerHTML, /Limited Edition Alpha · 1993 · \$9,000\.00/);
  assert.match(sel.innerHTML, /Commander 2021 · 2021 · \$1\.50/);
  // Enter on the form still cannot queue a card
  page.$("btnAdd").onclick();
  assert.match(page.$("entryStatus").textContent, /choose a printing first/);
  // newest first: Commander 2021 comes before Alpha (#324)
  assert.ok(sel.innerHTML.indexOf("Commander 2021") < sel.innerHTML.indexOf("Limited Edition Alpha"));
  // typing narrows the list and never picks for you
  page.$("inPrintFilter").value = "alpha";
  await page.$("inPrintFilter").fire("input");
  assert.doesNotMatch(sel.innerHTML, /Commander 2021/);
  assert.match(sel.innerHTML, /Limited Edition Alpha/);
  assert.equal(sel.value, "");
  assert.equal(page.$("btnAdd").disabled, true);
  page.$("inPrintFilter").value = "";
  await page.$("inPrintFilter").fire("input");
  sel.value = "0";
  sel.onchange();
  assert.equal(page.$("btnAdd").disabled, false);
  assert.equal(page.$("inSet").value, "c21");
  assert.equal(page.$("inNum").value, "263");
  sel.value = "";
  sel.onchange();
  assert.equal(page.$("btnAdd").disabled, true);
  assert.equal(page.$("inSet").value, "", "set and number cleared with the pick");
});

test("#236: set + number mode is not blocked by the printing placeholder", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "Box" }] });
  await page.pickName("Sol Ring");
  await settle(10);
  assert.equal(page.$("btnAdd").disabled, true);
  page.$("modeManual").onclick();
  assert.equal(page.$("btnAdd").disabled, false);
});

test("#240: Import a file is available in Simple mode, and a pasted list imports only set+number lines", async () => {
  const page = await open({ simple: true, locations: [{ id: "l1", name: "Box", type: "Box" }] });
  assert.equal(page.$("modeImport").hidden, false);
  page.$("modeImport").onclick();
  assert.equal(page.$("csvImportSection").hidden, false);
  page.$("pasteText").value = "Deck\n4 Lightning Bolt (M10) 146\n1 Sol Ring (C21) 263 *F*\n2 Counterspell\n\nLightning Bolt (LEA) 161";
  await page.$("pasteGo").onclick();
  assert.match(page.$("csvSummary").textContent, /3 valid · 1 skipped/);
  assert.match(page.$("csvDetail").innerHTML, /needs set \+ number: (&quot;|")2 Counterspell/);
  page.$("csvDest").value = "l1";
  page.$("csvFetch").checked = false;
  page.$("csvDest").onchange();
  await page.$("csvGo").onclick();
  await settle(20);
  const cards = page.G.state.cards;
  assert.equal(cards.length, 3);
  assert.equal(cards.find(c => c.set === "m10").quantity, 4);
  assert.equal(cards.find(c => c.set === "c21").finish, "foil");
  assert.equal(page.$("pasteText").value, "2 Counterspell", "only the rejected line stays");
  assert.match(page.$("csvDetail").innerHTML, /needs set/);
  assert.equal(page.$("pasteGo").disabled, false);
});

test("#244: ?mode=import (the Dashboard's Next steps link) opens the paste/file import", async () => {
  const page = await open({ search: "?mode=import", locations: [{ id: "l1", name: "Box", type: "box" }] });
  assert.equal(page.$("csvImportSection").hidden, false);
  assert.equal(page.$("entryFields").hidden, true);
  const plain = await open({ locations: [{ id: "l1", name: "Box", type: "box" }] });
  assert.equal(plain.$("csvImportSection").hidden, true, "without it, Receive opens on search as before");
});

test("#327: ManaBox / name-only CSV - normal finish, binders, cost, name matching with dropdowns", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "box" }] });
  const card = (name, set, collector, releasedAt, extra) => Object.assign(
    { name, set, setName: set.toUpperCase() + " name", setType: "expansion", collector, lang: "en", releasedAt, usd: 1, finishes: ["nonfoil", "foil"], borderColor: "black" }, extra);
  const index = {
    "sol ring": [card("Sol Ring", "cmm", "400", "2023-08-04"), card("Sol Ring", "c21", "263", "2021-04-23")],
    "counterspell": [card("Counterspell", "mh2", "267", "2021-06-18"), card("Counterspell", "mh2", "500", "2021-06-18", { borderColor: "borderless" }),
      card("Counterspell", "7ed", "67", "2001-04-11", { promo: true }), card("Counterspell", "lea", "54", "1993-08-05"),
      // newer than the real pick but not "regular": future release, The List, Secret Lair box
      card("Counterspell", "trc", "499", "2099-11-13"), card("Counterspell", "plst", "CLB-187", "2023-01-01", { setType: "masters" }),
      card("Counterspell", "sld", "9", "2024-01-01", { setType: "box" })],
    "brainstorm": [card("Brainstorm", "ice", "61", "1995-06-01")],
    "island": [card("Island", "neo", "1", "2022-02-18")]
  };
  let lookups = 0;
  page.G.cards.printings = async n => { lookups++; return index[n.toLowerCase()] || []; };
  page.G.cards.sets = async () => [{ code: "cmm", name: "Commander Masters" }, { code: "mh2", name: "Modern Horizons 2" }, { code: "ice", name: "Ice Age" },
    { code: "neo", name: "Kamigawa: Neon Dynasty" }];
  page.ui.setStatus = (id, t) => { page.$(id).textContent = t; };
  page.$("modeImport").onclick();
  page.$("csvFetch").checked = false;
  page.$("csvDest").value = "l1";
  const run = async csv => { page.G.pickFile = async () => ({ name: "x.csv", text: csv }); await page.$("csvPick").onclick(); await settle(10); };
  const pick = (i, v) => page.$("csvDetail").onchange({ target: { getAttribute: () => String(i), value: String(v) } });

  await run("Binder Name,Name,Set code,Set name,Collector number,Foil,Quantity,Purchase price,Condition\n" +
    "Staples,Sol Ring,cmm,Commander Masters,400,normal,2,1.50,near_mint\n" +
    "Trades,Brainstorm,ice,Ice Age,,foil,1,0.25,lightly_played\n");
  assert.match(page.$("csvSummary").textContent, /2 valid · 0 skipped/);
  assert.match(page.$("csvDetail").innerHTML, /2 new locations will be created from Binder Name: Staples, Trades/);
  assert.equal(page.$("csvGo").disabled, false);
  await page.$("csvGo").onclick();
  await settle(20);
  const sr = page.G.state.cards.find(c => c.set === "cmm");
  assert.equal(sr.finish, "nonfoil");
  assert.equal(sr.condition, "NM");
  assert.equal(sr.quantity, 2);
  assert.equal(page.G.locName(sr.locationId), "Staples");
  assert.equal(sr.avgCost, 1.5);
  assert.equal(sr.costTotal, 3);
  const bs = page.G.state.cards.find(c => c.set === "ice");
  assert.equal(bs.collector, "61");
  assert.equal(bs.finish, "foil");
  assert.equal(bs.condition, "LP");

  // Name-only sheet: a full set name resolves; several printings or no set need a pick; typos are skipped
  const before = page.G.state.cards.length;
  lookups = 0;
  await run("Card,Set,Qty,Foil?\nSol Ring,Commander Masters,1,\nCounterspell,Modern Horizons 2,1,\nCounterspell,,2,\nCounterspell,,1,\nCounterspel,Mystery Booster,1,\nSol Ring,Nowhere Set,1,\n");
  assert.equal(lookups, 3, "one lookup per distinct name");
  assert.match(page.$("csvSummary").textContent, /4 valid · 2 skipped/);
  const html = page.$("csvDetail").innerHTML;
  assert.match(html, /no card by that name: (&quot;|")Counterspel(&quot;|")/);
  assert.match(html, /no printing of Sol Ring in set/);
  assert.match(html, /Choose the printing for 3 rows/);
  assert.match(html, /<option value="3" selected>MH2 – #267/, "skips the future TRC, The List, Secret Lair box, promo and borderless printings");
  assert.doesNotMatch(html, /selected>(TRC|PLST|SLD)/);
  assert.equal(page.$("csvGo").disabled, true);
  assert.match(page.$("csvPickNote").textContent, /1 row still needs a printing/);
  pick(1, 1);
  assert.equal(page.$("csvGo").disabled, false);
  await page.$("csvGo").onclick();
  await settle(20);
  const added = page.G.state.cards.slice(before);
  assert.equal(added.length, 3, "same printing merges into one stack");
  assert.deepEqual(Array.from(added.filter(c => c.name === "Counterspell").map(c => c.set + c.collector + "x" + c.quantity).sort()), ["mh2267x3", "mh2500x1"]);
  assert.equal(added.find(c => c.set === "cmm").collector, "400");

  // A full set name that differs only in punctuation still resolves
  await run("Card,Set,Qty\nIsland,Kamigawa Neon Dynasty,1\n");
  assert.match(page.$("csvSummary").textContent, /1 valid · 0 skipped/);
});

test("#327: a file with no name and no set+number columns is refused with a next step", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "box" }] });
  page.ui.setStatus = (id, t) => { page.$(id).textContent = t; };
  page.G.pickFile = async () => ({ name: "x.csv", text: "Foo,Bar\n1,2\n" });
  page.$("modeImport").onclick();
  await page.$("csvPick").onclick();
  await settle(10);
  assert.match(page.$("csvSummary").textContent, /Add one of those and try again/);
});

// #328: a catalog small enough to reason about, keyed by set/number.
function catalogPage(page) {
  const C = {
    "cmm/400": { name: "Sol Ring", set: "cmm", collector: "400", lang: "en" },
    "cmm/87": { name: "Deranged Assistant", set: "cmm", collector: "87", lang: "en" },
    "isd/51": { name: "Delver of Secrets // Insectile Aberration", set: "isd", collector: "51", lang: "en" },
    "ice/290": { name: "Lim-Dûl's Vault", set: "ice", collector: "290", lang: "en" },
    "neo/9": { name: "Sol Ring", printedName: "ソル・リング", set: "neo", collector: "9", lang: "ja" },
    "afr/1": { name: "Island", set: "afr", collector: "1", lang: "en", langFallback: true }
  };
  page.G.cards.one = async (set, num) => C[set + "/" + num] || null;
  page.G.cards.sets = async () => [];
  page.ui.setStatus = (id, t) => { page.$(id).textContent = t; };
  page.$("modeImport").onclick();
  page.$("csvFetch").checked = false;
  page.$("csvDest").value = "l1";
  return csv => { page.G.pickFile = async () => ({ name: "x.csv", text: csv }); return page.$("csvPick").onclick().then(() => settle(10)); };
}

test("#328: a name that does not match its set + number is skipped and listed; loose matches are kept", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "box" }] });
  const run = catalogPage(page);
  const downloads = [];
  page.G.downloadBlob = (blob, name) => downloads.push(name);
  await run("Name,Set code,Collector number,Quantity,Language\n" +
    "Sol Ring,cmm,400,1,en\n" +
    "Sol Ring,cmm,87,1,en\n" +                   // wrong number
    "delver of secrets,isd,51,1,en\n" +          // one face of a double-faced card, any case
    "Lim-Dul's Vault,ice,290,1,en\n" +           // accent and punctuation
    "Sol Ring,neo,9,1,ja\n" +                    // English name for a Japanese printing
    "Forest,afr,1,1,de\n" +                      // Scryfall had no German print: can't compare, so not flagged
    "Mana Crypt,zzz,1,1,en\n");                  // not in the catalog: kept, with a warning
  const html = page.$("csvDetail").innerHTML;
  assert.match(page.$("csvSummary").textContent, /6 valid · 1 skipped/);
  assert.match(html, /You wrote Sol Ring, but CMM #87 is Deranged Assistant/);
  assert.match(html, /Deranged Assistant \(CMM #87\)/, "card matched column");
  assert.match(html, /Set and number not found in the card catalog[^<]* — 1 row \(line 8\)/);
  assert.match(html, /1 row is skipped/);
  assert.equal(page.$("csvGo").disabled, false);
  await page.$("csvGo").onclick();
  await settle(20);
  assert.equal(page.G.state.cards.length, 6, "the mismatched row was not imported");
  assert.ok(!page.G.state.cards.some(c => c.collector === "87"));
  const last = page.$("csvLast").innerHTML;
  assert.match(last, /Last import: 6 rows imported, 1 skipped/);
  assert.match(last, /See the skipped rows/);
  page.sandbox.Blob = Blob;
  await page.$("csvLast").onclick({ target: { closest: () => ({ dataset: { skip: "dl" }, closest: () => true }) } });
  assert.deepEqual(downloads, ["grimoire-skipped-rows.csv"]);
});

test("#328: Æther Vial matches Scryfall's Aether Vial, and the preview table sits in a table-wrap", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "box" }] });
  const run = catalogPage(page);
  page.G.cards.one = async () => ({ name: "Aether Vial", set: "dst", collector: "91", lang: "en" });
  await run("Name,Set code,Collector number\nÆther Vial,dst,91\nAether Vial,dst,91\n");
  assert.match(page.$("csvSummary").textContent, /2 valid · 0 skipped/);
  assert.match(page.$("csvDetail").innerHTML, /<div class="table-wrap"><table class="list">/);
});

test("#328: importing the same file twice asks first; the fingerprint stays small", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "box" }] });
  const run = catalogPage(page);
  const asked = [];
  let answer = false;
  page.ui.confirmDialog = async (msg, opts) => { asked.push({ msg, opts }); return answer; };
  const csv = "Name,Set code,Collector number,Quantity\nSol Ring,cmm,400,1\nDelver of Secrets,isd,51,2\nLim-Dul's Vault,ice,290,1\n";
  await run(csv);
  await page.$("csvGo").onclick();
  await settle(20);
  assert.equal(asked.length, 0, "first import: no warning");
  assert.equal(page.G.state.cards.length, 3);
  await run(csv);
  await page.$("csvGo").onclick();
  await settle(20);
  assert.equal(asked.length, 1);
  assert.match(asked[0].msg, /This looks like the file you imported on .+\. .*Import again anyway\?/s);
  assert.equal(asked[0].opts.okLabel, "Import again anyway");
  assert.equal(page.G.state.cards.reduce((s, c) => s + c.quantity, 0), 4, "declined: nothing added");
  answer = true;
  await page.$("csvGo").onclick();
  await settle(20);
  assert.equal(page.G.state.cards.reduce((s, c) => s + c.quantity, 0), 8, "Import again anyway adds them again");
  // A different file is not a repeat
  asked.length = 0;
  await run("Name,Set code,Collector number,Quantity\nSol Ring,cmm,400,5\nIsland,afr,1,1\nDelver of Secrets,isd,51,9\n");
  await page.$("csvGo").onclick();
  await settle(20);
  assert.equal(asked.length, 0);
});

test("#328: the repeat-import fingerprint is bounded however big the file", async () => {
  const page = await open({ locations: [{ id: "l1", name: "Box", type: "box" }] });
  const run = catalogPage(page);
  page.G.cards.one = async () => null;       // not in the catalog: every row imports as written
  let csv = "Name,Set code,Collector number,Quantity\n";
  for (let i = 1; i <= 1200; i++) csv += "Card " + i + ",tst," + i + ",1\n";
  await run(csv);
  assert.match(page.$("csvSummary").textContent, /1200 valid/);
  await page.$("csvGo").onclick();
  await settle(30);
  const prints = page.G.state.settings.importPrints;
  assert.equal(prints.length, 1);
  assert.equal(prints[0].sk.length, 64);
  assert.ok(JSON.stringify(prints).length < 800, "a 1,200-row file leaves under 800 bytes");
  // Same file, slightly edited (a handful of rows changed): still recognised
  const asked = [];
  page.ui.confirmDialog = async m => { asked.push(m); return false; };
  await run(csv.replace("Card 7,tst,7,1", "Card 7,tst,7,3").replace("Card 90,tst,90,1", "Card 90,tst,90,2"));
  await page.$("csvGo").onclick();
  await settle(30);
  assert.equal(asked.length, 1);
});

/* ---- #353 part A: Receive and Receive Sealed merged into one page ---- */
const fs = require("node:fs");
const path = require("node:path");
const LOC = [{ id: "l1", name: "Box", type: "Box" }];

test("#353: an old Receive Sealed draft becomes a lot tab with sealed lines, and the page opens on Bought", async () => {
  const page = await open({ locations: LOC, settings: {
    draftSealedLot: { id: "old", receiptId: "", source: "Distributor", date: "2026-10-01", spend: "40", alloc: "market", note: "",
      lines: [{ id: "x1", ts: "2026-10-01T00:00:00Z", tcgplayerProductId: 555, manapoolProductId: "mp5",
        name: BOX.name, setCode: "fdn", market: 20, qty: 2, locationId: "l1" }] }
  } });
  const s = page.G.state.settings;
  assert.equal(s.draftSealedLot, undefined, "old draft key removed");
  assert.equal(s.draftLots.length, 1, "no empty phantom tab next to it");
  const d = s.draftLots[0];
  assert.equal(s.activeDraftLotId, d.id);
  assert.equal(d.source, "Distributor");
  assert.equal(d.spend, "40");
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].item, "sealed");
  assert.equal(d.lines[0].qty, 2);
  assert.equal(d.lines[0].manualCost, null);
  assert.equal(page.$("lotSection").hidden, false, "opens on Bought");
  assert.equal(page.$("srcBought").classList.contains("active"), true);
  assert.ok(page.ui.toasts.some(t => /sealed lot draft/i.test(t)));
  assert.equal(page.G.hasUnsaved(), true, "the move is saved");
});

test("#353: one receipt holds card and sealed lines, with the spend spread across both", async () => {
  const card = { id: "c1", ts: "2026-10-01T00:00:00Z", set: "c21", collector: "263", lang: "en", finish: "nonfoil",
    condition: "NM", name: "Sol Ring", setName: "Commander 2021", market: 10, qty: 1, locationId: "l1", manualCost: null, meta: {} };
  const sealed = { id: "s1", ts: "2026-10-01T00:00:01Z", item: "sealed", tcgplayerProductId: 555, manapoolProductId: "mp5",
    name: BOX.name, setCode: "fdn", market: 20, qty: 1, locationId: "l1", manualCost: null };
  const page = await open({ locations: LOC, settings: {
    draftLots: [{ id: "d1", receiptId: "", source: "Show", date: "2026-10-01", spend: "30", alloc: "market", note: "", lines: [card, sealed] }],
    activeDraftLotId: "d1"
  } });
  assert.equal(page.$("lotSection").hidden, false);
  assert.match(page.$("lotStrip").innerHTML, /Items on receipt/);
  await page.$("lotPost").onclick();
  await settle(10);
  const st = page.G.state;
  assert.equal(st.cards.length, 1);
  assert.equal(st.cards[0].costTotal, 10, "card takes its market share");
  assert.equal(st.sealed.length, 1);
  assert.equal(st.sealed[0].costTotal, 20, "sealed takes its market share");
  assert.equal(st.sealed[0].quantity, 1);
  const r = st.receipts[0];
  assert.equal(r.kind, "lot");
  assert.equal(r.spend, 30);
  assert.equal(r.totalCost, 30, "allocation sums to what was paid");
  assert.deepEqual(Array.from(r.lines, l => l.item || "card"), ["card", "sealed"]);
  assert.equal(r.lines[1].setCode, "fdn");
  assert.equal(st.settings.draftLots.every(d => !d.lines.length), true, "the posted draft is gone");
});

test("#353: Sealed under Already mine adds with no cost; Bought adds a sealed lot line", async () => {
  const page = await open({ locations: LOC, search: "?item=sealed" });
  assert.equal(page.$("sealedEntry").hidden, false, "?item=sealed opens on Sealed");
  assert.equal(page.$("cardEntry").hidden, true);
  assert.equal(page.$("itemSealed").classList.contains("active"), true);
  await settle(10);
  assert.equal(page.$("ledItemTh").textContent, "Product", "the Added list's column fits sealed");
  const pick = async () => {
    page.$("sldSearch").value = "foundations";
    await page.$("sldSearch").fire("input");
    await settle(250);
    page.$("sldAcList").onmousedown({ target: { closest: () => ({ dataset: { i: "0" } }) }, preventDefault() {} });
  };
  await pick();
  page.$("sldQty").value = "3";
  page.$("sldAdd").onclick();
  const st = page.G.state;
  assert.equal(st.sealed.length, 1);
  assert.equal(st.sealed[0].quantity, 3);
  assert.equal(st.sealed[0].costQty || 0, 0, "no cost basis");
  assert.equal(st.receipts.length, 0, "Already mine writes no receipt");

  page.$("srcBought").onclick();
  assert.equal(page.$("sldCostRow").hidden, false, "Bought offers a cost each");
  await pick();
  page.$("sldQty").value = "2";
  page.$("sldCost").value = "15";
  page.$("sldAdd").onclick();
  const d = st.settings.draftLots.find(x => x.id === st.settings.activeDraftLotId);
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].item, "sealed");
  assert.equal(d.lines[0].qty, 2);
  assert.equal(d.lines[0].manualCost, 15);
  assert.equal(st.sealed[0].quantity, 3, "nothing reaches inventory before posting");
});

test("#353: Simple mode ignores ?item=sealed", async () => {
  const page = await open({ simple: true, locations: LOC, search: "?item=sealed" });
  assert.equal(page.$("sealedEntry").hidden, true);
  assert.equal(page.$("cardEntry").hidden, false);
  assert.equal(page.$("itemCard").classList.contains("active"), true);
  assert.equal(page.$("itemSealed").classList.contains("active"), false);
});

test("#353: Receive Sealed leaves the menu and its old address forwards to Receive with Sealed picked", () => {
  const read = f => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
  assert.doesNotMatch(read("js/ui.js"), /receive-sealed/);
  assert.match(read("receive-sealed.html"), /http-equiv="refresh" content="0; url=\/receive\.html\?item=sealed"/);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "public", "receive-sealed.page.js")), false);
  assert.doesNotMatch(read("sealed.html"), /receive-sealed/);
});

/* ---------- Keep locks (#398) ---------- */
const KEEP_LOC = [{ id: "l1", name: "Box", type: "Box" }, { id: "l2", name: "Binder", type: "Box" }];
const KEEP_KEY = "grimoire.receiveKeep.u1";
async function keepPage(o) {
  const page = await open(Object.assign({ locations: KEEP_LOC }, o));
  page.$("modeManual").onclick();
  return page;
}
function addOne(page) {
  page.$("inSet").value = "c21";
  page.$("inNum").value = "263";
  page.$("btnAdd").onclick();
}
const lock = (page, id) => { page.$(id).checked = true; return page.$(id).onchange(); };

test("#398: nothing locked: an add resets finish, condition and language as it always has", async () => {
  const page = await keepPage();
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  page.$("inCondition").value = "LP";
  page.$("inLang").value = "ja";
  addOne(page);
  assert.equal(page.$("inFoil").value, "nonfoil");
  assert.equal(page.$("inCondition").value, page.G.defaultCondition());
  assert.equal(page.$("inLang").value, "en");
});

test("#398: a locked field holds after an add and the others still reset", async () => {
  const page = await keepPage();
  lock(page, "keepCondition");
  page.$("inCondition").value = "LP";
  page.$("inLang").value = "ja";
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  addOne(page);
  assert.equal(page.$("inCondition").value, "LP");
  assert.equal(page.$("inLang").value, "en");
  assert.equal(page.$("inFoil").value, "nonfoil");

  lock(page, "keepLang");
  lock(page, "keepFinish");
  page.$("inLang").value = "ja";
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  addOne(page);
  addOne(page);
  assert.equal(page.$("inCondition").value, "LP");
  assert.equal(page.$("inLang").value, "ja");
  assert.equal(page.$("inFoil").value, "foil");
});

test("#398: a locked finish the printing lacks switches for that card, says so, and comes back", async () => {
  const page = await open({ locations: KEEP_LOC });
  await page.pickName("Sol Ring");
  await settle(10);
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  lock(page, "keepFinish");
  const sel = page.$("inFoil");
  assert.equal(page.$("keepFinishNote").hidden, true, "not on a printing with no finish list to fall short of");
  // Set + number, with a card the cache says only comes in etched.
  page.$("modeManual").onclick();
  page.$("inSet").value = "tst"; page.$("inNum").value = "1"; page.$("inLang").value = "en";
  page.G.cardCache.set(page.G.printKey("tst", "1", "en"), { name: "Etched only", set: "tst", collector: "1", lang: "en", finishes: ["etched"] });
  await page.$("inNum").fire("input");
  await settle(400);
  assert.equal(sel.value, "etched");
  assert.equal(page.$("keepFinishNote").hidden, false);
  assert.match(page.$("keepFinishNote").textContent, /No Foil in this printing, so this one is Etched foil\. Foil stays locked/);
  page.$("btnAdd").onclick();
  assert.equal(sel.value, "foil", "the next card starts on the locked finish");
  assert.equal(page.$("keepFinishNote").hidden, true);
});

test("#398: a locked location wins over auto putaway, an unlocked one doesn't", async () => {
  const locations = [{ id: "l1", name: "Box", type: "Box" },
    { id: "l2", name: "Foils", type: "Box", sellFrom: true, putaway: { rules: [] } }];
  const page = await open({ locations, settings: { autoPutaway: true } });
  await page.pickName("Sol Ring");
  await settle(10);
  page.$("inPrinting").value = "0";
  page.$("inPrinting").onchange();
  page.G.suggestLocation = () => ({ best: { locationId: "l2", name: "Foils", rules: [] }, considered: 1, blocked: [] });
  page.$("autoPutaway").checked = true;
  page.$("inLoc").value = "l1";
  lock(page, "keepLoc");
  page.$("inQty").oninput();
  assert.equal(page.$("inLoc").value, "l1", "locked: auto putaway leaves it");
  assert.doesNotMatch(page.$("entryStatus").textContent, /Putaway/);
  page.$("keepLoc").checked = false; page.$("keepLoc").onchange();
  page.$("inQty").oninput();
  assert.equal(page.$("inLoc").value, "l2", "unlocked: it follows the rules again");
});

test("#398: locks and what they hold come back after a reload, per person, off by default", async () => {
  const store = {};
  const first = await keepPage({ store });
  assert.equal(first.$("keepFinish").checked, false);
  assert.equal(first.$("keepCondition").checked, false);
  assert.equal(first.$("keepLang").checked, false);
  assert.equal(first.$("keepLoc").checked, false);
  lock(first, "keepCondition");
  first.$("inCondition").value = "LP"; await first.$("inCondition").fire("change");
  first.$("inFoil").value = "foil"; first.$("inFoil").onchange();
  lock(first, "keepFinish");
  first.$("inLoc").value = "l2"; await first.$("inLoc").fire("change");
  lock(first, "keepLoc");
  assert.deepEqual(JSON.parse(store[KEEP_KEY]), { inFoil: "foil", inCondition: "LP", inLoc: "l2" });
  assert.equal(first.G.hasUnsaved(), false, "a lock isn't a save of the whole collection");

  const second = await keepPage({ store });
  assert.equal(second.$("keepCondition").checked, true);
  assert.equal(second.$("inCondition").value, "LP");
  assert.equal(second.$("keepFinish").checked, true);
  assert.equal(second.$("inFoil").value, "foil");
  assert.equal(second.$("keepLoc").checked, true);
  assert.equal(second.$("inLoc").value, "l2");
  assert.equal(second.$("keepLang").checked, false);
  addOne(second);
  assert.equal(second.$("inFoil").value, "foil", "a reloaded lock still holds through an add");
});

test("#398: no lock is in the tab order, and each says what it keeps", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "receive.html"), "utf8");
  for (const [id, what] of [["keepFinish", "finish"], ["keepCondition", "condition"], ["keepLang", "language"], ["keepLoc", "location"]]) {
    const box = html.match(new RegExp('<input type="checkbox" id="' + id + '"[^>]*>'));
    assert.ok(box, id);
    assert.match(box[0], /tabindex="-1"/);
    assert.match(box[0], new RegExp('aria-label="Keep ' + what + ' after adding"'));
  }
  assert.match(html, /<input type="checkbox" id="inSetSticky" tabindex="-1" checked>/);
  // Each field still comes before its lock, and nothing else in the form left the tab order.
  const form = html.slice(html.indexOf('id="entryFields"'), html.indexOf('id="entryToolbar"'));
  assert.equal((form.match(/tabindex="-1"/g) || []).length, 5);
});

const NONFOIL_ONLY = (set, num) => ({ card: { finishes: ["nonfoil"], imageUrl: "" }, name: "Sol Ring", price: 2.92, collector: num, setName: "Set",
  rarity: "uncommon", scryfallId: "s1", tcgplayerId: "1", meta: {} });

test("#398: Enter before the preview: a locked finish that doesn't fit is called out, on the status line and the queue row", async () => {
  const page = await keepPage();
  page.G.lookupCard = async (set, num) => NONFOIL_ONLY(set, num);
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  lock(page, "keepFinish");
  addOne(page);
  await settle(30);
  assert.match(page.$("entryStatus").textContent, /doesn't come in Foil, so it went in as Non-foil/);
  assert.match(page.$("queueList").innerHTML, /Not Foil/);
  assert.equal(page.G.state.cards[0].finish, "nonfoil", "the saved finish is the one the printing has");
  assert.equal(page.$("inFoil").value, "foil", "the lock holds for the next card");
});

test("#398: the same goes for a lot line", async () => {
  const page = await keepPage();
  page.$("srcBought").onclick();
  page.G.lookupCard = async (set, num) => NONFOIL_ONLY(set, num);
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  addOne(page);
  await settle(30);
  assert.match(page.$("entryStatus").textContent, /to the lot .*doesn't come in Foil, so it went in as Non-foil/);
  const lines = page.G.state.settings.draftLots[0].lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].finish, "nonfoil");
});

test("#398: the unlocked default moving to a foil-only printing says nothing; a locked Non-foil does", async () => {
  const foilOnly = (set, num) => Object.assign(NONFOIL_ONLY(set, num), { card: { finishes: ["foil"], imageUrl: "" } });
  const page = await keepPage();
  page.G.lookupCard = async (set, num) => foilOnly(set, num);
  addOne(page);
  await settle(30);
  assert.doesNotMatch(page.$("entryStatus").textContent, /went in as/);
  assert.doesNotMatch(page.$("queueList").innerHTML, /Not Non-foil/);
  assert.equal(page.G.state.cards[0].finish, "foil");

  lock(page, "keepFinish");
  addOne(page);
  await settle(30);
  assert.match(page.$("entryStatus").textContent, /doesn't come in Non-foil, so it went in as Foil/);
});

test("#398: a lot line carries the lookup's own note too", async () => {
  const page = await keepPage();
  page.$("srcBought").onclick();
  page.G.lookupCard = async (set, num) => Object.assign(NONFOIL_ONLY(set, num), { note: " (that language isn't on Scryfall; used the default print)" });
  addOne(page);
  await settle(30);
  assert.match(page.$("entryStatus").textContent, /to the lot .*that language isn't on Scryfall/);
});

test("#398: a finish that fits says nothing extra", async () => {
  const page = await keepPage();
  page.G.lookupCard = async (set, num) => Object.assign(NONFOIL_ONLY(set, num), { card: { finishes: ["nonfoil", "foil"], imageUrl: "" } });
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  lock(page, "keepFinish");
  addOne(page);
  await settle(30);
  assert.doesNotMatch(page.$("entryStatus").textContent, /went in as/);
  assert.doesNotMatch(page.$("queueList").innerHTML, /Not Foil/);
});

test("#398: the finish note clears when the mode or the card name changes", async () => {
  const page = await keepPage();
  page.$("inFoil").value = "foil"; page.$("inFoil").onchange();
  lock(page, "keepFinish");
  const showNote = async () => {
    page.$("modeManual").onclick();
    page.$("inSet").value = "tst"; page.$("inNum").value = "1"; page.$("inLang").value = "en";
    page.G.cardCache.set(page.G.printKey("tst", "1", "en"), { name: "Etched only", set: "tst", collector: "1", lang: "en", finishes: ["etched"] });
    await page.$("inNum").fire("input");
    await settle(400);
    assert.equal(page.$("keepFinishNote").hidden, false);
  };
  await showNote();
  page.$("modeSearch").onclick();
  assert.equal(page.$("keepFinishNote").hidden, true, "changing mode");
  assert.equal(page.$("inFoil").value, "foil");
  // Search by name: a printing with no Foil raises the note, then a new name clears it.
  const real = page.G.cards.printings;
  page.G.cards.printings = async () => [{ name: "Etched only", set: "tst", setName: "Test", collector: "1", lang: "en", releasedAt: "2024-01-01", usd: 1, finishes: ["etched"] }];
  page.$("modeSearch").onclick();
  await page.pickName("Etched only");
  page.$("inPrinting").value = "0";
  page.$("inPrinting").onchange();
  await settle(10);
  assert.equal(page.$("keepFinishNote").hidden, false);
  page.G.cards.printings = real;
  await page.pickName("Sol Ring");
  assert.equal(page.$("keepFinishNote").hidden, true, "a new card name");
  assert.equal(page.$("inFoil").value, "foil");
});

test("#398: locking the location clears the putaway message it replaced", async () => {
  const page = await open({ locations: KEEP_LOC, settings: { autoPutaway: true } });
  await page.pickName("Sol Ring");
  await settle(10);
  page.$("inPrinting").value = "0";
  page.$("inPrinting").onchange();
  page.G.suggestLocation = () => ({ best: { locationId: "l2", name: "Binder", rules: [] }, considered: 1, blocked: [] });
  page.$("autoPutaway").checked = true;
  page.$("inQty").oninput();
  assert.match(page.$("entryStatus").textContent, /Putaway/);
  lock(page, "keepLoc");
  assert.doesNotMatch(page.$("entryStatus").textContent, /Putaway/);
});

test("#444: Bought shows one receipt box with two tabs; the floor list and its badge stay right on the other tab", async () => {
  const page = await open({ locations: LOC });
  page.$("srcBought").onclick();
  assert.equal(page.$("lotSection").hidden, false);
  assert.equal(page.$("rcptTabs").hidden, false, "inner tabs under Bought");
  assert.equal(page.$("lotPane").hidden, false, "opens on This receipt");
  assert.equal(page.$("floorSection").hidden, true);
  // Open a receipt while the floor tab is NOT showing: the list and the count still update.
  page.$("floorSource").value = "Craigslist";
  page.$("floorSpend").value = "30";
  page.$("floorOpen").onclick();
  assert.equal(page.G.openReceivings().length, 1);
  assert.equal(page.$("floorCount").textContent, "1");
  assert.equal(page.$("floorCount").hidden, false);
  assert.match(page.$("floorBody").innerHTML, /Craigslist/);
  page.$("rcptTabFloor").onclick();
  assert.equal(page.$("floorSection").hidden, false);
  assert.equal(page.$("lotPane").hidden, true);
  assert.equal(page.$("rcptTabFloor").classList.contains("active"), true);
  // Back to Already mine and again: no tabs, no floor part; Bought remembers the floor tab.
  page.$("srcMine").onclick();
  assert.equal(page.$("rcptTabs").hidden, true);
  assert.equal(page.$("floorSection").hidden, true);
  page.$("srcBought").onclick();
  assert.equal(page.$("floorSection").hidden, false);
  assert.equal(page.$("floorCount").textContent, "1");
});

test("#444: Mana Pool order shows just the receipt, no inner tabs", async () => {
  const page = await open({ locations: LOC });
  page.$("srcManapool").onclick();
  assert.equal(page.$("lotSection").hidden, false);
  assert.equal(page.$("rcptTabs").hidden, true);
  assert.equal(page.$("lotPane").hidden, false);
  assert.equal(page.$("floorSection").hidden, true);
});
