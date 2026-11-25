"use strict";
/* Outside services: Manapool (listings, orders, shipping details) and
   Pitney Bowes (labels).

   READ THIS BEFORE TURNING EITHER ON
   ----------------------------------
   Both vendors' request shapes (paths, header names, shipping defaults) live in
   config.json, because neither API is one I can verify from here - every path
   and field mapping is a config value with a plausible default, and every
   normaliser keeps the vendor's raw payload under `raw` so you can see exactly
   what came back and adjust the mapping in one place. `GET /api/manapool/status`
   and `GET /api/shipping/status` exist specifically so you can prove a
   connection works before trusting anything downstream of it.

   Credentials are NOT in config.json - each user connects their own account
   from Settings -> Integrations (Mana Pool: its own sign-in, server/lib/mpAuth.js,
   #499), stored server-side in their prefs.json
   (server/lib/store.js readPrefs/writePrefs), never in the collection document
   and never echoed back to the browser. Every function below that talks to a
   vendor takes that user's `creds` as its first argument instead of reading a
   shared module-level secret - there is no "the" Manapool account anymore, only
   "this user's" Manapool account. `enabled` in config.json is a deployment-level
   kill switch: it can turn an integration off for everyone regardless of who
   has entered credentials, but turning it on does not, by itself, connect
   anybody - that still takes real credentials in Settings.

   Both are off by default. Nothing else in Grimoire depends on either. */

const { fetchRetry } = require("./fetchRetry");

let cfg = { manapool: {}, pitneyBowes: {} };
let logger = m => console.log("[integrations] " + m);

function init(config, opts) {
  cfg = config;
  cfg.manapool = cfg.manapool || {};
  cfg.pitneyBowes = cfg.pitneyBowes || {};
  if (opts && opts.log) logger = opts.log;
}

/* First non-empty value among several candidate field names, so a mapping that
   is slightly off still surfaces the data instead of silently blanking it. */
function pick(obj, names, fallback) {
  for (const n of names) {
    if (!obj || typeof obj !== "object") break;
    const parts = String(n).split(".");
    let v = obj;
    let ok = true;
    for (const part of parts) {
      if (v == null || typeof v !== "object" || !(part in v)) { ok = false; break; }
      v = v[part];
    }
    if (ok && v !== null && v !== undefined && v !== "") return v;
  }
  return fallback;
}

function money(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1000 && Number.isInteger(v) ? v / 100 : v;  // cents vs dollars
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

/* "foil" as a plain substring also matches "nonfoil"/"non-foil" - check for a
   "non" prefix (with or without a separator) first so those read as
   nonfoil, and "etched" before the plainer "foil" match so "Etched Foil"
   text doesn't fall through to the coarser foil bucket. */
function finishFromText(v) {
  const s = String(v || "");
  if (/non.?foil/i.test(s)) return "nonfoil";
  if (/etched/i.test(s)) return "etched";
  if (/foil/i.test(s)) return "foil";
  return "nonfoil";
}
function isFoilText(v) { return finishFromText(v) !== "nonfoil"; }

/* Manapool's own price fields are unambiguously *_cents (confirmed against
   their published OpenAPI spec, not guessed) - money()'s dollars-vs-cents
   heuristic misreads an exact $10.00 (1000 cents, not > 1000) as dollars, so
   a known-cents field always goes through this instead. */
function centsToDollars(v) {
  const n = Number(v);
  return v == null || isNaN(n) ? null : Math.round(n) / 100;
}
/* Prefer a confirmed *_cents field; fall back to money()'s tolerant guess
   over a grab-bag of other candidate field names for anything unconfirmed. */
function priceFrom(raw, centsKeys, otherKeys) {
  const cents = pick(raw, centsKeys, null);
  return cents != null ? centsToDollars(cents) : money(pick(raw, otherKeys, null));
}

async function jsonRequest(url, opts) {
  const o = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs || 25000);
  try {
    const res = await fetchRetry(url, {
      method: o.method || "GET",
      headers: Object.assign({ Accept: "application/json" }, o.headers || {},
        o.body ? { "Content-Type": "application/json" } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { rawText: text.slice(0, 2000) }; }
    if (!res.ok) {
      const e = new Error("HTTP " + res.status + " from " + url + " - " +
        String(text).slice(0, 300).replace(/\s+/g, " "));
      // A 401/403 here means the upstream vendor rejected THIS user's stored
      // credentials - not that the caller's own Grimoire session is bad.
      // Surfacing it as our own 401 would be actively wrong: the browser's
      // api() wrapper (public/js/core.js) treats ANY 401 response as "your
      // session expired" and force-redirects to /login.html, which would
      // boot a signed-in user to the login page over an unrelated Manapool/
      // PB credential problem. 403 has no such special handling client-side,
      // so it is the code that actually lets a caller distinguish "upstream
      // says our credentials are bad" (403) from any other upstream failure
      // (502), while still just showing up as a normal error toast.
      e.status = (res.status === 401 || res.status === 403) ? 403 : 502;
      e.upstream = res.status;
      e.payload = data;
      throw e;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("The request to " + url + " timed out.");
      err.status = 504;
      throw err;
    }
    throw e;
  } finally { clearTimeout(timer); }
}

/* ============================ Manapool ============================ */
const mp = () => cfg.manapool || {};
function mpFeatureOn() { return !!mp().enabled; }
/* `creds` comes from server/lib/mpAuth.js (#499): { oauth: { token }, scopes }
   for a Mana Pool sign-in, or { email, accessToken, legacy } for the old
   pasted token during its grace week. */
function mpReady(creds) {
  return mpFeatureOn() && !!(creds && ((creds.oauth && typeof creds.oauth.token === "function") ||
    (creds.email && creds.accessToken)));
}

async function mpHeaders(creds, stale) {
  if (creds.oauth) return { Authorization: "Bearer " + await creds.oauth.token(stale) };
  const h = {};
  h[mp().emailHeader || "X-ManaPool-Email"] = creds.email;
  h[mp().tokenHeader || "X-ManaPool-Access-Token"] = creds.accessToken;
  return h;
}
/* Every Mana Pool API call goes through here. A 401 on a sign-in's access
   token (ended early on Mana Pool's side) gets one fresh token and one more
   try: a 401 means the request wasn't carried out, so a write is safe to resend. */
async function mpJson(creds, url, opts) {
  const headers = await mpHeaders(creds);
  try {
    return await jsonRequest(url, Object.assign({}, opts, { headers }));
  } catch (e) {
    if (!(e.upstream === 401 && creds.oauth)) throw e;
    const stale = String(headers.Authorization || "").slice("Bearer ".length);
    return jsonRequest(url, Object.assign({}, opts, { headers: await mpHeaders(creds, stale) }));
  }
}
/* Paths added after a server's config.json was written fall back to these,
   so an existing install picks them up without a config edit. */
const MP_DEFAULT_PATHS = {
  buyerOrders: "buyer/orders",
  buyerOrder: "buyer/orders/{id}",
  buyerReceived: "buyer/seller-orders/{id}/received",
  orderFulfillment: "seller/orders/{id}/fulfillment",
  listing: "seller/inventory/scryfall_id/{scryfall_id}"
};
function mpUrl(pathKey, params, subs) {
  const paths = mp().paths || {};
  let p = paths[pathKey] || MP_DEFAULT_PATHS[pathKey];
  if (!p) throw Object.assign(new Error('config.manapool.paths."' + pathKey + '" is not set.'), { status: 501 });
  for (const [k, v] of Object.entries(subs || {})) p = p.replace("{" + k + "}", encodeURIComponent(v));
  const url = new URL(p, mp().baseUrl || "https://api.manapool.com");
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === "") continue;
    // OpenAPI's default array serialization for a query param - repeat the
    // key once per value (scryfall_ids=a&scryfall_ids=b&...), not one
    // comma-joined value.
    if (Array.isArray(v)) { for (const one of v) if (one != null && one !== "") url.searchParams.append(k, one); }
    else url.searchParams.set(k, v);
  }
  return url.toString();
}
function mpGuard(creds) {
  if (!mpFeatureOn()) {
    throw Object.assign(
      new Error("Manapool is turned off for this server. An administrator needs to set " +
        "manapool.enabled in config.json, then restart."), { status: 501 });
  }
  if (!mpReady(creds)) {
    throw Object.assign(
      new Error(creds && creds.dead
        ? "Mana Pool ended Grimoire's connection to your account. Reconnect Mana Pool in Settings → Integrations."
        : "Mana Pool isn't connected. Connect it in Settings → Integrations, then try again."), { status: 501 });
  }
}
/* One inventory integration per seller (#499): when another tool manages
   this seller's listings, the connection has no inventory-write scope. */
const MP_OTHER_APP = "Another app manages your Mana Pool listings, so Grimoire can't change them.";
function mpCanWriteInventory(creds) {
  if (!creds || !creds.oauth) return true;
  const s = creds.scopes;
  return !Array.isArray(s) || !s.length || s.includes(mp().oauth && mp().oauth.inventoryWriteScope || "inventory:write");
}
function mpGuardInventoryWrite(creds) {
  mpGuard(creds);
  if (!mpCanWriteInventory(creds)) throw Object.assign(new Error(MP_OTHER_APP), { status: 409, otherApp: true });
}

