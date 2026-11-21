"use strict";
/* server/lib/mpSales.js - the Manapool sales history behind "Selling fast"
   (#202). Real (scratch, temp-dir) SQLite archive, never the live dataDir;
   no network: the catalog download and the API lookup are stubbed.

   Covers the three things the issue's Done-when names:
   - de-duplication across overlapping daily snapshots (and a top-up poll
     that formats created_at differently),
   - the 20-sale cap: gap detection, which printings get re-polled, and a
     top-up closing the gap,
   - retention: old sales ignored on ingest, buckets/identities pruned,
   plus the streaming catalog reader and the Selling fast rollup. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { PassThrough } = require("stream");
const store = require(path.join(__dirname, "..", "server", "lib", "store"));
const prices = require(path.join(__dirname, "..", "server", "lib", "prices"));
const mpSales = require(path.join(__dirname, "..", "server", "lib", "mpSales"));

const H = 3600000, D = 24 * H;
// Midday UTC of today (#373). The windows end on the latest catalog's UTC
// date (#354), so a NOW that floated with the clock gave different answers
// depending on the hour the suite ran (a catalog taken "2 hours ago" is
// yesterday's just after 00:00 UTC). It stays on today's date because the
// catalog-download and top-up paths read the real clock for retention.
const NOW = Math.floor(Date.now() / D) * D + 12 * H;
const tmpDirs = [];
after(() => {
  prices.closeDb();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

function freshEnv(pricesCfg) {
  prices.closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-mpsales-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  prices.init({ prices: {} });
  mpSales.init({ prices: pricesCfg || {} }, { log: () => {} });
  return dir;
}
const sale = (ms, price, quantity) => ({ created_at: new Date(ms).toISOString(), price, quantity });
function single(sid, name, variants, extra) {
  return Object.assign({
    scryfall_id: sid, name, set_code: "TST", number: sid.slice(-3), available_quantity: 7,
    variants: variants.map(([productId, sales]) => ({
      product_type: "mtg_single", product_id: productId, language_id: "EN", condition_id: "NM", finish_id: "NF",
      low_price: 100, available_quantity: 1, recent_sales: sales
    }))
  }, extra || {});
}
// 20 sales, newest first, `step` apart.
// (Each price is unique to its minute: sales of one date at one price and
// quantity are interchangeable to Manapool, so tests that mean distinct sales
// keep them distinct.)
const twenty = (newest, step) => Array.from({ length: 20 }, (_, i) => { const ms = newest - i * step; return sale(ms, 100 + Math.floor(ms / 60000) % 997, 1); });
function ingest(kind, observedMs, singles, nowMs) {
  const run = mpSales.beginRun(kind, observedMs, { nowMs: nowMs || NOW });
  for (const s of singles) run.add(s);
  return run.finish();
}
const db = () => prices.dbHandle();
const totals = () => db().prepare("SELECT COALESCE(SUM(copies),0) AS copies, COALESCE(SUM(sales),0) AS sales FROM mp_sale_days").get();

test("dedup: overlapping daily snapshots count each sale once", () => {
  freshEnv();
  const a = sale(NOW - 40 * H, 100, 2), b = sale(NOW - 30 * H, 100, 1);
  ingest("catalog", NOW - 24 * H, [single("sid-001", "Alpha", [["v1", [b, a]]])]);
  assert.deepEqual({ ...totals() }, { copies: 3, sales: 2 });

  // Next day: one new sale on top of the same two.
  const c = sale(NOW - 2 * H, 110, 3);
  const st = ingest("catalog", NOW, [single("sid-001", "Alpha", [["v1", [c, b, a]]])]);
  assert.equal(st.newSales, 1);
  assert.deepEqual({ ...totals() }, { copies: 6, sales: 3 });

  // The identical snapshot again (e.g. an admin re-run) adds nothing.
  assert.equal(ingest("catalog", NOW, [single("sid-001", "Alpha", [["v1", [c, b, a]]])]).newSales, 0);

  // A top-up returning the same sale with "+00:00" and microseconds instead
  // of "Z" is still the same sale.
  const micro = { created_at: new Date(NOW - 2 * H).toISOString().replace("Z", "123+00:00"), price: 110, quantity: 3 };
  assert.equal(ingest("topup", NOW, [single("sid-001", "Alpha", [["v1", [micro]]])]).newSales, 0);

  // Same time/price/quantity on a DIFFERENT variant is a different sale, and
  // so is a different quantity on the same variant.
  ingest("catalog", NOW, [single("sid-001", "Alpha", [["v1", [c, b, a, sale(NOW - 40 * H, 100, 5)]], ["v2", [c]]])]);
  assert.deepEqual({ ...totals() }, { copies: 14, sales: 5 });

  // Buckets are per sale day.
  // Only days with sales: the snapshot day also gets a row (avail, capped) with
  // copies 0, and in UTC late evening that is a different day from the sales.
  const days = db().prepare("SELECT day, copies FROM mp_sale_days WHERE copies > 0 ORDER BY day").all();
  const byDay = {};
  for (const r of days) byDay[r.day] = r.copies;
  const expect = {};
  for (const [ms, q] of [[NOW - 40 * H, 2], [NOW - 30 * H, 1], [NOW - 2 * H, 3], [NOW - 40 * H, 5], [NOW - 2 * H, 3]]) {
    const d = mpSales.saleDay(ms); expect[d] = (expect[d] || 0) + q;
  }
  assert.deepEqual(byDay, expect);
});

test("cap: a gap is flagged, the overdue printings are re-polled (bounded), and a top-up closes the gap", async () => {
  freshEnv();
  const T0 = NOW - 26 * H, T1 = NOW - 2 * H;
  // First look: nothing to compare against, so no gap even at the cap.
  let st = ingest("catalog", T0, [
    single("sid-00x", "Fast X", [["vx", twenty(T0 - H, H)]]),           // 20 sales in ~20h: tracked
    single("sid-00y", "Slow Y", [["vy", twenty(T0 - H, 12 * H)]]),      // 20 sales in ~10 days: not a candidate
    single("sid-00z", "Brisk Z", [["vz", twenty(T0 - H, 2 * H)]])       // 20 sales in ~40h: tracked
  ]);
  assert.equal(st.capped, 3);
  assert.equal(st.gaps, 0);

  // A day later X's 20 sales all fall after T0: whatever sold in between is
  // lost. Z's reach back past T0, so Z is complete.
  st = ingest("catalog", T1, [
    single("sid-00x", "Fast X", [["vx", twenty(T1 - 0.1 * H, 0.2 * H)]]),
    single("sid-00y", "Slow Y", [["vy", twenty(T0 - H, 12 * H)]]),
    single("sid-00z", "Brisk Z", [["vz", twenty(T1 - H, 2 * H)]])
  ]);
  assert.equal(st.capped, 3);
  assert.equal(st.gaps, 1);
  const xPid = db().prepare("SELECT pid FROM mp_printings WHERE sid = 'sid-00x'").get().pid;
  const cappedDays = db().prepare("SELECT day FROM mp_sale_days WHERE pid = ? AND capped = 1 ORDER BY day").all(xPid).map(r => r.day);
  assert.ok(cappedDays.includes(mpSales.saleDay(T0)), "the day of the last look is flagged");
  assert.ok(cappedDays.includes(mpSales.saleDay(T1 - 3.9 * H)), "the day of the oldest returned sale is flagged");
  assert.deepEqual(db().prepare("SELECT variant FROM mp_capped ORDER BY variant").all().map(r => r.variant), ["vx", "vz"]);

  // The read API reports X's count as a minimum.
  const sf = mpSales.sellingFast({ nowMs: NOW });
  assert.equal(sf.cards.find(c => c.name === "Fast X").capped7, true);
  assert.equal(sf.cards.find(c => c.name === "Fast X").atLeast7, true);
  assert.equal(sf.cards.find(c => c.name === "Brisk Z").capped7, false);
  // ...but history began yesterday, so every 7-day count is a minimum anyway.
  assert.equal(sf.cards.find(c => c.name === "Brisk Z").atLeast7, true);
  assert.equal(sf.coverage.windows.d7.complete, false);

  // Right now only X (gap) is due; once Z's 20-sale span has passed since its
  // last look, Z is overdue too. Bounded by `max`, gap first.
  assert.deepEqual(mpSales.topupCandidates(NOW, 10).map(c => c.sid), ["sid-00x"]);
  assert.deepEqual(mpSales.topupCandidates(T1 + 40 * H, 10).map(c => c.sid), ["sid-00x", "sid-00z"]);
  assert.deepEqual(mpSales.topupCandidates(T1 + 40 * H, 1).map(c => c.sid), ["sid-00x"]);

  // Top-up: polls only the candidates; X's response now reaches back past
  // the last look (T1), so the gap closes and X stops being due.
  const asked = [];
  const fresh6 = Array.from({ length: 6 }, (_, i) => sale(NOW - (0.1 + 0.3 * i) * H, 105, 1));
  const r = await mpSales.topup({ email: "e", accessToken: "t" }, {
    nowMs: NOW,
    lookup: async (creds, ids, onChunk) => {
      asked.push(...ids);
      onChunk(new Date(NOW).toISOString(), [single("sid-00x", "Fast X", [["vx", [...fresh6, ...twenty(T1 - 0.1 * H, 0.2 * H).slice(0, 14)]]])]);
    }
  });
  assert.deepEqual(asked, ["sid-00x"]);
  assert.equal(r.polled, 1);
  assert.equal(r.gaps, 0);
  assert.equal(r.newSales, 6, "only the sales since the last snapshot are new");
  assert.deepEqual(mpSales.topupCandidates(NOW + 60000, 10).map(c => c.sid), []);
  assert.ok(mpSales.sellingFast({ nowMs: NOW }).coverage.lastTopupAt);
});

test("top-up does nothing before the first catalog snapshot", async () => {
  freshEnv();
  let called = false;
  const r = await mpSales.topup({ email: "e", accessToken: "t" }, { lookup: async () => { called = true; } });
  assert.equal(r.skipped, "no catalog snapshot yet");
  assert.equal(called, false);
});

test("retention: sales older than the window are ignored, and prune drops expired buckets, identities and printings", () => {
  freshEnv({ mpSalesKeepDays: 40 });
  const old = sale(NOW - 50 * D, 100, 1);       // before the window: never counted
  const mid = sale(NOW - 30 * D, 100, 4);       // inside it
  const st = ingest("catalog", NOW, [single("sid-0r1", "Retained", [["vr", [mid, old]]])]);
  assert.equal(st.salesInWindow, 1);
  assert.deepEqual({ ...totals() }, { copies: 4, sales: 1 });
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM mp_seen").get().n, 1);

  // 15 days later the 30-day-old sale is 45 days old: outside a 40-day window.
  const later = mpSales.saleDay(NOW + 15 * D);
  mpSales.prune(later);
  assert.deepEqual({ ...totals() }, { copies: 0, sales: 0 });
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM mp_seen").get().n, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM mp_printings").get().n, 0);

  // ...and seeing it again then doesn't count it back in.
  const st2 = ingest("catalog", NOW + 15 * D, [single("sid-0r1", "Retained", [["vr", [mid]]])], NOW + 15 * D);
  assert.equal(st2.newSales, 0);
  assert.deepEqual({ ...totals() }, { copies: 0, sales: 0 });
});

test("sellingFast: rolls printings up by name, ranks by 7-day copies, flags a pace spike, bounded by limit", () => {
  freshEnv();
  // History starts 20 days ago.
  ingest("catalog", NOW - 20 * D, [single("sid-0h0", "Seed", [["vs", [sale(NOW - 20 * D - H, 50, 1)]]])]);
  const recent = n => Array.from({ length: n }, (_, i) => sale(NOW - (i + 1) * 6 * H, 100, 1));       // within ~2 days
  const spread = (n, fromDay) => Array.from({ length: n }, (_, i) => sale(NOW - (fromDay + i) * D, 100, 1));
  ingest("catalog", NOW, [
    single("sid-0h1", "Hot Card", [["h1", [...recent(6), ...spread(2, 15)]]]),
    single("sid-0h2", "Hot Card", [["h2", recent(4)]], { set_code: "ALT" }),
    single("sid-0s1", "Steady Card", [["s1", [...Array.from({ length: 7 }, (_, i) => sale(NOW - (0.2 + 0.8 * i) * D, 100, 1)), ...spread(14, 8)]]])
  ]);
  const sf = mpSales.sellingFast({ nowMs: NOW, limit: 1 });
  assert.equal(sf.total, 2);                     // Hot and Steady; Seed sold 20 days ago, not in the last 7
  assert.equal(sf.cards.length, 1);
  const hot = sf.cards[0];
  assert.equal(hot.name, "Hot Card");
  assert.equal(hot.copies7, 10);
  assert.equal(hot.copies30, 12);
  assert.equal(hot.printingCount, 2);
  assert.deepEqual(hot.printings.map(p => p.scryfallId), ["sid-0h1", "sid-0h2"]);
  assert.equal(hot.printings[0].available, 7);
  assert.equal(hot.hot, true);
  assert.equal(sf.coverage.source, "manapool");
  assert.equal(sf.coverage.historySince, mpSales.saleDay(NOW - 20 * D));
  assert.equal(sf.coverage.historyDays, 21);
  assert.equal(sf.coverage.window30Complete, false);
  assert.equal(sf.coverage.windows.d7.complete, true);
  assert.equal(sf.coverage.windows.d30.start, mpSales.saleDay(NOW - 29 * D));
  assert.equal(hot.capped7, false);
  assert.equal(hot.atLeast7, false, "7-day window fully inside our history");
  assert.equal(hot.atLeast30, true, "30-day window starts before our history");
  assert.equal(hot.printings[0].atLeast30, true);
  assert.equal(sf.coverage.topup.enabled, false);
  // #223: each printing carries its own pace and the same SELLING FAST rule
  // as the card. #354: the baseline is the 14 days of history BEFORE the 7.
  assert.equal(hot.baselineDays, 14);
  const [p1, p2] = hot.printings;
  assert.deepEqual({ pace7: p1.pace7, paceBaseline: p1.paceBaseline, paceRatio: p1.paceRatio, hot: p1.hot },
    { pace7: 0.86, paceBaseline: 0.14, paceRatio: 6, hot: true });
  assert.deepEqual({ pace7: p2.pace7, paceBaseline: p2.paceBaseline, paceRatio: p2.paceRatio, hot: p2.hot },
    { pace7: 0.57, paceBaseline: 0, paceRatio: null, hot: false }, "nothing before, but under the 5-copy minimum");
  assert.equal("salesBase" in p1, false, "the raw baseline count stays server-side");

  // 7 sales this week, 13 in the 14 days before: about its usual pace.
  const steady = mpSales.sellingFast({ nowMs: NOW, limit: 5 }).cards.find(c => c.name === "Steady Card");
  assert.equal(steady.copies7, 7);
  assert.equal(steady.paceRatio, 1.08);
  assert.equal(steady.hot, false);
});

test("sellingFast: no pace flag while there's under two weeks of history", () => {
  freshEnv();
  ingest("catalog", NOW, [single("sid-0n1", "New Card", [["n1", Array.from({ length: 9 }, (_, i) => sale(NOW - (i + 1) * H, 100, 1))]])]);
  const c = mpSales.sellingFast({ nowMs: NOW }).cards[0];
  assert.equal(c.copies7, 9);
  assert.equal(c.hot, null);
  assert.equal(c.printings[0].hot, null, "a printing is 'too early' too (#223)");
});

test("streamDataArray: splits elements across chunk boundaries, respects strings, stops at the array's end", async () => {
  const doc = JSON.stringify({ data: [{ a: "x}{]\"[", n: [1, { b: 2 }] }, { c: "\\" }, { d: [] }], meta: { e: "{not an element}" } });
  const s = new PassThrough();
  const got = [];
  const p = mpSales.streamDataArray(s, t => got.push(JSON.parse(t)));
  for (let i = 0; i < doc.length; i += 3) s.write(Buffer.from(doc.slice(i, i + 3)));
  s.end();
  const r = await p;
  assert.deepEqual(r, { count: 3, complete: true });
  assert.deepEqual(got, JSON.parse(doc).data);
});

test("refreshCatalog: streams a gzipped catalog end to end, then skips an unchanged one by ETag", async () => {
  freshEnv();
  const data = [];
  for (let i = 0; i < 1200; i++) data.push(single("sid-" + String(i).padStart(4, "0"), "Card " + i, [["p" + i, i % 100 === 0 ? [sale(NOW - H, 100, 2)] : []]]));
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ data, meta: { as_of: new Date(NOW).toISOString() } })));
  const seen = [];
  const fetchStub = async (url, opts) => {
    seen.push(opts.headers["If-None-Match"] || null);
    if (opts.headers["If-None-Match"] === '"v1"') return new Response(null, { status: 304 });
    return new Response(gz, { status: 200, headers: { etag: '"v1"', "last-modified": new Date(NOW).toUTCString() } });
  };
  const st = await mpSales.refreshCatalog({ fetch: fetchStub });
  assert.equal(st.catalogPrintings, 1200);
  assert.equal(st.parsed, 12);                   // only printings with any sale are parsed
  assert.equal(st.newSales, 12);
  assert.ok(st.peakRssMb > 0 && st.durationMs >= 0);
  assert.deepEqual({ ...totals() }, { copies: 24, sales: 12 });
  assert.equal(mpSales.status().lastRun.newSales, 12);

  const again = await mpSales.refreshCatalog({ fetch: fetchStub });
  assert.equal(again.skipped, "unchanged");
  assert.deepEqual(seen, [null, '"v1"']);

  // A truncated download is refused as a snapshot.
  const cut = zlib.gzipSync(Buffer.from(JSON.stringify({ data }).slice(0, 5000)));
  await assert.rejects(mpSales.refreshCatalog({ force: true, fetch: async () => new Response(cut, { status: 200 }) }),
    /truncated/);
});

/* A catalog whose body only arrives after `beforeBody()` runs, i.e. after
   refreshCatalog() has opened its run: a stand-in for a restart closing
   prices.db while the download is mid-stream. */
