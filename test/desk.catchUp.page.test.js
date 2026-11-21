"use strict";
/* The desk and a pull on the floor (#395). A desk page only hears of another
   device's save when it loads or saves, so right before a count, a chase or a
   Complete it asks the server (G.catchUp). Here the "other device" is a save
   landing on a stand-in server after the desk page has loaded. Also: an order
   being picked isn't short on its own screen, and a line short because of
   another ticket's tote says so (owner, 2026-11-01). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const OWNER = { id: "boss", username: "boss", orgId: "o1", orgRole: "owner" };
const card = (id, name, locationId, quantity) => ({ id, set: "tst", collector: id, name, lang: "en", finish: "nonfoil", condition: "NM", locationId, quantity,
  price: 12.34, avgCost: 5.67, costQty: quantity, costTotal: 5.67 * quantity, listedQty: 0 });
const line = (collector, name, qty) => ({ kind: "card", set: "tst", collector, lang: "en", finish: "nonfoil", condition: "NM", name, qty });
const ticket = (id, label, lines, extra) => Object.assign({ id, source: "manual", orderId: "o-" + id, orderLabel: label, status: "open", createdAt: "2026-10-31T08:00:00Z", lines }, extra);
const pull = (recordId, qty, locationId) => ({ key: "k", recordId, locationId: locationId || "a", name: "x", qty, by: "sam" });

function server(doc) {
  const s = { doc, stamp: "s1", rev: 1, down: false,
    // Another device's save: the page doesn't know until it asks.
    saveElsewhere(fn) { fn(s.doc); s.stamp = "s" + ++s.rev; },
    pull(id, recordId, qty) {
      s.saveElsewhere(d => {
        const p = d.pickLists.find(x => x.id === id);
        p.rfPulls = [Object.assign(pull(recordId, qty), s.keyOf ? { key: s.keyOf(p.lines[0]) } : {})];
      });
    },
    routes(url, init, body) {
      if (url === "/api/collection/stamp") return s.down ? { __status: 503, error: "down" } : { stamp: s.stamp };
      if (url === "/api/auth/me") return { user: OWNER };
      if (url === "/api/collection") {
        if (init && init.method === "PUT") { if (body && body.state) s.doc = body.state; s.stamp = "s" + ++s.rev; return { rev: s.rev }; }
        return { rev: s.rev, state: JSON.parse(JSON.stringify(s.doc)), patch: 0 };
      }
      if (String(url).startsWith("/api/audit")) return { entries: [], total: 0 };
      if (url === "/api/orgs/mine") return { members: [OWNER], activeStoreId: "s1" };
      if (url === "/api/meta") return { manapool: true };
      if (s.orders && url === "/api/manapool/orders") return { orders: s.orders };
      return {};
    }
  };
  return s;
}
const DOC = (cards, pickLists) => ({ locations: [{ id: "a", name: "A-1", type: "Box", sellFrom: true }, { id: "b", name: "B-2", type: "Box", sellFrom: true }],
  cards, sealed: [], pickLists, settings: { tutorialSeen: true } });

async function deskPage(s) {
  const pg = loadPage("lists.page.js", { routes: s.routes });
  s.keyOf = pg.G.pickKey;
  await pg.G.load();
  await pg.boot();
  await pg.$("tabPick").fire("click");
  return pg;
}
const qtyOf = (G, id) => { const c = G.state.cards.find(x => x.id === id); return c ? c.quantity : null; };
function openTicket(pg, label) {
  const row = pg.$("pickQueueBody").children.find(tr => tr.innerHTML.includes(label));
  assert.ok(row, label + " is in the queue");
  row.onclick();
}
// The stand-in DOM can't find the chase button in a row's innerHTML: hand it one.
function chaseButton(pg, rec, take) {
  const btn = { dataset: { rec, take: String(take), kind: "card" } };
  pg.$("pickBody").querySelectorAll = sel => (sel === ".chase" ? [btn] : []);
  return btn;
}
async function chase(pg, btn, answer) {
  const asked = [];
  pg.ui.promptDialog = async msg => { asked.push(msg); return typeof answer === "function" ? answer() : answer; };
  btn.onclick({ stopPropagation() {} });
  await settle(30);
  return asked;
}

/* ---------- Full Count and Sealed ---------- */
/* The stand-in DOM never parses innerHTML, and the catch-up edits rows in place, so
   the two count tables get just enough of a real one: a row per <tr>, with its book
   cell, tote line and box. Reading innerHTML gives back what's there now. */
