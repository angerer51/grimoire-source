"use strict";
/* Which inventory an account shares and trades from (#128).
   ----------------------------------------------------------
   Social sharing and Trade Proposals used to read the account's personal
   collection (empty for every org account) while the trade composer's
   "You give" side read the active store. Now one setting decides both:
   prefs.actFrom is either absent (the personal collection, the default
   for everyone) or the id of a store the account may act from.

   Acting from a store is for that store's Owners and Managers only
   (owner's decision, 2026-10-09): orgs.isOrgManager + orgs.canAccessStore,
   the same rank check every other store-management route uses. The stored
   choice is never trusted on its own: resolve() re-checks it on every
   call, so a person who is demoted, leaves the org, or whose store is
   archived falls straight back to their personal collection, with no
   window where their old share still shows the store.

   Trade proposals carry fromStoreId / toStoreId, stamped by the server
   from resolve() at propose time, never taken from the request.
   proposalRoles() is the one place that decides what a viewer may do with
   a proposal:
   - incoming: addressed to them, or to a store they manage (any of that
     store's Owners/Managers may accept or decline);
   - outgoing: sent by them, or from a store they manage (any of that
     store's Owners/Managers may withdraw; a store-sent proposal is the
     store's, so its sender needs the rank too). */

const store = require("./store");
const orgs = require("./orgs");
const trades = require("./trades");
const auth = require("./auth");

/* null when `user` may act from `storeId`, otherwise the refusal message. */
async function storeChoiceProblem(user, storeId) {
  if (!user || !user.orgId) return "Only an organization's owners and managers can share and trade from a store.";
  if (!orgs.isOrgManager(user)) return "Only a store's owners and managers can share and trade from it.";
  if (typeof storeId !== "string" || !storeId || !(await orgs.canAccessStore(user, storeId))) {
    return "That isn't a store you can share and trade from.";
  }
  return null;
}

const personal = user => ({ kind: "personal", owner: user.id, storeId: null, storeName: null, orgName: null });
// A disabled account (#142): no inventory at all, so no collection key.
const OFF = Object.freeze({ kind: "off", owner: null, storeId: null, storeName: null, orgName: null });

/* Whether the account is disabled right now. A raw account record carries
   `disabled`, and so does auth.listUsers({ withDisabled: true }); a plain
   auth.publicUser() projection doesn't, so that is looked up. A record
   that no longer exists counts as disabled. */
async function isDisabled(user) {
  if (user.disabled === true) return true;
  if (user.disabled === false) return false;
  const rec = await auth.findUserById(user.id);
  return !rec || !!rec.disabled;
}

/* #147: a saved store choice that gets cleared leaves a note in prefs
   (prefs.actFromCleared: { storeId, reason, at }), so Social and the trade
   composer can tell the person why they are back on their personal cards
   instead of switching silently. Every place that clears a choice calls
   this INSIDE its store.updatePrefs callback, so the note is written under
   the same prefs lock as the clear: resolve()'s backstop (clearChoice),
   auth.setOrgMembership (demoted / left), auth.setDisabled and
   orgs.clearStoreChoices (archived). The note stays until the person
   dismisses it (dismissClearedNotice) or picks again (choose).
   onlyId: clear only if the saved choice is still that id. nameOf(id): the
   store's name as it is when the choice is cleared (see storeNamer()),
   saved in the note so a later rename never reaches someone who has since
   left the org (review of PR #150). Returns whether anything was cleared.
   A non-string leftover is deleted with no note. */
const CLEARED_REASONS = ["archived", "demoted", "left", "disabled"];
const NAME_MAX = 80;   // orgs.addStore / renameStore cap store names at 80 too
function dropChoice(prefs, reason, onlyId, nameOf) {
  if (!prefs || prefs.actFrom === undefined) return false;
  if (onlyId !== undefined && prefs.actFrom !== onlyId) return false;
  const id = prefs.actFrom;
  delete prefs.actFrom;
  if (typeof id === "string" && id) {
    const name = typeof nameOf === "function" ? nameOf(id) : "";
    prefs.actFromCleared = {
      storeId: id, storeName: typeof name === "string" ? name.slice(0, NAME_MAX) : "",
      reason: CLEARED_REASONS.includes(reason) ? reason : "lost", at: new Date().toISOString()
    };
  }
  return true;
}

