"use strict";
/* Every sign-up code lasts at most 30 days from when it was made (owner's
   decision, 2026-10-10, on PR #143), worked out at read/redeem time so it
   also applies to codes made before the rule. A shorter stored expiry (an
   org invite's 7 days, #126) still wins. Against a scratch dataDir via
   store.init(), never the live one. Registration itself was exercised over
   HTTP on a scratch server (see the PR). */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const DAY = 24 * 3600 * 1000;

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-invite-expiry-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  return auth.createUser({ username: "boss", password: "correct-horse-1" });
}

// Rewrites a stored invite as if made `days` ago, the way an old record
// looks: by default no expiresAt at all (every plain invite before this).
async function backdate(code, days, expiresAt) {
  await store.withLock("users", async () => {
    const db = await store.readUsers();
    const inv = db.invites.find(i => i.code === code);
    inv.createdAt = new Date(Date.now() - days * DAY).toISOString();
    inv.expiresAt = expiresAt === undefined ? null : expiresAt;
    await store.writeJson(store.p("users.json"), db);
  });
}

test("a plain code made 31 days ago is refused at sign-up, even with no stored expiry", async () => {
  const boss = await fresh();
  const inv = await auth.createInvite(boss.id, "old");
  await backdate(inv.code, 31);
  assert.equal(await auth.consumeInvite(inv.code), null);
  assert.equal(await auth.inviteStateByCode(inv.code), "expired");
});

test("a plain code made 29 days ago still works", async () => {
  const boss = await fresh();
  const inv = await auth.createInvite(boss.id, "recent");
  await backdate(inv.code, 29);
  assert.equal(await auth.inviteStateByCode(inv.code), null);
  assert.ok(await auth.consumeInvite(inv.code));
});

test("a stored expiry later than 30 days doesn't stretch the limit", async () => {
  const boss = await fresh();
  const inv = await auth.createInvite(boss.id, "");
  await backdate(inv.code, 31, new Date(Date.now() + 365 * DAY).toISOString());
  assert.equal(await auth.inviteStateByCode(inv.code), "expired");
});

test("new codes carry their 30-day end date; org invites keep 7 days", async () => {
  const boss = await fresh();
  const plain = await auth.createInvite(boss.id, "");
  const org = await auth.createInvite(boss.id, "", { orgId: "org1", orgRole: "staff", storeIds: [] });
  const span = i => Math.round((Date.parse(i.expiresAt) - Date.parse(i.createdAt)) / DAY);
  assert.equal(span(plain), 30);
  assert.equal(span(org), 7);
  // An org invite 8 days old is expired, one 6 days old is not.
  await backdate(org.code, 8, new Date(Date.now() - DAY).toISOString());
  assert.equal(await auth.inviteStateByCode(org.code), "expired");
  const org2 = await auth.createInvite(boss.id, "", { orgId: "org1", orgRole: "staff", storeIds: [] });
  await backdate(org2.code, 6, new Date(Date.now() + DAY).toISOString());
  assert.equal(await auth.inviteStateByCode(org2.code), null);
});

test("Admin's invite list shows an old unused code as expired, with its real end date", async () => {
  const boss = await fresh();
  const old = await auth.createInvite(boss.id, "old");
  const live = await auth.createInvite(boss.id, "live");
  await backdate(old.code, 45);
  const list = await auth.listInvites();
  const row = c => list.find(i => i.code === c);
  assert.equal(row(old.code).expired, true);
  assert.equal(Math.round((Date.now() - Date.parse(row(old.code).expiresAt)) / DAY), 15);
  assert.equal(row(live.code).expired, false);
});

test("a used code isn't listed as expired once it ages", async () => {
  const boss = await fresh();
  const inv = await auth.createInvite(boss.id, "");
  await auth.markInviteUsed(inv.code, boss.id);
  await backdate(inv.code, 60);
  const row = (await auth.listInvites()).find(i => i.code === inv.code);
  assert.equal(row.used, true);
  assert.equal(row.expired, false);
});

test("a record with no readable creation date counts as expired", async () => {
  const boss = await fresh();
  const inv = await auth.createInvite(boss.id, "");
  await store.withLock("users", async () => {
    const db = await store.readUsers();
    const i = db.invites.find(x => x.code === inv.code);
    delete i.createdAt; i.expiresAt = null;
    await store.writeJson(store.p("users.json"), db);
  });
  assert.equal(await auth.inviteStateByCode(inv.code), "expired");
});
