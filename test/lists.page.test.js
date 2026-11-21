"use strict";
/* Order Fulfillment's "Pick list" tab count, through the real lists.page.js
   with a stand-in DOM (test-lib/page-shim.js). It is the number of pick
   lists created but not completed (status "open"), never the cards on the
   selected list. The owner had the card count removed once and it came back,
   so this pins it. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("../test-lib/page-shim");

function listsPage() {
  const pg = loadPage("lists.page.js", { routes: () => ({}) });
  const G = pg.G;
  const list = (id, status, qty) => {
    const p = G.newPickList({ source: "manual" });
    p.id = id;
    p.status = status;
    p.lines.push({ name: "Sol Ring", set: "c21", collector: "263", qty });
    G.pickLists().push(p);
    return p;
  };
  list("PL-1", "open", 4);
  list("PL-2", "open", 1);
  list("PL-3", "picked", 7);
  list("PL-4", "shipped", 9);
  return { pg, G };
}

test("the Pick list count is tickets not yet shipped (open or picked), shown as soon as the page loads", async () => {
  const { pg } = listsPage();
  await pg.boot();
  assert.equal(pg.$("pickCount").textContent, "3");
});

test("selecting a pick list doesn't turn the count into its card total", async () => {
  const { pg } = listsPage();
  await pg.boot();
  await pg.$("tabPick").fire("click");
  assert.equal(pg.$("pickCount").textContent, "3");
});

test("the count follows changes: a new open list adds one, completing one keeps it until it ships", async () => {
  const { pg, G } = listsPage();
  await pg.boot();
  const p = G.newPickList({ source: "manual" });
  G.pickLists().push(p);
  G.emit("change");
  assert.equal(pg.$("pickCount").textContent, "4");
  G.pickLists().find(x => x.id === "PL-1").status = "picked";
  G.emit("change");
  assert.equal(pg.$("pickCount").textContent, "4", "picked still waits to ship");
  G.pickLists().find(x => x.id === "PL-1").status = "shipped";
  G.emit("change");
  assert.equal(pg.$("pickCount").textContent, "3");
});

/* #138: the server gives a pick ticket's join code only for a pick list it
   already has. Printing never waits on it for long or fails because of it. */
function printPage(inviteAnswer) {
  const calls = { invite: 0, put: 0 };
  const saved = { list: false };
  const pg = loadPage("lists.page.js", { routes: (url, init) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/auth/me") return { user: { id: "u1", username: "packer" } };
    if (url === "/api/collection" && method === "PUT") { calls.put++; saved.list = true; return { rev: 2, savedAt: "now" }; }
    if (url === "/api/collection") return { rev: 1, savedAt: "then", state: { cards: [], locations: [] } };
    if (url === "/api/invite/pick-list") { calls.invite++; return inviteAnswer(saved); }
    return {};
  } });
  const printed = [];
  pg.G.printList = (title, head, body, sub, footer) => { printed.push(footer); };
  return { pg, calls, printed, saved };
}
const FOUND = { invite: { code: "JOIN123" }, url: "https://x/login.html?invite=JOIN123" };
const MISSING = { __status: 404, error: "No such pick list." };

async function withList(t) {
  await t.pg.G.load();
  await t.pg.boot();
  const p = t.pg.G.newPickList({ source: "manual" });
  p.lines.push({ name: "Sol Ring", set: "c21", collector: "263", qty: 1 });
  t.pg.G.pickLists().push(p);
  return p;
}

test("a pick ticket still prints, without a code, when the server has no such pick list (#138)", async () => {
  const t = printPage(() => MISSING);
  await withList(t);
  await t.pg.$("pickPrint").fire("click");
  assert.equal(t.printed.length, 1, "the ticket printed");
  assert.doesNotMatch(t.printed[0], /invite code/);
  assert.equal(t.calls.invite, 1, "nothing unsaved to wait for, so no second ask");
  assert.equal(t.pg.$("pickPrint").disabled, false);
});

test("printing a just-made pick list saves it first, then gets its code (#138)", async () => {
  const t = printPage(saved => (saved.list ? FOUND : MISSING));
  await withList(t);
  t.pg.G.persist("Add a pick list");          // unsaved, like a list generated a moment ago
  await t.pg.$("pickPrint").fire("click");
  assert.equal(t.calls.put, 1, "the list was saved");
  assert.equal(t.calls.invite, 2, "asked again after the save");
  assert.match(t.printed[0], /invite code <b>JOIN123<\/b>/);
});

