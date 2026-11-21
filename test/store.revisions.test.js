"use strict";
/* server/lib/store.js revisions (#157, #158) and the Store-document rules
   writeCollection enforces for #159. Real file I/O against a scratch
   dataDir, never the live one. Each test uses its own owner key: the
   archive throttle (lastRevisionAt) is process-wide. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "server", "lib", "store"));
const orgs = require(path.join(__dirname, "..", "server", "lib", "orgs"));

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-rev-test-"));
  tmpDirs.push(dir);
  store.init({ dataDir: dir });
  return dir;
}

const stacks = (n, qty) => Array.from({ length: n }, (_, i) => ({ id: "c" + i, quantity: qty || 1 }));
const doc = (cards, extra) => Object.assign({ cards, locations: [{ id: "l1" }] }, extra || {});
const revFile = (owner, rev) => path.join(store.ownerDir(owner), "rev", String(rev).padStart(8, "0") + ".json");

/* Counts JSON.parse calls on big inputs (a whole revision), not the small
   header/summary parses. */
function countBigParses(fn) {
  const real = JSON.parse;
  let big = 0;
  JSON.parse = function (text, ...rest) {
    if (typeof text === "string" && text.length > 2000) big++;
    return real.call(this, text, ...rest);
  };
  return Promise.resolve().then(fn).then(out => ({ out, big }), e => { throw e; })
    .finally(() => { JSON.parse = real; });
}

/* ---------- #157: destructive saves always keep what they replace ---------- */

test("#157: a forced save inside the 5-minute window still archives the version it replaces", async () => {
  freshDataDir();
  const o = "f157-force";
  await store.writeCollection(o, doc(stacks(3)), -1);            // rev 1
  await store.writeCollection(o, doc(stacks(4)), 1);             // rev 2, archives rev 1
  await store.writeCollection(o, doc([]), 2, { forceRevision: true }); // the Erase: must archive rev 2
  const revs = await store.listRevisions(o);
  assert.deepEqual(revs.map(r => r.rev), [2, 1], "the pre-erase version (rev 2) is in the list");
  assert.equal(revs[0].stacks, 4);
  const full = await store.readRevision(o, 2);
  assert.equal(full.state.cards.length, 4, "and it restores in full");
});

test("#157: without the flag, a save that drops most stacks of a 50+ stack collection is archived anyway", async () => {
  freshDataDir();
  const o = "f157-net";
  await store.writeCollection(o, doc(stacks(60)), -1);           // rev 1
  await store.writeCollection(o, doc(stacks(60, 2)), 1);         // rev 2, archives rev 1
  await store.writeCollection(o, doc(stacks(10)), 2);            // drops 50 of 60: archives rev 2
  assert.deepEqual((await store.listRevisions(o)).map(r => r.rev), [2, 1]);
});

test("#157: ordinary saves are still throttled (small collection, or not most stacks gone)", async () => {
  freshDataDir();
  const o = "f157-throttle";
  await store.writeCollection(o, doc(stacks(60)), -1);
  await store.writeCollection(o, doc(stacks(60)), 1);            // archives rev 1
  await store.writeCollection(o, doc(stacks(31)), 2);            // 29 of 60 gone: under half, throttled
  await store.writeCollection(o, doc(stacks(31)), 3);
  assert.deepEqual((await store.listRevisions(o)).map(r => r.rev), [1]);
  const small = "f157-small";
  await store.writeCollection(small, doc(stacks(10)), -1);
  await store.writeCollection(small, doc(stacks(10)), 1);        // archives rev 1
  await store.writeCollection(small, doc([]), 2);                // under 50 stacks: no net, throttled
  assert.deepEqual((await store.listRevisions(small)).map(r => r.rev), [1]);
});

/* ---------- #158: listing reads a header, not 30 whole collections ---------- */

test("#158: listing revisions parses no whole revision file", async () => {
  freshDataDir();
  const o = "f158-head";
  await store.writeCollection(o, doc(stacks(200, 2)), -1);
  await store.writeCollection(o, doc(stacks(150, 3)), 1, { forceRevision: true });
  await store.writeCollection(o, doc(stacks(100)), 2, { forceRevision: true });
  const { out, big } = await countBigParses(() => store.listRevisions(o));
  assert.equal(big, 0, "no revision file was parsed whole");
  assert.deepEqual(out.map(r => [r.rev, r.stacks, r.cards, r.locations]), [[2, 150, 450, 1], [1, 200, 400, 1]]);
  assert.ok(out.every(r => typeof r.savedAt === "string"));
});