/* Drops a saved choice under the prefs lock, only if it is still the one
   found invalid, so a fresh valid choice saved meanwhile is never lost. */
async function clearChoice(userId, staleId, reason, nameOf) {
  await store.updatePrefs(userId, prefs => { dropChoice(prefs, reason, staleId, nameOf); });
}

/* A synchronous id -> store name lookup over the store list as it is now,
   for dropChoice's nameOf. Read before the prefs lock is taken. */
async function storeNamer() {
  const list = (await store.readStoreList()).stores || [];
  return id => { const s = list.find(x => x && x.id === id); return (s && s.name) || ""; };
}

/* Why `user` may no longer act from store `id`, as a dropChoice reason. */
async function lostReason(user, id) {
  const s = await orgs.storeById(id);
  if (!s || s.archived) return "archived";
  if (!user.orgId || s.orgId !== user.orgId) return "left";
  if (!orgs.isOrgManager(user)) return "demoted";
  return "lost";
}

/* The sentence for a pending note, or null. Uses the name saved in the
   note, never the store's current one: the reader may have left its org. */
async function clearedNotice(userId) {
  const n = (await store.readPrefs(userId)).actFromCleared;
  if (!n || typeof n !== "object" || typeof n.storeId !== "string") return null;
  const name = typeof n.storeName === "string" && n.storeName ? n.storeName.slice(0, NAME_MAX) : "Your store";
  const back = "so you're sharing and trading from your personal cards again.";
  switch (n.reason) {
    case "archived": return name + " was archived, " + back;
    case "demoted": return "You're no longer an owner or manager, so you can't share and trade from " + name +
      ". You're sharing and trading from your personal cards again.";
    case "left": return "You're no longer in " + name + "'s organization, " + back;
    case "disabled": return "Your account was turned off, which stopped sharing and trading from " + name +
      ". You're sharing and trading from your personal cards again.";
    default: return "You can no longer share and trade from " + name + ", " + back;
  }
}

/* The person has read the note. */
async function dismissClearedNotice(userId) {
  await store.updatePrefs(userId, prefs => { delete prefs.actFromCleared; });
}

/* #147: how many personal cards (summed quantities) an account holds, for
   Social's picker label and the "your personal cards are empty" offer.
   Keyed on the collection file's stamp (mtime + size, as pickInvite.js and
   prices.js do), so a 70k-stack personal collection is parsed once per
   change, not on every page load; no file at all is 0 with no read. The
   entry holds the promise, so requests arriving together share one read;
   a failed read is dropped. Bounded by entry count; each entry is a
   number. */
const COUNT_CACHE_MAX = 200;
const countCache = new Map(); // user id -> { stamp, count: Promise<number> }
function countCards(cards) {
  let n = 0;
  for (const c of Array.isArray(cards) ? cards : []) {
    const q = Number(c && c.quantity);
    if (q > 0) n += q;
  }
  return n;
}
async function personalCardCount(userId) {
  const key = String(userId);
  const stamp = await store.collectionStamp(key);
  if (stamp === "none") return 0;
  const hit = countCache.get(key);
  if (hit && hit.stamp === stamp) return hit.count;
  const count = store.readCollection(key).then(c => countCards(c.state && c.state.cards));
  const entry = { stamp, count };
  countCache.delete(key);
  countCache.set(key, entry);
  while (countCache.size > COUNT_CACHE_MAX) countCache.delete(countCache.keys().next().value);
  count.catch(() => { if (countCache.get(key) === entry) countCache.delete(key); });
  return count;
}

/* The inventory `user` acts from right now, re-checked against their
   current rank and the store's current state. `prefs` may be passed when
   the caller already read them (the sharing routes loop over accounts).
   Returns { kind, owner (the store.readCollection key), storeId,
   storeName, orgName }. kind is "personal", "store", or "off" for a
   disabled account (#142), which has no owner key: nothing to share.

   A saved store choice that no longer holds (demoted, left the org, the
   store archived) is CLEARED, not just ignored for this request (owner's
   decision, 2026-10-10): otherwise a re-promotion, rejoining or a restored
   store would quietly turn store sharing back on without the person
   seeing Social's "who will see it" confirmation again. */