test("a missed code is asked for again at the next print, not remembered as none (#138)", async () => {
  let answer = MISSING;
  const t = printPage(() => answer);
  await withList(t);
  await t.pg.$("pickPrint").fire("click");
  answer = FOUND;
  await t.pg.$("pickPrint").fire("click");
  assert.equal(t.printed.length, 2);
  assert.match(t.printed[1], /JOIN123/);
  await t.pg.$("pickPrint").fire("click");
  assert.equal(t.calls.invite, 2, "a code, once had, is reused within the visit");
});

/* #212 Pick together: tick several open tickets, pull them from one
   combined sheet that names each line's order(s) by order number, then sort
   them back order by order. Each order stays its own ticket. */
// The signed-in person: personal (no Store) unless a test says otherwise.
const OWNER = { id: "u1", username: "packer", displayName: "Pat" };
const ALICE = { id: "u2", username: "alice", displayName: "Alice", orgId: "org1", orgRole: "staff", storeIds: ["s1"] };
const BOB = { id: "u3", username: "bob", displayName: "Bob", orgId: "org1", orgRole: "staff", storeIds: ["s1"] };
const MEG = { id: "u4", username: "meg", displayName: "Meg", orgId: "org1", orgRole: "manager", storeIds: [] };
const OTHER_STORE = { id: "u5", username: "olly", displayName: "Olly", orgId: "org1", orgRole: "staff", storeIds: ["s2"] };
async function batchPage(me) {
  const pg = loadPage("lists.page.js", { routes: url => {
    if (url === "/api/auth/me") return { user: me || OWNER };
    if (url === "/api/collection") return { rev: 1, savedAt: "then", state: { cards: [], locations: [] } };
    if (url === "/api/orgs/mine") return { members: [ALICE, BOB, MEG, OTHER_STORE], activeStoreId: "s1" };
    if (String(url).startsWith("/api/audit")) return { entries: [], total: 0 };
    return {};
  } });
  const G = pg.G;
  await G.load();
  G.state.locations.push(G.newLocation({ id: "B2", name: "Bin 2", type: "bin", sellFrom: true }));
  G.addCopies({ set: "c21", num: "263", lang: "en", finish: "nonfoil", condition: "NM", locationId: "B2", qty: 3,
    info: { name: "Sol Ring", collector: "263", setName: "Commander 2021", rarity: "uncommon", price: 1, meta: {} },
    unitCost: 0.1, action: "receipt", receiptId: "T1", note: "" });
  const order = (orderId, label, qty) => {
    const p = G.newPickList({ source: "manapool", orderId, orderLabel: label });
    G.pickLists().push(p);
    G.addToPickList(p.id, { kind: "card", set: "c21", collector: "263", lang: "en", finish: "nonfoil",
      condition: "", name: "Sol Ring", qty });
    return p;
  };
  const a = order("o1", "1043", 1), b = order("o2", "1051", 2), c = order("o3", "1060", 1);
  const printed = [];
  G.printList = (title, head, body, sub) => printed.push({ title, head, body, sub });
  await pg.boot();
  await pg.$("tabPick").fire("click");
  return { pg, G, a, b, c, printed };
}
async function tickAndBatch(pg) {
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  await pg.$("pqBatch").fire("click");
}

test("Pick together batches the ticked open tickets, shows the combined sheet, and leaves the tab count alone (#212)", async () => {
  const { pg, G, a, b, c } = await batchPage();
  assert.equal(pg.$("pickCount").textContent, "3");
  await tickAndBatch(pg);
  assert.ok(a.batchId);
  assert.equal(b.batchId, a.batchId);
  assert.equal(c.batchId, a.batchId);
  assert.equal(pg.$("pickCount").textContent, "3", "still the number of open tickets");
  assert.ok([a, b, c].every(p => p.status === "open"), "batching doesn't change a ticket's stage");
  assert.equal(pg.$("batchDetail").hidden, false);
  assert.equal(pg.$("pickDetail").hidden, true);
  assert.match(pg.$("pickHdr").textContent, /batch of 3 orders/);
  assert.equal(pg.$("pickClear").disabled, true, "Clear (discard one ticket) is off while a batch is showing");
  // 4 Sol Rings wanted, 3 on hand: one line pulls 3 from Bin 2, one is short.
  const rows = pg.$("batchBody").children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].innerHTML, /Bin 2/);
  assert.match(rows[0].innerHTML, /#1043 ×1, #1051 ×2/);
  assert.match(rows[1].innerHTML, /short 1/);
  assert.match(rows[1].innerHTML, /#1060 ×1/);
});

