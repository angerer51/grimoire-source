"use strict";
/* Invite requests (#238).
   -----------------------
   Grimoire is invite-only. A visitor without a code fills in the sign-up
   page's "Request an invite" form (name, email, optional note); the request
   waits in Admin -> Invites, where an admin sends the invite with one click
   (POST /api/admin/invite-requests/:id/send mints an ordinary invite and
   emails the link) or dismisses it. Nothing is emailed when a request comes
   in (owner, 2026-10-15).

   Every request has a `kind`. "personal" is the invite request above.
   "business" (#249) is the landing page's business contact form
   (business.html): a shop asking about using Grimoire, with its shop name,
   rough size and what it wants to do. It waits in the same admin list,
   tagged business, and the admin marks it handled (status "handled") after
   getting in touch outside Grimoire; it never gets an invite from here.
   The route picks the kind, never the visitor. Both kinds share every cap
   below and the route's per-IP throttle (one bound on what one address can
   store, whichever form it uses); "one open request per email" is per kind,
   so a shop owner can also ask for a personal invite.

   The submit route is public and unauthenticated, so this side keeps the
   store bounded whatever arrives: capped field lengths, one open request
   per email, at most MAX_OPEN_PER_IP waiting requests per address (so one
   address can't fill every waiting slot), finished requests dropped after
   KEEP_FINISHED_MS, and hard caps on open and stored requests. The address
   is kept only as a keyed hash (ipKey), never shown, and dropped once the
   request is no longer waiting. The per-IP rate limit lives with the route
   (server/index.js), next to the sign-in throttle it shares. */

const store = require("./store");
const httpu = require("./http");
const auth = require("./auth");

const KINDS = ["personal", "business"];
// email: auth.emailProblem's own limit. shopName/shopSize/plans: business only.
const LIMITS = { name: 80, note: 500, shopName: 100, shopSize: 100, plans: 1000 };
const MAX_OPEN = 200;                           // waiting requests; past this, new ones are refused
const MAX_OPEN_PER_IP = 3;                      // waiting requests one address may hold
const MAX_STORED = 500;                         // everything kept, finished ones included
const KEEP_FINISHED_MS = 90 * 24 * 3600 * 1000; // sent / dismissed ones go after this
const HONEYPOT = "website";                     // hidden field only a bot fills in

const ipKeyOf = ip => (ip ? store.hmac("invreq-ip:" + ip) : null);
// What leaves this module: everything but the address hash.
const shown = r => { if (!r) return r; const out = Object.assign({}, r); delete out.ipKey; return out; };

// Control characters out (a note keeps its line breaks), runs of spaces in
// a name squashed, both ends trimmed.
const oneLine = s => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const multiLine = s => String(s == null ? "" : s).replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/* Pure: what was typed -> { problems, clean }. Every problem at once, the
   same way the sign-up form reports them (#242). */
function validate(body) {
  const b = body && typeof body === "object" ? body : {};
  const name = oneLine(b.name);
  const email = String(b.email == null ? "" : b.email).trim().toLowerCase();
  const kind = KINDS.includes(b.kind) ? b.kind : "personal";
  const business = kind === "business";
  const problems = [];
  if (!name) problems.push("Enter your name.");
  else if (name.length > LIMITS.name) problems.push("Your name must be " + LIMITS.name + " characters or fewer.");
  if (!email) {
    problems.push(business ? "Enter your email address, so we can get back to you."
      : "Enter your email address, so the invite has somewhere to go.");
  } else {
    // The same check as an account's email, so any address someone could
    // put on their account can ask for an invite (o'brien@... included).
    const bad = auth.emailProblem(email);
    if (bad) problems.push(bad);
  }
  if (business) {
    // #249: the shop's name and what it wants are needed to reply at all;
    // the size is a rough guess the visitor may not have, so it's optional.
    const shopName = oneLine(b.shopName);
    const shopSize = oneLine(b.shopSize);
    const plans = multiLine(b.plans);
    if (!shopName) problems.push("Enter your shop's name.");
    else if (shopName.length > LIMITS.shopName) problems.push("The shop name must be " + LIMITS.shopName + " characters or fewer.");
    if (shopSize.length > LIMITS.shopSize) problems.push("The shop size must be " + LIMITS.shopSize + " characters or fewer.");
    if (!plans) problems.push("Tell us what you'd like to do with Grimoire.");
    else if (plans.length > LIMITS.plans) problems.push("What you'd like to do must be " + LIMITS.plans + " characters or fewer.");
    return { problems, clean: { kind, name, email, shopName, shopSize, plans } };
  }
  const note = multiLine(b.note);
  if (note.length > LIMITS.note) problems.push("The note must be " + LIMITS.note + " characters or fewer.");
  return { problems, clean: { kind, name, email, note } };
}

const isFinished = r => r.status === "sent" || r.status === "dismissed" || r.status === "handled";
const finishedAt = r => Date.parse(r.sentAt || r.handledAt || r.dismissedAt || r.createdAt) || 0;

/* In place: drop finished requests older than KEEP_FINISHED_MS, then the
   oldest finished ones while the store is over MAX_STORED. Open requests
   are never dropped here; MAX_OPEN refuses new ones instead, so a flood
   can't push out requests that are already waiting. */
