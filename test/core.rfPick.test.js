"use strict";
/* Warehouse Mode's pick and pack (#386): the walk, bin scans, keyed labels,
   short picks and packing, on the real core.js. The desk's own functions read
   the results back, because "the two never disagree" is the point. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { freshCore, APP_DIR } = require("../test-lib/core-shim");
const { moneyLeaks } = require("../test-lib/no-money");

const INFO = name => ({ name, collector: "1", setName: "Set", rarity: "common", tcgplayerId: "1", scryfallId: "s", price: 7.25, priceNote: "", note: "", meta: {} });

function setup(bins) {
  // The server's log is empty here; queryAudit shows what's logged but not yet sent.
  const G = freshCore({ fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ entries: [], total: 0 }) }) });
  for (const [id, name, pickPriority] of bins || [["a", "A-1", 5], ["b", "B-2", 3], ["c", "C-3", 1]]) {
    G.state.locations.push(G.newLocation({ id, name, type: "Box", pickPriority, sellFrom: true }));
  }
  return G;
}
function stock(G, locationId, qty, card) {
  const c = Object.assign({ set: "tst", num: "1", name: "Sol Ring", lang: "en", finish: "nonfoil", condition: "NM" }, card);
  G.addCopies({ set: c.set, num: c.num, lang: c.lang, finish: c.finish, condition: c.condition, locationId, qty, info: Object.assign(INFO(c.name), { collector: c.num }),
    unitCost: 1.5, action: "receipt", receiptId: "T1", note: "" });
}
const onHand = (G, locationId, set) => G.state.cards.filter(r => r.locationId === locationId && (!set || r.set === set)).reduce((n, r) => n + r.quantity, 0);
function ticket(G, lines, opts) {
  const p = G.newPickList(Object.assign({ source: "manual", orderId: "o-" + G.pickLists().length, orderLabel: "#10" + G.pickLists().length }, opts));
  G.pickLists().push(p);
  for (const l of lines) {
    G.addToPickList(p.id, Object.assign({ kind: "card", set: "tst", collector: "1", lang: "en", finish: "nonfoil", condition: "NM", name: "Sol Ring", qty: 1, unitPrice: 9.99 }, l));
  }
  return p;
}
const ME = { id: "u1", username: "sam" };
// core.js runs in its own VM realm, so compare by value.
const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

// Walks everything a picker would, bin by bin, tapping Picked each time.
function walkAll(G, target) {
  const seen = [];
  for (let guard = 0; guard < 50; guard++) {
    const w = G.rfPickWalk(target);
    if (!w.next) return seen;
    seen.push({ bin: w.next.bin, name: w.next.name, qty: w.next.need });
    assert.equal(G.rfConfirmPull(target, w.next.id), true);
  }
  throw new Error("the walk never finished");
}

test("a single ticket walks bin by bin in name order, then finishes through the desk's own completion", () => {
  const G = setup();
  stock(G, "b", 2, { name: "Beta", num: "2" });
  stock(G, "a", 3, { name: "Alpha", num: "3" });
  const p = ticket(G, [{ name: "Beta", collector: "2", qty: 2 }, { name: "Alpha", collector: "3", qty: 1 }]);
  const t = { kind: "ticket", id: p.id };

  const first = G.rfPickWalk(t);
  assert.equal(first.stage, "pick");
  assert.equal(first.stops, 2);
  assert.equal(first.stopNo, 1);
  assert.equal(first.next.bin, "A-1");

  same(walkAll(G, t), [{ bin: "A-1", name: "Alpha", qty: 1 }, { bin: "B-2", name: "Beta", qty: 2 }]);
  // Ticks are the desk's ticks: its progress line agrees.
  same(G.pickLineProgress(p), { done: 2, total: 2 });
  // Nothing has left stock yet, same as ticking on the desk.
  assert.equal(onHand(G, "a"), 3);

  const out = G.rfFinishPicking(t);
  assert.equal(out.pulled, 3);
  assert.equal(p.status, "picked");
  assert.equal(onHand(G, "a"), 2);
  assert.equal(onHand(G, "b"), 0);
  assert.equal(G.rfPickWalk(t).stage, "pack");
});

test("a batch walks one combined sheet, naming each order, and sorts back into orders", () => {
  const G = setup();
  stock(G, "a", 5);
  const p1 = ticket(G, [{ qty: 2 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  const batchId = G.createPickBatch([p1.id, p2.id], ME);
  const id = typeof batchId === "string" ? batchId : p1.batchId;
  const t = { kind: "batch", id };

  const w = G.rfPickWalk(t);
  assert.equal(w.rows.length, 1, "one row per card per bin");
  assert.equal(w.next.qty, 3);
  same(w.next.orders.map(o => [o.tag, o.qty]), [[G.pickListTag(p1), 2], [G.pickListTag(p2), 1]]);

  // One queue item, not two.
  const queue = G.rfPickQueue(ME);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, "batch");
  assert.equal(queue[0].cards, 3);

  walkAll(G, t);
  // The desk's batch sheet shows every order's line picked.
  same(G.pickLineProgress(p1), { done: 1, total: 1 });
  same(G.pickLineProgress(p2), { done: 1, total: 1 });
  G.rfFinishPicking(t);
  assert.equal(onHand(G, "a"), 2);

  const pack = G.rfPackView(t);
  assert.equal(pack.length, 2);
  assert.equal(pack[0].lines[0].pulled, 1);
  assert.equal(pack[0].lines[0].bagged, false);
  G.setPickBatchSorted(p2.id, pack[0].lines[0].key, true);
  assert.equal(G.rfPackView(t)[0].lines[0].bagged, true);
  G.rfPackOrder(p2.id);
  assert.equal(G.rfPickWalk(t).stage, "pack", "the second order still waits");
  G.rfPackOrder(p1.id);
  assert.equal(G.rfPickWalk(t).stage, "done");
  // The desk's sort progress agrees with the floor.
  same(G.pickBatchSortProgress(p2), { done: 1, total: 1 });
  assert.equal(G.rfPickQueue(ME).length, 0);
});

test("an unstarted batch is open to any picker; once claimed it's theirs, and a manager can take it over", () => {
  const G = setup();
  stock(G, "a", 5);
  const p1 = ticket(G, [{ qty: 1 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  G.createPickBatch([p1.id, p2.id], { id: "boss", username: "boss", orgId: "o1", orgRole: "owner" });
  const staff = { id: "u2", username: "sam", orgId: "o1", orgRole: "staff" };
  const other = { id: "u4", username: "lee", orgId: "o1", orgRole: "staff" };
  const manager = { id: "u3", username: "kim", orgId: "o1", orgRole: "manager" };
  const t = { kind: "batch", id: p1.batchId };

  // Open, whoever pressed Pick together at the desk.
  const open = G.rfPickQueue(staff)[0];
  assert.equal(open.unclaimed, true);
  assert.equal(open.canWork, true);
  assert.equal(G.rfCanWork(t, other), true);
  assert.equal(G.rfNeedsStart(t), true);

  assert.equal(G.rfStartWork(t, staff), true);
  assert.equal(G.rfNeedsStart(t), false);
  assert.equal(G.pickBatchAssignee(p1.batchId).name, "sam", "the desk sees the claim");
  assert.equal(G.rfCanWork(t, staff), true);
  assert.equal(G.rfCanWork(t, other), false);
  assert.equal(G.rfStartWork(t, other), false, "can't claim it now");
  const item = G.rfPickQueue(other)[0];
  assert.equal(item.unclaimed, false);
  assert.equal(item.canWork, false);
  assert.equal(item.canTakeOver, false);
  assert.equal(item.assignee, "sam", "others see who has it");
  assert.equal(G.rfPickQueue(manager)[0].canTakeOver, true);
  assert.equal(G.rfTakeOver(t, other), false, "staff can't take it over");
  assert.equal(G.rfTakeOver(t, manager), true);
  assert.equal(G.rfCanWork(t, manager), true);
  assert.equal(G.rfCanWork(t, staff), false);
});

test("a started ticket locks to its picker, at the desk too; a manager can take it over, and the lock ends at Finish", async () => {
  const G = setup();
  stock(G, "a", 5);
  const p = ticket(G, [{ qty: 2 }]);
  const t = { kind: "ticket", id: p.id };
  const sam = { id: "u2", username: "sam", orgId: "o1", orgRole: "staff" };
  const lee = { id: "u4", username: "lee", orgId: "o1", orgRole: "staff" };
  const kim = { id: "u3", username: "kim", orgId: "o1", orgRole: "manager" };
  assert.equal(G.rfCanWork(t, lee), true, "anyone's until it's started");
  G.rfStartWork(t, sam);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  assert.equal(G.rfCanWork(t, lee), false);
  assert.equal(G.canWorkPickList(p, lee), false, "the desk honours it");
  assert.equal(G.rfPickerOf(t).name, "sam");
  const seen = G.rfPickQueue(lee)[0];
  assert.equal(seen.assignee, "sam");
  assert.equal(seen.inHand, 2, "a takeover can warn who's holding what");
  assert.equal(seen.canTakeOver, false);
  assert.equal(G.rfPickQueue(kim)[0].canTakeOver, true);
  assert.equal(G.createPickBatch([p.id, ticket(G, [{ qty: 1 }]).id], kim), null, "can't be batched while someone's picking it");

  assert.equal(G.rfTakeOver(t, kim), true);
  assert.equal(G.rfCanWork(t, kim), true);
  assert.equal(G.rfCanWork(t, sam), false);
  assert.equal(G.rfPickWalk(t).cardsDone, 2, "what's in hand stays counted");
  const log = await G.queryAudit({ limit: 10 });
  assert.match(log.entries.find(e => e.action === "pick-takeover").note, /kim took over .* from sam/);

  G.rfFinishPicking(t);
  assert.equal(p.status, "picked");
  assert.equal(G.rfCanWork(t, lee), true, "anyone can pack it");
  assert.equal(p.rfPicker, undefined);
  assert.equal(p.rfPulls, undefined, "nothing left behind");
});

test("the queue skips what's done, and doesn't let the RF make anything", () => {
  const G = setup();
  stock(G, "a", 5);
  const p = ticket(G, [{ qty: 1 }]);
  ticket(G, [], { orderId: "empty" });
  assert.equal(G.rfPickQueue(ME).length, 1, "an empty ticket isn't work");
  const count = G.pickLists().length;
  G.rfPickQueue(ME);
  G.rfPickWalk({ kind: "ticket", id: p.id });
  assert.equal(G.pickLists().length, count, "reading the queue creates no tickets");
  assert.ok(!/newPickList|createPickBatch|ensureOrderPickList|generatePickList/.test(
    fs.readFileSync(path.join(APP_DIR, "public/rf/pick.page.js"), "utf8") + fs.readFileSync(path.join(APP_DIR, "public/rf/shell.page.js"), "utf8")),
    "the RF screens never call the desk's ticket or batch makers");
});

test("bin scan: only that bin's own label passes, and a typed name is never a scan", () => {
  const G = setup();
  const a = G.locById("a");
  const label = G.binLabelText(a);
  same(G.checkBinScan("a", label).ok, true);
  assert.equal(G.checkBinScan("a", "  " + label + "\n").ok, true, "a scanner's stray whitespace is fine");
  assert.equal(G.checkBinScan("a", label.toUpperCase()).ok, true, "a scanner that changes case is fine");
  const wrong = G.checkBinScan("a", G.binLabelText(G.locById("b")));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.problem, "wrong-bin");
  assert.equal(wrong.scanned.name, "B-2");
  assert.equal(G.checkBinScan("a", "A-1").problem, "not-a-label", "the bin's name typed in the scan field isn't a scan");
  assert.equal(G.checkBinScan("a", "").problem, "not-a-label");
  assert.equal(G.checkBinScan("a", "GRIMBIN:nope").problem, "unknown-bin");
});

test("a keyed bin needs the right name and a reason, and lands in the audit log", async () => {
  const G = setup();
  assert.equal(G.keyBin("a", "A-1", "").ok, false, "no reason, no key");
  assert.equal(G.keyBin("a", "B-2", "Label damaged").problem, "wrong-bin");
  assert.equal(G.keyBin("a", " a-1 ", "Label damaged", "Picking #101").ok, true, "case and spaces don't matter");
  const log = await G.queryAudit({ limit: 10 });
  const rows = log.entries;
  const hit = rows.find(e => e.action === "bin-keyed");
  assert.ok(hit, "the keyed bin is in the log");
  assert.equal(hit.from, "A-1");
  assert.match(hit.note, /Label damaged/);
  assert.match(hit.note, /Picking #101/);
});

test("short pick: on-hand corrects at once, logs, reroutes to the next bin with free stock, and books a count", async () => {
  const G = setup();
  stock(G, "a", 3);
  stock(G, "b", 4);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };
  const row = G.rfPickWalk(t).next;
  assert.equal(row.bin, "A-1", "highest pick priority first");
  assert.equal(row.qty, 3);

  const out = G.rfShortPick(t, row.id, 1);
  assert.equal(out.changed, true);
  assert.equal(onHand(G, "a"), 1, "corrected on the spot, before anything is picked");
  assert.equal(out.sameBin, 1, "the copy that's there still gets picked here");
  same(out.moved, [{ bin: "B-2", qty: 2, back: false }]);
  assert.equal(out.short, 0);
  assert.equal(G.pickListIsShort(p), false);

  assert.equal(G.locById("a").countWanted.reason, "Short pick on " + p.id);
  same(G.binsToCount().map(l => [l.id, l.kind]), [["a", "cards"]]);

  const log = await G.queryAudit({ limit: 10 });
  const hit = log.entries.find(e => e.action === "chase-pick");
  assert.ok(hit, "logged the same way as the desk's chase pick");
  assert.equal(hit.oldQty, 3);
  assert.equal(hit.newQty, 1);

  // The desk's own allocation already says the same thing.
  const desk = G.allocatePickLine(p, p.lines[0]);
  same(desk.pulls.map(x => [x.locationId, x.take]), [["a", 1], ["b", 2]]);

  same(walkAll(G, t), [{ bin: "A-1", name: "Sol Ring", qty: 1 }, { bin: "B-2", name: "Sol Ring", qty: 2 }]);
  G.rfFinishPicking(t);
  assert.equal(onHand(G, "a"), 0);
  assert.equal(onHand(G, "b"), 2);
});

test("short pick with nowhere else to go flags the order short, and it stays short after completing", () => {
  const G = setup();
  stock(G, "a", 2);
  const p = ticket(G, [{ qty: 2 }]);
  const t = { kind: "ticket", id: p.id };
  const row = G.rfPickWalk(t).next;
  const out = G.rfShortPick(t, row.id, 0);
  assert.equal(onHand(G, "a"), 0);
  same(out.moved, []);
  assert.equal(out.short, 2);
  same(out.shortOrders, [G.pickListTag(p)]);
  assert.equal(G.pickListIsShort(p), true);
  assert.equal(G.rfPickQueue(ME)[0].short, true);
  assert.equal(G.rfPickWalk(t).next, null, "nothing left to walk");
  G.rfFinishPicking(t);
  assert.equal(p.status, "picked");
  assert.equal(p.lines[0].pickedResult.shortfall, 2);
  assert.equal(G.pickListIsShort(p), true);
  assert.equal(G.rfPackView(t)[0].lines[0].bagged, true, "nothing pulled, nothing to bag");
});

test("a short only reroutes to free copies: lent ones don't count, and stay on the book", () => {
  const G = setup();
  stock(G, "a", 3);
  stock(G, "b", 2);
  const lentStack = G.state.cards.find(r => r.locationId === "b");
  lentStack.loans = [{ id: "l1", to: "Pat", qty: 2, at: "2026-10-01T00:00:00Z" }];
  assert.equal(G.availableQty(lentStack), 0);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };
  const out = G.rfShortPick(t, G.rfPickWalk(t).next.id, 0);
  same(out.moved, [], "copies out on loan aren't there to pick");
  assert.equal(out.short, 3);
  assert.equal(lentStack.quantity, 2);
});

test("a short keeps copies already in hand from another bin picked", () => {
  const G = setup();
  stock(G, "a", 2);
  stock(G, "b", 2);
  stock(G, "c", 5);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };
  const first = G.rfPickWalk(t).next;
  assert.equal(first.bin, "A-1");
  G.rfConfirmPull(t, first.id);
  const second = G.rfPickWalk(t).next;
  assert.equal(second.bin, "B-2");
  G.rfShortPick(t, second.id, 0);
  const after = G.rfPickWalk(t);
  assert.equal(after.next.bin, "C-3", "on to the next bin, not back to the one already pulled");
  assert.equal(after.next.need, 1);
  assert.equal(after.rows.find(r => r.bin === "A-1").picked, true);
});

test("saying every copy is there changes nothing", () => {
  const G = setup();
  stock(G, "a", 3);
  const p = ticket(G, [{ qty: 2 }]);
  const t = { kind: "ticket", id: p.id };
  const out = G.rfShortPick(t, G.rfPickWalk(t).next.id, 3);
  assert.equal(out.changed, false);
  assert.equal(onHand(G, "a"), 3);
  same(G.binsToCount(), []);
});

test("two stacks of one line in the same bin are two taps, sharing the desk's one tick", () => {
  const G = setup();
  stock(G, "a", 1, { condition: "NM" });
  stock(G, "a", 1, { condition: "LP" });
  const p = ticket(G, [{ qty: 2, condition: "" }]);
  const t = { kind: "ticket", id: p.id };
  const w = G.rfPickWalk(t);
  assert.equal(w.rows.length, 2);
  assert.notEqual(w.rows[0].condition, w.rows[1].condition, "each shows the grade to grab");
  G.rfConfirmPull(t, w.next.id);
  same(G.pickLineProgress(p), { done: 0, total: 1 }, "not ticked until both are in hand");
  const again = G.rfPickWalk(t);
  assert.equal(again.next.id, w.rows[1].id, "the second stack is still asked for");
  G.rfConfirmPull(t, again.next.id);
  same(G.pickLineProgress(p), { done: 1, total: 1 });
});

test("sealed lines walk, short and complete too", () => {
  const G = setup();
  G.addSealedCopies({ tcgplayerProductId: "777", name: "Booster Box", setCode: "tst", locationId: "a", qty: 2, price: 120 });
  const p = ticket(G, []);
  G.addToPickList(p.id, { kind: "sealed", tcgplayerProductId: "777", name: "Booster Box", setCode: "tst", qty: 2, unitPrice: 150 });
  const t = { kind: "ticket", id: p.id };
  const row = G.rfPickWalk(t).next;
  assert.equal(row.sealed, true);
  assert.match(row.image, /tcgplayer-cdn/);
  const out = G.rfShortPick(t, row.id, 1);
  assert.equal(out.short, 1);
  assert.equal(G.state.sealed[0].quantity, 1);
  walkAll(G, t);
  G.rfFinishPicking(t);
  assert.equal(p.lines[0].pickedResult.shortfall, 1);
});

test("the walk follows the walk sequence, then natural name order", () => {
  const G = setup([["a", "A-1", 1], ["b", "B-10", 1], ["c", "B-2", 1], ["d", "Z-9", 1]]);
  for (const id of ["a", "b", "c", "d"]) stock(G, id, 1);
  const p = ticket(G, [{ qty: 4 }]);
  const t = { kind: "ticket", id: p.id };
  same(G.rfPickWalk(t).rows.map(r => r.bin), ["A-1", "B-2", "B-10", "Z-9"], "no numbers: natural order, as today");
  G.locById("d").walkSeq = 1;
  G.locById("b").walkSeq = 2;
  same(G.rfPickWalk(t).rows.map(r => r.bin), ["Z-9", "B-10", "A-1", "B-2"], "numbered first, the rest by name");
  assert.equal(G.newLocation({ id: "x", name: "X" }).walkSeq, null);
  assert.equal(G.newLocation({ id: "x", name: "X", walkSeq: "" }).walkSeq, null);
  assert.equal(G.newLocation({ id: "x", name: "X", walkSeq: "7" }).walkSeq, 7);
  assert.equal(G.newLocation(JSON.parse(JSON.stringify(G.locById("d")))).walkSeq, 1, "survives a save and reload");
  // The desk's batch sheet walks the same path.
  const p2 = ticket(G, [{ qty: 1 }]);
  const batch = G.createPickBatch([p.id, p2.id], ME);
  same(G.pickBatchSheet(batch).rows.filter(r => r.kind === "pull").map(r => G.locName(r.locationId)), ["Z-9", "B-10", "A-1", "B-2"]);
});

test("skip sends a stop to the end of the walk, and it still has to be done before Finish", () => {
  const G = setup();
  stock(G, "a", 1);
  stock(G, "b", 1);
  stock(G, "c", 1);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };
  const skipped = ["a"];
  const w = G.rfPickWalk(t, skipped);
  same(w.rows.map(r => r.bin), ["B-2", "C-3", "A-1"]);
  assert.equal(w.next.bin, "B-2");
  assert.equal(w.binsLeft, 3);
  G.rfConfirmPull(t, w.next.id, skipped);
  G.rfConfirmPull(t, G.rfPickWalk(t, skipped).next.id, skipped);
  const last = G.rfPickWalk(t, skipped);
  assert.equal(last.next.bin, "A-1", "it comes back");
  assert.equal(last.binsLeft, 1);
  assert.equal(G.rfFinishPicking(t).refused, true, "can't finish past it");
  assert.equal(p.status, "open");
  // Shorted is as good as picked.
  G.rfShortPick(t, last.next.id, 0, skipped);
  assert.equal(G.rfFinishPicking(t).pulled, 2);
  assert.equal(p.lines[0].pickedResult.shortfall, 1);
});

test("the bin check follows Require bin scan, and every stop is logged as scanned, keyed or tapped", async () => {
  const G = setup();
  assert.equal(G.freshSettings ? G.freshSettings().requireBinScan : G.state.settings.requireBinScan, false, "off unless someone turns it on");
  assert.equal(G.binScanRequired(), false);
  assert.equal(G.logBinCheck("a", "tapped", "Picking #1"), true);
  assert.equal(G.logBinCheck("a", "scanned", "Picking #1"), true);
  G.keyBin("a", "A-1", "Label missing", "Picking #1");
  G.state.settings.requireBinScan = true;
  assert.equal(G.binScanRequired(), true);
  assert.equal(G.logBinCheck("a", "tapped", "Picking #1"), false, "a tap can't pass when a scan is required");
  const log = (await G.queryAudit({ limit: 10 })).entries;
  assert.equal(log.filter(e => e.action === "bin-tapped").length, 1);
  assert.equal(log.filter(e => e.action === "bin-scanned").length, 1);
  assert.equal(log.filter(e => e.action === "bin-keyed").length, 1);
  assert.equal(log.find(e => e.action === "bin-tapped").from, "A-1");
});

test("the count list clears on a full count of the bin, and that bin is counted first", async () => {
  const G = setup();
  stock(G, "a", 1);
  stock(G, "b", 1);
  G.requestBinCount("b", "Short pick on PICK-1");
  G.requestBinCount("b", "Short pick on PICK-2");
  assert.equal(G.locById("b").countWanted.reason, "Short pick on PICK-1", "the first date stands");
  for (let i = 0; i < 20; i++) assert.equal(G.pickCycleCountBin().id, "b");
  await G.applyCycleCountAdjustments("b", []);
  same(G.binsToCount(), []);
});

test("cards and sealed are flagged apart: a sealed count can't clear a card short nobody counted", async () => {
  const G = setup();
  stock(G, "a", 1);
  G.addSealedCopies({ tcgplayerProductId: "777", name: "Booster Box", setCode: "tst", locationId: "a", qty: 1, price: 120 });
  G.requestBinCount("a", "Short pick on PICK-1", "cards");
  G.requestBinCount("a", "Short pick on PICK-2", "sealed");
  same(G.binsToCount().map(b => b.kind).sort(), ["cards", "sealed"]);
  assert.equal(G.pickSealedCycleCountBin().id, "a");

  G.applySealedCycleCountAdjustments("a", []);
  same(G.binsToCount().map(b => [b.id, b.kind]), [["a", "cards"]], "the card short is still waiting");
  assert.ok(G.locById("a").lastSealedCycleCountAt);
  assert.equal(G.locById("a").lastCycleCountAt, null, "and the cards don't look counted");

  G.requestBinCount("a", "Short pick on PICK-3", "sealed");
  await G.applyCycleCountAdjustments("a", []);
  same(G.binsToCount().map(b => [b.id, b.kind]), [["a", "sealed"]], "nor the other way round");

  const again = G.newLocation(JSON.parse(JSON.stringify(G.locById("a"))));
  assert.equal(again.countWantedSealed.reason, "Short pick on PICK-3", "survives a save and reload");
});

test("an emptied bin on the count list still gets picked for its full count; sampling keeps its normal rotation", () => {
  const G = setup();
  stock(G, "b", 1);
  G.requestBinCount("a", "Short pick");
  assert.equal(G.pickCycleCountBin().id, "a", "no stock in it, and it's still first");
  assert.equal(G.pickCycleCountBin({ sampling: true }).id, "b", "a sample can't close it, so it doesn't hold up sampling");
  G.requestBinCount("c", "Short pick", "sealed");
  assert.equal(G.pickSealedCycleCountBin().id, "c");
});

/* Review of PR #394: "picked" was yes or no, so a short could raise a row the
   picker had passed and Finish took the higher number. Earlier bin, lower pick
   priority: the walk reaches it first, allocation empties it last. */
