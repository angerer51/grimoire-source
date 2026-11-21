"use strict";
/* #331: a brand-new account that left the welcome tour before choosing goes
   back to it on the next page load; finishing or skipping (tutorialSeen), an
   account with cards, or an organization member is left alone. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

async function open(settings, cards, orgId) {
  const page = loadPage(null, {
    realUI: true,
    routes: async url => {
      if (url === "/api/meta") return { version: "test", restart: null };
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u", orgId: orgId || null }, personalPrefs: null };
      if (url === "/api/collection") return { rev: 1, savedAt: null, state: { cards: cards || [], settings } };
      return {};
    }
  });
  let went = null;
  page.sandbox.location.pathname = "/index.html";
  page.sandbox.location.replace = u => { went = u; };
  await page.boot();
  await settle(5);
  return went;
}

test("#331: an unfinished tour on an empty new account reopens at the tour", async () => {
  assert.equal(await open({}), "/tutorial.html");
});

test("#331: a finished or skipped tour, existing cards, or an organization are not sent back", async () => {
  assert.equal(await open({ tutorialSeen: true }), null);
  assert.equal(await open({}, [{ id: "c1", name: "X", set: "s", collector: "1", qty: 1 }]), null);
  assert.equal(await open({}, [], "o1"), null);
});
