"use strict";
/* The card database.
   -----------------
   v0.07 hit api.scryfall.com from the browser on every keystroke, every add and
   every price refresh. One person is fine; ten people behind one public IP are
   not, and a browser cannot even send the User-Agent Scryfall asks for.

   So: once a day this process downloads Scryfall's bulk card file, trims each
   card to the fields the app actually reads, and keeps it in memory plus an
   NDJSON cache on disk. Every autocomplete, printing list, single lookup and
   price refresh is then answered locally - no network, no rate limit, no
   per-user traffic at all.

   Anything the bulk file cannot answer (a non-English printing, a card released
   since the last download) falls through to a live Scryfall request that goes
   through one shared token bucket, carries a real User-Agent, and is cached to
   disk so the same miss is never fetched twice.

   Bulk file sizes, so the RAM figure is not a surprise:
     default_cards  ~ 110k cards,  ~500 MB of JSON,  ~350 MB resident here
     all_cards      ~ 500k cards,  ~2.4 GB of JSON,  ~1.6 GB resident here
   default_cards is the right default: it is every printing in English (or the
   printed language when a card only exists in one), which is what almost every
   row in a collection is. */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { Readable, PassThrough } = require("stream");
const { once } = require("events");
const store = require("./store");
const integrations = require("./integrations");

const SCRYFALL = "https://api.scryfall.com";
const ACCEPT = "application/json;q=0.9,*/*;q=0.8";
const VERSION = "0.8";

let cfg = { cards: {} };
let userAgent = "Grimoire/" + VERSION;

const state = {
  ready: false,
  building: false,
  progress: "",
  bulkType: "default_cards",
  updatedAt: null,          // Scryfall's own updated_at for the bulk file
  builtAt: null,            // when we last indexed it
  count: 0,
  error: null,
  liveHits: 0,
  liveMisses: 0
};

let byPrint = new Map();    // "set|normnum|lang" -> card
let byId = new Map();       // scryfall id -> card
let byName = new Map();     // lowercase name -> [card, ...] oldest release first
let nameList = [];          // [{name, lower}] sorted, for autocomplete
let setsByCode = new Map(); // code -> {code,name,type,released}
let setsByName = new Map(); // lowercase name -> code
let illustrationToScryfall = new Map(); // illustration_id -> Set<scryfall id>, see buildIllustrationIndex()
let oracleFinishCount = new Map(); // oracle_id -> total (printing x finish) combos across the catalog, see buildOracleIndex()

const cardsFile = () => store.p("cards", "cards.ndjson");
const metaFile = () => store.p("cards", "meta.json");
const liveFile = () => store.p("cards", "live.ndjson");
const setsFile = () => store.p("cards", "sets.json");

/* ---------- Small helpers shared with the browser ---------- */
const normNum = n => String(n == null ? "" : n).trim().toLowerCase().replace(/^0+(?=.)/, "");
const printKey = (set, num, lang) =>
  String(set || "").toLowerCase() + "|" + normNum(num) + "|" + String(lang || "en").toLowerCase();

function collectorVariants(number) {
  const s = String(number == null ? "" : number).trim();
  if (!s) return [];
  const out = [s];
  const stripped = s.replace(/^0+(?=.)/, "");
  if (stripped !== s) out.push(stripped);
  const m = stripped.match(/^(\d+)(.*)$/);
  if (m) for (const w of [2, 3, 4]) if (m[1].length < w) out.push(m[1].padStart(w, "0") + m[2]);
  return [...new Set(out)];
}

/* ---------- Rate-limited live Scryfall access ----------
   Scryfall asks for under 10 requests/second, an Accept header and an accurate
   User-Agent. All three are satisfiable here in a way they never were in the
   browser. A 429 sets one gate that every queued request respects. */
const q = [];
let inflight = 0;
let window0 = [];
let gateUntil = 0;
let pumping = false;

function perSec() { return Math.max(1, Math.min(9, Number(cfg.cards.requestsPerSecond) || 8)); }

function pump() {
  if (pumping) return;
  pumping = true;
  (function step() {
    if (!q.length) { pumping = false; return; }
    const now = Date.now();
    if (now < gateUntil) { setTimeout(step, gateUntil - now); return; }
    while (window0.length && window0[0] <= now - 1000) window0.shift();
    if (inflight >= 3) { pumping = false; return; }
    if (window0.length >= perSec()) { setTimeout(step, 1000 - (now - window0[0]) + 5); return; }
    inflight++; window0.push(now);
    (q.shift())();
    step();
  })();
}
function done() { inflight--; pump(); }

function liveFetch(url, opts, retried) {
  const o = opts || {};
  const headers = Object.assign({ Accept: ACCEPT, "User-Agent": userAgent }, o.headers || {});
  return new Promise((resolve, reject) => {
    q.push(() => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; done(); } };
      fetch(url, Object.assign({}, o, { headers })).then(r => {
        if (r.status === 429 && !retried) {
          const wait = parseInt(r.headers.get("retry-after") || "30", 10) || 30;
          gateUntil = Math.max(gateUntil, Date.now() + wait * 1000);
          finish();
          liveFetch(url, o, true).then(resolve, reject);
          return;
        }
        finish(); resolve(r);
      }).catch(e => {
        finish();
        // A dropped connection during a bulk card-index build used to fail
        // outright with zero retries, unlike the 429 handling right above it -
        // one retry after a short pause for a transient blip, same one-retry
        // shape as the 429 case (BACKLOG.md #63).
        if (!retried) { setTimeout(() => liveFetch(url, o, true).then(resolve, reject), 1000); return; }
        reject(e);
      });
    });
    pump();
  });
}

/* ---------- Trimming ---------- */
function faceOf(c) {
  return (Array.isArray(c.card_faces) && c.card_faces[0]) ? c.card_faces[0] : {};
}
function imageOf(c) {
  if (c.image_uris) return c.image_uris.normal || c.image_uris.large || c.image_uris.small || "";
  const f = faceOf(c);
  if (f.image_uris) return f.image_uris.normal || f.image_uris.large || f.image_uris.small || "";
  return "";
}
function oracleOf(c) {
  if (c.oracle_text) return c.oracle_text;
  const faces = Array.isArray(c.card_faces) ? c.card_faces : [];
  return faces.map(f => f.oracle_text || "").filter(Boolean).join(" // ");
}

/* The lowercase blob search() tests a query against. Computed once per card
   here (at trim() time, i.e. bulk build, live fallback fetch, or a
   printings() lookup - every path that turns a raw Scryfall object into a
   card record) instead of once per request inside search(), which used to
   rebuild this same string for up to ~500k cards on every single search. */
function buildHay(name, typeLine, setName, oracle) {
  return (name + " " + typeLine + " " + setName + " " + oracle).toLowerCase();
}

/* Non-enumerable so it never rides along in a JSON response - card records
   are sent to the browser as-is (search results, /api/cards/one,
   /api/cards/collection, ...), and this is a server-only search index, not
   part of the card's public shape. */
function setHay(rec) {
  Object.defineProperty(rec, "hay", {
    value: buildHay(rec.name, rec.typeLine, rec.setName, rec.oracle),
    enumerable: false, writable: true, configurable: true
  });
  return rec.hay;
}

/* Paper formats Deck List can check a deck against (#80). A card's legality
   is kept as ONE short string, one character per format in exactly this
   order ("l" legal, "n" not legal, "b" banned, "r" restricted, "?" Scryfall
   didn't say) - never Scryfall's own ~20-key object. Two reasons, both about
   the all_cards scale in CLAUDE.md: an object per row is a real allocation
   on ~530k rows, and reuseUnlessChanged() compares non-array fields with
   `!==`, so a fresh object on every re-trim would defeat reuse for EVERY
   card and bring the 2026-09-08 OOM memory doubling straight back. A string
   compares by value, and internLegal() makes every row with the same
   legality share one instance - there are only a few dozen distinct codes.
   Append-only: reordering or removing a format silently re-labels every
   code already sitting in cards.ndjson. */
