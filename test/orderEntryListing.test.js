"use strict";
/* #432 rework (owner, 2026-11-07): a walk-in's Manapool update uses the
   connection of the account that owns the inventory, whoever is signed in,
   and acts only on a ticket saved in the caller's own inventory. Against a
   scratch dataDir via store.init() and a stubbed fetch: never the live data,
   never the real Manapool. The docOwner each call gets is worked out by
   orgs.resolveDocOwner(), exactly as the route's dispatcher does. */
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const orgs = lib("orgs");
const integrations = lib("integrations");
const oel = lib("orderEntryListing");

integrations.init({ manapool: { enabled: true, baseUrl: "https://mp.test/api/v1/", paths: { createListing: "seller/inventory/scryfall_id" } } },
  { log: () => {} });

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const PW = "correct-horse-1";
const OWNER_CREDS = { email: "owner@shop.test", accessToken: "owner-token" };

// Manapool: one listing of the bolt, 4 listed. Records who asked.
let listed, calls;
beforeEach(() => {
  listed = 4;
  calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    calls.push({ method: opts.method, email: opts.headers["X-ManaPool-Email"], body: opts.body ? JSON.parse(opts.body) : null });
    const send = (status, b) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (opts.method === "GET" && u.pathname.endsWith("/seller/inventory/scryfall_id/sf-bolt")) {
      return send(200, { inventory: { id: "i1", quantity: listed, price_cents: 250, product: { single: { scryfall_id: "sf-bolt" } } } });
    }
    if (opts.method === "POST") {
      const it = JSON.parse(opts.body)[0];
      listed = it.quantity;
      return send(200, { inventory: [{ id: "i1", quantity: listed, price_cents: 250,
        product: { single: { scryfall_id: it.scryfall_id, language_id: it.language_id, finish_id: it.finish_id, condition_id: it.condition_id } } }], skipped: [] });
    }
    return send(404, { message: "not found" });
  };
});

const CREATED = new Date().toISOString();
const bolt = { scryfallId: "sf-bolt", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM", name: "Lightning Bolt",
  quantity: 4, locationId: "loc1" };
const ticket = (id, qty, extra) => Object.assign({ id, source: "walkin", status: "open", createdAt: CREATED,
  lines: [{ kind: "card", set: "a25", collector: "141", lang: "en", finish: "nonfoil", condition: "NM", name: "Lightning Bolt", qty }] }, extra);
const doc = (...lists) => ({ cards: [Object.assign({ id: "c1" }, bolt)], pickLists: lists });

/* org1: owner (connected), staff1 on s1, staff2 on s2; bob is a personal account. */
async function seed(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-oel-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const mk = async (username, orgMeta) => {
    const u = await auth.createUser({ username, password: PW });
    if (orgMeta) await auth.setOrgMembership(u.id, orgMeta);
    return auth.findUserById(u.id);
  };
  const u = {
    owner: await mk("owner", { orgId: "org1", orgRole: "owner" }),
    staff1: await mk("staff1", { orgId: "org1", orgRole: "staff", storeIds: ["s1"] }),
    staff2: await mk("staff2", { orgId: "org1", orgRole: "staff", storeIds: ["s2"] }),
    bob: await mk("bob")
  };
  await store.writeOrgs({ orgs: [{ id: "org1", name: "Org", ownerId: u.owner.id }] });
  await store.writeStoreList({ stores: [
    { id: "s1", orgId: "org1", name: "One", archived: false },
    { id: "s2", orgId: "org1", name: "Two", archived: false }
  ] });
  if (!(opts && opts.ownerOffline)) await store.writePrefs(u.owner.id, { manapool: OWNER_CREDS });
  await store.writePrefs(u.staff1.id, {});   // Staff have no Manapool connection of their own
  await store.writeCollection("store:s1", doc(ticket("PICK-2026-0001", 1)));
  await store.writeCollection("store:s2", doc());
  await store.writeCollection(u.bob.id, doc(ticket("PICK-2026-0001", 2)));
  return u;
}
const ownerOf = (user, activeStoreId) => orgs.resolveDocOwner(Object.assign({}, user, { __activeStoreId: activeStoreId || null }));
const sync = async (user, event, id, activeStoreId) => oel.orderEntrySync(await ownerOf(user, activeStoreId), event, id, CREATED);
const refused = async (p, status) => { await assert.rejects(p, e => e.status === status); };