async function manapoolStatus(creds) {
  if (!mpFeatureOn()) return { enabled: false, configured: false };
  if (!mpReady(creds)) return { enabled: true, configured: false, dead: !!(creds && creds.dead) };
  try {
    const data = await mpJson(creds, mpUrl("inventory", { limit: 1 }));
    const list = Array.isArray(data) ? data : (data && (data.data || data.items || data.inventory)) || [];
    return {
      enabled: true, configured: true, ok: true,
      sample: Array.isArray(list) ? list.length : 0,
      baseUrl: mp().baseUrl
    };
  } catch (e) {
    return { enabled: true, configured: true, ok: false, error: e.message, upstream: e.upstream || null };
  }
}

/* Both an order line and an inventory item wrap the actual card as
   { product: { type, id, tcgplayer_sku, single: {scryfall_id, name, set,
   number, language_id, condition_id, finish_id, ...} | null, ... } } in
   Manapool's real API (confirmed against their published OpenAPI spec) -
   `single` is null for a sealed product. */
const pickSingle = raw => (raw && raw.product && raw.product.single) || {};

/* A sealed order line has `product.single` null (see pickSingle's comment
   above) and `product.type` "mtg_sealed" - previously unhandled here, so a
   real order line for sealed product (listed some other way than through
   Grimoire - this check doesn't depend on Grimoire ever having pushed the
   listing itself) fell through every `single.x || pick(raw, [...])`
   fallback above and came out as a near-empty, wrong "card" line
   (scryfallId "", finish defaulted to "nonfoil", etc.) instead of being
   recognized. Exact field names for the sealed identity are inferred from
   the same product-wrapper shape singles use (`product.id` = Manapool's
   own id, matching state.sealed's manapoolProductId; a tcgplayer id
   variously named across Manapool's endpoints, tried under a few
   plausible keys) - unverified against a live sealed order response,
   flagged the same as the rest of sealed's Manapool integration. */
function normalizeOrderLine(raw) {
  const product = (raw && raw.product) || {};
  if (product.type === "mtg_sealed" || product.type === "sealed") {
    return {
      kind: "sealed",
      name: String(pick(product, ["name"], "") || pick(raw, ["name", "product_name", "productName"], "")),
      setCode: String(pick(product, ["set_code", "setCode"], "") || pick(raw, ["set_code", "setCode", "set"], "")).toLowerCase(),
      manapoolProductId: String(product.id || pick(raw, ["product_id", "productId"], "")),
      tcgplayerProductId: String(pick(product, ["tcgplayer_sku", "tcgplayer_product_id", "tcgplayerProductId"], "") ||
        pick(raw, ["tcgplayer_product_id", "tcgplayerProductId"], "")),
      qty: Number(pick(raw, ["quantity", "qty", "count"], 1)) || 1,
      unitPrice: priceFrom(raw, ["price_cents"], ["unit_price", "price", "unitPrice"]),
      raw
    };
  }
  const single = pickSingle(raw);
  return {
    kind: "card",
    name: String(single.name || pick(raw, ["name", "card_name", "product_name", "cardName"], "")),
    set: String(single.set || pick(raw, ["set", "set_code", "setCode"], "")).toLowerCase(),
    setName: String(pick(raw, ["set_name", "setName"], "")),
    collector: String(single.number || pick(raw, ["collector_number", "collectorNumber", "number"], "")),
    lang: grimoireLang(String(single.language_id || pick(raw, ["language", "lang"], "en")).toLowerCase().slice(0, 3)),
    finish: single.finish_id ? (single.finish_id === "EF" ? "etched" : single.finish_id === "FO" ? "foil" : "nonfoil")
      : (pick(raw, ["is_foil", "isFoil"], false) === true ? "foil"
        : finishFromText(pick(raw, ["finish", "foil", "printing", "treatment"], ""))),
    condition: String(single.condition_id || pick(raw, ["condition", "grade"], "")),
    qty: Number(pick(raw, ["quantity", "qty", "count"], 1)) || 1,
    unitPrice: priceFrom(raw, ["price_cents"], ["unit_price", "price", "unitPrice"]),
    scryfallId: String(single.scryfall_id || pick(raw, ["scryfall_id", "scryfallId"], "")),
    raw
  };
}

function normalizeOrder(raw) {
  const shipRaw = pick(raw, ["shipping_address", "shippingAddress", "ship_to", "shipTo", "address"], {}) || {};
  const linesRaw = pick(raw, ["items", "lines", "order_items", "orderItems", "products"], []) || [];
  // Only the single-order-by-id response (manapoolOrder(), orderDetails in
  // manapool.json) carries this - the order LIST endpoint's orderSummary
  // shape has no such field, so `raw.payment` is genuinely absent there and
  // this comes back null, same "honest gap" as everything else `pick()`
  // defaults. subtotal/shipping/total mirror what the buyer paid;
  // fee/net are Manapool's own seller-fee deduction and the resulting
  // payout - net_cents IS "Earnings" (BACKLOG.md #19), no math needed on
  // this end.
  const paymentRaw = raw && raw.payment;
  const payment = paymentRaw ? {
    subtotal: centsToDollars(paymentRaw.subtotal_cents),
    shipping: centsToDollars(paymentRaw.shipping_cents),
    total: centsToDollars(paymentRaw.total_cents),
    fee: centsToDollars(paymentRaw.fee_cents),
    net: centsToDollars(paymentRaw.net_cents)
  } : null;
  return {
    id: String(pick(raw, ["id", "order_id", "orderId", "number", "order_number"], "")),
    // The internal UUID `id` above is what Grimoire links pick lists and
    // order-detail lookups by - it is NOT what Manapool shows a seller as
    // "their" order number. That's this separate `label` field (Manapool's
    // spec example: "1234-5678"), never captured before, so an order could
    // only ever be found here under an opaque id nobody outside this app
    // would recognize.
    label: String(pick(raw, ["label"], "")),
    // Manapool's "Minimum Required Shipping Method" (first_class |
    // ground_advantage), on both the list and the detail shape. Decides
    // whether marking it shipped needs a tracking number (#454).
    shippingMethod: String(pick(raw, ["shipping_method"], "")),
    placedAt: String(pick(raw, ["created_at", "placed_at", "createdAt", "date"], "")),
    // Manapool's own spec has latest_fulfillment_status as explicitly
    // nullable - null is not "no data", it's their real "Unfulfilled" state
    // (order placed, fulfillment not yet started). pick() treats null as
    // absent and would otherwise fall through to "" here, which the UI then
    // rendered as a bare "?" - "unfulfilled" is the correct default, not a
    // guess: it is Manapool's own label for this exact case.
    status: String(pick(raw, ["latest_fulfillment_status", "status", "state", "fulfillment_status"], "unfulfilled")),
    total: priceFrom(raw, ["total_cents"], ["total", "grand_total", "amount"]),
    // Manapool's order shape has no buyer display name field, only a buyer_id
    // uuid - the shipping recipient's name is the only real name available.
    buyer: String(pick(shipRaw, ["name", "full_name", "recipient"], "") ||
      pick(raw, ["buyer_name", "buyerName", "customer_name"], "")),
    // Manapool's stable buyer uuid - what the Customers page (#50) dedupes
    // repeat buyers by. An opaque id, not contact details.
    buyerId: String(pick(raw, ["buyer_id", "buyerId"], "")),
    ship: {
      name: String(pick(shipRaw, ["name", "full_name", "recipient"], "")),
      company: String(pick(shipRaw, ["company", "organization"], "")),
      line1: String(pick(shipRaw, ["address1", "line1", "street1", "address_line_1"], "")),
      line2: String(pick(shipRaw, ["address2", "line2", "street2", "address_line_2"], "")),
      city: String(pick(shipRaw, ["city", "city_town", "locality"], "")),
      state: String(pick(shipRaw, ["state", "state_province", "province", "region"], "")),
      postal: String(pick(shipRaw, ["zip", "postal_code", "postcode", "postalCode"], "")),
      country: String(pick(shipRaw, ["country", "country_code", "countryCode"], "US")),
      phone: String(pick(shipRaw, ["phone", "telephone"], "")),
      email: String(pick(shipRaw, ["email"], ""))
    },
    payment,
    lines: (Array.isArray(linesRaw) ? linesRaw : []).map(normalizeOrderLine),
    raw
  };
}

/* GET /seller/orders defaults to limit:100 (Grimoire has always asked for 50)
   and, same as manapoolInventory() below before it was fixed, was never
   paginated - confirmed live against a real account with >50 orders that an
   unpaginated call returns a fixed 50-order window starting from whatever
   the API considers its default starting point, NOT "the 50 most recent."
   A seller's newest orders past that window silently never appeared,
   indefinitely, no matter how many times "Fetch orders" was pressed. Pages
   through every result via cursor/next_cursor, same pattern as
   manapoolInventory. Bounded to 50 pages (~5,000 orders at the 100/page
   default) rather than manapoolInventory's much higher cap - order history
   only grows over an account's lifetime (unlike active inventory, which is
   naturally bounded), so an uncapped full-history walk here could get
   expensive for a long-lived seller; callers doing a routine refresh should
   pass `since` (the endpoint's own incremental filter) to keep this to one
   page in the common case instead of relying on the cap. */
