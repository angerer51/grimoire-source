"use strict";
/* #137: POST /api/trades/propose reads its body with
   trades.PROPOSE_BODY_LIMIT. The server allows 50 lines a side, so a full
   50 + 50 offer as the trade composer sends it must fit through that cap,
   or the most the server accepts can never actually be sent. The route
   itself was also exercised over HTTP on a scratch server (see the PR). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { PassThrough } = require("stream");
const lib = n => require(path.join(__dirname, "..", "server", "lib", n));
const trades = lib("trades");
const httpu = lib("http");

function fakeReq(buf) {
  const req = new PassThrough();
  req.headers = { "content-length": String(buf.length) };
  req.end(buf);
  return req;
}

// A line exactly as public/js/tradeCompose.js tradeLine() sends it, with a
// longer-than-usual name and a real-length Scryfall image URL.
function composerLine(i, role) {
  return {
    name: "Some Fairly Long Legendary Creature Name " + i, set: "mh3", collector: String(100 + i), lang: "en",
    finish: i % 3 ? "nonfoil" : "foil", qty: 1 + (i % 4), price: 12.34, oracleId: "6da045f8-6278-4c84-9d39-025adf0789c1",
    role, imageUrl: "https://cards.scryfall.io/normal/front/6/d/6da045f8-6278-4c84-9d39-025adf0789c1.jpg?1562404626"
  };
}

test("a full 50 + 50 trade offer fits the propose route's body cap, with room to spare (#137)", async () => {
  const body = {
    toUsername: "bob", fromStoreId: null, note: "x".repeat(1000),
    offering: Array.from({ length: trades.MAX_LINES_PER_SIDE }, (_, i) => composerLine(i, "main")),
    requesting: Array.from({ length: trades.MAX_LINES_PER_SIDE }, (_, i) => composerLine(i + 50, "filler"))
  };
  const buf = Buffer.from(JSON.stringify(body));
  assert.ok(buf.length > 16384, "the old 16 KB cap really was too small (" + buf.length + " bytes)");
  assert.ok(buf.length < trades.PROPOSE_BODY_LIMIT * 0.75, "headroom left: " + buf.length + " of " + trades.PROPOSE_BODY_LIMIT);
  const parsed = await httpu.readJsonBody(fakeReq(buf), trades.PROPOSE_BODY_LIMIT);
  assert.equal(trades.sanitizeTradeLines(parsed.offering).length, 50);
  assert.equal(trades.sanitizeTradeLines(parsed.requesting).length, 50);
});

test("the propose cap is 64 KB, and a body over it is still refused with 413 (#137)", async () => {
  assert.equal(trades.PROPOSE_BODY_LIMIT, 65536);
  const huge = Buffer.from(JSON.stringify({ offering: [{ name: "x".repeat(70000) }] }));
  await assert.rejects(() => httpu.readJsonBody(fakeReq(huge), trades.PROPOSE_BODY_LIMIT), e => e.status === 413);
});
