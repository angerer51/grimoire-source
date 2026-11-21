"use strict";
/* Who hears about what (#139). One function per event in the issue's
   table, each called from the single place that state changes:

     tradeProposed            POST /api/trades/propose (after it's saved)
     tradeStatusChanged       trades.changeStatus (respond route, archive sweep)
     shareStarted             POST /api/friends (a level going Off -> Summary/Full)
     friendRequested          POST /api/friends/requests (a new request, #140)
     friendAccepted           accepting one, or a request crossing one the other way
     friendRequestClosed      declining or cancelling one (tells nobody)
     invitedFriendJoined      POST /api/auth/register with a member's link (#337)
     ticketReplied            notifyTicketReply (staff reply, GitHub auto-reply)
     membershipChanged        auth.setOrgMembership
     storeStatusChanged       orgs.archiveStore / orgs.restoreStore
     restocksSaved            PUT /api/collection (new untold "came in" matches)
   and the daily pass in notifyJob.js (price alerts, a friend has a card).

   Rules every event follows:
   - Recipients are worked out NOW: a store side fans out to that store's
     CURRENT Owners/Managers, never a list captured earlier. Disabled
     accounts get nothing, and nothing is sent on a disabled account's
     behalf (#142).
   - The person who did the thing isn't told about it.
   - Text is written per recipient from what THEY may see: trade text comes
     from actFrom.viewerCopy, the same projection GET /api/trades gives
     them, so a store name or username hidden there is hidden here too.
   - Every item carries a scope; canOpen() re-checks it when the link is
     opened, since rank, sharing and stores can all change after sending.
   - Never throws: a notification failing is logged, and the action that
     caused it has already succeeded.

   Flow: docs/flows/notifications.dot. */

const store = require("./store");
const auth = require("./auth");
const orgs = require("./orgs");
const actFrom = require("./actFrom");
const friends = require("./friends");
const notifications = require("./notifications");

let log = () => {};
function init(deps) { if (deps && deps.log) log = deps.log; }

const enc = encodeURIComponent;
const quote = s => "“" + String(s || "").slice(0, 120) + "”";

/* Every event runs through here: errors are logged, never thrown, and the
   run is tracked so idle() can wait for fire-and-forget ones (tests). */
const inFlight = new Set();
function safely(what, fn) {
  const run = (async () => {
    try { return await fn(); }
    catch (e) { log("[notify] " + what + " failed: " + (e.stack || e.message)); return null; }
  })();
  inFlight.add(run);
  run.finally(() => inFlight.delete(run));
  return run;
}
async function idle() { while (inFlight.size) await Promise.all([...inFlight]); }

/* ---------- recipients ---------- */

async function activeUser(id) {
  if (typeof id !== "string" || !id) return null;
  const u = await auth.findUserById(id);
  return u && !u.disabled ? u : null;
}

/* Current Owners/Managers of an active store, not disabled. */
async function storeManagers(storeId) {
  const s = await orgs.storeById(storeId);
  if (!s || s.archived) return [];
  const db = await store.readUsers();
  return db.users.filter(u => !u.disabled && u.orgId === s.orgId && orgs.isOrgManager(u));
}

/* Everyone who can open an inventory now: its owner for a personal one,
   every account with access to the store (Owners, Managers and the Staff
   assigned to it) for a store. */
async function inventoryReaders(ownerKey) {
  if (typeof ownerKey !== "string" || !ownerKey) return [];
  if (!ownerKey.startsWith("store:")) {
    const u = await activeUser(ownerKey);
    return u && !u.orgId ? [u] : [];
  }
  const storeId = ownerKey.slice("store:".length);
  const s = await orgs.storeById(storeId);
  if (!s || s.archived) return [];
  const db = await store.readUsers();
  const out = [];
  for (const u of db.users) {
    if (u.disabled || u.orgId !== s.orgId) continue;
    if (await orgs.canAccessStore(u, storeId)) out.push(u);
  }
  return out;
}

/* One side of a proposal: the store's current managers, or the person. */
async function sideAccounts(storeId, userId) {
  if (storeId) return storeManagers(storeId);
  const u = await activeUser(userId);
  return u ? [u] : [];
}

/* ---------- trades ---------- */

const proposalLink = id => "/trades.html?proposal=" + enc(id);
const proposalScope = id => ({ t: "proposal", id });

