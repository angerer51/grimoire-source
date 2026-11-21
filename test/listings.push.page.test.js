"use strict";
/* #107: Listings' Push fetches Manapool orders fresh first, through the real
   listings.page.js with a stand-in DOM (test-lib/page-shim.js). A failed
   fetch stops the push; a new order found by it rebuilds the plan and stops
   (the plan moved); otherwise the push sends only the unsold copies. The
   reservation rules themselves are in core.orderReservations.test.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const LINE = { kind: "card", name: "Lightning Bolt", set: "a25", collector: "141", lang: "en",
  finish: "nonfoil", condition: "NM", qty: 1, unitPrice: 1 };
const order = (id, qty) => ({ id, status: "unfulfilled", placedAt: "2026-10-20T10:00:00Z",
  lines: [Object.assign({}, LINE, { qty })] });

function listingsPage(answers) {
  const a = Object.assign({ cached: [], fresh: [] }, answers);
  const pg = loadPage("listings.page.js", {
    routes: (url, init, body) => {
      if (url === "/api/manapool/orders/cached") return { orders: a.cached };
      if (url === "/api/manapool/orders") return a.freshFails ? { __status: 502, error: "Manapool is down" } : { orders: a.fresh };
      if (url === "/api/manapool/list-bulk") {
        return { succeeded: body.items.length, results: body.items.map(i => ({ ok: true, quantity: i.quantity })) };
      }
      return {};
    }
  });
  const G = pg.G;
  G.state.locations.push(G.newLocation({ id: "SELL", name: "Sell box", type: "bin", sellFrom: true }));
  G.state.cards.push({ id: "bolt", name: "Lightning Bolt", set: "a25", collector: "141", lang: "en", finish: "nonfoil",
    condition: "NM", quantity: 3, listedQty: 0, price: 0.5, scryfallId: "abc-123", locationId: "SELL",
    costQty: 0, costTotal: 0, avgCost: null });
  return { pg, G };
}
const pushes = pg => pg.net.filter(n => n.url === "/api/manapool/list-bulk");

test("Evaluate holds back copies on a cached order with no pick list yet (#107)", async () => {
  const { pg } = listingsPage({ cached: [order("o1", 2)] });
  await pg.boot();
  assert.ok(pg.net.some(n => n.url === "/api/manapool/orders/cached"), "the page reads the orders cache");
  assert.match(pg.$("planBody").innerHTML, /2 sold/);
});

test("a push stops and says why when Manapool's orders can't be fetched (#107)", async () => {
  const { pg, G } = listingsPage({ freshFails: true });
  await pg.boot();
  await pg.$("btnPushMp").fire("click");
  await settle();
  assert.equal(pushes(pg).length, 0, "nothing is sent to Manapool");
  assert.match(pg.ui.toasts.join("\n"), /Couldn't fetch your Manapool orders, so nothing was pushed: .*Manapool is down/);
  assert.equal(G.state.cards[0].listedQty, 0);
});

test("a new order found by the push's fetch rebuilds the plan and stops (#107)", async () => {
  const { pg } = listingsPage({ fresh: [order("o1", 1)] });
  await pg.boot();
  await pg.$("btnPushMp").fire("click");
  await settle();
  assert.equal(pushes(pg).length, 0);
  assert.match(pg.ui.toasts.join("\n"), /Manapool orders changed since this plan was built/);
  // Pressed again on the rebuilt plan, it sends only the 2 unsold copies.
  await pg.$("btnPushMp").fire("click");
  await settle();
  assert.equal(pushes(pg).length, 1);
  assert.equal(pushes(pg)[0].body.items[0].quantity, 2);
});
