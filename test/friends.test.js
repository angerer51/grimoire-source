"use strict";
/* Friend requests (#140): send / accept / decline / cancel / crossed /
   unfriend, the limits (20 waiting, no self, unknown and disabled answer
   alike), who is told (accept tells the sender; decline and cancel tell
   nobody), the sharing rule (a personal share counts only between
   friends), and the one-time migration that turns every existing sharing
   entry into a friendship without anybody losing access. Against a
   scratch dataDir via store.init(), never the live one. The routes were
   exercised over HTTP on a scratch server; see the PR. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const sharing = lib("sharing");
const friends = lib("friends");
const notifications = lib("notifications");
const notifyEvents = lib("notifyEvents");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const PW = "correct-horse-1";

async function seed(names) {
  await notifyEvents.idle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-friends-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  notifications._resetCache();
  const ids = {};
  for (const n of names || ["alice", "bob", "carol", "dave"]) ids[n] = (await auth.createUser({ username: n, password: PW })).id;
  const u = async n => auth.findUserById(ids[n]);
  return { ids, u };
}

const kinds = async id => (await notifications.list(id)).map(x => x.kind + (x.read ? ":read" : ""));
const rejects = (p, status, msg) => assert.rejects(p, e => e.status === status && (!msg || e.message === msg));

/* What the routes do after friends.send / respond (server/index.js). */
async function sendAndTell(from, name) {
  const r = await friends.send(from, name);
  if (r.status === "sent") await notifyEvents.friendRequested(from, r.target);
  if (r.status === "friends") await notifyEvents.friendAccepted(from, r.target.id);
  return r;
}
async function respondAndTell(user, id, action) {
  const r = await friends.respond(user, id, action);
  if (r.status === "accepted") await notifyEvents.friendAccepted(user, r.request.from);
  else if (r.status === "declined") await notifyEvents.friendRequestClosed(r.request.from, user.id);
  else await notifyEvents.friendRequestClosed(user.id, r.request.to);
  return r;
}

/* ======================= the request lifecycle ======================= */

test("send then accept: both are friends, the request is gone, the sender is told and the bell item is read", async () => {
  const { ids, u } = await seed();
  const r = await sendAndTell(await u("alice"), "Bob ");
  assert.equal(r.status, "sent");
  assert.deepEqual(await kinds(ids.bob), ["friend-request"]);
  assert.equal((await notifications.list(ids.bob))[0].text, "alice sent you a friend request.");

  const bobReq = await friends.requestsFor(await u("bob"));
  assert.deepEqual(bobReq.incoming.map(x => x.username), ["alice"]);
  assert.deepEqual((await friends.requestsFor(await u("alice"))).outgoing.map(x => x.username), ["bob"]);

  // The bell item opens while the request waits.
  const item = (await store.readJson(notifications._fileOf(ids.bob), {})).items[0];
  assert.equal((await notifyEvents.canOpen(await u("bob"), item.scope)).ok, true);

  const a = await respondAndTell(await u("bob"), bobReq.incoming[0].id, "accept");
  assert.equal(a.status, "accepted");
  const doc = await friends.read();
  assert.equal(friends.areFriends(doc, ids.alice, ids.bob), true);
  assert.equal(doc.requests.length, 0);
  assert.deepEqual(await kinds(ids.alice), ["friend-accepted"]);
  assert.equal((await notifications.list(ids.alice))[0].text, "bob accepted your friend request.");
  assert.deepEqual(await kinds(ids.bob), ["friend-request:read"]);
  // Sending again now says so and tells nobody.
  assert.equal((await sendAndTell(await u("alice"), "bob")).status, "already");
  assert.deepEqual(await kinds(ids.bob), ["friend-request:read"]);
});

test("decline is silent: the sender isn't told and still sees it waiting; asking again changes nothing", async () => {
  const { ids, u } = await seed();
  const { request } = await sendAndTell(await u("alice"), "bob");
  await respondAndTell(await u("bob"), request.id, "decline");
  assert.deepEqual(await kinds(ids.alice), [], "the sender hears nothing");
  assert.deepEqual(await kinds(ids.bob), ["friend-request:read"]);
  assert.deepEqual((await friends.requestsFor(await u("bob"))).incoming, [], "gone from the recipient's list");
  const out = (await friends.requestsFor(await u("alice"))).outgoing;
  assert.deepEqual(out.map(x => x.username), ["bob"], "still waiting on the sender's side");
  assert.equal(Object.keys(out[0]).includes("declinedAt"), false, "nothing says it was declined");
  // Again: "pending", no new or re-opened item for bob.
  assert.equal((await sendAndTell(await u("alice"), "bob")).status, "pending");
  assert.deepEqual(await kinds(ids.bob), ["friend-request:read"]);
  // Bob can't accept or decline it any more.
  await rejects(friends.respond(await u("bob"), request.id, "accept"), 404, "That friend request is no longer open.");
  await rejects(friends.respond(await u("bob"), request.id, "decline"), 404);
  // Alice can still cancel it.
  assert.equal((await friends.respond(await u("alice"), request.id, "cancel")).status, "cancelled");
  assert.equal((await friends.read()).requests.length, 0);
});