const LEGAL_FORMATS = ["standard", "pioneer", "modern", "premodern", "legacy", "vintage",
  "pauper", "commander", "paupercommander", "oathbreaker"];
const LEGAL_CHAR = { legal: "l", not_legal: "n", banned: "b", restricted: "r" };
// Bounded anyway, even though real data only ever produces a few dozen
// codes - past the cap a code just isn't shared, nothing breaks.
const legalPool = new Map();
function internLegal(s) {
  if (!s || typeof s !== "string") return "";
  const hit = legalPool.get(s);
  if (hit !== undefined) return hit;
  if (legalPool.size < 5000) legalPool.set(s, s);
  return s;
}
function legalCode(legalities) {
  if (!legalities || typeof legalities !== "object") return "";
  let s = "";
  for (const fmt of LEGAL_FORMATS) s += LEGAL_CHAR[legalities[fmt]] || "?";
  return internLegal(s);
}

function trim(c) {
  const f = faceOf(c);
  const keepOracle = cfg.cards.keepOracleText !== false;
  const oracle = keepOracle ? oracleOf(c) : "";
  const name = c.name || "";
  const setName = c.set_name || "";
  const typeLine = c.type_line || f.type_line || "";
  const oracleTrimmed = oracle.length > 900 ? oracle.slice(0, 900) : oracle;
  const rec = {
    id: c.id,
    oracleId: c.oracle_id || "",
    // Identifies one specific piece of artwork, shared across every printing
    // that reuses it (a reprint with new art gets a new one). Only consumed
    // server-side, to map an art-tag's illustration ids back to the scryfall
    // ids that carry them - see buildIllustrationIndex() below.
    illustrationId: c.illustration_id || f.illustration_id || "",
    name,
    // Phyrexian ("ph") isn't a real script - Scryfall's printed_name for it is
    // the name re-spelled through the invented Phyrexian glyph alphabet, only
    // legible with a special font. Never trust it as a display name.
    printedName: c.lang === "ph" ? "" : (c.printed_name || ""),
    lang: c.lang || "en",
    set: String(c.set || "").toLowerCase(),
    setName,
    setType: c.set_type || "",
    collector: String(c.collector_number == null ? "" : c.collector_number),
    rarity: c.rarity || "",
    typeLine,
    oracle: oracleTrimmed,
    manaCost: c.mana_cost || f.mana_cost || "",
    cmc: c.cmc == null ? null : Number(c.cmc),
    colors: c.colors || f.colors || [],
    colorIdentity: c.color_identity || [],
    keywords: c.keywords || [],
    artist: c.artist || f.artist || "",
    releasedAt: c.released_at || "",
    promo: !!c.promo,
    fullArt: !!c.full_art,
    reserved: !!c.reserved,
    borderColor: c.border_color || "",
    layout: c.layout || "",
    power: f.power != null ? f.power : (c.power != null ? c.power : ""),
    toughness: f.toughness != null ? f.toughness : (c.toughness != null ? c.toughness : ""),
    edhrecRank: c.edhrec_rank == null ? null : Number(c.edhrec_rank),
    tcgplayerId: c.tcgplayer_id || "",
    imageUrl: imageOf(c),
    usd: c.prices && c.prices.usd != null ? Number(c.prices.usd) : null,
    usdFoil: c.prices && c.prices.usd_foil != null ? Number(c.prices.usd_foil) : null,
    usdEtched: c.prices && c.prices.usd_etched != null ? Number(c.prices.usd_etched) : null,
    // A permanent, never-overwritten copy of Scryfall's own numbers, taken at
    // the same moment as usd/usdFoil/usdEtched above (which applyPriceSource()
    // may go on to overwrite from Manapool). Cheap - three more numbers per
    // card - and it's what lets switching cards.priceSource back to
    // "scryfall" be instant and local (copy these three fields back) instead
    // of needing a full Scryfall bulk re-download just to undo an overlay.
    scryfallUsd: c.prices && c.prices.usd != null ? Number(c.prices.usd) : null,
    scryfallUsdFoil: c.prices && c.prices.usd_foil != null ? Number(c.prices.usd_foil) : null,
    scryfallUsdEtched: c.prices && c.prices.usd_etched != null ? Number(c.prices.usd_etched) : null,
    finishes: c.finishes || [],
    // Which games this printing is legally available in ("paper", "arena",
    // "mtgo") - kept on the trimmed record (not just checked at build time)
    // so indexCard() can re-apply the paper-only filter on every path that
    // reaches it, including loading an already-built disk cache.
    games: Array.isArray(c.games) ? c.games : [],
    // Per-format legality code - see LEGAL_FORMATS above for the encoding.
    legal: legalCode(c.legalities)
  };
  setHay(rec);
  return rec;
}

/* Fields that legitimately change on a re-download even when the printing
   itself hasn't (Scryfall's own daily market snapshot, EDHREC rank drift) -
   see reuseUnlessChanged() below, which needs to tell "actually a different
   printing" apart from "same printing, prices moved." */
const VOLATILE_FIELDS = ["usd", "usdFoil", "usdEtched", "scryfallUsd", "scryfallUsdFoil", "scryfallUsdEtched", "edhrecRank"];

/* Fields only ever meant for one account's POST /api/cards/collection
   response (Manapool prices, vendor archive prices). indexCard() strips any
   found on an index object: see #82. */
const REQUEST_ONLY_FIELDS = ["mpLowNm", "mpLowNmFoil", "mpLowOther", "mpLowOtherFoil", "mpMarket", "mpMarketFoil", "vendor"];

function sameArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* refreshBulk() re-trims every printing from scratch on every run, but on a
   typical day the vast majority of them are byte-for-byte identical to what's
   already indexed - only prices/rank move. Reusing the live object (with its
   volatile fields refreshed in place) instead of keeping both the old and the
   newly-trimmed copy alive is what keeps an all_cards rebuild (~500k
   printings, ~1.6GB resident per full copy - see the file-header comment)
   from needing two full copies in memory at once. Safe to mutate `prior` in
   place: this only ever runs on the sync path of a stream callback, so there
   is no await between reading and writing its fields for another caller to
   observe a half-updated record. */
function reuseUnlessChanged(prior, fresh) {
  if (!prior || prior.id !== fresh.id) return fresh;
  // A field trim() has gained since `prior` was built (e.g. `legal`, #80, on
  // a record loaded from an older cards.ndjson) is a backfill onto the same
  // printing, not a change to it - adopt it rather than treating every row
  // as changed, which would double-allocate the whole index on the first
  // rebuild after any new field ships (the exact OOM this function exists
  // to prevent).
  let backfill = null;
  for (const k in fresh) {
    if (VOLATILE_FIELDS.includes(k)) continue;
    if (!(k in prior)) { (backfill || (backfill = [])).push(k); continue; }
    const a = prior[k], b = fresh[k];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!sameArray(a, b)) return fresh;
    } else if (a !== b) {
      return fresh;
    }
  }
  for (const f of VOLATILE_FIELDS) prior[f] = fresh[f];
  if (backfill) for (const k of backfill) prior[k] = fresh[k];
  return prior;
}

/* Arena/MTGO-only printings don't physically exist and have shown up as bad
   data across the app (autocomplete, search, Buy List, ...) - excluded here
   so they never enter any index, on any path. A card with no `games` field at
   all (e.g. an already-built disk cache line from before this field existed)
   is kept rather than dropped, so a stale cache degrades to "not yet
   filtered" instead of "everything disappears" - a forced card refresh
   backfills `games` and lets this actually take hold. */
function isPaperCard(card) {
  return !Array.isArray(card.games) || card.games.length === 0 || card.games.includes("paper");
}

/* ---------- Index ----------
   `maps`, when passed, is a private {byPrint,byId,byName} bundle to build
   into instead of the live module-level ones - see refreshBulk()'s "build in
   the background, swap in atomically" comment for why that matters. Every
   other caller (boot-time cache load, an opportunistic single-card add from
   a live fallback fetch) omits it and keeps writing straight into the live
   index, exactly as before. */
