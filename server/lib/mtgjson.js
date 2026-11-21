"use strict";
/* MTGJSON price data.
   --------------------
   Two files from https://mtgjson.com/downloads/all-files/, both keyed by
   MTGJSON's own `uuid` (not a Scryfall id, not a set+collector pair):

     AllPricesToday.json.gz  ~4.6MB compressed - today's price only, every
                              vendor, every finish. Small enough to download
                              and JSON.parse whole, every day.
     AllPrices.json.gz       ~147MB compressed / ~1GB+ decompressed - a
                              rolling 90-day history per vendor. Downloaded
                              only for the one-time archive backfill
                              (mtgjson.backfill below), streamed and never
                              written to disk whole - same reasoning that
                              killed permanently caching Manapool's full
                              catalog file (see integrations.js): a file this
                              size sitting on disk forever buys nothing a
                              much smaller derived result doesn't already
                              cover.

   Neither file carries a Scryfall id or a set/collector/language directly -
   that join lives in a THIRD file, AllIdentifiers.json.gz (~229MB
   compressed), which maps uuid -> {scryfallId, tcgplayerProductId, ...}.
   Same treatment: streamed once, trimmed to the two fields this app
   actually needs, and only THAT trimmed result is kept on disk
   (mtgjson/ids.ndjson) - never the raw file.

   Card data model: https://mtgjson.com/data-models/price/price-formats/
     data[uuid].paper.<vendor>.<retail|buylist>.<normal|foil|etched>.<date> = number
   vendor is one of tcgplayer/cardkingdom/cardmarket/cardsphere for paper.
   cardmarket prices are EUR, not USD - carried through as-is, never
   converted (no FX feed in this app), and labeled EUR wherever shown. */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");
const store = require("./store");

const BASE = "https://mtgjson.com/api/v5/";
const VERSION = "0.8";

// vendor code -> MTGJSON's own key under data[uuid].paper. MTGJSON's own
// published data model docs (mtgjson.com/data-models/price/price-formats/)
// list only tcgplayer/cardkingdom/cardmarket/cardsphere under `paper` -
// "manapool" is missing from that page but is very much present in the real
// data (confirmed directly against a live AllPricesToday.json download,
// 2026-09-02: 99,766 of 108,608 entries carry a paper.manapool block, same
// PriceList shape as every other vendor, ~92% coverage matching Manapool's
// own directly-observed in-stock coverage from BACKLOG.md #23). Trust the
// live file over the docs page here - this was found by a direct user
// report after the docs-only check above missed it.
const VENDORS = { tcg: "tcgplayer", ck: "cardkingdom", cm: "cardmarket", cs: "cardsphere", mp: "manapool" };
const VENDOR_CODES = Object.keys(VENDORS);
// PricePoints field -> Grimoire finish name
const FINISHES = { normal: "nonfoil", foil: "foil", etched: "etched" };

let cfg = { mtgjson: {} };
let userAgent = "Grimoire/" + VERSION;
let logger = m => console.log("[mtgjson] " + m);
function log(msg) { logger(msg); }

const idsFile = () => store.p("cards", "mtgjson-ids.ndjson");
const idsMetaFile = () => store.p("cards", "mtgjson-ids-meta.json");

const state = {
  idsReady: false, idsBuilding: false, idsUpdatedAt: null, idsBuiltAt: null, idsCount: 0, idsError: null,
  backfillRunning: false, backfillProgress: "", backfillError: null, backfillDone: null
};

let byScryfall = new Map();   // scryfallId -> tcgplayerProductId (identity join for sealed - see identifiersToLocal)
let sc2tcg = new Map();       // kept for clarity/name symmetry with the map above
let scryfallByUuid = new Map();     // uuid -> scryfallId, transient during a pass, not kept resident
let tcgByUuid = new Map();          // uuid -> tcgplayerProductId, transient during a pass

/* ---------- HTTP ---------- */
async function mtgFetch(url) {
  const r = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/octet-stream" } });
  if (!r.ok || !r.body) throw new Error("MTGJSON request to " + url + " returned HTTP " + (r ? r.status : "?"));
  return r;
}
function gunzipStream(webBody) {
  const src = Readable.fromWeb(webBody);
  const gz = zlib.createGunzip();
  src.on("error", e => gz.destroy(e));
  src.pipe(gz);
  return gz;
}

