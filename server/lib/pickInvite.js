"use strict";
/* Join codes printed on pick tickets (#138).
   ------------------------------------------
   POST /api/invite/pick-list hands any signed-in account a server join code
   for the "get your own copy" footer of a pick ticket, which is why it
   isn't admin-only: whoever packs orders is rarely an admin. It used to
   mint one for any pickListId at all, so made-up ids minted unlimited codes
   around the registration and invite controls (#64 audit).

   Now a code is only given for a pick list that really exists in an
   inventory the caller can work right now (owner's decision, 2026-10-09:
   "limit it"):
   - the inventory their session is working in (docOwner, from
     orgs.resolveDocOwner: their own collection, or a store they currently
     have access to, re-checked on every request), or
   - their own personal collection.
   That covers the owner of a personal list and an org's Owners and
   Managers, and also Staff assigned to the store, since they are the ones
   who pick, pack and print (owner confirmed, 2026-10-10). Anything else
   gets 404 "No such pick list", whether it's a made-up id or another
   account's list: only the caller's own inventories are searched, so
   nobody else's lists are read and no reply says whether some other
   account has a list by that id.

   Pick list ids (PICK-<year>-<n>) restart at 1 in every collection, so the
   dedup key is per inventory: "pick:<owner key>:<id>". The old global key
   "pick:<id>" handed one account's code (and note) to every other account
   with the same list number. A code minted under the old key is still
   reused when this same account made it, so reprints after the upgrade keep
   the code already printed. Like every invite, a pick-ticket code works for
   30 days at most (auth.inviteExpiryMs); a reprint after that gets a new
   one. */

const store = require("./store");
const auth = require("./auth");
const orgs = require("./orgs");

const MAX_ID = 64;

/* Pick list ids per inventory, keyed on the collection file's stamp
   (mtime + size, the same invalidation prices.js uses). The entry holds
   the PROMISE of the read and is set before the read starts, so requests
   that arrive together share one read and one parse. After a bulk
   "generate pick lists" the page's re-asks all land at the same moment,
   right after the save that changed the stamp, and a 70k-stack collection
   is tens of MB to parse (PR #143 review). A failed read is dropped, so
   the next ask tries again. Bounded by entry count; each entry is a Set
   of short ids. */
const CACHE_MAX = 200;
const idCache = new Map(); // owner key -> { stamp, ids: Promise<Set> }

async function readPickListIds(ownerKey) {
  const coll = await store.readCollection(ownerKey);
  const lists = coll.state && Array.isArray(coll.state.pickLists) ? coll.state.pickLists : [];
  return new Set(lists.map(p => p && typeof p.id === "string" ? p.id : null).filter(Boolean));
}

async function pickListIds(ownerKey) {
  const stamp = await store.collectionStamp(ownerKey);
  const hit = idCache.get(ownerKey);
  if (hit && hit.stamp === stamp) return hit.ids;
  const ids = readPickListIds(ownerKey);
  const entry = { stamp, ids };
  idCache.delete(ownerKey);
  idCache.set(ownerKey, entry);
  while (idCache.size > CACHE_MAX) idCache.delete(idCache.keys().next().value);
  ids.catch(() => { if (idCache.get(ownerKey) === entry) idCache.delete(ownerKey); });
  return ids;
}

/* The owner key of the inventory holding pick list `id` among those `user`
   can work right now, or null. */
async function pickListHome(user, docOwner, id) {
  const keys = [docOwner, user && user.id].filter((k, i, a) => k && a.indexOf(k) === i);
  for (const key of keys) {
    if ((await pickListIds(key)).has(id)) return key;
  }
  return null;
}

/* Returns { invite } or { status, error }. Never creates an invite unless
   the pick list checks out. An expired, revoked or used code is never
   handed back: the same tag then gets a fresh one (auth.createInvite). */
async function pickListInvite(user, docOwner, pickListId, note) {
  const id = typeof pickListId === "string" ? pickListId.trim() : "";
  if (!id) return { status: 400, error: "pickListId is required." };
  const home = id.length <= MAX_ID ? await pickListHome(user, docOwner, id) : null;
  if (!home) return { status: 404, error: "No such pick list." };
  const legacy = await auth.findInviteBySource("pick:" + id);
  if (legacy && legacy.createdBy === user.id) return { invite: legacy };
  // Find-or-create under the users lock, so two prints at once share one code.
  const invite = await auth.createInvite(user.id, typeof note === "string" ? note : "", null, "pick:" + home + ":" + id);
  return { invite };
}

