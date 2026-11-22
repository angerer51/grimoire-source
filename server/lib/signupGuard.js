"use strict";
/* Open sign-up guard (#506).
   --------------------------
   With `registration: "open"` and no invite code, POST /api/auth/register
   is a public door that creates an account (and its files under users/)
   for anyone. This keeps that door bounded, the same way the invite-request
   form is (server/lib/inviteRequests.js):

   - a honeypot field (`website`, already on the login page): a filled one
     is answered like a success and nothing is created;
   - at most `perIpPerDay` new accounts per client address in any 24 hours.
     "Address" is addressKey(): an IPv4 address as it is, an IPv6 one by its
     /64, since one IPv6 connection (or a cheap VPS) owns a whole /64 and
     could pick a fresh address for every request;
   - at most `dailyCap` new accounts in any 24 hours across the whole site,
     as a safety valve. It counts every account made in the window (from
     the users' own createdAt, so it survives a restart), but only refuses
     open sign-ups: an invite code still works when it's tripped. The route
     checks it early for a quick answer, and again through capRefusal()
     inside auth.createUser's users lock (opts.refuseIf), where the list is
     current, so a parallel burst can't overshoot it.

   The route (server/index.js) also counts each per-address refusal and
   honeypot hit against the sign-in throttle, under its own "signup:<ip>"
   key (an invite code's "reg:<ip>" is left alone), so a script
   that keeps knocking is locked out for a while.

   The first-ever account and sign-ups with an invite code never come here.

   The per-address counts live in memory on purpose, like the sign-in
   throttle: one process, and forgetting them on restart is a fair trade
   for not adding a store. The map holds at most MAX_IPS addresses (sign-ups
   here are a handful a day; 10k is far past any real day), and is swept of
   stale entries, then trimmed oldest-first, when it grows past that. */

const DAY_MS = 24 * 3600 * 1000;
const MAX_IPS = 10000;
const HONEYPOT = "website";
const DEFAULTS = { perIpPerDay: 3, dailyCap: 200 };
// While the cap stays tripped, server.log gets one line about it this often.
const CAP_LOG_EVERY_MS = 3600 * 1000;

// A positive whole number, or null for "this check is off".
const limitOf = (v, def) => {
  if (v === null || v === false || v === "off") return null;
  const n = Math.floor(Number(v));
  return v === undefined || !Number.isFinite(n) ? def : (n > 0 ? n : null);
};

/* The key one visitor's sign-ups are counted under. IPv4 stays per address;
   IPv6 is cut to its /64 ("2001:db8:1:2::/64"), whichever way it's written
   (zeros dropped or not, "::" anywhere, a zone id, brackets). An
   IPv4-mapped address (::ffff:1.2.3.4) is its IPv4. Anything that doesn't
   parse is used as given. */
function addressKey(ip) {
  let s = String(ip == null ? "" : ip).trim().toLowerCase();
  if (!s.includes(":")) return s;
  s = s.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes its two hex groups.
  const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const b = dotted.slice(2).map(Number);
    if (b.some(x => x > 255)) return s;
    s = dotted[1] + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return s;
  const part = h => (h ? h.split(":") : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return s;
  const groups = head.concat(Array(halves.length === 2 ? fill : 0).fill("0"), tail);
  if (groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  const n = groups.map(g => parseInt(g, 16));
  if (n.slice(0, 5).every(x => x === 0) && n[5] === 0xffff) {
    return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join(".");
  }
  return n.slice(0, 4).map(x => x.toString(16)).join(":") + "::/64";
}

const honeypotHit = body => !!String((body && body[HONEYPOT]) == null ? "" : body[HONEYPOT]).trim();

/* Accounts made in the last 24 hours, from listUsers()' createdAt. */
function recentAccounts(users, now) {
  const t = now == null ? Date.now() : now;
  let n = 0;
  for (const u of users || []) {
    const at = Date.parse(u && u.createdAt);
    if (at && t - at < DAY_MS) n++;
  }
  return n;
}

function createGuard(cfg, opts) {
  const c = cfg || {};
  const perIp = limitOf(c.perIpPerDay, DEFAULTS.perIpPerDay);
  const cap = limitOf(c.dailyCap, DEFAULTS.dailyCap);
  const maxIps = (opts && opts.maxIps) || MAX_IPS;
  const byIp = new Map(); // ip -> [createdAt ms, ...], newest last
  let capLoggedAt = 0;

  const live = (ip, t) => {
    const list = byIp.get(ip);
    if (!list) return null;
    const kept = list.filter(at => t - at < DAY_MS);
    if (!kept.length) { byIp.delete(ip); return null; }
    if (kept.length !== list.length) byIp.set(ip, kept);
    return kept;
  };

  const bound = t => {
    if (byIp.size <= maxIps) return;
    for (const ip of [...byIp.keys()]) live(ip, t);
    // Still over (a real flood from many addresses): drop the oldest first.
    for (const ip of byIp.keys()) {
      if (byIp.size <= maxIps) break;
      byIp.delete(ip);
    }
  };

  return {
    perIp, cap,
    /* Is the site-wide cap reached? `recent` is recentAccounts(). */
    capReached(recent) { return cap != null && recent >= cap; },
    /* For auth.createUser's opts.refuseIf: given the users list read inside
       its lock, the refusal when the cap is reached, else null. */
    capRefusal(users, now) { return cap != null && recentAccounts(users, now) >= cap ? REFUSE_CAP : null; },
    /* Whether the cap's refusal should be written to server.log now. */
    shouldLogCap(now) {
      const t = now == null ? Date.now() : now;
      if (t - capLoggedAt < CAP_LOG_EVERY_MS) return false;
      capLoggedAt = t;
      return true;
    },
    /* Reserve one of this address's sign-ups, or false when it has used
       them all. Checks and records in one synchronous step, so parallel
       requests from one address can't all slip past the check; release()
       hands it back if the account isn't made after all. */
    take(ip, now) {
      if (perIp == null) return true;
      const t = now == null ? Date.now() : now;
      const key = addressKey(ip);
      const list = live(key, t) || [];
      if (list.length >= perIp) return false;
      list.push(t);
      byIp.delete(key);       // re-insert, so the map's order is oldest-used first
      byIp.set(key, list);
      bound(t);
      return true;
    },
    release(ip) {
      if (perIp == null) return;
      const key = addressKey(ip);
      const list = byIp.get(key);
      if (!list) return;
      list.pop();
      if (!list.length) byIp.delete(key);
    },
    size() { return byIp.size; }
  };
}

const REFUSE_IP = "Too many new accounts from your network today. Please try again tomorrow.";
const REFUSE_CAP = "We can't take new sign-ups right now. Please try again tomorrow.";

module.exports = {
  createGuard, recentAccounts, honeypotHit, limitOf, addressKey,
  DAY_MS, MAX_IPS, HONEYPOT, DEFAULTS, CAP_LOG_EVERY_MS, REFUSE_IP, REFUSE_CAP
};
