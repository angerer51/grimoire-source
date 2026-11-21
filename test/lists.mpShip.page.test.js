"use strict";
/* #454: Mark shipped on Order Fulfillment also marks a Manapool order shipped
   on Manapool, through one table with a row per order (carrier, tracking #;
   tracking required only on Ground Advantage orders), and keeps how it went on the ticket so a failure shows
   "not sent to Manapool" with Retry. Driven through the real lists.page.js
   and core.js with the stand-in DOM (test-lib/page-shim.js); the server's
   answer is a fake route, so nothing reaches Manapool. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("../test-lib/page-shim");

// Objects made inside the page's sandbox, compared as plain data.
const plain = v => JSON.parse(JSON.stringify(v));
const FULFIL = /^\/api\/manapool\/order\/([^/]+)\/fulfillment$/;

/* PL-1: first-class order o1. PL-2: Ground Advantage order o2. PL-3: a
   manual ticket (no order). All picked, waiting to ship. reply(orderId, body)
   is what the server answers for each push. */
async function shipPage(opts) {
  const o = opts || {};
  const pushes = [];
  const state = { reply: o.reply || ((id, body) => ({ ok: true, at: "2026-11-11T12:00:00.000Z", status: "shipped",
    tracking: body.tracking ? Object.assign({ url: "" }, body.tracking) : null, alreadyDone: false })) };
  const pg = loadPage("lists.page.js", { routes: (url, init, body) => {
    if (url === "/api/meta") return { shipping: !!o.shipping, manapool: o.manapool !== false };
    if (url === "/api/manapool/orders/cached") {
      return { orders: [
        { id: "o1", label: "100-1", status: "unfulfilled", lines: [], shippingMethod: "first_class",
          ship: { name: "Ann Buyer", city: "Austin", state: "TX" }, grimoire: o.labelTracking1 ? { tracking: o.labelTracking1 } : undefined },
        { id: "o2", label: "100-2", status: "unfulfilled", lines: [], raw: { shipping_method: "ground_advantage" },
          ship: { name: "Bo Seller", city: "Reno", state: "NV" },
          grimoire: o.labelTracking ? { tracking: o.labelTracking } : undefined }] };
    }
    const m = FULFIL.exec(url);
    if (m) {
      const parsed = typeof body === "string" ? JSON.parse(body) : (init && init.body ? JSON.parse(init.body) : body);
      pushes.push({ orderId: decodeURIComponent(m[1]), body: parsed });
      return state.reply(m[1], parsed);
    }
    return {};
  } });
  const G = pg.G;
  const add = (id, orderId) => {
    const p = G.newPickList(orderId ? { source: "manapool", orderId } : { source: "manual" });
    p.id = id;
    p.status = "picked";
    p.lines.push({ name: "Sol Ring", set: "c21", collector: "263", qty: 1 });
    G.pickLists().push(p);
    return p;
  };
  add("PL-1", "o1"); add("PL-2", "o2"); add("PL-3", null);
  await pg.boot();
  // The orders cache, so the page knows each order's shipping method. (Kept
  // out of the Orders table by its search: the stand-in DOM can't draw an
  // order row's buttons, and only the loaded orders matter here.)
  pg.$("mpSearch").value = "no-such-order-zz";
  if (!o.ordersNotLoaded) await pg.$("mpCached").fire("click");
  await pg.$("tabPick").fire("click");
  const open = id => pg.$("pickQueueBody").children.find(tr => tr.innerHTML.includes(id)).onclick();
  const pick = id => G.pickLists().find(p => p.id === id);
  const tick = () => new Promise(r => setTimeout(r, 0));
  return { pg, G, pushes, state, open, pick, tick };
}

test("orderNeedsTracking / pickNeedsTracking: Ground Advantage only; a ticket without its order loaded uses what it saved", async () => {
  const { G } = await shipPage();
  assert.equal(G.orderNeedsTracking({ shippingMethod: "ground_advantage" }), true);
  assert.equal(G.orderNeedsTracking({ raw: { shipping_method: "ground_advantage" } }), true);
  assert.equal(G.orderNeedsTracking({ shippingMethod: "first_class" }), false);
  assert.equal(G.orderNeedsTracking({}), false);
  const t = { source: "manapool", orderId: "zz", shippingMethod: "ground_advantage" };
  assert.equal(G.pickNeedsTracking(t, []), true);
  assert.equal(G.pickNeedsTracking(t, [{ id: "zz", shippingMethod: "first_class" }]), false, "the loaded order wins");
  assert.equal(G.pickNeedsTracking({ source: "walkin", orderId: "zz", shippingMethod: "ground_advantage" }, []), false);
  assert.equal(G.pickNeedsTracking({ source: "manual", shippingMethod: "ground_advantage" }, []), false);
});

