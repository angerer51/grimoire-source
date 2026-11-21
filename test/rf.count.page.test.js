"use strict";
/* Warehouse Mode's count screens (#389), through the real rf/*.page.js next to
   the real core.js with a stand-in DOM: the list, the bin check, the blind
   stack screens, the one recount, found-not-on-the-list, and the post. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const MONEY = /\$\s*\d|price|cost|revenue|profit|12\.34|5\.67/i;
const card = (id, name, locationId, quantity, extra) => Object.assign({ id, set: "tst", collector: id, name, lang: "en", finish: "nonfoil", condition: "NM", quantity, locationId,
  imageUrl: "https://cards.scryfall.io/normal/front/a/b/" + id + ".jpg", price: 12.34, avgCost: 5.67, costQty: quantity, costTotal: 5.67 * quantity, listedQty: 0 }, extra);
const DOC = extra => Object.assign({
  locations: [{ id: "binA", name: "A-1", type: "Box", countWanted: { at: "2026-11-01T00:00:00Z", by: "x", reason: "Short pick on #1001" } },
    { id: "binB", name: "B-2", type: "Box", countWanted: { at: "2026-11-02T00:00:00Z", by: "x", reason: "Sent from the desk", src: "desk" } },
    { id: "binC", name: "C-3", type: "Box" }],
  cards: [card("1", "Sol Ring", "binA", 3), card("2", "Arcane Thing", "binA", 4), card("3", "Other", "binB", 2)],
  settings: { tutorialSeen: true }
}, extra);

async function rf(doc) {
  const pg = loadPage(null, {
    scripts: ["rf/shell.page.js", "rf/count.page.js"],
    routes: url => {
      if (url === "/api/auth/me") return { user: { id: "u1", username: "sam" } };
      if (url === "/api/collection") return { rev: 1, state: doc || DOC(), patch: 0 };
      if (url === "/api/collection/stamp") return { stamp: "s1" };
      if (url === "/api/meta") return { version: "1" };
      if (String(url).startsWith("/api/cards/one")) return { card: { name: "Found Thing", collector: "9", setName: "Test", set: "tst", rarity: "common", prices: { usd: "1" } } };
      if (String(url).startsWith("/api/audit")) return { entries: [], total: 0 };
      return {};
    }
  });
  pg.sandbox.scrollTo = () => {};
  pg.sandbox.location.hash = "";
  pg.$("rfOverlay").hidden = true;
  await pg.sandbox.RF.start();
  const RF = pg.sandbox.RF;
  const screen = () => pg.$("rfRoot").innerHTML;
  const open = hash => { pg.sandbox.location.hash = hash; RF.redraw(true); };
  const press = async (act, data) => {
    pg.dispatch("click", { target: { closest: () => ({ dataset: Object.assign({ act }, data), disabled: false }) } });
    await settle(5);
  };
  const type = async (id, value, act) => { pg.$(id).value = value; await press(act); };
  return { pg, G: pg.G, RF, screen, open, press, type };
}
const noMoney = t => assert.doesNotMatch(t.screen(), MONEY);

test("the list puts the short-pick bin first, and the home badge counts what's waiting", async () => {
  const t = await rf();
  t.open("");
  assert.match(t.screen(), /Count/);
  assert.match(t.screen(), /rf-count"[^>]*>2</);
  t.open("#count");
  const s = t.screen();
  assert.ok(s.indexOf("A-1") < s.indexOf("B-2"));
  assert.match(s, /Short pick/);
  assert.match(s, /Sent from the desk/);
  assert.doesNotMatch(s, /#1001/, "no ticket label on the floor list");
  assert.match(s, /Count A-1/);
  noMoney(t);
});

test("with nothing waiting, Count next bin takes a bin from the rotation", async () => {
  const doc = DOC();
  doc.locations.forEach(l => { delete l.countWanted; });
  const t = await rf(doc);
  t.open("#count");
  assert.match(t.screen(), /No bin is waiting/);
  assert.match(t.screen(), /Count next bin/);
  await t.press("cnNext", { kind: "cards" });
  assert.match(t.pg.sandbox.location.hash, /^#count\/bin\/bin[AB]\/cards$/);
  t.open("#count");
  await t.press("cnNext", { kind: "sealed" });
  assert.match(t.screen(), /No bin has sealed product to count/);
});

test("a blind count: no quantity on any screen, one recount, the second count posts", async () => {
  const t = await rf();
  t.open("#count/bin/binA/cards");
  assert.match(t.screen(), /Go to/);
  assert.match(t.screen(), /At this bin/);
  await t.press("cnAtBin");
  // Arcane Thing (4 on the book) comes first by name.
  assert.match(t.screen(), /Arcane Thing/);
  assert.match(t.screen(), /How many\?/);
  assert.match(t.screen(), /1 of 2/);
  assert.doesNotMatch(t.screen(), /\b[34]\b copies|book says|expect/i);
  noMoney(t);

  await t.type("rfN", "x", "cnCount");
  assert.match(t.screen(), /Type how many you see/);
  await t.type("rfN", "3", "cnCount");
  assert.match(t.screen(), /doesn't match the book/);
  assert.match(t.screen(), /Arcane Thing/, "the same stack again");
  assert.doesNotMatch(t.screen(), /\b[34]\b copies|book says|expect/i);
  await t.type("rfN", "3", "cnCount");
  assert.match(t.screen(), /Sol Ring/, "on to the next stack after the second count");
  assert.match(t.screen(), /2 of 2/);
  await t.type("rfN", "3", "cnCount");
  assert.match(t.screen(), /2 stacks counted/);
  assert.match(t.screen(), /Found a card not on the list/);

  await t.press("cnDone");
  assert.match(t.pg.$("rfOverlay").innerHTML, /Post this count/);
  await t.pg.$("rfConfirmOk").onclick();
  await settle(10);
  assert.match(t.screen(), /A-1 counted/);
  assert.match(t.screen(), /1 stack corrected/);
  assert.match(t.screen(), /Next: B-2/);
  const g = t.G;
  assert.equal(g.state.cards.find(r => r.name === "Arcane Thing").quantity, 3);
  assert.equal(g.state.cards.find(r => r.name === "Sol Ring").quantity, 3);
  assert.equal(g.state.locations.find(l => l.id === "binA").countWanted, null);
  noMoney(t);
});

test("a recount that matches the book changes nothing; an empty bin posts clean", async () => {
  const t = await rf();
  t.open("#count/bin/binA/cards");
  await t.press("cnAtBin");
  await t.type("rfN", "5", "cnCount");           // Arcane Thing: differs
  await t.type("rfN", "4", "cnCount");           // recount matches the book
  await t.type("rfN", "3", "cnCount");           // Sol Ring matches
  await t.press("cnDone");
  await t.pg.$("rfConfirmOk").onclick();
  await settle(10);
  assert.match(t.screen(), /Everything matched the book/);
  assert.equal(t.G.state.cards.find(r => r.name === "Arcane Thing").quantity, 4);

  t.open("#count/bin/binC/cards");
  await t.press("cnAtBin");
  assert.match(t.screen(), /Nothing is on the book for this bin/);
  await t.press("cnDone");
  await t.pg.$("rfConfirmOk").onclick();
  await settle(10);
  assert.match(t.screen(), /Everything matched the book/);
  assert.ok(t.G.state.locations.find(l => l.id === "binC").lastCycleCountAt);
});

test("stock that changed mid-count re-asks only the changed stack and keeps the other count", async () => {
  const t = await rf();
  t.open("#count/bin/binA/cards");
  await t.press("cnAtBin");
  await t.type("rfN", "4", "cnCount");           // Arcane Thing, matches
  t.G.state.cards.find(r => r.name === "Sol Ring").quantity = 2;   // another device changes Sol Ring's shelf
  await t.type("rfN", "2", "cnCount");
  await t.press("cnDone");
  await t.pg.$("rfConfirmOk").onclick();
  await settle(10);
  assert.match(t.screen(), /1 stack in A-1 changed[\s\S]*Sol Ring/);
  assert.doesNotMatch(t.screen(), /Arcane Thing/, "the stack that didn't change isn't asked again");
  await t.type("rfN", "2", "cnCount");
  await t.press("cnDone");
  await t.pg.$("rfConfirmOk").onclick();
  await settle(10);
  assert.match(t.screen(), /A-1 counted/);
  assert.equal(t.G.state.cards.find(r => r.name === "Arcane Thing").quantity, 4);
});

test("when the FIRST stack is the one that changed, the next screen is Done, not the stacks already counted", async () => {
  const t = await rf();
  t.open("#count/bin/binA/cards");
  await t.press("cnAtBin");
  await t.type("rfN", "4", "cnCount");           // Arcane Thing
  await t.type("rfN", "3", "cnCount");           // Sol Ring
  t.G.state.cards.find(r => r.name === "Arcane Thing").quantity = 2;   // the first one changes elsewhere
  await t.press("cnDone");
  await t.pg.$("rfConfirmOk").onclick();
  await settle(10);
  assert.match(t.screen(), /1 stack in A-1 changed[\s\S]*Arcane Thing/);
  await t.type("rfN", "2", "cnCount");
  assert.match(t.screen(), /2 stacks counted[\s\S]*Done counting/, "straight to the end, Sol Ring isn't asked again");
  assert.doesNotMatch(t.screen(), /How many\?/);
});

test("the bin check follows Require bin scan: no tap, a wrong bin refused, a keyed bin logged", async () => {
  const t = await rf(DOC({ settings: { tutorialSeen: true, requireBinScan: true } }));
  t.open("#count/bin/binA/cards");
  assert.doesNotMatch(t.screen(), /data-act="cnAtBin"/);
  await t.press("cnAtBin");
  assert.match(t.screen(), /Go to/, "a tap does nothing");
  t.pg.sandbox.document.activeElement = { id: "rfScanInput", value: "GRIMBIN:binB" };
  t.pg.dispatch("keydown", { key: "Enter" });
  await settle(2);
  assert.match(t.pg.$("rfScanMsg").textContent, /Wrong bin/);
  await t.press("cnCantScan");
  await t.press("cnKeyReason", { reason: "Label missing" });
  await t.type("rfKeyed", "B-2", "cnKeySubmit");
  assert.match(t.screen(), /not the right bin/);
  await t.type("rfKeyed", "a-1", "cnKeySubmit");
  assert.match(t.screen(), /How many\?/);
  const q = await t.G.queryAudit({ limit: 20 });
  assert.ok(q.entries.some(e => e.action === "bin-keyed"));
});

test("found a card not on the list: it's listed on the screen, can be removed, and is added on Done", async () => {
  const t = await rf();
  t.G.cards.autocomplete = async () => ["Found Thing"];
  t.G.cards.printings = async () => [{ set: "tst", collector: "9", name: "Found Thing", lang: "en", finishes: ["nonfoil", "foil"], imageUrl: "https://cards.scryfall.io/normal/front/f/f/ff.jpg", setName: "Test" }];
  t.open("#count/bin/binC/cards");
  await t.press("cnAtBin");
  await t.press("cnFound");
  assert.match(t.screen(), /Which card\?/);
  await t.type("rfQ", "found", "cnFind");
  await settle(10);
  assert.match(t.screen(), /Found Thing/);
  await t.press("cnUp");
  await t.press("cnCond", { v: "LP" });
  await t.press("cnAdd");
  assert.match(t.screen(), /×2 LP Found Thing/);
  noMoney(t);
  await t.press("cnFoundDel", { i: "0" });
  assert.doesNotMatch(t.screen(), /×2 LP Found Thing/);
  await t.press("cnFound");
  await t.type("rfQ", "found", "cnFind");
  await settle(10);
  await t.press("cnCond", { v: "MP" });
  await t.press("cnAdd");
  await t.press("cnDone");
  await t.pg.$("rfConfirmOk").onclick();
  await settle(10);
  assert.match(t.screen(), /1 item added/);
  assert.equal(t.G.state.cards.filter(r => r.locationId === "binC" && r.name === "Found Thing").length, 1);
});
