"use strict";
/* #379: Bulk Price became the Pricing tab on Listings. Pins the old URL, the
   redirect page, the nav entry, and that the two page scripts share Listings
   without clashing element ids. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const ids = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

test("/inventory/bulk-price still resolves to a page that sends people to the Pricing tab", () => {
  const server = read("server/index.js");
  assert.match(server, /PAGE_ALIASES = \{ "\/inventory\/bulk-price": "\/bulk-price\.html" \}/);
  assert.match(server, /"\/inventory\/bulk-price", "\/admin\.html"/);
  const redirect = read("public/bulk-price.html");
  assert.match(redirect, /http-equiv="refresh" content="0;url=\/listings\.html#pricing"/);
  assert.doesNotMatch(redirect, /<script/);
});

test("the nav no longer lists Bulk Price, and Listings has the four tabs in order", () => {
  assert.doesNotMatch(read("public/js/ui.js"), /inventory\/bulk-price/);
  const html = read("public/listings.html");
  const order = ["tabRules", "tabEvaluate", "tabPricing", "tabManapool"].map(i => html.indexOf('id="' + i + '"'));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), "tab order");
  assert.ok(html.indexOf('id="panePricing"') < html.indexOf('id="paneManapool"'));
  assert.match(html, /<script src="\/bulk-price\.page\.js"><\/script>/);
});

test("no element id appears twice on Listings, and bulk-price.page.js maps every shared id", () => {
  const all = ids(read("public/listings.html"));
  assert.deepEqual(all.filter((id, i) => all.indexOf(id) !== i), []);
  // Every id the Pricing script looks up by its plain name must exist in the
  // markup after the SHARED remap.
  const js = read("public/bulk-price.page.js");
  const shared = new Set(js.match(/new Set\("([^"]+)"\.split/)[1].split(" "));
  const present = new Set(all);
  const missing = [];
  for (const m of js.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)) {
    const id = shared.has(m[1]) ? "bp_" + m[1] : m[1];
    if (!present.has(id)) missing.push(id);
  }
  // Ids built by the script at run time (rule value editor, refresh button).
  const dynamic = new Set(["rmBasis", "rmPercent", "rmDelta", "rmFixed", "spRmPercent", "spRmDelta", "spRmFixed", "bpRefreshPrices"]);
  assert.deepEqual([...new Set(missing)].filter(i => !dynamic.has(i)), []);
});

test("the Pricing script starts only when asked, not at page load", () => {
  const js = read("public/bulk-price.page.js");
  assert.doesNotMatch(js, /UI\.boot\(/);
  assert.match(js, /window\.startPricingTab = async function/);
  assert.match(read("public/listings.page.js"), /window\.startPricingTab\(\)/);
});
