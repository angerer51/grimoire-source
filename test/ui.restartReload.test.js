"use strict";
/* public/js/ui.js - the restart banner's "Back online" reload waits for the
   save (#176). An edit made during the countdown or the downtime is still
   failing and waiting for its retry when the server comes back; reloading
   then would hit the browser's "Reload site?" prompt, and pressing Reload
   would lose it. Now the page saves first and only reloads once it landed;
   if it can't, it stays and says so, and (#183) takes that "hasn't saved
   yet" down as soon as a later save lands. The real ui.js and core.js run through
   the page shim (realUI). Each test waits for two real restart polls (about
   2 s apart), so they live in their own file. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle, holdCoreTimers } = require("../test-lib/page-shim");

// The server starts "down" (GET /api/meta fails); serverUp() brings it back.
// putFails(): true answers the next PUT with a 500, an object answers it
// with that ({ __status: 409, ... }), anything else saves it.
async function open(putFails, auditFails) {
  let up = false;
  const page = loadPage(null, {
    realUI: true,
    routes: async (url, init) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/meta") { if (!up) throw new TypeError("Failed to fetch"); return { version: "test", restart: null }; }
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u" }, personalPrefs: null };
      if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state: { settings: { tutorialSeen: true } } };
      if (url === "/api/collection" && method === "PUT") {
        const f = putFails();
        if (f && typeof f === "object") return f;
        if (f) return { __status: 500, error: "still starting" };
        return { rev: 2, savedAt: "2026-10-10T00:00:00Z" };
      }
      if (url === "/api/audit" && auditFails && auditFails()) return { __status: 500, error: "disk full" };
      if (url === "/api/cards/status") return { ready: true };
      return {};
    }
  });
  await page.boot();
  await settle(5);
  return Object.assign(page, { serverUp: () => { up = true; } });
}
function edit(G) {
  G.state.settings.someNote = "x" + Math.random();
  G.persist("edit");
}
const banner = page => page.$("restartBannerMsg").textContent;

test("#176: back online with a save that still fails: no reload over the edit, and the banner says why", async () => {
  const page = await open(() => true);
  assert.match(banner(page), /Restarting/);
  edit(page.G);
  page.serverUp();
  await settle(3600);                // the next poll (2 s), plus the old 1.2 s reload delay
  assert.equal(page.sandbox.location.reloads, 0, "didn't reload over unsaved work");
  assert.match(banner(page), /hasn't saved yet/);
  assert.equal(page.G.hasUnsaved(), true);
});

test("#176: back online: the edit saves first, then the page reloads", async () => {
  let failing = true;
  const page = await open(() => failing);
  edit(page.G);
  await page.G.saveNow();            // failed while the server was down
  assert.equal(page.G.saveState().label, "save failed");
  failing = false;
  page.serverUp();
  await settle(3600);
  const puts = page.net.filter(r => r.url === "/api/collection" && r.method === "PUT");
  assert.equal(puts.length, 2, "saved again the moment the server came back");
  assert.equal(page.G.hasUnsaved(), false);
  assert.equal(page.sandbox.location.reloads, 1);
});

test("#183: back online with a save that still fails: the banner comes down as soon as the retry lands", async () => {
  let failing = true;
  const page = await open(() => failing);
  const timers = holdCoreTimers(page, 8000);
  edit(page.G);
  page.serverUp();
  await settle(3600);
  assert.match(banner(page), /hasn't saved yet/);
  assert.equal(page.$("restartBanner").hidden, false);
  assert.equal(timers.pending, 1, "the failed save is waiting for its retry");
  await timers.fire();                // still failing: the banner stays
  assert.equal(page.$("restartBanner").hidden, false);
  edit(page.G);                       // a new edit isn't a save landing either
  assert.equal(page.$("restartBanner").hidden, false);
  failing = false;
  await timers.fire();                // the retry lands
  assert.equal(page.G.saveState().label, "saved");
  assert.equal(page.$("restartBanner").hidden, true, "no stale 'hasn't saved yet' once it saved");
  assert.equal(page.sandbox.location.reloads, 0, "and no surprise reload");
});

test("#183: back online in a conflict: not resent, and the banner stays until Keep mine lands", async () => {
  let answer = { __status: 409, error: "changed somewhere else", serverRev: 9 };
  const page = await open(() => answer);
  edit(page.G);
  await page.G.saveNow();             // the conflict
  assert.equal(page.G.saveState().conflict, true);
  page.serverUp();
  await settle(3600);
  assert.match(banner(page), /hasn't saved yet/);
  const sent = () => page.net.filter(r => r.url === "/api/collection" && r.method === "PUT").length;
  assert.equal(sent(), 1, "back online didn't resend the conflict");
  answer = null;
  await page.G.overwriteServer();     // Keep mine
  assert.equal(sent(), 2);
  assert.equal(page.$("restartBanner").hidden, true);
});

test("#190: back online with only the audit flush failing: the banner comes down once the audit lands", async () => {
  let auditFailing = true;
  const page = await open(() => false, () => auditFailing);
  const timers = holdCoreTimers(page, 8000);
  page.G.logAudit({ action: "edit", note: "n" });
  edit(page.G);
  page.serverUp();
  await settle(3600);
  assert.match(banner(page), /hasn't saved yet/);
  assert.equal(page.$("restartBanner").hidden, false);
  assert.equal(timers.pending, 1, "the audit flush is waiting for its retry");
  auditFailing = false;
  await timers.fire();
  timers.assertHeld();
  assert.equal(page.G.hasUnsaved(), false);
  assert.equal(page.$("restartBanner").hidden, true, "no stale banner while the header says Saved");
});
