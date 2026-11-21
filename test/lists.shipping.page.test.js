"use strict";
/* #188: Order Fulfillment's "Weigh & manifest" step exists only when a
   shipping API is connected (/api/meta's `shipping`). Without one the page
   has five steps, the bulk bar has a plain "Mark shipped", and a picked
   ticket shows just where it's going and a Mark shipped button. With one,
   everything is as before. Driven through the real lists.page.js with the
   stand-in DOM (test-lib/page-shim.js). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("../test-lib/page-shim");

// meta: what /api/meta answers, or "fail" for an error.
async function pickedTicketPage(meta) {
  const pg = loadPage("lists.page.js", { routes: url => {
    if (url === "/api/meta") {
      if (meta === "fail") return { __status: 500, error: "down" };
      return meta;
    }
    if (url === "/api/manapool/orders/cached") {
      return { orders: [{ id: "o1", label: "100-1", status: "delivered", lines: [],
        ship: { name: "Ann Buyer", city: "Austin", state: "TX" } }] };
    }
    return {};
  } });
  const G = pg.G;
  const p = G.newPickList({ source: "manual" });
  p.id = "PL-7";
  p.status = "picked";
  p.lines.push({ name: "Sol Ring", set: "c21", collector: "263", qty: 2 });
  G.pickLists().push(p);
  await pg.boot();
  await pg.$("tabPick").fire("click");
  // Open the ticket the way a click on its queue row does.
  const row = pg.$("pickQueueBody").children.find(tr => tr.innerHTML.includes("PL-7"));
  row.onclick();
  // The bulk bar acts on the ticked tickets; tick this one (the only one on
  // screen) with Select all.
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  return { pg, G, p, row };
}

const stepLabels = html => [...html.matchAll(/class="step-label">([^<]*)</g)].map(m => m[1]);
const stepDots = html => (html.match(/class="step-dot"/g) || []).length;

for (const [why, meta] of [["shipping is false", { shipping: false }], ["meta has no shipping flag", {}],
  ["/api/meta fails", "fail"]]) {
  test("no shipping API (" + why + "): five steps, no weigh & manifest anywhere", async () => {
    const { pg, row } = await pickedTicketPage(meta);
    const full = pg.$("pickStepper").innerHTML;
    assert.deepEqual(stepLabels(full),
      ["Choose order(s)", "Generate pick list", "Pick the lines", "Complete pick list", "Ship"]);
    assert.match(full, /class="step current"[^>]*title="5\. Ship"/, "Ship is the current step of a picked ticket");
    assert.equal(stepDots(row.innerHTML), 5, "the queue's compact stepper has five dots too");
    assert.doesNotMatch(full + row.innerHTML, /Weigh/i);
    assert.equal(pg.$("pqGoWeigh").hidden, true);
    assert.equal(pg.$("pqSkipWeigh").textContent, "Mark shipped");
  });
}

test("no shipping API: a picked ticket shows its ship-to line and Mark shipped only", async () => {
  const { pg, p, row } = await pickedTicketPage({ shipping: false });
  // Its order, loaded from the orders cache, gives the ship-to line.
  // (Filtered out of the Orders table: the stand-in DOM can't draw an order
  // row's buttons, and only the loaded order matters here.)
  p.orderId = "o1";
  pg.$("mpStatusFilter").value = "open";
  await pg.$("mpCached").fire("click");
  row.onclick();
  const panel = pg.$("pickActionArea").innerHTML;
  assert.match(panel, /Ship to: Ann Buyer — Austin, TX/);
  assert.match(panel, /id="pickShipGrimoire"[^>]*>Mark shipped</);
  for (const gone of ["odWeight", "odService", "odLabel", "wmTopLoader", "wmEnvelope", "Weigh", "shipping label"]) {
    assert.ok(!panel.includes(gone), "no " + gone + " on the panel");
  }
});

test("no shipping API: the panel's Mark shipped marks the ticket shipped, same status as before", async () => {
  const { pg, p } = await pickedTicketPage({ shipping: false });
  await pg.$("pickShipGrimoire").fire("click");
  assert.equal(p.status, "shipped");
});

test("no shipping API: the bulk Mark shipped asks first, without mentioning weighing or labels", async () => {
  const { pg, p } = await pickedTicketPage({ shipping: false });
  await pg.$("pqSkipWeigh").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /^Mark 1 ticket\(s\) shipped\?/);
  assert.doesNotMatch(pg.ui.confirms[0], /weigh|manifest|label/i);
  assert.equal(p.status, "shipped");
});

test("no shipping API: the Go to weigh & manifest action does nothing even if called", async () => {
  const { pg } = await pickedTicketPage({ shipping: false });
  let scrolled = false;
  pg.$("pickStepper").scrollIntoView = () => { scrolled = true; };
  await pg.$("pqGoWeigh").fire("click");
  assert.equal(scrolled, false);
});

test("shipping API connected: six steps with Weigh & manifest, as before", async () => {
  const { pg, row } = await pickedTicketPage({ shipping: true });
  const full = pg.$("pickStepper").innerHTML;
  assert.deepEqual(stepLabels(full),
    ["Choose order(s)", "Generate pick list", "Pick the lines", "Complete pick list", "Weigh &amp; manifest", "Ship"]);
  assert.match(full, /class="step current"[^>]*title="5\. Weigh &amp; manifest"/);
  assert.equal(stepDots(row.innerHTML), 6);
  assert.equal(pg.$("pqGoWeigh").hidden, false);
  assert.equal(pg.$("pqSkipWeigh").textContent, "Skip weigh & manifest → mark shipped");
});

test("shipping API connected: a picked ticket keeps the weigh & manifest panel", async () => {
  const { pg } = await pickedTicketPage({ shipping: true });
  const panel = pg.$("pickActionArea").innerHTML;
  for (const kept of ["<h3>Weigh &amp; Manifest</h3>", 'id="odWeight"', 'id="odService"', 'id="odLabel"',
    'id="wmTopLoader"', ">Skip weigh &amp; manifest<"]) {
    assert.ok(panel.includes(kept), "panel has " + kept);
  }
});

test("shipping API connected: the bulk skip keeps its weigh & manifest wording", async () => {
  const { pg, p } = await pickedTicketPage({ shipping: true });
  await pg.$("pqSkipWeigh").fire("click");
  assert.match(pg.ui.confirms[0], /^Skip weigh & manifest and mark 1 ticket\(s\) shipped\?/);
  assert.equal(p.status, "shipped");
});

test("shipping API connected: Go to weigh & manifest opens the ticket", async () => {
  const { pg } = await pickedTicketPage({ shipping: true });
  let scrolled = false;
  pg.$("pickStepper").scrollIntoView = () => { scrolled = true; };
  await pg.$("pqGoWeigh").fire("click");
  assert.equal(scrolled, true);
});