const row2bin = (w, bin) => w.rows.find(r => r.bin === bin);
test("a short raising a bin already passed sends the picker back for the difference, and Finish takes what was pulled", async () => {
  const G = setup([["a", "A-1", 1], ["z", "Z-9", 5]]);
  stock(G, "a", 5);
  stock(G, "z", 2);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };

  const first = G.rfPickWalk(t);
  assert.equal(first.next.bin, "A-1");
  assert.equal(first.next.need, 1, "the walk says take 1 from A-1");
  G.rfConfirmPull(t, first.next.id);
  same(p.rfPulls.map(h => [h.locationId, h.qty]), [["a", 1]], "how many, not just yes or no");

  const atZ = G.rfPickWalk(t).next;
  assert.equal(atZ.bin, "Z-9");
  const out = G.rfShortPick(t, atZ.id, 0);
  same(out.moved, [{ bin: "A-1", qty: 2, back: true }], "the result screen says go back");
  assert.equal(out.short, 0);

  const back = G.rfPickWalk(t);
  assert.equal(back.next.bin, "A-1");
  assert.equal(back.next.held, 1);
  assert.equal(back.next.need, 2, "only the difference");
  assert.equal(back.cardsDone, 1, "one in hand, not three");
  assert.equal(G.rfFinishPicking(t).refused, true, "can't finish holding 1 of 3");
  assert.equal(onHand(G, "a"), 5);

  G.rfConfirmPull(t, back.next.id);
  const finish = G.rfPickWalk(t);
  assert.equal(finish.next, null);
  assert.equal(finish.cardsDone, 3);
  const res = G.rfFinishPicking(t);
  assert.equal(res.pulled, 3, "what comes off stock");
  assert.equal(onHand(G, "a"), 2);
  same(p.lines[0].pickedResult.pulls.map(x => [x.locationId, x.qty]), [["a", 3]]);
  assert.equal(p.lines[0].pickedResult.shortfall, 0);
  assert.equal(G.rfPackView(t)[0].lines[0].pulled, 3);
});

