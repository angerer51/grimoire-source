"use strict";
/* "Never list cards at a loss" on Bulk Price (#378): the browser's plan, and
   the scheduled run's delist path. Real store against a scratch dataDir (never
   the live one); Manapool is stubbed on the integrations module, so nothing is
   sent anywhere. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { freshCoreWithLocation, APP_DIR } = require("../test-lib/core-shim");
const engine = require(path.join(APP_DIR, "public", "js", "priceRuleEngine.js"));
const store = require(path.join(APP_DIR, "server", "lib", "store"));
const integrations = require(path.join(APP_DIR, "server", "lib", "integrations"));
const priceRules = require(path.join(APP_DIR, "server", "lib", "priceRules"));

const tmpDirs = [];
const real = { enabled: integrations.manapoolEnabled, inventory: integrations.manapoolInventory, list: integrations.manapoolList,
  listBulk: integrations.manapoolListBulk, fetch: globalThis.fetch };
after(() => {
  integrations.manapoolEnabled = real.enabled;
  integrations.manapoolInventory = real.inventory;
  integrations.manapoolList = real.list;
  integrations.manapoolListBulk = real.listBulk;
  globalThis.fetch = real.fetch;
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});
const logs = [];
priceRules.init({ log: m => logs.push(m) });
// Only reachable through a stub: nothing in this file can reach Manapool.
integrations.init({ manapool: { enabled: true, baseUrl: "https://mp.test/api/v1/",
  paths: { createListing: "seller/inventory/scryfall_id" } } }, { log: () => {} });
globalThis.fetch = async url => { throw new Error("unexpected request: " + url); };

const FIXED = (fixed, extra) => Object.assign({ id: "r1", name: "Fixed", on: true, priority: 0, mode: "fixed", fixed,
  criteria: { combinator: "ALL", conditions: [], groups: [] } }, extra);
const COST = (avgCost, costQty) => ({ avgCost, costQty: costQty == null ? 2 : costQty, costTotal: avgCost * (costQty == null ? 2 : costQty) });

/* ---------------- The shared rule ---------------- */

test("listingBelowCost: at or below the average cost; no cost or no price is never below (#378)", () => {
  const s = c => [Object.assign({ listedQty: 2, askPrice: 99 }, c)];
  assert.deepEqual(engine.listingBelowCost(s(COST(5)), 3), { cost: 5, price: 3, profit: -2, pct: -40 });
  assert.ok(engine.listingBelowCost(s(COST(5)), 5), "break-even is not profitable");
  assert.equal(engine.listingBelowCost(s(COST(5)), 5.01), null);
  assert.equal(engine.listingBelowCost(s({ costQty: 0 }), 3), null, "no cost entered");
  assert.equal(engine.listingBelowCost(s(COST(5)), null), null, "no price");
  assert.equal(engine.listingBelowCost(s(COST(5)), 0), null, "$0.00 counts as no price");
  assert.equal(engine.listingBelowCost([], 3), null);
  // Averaged over the listing's stacks, by copies: (1x$2 + 3x$6) / 4 = $5.
  assert.equal(engine.listingBelowCost([COST(2, 1), COST(6, 3)], 5).cost, 5);
  assert.equal(engine.listingBelowCost([COST(2, 1), COST(6, 3)], 5.5), null);
  assert.equal(engine.listingBelowCost([COST(5), { costQty: 0 }], 3), null, "any stack with no cost leaves the listing alone");
  // Once something is listed, only the listed stacks are judged, as #377's button does.
  const up = Object.assign({ listedQty: 2 }, COST(5));
  assert.ok(engine.listingBelowCost([up, { costQty: 0, listedQty: 0 }], 3), "an unlisted no-cost stack doesn't shield a listed one");
  assert.equal(engine.listingBelowCost([up, { costQty: 0, listedQty: 1 }], 3), null, "a listed no-cost stack does");
});