function lateCatalog(beforeBody) {
  const data = [];
  for (let i = 0; i < 1200; i++) data.push(single("sid-L" + String(i).padStart(4, "0"), "Late " + i, [["L" + i, [sale(NOW - H, 100, 1)]]]));
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ data })));
  // The stream pulls its first chunk as soon as it's built (before the run
  // opens), so the first ~10% goes out untouched; beforeBody() runs when the
  // consumer asks for the rest, i.e. mid-stream with the run open.
  const cut = Math.floor(gz.length / 10);
  let step = 0;
  const state = { calledMidRun: false };
  const fetchStub = async () => new Response(new ReadableStream({
    pull(ctrl) {
      step++;
      if (step === 1) { ctrl.enqueue(new Uint8Array(gz.subarray(0, cut))); return; }
      if (step === 2) {
        state.calledMidRun = mpSales.busy() === "catalog";
        beforeBody();
        ctrl.enqueue(new Uint8Array(gz.subarray(cut)));
        return;
      }
      ctrl.close();
    }
  }), { status: 200 });
  fetchStub.state = state;
  return fetchStub;
}

test("a write failing inside the stream's data listener rejects the job, it doesn't crash the process", async () => {
  freshEnv();
  let uncaught = null;
  const onUncaught = e => { uncaught = e; };
  process.on("uncaughtException", onUncaught);
  try {
    const f = lateCatalog(() => prices.closeDb());
    await assert.rejects(mpSales.refreshCatalog({ fetch: f }), /not open/i);
    assert.equal(f.state.calledMidRun, true, "the archive closed mid-stream, so the failing write was inside the data listener");
    await new Promise(r => setTimeout(r, 50));
    assert.equal(uncaught, null);
    assert.equal(mpSales.busy(), null, "the job is no longer marked running");
  } finally { process.off("uncaughtException", onUncaught); }
});

