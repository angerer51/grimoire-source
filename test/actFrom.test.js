"use strict";
/* Share and trade from (#128): which inventory an org account shares and
   trades from, who may pick a store, and who may answer or withdraw a
   proposal that went to or from a store. Against a scratch dataDir via
   store.init(), never the live one. The route wiring (forged fromStoreId /
   toStoreId, what a friend's share shows) was exercised over HTTP on a
   scratch server; see the PR. */
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
const actFrom = lib("actFrom");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const PW = "correct-horse-1";

/* org1 (stores s1, s2) with an owner, two managers and staff on s1; org2
   (store sx) with its own owner; and a personal account. */
async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-actfrom-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  await store.writeOrgs({ orgs: [{ id: "org1", name: "Org" }, { id: "org2", name: "Other" }] });
  await store.writeStoreList({ stores: [
    { id: "s1", orgId: "org1", name: "One", archived: false },
    { id: "s2", orgId: "org1", name: "Two", archived: false },
    { id: "sx", orgId: "org2", name: "Foreign", archived: false }
  ] });
  const mk = async (username, orgMeta) => {
    const u = await auth.createUser({ username, password: PW });
    if (orgMeta) await auth.setOrgMembership(u.id, orgMeta);
    return u.id;
  };
  const ids = {
    owner: await mk("owner", { orgId: "org1", orgRole: "owner" }),
    mgr: await mk("mgr", { orgId: "org1", orgRole: "manager" }),
    mgr2: await mk("mgr2", { orgId: "org1", orgRole: "manager" }),
    staff: await mk("staff", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }),
    xowner: await mk("xowner", { orgId: "org2", orgRole: "owner" }),
    solo: await mk("solo", null)
  };
  const fresh = async name => auth.findUserById(ids[name]);
  return { ids, fresh };
}

/* ---------- who may act from a store ---------- */

test("an Owner and a Manager may act from a store in their org; it resolves to that store", async () => {
  const { fresh } = await seed();
  for (const name of ["owner", "mgr"]) {
    const u = await fresh(name);
    const r = await actFrom.choose(u, "s2");
    assert.equal(r.kind, "store");
    assert.equal(r.owner, "store:s2");
    assert.equal(r.storeName, "Two");
    assert.equal(r.orgName, "Org");
    assert.deepEqual((await actFrom.resolve(u)).owner, "store:s2");
  }
});

test("Staff may not act from a store, not even one they're assigned to (403)", async () => {
  const { fresh } = await seed();
  const staff = await fresh("staff");
  await assert.rejects(actFrom.choose(staff, "s1"), e => e.status === 403);
  assert.deepEqual(await actFrom.choices(staff), []);
  assert.equal((await actFrom.resolve(staff)).owner, staff.id);
});

test("a personal account, another org's store, an archived store and junk ids are all refused", async () => {
  const { fresh } = await seed();
  await assert.rejects(actFrom.choose(await fresh("solo"), "s1"), e => e.status === 403);
  const mgr = await fresh("mgr");
  for (const bad of ["sx", "nope"]) {
    await assert.rejects(actFrom.choose(mgr, bad), e => e.status === 403, bad);
  }
  await assert.rejects(actFrom.choose(mgr, { id: "s1" }), e => e.status === 400, "object id");
  assert.equal((await actFrom.resolve(mgr)).kind, "personal", "nothing was saved");
  await store.updateStoreList(d => { d.stores.find(s => s.id === "s2").archived = true; });
  await assert.rejects(actFrom.choose(mgr, "s2"), e => e.status === 403);
});

test("the default is personal cards, and choosing null/empty goes back to them", async () => {
  const { fresh } = await seed();
  const owner = await fresh("owner");
  assert.equal((await actFrom.resolve(owner)).kind, "personal");
  await actFrom.choose(owner, "s1");
  assert.equal((await actFrom.choose(owner, null)).kind, "personal");
  assert.equal((await store.readPrefs(owner.id)).actFrom, undefined);
});

