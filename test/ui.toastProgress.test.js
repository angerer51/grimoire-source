"use strict";
/* public/js/ui.js - UI.toastProgress (#480). It used to fill only a line
   inside the toast and never open it, so a push's progress sat in a hidden
   box. The real ui.js runs through the page shim (realUI); not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

async function open() {
  const page = loadPage(null, {
    realUI: true,
    routes: async url => {
      if (url === "/api/meta") return { version: "test", restart: null };
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u" }, personalPrefs: null };
      if (url === "/api/collection") return { rev: 1, savedAt: null, state: { settings: { tutorialSeen: true } } };
      if (url === "/api/cards/status") return { ready: true };
      return {};
    }
  });
  page.sandbox.location.pathname = "/inventory.html";
  await page.boot();
  await settle(5);
  page.sandbox.UI.hideToast();
  page.ui.toasts.length = 0;
  return page;
}

test("with nothing up, progress opens the toast as a working message, and \"\" closes it", async () => {
  const page = await open();
  const { UI } = page.sandbox;
  UI.toastProgress("Checking Manapool for new orders…");
  assert.equal(page.$("toast").hidden, false);
  assert.match(page.$("toast").className, /work/);
  assert.equal(page.$("toastMsg").textContent, "Checking Manapool for new orders…");
  assert.equal(page.$("toastProg").hidden, false);
  assert.ok(page.$("toastBar").classList.contains("indet"), "no numbers: indeterminate bar");
  assert.equal(page.$("toastBar").getAttribute("aria-valuenow"), undefined);

  UI.toastProgress("Pushing 1,200 of 7,419 listings to Manapool…", 1200, 7419);
  assert.equal(page.$("toastMsg").textContent, "Pushing 1,200 of 7,419 listings to Manapool…");
  assert.ok(!page.$("toastBar").classList.contains("indet"));
  assert.equal(page.$("toastBar").getAttribute("aria-valuenow"), "1200");
  assert.equal(page.$("toastBar").getAttribute("aria-valuemax"), "7419");
  assert.match(page.$("toastBar").querySelector("i").style.width, /^16\.17/);

  UI.toastProgress("");
  assert.equal(page.$("toast").hidden, true);
});

test("under a work toast already up, progress fills the line beneath and \"\" leaves the toast open", async () => {
  const page = await open();
  const { UI } = page.sandbox;
  UI.toast("Refreshing prices…", "work");
  UI.toastProgress("Loading 3 of 9…", 3, 9);
  assert.equal(page.$("toastMsg").textContent, "Refreshing prices…");
  assert.equal(page.$("toastProgText").textContent, "Loading 3 of 9…");
  UI.toastProgress("");
  assert.equal(page.$("toast").hidden, false);
  assert.equal(page.$("toastProg").hidden, true);
});

test("a result toast replaces progress, and a later \"\" doesn't close the result", async () => {
  const page = await open();
  const { UI } = page.sandbox;
  UI.toastProgress("Pushing 100 of 300 listings to Manapool…", 100, 300);
  UI.toast("Stopped after batch 2", "err");
  UI.toastProgress("");
  assert.equal(page.$("toast").hidden, false);
  assert.equal(page.$("toastMsg").textContent, "Stopped after batch 2");
  assert.equal(page.$("toastProg").hidden, true);
});