test("stop() before a restart turns in-flight writes into no-ops and new runs into skips", async () => {
  freshEnv();
  const f = lateCatalog(() => { mpSales.stop(); prices.closeDb(); });
  await assert.rejects(mpSales.refreshCatalog({ fetch: f }), /stopped|abort/i);
  assert.equal(f.state.calledMidRun, true);
  assert.equal(mpSales.busy(), null);
  assert.equal((await mpSales.refreshCatalog({ fetch: lateCatalog(() => {}) })).skipped, "stopping for a restart");
  assert.equal((await mpSales.topup({ email: "e", accessToken: "t" }, { lookup: async () => {} })).skipped, "stopping for a restart");
});

test("sellingFast: one cached ranking serves every limit", () => {
  freshEnv();
  ingest("catalog", NOW, ["A", "B", "C"].map((n, i) =>
    single("sid-0c" + i, "Card " + n, [["c" + i, Array.from({ length: 3 - i }, (_, k) => sale(NOW - (k + 1) * H, 100, 1))]])));
  const one = mpSales.sellingFast({ nowMs: NOW, limit: 1 });
  const three = mpSales.sellingFast({ nowMs: NOW, limit: 3 });
  assert.equal(one.cards.length, 1);
  assert.equal(three.cards.length, 3);
  assert.equal(three.limit, 3);
  assert.deepEqual(three.cards.map(c => c.name), ["Card A", "Card B", "Card C"]);
  assert.deepEqual(mpSales.sellingFast({ nowMs: NOW, limit: 1 }).cards, one.cards);
});