test("a store id written straight into prefs is still re-checked: Staff and outsiders get their personal cards", async () => {
  const { fresh } = await seed();
  for (const [name, sid] of [["staff", "s1"], ["solo", "s1"], ["mgr", "sx"], ["xowner", "s1"]]) {
    const u = await fresh(name);
    await store.updatePrefs(u.id, p => { p.actFrom = sid; });
    const r = await actFrom.resolve(u);
    assert.equal(r.kind, "personal", name);
    assert.equal(r.owner, u.id, name);
  }
});

test("losing Manager rank, leaving the org, or the store being archived falls straight back to personal", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  assert.equal((await actFrom.resolve(await fresh("mgr"))).kind, "personal", "demoted");

  await actFrom.choose(await fresh("mgr2"), "s1");
  await auth.setOrgMembership(ids.mgr2, { orgId: null });
  assert.equal((await actFrom.resolve(await fresh("mgr2"))).kind, "personal", "left");

  await actFrom.choose(await fresh("owner"), "s2");
  await orgs.archiveStore("s2", ids.owner);
  assert.equal((await actFrom.resolve(await fresh("owner"))).kind, "personal", "archived");
});

test("what a friend reads follows resolve(): a store's inventory only for an allowed account, otherwise the personal file", async () => {
  const { fresh } = await seed();
  await store.writeCollection("store:s1", { cards: [{ name: "Store card", quantity: 1, price: 5 }] });
  const staff = await fresh("staff");
  await store.updatePrefs(staff.id, p => { p.actFrom = "s1"; });   // forged
  const staffSrc = await actFrom.resolve(staff);
  const seen = await store.readCollection(staffSrc.owner);
  assert.ok(!((seen.state && seen.state.cards) || []).some(c => c.name === "Store card"));

  const owner = await fresh("owner");
  await actFrom.choose(owner, "s1");
  const ownerSeen = await store.readCollection((await actFrom.resolve(owner)).owner);
  assert.ok(ownerSeen.state.cards.some(c => c.name === "Store card"));
});

/* ---------- proposals to and from a store ---------- */

const prop = extra => Object.assign({
  id: "p1", fromUserId: "a", fromUsername: "a", toUserId: "b", toUsername: "b",
  fromStoreId: null, toStoreId: null, status: "open"
}, extra);

test("a proposal to a store: the recipient and every Owner/Manager of that store may answer; Staff and outsiders may not", async () => {
  const { ids, fresh } = await seed();
  const p = prop({ fromUserId: ids.solo, toUserId: ids.mgr, toStoreId: "s1" });
  for (const name of ["mgr", "mgr2", "owner"]) {
    const u = await fresh(name);
    const r = actFrom.proposalRoles(p, u, await actFrom.managedStoreIds(u));
    assert.ok(r.incoming && r.canRespond, name);
    assert.ok(!r.canWithdraw, name);
  }
  for (const name of ["staff", "xowner"]) {
    const u = await fresh(name);
    const r = actFrom.proposalRoles(p, u, await actFrom.managedStoreIds(u));
    assert.ok(!r.incoming && !r.canRespond && !r.outgoing, name);
  }
});

test("a proposal from a store: any Owner/Manager of it may withdraw, the sender needs the rank too, Staff never", async () => {
  const { ids, fresh } = await seed();
  const p = prop({ fromUserId: ids.mgr, toUserId: ids.solo, fromStoreId: "s1" });
  for (const name of ["mgr", "mgr2", "owner"]) {
    const u = await fresh(name);
    assert.ok(actFrom.proposalRoles(p, u, await actFrom.managedStoreIds(u)).canWithdraw, name);
  }
  const staff = await fresh("staff");
  assert.ok(!actFrom.proposalRoles(p, staff, await actFrom.managedStoreIds(staff)).canWithdraw);
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  const demoted = await fresh("mgr");
  const r = actFrom.proposalRoles(p, demoted, await actFrom.managedStoreIds(demoted));
  assert.ok(r.outgoing, "still listed as theirs");
  assert.ok(!r.canWithdraw, "but no longer theirs to withdraw");
  // The store's other managers keep it: still open and withdrawable by them.
  const mgr2 = await fresh("mgr2");
  assert.ok(actFrom.proposalRoles(p, mgr2, await actFrom.managedStoreIds(mgr2)).canWithdraw);
});

