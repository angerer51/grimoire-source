"use strict";
/* In-app notifications (#139): storage (dedupe, the 200-item bound, read
   pruning, the unread count, mark read / mark all), who gets told about
   each event (store fan-out by CURRENT rank, nobody about something they
   can't see, nothing for or from a disabled account), the open-time
   re-check, and the daily pass (one collection at a time, no repeat on a
   same-day re-run). Against a scratch dataDir via store.init(), never the
   live one. The routes themselves were exercised over HTTP on a scratch
   server; see the PR. */
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
const notifications = lib("notifications");
const notifyEvents = lib("notifyEvents");
const notifyJob = lib("notifyJob");
const friends = lib("friends");
// #140: a personal share counts only between friends.
const befriend = (x, y) => friends._update(doc => { friends._link(doc, x, y); });

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const PW = "correct-horse-1";

/* org1 (stores s1 "One", s2 "Two"): owner, mgr, mgr2, staff on s1, staff2
   on s2. org2 (store sx): xowner. Personal: solo, solo2. */
async function seed() {
  await notifyEvents.idle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-notify-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  notifications._resetCache();
  await store.writeOrgs({ orgs: [{ id: "org1", name: "Org" }, { id: "org2", name: "Other" }] });
  await store.writeStoreList({ stores: [
    { id: "s1", orgId: "org1", name: "One", archived: false },
    { id: "s2", orgId: "org1", name: "Two", archived: false },
    { id: "sx", orgId: "org2", name: "Foreign", archived: false }
  ] });
  const mk = async (username, orgMeta) => {
    const u = await auth.createUser({ username, password: PW });
    if (orgMeta) await auth.setOrgMembership(u.id, orgMeta, { by: u.id });
    return u.id;
  };
  const ids = {
    owner: await mk("owner", { orgId: "org1", orgRole: "owner" }),
    mgr: await mk("mgr", { orgId: "org1", orgRole: "manager" }),
    mgr2: await mk("mgr2", { orgId: "org1", orgRole: "manager" }),
    staff: await mk("staff", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }),
    staff2: await mk("staff2", { orgId: "org1", orgRole: "staff", storeIds: ["s2"] }),
    xowner: await mk("xowner", { orgId: "org2", orgRole: "owner" }),
    solo: await mk("solo", null),
    solo2: await mk("solo2", null)
  };
  await notifyEvents.idle();
  const fresh = async name => auth.findUserById(ids[name]);
  return { ids, fresh };
}

const listOf = async id => notifications.list(id);
const textsOf = async id => (await listOf(id)).map(x => x.text);
const kindsOf = async id => (await listOf(id)).map(x => x.kind);
async function stored(id) { return JSON.parse(fs.readFileSync(notifications._fileOf(id), "utf8")).items; }

function prop(o) {
  return Object.assign({ id: "p1", fromUserId: null, fromUsername: "", toUserId: null, toUsername: "",
    offering: [{ name: "A" }], requesting: [{ name: "B" }], status: "open", createdAt: "2026-10-10T00:00:00Z" }, o);
}

/* ======================= storage ======================= */

test("the same kind + ref updates one item instead of stacking, and comes back unread", async () => {
  const { ids } = await seed();
  const base = { kind: "trade-received", ref: "p1", link: "/trades.html?proposal=p1", scope: { t: "proposal", id: "p1" } };
  await notifications.notify([ids.solo], Object.assign({ text: "first" }, base));
  const [first] = await listOf(ids.solo);
  await notifications.markRead(ids.solo, first.id);
  assert.equal(await notifications.unreadCount(ids.solo), 0);
  const r = await notifications.notify([ids.solo], Object.assign({ text: "second" }, base));
  assert.equal(r[ids.solo], "updated");
  const all = await listOf(ids.solo);
  assert.equal(all.length, 1);
  assert.equal(all[0].text, "second");
  assert.equal(all[0].read, false);
  assert.equal(await notifications.unreadCount(ids.solo), 1);
  // A different kind with the same ref is a different notification.
  await notifications.notify([ids.solo], Object.assign({}, base, { kind: "trade-withdrawn", text: "gone" }));
  assert.equal((await listOf(ids.solo)).length, 2);
});

test("an account keeps at most 200; read ones go first, and read ones over 60 days old are pruned", async () => {
  const { ids } = await seed();
  const n = id => ({ kind: "price-alert", ref: "r" + id, text: "alert " + id, link: "/buy-list.html?watch=" + id, scope: null });
  for (let i = 0; i < 150; i++) await notifications.notify([ids.solo], n(i));
  await notifications.markAllRead(ids.solo);
  for (let i = 150; i < 260; i++) await notifications.notify([ids.solo], n(i));
  const items = await stored(ids.solo);
  assert.equal(items.length, notifications.MAX_ITEMS);
  // All 110 unread survive; only the newest 90 read ones are left.
  assert.equal(items.filter(x => !x.read).length, 110);
  assert.equal(items.filter(x => x.read).length, 90);
  assert.ok(!items.some(x => x.ref === "r0"), "the oldest read item went first");

  // A read item older than 60 days goes on the next write; an unread one that old stays.
  const old = new Date(Date.now() - 61 * 86400000).toISOString();
  const doc = { items: [
    { id: "a", kind: "price-alert", ref: "old-read", text: "x", at: old, read: true, readAt: old },
    { id: "b", kind: "price-alert", ref: "old-unread", text: "y", at: old, read: false, readAt: null }
  ] };
  fs.writeFileSync(notifications._fileOf(ids.solo2), JSON.stringify(doc));
  await notifications.notify([ids.solo2], n("new"));
  const refs = (await stored(ids.solo2)).map(x => x.ref);
  assert.ok(!refs.includes("old-read"));
  assert.ok(refs.includes("old-unread"));
});

