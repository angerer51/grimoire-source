"use strict";
/* Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) for two-factor
   sign-in (BACKLOG #51) - the 6-digit codes every authenticator app
   (Google Authenticator, 1Password, Authy, ...) produces. No dependency:
   it is one HMAC-SHA1 per check, which node's crypto already has.

   Defaults are the ones every app assumes when an otpauth:// URI doesn't
   say otherwise - SHA1, 6 digits, 30-second steps - so they're fixed here
   rather than configurable; changing any of them breaks every enrolled
   phone. */

const crypto = require("crypto");

const STEP = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// 160 bits - RFC 4226's recommended secret length for SHA1.
function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

const stepAt = ms => Math.floor((ms == null ? Date.now() : ms) / 1000 / STEP);

/* The time step `code` matches within +/-`window` steps of now (clock
   drift between a phone and this server), or -1. Returning the step, not
   just true/false, is what lets the caller refuse a replay of the same
   code (auth.js remembers the last step used per account). Constant-time
   comparison per candidate. */
function matchStep(secretB32, code, opts) {
  const o = opts || {};
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return -1;
  const now = stepAt(o.now);
  const win = o.window == null ? 1 : o.window;
  for (let d = -win; d <= win; d++) {
    const cand = Buffer.from(hotp(secretB32, now + d));
    if (crypto.timingSafeEqual(cand, Buffer.from(c))) return now + d;
  }
  return -1;
}

// What an authenticator app scans (as a QR code) or accepts pasted.
function otpauthUri(secretB32, account, issuer) {
  const iss = issuer || "Grimoire";
  return "otpauth://totp/" + encodeURIComponent(iss + ":" + account) +
    "?secret=" + secretB32 + "&issuer=" + encodeURIComponent(iss) + "&algorithm=SHA1&digits=" + DIGITS + "&period=" + STEP;
}

module.exports = { generateSecret, hotp, matchStep, stepAt, otpauthUri, base32Encode, base32Decode, STEP };