const fromLabel = v => v.fromStoreName ? v.fromStoreName + " (" + v.fromUsername + ")" : v.fromUsername;
const toLabel = v => v.toStoreName ? v.toUsername + " at " + v.toStoreName : v.toUsername;

async function viewFor(p, u) {
  const v = actFrom.viewerCopy(p, u, await actFrom.managedStoreIds(u));
  return v.incoming || v.outgoing ? v : null;
}

/* A new offer: the recipient, or every current Owner/Manager of the store
   it was sent to. */
async function tradeProposed(p) {
  return safely("trade proposed", async () => {
    if (!p || !p.id) return;
    for (const u of await sideAccounts(p.toStoreId, p.toUserId)) {
      if (u.id === p.fromUserId) continue;
      const v = await viewFor(p, u);
      if (!v || !v.incoming) continue;
      await notifications.notify([u.id], {
        kind: "trade-received", ref: p.id, link: proposalLink(p.id), scope: proposalScope(p.id),
        text: fromLabel(v) + " sent " + (v.toStoreName || "you") + " a trade offer."
      });
    }
  });
}

/* Called by trades.changeStatus for every status change (the one place a
   status changes). Runs after the proposals file is written: it queues on
   the same lock the change was made under, then re-reads the record, so a
   change that was never saved notifies nobody.
   - accepted / declined: the sending side.
   - withdrawn: the receiving side; but when it was the RECEIVING store
     that was archived, the sending side (their offer just went away). */
async function tradeStatusChanged(id, status, byUserId) {
  return safely("trade status", async () => {
    await store.withLock("tradeProposals", async () => {});
    const db = await store.readTradeProposals();
    const p = db.proposals.find(x => x && x.id === id);
    if (!p || p.status !== status) return;
    let side, kind;
    if (status === "accepted" || status === "declined") { side = "from"; kind = "trade-answered"; }
    else if (status === "withdrawn") {
      kind = "trade-withdrawn";
      side = p.statusReasonStoreId && p.statusReasonStoreId === p.toStoreId ? "from" : "to";
    } else return;
    const accounts = side === "from" ? await sideAccounts(p.fromStoreId, p.fromUserId) : await sideAccounts(p.toStoreId, p.toUserId);
    for (const u of accounts) {
      if (u.id === byUserId) continue;
      const v = await viewFor(p, u);
      if (!v) continue;
      let text;
      if (side === "from") {
        if (!v.outgoing) continue;
        const whose = v.fromStoreName ? "The trade offer from " + v.fromStoreName : "Your trade offer";
        text = whose + " to " + toLabel(v) + (status === "withdrawn" ? " was withdrawn" : " was " + status) +
          (status === "withdrawn" && v.statusReason ? ": " + v.statusReason : "") + ".";
      } else {
        if (!v.incoming) continue;
        text = "The trade offer from " + fromLabel(v) + " was withdrawn" + (v.statusReason ? ": " + v.statusReason : "") + ".";
      }
      await notifications.notify([u.id], { kind, ref: p.id, text, link: proposalLink(p.id), scope: proposalScope(p.id) });
    }
  });
}

/* ---------- sharing ---------- */

/* POST /api/friends: `owner` changed `viewerUsername`'s level from
   `before` to `after`. Only Off -> Summary/Full is news. A disabled owner
   shares nothing (#142), so nothing is sent for one. */
async function shareStarted(owner, viewerUsername, before, after) {
  return safely("share started", async () => {
    if (before !== "off" || (after !== "summary" && after !== "full")) return;
    if (!owner || await actFrom.isDisabled(owner)) return;
    const viewer = await auth.findUser(String(viewerUsername || ""));
    if (!viewer || viewer.disabled || viewer.id === owner.id) return;
    const src = await actFrom.resolve(owner);
    if (!src || !src.owner) return;
    const what = src.kind === "store" ? src.storeName + (src.orgName ? " (" + src.orgName + ")" : "") : "their collection";
    await notifications.notify([viewer.id], {
      kind: "share-started", ref: owner.id,
      text: owner.username + " started sharing " + what + " with you" + (after === "summary" ? " (a summary)." : "."),
      link: "/social.html?friend=" + enc(owner.username), scope: { t: "share", owner: owner.id, min: "summary" }
    });
  });
}

/* ---------- friend requests (#140) ----------
   Each tells exactly one person. One item per sender (ref = their id), so
   asking again after a cancel refreshes it rather than stacking. Decline
   and cancel tell nobody (owner's decision); they only mark the
   recipient's own item read, so nothing unread is left leading nowhere. */

