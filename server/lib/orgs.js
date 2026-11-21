"use strict";
/* Organizations, Stores, and membership. (BACKLOG.md #9.)
   ----------------------------------------------------------
   An Organization owns one or more Stores; a Store is exactly what a
   personal account's collection is today - its own current.json + rev/
   archive, read/written through store.js's readCollection/writeCollection
   generalized to accept "store:<id>" alongside a bare user id (see
   store.js's ownerDir()). Membership (orgId/orgRole/storeIds) lives on the
   user record itself (auth.js), not a separate join table, because an
   account belongs to at most one org - see auth.setOrgMembership().

   This module owns org/store CRUD and the permission/identity-resolution
   logic; it never touches users.json's storage directly (that stays
   auth.js's job, the same separation auth.js already keeps from store.js). */

const store = require("./store");
const auth = require("./auth");
const httpu = require("./http");

async function listOrgs() { return (await store.readOrgs()).orgs; }
async function orgById(orgId) { return (await listOrgs()).find(o => o.id === orgId) || null; }

async function listAllStores() { return (await store.readStoreList()).stores; }
async function storeById(storeId) { return (await listAllStores()).find(s => s.id === storeId) || null; }
async function storesOfOrg(orgId) { return (await listAllStores()).filter(s => s.orgId === orgId && !s.archived); }
async function archivedStoresOfOrg(orgId) { return (await listAllStores()).filter(s => s.orgId === orgId && s.archived); }

/* Keeps only ids of this org's active (non-archived) stores, de-duplicated
   (#126). Used wherever store ids arrive from a request or an old invite,
   so junk, another org's ids or an archived store never land on a user
   record. */
async function filterStoreIds(orgId, ids) {
  if (!orgId || !Array.isArray(ids)) return [];
  const active = new Set((await storesOfOrg(orgId)).map(s => s.id));
  return [...new Set(ids.filter(id => typeof id === "string" && active.has(id)))];
}

/* The storeIds a staff member ends up with when they're saved from Manage
   (#134). The requested ids go through filterStoreIds(), so a save can't
   ADD an archived store or another org's; but an archived store of this
   org the member already has is kept on top, because the form only lists
   active stores. Restoring that store then gives it back to them. */
async function memberStoreIds(orgId, requested, currentIds) {
  const kept = await filterStoreIds(orgId, requested);
  const archived = new Set((await archivedStoresOfOrg(orgId)).map(s => s.id));
  for (const id of Array.isArray(currentIds) ? currentIds : []) {
    if (archived.has(id) && !kept.includes(id)) kept.push(id);
  }
  return kept;
}

/* Every Store a user can act against right now. Owner/manager implicitly
   reach every Store in their org without being enumerated anywhere (see
   auth.js's comment on ORG_ROLES/storeIds) - adding a 4th store never
   requires re-granting existing managers. Staff only reach what's in their
   explicit storeIds. A personal (non-org) account has none. */
async function accessibleStores(user) {
  if (!user || !user.orgId) return [];
  const all = await storesOfOrg(user.orgId);
  if (user.orgRole === "owner" || user.orgRole === "manager") return all;
  const ids = new Set(user.storeIds || []);
  return all.filter(s => ids.has(s.id));
}

async function canAccessStore(user, storeId) {
  if (!user || !user.orgId || !storeId) return false;
  const s = await storeById(storeId);
  if (!s || s.orgId !== user.orgId || s.archived) return false;
  if (user.orgRole === "owner" || user.orgRole === "manager") return true;
  return (user.storeIds || []).includes(storeId);
}

const isOrgManager = user => !!user && (user.orgRole === "owner" || user.orgRole === "manager");
const isOrgOwner = user => !!user && user.orgRole === "owner";

/* Who may change whose membership (POST /api/orgs/members/:id, #123).
   Returns null when allowed, or the refusal message (the route sends 403).
   - An Owner may do anything; auth.setOrgMembership() still refuses to
     strip the org's last Owner.
   - A Manager may change or remove Staff only. Another member who is
     currently a Manager or Owner is off limits, for a role change, a
     store change and a removal alike: the target's CURRENT role decides,
     not just the role being asked for.
   - On their own row a Manager may leave or step down to Staff, but never
     ask for Manager/Owner (no self-promotion), the same as before #123.
   - Staff never reach this (the route needs orgRole "manager"). */
function memberChangeProblem(actor, target, body) {
  if (!actor || !target) return "No such member.";
  if (actor.orgRole === "owner") return null;
  if (actor.orgRole !== "manager") return "You don't have permission to do that.";
  const wants = body && body.orgRole;
  if (wants === "owner" || wants === "manager") return "Only an owner can make someone a manager or owner.";
  if (target.id !== actor.id && (target.orgRole === "owner" || target.orgRole === "manager")) {
    return "Only an owner can change or remove a manager or owner.";
  }
  return null;
}

