"use strict";
/* #160: finished invites are pruned from users.json, by the owner's rule
   (2026-10-10): expired or revoked ones are deleted 30 days after they
   stopped working; used ones stay, but a used pick-ticket invite's code and
   note are cleared 90 days after it was used. Runs at boot (pruneInvites)
   and whenever an invite is made (createInvite). Also the list fields the
   Invites tab's open/all filter, "Made by" and Revoke use. Against a
   scratch dataDir via store.init(), never the live one. */
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
const ago = d => new Date(Date.now() - d * DAY).toISOString();

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-invite-prune-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  return auth.createUser({ username: "boss", password: "correct-horse-1" });
}

// Writes invite records straight into users.json, as old ones look on disk.
async function seed(records) {
  await store.withLock("users", async () => {
    const db = await store.readUsers();
    for (const r of records) {
      db.invites.push(Object.assign({ createdBy: "x", revokedAt: null, note: "n", sourceRef: null, usedBy: null, usedAt: null, orgMeta: null }, r));
    }
    await store.writeJson(store.p("users.json"), db);
  });
}
const codes = async () => (await store.readUsers()).invites.map(i => i.code);

test("expired and revoked invites go 30 days after they stopped working, not before", async () => {
  await fresh();
  await seed([
    { code: "exp-61", createdAt: ago(61) },               // expired 31 days ago -> gone
    { code: "exp-59", createdAt: ago(59) },               // expired 29 days ago -> kept
    { code: "rev-31", createdAt: ago(40), revokedAt: ago(31) }, // revoked 31 days ago -> gone
    { code: "rev-10", createdAt: ago(12), revokedAt: ago(10) }, // revoked 10 days ago -> kept
    { code: "open", createdAt: ago(5) },                  // still works -> kept
    { code: "org-38", createdAt: ago(38), expiresAt: ago(31), orgMeta: { orgId: "o", orgRole: "staff", storeIds: [] } }
  ]);
  const r = await auth.pruneInvites();
  assert.deepEqual(r, { dropped: 3, trimmed: 0 });
  assert.deepEqual((await codes()).sort(), ["exp-59", "open", "rev-10"]);
});

test("used invites stay; a used pick-ticket one loses its code and note after 90 days", async () => {
  await fresh();
  await seed([
    { code: "manual-used", createdAt: ago(400), usedBy: "u1", usedAt: ago(399) },
    { code: "pick-used-old", createdAt: ago(120), usedBy: "u2", usedAt: ago(91), sourceRef: "pick:me:PL-1", note: "Printed with PL-1" },
    { code: "pick-used-new", createdAt: ago(100), usedBy: "u3", usedAt: ago(80), sourceRef: "pick:me:PL-2", note: "Printed with PL-2" }
  ]);
  const r = await auth.pruneInvites();
  assert.deepEqual(r, { dropped: 0, trimmed: 1 });
  const inv = (await store.readUsers()).invites;
  assert.equal(inv.length, 3);
  const trimmed = inv.find(i => i.usedBy === "u2");
  assert.equal(trimmed.code, null);
  assert.equal(trimmed.note, "");
  assert.equal(trimmed.sourceRef, "pick:me:PL-1", "still shows as a pick ticket's invite");
  assert.equal(inv.find(i => i.usedBy === "u1").code, "manual-used");
  assert.equal(inv.find(i => i.usedBy === "u3").code, "pick-used-new");
  // A second pass changes nothing and doesn't write.
  const before = fs.statSync(store.p("users.json")).mtimeMs;
  assert.deepEqual(await auth.pruneInvites(), { dropped: 0, trimmed: 0 });
  assert.equal(fs.statSync(store.p("users.json")).mtimeMs, before);
  // A trimmed record can't be matched by an empty or missing code.
  assert.equal(await auth.consumeInvite(""), null);
  assert.equal(await auth.consumeInvite(null), null);
});

test("making an invite prunes in the same write", async () => {
  const boss = await fresh();
  await seed([{ code: "exp-90", createdAt: ago(90) }]);
  const inv = await auth.createInvite(boss.id, "new one");
  assert.deepEqual(await codes(), [inv.code]);
});

test("the list says which invites are open and which came from a pick ticket", async () => {
  const boss = await fresh();
  const manual = await auth.createInvite(boss.id, "for Sam");
  const pick = await auth.createInvite(boss.id, "Printed with PL-3", null, "pick:me:PL-3");
  await seed([{ code: "exp-40", createdAt: ago(40) }]);
  await auth.revokeInvite(manual.code, boss.id);
  const list = await auth.listInvites();
  const by = c => list.find(i => i.code === c);
  assert.equal(by(manual.code).open, false);
  assert.equal(by(manual.code).revoked, true);
  assert.equal(by(manual.code).fromPickTicket, false);
  assert.equal(by(pick.code).open, true);
  assert.equal(by(pick.code).fromPickTicket, true);
  assert.equal(by("exp-40").open, false);
});