function indexCard(card, maps) {
  if (!isPaperCard(card)) return;
  // A card loaded from an on-disk cache file (JSON.parse of a line) always
  // gets `hay` back as a normal enumerable property, even though trim()
  // attaches it non-enumerably - drop it here so it can never leak into an
  // API response, and let search() recompute it non-enumerably on first use.
  if (Object.prototype.hasOwnProperty.call(card, "hay")) delete card.hay;
  // Per-account fields POST /api/cards/collection used to write straight
  // onto index objects (#82). A reused object carried them through every
  // rebuild and into cards.ndjson, so drop any that are already there.
  // delete only runs on the few cards that have them (a delete moves an
  // object to V8's slower dictionary mode, so never on every card).
  for (const k of REQUEST_ONLY_FIELDS) if (k in card) delete card[k];
  // JSON.parse gives every cached line its own copy of the legality string -
  // re-share the pooled one (see LEGAL_FORMATS).
  if (card.legal) card.legal = internLegal(card.legal);
  const bp = maps ? maps.byPrint : byPrint;
  const bi = maps ? maps.byId : byId;
  const bn = maps ? maps.byName : byName;
  const k = printKey(card.set, card.collector, card.lang);
  const existing = bp.get(k);
  // Two rows can collide on a padding-insensitive key (rare, e.g. "1" vs "01"
  // both present). Prefer the one whose collector number matches exactly.
  if (!existing || normNum(existing.collector) !== normNum(card.collector)) bp.set(k, card);
  if (card.id) bi.set(card.id, card);
  for (const nm of [card.name, card.printedName]) {
    if (!nm) continue;
    const key = nm.toLowerCase();
    let arr = bn.get(key);
    if (!arr) { arr = []; bn.set(key, arr); }
    if (!arr.includes(card)) arr.push(card);
  }
}

function finishIndex(maps) {
  const bn = maps ? maps.byName : byName;
  const bi = maps ? maps.byId : byId;
  const seen = new Set();
  const list = [];
  for (const [lower, arr] of bn) {
    if (seen.has(lower)) continue;
    seen.add(lower);
    list.push({ name: (arr[0].name || arr[0].printedName), lower });
  }
  list.sort((a, b) => a.lower.localeCompare(b.lower));
  for (const arr of bn.values()) {
    arr.sort((a, b) => String(a.releasedAt).localeCompare(String(b.releasedAt)));
  }
  if (maps) maps.nameList = list; else nameList = list;
  state.count = bi.size;
}

function resetIndex() {
  byPrint = new Map(); byId = new Map(); byName = new Map(); nameList = [];
}

/* illustration_id -> every scryfall id that shares it. An art tag from the
   Tagger bulk file (see the tags section below) identifies artwork by
   illustration_id, but Grimoire's owned-card rows only carry a scryfall id -
   this is the join between the two, rebuilt whenever the card index is
   (re)built since it's cheap (one pass over what's already in memory) and
   keeping it in perfect sync with byId matters more than saving that pass. */
function buildIllustrationIndex() {
  illustrationToScryfall = new Map();
  for (const c of byId.values()) {
    if (!c.illustrationId) continue;
    let set = illustrationToScryfall.get(c.illustrationId);
    if (!set) { set = new Set(); illustrationToScryfall.set(c.illustrationId, set); }
    set.add(c.id);
  }
}

/* oracle_id -> count of distinct (set, collector) printings across the
   whole catalog - the denominator Movers' "any printing" view needs to say
   "1 of 2 printings moved" rather than just "1 moved" with no sense of
   whether that's most of the card or a sliver of it. Deliberately does NOT
   count language variants or finishes as separate printings - all_cards
   (this deployment's real bulkType) catalogs every language of a card as
   its own scryfall id sharing the same oracle_id, which first inflated this
   count 5-10x (Elrond, Moon-Reader: 2 real printings x ~5 languages x 2
   finishes = 20, before a real user caught it looking nothing like "2 of
   20 printings" should). A printing is what set+collector number identify,
   full stop. */
function buildOracleIndex() {
  oracleFinishCount = new Map();
  const seenPrintings = new Map(); // oracle_id -> Set<"set|collector">
  for (const c of byId.values()) {
    if (!c.oracleId) continue;
    let seen = seenPrintings.get(c.oracleId);
    if (!seen) { seen = new Set(); seenPrintings.set(c.oracleId, seen); }
    const printingKey = c.set + "|" + c.collector;
    if (seen.has(printingKey)) continue;
    seen.add(printingKey);
    oracleFinishCount.set(c.oracleId, (oracleFinishCount.get(c.oracleId) || 0) + 1);
  }
}
function oracleFinishTotal(oracleId) { return oracleId ? (oracleFinishCount.get(oracleId) || 0) : 0; }

/* ---------- Decompress if, and only if, the bytes are actually gzip ----------
   Scryfall now serves the bulk files as `.jsonl.gz`, where the gzip is the FILE,
   not a Content-Encoding - so fetch() hands back compressed bytes and we have to
   inflate them ourselves. But a plain `.json` URL, or a server that does use
   Content-Encoding (which fetch decompresses for us), would already be plain
   text and inflating it again would fail. So sniff the two-byte gzip magic
   number rather than trusting the file extension. */
async function maybeGunzip(webBody) {
  const src = Readable.fromWeb(webBody);
  const pass = new PassThrough();
  const it = src[Symbol.asyncIterator]();
  const first = await it.next();
  const chunk = first.done ? null : first.value;
  const gzipped = !!(chunk && chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b);

  // Re-emit the sniffed chunk, then pump the rest, honouring back-pressure.
  (async () => {
    try {
      if (chunk && !pass.write(chunk)) await once(pass, "drain");
      for (;;) {
        const n = await it.next();
        if (n.done) break;
        if (!pass.write(n.value)) await once(pass, "drain");
      }
      pass.end();
    } catch (e) { pass.destroy(e); }
  })();

  if (!gzipped) return { stream: pass, gzipped: false };
  const gz = zlib.createGunzip();
  pass.on("error", e => gz.destroy(e));
  pass.pipe(gz);
  return { stream: gz, gzipped: true };
}

/* ---------- JSON Lines ----------
   The current bulk format: one complete card object per line. Nothing clever
   needed, which is the point - readline holds one line at a time. */
async function streamJsonLines(readable, onObject) {
  const rl = readline.createInterface({ input: readable, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    const s = line.trim();
    if (!s || s === "[" || s === "]") continue;          // tolerate a stray array wrapper
    try { onObject(JSON.parse(s.replace(/,$/, ""))); count++; }
    catch (e) { /* skip one unparseable line rather than losing the file */ }
  }
  return count;
}

/* ---------- Streaming split of a giant JSON array ----------
   Kept for the older `download_uri` form, which served one array of objects.
   Parsing that with JSON.parse would need the whole file as a single string
   first, which is exactly the allocation this avoids: scan for top-level object
   boundaries, parse one object at a time, and drop it from the buffer as soon as
   it is consumed. */
function streamJsonArray(readable, onObject) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let depth = 0, inStr = false, escaped = false, start = -1, count = 0;
    readable.setEncoding("utf8");
    readable.on("data", chunk => {
      buf += chunk;
      let i = 0;
      while (i < buf.length) {
        const ch = buf[i];
        if (inStr) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === "{") { if (depth === 0) start = i; depth++; }
        else if (ch === "}") {
          depth--;
          if (depth === 0 && start >= 0) {
            const text = buf.slice(start, i + 1);
            try { onObject(JSON.parse(text)); count++; } catch (e) { /* skip one bad object */ }
            buf = buf.slice(i + 1);
            start = -1;
            i = -1;                                 // rescan the trimmed buffer from 0
          }
        }
        i++;
      }
      // Between objects there is nothing but commas and whitespace, so the
      // buffer can be dropped; mid-object it is kept from `start` onward.
      if (start > 0) { buf = buf.slice(start); start = 0; }
      else if (depth === 0 && start < 0 && !inStr && buf.length > 4096) buf = "";
    });
    readable.on("end", () => resolve(count));
    readable.on("error", reject);
  });
}

