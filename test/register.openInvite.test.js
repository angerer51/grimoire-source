"use strict";
/* #135: open registration honours an invite code that is sent, through the
   same consume / throttle / #126 org re-check as invite mode (one code path
   in POST /api/auth/register); only a blank code skips it there. These pin
   the two auth.js helpers that path uses, against a scratch dataDir via
   store.init(), never the live one. The route itself (org join, refusals,
   the reg: throttle, blank code) was run over HTTP on a scratch server in
   both modes; see the PR. */
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

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-open-invite-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  return auth.createUser({ username: "boss", password: "correct-horse-1" });
}

test("invite mode always redeems; open mode only when a code is sent", () => {
  for (const code of ["", "  ", null, undefined]) {
    assert.equal(auth.signupRedeemsInvite("invite", code), true, "invite mode, blank " + JSON.stringify(code));
    assert.equal(auth.signupRedeemsInvite("open", code), false, "open mode, blank " + JSON.stringify(code));
  }
  assert.equal(auth.signupRedeemsInvite("invite", "abc"), true);
  assert.equal(auth.signupRedeemsInvite("open", "abc"), true);
});

test("open mode refuses a bad code with the same reasons, pointing at signing up without it", () => {
  const tail = " Ask for a new one, or clear the code to sign up without it.";
  assert.equal(auth.inviteRefusal("open", "x", "expired"), "That invite has expired." + tail);
  assert.equal(auth.inviteRefusal("open", "x", "revoked"), "That invite has been cancelled." + tail);
  assert.equal(auth.inviteRefusal("open", "x", "used"), "That invite code is not valid or has already been used." + tail);
  assert.equal(auth.inviteRefusal("open", "x", null), "That invite code is not valid or has already been used." + tail);
});

test("invite mode's refusals are unchanged", () => {
  const tail = " Use Request an invite to ask for a new one.";
  assert.equal(auth.inviteRefusal("invite", "", null), "Enter your invite code. No code yet? Request an invite instead.");
  assert.equal(auth.inviteRefusal("invite", "x", "expired"), "That invite has expired." + tail);
  assert.equal(auth.inviteRefusal("invite", "x", "revoked"), "That invite has been cancelled." + tail);
  assert.equal(auth.inviteRefusal("invite", "x", "used"), "That invite code is not valid or has already been used." + tail);
});

test("open mode with a real org code: redeemed, consumed once, and refused as used the second time", async () => {
  const boss = await fresh();
  const inv = await auth.createInvite(boss.id, "", { orgId: "org1", orgRole: "manager", storeIds: [] });
  assert.equal(auth.signupRedeemsInvite("open", inv.code), true);
  const got = await auth.consumeInvite(inv.code);
  assert.ok(got && got.orgMeta, "the org invite comes back with its org");
  assert.equal(got.orgMeta.orgId, "org1");
  const u = await auth.createUser({ username: "joiner", password: "correct-horse-1" });
  await auth.markInviteUsed(inv.code, u.id);
  assert.equal(await auth.consumeInvite(inv.code), null);
  const why = await auth.inviteStateByCode(inv.code);
  assert.match(auth.inviteRefusal("open", inv.code, why), /already been used\. Ask for a new one/);
});

test("open mode with an expired org code: refused as expired", async () => {
  const boss = await fresh();
  const inv = await auth.createInvite(boss.id, "", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  await store.withLock("users", async () => {
    const db = await store.readUsers();
    db.invites.find(i => i.code === inv.code).expiresAt = new Date(Date.now() - 1000).toISOString();
    await store.writeJson(store.p("users.json"), db);
  });
  assert.equal(await auth.consumeInvite(inv.code), null);
  assert.equal(auth.inviteRefusal("open", inv.code, await auth.inviteStateByCode(inv.code)),
    "That invite has expired. Ask for a new one, or clear the code to sign up without it.");
});