test("a personal proposal stays sender-only to withdraw and recipient-only to answer", async () => {
  const { ids, fresh } = await seed();
  const p = prop({ fromUserId: ids.mgr, toUserId: ids.solo });
  const mgr2 = await fresh("mgr2");
  const r2 = actFrom.proposalRoles(p, mgr2, await actFrom.managedStoreIds(mgr2));
  assert.ok(!r2.outgoing && !r2.incoming && !r2.canWithdraw && !r2.canRespond);
  const mgr = await fresh("mgr");
  assert.ok(actFrom.proposalRoles(p, mgr, await actFrom.managedStoreIds(mgr)).canWithdraw);
  const solo = await fresh("solo");
  const rs = actFrom.proposalRoles(p, solo, await actFrom.managedStoreIds(solo));
  assert.ok(rs.canRespond && !rs.canWithdraw);
});

test("a stored toStoreId / fromStoreId naming another org's store gives this org's managers nothing", async () => {
  const { ids, fresh } = await seed();
  const forged = prop({ fromUserId: ids.solo, toUserId: ids.xowner, toStoreId: "sx", fromStoreId: "sx" });
  for (const name of ["owner", "mgr"]) {
    const u = await fresh(name);
    const r = actFrom.proposalRoles(forged, u, await actFrom.managedStoreIds(u));
    assert.ok(!r.incoming && !r.outgoing && !r.canRespond && !r.canWithdraw, name);
  }
});

test("closed proposals can't be answered or withdrawn; a viewer on both sides can't accept their own offer", async () => {
  const { ids, fresh } = await seed();
  const mgr = await fresh("mgr");
  const managed = await actFrom.managedStoreIds(mgr);
  for (const status of ["accepted", "declined", "withdrawn"]) {
    const r = actFrom.proposalRoles(prop({ toUserId: ids.mgr, toStoreId: "s1", fromUserId: ids.mgr, fromStoreId: "s2", status }), mgr, managed);
    assert.ok(!r.canRespond && !r.canWithdraw, status);
  }
  const both = actFrom.proposalRoles(prop({ fromUserId: ids.solo, toUserId: ids.mgr2, fromStoreId: "s2", toStoreId: "s1" }), mgr, managed);
  assert.ok(both.incoming && both.outgoing);
  assert.ok(!both.canRespond, "can't accept an offer from a store they also manage");
  assert.ok(both.canWithdraw);
});

test("proposalProblem refuses a trade with a store you manage, or the same store on both sides", async () => {
  const { fresh } = await seed();
  const mgr = await fresh("mgr"), solo = await fresh("solo"), owner = await fresh("owner"), xowner = await fresh("xowner");
  const s1 = { storeId: "s1", storeName: "One" }, none = { storeId: null };
  assert.ok(await actFrom.proposalProblem(mgr, none, owner, s1), "sender manages the recipient's store");
  assert.ok(await actFrom.proposalProblem(mgr, s1, owner, none), "recipient manages the sender's store");
  assert.ok(await actFrom.proposalProblem(mgr, s1, owner, s1), "same store");
  assert.equal(await actFrom.proposalProblem(solo, none, mgr, s1), null);
  assert.equal(await actFrom.proposalProblem(mgr, s1, xowner, { storeId: "sx", storeName: "Foreign" }), null);
});

/* ---------- archive, and the one status-change point ---------- */