test("sent back and the stock is really gone: the line goes short, and the book and the bag still agree", () => {
  const G = setup([["a", "A-1", 1], ["z", "Z-9", 5]]);
  stock(G, "a", 5);
  stock(G, "z", 2);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  G.rfShortPick(t, G.rfPickWalk(t).next.id, 0);

  // Back at A-1: the book says 4 still on the shelf, and only 1 is.
  const back = G.rfPickWalk(t).next;
  assert.equal(back.shelfQty, 4, "the copy in hand has left the shelf");
  assert.equal(back.need, 2);
  const out = G.rfShortPick(t, back.id, 1);
  assert.equal(out.onHand, 2, "the shelf's 1 and the 1 in hand");
  assert.equal(onHand(G, "a"), 2, "the copy in hand stays on the book until Finish");
  assert.equal(out.sameBin, 1);
  assert.equal(out.short, 1);
  assert.equal(G.pickListIsShort(p), true);

  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  const res = G.rfFinishPicking(t);
  assert.equal(res.pulled, 2);
  assert.equal(onHand(G, "a"), 0, "book and shelf both empty");
  same(p.lines[0].pickedResult.pulls.map(x => [x.locationId, x.qty]), [["a", 2]]);
  assert.equal(p.lines[0].pickedResult.shortfall, 1);
  assert.equal(G.pickListIsShort(p), true);
});

