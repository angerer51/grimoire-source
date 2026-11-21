"use strict";
/* The store's kiosk (#433), server side (server/lib/kiosk.js), against a
   scratch dataDir via store.init(): never live data. Pins that the server's
   copy of the stock rules agrees with core.js's on the same inventory (the
   kiosk can't offer a copy the desk thinks is spoken for), that a search
   answers with only what a customer may see, that an order is a held
   counter ticket priced by the server, and that the desk then treats it
   like any walk-in. The routes themselves: test/kiosk.routes.test.js. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { freshCore } = require("../test-lib/core-shim");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const kiosk = lib("kiosk");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-kiosk-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
}

const BOLT = { name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon", tcgplayerId: "1", scryfallId: "sf-bolt",
  price: 2.5, priceNote: "", note: "", meta: {} };
const SPELL = { name: "Counterspell", collector: "50", setName: "Ice Age", rarity: "common", tcgplayerId: "2", scryfallId: "sf-cs",
  price: 1.25, priceNote: "", note: "", meta: {} };
const NOPRICE = { name: "Mystery Card", collector: "7", setName: "Ice Age", rarity: "common", tcgplayerId: "3", scryfallId: "sf-mc",
  price: null, priceNote: "", note: "", meta: {} };
const line = (info, set, qty, extra) => Object.assign({ kind: "card", set, collector: info.collector, lang: "en", finish: "nonfoil",
  condition: "NM", name: info.name, qty }, extra);

/* A store's inventory, built with core.js itself: bolts in two sell-from
   bins (one picked first) and a binder that isn't for sale, a lent and a
   held stack, a card with no market price, and open tickets of every kind
   claiming some of it. */