test("archiving a store withdraws its open proposals both ways, with the reason; others are untouched", async () => {
  const { ids } = await seed();
  await store.writeTradeProposals({ proposals: [
    prop({ id: "from-s1", fromStoreId: "s1" }),
    prop({ id: "to-s1", toStoreId: "s1" }),
    prop({ id: "s1-accepted", toStoreId: "s1", status: "accepted" }),
    prop({ id: "s2", fromStoreId: "s2" }),
    prop({ id: "personal" })
  ] });
  const archived = await orgs.archiveStore("s1", ids.owner);
  const n = await actFrom.withdrawStoreProposals(archived, { id: ids.owner, username: "owner" });
  assert.equal(n, 2);
  const by = Object.fromEntries((await store.readTradeProposals()).proposals.map(p => [p.id, p]));
  for (const id of ["from-s1", "to-s1"]) {
    assert.equal(by[id].status, "withdrawn");
    assert.equal(by[id].statusReason, "One was archived");
    assert.equal(by[id].statusByUsername, "owner");
  }
  assert.equal(by["s1-accepted"].status, "accepted");
  assert.equal(by.s2.status, "open");
  assert.equal(by.personal.status, "open");
});

test("changeStatus is the one status writer: it stamps who, when and why, and rejects unknown statuses", () => {
  const p = prop({});
  trades.changeStatus(p, "declined", { id: "u1", username: "alice" }, null);
  assert.equal(p.status, "declined");
  assert.equal(p.statusByUsername, "alice");
  assert.equal(p.statusReason, null);
  assert.ok(p.updatedAt);
  assert.throws(() => trades.changeStatus(p, "stolen", null));
});

test("sanitizeProposal keeps the store fields as bounded strings and drops object-valued ones", () => {
  const out = trades.sanitizeProposal(prop({ fromStoreId: "s1", fromStoreName: "One", toStoreId: { x: 1 }, toStoreName: ["x"] }));
  assert.equal(out.fromStoreId, "s1");
  assert.equal(out.fromStoreName, "One");
  assert.equal(out.toStoreId, null);
  assert.equal(out.toStoreName, null);
});

/* ---------- rework round 1 (owner's answers, 2026-10-10) ---------- */

test("a demoted or departed named recipient can still see a to-store offer but can't accept or decline it", async () => {
  const { ids, fresh } = await seed();
  const p = prop({ fromUserId: ids.solo, toUserId: ids.mgr, toStoreId: "s1" });
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  let mgr = await fresh("mgr");
  let r = actFrom.proposalRoles(p, mgr, await actFrom.managedStoreIds(mgr));
  assert.ok(r.incoming, "demoted: still listed");
  assert.ok(!r.canRespond, "demoted: can't answer for the store");
  await auth.setOrgMembership(ids.mgr, { orgId: null });
  mgr = await fresh("mgr");
  r = actFrom.proposalRoles(p, mgr, await actFrom.managedStoreIds(mgr));
  assert.ok(r.incoming && !r.canRespond, "departed: same");
  // The store's current managers still can.
  const mgr2 = await fresh("mgr2");
  assert.ok(actFrom.proposalRoles(p, mgr2, await actFrom.managedStoreIds(mgr2)).canRespond);
});

test("viewerCopy gives store ids only to a current manager of that store; names follow the share rule", async () => {
  const { ids, fresh } = await seed();
  const p = prop({ fromUserId: ids.mgr, toUserId: ids.xowner, fromStoreId: "s1", fromStoreName: "One",
    toStoreId: "sx", toStoreName: "Foreign", toStoreShown: false });
  const xowner = await fresh("xowner");
  const asRecipient = actFrom.viewerCopy(p, xowner, await actFrom.managedStoreIds(xowner));
  assert.equal(asRecipient.fromStoreId, null, "recipient never gets the sending store's id");
  assert.equal(asRecipient.fromStoreName, "One", "but sees its name");
  assert.equal(asRecipient.toStoreId, "sx", "their own store's id is theirs");
  const mgr2 = await fresh("mgr2");
  const asSenderSide = actFrom.viewerCopy(p, mgr2, await actFrom.managedStoreIds(mgr2));
  assert.equal(asSenderSide.fromStoreId, "s1");
  assert.equal(asSenderSide.toStoreId, null, "another org's store id never reaches this org");
  assert.equal(asSenderSide.toStoreName, null, "sender couldn't see the share, so no name either");
  const shown = actFrom.viewerCopy(Object.assign({}, p, { toStoreShown: true }), mgr2, await actFrom.managedStoreIds(mgr2));
  assert.equal(shown.toStoreName, "Foreign");
  assert.equal(shown.toStoreId, null);
  const solo = await fresh("solo");
  const outsider = actFrom.viewerCopy(prop({ toUserId: ids.solo, fromStoreId: "s1", fromStoreName: "One" }), solo, await actFrom.managedStoreIds(solo));
  assert.equal(outsider.fromStoreId, null);
});