/* ---------- Streaming scan of a top-level {"...": {value}, ...} object ----------
   Purpose-built for AllIdentifiers.json / AllPrices.json's shape:
   {"meta": {...}, "data": {"<uuid>": {...deeply nested...}, "<uuid>": {...}}}.
   Skips everything before `"data":{`, then for each entry at that depth reads
   the quoted key and the matching-brace value object, hands the parsed value
   to onEntry(key, value), and drops the consumed text from the buffer so
   memory stays bounded by one entry's size, not the whole file's. Mirrors
   cards.js's streamJsonArray() (same problem, one level of object nesting
   deeper - a keyed object instead of a bare array). */
function streamJsonObjectEntries(readable, onEntry) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let seenDataStart = false;
    let depth = 0;          // brace depth once inside the "data" object; 0 = looking for the next "key":{ pair
    let count = 0;
    let scanFrom = 0;

    function findDataStart(s) {
      const m = /"data"\s*:\s*\{/.exec(s);
      return m ? m.index + m[0].length : -1;
    }

    readable.setEncoding("utf8");
    readable.on("data", chunk => {
      buf += chunk;
      if (!seenDataStart) {
        const at = findDataStart(buf);
        if (at < 0) {
          // Keep only a small tail in case the marker straddles a chunk boundary.
          if (buf.length > 4096) buf = buf.slice(buf.length - 4096);
          return;
        }
        buf = buf.slice(at);
        seenDataStart = true;
        scanFrom = 0;
      }

      for (;;) {
        // Find the next quoted key at the top of the data object (depth 0 here).
        const keyMatch = /"((?:[^"\\]|\\.)*)"\s*:\s*\{/.exec(buf.slice(scanFrom));
        if (!keyMatch) {
          if (scanFrom > 0) { buf = buf.slice(scanFrom); scanFrom = 0; }
          break;
        }
        const keyStart = scanFrom + keyMatch.index;
        const valueOpenBrace = keyStart + keyMatch[0].length - 1; // index of the "{"
        // Walk forward from the opening brace to find its matching close,
        // respecting string/escape state so a brace inside a string value
        // doesn't miscount.
        let d = 0, inStr = false, escaped = false, i = valueOpenBrace, closeAt = -1;
        for (; i < buf.length; i++) {
          const ch = buf[i];
          if (inStr) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === "{") d++;
          else if (ch === "}") { d--; if (d === 0) { closeAt = i; break; } }
        }
        if (closeAt < 0) {
          // Value object isn't fully buffered yet - wait for more data, but
          // don't rescan the part already confirmed to be just the key.
          scanFrom = keyStart;
          break;
        }
        const key = keyMatch[1];
        const text = buf.slice(valueOpenBrace, closeAt + 1);
        try { onEntry(key, JSON.parse(text)); count++; } catch (e) { /* skip one bad entry */ }
        scanFrom = closeAt + 1;
        // A comma or the outer object's closing brace follows - either way,
        // resuming the search right after the value is correct.
        if (scanFrom - 0 > 2_000_000) { buf = buf.slice(scanFrom); scanFrom = 0; }
      }
    });
    readable.on("end", () => resolve(count));
    readable.on("error", reject);
  });
}

/* ---------- uuid -> {scryfallId, tcgplayerProductId} ----------
   AllIdentifiers.json.gz is huge (~229MB compressed) for what this app
   needs out of it (two short id strings per printing) - streamed once,
   trimmed hard, and only the trimmed NDJSON is kept on disk. Re-run
   whenever the card catalog itself is refreshed (server/index.js's daily
   job loop) rather than on its own schedule - set/printing data doesn't
   churn faster than that. */