test("minProfitPct: a stored value wins; none stored is 0% with the switch on, 25% with it off (#390)", () => {
  assert.equal(engine.minProfitPct({}), 25);
  assert.equal(engine.minProfitPct(null), 25);
  assert.equal(engine.minProfitPct({ neverListAtLoss: false }), 25);
  assert.equal(engine.minProfitPct({ neverListAtLoss: true }), 0);
  assert.equal(engine.minProfitPct({ neverListAtLoss: true, minProfitPct: 30 }), 30);
  assert.equal(engine.minProfitPct({ neverListAtLoss: false, minProfitPct: 0 }), 0, "a stored 0 is a value, not none");
  assert.equal(engine.minProfitPct({ minProfitPct: 12.5 }), 12.5, "decimals");
  assert.equal(engine.minProfitPct({ minProfitPct: "15" }), 15);
  // Empty or unreadable falls back the same way a missing one does.
  for (const bad of ["", "  ", "abc", -5, NaN, Infinity, "12abc", {}]) {
    assert.equal(engine.minProfitPct({ neverListAtLoss: true, minProfitPct: bad }), 0, JSON.stringify(bad));
    assert.equal(engine.minProfitPct({ neverListAtLoss: false, minProfitPct: bad }), 25, JSON.stringify(bad));
  }
});

test("listingBelowCost with a minimum: under fails, exactly at passes, over passes; 0% is today's rule (#390)", () => {
  const s = c => [Object.assign({ listedQty: 2 }, c)];
  // Cost $1.00 at 25%: $1.25 or more.
  assert.deepEqual(engine.listingBelowCost(s(COST(1)), 1.24, 25), { cost: 1, price: 1.24, profit: 0.24, pct: 24 });
  assert.equal(engine.listingBelowCost(s(COST(1)), 1.25, 25), null, "exactly at the minimum passes");
  assert.equal(engine.listingBelowCost(s(COST(1)), 1.26, 25), null);
  assert.ok(engine.listingBelowCost(s(COST(1)), 1.1, 25), "profitable but under the minimum");
  // 0%, or no minimum given: at or below cost, break-even included.
  for (const min of [0, undefined]) {
    assert.ok(engine.listingBelowCost(s(COST(1)), 1, min), "break-even at " + min);
    assert.equal(engine.listingBelowCost(s(COST(1)), 1.01, min), null);
  }
  // A loss fails at any minimum.
  assert.ok(engine.listingBelowCost(s(COST(1)), 0.5, 0));
  // $0 cost with a price: unbounded %, passes any minimum. No cost entered or no price: never touched.
  assert.equal(engine.listingBelowCost(s({ costQty: 2, costTotal: 0, avgCost: 0 }), 0.05, 1000), null);
  assert.equal(engine.listingBelowCost(s({ costQty: 0 }), 0.05, 1000), null);
  assert.equal(engine.listingBelowCost(s(COST(1)), null, 1000), null);
});

/* ---------------- The browser's plan ---------------- */

const INFO = { name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 3, priceNote: "", note: "", meta: {} };
function planSetup(costFields, opts) {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations[0].sellFrom = true;
  const r = G.addCopies({ set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty: 2, info: INFO, action: "receipt", receiptId: "T1", note: "" });
  r.listedQty = 2;
  r.askPrice = (opts && opts.askPrice) != null ? opts.askPrice : 9;
  Object.assign(r, { costQty: 0, costTotal: 0, avgCost: null }, costFields);
  G.state.priceRules = [G.normalizePriceRule(Object.assign({ name: "All", on: true, mode: "fixed", fixed: 3,
    criteria: { combinator: "ALL", conditions: [], groups: [] } }))];
  G.state.settings.neverListAtLoss = !(opts && opts.off);
  return { G, r };
}

