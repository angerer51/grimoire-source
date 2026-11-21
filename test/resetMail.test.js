"use strict";
/* #167: server/lib/resetMail.js - the limits and the background queue
   behind "Forgot password?", the admin's "Send reset email" and the notice
   to an old address. auth and mailer are stubs, so nothing is looked up on
   disk and nothing is ever sent. The last two tests read server/index.js's
   route source to pin that the routes use this module the right way (the
   HTTP behaviour itself was checked on a scratch server; see the PR). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const auth = require(path.join(__dirname, "..", "server", "lib", "auth"));
const { createResetMail, createLimiter, createQueue } = require(path.join(__dirname, "..", "server", "lib", "resetMail"));

/* accounts: [{id, username, email, disabled}]. sendImpl lets a test make
   sending hang or fail. */
function harness({ accounts = [], configured = true, sendImpl, opts } = {}) {
  const sent = [];
  const lookups = [];
  const logs = [];
  const stubAuth = {
    maskEmail: auth.maskEmail,
    findUsersByEmail: async email => {
      lookups.push(email);
      return accounts.filter(a => String(a.email).toLowerCase() === email);
    },
    createPasswordResetToken: async id => "tok-" + id
  };
  const stubMailer = {
    // Like the real one, answers after a file read: lets concurrent callers interleave.
    configured: () => new Promise(r => setImmediate(() => r(configured))),
    send: async (store, msg) => {
      if (sendImpl) return sendImpl(msg);
      sent.push(msg);
      return { id: "x" };
    }
  };
  const rm = createResetMail({ auth: stubAuth, mailer: stubMailer, store: {}, log: m => logs.push(m), baseUrl: "https://g.test" }, opts);
  return { rm, sent, lookups, logs };
}

const shared = n => Array.from({ length: n }, (_, i) => ({ id: "u" + i, username: "acct" + i, email: "shared@example.com" }));
const admin = { id: "a1", username: "boss", role: "admin" };
const admin2 = { id: "a2", username: "boss2", role: "admin" };

test("forgot password sends at most 3 emails per request, however many accounts share the address", async () => {
  const { rm, sent, logs } = harness({ accounts: shared(7) });
  rm.forgot("Shared@Example.com ");
  await rm.idle();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map(m => m.subject), ["acct0", "acct1", "acct2"].map(u => "Reset your Grimoire password (" + u + ")"));
  assert.ok(sent.every(m => m.to === "shared@example.com"));
  assert.match(sent[0].html, /Only 3 of the 7 accounts/);
  assert.ok(logs.some(l => /7 accounts share s\*\*\*@example\.com/.test(l)), "logged, with the address masked");
  assert.ok(!logs.join("\n").includes("shared@example.com"), "the whole address never reaches the log");
});

test("forgot password: one address gets at most 5 reset emails per 15 minutes, so N accounts can't multiply the request throttle", async () => {
  let t = 1_000_000;
  const { rm, sent, logs } = harness({ accounts: shared(4), opts: { now: () => t } });
  for (let i = 0; i < 8; i++) rm.forgot("shared@example.com"); // the request throttle allows 8
  await rm.idle();
  assert.equal(sent.length, 5, "not 8 requests x 3 emails");
  assert.ok(logs.some(l => /skipped: limit reached/.test(l)));
  t += 15 * 60 * 1000;
  rm.forgot("shared@example.com");
  await rm.idle();
  assert.equal(sent.length, 8, "a new window allows sending again (3 for this request)");
});

test("forgot password replies before any lookup or send: the work runs afterwards, and a hung email can't hold the caller", async () => {
  let release;
  const hang = new Promise(r => { release = r; });
  const { rm, lookups } = harness({ accounts: shared(1), sendImpl: () => hang });
  const known = rm.forgot("shared@example.com");
  const unknown = rm.forgot("nobody@example.com");
  // Same synchronous answer either way, and nothing has been looked up yet.
  assert.equal(known, true);
  assert.equal(unknown, true);
  assert.equal(lookups.length, 0, "no lookup happens while the request is being answered");
  await new Promise(r => setImmediate(r));
  assert.deepEqual(lookups, ["shared@example.com"], "the lookup happens afterwards, in the background");
  release();
  await rm.idle();
  assert.deepEqual(lookups, ["shared@example.com", "nobody@example.com"]);
});

