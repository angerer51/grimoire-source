"use strict";
/* #114: Movers' Explore table and its overlapping reloads, driven through
   the real movers.page.js with a stand-in DOM (test-lib/page-shim.js). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

// A held row whose Explore lens "Biggest value gainers (held)" matches, but
// which no curated pick takes: its % swing is past the sanity cap, it has no
// rank move, no moving averages and no cost basis.
function row(name, vendorTag) {
  return { key: name + "|" + vendorTag, name, set: "tst", collector: "1", setName: "Test", lang: "en", finish: "nonfoil",
    qty: 2, then: 1.5, now: 40, delta: 38.5, pct: 2566, valueDelta: 77, ma30: null, ma60: null, maDiff: null,
    rankNow: null, rankDelta: null, listed: 0, avgCost: null, costQty: 0, oracleId: "o-" + name, imageUrl: "" };
}
const moversBody = rows => ({ fromDate: "2026-10-01", toDate: "2026-10-08", requestedDays: 7, rows });
// GET /api/prices/golden-cross (#352).
const goldenBody = (rows, over) => Object.assign({ vendor: "tcg", days: 7, maxDays: 30, mine: false, toDate: "2026-10-08",
  sinceDate: "2026-10-02", windowDays: 7, total: rows.length, ownedTotal: rows.filter(r => r.qty > 0).length,
  shown: rows.length, best: rows.slice(0, 10), rows }, over);

function deferred() {
  let resolve;
  const p = new Promise(r => { resolve = r; });
  return { p, resolve };
}

function page(routes) {
  const pg = loadPage("movers.page.js", { scripts: ["js/moversPicks.js"], routes });
  pg.$("days").value = "7";
  pg.$("vendor").value = "tcg";
  pg.$("exCategory").value = "valueUp";
  pg.$("portDays").value = "90";
  return pg;
}

test("Explore is drawn on load even when no curated pick qualifies (#114)", async () => {
  const pg = page(url => url.startsWith("/api/prices/movers") ? moversBody([row("Quiet Gainer", "tcg")]) : { points: [] });
  await pg.boot();
  assert.match(pg.$("highlightsWrap").innerHTML, /Nothing stands out today/, "no curated picks");
  assert.match(pg.$("exploreBody").innerHTML, /Quiet Gainer/, "but Explore shows the lens's match");
  assert.match(pg.$("exploreHdr").textContent, /1 printing/);
});

test("a Reload with new data redraws Explore, empty state included (#114)", async () => {
  let rows = [row("First Day", "tcg")];
  const pg = page(url => url.startsWith("/api/prices/movers") ? moversBody(rows) : { points: [] });
  await pg.boot();
  assert.match(pg.$("exploreBody").innerHTML, /First Day/);
  rows = [];
  await pg.$("btnReload").fire("click");
  assert.doesNotMatch(pg.$("exploreBody").innerHTML, /First Day/, "the previous rows are gone");
  assert.match(pg.$("exploreBody").innerHTML, /Nothing to show yet/);
});

test("a slow response for a vendor the user already switched away from is ignored (#114)", async () => {
  const pending = { tcg: [], mp: [] };
  const pg = page(url => {
    if (!url.startsWith("/api/prices/movers")) return { points: [] };
    const v = /vendor=(\w+)/.exec(url)[1];
    const d = deferred();
    pending[v].push(d);
    return d.p;
  });
  const booted = pg.boot();
  await settle();
  // Switch to Manapool while the first (TCGplayer) response is still downloading.
  pg.$("vendor").value = "mp";
  const switched = pg.$("vendor").fire("change");
  await settle();
  pending.mp[0].resolve(moversBody([row("Manapool Row", "mp")]));
  await switched;
  await settle();
  assert.match(pg.$("exploreBody").innerHTML, /Manapool Row/);
  // The old vendor's response lands last: it must not replace what's drawn.
  pending.tcg[0].resolve(moversBody([row("Stale TCG Row", "tcg")]));
  await booted;
  await settle();
  assert.doesNotMatch(pg.$("exploreBody").innerHTML, /Stale TCG Row/);
  assert.match(pg.$("exploreBody").innerHTML, /Manapool Row/);
  assert.equal(pg.G.state.settings.moversVendor, "mp", "the saved vendor is the one on screen");
});

test("the portfolio chart ignores a superseded response too (#114)", async () => {
  const port = [];
  const pg = page(url => {
    if (url.startsWith("/api/prices/movers")) return moversBody([]);
    if (url.startsWith("/api/prices/golden-cross")) return goldenBody([]);
    const d = deferred();
    port.push({ url, d });
    return d.p;
  });
  await pg.boot();
  assert.equal(port.length, 0, "the chart loads lazily, when the Portfolio tab opens (#497)");
  await pg.$("tabPortfolio").fire("click");
  await settle();
  pg.$("portVendor").value = "mp";
  pg.$("portVendor").fire("change");
  await settle();
  assert.equal(pg.$("vendor").value, "mp", "the two Vendor picks are one setting (#497)");
  const [first, second] = port;
  assert.match(second.url, /vendor=mp/);
  second.d.resolve({ points: [{ date: "a", value: 1 }, { date: "b", value: 2 }] });
  await settle();
  assert.equal(pg.$("portChart").innerHTML, "[chart]");
  first.d.resolve({ points: [] });
  await settle();
  assert.equal(pg.$("portChart").innerHTML, "[chart]", "the old vendor's empty history didn't overwrite it");
});

/* ---------- Movers server batch: #110 status line, #111/#112 tiles, #112 condition ---------- */

