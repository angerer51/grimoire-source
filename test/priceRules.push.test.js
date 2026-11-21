"use strict";
/* server/lib/priceRules.js - the scheduled bulk price run's auto-push
   quantity cap (#86). Real store against a scratch dataDir (never the live
   one); Manapool is stubbed on the integrations module, so nothing is sent
   anywhere. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "server", "lib", "store"));
const integrations = require(path.join(__dirname, "..", "server", "lib", "integrations"));
const priceRules = require(path.join(__dirname, "..", "server", "lib", "priceRules"));

const tmpDirs = [];
const real = { enabled: integrations.manapoolEnabled, inventory: integrations.manapoolInventory, list: integrations.manapoolList,
  prices: integrations.manapoolPrices };
after(() => {
  integrations.manapoolPrices = real.prices;
  integrations.manapoolEnabled = real.enabled;
  integrations.manapoolInventory = real.inventory;
  integrations.manapoolList = real.list;
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});
priceRules.init({ log: () => {} });

const KEY = "abc-123|en|nonfoil|NM";
const card = (id, qty, listedQty, locationId) => ({
  id, name: "Lightning Bolt", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM",
  scryfallId: "abc-123", locationId: locationId || "loc1", quantity: qty, listedQty, price: 0.5
});
const LINE = { kind: "card", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM", name: "Lightning Bolt" };

async function fresh({ cards, pickLists, live, inventoryFails, locations, priceRules: rules }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-pricerules-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const state = {
    cards,
    locations: locations || [{ id: "loc1", name: "Shelf", sellFrom: true, pickPriority: 0 }],
    pickLists: pickLists || [],
    priceRules: rules || [{ id: "r1", name: "Fixed", on: true, mode: "fixed", fixed: 0.75, criteria: { op: "all", items: [] } }],
    settings: { bulkPriceSchedule: { enabled: true, autoPush: true } }
  };
  await store.writeCollection("u1", state, null);
  await store.updatePrefs("u1", p => { p.manapool = { email: "x@example.com", accessToken: "t" }; });
  const sent = [];
  integrations.manapoolEnabled = () => true;
  integrations.manapoolInventory = async () => {
    if (inventoryFails) throw new Error("Manapool down");
    return live.map(q => ({ kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: q }));
  };
  integrations.manapoolList = async (creds, c, opts) => { sent.push(opts); return { ok: true, quantity: opts.quantity }; };
  return { sent };
}

test("runForUser: a scheduled price push never sends more than Manapool lists right now (#86)", async () => {
  // Local still says 2 listed, but one sold on Manapool since the last fetch.
  const { sent } = await fresh({ cards: [card("c1", 4, 2)], live: [1] });
  const out = await priceRules.runForUser("u1", "u1");
  assert.equal(out.pushed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quantity, 1, "the stale local 2 would have re-listed the sold copy");
  assert.equal(sent[0].price, 0.75);
});

test("runForUser: never more than on hand minus copies sold to an open Manapool order (#86)", async () => {
  const { sent } = await fresh({
    cards: [card("c1", 2, 2)], live: [2],
    pickLists: [{ id: "PL1", status: "open", source: "manapool", lines: [Object.assign({ qty: 1 }, LINE)] }]
  });
  await priceRules.runForUser("u1", "u1");
  assert.equal(sent[0].quantity, 1);
});

test("runForUser: a listing gone from Manapool isn't pushed, and an unreadable live listing pushes nothing (#86)", async () => {
  let { sent } = await fresh({ cards: [card("c1", 2, 2)], live: [] });
  let out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 0, "a price push never creates a listing");
  assert.equal(out.pushSkipped, 1);

  ({ sent } = await fresh({ cards: [card("c1", 2, 2)], live: [2], inventoryFails: true }));
  out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 0, "no guessing when the live number can't be read");
  assert.equal(out.pushSkipped, 1);
});

test("manapoolReservations: mirrors the client - sell-from only, highest pick priority first, lines don't double-claim", () => {
  const state = {
    locations: [
      { id: "hi", sellFrom: true, pickPriority: 10 },
      { id: "lo", sellFrom: true, pickPriority: 1 },
      { id: "binder", sellFrom: false, pickPriority: 99 }
    ],
    cards: [card("a", 1, 0, "hi"), card("b", 3, 0, "lo"), card("c", 5, 0, "binder")],
    pickLists: [
      { status: "open", source: "manapool", lines: [Object.assign({ qty: 2 }, LINE)] },
      { status: "open", source: "manapool", lines: [Object.assign({ qty: 1 }, LINE, { collector: "0141" })] },
      { status: "open", source: "manual", lines: [Object.assign({ qty: 3 }, LINE)] },
      { status: "picked", source: "manapool", lines: [Object.assign({ qty: 3 }, LINE)] }
    ]
  };
  const res = priceRules.manapoolReservations(state);
  assert.equal(res.get("a"), 1);
  assert.equal(res.get("b"), 2);
  assert.equal(res.has("c"), false, "a personal binder is never sold from");
  const free = priceRules.freeToListByIdentity(state, new Set([KEY]));
  assert.equal(free.get(KEY), 6, "9 on hand - 3 reserved");
});

test("manapoolReservations: an open walk-in ticket holds its copies too (#432: entering it lowered Manapool)", () => {
  const state = {
    locations: [{ id: "hi", sellFrom: true, pickPriority: 10 }],
    cards: [card("a", 4, 0, "hi")],
    pickLists: [{ status: "open", source: "walkin", lines: [Object.assign({ qty: 3 }, LINE)] }]
  };
  assert.equal(priceRules.manapoolReservations(state).get("a"), 3);
});

/* ---------------- #87: a printing split across a matched and an unmatched stack ---------------- */