test("unread count, mark one read, mark all read; the count matches the file", async () => {
  const { ids } = await seed();
  for (const r of ["a", "b", "c"]) {
    await notifications.notify([ids.solo], { kind: "ticket-reply", ref: r, text: "reply " + r, link: "/help.html?ticket=" + r + "#support", scope: null });
  }
  assert.equal(await notifications.unreadCount(ids.solo), 3);
  const [top] = await listOf(ids.solo);
  const item = await notifications.markRead(ids.solo, top.id);
  assert.equal(item.read, true);
  assert.equal(await notifications.unreadCount(ids.solo), 2);
  assert.equal(await notifications.markRead(ids.solo, "nope"), null);
  assert.equal(await notifications.markAllRead(ids.solo), 2);
  assert.equal(await notifications.unreadCount(ids.solo), 0);
  // A cold cache (a restart) reads the same number from the file.
  notifications._resetCache();
  assert.equal(await notifications.unreadCount(ids.solo), 0);
  assert.equal((await stored(ids.solo)).filter(x => !x.read).length, 0);
});

test("links are same-origin relative pages only; anything else is stored as no link", async () => {
  for (const ok of ["/trades.html?proposal=abc", "/help.html?ticket=x1#support", "/customers.html?tab=came-in&match=m-1", "/org.html"]) {
    assert.equal(notifications.safeLink(ok), ok);
  }
  for (const bad of ["https://evil.example/x.html", "//evil.example/x.html", "javascript:alert(1)", "/x.html\\@evil",
    "/../etc/passwd", "trades.html", "/trades.html?x=<script>", "/x.html?a=b c", null, 42]) {
    assert.equal(notifications.safeLink(bad), null, String(bad));
  }
  const { ids } = await seed();
  await notifications.notify([ids.solo], { kind: "ticket-reply", ref: "t", text: "x", link: "https://evil.example/", scope: null });
  assert.equal((await stored(ids.solo))[0].link, null);
});

test("text is plain, trimmed and bounded; the list hands out no link, scope or ref", async () => {
  const { ids } = await seed();
  await notifications.notify([ids.solo], { kind: "share-started", ref: "u", text: "<b>x</b>  " + "y".repeat(500), link: "/social.html?friend=x", scope: { t: "share" } });
  const [it] = await listOf(ids.solo);
  assert.ok(it.text.startsWith("<b>x</b> y"), "stored as given (the page escapes it), whitespace collapsed");
  assert.equal(it.text.length, 300);
  assert.deepEqual(Object.keys(it).sort(), ["at", "icon", "id", "kind", "read", "text"]);
  await assert.rejects(notifications.notify([ids.solo], { kind: "made-up", ref: "x", text: "x" }));
});

test("a group switched off in Settings gets nothing new; switching it back on resumes", async () => {
  const { ids } = await seed();
  await notifications.setGroup(ids.solo, "watch", false);
  const r = await notifications.notify([ids.solo], { kind: "price-alert", ref: "a", text: "x", scope: null });
  assert.equal(r[ids.solo], "muted");
  assert.equal((await listOf(ids.solo)).length, 0);
  const groups = await notifications.settings(ids.solo);
  assert.equal(groups.find(g => g.id === "watch").on, false);
  await notifications.setGroup(ids.solo, "watch", true);
  await notifications.notify([ids.solo], { kind: "price-alert", ref: "a", text: "x", scope: null });
  assert.equal((await listOf(ids.solo)).length, 1);
  await assert.rejects(notifications.setGroup(ids.solo, "nope", false), e => e.status === 400);
});

test("daily dedupe: a same-day re-run adds nothing, a standing alert stays read, a fresh crossing notifies again", async () => {
  const { ids } = await seed();
  const it = text => ({ kind: "price-alert", ref: "w1", text, link: "/buy-list.html?watch=w1", scope: null });
  assert.equal((await notifications.notify([ids.solo], it("$5"), { day: "2026-10-10", prevDay: "2026-10-09" }))[ids.solo], "new");
  assert.equal((await notifications.notify([ids.solo], it("$5"), { day: "2026-10-10", prevDay: "2026-10-09" }))[ids.solo], "same");
  await notifications.markAllRead(ids.solo);
  // Next day, still hit: stays read, no new unread.
  assert.equal((await notifications.notify([ids.solo], it("$4"), { day: "2026-10-11", prevDay: "2026-10-10" }))[ids.solo], "same");
  assert.equal(await notifications.unreadCount(ids.solo), 0);
  // Missed a day (the price went back over), then crossed again: news.
  assert.equal((await notifications.notify([ids.solo], it("$3"), { day: "2026-10-13", prevDay: "2026-10-12" }))[ids.solo], "updated");
  assert.equal(await notifications.unreadCount(ids.solo), 1);
  assert.equal((await listOf(ids.solo)).length, 1);
});

/* ======================= trades ======================= */

test("an offer to a store reaches its CURRENT Owners/Managers only: not Staff, not the sender, not a demoted or disabled ex-manager", async () => {
  const { ids } = await seed();
  await auth.setOrgMembership(ids.mgr2, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }, { by: ids.owner });
  await auth.setDisabled(ids.mgr, true);
  const p = prop({ id: "to-s1", fromUserId: ids.solo, fromUsername: "solo", toUserId: ids.owner, toUsername: "owner",
    toStoreId: "s1", toStoreName: "One", toStoreShown: true });
  await store.writeTradeProposals({ proposals: [p] });
  await notifyEvents.tradeProposed(p);
  assert.deepEqual(await textsOf(ids.owner), ["solo sent One a trade offer."]);
  for (const who of ["mgr", "mgr2", "staff", "staff2", "solo", "xowner"]) {
    assert.deepEqual((await kindsOf(ids[who])).filter(k => k.startsWith("trade")), [], who + " must hear nothing");
  }
});