test("forgot password errors are logged, never thrown: a failed send or lookup doesn't stop the queue", async () => {
  const { rm, logs } = harness({ accounts: shared(2), sendImpl: async () => { const e = new Error("Email is not configured on this server yet."); e.status = 503; throw e; } });
  rm.forgot("shared@example.com");
  await rm.idle();
  assert.equal(logs.filter(l => /password reset email failed: Email is not configured/.test(l)).length, 2);
});

test("the forgot queue is bounded: past its limit a request is dropped (and logged), not held in memory", async () => {
  let release;
  const hang = new Promise(r => { release = r; });
  const { rm, logs } = harness({ accounts: shared(1), sendImpl: () => hang, opts: { queueMax: 3 } });
  const results = [];
  for (let i = 0; i < 6; i++) results.push(rm.forgot("a" + i + "@example.com"));
  assert.deepEqual(results, [true, true, true, false, false, false]);
  assert.equal(rm.queueSize(), 3);
  assert.equal(logs.filter(l => /queue full/.test(l)).length, 3);
  release();
  await rm.idle();
  assert.equal(rm.queueSize(), 0);
});

test("a disabled account gets no forgot-password email", async () => {
  const { rm, sent } = harness({ accounts: [{ id: "d", username: "gone", email: "gone@example.com", disabled: true }] });
  rm.forgot("gone@example.com");
  await rm.idle();
  assert.equal(sent.length, 0);
});

test("Send reset email is limited per admin: the 11th in 15 minutes waits and sends nothing", async () => {
  const { rm, sent } = harness();
  for (let i = 0; i < 10; i++) {
    const out = await rm.adminReset(admin, { id: "u" + i, username: "u" + i, email: "u" + i + "@example.com" });
    assert.equal(out.wait, 0);
  }
  const over = await rm.adminReset(admin, { id: "u10", username: "u10", email: "u10@example.com" });
  assert.ok(over.wait > 0 && over.wait <= 15 * 60);
  assert.equal(sent.length, 10);
  assert.equal((await rm.adminReset(admin2, { id: "u10", username: "u10", email: "u10@example.com" })).wait, 0,
    "another admin has their own allowance");
});

test("Send reset email is limited per address, and shares that count with Forgot password", async () => {
  const { rm, sent } = harness({ accounts: shared(1) });
  for (let i = 0; i < 3; i++) rm.forgot("shared@example.com");
  await rm.idle();
  const target = { id: "u0", username: "acct0", email: "Shared@example.com" };
  assert.equal((await rm.adminReset(admin, target)).wait, 0);
  assert.equal((await rm.adminReset(admin2, target)).wait, 0);
  assert.ok((await rm.adminReset(admin, target)).wait > 0, "the 6th reset email to one address waits");
  assert.equal(sent.length, 5);
  assert.match(sent[3].html, /An administrator sent you this link/);
  assert.match(sent[3].html, /https:\/\/g\.test\/login\.html\?reset=tok-u0/);
});

test("Send reset email with email not set up is a 503 (the admin sees why), not a silent success", async () => {
  const { rm } = harness({ configured: false });
  await assert.rejects(() => rm.adminReset(admin, { id: "u", username: "u", email: "u@example.com" }), e => e.status === 503);
});

/* The route's email-change sequence: reserve the notice, save the change
   (a stand-in for auth.setEmail, which awaits the users lock and a file
   write), then send. Returns the status the route would answer with. */
async function changeEmail(rm, actor, target, oldEmail, saved) {
  const r = await rm.reserveNotice(actor, oldEmail);
  if (r.wait) return 429;
  await new Promise(res => setTimeout(res, 5));
  saved.push(target.username);
  if (r.reserved) rm.sendNotice(target, oldEmail, actor);
  return 200;
}