test("concernsViewer picks a viewer's proposals by id alone, ignoring damaged records", async () => {
  const { ids, fresh } = await seed();
  const mgr = await fresh("mgr"), managed = await actFrom.managedStoreIds(mgr);
  assert.ok(actFrom.concernsViewer(prop({ toUserId: ids.mgr }), mgr, managed));
  assert.ok(actFrom.concernsViewer(prop({ toStoreId: "s2" }), mgr, managed));
  assert.ok(!actFrom.concernsViewer(prop({ toStoreId: "sx" }), mgr, managed));
  assert.ok(!actFrom.concernsViewer(prop({ toStoreId: { toString: () => "s1" } }), mgr, managed));
  assert.ok(!actFrom.concernsViewer(null, mgr, managed));
});

test("archivedSideProblem refuses an offer to or from a store archived since it was resolved", async () => {
  const { ids } = await seed();
  const s1 = { storeId: "s1", storeName: "One" }, none = { storeId: null };
  assert.equal(await actFrom.archivedSideProblem(s1, none), null);
  await orgs.archiveStore("s1", ids.owner);
  assert.match(await actFrom.archivedSideProblem(s1, none), /One has just been archived/);
  assert.match(await actFrom.archivedSideProblem(none, s1), /One/);
  assert.equal(await actFrom.archivedSideProblem(none, { storeId: "s2" }), null);
});

test("a saved store choice that stops being valid is cleared, so re-promotion or a restore doesn't turn it back on", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  assert.equal((await actFrom.resolve(await fresh("mgr"))).kind, "personal");
  assert.equal((await store.readPrefs(ids.mgr)).actFrom, undefined, "demotion cleared it");
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "manager" });
  assert.equal((await actFrom.resolve(await fresh("mgr"))).kind, "personal", "re-promoted: has to pick again");

  await actFrom.choose(await fresh("owner"), "s2");
  await orgs.archiveStore("s2", ids.owner);
  await actFrom.resolve(await fresh("owner"));
  await orgs.restoreStore("s2");
  assert.equal((await actFrom.resolve(await fresh("owner"))).kind, "personal", "restored store: has to pick again");
  assert.equal((await store.readPrefs(ids.owner)).actFrom, undefined);

  await store.updatePrefs(ids.solo, p => { p.actFrom = "s1"; });   // personal account with a stray choice
  await actFrom.resolve(await fresh("solo"));
  assert.equal((await store.readPrefs(ids.solo)).actFrom, undefined);
});

test("clearing only removes the stale choice, never a valid one saved meanwhile", async () => {
  const { ids, fresh } = await seed();
  const owner = await fresh("owner");
  // Resolve with prefs read when the choice was a bad id, after a good one was saved.
  await actFrom.choose(owner, "s2");
  await actFrom.resolve(owner, { actFrom: "gone" });
  assert.equal((await store.readPrefs(ids.owner)).actFrom, "s2");
});

/* ---------- rework round 2: cleared the moment access is lost ---------- */
// None of these call resolve() between losing and regaining access.

test("demote then re-promote, with no read in between: the store choice is gone", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "manager" });
  assert.equal((await store.readPrefs(ids.mgr)).actFrom, undefined);
  assert.equal((await actFrom.resolve(await fresh("mgr"))).kind, "personal");
});

