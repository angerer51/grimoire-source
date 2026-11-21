"use strict";
/* Daily digest email (2026-10-08, user ask): one email per subscribed
   account, the morning after, covering that account's previous day in
   Grimoire - what they did (their audit trail), what their collection is
   worth and what moved in it, watched cards that crossed a target (#79),
   and what changed in the app itself (help.html's change log).

   Subscription is ON by default for every account (the user asked for it
   "toggled on for all active users"); new accounts choose at sign-up, and
   anyone can leave via the email's own unsubscribe link (one-click, no
   sign-in - see unsubscribeToken()) or Settings -> Account. Stored as
   prefs.digest.unsubscribed, so "never touched" reads as subscribed.

   Never sends an empty email: a day with no activity, no app changes and no
   target hits is skipped for that account (a price wiggle alone isn't news).
   Reuses mailer.send() - the same Resend account password reset uses, with
   the same limitation (README §16: until a sending domain is verified in
   Resend, mail only reaches the operator's own address). */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let store, prices, audit, mailer, cards, orgs, cfg, log = () => {};
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

function init(deps) {
  ({ store, prices, audit, mailer, cards, orgs } = deps);
  cfg = deps.cfg || {};
  if (deps.log) log = deps.log;
}

/* ---------- subscription ---------- */

const isSubscribed = prefs => !(prefs && prefs.digest && prefs.digest.unsubscribed);

async function setSubscribed(userId, on, via) {
  await store.updatePrefs(userId, p => {
    p.digest = Object.assign({}, p.digest, { unsubscribed: !on, changedAt: new Date().toISOString(), via: via || "" });
  });
}

/* HMAC of the user id under the server's master key: lets the email's link
   unsubscribe exactly one account without a session, and can't be forged
   or pointed at someone else. Stable per account, so an old email's link
   keeps working. */