test("a personal offer reaches just the person; a store-sent one names the store and the sender", async () => {
  const { ids } = await seed();
  const p = prop({ id: "pp", fromUserId: ids.mgr, fromUsername: "mgr", fromStoreId: "s2", fromStoreName: "Two",
    toUserId: ids.solo, toUsername: "solo" });
  await store.writeTradeProposals({ proposals: [p] });
  await notifyEvents.tradeProposed(p);
  assert.deepEqual(await textsOf(ids.solo), ["Two (mgr) sent you a trade offer."]);
  assert.deepEqual(await kindsOf(ids.owner), []);
});

test("an answer goes to the sending side, and never names a store or manager the sender couldn't see", async () => {
  const { ids, fresh } = await seed();
  await store.writeTradeProposals({ proposals: [prop({ id: "hidden", fromUserId: ids.solo, fromUsername: "solo",
    toUserId: ids.owner, toUsername: "owner", toStoreId: "s1", toStoreName: "One", toStoreShown: false })] });
  const mgr = await fresh("mgr");
  await store.updateTradeProposals(db => { trades.changeStatus(db.proposals[0], "declined", { id: mgr.id, username: "mgr" }, null); });
  await notifyEvents.idle();
  const [text] = await textsOf(ids.solo);
  assert.equal(text, "Your trade offer to owner was declined.");
  assert.ok(!/One|mgr/.test(text));
  // The manager who answered isn't told about their own answer; the store's other managers aren't the sending side.
  assert.deepEqual(await kindsOf(ids.mgr), []);
  assert.deepEqual(await kindsOf(ids.owner), []);
});

test("a status change that never reached disk notifies nobody", async () => {
  const { ids } = await seed();
  await store.writeTradeProposals({ proposals: [prop({ id: "x", fromUserId: ids.solo, fromUsername: "solo", toUserId: ids.solo2, toUsername: "solo2" })] });
  await store.updateTradeProposals(db => {
    trades.changeStatus(db.proposals[0], "accepted", { id: ids.solo2, username: "solo2" }, null);
    throw new Error("the save failed");
  }).catch(() => {});
  await notifyEvents.idle();
  assert.deepEqual(await kindsOf(ids.solo), []);
});

test("archiving a store withdraws its offers: the other side is told, with a reason that only names the store if they could see it", async () => {
  const { ids } = await seed();
  await store.writeTradeProposals({ proposals: [
    prop({ id: "from-s1", fromUserId: ids.mgr, fromUsername: "mgr", fromStoreId: "s1", fromStoreName: "One", toUserId: ids.solo, toUsername: "solo" }),
    prop({ id: "to-s1", fromUserId: ids.solo2, fromUsername: "solo2", toUserId: ids.mgr, toUsername: "mgr", toStoreId: "s1", toStoreName: "One", toStoreShown: false })
  ] });
  const archived = await orgs.archiveStore("s1", ids.owner);
  await actFrom.withdrawStoreProposals(archived, { id: ids.owner, username: "owner" });
  await notifyEvents.idle();
  assert.deepEqual(await textsOf(ids.solo), ["The trade offer from One (mgr) was withdrawn: One was archived."]);
  assert.deepEqual(await textsOf(ids.solo2), ["Your trade offer to mgr was withdrawn: the store was archived."]);
  // The archived store's managers aren't told about offers of a store they can no longer use.
  assert.ok(!(await kindsOf(ids.mgr)).some(k => k.startsWith("trade")));
});

/* ======================= sharing ======================= */

test("starting to share (Off -> Summary/Full) tells the person once; raising the level or re-adding doesn't stack", async () => {
  const { ids, fresh } = await seed();
  const solo = await fresh("solo");
  await notifyEvents.shareStarted(solo, "solo2", "off", "summary");
  assert.deepEqual(await textsOf(ids.solo2), ["solo started sharing their collection with you (a summary)."]);
  await notifyEvents.shareStarted(solo, "solo2", "summary", "full");
  await notifyEvents.shareStarted(solo, "solo2", "full", "off");
  assert.equal((await listOf(ids.solo2)).length, 1);
  await notifyEvents.shareStarted(solo, "solo2", "off", "full");
  const all = await listOf(ids.solo2);
  assert.equal(all.length, 1);
  assert.equal(all[0].text, "solo started sharing their collection with you.");
});

test("nothing is sent on behalf of a disabled account, or to one (#142)", async () => {
  const { ids, fresh } = await seed();
  await auth.setDisabled(ids.solo, true);
  await notifyEvents.shareStarted(await fresh("solo"), "solo2", "off", "full");
  assert.deepEqual(await kindsOf(ids.solo2), []);
  await auth.setDisabled(ids.solo, false);
  await auth.setDisabled(ids.solo2, true);
  await notifyEvents.shareStarted(await fresh("solo"), "solo2", "off", "full");
  assert.deepEqual(await kindsOf(ids.solo2), []);
});

test("a manager sharing from a store names the store, not their personal cards", async () => {
  const { ids, fresh } = await seed();
  await actFrom.choose(await fresh("mgr"), "s2");
  await notifyEvents.shareStarted(await fresh("mgr"), "solo", "off", "full");
  assert.deepEqual(await textsOf(ids.solo), ["mgr started sharing Two (Org) with you."]);
});

/* ======================= tickets ======================= */