/* #231: a card name search reaches every card that sold, not just the top
   list, without the cached ranking holding detail for the long tail. */
function searchEnv() {
  freshEnv();
  const sales = (tag, n) => Array.from({ length: n }, (_, k) => sale(NOW - (k + 1) * H - tag.length * 1000, 100, 1));
  const singles = [single("sid-lb1", "Lightning Bolt", [["lb1", sales("lb1", 6)]]),
    single("sid-lb2", "Lightning Bolt", [["lb2", sales("lb2", 2)]], { set_code: "ALT" })];
  for (let i = 0; i < 502; i++) {
    const id = String(i).padStart(3, "0");
    singles.push(single("sid-f" + id, "Filler " + id, [["f" + id, sales("f" + id, 2)]]));
  }
  // Ranked last: one copy, two printings.
  singles.push(single("sid-zb1", "Zzyzx Bolt", [["zb1", sales("zb1", 1)]]), single("sid-zb2", "Zzyzx Bolt", [["zb2", []]], { set_code: "ALT" }));
  ingest("catalog", NOW, singles);
}

test("sellingSearch: finds cards ranked outside the top list, with full detail and their overall rank", () => {
  searchEnv();
  const top = mpSales.sellingFast({ nowMs: NOW, limit: 500 });
  assert.equal(top.total, 504);
  assert.equal(top.cards.length, 500);
  assert.equal(top.cards[0].rank, 1);
  assert.ok(!top.cards.some(c => c.name === "Zzyzx Bolt"), "below the top 500");

  const r = mpSales.sellingSearch({ nowMs: NOW, q: "  BOLT " });
  assert.equal(r.query, "bolt");
  assert.equal(r.matched, 2);
  assert.equal(r.limit, 500);
  assert.equal(r.total, 504);
  assert.deepEqual(r.cards.map(c => [c.name, c.rank]), [["Lightning Bolt", 1], ["Zzyzx Bolt", 504]]);
  assert.deepEqual(r.cards[0], top.cards[0], "a top-list match is the cached row");
  const zb = r.cards[1];
  assert.equal(zb.copies7, 1);
  assert.equal(zb.printingCount, 1, "the printing with no sales isn't counted");
  assert.deepEqual(zb.printings.map(p => p.scryfallId), ["sid-zb1"]);
  assert.equal(zb.hot, null, "same pace fields as the top list");
  assert.equal(zb.baselineDays, 0, "no history before the 7 days yet");
  assert.equal(zb.paceRatio, null);
  assert.equal("salesBase" in zb.printings[0], false);
  assert.equal(r.coverage.source, "manapool");
});

test("sellingSearch: caps the detailed results, best sellers first; no match or no query finds nothing", () => {
  searchEnv();
  const r = mpSales.sellingSearch({ nowMs: NOW, q: "filler" });
  assert.equal(r.matched, 502);
  assert.equal(r.cards.length, r.searchMax);
  assert.equal(r.searchMax, 50);
  assert.deepEqual(r.cards.map(c => c.rank), Array.from({ length: 50 }, (_, i) => i + 2));
  assert.deepEqual(mpSales.sellingSearch({ nowMs: NOW, q: "nope" }).cards, []);
  assert.equal(mpSales.sellingSearch({ nowMs: NOW, q: "nope" }).matched, 0);
  assert.equal(mpSales.sellingSearch({ nowMs: NOW, q: "  " }).matched, 0);
});

/* #233: "Show 500 more" pages past the cached top list by offset. */
test("sellingFast: offset pages continue the ranking past the top list, with full detail built on demand", () => {
  searchEnv();
  const top = mpSales.sellingFast({ nowMs: NOW, limit: 500 });
  assert.equal(top.offset, 0);
  const next = mpSales.sellingFast({ nowMs: NOW, limit: 500, offset: 500 });
  assert.equal(next.offset, 500);
  assert.equal(next.total, 504);
  assert.deepEqual(next.cards.map(c => c.rank), [501, 502, 503, 504]);
  assert.equal(next.cards[3].name, "Zzyzx Bolt");
  assert.deepEqual(next.cards[3], mpSales.sellingSearch({ nowMs: NOW, q: "zzyzx" }).cards[0], "same row as the search builds");
  assert.equal(next.cards[0].printingCount, 1);
  assert.equal("copiesBase" in next.cards[0].printings[0], false);
  // A page straddling the cached list: cached rows first, then on-demand ones, in rank order.
  const mid = mpSales.sellingFast({ nowMs: NOW, limit: 3, offset: 498 });
  assert.deepEqual(mid.cards.map(c => c.rank), [499, 500, 501]);
  assert.deepEqual(mid.cards[0], top.cards[498]);
  assert.deepEqual(mid.cards[2], next.cards[0]);
  // Past the end, or junk: an empty page or the top, never an error.
  assert.deepEqual(mpSales.sellingFast({ nowMs: NOW, offset: 9999 }).cards, []);
  assert.equal(mpSales.sellingFast({ nowMs: NOW, offset: 9999 }).offset, 504);
  assert.equal(mpSales.sellingFast({ nowMs: NOW, limit: 2, offset: "x" }).cards[0].rank, 1);
  assert.equal(mpSales.sellingFast({ nowMs: NOW, limit: 9999, offset: 1 }).cards.length, 500, "at most 500 per request");
});

/* #209: Sold 7d on the Movers table's rows - a batched lookup for an
   explicit list of printings, attached to copies of the rows. */
function soldEnv(now) {
  now = now || NOW;
  freshEnv();
  // History starts 20 days ago, so the 7-day window is complete and paces can be compared.
  ingest("catalog", now - 20 * D, [single("sid-0q0", "Seed", [["vq", [sale(now - 20 * D - H, 50, 1)]]])], now);
  const T0 = now - 26 * H, T1 = now - 2 * H;
  ingest("catalog", T0, [single("sid-0q1", "Capped", [["v1", twenty(T0 - H, H)]])], now);
  ingest("catalog", T1, soldLatest(now), now);
  return T1;
}
// The latest catalog's printings in soldEnv(now).
const soldLatest = now => [
  single("sid-0q1", "Capped", [["v1", twenty(now - 2.1 * H, 0.2 * H)]]),   // all 20 newer than the last look: a gap
  single("sid-0q2", "Hot", [["v2", Array.from({ length: 6 }, (_, i) => sale(now - (i + 1) * 6 * H, 100, 1))]]),
  single("sid-0q3", "Old", [["v3", [sale(now - 12 * D, 100, 4)]]])          // sold, but not in the last 7 days
];

