"use strict";
/* public/js/core.js - saving as the page is hidden or left (#174).
   The browser can't carry a multi-megabyte save out of a page that is going
   away (keepalive bodies are capped at 64 KiB), and iOS Safari doesn't
   reliably fire beforeunload. So: hiding the page (another tab or app, the
   phone locked) or leaving it (pagehide) saves at once instead of waiting
   out the 1.5 s debounce, asking for keepalive only when the body fits;
   beforeunload only asks "Leave site?" and sends nothing. Runs the real
   core.js through the page shim, with no page script. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const puts = page => page.net.filter(r => r.url === "/api/collection" && r.method === "PUT");

// opts.put(body) answers PUT /api/collection (default: saved).
async function open(opts) {
  const o = opts || {};
  let rev = 1;
  const page = loadPage(null, {
    routes: async (url, init, body) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u" }, personalPrefs: null };
      if (url === "/api/collection" && method === "GET") return { rev, savedAt: null, state: o.state || null };
      if (url === "/api/collection" && method === "PUT") {
        if (o.put) { const v = await o.put(body, init); if (v) return v; }
        return { rev: ++rev, savedAt: "2026-10-10T00:00:00Z" };
      }
      return {};
    }
  });
  await page.G.load();
  return page;
}
function edit(G, note) {
  G.state.settings.someNote = note || "x" + Math.random();
  G.persist("edit");
}

test("hiding the page saves at once, not after the 1.5 s debounce, and a small body asks for keepalive", async () => {
  const page = await open();
  edit(page.G);
  await page.fireDocument("visibilitychange", "hidden");
  await settle(20);
  assert.equal(puts(page).length, 1, "saved the moment the page was hidden");
  assert.equal(puts(page)[0].keepalive, true, "a small body survives the page going away");
  assert.equal(page.G.hasUnsaved(), false);
  await settle(1600);
  assert.equal(puts(page).length, 1, "the debounced save has nothing left to send");
});

test("pagehide (leaving, or iOS putting the page away) saves at once too", async () => {
  const page = await open();
  edit(page.G);
  await page.fireWindow("pagehide");
  await settle(20);
  assert.equal(puts(page).length, 1);
  assert.equal(page.G.hasUnsaved(), false);
});

test("a real-size collection is still saved on hide, as a normal request: it can't fit a keepalive", async () => {
  // About 120 KB of document, twice the browsers' keepalive allowance.
  const cards = Array.from({ length: 600 }, (_, i) => ({ id: "c" + i, name: "Card number " + i + " with a long-ish name", set: "neo",
    collector: String(i), lang: "en", finish: "nonfoil", condition: "NM", quantity: 1, locationId: "l1", price: 1.23 }));
  const page = await open({ state: { cards, locations: [{ id: "l1", name: "Bin" }] } });
  edit(page.G);
  await page.fireDocument("visibilitychange", "hidden");
  await settle(20);
  assert.equal(puts(page).length, 1);
  assert.equal(puts(page)[0].keepalive, false, "over the limit: sent normally, not refused");
  assert.equal(page.G.hasUnsaved(), false);
});

test("beforeunload still asks before leaving with unsaved work, but sends nothing", async () => {
  const page = await open();
  edit(page.G);
  page.G.logAudit({ action: "edit", note: "an edit" });
  const e = page.dispatchWindow("beforeunload");
  assert.equal(e.defaultPrevented, true, "the browser's Leave site? prompt");
  await settle(20);
  assert.deepEqual(page.net.filter(r => r.method !== "GET").map(r => r.url), [],
    "no whole-document keepalive PUT (and no copy that Stay would then save twice)");
});

test("nothing unsaved: hiding the page sends nothing, and leaving doesn't prompt", async () => {
  const page = await open();
  await page.fireDocument("visibilitychange", "hidden");
  await page.fireWindow("pagehide");
  await settle(20);
  assert.equal(puts(page).length, 0);
  assert.equal(page.dispatchWindow("beforeunload").defaultPrevented, false);
});

test("an edit made while a save is in the air is sent as soon as that save lands when the page is hidden", async () => {
  let release;
  let first = true;
  const page = await open({ put: () => first ? (first = false, new Promise(r => { release = r; })) : null });
  edit(page.G, "one");
  page.G.saveNow();                  // in the air
  await settle(5);
  edit(page.G, "two");               // changed meanwhile
  await page.fireDocument("visibilitychange", "hidden");
  release({ rev: 2, savedAt: "2026-10-10T00:00:00Z" });
  await settle(250);
  assert.equal(puts(page).length, 2, "the second save didn't wait out the debounce");
  assert.equal(puts(page)[1].body.state.settings.someNote, "two");
  assert.equal(page.G.hasUnsaved(), false);
});

test("a conflicted save isn't resent every time the page is hidden; it waits for the conflict prompt", async () => {
  const page = await open({ put: () => ({ __status: 409, error: "conflict", serverRev: 9 }) });
  edit(page.G);
  await page.G.saveNow();
  assert.equal(page.G.saveState().conflict, true);
  await page.fireDocument("visibilitychange", "hidden");
  await page.fireWindow("pagehide");
  await settle(20);
  assert.equal(puts(page).length, 1);
});

test("held for a store switch: hiding the page saves nothing", async () => {
  const page = await open();
  page.G.holdSaves(true);
  edit(page.G);
  await page.fireDocument("visibilitychange", "hidden");
  await page.fireWindow("pagehide");
  await settle(20);
  assert.equal(puts(page).length, 0, "the session may already point at another store");
});

test("a keepalive request the browser refuses is a failed save shown and retried, not an unhandled error", async () => {
  const page = await open({ put: (body, init) => { if (init.keepalive) throw new TypeError("Failed to fetch"); } });
  edit(page.G);
  await page.fireWindow("pagehide");
  await settle(20);
  assert.equal(puts(page).length, 1);
  assert.equal(page.G.saveState().label, "save failed");
  assert.equal(page.G.hasUnsaved(), true, "still unsaved, so it is retried");
});