test("#158: a revision written before the summary existed is summarised once, rewritten, and restores unchanged", async () => {
  freshDataDir();
  const o = "f158-legacy";
  await store.writeCollection(o, doc(stacks(5)), -1);            // rev 1: makes the dirs
  const state = doc(stacks(120, 2), { settings: { chime: false } });
  const oldText = JSON.stringify({ rev: 7, savedAt: "2026-10-01T10:00:00.000Z", state }); // the pre-#158 format
  fs.writeFileSync(revFile(o, 7), oldText);

  const first = await countBigParses(() => store.listRevisions(o));
  assert.equal(first.big, 1, "the old file is parsed once");
  assert.deepEqual(first.out, [{ rev: 7, savedAt: "2026-10-01T10:00:00.000Z", stacks: 120, cards: 240, locations: 1 }]);

  const text = fs.readFileSync(revFile(o, 7), "utf8");
  assert.ok(text.startsWith('{"rev":7,"savedAt":"2026-10-01T10:00:00.000Z","summary":{"stacks":120,"cards":240,"locations":1},"state":'),
    "the summary now sits at the front");
  assert.ok(text.endsWith(oldText.slice(oldText.indexOf('"state":'))), "the state's bytes are untouched");

  const second = await countBigParses(() => store.listRevisions(o));
  assert.equal(second.big, 0, "never parsed again");
  assert.deepEqual(second.out, first.out);

  const back = await store.readRevision(o, 7);
  assert.deepEqual(back.state, state, "Restore reads the same collection as before");
});

/* 30 ordinary (5-minute-spaced) revisions already on disk, rev 1..30, in the
   pre-#158 format, and current.json at rev 31 with `n` stacks. Written
   directly: the test can't wait out the real 5-minute spacing. */
function seedHistory(o, n) {
  const dir = path.dirname(revFile(o, 1));
  fs.mkdirSync(dir, { recursive: true });
  for (let r = 1; r <= store.REVISIONS; r++) {
    fs.writeFileSync(revFile(o, r), JSON.stringify({ rev: r, savedAt: "2026-10-0" + (1 + (r % 9)) + "T00:00:00.000Z", state: doc(stacks(n)) }));
  }
  fs.writeFileSync(path.join(store.ownerDir(o), "current.json"), JSON.stringify({ rev: 31, savedAt: null, state: doc(stacks(n)) }));
}

test("#158: a pruned revision drops out of the list; a corrupt old one is set aside, not listed", async () => {
  freshDataDir();
  const o = "f158-prune";
  seedHistory(o, 3);
  await store.writeCollection(o, doc(stacks(4)), 31);            // first save this process: due, an ordinary archive of 31
  const revs = await store.listRevisions(o);
  assert.equal(revs.length, store.REVISIONS, "capped at REVISIONS");
  assert.equal(revs[revs.length - 1].rev, 2, "the oldest was pruned and isn't listed");

  fs.writeFileSync(revFile(o, 999), '{"rev":999,"savedAt":null,"state":{"cards":[');
  const after = await store.listRevisions(o);
  assert.ok(!after.some(r => r.rev === 999));
  assert.ok(fs.readdirSync(path.dirname(revFile(o, 999))).some(f => f.startsWith("00000999.json.corrupt.")));
});

test("#157 review: emptying and refilling 60 times can't push the 30 spaced revisions out", async () => {
  freshDataDir();
  const o = "f157-flood";
  seedHistory(o, 60);
  await store.writeCollection(o, doc(stacks(60)), 31);           // due: ordinary archive of rev 31 (prunes rev 1)
  let rev = 32;
  for (let i = 0; i < 60; i++) {
    await store.writeCollection(o, doc([]), rev++);              // big drop: forced copy of the full version
    await store.writeCollection(o, doc(stacks(60)), rev++);      // refill: inside the spacing, not archived
  }
  const revs = await store.listRevisions(o);
  const ordinary = revs.filter(r => !r.forced), forced = revs.filter(r => r.forced);
  assert.equal(ordinary.length, store.REVISIONS, "all 30 ordinary revisions are still there");
  assert.deepEqual(ordinary.map(r => r.rev).sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i + 2));
  assert.equal(forced.length, store.FORCED_REVISIONS, "forced copies are capped separately");
  assert.equal(forced[0].rev, rev - 2, "the version just before the latest big drop is kept");
  assert.ok(forced.every(r => r.stacks === 60), "each forced copy is the full version that was emptied");
});