const requestRef = senderId => "from:" + senderId;

/* friends.send() said "sent": `target` has a new request from `sender`. */
async function friendRequested(sender, target) {
  return safely("friend request", async () => {
    if (!sender || !target || sender.id === target.id || await actFrom.isDisabled(sender)) return;
    const to = await activeUser(target.id);
    if (!to) return;
    await notifications.notify([to.id], {
      kind: "friend-request", ref: requestRef(sender.id),
      text: sender.username + " sent you a friend request.",
      link: "/social.html#requests", scope: { t: "friendRequest", from: sender.id }
    });
  });
}

/* A request was accepted (or crossed one the other way): `accepter` and
   `senderId` are now friends. The sender is told; the accepter's own
   "sent you a friend request" item is marked read. */
async function friendAccepted(accepter, senderId) {
  return safely("friend accepted", async () => {
    if (!accepter || !senderId || accepter.id === senderId) return;
    await notifications.markReadByRef(accepter.id, "friend-request", requestRef(senderId));
    const to = await activeUser(senderId);
    if (!to || await actFrom.isDisabled(accepter)) return;
    await notifications.notify([to.id], {
      kind: "friend-accepted", ref: accepter.id,
      text: accepter.username + " accepted your friend request.",
      link: "/social.html#friends", scope: { t: "friend", id: accepter.id }
    });
  });
}

/* #337: `newUser` signed up with `inviter`'s link and they are now friends.
   Each is told, so the new person doesn't just find a stranger in Friends. */
async function invitedFriendJoined(inviter, newUser) {
  return safely("invited friend joined", async () => {
    if (!inviter || !newUser) return;
    await notifications.notify([inviter.id], {
      kind: "friend-accepted", ref: newUser.id,
      text: newUser.username + " joined with your invite. You're now friends.",
      link: "/social.html#friends", scope: { t: "friend", id: newUser.id }
    });
    await notifications.notify([newUser.id], {
      kind: "friend-accepted", ref: inviter.id,
      text: "You're now friends with " + inviter.username + ", who invited you. Nothing is shared unless one of you chooses.",
      link: "/social.html#friends", scope: { t: "friend", id: inviter.id }
    });
  });
}

/* Declined or cancelled: nobody is told. The recipient's item for it is
   marked read. */
async function friendRequestClosed(senderId, recipientId) {
  return safely("friend request closed", async () => {
    if (!senderId || !recipientId) return;
    await notifications.markReadByRef(recipientId, "friend-request", requestRef(senderId));
  });
}

/* ---------- support tickets ---------- */

const isStaff = role => (auth.ROLE_RANK[role] || 0) >= auth.ROLE_RANK.moderator;

/* A staff reply (or the GitHub sync's automatic one) tells the reporter. */
async function ticketReplied(t, replier) {
  return safely("ticket reply", async () => {
    if (!t || !t.id || !replier || !isStaff(replier.role) || replier.id === t.createdBy) return;
    const reporter = await activeUser(t.createdBy);
    if (!reporter) return;
    await notifications.notify([reporter.id], {
      kind: "ticket-reply", ref: t.id,
      text: (replier.username || "Support") + " replied to your ticket " + quote(t.subject) + ".",
      link: "/help.html?ticket=" + enc(t.id) + "#support", scope: { t: "ticket", id: t.id }
    });
  });
}

/* ---------- organizations ---------- */

const ROLE_WORD = { owner: "Owner", manager: "Manager", staff: "Staff" };

/* auth.setOrgMembership: added to an org, or a new role in the same one.
   Nothing when the person did it themselves (creating an org, stepping
   down) or was removed (they can no longer open the Organization page). */
async function membershipChanged(userId, before, after, byUserId) {
  return safely("membership", async () => {
    if (!after || !after.orgId || byUserId === userId) return;
    const u = await activeUser(userId);
    if (!u) return;
    const org = await orgs.orgById(after.orgId);
    const name = (org && org.name) || "an organization";
    let kind, text;
    if (!before || before.orgId !== after.orgId) { kind = "org-added"; text = "You were added to " + name + " as " + ROLE_WORD[after.orgRole] + "."; }
    else if (before.orgRole !== after.orgRole) { kind = "org-role"; text = "Your role in " + name + " is now " + ROLE_WORD[after.orgRole] + "."; }
    else return;
    await notifications.notify([u.id], { kind, ref: after.orgId, text, link: "/org.html", scope: { t: "org", orgId: after.orgId } });
  });
}