/* ---------- Bulk refresh ---------- */
async function bulkInfo() {
  const r = await liveFetch(SCRYFALL + "/bulk-data");
  if (!r.ok) throw new Error("Scryfall /bulk-data returned HTTP " + r.status);
  const d = await r.json();
  const want = cfg.cards.bulkType || "default_cards";
  const list = Array.isArray(d.data) ? d.data : [];
  const item = list.find(x => x && x.type === want);
  if (!item) {
    throw new Error('Scryfall has no bulk file of type "' + want + '". It offers: ' +
      (list.map(x => x && x.type).filter(Boolean).join(", ") || "(nothing)"));
  }
  /* Scryfall renamed these. jsonl_download_uri + compressed_size are current;
     download_uri + size were the older names. Accept either, and if neither is
     present say what the object DID contain - a bare `undefined` in the log is
     what made this take a round trip to diagnose. */
  const url = item.jsonl_download_uri || item.download_uri || item.uri_download || "";
  if (!url) {
    throw new Error("Scryfall's bulk entry for " + want + " carries no download URL. " +
      "Fields present: " + Object.keys(item).join(", ") + ". The API shape has probably " +
      "changed again - map the new field name in server/lib/cards.js bulkInfo().");
  }
  return {
    raw: item,
    type: item.type,
    updatedAt: item.updated_at,
    url,
    bytes: Number(item.compressed_size || item.size || 0),
    // JSON Lines is the current format; a `.json` URL is the legacy array.
    jsonl: /\.jsonl(\.gz)?$/i.test(url) || !!item.jsonl_download_uri
  };
}

async function refreshSets() {
  try {
    const r = await liveFetch(SCRYFALL + "/sets");
    if (!r.ok) return;
    const d = await r.json();
    const sets = (d.data || []).map(s => ({
      code: s.code, name: s.name, type: s.set_type,
      released: s.released_at || "", cards: s.card_count || 0, digital: !!s.digital
    }));
    setsByCode = new Map(); setsByName = new Map();
    for (const s of sets) {
      setsByCode.set(s.code.toLowerCase(), s);
      setsByName.set(s.name.toLowerCase(), s.code);
    }
    await store.writeJsonCompact(setsFile(), { fetchedAt: new Date().toISOString(), sets });
  } catch (e) { /* the app works without the set list; it only aids TCG imports */ }
}

async function loadSetsFromDisk() {
  const d = await store.readJson(setsFile(), null);
  if (!d || !Array.isArray(d.sets)) return false;
  setsByCode = new Map(); setsByName = new Map();
  for (const s of d.sets) {
    setsByCode.set(String(s.code).toLowerCase(), s);
    setsByName.set(String(s.name).toLowerCase(), s.code);
  }
  return true;
}

async function refreshBulk(opts) {
  const force = !!(opts && opts.force);
  if (state.building) return { skipped: "already building" };
  state.building = true;
  state.error = null;
  state.progress = "checking Scryfall bulk index";
  const started = Date.now();
  try {
    const info = await bulkInfo();
    const meta = await store.readJson(metaFile(), null);
    if (!force && meta && meta.updatedAt === info.updatedAt && meta.bulkType === info.type) {
      state.progress = "";
      state.building = false;
      log("bulk file unchanged since " + info.updatedAt + " - keeping the cache");
      return { skipped: "unchanged", updatedAt: info.updatedAt };
    }

    log("downloading " + info.type + " (" + Math.round(info.bytes / 1048576) + " MB compressed, " +
      (info.jsonl ? "JSON Lines" : "JSON array") + ") from " + info.url);
    state.progress = "downloading " + info.type;
    const res = await liveFetch(info.url, { headers: { Accept: "application/json" } });
    if (!res.ok || !res.body) throw new Error("bulk download returned HTTP " + res.status);

    const tmpNd = store.p("tmp", "cards.building.ndjson");
    await fsp.mkdir(path.dirname(tmpNd), { recursive: true });
    const out = fs.createWriteStream(tmpNd, { encoding: "utf8" });

    // Build into a private set of maps, not the live byPrint/byId/byName -
    // the live index otherwise goes from "complete, slightly stale" straight
    // to "empty" the instant this starts, and stays that way for as long as
    // the download+parse takes (minutes for default_cards, plausibly over an
    // hour for all_cards). Every lookup in that window - autocomplete, a
    // price refresh, the nightly price snapshot - would silently see nothing
    // and no caller has any way to tell, since `ready` never went false. The
    // live maps are swapped in only once the new index is fully built (see
    // below), so readers keep serving the complete old index the whole time.
    // This alone would mean two complete copies of the index resident at
    // once (~1.6GB x2 for all_cards, per the file-header comment) - onCard()
    // below avoids that by reusing the live object for any printing that
    // hasn't actually changed (reuseUnlessChanged()), so only genuinely new
    // or changed printings end up double-allocated. Confirmed necessary, not
    // theoretical: an all_cards rebuild OOM'd production on 2026-09-08 with
    // both copies fully resident.
    const building = { byPrint: new Map(), byId: new Map(), byName: new Map(), nameList: [] };
    let n = 0;
    const writeQueue = [];
    // One shared pending-drain wait, not one per backpressured write - a
    // 500k+ card file (all_cards) hits backpressure often enough between
    // drain events that a listener-per-write stacked well past Node's
    // default MaxListeners(10) on this same stream, a real
    // MaxListenersExceededWarning confirmed live (2026-09-05). Every writer
    // waiting on "the next drain" is satisfied by the exact same event, so
    // one listener covers all of them.
    let pendingDrain = null;
    const onCard = obj => {
      if (!obj || obj.object !== "card") return;
      let card = trim(obj);
      // Arena/MTGO-only printings never even reach the disk cache - not just
      // filtered out of the runtime index (indexCard() does that too, but a
      // stale disk cache built before this existed still needs a fresh
      // download to actually stop carrying them).
      if (!isPaperCard(card)) return;
      // Reuse the live object when this printing hasn't actually changed
      // (see reuseUnlessChanged() above) - this is what keeps the old and
      // new indexes from both being fully resident at once for the rebuild's
      // duration.
      card = reuseUnlessChanged(byPrint.get(printKey(card.set, card.collector, card.lang)), card);
      indexCard(card, building);
      if (!out.write(JSON.stringify(card) + "\n") && !pendingDrain) {
        pendingDrain = new Promise(r => out.once("drain", () => { pendingDrain = null; r(); }));
        writeQueue.push(pendingDrain);
      }
      if (++n % 25000 === 0) {
        state.progress = "indexing " + n.toLocaleString() + " cards";
        log("  indexed " + n.toLocaleString());
      }
    };

    const { stream, gzipped } = await maybeGunzip(res.body);
    if (gzipped) log("  inflating gzip as it streams");
    state.progress = "indexing " + info.type;
    const total = info.jsonl
      ? await streamJsonLines(stream, onCard)
      : await streamJsonArray(stream, onCard);

    await Promise.all(writeQueue);
    await new Promise((resolve, reject) => { out.end(err => err ? reject(err) : resolve()); });
    if (!n) throw new Error("the bulk file yielded no cards - the format has probably changed");

    finishIndex(building);
    // Atomic swap - readers see either the complete old index or the
    // complete new one, never a partially-built one.
    byPrint = building.byPrint; byId = building.byId; byName = building.byName; nameList = building.nameList;
    buildIllustrationIndex();
    buildOracleIndex();
    await store.renameWithRetry(tmpNd, cardsFile());
    await store.writeJson(metaFile(), {
      bulkType: info.type,
      updatedAt: info.updatedAt,
      builtAt: new Date().toISOString(),
      count: state.count
    });
    state.bulkType = info.type;
    state.updatedAt = info.updatedAt;
    state.builtAt = new Date().toISOString();
    state.ready = true;
    state.progress = "";
    // Best effort: a compaction hiccup should never fail an otherwise-good
    // bulk refresh, so failures here are logged, not thrown.
    flushLive();
    try { await compactLiveCache(building); }
    catch (e) { log("live.ndjson compaction skipped: " + (e.message || e)); }
    await refreshSets();
    // trim() always resets usd/usdFoil/usdEtched to Scryfall's raw numbers,
    // so a rebuild wipes any earlier Manapool overlay - re-apply here so
    // "Rebuild the card database now" (or a scheduled refresh landing off
    // the daily job's own price-overlay slot) can't silently leave prices
    // on the wrong source until the next scheduled run. Best effort, same as
    // compactLiveCache above: a Manapool hiccup shouldn't fail an otherwise
    // good card rebuild.
    try { await applyPriceSource(); }
    catch (e) { log("price source re-apply after rebuild failed: " + (e.message || e)); }
    log("card database ready: " + state.count.toLocaleString() + " cards in " +
      Math.round((Date.now() - started) / 1000) + "s (scanned " + total.toLocaleString() + " objects)");
    return { ok: true, count: state.count, updatedAt: state.updatedAt };
  } catch (e) {
    state.error = e.message || String(e);
    state.progress = "";
    log("card refresh FAILED: " + state.error);
    throw e;
  } finally {
    state.building = false;
  }
}

