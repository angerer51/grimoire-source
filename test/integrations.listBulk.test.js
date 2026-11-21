"use strict";
/* #225: manapoolListBulk / manapoolListBulkSealed against Manapool's real
   createListing response shapes (manapool.json). A card `inventory` row is
   an inventoryItem: its own top-level product_id is Manapool's product id,
   and the card identity is nested at product.single. A `skipped` row
   carries the identity at the top level. Grimoire used to read only the
   top level, so no inventory row ever matched, every push logged
   "N/N unconfirmed", and the results were attributed by position. */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const integrations = require(path.join(__dirname, "..", "server", "lib", "integrations"));

const logs = [];
integrations.init({
  manapool: { enabled: true, baseUrl: "https://mp.test/api/v1/",
    paths: { createListing: "seller/inventory/scryfall_id", createSealedListing: "seller/inventory/product" } }
}, { log: m => logs.push(m) });
const creds = { email: "seller@example.com", accessToken: "secret-token-xyz" };

let respond;            // (sentItems, url) -> response body
let requests;
beforeEach(() => {
  logs.length = 0;
  requests = [];
  globalThis.fetch = async (url, opts) => {
    const sent = JSON.parse(opts.body);
    requests.push({ url, sent });
    return new Response(JSON.stringify(respond(sent, url)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});

const SF = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const card = (i, extra) => Object.assign({ scryfallId: SF[i], lang: "en", finish: "nonfoil", condition: "NM",
  name: "Card " + i, set: "abc", collector: String(i + 1) }, extra || {});

/* One inventoryItem row, shaped per manapool.json. `over` overrides fields
   of the returned row (quantity, price_cents); `single` overrides the
   nested identity. */
function invRow(sentItem, over, single) {
  return Object.assign({
    id: "inv-" + sentItem.scryfall_id.slice(0, 4),
    product_type: "mtg_single",
    product_id: "9d08d62f-b4c7-4698-b255-" + sentItem.scryfall_id.slice(0, 12),
    product: {
      type: "mtg_single", id: "9d08d62f-b4c7-4698-b255-" + sentItem.scryfall_id.slice(0, 12), tcgplayer_sku: null,
      single: Object.assign({
        scryfall_id: sentItem.scryfall_id, mtgjson_id: "00000000-0000-0000-0000-000000000000", tcgplayer_id: null,
        name: "x", set: "ABC", number: "1",
        language_id: sentItem.language_id, condition_id: sentItem.condition_id, finish_id: sentItem.finish_id
      }, single || {}),
      unique: null
    },
    price_cents: sentItem.price_cents,
    quantity: sentItem.quantity,
    effective_as_of: "2026-10-14T12:00:00.000000+00",
    custom_external_id: null
  }, over || {});
}
const skipRow = (s, reason) => ({ scryfall_id: s.scryfall_id, language_id: s.language_id, finish_id: s.finish_id,
  condition_id: s.condition_id, reason });

test("inventory rows match on product.single identity, even returned in a different order", async () => {
  respond = sent => ({ inventory: sent.map(s => invRow(s)).reverse(), skipped: [] });
  const out = await integrations.manapoolListBulk(creds, [
    { card: card(0), quantity: 1, price: 1.5 },
    { card: card(1), quantity: 2, price: 2.5 },
    { card: card(2), quantity: 3, price: 3.5 }
  ]);
  assert.deepEqual(out.map(r => r.ok), [true, true, true]);
  assert.deepEqual(out.map(r => r.quantity), [1, 2, 3]);
  assert.deepEqual(out.map(r => r.price), [1.5, 2.5, 3.5]);
  assert.deepEqual(out.map(r => r.listingId), ["inv-1111", "inv-2222", "inv-3333"]);
  assert.ok(out.every(r => !r.warning));
  assert.match(logs[0], /matched by identity/);
});

test("a skip next to confirmed rows only fails the skipped item (no more 'couldn't be matched back')", async () => {
  respond = sent => ({ inventory: [invRow(sent[0]), invRow(sent[2])], skipped: [skipRow(sent[1], "incomplete_new_inventory")] });
  const out = await integrations.manapoolListBulk(creds, [
    { card: card(0), quantity: 1, price: 1 },
    { card: card(1), quantity: 1 },
    { card: card(2), quantity: 1, price: 1 }
  ]);
  assert.deepEqual(out.map(r => r.ok), [true, false, true]);
  assert.match(out[1].error, /needs a price/);
});

test("case differences between what is sent and what comes back still match", async () => {
  respond = sent => ({ inventory: sent.map(s => invRow(s, null, { scryfall_id: s.scryfall_id.toUpperCase(), condition_id: s.condition_id.toLowerCase() })), skipped: [] });
  const out = await integrations.manapoolListBulk(creds, [
    { card: card(0), quantity: 1, price: 1 },
    { card: card(1), quantity: 1, price: 1 }
  ]);
  assert.deepEqual(out.map(r => r.ok), [true, true]);
  assert.match(logs[0], /matched by identity/);
});

test("fewer copies back than sent is ok with Manapool's count, plus a warning naming the card", async () => {
  respond = sent => ({ inventory: [invRow(sent[0], { quantity: 0 }), invRow(sent[1], { quantity: 1 }), invRow(sent[2])], skipped: [] });
  const out = await integrations.manapoolListBulk(creds, [
    { card: card(0), quantity: 3, price: 1 },
    { card: card(1), quantity: 4, price: 1 },
    { card: card(2), quantity: 2, price: 1 }
  ]);
  assert.deepEqual(out.map(r => r.ok), [true, true, true]);
  assert.deepEqual(out.map(r => r.quantity), [0, 1, 2]);
  assert.match(out[0].warning, /^Card 0 \(ABC #1\): .*0 copies for sale.*sent 3/);
  assert.match(out[1].warning, /only 1 of the 4 copies/);
  assert.equal(out[2].warning, undefined);
});

test("quantity 0 sent and 0 back is not a warning (a deliberate take-down)", async () => {
  respond = sent => ({ inventory: sent.map(s => invRow(s)), skipped: [] });
  const out = await integrations.manapoolListBulk(creds, [{ card: card(0), quantity: 0, price: 1 }, { card: card(1), quantity: 2, price: 1 }]);
  assert.deepEqual(out.map(r => [r.ok, r.quantity, r.warning]), [[true, 0, undefined], [true, 2, undefined]]);
});

test("rows with no identity at all still fall back to request order when nothing was skipped", async () => {
  respond = sent => ({ inventory: sent.map(s => { const r = invRow(s); r.product = { type: "mtg_single", id: r.product_id }; return r; }), skipped: [] });
  const out = await integrations.manapoolListBulk(creds, [{ card: card(0), quantity: 2, price: 1 }, { card: card(1), quantity: 1, price: 1 }]);
  assert.deepEqual(out.map(r => r.quantity), [2, 1]);
  assert.match(logs[0], /matched by request order/);
});

test("the log line records sent vs returned quantity and price per item, and no credentials", async () => {
  respond = sent => ({ inventory: [invRow(sent[0], { quantity: 0, price_cents: 151 })], skipped: [skipRow(sent[1], "ambiguous_scryfall_id")] });
  await integrations.manapoolListBulk(creds, [{ card: card(0), quantity: 3, price: 1.5 }, { card: card(1), quantity: 1, price: 2 }]);
  assert.equal(logs.length, 1);
  const line = logs[0];
  assert.match(line, /2 item\(s\) sent/);
  assert.ok(line.includes(SF[0] + "|EN|NF|NM q3@150 -> q0@151 SHORT"), line);
  assert.ok(line.includes(SF[1] + "|EN|NF|NM q1@200 -> skipped:ambiguous_scryfall_id"), line);
  assert.match(line, /0 ok, 1 short, 1 failed/);
  assert.ok(!line.includes(creds.email) && !line.includes(creds.accessToken) && !line.includes("Card 0"));
});

test("sealed: inventory rows match on their top-level product_id", async () => {
  const P = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  respond = sent => ({
    inventory: sent.slice().reverse().map(s => ({ id: "inv-" + s.product_id.slice(0, 4), product_type: "mtg_sealed", product_id: s.product_id,
      product: { type: "mtg_sealed", id: s.product_id, tcgplayer_sku: null, single: null },
      price_cents: s.price_cents, quantity: s.product_id === P[1] ? 0 : s.quantity, effective_as_of: "2026-10-14T12:00:00+00", custom_external_id: null })),
    skipped: []
  });
  const out = await integrations.manapoolListBulkSealed(creds, [
    { item: { manapoolProductId: P[0], name: "Box A" }, quantity: 1, price: 100 },
    { item: { manapoolProductId: P[1], name: "Box B", setCode: "xyz" }, quantity: 2, price: 50 }
  ]);
  assert.match(requests[0].url, /seller\/inventory\/product$/);
  assert.deepEqual(out.map(r => [r.ok, r.listingId, r.quantity]), [[true, "inv-aaaa", 1], [true, "inv-bbbb", 0]]);
  assert.match(out[1].warning, /^Box B \(XYZ\): /);
});

/* #480: a whole request rejected with the bad item(s) named in `details`
   is retried once without them, so one bad card doesn't sink the batch. */
const reject = (status, message, details) => ({ status, body: { message, details } });
function respondWith(fn) {
  globalThis.fetch = async (url, opts) => {
    const sent = JSON.parse(opts.body);
    requests.push({ url, sent });
    const r = fn(sent, requests.length);
    const status = r && r.status ? r.status : 200;
    const body = r && r.status ? r.body : r;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}
const ident = s => ({ scryfall_id: s.scryfall_id, language_id: s.language_id, finish_id: s.finish_id, condition_id: s.condition_id });

test("a rejected batch naming one card is retried without it; the rest go through", async () => {
  respondWith((sent, n) => n === 1
    ? reject(404, "Product not found", [ident(sent[1])])
    : { inventory: sent.map(s => invRow(s)), skipped: [] });
  const out = await integrations.manapoolListBulk(creds, [
    { card: card(0), quantity: 1, price: 1 },
    { card: card(1), quantity: 1, price: 1 },
    { card: card(2), quantity: 1, price: 1 }
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].sent.map(s => s.scryfall_id), [SF[0], SF[2]]);
  assert.deepEqual(out.map(r => r.ok), [true, false, true]);
  assert.equal(out[1].error, "Manapool rejected Card 1 (ABC #2): Product not found.");
});

test("if the retry is rejected too, the retried cards get that failure, and there is no third try", async () => {
  respondWith((sent, n) => n === 1
    ? reject(404, "Product not found", [ident(sent[0])])
    : reject(404, "Product not found", [ident(sent[0])]));
  const out = await integrations.manapoolListBulk(creds, [
    { card: card(0), quantity: 1, price: 1 },
    { card: card(1), quantity: 1, price: 1 },
    { card: card(2), quantity: 1, price: 1 }
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(out.map(r => r.ok), [false, false, false]);
  assert.match(out[0].error, /^Manapool rejected Card 0 /);
  assert.match(out[1].error, /^Manapool rejected Card 1 /);
  assert.match(out[2].error, /^Not sent - a different item/);
});

test("a rejection that names nothing is not retried", async () => {
  respondWith(() => reject(400, "Bad request", []));
  const out = await integrations.manapoolListBulk(creds, [{ card: card(0), quantity: 1, price: 1 }, { card: card(1), quantity: 1, price: 1 }]);
  assert.equal(requests.length, 1);
  assert.deepEqual(out.map(r => r.ok), [false, false]);
});

test("sealed: a rejected batch naming one product is retried without it", async () => {
  const P = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  respondWith((sent, n) => n === 1
    ? reject(404, "Product not found", [{ product_id: P[0] }])
    : { inventory: sent.map(s => ({ id: "inv-" + s.product_id.slice(0, 4), product_type: "mtg_sealed", product_id: s.product_id,
        price_cents: s.price_cents, quantity: s.quantity })), skipped: [] });
  const out = await integrations.manapoolListBulkSealed(creds, [
    { item: { manapoolProductId: P[0], name: "Box A" }, quantity: 1, price: 100 },
    { item: { manapoolProductId: P[1], name: "Box B" }, quantity: 2, price: 50 }
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].sent.map(s => s.product_id), [P[1]]);
  assert.deepEqual(out.map(r => r.ok), [false, true]);
  assert.match(out[0].error, /^Manapool rejected Box A: Product not found\.$/);
});

test("batches are 100 items, and every item of a full batch is in its log line", async () => {
  respondWith(sent => ({ inventory: sent.map(s => invRow(s)), skipped: [] }));
  const hex = i => String(i).padStart(8, "0");
  const entries = Array.from({ length: 150 }, (_, i) => ({ card: card(0, { scryfallId: hex(i) + "-0000-4000-8000-000000000000" }), quantity: 1, price: 1 }));
  const out = await integrations.manapoolListBulk(creds, entries);
  assert.deepEqual(requests.map(r => r.sent.length), [100, 50]);
  assert.ok(out.every(r => r.ok));
  assert.ok(!logs[0].includes("more"), "first batch's log line lists all 100 items");
  assert.equal((logs[0].match(/\|NM q1@100 -> /g) || []).length, 100);
});