test("bulkPricePlan: below cost is planned as a delist, with its cost and the price it would have sent (#378)", () => {
  const { G } = planSetup(COST(5));
  const [line] = G.bulkPricePlan();
  assert.equal(line.delist, true);
  assert.equal(line.cost, 5);
  assert.equal(line.target, 3, "the price that would have been sent");
  assert.equal(line.delta, null, "not a raise or a lower");
});

test("bulkPricePlan: an ask exactly at cost is a delist; an ask above cost is a normal price change (#378)", () => {
  assert.equal(planSetup(COST(3)).G.bulkPricePlan()[0].delist, true);
  const [line] = planSetup(COST(2)).G.bulkPricePlan();
  assert.equal(line.delist, undefined);
  assert.equal(line.target, 3);
  assert.equal(line.delta, -6);
});

test("bulkPricePlan: a stack with no cost is never a delist (#378)", () => {
  const [line] = planSetup({}).G.bulkPricePlan();
  assert.equal(line.delist, undefined);
  assert.equal(line.target, 3);
});

test("bulkPricePlan: an unchanged ask below cost still shows, since it's live at a loss (#378)", () => {
  const { G } = planSetup(COST(5), { askPrice: 3 });
  assert.equal(G.bulkPricePlan().length, 1);
  assert.equal(G.bulkPricePlan()[0].delist, true);
});

test("bulkPricePlan: switch off is exactly today's plan (#378)", () => {
  const a = planSetup(COST(5), { off: true }).G.bulkPricePlan()[0];
  assert.equal(a.delist, undefined);
  assert.equal(a.cost, undefined);
  assert.equal(a.delta, -6);
  assert.equal(a.target, 3);
  const unchanged = planSetup(COST(5), { off: true, askPrice: 3 }).G;
  assert.equal(unchanged.bulkPricePlan().length, 0, "an unchanged ask stays out of the plan");
});

test("bulkPricePlan: a card taken down by applyDelistUnprofitable is out of the plan for good (#378)", () => {
  const { G, r } = planSetup(COST(5));
  const key = G.manapoolIdentityKey(r);
  assert.equal(G.applyDelistUnprofitable(new Set([key]), "Bulk Price push, below cost").changed, 1);
  assert.equal(r.listedQty, 0);
  assert.equal(G.bulkPricePlan({ includeUnchanged: true }).length, 0);
  r.costQty = 0;   // even if it's no longer below cost
  assert.equal(G.bulkPricePlan({ includeUnchanged: true }).length, 0, "Bulk Price never relists it");
});

test("wording: every place that can trigger a takedown says so (#378)", () => {
  const read = f => fs.readFileSync(path.join(APP_DIR, "public", f), "utf8");
  assert.match(read("listings.html"), /title="[^"]*takes those listings down[^"]*"[^>]*><input type="checkbox" id="prefNeverLoss"/);
  assert.match(read("listings.html"), /id="bpAutoPushLoss"[^>]*>.*takes down/);
  assert.match(read("bulk-price.page.js"), /\$\("bpAutoPushLoss"\)\.hidden = !G\.state\.settings\.neverListAtLoss/);
  assert.match(read("bulk-price.page.js"), /neverListAtLoss \? " and take down up to 50 listings/);
  // The limit is named in the warning texts and Help.
  const n = String(priceRules.MAX_SCHEDULED_DELISTS);
  assert.equal(n, "50");
  const html = read("listings.html");
  const warning = html.match(/id="bpAutoPushLoss"[^>]*>(.*?)<\/span>/)[1];
  const tooltip = html.match(/title="([^"]*takes those listings down[^"]*)"[^>]*><input type="checkbox" id="prefNeverLoss"/)[1];
  assert.match(warning, new RegExp("up to " + n + " a run"));
  assert.match(tooltip, new RegExp("up to " + n + " a run"));
  // Each time Listings shows the Pricing or Manapool tab it refreshes what depends on the switch.
  const lp = read("listings.page.js");
  assert.match(lp, /t === "pricing"\) \$\("bpAutoPushLoss"\)\.hidden = !G\.state\.settings\.neverListAtLoss/);
  assert.match(lp, /t === "manapool"\) refreshUnprofitableCount\(\)/);
  assert.match(read("help.html"), new RegExp("takes down at most " + n));
  assert.doesNotMatch(read("help.html"), /It never changes quantity/);
});