async function resolve(user, prefs) {
  if (!user) return null;
  if (await isDisabled(user)) {
    // #142: a disabled account shares nothing, personal or store. Its saved
    // store choice goes too (auth.setDisabled clears it as well, this also
    // covers accounts disabled before that), so re-enabling brings back
    // personal sharing only and the store has to be picked again.
    const stale = (prefs || await store.readPrefs(user.id)).actFrom;
    if (typeof stale === "string" && stale) await clearChoice(user.id, stale, "disabled", await storeNamer());
    return OFF;
  }
  const p = prefs || await store.readPrefs(user.id);
  const id = p && typeof p.actFrom === "string" ? p.actFrom : "";
  if (!id) return personal(user);
  if (await storeChoiceProblem(user, id)) {
    await clearChoice(user.id, id, await lostReason(user, id), await storeNamer());
    return personal(user);
  }
  const s = await orgs.storeById(id);
  const org = await orgs.orgById(user.orgId);
  return { kind: "store", owner: "store:" + id, storeId: id, storeName: (s && s.name) || "Store", orgName: (org && org.name) || "" };
}

/* What the Social page's "Share and trade from" picker may offer. */
async function choices(user) {
  if (!user || !user.orgId || !orgs.isOrgManager(user)) return [];
  return (await orgs.accessibleStores(user)).map(s => ({ id: s.id, name: s.name }));
}

/* Saves the choice (null/"" = personal). Throws status 403 for a store the
   account may not act from, whatever the page offered. */
async function choose(user, storeId) {
  if (storeId != null && typeof storeId !== "string") { const e = new Error("Which store?"); e.status = 400; throw e; }
  const want = typeof storeId === "string" ? storeId.trim() : "";
  if (want) {
    const problem = await storeChoiceProblem(user, want);
    if (problem) { const e = new Error(problem); e.status = 403; throw e; }
  }
  await store.updatePrefs(user.id, prefs => {
    if (want) prefs.actFrom = want; else delete prefs.actFrom;
    delete prefs.actFromCleared;   // #147: picking again answers any "why you were switched back" note
  });
  // Re-resolved against the account as it is NOW: a demotion or archive
  // that landed between the check above and the save (and cleared choices
  // before this one was written) is caught here and cleared again.
  return resolve((await auth.findUserById(user.id)) || user);
}

/* Stores whose proposals this viewer handles: every active store of their
   org for an Owner/Manager (canAccessStore is true for exactly those),
   none for Staff or a personal account. Worked out once per request. */
async function managedStoreIds(user) {
  if (!user || !user.orgId || !orgs.isOrgManager(user)) return new Set();
  return new Set((await orgs.accessibleStores(user)).map(s => s.id));
}

const isOpen = (p, statuses) => !statuses.includes(p.status) || p.status === "open";

/* What `user` may see and do with proposal `p`, given managedStoreIds().
   Once a side names a store, acting for that side needs the store's
   CURRENT Owner/Manager rank (owner's decision, 2026-10-10): the person an
   offer was addressed to, or who sent it, still sees it after losing rank
   or leaving, but can no longer answer or withdraw it. A viewer on both
   sides may withdraw but never accept their own offer. */
function proposalRoles(p, user, managed) {
  const fromStore = !!(p.fromStoreId && managed.has(p.fromStoreId));
  const toStore = !!(p.toStoreId && managed.has(p.toStoreId));
  const outgoing = p.fromUserId === user.id || fromStore;
  const incoming = p.toUserId === user.id || toStore;
  const open = isOpen(p, trades.STATUSES);
  return {
    outgoing, incoming,
    canWithdraw: open && (p.fromStoreId ? fromStore : p.fromUserId === user.id),
    canRespond: open && (p.toStoreId ? toStore : p.toUserId === user.id) && !outgoing
  };
}

/* Cheap "is this proposal any of this viewer's business" test on the raw
   stored record, run before any cleaning (GET /api/trades): only string
   ids are compared, so a damaged record can't match by accident. */
function concernsViewer(p, user, managed) {
  if (!p || typeof p !== "object") return false;
  if (p.fromUserId === user.id || p.toUserId === user.id) return true;
  return (typeof p.fromStoreId === "string" && managed.has(p.fromStoreId)) ||
    (typeof p.toStoreId === "string" && managed.has(p.toStoreId));
}

