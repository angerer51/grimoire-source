"use strict";
/* Customers page's Lifetime spend column (#195), through the real
   customers.page.js with a stand-in DOM (test-lib/page-shim.js). The sum
   itself is G.customerOrders (test/core.customers.test.js); this checks the
   cell: sortable on data-v, a dash for no orders, "not cached" when none of
   their orders are left in the cache, and a "+" (explained under the
   table) when only some are. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const order = (id, buyerId, name, total) => ({ id, buyerId, buyer: name, label: "L-" + id,
  placedAt: "2026-09-0" + id.slice(-1) + "T00:00:00Z", total, ship: { name } });

async function customersPage(cached) {
  const pg = loadPage("customers.page.js", { routes: url =>
    url === "/api/manapool/orders/cached" ? { orders: cached } : {} });
  const G = pg.G;
  // Dana: two orders, one refunded in part. Marcus: one cached, one gone
  // from the cache. Lee: only an order that's gone. Walk-in: added by hand.
  G.syncCustomersFromOrders([order("o1", "b1", "Dana"), order("o2", "b1", "Dana"),
    order("o3", "b2", "Marcus"), order("o4", "b2", "Marcus"), order("o5", "b3", "Lee")]);
  G.addCustomer({ name: "Walk-in" });
  G.state.returns.push({ orderId: "o1", orderLabel: "L-o1", refundTotal: 5 });
  await pg.boot();
  await settle(10);
  return pg;
}
// One <tr> per customer; innerHTML is a plain string here.
function rowOf(pg, name) {
  return pg.$("custBody").innerHTML.split("<tr").find(r => r.includes(">" + name + "<")) || "";
}

test("the table's Lifetime spend is paid minus refunds, sortable on data-v", async () => {
  const pg = await customersPage([order("o1", "b1", "Dana", 20), order("o2", "b1", "Dana", 12.5),
    order("o3", "b2", "Marcus", 7)]);
  const dana = rowOf(pg, "Dana");
  assert.match(dana, /data-v="27.5"/);
  assert.match(dana, /\$27\.50/);
  assert.match(dana, /\$5\.00 refunded taken off/, "the tooltip says a refund came off");
  assert.doesNotMatch(dana, /or more/);
});

test("some orders out of the cache: a '+', and the note under the table shows", async () => {
  const pg = await customersPage([order("o1", "b1", "Dana", 20), order("o2", "b1", "Dana", 12.5),
    order("o3", "b2", "Marcus", 7)]);
  const marcus = rowOf(pg, "Marcus");
  assert.match(marcus, /data-v="7"/);
  assert.match(marcus, /aria-label="or more">\+</);
  assert.match(marcus, /1 older order no longer in the orders cache/);
  assert.equal(pg.$("custSpendNote").hidden, false);
});

test("all orders out of the cache says so; a hand-added customer is a dash; neither is NaN", async () => {
  const pg = await customersPage([order("o1", "b1", "Dana", 20)]);
  const lee = rowOf(pg, "Lee"), walkIn = rowOf(pg, "Walk-in");
  assert.match(lee, /data-v=""/);
  assert.match(lee, /not cached/);
  assert.match(walkIn, /data-v=""><span class="faint">—</);
  assert.doesNotMatch(pg.$("custBody").innerHTML, /NaN/);
});

test("an order refunded on Manapool counts $0, and the tooltip says why", async () => {
  const pg = await customersPage([order("o1", "b1", "Dana", 20), Object.assign(order("o2", "b1", "Dana", 12.5),
    { status: "refunded" }), order("o3", "b2", "Marcus", 7)]);
  const dana = rowOf(pg, "Dana");
  // 20 paid on o1 minus its $5 Return; o2 refunded on Manapool counts nothing.
  assert.match(dana, /data-v="15"/);
  assert.match(dana, /\$17\.50 refunded taken off \(1 order refunded on Manapool\)/);
});

test("nothing partial: the note under the table stays hidden", async () => {
  const pg = loadPage("customers.page.js", { routes: url =>
    url === "/api/manapool/orders/cached" ? { orders: [order("o1", "b1", "Dana", 20)] } : {} });
  pg.G.syncCustomersFromOrders([order("o1", "b1", "Dana")]);
  await pg.boot();
  await settle(10);
  assert.equal(pg.$("custSpendNote").hidden, true);
});