test("#157 review: a forced copy is labelled in the list; an ordinary one is not", async () => {
  freshDataDir();
  const o = "f157-label";
  seedHistory(o, 5);
  await store.writeCollection(o, doc(stacks(5)), 31);            // ordinary archive of 31; spacing clock starts
  await store.writeCollection(o, doc([]), 32, { forceRevision: true }); // forced copy of 32
  const revs = await store.listRevisions(o);
  assert.equal(revs[0].rev, 32);
  assert.equal(revs[0].forced, true);
  assert.equal(revs[1].rev, 31);
  assert.equal(revs[1].forced, undefined);
});

/* ---------- #159: what a save may change in a Store's document ---------- */

test("#386: Require bin scan is a store default: a Staff save can't change it, a Manager's can", async () => {
  freshDataDir();
  assert.ok(orgs.STORE_DEFAULT_KEYS.includes("requireBinScan"));
  const o = "store:f386-binscan";
  await store.writeCollection(o, doc(stacks(1), { settings: { requireBinScan: true, cycleCountSampleSize: 10 } }), -1);
  const staffLocked = orgs.lockedSettingKeys({ orgRole: "staff" }, o);
  assert.ok(staffLocked.includes("requireBinScan"));
  await store.writeCollection(o, doc(stacks(1), { settings: { requireBinScan: false, cycleCountSampleSize: 99 } }), 1, { lockSettings: staffLocked });
  let got = await store.readCollection(o);
  assert.equal(got.state.settings.requireBinScan, true, "a tap can't be switched on from a staff login");
  assert.equal(got.state.settings.cycleCountSampleSize, 10);
  const mgrLocked = orgs.lockedSettingKeys({ orgRole: "manager" }, o);
  assert.ok(!mgrLocked.includes("requireBinScan"));
  await store.writeCollection(o, doc(stacks(1), { settings: { requireBinScan: false } }), got.rev, { lockSettings: mgrLocked });
  got = await store.readCollection(o);
  assert.equal(got.state.settings.requireBinScan, false);
});

test("#159 review: a save with settings missing, null or not an object keeps the Store's settings", async () => {
  freshDataDir();
  const locked = orgs.lockedSettingKeys({ orgRole: "staff" }, "store:x");
  const onDisk = { defaultCondition: "LP", moversDays: 14, simpleMode: true, chime: false, draftLots: [{ id: "d1" }] };
  for (const [label, settings] of [["missing", undefined], ["null", null], ["a string", "x"], ["an array", ["a"]]]) {
    const o = "store:f159-nosettings-" + label.replace(/\s/g, "");
    await store.writeCollection(o, doc(stacks(2), { settings: onDisk }), -1);
    const incoming = doc(stacks(3));
    if (settings !== undefined) incoming.settings = settings;
    await store.writeCollection(o, incoming, 1, { lockSettings: locked });
    const got = await store.readCollection(o);
    assert.deepEqual(got.state.settings, onDisk, "settings " + label + ": kept as on disk");
    assert.equal(got.state.cards.length, 3, "the rest of the save still lands");
  }
});

test("#159 owner's answer: a Staff save that empties most of a Store is logged with who and how many", async () => {
  freshDataDir();
  const audit = require(path.join(__dirname, "..", "server", "lib", "audit"));
  audit.init({});
  const staff = { id: "s1", username: "sam", displayName: "Sam", orgId: "o", orgRole: "staff" };
  const manager = { id: "m1", username: "mo", orgId: "o", orgRole: "manager" };
  const full = doc(stacks(60, 2)), empty = doc(stacks(5, 2));

  const entry = orgs.staffBigDropEntry(staff, "store:x", full, empty, 41);
  assert.equal(entry.action, "delete");
  assert.equal(entry.by, "Sam");
  assert.equal(entry.byUserId, "s1");
  assert.match(entry.note, /^Sam removed 55 of 60 stacks \(110 cards\) in one save\..*revision 41/);

  assert.equal(orgs.staffBigDropEntry(manager, "store:x", full, empty, 41), null, "managers aren't flagged");
  assert.equal(orgs.staffBigDropEntry(staff, "s1", full, empty, 41), null, "not a store");
  assert.equal(orgs.staffBigDropEntry(staff, "store:x", full, doc(stacks(40, 2)), 41), null, "not a big drop");
  assert.equal(orgs.staffBigDropEntry(staff, "store:x", doc(stacks(10)), doc([]), 41), null, "under 50 stacks");

  await audit.append("store:x", [entry]);
  const got = await audit.query("store:x", { action: "delete" });
  assert.equal(got.entries.length, 1);
  assert.equal(got.entries[0].byUserId, "s1", "it's in the Store's activity log");
});

