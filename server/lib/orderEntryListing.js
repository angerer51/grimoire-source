"use strict";
/* Manapool listings follow an Order Entry order (#432; #402, owner's answer 7)
   --------------------------------------------------------------------------
   An order entered at the counter (or sent from the kiosk, #433) lowers each
   of its cards' Manapool listings by its copies; cancelling it raises them
   again by what came down. The Manapool calls themselves are
   integrations.manapoolOrderEntrySync (quantity only, never a price).

   Whose Manapool connection (owner, 2026-11-07, on #432): the one of the
   account that OWNS the inventory, never the signed-in login's. A personal
   account is its own owner. A Store uses its organization's owner: the
   org's ownerId first, then any other current Owner with a connection. So
   Staff and a kiosk session, which have no connection of their own, still
   update the store's listings. The credentials stay on the server: only
   per-card results go back.

   What a request may touch: the caller names only an inventory it can work
   in right now (docOwner, from orgs.resolveDocOwner: membership, and a Staff
   member's storeIds, re-checked on every request) and a ticket id. Every
   card and quantity comes from that ticket as saved in that inventory:
   - "entered": the ticket must be a saved, open or picked counter ticket.
     Its lines are lowered once: what came down is recorded here, per
     inventory, and a second "entered" for the same ticket changes nothing.
   - "cancelled": the ticket must be gone from the saved inventory (the
     cancel is saved), and only what this file recorded for it is raised,
     once (the record is dropped before the raise).
   The record lives server-side, not on the ticket in the collection, so no
   client can make a cancel raise more than its entry lowered. A ticket is
   matched by id AND createdAt, since a pick list id can come round again
   once the highest-numbered list is gone.

   Only a ticket created within the last day can be "entered", and records
   are pruned at each "entered" (see prune), so the file stays small. */

const path = require("path");
const store = require("./store");
const auth = require("./auth");
const orgs = require("./orgs");
const integrations = require("./integrations");
const mpAuth = require("./mpAuth");

// Sources of an Order Entry ticket (core.js COUNTER_SOURCES): a walk-in, and a kiosk order (#433).
const COUNTER_SOURCES = ["walkin", "kiosk"];
const ENTER_WINDOW_MS = 24 * 3600 * 1000;
const KEEP_MS = 2 * ENTER_WINDOW_MS;
const MAX_RECORDS = 2000;

const isStoreKey = k => String(k).startsWith("store:");
const recordFile = ownerKey => path.join(store.ownerDir(ownerKey), "order-entry-listings.json");
const lockKey = ownerKey => "order-entry-listing:" + store.canonicalOwner(ownerKey);

/* The Manapool credentials of the account that owns this inventory, or null
   (no such account, or none connected). For #433's kiosk too. Server-side
   only: never send these to a browser. */
async function ownerManapoolCreds(ownerKey) {
  const a = await ownerManapoolAccount(ownerKey);
  return a && a.creds;
}
/* Which account's Manapool this inventory sells through: { userId, creds }
   (creds null when it isn't connected), or null for no such inventory. A
   personal account is its own; a Store uses the first connected Owner, the
   org's ownerId first, else (none connected) the org's ownerId. */
async function ownerManapoolAccount(ownerKey) {
  if (!ownerKey) return null;
  if (!isStoreKey(ownerKey)) {
    const userId = store.canonicalOwner(ownerKey);
    const c = mpAuth.credsFromPrefs(userId, await store.readPrefs(userId));
    return { userId, creds: mpAuth.usable(c) ? c : null };
  }
  const s = await orgs.storeById(String(ownerKey).slice("store:".length));
  if (!s) return null;
  const org = await orgs.orgById(s.orgId);
  const owners = (await auth.listUsers({ withDisabled: true }))
    .filter(u => u.orgId === s.orgId && u.orgRole === "owner" && !u.disabled)
    .sort((a, b) => (b.id === (org && org.ownerId)) - (a.id === (org && org.ownerId)));
  for (const u of owners) {
    const c = mpAuth.credsFromPrefs(u.id, await store.readPrefs(u.id));
    if (mpAuth.usable(c)) return { userId: u.id, creds: c };
  }
  return org && org.ownerId ? { userId: org.ownerId, creds: null } : null;
}

