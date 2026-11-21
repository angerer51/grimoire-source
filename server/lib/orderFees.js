"use strict";
/* One-time backfill of Manapool fees and shipping on old sales (#452).
   -------------------------------------------------------------------
   Completing a Manapool pick list copies the order's payment breakdown
   (p.orderPayment, captured when the list was made) onto the sale once:
   fees, earnings (Manapool's net payout), shippingRevenue, and the shipping
   added into revenue (core.js completePickList). Sales completed before the
   orders cache carried a `payment` breakdown (early Sep 2026) kept null
   there for good, so Accounting said "Fees unknown" for them. This fills
   them in from the orders caches, fetching the detail of any order that
   still has no payment through the Manapool connection of the account
   whose cache holds it (orders are cached per signed-in user, not per
   store: see orderLabels.js).

   Exactly what completion does, applied late: fees = payment.fee,
   earnings = payment.net, shippingRevenue = payment.shipping and
   revenue += shipping. Only a picked/shipped Manapool sale with an order id
   and no fees is touched, and shipping is only added when the sale has no
   shippingRevenue yet, so a second run (or a sale already right) changes
   nothing. A sale whose order Manapool can't return stays null; the
   Accounting note keeps counting it.

   Runs in the background after the server starts listening (index.js), so
   the Manapool calls never hold up boot or the restart handshake. Each
   collection is changed through store.updateCollection: read, changed and
   written under the collection's lock with a new rev, so an open tab's
   next save merges with it (merge.js) instead of overwriting it.

   Done marker: set once a run has read and written everything and every
   order it needed either came back or was refused for good (Manapool said
   no such order, or the account has no Manapool connection). If a fetch
   failed in a way that could pass (Manapool down, a timeout, a rejected
   token) the run still fills everything it could, and a later boot tries
   again, up to MAX_TRIES boots in all; after that it is marked done with
   whatever is left null, so it doesn't re-read every collection on every
   boot forever. */

const fs = require("fs");
const path = require("path");
const store = require("./store");
const integrations = require("./integrations");
const mpAuth = require("./mpAuth");
const { ownerKeys } = require("./orderLabels");

const MARKER = "pickListFeesBackfill";
const MAX_TRIES = 3;
const CONCURRENCY = 3; // gentler than Fetch orders' 6: nobody is waiting on this

const round2 = n => Math.round(Number(n) * 100) / 100;

/* A completed Manapool sale still missing Manapool's figures. pickedAt is
   what makes it a sale (G.saleDate's rule): lists shipped before completion
   recorded sales (late Aug 2026) have none, no revenue or cost, and are
   left alone. */
const needsFees = p => !!(p && p.source === "manapool" && p.orderId && p.fees == null && p.pickedAt &&
  (p.status === "picked" || p.status === "shipped"));

/* A payment breakdown good enough to fill a sale from: at least the fee. */
const usablePayment = pay => !!(pay && typeof pay === "object" && pay.fee != null);

/* The cached order's payment, or one rebuilt from the raw detail it was
   stored with (an order fetched before normalizeOrder kept `payment` can
   still hold it under raw). */
function paymentOf(order) {
  if (!order) return null;
  if (usablePayment(order.payment)) return order.payment;
  if (order.raw && order.raw.payment) {
    const pay = integrations.normalizeOrder(order.raw).payment;
    if (usablePayment(pay)) return pay;
  }
  return null;
}

/* Fills the sales in place from `payments` (order id -> payment). Returns
   { filled, missing }: missing = sales that still need fees afterwards. */
function fillFees(state, payments) {
  let filled = 0, missing = 0;
  for (const p of state && Array.isArray(state.pickLists) ? state.pickLists : []) {
    if (!needsFees(p)) continue;
    const pay = payments.get(String(p.orderId));
    if (!usablePayment(pay)) { missing++; continue; }
    if (!p.orderPayment) p.orderPayment = Object.assign({}, pay);
    p.fees = pay.fee;
    p.earnings = pay.net == null ? null : pay.net;
    if (p.shippingRevenue == null && pay.shipping != null) {
      p.shippingRevenue = pay.shipping;
      p.revenue = round2((Number(p.revenue) || 0) + Number(pay.shipping));
    }
    filled++;
  }
  return { filled, missing };
}

/* Order id -> { payment, holders: [user id] } for just the ids asked for,
   from every account's orders cache, one file at a time. */
