"use strict";
/* Pick-ticket join codes (#138): POST /api/invite/pick-list gives a code
   only for a real pick list in an inventory the caller can work right now,
   and no invite is created otherwise. Against a scratch dataDir via
   store.init(), never the live one. The docOwner each call gets is worked
   out by orgs.resolveDocOwner(), exactly as the route's dispatcher does.
   The route wiring was exercised over HTTP on a scratch server; see the
   PR. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const orgs = lib("orgs");
const pickInvite = lib("pickInvite");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const PW = "correct-horse-1";

const pickDoc = (...ids) => ({ cards: [], pickLists: ids.map(id => ({ id, status: "open", lines: [] })) });

/* org1 (stores s1, s2): owner, manager, staff on s1, staff on s2. Two
   personal accounts whose first pick lists share a number, as every
   account's do (PICK-<year>-0001). */
async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-pickinvite-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  await store.writeOrgs({ orgs: [{ id: "org1", name: "Org" }] });
  await store.writeStoreList({ stores: [
    { id: "s1", orgId: "org1", name: "One", archived: false },
    { id: "s2", orgId: "org1", name: "Two", archived: false }
  ] });
  const mk = async (username, orgMeta) => {
    const u = await auth.createUser({ username, password: PW });
    if (orgMeta) await auth.setOrgMembership(u.id, orgMeta);
    return auth.findUserById(u.id);
  };
  const u = {
    alice: await mk("alice"), bob: await mk("bob"),
    owner: await mk("owner", { orgId: "org1", orgRole: "owner" }),
    mgr: await mk("mgr", { orgId: "org1", orgRole: "manager" }),
    staff1: await mk("staff1", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }),
    staff2: await mk("staff2", { orgId: "org1", orgRole: "staff", storeIds: ["s2"] })
  };
  await store.writeCollection(u.alice.id, pickDoc("PICK-2026-0001", "PICK-2026-0002"));
  await store.writeCollection(u.bob.id, pickDoc("PICK-2026-0001"));
  await store.writeCollection("store:s1", pickDoc("PICK-2026-0007"));
  return u;
}

// What the route does: docOwner from the session's active store.
async function ask(user, id, activeStoreId) {
  const asSession = Object.assign({}, user, { __activeStoreId: activeStoreId || null });
  return pickInvite.pickListInvite(asSession, await orgs.resolveDocOwner(asSession), id, "Printed with a pick list");
}
const inviteCount = async () => (await auth.listInvites()).length;

test("the owner of a personal pick list gets a code, and a reprint gets the same one", async () => {
  const { alice } = await seed();
  const first = await ask(alice, "PICK-2026-0001");
  assert.ok(first.invite && first.invite.code, JSON.stringify(first));
  const again = await ask(alice, "PICK-2026-0001");
  assert.equal(again.invite.code, first.invite.code, "the sourceRef dedup still holds");
  assert.equal(await inviteCount(), 1);
});

test("a store's pick list gets one code, shared by its Owner and Managers", async () => {
  const { owner, mgr } = await seed();
  const a = await ask(owner, "PICK-2026-0007", "s1");
  const b = await ask(mgr, "PICK-2026-0007", "s1");
  assert.ok(a.invite);
  assert.equal(b.invite.code, a.invite.code);
  assert.equal(await inviteCount(), 1);
});

test("Staff assigned to the store can get the code for its pick ticket; Staff of another store can't", async () => {
  const { staff1, staff2 } = await seed();
  const ok = await ask(staff1, "PICK-2026-0007");
  assert.ok(ok.invite, "staff1 packs for s1");
  const no = await ask(staff2, "PICK-2026-0007");
  assert.equal(no.status, 404);
  assert.equal(await inviteCount(), 1, "the refusal created nothing");
});

test("someone else's pick list is refused and creates no invite", async () => {
  const { bob, owner } = await seed();
  const r = await ask(bob, "PICK-2026-0002");          // alice's
  assert.equal(r.status, 404);
  assert.ok(!r.invite);
  const r2 = await ask(owner, "PICK-2026-0002", "s1"); // a store manager, still not alice's
  assert.equal(r2.status, 404);
  assert.equal(await inviteCount(), 0);
});