test("the batch case: ordinary quantity-1 lines, sent back for the second order's copy", () => {
  const G = setup([["a", "A-1", 1], ["z", "Z-9", 5]]);
  stock(G, "a", 3);
  stock(G, "z", 1);
  const p1 = ticket(G, [{ qty: 1 }], { orderLabel: "#101" });
  const p2 = ticket(G, [{ qty: 1 }], { orderLabel: "#102" });
  const t = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], ME) };

  const first = G.rfPickWalk(t);
  assert.equal(first.next.bin, "A-1");
  same(first.next.orders.map(o => o.tag), ["#102"], "#101 was given the higher priority bin");
  G.rfConfirmPull(t, first.next.id);
  const out = G.rfShortPick(t, G.rfPickWalk(t).next.id, 0);
  same(out.moved, [{ bin: "A-1", qty: 1, back: true }]);

  const back = G.rfPickWalk(t).next;
  assert.equal(back.need, 1);
  same(back.orders.map(o => [o.tag, o.need]), [["#101", 1], ["#102", 0]], "the copy still needed, and who it's for");
  G.rfConfirmPull(t, back.id);
  const res = G.rfFinishPicking(t);
  assert.equal(res.pulled, 2);
  assert.equal(res.short, 0);
  assert.equal(onHand(G, "a"), 1, "A-1's book and shelf agree");
  same(p1.lines[0].pickedResult.pulls.map(x => [x.locationId, x.qty]), [["a", 1]]);
  same(p2.lines[0].pickedResult.pulls.map(x => [x.locationId, x.qty]), [["a", 1]]);
  same(G.pickLineProgress(p1), { done: 1, total: 1 });
});

test("the batch case with the stock really gone: Finish still matches what's in hand", () => {
  const G = setup([["a", "A-1", 1], ["z", "Z-9", 5]]);
  stock(G, "a", 3);
  stock(G, "z", 1);
  const p1 = ticket(G, [{ qty: 1 }], { orderLabel: "#101" });
  const p2 = ticket(G, [{ qty: 1 }], { orderLabel: "#102" });
  const t = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], ME) };
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  G.rfShortPick(t, G.rfPickWalk(t).next.id, 0);
  const out = G.rfShortPick(t, G.rfPickWalk(t).next.id, 0);
  assert.equal(out.short, 1);
  same(out.shortOrders, ["#101"]);
  assert.equal(G.pickListIsShort(p1), true);
  assert.equal(G.pickListIsShort(p2), false, "#102's copy is in the bag");
  const res = G.rfFinishPicking(t);
  assert.equal(res.pulled, 1);
  assert.equal(onHand(G, "a"), 0);
});

test("a row that drops below what's in hand tells the picker to put the extra back, and Finish waits for it", async () => {
  const G = setup();
  stock(G, "a", 5);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  // The desk cuts the line to 1.
  p.lines[0].qty = 1;
  const w = G.rfPickWalk(t);
  same(w.putBack.map(x => [x.bin, x.qty, x.name]), [["A-1", 2, "Sol Ring"]]);
  assert.equal(w.next, null);
  assert.equal(w.cardsDone, 1);
  assert.equal(G.rfFinishPicking(t).refused, true);
  assert.ok(G.rfPutBack(t, w.putBack[0].id));
  same(G.rfPickWalk(t).putBack, []);
  assert.equal(G.rfFinishPicking(t).pulled, 1);
  assert.equal(onHand(G, "a"), 4);
  const log = await G.queryAudit({ limit: 10 });
  assert.match(log.entries.find(e => e.action === "pick-reversed").note, /2 back in the bin/);
});

test("reversing a mis-tapped Picked puts the row back on the walk, logged, until Finish", async () => {
  const G = setup();
  stock(G, "a", 3);
  stock(G, "b", 1, { name: "Beta", num: "2" });
  const p = ticket(G, [{ qty: 2 }, { name: "Beta", collector: "2", qty: 1 }]);
  const t = { kind: "ticket", id: p.id };
  const row = G.rfPickWalk(t).next;
  G.rfConfirmPull(t, row.id);
  same(G.pickLineProgress(p), { done: 1, total: 2 });
  assert.equal(G.rfPickWalk(t).next.bin, "B-2");

  const out = G.rfReversePull(t, row.id);
  same([out.bin, out.qty], ["A-1", 2]);
  const w = G.rfPickWalk(t);
  assert.equal(w.next.id, row.id, "asked for again");
  assert.equal(w.next.need, 2);
  assert.equal(w.cardsDone, 0);
  same(G.pickLineProgress(p), { done: 0, total: 2 }, "the desk's tick comes off too");
  assert.equal(G.rfReversePull(t, row.id), null, "nothing left to reverse");
  const log = await G.queryAudit({ limit: 10 });
  const hit = log.entries.find(e => e.action === "pick-reversed");
  assert.equal(hit.from, "A-1");
  assert.equal(hit.qty, 2);

  walkAll(G, t);
  G.rfFinishPicking(t);
  assert.equal(G.rfReversePull(t, row.id), null, "not after Finish");
});

test("a short on one condition leaves another condition in the same bin alone", () => {
  const G = setup();
  stock(G, "a", 8, { name: "Gamma", num: "9", condition: "NM" });
  stock(G, "a", 3, { name: "Gamma", num: "9", condition: "LP" });
  const p = ticket(G, [{ name: "Gamma", collector: "9", condition: "NM", qty: 1 }]);
  const t = { kind: "ticket", id: p.id };
  const row = G.rfPickWalk(t).next;
  assert.equal(row.condition, "NM");
  assert.equal(row.shelfQty, 8);
  G.rfShortPick(t, row.id, 0);
  const left = G.state.cards.filter(c => c.name === "Gamma");
  same(left.map(c => [c.condition, c.quantity]), [["LP", 3]], "the LP copies aren't touched");
  assert.equal(G.rfPickWalk(t).next, null, "an NM order isn't sent to the LP copies");
  same(G.rfPickWalk(t).shorts.map(s => s.qty), [1]);
});