test("status line (#110): a full-length window gets no 'as far back as the archive goes' note", async () => {
  const pg = page(url => url.startsWith("/api/prices/movers")
    ? { fromDate: "2026-10-01", toDate: "2026-10-08", oldestDate: "2026-07-01", requestedDays: 7, rows: [] } : { points: [] });
  await pg.boot();
  assert.equal(pg.$("status").textContent, "Comparing 2026-10-01 with 2026-10-08 (7 days apart).");
});

test("status line (#110): the archive note only when the window really starts at the archive's first snapshot", async () => {
  let body = { fromDate: "2026-10-02", toDate: "2026-10-08", oldestDate: "2026-10-02", requestedDays: 30, rows: [] };
  const pg = page(url => url.startsWith("/api/prices/movers") ? body : { points: [] });
  await pg.boot();
  assert.match(pg.$("status").textContent, /6 days apart; that is as far back as the archive goes/);
  // A missing day inside a longer archive: the nearest snapshot stood in.
  body = { fromDate: "2026-10-02", toDate: "2026-10-08", oldestDate: "2026-06-01", requestedDays: 7, rows: [] };
  await pg.$("btnReload").fire("click");
  assert.match(pg.$("status").textContent, /6 days apart; the nearest snapshot to 7 days back/);
  assert.doesNotMatch(pg.$("status").textContent, /as far back/);
});

test("tiles (#111, #112): drawn from the server's held summary, not from the table's rows", async () => {
  // The table rows hold nothing (Only held unticked, every held move under
  // the bar), but the summary covers every held printing.
  const held = { nowValue: 1092, netValue: 12, up: 2, upValue: 12, down: 0, downValue: 0,
    best: { name: "Card B", then: 20, now: 22, qty: 4, valueDelta: 8 }, worst: null };
  const pg = page(url => url.startsWith("/api/prices/movers")
    ? { fromDate: "2026-10-01", toDate: "2026-10-08", oldestDate: "2026-07-01", requestedDays: 7, held, rows: [] } : { points: [] });
  await pg.boot();
  const tiles = pg.$("tiles").innerHTML;
  assert.match(tiles, /\$1,092\.00<\/span><span class="lbl">Priced holdings now/);
  assert.match(tiles, /\+\$12\.00<\/span><span class="lbl">Net change/);
  assert.match(tiles, />2<\/span><span class="lbl">Printings up/);
  assert.match(tiles, /Card B<\/span><span class="lbl">Biggest gainer/);
  assert.match(tiles, /× 4 = \$8\.00/);
});

test("condition (#112): an owned row shows its condition in the Printing cell and the CSV has a Condition column", async () => {
  const nm = Object.assign(row("Card B", "tcg"), { condition: "NM", qty: 3, valueDelta: 6, delta: 2, pct: 10, then: 20, now: 22 });
  const lp = Object.assign(row("Card B", "tcg"), { condition: "LP", qty: 1, valueDelta: 2, delta: 2, pct: 10, then: 20, now: 22 });
  const pg = page(url => url.startsWith("/api/prices/movers")
    ? { fromDate: "2026-10-01", toDate: "2026-10-08", oldestDate: "2026-07-01", requestedDays: 7, rows: [nm, lp] } : { points: [] });
  await pg.boot();
  const cells = pg.$("moveBody").children.map(tr => tr.innerHTML);
  assert.equal(cells.length, 2);
  assert.ok(cells.some(h => / · NM<\/td>/.test(h)) && cells.some(h => / · LP<\/td>/.test(h)), "the two rows can be told apart");

  let csv = null;
  pg.sandbox.Blob = class { constructor(parts) { this.text = parts.join(""); } };
  pg.G.downloadBlob = blob => { csv = blob.text; };
  await pg.$("btnCsv").fire("click");
  const lines = csv.split("\r\n");
  const head = lines[0].split(",");
  const col = head.indexOf("Condition");
  assert.ok(col > 0, "Condition column present");
  assert.deepEqual(lines.slice(1).map(l => l.split(",")[col]).sort(), ["LP", "NM"]);
});

/* #209: Sold 7d + SELLING FAST in the main Movers table. */
const SALES = { source: "manapool", sourceNote: "Manapool sales only", historySince: "2026-09-20", historyDays: 21,
  window7Complete: true, baselineDays: 14, comparable: true, hotNeedsDays: 14, hotRatio: 2, hotMinCopies: 5, hotMinSales: 3 };
function soldRow(name, set, collector, finish, sold) {
  return Object.assign(row(name, "tcg"), { set, collector, finish, oracleId: "o-" + name, key: set + "|" + collector + "|en" }, sold);
}
async function soldPage(rows, sales) {
  const pg = page(url => url.startsWith("/api/prices/movers")
    ? Object.assign(moversBody(rows), sales === undefined ? { sales: SALES } : sales ? { sales } : {}) : { points: [] });
  await pg.boot();
  return pg;
}