function liveTable(pg, bodyId, cls) {
  const body = pg.$(bodyId);
  const doc = pg.sandbox.document;
  const BOOK = /<td class="num">(\d+)<\/td>/, SLOT = /<div class="toteSlot">(.*?)<\/div><\/td>/, BOX = /data-i="(\d+)" value="([^"]*)"/;
  let rows = [], other = "";
  const parse = html => (html.match(/<tr data-rec=.*?<\/tr>/g) || []).map(src => {
    const [, i, value] = BOX.exec(src);
    const box = { dataset: { i }, value, blur() { if (doc.activeElement === box) doc.activeElement = null; } };
    const book = { textContent: BOOK.exec(src)[1] }, slot = { innerHTML: SLOT.exec(src)[1] };
    const tr = { dataset: { rec: /data-rec="([^"]*)"/.exec(src)[1] }, box,
      querySelector: sel => ({ "td.num": book, ".toteSlot": slot, ["." + cls]: box })[sel] || null,
      remove() { rows = rows.filter(x => x !== tr); if (doc.activeElement === box) doc.activeElement = null; },
      html: () => src.replace(BOOK, () => '<td class="num">' + book.textContent + "</td>")
        .replace(SLOT, () => '<div class="toteSlot">' + slot.innerHTML + "</div></td>")
        .replace(BOX, () => 'data-i="' + box.dataset.i + '" value="' + box.value + '"') };
    return tr;
  });
  Object.defineProperty(body, "innerHTML", { configurable: true, enumerable: true,
    get: () => (rows.length ? rows.map(r => r.html()).join("") : other),
    set: v => { rows = parse(String(v)); other = rows.length ? "" : String(v); } });
  Object.defineProperty(body, "lastElementChild", { configurable: true, get: () => rows.at(-1) });
  body.insertAdjacentHTML = (pos, html) => { rows.push(...parse(html)); };
  body.querySelectorAll = sel => (sel === "." + cls ? rows.map(r => r.box) : /^tr/.test(sel) ? rows.slice() : []);
}
function liveTables(pg) {
  liveTable(pg, "fcBody", "fcCounted");
  liveTable(pg, "scBody", "scCounted");
  pg.sandbox.document.querySelectorAll = sel => (sel === ".fcCounted" ? pg.$("fcBody") : sel === ".scCounted" ? pg.$("scBody") : { querySelectorAll: () => [] }).querySelectorAll(sel);
}
const boxesOf = (pg, cls) => pg.$(cls === "fcCounted" ? "fcBody" : "scBody").querySelectorAll("." + cls);
async function countPage(s) {
  const pg = loadPage("cycle-count.page.js", { routes: s.routes });
  liveTables(pg);
  await pg.G.load();
  await pg.boot();
  pg.ui.confirmAnswer = true;
  pg.$("fcBin").value = "a";
  pg.$("fcBin").onchange();
  await settle(10);
  return pg;
}
// What's typed in the boxes, in row order.
const typeCounts = (pg, cls, values) => {
  boxesOf(pg, cls).forEach((box, i) => { box.value = values[i]; });
};
const countDoc = () => DOC([card("e", "Echo", "a", 5), card("k", "Kilo", "a", 4)], [ticket("P1", "#801", [line("e", "Echo", 2)])]);

test("Full Count: a pull saved after the page loaded stops Apply, keeps what was typed elsewhere, and the book ends as shelf + tote", async () => {
  const s = server(countDoc());
  const pg = await countPage(s);
  assert.doesNotMatch(pg.$("fcBody").innerHTML, /in a tote/, "the page hasn't heard yet");
  s.pull("P1", "e", 2);
  typeCounts(pg, "fcCounted", ["3", "2"]);
  await pg.$("fcApply").onclick();
  await settle(10);
  assert.equal(pg.ui.confirms.length, 0, "stopped before the question");
  assert.match(pg.ui.toasts.at(-1), /The stock of Echo changed while you were counting/);
  assert.match(pg.$("fcBody").innerHTML, /2 in a tote, pulled by sam/);
  assert.match(pg.$("fcBody").innerHTML, /data-i="0" value="3"/, "Echo starts over at what should be on the shelf");
  assert.match(pg.$("fcBody").innerHTML, /data-i="1" value="2"/, "Kilo keeps what was typed");
  assert.equal(qtyOf(pg.G, "e"), 5);
  assert.equal(qtyOf(pg.G, "k"), 4);

  // Counted again: the same 3 on the shelf, and it goes through.
  await pg.$("fcApply").onclick();
  await settle(10);
  assert.match(pg.ui.confirms.at(-1), /1 stack\(s\) adjusted/);
  assert.equal(qtyOf(pg.G, "e"), 5, "shelf 3 + tote 2, not 3");
  assert.equal(qtyOf(pg.G, "k"), 2);
});

test("Full Count: no answer from the server, and it isn't applied, says so, and keeps what was typed", async () => {
  const s = server(countDoc());
  const pg = await countPage(s);
  s.down = true;
  typeCounts(pg, "fcCounted", ["3", "2"]);
  const drawn = pg.$("fcBody").innerHTML;
  await pg.$("fcApply").onclick();
  await settle(10);
  assert.equal(pg.ui.confirms.length, 0);
  assert.match(pg.ui.toasts.at(-1), /Couldn't reach the server.*the count wasn't applied\. Nothing changed/);
  assert.equal(pg.$("fcBody").innerHTML, drawn, "the boxes aren't redrawn");
  assert.equal(pg.$("fcApply").disabled, false, "and it can be pressed again");
  assert.equal(qtyOf(pg.G, "e"), 5);
  assert.equal(qtyOf(pg.G, "k"), 4);
  assert.equal(pg.G.locById("a").lastCycleCountAt || null, null);
  s.down = false;
  await pg.$("fcApply").onclick();
  await settle(10);
  assert.equal(qtyOf(pg.G, "k"), 2, "pressed again, it goes");
});

