"use strict";
/* UI.pageTabs (#438): page tabs that remember where you were. The tab is in
   the address (#tab=), so Back and links land on it; with none there, the
   page opens on the tab last used on it on this device, else the first.
   The real ui.js runs through the page shim (realUI). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("../test-lib/page-shim");

const TABS = [
  { id: "running", button: "tRun", panes: ["pRun"] },
  { id: "pin", button: "tPin", panes: ["pPin"] },
  { id: "limits", button: "tLim", panes: ["pLim", "pLim2"] }
];
// One page load: the device's storage (shared across loads, like a browser's) and the address.
function open(storage, hash, opts) {
  const page = loadPage(null, { realUI: true });
  const sb = page.sandbox;
  sb.location.pathname = "/kiosk-setup.html";
  sb.location.hash = hash || "";
  sb.localStorage = storage === null ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }
    : { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } };
  const replaced = [];
  sb.history = { state: null, replaceState(s, t, url) { replaced.push(url); sb.location.hash = url.slice(url.indexOf("#")); } };
  for (const fn of (opts && opts.before) || []) fn(page);
  const tabs = sb.UI.pageTabs({ tabs: TABS });
  return { page, tabs, replaced, shown: () => TABS.filter(t => !page.$(t.panes[0]).hidden).map(t => t.id) };
}

test("first visit: the first tab, put in the address; a click switches, and the address follows", () => {
  const storage = {};
  const v = open(storage);
  assert.deepEqual(v.shown(), ["running"]);
  assert.equal(v.page.$("tRun").classList.contains("active"), true);
  assert.equal(v.page.$("tRun").getAttribute("aria-selected"), "true");
  assert.equal(v.page.sandbox.location.hash, "#tab=running");
  v.page.$("tPin").fire("click");
  assert.deepEqual(v.shown(), ["pin"]);
  assert.equal(v.page.$("tRun").classList.contains("active"), false);
  assert.equal(v.page.$("pLim2").hidden, true, "every pane of a tab follows it");
  assert.equal(v.page.sandbox.location.hash, "#tab=pin");
  assert.ok(v.replaced.every(u => u.startsWith("/kiosk-setup.html#")), "the address is replaced, not pushed: Back leaves the page");
});

test("coming back from the menu (no tab in the address) reopens the tab last used on this page", () => {
  const storage = {};
  open(storage).page.$("tPin").fire("click");
  const back = open(storage);
  assert.deepEqual(back.shown(), ["pin"]);
  assert.equal(back.page.sandbox.location.hash, "#tab=pin");
  assert.deepEqual(Object.keys(storage), ["grimoire.tab./kiosk-setup.html"], "one entry per page");
});

test("the address wins over the memory (Back, a link), and a #tab= link on the page switches", async () => {
  const storage = { "grimoire.tab./kiosk-setup.html": "pin" };
  const v = open(storage, "#tab=limits");
  assert.deepEqual(v.shown(), ["limits"]);
  v.page.sandbox.location.hash = "#tab=running";
  await v.page.fireWindow("hashchange");
  assert.deepEqual(v.shown(), ["running"]);
  assert.equal(storage["grimoire.tab./kiosk-setup.html"], "running");
});

test("an unknown or hidden tab falls back to the first one shown; blocked storage still works", () => {
  assert.deepEqual(open({}, "#tab=nope").shown(), ["running"]);
  const hidden = open({}, "#tab=pin", { before: [p => { p.$("tPin").hidden = true; }] });
  assert.deepEqual(hidden.shown(), ["running"], "a role-gated tab that's hidden isn't opened");
  const blocked = open(null);
  assert.deepEqual(blocked.shown(), ["running"]);
  blocked.page.$("tLim").fire("click");
  assert.deepEqual(blocked.shown(), ["limits"]);
});

test("other #key=value parts of the address are kept", () => {
  const v = open({}, "#card=abc&tab=pin");
  assert.deepEqual(v.shown(), ["pin"]);
  v.page.$("tLim").fire("click");
  assert.equal(v.page.sandbox.location.hash, "#card=abc&tab=limits");
});

test("a bare #<tab id> (an old link) opens that tab; def is the first-visit tab", () => {
  assert.deepEqual(open({}, "#pin").shown(), ["pin"]);
  assert.deepEqual(open({}, "#nope").shown(), ["running"]);
  const v = open({}, "", { before: [p => { p.sandbox.UI.pageTabs = (orig => spec => orig(Object.assign({ def: "limits" }, spec)))(p.sandbox.UI.pageTabs); }] });
  assert.deepEqual(v.shown(), ["limits"]);
});
