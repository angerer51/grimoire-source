"use strict";
/* server/lib/audit.js - the per-user, day-sharded audit log. Zero test
   coverage before now. Plain file I/O against store.js (same shape as
   orgs.js's existing coverage) - a scratch dataDir via store.init() is
   enough, no HTTP/browser needed.

   Covers the two properties the file's own header comment says this
   day-sharded design exists to preserve correctly: append() deduping a
   retried POST by entry id (so two overlapping flushes - two tabs, or a
   retry racing the original request - can't double an entry), and
   query()'s filtering/pagination/total-count reading back correctly across
   multiple day files; plus pruneOld()'s keepDays floor and clear(). */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "server", "lib", "store"));
const audit = require(path.join(__dirname, "..", "server", "lib", "audit"));

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-audit-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  audit.init({});
  return dir;
}

function entry(overrides) {
  return Object.assign({
    id: "e-default", ts: "2026-09-10T12:00:00.000Z", action: "add",
    name: "Lightning Bolt", set: "lea", collector: "162", note: ""
  }, overrides);
}

test("append: a retried POST (same entry ids) never double-appends", async () => {
  freshDataDir();
  const first = await audit.append("u1", [entry({ id: "e1" }), entry({ id: "e2" })]);
  assert.equal(first.appended, 2);
  const retry = await audit.append("u1", [entry({ id: "e1" }), entry({ id: "e2" })]);
  assert.equal(retry.appended, 0, "both ids already exist - a retried flush appends nothing new");
  const { total } = await audit.query("u1", {});
  assert.equal(total, 2);
});

test("append: entries land in the day file matching their own ts, and read back newest-first", async () => {
  freshDataDir();
  await audit.append("u1", [
    entry({ id: "e1", ts: "2026-09-08T09:00:00.000Z" }),
    entry({ id: "e2", ts: "2026-09-10T09:00:00.000Z" }),
    entry({ id: "e3", ts: "2026-09-10T15:00:00.000Z" })
  ]);
  const dates = await audit.availableDates("u1");
  assert.deepEqual(dates, ["2026-09-10", "2026-09-08"], "newest date first");
  const { entries } = await audit.query("u1", {});
  assert.deepEqual(entries.map(e => e.id), ["e3", "e2", "e1"], "newest timestamp first, across day files");
});

test("query: filters by action and a free-text query over the searchable fields", async () => {
  freshDataDir();
  await audit.append("u1", [
    entry({ id: "e1", action: "add", name: "Lightning Bolt" }),
    entry({ id: "e2", action: "remove", name: "Counterspell" }),
    entry({ id: "e3", action: "add", name: "Brainstorm", note: "found in a lot" })
  ]);
  const byAction = await audit.query("u1", { action: "add" });
  assert.equal(byAction.total, 2);
  assert.deepEqual(byAction.entries.map(e => e.id).sort(), ["e1", "e3"]);

  const byText = await audit.query("u1", { q: "counterspell" });
  assert.equal(byText.total, 1);
  assert.equal(byText.entries[0].id, "e2");

  const byNote = await audit.query("u1", { q: "found in a lot" });
  assert.equal(byNote.entries[0].id, "e3");
});

test("query: from/to date range and limit/offset pagination, with total reflecting the whole matched range not just the page", async () => {
  freshDataDir();
  await audit.append("u1", [
    entry({ id: "e1", ts: "2026-09-01T00:00:00.000Z" }),
    entry({ id: "e2", ts: "2026-09-05T00:00:00.000Z" }),
    entry({ id: "e3", ts: "2026-09-10T00:00:00.000Z" })
  ]);
  const ranged = await audit.query("u1", { from: "2026-09-02", to: "2026-09-10" });
  assert.equal(ranged.total, 2, "e1 (09-01) falls outside the range");
  assert.deepEqual(ranged.entries.map(e => e.id).sort(), ["e2", "e3"]);

  const page = await audit.query("u1", { limit: 1, offset: 1 });
  assert.equal(page.total, 3, "total counts every match in range, not just this page");
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].id, "e2", "newest-first order: e3, e2, e1 - offset 1 lands on e2");
});