test("a made-up pick list id is refused and creates no invite", async () => {
  const { alice } = await seed();
  for (const id of ["PICK-2099-9999", "anything", "x".repeat(500)]) {
    const r = await ask(alice, id);
    assert.equal(r.status, 404, id.slice(0, 20));
  }
  assert.equal((await ask(alice, "")).status, 400);
  assert.equal((await ask(alice, { toString: 1 })).status, 400);
  assert.equal(await inviteCount(), 0);
});

test("two accounts with the same pick list number get different codes", async () => {
  const { alice, bob } = await seed();
  const a = await ask(alice, "PICK-2026-0001");
  const b = await ask(bob, "PICK-2026-0001");
  assert.ok(a.invite && b.invite);
  assert.notEqual(a.invite.code, b.invite.code, "bob must not be handed alice's code");
  assert.equal(b.invite.createdBy, bob.id);
});

test("a code minted under the old key is reused by the account that made it, and no one else", async () => {
  const { alice, bob } = await seed();
  const old = await auth.createInvite(alice.id, "old", null, "pick:PICK-2026-0001");
  assert.equal((await ask(alice, "PICK-2026-0001")).invite.code, old.code, "the code already printed stays");
  assert.notEqual((await ask(bob, "PICK-2026-0001")).invite.code, old.code);
});

test("a pick list saved after a refusal is found on the next ask", async () => {
  const { alice } = await seed();
  assert.equal((await ask(alice, "PICK-2026-0003")).status, 404);
  await store.writeCollection(alice.id, pickDoc("PICK-2026-0001", "PICK-2026-0002", "PICK-2026-0003"), -1);
  assert.ok((await ask(alice, "PICK-2026-0003")).invite, "the cached id list follows the save");
});

/* ---------- PR #143 review: one read for a burst of asks ---------- */

// Counts store.readCollection calls while fn runs (pickInvite reads through
// the shared store module object).
async function countingReads(fn, fail) {
  const real = store.readCollection;
  let n = 0;
  store.readCollection = async key => { n++; if (fail && fail(n)) throw new Error("disk says no"); return real(key); };
  try { await fn(); } finally { store.readCollection = real; }
  return n;
}

test("ten asks landing together right after a save read the collection once, not ten times", async () => {
  const { alice } = await seed();
  await ask(alice, "PICK-2026-0001");   // warm the cache
  const ids = Array.from({ length: 10 }, (_, i) => "PICK-2026-1" + String(i).padStart(3, "0"));
  await store.writeCollection(alice.id, pickDoc(...ids), -1);   // the bulk generate's save: new stamp
  let results;
  const reads = await countingReads(async () => { results = await Promise.all(ids.map(id => ask(alice, id))); });
  assert.equal(reads, 1, "one shared read for the whole burst");
  assert.ok(results.every(r => r.invite), "every list got its code");
  assert.equal(new Set(results.map(r => r.invite.code)).size, 10);
});

test("a failed read isn't cached: the next ask reads again", async () => {
  const { alice } = await seed();
  await assert.rejects(countingReads(() => ask(alice, "PICK-2026-0001"), n => n === 1));
  const reads = await countingReads(async () => { assert.ok((await ask(alice, "PICK-2026-0001")).invite); });
  assert.equal(reads, 1);
});

/* ---------- PR #143 owner decisions: 30-day codes, orphan cleanup ---------- */

const DAY = 24 * 3600 * 1000;
async function ageInvite(code, days) {
  await store.withLock("users", async () => {
    const db = await store.readUsers();
    const inv = db.invites.find(i => i.code === code);
    inv.createdAt = new Date(Date.now() - days * DAY).toISOString();
    if (inv.expiresAt) inv.expiresAt = new Date(Date.parse(inv.createdAt) + 30 * DAY).toISOString();
    await store.writeJson(store.p("users.json"), db);
  });
}