async function manapoolOrders(creds, params) {
  mpGuard(creds);
  const base = Object.assign({ limit: 100 }, params || {});
  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard++) {
    const q = Object.assign({}, base, cursor ? { cursor } : {});
    const data = await mpJson(creds, mpUrl("orders", q));
    const list = Array.isArray(data) ? data : (data && (data.data || data.orders || data.items)) || [];
    out.push(...(Array.isArray(list) ? list : []).map(normalizeOrder));
    const next = data && data.pagination && data.pagination.next_cursor;
    if (!next) break;
    cursor = next;
  }
  return out;
}

async function manapoolOrder(creds, id) {
  mpGuard(creds);
  const data = await mpJson(creds, mpUrl("order", {}, { id }));
  const one = (data && (data.data || data.order)) || data;
  return normalizeOrder(one || {});
}

/* Full per-order detail for a batch of ids, bounded concurrency (same
   worker-pool pattern as manapoolPrices below). The list endpoint
   (manapoolOrders above) never carries lines, buyer name, or a shipping
   address - only this single-order endpoint does - so a caller that wants
   real data on a *specific* set of orders (e.g. "everything that still
   needs shipping," /api/manapool/orders' refresh below) has to hit it once
   per id. One bad id doesn't sink the batch - it's just left out of the
   returned map, same as if it hadn't been asked for. */
async function manapoolOrderDetails(creds, ids) {
  mpGuard(creds);
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  const out = new Map(); // id -> normalized order
  const CONCURRENCY = 6;
  let next = 0;
  async function worker() {
    while (next < uniqueIds.length) {
      const id = uniqueIds[next++];
      try { out.set(id, await manapoolOrder(creds, id)); }
      catch (e) { /* skip - a stale summary beats losing the whole refresh */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniqueIds.length) }, worker));
  return out;
}

/* Which orders a Fetch orders refresh re-downloads in full (#93). Manapool's
   statuses are error | processing | shipped | delivered | refunded |
   replaced (null = unfulfilled), and every normal order ends at delivered,
   so re-checking "anything not exactly shipped" meant re-fetching nearly
   the whole 500-order cache on every refresh, forever. Re-checked now:
   - everything Manapool's own needs_shipping list returns;
   - a cached order that can still change (anything but a finished state,
     so unfulfilled, processing, error and any unknown status);
   - a finished cached order whose details were never fetched (no lines on
     file), once, so it isn't left with only the list endpoint's summary;
   - a finished cached order with no `payment` breakdown (#452: details
     fetched before normalizeOrder kept it), once: a detail that comes back
     without one is marked paymentUnavailable and not asked for again.
   Same finished-state list as core.js's orderIsOpen(). */
const ORDER_FINAL_STATUSES = new Set(["shipped", "delivered", "replaced", "cancelled", "canceled",
  "refunded", "completed", "complete", "fulfilled", "returned", "closed"]);
function orderIsFinal(status) {
  return ORDER_FINAL_STATUSES.has(String(status == null ? "" : status).trim().toLowerCase().replace(/[\s-]+/g, "_"));
}
function ordersToRecheck(cachedOrders, needsShippingOrders) {
  const ids = new Set((needsShippingOrders || []).map(o => o && o.id).filter(Boolean));
  for (const o of cachedOrders || []) {
    if (!o || !o.id) continue;
    const hasDetail = Array.isArray(o.lines) && o.lines.length > 0;
    const hasPayment = !!o.payment || !!o.paymentUnavailable;
    if (!orderIsFinal(o.status) || !hasDetail || !hasPayment) ids.add(o.id);
  }
  return ids;
}

/* A row from the seller's live inventory/listings feed - what is actually for
   sale on Manapool right now, regardless of how it got there. Same
   product.single nesting as an order line (pickSingle) - and the same
   product.type "mtg_sealed" branch normalizeOrderLine already needed
   (2026-09-01: this function was missing it entirely, so a sealed listing
   fell through to pickSingle() and came back with a blank name/set/
   scryfallId - the Listings page's Manapool cross-check then had nothing
   real to match it against and always reported it as "no matching card in
   local inventory," regardless of what state.sealed actually held). */
function normalizeListing(raw) {
  const product = (raw && raw.product) || {};
  if (product.type === "mtg_sealed" || product.type === "sealed") {
    return {
      kind: "sealed",
      id: String(raw.id || ""),
      name: String(pick(product, ["name"], "") || pick(raw, ["name", "product_name", "productName"], "")),
      setCode: String(pick(product, ["set_code", "setCode"], "") || pick(raw, ["set_code", "setCode"], "")).toLowerCase(),
      manapoolProductId: String(product.id || pick(raw, ["product_id", "productId"], "")),
      tcgplayerProductId: String(pick(product, ["tcgplayer_sku", "tcgplayer_product_id", "tcgplayerProductId"], "") ||
        pick(raw, ["tcgplayer_product_id", "tcgplayerProductId"], "")),
      quantity: Number(raw.quantity) || 0,
      price: priceFrom(raw, ["price_cents"], ["price", "unit_price"]),
      raw
    };
  }
  const single = pickSingle(raw);
  return {
    kind: "card",
    id: String(raw.id || ""),
    name: String(single.name || ""),
    set: String(single.set || "").toLowerCase(),
    setName: "",
    collector: String(single.number || ""),
    lang: grimoireLang(single.language_id),
    finish: single.finish_id === "EF" ? "etched" : single.finish_id === "FO" ? "foil" : "nonfoil",
    condition: String(single.condition_id || ""),
    quantity: Number(raw.quantity) || 0,
    price: priceFrom(raw, ["price_cents"], ["price", "unit_price"]),
    scryfallId: String(single.scryfall_id || ""),
    raw
  };
}

/* GET /seller/inventory defaults to `limit: 100` and never paginated on its own
   - a real seller inventory (hundreds of active listings, plus however many
   historical zero-quantity entries Manapool keeps around after a delist) was
   silently truncated to whatever page happened to come back first, which could
   be entirely delisted rows: the "Your Manapool listings" table then showed
   nothing but 0-quantity ghosts, never reaching any card actually for sale.
   Fixed two ways: page through every result via `cursor`/`next_cursor` (offset
   pagination is being deprecated per the endpoint's own description) and pass
   `minQuantity: 1` so delisted rows never come back at all - the self-healing
   sync in core.js (syncManapoolListings) already treats any local identity
   missing from this list as quantity 0, so omitting them here loses nothing. */
async function manapoolInventory(creds, params) {
  mpGuard(creds);
  const base = Object.assign({ limit: 500, minQuantity: 1 }, params || {});
  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 1000; guard++) {
    const q = Object.assign({}, base, cursor ? { cursor } : {});
    const data = await mpJson(creds, mpUrl("inventory", q));
    const list = Array.isArray(data) ? data : (data && (data.data || data.items || data.inventory)) || [];
    out.push(...(Array.isArray(list) ? list : []).map(normalizeListing));
    const next = data && data.pagination && data.pagination.next_cursor;
    if (!next) break;
    cursor = next;
  }
  return out;
}

/* Every in-stock single Manapool sells, in one call - confirmed live (not
   just against the spec) that GET /prices/singles needs no credentials at
   all: no `security` entry on this path in Manapool's OpenAPI document,
   and a bare no-header request returns 200. That makes it a fundamentally
   different kind of call from manapoolPrices() below - one deployment-wide
   catalog pull server-side, not a per-account, per-printing live lookup -
   which is what makes it usable as cards.js's price SOURCE (see
   cards.refreshManapoolPrices) rather than just an on-demand basis a
   connected seller can opt into for bulk-price rules.

   Observed 2026-08-31: ~102,600 rows, ~50MB of JSON, no pagination
   parameters in the spec or needed in practice - it really is the whole
   in-stock catalog in one response. That's a real coverage gap against
   Scryfall's near-total printing universe though: a printing nobody is
   currently selling on Manapool simply isn't in this list, full stop -
   the caller decides what "no data" means rather than this function
   guessing. Same *_cents fields as manapoolPrices(), so centsToDollars
   applies the same way; there is still no per-condition "market" price for
   etched (Manapool has no etched price tier at all), only the flat NM ask. */
async function manapoolCatalogPrices() {
  const data = await jsonRequest(mpUrl("pricesSingles", {}), { timeoutMs: 60000 });
  // #529: a 200 that wasn't the expected list used to become an empty Map,
  // and cards.applyPriceSource() then wiped every printing's price with it
  // (0/543,023 priced, 2026-11-24 05:00). Anything but a non-empty list of
  // rows is an error now, saying briefly what came back instead.
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.data)) ? data.data : null;
  const bad = msg => Object.assign(new Error("Manapool's price feed " + msg), { status: 502 });
  if (!list) {
    if (data == null) throw bad("came back empty.");
    if (data.rawText != null) {
      throw bad("sent back something that isn't price data (it starts \"" +
        String(data.rawText).replace(/\s+/g, " ").trim().slice(0, 80) + "\").");
    }
    throw bad("came back without a list of prices.");
  }
  if (!list.length) throw bad("came back with an empty price list.");
  const out = new Map();   // scryfallId -> {market, marketFoil, nm, nmFoil, nmEtched}
  for (const row of list) {
    if (!row || !row.scryfall_id) continue;
    out.set(row.scryfall_id, {
      market: centsToDollars(row.price_market),
      marketFoil: centsToDollars(row.price_market_foil),
      nm: centsToDollars(row.price_cents_nm),
      nmFoil: centsToDollars(row.price_cents_nm_foil),
      nmEtched: centsToDollars(row.price_cents_nm_etched)
    });
  }
  if (!out.size) throw bad("had " + list.length.toLocaleString("en-US") + " rows but none with a Scryfall id.");
  return out;
}

