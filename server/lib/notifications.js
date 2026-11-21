"use strict";
/* In-app notifications (#139): the bell in every page's header.
   ------------------------------------------------------------
   One small JSON document per account, notifications/<userId>.json, written
   only through notify() / markRead() / markAllRead() here, each under that
   account's own lock ("notify:<userId>"). This module is storage only: it
   never decides WHO hears about something or whether they may see it. That
   is server/lib/notifyEvents.js (one function per event, called from the
   single place each state change happens) and server/lib/notifyJob.js (the
   daily price-alert, "selling fast" and "a friend has it" pass). The delivery flow is drawn
   in docs/flows/notifications.dot.

   An item: { id, kind, ref, text, link, scope, at, createdAt, read, readAt,
   seenDay }.
   - kind + ref is the dedupe key: a second event for the same thing (the
     same proposal answered, the same price alert the next day) updates the
     existing item instead of stacking another one.
   - text is plain text, worked out for THAT recipient by the event layer
     (never a store name, username or id they can't see). The page escapes
     it; it is never HTML.
   - link is a same-origin relative path (safeLink), and scope says what to
     re-check when it's opened (notifyEvents.canOpen): the list never hands
     the page a link, only POST /api/notifications/:id/open does, after the
     check, so a stale notification can't lead anywhere its reader has lost
     access to.

   Bounded (CLAUDE.md scale rule): at most MAX_ITEMS per account, read items
   older than READ_KEEP_DAYS dropped on every write. The unread count is
   cached in memory (bounded too), so the 60-second poll every open tab
   makes reads no file.

   Adding a kind (as #140's friend requests did): one row in KINDS, naming
   its Settings group and icon, then an event function in notifyEvents.js
   that calls notify(). Nothing else here changes. */

const crypto = require("crypto");
const store = require("./store");

const MAX_ITEMS = 200;
const READ_KEEP_DAYS = 60;
const TEXT_MAX = 300;
const LINK_MAX = 300;
const COUNT_CACHE_MAX = 5000;

/* Settings groups: each can be switched off in Settings -> Account. */
const GROUPS = [
  { id: "trades", label: "Trade offers sent to you, answered or withdrawn" },
  { id: "sharing", label: "Friend requests, and someone starts sharing with you" },
  { id: "support", label: "Replies to your support tickets" },
  { id: "org", label: "Organization and store changes" },
  { id: "wants", label: "A card a customer wants came in" },
  { id: "kiosk", label: "An order sent from the store's kiosk" },
  { id: "watch", label: "Watch-list price targets hit" },
  { id: "watchFast", label: "A card on your watch list starts selling fast" },
  { id: "friendHas", label: "A friend has a card on your watch list" }
];

/* Every kind: its Settings group and its sprite icon. */
const KINDS = {
  "trade-received": { group: "trades", icon: "handshake" },
  "trade-answered": { group: "trades", icon: "handshake" },
  "trade-withdrawn": { group: "trades", icon: "handshake" },
  "share-started": { group: "sharing", icon: "users" },
  "friend-request": { group: "sharing", icon: "user" },
  "friend-accepted": { group: "sharing", icon: "users" },
  "ticket-reply": { group: "support", icon: "life-buoy" },
  "org-added": { group: "org", icon: "users" },
  "org-role": { group: "org", icon: "users" },
  "store-status": { group: "org", icon: "archive" },
  "want-came-in": { group: "wants", icon: "package" },
  "kiosk-order": { group: "kiosk", icon: "receipt" },
  "price-alert": { group: "watch", icon: "target" },
  "watch-fast": { group: "watchFast", icon: "trending-up" },
  "friend-has": { group: "friendHas", icon: "star" }
};

/* Same-origin relative paths only: "/page.html", optional query and hash,
   from a narrow character set. No scheme, no "//host", no backslash, no
   "javascript:". Anything else is refused, so a notification can never
   carry the reader off-site. */
