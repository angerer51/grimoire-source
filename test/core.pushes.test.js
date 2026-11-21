"use strict";
/* Manapool pushes from Listings and Bulk Price (#88, #96, #98).

   #88/#228: a Listings push (and a single stack's push) sends the listing's
   live ask - its Bulk Price rule's price, else market x condition % - never
   a stored askPrice.
   #96: Delist all works from the live Manapool listings - cards and sealed,
   including listings Grimoire doesn't know about - and local listed counts
   follow what actually came down.
   #98: a pushed price is recorded as the ask, a $0.00 target is left alone,
   and the ask-price backfill doesn't refetch for rows it couldn't fill. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshCoreWithLocation, APP_DIR } = require("../test-lib/core-shim");

const INFO = {
  name: "Lightning Bolt", collector: "141", setName: "Masters 25", rarity: "uncommon",
  tcgplayerId: "123", scryfallId: "abc-123", price: 0.5, priceNote: "", note: "", meta: {}
};
const KEY = "abc-123|en|nonfoil|NM";

function setup() {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  G.state.locations[0].sellFrom = true;
  return G;
}
function receive(G, qty, opts) {
  const o = opts || {};
  const info = Object.assign({}, INFO, o.info || {});
  return G.addCopies({ set: o.set || "a25", num: info.collector, lang: "en", finish: "nonfoil", condition: o.condition || "NM",
    locationId: "loc1", qty, info, action: "receipt", receiptId: "T1", note: "" });
}
function sealedRecord(G, opts) {
  return G.addSealedCopies({
    tcgplayerProductId: opts.tcgplayerProductId || "tcg-1", manapoolProductId: opts.manapoolProductId || "mp-1",
    name: opts.name || "Foundations Bundle", setCode: "fdn", locationId: "loc1", qty: opts.qty || 1, price: opts.price
  });
}
const catchAll = (G, rule) => G.normalizePriceRule(Object.assign({ name: "All", on: true,
  criteria: { combinator: "ALL", conditions: [], groups: [] } }, rule));

/* ---------------- #88: which price a Listings push sends ---------------- */

test("manapoolListPrice: a rule's price, else market x condition %; a stored ask is never read (#88, #228)", () => {
  const G = setup();
  const r = receive(G, 2, { condition: "LP" });
  r.price = 10;
  assert.equal(G.manapoolListPrice(r), 8.5, "no rule: market x LP's 85%");
  r.askPrice = 12.34;
  assert.equal(G.manapoolListPrice(r), 8.5, "an old stored ask is only what was last sent - ignored");
  G.state.priceRules = [catchAll(G, { mode: "percent", percent: 1.2 })];
  assert.equal(G.manapoolListPrice(r), 12, "the rule prices it from the market price");
  r.price = 20;
  assert.equal(G.manapoolListPrice(r), 24, "and follows the next market refresh with no button");
});

test("manapoolListPrice: no price at all, or a rule with nothing to work from (#88, #228)", () => {
  const G = setup();
  const r = receive(G, 1);
  r.price = null;
  r.askPrice = 3;
  assert.equal(G.manapoolListPrice(r), null, "nothing to send - a stored ask is not a price");
  r.price = 4;
  r.listedQty = 1;
  G.state.priceRules = [catchAll(G, { mode: "percent", basis: "mpLow", percent: 1 })];
  const info = G.manapoolListingAsks().get(KEY);
  assert.equal(info.noBasis, true);
  assert.equal(info.fallback, true);
  assert.equal(G.manapoolListPrice(r), 4, "no Manapool basis yet: market x condition % (owner, #228)");
});

test("manapoolListPrice: an excluded listing goes out at market x condition % (owner, #228)", () => {
  const G = setup();
  const r = receive(G, 1, { condition: "HP" });
  r.price = 4; r.listedQty = 1; r.askPrice = 9;
  G.state.priceRules = [catchAll(G, { mode: "exclude" })];
  assert.equal(G.manapoolListPrice(r), 2, "4 x HP's 50%, not the old $9");
  assert.equal(G.manapoolListingAsks().get(G.manapoolIdentityKey(r)).excluded, true);
  const [line] = G.bulkPricePlan({ includeUnchanged: true });
  assert.equal(line.excluded, true);
  assert.equal(line.target, 2, "Bulk Price shows and pushes the same number");
  assert.equal(line.fallback, true);
});