test("a staff reply tells the reporter; their own reply, a non-staff reply or a disabled reporter gets nothing", async () => {
  const { ids } = await seed();
  const t = { id: "t1", createdBy: ids.solo, subject: "Help <me>" };
  await notifyEvents.ticketReplied(t, { id: ids.solo, username: "solo", role: "user" });
  await notifyEvents.ticketReplied(t, { id: ids.solo2, username: "solo2", role: "user" });
  assert.deepEqual(await kindsOf(ids.solo), []);
  await notifyEvents.ticketReplied(t, { id: "grimoire", username: "Grimoire", role: "admin" });
  assert.deepEqual(await textsOf(ids.solo), ["Grimoire replied to your ticket “Help <me>”."]);
  await auth.setDisabled(ids.solo2, true);
  await notifyEvents.ticketReplied({ id: "t2", createdBy: ids.solo2, subject: "x" }, { id: "m", username: "m", role: "moderator" });
  assert.deepEqual(await kindsOf(ids.solo2), []);
});

/* ======================= organizations ======================= */

test("added to an org or given a new role by someone else: told; doing it yourself or being removed: not", async () => {
  const { ids } = await seed();
  await auth.setOrgMembership(ids.solo, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }, { by: ids.owner });
  assert.deepEqual(await textsOf(ids.solo), ["You were added to Org as Staff."]);
  await auth.setOrgMembership(ids.solo, { orgId: "org1", orgRole: "manager" }, { by: ids.owner });
  assert.deepEqual(await kindsOf(ids.solo), ["org-role", "org-added"]);
  await auth.setOrgMembership(ids.solo, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }, { by: ids.solo });
  await auth.setOrgMembership(ids.solo, { orgId: null }, { by: ids.owner });
  assert.equal((await listOf(ids.solo)).length, 2);
});

test("archive/restore tells the members who could use that store, except the one who did it", async () => {
  const { ids } = await seed();
  await orgs.archiveStore("s1", ids.owner);
  for (const who of ["mgr", "mgr2", "staff"]) assert.deepEqual(await textsOf(ids[who]), ["One was archived."], who);
  for (const who of ["owner", "staff2", "xowner", "solo"]) assert.deepEqual(await kindsOf(ids[who]), [], who);
  await orgs.archiveStore("s1", ids.owner);   // already archived: no change, no repeat
  await orgs.restoreStore("s1", ids.owner);
  assert.deepEqual(await textsOf(ids.mgr), ["One was restored."], "one item per store, updated");
});

/* ======================= customer wantlists ======================= */

test("newRestocks picks new or bumped untold matches only", () => {
  const before = { restockMatches: [{ id: "a", ts: "1" }, { id: "b", ts: "1" }, { id: "c", ts: "1", toldAt: "x" }] };
  const after = { restockMatches: [{ id: "a", ts: "1" }, { id: "b", ts: "2" }, { id: "c", ts: "1", toldAt: "x" }, { id: "d", ts: "3" }, { id: "e", ts: "3", toldAt: "y" }] };
  assert.deepEqual(notifyEvents.newRestocks(before, after).map(m => m.id), ["b", "d"]);
  assert.deepEqual(notifyEvents.newRestocks(null, { restockMatches: null }), []);
  const many = { restockMatches: Array.from({ length: 50 }, (_, i) => ({ id: "m" + i, ts: "1" })) };
  assert.equal(notifyEvents.newRestocks(null, many).length, notifyEvents.RESTOCK_MAX_PER_SAVE);
});

test("a store's 'came in' reaches everyone who works in that store, never names the customer", async () => {
  const { ids } = await seed();
  await notifyEvents.restocksSaved("store:s1", [{ id: "m1", name: "Ragavan", available: 3, customerId: "c1" }]);
  for (const who of ["owner", "mgr", "mgr2", "staff"]) {
    assert.deepEqual(await textsOf(ids[who]), ["One: A card a customer wants came in: Ragavan (3 in stock)."], who);
  }
  for (const who of ["staff2", "xowner", "solo"]) assert.deepEqual(await kindsOf(ids[who]), [], who);
  await notifyEvents.restocksSaved(ids.solo, [{ id: "m2", name: "Bolt", available: 0 }]);
  assert.deepEqual(await textsOf(ids.solo), ["A card a customer wants came in: Bolt."]);
});

/* ======================= opening ======================= */

test("opening re-checks access now: lost rank, stopped sharing, a disabled sharer, someone else's ticket or store all refuse", async () => {
  const { ids, fresh } = await seed();
  await store.writeTradeProposals({ proposals: [prop({ id: "q", fromUserId: ids.solo, fromUsername: "solo",
    toUserId: ids.owner, toUsername: "owner", toStoreId: "s1", toStoreName: "One" })] });
  const sc = { t: "proposal", id: "q" };
  assert.equal((await notifyEvents.canOpen(await fresh("mgr"), sc)).ok, true);
  await auth.setOrgMembership(ids.mgr, { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }, { by: ids.owner });
  assert.equal((await notifyEvents.canOpen(await fresh("mgr"), sc)).ok, false, "demoted: the offer isn't theirs to see");
  assert.equal((await notifyEvents.canOpen(await fresh("xowner"), sc)).ok, false);

  await store.updatePrefs(ids.solo, p => { p.friends = [{ username: "solo2", share: "summary" }]; });
  const share = { t: "share", owner: ids.solo, min: "summary" };
  assert.equal((await notifyEvents.canOpen(await fresh("solo2"), share)).ok, false, "not friends: the entry counts for nothing (#140)");
  await befriend(ids.solo, ids.solo2);
  assert.equal((await notifyEvents.canOpen(await fresh("solo2"), share)).ok, true);
  assert.equal((await notifyEvents.canOpen(await fresh("solo2"), Object.assign({}, share, { min: "full" }))).ok, false);
  await auth.setDisabled(ids.solo, true);
  assert.equal((await notifyEvents.canOpen(await fresh("solo2"), share)).ok, false, "a disabled account shares nothing");
  await auth.setDisabled(ids.solo, false);
  await store.updatePrefs(ids.solo, p => { p.friends = [{ username: "solo2", share: "off" }]; });
  assert.equal((await notifyEvents.canOpen(await fresh("solo2"), share)).ok, false);

  await store.writeTickets({ tickets: [{ id: "t1", createdBy: ids.solo, subject: "x", messages: [] }] });
  assert.equal((await notifyEvents.canOpen(await fresh("solo"), { t: "ticket", id: "t1" })).ok, true);
  assert.equal((await notifyEvents.canOpen(await fresh("solo2"), { t: "ticket", id: "t1" })).ok, false);

  const inv = { t: "inv", key: "store:s2" };
  assert.deepEqual(await notifyEvents.canOpen(await fresh("owner"), inv), { ok: true, storeId: "s2" });
  assert.equal((await notifyEvents.canOpen(await fresh("staff"), inv)).ok, false);
  assert.equal((await notifyEvents.canOpen(await fresh("solo2"), { t: "inv", key: ids.solo })).ok, false);
  assert.equal((await notifyEvents.canOpen(await fresh("solo"), { t: "org", orgId: "org1" })).ok, false);
  assert.equal((await notifyEvents.canOpen(await fresh("staff"), { t: "org", orgId: "org1" })).ok, true);
  assert.equal((await notifyEvents.canOpen(await fresh("solo"), null)).ok, false);
});