/* Every sealed product Manapool tracks, in one call - same credential-free
   access as manapoolCatalogPrices() above (GET /prices/sealed has no
   `security` entry either). Confirmed live 2026-08-31: 2,045 products, no
   pagination needed. Field names don't carry a "_cents" suffix the way the
   singles endpoint's do (`low_price`, `price_market` vs singles'
   `price_cents_nm`), but a live sample confirms they're cents all the same -
   e.g. a Double Masters 2022 Collector Booster Box read low_price: 49999
   (=$499.99), not $499.99 as a bare integer. No `recent_sales` field showed
   up in the live response despite being listed in early scoping notes (see
   BACKLOG.md #24) - dropped here rather than carried through as a field
   that's always empty.

   Unlike singles there is no scryfall_id to key off - Manapool's own
   product_id and TCGplayer's product_id are the only identities on offer.
   Per #24's identity design, tcgplayer_product_id is the vendor-neutral key
   sealed.js indexes by; rows missing it (~35 of 2,045 in the live sample,
   figures/oversized or otherwise TCGplayer-unlisted product) are dropped
   here, same as manapoolCatalogPrices() drops scryfall_id-less rows -
   Manapool's own product_id is still returned per-row for anything that
   does need to reach Manapool specifically (listing, order lookup). */
async function manapoolSealedCatalog() {
  const data = await jsonRequest(mpUrl("pricesSealed", {}), { timeoutMs: 60000 });
  const list = Array.isArray(data) ? data : (data && data.data) || [];
  const out = [];
  for (const row of list) {
    if (!row.tcgplayer_product_id) continue;
    out.push({
      tcgplayerProductId: String(row.tcgplayer_product_id),
      manapoolProductId: row.product_id,
      setCode: row.set_code,
      name: row.name,
      languageId: row.language_id,
      lowPrice: centsToDollars(row.low_price),
      marketPrice: centsToDollars(row.price_market),
      availableQuantity: row.available_quantity,
      url: row.url
    });
  }
  return out;
}

/* Price lookup for a specific set of printings - not the whole marketplace.
   Confirmed against Manapool's published spec: GET /products/singles takes
   up to 100 scryfall_ids per call and returns, per printing, Manapool's own
   market-price estimate plus the lowest price currently being asked for it
   at a couple of condition tiers. A bigger ask than 100 is chunked here
   transparently so a caller never has to think about the cap. This is what
   the bulk-price rule engine's "Manapool" pricing bases read from - looked
   up live, on demand, only for cards actually being priced, rather than any
   kind of local copy of Manapool's whole catalog. */