test("remove then re-add (rejoin), with no read in between: the store choice is gone", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setOrgMembership(ids.mgr, { orgId: null });
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "manager" });
  assert.equal((await store.readPrefs(ids.mgr)).actFrom, undefined);
  assert.equal((await actFrom.resolve(await fresh("mgr"))).kind, "personal");
});

test("archive then restore, with no read in between: every member's choice of that store is gone, others kept", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("owner"), "s1");
  await actFrom.choose(await fresh("mgr"), "s1");
  await actFrom.choose(await fresh("mgr2"), "s2");
  await orgs.archiveStore("s1", ids.owner);
  await orgs.restoreStore("s1");
  assert.equal((await store.readPrefs(ids.owner)).actFrom, undefined);
  assert.equal((await store.readPrefs(ids.mgr)).actFrom, undefined);
  assert.equal((await store.readPrefs(ids.mgr2)).actFrom, "s2", "a different store's choice is untouched");
  assert.equal((await actFrom.resolve(await fresh("owner"))).kind, "personal");
});

test("a change that keeps the rank in the same org (manager to owner) keeps the choice", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "owner" });
  assert.equal((await store.readPrefs(ids.mgr)).actFrom, "s1");
});

test("a sender who couldn't see the recipient's store gets a generic archive reason and no other manager's name", async () => {
  const { ids, fresh } = await seed();
  const solo = await fresh("solo"), noManaged = await actFrom.managedStoreIds(solo);
  const base = prop({ fromUserId: ids.solo, toUserId: ids.mgr, toStoreId: "s1", toStoreName: "One", toStoreShown: false });
  const archived = Object.assign({}, base, { status: "withdrawn", statusReason: "One was archived", statusReasonStoreId: "s1",
    statusByUserId: ids.owner, statusByUsername: "owner" });
  let v = actFrom.viewerCopy(archived, solo, noManaged);
  assert.equal(v.statusReason, "the store was archived");
  assert.equal(v.statusByUsername, null);
  assert.ok(!JSON.stringify(v).includes("One"), "the store's name appears nowhere");
  const answered = Object.assign({}, base, { status: "accepted", statusByUserId: ids.mgr2, statusByUsername: "mgr2" });
  assert.equal(actFrom.viewerCopy(answered, solo, noManaged).statusByUsername, null);
  const byAddressee = Object.assign({}, base, { status: "declined", statusByUserId: ids.mgr, statusByUsername: "mgr" });
  assert.equal(actFrom.viewerCopy(byAddressee, solo, noManaged).statusByUsername, "mgr", "the person they addressed is no secret");
  // A sender who could see the share keeps the specific wording.
  v = actFrom.viewerCopy(Object.assign({}, archived, { toStoreShown: true }), solo, noManaged);
  assert.equal(v.statusReason, "One was archived");
  assert.equal(v.statusByUsername, "owner");
  // And the store's own managers always do.
  const mgr2 = await fresh("mgr2");
  assert.equal(actFrom.viewerCopy(archived, mgr2, await actFrom.managedStoreIds(mgr2)).statusReason, "One was archived");
});

test("the archive sweep records which store the reason names", async () => {
  const { ids } = await seed();
  await store.writeTradeProposals({ proposals: [prop({ id: "x", toStoreId: "s1" })] });
  const s = await orgs.archiveStore("s1", ids.owner);
  await actFrom.withdrawStoreProposals(s, null);
  assert.equal((await store.readTradeProposals()).proposals[0].statusReasonStoreId, "s1");
});

/* ---------- #142: a disabled account shares nothing ---------- */

test("a disabled account resolves to nothing shared, personal or store, however it is looked up (#142)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setDisabled(ids.mgr, true);
  await auth.setDisabled(ids.solo, true);
  for (const name of ["mgr", "solo"]) {
    const raw = await fresh(name);
    const listed = (await auth.listUsers({ withDisabled: true })).find(u => u.id === ids[name]);
    const plain = (await auth.listUsers()).find(u => u.id === ids[name]);
    for (const acct of [raw, listed, plain]) {
      const r = await actFrom.resolve(acct);
      assert.equal(r.kind, "off", name);
      assert.equal(r.owner, null, name + ": no collection to read");
      assert.equal(r.storeId, null);
    }
  }
});

