"use strict";
/* Account email that someone can make the server send to an address:
   "Forgot password?" links, the admin's "Send reset email", and the notice
   to an old address after an admin changes it (#167).

   Three rules, all in memory (one process; losing the counters on restart
   is the same fair trade as the sign-in throttle in index.js):

   - Forgot password sends at most PER_REQUEST emails per request, however
     many accounts share the address, and every reset link to one address
     counts against PER_ADDRESS per window. So N accounts on one address
     can't multiply the 8-requests-per-15-minutes throttle into 8 x N
     emails.
   - "Send reset email" and the old-address notice are limited per acting
     account and per target address. Over the limit is a 429 to the admin,
     before anything changes: an email change whose notice can't go out is
     refused rather than made silently.
   - Forgot password does no lookup and no sending while the request waits.
     The route replies at once with the same answer whether or not the
     address is on file, and this module does the work afterwards through a
     small bounded queue. Errors go to the log, never to the visitor.

   Everything held here is bounded: each limiter map at DEFAULTS.maxKeys
   entries, the queue at DEFAULTS.queueMax waiting requests (more are
   dropped and logged). Log lines show a masked address (auth.maskEmail),
   never the whole one. Pending sends are lost on a restart, like the
   throttle counters. */

const httpu = require("./http");

const WINDOW_MS = 15 * 60 * 1000;
const DEFAULTS = {
  perRequest: 3,                       // forgot: most emails one request sends
  perAddress: 5, addressWindowMs: WINDOW_MS, // reset links (or notices) to one address
  perActor: 10, actorWindowMs: WINDOW_MS,    // reset links + notices one admin sends
  queueMax: 50,                        // forgot requests waiting to be worked
  sendTimeoutMs: 15000,                // one email (mailer.js has the same deadline on its fetch)
  jobTimeoutMs: 60000,                 // one forgot request: lookup + up to perRequest sends
  maxKeys: 5000                        // entries per limiter map
};

/* Rejects with a 504 if `p` hasn't settled within `ms`. mailer.send has
   its own deadline on the network call; this one also covers whatever
   else a send waits on, and a mailer stub in tests. */
function withTimeout(p, ms, what) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(what + " didn't finish within " + Math.round(ms / 1000) + " seconds.");
      e.status = 504;
      reject(e);
    }, ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const normEmail = e => String(e == null ? "" : e).trim().toLowerCase();

/* A fixed-window counter per key. wait(keys) is the seconds until every key
   is under the limit again (0 = allowed now); take(keys) counts one against
   each key if all are allowed, otherwise counts nothing and returns the
   wait. Synchronous, so check-and-count can't interleave. */
function createLimiter({ max, windowMs, maxKeys, now }) {
  const clock = now || Date.now;
  const cap = maxKeys || DEFAULTS.maxKeys;
  const hits = new Map(); // key -> { count, first }

  function live(key, t) {
    const r = hits.get(key);
    if (!r) return null;
    if (t - r.first >= windowMs) { hits.delete(key); return null; }
    return r;
  }
  function wait(keys) {
    const t = clock();
    let worst = 0;
    for (const k of keys) {
      const r = live(k, t);
      if (r && r.count >= max) worst = Math.max(worst, r.first + windowMs - t);
    }
    return worst > 0 ? Math.ceil(worst / 1000) : 0;
  }
  function sweep(t) {
    if (hits.size <= cap) return;
    for (const [k, r] of hits) if (t - r.first >= windowMs) hits.delete(k);
    // Still over: drop the oldest. Map order is insertion order.
    for (const k of hits.keys()) { if (hits.size <= cap) break; hits.delete(k); }
  }
  function take(keys) {
    const w = wait(keys);
    if (w) return w;
    const t = clock();
    for (const k of keys) {
      let r = live(k, t);
      if (!r) { r = { count: 0, first: t }; hits.set(k, r); }
      r.count++;
    }
    sweep(t);
    return 0;
  }
  return { wait, take, size: () => hits.size };
}

/* Runs async jobs one at a time, after the caller has returned. push() is
   false (and the job is dropped) when `max` are already waiting. A failing
   job is logged and the next one runs. A job gets `jobTimeoutMs` at most:
   then the queue moves on and the job's AbortSignal (its argument) fires,
   so a stuck provider can't hold every later reset link past its useful
   life (#167 review). idle() resolves once nothing is waiting or running
   (tests use it). */