/* ---------------- The scheduled run ---------------- */

const card = (id, extra) => Object.assign({
  id, name: "Lightning Bolt", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM",
  scryfallId: "abc-123", locationId: "loc1", quantity: 2, listedQty: 2, price: 3, askPrice: 9
}, extra);

async function run({ cards, noLoss, autoPush, connected, live, inventoryFails, listFails, listShows, rule, realBulk, reply, liveRows, minProfitPct }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-noloss-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const state = {
    cards,
    locations: [{ id: "loc1", name: "Shelf", sellFrom: true, pickPriority: 0 }],
    pickLists: [],
    priceRules: [rule || FIXED(3)],
    settings: Object.assign({ neverListAtLoss: noLoss !== false, bulkPriceSchedule: { enabled: true, autoPush: autoPush !== false } },
      minProfitPct !== undefined ? { minProfitPct } : {})
  };
  await store.writeCollection("u1", state, null);
  await store.updatePrefs("u1", p => { p.manapool = connected === false ? {} : { email: "x@example.com", accessToken: "t" }; });
  const sent = [];
  let inventoryReads = 0;
  integrations.manapoolEnabled = () => true;
  integrations.manapoolInventory = async () => {
    inventoryReads++;
    if (inventoryFails) throw new Error("Manapool down");
    if (liveRows) return liveRows.map(c => ({ kind: "card", scryfallId: c.scryfallId, lang: "en", finish: "nonfoil", condition: "NM", quantity: 2 }));
    return [{ kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: live == null ? 2 : live }];
  };
  integrations.manapoolList = async (creds, c, opts) => { sent.push(opts); return { ok: true, quantity: opts.quantity }; };
  // Delists go through the bulk path. realBulk runs the real one, with only
  // the network stubbed: reply(items) answers what Manapool would.
  integrations.manapoolListBulk = realBulk ? real.listBulk : async (creds, entries) => {
    sent.push(...entries);
    if (listFails) throw new Error("Manapool said no");
    return entries.map(e => ({ ok: true, quantity: listShows !== undefined ? listShows : e.quantity }));
  };
  if (realBulk) {
    globalThis.fetch = async (url, opts) => {
      assert.ok(String(url).startsWith("https://mp.test/"), "never a real Manapool call");
      const items = JSON.parse(opts.body);
      sent.push(...items);
      const out = await reply(items);
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  }
  logs.length = 0;
  const out = await priceRules.runForUser("u1", "u1");
  const doc = await store.readCollection("u1");
  return { out, sent, doc, inventoryReads: () => inventoryReads };
}

test("runForUser: below cost with Auto-push on: delists on Manapool, unlists every stack, logs and audits (#378)", async () => {
  const cards = [card("a", COST(5)), card("b", Object.assign({ locationId: "loc1", listedQty: 0 }, COST(5)))];
  const { out, sent, doc } = await run({ cards });
  assert.equal(sent.length, 1, "one write per listing");
  assert.equal(sent[0].quantity, 0);
  assert.equal(sent[0].price, null, "the same write Delist all sends");
  assert.equal(out.delisted, 1);
  assert.equal(out.belowCost, 1);
  assert.equal(out.pushed, 0, "not counted as a price push");
  assert.equal(out.changed, 0, "not a new price");
  assert.deepEqual(doc.state.cards.map(c => c.listedQty), [0, 0]);
  assert.equal(doc.state.cards[0].askPrice, 9, "askPrice stays the last price Manapool really got");
  const lines = doc.state.audit.filter(a => /Scheduled run: delisted/.test(a.note));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].note, "Scheduled run: delisted Lightning Bolt, ask $3.00, cost $5.00, under the minimum profit of 0%");
  assert.equal(lines[0].action, "list");
  assert.ok(logs.some(m => m.includes("Scheduled run: delisted Lightning Bolt, ask $3.00, cost $5.00, under the minimum profit of 0%")), "logged too");
});

