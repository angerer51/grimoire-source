"use strict";
/* The in-store kiosk (#433, part 3 of #402 Order Entry)
   -----------------------------------------------------
   A customer builds their own order on a Grimoire screen in the shop. The
   device runs a kiosk session: its own cookie, its own record in
   kiosk-sessions.json, never an account session. So nothing that reads a
   signed-in user (auth.userFromRequest) ever sees a kiosk, and server/
   index.js refuses a request carrying one on every route that isn't marked
   { kiosk: true }, and every page but /kiosk.html (deny by default: a new
   route is closed to a kiosk until someone opens it on purpose).

   Owner's answers (2026-11-07, on #402):
   - A signed-in Manager or Owner switches the device into kiosk mode for
     the store they're working in (a personal account: its own inventory).
     Their own session on that device ends then, so the public never gets
     it back. Getting out takes the staff PIN (one per account, set by a
     Manager or Owner, throttled like sign-in) and ends at the sign-in page.
     A Manager can also end any kiosk of the store from the Kiosk page.
   - The kiosk shows only that store's stock in its sell-from locations that
     is free to sell (not set aside for an open ticket or a fetched Manapool
     order with no pick list yet, not lent, not held
     on a receipt), at its market price; a card with no market price doesn't
     show. Nothing else of the account reaches it: no costs, customers,
     other orders or staff.
   - Sending an order sets the copies aside at once (an open ticket, source
     "kiosk", that staff pick and hand over like a walk-in), needs a name and
     an email or phone, and lowers Manapool through the store owner's
     connection (orderEntryListing.js). Nothing expires: staff cancel it.

   The stock rules mirror core.js (counterFree / counterFindCards /
   pickAllocations), as priceRules.js mirrors its reservations: the server
   can't run the page's code. test/kiosk.test.js checks the two agree on the
   same inventory. */

const crypto = require("crypto");
const store = require("./store");
const auth = require("./auth");
const orgs = require("./orgs");
const httpu = require("./http");
const orderEntryListing = require("./orderEntryListing");

const COOKIE = "grimoire_kiosk";
const SOURCE = "kiosk";
const DAY_MS = 86400000;
// How long a kiosk runs before a manager starts it again (Help: "The store's kiosk").
const KIOSK_DAYS = 90;

/* ---------- Sessions ---------- */
const sessionsFile = () => store.p("kiosk-sessions.json");
// The cookie value never sits on disk: a copied kiosk-sessions.json opens nothing.
const hashSid = sid => crypto.createHash("sha256").update(String(sid)).digest("base64url");
const readSessions = async () => {
  const d = await store.readJson(sessionsFile(), {});
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
};
const isStoreKey = k => String(k || "").startsWith("store:");

/* May this account run a kiosk on this inventory? A Manager or Owner of the
   store's organization (the store still open), or a personal account on its
   own inventory. Checked when it starts and again on every kiosk request, so
   a manager who is demoted, disabled or removed ends every kiosk they
   started. */
async function canRun(user, ownerKey) {
  if (!user || user.disabled || !ownerKey) return false;
  if (!isStoreKey(ownerKey)) return !user.orgId && String(user.id) === String(ownerKey);
  const s = await orgs.storeById(String(ownerKey).slice("store:".length));
  return !!(s && !s.archived && user.orgId === s.orgId && orgs.isOrgManager(user));
}

async function inventoryName(ownerKey) {
  if (!isStoreKey(ownerKey)) return "";
  const s = await orgs.storeById(String(ownerKey).slice("store:".length));
  return (s && s.name) || "";
}

/* user: the signed-in Manager/Owner; ownerKey: the inventory they're in.
   Resolves { sid, days, id }. */
async function startSession(user, ownerKey, cfg, req) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomBytes(6).toString("hex");
  const days = KIOSK_DAYS;
  const now = Date.now();
  await store.withLock("kiosk-sessions", async () => {
    const all = await readSessions();
    for (const [k, s] of Object.entries(all)) if (!(s && s.exp >= now)) delete all[k];
    all[hashSid(sid)] = { id, ownerKey: String(ownerKey), by: user.id, createdAt: now, exp: now + days * DAY_MS,
      ua: String((req && req.headers["user-agent"]) || "").slice(0, 160) };
    await store.writeJsonCompact(sessionsFile(), all);
  });
  return { sid, days, id };
}

/* The kiosk session this request carries, re-checked now, or null. */
async function sessionFromRequest(req) {
  const sid = httpu.parseCookies(req)[COOKIE];
  if (!sid) return null;
  const key = hashSid(sid);
  const s = (await readSessions())[key];
  if (!s || !(s.exp >= Date.now())) return null;
  const by = await auth.findUserById(s.by);
  if (!(await canRun(by, s.ownerKey))) return null;
  return { key, id: s.id, ownerKey: s.ownerKey, by: s.by, createdAt: s.createdAt };
}

