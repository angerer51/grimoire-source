"use strict";
/* The Dashboard through its real script (public/index.page.js) with the
   page-shim's stand-in DOM. Not a browser.
   #177: "Awaiting your reply" counts only tickets someone else answered
   last; Simple mode isn't nagged
   about Putaway or Cycle Count, which it hides; the Simple-mode nudge never
   shows to an organization member (its flags are the Store's, shared);
   the toolbar is plain
   buttons that leave through UI.go. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, settle } = require("../test-lib/page-shim");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

const ME = (o) => ({
  user: { id: "u1", username: "u", createdAt: "2026-01-01", orgId: o.org ? "o1" : null, orgRole: o.org ? "staff" : null },
  personalPrefs: o.org ? { simpleMode: !!o.simple } : null
});
const STATE = (o) => ({
  cards: [{ id: "c1", name: "Lightning Bolt", set: "lea", collector: "161", quantity: 2, locationId: "l1", typeLine: "Instant" }],
  locations: o.locations || [{ id: "l1", name: "Box", type: "box" }],   // no putaway, never counted
  settings: Object.assign({ simpleMode: !!o.simple }, o.settings || {})
});

async function open(opts) {
  const o = opts || {};
  const routes = (url, init) => {
    const method = (init && init.method) || "GET";
    const x = o.extraRoutes && o.extraRoutes(url); if (x !== undefined) return x;
    if (url === "/api/auth/me") return ME(o);
    if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state: STATE(o), owner: o.org ? "store:st1" : "u1" };
    if (url === "/api/tickets") return { tickets: o.tickets || [] };
    if (url.startsWith("/api/audit?")) return o.audit ? o.audit() : { entries: [], total: null };
    return {};
  };
  const page = loadPage("index.page.js", { routes });
  page.went = [];
  page.ui.go = url => { page.went.push(url); return Promise.resolve(true); };
  await page.G.load();
  await page.boot();
  await settle(10);
  return page;
}

const msg = (from, at) => ({ from, fromRole: from === "u1" ? "user" : "moderator", body: "x", at });

test("#177: a ticket you just filed isn't 'Awaiting your reply'", async () => {
  const page = await open({ tickets: [
    { id: "t1", status: "open", messages: [msg("u1", "2026-10-10T00:00:00Z")] }
  ] });
  const tiles = page.$("tiles").innerHTML;
  assert.doesNotMatch(tiles, /Awaiting your reply/);
  assert.match(tiles, /Open tickets/, "a quiet count of the ones waiting on staff");
  assert.match(tiles, /waiting on the support team/);
  assert.doesNotMatch(tiles, /class="tile gold"><a href="\/help\.html#support"/, "not orange");
});

test("#177: a staff reply makes it yours to answer; your own reply hands it back", async () => {
  const page = await open({ tickets: [
    { id: "t1", status: "in-progress", messages: [msg("u1", "1"), msg("m1", "2")] },
    { id: "t2", status: "open", messages: [msg("u1", "1"), msg("m1", "2"), msg("u1", "3")] },
    { id: "t3", status: "resolved", messages: [msg("u1", "1"), msg("m1", "2")] }
  ] });
  const tiles = page.$("tiles").innerHTML;
  assert.match(tiles, /<span class="big ">1<\/span><span class="lbl">Awaiting your reply/);
  assert.match(tiles, /1 support ticket; 1 more waiting on the support team/);
});

test("#177: the toolbar is buttons, not buttons in links", async () => {
  assert.doesNotMatch(HTML, /<a [^>]*>\s*<button/, "no <button> nested in an <a>");
  assert.doesNotMatch(HTML, /＋|style="/, "no full-width plus glyph, no inline style");
  assert.match(HTML, /id="goReceive" class="gold"><svg class=ic aria-hidden=true><use href=\/icons\/sprite\.svg#plus>/);
  const page = await open({});
  await page.$("goReceive").fire("click");
  await page.$("linkPutaway").fire("click");
  await page.$("goInventory").fire("click");
  assert.deepEqual(page.went, ["/receive.html", "/putaway.html", "/inventory.html"], "each one leaves through UI.go (saves first)");
});

test("#177: full mode still gets the putaway callout and the overdue-count tile", async () => {
  const page = await open({});
  assert.match(page.$("alerts").innerHTML, /Putaway is not set up/);
  assert.match(page.$("tiles").innerHTML, /Overdue for a count/);
  assert.match(page.$("tiles").innerHTML, /in the putaway rotation/);
});

const overdueCount = page => {
  const m = page.$("tiles").innerHTML.match(/<span class="big [^"]*">([\d,]+)<\/span><span class="lbl">Overdue for a count/);
  return m && Number(m[1]);
};

test("#248: a never-counted location goes by its creation date, not 'overdue'", async () => {
  const day = 86400000;
  const fresh = await open({ locations: [
    { id: "l1", name: "New box", type: "box", createdAt: new Date(Date.now() - 5 * 60000).toISOString() }
  ] });
  assert.equal(overdueCount(fresh), 0, "made minutes ago");
  const old = await open({ locations: [
    { id: "l1", name: "Old box", type: "box", createdAt: new Date(Date.now() - 100 * day).toISOString() }
  ] });
  assert.equal(overdueCount(old), 1, "made 100 days ago and never counted");
  const legacy = await open({});
  assert.equal(overdueCount(legacy), 1, "no createdAt (pre-#248 location): still overdue, as before");
});

test("#248: createLocation stamps createdAt; loading saved data never invents one", async () => {
  const page = await open({});
  const before = Date.now();
  const l = page.G.createLocation({ name: "Shelf", type: "bin" });
  assert.ok(new Date(l.createdAt).getTime() >= before - 1000);
  assert.equal(page.G.newLocation({ name: "Old" }).createdAt, null, "normalizer leaves unknown age unknown");
  assert.equal(page.G.newLocation({ name: "Kept", createdAt: "2026-01-02T00:00:00.000Z" }).createdAt, "2026-01-02T00:00:00.000Z");
});

test("#177: Simple mode isn't told about Putaway or Cycle Count, which it hides", async () => {
  const page = await open({ simple: true });
  assert.doesNotMatch(page.$("alerts").innerHTML, /Putaway is not set up/);
  const tiles = page.$("tiles").innerHTML;
  assert.doesNotMatch(tiles, /Overdue for a count/);
  assert.doesNotMatch(tiles, /putaway/i);
  assert.match(tiles, /Locations/, "the Locations tile itself stays");
});

test("#177: Simple mode still gets 'Start with a location' (Receive needs one)", async () => {
  const routesState = { simple: true };
  const page = await open(routesState);
  page.G.state.locations.length = 0;
  page.G.state.cards.length = 0;
  page.G.emit("change", {});
  await settle(5);
  assert.match(page.$("alerts").innerHTML, /Start with a location/);
});

test("#177: the Simple-mode nudge shows on a personal account, never in a store", async () => {
  const personal = await open({});
  assert.match(personal.$("alerts").innerHTML, /Just tracking cards for yourself\?/);
  const staff = await open({ org: true });
  assert.doesNotMatch(staff.$("alerts").innerHTML, /Just tracking cards for yourself\?/);
});


test("#331: Check a price picks the card name first, then lists that card's printings with collector numbers", async () => {
  const asked = [];
  const P = (set, setName, collector, releasedAt, usd) => ({ name: "Sol Ring", set, setName, collector, releasedAt, lang: "en", usd, usdFoil: null, usdEtched: null });
  const page = await open({ extraRoutes: (url) => {
    if (url.startsWith("/api/cards/printings?")) {
      asked.push(decodeURIComponent(url.split("name=")[1]));
      return { data: [P("c21", "Commander 2021", "263", "2021-04-23", 2.5), P("ltc", "Lorwyn Eclipsed Commander", "12", "2026-01-23", 2.08),
        P("ltc", "Lorwyn Eclipsed Commander", "412", "2026-01-23", 1.94)] };
    }
  } });
  assert.equal(page.ui.autocompletes.length, 1);
  assert.equal(page.ui.autocompletes[0].input, "priceCheckSearch");
  await page.ui.autocompletes[0].onPick("Sol Ring");
  await settle(10);
  assert.deepEqual(asked, ["Sol Ring"]);
  const html = page.$("priceCheckOut").innerHTML;
  assert.match(html, /Sol Ring/);
  assert.match(html, /#12</);
  assert.match(html, /#412</, "look-alike rows are told apart by collector number");
  assert.ok(html.indexOf("Lorwyn") < html.indexOf("Commander 2021"), "newest first");
});
