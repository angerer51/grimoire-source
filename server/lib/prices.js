"use strict";
/* Price and EDHRec-rank history, and movers.
   ------------------------
   Sourced from MTGJSON (server/lib/mtgjson.js) - see that file's own header
   for why, and BACKLOG.md/PRICING.md for the decision trail. Every printing
   in the loaded card index gets a row per vendor MTGJSON tracks for paper
   Magic (mtgjson.VENDOR_CODES), not just what someone owns, so history
   survives a card being sold and movers can surface cards nobody holds yet -
   except tokens/double-faced tokens/emblems (EXCLUDED_LAYOUTS), which never
   enter the archive at all: they aren't cards anyone collects or trades the
   way a normal printing is, so a "price" for one (when vendor data exists at
   all) isn't a real signal, just a Movers-page data bug waiting to happen.
   EDHRec rank rides along in the same row (read from the in-memory
   Scryfall-backed card index - MTGJSON doesn't carry it).

   This archive is deliberately independent of cards.priceSource/
   applyPriceSource() (server/lib/cards.js): the LIVE "current price" shown
   everywhere else in the app (Listings, the bulk-price rule engine's default
   basis, Inventory/Dashboard value, the Manage dialog) stays whatever
   cards.priceSource says - completely unrelated to this file, which is
   purely the historical/trend record Movers, the price-history chart, and
   Portfolio read.

   Storage: one SQLite database, `prices/prices.db`, via node:sqlite (built
   into Node itself; usable without a flag since 22.13 - no npm dependency, no native compiler
   toolchain, unlike better-sqlite3/sqlite3; see store.js's header for why
   this project otherwise avoids SQLite). Replaces what used to be up to 400
   `prices/day/*.json` files plus 64 `prices/series/NN.json` shards (each up
   to ~20MB), read by parsing the whole file and kept warm via a hand-rolled
   bounded LRU cache. That design needed three separate incident-driven fixes
   (an unbounded shard cache OOM'd; a bulk-write path OOM'd differently; the
   catalog sweep OOM'd a third way) before it became merely slow - see
   BACKLOG.md #26's incident log for the full history. Three tables:

     snapshots(date PK, count, mtgjson_as_of, built_at)
       - which dates exist at all, and how many printings they cover.
     price_days(key, date, rank, <vendor>_<u|f|e> per vendor...)
       PRIMARY KEY (key, date), WITHOUT ROWID
       - one row per printing per day. WITHOUT ROWID clusters physically by
         key then date, so "this printing's whole history" (the chart, an
         owned row's moving averages) is one contiguous indexed range scan -
         no shard concept, no cache to keep warm, needed at all.
     movers_cache(date, vendor, window_days PK, computed_at, data)
       - the whole-catalog "what moved" sweep result (JSON), persisted so a
         server restart mid-day doesn't force the next visitor to re-pay a
         full sweep. Only ever holds today's combos - see snapshot()'s
         pruning and unownedMovedSweep()'s own in-memory Map above it.
     cross_cache(date, vendor PK, computed_at, data)
       - the catalog's golden crosses (#352), the same idea for Worth a look
         today's Golden cross list; see goldenCrossSweep().
   idx_price_days_date lets the whole-catalog sweep (what moved, across
   every printing - identical for every user on a given day/vendor/window,
   so it's computed once, persisted, and cached the same way the old code
   cached it, just durably) pull one day's data as a single indexed scan
   instead of a 64-shard walk. cache_size/mmap_size are set generously at
   open (openDb()) so hot pages stay resident in SQLite's own buffer cache
   across requests; checkpointAndOptimize() runs after big write batches
   (the daily snapshot, backfill, migration) to keep the WAL file bounded
   and the query planner's statistics current - never on the per-request
   read path.

   `key` is the existing printKey string (cards.printKey: "set|collector|
   lang") - the same value already used on the wire (movers rows, chart URL
   query params), so keeping it as the real key avoids adding an id-
   assignment layer for no reachable benefit at this row count (tens of
   millions of rows is unremarkable for SQLite). */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");
const store = require("./store");
const cards = require("./cards");
const mtgjson = require("./mtgjson");
// The Movers picks' rules, shared with the page (#352: the Golden cross
// pick's steady-climber test chooses which candidates the server sends).
const moversPicks = require("../../public/js/moversPicks.js");

const VENDOR_CODES = mtgjson.VENDOR_CODES;   // e.g. ["tcg","ck","cm","cs","mp"] - whatever MTGJSON currently tracks
const DEFAULT_VENDOR = "tcg";
// The unowned catalog sweep (unownedMovedSweep) only keeps a candidate whose
// price on BOTH ends is at or above this floor - matches movers.page.js's
// own HL_MIN_PRICE and the Movers toolbar's default Min Price of 1, so this
// changes nothing about what the page shows by default. It exists because
// the sweep was shipping ~98k rows (a 50MB+ response) for a 7-day/tcg
// window, two-thirds of which were sub-$1 bulk cards the client already
// discarded after downloading them - see BACKLOG.md's 2026-09-03 "enormous
// response" incident for the same class of problem at smaller catalog
// scale. Applied here (server-side, before the result is cached) instead of
// only client-side, so the noise is never computed, cached, or sent at all.
const MIN_SWEEP_PRICE = 1;
// Tokens/emblems aren't cards someone collects or trades the way a normal
// printing is - MTGJSON/vendor data for them (when it exists at all) doesn't
// mean the same thing a real card's price does, and showing one on Movers
// reads as a data bug, not a real signal. Excluded from the archive entirely
// (not just hidden client-side) so they never occupy a row or get swept.
const EXCLUDED_LAYOUTS = new Set(["token", "double_faced_token", "emblem"]);
let cfg = { prices: {} };
let logger = m => console.log("[prices] " + m);

function finLetter(finish) { return finish === "etched" ? "e" : finish === "foil" ? "f" : "u"; }
function colName(vendor, finish) { return vendor + "_" + finLetter(finish); }

// Column list built from VENDOR_CODES rather than hardcoded, so an upstream
// MTGJSON vendor addition/removal doesn't need a schema edit here too.
const PRICE_COLS = [];
for (const v of VENDOR_CODES) for (const letter of ["u", "f", "e"]) PRICE_COLS.push(v + "_" + letter);

let db = null;
const stmt = {};
const vendorStmtCache = new Map(); // vendor -> {pair, range, sweepNow, sweepThen}; at most VENDOR_CODES.length entries
const colStmtCache = new Map();    // price column -> last-60 statement, "cross|column" -> crossColStmt; at most 2 x PRICE_COLS.length entries

function dbFile() { return store.p("prices", "prices.db"); }