const hasCookie = req => !!httpu.parseCookies(req)[COOKIE];

async function endSession(key) {
  return store.withLock("kiosk-sessions", async () => {
    const all = await readSessions();
    if (!all[key]) return false;
    delete all[key];
    await store.writeJsonCompact(sessionsFile(), all);
    return true;
  });
}

// The kiosks running on one inventory, for its managers (Kiosk page).
async function listSessions(ownerKey) {
  const all = await readSessions(), now = Date.now(), out = [];
  for (const s of Object.values(all)) {
    if (!s || s.ownerKey !== String(ownerKey) || !(s.exp >= now)) continue;
    const by = await auth.findUserById(s.by);
    out.push({ id: s.id, startedAt: new Date(s.createdAt).toISOString(), by: by ? (by.displayName || by.username) : "",
      device: s.ua || "", running: await canRun(by, s.ownerKey) });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function endSessionById(ownerKey, id) {
  return store.withLock("kiosk-sessions", async () => {
    const all = await readSessions();
    const k = Object.keys(all).find(x => all[x] && all[x].id === id && all[x].ownerKey === String(ownerKey));
    if (!k) return false;
    delete all[k];
    await store.writeJsonCompact(sessionsFile(), all);
    return true;
  });
}

const cookie = (sid, cfg, days, req) => httpu.cookieHeader(COOKIE, sid, {
  maxAge: (days || KIOSK_DAYS) * 86400, secure: httpu.isSecureRequest(req, cfg), sameSite: "Strict" });
const clearCookie = (cfg, req) => httpu.cookieHeader(COOKIE, "", { maxAge: 0, secure: httpu.isSecureRequest(req, cfg), sameSite: "Strict" });

/* ---------- The account's kiosk settings: the staff PIN and the limits ----------
   One record per account (#433: "set per account by a manager"): a Store's
   is its organization's, so every store and kiosk of the business shares
   it, and a personal account has its own. Kept in kiosk-accounts.json beside
   the sessions. The PIN is hashed like a password and never sent anywhere.
   The limits (owner, 2026-11-08), changed by a Manager or Owner:
   - maxCards: most cards (copies) in one kiosk order; null = no limit, the default;
   - maxWaiting: most kiosk orders waiting in one store; 50 until a manager
     changes it, null = no limit.
   Whatever they say, an order never takes more copies than are free to sell. */
const accountsFile = () => store.p("kiosk-accounts.json");
const PIN_RX = /^\d{4,8}$/;
const DEFAULT_MAX_WAITING = 50;
const pinProblem = pin => (PIN_RX.test(String(pin == null ? "" : pin)) ? null : "The PIN must be 4 to 8 digits.");
// Whose settings govern this inventory: "org:<id>" for a Store, "user:<id>" for a personal account.
async function pinOwner(ownerKey) {
  if (!isStoreKey(ownerKey)) return "user:" + String(ownerKey);
  const s = await orgs.storeById(String(ownerKey).slice("store:".length));
  return s ? "org:" + s.orgId : null;
}
const readAccounts = async () => {
  const d = await store.readJson(accountsFile(), {});
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
};
async function accountRecord(ownerKey) {
  const k = await pinOwner(ownerKey);
  const d = k ? (await readAccounts())[k] : null;
  return d && typeof d === "object" ? d : {};
}
// Changes the account's record under its lock; fields not in `patch` are kept.
async function patchAccount(ownerKey, patch) {
  const k = await pinOwner(ownerKey);
  if (!k) throw Object.assign(new Error("No such store."), { status: 404 });
  await store.withLock("kiosk-accounts", async () => {
    const all = await readAccounts();
    all[k] = Object.assign({}, all[k], patch);
    await store.writeJson(accountsFile(), all);
  });
}
const hasPin = async ownerKey => !!(await accountRecord(ownerKey)).pinHash;
async function setPin(ownerKey, pin, user) {
  const problem = pinProblem(pin);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  await patchAccount(ownerKey, { pinHash: auth.hashPassword(String(pin)), setAt: new Date().toISOString(), setBy: user.id });
}
async function checkPin(ownerKey, pin) {
  if (!PIN_RX.test(String(pin == null ? "" : pin))) return false;
  const d = await accountRecord(ownerKey);
  return !!(d.pinHash && auth.verifyPassword(String(pin), d.pinHash));
}

/* The limits in force for this inventory: { maxCards, maxWaiting }, null = no limit. */
async function limits(ownerKey) {
  const d = await accountRecord(ownerKey);
  return {
    maxCards: Number.isSafeInteger(d.maxCards) && d.maxCards > 0 ? d.maxCards : null,
    maxWaiting: !("maxWaiting" in d) ? DEFAULT_MAX_WAITING : Number.isSafeInteger(d.maxWaiting) && d.maxWaiting > 0 ? d.maxWaiting : null
  };
}
/* A limit as typed: blank (or null) = no limit, else a whole number of 1 or more. */
function limitValue(v, what) {
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
    throw Object.assign(new Error(what + " must be a whole number of 1 or more, or left blank for no limit."), { status: 400 });
  }
  return n;
}
async function setLimits(ownerKey, body, user) {
  const maxCards = limitValue(body && body.maxCards, "Most cards in one order");
  const maxWaiting = limitValue(body && body.maxWaiting, "Most orders waiting");
  await patchAccount(ownerKey, { maxCards, maxWaiting, limitsSetAt: new Date().toISOString(), limitsSetBy: user.id });
  return limits(ownerKey);
}

/* ---------- Stock free to sell (mirrors core.js) ---------- */
const normNum = n => String(n == null ? "" : n).trim().toLowerCase().replace(/^0+(?=.)/, "");
const COUNTER_SOURCES = ["walkin", SOURCE]; // core.js COUNTER_SOURCES
const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];

