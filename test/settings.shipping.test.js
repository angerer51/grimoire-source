"use strict";
/* #457 part 2: Settings → Shipping through the real settings.page.js, ui.js
   and shipCost.js with the stand-in DOM. What the tab draws from the
   suggested setup, Try it, the letters-only warning, and Save storing a clean
   copy that opens next time. Not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

function routes(settings) {
  return url => {
    if (url === "/api/auth/me") return { user: { id: "u1", username: "u", role: "user", createdAt: "2026-01-01" } };
    if (url === "/api/collection") return { rev: 1, savedAt: null, state: { cards: [], locations: [], settings: Object.assign({ tutorialSeen: true }, settings) } };
    if (url === "/api/collection/revisions") return { revisions: [] };
    if (url === "/api/notifications/settings") return { groups: [] };
    if (url === "/api/integrations") return { manapool: {}, pitneyBowes: {} };
    return {};
  };
}
async function open(settings) {
  const page = loadPage("settings.page.js", { realUI: true, scripts: ["js/shipCost.js"], routes: routes(settings) });
  const sb = page.sandbox;
  sb.location.pathname = "/settings.html";
  sb.location.hash = "#tab=shipping";
  sb.localStorage = { getItem: () => null, setItem: () => {} };
  sb.history = { state: null, replaceState() {} };
  sb.window.scrollTo = () => {};
  page.$("adminSection").hidden = true;
  page.$("shipTryCards").value = "4";   // the stand-in DOM does not read value="" from the markup
  page.$("shipTryValue").value = "10";
  await page.G.load();
  await page.boot();
  await settle(5);
  return page;
}

test("Shipping: the suggested setup is drawn, and Try it prices a small order as a letter", async () => {
  const page = await open({});
  assert.equal(page.$("paneShipping").hidden, false);
  const rules = page.$("shipRuleRows").innerHTML;
  for (const name of ["Letter", "Small bubble mailer", "Large bubble mailer", "Box"]) assert.ok(rules.includes(name), name);
  assert.ok(page.$("shipSupplyRows").innerHTML.includes("Toploader"));
  assert.equal(page.$("shipStamp").value, 0.82);
  // 4 cards, $10: the default letter, one stamp (shipCost.test.js has the math).
  assert.match(page.$("shipTryOut").textContent, /^Letter: 0\.98 oz, supplies \$0\.24 \+ postage \$0\.82 = \$1\.06$/);
  assert.equal(page.$("shipWarn").hidden, true);
  assert.equal(page.$("shipFields").disabled, false);
});

test("Shipping: Save stores a clean copy in settings.shipping; a saved setup is what opens next time", async () => {
  const page = await open({});
  page.$("shipSave").onclick();
  const saved = page.G.state.settings.shipping;
  assert.ok(saved && Array.isArray(saved.rules) && saved.rules.length === 4);
  assert.equal(saved.postage.stamp, 0.82);

  const custom = JSON.parse(JSON.stringify(saved));
  custom.rules = custom.rules.filter(r => r.kind === "letter");
  custom.postage.stamp = 1;
  const again = await open({ shipping: custom });
  assert.equal(again.$("shipStamp").value, 1);
  assert.ok(!again.$("shipRuleRows").innerHTML.includes("Box"));
  // Letters only: an order needing tracking has nowhere to go, so the tab says so.
  assert.equal(again.$("shipWarn").hidden, false);
  assert.match(again.$("shipWarnText").textContent, /Every rule is a letter/);
});
