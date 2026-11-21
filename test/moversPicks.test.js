"use strict";
/* public/js/moversPicks.js is a plain, DOM-free module (same dual-use shape
   as priceRuleEngine.js) - requireable directly. Locks down the selection
   rules behind Movers' "Worth a look today" picks, in particular #6's
   "Trending up (not owned)": maDiff > 0 AND rank improving, unowned, $1 floor
   (on then/now and, since #266, on now/ma30/ma60); strongest maPct wins. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const P = require(path.join(__dirname, "..", "public", "js", "moversPicks"));

// A floor-passing, unowned, trending-up row unless overridden.
// maDiff/maPct follow ma30/ma60 unless the override sets them itself.
const row = over => {
  const r = Object.assign({
    name: "Esper Sentinel", qty: 0, then: 10, now: 11, delta: 1, pct: 10,
    rankDelta: -300, ma30: 10.4, ma60: 9
  }, over);
  if (!("maDiff" in (over || {}))) r.maDiff = r.ma30 == null || r.ma60 == null ? null : r.ma30 - r.ma60;
  if (!("maPct" in (over || {}))) r.maPct = r.ma30 == null || r.ma60 == null ? null : (r.ma30 - r.ma60) / r.ma60 * 100;
  return r;
};

test("meetsFloor: both ends must be at or above $1", () => {
  assert.equal(P.meetsFloor(row({ then: 1, now: 1 })), true, "exactly $1 on both ends passes");
  assert.equal(P.meetsFloor(row({ then: 0.99 })), false, "a sub-$1 'then' fails even with a big 'now'");
  assert.equal(P.meetsFloor(row({ now: 0.5 })), false);
  assert.equal(P.meetsFloor(row({ then: null })), false, "a missing end fails");
});

test("rankImproving: needs a real improvement of at least HL_FLAT_SPOTS", () => {
  assert.equal(P.rankImproving(row({ rankDelta: -P.HL_FLAT_SPOTS })), true);
  assert.equal(P.rankImproving(row({ rankDelta: -(P.HL_FLAT_SPOTS - 1) })), false, "under the bar is noise");
  assert.equal(P.rankImproving(row({ rankDelta: 300 })), false, "a rising rank NUMBER is getting less popular");
  assert.equal(P.rankImproving(row({ rankDelta: null })), false);
});

test("earlySignal: rank improving and price flat", () => {
  assert.equal(P.earlySignal(row({ pct: 1 })), true);
  assert.equal(P.earlySignal(row({ pct: 10 })), false, "price already moved");
  assert.equal(P.earlySignal(row({ pct: 1, rankDelta: -5 })), false, "rank barely moved");
});

test("trendingUpUnowned: unowned, maDiff > 0 and rank improving - all three required", () => {
  assert.equal(P.trendingUpUnowned(row()), true);
  assert.equal(P.trendingUpUnowned(row({ qty: 2 })), false, "a card you hold is not a discovery pick");
  assert.equal(P.trendingUpUnowned(row({ ma30: 9 })), false, "30-day median must be ABOVE the 60-day one");
  assert.equal(P.trendingUpUnowned(row({ ma30: 8.5 })), false);
  assert.equal(P.trendingUpUnowned(row({ ma30: null })), false, "no trend history (or too sparse), no trend");
  assert.equal(P.trendingUpUnowned(row({ rankDelta: 300 })), false, "price trend alone isn't enough");
  assert.equal(P.trendingUpUnowned(row({ rankDelta: null })), false);
});

test("hasMaTrend (#266): now, ma30 and ma60 must all be at least $1", () => {
  assert.equal(P.hasMaTrend(row()), true);
  assert.equal(P.hasMaTrend(row({ now: 0.4 })), false, "today's price under the floor");
  assert.equal(P.hasMaTrend(row({ ma30: 0.3, ma60: 2.5 })), false, "a stale bad price sitting under the 30-day median");
  assert.equal(P.hasMaTrend(row({ ma30: 1.2, ma60: 0.8 })), false, "60-day median under the floor");
  assert.equal(P.hasMaTrend(row({ ma60: null })), false, "too sparse - no trend at all");
  assert.equal(P.trendingUpUnowned(row({ ma30: 1.5, ma60: 0.5, now: 1.6 })), false, "+200% off a sub-$1 base never wins a pick");
});

test("pickTrendingUp (#266): strongest PERCENT that passes the floor, not the biggest dollar gap", () => {
  const pricey = row({ name: "pricey", then: 3600, now: 3700, ma30: 3700, ma60: 3450 }); // +$250, +7.2%
  const doubled = row({ name: "doubled", then: 4, now: 9, ma30: 8, ma60: 4 });           // +$4, +100%
  const weak = row({ name: "weak", ma30: 9.2 });
  const cheap = row({ name: "cheap", then: 0.4, now: 0.6, ma30: 0.6, ma60: 0.2 });
  const held = row({ name: "held", qty: 1, ma30: 20, ma60: 5 });
  assert.ok(pricey.maDiff > doubled.maDiff && pricey.maPct < doubled.maPct);
  assert.equal(P.pickTrendingUp([weak, pricey, cheap, doubled, held]), doubled);
  assert.equal(P.pickTrendingUp([cheap, held]), null);
  assert.equal(P.pickTrendingUp([]), null);
});

test("pickTrendingUp: ties go to the bigger rank improvement", () => {
  const a = row({ name: "a", oracleId: "o-a", rankDelta: -50 });
  const b = row({ name: "b", oracleId: "o-b", rankDelta: -500 });
  assert.equal(P.pickTrendingUp([a, b]), b);
  assert.equal(P.pickTrendingUp([a, b], [b]), a, "an excluded card yields to the next one");
});

test("pickTrendingUp: a card already shown as Early signal is skipped in EVERY printing/finish", () => {
  // Same card (same oracleId): the nonfoil is flat-priced (Early signal),
  // the foil climbed and is the strongest trending row of all.
  const nonfoil = row({ oracleId: "o-x", name: "X", finish: "nonfoil", pct: 1, ma30: 9.1, rankDelta: -300 });
  const foil = row({ oracleId: "o-x", name: "X", finish: "foil", pct: 8, ma30: 11, rankDelta: -300 });
  const other = row({ oracleId: "o-y", name: "Y", ma30: 9.5, rankDelta: -40 });
  assert.equal(P.earlySignal(nonfoil), true);
  assert.equal(P.pickTrendingUp([nonfoil, foil, other]), foil, "without exclusion the foil would win");
  assert.equal(P.pickTrendingUp([nonfoil, foil, other], [nonfoil]), other, "card X is shown already - no duplicate");
  assert.equal(P.pickTrendingUp([nonfoil, foil], [nonfoil]), null, "nothing else qualifies");
});

// A golden-cross row (GET /api/prices/golden-cross): no then/pct/rank, only
// today's price, the lines and how the price climbed. Steady unless overridden.
const gx = over => row(Object.assign({ then: null, delta: null, pct: null, rankDelta: null, crossDate: "2026-10-25",
  climbPct: 40, jumpShare: 0.2, offHighPct: 2 }, over));

test("steadyClimber (#352): a climb over several days, near its high, within the sanity cap", () => {
  assert.equal(P.steadyClimber(gx({})), true);
  assert.equal(P.steadyClimber(gx({ jumpShare: 1 })), false, "the whole climb in one day (a repricing)");
  assert.equal(P.steadyClimber(gx({ jumpShare: 0.5 })), false, "half of it in one day");
  assert.equal(P.steadyClimber(gx({ jumpShare: 1 / 3 })), true, "a third is the limit");
  assert.equal(P.steadyClimber(gx({ jumpShare: null })), false, "the price didn't rise over the 30 days");
  assert.equal(P.steadyClimber(gx({ offHighPct: 25 })), false, "faded well off its peak");
  assert.equal(P.steadyClimber(gx({ offHighPct: 10 })), true);
  assert.equal(P.steadyClimber(gx({ ma30: 30, ma60: 2 })), false, "a 1,400% gap is past HL_MAX_PCT");
  assert.equal(P.steadyClimber(gx({ now: 20, ma30: 10.4 })), true, "well above its lagging 30-day line is fine for a real climber");
});

test("pickGoldenCross (#352): the steady climber furthest above its 60-day line, $1 floor, owned or not, skipping cards already picked", () => {
  const mild = gx({ name: "mild", oracleId: "o-m", ma30: 10.5, ma60: 10 });
  const strong = gx({ name: "strong", oracleId: "o-s", ma30: 13, ma60: 10, qty: 2 });
  const repriced = gx({ name: "repriced", oracleId: "o-r", now: 44, ma30: 44, ma60: 4.34, jumpShare: 1 });
  const cents = gx({ name: "cents", oracleId: "o-c", now: 0.9, ma30: 0.9, ma60: 0.3 });
  assert.equal(P.pickGoldenCross([repriced, mild, strong, cents]), strong,
    "the one-day repricing has the biggest gap but isn't a steady climber; a card you own can be the pick");
  assert.equal(P.pickGoldenCross([mild, strong, cents], [gx({ oracleId: "o-s", finish: "foil" })]), mild,
    "a card another pick shows is skipped in every printing");
  assert.equal(P.pickGoldenCross([cents, repriced]), null, "under the $1 floor, or not steady");
  assert.equal(P.pickGoldenCross(null), null);
});

test("cardKey: oracleId, falling back to the name when there is none", () => {
  assert.equal(P.cardKey({ oracleId: "o-1", name: "A" }), "o-1");
  assert.equal(P.cardKey({ oracleId: null, name: "A" }), "name:A");
});

test("hasMaTrend (#356): the 30-vs-60-day gap must be within HL_MAX_PCT (1000%)", () => {
  // ma60 $2: ma30 $21.98 is +999%, $22.02 is +1,001%.
  const under = row({ ma30: 21.98, ma60: 2, now: 22 });
  const over = row({ ma30: 22.02, ma60: 2, now: 22 });
  assert.ok(under.maPct < P.HL_MAX_PCT && over.maPct > P.HL_MAX_PCT);
  assert.equal(P.hasMaTrend(under), true, "just under the cap still counts");
  assert.equal(P.hasMaTrend(row({ maPct: P.HL_MAX_PCT })), true, "exactly the cap counts");
  assert.equal(P.hasMaTrend(over), false, "just over the cap is a repricing or bad data, not a trend");
  assert.equal(P.hasMaTrend(row({ maPct: -1001 })), false, "the cap applies both ways");
  // The 2026-10-28 case: Onakke Oathkeeper at +1,016% no longer wins Trending up.
  const onakke = row({ name: "Onakke Oathkeeper", oracleId: "o-onakke", ma30: 22.32, ma60: 2, now: 23 });
  const real = row({ name: "real", oracleId: "o-real", ma30: 12, ma60: 10 });
  assert.equal(P.trendingUpUnowned(onakke), false);
  assert.equal(P.pickTrendingUp([onakke, real]), real);
  assert.equal(P.pickTrendingUp([under, real]), under, "a +999% gap is still allowed to win");
  // And the golden-cross pick, which also goes through hasMaTrend.
  assert.equal(P.pickGoldenCross([gx({ oracleId: "o-g", ma30: 22.02, ma60: 2, now: 22 })]), null);
});

test("takeNewCards (#356): one line per card, skipping cards already shown, falling to the next best", () => {
  const xNon = row({ oracleId: "o-x", name: "X", finish: "nonfoil" });
  const xFoil = row({ oracleId: "o-x", name: "X", finish: "foil" });
  const y = row({ oracleId: "o-y", name: "Y" });
  const z = row({ oracleId: "o-z", name: "Z" });
  assert.deepEqual(P.takeNewCards([xNon, xFoil, y, z], 3), [xNon, y, z], "two printings of X take one line");
  assert.deepEqual(P.takeNewCards([xFoil, y], 1, [xNon]), [y], "X is shown already (another printing): next best");
  assert.deepEqual(P.takeNewCards([xFoil], 1, [xNon]), [], "nothing new: the line is left out");
  assert.deepEqual(P.takeNewCards(null, 1), []);
  // Today's top picks order: a held % pick skips a card the Golden cross pick already shows.
  const shown = [];
  const take = (sorted, n) => { const got = P.takeNewCards(sorted, n, shown); shown.push(...got); return got; };
  const epic = gx({ oracleId: "o-epic", name: "Epic Fight", qty: 1 });
  const cross = P.pickGoldenCross([epic], shown); shown.push(cross);
  assert.equal(cross, epic);
  const heldUp = take([row({ oracleId: "o-epic", name: "Epic Fight", qty: 1, pct: 40 }), row({ oracleId: "o-w", name: "W", qty: 1, pct: 20 })], 1)[0];
  assert.equal(heldUp.name, "W");
});