test("a new Manapool ticket saves the order's shipping method", async () => {
  const { G } = await shipPage();
  const r = await G.ensureOrderPickList({ id: "o9", label: "9", lines: [{ name: "Sol Ring", qty: 1 }],
    raw: { shipping_method: "ground_advantage" } });
  assert.equal(r.pickList.shippingMethod, "ground_advantage");
});


/* The table's row index for an order label (rows follow the selection order). */
function rowOf(pg, label) {
  const rows = pg.$("mpShipBody").innerHTML.split("<tr data-id=").slice(1);
  const row = rows.find(r => r.includes(">" + label + "<"));
  return row ? Number(/id="mpNo-(\d+)"/.exec(row)[1]) : -1;
}
const rowsOf = pg => pg.$("mpShipBody").innerHTML.split("<tr data-id=").slice(1);
const type = async (pg, id, v) => { pg.$(id).value = v; await pg.$(id).fire("input"); };

test("one first-class ticket: the table with one row, tracking optional; empty sends no tracking", async () => {
  const { pg, pushes, open, pick, tick } = await shipPage();
  open("PL-1");
  const done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  const body = pg.$("mpShipBody").innerHTML;
  assert.equal(rowsOf(pg).length, 1, "one row");
  assert.match(body, />100-1</);
  assert.match(body, /Ann Buyer/);
  assert.match(body, /Austin, TX/);
  assert.match(body, /id="mpCo-0" value="USPS"/);
  assert.match(body, /id="mpNo-0" value=""[^>]*placeholder="Optional"/);
  assert.doesNotMatch(body, /Tracking required/, "no row needs it, and the lead doesn't mention it");
  assert.doesNotMatch(body, /mpShipAllCo/, "no Set all for one row");
  assert.equal(pg.$("mpShipOk").disabled, false);
  assert.equal(pg.$("mpShipOk").textContent, "Mark 1 ticket shipped");
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.equal(pick("PL-1").status, "shipped");
  assert.deepEqual(pushes, [{ orderId: "o1", body: { tracking: null } }]);
  assert.equal(pick("PL-1").manapoolShip.ok, true);
  assert.ok(pg.ui.toasts.some(t => /Marked shipped on Manapool too/.test(t)));
  assert.equal(pg.$("pickCount").textContent, "2", "gone from the queue");
});

test("a first-class order with a tracking number typed sends it too", async () => {
  const { pg, pushes, open, tick } = await shipPage();
  open("PL-1");
  const done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  pg.$("mpCo-0").value = "UPS";
  await type(pg, "mpNo-0", " 1Z999 ");
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.deepEqual(pushes, [{ orderId: "o1", body: { tracking: { company: "UPS", number: "1Z999" } } }]);
});

test("one Ground Advantage ticket: marked Tracking required, can't be confirmed until it has a number", async () => {
  const { pg, pushes, open, pick, tick } = await shipPage();
  open("PL-2");
  const done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  const body = pg.$("mpShipBody").innerHTML;
  assert.match(body, /Tracking required/);
  assert.match(body, /placeholder="Required" required aria-required="true"/);
  assert.equal(pg.$("mpShipOk").disabled, true);
  assert.match(pg.$("mpShipErr").textContent, /1 order\(s\) still need a tracking number: 100-2/);
  await pg.$("mpShipOk").fire("click");
  assert.equal(pick("PL-2").status, "picked", "a click on the disabled button does nothing");
  await type(pg, "mpNo-0", "9400111");
  assert.equal(pg.$("mpShipOk").disabled, false);
  assert.equal(pg.$("mpShipErr").textContent, "");
  pg.$("mpCo-0").value = "USPS";
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.equal(pick("PL-2").status, "shipped");
  assert.deepEqual(pushes, [{ orderId: "o2", body: { tracking: { company: "USPS", number: "9400111" } } }]);
  assert.deepEqual(plain(pick("PL-2").manapoolShip.tracking), { company: "USPS", number: "9400111", url: "" });
});

test("Cancel leaves the ticket as it was", async () => {
  const { pg, pushes, open, pick, tick } = await shipPage();
  open("PL-2");
  const done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  await pg.$("mpShipCancel").fire("click");
  await done;
  assert.equal(pick("PL-2").status, "picked");
  assert.equal(pushes.length, 0);
});

test("a label's tracking number is filled in on any order, first class included", async () => {
  const { pg, open, tick } = await shipPage({ shipping: true, labelTracking: "9205590", labelTracking1: "9205111" });
  open("PL-1");
  let done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  assert.match(pg.$("mpShipBody").innerHTML, /id="mpNo-0" value="9205111"/);
  await pg.$("mpShipCancel").fire("click");
  await done;
  open("PL-2");
  done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  assert.match(pg.$("mpShipBody").innerHTML, /id="mpNo-0" value="9205590"/);
  await pg.$("mpShipCancel").fire("click");
  await done;
});

