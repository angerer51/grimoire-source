"use strict";
/* Order Entry → Walk-in Order (#431), through the real walk-in.page.js,
   lists.page.js and accounting.page.js with a stand-in DOM
   (test-lib/page-shim.js): build an order from stock, finish it or send it to
   be picked, hand it over on Order Fulfillment, see it on Accounting. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const INFO = { name: "Sol Ring", collector: "263", setName: "Commander 2021", rarity: "uncommon",
  tcgplayerId: "1", scryfallId: "sol-1", price: 1.5, priceNote: "", note: "", meta: {} };
function stock(G, qty, cost) {
  G.state.locations.push(Object.assign(G.newLocation({ id: "loc1", name: "A-01", type: "bin" }), { sellFrom: true }));
  G.addCopies({ set: "c21", num: "263", lang: "en", finish: "nonfoil", condition: "NM",
    locationId: "loc1", qty, info: INFO, unitCost: cost, action: "receipt", receiptId: "T1", note: "" });
}
async function walkInPage(qty) {
  const pg = loadPage("walk-in.page.js", { routes: url => (url === "/api/order-entry/fetched-orders" ? { orders: [] } : {}) });
  stock(pg.G, qty == null ? 3 : qty, 0.5);
  await pg.boot();
  return pg;
}
async function search(pg, text) {
  pg.$("wiSearch").value = text;
  await pg.$("wiSearch").fire("input");
  await settle(200);   // the search is debounced
}
const addFirst = pg => pg.$("wiFindBody").children[0].querySelector(".wiAdd").fire("click");

test("a search lists the stock with its market price; Add puts it on the order at that price", async () => {
  const pg = await walkInPage();
  await search(pg, "sol");
  assert.equal(pg.$("wiFindBody").children.length, 1);
  assert.match(pg.$("wiFindBody").children[0].innerHTML, /\$1\.50/);
  await addFirst(pg);
  await addFirst(pg);
  assert.equal(pg.$("wiLinesBody").children.length, 1, "the same card twice is one line");
  assert.match(pg.$("wiLinesFoot").innerHTML, /\$3\.00/);
  assert.equal(pg.$("wiSubmit").disabled, false);
});

test("Finish now: the payment is required, then stock comes off and the sale is done", async () => {
  const pg = await walkInPage();
  await search(pg, "sol");
  await addFirst(pg);
  await pg.$("wiModeNow").fire("click");
  assert.equal(pg.$("wiPayWrap").hidden, false);
  await pg.$("wiSubmit").fire("click");
  assert.equal(pg.G.pickLists().length, 0, "no payment chosen, nothing sold");
  pg.$("wiPay").value = "cash";
  await pg.$("wiSubmit").fire("click");
  const p = pg.G.pickLists()[0];
  assert.equal(p.source, "walkin");
  assert.equal(p.status, "shipped");
  assert.equal(p.payment.method, "cash");
  assert.equal(p.payment.total, 1.5);
  assert.equal(pg.G.state.cards[0].quantity, 2);
  assert.ok(pg.ui.toasts.some(t => /Sold \$1\.50 to Walk-in, paid by cash/.test(t)));
  assert.equal(pg.$("wiLinesBody").children.length, 0, "the order is cleared for the next customer");
});

test("Send to be picked with a new customer: the customer is added and the ticket waits", async () => {
  const pg = await walkInPage();
  await search(pg, "sol");
  await addFirst(pg);
  pg.$("wiCustomer").value = "Sam Jones";
  await pg.$("wiCustomer").fire("input");
  assert.equal(pg.$("wiEmailWrap").hidden, false, "a new name can take an email");
  pg.$("wiEmail").value = "sam@example.com";
  await pg.$("wiSubmit").fire("click");
  const p = pg.G.pickLists()[0];
  assert.equal(p.status, "open");
  const c = pg.G.state.customers.find(x => x.name === "Sam Jones");
  assert.ok(c, "added to Customers");
  assert.equal(c.email, "sam@example.com");
  assert.equal(p.customer.id, c.id);
  assert.match(pg.$("wiWaitBody").innerHTML, new RegExp("lists\\.html\\?pick=" + p.id));
  assert.match(pg.$("wiWaitBody").innerHTML, /customers\.html\?id=/);
  assert.equal(pg.G.state.cards[0].quantity, 3, "nothing taken until it's picked");
});

test("a typed price replaces the market price; an existing customer is used, not duplicated", async () => {
  const pg = await walkInPage();
  pg.G.addCustomer({ name: "Ada" });
  await search(pg, "sol");
  await addFirst(pg);
  const row = pg.$("wiLinesBody").children[0];
  row.querySelector(".wi-price").value = "1.00";
  await row.querySelector(".wi-price").fire("input");
  pg.$("wiCustomer").value = "ada";
  await pg.$("wiCustomer").fire("input");
  await pg.$("wiModeNow").fire("click");
  pg.$("wiPay").value = "card";
  await pg.$("wiSubmit").fire("click");
  const p = pg.G.pickLists()[0];
  assert.equal(p.lines[0].unitPrice, 1);
  assert.equal(p.lines[0].marketPrice, 1.5);
  assert.equal(p.customer.name, "Ada");
  assert.equal(pg.G.state.customers.length, 1);
});

/* ---------- Order Fulfillment: hand over, cancel ---------- */
function listsWithWalkIn(status) {
  const pg = loadPage("lists.page.js", { routes: () => ({}) });
  stock(pg.G, 3, 0.5);
  const out = pg.G.enterWalkInOrder({ lines: [{ set: "c21", collector: "263", lang: "en", finish: "nonfoil", condition: "NM",
    name: "Sol Ring", qty: 2, unitPrice: 2 }], customer: { id: "", name: "Sam" }, mode: "pick" });
  const p = out.pickList;
  if (status === "picked") pg.G.completePickList(p.id);
  return { pg, p };
}

