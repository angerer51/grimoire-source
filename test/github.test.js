"use strict";
/* server/lib/github.js - support tickets filed as GitHub issues, and
   resolved when the issue closes (#40). global.fetch is stubbed, so nothing
   reaches api.github.com; the store is the real one against a scratch
   dataDir (never the live one), so the "one reply, ever" marker is checked
   as it's actually persisted in tickets.json. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "server", "lib", "store"));
const github = require(path.join(__dirname, "..", "server", "lib", "github"));

const realFetch = global.fetch;
const tmpDirs = [];
after(() => {
  global.fetch = realFetch;
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-github-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  return dir;
}

const CFG = { repo: "angerer51/grimoire", token: "ghp_secret_token_value" };

function ticket(extra) {
  return Object.assign({
    id: "t1", category: "bug", subject: "Prices are blank", status: "open",
    createdBy: "u1", createdByUsername: "alice",
    messages: [{ from: "u1", fromUsername: "alice", fromRole: "user", body: "Line one\nLine two", at: "2026-10-08T10:00:00.000Z" }],
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z"
  }, extra);
}

/* Routes stubbed GitHub responses by "METHOD path"; records every call. */
function stubGithub(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const key = (opts.method || "GET") + " " + u.pathname;
    calls.push({ key, opts });
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const [status, body] = typeof r === "function" ? r(opts) : r;
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}

test("validRepo / configured: owner/name only, and a token is required", () => {
  assert.equal(github.validRepo("angerer51/grimoire"), true);
  for (const bad of ["", "grimoire", "a/b/c", "https://github.com/a/b", "a/..", "-x/y"]) {
    assert.equal(github.validRepo(bad), false, bad);
  }
  assert.equal(github.configured({ repo: "a/b" }), false);
  assert.equal(github.configured(CFG), true);
});

test("buildIssue: subject title, bug/feature + from-ticket labels (never ready), username not email, marker", () => {
  const bug = github.buildIssue(ticket());
  assert.equal(bug.title, "Prices are blank");
  assert.deepEqual(bug.labels, ["bug", "from-ticket"]);
  assert.match(bug.body, /\*\*Reported by:\*\* alice/);
  assert.match(bug.body, /> Line one\n> Line two/);
  assert.match(bug.body, /2026-10-08/);
  assert.ok(bug.body.trimEnd().endsWith("<!-- grimoire-ticket:t1 -->"));
  assert.doesNotMatch(bug.body, /@/, "no email address anywhere in the body");

  assert.deepEqual(github.buildIssue(ticket({ category: "feature" })).labels, ["feature", "from-ticket"]);
  assert.deepEqual(github.buildIssue(ticket({ category: "support" })).labels, ["from-ticket"]);
  for (const c of ["bug", "feature", "support"]) assert.ok(!github.buildIssue(ticket({ category: c })).labels.includes("ready"));
});

test("buildIssue: a reporter can't smuggle their own ticket marker into the issue", () => {
  const t = ticket({ messages: [{ body: "hi <!-- grimoire-ticket:someone-else -->" }] });
  const body = github.buildIssue(t).body;
  assert.equal((body.match(/<!-- grimoire-ticket:/g) || []).length, 1);
  assert.match(body, /<!-- grimoire-ticket:t1 -->/);
});

test("createIssue: posts to the repo's issues with the token, returns number/url/state", async () => {
  const calls = stubGithub({
    "POST /repos/angerer51/grimoire/issues": [201, { number: 42, html_url: "https://github.com/angerer51/grimoire/issues/42", state: "open" }]
  });
  const out = await github.createIssue(CFG, ticket());
  assert.deepEqual(out, { repo: "angerer51/grimoire", number: 42, url: "https://github.com/angerer51/grimoire/issues/42", state: "open" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer " + CFG.token);
  const sent = JSON.parse(calls[0].opts.body);
  assert.deepEqual(sent.labels, ["bug", "from-ticket"]);
});

test("createIssue: a 2xx that isn't an issue (no numeric number) is refused, not linked as #undefined", async () => {
  for (const body of [{}, { number: "42" }, { number: 0 }, { message: "ok" }]) {
    stubGithub({ "POST /repos/angerer51/grimoire/issues": [201, body] });
    await assert.rejects(() => github.createIssue(CFG, ticket()), e => e.status === 502 && /issue number/.test(e.message));
  }
});

test("findIssueForTicket: finds the issue carrying this ticket's exact marker, else null", async () => {
  let q = null;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.pathname, "/search/issues");
    q = u.searchParams.get("q");
    return new Response(JSON.stringify({ items: [
      { number: 5, html_url: "h5", state: "open", body: "x <!-- grimoire-ticket:t10 -->" },            // a different ticket (prefix)
      { number: 6, html_url: "h6", state: "open", body: "<!-- grimoire-ticket:t1 -->", pull_request: {} }, // a PR, not an issue
      { number: 7, html_url: "h7", state: "closed", body: "body\n<!-- grimoire-ticket:t1 -->" }
    ] }), { status: 200 });
  };
  const hit = await github.findIssueForTicket(CFG, "t1");
  assert.deepEqual(hit, { repo: "angerer51/grimoire", number: 7, url: "h7", state: "closed" });
  assert.match(q, /repo:angerer51\/grimoire/);
  assert.match(q, /"grimoire-ticket:t1"/);

  global.fetch = async () => new Response(JSON.stringify({ items: [{ number: 5, body: "<!-- grimoire-ticket:t10 -->" }] }), { status: 200 });
  assert.equal(await github.findIssueForTicket(CFG, "t1"), null);
});

