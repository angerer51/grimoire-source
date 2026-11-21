"use strict";
/* The tutorial's Finish / Skip through its real script
   (public/tutorial.page.js) with the page-shim's stand-in DOM. Not a browser.
   #176: it saved with G.saveNow(), which never rejects, so a failed save
   still left for the Dashboard (where the browser's generic "Leave site?"
   prompt appeared instead of the page's own message). Now it waits for
   G.saveAll() and stays put, with its own message, when that fails.
   #179: replaying the tour leaves the account's mode alone unless an answer
   is picked; an organization member gets no mode question and the tour
   writes nothing to the Store's document; step 5 says what is true of the
   real collection; the logo is the current one. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, settle } = require("../test-lib/page-shim");

const PUT_OK = () => ({ rev: 2, savedAt: "2026-10-10T00:00:00Z" });
const BOLT = { name: "Lightning Bolt", set: "lea", collector: "161", lang: "en", prices: { usd: "1.00" }, imageUrl: "" };

// o.state: the collection; o.org: an organization member of "Main Street".
async function open(putAnswer, o) {
  o = o || {};
  const ac = {};
  const page = loadPage("tutorial.page.js", {
    routes: (url, init) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/auth/me") {
        return { user: { id: "u1", username: "u", orgId: o.org ? "o1" : null, orgRole: o.org ? "staff" : null },
          personalPrefs: o.org ? { simpleMode: false } : null };
      }
      if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state: o.state || null, owner: o.org ? "store:st1" : "u1" };
      if (url === "/api/collection" && method === "PUT") return putAnswer();
      if (url === "/api/orgs/mine") return { stores: [{ id: "st1", name: "Main Street" }], activeStoreId: "st1" };
      if (url.startsWith("/api/cards/printings")) return { data: o.printings || [BOLT] };
      return {};
    }
  });
  // The page boots itself; these are read once G.load() has answered.
  page.ui.Autocomplete = (id, list, pick) => { ac.pick = pick; };
  page.ui.CardPanel = () => ({ showCard() {}, message() {}, clear() {} });
  page.ui.icon = name => "[icon " + name + "]";
  page.ac = ac;
  page.sandbox.location.href = "/tutorial.html";
  await settle(10);                  // the page boots itself (G.load)
  return page;
}
const puts = page => page.net.filter(r => r.url === "/api/collection" && r.method === "PUT");
const prefPosts = page => page.net.filter(r => r.url === "/api/prefs/personal");
const REPLAY = (simpleMode) => ({ cards: [{ id: "c1", name: "Bolt", set: "lea", collector: "161", quantity: 1, locationId: "l1" }],
  locations: [{ id: "l1", name: "Box" }], settings: { tutorialSeen: true, simpleMode } });

async function addDemoCard(page) {
  await page.ac.pick("Lightning Bolt");
  page.$("tutPrinting").value = "0";
  page.$("tutPrinting").onchange();
  page.$("tutAddBtn").onclick();
}

test("#176: Skip with a save that fails stays on the tutorial and says so", async () => {
  const page = await open(() => ({ __status: 500, error: "disk full" }));
  await page.$("tutSkip").onclick();
  await settle(50);
  assert.equal(page.sandbox.location.href, "/tutorial.html", "didn't leave with the choice unsaved");
  assert.match(page.$("tutMsg").textContent, /Couldn't save your choice \(disk full\)/);
  assert.equal(page.$("tutSkip").disabled, false, "Skip works again for a retry");
  assert.equal(page.$("tutNext").disabled, false);
});

test("#176: Skip saves the choice, then opens the Dashboard", async () => {
  const page = await open(PUT_OK);
  await page.$("tutSkip").onclick();
  await settle(50);
  const put = puts(page)[0];
  assert.ok(put, "saved");
  assert.equal(put.body.state.settings.tutorialSeen, true);
  assert.equal(put.body.state.settings.simpleMode, true, "Skip on a new account's first run means Simple mode");
  assert.equal(page.sandbox.location.href, "/index.html");
});

test("#179: replaying the tour and pressing Skip leaves a full-mode account in full mode", async () => {
  const page = await open(PUT_OK, { state: REPLAY(false) });
  assert.match(page.$("step1Hint").textContent, /You're in full mode now.*Skip leaves it as it is/);
  await page.$("tutSkip").onclick();
  await settle(50);
  assert.equal(puts(page).length, 0, "nothing to save");
  assert.equal(page.G.simpleMode, false);
  assert.equal(page.sandbox.location.href, "/index.html");
});

test("#179: an account that predates the tour (has cards) isn't put in Simple mode by Skip", async () => {
  const state = REPLAY(false);
  state.settings.tutorialSeen = false;
  const page = await open(PUT_OK, { state });
  await page.$("tutSkip").onclick();
  await settle(50);
  const put = puts(page)[0];
  assert.ok(put, "marks the tour seen");
  assert.equal(put.body.state.settings.tutorialSeen, true);
  assert.equal(put.body.state.settings.simpleMode, false);
});

test("#179: on a replay, an answer picked on step 1 is applied", async () => {
  const page = await open(PUT_OK, { state: REPLAY(false) });
  await page.$("choiceSimple").onclick();
  assert.equal(page.$("step2").hidden, false);
  await page.$("tutSkip").onclick();
  await settle(50);
  assert.equal(puts(page)[0].body.state.settings.simpleMode, true);
});

test("#179: step 5 says the real collection wasn't touched when it has cards", async () => {
  const page = await open(PUT_OK, { state: REPLAY(true) });
  await page.$("choiceBusiness").onclick();
  await addDemoCard(page);
  assert.match(page.$("tutDemoBody").innerHTML, /<tr class="click" tabindex="0" data-id="demo1">/, "the row is keyboard-reachable");
  for (let i = 0; i < 3; i++) await page.$("tutNext").onclick();
  assert.equal(page.$("step5").hidden, false);
  const s = page.$("tutSummary").textContent;
  assert.match(s, /You added 1 card to this demo\. Your real collection wasn't touched\. Starting in full mode\./);
  assert.doesNotMatch(s, /still empty/);
});

test("#179: step 5 on a new, empty account keeps the 'still empty' line", async () => {
  const page = await open(PUT_OK);
  await page.$("choiceSimple").onclick();
  await addDemoCard(page);
  for (let i = 0; i < 3; i++) await page.$("tutNext").onclick();
  assert.match(page.$("tutSummary").textContent, /still empty and ready for the real thing\. Starting in Simple mode/);
});

test("#179: a store member skips the mode question, and the tour writes nothing", async () => {
  const page = await open(PUT_OK, { org: true, state: { cards: [{ id: "c1", name: "Bolt", set: "lea", collector: "161", quantity: 1, locationId: "l1" }],
    locations: [{ id: "l1", name: "Box" }], settings: {} } });
  assert.equal(page.$("step1").hidden, true, "no 'how will you use Grimoire' question");
  assert.equal(page.$("step2").hidden, false);
  assert.equal(page.$("tutBack").hidden, true, "no Back to the skipped step");
  await addDemoCard(page);
  for (let i = 0; i < 3; i++) await page.$("tutNext").onclick();
  assert.match(page.$("tutSummary").textContent, /Nothing in this tour touched Main Street's inventory\./);
  assert.doesNotMatch(page.$("tutSummary").textContent, /Simple mode|full mode/);
  await page.$("tutNext").onclick();   // Enter Grimoire
  await settle(50);
  assert.equal(puts(page).length, 0, "the Store's document isn't saved");
  assert.equal(prefPosts(page).filter(r => r.body && "simpleMode" in r.body && !r.body.onlyIfUnset).length, 0, "Simple mode untouched");
  assert.equal(page.G.state.settings.tutorialSeen, false, "not marked seen for every coworker");
  assert.equal(page.sandbox.location.href, "/index.html");
});

test("#179: the tour's logo is the current graphite and orange mark", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "tutorial.html"), "utf8");
  assert.doesNotMatch(html, /#302a58|#e0a82e|#efe9d9/i, "no pre-restyle purple and gold");
  assert.match(html, /fill="#1d1e21" stroke="#f26b1d"/);
  assert.match(html, /press <b>Mark listed<\/b>/);
});

/* #239: the tour creates the account's first location. */
const locNames = page => Array.from(page.G.state.locations, l => l.name);

