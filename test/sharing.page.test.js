"use strict";
/* #129-#132: the Sharing pages (trade composer, Social's friend view, Trade
   Proposals) through their real scripts with the stand-in DOM in
   test-lib/page-shim.js. What a proposal posts, which friend's answer wins
   when two are in flight, and how a big shared collection is drawn. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const ALLOWED = ["name", "set", "collector", "lang", "finish", "qty", "price", "oracleId", "role", "imageUrl"];

// A whole inventory stack, with the private and bulky fields a real one has.
function fatStack(i, extra) {
  return Object.assign({
    id: "s" + i, name: "Card " + String(i).padStart(5, "0"), set: "abc", collector: String(i), lang: "en",
    finish: "nonfoil", quantity: 2, listedQty: 0, price: 1 + (i % 50) / 10, oracleId: "o" + i,
    imageUrl: "https://cards.scryfall.io/normal/front/6/d/6da045f8-6278-4c84-9d39-025adf0789c1.jpg?1562404626",
    edhrecRank: 100 + i, costBasis: 0.42, locationId: "LOC-secret", condition: "NM",
    oracleText: "Flying. ".repeat(60), typeLine: "Creature — Dragon", artist: "Someone", keywords: ["Flying"],
    colors: ["R"], manapoolPrice: 3, vendorPrices: { a: 1, b: 2 }
  }, extra || {});
}

// A deferred answer, so a test can decide which of two requests lands first.
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function composerPage(routes) {
  return loadPage("social.page.js", { scripts: ["js/tradeCompose.js"], routes });
}
const proposals = pg => pg.net.filter(r => r.url === "/api/trades/propose");

test("a trade offer posts only the server's line fields (#129)", async () => {
  const pg = composerPage(url => {
    if (url.includes("/api/friends/collection")) return { data: [fatStack(900, { name: "Their Card" })] };
    if (url.includes("/api/friends/watchlist")) return { data: [] };
    return {};
  });
  for (let i = 0; i < 30; i++) pg.G.state.cards.push(fatStack(i));
  await pg.sandbox.TradeCompose.openForRow(
    { name: "Wanted Card", set: "xyz", collector: "1", lang: "en", low: 20, oracleId: "w", imageUrl: "" }, "bob");
  await pg.$("tcSend").fire("click");
  const sent = proposals(pg);
  assert.equal(sent.length, 1, "the offer was sent");
  const { offering, requesting } = sent[0].body;
  assert.ok(offering.length > 1 && requesting.length >= 1);
  for (const l of offering.concat(requesting)) {
    for (const k of Object.keys(l)) assert.ok(ALLOWED.includes(k), "unexpected field " + k);
  }
  const raw = JSON.stringify(sent[0].body);
  for (const secret of ["costBasis", "locationId", "LOC-secret", "oracleText", "vendorPrices", "edhrecRank", "why"]) {
    assert.ok(!raw.includes(secret), secret + " left the browser");
  }
  // A realistic line is now ~300 bytes instead of ~1.2 KB.
  assert.ok(raw.length / (offering.length + requesting.length) < 320, "per-line size " + raw.length);
});

// Many lines with long names and image URLs, the most a filler suggestion
// adds (one main card plus up to 25 filler lines).
async function bigOffer(nameLen) {
  const pg = composerPage(url => {
    if (url.includes("/api/friends/collection")) return { data: [] };
    if (url.includes("/api/friends/watchlist")) return { data: [] };
    return {};
  });
  const long = "https://cards.scryfall.io/normal/front/" + "x".repeat(440) + ".jpg";
  for (let i = 0; i < 60; i++) pg.G.state.cards.push(fatStack(i, { name: "N".repeat(nameLen) + i, price: 1, imageUrl: long }));
  await pg.sandbox.TradeCompose.openForRow(
    { name: "Wanted Card", set: "xyz", collector: "1", lang: "en", low: 60, oracleId: "w", imageUrl: "" }, "bob");
  await pg.$("tcSend").fire("click");
  return pg;
}

test("an offer over the old 16 KB limit is now sent, since the server takes 64 KB (#137)", async () => {
  const pg = await bigOffer(190);
  const sent = proposals(pg);
  assert.equal(sent.length, 1, "the offer was sent");
  const bytes = Buffer.byteLength(JSON.stringify(sent[0].body));
  assert.ok(bytes > 16384 && bytes < 65536, "body size " + bytes);
});

test("an offer too big for the server's 64 KB limit says so instead of failing (#129, #137)", async () => {
  const pg = await bigOffer(3000);
  assert.equal(proposals(pg).length, 0, "nothing posted");
  assert.match(pg.ui.toasts.join("\n"), /too many cards to send/);
});

test("switching friends mid-load never leaves the previous friend's cards (#131)", async () => {
  const slow = { collection: deferred(), watch: deferred() };
  const pg = composerPage((url, init, body) => {
    if (url === "/api/friends") return { friends: [], sharedWithMe: [{ username: "alice" }, { username: "bob" }] };
    const who = body && body.username;
    if (who === "alice") return url.includes("collection") ? slow.collection.promise : slow.watch.promise;
    if (url.includes("/api/friends/collection")) return { data: [{ name: "Bob's Card", set: "b", collector: "1", price: 2, quantity: 1 }] };
    if (url.includes("/api/friends/watchlist")) return { data: [] };
    return {};
  });
  pg.sandbox.TradeCompose.open({});
  await settle();
  pg.$("tcFriendSelect").value = "alice";
  const aliceLoad = pg.$("tcFriendSelect").fire("change");
  pg.$("tcFriendSelect").value = "bob";
  await pg.$("tcFriendSelect").fire("change");
  assert.match(pg.$("tcTheirBrowseBody").innerHTML, /Bob&#39;s Card|Bob's Card/);
  // alice's slow answer lands last; it must be dropped.
  slow.collection.resolve({ data: [{ name: "Alice's Card", set: "a", collector: "1", price: 2, quantity: 1 }] });
  slow.watch.resolve({ data: [] });
  await aliceLoad;
  await settle();
  const html = pg.$("tcTheirBrowseBody").innerHTML;
  assert.doesNotMatch(html, /Alice/, "alice's collection replaced bob's");
  assert.match(html, /Bob/);
  assert.doesNotMatch(pg.$("tcTheirAddArea").innerHTML, /Loading/);
});

test("the composer browses a 70k-stack collection sorted, capped and filtered (#130)", async () => {
  const pg = composerPage(url => (url.includes("/api/friends/") ? { data: [] } : {}));
  for (let i = 69999; i >= 0; i--) pg.G.state.cards.push(fatStack(i, { oracleText: "" }));
  pg.sandbox.TradeCompose.open({ username: "bob", lockFriend: true });
  await settle();
  const body = pg.$("tcMyBrowseBody");
  assert.match(pg.$("tcMyBrowseMore").textContent, /Showing top 150 of 70,000/);
  assert.ok(body.innerHTML.indexOf("Card 00000") < body.innerHTML.indexOf("Card 00001"), "sorted by name, not insertion order");
  // Typing and redrawing re-filter the cached sorted pool; nothing re-sorts.
  let sorts = 0;
  const sortRows = pg.G.sortRows;
  pg.G.sortRows = function () { sorts++; return sortRows.apply(null, arguments); };
  pg.$("tcMySearch").value = "Card 0001";
  await pg.$("tcMySearch").fire("input");
  assert.match(pg.$("tcMyBrowseMore").textContent, /70,000/, "a keystroke waits for the pause in typing");
  await settle(200);
  assert.equal(pg.$("tcMyBrowseMore").textContent, "", "10 matches, all drawn");
  assert.equal((body.innerHTML.match(/<tr>/g) || []).length, 10);
  assert.ok(body.innerHTML.indexOf("Card 00010") < body.innerHTML.indexOf("Card 00019"), "still in name order");
  assert.equal(sorts, 0, "the filter did not re-sort 70k stacks");
});

/* ---------- Social: the friend's collection modal ---------- */
function socialPage(share) {
  const pg = loadPage("social.page.js", {
    scripts: ["js/tradeCompose.js"],
    routes: url => {
      if (url === "/api/friends") return { friends: [], sharedWithMe: [], defaultShare: "off" };
      const m = url.match(/^\/api\/share\/(.+)$/);
      if (m) return share(decodeURIComponent(m[1]));
      return {};
    }
  });
  // The page wires its View buttons with querySelectorAll; hand it one.
  const viewBtn = { dataset: {} };
  pg.$("sharedBody").querySelectorAll = sel => (sel === "[data-view]" ? [viewBtn] : []);
  const view = async who => { viewBtn.dataset.view = who; await viewBtn.onclick(); };
  return { pg, view };
}
const summary = who => ({ username: who, displayName: who, level: "full", stacks: 0, cards: 0, distinctNames: 0,
  totalValue: 0, listedForSale: 0, top: [] });