async function refreshIdentifiers(opts) {
  const force = !!(opts && opts.force);
  if (state.idsBuilding) return { skipped: "already building" };
  state.idsBuilding = true;
  state.idsError = null;
  try {
    // A cheap HEAD first: MTGJSON doesn't expose a small "has this changed"
    // endpoint the way Scryfall's /bulk-data does, but ETag/Last-Modified on
    // the file itself serves the same purpose without downloading anything.
    const head = await fetch(BASE + "AllIdentifiers.json.gz", { method: "HEAD", headers: { "User-Agent": userAgent } });
    const tag = (head.headers.get("etag") || "") + "|" + (head.headers.get("last-modified") || "");
    const meta = await store.readJson(idsMetaFile(), null);
    if (!force && meta && meta.tag === tag && meta.count > 0) {
      state.idsReady = true; state.idsUpdatedAt = meta.updatedAt; state.idsBuiltAt = meta.builtAt; state.idsCount = meta.count;
      log("identifier map unchanged (" + meta.count.toLocaleString() + " entries) - keeping the cache");
      return { skipped: "unchanged", count: meta.count };
    }

    log("downloading AllIdentifiers.json.gz (~229MB compressed) to rebuild the uuid->scryfallId map");
    const res = await mtgFetch(BASE + "AllIdentifiers.json.gz");
    const stream = gunzipStream(res.body);

    const tmp = store.p("tmp", "mtgjson-ids.building.ndjson");
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    const out = fs.createWriteStream(tmp, { encoding: "utf8" });
    let n = 0, kept = 0;
    const writeQueue = [];
    await streamJsonObjectEntries(stream, (uuid, obj) => {
      n++;
      const ids = obj && obj.identifiers ? obj.identifiers : obj; // tolerate either shape
      const scryfallId = ids && ids.scryfallId ? String(ids.scryfallId) : "";
      const tcgplayerProductId = ids && ids.tcgplayerProductId ? String(ids.tcgplayerProductId) : "";
      if (!scryfallId && !tcgplayerProductId) return;
      kept++;
      const line = JSON.stringify({ u: uuid, s: scryfallId || undefined, t: tcgplayerProductId || undefined }) + "\n";
      if (!out.write(line)) writeQueue.push(new Promise(r => out.once("drain", r)));
      if (n % 200000 === 0) log("  scanned " + n.toLocaleString() + " identifiers, kept " + kept.toLocaleString());
    });
    await Promise.all(writeQueue);
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    if (!kept) throw new Error("AllIdentifiers.json yielded no usable rows - the format may have changed");

    await store.renameWithRetry(tmp, idsFile());
    const builtAt = new Date().toISOString();
    await store.writeJson(idsMetaFile(), { tag, updatedAt: head.headers.get("last-modified") || builtAt, builtAt, count: kept });
    state.idsReady = true; state.idsUpdatedAt = head.headers.get("last-modified") || builtAt; state.idsBuiltAt = builtAt; state.idsCount = kept;
    log("identifier map ready: " + kept.toLocaleString() + " printings (of " + n.toLocaleString() + " scanned)");
    return { ok: true, count: kept };
  } catch (e) {
    state.idsError = e.message || String(e);
    log("identifier refresh FAILED: " + state.idsError);
    throw e;
  } finally {
    state.idsBuilding = false;
  }
}

/* Loads the trimmed id map from disk into the two transient uuid-keyed Maps
   above. Cheap (tens of MB, not hundreds) - re-read on demand rather than
   held resident all the time, since it's only needed while pricesToday()/
   backfill() are actually running. */
async function loadIdMaps() {
  scryfallByUuid = new Map();
  tcgByUuid = new Map();
  let text;
  try { text = await fsp.readFile(idsFile(), "utf8"); }
  catch (e) { return; }
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec.s) scryfallByUuid.set(rec.u, rec.s);
      if (rec.t) tcgByUuid.set(rec.u, rec.t);
    } catch (e) {}
  }
}

/* ---------- Shared price-object extraction ----------
   data[uuid].paper.<vendor>.retail.<normal|foil|etched>[date] -> number.
   Returns { tcg: [normal, foil, etched], ck: [...], cm: [...], cs: [...] }
   for ONE specific date, or null slots where that vendor/finish/date has no
   price - same "missing = null, not zero" convention prices.js already
   uses everywhere. `dateOrLatest` is either an exact "YYYY-MM-DD" (used by
   backfill, which knows the date it's asking about) or null (used by
   pricesToday, which just wants whatever single date is present). */
function extractPaper(entry, dateOrLatest) {
  const paper = entry && entry.paper;
  if (!paper) return null;
  const out = {};
  let any = false;
  for (const code of VENDOR_CODES) {
    const v = paper[VENDORS[code]];
    const retail = v && v.retail;
    if (!retail) continue;
    const row = [null, null, null];
    let vAny = false;
    let i = 0;
    for (const field of Object.keys(FINISHES)) {
      const points = retail[field];
      if (points) {
        const date = dateOrLatest || Object.keys(points).sort().pop();
        const p = date ? points[date] : null;
        if (p != null) { row[i] = Number(p); vAny = true; }
      }
      i++;
    }
    if (vAny) { out[code] = row; any = true; }
  }
  return any ? out : null;
}

/* ---------- Daily overlay: AllPricesToday.json ----------
   Small enough to fetch and JSON.parse whole. Returns
   { bySc: Map(scryfallId -> {tcg,ck,cm,cs}), byTcg: Map(tcgplayerProductId -> {...}) }
   so both the singles archive (prices.js) and the sealed catalog (sealed.js)
   can read out of one download/pass. */