/* What a member may do to a Store's whole document (#159). Personal
   accounts (docOwner is their own id, not "store:...") are never limited.
   - Erasing, a Replace import and restoring a revision replace the whole
     inventory: Managers and Owners only, like clearing the log (#76).
   - The Store defaults on Settings (receiving, condition, movers window,
     cycle count, shipping costs #457) are shared by everyone in the Store, so only Managers and
     Owners change them; a Staff save keeps what's there.
   - Simple mode and the chime are per person now: they live in each
     account's own prefs.json (POST /api/prefs/personal), so no save from
     anyone changes the copies left in a Store's document. Those copies are
     only read once, to seed each member's own value (core.js load()). */
const STORE_DEFAULT_KEYS = ["autoPutaway", "lotAllocation", "defaultCondition",
  "moversDays", "cycleCountSampleSize", "cycleCountErrorThreshold", "requireBinScan", "shipping"];
// nextStepsDismissed (#244): the Dashboard's "Next steps", hidden per person.
// dashTiles (#298): the Dashboard's tile layout, per person.
// whatsNewDone (#455): the "What's new" tutorials this person has finished.
const PERSONAL_PREF_KEYS = ["simpleMode", "chime", "chimeMin", "nextStepsDismissed", "dashTiles", "whatsNewDone"];
const isStoreDoc = docOwner => typeof docOwner === "string" && docOwner.startsWith("store:");
function canReplaceInventory(user, docOwner) {
  return !isStoreDoc(docOwner) || isOrgManager(user);
}
function lockedSettingKeys(user, docOwner) {
  if (!isStoreDoc(docOwner)) return [];
  return isOrgManager(user) ? PERSONAL_PREF_KEYS.slice() : PERSONAL_PREF_KEYS.concat(STORE_DEFAULT_KEYS);
}
/* Owner's answer on #159 (PR #171 review): a Staff save that empties most
   of a Store is allowed (Staff do real big clean-ups) and the version before
   it is always kept as a revision, but it is also written to the Store's
   activity log, so managers see who did it without digging in Revisions.
   Returns that audit entry (the same shape as core.js logAudit(), stamped
   server-side) or null when this isn't a Staff save into a Store, or isn't
   a big drop (store.dropsMostStacks). keptRev: the revision it's kept as. */
function staffBigDropEntry(user, docOwner, before, after, keptRev) {
  if (!isStoreDoc(docOwner) || !user || isOrgManager(user)) return null;
  if (!store.dropsMostStacks(before, after)) return null;
  const stacksOf = s => (s && Array.isArray(s.cards) ? s.cards.length : 0);
  const cardsOf = s => (s && Array.isArray(s.cards) ? s.cards.reduce((n, c) => n + (Number(c && c.quantity) || 0), 0) : 0);
  const was = stacksOf(before), now = stacksOf(after);
  const removedCards = Math.max(0, cardsOf(before) - cardsOf(after));
  const who = user.displayName || user.username;
  return {
    id: "srv-" + require("crypto").randomBytes(8).toString("hex"),
    ts: new Date().toISOString(),
    action: "delete", name: "", set: "", collector: "", lang: "", finish: "", condition: "",
    qty: 0, oldQty: null, newQty: null, from: "", to: "",
    note: who + " removed " + (was - now) + " of " + was + " stacks (" + removedCards + " cards) in one save. " +
      "The version before it is kept as revision " + keptRev + " in Settings, Server-side revisions.",
    cost: null, receiptId: "",
    by: who, byUserId: user.id
  };
}

/* The valid personal-preference fields of a request body; anything else,
   or a value of the wrong type, is dropped. */