test("bulk: one row per Manapool order, Set all carriers, required only on Ground Advantage; the manual ticket just ships", async () => {
  const { pg, pushes, pick, tick } = await shipPage();
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  const done = pg.$("pqSkipWeigh").fire("click");
  await tick();
  const body = pg.$("mpShipBody").innerHTML;
  assert.equal(rowsOf(pg).length, 2, "two Manapool rows");
  assert.match(body, /1 other ticket\(s\) are marked shipped in Grimoire only/);
  assert.match(body, /id="mpShipAllCo"/);
  assert.match(body, /table class="list stack-sm" id="mpShipTable" data-sort/);
  const i1 = rowOf(pg, "100-1"), i2 = rowOf(pg, "100-2");
  assert.ok(i1 >= 0 && i2 >= 0 && i1 !== i2);
  assert.match(rowsOf(pg).find(r => r.includes(">100-2<")), /Tracking required/);
  assert.doesNotMatch(rowsOf(pg).find(r => r.includes(">100-1<")), /Tracking required/);
  assert.equal(pg.$("mpShipOk").textContent, "Mark 3 tickets shipped");
  assert.equal(pg.$("mpShipOk").disabled, true);
  pg.$("mpShipAllCo").value = "UPS";
  await pg.$("mpShipAllBtn").fire("click");
  assert.equal(pg.$("mpCo-" + i1).value, "UPS");
  assert.equal(pg.$("mpCo-" + i2).value, "UPS");
  await type(pg, "mpNo-" + i2, "9400222");
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.deepEqual(["PL-1", "PL-2", "PL-3"].map(id => pick(id).status), ["shipped", "shipped", "shipped"]);
  assert.deepEqual(pushes.map(p => p.orderId).sort(), ["o1", "o2"]);
  assert.deepEqual(pushes.find(p => p.orderId === "o2").body.tracking, { company: "UPS", number: "9400222" });
  assert.equal(pushes.find(p => p.orderId === "o1").body.tracking, null, "no number, no tracking");
  assert.equal(pick("PL-3").manapoolShip, undefined);
});

test("bulk of non-Manapool tickets only: the plain question", async () => {
  const { pg, pushes, pick } = await shipPage();
  pick("PL-1").status = "shipped";
  pick("PL-2").status = "shipped";
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  await pg.$("pqSkipWeigh").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /^Mark 1 ticket\(s\) shipped\?/);
  assert.equal(pick("PL-3").status, "shipped");
  assert.equal(pushes.length, 0);
});

test("a ticket another tab shipped while the table was up isn't shipped or sent twice", async () => {
  const { pg, pushes, open, pick, tick } = await shipPage();
  open("PL-1");
  const done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  // The other tab's save lands: shipped and sent there.
  Object.assign(pick("PL-1"), { status: "shipped", shippedAt: "x", manapoolShip: { ok: true, at: "x", status: "shipped", tracking: null } });
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.equal(pushes.length, 0);
  assert.equal(pick("PL-1").shippedAt, "x");
});

test("a refusal: still shipped, kept on the queue as not sent; Retry opens the one-row table and clears it", async () => {
  const { pg, pushes, state, open, pick, tick } = await shipPage();
  state.reply = () => ({ ok: false, at: "2026-11-11T12:00:00.000Z", status: "shipped", tracking: null,
    error: "Mana Pool turned down Grimoire's connection. Reconnect Mana Pool in Settings → Integrations, then retry." });
  open("PL-1");
  let done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  await pg.$("mpShipOk").fire("click");
  await done;
  const p = pick("PL-1");
  assert.equal(p.status, "shipped");
  assert.equal(pg.G.manapoolShipFailed(p), true);
  assert.ok(pg.ui.toasts.some(t => /Not marked shipped on Manapool: Mana Pool turned down/.test(t)));
  assert.equal(pg.$("pickCount").textContent, "3", "still on the queue");
  const row = pg.$("pickQueueBody").children.find(tr => tr.innerHTML.includes("100-1"));
  assert.match(row.innerHTML, /shipped — not sent to Manapool/);
  open("100-1");
  const panel = pg.$("pickActionArea").innerHTML;
  assert.match(panel, /<h3>Not sent to Manapool<\/h3>/);
  assert.match(panel, /Settings → Integrations/);
  assert.match(panel, /id="pickMpRetry"/);
  state.reply = (id, body) => ({ ok: true, at: "2026-11-11T12:05:00.000Z", status: "shipped", tracking: body.tracking, alreadyDone: true });
  done = pg.$("pickMpRetry").fire("click");
  await tick();
  assert.equal(pg.$("mpShipTitle").textContent, "Send to Manapool");
  assert.equal(pg.$("mpShipOk").textContent, "Send to Manapool");
  assert.match(pg.$("mpShipBody").innerHTML, /not sent/);
  await type(pg, "mpNo-0", "9400555");
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.equal(pushes.length, 2);
  assert.deepEqual(pushes[1].body.tracking, { company: "USPS", number: "9400555" }, "tracking added on retry, first class or not");
  assert.equal(pick("PL-1").manapoolShip.ok, true);
  assert.equal(pick("PL-1").status, "shipped", "not shipped again, only sent");
  assert.equal(pg.$("pickCount").textContent, "2", "off the queue once sent");
  assert.match(pg.$("pickActionArea").innerHTML, /Manapool already had this order as shipped/);
});