test("a Staff walk-in lowers the store's listing with the owner's Manapool connection; a cancel raises it once", async () => {
  const u = await seed();
  const out = await sync(u.staff1, "entered", "PICK-2026-0001");
  assert.equal(out.connected, true);
  assert.deepEqual([out.results[0].before, out.results[0].quantity], [4, 3]);
  assert.ok(calls.length && calls.every(c => c.email === OWNER_CREDS.email), "the owner's connection, never the staff login's");
  assert.equal(listed, 3);
  assert.equal(JSON.stringify(out).includes("owner-token"), false, "the key never goes back");

  const again = await sync(u.staff1, "entered", "PICK-2026-0001");
  assert.equal(again.results.length, 0, "entering it twice lowers it once");
  assert.equal(listed, 3);

  await refused(sync(u.staff1, "cancelled", "PICK-2026-0001"), 409);   // still saved as open: not cancelled
  await store.writeCollection("store:s1", doc(), 1);                    // the cancel is saved
  const back = await sync(u.staff1, "cancelled", "PICK-2026-0001");
  assert.deepEqual([back.results[0].change, listed], [1, 4]);
  assert.equal((await sync(u.staff1, "cancelled", "PICK-2026-0001")).results.length, 0, "raised once");
  assert.equal(listed, 4);
});

test("a non-member can't touch the store's listings: only tickets saved in their own inventory count", async () => {
  const u = await seed();
  // Staff on s2 asking for s1: the session resolves to s2, where there's no such ticket.
  await refused(sync(u.staff2, "entered", "PICK-2026-0001", "s1"), 404);
  // A personal account's own ticket of the same number lowers its OWN listings (bob has no connection: nothing sent).
  const own = await sync(u.bob, "entered", "PICK-2026-0001");
  assert.deepEqual([own.connected, own.store, own.reason], [false, false, "not-connected"]);
  await refused(sync(u.bob, "entered", "PICK-2026-0999"), 404);
  assert.equal(calls.length, 0);
  assert.equal(listed, 4);
  // Not a counter ticket: refused too.
  await store.writeCollection("store:s1", doc(ticket("PICK-2026-0002", 1, { source: "manapool" })), 1);
  await refused(sync(u.staff1, "entered", "PICK-2026-0002"), 404);
});

test("a store whose owner hasn't connected Manapool answers not-connected, and nothing is sent", async () => {
  const u = await seed({ ownerOffline: true });
  const out = await sync(u.staff1, "entered", "PICK-2026-0001");
  assert.deepEqual([out.connected, out.store, out.reason], [false, true, "not-connected"]);
  assert.equal(calls.length, 0);
});

test("a sale on the spot that emptied the stack still finds its Scryfall ID (the pull's put-back copy)", async () => {
  const u = await seed();
  const sold = ticket("PICK-2026-0003", 1, { status: "shipped" });
  sold.lines[0].pickedResult = { pulls: [{ qty: 1, back: { stack: Object.assign({}, bolt) } }] };
  await store.writeCollection("store:s1", { cards: [], pickLists: [sold] }, 1);
  const out = await sync(u.staff1, "entered", "PICK-2026-0003");
  assert.deepEqual([out.results[0].quantity, listed], [3, 3]);
});

test("a personal account uses its own connection", async () => {
  const u = await seed();
  await store.writePrefs(u.bob.id, { manapool: { email: "bob@home.test", accessToken: "bob-token" } });
  const out = await sync(u.bob, "entered", "PICK-2026-0001");
  assert.deepEqual([out.store, out.results[0].quantity], [false, 2]);
  assert.ok(calls.every(c => c.email === "bob@home.test"));
});