test("runForUser: above cost is a normal price push (#378)", async () => {
  const { out, sent, doc } = await run({ cards: [card("a", COST(2))] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].price, 3);
  assert.equal(sent[0].quantity, 2);
  assert.equal(out.delisted, 0);
  assert.equal(out.pushed, 1);
  assert.equal(doc.state.cards[0].listedQty, 2);
  assert.equal(doc.state.cards[0].askPrice, 3);
});

test("runForUser: a stack with no cost is never delisted, even beside one with a cost (#378)", async () => {
  let r = await run({ cards: [card("a")] });
  assert.equal(r.sent[0].price, 3);
  assert.equal(r.out.belowCost, 0);
  assert.equal(r.doc.state.cards[0].listedQty, 2);
  r = await run({ cards: [card("a", COST(5)), card("b", { costQty: 0, listedQty: 1 })] });
  assert.equal(r.sent[0].price, 3, "a listing with a listed no-cost stack is priced, not taken down");
  assert.equal(r.out.delisted, 0);
  assert.equal(r.doc.state.cards[0].listedQty, 2);
});

test("runForUser: switch off behaves exactly as before, result shape included (#378)", async () => {
  const { out, sent, doc } = await run({ cards: [card("a", COST(5))], noLoss: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].price, 3);
  assert.equal(sent[0].quantity, 2);
  assert.deepEqual(out, { ok: true, considered: 1, changed: 1, pushed: 1, pushFailed: 0, pushSkipped: 0, fallback: 0, noPrice: 0 });
  assert.equal(doc.state.cards[0].listedQty, 2);
  assert.equal(doc.state.audit.filter(a => /delisted/.test(a.note)).length, 0);
});

test("runForUser: Auto-push off only records them: no Manapool call, nothing unlisted, nothing saved (#378)", async () => {
  const { out, sent, doc, inventoryReads } = await run({ cards: [card("a", COST(5))], autoPush: false });
  assert.equal(sent.length, 0);
  assert.equal(inventoryReads(), 0);
  assert.equal(out.belowCost, 1);
  assert.equal(out.delisted, 0);
  assert.equal(doc.state.cards[0].listedQty, 2);
  assert.equal((doc.state.audit || []).length, 0);
});

test("runForUser: no Manapool connection means no delist (#378)", async () => {
  const { out, sent, doc } = await run({ cards: [card("a", COST(5))], connected: false });
  assert.equal(sent.length, 0);
  assert.equal(out.delisted, 0);
  assert.equal(doc.state.cards[0].listedQty, 2);
});

test("runForUser: a failed delist changes nothing locally and is counted (#378)", async () => {
  for (const opts of [{ listFails: true }, { listShows: 2 }, { listShows: null }]) {
    const { out, doc } = await run(Object.assign({ cards: [card("a", COST(5))] }, opts));
    assert.equal(out.delisted, 0);
    assert.equal(out.delistFailed, 1);
    assert.equal(doc.state.cards[0].listedQty, 2, "still listed: only a confirmed 0 counts as down");
    assert.equal((doc.state.audit || []).length, 0);
  }
});

test("runForUser: unreadable live listings delist nothing; a listing already gone isn't written (#378)", async () => {
  let r = await run({ cards: [card("a", COST(5))], inventoryFails: true });
  assert.equal(r.sent.length, 0);
  assert.equal(r.out.delisted, 0);
  assert.equal(r.doc.state.cards[0].listedQty, 2);
  r = await run({ cards: [card("a", COST(5))], live: 0 });
  assert.equal(r.sent.length, 0);
  assert.equal(r.out.pushSkipped, 1);
});