test("Full Count: opening a bin catches up first, so a pull is on screen before anyone counts", async () => {
  const s = server(countDoc());
  const pg = loadPage("cycle-count.page.js", { routes: s.routes });
  liveTables(pg);
  await pg.G.load();
  await pg.boot();
  s.pull("P1", "e", 2);
  pg.$("fcBin").value = "a";
  pg.$("fcBin").onchange();
  await settle(20);
  assert.match(pg.$("fcBody").innerHTML, /2 in a tote, pulled by sam/);
  assert.match(pg.$("fcTote").innerHTML, /2 copies from this bin are in a tote/);
});

test("Sealed: the same stop, and book = shelf + tote", async () => {
  const doc = countDoc();
  doc.sealed = [{ id: "box", kind: "sealed", name: "Booster Box", setCode: "tst", tcgplayerProductId: "777", locationId: "a", quantity: 5, price: 120, avgCost: 90, costQty: 5, costTotal: 450, listedQty: 0 }];
  const s = server(doc);
  const pg = await countPage(s);
  pg.$("scBin").value = "a";
  pg.$("scBin").onchange();
  await settle(10);
  s.pull("P1", "box", 2);
  typeCounts(pg, "scCounted", ["3"]);
  await pg.$("scApply").onclick();
  await settle(10);
  assert.equal(pg.ui.confirms.length, 0);
  assert.match(pg.ui.toasts.at(-1), /The stock of Booster Box changed/);
  assert.match(pg.$("scBody").innerHTML, /2 in a tote, pulled by sam/);
  await pg.$("scApply").onclick();
  await settle(10);
  assert.equal(pg.G.state.sealed[0].quantity, 5);
  s.down = true;
  typeCounts(pg, "scCounted", ["1"]);
  await pg.$("scApply").onclick();
  await settle(10);
  assert.match(pg.ui.toasts.at(-1), /Couldn't reach the server/);
  assert.equal(pg.G.state.sealed[0].quantity, 5);
});

/* ---------- Typing before the catch-up that follows opening a bin has finished ---------- */
// Holds the document's answer until released: the seconds a real load takes.
function holdLoads(s) {
  const real = s.routes;
  let release = () => {};
  s.routes = (url, init, body) => {
    if (url === "/api/collection" && !(init && init.method === "PUT") && s.holding) return new Promise(res => { release = () => res(real(url, init, body)); });
    return real(url, init, body);
  };
  return () => { s.holding = false; release(); };
}
async function loadedCountPage(s) {
  const pg = loadPage("cycle-count.page.js", { routes: (...a) => s.routes(...a) });
  liveTables(pg);
  const printings = [{ name: "Found Card", set: "tst", collector: "9", setName: "Set", lang: "en" }];
  let pick = () => {};
  pg.ui.loadPrintingSelect = async () => printings;
  pg.ui.Autocomplete = (id, list, fn) => { if (id === "fcSearch") pick = fn; };
  await pg.G.load();
  await pg.boot();
  pg.ui.confirmAnswer = true;
  await pick("Found Card");
  return pg;
}
function open(pg, select) {
  pg.$(select).value = "a";
  pg.$(select).onchange();
}
function findCard(pg) {
  pg.$("fcPrint").value = "0";
  pg.$("fcAddNew").onclick();
  assert.match(pg.$("fcNewBody").innerHTML, /Found Card/);
}

test("Full Count: a number typed before the catch-up finishes survives its redraw, and so does a found card", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  // Something on this bin changed elsewhere, so the rows do have to redraw: Kilo's book.
  s.saveElsewhere(d => { d.cards.find(c => c.id === "k").quantity = 3; });
  open(pg, "fcBin");
  await settle(10);
  assert.match(pg.$("fcBody").innerHTML, /data-i="1" value="4"/, "drawn straight away, from what the page knows");
  typeCounts(pg, "fcCounted", ["2", "4"]);
  findCard(pg);
  release();
  await settle(20);
  assert.match(pg.$("fcBody").innerHTML, /data-i="0" value="2"/, "Echo keeps what was typed");
  assert.match(pg.$("fcBody").innerHTML, /data-i="1" value="3"/, "Kilo was never touched, so it follows the book");
  assert.match(pg.$("fcNewBody").innerHTML, /Found Card/, "the found card is still listed");
  assert.equal(pg.ui.toasts.length, 0, "nothing to say");
  typeCounts(pg, "fcCounted", ["2", "3"]);
  await pg.$("fcApply").onclick();
  await settle(10);
  assert.match(pg.ui.confirms.at(-1), /1 stack\(s\) adjusted, 1 new card/, "the found card goes in with the count");
});

