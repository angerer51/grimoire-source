"use strict";
/* One-time backfill of pick lists' readable order numbers (#197),
   server/lib/orderLabels.js. Against a scratch dataDir via store.init(),
   never the live one. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const orderLabels = lib("orderLabels");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const UUID = n => "0000000" + n + "-aaaa-bbbb-cccc-dddddddddddd";
const pick = (id, orderId, orderLabel, extra) => Object.assign({ id, source: orderId ? "manapool" : "manual",
  orderId: orderId || null, orderLabel: orderLabel === undefined ? null : orderLabel, status: "shipped", lines: [] }, extra);

/* alice: one list with no label, one with the UUID as its label, one
   already right, one manual (no order), one whose order is in no cache.
   bob: nothing to fix. Store s1: two lists whose orders are in bob's
   cache, not alice's (orders are cached per signed-in user, not per
   store). */
async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-orderlabels-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const alice = await auth.createUser({ username: "alice", password: "correct-horse-1" });
  const bob = await auth.createUser({ username: "bob", password: "correct-horse-1" });
  await store.writeStoreList({ stores: [{ id: "s1", orgId: "org1", name: "One", archived: false }] });
  await store.writeOrders(alice.id, { orders: [
    { id: UUID(1), label: "584368-1" }, { id: UUID(2), label: "584368-2" }, { id: UUID(3), label: "584368-3" }] });
  await store.writeOrders(bob.id, { orders: [
    { id: UUID(5), label: "700-5" }, { id: UUID(6), label: "700-6" }, { id: UUID(7), label: "" }] });
  await store.writeCollection(alice.id, { cards: [{ id: "c1" }], pickLists: [
    pick("PICK-2026-0001", UUID(1)),
    pick("PICK-2026-0002", UUID(2), UUID(2)),
    pick("PICK-2026-0003", UUID(3), "584368-3"),
    pick("PICK-2026-0004", null),
    pick("PICK-2026-0009", UUID(9))] });
  await store.writeCollection(bob.id, { cards: [], pickLists: [pick("PICK-2026-0001", UUID(5), "700-5")] });
  await store.writeCollection("store:s1", { cards: [], pickLists: [
    pick("PICK-2026-0001", UUID(5), ""), pick("PICK-2026-0002", UUID(6)), pick("PICK-2026-0003", UUID(7))] });
  return { alice, bob };
}
const lists = async key => (await store.readCollection(key)).state.pickLists;
const labelsOf = async key => (await lists(key)).map(p => p.orderLabel);

test("fills the readable number onto lists missing it or holding the UUID; leaves everything else alone", async () => {
  const { alice, bob } = await seed();
  const bobRev = (await store.readCollection(bob.id)).rev;
  const out = await orderLabels.backfillOrderLabelsOnce();
  assert.deepEqual(await labelsOf(alice.id), ["584368-1", "584368-2", "584368-3", null, null]);
  // The store's lists come from bob's cache; an order cached with no label stays unresolved.
  assert.deepEqual(await labelsOf("store:s1"), ["700-5", "700-6", null]);
  // Ids and order ids are untouched; other fields too.
  const a = await lists(alice.id);
  assert.deepEqual(a.map(p => [p.id, p.orderId]), [
    ["PICK-2026-0001", UUID(1)], ["PICK-2026-0002", UUID(2)], ["PICK-2026-0003", UUID(3)],
    ["PICK-2026-0004", null], ["PICK-2026-0009", UUID(9)]]);
  assert.equal((await store.readCollection(alice.id)).state.cards.length, 1);
  // Nothing to fix: not written at all.
  assert.equal((await store.readCollection(bob.id)).rev, bobRev);
  assert.deepEqual(out, { owners: 2, filled: 4, unresolved: 2, skipped: 0 });
});

test("runs once per data directory; a second run (or call) changes nothing", async () => {
  const { alice } = await seed();
  await orderLabels.backfillOrderLabelsOnce();
  const rev = (await store.readCollection(alice.id)).rev;
  assert.equal(await orderLabels.backfillOrderLabelsOnce(), null);
  assert.ok((await store.readMigrations())[orderLabels.MARKER]);
  // Even run again by hand, it's idempotent: nothing left it can fill.
  const again = await orderLabels.backfillOrderLabels();
  assert.equal(again.filled, 0);
  assert.equal((await store.readCollection(alice.id)).rev, rev);
});

test("a collection it can't read or save is skipped and the marker isn't set, so the next boot retries", async () => {
  const { alice } = await seed();
  const real = store.writeCollection;
  store.writeCollection = async (key, ...rest) => {
    if (key === "store:s1") throw new Error("disk on fire");
    return real(key, ...rest);
  };
  let out;
  try { out = await orderLabels.backfillOrderLabelsOnce(); } finally { store.writeCollection = real; }
  assert.equal(out.skipped, 1);
  assert.deepEqual(await labelsOf(alice.id), ["584368-1", "584368-2", "584368-3", null, null]);
  assert.equal((await store.readMigrations())[orderLabels.MARKER], undefined);
  const next = await orderLabels.backfillOrderLabelsOnce();
  assert.deepEqual([next.owners, next.filled, next.skipped], [1, 2, 0]);
  assert.deepEqual(await labelsOf("store:s1"), ["700-5", "700-6", null]);
});

test("a browser save landing mid-run is merged, not lost, and keeps the label", async () => {
  const { alice } = await seed();
  const before = await store.readCollection(alice.id);
  // The browser's save between the backfill's read and its write.
  const realRead = store.readCollection;
  store.readCollection = async key => {
    const doc = await realRead(key);
    if (key === alice.id) {
      store.readCollection = realRead;
      const mine = JSON.parse(JSON.stringify(doc.state));
      mine.cards.push({ id: "c2" });
      await store.writeCollection(alice.id, mine, doc.rev);
    }
    return doc;
  };
  try { await orderLabels.backfillOrderLabelsOnce(); } finally { store.readCollection = realRead; }
  const after = await store.readCollection(alice.id);
  assert.equal(after.rev, before.rev + 2);
  assert.deepEqual(after.state.cards.map(c => c.id), ["c1", "c2"]);
  assert.equal(after.state.pickLists[0].orderLabel, "584368-1");
  // And a tab still on the old rev saving afterwards merges too, keeping the label.
  const stale = JSON.parse(JSON.stringify(before.state));
  stale.pickLists[3].status = "picked";
  stale.cards.push({ id: "c2" });
  await store.writeCollection(alice.id, stale, before.rev + 1);
  const final = await store.readCollection(alice.id);
  assert.equal(final.state.pickLists[0].orderLabel, "584368-1");
  assert.equal(final.state.pickLists[3].status, "picked");
});

test("no orders folder at all: nothing filled, nothing breaks, marked done", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-orderlabels-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const u = await auth.createUser({ username: "carol", password: "correct-horse-1" });
  await store.writeCollection(u.id, { cards: [], pickLists: [pick("PICK-2026-0001", UUID(1))] });
  const out = await orderLabels.backfillOrderLabelsOnce();
  assert.deepEqual(out, { owners: 0, filled: 0, unresolved: 1, skipped: 0 });
  assert.ok((await store.readMigrations())[orderLabels.MARKER]);
});