test("friend view folds identical stacks, caps the rows and sorts the whole list (#130)", async () => {
  const cards = [];
  for (let i = 0; i < 1200; i++) {
    const c = { name: "Card " + String(i).padStart(4, "0"), set: "abc", collector: String(i), lang: "en", finish: "nonfoil",
      quantity: 1, listedQty: 0, price: 1, imageUrl: "" };
    cards.push(c, Object.assign({}, c, { quantity: 2, listedQty: 1 }));   // same printing, another (hidden) location
  }
  cards.push({ name: "Card 1199", set: "abc", collector: "1199", lang: "en", finish: "foil", quantity: 7, price: 1 });
  const { pg, view } = socialPage(who => ({ summary: summary(who), cards }));
  await pg.boot();
  await view("alice");
  const body = pg.$("fvGridBody").innerHTML;
  assert.equal((body.match(/<tr>/g) || []).length, 500, "drawn rows are capped");
  assert.match(pg.$("fvMore").textContent, /Showing 500 of 1,201/, "2,401 stacks fold to 1,201 rows");
  assert.match(body, /Card 0000[\s\S]*?<td class="num">3<\/td>/, "quantities of folded stacks add up");
  assert.match(body, /<span class="badge sale">1<\/span>/);

  // Sort by Qty, highest first: the foil (7) lives past the first 500 rows.
  pg.ui.sortStateOf = () => ({ col: 4, dir: -1 });
  pg.$("fvSearch").value = "";
  await pg.$("fvSearch").fire("input");
  await settle(200);
  assert.match(pg.$("fvGridBody").innerHTML, /^<tr><td><\/td><td class="card-name" data-vs="Card 1199">/, "whole-list sort");
});

