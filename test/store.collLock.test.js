"use strict";
/* #186: one lock and one in-memory history per collection folder.

   A personal account's folder answers to "user:<id>", "<id>" and the
   number <id> (store.ownerDir). Create organization's move locked
   "coll:user:<id>" while that account's saves locked "coll:<id>", so a save
   arriving at that moment wasn't kept in order with the move and could
   write into the folder being renamed away. Now every collection lock and
   in-memory map uses store.canonicalOwner(), the move takes the same locks
   a save (and an audit append) does, and the personal key's in-memory save
   history is dropped once its files have moved. Real file I/O against a
   scratch dataDir, never the live one. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "server", "lib", "store"));
const audit = require(path.join(__dirname, "..", "server", "lib", "audit"));

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

let n = 0;
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-colllock-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  audit.init({});
  n++;
  return { user: "u" + n + "-" + Date.now(), storeId: "s" + n + "-" + Date.now() }; // in-memory maps are per process
}
const doc = cards => ({ cards: cards.map(c => Object.assign({ name: c.id }, c)), locations: [] });
const qty = (state, id) => { const c = state && state.cards.find(x => x.id === id); return c ? c.quantity : undefined; };
const personalFile = u => path.join(store.p("users", u), "current.json");

test("every spelling of a personal account is one lock key and one owner", () => {
  assert.equal(store.canonicalOwner("user:42"), "42");
  assert.equal(store.canonicalOwner("42"), "42");
  assert.equal(store.canonicalOwner(42), "42");
  assert.equal(store.canonicalOwner("store:abc"), "store:abc");
  assert.equal(store.collLock("user:42"), store.collLock(42));
  assert.equal(store.collLock("42"), "coll:42");
  assert.notEqual(store.collLock("store:42"), store.collLock("42"), "a Store and a person never share a lock");
  assert.equal(store.ownerMismatch("user:42", 42), false);
  assert.equal(store.ownerMismatch("store:42", "42"), true);
});

test("a save made as \"user:<id>\" is the same owner as \"<id>\": a copy of it is answered, not applied again", async () => {
  const { user } = fresh();
  const r1 = await store.writeCollection(user, doc([{ id: "a", quantity: 1 }]), null);
  const S = doc([{ id: "a", quantity: 2 }]);
  const first = await store.writeCollection("user:" + user, S, r1.rev, { saveId: "x1" });
  const again = await store.writeCollection(user, S, r1.rev, { saveId: "x1" });
  assert.equal(again.replayed, true);
  assert.equal(again.rev, first.rev);
  assert.equal((await store.readCollection(user)).rev, first.rev, "nothing written twice");
});

test("a save and Create organization's move started together run one after the other (save first)", async () => {
  const { user, storeId } = fresh();
  const r1 = await store.writeCollection(user, doc([{ id: "a", quantity: 1 }]), null);
  // The save is the personal account's own (bare id, as resolveDocOwner
  // gives it); the move is what createOrg calls. Neither awaited first.
  const save = store.writeCollection(user, doc([{ id: "a", quantity: 5 }]), r1.rev, { saveId: "s1" });
  const move = store.moveCollectionToStore(user, storeId);
  const [saved] = await Promise.all([save, move]);
  assert.equal(saved.rev, 2);
  const moved = await store.readCollection("store:" + storeId);
  assert.equal(moved.rev, 2, "the save landed before the move, so it moved with the rest");
  assert.equal(qty(moved.state, "a"), 5);
  assert.equal(fs.existsSync(personalFile(user)), false, "nothing written into the personal folder after the move");
});

test("a save queued behind the move doesn't land in the emptied personal folder: it gets the ordinary 409", async () => {
  const { user, storeId } = fresh();
  const r1 = await store.writeCollection(user, doc([{ id: "a", quantity: 1 }]), null);
  await store.writeCollection(user, doc([{ id: "a", quantity: 2 }]), r1.rev, { saveId: "before" });
  const move = store.moveCollectionToStore(user, storeId);
  // Sent by a page that loaded the personal collection at rev 2, a moment
  // too late. Before #186 it found rev 2 in the personal key's snapshot
  // buffer and was merged into the empty folder, out of sight.
  const save = store.writeCollection(user, doc([{ id: "a", quantity: 9 }]), 2, { saveId: "late" });
  await move;
  await assert.rejects(save, e => e.status === 409 && !e.wrongOwner);
  assert.equal(fs.existsSync(personalFile(user)), false, "the personal folder stays empty");
  const moved = await store.readCollection("store:" + storeId);
  assert.equal(moved.rev, 2);
  assert.equal(qty(moved.state, "a"), 2, "the Store has the collection as it was moved");
});

test("after the move, the personal key remembers nothing about the old collection", async () => {
  const { user, storeId } = fresh();
  const r1 = await store.writeCollection(user, doc([{ id: "a", quantity: 1 }]), null);
  const S = doc([{ id: "a", quantity: 2 }]);
  await store.writeCollection(user, S, r1.rev, { saveId: "old" });
  await store.moveCollectionToStore(user, storeId);
  // Same saveId again at the personal key (say the account later leaves
  // the org and starts over): not answered from the moved collection's
  // history, it's a new save into the new, empty folder.
  const out = await store.writeCollection(user, S, -1, { saveId: "old" });
  assert.equal(out.replayed, undefined);
  assert.equal(out.rev, 1);
  // And the Store's history starts clean too: its key never saw "old".
  const st = await store.writeCollection("store:" + storeId, S, -1, { saveId: "old" });
  assert.equal(st.replayed, undefined);
  assert.equal(st.rev, 3);
});

test("an audit append and the move started together: the day file ends up in the Store, not stranded", async () => {
  const { user, storeId } = fresh();
  await store.writeCollection(user, doc([]), null);
  const day = "2026-10-11";
  const append = audit.append(user, [{ id: "e1", ts: day + "T10:00:00Z", action: "edit" }]);
  const move = store.moveCollectionToStore(user, storeId);
  await Promise.all([append, move]);
  const inStore = path.join(store.p("stores", storeId), "audit", "day", day + ".json");
  const inUser = path.join(store.p("users", user), "audit", "day", day + ".json");
  assert.ok(fs.existsSync(inStore), "moved with the rest");
  assert.equal(fs.existsSync(inUser), false, "not left behind");
  assert.equal(JSON.parse(fs.readFileSync(inStore, "utf8"))[0].id, "e1");
});