test("Sold 7d (#209): each printing row shows its Manapool count, the 'at least' mark and the flag; no data says why", async () => {
  const pg = await soldPage([
    soldRow("Fast One", "aaa", "1", "nonfoil", { mpId: "m1", sold7d: 12, soldBase: 3, sold7dAtLeast: true, sellingFast: true }),
    soldRow("Quiet One", "bbb", "2", "nonfoil", { mpId: "m2", sold7d: 0, soldBase: 0, sold7dAtLeast: false, sellingFast: false }),
    soldRow("Unmatched", "ccc", "3", "nonfoil", { mpId: null, sold7d: null, soldBase: null, sold7dAtLeast: false, sellingFast: null })
  ]);
  const html = name => pg.$("moveBody").children.map(tr => tr.innerHTML).find(h => h.includes(name));
  assert.match(html("Fast One"), /data-v="12">.*≥ 12.*SELLING FAST/);
  assert.match(html("Fast One"), /sprite\.svg#trending-up/, "the flag has an icon, not colour alone");
  assert.match(html("Quiet One"), /data-v="0">0<\/td>/);
  assert.doesNotMatch(html("Quiet One"), /SELLING FAST/);
  assert.match(html("Unmatched"), /data-v="" title="This printing couldn't be matched to Manapool\.">—/);
  assert.match(pg.$("thSold").title, /Sales history since 2026-09-20\./, "the header tooltip says how far back the history goes");
  const html2 = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "movers.html"), "utf8");
  assert.match(html2, /id="thSold" title="[^"]*Manapool only/, "and that it's Manapool only");
});

test("Sold 7d (#209): an older server or a failed read leaves the column blank with a reason, not zero", async () => {
  const pg = await soldPage([row("Plain", "tcg")], null);
  assert.match(pg.$("moveBody").children[0].innerHTML, /data-v="" title="Manapool sales aren't available right now\.">—/);
});

test("Sold 7d (#209): a card row adds each printing up once, keeps the 'at least' mark and re-applies the pace rule", async () => {
  const pg = await soldPage([
    // One printing in two finishes: Manapool's count is per printing, so it must count once.
    soldRow("Big Card", "aaa", "1", "nonfoil", { mpId: "m1", sold7d: 3, soldSales7: 3, soldBase: 3, sold7dAtLeast: false, sellingFast: false }),
    soldRow("Big Card", "aaa", "1", "foil", { mpId: "m1", sold7d: 3, soldSales7: 3, soldBase: 3, sold7dAtLeast: false, sellingFast: false }),
    // A second printing whose count is a minimum.
    soldRow("Big Card", "bbb", "7", "nonfoil", { mpId: "m2", sold7d: 4, soldSales7: 4, soldBase: 4, sold7dAtLeast: true, sellingFast: false }),
    soldRow("Big Card", "ccc", "9", "nonfoil", { mpId: null, sold7d: null, soldBase: null, sold7dAtLeast: false, sellingFast: null }),
    // Matched, but no sales on record: no mpId, adds 0.
    soldRow("Big Card", "ddd", "4", "nonfoil", { mpId: null, sold7d: 0, soldBase: 0, sold7dAtLeast: false, sellingFast: false })
  ]);
  pg.$("group").value = "card";
  await pg.$("group").fire("change");
  const card = pg.$("moveBody").children[0].innerHTML;
  // 3 + 4 = 7 sales this week against 7 in the 14 days before: 1/day vs 1/2 per day, 2x - SELLING FAST,
  // although neither printing is fast on its own.
  assert.match(card, /data-v="7" title="[^"]*each printing listed here once">.*≥ 7/);
  assert.match(card, /SELLING FAST/);

  pg.$("rank").value = "sold7d";
  await pg.$("rank").fire("change");
  assert.match(pg.$("moveBody").children[0].innerHTML, /Big Card/, "the sort-by list can rank by copies sold");
});

test("Sold 7d (#354): a card row's flag compares separate sales, so one bulk buy across printings doesn't set it", async () => {
  const pg = await soldPage([
    soldRow("Bulk Card", "aaa", "1", "nonfoil", { mpId: "m1", sold7d: 300, soldSales7: 1, soldBase: 0, sold7dAtLeast: false, sellingFast: false }),
    soldRow("Bulk Card", "bbb", "2", "nonfoil", { mpId: "m2", sold7d: 1, soldSales7: 1, soldBase: 2, sold7dAtLeast: false, sellingFast: false })
  ]);
  pg.$("group").value = "card";
  await pg.$("group").fire("change");
  const card = pg.$("moveBody").children[0].innerHTML;
  assert.match(card, /data-v="301"/, "every copy still counts in Sold 7d");
  assert.doesNotMatch(card, /SELLING FAST/, "2 sales: under the 3-sale minimum");
});

test("Sold 7d (#209): the CSV carries the count and whether it's a minimum", async () => {
  const pg = await soldPage([
    soldRow("Fast One", "aaa", "1", "nonfoil", { mpId: "m1", sold7d: 12, soldBase: 3, sold7dAtLeast: true, sellingFast: true })
  ]);
  let csv = null;
  pg.sandbox.Blob = class { constructor(parts) { this.text = parts.join(""); } };
  pg.G.downloadBlob = blob => { csv = blob.text; };
  await pg.$("btnCsv").fire("click");
  const [head, line] = csv.split("\r\n").map(l => l.split(","));
  assert.equal(line[head.indexOf("Manapool Sold 7d")], "12");
  assert.equal(line[head.indexOf("Sold 7d Is A Minimum")], "Yes");
});