test("runForUser: a delisted card isn't relisted by a later run, even once it's above cost again (#378)", async () => {
  const { sent } = await run({ cards: [card("a", COST(5))] });
  assert.equal(sent.length, 1);
  const doc = await store.readCollection("u1");
  doc.state.priceRules = [FIXED(50)];
  await store.writeCollection("u1", doc.state, doc.rev);
  const out = await priceRules.runForUser("u1", "u1");
  assert.equal(sent.length, 1, "no further write to Manapool");
  assert.equal(out.skipped || out.considered, 0);
});

/* The real manapoolListBulk, with only the network stubbed: what Manapool's
   reply means for what Grimoire believes is down. */
const printing = (id, n) => card(id, Object.assign({ collector: String(n), scryfallId: "sid-" + n, name: "Card " + n }, COST(5)));
const row = (item, quantity) => ({ id: "L" + item.scryfall_id, quantity, price_cents: 300,
  product: { single: { scryfall_id: item.scryfall_id, language_id: item.language_id, finish_id: item.finish_id, condition_id: item.condition_id } } });
const runReal = (cards, reply) => run({ cards, realBulk: true, reply, live: 2 });

test("runForUser delist, real bulk path: a confirmed 0 is down, sent as Delist all sends it (#378)", async () => {
  const { out, sent, doc } = await runReal([card("a", COST(5))], items => ({ inventory: items.map(i => row(i, 0)), skipped: [] }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quantity, 0);
  assert.equal(sent[0].price_cents, null, "no price, as Delist all");
  assert.equal(out.delisted, 1);
  assert.equal(doc.state.cards[0].listedQty, 0);
});

test("runForUser delist, real bulk path: a reply that doesn't confirm it leaves it listed, unaudited, and retried (#378)", async () => {
  for (const reply of [() => ({ inventory: [], skipped: [] }), () => ({})]) {
    const { out, sent, doc } = await runReal([card("a", COST(5))], reply);
    assert.equal(out.delisted, 0);
    assert.equal(out.delistFailed, 1);
    assert.equal(doc.state.cards[0].listedQty, 2, "the card may still be on sale");
    assert.equal((doc.state.audit || []).filter(a => /delisted/.test(a.note)).length, 0);
    assert.equal(sent.length, 1);
    // The next run sends it again.
    const again = await priceRules.runForUser("u1", "u1");
    assert.equal(sent.length, 2, "retried on the next run");
    assert.equal(again.delistFailed, 1);
  }
});

test("runForUser delist, real bulk path: a reply still showing copies isn't down (#378)", async () => {
  const { out, doc } = await runReal([card("a", COST(5))], items => ({ inventory: items.map(i => row(i, 2)), skipped: [] }));
  assert.equal(out.delisted, 0);
  assert.equal(out.delistFailed, 1);
  assert.equal(doc.state.cards[0].listedQty, 2);
});

test("runForUser delist, real bulk path: a thrown request leaves everything listed (#378)", async () => {
  const { out, doc } = await runReal([card("a", COST(5))], () => { throw new Error("connection dropped"); });
  assert.equal(out.delisted, 0);
  assert.equal(out.delistFailed, 1);
  assert.equal(doc.state.cards[0].listedQty, 2);
  assert.equal((doc.state.audit || []).length, 0);
});

test("runForUser delist, real bulk path: a partial batch counts only what Manapool confirmed, by identity (#378)", async () => {
  const cards = [printing("a", 1), printing("b", 2), printing("c", 3)];
  // Manapool confirms the second, skips the first and doesn't mention the third.
  const reply = items => ({ inventory: [row(items[1], 0)], skipped: [Object.assign({ reason: "nope" }, items[0])] });
  const { out, doc } = await run({ cards, realBulk: true, reply, liveRows: cards });
  assert.equal(out.delisted, 1);
  assert.equal(out.delistFailed, 2);
  assert.deepEqual(doc.state.cards.map(c => c.listedQty), [2, 0, 2], "only the confirmed one is down");
  const notes = doc.state.audit.filter(a => /delisted/.test(a.note)).map(a => a.note);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /delisted Card 2,/);
});