test("cancel is silent: gone on both sides, the recipient's bell item is marked read, nobody is told", async () => {
  const { ids, u } = await seed();
  const { request } = await sendAndTell(await u("alice"), "bob");
  // Only the sender may cancel; anyone else gets "no longer open".
  await rejects(friends.respond(await u("bob"), request.id, "cancel"), 404);
  await rejects(friends.respond(await u("carol"), request.id, "accept"), 404);
  await respondAndTell(await u("alice"), request.id, "cancel");
  assert.deepEqual((await friends.requestsFor(await u("bob"))).incoming, []);
  assert.deepEqual((await friends.requestsFor(await u("alice"))).outgoing, []);
  assert.deepEqual(await kinds(ids.alice), []);
  assert.deepEqual(await kinds(ids.bob), ["friend-request:read"]);
  // The bell item no longer opens.
  const item = (await store.readJson(notifications._fileOf(ids.bob), {})).items[0];
  assert.equal((await notifyEvents.canOpen(await u("bob"), item.scope)).ok, false);
});

test("crossed requests resolve to friends, declined or not, and the first asker is told", async () => {
  const { ids, u } = await seed();
  await sendAndTell(await u("alice"), "bob");
  const r = await sendAndTell(await u("bob"), "alice");
  assert.equal(r.status, "friends");
  let doc = await friends.read();
  assert.equal(friends.areFriends(doc, ids.alice, ids.bob), true);
  assert.equal(doc.requests.length, 0);
  assert.deepEqual(await kinds(ids.alice), ["friend-accepted"]);
  assert.deepEqual(await kinds(ids.bob), ["friend-request:read"]);

  // carol asks dave; dave declines; later dave asks carol: friends.
  const { request } = await sendAndTell(await u("carol"), "dave");
  await friends.respond(await u("dave"), request.id, "decline");
  assert.equal((await sendAndTell(await u("dave"), "carol")).status, "friends");
  doc = await friends.read();
  assert.equal(friends.areFriends(doc, ids.carol, ids.dave), true);
  assert.equal(doc.requests.length, 0);
});

test("at most 20 waiting per sender (a declined one counts until cancelled); no self-requests", async () => {
  const names = Array.from({ length: 22 }, (_, i) => "user" + i);
  const { ids, u } = await seed(["alice"].concat(names));
  const alice = await u("alice");
  for (let i = 0; i < 20; i++) assert.equal((await friends.send(alice, "user" + i)).status, "sent");
  await rejects(friends.send(alice, "user20"), 429);
  // A recipient declining doesn't free a slot (the sender can't know)...
  const first = (await friends.read()).requests.find(r => r.to === ids.user0);
  await friends.respond(await u("user0"), first.id, "decline");
  await rejects(friends.send(alice, "user20"), 429);
  // ...cancelling does.
  await friends.respond(alice, first.id, "cancel");
  assert.equal((await friends.send(alice, "user20")).status, "sent");
  assert.equal((await friends.requestsFor(alice)).outgoing.length, 20);
  await rejects(friends.send(alice, "ALICE"), 400, "That is you.");
  await rejects(friends.send(alice, ""), 400);
});

test("an unknown name and a disabled account get the same answer; a disabled account can't send or be accepted", async () => {
  const { ids, u } = await seed();
  await rejects(friends.send(await u("alice"), "nobody"), 404, "No user named nobody on this server.");
  // carol asks alice, then carol is disabled.
  const { request } = await friends.send(await u("carol"), "alice");
  await auth.setDisabled(ids.bob, true);
  await auth.setDisabled(ids.carol, true);
  await rejects(friends.send(await u("alice"), "bob"), 404, "No user named bob on this server.");
  await rejects(friends.send(await u("carol"), "dave"), 403);
  assert.deepEqual((await friends.requestsFor(await u("alice"))).incoming, [], "a disabled sender's request is hidden");
  await rejects(friends.respond(await u("alice"), request.id, "accept"), 404);
  // No notification goes to or from a disabled account.
  await notifyEvents.friendRequested(await u("alice"), await u("bob"));
  assert.deepEqual(await kinds(ids.bob), []);
  await notifyEvents.friendRequested(await u("carol"), await u("dave"));
  assert.deepEqual(await kinds(ids.dave), []);
  // Turned back on: the request can be answered again.
  await auth.setDisabled(ids.carol, false);
  assert.equal((await friends.respond(await u("alice"), request.id, "accept")).status, "accepted");
});