test("a reprint after the pick-ticket code expired gets a fresh code, and the old one stays dead", async () => {
  const { alice } = await seed();
  const first = (await ask(alice, "PICK-2026-0001")).invite.code;
  await ageInvite(first, 29);
  assert.equal((await ask(alice, "PICK-2026-0001")).invite.code, first, "29 days old: still the same code");
  await ageInvite(first, 31);
  const second = (await ask(alice, "PICK-2026-0001")).invite.code;
  assert.notEqual(second, first);
  assert.equal(await auth.inviteStateByCode(first), "expired");
  assert.equal((await ask(alice, "PICK-2026-0001")).invite.code, second, "and the new one is reused from then on");
});

test("an expired old-key code isn't reused either", async () => {
  const { alice } = await seed();
  const old = await auth.createInvite(alice.id, "old", null, "pick:PICK-2026-0001");
  await ageInvite(old.code, 40);
  assert.notEqual((await ask(alice, "PICK-2026-0001")).invite.code, old.code);
});

test("the orphan cleanup revokes unused codes whose pick list is gone, and nothing else", async () => {
  const { alice, bob, owner, staff1 } = await seed();
  const keep = (await ask(alice, "PICK-2026-0001")).invite.code;
  const gone = (await ask(alice, "PICK-2026-0002")).invite.code;
  const storeKeep = (await ask(staff1, "PICK-2026-0007")).invite.code;
  // Codes minted the old way for made-up ids, and one for a list that exists.
  const fakeOld = await auth.createInvite(bob.id, "", null, "pick:MADE-UP-1");
  const realOld = await auth.createInvite(owner.id, "", null, "pick:PICK-2026-0007");   // in store s1, which owner can work
  const usedFake = await auth.createInvite(bob.id, "", null, "pick:MADE-UP-2");
  await auth.markInviteUsed(usedFake.code, alice.id);
  const plain = await auth.createInvite(owner.id, "admin code");                        // not a pick-ticket code
  // alice deletes PICK-2026-0002.
  await store.writeCollection(alice.id, pickDoc("PICK-2026-0001"), -1);

  const out = await pickInvite.revokeOrphanPickCodesOnce();
  assert.equal(out.revoked, 2);
  const state = async c => auth.inviteStateByCode(c);
  assert.equal(await state(gone), "revoked");
  assert.equal(await state(fakeOld.code), "revoked");
  for (const c of [keep, storeKeep, realOld.code, plain.code]) assert.equal(await state(c), null, c);
  assert.equal(await state(usedFake.code), "used");
  assert.equal(await pickInvite.revokeOrphanPickCodesOnce(), null, "it runs once per data directory");
});

test("the orphan cleanup leaves an inventory's codes alone when it can't be read, and runs again next boot", async () => {
  const { alice } = await seed();
  const code = (await ask(alice, "PICK-2026-0001")).invite.code;
  await store.writeCollection(alice.id, pickDoc(), -1);   // list gone, but the read below fails
  const real = store.readCollection;
  store.readCollection = async () => { throw new Error("disk says no"); };
  let out;
  try { out = await pickInvite.revokeOrphanPickCodesOnce(); } finally { store.readCollection = real; }
  assert.equal(out.skipped, 1);
  assert.equal(out.revoked, 0);
  assert.equal(await auth.inviteStateByCode(code), null);
  assert.deepEqual(await store.readMigrations(), {}, "not marked done");
  const next = await pickInvite.revokeOrphanPickCodesOnce();   // the next boot, disk fine again
  assert.equal(next.revoked, 1);
  assert.equal(await auth.inviteStateByCode(code), "revoked");
  assert.equal(await pickInvite.revokeOrphanPickCodesOnce(), null);
});

test("pick-ticket tags parse to their inventory and id", () => {
  assert.deepEqual(pickInvite.parseSourceRef("pick:store:s1:PICK-2026-0007"), { ownerKey: "store:s1", id: "PICK-2026-0007" });
  assert.deepEqual(pickInvite.parseSourceRef("pick:Ab_c-9:PICK-2026-0001"), { ownerKey: "Ab_c-9", id: "PICK-2026-0001" });
  assert.deepEqual(pickInvite.parseSourceRef("pick:PICK-2026-0001"), { ownerKey: null, id: "PICK-2026-0001" });
  assert.equal(pickInvite.parseSourceRef(null), null);
  assert.equal(pickInvite.parseSourceRef("org:x"), null);
});
