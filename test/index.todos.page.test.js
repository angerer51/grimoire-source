"use strict";
/* #299: more kinds of Things to do on the Dashboard. Through the real
   public/index.page.js with the page-shim's stand-in DOM: each new to-do
   shows with its count, only above 0, Simple mode leaves out the ones for
   pages it hides, and a failed optional fetch stays quiet. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const DAY = 86400000;
const old = new Date(Date.now() - 100 * DAY).toISOString();

async function open(o) {
  const opts = o || {};
  const user = { id: "u1", username: "u", createdAt: "2026-01-01T00:00:00Z", email: "", orgId: null, orgRole: null, role: "user" };
  const state = Object.assign({
    cards: [
      { id: "c1", name: "Bolt", set: "lea", collector: "161", quantity: 2, locationId: "l1", typeLine: "Instant", price: 5, listedQty: 1 },
      { id: "c2", name: "Mystery", quantity: 1, locationId: "l1", typeLine: "Instant", price: null, listedQty: 1 }
    ],
    locations: [{ id: "l1", name: "Box", type: "box", createdAt: old, putaway: { enabled: true } }],
    pickLists: [{ id: "p1", orderId: "o1", status: "picked", lines: [{ qty: 1 }] }, { id: "p2", orderId: "o2", status: "picked", lines: [{ qty: 1 }] },
      { id: "p3", orderId: "o3", status: "shipped", lines: [{ qty: 1 }] }],
    customers: [{ id: "k1", name: "Kay" }],
    customerWants: [{ id: "w1", customerId: "k1", name: "Bolt" }],
    settings: Object.assign({}, opts.settings || {})
  }, opts.state || {});
  const routes = (url) => {
    if (url === "/api/auth/me") return { user, personalPrefs: null };
    if (url === "/api/collection") return { rev: 1, savedAt: null, state, owner: "u1" };
    if (url === "/api/tickets") return opts.tickets || { tickets: [{ status: "open", messages: [{ from: "staff" }] }] };
    if (url === "/api/trades") {
      if (opts.tradesFail) throw new Error("down");
      return { data: [{ incoming: true, outgoing: false, status: "open" }, { incoming: true, outgoing: false, status: "open" }] };
    }
    if (url === "/api/friends") { if (opts.tradesFail) throw new Error("down"); }
    if (url === "/api/friends") return { requests: { incoming: [{}] } };
    return {};
  };
  const page = loadPage("index.page.js", { routes });
  await page.G.load();
  await page.boot();
  await settle(10);
  page.todos = () => page.$("alerts").innerHTML;
  return page;
}

test("#299: each new to-do shows with its count and a link", async () => {
  const t = (await open()).todos();
  assert.match(t, /2 orders picked, waiting to ship/);
  assert.match(t, /1 location overdue for a count/);
  assert.match(t, /1 wanted card in stock for 1 customer/);
  assert.match(t, /1 listing with no price to send/);
  assert.match(t, /1 support ticket waiting on your reply/);
  assert.match(t, /2 trade offers waiting for your answer/);
  assert.match(t, /1 friend request waiting for you/);
  assert.match(t, /href="\/lists\.html"/);
});

test("#299: a to-do goes away once it's cleared", async () => {
  const t = (await open({
    tickets: { tickets: [] },
    state: { pickLists: [], customerWants: [], cards: [{ id: "c1", name: "Bolt", quantity: 1, locationId: "l1", typeLine: "Instant", price: 5 }],
      locations: [{ id: "l1", name: "Box", createdAt: new Date().toISOString(), putaway: { enabled: true } }] }
  })).todos();
  assert.doesNotMatch(t, /picked, waiting|overdue|wanted card|no price to send|support ticket/);
});

test("#299: Simple mode leaves out to-dos for pages it hides", async () => {
  const t = (await open({ settings: { simpleMode: true } })).todos();
  assert.doesNotMatch(t, /picked, waiting|overdue|wanted card|no price to send/);
  assert.match(t, /support ticket/);
  assert.match(t, /trade offers/);
});

test("#299: a failed trades fetch adds no to-do and no error", async () => {
  const t = (await open({ tradesFail: true })).todos();
  assert.doesNotMatch(t, /trade offer|friend request/);
  assert.match(t, /orders picked/);
});