test("#159: lockSettings keeps the on-disk value of the locked keys and lets every other key through", async () => {
  freshDataDir();
  const o = "store:f159-lock";
  await store.writeCollection(o, doc(stacks(2), { settings: { defaultCondition: "LP", simpleMode: false, draftLots: [] } }), -1);
  await store.writeCollection(o, doc(stacks(2), {
    settings: { defaultCondition: "NM", simpleMode: true, moversDays: 30, draftLots: [{ id: "d1" }] }
  }), 1, { lockSettings: ["defaultCondition", "simpleMode", "moversDays"] });
  const s = (await store.readCollection(o)).state.settings;
  assert.equal(s.defaultCondition, "LP", "a locked key keeps what was there");
  assert.equal(s.simpleMode, false);
  assert.equal("moversDays" in s, false, "a locked key that wasn't set stays unset");
  assert.deepEqual(s.draftLots, [{ id: "d1" }], "unlocked keys save as sent");
});

test("#159: who may replace a Store's inventory, and which settings each role's saves keep", () => {
  const staff = { id: "s", orgId: "o", orgRole: "staff" };
  const manager = { id: "m", orgId: "o", orgRole: "manager" };
  const owner = { id: "w", orgId: "o", orgRole: "owner" };
  const personal = { id: "p", orgId: null, orgRole: null };
  assert.equal(orgs.canReplaceInventory(staff, "store:x"), false);
  assert.equal(orgs.canReplaceInventory(manager, "store:x"), true);
  assert.equal(orgs.canReplaceInventory(owner, "store:x"), true);
  assert.equal(orgs.canReplaceInventory(personal, "p"), true, "personal accounts are unaffected");

  assert.deepEqual(orgs.lockedSettingKeys(personal, "p"), []);
  assert.deepEqual(orgs.lockedSettingKeys(manager, "store:x").sort(), ["chime", "chimeMin", "dashTiles", "nextStepsDismissed", "simpleMode", "whatsNewDone"]);
  const st = orgs.lockedSettingKeys(staff, "store:x");
  for (const k of ["autoPutaway", "lotAllocation", "defaultCondition", "moversDays", "cycleCountSampleSize",
    "cycleCountErrorThreshold", "shipping", "simpleMode", "chime", "chimeMin", "nextStepsDismissed", "dashTiles"]) assert.ok(st.includes(k), k);
  assert.ok(!st.includes("draftLots") && !st.includes("stickySetCode"), "everyday working state stays editable");
});

test("#159: personalPrefsFrom keeps only well-typed personal fields", () => {
  assert.deepEqual(orgs.personalPrefsFrom({ simpleMode: true, chime: false, chimeMin: "25", defaultCondition: "LP" }),
    { simpleMode: true, chime: false, chimeMin: 25 });
  assert.deepEqual(orgs.personalPrefsFrom({ simpleMode: "yes", chimeMin: -1 }), {});
  assert.deepEqual(orgs.personalPrefsFrom(null), {});
  assert.deepEqual(orgs.personalPrefsFrom({ nextStepsDismissed: true }), { nextStepsDismissed: true }, "#244");
  assert.deepEqual(orgs.personalPrefsFrom({ nextStepsDismissed: 1 }), {});
});

test("#298: personalPrefsFrom keeps a clean, small Dashboard tile layout", () => {
  assert.deepEqual(orgs.personalPrefsFrom({ dashTiles: [{ id: "cards" }, { id: "movers", wide: true }, { id: "value", wide: "yes" }] }),
    { dashTiles: [{ id: "cards" }, { id: "movers", wide: true }, { id: "value" }] });
  assert.deepEqual(orgs.personalPrefsFrom({ dashTiles: null }), { dashTiles: null }, "null = back to the default layout");
  assert.deepEqual(orgs.personalPrefsFrom({ dashTiles: [{ id: "cards" }, { id: "cards" }, "value", { id: "<b>" }, { id: "x".repeat(40) }, null] }),
    { dashTiles: [{ id: "cards" }] }, "repeats, bare strings, bad ids and junk are dropped");
  assert.deepEqual(orgs.personalPrefsFrom({ dashTiles: "cards" }), {});
  const many = Array.from({ length: 100 }, (_, i) => ({ id: "t" + i, wide: true }));
  const kept = orgs.personalPrefsFrom({ dashTiles: many }).dashTiles;
  assert.equal(kept.length, 60);
  assert.ok(JSON.stringify({ dashTiles: kept }).length < 4096, "a full layout fits the 4 KB prefs body");
});