test("soldFor: one batched lookup returns just the printings asked for, with the 'at least' and pace flags", () => {
  soldEnv();
  const { bySid, coverage } = mpSales.soldFor(["sid-0q1", "sid-0q2", "sid-0q3", "sid-nope", null, "sid-0q2"], { nowMs: NOW });
  assert.equal(coverage.window7Complete, true);
  assert.deepEqual([...bySid.keys()].sort(), ["sid-0q1", "sid-0q2", "sid-0q3"], "unknown ids and blanks are just absent");
  const capped = bySid.get("sid-0q1"), hot = bySid.get("sid-0q2"), old = bySid.get("sid-0q3");
  assert.equal(capped.atLeast7, true, "a capped day inside the window makes the count a minimum");
  assert.equal(hot.atLeast7, false);
  assert.equal(hot.copies7, 6);
  assert.equal(hot.hot, true, "6 copies this week against a near-zero baseline");
  assert.equal(old.copies7, 0);
  assert.equal(old.salesBase, 1, "the baseline (the days before the 7) still sees the older sale");
  assert.equal(old.hot, false);
  // The same numbers the Selling fast tab shows for those printings.
  const sf = mpSales.sellingFast({ nowMs: NOW, limit: 10 });
  const tabHot = sf.cards.find(c => c.name === "Hot");
  assert.equal(tabHot.copies7, hot.copies7);
  assert.equal(tabHot.hot, hot.hot);
  assert.equal(sf.cards.find(c => c.name === "Capped").copies7, capped.copies7);
  assert.equal(sf.cards.find(c => c.name === "Capped").atLeast7, true);
});

test("soldFor: ids are looked up in chunks, so a long list still finds a printing at its far end", () => {
  soldEnv();
  const ids = Array.from({ length: 12000 }, (_, i) => "sid-filler-" + i);
  ids.push("sid-0q2");
  const { bySid } = mpSales.soldFor(ids, { nowMs: NOW });
  assert.equal(bySid.size, 1);
  assert.equal(bySid.get("sid-0q2").copies7, 6);
});

test("attachSold: copies the rows, a printing with no recent sale sold 0, an unmatched row is null", () => {
  soldEnv();
  const rows = [
    { set: "tst", collector: "1", finish: "nonfoil", sid: "sid-0q2" },
    { set: "tst", collector: "1", finish: "foil", sid: "sid-0q2" },     // a second finish of the same printing
    { set: "tst", collector: "2", finish: "nonfoil", sid: "sid-0zz" },  // Manapool has no sales for it
    { set: "tst", collector: "3", finish: "nonfoil", sid: null }        // couldn't be matched to a printing
  ];
  const out = mpSales.attachSold(rows, r => r.sid, { nowMs: NOW });
  assert.equal(rows[0].sold7d, undefined, "the input rows (shared cache objects) are not mutated");
  assert.deepEqual(out.rows.map(r => r.sold7d), [6, 6, 0, null]);
  const pid = db().prepare("SELECT pid FROM mp_printings WHERE sid = 'sid-0q2'").get().pid;
  assert.deepEqual(out.rows.map(r => r.mpId), [pid, pid, null, null], "a small per-printing number, only where sales are on record");
  assert.deepEqual(out.rows.map(r => r.sellingFast), [true, true, false, null]);
  assert.equal(out.rows[2].sold7dAtLeast, false);
  assert.equal(out.rows[0].finish, "nonfoil", "the row's own fields ride along");
  assert.equal(out.sales.source, "manapool");
  assert.equal(out.sales.comparable, true);
  assert.equal(out.sales.baselineDays, 14);
  assert.deepEqual(out.rows.map(r => r.soldSales7), [6, 6, 0, null], "separate sales, for the client's pace rule");
  assert.ok(out.sales.hotMinCopies > 0 && out.sales.hotMinSales > 0 && out.sales.hotRatio > 0, "the client re-applies the pace rule to card roll-ups");
});

test("attachSold: an incomplete 7-day window marks every count, zero included, as a minimum; no history means no numbers", () => {
  freshEnv();
  assert.deepEqual(mpSales.attachSold([{ sid: "sid-0w1" }], r => r.sid, { nowMs: NOW }).rows.map(r => r.sold7d), [null],
    "no history collected yet");
  ingest("catalog", NOW, [single("sid-0w1", "New", [["w1", [sale(NOW - 2 * H, 100, 3)]]])]);
  const out = mpSales.attachSold([{ sid: "sid-0w1" }, { sid: "sid-0w2" }], r => r.sid, { nowMs: NOW });
  assert.deepEqual(out.rows.map(r => [r.sold7d, r.sold7dAtLeast, r.sellingFast]), [[3, true, null], [0, true, null]]);
  assert.equal(out.sales.window7Complete, false);
  assert.equal(out.sales.comparable, false);
});

test("attachSold: the per-printing memo is dropped by the next ingest - a new catalog pull shows on the very next call", () => {
  soldEnv();
  const first = mpSales.attachSold([{ sid: "sid-0q3" }], r => r.sid, { nowMs: NOW }).rows[0].sold7d;
  assert.equal(first, 0);
  assert.equal(mpSales.attachSold([{ sid: "sid-0q3" }], r => r.sid, { nowMs: NOW }).rows[0].sold7d, 0, "memoised answer");
  ingest("catalog", NOW, [single("sid-0q3", "Old", [["v3", [sale(NOW - H, 100, 2), sale(NOW - 12 * D, 100, 4)]]])]);
  assert.equal(mpSales.attachSold([{ sid: "sid-0q3" }], r => r.sid, { nowMs: NOW }).rows[0].sold7d, 2);
});

/* #366: Sold 7d on an account's own stock - soldFor() keyed by what the
   browser can rebuild, sent back compact. */
test("soldByKey (#366): only printings that sold come back, as [copies, atLeast, hot]; unmatched keys are listed", () => {
  soldEnv();
  const out = mpSales.soldByKey([
    { key: "tst|0q1", sid: "sid-0q1" },   // capped: a minimum
    { key: "tst|0q2", sid: "sid-0q2" },   // SELLING FAST
    { key: "tst|0q3", sid: "sid-0q3" },   // sold, but not this week: left out (0)
    { key: "tst|zz", sid: "sid-0zz" },    // Manapool has nothing for it: left out (0)
    { key: "tok|1", sid: null }           // no printing found
  ], { nowMs: NOW });
  const capped = mpSales.soldFor(["sid-0q1"], { nowMs: NOW }).bySid.get("sid-0q1");
  // #368: with 5+ separate sales the tuple adds [days left, copies listed now];
  // every printing here has 7 listed copies.
  assert.deepEqual(out.sold, {
    "tst|0q1": [capped.copies7, 1, capped.hot, mpSales.daysLeftFor(7, capped.copies7, capped.sales7), 7],
    "tst|0q2": [6, 0, true, 8.2, 7]
  });
  assert.deepEqual(out.unmatched, ["tok|1"]);
  assert.equal(out.sales.comparable, true);
  assert.equal(out.sales.window7Complete, true);
  assert.equal(out.sales.historySince != null, true);
  assert.deepEqual(Object.keys(out.sales), Object.keys(mpSales.attachSold([], r => r.sid, { nowMs: NOW }).sales),
    "the same coverage notes Movers gets");
});