/* ---------- Load the trimmed cache at boot ---------- */
async function loadFromDisk() {
  const meta = await store.readJson(metaFile(), null);
  if (!meta) return false;
  let exists = true;
  try { await fsp.access(cardsFile()); } catch (e) { exists = false; }
  if (!exists) return false;

  const started = Date.now();
  resetIndex();
  const rl = readline.createInterface({
    input: fs.createReadStream(cardsFile(), { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    try { indexCard(JSON.parse(line)); n++; } catch (e) {}
  }
  finishIndex();
  buildIllustrationIndex();
  buildOracleIndex();
  state.bulkType = meta.bulkType || "default_cards";
  state.updatedAt = meta.updatedAt || null;
  state.builtAt = meta.builtAt || null;
  state.ready = n > 0;
  await loadSetsFromDisk();
  log("loaded " + n.toLocaleString() + " cards from cache in " + (Date.now() - started) + "ms" +
    " (Scryfall bulk of " + (state.updatedAt || "unknown date") + ")");
  return state.ready;
}

/* ---------- Live fallback, cached ---------- */
let liveCache = new Map();      // printKey -> card | null (null = confirmed absent)
let liveDirty = [];

async function loadLiveCache() {
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(liveFile(), { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.k) liveCache.set(rec.k, rec.c || null);
      } catch (e) {}
    }
  } catch (e) { /* no cache yet */ }
}

function rememberLive(key, card) {
  liveCache.set(key, card || null);
  liveDirty.push(JSON.stringify({ k: key, c: card || null, t: Date.now() }) + "\n");
  if (liveDirty.length >= 20) flushLive();
}

function flushLive() {
  if (!liveDirty.length) return;
  const text = liveDirty.join("");
  liveDirty = [];
  fs.appendFile(liveFile(), text, "utf8", () => {});
}
setInterval(flushLive, 30000).unref();

/* live.ndjson is append-only (rememberLive/flushLive above) and never
   otherwise touched, so a long-running server slowly turns it into an
   ever-growing log of duplicate and now-redundant lines - and the whole
   thing is read into memory at boot (loadLiveCache). Piggyback on the daily
   bulk refresh to compact it: once `building` (the freshly built bulk index
   - see refreshBulk) is complete, drop any live-cache entry whose print key
   is now answered by the bulk file itself (localOne() already tries byPrint
   before ever consulting the live cache, so such an entry is pure dead
   weight), and dedupe whatever is left by key, keeping only the newest
   record for each - "last write wins", same as loadLiveCache already
   behaves when it replays the file front-to-back into a Map. */
async function compactLiveCache(building) {
  let text;
  try { text = await fsp.readFile(liveFile(), "utf8"); } catch (e) { return; }
  if (!text) return;

  const merged = new Map();   // printKey -> last {k,c,t} line seen
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && rec.k) merged.set(rec.k, rec);
    } catch (e) { /* drop one unparseable line rather than losing the rest */ }
  }

  const keptLines = [];
  for (const [key, rec] of merged) {
    if (building.byPrint.has(key)) {
      // Now covered by the fresh bulk index - forget it both on disk and in
      // the in-memory cache, so a long-lived process's liveCache Map doesn't
      // keep growing across refreshes either.
      liveCache.delete(key);
      continue;
    }
    keptLines.push(JSON.stringify(rec));
  }

  const before = merged.size;
  const after = keptLines.length;
  await store.writeFileAtomic(liveFile(), keptLines.length ? keptLines.join("\n") + "\n" : "");
  if (before !== after) {
    log("compacted live.ndjson: " + before.toLocaleString() + " -> " + after.toLocaleString() + " entries");
  }
}

async function liveOne(set, num, lang) {
  if (cfg.cards.liveFallback === false) return null;
  const key = printKey(set, num, lang);
  if (liveCache.has(key)) return liveCache.get(key);
  for (const variant of collectorVariants(num)) {
    const base = SCRYFALL + "/cards/" + encodeURIComponent(String(set).toLowerCase()) +
      "/" + encodeURIComponent(variant);
    try {
      let r = await liveFetch(base + "/" + encodeURIComponent(lang || "en"));
      if (r.ok) {
        const card = trim(await r.json());
        // Arena/MTGO-only printings are treated as not found, the same as a
        // genuine 404 - indexCard() would silently drop them from the index
        // anyway, but without this they'd still be remembered and RETURNED
        // by this function on every call, live-index skip or not.
        if (!isPaperCard(card)) { rememberLive(key, null); state.liveMisses++; return null; }
        indexCard(card); rememberLive(key, card); state.liveHits++;
        return card;
      }
      r = await liveFetch(base);
      if (r.ok) {
        const card = trim(await r.json());
        card.langFallback = true;
        if (!isPaperCard(card)) { rememberLive(key, null); state.liveMisses++; return null; }
        indexCard(card); rememberLive(key, card); state.liveHits++;
        return card;
      }
    } catch (e) { /* try the next padding variant */ }
  }
  state.liveMisses++;
  rememberLive(key, null);
  return null;
}

/* ---------- Oracle tags / illustration tags (Scryfall Tagger bulk files) ----------
   Downloaded and cached exactly like the card database above (refreshBulk/
   loadFromDisk) - NOT a live per-query search, which an earlier version of
   this used and turned out to take 10-20+ seconds for a broad tag (Scryfall's
   courtesy rate limit, paginated). Scryfall publishes the whole Tagger
   dataset as two bulk files (types "oracle_tags"/"art_tags" from /bulk-data,
   ~6MB and ~13MB compressed respectively - tiny next to the card file), so
   there's no need to hit their search endpoint at all once these are cached.

   Tags nest (a tag's child_ids can point at more specific child tags, e.g.
   "removal" has children like "removal-creature") and Scryfall's own otag:/
   art: search silently includes every descendant's cards when you search a
   parent tag - replicated here by expanding each tag's own taggings with
   every descendant's, once, at index-build time, so a lookup at query time
   is a single Map.get() instead of a graph walk.

   Oracle tags key by oracle_id (the rules card, shared by every printing).
   Art/illustration tags key by illustration_id, which Grimoire's own card
   rows don't carry - illustrationToScryfall (built alongside the main card
   index, see buildIllustrationIndex above) is the join back to the scryfall
   ids an owned Grimoire row can actually be matched against. */
const tagsFile = () => store.p("cards", "tags.ndjson");
const tagsMetaFile = () => store.p("cards", "tags-meta.json");

const tagState = { ready: false, building: false, progress: "", updatedAt: null, builtAt: null,
  error: null, oracleTagCount: 0, artTagCount: 0 };

let oracleTagIndex = new Map();   // slug or alias (lowercase) -> Set<oracle_id>
let artTagIndex = new Map();      // slug or alias (lowercase) -> Set<illustration_id>

/* [{id, slug, aliases, child_ids, taggings: [oracle_id or illustration_id, ...]}]
   -> a lookup Map keyed by every slug/alias a tag is known by, each value
   already expanded to include every descendant tag's taggings too. */