/* ======================= the daily pass ======================= */

const card = (oracleId, name, price, quantity) => ({ id: oracleId + name, oracleId, name, set: "set", collector: "1", lang: "en",
  finish: "nonfoil", price, quantity });
const watch = (id, oracleId, name, extra) => Object.assign({ id, oracleId, name, set: "s-" + id, collector: "1", lang: "en", finish: "nonfoil" }, extra);
async function writeInv(key, state) {
  await store.writeCollection(key, Object.assign({ cards: [], locations: [] }, state), -1);
}

/* Counts collection reads in flight, so the test can prove the pass never
   holds two at once. */
function countReads() {
  const real = store.readCollection;
  const c = { inFlight: 0, max: 0, total: 0 };
  store.readCollection = async key => {
    c.inFlight++; c.total++; c.max = Math.max(c.max, c.inFlight);
    try { await new Promise(r => setTimeout(r, 2)); return await real(key); } finally { c.inFlight--; }
  };
  c.restore = () => { store.readCollection = real; };
  return c;
}

test("the daily pass reads one collection at a time, tells a store's readers about a hit target, and a same-day re-run adds nothing", async () => {
  const { ids } = await seed();
  await writeInv(ids.solo, { watchList: [watch("w1", "o1", "Bolt", { target: 5, targetDir: "below" }), watch("w2", "o2", "Opt", { target: 1 })] });
  await writeInv("store:s1", { watchList: [watch("w3", "o3", "Sol Ring", { target: 2, targetDir: "above" })] });
  const prices = { "s-w1": 4, "s-w2": 3, "s-w3": 2.5 };
  const priceNow = async items => items.map(x => prices[x.set] == null ? null : prices[x.set]);
  const reads = countReads();
  try {
    const r = await notifyJob.runDaily({ day: "2026-10-10", prevDay: "2026-10-09", priceNow });
    assert.equal(reads.max, 1, "never two collections in memory at once");
    assert.ok(r.collectionsRead >= 2);
    assert.equal(r.priceAlerts, 1 + 4);
  } finally { reads.restore(); }
  assert.deepEqual(await textsOf(ids.solo), ["Bolt is $4.00, your target was ≤ $5.00."]);
  for (const who of ["owner", "mgr", "mgr2", "staff"]) {
    assert.deepEqual(await textsOf(ids[who]), ["One: Sol Ring is $2.50, your target was ≥ $2.00."], who);
  }
  assert.deepEqual(await kindsOf(ids.staff2), []);
  // A restart re-running today's pass adds nothing.
  const again = await notifyJob.runDaily({ day: "2026-10-10", prevDay: "2026-10-09", priceNow });
  assert.equal(again.priceAlerts, 0);
  assert.equal((await listOf(ids.solo)).length, 1);
  // Tomorrow, read and still hit: still nothing new.
  await notifications.markAllRead(ids.solo);
  await notifyJob.runDaily({ day: "2026-10-11", prevDay: "2026-10-10", priceNow });
  assert.equal(await notifications.unreadCount(ids.solo), 0);
});

