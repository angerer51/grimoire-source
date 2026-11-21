"use strict";
/* #244: the Dashboard gives a newcomer somewhere to go next and a returning
   user a reason to look. Through the real public/index.page.js with the
   page-shim's stand-in DOM (not a browser):
   - the first visit of a new account says "Welcome", later ones "Welcome back";
   - once a card is in, a "Next steps" list stays until done or hidden, and
     hiding it is per person (an org member's own prefs, not the Store's);
   - a return visit shows how card prices moved the collection since then;
   - a new account's menu buckets start open, nobody else's change. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const DAY = 86400000;
const HOUR = 3600000;

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    dump: () => Object.fromEntries(m)
  };
}

const card = i => ({ id: "c" + i, name: "Card " + i, set: "lea", collector: String(i), quantity: 1, locationId: "l1", typeLine: "Instant" });

async function open(opts) {
  const o = opts || {};
  const user = Object.assign({ id: "u1", username: "u", createdAt: "2026-01-01T00:00:00Z", email: "",
    orgId: o.org ? "o1" : null, orgRole: o.org ? "staff" : null }, o.user || {});
  const state = {
    cards: o.cards || [card(1)],
    locations: [{ id: "l1", name: "Box", type: "box" }],
    watchList: o.watchList || [],
    settings: Object.assign({}, o.settings || {})
  };
  const routes = (url, init) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/auth/me") return { user, personalPrefs: o.org ? (o.personalPrefs || {}) : null };
    if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state, owner: o.org ? "store:st1" : "u1" };
    if (url.startsWith("/api/prices/portfolio")) return o.portfolio ? o.portfolio(url) : { points: [] };
    if (url === "/api/tickets") return { tickets: [] };
    if (url.startsWith("/api/audit?")) return { entries: [], total: null };
    return {};
  };
  const page = loadPage("index.page.js", { routes });
  page.sandbox.localStorage = o.storage || memStorage();
  await page.G.load();
  await page.boot();
  await settle(10);
  return page;
}

const KEY = "grimoireLastVisit:u1:u1";

test("#244: a new account's first visit says Welcome; an older account says Welcome back", async () => {
  const fresh = await open({ user: { createdAt: new Date(Date.now() - HOUR).toISOString() } });
  assert.equal(fresh.$("hello").textContent, "Welcome, u");
  const old = await open({});
  assert.equal(old.$("hello").textContent, "Welcome back, u", "a new device for an established account");
});

test("#244: a new account coming back after a gap gets Welcome back", async () => {
  const storage = memStorage({ [KEY]: JSON.stringify({ seenAt: Date.now() - 5 * HOUR }) });
  const page = await open({ storage, user: { createdAt: new Date(Date.now() - 6 * HOUR).toISOString() } });
  assert.equal(page.$("hello").textContent, "Welcome back, u");
  // Reloading a minute later within the same visit: no new "previous visit".
  const again = await open({ storage, user: { createdAt: new Date(Date.now() - 6 * HOUR).toISOString() } });
  assert.equal(again.$("hello").textContent, "Welcome back, u");
  const rec = JSON.parse(storage.dump()[KEY]);
  assert.ok(Date.now() - rec.prevAt >= 5 * HOUR - 1000, "the previous visit is still the one 5 hours ago");
});

test("#244: after the first card, Next steps stays on the page and links each step", async () => {
  const page = await open({});
  const html = page.$("alerts").innerHTML;
  assert.equal(page.$("secThingsToDo").hidden, false);
  assert.match(html, /Next steps <span class="faint">0 of 3 done/);
  assert.match(html, /href="\/receive\.html\?mode=import"/);
  assert.match(html, /href="\/buy-list\.html"/);
  assert.match(html, /href="\/settings\.html#acctEmail"/);
  assert.match(html, /<div class="feed steps">/);
});

test("#244: no Next steps before the first card (the existing first-run callouts cover that)", async () => {
  const page = await open({ cards: [], settings: { tutorialSeen: true } });
  assert.doesNotMatch(page.$("alerts").innerHTML, /Next steps/);
  assert.match(page.$("alerts").innerHTML, /Nothing in inventory yet/);
});

test("#244: steps tick off; the list goes when all are done", async () => {
  const some = await open({ watchList: [{ set: "lea", collector: "1", lang: "en", finish: "nonfoil", name: "X" }] });
  assert.match(some.$("alerts").innerHTML, /1 of 3 done/);
  assert.match(some.$("alerts").innerHTML, /<div class="feed-row done">/);
  const all = await open({
    cards: Array.from({ length: 10 }, (_, i) => card(i + 1)),
    watchList: [{ set: "lea", collector: "1", lang: "en", finish: "nonfoil", name: "X" }],
    user: { email: "me@example.com" }
  });
  assert.doesNotMatch(all.$("alerts").innerHTML, /Next steps/);
});

test("#244: Hide these keeps it hidden - in the document for a personal account", async () => {
  const page = await open({});
  await page.$("dismissNextSteps").fire("click");
  assert.doesNotMatch(page.$("alerts").innerHTML, /Next steps/);
  assert.equal(page.G.state.settings.nextStepsDismissed, true);
  const later = await open({ settings: { nextStepsDismissed: true } });
  assert.doesNotMatch(later.$("alerts").innerHTML, /Next steps/);
});

test("#244: an org member's Hide these goes to their own prefs, not the Store's document", async () => {
  const page = await open({ org: true });
  assert.match(page.$("alerts").innerHTML, /Next steps/);
  await page.$("dismissNextSteps").fire("click");
  await settle(5);
  assert.doesNotMatch(page.$("alerts").innerHTML, /Next steps/);
  assert.equal(page.G.state.settings.nextStepsDismissed, undefined, "the Store's shared settings are untouched");
  const sent = page.net.find(r => r.url === "/api/prefs/personal" && r.body && r.body.nextStepsDismissed === true);
  assert.ok(sent, "saved to the person's own account");
  const coworker = await open({ org: true, settings: {} });
  assert.match(coworker.$("alerts").innerHTML, /Next steps/, "a coworker still sees theirs");
  const sameLater = await open({ org: true, personalPrefs: { nextStepsDismissed: true } });
  assert.doesNotMatch(sameLater.$("alerts").innerHTML, /Next steps/);
});

const points = (...pairs) => ({ points: pairs.map(([date, value, pricedCards]) => ({ date, value, pricedCards: pricedCards == null ? 5 : pricedCards, totalCards: 5 })) });
const dayStr = ms => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

test("#244: a return visit shows how prices moved the collection, and caches the figure", async () => {
  const prevAt = Date.now() - 3 * DAY;
  const storage = memStorage({ [KEY]: JSON.stringify({ seenAt: prevAt }) });
  let asked = 0;
  const portfolio = url => {
    asked++;
    assert.match(url, /days=7$/, "the smallest Movers window that reaches the last visit, not 90 days");
    return points([dayStr(Date.now() - 4 * DAY), 90], [dayStr(prevAt), 100], [dayStr(Date.now()), 112.5]);
  };
  const page = await open({ storage, portfolio });
  const box = page.$("sinceLast");
  assert.equal(box.hidden, false);
  assert.match(box.innerHTML, /up \$12\.50<\/b> \(\+12\.5%\) since your last visit \(3 days ago\)/);
  assert.match(box.innerHTML, /href="\/movers\.html"/);
  assert.equal(box.className, "since-last up");
  // A reload in the same visit reuses the figure instead of asking again.
  const again = await open({ storage, portfolio });
  assert.equal(asked, 1);
  assert.match(again.$("sinceLast").innerHTML, /up \$12\.50/);
});

test("#244: no line on a first visit, or when no snapshot has landed since the last one", async () => {
  // The stand-in element starts visible and empty; the page only ever fills
  // and un-hides it, so "empty" is "no line".
  let asked = 0;
  const first = await open({ portfolio: () => { asked++; return points(); } });
  assert.equal(first.$("sinceLast").innerHTML, "");
  assert.equal(asked, 0, "a first visit doesn't even ask");
  // Five hours ago, and the only snapshot is today's: nothing to compare.
  const prevAt = Date.now() - 5 * HOUR;
  const storage = memStorage({ [KEY]: JSON.stringify({ seenAt: prevAt }) });
  const sameDay = await open({ storage, portfolio: () => points([dayStr(Date.now()), 100]) });
  assert.equal(sameDay.$("sinceLast").innerHTML, "");
});

test("#244: no line when a card had no price on one of the two days (not price movement)", async () => {
  const prevAt = Date.now() - 3 * DAY;
  const storage = memStorage({ [KEY]: JSON.stringify({ seenAt: prevAt }) });
  const page = await open({ storage, portfolio: () => points([dayStr(prevAt), 100, 4], [dayStr(Date.now()), 140, 5]) });
  assert.equal(page.$("sinceLast").innerHTML, "");
});

test("#244: the look-back rounds up to the Movers windows (30, then 90)", async () => {
  const seen = [];
  for (const d of [12, 45]) {
    const storage = memStorage({ [KEY]: JSON.stringify({ seenAt: Date.now() - d * DAY }) });
    await open({ storage, portfolio: url => { seen.push(url.match(/days=(\d+)/)[1]); return points(); } });
  }
  assert.deepEqual(seen, ["30", "90"]);
});

test("#244: a fall says down, with its own arrow; Simple mode gets no Movers link", async () => {
  const prevAt = Date.now() - 2 * DAY;
  const storage = memStorage({ [KEY]: JSON.stringify({ seenAt: prevAt }) });
  const page = await open({ storage, settings: { simpleMode: true },
    portfolio: () => points([dayStr(prevAt), 200], [dayStr(Date.now()), 150]) });
  const box = page.$("sinceLast");
  assert.match(box.innerHTML, /down \$50\.00<\/b> \(-25\.0%\)/);
  assert.equal(box.className, "since-last down");
  assert.doesNotMatch(box.innerHTML, /movers/);
});

/* The sidebar, through the real ui.js. The shim's querySelectorAll finds
   nothing, so the test hands the nav its buckets. */
