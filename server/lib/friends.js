"use strict";
/* Friendships and friend requests (#140).
   ----------------------------------------
   Before #140, "adding a friend" only wrote an entry into YOUR sharing
   list; the other person was never asked. Now two people are friends only
   once one has sent a request and the other has accepted it, and a
   personal share (a sharing-list entry at Summary or Full) counts only
   between friends (sharing.levelFor's `friend` argument). Sharing levels
   stay per person and per side, in each account's prefs.friends, as
   before: a friendship permits sharing, it doesn't share anything itself.

   Storage: one small document, friends.json, written only here under one
   lock ("friends"), so a crossed request (A asks B while B's request to A
   is waiting) is resolved in one step. Ids, not usernames: usernames can't
   change today, but ids are what everything else keys on.
     friendships: [{ a, b, since }]   a < b, one row per pair
     requests:    [{ id, from, to, createdAt, declinedAt? }]

   Rules (owner's decisions, issue #140):
   - Accept makes both friends and tells the sender. Decline is SILENT: the
     request stays on the sender's "sent" list as if still waiting
     (declinedAt is never shown to them) and leaves the recipient's list, so
     sending it again changes nothing and tells nobody. Cancel (the sender)
     deletes it, silently too.
   - A request crossing one the other way, declined or not, makes them
     friends straight away.
   - At most MAX_PENDING_OUT requests waiting per sender (a declined one
     still counts, until cancelled). No requests to yourself.
   - An unknown username and a disabled account (#142) get the same
     "No user named X on this server." as before #140, so the answer never
     says an account exists but is disabled. A disabled account can't send
     (it has no session anyway), and a request from one can't be accepted.
   - Unfriend removes the friendship for both and sets each side's sharing
     level for the other to Off (sharing.stopSharing).
   - A NEW friendship starts fresh: any entry either side had for the other
     (an Off left by an earlier unfriend, or one made for a username before
     that account existed) is deleted, so each sees what everyone else on
     the server sees until its owner picks a level.

   Existing data: every sharing entry that names a real account became an
   accepted friendship, once (migrateSharesOnce, marker in migrations.json),
   so nobody lost access. The request lifecycle is drawn in
   docs/flows/friend-requests.dot.

   Bounded (CLAUDE.md scale rule): requests are capped per sender, so the
   file holds at most MAX_PENDING_OUT x accounts requests; each event tells
   exactly one person. */

const crypto = require("crypto");
const store = require("./store");
const auth = require("./auth");
const sharing = require("./sharing");

const MAX_PENDING_OUT = 20;
const MIGRATION = "friendships-from-shares-140";
const LOCK = "friends";
const file = () => store.p("friends.json");

const err = (status, message) => Object.assign(new Error(message), { status });
const noSuchUser = uname => err(404, "No user named " + uname + " on this server.");
const notOpen = () => err(404, "That friend request is no longer open.");

function normalize(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  const str = x => typeof x === "string" && x;
  return {
    friendships: (Array.isArray(d.friendships) ? d.friendships : [])
      .filter(f => f && str(f.a) && str(f.b) && f.a !== f.b),
    requests: (Array.isArray(d.requests) ? d.requests : [])
      .filter(r => r && str(r.id) && str(r.from) && str(r.to) && r.from !== r.to)
  };
}

async function read() { return normalize(await store.readJson(file(), {})); }

function update(fn) {
  return store.withLock(LOCK, async () => {
    const doc = normalize(await store.readJson(file(), {}));
    const result = await fn(doc);
    await store.writeJson(file(), doc);
    return result;
  });
}

const pairOf = (x, y) => x < y ? [x, y] : [y, x];

function areFriends(doc, x, y) {
  if (!doc || typeof x !== "string" || typeof y !== "string" || !x || x === y) return false;
  const [a, b] = pairOf(x, y);
  return doc.friendships.some(f => f.a === a && f.b === b);
}

function friendIds(doc, id) {
  const out = new Set();
  for (const f of doc.friendships) {
    if (f.a === id) out.add(f.b);
    else if (f.b === id) out.add(f.a);
  }
  return out;
}

/* Adds the pair; false when they were friends already. */
function link(doc, x, y, since) {
  if (areFriends(doc, x, y)) return false;
  const [a, b] = pairOf(x, y);
  doc.friendships.push({ a, b, since: since || new Date().toISOString() });
  return true;
}

function unlink(doc, x, y) {
  const [a, b] = pairOf(x, y);
  const before = doc.friendships.length;
  doc.friendships = doc.friendships.filter(f => !(f.a === a && f.b === b));
  return doc.friendships.length !== before;
}