test("viewing a second friend while the first is loading shows the second (#131)", async () => {
  const alice = deferred();
  const { pg, view } = socialPage(who => (who === "alice" ? alice.promise : { summary: summary("bob"), cards: [] }));
  await pg.boot();
  const first = view("alice");
  await view("bob");
  alice.resolve({ summary: summary("alice"), cards: [{ name: "Alice's Card", set: "a", collector: "1", quantity: 1, price: 1 }] });
  await first;
  await settle();
  assert.equal(pg.$("fvTitle").textContent, "bob's collection");
  assert.doesNotMatch(pg.$("fvGridBody").innerHTML, /Alice/);
});

/* ---------- Trade Proposals ---------- */
test("Trade Proposals rows carry the full card image for the hover preview (#132)", async () => {
  const img = "https://cards.scryfall.io/normal/front/a/b/abc.jpg?1";
  const pg = loadPage("trades.page.js", {
    scripts: ["js/tradeCompose.js"],
    routes: url => (url === "/api/trades" ? { data: [{
      id: "p1", fromUserId: "me", fromUsername: "me", toUserId: "them", toUsername: "them", status: "open",
      createdAt: "2026-10-09T00:00:00Z",
      offering: [{ name: "A", qty: 1, price: 1, role: "main", imageUrl: img }],
      requesting: [{ name: "B", qty: 1, price: 1, role: "main", imageUrl: "" }]
    }] } : {})
  });
  Object.defineProperty(pg.G, "me", { value: { id: "me" } });   // signed in as the sender
  await pg.boot();
  assert.ok(pg.$("outList").innerHTML.includes('<tr data-img="' + img + '">'), "full imageUrl, not the art crop");
});

/* ---------- #128: share and trade from ---------- */
test("an org account's offer gives from the inventory it trades from, not the store open in the app (#128)", async () => {
  const pg = composerPage(url => {
    if (url === "/api/trades/my-pool") {
      return { actFrom: { kind: "store", storeId: "s1", storeName: "One", orgName: "Org" },
        data: [fatStack(1, { name: "Store Card", price: 25 })] };
    }
    if (url.includes("/api/friends/collection")) return { store: null, data: [] };
    if (url.includes("/api/friends/watchlist")) return { data: [] };
    return {};
  });
  Object.defineProperty(pg.G, "me", { value: { id: "me", orgId: "org1" } });
  pg.G.state.cards.push(fatStack(2, { name: "Open Store Card", price: 25 }));
  await pg.sandbox.TradeCompose.openForRow(
    { name: "Wanted Card", set: "xyz", collector: "1", lang: "en", low: 20, oracleId: "w", imageUrl: "" }, "bob");
  await settle();
  await pg.$("tcSend").fire("click");
  const sent = proposals(pg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.fromStoreId, "s1", "says which inventory the lines came from");
  const names = sent[0].body.offering.map(l => l.name);
  assert.ok(names.includes("Store Card"));
  assert.ok(!names.includes("Open Store Card"), "never the app's open store");
});

test("an account outside any org still gives from its own collection and asks for no pool (#128)", async () => {
  const pg = composerPage(url => {
    if (url.includes("/api/friends/collection")) return { data: [] };
    if (url.includes("/api/friends/watchlist")) return { data: [] };
    return {};
  });
  Object.defineProperty(pg.G, "me", { value: { id: "me", orgId: null } });
  pg.G.state.cards.push(fatStack(3, { name: "My Card", price: 25 }));
  await pg.sandbox.TradeCompose.openForRow(
    { name: "Wanted Card", set: "xyz", collector: "1", lang: "en", low: 20, oracleId: "w", imageUrl: "" }, "bob");
  await settle();
  await pg.$("tcSend").fire("click");
  const sent = proposals(pg);
  assert.equal(sent[0].body.fromStoreId, null);
  assert.ok(sent[0].body.offering.some(l => l.name === "My Card"));
  assert.ok(!pg.net.some(r => r.url === "/api/trades/my-pool"));
});

test("a proposal to a store shows as incoming, with Accept, for one of its managers it wasn't addressed to (#128)", async () => {
  const pg = loadPage("trades.page.js", {
    scripts: ["js/tradeCompose.js"],
    routes: url => (url === "/api/trades" ? { data: [{
      id: "p1", fromUserId: "alice", fromUsername: "alice", toUserId: "mgr", toUsername: "mgr",
      toStoreId: "s1", toStoreName: "One", status: "open", createdAt: "2026-10-09T00:00:00Z",
      incoming: true, outgoing: false, canRespond: true, canWithdraw: false,
      offering: [{ name: "A", qty: 1, price: 1, role: "main" }],
      requesting: [{ name: "B", qty: 1, price: 1, role: "main" }]
    }] } : {})
  });
  Object.defineProperty(pg.G, "me", { value: { id: "mgr2", username: "mgr2" } });
  await pg.boot();
  const html = pg.$("inList").innerHTML;
  assert.match(html, /data-act="accept"/);
  assert.match(html, /to One, addressed to mgr/);
  assert.doesNotMatch(pg.$("outList").innerHTML, /data-id="p1"/);
});