test("daysLeftFor (#368): listed copies over copies sold a day; blank with too few sales or unknown supply", () => {
  assert.equal(mpSales.daysLeftFor(14, 49, 40), 2, "14 listed, 7 copies a day: 2 days");
  assert.equal(mpSales.daysLeftFor(63, 7, 5), 63, "5 separate sales is enough");
  assert.equal(mpSales.daysLeftFor(10, 3, 5), 23.3, "rounded to a tenth");
  assert.equal(mpSales.daysLeftFor(0, 12, 6), 0, "nothing listed: none left");
  assert.equal(mpSales.daysLeftFor(63, 40, 4), null, "4 sales, even of 40 copies, is too few to say");
  assert.equal(mpSales.daysLeftFor(null, 40, 40), null, "supply unknown");
  assert.equal(mpSales.daysLeftFor(5, 0, 0), null);
});

test("Selling fast printings carry daysLeft (#368)", () => {
  soldEnv();
  const res = mpSales.sellingFast({ limit: 10, nowMs: NOW });
  const card = res.cards.find(c => c.name === "Hot");
  assert.equal(card.printings[0].available, 7);
  assert.equal(card.printings[0].daysLeft, 8.2, "7 listed / (6 copies / 7 days)");
  assert.equal(res.coverage.daysLeftMinSales, 5);
});

/* #370: Buy List restock hints. Only printings / names that are SELLING FAST
   or whose card is in the week's top RESTOCK_TOP_N come back. */
test("restockFor (#370): SELLING FAST or the week's top list qualifies; a printing must have sold this week; names are the whole card", () => {
  freshEnv();
  ingest("catalog", NOW - 20 * D, [single("sid-0s0", "Seed", [["vs0", [sale(NOW - 20 * D - H, 50, 1)]]])]);
  const spread = (n, fromDay, tag) => Array.from({ length: n }, (_, i) => sale(NOW - (fromDay + i) * D - tag * 1000, 100, 1));
  // Steady sellers: 7 copies this week, about their usual pace, never SELLING FAST.
  const steady = tag => [...Array.from({ length: 7 }, (_, i) => sale(NOW - (0.2 + 0.8 * i) * D - tag * 1000, 100, 1)), ...spread(14, 8, tag)];
  const singles = [];
  for (let i = 0; i < mpSales.RESTOCK_TOP_N + 10; i++) {
    const id = String(i).padStart(3, "0");
    singles.push(single("sid-r" + id, "Steady " + id, [["r" + id, steady(i)]]));
  }
  // 6 copies in two days, nothing before: SELLING FAST, but ranked below every steady card.
  singles.push(single("sid-hot", "Late // Hot", [["hot", Array.from({ length: 6 }, (_, i) => sale(NOW - (i + 1) * 6 * H, 100, 1))]]));
  singles.push(single("sid-zip", "Steady 000", [["zip", [sale(NOW - 12 * D, 100, 1)]]], { set_code: "ALT" }));   // sold, not this week
  ingest("catalog", NOW, singles);

  const top = mpSales.sellingFast({ nowMs: NOW, limit: 500 });
  const rankOf = n => top.cards.find(c => c.name === n).rank;
  const firstOut = top.cards[mpSales.RESTOCK_TOP_N];
  assert.equal(firstOut.hot, false);
  const out = mpSales.restockFor([
    { key: "a", sid: "sid-r000", name: "STEADY 000" },                          // top list, any case
    { key: "b", sid: firstOut.printings[0].scryfallId, name: firstOut.name },  // just outside, steady: no
    { key: "c", sid: "sid-hot", name: "Late" },                                 // front face of a two-faced card; SELLING FAST
    { key: "d", sid: "sid-zip", name: "Steady 000" },                           // top card, but this printing didn't sell this week
    { key: "e", sid: null, name: "Steady 001" },                                // no printing found
    { key: "f", sid: "sid-nope", name: "Steady 002" }                           // Manapool has nothing for it
  ], [{ key: "Late // Hot", name: "Late // Hot" }, { key: "Steady 003", name: "Steady 003" },
    { key: firstOut.name, name: firstOut.name }, { key: "Nope", name: "Nope" }], { nowMs: NOW });
  assert.equal(out.topN, mpSales.RESTOCK_TOP_N);
  assert.equal(out.sales.comparable, true);
  assert.deepEqual(Object.keys(out.prints).sort(), ["a", "c"]);
  assert.deepEqual(out.prints.a, [7, 0, false, rankOf("Steady 000")]);
  assert.deepEqual(out.prints.c, [6, 0, true, rankOf("Late // Hot")]);
  assert.equal(rankOf("Late // Hot") > mpSales.RESTOCK_TOP_N, true, "qualifies on the flag alone");
  assert.deepEqual(Object.keys(out.names).sort(), ["Late // Hot", "Steady 003"]);
  assert.deepEqual(out.names["Late // Hot"], [6, 0, true, rankOf("Late // Hot"), "sid-hot"]);
  assert.deepEqual(out.names["Steady 003"], [7, 0, false, rankOf("Steady 003"), "sid-r003"]);
});

test("restockFor (#370): names ranked outside the cached top list get their detail on demand; too early, only the top list counts; no history, nothing", () => {
  freshEnv();
  const none = mpSales.restockFor([{ key: "a", sid: "sid-lb1", name: "Lightning Bolt" }], [{ key: "Lightning Bolt", name: "Lightning Bolt" }], { nowMs: NOW });
  assert.deepEqual([none.prints, none.names], [{}, {}]);
  assert.equal(none.sales.historySince, null);
  searchEnv();                     // one day of history: too early to compare paces
  const out = mpSales.restockFor([{ key: "a", sid: "sid-lb1", name: "Lightning Bolt" }, { key: "z", sid: "sid-zb1", name: "Zzyzx Bolt" }],
    [{ key: "Lightning Bolt", name: "Lightning Bolt" }, { key: "Zzyzx Bolt", name: "Zzyzx Bolt" }], { nowMs: NOW });
  assert.equal(out.sales.comparable, false);
  assert.deepEqual(out.prints, { a: [6, 1, null, 1] }, "rank 1; a minimum, the week isn't full yet");
  assert.deepEqual(out.names, { "Lightning Bolt": [8, 1, null, 1, "sid-lb1"] }, "rank 504 can't qualify while the flag can't be told");
});

test("soldByKey (#366): no history yet means no numbers at all; dataKey moves with a new ingest", () => {
  freshEnv();
  const none = mpSales.soldByKey([{ key: "tst|1", sid: "sid-0w1" }, { key: "tok|1", sid: null }], { nowMs: NOW });
  assert.deepEqual(none.sold, {});
  assert.deepEqual(none.unmatched, [], "nothing to explain while there's no history");
  assert.equal(none.sales.historySince, null);
  const before = mpSales.dataKey({ nowMs: NOW });
  assert.equal(mpSales.dataKey({ nowMs: NOW }), before, "steady between ingests");
  ingest("catalog", NOW, [single("sid-0w1", "New", [["w1", [sale(NOW - 2 * H, 100, 3)]]])]);
  assert.notEqual(mpSales.dataKey({ nowMs: NOW }), before);
  const out = mpSales.soldByKey([{ key: "tst|1", sid: "sid-0w1" }], { nowMs: NOW });
  assert.deepEqual(out.sold, { "tst|1": [3, 1, null] }, "a minimum while the week isn't full; too early to flag");
  assert.equal(out.sales.comparable, false);
});

