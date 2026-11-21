"use strict";
/* Manapool sales history: "Selling fast" (#202, part A: server side).
   -------------------------------------------------------------------
   Manapool publishes no sales history, only `recent_sales`: the newest 20
   sales per variant (printing x condition x finish x language), each
   {created_at, price (cents), quantity}. The same data comes from two places:

     - the daily public catalog, singles.json.gz (no auth, ~222MB gzipped,
       ~1.4GB of JSON, every printing Manapool tracks), and
     - GET /products/singles (auth, <=100 scryfall_ids per call).

   So we build our own history from the day this shipped. Once a day
   refreshCatalog() STREAMS the catalog (one printing's JSON in memory at a
   time, never the file) and counts every sale it hasn't seen before into
   per-printing, per-day buckets. A sale is identified by (variant, sale
   DATE, price, quantity), so the overlap between consecutive snapshots (a
   slow seller shows the same sales for weeks) is never counted twice. The
   identities are kept as 64-bit hashes (mp_seen) only for sales inside the
   retention window; an older sale is ignored outright, so it can never be
   miscounted after its hash is pruned.

   #354: Manapool stamps every sale with its DATE only ("2026-10-22T00:00:00
   +00:00", midnight UTC). So:
     - a sale's day is that UTC date (saleDay), not the server's local day
       (local time put every sale on the day before);
     - two real sales of one variant on one date at the same price and
       quantity look identical, so identities are a multiset: mp_seen.n is
       how many of them we've seen, and a snapshot showing k of them adds
       k - n (an INSERT OR IGNORE counted only the first);
     - the identity hashes the start of that date, so a change in timestamp
       precision can't make every sale look new again (on 2026-10-17 one did,
       and every sale in the window was counted twice: repairHistory());
     - the read windows end on the date of the latest catalog (dataDay), not
       the wall clock: the catalog lands around 21:00 UTC with sales up to
       that date, so "today" always had nothing yet.

   The 20-sale cap: a variant showing 20 sales whose OLDEST is newer than the
   last time we looked may have sold more in between, and those sales are
   gone for good. Those days are flagged `capped` (the count is "at least
   N"). Fast-selling capped variants are remembered in mp_capped, and topup()
   re-polls the most overdue of them through the API every few hours (a
   bounded number of printings, and only when an admin's Manapool
   credentials are configured: otherwise collection is daily only, and
   sellingFast() says so). docs/flows/mp-sales.dot draws the lifecycle.

   Storage: tables in the price archive's SQLite file (prices.dbHandle()),
   so there is no second long-lived file handle to release before a restart.
   Retention is prices.mpSalesKeepDays (default 90) of daily buckets.

   Size (measured on the 2026-10-12 catalog): 106,643 printings, 97,344 with
   sales; 1.82M sales inside 90 days, 80,533 variants at the cap. One full
   pass took 42s and added ~130MB RSS; the tables came to ~110MB on disk. */

const crypto = require("crypto");
const zlib = require("zlib");
const { Readable } = require("stream");
const prices = require("./prices");
const integrations = require("./integrations");

const CAP = 20;                                  // Manapool's recent_sales limit per variant
const DEFAULT_CATALOG_URL = "https://storage.googleapis.com/manapool-prod-catalog/singles.json.gz";
const FAST_SPAN_MS = 3 * 86400000;               // a capped variant whose 20 sales span <= 3 days is a top-up candidate
const MAX_TRACKED = 5000;                        // capped variants remembered for top-up (fastest first)
const FLUSH_EVERY = 500;                         // printings per write transaction
const DAY_MS = 86400000;
const STALL_MS = 120000;                         // abort a catalog download that sends nothing for 2 minutes
const MAX_RUN_MS = 45 * 60000;                   // and any that runs longer than this
const HOT_MIN_HISTORY_DAYS = 14;                 // pace comparison needs this much history
const HOT_MIN_COPIES = 5;                        // ...and at least this many copies in the 7 days
const HOT_RATIO = 2;                             // 7-day pace at least this multiple of the baseline pace
const HOT_MIN_SALES = 3;                         // ...from at least this many separate sales (one bulk lot isn't a trend)
const DAYS_LEFT_MIN_SALES = 5;                   // days of listings left (#368) needs this many separate sales in 7 days
// #354 repair: the first sale date counted only once. The 2026-10-17 catalog
// changed how sales are stamped, and every sale up to then was counted again.
const RECOUNT_CLEAN_DAY = "2026-10-18";

let cfg = { prices: {} };
let logger = m => console.log("[mpSales] " + m);
let running = null;                              // "catalog" | "topup" | null
let abortCtl = null;
let topupMode = { enabled: false, reason: "Not checked yet." };
let cache = null;                                // { key, value }: today's ranking, computed once at MAX_LIMIT
let soldMemo = null;                             // { key, map }: soldFor()'s per-printing answers since the last ingest (#209)
let stopped = false;                             // set by stop() before a restart closes prices.db

function init(config, opts) {
  cfg = config || { prices: {} };
  cfg.prices = cfg.prices || {};
  if (opts && opts.log) logger = opts.log;
  stopped = false;
  cache = null;
  soldMemo = null;
}
function keepDays() { return Math.max(35, Number(cfg.prices.mpSalesKeepDays) || 90); }
function catalogUrl() { return cfg.prices.mpSalesCatalogUrl || DEFAULT_CATALOG_URL; }