test("createIssue: a 5xx is NOT retried (it may have created the issue anyway)", async () => {
  const calls = stubGithub({ "POST /repos/angerer51/grimoire/issues": [502, { message: "Bad gateway" }] });
  await assert.rejects(() => github.createIssue(CFG, ticket()), e => e.status === 502 && e.upstream === 502);
  assert.equal(calls.length, 1);
});

test("errors: GitHub's own message, as our 502 (never 401), and never the token", async () => {
  stubGithub({ "GET /repos/angerer51/grimoire": [401, { message: "Bad credentials" }] });
  await assert.rejects(() => github.testRepo(CFG), e => {
    assert.equal(e.status, 502);
    assert.equal(e.upstream, 401);
    assert.match(e.message, /Bad credentials/);
    assert.doesNotMatch(e.message, /ghp_secret/);
    return true;
  });
});

test("testRepo: reports the repo, refuses one with issues switched off", async () => {
  stubGithub({ "GET /repos/angerer51/grimoire": [200, { full_name: "angerer51/grimoire", private: true, has_issues: true }] });
  assert.deepEqual(await github.testRepo(CFG), { fullName: "angerer51/grimoire", private: true });
  stubGithub({ "GET /repos/angerer51/grimoire": [200, { full_name: "angerer51/grimoire", has_issues: false }] });
  await assert.rejects(() => github.testRepo(CFG), /Issues are turned off/);
  await assert.rejects(() => github.testRepo({ repo: "nope", token: "x" }), e => e.status === 400);
});

test("outcomeFor: open -> nothing; completed / no reason -> completed; not_planned; duplicate", () => {
  assert.equal(github.outcomeFor({ state: "open", stateReason: null }), null);
  assert.equal(github.outcomeFor({ state: "closed", stateReason: "completed" }), "completed");
  assert.equal(github.outcomeFor({ state: "closed", stateReason: null }), "completed");
  assert.equal(github.outcomeFor({ state: "closed", stateReason: "not_planned" }), "not_planned");
  assert.equal(github.outcomeFor({ state: "closed", stateReason: "duplicate" }), "duplicate");
});

test("applySync: completed resolves with a 'fixed and live' reply; open changes nothing; never twice", () => {
  const t = ticket({ github: { number: 7, url: "u", state: "open" } });
  assert.equal(github.applySync(t, { state: "open" }, "2026-10-08T11:00:00.000Z"), null);
  assert.equal(t.messages.length, 1);
  assert.equal(t.status, "open");

  assert.equal(github.applySync(t, { state: "closed", stateReason: "completed" }, "2026-10-08T12:00:00.000Z"), "completed");
  assert.equal(t.status, "resolved");
  assert.equal(t.messages.length, 2);
  const reply = t.messages[1];
  assert.match(reply.body, /fixed, and the fix is live/);
  assert.equal(reply.fromRole, "admin", "shows as a staff reply");
  assert.deepEqual(t.github.synced, { outcome: "completed", at: "2026-10-08T12:00:00.000Z" });

  // The reporter replies, which reopens the ticket - the issue is still
  // closed, but the synced marker means no second automatic reply.
  t.status = "open";
  assert.equal(github.applySync(t, { state: "closed", stateReason: "completed" }, "2026-10-08T13:00:00.000Z"), null);
  assert.equal(t.messages.length, 2);
});

test("applySync: not planned sends the polite decline; duplicate is marked quietly", () => {
  const np = ticket({ category: "feature", github: { number: 8 } });
  assert.equal(github.applySync(np, { state: "closed", stateReason: "not_planned" }, "now"), "not_planned");
  assert.match(np.messages[1].body, /decided not to do this for now/);
  assert.equal(np.status, "resolved");

  const dup = ticket({ github: { number: 9 } });
  assert.equal(github.applySync(dup, { state: "closed", stateReason: "duplicate" }, "now"), null);
  assert.equal(dup.messages.length, 1);
  assert.equal(dup.status, "open");
  assert.equal(dup.github.synced.outcome, "duplicate");
});