/* orgs.archiveStore / restoreStore, on an actual change only. Told: the
   org's members who could use the store (Owners, Managers, its assigned
   Staff), other than the person who did it. */
async function storeStatusChanged(storeRec, archived, byUserId) {
  return safely("store status", async () => {
    if (!storeRec || !storeRec.id || !storeRec.orgId) return;
    const db = await store.readUsers();
    for (const u of db.users) {
      if (u.disabled || u.orgId !== storeRec.orgId || u.id === byUserId) continue;
      if (!orgs.isOrgManager(u) && !(u.storeIds || []).includes(storeRec.id)) continue;
      await notifications.notify([u.id], {
        kind: "store-status", ref: storeRec.id,
        text: (storeRec.name || "A store") + (archived ? " was archived." : " was restored."),
        link: "/org.html", scope: { t: "org", orgId: storeRec.orgId }
      });
    }
  });
}

/* ---------- customer wantlists (#59) ---------- */

const RESTOCK_MAX_PER_SAVE = 20;

/* The "came in" matches a save adds or bumps: untold, and either new or
   with a newer `ts` than before (more copies arrived). Pure. Restoring an
   old revision doesn't come through here (only PUT /api/collection does),
   so old matches reappearing never count. */
function newRestocks(prevState, nextState) {
  const prev = new Map(((prevState && prevState.restockMatches) || []).filter(m => m && m.id).map(m => [m.id, m]));
  const out = [];
  for (const m of (nextState && Array.isArray(nextState.restockMatches) ? nextState.restockMatches : [])) {
    if (!m || typeof m.id !== "string" || m.toldAt) continue;
    const was = prev.get(m.id);
    if (was && !was.toldAt && String(was.ts) === String(m.ts)) continue;
    out.push(m);
    if (out.length >= RESTOCK_MAX_PER_SAVE) break;
  }
  return out;
}

/* Never names the customer (personal data stays on the Customers page). */
async function restocksSaved(ownerKey, matches) {
  return safely("restocks", async () => {
    if (!matches || !matches.length) return;
    const readers = await inventoryReaders(ownerKey);
    if (!readers.length) return;
    let prefix = "";
    if (ownerKey.startsWith("store:")) {
      const s = await orgs.storeById(ownerKey.slice(6));
      prefix = ((s && s.name) || "Store") + ": ";
    }
    for (const m of matches) {
      const name = typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 120) : "a wanted card";
      const n = Math.max(0, Math.floor(Number(m.available) || 0));
      await notifications.notify(readers.map(u => u.id), {
        kind: "want-came-in", ref: ownerKey + ":" + m.id,
        text: prefix + "A card a customer wants came in: " + name + (n ? " (" + n + " in stock)." : "."),
        link: "/customers.html?tab=came-in&match=" + enc(m.id), scope: { t: "inv", key: ownerKey }
      });
    }
  });
}

/* A customer sent an order from the store's kiosk (#433): everyone who works
   in that inventory hears of it, since a desk page only sees it on its next
   load or save. ticket: the saved kiosk ticket. */