const SAM = { id: "u2", username: "sam", orgId: "o1", orgRole: "staff" };
const LEE = { id: "u4", username: "lee", orgId: "o1", orgRole: "staff" };
const KIM = { id: "u3", username: "kim", orgId: "o1", orgRole: "manager" };

test("release: a picker gives back their own ticket, a manager anyone's, and what's pulled stays on record", async () => {
  const G = setup();
  stock(G, "a", 5);
  stock(G, "b", 5);
  const p = ticket(G, [{ qty: 2 }, { name: "Beta", collector: "2", qty: 1 }]);
  stock(G, "b", 1, { name: "Beta", num: "2" });
  const t = { kind: "ticket", id: p.id };
  assert.equal(G.rfCanRelease(t, SAM), false, "nobody has it yet");
  G.rfStartWork(t, SAM);
  assert.equal(G.rfCanRelease(t, SAM), true, "their own");
  assert.equal(G.rfCanRelease(t, LEE), false, "not someone else's");
  assert.equal(G.rfCanRelease(t, KIM), true, "a manager, anyone's");
  assert.equal(G.rfRelease(t, LEE), false);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);

  assert.equal(G.rfRelease(t, SAM), true);
  assert.equal(p.rfPicker, undefined);
  assert.equal(G.rfCanWork(t, LEE), true, "back in the open queue");
  assert.equal(G.canWorkPickList(p, LEE), true, "the desk's lock lifts too");
  const item = G.rfPickQueue(LEE)[0];
  assert.equal(item.canWork, true);
  assert.equal(item.released, true);
  assert.equal(item.inHand, 2);
  const log = (await G.queryAudit({ limit: 10 })).entries.find(e => e.action === "pick-released");
  assert.equal(log.from, "sam");
  assert.equal(log.qty, 2);
  assert.match(log.note, /sam released .* 2 already pulled/);

  // The next picker carries on from what's on record.
  assert.equal(G.rfPickWalk(t).releasedBy, "sam");
  assert.equal(G.rfNeedsStart(t), true);
  G.rfStartWork(t, LEE);
  assert.equal(p.rfReleased, undefined);
  const w = G.rfPickWalk(t);
  assert.equal(w.cardsDone, 2, "nobody's sent for those again");
  G.rfConfirmPull(t, w.next.id);
  assert.equal(G.rfFinishPicking(t).pulled, 3);
  assert.equal(G.rfCanRelease(t, LEE), false, "nothing left to release");
});

test("release by a manager, and a personal account can release its own start (#448)", async () => {
  const G = setup();
  stock(G, "a", 5);
  const p = ticket(G, [{ qty: 1 }]);
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, SAM);
  assert.equal(G.rfPickQueue(KIM)[0].canRelease, true);
  assert.equal(G.rfPickQueue(LEE)[0].canRelease, false);
  G.rfRelease(t, KIM);
  const log = (await G.queryAudit({ limit: 10 })).entries.find(e => e.action === "pick-released");
  assert.match(log.note, /kim released .* from sam/);

  const solo = setup();
  stock(solo, "a", 5);
  const q = ticket(solo, [{ qty: 1 }]);
  const st = { kind: "ticket", id: q.id };
  solo.rfStartWork(st, ME);
  assert.equal(solo.rfCanRelease(st, ME), true);
});

test("#448: personal account batches a bare Warehouse Mode start, refuses one with pulls and names it", () => {
  const G = setup();
  stock(G, "a", 5);
  const a = ticket(G, [{ qty: 1 }]), b = ticket(G, [{ qty: 1 }]), c = ticket(G, [{ qty: 1 }]);
  G.rfStartWork({ kind: "ticket", id: a.id }, ME);
  assert.equal(G.rfCanRelease({ kind: "ticket", id: a.id }, ME), true);
  same(G.pickBatchBlockers([a.id, b.id], ME), [], "nothing pulled: not blocked");
  const id = G.createPickBatch([a.id, b.id], ME);
  assert.ok(id, "batched");
  assert.equal(a.rfPicker, undefined, "start cleared");
  assert.equal(a.rfReleased, undefined);
  G.rfStartWork({ kind: "ticket", id: c.id }, ME);
  G.rfConfirmPull({ kind: "ticket", id: c.id }, G.rfPickWalk({ kind: "ticket", id: c.id }).next.id);
  const d = ticket(G, [{ qty: 1 }]);
  assert.equal(G.createPickBatch([c.id, d.id], ME), null);
  const why = G.pickBatchBlockers([c.id, d.id], ME);
  assert.equal(why.length, 1);
  assert.match(why[0], /1 card pulled in Warehouse Mode\. Finish it there/);
  assert.equal(G.rfRelease({ kind: "ticket", id: c.id }, ME), true, "release works with pulls");
  assert.equal(G.createPickBatch([c.id, d.id], ME), null, "pulls stay on record, so still not batchable");
});

test("#448: in a Store a Warehouse Mode start still blocks batching, and the message names who", () => {
  const G = setup();
  stock(G, "a", 5);
  const a = ticket(G, [{ qty: 1 }]), b = ticket(G, [{ qty: 1 }]);
  G.rfStartWork({ kind: "ticket", id: a.id }, SAM);
  assert.equal(G.createPickBatch([a.id, b.id], KIM), null);
  assert.equal(a.rfPicker.name, "sam", "lock untouched");
  assert.match(G.pickBatchBlockers([a.id, b.id], KIM)[0], /is being picked by sam in Warehouse Mode\. Release it first/);
  assert.equal(G.rfCanRelease({ kind: "ticket", id: a.id }, LEE), false);
  assert.equal(G.rfCanRelease({ kind: "ticket", id: a.id }, KIM), true);
});

test("a released batch goes back to the open pool, even with copies on record, and the next picker finishes it right", () => {
  const G = setup([["a", "A-1", 1], ["z", "Z-9", 5]]);
  stock(G, "a", 3);
  stock(G, "z", 1);
  const p1 = ticket(G, [{ qty: 1 }], { orderLabel: "#101" });
  const p2 = ticket(G, [{ qty: 1 }], { orderLabel: "#102" });
  const t = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], KIM) };
  G.rfStartWork(t, SAM);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  assert.equal(G.rfPickQueue(LEE)[0].canWork, false);

  assert.equal(G.rfRelease(t, SAM), true);
  assert.equal(G.pickBatchIsOpen(t.id), true);
  assert.equal(G.pickBatchAssignee(t.id), null);
  const item = G.rfPickQueue(LEE)[0];
  assert.equal(item.unclaimed, true);
  assert.equal(item.canWork, true);
  assert.equal(item.inHand, 1);

  G.rfStartWork(t, LEE);
  assert.equal(G.pickBatchAssignee(t.id).name, "lee");
  assert.equal(G.rfCanWork(t, SAM), false);
  const w = G.rfPickWalk(t);
  assert.equal(w.cardsDone, 1);
  G.rfConfirmPull(t, w.next.id);
  assert.equal(G.rfFinishPicking(t).pulled, 2);
  assert.equal(onHand(G, "a") + onHand(G, "z"), 2);
});

test("a batch opens to anyone at Finish, and only one finished here", () => {
  const G = setup();
  stock(G, "a", 5);
  const p1 = ticket(G, [{ qty: 1 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  const t = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], KIM) };
  G.rfStartWork(t, SAM);
  assert.equal(G.rfCanWork(t, LEE), false);
  walkAll(G, t);
  G.rfFinishPicking(t);
  assert.equal(G.rfCanWork(t, LEE), true);
  assert.equal(G.canWorkPickBatch(t.id, LEE), true, "the desk's sort too");
  const item = G.rfPickQueue(LEE)[0];
  assert.equal(item.stage, "pack");
  assert.equal(item.canWork, true);
  G.setPickBatchSorted(p1.id, G.pickKey(p1.lines[0]), true);
  assert.ok(G.rfPackOrder(p1.id));

  // A batch completed at the desk keeps the desk's rule.
  const p3 = ticket(G, [{ qty: 1 }]);
  const p4 = ticket(G, [{ qty: 1 }]);
  const desk = G.createPickBatch([p3.id, p4.id], SAM);
  G.completePickList(p3.id);
  G.completePickList(p4.id);
  assert.equal(G.canWorkPickBatch(desk, LEE), false);
});