function buildTagIndex(tags) {
  const byTagId = new Map(tags.map(t => [t.id, t]));
  const memo = new Map();
  function idsFor(tag, seen) {
    if (memo.has(tag.id)) return memo.get(tag.id);
    if (seen.has(tag.id)) return new Set();   // guard against a cyclic parent/child graph
    seen.add(tag.id);
    const out = new Set(tag.taggings);
    for (const childId of tag.child_ids || []) {
      const child = byTagId.get(childId);
      if (child) for (const id of idsFor(child, seen)) out.add(id);
    }
    memo.set(tag.id, out);
    return out;
  }
  const index = new Map();
  for (const t of tags) {
    const ids = idsFor(t, new Set());
    for (const key of [t.slug, ...(t.aliases || [])]) {
      if (!key) continue;
      const k = String(key).toLowerCase();
      let set = index.get(k);
      if (!set) { set = new Set(); index.set(k, set); }
      for (const id of ids) set.add(id);
    }
  }
  return index;
}

async function tagBulkInfo(type) {
  const r = await liveFetch(SCRYFALL + "/bulk-data");
  if (!r.ok) throw new Error("Scryfall /bulk-data returned HTTP " + r.status);
  const d = await r.json();
  const item = (d.data || []).find(x => x && x.type === type);
  if (!item) throw new Error('Scryfall has no bulk file of type "' + type + '".');
  const url = item.jsonl_download_uri || item.download_uri || "";
  if (!url) throw new Error("Scryfall's bulk entry for " + type + " carries no download URL.");
  return { updatedAt: item.updated_at, url, bytes: Number(item.compressed_size || item.size || 0) };
}

async function downloadTagFile(type, onTag) {
  const info = await tagBulkInfo(type);
  const res = await liveFetch(info.url, { headers: { Accept: "application/json" } });
  if (!res.ok || !res.body) throw new Error(type + " download returned HTTP " + res.status);
  const { stream } = await maybeGunzip(res.body);
  await streamJsonLines(stream, obj => {
    if (!obj || obj.object !== "tag") return;
    onTag({
      id: obj.id,
      slug: obj.slug || obj.label || "",
      aliases: Array.isArray(obj.aliases) ? obj.aliases : [],
      child_ids: Array.isArray(obj.child_ids) ? obj.child_ids : [],
      taggings: (obj.taggings || []).map(x => x.oracle_id || x.illustration_id).filter(Boolean)
    });
  });
  return info;
}

async function refreshTags(opts) {
  const force = !!(opts && opts.force);
  if (tagState.building) return { skipped: "already building" };
  tagState.building = true;
  tagState.error = null;
  const started = Date.now();
  try {
    tagState.progress = "checking Scryfall bulk index";
    const [oracleInfo, artInfo] = await Promise.all([tagBulkInfo("oracle_tags"), tagBulkInfo("art_tags")]);
    const meta = await store.readJson(tagsMetaFile(), null);
    const combinedUpdatedAt = oracleInfo.updatedAt + "|" + artInfo.updatedAt;
    if (!force && meta && meta.updatedAt === combinedUpdatedAt) {
      tagState.progress = "";
      log("tag files unchanged since " + combinedUpdatedAt + " - keeping the cache");
      return { skipped: "unchanged" };
    }

    tagState.progress = "downloading oracle tags";
    log("downloading oracle tags (" + Math.round(oracleInfo.bytes / 1048576) + " MB compressed)");
    const oracleTags = [];
    await downloadTagFile("oracle_tags", t => oracleTags.push(t));

    tagState.progress = "downloading art tags";
    log("downloading art tags (" + Math.round(artInfo.bytes / 1048576) + " MB compressed)");
    const artTags = [];
    await downloadTagFile("art_tags", t => artTags.push(t));

    if (!oracleTags.length && !artTags.length) {
      throw new Error("both tag files yielded zero tags - the format has probably changed");
    }

    oracleTagIndex = buildTagIndex(oracleTags);
    artTagIndex = buildTagIndex(artTags);

    const tmp = store.p("tmp", "tags.building.ndjson");
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    const lines = [];
    for (const t of oracleTags) lines.push(JSON.stringify(Object.assign({ kind: "otag" }, t)));
    for (const t of artTags) lines.push(JSON.stringify(Object.assign({ kind: "art" }, t)));
    await fsp.writeFile(tmp, lines.join("\n") + "\n", "utf8");
    await store.renameWithRetry(tmp, tagsFile());
    await store.writeJson(tagsMetaFile(), {
      updatedAt: combinedUpdatedAt, builtAt: new Date().toISOString(),
      oracleTagCount: oracleTags.length, artTagCount: artTags.length
    });

    tagState.updatedAt = combinedUpdatedAt;
    tagState.builtAt = new Date().toISOString();
    tagState.oracleTagCount = oracleTags.length;
    tagState.artTagCount = artTags.length;
    tagState.ready = true;
    tagState.progress = "";
    log("tag index ready: " + oracleTags.length.toLocaleString() + " oracle tags, " +
      artTags.length.toLocaleString() + " art tags in " + Math.round((Date.now() - started) / 1000) + "s");
    return { ok: true, oracleTagCount: oracleTags.length, artTagCount: artTags.length };
  } catch (e) {
    tagState.error = e.message || String(e);
    tagState.progress = "";
    log("tag refresh FAILED: " + tagState.error);
    throw e;
  } finally {
    tagState.building = false;
  }
}

async function loadTagsFromDisk() {
  const meta = await store.readJson(tagsMetaFile(), null);
  if (!meta) return false;
  let exists = true;
  try { await fsp.access(tagsFile()); } catch (e) { exists = false; }
  if (!exists) return false;

  const started = Date.now();
  const oracleTags = [], artTags = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(tagsFile(), { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const t = JSON.parse(line);
      (t.kind === "art" ? artTags : oracleTags).push(t);
    } catch (e) {}
  }
  oracleTagIndex = buildTagIndex(oracleTags);
  artTagIndex = buildTagIndex(artTags);
  tagState.updatedAt = meta.updatedAt || null;
  tagState.builtAt = meta.builtAt || null;
  tagState.oracleTagCount = oracleTags.length;
  tagState.artTagCount = artTags.length;
  tagState.ready = oracleTags.length > 0 || artTags.length > 0;
  log("loaded " + oracleTags.length.toLocaleString() + " oracle tags, " + artTags.length.toLocaleString() +
    " art tags from cache in " + (Date.now() - started) + "ms");
  return tagState.ready;
}

/* Same {ids: [...]} shape the query builder has always gotten back - kind
   "otag" resolves straight to oracle ids; "art" resolves the tag's
   illustration ids through illustrationToScryfall to actual scryfall ids.
   An unrecognized slug/alias is reported distinctly from "resolved to zero
   cards" so the UI can say "no such tag" instead of a misleading "0 match" -
   matching Scryfall's own otag:/art: syntax, which needs the exact tag name,
   not a free-text search. */
function tagSearch(kind, value) {
  if (kind !== "otag" && kind !== "art") throw Object.assign(new Error('kind must be "otag" or "art".'), { status: 400 });
  const v = String(value || "").trim().toLowerCase();
  if (!v) return { ids: [], found: true };
  if (!tagState.ready) {
    throw Object.assign(new Error("The oracle/art tag index hasn't finished loading yet - try again shortly."), { status: 503 });
  }
  const index = kind === "otag" ? oracleTagIndex : artTagIndex;
  const ids = index.get(v);
  if (!ids) return { ids: [], found: false };
  if (kind === "otag") return { ids: [...ids], found: true };
  const scryfallIds = new Set();
  for (const illustrationId of ids) {
    const set = illustrationToScryfall.get(illustrationId);
    if (set) for (const id of set) scryfallIds.add(id);
  }
  return { ids: [...scryfallIds], found: true };
}

function tagsStatus() {
  return {
    ready: tagState.ready, building: tagState.building, progress: tagState.progress,
    updatedAt: tagState.updatedAt, builtAt: tagState.builtAt, error: tagState.error,
    oracleTagCount: tagState.oracleTagCount, artTagCount: tagState.artTagCount
  };
}