async function kioskOrderPlaced(ownerKey, ticket) {
  return safely("kiosk order", async () => {
    if (!ticket || !ticket.id) return;
    const readers = await inventoryReaders(ownerKey);
    if (!readers.length) return;
    let prefix = "";
    if (ownerKey.startsWith("store:")) {
      const s = await orgs.storeById(ownerKey.slice(6));
      prefix = ((s && s.name) || "Store") + ": ";
    }
    const cards = (ticket.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
    const who = String((ticket.customer && ticket.customer.name) || "A customer").slice(0, 80);
    await notifications.notify(readers.map(u => u.id), {
      kind: "kiosk-order", ref: ownerKey + ":" + ticket.id + ":" + ticket.createdAt,
      text: prefix + "Kiosk order " + ticket.id + " from " + who + ": " + cards + " card" + (cards === 1 ? "" : "s") + " to pick.",
      link: "/lists.html?pick=" + enc(ticket.id), scope: { t: "inv", key: ownerKey }
    });
  });
}

/* ---------- opening a notification ---------- */

/* Re-checks a notification's scope for `user` NOW. Returns { ok, storeId }
   where storeId is the store the session must switch to for the link to
   show the right inventory. */
async function canOpen(user, scope) {
  if (!user || !scope || typeof scope !== "object") return { ok: false };
  switch (scope.t) {
    case "proposal": {
      const db = await store.readTradeProposals();
      const p = db.proposals.find(x => x && x.id === scope.id);
      return { ok: !!p && !!(await viewFor(p, user)) };
    }
    case "share": return { ok: await sharesWith(scope.owner, user, scope.min) };
    case "ticket": {
      const db = await store.readTickets();
      const t = db.tickets.find(x => x && x.id === scope.id);
      return { ok: !!t && (t.createdBy === user.id || isStaff(user.role)) };
    }
    case "org": return { ok: !!user.orgId && user.orgId === scope.orgId && !!(await orgs.orgById(scope.orgId)) };
    case "inv": return invAccess(user, scope.key);
    // #140: a request still waiting for this reader (or already accepted),
    // and a friendship that still stands, with an account not disabled.
    case "friendRequest": {
      if (!(await activeUser(scope.from))) return { ok: false };
      const doc = await friends.read();
      return { ok: friends.waiting(doc, scope.from, user.id) || friends.areFriends(doc, scope.from, user.id) };
    }
    case "friend": {
      if (!(await activeUser(scope.id))) return { ok: false };
      return { ok: friends.areFriends(await friends.read(), scope.id, user.id) };
    }
    case "friendWatch": {
      // Still a personal Full share between FRIENDS (owner's rule, #139,
      // and #140): a friend who drops to Summary, leaves only a
      // server-wide share, or unfriends can't be opened from here.
      const inv = await invAccess(user, scope.key);
      return inv.ok && await sharesWith(scope.friend, user, "full", { personal: true }) ? inv : { ok: false };
    }
    default: return { ok: false };
  }
}

/* What opening `item` does for `user` now (POST /api/notifications/:id/open).
   It never switches the session's store itself: a save from the page the
   reader is on carries no owner, so a switch made here, before that page's
   unsaved edits had saved, would put them into the other store (PR #144
   review). Instead it names the store (switchTo) and the one the session
   is in now (from); the page saves, says so, switches through
   /api/store/switch, and only then follows the link. */
async function openTarget(user, item, docOwner) {
  const link = item ? notifications.safeLink(item.link) : null;
  const access = link ? await canOpen(user, item.scope) : { ok: false };
  if (!access.ok) return { ok: false };
  const out = { ok: true, link, switchTo: null, from: null };
  if (access.storeId && docOwner !== "store:" + access.storeId) {
    const s = await orgs.storeById(access.storeId);
    out.switchTo = { id: access.storeId, name: String((s && s.name) || "another store") };
    out.from = typeof docOwner === "string" && docOwner.startsWith("store:") ? docOwner.slice(6) : null;
  }
  return out;
}

async function invAccess(user, key) {
  if (typeof key !== "string" || !key) return { ok: false };
  if (!key.startsWith("store:")) return { ok: key === user.id && !user.orgId };
  const storeId = key.slice(6);
  return (await orgs.canAccessStore(user, storeId)) ? { ok: true, storeId } : { ok: false };
}

/* Whether `ownerId` still shares with `viewer` at `min` or more, and isn't
   disabled (#142). opts.personal: only a share made to the viewer by name,
   between friends (#140), counts, not the owner's "everyone else on this
   server" level. */
const RANK = { off: 0, summary: 1, full: 2 };
async function sharesWith(ownerId, viewer, min, opts) {
  const owner = await activeUser(ownerId);
  if (!owner || owner.id === viewer.id) return false;
  const prefs = await store.readPrefs(owner.id);
  const level = friends.levelBetween(await friends.read(), owner, prefs, viewer, opts);
  if ((RANK[level] || 0) < (RANK[min] || 1)) return false;
  const src = await actFrom.resolve(owner);
  return !!(src && src.owner);
}

module.exports = {
  init, idle, tradeProposed, tradeStatusChanged, shareStarted, friendRequested, friendAccepted, invitedFriendJoined, friendRequestClosed, ticketReplied, membershipChanged, storeStatusChanged,
  newRestocks, restocksSaved, kioskOrderPlaced, canOpen, openTarget, inventoryReaders, storeManagers, RESTOCK_MAX_PER_SAVE
};