test("a manager's assignment holds: a named batch shows only for that picker, and a manager can still take it over", async () => {
  const G = setup();
  stock(G, "a", 5);
  const p1 = ticket(G, [{ qty: 1 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  const t = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], KIM) };
  assert.equal(G.rfPickQueue(LEE).length, 1, "the open pool, until someone's named");

  assert.equal(G.reassignPickBatch(t.id, SAM, LEE), false, "staff can't name anyone");
  assert.equal(G.reassignPickBatch(t.id, SAM, KIM), true);
  assert.equal(G.pickBatchIsOpen(t.id), false);
  same(G.rfPickQueue(LEE), [], "it doesn't show for anyone else");
  assert.equal(G.rfCanWork(t, LEE), false);
  assert.equal(G.rfStartWork(t, LEE), false);
  const mine = G.rfPickQueue(SAM)[0];
  assert.equal(mine.canWork, true);
  assert.equal(mine.named, true);
  assert.equal(G.rfCanWork(t, SAM), true);
  const boss = G.rfPickQueue(KIM)[0];
  assert.equal(boss.canWork, false);
  assert.equal(boss.canTakeOver, true);
  assert.equal(boss.assignee, "sam");
  const log = (await G.queryAudit({ limit: 10 })).entries.find(e => e.action === "pick-assigned");
  assert.equal(log.to, "sam");

  // Still theirs and still hidden once started.
  G.rfStartWork(t, SAM);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  same(G.rfPickQueue(LEE), []);
  assert.equal(G.pickBatchInHand(t.id), 2);
  // Takeover ends the naming.
  G.rfTakeOver(t, KIM);
  assert.equal(p1.batchNamed, undefined);
  assert.equal(G.rfPickQueue(LEE)[0].assignee, "kim");
  G.rfFinishPicking(t);
  assert.equal(G.rfCanWork(t, LEE), true, "and it opens at Finish like any batch");
});

test("a named batch released goes back to the open pool", () => {
  const G = setup();
  stock(G, "a", 5);
  const p1 = ticket(G, [{ qty: 1 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  const t = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], KIM) };
  G.reassignPickBatch(t.id, SAM, KIM);
  assert.equal(G.rfCanRelease(t, SAM), true, "their own");
  G.rfRelease(t, SAM);
  assert.equal(p1.batchNamed, undefined);
  assert.equal(G.pickBatchIsOpen(t.id), true);
  assert.equal(G.rfPickQueue(LEE)[0].canWork, true);
});

test("copies in a tote say how many and who pulled them, ticket and batch, and go away when reversed or finished", () => {
  const G = setup();
  stock(G, "a", 5);
  const p = ticket(G, [{ qty: 2 }]);
  const t = { kind: "ticket", id: p.id };
  assert.equal(G.pickListInHand(p), null);
  G.rfStartWork(t, SAM);
  assert.equal(G.pickListInHand(p), null, "started, but nothing pulled");
  const row = G.rfPickWalk(t).next;
  G.rfConfirmPull(t, row.id);
  same(G.pickListInHand(p), { cards: 2, by: ["sam"] }, "with no name on the pull, whoever has it");
  G.rfRelease(t, SAM);
  same(G.pickListInHand(p), { cards: 2, by: ["sam"] }, "still theirs once released");
  G.rfReversePull(t, row.id);
  assert.equal(G.pickListInHand(p), null);

  const p1 = ticket(G, [{ qty: 1 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  const b = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], KIM) };
  G.rfConfirmPull(b, G.rfPickWalk(b).next.id);
  assert.equal(G.pickListInHand(p1).cards, 2, "the whole batch");
  assert.equal(G.pickListInHand(p2).cards, 2);
  G.rfFinishPicking(b);
  assert.equal(G.pickListInHand(p1), null);
});

test("a released batch reassigned at the desk still says who pulled what's in the tote", () => {
  const G = setup();
  stock(G, "a", 5);
  const p1 = ticket(G, [{ qty: 1 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  const b = { kind: "batch", id: G.createPickBatch([p1.id, p2.id], SAM) };
  G.rfStartWork(b, SAM);
  G.rfConfirmPull(b, G.rfPickWalk(b).next.id);
  for (const p of [p1, p2]) p.rfPulls = p.rfPulls.map(h => Object.assign({}, h, { by: "sam" }));
  G.rfRelease(b, SAM);
  G.reassignPickBatch(b.id, KIM, KIM);
  assert.equal(p1.rfReleased, undefined);
  assert.equal(G.rfPickWalk(b).releasedBy, "sam");
});

test("a ticket with copies in a tote can't be batched at the desk", () => {
  const G = setup();
  stock(G, "a", 5);
  const p = ticket(G, [{ qty: 1 }]);
  const q = ticket(G, [{ qty: 1 }]);
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, SAM);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  G.rfRelease(t, SAM);
  assert.equal(p.rfPicker, undefined);
  assert.equal(G.createPickBatch([p.id, q.id], KIM), null);
});

test("a reversal says whether anything went back", async () => {
  const G = setup();
  stock(G, "a", 3);
  const p = ticket(G, [{ qty: 1 }]);
  const t = { kind: "ticket", id: p.id };
  const row = G.rfPickWalk(t).next;
  G.rfConfirmPull(t, row.id);
  G.rfReversePull(t, row.id, { returned: false });
  const log = (await G.queryAudit({ limit: 10 })).entries.find(e => e.action === "pick-reversed");
  assert.match(log.note, /nothing went back to the bin/);
});

test("copies in another picker's hand aren't on the shelf for anyone", () => {
  const G = setup();
  stock(G, "a", 2);
  const p1 = ticket(G, [{ qty: 2 }]);
  const p2 = ticket(G, [{ qty: 1 }]);
  const t1 = { kind: "ticket", id: p1.id }, t2 = { kind: "ticket", id: p2.id };
  G.rfConfirmPull(t1, G.rfPickWalk(t1).next.id);
  const w2 = G.rfPickWalk(t2);
  assert.equal(w2.next, null, "nobody's sent to a copy that's already gone");
  same(w2.shorts.map(s => s.qty), [1]);
  assert.equal(G.rfFinishPicking(t1).pulled, 2);
  assert.equal(onHand(G, "a"), 0);
});

test("the pack queue takes tickets picked here only: one completed at the desk finishes at the desk", () => {
  const G = setup();
  stock(G, "a", 5);
  const atDesk = ticket(G, [{ qty: 1 }]);
  const onFloor = ticket(G, [{ qty: 1 }]);
  G.completePickList(atDesk.id);
  assert.equal(atDesk.status, "picked");
  assert.equal(G.rfPickQueue(ME).length, 1, "only what's still to do on the floor");
  assert.equal(G.rfPickQueue(ME)[0].id, onFloor.id);
  const deskTarget = { kind: "ticket", id: atDesk.id };
  assert.equal(G.rfPickWalk(deskTarget).stage, "done");
  same(G.rfPackView(deskTarget), []);
  assert.equal(G.rfPackedHere(deskTarget), false);

  const t = { kind: "ticket", id: onFloor.id };
  walkAll(G, t);
  G.rfFinishPicking(t);
  const q = G.rfPickQueue(ME);
  assert.equal(q.length, 1);
  assert.equal(q[0].stage, "pack");
  assert.equal(q[0].id, onFloor.id);
  assert.ok(onFloor.rfPickedAt);
});

test("ticks made at the desk before the RF started carry over as copies in hand", () => {
  const G = setup();
  stock(G, "a", 2);
  stock(G, "b", 1, { name: "Beta", num: "2" });
  const p = ticket(G, [{ qty: 2 }, { name: "Beta", collector: "2", qty: 1 }]);
  const t = { kind: "ticket", id: p.id };
  const key = G.pickKey(p.lines[0]);
  G.setPickLinePicked(p.id, key, true);
  G.rfStartWork(t, ME);
  const w = G.rfPickWalk(t);
  assert.equal(w.next.bin, "B-2", "not sent to pull them again");
  assert.equal(w.cardsDone, 2);
});

test("the count flag survives a save and reload", () => {
  const G = setup();
  G.requestBinCount("a", "Short pick");
  const again = G.newLocation(JSON.parse(JSON.stringify(G.locById("a"))));
  assert.equal(again.countWanted.reason, "Short pick");
  assert.equal(G.newLocation({ id: "x", name: "X" }).countWanted, null);
});

test("packed: only after picking, only once, logged, and the ticket keeps its stage for the desk", () => {
  const G = setup();
  stock(G, "a", 3);
  const p = ticket(G, [{ qty: 1 }]);
  assert.equal(G.markPickListPacked(p.id), null, "not before it's picked");
  walkAll(G, { kind: "ticket", id: p.id });
  G.rfFinishPicking({ kind: "ticket", id: p.id });
  const packed = G.markPickListPacked(p.id);
  assert.ok(packed.packedAt);
  assert.equal(p.status, "picked", "the desk still weighs and ships it");
  assert.equal(G.markPickListPacked(p.id), null);
  G.markPickListShipped(p.id);
  assert.equal(p.status, "shipped");
});

/* Owner, 2026-10-31: "must not display prices, costs or similar financial
   information anywhere". Every view the RF screens draw from, on a ticket that
   has all of it in the source data. */
const MONEY = { words: /price|cost|revenue|cogs|fee|earning|payment|margin|profit|value|net\b|\$/i, numbers: [9.99, 7.25, 1.5] };
const noMoney = (what, v) => assert.deepEqual(moneyLeaks(v, MONEY), [], what + " carries a financial field");

test("no financial field reaches any RF view, at any stage", () => {
  const G = setup();
  stock(G, "a", 2, { name: "Rich Card" });
  G.state.cards[0].imageUrl = "https://cards.scryfall.io/normal/front/a/b/ab.jpg";
  const p = ticket(G, [{ qty: 3, name: "Rich Card" }], { orderPayment: { subtotal: 40, shipping: 4, total: 44, fee: 3, net: 41 } });
  const t = { kind: "ticket", id: p.id };
  const w = G.rfPickWalk(t);
  assert.ok(p.lines[0].unitPrice > 0 && w.rows.length, "the source really has a price");
  noMoney("rfPickQueue", G.rfPickQueue(ME));
  noMoney("rfPickWalk", w);
  const out = G.rfShortPick(t, w.next.id, 1);
  noMoney("rfShortPick", out);
  walkAll(G, t);
  noMoney("rfFinishPicking", G.rfFinishPicking(t));
  assert.ok(p.revenue != null || p.cogs != null, "completion really did record money on the ticket");
  noMoney("rfPackView", G.rfPackView(t));
  noMoney("rfPickWalk after", G.rfPickWalk(t));
});

test("the RF page scripts never read a financial field off anything", () => {
  const dir = path.join(APP_DIR, "public/rf");
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".page.js"))) {
    const code = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\.(price|unitPrice|avgCost|costTotal|costQty|revenue|cogs|fees?|earnings|orderPayment|shippingRevenue)\b/, f);
  }
});