const TWO_BINS = [
  { id: "loc1", name: "Shelf", sellFrom: true, pickPriority: 0 },
  { id: "loc2", name: "Showcase", sellFrom: true, pickPriority: 0 }
];
// Only the Shelf bin is in the sweep: one rule scoped by location...
const SHELF_ONLY = [{ id: "r1", name: "Shelf only", on: true, mode: "fixed", fixed: 0.75,
  criteria: { combinator: "ALL", conditions: [{ on: true, field: "location", op: "is", value: "Shelf" }], groups: [] } }];
// ...or a catch-all with a higher-priority exclude on the other bin.
const EXCLUDE_SHOWCASE = [
  { id: "r1", name: "Everything", on: true, priority: 0, mode: "fixed", fixed: 0.75, criteria: { combinator: "ALL", conditions: [], groups: [] } },
  { id: "r2", name: "Not the showcase", on: true, priority: 10, mode: "exclude",
    criteria: { combinator: "ALL", conditions: [{ on: true, field: "location", op: "is", value: "Showcase" }], groups: [] } }
];

for (const [label, rules] of [["a location-scoped rule", SHELF_ONLY], ["an exclude rule on the other bin", EXCLUDE_SHOWCASE]]) {
  test("runForUser: " + label + " still pushes the whole listing's quantity, not the matched bin's share (#87)", async () => {
    // Bin A (matched): 2 listed. Bin B (not matched): 3 listed. Manapool lists 5.
    const { sent } = await fresh({
      cards: [card("a", 2, 2, "loc1"), card("b", 3, 3, "loc2")], live: [5],
      locations: TWO_BINS, priceRules: rules
    });
    const out = await priceRules.runForUser("u1", "u1");
    assert.equal(out.pushed, 1, "one listing, pushed once");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].quantity, 5, "sending only bin A's 2 would take 3 copies off sale");
    assert.equal(sent[0].price, 0.75);
    const doc = await store.readCollection("u1");
    // #228: one listing, one price - the price sent is recorded on every
    // stack of it, the unmatched bin's too.
    assert.deepEqual(doc.state.cards.map(c => c.askPrice), [0.75, 0.75]);
  });
}

test("runForUser: the unmatched stack has no base price yet - the push still keeps the full quantity (#87)", async () => {
  const pct = [{ id: "r1", name: "Market", on: true, mode: "percent", percent: 1, basis: "price",
    criteria: { combinator: "ALL", conditions: [], groups: [] } }];
  const b = card("b", 3, 3, "loc2");
  b.price = null; b.set = "zzz";   // not in the card index, so no price is filled in
  const a = card("a", 2, 2, "loc1");
  a.set = "zzz";
  const { sent } = await fresh({ cards: [a, b], live: [5], locations: TWO_BINS, priceRules: pct });
  await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quantity, 5);
});

test("runForUser: the full total is still capped by live and by sold-not-picked copies (#87 keeps #86)", async () => {
  // 5 on hand across both bins, Manapool lists 4, one copy sold to an open order.
  const { sent } = await fresh({
    cards: [card("a", 2, 2, "loc1"), card("b", 3, 3, "loc2")], live: [4],
    locations: TWO_BINS, priceRules: SHELF_ONLY,
    pickLists: [{ id: "PL1", status: "open", source: "manapool", lines: [Object.assign({ qty: 2 }, LINE)] }]
  });
  await priceRules.runForUser("u1", "u1");
  assert.equal(sent[0].quantity, 3, "min(live 4, 5 on hand - 2 sold)");
});

/* ---------------- #98: a $0.00 target ---------------- */

test("runForUser: a rule that works out to $0.00 is never sent - market x condition % goes instead (#98, #228)", async () => {
  const minus = [{ id: "r1", name: "Minus a quarter", on: true, mode: "delta", delta: -0.25, basis: "price",
    criteria: { combinator: "ALL", conditions: [], groups: [] } }];
  const c = card("c1", 2, 2);
  c.price = 0.2; c.set = "zzz"; c.askPrice = 0.4;
  const { sent } = await fresh({ cards: [c], live: [2], priceRules: minus });
  const out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].price, 0.2, "not $0.00 (Manapool can't take it): market 0.20 x NM's 100%");
  assert.equal(out.changed, 1);
  assert.equal(out.fallback, 1);
  const doc = await store.readCollection("u1");
  assert.equal(doc.state.cards[0].askPrice, 0.2);
});