test("the old-address notice is limited per address and per admin, and shares the admin's allowance with reset emails", async () => {
  const { rm, sent } = harness();
  const target = { id: "u", username: "pat" };
  for (let i = 0; i < 5; i++) assert.deepEqual(await rm.reserveNotice(admin, "old@example.com"), { wait: 0, reserved: true });
  const sixth = await rm.reserveNotice(admin2, "OLD@example.com");
  assert.ok(sixth.wait > 0 && !sixth.reserved, "a 6th notice to one address in 15 minutes waits");
  // 5 notices + 5 resets = this admin's 10.
  for (let i = 0; i < 5; i++) assert.equal((await rm.adminReset(admin, { id: "r" + i, username: "r" + i, email: "r" + i + "@example.com" })).wait, 0);
  assert.ok((await rm.reserveNotice(admin, "fresh@example.com")).wait > 0, "the admin's own allowance is used up");
  assert.equal(await rm.sendNotice(target, "old@example.com", admin), true);
  const notices = sent.filter(m => /was changed/.test(m.subject));
  assert.equal(notices.length, 1);
  assert.match(notices[0].html, /changed by an administrator/);
  assert.ok(!notices[0].html.includes("new@"), "the notice doesn't name the new address");
});

test("concurrent email changes at 9 of an admin's 10: exactly one is saved, with its notice; the rest are 429 (#167 review)", async () => {
  const { rm, sent } = harness();
  for (let i = 0; i < 9; i++) assert.equal((await rm.adminReset(admin, { id: "r" + i, username: "r" + i, email: "r" + i + "@example.com" })).wait, 0);
  const saved = [];
  const targets = ["vic", "dum1", "dum2", "dum3"].map(u => ({ id: u, username: u }));
  const codes = await Promise.all(targets.map(t => changeEmail(rm, admin, t, t.username + "@old.test", saved)));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(codes.slice().sort(), [200, 429, 429, 429]);
  const notices = sent.filter(m => /was changed/.test(m.subject));
  assert.equal(saved.length, 1, "only one change saved");
  assert.equal(notices.length, 1, "and it has its notice");
  assert.equal(notices[0].to, saved[0] + "@old.test", "the notice went to the saved change's old address");
});

test("concurrent email changes needing a notice to one old address: no change is saved without its notice", async () => {
  const { rm, sent } = harness();
  for (let i = 0; i < 4; i++) assert.equal((await rm.reserveNotice(admin2, "same@example.com")).reserved, true);
  const saved = [];
  const targets = ["a1", "a2", "a3", "a4", "a5"].map(u => ({ id: u, username: u }));
  const codes = await Promise.all(targets.map(t => changeEmail(rm, admin, t, "same@example.com", saved)));
  await new Promise(r => setImmediate(r));
  assert.equal(codes.filter(c => c === 200).length, 1);
  assert.equal(saved.length, 1);
  assert.equal(sent.filter(m => /was changed/.test(m.subject)).length, saved.length, "every saved change has its notice");
});

test("no notice, and no limit, when email isn't set up or there was no old address", async () => {
  const off = harness({ configured: false });
  for (let i = 0; i < 20; i++) assert.deepEqual(await off.rm.reserveNotice(admin, "old@example.com"), { wait: 0, reserved: false });
  const on = harness();
  assert.deepEqual(await on.rm.reserveNotice(admin, ""), { wait: 0, reserved: false });
  assert.deepEqual(await on.rm.reserveNotice(admin, "  "), { wait: 0, reserved: false });
  assert.equal(on.sent.length, 0);
});