/* ---------- Social: friend requests (#140) ---------- */
function requestsPage() {
  let friendsCalls = 0;
  const pg = loadPage("social.page.js", {
    scripts: ["js/tradeCompose.js"],
    routes: url => {
      if (url === "/api/friends") {
        friendsCalls++;
        return {
          friends: [
            { username: "bob", displayName: "Bob", exists: true, friend: true, share: null, sees: "summary" },
            { username: "carl", displayName: "carl", exists: true, friend: false, share: "off", sees: "off" }
          ],
          requests: { incoming: [{ id: "r<1>", username: "dee", displayName: "Dee", at: "2026-10-10T12:00:00Z" }],
            outgoing: [{ id: "r2", username: "eve", displayName: "Eve", at: "2026-10-09T12:00:00Z" }], maxPending: 20 },
          sharedWithMe: [], defaultShare: "summary"
        };
      }
      if (url === "/api/friends/requests") return { ok: true, status: "sent", message: "Friend request sent to zed." };
      if (url.startsWith("/api/friends/requests/")) return { ok: true, status: "accepted", message: "You and dee are now friends." };
      return {};
    }
  });
  return { pg, calls: () => friendsCalls };
}

test("Social draws incoming requests with Accept/Decline, sent ones with Cancel, and friends with a level picker (#140)", async () => {
  const { pg } = requestsPage();
  await pg.boot();
  await settle();
  const inc = pg.$("reqInBody").innerHTML, out = pg.$("reqOutBody").innerHTML, fr = pg.$("friendBody").innerHTML;
  assert.match(inc, /Dee/);
  assert.match(inc, /data-accept="r&lt;1&gt;"/, "ids are escaped");
  assert.match(inc, /data-decline=/);
  assert.match(out, /Eve/);
  assert.match(out, /data-cancel="r2"/);
  assert.equal(pg.$("reqOutHint").textContent, "1 of 20 requests you can have waiting at once.");
  // A friend with no level of their own: "same as everyone else", picked.
  assert.match(fr, /<option value="" selected>same as everyone else \(a summary\)<\/option>/);
  assert.match(fr, /data-unfriend="bob"/);
  // Someone who isn't a friend: no picker, only Remove.
  assert.match(fr, /not a friend/);
  assert.match(fr, /data-forget="carl"/);
  assert.doesNotMatch(fr, /data-level="carl"/);
});

test("Send request posts the username only; Accept posts the action and reloads (#140)", async () => {
  const { pg, calls } = requestsPage();
  const accept = { dataset: {}, disabled: false };
  pg.$("reqInBody").querySelectorAll = sel => (sel === "[data-accept]" ? [accept] : []);
  await pg.boot();
  await settle();
  pg.$("friendPick").value = "zed";
  await pg.$("friendAdd").fire("click");
  await settle();
  const sent = pg.net.filter(r => r.url === "/api/friends/requests");
  assert.equal(sent.length, 1);
  assert.deepEqual(typeof sent[0].body === "string" ? JSON.parse(sent[0].body) : sent[0].body, { username: "zed" });
  accept.dataset.accept = "r<1>";
  const before = calls();
  await accept.onclick();
  await settle();
  const answered = pg.net.filter(r => r.url.startsWith("/api/friends/requests/"));
  assert.equal(answered[0].url, "/api/friends/requests/r%3C1%3E/respond");
  assert.deepEqual(typeof answered[0].body === "string" ? JSON.parse(answered[0].body) : answered[0].body, { action: "accept" });
  assert.ok(calls() > before, "reloads the lists");
});

/* ---------- #147: which inventory "You give" comes from, and the empty-personal offer ---------- */
const PC = { id: "s1", name: "Personal Collection" };
const FRIENDS = {
  friends: [{ username: "bob", displayName: "Bob", exists: true, friend: true, share: "full", sees: "full" }],
  sharedWithMe: [], defaultShare: "off", requests: { incoming: [], outgoing: [] }
};

/* The composer for an org account acting from its personal cards. `pool`
   overrides the /api/trades/my-pool answer; after a switch to s1 the pool
   answers from the store. */
