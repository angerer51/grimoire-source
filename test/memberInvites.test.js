"use strict";
/* Member invites (#337): the rules, in auth.js and friends.js, against a
   scratch dataDir via store.init(), never the live one. The routes are pinned
   over real HTTP in memberInvites.routes.test.js. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const friends = lib("friends");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const DAY = 24 * 3600 * 1000;
const PW = "correct-horse-1";

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-member-invite-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  await auth.createUser({ username: "boss", password: PW }); // the first account is the admin
  const ann = await auth.createUser({ username: "ann", password: PW });
  const bob = await auth.createUser({ username: "bob", password: PW });
  return { ann, bob };
}

async function backdate(code, days) {
  await store.withLock("users", async () => {
    const db = await store.readUsers();
    const inv = db.invites.find(i => i.code === code);
    const at = Date.now() - days * DAY;
    inv.createdAt = new Date(at).toISOString();
    inv.expiresAt = new Date(at + 30 * DAY).toISOString();
    await store.writeJson(store.p("users.json"), db);
  });
}

// The way the register route spends a code.
async function spend(code, newUser) {
  const inv = await auth.consumeInvite(code);
  assert.ok(inv, "the code should be accepted");
  await auth.markInviteUsed(inv.code, newUser.id);
  return inv;
}

test("each member gets 3; the fourth is refused", async () => {
  const { ann } = await fresh();
  for (let i = 0; i < 3; i++) await auth.createMemberInvite(ann.id);
  await assert.rejects(auth.createMemberInvite(ann.id), e => e.status === 409 && /no invites left/.test(e.message));
  const d = await auth.memberInvitesFor(ann.id);
  assert.deepEqual([d.allowance, d.open, d.used, d.remaining], [3, 3, 0, 0]);
});

test("clicks landing together can't pass the allowance", async () => {
  const { ann } = await fresh();
  const out = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => auth.createMemberInvite(ann.id)));
  assert.equal(out.filter(r => r.status === "fulfilled").length, 3);
});

test("a used link stays spent and can't be used again", async () => {
  const { ann, bob } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  await spend(inv.code, bob);
  assert.equal(await auth.consumeInvite(inv.code), null);
  assert.equal(await auth.inviteStateByCode(inv.code), "used");
  const d = await auth.memberInvitesFor(ann.id);
  assert.deepEqual([d.used, d.open, d.remaining], [1, 0, 2]);
  assert.equal(d.invites[0].status, "joined");
  assert.equal(d.invites[0].username, "bob");
});

test("a used link still counts after it is 90 days old", async () => {
  const { ann, bob } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  await spend(inv.code, bob);
  await backdate(inv.code, 90);
  await auth.pruneInvites();
  assert.equal((await auth.memberInvitesFor(ann.id)).used, 1);
});

test("an unused link that expires gives the invite back and stops working", async () => {
  const { ann } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  await auth.createMemberInvite(ann.id);
  await auth.createMemberInvite(ann.id);
  await backdate(inv.code, 31);
  assert.equal(await auth.consumeInvite(inv.code), null);
  assert.equal(await auth.inviteStateByCode(inv.code), "expired");
  const d = await auth.memberInvitesFor(ann.id);
  assert.deepEqual([d.open, d.remaining], [2, 1]);
  assert.equal(d.invites.length, 2, "the expired link leaves the member's list");
  await auth.createMemberInvite(ann.id);
});

test("a revoked link can't be used and gives the invite back", async () => {
  const { ann } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  await auth.revokeInvite(inv.code, "admin");
  assert.equal(await auth.consumeInvite(inv.code), null);
  assert.equal(await auth.inviteStateByCode(inv.code), "revoked");
  const d = await auth.memberInvitesFor(ann.id);
  assert.deepEqual([d.open, d.remaining, d.invites.length], [0, 3, 0]);
});

test("a sign-up that crashed half-way holds its invite only until the link expires", async () => {
  const { ann } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  assert.ok(await auth.consumeInvite(inv.code));
  assert.equal((await auth.memberInvitesFor(ann.id)).remaining, 2);
  await backdate(inv.code, 31);
  assert.equal((await auth.memberInvitesFor(ann.id)).remaining, 3);
});

test("a form refused after the code was accepted doesn't spend the invite", async () => {
  const { ann } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  assert.ok(await auth.consumeInvite(inv.code));
  await auth.releaseInvite(inv.code);
  assert.ok(await auth.consumeInvite(inv.code), "still usable");
});

test("cancelling: own unused links only; the code dies and the invite comes back", async () => {
  const { ann, bob } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  assert.equal(await auth.cancelMemberInvite(inv.code, bob.id), false, "not someone else's");
  assert.ok(await auth.consumeInvite(inv.code).then(i => auth.releaseInvite(i.code).then(() => true)), "still there");
  assert.equal(await auth.cancelMemberInvite(inv.code, ann.id), true);
  assert.equal(await auth.consumeInvite(inv.code), null);
  assert.equal((await auth.memberInvitesFor(ann.id)).remaining, 3);
  const used = await auth.createMemberInvite(ann.id);
  await spend(used.code, bob);
  assert.equal(await auth.cancelMemberInvite(used.code, ann.id), false, "a used one can't be taken back");
});

test("cancel and remake leaves users.json no bigger", async () => {
  const { ann } = await fresh();
  for (let i = 0; i < 10; i++) {
    const inv = await auth.createMemberInvite(ann.id);
    await auth.cancelMemberInvite(inv.code, ann.id);
  }
  assert.equal((await store.readUsers()).invites.length, 0);
});

test("a member sees only their own links", async () => {
  const { ann, bob } = await fresh();
  const mine = await auth.createMemberInvite(ann.id);
  await auth.createInvite(ann.id, "an admin-style code");
  assert.deepEqual((await auth.memberInvitesFor(ann.id)).invites.map(i => i.code), [mine.code]);
  assert.deepEqual((await auth.memberInvitesFor(bob.id)).invites, []);
});

test("turned off: no new links, and links already out stop until it's back on", async () => {
  const { ann } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  await auth.setMemberInviteSettings({ enabled: false });
  await assert.rejects(auth.createMemberInvite(ann.id), e => e.status === 403);
  assert.deepEqual(await auth.checkMemberInviteAtUse(inv), { state: "off" });
  assert.match(auth.inviteRefusal("invite", inv.code, "off"), /turned off/);
  assert.equal((await auth.memberInvitesFor(ann.id)).enabled, false);
  await auth.setMemberInviteSettings({ enabled: true });
  assert.equal((await auth.checkMemberInviteAtUse(inv)).inviter.id, ann.id);
});

test("turning it off leaves admin-made codes alone", async () => {
  await fresh();
  await auth.setMemberInviteSettings({ enabled: false });
  assert.ok(await auth.consumeInvite((await auth.createInvite("x", "admin code")).code));
});

test("a disabled inviter's links stop working and they can't make more", async () => {
  const { ann } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  await auth.setDisabled(ann.id, true);
  assert.deepEqual(await auth.checkMemberInviteAtUse(inv), { state: "revoked" });
  await assert.rejects(auth.createMemberInvite(ann.id), e => e.status === 403);
});

test("the admin can change the usual number and one person's", async () => {
  const { ann, bob } = await fresh();
  await auth.setMemberInviteSettings({ allowance: 5 });
  await auth.setMemberInviteAllowance("ANN", 8);
  assert.equal((await auth.memberInvitesFor(ann.id)).allowance, 8);
  assert.equal((await auth.memberInvitesFor(bob.id)).allowance, 5);
  await auth.setMemberInviteAllowance("ann", null);
  assert.equal((await auth.memberInvitesFor(ann.id)).allowance, 5);
  for (const bad of [-1, 1.5, "7", 101]) {
    await assert.rejects(auth.setMemberInviteAllowance("ann", bad), e => e.status === 400);
    await assert.rejects(auth.setMemberInviteSettings({ allowance: bad }), e => e.status === 400);
  }
  await assert.rejects(auth.setMemberInviteAllowance("nobody", 4), e => e.status === 404);
});

test("lowering an allowance stops new links and leaves open ones working", async () => {
  const { ann } = await fresh();
  const a = await auth.createMemberInvite(ann.id);
  await auth.createMemberInvite(ann.id);
  await auth.setMemberInviteAllowance("ann", 1);
  await assert.rejects(auth.createMemberInvite(ann.id), e => e.status === 409);
  assert.equal((await auth.memberInvitesFor(ann.id)).remaining, 0);
  assert.equal((await auth.checkMemberInviteAtUse(a)).inviter.id, ann.id);
});

test("settings and allowances stay out of what other people get to see", async () => {
  const { ann } = await fresh();
  await auth.setMemberInviteAllowance("ann", 9);
  const u = await auth.findUser("ann");
  assert.equal(u.inviteAllowance, 9);
  assert.equal("inviteAllowance" in auth.publicUser(u), false);
  assert.equal((await auth.listUsers()).some(x => "inviteAllowance" in x), false);
  assert.equal(ann.username, "ann");
});

test("the admin's overview says who invited whom", async () => {
  const { ann, bob } = await fresh();
  const inv = await auth.createMemberInvite(ann.id);
  await spend(inv.code, bob);
  await auth.createMemberInvite(ann.id);
  const o = await auth.memberInviteOverview();
  assert.deepEqual([o.enabled, o.allowance], [true, 3]);
  assert.deepEqual(o.people.map(p => p.username), ["ann"], "only people with links or their own number");
  const p = o.people[0];
  assert.deepEqual(p.invited.map(x => x.username), ["bob"]);
  assert.deepEqual([p.used, p.open, p.remaining, p.custom], [1, 1, 1, null]);
  const listed = await auth.listInvites();
  assert.ok(listed.every(i => i.memberInvite === true));
});

test("signing up with a link makes them friends, with no request left waiting", async () => {
  const { ann, bob } = await fresh();
  assert.equal(await friends.befriendInvited(bob, ann), true);
  const doc = await friends.read();
  assert.equal(friends.areFriends(doc, ann.id, bob.id), true);
  assert.deepEqual(doc.requests, []);
  assert.equal(await friends.befriendInvited(bob, ann), false, "already friends");
});

test("a new friendship from a link shares nothing and clears old entries", async () => {
  const { ann, bob } = await fresh();
  await store.updatePrefs(ann.id, p => { p.friends = [{ username: "bob", share: "off" }]; });
  await friends.befriendInvited(bob, ann);
  assert.deepEqual((await store.readPrefs(ann.id)).friends, []);
  const doc = await friends.read();
  assert.equal(friends.levelBetween(doc, ann, await store.readPrefs(ann.id), bob), "off");
});
