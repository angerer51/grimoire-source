"use strict";
/* The Receive / tour printing picker (#324): newest release first, and a
   typed filter over set name, set code, collector number and year. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const card = (set, collector, setName, releasedAt) => ({ set, collector, setName, releasedAt });

test("sortPrintingsNewest: newest first, undated last, ties by set then number", () => {
  const G = freshCore();
  const list = [
    card("lea", "269", "Limited Edition Alpha", "1993-08-05"),
    card("c21", "263", "Commander 2021", "2021-04-23"),
    card("xxx", "1", "No date", ""),
    card("c21", "10", "Commander 2021", "2021-04-23"),
    card("eoe", "10", "Edge of Eternities", "2025-08-01")
  ];
  const out = G.sortPrintingsNewest(list).map(c => c.set + c.collector);
  assert.equal(JSON.stringify(out), JSON.stringify(["eoe10", "c2110", "c21263", "lea269", "xxx1"]));
});

test("printingMatches: every word must hit set name, code, number or year", () => {
  const G = freshCore();
  const c = card("c21", "263", "Commander 2021", "2021-04-23");
  assert.equal(G.printingMatches(c, ""), true);
  assert.equal(G.printingMatches(c, "commander"), true);
  assert.equal(G.printingMatches(c, "C21 263"), true);
  assert.equal(G.printingMatches(c, "2021"), true);
  assert.equal(G.printingMatches(c, "commander alpha"), false);
});