async function pricesToday() {
  await loadIdMaps();
  if (!scryfallByUuid.size && !tcgByUuid.size) {
    throw new Error("No MTGJSON identifier map on disk yet - run the identifier refresh first.");
  }
  log("downloading AllPricesToday.json.gz");
  const res = await mtgFetch(BASE + "AllPricesToday.json.gz");
  const stream = gunzipStream(res.body);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const data = doc.data || {};
  const bySc = new Map(), byTcg = new Map();
  let matched = 0;
  for (const uuid of Object.keys(data)) {
    const prices = extractPaper(data[uuid], null);
    if (!prices) continue;
    const scryfallId = scryfallByUuid.get(uuid);
    const tcgId = tcgByUuid.get(uuid);
    if (scryfallId) { bySc.set(scryfallId, prices); matched++; }
    if (tcgId) byTcg.set(tcgId, prices);
  }
  log("AllPricesToday: " + matched.toLocaleString() + " printings matched to a Scryfall id, " +
    byTcg.size.toLocaleString() + " matched to a TCGplayer product id (sealed)");
  return { asOf: doc.meta && doc.meta.date || null, bySc, byTcg };
}

/* ---------- 90-day backfill: AllPrices.json ----------
   Streams the ~1GB decompressed file once. For every uuid it can resolve to
   a Scryfall id, folds each of that printing's up-to-90 dated prices into
   `onDay(date, scryfallId, prices)` - the caller (prices.js) is what
   actually accumulates and writes day/series files; this module has no
   opinion on Grimoire's own archive format. Nothing from the source file is
   kept after this returns. */
async function backfill(onDay) {
  await loadIdMaps();
  if (!scryfallByUuid.size) throw new Error("No MTGJSON identifier map on disk yet - run the identifier refresh first.");
  state.backfillRunning = true;
  state.backfillError = null;
  state.backfillProgress = "downloading AllPrices.json.gz (~147MB compressed)";
  log(state.backfillProgress);
  try {
    const res = await mtgFetch(BASE + "AllPrices.json.gz");
    const stream = gunzipStream(res.body);
    let n = 0, matched = 0;
    state.backfillProgress = "streaming AllPrices.json";
    await streamJsonObjectEntries(stream, (uuid, entry) => {
      n++;
      const scryfallId = scryfallByUuid.get(uuid);
      if (!scryfallId) return;
      const paper = entry && entry.paper;
      if (!paper) return;
      // Collect the union of every date any vendor/finish mentions for this
      // printing, then extract one full vendor row per date - avoids
      // assuming all vendors agree on exactly the same date set.
      const dates = new Set();
      for (const code of VENDOR_CODES) {
        const v = paper[VENDORS[code]];
        const retail = v && v.retail;
        if (!retail) continue;
        for (const field of Object.keys(FINISHES)) {
          const points = retail[field];
          if (points) for (const d of Object.keys(points)) dates.add(d);
        }
      }
      if (!dates.size) return;
      matched++;
      for (const date of dates) {
        const prices = extractPaper(entry, date);
        if (prices) onDay(date, scryfallId, prices);
      }
      if (n % 50000 === 0) {
        state.backfillProgress = "streamed " + n.toLocaleString() + " printings, " + matched.toLocaleString() + " matched";
        log(state.backfillProgress);
      }
    });
    state.backfillDone = new Date().toISOString();
    state.backfillProgress = "";
    log("backfill source scan complete: " + n.toLocaleString() + " printings seen, " + matched.toLocaleString() + " matched to owned Scryfall ids");
    return { ok: true, scanned: n, matched };
  } catch (e) {
    state.backfillError = e.message || String(e);
    state.backfillProgress = "";
    log("backfill FAILED: " + state.backfillError);
    throw e;
  } finally {
    state.backfillRunning = false;
  }
}

function status() {
  return {
    idsReady: state.idsReady, idsBuilding: state.idsBuilding, idsUpdatedAt: state.idsUpdatedAt,
    idsBuiltAt: state.idsBuiltAt, idsCount: state.idsCount, idsError: state.idsError,
    backfillRunning: state.backfillRunning, backfillProgress: state.backfillProgress,
    backfillError: state.backfillError, backfillDone: state.backfillDone
  };
}

async function init(config, opts) {
  cfg = config;
  cfg.mtgjson = cfg.mtgjson || {};
  const contact = config.contactEmail ? " (+" + config.contactEmail + ")" : "";
  userAgent = "Grimoire/" + VERSION + contact;
  if (opts && opts.log) logger = opts.log;
  const meta = await store.readJson(idsMetaFile(), null);
  if (meta) { state.idsReady = true; state.idsUpdatedAt = meta.updatedAt; state.idsBuiltAt = meta.builtAt; state.idsCount = meta.count; }
}

module.exports = {
  init, status, refreshIdentifiers, pricesToday, backfill,
  VENDOR_CODES, VENDORS, FINISHES
};