/* A proposal as one viewer gets it: cleaned (trades.sanitizeProposal),
   plus what they may do with it (proposalRoles).
   - Store ids are internal: a viewer who doesn't currently manage that
     store never gets its id, only its name.
   - A viewer on the sending side only learns the recipient's store NAME if
     they could see the recipient's share when they sent it (toStoreShown),
     or are on the receiving side themselves. That viewer also gets a
     generic archive reason (no store name) and no "by <username>" when
     someone other than the person they addressed answered for the store. */
function viewerCopy(p, user, managed) {
  const out = trades.sanitizeProposal(p);
  const roles = proposalRoles(out, user, managed);
  if (out.toStoreId && !roles.incoming && p.toStoreShown !== true) {
    out.toStoreName = null;
    if (out.statusReason && p.statusReasonStoreId === p.toStoreId) out.statusReason = "the store was archived";
    if (out.statusByUsername && p.statusByUserId !== p.toUserId && p.statusByUserId !== user.id) out.statusByUsername = null;
  }
  if (out.fromStoreId && !managed.has(out.fromStoreId)) out.fromStoreId = null;
  if (out.toStoreId && !managed.has(out.toStoreId)) out.toStoreId = null;
  return Object.assign(out, roles);
}

/* Inside the trade-proposals lock at propose time: refuses a side whose
   store has been archived since it was resolved, so an offer can never be
   saved to or from an archived store after archive's withdraw sweep ran. */
async function archivedSideProblem(from, to) {
  for (const side of [from, to]) {
    if (!side || !side.storeId) continue;
    const s = await orgs.storeById(side.storeId);
    if (!s || s.archived) return (side.storeName || "That store") + " has just been archived. Start the offer again.";
  }
  return null;
}

/* Whether a trade offer can be sent to `target` (a raw account record or
   null): null when it can, otherwise the refusal message. A disabled
   account takes no offers (owner's decision, 2026-10-10, #142), and gets
   the same "No such user." as an unknown name, so the reply never says
   that an account exists but is disabled. */
function recipientProblem(target) {
  return !target || target.disabled ? "No such user." : null;
}

/* Refusal message for a proposal between these two resolved inventories,
   or null. A side that manages the other side's store would end up
   answering its own offer. */
async function proposalProblem(sender, from, recipient, to) {
  if (from.storeId && to.storeId && from.storeId === to.storeId) return "Both sides of this trade are the same store.";
  if (to.storeId && !(await storeChoiceProblem(sender, to.storeId))) {
    return "You manage " + to.storeName + ", so you can't send it a trade offer.";
  }
  if (from.storeId && !(await storeChoiceProblem(recipient, from.storeId))) {
    return recipient.username + " manages " + from.storeName + " too, so this can't be a trade between you.";
  }
  return null;
}

/* Archiving a store withdraws its open proposals, both those sent from it
   and those addressed to it (owner's decision: a proposal belongs to the
   store, so it stays open when a manager loses rank, and ends only with
   the store). Goes through trades.changeStatus like every other status
   change. Returns how many were withdrawn. */
async function withdrawStoreProposals(storeRec, by) {
  if (!storeRec || !storeRec.id) return 0;
  const reason = (storeRec.name || "The store") + " was archived";
  let n = 0;
  await store.updateTradeProposals(db => {
    for (const p of db.proposals) {
      if (!p || (p.fromStoreId !== storeRec.id && p.toStoreId !== storeRec.id)) continue;
      if (!isOpen(p, trades.STATUSES)) continue;
      trades.changeStatus(p, "withdrawn", by ? { id: by.id, username: by.username } : null, reason);
      p.statusReasonStoreId = storeRec.id;   // which store the reason names (viewerCopy)
      n++;
    }
  });
  return n;
}

module.exports = {
  storeChoiceProblem, isDisabled, recipientProblem, resolve, choices, choose, dropChoice, storeNamer, clearedNotice,
  dismissClearedNotice, personalCardCount, countCards, managedStoreIds, proposalRoles, concernsViewer, proposalProblem,
  archivedSideProblem, viewerCopy, withdrawStoreProposals
};