const between = (r, x, y) => (r.from === x && r.to === y) || (r.from === y && r.to === x);
const dropBetween = (doc, x, y) => { doc.requests = doc.requests.filter(r => !between(r, x, y)); };

/* The level `viewer` gets of `owner`'s share, given the owner's sharing
   settings (prefs, or readSharing()'s result) and the friends document.
   opts.personal: only a share made to the viewer by name counts (#139's
   "a friend has a card" rule). Disabled owners are the caller's check. */
function levelBetween(doc, owner, ownerSharing, viewer, opts) {
  if (!owner || !viewer) return "off";
  const friend = areFriends(doc, owner.id, viewer.id);
  return opts && opts.personal
    ? sharing.personalLevel(ownerSharing, viewer.username, friend)
    : sharing.levelFor(ownerSharing, viewer.username, friend);
}

/* A new friendship starts fresh (see the header). */
async function freshStart(x, y) {
  await store.updatePrefs(x.id, p => {
    if (Array.isArray(p.friends)) p.friends = sharing.stopSharing(p.friends, y.username, { forget: true });
  });
  await store.updatePrefs(y.id, p => {
    if (Array.isArray(p.friends)) p.friends = sharing.stopSharing(p.friends, x.username, { forget: true });
  });
}

const cleanName = raw => String(raw == null ? "" : raw).toLowerCase().trim().slice(0, 64);

/* Sends a friend request from `sender` to the account named `rawUsername`.
   Returns { status, target, request }:
     "sent"     a new request is waiting (tell the target);
     "pending"  one from the sender was already there (tell nobody);
     "friends"  theirs to the sender was waiting: now friends (tell the
                target their request was accepted);
     "already"  they were friends already.
   Throws { status } errors with the message to show. */
async function send(sender, rawUsername) {
  const uname = cleanName(rawUsername);
  if (!uname) throw err(400, "Whose username?");
  if (!sender || sender.disabled) throw err(403, "This account can't send friend requests.");
  if (uname === sender.username) throw err(400, "That is you.");
  const target = await auth.findUser(uname);
  if (!target || target.disabled) throw noSuchUser(uname);
  const out = await update(doc => {
    if (areFriends(doc, sender.id, target.id)) return { status: "already" };
    const mine = doc.requests.find(r => r.from === sender.id && r.to === target.id);
    if (mine) return { status: "pending", request: mine };
    const theirs = doc.requests.find(r => r.from === target.id && r.to === sender.id);
    if (theirs) {
      link(doc, sender.id, target.id);
      dropBetween(doc, sender.id, target.id);
      return { status: "friends", request: theirs };
    }
    if (doc.requests.filter(r => r.from === sender.id).length >= MAX_PENDING_OUT) {
      throw err(429, "You have " + MAX_PENDING_OUT + " friend requests waiting for an answer. Cancel one before sending another.");
    }
    const request = { id: crypto.randomBytes(9).toString("base64url"), from: sender.id, to: target.id, createdAt: new Date().toISOString() };
    doc.requests.push(request);
    return { status: "sent", request };
  });
  if (out.status === "friends") await freshStart(sender, target);
  return Object.assign(out, { target });
}

/* Someone just signed up with a member's invite link (#337): friends straight
   away, no request to accept (owner's decision, 2026-10-28). A friendship
   permits sharing and shares nothing itself, so the fresh start applies as it
   does to any new one. Returns whether a friendship was made. */
async function befriendInvited(newUser, inviter) {
  const created = await update(doc => {
    const made = link(doc, newUser.id, inviter.id);
    dropBetween(doc, newUser.id, inviter.id);
    return made;
  });
  if (created) await freshStart(newUser, inviter);
  return created;
}

/* The recipient accepts or declines, or the sender cancels.
   Returns { status: "accepted" | "declined" | "cancelled", request, other }
   where other is the account on the far side. A request that isn't open
   to this account for this action is "no longer open" (404), whoever's it
   is, so ids can't be probed. */
async function respond(user, id, action) {
  if (!["accept", "decline", "cancel"].includes(action)) throw err(400, "Accept, decline or cancel?");
  if (typeof id !== "string" || !id) throw notOpen();
  const out = await update(async doc => {
    const r = doc.requests.find(x => x.id === id);
    if (!r) throw notOpen();
    if (action === "cancel") {
      if (r.from !== user.id) throw notOpen();
      doc.requests = doc.requests.filter(x => x !== r);
      return { status: "cancelled", request: r, otherId: r.to };
    }
    if (r.to !== user.id || r.declinedAt) throw notOpen();
    const sender = await auth.findUserById(r.from);
    if (!sender || sender.disabled) throw notOpen();
    if (action === "decline") {
      r.declinedAt = new Date().toISOString();
      return { status: "declined", request: r, otherId: r.from };
    }
    const created = link(doc, user.id, r.from);
    dropBetween(doc, user.id, r.from);
    return { status: "accepted", request: r, otherId: r.from, created };
  });
  const other = await auth.findUserById(out.otherId);
  if (out.created && other) await freshStart(user, other);
  return { status: out.status, request: out.request, other };
}