test("a picked Walk-in ticket offers Hand over, not label or ship, and records the payment", async () => {
  const { pg, p } = listsWithWalkIn("picked");
  await pg.boot();
  await pg.$("tabPick").fire("click");
  pg.$("pickQueueBody").children[0].onclick();   // open the ticket
  const area = pg.$("pickActionArea").innerHTML;
  assert.match(area, /Hand over and record payment/);
  assert.doesNotMatch(area, /Mark shipped|shipping label/);
  assert.match(area, /\$4\.00/);
  pg.$("hoPay").value = "other";
  await pg.$("hoDone").fire("click");
  assert.equal(p.status, "shipped");
  assert.equal(p.payment.method, "other");
  assert.equal(p.payment.total, 4);
});

test("Mark shipped in bulk leaves a Walk-in ticket alone", async () => {
  const { pg, p } = listsWithWalkIn("picked");
  await pg.boot();
  await pg.$("tabPick").fire("click");
  const box = pg.$("pickQueueBody").children[0].querySelector(".pqPick");
  box.checked = true;
  await box.fire("click");
  assert.equal(pg.$("pqSkipWeigh").disabled, true);
  assert.match(pg.$("pqStatus").textContent, /ready to hand over/);
  assert.equal(p.status, "picked");
});

test("cancelling a picked Walk-in ticket asks first, then puts the cards back", async () => {
  const { pg, p } = listsWithWalkIn("picked");
  await pg.boot();
  await pg.$("tabPick").fire("click");
  pg.$("pickQueueBody").children[0].onclick();
  assert.equal(pg.G.state.cards[0].quantity, 1);
  await pg.$("hoCancel").fire("click");
  assert.match(pg.ui.confirms[0], /go back on the shelf/);
  assert.equal(pg.G.pickLists().length, 0);
  assert.equal(pg.G.state.cards[0].quantity, 3);
  assert.ok(pg.ui.toasts.some(t => /cancelled, 2 card\(s\) put back/.test(t)));
  assert.equal(p.status, "picked", "the ticket object itself is just dropped");
});

test("discarding an open Walk-in ticket is a cancel, and saying no keeps it", async () => {
  const { pg, p } = listsWithWalkIn("open");
  await pg.boot();
  await pg.$("tabPick").fire("click");
  pg.ui.confirmAnswer = false;
  await pg.$("pickClear").fire("click");
  await settle(10);
  assert.match(pg.ui.confirms[0], /free to sell again/);
  assert.equal(pg.G.pickLists().length, 1);
  pg.ui.confirmAnswer = true;
  await pg.$("pickClear").fire("click");
  await settle(10);
  assert.equal(pg.G.pickLists().length, 0);
  assert.equal(p.source, "walkin");
});

/* ---------- Accounting ---------- */
async function accountingWith(setup) {
  const pg = loadPage("accounting.page.js", { routes: () => ({}) });
  stock(pg.G, 3, 0.5);
  setup(pg.G);
  await pg.boot();
  await settle(10);
  return pg;
}
const sell = (G, mode, payment) => G.enterWalkInOrder({ lines: [{ set: "c21", collector: "263", lang: "en", finish: "nonfoil",
  condition: "NM", name: "Sol Ring", qty: 2, unitPrice: 2 }], customer: { id: "", name: "Sam" }, mode, payment }).pickList;

test("Accounting shows a handed-over walk-in as a Counter sale with revenue, cost, no fees, and who bought it", async () => {
  const pg = await accountingWith(G => sell(G, "now", "card"));
  const html = pg.$("acctBody").innerHTML;
  assert.match(html, /Counter sale/);
  assert.match(html, /<td>Sam<\/td>/);
  assert.match(html, /\$4\.00/);
  assert.match(html, /\$1\.00/, "COGS: 2 copies at $0.50");
  assert.match(pg.$("acctTiles").innerHTML, /\$4\.00/);
  let csv = "";
  pg.sandbox.Blob = class { constructor(parts) { csv = parts.join(""); } };
  pg.G.downloadBlob = () => {};
  await pg.$("acctCsv").fire("click");
  const [head, row] = csv.split("\r\n");
  assert.match(head, /,Paid By,Shipping Cost$/);   // Shipping Cost appended after it (#457)
  assert.match(row, /^[^,]+,Counter sale,/);
  assert.match(row, /,Card,$/, "paid by card; a counter sale has no shipping cost");
});

test("a walk-in picked but not yet handed over isn't revenue yet", async () => {
  const pg = await accountingWith(G => { const p = sell(G, "pick"); G.completePickList(p.id); });
  assert.doesNotMatch(pg.$("acctBody").innerHTML, /Counter sale/);
});