/* #202: the Selling fast tab. */
function sfBody(over) {
  const pr = (id, set, n, c7, c30, al) => ({ scryfallId: id, set, number: n, copies7: c7, sales7: c7, copies30: c30, sales30: c30,
    capped7: false, capped30: false, atLeast7: al, atLeast30: al, pace7: +(c7 / 7).toFixed(2), paceBaseline: 0, paceRatio: null, hot: null });
  return Object.assign({
    asOf: "2026-10-14", total: 2, limit: 500,
    cards: [
      { name: "Trading Post", copies7: 30, sales7: 25, copies30: 40, sales30: 33, capped7: false, capped30: false, atLeast7: true, atLeast30: true,
        pace7: 4.29, paceBaseline: 1.3, baselineDays: 23, paceRatio: 3.3, hot: true, printingCount: 2,
        printings: [pr("abcd0000-0000-0000-0000-000000000001", "msc", "12", 20, 25, true), pr("bcde0000-0000-0000-0000-000000000002", "c13", "5", 10, 15, true)] },
      { name: "Island", copies7: 90, sales7: 80, copies30: 100, sales30: 90, capped7: false, capped30: false, atLeast7: true, atLeast30: true,
        pace7: 12, paceBaseline: 3, baselineDays: 23, paceRatio: 4, hot: true, printingCount: 1,
        printings: [pr("cdef0000-0000-0000-0000-000000000003", "m21", "1", 90, 100, true)] }
    ],
    coverage: { sourceNote: "Manapool sales only", historySince: "2026-10-12", historyDays: 3, window7Complete: false, window30Complete: false,
      hotNeedsDays: 7, topup: { enabled: true } }
  }, over || {});
}
async function sellingPage(body) {
  const pg = page(url => url.startsWith("/api/prices/selling-fast") ? body : url.startsWith("/api/prices/movers") ? moversBody([]) : { points: [] });
  await pg.boot();
  pg.$("sfHideLands").checked = true; // the page ships it ticked
  await pg.$("tabSelling").fire("click");
  await settle();
  return pg;
}

test("Selling fast rolls up by card, shows 'at least' counts and the coverage notes (#202)", async () => {
  const pg = await sellingPage(sfBody());
  assert.ok(pg.net.some(n => n.url.startsWith("/api/prices/selling-fast")), "fetched on opening the tab");
  assert.equal(pg.$("paneSelling").hidden, false);
  assert.equal(pg.$("paneMovers").hidden, true);
  const rows = pg.$("sellBody").children;
  assert.equal(rows.length, 1, "basic lands are hidden by default, leaving the one card row");
  assert.match(rows[0].innerHTML, /Trading Post/);
  assert.match(rows[0].innerHTML, /≥ 30/, "7-day count is marked as a minimum");
  assert.match(rows[0].innerHTML, /SELLING FAST/);
  const notes = pg.$("sfNotes").innerHTML;
  assert.match(notes, /Manapool sales only/);
  assert.match(notes, /since <b>2026-10-12/);
  assert.match(notes, /Still building history/);
  assert.match(notes, /needs 7 days/);
});

test("Selling fast: drilling into a card lists its printings; basic lands can be shown (#202)", async () => {
  const pg = await sellingPage(sfBody());
  await pg.$("sellBody").children[0].onclick();
  const rows = pg.$("sellBody").children;
  assert.equal(rows.length, 3, "card row plus two printing rows");
  assert.match(rows[1].innerHTML, /MSC/);
  assert.match(rows[1].innerHTML, /≥ 20/);
  pg.$("sfHideLands").checked = false;
  await pg.$("sfHideLands").fire("change");
  assert.match(pg.$("sellBody").children[0].innerHTML, /Island/, "Island leads when lands are shown (most sold)");
});

