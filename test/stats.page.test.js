"use strict";
/* #115 / #116: Statistics at collection scale, through the real
   stats.page.js with a stand-in DOM (test-lib/page-shim.js), plus core's
   receipt index. A location, metric or query change must not go back to the
   server (Sold vs market's route can call Manapool live), and Spend by
   receipt must not scan the collection per receipt line. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

const LOOKUPS = /\/api\/cards\/(collection|set-completion)/;

function seed(G, n) {
  G.state.locations.push(G.newLocation({ id: "A", name: "Shelf A", type: "bin" }));
  G.state.locations.push(G.newLocation({ id: "B", name: "Shelf B", type: "bin" }));
  for (let i = 0; i < n; i++) {
    G.state.cards.push({ id: "s" + i, name: "Card " + (i % 900), set: "s" + (i % 40), collector: String(i % 300), lang: "en",
      finish: i % 7 ? "nonfoil" : "foil", condition: "NM", quantity: 1 + (i % 3), listedQty: 0, price: 0.25 * (i % 9),
      locationId: i % 2 ? "A" : "B", oracleId: "o" + (i % 900), typeLine: "Creature", rarity: "common", colorIdentity: "G" });
  }
  G.state.history = [{ id: "h1", ts: "2026-10-01T00:00:00Z", type: "pick", lines: [
    { name: "Card 1", set: "s1", collector: "1", finish: "nonfoil", qty: 2, unitPrice: 3 },
    { name: "Card 2", set: "s2", collector: "2", finish: "foil", qty: 1, unitPrice: 5 }] }];
  G.state.receipts = [{ receiptId: "R1", ts: "2026-09-01T00:00:00Z", kind: "lot", source: "LGS", spend: 10, totalCards: 3,
    lines: [{ set: "s1", collector: "001", finish: "nonfoil", qty: 2, market: 9 }, { set: "zzz", collector: "1", finish: "nonfoil", qty: 1, market: 4 }] }];
}

function statsPage(n) {
  const pg = loadPage("stats.page.js", {
    routes: url => {
      if (url.includes("/api/cards/collection")) {
        return { found: [{ set: "s1", collector: "1", lang: "en", prices: { usd: 2 }, price: 2, imageUrl: "" }] };
      }
      if (url.includes("/api/cards/set-completion")) return { data: [{ set: "s1", setName: "Set 1", total: 10, owned: 4 }] };
      return {};
    }
  });
  seed(pg.G, n);
  pg.$("locMetric").value = "cards";
  pg.$("setMetric").value = "cards";
  return pg;
}
const lookups = pg => pg.net.filter(r => LOOKUPS.test(r.url));

test("changing the location or metric on a big collection sends no request (#115)", async () => {
  const pg = statsPage(20000);
  await pg.boot();
  await settle();
  assert.equal(lookups(pg).length, 2, "one Sold lookup and one Collector lookup on load");
  pg.$("scopeLoc").value = "A";
  await pg.$("scopeLoc").fire("change");
  pg.$("locMetric").value = "value";
  await pg.$("locMetric").fire("change");
  await settle();
  assert.equal(lookups(pg).length, 2, "no new market or set-completion request");
  assert.match(pg.$("scopeHdr").textContent, /of 20000 stacks selected/, "it still redrew");
  assert.match(pg.$("soldTiles").innerHTML, /Total sold/, "Sold vs market redrawn from the prices in hand");
});

test("Sold vs market fetches again when a new printing is sold, and Collector when the owned set changes (#115)", async () => {
  const pg = statsPage(50);
  await pg.boot();
  await settle();
  pg.G.state.history.push({ id: "h2", ts: "2026-10-02T00:00:00Z", type: "pick", lines: [
    { name: "Card 3", set: "s3", collector: "3", finish: "nonfoil", qty: 1, unitPrice: 1 }] });
  pg.G.emit("change");
  await settle(200);   // the page debounces change events
  const sold = pg.net.filter(r => r.url.includes("/api/cards/collection"));
  assert.equal(sold.length, 2);
  assert.equal(sold[1].body.identifiers.length, 3);
  assert.equal(pg.net.filter(r => r.url.includes("set-completion")).length, 1, "owned cards didn't change");
  pg.G.state.cards.push({ id: "new", name: "Fresh", set: "new", collector: "1", lang: "en", finish: "nonfoil",
    condition: "NM", quantity: 1, price: 1, locationId: "A", oracleId: "o-fresh" });
  pg.G.emit("change");
  await settle(200);
  assert.equal(pg.net.filter(r => r.url.includes("set-completion")).length, 2);
});

test("a superseded Sold vs market response doesn't draw over the newer one (#115)", async () => {
  const waits = [];
  const pg = loadPage("stats.page.js", {
    routes: (url, init, body) => {
      if (!url.includes("/api/cards/collection")) return url.includes("set-completion") ? { data: [] } : {};
      return new Promise(r => waits.push({ n: body.identifiers.length, r }));
    }
  });
  seed(pg.G, 10);
  await pg.boot();
  await settle();
  // A new sale lands while the first lookup is still out.
  pg.G.state.history.push({ id: "h2", ts: "2026-10-02T00:00:00Z", type: "pick", lines: [
    { name: "Card 3", set: "s3", collector: "3", finish: "nonfoil", qty: 1, unitPrice: 1 }] });
  pg.G.emit("change");
  await settle(200);
  assert.equal(waits.length, 2);
  waits[1].r({ found: [] });
  await settle();
  assert.match(pg.$("soldTiles").innerHTML, /3 printing/);
  waits[0].r({ found: [] });
  await settle();
  assert.match(pg.$("soldTiles").innerHTML, /3 printing/, "the 2-printing response that came back last was dropped");
});

test("#116: the query chip's clear button is labelled, and Sold's empty state spans all 10 columns", async () => {
  const pg = loadPage("stats.page.js", { routes: url => url.includes("set-completion") ? { data: [] } : {} });
  await pg.boot();
  assert.match(pg.$("soldBody").innerHTML, /^\[emptyrow 10:/);
  // Open the query builder and come back with one condition.
  pg.ui.openQuery = async () => Object.assign(pg.G.emptyQuery(), { name: "bolt" });
  await pg.$("btnQuery").fire("click");
  const chip = pg.$("queryChip").innerHTML;
  assert.match(chip, /title="Clear the query"/);
  assert.match(chip, /aria-label="Clear the query"/);
  assert.doesNotMatch(chip, /✕/);
});

test("receipt market values come from one index, matching the old per-line scan (#115)", () => {
  const G = freshCoreWithLocation("A", "Shelf A");
  seed(G, 70000);
  const idx = G.printFinishIndex(G.state.cards);
  const old = r => {
    let market = 0, priced = 0;
    for (const l of r.lines) {
      const rec = G.state.cards.find(c => c.set === l.set && G.normNum(c.collector) === G.normNum(l.collector) && c.finish === l.finish);
      const p = rec ? rec.price : l.market;
      if (p != null) { market += p * l.qty; priced += l.qty; }
    }
    return { market, priced };
  };
  const receipt = G.state.receipts[0];
  assert.deepEqual({ ...G.receiptMarket(receipt, idx) }, old(receipt));
  // 300 receipts x 40 lines against 70k stacks: map lookups, not 12,000 scans.
  const lines = Array.from({ length: 40 }, (_, i) => ({ set: "s" + (i % 40), collector: String(i), finish: "nonfoil", qty: 1, market: 1 }));
  const t0 = process.hrtime.bigint();
  const idx2 = G.printFinishIndex(G.state.cards);
  for (let i = 0; i < 300; i++) G.receiptMarket({ lines }, idx2);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, "300 receipts priced in " + ms.toFixed(0) + " ms");
});

test("sameKeySet compares contents, not order", () => {
  const G = freshCoreWithLocation();
  assert.equal(G.sameKeySet(new Set(["a", "b"]), new Set(["b", "a"])), true);
  assert.equal(G.sameKeySet(new Set(["a"]), new Set(["a", "b"])), false);
  assert.equal(G.sameKeySet(new Set(["a", "c"]), new Set(["a", "b"])), false);
  assert.equal(G.sameKeySet(new Set(), null), false, "nothing fetched yet is never a match");
});
