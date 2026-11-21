"use strict";
/* The sign-in page through its real script (public/login.page.js) in a
   bare VM with a stand-in DOM. Not a browser.
   #156: ?next= may only send you somewhere on this site after signing in.
   An already-signed-in visit redirects at once, so that path is checked
   here: //evil, /\evil, /.//evil (the browser tidies it to //evil), a full
   URL and javascript: all land on /index.html; a real page keeps its
   query string.
   #155: the reset form checks the password rules before posting, so a
   too-short password never reaches (and never spends) the link. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "login.page.js"), "utf8");
const ORIGIN = "https://grimoire.example";
const settle = () => new Promise(r => setTimeout(r, 0));

function el(id) {
  return { id, hidden: false, value: "", textContent: "", className: "", autocomplete: "", disabled: false, checked: false, focus() {}, setAttribute() {}, removeAttribute() {} };
}

// signedIn: what /api/auth/me answers. Returns { sandbox, net, els }.
async function loadLogin(search, signedIn, registration) {
  const els = new Map();
  const net = [];
  const fetch = async (url, init) => {
    net.push({ url, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : undefined });
    const body = url === "/api/meta" ? { registration: registration || "invite", firstRun: false }
      : url === "/api/auth/me" ? { user: signedIn ? { id: "u1" } : null }
      : { ok: true };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const sandbox = {
    console, URL, URLSearchParams, fetch, setTimeout,
    location: { search, origin: ORIGIN, href: ORIGIN + "/login.html" + search },
    document: { getElementById: id => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "login.page.js" });
  for (let i = 0; i < 5; i++) await settle();
  return { sandbox, net, els };
}

const where = async next => (await loadLogin("?next=" + encodeURIComponent(next), true)).sandbox.location.href;

test("off-site next values all land on /index.html (#156)", async () => {
  for (const bad of ["//evil.example/", "/\\evil.example", "/\t/evil.example",
    "https://evil.example/", "javascript:alert(1)", "evil.example", ""]) {
    assert.equal(await where(bad), "/index.html", JSON.stringify(bad));
  }
});

test("a path the browser tidies into //host stays on this site (#156)", async () => {
  // The suggested fix returned the parsed path, and "/.//evil.example"
  // parses to the path "//evil.example": a protocol-relative URL once
  // assigned to location.href. The full same-origin URL is used instead.
  for (const tricky of ["/.//evil.example", "/..//evil.example"]) {
    const href = await where(tricky);
    assert.equal(new URL(href, ORIGIN).origin, ORIGIN, tricky);
    assert.ok(href.startsWith(ORIGIN + "/"), tricky);
  }
});

test("a real page on this site is kept, query string included (#156)", async () => {
  assert.equal(await where("/inventory.html?q=1"), ORIGIN + "/inventory.html?q=1");
  assert.equal(await where("/inventory/bulk-price"), ORIGIN + "/inventory/bulk-price");
});

test("the reset form refuses a too-short password without posting it (#155)", async () => {
  const pg = await loadLogin("?reset=tok123", false);
  const $ = id => pg.sandbox.document.getElementById(id);
  $("password").value = "short1";
  $("password2").value = "short1";
  await $("form").onsubmit({ preventDefault() {} });
  assert.match($("msg").textContent, /at least 10 characters/);
  assert.equal(pg.net.filter(r => r.url === "/api/auth/reset").length, 0);
  $("password").value = "long-enough-1";
  $("password2").value = "long-enough-1";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal(pg.net.filter(r => r.url === "/api/auth/reset").length, 1);
});

test("?mode=register from the landing page opens the sign-up form (#237)", async () => {
  const pg = await loadLogin("?mode=register", false);
  const $ = id => pg.sandbox.document.getElementById(id);
  assert.equal($("submit").textContent, "Create account");
  assert.equal($("password2Wrap").hidden, false);
  // Sign-ups closed: the link can't open a form the server would refuse.
  const closed = await loadLogin("?mode=register", false, "closed");
  assert.equal(closed.sandbox.document.getElementById("submit").textContent, "Sign in");
});

test("the sign-in tagline no longer names a price source (#237)", async () => {
  const pg = await loadLogin("", false);
  const tag = pg.sandbox.document.getElementById("tag").textContent;
  assert.match(tag, /price history/);
  assert.doesNotMatch(tag, /Scryfall/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8"), /via Scryfall/);
});