test("a friend has a watched card: only a PERSONAL Full share tells you; Summary, server-wide, Off and disabled sharers never do", async () => {
  const { ids } = await seed();
  // The watcher (solo) watches one card each sharer below owns.
  await writeInv(ids.solo, { watchList: [watch("wf", "o-full", "Full Card"), watch("ws", "o-store", "Store Card"),
    watch("wm", "o-sum", "Summary Card"), watch("wd", "o-def", "Default Card"), watch("wx", "o-dis", "Disabled Card")] });
  // solo2: personal Full, owns o-full -> told.
  await writeInv(ids.solo2, { cards: [card("o-full", "Full Card", 1, 1)] });
  await store.updatePrefs(ids.solo2, p => { p.friends = [{ username: "solo", share: "full" }]; });
  // mgr: personal Full from store s2, owns o-store -> told, naming the store.
  await writeInv("store:s2", { cards: [card("o-store", "Store Card", 1, 1)] });
  await actFrom.choose(await auth.findUserById(ids.mgr), "s2");
  await store.updatePrefs(ids.mgr, p => { p.friends = [{ username: "solo", share: "full" }]; });
  // owner: personal Summary (from s1), even with "everyone else" at Full; owns o-sum (its most valuable card) -> not told.
  await writeInv("store:s1", { cards: [card("o-sum", "Summary Card", 999, 1)] });
  await actFrom.choose(await auth.findUserById(ids.owner), "s1");
  await store.updatePrefs(ids.owner, p => { p.friends = [{ username: "solo", share: "summary" }]; p.defaultShare = "full"; });
  // xowner: no personal share, "everyone else on this server" at Full; owns o-def -> not told.
  await writeInv("store:sx", { cards: [card("o-def", "Default Card", 1, 1)] });
  await store.updatePrefs(ids.xowner, p => { p.friends = []; p.defaultShare = "full"; });
  // staff2: disabled, personal Full, owns o-dis -> not told.
  await writeInv(ids.staff2, { cards: [card("o-dis", "Disabled Card", 1, 1)] });
  await auth.setDisabled(ids.staff2, true);
  await store.updatePrefs(ids.staff2, p => { p.friends = [{ username: "solo", share: "full" }]; });
  for (const who of ["solo2", "mgr", "owner", "staff2"]) await befriend(ids[who], ids.solo);
  // mgr2: personal Full, owns o-nf, but NOT a friend (#140) -> not told.
  await writeInv(ids.solo, { watchList: [watch("wf", "o-full", "Full Card"), watch("ws", "o-store", "Store Card"),
    watch("wm", "o-sum", "Summary Card"), watch("wd", "o-def", "Default Card"), watch("wx", "o-dis", "Disabled Card"),
    watch("wn", "o-nf", "Not Friend Card")] });
  await writeInv(ids.mgr2, { cards: [card("o-nf", "Not Friend Card", 1, 1)] });
  await store.updatePrefs(ids.mgr2, p => { p.friends = [{ username: "solo", share: "full" }]; });

  const reads = countReads();
  let r;
  try { r = await notifyJob.runDaily({ day: "2026-10-10", prevDay: null, priceNow: async items => items.map(() => null) }); }
  finally { reads.restore(); }
  assert.equal(reads.max, 1);
  assert.equal(r.friendHas, 2);
  const mine = await stored(ids.solo);
  const byText = Object.fromEntries(mine.map(x => [x.text, x]));
  assert.deepEqual(Object.keys(byText).sort(), [
    "mgr (Two) has Store Card, a card on your watch list.",
    "solo2 has Full Card, a card on your watch list."
  ]);
  // Full always links to the Buy List's trade flow.
  assert.equal(byText["solo2 has Full Card, a card on your watch list."].link, "/buy-list.html?watch=wf&friend=solo2");
  assert.equal(byText["mgr (Two) has Store Card, a card on your watch list."].link, "/buy-list.html?watch=ws&friend=mgr");
  // Nobody else hears about solo's watch list.
  for (const who of ["solo2", "mgr", "owner", "xowner"]) assert.ok(!(await kindsOf(ids[who])).includes("friend-has"), who);
  // Same day again: nothing new.
  assert.equal((await notifyJob.runDaily({ day: "2026-10-10", prevDay: null, priceNow: async items => items.map(() => null) })).friendHas, 0);

  // Opening re-checks the same rule: personal and Full, now.
  const scope = byText["solo2 has Full Card, a card on your watch list."].scope;
  const solo = await auth.findUserById(ids.solo);
  assert.equal((await notifyEvents.canOpen(solo, scope)).ok, true);
  await store.updatePrefs(ids.solo2, p => { p.friends = [{ username: "solo", share: "summary" }]; });
  assert.equal((await notifyEvents.canOpen(solo, scope)).ok, false, "dropped to Summary");
  await store.updatePrefs(ids.solo2, p => { p.friends = []; p.defaultShare = "full"; });
  assert.equal((await notifyEvents.canOpen(solo, scope)).ok, false, "only a server-wide share left");
  await store.updatePrefs(ids.solo2, p => { p.friends = [{ username: "solo", share: "off" }]; p.defaultShare = "off"; });
  assert.equal((await notifyEvents.canOpen(solo, scope)).ok, false, "stopped sharing");
});

test("personalLevel ignores the server-wide share; levelFor doesn't; both need a friendship (#140)", () => {
  const sharing = lib("sharing");
  const prefs = { friends: [{ username: "a", share: "summary" }, { username: "b", share: "full" }], defaultShare: "full" };
  assert.equal(sharing.personalLevel(prefs, "a", true), "summary");
  assert.equal(sharing.personalLevel(prefs, "b", true), "full");
  assert.equal(sharing.personalLevel(prefs, "c", true), "off");
  assert.equal(sharing.levelFor(prefs, "c", true), "full");
  assert.equal(sharing.personalLevel(null, "a", true), "off");
  // Not friends: a personal entry is nothing personal.
  assert.equal(sharing.personalLevel(prefs, "b", false), "off");
  assert.equal(sharing.personalLevel(prefs, "b"), "off");
});

test("a disabled watcher is skipped, and one account gets at most NEW_CAP new items a pass", async () => {
  const { ids } = await seed();
  const many = Array.from({ length: 30 }, (_, i) => watch("w" + i, "o" + i, "Card " + i, { target: 100 }));
  await writeInv(ids.solo, { watchList: many });
  await writeInv(ids.solo2, { watchList: [watch("x", "ox", "X", { target: 100 })] });
  await auth.setDisabled(ids.solo2, true);
  await notifyJob.runDaily({ day: "2026-10-10", prevDay: null, priceNow: async items => items.map(() => 1) });
  assert.equal((await listOf(ids.solo)).length, notifyJob.NEW_CAP);
  assert.deepEqual(await kindsOf(ids.solo2), []);
});