function prune(db, now) {
  const t = now == null ? Date.now() : now;
  db.requests = db.requests.filter(r => !(isFinished(r) && t - finishedAt(r) > KEEP_FINISHED_MS));
  let over = db.requests.length - MAX_STORED;
  if (over > 0) {
    const oldest = db.requests.filter(isFinished).sort((a, b) => finishedAt(a) - finishedAt(b));
    const drop = new Set(oldest.slice(0, over).map(r => r.id));
    db.requests = db.requests.filter(r => !drop.has(r.id));
  }
  return db;
}

/* The public form's submission. Resolves to { result, problems? }:
   "invalid" (problems listed), "honeypot" (a bot: nothing stored),
   "duplicate" (that email already has an open request of this kind:
   nothing new stored), "full" (MAX_OPEN reached), "ip-full" (this address already
   has MAX_OPEN_PER_IP waiting) or "stored". The route answers honeypot
   and duplicate exactly like stored, so the form tells nobody whether an
   address has asked before. */
async function submit(body, now, ip) {
  const t = now == null ? Date.now() : now;
  const b = body && typeof body === "object" ? body : {};
  if (oneLine(b[HONEYPOT])) return { result: "honeypot" };
  const { problems, clean } = validate(b);
  if (problems.length) return { result: "invalid", problems };
  return store.updateInviteRequests(db => {
    prune(db, t);
    if (db.requests.some(r => r.status === "open" && r.email === clean.email && (r.kind || "personal") === clean.kind)) {
      return { result: "duplicate" };
    }
    if (db.requests.filter(r => r.status === "open").length >= MAX_OPEN) return { result: "full" };
    const ipKey = ipKeyOf(ip);
    if (ipKey && db.requests.filter(r => r.status === "open" && r.ipKey === ipKey).length >= MAX_OPEN_PER_IP) {
      return { result: "ip-full" };
    }
    const rec = Object.assign({ id: httpu.randomId(8) }, clean, {
      createdAt: new Date(t).toISOString(),
      status: "open",
      sentAt: null, sentBy: null, inviteCode: null, emailed: false,
      handledAt: null, handledBy: null,
      dismissedAt: null, dismissedBy: null,
      ipKey
    });
    db.requests.push(rec);
    return { result: "stored", request: shown(rec) };
  });
}

/* Newest first. */
async function list() {
  const db = await store.readInviteRequests();
  const rows = Array.isArray(db.requests) ? db.requests.slice() : [];
  return rows.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)).map(shown);
}

async function get(id) {
  const db = await store.readInviteRequests();
  return shown((db.requests || []).find(r => r.id === id) || null);
}

/* Records that an invite went out (or was made, when email couldn't send
   it). Sending again overwrites the code and time. A dismissed request
   can't be sent: the caller checks first, and this refuses too. */
async function markSent(id, { inviteCode, emailed, byUserId }, now) {
  const t = now == null ? Date.now() : now;
  return store.updateInviteRequests(db => {
    const r = db.requests.find(x => x.id === id);
    if (!r || r.status === "dismissed" || r.status === "handled" || r.kind === "business") return null;
    Object.assign(r, {
      status: "sent", sentAt: new Date(t).toISOString(), sentBy: byUserId || null,
      inviteCode: inviteCode || null, emailed: !!emailed
    });
    delete r.ipKey; // only waiting requests count against an address
    return shown(r);
  });
}

/* A business enquiry (#249) once the admin has been in touch. Only an open
   one: a dismissed enquiry stays dismissed. Nothing is emailed. */
async function markHandled(id, byUserId, now) {
  const t = now == null ? Date.now() : now;
  return store.updateInviteRequests(db => {
    const r = db.requests.find(x => x.id === id);
    if (!r || r.status !== "open" || r.kind !== "business") return null;
    Object.assign(r, { status: "handled", handledAt: new Date(t).toISOString(), handledBy: byUserId || null });
    delete r.ipKey;
    return shown(r);
  });
}

/* Only an open request can be dismissed; a sent one already has an invite. */
async function dismiss(id, byUserId, now) {
  const t = now == null ? Date.now() : now;
  return store.updateInviteRequests(db => {
    const r = db.requests.find(x => x.id === id);
    if (!r || r.status !== "open") return null;
    Object.assign(r, { status: "dismissed", dismissedAt: new Date(t).toISOString(), dismissedBy: byUserId || null });
    delete r.ipKey;
    return shown(r);
  });
}

/* The invite email. Plain words, the link twice (button-ish and bare) for
   mail clients that drop one. */
function inviteEmail(name, url) {
  const e = httpu.escapeHtml;
  return {
    subject: "Your Grimoire invite",
    html: "<p>Hi " + e(name) + ",</p>" +
      "<p>Thanks for asking. Here's your invite to Grimoire. Open this link to pick a username and password:</p>" +
      '<p><a href="' + e(url) + '">Create your Grimoire account</a></p>' +
      "<p>Or copy this into your browser: " + e(url) + "</p>" +
      "<p>The link works once and stops working after 30 days.</p>",
    text: "Hi " + name + ",\n\nThanks for asking. Here's your invite to Grimoire. Open this link to pick a " +
      "username and password:\n\n" + url + "\n\nThe link works once and stops working after 30 days.\n"
  };
}

module.exports = {
  KINDS, LIMITS, MAX_OPEN, MAX_OPEN_PER_IP, MAX_STORED, KEEP_FINISHED_MS, HONEYPOT,
  validate, prune, submit, list, get, markSent, markHandled, dismiss, inviteEmail
};