/* ---------- Public lookups ---------- */
function localOne(set, num, lang) {
  const want = String(lang || "en").toLowerCase();
  let c = byPrint.get(printKey(set, num, want));
  if (c) return c;
  if (want !== "en") {
    c = byPrint.get(printKey(set, num, "en"));
    if (c) return Object.assign({}, c, { langFallback: true });
  }
  return null;
}

async function one(set, num, lang) {
  return localOne(set, num, lang) || await liveOne(set, num, lang);
}

/* Batch resolve, the shape the price refresh wants. No chunking, no 75-per-post
   ceiling, no deep one-at-a-time pass: everything already in the bulk file comes
   back from memory, and only genuine misses cost a request. */
async function collection(identifiers) {
  const found = [];
  const missing = [];
  const liveNeeded = [];
  for (const id of (identifiers || [])) {
    if (id && id.id && byId.has(id.id)) { found.push(byId.get(id.id)); continue; }
    const local = localOne(id.set, id.collector, id.lang);
    if (local) found.push(local);
    else liveNeeded.push(id);
  }
  // Cap the live tail so one badly-typed collection cannot queue thousands of
  // requests; the rest come back as misses the UI already knows how to show.
  const LIVE_CAP = 400;
  for (const id of liveNeeded.slice(0, LIVE_CAP)) {
    const c = await liveOne(id.set, id.collector, id.lang);
    if (c) found.push(c); else missing.push(id);
  }
  for (const id of liveNeeded.slice(LIVE_CAP)) missing.push(id);
  // Shallow copies, not the shared index objects: the caller (POST
  // /api/cards/collection) adds one account's Manapool and vendor prices to
  // each, which must not stick to the index for everyone else (#82). One
  // small object per identifier, and the route caps identifiers at 20000.
  return { found: found.map(c => Object.assign({}, c)), missing, liveTried: Math.min(liveNeeded.length, LIVE_CAP) };
}

function autocomplete(qstr, limit) {
  const s = String(qstr || "").trim().toLowerCase();
  if (s.length < 2) return [];
  const cap = limit || 20;
  const starts = [];
  const contains = [];
  for (const entry of nameList) {
    if (entry.lower.startsWith(s)) { if (starts.length < cap) starts.push(entry.name); }
    else if (contains.length < cap && entry.lower.includes(s)) contains.push(entry.name);
    if (starts.length >= cap) break;
  }
  return starts.concat(contains).slice(0, cap);
}

async function printings(name) {
  const key = String(name || "").trim().toLowerCase();
  let arr = byName.get(key);
  if (arr && arr.length) return arr;
  // Not in the bulk file at all - ask Scryfall once and index what comes back.
  if (cfg.cards.liveFallback === false) return [];
  try {
    const url = SCRYFALL + "/cards/search?order=released&unique=prints&q=" +
      encodeURIComponent('!"' + String(name).replace(/"/g, "") + '"');
    const r = await liveFetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    const out = (d.data || []).map(trim).filter(isPaperCard);
    out.forEach(indexCard);
    finishIndex();
    return out;
  } catch (e) { return []; }
}

/* Deck List's format check (#80): card name -> legality code (see
   LEGAL_FORMATS). Legality is per oracle card, identical on every printing
   and language, so any indexed printing of the name answers it - which is
   also why this is name-based rather than per-printing: a deck line is just
   a name, and may not be owned at all. A bare front-face name ("Delver of
   Secrets") falls back to the full "Front // Back" entry. Per name: null
   if no card by that name is indexed, otherwise deckRules() below - whose
   `legal` is "" if the record predates legality data (an older
   cards.ndjson - fills in on the next bulk refresh). Local only - never
   goes out live. */
function nameEntryWithPrefix(prefix) {
  let lo = 0, hi = nameList.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nameList[mid].lower < prefix) lo = mid + 1; else hi = mid;
  }
  const e = nameList[lo];
  return e && e.lower.startsWith(prefix) ? e : null;
}
function legality(names) {
  const out = Object.create(null);
  for (const raw of names || []) {
    const name = String(raw == null ? "" : raw).trim();
    if (!name || name in out) continue;
    const key = name.toLowerCase();
    let arr = byName.get(key);
    if (!arr && !key.includes(" // ")) {
      const e = nameEntryWithPrefix(key + " // ");
      if (e) arr = byName.get(e.lower);
    }
    if (!arr || !arr.length) { out[name] = null; continue; }
    out[name] = deckRules(arr);
  }
  return { formats: LEGAL_FORMATS, results: out };
}

/* The deck-construction facts Deck List's format check needs about one card
   (#80/#81), all derived from fields every record already carries - nothing
   new stored. Prefers an English printing: type_line/oracle are English on
   every language's record, but a printedName-keyed hit can be any of them.
     legal   - legality code (see LEGAL_FORMATS), "" if not known yet
     ci      - colour identity, e.g. "WUB" ("" = colourless)
     copies  - 0 = the format's normal copy limit applies; -1 = any number
               (basic lands, Relentless Rats); N = "up to N" (Seven Dwarves)
     lead    - can be a Commander (legendary creature, or says so)
     walker  - is a planeswalker (Oathbreaker's commander slot)
     partner - can share the command zone with a second commander */
const COPY_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PARTNER_KEYWORDS = ["partner", "partner with", "friends forever", "choose a background", "doctor's companion"];
function deckRules(arr) {
  const c = arr.find(x => x.lang === "en") || arr[0];
  const withCode = c.legal ? c : arr.find(x => x.legal);
  const front = String(c.typeLine || "").split(" // ")[0];
  const oracle = String(c.oracle || "");
  let copies = 0;
  if (/\bBasic\b/.test(front) || /A deck can have any number of cards named/i.test(oracle)) copies = -1;
  else {
    const m = oracle.match(/A deck can have up to (\w+) cards named/i);
    if (m) copies = COPY_WORDS[m[1].toLowerCase()] || Number(m[1]) || 0;
  }
  const kw = (c.keywords || []).map(k => String(k).toLowerCase());
  return {
    legal: withCode ? withCode.legal : "",
    ci: ["W", "U", "B", "R", "G"].filter(x => (c.colorIdentity || []).includes(x)).join(""),
    copies,
    lead: (/\bLegendary\b/.test(front) && /\bCreature\b/.test(front)) || /can be your commander/i.test(oracle),
    walker: /\bPlaneswalker\b/.test(front),
    partner: kw.some(k => PARTNER_KEYWORDS.includes(k)) || /\bBackground\b/.test(front)
  };
}

/* Free-text search over the local index. Backs the "browse the card database"
   box on the receiving page - it never touches Scryfall. */
function search(opts) {
  const o = opts || {};
  const text = String(o.q || "").trim().toLowerCase();
  const limit = Math.min(200, Number(o.limit) || 60);
  const out = [];
  for (const card of byId.values()) {
    if (text) {
      // Normally already computed in trim(). A card loaded from an on-disk
      // cache written before this field existed won't have it yet - compute
      // and cache it in place once, rather than falling back to rebuilding
      // it on every request forever.
      const hay = card.hay || setHay(card);
      if (!hay.includes(text)) continue;
    }
    if (o.set && card.set !== String(o.set).toLowerCase()) continue;
    if (o.rarity && card.rarity !== String(o.rarity).toLowerCase()) continue;
    out.push(card);
    if (out.length >= limit) break;
  }
  return out;
}

function sets() {
  return [...setsByCode.values()].sort((a, b) => String(b.released).localeCompare(String(a.released)));
}
function resolveSetCode(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  if (setsByCode.has(v)) return v;
  if (setsByName.has(v)) return setsByName.get(v);
  return v;
}

/* "Real" sets for collector-completion purposes - excludes tokens, art
   series, memorabilia, and (via the `digital` flag captured in refreshSets())
   Arena/Alchemy-only sets, any of which would otherwise distort a % complete
   figure with cards nobody expects to physically collect. */