test("an already-read standing alert stays read on the next passes, even when 20+ new hits come before it", async () => {
  const { ids } = await seed();
  // 25 targets that only start hitting on day 2, then the standing one, last in iteration order.
  const fresh = Array.from({ length: 25 }, (_, i) => watch("n" + i, "on" + i, "New " + i, { target: 10 }));
  const standing = watch("st", "ost", "Standing", { target: 10 });
  await writeInv(ids.solo, { watchList: fresh.concat([standing]) });
  const priceDay1 = async items => items.map(x => x.set === "s-st" ? 5 : null);
  const priceAll = async items => items.map(() => 5);

  await notifyJob.runDaily({ day: "2026-10-09", prevDay: null, priceNow: priceDay1 });
  assert.deepEqual(await textsOf(ids.solo), ["Standing is $5.00, your target was ≤ $10.00."]);
  await notifications.markAllRead(ids.solo);

  const r2 = await notifyJob.runDaily({ day: "2026-10-10", prevDay: "2026-10-09", priceNow: priceAll });
  assert.equal(r2.priceAlerts, notifyJob.NEW_CAP, "20 new, the rest capped");
  const st2 = (await stored(ids.solo)).find(x => x.ref.includes(":st:"));
  assert.equal(st2.read, true, "still read");
  assert.equal(st2.seenDay, "2026-10-10", "stamped although the account was at its cap");
  assert.equal(await notifications.unreadCount(ids.solo), notifyJob.NEW_CAP);

  await notifyJob.runDaily({ day: "2026-10-11", prevDay: "2026-10-10", priceNow: priceAll });
  const st3 = (await stored(ids.solo)).find(x => x.ref.includes(":st:"));
  assert.equal(st3.read, true, "the next pass doesn't take it for a fresh crossing");
});

/* #369: SELLING FAST on a watched printing. fastFor(map) answers fastNow
   from { set: true/false/null }; anything unlisted is null. */
const fastFor = map => async items => items.map(x => map[x.set] === undefined ? null : map[x.set]);
const noPrice = async items => items.map(() => null);

test("selling fast: told when a watched printing starts, not while it stays hot; too early is silent; once per printing", async () => {
  const { ids } = await seed();
  // Opt is watched twice (non-foil and foil): one printing, one notification.
  await writeInv(ids.solo, { watchList: [watch("w1", "o1", "Bolt"), watch("w2", "o2", "Opt"),
    watch("w2f", "o2", "Opt", { set: "s-w2", finish: "foil" }), watch("w3", "o3", "Calm")] });
  const pass = (day, prevDay, map) => notifyJob.runDaily({ day, prevDay, priceNow: noPrice, fastNow: fastFor(map) });

  // Paces "too early" (null) and plain "not fast": nothing.
  assert.equal((await pass("2026-10-30", null, { "s-w1": null, "s-w2": null, "s-w3": false })).fastAlerts, 0);
  assert.deepEqual(await kindsOf(ids.solo), []);

  const r = await pass("2026-10-31", "2026-10-30", { "s-w1": true, "s-w2": true, "s-w3": false });
  assert.equal(r.fastAlerts, 2);
  assert.deepEqual((await textsOf(ids.solo)).sort(), [
    "Bolt (S-W1 #1) is SELLING FAST on Manapool: sales in the last 7 days are well above its usual pace.",
    "Opt (S-W2 #1) is SELLING FAST on Manapool: sales in the last 7 days are well above its usual pace."
  ]);
  const bolt = (await stored(ids.solo)).find(x => x.text.startsWith("Bolt"));
  assert.equal(bolt.kind, "watch-fast");
  assert.equal(bolt.link, "/buy-list.html?watch=w1");
  assert.deepEqual(bolt.scope, { t: "inv", key: ids.solo });

  // A restart re-running the day adds nothing; staying hot (read) adds nothing.
  assert.equal((await pass("2026-10-31", "2026-10-30", { "s-w1": true, "s-w2": true })).fastAlerts, 0);
  await notifications.markAllRead(ids.solo);
  assert.equal((await pass("2026-11-01", "2026-10-31", { "s-w1": true, "s-w2": true })).fastAlerts, 0);
  assert.equal(await notifications.unreadCount(ids.solo), 0);
  // Bolt flickers across the line (off a pass, on, off, on): the cool-off
  // keeps it a standing alert, still read. Opt stayed hot: still read.
  assert.equal((await pass("2026-11-02", "2026-11-01", { "s-w1": false, "s-w2": true })).fastAlerts, 0);
  assert.equal((await pass("2026-11-03", "2026-11-02", { "s-w1": true, "s-w2": true })).fastAlerts, 0);
  assert.equal((await pass("2026-11-04", "2026-11-03", { "s-w1": false, "s-w2": true })).fastAlerts, 0);
  assert.equal((await pass("2026-11-05", "2026-11-04", { "s-w1": true, "s-w2": true })).fastAlerts, 0);
  assert.equal(await notifications.unreadCount(ids.solo), 0);
  assert.equal((await stored(ids.solo)).find(x => x.text.startsWith("Bolt")).seenDay, "2026-11-05", "re-stamped");
  // Off for 6 passes, back on the 7th day after it was last seen: still inside the cool-off.
  let prev = "2026-11-05";
  for (const d of ["06", "07", "08", "09", "10", "11"]) {
    await pass("2026-11-" + d, prev, { "s-w1": false, "s-w2": true });
    prev = "2026-11-" + d;
  }
  assert.equal(notifyJob.FAST_COOLOFF_DAYS, 7);
  assert.equal((await pass("2026-11-12", prev, { "s-w1": true, "s-w2": true })).fastAlerts, 0);
  assert.equal(await notifications.unreadCount(ids.solo), 0);
  assert.equal((await stored(ids.solo)).filter(x => x.kind === "watch-fast").length, 2, "never stacked");
});

