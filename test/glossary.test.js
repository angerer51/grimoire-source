"use strict";
/* Glossary (#301): public/js/glossary.js. Not a browser. The matcher and the
   skip rules are plain functions; linkTree runs against a tiny stand-in DOM
   (text nodes, elements, replaceChild). Covers: whole words only, plurals and
   other forms, every use, the skip rules, Simple mode, and that a card or
   location named after a glossary word is never linked. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Glossary = require("../public/js/glossary.js");

const ids = (text, simple) => Glossary.findMatches(text, Glossary.buildMatcher(Glossary.termsFor(!!simple)))
  .map(h => h.term.id + ":" + text.slice(h.start, h.end));

/* ---------- a minimal DOM ---------- */
function text(v) { return { nodeType: 3, nodeValue: v, parentNode: null }; }
function el(tag, attrs, kids) {
  const a = Object.assign({}, attrs || {});
  const n = {
    nodeType: 1, tagName: tag.toUpperCase(), parentNode: null, childNodes: [], attrs: a, className: a.class || "",
    hasAttribute: k => k in a, getAttribute: k => (k in a ? a[k] : null), setAttribute(k, v) { a[k] = v; },
    appendChild(c) { if (c.nodeType === 11) { c.childNodes.forEach(x => this.appendChild(x)); return c; } c.parentNode = n; n.childNodes.push(c); return c; },
    replaceChild(frag, old) {
      const i = n.childNodes.indexOf(old);
      frag.childNodes.forEach(x => { x.parentNode = n; });
      n.childNodes.splice(i, 1, ...frag.childNodes);
    }
  };
  (kids || []).forEach(k => n.appendChild(typeof k === "string" ? text(k) : k));
  return n;
}
const doc = {
  createDocumentFragment: () => ({ nodeType: 11, childNodes: [], appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; } }),
  createTextNode: text,
  createElement: tag => el(tag)
};
// The text of a tree with each link shown as [word].
function render(n) {
  if (n.nodeType === 3) return n.nodeValue;
  const inner = n.childNodes.map(render).join("");
  if (n.className !== "gloss") return inner;
  return n.tagName === "A" ? "[" + inner + "]" : "{" + inner + "}";   // [link] and {preview-only span}
}
const link = (root, simple, extra) => { const n = Glossary.linkTree(root, Object.assign({ simple, doc }, extra)); return { n, out: render(root) }; };

/* ---------- matcher ---------- */
test("whole words only, case-insensitive", () => {
  assert.deepEqual(ids("Each stack has a location."), ["stack:stack", "location:location"]);
  assert.deepEqual(ids("STACK and Stack"), ["stack:STACK", "stack:Stack"]);
  assert.deepEqual(ids("restacking, unstacked, binder, cabin, relocation, slocation"), []);
  assert.deepEqual(ids("non-foil and anti-stack"), [], "a hyphen joins words, so it is not a whole word");
});

test("plurals and other forms link, with a possessive too", () => {
  assert.deepEqual(ids("stacks, locations, printings, conditions"),
    ["stack:stacks", "location:locations", "printing:printings", "condition:conditions"]);
  assert.deepEqual(ids("the stack's price"), ["stack:stack"]);
  assert.deepEqual(ids("pick lists and Pick List"), ["pick-list:pick lists", "pick-list:Pick List"]);
  assert.deepEqual(ids("unrealized gain / Unrealised Gain"), ["unrealised-gain:unrealized gain", "unrealised-gain:Unrealised Gain"]);
  assert.deepEqual(ids("foil, nonfoil and etched"), ["finish:foil", "finish:nonfoil", "finish:etched"]);
  assert.deepEqual(ids("the collector\n number"), ["collector-number:collector\n number"]);
});

test("the longest phrase wins, and every use links", () => {
  assert.deepEqual(ids("Putaway rotation decides putaway."), ["putaway-rotation:Putaway rotation", "putaway:putaway"]);
  assert.deepEqual(ids("a bulk price rule, then Bulk Price"), ["bulk-price-rule:bulk price rule", "bulk-price-rule:Bulk Price"]);
  assert.equal(ids("stack stack stack").length, 3);
});

test("everyday verbs are not terms on their own", () => {
  assert.deepEqual(ids("Set a price, ask the store to list it, then watch the target."), []);
  assert.deepEqual(ids("Pick the set code."), ["set-code:set code"]);
});

test("Simple mode drops the full-only terms", () => {
  assert.deepEqual(ids("Putaway the stack", false), ["putaway:Putaway", "stack:stack"]);
  assert.deepEqual(ids("Putaway the stack", true), ["stack:stack"]);
  assert.ok(Glossary.termsFor(true).every(t => !t.full));
  assert.ok(Glossary.termsFor(true).length < Glossary.TERMS.length);
});

test("every term has a unique id, a short plain definition and links to its own anchor", () => {
  const seen = new Set();
  for (const t of Glossary.TERMS) {
    assert.ok(/^[a-z-]+$/.test(t.id) && !seen.has(t.id), t.id);
    seen.add(t.id);
    assert.ok(t.def.length > 20 && t.def.length < 320, t.id + " definition length");
    assert.ok(!/[—–]|\bsimply\b|\bseamless|\bpowerful\b|\brobust\b/i.test(t.def), t.id + " has filler");
    assert.ok(Glossary.formsOf(t).length > 0);
    assert.equal(Glossary.hrefFor(t), "/help.html#g-" + t.id);
  }
});