test("Full Count: that number is what Apply records, so the shortage isn't lost", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.saveElsewhere(d => { d.cards.find(c => c.id === "k").quantity = 3; });
  open(pg, "fcBin");
  await settle(10);
  typeCounts(pg, "fcCounted", ["2", "4"]);
  release();
  await settle(20);
  typeCounts(pg, "fcCounted", ["2", "3"]);
  await pg.$("fcApply").onclick();
  await settle(10);
  assert.equal(qtyOf(pg.G, "e"), 2);
  assert.equal(qtyOf(pg.G, "k"), 3);
  assert.ok(pg.G.locById("a").lastCycleCountAt);
});

test("Full Count: nothing new for this bin, and the rows aren't redrawn at all", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.saveElsewhere(() => {});
  open(pg, "fcBin");
  await settle(10);
  let writes = 0;
  const body = pg.$("fcBody");
  let html = body.innerHTML;
  Object.defineProperty(body, "innerHTML", { get: () => html, set: v => { writes++; html = v; } });
  typeCounts(pg, "fcCounted", ["2", "4"]);
  release();
  await settle(20);
  assert.equal(writes, 0, "the box being typed in is left alone");
});

test("Full Count: a typed row whose tote moved during the catch-up clears and says so; the others keep theirs", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.pull("P1", "e", 2);
  open(pg, "fcBin");
  await settle(10);
  typeCounts(pg, "fcCounted", ["2", "1"]);
  release();
  await settle(20);
  assert.match(pg.ui.toasts.at(-1), /The stock of Echo changed while you were counting/);
  assert.match(pg.$("fcBody").innerHTML, /data-i="0" value="3"/, "Echo clears to what should be on the shelf");
  assert.match(pg.$("fcBody").innerHTML, /2 in a tote, pulled by sam/);
  assert.match(pg.$("fcBody").innerHTML, /data-i="1" value="1"/, "Kilo keeps what was typed");
});

test("Full Count: an untouched row whose tote moved redraws with no message", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.pull("P1", "e", 2);
  open(pg, "fcBin");
  await settle(10);
  typeCounts(pg, "fcCounted", ["5", "1"]);
  release();
  await settle(20);
  assert.equal(pg.ui.toasts.length, 0);
  assert.match(pg.$("fcBody").innerHTML, /data-i="0" value="3"/);
  assert.match(pg.$("fcBody").innerHTML, /data-i="1" value="1"/);
});

test("Full Count: Apply pressed during that same catch-up stops if a typed row's tote moved, and doesn't take the cleared row as counted", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.pull("P1", "e", 2);
  open(pg, "fcBin");
  await settle(10);
  typeCounts(pg, "fcCounted", ["2", "4"]);
  const applying = pg.$("fcApply").onclick();
  await settle(5);
  release();
  await applying;
  await settle(10);
  assert.equal(pg.ui.confirms.length, 0, "no question");
  assert.match(pg.ui.toasts.at(-1), /The stock of Echo changed/);
  assert.equal(qtyOf(pg.G, "e"), 5);
  assert.equal(pg.G.locById("a").lastCycleCountAt || null, null, "not recorded as counted");
});

test("Sealed: a number typed before the catch-up finishes survives its redraw, and so does a found product", async () => {
  const doc = countDoc();
  const box = (id, qty) => ({ id, kind: "sealed", name: id, setCode: "tst", tcgplayerProductId: id, locationId: "a", quantity: qty, price: 120, avgCost: 90, costQty: qty, costTotal: 90 * qty, listedQty: 0 });
  doc.sealed = [box("Box", 5), box("Bundle", 4)];
  const s = server(doc);
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  // Picking a found product from its search box, in the stand-in DOM.
  const item = { addEventListener: (t, fn) => fn({ preventDefault() {} }) };
  pg.$("scAcList").querySelectorAll = () => [item];
  const realRoutes = s.routes;
  s.routes = (url, ...rest) => (String(url).startsWith("/api/sealed/search") ? { data: [{ name: "Found Box", setCode: "tst", tcgplayerProductId: "9", marketPrice: 10 }] } : realRoutes(url, ...rest));
  pg.$("scSearch").value = "Found";
  await pg.$("scSearch").fire("input");
  await new Promise(r => setTimeout(r, 250));
  await settle(5);
  s.holding = true;
  s.saveElsewhere(d => { d.sealed.find(x => x.id === "Bundle").quantity = 3; });
  open(pg, "scBin");
  await settle(10);
  typeCounts(pg, "scCounted", ["2", "4"]);
  pg.$("scAddNew").onclick();
  assert.match(pg.$("scNewBody").innerHTML, /Found Box/);
  release();
  await settle(20);
  assert.match(pg.$("scBody").innerHTML, /data-i="0" value="2"/);
  assert.match(pg.$("scBody").innerHTML, /data-i="1" value="3"/);
  assert.match(pg.$("scNewBody").innerHTML, /Found Box/);
  typeCounts(pg, "scCounted", ["2", "3"]);
  await pg.$("scApply").onclick();
  await settle(10);
  assert.equal(pg.G.state.sealed.find(x => x.id === "Box").quantity, 2);
});