/* The vendored decoder has to read the labels the vendored encoder prints. */
test("a printed bin label decodes back to that bin, through the vendored QR reader", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(APP_DIR, "public/js/vendor/qrcode.js"), "utf8"), sandbox);
  const reader = {};
  vm.createContext(reader);
  reader.self = reader;
  vm.runInContext(fs.readFileSync(path.join(APP_DIR, "public/js/vendor/jsQR.js"), "utf8"), reader);
  assert.equal(typeof reader.jsQR, "function");

  const G = setup([["c" + "lq7n3x2abcde", "Aisle 12 Bay 4", 0]]);
  const loc = G.state.locations[0];
  const text = G.binLabelText(loc);
  sandbox.text = text;
  const size = vm.runInContext('var q = qrcode(0, "M"); q.addData(text); q.make(); q.getModuleCount()', sandbox);
  const scale = 6, quiet = 4 * scale, w = size * scale + quiet * 2;
  const data = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      sandbox.r = r; sandbox.c = c;
      if (!vm.runInContext("q.isDark(r, c)", sandbox)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = ((quiet + r * scale + y) * w + quiet + c * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  const hit = reader.jsQR(data, w, w, { inversionAttempts: "dontInvert" });
  assert.ok(hit, "the reader finds the code");
  assert.equal(hit.data, text);
  assert.equal(G.binFromLabel(hit.data).name, "Aisle 12 Bay 4");
  assert.ok(size <= 29, "small enough to scan off a 1 inch label");
});

/* ---------- Count and chase vs the tote (#395): book = shelf + tote ---------- */
const stackAt = (G, loc) => G.state.cards.find(r => r.locationId === loc);
// A ticket for `qty`, its picker holding them all.
function pulled(G, qty) {
  const p = ticket(G, [{ qty }]);
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, SAM);
  G.rfConfirmPull(t, G.rfPickWalk(t).next.id);
  return { p, t };
}
const countRow = (G, loc, counted) => ({ recordId: stackAt(G, loc).id, countedQty: counted });

test("the issue's count: book 5, tote 2, shelf 3. Counting 3 leaves the book at 5, and Finish leaves 3", async () => {
  const G = setup();
  stock(G, "a", 5);
  const { p, t } = pulled(G, 2);
  const out = await G.applyCycleCountAdjustments("a", [countRow(G, "a", 3)]);
  assert.equal(out.adjusted, 0, "shelf and tote add up to the book: nothing to adjust");
  assert.equal(onHand(G, "a"), 5);
  same(G.rfPickWalk(t).putBack, [], "nobody's told to put anything back");
  assert.equal(G.rfFinishPicking(t).pulled, 2);
  assert.equal(p.status, "picked");
  assert.equal(onHand(G, "a"), 3, "the book matches the shelf");
});

test("a count that finds fewer on the shelf corrects the shelf only: the tote still comes off at Finish", async () => {
  const G = setup();
  stock(G, "a", 5);
  const { t } = pulled(G, 2);
  const out = await G.applyCycleCountAdjustments("a", [countRow(G, "a", 1)]);
  assert.equal(out.adjusted, 1);
  assert.equal(onHand(G, "a"), 3, "1 on the shelf + 2 in the tote");
  const log = await G.queryAudit({ limit: 50 });
  const line = log.entries.find(e => e.note === "Cycle count adjustment");
  assert.equal(line.qty, -2);
  assert.equal(line.newQty, 3);
  assert.equal(G.rfFinishPicking(t).pulled, 2);
  assert.equal(onHand(G, "a"), 1);
});

test("a shelf found empty with everything in a tote keeps the stack, and Finish empties it", async () => {
  const G = setup();
  stock(G, "a", 2);
  const { t } = pulled(G, 2);
  assert.equal(G.shelfQty(stackAt(G, "a"), G.totesByStack()), 0);
  await G.applyCycleCountAdjustments("a", [countRow(G, "a", 0)]);
  assert.equal(onHand(G, "a"), 2, "not removed: the copies are in the tote");
  same(G.rfPickWalk(t).putBack, []);
  assert.equal(G.rfFinishPicking(t).pulled, 2);
  assert.equal(onHand(G, "a"), 0);
});

test("a count closes the bin's Bins to count entry with copies in a tote, whether it matches or not", async () => {
  for (const counted of [3, 1]) {
    const G = setup();
    stock(G, "a", 5);
    pulled(G, 2);
    G.requestBinCount("a", "Short pick on P1", "cards");
    same(G.binsToCount().map(b => b.id), ["a"]);
    await G.applyCycleCountAdjustments("a", [countRow(G, "a", counted)]);
    same(G.binsToCount(), [], "counted " + counted);
    assert.ok(G.state.locations.find(l => l.id === "a").lastCycleCountAt);
  }
});

test("a short with copies in hand, then the count it asks for: the entry closes and the book stays right", async () => {
  const G = setup();
  stock(G, "a", 5);
  const p = ticket(G, [{ qty: 3 }]);
  const t = { kind: "ticket", id: p.id };
  G.rfStartWork(t, SAM);
  const row = G.rfPickWalk(t).next;
  G.rfConfirmPull(t, row.id);
  const held = G.rfPickWalk(t).rows[0];
  assert.equal(held.held, 3);
  assert.equal(held.shelfQty, 2);
  const out = G.rfShortPick(t, row.id, 0);
  assert.equal(out.onHand, 3, "what's found plus what's in hand");
  assert.equal(onHand(G, "a"), 3);
  same(G.binsToCount().map(b => b.id), ["a"]);
  // The counter finds the empty shelf the short said.
  const shelf = G.shelfQty(stackAt(G, "a"), G.totesByStack());
  assert.equal(shelf, 0);
  await G.applyCycleCountAdjustments("a", [countRow(G, "a", shelf)]);
  same(G.binsToCount(), []);
  assert.equal(onHand(G, "a"), 3);
  G.rfFinishPicking(t);
  assert.equal(onHand(G, "a"), 0);
});

test("sealed counts by the same rule", () => {
  const G = setup();
  G.addSealedCopies({ tcgplayerProductId: "77", name: "Box", setCode: "tst", locationId: "a", qty: 5, price: 10, note: "" });
  const rec = G.state.sealed[0];
  const p = ticket(G, []);
  p.rfPulls = [{ key: "k", recordId: rec.id, locationId: "a", name: "Box", qty: 2, by: "sam" }];
  G.requestBinCount("a", "Short", "sealed");
  assert.equal(G.shelfQty(rec, G.totesByStack()), 3);
  assert.equal(G.applySealedCycleCountAdjustments("a", [{ recordId: rec.id, countedQty: 3 }]).adjusted, 0, "matches");
  assert.equal(rec.quantity, 5);
  assert.equal(G.applySealedCycleCountAdjustments("a", [{ recordId: rec.id, countedQty: 1 }]).adjusted, 1);
  assert.equal(rec.quantity, 3);
  same(G.binsToCount(), []);
});