function openDb() {
  db = new DatabaseSync(dbFile());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Keep hot pages (recent dates, popular printings) resident in SQLite's own
  // buffer cache across requests instead of falling back to the (small)
  // default. 64MB page cache + a 256MB memory-mapped window - generous for a
  // single-process server, nowhere near what the old per-process JSON shard
  // cache risked holding.
  db.exec("PRAGMA cache_size = -65536");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
    date TEXT PRIMARY KEY,
    count INTEGER,
    mtgjson_as_of TEXT,
    built_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS price_days (
    key TEXT NOT NULL,
    date TEXT NOT NULL,
    rank INTEGER,
    ${PRICE_COLS.map(c => c + " REAL").join(", ")},
    PRIMARY KEY (key, date)
  ) WITHOUT ROWID`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_price_days_date ON price_days(date)");
  // The whole-catalog "what moved" sweep is identical for every user on a
  // given (date, vendor, window) - persisted here (not just the in-memory
  // unownedSweepCache below) so a server restart mid-day doesn't force the
  // next visitor to re-pay the full sweep cost. Only ever holds TODAY's
  // combos (pruned to date=today whenever a new snapshot lands - see
  // snapshot() below) since a sweep result is only ever useful anchored at
  // the latest snapshot date; there's no reason to keep yesterday's.
  db.exec(`CREATE TABLE IF NOT EXISTS movers_cache (
    date TEXT NOT NULL,
    vendor TEXT NOT NULL,
    window_days INTEGER NOT NULL,
    computed_at TEXT,
    data TEXT,
    PRIMARY KEY (date, vendor, window_days)
  )`);
  // #110: the "then" date a persisted sweep was computed against. Added as a
  // plain column (not folded into `data`) so an older build reading this
  // table still finds the rows array it expects in `data`. A row written
  // before this column existed has then_date NULL and never matches, so it
  // is recomputed once rather than trusted.
  if (!db.prepare("PRAGMA table_info(movers_cache)").all().some(c => c.name === "then_date")) {
    db.exec("ALTER TABLE movers_cache ADD COLUMN then_date TEXT");
  }
  // #352: the catalog's golden crosses (30-day line crossing above the
  // 60-day one) over the last CROSS_MAX_DAYS snapshot days, per vendor -
  // like movers_cache, identical for every user, so computed once per
  // snapshot date and persisted to survive a restart. Pruned alongside
  // movers_cache (only the latest date is ever read).
  db.exec(`CREATE TABLE IF NOT EXISTS cross_cache (
    date TEXT NOT NULL,
    vendor TEXT NOT NULL,
    computed_at TEXT,
    data TEXT,
    PRIMARY KEY (date, vendor)
  )`);

  stmt.upsertDay = db.prepare(`
    INSERT INTO price_days (key, date, rank, ${PRICE_COLS.join(", ")})
    VALUES (?, ?, ?, ${PRICE_COLS.map(() => "?").join(", ")})
    ON CONFLICT(key, date) DO UPDATE SET
      rank = excluded.rank,
      ${PRICE_COLS.map(c => c + " = excluded." + c).join(", ")}
  `);
  stmt.upsertSnapshot = db.prepare(`
    INSERT INTO snapshots (date, count, mtgjson_as_of, built_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET count = excluded.count, mtgjson_as_of = excluded.mtgjson_as_of, built_at = excluded.built_at
  `);
  stmt.snapshotByDate = db.prepare("SELECT date FROM snapshots WHERE date = ?");
  stmt.latestSnapshot = db.prepare("SELECT date FROM snapshots ORDER BY date DESC LIMIT 1");
  stmt.allSnapshotDates = db.prepare("SELECT date FROM snapshots ORDER BY date ASC");
  stmt.closestBefore = db.prepare(
    "SELECT date FROM snapshots WHERE date < ? ORDER BY ABS(julianday(date) - julianday(?)) ASC LIMIT 1"
  );
  stmt.pairAt = db.prepare(`SELECT rank, ${PRICE_COLS.join(", ")} FROM price_days WHERE key = ? AND date = ?`);
  stmt.seriesRange = db.prepare(`SELECT date, rank, ${PRICE_COLS.join(", ")} FROM price_days WHERE key = ? ORDER BY date ASC`);
  stmt.rowsForDate = db.prepare(`SELECT key, rank, ${PRICE_COLS.join(", ")} FROM price_days WHERE date = ?`);
  stmt.oldestRankAtOrBefore = db.prepare(
    "SELECT rank FROM price_days WHERE key = ? AND date <= ? AND rank IS NOT NULL ORDER BY date ASC LIMIT 1"
  );
  stmt.countForDate = db.prepare("SELECT COUNT(*) AS n FROM price_days WHERE date = ?");
  stmt.deleteOldPriceDays = db.prepare("DELETE FROM price_days WHERE date < ?");
  stmt.deleteOldSnapshots = db.prepare("DELETE FROM snapshots WHERE date < ?");
  stmt.deleteAllPriceDays = db.prepare("DELETE FROM price_days");
  stmt.deleteAllSnapshots = db.prepare("DELETE FROM snapshots");
  stmt.getMoversCache = db.prepare("SELECT data, then_date FROM movers_cache WHERE date = ? AND vendor = ? AND window_days = ?");
  stmt.setMoversCache = db.prepare(`
    INSERT INTO movers_cache (date, vendor, window_days, computed_at, data, then_date) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, vendor, window_days) DO UPDATE SET computed_at = excluded.computed_at, data = excluded.data, then_date = excluded.then_date
  `);
  stmt.oldestSnapshot = db.prepare("SELECT date FROM snapshots ORDER BY date ASC LIMIT 1");
  // Narrow, per-vendor and per-column statements (#113, #54), prepared on
  // first use - see vendorStmts()/colStmts() below.
  vendorStmtCache.clear();
  colStmtCache.clear();
  stmt.deleteStaleMoversCache = db.prepare("DELETE FROM movers_cache WHERE date < ?");
  stmt.deleteMoversCacheForDate = db.prepare("DELETE FROM movers_cache WHERE date = ?");
  stmt.deleteAllMoversCache = db.prepare("DELETE FROM movers_cache");
  stmt.getCrossCache = db.prepare("SELECT data FROM cross_cache WHERE date = ? AND vendor = ?");
  stmt.setCrossCache = db.prepare(`
    INSERT INTO cross_cache (date, vendor, computed_at, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(date, vendor) DO UPDATE SET computed_at = excluded.computed_at, data = excluded.data
  `);
  stmt.deleteStaleCrossCache = db.prepare("DELETE FROM cross_cache WHERE date < ?");
  stmt.deleteCrossCacheForDate = db.prepare("DELETE FROM cross_cache WHERE date = ?");
  stmt.deleteAllCrossCache = db.prepare("DELETE FROM cross_cache");
  stmt.deletePriceDaysForKey = db.prepare("DELETE FROM price_days WHERE key = ?");
  // One per vendor (5, not per vendor+finish) - "does this vendor price this
  // printing at all, in any finish" for the movers page's vendorCoverage stat.
  stmt.vendorCoverage = {};
  for (const v of VENDOR_CODES) {
    stmt.vendorCoverage[v] = db.prepare(
      `SELECT COUNT(*) AS n FROM price_days WHERE date = ? AND (${colName(v, "nonfoil")} IS NOT NULL OR ${colName(v, "foil")} IS NOT NULL OR ${colName(v, "etched")} IS NOT NULL)`
    );
  }
}

// Run after any big write batch (daily snapshot, backfill, migration) - not
// on every request. wal_checkpoint(TRUNCATE) keeps the WAL file from growing
// unbounded between writes; PRAGMA optimize refreshes the query planner's
// statistics so it keeps making good choices as the table grows well past
// whatever it looked like at launch. Both are cheap, best-effort - a failure
// here (e.g. a checkpoint that can't fully truncate because a read is mid-
// flight) shouldn't fail the write that triggered it.
function checkpointAndOptimize() {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}
  try { db.exec("PRAGMA optimize"); } catch (e) {}
}

function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (e2) {}
    throw e;
  }
}

/* The 30/60-day price trend lines (#266). Each is the MEDIAN of the last
   30 / 60 days that actually have a price (gaps skipped), so one bad day -
   a single $30 print on a $2 card - can't drag it. A window whose priced
   days reach back further than MA_SPAN calendar days (counted from the
   as-of date) is too sparse to call a 30- or 60-day trend, so it's null and
   the page shows a dash. maFor() (the Movers table) and slidingMedian() (the
   chart lines) share these rules so the numbers and the lines agree. */
const MA_SPAN = { 30: 40, 60: 75 };
const DAY_MS = 86400000;
function dayNum(date) { return Math.round(Date.parse(date + "T00:00:00Z") / DAY_MS); }
function medianOf(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
/* Percent gap between the two trend lines: (ma30 - ma60) / ma60 x 100.
   Comparable across a $2 card and a $2,000 one, unlike the dollar gap. */
function maPctOf(ma30, ma60) {
  return (ma30 != null && ma60 != null && ma60 > 0) ? (ma30 - ma60) / ma60 * 100 : null;
}

/* Trailing median trend line at every index of a daily series (`dates`
   parallel to `values`), skipping nulls rather than letting them shrink the
   window. Null until `window` real prices exist, and null wherever those
   prices reach back more than MA_SPAN[window] days. Used by history(). */
function slidingMedian(values, dates, window) {
  const maxSpan = MA_SPAN[window];
  const out = new Array(values.length).fill(null);
  const buf = [];   // { v, d } oldest first, at most `window`
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null) {
      buf.push({ v, d: dayNum(dates[i]) });
      if (buf.length > window) buf.shift();
    }
    if (buf.length < window) continue;
    if (maxSpan != null && dayNum(dates[i]) - buf[0].d > maxSpan) continue;
    out[i] = medianOf(buf.map(b => b.v));
  }
  return out;
}

function today() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0");
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0");
}

function vendorOf(opts) {
  const v = opts && opts.vendor;
  return VENDOR_CODES.includes(v) ? v : DEFAULT_VENDOR;
}

function finishesFor(card) {
  const out = ["nonfoil", "foil"];
  if (Array.isArray(card.finishes) && card.finishes.includes("etched")) out.push("etched");
  return out;
}

/* ---------- Reads against price_days/snapshots ---------- */

function latestDateStr() {
  const row = stmt.latestSnapshot.get();
  return row ? row.date : null;
}
function oldestDateStr() {
  const row = stmt.oldestSnapshot.get();
  return row ? row.date : null;
}
async function latest() {
  const date = latestDateStr();
  return date ? { date } : null;
}
async function snapshotNear(target, beforeDate) {
  const row = stmt.closestBefore.get(beforeDate, target);
  return row ? { date: row.date } : null;
}
async function availableDates() {
  return stmt.allSnapshotDates.all().map(r => r.date);
}

/* Calendar arithmetic on the archive's own YYYY-MM-DD strings. #110: every
   window (Movers, Portfolio, the Buy List watch window) is counted back from
   the LATEST SNAPSHOT date, not from today's wall clock. Until the day's
   snapshot lands (it waits for MTGJSON's ~9am Eastern file) the latest
   snapshot is still yesterday, and counting from the wall clock then picked
   a "then" date one day later than the cached catalog sweep had used, so
   owned rows, unowned rows and the label disagreed. */
function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}
/* The snapshot a `back`-day window ending at `nowDate` compares against:
   the one nearest `nowDate - back`, strictly before `nowDate`. */
function thenDateFor(nowDate, back) {
  const row = stmt.closestBefore.get(nowDate, shiftDate(nowDate, -back));
  return row ? row.date : null;
}

/* #113 / #54: node:sqlite is synchronous, so a long per-key loop blocks every
   other request until it finishes. Loops over owned printings or the catalog
   check due() each key and, every YIELD_SLICE_MS of work, give the event loop
   a turn (setImmediate lets pending I/O, e.g. a concurrent /api/meta, run
   first). Checking the clock is cheap; awaiting on every key is not. */
const YIELD_SLICE_MS = 15;
function slicer() {
  let since = performance.now();
  return {
    due() { return performance.now() - since >= YIELD_SLICE_MS; },
    async pause() {
      await new Promise(resolve => setImmediate(resolve));
      since = performance.now();
    }
  };
}

/* Statements that read only the selected vendor's three finish columns
   instead of all 15 vendor columns. Materialising a JS object per row is
   most of the cost of a read here, so narrower rows are proportionally
   cheaper. `vendor` is always one of VENDOR_CODES (vendorOf()), never raw
   user input, so building it into the SQL is safe. */
function vendorStmts(vendor) {
  let s = vendorStmtCache.get(vendor);
  if (s) return s;
  const cols = ["nonfoil", "foil", "etched"].map(f => colName(vendor, f)).join(", ");
  s = {
    pair: db.prepare(`SELECT rank, ${cols} FROM price_days WHERE key = ? AND date = ?`),
    range: db.prepare(`SELECT date, ${cols} FROM price_days WHERE key = ? AND date >= ? AND date <= ? ORDER BY date ASC`),
    // The catalog sweep walks one date in key order, a chunk at a time
    // (keyset pagination on the (date, key) index), so it can yield between
    // chunks and never holds the whole ~100k-row day in memory at once.
    sweepNow: db.prepare(`SELECT key, rank, ${cols} FROM price_days INDEXED BY idx_price_days_date WHERE date = ? AND key > ? ORDER BY key LIMIT ?`),
    sweepThen: db.prepare(`SELECT key, rank, ${cols} FROM price_days INDEXED BY idx_price_days_date WHERE date = ? AND key > ? AND key <= ?`)
  };
  vendorStmtCache.set(vendor, s);
  return s;
}
/* The newest (up to) 60 real prices in one column at or before a date - all
   a 30/60-day moving average needs. The (key, date) primary key serves it as
   one short backwards range scan that stops at 60 rows. Measured ~20us per
   read against ~460us for the old whole-history read filtered in JS. */
function colStmt(col) {
  let s = colStmtCache.get(col);
  if (!s) {
    s = db.prepare(`SELECT ${col} AS v, date FROM price_days WHERE key = ? AND date <= ? AND ${col} IS NOT NULL ORDER BY date DESC LIMIT 60`);
    colStmtCache.set(col, s);
  }
  return s;
}
/* The golden-cross scan's read (#352): the same backwards range scan, but
   the newest CROSS_READ prices, each with its date as a day number (dayNum())
   computed by SQLite. ~100k printings x up to 91 rows: a number per row
   instead of a date string keeps both the time and the garbage down. */
function crossColStmt(col) {
  const cacheKey = "cross|" + col;
  let s = colStmtCache.get(cacheKey);
  if (!s) {
    s = db.prepare(`SELECT ${col} AS v, CAST(julianday(date) - 2440587.5 AS INTEGER) AS d FROM price_days
      WHERE key = ? AND date <= ? AND ${col} IS NOT NULL ORDER BY date DESC LIMIT ${CROSS_READ}`);
    colStmtCache.set(cacheKey, s);
  }
  return s;
}

function readPair(key, date) {
  if (!date) return null;
  return stmt.pairAt.get(key, date) || null;
}
function priceAt(pair, vendor, finish) {
  if (!pair) return null;
  const v = pair[colName(vendor, finish)];
  return v == null ? null : v;
}

/* One printing's whole recorded history, every column - used by history()
   (the price chart), which really does show all of it. Bounded by however
   many days this archive keeps (keepDays, default 400). The Movers,
   Portfolio and watch-list paths read narrower slices instead (#113). */
function wholeSeries(key) {
  return stmt.seriesRange.all(key);
}

/* The median of the newest `n` of `vals` (newest first, each { v, date }),
   or null if there are fewer than n or they reach back more than MA_SPAN[n]
   days before `atDate` (#266). */
function windowMedian(vals, n, atDate) {
  if (vals.length < n) return null;
  if (dayNum(atDate) - dayNum(vals[n - 1].date) > MA_SPAN[n]) return null;
  return medianOf(vals.slice(0, n).map(r => r.v));
}

/* 30/60-day trend values as of `atDate`, for one printing/vendor/finish:
   the median of the last 30 / 60 days that actually have a price (gaps
   skipped), null until that many exist or when they're too spread out (see
   MA_SPAN). Still one <=60-row indexed read (#54/#113): the median and span
   come from the same rows. Called for an owned row and for every unowned
   catalog-sweep candidate that survived the meaningful-move filter. */
function maFor(key, vendor, finish, atDate) {
  const vals = colStmt(colName(vendor, finish)).all(key, atDate);
  return { ma30: windowMedian(vals, 30, atDate), ma60: windowMedian(vals, 60, atDate) };
}

/* EDHRec rank's "then" value, snapping forward to the OLDEST rank reading a
   printing actually has when the requested window reaches further back than
   real rank data goes - only ever looks at or before `nowDate`. Cheap,
   dedicated indexed lookup (not wholeSeries) since the unowned sweep calls
   this for every candidate whose exact "then" row has no rank of its own. */
function rankThenFor(key, thenPair, nowDate) {
  if (thenPair && thenPair.rank != null) return thenPair.rank;
  const row = stmt.oldestRankAtOrBefore.get(key, nowDate);
  return row ? row.rank : null;
}

/* A MEANINGFUL move, not literally any nonzero cent - real 5-vendor daily
   price data essentially never sits perfectly flat, so a looser bar let
   nearly every candidate through (see BACKLOG.md's 2026-09-03 incident log
   for the enormous-response problem that caused). The unowned sweep always
   requires it; an owned row is held to it only when "Only held" is off, so
   two accounts with "Only held" off see the same catalog-wide rows (see
   BACKLOG.md's 2026-09-20 note on two accounts' CSV exports disagreeing). */
function isMeaningful(row) {
  return (row.pct != null && Math.abs(row.pct) >= 1) ||
    (row.rankDelta != null && Math.abs(row.rankDelta) >= 25);
}

/* Core per-printing/finish computation shared by an owned row and an unowned
   catalog-sweep candidate. `nowPair`/`thenPair` are the printing's rows on
   the two dates (already read by the caller, once per printing however many
   finishes or conditions it has); `rankThenOf()` supplies the "then" rank,
   looked up only if it's actually needed. `requireMove` (the sweep) drops a
   row without a real price on both ends, under MIN_SWEEP_PRICE, or without a
   meaningful move. Moving averages start null; the caller fills them in with
   setMA() only for rows it keeps. Returns null if there's nothing to show. */
function moveCore(key, finish, vendor, nowPair, thenPair, rankThenOf, requireMove) {
  const nowPrice = priceAt(nowPair, vendor, finish);
  const thenPrice = priceAt(thenPair, vendor, finish);
  // A discovery-sweep row needs a REAL price on both ends from the selected
  // vendor - the whole point of the "rank leads price" signal is "price
  // hasn't caught up to rising popularity YET"; there's no price to catch up
  // if there's no price at all.
  if (requireMove && (nowPrice == null || thenPrice == null)) return null;
  if (requireMove && (nowPrice < MIN_SWEEP_PRICE || thenPrice < MIN_SWEEP_PRICE)) return null;
  const rankNow = nowPair && nowPair.rank != null ? nowPair.rank : null;
  const rankThen = rankThenOf();
  const rankDelta = (rankNow == null || rankThen == null) ? null : rankNow - rankThen;
  if (nowPrice == null && thenPrice == null && rankNow == null && rankThen == null) return null;
  const delta = (nowPrice == null || thenPrice == null) ? null : nowPrice - thenPrice;
  const pct = (delta == null || !thenPrice) ? null : (delta / thenPrice) * 100;
  const row = {
    key, finish, then: thenPrice, now: nowPrice, delta, pct,
    rankNow, rankThen, rankDelta, ma30: null, ma60: null, maDiff: null, maPct: null
  };
  if (requireMove && !isMeaningful(row)) return null;
  return row;
}
function setMA(row, ma) {
  row.ma30 = ma.ma30;
  row.ma60 = ma.ma60;
  row.maDiff = (ma.ma30 != null && ma.ma60 != null) ? ma.ma30 - ma.ma60 : null;
  row.maPct = maPctOf(ma.ma30, ma.ma60);
}

/* Small bounded LRU helpers for the per-account caches below. */
function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}
function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/* The unowned-catalog sweep - what "moved" across every printing, for
   whoever's asking - is identical for every user on a given vendor/window/
   day (it never looks at anyone's collection), so it's computed once and
   cached rather than redone on every single Movers page load. Keyed by
   (nowDate, back, vendor, thenDate): #110 added thenDate, so a cached sweep
   can never be served for a different start date than the response
   reports. A new day's snapshot naturally invalidates every previous key,
   and old ones are dropped so a long-running process doesn't accumulate one
   entry per day forever (at most one entry per vendor x window for the
   latest date).

   #54: the sweep is async. It walks the latest date's rows a chunk at a
   time and yields every YIELD_SLICE_MS, so a cold sweep (~100k priced
   printings, moving averages for every survivor) no longer freezes every
   other request for the ~11s it used to. Two requests for the same cold
   combo share one computation (sweepInflight). If the archive is wiped or
   re-snapshotted while a sweep is running (sweepGeneration moves), that
   result is returned to its callers but never cached or persisted. */
const SWEEP_CHUNK = 2000;
/* vendorCoverage (below) counts a whole day's rows: ~400ms of blocking on a
   100k-printing day, on every Movers load. It only changes when a snapshot
   is written, so it's cached per (date, vendor): at most one entry per
   vendor, older dates dropped, cleared with the sweep cache. */
const coverageCache = new Map(); // "date|vendor" -> count
function vendorCoverageFor(date, vendor) {
  const key = date + "|" + vendor;
  if (coverageCache.has(key)) return coverageCache.get(key);
  for (const k of coverageCache.keys()) if (!k.startsWith(date + "|")) coverageCache.delete(k);
  const n = stmt.vendorCoverage[vendor].get(date).n;
  coverageCache.set(key, n);
  return n;
}
const unownedSweepCache = new Map(); // "nowDate|back|vendor|thenDate" -> row[]
const sweepInflight = new Map();     // same key -> Promise<row[]>
let sweepGeneration = 0;
/* Called whenever the archive's existing data changes under a date that may
   already be cached: a forced re-snapshot of today, a purge, the MTGJSON
   backfill wipe, a (re)open. Every result cache keyed on a snapshot date
   goes, not just the sweep - the per-account ticker and Portfolio caches
   (below) are keyed on the date too, so without this a forced re-snapshot or
   a backfill left them serving the old numbers for the rest of the day. The
   generation bump stops a computation that was already running when the
   data changed from caching what it read. */
function clearSweepCache() {
  unownedSweepCache.clear();
  coverageCache.clear();
  sweepInflight.clear();
  topCache.clear();
  portfolioCache.clear();
  crossCache.clear();
  crossInflight.clear();
  sweepGeneration++;
}

function unownedMovedSweep(vendor, back, nowDate, thenDate) {
  const cacheKey = [nowDate, back, vendor, thenDate || ""].join("|");
  const hit = unownedSweepCache.get(cacheKey);
  if (hit) return Promise.resolve(hit);
  const running = sweepInflight.get(cacheKey);
  if (running) return running;
  const p = computeSweep(vendor, back, nowDate, thenDate, cacheKey).finally(() => {
    if (sweepInflight.get(cacheKey) === p) sweepInflight.delete(cacheKey);
  });
  sweepInflight.set(cacheKey, p);
  return p;
}

async function computeSweep(vendor, back, nowDate, thenDate, cacheKey) {
  for (const k of unownedSweepCache.keys()) if (!k.startsWith(nowDate + "|")) unownedSweepCache.delete(k);

  // Check the persisted cache before recomputing - survives a restart mid-
  // day, which the in-memory Map above does not. Only ever populated for
  // today's date (see snapshot()'s pruning below), and only trusted when it
  // was computed against the same "then" date (#110).
  const persisted = stmt.getMoversCache.get(nowDate, vendor, back);
  if (persisted && persisted.then_date === (thenDate || "")) {
    const out = JSON.parse(persisted.data);
    unownedSweepCache.set(cacheKey, out);
    return out;
  }

  const gen = sweepGeneration;
  const vs = vendorStmts(vendor);
  const slice = slicer();
  const out = [];
  let after = "";
  for (;;) {
    const nowRows = vs.sweepNow.all(nowDate, after, SWEEP_CHUNK);
    if (!nowRows.length) break;
    const last = nowRows[nowRows.length - 1].key;
    const thenByKey = new Map();
    if (thenDate) for (const r of vs.sweepThen.all(thenDate, after, last)) thenByKey.set(r.key, r);
    after = last;
    for (const nowPair of nowRows) {
      const key = nowPair.key;
      const parts = key.split("|");
      const card = cards.cardByKey(parts[0], parts[1], parts[2]);
      if (!card) continue;
      const thenPair = thenByKey.get(key) || null;
      // Looked up at most once per printing, and only for a finish that has
      // already passed the price checks (most candidates never get there).
      let rankThen, rankKnown = false;
      const rankThenOf = () => {
        if (!rankKnown) { rankThen = rankThenFor(key, thenPair, nowDate); rankKnown = true; }
        return rankThen;
      };
      for (const finish of finishesFor(card)) {
        const r = moveCore(key, finish, vendor, nowPair, thenPair, rankThenOf, true);
        if (!r) continue;
        setMA(r, maFor(key, vendor, finish, nowDate));
        out.push(Object.assign(r, {
          name: card.name, set: card.set, setName: card.setName, collector: card.collector, lang: card.lang,
          rarity: card.rarity || "", imageUrl: card.imageUrl || "",
          oracleId: card.oracleId || null, totalPrintings: cards.oracleFinishTotal(card.oracleId) || 1,
          qty: 0, listed: null, avgCost: null, costQty: 0, valueDelta: null
        }));
      }
      if (slice.due()) await slice.pause();
    }
    if (nowRows.length < SWEEP_CHUNK) break;
  }
  if (gen !== sweepGeneration) return out;
  unownedSweepCache.set(cacheKey, out);
  stmt.setMoversCache.run(nowDate, vendor, back, new Date().toISOString(), JSON.stringify(out), thenDate || "");
  return out;
}

/* ---------- Golden crosses (#352) ----------
   A golden cross is the day a printing's 30-day trend line moves from at or
   below its 60-day line to above it. The lines are exactly maFor()'s: the
   median of the last 30 / 60 priced days, with the MA_SPAN gap guard, so a
   cross always agrees with the MA30/MA60 columns and one bad reading can't
   fake one.

   Like the unowned "what moved" sweep, the answer is the same for every
   user, so it is computed once per (latest snapshot date, vendor) for the
   widest window anyone can ask for (CROSS_MAX_DAYS snapshot days), cached in
   memory and persisted in cross_cache; a request then only filters that
   list by its own N and marks the caller's owned copies.

   Cost at real scale (~100k priced printings a day): the latest day is
   walked a chunk at a time, and only a finish priced at MIN_SWEEP_PRICE or
   more today goes on to read its newest CROSS_READ prices (one short
   indexed range scan, the same shape maFor() uses). Today's lines are
   checked first; only a printing whose 30-day line is above its 60-day line
   today is scanned back for the cross, and that scan stops at the first
   day it wasn't above. The loop yields every YIELD_SLICE_MS (#54, #113). */
const CROSS_MAX_DAYS = 30;
const CROSS_DEFAULT_DAYS = 7;
// Up to CROSS_MAX_DAYS priced days in the window, the day before the
// earliest of them, and that day's 60-day line: 60 + 30 + 1.
const CROSS_READ = 60 + CROSS_MAX_DAYS + 1;
// The response carries at most this many rows (strongest MA30-60 % first);
// `total` says how many matched.
const CROSS_MAX_ROWS = 1000;
const CROSS_BEST = 10;
// Shape of a cached/persisted list; bump when a row gains a field, so an
// older persisted list is recomputed rather than served.
const CROSS_FORMAT = 2;
// "At least N% above" (owner, 2026-10-28): only crosses whose 30-day line
// is at least this far above the 60-day one today. 0 shows every cross.
const CROSS_DEFAULT_MIN_GAP = 5;
const CROSS_MAX_MIN_GAP = 100;
const crossCache = new Map();    // "nowDate|vendor" -> {nowDate, windowDates, rows}; latest date only
const crossInflight = new Map(); // same key -> Promise

/* The pure detection rule. `vals` are one printing/finish's prices, newest
   first, as {v, d} with `d` a day number (dayNum()); `nowDay` is the latest
   snapshot's day number and `sinceDay` the earliest day a cross may fall
   on. Returns {crossDay, ma30, ma60} (ma30/ma60 are today's lines) or null.
   The lines on each priced day are exactly what maFor() returns as of that
   day: the median of the newest 30 / 60 prices at or before it, null when
   there are too few or they reach back more than MA_SPAN days. The most
   recent upward cross wins; the lines must still be above today, every day
   from the cross on, and the day before the cross must have real lines at
   or below (not "too little history"). */
function goldenCrossOf(vals, nowDay, sinceDay) {
  const N = vals.length;
  if (N < 61) return null;   // today's 60-day line plus the day before the cross
  // Walking back one priced day at a time, the two windows (vals[i..i+29]
  // and vals[i..i+59]) are kept sorted and shifted by one value each step
  // instead of re-sorted: the same medians medianOf() takes, at a fraction
  // of the cost over ~100k printings.
  const byNum = (x, y) => x - y;
  const w30 = [], w60 = [];
  for (let k = 0; k < 60; k++) { if (k < 30) w30.push(vals[k].v); w60.push(vals[k].v); }
  w30.sort(byNum); w60.sort(byNum);
  // Lines as of day `asOf` from the windows starting at vals[i]: true above,
  // false at or below, null when either is missing (MA_SPAN).
  const linesAt = (i, asOf) => {
    if (N - i < 60) return null;
    if (asOf - vals[i + 29].d > MA_SPAN[30] || asOf - vals[i + 59].d > MA_SPAN[60]) return null;
    return sortedMedian(w30) > sortedMedian(w60);
  };
  if (linesAt(0, nowDay) !== true) return null;
  const ma30 = sortedMedian(w30), ma60 = sortedMedian(w60);
  let cur = linesAt(0, vals[0].d);
  for (let i = 0; i < N && vals[i].d >= sinceDay; i++) {
    if (cur !== true) return null;           // not above on this day: no unbroken run from a cross to today
    if (N - (i + 1) < 60) return null;       // the day before has no 60-day line
    sortedRemove(w30, vals[i].v); sortedInsert(w30, vals[i + 30].v);
    sortedRemove(w60, vals[i].v); sortedInsert(w60, vals[i + 60].v);
    const prev = linesAt(i + 1, vals[i + 1].d);
    if (prev === false) return Object.assign({ crossDay: vals[i].d, ma30, ma60 }, climbOf(vals));
    cur = prev;
  }
  return null;
}
/* How the price got where it is over the newest 30 priced days, for the
   "steady climber" pick (#352, MoversPicks.steadyClimber): `climbPct` is the
   rise from the oldest of them to today, in percent; `jumpShare` the biggest
   single day-to-day rise as a share of that whole climb (1 = it all came in
   one jump; null when the price didn't rise); `offHighPct` how far today's
   price sits below the highest of them, in percent (0 = at the high). */
function climbOf(vals) {
  const first = vals[29].v, last = vals[0].v;
  let maxStep = 0, high = last;
  for (let k = 0; k < 29; k++) {
    maxStep = Math.max(maxStep, vals[k].v - vals[k + 1].v);
    high = Math.max(high, vals[k + 1].v);
  }
  const rise = last - first;
  return {
    climbPct: first > 0 ? rise / first * 100 : null,
    jumpShare: rise > 0 ? maxStep / rise : null,
    offHighPct: high > 0 ? (high - last) / high * 100 : null
  };
}
function sortedMedian(a) {
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function lowerBound(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}
function sortedInsert(a, v) { a.splice(lowerBound(a, v), 0, v); }
function sortedRemove(a, v) { a.splice(lowerBound(a, v), 1); }

function goldenCrossSweep(vendor, nowDate) {
  const cacheKey = nowDate + "|" + vendor;
  const hit = crossCache.get(cacheKey);
  if (hit) return Promise.resolve(hit);
  const running = crossInflight.get(cacheKey);
  if (running) return running;
  const p = computeCrosses(vendor, nowDate, cacheKey).finally(() => {
    if (crossInflight.get(cacheKey) === p) crossInflight.delete(cacheKey);
  });
  crossInflight.set(cacheKey, p);
  return p;
}

async function computeCrosses(vendor, nowDate, cacheKey) {
  for (const k of crossCache.keys()) if (!k.startsWith(nowDate + "|")) crossCache.delete(k);
  const persisted = stmt.getCrossCache.get(nowDate, vendor);
  if (persisted) {
    const out = JSON.parse(persisted.data);
    if (out && out.v === CROSS_FORMAT && out.nowDate === nowDate && Array.isArray(out.rows)) {
      crossCache.set(cacheKey, out);
      return out;
    }
  }

  const gen = sweepGeneration;
  // The newest CROSS_MAX_DAYS snapshot dates, oldest first: the window a
  // request's N picks from (N=1 is just the latest day).
  const windowDates = stmt.allSnapshotDates.all().map(r => r.date).filter(d => d <= nowDate).slice(-CROSS_MAX_DAYS);
  const nowDay = dayNum(nowDate), sinceDay = dayNum(windowDates[0] || nowDate);
  const vs = vendorStmts(vendor);
  const slice = slicer();
  const rows = [];
  let after = "";
  for (;;) {
    const nowRows = vs.sweepNow.all(nowDate, after, SWEEP_CHUNK);
    if (!nowRows.length) break;
    after = nowRows[nowRows.length - 1].key;
    for (const nowPair of nowRows) {
      const key = nowPair.key;
      const parts = key.split("|");
      const card = cards.cardByKey(parts[0], parts[1], parts[2]);
      if (!card) continue;
      for (const finish of finishesFor(card)) {
        const now = priceAt(nowPair, vendor, finish);
        // hasMaTrend's floor (moversPicks.js): today's price and both lines
        // at $1+, so cents-level cards can't flood the list.
        if (now == null || now < MIN_SWEEP_PRICE) continue;
        const vals = crossColStmt(colName(vendor, finish)).all(key, nowDate);
        const x = goldenCrossOf(vals, nowDay, sinceDay);
        if (!x || x.ma30 < MIN_SWEEP_PRICE || x.ma60 < MIN_SWEEP_PRICE) continue;
        rows.push({
          key, finish, crossDate: shiftDate(nowDate, x.crossDay - nowDay), now,
          ma30: x.ma30, ma60: x.ma60, maDiff: x.ma30 - x.ma60, maPct: maPctOf(x.ma30, x.ma60),
          climbPct: x.climbPct, jumpShare: x.jumpShare, offHighPct: x.offHighPct,
          name: card.name, set: card.set, setName: card.setName, collector: card.collector, lang: card.lang,
          rarity: card.rarity || "", imageUrl: card.imageUrl || "", oracleId: card.oracleId || null
        });
      }
      if (slice.due()) await slice.pause();
    }
    if (nowRows.length < SWEEP_CHUNK) break;
  }
  rows.sort((a, b) => b.maPct - a.maPct);
  const out = { v: CROSS_FORMAT, nowDate, windowDates, rows };
  if (gen !== sweepGeneration) return out;
  crossCache.set(cacheKey, out);
  stmt.setCrossCache.run(nowDate, vendor, new Date().toISOString(), JSON.stringify(out));
  return out;
}

/* GET /api/prices/golden-cross: every catalog printing/finish whose 30-day
   line crossed above its 60-day line within the last `days` snapshot days
   (1..CROSS_MAX_DAYS, default 7), is still above today, and sits at least
   `opts.minGap` percent above it now (0..CROSS_MAX_MIN_GAP, default 5).
   Each row carries the caller's owned quantity of that printing + finish;
   `opts.mine` keeps only those. Strongest MA30-60 % first, at most
   CROSS_MAX_ROWS rows; `total`/`ownedTotal` count every match before that
   cap. `best` is the strongest few steady climbers (MoversPicks.
   steadyClimber) among the same matches, whatever `mine` says, for the
   curated pick. */
async function goldenCrosses(userId, opts) {
  const vendor = vendorOf(opts);
  const raw = Math.floor(Number(opts && opts.days));
  const days = Math.min(CROSS_MAX_DAYS, Math.max(1, Number.isFinite(raw) && raw > 0 ? raw : CROSS_DEFAULT_DAYS));
  const gapIn = opts && opts.minGap;
  const gapNum = gapIn === "" || gapIn == null ? NaN : Number(gapIn);
  const minGap = Number.isFinite(gapNum) ? Math.min(CROSS_MAX_MIN_GAP, Math.max(0, gapNum)) : CROSS_DEFAULT_MIN_GAP;
  const mine = !!(opts && opts.mine);
  const nowDate = latestDateStr();
  const base = { vendor, vendors: VENDOR_CODES, days, maxDays: CROSS_MAX_DAYS, minGap, maxMinGap: CROSS_MAX_MIN_GAP, mine, toDate: nowDate };
  if (!nowDate) return Object.assign(base, { error: "No price snapshots have been taken yet.", sinceDate: null, total: 0, ownedTotal: 0, rows: [] });

  const sweep = await goldenCrossSweep(vendor, nowDate);
  const wd = sweep.windowDates;
  const sinceDate = wd.length ? wd[Math.max(0, wd.length - days)] : nowDate;

  // The caller's held copies per printing + finish (every condition summed).
  const coll = await store.readCollection(userId);
  const held = new Map();
  for (const c of (coll.state && coll.state.cards) || []) {
    if (!c || !c.set || !c.collector) continue;
    const kf = cards.printKey(c.set, c.collector, c.lang || "en") + "|" + (c.finish || "nonfoil");
    held.set(kf, (held.get(kf) || 0) + (Number(c.quantity) || 0));
  }

  const out = [];
  // The strongest few steady climbers whatever `mine` says, for the curated
  // pick on Worth a look today (the page skips cards another pick shows).
  const best = [];
  let total = 0, ownedTotal = 0;
  for (const r of sweep.rows) {
    if (r.crossDate < sinceDate || !(r.maPct >= minGap)) continue;
    const qty = held.get(r.key + "|" + r.finish) || 0;
    total++;
    if (qty > 0) ownedTotal++;
    if (best.length < CROSS_BEST && moversPicks.steadyClimber(r)) best.push(Object.assign({}, r, { qty }));
    if (mine && !(qty > 0)) continue;
    if (out.length < CROSS_MAX_ROWS) out.push(Object.assign({}, r, { qty }));
  }
  return Object.assign(base, {
    sinceDate,
    // Snapshot days the window really spans (fewer than `days` while the
    // archive is young).
    windowDays: wd.length ? wd.length - wd.indexOf(sinceDate) : 0,
    total, ownedTotal,
    shown: out.length,
    best,
    rows: out
  });
}

/* Per-account result caches (#113). The header ticker asks for the same
   tiny answer on every page view, and the Movers page asks for the same
   Portfolio chart on every visit, so each is cached per account per
   snapshot date. The key includes the collection file's stamp
   (store.collectionStamp: mtime + size), so saving the collection
   invalidates it with no explicit hook. Both are bounded by entry count and
   each entry is small (at most `top` rows, or one point per snapshot date). */
const TOP_CACHE_MAX = 500;
const PORTFOLIO_CACHE_MAX = 200;
const topCache = new Map();
const portfolioCache = new Map();
const MAX_TOP = 100;

/* What moved - every printing in the card index, not just what this user
   holds. `opts.vendor` picks which MTGJSON vendor drives now/then/delta/
   pct/valueDelta/ma30/ma60 (default "tcg") - the Movers page lets the
   viewer switch it, everything else about the row shape is identical
   regardless of which vendor produced it.

   `opts.top` (the header ticker) returns only the N owned rows with the
   biggest value change instead of every owned row, and is cached per
   account per snapshot date.

   `held` (#111) summarises every held printing for the Movers tiles,
   computed before the meaningful-move filter, so the tiles read the same
   whether "Only held" is ticked or not and agree with the Portfolio chart.
   It counts printing + finish (#112), so one printing held in two
   conditions is one printing up or down, not two. */
async function movers(userId, days, opts) {
  const ownedOnly = !!(opts && opts.ownedOnly);
  const skipMA = !!(opts && opts.skipMA);
  const heldOnly = !!(opts && opts.heldOnly);
  const top = Math.min(MAX_TOP, Math.max(0, Math.floor(Number(opts && opts.top) || 0)));
  // An owned row bypasses the meaningful-move bar by default - deliberately,
  // so a small real move on your own collection is never hidden just because
  // it wouldn't earn a spot in the wider catalog sweep. That's the right
  // default with "Only held" ON (a deliberate deep-dive into just your own
  // cards) but not with it OFF, where the table is meant to read as "what
  // moved," same for every account - ownedOnly (the nav ticker, always wants
  // every owned move regardless) is excluded either way. The tiles never
  // apply it (see `held`).
  const requireMeaningfulOwned = !ownedOnly && !heldOnly;
  const vendor = vendorOf(opts);
  const back = Math.max(1, Number(days) || 7);
  const nowDate = latestDateStr();
  if (!nowDate) return { error: "No price snapshots have been taken yet.", rows: [] };
  const thenDate = thenDateFor(nowDate, back);

  const gen = sweepGeneration;
  let topKey = null;
  if (top) {
    const stamp = await store.collectionStamp(userId);
    topKey = [userId, stamp, nowDate, thenDate || "", vendor, back, ownedOnly ? 1 : 0, heldOnly ? 1 : 0, skipMA ? 1 : 0, top].join("|");
    const hit = lruGet(topCache, topKey);
    if (hit) return hit;
  }

  const coll = await store.readCollection(userId);
  const list = (coll.state && coll.state.cards) || [];

  const rows = [];
  const owned = new Set();

  // Storefront grain: one row per printing x finish x condition.
  const grouped = new Map();
  for (const c of list) {
    if (!c || !c.set || !c.collector) continue;
    const finish = c.finish || "nonfoil";
    const condition = c.condition || "";
    const key = [c.set, cards.normNum(c.collector), c.lang || "en", finish, condition].join("|");
    let g = grouped.get(key);
    if (!g) {
      g = {
        set: c.set, collector: c.collector, setName: c.setName, lang: c.lang || "en",
        finish, condition, name: c.name, rarity: c.rarity, imageUrl: c.imageUrl, oracleId: c.oracleId || null,
        qty: 0, listed: 0, costTotal: 0, costQty: 0
      };
      grouped.set(key, g);
    }
    g.qty += Number(c.quantity) || 0;
    g.listed += Number(c.listedQty) || 0;
    const cq = Math.min(Number(c.costQty) || 0, Number(c.quantity) || 0);
    if (cq > 0 && c.avgCost != null) { g.costTotal += cq * Number(c.avgCost); g.costQty += cq; }
  }

  // #113: each printing's two dated rows (and its "then" rank) are read
  // once, however many finishes and conditions it is held in, and each
  // printing x finish's moving averages once. Both maps are request-scoped
  // and hold one small entry per distinct owned printing.
  const vs = vendorStmts(vendor);
  const perKey = new Map();
  const maMemo = new Map();
  const heldAgg = new Map(); // "printKey|finish" -> {name, then, now, delta, qty, valueDelta}
  let heldNowValue = 0;
  const slice = slicer();
  for (const g of grouped.values()) {
    const k = cards.printKey(g.set, g.collector, g.lang);
    const kf = k + "|" + g.finish;
    owned.add(kf);
    let ctx = perKey.get(k);
    if (!ctx) {
      const nowPair = vs.pair.get(k, nowDate) || null;
      const thenPair = thenDate ? (vs.pair.get(k, thenDate) || null) : null;
      let rankThen, rankKnown = false;
      // skipMA (the ticker) wants NO rank walk at all - it never displays
      // rank - so it takes whatever the immediate "then" row already has.
      const rankThenOf = () => {
        if (!rankKnown) {
          rankThen = skipMA ? (thenPair && thenPair.rank != null ? thenPair.rank : null) : rankThenFor(k, thenPair, nowDate);
          rankKnown = true;
        }
        return rankThen;
      };
      ctx = { nowPair, thenPair, rankThenOf };
      perKey.set(k, ctx);
    }
    const r = moveCore(k, g.finish, vendor, ctx.nowPair, ctx.thenPair, ctx.rankThenOf, false);
    if (r) {
      const valueDelta = r.delta == null ? null : r.delta * g.qty;
      if (r.now != null) heldNowValue += r.now * g.qty;
      if (r.delta != null) {
        let a = heldAgg.get(kf);
        if (!a) { a = { name: g.name, then: r.then, now: r.now, delta: r.delta, qty: 0, valueDelta: 0 }; heldAgg.set(kf, a); }
        a.qty += g.qty;
        a.valueDelta += valueDelta;
      }
      if (!requireMeaningfulOwned || isMeaningful(r)) {
        if (!skipMA) {
          let ma = maMemo.get(kf);
          if (!ma) { ma = maFor(k, vendor, g.finish, nowDate); maMemo.set(kf, ma); }
          setMA(r, ma);
        }
        const avgCost = g.costQty > 0 ? g.costTotal / g.costQty : null;
        rows.push(Object.assign(r, {
          name: g.name, set: g.set, setName: g.setName, collector: g.collector, lang: g.lang,
          condition: g.condition,
          rarity: g.rarity || "", imageUrl: g.imageUrl || "",
          oracleId: g.oracleId, totalPrintings: cards.oracleFinishTotal(g.oracleId) || 1,
          qty: g.qty, listed: g.listed, avgCost: avgCost == null ? null : Number(avgCost), costQty: Number(g.costQty) || 0,
          valueDelta
        }));
      }
    }
    if (slice.due()) await slice.pause();
  }

  // thenValue (#298): what the printings in netValue (priced at both ends)
  // were worth at the start, so the Dashboard's Value change tile can give
  // a percentage over the same cards.
  const held = { nowValue: heldNowValue, netValue: 0, thenValue: 0, up: 0, upValue: 0, down: 0, downValue: 0, best: null, worst: null };
  for (const a of heldAgg.values()) {
    if (!(a.qty > 0)) continue;
    held.netValue += a.valueDelta;
    held.thenValue += (Number(a.then) || 0) * a.qty;
    if (a.delta > 0) {
      held.up++; held.upValue += a.valueDelta;
      if (!held.best || a.valueDelta > held.best.valueDelta) held.best = a;
    } else if (a.delta < 0) {
      held.down++; held.downValue += a.valueDelta;
      if (!held.worst || a.valueDelta < held.worst.valueDelta) held.worst = a;
    }
  }

  let outRows = rows;
  if (top) {
    outRows = rows
      .filter(r => r.qty > 0 && r.delta != null && Math.abs(r.valueDelta || 0) >= 0.01)
      .sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta))
      .slice(0, top);
  } else if (!ownedOnly) {
    const sweep = await unownedMovedSweep(vendor, back, nowDate, thenDate);
    for (const r of sweep) if (!owned.has(r.key + "|" + r.finish)) rows.push(r);
  }
  const result = {
    fromDate: thenDate,
    toDate: nowDate,
    // The archive's first snapshot, so the page can tell "the archive
    // doesn't go back that far" apart from "the nearest snapshot to that
    // day" (#110).
    oldestDate: oldestDateStr(),
    requestedDays: back,
    vendor,
    vendors: VENDOR_CODES,
    // How many printings in TODAY's snapshot have any price at all for the
    // selected vendor - an empty `rows` otherwise reads as "nothing moved
    // today" whether that's true or the vendor simply has no data. Skipped
    // for the ticker's skipMA fast path - it never shows this message.
    vendorCoverage: skipMA ? null : vendorCoverageFor(nowDate, vendor),
    held,
    rows: outRows
  };
  if (topKey && gen === sweepGeneration) lruSet(topCache, topKey, result, TOP_CACHE_MAX);
  return result;
}

/* Price stats for an explicit list of printings - the Buy List watch list
   (at most 200 from the route) and the daily digest (every held printing).
   Unlike movers(), this never sweeps the catalog. `items` is
   [{set, collector, lang, finish}, ...]. */
async function watchPrices(items, days, opts) {
  const vendor = vendorOf(opts);
  const back = Math.max(1, Number(days) || 90);
  const nowDate = latestDateStr();
  if (!nowDate) return { error: "No price snapshots have been taken yet.", rows: [] };
  const thenDate = thenDateFor(nowDate, back);
  const cutoff = shiftDate(nowDate, -back);
  const vs = vendorStmts(vendor);
  const slice = slicer();

  const rows = [];
  for (const it of (items || [])) {
    if (!it || !it.set || !it.collector) continue;
    const finish = it.finish || "nonfoil";
    const lang = it.lang || "en";
    const k = cards.printKey(it.set, it.collector, lang);
    const nowPair = vs.pair.get(k, nowDate) || null;
    const thenPair = thenDate ? (vs.pair.get(k, thenDate) || null) : null;
    const nowPrice = priceAt(nowPair, vendor, finish);
    const thenPrice = priceAt(thenPair, vendor, finish);
    const rankNow = nowPair && nowPair.rank != null ? nowPair.rank : null;
    const rankThen = rankThenFor(k, thenPair, nowDate);
    const rankDelta = (rankNow == null || rankThen == null) ? null : rankNow - rankThen;
    const delta = (nowPrice == null || thenPrice == null) ? null : nowPrice - thenPrice;

    const { ma30, ma60 } = maFor(k, vendor, finish, nowDate);
    const c = colName(vendor, finish);
    let windowLow = null, windowHigh = null;
    for (const row of vs.range.all(k, cutoff, nowDate)) {
      const v = row[c];
      if (v == null) continue;
      if (windowLow == null || v < windowLow) windowLow = v;
      if (windowHigh == null || v > windowHigh) windowHigh = v;
    }

    rows.push({
      key: k, set: it.set, collector: it.collector, lang, finish,
      then: thenPrice, now: nowPrice, delta,
      pct: (delta == null || !thenPrice) ? null : (delta / thenPrice) * 100,
      rankNow, rankThen, rankDelta,
      ma30, ma60, maDiff: (ma30 != null && ma60 != null) ? ma30 - ma60 : null,
      maPct: maPctOf(ma30, ma60),
      windowLow, windowHigh
    });
    if (slice.due()) await slice.pause();
  }
  return { fromDate: thenDate, toDate: nowDate, requestedDays: back, vendor, rows };
}

/* Every vendor's most recent retail price for one printing, per finish
   (BACKLOG #78a - the side-by-side "who lists it for what" table under the
   price chart). Walks back from the newest row per vendor/finish, so a
   vendor that skipped the latest snapshot still shows its last known price,
   with that price's own date - the client flags it as older rather than
   presenting it as today's. `rows` is wholeSeries() output, already in hand
   for history(), so this costs no extra read. Values are each vendor's own
   currency: cm (Cardmarket) is EUR, never converted (mtgjson.js). */
/* Today's USD vendor prices for a batch of inventory rows (BACKLOG #78b:
   the TCGplayer / Card Kingdom / Manapool price-rule bases). One indexed
   point read per distinct printing at the latest snapshot - measured, not
   guessed: see the 78b note in BACKLOG_COMPLETE.md. Returns an array
   parallel to `items` ({set, collector, lang, finish}); each entry is
   {tcg, ck, mp} with only the vendors that had a price, or null. Etched
   falls back to the foil column (same gap the Manapool bases fill that
   way). Cardmarket (EUR, no FX feed) is never included, nor Cardsphere (no
   retail price in MTGJSON - never once in this archive). */
const RULE_VENDORS = ["tcg", "ck", "mp"];
function vendorPricesFor(items) {
  const date = latestDateStr();
  const out = new Array(items.length).fill(null);
  if (!date) return out;
  const rowByKey = new Map();
  items.forEach((it, i) => {
    if (!it || !it.set || it.collector == null) return;
    const key = cards.printKey(it.set, it.collector, it.lang || "en");
    if (!rowByKey.has(key)) rowByKey.set(key, stmt.pairAt.get(key, date) || null);
    const row = rowByKey.get(key);
    if (!row) return;
    const vp = {};
    for (const v of RULE_VENDORS) {
      let val = row[colName(v, it.finish)];
      if (val == null && it.finish === "etched") val = row[colName(v, "foil")];
      if (val != null && Number(val) > 0) vp[v] = Math.round(Number(val) * 100) / 100;
    }
    out[i] = Object.keys(vp).length ? vp : null;
  });
  return out;
}

function latestByVendor(rows) {
  const out = { date: rows.length ? rows[rows.length - 1].date : null, vendors: {} };
  for (const v of VENDOR_CODES) {
    const per = {};
    for (const finish of ["nonfoil", "foil", "etched"]) {
      const col = colName(v, finish);
      for (let i = rows.length - 1; i >= 0; i--) {
        const val = rows[i][col];
        if (val != null) { per[finish] = { price: val, date: rows[i].date }; break; }
      }
    }
    out.vendors[v] = per;
  }
  return out;
}

/* One printing's whole series, all three finishes, for one vendor
   (`opts.vendor`, default "tcg"). `rank` is per-card, not per-finish or
   per-vendor. */
async function history(key, opts) {
  const vendor = vendorOf(opts);
  const rows = wholeSeries(key);
  if (!rows.length) {
    return { key, vendor, vendors: VENDOR_CODES, dates: [], usd: [], foil: [], etched: [], rank: [],
      usdMa30: [], usdMa60: [], foilMa30: [], foilMa60: [], etchedMa30: [], etchedMa60: [] };
  }
  const dates = rows.map(r => r.date);
  const rank = rows.map(r => r.rank == null ? null : r.rank);
  const usd = rows.map(r => r[colName(vendor, "nonfoil")]);
  const foil = rows.map(r => r[colName(vendor, "foil")]);
  const etched = rows.map(r => r[colName(vendor, "etched")]);
  return {
    key, vendor, vendors: VENDOR_CODES,
    dates, usd, foil, etched, rank,
    latestByVendor: latestByVendor(rows),
    usdMa30: slidingMedian(usd, dates, 30), usdMa60: slidingMedian(usd, dates, 60),
    foilMa30: slidingMedian(foil, dates, 30), foilMa60: slidingMedian(foil, dates, 60),
    etchedMa30: slidingMedian(etched, dates, 30), etchedMa60: slidingMedian(etched, dates, 60)
  };
}

/* Portfolio value over time for one user: today's quantities priced at each
   historic date, using `opts.vendor` (default "tcg"). The window is counted
   back from the latest snapshot (#110), the same way Movers counts it.

   #113: one narrow range read per owned printing - just the window's dates
   and the selected vendor's three finish columns, shared by every finish
   held of that printing - instead of every column of its whole history once
   per finish. The loop yields every YIELD_SLICE_MS, so a 30,000-printing
   collection doesn't hold up other requests, and the result is cached per
   account per snapshot date (invalidated by a collection save; see
   portfolioCache). */
async function portfolio(userId, days, opts) {
  const vendor = vendorOf(opts);
  const back = Math.max(2, Number(days) || 90);
  const nowDate = latestDateStr();
  if (!nowDate) return { days: back, vendor, points: [] };
  const gen = sweepGeneration;
  const stamp = await store.collectionStamp(userId);
  const cacheKey = [userId, stamp, nowDate, vendor, back].join("|");
  const hit = lruGet(portfolioCache, cacheKey);
  if (hit) return hit;

  const start = shiftDate(nowDate, -back);
  const dates = (await availableDates()).filter(d => d >= start);
  const coll = await store.readCollection(userId);
  const list = (coll.state && coll.state.cards) || [];

  const owned = new Map(); // printKey -> Map(finish -> qty)
  let totalCards = 0;
  for (const c of list) {
    if (!c || !c.set || !c.collector) continue;
    const finish = c.finish || "nonfoil";
    const qty = Number(c.quantity) || 0;
    totalCards += qty;
    const k = cards.printKey(c.set, c.collector, c.lang || "en");
    let fins = owned.get(k);
    if (!fins) { fins = new Map(); owned.set(k, fins); }
    fins.set(finish, (fins.get(finish) || 0) + qty);
  }

  const valueByDate = new Map(dates.map(d => [d, { value: 0, pricedCards: 0 }]));
  const vs = vendorStmts(vendor);
  const slice = slicer();
  for (const [k, fins] of owned) {
    const held = [...fins].map(([finish, qty]) => [colName(vendor, finish), qty]);
    for (const row of vs.range.all(k, start, nowDate)) {
      const acc = valueByDate.get(row.date);
      if (!acc) continue;
      for (const [c, qty] of held) {
        const price = row[c];
        if (price == null) continue;
        acc.value += price * qty;
        acc.pricedCards += qty;
      }
    }
    if (slice.due()) await slice.pause();
  }

  const points = dates.map(d => {
    const acc = valueByDate.get(d);
    return { date: d, value: acc.value, pricedCards: acc.pricedCards, totalCards };
  });
  const result = { days: back, vendor, points };
  if (gen === sweepGeneration) lruSet(portfolioCache, cacheKey, result, PORTFOLIO_CACHE_MAX);
  return result;
}

/* ---------- Writes ---------- */

function priceRowValues(key, date, rank, vendorPrices) {
  const vals = [key, date, rank == null ? null : rank];
  for (const code of VENDOR_CODES) {
    const row = vendorPrices ? vendorPrices[code] : null;
    vals.push(row && row[0] != null ? row[0] : null);
    vals.push(row && row[1] != null ? row[1] : null);
    vals.push(row && row[2] != null ? row[2] : null);
  }
  return vals;
}

/* Two overlapping callers - a manual "run now" landing on top of the nightly
   schedule, most plausibly - both check "already done today" then go on to
   write. store.withLock() serialises callers sharing the same key so the
   whole body runs as one critical section per key - shared with
   backfillFromMtgjson() below since both touch the same archive. */
async function snapshot(opts) {
  return store.withLock("price-snapshot", async () => {
    const force = !!(opts && opts.force);
    const date = (opts && opts.date) || today();
    if (!cards.ready) {
      logger("card index is not loaded yet - skipping today's snapshot");
      return { skipped: "cards not ready" };
    }
    if (!force && stmt.snapshotByDate.get(date)) return { skipped: "already snapshotted " + date };

    const mp = await mtgjson.pricesToday();
    let count = 0, purgedNonCards = 0;
    transaction(() => {
      for (const card of cards.all()) {
        const k = cards.printKey(card.set, card.collector, card.lang);
        if (EXCLUDED_LAYOUTS.has(card.layout)) {
          // Self-healing: also removes any row this key picked up before
          // this filter existed (a legacy-archive migration, or an older
          // snapshot run pre-fix), not just skipping it going forward.
          stmt.deletePriceDaysForKey.run(k);
          purgedNonCards++;
          continue;
        }
        const vendorPrices = mp.bySc.get(card.id);
        // Price-required, not rank-OR-price: if no vendor has ever priced
        // this printing, nobody's trading it, so it can never appear in a
        // movers() row anyway (a delta needs a real price on both ends) and
        // tracking its rank alone is pure archive bloat with no reachable
        // feature behind it (see BACKLOG.md - a one-time recovery merge
        // that violated this rule nearly quadrupled every shard's size
        // under the old storage design).
        if (!vendorPrices) continue;
        const rank = card.edhrecRank == null ? null : card.edhrecRank;
        stmt.upsertDay.run(...priceRowValues(k, date, rank, vendorPrices));
        count++;
      }
      stmt.upsertSnapshot.run(date, count, mp.asOf || null, new Date().toISOString());
      // Yesterday's sweep cache is dead weight the moment a new day lands -
      // it's only ever looked up keyed on today's date, so nothing will ever
      // read an older row again.
      stmt.deleteStaleMoversCache.run(date);
      stmt.deleteStaleCrossCache.run(date);
      // A persisted sweep computed before this run - e.g. under an older
      // exclusion rule - would otherwise keep being served as-is for the
      // rest of today, since the cache is normally only invalidated by the
      // date changing. `force` already means "recompute now" - an explicit
      // ask, not the nightly job - so it also always drops today's cached
      // sweep, not just when this run itself purged a row.
      if (purgedNonCards || force) {
        stmt.deleteMoversCacheForDate.run(date);
        stmt.deleteCrossCacheForDate.run(date);
      }
    });
    if (purgedNonCards || force) clearSweepCache();
    await pruneDays();
    // Warm the one combo the page actually opens to by default (TCGplayer,
    // 7-day window) right now, in this background job, rather than making
    // whoever happens to load Movers first today pay for it. Every other
    // vendor/window combo stays lazy (computed - and persisted - on first
    // real request) since most never get visited on a given day and
    // precomputing all of them would mean holding a full-catalog sweep
    // result for every one of the ~25 vendor/window combinations at once.
    try {
      // Awaited, but no longer one synchronous ~11s block (#54): the sweep
      // yields to other requests as it goes.
      await unownedMovedSweep(DEFAULT_VENDOR, 7, date, thenDateFor(date, 7));
    } catch (e) {
      logger("could not warm the default movers sweep: " + e.message);
    }
    // Same for the default vendor's golden crosses (#352), which Worth a
    // look today asks for on every Movers load.
    try {
      await goldenCrossSweep(DEFAULT_VENDOR, date);
    } catch (e) {
      logger("could not warm the golden-cross list: " + e.message);
    }
    checkpointAndOptimize();
    logger("snapshot " + date + ": " + count + " printings with an MTGJSON price" +
      (purgedNonCards ? " (" + purgedNonCards + " token/emblem printings excluded)" : ""));
    return { ok: true, date, printings: count, priced: count, purgedNonCards };
  });
}

async function pruneDays() {
  const keep = Math.max(30, Number(cfg.prices.keepDays) || 400);
  const cutoff = daysAgo(keep);
  transaction(() => {
    stmt.deleteOldPriceDays.run(cutoff);
    stmt.deleteOldSnapshots.run(cutoff);
  });
}

/* One-time (or re-run-on-demand) replacement of the whole archive with
   MTGJSON's 90-day paper price history. Deliberately admin-triggered, not
   part of the daily job loop - a 147MB compressed streamed download is not
   something to repeat every day when AllPricesToday.json (4-5MB) already
   covers the daily case via snapshot() above.

   mtgjson.backfill() streams AllPrices.json uuid-major, calling back
   `onDay(date, scryfallId, prices)` once per (printing, date) pair it finds -
   grouped by printing, not by date. The old JSON-file storage needed a whole
   staging subsystem here (one temp NDJSON file per date, opened lazily
   during the streamed pass, read back in a second phase) specifically
   because writing a date-major file needed every printing's data for that
   date in hand at once, and the source stream never guarantees that until
   it's fully finished. SQLite doesn't care about insertion order - each
   (key, date) pair upserts as its own row wherever it lands in the stream -
   so that whole staging subsystem is gone: `onDay` upserts directly,
   chunked into transactions every ~50,000 rows to bound how much a single
   transaction holds before committing (matches the existing progress-log
   cadence below). */
async function backfillFromMtgjson() {
  return store.withLock("price-snapshot", async () => {
    if (!cards.ready) throw new Error("The card index is not loaded yet - try again once it is.");

    logger("wiping the existing price archive before the MTGJSON backfill");
    transaction(() => {
      stmt.deleteAllPriceDays.run();
      stmt.deleteAllSnapshots.run();
      stmt.deleteAllMoversCache.run();
      stmt.deleteAllCrossCache.run();
    });
    clearSweepCache();

    const printKeyOf = new Map(); // scryfallId -> Grimoire printKey
    for (const card of cards.all()) printKeyOf.set(card.id, cards.printKey(card.set, card.collector, card.lang));

    let n = 0;
    const seenDates = new Set();
    db.exec("BEGIN");
    try {
      const scan = await mtgjson.backfill((date, scryfallId, prices) => {
        const k = printKeyOf.get(scryfallId);
        if (!k) return;
        stmt.upsertDay.run(...priceRowValues(k, date, null, prices));
        seenDates.add(date);
        n++;
        if (n % 50000 === 0) {
          db.exec("COMMIT");
          db.exec("BEGIN");
          logger("MTGJSON backfill: " + n.toLocaleString() + " rows written");
        }
      });
      db.exec("COMMIT");

      transaction(() => {
        for (const date of seenDates) {
          const row = stmt.countForDate.get(date);
          stmt.upsertSnapshot.run(date, row.n, null, new Date().toISOString());
        }
      });

      checkpointAndOptimize();
      const dates = [...seenDates].sort();
      logger("MTGJSON backfill complete: " + dates.length + " days, " + scan.matched.toLocaleString() + " printings matched");
      return { ok: true, days: dates.length, from: dates[0] || null, to: dates[dates.length - 1] || null, matched: scan.matched };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (e2) {}
      throw e;
    }
  });
}

/* One-time migration from the legacy JSON-file archive (prices/day/*.json,
   prices/series/NN.json) into this file's SQLite database - see
   `--migrate-prices-to-sqlite` in server/index.js. Reads the 64 series
   shards (each already the fullest per-printing history - the canonical
   source, not day/*.json, which is a redundant flattening of the same
   data) and writes one price_days row per date per printing. Deliberately
   does NOT delete the old files - they're simply not read once this
   process's code is live; leave them as a fallback until the migrated data
   has been confirmed correct (this archive has been lost and recovered from
   backup once already - see BACKLOG.md - so this migration errs toward
   over-cautious). */
async function migrateFromLegacyFiles() {
  const seriesDir = store.p("prices", "series");
  const dayDir = store.p("prices", "day");

  let seriesFiles = [];
  try { seriesFiles = (await fsp.readdir(seriesDir)).filter(f => f.endsWith(".json")).sort(); } catch (e) {}
  if (!seriesFiles.length) {
    logger("no legacy prices/series/*.json files found - nothing to migrate");
    return { migrated: false, printingsSeen: 0, rowsWritten: 0, dates: 0 };
  }

  // Best-effort metadata (mtgjson_as_of/built_at) from the old day files -
  // not load-bearing, so a missing/unreadable day file just leaves it null.
  const meta = new Map();
  let dayFiles = [];
  try { dayFiles = (await fsp.readdir(dayDir)).filter(f => f.endsWith(".json")); } catch (e) {}
  for (const f of dayFiles) {
    const doc = await store.readJson(path.join(dayDir, f), null);
    if (doc && doc.asOf) meta.set(doc.asOf, { mtgjsonAsOf: doc.mtgjsonAsOf || null, builtAt: doc.builtAt || null });
  }

  let printingsSeen = 0, rowsWritten = 0;
  const dateCounts = new Map();
  for (const f of seriesFiles) {
    const shard = await store.readJson(path.join(seriesDir, f), {});
    transaction(() => {
      for (const key of Object.keys(shard)) {
        const s = shard[key];
        if (!s || !s.d) continue;
        printingsSeen++;
        for (let i = 0; i < s.d.length; i++) {
          const date = s.d[i];
          const rank = (s.r && s.r[i] != null) ? s.r[i] : null;
          const vals = [key, date, rank];
          let any = rank != null;
          for (const code of VENDOR_CODES) {
            const v = s.v && s.v[code];
            const u = v && v.u && v.u[i] != null ? v.u[i] : null;
            const fo = v && v.f && v.f[i] != null ? v.f[i] : null;
            const e = v && v.e && v.e[i] != null ? v.e[i] : null;
            if (u != null || fo != null || e != null) any = true;
            vals.push(u, fo, e);
          }
          if (!any) continue; // an all-null row (no price anywhere, no rank) carries nothing worth a page
          stmt.upsertDay.run(...vals);
          rowsWritten++;
          dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
        }
      }
    });
  }
  transaction(() => {
    for (const [date, count] of dateCounts) {
      const m = meta.get(date) || {};
      stmt.upsertSnapshot.run(date, count, m.mtgjsonAsOf || null, m.builtAt || new Date().toISOString());
    }
  });

  checkpointAndOptimize();
  const dateList = [...dateCounts.keys()].sort();
  logger("migration complete: " + printingsSeen.toLocaleString() + " printings scanned, " +
    rowsWritten.toLocaleString() + " rows written across " + dateList.length + " dates");
  return {
    migrated: true, printingsSeen, rowsWritten, dates: dateList.length,
    first: dateList[0] || null, last: dateList[dateList.length - 1] || null
  };
}

async function status() {
  const dates = await availableDates();
  const nowDate = latestDateStr();
  return {
    snapshots: dates.length,
    first: dates[0] || null,
    last: dates[dates.length - 1] || null,
    printings: nowDate ? stmt.countForDate.get(nowDate).n : 0,
    keepDays: Math.max(30, Number(cfg.prices.keepDays) || 400),
    vendors: VENDOR_CODES,
    defaultVendor: DEFAULT_VENDOR
  };
}

function init(config, opts) {
  cfg = config;
  cfg.prices = cfg.prices || {};
  if (opts && opts.log) logger = opts.log;
  fs.mkdirSync(store.p("prices"), { recursive: true });
  openDb();
  // A (re)opened archive starts with no cached results from a previous one.
  clearSweepCache();
}

/* Real incident (2026-09-06): checkRestartRequest() (index.js) spawns the
   replacement process BEFORE this one actually exits, so there is a real
   window where both processes are alive at once. That was always true for
   the old flat-JSON-file archive with no consequence - a file gets
   read/written per call, nothing holds it open for the process's whole
   lifetime. A WAL-mode SQLite database is different: this process holds
   prices.db (and its -wal/-shm siblings) open continuously, and Windows'
   file locking is stricter than POSIX's advisory locking about two
   processes touching the same locked file - the respawned child's own
   openDb() failed outright with "disk I/O error" the first time this was
   actually hit in production. Explicit close() call, not just relying on
   the OS to release the handle whenever this process eventually exits. */
function closeDb() {
  try { if (db) { db.close(); db = null; } } catch (e) { logger("close on shutdown failed: " + (e.message || e)); }
}

/* The open archive handle, for server/lib/mpSales.js (#202). Its Manapool
   sales tables live in this same file, so there is still exactly one
   long-lived handle to release before a restart (closeDb() above). null
   while closed. */
function dbHandle() { return db; }

module.exports = {
  init, snapshot, movers, goldenCrosses, watchPrices, history, portfolio, status, backfillFromMtgjson, vendorPricesFor,
  migrateFromLegacyFiles, availableDates, latest, today, daysAgo, shiftDate, closeDb, dbHandle,
  VENDOR_CODES, DEFAULT_VENDOR,
  _ma: { medianOf, maPctOf, slidingMedian, windowMedian, MA_SPAN, dayNum, goldenCrossOf, CROSS_MAX_DAYS }
};