const ALLOWED_SET_TYPES = new Set(["core", "expansion", "masters", "draft_innovation", "commander"]);
function isCollectibleSet(meta) {
  return !!meta && ALLOWED_SET_TYPES.has(meta.type) && !meta.digital;
}

/* Every printing in one set, unpaginated - the largest real sets are a few
   hundred cards, so a single filter pass is cheap and needs no chunking. */
function bySet(code) {
  const want = String(code || "").trim().toLowerCase();
  if (!want) return [];
  const out = [];
  for (const c of byId.values()) if (c.set === want) out.push(c);
  return out;
}

/* Per-set collector completion: how many distinct oracle ids exist in each
   "real" set, and how many of those the caller already owns FROM THAT SET
   specifically (owning the name via a different set doesn't count - this
   answers "how much of this set do I have", a binder-completion question,
   not "do I own this card anywhere"). `ownedKeys` is an array of
   "<set>|<oracleId>" strings, one per (set, name) the caller holds. */
function setCompletion(ownedKeys) {
  const owned = new Set(ownedKeys || []);
  const bySetId = new Map(); // set code -> {total:Set<oracleId>, owned:Set<oracleId>}
  for (const c of byId.values()) {
    if (!c.oracleId) continue;
    const meta = setsByCode.get(c.set);
    if (!isCollectibleSet(meta)) continue;
    let b = bySetId.get(c.set);
    if (!b) { b = { total: new Set(), owned: new Set() }; bySetId.set(c.set, b); }
    b.total.add(c.oracleId);
    if (owned.has(c.set + "|" + c.oracleId)) b.owned.add(c.oracleId);
  }
  const out = [];
  for (const [code, b] of bySetId) {
    const meta = setsByCode.get(code);
    out.push({ set: code, setName: meta.name, released: meta.released, total: b.total.size, owned: b.owned.size });
  }
  return out;
}

/* Makes every loaded printing's usd/usdFoil/usdEtched match whichever source
   cfg.cards.priceSource currently names - the single place that decides,
   called after anything that could leave those fields stale: a bulk rebuild
   (end of refreshBulk, since trim() always resets them to Scryfall's raw
   numbers), the daily job loop (index.js's runDueJobs, right before the
   price snapshot), and the admin "flip the switch" route in index.js. The
   nightly snapshot, movers, portfolio and the price-rule engine's default
   basis all just read card.usd/usdFoil/usdEtched off this same in-memory
   index either way, so none of them need to know or care which source last
   wrote those fields.

   "scryfall" is a local, instant, no-network copy from the scryfallUsd*
   shadow fields trim() always maintains - undoing a prior Manapool overlay
   doesn't need a fresh bulk download, since the disk-cached Scryfall numbers
   were never touched by one.

   "manapool" overlays from integrations.manapoolCatalogPrices() (Manapool's
   public bulk price feed) instead. This is deliberately "exclusively
   Manapool", not a blend: a printing Manapool has no current listing for is
   left with no price at all rather than quietly falling back to Scryfall's
   number - mixing two pricing philosophies into one field with no way to
   tell which is which seemed worse than an honest gap. Etched has no
   Manapool "market" tier (see integrations.js), so it always uses the flat
   NM ask - the same gap priceRules.js's mpLow basis already works around. */
async function applyPriceSource() {
  const source = cfg.cards.priceSource || "scryfall";
  if (source !== "manapool") {
    for (const card of byId.values()) {
      card.usd = card.scryfallUsd;
      card.usdFoil = card.scryfallUsdFoil;
      card.usdEtched = card.scryfallUsdEtched;
    }
    state.mpPricesUpdatedAt = null;
    state.mpPricesMatched = null;
    return { ok: true, source: "scryfall", total: byId.size };
  }
  const priced = await integrations.manapoolCatalogPrices();
  let matched = 0;
  for (const card of byId.values()) {
    const mp = priced.get(card.id);
    card.usd = mp ? (mp.market != null ? mp.market : mp.nm) : null;
    card.usdFoil = mp ? (mp.marketFoil != null ? mp.marketFoil : mp.nmFoil) : null;
    card.usdEtched = mp ? mp.nmEtched : null;
    if (mp) matched++;
  }
  state.mpPricesUpdatedAt = new Date().toISOString();
  state.mpPricesMatched = matched;
  log("Manapool price overlay: " + matched + "/" + byId.size + " printings priced");
  return { ok: true, source: "manapool", matched, total: byId.size };
}

/* Price for a printing in a given finish, from the in-memory index. Used by the
   nightly snapshot, so a snapshot costs zero requests. */
function priceFor(set, num, lang, finish) {
  const c = localOne(set, num, lang);
  if (!c) return null;
  const p = finish === "etched" ? c.usdEtched : finish === "foil" ? c.usdFoil : c.usd;
  return p == null ? null : Number(p);
}
function cardByKey(set, num, lang) { return localOne(set, num, lang); }
/* Reverse lookup for anything that only has a Scryfall id in hand (the
   MTGJSON price overlay's uuid->scryfallId join, see server/lib/mtgjson.js) -
   needs to get back to set/collector/lang so it can compute the same
   printKey the rest of the app indexes price history by. */
function cardById(id) { return byId.get(id) || null; }

/* Every printing in the loaded index, one entry per Scryfall id. What the
   nightly price snapshot walks, so the archive covers the whole card
   database rather than whatever anyone happens to own that day. */
function all() { return byId.values(); }

function status() {
  return {
    ready: state.ready,
    building: state.building,
    progress: state.progress,
    bulkType: state.bulkType,
    updatedAt: state.updatedAt,
    builtAt: state.builtAt,
    count: state.count,
    names: nameList.length,
    sets: setsByCode.size,
    error: state.error,
    liveHits: state.liveHits,
    liveMisses: state.liveMisses,
    liveQueue: q.length + inflight,
    liveFallback: cfg.cards.liveFallback !== false,
    priceSource: cfg.cards.priceSource || "scryfall",
    mpPricesUpdatedAt: state.mpPricesUpdatedAt || null,
    mpPricesMatched: state.mpPricesMatched == null ? null : state.mpPricesMatched
  };
}

let logger = msg => console.log("[cards] " + msg);
function log(msg) { logger(msg); }

async function init(config, opts) {
  cfg = config;
  cfg.cards = cfg.cards || {};
  const contact = config.contactEmail ? " (+" + config.contactEmail + ")" : "";
  userAgent = "Grimoire/" + VERSION + contact;
  if (opts && opts.log) logger = opts.log;
  await loadLiveCache();
  const ok = await loadFromDisk();
  if (!ok) {
    log("no card cache on disk - downloading the Scryfall bulk file now. " +
      "The app works meanwhile; lookups just go out live one at a time.");
    refreshBulk({ force: true }).catch(() => {});
  } else if ((cfg.cards.priceSource || "scryfall") === "manapool") {
    // loadFromDisk() reads straight from cards.ndjson, which only ever holds
    // Scryfall's own numbers (see trim()) - so a warm restart on
    // priceSource:"manapool" starts back on Scryfall's prices until this
    // catches up. Fire-and-forget: a ~50MB fetch shouldn't hold up the rest
    // of boot, and refreshBulk() above already awaits its own copy of this
    // for the cold-start path.
    applyPriceSource().catch(e => log("price source apply at boot failed: " + e.message));
  }
  const tagsOk = await loadTagsFromDisk();
  if (!tagsOk) {
    log("no oracle/art tag cache on disk - downloading it now. Query builder otag/art search " +
      "returns nothing until this finishes.");
    refreshTags({ force: true }).catch(() => {});
  }
  return state.ready;
}

module.exports = {
  init, refreshBulk, refreshSets, status,
  one, collection, autocomplete, printings, legality, search, sets, resolveSetCode,
  refreshTags, tagSearch, tagsStatus,
  priceFor, cardByKey, cardById, localOne, all, bySet, setCompletion, applyPriceSource, oracleFinishTotal,
  normNum, printKey, collectorVariants, trim,
  liveFetch, flushLive,
  get count() { return state.count; },
  get ready() { return state.ready; }
};
