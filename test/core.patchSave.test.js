"use strict";
/* #181 patch saves, the page's side: public/js/core.js savePlan/flushSave
   against the real store.writeCollection (scratch dataDir), routed the way
   PUT /api/collection routes it. The server's side is patch.test.js. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadPage } = require("../test-lib/page-shim");
const store = require("../server/lib/store");
const { MERGE_ARRAYS } = require("../server/lib/merge");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const puts = page => page.net.filter(r => r.url === "/api/collection" && r.method === "PUT");
const card = (id, q, loc) => ({ id, name: "Card " + id, set: "lea", collector: id, lang: "en", finish: "nonfoil",
  condition: "NM", quantity: q, locationId: loc || "l1" });

/* A collection already saved once by a page (so its rows are what the page
   normalises them to), then a fresh page loaded on it. opts.patch: false
   is a server from before patch saves (no `patch: 1`, 400 on a patch). */
async function setup(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-patchsave-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const owner = "u-ps-" + Math.random().toString(36).slice(2);
  await store.writeCollection(owner, { cards: o.cards || [card("a", 2), card("b", 1)], locations: [{ id: "l1", name: "Bin" }] }, null);
  const route = async (url, init, body) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/auth/me") return { user: { id: owner, username: "u" }, personalPrefs: null };
    if (url === "/api/collection" && method === "GET") {
      const c = await store.readCollection(owner);
      const r = { rev: c.rev, savedAt: c.savedAt, state: c.state, owner };
      if (o.patch !== false) r.patch = 1;
      return r;
    }
    if (url === "/api/collection" && method === "PUT") {
      if (o.put) { const v = await o.put(body, init); if (v) return v; }
      if (body.patch && o.patch === false) return { __status: 400, error: "Send {rev, state}." };
      try {
        return await store.writeCollection(owner, body.patch ? null : body.state, body.rev,
          { saveId: body.saveId, afterSaveIds: body.afterSaveIds, loadedOwner: body.owner, patch: body.patch || null,
            lockSettings: o.lockSettings });
      } catch (e) {
        if (e.patchRefused) return { __status: 422, error: e.message, patchRefused: true };
        if (e.status === 409) return { __status: 409, error: e.message, serverRev: e.serverRev };
        throw e;
      }
    }
    return {};
  };
  // The page that wrote the rows first, so the next page's load is tidy.
  const first = loadPage(null, { routes: route });
  await first.G.load();
  first.G.state.settings.note = "seeded"; first.G.persist("edit");
  await first.G.saveNow();
  const page = loadPage(null, { routes: route });
  await page.G.load();
  return { owner, page, G: page.G, route };
}
// What the page holds and the server holds, as JSON (savedAt is stamped at send time).
async function same(owner, G) {
  const cur = await store.readCollection(owner);
  const mine = JSON.parse(JSON.stringify(G.state));
  const disk = Object.assign({}, cur.state);
  delete disk.savedAt; delete disk.app; delete disk.version;
  for (const k of Object.keys(disk)) assert.deepEqual(disk[k], mine[k], k + " matches the page");
}

test("the page's keyed lists are the ones merge.js keys, on the same key", async () => {
  const page = loadPage(null, { routes: async () => ({}) });
  const keys = {};
  for (const [k, cfg] of Object.entries(MERGE_ARRAYS)) keys[k] = cfg.key || "id";
  assert.deepEqual(Object.assign({}, page.G.PATCH_KEYS), keys);
});

test("an edit goes as a patch of just that row, and the server ends with the page's document", async () => {
  const { owner, page, G } = await setup();
  G.state.cards.find(c => c.id === "a").quantity = 5;
  G.persist("edit");
  await G.saveNow();
  const p = puts(page);
  assert.equal(p.length, 1);
  assert.equal(p[0].body.state, undefined);
  assert.deepEqual(p[0].body.patch.rows.cards.edit.map(r => r.id), ["a"]);
  assert.equal(p[0].body.patch.rows.locations, undefined, "untouched lists aren't sent");
  assert.equal(G.hasUnsaved(), false);
  await same(owner, G);
});

test("adds at the front and the end, deletes, and a settings change all land in the page's order", async () => {
  const { owner, page, G } = await setup({ cards: [card("a", 2), card("b", 1), card("c", 4)] });
  G.state.cards.unshift(Object.assign(card("z", 1), { createdAt: "2026-10-16T00:00:00Z" }));
  G.state.cards.push(Object.assign(card("y", 1), { createdAt: "2026-10-16T00:00:00Z" }));
  G.state.cards = G.state.cards.filter(c => c.id !== "b");
  G.state.settings.note = "changed";
  G.state.history.unshift({ id: "h-new", at: "2026-10-16T00:00:00Z", text: "x" });
  G.persist("edit");
  await G.saveNow();
  const patch = puts(page)[0].body.patch;
  assert.ok(patch, "sent as a patch");
  assert.deepEqual(patch.rows.cards.del, ["b"]);
  assert.ok(patch.rows.cards.order, "the front add needs an order");
  assert.ok(patch.set.settings && patch.set.history, "whole fields go whole");
  await same(owner, G);
  assert.deepEqual((await store.readCollection(owner)).state.cards.map(c => c.id), ["z", "a", "c", "y"]);
});

