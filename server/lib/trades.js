"use strict";
/* Trade-proposal line sanitising (#125). A proposal is the one record one
   account writes and another account's page renders, so every field the
   sender controls is coerced to a plain, bounded string, number or null
   here - never stored or handed back as whatever JSON was posted. An
   object such as {"toString":1} used to reach the recipient's
   trades.page.js and throw inside String(), which stopped the whole list
   from drawing (and with it the Decline button).

   sanitizeTradeLines() runs on the way in (POST /api/trades/propose).
   sanitizeProposal() runs on the way out (GET /api/trades), so a proposal
   stored before this fix is cleaned up for display without rewriting the
   file. */

const FINISHES = ["nonfoil", "foil", "etched"];
const STATUSES = ["open", "accepted", "declined", "withdrawn"];

/* A string or a finite number becomes a trimmed, bounded string; anything
   else (object, array, boolean, null) becomes null. Never calls a
   user-supplied toString/valueOf. */
function safeStr(v, max) {
  if (typeof v === "string") { const s = v.trim().slice(0, max); return s || null; }
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  return null;
}

function safeNum(v, fallback, min, max) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeLine(l) {
  const src = l && typeof l === "object" && !Array.isArray(l) ? l : {};
  const finish = safeStr(src.finish, 16);
  return {
    name: safeStr(src.name, 200) || "",
    set: safeStr(src.set, 64),
    collector: safeStr(src.collector, 64),
    lang: safeStr(src.lang, 64),
    finish: finish && FINISHES.includes(finish.toLowerCase()) ? finish.toLowerCase() : null,
    qty: Math.floor(safeNum(src.qty, 1, 1, 9999)),
    price: safeNum(src.price, 0, 0, 1e7),
    oracleId: safeStr(src.oracleId, 64),
    role: src.role === "filler" ? "filler" : "main",
    imageUrl: safeStr(src.imageUrl, 500)
  };
}

/* Request-body cap for POST /api/trades/propose (#137). A line the trade
   composer sends is ~300 bytes (only these fields), so a full 50 + 50
   offer is ~30 KB; 64 KB leaves room for long names and image URLs. The
   composer (public/js/tradeCompose.js) checks the same number before
   sending, so the two must move together. */
const PROPOSE_BODY_LIMIT = 65536;
const MAX_LINES_PER_SIDE = 50;

/* Inbound: up to 50 lines, nameless lines dropped. */
function sanitizeTradeLines(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_LINES_PER_SIDE).map(sanitizeLine).filter(l => l.name);
}

/* Outbound: same coercion over a stored proposal, keeping nameless lines
   (shown as "(unnamed card)" by the page) so the record still reads as it
   was sent. The server-written fields (ids, usernames, status, dates) are
   coerced too, since a hand-edited or pre-fix record is no more trusted. */
function sanitizeProposal(p) {
  const src = p && typeof p === "object" ? p : {};
  const lines = raw => (Array.isArray(raw) ? raw : []).slice(0, 50).map(sanitizeLine);
  return {
    id: safeStr(src.id, 64) || "",
    fromUserId: safeStr(src.fromUserId, 64), fromUsername: safeStr(src.fromUsername, 64) || "",
    toUserId: safeStr(src.toUserId, 64), toUsername: safeStr(src.toUsername, 64) || "",
    offering: lines(src.offering),
    requesting: lines(src.requesting),
    note: safeStr(src.note, 1000) || "",
    status: STATUSES.includes(src.status) ? src.status : "open",
    // #128: the store a side acted from (null = that person's own cards),
    // and who last changed the status and why.
    fromStoreId: safeStr(src.fromStoreId, 64), fromStoreName: safeStr(src.fromStoreName, 80),
    toStoreId: safeStr(src.toStoreId, 64), toStoreName: safeStr(src.toStoreName, 80),
    statusByUsername: safeStr(src.statusByUsername, 64), statusReason: safeStr(src.statusReason, 200),
    createdAt: safeStr(src.createdAt, 40) || "",
    updatedAt: safeStr(src.updatedAt, 40) || ""
  };
}

/* THE one place a stored proposal's status changes (#128). The respond
   route (accept / decline / withdraw) and the auto-withdraw when a store is
   archived both come through here, so the coming in-app notifications can
   hook in at this single point rather than at every caller. Mutates the
   stored record; the caller holds store.updateTradeProposals' lock.
   by: the acting account ({ id, username }), or null for the system.
   #139: the in-app notification for the change is queued from here. It
   waits for the lock the caller holds and re-reads the saved record, so
   it only goes out once the change is on disk (notifyEvents). Required
   lazily: notifyEvents reaches this module through actFrom. */
function changeStatus(p, status, by, reason) {
  if (!STATUSES.includes(status)) throw new Error("Unknown proposal status: " + status);
  p.status = status;
  p.updatedAt = new Date().toISOString();
  p.statusByUserId = by ? by.id : null;
  p.statusByUsername = by ? by.username : null;
  p.statusReason = reason || null;
  if (typeof p.id === "string" && p.id) require("./notifyEvents").tradeStatusChanged(p.id, status, by ? by.id : null);
  return p;
}

module.exports = { PROPOSE_BODY_LIMIT, MAX_LINES_PER_SIDE, FINISHES, STATUSES, safeStr, sanitizeLine, sanitizeTradeLines, sanitizeProposal, changeStatus };