// core.js availableQty: nothing while held on an open receipt; lent copies aren't here.
function availableQty(c) {
  if (c && c.held) return 0;
  const lent = c && Array.isArray(c.loans) ? c.loans.reduce((s, l) => s + (Number(l && l.qty) || 0), 0) : 0;
  return Math.max(0, (Number(c && c.quantity) || 0) - lent);
}
// core.js cardLineMatches.
function lineMatches(item, r) {
  if (item.collector) {
    return r.set === item.set && normNum(r.collector) === normNum(item.collector) && r.lang === item.lang &&
      r.finish === item.finish && (!item.condition || r.condition === item.condition);
  }
  return String(r.name || "").toLowerCase() === String(item.name || "").toLowerCase() &&
    (!item.set || r.set === item.set) && r.finish === item.finish && (!item.condition || r.condition === item.condition);
}

// core.js conditionCode: Manapool's condition words as a condition code ("" = any).
const CONDITION_NAMES = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };
function conditionCode(v) {
  v = String(v || "").trim().toLowerCase();
  if (!v) return "";
  if (CONDITIONS.includes(v.toUpperCase())) return v.toUpperCase();
  for (const [code, nm] of Object.entries(CONDITION_NAMES)) if (nm.toLowerCase() === v) return code;
  if (/damaged|^dmg/.test(v)) return "DMG";
  if (/heavily.?played|^hp$/.test(v)) return "HP";
  if (/moderately.?played|^mp$/.test(v)) return "MP";
  if (/lightly.?played|^lp$/.test(v)) return "LP";
  if (/near.?mint|^nm$|^mint$/.test(v)) return "NM";
  return "";
}
// core.js orderIsOpen: anything not finished still holds its copies.
const ORDER_DONE_STATUSES = new Set(["shipped", "delivered", "replaced", "cancelled", "canceled",
  "refunded", "completed", "complete", "fulfilled", "returned", "closed"]);
const orderIsOpen = status => !ORDER_DONE_STATUSES.has(String(status == null ? "" : status).trim().toLowerCase().replace(/[\s-]+/g, "_"));
const pickKey = i => [i.set, normNum(i.collector), i.lang, i.finish || "nonfoil", i.condition || ""].join("|");

/* core.js unpickedManapoolOrders + orderPickItems(o, true): the fetched
   Manapool orders still open that have no pick list in this inventory,
   oldest first, as merged card lines. */