test("#373: Sold 7d, SELLING FAST and the baseline give the same answers at any hour of the UTC day", () => {
  const day = Date.parse("2026-10-29T00:00:00Z");
  for (const at of [1000, 25 * 60000, 2 * H - 60000, 2 * H + 60000, 12 * H, 24 * H - 60000, 24 * H - 1000]) {
    const now = day + at, when = new Date(now).toISOString();
    const T1 = soldEnv(now);
    const rows = [{ sid: "sid-0q2" }, { sid: "sid-0q3" }, { sid: "sid-0zz" }, { sid: null }];
    const out = mpSales.attachSold(rows, r => r.sid, { nowMs: now });
    assert.deepEqual(out.rows.map(r => r.sold7d), [6, 0, 0, null], when);
    assert.deepEqual(out.rows.map(r => r.soldSales7), [6, 0, 0, null], when);
    assert.deepEqual(out.rows.map(r => r.soldBase), [0, 1, 0, null], when + ": the older sale is in the baseline");
    assert.deepEqual(out.rows.map(r => r.sellingFast), [true, false, false, null], when);
    assert.equal(out.sales.comparable, true, when);
    assert.equal(out.sales.window7Complete, true, when);
    // The windows end on the latest catalog's date. Just after 00:00 UTC
    // that's still yesterday's (taken 2 hours ago), so history - and with
    // it the baseline - is a day shorter until the next catalog arrives.
    const sameDay = mpSales.saleDay(T1) === mpSales.saleDay(now);
    assert.equal(out.sales.dataThrough, mpSales.saleDay(T1), when);
    assert.equal(out.sales.historyDays, sameDay ? 21 : 20, when);
    assert.equal(out.sales.baselineDays, sameDay ? 14 : 13, when);
    const sf = mpSales.sellingFast({ nowMs: now, limit: 10 });
    assert.equal(sf.cards.find(c => c.name === "Hot").copies7, 6, when + ": the Selling fast tab agrees");
    assert.equal(sf.cards.find(c => c.name === "Hot").hot, true, when);
    // Today's catalog (the same sales seen again) brings the full baseline back, at any hour.
    assert.equal(ingest("catalog", now, soldLatest(now), now).newSales, 0, when);
    const fresh = mpSales.attachSold(rows, r => r.sid, { nowMs: now });
    assert.equal(fresh.sales.dataThrough, mpSales.saleDay(now), when);
    assert.equal(fresh.sales.baselineDays, 14, when);
    assert.deepEqual(fresh.rows.map(r => [r.sold7d, r.soldBase, r.sellingFast]), [[6, 0, true], [0, 1, false], [0, 0, false], [null, null, null]], when);
  }
});

/* #354: what the audit against the real archive found. Manapool stamps each
   sale with its date only ("2026-10-22T00:00:00+00:00"). Fixed dates here,
   so every case behaves the same in any time zone and at any hour. */
const DAY0 = Date.parse("2026-10-28T21:08:30Z");            // a real catalog's Last-Modified
const dated = (day, price, quantity) => ({ created_at: day + "T00:00:00+00:00", price, quantity });

test("#354: a date-only sale lands on its own date, and the windows end on the latest catalog's date", () => {
  freshEnv();
  ingest("catalog", DAY0, [single("sid-1d1", "Dated", [["d1", [dated("2026-10-28", 50, 1), dated("2026-10-22", 50, 2), dated("2026-10-21", 50, 4)]]])], DAY0);
  const days = db().prepare("SELECT day, copies FROM mp_sale_days WHERE copies > 0 ORDER BY day").all().map(r => [r.day, r.copies]);
  assert.deepEqual(days, [["2026-10-21", 4], ["2026-10-22", 2], ["2026-10-28", 1]], "never the day before, whatever the server's zone");
  // Next morning, before the next catalog: still the 7 days to 10-28, not
  // a week ending on an empty "today".
  const sf = mpSales.sellingFast({ nowMs: DAY0 + 10 * H });
  assert.equal(sf.coverage.dataThrough, "2026-10-28");
  assert.equal(sf.coverage.windows.d7.start, "2026-10-22");
  assert.equal(sf.cards[0].copies7, 3, "10-22 and 10-28 are in the 7 days, 10-21 isn't");
  assert.equal(mpSales.soldFor(["sid-1d1"], { nowMs: DAY0 + 10 * H }).bySid.get("sid-1d1").copies7, 3, "Sold 7d uses the same window");
  // ...and never past today: an evening catalog read the same evening.
  assert.equal(mpSales.sellingFast({ nowMs: DAY0 + H }).coverage.dataThrough, "2026-10-28");
});

test("#354: identical sales on one date are a count, not one sale - and later snapshots add only the extra ones", () => {
  freshEnv();
  const two = [dated("2026-10-27", 25, 1), dated("2026-10-27", 25, 1)];
  let st = ingest("catalog", DAY0 - D, [single("sid-1m1", "Penny", [["m1", two]])], DAY0 - D);
  assert.equal(st.newSales, 2, "two real sales, same date, price and quantity");
  assert.deepEqual({ ...totals() }, { copies: 2, sales: 2 });
  // Next day: a third identical one, plus the two again.
  st = ingest("catalog", DAY0, [single("sid-1m1", "Penny", [["m1", [...two, dated("2026-10-27", 25, 1)]]])], DAY0);
  assert.equal(st.newSales, 1);
  // A snapshot showing fewer of them (older ones pushed out by the cap) adds nothing.
  st = ingest("catalog", DAY0, [single("sid-1m1", "Penny", [["m1", [dated("2026-10-27", 25, 1)]]])], DAY0);
  assert.equal(st.newSales, 0);
  assert.deepEqual({ ...totals() }, { copies: 3, sales: 3 });
  // The same sale with a time of day (a top-up, or Manapool changing format
  // again) is not new: a format change is what counted every sale twice on
  // 2026-10-17.
  st = ingest("topup", DAY0, [single("sid-1m1", "Penny", [["m1", [{ created_at: "2026-10-27T15:30:00.123Z", price: 25, quantity: 1 }]]])], DAY0);
  assert.equal(st.newSales, 0);
});

