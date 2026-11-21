"use strict";
/* Transactional email - password reset and the daily digest, one instance-level account
   for the whole server (see store.js's readEmailConfig/writeEmailConfig).

   Resend's REST API directly via fetch, same idiom as Manapool/Pitney Bowes
   in integrations.js - this app has zero npm dependencies, and Resend's own
   SDK is a thin wrapper around one POST anyway. No credentials live in code;
   `store.readEmailConfig()` returns them already unsealed. */

const { fetchRetry } = require("./fetchRetry");

const RESEND_URL = "https://api.resend.com/emails";

/* `text` (a plain-text alternative), `headers` (extra mail headers - the
   daily digest's List-Unsubscribe pair) and `bcc` (an address or array -
   the operator watching a digest run) are optional; password reset sends
   none of them, exactly as before. */
/* Every send has a deadline (#167): without one, Node's fetch waits up to
   300s for headers and again for the body, and fetchRetry retries, so a
   provider that accepts the connection and then stalls held a caller for
   many minutes - including the one-at-a-time Forgot password queue. The
   deadline covers the whole call, retries and the body included. */
const SEND_TIMEOUT_MS = 15000;

async function sendResendMail(cfg, { to, subject, html, text, headers, bcc, timeoutMs }) {
  const payload = { from: cfg.from, to, subject, html };
  if (text) payload.text = text;
  if (bcc && bcc.length) payload.bcc = bcc;
  if (headers && Object.keys(headers).length) payload.headers = headers;
  const ms = timeoutMs || SEND_TIMEOUT_MS;
  let res, body;
  try {
    res = await fetchRetry(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + cfg.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ms)
    }, { attempts: 2 });
    body = await res.text();
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      const err = new Error("The email provider didn't answer within " + Math.round(ms / 1000) + " seconds.");
      err.status = 504;
      throw err;
    }
    throw e;
  }
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch (e) { data = { rawText: body.slice(0, 500) }; }
  if (!res.ok) {
    const e = new Error("Resend rejected the email (HTTP " + res.status + "): " +
      (data && data.message ? data.message : String(body).slice(0, 300)));
    e.status = 502;
    e.upstream = res.status;
    throw e;
  }
  return data;
}

/* configured() lets a caller check "is email set up at all" without needing
   its own readEmailConfig() call and without ever touching the raw key. */
async function configured(store) {
  const cfg = await store.readEmailConfig();
  return !!(cfg.provider && cfg.apiKey && cfg.from);
}

async function send(store, msg) {
  const cfg = await store.readEmailConfig();
  if (!cfg.provider || !cfg.apiKey || !cfg.from) {
    const e = new Error("Email is not configured on this server yet.");
    e.status = 503;
    throw e;
  }
  if (cfg.provider === "resend") return sendResendMail(cfg, msg);
  const e = new Error("Unknown email provider: " + cfg.provider);
  e.status = 500;
  throw e;
}

module.exports = { send, configured, SEND_TIMEOUT_MS };
