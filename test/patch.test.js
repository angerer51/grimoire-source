"use strict";
/* #181 patch saves, the server's side: server/lib/patch.js applyPatch and
   store.writeCollection({ patch }). The page's side is
   core.patchSave.test.js. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyPatch } = require("../server/lib/patch");
const { MERGE_ARRAYS } = require("../server/lib/merge");
const store = require("../server/lib/store");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const base = () => ({
  app: "Grimoire",
  cards: [{ id: "a", quantity: 1 }, { id: "b", quantity: 2 }, { id: "c", quantity: 3 }],
  locations: [{ id: "l1", name: "Bin" }],
  history: [{ id: "h1" }],
  settings: { theme: "dark" },
  pickList: []
});
const keys = ["app", "cards", "locations", "history", "settings"];

test("rows edited, added and deleted by key; untouched fields and rows shared with the base", () => {
  const b = base();
  const before = JSON.stringify(b);
  const r = applyPatch(b, { v: 1, keys, set: { settings: { theme: "light" } },
    rows: { cards: { edit: [{ id: "b", quantity: 5 }], add: [{ id: "d", quantity: 1 }], del: ["a"], n: 3 } } });
  assert.equal(r.refused, undefined);
  assert.deepEqual(r.state.cards, [{ id: "b", quantity: 5 }, { id: "c", quantity: 3 }, { id: "d", quantity: 1 }]);
  assert.deepEqual(r.state.settings, { theme: "light" });
  assert.equal(r.state.locations, b.locations, "an untouched field is the base's own");
  assert.equal(r.state.cards[1], b.cards[2], "an untouched row is the base's own");
  assert.equal(r.state.pickList, undefined, "a field the page no longer sends is dropped, as a full save drops it");
  assert.deepEqual(Object.keys(r.state), keys, "fields in the page's order");
  assert.equal(JSON.stringify(b), before, "the base isn't changed");
});

test("order segments: a row added at the front, and a re-sort", () => {
  const front = applyPatch(base(), { v: 1, keys, rows: { cards: { add: [{ id: "z" }], order: ["z", [0, 3]], n: 4 } } });
  assert.deepEqual(front.state.cards.map(c => c.id), ["z", "a", "b", "c"]);
  const sorted = applyPatch(base(), { v: 1, keys, rows: { cards: { order: [[2, 1], [0, 2]], n: 3 } } });
  assert.deepEqual(sorted.state.cards.map(c => c.id), ["c", "a", "b"]);
});

test("anything that doesn't fit the base exactly is refused, never guessed at", () => {
  const bad = [
    ["edit of a missing row", { cards: { edit: [{ id: "x" }], n: 3 } }],
    ["delete of a missing row", { cards: { del: ["x"], n: 2 } }],
    ["add of a row already there", { cards: { add: [{ id: "a" }], n: 4 } }],
    ["wrong length", { cards: { edit: [{ id: "a", quantity: 9 }], n: 4 } }],
    ["a row placed twice", { cards: { order: [[0, 2], [1, 2]], n: 3 } }],
    ["a row left out", { cards: { order: [[0, 2]], n: 3 } }],
    ["a list merge.js doesn't key", { history: { add: [{ id: "h2" }], n: 2 } }]
  ];
  for (const [why, rows] of bad) assert.ok(applyPatch(base(), { v: 1, keys, rows }).refused, why);
  assert.ok(applyPatch(base(), { v: 2, keys }).refused, "an unknown version");
  assert.ok(applyPatch(base(), { v: 1, keys: keys.concat("receipts") }).refused, "a field the base doesn't have");
  assert.ok(applyPatch(null, { v: 1, keys }).refused, "no base");
  const dup = base(); dup.cards.push({ id: "a" });
  assert.ok(applyPatch(dup, { v: 1, keys, rows: { cards: { del: ["b"], n: 3 } } }).refused, "a base with a repeated key");
});

test("deckList is keyed on name, as merge.js keys it", () => {
  assert.equal(MERGE_ARRAYS.deckList.key, "name");
  const b = Object.assign(base(), { deckList: [{ name: "Sol Ring", qty: 1 }] });
  const r = applyPatch(b, { v: 1, keys: keys.concat("deckList"), rows: { deckList: { edit: [{ name: "Sol Ring", qty: 2 }], n: 1 } } });
  assert.deepEqual(r.state.deckList, [{ name: "Sol Ring", qty: 2 }]);
});

/* ------------------------- through writeCollection ------------------------- */

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-patch-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  return "u-patch-" + Math.random().toString(36).slice(2);
}