function orgComposer(pool) {
  let switched = false;
  const pg = composerPage((url, init, body) => {
    if (url === "/api/trades/my-pool") {
      return switched
        ? { actFrom: { kind: "store", storeId: "s1", storeName: "Personal Collection", orgName: "Org" },
            data: [fatStack(5, { name: "Store Card", price: 3 })], personalCards: null, canChooseStore: true, stores: [PC], notice: null }
        : Object.assign({ actFrom: { kind: "personal", storeId: null, storeName: null, orgName: null },
            data: [], personalCards: 0, canChooseStore: true, stores: [PC], notice: null }, pool || {});
    }
    if (url === "/api/sharing/act-from") {
      switched = !!(body && body.storeId);
      return { current: { kind: "store", storeId: "s1", storeName: "Personal Collection", orgName: "Org" }, stores: [PC] };
    }
    if (url === "/api/friends") return FRIENDS;
    if (url.includes("/api/friends/collection")) return { store: null, data: [] };
    if (url.includes("/api/friends/watchlist")) return { data: [] };
    return {};
  });
  Object.defineProperty(pg.G, "me", { value: { id: "me", orgId: "org1" } });
  return pg;
}
const openWanting = pg => pg.sandbox.TradeCompose.openForRow(
  { name: "Wanted Card", set: "xyz", collector: "1", lang: "en", low: 20, oracleId: "w", imageUrl: "" }, "bob");