async function indexOrders(ids) {
  const out = new Map();
  let unreadable = 0;
  let files = [];
  try { files = await fs.promises.readdir(store.p("orders")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const userId = path.basename(f, ".json");
    let doc;
    try { doc = await store.readOrders(userId); }
    catch (e) { unreadable++; continue; }
    for (const o of (doc && Array.isArray(doc.orders)) ? doc.orders : []) {
      const id = o && o.id != null ? String(o.id) : "";
      if (!id || !ids.has(id)) continue;
      const entry = out.get(id) || { payment: null, holders: [] };
      if (!entry.holders.includes(userId)) entry.holders.push(userId);
      if (!entry.payment) entry.payment = paymentOf(o);
      out.set(id, entry);
    }
  }
  return { orders: out, unreadable };
}

/* For good: Manapool says there's no such order, or this server/account
   has no Manapool connection. Anything else (a timeout, 5xx, a rejected
   token, no network) might work on a later boot. */
const finalFailure = e => !!(e && (e.upstream === 404 || e.upstream === 410 || e.status === 501));

/* Fetches each order's detail through a holder's own connection, trying
   the next holder when one can't. Returns { fetched: Map user id -> [order],
   payments: Map id -> payment, unfetchable, retry }. */
async function fetchMissing(need, opts) {
  const fetchOrder = opts.fetchOrder;
  const log = opts.log;
  const credsOf = new Map();
  const fetched = new Map();
  const payments = new Map();
  const transient = new Set();
  let unfetchable = 0;
  let pending = [...need.keys()];
  for (let round = 0; pending.length; round++) {
    const byHolder = new Map();
    const next = [];
    for (const id of pending) {
      const holder = need.get(id).holders[round];
      if (holder == null) { unfetchable++; continue; }
      if (!byHolder.has(holder)) byHolder.set(holder, []);
      byHolder.get(holder).push(id);
    }
    for (const [userId, ids] of byHolder) {
      if (!credsOf.has(userId)) {
        try { credsOf.set(userId, await mpAuth.credsFor(userId)); }
        catch (e) { credsOf.set(userId, null); log("fees backfill: couldn't read the settings of " + userId + " - " + e.message); }
      }
      const creds = credsOf.get(userId);
      if (!creds) { for (const id of ids) { transient.add(id); next.push(id); } continue; }
      let at = 0, broken = null;
      const got = [];
      const worker = async () => {
        while (at < ids.length && !broken) {
          const id = ids[at++];
          try {
            const o = await fetchOrder(creds, id);
            if (o && String(o.id) === id) {
              got.push(o);
              if (usablePayment(o.payment)) payments.set(id, o.payment);
              else unfetchable++; // the detail itself has no payment: nothing more to ask for
            } else next.push(id);
          } catch (e) {
            if (finalFailure(e)) { next.push(id); continue; }
            transient.add(id);
            next.push(id);
            // One failure like this usually means the connection itself is
            // down or refused: stop asking on this account's behalf.
            broken = e;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
      if (broken) {
        log("fees backfill: Manapool fetch for account " + userId + " failed - " + broken.message);
        for (const id of ids.slice(at)) { transient.add(id); next.push(id); }
      }
      if (got.length) fetched.set(userId, (fetched.get(userId) || []).concat(got));
    }
    pending = next;
  }
  // Every id that ended unfetched after a failure that could pass.
  const retry = [...need.keys()].some(id => transient.has(id) && !payments.has(id));
  return { fetched, payments, unfetchable, retry };
}

/* Writes freshly fetched details into the account's orders cache, the same
   merge Fetch orders does, so the source is fixed too. Only orders already
   in that cache. */
async function saveFetched(userId, orders) {
  const now = new Date().toISOString();
  const byId = new Map(orders.map(o => [String(o.id), o]));
  await store.updateOrders(userId, doc => {
    doc.orders = (doc.orders || []).map(prev => {
      const o = prev && byId.get(String(prev.id));
      return o ? Object.assign({}, prev, o, { fetchedAt: now, paymentUnavailable: !o.payment }) : prev;
    });
  });
}

async function backfillFees(opts) {
  opts = Object.assign({ log: () => {}, fetchOrder: integrations.manapoolOrder }, opts || {});
  const log = opts.log;
  const out = { owners: 0, filled: 0, fetched: 0, unfetchable: 0, skipped: 0, retry: false };

  // 1. Which collections have sales to fill, and which orders they need.
  const keys = [];
  const ids = new Set();
  for (const key of await ownerKeys()) {
    let doc;
    try { doc = await store.readCollection(key); }
    catch (e) { out.skipped++; log("fees backfill: couldn't read " + key + " - " + e.message); continue; }
    const lists = doc.state && Array.isArray(doc.state.pickLists) ? doc.state.pickLists.filter(needsFees) : [];
    if (!lists.length) continue;
    keys.push(key);
    for (const p of lists) ids.add(String(p.orderId));
  }
  if (!keys.length) return out;

  // 2. What the caches already know; fetch the rest.
  const { orders, unreadable } = await indexOrders(ids);
  out.skipped += unreadable;
  const payments = new Map();
  const need = new Map();
  for (const [id, entry] of orders) {
    if (entry.payment) payments.set(id, entry.payment);
    else need.set(id, entry);
  }
  out.unfetchable += [...ids].filter(id => !orders.has(id)).length; // in no cache at all
  if (need.size) {
    const r = await fetchMissing(need, opts);
    out.unfetchable += r.unfetchable;
    out.retry = r.retry;
    for (const [id, pay] of r.payments) payments.set(id, pay);
    for (const [userId, list] of r.fetched) {
      out.fetched += list.length;
      try { await saveFetched(userId, list); }
      catch (e) { log("fees backfill: couldn't update the orders cache of " + userId + " - " + e.message); }
    }
  }

  // 3. Fill the sales, each collection under its own lock.
  for (const key of keys) {
    try {
      const r = await store.updateCollection(key, draft => {
        const f = fillFees(draft, payments);
        return { write: f.filled > 0, result: f };
      });
      if (r.result && r.result.filled) { out.owners++; out.filled += r.result.filled; }
    } catch (e) {
      out.skipped++;
      log("fees backfill: couldn't save " + key + " - " + e.message);
    }
  }
  return out;
}

/* Runs backfillFees() until it's done once per data directory (see the
   header for when a later boot retries). Returns null when already done. */
async function backfillFeesOnce(opts) {
  const done = await store.readMigrations();
  if (done[MARKER]) return null;
  const out = await backfillFees(opts);
  const tries = (Number(done[MARKER + "Tries"]) || 0) + 1;
  out.tries = tries;
  if (!(out.skipped || out.retry) || tries >= MAX_TRIES) await store.markMigrationDone(MARKER);
  else await store.noteMigrationTry(MARKER + "Tries", tries);
  return out;
}

module.exports = { MARKER, MAX_TRIES, needsFees, paymentOf, fillFees, backfillFees, backfillFeesOnce };
