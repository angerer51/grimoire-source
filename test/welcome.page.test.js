"use strict";
/* The public landing page (#237) through its real script
   (public/welcome.page.js) in a bare VM with a stand-in DOM. Not a browser.
   Plain links do the work; the script only swaps the buttons for a
   signed-in visitor and for a server with sign-ups closed. The markup is
   checked too: the cover and all four tour screenshots are referenced,
   exist on disk, and carry alt text. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PUB = path.join(__dirname, "..", "public");
const SRC = fs.readFileSync(path.join(PUB, "welcome.page.js"), "utf8");
const HTML = fs.readFileSync(path.join(PUB, "welcome.html"), "utf8");
const settle = () => new Promise(r => setTimeout(r, 0));

async function loadWelcome({ signedIn = false, registration = "invite", firstRun = false } = {}) {
  const els = new Map();
  const el = id => ({ id, hidden: false, className: "lp-btn", textContent: "", href: "" });
  const fetch = async url => ({
    json: async () => url === "/api/auth/me" ? { user: signedIn ? { id: "u1" } : null }
      : url === "/api/meta" ? { registration, firstRun } : {}
  });
  const sandbox = {
    fetch,
    document: { getElementById: id => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "welcome.page.js" });
  for (let i = 0; i < 6; i++) await settle();
  return id => sandbox.document.getElementById(id);
}

test("signed out on an invite or open server: both buttons stay as the markup has them", async () => {
  for (const registration of ["invite", "open"]) {
    const $ = await loadWelcome({ registration });
    assert.equal($("createBtn").hidden, false, registration);
    assert.equal($("signInBtn").className, "lp-btn", registration);
  }
});

test("signed in: one orange button to the Dashboard instead of Create account / Sign in", async () => {
  const $ = await loadWelcome({ signedIn: true });
  assert.equal($("createBtn").hidden, true);
  assert.equal($("signInBtn").className, "lp-btn gold");
  assert.equal($("signInBtn").href, "/index.html");
  assert.equal($("topSignIn").href, "/index.html");
});

test("sign-ups closed: no Create account, Sign in becomes the main action", async () => {
  const $ = await loadWelcome({ registration: "closed" });
  assert.equal($("createBtn").hidden, true);
  assert.equal($("signInBtn").className, "lp-btn gold");
  assert.equal($("signInBtn").href, "/login.html");
  // ...except on a brand-new server, where the first account still has to be made.
  const first = await loadWelcome({ registration: "closed", firstRun: true });
  assert.equal(first("createBtn").hidden, false);
});

test("the page carries the cover, four captioned screenshots, and the shop band", () => {
  const imgs = [...HTML.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
  const srcs = imgs.map(t => (t.match(/src="([^"]+)"/) || [])[1]);
  assert.deepEqual(srcs, ["/img/grimoire-cover.webp", "/img/tour-inventory.webp",
    "/img/tour-price-history.webp", "/img/tour-putaway.webp", "/img/tour-trades.webp"]);
  for (const t of imgs) {
    const src = t.match(/src="([^"]+)"/)[1];
    assert.ok(fs.existsSync(path.join(PUB, src)), src + " exists");
    assert.ok(fs.statSync(path.join(PUB, src)).size < 160 * 1024, src + " stays small");
    assert.match(t, /alt="[^"]{20,}"/, src + " has real alt text");
    assert.match(t, /width="\d+" height="\d+"/, src + " reserves its space");
  }
  for (const h of ["Inventory", "Price History", "Putaway", "Trades"]) assert.match(HTML, new RegExp("<h2>" + h + "</h2>"));
  assert.match(HTML, /Free for personal collections\./);
  // #249: the shop band links to the business contact form.
  assert.match(HTML, /<a class="lp-btn" id="shopBtn" href="\/business\.html">Using Grimoire for your shop\?<\/a>/);
  assert.doesNotMatch(HTML, /coming soon/i);
  assert.match(HTML, /href="\/login\.html\?mode=register"/);
  // Owner's call: no prices, tiers or donation link on this page.
  assert.doesNotMatch(HTML, /\$\d|per month|donat/i);
});
