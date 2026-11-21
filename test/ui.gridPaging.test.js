"use strict";
/* public/js/ui.js gridPageMath() - the Grid pager's paging maths (#427).
   Lifted out of the browser IIFE's source and evaluated alone. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "ui.js"), "utf8").replace(/\r\n/g, "\n");
const start = src.indexOf("    function gridPageMath(");
const end = src.indexOf("\n    }\n", start) + 7;
assert.ok(start > 0 && end > start, "gridPageMath() not found in ui.js");
const math = vm.runInNewContext(src.slice(start, end) + "\ngridPageMath;");
const plain = x => JSON.parse(JSON.stringify(x));

test("pages and slice bounds", () => {
  assert.deepEqual(plain(math(71234, 0, 100)), { page: 0, pages: 713, start: 0, end: 100 });
  assert.deepEqual(plain(math(71234, 712, 100)), { page: 712, pages: 713, start: 71200, end: 71234 });
  assert.deepEqual(plain(math(100, 0, 100)), { page: 0, pages: 1, start: 0, end: 100 });
  assert.deepEqual(plain(math(101, 1, 100)), { page: 1, pages: 2, start: 100, end: 101 });
});

test("a kept page is clamped when the list shrinks or the size grows", () => {
  assert.equal(math(150, 5, 100).page, 1);
  assert.equal(math(0, 3, 100).page, 0);
  assert.equal(math(0, 0, 100).pages, 1);
  assert.equal(math(900, 8, 500).page, 1);
  assert.equal(math(900, -2, 50).page, 0);
});

test("ui.js resets to page 1 on filter, sort and view changes", () => {
  assert.match(src, /Object\.assign\(filters, f\); page = 0; render\(\)/);
  assert.match(src, /function setMode\(m\) \{ if \(m !== mode\) page = 0;/);
  assert.equal((src.match(/page = 0;\n\s+render\(\);/g) || []).length, 4, "four sort handlers reset the page");
});