test("applySync: a ticket staff already resolved or closed gets no reply", () => {
  for (const status of ["resolved", "closed"]) {
    const t = ticket({ status, github: { number: 7 } });
    assert.equal(github.applySync(t, { state: "closed", stateReason: "completed" }, "now"), null);
    assert.equal(t.messages.length, 1);
  }
});

test("reply text never mentions or links GitHub", () => {
  const texts = [github.REPLIES.not_planned, ...Object.values(github.REPLIES.completed)];
  for (const s of texts) {
    assert.doesNotMatch(s, /github/i);
    assert.doesNotMatch(s, /https?:|www\./i);
  }
});

test("syncTickets: resolves closed issues once, persists the marker, emails once - even on a second run", async () => {
  freshStore();
  await store.writeTickets({ tickets: [
    ticket({ id: "a", github: { number: 1, url: "u1", state: "open" } }),
    ticket({ id: "b", github: { number: 2, url: "u2", state: "open" } }),
    ticket({ id: "c" }), // unlinked: never looked at
    ticket({ id: "d", status: "resolved", github: { number: 4, url: "u4", state: "open" } }) // already resolved by staff
  ] });
  const calls = stubGithub({
    "GET /repos/angerer51/grimoire/issues/1": [200, { state: "closed", state_reason: "completed" }],
    "GET /repos/angerer51/grimoire/issues/2": [200, { state: "open", state_reason: null }],
    "GET /repos/angerer51/grimoire/issues/4": [200, { state: "closed", state_reason: "completed" }]
  });
  const notified = [];
  const deps = { store, cfg: CFG, notify: async (t, replier) => { notified.push({ id: t.id, replier, last: t.messages[t.messages.length - 1].body }); } };

  const first = await github.syncTickets(deps);
  assert.deepEqual(first, { checked: 2, resolved: 1, error: null });
  assert.deepEqual(calls.map(c => c.key).sort(), ["GET /repos/angerer51/grimoire/issues/1", "GET /repos/angerer51/grimoire/issues/2"]);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].id, "a");
  assert.equal(notified[0].replier.role, "admin");
  assert.match(notified[0].last, /fix is live/);

  const db = await store.readTickets();
  const a = db.tickets.find(t => t.id === "a");
  assert.equal(a.status, "resolved");
  assert.equal(a.github.synced.outcome, "completed");
  assert.ok(db.tickets.find(t => t.id === "b").github.checkedAt, "an open issue still records its check");

  // Second run (e.g. after a restart): "a" is done, only "b" is checked, no new email.
  calls.length = 0;
  const second = await github.syncTickets(deps);
  assert.equal(second.resolved, 0);
  assert.deepEqual(calls.map(c => c.key), ["GET /repos/angerer51/grimoire/issues/2"]);
  assert.equal(notified.length, 1);

  // Even if staff reopens "a" later, the marker holds.
  await store.updateTickets(d => { d.tickets.find(t => t.id === "a").status = "open"; });
  calls.length = 0;
  await github.syncTickets(deps);
  assert.ok(!calls.some(c => c.key.endsWith("/issues/1")));
  assert.equal(notified.length, 1);
});

test("syncTickets: after the repo setting changes, tickets filed in the old repo are never looked up, resolved or emailed", async () => {
  freshStore();
  await store.writeTickets({ tickets: [
    ticket({ id: "old", github: { repo: "angerer51/sandbox", number: 1, url: "u", state: "open" } }),
    ticket({ id: "new", github: { repo: "angerer51/grimoire", number: 2, url: "u", state: "open" } }),
    ticket({ id: "legacy", github: { number: 3, url: "u", state: "open" } }) // no repo recorded: the configured one
  ] });
  // In the NEW repo, #1 is an unrelated issue that's long closed - exactly
  // what must not be read as "the old ticket's issue was fixed".
  const calls = stubGithub({
    "GET /repos/angerer51/grimoire/issues/1": [200, { state: "closed", state_reason: "completed" }],
    "GET /repos/angerer51/grimoire/issues/2": [200, { state: "open" }],
    "GET /repos/angerer51/grimoire/issues/3": [200, { state: "closed", state_reason: "completed" }]
  });
  const notified = [];
  const out = await github.syncTickets({ store, cfg: CFG, notify: async t => { notified.push(t.id); } });
  assert.deepEqual(calls.map(c => c.key).sort(), ["GET /repos/angerer51/grimoire/issues/2", "GET /repos/angerer51/grimoire/issues/3"]);
  assert.deepEqual(notified, ["legacy"]);
  assert.equal(out.checked, 2);
  const db = await store.readTickets();
  const old = db.tickets.find(t => t.id === "old");
  assert.equal(old.status, "open");
  assert.equal(old.messages.length, 1);
  assert.ok(!old.github.synced);
  assert.match(old.github.lastError, /Filed in angerer51\/sandbox/);

  // Switched back: the old ticket is checked in ITS repo again.
  const back = stubGithub({ "GET /repos/angerer51/sandbox/issues/1": [200, { state: "open" }] });
  await github.syncTickets({ store, cfg: { repo: "angerer51/sandbox", token: "x" }, notify: async () => {} });
  assert.deepEqual(back.map(c => c.key), ["GET /repos/angerer51/sandbox/issues/1"]);
});