async function manapoolPrices(creds, scryfallIds) {
  mpGuard(creds);
  const ids = [...new Set((scryfallIds || []).filter(Boolean))];
  const out = new Map();   // scryfallId -> {nm, nmFoil, lpPlus, lpPlusFoil, market, marketFoil}
  const CHUNK = 100;
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  // A whole collection's worth of distinct printings can be dozens of
  // chunks - run them concurrently (capped) rather than one round trip at a
  // time, or "Refresh prices" would visibly crawl once Manapool is connected.
  const CONCURRENCY = 6;
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const data = await mpJson(creds, mpUrl("productsSingles", { scryfall_ids: chunk }));
      const list = Array.isArray(data) ? data : (data && data.data) || [];
      for (const row of list) {
        if (!row.scryfall_id) continue;
        out.set(row.scryfall_id, {
          nm: centsToDollars(row.price_cents_nm),
          nmFoil: centsToDollars(row.price_cents_nm_foil),
          lpPlus: centsToDollars(row.price_cents_lp_plus != null ? row.price_cents_lp_plus : row.price_cents),
          lpPlusFoil: centsToDollars(row.price_cents_lp_plus_foil != null ? row.price_cents_lp_plus_foil : row.price_cents_foil),
          market: centsToDollars(row.price_market),
          marketFoil: centsToDollars(row.price_market_foil)
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return out;
}

/* The raw GET /products/singles rows (lookupSingle: variants[] with
   recent_sales and available_quantity) for the Selling fast cap top-up
   (server/lib/mpSales.js, #202). One chunk of <=100 ids at a time, in
   sequence: it runs unattended in the background, so there's no reason to
   hit Manapool in parallel. onChunk(asOf, rows) gets each response as it
   lands, with meta.as_of, so nothing is accumulated here. */
async function manapoolLookupSingles(creds, scryfallIds, onChunk) {
  mpGuard(creds);
  const ids = [...new Set((scryfallIds || []).filter(Boolean))];
  let n = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const data = await mpJson(creds, mpUrl("productsSingles", { scryfall_ids: ids.slice(i, i + 100) }));
    const list = Array.isArray(data) ? data : (data && data.data) || [];
    n += list.length;
    onChunk((data && data.meta && data.meta.as_of) || null, list);
  }
  return n;
}

/* Grimoire's lowercase language codes (core.js LANG_NAMES) -> Manapool's
   uppercase language_id enum. Manapool additionally supports QYA (Quenya),
   which Grimoire still has no card data for, so there is nothing on our
   side that would ever need to map to it. DW (Dwarvish) *is* mapped below
   (support ticket, 2026-09-23) even though Scryfall carries no separate
   Dwarvish printings either - LOTR Dwarvish-rune cards are a real,
   physically-collectible variant, so a user tags one via Receive's manual
   entry mode (not the Scryfall-search mode, which only offers languages a
   given printing's own Scryfall record lists) and this map is what makes
   that manual tag round-trip correctly to a Manapool listing. */
const MP_LANG = {
  en: "EN", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "PT", ja: "JA", ko: "KO", ru: "RU",
  zhs: "CS", zht: "CT", he: "HE", la: "LA", grc: "EL", ar: "AR", sa: "SA", ph: "PH", dw: "DW"
};
/* The way back: a Manapool language_id on a listing or order line -> the
   Grimoire code. Most are the same letters lowercased, but CS/CT/EL are
   zhs/zht/grc here. Without this a Chinese listing came back as "cs", so it
   never matched its local stack, and Delist all re-sent it as English (#96). */
const MP_LANG_BACK = Object.fromEntries(Object.entries(MP_LANG).map(([k, v]) => [v.toLowerCase(), k]));
function grimoireLang(id) {
  const l = String(id || "en").toLowerCase();
  return MP_LANG_BACK[l] || l;
}

/* `card` -> the {scryfall_id, language_id, finish_id, condition_id, ...} shape
   Manapool's createListing endpoint wants for one item. Throws (rather than
   returning something half-built) if the card can't be identified, so a bulk
   caller can catch this per-item without a bad row taking down the batch. */
function mpBuildItem(card, opts) {
  if (!card.scryfallId) {
    throw Object.assign(new Error("This card has no Scryfall ID on file - Manapool needs one to identify the listing."), { status: 400 });
  }
  const o = opts || {};
  return {
    scryfall_id: card.scryfallId,
    language_id: MP_LANG[String(card.lang || "en").toLowerCase()] || "EN",
    finish_id: card.finish === "etched" ? "EF" : card.finish === "foil" ? "FO" : "NF",
    condition_id: o.condition || card.condition || "NM",
    price_cents: Number(o.price) > 0 ? Math.round(Number(o.price) * 100) : null,
    quantity: Math.max(0, Math.round(Number(o.quantity)) || 0),
    custom_external_id: null
  };
}
/* The identity of one createListing item, as a match key. Works on all
   three shapes it meets: a request item and a `skipped` row carry the four
   fields at the top level, but an `inventory` row (manapool.json
   inventoryItem) carries them nested at product.single - its own top-level
   product_id is Manapool's product id, not a Scryfall id. Reading only the
   top level meant no inventory row ever matched (#225). Case-folded so an
   uppercase Scryfall id or a lowercase condition still matches. */
function mpItemKey(it) {
  const src = (it && it.product && it.product.single) || it || {};
  return [String(src.scryfall_id || "").toLowerCase(), String(src.language_id || "").toUpperCase(),
    String(src.finish_id || "").toUpperCase(), String(src.condition_id || "").toUpperCase()].join("|");
}

/* Translates a raw Manapool skip reason into something actionable. Manapool
   requires a nonzero price_cents to CREATE a brand-new listing (but not to
   update an existing one) - it reports that as "incomplete_new_inventory",
   which reads as an opaque validation failure unless you already know that.
   Caught live against real data: a batch of never-before-listed stacks with
   no local price set all failed this way. */
function mpSkipMessage(reason, item) {
  if (reason === "incomplete_new_inventory" && item && item.price_cents == null) {
    return "Manapool needs a price to create a new listing, and this card has no price set locally. Set a price for this card, then try listing it again.";
  }
  return "Manapool skipped this item: " + reason;
}

/* Multi-item counterpart to the direct call manapoolList makes: POSTs one
   array of items (2+) to the same createListing endpoint. Confirmed
   behavior stops at "it always wants an array and bulk-sets by
   {scryfall_id, language_id, finish_id, condition_id}". Per manapool.json,
   `skipped` rows carry those fields at the top level and `inventory` rows
   carry them nested at product.single (mpItemKey reads both, #225); the
   sealed endpoint's rows both carry a top-level product_id. Whether the
   arrays preserve request order is unverified. This matches by identity
   first, and only if that finds no
   matches at all falls back to assuming request order is preserved - which
   is only safe when nothing was skipped, since a skip would shift
   positions. If neither assumption can be validated, every item in this
   call is reported unconfirmed rather than silently attributed to the
   wrong card. */
async function mpSubmitListings(creds, items, opts) {
  // pathKey/keyFn are overridable so manapoolListBulkSealed below can reuse
  // this same request/response-matching logic against a different endpoint
  // and identity shape, without duplicating the (fiddly, already-debugged)
  // inventory/skipped reconciliation - unlike mpBuildItem, this part has no
  // card-specific assumptions baked in, it just matches whatever key shape
  // it's given.
  const o = opts || {};
  const pathKey = o.pathKey || "createListing";
  const keyFn = o.keyFn || mpItemKey;
  const labels = o.labels || [];   // per item, for a readable warning (cardLabel / sealedItemLabel)
  let data;
  try {
    data = await mpJson(creds, mpUrl(pathKey), { method: "POST", body: items });
  } catch (e) {
    // A whole-batch HTTP failure (4xx/5xx) sometimes names the exact item(s)
    // it choked on in its own error payload (e.g. a 404 "Product not found"
    // with a `details` array of {scryfall_id, language_id, finish_id,
    // condition_id}) - those fields are the same shape `keyFn` already
    // matches request items on, so tag the error with which request items
    // (if any) were actually named, and with the upstream's own human
    // message, rather than making every caller re-parse e.payload itself.
    const details = e && e.payload && Array.isArray(e.payload.details) ? e.payload.details : [];
    e.badKeys = new Set(details.map(keyFn));
    e.upstreamMessage = (e && e.payload && typeof e.payload.message === "string") ? e.payload.message : null;
    throw e;
  }
  const inventory = (data && Array.isArray(data.inventory)) ? data.inventory : [];
  const skipped = (data && Array.isArray(data.skipped)) ? data.skipped : [];

  const byKey = new Map();
  for (const row of inventory) byKey.set(keyFn(row), { ok: true, row });
  for (const row of skipped) byKey.set(keyFn(row), { ok: false, reason: row.reason || "unknown reason" });
  const hits = items.map(item => byKey.get(keyFn(item)) || null);
  let rows = hits.map(h => (h && h.ok ? h.row : null));

  // Nothing matched by identity - fall back to order, but only when it's
  // actually safe to (a full-success response with no skips and a
  // matching count; anything else can't be positionally trusted).
  let matchedBy = "identity";
  if (!hits.some(Boolean)) {
    if (skipped.length === 0 && inventory.length === items.length && items.length) {
      rows = inventory.slice();
      matchedBy = "request order";
    } else {
      matchedBy = "none";
    }
  }
  const results = items.map((item, k) => {
    if (matchedBy === "none") {
      return { ok: false, error: "Manapool's response for this batch couldn't be matched back to specific items - check your Manapool listings page to confirm what actually went through." };
    }
    if (rows[k]) return mpConfirmedResult(rows[k], item, labels[k]);
    if (hits[k]) return { ok: false, error: mpSkipMessage(hits[k].reason, item) };
    // Real requests have hit this - Manapool's response sometimes omits an
    // item from both `inventory` and `skipped` with no explanation.
    return { ok: false, error: "Manapool did not confirm this item." };
  });
  // There is no other record of the raw response once this returns, so log
  // what was sent and what came back for every item (#225).
  logger(mpPushLogLine(pathKey, items, rows, hits, results, keyFn, matchedBy, inventory.length, skipped.length));
  return results;
}

/* One confirmed `inventory` row -> the per-item result. Manapool SETS the
   quantity it was sent, so a row that comes back with fewer copies than
   that (0 most of all: the listing exists but nobody can buy it) is not a
   plain success (#225). It stays ok, with Manapool's own count, so the
   local listed count records what Manapool really has, plus a `warning`
   the Listings page shows. */
function mpConfirmedResult(row, item, label) {
  const q = Number(row.quantity);
  const quantity = row.quantity != null && Number.isFinite(q) ? q : null;
  const out = { ok: true, listingId: String(row.id || ""), quantity, price: centsToDollars(row.price_cents) };
  const sent = Number(item.quantity);
  if (quantity != null && Number.isFinite(sent) && quantity < sent) {
    const name = label || "An item";
    out.warning = quantity <= 0
      ? name + ": Manapool accepted the push but shows 0 copies for sale (Grimoire sent " + sent +
        "), so it won't appear in your Manapool listings. Grimoire now counts 0 listed. " +
        "Check this card on Manapool's site, then push it again."
      : name + ": Manapool shows only " + quantity + " of the " + sent + " copies Grimoire sent. " +
        "Grimoire now counts " + quantity + " listed. Check this card on Manapool's site, then push it again if that's wrong.";
  }
  return out;
}

/* The server.log line for one createListing batch: per item, its identity
   key, the quantity and price (cents) sent, and what Manapool returned or
   why not. Identity keys and numbers only - no credentials, names or
   emails. Capped at MP_LOG_ITEMS items so one line stays a bounded size;
   that cap is at least MP_LIST_BATCH_SIZE, so a bulk push logs every item. */
const MP_LOG_ITEMS = 100;
function mpPushLogLine(pathKey, items, rows, hits, results, keyFn, matchedBy, nInventory, nSkipped) {
  const v = x => (x == null ? "null" : String(x));
  const count = pred => results.filter(pred).length;
  const parts = items.slice(0, MP_LOG_ITEMS).map((item, k) => {
    const sent = "q" + v(item.quantity) + "@" + v(item.price_cents);
    const got = rows[k] ? "q" + v(rows[k].quantity) + "@" + v(rows[k].price_cents) + (results[k].warning ? " SHORT" : "")
      : hits[k] && !hits[k].ok ? "skipped:" + hits[k].reason
      : "unconfirmed";
    return keyFn(item) + " " + sent + " -> " + got;
  });
  if (items.length > MP_LOG_ITEMS) parts.push("+" + (items.length - MP_LOG_ITEMS) + " more");
  return "Manapool " + pathKey + ": " + items.length + " item(s) sent, matched by " + matchedBy +
    " (inventory=" + nInventory + ", skipped=" + nSkipped + "); " +
    count(r => r.ok && !r.warning) + " ok, " + count(r => r.warning) + " short, " +
    count(r => !r.ok) + " failed. Sent -> returned (quantity@price_cents): " + parts.join(", ");
}

/* Create or update a single listing. `card` is a Grimoire inventory row.
   Deliberately not routed through mpSubmitListings' identity-key matching
   below - for a single item, which response row is "the" row was never in
   question, so this keeps the original, fully-confirmed positional read
   (data.inventory[0] / data.skipped[0]) rather than inheriting the bulk
   path's fallback logic for a case that never needed it. */
async function manapoolList(creds, card, opts) {
  mpGuardInventoryWrite(creds);
  const item = mpBuildItem(card, opts);
  const data = await mpJson(creds, mpUrl("createListing"), { method: "POST", body: [item] });
  const updated = (data && Array.isArray(data.inventory) && data.inventory[0]) || null;
  const skipped = (data && Array.isArray(data.skipped) && data.skipped[0]) || null;
  if (skipped) {
    throw Object.assign(new Error("Manapool skipped this item: " + (skipped.reason || "unknown reason")), { status: 409 });
  }
  return {
    ok: true,
    listingId: updated ? String(updated.id || "") : "",
    quantity: updated ? Number(updated.quantity) : null,
    price: updated ? centsToDollars(updated.price_cents) : null,
    raw: data
  };
}

/* A bulk push of any size is split into calls of this many items each, sent
   one at a time (never in parallel) so each batch's per-item success/failure
   is known before the next batch goes out. Matches the browser's
   MANAPOOL_BATCH_SIZE (core.js). Manapool's spec allows up to 2000 items per
   request on both create endpoints (manapool.json, maxItems); 100 keeps each
   request small and its log line whole (MP_LOG_ITEMS), while needing a fifth
   of the round trips the old 20 did (#480: 7,419 listings took 372 requests
   and ~50 s). Keep MP_LOG_ITEMS >= this. */
const MP_LIST_BATCH_SIZE = 100;

/* A card's own name/printing, for an error message a user can actually act
   on - never Manapool's identity fields (scryfall_id etc.), which mean
   nothing outside Manapool's own database. */
function cardLabel(card) {
  if (!card || !card.name) return "an item";
  const bits = [String(card.set || "").toUpperCase(), card.collector ? "#" + card.collector : ""].filter(Boolean);
  return card.name + (bits.length ? " (" + bits.join(" ") + ")" : "");
}
function sealedItemLabel(item) {
  if (!item || !item.name) return "an item";
  return item.name + (item.setCode ? " (" + String(item.setCode).toUpperCase() + ")" : "");
}

/* Shared by manapoolListBulk/manapoolListBulkSealed's catch blocks below: a
   whole-batch failure (mpSubmitListings threw, see its own comment on
   e.badKeys/e.upstreamMessage) needs turning into one result per item in
   the batch. When Manapool's error payload named specific item(s), only
   those get blamed by name - anything else in the batch was an innocent
   bystander caught by the same rejected request, not itself the problem,
   so it gets a distinct message rather than implying it was also bad. */
function attributeBatchFailure(e, items, labels, itemIndexes, results, keyFn) {
  const badKeys = e.badKeys || new Set();
  const upstream = e.upstreamMessage;
  for (let k = 0; k < items.length; k++) {
    const index = itemIndexes[k];
    if (badKeys.size && badKeys.has(keyFn(items[k]))) {
      results[index] = { ok: false, error: "Manapool rejected " + labels[k] + (upstream ? ": " + upstream : "") + "." };
    } else if (badKeys.size) {
      results[index] = { ok: false, error: "Not sent - a different item in this same batch" +
        (upstream ? " (" + upstream + ")" : "") + " caused Manapool to reject the whole request. Try again to retry this one." };
    } else {
      results[index] = { ok: false, error: e.message };
    }
  }
}

/* Sends one batch through mpSubmitListings and writes one result per item
   into `results` at its itemIndexes slot. When Manapool rejects the whole
   request but names the item(s) it choked on (e.badKeys), the batch is sent
   once more without them (#480), so one bad card doesn't sink the other 99:
   the named ones fail with their own "Manapool rejected ..." message, the
   rest get the retry's own results. If the retry throws too, its error is
   attributed the same way. Nothing named, or every item named: no retry. */
async function mpSubmitBatch(creds, items, labels, itemIndexes, results, opts) {
  const o = opts || {};
  const keyFn = o.keyFn || mpItemKey;
  const send = (its, lbls) => mpSubmitListings(creds, its, Object.assign({}, o, { labels: lbls }));
  try {
    (await send(items, labels)).forEach((r, k) => { results[itemIndexes[k]] = r; });
    return;
  } catch (e) {
    const bad = e.badKeys || new Set();
    const rest = [];
    items.forEach((it, k) => { if (!bad.has(keyFn(it))) rest.push(k); });
    if (!bad.size || !rest.length || rest.length === items.length) {
      attributeBatchFailure(e, items, labels, itemIndexes, results, keyFn);
      return;
    }
    const named = items.map((_, k) => k).filter(k => !rest.includes(k));
    const pick = (arr, ks) => ks.map(k => arr[k]);
    attributeBatchFailure(e, pick(items, named), pick(labels, named), pick(itemIndexes, named), results, keyFn);
    try {
      (await send(pick(items, rest), pick(labels, rest))).forEach((r, j) => { results[itemIndexes[rest[j]]] = r; });
    } catch (e2) {
      attributeBatchFailure(e2, pick(items, rest), pick(labels, rest), pick(itemIndexes, rest), results, keyFn);
    }
  }
}

/* Bulk create/update listings for an arbitrary-size list of Grimoire
   inventory rows. `entries` is [{card, quantity, price, condition}, ...].
   The result array lines up 1:1 with `entries` regardless of batching. If a
   whole batch's request fails outright (bad auth, dropped connection, etc.)
   - as opposed to Manapool accepting the request but skipping some items in
   it - every item in that batch is recorded as failed (named by whichever
   card Manapool's own error actually pointed at, see attributeBatchFailure;
   when it did name one, the rest of the batch is retried once without it,
   see mpSubmitBatch) and the remaining batches are still attempted, so a transient blip on one
   batch doesn't abandon cards that were never even tried. */
async function manapoolListBulk(creds, entries) {
  mpGuardInventoryWrite(creds);
  const results = new Array(entries.length);
  for (let start = 0; start < entries.length; start += MP_LIST_BATCH_SIZE) {
    const batch = entries.slice(start, start + MP_LIST_BATCH_SIZE)
      .map((entry, j) => ({ entry, index: start + j }));
    const items = [];
    const labels = [];
    const itemIndexes = [];
    for (const { entry, index } of batch) {
      try {
        items.push(mpBuildItem(entry.card, entry));
        labels.push(cardLabel(entry.card));
        itemIndexes.push(index);
      } catch (e) {
        results[index] = { ok: false, error: e.message };
      }
    }
    if (!items.length) continue;
    await mpSubmitBatch(creds, items, labels, itemIndexes, results);
  }
  return results;
}

/* Sealed's counterpart to mpBuildItem above - a genuinely different
   identity/shape, not a parameterization of it: Manapool's sealed endpoint
   (POST /seller/inventory/product, confirmed in BACKLOG.md #24) keys by
   their own product_id, not scryfall_id, and needs an explicit
   product_type. `item` is a Grimoire state.sealed row. */
function mpBuildSealedItem(item, opts) {
  if (!item.manapoolProductId) {
    throw Object.assign(new Error("This product has no Manapool product ID on file - Manapool needs one to identify the listing."), { status: 400 });
  }
  const o = opts || {};
  return {
    product_type: "mtg_sealed",
    product_id: item.manapoolProductId,
    price_cents: Number(o.price) > 0 ? Math.round(Number(o.price) * 100) : null,
    quantity: Math.max(0, Math.round(Number(o.quantity)) || 0)
  };
}
const mpSealedItemKey = it => String(it.product_id || "");

/* Bulk create/update sealed listings - same batching/per-batch-failure-
   isolation shape as manapoolListBulk above, pointed at the sealed
   endpoint via mpSubmitListings' pathKey/keyFn overrides. `entries` is
   [{item, quantity, price}, ...] where `item` is a state.sealed row.
   Response row shape (id/quantity/price_cents) assumed to mirror the
   singles endpoint's, per BACKLOG #24's request-shape scoping - unverified
   against a live response, same as the rest of sealed's Manapool write
   path, since it's blocked on real sandbox credentials (BACKLOG #8). */
async function manapoolListBulkSealed(creds, entries) {
  mpGuardInventoryWrite(creds);
  const results = new Array(entries.length);
  for (let start = 0; start < entries.length; start += MP_LIST_BATCH_SIZE) {
    const batch = entries.slice(start, start + MP_LIST_BATCH_SIZE)
      .map((entry, j) => ({ entry, index: start + j }));
    const items = [];
    const labels = [];
    const itemIndexes = [];
    for (const { entry, index } of batch) {
      try {
        items.push(mpBuildSealedItem(entry.item, entry));
        labels.push(sealedItemLabel(entry.item));
        itemIndexes.push(index);
      } catch (e) {
        results[index] = { ok: false, error: e.message };
      }
    }
    if (!items.length) continue;
    await mpSubmitBatch(creds, items, labels, itemIndexes, results, { pathKey: "createSealedListing", keyFn: mpSealedItemKey });
  }
  return results;
}

/* ---------------------- Order Entry: move listings by an order (#432) ----------------------
   A card sold at the counter or the kiosk is still listed on Manapool, so an
   online buyer could take the same copy (#402, owner's answer 7). When an
   Order Entry order goes in, each of its listings comes down by the copies on
   it; when the order is cancelled, back up by what came down.

   Manapool's write SETS a quantity (there is no "take 2 off"), so each listing
   is read first (GET seller/inventory/scryfall_id/{id} with its language,
   finish and condition: a 404 means no such listing) and the new number is
   written with price_cents null, which the spec (manapool.com/api/docs/v1/
   openapi.json, v0.57.3) defines as "leaves the existing value unchanged".
   custom_external_id is left out of the write, not sent as null, so nothing
   but the quantity moves. A card with no listing is skipped, never created
   (Manapool would skip a new listing with no price anyway:
   incomplete_new_inventory). Both calls are per the published spec only, not
   yet seen against a live account; every write still goes through
   mpSubmitListings, which matches and logs exactly what came back.

   The read and the write are two calls, so a Manapool sale landing in the
   moment between them is overwritten. That can leave a listing one copy off
   until the next Fetch listings, never a wrong price. */
const MP_ADJUST_MAX = 200;
const mpListingParams = item => ({ language_id: item.language_id, finish_id: item.finish_id, condition_id: item.condition_id });

/* entries: [{ card: {scryfallId, lang, finish, condition, name, set, collector}, delta }],
   one per listing (the caller folds repeats). Resolves 1:1 to
   { ok, listed, before, quantity, change } or { ok: false, error }. listed
   false: Manapool has no such listing (or the card has no Scryfall ID, so
   Grimoire never listed it), and nothing was sent. */
async function manapoolAdjustListings(creds, entries) {
  mpGuardInventoryWrite(creds);
  const results = new Array(entries.length);
  const writes = [];
  for (let i = 0; i < entries.length; i++) {
    const { card, delta } = entries[i];
    if (!card || !card.scryfallId) { results[i] = { ok: true, listed: false, change: 0 }; continue; }
    const id = mpBuildItem(card, { quantity: 0 });
    let before;
    try {
      const data = await mpJson(creds, mpUrl("listing", mpListingParams(id), { scryfall_id: id.scryfall_id }));
      const inv = data && data.inventory;
      if (!inv || inv.quantity == null || !Number.isFinite(Number(inv.quantity))) {
        results[i] = { ok: false, error: "Manapool's reply didn't say how many are listed." };
        continue;
      }
      before = Number(inv.quantity);
    } catch (e) {
      results[i] = e.upstream === 404 ? { ok: true, listed: false, change: 0 } : { ok: false, error: e.message };
      continue;
    }
    const quantity = Math.max(0, Math.min(99999, before + Math.round(Number(delta) || 0)));
    if (quantity === before) { results[i] = { ok: true, listed: true, before, quantity, change: 0 }; continue; }
    writes.push({ index: i, before, label: cardLabel(card), item: {
      scryfall_id: id.scryfall_id, language_id: id.language_id, finish_id: id.finish_id, condition_id: id.condition_id,
      price_cents: null, quantity } });
  }
  for (let start = 0; start < writes.length; start += MP_LIST_BATCH_SIZE) {
    const batch = writes.slice(start, start + MP_LIST_BATCH_SIZE);
    const items = batch.map(w => w.item), labels = batch.map(w => w.label);
    const rs = [];
    await mpSubmitBatch(creds, items, labels, batch.map((w, k) => k), rs);
    batch.forEach((w, k) => {
      const r = rs[k] || { ok: false, error: "Manapool did not confirm this item." };
      if (!r.ok) { results[w.index] = { ok: false, error: r.error }; return; }
      const quantity = r.quantity == null ? w.item.quantity : r.quantity;
      results[w.index] = { ok: true, listed: true, before: w.before, quantity, change: quantity - w.before };
    });
  }
  return results;
}

/* An Order Entry order's listings, moved (#432): "entered" lowers each by its
   qty, "cancelled" raises it by its qty (the caller sends what entering took
   down, so a card that wasn't lowered isn't raised). lines: [{ scryfallId,
   lang, finish, condition, name, set, collector, qty }]; the same listing
   twice is folded into one. An account without Manapool resolves
   { connected: false } with nothing sent, never an error. `ref` (the order's
   id) is only for the log line. Resolves
   { connected, results: [{ card, qty, ok, listed, before, quantity, change, error }] }. */
async function manapoolOrderEntrySync(creds, event, lines, ref) {
  if (!mpReady(creds)) return { connected: false, results: [] };
  const sign = event === "cancelled" ? 1 : -1;
  const byKey = new Map();
  for (const l of lines || []) {
    const qty = Math.round(Number(l && l.qty));
    if (!(qty > 0)) continue;
    const card = { scryfallId: String(l.scryfallId || ""), lang: l.lang || "en", finish: l.finish || "nonfoil",
      condition: l.condition || "NM", name: String(l.name || ""), set: String(l.set || ""), collector: String(l.collector || "") };
    const key = card.scryfallId ? mpItemKey(mpBuildItem(card, { quantity: 0 })) : "no-scryfall-id|" + byKey.size;
    const ex = byKey.get(key);
    if (ex) ex.qty += qty; else byKey.set(key, { key, card, qty });
  }
  const groups = [...byKey.values()].slice(0, MP_ADJUST_MAX);
  if (!groups.length) return { connected: true, results: [] };
  const rs = await manapoolAdjustListings(creds, groups.map(g => ({ card: g.card, delta: sign * g.qty })));
  const results = groups.map((g, i) => Object.assign({ card: g.card, qty: g.qty }, rs[i]));
  // Identity keys and numbers only, as mpPushLogLine: no names or credentials.
  const failed = groups.map((g, i) => [g.key, results[i]]).filter(([, r]) => !r.ok);
  logger("Manapool order entry " + event + (ref ? " " + String(ref).slice(0, 40) : "") + ": " + results.length + " listing(s), " +
    results.filter(r => r.ok && r.change).length + " moved, " + results.filter(r => r.ok && !r.listed).length + " not listed, " +
    failed.length + " failed" + (failed.length ? " - " + failed.slice(0, MP_LOG_ITEMS)
      .map(([k, r]) => k + ": " + String(r.error || "").slice(0, 160)).join("; ") : ""));
  return { connected: true, results };
}

/* ---------------------- Buyer side: what this account BOUGHT (#353) ----------------------
   Everything above is the seller side. These read the account's purchases so
   Receive can turn one into a lot receipt, and mark a seller's package
   received. Same credentials (Manapool's spec gives the buyer endpoints the
   same email + access-token headers), same 403 for a refused token.
   Shapes per manapool.com/api/docs/v1/openapi.json (v0.53): an order has
   order_seller_details[], one per seller package; only the single-order
   endpoint fills each package's items[] and refunded_items[]. */
const MP_FINISH_BACK = { NF: "nonfoil", FO: "foil", EF: "etched" };
const MP_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];

/* One purchased product -> the identity Receive needs. A card keeps Manapool's
   own set/number as a fallback; the route swaps in the card index's printing
   by scryfall id. */
function buyerProduct(product) {
  const p = product || {};
  if (p.product_type === "mtg_sealed") {
    const s = p.sealed || {};
    return { kind: "sealed", manapoolProductId: String(p.product_id || ""), name: String(s.name || ""),
      setCode: String(s.set || "").toLowerCase(), lang: grimoireLang(s.language_id || "en") };
  }
  const s = p.single || {};
  const cond = String(s.condition_id || "").toUpperCase();
  return {
    kind: "card", manapoolProductId: String(p.product_id || ""), scryfallId: String(s.scryfall_id || ""),
    name: String(s.name || ""), set: String(s.set || "").toLowerCase(), collector: String(s.number || ""),
    lang: grimoireLang(s.language_id || "en"),
    finish: MP_FINISH_BACK[String(s.finish_id || "").toUpperCase()] || "nonfoil",
    // "UC" (no condition given) has no Grimoire grade: it comes in as NM, editable on the line.
    condition: MP_CONDITIONS.includes(cond) ? cond : "NM"
  };
}

/* A package's items -> receivable lines. Refunded copies won't arrive, so
   they come off the quantity (shipped_quantity already is ordered minus
   refunded). Replaced copies arrive as a different product: they become
   their own line, priced at what was paid less any partial refund. */
function buyerItems(pkg) {
  const refunded = new Map();
  for (const r of Array.isArray(pkg.refunded_items) ? pkg.refunded_items : []) {
    refunded.set(r.order_item_id, (refunded.get(r.order_item_id) || 0) + (Number(r.quantity) || 0));
  }
  const out = [];
  for (const it of Array.isArray(pkg.items) ? pkg.items : []) {
    const ordered = Number(it.quantity) || 0;
    const back = refunded.get(it.order_item_id) || 0;
    const shipped = it.shipped_quantity != null ? Number(it.shipped_quantity) || 0 : Math.max(0, ordered - back);
    const rep = it.replacement || null;
    const replaced = rep ? Math.min(shipped, Number(rep.quantity) || 0) : 0;
    const unitPrice = centsToDollars(it.price_cents) || 0;
    const base = { orderItemId: String(it.order_item_id || ""), ordered, refunded: back };
    if (shipped - replaced > 0) {
      out.push(Object.assign(buyerProduct(it.product), base, { unitPrice, qty: shipped - replaced }));
    }
    if (replaced > 0 && rep.product) {
      const partial = (Number(rep.refunded_cents) || 0) / replaced;
      out.push(Object.assign(buyerProduct(rep.product), base, {
        replacement: true, qty: replaced,
        unitPrice: Math.max(0, Math.round(Number(it.price_cents || 0) - partial) / 100)
      }));
    }
  }
  return out;
}

function normalizeBuyerOrder(raw) {
  const r = raw || {};
  return {
    id: String(r.id || ""),
    orderNumber: String(r.order_number || ""),
    createdAt: String(r.created_at || ""),
    subtotal: centsToDollars(r.subtotal_cents) || 0,
    tax: centsToDollars(r.tax_cents) || 0,
    shipping: centsToDollars(r.shipping_cents) || 0,
    total: centsToDollars(r.total_cents) || 0,
    packages: (Array.isArray(r.order_seller_details) ? r.order_seller_details : []).map(p => ({
      id: String(p.id || ""),
      orderNumber: String(p.order_number || ""),
      seller: String(p.seller_username || ""),
      shipping: centsToDollars(p.shipping_cents) || 0,
      // When the buyer marked it received on Manapool (null = not yet).
      receivedAt: p.buyer_confirmed_at || null,
      itemCount: Number(p.item_count) || 0,
      // The list endpoint carries no items; only the single-order one does.
      detailed: Array.isArray(p.items),
      items: buyerItems(p),
      refunds: (Array.isArray(p.refunded_items) ? p.refunded_items : []).map(x => Object.assign(buyerProduct(x.product), {
        qty: Number(x.quantity) || 0, refunded: centsToDollars(x.refunded_cents)
      }))
    }))
  };
}

/* One page of purchases, newest first. Manapool pages these by offset. */
async function manapoolBuyerOrders(creds, params) {
  mpGuard(creds);
  const o = params || {};
  const limit = Math.min(100, Math.max(1, Number(o.limit) || 25));
  const offset = Math.max(0, Number(o.offset) || 0);
  const data = await mpJson(creds, mpUrl("buyerOrders", { limit, offset }));
  const list = (data && (data.orders || data.data)) || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(normalizeBuyerOrder)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function manapoolBuyerOrder(creds, id) {
  mpGuard(creds);
  const data = await mpJson(creds, mpUrl("buyerOrder", {}, { id }));
  return normalizeBuyerOrder((data && (data.order || data.data)) || data || {});
}

/* Marks one seller's package received on Manapool. A write to the user's
   account: only Receive's "Also mark received on Mana Pool" box calls it. */
async function manapoolMarkReceived(creds, sellerOrderId) {
  mpGuard(creds);
  const data = await mpJson(creds, mpUrl("buyerReceived", {}, { id: sellerOrderId }), { method: "POST" });
  return { sellerOrderId: String((data && data.seller_order_id) || sellerOrderId),
    receivedAt: (data && data.received_at) || new Date().toISOString() };
}

/* Marking a sold order shipped on Manapool (#454). Manapool has no explicit
   "tracking required" flag; an order's shipping_method does it:
   ground_advantage is USPS's tracked package service, so tracking is
   required (carrier USPS), first_class is a letter with none. The same rule
   lives in core.js orderNeedsTracking for the dialog; this one is the
   server's own check before it sends anything. */
const TRACKED_SHIPPING = new Set(["ground_advantage"]);
function orderNeedsTracking(order) {
  const m = order && (order.shippingMethod || (order.raw && order.raw.shipping_method));
  return TRACKED_SHIPPING.has(String(m || "").trim().toLowerCase());
}

const httpUrl = v => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.toString() : ""; } catch (e) { return ""; } };
/* PUT /seller/orders/{id}/fulfillment's body: status "shipped", plus the
   tracking only when there's a number. A USPS number gets USPS's own
   tracking page as its link (Manapool wants http/https there or nothing). */