test("Listings push and the single-stack push both send manapoolListPrice (#88)", () => {
  // Page code can't run in the shim, so pin the wiring: the Evaluate column,
  // the push entries and the single-stack push in ui.js all read the one helper.
  const listings = fs.readFileSync(path.join(APP_DIR, "public/listings.page.js"), "utf8");
  assert.match(listings, /const listPriceFor = \(record, asks\) => G\.manapoolListPrice\(record, asks\);/);
  assert.match(listings, /price: listPriceFor\(g\.sample, asks\)/);
  assert.match(listings, /const listPrice = listPriceFor\(p\.record, asks\);/);
  const ui = fs.readFileSync(path.join(APP_DIR, "public/js/ui.js"), "utf8");
  assert.match(ui, /const price = G\.manapoolListPrice\(r\);/);
  assert.doesNotMatch(ui, /conditionPricing/, "no second copy of the market x % math");
});

function twoBins(G) {
  const a = receive(G, 2);
  G.state.locations.push(G.newLocation({ id: "loc2", name: "Shelf B", type: "bin" }));
  G.state.locations[1].sellFrom = true;
  const b = G.addCopies({ set: "a25", num: "141", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc2", qty: 2, info: INFO, action: "receipt", receiptId: "T2", note: "" });
  assert.notEqual(a.id, b.id, "two stacks of one printing");
  a.price = 3; b.price = 3;
  return { a, b };
}
const inBin = name => ({ combinator: "ALL", conditions: [{ on: true, field: "location", op: "is", value: name }], groups: [] });

test("manapoolListPrice: every stack of one listing gets the same ask, whatever was stored (#88, #228)", () => {
  // The 23 clashes: two stacks of one listing with different stored asks.
  const G = setup();
  const { a, b } = twoBins(G);
  a.listedQty = 2; a.askPrice = 4; b.askPrice = 6;
  G.state.priceRules = [catchAll(G, { mode: "percent", percent: 2 })];
  assert.equal(G.manapoolListPrice(a), 6);
  assert.equal(G.manapoolListPrice(b), 6, "bin B (not listed yet) goes out at the listing's ask");
  const asks = G.manapoolListingAsks();
  assert.equal(asks.size, 1, "one listing, one ask");
  assert.equal(G.manapoolListPrice(b, asks), 6, "same answer from the prebuilt map");
  G.state.priceRules = [];
  assert.equal(G.manapoolListPrice(a), 3, "no rule anywhere: market");
});

test("listing ask: the highest-priority rule among the listed stacks prices the whole listing (#228)", () => {
  const G = setup();
  const { a, b } = twoBins(G);
  a.listedQty = 1; b.listedQty = 1;
  const binA = catchAll(G, { name: "A", priority: 1, mode: "fixed", fixed: 5, criteria: inBin("Shelf A") });
  const binB = catchAll(G, { name: "B", priority: 9, mode: "fixed", fixed: 7, criteria: inBin("Shelf B") });
  G.state.priceRules = [binA, binB];
  assert.equal(G.manapoolListPrice(a), 7);
  assert.equal(G.manapoolListPrice(b), 7);
  // Only bin A listed: bin B's copies aren't part of the live listing.
  b.listedQty = 0;
  assert.equal(G.manapoolListPrice(b), 5);
  // An exclude on bin A doesn't stop bin B's rule pricing the listing (#87).
  b.listedQty = 1;
  G.state.priceRules = [catchAll(G, { name: "not A", priority: 9, mode: "exclude", criteria: inBin("Shelf A") }),
    catchAll(G, { name: "rest", priority: 0, mode: "fixed", fixed: 2 })];
  assert.equal(G.manapoolListPrice(a), 2);
  const plan = G.bulkPricePlan({ includeUnchanged: true });
  assert.equal(plan.length, 2, "both listed stacks are lines");
  assert.deepEqual([...plan.map(l => l.target)], [2, 2], "with the listing's one ask");
  assert.deepEqual([...plan.map(l => l.rule.name)], ["rest", "rest"]);
});

test("bulkPricePlan: 'current' is the price last sent; picking a rule only narrows the plan (#228)", () => {
  const G = setup();
  const { a } = twoBins(G);
  a.listedQty = 1; a.askPrice = 3;
  const fixed = catchAll(G, { name: "fixed", priority: 5, mode: "fixed", fixed: 4 });
  const pct = catchAll(G, { name: "pct", priority: 0, mode: "percent", percent: 1 });
  G.state.priceRules = [fixed, pct];
  const [line] = G.bulkPricePlan();
  assert.equal(line.current, 3);
  assert.equal(line.target, 4);
  assert.equal(line.delta, 1);
  assert.equal(G.bulkPricePlan({ ruleId: pct.id }).length, 0, "pct doesn't price this listing - fixed outranks it");
  assert.equal(G.bulkPricePlan({ ruleId: fixed.id }).length, 1);
  fixed.on = false;
  assert.equal(G.bulkPricePlan({ ruleId: fixed.id }).length, 0, "a switched-off rule prices nothing");
  assert.equal(G.bulkPricePlan({ includeUnchanged: true })[0].target, 3, "pct takes over");
  assert.equal(G.bulkPricePlan().length, 0, "Manapool already has $3 - nothing to push");
});

/* ---------------- #98: $0.00 targets ---------------- */

test("bulkPricePlan: a rule that works out to $0.00 is flagged zero and goes out at market x % (#98, #228)", () => {
  const G = setup();
  const r = receive(G, 1);
  r.price = 0.2; r.listedQty = 1; r.askPrice = 0.4;
  G.state.priceRules = [catchAll(G, { mode: "delta", delta: -0.25 })];
  const [line] = G.bulkPricePlan({ includeUnchanged: true });
  assert.equal(line.zero, true);
  assert.equal(line.noBasis, false, "not 'waiting on price data' - it has a price, it's just $0.00");
  assert.equal(line.target, 0.2, "never $0.00: market x NM's 100%");
  assert.equal(line.fallback, true);
  assert.equal(G.bulkPricePlan().length, 1, "differs from the $0.40 last sent");
  assert.equal(G.manapoolListPrice(r), 0.2, "Listings sends the same");
  G.recordManapoolAsks([{ key: KEY, price: 0 }], "test");
  assert.equal(r.askPrice, 0.4, "a $0.00 price is never recorded");

  r.price = null;
  const [noPrice] = G.bulkPricePlan({ includeUnchanged: true });
  assert.equal(noPrice.noBasis, true);
  assert.equal(noPrice.zero, false);
  assert.equal(noPrice.target, null, "no market price either: no price, Push skips it");
  assert.equal(G.bulkPricePlan().length, 1, "still surfaced, not silently dropped");
});

test("bulkPricePlan: a fixed $0 rule is zero too; a real price is unaffected (#98)", () => {
  const G = setup();
  const r = receive(G, 1);
  r.price = 1; r.listedQty = 1;
  G.state.priceRules = [catchAll(G, { mode: "fixed", fixed: 0 })];
  assert.equal(G.bulkPricePlan({ includeUnchanged: true })[0].zero, true);
  G.state.priceRules = [catchAll(G, { mode: "percent", percent: 0.9 })];
  const [line] = G.bulkPricePlan({ includeUnchanged: true });
  assert.equal(line.target, 0.9);
  assert.equal(!!line.zero, false);
});

test("sealedBulkPricePlan: a $0.00 target is flagged zero and not applied (#98)", () => {
  const G = setup();
  const rec = sealedRecord(G, { price: 0.1 });
  rec.listedQty = 1;
  G.state.sealedPriceRules = [G.normalizeSealedPriceRule({ mode: "delta", delta: -1 })];
  const [line] = G.sealedBulkPricePlan({ includeUnchanged: true });
  assert.equal(line.zero, true);
  assert.equal(line.target, null);
  G.applySealedBulkPricePlan([line], "test");
  assert.equal(rec.askPrice == null, true);
});

/* ---------------- #98: a push records what it pushed ---------------- */

test("a pushed price is recorded on every stack of the listing, and Evaluate stops offering it (#98, #228)", () => {
  // Every confirmed push (Bulk Price, Listings, the single-stack +/-) calls
  // recordManapoolAsks with what it sent.
  const G = setup();
  const { a, b } = twoBins(G);
  a.price = 2; b.price = 2; a.listedQty = 1; b.listedQty = 1; a.askPrice = 1; b.askPrice = 5;
  G.state.priceRules = [catchAll(G, { mode: "percent", percent: 1.5 })];
  const lines = G.bulkPricePlan();
  assert.deepEqual([...lines.map(l => l.target)], [3, 3]);
  const out = G.recordManapoolAsks([{ key: KEY, price: 3 }], "Manapool price push");
  assert.equal(out.changed, 2);
  assert.equal(a.askPrice, 3);
  assert.equal(b.askPrice, 3, "the clash is gone - one listing, one price");
  assert.equal(G.bulkPricePlan().length, 0, "nothing left to change");
  const page = fs.readFileSync(path.join(APP_DIR, "public/bulk-price.page.js"), "utf8");
  assert.match(page, /G\.recordManapoolAsks\(sent, "Manapool price push"\)/);
  assert.match(page, /G\.applySealedBulkPricePlan\(asks, "Manapool price push"\)/);
  assert.doesNotMatch(page, /applyBulkPricePlan\(/, "no card Apply any more");
  const listings = fs.readFileSync(path.join(APP_DIR, "public/listings.page.js"), "utf8");
  assert.match(listings, /G\.recordManapoolAsks\(confirmed\.map/,"sent and already-right listings (#482)");
  const ui = fs.readFileSync(path.join(APP_DIR, "public/js/ui.js"), "utf8");
  assert.match(ui, /G\.recordManapoolAsks\(\[\{ key: identityKey, price \}\], "Manapool push"\);/);
});

/* ---------------- #98: ask-price backfill ---------------- */

test("askPriceBackfillPending / backfillAskPricesFromManapool: rows a fetch couldn't fill aren't fetched for again (#98)", () => {
  const G = setup();
  const onMp = receive(G, 1);
  onMp.listedQty = 1;
  const notOnMp = receive(G, 1, { info: { scryfallId: "zzz-9", collector: "9", name: "Shock" } });
  notOnMp.listedQty = 1;
  const priced = receive(G, 1, { info: { scryfallId: "p-1", collector: "1", name: "Opt" } });
  priced.listedQty = 1; priced.askPrice = 1;

  const pending = G.askPriceBackfillPending(new Set());
  assert.deepEqual([...pending].sort(), [onMp.id, notOnMp.id].sort(), "only listed rows with no ask");
  const out = G.backfillAskPricesFromManapool([
    { kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 1, price: 0.61 }
  ]);
  assert.equal(out.filled, 1);
  assert.equal(onMp.askPrice, 0.61);
  assert.deepEqual([...out.missed], [notOnMp.id]);
  // The page remembers `missed`, so the next visit has nothing to fetch for.
  assert.equal(G.askPriceBackfillPending(new Set(out.missed)).length, 0);
  // A newly listed row is still picked up.
  const fresh = receive(G, 1, { info: { scryfallId: "n-2", collector: "2", name: "Ponder" } });
  fresh.listedQty = 1;
  assert.deepEqual([...G.askPriceBackfillPending(new Set(out.missed))], [fresh.id]);
});

test("backfillAskPricesFromManapool: a $0 live price is not copied in as the ask (#98)", () => {
  const G = setup();
  const r = receive(G, 1);
  r.listedQty = 1;
  const out = G.backfillAskPricesFromManapool([
    { kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 1, price: 0 }
  ]);
  assert.equal(out.filled, 0);
  assert.equal(r.askPrice == null, true);
});

/* ---------------- #96: Delist all ---------------- */

const LIVE = [
  // known locally, local listedQty stale at 0
  { kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 2, name: "Lightning Bolt" },
  // the same identity split across two Manapool rows: one write
  { kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 1, name: "Lightning Bolt" },
  // listed on Manapool directly, no local stack at all
  { kind: "card", scryfallId: "mp-only", lang: "ja", finish: "foil", condition: "LP", quantity: 1, name: "Sol Ring", set: "cmm", collector: "1" },
  // sealed
  { kind: "sealed", manapoolProductId: "mp-1", tcgplayerProductId: "tcg-1", quantity: 3, name: "Foundations Bundle" },
  // nothing to address it by
  { kind: "card", scryfallId: "", quantity: 1, name: "Mystery card" },
  // already at 0 (Manapool normally omits these)
  { kind: "card", scryfallId: "gone", quantity: 0, name: "Gone" }
];

test("delistAllPlan: every live listing, cards and sealed, including ones Grimoire doesn't know are listed (#96)", () => {
  const G = setup();
  const r = receive(G, 2);
  r.listedQty = 0;   // stale: Manapool shows it listed
  const plan = G.delistAllPlan(LIVE);
  assert.deepEqual([...plan.cards.map(c => c.key)], [KEY, "mp-only|ja|foil|LP"]);
  for (const c of plan.cards) {
    assert.equal(c.entry.quantity, 0);
    assert.equal(c.entry.price, null);
  }
  const solRing = plan.cards[1].entry;
  assert.equal(solRing.card.scryfallId, "mp-only");
  assert.equal(solRing.card.lang, "ja");
  assert.equal(solRing.card.finish, "foil");
  assert.equal(solRing.condition, "LP");
  assert.equal(plan.sealed.length, 1);
  assert.equal(plan.sealed[0].entry.item.manapoolProductId, "mp-1");
  assert.equal(plan.sealed[0].entry.quantity, 0);
  assert.deepEqual([...plan.cantDelist], ["Mystery card"], "reported, not silently skipped");
});

test("applyDelistAll: local listed goes to 0 for everything that came down, stale counts included; failures stay listed (#96)", () => {
  const G = setup();
  const delisted = receive(G, 3);
  delisted.listedQty = 2;
  const failedOne = receive(G, 2, { info: { scryfallId: "fail-1", collector: "5", name: "Counterspell" } });
  failedOne.listedQty = 2;
  // locally listed but not on Manapool at all - Manapool already lists none
  const stale = receive(G, 1, { info: { scryfallId: "stale-1", collector: "6", name: "Brainstorm" } });
  stale.listedQty = 1;
  const box = sealedRecord(G, { qty: 3 });
  box.listedQty = 3;
  const failedBox = sealedRecord(G, { tcgplayerProductId: "tcg-2", manapoolProductId: "mp-2", name: "Bloomburrow Bundle" });
  failedBox.listedQty = 1;

  const out = G.applyDelistAll({ cards: new Set(["fail-1|en|nonfoil|NM"]), sealed: new Set(["mp-2"]) }, "Delist all");
  assert.equal(delisted.listedQty, 0);
  assert.equal(stale.listedQty, 0, "a stale local count follows Manapool to 0");
  assert.equal(box.listedQty, 0, "sealed too");
  assert.equal(failedOne.listedQty, 2, "a listing that failed to delist is still live, so local keeps it");
  assert.equal(failedBox.listedQty, 1, "matched by Manapool product id");
  assert.equal(out.changed, 3);
});

test("Push ticked carries Manapool's short-quantity warning and calls out 0-copy listings instead of 'Pushed' (#225)", () => {
  // Page code can't run in the shim, so pin the wiring.
  const page = fs.readFileSync(path.join(APP_DIR, "public/listings.page.js"), "utf8");
  const batch = page.slice(page.indexOf("async function pushManapoolBatch("), page.indexOf("async function pushToManapool()"));
  assert.match(batch, /warning: r\.warning \|\| null/, "a confirmed result's warning reaches the caller");
  const fn = page.slice(page.indexOf("async function pushToManapool()"), page.indexOf("async function delistAll()"));
  assert.match(fn, /G\.applyManapoolPushToStacks\(s\.key, g\.perStack, g\.targetSum, s\.quantity,/, "local listed follows Manapool's count");
  assert.match(fn, /const short = succeeded\.filter\(s => s\.warning\)/);
  assert.match(fn, /groups\.get\(s\.key\)\.targetSum === 0/, "a group sent with 0 copies is counted apart");
  assert.match(fn, /const listed = succeeded\.length - short\.length - zero\.length/, "'Pushed' counts only real listings");
  assert.match(fn, /"Nothing was listed for sale on Manapool"/);
});

test("Delist all reads live listings first and sends sealed through the sealed route (#96)", () => {
  const page = fs.readFileSync(path.join(APP_DIR, "public/listings.page.js"), "utf8");
  const fn = page.slice(page.indexOf("async function delistAll()"), page.indexOf("async function refreshManapoolButton()"));
  assert.ok(fn.indexOf('G.api("/api/manapool/listings")') !== -1);
  assert.ok(fn.indexOf('G.api("/api/manapool/listings")') < fn.indexOf("confirmDialog"), "live read before asking");
  assert.match(fn, /G\.delistAllPlan\(listings\)/);
  assert.match(fn, /"\/api\/manapool\/list-bulk-sealed"/);
  assert.match(fn, /typeToConfirm: "DELIST"/, "keeps the typed confirm");
  assert.doesNotMatch(fn, /G\.state\.cards/, "not built from local listed counts any more");
});
