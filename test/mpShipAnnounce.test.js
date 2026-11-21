"use strict";
/* One-time email to Manapool sellers (#456), server/lib/mpShipAnnounce.js.
   Against a scratch dataDir via store.init(), never the live one; the
   mailer is a stub that records what it would send - nothing is mailed. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const store = lib("store");
const auth = lib("auth");
const ann = lib("mpShipAnnounce");

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const MP = p => { p.manapool = { email: "seller@example.com", accessToken: "tok" }; };

/* alice, frank: own Manapool connection, email -> eligible. bob: connected
   but disabled. carol: no connection. dave: connected, no email address.
   erin: connected, turned the digest off. */
async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-mpshipannounce-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  const mk = (username, email) => auth.createUser({ username, email, password: "correct-horse-1" });
  const u = {
    alice: await mk("alice", "alice@example.com"),
    bob: await mk("bob", "bob@example.com"),
    carol: await mk("carol", "carol@example.com"),
    dave: await mk("dave", ""),
    erin: await mk("erin", "erin@example.com"),
    frank: await mk("frank", "frank@example.com")
  };
  for (const n of ["alice", "bob", "dave", "erin", "frank"]) await store.updatePrefs(u[n].id, MP);
  await store.updatePrefs(u.erin.id, p => { p.digest = { unsubscribed: true }; });
  await auth.setDisabled(u.bob.id, true);
  return u;
}

/* opts.fail: { username: error to throw }. */
function stubMailer(sent, opts) {
  opts = opts || {};
  return {
    configured: async () => opts.configured !== false,
    send: async (st, msg) => {
      if (opts.onSend) await opts.onSend(msg);
      const err = opts.fail && opts.fail[msg.to];
      if (err) throw err;
      sent.push(msg);
      return { id: "stub" };
    }
  };
}
const run = (mailer, extra) => ann.announceOnce(Object.assign({
  mailer, baseUrl: "https://grimoire.example", enabled: true, manapoolOn: true, featureShipped: true, gapMs: 0
}, extra));

test("eligibility: own Manapool connection, enabled, has an email, digest not turned off", async () => {
  await seed();
  const names = (await ann.recipients()).map(u => u.username).sort();
  assert.deepEqual(names, ["alice", "frank"]);
});

test("sends one email per eligible account, once; a second boot sends nothing", async () => {
  await seed();
  const sent = [];
  const r = await run(stubMailer(sent));
  assert.equal(r.sent, 2);
  assert.deepEqual(sent.map(m => m.to).sort(), ["alice@example.com", "frank@example.com"]);
  assert.equal(sent[0].subject, ann.SUBJECT);
  const mig = await store.readMigrations();
  assert.ok(mig[ann.MARKER], "done marker set");
  assert.equal(Object.values(mig[ann.SENT]).filter(x => x.state === "sent").length, 2);
  assert.equal(await run(stubMailer(sent)), null);
  assert.equal(sent.length, 2, "nothing more sent");
});

test("each account is claimed before its send, so a crash mid-send never re-sends it", async () => {
  const u = await seed();
  const sent = [];
  await run(stubMailer(sent, { onSend: async msg => {
    const id = msg.to.startsWith("alice") ? u.alice.id : u.frank.id;
    assert.equal((await store.readMigrations())[ann.SENT][id].state, "sending");
  } }));
  assert.equal(sent.length, 2);

  // A crash after alice's claim: next boot (no done marker yet) skips her.
  await seed();
  const fresh = (await ann.recipients()).find(x => x.username === "alice");
  await store.updateMigrations(doc => { doc[ann.SENT] = { [fresh.id]: { state: "sending", at: "x" } }; });
  const sent2 = [];
  const r = await run(stubMailer(sent2));
  assert.deepEqual(sent2.map(m => m.to), ["frank@example.com"]);
  assert.equal(r.already, 1);
});

