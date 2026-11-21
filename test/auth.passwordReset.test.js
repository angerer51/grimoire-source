"use strict";
/* #155: "Forgot password?" fixes. A too-short new password no longer
   burns the link; every account sharing an address can be reset; a
   disabled account can't finish a reset. Against a scratch dataDir via
   store.init(), never the live one. The routes (POST /api/auth/forgot,
   /api/auth/reset, /api/admin/users/:id/reset-email) were exercised over
   HTTP on a scratch server (see the PR). */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "server", "lib", "store"));
const auth = require(path.join(__dirname, "..", "server", "lib", "auth"));

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-reset-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
}
const GOOD = "correct-horse-1";

test("a too-short new password is refused without spending the link; a good one then works", async () => {
  fresh();
  await auth.createUser({ username: "boss", password: GOOD });
  const u = await auth.createUser({ username: "pat", password: GOOD });
  const token = await auth.createPasswordResetToken(u.id);
  await assert.rejects(() => auth.consumePasswordResetToken(token, "short1"), /at least 10 characters/);
  await assert.rejects(() => auth.consumePasswordResetToken(token, "nodigitsatall"), /letter and one number/);
  const done = await auth.consumePasswordResetToken(token, "a-better-pass-2");
  assert.equal(done.id, u.id);
  assert.ok(auth.verifyPassword("a-better-pass-2", done.pwd));
  // Still single-use once it has actually been used.
  await assert.rejects(() => auth.consumePasswordResetToken(token, "a-third-pass-3"), /invalid or has expired/);
});

test("two accounts sharing an address are both found, so each gets its own link", async () => {
  fresh();
  await auth.createUser({ username: "boss", password: GOOD, email: "other@example.com" });
  const a = await auth.createUser({ username: "personal", password: GOOD, email: "Shared@Example.com" });
  const b = await auth.createUser({ username: "staffer", password: GOOD, email: "shared@example.com " });
  const found = await auth.findUsersByEmail(" shared@example.com");
  assert.deepEqual(found.map(u => u.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(await auth.findUsersByEmail(""), []);
  // Each link resets only its own account.
  const tb = await auth.createPasswordResetToken(b.id);
  await auth.consumePasswordResetToken(tb, "staff-new-pass-1");
  assert.ok(auth.verifyPassword(GOOD, (await auth.findUserById(a.id)).pwd));
  assert.ok(auth.verifyPassword("staff-new-pass-1", (await auth.findUserById(b.id)).pwd));
});

test("a disabled account's link changes nothing and is spent", async () => {
  fresh();
  await auth.createUser({ username: "boss", password: GOOD });
  const u = await auth.createUser({ username: "pat", password: GOOD });
  const { sid } = await auth.createSession(u.id, { sessionDays: 30 }, null);
  const token = await auth.createPasswordResetToken(u.id);
  await auth.setDisabled(u.id, true);
  await assert.rejects(() => auth.consumePasswordResetToken(token, "a-new-pass-123"), /invalid or has expired/);
  assert.ok(auth.verifyPassword(GOOD, (await auth.findUserById(u.id)).pwd), "password unchanged");
  // Re-enabled, the old link is still gone.
  await auth.setDisabled(u.id, false);
  await assert.rejects(() => auth.consumePasswordResetToken(token, "a-new-pass-123"), /invalid or has expired/);
  const sessions = await store.readSessions();
  assert.ok(sessions[sid], "no session was created or destroyed by the refused reset");
});
