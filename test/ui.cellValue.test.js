"use strict";
/* public/js/ui.js cellValue() - the generic column sort's per-cell key.
   ui.js is a browser IIFE, so this lifts just CLEAN_NUM + cellValue out of
   its source and evaluates them alone. #79: data-v is numbers only;
   data-vs is a text sort key (a <select> cell's chosen label) that is never
   read as a number, so a bin named "101" still sorts as a name. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "ui.js"), "utf8").replace(/\r\n/g, "\n");
const cleanNum = src.match(/^ {2}const CLEAN_NUM = .*$/m)[0];
const start = src.indexOf("  function cellValue(td) {");
const end = src.indexOf("\n  }\n", start) + 4;
assert.ok(start > 0 && end > start, "cellValue() not found in ui.js");
const cellValue = vm.runInNewContext(cleanNum + "\n" + src.slice(start, end) + "\ncellValue;");
const plain = x => JSON.parse(JSON.stringify(x));

const td = (text, data) => ({ textContent: text, dataset: data || {} });
// The column comparison sortTable() uses when no cell in it is numeric.
const textOrder = keys => keys
  .map(k => cellValue(td("Binder A (binder)Box 1 (box)", { vs: k })))
  .sort((a, b) => a.s.localeCompare(b.s, undefined, { numeric: true, sensitivity: "base" }))
  .map(v => v.s);

test("numeric data-v sorts as a number, ignoring the text", () => {
  assert.deepEqual(plain(cellValue(td("$1,234 ▲", { v: "1234" }))), { empty: false, n: 1234, s: "1234", numeric: true });
});

test("data-v stays numbers-only: blank or non-numeric is an empty cell", () => {
  assert.equal(cellValue(td("whatever", { v: "" })).empty, true);
  assert.equal(cellValue(td("whatever", { v: "Binder A" })).empty, true);
});

test("data-vs is always a text key, even when it looks like a number (#79)", () => {
  for (const k of ["101", "1e3", "0x1A", "Infinity", " 2 "]) {
    const v = cellValue(td("101", { vs: k }));
    assert.equal(v.empty, false, k);
    assert.equal(v.numeric, undefined, k);
    assert.equal(v.s, k.trim().toLowerCase(), k);
  }
});

test("data-vs: blank sinks, case-insensitive, natural order", () => {
  assert.equal(cellValue(td("x", { vs: "" })).empty, true);
  assert.equal(cellValue(td("x", { vs: "  " })).empty, true);
  assert.deepEqual(textOrder(["box 10", "Binder A", "101", "Box 2", "binder b"]),
    ["101", "binder a", "binder b", "box 2", "box 10"]);
});

test("data-vs wins over data-v and textContent", () => {
  assert.equal(cellValue(td("999", { vs: "Shelf", v: "5" })).s, "shelf");
});

test("without data-v/data-vs, cells still fall back to textContent", () => {
  assert.equal(cellValue(td("  NEO ")).s, "neo");
  assert.equal(cellValue(td("—")).empty, true);
  assert.equal(cellValue(td("$12.50")).n, 12.5);
});
