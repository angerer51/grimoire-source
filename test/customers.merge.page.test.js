"use strict";
/* Customers page's "Merge into…" (#196), through the real customers.page.js
   with a stand-in DOM (test-lib/page-shim.js): the slide-over button, the
   searchable picker that leaves out the customer itself, the danger
   confirm, and the kept customer opened afterwards with both buyers'
   orders. The merge itself is G.mergeCustomers
   (test/core.customerMerge.test.js). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const order = (id, buyerId, name, total) => ({ id, buyerId, buyer: name, label: "L-" + id,
  placedAt: "2026-09-0" + id.slice(-1) + "T00:00:00Z", total, ship: { name } });
const CACHE = [order("o1", "b1", "Dana Reyes", 20), order("o2", "b2", "D Reyes", 5), order("o3", "b3", "Marcus Lee", 7)];

async function page() {
  const pg = loadPage("customers.page.js", { routes: url =>
    url === "/api/manapool/orders/cached" ? { orders: CACHE } : {} });
  pg.G.syncCustomersFromOrders(CACHE);
  pg.G.updateCustomer("mp-b2", { note: "plays Mardu" });
  pg.G.addWant("mp-b2", { name: "Sol Ring" });
  const dialogs = [];
  pg.ui.confirmDialog = async (msg, opts) => { dialogs.push({ msg, opts }); return pg.ui.confirmAnswer; };
  pg.dialogs = dialogs;
  await pg.boot();
  await settle(10);
  return pg;
}
// The stand-in DOM never parses markup, so a click "on a row" is the
// container's listener with closest() answering that row.
async function clickRow(pg, bodyId, dataset) {
  pg.$(bodyId).closest = () => ({ dataset });
  await pg.$(bodyId).fire("click");
  await settle(5);
}
const ids = pg => JSON.parse(JSON.stringify(pg.G.state.customers.map(c => c.id))).sort();

test("the slide-over offers Merge into…; the picker lists everyone else, searchable", async () => {
  const pg = await page();
  await clickRow(pg, "custBody", { id: "mp-b2" });
  assert.match(pg.$("custDetail").innerHTML, /id="cdMerge"[^>]*>.*Merge into…/);
  await pg.$("cdMerge").fire("click");
  const rows = pg.$("mgBody").innerHTML;
  assert.match(rows, /data-into="mp-b1"/);
  assert.match(rows, /data-into="mp-b3"/);
  assert.doesNotMatch(rows, /data-into="mp-b2"/, "not itself");
  assert.match(pg.$("mgIntro").textContent, /D Reyes's orders, wants and note move to them/);
  pg.$("mergeSearch").value = "marc";
  await pg.$("mergeSearch").fire("input");
  assert.doesNotMatch(pg.$("mgBody").innerHTML, /mp-b1/);
  assert.match(pg.$("mgBody").innerHTML, /data-into="mp-b3"/);
  pg.$("mergeSearch").value = "nobody";
  await pg.$("mergeSearch").fire("input");
  assert.match(pg.$("mgBody").innerHTML, /No customer matches that search/);
});

test("two customers with the same name are told apart in the picker: email, last order and spend, or date added", async () => {
  const pg = await page();
  pg.G.updateCustomer("mp-b1", { email: "dana@example.com" });
  const walkIn = pg.G.addCustomer({ name: "Dana Reyes" });
  walkIn.createdAt = "2026-10-01T12:00:00Z";
  pg.G.persist("Add customer");
  await clickRow(pg, "custBody", { id: "mp-b3" });
  await pg.$("cdMerge").fire("click");
  const rows = pg.$("mgBody").innerHTML.split("<tr").filter(r => r.includes(">Dana Reyes<"));
  assert.equal(rows.length, 2);
  const mp = rows.find(r => r.includes('data-into="mp-b1"')), hand = rows.find(r => r.includes(walkIn.id));
  assert.match(mp, /dana@example\.com · last order 2026-09-01 · \$20\.00 spent/);
  assert.match(hand, /no email · no orders · added 2026-10-01/);
});

test("picking one asks first (danger), then merges and opens the kept customer with both buyers' orders", async () => {
  const pg = await page();
  await clickRow(pg, "custBody", { id: "mp-b2" });
  await pg.$("cdMerge").fire("click");
  await clickRow(pg, "mgBody", { into: "mp-b1" });
  assert.equal(pg.dialogs.length, 1);
  const { msg, opts } = pg.dialogs[0];
  assert.equal(opts.danger, true);
  assert.equal(opts.okLabel, "Merge");
  assert.match(msg, /D Reyes will be combined into Dana Reyes/);
  assert.match(msg, /1 order, 1 want, any "came in" notes and their note/);
  assert.match(msg, /future Manapool orders go to Dana Reyes/);
  assert.match(msg, /no unmerge/);
  assert.deepEqual(ids(pg), ["mp-b1", "mp-b3"]);
  const detail = pg.$("custDetail").innerHTML;
  assert.match(detail, /<h2 id="cdName"[^>]*>Dana Reyes</, "the kept customer is the one open");
  assert.match(detail, /2 orders · \$25\.00 spent/);
  assert.match(detail, /L-o1/);
  assert.match(detail, /L-o2/);
  assert.match(detail, /Sol Ring/);
  assert.match(detail, /plays Mardu/);
  assert.ok(pg.ui.toasts.includes("Customers merged."));
  const row = pg.$("custBody").innerHTML.split("<tr").find(r => r.includes(">Dana Reyes<"));
  assert.match(row, /data-v="25"/, "Lifetime spend in the table covers both");
});

test("Cancel on the confirm merges nothing", async () => {
  const pg = await page();
  pg.ui.confirmAnswer = false;
  await clickRow(pg, "custBody", { id: "mp-b2" });
  await pg.$("cdMerge").fire("click");
  await clickRow(pg, "mgBody", { into: "mp-b1" });
  assert.deepEqual(ids(pg), ["mp-b1", "mp-b2", "mp-b3"]);
  assert.equal(pg.G.state.customerAliases.length, 0);
});

test("a hand-added customer can be merged into a Manapool one, and keeps nothing it shouldn't", async () => {
  const pg = await page();
  const walkIn = pg.G.addCustomer({ name: "Dana at the shop", email: "dana@example.com", emailOk: true });
  pg.G.persist("Add customer");
  await clickRow(pg, "custBody", { id: walkIn.id });
  await pg.$("cdMerge").fire("click");
  await clickRow(pg, "mgBody", { into: "mp-b1" });
  const { msg } = pg.dialogs[0];
  assert.match(msg, /takes the email dana@example\.com, with its OK to email/);
  assert.doesNotMatch(msg, /future Manapool orders/, "a walk-in with no orders has none to redirect");
  const kept = pg.G.state.customers.find(c => c.id === "mp-b1");
  assert.equal(kept.email, "dana@example.com");
  assert.equal(kept.emailOk, true);
  assert.ok(!pg.G.state.customers.some(c => c.id === walkIn.id));
});