function unpickedOrderLines(state, orders) {
  if (!Array.isArray(orders) || !orders.length) return [];
  const listed = new Set((Array.isArray(state && state.pickLists) ? state.pickLists : []).map(p => p && p.orderId).filter(Boolean).map(String));
  const seen = new Set(), out = [];
  const open = orders.filter(o => {
    if (!o || !o.id || !Array.isArray(o.lines) || !o.lines.length) return false;
    const id = String(o.id);
    if (seen.has(id) || listed.has(id) || !orderIsOpen(o.status)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => String(a.placedAt || "").localeCompare(String(b.placedAt || "")));
  for (const o of open) {
    const byKey = new Map();
    for (const l of o.lines) {
      if (!l || l.kind === "sealed") continue;
      const it = { kind: "card", set: l.set, collector: l.collector, lang: l.lang || "en", finish: l.finish,
        condition: conditionCode(l.condition), name: l.name, qty: l.qty };
      const k = pickKey(it), ex = byKey.get(k);
      if (ex) ex.qty += it.qty; else byKey.set(k, it);
    }
    out.push(...byKey.values());
  }
  return out;
}

/* Copies of each sell-from stack free to sell now: core.js counterFree.
   Every open ticket's lines are allocated first, in ticket order, as
   completing them would (pickAllocations: a Manapool or counter ticket from
   sell-from locations only, the highest pick priority first, then the
   biggest stack), then the fetched Manapool orders that have no pick list
   yet (`orders`, orderEntryListing.fetchedOrders: owner 2026-11-08, a copy
   sold online is held from the moment its order is fetched), as their
   lists would be. What's left is free. Map stack id -> copies. */
function freeStock(state, orders) {
  const cards = (Array.isArray(state && state.cards) ? state.cards : []).filter(r => r && r.id);
  const locs = new Map((Array.isArray(state && state.locations) ? state.locations : []).map(l => [l && l.id, l]));
  const sells = r => { const l = locs.get(r.locationId); return !!(l && l.sellFrom); };
  const prio = id => { const l = locs.get(id); return l ? (l.pickPriority || 0) : 0; };
  const remaining = new Map(cards.map(r => [r.id, availableQty(r)]));
  const lists = (Array.isArray(state && state.pickLists) ? state.pickLists : []).filter(p => p && p.status === "open");
  const lines = [];
  for (const p of lists) {
    const sellOnly = p.source === "manapool" || COUNTER_SOURCES.includes(p.source);
    for (const it of p.lines || []) if (it && it.kind !== "sealed") lines.push({ it, sellOnly });
  }
  for (const it of unpickedOrderLines(state, orders)) lines.push({ it, sellOnly: true });
  if (lines.length) {
    // Index only what the lines ask for (core.js stackLookup), in collection order.
    const printKey = (set, num, lang, finish) => set + "|" + normNum(num) + "|" + lang + "|" + finish;
    const want = new Set(), wantName = new Set();
    for (const { it } of lines) {
      if (it.collector) want.add(printKey(it.set, it.collector, it.lang, it.finish));
      else wantName.add(String(it.name || "").toLowerCase());
    }
    const byPrint = new Map(), byName = new Map();
    const push = (m, k, r) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(r); };
    for (const r of cards) {
      const k = printKey(r.set, r.collector, r.lang, r.finish);
      if (want.has(k)) push(byPrint, k, r);
      const n = String(r.name || "").toLowerCase();
      if (wantName.has(n)) push(byName, n, r);
    }
    for (const { it, sellOnly } of lines) {
      const pool = (it.collector ? byPrint.get(printKey(it.set, it.collector, it.lang, it.finish)) : byName.get(String(it.name || "").toLowerCase())) || [];
      const snap = pool.filter(r => lineMatches(it, r) && (!sellOnly || sells(r)))
        .map(r => ({ r, q: remaining.get(r.id) || 0 })).filter(s => s.q > 0)
        .sort((a, b) => (prio(b.r.locationId) - prio(a.r.locationId)) || (b.q - a.q));
      let need = Number(it.qty) || 0;
      for (const s of snap) {
        if (need <= 0) break;
        const take = Math.min(need, s.q);
        remaining.set(s.r.id, s.q - take);
        need -= take;
      }
    }
  }
  const free = new Map();
  for (const r of cards) if (sells(r)) free.set(r.id, remaining.get(r.id) || 0);
  return free;
}

// One sellable unit (core.js counterKey): a printing in one language, finish and condition.
const unitKey = l => [String(l.set || "").toLowerCase(), normNum(l.collector), l.lang || "en", l.finish || "nonfoil", l.condition || "NM"].join("|");
const priceOf = r => { const n = r && r.price != null && r.price !== "" ? Number(r.price) : NaN; return isFinite(n) && n > 0 ? n : null; };
// core.js rfFold: what a search word is matched against.
function fold(text) {
  let s = String(text == null ? "" : text).toLowerCase().normalize("NFKD"), out = "";
  for (const ch of s) { const c = ch.codePointAt(0); if (c < 0x0300 || c > 0x036f) out += ch; }
  return out.replace(/\/\//g, " ").replace(/[^a-z0-9 ]+/g, "");
}

/* What the browse filters (#438) sort a card by: its colours, the type it's
   filed under and its rarity. From the stack (core.js copies the card's
   details onto it when it's received), else the card index: one lookup per
   unit, only for a stack that came in without them. */
const COLORS = ["W", "U", "B", "R", "G"];
// core.js mainType: Artifact Creature is a creature, Artifact Land a land; only the front face counts.
const MAIN_TYPES = ["Creature", "Planeswalker", "Battle", "Land", "Instant", "Sorcery", "Artifact", "Enchantment", "Kindred", "Tribal"];
function mainType(typeLine) {
  const words = new Set(String(typeLine || "").split("//")[0].split("—")[0].trim().split(/\s+/));
  for (const t of MAIN_TYPES) if (words.has(t)) return t === "Tribal" ? "Kindred" : t;
  return "";
}
const RARITIES = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
// The card index (server/lib/cards.js), required on first use: the kiosk's tests run without one loaded.
let cardsLib = null;
function indexCard(r, lang) {
  try {
    if (!cardsLib) cardsLib = require("./cards");
    return cardsLib.cardByKey(r.set, r.collector, lang) || null;
  } catch (e) { return null; }
}
function sortFields(r) {
  let c = null;
  const ix = () => (c === null ? (c = indexCard(r, r.lang || "en") || false) : c);
  const colorsOf = a => Array.isArray(a) ? COLORS.filter(x => a.includes(x)).join("") : null;
  // A saved stack always has colors ([] until its card details are filled in), so they
  // only count with a typeLine beside them; else the index says (a bare Bolt is red, not colorless).
  let colors = r.typeLine ? colorsOf(r.colors) : null, typeLine = r.typeLine, rarity = r.rarity;
  if (colors == null && ix()) colors = colorsOf(ix().colors);
  if (!typeLine && ix()) typeLine = ix().typeLine;
  if (!rarity && ix()) rarity = ix().rarity;
  rarity = String(rarity || "").toLowerCase();
  return { colors, type: mainType(typeLine), rarity: RARITIES.includes(rarity) ? rarity : "" };
}
// Manapool keys its sales by the English printing's id (server/index.js moversMpId).
function salesId(r) {
  const en = indexCard(r, "en");
  if (en && !en.langFallback) return en.id || "";
  if ((r.lang || "en") === "en") return String(r.scryfallId || "");
  const own = indexCard(r, r.lang);
  return (own && !own.langFallback && own.id) || "";
}

/* Every unit the kiosk may offer: in a sell-from location, at least one copy
   free, and a market price (the first stack of the unit with one, as
   core.js counterFindCards). Only the fields a customer sees, and what the
   filters and the Popular row need (colors, type, rarity, sid), which
   shown() never sends. */
function kioskUnits(state, orders) {
  const free = freeStock(state, orders);
  const by = new Map(), folded = new Map();
  for (const r of Array.isArray(state && state.cards) ? state.cards : []) {
    if (!r || !free.has(r.id) || r.kind === "sealed") continue;
    const key = unitKey(r);
    let u = by.get(key);
    if (!u) {
      let n = folded.get(r.name);
      if (n === undefined) folded.set(r.name, n = fold(r.name));
      u = { key, name: String(r.name || ""), set: String(r.set || ""), setName: String(r.setName || ""), collector: String(r.collector || ""),
        lang: r.lang || "en", finish: r.finish || "nonfoil", condition: r.condition || "NM", price: null, free: 0,
        imageUrl: "", hay: n + " " + fold(r.set) + " " + fold(r.collector), stack: r };
      by.set(key, u);
    }
    u.free += free.get(r.id) || 0;
    if (u.price == null) u.price = priceOf(r);
    if (!u.imageUrl && typeof r.imageUrl === "string" && /^https:\/\//.test(r.imageUrl)) u.imageUrl = r.imageUrl;
    if (!u.setName && r.setName) u.setName = String(r.setName);
  }
  const out = [...by.values()].filter(u => u.free > 0 && u.price != null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.set.localeCompare(b.set) ||
      a.collector.localeCompare(b.collector, undefined, { numeric: true }) || a.finish.localeCompare(b.finish) ||
      CONDITIONS.indexOf(a.condition) - CONDITIONS.indexOf(b.condition));
  // Only for what's offered, and the stack isn't kept: the cache holds the units, not the collection.
  const sids = new Map();
  for (const u of out) {
    Object.assign(u, sortFields(u.stack));
    const pk = u.set.toLowerCase() + "|" + normNum(u.collector) + "|" + u.lang;
    if (!sids.has(pk)) sids.set(pk, salesId(u.stack));
    u.sid = sids.get(pk);
    delete u.stack;
  }
  return out;
}

/* What the filters offer: only the sets, colours, types and rarities that
   are in stock, so no choice leads to an empty screen. */
function facetsOf(units) {
  const sets = new Map(), types = new Set(), rarities = new Set(), colors = new Set();
  for (const u of units) {
    const code = u.set.toLowerCase();
    if (!sets.has(code)) sets.set(code, u.setName || u.set.toUpperCase());
    if (u.type) types.add(u.type);
    if (u.rarity) rarities.add(u.rarity);
    if (u.colors != null) {
      if (!u.colors) colors.add("C");
      else { for (const x of u.colors) colors.add(x); if (u.colors.length > 1) colors.add("M"); }
    }
  }
  return {
    sets: [...sets].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])),
    colors: COLORS.concat(["M", "C"]).filter(x => colors.has(x)),
    types: MAIN_TYPES.filter(t => types.has(t)),
    rarities: RARITIES.filter(r => rarities.has(r))
  };
}