test("Selling fast: printing rows show their own pace and status and follow the table's sort (#223)", async () => {
  const body = sfBody();
  const [msc, c13] = body.cards[0].printings;          // server order: MSC (20 sold in 7d), then C13 (10)
  Object.assign(msc, { paceBaseline: 0, paceRatio: null, hot: false });
  Object.assign(c13, { pace7: 1.43, paceBaseline: 0.24, paceRatio: 6, hot: true });
  Object.assign(msc, { available: 189, available7DaysAgo: 584 });
  Object.assign(c13, { available: 50, available7DaysAgo: null });
  const pg = await sellingPage(body);
  await pg.$("sellBody").children[0].onclick();
  const names = () => pg.$("sellBody").children.slice(1).map(r => /MSC/.test(r.innerHTML) ? "MSC" : "C13");
  const byName = n => pg.$("sellBody").children.find((r, i) => i > 0 && r.innerHTML.includes(n)).innerHTML;
  assert.deepEqual(names(), ["MSC", "C13"], "default sort: copies in 7 days, high to low");
  assert.match(byName("C13"), /data-v="6" title="1.43 sales\/day in the last 7 days vs 0.24 sales\/day in the 23 days before">6×/);
  assert.match(byName("C13"), /SELLING FAST/);
  assert.match(byName("MSC"), /data-v="" title="[^"]*">—<\/td>/, "no baseline sales: no ratio");
  assert.match(byName("MSC"), /Steady/);
  assert.match(byName("MSC"), /data-v="395" title="Supply is falling[^"]*"><span class="pos">▼ 189<\/span> <span class="muted">\(584\)/);
  assert.match(byName("C13"), /data-v="" title="[^"]*">—<\/td>/, "unknown supply: dash");

  const head = pg.$("sellTable").tHead;
  const clickCol = async col => { head.closest = () => ({ cellIndex: col }); await head.fire("click"); };
  await clickCol(7);
  assert.deepEqual(names(), ["C13", "MSC"], "Pace vs usual, high to low");
  await clickCol(7);
  assert.deepEqual(names(), ["MSC", "C13"], "Pace vs usual, low to high");
  await clickCol(8);
  assert.deepEqual(names(), ["MSC", "C13"], "Listed supply: biggest drop first, unknown last");
  await clickCol(10);
  assert.deepEqual(names(), ["C13", "MSC"], "Status: SELLING FAST first");
  await clickCol(2);
  assert.deepEqual(names(), ["C13", "MSC"], "Card name: printing label, A to Z");
  await clickCol(2);
  assert.deepEqual(names(), ["MSC", "C13"], "Card name: printing label, Z to A");
  await clickCol(3);
  assert.deepEqual(names(), ["MSC", "C13"], "Printings column: keeps copies in 7 days order");
  await clickCol(3);
  assert.deepEqual(names(), ["MSC", "C13"], "...in either direction");
  await clickCol(1);
  assert.deepEqual(names(), ["MSC", "C13"], "Rank column: printings have none, so they keep copies in 7 days order");
  assert.match(pg.$("sellBody").children[1].innerHTML, /^<td[^]*?<\/td><td class="num"><\/td><td class="card-name">/, "a printing's Rank cell is blank");
});

test("Selling fast: exact counts carry no 'at least' mark once the windows are full (#202)", async () => {
  const body = sfBody();
  for (const c of body.cards) { c.atLeast7 = c.atLeast30 = false; c.printings.forEach(p => { p.atLeast7 = p.atLeast30 = false; }); }
  body.coverage.window7Complete = body.coverage.window30Complete = true;
  const pg = await sellingPage(body);
  assert.doesNotMatch(pg.$("sellBody").children[0].innerHTML, /≥/);
  assert.doesNotMatch(pg.$("sfNotes").innerHTML, /Still building history/);
});

test("Selling fast: no history yet shows the shared empty state (#202)", async () => {
  const pg = await sellingPage({ asOf: "2026-10-14", total: 0, limit: 500, cards: [], coverage: { sourceNote: "Manapool sales only", historySince: null, historyDays: 0 } });
  assert.match(pg.$("sellBody").innerHTML, /No Manapool sales history yet/);
  assert.match(pg.$("sfNotes").innerHTML, /No sales history has been collected yet/);
});

/* #231: the name search reaches every card that sold, not just the top list. */
async function searchFor(pg, q) {
  pg.$("sfSearch").value = q;
  await pg.$("sfSearch").fire("input");
  await settle(300);                                  // past the 250 ms debounce
}
async function searchingPage(answer) {
  const top = sfBody();
  const pg = page(url => url.includes("q=") ? answer(decodeURIComponent(/q=([^&]*)/.exec(url)[1]))
    : url.startsWith("/api/prices/selling-fast") ? top : url.startsWith("/api/prices/movers") ? moversBody([]) : { points: [] });
  await pg.boot();
  pg.$("sfHideLands").checked = true;
  await pg.$("tabSelling").fire("click");
  await settle();
  return pg;
}
const found = (cards, over) => Object.assign({ asOf: "2026-10-14", total: 900, limit: 500, query: "", matched: cards.length, searchMax: 50,
  cards, coverage: sfBody().coverage }, over || {});

