"use strict";
/* The business contact form (#249) through its real script
   (public/business.page.js) in a bare VM with a stand-in DOM. Not a
   browser. Missing fields are listed at once without a request; a good
   submission posts the five fields plus the honeypot to
   /api/business-enquiries and swaps the form for "Thanks, we'll be in
   touch at <email>"; the server's problems are listed. The markup is
   checked too: the page is public and the landing page links to it. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PUB = path.join(__dirname, "..", "public");
const SRC = fs.readFileSync(path.join(PUB, "business.page.js"), "utf8");
const HTML = fs.readFileSync(path.join(PUB, "business.html"), "utf8");
const settle = () => new Promise(r => setTimeout(r, 0));

function el(id) {
  return {
    id, hidden: false, value: "", textContent: "", className: "", disabled: false, children: [],
    focus() { this.focused = true; },
    appendChild(c) { this.children.push(c); this.textContent += c.textContent || ""; return c; }
  };
}

function load(reply) {
  const els = new Map();
  const net = [];
  const fetch = async (url, init) => {
    const sent = init && init.body ? JSON.parse(init.body) : undefined;
    net.push({ url, method: init && init.method, body: sent });
    const r = (reply && reply(url, sent)) || { body: { ok: true } };
    const status = r.status || 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r.body) };
  };
  const sandbox = {
    fetch, setTimeout,
    document: {
      getElementById: id => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); },
      createElement: tag => el("<" + tag + ">")
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "business.page.js" });
  const $ = id => sandbox.document.getElementById(id);
  const fill = v => { for (const k of Object.keys(v)) $(k).value = v[k]; };
  const submit = async () => { await $("form").onsubmit({ preventDefault() {} }); for (let i = 0; i < 5; i++) await settle(); };
  return { $, net, fill, submit };
}

test("empty form: every missing field listed at once, nothing sent", async () => {
  const p = load();
  assert.equal(p.$("name").focused, true, "the cursor starts in Your name");
  await p.submit();
  assert.equal(p.net.length, 0);
  assert.equal(p.$("msg").children[0].children.length, 4, "one line per problem");
  assert.match(p.$("msg").className, /err/);
});

test("a good submission posts all five fields and shows where we'll reply", async () => {
  const p = load();
  p.fill({ name: " Sam ", email: "sam@shop.example", shopName: "Sam's Cards", shopSize: "", plans: "Track stock", website: "" });
  await p.submit();
  assert.equal(p.net.length, 1);
  assert.equal(p.net[0].url, "/api/business-enquiries");
  assert.equal(p.net[0].method, "POST");
  assert.deepEqual(p.net[0].body, { name: "Sam", email: "sam@shop.example", shopName: "Sam's Cards", shopSize: "",
    plans: "Track stock", website: "" });
  assert.equal(p.$("form").hidden, true);
  assert.equal(p.$("msg").textContent, "Thanks, we'll be in touch at sam@shop.example.");
  assert.match(p.$("msg").className, /ok/);
});

test("the server's problems are listed and the form stays to fix them", async () => {
  const p = load(() => ({ status: 400, body: { error: "a b", problems: ["That doesn't look like a valid email address.", "x"] } }));
  p.fill({ name: "Sam", email: "nope", shopName: "S", plans: "P" });
  await p.submit();
  assert.equal(p.$("form").hidden, false);
  assert.equal(p.$("submit").disabled, false);
  assert.equal(p.$("msg").children[0].children.length, 2);
  const busy = load(() => ({ status: 429, body: { error: "Too many requests. Try again in 15 minute(s)." } }));
  busy.fill({ name: "Sam", email: "sam@shop.example", shopName: "S", plans: "P" });
  await busy.submit();
  assert.equal(busy.$("msg").textContent, "Too many requests. Try again in 15 minute(s).");
});

test("markup: five fields with limits, the honeypot, and a public page the landing page links to", () => {
  for (const id of ["name", "email", "shopName", "shopSize", "plans", "website"]) assert.match(HTML, new RegExp('id="' + id + '"'));
  assert.match(HTML, /class="hp" aria-hidden="true"><label>Website <input id="website" tabindex="-1"/);
  assert.match(HTML, /id="plans"[^>]*maxlength="1000"/);
  assert.match(HTML, /<script src="\/business\.page\.js"><\/script>/);
  assert.doesNotMatch(HTML, /captcha/i);
  const server = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  assert.match(server, /const PUBLIC_PAGES = new Set\(\[[^\]]*"\/business\.html"/);
  assert.match(fs.readFileSync(path.join(PUB, "welcome.html"), "utf8"), /<a class="lp-btn" id="shopBtn" href="\/business\.html">/);
});