const LINK_RX = /^\/[a-z0-9-]+\.html(\?[A-Za-z0-9=&%._~+-]*)?(#[A-Za-z0-9_-]*)?$/;
function safeLink(link) {
  return typeof link === "string" && link.length <= LINK_MAX && LINK_RX.test(link) ? link : null;
}

const fileOf = userId => store.p("notifications", String(userId).replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
const lockOf = userId => "notify:" + userId;

async function readDoc(userId) {
  const doc = await store.readJson(fileOf(userId), { items: [] });
  return { items: Array.isArray(doc && doc.items) ? doc.items.filter(x => x && typeof x === "object") : [] };
}

/* ---------- unread count cache ---------- */
const counts = new Map();
function cacheCount(userId, n) {
  counts.delete(userId);
  counts.set(userId, n);
  if (counts.size > COUNT_CACHE_MAX) counts.delete(counts.keys().next().value);
}
const unreadIn = items => items.reduce((n, x) => n + (x.read ? 0 : 1), 0);

async function unreadCount(userId) {
  if (counts.has(userId)) return counts.get(userId);
  const n = unreadIn((await readDoc(userId)).items);
  cacheCount(userId, n);
  return n;
}

/* Newest first, read items past READ_KEEP_DAYS gone, then capped at
   MAX_ITEMS by dropping the oldest read items before any unread one. */
function prune(items, now) {
  const cutoff = now - READ_KEEP_DAYS * 86400000;
  let out = items.filter(x => !(x.read && Date.parse(x.readAt || x.at) < cutoff));
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (out.length > MAX_ITEMS) {
    let over = out.length - MAX_ITEMS;
    const drop = new Set();
    for (let i = out.length - 1; i >= 0 && over > 0; i--) if (out[i].read) { drop.add(out[i]); over--; }
    out = out.filter(x => !drop.has(x));
    if (out.length > MAX_ITEMS) out = out.slice(0, MAX_ITEMS);
  }
  return out;
}

async function update(userId, fn) {
  return store.withLock(lockOf(userId), async () => {
    const doc = await readDoc(userId);
    const result = await fn(doc);
    doc.items = prune(doc.items, Date.now());
    await store.writeJson(fileOf(userId), doc);
    cacheCount(userId, unreadIn(doc.items));
    return result;
  });
}

/* Whether the account has switched this kind's group off in Settings. */
async function mutedFor(userId, kind) {
  const prefs = await store.readPrefs(userId).catch(() => ({}));
  const off = prefs && prefs.notify && Array.isArray(prefs.notify.off) ? prefs.notify.off : [];
  return off.includes(KINDS[kind].group);
}

function clean(item) {
  if (!item || !KINDS[item.kind]) throw new Error("Unknown notification kind: " + (item && item.kind));
  const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX) : "";
  if (!text) throw new Error("A notification needs text.");
  const ref = typeof item.ref === "string" && item.ref ? item.ref.slice(0, 200) : null;
  if (!ref) throw new Error("A notification needs a ref.");
  return { kind: item.kind, ref, text, link: safeLink(item.link), scope: item.scope && typeof item.scope === "object" ? item.scope : null };
}

// Whether day string `seen` (YYYY-MM-DD) is 1..n days before `day`.
function withinDays(seen, day, n) {
  if (!n || typeof seen !== "string") return false;
  const a = Date.parse(seen + "T00:00:00Z"), b = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.round((b - a) / 86400000);
  return diff >= 1 && diff <= n;
}

/* Delivers one item to each of userIds. Dedupe by kind + ref:
   - default: an existing item is refreshed (new text, link and time) and
     marked unread again, so repeats never stack;
   - opts.day (the daily pass): an item already seen on `day` is left
     alone, so a re-run the same day (a restart) adds nothing. One seen on
     opts.prevDay (the previous pass) is the same alert still standing: it
     stays read if it was read, and only its text follows the price. One
     not seen since before that is a fresh crossing and notifies again.
   - opts.noNew (the daily pass, once an account has had its NEW_CAP new
     items): nothing new or unread-again is added ("capped"), but an alert
     still standing is stamped with `day` as usual. Skipping notify()
     altogether would leave it unstamped, and the next pass would take it
     for a fresh crossing and mark it unread again.
   - opts.standDays (with opts.day; #369's SELLING FAST alerts): a cool-off.
     An item last seen at most this many days before `day` also counts as
     still standing, even with passes between that didn't send it, so a
     flag flickering on and off across its line doesn't re-alert every
     other day. Price-target alerts don't pass it.
   Returns { userId: "new" | "updated" | "same" | "capped" | "muted" }.
   Never throws for one recipient's failure; the caller's event must not
   fail over it. */
async function notify(userIds, item, opts) {
  const it = clean(item);
  const day = opts && opts.day ? String(opts.day) : null;
  const prevDay = opts && opts.prevDay ? String(opts.prevDay) : null;
  const noNew = !!(opts && opts.noNew);
  const standDays = opts && Number(opts.standDays) > 0 ? Math.floor(Number(opts.standDays)) : 0;
  const out = {};
  for (const userId of [...new Set((userIds || []).filter(id => typeof id === "string" && id))]) {
    try {
      if (await mutedFor(userId, it.kind)) { out[userId] = "muted"; continue; }
      out[userId] = await update(userId, doc => {
        const now = new Date().toISOString();
        const ex = doc.items.find(x => x.kind === it.kind && x.ref === it.ref);
        if (!ex) {
          if (noNew) return "capped";
          doc.items.push(Object.assign({ id: crypto.randomBytes(9).toString("base64url"), createdAt: now, at: now, read: false, readAt: null },
            it, day ? { seenDay: day } : {}));
          return "new";
        }
        if (day && ex.seenDay === day) return "same";
        if (day && ((prevDay && ex.seenDay === prevDay) || withinDays(ex.seenDay, day, standDays))) {
          ex.seenDay = day;
          if (!ex.read) Object.assign(ex, { text: it.text, link: it.link, scope: it.scope });
          return "same";
        }
        if (noNew) return "capped";
        Object.assign(ex, it, { at: now, read: false, readAt: null }, day ? { seenDay: day } : {});
        return "updated";
      });
    } catch (e) { out[userId] = "error: " + e.message; }
  }
  return out;
}

/* What the page gets: no link, no scope, no ref. The link comes from
   open(), after the access re-check. */
async function list(userId) {
  const { items } = await readDoc(userId);
  const sorted = items.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, MAX_ITEMS);
  return sorted.map(x => ({
    id: String(x.id || ""), kind: x.kind, icon: (KINDS[x.kind] || {}).icon || "bell",
    text: String(x.text || ""), at: x.at, read: !!x.read
  }));
}