test("a hundred random edits, saved in turn, keep the server identical to the page", async () => {
  const cards = Array.from({ length: 40 }, (_, i) => card("k" + i, 1 + (i % 3)));
  const { owner, page, G } = await setup({ cards });
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 100; i++) {
    const op = rnd(5), list = G.state.cards;
    if (op === 0 && list.length) list[rnd(list.length)].quantity += 1;
    else if (op === 1) list.splice(rnd(list.length + 1), 0, Object.assign(card("n" + i, 1), { createdAt: "2026-10-16T00:00:00Z" }));
    else if (op === 2 && list.length > 1) list.splice(rnd(list.length), 1);
    else if (op === 3) list.reverse();
    else G.state.settings.note = "n" + i;
    G.persist("edit");
    await G.saveNow();
    assert.equal(G.hasUnsaved(), false, "save " + i);
  }
  await same(owner, G);
  assert.ok(puts(page).filter(p => p.body.patch).length > 50, "most went as patches");
});

test("the server refuses a patch (it doesn't fit): the page sends the whole document at once, and patches again after", async () => {
  let refuseOne = true;
  const { owner, page, G } = await setup({
    put: body => { if (body.patch && refuseOne) { refuseOne = false; return { __status: 422, error: "no", patchRefused: true }; } }
  });
  G.state.cards[0].quantity = 9; G.persist("edit");
  await G.saveNow();
  let p = puts(page);
  assert.equal(p.length, 2);
  assert.ok(p[0].body.patch && p[1].body.state, "patch, then the whole document");
  assert.equal(G.saveState().label, "saved", "no error shown");
  G.state.cards[0].quantity = 10; G.persist("edit");
  await G.saveNow();
  p = puts(page);
  assert.ok(p[2].body.patch, "the full save rebuilt what the page knows the server has");
  await same(owner, G);
});

test("a server from before patch saves: whole documents only", async () => {
  const { owner, page, G } = await setup({ patch: false });
  G.state.cards[0].quantity = 9; G.persist("edit");
  await G.saveNow();
  G.state.cards[0].quantity = 8; G.persist("edit");
  await G.saveNow();
  assert.ok(puts(page).every(p => p.body.state && !p.body.patch));
  await same(owner, G);
});

test("a patch to a server rolled back to before patches (400) falls back to whole documents and stays there", async () => {
  let old = false;
  const { owner, page, G } = await setup({ put: body => { if (old && body.patch) return { __status: 400, error: "Send {rev, state}." }; } });
  old = true;
  for (const q of [7, 6]) { G.state.cards[0].quantity = q; G.persist("edit"); await G.saveNow(); }
  const p = puts(page);
  assert.deepEqual(p.map(x => x.body.patch ? "patch" : "full"), ["patch", "full", "full"]);
  await same(owner, G);
});

test("someone else saved in between: the patch merges like a full save, and the page adopts the merged document", async () => {
  const { owner, page, G } = await setup();
  const cur = await store.readCollection(owner);
  const other = JSON.parse(JSON.stringify(cur.state));
  other.cards.find(c => c.id === "b").quantity = 6;              // another device: b 1 -> 6
  await store.writeCollection(owner, other, cur.rev);
  G.state.cards.find(c => c.id === "a").quantity += 1;           // this page: a 2 -> 3
  G.persist("edit");
  await G.saveNow();
  assert.ok(puts(page)[0].body.patch);
  assert.equal(G.state.cards.find(c => c.id === "b").quantity, 6, "the other edit adopted");
  G.state.cards.find(c => c.id === "b").quantity += 1;           // and edited further: 6 -> 7
  G.persist("edit");
  await G.saveNow();
  assert.ok(puts(page)[1].body.patch, "the next save patches against the merged document");
  await same(owner, G);
  assert.equal((await store.readCollection(owner)).state.cards.find(c => c.id === "b").quantity, 7);
});

test("the reply to a patch is lost: the retry patches from the same base, and each edit counts once", async () => {
  let loseNext = true;
  const { owner, page, G, route } = await setup({
    put: async (body, init) => {
      if (!loseNext || !body.patch) return;
      loseNext = false;
      await store.writeCollection(owner, null, body.rev, { saveId: body.saveId, loadedOwner: body.owner, patch: body.patch });
      throw new TypeError("Failed to fetch");                     // written, reply lost
    }
  });
  void route;
  G.state.cards.find(c => c.id === "a").quantity += 1; G.persist("edit");
  await G.saveNow();
  assert.equal(G.saveState().label, "save failed");
  G.state.cards.find(c => c.id === "a").quantity += 1; G.persist("edit");
  await G.saveNow();
  const p = puts(page);
  assert.ok(p[1].body.patch && p[1].body.rev === p[0].body.rev, "same base as the lost one");
  assert.deepEqual(p[1].body.afterSaveIds, [p[0].body.saveId]);
  assert.equal((await store.readCollection(owner)).state.cards.find(c => c.id === "a").quantity, 4, "2 + 1 + 1");
});

test("leaving the page: a small patch fits the keepalive budget, so it is sent as keepalive", async () => {
  const cards = Array.from({ length: 3000 }, (_, i) => card("k" + i, 1));
  const { page, G } = await setup({ cards });
  G.state.cards[5].quantity = 3; G.persist("edit");
  await page.fireDocument("visibilitychange", "hidden");
  const p = puts(page);
  assert.equal(p.length, 1);
  assert.ok(p[0].body.patch);
  assert.equal(p[0].keepalive, true);
  assert.ok(JSON.stringify(p[0].body).length < 4000);
});

test("Erase / Replace (archive) and Keep mine still send the whole document", async () => {
  const { page, G } = await setup();
  G.state.cards = []; G.persist("edit");
  await G.saveNow({ archive: true });
  assert.ok(puts(page)[0].body.state && puts(page)[0].body.archive);
  await G.overwriteServer();
  assert.ok(puts(page)[1].body.state && puts(page)[1].body.rev === -1);
});