test("Sealed: a typed row whose tote moved clears and says so", async () => {
  const doc = countDoc();
  doc.sealed = [{ id: "box", kind: "sealed", name: "Booster Box", setCode: "tst", tcgplayerProductId: "777", locationId: "a", quantity: 5, price: 120, avgCost: 90, costQty: 5, costTotal: 450, listedQty: 0 }];
  const s = server(doc);
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.pull("P1", "box", 2);
  open(pg, "scBin");
  await settle(10);
  typeCounts(pg, "scCounted", ["1"]);
  release();
  await settle(20);
  assert.match(pg.ui.toasts.at(-1), /The stock of Booster Box changed/);
  assert.match(pg.$("scBody").innerHTML, /data-i="0" value="3"/);
});

/* ---------- The cursor (round 3): a rebuilt box loses it, and 3 becomes 35 ---------- */
test("Full Count: a box nobody needs to change is the same box afterwards, with the cursor still in it", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.saveElsewhere(d => { d.cards.find(c => c.id === "k").quantity = 3; });
  open(pg, "fcBin");
  await settle(10);
  const [echo] = boxesOf(pg, "fcCounted");
  pg.sandbox.document.activeElement = echo;
  echo.value = "2";
  release();
  await settle(20);
  assert.match(pg.$("fcBody").innerHTML, /data-i="1" value="3"/, "the other row did change");
  assert.equal(boxesOf(pg, "fcCounted")[0], echo, "not rebuilt");
  assert.equal(echo.value, "2");
  assert.equal(pg.sandbox.document.activeElement, echo);
  assert.equal(pg.ui.toasts.length, 0);
});

test("Full Count: the row being typed in is the one that clears: the cursor leaves it and the message names the card", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.pull("P1", "e", 2);
  open(pg, "fcBin");
  await settle(10);
  const [echo, kilo] = boxesOf(pg, "fcCounted");
  pg.sandbox.document.activeElement = echo;
  echo.value = "2";
  kilo.value = "1";
  release();
  await settle(20);
  assert.equal(echo.value, 3, "back to what should be on the shelf");
  assert.equal(pg.sandbox.document.activeElement, null, "the next key can't land in it");
  assert.match(pg.ui.toasts.at(-1), /The stock of Echo changed while you were counting/);
  assert.equal(kilo.value, "1");
});

test("Full Count: the cursor sitting in an untouched box whose number changes leaves it too, and says so", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.pull("P1", "e", 2);
  open(pg, "fcBin");
  await settle(10);
  const [echo] = boxesOf(pg, "fcCounted");
  pg.sandbox.document.activeElement = echo;
  release();
  await settle(20);
  assert.equal(echo.value, 3);
  assert.equal(pg.sandbox.document.activeElement, null);
  assert.match(pg.ui.toasts.at(-1), /The stock of Echo changed/);
});

test("Full Count: a row that's gone and a row that's new line up with what Apply records", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  s.holding = true;
  s.saveElsewhere(d => {
    d.cards.find(c => c.id === "e").locationId = "b";
    d.cards.push(card("m", "Mike", "a", 6));
  });
  open(pg, "fcBin");
  await settle(10);
  const [echo, kilo] = boxesOf(pg, "fcCounted");
  echo.value = "2";
  kilo.value = "1";
  release();
  await settle(20);
  assert.match(pg.ui.toasts.at(-1), /The stock of Echo changed/, "what was typed on it has nowhere to go");
  assert.equal(boxesOf(pg, "fcCounted")[0], kilo, "Kilo is the same box");
  assert.deepEqual(boxesOf(pg, "fcCounted").map(b => [b.dataset.i, String(b.value)]), [["0", "1"], ["1", "6"]]);
  await pg.$("fcApply").onclick();
  await settle(10);
  assert.match(pg.ui.confirms.at(-1), /1 stack\(s\) adjusted/);
  assert.equal(qtyOf(pg.G, "k"), 1);
  assert.equal(qtyOf(pg.G, "m"), 6);
  assert.equal(qtyOf(pg.G, "e"), 5, "Echo, now in another bin, isn't touched");
});

/* ---------- "Checking…" while a catch-up runs ---------- */
test("Apply says Checking while it waits, and puts its words back", async () => {
  const s = server(countDoc());
  const release = holdLoads(s);
  const pg = await loadedCountPage(s);
  open(pg, "fcBin");
  await settle(10);
  typeCounts(pg, "fcCounted", ["3", "4"]);
  pg.$("fcApply").innerHTML = "Apply full count";
  s.holding = true;
  s.saveElsewhere(() => {});
  const applying = pg.$("fcApply").onclick();
  await settle(5);
  assert.equal(pg.$("fcApply").innerHTML, "Checking…");
  assert.equal(pg.$("fcApply").disabled, true);
  release();
  await applying;
  await settle(5);
  assert.equal(pg.$("fcApply").innerHTML, "Apply full count");
  assert.equal(pg.$("fcApply").disabled, false);
});