/* Manapool orders already fetched for this inventory (#433, owner
   2026-11-08: a copy sold online is held from the moment its order is
   fetched, not only once its pick list is made). They live in the orders
   cache of the account whose Manapool the inventory sells through (GET
   /api/manapool/orders keeps one per account). Only what working out the
   hold needs: no buyer, address or money. stamp changes whenever the cache
   is rewritten, for a caller that caches on it. */
async function fetchedOrders(ownerKey) {
  const a = await ownerManapoolAccount(ownerKey);
  if (!a) return { orders: [], stamp: "none" };
  const [doc, stamp] = await Promise.all([store.readOrders(a.userId), store.ordersStamp(a.userId)]);
  const orders = [];
  for (const o of (doc && Array.isArray(doc.orders) ? doc.orders : [])) {
    if (!o || !o.id || !Array.isArray(o.lines) || !o.lines.length) continue;
    orders.push({ id: String(o.id), status: o.status == null ? null : String(o.status), placedAt: o.placedAt || null,
      lines: o.lines.filter(Boolean).map(l => l.kind === "sealed"
        ? { kind: "sealed", tcgplayerProductId: l.tcgplayerProductId, name: String(l.name || ""), qty: Number(l.qty) || 0 }
        : { kind: "card", set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
            name: String(l.name || ""), qty: Number(l.qty) || 0 }) });
  }
  return { orders, stamp: a.userId + ":" + stamp };
}

const normNum = n => String(n == null ? "" : n).trim().toLowerCase().replace(/^0+(?=.)/, "");
// core.js cardLineMatches, for a printing line (every counter line has a collector number).
const lineMatches = (it, r) => r && r.set === it.set && normNum(r.collector) === normNum(it.collector) &&
  r.lang === (it.lang || "en") && r.finish === (it.finish || "nonfoil") && (r.condition || "NM") === (it.condition || "NM");

/* A saved ticket's card lines as Manapool listings, with the copies on each.
   The Scryfall ID comes from a stack of that printing in the same inventory,
   or, once a sale on the spot emptied it, from the copy its pick kept to put
   back. A line with neither was never listed by Grimoire. */
function ticketListingLines(state, ticket) {
  const cards = Array.isArray(state.cards) ? state.cards : [];
  const out = [];
  for (const it of ticket.lines || []) {
    if (!it || it.kind === "sealed" || !(Number(it.qty) > 0)) continue;
    const rec = cards.find(r => r && r.scryfallId && lineMatches(it, r));
    const pull = ((it.pickedResult && it.pickedResult.pulls) || []).find(x => x && x.back && x.back.stack && x.back.stack.scryfallId);
    const scryfallId = rec ? rec.scryfallId : pull ? pull.back.stack.scryfallId : "";
    if (!scryfallId) continue;
    out.push({ scryfallId: String(scryfallId), lang: it.lang || "en", finish: it.finish || "nonfoil", condition: it.condition || "NM",
      name: String(it.name || ""), set: String(it.set || ""), collector: String(it.collector || ""), qty: Number(it.qty) });
  }
  return out;
}

const failure = (status, error) => Object.assign(new Error(error), { status });

/* ownerKey: the inventory (docOwner). Resolves { connected, store, reason?, results }:
   connected false with reason "off" (Manapool turned off on this server) or
   "not-connected" (the owning account has no connection); store says
   whether it's a Store's inventory. Throws { status } 404 / 409 for a
   ticket that doesn't qualify. */
