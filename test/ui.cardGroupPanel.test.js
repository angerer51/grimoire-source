"use strict";
/* #423: every card name on a desk page is a UI.cardLink. A grouped row (one
   name, several printings) uses UI.cardNameLink, and its click opens the
   card panel on a printing list: "You hold N across M printings", one row
   per printing. The real ui.js runs through the page shim; not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, settle } = require("../test-lib/page-shim");

async function open() {
  const page = loadPage(null, {
    realUI: true,
    routes: async (url, init) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/meta") return { version: "test", restart: null };
      if (url === "/api/auth/me") return { user: { id: "u1", username: "u" }, personalPrefs: null };
      if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state: { settings: { tutorialSeen: true } } };
      if (url === "/api/cards/status") return { ready: true };
      return {};
    }
  });
  page.sandbox.location.pathname = "/inventory.html";
  await page.boot();
  await settle(5);
  return page;
}

test("cardNameLink marks a name link as a group, and cardLink falls back to it without a printing", async () => {
  const page = await open();
  const a = page.sandbox.UI.cardNameLink("Sol Ring");
  assert.match(a, /class="card-link"/);
  assert.match(a, /data-group="1"/);
  assert.match(a, /data-name="Sol Ring"/);
  assert.equal(page.sandbox.UI.cardNameLink(""), "");
  assert.match(page.sandbox.UI.cardLink({ name: "Sol Ring" }), /data-group="1"/);
  const one = page.sandbox.UI.cardLink({ name: "Sol Ring", set: "c21", collector: "263" });
  assert.match(one, /data-set="c21"/);
  assert.doesNotMatch(one, /data-group/);
  assert.equal(page.sandbox.UI.cardLink({ name: "" }, "x"), "x");
});

test("a name-link click opens the printing list with the holdings across printings", async () => {
  const page = await open();
  const mk = (id, set, collector, finish, condition, quantity, price) =>
    ({ id, name: "Sol Ring", set, collector, finish, condition, quantity, price, locationId: "l1" });
  page.G.state.cards = [
    mk("a", "c21", "263", "nonfoil", "NM", 3, 1.5),
    mk("b", "c21", "263", "nonfoil", "LP", 1, 1.2),
    mk("c", "cmm", "400", "foil", "NM", 2, 4),
    Object.assign(mk("d", "lea", "1", "nonfoil", "NM", 9, 9), { name: "Black Lotus" })
  ];
  const anchor = { dataset: { group: "1", name: "sol ring" } };
  let stopped = false;
  await page.dispatch("click", {
    target: { closest: sel => sel === "a.card-link" ? anchor : null },
    preventDefault() {}, stopPropagation() { stopped = true; }
  });
  assert.ok(stopped, "the link stops the row's own click");
  const html = page.$("cpGroup").innerHTML;
  assert.match(html, /You hold 6 across 2 printings/);
  assert.match(html, /C21 #263/);
  assert.match(html, /CMM #400/);
  assert.doesNotMatch(html, /LEA/);
  assert.match(html, /NM, LP/, "conditions of one printing share a row");
  assert.equal(page.$("cpGroup").hidden, false);
  assert.equal(page.$("cardPanelHost").hidden, true);
});

/* The coverage rule itself: a card-name cell in a page script holds a card
   link, unless it is sealed product (not a card) or a print-only sheet. */
test("every card-name cell on a desk page is a card link", () => {
  const dir = path.join(__dirname, "..", "public");
  const files = fs.readdirSync(dir).filter(f => /\.page\.js$/.test(f)).map(f => path.join(dir, f))
    .concat(["tradeCompose.js", "tradeRecord.js"].map(f => path.join(dir, "js", f)));
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((ln, i) => {
      // a card-name cell, or a queue line that names a card (Receive's add queue)
      if (!/class=\\?"(card-name|qname)\\?"/.test(ln)) return;
      const near = lines.slice(i, i + 3).join(" ");
      if (/cardLink|cardNameLink/.test(near)) return;
      if (/setCode|[sS]ealed/.test(near)) return;   // sealed product has no card panel
      bad.push(path.basename(f) + ":" + (i + 1) + " " + ln.trim().slice(0, 90));
    });
  }
  assert.deepEqual(bad, []);
});