/* The limit: 50 takedowns per scheduled run (owner, #378). */
const sixty = () => Array.from({ length: 60 }, (_, i) => printing("s" + i, i + 1));

test("runForUser: 60 below cost: 50 down, 10 left up and untouched, and the next run takes the rest (#378)", async () => {
  const cards = sixty().reverse();   // the order taken doesn't depend on the stacks' order
  const keys = cards.map(c => engine.manapoolIdentityKey(c)).sort();
  const { out, sent, doc } = await run({ cards, liveRows: cards });
  assert.equal(sent.length, 50);
  assert.ok(sent.every(s => s.quantity === 0 && s.price === null), "nothing over the limit is sent a below-cost price");
  assert.equal(out.belowCost, 60);
  assert.equal(out.delisted, 50);
  assert.equal(out.delistLeft, 10);
  assert.equal(out.pushed, 0);
  const left = doc.state.cards.filter(c => c.listedQty > 0);
  assert.equal(left.length, 10);
  assert.ok(left.every(c => c.listedQty === 2 && c.askPrice === 9), "untouched");
  assert.deepEqual(left.map(c => engine.manapoolIdentityKey(c)).sort(), keys.slice(50), "a stable order");
  const summary = "Scheduled run: took down 50 listing(s) under the minimum profit, left 10 for the next run (limit 50 a run)";
  assert.equal(doc.state.audit.filter(a => a.note === summary).length, 1, "audited");
  assert.equal(doc.state.audit.filter(a => /Scheduled run: delisted/.test(a.note)).length, 50);
  assert.ok(logs.some(m => m.includes(summary)), "logged");

  const next = await priceRules.runForUser("u1", "u1");
  assert.equal(next.delisted, 10);
  assert.equal(next.delistLeft, 0);
  assert.equal(sent.length, 60);
  const after = await store.readCollection("u1");
  assert.ok(after.state.cards.every(c => c.listedQty === 0));
  assert.equal(after.state.audit.filter(a => /took down 10 listing\(s\) under the minimum profit, left 0/.test(a.note)).length, 1);
});

test("runForUser: a failing batch uses up the limit, once: nothing goes down and nothing more is sent (#378)", async () => {
  const cards = sixty();
  const { out, sent, doc } = await run({ cards, liveRows: cards, listFails: true });
  assert.equal(sent.length, 50, "sent once, never looped");
  assert.equal(out.delisted, 0);
  assert.equal(out.delistFailed, 50);
  assert.equal(out.delistLeft, 10);
  assert.ok(doc.state.cards.every(c => c.listedQty === 2));
  assert.equal(doc.state.audit.filter(a => /Scheduled run: delisted/.test(a.note)).length, 0);
  assert.equal(doc.state.audit.filter(a => /took down 0 listing\(s\) under the minimum profit, left 10/.test(a.note)).length, 1);
});

test("runForUser: the limit is only on scheduled takedowns: price pushes aren't counted (#378)", async () => {
  const cheap = Array.from({ length: 3 }, (_, i) => card("p" + i, Object.assign({ collector: String(100 + i), scryfallId: "cheap-" + i }, COST(1))));
  const cards = sixty().concat(cheap);
  const { out } = await run({ cards, liveRows: cards });
  assert.equal(out.pushed, 3);
  assert.equal(out.delisted, 50);
});

test("runForUser: the server and the browser's plan agree on the same stacks (#378)", async () => {
  for (const [fields, expected] of [[COST(5), true], [COST(3), true], [COST(2), false], [{}, false]]) {
    const browser = planSetup(fields).G.bulkPricePlan()[0];
    const { out } = await run({ cards: [card("a", fields)] });
    assert.equal(!!browser.delist, expected, "browser");
    assert.equal(out.delisted === 1, expected, "server");
  }
});