/* The offer per inventory, kept while the saved collection and the fetched
   Manapool orders are unchanged (their stamps), so typing in the search box
   doesn't re-read a big inventory per letter. Bounded: a few inventories
   (one per shop with a kiosk in use), each only its offered units, their
   filter choices and which of them are selling fast. */
const OFFER_CACHE_MAX = 3;
const offers = new Map(); // ownerKey -> { stamp, units, facets, hot }
async function offerEntry(ownerKey) {
  const key = store.canonicalOwner(ownerKey);
  const fetched = await orderEntryListing.fetchedOrders(key);
  const stamp = (await store.collectionStamp(key)) + "|" + fetched.stamp;
  const hit = offers.get(key);
  if (hit && hit.stamp === stamp) { offers.delete(key); offers.set(key, hit); return hit; }
  return store.readCollectionLocked(key, (doc, lockedStamp) => {
    const units = kioskUnits(doc.state || {}, fetched.orders);
    const entry = { stamp: lockedStamp + "|" + fetched.stamp, units, facets: facetsOf(units), hot: null };
    offers.delete(key);
    offers.set(key, entry);
    while (offers.size > OFFER_CACHE_MAX) offers.delete(offers.keys().next().value);
    return entry;
  });
}

/* SELLING FAST (#366's Manapool flag, the one behind Sold 7d on Listings
   and Card Inventory) for the offered units: unit key -> copies sold this
   week, for the Popular row's order. The customer only ever gets a yes:
   no counts. Worked out again when the sales move on (mpSales.dataKey);
   no price archive open, no Popular row. Swappable for the tests. */
