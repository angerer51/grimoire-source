"use strict";
/* Manapool pushes send only what changes (#482).

   Listings' Push and Bulk Price's card and sealed pushes read the live
   Manapool listings first and leave out every listing Manapool already
   shows at exactly the quantity and price the push would send. The skip
   decision is core.js manapoolPushAlreadyLive / splitManapoolPush, over
   manapoolLiveListings. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreWithLocation } = require("../test-lib/core-shim");

// core.js runs in its own vm realm: copy results before deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));
const KEY = "abc-123|en|nonfoil|NM";
const card = (o) => Object.assign({ kind: "card", scryfallId: "abc-123", lang: "en", finish: "nonfoil", condition: "NM", quantity: 2, price: 1.25 }, o);

function live(listings, sealed) {
  return freshCoreWithLocation("loc1", "Shelf A").manapoolLiveListings(listings, sealed);
}

test("manapoolLiveListings: card listings by identity with quantity and price, sealed left out", () => {
  const m = live([card({ lang: "EN" }), { kind: "sealed", tcgplayerProductId: "9", quantity: 5, price: 40 }]);
  assert.equal(m.size, 1);
  assert.deepEqual(plain(m.get(KEY)), { quantity: 2, price: 125 });
});

test("manapoolLiveListings: rows of one identity sum their quantities; a price disagreement means 'send it'", () => {
  assert.deepEqual(plain(live([card({ quantity: 2 }), card({ quantity: 1 })]).get(KEY)), { quantity: 3, price: 125 });
  assert.deepEqual(plain(live([card({ quantity: 2 }), card({ quantity: 1, price: 1.3 })]).get(KEY)), { quantity: 3, price: null });
});

test("manapoolPushAlreadyLive: quantity and price both match -> skip", () => {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  const m = G.manapoolLiveListings([card()]);
  assert.equal(G.manapoolPushAlreadyLive(m.get(KEY), 2, 1.25), true);
  // Price compared in cents, so float noise doesn't force a send.
  assert.equal(G.manapoolPushAlreadyLive(m.get(KEY), 2, 0.1 + 1.15), true);
});

test("manapoolPushAlreadyLive: quantity differs -> send", () => {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  const m = G.manapoolLiveListings([card()]);
  assert.equal(G.manapoolPushAlreadyLive(m.get(KEY), 3, 1.25), false);
  assert.equal(G.manapoolPushAlreadyLive(m.get(KEY), 1, 1.25), false);
  assert.equal(G.manapoolPushAlreadyLive(m.get(KEY), 0, 1.25), false, "taking a live listing down is a change");
});

test("manapoolPushAlreadyLive: price differs -> send", () => {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  const m = G.manapoolLiveListings([card()]);
  assert.equal(G.manapoolPushAlreadyLive(m.get(KEY), 2, 1.24), false);
  assert.equal(G.manapoolPushAlreadyLive(m.get(KEY), 2, null), false, "no price to compare -> send");
});

test("manapoolPushAlreadyLive: not on Manapool at all", () => {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  assert.equal(G.manapoolPushAlreadyLive(undefined, 0, 1.25), true, "target 0 and nothing live: nothing to take down");
  assert.equal(G.manapoolPushAlreadyLive(undefined, 0, null), true);
  assert.equal(G.manapoolPushAlreadyLive(undefined, 2, 1.25), false, "copies to list and nothing live: must be sent");
});

test("splitManapoolPush: keeps keys and entries paired, upToDate carries the numbers to record", () => {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  const other = "def-456|en|foil|LP";
  const gone = "ghi-789|en|nonfoil|NM";
  const m = G.manapoolLiveListings([card(), card({ scryfallId: "def-456", finish: "foil", condition: "LP", quantity: 1, price: 3 })]);
  const keys = [KEY, other, gone];
  const entries = [{ quantity: 2, price: 1.25, tag: "a" }, { quantity: 1, price: 3.5, tag: "b" }, { quantity: 0, price: 0.5, tag: "c" }];
  const out = G.splitManapoolPush(keys, entries, m);
  assert.deepEqual(plain(out.keys), [other]);
  assert.deepEqual(plain(out.entries.map(e => e.tag)), ["b"]);
  assert.deepEqual(plain(out.upToDate), [{ key: KEY, quantity: 2, price: 1.25 }, { key: gone, quantity: 0, price: 0.5 }]);
});

test("sealed: keyed by TCGplayer product id, same skip rule", () => {
  const G = freshCoreWithLocation("loc1", "Shelf A");
  const m = G.manapoolLiveListings([
    { kind: "sealed", tcgplayerProductId: "tcg-1", quantity: 2, price: 49.99 },
    { kind: "sealed", tcgplayerProductId: "tcg-2", quantity: 1, price: 20 },
    card()
  ], true);
  assert.equal(m.size, 2, "card listings left out of the sealed read");
  const out = G.splitManapoolPush(["tcg-1", "tcg-2"], [{ quantity: 2, price: 49.99 }, { quantity: 1, price: 18 }], m);
  assert.deepEqual(plain(out.keys), ["tcg-2"]);
  assert.deepEqual(plain(out.upToDate.map(u => u.key)), ["tcg-1"]);
});