function inventory() {
  const G = freshCore();
  G.state.locations.push(
    G.newLocation({ id: "bin1", name: "Bin 1", type: "bin" }),
    G.newLocation({ id: "bin2", name: "Bin 2", type: "bin" }),
    G.newLocation({ id: "binder", name: "Binder", type: "binder" }));
  for (const l of G.state.locations) l.sellFrom = l.id !== "binder";
  G.state.locations.find(l => l.id === "bin2").pickPriority = 5;
  const add = (info, set, loc, qty, extra) => G.addCopies(Object.assign({ set, num: info.collector, lang: "en", finish: "nonfoil", condition: "NM",
    locationId: loc, qty, info, unitCost: 0.4, action: "receipt", receiptId: "T1", note: "" }, extra));
  add(BOLT, "a25", "bin1", 8);
  add(BOLT, "a25", "bin2", 2);
  add(BOLT, "a25", "binder", 3);
  add(BOLT, "a25", "bin1", 2, { condition: "LP" });
  const cs = add(SPELL, "ice", "bin1", 3);
  cs.loans = [{ id: "ln1", qty: 1, to: "Friend", at: new Date().toISOString() }];
  add(SPELL, "ice", "bin2", 2, { held: "LOT-2026-0001" });
  add(NOPRICE, "ice", "bin1", 5);
  const ticket = (source, lines) => { const p = G.newPickList({ source }); p.lines = lines; G.pickLists().push(p); return p; };
  ticket("manapool", [line(BOLT, "a25", 3)]);                        // sell-from only: bin2's 2 first, then 1 from bin1
  ticket("manual", [line(BOLT, "a25", 2, { collector: "", set: "" })]); // by name, any location
  ticket("walkin", [line(SPELL, "ice", 1)]);
  return G;
}
const sorted = m => [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const plain = o => JSON.parse(JSON.stringify(o));

test("free to sell agrees with core.js's counterFree on the same inventory", () => {
  const G = inventory();
  const core = new Map(Object.entries(plain(Object.fromEntries(G.counterFree()))));
  const server = kiosk.freeStock(plain(G.state));
  assert.deepEqual(sorted(server), sorted(core));
  assert.ok([...server.values()].some(n => n > 0), "some stock is free");
});

/* Manapool orders as the orders cache holds them: condition in words, one
   already on a ticket, one finished, one open with no pick list yet. */
function fetched(G) {
  const mp = G.pickLists().find(p => p.source === "manapool");
  mp.orderId = "mp-ticketed";
  const ol = (info, set, qty, condition) => ({ kind: "card", set, collector: info.collector, lang: "en", finish: "nonfoil", condition, name: info.name, qty });
  return [
    { id: "mp-new", status: "unfulfilled", placedAt: "2026-11-08T10:00:00Z", lines: [ol(BOLT, "a25", 2, "Near Mint"), ol(SPELL, "ice", 1, "near mint")] },
    { id: "mp-old", status: "processing", placedAt: "2026-11-07T10:00:00Z", lines: [ol(BOLT, "a25", 1, "Lightly Played")] },
    { id: "mp-ticketed", status: "unfulfilled", placedAt: "2026-11-06T10:00:00Z", lines: [ol(BOLT, "a25", 3, "Near Mint")] },
    { id: "mp-done", status: "Shipped", placedAt: "2026-11-05T10:00:00Z", lines: [ol(BOLT, "a25", 4, "Near Mint")] }
  ];
}

test("Manapool orders fetched but not yet on a pick list hold their copies, exactly as core.js counts them", () => {
  const G = inventory();
  const orders = fetched(G);
  const before = kiosk.freeStock(plain(G.state));
  G.setManapoolOrders(plain(orders));
  const core = new Map(Object.entries(plain(Object.fromEntries(G.counterFree()))));
  const server = kiosk.freeStock(plain(G.state), plain(orders));
  assert.deepEqual(sorted(server), sorted(core));
  const total = m => [...m.values()].reduce((s, n) => s + n, 0);
  // mp-new's 2 bolts + 1 Counterspell and mp-old's LP bolt; the ticketed and shipped orders hold nothing more.
  assert.equal(total(before) - total(server), 4);
  const lines = kiosk.unpickedOrderLines(plain(G.state), plain(orders));
  assert.deepEqual(lines.map(l => l.name + " " + l.condition + " " + l.qty), ["Lightning Bolt LP 1", "Lightning Bolt NM 2", "Counterspell NM 1"],
    "oldest first, condition words as codes");
});

test("the offer: sell-from stock with a market price, free copies only, and nothing a customer shouldn't see", () => {
  const G = inventory();
  const units = kiosk.kioskUnits(plain(G.state));
  const by = Object.fromEntries(units.map(u => [u.name + " " + u.condition, u]));
  // Bolts NM: bin1 8 + bin2 2, less the Manapool ticket's 3 and whatever the manual
  // ticket's 2 (by name, any location) take from them: the parity test above pins where.
  const freeNm = [...kiosk.freeStock(plain(G.state))].filter(([id]) => {
    const r = G.state.cards.find(c => c.id === id);
    return r.name === "Lightning Bolt" && r.condition === "NM";
  }).reduce((s, [, n]) => s + n, 0);
  assert.equal(by["Lightning Bolt NM"].free, freeNm);
  assert.equal(by["Lightning Bolt NM"].price, 2.5);
  assert.equal(by["Lightning Bolt LP"].free, 2);
  // Counterspell: 3 less 1 lent less 1 on the walk-in; the held stack is nobody's to sell.
  assert.equal(by["Counterspell NM"].free, 1);
  assert.ok(!units.some(u => u.name === "Mystery Card"), "no market price, not offered");
});

test("a search answers only the customer's fields: no cost, location, stack ids or notes", async () => {
  scratch();
  const G = inventory();
  await store.writeCollection("kioskowner", plain(G.state));
  const r = await kiosk.search("kioskowner", "bolt");
  assert.ok(r.rows.length >= 2);
  const allowed = ["key", "name", "set", "setName", "collector", "lang", "finish", "condition", "price", "free", "imageUrl"];
  for (const row of r.rows) assert.deepEqual(Object.keys(row).sort(), allowed.slice().sort());
  const text = JSON.stringify(r);
  for (const word of ["avgCost", "costTotal", "costQty", "locationId", "bin1", "Binder", "loans", "held", "acquiredAt"]) {
    assert.ok(!text.includes(word), word + " stays on the server");
  }
  assert.deepEqual((await kiosk.search("kioskowner", "")).rows.map(u => u.key), kiosk.kioskUnits(plain(G.state)).map(u => u.key),
    "nothing typed: the whole offer, to browse (#438)");
  assert.equal((await kiosk.search("kioskowner", "a25 141")).rows.length, 2, "set code and number match, as on the desk");
});

/* Browse (#438): a shop's offer to page through and narrow with no typing. */
const stack = (id, name, set, collector, price, extra) => Object.assign({ id, set, collector, lang: "en", finish: "nonfoil", condition: "NM",
  name, setName: set.toUpperCase() + " set", scryfallId: "sf-" + id, price, quantity: 2, locationId: "bin1",
  avgCost: 0.37, costQty: 2, costTotal: 0.74 }, extra);
function shop() {
  const cards = [
    stack("b1", "Lightning Bolt", "a25", "141", 2.5, { typeLine: "Instant", colors: ["R"], rarity: "uncommon" }),
    stack("b2", "Lightning Bolt", "a25", "141", 1.8, { condition: "LP", typeLine: "Instant", colors: ["R"], rarity: "uncommon" }),
    stack("g1", "Grizzly Bears", "m10", "180", 0.25, { typeLine: "Creature — Bear", colors: ["G"], rarity: "common" }),
    stack("s1", "Sol Ring", "c21", "263", 1.5, { typeLine: "Artifact", colors: [], rarity: "uncommon" }),
    stack("r1", "Rhox War Monk", "m10", "222", 0.6, { typeLine: "Creature — Rhino Monk", colors: ["G", "W", "U"], rarity: "uncommon" }),
    stack("l1", "Dryad Arbor", "m10", "300", 40, { typeLine: "Land Creature — Forest Dryad", colors: ["G"], rarity: "rare" }),
    stack("x1", "Not For Sale", "m10", "1", 9, { locationId: "binder", typeLine: "Instant", colors: ["U"], rarity: "mythic" })
  ];
  // Enough commons to need a second page.
  for (let i = 0; i < kiosk.FIND_MAX + 5; i++) cards.push(stack("f" + i, "Filler " + String(i).padStart(2, "0"), "fil", String(i), 0.1,
    { typeLine: "Sorcery", colors: ["B"], rarity: "common" }));
  return { locations: [{ id: "bin1", name: "Bin 1", type: "bin", sellFrom: true }, { id: "binder", name: "Binder", type: "binder", sellFrom: false }],
    cards, sealed: [], pickLists: [], customers: [] };
}
const names = r => [...new Set(r.rows.map(u => u.name))];

test("browse: nothing typed pages through the whole offer; the filters narrow it, alone or with the search box", async () => {
  scratch();
  await store.writeCollection("kioskowner", shop());
  const p0 = await kiosk.search("kioskowner", "", { page: 0 });
  assert.equal(p0.rows.length, kiosk.FIND_MAX);
  assert.equal(p0.more, true);
  const p1 = await kiosk.search("kioskowner", "", { page: 1 });
  assert.equal(p0.rows.length + p1.rows.length, 6 + kiosk.FIND_MAX + 5, "every unit for sale, once, across the pages");
  assert.equal(p1.more, false);
  assert.ok(![...p0.rows, ...p1.rows].some(u => u.name === "Not For Sale"), "not in a sell-from location, not offered");
  const by = async f => names(await kiosk.search("kioskowner", "", f));
  assert.deepEqual(await by({ set: "m10" }), ["Dryad Arbor", "Grizzly Bears", "Rhox War Monk"]);
  assert.deepEqual(await by({ colors: ["R"] }), ["Lightning Bolt"]);
  assert.deepEqual(await by({ colors: ["W", "R"] }), ["Lightning Bolt", "Rhox War Monk"], "any of the colours picked");
  assert.deepEqual(await by({ colors: ["M"] }), ["Rhox War Monk"], "multicolour");
  assert.deepEqual(await by({ colors: ["C"] }), ["Sol Ring"], "colourless");
  assert.deepEqual(await by({ type: "Creature" }), ["Dryad Arbor", "Grizzly Bears", "Rhox War Monk"], "a land creature is filed as a creature");
  assert.deepEqual(await by({ rarity: "rare" }), ["Dryad Arbor"]);
  assert.deepEqual(await by({ min: 1, max: 5 }), ["Lightning Bolt", "Sol Ring"]);
  assert.deepEqual(await by({ min: 20 }), ["Dryad Arbor"]);
  assert.deepEqual(await by({ set: "m10", type: "Creature", colors: ["W"] }), ["Rhox War Monk"], "filters combine");
  assert.deepEqual(names(await kiosk.search("kioskowner", "bears", { set: "m10" })), ["Grizzly Bears"], "and combine with the search box");
  assert.deepEqual(names(await kiosk.search("kioskowner", "bolt", { set: "m10" })), []);

  const f = (await kiosk.search("kioskowner", "", { facets: true })).facets;
  assert.deepEqual(f.sets.map(s => s[0]), ["a25", "c21", "fil", "m10"], "only the sets in stock, by name");
  assert.deepEqual(f.colors, ["W", "U", "B", "R", "G", "M", "C"]);
  assert.deepEqual(f.types, ["Creature", "Instant", "Sorcery", "Artifact"]);
  assert.deepEqual(f.rarities, ["common", "uncommon", "rare"], "the binder's mythic isn't for sale, so it isn't a choice");
});

test("a stack saved without its card details (colors: [], no type) is filed by the card index, not as colorless", async () => {
  scratch();
  // As saved: colors is always an array, empty until the details are filled in.
  const bare = stack("bare", "Lightning Bolt", "a25", "141", 2.5, { colors: [], typeLine: "", rarity: "" });
  const solRing = stack("s1", "Sol Ring", "c21", "263", 1.5, { typeLine: "Artifact", colors: [], rarity: "uncommon" });
  await store.writeCollection("kioskowner", { locations: [{ id: "bin1", name: "Bin 1", type: "bin", sellFrom: true }],
    cards: [bare, solRing], sealed: [], pickLists: [], customers: [] });
  const by = async f => names(await kiosk.search("kioskowner", "", f));
  // No card index loaded: unknown, so it's under no colour (never "Colorless").
  assert.deepEqual(await by({ colors: ["C"] }), ["Sol Ring"]);
  assert.deepEqual(await by({ colors: ["R"] }), []);
  const cards = lib("cards");
  const real = cards.cardByKey;
  cards.cardByKey = (set, num) => set === "a25" && String(num) === "141"
    ? { id: "sf-index-bolt", colors: ["R"], typeLine: "Instant", rarity: "uncommon" } : null;
  try {
    await store.writeCollection("kioskowner", { locations: [{ id: "bin1", name: "Bin 1", type: "bin", sellFrom: true }],
      cards: [Object.assign({}, bare, { quantity: 3 }), solRing], sealed: [], pickLists: [], customers: [] });
    assert.deepEqual(await by({ colors: ["R"] }), ["Lightning Bolt"], "red, from the card index");
    assert.deepEqual(await by({ colors: ["C"] }), ["Sol Ring"], "a colorless card with its details stays colorless");
    assert.deepEqual(await by({ type: "Instant" }), ["Lightning Bolt"], "type from the index too");
    assert.deepEqual(await by({ rarity: "uncommon" }), ["Lightning Bolt", "Sol Ring"], "and rarity");
  } finally {
    cards.cardByKey = real;
  }
});

test("the filters from the request: only known values, a bounded page", () => {
  const f = kiosk.filtersFrom(new URLSearchParams("set=M10&colors=r,w,x,M&type=Creature&rarity=Mythic&min=1&max=abc&page=99999&facets=1"));
  assert.deepEqual([f.set, f.colors, f.type, f.rarity, f.min, f.max, f.facets, f.popular], ["m10", ["R", "W", "M"], "Creature", "mythic", 1, null, true, false]);
  assert.ok(f.page < 1000);
  const junk = kiosk.filtersFrom(new URLSearchParams("type=<script>&rarity=gold&min=-3&page=-2"));
  assert.deepEqual([junk.type, junk.rarity, junk.min, junk.page], ["", "", null, 0]);
});

test("the Popular row: SELLING FAST cards in stock, one copy each, a yes only: no counts or other figures", async () => {
  scratch();
  await store.writeCollection("kioskowner", shop());
  // The sales: Bolt and the binder's card selling fast, Sol Ring sold but not fast.
  kiosk.setSalesSource({ key: () => "day1", bySid: sids => new Map([
    ["sf-b1", { hot: true, copies7: 7351, sales7: 2077 }], ["sf-x1", { hot: true, copies7: 9999, sales7: 5000 }],
    ["sf-s1", { hot: false, copies7: 4, sales7: 2 }], ["sf-g1", { hot: true, copies7: 4423, sales7: 1201 }]].filter(([k]) => sids.includes(k))) });
  try {
    const r = await kiosk.search("kioskowner", "", { popular: true });
    assert.deepEqual(r.popular.map(u => u.name + " " + u.condition), ["Lightning Bolt NM", "Grizzly Bears NM"],
      "fastest first, the best condition of each; the binder's copy isn't for sale");
    const allowed = ["key", "name", "set", "setName", "collector", "lang", "finish", "condition", "price", "free", "imageUrl", "popular"];
    for (const row of [...r.popular, ...r.rows]) {
      for (const k of Object.keys(row)) assert.ok(allowed.includes(k), k + " reached the kiosk");
    }
    assert.ok(r.popular.every(u => u.popular === true));
    const grid = await kiosk.search("kioskowner", "", { colors: ["R", "G"] });
    assert.deepEqual(grid.rows.filter(u => u.popular).map(u => u.name + " " + u.condition), ["Grizzly Bears NM", "Lightning Bolt NM", "Lightning Bolt LP"],
      "the grid flags them too");
    const text = JSON.stringify(await kiosk.search("kioskowner", "", { popular: true, facets: true }));
    for (const word of ["7351", "4423", "2077", "copies7", "sales7", "sid", "sf-", "avgCost", "costTotal", "0.37", "0.74", "locationId", "bin1", "Binder", "typeLine", "colorIdentity"]) {
      assert.ok(!text.includes(word), word + " stays on the server");
    }
    // No sales history (no price archive open): no Popular row, and browsing still works.
    kiosk.setSalesSource({ key: () => { throw new Error("The price archive is not open."); }, bySid: () => new Map() });
    const none = await kiosk.search("kioskowner", "", { popular: true });
    assert.deepEqual(none.popular, []);
    assert.equal(none.rows.length, kiosk.FIND_MAX);
  } finally {
    kiosk.setSalesSource({ key: () => "none", bySid: () => new Map() });
  }
});

test("an order is an open kiosk ticket at the server's price, held at once; what isn't free is refused", async () => {
  scratch();
  const G = inventory();
  await store.writeCollection("kioskowner", plain(G.state));
  const [boltNm] = (await kiosk.search("kioskowner", "bolt")).rows.filter(u => u.condition === "NM");
  const free = boltNm.free;

  await assert.rejects(kiosk.placeOrder("kioskowner", { name: "", contact: "a@b.co", lines: [{ key: boltNm.key, qty: 1 }] }), e => e.status === 400 && e.field === "name");
  await assert.rejects(kiosk.placeOrder("kioskowner", { name: "Sam", contact: "", lines: [{ key: boltNm.key, qty: 1 }] }), e => e.status === 400 && e.field === "contact");
  await assert.rejects(kiosk.placeOrder("kioskowner", { name: "Sam", contact: "not a thing", lines: [{ key: boltNm.key, qty: 1 }] }), e => e.status === 400);
  await assert.rejects(kiosk.placeOrder("kioskowner", { name: "Sam", contact: "a@b.co", lines: [] }), e => e.status === 400);

  // The customer's screen names cards and quantities only: a price it sends is ignored.
  const { ticket } = await kiosk.placeOrder("kioskowner", { name: " Sam  Jones ", contact: "555-123-4567",
    lines: [{ key: boltNm.key, qty: 1, unitPrice: 0.01 }] });
  assert.match(ticket.id, /^KIOSK-\d{4}-0001$/);
  assert.equal(ticket.source, "kiosk");
  assert.equal(ticket.status, "open");
  assert.deepEqual(ticket.customer, { id: "", name: "Sam Jones", email: "", phone: "555-123-4567" });
  assert.equal(ticket.lines[0].unitPrice, 2.5);
  assert.deepEqual(kiosk.receipt(ticket), { id: ticket.id, cards: 1, total: 2.5 });

  const saved = (await store.readCollection("kioskowner")).state;
  assert.ok(saved.pickLists.some(p => p.id === ticket.id && p.source === "kiosk"), "written to the saved inventory");
  const after1 = (await kiosk.search("kioskowner", "bolt")).rows.find(u => u.key === boltNm.key);
  assert.equal(after1.free, free - 1, "set aside at once: the next customer sees one fewer");

  await assert.rejects(kiosk.placeOrder("kioskowner", { name: "Ann", contact: "ann@x.io", lines: [{ key: boltNm.key, qty: free }] }),
    e => e.status === 409 && e.short.length === 1 && e.short[0].free === free - 1);
  await assert.rejects(kiosk.placeOrder("kioskowner", { name: "Ann", contact: "ann@x.io", lines: [{ key: "no|such|card|nonfoil|NM", qty: 1 }] }),
    e => e.status === 409);
  const second = await kiosk.placeOrder("kioskowner", { name: "Ann", contact: "Ann@X.io", lines: [{ key: boltNm.key, qty: 1 }] });
  assert.match(second.ticket.id, /-0002$/);
  assert.equal(second.ticket.customer.email, "ann@x.io");
});

test("by default no limit on an order's size: only what's free to sell bounds it", async () => {
  scratch();
  const cards = [];
  for (let i = 1; i <= 60; i++) {
    cards.push({ id: "c" + i, set: "big", collector: String(i), lang: "en", finish: "nonfoil", condition: "NM", name: "Card " + i,
      price: 1, quantity: 2000, locationId: "bin1" });
  }
  await store.writeCollection("bigshop", { locations: [{ id: "bin1", name: "Bin 1", sellFrom: true }], cards, pickLists: [] });
  const lines = cards.map(c => ({ key: "big|" + c.collector + "|en|nonfoil|NM", qty: 1500 }));
  const { ticket } = await kiosk.placeOrder("bigshop", { name: "Collector", contact: "c@x.io", lines });
  assert.equal(ticket.lines.length, 60, "60 different cards in one order");
  assert.equal(kiosk.receipt(ticket).cards, 90000);
  await assert.rejects(kiosk.placeOrder("bigshop", { name: "Collector", contact: "c@x.io", lines: [{ key: lines[0].key, qty: 501 }] }),
    e => e.status === 409 && e.short[0].free === 500, "more than is free is refused as short, not as too big");
});

test("the account's limits: most cards per order (none by default) and most orders waiting (50 by default)", async () => {
  scratch();
  const cards = [];
  for (let i = 1; i <= 3; i++) cards.push({ id: "c" + i, set: "lim", collector: String(i), lang: "en", finish: "nonfoil", condition: "NM",
    name: "Card " + i, price: 1, quantity: 100, locationId: "bin1" });
  await store.writeCollection("limshop", { locations: [{ id: "bin1", name: "Bin 1", sellFrom: true }], cards, pickLists: [] });
  const key = i => "lim|" + i + "|en|nonfoil|NM";
  const order = lines => kiosk.placeOrder("limshop", { name: "Sam", contact: "s@x.io", lines });
  const boss = { id: "limshop" };
  assert.deepEqual(await kiosk.limits("limshop"), { maxCards: null, maxWaiting: 50 });

  for (const bad of [0, -1, 1.5, "abc", "2x", true, {}]) {
    await assert.rejects(kiosk.setLimits("limshop", { maxCards: bad }, boss), e => e.status === 400, JSON.stringify(bad));
    await assert.rejects(kiosk.setLimits("limshop", { maxWaiting: bad }, boss), e => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(await kiosk.limits("limshop"), { maxCards: null, maxWaiting: 50 }, "a refused change changes nothing");

  assert.deepEqual(await kiosk.setLimits("limshop", { maxCards: "5", maxWaiting: 2 }, boss), { maxCards: 5, maxWaiting: 2 });
  await assert.rejects(order([{ key: key(1), qty: 4 }, { key: key(2), qty: 2 }]), e => e.status === 400 && /up to 5 cards/.test(e.message));
  await order([{ key: key(1), qty: 3 }, { key: key(2), qty: 2 }]);                  // exactly 5: fine
  await order([{ key: key(3), qty: 1 }]);
  await assert.rejects(order([{ key: key(3), qty: 1 }]), e => e.status === 409, "two waiting: the third waits for staff");

  // Blank = no limit, for both.
  assert.deepEqual(await kiosk.setLimits("limshop", { maxCards: "", maxWaiting: null }, boss), { maxCards: null, maxWaiting: null });
  await order([{ key: key(3), qty: 99 }]);
  await assert.rejects(order([{ key: key(1), qty: 98 }]), e => e.status === 409 && e.short[0].free === 97, "still never more than is free");
  // The PIN and the limits share the account's record without wiping each other.
  await kiosk.setPin("limshop", "1357", boss);
  assert.deepEqual(await kiosk.limits("limshop"), { maxCards: null, maxWaiting: null });
  await kiosk.setLimits("limshop", { maxCards: 9 }, boss);
  assert.equal(await kiosk.checkPin("limshop", "1357"), true);
});

test("the desk takes a kiosk order like a walk-in: picked, handed over with the payment, or cancelled", async () => {
  scratch();
  const G0 = inventory();
  await store.writeCollection("kioskowner", plain(G0.state));
  const [boltNm] = (await kiosk.search("kioskowner", "bolt")).rows.filter(u => u.condition === "NM");
  const { ticket } = await kiosk.placeOrder("kioskowner", { name: "Sam", contact: "sam@x.io", lines: [{ key: boltNm.key, qty: 1 }] });

  const G = freshCore();
  G.adoptState(plain((await store.readCollection("kioskowner")).state));
  const p = G.pickLists().find(x => x.id === ticket.id);
  assert.ok(G.isCounterSale(p));
  assert.equal(G.pickListTag(p), ticket.id, "the number already says Kiosk");
  assert.equal(G.counterSaleName(p), "Sam");
  assert.equal(G.counterContact(p), "sam@x.io");
  assert.deepEqual(plain(G.pickListAllocOpts(p)), { sellFromOnly: true });
  const before = G.state.cards.reduce((s, r) => s + r.quantity, 0);
  G.completePickList(p.id);
  assert.equal(G.state.cards.reduce((s, r) => s + r.quantity, 0), before - 1);
  assert.equal(G.saleDate(p), null, "not a sale until it's handed over");
  const done = G.handOverCounterSale(p.id, "cash");
  assert.deepEqual(plain(done.payment), { method: "cash", total: 2.5 });
  assert.ok(G.saleDate(p));

  // A second order, never collected: cancelling it frees the cards.
  const G2 = freshCore();
  G2.adoptState(plain((await store.readCollection("kioskowner")).state));
  const out = G2.cancelCounterSale(ticket.id);
  assert.equal(out.ok, true);
  assert.ok(!G2.pickLists().some(x => x.id === ticket.id));
});

test("the staff PIN: digits only, hashed, one per account", async () => {
  scratch();
  await assert.rejects(kiosk.setPin("someone", "12a4", { id: "someone" }), e => e.status === 400);
  await assert.rejects(kiosk.setPin("someone", "123", { id: "someone" }), e => e.status === 400);
  assert.equal(await kiosk.hasPin("someone"), false);
  await kiosk.setPin("someone", "2468", { id: "someone" });
  assert.equal(await kiosk.hasPin("someone"), true);
  assert.equal(await kiosk.checkPin("someone", "2468"), true);
  assert.equal(await kiosk.checkPin("someone", "2469"), false);
  assert.equal(await kiosk.checkPin("someone", ""), false);
  assert.equal(await kiosk.checkPin("someone else", "2468"), false, "another account's PIN doesn't open this one");
  assert.ok(!fs.readFileSync(store.p("kiosk-accounts.json"), "utf8").includes("2468"), "never stored as typed");
});
