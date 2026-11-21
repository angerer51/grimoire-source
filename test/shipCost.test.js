"use strict";
/* public/js/shipCost.js (#457 part 1): the packaging + postage engine that
   every shipped sale's cost will be frozen from. A wrong break or stamp count
   here silently moves profit on every order, so the math is pinned down. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const ShipCost = require(path.join(__dirname, "..", "public", "js", "shipCost"));

const D = ShipCost.defaults();

test("letter: a few cheap cards go in the default letter with one stamp", () => {
  // 4 cards .24 + envelope .2 + slip .17 + 4 sleeves .08 + 1 toploader .24 + 1 team bag .05
  const r = ShipCost.costOrder({ cards: 4, value: 5 }, D);
  assert.equal(r.rule, "letter");
  assert.equal(r.oz, 0.98);
  assert.equal(r.extraOunces, 0);
  assert.equal(r.postage, 0.82);
  assert.equal(r.supplies, 0.24);
  assert.equal(r.total, 1.06);
  assert.equal(r.fallback, false);
});

test("letter: each ounce (or part) over 1 oz adds an extra-ounce stamp", () => {
  const r = ShipCost.costOrder({ cards: 8, value: 10 }, D);   // 1.59 oz
  assert.equal(r.rule, "letter");
  assert.equal(r.oz, 1.59);
  assert.equal(r.extraOunces, 1);
  assert.equal(r.postage, 1.11);
  const p = D.postage;
  assert.deepEqual(ShipCost.letterPostage(1, p), { extraOunces: 0, cost: 0.82 });
  assert.deepEqual(ShipCost.letterPostage(1.01, p), { extraOunces: 1, cost: 1.11 });
  assert.deepEqual(ShipCost.letterPostage(3.5, p), { extraOunces: 3, cost: 1.69 });
});

test("breaks: past the card break or the value break, the next rule takes it", () => {
  const byCards = ShipCost.costOrder({ cards: 9, value: 10 }, D);
  assert.equal(byCards.rule, "mailer-small");
  assert.equal(byCards.postage, 4.10);   // 2.21 oz, the ≤4 oz band
  const byValue = ShipCost.costOrder({ cards: 2, value: 60 }, D);
  assert.equal(byValue.rule, "mailer-small");
  assert.equal(ShipCost.costOrder({ cards: 2, value: 50 }, D).rule, "letter");   // "up to" includes the break
  assert.equal(ShipCost.costOrder({ cards: 40, value: 10 }, D).rule, "mailer-large");
  assert.equal(ShipCost.costOrder({ cards: 200, value: 10 }, D).rule, "box");
});

test("tracked orders (Manapool ground_advantage) never go as a letter", () => {
  const r = ShipCost.costOrder({ cards: 1, value: 1, tracked: true }, D);
  assert.equal(r.kind, "mailer");
  assert.equal(ShipCost.isTracked("ground_advantage"), true);
  assert.equal(ShipCost.isTracked("first_class"), false);
  assert.equal(ShipCost.isTracked(undefined), false);
  // Only letters set up: a tracked order has nothing to go in.
  const lettersOnly = Object.assign(ShipCost.defaults(), { rules: [D.rules[0]] });
  assert.equal(ShipCost.costOrder({ cards: 1, value: 1, tracked: true }, lettersOnly), null);
});

test("a letter heavier than the letter limit moves to the next rule up", () => {
  const cfg = ShipCost.defaults();
  cfg.rules[0].items.push({ supply: "onetouch", per: "card", qty: 1 });   // 1 oz each
  const r = ShipCost.costOrder({ cards: 4, value: 5 }, cfg);
  assert.equal(r.rule, "mailer-small");
});

test("tracked bands: the first band the weight fits, the open-ended band past the rest", () => {
  const b = D.postage.bands;
  assert.equal(ShipCost.bandPostage(4, b).cost, 4.10);
  assert.equal(ShipCost.bandPostage(4.01, b).cost, 4.80);
  assert.equal(ShipCost.bandPostage(16, b).cost, 5.90);
  assert.equal(ShipCost.bandPostage(40, b).cost, 7.50);
  // No open-ended band: heavier than the last still pays the last price.
  assert.equal(ShipCost.bandPostage(40, [{ upToOz: 4, price: 4 }, { upToOz: 8, price: 5 }]).cost, 5);
  assert.equal(ShipCost.bandPostage(2, []).cost, 0);
});

test("supply quantities: per order, per card, one per N cards (or part)", () => {
  assert.equal(ShipCost.itemQty({ per: "order", qty: 1 }, 30), 1);
  assert.equal(ShipCost.itemQty({ per: "card", qty: 1 }, 30), 30);
  assert.equal(ShipCost.itemQty({ per: "every", every: 4, qty: 1 }, 4), 1);
  assert.equal(ShipCost.itemQty({ per: "every", every: 4, qty: 1 }, 5), 2);
  assert.equal(ShipCost.itemQty({ per: "every", every: 4, qty: 1 }, 0), 0);
});

test("past every break, the last rule that can carry it is used and flagged", () => {
  const cfg = ShipCost.defaults();
  cfg.rules = [cfg.rules[0], Object.assign({}, cfg.rules[1], { upToCards: 10 })];
  const r = ShipCost.costOrder({ cards: 30, value: 10 }, cfg);
  assert.equal(r.rule, "mailer-small");
  assert.equal(r.fallback, true);
});

test("rules switched off are skipped; a deleted supply counts as nothing", () => {
  const cfg = ShipCost.defaults();
  cfg.rules[0].off = true;
  assert.equal(ShipCost.costOrder({ cards: 1, value: 1 }, cfg).rule, "mailer-small");
  const gone = ShipCost.defaults();
  gone.supplies = gone.supplies.filter(s => s.id !== "toploader");
  const r = ShipCost.costOrder({ cards: 4, value: 5 }, gone);
  assert.equal(r.oz, 0.74);
  assert.ok(!r.lines.some(l => l.supply === "toploader"));
});

test("normalize: junk or missing setup falls back to the defaults, never throws", () => {
  for (const bad of [null, undefined, 42, "x", {}, { rules: "no", supplies: null, postage: [] }]) {
    const n = ShipCost.normalize(bad);
    assert.equal(n.rules.length, D.rules.length);
    assert.equal(n.supplies.length, D.supplies.length);
    assert.equal(n.postage.stamp, 0.82);
  }
  const n = ShipCost.normalize({ rules: [{ id: "a", kind: "weird", upToCards: "", items: [{ supply: "sleeve", per: "nope", qty: "-3" }] }] });
  assert.equal(n.rules[0].kind, "mailer");
  assert.equal(n.rules[0].upToCards, null);
  assert.deepEqual(n.rules[0].items[0], { supply: "sleeve", per: "order", every: 1, qty: 1 });
  // Defaults are a copy: changing one doesn't touch the next caller's.
  ShipCost.defaults().rules.length = 0;
  assert.equal(ShipCost.defaults().rules.length, D.rules.length);
});