test("#354: an archive from before the fix keeps its identities, and its next snapshot counts the duplicates it missed", () => {
  freshEnv();
  // The old table: no n column, one row per hash.
  db().exec("CREATE TABLE mp_seen (h INTEGER PRIMARY KEY, day INTEGER NOT NULL)");
  const old = require("crypto").createHash("sha1").update("m2|" + Date.parse("2026-10-27T00:00:00Z") + "|25|1").digest().readBigInt64BE(0);
  db().prepare("INSERT INTO mp_seen (h, day) VALUES (?, ?)").run(old, 20261026);
  const st = ingest("catalog", DAY0, [single("sid-1m2", "Penny", [["m2", [dated("2026-10-27", 25, 1), dated("2026-10-27", 25, 1), dated("2026-10-27", 25, 1)]]])], DAY0);
  assert.equal(st.newSales, 2, "the one the old INSERT OR IGNORE counted, plus the two it dropped");
  assert.equal(db().prepare("SELECT n FROM mp_seen WHERE h = ?").get(old).n, 3);
});

test("#354: pace counts separate sales, so one bulk buy isn't SELLING FAST; the baseline is the days before the 7", () => {
  freshEnv();
  // 21 days of history; a sale a day of each card before this week.
  ingest("catalog", DAY0 - 20 * D, [single("sid-1s0", "Seed", [["s0", [dated("2026-10-08", 10, 1)]]])], DAY0 - 20 * D);
  const daily = (from, to, price) => { const out = []; for (let d = from; d <= to; d++) out.push(dated(prices.shiftDate("2026-10-28", -d), price, 1)); return out; };
  ingest("catalog", DAY0, [
    single("sid-1b1", "Bulk Lot", [["b1", [dated("2026-10-26", 15, 300), ...daily(7, 20, 15)]]]),
    // (Two versions, under Manapool's 20-sale cap each.)
    single("sid-1h1", "Real Spike", [["h1", [...daily(0, 6, 40), ...daily(0, 6, 41)]], ["h2", [...daily(0, 6, 42), ...daily(8, 19, 40)]]])
  ], DAY0);
  const sf = mpSales.sellingFast({ nowMs: DAY0 + H, limit: 5 });
  const bulk = sf.cards.find(c => c.name === "Bulk Lot"), spike = sf.cards.find(c => c.name === "Real Spike");
  assert.equal(bulk.copies7, 300, "Sold 7d still counts every copy");
  assert.equal(bulk.sales7, 1);
  assert.equal(bulk.hot, false, "one buyer, one sale: not a trend");
  assert.equal(bulk.paceRatio, 0.14, "1 sale this week vs a sale a day before");
  assert.equal(spike.sales7, 21);
  assert.equal(spike.paceRatio, 3.5, "3 sales a day vs 12 in the 14 days before");
  assert.equal(spike.capped30, false);
  assert.equal(spike.hot, true);
  assert.equal(spike.baselineDays, 14);
});

test("#354: the one-time repair moves sale counts to their real date and drops the doubled days before the recount", () => {
  freshEnv();
  mpSales.status();                                         // creates the tables (an empty archive just gets the marker)
  const meta = k => (db().prepare("SELECT v FROM mp_meta WHERE k = ?").get(k) || {}).v;
  assert.equal(meta("saleDays"), "utc");
  assert.equal(mpSales.repairHistory(db()), null, "already done");
  // An archive as production had it: history since 10-12, local days.
  db().exec("DELETE FROM mp_meta");
  db().prepare("INSERT INTO mp_meta (k, v) VALUES ('historySince', '2026-10-12'), ('lastAvailDay', '2026-10-20')").run();
  const pid = Number(db().prepare("INSERT INTO mp_printings (sid, name) VALUES ('sid-1r1', 'Repaired') RETURNING pid").get().pid);
  const add = db().prepare("INSERT INTO mp_sale_days (pid, day, copies, sales, capped, avail) VALUES (?, ?, ?, ?, ?, ?)");
  add.run(pid, "2026-10-14", 8, 8, 0, 30);                  // doubled: goes (its avail stays)
  add.run(pid, "2026-10-16", 6, 6, 0, null);                // doubled, and would land on 10-17: goes
  add.run(pid, "2026-10-17", 3, 2, 1, null);                // really 10-18
  add.run(pid, "2026-10-20", 5, 4, 0, 31);                  // really 10-21; 10-20's avail stays on 10-20
  add.run(pid, "2026-10-21", 1, 1, 0, null);                // really 10-22
  const r = mpSales.repairHistory(db(), 1);
  assert.deepEqual(r, { shiftDays: 1, cleanFrom: mpSales.RECOUNT_CLEAN_DAY, moved: 3, dropped: 2 });
  const rows = db().prepare("SELECT day, copies, sales, capped, avail FROM mp_sale_days WHERE pid = ? ORDER BY day").all(pid).map(x => ({ ...x }));
  assert.deepEqual(rows, [
    { day: "2026-10-14", copies: 0, sales: 0, capped: 0, avail: 30 },
    { day: "2026-10-18", copies: 3, sales: 2, capped: 1, avail: null },
    { day: "2026-10-20", copies: 0, sales: 0, capped: 0, avail: 31 },
    { day: "2026-10-21", copies: 5, sales: 4, capped: 0, avail: null },
    { day: "2026-10-22", copies: 1, sales: 1, capped: 0, avail: null }
  ]);
  assert.equal(meta("historySince"), "2026-10-18");
  assert.equal(mpSales.repairHistory(db(), 1), null, "runs once");
});

test("#354: a repair that has to wait for another transaction runs on the next call, and nothing is recorded before it", () => {
  freshEnv();
  db().exec("BEGIN");                                       // e.g. an admin MTGJSON backfill holding a transaction
  mpSales.status();
  assert.equal(db().prepare("SELECT v FROM mp_meta WHERE k = 'saleDays'").get(), undefined, "skipped, not inside someone else's transaction");
  assert.throws(() => mpSales.beginRun("catalog", DAY0, { nowMs: DAY0 }), /repair/, "no ingest onto unrepaired history");
  db().exec("COMMIT");
  mpSales.status();
  assert.equal(db().prepare("SELECT v FROM mp_meta WHERE k = 'saleDays'").get().v, "utc", "retried on the next call");
  assert.equal(ingest("catalog", DAY0, [single("sid-1t1", "After", [["t1", [dated("2026-10-28", 50, 1)]]])], DAY0).newSales, 1);
});

test("#354: on a server at or east of UTC the repair moves nothing, but still drops the doubled days", () => {
  freshEnv();
  mpSales.status();
  db().exec("DELETE FROM mp_meta");
  db().prepare("INSERT INTO mp_meta (k, v) VALUES ('historySince', '2026-10-12')").run();
  const pid = Number(db().prepare("INSERT INTO mp_printings (sid, name) VALUES ('sid-1r2', 'East') RETURNING pid").get().pid);
  db().prepare("INSERT INTO mp_sale_days (pid, day, copies, sales, capped, avail) VALUES (?, '2026-10-17', 2, 2, 0, NULL), (?, '2026-10-19', 1, 1, 0, NULL)").run(pid, pid);
  assert.deepEqual(mpSales.repairHistory(db(), 0), { shiftDays: 0, cleanFrom: "2026-10-18", moved: 0, dropped: 1 });
  assert.deepEqual(db().prepare("SELECT day, copies FROM mp_sale_days WHERE pid = ?").all(pid).map(x => [x.day, x.copies]), [["2026-10-19", 1]]);
});