function personalPrefsFrom(body) {
  const out = {};
  if (!body || typeof body !== "object") return out;
  if (typeof body.simpleMode === "boolean") out.simpleMode = body.simpleMode;
  if (typeof body.chime === "boolean") out.chime = body.chime;
  // #244: the Dashboard's "Next steps" list, hidden for this person only.
  if (typeof body.nextStepsDismissed === "boolean") out.nextStepsDismissed = body.nextStepsDismissed;
  const min = Number(body.chimeMin);
  if (body.chimeMin !== undefined && body.chimeMin !== null && body.chimeMin !== "" && isFinite(min) && min >= 0 && min <= 1e6) {
    out.chimeMin = min;
  }
  // #298: the Dashboard's tiles, in order, as [{ id, wide? }]; null = the
  // default layout. Same rules as core.js dashLayoutClean: bad or repeated
  // ids are dropped, at most DASH_TILES_MAX kept.
  if (body.dashTiles === null) out.dashTiles = null;
  else if (Array.isArray(body.dashTiles)) {
    const seen = new Set(), list = [];
    for (const t of body.dashTiles) {
      const id = t && typeof t === "object" ? t.id : null;
      if (typeof id !== "string" || !DASH_TILE_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      list.push(t.wide === true ? { id, wide: true } : { id });
      if (list.length >= DASH_TILES_MAX) break;
    }
    out.dashTiles = list;
  }
  // #455: the "What's new" tutorials finished, as ids. Same rules as ui.js
  // whatsNewClean: bad or repeated ids dropped, the newest WHATS_NEW_MAX kept
  // (60 x 32 characters stays well inside the route's 4 KB body).
  if (Array.isArray(body.whatsNewDone)) out.whatsNewDone = whatsNewClean(body.whatsNewDone);
  return out;
}
const DASH_TILE_ID = /^[a-z][a-zA-Z0-9-]{0,31}$/;
const DASH_TILES_MAX = 60;
const WHATS_NEW_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const WHATS_NEW_MAX = 60;
function whatsNewClean(list) {
  const seen = new Set(), out = [];
  for (const id of Array.isArray(list) ? list : []) {
    if (typeof id !== "string" || !WHATS_NEW_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-WHATS_NEW_MAX);
}

/* Re-checks an org invite at the moment it's used (#126), rather than
   trusting the orgMeta stored when it was made. The org must still exist;
   the inviter must still be in it, not disabled, and still entitled to
   send this kind of invite (an Owner for an owner/manager invite, a
   Manager or Owner for a staff invite). storeIds are re-filtered to the
   org's current active stores. Returns { orgMeta } to apply, or
   { error } to refuse with. */
async function checkOrgInviteAtUse(invite) {
  const meta = invite && invite.orgMeta;
  if (!meta || !meta.orgId) return { error: "That invite isn't for an organization." };
  const org = await orgById(meta.orgId);
  if (!org) return { error: "The organization this invite is for no longer exists." };
  const role = auth.ORG_ROLES.includes(meta.orgRole) ? meta.orgRole : "staff";
  const inviter = invite.createdBy ? await auth.findUserById(invite.createdBy) : null;
  const stillEntitled = !!inviter && !inviter.disabled && inviter.orgId === meta.orgId &&
    (role === "staff" ? isOrgManager(inviter) : isOrgOwner(inviter));
  if (!stillEntitled) {
    return { error: "This invite is no longer valid: the person who sent it can no longer invite people to that organization. Ask for a new invite." };
  }
  const storeIds = role === "staff" ? await filterStoreIds(meta.orgId, meta.storeIds) : [];
  return { orgMeta: { orgId: meta.orgId, orgRole: role, storeIds } };
}

/* The one chokepoint every collection-scoped route resolves its storage key
   through (server/index.js's handle(), alongside auth.userFromRequest()) -
   see BACKLOG.md #9's "Request-context resolution" design. A personal
   account gets its own bare id back, completely unchanged from today. An
   org account gets "store:<id>" for whichever Store its session last
   switched to (user.__activeStoreId, stashed by auth.userFromRequest onto
   the user object the same way __sid already is) - re-validated against
   current access on every call, not just at switch time, since role/store
   assignment can change between requests. Falls back to the first
   accessible store if the session has none set yet or it's since become
   inaccessible (a demoted staff member, an archived store), rather than
   erroring - the caller always gets *some* valid store or null, never a
   half-authorized state. */
async function resolveDocOwner(user) {
  if (!user) return null;
  if (!user.orgId) return user.id; // personal account - unchanged today's behavior
  const mine = await accessibleStores(user);
  if (!mine.length) return null; // org member with nothing assigned yet
  const active = user.__activeStoreId;
  if (active && mine.some(s => s.id === active)) return "store:" + active;
  return "store:" + mine[0].id;
}

/* Creates an org from the caller's existing personal account: the account
   becomes Owner, and its current collection (current.json + rev/ history)
   is MOVED - not copied - into the org's first Store, per the locked-in
   "import existing collection as Store 1" decision. Refuses if the account
   is already in an org (leave first). */
async function createOrg(user, name) {
  if (user.orgId) { const e = new Error("This account already belongs to an organization."); e.status = 400; throw e; }
  const orgName = String(name || "").trim().slice(0, 80) || (user.displayName || user.username) + "'s organization";
  const org = { id: httpu.randomId(12), name: orgName, ownerId: user.id, createdAt: new Date().toISOString() };
  const firstStore = { id: httpu.randomId(12), orgId: org.id, name: "Store 1", createdAt: new Date().toISOString(), archived: false };

  // Read-modify-write under each file's lock, so two orgs (or stores)
  // created at the same moment can't overwrite each other's entry.
  await store.updateOrgs(doc => { doc.orgs.push(org); });
  await store.updateStoreList(doc => { doc.stores.push(firstStore); });

  await store.moveCollectionToStore(user.id, firstStore.id);
  await auth.setOrgMembership(user.id, { orgId: org.id, orgRole: "owner" }, { by: user.id });

  return { org, store: firstStore };
}

/* Adds an empty Store to an existing org - Owner/Manager only, enforced by
   the caller (route-level, mirroring how {admin:true} is checked today). */
async function addStore(orgId, name) {
  const org = await orgById(orgId);
  if (!org) { const e = new Error("No such organization."); e.status = 404; throw e; }
  const s = { id: httpu.randomId(12), orgId, name: String(name || "").trim().slice(0, 80) || "New store", createdAt: new Date().toISOString(), archived: false };
  await store.updateStoreList(doc => { doc.stores.push(s); });
  return s;
}

async function renameStore(storeId, name) {
  const trimmed = String(name || "").trim().slice(0, 80);
  if (!trimmed) { const e = new Error("Give the store a name."); e.status = 400; throw e; }
  // Under the stores lock: a rename that read the list before an archive
  // or restore landed would otherwise write the old archived flag back.
  return store.updateStoreList(doc => {
    const s = doc.stores.find(x => x.id === storeId);
    if (!s) { const e = new Error("No such store."); e.status = 404; throw e; }
    s.name = trimmed;
    return s;
  });
}

/* Owner-only at the route (#127). Refuses the org's last active store:
   with none left, resolveDocOwner() returns null for every member and the
   whole org loses its inventory. The check and the write share one lock
   (store.updateStoreList), so two archives at once can't both pass. */
async function archiveStore(storeId, byUserId) {
  let changed = false;
  const s = await store.updateStoreList(doc => {
    const s = doc.stores.find(x => x.id === storeId);
    if (!s) { const e = new Error("No such store."); e.status = 404; throw e; }
    if (s.archived) return s;
    changed = true;
    const othersActive = doc.stores.filter(x => x.orgId === s.orgId && !x.archived && x.id !== s.id).length;
    if (!othersActive) {
      const e = new Error("You can't archive your organization's last active store. Add another store first."); e.status = 400; throw e;
    }
    s.archived = true;
    s.archivedAt = new Date().toISOString();
    s.archivedBy = byUserId || null;
    return s;
  });
  await clearStoreChoices(s);
  // #139: the members who could use it hear about it (lazily required:
  // notifyEvents needs this module). Only on an actual change.
  if (changed) await require("./notifyEvents").storeStatusChanged(s, true, byUserId);
  return s;
}

/* #128: archiving a store clears it as the saved "Share and trade from"
   choice of every member of its org, at once, so restoring the store
   never quietly shares it again. Bounded by the org's size; taken after
   the stores lock is released (stores, then prefs; never nested). */
async function clearStoreChoices(s) {
  if (!s || !s.orgId) return;
  for (const m of await membersOfOrg(s.orgId)) {
    // #147: with a note, so the member is told (lazily required: actFrom needs this module).
    await store.updatePrefs(m.id, prefs => { require("./actFrom").dropChoice(prefs, "archived", s.id, () => s.name); });
  }
}

/* Brings an archived store back (#127, Owner-only at the route). Its
   inventory, history and audit log never left disk, so it comes back
   exactly as it was archived. */
async function restoreStore(storeId, byUserId) {
  let changed = false;
  const s = await store.updateStoreList(doc => {
    const s = doc.stores.find(x => x.id === storeId);
    if (!s) { const e = new Error("No such store."); e.status = 404; throw e; }
    changed = !!s.archived;
    s.archived = false;
    s.restoredAt = new Date().toISOString();
    return s;
  });
  if (changed) await require("./notifyEvents").storeStatusChanged(s, false, byUserId);
  return s;
}

/* Every account belonging to an org, for the org-management page's member
   list - projected through auth.publicUser() the same as any other
   account listing, never raw user records. */
async function membersOfOrg(orgId) {
  const all = await auth.listUsers(); // already publicUser()-projected
  return all.filter(u => u.orgId === orgId);
}

module.exports = {
  listOrgs, orgById, listAllStores, storeById, storesOfOrg, archivedStoresOfOrg, filterStoreIds, memberStoreIds,
  accessibleStores, canAccessStore, isOrgManager, isOrgOwner, memberChangeProblem, checkOrgInviteAtUse,
  canReplaceInventory, lockedSettingKeys, personalPrefsFrom, whatsNewClean, staffBigDropEntry, STORE_DEFAULT_KEYS, PERSONAL_PREF_KEYS,
  resolveDocOwner, createOrg, addStore, renameStore, archiveStore, restoreStore, membersOfOrg
};
