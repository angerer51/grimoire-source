"use strict";
/* #455: "What's new" step cards. Through the real ui.js and core.js with the
   page-shim's stand-in DOM (not a browser):
   - on a desk page load, a person who hasn't finished a tutorial gets it and
     can only leave with Done (no X, no Esc); Done saves the id as their own
     pref (an org member's account, a personal account's document);
   - it never comes back once done, never reaches an account made after it
     shipped (a new account straight off the welcome tour), and the first
     one's audience is Manapool sellers in full mode only;
   - a replay from Help can be closed;
   - the server keeps the finished list clean and only ever adds to it. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadPage, settle } = require("../test-lib/page-shim");
const orgs = require(path.join(__dirname, "..", "server", "lib", "orgs"));

const ID = "mp-mark-shipped";
// #476: the second tutorial. The #455 tests below treat it as finished unless
// a test passes shipDue, so they keep testing one tutorial at a time.
const SHIP = "shipping-costs";
const withShip = (prefs, due, ptDue, mpcDue) => {
  const p = Object.assign({}, prefs || {});
  p.whatsNewDone = [].concat(p.whatsNewDone || [], due ? [] : [SHIP], ptDue ? [] : [PT], mpcDue ? [] : [MPC]);
  return p;
};
// #497: the third tutorial, also treated as finished here (it has its own test below).
const PT = "pricing-portfolio-tabs";
// #499: the fourth (Connect Mana Pool), finished here too unless a test passes mpcDue.
const MPC = "mp-connect";
const noPT = a => Array.from(a).filter(x => x !== PT && x !== MPC);
const OLD = "2026-01-01T00:00:00Z";

async function open(o) {
  const opts = o || {};
  const org = !!opts.org;
  const user = { id: "u1", username: "u", createdAt: opts.createdAt === undefined ? OLD : opts.createdAt,
    orgId: org ? "o1" : null, orgRole: org ? "staff" : null };
  const mp = Object.assign({ featureOn: true, hasToken: true }, opts.manapool || {});
  const page = loadPage(null, {
    realUI: true,
    routes: async url => {
      if (url === "/api/meta") return { version: "test", restart: null };
      if (url === "/api/auth/me") return { user, personalPrefs: org ? withShip(opts.personalPrefs, opts.shipDue, opts.ptDue, opts.mpcDue) : null };
      if (url === "/api/collection") {
        return { rev: 1, savedAt: null, owner: org ? "store:st1" : "u1",
          state: { cards: [{ id: "c1", name: "X", set: "s", collector: "1", quantity: 1 }], pickLists: opts.pickLists || [],
            settings: Object.assign({ tutorialSeen: true }, org ? opts.settings || {} : withShip(opts.settings, opts.shipDue, opts.ptDue, opts.mpcDue)) } };
      }
      if (url === "/api/integrations") return { manapool: mp };
      return {};
    }
  });
  page.sandbox.location.pathname = opts.path || "/index.html";
  page.sandbox.location.replace = () => {};
  await page.boot();
  await settle(10);
  const modal = page.$("whatsNewModal");
  // The stand-in makes any id on first use, so "shown" is: something was drawn into it.
  return { page, shown: !!page.$("wnTitle").textContent && !modal.hidden, modal, asked: page.net.some(r => r.url === "/api/integrations") };
}
const next = page => page.$("wnNext").onclick();

test("#455: a Manapool seller gets the step cards once, and only Done closes them", async () => {
  const { page, shown, modal } = await open({ org: true });
  assert.ok(shown, "shown on the next desk page load");
  assert.ok(modal.hasAttribute("data-must-finish"));
  assert.equal(page.$("wnClose").hidden, true, "no X the first time");
  assert.equal(page.$("wnTitle").textContent, "Mark shipped now tells Manapool");
  assert.equal(page.$("wnCount").textContent, "1 of 3");
  assert.equal(page.$("wnImg").src, "/img/whats-new-mp-ship-1.webp");
  assert.match(page.$("wnText").textContent, /Order Fulfillment, Pick list tab/);
  assert.equal(page.$("wnBack").hidden, true);
  // Esc is ignored: the owner wants it completed.
  page.dispatch("keydown", { key: "Escape" });
  assert.equal(modal.hidden, false, "Esc doesn't close a first showing");
  next(page);
  assert.equal(page.$("wnCount").textContent, "2 of 3");
  assert.match(page.$("wnText").textContent, /Tracking is optional, except on Ground Advantage orders/);
  assert.equal(page.$("wnBack").hidden, false);
  page.$("wnBack").onclick();
  assert.equal(page.$("wnCount").textContent, "1 of 3", "Back goes back a step");
  next(page); next(page);
  assert.match(page.$("wnText").textContent, /not sent to Manapool.*Retry/);
  assert.equal(page.$("wnNext").innerHTML, "Done");
  next(page);
  await settle(5);
  assert.equal(modal.hidden, true, "Done closes it");
  const sent = page.net.find(r => r.url === "/api/prefs/personal" && r.body && r.body.whatsNewDone);
  assert.deepEqual(noPT(sent.body.whatsNewDone), [SHIP, ID], "saved as the person's own pref, not the Store's");
  assert.equal(page.G.state.settings.whatsNewDone, undefined, "the Store's shared settings are untouched");
});

test("#455: a personal account keeps the finished list in its own document", async () => {
  const { page, shown } = await open({});
  assert.ok(shown);
  next(page); next(page); next(page);
  await settle(5);
  assert.deepEqual(noPT(page.G.state.settings.whatsNewDone), [SHIP, ID]);
  assert.ok(page.G.hasUnsaved(), "a save is on its way");
});

test("#455: once done it never shows again, and a later account never gets it", async () => {
  const done = await open({ org: true, personalPrefs: { whatsNewDone: [ID] } });
  assert.equal(done.shown, false);
  assert.equal(done.asked, false, "nothing due: no extra request either");
  const personalDone = await open({ settings: { whatsNewDone: ["older-one", ID] } });
  assert.equal(personalDone.shown, false);
  // 30 days' grace after the release day (owner, on #455): a slipped release still reaches everyone.
  const sameDay = await open({ createdAt: "2026-11-12T15:00:00Z" });
  assert.equal(sameDay.shown, true, "an account made the day it shipped still gets it");
  const inside = await open({ createdAt: "2026-12-11T23:00:00Z" });
  assert.equal(inside.shown, true, "29 days after: inside the window");
  const edge = await open({ createdAt: "2026-12-12T00:00:00Z" });
  assert.equal(edge.shown, true, "exactly 30 days after: still inside");
  const later = await open({ createdAt: "2026-12-12T00:00:01Z" });
  assert.equal(later.shown, false, "more than 30 days after it shipped (a new account straight off the welcome tour): not shown");
  const noDate = await open({ createdAt: null });
  assert.equal(noDate.shown, true, "an account with no creation date counts as an old one");
});

test("#455: the first tutorial is for Manapool sellers in full mode only", async () => {
  assert.equal((await open({ manapool: { featureOn: false } })).shown, false, "Manapool off for the site");
  assert.equal((await open({ manapool: { hasToken: false } })).shown, false, "no connection and no Manapool tickets");
  const teammate = await open({ org: true, manapool: { hasToken: false },
    pickLists: [{ id: "P-1", source: "manapool", orderId: "o1", status: "shipped", lines: [] }] });
  assert.equal(teammate.shown, true, "a store whose Manapool orders a teammate's connection brings in");
  assert.equal((await open({ settings: { simpleMode: true } })).shown, false, "Simple mode hides Order Fulfillment");
});

test("#455: not during the welcome tour", async () => {
  assert.equal((await open({ path: "/tutorial.html" })).shown, false);
});

test("#455: a replay from Help can be closed, and the list is newest first", async () => {
  const { page } = await open({ org: true, personalPrefs: { whatsNewDone: [ID] } });
  const list = page.sandbox.UI.whatsNew.list();
  assert.deepEqual(noPT(Array.from(list, t => t.id)), [SHIP, ID], "newest first");
  assert.ok(list.every(t => t.title && t.summary && /^\d{4}-\d\d-\d\d$/.test(t.released) && t.steps >= 2 && t.steps <= 4));
  const closed = page.sandbox.UI.whatsNew.replay(ID);
  const modal = page.$("whatsNewModal");
  assert.equal(modal.hidden, false);
  assert.equal(modal.hasAttribute("data-must-finish"), false);
  assert.equal(page.$("wnClose").hidden, false, "an X on a replay");
  page.dispatch("keydown", { key: "Escape" });
  await closed;
  assert.equal(modal.hidden, true, "Esc closes a replay");
});

test("#455: due() and clean() rules", async () => {
  const { page } = await open({ org: true, personalPrefs: { whatsNewDone: [ID] } });
  const W = page.sandbox.UI.whatsNew;
  const list = [{ id: "a", released: "2026-11-01" }, { id: "b", released: "2026-12-01" }];
  assert.deepEqual(W.due(list, [], "2026-10-01T00:00:00Z").map(t => t.id), ["a", "b"]);
  assert.deepEqual(W.due(list, ["a"], "2026-10-01T00:00:00Z").map(t => t.id), ["b"]);
  assert.deepEqual(W.due(list, [], "2026-11-05T00:00:00Z").map(t => t.id), ["a", "b"], "a few days after a shipped: still inside its 30 days");
  assert.deepEqual(W.due(list, [], "2026-12-05T00:00:00Z").map(t => t.id), ["b"], "34 days after a: only b");
  assert.deepEqual(W.due(list, "junk", undefined).map(t => t.id), ["a", "b"]);
  assert.deepEqual(Array.from(W.clean(["a", "a", "B", "<x>", 5, "x".repeat(33), "ok-1"])), ["a", "ok-1"]);
});

test("#455: the server keeps whatsNewDone clean and small", () => {
  assert.deepEqual(orgs.personalPrefsFrom({ whatsNewDone: [ID, ID, "Bad", "<b>", 7, "x".repeat(40), "two"] }),
    { whatsNewDone: [ID, "two"] });
  assert.deepEqual(orgs.personalPrefsFrom({ whatsNewDone: "mp" }), {}, "not a list: dropped");
  const many = Array.from({ length: 80 }, (_, i) => "t" + i);
  const kept = orgs.personalPrefsFrom({ whatsNewDone: many }).whatsNewDone;
  assert.equal(kept.length, 60);
  assert.equal(kept[59], "t79", "the newest are kept");
  assert.ok(JSON.stringify({ whatsNewDone: Array.from({ length: 60 }, (_, i) => "x".repeat(30) + String(i).padStart(2, "0")) }).length < 4096,
    "a full list fits the route's 4 KB body");
  assert.deepEqual(orgs.whatsNewClean([].concat(["a"], ["b", "a"])), ["a", "b"], "the route adds to what's there");
  assert.ok(orgs.lockedSettingKeys({ orgRole: "staff" }, "store:s1").includes("whatsNewDone"), "never written into a Store's document");
});

test("#455: the glossary links \"What's new tutorials\", not everyday \"what's new\"", () => {
  const Glossary = require(path.join(__dirname, "..", "public", "js", "glossary.js"));
  const matcher = Glossary.buildMatcher(Glossary.TERMS);
  const ids = text => Glossary.findMatches(text, matcher).map(m => m.term.id);
  assert.ok(!ids("collection moved, watch-list targets hit, and what's new in the app.").includes("whats-new"), "the daily digest's sentence");
  assert.ok(!ids("what I did, what moved, and what's new in Grimoire").includes("whats-new"));
  assert.ok(ids("Replay the What's new tutorials in Help.").includes("whats-new"));
});

test("#476: the Shipping tutorial plays after Mark shipped, and Done saves each", async () => {
  const { page, shown, modal } = await open({ org: true, shipDue: true });
  assert.ok(shown);
  assert.equal(page.$("wnTitle").textContent, "Mark shipped now tells Manapool", "oldest first");
  next(page); next(page); next(page);
  await settle(5);
  assert.equal(modal.hidden, false, "the next one follows");
  assert.equal(page.$("wnTitle").textContent, "Your shipping costs, in Settings");
  assert.equal(page.$("wnCount").textContent, "1 of 4");
  assert.equal(page.$("wnImg").src, "/img/whats-new-ship-1.webp");
  assert.match(page.$("wnText").textContent, /Shipping tab/);
  next(page); next(page); next(page);
  assert.match(page.$("wnText").textContent, /Try it/);
  next(page);
  await settle(5);
  assert.equal(modal.hidden, true);
  const sent = page.net.filter(r => r.url === "/api/prefs/personal" && r.body && r.body.whatsNewDone).at(-1);
  assert.deepEqual(noPT(sent.body.whatsNewDone), [ID, SHIP]);
});

test("#476: only the Shipping tutorial when Mark shipped is done; not in Simple mode", async () => {
  const one = await open({ org: true, shipDue: true, personalPrefs: { whatsNewDone: [ID] } });
  assert.equal(one.page.$("wnTitle").textContent, "Your shipping costs, in Settings");
  assert.equal((await open({ shipDue: true, settings: { simpleMode: true } })).shown, false);
});

test("#476: every step's picture is in public/img", () => {
  const fs = require("fs");
  for (const n of [1, 2, 3, 4]) assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "img", "whats-new-ship-" + n + ".webp")));
});

test("#497: the Sealed pricing / Portfolio tutorial has its pictures in public/img", () => {
  const fs = require("fs");
  for (const n of ["sealed-pricing-1", "portfolio-1"]) assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "img", "whats-new-" + n + ".webp")));
});

test("#497: the Sealed pricing / Portfolio tutorial is for full mode only", async () => {
  const done = { whatsNewDone: [ID] };
  const full = await open({ org: true, ptDue: true, personalPrefs: done });
  assert.equal(full.shown, true, "a full-mode account gets it");
  assert.equal(full.page.$("wnTitle").textContent, "Sealed pricing and Portfolio have their own tabs");
  const simple = await open({ org: true, ptDue: true, personalPrefs: done, settings: { simpleMode: true } });
  assert.equal(simple.shown, false, "Simple mode hides Listings and Movers, so no tutorial about them");
});

test("#499: the Connect Mana Pool tutorial: for a Mana Pool seller, an old token or an ended connection; pictures in public/img", async () => {
  const fs = require("fs");
  for (const n of [1, 2, 3]) assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "img", "whats-new-mp-connect-" + n + ".webp")));
  const done = { whatsNewDone: [ID] };
  const early = await open({ org: true, mpcDue: true, personalPrefs: done, manapool: { appReady: false } });
  assert.equal(early.shown, false, "waits until the admin has saved the Mana Pool app");
  assert.equal(early.page.net.some(r => r.url === "/api/prefs/personal" && r.body && r.body.whatsNewDone), false, "and isn't counted as seen");
  const seller = await open({ org: true, mpcDue: true, personalPrefs: done, manapool: { appReady: true } });
  assert.equal(seller.shown, true);
  assert.equal(seller.page.$("wnTitle").textContent, "Connect Mana Pool with its own sign-in");
  const ended = await open({ org: true, mpcDue: true, personalPrefs: done, manapool: { hasToken: false, dead: true, appReady: true } });
  assert.equal(ended.shown, true, "an ended connection still gets it");
  const none = await open({ org: true, mpcDue: true, personalPrefs: done, manapool: { hasToken: false, appReady: true } });
  assert.equal(none.shown, false, "no Mana Pool: no tutorial");
});