let salesSource = {
  key: () => require("./mpSales").dataKey(),
  bySid: sids => require("./mpSales").soldFor(sids).bySid
};
function setSalesSource(src) { salesSource = src; for (const e of offers.values()) e.hot = null; }
function hotOf(entry) {
  let key;
  try { key = salesSource.key(); } catch (e) { return new Map(); }
  if (entry.hot && entry.hot.key === key) return entry.hot.map;
  const map = new Map();
  try {
    const bySid = salesSource.bySid([...new Set(entry.units.map(u => u.sid).filter(Boolean))]);
    for (const u of entry.units) {
      const x = u.sid ? bySid.get(u.sid) : null;
      if (x && x.hot === true) map.set(u.key, Number(x.copies7) || 0);
    }
  } catch (e) { /* no sales history to compare: nothing is selling fast */ }
  entry.hot = { key, map };
  return map;
}

const FIND_MAX = 40;        // cards per page of the grid
const PAGE_MAX = 250;       // pages: 10,000 cards in, the filters are the way on
const POPULAR_MAX = 12;
const shown = (u, hot) => Object.assign({ key: u.key, name: u.name, set: u.set, setName: u.setName, collector: u.collector, lang: u.lang,
  finish: u.finish, condition: u.condition, price: u.price, free: u.free, imageUrl: u.imageUrl }, hot && hot.has(u.key) ? { popular: true } : {});

/* The filters from the kiosk's request (GET /api/kiosk/search): set code,
   colours (W U B R G, M multicolour, C colourless: a card with any of them),
   card type, rarity, a price range, and the page. Anything else is ignored. */
function filtersFrom(params) {
  const get = k => String((params && params.get(k)) || "").trim();
  const num = k => { const v = get(k); const n = v === "" ? NaN : Number(v); return isFinite(n) && n >= 0 ? n : null; };
  const page = Math.floor(Number(get("page")) || 0);
  return {
    set: get("set").toLowerCase().slice(0, 12),
    colors: [...new Set(get("colors").toUpperCase().split(/[\s,]+/).filter(c => COLORS.includes(c) || c === "M" || c === "C"))],
    type: MAIN_TYPES.includes(get("type")) ? get("type") : "",
    rarity: RARITIES.includes(get("rarity").toLowerCase()) ? get("rarity").toLowerCase() : "",
    min: num("min"), max: num("max"),
    page: Math.max(0, Math.min(PAGE_MAX - 1, page)),
    facets: get("facets") === "1", popular: get("popular") === "1"
  };
}
function matcher(f) {
  const tests = [];
  if (f.set) tests.push(u => u.set.toLowerCase() === f.set);
  if (f.colors && f.colors.length) tests.push(u => u.colors != null && f.colors.some(c =>
    c === "C" ? !u.colors : c === "M" ? u.colors.length > 1 : u.colors.includes(c)));
  if (f.type) tests.push(u => u.type === f.type);
  if (f.rarity) tests.push(u => u.rarity === f.rarity);
  if (f.min != null) tests.push(u => u.price >= f.min);
  if (f.max != null) tests.push(u => u.price < f.max);
  return u => tests.every(t => t(u));
}

