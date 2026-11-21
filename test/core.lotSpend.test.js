"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

test("lotSpend: typed costs stand in while the total is empty or $0", () => {
  const G = freshCoreWithLocation().G || freshCoreWithLocation();
  assert.deepEqual({ ...G.lotSpend("", 35.005) }, { spend: 35.01, auto: true });
  assert.deepEqual({ ...G.lotSpend("0", 280) }, { spend: 280, auto: true });
  assert.deepEqual({ ...G.lotSpend(undefined, 12) }, { spend: 12, auto: true });
});

test("lotSpend: the user's own total wins, even below the typed costs", () => {
  const G = freshCoreWithLocation().G || freshCoreWithLocation();
  assert.deepEqual({ ...G.lotSpend("100", 280) }, { spend: 100, auto: false });
  assert.deepEqual({ ...G.lotSpend("", 0) }, { spend: 0, auto: false });
});