test("Selling fast search: a match below the top list shows its overall rank; clearing returns to the top list (#231)", async () => {
  const deep = Object.assign(sfBody().cards[0], { name: "Zzyzx Bolt", rank: 812 });
  const pg = await searchingPage(q => found(q === "zzy" ? [deep] : []));
  await searchFor(pg, " zzy ");
  assert.ok(pg.net.some(n => n.url === "/api/prices/selling-fast?q=zzy"), "searches the server, not just the rows on screen");
  const rows = pg.$("sellBody").children;
  assert.equal(rows.length, 1);
  assert.match(rows[0].innerHTML, /<td class="num" data-v="812" title="Ranked #812 of 900 cards[^"]*">#812<\/td><td class="card-name">[^]*Zzyzx Bolt<\/td>/, "its rank in the Rank column (#233)");
  assert.match(rows[0].innerHTML, /SELLING FAST/, "same columns as the top list");
  assert.equal(pg.$("sfHdr").textContent, '- 1 shown: 1 card matching "zzy", out of 900 sold on Manapool in the last 7 days');
  assert.match(pg.$("sfNotes").innerHTML, /search covers all 900 cards/);
  assert.doesNotMatch(pg.$("sfNotes").innerHTML, /Sorting reorders only the cards loaded/);
  await rows[0].onclick();
  assert.equal(pg.$("sellBody").children.length, 3, "printings drill-down works on a result");

  await searchFor(pg, "");
  assert.match(pg.$("sellBody").children[0].innerHTML, /Trading Post/);
  assert.match(pg.$("sfHdr").textContent, /shown, top 2 of 2/);
  assert.match(pg.$("sfNotes").innerHTML, /Sorting reorders only the cards loaded so far: the top 2 by 7-day sales\. A search/);
});

test("Selling fast search: capped results, hidden basic lands and no match read correctly (#231)", async () => {
  const body = sfBody();
  body.cards.forEach((c, i) => { c.rank = i + 1; });
  const pg = await searchingPage(q => q === "t" ? found(body.cards, { matched: 120 })
    : q === "island" ? found([body.cards[1]]) : found([]));
  await searchFor(pg, "t");
  assert.equal(pg.$("sfHdr").textContent, '- 1 shown: the 2 best sellers of 120 cards matching "t", out of 900 sold on Manapool in the last 7 days');
  assert.match(pg.$("sellBody").children[0].innerHTML, /data-v="1" title="Ranked #1 of 900 [^"]*">#1<\/td>/);
  await searchFor(pg, "island");
  assert.match(pg.$("sellBody").innerHTML, /Every card matching "island" is a basic land/);  await searchFor(pg, "<b>x");
  assert.match(pg.$("sellBody").innerHTML, /No card matching "&lt;b&gt;x" sold on Manapool in the last 7 days\./);
  assert.equal(pg.$("sfHdr").textContent, "");
});

/* #233: a Rank column on every card row, and "Show 500 more" past the top list. */
test("Selling fast: Rank column on every card row, unchanged by sorting; Show more appends the next page (#233)", async () => {
  const top = sfBody({ total: 3 });
  top.cards.forEach((c, i) => { c.rank = i + 1; });
  const next = Object.assign(sfBody().cards[0], { name: "Deep Cut", rank: 3, copies7: 1 });
  let gate = null, fail = false;
  const pg = page(url => {
    if (!url.startsWith("/api/prices/selling-fast")) return url.startsWith("/api/prices/movers") ? moversBody([]) : { points: [] };
    if (!/offset=/.test(url)) return top;
    if (fail) return Promise.reject(new Error("HTTP 500"));
    return gate.p.then(() => sfBody({ total: 3, offset: 2, cards: [next] }));
  });
  await pg.boot();
  pg.$("sfHideLands").checked = false;
  await pg.$("tabSelling").fire("click");
  await settle();
  const ranks = () => pg.$("sellBody").children.map(r => (/>#(\d+)<\/td>/.exec(r.innerHTML) || [])[1]);
  assert.deepEqual(ranks(), ["2", "1"], "default sort is copies in 7 days: Island (#2 here) first, each with its own rank");
  const head = pg.$("sellTable").tHead;
  const clickCol = async col => { head.closest = () => ({ cellIndex: col }); await head.fire("click"); };
  await clickCol(1);
  assert.deepEqual(ranks(), ["1", "2"], "Rank column sorts #1 first");
  await clickCol(2);
  assert.deepEqual(ranks(), ["2", "1"], "sorting by name keeps each card's own rank");
  await clickCol(1);

  assert.equal(pg.$("sfMore").hidden, false);
  assert.equal(pg.$("sfMoreCount").textContent, "Showing 2 of 3 sold");
  assert.equal(pg.$("sfMoreBtn").hidden, false);
  assert.equal(pg.$("sfMoreLabel").textContent, "Show 1 more");
  assert.match(pg.$("sfNotes").innerHTML, /the top 2 by 7-day sales \(of 3 that sold\)\. Show more loads the next 500, and a search/);

  // A failed page keeps the rows and says why in the status line.
  fail = true;
  await pg.$("sfMoreBtn").fire("click");
  assert.match(pg.$("sfStatus").textContent, /Could not load more of Selling fast: HTTP 500/);
  assert.equal(pg.$("sellBody").children.length, 2, "rows already shown are kept");
  assert.equal(pg.$("sfMoreBtn").disabled, false, "and the button can be tried again");

  fail = false;
  gate = deferred();
  const pending = pg.$("sfMoreBtn").fire("click");
  await settle();
  assert.equal(pg.$("sfMoreBtn").disabled, true, "disabled while the page loads");
  assert.ok(pg.net.some(n => n.url === "/api/prices/selling-fast?limit=500&offset=2"), "asks for the cards after the ones loaded");
  gate.resolve();
  await pending;
  await settle();
  assert.deepEqual(ranks(), ["1", "2", "3"], "the next page is appended");
  assert.equal(pg.$("sfMoreCount").textContent, "Showing 3 of 3 sold");
  assert.equal(pg.$("sfMoreBtn").hidden, true, "hidden once every card that sold is showing");
  assert.match(pg.$("sfHdr").textContent, /3 cards shown, top 3 of 3/);
  assert.match(pg.$("sfNotes").innerHTML, /the top 3 by 7-day sales\. A search by card name/, "no Show more hint once everything is loaded");

  // Searching hides the footer; clearing the search brings back every loaded row.
  await searchFor(pg, "deep");
  assert.equal(pg.$("sfMore").hidden, true);
  await searchFor(pg, "");
  assert.equal(pg.$("sellBody").children.length, 3);
});

/* #266: MA30-60 as a percent. */
function trendRow(name, ma30, ma60, extra) {
  return Object.assign(row(name, "tcg"), { qty: 0, then: ma60, now: ma30, delta: ma30 - ma60, pct: (ma30 - ma60) / ma60 * 100,
    valueDelta: null, rankNow: 500, rankDelta: -300, ma30, ma60, maDiff: ma30 - ma60, maPct: (ma30 - ma60) / ma60 * 100 }, extra || {});
}

test("MA30-60 % (#266): the table shows the percent, keeps the dollar gap in the tooltip and the CSV; picks and lenses rank by percent", async () => {
  const pricey = trendRow("Pricey Card", 3700, 3450);  // +$250, +7.2%
  const doubled = trendRow("Doubled Card", 8, 4);      // +$4, +100%
  const sparse = Object.assign(trendRow("Sparse Card", 5, 4), { ma60: null, maDiff: null, maPct: null });
  const pg = page(url => url.startsWith("/api/prices/movers") ? moversBody([pricey, doubled, sparse]) : { points: [] });
  await pg.boot();
  const html = pg.$("moveBody").children.map(tr => tr.innerHTML).join("\n");
  assert.match(html, /data-v="100" title="\+[^"]*4\.00 \(30-day minus 60-day\)">\+100(\.0)?%<\/td>/, "percent shown, $ gap in the tooltip");
  assert.match(html, /data-v="7\.24[0-9]*"/, "the column sorts by percent");

  // Explore's trend lens ranks by percent: the $4 move beats the $250 one.
  pg.$("exCategory").value = "trendingUp";
  await pg.$("exCategory").fire("change");
  const ex = pg.$("exploreBody").innerHTML;
  assert.ok(ex.indexOf("Doubled Card") >= 0 && ex.indexOf("Doubled Card") < ex.indexOf("Pricey Card"), "percent, not dollars");
  assert.doesNotMatch(ex, /Sparse Card/, "no trend, no lens");
  // And so does the curated pick.
  const picks = pg.$("highlightsWrap").children.map(el => el.innerHTML);
  const trendPick = picks.find(h => /Trending up \(not owned\)/.test(h));
  assert.match(trendPick, /Doubled Card[\s\S]*▲ 30-day \+100(\.0)?% vs 60-day/);

  let csv = null;
  pg.sandbox.Blob = class { constructor(parts) { this.text = parts.join(""); } };
  pg.G.downloadBlob = blob => { csv = blob.text; };
  await pg.$("btnCsv").fire("click");
  const lines = csv.split("\r\n");
  const head = lines[0].split(",");
  const pctCol = head.indexOf("MA30-60 Pct"), usdCol = head.indexOf("MA30-60");
  assert.ok(pctCol > 0 && usdCol > 0);
  const doubledLine = lines.find(l => l.startsWith("Doubled Card")).split(",");
  assert.equal(doubledLine[pctCol], "100.00");
  assert.equal(doubledLine[usdCol], "4.00");
});

/* ---------- Golden cross (#352) ---------- */

function crossRow(name, over) {
  return Object.assign({ key: name + "|1|en", name, set: "tst", collector: "1", setName: "Test", lang: "en", finish: "nonfoil",
    crossDate: "2026-10-06", now: 12, ma30: 12, ma60: 10, maDiff: 2, maPct: 20, climbPct: 30, jumpShare: 0.2, offHighPct: 0,
    qty: 0, oracleId: "o-" + name, imageUrl: "" }, over);
}

test("golden cross (#352): the list draws, marks owned copies, and N / Show only mine re-ask the server", async () => {
  const asked = [];
  const pg = page(url => {
    if (url.startsWith("/api/prices/movers")) return moversBody([row("Quiet Gainer", "tcg")]);
    if (url.startsWith("/api/prices/golden-cross")) {
      asked.push(url);
      const mine = /mine=1/.test(url);
      const all = [crossRow("Big Cross", { maPct: 80, ma30: 18, maDiff: 8, crossDate: "2026-10-07" }), crossRow("Owned Cross", { qty: 3 })];
      return goldenBody(mine ? all.filter(r => r.qty) : all, { mine, days: Number(/days=(\d+)/.exec(url)[1]), best: all });
    }
    return { points: [] };
  });
  await pg.boot();
  await settle();
  assert.match(asked[0], /days=7&minGap=5&vendor=tcg&mine=0/, "N starts at 7, the gap at 5%");
  const body = pg.$("gxBody").innerHTML;
  assert.match(body, /Big Cross[\s\S]*Owned Cross/);
  assert.match(body, /data-v="1"[^>]*>1 day ago</, "cross date as days ago, sortable by age");
  assert.match(body, /data-v="3">3</, "owned quantity shown");
  assert.match(pg.$("gxHdr").textContent, /2 printings, 1 yours/);
  const pick = pg.$("highlightsWrap").children.map(el => el.innerHTML).find(h => /Golden cross/.test(h));
  assert.match(pick, /Big Cross[\s\S]*▲ 30-day \+80(\.0)?% · 1 day ago/, "the strongest cross is the pick");

  pg.$("gxMine").checked = true;
  await pg.$("gxMine").fire("change");
  await settle();
  assert.match(asked[asked.length - 1], /mine=1/);
  assert.doesNotMatch(pg.$("gxBody").innerHTML, /Big Cross/);
  assert.match(pg.$("gxBody").innerHTML, /Owned Cross/);
  assert.ok(pg.$("highlightsWrap").children.some(el => /Big Cross/.test(el.innerHTML)), "the pick ignores Show only mine");

  pg.$("gxDays").value = "45";
  await pg.$("gxDays").fire("change");
  await settle();
  assert.match(asked[asked.length - 1], /days=30/, "N is held to 1-30");
  assert.equal(pg.$("gxDays").value, "30");

  pg.$("gxGap").value = "12";
  await pg.$("gxGap").fire("change");
  await settle();
  assert.match(asked[asked.length - 1], /minGap=12&/, "the gap re-asks the server");
  pg.$("gxGap").value = "250";
  await pg.$("gxGap").fire("change");
  await settle();
  assert.match(asked[asked.length - 1], /minGap=100&/, "held to 0-100");
  assert.equal(pg.$("gxGap").value, "100");
  pg.$("gxGap").value = "";
  await pg.$("gxGap").fire("change");
  await settle();
  assert.match(asked[asked.length - 1], /minGap=5&/, "a cleared box asks for the default");
  assert.equal(pg.$("gxGap").value, "", "without rewriting the box mid-edit");
});

test("golden cross (#352): the pick skips a one-day repricing even when its gap is the biggest", async () => {
  const pg = page(url => {
    if (url.startsWith("/api/prices/movers")) return moversBody([row("Quiet Gainer", "tcg")]);
    if (url.startsWith("/api/prices/golden-cross")) {
      const all = [crossRow("Repriced Foil", { now: 44, ma30: 44, ma60: 4.34, maDiff: 39.66, maPct: 914, jumpShare: 1, climbPct: 914 }),
        crossRow("Steady Riser", { maPct: 28 })];
      return goldenBody(all);
    }
    return { points: [] };
  });
  await pg.boot();
  await settle();
  const picks = pg.$("highlightsWrap").innerHTML + pg.$("highlightsWrap").children.map(el => el.innerHTML).join("");
  assert.match(picks, /Golden cross[\s\S]*Steady Riser/);
  assert.doesNotMatch(picks, /Repriced Foil/);
  assert.match(pg.$("gxBody").innerHTML, /Repriced Foil/, "it's still in the list");
});

test("Selling fast: Days left shows ~N days, explains itself, sorts shortest first with blanks last both ways (#368)", async () => {
  const body = sfBody();
  body.coverage.daysLeftMinSales = 5;
  const [msc, c13] = body.cards[0].printings;
  Object.assign(msc, { available: 189, daysLeft: 66.2 });
  Object.assign(c13, { available: 50, daysLeft: 35 });
  const island = body.cards[1].printings[0];
  Object.assign(island, { available: 12, daysLeft: null, sales7: 3 });
  const pg = await sellingPage(body);
  pg.$("sfHideLands").checked = false;
  await pg.$("sfHideLands").fire("change");
  await pg.$("sellBody").children.find(r => /Trading Post/.test(r.innerHTML)).onclick();
  await pg.$("sellBody").children.find(r => /Island/.test(r.innerHTML)).onclick();
  const rows = () => pg.$("sellBody").children;
  const html = n => rows().find(r => r.className === "child-row" && r.innerHTML.includes(n)).innerHTML;
  assert.match(html("MSC"), /data-v="66.2" title="About 66 days of listings left: 189 copies listed on Manapool now \(every seller together\) ÷ about 2.9 sold a day[^"]*not a forecast for your own price[^"]*">~66d<\/td>/);
  assert.match(html("M21"), /data-v="" title="Too few separate sales in the last 7 days to estimate \(it needs 5\)\."><span class="faint">—/);
  assert.doesNotMatch(rows().find(r => /Trading Post/.test(r.innerHTML)).innerHTML, /~\d+d/, "a card row leaves it blank");

  const order = () => rows().filter(r => r.className !== "child-row").map(r => /Trading Post/.test(r.innerHTML) ? "TP" : "IS");
  const kids = () => rows().filter(r => r.className === "child-row" && /MSC|C13/.test(r.innerHTML)).map(r => /MSC/.test(r.innerHTML) ? "MSC" : "C13");
  const head = pg.$("sellTable").tHead;
  head.closest = () => ({ cellIndex: 9 });
  await head.fire("click");
  assert.deepEqual(order(), ["TP", "IS"], "the card whose printing runs out first leads; no estimate sinks");
  assert.deepEqual(kids(), ["C13", "MSC"], "shortest first");
  await head.fire("click");
  assert.deepEqual(order(), ["TP", "IS"], "reversed: no estimate still sinks");
  assert.deepEqual(kids(), ["MSC", "C13"]);
});

test("Selling fast: sorting by Listed supply reorders the cards by their biggest printing drop (#365)", async () => {
  const body = sfBody();
  Object.assign(body.cards[0].printings[0], { available: 189, available7DaysAgo: 584 });
  Object.assign(body.cards[1].printings[0], { available: 100, available7DaysAgo: 120 });
  const pg = await sellingPage(body);
  pg.$("sfHideLands").checked = false;
  await pg.$("sfHideLands").fire("change");
  const order = () => pg.$("sellBody").children.map(r => /Trading Post/.test(r.innerHTML) ? "TP" : /Island/.test(r.innerHTML) ? "IS" : "?");
  assert.deepEqual(order(), ["IS", "TP"], "default: most sold first");
  const head = pg.$("sellTable").tHead;
  head.closest = () => ({ cellIndex: 8 });
  await head.fire("click");
  assert.deepEqual(order(), ["TP", "IS"], "biggest supply drop first");
});