async function toLastStep(page) {
  await page.$("choiceSimple").onclick();
  await addDemoCard(page);
  for (let i = 0; i < 3; i++) await page.$("tutNext").onclick();
}

test("#239: finishing with a binder name creates exactly that location and opens Receive", async () => {
  const page = await open(PUT_OK);
  await toLastStep(page);
  assert.equal(page.$("tutBinder").hidden, false, "binder step shown");
  assert.match(fs.readFileSync(path.join(__dirname, "..", "public", "tutorial.html"), "utf8"),
    /id="tutBinderName" placeholder="My Binder"/, "suggests My Binder as a placeholder");
  page.$("tutBinderName").value = "  Trade Stuff ";
  await page.$("tutNext").onclick();
  await settle(50);
  assert.deepEqual(locNames(page), ["Trade Stuff"]);
  assert.equal(page.G.state.locations[0].type, "Binder");
  assert.equal(puts(page)[0].body.state.locations.length, 1, "in the guaranteed save");
  assert.equal(page.sandbox.location.href, "/receive.html");
});

test("#239: finishing with the name blank creates 'My Collection' only", async () => {
  const page = await open(PUT_OK);
  await toLastStep(page);
  page.$("tutBinderName").value = "   ";
  await page.$("tutNext").onclick();
  await settle(50);
  assert.deepEqual(locNames(page), ["My Collection"]);
});

