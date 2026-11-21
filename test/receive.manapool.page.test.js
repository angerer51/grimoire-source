"use strict";
/* #353 part B: Receive's "Mana Pool order" source, through the real
   public/receive.page.js with the page-shim's stand-in DOM (not a browser).
   Every /api/manapool/* answer here is a stub: nothing talks to Mana Pool. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const LIST_ORDER = {
  id: "o1", orderNumber: "1234-5678", createdAt: "2026-10-20T15:00:00Z", subtotal: 30, tax: 2.4, shipping: 5, total: 37.4,
  packages: [
    { id: "pkg-a", seller: "alice", shipping: 2, receivedAt: null, itemCount: 3, detailed: false, items: [] },
    { id: "pkg-b", seller: "bob", shipping: 3, receivedAt: null, itemCount: 2, detailed: false, items: [] }
  ]
};
const item = (id, collector, qty, unitPrice, extra) => Object.assign({ kind: "card", orderItemId: id, set: "neo",
  collector, lang: "en", finish: "nonfoil", condition: "NM", name: "Card " + collector, scryfallId: "sf-" + collector,
  qty, unitPrice, matched: true }, extra || {});
// As the server sends it: lines matched to Grimoire's catalogs.
const DETAIL = Object.assign({}, LIST_ORDER, { packages: [
  Object.assign({}, LIST_ORDER.packages[0], { detailed: true, items: [item("i1", "10", 2, 5), item("i2", "11", 1, 3)] }),
  Object.assign({}, LIST_ORDER.packages[1], { detailed: true, items: [
    { kind: "sealed", orderItemId: "i3", name: "Foundations Play Booster Box", setCode: "fdn", manapoolProductId: "mp-box",
      tcgplayerProductId: "555", market: 12, qty: 1, unitPrice: 10, matched: true },
    item("i4", "12", 2, 3.5)] })
] });
const CARD = n => ({ id: "sf-" + n, name: "Card " + n, set: "neo", setName: "Neon Dynasty", collector: n, lang: "en",
  rarity: "rare", usd: 4, usdFoil: 9, finishes: ["nonfoil", "foil"] });

async function open(o) {
  o = o || {};
  const page = loadPage("receive.page.js", {
    routes: (url, init) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u", orgId: null, orgRole: null }, personalPrefs: null };
      if (url === "/api/collection" && method === "GET") {
        return { rev: 1, savedAt: null, owner: "u1", state: { cards: o.cards || [], sealed: [], receipts: o.receipts || [],
          locations: [{ id: "loc1", name: "Tray", type: "Box" }],
          settings: { tutorialSeen: true, simpleMode: false } } };
      }
      if (url === "/api/collection" && method === "PUT") return { rev: 2, savedAt: "2026-10-29T00:00:00Z" };
      if (url.startsWith("/api/manapool/purchases")) return o.listError || { orders: [LIST_ORDER], more: false };
      if (url.startsWith("/api/manapool/purchase/")) return { order: o.detail || DETAIL };
      if (url.includes("/received")) return o.markError || { ok: true };
      if (url.startsWith("/api/cards/one")) {
        const n = new URL(url, "http://x").searchParams.get("num");
        return (o.unknown || []).includes(n) ? { __status: 404, error: "not found" } : { card: CARD(n) };
      }
      return {};
    }
  });
  page.ui.Autocomplete = () => {};
  page.ui.CardPanel = () => ({ showCard() {}, message() {}, clear() {}, bump() {}, async showBySetNumber() { return null; } });
  await page.G.load();
  await page.boot();
  await settle(20);
  await page.$("srcManapool").click();
  await settle(20);
  return page;
}

// The purchase list's rows: an order line, then "Receive all", then one per package.
const rows = page => page.$("mpList").children;
const buttonOf = row => row.children.find(c => c.tagName === "BUTTON");
const activeDraft = page => page.G.state.settings.draftLots.find(d => d.id === page.G.state.settings.activeDraftLotId);
const posts = (page, re) => page.net.filter(r => r.method === "POST" && re.test(r.url));

test("the Mana Pool tab lists purchases; Receive all fills a lot receipt priced at what was paid", async () => {
  const page = await open();
  assert.equal(page.$("mpSection").hidden, false);
  assert.equal(page.$("lotSection").hidden, false, "the receipt it fills sits in the middle");
  assert.equal(page.$("entrySection").hidden, true);
  assert.equal(rows(page).length, 4);
  await buttonOf(rows(page)[1]).click();
  await settle(30);
  const d = activeDraft(page);
  assert.equal(d.alloc, "paid");
  assert.equal(d.spend, "37.4");
  assert.match(d.source, /Mana Pool order 1234-5678/);
  assert.deepEqual(Array.from(d.manapool.packages, p => p.id), ["pkg-a", "pkg-b"]);
  assert.equal(d.lines.length, 4);
  const box = d.lines.find(l => l.item === "sealed");
  assert.equal(box.tcgplayerProductId, "555");
  assert.equal(d.lines.every(l => l.locationId === "loc1"), true);

  await page.$("lotPost").click();
  await settle(30);
  const r = page.G.state.receipts[0];
  assert.equal(r.totalCost, 37.4, "the receipt adds up to what was paid");
  assert.equal(r.source, d.source);
  assert.deepEqual(Array.from(r.manapool.packageIds), ["pkg-a", "pkg-b"]);
  assert.equal(page.G.state.cards.reduce((s, c) => s + c.quantity, 0), 5, "cards in Card Inventory");
  assert.equal(page.G.state.sealed.length, 1, "the box in Sealed inventory");
  assert.ok(page.G.state.sealed[0].costQty === 1 && page.G.state.sealed[0].avgCost > 10, "price plus its share");
  // Ticked by default: both packages marked received on Mana Pool.
  assert.deepEqual(posts(page, /\/received$/).map(p => p.url),
    ["/api/manapool/purchase-package/pkg-a/received", "/api/manapool/purchase-package/pkg-b/received"]);
  assert.match(page.ui.toasts.at(-1), /marked received on Mana Pool/);
});

test("received once: the package shows its receipt and can't be received again", async () => {
  const page = await open({ receipts: [{ id: "r1", receiptId: "LOT-2026-0001", kind: "lot", ts: "2026-10-21T00:00:00Z",
    lines: [], manapool: { orderId: "o1", orderNumber: "1234-5678", packageIds: ["pkg-a"] } }] });
  const list = rows(page);
  // No "Receive all" (only one package left); pkg-a has no button, pkg-b does.
  assert.equal(list.length, 3);
  assert.match(list[1].innerHTML, /Received as LOT-2026-0001/);
  assert.equal(buttonOf(list[1]), undefined);
  await buttonOf(list[2]).click();
  await settle(30);
  assert.deepEqual(Array.from(activeDraft(page).manapool.packages, p => p.id), ["pkg-b"]);
  // Picking it again reopens that draft instead of making a second one.
  const n = page.G.state.settings.draftLots.length;
  await buttonOf(rows(page)[2]).click();
  await settle(10);
  assert.equal(page.G.state.settings.draftLots.length, n);
});

test("a draft whose package was posted elsewhere since won't post a second time", async () => {
  const page = await open();
  await buttonOf(rows(page)[2]).click();     // pkg-a
  await settle(30);
  page.G.state.receipts.unshift({ id: "r9", receiptId: "LOT-2026-0009", kind: "lot", lines: [],
    manapool: { orderId: "o1", packageIds: ["pkg-a"] } });
  const before = page.G.state.receipts.length;
  await page.$("lotPost").click();
  await settle(10);
  assert.equal(page.G.state.receipts.length, before);
  assert.match(page.ui.toasts.at(-1), /already received, as LOT-2026-0009/);
});

test("mark received unticked: nothing is sent to Mana Pool", async () => {
  const page = await open();
  await buttonOf(rows(page)[2]).click();
  await settle(30);
  page.$("lotMpMark").checked = false;
  await page.$("lotMpMark").fire("change");
  assert.equal(activeDraft(page).manapool.markReceived, false);
  await page.$("lotPost").click();
  await settle(30);
  assert.equal(page.G.state.receipts.length, 1);
  assert.equal(posts(page, /\/received$/).length, 0);
});

test("Mana Pool refusing the mark: the receipt stays saved and the error is shown in plain words", async () => {
  const page = await open({ markError: { __status: 403, error: "HTTP 401 from https://manapool.com/..." } });
  await buttonOf(rows(page)[2]).click();
  await settle(30);
  await page.$("lotPost").click();
  await settle(30);
  assert.equal(page.G.state.receipts.length, 1, "the receipt is saved");
  assert.match(page.ui.toasts.at(-1), /Posted LOT-.*but Mana Pool didn't take the "received" mark.*Reconnect Mana Pool/);
});

test("a token Mana Pool refuses for purchases: a plain message, not a sign-out", async () => {
  const page = await open({ listError: { __status: 403, error: "HTTP 401 from https://manapool.com/api/v1/buyer/orders" } });
  assert.match(page.$("mpStatus").textContent, /turned down Grimoire's connection.*Settings → Integrations/);
});

test("a card Grimoire can't match is a clear unmatched line that blocks posting", async () => {
  const page = await open({ unknown: ["11"] });
  await buttonOf(rows(page)[2]).click();
  await settle(30);
  const d = activeDraft(page);
  const bad = d.lines.find(l => l.unmatched);
  assert.equal(bad.name, "Card 11");
  assert.match(page.$("lotAllocNote").innerHTML, /isn't in Grimoire's catalog/);
  await page.$("lotPost").click();
  await settle(10);
  assert.equal(page.G.state.receipts.length, 0);
  assert.match(page.ui.toasts.at(-1), /aren't in Grimoire's catalog/);
});

const owned = (acquiredAt, qty) => ({ id: "c1", set: "neo", collector: "10", lang: "en", finish: "nonfoil", condition: "NM",
  name: "Card 10", quantity: qty, locationId: "loc1", acquiredAt, price: 4 });

test("already in inventory, added after the order: defaults to 'just set the cost' and adds nothing", async () => {
  const page = await open({ cards: [owned("2026-10-24T12:00:00Z", 2)] });
  await buttonOf(rows(page)[2]).click();     // pkg-a: 2x Card 10, 1x Card 11
  await settle(30);
  const d = activeDraft(page);
  assert.equal(d.lines.find(l => l.collector === "10").dupe, "cost");
  assert.equal(d.lines.find(l => l.collector === "11").dupe, undefined);
  await page.$("lotPost").click();
  await settle(30);
  const stack = page.G.state.cards.find(c => c.collector === "10");
  assert.equal(stack.quantity, 2, "no copies added");
  assert.equal(stack.costQty, 2);
  assert.ok(stack.avgCost > 5, "price paid plus its share of shipping and tax");
  assert.equal(page.G.state.receipts[0].lines.find(l => l.collector === "10").existing, 2);
  assert.equal(page.G.state.receipts[0].totalCost, 16.04, "still the whole package's money");
});

test("already in inventory from before the order: defaults to 'add as new copies'", async () => {
  const page = await open({ cards: [owned("2026-09-01T12:00:00Z", 1)] });
  await buttonOf(rows(page)[2]).click();
  await settle(30);
  assert.equal(activeDraft(page).lines.find(l => l.collector === "10").dupe, "new");
  await page.$("lotPost").click();
  await settle(30);
  assert.equal(page.G.state.cards.find(c => c.collector === "10").quantity, 3, "1 owned + 2 bought");
});

test("two sellers, same card: seller B's copies are added after seller A's package is posted, A's cost kept", async () => {
  const split = Object.assign({}, DETAIL, { packages: [DETAIL.packages[0],
    Object.assign({}, DETAIL.packages[1], { items: [item("i5", "10", 1, 5)] })] });
  const page = await open({ detail: split });
  await buttonOf(rows(page)[2]).click();     // pkg-a: 2x Card 10, 1x Card 11
  await settle(30);
  await page.$("lotPost").click();
  await settle(30);
  const a = page.G.state.cards.find(c => c.collector === "10");
  const costA = a.costTotal;
  assert.equal(a.quantity, 2);
  // pkg-a is received now: the list is the order line, then pkg-a, then pkg-b.
  await buttonOf(rows(page)[2]).click();
  await settle(30);
  assert.equal(activeDraft(page).lines.find(l => l.collector === "10").dupe, "new");
  await page.$("lotPost").click();
  await settle(30);
  const stack = page.G.state.cards.find(c => c.collector === "10");
  assert.equal(stack.quantity, 3, "2 from A + 1 from B");
  assert.equal(stack.costQty, 3);
  assert.ok(stack.costTotal > costA, "A's cost kept, B's added");
});