test("Complete says Checking while it waits; a double press takes the cards off once and doesn't leave the word behind", async () => {
  const s = server(completeDoc());
  const release = holdLoads(s);
  const pg = await deskPage(s);
  openTicket(pg, "#802");
  const btn = pg.$("pickComplete");
  btn.innerHTML = "Complete all lines on ticket";
  s.holding = true;
  s.saveElsewhere(() => {});
  const first = btn.onclick();
  const second = btn.onclick();
  await settle(5);
  assert.equal(btn.innerHTML, "Checking…");
  release();
  await Promise.all([first, second]);
  await settle(10);
  assert.notEqual(btn.innerHTML, "Checking…");
  assert.equal(qtyOf(pg.G, "k"), 1, "4 off a stack of 5, once");
});

test("Chase says Checking while it waits", async () => {
  const s = server(chaseDoc());
  const release = holdLoads(s);
  const pg = await deskPage(s);
  const btn = chaseButton(pg, "s", 2);
  openTicket(pg, "#802");
  btn.innerHTML = "icon";
  s.holding = true;
  s.saveElsewhere(() => {});
  pg.ui.promptDialog = async () => null;
  btn.onclick({ stopPropagation() {} });
  await settle(5);
  assert.equal(btn.innerHTML, "Checking…");
  release();
  await settle(20);
  assert.equal(btn.innerHTML, "icon");
});

/* ---------- Chase ---------- */
const chaseDoc = () => DOC([card("s", "Sol Ring", "a", 5)], [ticket("P1", "#801", [line("s", "Sol Ring", 2)]), ticket("P2", "#802", [line("s", "Sol Ring", 2)])]);