function navGroups() {
  return ["whNavWrap", "stockNavWrap"].map(id => {
    const cls = new Set(["collapsed"]);
    const label = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    return { id, classList: { remove: c => cls.delete(c), add: c => cls.add(c), contains: c => cls.has(c) },
      querySelector: () => label, label, isCollapsed: () => cls.has("collapsed") };
  });
}
async function openChrome(createdAt, storage) {
  const routes = url => {
    if (url === "/api/auth/me") return { user: { id: "u1", username: "u", createdAt }, personalPrefs: null };
    if (url === "/api/collection") return { rev: 1, savedAt: null, state: { cards: [], locations: [], settings: { tutorialSeen: true } }, owner: "u1" };
    return {};
  };
  const page = loadPage(null, { routes, realUI: true });
  page.sandbox.localStorage = storage;
  const groups = navGroups();
  page.$("appNav").querySelectorAll = sel => (sel === ".nav-group" ? groups : []);
  await page.boot();
  await settle(10);
  return { page, groups };
}

test("#244: a new account's menu buckets start open and are saved as pinned", async () => {
  const storage = memStorage();
  const { groups } = await openChrome(new Date().toISOString(), storage);
  assert.deepEqual(groups.map(g => g.isCollapsed()), [false, false]);
  assert.equal(groups[0].label.attrs["aria-expanded"], "true");
  assert.deepEqual(JSON.parse(storage.dump().grimoireNavPinned), ["whNavWrap", "stockNavWrap"]);
});

test("#244: an existing account's menu, or one with saved pin state, is left alone", async () => {
  const old = memStorage();
  const a = await openChrome("2026-03-01T00:00:00Z", old);
  assert.deepEqual(a.groups.map(g => g.isCollapsed()), [true, true]);
  assert.equal(old.dump().grimoireNavPinned, undefined, "nothing written");
  const chose = memStorage({ grimoireNavPinned: "[]" });
  const b = await openChrome(new Date().toISOString(), chose);
  assert.deepEqual(b.groups.map(g => g.isCollapsed()), [true, true], "a new account that already closed them keeps them closed");
  assert.equal(chose.dump().grimoireNavPinned, "[]");
});