function mpFulfillmentBody(tracking) {
  const t = tracking || {};
  const body = { status: "shipped" };
  const number = String(t.number || "").trim();
  if (!number) return body;
  const company = String(t.company || "").trim();
  body.tracking_number = number;
  if (company) body.tracking_company = company;
  const url = httpUrl(t.url) ||
    (/^usps$/i.test(company) ? "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + encodeURIComponent(number) : "");
  if (url) body.tracking_url = url;
  return body;
}

/* Words for a failed push, for the ticket's "Not sent to Manapool" line:
   the owner reads these, so no URLs or raw JSON. */
function mpShipFailure(e) {
  const up = e && e.upstream;
  const said = e && e.payload && typeof e.payload.message === "string" ? e.payload.message.trim() : "";
  const details = e && e.payload && Array.isArray(e.payload.details) ? e.payload.details.filter(d => typeof d === "string") : [];
  const theirs = [said, ...details].filter(Boolean).join(": ").slice(0, 300);
  if (up === 401 || up === 403) return "Mana Pool turned down Grimoire's connection. Reconnect Mana Pool in Settings → Integrations, then retry.";
  if (up === 404) return "Manapool has no such order on this account.";
  if (up === 400 || up === 422) return "Manapool refused it" + (theirs ? ": " + theirs : ".");
  if (e && e.status === 504) return "Manapool didn't answer in time.";
  if (e && e.status === 501) return e.message;
  if (up) return "Manapool had a problem (error " + up + ")" + (theirs ? ": " + theirs : ".");
  return "Couldn't reach Manapool.";
}

/* One write to the seller's account: marks the order shipped. Resolves
   { ok: true, alreadyDone, sent } (409 "already released" counts as done:
   it's shipped there either way); any other refusal throws, as jsonRequest
   does. */
async function manapoolMarkShipped(creds, orderId, tracking) {
  mpGuard(creds);
  const body = mpFulfillmentBody(tracking);
  try {
    const data = await mpJson(creds, mpUrl("orderFulfillment", {}, { id: orderId }), { method: "PUT", body });
    const f = (data && data.fulfillment) || {};
    return { ok: true, alreadyDone: false, sent: body, status: f.status || "shipped" };
  } catch (e) {
    if (e.upstream === 409) return { ok: true, alreadyDone: true, sent: body, status: "shipped" };
    throw e;
  }
}

/* ============================ Pitney Bowes ============================ */
const pb = () => cfg.pitneyBowes || {};
function pbFeatureOn() { return !!pb().enabled; }
function pbReady(creds) { return pbFeatureOn() && !!(creds && creds.apiKey && creds.apiSecret); }
function pbGuard(creds) {
  if (!pbFeatureOn()) {
    throw Object.assign(
      new Error("Shipping labels are turned off for this server. An administrator needs to set " +
        "pitneyBowes.enabled in config.json, then restart."), { status: 501 });
  }
  if (!pbReady(creds)) {
    throw Object.assign(
      new Error("Pitney Bowes is not connected. Add your API key and secret in " +
        "Settings → Integrations, then try again."), { status: 501 });
  }
}

const pbTokens = new Map();      // userId -> {token, exp} - one account per user, not one shared token
async function pbAccessToken(creds, userId) {
  pbGuard(creds);
  const cached = pbTokens.get(userId);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const url = new URL((pb().paths || {}).token || "/oauth/token", pb().baseUrl).toString();
  const basic = Buffer.from(creds.apiKey + ":" + creds.apiSecret).toString("base64");
  const res = await fetchRetry(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + basic,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: "grant_type=client_credentials"
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error("Pitney Bowes token request failed: HTTP " + res.status + " " +
      text.slice(0, 200)), { status: 502 });
  }
  let data = {};
  try { data = JSON.parse(text); } catch (e) {}
  const token = data.access_token || data.accessToken;
  if (!token) throw Object.assign(new Error("Pitney Bowes returned no access token."), { status: 502 });
  const ttl = Number(data.expires_in || data.expiresIn || 3600) * 1000;
  pbTokens.set(userId, { token, exp: Date.now() + ttl });
  return token;
}