test("Retry after Manapool asked for tracking marks it required, even if the order looks first-class here", async () => {
  const { pg, state, open, tick } = await shipPage();
  state.reply = () => ({ ok: false, at: "x", status: "shipped", tracking: null, needsTracking: true,
    error: "Manapool needs a tracking number for this order (Ground Advantage). Add it, then retry." });
  open("PL-1");
  let done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  await pg.$("mpShipOk").fire("click");
  await done;
  open("100-1");
  done = pg.$("pickMpRetry").fire("click");
  await tick();
  assert.match(pg.$("mpShipBody").innerHTML, /Tracking required/);
  assert.equal(pg.$("mpShipOk").disabled, true);
  await pg.$("mpShipCancel").fire("click");
  await done;
});

test("bulk Retry: ticking several not-sent tickets and pressing Mark shipped sends them all again", async () => {
  const { pg, pushes, state, pick, tick } = await shipPage();
  state.reply = (id, body) => ({ ok: false, at: "x", status: "shipped", tracking: body.tracking, error: "Couldn't reach Manapool." });
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  let done = pg.$("pqSkipWeigh").fire("click");
  await tick();
  await type(pg, "mpNo-" + rowOf(pg, "100-2"), "9400666");
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.ok(pg.ui.toasts.some(t => /2 order\(s\) weren't marked shipped on Manapool \(Couldn't reach Manapool\.\)/.test(t)));
  assert.equal(pg.$("pickCount").textContent, "2", "both failed ones stay queued");
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  assert.match(pg.$("pqStatus").textContent, /2 not sent to Manapool: Mark shipped sends them again/);
  assert.doesNotMatch(pg.$("pqStatus").textContent, /nothing to do/);
  assert.equal(pg.$("pqSkipWeigh").disabled, false);
  state.reply = (id, body) => ({ ok: true, at: "y", status: "shipped", tracking: body.tracking, alreadyDone: false });
  done = pg.$("pqSkipWeigh").fire("click");
  await tick();
  assert.equal(pg.$("mpShipTitle").textContent, "Send to Manapool");
  assert.match(pg.$("mpShipBody").innerHTML, /id="mpNo-\d" value="9400666"/, "the last try's number filled in");
  await type(pg, "mpNo-" + rowOf(pg, "100-2"), "9400666");
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.equal(pushes.length, 4);
  assert.equal(pick("PL-1").manapoolShip.ok, true);
  assert.equal(pick("PL-2").manapoolShip.ok, true);
  assert.equal(pg.$("pickCount").textContent, "0");
});

test("the server unreachable: recorded as not sent, same as a refusal", async () => {
  const { pg, state, open, pick, tick } = await shipPage();
  state.reply = () => ({ __status: 502, error: "Bad gateway" });
  open("PL-1");
  const done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.equal(pick("PL-1").status, "shipped");
  assert.equal(pick("PL-1").manapoolShip.ok, false);
  assert.match(pick("PL-1").manapoolShip.error, /Couldn't reach Grimoire's server/);
});

test("Manapool off on this server: nothing asked or sent, the ticket just ships", async () => {
  const { pg, pushes, open, pick } = await shipPage({ manapool: false });
  open("PL-2");
  await pg.$("pickShipGrimoire").fire("click");
  assert.equal(pick("PL-2").status, "shipped");
  assert.equal(pushes.length, 0);
  assert.equal(pick("PL-2").manapoolShip, undefined);
});

test("Pick list tab only (orders not loaded): the orders cache is read for the buyer and the shipping method", async () => {
  const { pg, pushes, open, pick, tick } = await shipPage({ ordersNotLoaded: true });
  assert.equal(pick("PL-2").shippingMethod, null);
  open("PL-2");
  const done = pg.$("pickShipGrimoire").fire("click");
  await tick();
  assert.ok(pg.net.some(r => r.url === "/api/manapool/orders/cached"), "read the cache");
  assert.match(pg.$("mpShipBody").innerHTML, /Tracking required/);
  assert.match(pg.$("mpShipBody").innerHTML, /Bo Seller/);
  await type(pg, "mpNo-0", "9400444");
  await pg.$("mpShipOk").fire("click");
  await done;
  assert.equal(pushes[0].body.tracking.number, "9400444");
});