test("pruneOld: drops day files older than keepDays (floored at 7), keeps the rest", async () => {
  freshDataDir();
  audit.init({ audit: { keepDays: 3 } }); // still floored to 7 by keepDays()
  const now = new Date();
  const iso = d => d.toISOString();
  const old = new Date(now); old.setDate(old.getDate() - 40);
  const recent = new Date(now); recent.setDate(recent.getDate() - 1);
  await audit.append("u1", [
    entry({ id: "e-old", ts: iso(old) }),
    entry({ id: "e-recent", ts: iso(recent) }),
    entry({ id: "e-now", ts: iso(now) })
  ]);
  const dates = await audit.availableDates("u1");
  assert.equal(dates.length, 2, "the 40-day-old entry's day file was pruned - append() calls pruneOld() every time");
  const { entries } = await audit.query("u1", {});
  assert.equal(entries.some(e => e.id === "e-old"), false);
  assert.ok(entries.some(e => e.id === "e-recent"));
  assert.ok(entries.some(e => e.id === "e-now"));
});

test("clear: removes every day file for that user", async () => {
  freshDataDir();
  await audit.append("u1", [entry({ id: "e1" })]);
  await audit.append("u2", [entry({ id: "e2" })]);
  await audit.clear("u1");
  assert.deepEqual(await audit.availableDates("u1"), []);
  assert.equal((await audit.query("u2", {})).total, 1, "clearing one user's log never touches another's");
});

/* #178: the Dashboard's Recent activity wants 12 rows, not a count of the
   whole log. total: false stops reading day files once the page is full. */
test("query total: false returns the newest rows without opening older day files, and total null", async () => {
  freshDataDir();
  const day = n => { const d = new Date(); d.setDate(d.getDate() - n); d.setUTCHours(12, 0, 0, 0); return d; };
  const rows = [];
  for (let n = 0; n < 4; n++) {
    for (let i = 0; i < 8; i++) {
      const t = new Date(day(n).getTime() + i * 60000);
      rows.push(entry({ id: "d" + n + "-" + i, ts: t.toISOString(), action: n === 3 ? "move" : "add" }));
    }
  }
  await audit.append("u1", rows);
  assert.equal((await audit.availableDates("u1")).length, 4);

  const opened = [];
  const realRead = store.readJson;
  store.readJson = async (file, dflt) => { opened.push(path.basename(file)); return realRead(file, dflt); };
  try {
    const all = await audit.query("u1", { limit: 400 });
    const newest = all.entries.slice(0, 12).map(e => e.id);
    assert.equal(all.total, 32, "the default still counts everything");
    assert.equal(opened.length, 4);

    opened.length = 0;
    const page = await audit.query("u1", { limit: 12, total: false });
    assert.equal(page.total, null);
    assert.deepEqual(page.entries.map(e => e.id), newest, "the same newest 12 rows");
    assert.equal(opened.length, 2, "12 rows fill from the two newest day files; the two older ones are never opened");

    opened.length = 0;
    const second = await audit.query("u1", { limit: 4, offset: 4, total: false });
    assert.deepEqual(second.entries.map(e => e.id), all.entries.slice(4, 8).map(e => e.id));
    assert.equal(opened.length, 1, "offset + limit fit in the newest file");

    opened.length = 0;
    const moves = await audit.query("u1", { action: "move", limit: 3, total: false });
    assert.equal(moves.entries.length, 3, "a filter keeps reading back until it has its rows");
    assert.ok(moves.entries.every(e => e.action === "move"));
    assert.equal(opened.length, 4);
  } finally {
    store.readJson = realRead;
  }
});

test("query: set + collector narrow to one printing exactly, with an exact total and paging (#410)", async () => {
  freshDataDir();
  await audit.append("u1", [
    entry({ id: "p1", set: "LEA", collector: "161", name: "Lightning Bolt" }),
    entry({ id: "p2", set: "lea", collector: "161", name: "Lightning Bolt", ts: "2026-09-10T12:01:00.000Z" }),
    entry({ id: "p3", set: "lea", collector: "1610", name: "Lightning Bolt" }),
    entry({ id: "p4", set: "m10", collector: "161", name: "Lightning Bolt" })
  ]);
  const one = await audit.query("u1", { set: "lea", collector: "161" });
  assert.equal(one.total, 2);
  assert.deepEqual(one.entries.map(e => e.id).sort(), ["p1", "p2"]);
  const paged = await audit.query("u1", { set: "LEA", collector: "161", limit: 1, offset: 1 });
  assert.equal(paged.total, 2);
  assert.equal(paged.entries.length, 1);
  // Over-long values are cut, not matched whole.
  const long = await audit.query("u1", { set: "x".repeat(500), collector: "1" });
  assert.equal(long.total, 0);
});