function unsubscribeToken(userId) {
  return store.hmac("digest-unsub:" + userId).slice(0, 32);
}
function verifyToken(userId, token) {
  const want = Buffer.from(unsubscribeToken(String(userId || "")));
  const got = Buffer.from(String(token || ""));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function unsubscribeUrl(userId) {
  return (cfg.baseUrl || "") + "/api/digest/unsubscribe?u=" + encodeURIComponent(userId) +
    "&t=" + encodeURIComponent(unsubscribeToken(userId));
}

/* ---------- dates ---------- */

// Audit shards by UTC date (audit.js dateOf); the digest reports the UTC
// day before `now`, which the morning send (default 07:00 local) always
// sees complete.
function yesterdayUtc(now) {
  const d = new Date(now || Date.now());
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
// help.html's change log labels entries like "Oct 8, 2026".
function changelogLabel(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return MON[m - 1] + " " + d + ", " + y;
}
function longDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US",
    { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

/* ---------- content ---------- */

/* App changes released on `isoDate`, straight from help.html's change log -
   the one place release notes are already written in plain language. */
function appChanges(isoDate) {
  let html;
  try { html = fs.readFileSync(path.join(PUBLIC_DIR, "help.html"), "utf8"); } catch (e) { return []; }
  const label = changelogLabel(isoDate);
  const out = [];
  const rx = /<div class="ce-head"><span class="ce-ver">([^<]+)<\/span><span class="ce-date">([^<]+)<\/span><\/div>\s*<ul>([\s\S]*?)<\/ul>/g;
  let m;
  while ((m = rx.exec(html))) {
    if (m[2].trim() !== label) continue;
    const items = [...m[3].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(x => cleanInline(x[1]));
    out.push({ version: m[1].trim(), items });
  }
  return out;
}
// Change-log <li>s carry a little markup (<b>, <code>, the odd link or icon)
// - keep bold, flatten everything else to text, collapse source wrapping.
function cleanInline(s) {
  return String(s)
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<(?!\/?b>)[^>]+>/g, "")
    .replace(/\s+/g, " ").trim();
}

// Every action the audit log actually records (surveyed from real data,
// 2026-10-08), in plain words. Unknown future actions fall back to the raw
// action name rather than vanishing.
const VERB = {
  add: "Added", remove: "Removed", edit: "Edited", delete: "Deleted", move: "Moved", putaway: "Filed",
  list: "Listing changes", price: "Price updates", import: "Imported", transfer: "Transferred in",
  receipt: "Received", location: "Location changes", ship: "Shipped", pick: "Picked", build: "Pulled into decks",
  cost: "Cost set", undo: "Undid", return: "Returns", "watch-list": "Watch list", "listing-rule": "Listing rules",
  "price-rule": "Price rules", "sealed-add": "Sealed added", "sealed-edit": "Sealed edited",
  "sealed-move": "Sealed moved", "sealed-delete": "Sealed removed",
  lend: "Loan changes", "chase-pick": "Corrected while picking",
  pack: "Packed", "bin-keyed": "Bins keyed without a scan", "bin-scanned": "Bins scanned", "bin-tapped": "Bins confirmed with a tap",
  "pick-reversed": "Picks reversed or put back", "pick-takeover": "Picks taken over", "pick-released": "Picks released", "pick-assigned": "Batches assigned to a picker"
};

/* Where an account's cards and log actually live: a personal account's own
   id, or - for an org member - every Store it can reach, keyed "store:<id>"
   exactly as store.ownerDir() expects. Resolved through orgs.js's own
   accessibleStores(), since an owner/manager reaches every Store in the org
   WITHOUT any storeIds on the account (found the hard way: the first test
   digest to an org owner came back with no collection at all). */
async function ownerKeys(user) {
  if (!user.orgId || !orgs) return [{ key: user.id, store: null }];
  const list = await orgs.accessibleStores(user).catch(() => []);
  return list.map(s => ({ key: "store:" + s.id, store: s.name || "Store" }));
}

/* The account's own audit entries for `isoDate`. A Store's log is shared
   by everyone working in it, so only this account's own entries
   (byUserId) count as "what you did". */
async function activity(user, isoDate, keys) {
  const range = { from: isoDate, to: isoDate, limit: 20000 };
  const entries = [];
  for (const k of keys) {
    try {
      const r = await audit.query(k.key, range);
      entries.push(...(k.store ? r.entries.filter(e => e.byUserId === user.id).map(e => Object.assign({ store: k.store }, e)) : r.entries));
    } catch (e) {}
  }
  entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const byAction = new Map();
  for (const e of entries) {
    const k = e.action || "other";
    const g = byAction.get(k) || { action: k, entries: 0, cards: 0 };
    g.entries++;
    g.cards += Math.abs(Number(e.qty) || 0);
    byAction.set(k, g);
  }
  return { total: entries.length, groups: [...byAction.values()].sort((a, b) => b.entries - a.entries), recent: entries.slice(0, 8) };
}

/* Collection value now, and which held cards moved most since the
   previous snapshot (value-weighted: a $0.50 move on 40 copies outranks a
   $5 move on one). */
async function collectionPicture(user, keys) {
  const list = [], watchList = [];
  for (const k of keys) {
    try {
      const coll = await store.readCollection(k.key);
      const st = (coll && coll.state) || {};
      list.push(...(st.cards || []).filter(c => c && Number(c.quantity) > 0));
      watchList.push(...(st.watchList || []));
    } catch (e) {}
  }
  if (!list.length) return null;
  const cardsTotal = list.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
  const value = list.reduce((s, c) => s + (Number(c.price) || 0) * (Number(c.quantity) || 0), 0);

  const owned = new Map();
  for (const c of list) {
    if (!c.set || !c.collector) continue;
    const key = cards.printKey(c.set, c.collector, c.lang || "en") + "|" + (c.finish || "nonfoil");
    const o = owned.get(key) || { set: c.set, collector: c.collector, lang: c.lang || "en", finish: c.finish || "nonfoil", name: c.name, qty: 0 };
    o.qty += Number(c.quantity) || 0;
    owned.set(key, o);
  }
  let movers = [], valueDelta = null;
  try {
    const w = await prices.watchPrices([...owned.values()], 1, {});
    if (!w.error) {
      const rows = (w.rows || []).map(r => {
        const o = owned.get(r.key + "|" + r.finish);
        return o && r.delta != null ? { name: o.name, qty: o.qty, now: r.now, delta: r.delta, pct: r.pct, move: r.delta * o.qty } : null;
      }).filter(Boolean);
      // null (shown as "—"), not $0.00, when nothing held has two days of prices yet.
      valueDelta = rows.length ? rows.reduce((s, r) => s + r.move, 0) : null;
      movers = rows.filter(r => Math.abs(r.move) >= 0.5).sort((a, b) => Math.abs(b.move) - Math.abs(a.move)).slice(0, 5);
    }
  } catch (e) {}
  const stores = keys.filter(k => k.store).map(k => k.store);
  return { cards: cardsTotal, stacks: list.length, value, valueDelta, movers, watchList, stores };
}

async function targetHits(watchList) {
  const withTarget = (watchList || []).filter(w => Number(w.target) > 0);
  if (!withTarget.length) return [];
  try {
    const w = await prices.watchPrices(withTarget.map(x => ({ set: x.set, collector: x.collector, lang: x.lang, finish: x.finish })), 30, {});
    const byKey = new Map((w.rows || []).map(r => [r.key + "|" + r.finish, r]));
    return withTarget.map(x => {
      const r = byKey.get(cards.printKey(x.set, x.collector, x.lang || "en") + "|" + (x.finish || "nonfoil"));
      const now = r ? r.now : null;
      const hit = now != null && (x.targetDir === "above" ? now >= x.target : now <= x.target);
      return hit ? { name: x.name, now, target: x.target, dir: x.targetDir === "above" ? "above" : "below" } : null;
    }).filter(Boolean);
  } catch (e) { return []; }
}

/* Everything one account's digest says for `isoDate`, or null-worthy
   emptiness the caller uses to skip sending. */
async function build(user, isoDate) {
  const keys = await ownerKeys(user);
  const [act, pic] = await Promise.all([activity(user, isoDate, keys), collectionPicture(user, keys)]);
  const hits = pic ? await targetHits(pic.watchList) : [];
  const changes = appChanges(isoDate);
  return {
    user, date: isoDate, activity: act, collection: pic, hits, changes,
    newsworthy: act.total > 0 || changes.length > 0 || hits.length > 0
  };
}

/* ---------- rendering ---------- */

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = n => n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = n => (n > 0 ? "+" : "") + money(n);

/* One audit entry as one readable line. Entries without a card (a price
   refresh, an import, a rule edit) are best described by their own note;
   a card entry whose quantity didn't change (a listing or detail edit)
   gets its note appended, since that's where the actual change is. */
function describeEntry(e) {
  if (!e.name) return e.note || VERB[e.action] || e.action || "";
  const q = Math.abs(Number(e.qty) || 0);
  const where = e.from && e.to && e.from !== e.to ? " (" + e.from + " → " + e.to + ")"
    : e.to ? " → " + e.to : e.from ? " (from " + e.from + ")" : "";
  const verb = (VERB[e.action] || e.action || "").replace(/ changes$| updates$/, "");
  return (verb + " " + (q ? q + "× " : "") + e.name + where + (!q && e.note ? " — " + e.note : "")).trim();
}

/* Email-safe HTML: tables + inline styles only (no stylesheet, no web
   fonts, no SVG - mail clients strip all three), in the app's industrial
   palette: a dark header strip with the orange rule, light body for
   reading. */
function renderHtml(d) {
  const base = cfg.baseUrl || "";
  const name = d.user.displayName || d.user.username;
  const C = { ink: "#151617", text: "#26272b", muted: "#6b6a64", line: "#e3e1da", orange: "#f26b1d", pos: "#2f8a45", neg: "#c4372f", bg: "#f4f3ef" };
  const mono = "font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;";
  const sans = "font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;";
  const h2 = t => '<tr><td style="padding:22px 28px 6px;' + mono + 'font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:' + C.muted +
    ';"><span style="display:inline-block;width:6px;height:6px;background:' + C.orange + ';margin-right:8px;vertical-align:middle;"></span>' + t + "</td></tr>";
  const para = html => '<tr><td style="padding:2px 28px;' + sans + 'font-size:14px;line-height:1.55;color:' + C.text + ';">' + html + "</td></tr>";
  const rows = [];

  rows.push(para('<p style="margin:0 0 4px;">Hi ' + esc(name) + ", here's your " + esc(longDate(d.date)) + " in Grimoire.</p>"));

  if (d.collection) {
    const c = d.collection;
    const dv = c.valueDelta;
    rows.push(h2(c.stores.length ? (c.stores.length === 1 ? esc(c.stores[0]) : "Your stores") : "Your collection"));
    rows.push(para('<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;"><tr>' +
      stat("Cards", c.cards.toLocaleString("en-US")) + stat("Market value", money(c.value)) +
      stat("Since last snapshot", dv == null ? "—" : signed(dv), dv > 0 ? C.pos : dv < 0 ? C.neg : null) + "</tr></table>"));
    if (c.movers.length) {
      rows.push(para('<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:6px;">' +
        c.movers.map(m => '<tr><td style="padding:5px 0;border-top:1px solid ' + C.line + ';">' + esc(m.name) +
          ' <span style="color:' + C.muted + ';">×' + m.qty + "</span></td>" +
          '<td style="padding:5px 0;border-top:1px solid ' + C.line + ';text-align:right;' + mono + 'font-size:13px;color:' +
          (m.move >= 0 ? C.pos : C.neg) + ';">' + (m.move >= 0 ? "▲ " : "▼ ") + signed(m.move) + "</td></tr>").join("") + "</table>"));
    }
  }

  if (d.hits.length) {
    rows.push(h2("Watch list targets hit"));
    rows.push(para(d.hits.map(h => "<b>" + esc(h.name) + "</b> is " + money(h.now) + " — your target was " +
      (h.dir === "above" ? "≥ " : "≤ ") + money(h.target)).join("<br>") +
      '<br><a href="' + esc(base) + '/buy-list.html" style="color:' + C.orange + ';">Open the Buy List</a>'));
  }

  rows.push(h2("What you did"));
  if (!d.activity.total) {
    rows.push(para('<span style="color:' + C.muted + ';">Nothing logged on your account that day.</span>'));
  } else {
    rows.push(para(d.activity.groups.map(g => "<b>" + esc(VERB[g.action] || g.action) + "</b> " +
      (g.cards ? g.cards.toLocaleString("en-US") + " card" + (g.cards === 1 ? "" : "s") + " · " : "") +
      g.entries + " entr" + (g.entries === 1 ? "y" : "ies")).join("<br>")));
    rows.push(para('<div style="margin-top:8px;' + mono + 'font-size:12px;color:' + C.muted + ';line-height:1.7;">' +
      d.activity.recent.map(e => esc(describeEntry(e))).join("<br>") +
      (d.activity.total > d.activity.recent.length ? "<br>…and " + (d.activity.total - d.activity.recent.length) + " more" : "") +
      '</div><a href="' + esc(base) + '/audit-log.html" style="color:' + C.orange + ';font-size:13px;">Full audit log</a>'));
  }

  if (d.changes.length) {
    rows.push(h2("New in Grimoire"));
    rows.push(para(d.changes.map(ch =>
      '<div style="margin:4px 0 2px;' + mono + 'font-size:12px;color:' + C.orange + ';">' + esc(ch.version) + "</div>" +
      '<ul style="margin:0 0 6px;padding-left:18px;">' + ch.items.map(i => '<li style="margin:3px 0;">' + i + "</li>").join("") + "</ul>"
    ).join("")));
  }

  const unsub = unsubscribeUrl(d.user.id);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + ';">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:' + C.bg + ';"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ' + C.line + ';">' +
    '<tr><td style="background:' + C.ink + ';border-bottom:3px solid ' + C.orange + ';padding:16px 28px;' + mono +
    'font-size:14px;font-weight:600;letter-spacing:.14em;color:#e6e5e0;">GRIMOIRE <span style="color:#8b8a84;font-weight:400;letter-spacing:.06em;">· DAILY DIGEST</span></td></tr>' +
    rows.join("") +
    '<tr><td style="padding:26px 28px 22px;' + sans + 'font-size:12px;line-height:1.6;color:' + C.muted + ';border-top:1px solid ' + C.line + ';">' +
    "You're getting this because daily digests are on for your Grimoire account (" + esc(d.user.username) + "). " +
    '<a href="' + esc(unsub) + '" style="color:' + C.muted + ';">Unsubscribe</a> in one click, or change it any time under ' +
    '<a href="' + esc(base) + '/settings.html" style="color:' + C.muted + ';">Settings → Account</a>.' +
    "</td></tr></table></td></tr></table></body></html>";

  function stat(label, value, color) {
    return '<td style="padding:6px 16px 6px 0;vertical-align:top;"><div style="' + mono + 'font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:' +
      C.muted + ';">' + esc(label) + '</div><div style="' + mono + 'font-size:20px;color:' + (color || C.ink) + ';">' + esc(value) + "</div></td>";
  }
}

function renderText(d) {
  const L = [];
  L.push("Grimoire - daily digest for " + longDate(d.date), "");
  if (d.collection) {
    const c = d.collection;
    L.push(c.stores.length ? c.stores.join(", ").toUpperCase() : "YOUR COLLECTION", "  " + c.cards + " cards, market value " + money(c.value) +
      (c.valueDelta == null ? "" : " (" + signed(c.valueDelta) + " since last snapshot)"));
    for (const m of c.movers) L.push("  " + (m.move >= 0 ? "+" : "-") + " " + m.name + " x" + m.qty + "  " + signed(m.move));
    L.push("");
  }
  if (d.hits.length) {
    L.push("WATCH LIST TARGETS HIT");
    for (const h of d.hits) L.push("  " + h.name + " is " + money(h.now) + " (target " + (h.dir === "above" ? ">= " : "<= ") + money(h.target) + ")");
    L.push("");
  }
  L.push("WHAT YOU DID");
  if (!d.activity.total) L.push("  Nothing logged on your account that day.");
  for (const e of d.activity.recent) L.push("  " + describeEntry(e));
  if (d.activity.total > d.activity.recent.length) L.push("  ...and " + (d.activity.total - d.activity.recent.length) + " more");
  L.push("");
  for (const ch of d.changes) {
    L.push("NEW IN GRIMOIRE " + ch.version);
    for (const i of ch.items) L.push("  - " + i.replace(/<\/?b>/g, ""));
    L.push("");
  }
  L.push("Unsubscribe: " + unsubscribeUrl(d.user.id));
  return L.join("\n");
}

/* ---------- sending ---------- */

/* Every account that would get a digest: not disabled, has an email,
   hasn't unsubscribed. */
async function recipients() {
  const db = await store.readUsers();
  const out = [];
  for (const u of db.users) {
    if (u.disabled || !String(u.email || "").includes("@")) continue;
    const prefs = await store.readPrefs(u.id).catch(() => ({}));
    if (isSubscribed(prefs)) out.push(u);
  }
  return out;
}

async function sendOne(user, isoDate, opts) {
  const d = await build(user, isoDate);
  if (!d.newsworthy && !(opts && opts.force)) return { skipped: "nothing to report" };
  await mailer.send(store, {
    to: user.email,
    bcc: (opts && opts.bcc) || undefined,
    subject: "Your Grimoire day — " + longDate(d.date),
    html: renderHtml(d),
    text: renderText(d),
    // RFC 8058 one-click: Gmail/Outlook show their own "Unsubscribe" button
    // and POST straight to this URL - see the CSRF exemption in index.js.
    headers: { "List-Unsubscribe": "<" + unsubscribeUrl(user.id) + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
  });
  return { sent: true };
}

/* The daily job: every recipient, one at a time with a short gap (Resend's
   default rate limit is a couple of requests a second). One account's
   failure is logged and skipped, never fatal to the rest. */
async function runDaily(opts) {
  const o = opts || {};
  if (!(await mailer.configured(store))) { log("email isn't configured - skipping"); return { skipped: "email not configured" }; }
  const isoDate = o.date || yesterdayUtc();
  const list = await recipients();
  let sent = 0, skipped = 0, failed = 0;
  for (const u of list) {
    try {
      const r = await sendOne(u, isoDate, { bcc: o.bcc, force: o.force });
      if (r.sent) sent++; else skipped++;
    } catch (e) { failed++; log(u.username + ": " + (e.message || e)); }
    await new Promise(r => setTimeout(r, 600));
  }
  log(isoDate + ": " + sent + " sent, " + skipped + " skipped (nothing to report), " + failed + " failed, of " + list.length + " subscribed" +
    (o.bcc ? " (bcc " + o.bcc + ")" : ""));
  return { date: isoDate, recipients: list.length, sent, skipped, failed };
}

module.exports = {
  init, isSubscribed, setSubscribed, unsubscribeToken, verifyToken, unsubscribeUrl,
  yesterdayUtc, appChanges, build, renderHtml, renderText, recipients, sendOne, runDaily
};