test("an empty personal pool says so, in the browse list and in Suggest filler, and offers the store (#147)", async () => {
  const pg = orgComposer();
  await openWanting(pg);
  await settle();
  assert.equal(pg.$("tcMyFrom").textContent, "from your personal cards", "says where You give comes from");
  assert.match(pg.$("tcMyBrowseBody").innerHTML, /You're trading from your personal cards, which are empty\./);
  const note = pg.$("tcMyNote").innerHTML;
  assert.match(note, /Your personal cards are empty\. Share and trade from <b>Personal Collection<\/b>\?/);
  assert.match(note, /data-use-store="s1"/);
  await pg.$("tcSuggest").fire("click");
  const toast = pg.ui.toasts[pg.ui.toasts.length - 1];
  assert.match(toast, /which are empty/);
  assert.doesNotMatch(toast, /closes that gap/, "not the generic message");
});

test("the offer is only for Owners/Managers, and only when their personal cards are empty (#147)", async () => {
  const staff = orgComposer({ canChooseStore: false, stores: [] });
  await openWanting(staff);
  await settle();
  assert.equal(staff.$("tcMyNote").innerHTML, "");
  assert.match(staff.$("tcMyBrowseBody").innerHTML, /which are empty\. Only your organization's owners and managers can trade from a store\./);

  const hasCards = orgComposer({ personalCards: 4 });
  await openWanting(hasCards);
  await settle();
  assert.equal(hasCards.$("tcMyNote").innerHTML, "", "personal cards that exist (unpriced): no offer");
  assert.match(hasCards.$("tcMyBrowseBody").innerHTML, /none of them has a price/);

  const fromStore = orgComposer({ actFrom: { kind: "store", storeId: "s1", storeName: "Personal Collection", orgName: "Org" }, personalCards: null });
  await openWanting(fromStore);
  await settle();
  assert.equal(fromStore.$("tcMyNote").innerHTML, "");
  assert.equal(fromStore.$("tcMyFrom").textContent, "from Personal Collection (Org)");
});

test("several stores: one button each, and past three a pointer to the Social picker (#147)", async () => {
  const two = orgComposer({ stores: [PC, { id: "s2", name: "Shop" }] });
  await openWanting(two);
  await settle();
  const note = two.$("tcMyNote").innerHTML;
  assert.match(note, /one of your stores\?/);
  assert.match(note, /data-use-store="s1"/);
  assert.match(note, /data-use-store="s2"/);
  const many = orgComposer({ stores: [1, 2, 3, 4].map(i => ({ id: "s" + i, name: "Store " + i })) });
  await openWanting(many);
  await settle();
  assert.doesNotMatch(many.$("tcMyNote").innerHTML, /data-use-store/);
  assert.match(many.$("tcMyNote").innerHTML, /href="\/social\.html#sharing"/);
});

test("accepting the offer goes through the who-will-see-it confirmation and the same save, then gives from the store (#147)", async () => {
  const pg = orgComposer();
  const btn = { dataset: { useStore: "s1" } };
  pg.$("tcMyNote").querySelectorAll = sel => (sel === "[data-use-store]" ? [btn] : []);
  await openWanting(pg);
  await settle();
  // Cancelled: nothing saved.
  pg.ui.confirmAnswer = false;
  await btn.onclick();
  assert.equal(pg.net.filter(r => r.url === "/api/sharing/act-from").length, 0);
  assert.match(pg.ui.confirms[0], /Personal Collection's inventory will take the place of your personal cards/);
  assert.match(pg.ui.confirms[0], /Who will see it:\n- Bob \(bob\): the full card list/);
  // Accepted.
  pg.ui.confirmAnswer = true;
  await btn.onclick();
  await settle();
  const saves = pg.net.filter(r => r.url === "/api/sharing/act-from");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].method, "POST");
  assert.deepEqual(saves[0].body, { storeId: "s1" });
  assert.equal(pg.$("tcMyFrom").textContent, "from Personal Collection (Org)");
  assert.equal(pg.$("tcMyNote").innerHTML, "", "offer gone");
  assert.match(pg.$("tcMyBrowseBody").innerHTML, /Store Card/);
});

test("the composer shows why a store choice was cleared, and Got it dismisses it (#147)", async () => {
  const pg = orgComposer({ notice: "Pop-up Shop was archived, so you're sharing and trading from your personal cards again." });
  await openWanting(pg);
  await settle();
  assert.match(pg.$("tcMyNote").innerHTML, /Pop-up Shop was archived/);
  await pg.$("tcNoticeOk").fire("click");
  assert.doesNotMatch(pg.$("tcMyNote").innerHTML, /Pop-up Shop/);
  assert.equal(pg.net.filter(r => r.url === "/api/sharing/act-from/dismiss").length, 1);
});

/* Social's picker, offer and notice. */
function actFromSocial(view) {
  const pg = loadPage("social.page.js", {
    scripts: ["js/tradeCompose.js"],
    routes: (url, init, body) => {
      if (url === "/api/friends") return FRIENDS;
      if (url === "/api/sharing/act-from/dismiss") { if (view) view.notice = null; return { ok: true }; }
      if (url === "/api/sharing/act-from") {
        return init && init.method === "POST"
          ? { current: { kind: "store", storeId: body.storeId, storeName: "Personal Collection", orgName: "Org" }, stores: [PC] }
          : Object.assign({ current: { kind: "personal", storeId: null }, stores: [PC], inOrg: true, canChooseStore: true,
              personalCards: 0, notice: null }, view || {});
      }
      return {};
    }
  });
  return pg;
}

test("Social labels the personal option with its card count, so it can't be read as a store (#147)", async () => {
  let pg = actFromSocial();
  await pg.boot();
  assert.match(pg.$("actFrom").innerHTML, /^<option value="">My personal cards \(empty\)<\/option><option value="s1">Personal Collection<\/option>/);
  pg = actFromSocial({ personalCards: 1234 });
  await pg.boot();
  assert.match(pg.$("actFrom").innerHTML, /My personal cards \(1,234 cards\)/);
  pg = actFromSocial({ canChooseStore: false, stores: [], personalCards: null });
  await pg.boot();
  assert.match(pg.$("actFrom").innerHTML, /^<option value="">My personal cards<\/option>$/);
});

test("Social offers the store to an Owner/Manager on empty personal cards, through the picker's confirmation and save (#147)", async () => {
  const pg = actFromSocial();
  const btn = { dataset: { useStore: "s1" } };
  pg.$("actFromOffer").querySelectorAll = sel => (sel === "[data-use-store]" ? [btn] : []);
  await pg.boot();
  assert.match(pg.$("actFromOffer").innerHTML, /Your personal cards are empty\. Share and trade from <b>Personal Collection<\/b>\?/);
  await btn.onclick();
  await settle();
  assert.equal(pg.ui.confirms.length, 1);
  assert.match(pg.ui.confirms[0], /Who will see it:\n- Bob \(bob\): the full card list/);
  const saves = pg.net.filter(r => r.url === "/api/sharing/act-from" && r.method === "POST");
  assert.deepEqual(saves.map(r => r.body), [{ storeId: "s1" }]);
  // The picker's own change takes the very same path.
  const viaPicker = actFromSocial();
  await viaPicker.boot();
  viaPicker.$("actFrom").value = "s1";
  await viaPicker.$("actFrom").fire("change");
  assert.equal(viaPicker.ui.confirms.length, 1);
  assert.deepEqual(viaPicker.net.filter(r => r.url === "/api/sharing/act-from" && r.method === "POST").map(r => r.body), [{ storeId: "s1" }]);

  const hasCards = actFromSocial({ personalCards: 3 });
  await hasCards.boot();
  assert.equal(hasCards.$("actFromOffer").innerHTML, "", "no offer when the personal cards aren't empty");
});

/* Review of PR #150: Social with a server that remembers the setting, so a
   switch made anywhere shows up in what the page draws next. #151 hooks:
   srv.offline makes every act-from request fail as if the server can't be
   reached, srv.afterSave runs after a saved POST, and srv.gate(view) can
   hold back a GET's answer (return a promise of it). */
function statefulSocial() {
  const srv = { storeId: null, notice: null, offline: false, afterSave: null, gate: null };
  const view = () => ({
    current: srv.storeId ? { kind: "store", storeId: "s1", storeName: "Personal Collection", orgName: "Org" }
      : { kind: "personal", storeId: null, storeName: null, orgName: null },
    stores: [PC], inOrg: true, canChooseStore: true, personalCards: 0, notice: srv.notice
  });
  const pg = loadPage("social.page.js", {
    scripts: ["js/tradeCompose.js"],
    routes: (url, init, body) => {
      if (url === "/api/friends") return FRIENDS;
      if (url === "/api/sharing/act-from/dismiss") { srv.notice = null; return { ok: true }; }
      if (url === "/api/sharing/act-from") {
        if (srv.offline) throw new Error("Failed to fetch");
        if (init && init.method === "POST") {
          srv.storeId = body.storeId || null; srv.notice = null;
          const v = view();
          if (srv.afterSave) srv.afterSave();
          return v;
        }
        return srv.gate ? srv.gate(view()) : view();
      }
      if (url === "/api/trades/my-pool") {
        const v = view();
        return { actFrom: v.current, data: srv.storeId ? [fatStack(5, { name: "Store Card", price: 3 })] : [],
          personalCards: srv.storeId ? null : 0, canChooseStore: true, stores: [PC], notice: srv.notice };
      }
      return {};
    }
  });
  Object.defineProperty(pg.G, "me", { value: { id: "me", orgId: "org1" } });
  return { pg, srv };
}
const saves = pg => pg.net.filter(r => r.url === "/api/sharing/act-from" && r.method === "POST");

test("a switch made in the composer opened from Social updates Social, and switching back to personal saves (#147 review)", async () => {
  const { pg, srv } = statefulSocial();
  const offerBtn = { dataset: { useStore: "s1" } };
  pg.$("tcMyNote").querySelectorAll = sel => (sel === "[data-use-store]" ? [offerBtn] : []);
  await pg.boot();
  assert.match(pg.$("actFromHint").textContent, /see your personal cards/);
  assert.match(pg.$("actFromOffer").innerHTML, /Use Personal Collection/);

  // Social -> + New proposal -> Use Personal Collection -> confirm.
  await pg.$("btnNewProposal").fire("click");
  await settle();
  await offerBtn.onclick();
  await settle();
  assert.equal(srv.storeId, "s1", "the server now shares the store");
  assert.equal(pg.ui.confirms.length, 1, "through the who-will-see-it confirmation");

  // Composer closed: Social shows what friends now see.
  assert.match(pg.$("actFromHint").textContent, /see Personal Collection \(Org\)'s inventory/);
  assert.equal(pg.$("actFrom").value, "s1");
  assert.equal(pg.$("actFromOffer").innerHTML, "", "no stale offer");

  // Back to personal from the picker: one save, and the server is personal again.
  const before = saves(pg).length;
  pg.$("actFrom").value = "";
  await pg.$("actFrom").fire("change");
  await settle();
  assert.equal(saves(pg).length - before, 1);
  assert.deepEqual(saves(pg).pop().body, { storeId: null });
  assert.equal(srv.storeId, null);
  assert.match(pg.$("actFromHint").textContent, /see your personal cards/);
  assert.equal(pg.$("actFrom").value, "");
});

test("the picker compares against the server, not the page's last drawing (#147 review)", async () => {
  const { pg, srv } = statefulSocial();
  await pg.boot();
  srv.storeId = "s1";                      // changed elsewhere (another tab), nothing announced here
  pg.$("actFrom").value = "";
  await pg.$("actFrom").fire("change");
  await settle();
  assert.deepEqual(saves(pg).map(r => r.body), [{ storeId: null }], "saved, not skipped as 'already personal'");
  assert.equal(srv.storeId, null);
});

test("Social tells the person why their store choice was cleared, even outside an org, until Got it (#147)", async () => {
  const pg = actFromSocial({ inOrg: false, canChooseStore: false, stores: [], personalCards: null,
    notice: "You're no longer in Shop's organization, so you're sharing and trading from your personal cards again." });
  await pg.boot();
  assert.equal(pg.$("actFromNotice").hidden, false);
  assert.match(pg.$("actFromNotice").innerHTML, /no longer in Shop's organization/);
  assert.equal(pg.$("actFromArea").hidden, true);
  await pg.$("actFromNoticeOk").fire("click");
  assert.equal(pg.$("actFromNotice").hidden, true);
  assert.equal(pg.net.filter(r => r.url === "/api/sharing/act-from/dismiss").length, 1);
});

/* #151: the picker after a failed switch, and a Social tab gone stale. */
// A real <select>: picking the option that is already selected fires no
// change event, and a disabled one can't be picked at all.
async function browserPick(pg, value) {
  const sel = pg.$("actFrom");
  if (sel.disabled || sel.value === value) return false;
  sel.value = value;
  await sel.fire("change");
  return true;
}
const REFRESH_WAIT = 320;   // past Social's 250 ms debounce
const actFromGets = pg => pg.net.filter(r => r.url === "/api/sharing/act-from" && r.method === "GET").length;

test("a switch that fails because the server can't be reached puts the picker back, enabled (#151)", async () => {
  const { pg, srv } = statefulSocial();
  await pg.boot();
  // The server goes away while the who-will-see-it box is open.
  pg.ui.confirmDialog = async msg => { pg.ui.confirms.push(msg); srv.offline = true; return true; };
  await browserPick(pg, "s1");
  await settle();
  assert.equal(pg.ui.confirms.length, 1);
  assert.equal(srv.storeId, null, "nothing was saved");
  assert.equal(pg.$("actFrom").value, "", "not left showing the store that was never saved");
  assert.equal(pg.$("actFrom").disabled, false, "not left disabled");
  assert.ok(pg.ui.statuses.includes("Failed to fetch"), "the failure is said");
  assert.match(pg.$("actFromHint").textContent, /see your personal cards/);

  // Back online: the same pick now works without a reload.
  srv.offline = false;
  pg.ui.confirmDialog = async msg => { pg.ui.confirms.push(msg); return true; };
  assert.equal(await browserPick(pg, "s1"), true);
  await settle();
  assert.equal(srv.storeId, "s1");
  assert.equal(pg.$("actFrom").value, "s1");
});

test("a switch that saved but couldn't redraw shows the saved store, enabled (#151)", async () => {
  const { pg, srv } = statefulSocial();
  await pg.boot();
  srv.afterSave = () => { srv.offline = true; };   // the reload after the save fails
  await browserPick(pg, "s1");
  await settle();
  assert.equal(srv.storeId, "s1");
  assert.equal(pg.$("actFrom").value, "s1");
  assert.equal(pg.$("actFrom").disabled, false);
});

test("a stale Social tab redraws when it comes back into view, so re-picking My personal cards saves (#151)", async () => {
  const { pg, srv } = statefulSocial();
  await pg.boot();
  srv.storeId = "s1";                      // switched in another tab; this one still shows personal
  // The bug: the option is already selected, so the browser fires nothing.
  assert.equal(await browserPick(pg, ""), false);
  assert.equal(saves(pg).length, 0);

  await pg.fireDocument("visibilitychange", "visible");
  await settle(REFRESH_WAIT);
  assert.equal(pg.$("actFrom").value, "s1", "the picker shows what the server has");
  assert.match(pg.$("actFromHint").textContent, /see Personal Collection \(Org\)'s inventory/);
  assert.equal(pg.$("actFromOffer").innerHTML, "", "no stale empty-personal offer");
  assert.equal(saves(pg).length, 0, "a refresh never saves");
  assert.equal(pg.ui.confirms.length, 0);

  assert.equal(await browserPick(pg, ""), true);
  await settle();
  assert.deepEqual(saves(pg).map(r => r.body), [{ storeId: null }]);
  assert.equal(srv.storeId, null);
  assert.match(pg.$("actFromHint").textContent, /see your personal cards/);
});

test("window focus refreshes too; focus and visibilitychange together cost one request; a hidden tab none (#151)", async () => {
  const { pg, srv } = statefulSocial();
  await pg.boot();
  const booted = actFromGets(pg);
  await pg.fireDocument("visibilitychange", "hidden");
  await settle(REFRESH_WAIT);
  assert.equal(actFromGets(pg), booted, "going out of view asks nothing");

  srv.storeId = "s1";
  await pg.fireDocument("visibilitychange", "visible");
  await pg.fireWindow("focus");
  await settle(REFRESH_WAIT);
  assert.equal(actFromGets(pg), booted + 1, "debounced into one");
  assert.equal(pg.$("actFrom").value, "s1");

  srv.storeId = null;
  await pg.fireWindow("focus");
  await settle(REFRESH_WAIT);
  assert.equal(pg.$("actFrom").value, "");
  assert.equal(saves(pg).length, 0);
});

test("opening the trade composer from a stale Social tab redraws Social's picker (#151)", async () => {
  const { pg, srv } = statefulSocial();
  await pg.boot();
  srv.storeId = "s1";                      // switched elsewhere
  await pg.$("btnNewProposal").fire("click");
  await settle();
  assert.equal(pg.$("actFrom").value, "s1");
  assert.match(pg.$("actFromHint").textContent, /see Personal Collection \(Org\)'s inventory/);
  assert.equal(await browserPick(pg, ""), true);
  await settle();
  assert.deepEqual(saves(pg).map(r => r.body), [{ storeId: null }]);
  assert.equal(srv.storeId, null);
});

test("an older refresh answering last never draws over a newer one (#151)", async () => {
  const { pg, srv } = statefulSocial();
  await pg.boot();
  const held = [];
  srv.gate = v => { const d = deferred(); held.push({ d, v }); return d.promise; };
  await pg.fireWindow("focus");              // asks while the server is on personal
  await settle(REFRESH_WAIT);
  srv.storeId = "s1";
  await pg.$("btnNewProposal").fire("click"); // asks again, now on the store
  await settle();
  assert.equal(held.length, 2);
  held[1].d.resolve(held[1].v);
  await settle();
  held[0].d.resolve(held[0].v);
  await settle();
  assert.equal(pg.$("actFrom").value, "s1", "the stale personal answer is dropped");
  assert.match(pg.$("actFromHint").textContent, /see Personal Collection \(Org\)'s inventory/);
});

test("a refresh while the page's own switch waits on its confirmation leaves the picker alone (#151)", async () => {
  const { pg } = statefulSocial();
  await pg.boot();
  let during = null;
  pg.ui.confirmDialog = async msg => {
    pg.ui.confirms.push(msg);
    const gets = actFromGets(pg);
    await pg.fireWindow("focus");
    await settle(REFRESH_WAIT);
    during = { gets: actFromGets(pg) - gets, value: pg.$("actFrom").value, disabled: pg.$("actFrom").disabled };
    return false;
  };
  await browserPick(pg, "s1");
  await settle();
  assert.deepEqual(during, { gets: 0, value: "s1", disabled: true });
  assert.equal(pg.$("actFrom").value, "", "cancelled: back to personal");
  assert.equal(pg.$("actFrom").disabled, false);
  assert.equal(saves(pg).length, 0);
});