/* Unfriend: no longer friends, any request between them gone, and each
   side's level for the other set to Off. The friendship goes first: from
   that moment neither side's personal share reaches the other, whatever
   happens to the two prefs writes after it. */
async function unfriend(user, rawUsername) {
  const uname = cleanName(rawUsername);
  const target = uname ? await auth.findUser(uname) : null;
  const was = target ? await update(doc => {
    const removed = unlink(doc, user.id, target.id);
    if (removed) dropBetween(doc, user.id, target.id);
    return removed;
  }) : false;
  if (!was) throw err(404, "You aren't friends with " + (uname || "them") + ".");
  await store.updatePrefs(user.id, p => { p.friends = sharing.stopSharing(p.friends, target.username); });
  await store.updatePrefs(target.id, p => { p.friends = sharing.stopSharing(p.friends, user.username); });
  return { target };
}

/* What Social's Requests section shows `user`: incoming requests still
   waiting (not declined, from an account that isn't disabled), and every
   request they sent that they haven't cancelled; a declined one looks
   just like a waiting one. Newest first. */
async function requestsFor(user, doc, usersById) {
  const d = doc || await read();
  const byId = usersById || new Map((await store.readUsers()).users.map(u => [u.id, u]));
  const row = (r, otherId) => {
    const u = byId.get(otherId);
    return u ? { id: r.id, username: u.username, displayName: u.displayName || u.username, at: r.createdAt } : null;
  };
  const newest = (a, b) => String(b.at).localeCompare(String(a.at));
  const incoming = d.requests
    .filter(r => r.to === user.id && !r.declinedAt && byId.has(r.from) && !byId.get(r.from).disabled)
    .map(r => row(r, r.from)).filter(Boolean).sort(newest);
  const outgoing = d.requests.filter(r => r.from === user.id).map(r => row(r, r.to)).filter(Boolean).sort(newest);
  return { incoming, outgoing, maxPending: MAX_PENDING_OUT };
}

/* Whether a request from `fromId` to `toId` is still waiting for the
   recipient (not declined). For the notification's open-time re-check. */
function waiting(doc, fromId, toId) {
  return doc.requests.some(r => r.from === fromId && r.to === toId && !r.declinedAt);
}

/* ---------- one-time migration (#140) ----------
   Every sharing entry that names a real account (other than its owner)
   becomes an accepted friendship, whatever its level, Off included: the
   owner's rule was "every existing sharing entry". Disabled accounts too,
   so turning one back on restores what it had (#142). Entries naming no
   account are left as they are; they never reach anybody (a non-friend's
   entry only ever counts as Off). Idempotent: an existing pair is never
   added twice. An account whose prefs can't be read is skipped and the
   marker isn't written, so the next boot runs it again. */
const validDate = s => typeof s === "string" && !isNaN(Date.parse(s)) ? s : null;

async function migrateShares() {
  const db = await store.readUsers();
  const byName = new Map(db.users.map(u => [u.username, u]));
  const pairs = [];
  let entries = 0, unknown = 0, skipped = 0;
  for (const u of db.users) {
    let prefs;
    try { prefs = await store.readPrefs(u.id); }
    catch (e) { skipped++; continue; }
    for (const f of Array.isArray(prefs && prefs.friends) ? prefs.friends : []) {
      if (!f || typeof f.username !== "string") continue;
      entries++;
      const v = byName.get(f.username);
      if (!v || v.id === u.id) { unknown++; continue; }
      pairs.push([u.id, v.id, validDate(f.addedAt)]);
    }
  }
  let created = 0;
  if (pairs.length) {
    await update(doc => { for (const [x, y, at] of pairs) if (link(doc, x, y, at)) created++; });
  }
  return { accounts: db.users.length, entries, created, unknown, skipped };
}

async function migrateSharesOnce() {
  if ((await store.readMigrations())[MIGRATION]) return null;
  const out = await migrateShares();
  if (!out.skipped) await store.markMigrationDone(MIGRATION);
  return out;
}

module.exports = {
  MAX_PENDING_OUT, MIGRATION,
  read, areFriends, friendIds, levelBetween, waiting,
  send, respond, unfriend, requestsFor, befriendInvited,
  migrateShares, migrateSharesOnce,
  _update: update, _link: link
};