/* The kiosk's search and browse (#438). Every word must be in the name, set
   code or number; with no words it's the whole offer (browse). The filters
   narrow either. A page of FIND_MAX at a time. On request, the filter
   choices (facets) and the Popular row: up to POPULAR_MAX selling-fast
   cards, one copy per card (the best condition, then the cheapest), the
   fastest sellers first. */
async function search(ownerKey, text, filters) {
  const f = Object.assign({ page: 0 }, filters || {});
  const terms = fold(String(text || "").slice(0, 100)).split(/\s+/).filter(Boolean);
  const entry = await offerEntry(ownerKey);
  const hot = hotOf(entry);
  const ok = matcher(f);
  const from = f.page * FIND_MAX, hits = [];
  let seen = 0;
  for (const u of entry.units) {
    if (terms.length && !terms.every(t => u.hay.includes(t))) continue;
    if (!ok(u)) continue;
    if (seen++ < from) continue;
    hits.push(u);
    if (hits.length > FIND_MAX) break;
  }
  const out = { rows: hits.slice(0, FIND_MAX).map(u => shown(u, hot)), more: hits.length > FIND_MAX, page: f.page };
  if (f.facets) out.facets = entry.facets;
  if (f.popular) {
    const best = new Map();
    for (const u of entry.units) {
      if (!hot.has(u.key)) continue;
      const b = best.get(u.name);
      if (!b || CONDITIONS.indexOf(u.condition) < CONDITIONS.indexOf(b.condition) ||
        (u.condition === b.condition && u.price < b.price)) best.set(u.name, u);
    }
    out.popular = [...best.values()].sort((a, b) => (hot.get(b.key) - hot.get(a.key)) || a.name.localeCompare(b.name))
      .slice(0, POPULAR_MAX).map(u => shown(u, hot));
  }
  return out;
}

/* ---------- Sending an order ---------- */
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const refuse = (status, error, extra) => Object.assign(new Error(error), { status }, extra || {});

/* "Name" and "email or phone", both required (owner's answer 10). */
function customerFrom(body) {
  const name = String((body && body.name) || "").replace(/\s+/g, " ").trim();
  const contact = String((body && body.contact) || "").trim();
  if (!name) throw refuse(400, "Enter your name.", { field: "name" });
  if (name.length > 80) throw refuse(400, "That name is too long.", { field: "name" });
  if (!contact) throw refuse(400, "Enter your email or phone number.", { field: "contact" });
  if (contact.length <= 254 && EMAIL_RX.test(contact)) return { id: "", name, email: contact.toLowerCase(), phone: "" };
  const digits = contact.replace(/\D/g, "");
  if (/^[0-9+()\-. ]+$/.test(contact) && digits.length >= 7 && digits.length <= 15) return { id: "", name, email: "", phone: contact };
  throw refuse(400, "That doesn't look like an email address or a phone number.", { field: "contact" });
}

