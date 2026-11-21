"use strict";
/* public/js/ui.js - the "merged automatically" toast after a save that
   server/lib/merge.js had to resolve (#201). A conflict on a customer's
   mergedAt (#196 bookkeeping, never something the person typed) is left
   out of it; a toast with only that to say isn't shown at all. The real
   ui.js and core.js run through the page shim (realUI); not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

async function open() {
  const page = loadPage(null, {
    realUI: true,
    routes: async (url, init) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/meta") return { version: "test", restart: null };
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u" }, personalPrefs: null };
      if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state: { settings: { tutorialSeen: true } } };
      if (url === "/api/cards/status") return { ready: true };
      return {};
    }
  });
  page.sandbox.location.pathname = "/inventory.html";
  await page.boot();
  await settle(5);
  page.ui.toasts.length = 0;
  return page;
}

const mergedAt = { array: "customers", key: "mp-b1", field: "mergedAt", mine: "a", theirs: "b", resolution: "theirs" };
const note = { array: "customers", key: "mp-b1", field: "note", mine: "x", theirs: "y", resolution: "theirs" };

test("#201: a conflict on a customer's mergedAt alone shows no toast", async () => {
  const page = await open();
  page.G.emit("merged", { conflicts: [mergedAt] });
  assert.deepEqual(page.ui.toasts, []);
});

test("#201: alongside a real conflict, mergedAt is left out of the toast's detail", async () => {
  const page = await open();
  page.G.emit("merged", { conflicts: [mergedAt, note] });
  assert.equal(page.ui.toasts.length, 1);
  const detail = page.$("toastDetail").textContent;
  assert.match(detail, /customers\.note/);
  assert.doesNotMatch(detail, /mergedAt/);
  assert.doesNotMatch(detail, /more\)/, "not counted as one more either");
});

/* #214: a pick list completed here that another device had already
   completed. Merged (the server undid this tab's take) or, from a tab
   without the completion mark, refused. */
const done = key => ({ array: "pickLists", key, type: "already-completed", resolution: "theirs" });

test("#214: an already-completed pick list gets its own toast, saying the cards came off once", async () => {
  const page = await open();
  page.G.emit("merged", { conflicts: [done("P-1")] });
  assert.equal(page.ui.toasts.length, 1);
  assert.match(page.ui.toasts[0], /Already completed on another device - reload/);
  const detail = page.$("toastDetail").textContent;
  assert.match(detail, /Pick list P-1 was completed on another device first/);
  assert.match(detail, /once, not twice/);
  assert.doesNotMatch(detail, /Also:/);
});

test("#214: other conflicts in the same save are listed after it", async () => {
  const page = await open();
  page.G.emit("merged", { conflicts: [done("P-1"), done("P-2"), note] });
  assert.equal(page.ui.toasts.length, 1);
  const detail = page.$("toastDetail").textContent;
  assert.match(detail, /Pick lists P-1, P-2 were completed/);
  assert.match(detail, /their cards/);
  assert.match(detail, /Also: your change to customers\.note/);
});

test("#214: a refused save (409 alreadyCompleted) says so, with Reload and no Keep mine", async () => {
  const page = await open();
  page.G.emit("conflict", { message: "x", serverRev: 4, alreadyCompleted: ["P-1"] });
  assert.match(page.ui.toasts[0], /Already completed on another device - reload/);
  const detail = page.$("toastDetail").textContent;
  assert.match(detail, /Pick list P-1 was completed on another device first/);
  assert.match(detail, /Reload/);
  assert.doesNotMatch(detail, /Keep mine/);
});