test("runForUser: no rule price and no market price either - nothing is sent (#228)", async () => {
  const mp = [{ id: "r1", name: "Manapool low", on: true, mode: "percent", percent: 1, basis: "mpLow",
    criteria: { combinator: "ALL", conditions: [], groups: [] } }];
  const c = card("c1", 2, 2);
  c.price = null; c.set = "zzz"; c.askPrice = 0.4;
  integrations.manapoolPrices = async () => new Map();
  const { sent } = await fresh({ cards: [c], live: [2], priceRules: mp });
  const out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 0);
  assert.equal(out.noPrice, 1);
  const doc = await store.readCollection("u1");
  assert.equal(doc.state.cards[0].askPrice, 0.4, "the last-sent price stays");
});

/* ---------------- #228: the live ask ---------------- */

const PCT = (percent, extra) => Object.assign({ id: "r1", name: "Market %", on: true, priority: 0, mode: "percent", percent, basis: "market",
  criteria: { combinator: "ALL", conditions: [], groups: [] } }, extra);

test("runForUser: pushes the live ask from today's market price, never a stored ask, once per listing (#228)", async () => {
  // Two stacks of one listing whose stored asks clash (the 23 clashes).
  const a = card("a", 2, 2, "loc1"), b = card("b", 1, 1, "loc2");
  a.set = b.set = "zzz";            // not in the card index: market stays 0.5
  a.askPrice = 1; b.askPrice = 2;
  const { sent } = await fresh({ cards: [a, b], live: [3], locations: TWO_BINS, priceRules: [PCT(2)] });
  const out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 1, "one push for the listing");
  assert.equal(sent[0].price, 1, "market 0.5 x 200%");
  assert.equal(out.considered, 1);
  assert.equal(out.changed, 1, "Manapool last got a different price (bin B's $2)");
  const doc = await store.readCollection("u1");
  assert.deepEqual(doc.state.cards.map(c => c.askPrice), [1, 1]);
  assert.equal(doc.state.audit.length, 1, "one audit line for the listing");
});

test("runForUser: Auto-push off sends and saves nothing, just counts (#228)", async () => {
  const c = card("c1", 2, 2);
  c.set = "zzz"; c.askPrice = 9;
  const { sent } = await fresh({ cards: [c], live: [2], priceRules: [PCT(1)] });
  const doc0 = await store.readCollection("u1");
  doc0.state.settings.bulkPriceSchedule.autoPush = false;
  await store.writeCollection("u1", doc0.state, doc0.rev);
  const out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 0);
  assert.equal(out.changed, 1);
  assert.equal(out.pushed, 0);
  const doc = await store.readCollection("u1");
  assert.equal(doc.state.cards[0].askPrice, 9, "nothing was sent, so nothing is recorded");
});

test("runForUser: a scheduled rule only pushes the listings it prices, at the screens' price (#228)", async () => {
  // A higher-priority fixed rule owns this listing; the schedule runs the
  // catch-all. Before #228 the catch-all repriced it anyway.
  const fixed = { id: "r2", name: "Fixed", on: true, priority: 5, mode: "fixed", fixed: 3,
    criteria: { combinator: "ALL", conditions: [], groups: [] } };
  const c = card("c1", 2, 2);
  c.set = "zzz";
  const { sent } = await fresh({ cards: [c], live: [2], priceRules: [PCT(1), fixed] });
  const doc0 = await store.readCollection("u1");
  doc0.state.settings.bulkPriceSchedule.ruleId = "r1";
  await store.writeCollection("u1", doc0.state, doc0.rev);
  let out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 0, "the catch-all doesn't price this listing");
  assert.equal(out.considered, 0);

  const doc1 = await store.readCollection("u1");
  doc1.state.settings.bulkPriceSchedule.ruleId = "r2";
  await store.writeCollection("u1", doc1.state, doc1.rev);
  out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].price, 3);
});

test("runForUser: the server's ask matches the shared engine the screens use (#228)", async () => {
  const engine = require(path.join(__dirname, "..", "public", "js", "priceRuleEngine.js"));
  const a = card("a", 2, 2, "loc1");
  a.set = "zzz"; a.condition = "LP";
  const rules = [PCT(1.1)];
  const { sent } = await fresh({ cards: [a], live: [], priceRules: rules });
  const info = engine.listingAsk([a], rules, { locName: () => "Shelf", sellFrom: () => true });
  assert.equal(info.ask, 0.55);
  assert.equal(info.target, 0.55);
  await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 0, "nothing live on Manapool: a price push never creates a listing");
});
