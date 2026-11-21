"use strict";
/* #298: each person picks, orders and sizes their Dashboard tiles, and there
   are more tiles to pick from. Through the real public/index.page.js with
   the page-shim's stand-in DOM (not a browser), plus core.js's counting
   helpers directly:
   - nobody's Dashboard changes until they customize (default = the old set);
   - Customize -> move, hide, add, make wide -> Done saves a per-person
     layout (an org member's own prefs, never the Store's document);
   - Reset asks first; a saved tile that's gone or not allowed is skipped;
   - a server-backed tile asks once per visit, and only when it's shown;
   - the counts behind the new tiles. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");
const { freshCore } = require("../test-lib/core-shim");

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
// core.js runs in its own realm: compare its values as plain data.
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

async function open(opts) {
  const o = opts || {};
  const user = { id: "u1", username: "u", createdAt: "2026-01-01T00:00:00Z", email: "",
    orgId: o.org ? "o1" : null, orgRole: o.org ? "staff" : null, role: o.role || "user" };
  const state = Object.assign({
    cards: [{ id: "c1", name: "Lightning Bolt", set: "lea", collector: "161", quantity: 2, locationId: "l1", typeLine: "Instant", price: 5 }],
    locations: [{ id: "l1", name: "Box", type: "box" }],
    settings: Object.assign({}, o.settings || {})
  }, o.state || {});
  const routes = (url, init) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/auth/me") return { user, personalPrefs: o.org ? (o.personalPrefs || {}) : null };
    if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state, owner: o.org ? "store:st1" : "u1" };
    if (url === "/api/tickets") return { tickets: [] };
    if (url.startsWith("/api/admin/tickets")) return { total: 0 };
    if (url.startsWith("/api/audit?")) return { entries: [], total: null };
    if (url.startsWith("/api/prices/portfolio")) return o.portfolio || { points: [] };
    if (url.startsWith("/api/prices/movers")) return o.movers || { rows: [] };
    if (url === "/api/prices/selling-fast?limit=100") return o.selling || { cards: [] };
    if (url === "/api/prices/sold-mine") return o.soldMine || {};
    if (url === "/api/trades") return o.trades || { data: [] };
    if (url === "/api/friends") return o.friends || { requests: { incoming: [] } };
    if (url === "/api/prefs/personal") return { personalPrefs: {} };
    return {};
  };
  const page = loadPage("index.page.js", { routes });
  await page.G.load();
  await page.boot();
  await settle(10);
  // A click on a button inside #tiles / #tilesBar (the page delegates).
  page.act = async (act, id) => {
    const box = act === "customize" || act === "add" || act === "done" || act === "reset" ? "tilesBar" : "tiles";
    await page.$(box).onclick({ target: { closest: () => ({ dataset: { act, id }, disabled: false }) }, preventDefault() {} });
    await settle(5);
  };
  page.ids = () => [...page.$("tiles").innerHTML.matchAll(/data-tile="([^"]+)"/g)].map(m => m[1]);
  return page;
}

test("#298: a new account's Dashboard shows the same tiles, in the same order, as before", async () => {
  const full = await open({});
  assert.deepEqual(full.ids(), ["cards", "value", "cost", "gain", "locations", "sealed", "listed", "picklist", "decklist",
    "watching", "overdue"], "no tickets, not a moderator: those two stay out, as before");
  assert.match(full.$("tilesBar").innerHTML, /data-act="customize"/);
  const simple = await open({ settings: { simpleMode: true } });
  assert.deepEqual(simple.ids(), ["cards", "value", "locations", "watching"]);
  assert.doesNotMatch(simple.$("tiles").innerHTML, /putaway/i);
  const mod = await open({ role: "moderator" });
  assert.equal(mod.ids().at(-1), "queue", "moderators keep the Support queue tile");
  for (const p of [full, simple, mod]) {
    assert.ok(!p.net.some(r => /prices\/(portfolio|movers|selling-fast)/.test(r.url)),
      "no new tile is on, so none of their data is fetched");
    // #299: the trades to-do shares the Trades tile's fetch: once per visit, tile or not.
    assert.equal(p.net.filter(r => /\/api\/trades/.test(r.url)).length, 1, "one trades request, shared with the to-do");
  }
});

test("#298: Customize, move, hide, add, make wide, Done: saved in the person's own prefs, not the Store's", async () => {
  const page = await open({ org: true });
  await page.act("customize");
  const t = page.$("tiles").innerHTML;
  assert.match(t, /class="tiles?/);
  assert.match(t, /data-act="left" data-id="value" title="Move Market value earlier" aria-label="Move Market value earlier"/, "icon buttons say what they do, twice");
  assert.match(t, /data-act="left" data-id="cards"[^>]* disabled>/, "the first tile can't go earlier");
  assert.match(t, /title="Drag to move" aria-label="Drag to move"/);
  assert.doesNotMatch(t, /<a href=/, "no links while customizing");
  assert.match(page.$("tilesBar").innerHTML, /data-act="add" data-id="movers"/, "hidden tiles are in the tray");

  await page.act("right", "cards");
  await page.act("hide", "cost");
  await page.act("add", "topCard");
  await page.act("wide", "topCard");
  assert.deepEqual(page.ids().slice(0, 3), ["value", "cards", "gain"]);
  assert.equal(page.ids().at(-1), "topCard");
  assert.match(page.$("tilesBar").innerHTML, /data-act="add" data-id="cost"/, "a hidden tile goes back in the tray");

  await page.act("done");
  const sent = page.net.filter(r => r.url === "/api/prefs/personal" && r.body && r.body.dashTiles);
  assert.equal(sent.length, 1);
  const saved = sent[0].body.dashTiles;
  assert.deepEqual(saved.slice(0, 3), [{ id: "value" }, { id: "cards" }, { id: "gain" }]);
  assert.deepEqual(saved.find(x => x.id === "topCard"), { id: "topCard", wide: true });
  assert.deepEqual(saved.at(-1), { id: "queue" }, "a default tile this role can't see is kept for later, not lost");
  assert.ok(!saved.some(x => x.id === "cost"));
  assert.equal(page.G.state.settings.dashTiles, undefined, "the Store's shared settings are untouched");
  assert.doesNotMatch(page.$("tiles").innerHTML, /data-act=/, "back to plain tiles");
  assert.match(page.$("tiles").innerHTML, /data-tile="topCard" class="tile  wide">/);
  assert.match(page.$("tiles").innerHTML, /Lightning Bolt/, "the wide tile lists the card");

  // A reload, and a coworker with no layout of their own.
  const again = await open({ org: true, personalPrefs: { dashTiles: saved } });
  assert.deepEqual(again.ids(), page.ids());
  const coworker = await open({ org: true });
  assert.equal(coworker.ids()[0], "cards");
});

test("#298: a personal account keeps its layout in its own document", async () => {
  const page = await open({});
  await page.act("customize");
  await page.act("hide", "cards");
  await page.act("done");
  assert.ok(Array.isArray(page.G.state.settings.dashTiles));
  assert.ok(!page.G.state.settings.dashTiles.some(x => x.id === "cards"));
  assert.equal(page.ids()[0], "value");
});

test("#298: Reset asks first, then goes back to the default layout", async () => {
  const layout = [{ id: "avgValue" }, { id: "cards" }];
  const page = await open({ org: true, personalPrefs: { dashTiles: layout } });
  assert.deepEqual(page.ids(), ["avgValue", "cards"]);
  await page.act("customize");
  page.ui.confirmAnswer = false;
  await page.act("reset");
  assert.equal(page.ui.confirms.length, 1);
  assert.ok(!page.net.some(r => r.url === "/api/prefs/personal" && r.body && "dashTiles" in r.body), "cancelled: nothing saved");
  page.ui.confirmAnswer = true;
  await page.act("reset");
  assert.ok(page.net.some(r => r.url === "/api/prefs/personal" && r.body && r.body.dashTiles === null));
  assert.equal(page.ids()[0], "cards");
  assert.equal(page.ids()[1], "value");
});

test("#298: saved tiles that are gone or not allowed are skipped, and kept for full mode", async () => {
  const layout = [{ id: "noSuchTile" }, { id: "profit" }, { id: "avgValue" }, { id: "queue" }, { id: "cards", wide: true }];
  const page = await open({ org: true, personalPrefs: { simpleMode: true, dashTiles: layout } });
  assert.deepEqual(page.ids(), ["avgValue", "cards"], "Profit is full-mode only; the queue is for moderators");
  assert.match(page.$("tiles").innerHTML, /data-tile="cards" class="tile "/, "Cards can't be wide: drawn small");
  await page.act("customize");
  assert.doesNotMatch(page.$("tilesBar").innerHTML, /data-id="profit"|data-id="putaway"/, "the tray only offers what Simple mode shows");
  await page.act("hide", "avgValue");
  await page.act("done");
  const saved = page.net.find(r => r.url === "/api/prefs/personal" && r.body && r.body.dashTiles).body.dashTiles;
  assert.deepEqual(saved.map(x => x.id), ["cards", "profit", "queue"], "full-mode and moderator tiles survive a Simple-mode save; the unknown one goes");
});

test("#298: a server-backed tile asks once, however often the page redraws", async () => {
  const page = await open({ org: true, personalPrefs: { dashTiles: [{ id: "valueChange" }, { id: "movers", wide: true }, { id: "trades" }, { id: "selling", wide: true }] },
    movers: { fromDate: "2026-10-10", toDate: "2026-10-17", held: { nowValue: 90, netValue: -10, thenValue: 100, up: 0, down: 2 },
      rows: [{ name: "Ragavan", qty: 1, delta: 5, pct: 10, valueDelta: 5 }, { name: "Sol Ring", qty: 2, delta: -1, pct: -4, valueDelta: -2 }] },
    selling: { cards: [{ name: "Island", copies7: 90, rank: 1 }, { name: "Lightning Bolt", copies7: 40, rank: 2, atLeast7: true },
      { name: "Sol Ring", copies7: 30, rank: 3 }, { name: "Plains", copies7: 20, rank: 4 }] },
    trades: { data: [{ id: "p1", incoming: true, status: "open" }, { id: "p2", incoming: true, status: "accepted" }, { id: "p3", outgoing: true, status: "open" }] },
    friends: { requests: { incoming: [{ id: "f1" }] } } });
  for (let i = 0; i < 3; i++) page.G.emit("change");
  await settle(10);
  for (const u of ["/api/trades", "/api/friends", "/api/prices/selling-fast?limit=100"]) {
    assert.equal(page.net.filter(r => r.url === u).length, 1, u);
  }
  assert.equal(page.net.filter(r => r.url.startsWith("/api/prices/movers?days=7")).length, 1,
    "Value change and Biggest movers share one request");
  assert.ok(!page.net.some(r => r.url.startsWith("/api/prices/portfolio")));
  const t = page.$("tiles").innerHTML;
  assert.match(t, /▼ \$10\.00<\/span><span class="lbl">Value change, 7 days/, "an arrow, not colour alone");
  assert.match(t, /-10\.0% from card prices/);
  assert.match(t, /Ragavan/);
  assert.match(t, /Sol Ring/, "wide: the top few");
  assert.match(t, /<span class="big ">2<\/span><span class="lbl">Trades/, "one open offer to you + one friend request");
  assert.match(t, /<span class="big ">1<\/span><span class="lbl">Selling fast/, "how many of the top sellers you have");
  assert.match(t, /you have 1 of the top 4 sellers this week/);
  assert.match(t, /#1<\/span> <b>Island<\/b><\/span><span class="fnum">90 sold 7d/, "wide: the top 3 overall, Island not held");
  assert.match(t, /#2<\/span> <b>Lightning Bolt<\/b> <span class="tile-have">[^<]*(<[^>]*>)*[^<]*you have it<\/span><\/span><span class="fnum">≥ 40 sold 7d/,
    "a card you have is marked in words");
  assert.doesNotMatch(t, /Plains/, "only the top 3");
  assert.doesNotMatch(t, /Manapool's top 100/);
});

test("#366: the Selling fast tile adds how many of your listed cards are SELLING FAST, linking to just those", async () => {
  const sales = { historySince: "2026-10-18", historyDays: 19, window7Complete: true, comparable: true };
  const cards = [
    { id: "c1", name: "Lightning Bolt", set: "lea", collector: "161", quantity: 2, listedQty: 1, locationId: "l1", typeLine: "Instant", price: 5 },
    { id: "c2", name: "Lightning Bolt", set: "lea", collector: "161", finish: "foil", quantity: 1, listedQty: 1, locationId: "l1", typeLine: "Instant", price: 9 },
    { id: "c3", name: "Sol Ring", set: "c21", collector: "263", quantity: 1, listedQty: 1, locationId: "l1", typeLine: "Artifact", price: 2 },
    { id: "c4", name: "Island", set: "dmu", collector: "262", quantity: 9, listedQty: 0, locationId: "l1", typeLine: "Land", price: 0.1 }];
  const page = await open({ settings: { dashTiles: [{ id: "selling" }] }, state: { cards },
    soldMine: { sold: { "lea|161": [8, 0, true], "c21|263": [2, 0, true], "dmu|262": [40, 0, true] }, unmatched: [], sales } });
  page.G.emit("change");
  await settle(10);
  assert.equal(page.net.filter(r => r.url === "/api/prices/sold-mine").length, 1, "asked once");
  const t = page.$("tiles").innerHTML;
  assert.match(t, /<a class="tile-foot" href="\/inventory\.html\?fast=1&listed=1">[^]*2 of your listed cards are SELLING FAST<\/a>/,
    "Bolt's two stacks count once; Island is fast but not listed");
  assert.match(t, /<span class="lbl">Selling fast<\/span>/, "the tile's own figure is still there");

  const none = await open({ settings: { dashTiles: [{ id: "selling" }] }, state: { cards },
    soldMine: { sold: { "dmu|262": [40, 0, true] }, unmatched: [], sales } });
  assert.match(none.$("tiles").innerHTML, /<div class="tile-foot faint">none of your listed cards is SELLING FAST<\/div>/, "no link to an empty list");

  const early = await open({ settings: { dashTiles: [{ id: "selling" }] }, state: { cards },
    soldMine: { sold: { "lea|161": [8, 0, null] }, unmatched: [], sales: Object.assign({}, sales, { comparable: false }) } });
  assert.doesNotMatch(early.$("tiles").innerHTML, /tile-foot/, "too early to compare: no line");
});

test("#298: tiles from local data", async () => {
  const now = Date.now();
  const page = await open({ personalPrefs: null, settings: { dashTiles: [
    { id: "soldWeek" }, { id: "toShip" }, { id: "putaway" }, { id: "nearlyFull" }, { id: "noCost" }, { id: "avgValue" }] },
  state: {
    cards: [
      { id: "c1", name: "A", set: "lea", collector: "1", quantity: 3, costQty: 1, costTotal: 1, locationId: "l1", typeLine: "x", price: 2 },
      { id: "c2", name: "B", set: "lea", collector: "2", quantity: 1, locationId: "tray", typeLine: "x", price: 6 }],
    locations: [{ id: "l1", name: "Box", type: "box", maxCards: 3 }, { id: "tray", name: "Tray", type: "box", staging: true }],
    pickLists: [
      { id: "p1", orderId: "o1", status: "shipped", pickedAt: iso(now - DAY), revenue: 12.5, lines: [{ qty: 2 }] },
      { id: "p2", orderId: "o2", status: "picked", pickedAt: iso(now - 2 * DAY), revenue: 3, lines: [{ qty: 1 }] },
      { id: "p3", orderId: "o3", status: "shipped", pickedAt: iso(now - 20 * DAY), revenue: 99, lines: [{ qty: 9 }] },
      { id: "p4", status: "open", lines: [{ qty: 1 }] }]
  } });
  const t = page.$("tiles").innerHTML;
  assert.match(t, /<span class="big ">3<\/span><span class="lbl">Sold, last 7 days<\/span>[^]*?\$15\.50 from 2 orders/);
  assert.match(t, /<span class="big ">1<\/span><span class="lbl">Orders to ship/);
  assert.match(t, /<span class="big ">1<\/span><span class="lbl">Waiting for putaway/);
  assert.match(t, /<span class="big ">1<\/span><span class="lbl">Nearly full locations/);
  assert.match(t, /<span class="big ">3<\/span><span class="lbl">Missing cost basis/);
  assert.match(t, /<span class="big ">\$3\.00<\/span><span class="lbl">Average card value/);
});

test("#298: dashLayout skips unknown and not-allowed ids; null is the default", () => {
  const G = freshCore();
  eq(G.dashLayout(null, ["a", "b", "c"], ["a", "b", "x"]), [{ id: "a" }, { id: "b" }]);
  eq(G.dashLayout([{ id: "c", wide: true }, { id: "zz" }, { id: "c" }, { id: "a" }], ["a", "b", "c"], ["a"]),
    [{ id: "c", wide: true }, { id: "a" }]);
  eq(G.dashLayout([], ["a"], ["a"]), [], "an empty layout is a choice, not the default");
  assert.equal(G.dashLayoutClean("nope"), null);
});

test("#298: the counts behind the new tiles", () => {
  const G = freshCore();
  const now = new Date(2026, 9, 17, 12).getTime();
  const monthStart = G.monthStartMs(now);
  assert.equal(monthStart, new Date(2026, 9, 1).getTime());
  G.state.pickLists = [
    { id: "p1", orderId: "o1", status: "shipped", pickedAt: iso(now - DAY), revenue: 10, cogs: 4, fees: 1, lines: [{ qty: 2 }, { qty: 1 }] },
    { id: "p2", orderId: "o2", status: "picked", pickedAt: iso(now - 10 * DAY), revenue: 5, cogs: 1, fees: null, lines: [{ qty: 1 }] },
    { id: "p3", orderId: "o3", status: "open", pickedAt: null, revenue: 50, lines: [{ qty: 9 }] },
    { id: "p4", status: "shipped", pickedAt: iso(now - DAY), revenue: 0, cogs: 2, lines: [{ qty: 1 }] },   // a manual pick, no order
    { id: "p5", orderId: "o5", status: "shipped", pickedAt: iso(now - 40 * DAY), revenue: 7, cogs: 1, fees: 0, lines: [{ qty: 1 }] }
  ];
  eq(G.salesBetween(now - 7 * DAY, now), { orders: 1, copies: 3, revenue: 10 });
  eq(G.salesBetween(monthStart, now), { orders: 2, copies: 4, revenue: 15 });
  G.state.returns = [{ id: "r1", ts: iso(now - 2 * DAY), refundTotal: 3, disposition: "restock", lines: [{ qty: 1, unitCost: 0.5 }], totalQty: 1 }];
  // 15 revenue - 7 cogs (incl. the manual pick's 2) - 1 fee - 3 refund + 0.5 cost back
  assert.equal(G.profitBetween(monthStart, now).net, 4.5);
  eq(G.returnsSince(monthStart), { returns: 1, copies: 1 });

  G.state.receipts = [{ id: "a", ts: iso(now - DAY), totalCards: 5 }, { id: "b", ts: iso(now - 9 * DAY), totalCards: 7 }];
  assert.equal(G.receiptsSince(now - 7 * DAY).cards, 5);

  G.state.locations = [{ id: "l1", name: "Full", maxCards: 10 }, { id: "l2", name: "Half", maxCards: 10 }, { id: "l3", name: "No cap" }];
  G.state.cards = [
    { id: "c1", name: "A", quantity: 9, costQty: 9, locationId: "l1", price: 1 },
    { id: "c2", name: "B", quantity: 5, costQty: 2, locationId: "l2", price: 30 },
    { id: "c3", name: "C", quantity: 40, locationId: "l3", price: null },
    { id: "c4", name: "D", quantity: 1, locationId: "l3", price: 12 }
  ];
  eq(G.nearlyFullLocations(90).map(x => x.location.id), ["l1"]);
  assert.equal(G.copiesWithoutCost(), 3 + 40 + 1);
  eq(G.topCardsByPrice(2).map(r => r.id), ["c2", "c4"]);
  eq(G.topCardsByPrice(3).map(r => r.id), ["c2", "c4", "c1"]);

  G.state.customerWants = [
    { id: "w1", customerId: "k1", name: "B" }, { id: "w2", customerId: "k1", name: "D" },
    { id: "w3", customerId: "k2", name: "Z" }, { id: "w4", customerId: "k3", name: "A" }];
  eq(G.wantsInStock(), { wants: 3, customers: 2 });

  assert.equal(G.heldChange(null), null);
  assert.equal(G.heldChange({ fromDate: null, held: { netValue: 0, thenValue: 0, up: 0, down: 0 } }), null, "no snapshot from a week ago");
  assert.equal(G.heldChange({ fromDate: "2026-10-10", held: { netValue: 0, thenValue: 0, up: 0, down: 0 } }), null,
    "nothing priced at both ends");
  // movers' held summary already leaves out a card first priced mid-week,
  // however much it's worth now (nowValue): it can't blank or skew the figure.
  const m = G.heldChange({ fromDate: "2026-10-10", toDate: "2026-10-17",
    held: { nowValue: 5210, netValue: 10, thenValue: 200, up: 2, down: 1 } });
  assert.equal(m.delta, 10);
  assert.equal(m.pct, 5);
  assert.equal(G.heldChange({ fromDate: "2026-10-10", held: { netValue: -3, up: 0, down: 1 } }).pct, null,
    "a server from before thenValue: the change, no percentage");
});

test("#299: listedWithoutAsk counts listings with no price to send", () => {
  const G = freshCore();
  G.state.cards = [
    { id: "a", name: "A", quantity: 1, listedQty: 1, price: 4 },
    { id: "b", name: "B", quantity: 1, listedQty: 1, price: null },
    { id: "c", name: "C", quantity: 1, price: null }
  ];
  assert.equal(G.listedWithoutAsk(), 1);
  G.state.cards = [];
  assert.equal(G.listedWithoutAsk(), 0);
});