async function orderEntrySync(ownerKey, event, ticketId, createdAt) {
  const id = typeof ticketId === "string" ? ticketId.trim().slice(0, 64) : "";
  if (!id) throw failure(400, "ticketId is required.");
  if (event !== "entered" && event !== "cancelled") throw failure(400, 'event must be "entered" or "cancelled".');
  const storeDoc = isStoreKey(ownerKey);
  return store.withLock(lockKey(ownerKey), async () => {
    const state = (await store.readCollection(ownerKey)).state || {};
    const lists = Array.isArray(state.pickLists) ? state.pickLists : [];
    const ticket = lists.find(p => p && p.id === id && COUNTER_SOURCES.includes(p.source));
    const doc = await store.readJson(recordFile(ownerKey), { tickets: {} });
    if (!doc.tickets || typeof doc.tickets !== "object") doc.tickets = {};
    const rec = doc.tickets[id];

    let lines;
    if (event === "entered") {
      if (!ticket || (ticket.status !== "open" && ticket.status !== "picked" && ticket.status !== "shipped")) {
        throw failure(404, "That order isn't saved yet, so Manapool wasn't updated.");
      }
      if (rec && rec.createdAt === (ticket.createdAt || null)) return { connected: true, store: storeDoc, results: [], already: true };
      // Only a ticket entered just now: an old one is never lowered again once its record is pruned.
      if (!(Date.now() - (Date.parse(ticket.createdAt) || 0) < ENTER_WINDOW_MS)) {
        throw failure(409, "That order was entered too long ago to update Manapool now.");
      }
      lines = ticketListingLines(state, ticket);
    } else {
      if (ticket && (!createdAt || ticket.createdAt === createdAt)) throw failure(409, "That order hasn't been cancelled, so Manapool wasn't raised.");
      if (!rec || (createdAt && rec.createdAt && rec.createdAt !== createdAt)) return { connected: true, store: storeDoc, results: [] };
      lines = rec.lowered || [];
    }
    if (!lines.length) return { connected: true, store: storeDoc, results: [] };
    if (!integrations.manapoolEnabled()) return { connected: false, store: storeDoc, reason: "off", results: [] };
    const creds = await ownerManapoolCreds(ownerKey);
    if (!creds) return { connected: false, store: storeDoc, reason: "not-connected", results: [] };
    // Another tool manages this seller's Mana Pool listings (#499): it keeps them right, so nothing to send or warn about.
    if (!integrations.manapoolCanWriteInventory(creds)) return { connected: false, store: storeDoc, reason: "other-app", results: [] };

    // A cancel's record goes before the raise: whatever happens, never twice.
    if (event === "cancelled") {
      delete doc.tickets[id];
      await store.writeJson(recordFile(ownerKey), doc);
    }
    const out = await integrations.manapoolOrderEntrySync(creds, event, lines, id);
    if (event === "entered") {
      const lowered = out.results.filter(r => r.ok && r.change < 0).map(r => Object.assign({}, r.card, { qty: -r.change }));
      prune(doc, lists);
      // Recorded even when nothing came down, so a second "entered" changes nothing.
      doc.tickets[id] = { createdAt: ticket.createdAt || null, at: new Date().toISOString(), lowered };
      await store.writeJson(recordFile(ownerKey), doc);
    }
    return { connected: true, store: storeDoc, results: out.results };
  });
}

/* A record is kept while its ticket can still be cancelled (open or picked),
   and otherwise for KEEP_MS: long enough for a cancel's sync to arrive, and
   longer than ENTER_WINDOW_MS, so a ticket can't be entered twice. */
function prune(doc, lists) {
  const now = Date.now();
  const byId = new Map(lists.filter(p => p && p.id).map(p => [p.id, p]));
  for (const [id, r] of Object.entries(doc.tickets)) {
    const p = byId.get(id);
    const live = p && (p.createdAt || null) === (r && r.createdAt) && (p.status === "open" || p.status === "picked");
    if (!live && now - (Date.parse(r && r.at) || 0) > KEEP_MS) delete doc.tickets[id];
  }
  const ids = Object.keys(doc.tickets);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_RECORDS))) delete doc.tickets[id];
}

module.exports = { orderEntrySync, ownerManapoolCreds, ownerManapoolAccount, fetchedOrders, ticketListingLines, COUNTER_SOURCES };