test("a refused send is retried on a later boot; only that account is sent again", async () => {
  await seed();
  const sent = [];
  const refused = Object.assign(new Error("Resend rejected the email (HTTP 422)"), { status: 502 });
  const r1 = await run(stubMailer(sent, { fail: { "frank@example.com": refused } }));
  assert.equal(r1.sent, 1);
  assert.equal(r1.failed, 1);
  assert.ok(!(await store.readMigrations())[ann.MARKER], "not done yet");
  const r2 = await run(stubMailer(sent));
  assert.equal(r2.sent, 1);
  assert.equal(r2.already, 1);
  assert.deepEqual(sent.map(m => m.to), ["alice@example.com", "frank@example.com"]);
  assert.ok((await store.readMigrations())[ann.MARKER]);
});

test("gives up after MAX_TRIES boots of refusals", async () => {
  await seed();
  const refused = Object.assign(new Error("nope"), { status: 502 });
  let r;
  for (let i = 0; i < ann.MAX_TRIES; i++) r = await run(stubMailer([], { fail: { "frank@example.com": refused } }));
  assert.equal(r.tries, ann.MAX_TRIES);
  assert.ok((await store.readMigrations())[ann.MARKER]);
});

test("a timeout (it may have gone) is kept as unsure and never retried", async () => {
  const u = await seed();
  const timeout = Object.assign(new Error("The email provider didn't answer within 15 seconds."), { status: 504 });
  const r = await run(stubMailer([], { fail: { "frank@example.com": timeout } }));
  assert.equal(r.unsure, 1);
  const mig = await store.readMigrations();
  assert.equal(mig[ann.SENT][u.frank.id].state, "unsure");
  assert.ok(mig[ann.MARKER], "done: nothing left to retry");
});

test("sends nothing and stays not-done without email settings, with Manapool off, when switched off, or before #454 ships", async () => {
  await seed();
  const sent = [];
  for (const [mailer, extra] of [
    [stubMailer(sent, { configured: false }), {}],
    [stubMailer(sent), { manapoolOn: false }],
    [stubMailer(sent), { enabled: false }],
    [stubMailer(sent), { featureShipped: false }]
  ]) {
    const r = await run(mailer, extra);
    assert.ok(r && r.skipped, JSON.stringify(r));
  }
  assert.equal(sent.length, 0);
  const mig = await store.readMigrations();
  assert.ok(!mig[ann.MARKER] && !mig[ann.SENT]);
});

test("the email: plain words, the Lists link, tracking and Retry, the name escaped", () => {
  const user = { username: "alice", displayName: "Al <b>" };
  const text = ann.renderText(user, "https://grimoire.example");
  for (const s of ["Hi Al <b>,", "Mark shipped", "Ground Advantage", "Tracking required", "not sent to Manapool", "Retry",
    "What's new", "https://grimoire.example/lists.html#tab=pick", "one-time note", "(alice)"]) assert.ok(text.includes(s), s);
  const html = ann.renderHtml(user, "https://grimoire.example");
  assert.ok(html.includes("Hi Al &lt;b&gt;,"));
  assert.ok(html.includes('href="https://grimoire.example/lists.html#tab=pick"'));
});

test("a send that went but couldn't be recorded keeps its claim and is never sent again", async () => {
  const u = await seed();
  const real = store.updateMigrations;
  let failNext = false;
  store.updateMigrations = fn => {
    if (failNext) { failNext = false; return Promise.reject(new Error("disk full")); }
    return real(fn);
  };
  const logs = [];
  const sent = [];
  try {
    const r = await ann.announce({ mailer: stubMailer(sent, { onSend: async msg => { failNext = msg.to.startsWith("alice"); } }),
      baseUrl: "", gapMs: 0, log: m => logs.push(m) });
    assert.equal(r.sent, 2);
    assert.equal(r.failed, 0);
  } finally { store.updateMigrations = real; }
  assert.equal((await store.readMigrations())[ann.SENT][u.alice.id].state, "sending");
  assert.ok(logs.some(m => m.includes("recording it failed")));
  const again = await ann.announce({ mailer: stubMailer(sent), baseUrl: "", gapMs: 0 });
  assert.equal(again.sent, 0);
  assert.equal(sent.filter(m => m.to === "alice@example.com").length, 1, "alice emailed once");
});
