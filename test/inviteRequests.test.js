"use strict";
/* Invite requests (#238): the sign-up page's "Request an invite" store.
   Against a scratch dataDir via store.init(), never the live one. The
   routes (throttle, admin gate, send and email fallback) were exercised
   over HTTP on a scratch server; see the PR. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const reqs = lib("inviteRequests");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-invreq-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
}
const DAY = 24 * 3600 * 1000;

test("validate lists every problem and cleans what it keeps", () => {
  assert.deepEqual(reqs.validate({}).problems, [
    "Enter your name.", "Enter your email address, so the invite has somewhere to go."
  ]);
  const long = reqs.validate({ name: "x".repeat(81), email: "a@b.co", note: "n".repeat(501) });
  assert.equal(long.problems.length, 2);
  for (const bad of ["nope", "a@b", "a b@c.de", "a@b.co,c@d.co", "a@b.co\nBcc: x@y.zz"]) {
    assert.deepEqual(reqs.validate({ name: "A", email: bad }).problems, ["That doesn't look like a valid email address."], bad);
  }
  // Whatever an account's email may be, a request's may be too (review of #238).
  for (const good of ["o'brien@example.com", "first.last+tag@sub.example.co.uk"]) {
    assert.deepEqual(reqs.validate({ name: "A", email: good }).problems, [], good);
  }
  assert.equal(reqs.validate({ name: "A", email: "x".repeat(200) + "@example.com" }).problems.length, 1);
  const ok = reqs.validate({ name: "  Ann \u0007  Lee ", email: " Ann@Example.COM ", note: "line one\r\nline two\u0000", kind: "evil" });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.clean, { kind: "personal", name: "Ann Lee", email: "ann@example.com", note: "line one\nline two" });
});

test("submit stores one open request per email; the honeypot stores nothing", async () => {
  fresh();
  const a = await reqs.submit({ name: "Ann", email: "ann@example.com", note: "hi" });
  assert.equal(a.result, "stored");
  assert.equal(a.request.kind, "personal");
  assert.equal(a.request.status, "open");
  assert.equal((await reqs.submit({ name: "Ann again", email: "ANN@example.com" })).result, "duplicate");
  assert.equal((await reqs.submit({ name: "Bot", email: "bot@example.com", website: "http://spam" })).result, "honeypot");
  assert.equal((await reqs.submit({ name: "", email: "x" })).result, "invalid");
  const rows = await reqs.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ann");
});

test("send and dismiss: only open requests dismiss, a dismissed one can't be sent, a sent email can ask again", async () => {
  fresh();
  const a = (await reqs.submit({ name: "Ann", email: "ann@example.com" })).request;
  const b = (await reqs.submit({ name: "Bob", email: "bob@example.com" })).request;
  const sent = await reqs.markSent(a.id, { inviteCode: "CODE1", emailed: false, byUserId: "u1" });
  assert.equal(sent.status, "sent");
  assert.equal(sent.inviteCode, "CODE1");
  assert.equal(sent.emailed, false);
  assert.equal(await reqs.dismiss(a.id, "u1"), null, "a sent request isn't dismissed");
  const again = await reqs.markSent(a.id, { inviteCode: "CODE1", emailed: true, byUserId: "u1" });
  assert.equal(again.emailed, true, "Send again records the email that went out");
  assert.equal((await reqs.dismiss(b.id, "u1")).status, "dismissed");
  assert.equal(await reqs.markSent(b.id, { inviteCode: "X" }), null, "a dismissed request isn't sent");
  assert.equal(await reqs.dismiss("nope", "u1"), null);
  // Once sent or dismissed, the same email may ask again.
  assert.equal((await reqs.submit({ name: "Ann", email: "ann@example.com" })).result, "stored");
  assert.equal((await reqs.submit({ name: "Bob", email: "bob@example.com" })).result, "stored");
});

test("the store stays bounded: open requests capped, finished ones pruned", async () => {
  fresh();
  const now = Date.parse("2026-10-16T12:00:00Z");
  const old = new Date(now - reqs.KEEP_FINISHED_MS - DAY).toISOString();
  const recent = new Date(now - DAY).toISOString();
  const rec = (i, status, at) => ({ id: "r" + i, kind: "personal", name: "N" + i, email: "n" + i + "@example.com", note: "",
    createdAt: at, status, sentAt: status === "sent" ? at : null, dismissedAt: status === "dismissed" ? at : null });
  await store.updateInviteRequests(db => {
    db.requests = [rec(0, "sent", old), rec(1, "dismissed", old), rec(2, "sent", recent)];
    for (let i = 0; i < reqs.MAX_OPEN; i++) db.requests.push(rec(100 + i, "open", recent));
  });
  const full = await reqs.submit({ name: "Late", email: "late@example.com" }, now);
  assert.equal(full.result, "full", "past MAX_OPEN a new request is refused, nothing waiting is pushed out");
  const ids = (await reqs.list()).map(r => r.id);
  assert.ok(!ids.includes("r0") && !ids.includes("r1"), "finished requests past 90 days are gone");
  assert.ok(ids.includes("r2"), "a recent finished request stays");
  assert.equal(ids.length, reqs.MAX_OPEN + 1);

  // Over MAX_STORED: the oldest finished ones go first, never an open one.
  const db = { requests: [] };
  for (let i = 0; i < reqs.MAX_STORED; i++) db.requests.push(rec(i, "sent", new Date(now - (i + 1) * 1000).toISOString()));
  db.requests.push(rec("open", "open", recent));
  reqs.prune(db, now);
  assert.equal(db.requests.length, reqs.MAX_STORED);
  assert.ok(db.requests.some(r => r.id === "ropen"));
  assert.ok(!db.requests.some(r => r.id === "r" + (reqs.MAX_STORED - 1)), "the oldest sent one was dropped");
});

test("one address may hold only MAX_OPEN_PER_IP waiting requests; its hash never leaves the module", async () => {
  fresh();
  const ip = "203.0.113.7";
  const ids = [];
  for (let i = 0; i < reqs.MAX_OPEN_PER_IP; i++) {
    const r = await reqs.submit({ name: "N" + i, email: "n" + i + "@example.com" }, null, ip);
    assert.equal(r.result, "stored");
    assert.equal("ipKey" in r.request, false);
    ids.push(r.request.id);
  }
  assert.equal((await reqs.submit({ name: "More", email: "more@example.com" }, null, ip)).result, "ip-full");
  assert.equal((await reqs.submit({ name: "Other", email: "other@example.com" }, null, "198.51.100.1")).result, "stored",
    "another address is unaffected");
  // Stored as a keyed hash, not the address itself, and never listed.
  const raw = await store.readInviteRequests();
  assert.ok(raw.requests.every(r => !JSON.stringify(r).includes(ip)));
  assert.ok((await reqs.list()).every(r => !("ipKey" in r)));
  assert.equal("ipKey" in (await reqs.get(ids[0])), false);
  // A request that stops waiting frees its slot.
  const done = await reqs.dismiss(ids[0], "u1");
  assert.equal("ipKey" in done, false);
  assert.equal((await reqs.submit({ name: "More", email: "more@example.com" }, null, ip)).result, "stored");
});

test("the invite email escapes the name and carries the link", () => {
  const m = reqs.inviteEmail("<b>Ann</b>", "https://g.example/login.html?invite=abc");
  assert.match(m.html, /&lt;b&gt;Ann&lt;\/b&gt;/);
  assert.ok(m.html.includes('href="https://g.example/login.html?invite=abc"'));
  assert.ok(m.text.includes("https://g.example/login.html?invite=abc"));
});