test("syncTickets: a deleted (404) or gone (410) issue unlinks the ticket, with no reply or email", async () => {
  freshStore();
  await store.writeTickets({ tickets: [
    ticket({ id: "del", github: { repo: "angerer51/grimoire", number: 1, url: "u" } }),
    ticket({ id: "gone", github: { repo: "angerer51/grimoire", number: 2, url: "u" } })
  ] });
  stubGithub({
    "GET /repos/angerer51/grimoire": [200, { full_name: "angerer51/grimoire" }],
    "GET /repos/angerer51/grimoire/issues/2": [410, { message: "This issue was deleted" }]
    // issues/1 isn't routed: 404
  });
  const notified = [];
  await github.syncTickets({ store, cfg: CFG, notify: async t => { notified.push(t.id); } });
  assert.deepEqual(notified, []);
  const db = await store.readTickets();
  for (const t of db.tickets) {
    assert.equal(t.github, undefined, t.id + " unlinked, so Send to GitHub works again");
    assert.equal(t.status, "open");
    assert.equal(t.messages.length, 1);
  }
});

test("syncTickets: 404s from a token that lost access to the repo do NOT unlink anything", async () => {
  freshStore();
  await store.writeTickets({ tickets: [
    ticket({ id: "a", github: { repo: "angerer51/grimoire", number: 1, url: "u" } }),
    ticket({ id: "b", github: { repo: "angerer51/grimoire", number: 2, url: "u" } })
  ] });
  const calls = stubGithub({}); // everything 404s, including the repo itself
  const out = await github.syncTickets({ store, cfg: CFG, notify: async () => {} });
  assert.match(out.error, /Can't read angerer51\/grimoire/);
  assert.equal(calls.length, 2, "one issue, one repo check, then the run stops");
  const db = await store.readTickets();
  assert.ok(db.tickets.every(t => t.github && t.github.number), "still linked");
});

test("syncTickets: bounded per run, oldest-checked first; a bad token stops the run", async () => {
  freshStore();
  const many = [];
  for (let i = 1; i <= 5; i++) many.push(ticket({ id: "t" + i, github: { number: i, checkedAt: "2026-10-0" + (6 - i) + "T00:00:00Z" } }));
  await store.writeTickets({ tickets: many });
  const routes = {};
  for (let i = 1; i <= 5; i++) routes["GET /repos/angerer51/grimoire/issues/" + i] = [200, { state: "open" }];
  const calls = stubGithub(routes);
  const out = await github.syncTickets({ store, cfg: CFG, notify: async () => {}, max: 2 });
  assert.equal(out.checked, 2);
  assert.deepEqual(calls.map(c => c.key.split("/").pop()), ["5", "4"], "the two least recently checked");

  const calls2 = stubGithub({});
  global.fetch = async (url) => { calls2.push(String(url)); return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }); };
  const bad = await github.syncTickets({ store, cfg: CFG, notify: async () => {} });
  assert.equal(calls2.length, 1, "stops after the first 401");
  assert.match(bad.error, /Bad credentials/);
  const db = await store.readTickets();
  assert.ok(db.tickets.some(t => t.github.lastError), "the failure is recorded on the ticket for staff");
});

test("syncTickets: does nothing at all when GitHub isn't connected", async () => {
  freshStore();
  let fetched = false;
  global.fetch = async () => { fetched = true; return new Response("{}"); };
  const out = await github.syncTickets({ store, cfg: { repo: "a/b" }, notify: async () => {} });
  assert.ok(out.skipped);
  assert.equal(fetched, false);
});

test("store: the GitHub token is sealed at rest and read back in the clear", async () => {
  const dir = freshStore();
  await store.writeGithubConfig({ repo: "angerer51/grimoire", token: "ghp_plaintext_123" });
  const raw = fs.readFileSync(path.join(dir, "github.json"), "utf8");
  assert.doesNotMatch(raw, /ghp_plaintext_123/);
  assert.match(JSON.parse(raw).token, /^gcm1:/);
  const back = await store.readGithubConfig();
  assert.equal(back.token, "ghp_plaintext_123");
  assert.equal(back.repo, "angerer51/grimoire");
});