test("a request answered with a bad action or a made-up id says so", async () => {
  const { u } = await seed();
  const { request } = await friends.send(await u("alice"), "bob");
  await rejects(friends.respond(await u("bob"), request.id, "maybe"), 400);
  await rejects(friends.respond(await u("bob"), "nope", "accept"), 404);
  await rejects(friends.respond(await u("bob"), { id: request.id }, "accept"), 404);
});

/* ======================= sharing between friends ======================= */

test("a personal share counts only between friends; Off always wins; everyone else gets defaultShare", () => {
  const s = { friends: [{ username: "f", share: "full" }, { username: "o", share: "off" }, { username: "j", share: "everything" }], defaultShare: "summary" };
  assert.equal(sharing.levelFor(s, "f", true), "full");
  assert.equal(sharing.levelFor(s, "f", false), "summary", "not a friend: everyone else");
  assert.equal(sharing.levelFor(s, "o", true), "off");
  assert.equal(sharing.levelFor(s, "o", false), "off", "an Off entry beats defaultShare (#124)");
  assert.equal(sharing.levelFor(s, "j", true), "off");
  assert.equal(sharing.levelFor(s, "nobody", true), "summary", "a friend with no level of their own");
  assert.equal(sharing.levelFor(s, "nobody", false), "summary");
});

test("unfriend: gone for both, each side set to Off (beating defaultShare), waiting requests dropped", async () => {
  const { ids, u } = await seed();
  const { request } = await friends.send(await u("alice"), "bob");
  await friends.respond(await u("bob"), request.id, "accept");
  await store.updatePrefs(ids.alice, p => { p.friends = [{ username: "bob", share: "full" }]; p.defaultShare = "full"; });
  await store.updatePrefs(ids.bob, p => { p.friends = [{ username: "alice", share: "summary" }]; });
  let doc = await friends.read();
  assert.equal(friends.levelBetween(doc, await u("alice"), await store.readPrefs(ids.alice), await u("bob")), "full");

  await friends.unfriend(await u("bob"), "alice");
  doc = await friends.read();
  assert.equal(friends.areFriends(doc, ids.alice, ids.bob), false);
  assert.equal(friends.levelBetween(doc, await u("alice"), await store.readPrefs(ids.alice), await u("bob")), "off");
  assert.equal(friends.levelBetween(doc, await u("bob"), await store.readPrefs(ids.bob), await u("alice")), "off");
  assert.deepEqual((await store.readPrefs(ids.alice)).friends.map(f => f.username + ":" + f.share), ["bob:off"]);
  assert.deepEqual((await store.readPrefs(ids.bob)).friends.map(f => f.username + ":" + f.share), ["alice:off"]);
  await rejects(friends.unfriend(await u("bob"), "alice"), 404, "You aren't friends with alice.");
  await rejects(friends.unfriend(await u("bob"), "nobody"), 404, "You aren't friends with nobody.");
});

test("a new friendship starts fresh: old entries for each other go, so each sees 'everyone else' until picked", async () => {
  const { ids, u } = await seed();
  // alice once shared Full with a name before that account existed, and
  // bob had alice at Off after an earlier unfriend.
  await store.updatePrefs(ids.alice, p => { p.friends = [{ username: "erin", share: "full" }, { username: "carol", share: "summary" }]; });
  await store.updatePrefs(ids.bob, p => { p.friends = [{ username: "alice", share: "off" }]; p.defaultShare = "summary"; });
  const erin = await auth.createUser({ username: "erin", password: PW });
  // Not friends yet: the old Full entry gives erin nothing.
  assert.equal(friends.levelBetween(await friends.read(), await u("alice"), await store.readPrefs(ids.alice), erin), "off");
  const { request } = await friends.send(erin, "alice");
  await friends.respond(await u("alice"), request.id, "accept");
  assert.deepEqual((await store.readPrefs(ids.alice)).friends.map(f => f.username), ["carol"], "erin's old entry is gone");
  assert.equal(friends.levelBetween(await friends.read(), await u("alice"), await store.readPrefs(ids.alice), erin), "off");
  // Re-friending after an Off: bob's Off for alice goes, so alice sees bob's defaultShare.
  assert.equal((await friends.send(await u("alice"), "bob")).status, "sent");
  assert.equal((await friends.send(await u("bob"), "alice")).status, "friends");
  assert.deepEqual((await store.readPrefs(ids.bob)).friends, []);
  assert.equal(friends.levelBetween(await friends.read(), await u("bob"), await store.readPrefs(ids.bob), await u("alice")), "summary");
});