test("#239: Skip creates 'My Collection' and never a second location", async () => {
  const page = await open(PUT_OK);
  await page.$("tutSkip").onclick();
  await settle(50);
  assert.deepEqual(locNames(page), ["My Collection"]);
  assert.equal(puts(page)[0].body.state.locations.length, 1);
  assert.equal(page.sandbox.location.href, "/index.html");
});

test("#239: a failed save then a retry doesn't duplicate the location", async () => {
  let fail = true;
  const page = await open(() => fail ? { __status: 500, error: "down" } : PUT_OK());
  await page.$("tutSkip").onclick();
  await settle(50);
  fail = false;
  await page.$("tutSkip").onclick();
  await settle(50);
  assert.deepEqual(locNames(page), ["My Collection"]);
});

test("#239: a replay with locations, or a store member, creates nothing", async () => {
  const page = await open(PUT_OK, { state: REPLAY(false) });
  await toLastStep(page);
  assert.equal(page.$("tutBinder").hidden, true);
  await page.$("tutNext").onclick();
  await settle(50);
  assert.deepEqual(locNames(page), ["Box"]);
  const org = await open(PUT_OK, { org: true, state: { cards: [], locations: [], settings: {} } });
  await org.$("tutSkip").onclick();
  await settle(50);
  assert.deepEqual(locNames(org), []);
});

test("#236: the tour's printing list starts on a placeholder and Add waits for a pick", async () => {
  const page = await open(() => PUT_OK());
  await page.ac.pick("Lightning Bolt");
  assert.equal(page.$("tutPrinting").value, "");
  assert.match(page.$("tutPrinting").innerHTML, /Choose a printing…/);
  assert.equal(page.$("tutAddBtn").disabled, true);
  page.$("tutAddBtn").onclick();
  page.$("tutPrinting").value = "0";
  page.$("tutPrinting").onchange();
  assert.equal(page.$("tutAddBtn").disabled, false);
});

test("#236: the tour's list offers the English copy of each printing, not the first language found", async () => {
  const printings = [
    { name: "Lightning Bolt", set: "m11", setName: "Magic 2011", collector: "149", lang: "zhs", usd: null },
    { name: "Lightning Bolt", set: "m11", setName: "Magic 2011", collector: "149", lang: "en", usd: 1.25 },
    { name: "Lightning Bolt", set: "lea", setName: "Limited Edition Alpha", collector: "161", lang: "en", usd: 900 }
  ];
  const page = await open(() => PUT_OK(), { printings });
  await page.ac.pick("Lightning Bolt");
  const sel = page.$("tutPrinting");
  assert.equal(sel.innerHTML.split("<option").length - 1, 3, "placeholder + one option per printing");
  assert.ok(sel.innerHTML.includes("Magic 2011 · $1.25"), "the English copy, with its price");
  sel.value = "0"; sel.onchange();
  await page.$("tutAddBtn").onclick();
  assert.equal(page.$("tutAddBtn").hidden, true);
});
