"use strict";
/* Bulk price rule engine - server side.
   ---------------------------------------------------------------
   The browser's rule builder and Evaluate/Apply/Push buttons on
   /inventory/bulk-price run the same matching + pricing math, from
   public/js/priceRuleEngine.js - a plain, DOM-free module required here
   directly and loaded as a <script> in the browser, so there is exactly one
   copy of this logic rather than two hand-kept-in-sync ones.

   Card metadata needed to match a rule (colors, rarity, type line, ...)
   already lives on every inventory row - refreshPrices (or Receive) put it
   there. `price` (Scryfall's market price) is refreshed straight out of the
   in-memory card index the same way prices.js's nightly snapshot does, zero
   network cost. A rule targeting a Manapool basis (mpLow/mpMarket) instead
   needs a live, per-account lookup - see integrations.manapoolPrices - so
   that only happens for the specific printings a matched rule actually
   needs it for, not the whole collection, and only once this user has
   connected a Manapool account. */

const store = require("./store");
const cards = require("./cards");
const integrations = require("./integrations");
const mpAuth = require("./mpAuth");
const prices = require("./prices");
const engine = require("../../public/js/priceRuleEngine.js");
const { matchesCriteria, ruleForRecord, basisValue, priceRuleTarget, manapoolIdentityKey, isVendorBasis, listingRule, listingAskFromRule } = engine;

let logger = m => console.log("[priceRules] " + m);
function init(opts) { if (opts && opts.log) logger = opts.log; }

// Profit vs cost on a price rule is judged against market price (#375).
function matchesPriceRule(record, rule, locName) { return matchesCriteria(record, rule.criteria, locName, engine.PRICE_RULE_MATCH); }

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// The most listings under the minimum profit one scheduled run takes down, per user (owner,
// #378). The rest stay listed and untouched for the next run. Manual Push and
// Delist unprofitable aren't limited. The help and warning texts name this number.
const MAX_SCHEDULED_DELISTS = 50;

/* ============================== One collection's scheduled run ==============================
   ownerKey is either a bare user id (a personal account's own collection,
   today's exact behavior) or "store:<id>" (a Store under an Organization -
   BACKLOG.md #9); label is just what shows up in log lines. Credentials
   (store.readPrefs(ownerKey).manapool below) are looked up the same
   generalized way - a Store has no Manapool credentials of its own yet
   (that's still-open future scope, not this stage), so mpConnected simply
   stays false for one today and the push step no-ops, same as any
   personal account that's never connected Manapool. */