/* Which inventory a pick-ticket tag points at, and the pick list id:
   "pick:<owner key>:<id>" (owner key = a user id or "store:<id>"), or the
   pre-#138 "pick:<id>", which names no inventory (ownerKey null). Pick
   list ids and user ids never contain ":". */
function parseSourceRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("pick:")) return null;
  const rest = ref.slice(5);
  const m = /^(store:[^:]+|[^:]+):(.+)$/.exec(rest);
  return m ? { ownerKey: m[1], id: m[2] } : { ownerKey: null, id: rest };
}

/* One-time cleanup (owner's decision, 2026-10-10, on PR #143): revoke
   every unused, still-working pick-ticket code whose pick list no longer
   exists, so codes minted for made-up ids before #138 stop working. A
   tagged code is checked against the inventory in its tag; an old untagged
   one against the inventories its creator can work today (their own cards
   and the stores they can access). A creator who no longer exists has
   none.

   Bounded: inventories are read one at a time, through pickListIds, so
   only each one's Set of ids is kept, never two collections at once; and
   only inventories some live code points at are read. An inventory that
   can't be read is skipped, and its codes are left alone rather than
   revoked on a guess. Returns { checked, revoked, skipped }. */
async function revokeOrphanPickCodes() {
  const now = Date.now();
  const db = await store.readUsers();
  const live = db.invites.filter(i => parseSourceRef(i.sourceRef) && !auth.inviteState(i, now));
  const wants = new Map(); // owner key -> [{ code, id }]
  const want = (key, code, id) => { if (!wants.has(key)) wants.set(key, []); wants.get(key).push({ code, id }); };
  for (const inv of live) {
    const { ownerKey, id } = parseSourceRef(inv.sourceRef);
    if (ownerKey) { want(ownerKey, inv.code, id); continue; }
    const creator = db.users.find(u => u.id === inv.createdBy);
    if (!creator) continue;
    want(creator.id, inv.code, id);
    for (const s of await orgs.accessibleStores(creator)) want("store:" + s.id, inv.code, id);
  }
  const found = new Set(), unreadable = new Set();
  for (const [key, list] of wants) {
    let ids;
    try { ids = await pickListIds(key); }
    catch (e) { for (const w of list) unreadable.add(w.code); continue; }
    for (const w of list) if (ids.has(w.id)) found.add(w.code);
  }
  const orphans = new Set(live.map(i => i.code).filter(c => !found.has(c) && !unreadable.has(c)));
  let revoked = 0;
  if (orphans.size) {
    await store.withLock("users", async () => {
      const cur = await store.readUsers();
      const at = new Date().toISOString();
      for (const inv of cur.invites) {
        if (!orphans.has(inv.code) || inv.usedBy || inv.revokedAt) continue;
        inv.revokedAt = at;
        inv.revokedBy = null;
        inv.revokedReason = "pick list no longer exists";
        revoked++;
      }
      if (revoked) await store.writeJson(store.p("users.json"), cur);
    });
  }
  return { checked: live.length, revoked, skipped: unreadable.size };
}

/* Runs revokeOrphanPickCodes() once per data directory, at boot. The done
   marker (store.markMigrationDone) is written only after a full run that
   read every inventory it needed, so a crash part-way, or an inventory it
   couldn't read, means it runs again on the next boot. Returns null when
   it already ran. */
const ORPHAN_CLEANUP = "revokeOrphanPickCodes";
async function revokeOrphanPickCodesOnce() {
  if ((await store.readMigrations())[ORPHAN_CLEANUP]) return null;
  const out = await revokeOrphanPickCodes();
  if (!out.skipped) await store.markMigrationDone(ORPHAN_CLEANUP);
  return out;
}

module.exports = { pickListInvite, pickListHome, parseSourceRef, revokeOrphanPickCodes, revokeOrphanPickCodesOnce };