/* ---------- Schema + statements (re-prepared whenever the archive reopens) ---------- */
let stDb = null;
let st = null;
function stmts() {
  const db = prices.dbHandle();
  if (!db) throw new Error("The price archive is not open.");
  if (db === stDb && st) { ensureRepaired(db); return st; }
  db.exec("CREATE TABLE IF NOT EXISTS mp_meta (k TEXT PRIMARY KEY, v TEXT)");
  db.exec(`CREATE TABLE IF NOT EXISTS mp_printings (
    pid INTEGER PRIMARY KEY, sid TEXT NOT NULL UNIQUE, name TEXT, set_code TEXT, number TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS mp_sale_days (
    pid INTEGER NOT NULL, day TEXT NOT NULL,
    copies INTEGER NOT NULL DEFAULT 0, sales INTEGER NOT NULL DEFAULT 0,
    capped INTEGER NOT NULL DEFAULT 0, avail INTEGER,
    PRIMARY KEY (pid, day)) WITHOUT ROWID`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_mp_sale_days_day ON mp_sale_days(day)");
  // n (#354): how many identical sales (same variant, date, price, quantity)
  // we've counted under this hash. Older archives lack it: each hash there
  // was counted once.
  db.exec("CREATE TABLE IF NOT EXISTS mp_seen (h INTEGER PRIMARY KEY, day INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 1)");
  if (!db.prepare("PRAGMA table_info(mp_seen)").all().some(c => c.name === "n")) {
    db.exec("ALTER TABLE mp_seen ADD COLUMN n INTEGER NOT NULL DEFAULT 1");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS mp_capped (
    variant TEXT PRIMARY KEY, pid INTEGER NOT NULL, oldest_ms INTEGER NOT NULL,
    seen_ms INTEGER NOT NULL, span_ms INTEGER NOT NULL, gap INTEGER NOT NULL) WITHOUT ROWID`);
  st = {
    db,
    getMeta: db.prepare("SELECT k, v FROM mp_meta"),
    setMeta: db.prepare("INSERT INTO mp_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
    upsertPrinting: db.prepare(`INSERT INTO mp_printings (sid, name, set_code, number) VALUES (?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET name = excluded.name, set_code = excluded.set_code, number = excluded.number
      RETURNING pid`),
    getSeen: db.prepare("SELECT n FROM mp_seen WHERE h = ?"),
    putSeen: db.prepare("INSERT INTO mp_seen (h, day, n) VALUES (?, ?, ?) ON CONFLICT(h) DO UPDATE SET n = excluded.n"),
    addDay: db.prepare(`INSERT INTO mp_sale_days (pid, day, copies, sales, capped, avail) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pid, day) DO UPDATE SET copies = copies + excluded.copies, sales = sales + excluded.sales,
        capped = MAX(capped, excluded.capped), avail = COALESCE(excluded.avail, avail)`),
    allCapped: db.prepare("SELECT variant, seen_ms FROM mp_capped"),
    clearCapped: db.prepare("DELETE FROM mp_capped"),
    putCapped: db.prepare(`INSERT INTO mp_capped (variant, pid, oldest_ms, seen_ms, span_ms, gap) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(variant) DO UPDATE SET pid = excluded.pid, oldest_ms = excluded.oldest_ms, seen_ms = excluded.seen_ms,
        span_ms = excluded.span_ms, gap = excluded.gap`),
    dropCapped: db.prepare("DELETE FROM mp_capped WHERE variant = ?"),
    candidates: db.prepare(`SELECT c.pid AS pid, p.sid AS sid, MAX(c.gap) AS gap,
        MAX((? - c.seen_ms) * 1.0 / c.span_ms) AS urgency
      FROM mp_capped c JOIN mp_printings p ON p.pid = c.pid
      GROUP BY c.pid HAVING MAX(c.gap) = 1 OR urgency >= 0.75
      ORDER BY MAX(c.gap) DESC, urgency DESC LIMIT ?`),
    pruneDays: db.prepare("DELETE FROM mp_sale_days WHERE day < ?"),
    pruneSeen: db.prepare("DELETE FROM mp_seen WHERE day < ?"),
    prunePrintings: db.prepare(`DELETE FROM mp_printings WHERE pid NOT IN (SELECT DISTINCT pid FROM mp_sale_days)
      AND pid NOT IN (SELECT pid FROM mp_capped)`),
    window: db.prepare(`SELECT p.pid AS pid, p.sid AS sid, p.name AS name, p.set_code AS setCode, p.number AS number,
        SUM(CASE WHEN d.day >= ? THEN d.copies ELSE 0 END) AS c7,
        SUM(CASE WHEN d.day >= ? THEN d.sales ELSE 0 END) AS s7,
        SUM(d.copies) AS c30, SUM(d.sales) AS s30,
        SUM(CASE WHEN d.day >= ? AND d.day < ? THEN d.sales ELSE 0 END) AS sBase,
        MAX(CASE WHEN d.day >= ? THEN d.capped ELSE 0 END) AS cap7,
        MAX(d.capped) AS cap30,
        MAX(CASE WHEN d.day = ? THEN d.avail END) AS availNow,
        MAX(CASE WHEN d.day = ? THEN d.avail END) AS availThen
      FROM mp_sale_days d JOIN mp_printings p ON p.pid = d.pid
      WHERE d.day >= ? AND d.day <= ? GROUP BY d.pid HAVING SUM(d.copies) > 0`),
    // #231: the same rows for just the cards a name search matched (a JSON
    // array of names; a printing with no name goes by its scryfall id, as in
    // rankAll). One pass over mp_printings, then its sale days by key.
    // CROSS JOIN pins that order: without planner stats SQLite would drive
    // from idx_mp_sale_days_day and walk the whole 30-day window instead
    // (~340 ms vs ~9 ms at 100k printings / 1.2M sale days).
    windowFor: db.prepare(`SELECT p.pid AS pid, p.sid AS sid, p.name AS name, p.set_code AS setCode, p.number AS number,
        SUM(CASE WHEN d.day >= ? THEN d.copies ELSE 0 END) AS c7,
        SUM(CASE WHEN d.day >= ? THEN d.sales ELSE 0 END) AS s7,
        SUM(d.copies) AS c30, SUM(d.sales) AS s30,
        SUM(CASE WHEN d.day >= ? AND d.day < ? THEN d.sales ELSE 0 END) AS sBase,
        MAX(CASE WHEN d.day >= ? THEN d.capped ELSE 0 END) AS cap7,
        MAX(d.capped) AS cap30,
        MAX(CASE WHEN d.day = ? THEN d.avail END) AS availNow,
        MAX(CASE WHEN d.day = ? THEN d.avail END) AS availThen
      FROM mp_printings p CROSS JOIN mp_sale_days d ON d.pid = p.pid AND d.day >= ? AND d.day <= ?
      WHERE COALESCE(p.name, p.sid) IN (SELECT value FROM json_each(?))
      GROUP BY p.pid HAVING SUM(d.copies) > 0`),
    // #209: the same 7-day and baseline sums for an explicit list of printings
    // (a JSON array of scryfall ids), joined in one query per chunk.
    soldFor: db.prepare(`SELECT p.sid AS sid, p.pid AS pid,
        SUM(CASE WHEN d.day >= ? THEN d.copies ELSE 0 END) AS c7,
        SUM(CASE WHEN d.day >= ? THEN d.sales ELSE 0 END) AS s7,
        SUM(CASE WHEN d.day >= ? AND d.day < ? THEN d.sales ELSE 0 END) AS sBase,
        MAX(CASE WHEN d.day >= ? THEN d.capped ELSE 0 END) AS cap7,
        MAX(CASE WHEN d.day = ? THEN d.avail END) AS availNow
      FROM json_each(?) j JOIN mp_printings p ON p.sid = j.value
      JOIN mp_sale_days d ON d.pid = p.pid AND d.day >= ? AND d.day <= ?
      GROUP BY p.pid`)
  };
  stDb = db;
  ensureRepaired(db);
  return st;
}
/* The #354 repair runs before anything else uses a freshly opened archive.
   Never inside someone else's transaction (an admin MTGJSON backfill holds
   one across awaits): then it waits, and every later stmts() call tries
   again until it has run. Until then beginRun() refuses to write, so new
   UTC-dated sales never land among the old local-day rows. */
let repairedDb = null;
function ensureRepaired(db) {
  if (repairedDb === db || db.isTransaction) return;
  repairHistory(db);
  repairedDb = db;
}

/* #354: one-time repair of an archive collected before the fixes in the
   header (mp_meta.saleDays absent). What it holds is wrong in two ways:
   1. Each sale sits on the server's local day of its midnight-UTC stamp: on
      a server west of UTC (production), the day BEFORE its real date. The
      sale counts move forward by that offset (avail stays put: it's read by
      mp_meta.lastAvailDay, which the snapshots wrote in local days).
   2. The 2026-10-17 catalog counted every sale up to then a second time
      (production log: 1,754,620 "new" sales in one run, ~45k on a normal
      day). Those days can't be split back into the real and the doubled
      counts, so their sale counts go and history restarts at
      RECOUNT_CLEAN_DAY: earlier dates read as "at least", like any time
      before history began.
   One transaction; on production's ~2.7M rows it took about 4 s once. An
   empty or new archive just gets the marker. `shift` is for tests. */
function repairHistory(db, shift) {
  const meta = {};
  for (const r of db.prepare("SELECT k, v FROM mp_meta").all()) meta[r.k] = r.v;
  if (meta.saleDays === "utc") return null;
  const k = shift == null ? daysBetween(localDay(Date.UTC(2026, 0, 15)), "2026-01-15") : shift;
  const since = meta.historySince || null;
  const clean = since && since < RECOUNT_CLEAN_DAY ? RECOUNT_CLEAN_DAY : null;
  const out = { shiftDays: since ? k : 0, cleanFrom: clean, moved: 0, dropped: 0 };
  const put = db.prepare("INSERT INTO mp_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  const hasSales = "(copies > 0 OR sales > 0 OR capped > 0)";
  db.exec("BEGIN");
  try {
    if (since && k) {
      // Only rows that survive step 2 are worth moving.
      const from = clean ? prices.shiftDate(clean, -k) : "0000-00-00";
      db.exec("DROP TABLE IF EXISTS temp.mp_fix");
      db.prepare(`CREATE TEMP TABLE mp_fix AS SELECT pid, date(day, ?) AS day, copies, sales, capped
        FROM mp_sale_days WHERE day >= ? AND ${hasSales}`).run((k > 0 ? "+" : "") + k + " days", from);
      db.prepare(`UPDATE mp_sale_days SET copies = 0, sales = 0, capped = 0 WHERE day >= ? AND ${hasSales}`).run(from);
      out.moved = Number(db.prepare(`INSERT INTO mp_sale_days (pid, day, copies, sales, capped, avail)
        SELECT pid, day, copies, sales, capped, NULL FROM mp_fix WHERE true
        ON CONFLICT(pid, day) DO UPDATE SET copies = excluded.copies, sales = excluded.sales, capped = excluded.capped`).run().changes);
      db.exec("DROP TABLE temp.mp_fix");
    }
    if (clean) {
      out.dropped = Number(db.prepare(`UPDATE mp_sale_days SET copies = 0, sales = 0, capped = 0 WHERE day < ? AND ${hasSales}`).run(clean).changes);
      put.run("historySince", clean);
    }
    if (since) db.exec("DELETE FROM mp_sale_days WHERE copies = 0 AND sales = 0 AND capped = 0 AND avail IS NULL");
    put.run("saleDays", "utc");
    put.run("repair354", JSON.stringify(out));
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
  cache = null;
  soldMemo = null;
  if (since) logger("repaired the sales history (#354): " + JSON.stringify(out));
  return out;
}

function readMeta() {
  const out = {};
  for (const r of stmts().getMeta.all()) out[r.k] = r.v;
  return out;
}
function setMeta(k, v) { stmts().setMeta.run(k, v == null ? null : String(v)); }

function txn(fn) {
  const db = stmts().db;
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
}

/* ---------- Small helpers ---------- */
function localDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// A sale's day: its UTC date, the date Manapool stamps it with (#354).
const saleDay = ms => new Date(ms).toISOString().slice(0, 10);
const dayInt = day => Number(day.slice(0, 4) + day.slice(5, 7) + day.slice(8, 10));
// The identity hashes the START of the sale's date, so the same sale stamped
// "2026-10-22T00:00:00+00:00" or with a time of day is the same sale (and
// date-only stamps hash exactly as they did before #354).
function saleHash(variant, day, price, qty) {
  return crypto.createHash("sha1").update(variant + "|" + Date.parse(day + "T00:00:00Z") + "|" + price + "|" + qty).digest().readBigInt64BE(0);
}
// The last date the windows cover: the latest catalog's date (it holds sales
// up to that date), never past today. Before any catalog, today.
function dataDay(meta, nowMs) {
  const today = saleDay(nowMs || Date.now());
  const last = Number(meta.lastCatalogMs) || 0;
  if (!last) return today;
  const d = saleDay(last);
  return d < today ? d : today;
}
function daysBetween(a, b) {   // whole days from YYYY-MM-DD a to b
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
}

/* ---------- One ingest pass (a catalog snapshot or a top-up poll) ----------
   beginRun() returns {add(single), flush(), finish(extraMeta)}. add() only
   queues; flush() writes the queued printings in ONE synchronous
   transaction. It never holds a transaction across an await, because this
   connection is shared with prices.js, whose own transaction() could
   otherwise interleave. */
function beginRun(kind, observedMs, opts) {
  const s = stmts();
  if (repairedDb !== s.db) throw new Error("the sales history repair (#354) is waiting for another transaction - nothing recorded, try again later");
  const o = opts || {};
  const meta = readMeta();
  const lastCatalogMs = Number(meta.lastCatalogMs) || 0;
  const prevSeen = new Map();
  for (const r of s.allCapped.all()) prevSeen.set(r.variant, Number(r.seen_ms));
  const today = saleDay(o.nowMs || Date.now());
  const cutoffDay = prices.shiftDate(today, -(keepDays() - 1));
  const tracked = new Map();                     // catalog runs: variant -> mp_capped row, written at finish()
  const stats = { kind, observedAt: new Date(observedMs).toISOString(), printings: 0, printingsWithSales: 0,
    salesInWindow: 0, newSales: 0, newCopies: 0, capped: 0, gaps: 0 };
  let pending = [];
  const run = { observedMs, stats, tracked };

  function ingestOne(single) {
    const sid = single.scryfall_id;
    if (!sid || !Array.isArray(single.variants)) return;
    const obs = run.observedMs;
    const days = new Map();                      // day -> {copies, sales, capped}
    const cappedRows = [];
    const dropRows = [];
    let newest = 0, any = false;
    const bump = (day, copies, sales, capped) => {
      let b = days.get(day);
      if (!b) days.set(day, b = { copies: 0, sales: 0, capped: 0 });
      b.copies += copies; b.sales += sales; if (capped) b.capped = 1;
    };
    for (const v of single.variants) {
      const sales = v && v.recent_sales;
      if (!Array.isArray(sales) || !sales.length) continue;
      any = true;
      const variant = v.product_id || (sid + "|" + v.language_id + "|" + v.condition_id + "|" + v.finish_id);
      let oldest = Infinity;
      const groups = new Map();                  // identical sales in this snapshot: "day|price|qty" -> {day, qty, k}
      for (const sale of sales) {
        const ms = Date.parse(sale && sale.created_at);
        if (!Number.isFinite(ms)) continue;
        if (ms < oldest) oldest = ms;
        if (ms > newest) newest = ms;
        const day = saleDay(ms);
        if (day < cutoffDay) continue;           // outside retention: never bucketed, never remembered
        stats.salesInWindow++;
        const qty = Math.max(0, Math.round(Number(sale.quantity) || 0));
        const price = Math.round(Number(sale.price) || 0);
        const key = day + "|" + price + "|" + qty;
        const g = groups.get(key);
        if (g) g.k++; else groups.set(key, { day, price, qty, k: 1 });
      }
      // k identical sales showing now, n of them counted before: k - n are new.
      for (const g of groups.values()) {
        const h = saleHash(variant, g.day, g.price, g.qty);
        const had = s.getSeen.get(h);
        const n = had ? Number(had.n) : 0;
        if (g.k <= n) continue;
        s.putSeen.run(h, dayInt(g.day), g.k);
        bump(g.day, g.qty * (g.k - n), g.k - n, 0);
        stats.newSales += g.k - n; stats.newCopies += g.qty * (g.k - n);
      }
      if (sales.length >= CAP && Number.isFinite(oldest)) {
        stats.capped++;
        // When did we last look at this variant? The last catalog, or a
        // later top-up of it. A first-ever look has nothing to compare to.
        // With date-only stamps (#354) a sale dated the day of the last look
        // may be from after it, so all 20 dated that day or later is a gap.
        const lastLook = Math.max(lastCatalogMs, prevSeen.get(variant) || 0);
        const after = oldest % DAY_MS === 0 ? saleDay(oldest) >= saleDay(lastLook) : oldest > lastLook;
        const gap = lastLook > 0 && lastLook < obs && after;
        if (gap) {
          stats.gaps++;
          // Sales between lastLook and `oldest` may be lost: flag those days.
          let day = saleDay(lastLook);
          const end = saleDay(oldest);
          if (day < cutoffDay) day = cutoffDay;
          for (let i = 0; day <= end && i <= keepDays(); i++, day = prices.shiftDate(day, 1)) bump(day, 0, 0, 1);
        }
        const span = Math.max(1, obs - oldest);
        if (span <= FAST_SPAN_MS) cappedRows.push({ variant, oldest, span, gap: gap ? 1 : 0 });
        else dropRows.push(variant);
      } else dropRows.push(variant);
    }
    stats.printings++;
    if (!any) return;
    stats.printingsWithSales++;
    // available_quantity (listed supply, all variants) - only for printings
    // that sold in the last week, the only ones the Selling fast view shows.
    const avail = kind === "catalog" && newest >= obs - 7 * DAY_MS && Number.isFinite(Number(single.available_quantity))
      ? Math.round(Number(single.available_quantity)) : null;
    if (avail != null) bump(saleDay(obs), 0, 0, 0);
    if (!days.size && !cappedRows.length) return;
    const pid = Number(s.upsertPrinting.get(sid, single.name || null, single.set_code || null, single.number || null).pid);
    const availDay = avail != null ? saleDay(obs) : null;
    for (const [day, b] of days) s.addDay.run(pid, day, b.copies, b.sales, b.capped, day === availDay ? avail : null);
    for (const c of cappedRows) {
      const row = { variant: c.variant, pid, oldest_ms: c.oldest, seen_ms: obs, span_ms: c.span, gap: c.gap };
      if (kind === "catalog") tracked.set(c.variant, row);
      else s.putCapped.run(row.variant, row.pid, row.oldest_ms, row.seen_ms, row.span_ms, row.gap);
    }
    if (kind !== "catalog") for (const v of dropRows) s.dropCapped.run(v);
    if (tracked.size > MAX_TRACKED * 2) trimTracked();
  }
  function trimTracked() {
    const keep = [...tracked.values()].sort((a, b) => b.gap - a.gap || a.span_ms - b.span_ms).slice(0, MAX_TRACKED);
    tracked.clear();
    for (const r of keep) tracked.set(r.variant, r);
  }

  // After stop() (a restart is about to close prices.db) every write is a
  // no-op and finish() throws, so a late decompressed chunk or API response
  // can't touch a closed handle; the job's promise rejects instead.
  run.add = single => { if (stopped) return; pending.push(single); if (pending.length >= FLUSH_EVERY) run.flush(); };
  run.flush = () => {
    if (stopped) { pending = []; return; }
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    txn(() => { for (const one of batch) ingestOne(one); });
  };
  run.finish = extraMeta => {
    if (stopped) throw new Error("stopped for a restart - nothing more recorded");
    run.flush();
    txn(() => {
      if (kind === "catalog") {
        trimTracked();
        s.clearCapped.run();
        for (const r of tracked.values()) s.putCapped.run(r.variant, r.pid, r.oldest_ms, r.seen_ms, r.span_ms, r.gap);
        if (observedMs > lastCatalogMs) setMeta("lastCatalogMs", observedMs);
        if (!meta.historySince) setMeta("historySince", saleDay(observedMs));
        setMeta("lastAvailDay", saleDay(observedMs));
      } else setMeta("lastTopupMs", observedMs);
      for (const [k, v] of Object.entries(extraMeta || {})) setMeta(k, v);
      setMeta("lastIngestMs", Date.now());
    });
    stats.trackedCapped = kind === "catalog" ? tracked.size : undefined;
    cache = null;
    soldMemo = null;
    return stats;
  };
  return run;
}

/* Drop buckets, sale identities and printings older than the retention
   window. A sale older than the cutoff is ignored on ingest, so forgetting
   its identity can't let it be counted again. Identities are kept two days
   longer than buckets: those written before #354 carry the local day, one
   day before the sale's date. */
function prune(todayDay) {
  const s = stmts();
  const cutoff = prices.shiftDate(todayDay || saleDay(Date.now()), -(keepDays() - 1));
  txn(() => {
    s.pruneDays.run(cutoff);
    s.pruneSeen.run(dayInt(prices.shiftDate(cutoff, -2)));
    s.prunePrintings.run();
  });
  cache = null;
  soldMemo = null;
  return { cutoff };
}

/* ---------- Streaming the catalog ----------
   singles.json.gz is {"data":[{printing}, {printing}, ...], "meta":{...}}.
   Finds `"data":[`, then hands each top-level element's raw JSON text to
   onText(text) and drops it, so memory is one printing (a few KB), not the
   file. Stops at the array's closing bracket.
   onText runs inside the stream's 'data' listener, where a throw (e.g. a
   SQLite write to a closed handle) would be an uncaught exception that kills
   the server. So anything it throws is caught here: the stream is destroyed
   and the promise rejects. */
function streamDataArray(readable, onText) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let inData = false, done = false;
    let pos = 0, depth = 0, inStr = false, esc = false, start = -1, count = 0;
    const fail = e => {
      if (done) return;
      done = true; buf = "";
      try { readable.destroy(); } catch (e2) {}
      reject(e);
    };
    readable.setEncoding("utf8");
    readable.on("data", chunk => {
      if (done) return;
      try { scan(chunk); } catch (e) { fail(e); }
    });
    function scan(chunk) {
      buf += chunk;
      if (!inData) {
        const m = /"data"\s*:\s*\[/.exec(buf);
        if (!m) { if (buf.length > 4096) buf = buf.slice(-4096); return; }
        buf = buf.slice(m.index + m[0].length);
        inData = true; pos = 0;
      }
      const n = buf.length;
      let i = pos;
      for (; i < n; i++) {
        const c = buf.charCodeAt(i);
        if (inStr) {
          if (esc) esc = false;
          else if (c === 92) esc = true;          // backslash
          else if (c === 34) inStr = false;       // "
          continue;
        }
        if (c === 34) { if (depth > 0) inStr = true; }
        else if (c === 123) { if (depth === 0) start = i; depth++; }      // {
        else if (c === 125) {                                             // }
          depth--;
          if (depth === 0 && start >= 0) {
            onText(buf.slice(start, i + 1));
            count++;
            start = -1;
          }
        } else if (c === 93 && depth === 0) { done = true; break; }       // ] closes the data array
      }
      if (done) { buf = ""; readable.destroy(); resolve({ count, complete: true }); return; }
      if (start >= 0) { buf = buf.slice(start); pos = i - start; start = 0; }
      else { buf = ""; pos = 0; }
    }
    const ended = () => { if (!done) { done = true; resolve({ count, complete: false }); } };
    readable.on("end", ended);
    readable.on("error", fail);
    readable.on("close", ended);
  });
}

/* ---------- The daily catalog job ---------- */
async function refreshCatalog(opts) {
  const o = opts || {};
  if (stopped) return { skipped: "stopping for a restart" };
  if (running) return { skipped: "already running (" + running + ")" };
  running = "catalog";
  const t0 = Date.now();
  const rss0 = process.memoryUsage().rss;
  let peakRss = rss0, peakHeap = process.memoryUsage().heapUsed;
  const sampler = setInterval(() => { const m = process.memoryUsage(); if (m.rss > peakRss) peakRss = m.rss; if (m.heapUsed > peakHeap) peakHeap = m.heapUsed; }, 500);
  sampler.unref();
  abortCtl = new AbortController();
  let stall = null;
  const armStall = () => { clearTimeout(stall); stall = setTimeout(() => abortCtl && abortCtl.abort(), STALL_MS); stall.unref(); };
  const hardStop = setTimeout(() => abortCtl && abortCtl.abort(), MAX_RUN_MS);
  hardStop.unref();
  let res = null, src = null, gz = null;
  try {
    const meta = readMeta();
    const headers = { "User-Agent": "Grimoire", Accept: "application/octet-stream" };
    if (!o.force && meta.catalogEtag) headers["If-None-Match"] = meta.catalogEtag;
    armStall();
    res = await (o.fetch || fetch)(catalogUrl(), { headers, signal: abortCtl.signal });
    if (res.status === 304) { logger("catalog unchanged since the last run - skipped"); return { skipped: "unchanged" }; }
    if (!res.ok || !res.body) throw new Error("catalog download returned HTTP " + res.status);
    const etag = res.headers.get("etag") || "";
    const lastMod = Date.parse(res.headers.get("last-modified") || "");
    const observedMs = Number.isFinite(lastMod) ? lastMod : Date.now();
    const run = beginRun("catalog", observedMs);
    src = Readable.fromWeb(res.body);
    gz = zlib.createGunzip();
    src.on("error", e => gz.destroy(e));
    src.on("data", armStall);
    src.pipe(gz);
    let bad = 0, parsed = 0;
    const scan = await streamDataArray(gz, text => {
      // A printing with no sale at all (~9% of them) is skipped unparsed.
      if (text.indexOf('"recent_sales":[{') < 0) return;
      let single;
      try { single = JSON.parse(text); } catch (e) { bad++; return; }
      parsed++;
      run.add(single);
    });
    const elements = scan.count;
    // A cut-off download must not stand in for a full snapshot: the cap
    // bookkeeping (last look, tracked variants) would be wrong. Sales already
    // counted are real and stay counted.
    if (!scan.complete || elements < 1000) {
      throw new Error("catalog looked truncated (" + elements + " printings, " + (scan.complete ? "complete" : "no end") +
        ") - not recorded as a snapshot");
    }
    const stats = run.finish({ catalogEtag: etag });
    prune();
    try { stmts().db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}
    Object.assign(stats, { catalogPrintings: elements, parsed, bad, durationMs: Date.now() - t0,
      startRssMb: Math.round(rss0 / 1048576), peakRssMb: Math.round(peakRss / 1048576), peakHeapMb: Math.round(peakHeap / 1048576) });
    setMeta("lastRun", JSON.stringify(stats));
    logger("catalog: " + elements + " printings, " + stats.newSales + " new sales (" + stats.newCopies + " copies), " +
      stats.capped + " variants at the cap, " + stats.gaps + " with a gap; " + Math.round(stats.durationMs / 1000) +
      "s, peak " + stats.peakRssMb + "MB");
    return stats;
  } finally {
    // Every path (success, 304, HTTP error, parse/write failure, stop())
    // closes the download: the streams, then the fetch and its socket.
    try { if (gz) gz.destroy(); } catch (e) {}
    try { if (src) src.destroy(); } catch (e) {}
    try { if (res && res.body && !src && !res.bodyUsed) await res.body.cancel(); } catch (e) {}
    try { abortCtl.abort(); } catch (e) {}
    clearInterval(sampler); clearTimeout(stall); clearTimeout(hardStop);
    abortCtl = null; running = null;
  }
}

/* ---------- Cap top-up ---------- */
/* Printings worth re-polling now, most urgent first, at most `max`: any with
   a capped variant that showed a gap at its last look, or whose 20 sales
   took less time than has passed since (so likely 20+ sales by now). */
function topupCandidates(nowMs, max) {
  return stmts().candidates.all(nowMs, Math.max(0, Math.floor(max))).map(r => ({ pid: Number(r.pid), sid: r.sid, gap: !!r.gap, urgency: r.urgency }));
}
function topupMax() { const n = Number(cfg.prices.mpSalesTopupMax); return Number.isFinite(n) && n >= 0 ? Math.min(n, 2000) : 300; }

async function topup(creds, opts) {
  const o = opts || {};
  if (stopped) return { skipped: "stopping for a restart" };
  if (running) return { skipped: "already running (" + running + ")" };
  const meta = readMeta();
  if (!meta.lastCatalogMs) return { skipped: "no catalog snapshot yet" };
  running = "topup";
  try {
    const nowMs = o.nowMs || Date.now();
    const pick = topupCandidates(nowMs, topupMax());
    const run = beginRun("topup", nowMs);
    if (pick.length) {
      await (o.lookup || integrations.manapoolLookupSingles)(creds, pick.map(p => p.sid), (asOf, rows) => {
        const ms = Date.parse(asOf || "");
        run.observedMs = Number.isFinite(ms) ? ms : Date.now();
        for (const r of rows) run.add(r);
        run.flush();
      });
    }
    const stats = run.finish({ lastTopupMs: nowMs });
    stats.polled = pick.length;
    setMeta("lastTopup", JSON.stringify(stats));
    if (pick.length) logger("top-up: " + pick.length + " printings re-polled, " + stats.newSales + " new sales, " + stats.gaps + " still capped with a gap");
    return stats;
  } finally { running = null; }
}

/* index.js tells us each job tick whether an admin's Manapool credentials
   are available, so the read API can say "daily only" honestly. */
function setTopupMode(enabled, reason) { topupMode = { enabled: !!enabled, reason: reason || "" }; }

/* Before a restart closes prices.db (checkRestartRequest, SIGINT/SIGTERM):
   from here on every write is a no-op, and an in-flight download is aborted.
   init() clears it (tests reopen the archive in the same process). */
function stop() {
  stopped = true;
  cache = null;
  soldMemo = null;
  try { if (abortCtl) abortCtl.abort(); } catch (e) {}
}
function busy() { return running; }

/* ---------- Read API: GET /api/prices/selling-fast ----------
   Cards rolled up by name, ranked by copies sold in the last 7 days, with
   per-printing detail. The 7 and 30 days end on the latest catalog's date
   (dataDay). `hot` = the 7-day pace is at least HOT_RATIO x the baseline
   pace (separate sales per day over the up to 23 days of history before
   the 7), with HOT_MIN_COPIES+ copies in HOT_MIN_SALES+ sales; null while
   there's under HOT_MIN_HISTORY_DAYS of history to compare against.

   Counts are minimums (`atLeast7` / `atLeast30`) when the window has a
   capped day (`capped7` / `capped30`: more may have sold than Manapool
   showed us) OR the window starts before our history does (coverage.windows:
   before historySince we only have whatever that first snapshot's last 20
   sales per variant reached back to).

   The ranking is computed once per day and ingest at MAX_LIMIT cards and
   sliced per request, so callers asking for different `limit`s share it.
   Bounded: at most MAX_LIMIT cards, 25 printings each, plus just the name
   of every other card that sold (#231's search), in rank order. */
const MAX_LIMIT = 500;
const SEARCH_MAX = 50;                           // #231: detailed cards per name search
function ranking(o) {
  const meta = readMeta();
  const today = dataDay(meta, o.nowMs);
  const coverage = coverageFor(meta, today);
  const key = today + "|" + (meta.lastIngestMs || "");
  if (!cache || cache.key !== key) cache = { key, value: rankAll(meta, today, coverage) };
  return { meta, today, coverage, v: cache.value };
}
/* #233: `offset` pages past the cached top list ("Show 500 more"): the cards
   ranked offset+1 .. offset+limit, at most MAX_LIMIT per request. Rows inside
   the cached top list are reused; the rest get their detail built on demand
   (detailFor), so the cache never holds full detail for the long tail. */
function sellingFast(opts) {
  const o = opts || {};
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(o.limit) || 100)));
  const { meta, today, coverage, v } = ranking(o);
  const offset = Math.min(v.total, Math.max(0, Math.floor(Number(o.offset) || 0)));
  const idx = [];
  for (let i = offset; i < Math.min(v.total, offset + limit); i++) idx.push(i);
  return { asOf: v.asOf, total: v.total, limit, offset, cards: detailFor(idx, meta, today, coverage, v), coverage };
}

/* Full card rows for the given indexes into the ranking (v.names), in that
   order, each with its overall `rank`. A card in the cached top list reuses
   its cached row; the rest are rolled up from one query over just their
   printings (windowFor), so no full detail is kept for the long tail.
   Shared by the name search (#231) and the offset pages (#233). */
function detailFor(idx, meta, today, coverage, v) {
  const extra = new Map();
  const outside = idx.filter(i => i >= v.cards.length).map(i => v.names[i]);
  let w = null;
  if (outside.length) {
    w = paceWindow(coverage, today);
    const availDay = meta.lastAvailDay || today;
    const rows = stmts().windowFor.all(w.d7, w.d7, w.dBase, w.d7, w.d7, availDay, prices.shiftDate(availDay, -7), w.d30, w.end, JSON.stringify(outside));
    for (const c of rollUp(rows, w).values()) extra.set(c.name, c);
  }
  const cards = [];
  for (const i of idx) {
    if (i < v.cards.length) { cards.push(v.cards[i]); continue; }
    const c = extra.get(v.names[i]);
    if (c && c.copies7 > 0) cards.push({ rank: i + 1, ...cardRow(c, w) });
  }
  return cards;
}

/* #231: a card name search across every card that sold in the last 7 days,
   not just the top MAX_LIMIT. Case-insensitive substring match against the
   cached name list; the best-selling SEARCH_MAX matches come back with the
   same fields as the top list, each with its overall `rank` (detailFor).
   `matched` counts every match, shown or not; `limit` is the top list's size. */
function sellingSearch(opts) {
  const o = opts || {};
  const q = String(o.q || "").trim().toLowerCase().slice(0, 100);
  const { meta, today, coverage, v } = ranking(o);
  const hits = [];
  let matched = 0;
  if (q) for (let i = 0; i < v.hay.length; i++) {
    if (!v.hay[i].includes(q)) continue;
    matched++;
    if (hits.length < SEARCH_MAX) hits.push(i);
  }
  const cards = detailFor(hits, meta, today, coverage, v);
  return { asOf: v.asOf, total: v.total, limit: v.cards.length, query: q, matched, searchMax: SEARCH_MAX, cards, coverage };
}

/* The windows both read paths share: 7-day start, the window end (the
   latest catalog's date, dataDay), whether the 7-day count is a minimum
   because history starts inside it, and the baseline: the days of history
   BEFORE the 7 days, up to 23 (so 7 + 23 = the 30-day window). #354: the
   baseline used to include the 7 days themselves, which made "2x usual"
   mean anything from "nothing sold the week before" (14 days of history)
   to ~2.9x (30 days). A pace comparison needs a full week before this one
   (HOT_MIN_HISTORY_DAYS).
   Paces count separate SALES, not copies: one buyer taking 601 copies of
   Holy Cow in a single sale made it "36x usual" by copies; by sales it's
   an ordinary week. Most sales are one copy, so elsewhere the two agree. */
function paceWindow(coverage, today) {
  const d7 = coverage.windows.d7.start;
  const baseDays = Math.max(0, Math.min(23, (coverage.historyDays || 0) - 7));
  return {
    d7, d30: coverage.windows.d30.start, end: today,
    open7: !coverage.windows.d7.complete, open30: !coverage.windows.d30.complete,
    baseDays, dBase: prices.shiftDate(d7, -baseDays),
    comparable: coverage.historyDays >= HOT_MIN_HISTORY_DAYS
  };
}
// The SELLING FAST rule: null while there's too little history to compare.
function hotFor(copies7, sales7, salesBase, w) {
  if (!w.comparable) return null;
  return copies7 >= HOT_MIN_COPIES && sales7 >= HOT_MIN_SALES && sales7 / 7 >= HOT_RATIO * (salesBase / w.baseDays);
}
// The pace fields a card row and each of its printings share (#223):
// sales per day over the 7 days vs over the baseline, their ratio (null
// with no baseline sales) and the SELLING FAST flag.
function paceFor(copies7, sales7, salesBase, w) {
  const pace7 = sales7 / 7, paceBase = w.baseDays ? salesBase / w.baseDays : 0;
  return { pace7: round2(pace7), paceBaseline: round2(paceBase),
    paceRatio: paceBase > 0 ? round2(pace7 / paceBase) : null, hot: hotFor(copies7, sales7, salesBase, w) };
}

/* Days of listings left (#368): the copies listed on Manapool now (every
   seller together) divided by the copies sold per day over the last 7 days.
   Copies over copies, since listed supply counts copies. Rounded to 0.1;
   null when supply is unknown or there were fewer than DAYS_LEFT_MIN_SALES
   separate sales (a pace from one or two sales says nothing). A capped
   count is a minimum, which makes this a maximum; the browser says so. */
function daysLeftFor(available, copies7, sales7) {
  if (available == null || !(sales7 >= DAYS_LEFT_MIN_SALES) || !(copies7 > 0)) return null;
  return Math.round(available / (copies7 / 7) * 10) / 10;
}

// Window rows (one per printing) rolled up into cards by name.
function rollUp(rows, w) {
  const { open7, open30 } = w;
  const byName = new Map();
  for (const r of rows) {
    const name = r.name || r.sid;
    let card = byName.get(name);
    if (!card) byName.set(name, card = { name, copies7: 0, sales7: 0, copies30: 0, sales30: 0, salesBase: 0, capped7: false, capped30: false, printings: [] });
    card.copies7 += r.c7; card.sales7 += r.s7; card.copies30 += r.c30; card.sales30 += r.s30; card.salesBase += r.sBase;
    if (r.cap7) card.capped7 = true;
    if (r.cap30) card.capped30 = true;
    card.printings.push({ scryfallId: r.sid, set: r.setCode, number: r.number, copies7: r.c7, sales7: r.s7,
      copies30: r.c30, sales30: r.s30, salesBase: r.sBase, capped7: !!r.cap7, capped30: !!r.cap30,
      atLeast7: !!r.cap7 || open7, atLeast30: !!r.cap30 || open30,
      available: r.availNow == null ? null : r.availNow, available7DaysAgo: r.availThen == null ? null : r.availThen,
      daysLeft: daysLeftFor(r.availNow, r.c7, r.s7) });
  }
  return byName;
}
// One rolled-up card as the API sends it: at most 25 printings, best sellers first.
function cardRow(c, w) {
  const { open7, open30, baseDays } = w;
  const printings = c.printings.sort((a, b) => b.copies7 - a.copies7 || b.copies30 - a.copies30);
  return {
    name: c.name, copies7: c.copies7, sales7: c.sales7, copies30: c.copies30, sales30: c.sales30,
    capped7: c.capped7, capped30: c.capped30,
    atLeast7: c.capped7 || open7, atLeast30: c.capped30 || open30,
    ...paceFor(c.copies7, c.sales7, c.salesBase, w), baselineDays: baseDays,
    printingCount: printings.length,
    // #223: each shown printing gets the same pace and SELLING FAST fields as its card.
    printings: printings.slice(0, 25).map(({ salesBase, ...p }) => ({ ...p, ...paceFor(p.copies7, p.sales7, salesBase, w) }))
  };
}

function rankAll(meta, today, coverage) {
  const w = paceWindow(coverage, today);
  const availDay = meta.lastAvailDay || today;
  const rows = stmts().window.all(w.d7, w.d7, w.dBase, w.d7, w.d7, availDay, prices.shiftDate(availDay, -7), w.d30, w.end);
  const cards = [...rollUp(rows, w).values()].filter(c => c.copies7 > 0)
    .sort((a, b) => b.copies7 - a.copies7 || b.copies30 - a.copies30 || (a.name < b.name ? -1 : 1));
  const names = cards.map(c => c.name);
  return { asOf: today, total: cards.length, names, hay: names.map(n => n.toLowerCase()),
    cards: cards.slice(0, MAX_LIMIT).map((c, i) => ({ rank: i + 1, ...cardRow(c, w) })) };
}
const round2 = n => Math.round(n * 100) / 100;

/* ---------- Read API: Sold 7d on the Movers table's rows (#209) ----------
   soldFor(sids) answers "copies sold on Manapool in the last 7 days" for an
   explicit list of printings (scryfall ids): one query per LOOKUP_CHUNK ids,
   never one per row, and only the printings asked about are read (their
   baseline days at most, via mp_sale_days' (pid, day) key). Same windows,
   "at least" rule and SELLING FAST rule as sellingFast() above.

   Answers are memoised per printing (soldMemo) until the next ingest or
   the next day, like sellingFast()'s ranking: every Movers request asks
   for the same catalog-wide sweep rows, so only the first one of the day
   pays for the query. The memo can't outlive the data: any ingest (catalog
   or top-up), prune or stop() drops it, so a Movers row never shows
   yesterday's sales, whatever the price sweep cache (keyed on the price
   snapshot date) still holds. Bounded: SOLD_MEMO_MAX printings, one small
   entry each (a miss is stored as null), cleared whole when full. */
const LOOKUP_CHUNK = 5000;
const SOLD_MEMO_MAX = 200000;                    // > every printing Manapool lists (~107k) or the card index's English printings
function soldFor(sids, opts) {
  const o = opts || {};
  const meta = readMeta();
  const today = dataDay(meta, o.nowMs);
  const coverage = coverageFor(meta, today);
  const w = paceWindow(coverage, today);
  const bySid = new Map();
  if (!coverage.historySince) return { bySid, coverage, window: w };
  const key = today + "|" + (meta.lastIngestMs || "");
  if (!soldMemo || soldMemo.key !== key) soldMemo = { key, map: new Map() };
  const memo = soldMemo.map;
  const ids = [...new Set((sids || []).filter(Boolean))];
  const want = ids.filter(id => !memo.has(id));
  if (want.length) {
    if (memo.size + want.length > SOLD_MEMO_MAX) memo.clear();
    const s = stmts();
    const from = w.dBase < w.d7 ? w.dBase : w.d7;
    const availDay = meta.lastAvailDay || today;
    for (let i = 0; i < want.length; i += LOOKUP_CHUNK) {
      for (const r of s.soldFor.all(w.d7, w.d7, w.dBase, w.d7, w.d7, availDay, JSON.stringify(want.slice(i, i + LOOKUP_CHUNK)), from, w.end)) {
        memo.set(r.sid, { pid: r.pid, copies7: r.c7, sales7: r.s7, salesBase: r.sBase, atLeast7: !!r.cap7 || w.open7, hot: hotFor(r.c7, r.s7, r.sBase, w),
          available: r.availNow == null ? null : r.availNow, daysLeft: daysLeftFor(r.availNow, r.c7, r.s7) });
      }
    }
    for (const id of want) if (!memo.has(id)) memo.set(id, null);
  }
  for (const id of ids) { const v = memo.get(id); if (v) bySid.set(id, v); }
  return { bySid, coverage, window: w };
}

/* Copies of every row with its printing's sales attached (the rows may be
   shared cache objects, so they're never mutated). sidOf(row) -> scryfall
   id or null. A printing with history but no sale in the window sold 0;
   sold7d is null only when there's no history yet or the row couldn't be
   matched to a printing. Manapool counts per printing, so every finish,
   condition and language row of one printing carries the same number:
   `mpId` (our small mp_printings number - a scryfall id per row would add
   ~1MB of incompressible text to a 25k-row response) lets a roll-up count
   it once. A row with no sales on record has none: it adds 0 anyway. */
function attachSold(rows, sidOf, opts) {
  const sids = rows.map(r => sidOf(r) || null);
  const { bySid, coverage, window: w } = soldFor(sids, opts);
  const has = !!coverage.historySince;
  const out = rows.map((r, i) => {
    const sid = sids[i];
    // Object spread, not Object.assign({}, ...): on 25k real rows the spread
    // copies came out about half the cost to build and to JSON-encode.
    if (!has || !sid) return { ...r, mpId: null, sold7d: null, soldSales7: null, soldBase: null, sold7dAtLeast: false, sellingFast: null };
    const x = bySid.get(sid);
    return x
      ? { ...r, mpId: x.pid, sold7d: x.copies7, soldSales7: x.sales7, soldBase: x.salesBase, sold7dAtLeast: x.atLeast7, sellingFast: x.hot }
      : { ...r, mpId: null, sold7d: 0, soldSales7: 0, soldBase: 0, sold7dAtLeast: w.open7, sellingFast: hotFor(0, 0, 0, w) };
  });
  return { rows: out, sales: salesInfo(coverage, w) };
}
// What a Sold 7d column needs to explain itself: how much history there is,
// and the SELLING FAST rule, so a roll-up can re-apply it to its sums.
function salesInfo(coverage, w) {
  return {
    source: "manapool", sourceNote: coverage.sourceNote,
    historySince: coverage.historySince, historyDays: coverage.historyDays, dataThrough: coverage.dataThrough,
    window7Complete: coverage.window7Complete, baselineDays: w.baseDays, comparable: w.comparable,
    hotNeedsDays: HOT_MIN_HISTORY_DAYS, hotRatio: HOT_RATIO, hotMinCopies: HOT_MIN_COPIES, hotMinSales: HOT_MIN_SALES, hotRule: coverage.hotRule,
    daysLeftMinSales: DAYS_LEFT_MIN_SALES
  };
}

/* Sold 7d on an account's own stock (#366): soldFor() for a list of
   { key, sid }, where key is whatever the browser can rebuild from its own
   stacks (the route uses "set|collector"). Sent back compact, since a big
   account holds tens of thousands of printings and most sold nothing this
   week: `sold` has only the printings that sold, as [copies, atLeast 0/1,
   SELLING FAST true/false/null], plus [days of listings left, copies listed
   now] when there's a days-left estimate (#368); `unmatched` the keys no printing was found
   for. Every other key sold 0: a minimum while the 7-day window isn't full
   (sales.window7Complete), never SELLING FAST, and null while the flag
   can't compare yet (sales.comparable). No history at all: both empty. */
function soldByKey(items, opts) {
  const { bySid, coverage, window: w } = soldFor(items.map(i => i.sid), opts);
  const sold = {}, unmatched = [];
  if (coverage.historySince) {
    for (const it of items) {
      if (!it.sid) { unmatched.push(it.key); continue; }
      const x = bySid.get(it.sid);
      if (x && (x.copies7 > 0 || x.hot)) sold[it.key] = x.daysLeft == null ? [x.copies7, x.atLeast7 ? 1 : 0, x.hot]
        : [x.copies7, x.atLeast7 ? 1 : 0, x.hot, x.daysLeft, x.available];
    }
  }
  return { sold, unmatched, sales: salesInfo(coverage, w) };
}
/* Restock hints on the Buy List (#370). The browser sends what the account
   sold before or has customers wanting and now has none of: printings as
   { key, sid, name } (name is the card's, for its rank) and card names
   (an any-printing want) as { key, name }. Back come only the ones worth
   buying again: SELLING FAST, or the card ranks in this week's top
   RESTOCK_TOP_N by copies sold (a printing must also have sold this week
   itself, or a card's long tail of rare printings would all qualify).
     prints[key] = [copies7, atLeast 0/1, hot, rank or null]
     names[key]  = [copies7, atLeast 0/1, hot, rank, best-selling printing's sid]
   A name is the whole card: every printing's sales and the card's own flag,
   as the Selling fast tab shows it. Same windows and SELLING FAST rule as
   everything above; hot is null while it's too early to compare
   (sales.comparable). Bounded: one soldFor() lookup for the printings
   (memoised per printing), ranks from a name index built once per ranking,
   and one detailFor() query for names outside the cached top list. */
const RESTOCK_TOP_N = 100;
function rankIndex(v) {
  if (!v.rankOf) {
    const m = new Map();
    v.hay.forEach((n, i) => { if (!m.has(n)) m.set(n, i); });
    // A two-faced card also answers to its front face ("Fire // Ice" -> "fire").
    v.hay.forEach((n, i) => { const f = n.split(" // ")[0].trim(); if (!m.has(f)) m.set(f, i); });
    v.rankOf = m;
  }
  return v.rankOf;
}
function rankIdx(m, name) {
  const k = String(name || "").trim().toLowerCase();
  if (!k) return null;
  const i = m.has(k) ? m.get(k) : m.get(k.split(" // ")[0].trim());
  return i == null ? null : i;
}
function restockFor(prints, names, opts) {
  const o = opts || {};
  const { meta, today, coverage, v } = ranking(o);
  const { bySid, window: w } = soldFor((prints || []).map(p => p.sid), o);
  const out = { topN: RESTOCK_TOP_N, prints: {}, names: {}, sales: salesInfo(coverage, w) };
  if (!coverage.historySince) return out;
  const idx = rankIndex(v);
  for (const p of prints || []) {
    const x = p.sid ? bySid.get(p.sid) : null;
    if (!x || !(x.copies7 > 0)) continue;
    const i = rankIdx(idx, p.name), rank = i == null ? null : i + 1;
    if (x.hot === true || (rank != null && rank <= RESTOCK_TOP_N)) out.prints[p.key] = [x.copies7, x.atLeast7 ? 1 : 0, x.hot, rank];
  }
  const want = [];
  for (const n of names || []) { const i = rankIdx(idx, n.name); if (i != null) want.push([n.key, i]); }
  const outside = [...new Set(want.map(([, i]) => i).filter(i => i >= v.cards.length))];
  const extra = new Map();
  if (outside.length) for (const c of detailFor(outside, meta, today, coverage, v)) extra.set(c.rank - 1, c);
  for (const [key, i] of want) {
    const c = i < v.cards.length ? v.cards[i] : extra.get(i);
    if (!c || !(c.hot === true || i < RESTOCK_TOP_N)) continue;
    out.names[key] = [c.copies7, c.atLeast7 ? 1 : 0, c.hot, i + 1, (c.printings[0] && c.printings[0].scryfallId) || null];
  }
  return out;
}

// Changes whenever soldFor()'s answers can: a new day or any ingest. The
// route keys its per-account cache on it.
function dataKey(opts) {
  const meta = readMeta();
  return dataDay(meta, opts && opts.nowMs) + "|" + (meta.lastIngestMs || "");
}

function coverageFor(meta, today) {
  const since = meta.historySince || null;
  const historyDays = since ? Math.max(0, daysBetween(since, today) + 1) : 0;
  // A window is complete when our history began on or before its first day.
  const win = days => {
    const start = prices.shiftDate(today, -(days - 1));
    const complete = !!since && since <= start;
    return { days, start, complete, countsAreMinimums: !complete };
  };
  const d7 = win(7), d30 = win(30);
  return {
    source: "manapool",
    sourceNote: "Manapool sales only",
    historySince: since,
    historyDays,
    // #354: the windows end here (the latest catalog's date), not on the
    // wall-clock day; a stale catalog shows as an older date.
    dataThrough: today,
    windows: { d7, d30 },
    window7Complete: d7.complete,
    window30Complete: d30.complete,
    // #354: after the repair there is almost nothing before historySince,
    // so this no longer promises "each version's last 20 sales".
    windowNote: "History starts " + (since || "with the first daily pull") + "; there's little or no sales history before that, " +
      "so a window starting earlier is a minimum (atLeast).",
    hotNeedsDays: HOT_MIN_HISTORY_DAYS,
    hotRule: "separate sales in the last 7 days came at least " + HOT_RATIO + "x as fast as in the days before, with " +
      HOT_MIN_COPIES + "+ copies from " + HOT_MIN_SALES + "+ sales",
    daysLeftMinSales: DAYS_LEFT_MIN_SALES,
    capNote: "Manapool shows only the last " + CAP + " sales of each version of a card; where more may have sold between our checks the count is a minimum (atLeast).",
    keepDays: keepDays(),
    lastCatalogAt: meta.lastCatalogMs ? new Date(Number(meta.lastCatalogMs)).toISOString() : null,
    lastTopupAt: meta.lastTopupMs ? new Date(Number(meta.lastTopupMs)).toISOString() : null,
    topup: { enabled: topupMode.enabled, reason: topupMode.reason },
    running: running
  };
}

function status() {
  const meta = readMeta();
  let lastRun = null, lastTopup = null;
  try { lastRun = meta.lastRun ? JSON.parse(meta.lastRun) : null; } catch (e) {}
  try { lastTopup = meta.lastTopup ? JSON.parse(meta.lastTopup) : null; } catch (e) {}
  return { running, lastRun, lastTopup, coverage: coverageFor(meta, dataDay(meta)) };
}

module.exports = {
  init, refreshCatalog, topup, topupCandidates, setTopupMode, sellingFast, sellingSearch, soldFor, attachSold, soldByKey, restockFor, RESTOCK_TOP_N, dataKey, daysLeftFor, status, prune, stop, busy,
  // exposed for tests
  beginRun, streamDataArray, localDay, saleDay, repairHistory, CAP, RECOUNT_CLEAN_DAY
};