/* ---------- skip rules ---------- */
test("text is linked in page copy, headings and column headers", () => {
  const root = el("main", {}, [
    el("p", { class: "page-intro" }, ["Move each stack to a new location."]),
    el("h2", {}, ["Your stacks"]),
    el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", {}, ["Location"])])])])
  ]);
  const { n, out } = link(root);
  assert.equal(n, 4);
  assert.equal(out, "Move each [stack] to a new [location].Your [stacks][Location]");
});

test("never linked: buttons, inputs, selects, links, nav, header, code, titles", () => {
  const root = el("main", {}, [
    el("button", {}, ["Empty the stack"]),
    el("select", {}, [el("option", {}, ["Pick list"])]),
    el("textarea", {}, ["my stack"]),
    el("a", { href: "/x" }, ["stack"]),
    el("nav", {}, ["Locations"]),
    el("header", {}, ["Locations"]),
    el("h1", {}, ["Putaway"]),
    el("code", {}, ["stack"]),
    el("span", { role: "button" }, ["stack"]),
    el("span", { "data-no-gloss": "" }, ["stack"]),
    el("span", { "aria-hidden": "true" }, ["stack"])
  ]);
  const { n, out } = link(root);
  assert.equal(n, 0);
  assert.ok(!out.includes("["));
});

test("a card or location named after a glossary word is not linked (table data, drawn lists)", () => {
  const root = el("main", {}, [
    el("p", {}, ["Your cards"]),
    el("table", {}, [el("tbody", {}, [
      el("tr", {}, [el("td", {}, ["Stack"]), el("td", {}, ["Foil Printing Sorting Tray"]), el("td", {}, ["Bin 4 (Watch List)"])])
    ])]),
    el("a", { href: "/inventory.html?loc=1" }, ["Stack of Cards"]),
    el("select", {}, [el("option", {}, ["Sorting tray"]), el("option", {}, ["Pick List binder"])]),
    el("input", { value: "Stack" })
  ]);
  const { n, out } = link(root);
  assert.equal(n, 0);
  assert.ok(!out.includes("["), out);
});

test("full-only blocks are skipped in Simple mode and linked otherwise", () => {
  const mk = () => el("main", {}, [el("p", { "data-full-only": "" }, ["Run Putaway."]), el("p", {}, ["Run Putaway."])]);
  assert.equal(link(mk(), false).out, "Run [Putaway].Run [Putaway].");
  assert.equal(link(mk(), true).out, "Run Putaway.Run Putaway.");
});

test("links are written once: a second pass finds only plain text and adds nothing", () => {
  const root = el("main", {}, [el("p", {}, ["Each stack."])]);
  assert.equal(link(root).n, 1);
  assert.equal(link(root).n, 0);
});

/* ---------- the wiring ---------- */
test("every page that loads ui.js loads glossary.js first, and the service worker serves it network-first", () => {
  const pub = path.join(__dirname, "..", "public");
  for (const f of fs.readdirSync(pub).filter(f => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(pub, f), "utf8");
    if (!html.includes('src="/js/ui.js"')) continue;
    assert.ok(html.indexOf('src="/js/glossary.js"') > -1 && html.indexOf('src="/js/glossary.js"') < html.indexOf('src="/js/ui.js"'), f);
  }
  const sw = fs.readFileSync(path.join(pub, "sw.js"), "utf8");
  assert.ok(/NETWORK_FIRST = new Set\([^;]*"\/js\/glossary.js"/s.test(sw));
});

test("a form label gets a preview-only span, never a link, so its checkbox still ticks", () => {
  const root = el("main", {}, [el("label", {}, [el("input", { type: "checkbox" }), " Simple mode - hide the business pages"])]);
  const { n, out } = link(root);
  assert.equal(n, 1);
  assert.equal(out, " {Simple mode} - hide the business pages");
  const span = root.childNodes[0].childNodes.find(c => c.tagName === "SPAN");
  assert.ok(span && !span.hasAttribute("href") && !span.hasAttribute("tabindex") && span.getAttribute("data-gloss") === "simple-mode");
});

test("a sortable column header gets a preview-only span; a plain header gets a link", () => {
  const sortable = el("table", { "data-sort": "" }, [el("thead", {}, [el("tr", {}, [el("th", {}, ["Location"])])])]);
  assert.equal(link(el("main", {}, [sortable])).out, "{Location}");
  const plain = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", {}, ["Location"])])])]);
  assert.equal(link(el("main", {}, [plain])).out, "[Location]");
});

test("link(el) on text inside a link (a dashboard tile) gives preview-only spans; the page scan still skips links", () => {
  const tile = () => el("main", {}, [el("a", { href: "/inventory.html" }, [el("span", { class: "lbl" }, ["Cost basis"])])]);
  assert.equal(link(tile()).out, "Cost basis");
  assert.equal(link(tile(), false, { links: true }).out, "{Cost basis}");
});

test("Dashboard links tile labels only when not customizing", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "index.page.js"), "utf8");
  assert.ok(src.includes("if (UI.glossLink && !edit) "));
});
