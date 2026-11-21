"use strict";
/* Per-user audit log, day-sharded like server/lib/prices.js shards price
   history - one small file per day instead of one array embedded in the
   collection document. That embedding used to mean every autosave, every
   server-side revision (store.js's REVISIONS), and every client-side undo
   snapshot carried the whole audit history along with it; a day file only
   ever holds one day's worth of entries, so retention (keepDays) no longer
   multiplies through any of that. */

const fsp = require("fs/promises");
const path = require("path");
const store = require("./store");

let cfg = { audit: {} };

/* ownerKey is either a bare user id (today's exact users/<id>/audit/day
   layout, unchanged) or "store:<id>" (BACKLOG.md #9) - store.ownerDir()
   is the single place that distinction is resolved, so this reuses it
   rather than duplicating the "users" vs "stores" branch here too. */
const dayDir = ownerKey => path.join(store.ownerDir(ownerKey), "audit", "day");
const dayFile = (ownerKey, date) => path.join(dayDir(ownerKey), date + ".json");

function keepDays() {
  return Math.max(7, Number(cfg.audit && cfg.audit.keepDays) || 90);
}

/* ts arrives from POST /api/audit's request body - client-controlled, and
   its first 10 characters become a filename component in dayFile() below.
   A plain length check let anything of the right length through (found in
   a security pass, 2026-09-15): a crafted ts like "../../../x" is 10
   characters and survived the old `s.length >= 10 ? s.slice(0, 10) : ...`
   guard unchanged, landing dayFile() outside audit/day/ entirely - real
   path traversal, reachable by any signed-in account, not just admin.
   Validating the actual YYYY-MM-DD shape (not just length) closes it for
   any future ts regardless of how dayDir()'s own depth changes later. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
function dateOf(ts) {
  const s = String(ts || "");
  return DATE_RE.test(s) ? s.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function availableDates(userId) {
  try {
    return (await fsp.readdir(dayDir(userId)))
      .filter(f => f.endsWith(".json"))
      .map(f => f.slice(0, -5))
      .sort()
      .reverse(); // newest first
  } catch (e) { return []; }
}

async function pruneOld(userId) {
  const cutoff = daysAgo(keepDays());
  try {
    const dir = dayDir(userId);
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      if (f.slice(0, 10) < cutoff) await fsp.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch (e) {}
}

/* Entries arrive newest-first from the client (core.js's logAudit unshifts).
   Grouped by day and merged under one lock per user so two overlapping
   flushes (two tabs, or a retry racing the original request) can't
   interleave their read-modify-write of the same day file. Deduped by id
   so a retried POST doesn't double an entry. */
async function append(userId, entries) {
  const list = Array.isArray(entries) ? entries.filter(e => e && e.id) : [];
  if (!list.length) return { ok: true, appended: 0 };

  const byDate = new Map();
  for (const e of list) {
    const d = dateOf(e.ts);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(e);
  }

  return store.withLock("audit:" + userId, async () => {
    let appended = 0;
    for (const [date, newEntries] of byDate) {
      const file = dayFile(userId, date);
      const existing = await store.readJson(file, []);
      const seen = new Set(existing.map(e => e.id));
      const added = newEntries.filter(e => !seen.has(e.id));
      appended += added.length;
      const merged = existing.concat(added);
      merged.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
      await store.writeJsonCompact(file, merged);
    }
    await pruneOld(userId);
    return { ok: true, appended };
  });
}

function matches(e, action, q, set, collector) {
  if (action && e.action !== action) return false;
  // One printing (the card panel's History link): exact set and collector number.
  if (set && String(e.set || "").toLowerCase() !== set) return false;
  if (collector && String(e.collector == null ? "" : e.collector).toLowerCase() !== collector) return false;
  if (q) {
    const hay = [e.name, e.set, e.collector, e.from, e.to, e.note, e.action, e.receiptId]
      .join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/* Reads whole day files in range, newest day first (each file is already
   newest-first internally from append()'s sort), so the merged result needs
   no further sorting. `total` counts every match in range, not just the
   returned page, so callers can show "showing N of M" the way the old
   in-memory filteredAudit() did.
   opts.total === false (#178): the caller doesn't need that count (the
   Dashboard's Recent activity), so stop reading day files as soon as the
   page is full and return total: null. The newest day file alone usually
   holds it; the count otherwise means parsing the whole log (16-21 MB for
   the biggest owners). */
async function query(userId, opts) {
  const o = opts || {};
  const action = o.action || "";
  const q = String(o.q || "").trim().toLowerCase();
  const from = o.from || null;
  const to = o.to || null;
  // Bounded: a set code or collector number is a few characters.
  const set = String(o.set || "").trim().toLowerCase().slice(0, 16);
  const collector = String(o.collector || "").trim().toLowerCase().slice(0, 16);
  const limit = (o.limit == null || o.limit === "")
    ? 400 : Math.max(0, Math.min(20000, Number(o.limit) || 0));
  const offset = Math.max(0, Number(o.offset) || 0);

  let dates = await availableDates(userId);
  if (from) dates = dates.filter(d => d >= from);
  if (to) dates = dates.filter(d => d <= to);

  const counting = o.total !== false;
  const enough = offset + limit;
  const entries = [];
  let total = 0;
  for (const date of dates) {
    if (!counting && total >= enough) break;
    const rows = await store.readJson(dayFile(userId, date), []);
    for (const e of rows) {
      if (!matches(e, action, q, set, collector)) continue;
      if (total >= offset && entries.length < limit) entries.push(e);
      total++;
      if (!counting && total >= enough) break;
    }
  }
  return { entries, total: counting ? total : null };
}

async function clear(userId) {
  return store.withLock("audit:" + userId, async () => {
    try {
      const dir = dayDir(userId);
      for (const f of await fsp.readdir(dir)) {
        if (f.endsWith(".json")) await fsp.unlink(path.join(dir, f)).catch(() => {});
      }
    } catch (e) {}
    return { ok: true };
  });
}

function init(config) {
  cfg = config || {};
  cfg.audit = cfg.audit || {};
}

module.exports = { init, append, query, clear, pruneOld, availableDates };
