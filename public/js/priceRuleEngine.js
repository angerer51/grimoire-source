"use strict";
/* Shared rule-matching + price-target math.
   ---------------------------------------------------------------
   Used two places that never used to share code: the browser's rule builder
   and Evaluate/Apply/Push buttons on /inventory/bulk-price (public/js/core.js),
   and server/lib/priceRules.js's unattended nightly schedule - there is no
   browser open for that one, so it cannot just call into core.js.

   This file used to be two hand-written copies, one per side, with a comment
   asking whoever changed one to remember the other. Now there is one copy:
   loaded as a plain <script> before core.js in every page (a global,
   window.RuleEngine), and require()'d directly by priceRules.js. Everything
   in here is a pure function - no DOM, no `state`, no filesystem - so both
   sides can use it as-is. A "location" field lookup takes a locName(id)
   function as a parameter instead of closing over anything, since the
   browser's location list and the server's are different objects entirely. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.RuleEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* ---------- Type line parsing ----------
     "Legendary Artifact Creature - Human Wizard" splits into
     supertypes [legendary], types [artifact, creature], subtypes [human, wizard].
     Lowercasing the whole line up front matters, not just style: SUPERTYPES
     is all-lowercase, so without it every word falls through to `types`
     instead and a "supertype" rule never matches anything. Handles the em
     dash Scryfall uses, an en dash, and a plain hyphen, so hand-typed data
     works too. */
  var SUPERTYPES = ["basic", "legendary", "ongoing", "snow", "world", "host", "elite"];
  function typeParts(typeLine) {
    var line = String(typeLine || "").toLowerCase();
    var split = line.split(/\s[—–-]\s/);
    var left = (split[0] || "").trim();
    var right = (split[1] || "").trim();
    var words = left.split(/\s+/).filter(Boolean);
    var supertypes = [], types = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (SUPERTYPES.indexOf(w) >= 0) supertypes.push(w); else types.push(w);
    }
    return { supertypes: supertypes, types: types, subtypes: right.split(/\s+/).filter(Boolean) };
  }

  /* ---------- Colors ---------- */
  var COLOR_LETTERS = ["W", "U", "B", "R", "G", "C"];
  function normColors(list) {
    var a = (Array.isArray(list) ? list : []).map(function (c) { return String(c).toUpperCase(); })
      .filter(function (c) { return COLOR_LETTERS.indexOf(c) >= 0; });
    return a.length ? Array.from(new Set(a)) : ["C"]; // no colours at all means colourless
  }

  /* ---------- Field kind ----------
     One source of truth for what kind of comparison each rule field uses.
     The browser's PUTAWAY_FIELDS (public/js/core.js) also carries a label and,
     for enum fields, an options list for the rule-builder UI - that stays
     browser-only, but its `kind` per field comes from here rather than being
     retyped. */
  var FIELD_KIND = {
    colorIdentity: "colors", colors: "colors", rarity: "enum", supertype: "enum", type: "enum",
    subtype: "text", set: "text", setName: "text", setType: "text", oracleTag: "text", name: "text",
    artist: "text", price: "number", cmc: "number", edhrecRank: "number", finish: "enum", language: "enum",
    location: "text", borderColor: "enum", promo: "bool", fullArt: "bool", reserved: "bool",
    profit: "profit"
  };
  function kindOf(key) { return FIELD_KIND[key] || "text"; }

  /* ---------- Profit vs cost (#375) ----------
     Bulk Price and Listings only. Profit per copy = the comparison price
     minus the stack's average cost per copy.

     The comparison price depends on the rule kind (owner, #375):
     - Listings rules (no opts): what the stack is listed at on Manapool
       (askPrice, the price last sent) while it is listed, else its market
       price. There the price is an input to the rule.
     - Bulk Price rules (opts.profitPrice "market"): always the market
       price. A price rule's own push moves askPrice, so judging against it
       made a "reprice the losers" rule stop matching after each push and
       the price flip back and forth night to night. Market price is what
       the rule reacts to and a push doesn't change it.

     null when either side is missing: no cost entered, or no price at all
     ($0.00 counts as no price, as it does everywhere else here). A stack
     with null never matches a rule that uses this condition - see
     matchesCriteria. `pct` is profit as a % of cost; a $0 cost with any
     gain is an unbounded % gain. */
  function profitInfo(card, opts) {
    var cq = Number(card && card.costQty) || 0;
    if (!(cq > 0)) return null;
    var cost = card.avgCost != null && card.avgCost !== "" ? Number(card.avgCost) : Number(card.costTotal) / cq;
    if (!isFinite(cost) || cost < 0) return null;
    var listed = !(opts && opts.profitPrice === "market") &&
      Number(card.listedQty) > 0 && card.askPrice != null && Number(card.askPrice) > 0;
    var cmp = listed ? Number(card.askPrice) : (card.price == null ? NaN : Number(card.price));
    if (!(cmp > 0)) return null;
    var profit = round2(cmp - cost);
    var pct = cost > 0 ? round2(profit / cost * 100) : (profit > 0 ? Infinity : profit < 0 ? -Infinity : 0);
    return { profit: profit, pct: pct, cost: cost, price: cmp, listed: listed };
  }
  /* Minimum profit (#390): the profit, as a % of cost (profitInfo's pct,
     before Manapool's fees), a listing must reach to stay up under Delist
     unprofitable, "Never list below my minimum profit" (Evaluate) and Bulk
     Price's takedowns, in the browser and the scheduled run alike. One number
     per account, settings.minProfitPct. With none stored (an empty or
     unreadable value counts as none), an account that already had the switch
     on stays at 0%, the rule it had before this setting existed; any other
     account gets 25%. So minProfitPct must never get a default merged in on
     load (core.js DEFAULT_SETTINGS), or the two can't be told apart. */
  var DEFAULT_MIN_PROFIT_PCT = 25;
  function readMinProfitPct(v) {
    if (v == null) return null;
    var t = typeof v === "number" ? null : String(v).replace(/[%\s]/g, "");
    var n = t == null ? v : t === "" ? NaN : Number(t);
    return isFinite(n) && n >= 0 ? n : null;
  }
  function minProfitPct(settings) {
    var s = settings || {};
    var stored = readMinProfitPct(s.minProfitPct);
    if (stored != null) return stored;
    return s.neverListAtLoss ? 0 : DEFAULT_MIN_PROFIT_PCT;
  }
  /* Is a profitInfo result under the minimum? A profit of 0 or less always
     is (break-even included, whatever the minimum), and so is a profit %
     under it; exactly at the minimum passes. A $0 cost with a price above 0
     passes (its % is unbounded). No info (no cost or no price) never is. */
  function underMinProfit(info, minPct) {
    if (!info) return false;
    var min = Number(minPct) > 0 ? Number(minPct) : 0;
    return info.profit <= 0 || info.pct < min;
  }
  /* Delist unprofitable and "Never list below my minimum profit" (#377,
     #378, #390), for the browser and the scheduled run alike: would selling
     this listing at `price` miss `minPct` (minProfitPct(settings); left out
     it is 0, i.e. at or below the average cost per copy)? It judges the
     stacks that are listed (what the price covers), or all of them if none
     are. Reuses the Profit vs cost maths. Null unless it would: a listing
     with no price, or with any judged stack that has no cost entered, is
     never touched. */
  function listingBelowCost(stacks, price, minPct) {
    if (!stacks || !stacks.length) return null;
    var up = stacks.filter(function (r) { return Number(r.listedQty) > 0; });
    var judged = up.length ? up : stacks;
    var costQty = 0, costTotal = 0;
    for (var i = 0; i < judged.length; i++) {
      var r = judged[i], cq = Number(r.costQty);
      if (!(cq > 0)) return null;
      costQty += cq;
      costTotal += r.avgCost != null && r.avgCost !== "" ? Number(r.avgCost) * cq : Number(r.costTotal);
    }
    var info = profitInfo({ costQty: costQty, costTotal: costTotal, price: price == null ? null : Number(price) }, { profitPrice: "market" });
    return underMinProfit(info, minPct) ? { cost: info.cost, price: info.price, profit: info.profit, pct: info.pct } : null;
  }
  /* The optional "by at least" margin of a profit condition: a plain
     positive number in the row's unit ($ per copy, or % of cost). Empty or
     unreadable is 0, i.e. plain profitable / unprofitable. */
  function profitMargin(rule) {
    var n = parseFloat(String(rule && rule.value != null ? rule.value : "").replace(/[$%,\s]/g, ""));
    return isFinite(n) ? Math.abs(n) : 0;
  }
  function matchProfit(info, rule) {
    if (!info) return false;   // no cost or no price: never matches, either way round
    var margin = profitMargin(rule);
    var amount = rule.unit === "pct" ? info.pct : info.profit;
    // Break-even is not profitable.
    if (rule.op === "unprofitable") return info.profit <= 0 && -amount >= margin;
    return info.profit > 0 && amount >= margin;
  }
  // Does any switched-on condition anywhere in this box use Profit vs cost?
  function usesProfit(criteria) {
    if (!criteria) return false;
    var conds = Array.isArray(criteria) ? criteria : (criteria.conditions || []);
    for (var i = 0; i < conds.length; i++) if (conds[i] && conds[i].on && conds[i].field === "profit") return true;
    var groups = Array.isArray(criteria) ? [] : (criteria.groups || []);
    for (var j = 0; j < groups.length; j++) if (usesProfit(groups[j])) return true;
    return false;
  }

  /* ---------- Matching ----------
     `opts` (optional, threaded through every matcher below) is
     { profitPrice: "market" } for Bulk Price rules; see profitInfo. */
  function ruleFieldValue(card, key, locName, opts) {
    var t = function () { return typeParts(card.typeLine); };
    switch (key) {
      case "colors": return normColors(card.colors);
      case "colorIdentity": return normColors(card.colorIdentity);
      case "rarity": return [String(card.rarity || "").toLowerCase()];
      case "supertype": return t().supertypes;
      case "type": return t().types;
      case "subtype": return t().subtypes;
      case "set": return [String(card.set || "").toLowerCase()];
      case "setName": return [String(card.setName || "").toLowerCase()];
      case "setType": return [String(card.setType || "").toLowerCase()];
      case "oracleTag": return (card.keywords || []).map(function (k) { return String(k).toLowerCase(); })
        .concat([String(card.oracle || "").toLowerCase()]);
      case "name": return [String(card.name || "").toLowerCase()];
      case "artist": return [String(card.artist || "").toLowerCase()];
      case "finish": return [card.finish || "nonfoil"];
      case "language": return [String(card.lang || "en").toLowerCase()];
      case "location": return [String(card.locationId && locName ? locName(card.locationId) : "").toLowerCase()];
      case "borderColor": return [String(card.borderColor || "").toLowerCase()];
      case "price": return card.price == null ? null : Number(card.price);
      case "cmc": return card.cmc == null ? null : Number(card.cmc);
      case "edhrecRank": return card.edhrecRank == null ? null : Number(card.edhrecRank);
      case "promo": return !!card.promo;
      case "fullArt": return !!card.fullArt;
      case "reserved": return !!card.reserved;
      case "profit": return profitInfo(card, opts);
      default: return [];
    }
  }

  function ruleValueList(rule) {
    if (Array.isArray(rule.value)) {
      return rule.value.map(function (v) { return String(v).trim().toLowerCase(); }).filter(Boolean);
    }
    return String(rule.value == null ? "" : rule.value)
      .split(",").map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
  }

  function matchRule(card, rule, locName, opts) {
    var kind = kindOf(rule.field);
    var cardVal = ruleFieldValue(card, rule.field, locName, opts);

    if (kind === "bool") return rule.op === "isTrue" ? !!cardVal : !cardVal;
    if (kind === "profit") return matchProfit(cardVal, rule);

    if (kind === "number") {
      if (cardVal == null) return false; // unknown never satisfies a numeric rule
      var nums = ruleValueList(rule).map(Number).filter(function (n) { return !isNaN(n); });
      if (!nums.length) return true; // an unfilled rule is not a filter
      if (rule.op === "gte") return cardVal >= nums[0];
      if (rule.op === "lte") return cardVal <= nums[0];
      if (rule.op === "eq") return cardVal === nums[0];
      if (rule.op === "between") {
        var lo = Math.min(nums[0], nums.length > 1 ? nums[1] : nums[0]);
        var hi = Math.max(nums[0], nums.length > 1 ? nums[1] : nums[0]);
        return cardVal >= lo && cardVal <= hi;
      }
      return true;
    }

    var want = kind === "colors"
      ? ruleValueList(rule).map(function (v) { return v.toUpperCase(); }).filter(function (v) { return COLOR_LETTERS.indexOf(v) >= 0; })
      : ruleValueList(rule);
    if (!want.length) return true; // an unfilled rule is not a filter
    var have = (Array.isArray(cardVal) ? cardVal : [cardVal])
      .map(function (v) { return kind === "colors" ? String(v).toUpperCase() : String(v).toLowerCase(); });

    switch (rule.op) {
      case "exactly": return have.length === want.length && want.every(function (v) { return have.indexOf(v) >= 0; });
      case "allOf": return want.every(function (v) { return have.indexOf(v) >= 0; });
      case "anyOf": return want.some(function (v) { return have.indexOf(v) >= 0; });
      case "noneOf": return !want.some(function (v) { return have.indexOf(v) >= 0; });
      case "is": return have.length === 1 && have[0] === want[0];
      case "isNot": return !(have.length === 1 && have[0] === want[0]);
      case "contains": return have.some(function (h) { return want.some(function (w) { return h.indexOf(w) >= 0; }); });
      case "notContains": return !have.some(function (h) { return want.some(function (w) { return h.indexOf(w) >= 0; }); });
      default: return true;
    }
  }

  /* ---------- Condition groups ----------
     `criteria` is a box, not a flat array: { combinator, not, conditions,
     groups }. `combinator` ("ALL"/"ANY") is AND/OR across every immediate
     child - plain `conditions` (field/op/value rows) plus nested `groups`
     (boxes of the same shape, normally one level deep - a group is just
     another child from its parent's point of view, evaluated by calling
     matchesCriteria on it recursively). `not` inverts the combined result of
     the box itself, so "(A OR B) AND NOT (C OR D)" is a top box with
     combinator "ALL" holding a plain condition A-or-B group and a `not`
     group for C-or-D. A box with no children at all is a catch-all (true) -
     same meaning group-less rules have always had. Legacy data (a bare
     array of conditions, from before this existed) is treated as
     combinator "ALL" with no groups, i.e. unchanged AND-everything behavior. */
  function normalizeCriteriaShape(criteria) {
    if (Array.isArray(criteria)) return { combinator: "ALL", not: false, conditions: criteria, groups: [] };
    var b = criteria || {};
    return {
      combinator: b.combinator === "ANY" ? "ANY" : "ALL",
      not: !!b.not,
      conditions: Array.isArray(b.conditions) ? b.conditions : [],
      groups: Array.isArray(b.groups) ? b.groups : []
    };
  }

  /* A stack with no cost (or no price) is left out of any box that uses
     Profit vs cost anywhere, NOT groups included: inverting "is
     unprofitable" must not sweep in every stack nobody entered a cost for
     (owner, #375). `opts`: see "Matching" above. */
  function matchesCriteria(card, criteria, locName, opts) {
    if (usesProfit(criteria) && !profitInfo(card, opts)) return false;
    return matchBox(card, criteria, locName, opts);
  }
  function matchBox(card, criteria, locName, opts) {
    var box = normalizeCriteriaShape(criteria);
    var conditions = box.conditions.filter(function (c) { return c.on; });
    var groups = box.groups;
    if (!conditions.length && !groups.length) return true;
    var results = conditions.map(function (c) { return matchRule(card, c, locName, opts); })
      .concat(groups.map(function (g) { return matchBox(card, g, locName, opts); }));
    var combined = box.combinator === "ANY" ? results.some(Boolean) : results.every(Boolean);
    return box.not ? !combined : combined;
  }

  /* Highest-priority enabled rule whose criteria all match; null if none do. */
  function ruleForRecord(record, rules, locName, opts) {
    var active = (rules || []).filter(function (r) { return r.on; }).slice()
      .sort(function (a, b) { return b.priority - a.priority || String(a.name).localeCompare(String(b.name)); });
    for (var i = 0; i < active.length; i++) {
      if (matchesCriteria(record, active[i].criteria, locName, opts)) return active[i];
    }
    return null;
  }

  /* ---------- Price targets ---------- */
  var PRICE_BASES = [
    { key: "market", label: "Scryfall market price" },
    { key: "mpLow", label: "Manapool — lowest listed price" },
    { key: "mpMarket", label: "Manapool — market price" },
    { key: "vTcg", label: "TCGplayer — today's price" },
    { key: "vCk", label: "Card Kingdom — today's price" },
    { key: "vMp", label: "Manapool — today's price (daily, no account needed)" },
    { key: "vHigh", label: "Highest of TCGplayer / Card Kingdom / Manapool today" },
    { key: "vLow", label: "Lowest of TCGplayer / Card Kingdom / Manapool today" }
  ];
  /* Vendor bases (BACKLOG #78b) read `record.vp` - {tcg, ck, mp}, USD, only
     the vendors that had a price - from the daily MTGJSON snapshot in
     prices.db (prices.vendorPricesFor). Cardmarket is EUR with no FX feed,
     so it is never a basis and never in highest/lowest; Cardsphere has no
     retail price in MTGJSON at all (0 rows ever in prices.db, 2026-10-08).
     vMp is MTGJSON's daily copy of Manapool's price - unlike mpLow/mpMarket
     it needs no connected Manapool account. */
  var VENDOR_BASIS = { vTcg: "tcg", vCk: "ck", vMp: "mp" };
  var VENDOR_CODES_USD = ["tcg", "ck", "mp"];
  function isVendorBasis(basis) { return !!VENDOR_BASIS[basis] || basis === "vHigh" || basis === "vLow"; }
  function vendorNumbers(vp) {
    var out = [];
    for (var i = 0; i < VENDOR_CODES_USD.length; i++) {
      var v = vp && vp[VENDOR_CODES_USD[i]];
      if (v != null && isFinite(Number(v)) && Number(v) > 0) out.push(Number(v));
    }
    return out;
  }
  function basisValue(record, basis) {
    if (basis === "mpLow") return record.mpLow == null ? null : Number(record.mpLow);
    if (basis === "mpMarket") return record.mpMarket == null ? null : Number(record.mpMarket);
    if (VENDOR_BASIS[basis]) {
      var v = record.vp && record.vp[VENDOR_BASIS[basis]];
      return v == null ? null : Number(v);
    }
    if (basis === "vHigh" || basis === "vLow") {
      var nums = vendorNumbers(record.vp);
      if (!nums.length) return null;
      return basis === "vHigh" ? Math.max.apply(null, nums) : Math.min.apply(null, nums);
    }
    return record.price == null ? null : Number(record.price);
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /* null return means "do not touch this stack's price" - no rule claims it,
     an exclude rule claims it, or a percent/delta rule has no base price to
     work from. Deliberately no fallback to a collection-wide default: a rule
     INCLUDES specific stacks into a sweep, and a stack nothing names is left
     alone - what makes it safe to run this unattended.

     A price that works out to $0.00 or less is null too (#98). Manapool
     can't be sent a zero price: mpBuildItem sends price_cents: null, which
     leaves the old live price in place, so a "$0.00" ask used to be stored,
     pushed as "no price" and reported as done while nothing changed.
     zeroTarget() tells that case apart from "no base price" for the plan. */
  function rawRuleTarget(rule, basisVal) {
    if (!rule || rule.mode === "exclude") return null;
    if (rule.mode === "fixed") return rule.fixed == null ? null : Number(rule.fixed);
    if (basisVal == null) return null;
    if (rule.mode === "delta") return round2(basisVal + Number(rule.delta || 0));
    return round2(basisVal * Number(rule.percent == null ? 1 : rule.percent));
  }
  function priceRuleTarget(rule, basisVal) {
    var t = rawRuleTarget(rule, basisVal);
    return t == null || !(round2(t) > 0) ? null : t;
  }
  // True when a rule did compute a price, but it came out at $0.00 or less.
  function zeroTarget(rule, basisVal) {
    var t = rawRuleTarget(rule, basisVal);
    return t != null && !(round2(t) > 0);
  }

  /* ---------- Manapool identity grouping ----------
     Manapool identifies a listing by (scryfall_id, language, finish,
     condition), no storage location, and its write endpoint SETS quantity
     rather than adding to it - a push has to send the correct summed
     quantity across every local row sharing an identity, not just one. */
  function manapoolIdentityKey(r) {
    return [r.scryfallId, String(r.lang || "en").toLowerCase(), r.finish || "nonfoil", r.condition || "NM"].join("|");
  }

  /* ---------- One live ask per Manapool listing (#228) ----------
     A listing's ask is never stored: it is worked out from the price rules
     and the latest prices every time something needs it (Listings, Bulk
     Price, a push, the scheduled run), so it follows the nightly market
     refresh by itself and every stack of one listing always gets the same
     number. A stored askPrice is only "the price last sent to Manapool".

     Which stacks speak for the listing: the listed ones; with none listed
     yet, the ones in a location with "Sell from" on (where a Listings push
     would list from); else all of them.

     Which rule prices it: each of those stacks finds its own
     highest-priority matching rule, as before. A stack whose own rule is
     an exclude drops out, and a stack no rule names counts for nothing,
     so a scoped rule or an exclude on one bin still prices the listing
     from the other bin (#87). Of the rules left, the highest-priority one
     prices the whole listing. Only when every stack is excluded is the
     listing excluded.

     `rules` must be the enabled rules already in competing order (highest
     priority first): sorted once per pass, not per listing.
     opts: { locName(id), sellFrom(id) -> bool, conditionPricing }. */
  var DEFAULT_CONDITION_PRICING = { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 };

  // Price rules judge Profit vs cost against market price, never the ask
  // they set themselves (#375; see profitInfo).
  var PRICE_RULE_MATCH = { profitPrice: "market" };

  function listingRule(stacks, rules, opts) {
    var o = opts || {};
    var pool = stacks.filter(function (s) { return Number(s.listedQty) > 0; });
    if (!pool.length && o.sellFrom) pool = stacks.filter(function (s) { return o.sellFrom(s.locationId); });
    if (!pool.length) pool = stacks.slice();
    var best = rules.length, claimed = [], excluded = false;
    for (var k = 0; k < pool.length; k++) {
      // A stack's own rule is its first match. Rules ranked below the
      // current winner can't change the outcome, so stop there.
      for (var i = 0; i < rules.length && i <= best; i++) {
        if (!matchesCriteria(pool[k], rules[i].criteria, o.locName, PRICE_RULE_MATCH)) continue;
        if (rules[i].mode === "exclude") excluded = true;
        else if (i < best) { best = i; claimed = [pool[k]]; }
        else claimed.push(pool[k]);
        break;
      }
    }
    var rule = best < rules.length ? rules[best] : null;
    return { rule: rule, claimed: claimed, pool: pool, excluded: !rule && excluded };
  }

  function firstNumber(list, fn) {
    for (var i = 0; i < list.length; i++) {
      var v = fn(list[i]);
      if (v != null && isFinite(v)) return Number(v);
    }
    return null;
  }

  /* The ask for one listing, from a listingRule() pick. `target` is the
     rule's own price (null: no rule, excluded, $0.00 or no base price).
     `ask` is what every screen shows and every push sends: the rule's
     price, else - no rule names the listing, or its rule is an exclude,
     works out to $0.00 or has no base price (owner, #228) - the market
     price x condition % (Listings' Rules tab). `fallback` is true when the
     ask is that market x % number. null = no market price either: nothing
     to send, as before. */
  function listingAskFromRule(pick, opts) {
    var o = opts || {};
    var rule = pick.rule;
    var from = pick.claimed.length ? pick.claimed : pick.pool;
    var record = from[0] || null;
    var price = function (s) { return s.price == null ? null : Number(s.price); };
    var market = firstNumber(from, price);
    if (market == null) market = firstNumber(pick.pool, price);
    var basisVal = rule ? firstNumber(pick.claimed, function (s) { return basisValue(s, rule.basis); }) : market;
    var target = rule ? priceRuleTarget(rule, basisVal) : null;
    var zero = rule ? zeroTarget(rule, basisVal) : false;
    var pricing = o.conditionPricing || DEFAULT_CONDITION_PRICING;
    var mult = record ? pricing[record.condition || "NM"] : null;
    var marketAsk = market == null ? null : round2(market * (mult == null ? 1 : Number(mult)));
    if (!(marketAsk > 0)) marketAsk = null;   // $0.00 is no price - Manapool can't take one
    return {
      ask: target != null ? target : marketAsk, fallback: target == null && marketAsk != null,
      target: target, marketAsk: marketAsk,
      rule: rule, record: record, market: market, basisVal: basisVal,
      excluded: pick.excluded, zero: zero, noBasis: !!rule && target == null && !zero
    };
  }

  function listingAsk(stacks, rules, opts) {
    return listingAskFromRule(listingRule(stacks, rules, opts), opts);
  }

  return {
    SUPERTYPES: SUPERTYPES, typeParts: typeParts,
    COLOR_LETTERS: COLOR_LETTERS, normColors: normColors,
    FIELD_KIND: FIELD_KIND, kindOf: kindOf,
    ruleFieldValue: ruleFieldValue, ruleValueList: ruleValueList, matchRule: matchRule,
    profitInfo: profitInfo, listingBelowCost: listingBelowCost,
    DEFAULT_MIN_PROFIT_PCT: DEFAULT_MIN_PROFIT_PCT, readMinProfitPct: readMinProfitPct, minProfitPct: minProfitPct, underMinProfit: underMinProfit,
    profitMargin: profitMargin, usesProfit: usesProfit, PRICE_RULE_MATCH: PRICE_RULE_MATCH,
    normalizeCriteriaShape: normalizeCriteriaShape, matchesCriteria: matchesCriteria, ruleForRecord: ruleForRecord,
    PRICE_BASES: PRICE_BASES, basisValue: basisValue, priceRuleTarget: priceRuleTarget, zeroTarget: zeroTarget, isVendorBasis: isVendorBasis,
    manapoolIdentityKey: manapoolIdentityKey,
    DEFAULT_CONDITION_PRICING: DEFAULT_CONDITION_PRICING,
    listingRule: listingRule, listingAskFromRule: listingAskFromRule, listingAsk: listingAsk
  };
});
