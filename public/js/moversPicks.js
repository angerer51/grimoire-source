"use strict";
/* Movers' "Worth a look today" selection rules - the pure, DOM-free part.
   ---------------------------------------------------------------
   Loaded as a plain <script> before movers.page.js (a global,
   window.MoversPicks) and require()'d directly by test/moversPicks.test.js,
   the same dual-use shape as priceRuleEngine.js. Everything here takes a
   Movers row (the shape prices.movers() returns) and answers a yes/no or
   picks from a list - no DOM, no fetch, no page state - so the rules that
   decide what gets flagged can be tested without a browser.

   Only the rules that the "Trending up (not owned)" pick (#6) and the
   "Golden cross" pick (#352) depend on live here; the cost-basis and
   %-swing rules stay in movers.page.js. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.MoversPicks = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* Fixed thresholds for the curated panel and Explore - deliberately not
     the Signal section's own live flatPct/flatSpots inputs, so the panel
     doesn't shift around as someone tunes those for a manual search. */
  var HL_FLAT_PCT = 2, HL_FLAT_SPOTS = 25, HL_MIN_PRICE = 1, HL_MAX_PCT = 1000;

  // BOTH ends need a real price at or above the floor - not just the larger
  // of the two. An old, thinly-traded printing (a reserved-list dual, say)
  // can have a near-worthless "then" data point that's really a feed gap,
  // not an actual price - checking only the max let a real $300 "now" pair
  // with a garbage $0.02 "then" and report an absurd four-digit percentage.
  function meetsFloor(r) {
    return r.now != null && r.then != null && r.now >= HL_MIN_PRICE && r.then >= HL_MIN_PRICE;
  }

  // EDHRec rank getting better by a real amount: rankDelta is negative when
  // the rank NUMBER goes down (more popular). A move under HL_FLAT_SPOTS is
  // noise, the same bar the server's sweep uses for a "meaningful" rank move.
  function rankImproving(r) {
    return r.rankDelta != null && r.rankDelta < 0 && Math.abs(r.rankDelta) >= HL_FLAT_SPOTS;
  }

  // "Early signal": popularity rising while the price hasn't moved yet.
  function earlySignal(r) {
    var priceFlat = r.pct == null ? (r.delta == null) : Math.abs(r.pct) < HL_FLAT_PCT;
    return rankImproving(r) && priceFlat;
  }

  // "Trending up (not owned)" - #6, owner's definition (2026-10-08): a card
  // you don't hold whose 30-day average price is above its 60-day average
  // (maDiff > 0) AND whose popularity rank is improving. maDiff is real for
  // unowned rows because the catalog sweep computes MAs for its survivors
  // (since 2026-09-20). The $1 floor is applied by the caller (meetsFloor),
  // same as every other pick.
  function trendingUpUnowned(r) {
    return !(r.qty > 0) && hasMaTrend(r) && r.maDiff > 0 && rankImproving(r);
  }

  // #266: a row only counts as having a 30/60-day trend when both trend
  // values AND today's price are at or above the $1 floor - the same idea as
  // meetsFloor for then/now. Cents-level prices make wild percentages out of
  // tiny moves, and a stale bad price can sit under both averages for weeks.
  // #356: and the 30-vs-60-day gap within the same sanity cap the % picks
  // use (HL_MAX_PCT) - a four-digit gap is a one-off repricing or bad data,
  // not a trend. The main table still shows the numbers; this only keeps a
  // row out of the picks and the Explore trend lenses.
  function hasMaTrend(r) {
    return r.maPct != null && r.maDiff != null && r.now != null && r.ma30 != null && r.ma60 != null &&
      r.now >= HL_MIN_PRICE && r.ma30 >= HL_MIN_PRICE && r.ma60 >= HL_MIN_PRICE &&
      Math.abs(r.maPct) <= HL_MAX_PCT;
  }

  // Card identity across printings and finishes. Rows are per printing x
  // finish, but EDHRec rank is per card, so "is this the same card" has to
  // be asked at this level, not by row.
  function cardKey(r) { return r.oracleId || ("name:" + r.name); }

  /* #356: up to `n` rows from `sorted` (best first), one per card, skipping
     every card already in `shownRows` - so each card fills at most one line
     of Today's top picks, and a line whose best card is already shown falls
     to its next-best card instead. */
  function takeNewCards(sorted, n, shownRows) {
    var seen = new Set((shownRows || []).map(cardKey)), out = [];
    for (var i = 0; i < (sorted || []).length && out.length < n; i++) {
      var k = cardKey(sorted[i]);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(sorted[i]);
    }
    return out;
  }

  /* The single best "Trending up (not owned)" row for the curated panel:
     floor-passing, strongest maPct (percent, #266) first, ties broken by the bigger rank
     improvement. `excludeRows` (optional array of rows already shown as
     another pick) skips every printing and finish of THOSE CARDS, so one
     card doesn't fill two lines. Returns null when nothing qualifies. */
  function pickTrendingUp(rows, excludeRows) {
    var skip = new Set((excludeRows || []).map(cardKey));
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (skip.has(cardKey(r))) continue;
      if (!meetsFloor(r) || !trendingUpUnowned(r)) continue;
      if (!best || r.maPct > best.maPct ||
          (r.maPct === best.maPct && r.rankDelta < best.rankDelta)) best = r;
    }
    return best;
  }

  /* "Steady climber" (#352, owner 2026-10-28): a golden cross whose price
     climbed over several days rather than jumping once. Real price data is
     full of one-day repricings (a $4 foil relisted at $44 and left there),
     which make the biggest 30-vs-60-day gaps; those are what this skips.
     Over the newest 30 priced days (the server sends the figures, prices.js
     climbOf()):
     - the price rose, and no single day supplied more than a third of that
       climb (jumpShare). That rules out a one-off repricing, and a spike
       today, which would be one big day too;
     - today's price is within 10% of the highest of those days (offHighPct):
       still climbing or holding, not fading after a peak;
     - and the 30-vs-60-day gap is within the picks' sanity cap (HL_MAX_PCT).
     Checked against real prices on 2026-10-28 (7-day window, 5% gap): 706
     crosses, 37 steady climbers. A "today at most N% above the 30-day line"
     test was tried and dropped: a real steady climber sits well above its
     lagging 30-day median, so it removed the best examples. The server
     applies the same rule (it requires this file) to choose the pick
     candidates it sends. */
  var GX_MAX_JUMP_SHARE = 1 / 3, GX_MAX_OFF_HIGH_PCT = 10;
  function steadyClimber(r) {
    return r.maPct != null && r.maPct <= HL_MAX_PCT &&
      r.jumpShare != null && r.jumpShare <= GX_MAX_JUMP_SHARE &&
      r.offHighPct != null && r.offHighPct <= GX_MAX_OFF_HIGH_PCT;
  }

  /* The "Golden cross" pick (#352): of the golden-cross rows the server
     returns (GET /api/prices/golden-cross's `best`, each a printing whose
     30-day line crossed above the 60-day line in the last N days), the
     steady climber (above) sitting furthest above its 60-day line, held to
     hasMaTrend's $1 floor. Like pickTrendingUp, it skips every printing of a
     card already shown by another pick. Owned or not doesn't matter. Null
     when none qualifies. */
  function pickGoldenCross(rows, excludeRows) {
    var skip = new Set((excludeRows || []).map(cardKey));
    var best = null;
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (skip.has(cardKey(r)) || !hasMaTrend(r) || !(r.maDiff > 0) || !steadyClimber(r)) continue;
      if (!best || r.maPct > best.maPct) best = r;
    }
    return best;
  }

  return {
    HL_FLAT_PCT: HL_FLAT_PCT, HL_FLAT_SPOTS: HL_FLAT_SPOTS, HL_MIN_PRICE: HL_MIN_PRICE, HL_MAX_PCT: HL_MAX_PCT,
    meetsFloor: meetsFloor, rankImproving: rankImproving, earlySignal: earlySignal,
    trendingUpUnowned: trendingUpUnowned, hasMaTrend: hasMaTrend, cardKey: cardKey, takeNewCards: takeNewCards, pickTrendingUp: pickTrendingUp,
    steadyClimber: steadyClimber, pickGoldenCross: pickGoldenCross
  };
});
