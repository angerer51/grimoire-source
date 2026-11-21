"use strict";
/* Business enquiries (#249): the landing page's business contact form,
   stored as kind "business" in the invite-request store (#238). Against a
   scratch dataDir via store.init(), never the live one. The routes (public
   submit, shared throttle, admin gate, Mark handled) were exercised over
   HTTP on a scratch server; see the PR. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-bizreq-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
}
const DAY = 24 * 3600 * 1000;
const BIZ = { kind: "business", name: "Sam", email: "sam@shop.example", shopName: "Sam's Cards",
  shopSize: "about 20k cards, 3 staff", plans: "Track stock\r\nacross two stores" };

test("validate: a business enquiry needs a name, email, shop name and plans; size is optional", () => {
  assert.deepEqual(reqs.validate({ kind: "business" }).problems, [
    "Enter your name.", "Enter your email address, so we can get back to you.",
    "Enter your shop's name.", "Tell us what you'd like to do with Grimoire."
  ]);
  const ok = reqs.validate(Object.assign({}, BIZ, { shopSize: "", note: "ignored", shopName: " Sam's\u0007  Cards " }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.clean, { kind: "business", name: "Sam", email: "sam@shop.example", shopName: "Sam's Cards",
    shopSize: "", plans: "Track stock\nacross two stores" });
  const long = reqs.validate(Object.assign({}, BIZ, {
    shopName: "s".repeat(reqs.LIMITS.shopName + 1), shopSize: "z".repeat(reqs.LIMITS.shopSize + 1),
    plans: "p".repeat(reqs.LIMITS.plans + 1)
  }));
  assert.equal(long.problems.length, 3);
  // A personal request is untouched by the business fields.
  assert.deepEqual(reqs.validate({ name: "A", email: "a@b.co", shopName: "x" }).clean,
    { kind: "personal", name: "A", email: "a@b.co", note: "" });
});

test("submit: one open enquiry per email per kind, honeypot stores nothing, caps shared with invite requests", async () => {
  fresh();
  const a = await reqs.submit(BIZ, null, "10.0.0.1");
  assert.equal(a.result, "stored");
  assert.equal(a.request.kind, "business");
  assert.equal(a.request.shopName, "Sam's Cards");
  assert.equal(a.request.ipKey, undefined);
  assert.equal((await reqs.submit(Object.assign({}, BIZ, { name: "Sam again" }), null, "10.0.0.2")).result, "duplicate");
  // The same person may also ask for a personal invite.
  assert.equal((await reqs.submit({ name: "Sam", email: "sam@shop.example" }, null, "10.0.0.1")).result, "stored");
  assert.equal((await reqs.submit(Object.assign({}, BIZ, { email: "bot@x.example", website: "spam" }))).result, "honeypot");
  // 10.0.0.1 now holds 2 waiting; one more of either kind fills it.
  assert.equal((await reqs.submit(Object.assign({}, BIZ, { email: "c@x.example" }), null, "10.0.0.1")).result, "stored");
  assert.equal((await reqs.submit({ name: "D", email: "d@x.example" }, null, "10.0.0.1")).result, "ip-full");
  assert.equal((await reqs.submit(Object.assign({}, BIZ, { email: "e@x.example" }), null, "10.0.0.1")).result, "ip-full");
  assert.equal((await reqs.list()).length, 3);
});

test("Mark handled: only an open business enquiry; it can't be sent an invite; handled ones are pruned like sent ones", async () => {
  fresh();
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  const biz = (await reqs.submit(BIZ, t0, "10.0.0.1")).request;
  const per = (await reqs.submit({ name: "Ann", email: "ann@example.com" }, t0)).request;
  assert.equal(await reqs.markHandled(per.id, "admin"), null, "a personal request isn't handled, it's sent");
  assert.equal(await reqs.markSent(biz.id, { inviteCode: "c", emailed: false, byUserId: "admin" }), null,
    "a business enquiry never gets an invite");
  const h = await reqs.markHandled(biz.id, "admin", t0 + DAY);
  assert.equal(h.status, "handled");
  assert.equal(h.handledBy, "admin");
  assert.equal(h.handledAt, new Date(t0 + DAY).toISOString());
  assert.equal(await reqs.markHandled(biz.id, "admin"), null, "only once");
  assert.equal(await reqs.dismiss(biz.id, "admin"), null, "a handled enquiry can't be dismissed");
  // It no longer counts against the address, and the email may get in touch again.
  const raw = await store.readInviteRequests();
  assert.equal(raw.requests.find(r => r.id === biz.id).ipKey, undefined);
  assert.equal((await reqs.submit(BIZ, t0 + 2 * DAY)).result, "stored");
  // Dismiss still works on an open enquiry.
  const again = (await reqs.list()).find(r => r.kind === "business" && r.status === "open");
  assert.equal((await reqs.dismiss(again.id, "admin")).status, "dismissed");
  // Handled is a finished state: gone after KEEP_FINISHED_MS.
  const db = await store.readInviteRequests();
  reqs.prune(db, t0 + DAY + reqs.KEEP_FINISHED_MS + 1);
  assert.equal(db.requests.some(r => r.id === biz.id), false);
});
