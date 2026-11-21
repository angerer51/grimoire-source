"use strict";
/* The sealed-product catalog.
   ----------------------------
   Manapool's GET /prices/sealed is a credential-free, deployment-wide catalog
   pull - same shape of access as cards.js's Manapool price overlay (see
   integrations.manapoolCatalogPrices). Unlike cards.js there is no Scryfall
   data to fall back to or merge with: Scryfall has no sealed product data at
   all, so for sealed, Manapool isn't an alternative price source layered on
   an existing catalog - it IS the catalog, identity and price both. See
   BACKLOG.md #24 for the full scoping this module implements the first slice
   of.

   Deliberately far lighter than cards.js: ~2,045 products vs 100k+
   printings, so this is a single in-memory Map rebuilt wholesale on every
   refresh - no NDJSON sharding, no live-fallback machinery, no disk cache.
   A cold boot just fetches once, the same as any other daily job; a process
   restart before the first refresh completes simply serves an empty catalog
   until it does.

   This module itself is still catalog/pricing only (mirrors #23's "prove the
   data out first" shape) - the actual `state.sealed` inventory rows this
   feeds (Receive intake, Inventory's Sealed tab) live in public/js/core.js,
   not here. Pricing rules (Listings/Bulk Price) and Manapool sell-side
   listing writes remain follow-on slices #24 scoped out. */

const integrations = require("./integrations");

let logger = msg => console.log("[sealed] " + msg);
function log(msg) { logger(msg); }

const state = {
  ready: false,       // a refresh has completed at least once
  building: false,
  updatedAt: null,     // when this process last refreshed successfully
  count: 0,
  skipped: 0,          // rows dropped for having no tcgplayer_product_id
  error: null
};

let byId = new Map();          // tcgplayer_product_id (string) -> product
let byManapoolId = new Map();  // manapool product_id (uuid) -> product

async function refresh() {
  if (state.building) return status();
  state.building = true;
  try {
    const products = await integrations.manapoolSealedCatalog();
    const nextById = new Map();
    const nextByMp = new Map();
    for (const p of products) {
      nextById.set(p.tcgplayerProductId, p);
      if (p.manapoolProductId) nextByMp.set(p.manapoolProductId, p);
    }
    byId = nextById;
    byManapoolId = nextByMp;
    state.count = byId.size;
    state.updatedAt = new Date().toISOString();
    state.error = null;
    state.ready = true;
    log(state.count + " sealed products loaded from Manapool");
  } catch (e) {
    state.error = e.message;
    log("refresh failed: " + e.message);
    throw e;
  } finally {
    state.building = false;
  }
  return status();
}

/* Look up by TCGplayer product id - the vendor-neutral key #24 settled on. */
function one(tcgplayerProductId) {
  return byId.get(String(tcgplayerProductId)) || null;
}
/* Look up by Manapool's own product id - needed anywhere Grimoire has to
   talk back to Manapool specifically (a future listing/order call). */
function byManapool(productId) {
  return byManapoolId.get(productId) || null;
}
function all() { return byId.values(); }

/* Name search for Receive's sealed intake - same starts-with-then-contains
   ranking as cards.js's autocomplete() (server/lib/cards.js), but returns
   full product objects rather than bare names: a sealed search hit IS the
   thing to add, there's no separate name->printings step the way cards
   have. */
function search(qstr, limit) {
  const s = String(qstr || "").trim().toLowerCase();
  if (s.length < 2) return [];
  const cap = limit || 20;
  const starts = [];
  const contains = [];
  for (const p of byId.values()) {
    const lower = String(p.name || "").toLowerCase();
    if (lower.startsWith(s)) { if (starts.length < cap) starts.push(p); }
    else if (contains.length < cap && lower.includes(s)) contains.push(p);
    if (starts.length >= cap) break;
  }
  return starts.concat(contains).slice(0, cap);
}

function status() {
  return {
    ready: state.ready,
    building: state.building,
    updatedAt: state.updatedAt,
    count: state.count,
    error: state.error
  };
}

async function init(config, opts) {
  if (opts && opts.log) logger = opts.log;
  // Fire-and-forget, same spirit as cards.js's cold-start path: a ~650KB
  // fetch shouldn't hold up the rest of boot, and the app has nothing today
  // that depends on this catalog being populated yet.
  refresh().catch(() => {});
}

module.exports = { init, refresh, one, byManapool, all, search, status };