test("an accepted notification opens only while still friends", async () => {
  const { ids, u } = await seed();
  const { request } = await sendAndTell(await u("alice"), "bob");
  await respondAndTell(await u("bob"), request.id, "accept");
  const item = (await store.readJson(notifications._fileOf(ids.alice), {})).items[0];
  assert.equal(item.link, "/social.html#friends");
  assert.equal((await notifyEvents.canOpen(await u("alice"), item.scope)).ok, true);
  await friends.unfriend(await u("alice"), "bob");
  assert.equal((await notifyEvents.canOpen(await u("alice"), item.scope)).ok, false);
});

/* ======================= the one-time migration ======================= */

/* The rule before #140, kept here to compare against: an entry by name
   (any level; an unknown one is Off) beats defaultShare; no entry means
   defaultShare. personal: the entry only, Off without one. */
function legacyLevel(s, viewer, personal) {
  const e = (Array.isArray(s.friends) ? s.friends : []).find(x => x && x.username === viewer);
  if (personal) return e && sharing.LEVELS.includes(e.share) ? e.share : "off";
  const level = e ? e.share : s.defaultShare;
  return sharing.LEVELS.includes(level) ? level : "off";
}

test("migration: every sharing entry becomes a friendship and NOBODY loses (or gains) access", async () => {
  const names = ["alice", "bob", "carol", "dave", "erin", "frank"];
  const { ids, u } = await seed(names);
  const setups = {
    alice: { friends: [{ username: "bob", share: "full", addedAt: "2026-09-01T00:00:00.000Z" }, { username: "carol", share: "summary" },
      { username: "ghost", share: "full" }], defaultShare: "off" },
    bob: { friends: [{ username: "alice", share: "summary" }, { username: "dave", share: "off" }], defaultShare: "full" },
    carol: { friends: [], defaultShare: "summary" },
    dave: { friends: [{ username: "erin", share: "full" }, { username: "dave", share: "full" }, { username: "frank", share: "junk" }] },
    erin: { defaultShare: "full" },
    frank: { friends: [{ username: "alice", share: "full" }] }
  };
  for (const n of names) await store.updatePrefs(ids[n], p => Object.assign(p, setups[n]));
  await auth.setDisabled(ids.frank, true);

  const before = {};
  for (const o of names) for (const v of names) if (o !== v) {
    before[o + ">" + v] = [legacyLevel(setups[o], v, false), legacyLevel(setups[o], v, true)];
  }

  const r = await friends.migrateSharesOnce();
  assert.deepEqual(r, { accounts: 6, entries: 9, created: 6, unknown: 2, skipped: 0 });
  const doc = await friends.read();
  const pairs = doc.friendships.map(f => [f.a, f.b].map(id => names.find(n => ids[n] === id)).sort().join("+")).sort();
  assert.deepEqual(pairs, ["alice+bob", "alice+carol", "alice+frank", "bob+dave", "dave+erin", "dave+frank"]);
  assert.equal(doc.friendships.find(f => [f.a, f.b].sort().join() === [ids.alice, ids.bob].sort().join()).since, "2026-09-01T00:00:00.000Z");

  for (const o of names) for (const v of names) if (o !== v) {
    const prefs = await store.readPrefs(ids[o]);
    const got = [friends.levelBetween(doc, await u(o), prefs, await u(v)),
      friends.levelBetween(doc, await u(o), prefs, await u(v), { personal: true })];
    assert.deepEqual(got, before[o + ">" + v], o + " -> " + v);
  }
  // Sharing levels themselves are untouched.
  for (const n of names) assert.deepEqual((await store.readPrefs(ids[n])).friends || [], setups[n].friends || [], n);

  // Once: the marker is written, a second boot does nothing, and running
  // the conversion again by hand adds no duplicates.
  assert.ok((await store.readMigrations())[friends.MIGRATION]);
  assert.equal(await friends.migrateSharesOnce(), null);
  assert.equal((await friends.migrateShares()).created, 0);
  assert.equal((await friends.read()).friendships.length, 6);
});

test("migration: an account whose settings can't be read is skipped, the marker isn't written, and the next boot finishes", async () => {
  const { ids } = await seed(["alice", "bob"]);
  await store.updatePrefs(ids.alice, p => { p.friends = [{ username: "bob", share: "full" }]; });
  const real = store.readPrefs;
  store.readPrefs = async id => { if (id === ids.alice) throw new Error("EBUSY"); return real(id); };
  let r;
  try { r = await friends.migrateSharesOnce(); }
  finally { store.readPrefs = real; }
  assert.equal(r.skipped, 1);
  assert.equal((await store.readMigrations())[friends.MIGRATION], undefined);
  r = await friends.migrateSharesOnce();
  assert.equal(r.created, 1);
  assert.ok((await store.readMigrations())[friends.MIGRATION]);
});
