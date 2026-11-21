"use strict";
/* The daily notification pass (#139): watch-list price targets hit, a
   watched card that starts SELLING FAST (#369), and "a friend now has a
   card on your watch list". Run once a day by runDueJobs()
   (jobs.notifyDay), after the day's price snapshot.

   SELLING FAST (#369) is Manapool's per-printing flag (mpSales hotFor, the
   one Movers shows); opts.fastNow(items) answers it per watch item. Manapool
   counts a printing (set + collector number) across finishes and languages,
   so "a watched card is selling fast" means its printing is, and two watch
   rows of one printing (foil and non-foil) make ONE notification. Only
   `true` counts: null (too little history to compare paces yet) is silent.
   The ref has no day in it, so the dedupe below makes it a transition
   alert: told once when it starts, nothing while it stays hot. A small
   7-day window with low thresholds can flicker across the line (hot, not,
   hot), so these pass notify() a FAST_COOLOFF_DAYS cool-off: told again
   only after more than that many days without the flag.

   Scale (CLAUDE.md): a collection reaches ~70k stacks, and the friend
   check must never scan friends' collections per request. So this reads
   ONE collection at a time, in two sequential sweeps, keeping only small
   extracts between reads:
     1. every inventory (each active account's personal one, every active
        store): its watch list, capped at WATCH_CAP items. Price alerts are
        worked out right there.
     2. every account that shares at Full, personally, with at least one
        active watcher: its shared inventory, reduced to the oracle ids
        those watchers want.
   "A friend" is the owner's rule (2026-10-10): someone who shared with
   the watcher BY NAME (sharing.personalLevel), at Full, and since #140 is
   an accepted friend (friends.levelBetween). A Summary share
   never triggers it, and neither does an "everyone else on this server"
   share alone. Disabled accounts are skipped on both sides (#142).

   Dedupe: notify() with { day, prevDay } (notifications.js). A re-run on
   the same day (a restart) adds nothing; an alert still standing from the
   previous pass stays as it is; only a fresh crossing notifies again.
   NEW_CAP bounds how many new items one account gets per pass. An account
   at the cap still goes through notify(), with noNew, so its standing
   alerts keep their day stamp (else the next pass would take them for
   fresh crossings and mark them unread again). */

const store = require("./store");
const orgs = require("./orgs");
const actFrom = require("./actFrom");
const friends = require("./friends");
const notifications = require("./notifications");
const notifyEvents = require("./notifyEvents");

const WATCH_CAP = 500;
const NEW_CAP = 20;
const FAST_COOLOFF_DAYS = 7;

const enc = encodeURIComponent;
const money = n => "$" + Number(n).toFixed(2);

function watchExtract(state) {
  const list = state && Array.isArray(state.watchList) ? state.watchList : [];
  return list.slice(0, WATCH_CAP).filter(w => w && typeof w.id === "string").map(w => ({
    id: w.id, name: String(w.name || "").slice(0, 120), set: w.set, collector: w.collector, lang: w.lang || "en",
    finish: w.finish || "nonfoil", oracleId: typeof w.oracleId === "string" ? w.oracleId : "",
    target: Number(w.target) > 0 ? Number(w.target) : null, targetDir: w.targetDir === "above" ? "above" : "below"
  }));
}

// One Manapool printing: what SELLING FAST is counted on.
const printingOf = w => String(w.set).toLowerCase() + "|" + String(w.collector);

/* The watched printings flagged SELLING FAST, one watch item per printing
   (the first on the list), in list order. */
async function fastHits(items, fastNow) {
  if (!items.length || typeof fastNow !== "function") return [];
  const flags = await fastNow(items);
  const seen = new Set(), out = [];
  items.forEach((w, i) => {
    if (!flags || flags[i] !== true) return;
    const p = printingOf(w);
    if (seen.has(p)) return;
    seen.add(p);
    out.push(w);
  });
  return out;
}

/* opts.priceNow(items) -> array of today's price (or null), same order.
   opts.fastNow(items) -> array of true / false / null (SELLING FAST on
   Manapool, null = can't compare yet), same order.
   Returns counts for the log. */
