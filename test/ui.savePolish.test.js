"use strict";
/* Save path polish (#183), follow-up to the #182 review.
   1. G.saveAll() doesn't resend a save that was refused with a 409 conflict
      (it waits for its "Keep mine" prompt) or a 403 refusal. A save that
      failed for a reason that may pass (no answer, a 5xx) is sent again at
      once, in place of its waiting retry.
   2. One retry timer: link clicks, Ctrl+S, Save buttons and saveAll each
      used to start an 8 s retry loop of their own (4 clicks -> 8 PUTs in
      17 s). Now every save sent cancels the waiting retry and every failure
      replaces it. The audit flush gets the same.
   The restart banner clearing once a save lands (3.) is in
   ui.restartReload.test.js, with the other tests that wait for real
   restart polls. The real ui.js and core.js run through the page shim
   (realUI); holdCoreTimers counts core.js's 8 s retries and runs them. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle, holdCoreTimers } = require("../test-lib/page-shim");

const ORIGIN = "https://grimoire.test";
const RETRY_MS = 8000;

/* opts.put(body): answers PUT /api/collection (default: saved).
   opts.audit(body): answers POST /api/audit (default: ok). */
async function open(opts) {
  const o = opts || {};
  let rev = 1;
  const page = loadPage(null, {
    realUI: true,
    routes: async (url, init, body) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/meta") return { version: "test", restart: null };
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u" }, personalPrefs: null };
      if (url === "/api/collection" && method === "GET") return { rev, savedAt: null, state: { settings: { tutorialSeen: true } } };
      if (url === "/api/collection" && method === "PUT") {
        if (o.put) { const v = await o.put(body); if (v) return v; }
        return { rev: ++rev, savedAt: "2026-10-11T00:00:00Z" };
      }
      if (url === "/api/audit" && method === "POST" && o.audit) return o.audit(body);
      if (url === "/api/cards/status") return { ready: true };
      return {};
    }
  });
  page.sandbox.location.pathname = "/inventory.html";
  page.sandbox.location.href = ORIGIN + "/inventory.html";
  const timers = holdCoreTimers(page, RETRY_MS);
  await page.boot();
  await settle(5);
  page.ui.toasts.length = 0;
  return Object.assign(page, { timers });
}
function edit(G, note) {
  G.state.settings.someNote = note || "x" + Math.random();
  G.persist("edit");
}
const link = href => ({
  tagName: "A", href: new URL(href, ORIGIN + "/inventory.html").href, target: "", attrs: {},
  hasAttribute(k) { return k in this.attrs; },
  closest(sel) { return sel === "a[href]" ? this : null; }
});
const saveButton = label => ({
  tagName: "BUTTON", textContent: label, disabled: false,
  closest(sel) { return sel === "button" ? this : null; }
});
const puts = page => page.net.filter(r => r.url === "/api/collection" && r.method === "PUT");
const auditPosts = page => page.net.filter(r => r.url === "/api/audit" && r.method === "POST");
const lastToast = page => page.ui.toasts[page.ui.toasts.length - 1] || "";
const CONFLICT = { __status: 409, error: "This collection was changed somewhere else.", serverRev: 9 };

/* ---------------- 1. saveAll and a just-failed save ---------------- */

test("#183: saveAll doesn't resend a save refused with a conflict; it waits for Keep mine", async () => {
  let answer = CONFLICT;
  const page = await open({ put: () => answer });
  const conflicts = [];
  page.G.on("conflict", c => conflicts.push(c));
  edit(page.G);
  await page.G.saveNow();
  assert.equal(page.G.saveState().conflict, true);
  assert.equal(await page.G.saveAll(500), false, "not saved, and says so");
  assert.equal(await page.G.saveAll(500), false);
  assert.equal(puts(page).length, 1, "the conflict wasn't sent again");
  assert.equal(conflicts.length, 1, "one conflict, one prompt");
  assert.equal(page.timers.pending, 0, "and no retry: a conflict waits for the person");
  // Keep mine: the overwrite lands, and saveAll is satisfied again.
  answer = null;
  await page.G.overwriteServer();
  assert.equal(await page.G.saveAll(500), true);
  assert.equal(puts(page).length, 2);
});