/* Marks one item read and returns the stored item (or null). */
async function markRead(userId, id) {
  return update(userId, doc => {
    const x = doc.items.find(y => y.id === id);
    if (!x) return null;
    if (!x.read) { x.read = true; x.readAt = new Date().toISOString(); }
    return Object.assign({}, x);
  });
}

/* Marks the item for kind + ref read, if there is one and it's unread
   (#140: an answered or cancelled friend request leaves nothing unread
   that leads nowhere). Writes nothing otherwise. */
async function markReadByRef(userId, kind, ref) {
  const { items } = await readDoc(userId);
  if (!items.some(x => x.kind === kind && x.ref === ref && !x.read)) return false;
  return update(userId, doc => {
    const x = doc.items.find(y => y.kind === kind && y.ref === ref && !y.read);
    if (!x) return false;
    x.read = true;
    x.readAt = new Date().toISOString();
    return true;
  });
}

async function markAllRead(userId) {
  return update(userId, doc => {
    const now = new Date().toISOString();
    let n = 0;
    for (const x of doc.items) if (!x.read) { x.read = true; x.readAt = now; n++; }
    return n;
  });
}

/* Settings: which groups are on. */
async function settings(userId) {
  const prefs = await store.readPrefs(userId);
  const off = prefs && prefs.notify && Array.isArray(prefs.notify.off) ? prefs.notify.off : [];
  return GROUPS.map(g => ({ id: g.id, label: g.label, on: !off.includes(g.id) }));
}
async function setGroup(userId, groupId, on) {
  if (!GROUPS.some(g => g.id === groupId)) { const e = new Error("No such notification type."); e.status = 400; throw e; }
  await store.updatePrefs(userId, prefs => {
    const cur = prefs.notify && Array.isArray(prefs.notify.off) ? prefs.notify.off.filter(x => GROUPS.some(g => g.id === x)) : [];
    const off = new Set(cur);
    if (on) off.delete(groupId); else off.add(groupId);
    prefs.notify = Object.assign({}, prefs.notify, { off: [...off] });
  });
  return settings(userId);
}

/* Tests only: forget cached counts (a test switches data directories). */
function _resetCache() { counts.clear(); }

module.exports = {
  MAX_ITEMS, READ_KEEP_DAYS, GROUPS, KINDS,
  safeLink, notify, list, unreadCount, markRead, markReadByRef, markAllRead, settings, setGroup, prune,
  _resetCache, _fileOf: fileOf
};
