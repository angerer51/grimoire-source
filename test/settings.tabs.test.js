"use strict";
/* #444: Settings is four tabs through the real UI.pageTabs. The Integrations
   tab is hidden (never shown empty) in Simple mode; an old link to a box
   (#acctEmail, #notifications) opens the Account tab; the open tab is
   remembered. Not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const PANES = ["paneAccount", "panePrefs", "paneIntegrations", "paneData"];
function routes(simple, role) {
  return url => {
    if (url === "/api/auth/me") return { user: { id: "u1", username: "u", role: role || "user", createdAt: "2026-01-01" } };
    if (url === "/api/collection") return { rev: 1, savedAt: null, state: { cards: [], locations: [], settings: { tutorialSeen: true, simpleMode: !!simple } } };
    if (url === "/api/collection/revisions") return { revisions: [] };
    if (url === "/api/notifications/settings") return { groups: [] };
    if (url === "/api/integrations") return { manapool: {}, pitneyBowes: {} };
    return {};
  };
}
// The shim has no [data-full-only] pass or hidden-attribute parsing or contains(): do those as the
// browser would (UI.boot hides full-only things in Simple mode; the markup starts adminSection hidden).
async function open(hash, store, simple, role) {
  const page = loadPage("settings.page.js", { realUI: true, routes: routes(simple, role) });
  const sb = page.sandbox;
  sb.location.pathname = "/settings.html";
  sb.location.hash = hash;
  const s = Object.assign({}, store);
  sb.localStorage = { getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); } };
  sb.history = { state: null, replaceState(st, t, url) { sb.location.hash = url.slice(url.indexOf("#")); } };
  sb.window.scrollTo = () => {};
  page.$("adminSection").hidden = true;
  if (simple) page.$("tabIntegrations").hidden = true;
  for (const id of PANES) page.$(id).contains = el => !!el && el.paneId === id;
  for (const id of ["acctEmail", "notifications"]) page.$(id).paneId = "paneAccount";
  page.$("wipe").paneId = "paneData";
  await page.G.load();
  await page.boot();
  await settle(5);
  return page;
}
const shown = page => PANES.filter(id => !page.$(id).hidden);

test("Settings: opens on Account, remembers the tab, #tab= wins over the memory", async () => {
  assert.deepEqual(shown(await open("", {}, false)), ["paneAccount"]);
  assert.deepEqual(shown(await open("", { "grimoire.tab./settings.html": "data" }, false)), ["paneData"]);
  assert.deepEqual(shown(await open("#tab=prefs", { "grimoire.tab./settings.html": "data" }, false)), ["panePrefs"]);
});

test("Settings: Simple mode hides the Integrations tab and never opens it", async () => {
  const full = await open("", {}, false);
  assert.equal(full.$("tabIntegrations").hidden, false);
  const simple = await open("#tab=integrations", { "grimoire.tab./settings.html": "integrations" }, true);
  assert.equal(simple.$("tabIntegrations").hidden, true);
  assert.deepEqual(shown(simple), ["paneAccount"], "falls back to Account, not an empty pane");
  assert.equal(simple.$("tabData").hidden, false, "Data keeps revisions, import and the danger zone");
});

test("Settings: an old link to a box opens the tab that holds it", async () => {
  const mem = { "grimoire.tab./settings.html": "data" };
  for (const id of ["acctEmail", "notifications"]) {
    const page = await open("#" + id, mem, false);
    assert.deepEqual(shown(page), ["paneAccount"], "#" + id);
  }
  assert.deepEqual(shown(await open("#wipe", {}, false)), ["paneData"], "the danger zone is on Data");
});

test("Settings: the bell's #notifications link switches to Account while already on another tab", async () => {
  const page = await open("#tab=data", {}, false);
  assert.deepEqual(shown(page), ["paneData"]);
  let scrolled = 0;
  page.$("notifications").scrollIntoView = () => scrolled++;
  page.sandbox.location.hash = "#notifications";
  await page.fireWindow("hashchange");
  assert.deepEqual(shown(page), ["paneAccount"]);
  assert.equal(scrolled, 1);
});

test("Settings: Administration sits on Account and shows for an admin only", async () => {
  assert.equal((await open("", {}, false, "admin")).$("adminSection").hidden, false);
  assert.equal((await open("", {}, false, "user")).$("adminSection").hidden, true);
});