function createQueue({ max, log, jobTimeoutMs }) {
  const ceilingMs = jobTimeoutMs || DEFAULTS.jobTimeoutMs;
  const jobs = [];
  let running = false;
  let waiters = [];
  async function runOne(job) {
    const ac = new AbortController();
    let timer;
    const ceiling = new Promise(r => { timer = setTimeout(() => { ac.abort(); r("timeout"); }, ceilingMs); });
    try {
      const out = await Promise.race([Promise.resolve().then(() => job(ac.signal)), ceiling]);
      if (out === "timeout") log("email queue: a job ran over " + Math.round(ceilingMs / 1000) + "s and was abandoned");
    } catch (e) {
      log("email queue: " + (e && e.message));
    } finally {
      clearTimeout(timer);
    }
  }
  async function run() {
    running = true;
    while (jobs.length) await runOne(jobs.shift());
    running = false;
    const w = waiters; waiters = [];
    for (const r of w) r();
  }
  function push(job) {
    if (jobs.length >= max) return false;
    jobs.push(job);
    if (!running) { running = true; setImmediate(run); }
    return true;
  }
  function idle() {
    return running || jobs.length ? new Promise(r => waiters.push(r)) : Promise.resolve();
  }
  return { push, idle, size: () => jobs.length };
}

/* deps: auth (findUsersByEmail, createPasswordResetToken, maskEmail),
   mailer (send, configured), store, log, baseUrl() -> string. */