test("a send that never finishes times out: Forgot password logs it and moves on to the next email", async () => {
  const { rm, logs } = harness({ accounts: shared(3), sendImpl: () => new Promise(() => {}), opts: { sendTimeoutMs: 20, jobTimeoutMs: 5000 } });
  const t0 = Date.now();
  rm.forgot("shared@example.com");
  await rm.idle();
  assert.ok(Date.now() - t0 < 2000, "three hung sends cost about three short deadlines, not minutes");
  assert.equal(logs.filter(l => /password reset email failed: Sending the email didn't finish/.test(l)).length, 3);
});

test("a stuck Forgot password job can't hold the queue: past its ceiling the next request runs, and the stuck one sends nothing more", async () => {
  let calls = 0;
  const { rm, logs, sent } = harness({
    accounts: [...shared(3), { id: "p", username: "pat", email: "pat@example.com" }],
    sendImpl: msg => { calls++; if (msg.to === "shared@example.com") return new Promise(() => {}); sent.push(msg); return Promise.resolve({}); },
    opts: { sendTimeoutMs: 200, jobTimeoutMs: 30 }
  });
  rm.forgot("shared@example.com");
  rm.forgot("pat@example.com");
  await rm.idle();
  assert.ok(logs.some(l => /a job ran over \d+s and was abandoned/.test(l)));
  assert.equal(sent.length, 1, "the next request in the queue was sent");
  assert.equal(sent[0].to, "pat@example.com");
  // Its hung send times out at 200 ms; the job then sees it was abandoned.
  await new Promise(r => setTimeout(r, 400));
  assert.equal(calls, 2, "the abandoned job didn't go on to its other accounts");
});

test("the queue's ceiling fires the job's abort signal", async () => {
  const logs = [];
  const q = createQueue({ max: 5, log: m => logs.push(m), jobTimeoutMs: 20 });
  let signal = null;
  let next = false;
  q.push(s => { signal = s; return new Promise(() => {}); });
  q.push(async () => { next = true; });
  await q.idle();
  assert.equal(signal.aborted, true);
  assert.ok(next);
});

test("the limiter map stays bounded however many keys it sees", () => {
  let t = 0;
  const lim = createLimiter({ max: 2, windowMs: 1000, maxKeys: 10, now: () => t });
  for (let i = 0; i < 500; i++) lim.take(["k" + i]);
  assert.ok(lim.size() <= 10);
  // Expired windows are forgotten rather than kept.
  assert.equal(lim.take(["x"]), 0);
  assert.equal(lim.take(["x"]), 0);
  assert.ok(lim.take(["x"]) > 0);
  t += 1000;
  assert.equal(lim.take(["x"]), 0);
});

test("a failing queue job is logged and the next one still runs", async () => {
  const logs = [];
  const q = createQueue({ max: 5, log: m => logs.push(m) });
  let ran = false;
  q.push(async () => { throw new Error("boom"); });
  q.push(async () => { ran = true; });
  await q.idle();
  assert.ok(ran);
  assert.deepEqual(logs, ["email queue: boom"]);
});

/* Route wiring in server/index.js. Reading the source is the cheapest way
   to pin these two facts in the test suite; the scratch-server HTTP checks
   in the PR exercise them for real. */
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
function routeSource(method, p) {
  const start = indexSrc.indexOf('route("' + method + '", "' + p + '"');
  assert.ok(start >= 0, "route " + p + " exists");
  // A route ends at its first line starting with "}" that closes the call.
  const rest = indexSrc.slice(start);
  const m = /\n\}(, \{[^}]*\})?\);/.exec(rest);
  assert.ok(m, "route " + p + " has an end");
  return rest.slice(0, m.index + m[0].length);
}

test("POST /api/auth/forgot replies before looking anything up or sending (no timing hint)", () => {
  const src = routeSource("POST", "/api/auth/forgot");
  assert.ok(!/findUsersByEmail|mailer\.send|createPasswordResetToken/.test(src), "no lookup or send inside the request");
  const reply = src.indexOf("sendJson(res, 200");
  const queued = src.indexOf("resetMail.forgot(");
  assert.ok(reply > 0 && queued > reply, "the reply is sent, then the work is queued");
});

test("changing another account's email and Send reset email are administrator-only routes (#167)", () => {
  for (const p of ["/api/admin/users/:id/email", "/api/admin/users/:id/reset-email"]) {
    const src = routeSource("POST", p);
    assert.match(src, /\n\}, \{ admin: true \}\);$/, p + " is { admin: true }");
    assert.ok(!/role: "moderator"/.test(src), p + " no longer lets moderators in");
  }
});

test("the email-change route reserves the old-address notice before saving, and never re-checks the limit after (#167 review)", () => {
  const src = routeSource("POST", "/api/admin/users/:id/email");
  const reserve = src.indexOf("resetMail.reserveNotice(");
  const save = src.indexOf("auth.setEmail(");
  const sendIt = src.indexOf("resetMail.sendNotice(");
  assert.ok(reserve > 0 && save > reserve && sendIt > save, "reserve, then save, then send");
  assert.ok(!/noticeWait|notifyOldEmail/.test(src), "no separate check-then-count");
  assert.ok(src.indexOf("auth.emailProblem(") < reserve, "a bad address is refused before it uses a slot");
});