function nextOrderId(lists) {
  const prefix = "KIOSK-" + new Date().getFullYear() + "-";
  let max = 0;
  for (const p of lists) {
    if (!p || !String(p.id || "").startsWith(prefix)) continue;
    const n = parseInt(String(p.id).slice(prefix.length), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(4, "0");
}

/* Writes the order as an open ticket, under the inventory's lock, from what
   the saved inventory has free right now: the customer's screen names only
   which cards and how many; prices and stock are the server's. Resolves
   { ticket } (the saved ticket) or throws { status, error } for the page:
   409 when a card isn't free in that number any more (with `short`, the
   unit keys and what's left). */
async function placeOrder(ownerKey, body) {
  const customer = customerFrom(body);
  const want = new Map();
  // An order's size is bounded by what's free to sell, and by the account's own limit if a manager set one.
  for (const l of Array.isArray(body && body.lines) ? body.lines : []) {
    const qty = Number(l && l.qty);
    const key = typeof (l && l.key) === "string" ? l.key.slice(0, 200) : "";
    if (!key || !Number.isSafeInteger(qty) || qty < 1) throw refuse(400, "Each card needs a quantity of 1 or more.");
    want.set(key, (want.get(key) || 0) + qty);
  }
  if (!want.size) throw refuse(400, "Add at least one card to your order.");
  const lim = await limits(ownerKey);
  const cards = [...want.values()].reduce((s, n) => s + n, 0);
  if (lim.maxCards != null && cards > lim.maxCards) {
    throw refuse(400, "A kiosk order can have up to " + lim.maxCards + " card" + (lim.maxCards === 1 ? "" : "s") + ". Please ask at the counter for more.", { field: "lines" });
  }
  // Read just before the lock: an order fetched since still holds its copies on the next search.
  const { orders } = await orderEntryListing.fetchedOrders(ownerKey);
  const out = await store.updateCollection(ownerKey, state => {
    if (!Array.isArray(state.pickLists)) state.pickLists = [];
    if (lim.maxWaiting != null && state.pickLists.filter(p => p && p.source === SOURCE && p.status === "open").length >= lim.maxWaiting) {
      throw refuse(409, "The kiosk can't take more orders right now. Please ask at the counter.");
    }
    const units = new Map(kioskUnits(state, orders).map(u => [u.key, u]));
    const lines = [], short = [];
    for (const [key, qty] of want) {
      const u = units.get(key);
      if (!u || u.free < qty) { short.push({ key, free: u ? u.free : 0 }); continue; }
      lines.push({ kind: "card", set: u.set.toLowerCase(), collector: u.collector, lang: u.lang, finish: u.finish, condition: u.condition,
        name: u.name, qty, unitPrice: u.price, marketPrice: u.price });
    }
    if (short.length) throw refuse(409, "Some cards just sold out or have fewer copies left. Your order has been updated: check it and send it again.", { short });
    const now = new Date().toISOString();
    const ticket = { id: nextOrderId(state.pickLists), source: SOURCE, orderId: null, orderLabel: null, orderPayment: null,
      status: "open", createdAt: now, pickedAt: null, shippedAt: null, customer, lines };
    state.pickLists.push(ticket);
    return { write: true, result: ticket };
  });
  // The offer changed: the next search reads it again (its stamp moved too).
  offers.delete(store.canonicalOwner(ownerKey));
  return { ticket: out.result };
}

/* What the customer's screen is told back: the number, the cards, the total. */
function receipt(ticket) {
  const total = Math.round(ticket.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0) * 100) / 100;
  return { id: ticket.id, cards: ticket.lines.reduce((s, l) => s + l.qty, 0), total };
}

/* Manapool's answer for a kiosk order (orderEntryListing.orderEntrySync) as
   the warning staff see on its ticket (the same words as core.js
   listingWarning for a walk-in), or "" when there's nothing to say. */
function listingWarning(sync) {
  if (!sync) return "";
  if (!sync.connected) {
    return sync.store && sync.reason === "not-connected"
      ? "Manapool wasn't updated: the store isn't connected to Manapool. The store's owner can connect it in Settings → Integrations." : "";
  }
  const failed = (sync.results || []).filter(r => r && r.card && !r.ok).map(r => r.card);
  if (!failed.length) return "";
  const names = failed.map(c => c.name + (c.set ? " (" + String(c.set).toUpperCase() + (c.collector ? " #" + c.collector : "") + ")" : ""));
  return "Manapool wasn't lowered for " + names.join(", ") + ". Lower " + (names.length === 1 ? "that listing" : "those listings") +
    " on Manapool by hand so an online buyer can't buy the same copies.";
}

/* Puts that warning on the saved ticket, if it's still there. */
async function noteListingWarning(ownerKey, ticket, text) {
  if (!text) return;
  await store.updateCollection(ownerKey, state => {
    const p = (Array.isArray(state.pickLists) ? state.pickLists : []).find(x => x && x.id === ticket.id && x.createdAt === ticket.createdAt);
    if (!p) return { write: false };
    p.listingWarning = text.slice(0, 1000);
    return { write: true };
  });
}

module.exports = {
  COOKIE, SOURCE, canRun, inventoryName, startSession, sessionFromRequest, hasCookie, endSession, listSessions, endSessionById,
  cookie, clearCookie, hasPin, setPin, checkPin, pinProblem, pinOwner,
  freeStock, kioskUnits, unpickedOrderLines, unitKey, search, filtersFrom, setSalesSource, mainType, placeOrder, receipt, customerFrom, listingWarning, noteListingWarning,
  limits, setLimits, DEFAULT_MAX_WAITING, FIND_MAX, POPULAR_MAX
};