function createResetMail(deps, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const { auth, mailer, store } = deps;
  const log = deps.log || (() => {});
  const baseUrl = typeof deps.baseUrl === "function" ? deps.baseUrl : () => deps.baseUrl || "";
  const byAddress = createLimiter({ max: o.perAddress, windowMs: o.addressWindowMs, maxKeys: o.maxKeys, now: o.now });
  const byActor = createLimiter({ max: o.perActor, windowMs: o.actorWindowMs, maxKeys: o.maxKeys, now: o.now });
  const queue = createQueue({ max: o.queueMax, log, jobTimeoutMs: o.jobTimeoutMs });

  const resetKey = email => "reset:" + normEmail(email);
  const noticeKey = email => "notice:" + normEmail(email);
  const actorKey = actor => "actor:" + actor.id;
  const resetLink = token => baseUrl() + "/login.html?reset=" + encodeURIComponent(token);
  // Every send has a deadline: mailer.js's on the fetch, and this one (a
  // little later, 16s by default) on the whole call.
  const send = msg => withTimeout(mailer.send(store, Object.assign({ timeoutMs: o.sendTimeoutMs }, msg)),
    o.sendTimeoutMs + Math.ceil(o.sendTimeoutMs / 15), "Sending the email");

  /* Forgot password: queue the work and return at once. The caller replies
     the same way whatever this returns. */
  function forgot(email) {
    const want = normEmail(email);
    if (!want) return false;
    const queued = queue.push(signal => sendForgot(want, signal));
    if (!queued) log("password reset queue full: dropped a request for " + auth.maskEmail(want));
    return queued;
  }

  async function sendForgot(email, signal) {
    let targets = [];
    try { targets = (await auth.findUsersByEmail(email)).filter(u => !u.disabled); }
    catch (e) { log("password reset lookup failed: " + e.message); return; }
    if (!targets.length) return;
    const many = targets.length > 1;
    const capped = targets.length > o.perRequest;
    if (capped) log("password reset: " + targets.length + " accounts share " + auth.maskEmail(email) +
      ", sending " + o.perRequest + " this request");
    for (const target of targets.slice(0, o.perRequest)) {
      // The queue gave up on this job: send nothing more for it.
      if (signal && signal.aborted) return;
      const wait = byAddress.take([resetKey(email)]);
      if (wait) { log("password reset email to " + auth.maskEmail(email) + " skipped: limit reached (" + wait + "s left)"); return; }
      try {
        const token = await auth.createPasswordResetToken(target.id);
        const name = httpu.escapeHtml(target.username);
        await send({
          to: email,
          subject: "Reset your Grimoire password" + (many ? " (" + target.username + ")" : ""),
          html: "<p>Someone (hopefully you) asked to reset the password for the Grimoire account " +
            "<b>" + name + "</b>.</p><p><a href=\"" + resetLink(token) + "\">Choose a new password</a></p>" +
            (many ? "<p>More than one account uses this email address, so each one gets its own email. " +
              "This link only resets <b>" + name + "</b>.</p>" : "") +
            (capped ? "<p>Only " + o.perRequest + " of the " + targets.length + " accounts on this address get a link per " +
              "request. If yours wasn't among them, ask the administrator to send you a reset email.</p>" : "") +
            "<p>This link works once and expires in 30 minutes. If you didn't ask for this, ignore this email.</p>"
        });
      } catch (e) {
        // Not configured, provider down: logged only. The visitor already
        // has the same answer as everyone else.
        log("password reset email failed: " + e.message);
      }
    }
  }

  /* Admin "Send reset email". Returns { wait } (seconds, nothing sent) when
     over a limit, otherwise sends and returns { wait: 0 }. Send errors
     propagate (the admin sees "Email is not configured" etc.). */
  async function adminReset(actor, target) {
    if (!(await mailer.configured(store))) {
      const e = new Error("Email is not configured on this server yet.");
      e.status = 503;
      throw e;
    }
    const wait = Math.max(byActor.wait([actorKey(actor)]), byAddress.wait([resetKey(target.email)]));
    if (wait) return { wait };
    byActor.take([actorKey(actor)]);
    byAddress.take([resetKey(target.email)]);
    const token = await auth.createPasswordResetToken(target.id);
    await send({
      to: target.email,
      subject: "Reset your Grimoire password",
      html: "<p>An administrator sent you this link to reset the password for the Grimoire account " +
        "<b>" + httpu.escapeHtml(target.username) + "</b>.</p><p><a href=\"" + resetLink(token) + "\">Choose a new password</a></p>" +
        "<p>This link works once and expires in 30 minutes.</p>"
    });
    return { wait: 0 };
  }

  /* The old-address notice, in two steps so the route can refuse an email
     change before making it.
     reserveNotice() checks AND counts the notice in one step - nothing is
     awaited between the check and the count, so concurrent changes can't
     all pass the check and then find the limit used up (#167 review). It
     returns { wait } (seconds; refuse the change) or { reserved } (true:
     a notice is owed; false: email isn't set up or there was no old
     address, so no notice and no limit). The route reserves BEFORE saving
     the change, and a reserved notice is always sent: sendNotice() never
     re-checks the limit.
     If the save then fails, the slot stays used. That is the safe way
     round: a failed change can only make the limit stricter, never let a
     saved change through without its notice. */
  async function reserveNotice(actor, oldEmail) {
    if (!normEmail(oldEmail) || !(await mailer.configured(store))) return { wait: 0, reserved: false };
    // From here to the return: no await.
    const wait = Math.max(byActor.wait([actorKey(actor)]), byAddress.wait([noticeKey(oldEmail)]));
    if (wait) return { wait, reserved: false };
    byActor.take([actorKey(actor)]);
    byAddress.take([noticeKey(oldEmail)]);
    return { wait: 0, reserved: true };
  }

  /* Sends a notice reserved above. Started straight away (not awaited, not
     through the Forgot password queue: strangers can fill that queue, and
     this notice must not be the one dropped). Failures are logged. */
  function sendNotice(target, oldEmail, by) {
    return send({
      to: String(oldEmail).trim(),
      subject: "The email on your Grimoire account was changed",
      html: "<p>The email address on the Grimoire account <b>" + httpu.escapeHtml(target.username) + "</b> was changed by " +
        "an administrator. Password reset links and the daily digest " +
        "now go to the new address, not this one.</p><p>If you didn't ask for this, contact the administrator of this Grimoire server.</p>"
    }).then(() => true, e => { log("old-address notice failed for " + target.username + ": " + e.message); return false; });
  }

  return { forgot, adminReset, reserveNotice, sendNotice, idle: queue.idle, queueSize: queue.size };
}

module.exports = { createResetMail, createLimiter, createQueue, withTimeout, DEFAULTS };
