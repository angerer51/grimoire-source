"use strict";
/* #154, #167: who may change another account's email or send it a reset
   link from Admin -> Accounts. Administrators only (#167, owner's
   decision), never a moderator; nobody for their own account (Settings asks
   for the password, the admin routes don't). Both routes call
   auth.accountActionProblem(), and the users list's canManage flag comes
   from it too. The routes themselves were exercised over HTTP on a scratch
   server (see the PRs). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const auth = require(path.join(__dirname, "..", "server", "lib", "auth"));

const admin = { id: "a1", username: "boss", role: "admin" };
const admin2 = { id: "a2", username: "boss2", role: "admin" };
const mod = { id: "m1", username: "mod", role: "moderator" };
const mod2 = { id: "m2", username: "mod2", role: "moderator" };
const user = { id: "u1", username: "pat", role: "user" };

test("a moderator can't act on the administrator", () => {
  assert.match(auth.accountActionProblem(mod, admin), /Only an administrator/);
});

test("a moderator can't act on another moderator", () => {
  assert.match(auth.accountActionProblem(mod, mod2), /Only an administrator/);
});

test("a moderator can't use the admin routes on their own account", () => {
  assert.match(auth.accountActionProblem(mod, mod), /Settings → Account/);
});

test("a moderator can't act on a plain user either: changing someone's email or sending a reset is admin-only (#167)", () => {
  // Setting an address and sending it a reset link takes over any account
  // without 2FA, store owners included (store roles are a separate axis).
  assert.match(auth.accountActionProblem(mod, user), /Only an administrator/);
  assert.match(auth.accountActionProblem(mod, { id: "o1", username: "shop", role: "user", orgRole: "owner" }), /Only an administrator/);
});

test("an admin can act on anyone else, other admins included, but not on themselves", () => {
  for (const t of [user, mod, admin2]) assert.equal(auth.accountActionProblem(admin, t), null, t.username);
  assert.match(auth.accountActionProblem(admin, admin), /Settings → Account/);
});

test("a plain user (never let through by the route gate anyway) can act on nobody", () => {
  assert.ok(auth.accountActionProblem(user, { id: "u2", username: "x", role: "user" }));
});

test("maskEmail never shows the local part beyond its first letter", () => {
  assert.equal(auth.maskEmail("name@example.com"), "n***@example.com");
  assert.equal(auth.maskEmail("a@b.co"), "a***@b.co");
  assert.equal(auth.maskEmail("weird"), "***");
  assert.equal(auth.maskEmail(""), "");
  assert.ok(!auth.maskEmail("secret.person@example.com").includes("secret"));
});

test("the reset-email answer shows a moderator only the masked address; an admin the whole one", () => {
  assert.equal(auth.emailShownTo(mod, "pat@example.com"), "p***@example.com");
  assert.equal(auth.emailShownTo(admin, "pat@example.com"), "pat@example.com");
});
