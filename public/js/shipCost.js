"use strict";
/* Packaging + postage cost of one shipped order (#457, part 1: the engine).
   ---------------------------------------------------------------
   One copy, shared like priceRuleEngine.js: a plain <script> global
   (window.ShipCost) for Settings → Shipping and the desk's order views, and
   require()'d by the server when a ticket ships and by the one-time backfill.
   Pure functions only: no DOM, no state, no filesystem.

   The seller's setup (per account, Settings → Shipping):
   - supplies: { id, name, cost (each, $), oz (each) }
   - rules, in order; the first one that fits the order wins:
       { id, name, kind: "letter" | "mailer" | "box",
         upToCards: N | null, upToValue: $ | null,   // a break; both set = both must hold
         items: [{ supply, per: "order" | "card" | "every", every: N, qty: N }],
         nonmachinable: $ (letters only; a rigid/lumpy letter's surcharge) }
     per "order" = qty once; "card" = qty per card; "every" = qty per N cards
     or part (one toploader per 4 cards → per "every", every 4).
   - postage: { stamp, extraOunce, letterMaxOz, bands: [{ upToOz, price }] }
     A letter pays one stamp plus an extra-ounce stamp for each ounce (or
     part) over 1 oz; a letter heavier than letterMaxOz can't go as a letter,
     so the next rule is tried. Tracked parcels pay the seller's own price for
     the first weight band they fit (upToOz null = anything heavier).
   An order that must be tracked (Manapool's ground_advantage) skips letter
   rules. Nothing fits → the last rule that can carry it, flagged `fallback`. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.ShipCost = factory();
})(typeof self !== "undefined" ? self : this, function () {

  var KINDS = ["letter", "mailer", "box"];
  var PER = ["order", "card", "every"];

  /* Starting values a seller edits to their own. Weights: card, toploader,
     envelope and packing slip are the ones Weigh & Manifest already used
     (core.js SHIP_WEIGHTS); the rest are typical. Costs are rough bulk prices.
     Postage: USPS from 2026-07-12 (Forever stamp $0.82, extra ounce $0.29,
     letters up to 3.5 oz); the tracked bands are an example to replace. */
  var DEFAULTS = {
    cardOz: 0.06,
    supplies: [
      { id: "envelope", name: "#10 envelope", cost: 0.05, oz: 0.2 },
      { id: "sleeve", name: "Penny sleeve", cost: 0.01, oz: 0.02 },
      { id: "toploader", name: "Toploader", cost: 0.10, oz: 0.24 },
      { id: "semirigid", name: "Semi-rigid card saver", cost: 0.15, oz: 0.3 },
      { id: "teambag", name: "Team bag", cost: 0.03, oz: 0.05 },
      { id: "onetouch", name: "Magnetic one-touch", cost: 1.00, oz: 1.0 },
      { id: "stiffener", name: "Cardboard stiffener", cost: 0.02, oz: 0.2 },
      { id: "tape", name: "Painter's tape", cost: 0.01, oz: 0 },
      { id: "slip", name: "Packing slip", cost: 0.01, oz: 0.17 },
      { id: "label", name: "Shipping label", cost: 0.03, oz: 0.05 },
      { id: "mailer4x8", name: "Bubble mailer 4×8", cost: 0.25, oz: 0.4 },
      { id: "mailer6x9", name: "Bubble mailer 6×9", cost: 0.30, oz: 0.6 },
      { id: "box", name: "Small box", cost: 0.75, oz: 3.0 },
      { id: "bubblewrap", name: "Bubble wrap", cost: 0.10, oz: 0.2 },
      { id: "cardbox", name: "Card box", cost: 0.40, oz: 1.5 }
    ],
    rules: [
      { id: "letter", name: "Letter", kind: "letter", upToCards: 8, upToValue: 50, nonmachinable: 0,
        items: [{ supply: "envelope", per: "order", qty: 1 }, { supply: "slip", per: "order", qty: 1 },
                { supply: "tape", per: "order", qty: 1 }, { supply: "sleeve", per: "card", qty: 1 },
                { supply: "toploader", per: "every", every: 4, qty: 1 }, { supply: "teambag", per: "every", every: 4, qty: 1 }] },
      { id: "mailer-small", name: "Small bubble mailer", kind: "mailer", upToCards: 25, upToValue: null,
        items: [{ supply: "mailer4x8", per: "order", qty: 1 }, { supply: "slip", per: "order", qty: 1 },
                { supply: "label", per: "order", qty: 1 }, { supply: "sleeve", per: "card", qty: 1 },
                { supply: "toploader", per: "every", every: 4, qty: 1 }, { supply: "teambag", per: "every", every: 4, qty: 1 }] },
      { id: "mailer-large", name: "Large bubble mailer", kind: "mailer", upToCards: 60, upToValue: null,
        items: [{ supply: "mailer6x9", per: "order", qty: 1 }, { supply: "slip", per: "order", qty: 1 },
                { supply: "label", per: "order", qty: 1 }, { supply: "sleeve", per: "card", qty: 1 },
                { supply: "toploader", per: "every", every: 4, qty: 1 }, { supply: "teambag", per: "every", every: 4, qty: 1 }] },
      { id: "box", name: "Box", kind: "box", upToCards: null, upToValue: null,
        items: [{ supply: "box", per: "order", qty: 1 }, { supply: "bubblewrap", per: "order", qty: 1 },
                { supply: "cardbox", per: "order", qty: 1 }, { supply: "slip", per: "order", qty: 1 },
                { supply: "label", per: "order", qty: 1 }, { supply: "sleeve", per: "card", qty: 1 }] }
    ],
    postage: {
      stamp: 0.82, extraOunce: 0.29, letterMaxOz: 3.5,
      bands: [{ upToOz: 4, price: 4.10 }, { upToOz: 8, price: 4.80 }, { upToOz: 12, price: 5.40 },
              { upToOz: 16, price: 5.90 }, { upToOz: null, price: 7.50 }]
    }
  };

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var num = function (v, d) { var n = Number(v); return isFinite(n) && n >= 0 ? n : d; };
  var limit = function (v) { return v == null || v === "" ? null : num(v, null); };
  var cents = function (n) { return Math.round(n * 100) / 100; };
  var ozRound = function (n) { return Math.round(n * 100) / 100; };

  /* A stored setup → a clean one: missing parts take the defaults, numbers
     are numbers, unknown kinds/per values fall back, bands sorted by weight. */
  function normalize(cfg) {
    var c = cfg && typeof cfg === "object" ? cfg : {};
    var d = clone(DEFAULTS);
    var out = { cardOz: num(c.cardOz, d.cardOz) };
    out.supplies = (Array.isArray(c.supplies) ? c.supplies : d.supplies).filter(function (s) { return s && s.id; }).map(function (s) {
      return { id: String(s.id), name: String(s.name || s.id), cost: num(s.cost, 0), oz: num(s.oz, 0) };
    });
    out.rules = (Array.isArray(c.rules) ? c.rules : d.rules).filter(function (r) { return r && r.id; }).map(function (r) {
      return {
        id: String(r.id), name: String(r.name || r.id),
        kind: KINDS.indexOf(r.kind) >= 0 ? r.kind : "mailer",
        upToCards: limit(r.upToCards), upToValue: limit(r.upToValue),
        nonmachinable: num(r.nonmachinable, 0), off: !!r.off,
        items: (Array.isArray(r.items) ? r.items : []).filter(function (i) { return i && i.supply; }).map(function (i) {
          return { supply: String(i.supply), per: PER.indexOf(i.per) >= 0 ? i.per : "order",
                   every: Math.max(1, Math.floor(num(i.every, 1)) || 1), qty: num(i.qty, 1) };
        })
      };
    });
    var p = c.postage && typeof c.postage === "object" ? c.postage : {};
    out.postage = {
      stamp: num(p.stamp, d.postage.stamp), extraOunce: num(p.extraOunce, d.postage.extraOunce),
      letterMaxOz: num(p.letterMaxOz, d.postage.letterMaxOz),
      bands: (Array.isArray(p.bands) ? p.bands : d.postage.bands).map(function (b) {
        return { upToOz: limit(b && b.upToOz), price: num(b && b.price, 0) };
      }).sort(function (a, b) {
        return (a.upToOz == null ? Infinity : a.upToOz) - (b.upToOz == null ? Infinity : b.upToOz);
      })
    };
    return out;
  }

  // How many of one supply a rule uses for an order of `cards` cards.
  function itemQty(item, cards) {
    var q = item.qty == null ? 1 : item.qty;
    if (item.per === "card") return q * cards;
    if (item.per === "every") return cards > 0 ? q * Math.ceil(cards / (item.every || 1)) : 0;
    return q;
  }

  // Supplies cost and package weight for one rule (cards included in the weight).
  function packOf(rule, cards, cfg) {
    var byId = {};
    cfg.supplies.forEach(function (s) { byId[s.id] = s; });
    var cost = 0, oz = cards * cfg.cardOz, lines = [];
    rule.items.forEach(function (i) {
      var s = byId[i.supply];
      if (!s) return;   // a supply deleted after the rule was made counts as nothing
      var q = itemQty(i, cards);
      if (!q) return;
      cost += q * s.cost;
      oz += q * s.oz;
      lines.push({ supply: s.id, name: s.name, qty: q, cost: cents(q * s.cost) });
    });
    return { cost: cents(cost), oz: ozRound(oz), lines: lines };
  }

  // A letter's postage: one stamp + an extra-ounce stamp per ounce (or part) over 1 oz.
  function letterPostage(oz, postage) {
    var extra = Math.max(0, Math.ceil(oz - 1 - 1e-9));
    return { extraOunces: extra, cost: cents(postage.stamp + extra * postage.extraOunce) };
  }

  // A tracked parcel's postage: the first band the weight fits; past the last band, the last price.
  function bandPostage(oz, bands) {
    if (!bands.length) return { band: null, cost: 0 };
    for (var i = 0; i < bands.length; i++) {
      if (bands[i].upToOz == null || oz <= bands[i].upToOz + 1e-9) return { band: bands[i], cost: cents(bands[i].price) };
    }
    var last = bands[bands.length - 1];
    return { band: last, cost: cents(last.price) };
  }

  // Does a Manapool shipping method need a tracked parcel? (first_class = a plain letter is fine)
  function isTracked(method) {
    return /ground|priority|express|tracked/i.test(String(method || ""));
  }

  var fits = function (rule, cards, value) {
    return (rule.upToCards == null || cards <= rule.upToCards) && (rule.upToValue == null || value <= rule.upToValue + 1e-9);
  };

  // Price one rule for one order, or null when this rule can't carry it (a too-heavy letter).
  function priceRule(rule, cards, cfg) {
    var pack = packOf(rule, cards, cfg);
    var post;
    if (rule.kind === "letter") {
      if (pack.oz > cfg.postage.letterMaxOz + 1e-9) return null;
      var l = letterPostage(pack.oz, cfg.postage);
      post = { cost: cents(l.cost + rule.nonmachinable), extraOunces: l.extraOunces };
    } else {
      var b = bandPostage(pack.oz, cfg.postage.bands);
      post = { cost: b.cost, bandUpToOz: b.band ? b.band.upToOz : null };
    }
    return {
      rule: rule.id, ruleName: rule.name, kind: rule.kind,
      oz: pack.oz, supplies: pack.cost, postage: post.cost, total: cents(pack.cost + post.cost),
      extraOunces: post.extraOunces || 0, bandUpToOz: post.bandUpToOz == null ? null : post.bandUpToOz,
      lines: pack.lines
    };
  }

  /* The cost of shipping one order: { cards, value, tracked } →
     { rule, ruleName, kind, oz, supplies, postage, total, extraOunces,
       bandUpToOz, lines, fallback } or null when no rule could carry it
     (no rules at all, or only letters for a tracked order). */
  function costOrder(order, cfgIn) {
    var cfg = normalize(cfgIn);
    var cards = Math.max(0, Math.floor(num(order && order.cards, 0)));
    var value = num(order && order.value, 0);
    var tracked = !!(order && order.tracked);
    var usable = cfg.rules.filter(function (r) { return !r.off && !(tracked && r.kind === "letter"); });
    for (var i = 0; i < usable.length; i++) {
      if (!fits(usable[i], cards, value)) continue;
      var got = priceRule(usable[i], cards, cfg);
      if (got) { got.fallback = false; return got; }
    }
    // Past every break: the last rule that can physically carry it.
    for (var j = usable.length - 1; j >= 0; j--) {
      var fb = priceRule(usable[j], cards, cfg);
      if (fb) { fb.fallback = true; return fb; }
    }
    return null;
  }

  /* ---------- On a sale (part 3) ----------
     A completed sale → the order it shipped: copies actually pulled (each
     line's pickedResult; its qty when it has none) and the goods' value
     (revenue less the shipping the buyer paid). `tracked` comes from the
     caller's own rule (core.js / integrations.js orderNeedsTracking). */
  function saleOrder(p, tracked) {
    var cards = 0;
    (p && Array.isArray(p.lines) ? p.lines : []).forEach(function (l) {
      if (l && l.pickedResult && Array.isArray(l.pickedResult.pulls)) {
        l.pickedResult.pulls.forEach(function (pu) { cards += Number(pu && pu.qty) || 0; });
      } else cards += Number(l && l.qty) || 0;
    });
    var value = Math.max(0, (Number(p && p.revenue) || 0) - (Number(p && p.shippingRevenue) || 0));
    return { cards: cards, value: cents(value), tracked: !!tracked };
  }
  // What a sale keeps (p.shipCost): the totals and the rule used, not each supply.
  function freeze(r, at) {
    if (!r) return null;
    return { total: r.total, supplies: r.supplies, postage: r.postage, oz: r.oz, rule: r.rule, ruleName: r.ruleName,
             kind: r.kind, extraOunces: r.extraOunces, fallback: r.fallback, at: at || new Date().toISOString() };
  }
  // A sale's frozen cost, worked out once: null for an order with no copies or no rule that carries it.
  function costSale(p, tracked, cfg, at) {
    var o = saleOrder(p, tracked);
    return o.cards > 0 ? freeze(costOrder(o, cfg), at) : null;
  }
  /* A completed Manapool order's sale that has never had its cost worked out
     (completion sets p.shipCost, null included, so a key that's missing
     means a sale from before #457). pickedAt is what makes it a sale. */
  function needsShipCost(p) {
    return !!(p && p.source === "manapool" && p.orderId && p.pickedAt &&
      (p.status === "picked" || p.status === "shipped") && p.shipCost === undefined);
  }

  return {
    DEFAULTS: DEFAULTS, defaults: function () { return clone(DEFAULTS); },
    normalize: normalize, costOrder: costOrder, isTracked: isTracked,
    saleOrder: saleOrder, freeze: freeze, costSale: costSale, needsShipCost: needsShipCost,
    itemQty: itemQty, packOf: packOf, letterPostage: letterPostage, bandPostage: bandPostage
  };
});
