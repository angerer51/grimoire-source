"use strict";
/* Order Fulfillment's search boxes (#198), one per tab, through the real
   lists.page.js with the stand-in DOM (test-lib/page-shim.js). The matching
   itself is tested in test/core.fulfillmentSearch.test.js; this checks the
   wiring: what each box filters, that it works with the status filter, the
   empty state, and that ticked orders and tickets the search hides stay
   ticked and are said to be hidden. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const ORDERS = [
  { id: "u-1", label: "100-1", status: "unfulfilled", buyer: "Dana Reyes", ship: { name: "Dana Reyes" },
    lines: [{ name: "Lightning Bolt", qty: 1 }] },
  { id: "u-2", label: "100-2", status: "shipped", buyer: "Marcus Lee", ship: { name: "Marcus Lee" },
    lines: [{ name: "Sol Ring", qty: 2 }] },
  { id: "u-3", label: "100-3", status: "processing", buyer: "Ann Buyer", ship: { name: "Ann Buyer" },
    lines: [{ name: "Lightning Bolt", qty: 4 }] }
];

async function page() {
  const pg = loadPage("lists.page.js", { routes: url => {
    if (url === "/api/meta") return { manapool: true };
    if (url === "/api/manapool/orders") return { orders: JSON.parse(JSON.stringify(ORDERS)) };
    return {};
  } });
  // The stand-in DOM can't find an order row's buttons or checkbox inside
  // its innerHTML; hand each row real stand-ins to wire up.
  const doc = pg.sandbox.document, make = doc.createElement;
  doc.createElement = tag => {
    const el = make(tag);
    const q = {};
    el.querySelector = sel => (q[sel] = q[sel] || make("input"));
    el.querySelectorAll = sel => sel === "button" ? [make("button"), make("button"), make("button")] : [];
    return el;
  };
  const G = pg.G;
  const pl = (id, orderId, orderLabel, status, card) => {
    const p = G.newPickList({ source: orderId ? "manapool" : "manual", orderId, orderLabel });
    p.id = id;
    p.status = status;
    p.lines.push({ name: card, set: "c21", collector: "1", qty: 1 });
    G.pickLists().push(p);
    return p;
  };
  pl("PICK-2026-0001", "u-1", "100-1", "open", "Lightning Bolt");
  pl("PICK-2026-0002", "u-2", null, "shipped", "Sol Ring");        // label only in the orders cache
  pl("PICK-2026-0003", "u-3", "100-3", "picked", "Lightning Bolt");
  pl("PICK-2026-0004", null, null, "open", "Counterspell");         // manual
  await pg.boot();
  await settle(10);
  return { pg, G };
}
const orderRows = pg => pg.$("mpBody").children.filter(tr => tr.className === "click");
const shownLabels = pg => orderRows(pg).map(tr => (tr.innerHTML.match(/<b>([^<]*)<\/b>/) || [])[1]);
// The queue row's Order cell: the one after the checkbox.
const queueTickets = pg => pg.$("pickQueueBody").children
  .map(tr => (tr.innerHTML.match(/class="pqPick"[^>]*><\/td><td>([^<]*)<\/td>/) || [])[1]);
async function search(pg, id, q) { pg.$(id).value = q; await pg.$(id).fire("input"); }
function tick(tr) {
  const cb = tr.querySelector(".mppick");
  cb.checked = true;
  cb.onclick({ target: cb, stopPropagation() {} });
}

test("Orders: the box filters by order number, customer, card name and pick ticket; clearing it brings all back", async () => {
  const { pg } = await page();
  assert.deepEqual(shownLabels(pg), ["100-1", "100-2", "100-3"]);
  await search(pg, "mpSearch", "100-2");
  assert.deepEqual(shownLabels(pg), ["100-2"]);
  await search(pg, "mpSearch", "MARCUS");
  assert.deepEqual(shownLabels(pg), ["100-2"]);
  await search(pg, "mpSearch", "bolt");
  assert.deepEqual(shownLabels(pg), ["100-1", "100-3"]);
  await search(pg, "mpSearch", "bolt ann");
  assert.deepEqual(shownLabels(pg), ["100-3"], "every word must match");
  await search(pg, "mpSearch", "pick-2026-0001");
  assert.deepEqual(shownLabels(pg), ["100-1"]);
  await search(pg, "mpSearch", "u-3");
  assert.deepEqual(shownLabels(pg), ["100-3"], "the internal id too");
  await search(pg, "mpSearch", "");
  assert.deepEqual(shownLabels(pg), ["100-1", "100-2", "100-3"]);
});

test("Orders: the search works within the status filter, and an empty result says so", async () => {
  const { pg } = await page();
  pg.$("mpStatusFilter").value = "open";
  await search(pg, "mpSearch", "sol ring");
  assert.deepEqual(shownLabels(pg), []);
  assert.match(pg.$("mpBody").innerHTML, /\[emptyrow 10:No orders match “sol ring” in this status filter\.\]/);
  pg.$("mpStatusFilter").value = "";
  await pg.$("mpStatusFilter").fire("change");
  assert.deepEqual(shownLabels(pg), ["100-2"]);
});

test("Orders: the search text is escaped in the empty state", async () => {
  const { pg } = await page();
  await search(pg, "mpSearch", "<img src=x>");
  assert.match(pg.$("mpBody").innerHTML, /&lt;img src=x&gt;/);
});

test("Orders: a ticked order the search hides stays ticked, is counted as hidden, and Generate includes it", async () => {
  const { pg, G } = await page();
  tick(orderRows(pg).find(tr => tr.innerHTML.includes("100-3")));
  assert.equal(pg.$("mpSel").textContent, "1 ticked");
  await search(pg, "mpSearch", "dana");
  assert.equal(pg.$("mpSel").textContent, "1 ticked · 1 hidden by the search or status filter");
  // Select all adds what's on screen (Dana's order) to it.
  pg.$("mpAll").checked = true;
  await pg.$("mpAll").fire("change");
  assert.equal(pg.$("mpSel").textContent, "2 ticked · 1 hidden by the search or status filter");
  assert.match(orderRows(pg)[0].innerHTML, / checked>/, "the shown row draws ticked");
  await search(pg, "mpSearch", "");
  assert.equal(pg.$("mpSel").textContent, "2 ticked");
  await search(pg, "mpSearch", "dana");
  // One ticked order is hidden, so Generate asks first. Cancel: nothing
  // happens and the ticks stay.
  pg.ui.confirmAnswer = false;
  await pg.$("mpBulkPick").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.equal(pg.ui.confirms[0],
    "1 of the 2 ticked orders is hidden by your search or status filter. Generate pick lists for all 2 anyway?");
  assert.equal(pg.ui.toasts.length, 0);
  assert.equal(pg.$("mpSel").textContent, "2 ticked · 1 hidden by the search or status filter");
  // Yes: both already have pick lists, so it makes none, but covers both and
  // unticks the batch.
  pg.ui.confirmAnswer = true;
  await pg.$("mpBulkPick").fire("click");
  assert.ok(pg.ui.toasts.some(t => /2 already had one\./.test(t)), pg.ui.toasts.join(" | "));
  assert.equal(pg.$("mpSel").textContent, "");
  assert.equal(G.pickLists().length, 4);
});

test("Orders: Generate doesn't ask when every ticked order is on screen", async () => {
  const { pg } = await page();
  await search(pg, "mpSearch", "bolt");
  pg.$("mpAll").checked = true;
  await pg.$("mpAll").fire("change");
  assert.equal(pg.$("mpSel").textContent, "2 ticked");
  await pg.$("mpBulkPick").fire("click");
  assert.equal(pg.ui.confirms.length, 0);
  assert.ok(pg.ui.toasts.some(t => /2 already had one\./.test(t)), pg.ui.toasts.join(" | "));
});

test("Pick list: a shipped ticket ticked while searching isn't counted as selected for the bulk actions", async () => {
  const { pg } = await page();
  await pg.$("tabPick").fire("click");
  await search(pg, "pqSearch", "100");     // 0001 (open), 0002 (shipped), 0003 (picked)
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  assert.equal(pg.$("pqStatus").textContent, "2 ticket(s) selected · 1 shipped ticket(s) ticked, nothing to do for it");
  await search(pg, "pqSearch", "marcus");  // only the shipped one on screen
  assert.equal(pg.$("pqStatus").textContent,
    "2 ticket(s) selected (2 of them hidden by the search) · 1 shipped ticket(s) ticked, nothing to do for it");
});

test("Pick list: the box filters tickets by number, order number, customer and card, shipped ones included", async () => {
  const { pg } = await page();
  await pg.$("tabPick").fire("click");
  assert.deepEqual(queueTickets(pg), ["100-1", "100-3", "PICK-2026-0004"], "no search: tickets not yet shipped");
  assert.equal(pg.$("pqSearchNote").hidden, true);
  await search(pg, "pqSearch", "0003");
  assert.deepEqual(queueTickets(pg), ["100-3"]);
  await search(pg, "pqSearch", "100-2");
  assert.deepEqual(queueTickets(pg), ["100-2"], "a shipped ticket, its number from the orders cache");
  assert.equal(pg.$("pqSearchNote").hidden, false);
  await search(pg, "pqSearch", "marcus");
  assert.deepEqual(queueTickets(pg), ["100-2"]);
  await search(pg, "pqSearch", "counterspell");
  assert.deepEqual(queueTickets(pg), ["PICK-2026-0004"]);
  await search(pg, "pqSearch", "bolt dana");
  assert.deepEqual(queueTickets(pg), ["100-1"]);
  await search(pg, "pqSearch", "nothing like this");
  assert.match(pg.$("pickQueueBody").innerHTML, /\[emptyrow 7:No pick tickets match “nothing like this”\.\]/);
  await search(pg, "pqSearch", "");
  assert.deepEqual(queueTickets(pg), ["100-1", "100-3", "PICK-2026-0004"]);
});

test("Pick list: a ticked ticket the search hides stays ticked, counted as hidden, and the bulk action names it", async () => {
  const { pg, G } = await page();
  await pg.$("tabPick").fire("click");
  await search(pg, "pqSearch", "bolt");
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  assert.equal(pg.$("pqStatus").textContent, "2 ticket(s) selected");
  await search(pg, "pqSearch", "100-3");
  assert.equal(pg.$("pqStatus").textContent, "2 ticket(s) selected (1 of them hidden by the search)");
  assert.equal(pg.$("pqComplete").disabled, false, "the hidden open ticket still counts");
  pg.ui.confirmAnswer = false;
  await pg.$("pqComplete").fire("click");
  assert.match(pg.ui.confirms[0], /^Complete 1 pick list \(1 of them hidden by the search\)\?/);
  await search(pg, "pqSearch", "");
  assert.equal(pg.$("pqStatus").textContent, "2 ticket(s) selected");
  assert.equal(G.pickLists().find(p => p.id === "PICK-2026-0001").status, "open", "cancelled: nothing completed");
});

/* #289: order details show the boxed ×N badge for a line needing more than one. */
test("order details: qty 2 is the boxed badge, qty 1 stays plain (#289)", async () => {
  const { pg } = await page();
  for (const [i, want] of [[0, /data-v="1">1<\/td>/], [1, /data-v="2"><span class='qty-multi'>×2<\/span><\/td>/]]) {
    const tr = orderRows(pg)[i];
    await tr.onclick({ target: tr });
    assert.match(pg.$("odBody").innerHTML, want);
  }
});