test("disabling clears the saved store; re-enabling brings back personal sharing, and the store needs a re-pick (#142)", async () => {
  const { ids, fresh } = await seed();
  assert.equal((await actFrom.choose(await fresh("mgr2"), "s2")).kind, "store");
  await auth.setDisabled(ids.mgr2, true);
  assert.equal((await store.readPrefs(ids.mgr2)).actFrom, undefined, "cleared at disable time");
  await auth.setDisabled(ids.mgr2, false);
  const back = await actFrom.resolve(await fresh("mgr2"));
  assert.equal(back.kind, "personal");
  assert.equal(back.owner, ids.mgr2);
  assert.equal((await actFrom.choose(await fresh("mgr2"), "s2")).kind, "store", "picking it again works");
});

test("an account disabled with a store still saved (before #142) loses that choice on first look (#142)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  // Disabled the old way: the flag only, no prefs clean-up.
  await store.withLock("users", async () => {
    const db = await store.readUsers();
    db.users.find(u => u.id === ids.mgr).disabled = true;
    await store.writeJson(store.p("users.json"), db);
  });
  assert.equal((await store.readPrefs(ids.mgr)).actFrom, "s1");
  assert.equal((await actFrom.resolve(await fresh("mgr"))).kind, "off");
  assert.equal((await store.readPrefs(ids.mgr)).actFrom, undefined);
  await auth.setDisabled(ids.mgr, false);
  assert.equal((await actFrom.resolve(await fresh("mgr"))).kind, "personal");
});

test("a disabled account resolves with no store name to leak (#142)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setDisabled(ids.mgr, true);
  const to = await actFrom.resolve(await fresh("mgr"));
  assert.equal(to.storeId, null);
  assert.equal(to.storeName, null);
});

test("a trade offer to a disabled account is refused, in the same words as an unknown name (#142)", async () => {
  const { ids, fresh } = await seed();
  assert.equal(actFrom.recipientProblem(await fresh("solo")), null);
  await auth.setDisabled(ids.solo, true);
  assert.equal(actFrom.recipientProblem(await fresh("solo")), "No such user.");
  assert.equal(actFrom.recipientProblem(null), "No such user.");
  await auth.setDisabled(ids.solo, false);
  assert.equal(actFrom.recipientProblem(await fresh("solo")), null, "re-enabled: offers allowed again");
});

/* ---------- #147: telling the person, and the personal card count ---------- */

const BACK = /you're sharing and trading from your personal cards again/;

test("archiving the chosen store leaves a note naming it, until dismissed (#147)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("owner"), "s2");
  assert.equal(await actFrom.clearedNotice(ids.owner), null, "nothing to say while the choice holds");
  await orgs.archiveStore("s2", ids.owner);
  assert.equal((await store.readPrefs(ids.owner)).actFrom, undefined);
  const note = await actFrom.clearedNotice(ids.owner);
  assert.match(note, /^Two was archived, /);
  assert.match(note, BACK);
  assert.match(await actFrom.clearedNotice(ids.owner), /Two/, "reading it doesn't clear it");
  await actFrom.dismissClearedNotice(ids.owner);
  assert.equal(await actFrom.clearedNotice(ids.owner), null);
  assert.equal(await actFrom.clearedNotice(ids.mgr), null, "a member who never picked it gets no note");
});