test("selling fast: an alert comes back once the printing has been off for more than the cool-off", async () => {
  const { ids } = await seed();
  await writeInv(ids.solo, { watchList: [watch("w1", "o1", "Bolt")] });
  const pass = (day, prevDay, hot) => notifyJob.runDaily({ day, prevDay, priceNow: noPrice, fastNow: fastFor({ "s-w1": hot }) });
  assert.equal((await pass("2026-11-01", null, true)).fastAlerts, 1);
  await notifications.markAllRead(ids.solo);
  // Eight quiet passes (11-02 .. 11-09), then hot again on 11-10: 9 days since last seen.
  let prev = "2026-11-01";
  for (let d = 2; d <= 9; d++) {
    const day = "2026-11-" + String(d).padStart(2, "0");
    assert.equal((await pass(day, prev, false)).fastAlerts, 0);
    prev = day;
  }
  assert.equal((await pass("2026-11-10", prev, true)).fastAlerts, 1, "told again");
  const items = await stored(ids.solo);
  assert.equal(items.length, 1, "updated in place, not stacked");
  assert.equal(items[0].read, false);
  assert.equal(items[0].seenDay, "2026-11-10");
  // A price-target alert has no cool-off: one cool pass is enough for a fresh crossing.
  const item = { kind: "price-alert", ref: "r", text: "t", link: "/buy-list.html", scope: { t: "inv", key: ids.solo } };
  await notifications.notify([ids.solo], item, { day: "2026-11-01" });
  await notifications.markAllRead(ids.solo);
  assert.equal((await notifications.notify([ids.solo], item, { day: "2026-11-03", prevDay: "2026-11-02" }))[ids.solo], "updated");
});

test("selling fast: a store's readers are told with the store's name; switching the group off mutes it, not price targets", async () => {
  const { ids } = await seed();
  await writeInv("store:s1", { watchList: [watch("w9", "o9", "Sol Ring", { target: 5 })] });
  await notifications.setGroup(ids.mgr, "watchFast", false);
  const r = await notifyJob.runDaily({ day: "2026-10-31", prevDay: null, priceNow: async items => items.map(() => 4), fastNow: fastFor({ "s-w9": true }) });
  assert.equal(r.fastAlerts, 3, "owner, mgr2, staff");
  assert.equal(r.priceAlerts, 4);
  for (const who of ["owner", "mgr2", "staff"]) {
    assert.deepEqual((await kindsOf(ids[who])).sort(), ["price-alert", "watch-fast"], who);
    assert.ok((await textsOf(ids[who])).includes("One: Sol Ring (S-W9 #1) is SELLING FAST on Manapool: sales in the last 7 days are well above its usual pace."), who);
  }
  assert.deepEqual(await kindsOf(ids.mgr), ["price-alert"], "watchFast switched off");
  assert.deepEqual(await kindsOf(ids.staff2), []);
  // Settings lists the new group.
  assert.ok((await notifications.settings(ids.solo)).some(g => g.id === "watchFast" && g.on));
  // No fastNow (or no watch items with a printing): the pass works as before.
  assert.equal((await notifyJob.runDaily({ day: "2026-11-01", prevDay: "2026-10-31", priceNow: noPrice })).fastAlerts, 0);
});

test("notify with noNew adds nothing new and re-opens nothing, but stamps a standing item", async () => {
  const { ids } = await seed();
  const item = ref => ({ kind: "price-alert", ref, text: "t " + ref, link: "/buy-list.html", scope: { t: "inv", key: ids.solo } });
  await notifications.notify([ids.solo], item("a"), { day: "d1" });
  await notifications.notify([ids.solo], item("b"), { day: "d0" });
  await notifications.markAllRead(ids.solo);
  const capped = { day: "d2", prevDay: "d1", noNew: true };
  assert.equal((await notifications.notify([ids.solo], item("a"), capped))[ids.solo], "same", "standing: stamped");
  assert.equal((await notifications.notify([ids.solo], item("b"), capped))[ids.solo], "capped", "a fresh crossing waits");
  assert.equal((await notifications.notify([ids.solo], item("c"), capped))[ids.solo], "capped", "nothing new");
  const items = await stored(ids.solo);
  assert.equal(items.length, 2);
  assert.equal(items.find(x => x.ref === "a").seenDay, "d2");
  assert.equal(items.find(x => x.ref === "b").seenDay, "d0");
  assert.equal(await notifications.unreadCount(ids.solo), 0);
});

test("opening names the store to switch to but never switches the session itself", async () => {
  const { ids, fresh } = await seed();
  const realSwitch = auth.setActiveStore;
  let switched = 0;
  auth.setActiveStore = async () => { switched++; };
  try {
    const item = { link: "/buy-list.html?watch=w1", scope: { t: "inv", key: "store:s2" } };
    assert.deepEqual(await notifyEvents.openTarget(await fresh("owner"), item, "store:s1"),
      { ok: true, link: "/buy-list.html?watch=w1", switchTo: { id: "s2", name: "Two" }, from: "s1" });
    assert.deepEqual(await notifyEvents.openTarget(await fresh("owner"), item, "store:s2"),
      { ok: true, link: "/buy-list.html?watch=w1", switchTo: null, from: null }, "already there: nothing to switch");
    assert.deepEqual(await notifyEvents.openTarget(await fresh("staff"), item, "store:s1"), { ok: false }, "no access to s2");
    assert.deepEqual(await notifyEvents.openTarget(await fresh("owner"), Object.assign({}, item, { link: "https://evil.example/" }), "store:s1"),
      { ok: false }, "no safe link");
    const personal = { link: "/trades.html", scope: { t: "inv", key: ids.solo } };
    assert.deepEqual(await notifyEvents.openTarget(await fresh("solo"), personal, ids.solo),
      { ok: true, link: "/trades.html", switchTo: null, from: null });
    assert.equal(switched, 0, "the session's store is only ever switched by the page, after it saved");
  } finally { auth.setActiveStore = realSwitch; }
});