async function runDaily(opts) {
  const day = opts.day, prevDay = opts.prevDay || null;
  const priceNow = opts.priceNow, fastNow = opts.fastNow;
  const stats = { inventories: 0, collectionsRead: 0, priceAlerts: 0, fastAlerts: 0, friendHas: 0 };
  const newCount = new Map();
  const bump = (id, r) => { if (r === "new" || r === "updated") newCount.set(id, (newCount.get(id) || 0) + 1); };
  const passOpts = id => ({ day, prevDay, noNew: (newCount.get(id) || 0) >= NEW_CAP });

  const users = (await store.readUsers()).users.filter(u => u && !u.disabled);
  const stores = (await orgs.listAllStores()).filter(s => !s.archived);
  const storeName = new Map(stores.map(s => [s.id, s.name || "Store"]));

  // ---- sweep 1: watch lists, one inventory at a time ----
  const keys = users.filter(u => !u.orgId).map(u => u.id).concat(stores.map(s => "store:" + s.id));
  const watchByKey = new Map();
  for (const key of keys) {
    let coll = await store.readCollection(key);
    stats.collectionsRead++;
    const watch = watchExtract(coll && coll.state);
    coll = null;
    if (!watch.length) continue;
    stats.inventories++;
    watchByKey.set(key, watch);
    const printed = watch.filter(w => w.set && w.collector);
    const targeted = printed.filter(w => w.target != null);
    let hits = [];
    if (targeted.length && typeof priceNow === "function") {
      const nows = await priceNow(targeted);
      hits = targeted.map((w, i) => ({ w, now: nows[i] }))
        .filter(h => h.now != null && (h.w.targetDir === "above" ? h.now >= h.w.target : h.now <= h.w.target));
    }
    const fast = await fastHits(printed, fastNow);
    if (!hits.length && !fast.length) continue;
    const readers = await notifyEvents.inventoryReaders(key);
    const prefix = key.startsWith("store:") ? storeName.get(key.slice(6)) + ": " : "";
    for (const { w, now } of hits) {
      for (const u of readers) {
        const r = (await notifications.notify([u.id], {
          kind: "price-alert", ref: key + ":" + w.id + ":" + w.targetDir + w.target,
          text: prefix + w.name + " is " + money(now) + ", your target was " + (w.targetDir === "above" ? "≥ " : "≤ ") + money(w.target) + ".",
          link: "/buy-list.html?watch=" + enc(w.id), scope: { t: "inv", key }
        }, passOpts(u.id)))[u.id];
        bump(u.id, r);
        if (r === "new" || r === "updated") stats.priceAlerts++;
      }
    }
    for (const w of fast) {
      const label = w.name + " (" + String(w.set).toUpperCase() + " #" + w.collector + ")";
      for (const u of readers) {
        const r = (await notifications.notify([u.id], {
          kind: "watch-fast", ref: key + ":fast:" + printingOf(w),
          text: prefix + label + " is SELLING FAST on Manapool: sales in the last 7 days are well above its usual pace.",
          link: "/buy-list.html?watch=" + enc(w.id), scope: { t: "inv", key }
        }, Object.assign(passOpts(u.id), { standDays: FAST_COOLOFF_DAYS })))[u.id];
        bump(u.id, r);
        if (r === "new" || r === "updated") stats.fastAlerts++;
      }
    }
  }

  // ---- who watches what, from the inventory they share and trade from ----
  const watchers = [];
  for (const u of users) {
    const src = await actFrom.resolve(u);
    const watch = src && src.owner ? watchByKey.get(src.owner) : null;
    const wanted = watch ? watch.filter(w => w.oracleId) : [];
    if (wanted.length) watchers.push({ user: u, key: src.owner, wanted });
  }

  // ---- sweep 2: each sharer's inventory, one at a time ----
  if (watchers.length) {
    const fdoc = await friends.read();
    for (const f of users) {
      const prefs = await store.readPrefs(f.id);
      const viewers = [];
      for (const w of watchers) {
        if (w.user.id === f.id) continue;
        if (friends.levelBetween(fdoc, f, prefs, w.user, { personal: true }) === "full") viewers.push(w);
      }
      if (!viewers.length) continue;
      const src = await actFrom.resolve(f, prefs);
      if (!src || !src.owner) continue;
      let coll = await store.readCollection(src.owner);
      stats.collectionsRead++;
      const cards = (coll && coll.state && Array.isArray(coll.state.cards)) ? coll.state.cards : [];
      coll = null;
      const wantedAll = new Set();
      for (const v of viewers) for (const x of v.wanted) wantedAll.add(x.oracleId);
      const owned = new Set();
      for (const c of cards) if (c && wantedAll.has(c.oracleId) && Number(c.quantity) > 0) owned.add(c.oracleId);
      const label = f.username + (src.kind === "store" ? " (" + src.storeName + ")" : "");
      for (const w of viewers) {
        if (w.key === src.owner) continue;   // the same inventory on both sides
        for (const x of w.wanted) {
          if (!owned.has(x.oracleId)) continue;
          const r = (await notifications.notify([w.user.id], {
            kind: "friend-has", ref: "friend:" + f.id + ":" + w.key + ":" + x.id,
            text: label + " has " + x.name + ", a card on your watch list.",
            link: "/buy-list.html?watch=" + enc(x.id) + "&friend=" + enc(f.username),
            scope: { t: "friendWatch", key: w.key, friend: f.id, min: "full" }
          }, passOpts(w.user.id)))[w.user.id];
          bump(w.user.id, r);
          if (r === "new" || r === "updated") stats.friendHas++;
        }
      }
    }
  }
  return stats;
}

module.exports = { runDaily, WATCH_CAP, NEW_CAP, FAST_COOLOFF_DAYS };
