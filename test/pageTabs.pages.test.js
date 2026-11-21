"use strict";
/* #442: the pages' tabs go through the real UI.pageTabs. Help keeps its
   #section deep links and #glossary / #support names; a role-gated Admin
   tab is never opened, even when it is the remembered one. Not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

function storageOf(init) {
  const s = Object.assign({}, init);
  return { getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); } };
}
async function open(file, hash, store, routes, scripts, before) {
  const page = loadPage(file, { realUI: true, routes, scripts });
  const sb = page.sandbox;
  sb.location.pathname = "/" + file.replace(".page.js", ".html");
  sb.location.hash = hash;
  sb.localStorage = storageOf(store);
  sb.history = { state: null, replaceState(st, t, url) { sb.location.hash = url.slice(url.indexOf("#")); } };
  sb.window.scrollTo = () => {};
  if (before) before(page);
  await page.G.load();
  await page.boot();
  await settle(5);
  return page;
}
const shown = (page, ids) => ids.filter(id => !page.$(id).hidden);

const helpRoutes = url => (url === "/api/auth/me" ? { user: { id: "u1", username: "u" } } : url === "/api/collection" ? { rev: 1, savedAt: null, state: null } : url === "/api/tickets" ? { tickets: [] } : {});
const HELP = ["paneGuide", "paneGlossary", "paneSupport", "paneChangelog"];
const openHelp = (hash, store) => open("help.page.js", hash, store, helpRoutes, ["js/glossary.js"]);

test("Help: no address opens the remembered tab, else the Guide; a section link opens the Guide over the memory", async () => {
  assert.deepEqual(shown(await openHelp("", {}), HELP), ["paneGuide"]);
  const mem = { "grimoire.tab./help.html": "support" };
  assert.deepEqual(shown(await openHelp("", mem), HELP), ["paneSupport"]);
  const scrolled = [];
  const link = await open("help.page.js", "#putaway-page", mem, helpRoutes, ["js/glossary.js"], p => {
    p.$("paneGuide").contains = () => true;
    p.$("chromeSticky").getBoundingClientRect = () => ({ height: 50 });
    p.$("putaway-page").style = {};
    p.$("putaway-page").scrollIntoView = () => scrolled.push(p.$("putaway-page").style.scrollMarginTop);
  });
  assert.deepEqual(shown(link, HELP), ["paneGuide"], "help.html#<section> is the Guide, not the remembered tab");
  assert.deepEqual(scrolled, ["64px"], "scrolled to the section, below the sticky bar");
});

test("Help: #tab=<id>, #support and #g-<term> pick their tab over the memory", async () => {
  const mem = { "grimoire.tab./help.html": "changelog" };
  assert.deepEqual(shown(await openHelp("#tab=support", mem), HELP), ["paneSupport"]);
  assert.deepEqual(shown(await openHelp("#support", mem), HELP), ["paneSupport"]);
  assert.deepEqual(shown(await openHelp("#g-stack", mem), HELP), ["paneGlossary"]);
});

const adminRoutes = role => url => {
  if (url === "/api/auth/me") return { user: { id: "u1", username: "boss", role, createdAt: "2026-01-01" } };
  if (url === "/api/collection") return { rev: 1, savedAt: null, state: { cards: [], locations: [] } };
  if (url.startsWith("/api/admin/users?")) return { users: [], total: 0, page: 1 };
  if (url.startsWith("/api/admin/tickets?")) return { tickets: [], total: 0, page: 1 };
  if (url === "/api/admin/status") return { users: [], cards: { count: 0 }, prices: { snapshots: 0 }, memoryMB: 1, uptimeMin: 1, node: "v22", dataDir: "/d", invites: [] };
  return {};
};
// As in admin.html: the admin-only tab buttons start hidden; the page unhides them for an admin.
const hideAdminTabs = p => { for (const id of ["tabSystem", "tabInvites", "tabEmail", "tabGithub"]) p.$(id).hidden = true; };
const ADMIN = ["paneSystemA", "paneAccounts", "paneTickets", "paneInvites", "paneEmail", "paneGithub"];

test("Admin: an admin's tab is remembered; a moderator never lands on an admin-only tab (address or memory)", async () => {
  const mem = { "grimoire.tab./admin.html": "tickets" };
  assert.deepEqual(shown(await open("admin.page.js", "", mem, adminRoutes("admin"), null, hideAdminTabs), ADMIN), ["paneTickets"]);
  assert.deepEqual(shown(await open("admin.page.js", "", {}, adminRoutes("admin"), null, hideAdminTabs), ADMIN), ["paneSystemA"]);
  for (const hash of ["", "#tab=system", "#tab=email"]) {
    const m = await open("admin.page.js", hash, { "grimoire.tab./admin.html": "system" }, adminRoutes("moderator"), null, hideAdminTabs);
    assert.deepEqual(shown(m, ADMIN), ["paneAccounts"], "moderator, address '" + hash + "'");
  }
});
