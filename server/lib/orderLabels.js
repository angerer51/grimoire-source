"use strict";
/* One-time backfill of pick lists' readable order numbers (#197).
   ---------------------------------------------------------------
   A Manapool pick list keeps the order's internal UUID (orderId, which
   links it to the order) and, since core.js's ensureOrderPickList started
   saving it, the order's readable number (orderLabel, e.g. "584368-2076788").
   Lists made before that have no orderLabel, and some saved the UUID itself
   as the label, so Accounting showed the UUID. This writes the real label
   onto every such list, from the server's orders caches, so the saved data
   is fixed and not just the display. orderId and the pick list id stay.

   Why a server boot task rather than the browser: it fixes every account
   and store at once, including ones nobody opens Order Fulfillment in, and
   a store's lists in particular. Orders are cached per signed-in user
   (orders/<user id>.json, see store.readOrders), not per store, so a store's
   pick lists were made from whichever member's cache fetched that order; a
   browser could only fill the ones its own user happened to fetch. Every
   orders file is read here and keyed by order id. Manapool order ids are
   UUIDs, unique across accounts, and the label written is the number of the
   very order the pick list already names, so nothing new is revealed to
   anyone who can see the list.

   Safe alongside saves: each collection is read, changed and written back
   through store.writeCollection with the rev it read, the same as the
   scheduled price jobs (priceRules.js). A browser save that lands in
   between is three-way merged field by field (merge.js), and a browser tab
   still holding the old rev merges its next save the same way, keeping
   the label (it never touched that field). index.js awaits this before the
   server starts listening, so on a normal boot nothing is saving anyway.

   Idempotent: only a list with an orderId and no label (or the UUID as its
   label) is touched, a collection with nothing to fix is not written, and
   the done marker (migrations.json) is set only after a run that read and
   wrote everything it needed, so a failure part-way runs again next boot.
   Bounded: one collection in memory at a time; the label map is at most
   500 orders per account (the orders cache's own cap). */

const fs = require("fs");
const path = require("path");
const store = require("./store");

const MARKER = "pickListOrderLabels";

const needsLabel = p => !!(p && p.orderId &&
  (!p.orderLabel || String(p.orderLabel).trim() === String(p.orderId)));

/* order id -> readable label, from every account's orders cache. A read
   error (permissions, a locked file) is counted, so the run isn't marked
   done on a guess. A CORRUPT file is not: store.readJson moves it aside as
   .corrupt.<time> and returns an empty cache, so its labels are simply
   missing here, those lists keep no label in the saved data, and the pages
   fall back to the live cache or a shortened id for them. */
async function orderLabelIndex() {
  const labels = new Map();
  let unreadable = 0;
  let files = [];
  try { files = await fs.promises.readdir(store.p("orders")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let doc;
    try { doc = await store.readOrders(path.basename(f, ".json")); }
    catch (e) { unreadable++; continue; }
    for (const o of (doc && Array.isArray(doc.orders)) ? doc.orders : []) {
      const id = o && o.id != null ? String(o.id) : "";
      const label = o && o.label ? String(o.label).trim() : "";
      if (id && label && label !== id && !labels.has(id)) labels.set(id, label);
    }
  }
  return { labels, unreadable };
}

/* Fills the labels in place. Returns { filled, unresolved }. */
function fillOrderLabels(state, labels) {
  let filled = 0, unresolved = 0;
  for (const p of state && Array.isArray(state.pickLists) ? state.pickLists : []) {
    if (!needsLabel(p)) continue;
    const label = labels.get(String(p.orderId));
    if (label) { p.orderLabel = label; filled++; } else unresolved++;
  }
  return { filled, unresolved };
}

/* Every collection: each account's own, then each store's (archived ones
   too: their saved data is fixed the same). */
async function ownerKeys() {
  const db = await store.readUsers();
  const stores = (await store.readStoreList()).stores || [];
  return (db.users || []).map(u => String(u.id)).concat(stores.map(s => "store:" + s.id));
}

async function backfillOrderLabels(opts) {
  const log = (opts && opts.log) || (() => {});
  const { labels, unreadable } = await orderLabelIndex();
  const out = { owners: 0, filled: 0, unresolved: 0, skipped: unreadable };
  for (const key of await ownerKeys()) {
    let doc;
    try { doc = await store.readCollection(key); }
    catch (e) { out.skipped++; log("order number backfill: couldn't read " + key + " - " + e.message); continue; }
    if (!doc.state || !Array.isArray(doc.state.pickLists) || !doc.state.pickLists.some(needsLabel)) continue;
    const r = fillOrderLabels(doc.state, labels);
    out.unresolved += r.unresolved;
    if (!r.filled) continue;
    try {
      await store.writeCollection(key, doc.state, doc.rev);
      out.owners++;
      out.filled += r.filled;
    } catch (e) {
      out.skipped++;
      log("order number backfill: couldn't save " + key + " - " + e.message);
    }
  }
  return out;
}

/* Runs backfillOrderLabels() once per data directory, at boot. Returns
   null when it already ran. Lists whose order is in no cache at all are
   left as they are (the pages show a shortened id for those) and don't
   hold the marker back: a later boot couldn't find them either. */
async function backfillOrderLabelsOnce(opts) {
  if ((await store.readMigrations())[MARKER]) return null;
  const out = await backfillOrderLabels(opts);
  if (!out.skipped) await store.markMigrationDone(MARKER);
  return out;
}

module.exports = { MARKER, needsLabel, ownerKeys, orderLabelIndex, fillOrderLabels, backfillOrderLabels, backfillOrderLabelsOnce };