test("Chase: a pull saved after the ticket opened is named in the question, the book keeps it, and nobody puts it back", async () => {
  const s = server(chaseDoc());
  const pg = await deskPage(s);
  const btn = chaseButton(pg, "s", 2);
  openTicket(pg, "#802");
  s.pull("P1", "s", 2);
  const asked = await chase(pg, btn, "0");
  assert.match(asked[0], /2 in a tote, pulled by sam\. Don't count those\./);
  assert.equal(qtyOf(pg.G, "s"), 2, "the stack isn't removed");
  const walk = pg.G.rfPickWalk({ kind: "ticket", id: "P1" });
  assert.equal(walk.putBack.length, 0, "nothing to put back");
  assert.equal(walk.shorts.length, 0);
});

test("Chase: a pull landing while the question is up still counts", async () => {
  const s = server(chaseDoc());
  const pg = await deskPage(s);
  const btn = chaseButton(pg, "s", 2);
  openTicket(pg, "#802");
  const asked = await chase(pg, btn, () => { s.pull("P1", "s", 2); return "0"; });
  assert.doesNotMatch(asked[0], /in a tote/);
  assert.equal(qtyOf(pg.G, "s"), 2);
  assert.equal(pg.G.rfPickWalk({ kind: "ticket", id: "P1" }).putBack.length, 0);
});

test("Chase: no answer from the server, and it isn't asked or applied, and says so", async () => {
  const s = server(chaseDoc());
  const pg = await deskPage(s);
  const btn = chaseButton(pg, "s", 2);
  openTicket(pg, "#802");
  s.down = true;
  const asked = await chase(pg, btn, "0");
  assert.equal(asked.length, 0);
  assert.match(pg.ui.toasts.at(-1), /Couldn't reach the server.*the chase wasn't applied\. Nothing changed/);
  assert.equal(qtyOf(pg.G, "s"), 5);
  // And if it goes down while the question is up.
  s.down = false;
  const again = await chase(pg, btn, () => { s.down = true; return "0"; });
  assert.equal(again.length, 1);
  assert.equal(qtyOf(pg.G, "s"), 5, "not applied");
});

test("Chase: the ticket holding the tote, once the desk hears of it, stays locked (decision 18)", async () => {
  const s = server(chaseDoc());
  const pg = await deskPage(s);
  const btn = chaseButton(pg, "s", 2);
  openTicket(pg, "#802");
  s.pull("P2", "s", 1);
  const asked = await chase(pg, btn, "0");
  assert.equal(asked.length, 0, "not even asked");
  assert.equal(qtyOf(pg.G, "s"), 5);
});

test("Chase: if the pull moved this ticket off the stack, it says so and asks nothing", async () => {
  const doc = DOC([card("s", "Sol Ring", "a", 2), Object.assign(card("t", "Sol Ring", "b", 2), { collector: "s" })],
    [ticket("P1", "#801", [line("s", "Sol Ring", 2)]), ticket("P2", "#802", [line("s", "Sol Ring", 2)])]);
  doc.locations[0].pickPriority = 5;
  const s = server(doc);
  const pg = await deskPage(s);
  const btn = chaseButton(pg, "s", 2);
  openTicket(pg, "#802");
  s.pull("P1", "s", 2);
  const asked = await chase(pg, btn, "0");
  assert.equal(asked.length, 0);
  assert.match(pg.ui.toasts.at(-1), /doesn't pull from there any more/);
  assert.equal(qtyOf(pg.G, "s"), 2);
});

/* ---------- Complete ---------- */
const completeDoc = () => DOC([card("k", "Kilo", "a", 5)], [ticket("P1", "#801", [line("k", "Kilo", 2)]), ticket("P2", "#802", [line("k", "Kilo", 4)])]);

test("Complete: a pull saved after the page loaded isn't taken, and the picker isn't told to put it back", async () => {
  const s = server(completeDoc());
  const pg = await deskPage(s);
  openTicket(pg, "#802");
  s.pull("P1", "k", 2);
  await pg.$("pickComplete").onclick();
  await settle(20);
  assert.match(pg.ui.confirms.at(-1), /1 line\(s\) do not have enough copies/, "the question knows");
  const p2 = pg.G.pickLists().find(p => p.id === "P2");
  assert.equal(p2.status, "picked");
  assert.equal(p2.lines[0].pickedResult.shortfall, 1, "3 off the shelf, 1 short");
  assert.equal(qtyOf(pg.G, "k"), 2, "the tote's 2 are still on the book");
  const t = { kind: "ticket", id: "P1" };
  const walk = pg.G.rfPickWalk(t);
  assert.equal(walk.putBack.length, 0);
  assert.equal(walk.shorts.length, 0);
  assert.equal(pg.G.rfFinishPicking(t).pulled, 2);
  assert.equal(qtyOf(pg.G, "k"), null, "the shelf is empty, and so is the book");
});

test("Complete: no answer from the server, and it isn't completed, and says so", async () => {
  const s = server(completeDoc());
  const pg = await deskPage(s);
  openTicket(pg, "#802");
  s.down = true;
  await pg.$("pickComplete").onclick();
  await settle(20);
  assert.match(pg.ui.toasts.at(-1), /Couldn't reach the server.*it wasn't completed\. Nothing changed/);
  assert.equal(pg.G.pickLists().find(p => p.id === "P2").status, "open");
  assert.equal(qtyOf(pg.G, "k"), 5);
});

test("Complete: a pull landing while the question is up, making more lines short, stops it", async () => {
  const s = server(completeDoc());
  const pg = await deskPage(s);
  openTicket(pg, "#802");
  pg.ui.confirmDialog = async () => { s.pull("P1", "k", 2); return true; };
  await pg.$("pickComplete").onclick();
  await settle(20);
  assert.match(pg.ui.toasts.at(-1), /more lines are short now/);
  assert.equal(pg.G.pickLists().find(p => p.id === "P2").status, "open");
  assert.equal(qtyOf(pg.G, "k"), 5);
});

test("Nothing moved: no reload, however many times it asks", async () => {
  const s = server(completeDoc());
  const pg = await deskPage(s);
  const loads = () => pg.net.filter(n => n.url === "/api/collection" && n.method === "GET").length;
  const before = loads();
  assert.equal((await pg.G.catchUp()).loaded, false);
  assert.equal((await pg.G.catchUp()).loaded, false);
  assert.equal(loads(), before);
  s.saveElsewhere(() => {});
  const moved = await pg.G.catchUp();
  assert.equal(moved.ok, true);
  assert.equal(moved.loaded, true);
  assert.equal(loads(), before + 1);
});

/* ---------- The short line says why ---------- */
test("a ticket short because of another ticket's tote says so: on screen and printed", async () => {
  const doc = DOC([card("z", "Zeta", "a", 2)], [ticket("P1", "#801", [line("z", "Zeta", 2)], { rfPulls: [pull("z", 2)] }), ticket("P2", "#802", [line("z", "Zeta", 2)])]);
  const pg = await deskPage(server(doc));
  openTicket(pg, "#802");
  const html = pg.$("pickBody").children.map(tr => tr.innerHTML).join("");
  assert.match(html, /short 2 \(2 in a tote, pulled by sam\)/);
  assert.match(html, /none on the shelf/);
  assert.doesNotMatch(html, /none in inventory/);
  const printed = [];
  pg.G.printList = (...a) => printed.push(a);
  await pg.$("pickPrint").onclick();
  await settle(5);
  const row = printed[0][2][0];
  assert.match(row.at(-1), /SHORT 2 \(2 in a tote, pulled by sam\)/);
  assert.match(row.at(-2), /none on the shelf/);
});

test("a line really missing still says none in inventory", async () => {
  const doc = DOC([], [ticket("P2", "#802", [line("z", "Zeta", 2)])]);
  const pg = await deskPage(server(doc));
  openTicket(pg, "#802");
  const html = pg.$("pickBody").children.map(tr => tr.innerHTML).join("");
  assert.match(html, /none in inventory/);
  assert.match(html, /short 2</);
});

/* ---------- The order screen ---------- */
async function orderPage(pickLists, cards) {
  const s = server(DOC(cards, pickLists));
  s.orders = [{ id: "u-1", label: "100-1", status: "unfulfilled", buyer: "Dana", ship: { name: "Dana" },
    lines: [{ kind: "card", set: "tst", collector: "z", lang: "en", finish: "nonfoil", condition: "NM", name: "Zeta", qty: 2 }] }];
  const pg = loadPage("lists.page.js", { routes: s.routes });
  const d = pg.sandbox.document, make = d.createElement;
  d.createElement = tag => {
    const el = make(tag);
    const q = {};
    el.querySelector = sel => (q[sel] = q[sel] || make("input"));
    el.querySelectorAll = sel => (sel === "button" ? [make("button"), make("button"), make("button")] : []);
    return el;
  };
  await pg.G.load();
  await pg.boot();
  await settle(10);
  const tr = pg.$("mpBody").children.find(x => x.className === "click");
  await tr.onclick({ target: tr });
  await settle(5);
  return pg;
}
const orderTicket = extra => ticket("P1", "100-1", [line("z", "Zeta", 2)], Object.assign({ source: "manapool", orderId: "u-1" }, extra));

test("an order being picked isn't short on its own screen: its own tote is still its own", async () => {
  const pg = await orderPage([orderTicket({ rfPulls: [pull("z", 2)] })], [card("z", "Zeta", "a", 2)]);
  const html = pg.$("odBody").innerHTML;
  assert.match(html, /A-1: 2/);
  assert.match(html, /ok-tag/);
  assert.doesNotMatch(html, /not in inventory|short 2/);
});

test("the same for an order in a batch, with its copies in a batch-mate's tote", async () => {
  const mate = ticket("P9", "#900", [line("z", "Zeta", 1)], { batchId: "b1", rfPulls: [pull("z", 2)] });
  const pg = await orderPage([orderTicket({ batchId: "b1" }), mate], [card("z", "Zeta", "a", 2)]);
  assert.match(pg.$("odBody").innerHTML, /A-1: 2/);
});

test("an order short because of another ticket's tote says so on its screen", async () => {
  const other = ticket("P9", "#900", [line("z", "Zeta", 2)], { rfPulls: [pull("z", 2)] });
  const pg = await orderPage([orderTicket(), other], [card("z", "Zeta", "a", 2)]);
  const html = pg.$("odBody").innerHTML;
  assert.match(html, /short 2 \(2 in a tote, pulled by sam\)/);
  assert.match(html, /none on the shelf/);
  assert.doesNotMatch(html, /not in inventory/);
});

test("an order with no ticket yet doesn't count on anyone's tote", async () => {
  const other = ticket("P9", "#900", [line("z", "Zeta", 2)], { rfPulls: [pull("z", 2)] });
  const pg = await orderPage([other], [card("z", "Zeta", "a", 2)]);
  assert.match(pg.$("odBody").innerHTML, /short 2 \(2 in a tote, pulled by sam\)/);
});

/* ---------- Release from the desk (#448) ---------- */
async function batchPage() {
  const s = server(DOC([card("z", "Zeta", "a", 5)], [ticket("P1", "#1", [line("z", "Zeta", 1)]), ticket("P2", "#2", [line("z", "Zeta", 1)])]));
  const pg = await deskPage(s);
  pg.ui.confirmAnswer = true;
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  await pg.$("pqBatch").onclick();
  await settle(10);
  return { s, pg, lists: () => pg.G.pickLists() };
}
const redraw = async pg => { await pg.$("batchStepSort").onclick(); };

test("desk Release on a batch shows only once a ticket was started in Warehouse Mode, not for desk ticks alone", async () => {
  const { pg, lists } = await batchPage();
  for (const p of lists()) p.batchSorted = ["x"];
  await redraw(pg);
  assert.equal(pg.$("batchRelease").hidden, true, "assigned by desk ticks only");
  for (const p of lists()) p.rfPicker = { id: "boss", name: "boss" };
  await redraw(pg);
  assert.equal(pg.$("batchRelease").hidden, false, "started on the floor");
});

test("desk Release catches up first: a batch finished on the floor is not released by a stale page", async () => {
  const { s, pg, lists } = await batchPage();
  for (const p of lists()) p.rfPicker = { id: "boss", name: "boss" };
  await redraw(pg);
  pg.G.persist("start");
  await pg.G.saveNow();
  await settle(30);
  s.doc =JSON.parse(JSON.stringify(Object.assign({}, s.doc, { pickLists: lists().map(p => Object.assign(JSON.parse(JSON.stringify(p)), { status: "picked" })) })));
  s.stamp = "s" + ++s.rev;
  const asked = pg.ui.confirms.length;
  await pg.$("batchRelease").onclick();
  await settle(20);
  assert.equal(pg.ui.confirms.length, asked, "no question for something already finished");
  assert.ok(lists().every(p => p.status === "picked" && p.rfReleased === undefined), "nothing released");
});
