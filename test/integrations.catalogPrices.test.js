"use strict";
/* #529: manapoolCatalogPrices() against bad 200 answers. It used to turn
   anything that wasn't the expected list (an HTML page, {data: []}) into an
   empty Map, which cards.applyPriceSource() then applied as "no price for
   any printing" (0/543,023 priced on 2026-11-24). Now anything but a
   non-empty list of rows with Scryfall ids is an error. Real feed shape
   (fetched 2026-11-24): {meta: {as_of, base_url}, data: [{scryfall_id,
   price_market, price_market_foil, price_cents_nm, ...}]}. */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const integrations = require(path.join(__dirname, "..", "server", "lib", "integrations"));

integrations.init({
  manapool: { enabled: true, baseUrl: "https://mp.test/api/v1/", paths: { pricesSingles: "prices/singles" } }
}, { log: () => {} });

let body, contentType;
beforeEach(() => {
  contentType = "application/json";
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": contentType } });
});

const row = (id, cents) => ({ scryfall_id: id, price_market: cents, price_market_foil: null,
  price_cents_nm: cents + 10, price_cents_nm_foil: null, price_cents_nm_etched: null });

test("the real feed shape parses into a scryfallId -> price map", async () => {
  body = JSON.stringify({ meta: { as_of: "2026-11-24T00:00:00Z" }, data: [row("a", 150), row("b", 99), { price_market: 5 }] });
  const out = await integrations.manapoolCatalogPrices();
  assert.equal(out.size, 2, "the row without a scryfall_id is skipped");
  assert.equal(out.get("a").market, 1.5);
  assert.equal(out.get("b").nm, 1.09);
});

test("an empty list is an error, not an empty map", async () => {
  body = JSON.stringify({ meta: {}, data: [] });
  await assert.rejects(integrations.manapoolCatalogPrices(), e => e.status === 502 && /empty price list/.test(e.message));
  body = "[]";
  await assert.rejects(integrations.manapoolCatalogPrices(), /empty price list/);
});

test("an HTML page with a 200 is an error that quotes its start", async () => {
  contentType = "text/html";
  body = "<!DOCTYPE html>\n<html><head><title>Just a moment...</title></head><body></body></html>";
  await assert.rejects(integrations.manapoolCatalogPrices(),
    e => e.status === 502 && /isn't price data/.test(e.message) && /<!DOCTYPE html> <html>/.test(e.message));
});

test("an empty body, a wrong shape, or rows without Scryfall ids are errors too", async () => {
  body = "";
  await assert.rejects(integrations.manapoolCatalogPrices(), /came back empty/);
  body = JSON.stringify({ error: "maintenance" });
  await assert.rejects(integrations.manapoolCatalogPrices(), /without a list of prices/);
  body = JSON.stringify({ data: [{ price_market: 1 }, { price_market: 2 }] });
  await assert.rejects(integrations.manapoolCatalogPrices(), /2 rows but none with a Scryfall id/);
});