test("minimum profit: Bulk Price and the scheduled run take down a profitable card under the minimum, by the same effective minimum (#390)", async () => {
  // The rule asks $3.00; cost $2.50 is 20% profit.
  for (const [minPct, expected] of [[undefined, false], [25, true], [20, false], [0, false], [10, false], [30, true]]) {
    const { G } = planSetup(COST(2.5));
    if (minPct !== undefined) G.state.settings.minProfitPct = minPct;
    const browser = G.bulkPricePlan()[0];
    const { out, sent } = await run({ cards: [card("a", COST(2.5))], minProfitPct: minPct });
    assert.equal(!!browser.delist, expected, "browser, minimum " + minPct);
    assert.equal(out.delisted === 1, expected, "server, minimum " + minPct);
    assert.equal(sent[0].price, expected ? null : 3, "server sends a takedown or the new price");
    if (expected) assert.equal(browser.pct, 20, "the plan carries the profit % for the pill");
  }
});

test("minimum profit: switch on, none stored is 0% in the browser and the server alike (#390)", async () => {
  const { G } = planSetup(COST(2.9));
  assert.ok(!("minProfitPct" in G.state.settings));
  assert.equal(G.minProfitPct(), 0);
  assert.equal(engine.minProfitPct({ neverListAtLoss: true }), G.minProfitPct());
  assert.ok(!G.bulkPricePlan()[0].delist, "3% profit stays up at 0%");
  const { out, doc } = await run({ cards: [card("a", COST(2.9))] });
  assert.equal(out.delisted, 0);
  assert.equal(out.pushed, 1);
  assert.equal(doc.state.cards[0].listedQty, 2);
});

test("minimum profit: the scheduled run's audit names the minimum (#390)", async () => {
  const { doc } = await run({ cards: [card("a", COST(2.5))], minProfitPct: 25 });
  const lines = doc.state.audit.filter(a => /Scheduled run: delisted/.test(a.note));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].note, "Scheduled run: delisted Lightning Bolt, ask $3.00, cost $2.50, under the minimum profit of 25%");
});

test("minimum profit wiring: the setting sits beside the renamed switch, shows the minimum in effect and never saves a surprise 0 (#390)", () => {
  const read = f => fs.readFileSync(path.join(APP_DIR, "public", f), "utf8");
  const html = read("listings.html");
  assert.match(html, /Minimum profit \(% of cost\)\s*<input id="prefMinProfit" type="number" min="0"/);
  assert.match(html, /id="prefNeverLoss"> Never list below my minimum profit</);
  assert.match(html, /\$1\.00 card must list at \$1\.25 or more/);
  const lp = read("listings.page.js");
  assert.match(lp, /\$\("prefMinProfit"\)\.value = G\.minProfitPct\(\)/);
  assert.match(lp, /readMinProfitPct\(\$\("prefMinProfit"\)\.value\);\s*s\.minProfitPct = typed != null \? typed : G\.minProfitPct\(\);\s*s\.neverListAtLoss =/,
    "an empty box keeps the minimum in effect before the switch changes");
  const help = read("help.html");
  assert.match(help, /At 25%, a \$1\.00 card must list at \$1\.25 or more/);
  assert.match(help, /before Manapool's fees/);
});

test("Bulk Price page wiring: push sends delists as a 0-quantity write and marks them through #377's helper (#378)", () => {
  // Page code can't run in the shim, so pin the wiring.
  const page = fs.readFileSync(path.join(APP_DIR, "public/bulk-price.page.js"), "utf8");
  assert.match(page, /price: null, qty: 0, delist: true/);
  assert.match(page, /G\.applyDelistUnprofitable\(downKeys,/);
  assert.match(page, /Delist \(below minimum profit\)/);
  assert.match(page, /p\.delist \? ":delist" : ""/, "a plan flipping to delist must stop the push");
  assert.match(page, /r\.quantity !== 0/, "only a reply showing exactly 0 counts as down");
});