test("the combined sheet prints with order numbers on every line (#212)", async () => {
  const { pg, printed } = await batchPage();
  await tickAndBatch(pg);
  await pg.$("pickPrint").fire("click");
  assert.equal(printed.length, 1);
  assert.equal(printed[0].head[8], "For orders");
  assert.equal(printed[0].body.map(r => r[8]).join(" | "), "#1043 ×1, #1051 ×2 | #1060 ×1");
  assert.equal(printed[0].sub, "Orders #1043, #1051, #1060");
});

test("completing a batch completes each ticket on its own, then goes to Sort into orders (#212)", async () => {
  const { pg, G, a, b, c } = await batchPage();
  await tickAndBatch(pg);
  await pg.$("batchComplete").fire("click");
  assert.ok([a, b, c].every(p => p.status === "picked"));
  assert.equal(c.lines[0].pickedResult.shortfall, 1, "the short order completes short, as on its own");
  assert.equal(pg.$("pickCount").textContent, "3", "picked tickets still wait to ship");
  assert.equal(pg.$("batchSortPane").hidden, false);
  assert.match(pg.$("batchSortHead").textContent, /Order #1060 — 1 of 3 — 0 of 1/);
  assert.equal(pg.$("batchSortBody").children.length, 1);
  // Tick order #1060's only line: the sort step moves on to #1051 by itself next time.
  G.setPickBatchSorted(c.id, G.pickKey(c.lines[0]), true);
  G.persist("Bag");
  assert.match(pg.$("batchSortDone").innerHTML, /Order #1060 is bagged/);
  assert.match(pg.$("batchSortDone").innerHTML, /Next up: order #1051/);
  await pg.$("batchNextOrder").fire("click");
  assert.match(pg.$("batchSortHead").textContent, /Order #1051/);
});

test("dissolving a batch asks first only when sort progress would be lost, and never touches the tickets (#212)", async () => {
  const { pg, G, a, b } = await batchPage();
  await tickAndBatch(pg);
  await pg.$("batchDissolve").fire("click");
  assert.equal(pg.ui.confirms.length, 0, "nothing to lose, no question");
  assert.equal(a.batchId, undefined);
  assert.equal(pg.$("batchDetail").hidden, true);

  await tickAndBatch(pg);
  G.setPickBatchSorted(b.id, G.pickKey(b.lines[0]), true);
  pg.ui.confirmAnswer = false;
  await pg.$("batchDissolve").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /1 line\(s\) already ticked off/);
  assert.ok(b.batchId, "kept when the question is cancelled");
  pg.ui.confirmAnswer = true;
  await pg.$("batchDissolve").fire("click");
  assert.equal(b.batchId, undefined);
  assert.equal(b.status, "open");
  assert.equal(b.lines.length, 1);
});

/* Batches are assigned (owner, 2026-10-13, rework round 1 on PR #213). */
test("Pick together assigns the batch to whoever pressed it; a personal inventory shows no assignee row (#212)", async () => {
  const store = await batchPage(ALICE);
  await tickAndBatch(store.pg);
  for (const p of [store.a, store.b, store.c]) assert.equal(JSON.stringify(p.batchAssignee), '{"id":"u2","name":"Alice"}');
  assert.equal(store.pg.$("batchAssignRow").hidden, false);
  assert.match(store.pg.$("batchAssignee").innerHTML, /Made by <b>Alice<\/b> \(you\)\. Open: any picker can claim it in Warehouse Mode/, "open until someone claims it (owner, #386)");
  assert.doesNotMatch(store.pg.$("batchAssignee").innerHTML, /name one here/, "staff can't name one");
  assert.equal(store.pg.$("batchReassignBox").hidden, true, "staff can't reassign");
  assert.match(store.pg.$("batchPullActions").innerHTML, /id="batchComplete" class="gold">/);
  assert.equal(store.pg.$("batchDissolve").disabled, false);
  assert.equal(store.pg.$("batchLockNote").innerHTML, "");

  const personal = await batchPage(OWNER);
  await tickAndBatch(personal.pg);
  assert.equal(personal.a.batchAssignee.id, "u1", "the owner is the assignee");
  assert.equal(personal.pg.$("batchAssignRow").hidden, true);
  // Even a batch somehow assigned to someone else stays workable at home.
  personal.G.assignPickBatch(personal.a.batchId, { id: "zz", displayName: "Someone" });
  personal.G.emit("change");
  assert.match(personal.pg.$("batchPullActions").innerHTML, /id="batchComplete" class="gold">/);
  assert.equal(personal.pg.$("batchLockNote").innerHTML, "");
});

// Batches as the signed-in person, then hands the batch to `user` (as a
// Manager's reassign from another device would), and shows it.
async function batchThenAssign(pg, user) {
  await tickAndBatch(pg);
  const id = pg.G.pickLists()[0].batchId;
  pg.G.reassignPickBatch(id, user, MEG);
  pg.G.emit("change");
  return id;
}

test("someone else's batch: look and print, but tick, complete, chase and dissolve are disabled with the reason (#212)", async () => {
  const { pg, a, b, c, printed } = await batchPage(BOB);
  const id = await batchThenAssign(pg, ALICE);
  assert.match(pg.$("batchAssignee").innerHTML, /Assigned to <b>Alice<\/b>/);
  assert.doesNotMatch(pg.$("batchAssignee").innerHTML, /\(you\)/);
  assert.match(pg.$("batchLockNote").innerHTML, /Being picked by Alice\. Only they can tick, complete, chase or dissolve it - ask an Owner or Manager/);
  assert.match(pg.$("batchPullActions").innerHTML, /id="batchComplete" class="gold" disabled title="Being picked by Alice/);
  assert.equal(pg.$("batchDissolve").disabled, true);
  assert.match(pg.$("batchDissolve").title, /Being picked by Alice/);
  assert.match(pg.$("batchBody").children[0].innerHTML, /class="small ghost chase" disabled title="Not actually there\? Try a different location - Being picked by Alice/);
  // Pressing them anyway does nothing.
  await pg.$("batchComplete").fire("click");
  await pg.$("batchDissolve").fire("click");
  assert.ok([a, b, c].every(p => p.status === "open" && p.batchId === id));
  // Sort step: the ticks are disabled too.
  await pg.$("batchStepSort").fire("click");
  assert.match(pg.$("batchSortBody").children[0].innerHTML, /class="bsTick"[^>]* disabled title="Being picked by Alice/);
  // Printing still works.
  await pg.$("batchStepPull").fire("click");
  await pg.$("pickPrint").fire("click");
  assert.equal(printed.length, 1);
  // And the tickets can't be completed one by one around the batch either.
  await pg.$("batchClose").fire("click");
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  assert.equal(pg.$("pqComplete").disabled, true);
  assert.match(pg.$("pqStatus").textContent, /3 being picked by someone else or with cards pulled in Warehouse Mode/);
});

test("an Owner or Manager reassigns a batch; the new assignee can act and the old one can't (#212)", async () => {
  const { pg, G, a, b, c } = await batchPage(MEG);
  const id = await batchThenAssign(pg, ALICE);
  assert.equal(pg.$("batchReassignBox").hidden, false);
  await new Promise(r => setImmediate(r)); // the Store's people load
  const opts = pg.$("batchAssignSel").innerHTML;
  assert.match(opts, /Meg \(you\)/);
  assert.match(opts, /Alice/);
  assert.match(opts, /Bob/);
  assert.doesNotMatch(opts, /Olly/, "someone without this Store isn't offered");
  assert.equal(pg.$("batchAssignSel").value, "u2");
  assert.match(pg.$("batchPullActions").innerHTML, /batchComplete" class="gold" disabled/, "a Manager is locked out too until it's theirs");
  assert.match(pg.$("batchLockNote").innerHTML, /reassign it to yourself to take over/);
  pg.$("batchAssignSel").value = "u4";
  await pg.$("batchReassign").fire("click");
  assert.ok([a, b, c].every(p => p.batchAssignee.id === "u4" && p.batchAssignee.name === "Meg"));
  assert.match(pg.$("batchPullActions").innerHTML, /id="batchComplete" class="gold">/);
  assert.match(pg.$("batchAssignee").innerHTML, /Meg<\/b> \(you\)/);
  await pg.$("batchComplete").fire("click");
  assert.ok([a, b, c].every(p => p.status === "picked"), "now theirs, Meg can complete it");
  assert.equal(G.canWorkPickBatch(id, ALICE), false);
  assert.equal(G.canWorkPickBatch(id, MEG), true);
});

test("the desk's reassign names the picker, warns about copies in hand, and is logged (#386)", async () => {
  const { pg, G, a, b, c } = await batchPage(MEG);
  await tickAndBatch(pg);
  const id = a.batchId;
  const t = { kind: "batch", id };
  G.state.locations.push(G.newLocation({ id: "w", name: "W-1", type: "Box" }));
  assert.equal(G.pickBatchIsOpen(id), true, "made at the desk, it's open");
  assert.match(pg.$("batchAssignee").innerHTML, /or name one here/);
  await new Promise(r => setImmediate(r));
  pg.$("batchAssignSel").value = "u2";
  await pg.$("batchReassign").fire("click");
  assert.equal(pg.ui.confirms.length, 0, "nothing in hand: nothing to warn about");
  assert.equal(G.pickBatchIsOpen(id), false, "the assignment holds");
  assert.ok([a, b, c].every(p => p.batchNamed && p.batchAssignee.name === "Alice"));
  assert.match(pg.$("batchAssignee").innerHTML, /Assigned to <b>Alice/);
  let log = (await G.queryAudit({ limit: 10 })).entries.find(e => e.action === "pick-assigned");
  assert.equal(log.to, "Alice");

  // Alice has started and pulled copies, then it moves to Bob.
  a.rfPicker = { id: "u2", name: "Alice" };
  a.rfPulls = [{ key: "k", recordId: "r", locationId: "w", name: "X", qty: 2 }];
  G.emit("change");
  pg.$("batchAssignSel").value = "u3";
  pg.ui.confirmAnswer = false;
  await pg.$("batchReassign").fire("click");
  assert.match(pg.ui.confirms.at(-1), /Alice still has 2 cards in hand/);
  assert.equal(a.batchAssignee.name, "Alice", "said no: nothing moved");
  pg.ui.confirmAnswer = true;
  await pg.$("batchReassign").fire("click");
  assert.equal(a.batchAssignee.name, "Bob");
  assert.equal(a.rfPicker.name, "Bob", "the RF's lock moves with it");
  log = (await G.queryAudit({ limit: 10 })).entries.find(e => e.action === "pick-assigned" && e.to === "Bob");
  assert.equal(log.from, "Alice");
  assert.equal(log.to, "Bob");

});

/* #217: a picked checkbox on every line; Complete asks only if some are unticked. */
const openTicket = (pg, label) => pg.$("pickQueueBody").children.find(tr => tr.innerHTML.includes(label)).onclick();
const tickRow = (row, on) => { const t = row.querySelector(".pickTick"); t.checked = on; return t.onchange({ target: t }); };

test("a ticket's lines have picked boxes with progress; ticks are saved on the ticket (#217)", async () => {
  const { pg, G, a } = await batchPage();
  openTicket(pg, "1043");
  assert.equal(pg.$("pickBody").children.length, 1);
  assert.match(pg.$("pickHdr").textContent, /0 of 1 lines picked/);
  assert.match(pg.$("pickBody").children[0].innerHTML, /class="pickTick" aria-label="Picked: Sol Ring" title="[^"]+"><\/td>/);
  tickRow(pg.$("pickBody").children[0], true);
  assert.equal(a.pickedKeys.join(), G.pickKey(a.lines[0]) + "@B2");
  assert.match(pg.$("pickHdr").textContent, /1 of 1 lines picked/);
  assert.match(pg.$("pickBody").children[0].innerHTML, /pickTick"[^>]* checked/);
  assert.equal(pg.ui.confirms.length, 0, "ticking never asks");
  tickRow(pg.$("pickBody").children[0], false);
  assert.equal(a.pickedKeys.length, 0);
  assert.equal(a.status, "open", "ticks don't touch the ticket's stage or inventory");
});

test("single Complete asks only while a line is unticked (#217)", async () => {
  const { pg, a } = await batchPage();
  openTicket(pg, "1043");
  pg.ui.confirmAnswer = false;
  await pg.$("pickComplete").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /1 of 1 lines aren't ticked as picked\. Complete anyway\?/);
  assert.equal(a.status, "open", "cancelled");
  pg.ui.confirmAnswer = true;
  tickRow(pg.$("pickBody").children[0], true);
  await pg.$("pickComplete").fire("click");
  assert.equal(pg.ui.confirms.length, 1, "all ticked: no second question");
  assert.equal(a.status, "picked");
  // Completed: the box stays, read-only.
  assert.match(pg.$("pickBody").children[0].innerHTML, /pickTick"[^>]* checked[^>]* disabled/);
});

test("bulk Complete asks how many lines are unticked across the tickets, and not at all when all are ticked (#217)", async () => {
  const { pg, G, a, b, c } = await batchPage();
  pg.$("pqAll").checked = true;
  await pg.$("pqAll").fire("change");
  G.setPickLinePicked(a.id, G.pickKey(a.lines[0]), true);
  pg.ui.confirmAnswer = false;
  await pg.$("pqComplete").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /2 of 3 lines aren't ticked as picked\. Complete anyway\?/);
  assert.equal(a.status, "open");
  for (const p of [b, c]) G.setPickLinePicked(p.id, G.pickKey(p.lines[0]), true);
  pg.ui.confirmAnswer = true;
  await pg.$("pqComplete").fire("click");
  assert.equal(pg.ui.confirms.length, 1, "all ticked: no question");
  assert.ok([a, b, c].every(p => p.status === "picked"));
});

test("the batch's combined box ticks that card on every order, shows ticked only when all are, and Complete asks only if some are not (#217)", async () => {
  const { pg, G, a, b, c } = await batchPage();
  await tickAndBatch(pg);
  assert.match(pg.$("pickHdr").textContent, /0 of 3 lines picked/);
  const rows = () => pg.$("batchBody").children;
  tickRow(rows()[0], true); // the Bin 2 line: orders #1043 and #1051
  assert.equal(a.pickedKeys.length, 1);
  assert.equal(b.pickedKeys.length, 1);
  assert.equal(c.pickedKeys, undefined, "the short line is a separate row, for order #1060");
  assert.match(rows()[0].innerHTML, /pickTick"[^>]* checked/);
  assert.doesNotMatch(rows()[1].innerHTML, /pickTick"[^>]* checked/);
  assert.match(pg.$("pickHdr").textContent, /2 of 3 lines picked/);
  // One order unticks elsewhere: the combined box no longer shows ticked.
  G.setPickLinePicked(b.id, G.pickKey(b.lines[0]), false);
  await pg.$("batchStepPull").fire("click");
  assert.doesNotMatch(rows()[0].innerHTML, /pickTick"[^>]* checked/);
  tickRow(rows()[0], true);
  pg.ui.confirmAnswer = false;
  await pg.$("batchComplete").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /1 of 3 lines aren't ticked as picked\. Complete anyway\?/);
  assert.ok([a, b, c].every(p => p.status === "open"));
  tickRow(rows()[1], true);
  pg.ui.confirmAnswer = true;
  await pg.$("batchComplete").fire("click");
  // Every line ticked, but one is short: still warned about the short line, not about ticks.
  assert.equal(pg.ui.confirms.length, 2);
  assert.match(pg.ui.confirms[1], /1 line\(s\) do not have enough copies and will complete short/);
  assert.doesNotMatch(pg.ui.confirms[1], /aren't ticked/);
  assert.ok([a, b, c].every(p => p.status === "picked"));
});

test("someone else's batch can't be ticked: the boxes are disabled with the reason and a forced tick does nothing (#217)", async () => {
  const { pg, a } = await batchPage(BOB);
  await batchThenAssign(pg, ALICE);
  const row = pg.$("batchBody").children[0];
  assert.match(row.innerHTML, /pickTick"[^>]* title="Being picked by Alice[^>]* disabled|pickTick"[^>]* disabled/);
  tickRow(row, true);
  assert.equal(a.pickedKeys, undefined);
});

test("printed pull sheets carry an empty box per line for pen ticks (#217)", async () => {
  const { pg, printed } = await batchPage();
  await tickAndBatch(pg);
  await pg.$("pickPrint").fire("click");
  assert.equal(printed[0].head[0], "Picked");
  assert.ok(printed[0].body.every(r => r[0] === "☐"));
});

test("batch sheet: one order's card at two locations is two boxes; ticking one doesn't tick the other, and Complete still asks (#217)", async () => {
  const { pg, G, a } = await batchPage();
  G.state.locations.push(G.newLocation({ id: "B3", name: "Bin 3", type: "bin", sellFrom: true }));
  G.addCopies({ set: "c21", num: "263", lang: "en", finish: "nonfoil", condition: "NM", locationId: "B3", qty: 2,
    info: { name: "Sol Ring", collector: "263", setName: "Commander 2021", rarity: "uncommon", price: 1, meta: {} },
    unitCost: 0.1, action: "receipt", receiptId: "T2", note: "" });
  a.lines[0].qty = 5; // 3 in Bin 2 + 2 in Bin 3: this one line is pulled from both
  await tickAndBatch(pg);
  const key = G.pickKey(a.lines[0]);
  const rows = () => pg.$("batchBody").children.filter(r => /Bin [23]/.test(r.innerHTML));
  assert.equal(rows().length, 2, "one row per location");
  const bin2 = rows().find(r => /Bin 2/.test(r.innerHTML));
  tickRow(bin2, true);
  assert.equal(a.pickedKeys.length, 1);
  assert.ok(a.pickedKeys[0].endsWith("@B2"));
  assert.match(rows().find(r => /Bin 2/.test(r.innerHTML)).innerHTML, /pickTick"[^>]* checked/);
  assert.doesNotMatch(rows().find(r => /Bin 3/.test(r.innerHTML)).innerHTML, /pickTick"[^>]* checked/, "the other location is not ticked");
  assert.equal(G.pickLinePicked(a, key), false, "picked only when both locations are");
  pg.ui.confirmAnswer = false;
  await pg.$("batchComplete").fire("click");
  assert.match(pg.ui.confirms[pg.ui.confirms.length - 1], /aren't ticked as picked/);
  assert.equal(a.status, "open");
  tickRow(rows().find(r => /Bin 3/.test(r.innerHTML)), true);
  assert.equal(G.pickLinePicked(a, key), true);
});

test("a short line still gets the short-stock warning when every line is ticked (#217)", async () => {
  const { pg, G, a } = await batchPage();
  openTicket(pg, "1043");
  a.lines[0].qty = 9; // only 3 on hand
  G.setPickLinePicked(a.id, G.pickKey(a.lines[0]), true);
  pg.ui.confirmAnswer = false;
  await pg.$("pickComplete").fire("click");
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /1 line\(s\) do not have enough copies and will complete short/);
  assert.doesNotMatch(pg.ui.confirms[0], /aren't ticked/);
  assert.equal(a.status, "open");
});

/* #221: a tick-all box in the Picked / Bagged column headers. */
const tickAll = (pg, id, on) => { const b = pg.$(id); b.checked = on; return b.onchange({ target: b }); };
const spyPersist = G => { const log = []; const orig = G.persist; G.persist = (...a) => { log.push(a[0]); return orig.apply(G, a); }; return log; };

test("pick list: the Picked header box ticks every line in one save, unticks from all-ticked, and shows a dash for some (#221)", async () => {
  const { pg, G, a } = await batchPage();
  G.addToPickList(a.id, { kind: "card", set: "c21", collector: "100", lang: "en", finish: "nonfoil", condition: "", name: "Other Card", qty: 1 });
  openTicket(pg, "1043");
  assert.equal(pg.$("pickAll").disabled, false);
  assert.equal(pg.$("pickAll").checked, false);
  const log = spyPersist(G);
  tickAll(pg, "pickAll", true);
  assert.equal(log.length, 1, "one save for the whole click");
  assert.equal(G.pickLineProgress(a).done, 2);
  assert.equal(pg.$("pickAll").checked, true);
  assert.equal(pg.$("pickAll").indeterminate, false);
  assert.equal(pg.ui.confirms.length, 0, "no confirm dialog");
  tickAll(pg, "pickAll", false);
  assert.equal(log.length, 2);
  assert.equal(G.pickLineProgress(a).done, 0);
  assert.equal(pg.$("pickAll").checked, false);
  tickRow(pg.$("pickBody").children[0], true);
  assert.equal(pg.$("pickAll").indeterminate, true);
  assert.equal(pg.$("pickAll").checked, false);
  tickAll(pg, "pickAll", true);
  assert.equal(G.pickLineProgress(a).done, 2, "from a dash it ticks the rest");
});

test("pick list: a completed ticket's header box shows the real state, disabled, and does nothing (#221)", async () => {
  const { pg, G, a } = await batchPage();
  openTicket(pg, "1043");
  tickAll(pg, "pickAll", true);
  G.completePickList(a.id);
  G.emit("change");
  assert.equal(pg.$("pickAll").disabled, true);
  assert.equal(pg.$("pickAll").checked, true);
  assert.match(pg.$("pickAll").title, /read-only/);
  tickAll(pg, "pickAll", false);
  assert.equal(a.pickedKeys.length, 1, "a forced click changes nothing");
});

test("batch Pull: the header box gives the same ticks as ticking each row by hand, short row included (#221)", async () => {
  const hand = await batchPage();
  await tickAndBatch(hand.pg);
  const n = hand.pg.$("batchBody").children.length;
  for (let i = 0; i < n; i++) tickRow(hand.pg.$("batchBody").children[i], true);
  const all = await batchPage();
  await tickAndBatch(all.pg);
  const log = spyPersist(all.G);
  tickAll(all.pg, "batchPullAll", true);
  assert.equal(log.length, 1);
  for (const k of ["a", "b", "c"]) {
    assert.deepEqual([...(all[k].pickedKeys || [])].sort(), [...(hand[k].pickedKeys || [])].sort(), "order " + k);
    assert.ok((all[k].pickedKeys || []).length > 0);
  }
  assert.equal(all.pg.$("batchPullAll").checked, true);
  tickAll(all.pg, "batchPullAll", false);
  assert.ok([all.a, all.b, all.c].every(p => !(p.pickedKeys || []).length));
  assert.equal(all.pg.$("batchPullAll").checked, false);
  tickRow(all.pg.$("batchBody").children[0], true);
  assert.equal(all.pg.$("batchPullAll").indeterminate, true);
});

test("batch Pull: a card at two locations is two pulls, both ticked by the header box (#221)", async () => {
  const { pg, G, a } = await batchPage();
  G.state.locations.push(G.newLocation({ id: "B3", name: "Bin 3", type: "bin", sellFrom: true }));
  G.addCopies({ set: "c21", num: "263", lang: "en", finish: "nonfoil", condition: "NM", locationId: "B3", qty: 2,
    info: { name: "Sol Ring", collector: "263", setName: "Commander 2021", rarity: "uncommon", price: 1, meta: {} },
    unitCost: 0.1, action: "receipt", receiptId: "T2", note: "" });
  a.lines[0].qty = 5;
  await tickAndBatch(pg);
  tickAll(pg, "batchPullAll", true);
  assert.equal(G.pickLinePicked(a, G.pickKey(a.lines[0])), true);
  assert.equal(a.pickedKeys.length, 2);
});

test("batch Sort: the Bagged header box affects only the order shown and re-syncs after a single row tick (#221)", async () => {
  const { pg, G, a, b, c } = await batchPage();
  await tickAndBatch(pg);
  await pg.$("batchStepSort").fire("click");
  assert.equal(pg.$("batchSortAll").checked, false);
  const log = spyPersist(G);
  tickAll(pg, "batchSortAll", true);
  assert.equal(log.length, 1);
  assert.equal([a, b, c].filter(p => (p.batchSorted || []).length).length, 1, "only the order on screen");
  assert.equal(pg.$("batchSortAll").checked, true);
  const t = pg.$("batchSortBody").children[0].querySelector(".bsTick");
  t.checked = false; t.onchange({ target: t });
  assert.equal(pg.$("batchSortAll").checked, false, "header follows a single tick without a re-render");
  t.checked = true; t.onchange({ target: t });
  assert.equal(pg.$("batchSortAll").checked, true);
});

test("someone else's batch: the Picked and Bagged header boxes are disabled with the reason and a forced change does nothing (#221)", async () => {
  const { pg, a, b, c } = await batchPage(BOB);
  await batchThenAssign(pg, ALICE);
  assert.equal(pg.$("batchPullAll").disabled, true);
  assert.match(pg.$("batchPullAll").title, /Being picked by Alice/);
  tickAll(pg, "batchPullAll", true);
  assert.ok([a, b, c].every(p => !(p.pickedKeys || []).length));
  await pg.$("batchStepSort").fire("click");
  assert.equal(pg.$("batchSortAll").disabled, true);
  assert.match(pg.$("batchSortAll").title, /Being picked by Alice/);
  tickAll(pg, "batchSortAll", true);
  assert.ok([a, b, c].every(p => !(p.batchSorted || []).length));
});

/* #289: a pick quantity above 1 is a boxed ×N badge; 1 stays a plain number. */
test("pick list: qty 1 is a plain number, qty 2 is the boxed ×2 badge, both sort by number (#289)", async () => {
  const { pg, G } = await batchPage();
  openTicket(pg, "1043");
  assert.match(pg.$("pickBody").children[0].innerHTML, /<td class="num" data-v="1">1<\/td>/);
  assert.doesNotMatch(pg.$("pickBody").children[0].innerHTML, /qty-multi/);
  openTicket(pg, "1051");
  assert.match(pg.$("pickBody").children[0].innerHTML, /<td class="num" data-v="2"><span class='qty-multi'>×2<\/span><\/td>/);
  assert.equal(G.qtyBadge(3), "<span class='qty-multi'>×3</span>");
  assert.equal(G.qtyBadge(1), "1");
});

test("batch pick table shows the badge on a combined quantity above 1 (#289)", async () => {
  const { pg } = await batchPage();
  await tickAndBatch(pg);
  assert.match(pg.$("batchBody").children[0].innerHTML, /<td class="num" data-v="3"><span class='qty-multi'>×3<\/span><\/td>/);
});

test("printed pick sheet and batch sheet carry the badge only above 1 (#289)", async () => {
  const { pg, printed } = await batchPage();
  openTicket(pg, "1051");
  await pg.$("pickPrint").fire("click");
  const row = printed.at(-1).body[0];
  assert.equal(row[6], "<span class='qty-multi'>×2</span>");
  openTicket(pg, "1043");
  await pg.$("pickPrint").fire("click");
  assert.equal(printed.at(-1).body[0][6], "1");
});