test("#183: the Import pattern (saveNow, then saveAll) sends a conflicting save once, not twice", async () => {
  const page = await open({ put: () => CONFLICT });
  const conflicts = [];
  page.G.on("conflict", c => conflicts.push(c));
  edit(page.G);
  await page.G.saveNow({ archive: true });
  assert.equal(await page.G.saveAll(), false);
  assert.equal(puts(page).length, 1);
  assert.equal(conflicts.length, 1);
});

test("#183: a link clicked during a conflict sends nothing and keeps the Keep mine toast", async () => {
  const page = await open({ put: () => CONFLICT });
  edit(page.G);
  await page.G.saveNow();
  const conflictToast = lastToast(page);
  assert.match(conflictToast, /also changed somewhere else/);
  const ev = page.dispatch("click", { target: link("/receive.html") });
  assert.equal(ev.defaultPrevented, true, "unsaved work: the page waits");
  await settle(30);
  assert.equal(puts(page).length, 1, "nothing resent");
  assert.equal(page.sandbox.location.href, ORIGIN + "/inventory.html", "still here");
  assert.equal(lastToast(page), "Saving your changes before leaving this page…",
    "the leave toast only; notSavedToast leaves a conflict alone");
  // The conflict toast (with Keep mine) stays the one the person deals with:
  // nothing re-posted it, and no second conflict came in.
  assert.equal(page.ui.toasts.filter(t => /also changed somewhere else/.test(t)).length, 1);
});

test("#183: a 403 refusal isn't resent by saveAll either", async () => {
  const page = await open({ put: () => ({ __status: 403, error: "Only a manager can replace the store's inventory." }) });
  edit(page.G);
  await page.G.saveNow({ archive: true });
  assert.equal(await page.G.saveAll(500), false);
  assert.equal(puts(page).length, 1);
  assert.equal(page.timers.pending, 0);
});

test("#183: a save that failed with a 5xx is sent again at once by saveAll, in place of its retry", async () => {
  let fail = true;
  const page = await open({ put: () => fail ? { __status: 503, error: "server restarting" } : null });
  edit(page.G);
  await page.G.saveNow();
  assert.equal(page.timers.pending, 1, "the failure is waiting for its retry");
  fail = false;
  assert.equal(await page.G.saveAll(500), true, "someone leaving the page wants it saved now");
  assert.equal(puts(page).length, 2);
  assert.equal(page.timers.pending, 0, "the retry it replaced is gone");
  await page.timers.fire();
  assert.equal(puts(page).length, 2);
});

/* ---------------- 2. one retry timer ---------------- */

test("#183: four link clicks while saves fail leave one retry, not four (2 PUTs in 17 s, not 8)", async () => {
  const page = await open({ put: () => ({ __status: 500, error: "disk full" }) });
  edit(page.G);
  for (let i = 0; i < 4; i++) {
    page.dispatch("click", { target: link("/receive.html") });
    await settle(30);
    assert.equal(page.timers.pending, 1, "click " + (i + 1) + ": still one retry waiting");
  }
  assert.equal(puts(page).length, 4, "each click tried once");
  assert.equal(page.sandbox.location.href, ORIGIN + "/inventory.html");
  // The next 17 s: the retry at 8 s and the one it schedules at 16 s.
  await page.timers.fire();
  await page.timers.fire();
  assert.equal(puts(page).length, 6, "two retries, one loop");
  assert.equal(page.timers.pending, 1);
});