test("lent copies and copies in a tote both stay on the book through a count", async () => {
  const G = setup();
  stock(G, "a", 6);
  const rec = stackAt(G, "a");
  rec.loans = [{ id: "l1", qty: 1, to: "Sam", at: "2026-10-01" }];
  pulled(G, 2);
  assert.equal(G.shelfQty(rec, G.totesByStack()), 3);
  await G.applyCycleCountAdjustments("a", [countRow(G, "a", 2)]);
  assert.equal(onHand(G, "a"), 5, "2 on the shelf, 1 lent, 2 in a tote");
});

test("the partial counts see the shelf too: Book to Floor's sample, Floor to Book's match", () => {
  const G = setup();
  stock(G, "a", 2);
  stock(G, "a", 3, { name: "Beta", num: "2" });
  const { p } = pulled(G, 2);
  same(G.sampleBinStacks("a", 10).map(r => r.name), ["Beta"], "nothing on the shelf to find");
  const card = { set: "tst", collector: "1", lang: "en", finish: "nonfoil" };
  same(G.matchStackInBin("a", card), { status: "zero", inTote: 2 }, "the book says none on the shelf, and why");
  p.rfPulls = [];
  same(G.matchStackInBin("a", card), { status: "match", locationId: "a" });
  assert.equal(G.sampleBinStacks("a", 10).length, 2);
});

test("the issue's chase: 0 found on another ticket keeps the tote's copies, nobody's told to put them back, and that order isn't short", () => {
  const G = setup();
  stock(G, "a", 5);
  const { p: holder, t } = pulled(G, 2);
  const other = ticket(G, [{ qty: 2 }]);
  // The desk's sheet offers only what's on the shelf, then the chase of 0.
  same(G.allocatePickLine(other, other.lines[0]).pulls.map(x => x.take), [2]);
  G.chasePickAdjust(stackAt(G, "a").id, 0, "Chase pick while working " + other.id);
  assert.equal(onHand(G, "a"), 2, "the 3 that weren't there go; the 2 in the tote stay");
  assert.ok(stackAt(G, "a"), "the stack isn't removed");
  // That ticket's line doesn't go to the empty shelf any more.
  const again = G.allocatePickLine(other, other.lines[0]);
  same(again.pulls, []);
  assert.equal(again.shortfall, 2);
  // The picker's walk is untouched.
  const w = G.rfPickWalk(t);
  same(w.putBack, []);
  same(w.shorts, []);
  assert.equal(w.next, null);
  assert.ok(!holder.shortFlag);
  const done = G.rfFinishPicking(t);
  assert.equal(done.pulled, 2);
  assert.equal(done.short, 0);
  assert.equal(G.pickListIsShort(holder), false);
  assert.equal(onHand(G, "a"), 0, "the shelf was empty, and now so is the book");
});

test("a chase reroutes the other ticket to the next bin, not to the copies in a tote", () => {
  const G = setup();
  stock(G, "a", 3);
  stock(G, "b", 4);
  const { t } = pulled(G, 2);
  const other = ticket(G, [{ qty: 2 }]);
  same(G.allocatePickLine(other, other.lines[0]).pulls.map(x => [x.locationId, x.take]), [["a", 1], ["b", 1]], "1 left on A's shelf");
  G.chasePickAdjust(stackAt(G, "a").id, 0, "Chase");
  assert.equal(onHand(G, "a"), 2);
  same(G.allocatePickLine(other, other.lines[0]).pulls.map(x => [x.locationId, x.take]), [["b", 2]]);
  same(G.rfPickWalk(t).putBack, []);
  assert.equal(G.completePickList(other.id).shipped, 2, "the desk takes it from B");
  assert.equal(onHand(G, "b"), 2);
  assert.equal(onHand(G, "a"), 2, "the tote's copies are still on the book");
  G.rfFinishPicking(t);
  assert.equal(onHand(G, "a"), 0);
});

test("at equal priority a tote landing on a bin doesn't send a ticket already working there somewhere else", () => {
  const G = setup([["d", "D-1", 0], ["e", "E-2", 0]]);
  stock(G, "d", 5);
  stock(G, "e", 4);
  const other = ticket(G, [{ qty: 3 }]);
  const where = () => G.allocatePickLine(other, other.lines[0]).pulls.map(x => [x.locationId, x.take]);
  same(where(), [["d", 3]]);
  const key = G.pickKey(other.lines[0]) + "@pull@d";
  other.pickedKeys = [key];
  pulled(G, 2);
  same(where(), [["d", 3]], "D-1's shelf still has the 3");
  // The batch sheet and completion stay together on it.
  const one = ticket(G, [{ qty: 3 }]), two = ticket(G, [{ qty: 1 }]);
  const batchId = G.createPickBatch([one.id, two.id], ME);
  same(G.pickBatchSheet(batchId).rows.filter(r => r.kind === "pull").map(r => [r.locationId, r.qty]), [["d", 3], ["e", 1]]);
  G.completePickList(one.id);
  G.completePickList(two.id);
  assert.equal(onHand(G, "d"), 2);
  assert.equal(onHand(G, "e"), 3);
  // With the shelf too low, it does move: those copies really aren't there.
  same(where(), [["e", 3]]);
});

test("a line short because of another ticket's tote says so, and one really missing doesn't", () => {
  const G = setup();
  stock(G, "a", 2);
  pulled(G, 2);
  const other = ticket(G, [{ qty: 2 }]);
  assert.equal(G.allocatePickLine(other, other.lines[0]).shortfall, 2);
  assert.equal(G.pickShortTote(other, other.lines[0]), "2 in a tote, pulled by sam");
  const none = ticket(G, [{ qty: 1, set: "tst", collector: "9", name: "Nothing" }]);
  assert.equal(G.pickShortTote(none, none.lines[0]), "");
});

test("a ticket's own tote, or its batch's, isn't why it's short", () => {
  const G = setup();
  stock(G, "a", 1);
  const { p } = pulled(G, 1);
  p.lines[0].qty = 3;
  assert.equal(G.pickShortTote(p, p.lines[0]), "");
  same(G.pickHolders(p).map(x => x.id), [p.id]);
  same(G.pickHolders(null), []);
});

test("the desk's batch sheet and completion leave another ticket's tote alone too", () => {
  const G = setup();
  stock(G, "a", 3);
  const { t } = pulled(G, 2);
  const one = ticket(G, [{ qty: 1 }]), two = ticket(G, [{ qty: 1 }]);
  const batchId = G.createPickBatch([one.id, two.id], ME);
  const sheet = G.pickBatchSheet(batchId);
  same(sheet.rows.filter(r => r.kind === "pull").map(r => r.qty), [1]);
  same(sheet.rows.filter(r => r.kind === "short").map(r => r.qty), [1]);
  assert.equal(G.completePickList(one.id).shipped, 1);
  assert.equal(G.completePickList(two.id).shortLines, 1);
  assert.equal(onHand(G, "a"), 2);
  same(G.rfPickWalk(t).putBack, []);
  assert.equal(G.rfFinishPicking(t).pulled, 2);
  assert.equal(onHand(G, "a"), 0);
});

test("the ticket holding the tote still allocates its own copies: the lock is what stops the desk, not the allocation", () => {
  const G = setup();
  stock(G, "a", 2);
  const { p } = pulled(G, 2);
  same(G.allocatePickLine(p, p.lines[0]).pulls.map(x => x.take), [2]);
  assert.equal(G.allocatePickLine(p, p.lines[0]).shortfall, 0);
  assert.equal(G.pickListInHand(p).cards, 2);
});

test("a chase of a stack with nothing in a tote works as it always did", () => {
  const G = setup();
  stock(G, "a", 3);
  G.chasePickAdjust(stackAt(G, "a").id, 1, "Chase");
  assert.equal(onHand(G, "a"), 1);
  G.chasePickAdjust(stackAt(G, "a").id, 0, "Chase");
  assert.equal(stackAt(G, "a"), undefined, "found none: gone (#73)");
});

test("the count screens' words: the number, who pulled them, and not to count them", () => {
  const G = setup();
  stock(G, "a", 5);
  pulled(G, 2);
  const t = G.totesByStack().get(stackAt(G, "a").id);
  same(t, { qty: 2, by: ["sam"] });
  assert.equal(G.toteWords(t), "2 in a tote, pulled by sam. Don't count those.");
  assert.equal(G.toteWords({ qty: 1, by: ["sam", "lee"] }), "1 in a tote, pulled by sam and lee. Don't count it.");
  assert.equal(G.toteWords(undefined), "");
});

test("a finished ticket holds no tote", () => {
  const G = setup();
  stock(G, "a", 5);
  const { t } = pulled(G, 2);
  assert.equal(G.totesByStack().size, 1);
  G.rfFinishPicking(t);
  assert.equal(G.totesByStack().size, 0);
});
