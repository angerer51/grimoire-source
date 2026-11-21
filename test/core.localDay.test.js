"use strict";
/* G.localDay(): "YYYY-MM-DD" of a timestamp in the browser's LOCAL time zone
   (issue #57). The Receive page defaults a new lot's date
   to G.localDay(Date.now()); before #57 it used toISOString(), the UTC day,
   which is tomorrow for a seller west of UTC receiving in the evening and
   yesterday for one east of UTC early in the morning. These tests pin the
   process time zone (Node re-reads process.env.TZ on change). */
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshCore } = require("../test-lib/core-shim");

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

test("west of UTC, evening: the local day, not tomorrow's UTC day", () => {
  process.env.TZ = "America/Chicago";
  const G = freshCore();
  const ms = Date.parse("2026-10-09T03:30:00Z"); // 10:30 PM CDT on Oct 8
  assert.equal(new Date(ms).toISOString().slice(0, 10), "2026-10-09", "the old UTC default");
  assert.equal(G.localDay(ms), "2026-10-08");
});

test("east of UTC, early morning: the local day, not yesterday's UTC day", () => {
  process.env.TZ = "Asia/Tokyo";
  const G = freshCore();
  const ms = Date.parse("2026-10-08T22:15:00Z"); // 7:15 AM JST on Oct 9
  assert.equal(new Date(ms).toISOString().slice(0, 10), "2026-10-08", "the old UTC default");
  assert.equal(G.localDay(ms), "2026-10-09");
});

test("local midnight edges and zero-padding", () => {
  process.env.TZ = "America/Chicago";
  const G = freshCore();
  assert.equal(G.localDay(new Date(2026, 0, 5, 0, 0, 0).getTime()), "2026-01-05");
  assert.equal(G.localDay(new Date(2026, 0, 4, 23, 59, 59).getTime()), "2026-01-04");
  assert.equal(G.localDay(new Date(2026, 11, 31, 23, 59, 59).getTime()), "2026-12-31");
});

// The page code is inline DOM wiring with no test harness, so guard the call
// sites directly: each "today" default or filename uses the local day.
test("receive pages and the transfer export use G.localDay, not the UTC day", () => {
  const read = f => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
  for (const f of ["receive.page.js", "inventory.page.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /toISOString\(\)\.slice\(0,\s*10\)/, f + " still builds a UTC day");
    assert.match(src, /G\.localDay\(Date\.now\(\)\)/, f + " should use G.localDay(Date.now())");
  }
  for (const f of ["receive.page.js"])
    assert.match(read(f), /\$\("lotDate"\)\.value = d\.date \|\| G\.localDay\(Date\.now\(\)\);/, f);
});