test("a patch at the current rev writes exactly what the full save would have", async () => {
  const owner = fresh();
  await store.writeCollection(owner, base(), null);
  const full = base(); full.cards[0].quantity = 7; delete full.pickList;
  const out = await store.writeCollection(owner, null, 1,
    { patch: { v: 1, keys, rows: { cards: { edit: [{ id: "a", quantity: 7 }], n: 3 } } } });
  assert.equal(out.rev, 2);
  const cur = await store.readCollection(owner);
  assert.equal(JSON.stringify(cur.state), JSON.stringify(full));
});

test("a patch from a stale rev is rebuilt on that rev, then merged with the newer save (quantities add)", async () => {
  const owner = fresh();
  await store.writeCollection(owner, base(), null);                          // rev 1
  const other = base(); other.cards[1].quantity = 10;
  await store.writeCollection(owner, other, 1);                              // rev 2, someone else: b 2 -> 10
  const out = await store.writeCollection(owner, null, 1,                    // this page, still at rev 1: b 2 -> 3
    { patch: { v: 1, keys: keys.concat("pickList"), rows: { cards: { edit: [{ id: "b", quantity: 3 }], n: 3 } } } });
  assert.equal(out.merged, true);
  const cur = await store.readCollection(owner);
  assert.equal(cur.state.cards.find(c => c.id === "b").quantity, 11, "+8 and +1");
});

test("a rev the server no longer holds, or a patch that doesn't fit, is a 422 and writes nothing", async () => {
  const owner = fresh();
  await store.writeCollection(owner, base(), null);
  await assert.rejects(store.writeCollection(owner, null, 0, { patch: { v: 1, keys } }),
    e => e.status === 422 && e.patchRefused === true && e.serverRev === 1);
  await assert.rejects(store.writeCollection(owner, null, -1, { patch: { v: 1, keys } }),
    e => e.status === 422 && e.patchRefused, "Keep mine (rev -1) always sends the whole document");
  await assert.rejects(store.writeCollection(owner, null, 1,
    { patch: { v: 1, keys, rows: { cards: { del: ["nope"], n: 2 } } } }), e => e.status === 422);
  await assert.rejects(store.writeCollection(owner, null, 1, { patch: { v: 1, keys: ["app", "settings"] } }),
    e => e.status === 422, "no cards or locations");
  assert.equal((await store.readCollection(owner)).rev, 1);
});

test("a patch's saveId is remembered: the same patch again is answered, not applied twice", async () => {
  const owner = fresh();
  await store.writeCollection(owner, base(), null);
  const patch = { v: 1, keys, rows: { cards: { edit: [{ id: "a", quantity: 2 }], n: 3 } } };
  const one = await store.writeCollection(owner, null, 1, { patch, saveId: "s1" });
  const two = await store.writeCollection(owner, null, 1, { patch, saveId: "s1" });
  assert.equal(two.replayed, true);
  assert.equal(two.rev, one.rev);
  assert.equal((await store.readCollection(owner)).rev, 2);
});

test("Staff setting locks, the big-drop revision and onWrite all see the rebuilt document", async () => {
  const owner = fresh();
  const big = base();
  big.cards = Array.from({ length: 60 }, (_, i) => ({ id: "c" + i, quantity: 1 }));
  await store.writeCollection(owner, big, null);
  let seen = null;
  const out = await store.writeCollection(owner, null, 1, {
    patch: { v: 1, keys, set: { settings: { theme: "light" } },
      rows: { cards: { del: big.cards.slice(0, 50).map(c => c.id), n: 10 } } },
    lockSettings: ["theme"],
    onWrite: (before, after) => { seen = [before.cards.length, after.cards.length]; }
  });
  assert.deepEqual(seen, [60, 10]);
  const cur = await store.readCollection(owner);
  assert.equal(cur.state.settings.theme, "dark", "a locked setting keeps what's on disk");
  const revs = await store.listRevisions(owner);
  assert.ok(revs.some(r => r.rev === out.rev - 1), "the outgoing version kept as a revision");
});