async function shippingStatus(creds, userId) {
  if (!pbFeatureOn()) return { enabled: false, configured: false };
  if (!pbReady(creds)) return { enabled: true, configured: false };
  try {
    await pbAccessToken(creds, userId);
    return { enabled: true, configured: true, ok: true, baseUrl: pb().baseUrl };
  } catch (e) {
    return { enabled: true, configured: true, ok: false, error: e.message };
  }
}

function pbAddress(a) {
  return {
    name: a.name || "",
    company: a.company || "",
    addressLines: [a.line1 || a.addressLines && a.addressLines[0] || "", a.line2 || ""].filter(Boolean),
    cityTown: a.city || a.cityTown || "",
    stateProvince: a.state || a.stateProvince || "",
    postalCode: a.postal || a.postalCode || "",
    countryCode: (a.country || a.countryCode || "US").slice(0, 2).toUpperCase(),
    phone: a.phone || "",
    email: a.email || "",
    residential: a.residential !== false
  };
}

/* Create one label. Returns whatever URL / tracking number came back, plus the
   raw payload - PB's response shape differs by carrier and account. */
async function createLabel(creds, userId, opts) {
  pbGuard(creds);
  const o = opts || {};
  if (!o.to || !(o.to.line1 || (o.to.addressLines && o.to.addressLines[0]))) {
    throw Object.assign(new Error("A destination address with at least a street line is required."), { status: 400 });
  }
  const token = await pbAccessToken(creds, userId);
  const parcelCfg = pb().parcel || {};
  const parcel = {
    weight: { unitOfMeasurement: "OZ", weight: Number(o.weightOz || parcelCfg.weightOz || 3) },
    dimension: {
      unitOfMeasurement: "IN",
      length: Number(o.lengthIn || parcelCfg.lengthIn || 9),
      width: Number(o.widthIn || parcelCfg.widthIn || 6),
      height: Number(o.heightIn || parcelCfg.heightIn || 1)
    }
  };
  const body = {
    fromAddress: pbAddress(pb().from || {}),
    toAddress: pbAddress(o.to),
    parcel,
    rates: [{
      carrier: o.carrier || pb().carrier || "USPS",
      parcelType: o.parcelType || pb().parcelType || "PKG",
      serviceId: o.service || pb().service || "PM"
    }],
    documents: [{
      type: "SHIPPING_LABEL",
      contentType: "URL",
      size: "DOC_4X6",
      fileFormat: "PDF",
      printDialogOption: "NO_PRINT_DIALOG"
    }],
    shipmentOptions: [
      { name: "SHIPPER_ID", value: creds.shipperId },
      { name: "ADD_TO_MANIFEST", value: "true" }
    ],
    references: o.reference ? [{ name: "ORDER_ID", value: String(o.reference) }] : undefined
  };
  const url = new URL((pb().paths || {}).shipments || "/shippingservices/v1/shipments", pb().baseUrl).toString();
  const data = await jsonRequest(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "X-PB-TransactionId": "grimoire-" + Date.now().toString(36) +
        "-" + Math.random().toString(36).slice(2, 8)
    },
    body
  });
  const docs = (data && data.documents) || [];
  return {
    ok: true,
    shipmentId: pick(data, ["shipmentId", "parcelTrackingNumber", "id"], ""),
    tracking: pick(data, ["parcelTrackingNumber", "trackingNumber"], ""),
    labelUrl: (docs[0] && (docs[0].contents || docs[0].url)) || "",
    totalCharge: pick(data, ["rates.0.totalCarrierCharge", "rates.0.baseCharge"], null),
    raw: data
  };
}

module.exports = {
  init,
  manapoolEnabled: mpFeatureOn, manapoolStatus, manapoolOrders, manapoolOrder, manapoolOrderDetails, manapoolList, manapoolListBulk, manapoolInventory,
  manapoolPrices, manapoolCatalogPrices, manapoolSealedCatalog, manapoolListBulkSealed, manapoolLookupSingles, manapoolAdjustListings, manapoolOrderEntrySync,
  manapoolBuyerOrders, manapoolBuyerOrder, manapoolMarkReceived, normalizeBuyerOrder,
  manapoolMarkShipped, mpFulfillmentBody, mpShipFailure, orderNeedsTracking,
  manapoolReady: mpReady, manapoolCanWriteInventory: mpCanWriteInventory, MP_OTHER_APP,
  shippingEnabled: pbFeatureOn, shippingStatus, createLabel,
  normalizeOrder, normalizeListing, orderIsFinal, ordersToRecheck
};