test("demotion, leaving the org and disabling each say why (#147)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  assert.match(await actFrom.clearedNotice(ids.mgr), /no longer an owner or manager, so you can't share and trade from One/);

  await actFrom.choose(await fresh("mgr2"), "s1");
  await auth.setOrgMembership(ids.mgr2, { orgId: null });
  const left = await actFrom.clearedNotice(ids.mgr2);
  assert.match(left, /no longer in One's organization/);
  assert.match(left, BACK);

  await auth.setOrgMembership(ids.mgr2, { orgId: "org1", orgRole: "manager" });   // back, as a manager
  await actFrom.choose(await fresh("mgr2"), "s2");
  assert.equal(await actFrom.clearedNotice(ids.mgr2), null, "the new pick answered the old note");
  await auth.setDisabled(ids.mgr2, true);
  await auth.setDisabled(ids.mgr2, false);
  assert.match(await actFrom.clearedNotice(ids.mgr2), /turned off, which stopped sharing and trading from Two/);
});

test("the note keeps the store's name from when it was cleared, so a later rename never reaches an ex-member (#147 review)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s1");
  await auth.setOrgMembership(ids.mgr, { orgId: null });
  await orgs.renameStore("s1", "Secret New Name");
  const note = await actFrom.clearedNotice(ids.mgr);
  assert.match(note, /no longer in One's organization/);
  assert.doesNotMatch(note, /Secret/);
  assert.equal((await store.readPrefs(ids.mgr)).actFromCleared.storeName, "One");

  await actFrom.choose(await fresh("owner"), "s2");
  await orgs.archiveStore("s2", ids.owner);
  await orgs.renameStore("s2", "Renamed Later");
  assert.match(await actFrom.clearedNotice(ids.owner), /^Two was archived/);

  // A note with no saved name (or a damaged one) uses neutral words.
  await store.updatePrefs(ids.solo, p => { p.actFromCleared = { storeId: "s1", storeName: { x: 1 }, reason: "left" }; });
  assert.match(await actFrom.clearedNotice(ids.solo), /^You're no longer in Your store's organization/);
  const p = { actFrom: "s1" };
  actFrom.dropChoice(p, "left", undefined, () => "x".repeat(500));
  assert.equal(p.actFromCleared.storeName.length, 80, "bounded");
});

test("resolve()'s backstop leaves the note too, and picking again answers it (#147)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("owner"), "s2");
  // Archived behind the app's back: no clearStoreChoices ran.
  const doc = await store.readStoreList();
  doc.stores.find(s => s.id === "s2").archived = true;
  await store.writeStoreList(doc);
  assert.equal((await actFrom.resolve(await fresh("owner"))).kind, "personal");
  assert.match(await actFrom.clearedNotice(ids.owner), /^Two was archived/);
  await actFrom.choose(await fresh("owner"), "s1");
  assert.equal(await actFrom.clearedNotice(ids.owner), null, "a new pick replaces the note");
});

test("no note when nothing was cleared: a valid choice saved meanwhile, or no choice at all (#147)", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("owner"), "s2");
  await actFrom.resolve(await fresh("owner"), { actFrom: "gone" });
  assert.equal((await store.readPrefs(ids.owner)).actFrom, "s2");
  assert.equal(await actFrom.clearedNotice(ids.owner), null);
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] });
  assert.equal(await actFrom.clearedNotice(ids.mgr), null, "demoted with no store picked");
  const p = { actFrom: { not: "a string" } };
  assert.equal(actFrom.dropChoice(p, "left"), true);
  assert.deepEqual(p, {}, "junk is deleted with no note");
});

test("the personal card count sums quantities, is 0 with no file, and follows saves (#147)", async () => {
  const { ids } = await seed();
  assert.equal(await actFrom.personalCardCount(ids.owner), 0);
  await store.writeCollection(ids.owner, { cards: [{ name: "A", quantity: 2 }, { name: "B", quantity: 3 }, { name: "C", quantity: 0 }] });
  assert.equal(await actFrom.personalCardCount(ids.owner), 5);
  assert.equal(await actFrom.personalCardCount(ids.owner), 5, "cached");
  await store.writeCollection(ids.owner, { cards: [] });
  assert.equal(await actFrom.personalCardCount(ids.owner), 0, "a save changes the stamp");
  assert.equal(actFrom.countCards(null), 0);
  assert.equal(actFrom.countCards([{ quantity: "4" }, null, { quantity: -1 }]), 4);
});