test("#183: Ctrl+S, Save buttons and saveAll share the one retry", async () => {
  const page = await open({ put: () => ({ __status: 500, error: "disk full" }) });
  edit(page.G);
  for (let i = 0; i < 3; i++) {
    page.dispatch("keydown", { key: "s", ctrlKey: true, target: { tagName: "BODY" } });
    await settle(20);
  }
  for (const label of ["Save", "Save rule"]) {
    page.dispatch("click", { target: saveButton(label) });
    await settle(20);
  }
  await page.G.saveAll(500);
  await page.G.saveAll(500);
  assert.equal(puts(page).length, 7, "3 Ctrl+S, 2 Save buttons, 2 saveAll");
  assert.equal(page.timers.started, 7, "each failure scheduled a retry...");
  assert.equal(page.timers.pending, 1, "...replacing the one before");
  await page.timers.fire();
  assert.equal(puts(page).length, 8);
  assert.equal(page.timers.pending, 1, "a failed retry schedules the next one, still only one");
});

test("#183: a save that lands cancels the waiting retry", async () => {
  let fail = true;
  const page = await open({ put: () => fail ? { __status: 500, error: "disk full" } : null });
  edit(page.G);
  await page.G.saveNow();
  assert.equal(page.timers.pending, 1);
  fail = false;
  page.dispatch("keydown", { key: "s", ctrlKey: true, target: { tagName: "BODY" } });
  await settle(20);
  assert.equal(page.G.hasUnsaved(), false);
  assert.equal(page.timers.pending, 0);
  assert.equal(puts(page).length, 2);
});

test("#183: a failing audit flush keeps one retry too, however many saves flush it", async () => {
  const page = await open({ audit: () => ({ __status: 500, error: "disk full" }) });
  for (let i = 0; i < 3; i++) {
    page.G.logAudit({ action: "edit", note: "n" + i });
    edit(page.G);
    await page.G.saveNow();
    await settle(20);
  }
  assert.equal(puts(page).length, 3, "the document saved each time");
  assert.equal(auditPosts(page).length, 3);
  assert.equal(page.timers.pending, 1, "one audit retry waiting, not three");
  await page.timers.fire();
  assert.equal(auditPosts(page).length, 4);
  assert.equal(page.timers.pending, 1);
  page.timers.assertHeld();           // the stack-trace match still finds core.js (#190)
});

/* ---------------- 3. a waiting conflict holds every send (#190) ---------------- */

test("#190: while a conflict waits, a new edit, Ctrl+S and Save send nothing; Keep mine sends the latest", async () => {
  let answer = CONFLICT;
  const page = await open({ put: () => answer });
  const conflicts = [];
  page.G.on("conflict", c => conflicts.push(c));
  edit(page.G);
  await page.G.saveNow();
  assert.equal(puts(page).length, 1);
  edit(page.G, "newer");
  await settle(1700);                 // past the 1.5 s autosave debounce
  page.dispatch("keydown", { key: "s", ctrlKey: true, target: { tagName: "BODY" } });
  page.dispatch("click", { target: saveButton("Save") });
  await settle(30);
  assert.equal(puts(page).length, 1, "nothing was sent again");
  assert.equal(page.ui.toasts.filter(t => /also changed somewhere else/.test(t)).length, 3,
    "the autosave stayed quiet; the first conflict plus one each for Ctrl+S and Save");
  assert.equal(page.G.saveState().conflict, true);
  answer = null;
  await page.G.overwriteServer();
  assert.equal(puts(page).length, 2);
  assert.equal(JSON.stringify(puts(page)[1].body).includes("newer"), true, "Keep mine carries the latest state");
  assert.equal(page.G.hasUnsaved(), false);
});

test("#190: after the conflict toast is gone, Ctrl+S brings it back with Keep mine, still without a second PUT", async () => {
  const page = await open({ put: () => CONFLICT });
  edit(page.G);
  await page.G.saveNow();
  page.ui.toasts.length = 0;
  page.$("toastDetail").children.length = 0;   // another toast (or the X) took it away
  edit(page.G, "later");
  page.dispatch("keydown", { key: "s", ctrlKey: true, target: { tagName: "BODY" } });
  await settle(30);
  assert.match(lastToast(page), /also changed somewhere else/);
  const labels = page.$("toastDetail").children.map(c => c.textContent).filter(Boolean);
  assert.ok(labels.includes("Keep mine"), "Keep mine is back");
  assert.equal(puts(page).length, 1);
});
