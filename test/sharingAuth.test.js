"use strict";
/* Sharing-auth batch (#123-#127): who may change org membership, what Stop
   sharing leaves behind, trade-proposal sanitising, org invite expiry /
   revoke / re-check at use, and Owner-only store archive with restore.
   Against a scratch dataDir via store.init(), never the live one; the
   route wiring itself was exercised over HTTP on a scratch server (see the
   PR). */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const orgs = lib("orgs");
const trades = lib("trades");
const sharing = lib("sharing");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-sharing-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  return dir;
}
const PW = "correct-horse-1";

/* Owner + manager + staff in org1 with two active stores, plus a foreign org. */
async function seedOrg() {
  freshDataDir();
  await store.writeOrgs({ orgs: [{ id: "org1", name: "Org" }, { id: "org2", name: "Other" }] });
  await store.writeStoreList({ stores: [
    { id: "s1", orgId: "org1", name: "One", archived: false },
    { id: "s2", orgId: "org1", name: "Two", archived: false },
    { id: "sx", orgId: "org2", name: "Foreign", archived: false }
  ] });
  const owner = await auth.createUser({ username: "owner", password: PW });
  const owner2 = await auth.createUser({ username: "owner2", password: PW });
  const mgr = await auth.createUser({ username: "mgr", password: PW });
  const mgr2 = await auth.createUser({ username: "mgr2", password: PW });
  const staff = await auth.createUser({ username: "staff", password: PW });
  await auth.setOrgMembership(owner.id, { orgId: "org1", orgRole: "owner" });
  await auth.setOrgMembership(owner2.id, { orgId: "org1", orgRole: "owner" });
  await auth.setOrgMembership(mgr.id, { orgId: "org1", orgRole: "manager" });
  await auth.setOrgMembership(mgr2.id, { orgId: "org1", orgRole: "manager" });
  await auth.setOrgMembership(staff.id, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  const u = async id => auth.findUserById(id);
  return { owner: await u(owner.id), owner2: await u(owner2.id), mgr: await u(mgr.id), mgr2: await u(mgr2.id), staff: await u(staff.id) };
}

/* ---------- #123 member changes ---------- */

test("#123: a Manager is refused (403 message) demoting, re-storing or removing another Manager or an Owner", async () => {
  const { mgr, mgr2, owner } = await seedOrg();
  for (const target of [mgr2, owner]) {
    assert.ok(orgs.memberChangeProblem(mgr, target, { orgRole: "staff", storeIds: ["s1"] }), "demote " + target.username);
    assert.ok(orgs.memberChangeProblem(mgr, target, { storeIds: ["s2"] }), "store change " + target.username);
    assert.ok(orgs.memberChangeProblem(mgr, target, { remove: true }), "remove " + target.username);
  }
});

test("#123: a Manager can still change and remove Staff, but not promote them", async () => {
  const { mgr, staff } = await seedOrg();
  assert.equal(orgs.memberChangeProblem(mgr, staff, { orgRole: "staff", storeIds: ["s2"] }), null);
  assert.equal(orgs.memberChangeProblem(mgr, staff, { remove: true }), null);
  assert.ok(orgs.memberChangeProblem(mgr, staff, { orgRole: "manager" }));
  assert.ok(orgs.memberChangeProblem(mgr, staff, { orgRole: "owner" }));
});

test("#123: a Manager on their own row may leave or step down, never self-promote (same as before)", async () => {
  const { mgr } = await seedOrg();
  assert.equal(orgs.memberChangeProblem(mgr, mgr, { remove: true }), null);
  assert.equal(orgs.memberChangeProblem(mgr, mgr, { orgRole: "staff", storeIds: ["s1"] }), null);
  assert.ok(orgs.memberChangeProblem(mgr, mgr, { orgRole: "owner" }));
  assert.ok(orgs.memberChangeProblem(mgr, mgr, { orgRole: "manager" }));
});

test("#123: an Owner can still do everything, staff can do nothing", async () => {
  const { owner, owner2, mgr, staff } = await seedOrg();
  for (const t of [owner2, mgr, staff]) {
    assert.equal(orgs.memberChangeProblem(owner, t, { orgRole: "staff" }), null);
    assert.equal(orgs.memberChangeProblem(owner, t, { remove: true }), null);
    assert.equal(orgs.memberChangeProblem(owner, t, { orgRole: "owner" }), null);
  }
  assert.ok(orgs.memberChangeProblem(staff, staff, { remove: true }));
});

test("#126: filterStoreIds keeps only this org's active stores, de-duplicated", async () => {
  await seedOrg();
  const doc = await store.readStoreList();
  doc.stores.find(s => s.id === "s2").archived = true;
  await store.writeStoreList(doc);
  assert.deepEqual(await orgs.filterStoreIds("org1", ["s1", "s1", "s2", "sx", "junk", 7, { a: 1 }]), ["s1"]);
  assert.deepEqual(await orgs.filterStoreIds("org1", "s1"), []);
});

/* ---------- #127 archive / restore ---------- */

test("#127: archiving the org's last active store is refused (400); restore brings it back", async () => {
  const { owner } = await seedOrg();
  const a = await orgs.archiveStore("s1", owner.id);
  assert.equal(a.archived, true);
  assert.equal(a.archivedBy, owner.id);
  await assert.rejects(orgs.archiveStore("s2", owner.id), e => e.status === 400 && /last active store/.test(e.message));
  assert.deepEqual((await orgs.storesOfOrg("org1")).map(s => s.id), ["s2"]);
  assert.deepEqual((await orgs.archivedStoresOfOrg("org1")).map(s => s.id), ["s1"]);
  await orgs.restoreStore("s1");
  assert.deepEqual((await orgs.storesOfOrg("org1")).map(s => s.id).sort(), ["s1", "s2"]);
  assert.deepEqual(await orgs.archivedStoresOfOrg("org1"), []);
});

test("#127: two archives at once can't take the org to zero active stores", async () => {
  const { owner } = await seedOrg();
  const results = await Promise.allSettled([orgs.archiveStore("s1", owner.id), orgs.archiveStore("s2", owner.id)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await orgs.storesOfOrg("org1")).length, 1);
});

test("#127: the last-store rule counts per org, not across orgs", async () => {
  const { owner } = await seedOrg();
  // org2 has a single store; org1's stores don't count toward it.
  await assert.rejects(orgs.archiveStore("sx", owner.id), e => e.status === 400);
});

/* ---------- #134 saving a member keeps their archived stores ---------- */

test("#134: saving a staff member from Manage keeps an archived store they had; restoring it gives it back", async () => {
  const { owner, staff } = await seedOrg();
  await orgs.archiveStore("s1", owner.id);
  // The Manage form only lists active stores, so it sends just s2.
  const ids = await orgs.memberStoreIds("org1", ["s2"], staff.storeIds);
  assert.deepEqual(ids.sort(), ["s1", "s2"]);
  await auth.setOrgMembership(staff.id, { orgId: "org1", orgRole: "staff", storeIds: ids });
  let saved = await auth.findUserById(staff.id);
  assert.equal(await orgs.canAccessStore(saved, "s1"), false, "archived: no access yet");
  await orgs.restoreStore("s1", owner.id);
  saved = await auth.findUserById(staff.id);
  assert.equal(await orgs.canAccessStore(saved, "s1"), true, "restored: s1 is theirs again");
  assert.equal(await orgs.canAccessStore(saved, "s2"), true);
});

test("#134: a save can't ADD an archived or foreign store, and an active store can still be unticked", async () => {
  const { owner, staff } = await seedOrg();
  await orgs.archiveStore("s2", owner.id);
  // staff has only s1: asking for archived s2 and foreign sx gets neither.
  assert.deepEqual(await orgs.memberStoreIds("org1", ["s1", "s2", "sx"], staff.storeIds), ["s1"]);
  // Current ids are only kept when they're this org's archived stores.
  assert.deepEqual(await orgs.memberStoreIds("org1", [], ["s1", "sx", "junk"]), []);
  assert.deepEqual(await orgs.memberStoreIds("org1", ["s1"], "s2"), ["s1"]);
});

test("#127: rename and add share the stores lock with archive/restore (no lost updates)", async () => {
  const { owner } = await seedOrg();
  // A rename racing an archive must not write the old archived flag back.
  await Promise.all([orgs.renameStore("s1", "Renamed"), orgs.archiveStore("s1", owner.id)]);
  const s1 = await orgs.storeById("s1");
  assert.equal(s1.archived, true);
  assert.equal(s1.name, "Renamed");
  // Stores added at the same moment all survive.
  await Promise.all([1, 2, 3, 4, 5].map(n => orgs.addStore("org1", "New " + n)));
  assert.equal((await orgs.storesOfOrg("org1")).length, 6);
});

/* ---------- #126 invites ---------- */

async function setInviteField(code, patch) {
  const db = await store.readUsers();
  Object.assign(db.invites.find(i => i.code === code), patch);
  await store.writeUsers(db);
}

test("#126: an org invite expires after 7 days and is then refused; plain invites last 30 days (PR #143)", async () => {
  const { owner } = await seedOrg();
  const inv = await auth.createInvite(owner.id, "", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  const days = (Date.parse(inv.expiresAt) - Date.parse(inv.createdAt)) / 86400000;
  assert.equal(days, 7);
  const plain = await auth.createInvite(owner.id, "", null, null);
  assert.equal((Date.parse(plain.expiresAt) - Date.parse(plain.createdAt)) / 86400000, 30, "plain invites: 30 days (PR #143)");

  await setInviteField(inv.code, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await auth.consumeInvite(inv.code), null, "expired invite can't be consumed");
  assert.equal(await auth.inviteStateByCode(inv.code), "expired");
  assert.deepEqual(await auth.listOrgInvites("org1"), [], "expired invites aren't outstanding");
});

test("#126: a revoked invite is refused and drops off the outstanding list", async () => {
  const { owner } = await seedOrg();
  const inv = await auth.createInvite(owner.id, "jamie", { orgId: "org1", orgRole: "manager" });
  assert.equal((await auth.listOrgInvites("org1")).length, 1);
  assert.equal((await auth.listOrgInvites("org2")).length, 0, "another org never sees it");
  assert.ok(await auth.revokeInvite(inv.code, owner.id));
  assert.equal(await auth.consumeInvite(inv.code), null);
  assert.equal(await auth.inviteStateByCode(inv.code), "revoked");
  assert.deepEqual(await auth.listOrgInvites("org1"), []);
  assert.equal(await auth.revokeInvite("no-such-code", owner.id), null);
});

test("#126: a used invite can't be revoked or reused", async () => {
  const { owner } = await seedOrg();
  const inv = await auth.createInvite(owner.id, "", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  await auth.consumeInvite(inv.code);
  await auth.markInviteUsed(inv.code, "someone");
  assert.equal(await auth.revokeInvite(inv.code, owner.id), null);
  assert.equal(await auth.consumeInvite(inv.code), null);
});

test("#126: invites made before expiry existed get 7 days from first boot, once", async () => {
  const { owner } = await seedOrg();
  const old = await auth.createInvite(owner.id, "", { orgId: "org1", orgRole: "owner" });
  const plain = await auth.createInvite(owner.id, "", null, null);
  const used = await auth.createInvite(owner.id, "", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  await setInviteField(old.code, { expiresAt: undefined, revokedAt: undefined, createdAt: "2026-01-01T00:00:00.000Z" });
  await setInviteField(used.code, { expiresAt: undefined, usedBy: "u", usedAt: "2026-01-02T00:00:00.000Z" });
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  assert.equal(await auth.stampLegacyOrgInviteExpiry(now), 1, "only the unused org invite is stamped");
  const db = await store.readUsers();
  const row = db.invites.find(i => i.code === old.code);
  assert.equal(row.expiresAt, "2026-10-16T12:00:00.000Z");
  assert.equal(row.expiryBackfilled, true);
  assert.equal(db.invites.find(i => i.code === plain.code).expiresAt, plain.expiresAt, "plain invites untouched");
  assert.equal(await auth.stampLegacyOrgInviteExpiry(now + 86400000), 0, "idempotent");
});

test("#126: re-check at use refuses when the inviter lost standing, was removed, disabled, or the org is gone", async () => {
  const { owner, owner2, mgr } = await seedOrg();
  const ownerInv = await auth.createInvite(owner2.id, "", { orgId: "org1", orgRole: "owner" });
  const staffInv = await auth.createInvite(mgr.id, "", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  assert.ok((await orgs.checkOrgInviteAtUse(ownerInv)).orgMeta, "fine while owner2 is an owner");
  assert.ok((await orgs.checkOrgInviteAtUse(staffInv)).orgMeta, "fine while mgr is a manager");

  // Owner demoted to manager: their owner-level invite dies, a staff one wouldn't.
  await auth.setOrgMembership(owner2.id, { orgId: "org1", orgRole: "manager" });
  assert.match((await orgs.checkOrgInviteAtUse(ownerInv)).error, /no longer valid/);
  const mgrInvAsOwner = await auth.createInvite(owner2.id, "", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  assert.ok((await orgs.checkOrgInviteAtUse(mgrInvAsOwner)).orgMeta);

  // Manager removed from the org: their staff invite dies.
  await auth.setOrgMembership(mgr.id, { orgId: null });
  assert.match((await orgs.checkOrgInviteAtUse(staffInv)).error, /no longer valid/);

  // Disabled inviter.
  const db = await store.readUsers();
  db.users.find(u => u.id === owner.id).disabled = true;
  await store.writeUsers(db);
  const disabledInv = { createdBy: owner.id, orgMeta: { orgId: "org1", orgRole: "staff", storeIds: ["s1"] } };
  assert.ok((await orgs.checkOrgInviteAtUse(disabledInv)).error);

  // Org gone.
  await store.writeOrgs({ orgs: [] });
  assert.match((await orgs.checkOrgInviteAtUse(mgrInvAsOwner)).error, /no longer exists/);
});

test("#126: re-check at use re-filters stores (archived, foreign and junk ids dropped)", async () => {
  const { mgr, owner } = await seedOrg();
  const inv = { createdBy: mgr.id, orgMeta: { orgId: "org1", orgRole: "staff", storeIds: ["s1", "s2", "sx", "junk"] } };
  await orgs.archiveStore("s2", owner.id);
  const out = await orgs.checkOrgInviteAtUse(inv);
  assert.deepEqual(out.orgMeta, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  // Manager/owner invites carry no store list at all.
  const ownerInv = { createdBy: owner.id, orgMeta: { orgId: "org1", orgRole: "manager", storeIds: ["s1"] } };
  assert.deepEqual((await orgs.checkOrgInviteAtUse(ownerInv)).orgMeta.storeIds, []);
});

/* ---------- #124 Stop sharing ---------- */

test("#124: after Stop sharing the friend sees nothing, whatever defaultShare is", () => {
  for (const def of ["off", "summary", "full"]) {
    const s = { friends: [{ username: "bob", share: "summary" }], defaultShare: def };
    s.friends = sharing.stopSharing(s.friends, "bob");
    assert.equal(sharing.levelFor(s, "bob"), "off", "defaultShare " + def);
    assert.equal(s.friends.length, 1, "the entry is kept, at off");
  }
});

test("#124: Stop sharing for someone with no entry adds an explicit off entry", () => {
  const s = { friends: [], defaultShare: "full" };
  s.friends = sharing.stopSharing(s.friends, "carol");
  assert.equal(sharing.levelFor(s, "carol"), "off");
});

test("#124: forget deletes the entry, falling back to defaultShare (what the page warns about)", () => {
  const s = { friends: [{ username: "bob", share: "off" }], defaultShare: "summary" };
  s.friends = sharing.stopSharing(s.friends, "bob", { forget: true });
  assert.equal(s.friends.length, 0);
  assert.equal(sharing.levelFor(s, "bob"), "summary");
});

test("#124: levelFor treats an unknown stored level as off", () => {
  assert.equal(sharing.levelFor({ friends: [{ username: "bob", share: "everything" }], defaultShare: "full" }, "bob"), "off");
  assert.equal(sharing.levelFor({ friends: [], defaultShare: undefined }, "bob"), "off");
  assert.equal(sharing.levelFor({ friends: [], defaultShare: "full" }, "bob"), "full");
});

/* ---------- #125 trade lines ---------- */

const EVIL = { toString: 1, valueOf: 1 };

test("#125: object/array-valued line fields are stored as null, never as objects", () => {
  const [l] = trades.sanitizeTradeLines([{
    name: "Bolt", set: EVIL, collector: ["1"], lang: { a: 1 }, finish: EVIL, oracleId: true,
    qty: EVIL, price: EVIL, role: EVIL, imageUrl: EVIL
  }]);
  assert.deepEqual(l, { name: "Bolt", set: null, collector: null, lang: null, finish: null, qty: 1, price: 0,
    oracleId: null, role: "main", imageUrl: null });
  for (const v of Object.values(l)) assert.ok(v === null || typeof v === "string" || typeof v === "number");
});

test("#125: an object-valued name doesn't throw; the line is dropped", () => {
  assert.deepEqual(trades.sanitizeTradeLines([{ name: EVIL }, null, 5, "x"]), []);
});

test("#125: strings and numbers are bounded; finish limited to known names", () => {
  const [l] = trades.sanitizeTradeLines([{
    name: "  Bolt  ", set: "x".repeat(100), collector: 123, lang: "en", finish: "FOIL",
    oracleId: "o".repeat(80), qty: "3", price: "1.5", role: "filler"
  }]);
  assert.equal(l.name, "Bolt");
  assert.equal(l.set.length, 64);
  assert.equal(l.collector, "123");
  assert.equal(l.finish, "foil");
  assert.equal(l.oracleId.length, 64);
  assert.equal(l.qty, 3);
  assert.equal(l.price, 1.5);
  assert.equal(l.role, "filler");
  assert.equal(trades.sanitizeTradeLines([{ name: "a", finish: "shiny" }])[0].finish, null);
  assert.equal(trades.sanitizeTradeLines([{ name: "a", qty: 1e9, price: Infinity }])[0].qty, 9999);
  assert.equal(trades.sanitizeTradeLines([{ name: "a", price: Infinity }])[0].price, 0);
  assert.equal(trades.sanitizeTradeLines(Array(80).fill({ name: "a" })).length, 50);
});

test("#125: a bad proposal already on disk is cleaned on the way out, and an unknown status reads as open", () => {
  const stored = {
    id: "p1", fromUserId: "a", fromUsername: "alice", toUserId: "b", toUsername: "bob",
    offering: [{ name: "Bolt", set: EVIL }], requesting: "nope", note: EVIL, status: { x: 1 },
    createdAt: 5, updatedAt: null
  };
  const p = trades.sanitizeProposal(stored);
  assert.equal(p.offering[0].set, null);
  assert.deepEqual(p.requesting, []);
  assert.equal(p.note, "");
  assert.equal(p.status, "open");
  assert.equal(typeof p.createdAt, "string");
  assert.doesNotThrow(() => JSON.stringify(p));
});
