"use strict";
/* One-time backfill of packing + postage cost onto old sales (#457).
   -------------------------------------------------------------------
   Completing a Manapool order's pick list freezes what packing and posting
   it cost on the sale (core.js completePickList → p.shipCost), worked out
   from the account's Settings → Shipping at that moment. Sales completed
   before #457 have no p.shipCost; owner's answer on #457: "past orders get
   today's rules once, as the backfill. Changing a cost later never moves
   past months." This run is that once.

   Same rules as completion, through the same shared math
   (public/js/shipCost.js costSale): copies actually pulled, the goods'
   value (revenue less the buyer's shipping), tracked when the order's
   shipping method needs it (integrations.orderNeedsTracking, the server's
   twin of core.js's). Tickets only save their shipping method since #454
   (2026-11-11), so for older sales the method comes from the Manapool
   orders caches (one per signed-in user, like orderFees.indexOrders); the
   ticket's own wins when it has one. Only a completed Manapool order's sale with pickedAt
   and no shipCost key is touched (ShipCost.needsShipCost), so a sale that
   already has one, null included, is left alone and a second run changes
   nothing. An account that never opened Settings → Shipping gets the
   suggested setup, the same as its next completion would.

   No network: it only reads and writes collections, each through
   store.updateCollection (read, changed and written under the collection's
   lock with a new rev, so an open tab's next save merges with it).

   Done marker in migrations.json. A collection that couldn't be read or
   saved leaves the run not done, and a later boot tries again, up to
   MAX_TRIES boots; after that it is marked done. An orders cache that
   can't be read means a tracked order could be costed as a letter for
   good, so that boot fills nothing and waits for the next, except on the
   last try, which fills with what it could read. */

const fs = require("fs");
const path = require("path");
const store = require("./store");
const { ownerKeys } = require("./orderLabels");
const { orderNeedsTracking } = require("./integrations");
const ShipCost = require("../../public/js/shipCost.js");

const MARKER = "saleShipCostBackfill";
const MAX_TRIES = 3;

/* Every cached Manapool order that needed tracking: Set of order ids, plus
   how many caches couldn't be read. */
async function trackedOrderIds() {
  const ids = new Set();
  let unreadable = 0, files = [];
  try { files = await fs.promises.readdir(store.p("orders")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let doc;
    try { doc = await store.readOrders(path.basename(f, ".json")); }
    catch (e) { unreadable++; continue; }
    for (const o of (doc && Array.isArray(doc.orders)) ? doc.orders : []) {
      if (o && o.id != null && orderNeedsTracking(o)) ids.add(String(o.id));
    }
  }
  return { ids, unreadable };
}

// A ticket's own shipping method when it saved one (#454), else its cached order's.
const saleTracked = (p, trackedIds) => p.shippingMethod ? orderNeedsTracking(p) : !!(trackedIds && trackedIds.has(String(p.orderId)));

// Fills every sale in one collection's state that needs it. Returns { filled }.
function fillShipCosts(state, at, trackedIds) {
  let filled = 0;
  const cfg = state && state.settings ? state.settings.shipping : undefined;
  for (const p of state && Array.isArray(state.pickLists) ? state.pickLists : []) {
    if (!ShipCost.needsShipCost(p)) continue;
    p.shipCost = ShipCost.costSale(p, saleTracked(p, trackedIds), cfg, at);
    filled++;
  }
  return { filled };
}

async function backfillShipCosts(opts) {
  const log = (opts && opts.log) || (() => {});
  const at = (opts && opts.at) || new Date().toISOString();
  const out = { owners: 0, filled: 0, skipped: 0 };
  const { ids, unreadable } = await trackedOrderIds();
  if (unreadable) {
    log("shipping cost backfill: " + unreadable + " orders cache(s) couldn't be read");
    out.skipped += unreadable;
    if (!(opts && opts.partialOk)) return out;   // not this boot: a tracked order could go in as a letter
  }
  for (const key of await ownerKeys()) {
    try {
      const r = await store.updateCollection(key, draft => {
        const f = fillShipCosts(draft, at, ids);
        return { write: f.filled > 0, result: f };
      });
      if (r && r.result && r.result.filled) { out.owners++; out.filled += r.result.filled; }
    } catch (e) {
      out.skipped++;
      log("shipping cost backfill: couldn't update " + key + " - " + e.message);
    }
  }
  return out;
}

/* Runs backfillShipCosts() until it's done once per data directory.
   Returns null when already done. */
async function backfillShipCostsOnce(opts) {
  const done = await store.readMigrations();
  if (done[MARKER]) return null;
  const tries = (Number(done[MARKER + "Tries"]) || 0) + 1;
  const out = await backfillShipCosts(Object.assign({}, opts, { partialOk: tries >= MAX_TRIES }));
  out.tries = tries;
  if (!out.skipped || tries >= MAX_TRIES) await store.markMigrationDone(MARKER);
  else await store.noteMigrationTry(MARKER + "Tries", tries);
  return out;
}

module.exports = { MARKER, MAX_TRIES, trackedOrderIds, fillShipCosts, backfillShipCosts, backfillShipCostsOnce };