async function runForUser(ownerKey, label) {
  const doc = await store.readCollection(ownerKey);
  const state = doc.state;
  if (!state || !Array.isArray(state.cards) || !state.cards.length) {
    return { ok: true, considered: 0, changed: 0, pushed: 0, pushFailed: 0, skipped: "empty collection" };
  }
  const allRules = Array.isArray(state.priceRules) ? state.priceRules : [];
  const schedule = (state.settings && state.settings.bulkPriceSchedule) || {};

  // An empty/missing ruleId means "every active rule" (the original,
  // priority-ordered behavior); a set ruleId narrows the run to the listings
  // that one rule prices (#228: it no longer prices a listing a
  // higher-priority rule owns), so a schedule can't silently start acting on
  // some other rule someone added later. That rule still has to be switched
  // on itself - the schedule doesn't override its toggle.
  let rules = allRules;
  if (schedule.ruleId) {
    const picked = allRules.find(r => r.id === schedule.ruleId);
    if (!picked) {
      return { ok: true, considered: 0, changed: 0, pushed: 0, pushFailed: 0, skipped: "the scheduled rule no longer exists" };
    }
    rules = [picked];
  }
  if (!rules.some(r => r.on)) {
    return { ok: true, considered: 0, changed: 0, pushed: 0, pushFailed: 0,
      skipped: schedule.ruleId ? "the scheduled rule is turned off" : "no active price rules" };
  }

  const locations = Array.isArray(state.locations) ? state.locations : [];
  const locById = new Map(locations.map(l => [l.id, l]));
  const locName = id => { const l = locById.get(id); return l ? l.name : ""; };
  const sellFrom = id => { const l = locById.get(id); return !!(l && l.sellFrom); };
  const askOpts = { locName, sellFrom,
    conditionPricing: (state.settings && state.settings.conditionPricing) || engine.DEFAULT_CONDITION_PRICING };
  const prefs = await store.readPrefs(ownerKey);
  const creds = mpAuth.credsFromPrefs(ownerKey, prefs);
  const mpConnected = integrations.manapoolEnabled() && mpAuth.usable(creds);

  // #228: a listing's ask is worked out live, the same way every screen does
  // it (priceRuleEngine.js listingAsk): every enabled rule competes, sorted
  // once here, not per listing. A scheduled ruleId then only narrows WHICH
  // listings this run pushes - the ones that rule prices - so the schedule
  // can never send a different price than Listings and Bulk Price show.
  const active = allRules.filter(r => r.on).slice()
    .sort((a, b) => b.priority - a.priority || String(a.name).localeCompare(String(b.name)));

  // Pass 1: which listings are in play. Only listings with a listed stack -
  // repricing stock that isn't for sale has no effect anywhere (mirrors
  // core.js's bulkPricePlan). The listed stacks' market price is refreshed
  // from the local card index (free - same source as the nightly snapshot).
  // Then each listing's rule is picked from what lives on its stacks, before
  // spending a single Manapool request on any of them. One pass to find the
  // listed listings, one to group their stacks: no per-listing scans.
  const listedKeys = new Set();
  for (const r of state.cards) {
    if (!(Number(r.listedQty) > 0) || !r.scryfallId) continue;
    if (cards.ready) {
      const p = cards.priceFor(r.set, r.collector, r.lang, r.finish);
      if (p != null) r.price = p;
    }
    listedKeys.add(manapoolIdentityKey(r));
  }
  const groups = new Map();   // identity key -> every stack of that listing
  for (const r of state.cards) {
    if (!r.scryfallId) continue;
    const key = manapoolIdentityKey(r);
    if (!listedKeys.has(key)) continue;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  const claimed = [];   // [{key, stacks, pick}] for listings a rule prices
  for (const [key, stacks] of groups) {
    const pick = listingRule(stacks, active, askOpts);
    // No rule, or excluded: no rule prices it, so the schedule leaves the
    // listing alone - the same as a listing no rule names. (Its ask, for
    // a manual push, is market x condition %.)
    if (!pick.rule) continue;
    if (schedule.ruleId && pick.rule.id !== schedule.ruleId) continue;
    claimed.push({ key, stacks, pick });
  }
  const basedOn = pred => {
    const out = [];
    for (const c of claimed) {
      const rule = c.pick.rule;
      if ((rule.mode === "percent" || rule.mode === "delta") && pred(rule.basis)) out.push(...c.pick.claimed);
    }
    return out;
  };

  // Pass 1b: vendor bases (TCGplayer/Card Kingdom/Manapool, BACKLOG #78b)
  // come from the local price archive - no network, no account needed - and
  // only for stacks a vendor-based rule prices. Written onto the row (r.vp)
  // so the screens show the same basis the run actually used.
  const vendorRows = basedOn(isVendorBasis);
  if (vendorRows.length) {
    try {
      const vps = prices.vendorPricesFor(vendorRows);
      vendorRows.forEach((r, i) => { r.vp = vps[i]; });
    } catch (e) { logger("vendor price lookup failed for " + label + ": " + e.message); }
  }

  // Pass 2: a live, per-account Manapool lookup, but ONLY for the printings
  // a rule actually bases its price on - not the whole collection, and not
  // at all if this account has no Manapool connection (those rows' basis
  // value is simply null, so the rule gives no price and the listing's ask
  // is market x condition %, #228).
  if (mpConnected) {
    const mpRows = basedOn(b => b === "mpLow" || b === "mpMarket");
    const needed = [...new Set(mpRows.map(r => r.scryfallId))];
    if (needed.length) {
      try {
        const priced = await integrations.manapoolPrices(creds, needed);
        for (const r of mpRows) {
          const mp = priced.get(r.scryfallId);
          if (!mp) continue;
          const isNm = (r.condition || "NM") === "NM";
          // Manapool has no separate etched price tier - foil is the
          // closest real comp (same gap public/js/core.js's refreshPrices
          // works around).
          const useFoilBasis = r.finish === "foil" || r.finish === "etched";
          r.mpLow = useFoilBasis ? (isNm ? (mp.nmFoil != null ? mp.nmFoil : mp.lpPlusFoil) : (mp.lpPlusFoil != null ? mp.lpPlusFoil : mp.nmFoil))
            : (isNm ? (mp.nm != null ? mp.nm : mp.lpPlus) : (mp.lpPlus != null ? mp.lpPlus : mp.nm));
          r.mpMarket = useFoilBasis ? mp.marketFoil : mp.market;
        }
      } catch (e) { logger("Manapool price lookup failed for " + label + ": " + e.message); }
    }
  }

  // "Never list below my minimum profit" (#377, #378, #390): a listing whose
  // ask misses the account's minimum profit over its cost is taken down rather
  // than repriced. Same rule and same minimum as the browser's plan
  // (priceRuleEngine.js minProfitPct + listingBelowCost), read off the raw
  // settings so "none stored" is still told apart.
  const noLoss = !!(state.settings && state.settings.neverListAtLoss);
  const minPct = engine.minProfitPct(state.settings);
  let belowCost = 0;
  let considered = 0, changed = 0, fallback = 0, noPrice = 0;
  const matched = [];   // [{key, stacks, sample, target, rule, fallback}] - listings with a price, candidates for the push
  for (const c of claimed) {
    considered++;
    // The listing's shared ask - the same number Listings and Bulk Price
    // show. A rule that gives no price ($0.00, or no base price) means
    // market x condition % (owner, #228); a $0.00 is still never sent (#98).
    const info = listingAskFromRule(c.pick, askOpts);
    if (info.ask == null) { noPrice++; continue; }   // no market price either: nothing to send
    if (info.fallback) fallback++;
    const target = round2(info.ask);
    const below = noLoss ? engine.listingBelowCost(c.stacks, target, minPct) : null;
    if (below) belowCost++;
    // "Changed" = Manapool last got a different price for this listing.
    else if (c.pick.pool.some(r => r.askPrice == null || Math.abs(Number(r.askPrice) - target) >= 0.005)) changed++;
    matched.push({ key: c.key, stacks: c.stacks, sample: c.pick.pool[0], target, rule: c.pick.rule, fallback: info.fallback, below });
  }

  // Record a confirmed push as every stack's "last sent to Manapool" price,
  // one audit line per listing whose number moved.
  let recorded = 0;
  const recordSent = m => {
    let logged = false;
    for (const r of m.stacks) {
      if (r.askPrice != null && Math.abs(Number(r.askPrice) - m.target) < 0.005) continue;
      if (!logged) {
        logged = true;
        state.audit = Array.isArray(state.audit) ? state.audit : [];
        state.audit.unshift({
          id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          ts: new Date().toISOString(), action: "price",
          name: r.name || "", set: r.set || "", collector: r.collector || "", lang: r.lang || "",
          finish: r.finish || "nonfoil", condition: r.condition || "", qty: 0, oldQty: null, newQty: null,
          from: "", to: "", note: "Scheduled price push: rule \"" + m.rule.name + "\"" +
            (m.fallback ? " (no price from the rule: market x condition %)" : "") + " — " +
            (r.askPrice == null ? "unset" : "$" + Number(r.askPrice).toFixed(2)) + " → $" + m.target.toFixed(2),
          cost: null, receiptId: ""
        });
      }
      r.askPrice = m.target;
      recorded++;
    }
  };

  // A confirmed scheduled delist: every stack of the listing is unlisted, with
  // one audit and log line for the listing. askPrice stays the last price
  // Manapool really got.
  let delisted = 0, delistFailed = 0, delistLeft = 0;
  const recordDelist = m => {
    const note = "Scheduled run: delisted " + (m.sample.name || m.key) + ", ask $" + m.target.toFixed(2) +
      ", cost $" + m.below.cost.toFixed(2) + ", under the minimum profit of " + minPct + "%";
    logger(label + ": " + note);
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    const r = m.sample;
    state.audit.unshift({
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(), action: "list",
      name: r.name || "", set: r.set || "", collector: r.collector || "", lang: r.lang || "",
      finish: r.finish || "nonfoil", condition: r.condition || "", qty: 0, oldQty: null, newQty: null,
      from: "", to: "", note, cost: null, receiptId: ""
    });
    for (const s of m.stacks) if (Number(s.listedQty) > 0) s.listedQty = 0;
    delisted++;
  };

  // Nothing goes to Manapool unless the owner turned Auto-push on: asks are
  // live, so without it the run only reports how many listings changed (and
  // how many are below cost: it never delists).
  let pushed = 0, pushFailed = 0, pushSkipped = 0;
  if (schedule.autoPush && matched.length && mpConnected) {
    // Manapool's write endpoint sets quantity alongside the price, so the
    // push has to send one - and the local listedQty may be stale (a sale
    // lowers Manapool's listing before Grimoire hears of it), which used
    // to put a sold copy back up (#86). Same cap as the Bulk Price page's
    // push (core.js pricePushQuantity): never more than Manapool lists
    // right now, never more than the copies on hand that aren't already
    // sold to an open Manapool order. If the live listings can't be read,
    // nothing is pushed - guessing is exactly the bug.
    //
    // #87: the quantity counts every local stack sharing the listing
    // (freeToListByIdentity scans them all, priced by the rule or not),
    // capped by what Manapool lists live. So a printing split across a
    // rule-matched bin and an unmatched one keeps its full live quantity.
    // Only listings already listed are pushed - a price sweep never creates
    // a new live listing.
    let live = null;
    try {
      live = liveListingTotals(await integrations.manapoolInventory(creds, {}));
    } catch (e) {
      logger("Manapool push skipped for " + label + ": couldn't read live listings - " + e.message);
      pushSkipped = matched.length;
    }
    const free = live ? freeToListByIdentity(state, new Set(matched.map(m => m.key))) : null;
    const toDelist = [];
    for (const m of live ? matched : []) {
      const liveQty = live.get(m.key) || 0;
      // Gone from Manapool (sold out or delisted there): nothing to price.
      if (!liveQty) { pushSkipped++; continue; }
      if (m.below) { toDelist.push(m); continue; }
      const quantity = Math.max(0, Math.min(liveQty, free.get(m.key) || 0));
      try {
        await integrations.manapoolList(creds, m.sample, {
          quantity, price: m.target, condition: m.sample.condition
        });
        pushed++;
        recordSent(m);
      } catch (e) {
        pushFailed++;
        logger("Manapool push failed for " + label + " (" + m.key + "): " + e.message);
      }
    }
    // Below cost: Delist all's own write, through its bulk path (quantity 0,
    // no price; replies matched back per item). Only a reply showing exactly
    // 0 counts as down. Anything else stays listed here and is sent again on
    // the next run, since the card may still be for sale at a loss. Sent once,
    // so a failure still uses up its place in this run's limit; a listing over
    // the limit isn't sent anything at all.
    if (toDelist.length) {
      toDelist.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const batch = toDelist.slice(0, MAX_SCHEDULED_DELISTS);
      delistLeft = toDelist.length - batch.length;
      let results = [], thrown = "";
      try {
        results = await integrations.manapoolListBulk(creds, batch.map(m =>
          ({ card: m.sample, quantity: 0, price: null, condition: m.sample.condition })));
      } catch (e) { thrown = e.message; }
      batch.forEach((m, i) => {
        const res = results[i];
        if (res && res.ok && res.quantity === 0) { recordDelist(m); return; }
        delistFailed++;
        logger("Manapool delist failed for " + label + " (" + m.key + "): " + (thrown || (res && res.error) ||
          (res && res.quantity != null ? "Manapool still shows " + res.quantity + " listed" : "Manapool did not confirm it")));
      });
      if (delisted || delistLeft) {
        const note = "Scheduled run: took down " + delisted + " listing(s) under the minimum profit, left " + delistLeft +
          " for the next run (limit " + MAX_SCHEDULED_DELISTS + " a run)";
        logger(label + ": " + note);
        state.audit = Array.isArray(state.audit) ? state.audit : [];
        state.audit.unshift({
          id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          ts: new Date().toISOString(), action: "list",
          name: "Bulk Price schedule", set: "", collector: "", lang: "",
          finish: "nonfoil", condition: "", qty: 0, oldQty: null, newQty: null,
          from: "", to: "", note, cost: null, receiptId: ""
        });
      }
    }
  }
  if (state.audit && state.audit.length > 5000) state.audit.length = 5000;

  if (recorded || delisted || delistLeft) {
    try {
      await store.writeCollection(ownerKey, state, doc.rev);
    } catch (e) {
      logger("could not save scheduled bulk price run for " + label + " - " + e.message + " (will retry next scheduled run)");
      return { ok: false, error: e.message };
    }
  }
  return { ok: true, considered, changed, pushed, pushFailed, pushSkipped, fallback, noPrice,
    ...(noLoss ? { belowCost, delisted, delistFailed, delistLeft } : {}) };
}

/* ============================== Push quantity cap (#86) ==============================
   Server-side mirror of core.js's manapoolReservations/listableQty, for the
   scheduled auto-push. Kept deliberately small and bounded: one pass over
   state.cards, and only when the run actually pushes something. */

// Live Manapool listings (normalizeListing rows) -> identity key -> listed qty.
function liveListingTotals(listings) {
  const totals = new Map();
  for (const l of listings || []) {
    if (l.kind === "sealed" || !l.scryfallId) continue;
    const key = manapoolIdentityKey(l);
    totals.set(key, (totals.get(key) || 0) + (Number(l.quantity) || 0));
  }
  return totals;
}

const normNum = n => String(n == null ? "" : n).trim().toLowerCase().replace(/^0+(?=.)/, "");

/* core.js availableQty (#336): a stack's copies less any lent out. Lent copies
   are owned but aren't here to sell, pick or trade. */
function availableQty(c) {
  // Held on a receipt still open on the floor (#388): none free until the desk closes it.
  if (c && c.held) return 0;
  const lent = c && Array.isArray(c.loans) ? c.loans.reduce((s, l) => s + (Number(l && l.qty) || 0), 0) : 0;
  return Math.max(0, (Number(c && c.quantity) || 0) - lent);
}

/* Copies already sold to an open Manapool order but not picked yet, per
   stack id. Same allocation completing the pick list uses (core.js
   pickAllocations limited to Manapool lists): only sell-from locations,
   highest pick priority first, then the bigger stack, each line's claim
   honoured by the next. Card lines only - the scheduled push is cards-only. */
function manapoolReservations(state) {
  const reserved = new Map();
  const lists = (Array.isArray(state.pickLists) ? state.pickLists : [])
    // A counter ticket too (#432; a kiosk order, #433): entering it lowered its listings on Manapool.
    .filter(p => p && p.status === "open" && (p.source === "manapool" || p.source === "walkin" || p.source === "kiosk"));
  const lines = [];
  for (const p of lists) for (const it of p.lines || []) if (it && it.kind !== "sealed") lines.push(it);
  if (!lines.length) return reserved;

  const locs = new Map((Array.isArray(state.locations) ? state.locations : []).map(l => [l.id, l]));
  const prio = id => { const l = locs.get(id); return l ? (l.pickPriority || 0) : 0; };
  // Index only the printings/names some open line asks for.
  const printKey = (set, num, lang, finish) => [set, normNum(num), lang, finish].join("|");
  const wantPrint = new Set(), wantName = new Set();
  for (const it of lines) {
    if (it.collector) wantPrint.add(printKey(it.set, it.collector, it.lang, it.finish));
    else wantName.add(String(it.name || "").toLowerCase());
  }
  const byPrint = new Map(), byName = new Map();
  for (const r of state.cards) {
    const l = locs.get(r.locationId);
    if (!(l && l.sellFrom)) continue;
    const pk = printKey(r.set, r.collector, r.lang, r.finish);
    if (wantPrint.has(pk)) { if (!byPrint.has(pk)) byPrint.set(pk, []); byPrint.get(pk).push(r); }
    const nk = String(r.name || "").toLowerCase();
    if (wantName.has(nk)) { if (!byName.has(nk)) byName.set(nk, []); byName.get(nk).push(r); }
  }
  const remaining = new Map();
  const left = r => remaining.has(r.id) ? remaining.get(r.id) : availableQty(r);
  for (const it of lines) {
    const pool = it.collector
      ? (byPrint.get(printKey(it.set, it.collector, it.lang, it.finish)) || [])
      : (byName.get(String(it.name || "").toLowerCase()) || [])
        .filter(r => (!it.set || r.set === it.set) && r.finish === it.finish);
    const stacks = pool.filter(r => (!it.condition || r.condition === it.condition) && left(r) > 0)
      .sort((a, b) => (prio(b.locationId) - prio(a.locationId)) || (left(b) - left(a)));
    let need = Number(it.qty) || 0;
    for (const r of stacks) {
      if (need <= 0) break;
      const take = Math.min(need, left(r));
      reserved.set(r.id, (reserved.get(r.id) || 0) + take);
      remaining.set(r.id, left(r) - take);
      need -= take;
    }
  }
  return reserved;
}

// identity key -> copies on hand that aren't reserved, for the given keys only.
function freeToListByIdentity(state, keys) {
  const reserved = manapoolReservations(state);
  const free = new Map();
  for (const r of state.cards) {
    if (!r.scryfallId) continue;
    const key = manapoolIdentityKey(r);
    if (!keys.has(key)) continue;
    const n = Math.max(0, availableQty(r) - (reserved.get(r.id) || 0));
    free.set(key, (free.get(key) || 0) + n);
  }
  return free;
}

/* ============================== Due-ness ==============================
   Checked from the server's existing 10-minute job loop. Bookkeeping (when a
   user's schedule last actually ran) lives in that user's prefs.json, not the
   collection document - it is operational state, not something the browser
   edits, and stashing it there would race the browser's own autosave. */
/* hourLocal/weekday were always compared against the SERVER's own clock -
   fine when the server happens to run in the operator's own time zone, wrong
   the moment it doesn't (a VPS left on UTC being the common case), silently
   firing a live-price-pushing schedule at the wrong hour with no error
   anywhere. bulk-price.page.js's saveSchedule() now stashes the browser's
   getTimezoneOffset() alongside hourLocal at save time, so "6 AM" means the
   hour the person who set it actually meant. Schedules saved before this
   fix carry no tzOffsetMinutes, so this falls back to the server's own
   offset - reproducing the exact old (if wrong) behavior for them rather
   than silently shifting an existing schedule's effective run time. */
function localParts(now, tzOffsetMinutes) {
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : now.getTimezoneOffset();
  const local = new Date(now.getTime() - off * 60000);
  return {
    hour: local.getUTCHours(),
    day: local.getUTCDay(),
    stamp: local.getUTCFullYear() + "-" + String(local.getUTCMonth() + 1).padStart(2, "0") + "-" + String(local.getUTCDate()).padStart(2, "0")
  };
}

function isDue(schedule, bookkeeping, now) {
  if (!schedule || !schedule.enabled) return false;
  const hour = Number(schedule.hourLocal);
  if (!Number.isFinite(hour)) return false;
  const local = localParts(now, Number(schedule.tzOffsetMinutes));
  if (local.hour < hour) return false;
  if (schedule.frequency === "weekly") {
    const wd = Number.isFinite(Number(schedule.weekday)) ? Number(schedule.weekday) : 1;
    if (local.day !== wd) return false;
  }
  return (bookkeeping && bookkeeping.lastRunDay) !== local.stamp;
}

/* Shared by both loops in runDue() below - checks one collection's own
   embedded schedule against that SAME collection's bookkeeping (prefs
   keyed by the identical ownerKey, so a Store's schedule/bookkeeping both
   live under stores/<id>/ and a personal account's both live under
   users/<id>/ - never a mismatch between where the schedule was read from
   and where "did it already run" gets stamped). */
async function runScheduleFor(ownerKey, label, now) {
  let doc;
  try { doc = await store.readCollection(ownerKey); } catch (e) { return; }
  const schedule = doc.state && doc.state.settings && doc.state.settings.bulkPriceSchedule;
  if (!schedule || !schedule.enabled) return;
  const prefs = await store.readPrefs(ownerKey);
  const bk = prefs.bulkPriceJobs || {};
  if (!isDue(schedule, bk, now)) return;

  // Stamp "ran today" before doing the work, so a crash mid-run cannot spin
  // the same schedule every ten minutes for the rest of the day. Must be
  // the same day-stamp basis isDue() compares against (the schedule's own
  // local day, not the server's) or a tz-offset schedule would never
  // register as "already run" - or would register a day early/late.
  await store.updatePrefs(ownerKey, p => {
    p.bulkPriceJobs = Object.assign({}, p.bulkPriceJobs || {},
      { lastRunDay: localParts(now, Number(schedule.tzOffsetMinutes)).stamp, lastRunAt: now.toISOString() });
  });
  logger("running scheduled bulk price for " + label);
  let result, failed;
  try {
    result = await runForUser(ownerKey, label);
    logger(label + ": " + JSON.stringify(result));
  } catch (e) {
    logger("scheduled bulk price failed for " + label + ": " + (e.stack || e.message));
    failed = { ok: false, error: e.message };
  }
  await store.updatePrefs(ownerKey, p => {
    p.bulkPriceJobs = Object.assign({}, p.bulkPriceJobs || {}, { lastResult: failed || result });
  });
}

/* orgs is optional (undefined skips the Store loop entirely) so this stays
   callable from a test/CLI context that only cares about personal
   accounts, same as before this parameter existed. */
async function runDue(auth, orgs) {
  if (!cards.ready) return;
  const now = new Date();

  const users = await auth.listUsers();
  for (const user of users) {
    if (user.disabled || user.orgId) continue; // an org member has no personal collection to schedule - see the Store loop below
    await runScheduleFor(user.id, user.username, now);
  }

  if (!orgs) return;
  const stores = await orgs.listAllStores();
  for (const s of stores) {
    if (s.archived) continue;
    await runScheduleFor("store:" + s.id, s.name, now);
  }
}

/* ============================== Unconditional daily row-price refresh ==============================
   Separate from the opt-in bulk-price schedule above: that one only ever touches `price` on
   listedQty>0 rows, and only for accounts that turned the schedule on. Every OTHER row's `price`
   used to change only when someone clicked "Refresh prices" - which could be weeks stale, silently
   understating/overstating inventory value against the Movers tab's always-current numbers (real
   user-reported discrepancy). This pushes every row's `price` to the in-memory card index's current
   number for every collection, every day - the same zero-network cards.priceFor() lookup Pass 1 above
   already uses, so it costs nothing extra to run unconditionally. */
async function refreshRowPrices(ownerKey) {
  const doc = await store.readCollection(ownerKey);
  const state = doc.state;
  if (!state || !Array.isArray(state.cards) || !state.cards.length) return { changed: 0 };
  let changed = 0;
  for (const r of state.cards) {
    const p = cards.priceFor(r.set, r.collector, r.lang, r.finish);
    if (p != null && p !== r.price) { r.price = p; changed++; }
  }
  if (changed) {
    try {
      await store.writeCollection(ownerKey, state, doc.rev);
    } catch (e) {
      logger("could not save daily row price refresh for " + ownerKey + " - " + e.message);
      return { changed: 0, error: e.message };
    }
  }
  return { changed };
}

/* Same personal-accounts-then-Stores loop shape as runDue() above. */
async function runDailyPriceRefresh(auth, orgs) {
  if (!cards.ready) return;
  const users = await auth.listUsers();
  for (const user of users) {
    if (user.disabled || user.orgId) continue;
    try { await refreshRowPrices(user.id); } catch (e) { logger("daily row price refresh failed for " + user.username + ": " + e.message); }
  }
  if (!orgs) return;
  const stores = await orgs.listAllStores();
  for (const s of stores) {
    if (s.archived) continue;
    try { await refreshRowPrices("store:" + s.id); } catch (e) { logger("daily row price refresh failed for store " + s.name + ": " + e.message); }
  }
}

module.exports = {
  init, MAX_SCHEDULED_DELISTS, runForUser, runDue, isDue, refreshRowPrices, runDailyPriceRefresh,
  manapoolReservations, freeToListByIdentity, availableQty, liveListingTotals,
  matchesPriceRule, ruleForRecord, priceRuleTarget, basisValue, manapoolIdentityKey
};
