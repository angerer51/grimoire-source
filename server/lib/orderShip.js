"use strict";
/* Mark shipped in Grimoire also marks the order shipped on Manapool (#454).
   -----------------------------------------------------------------------
   The browser marks the ticket shipped in the collection as before, then
   asks POST /api/manapool/order/:id/fulfillment to tell Manapool, and keeps
   what came back on the ticket (core.js pushShippedToManapool). The token
   never reaches the browser: this sends it, through the Manapool connection
   of the account whose orders cache holds the order. Orders are cached per
   signed-in user, not per store (orderLabels.js), so a store's ticket may
   have come from a teammate's fetch: the caller's own cache is tried first,
   then those of the other active members who can reach the store the
   caller is working in. Nobody reaches an order outside their own cache
   and their current store's.

   Never throws for a Manapool problem: it answers { ok: false, error } so
   the ticket can say "Not sent to Manapool" with the reason and offer Retry. */

const store = require("./store");
const orgs = require("./orgs");
const integrations = require("./integrations");
const mpAuth = require("./mpAuth");

/* User ids whose orders cache may hold this caller's orders, in the order
   to try them: the caller, then (in a store) the store's other members. */
async function holderCandidates(user, docOwner) {
  const out = [String(user.id)];
  const storeId = typeof docOwner === "string" && docOwner.startsWith("store:") ? docOwner.slice(6) : "";
  if (!storeId || !user.orgId) return out;
  const db = await store.readUsers();
  for (const u of db.users || []) {
    if (!u || String(u.id) === String(user.id) || u.disabled || u.orgId !== user.orgId) continue;
    if (await orgs.canAccessStore(u, storeId)) out.push(String(u.id));
  }
  return out;
}

/* { holderId, order, creds } for the first candidate whose cache has the
   order, preferring one with a Manapool connection; null if none has it. */
async function findOrder(user, docOwner, orderId) {
  let found = null;
  for (const id of await holderCandidates(user, docOwner)) {
    const doc = await store.readOrders(id);
    const order = (doc.orders || []).find(o => o && String(o.id) === String(orderId));
    if (!order) continue;
    const creds = mpAuth.credsFromPrefs(id, await store.readPrefs(id));
    const hit = { holderId: id, order, creds };
    if (mpAuth.usable(creds)) return hit;
    if (!found) found = hit;
  }
  return found;
}

/* Orders Manapool replaced, cancelled or refunded (#489): a ticket for one
   must not ship. Read from the same caches findOrder looks in (the caller's,
   then in a store its teammates'), so the desk, Warehouse Mode and this
   ship call agree. Each cache is parsed again only when its file changes. */
const CANCELLED_STATUSES = new Set(["replaced", "cancelled", "canceled", "refunded"]);
const statusKey = s => String(s == null ? "" : s).trim().toLowerCase().replace(/[\s-]+/g, "_");
const orderWasCancelled = s => CANCELLED_STATUSES.has(statusKey(s));
const cancelledCache = new Map();   // user id -> { stamp, list }: one entry per account at most
async function cancelledIn(userId) {
  const stamp = await store.ordersStamp(userId);
  const hit = cancelledCache.get(userId);
  if (hit && hit.stamp === stamp) return hit.list;
  const doc = await store.readOrders(userId);
  const list = (doc.orders || []).filter(o => o && o.id != null && orderWasCancelled(o.status))
    .map(o => ({ id: String(o.id), status: statusKey(o.status) }));
  cancelledCache.set(userId, { stamp, list });
  return list;
}
// -> [{ id, status }], one per order, across everyone working this inventory.
async function cancelledOrders(user, docOwner) {
  const out = new Map();
  for (const id of await holderCandidates(user, docOwner)) {
    for (const o of await cancelledIn(id)) if (!out.has(o.id)) out.set(o.id, o);
  }
  return [...out.values()];
}
const cancelledWord = s => ({ replaced: "replaced", refunded: "refunded" })[statusKey(s)] || "cancelled";

const cleanTracking = t => {
  const o = t && typeof t === "object" ? t : {};
  const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const number = s(o.number, 100);
  return number ? { company: s(o.company, 60), number, url: s(o.url, 500) } : null;
};

/* Resolves the record the ticket keeps: { ok, at, status, tracking,
   alreadyDone?, needsTracking?, error? }. */
async function pushShipped({ user, docOwner, orderId, tracking }) {
  const at = new Date().toISOString();
  const t = cleanTracking(tracking);
  const fail = (error, extra) => Object.assign({ ok: false, at, status: "shipped", tracking: t, error }, extra);
  if (!integrations.manapoolEnabled()) return fail("Manapool is turned off on this server.");
  const gone = (await cancelledOrders(user, docOwner)).find(o => o.id === String(orderId));
  if (gone) {
    return fail("Manapool has this order as " + cancelledWord(gone.status) + ", so it wasn't marked shipped there. " +
      "Don't send it: Cancel and put back on its ticket puts the cards in a sorting tray.", { cancelled: gone.status });
  }
  const hit = await findOrder(user, docOwner, orderId);
  if (!hit) {
    return fail("This order isn't in the fetched orders of anyone working this inventory, so Grimoire can't tell " +
      "which Manapool account it belongs to. Fetch orders on the Orders tab, then retry.");
  }
  const needsTracking = integrations.orderNeedsTracking(hit.order);
  if (needsTracking && !t) {
    return fail("Manapool needs a tracking number for this order (Ground Advantage). Add it, then retry.", { needsTracking });
  }
  let out;
  try {
    out = await integrations.manapoolMarkShipped(hit.creds, orderId, t);
  } catch (e) {
    return fail(integrations.mpShipFailure(e), { needsTracking });
  }
  // The holder's cache shows it shipped now, so Orders says so before the
  // next Fetch orders brings Manapool's own word.
  try {
    await store.updateOrders(hit.holderId, doc => {
      const o = (doc.orders || []).find(x => x && String(x.id) === String(orderId));
      if (!o) return;
      if (!integrations.orderIsFinal(o.status)) o.status = "shipped";
      o.grimoire = Object.assign({}, o.grimoire, { manapoolShippedAt: at },
        t ? { tracking: t.number } : {});
    });
  } catch (e) { /* the push itself worked; the cache catches up on the next fetch */ }
  return { ok: true, at, status: "shipped", tracking: t, alreadyDone: !!out.alreadyDone, needsTracking };
}

module.exports = { holderCandidates, findOrder, pushShipped, cancelledOrders, orderWasCancelled, cancelledWord };
