"use strict";
/* Runs one page's public/<page>.page.js next to the real core.js, with a
   stand-in DOM and UI, so a test can drive the page's own handlers and see
   what it draws and which requests it sends. Not a browser: elements are
   plain objects (innerHTML is a string, nothing is parsed or laid out), and
   UI is a stub whose helpers return short marker strings. Good for "does a
   dropdown change hit the network", "is a superseded response ignored",
   "what does Cancel leave behind"; not for layout or CSS.

   loadPage(file, { routes, scripts, realUI, ui }) -> { G, sandbox, $, boot, net, ui }
   - routes(url, opts) answers each fetch: return a value (sent as a 200 JSON
     body), a Promise of one (for out-of-order tests), or throw. Unrouted
     requests answer {}. { __status: 404, error } answers that status.
   - net is every request sent: [{ url, method, body, keepalive }].
   - boot() runs the page's UI.boot callback and waits for it.
   - fireWindow(type) / fireDocument(type, visibilityState?) call the
     listeners the page added on window / document.
   - dispatch(type, props) sends one event object (props merged in, e.g.
     { target }) to the document listeners and returns it, so a test can
     see whether a listener called preventDefault().
   - $ (id) is the element with that id, made on first use; set .value /
     .checked and call el.fire("change") to act like the user.
   - realUI: true runs the real public/js/ui.js instead of the stub UI, for
     the shared chrome (Sign out, the store switcher, links, the restart
     banner). file may then be null: boot() mounts the chrome and loads the
     collection with no page script. ui.toasts still collects every toast,
     and location.reload() counts into sandbox.location.reloads.

   holdCoreTimers(page, 8000) holds core.js's own 8 s retry timers, so a
   test can count the waiting ones and run them at once (see below). */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { freshCoreSandbox, APP_DIR } = require("./core-shim");

function makeEl(id, doc) {
  const listeners = {};
  let found = {};
  const el = {
    id, tagName: "DIV", textContent: "", value: "", checked: false, hidden: false,
    disabled: false, className: "", title: "", children: [], dataset: {}, style: {},
    rows: [],   // a tbody's drawn rows; innerHTML is never parsed, so always none
    options: [], get selectedOptions() { return [{ value: el.value, textContent: el.value }]; },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, on) { const v = on === undefined ? !this._s.has(c) : !!on; if (v) this._s.add(c); else this._s.delete(c); return v; }
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    async fire(type) {
      const ev = { type, target: el, preventDefault() {}, stopPropagation() {} };
      const out = [];
      if (typeof el["on" + type] === "function") out.push(el["on" + type](ev));
      for (const fn of listeners[type] || []) out.push(fn(ev));
      await Promise.all(out);
    },
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.unshift(c); return c; },
    contains() { return false; },
    hasAttribute(k) { return ("attr:" + k) in el; },
    insertAdjacentHTML(pos, html) { el.innerHTML += html; },
    querySelectorAll() { return []; },
    // A fresh stand-in, so `row.querySelector("button").onclick = ...` works.
    querySelector(sel) { return (found[sel] = found[sel] || makeEl(null)); }, // same stand-in per selector, so a test can call the handler the page set
    closest() { return null; },
    setAttribute(k, v) { el["attr:" + k] = String(v); },
    getAttribute(k) { return el["attr:" + k]; },
    removeAttribute(k) { delete el["attr:" + k]; },
    focus() {}, blur() {}, remove() {}, click() { return el.fire("click"); }
  };
  // Setting innerHTML replaces the children, as in a browser.
  let html = "";
  Object.defineProperty(el, "innerHTML", { configurable: true, enumerable: true,
    get: () => html, set: v => { html = String(v); el.children = []; found = {}; } });
  let head = null;
  Object.defineProperty(el, "tHead", { get: () => head || (head = Object.assign(makeEl(null), { rows: [{ cells: [] }] })) });
  return el;
}

function loadPage(file, opts) {
  const o = opts || {};
  const net = [];
  const fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    net.push({ url, method: (init && init.method) || "GET", body, keepalive: !!(init && init.keepalive) });
    let v = await (o.routes ? o.routes(url, init, body) : {});
    // The server's "did anything change?": nothing has, unless a test's route says otherwise.
    if (url === "/api/collection/stamp" && !(v && (v.stamp || v.__status))) v = { stamp: "page-shim" };
    // A route may answer an error: { __status: 404, error: "..." }.
    const status = (v && v.__status) || 200;
    const out = v === undefined ? {} : v;
    return { status, ok: status < 400, text: async () => JSON.stringify(out), json: async () => out };
  };
  // window and document listeners, so a test can fire "focus" or
  // "visibilitychange" with fireWindow / fireDocument.
  const winListeners = {}, docListeners = {};
  const listen = map => (type, fn) => { (map[type] = map[type] || []).push(fn); };
  const makeEvent = (type, props) => Object.assign({
    type, button: 0, defaultPrevented: false, returnValue: undefined,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}
  }, props || {});
  const fireAll = (map, type) => Promise.all((map[type] || []).map(fn => fn(makeEvent(type))));
  const dispatchTo = (map, type, props) => {
    const ev = makeEvent(type, props);
    for (const fn of map[type] || []) fn(ev);
    return ev;
  };
  const els = new Map();
  const $ = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  // Made before core.js runs, so its own document listeners
  // (visibilitychange) land here too.
  const document = {
    visibilityState: "visible", hidden: false, activeElement: null,
    addEventListener: listen(docListeners), removeEventListener() {},
    getElementById: $,
    createElement: tag => Object.assign(makeEl(null), { tagName: String(tag).toUpperCase() }),
    createTextNode: t => ({ textContent: t }),
    querySelectorAll: () => [], querySelector: () => null, contains: () => false, body: makeEl("body")
  };
  const { G, sandbox } = freshCoreSandbox({ fetch, document, addEventListener: listen(winListeners) });
  let bootFn = null;
  const ui = {
    confirmAnswer: true, confirms: [], toasts: [], statuses: [],
    $, boot: fn => { bootFn = fn; },
    // Stand-in for UI.pageTabs (#438/#442; the real one is tested in ui.pageTabs.test.js):
    // opens the tab in the address (#id or #tab=id), else spec.def or the first shown, no memory.
    pageTabs: spec => {
      const list = spec.tabs;
      const usable = id => list.find(t => t.id === id && !$(t.button).hidden);
      let cur = null;
      const show = id => {
        const t = usable(id) || list.find(x => !$(x.button).hidden);
        if (!t) return;
        cur = t.id;
        for (const x of list) {
          $(x.button).classList.toggle("active", x === t);
          for (const p of x.panes) $(p).hidden = x !== t;
        }
        if (spec.onShow) spec.onShow(cur);
      };
      for (const t of list) $(t.button).addEventListener("click", () => show(t.id));
      const h = String((sandbox.location && sandbox.location.hash) || "").replace(/^#(tab=)?/, "");
      show(usable(h) ? h : spec.def);
      return { show, current: () => cur };
    },
    autocompletes: [], Autocomplete: (input, list, onPick) => { ui.autocompletes.push({ input, list, onPick }); },
    confirmDialog: async (msg, op) => { ui.confirms.push(msg); return ui.confirmAnswer; },
    toast: (msg, kind) => { ui.toasts.push(msg); },
    setStatus: (id, msg, kind) => { ui.statuses.push(msg); $(id).textContent = msg; },
    emptyBlock: e => "[empty:" + ((e && e.title) || "") + "]",
    emptyRow: (n, e) => "[emptyrow " + n + ":" + ((e && e.title) || "") + "]",
    skeletonRows: n => "[skeleton " + n + "]",
    skeletonBlock: () => "[skeleton]",
    artThumbTd: () => "<td></td>",
    // The card panel's name link and card-filter chip (#410): plain text, no filter.
    cardLink: (c, text) => G.esc(text == null ? (c && c.name) : text),
    cardNameLink: (name, text) => G.esc(text == null ? name : text),
    cardFilterFromUrl: () => null, cardFilterMatches: () => true,
    cardFilterChip() {}, cardFilterLabel: f => (f && f.name) || "",
    // A slide-over that is never open (Customers' detail panel).
    slideOver: () => ({ open() {}, close() {}, isOpen: () => false }),
    barList: rows => "[bars " + rows.length + "]",
    lineChart: () => "[chart]",
    vendorCompare: () => "",
    rowGain: () => null,
    domOrder: () => null,
    fillLocationSelect(el, selectedId, op) {
      const keep = selectedId != null ? selectedId : el.value;
      const ids = G.state.locations.map(l => l.id).concat(op && op.newLabel ? ["__new"] : []);
      el.options = ids.map(v => ({ value: v, textContent: v }));
      el.value = ids.includes(keep) ? keep : (ids[0] || "");
    }
  };
  if (o.realUI) {
    Object.assign(sandbox.location, {
      origin: "https://grimoire.test", href: "https://grimoire.test/test", search: "", hash: "",
      reloads: 0, reload() { this.reloads++; }
    });
    vm.runInContext(fs.readFileSync(path.join(APP_DIR, "public/js/ui.js"), "utf8"), sandbox, { filename: "ui.js" });
    // Every toast the real UI shows lands in ui.toasts too.
    let shown = "";
    Object.defineProperty($("toastMsg"), "textContent", { get: () => shown, set: v => { shown = v; ui.toasts.push(v); } });
    // With a page script too (#442: its real UI.pageTabs): only the page's boot callback
    // runs, as with the stub UI, not the chrome.
    if (file) sandbox.UI = Object.assign({}, sandbox.UI, { boot: fn => { bootFn = fn; } });
  } else {
    // Anything else on UI (hover wiring, sort re-apply, modals) is a no-op.
    // o.ui: a test's own stand-ins on top, e.g. { cardFilterFromUrl: () => filter }.
    sandbox.UI = new Proxy(Object.assign(ui, o.ui || {}), { get: (t, k) => (k in t ? t[k] : () => "") });
  }
  // Other scripts the page loads before itself, e.g. ["js/moversPicks.js"].
  for (const extra of o.scripts || []) {
    vm.runInContext(fs.readFileSync(path.join(APP_DIR, "public", extra), "utf8"), sandbox, { filename: extra });
  }
  if (file) {
    const src = fs.readFileSync(path.join(APP_DIR, "public", file), "utf8");
    vm.runInContext(src, sandbox, { filename: file });
  }
  return {
    G, sandbox, $, net, ui,
    boot: async () => {
      if (o.realUI && !file) await sandbox.UI.boot(async () => {});
      else await bootFn();
    },
    fireWindow: type => fireAll(winListeners, type),
    // Sets document.visibilityState first when `state` is given.
    fireDocument: (type, state) => {
      if (state) { sandbox.document.visibilityState = state; sandbox.document.hidden = state !== "visible"; }
      return fireAll(docListeners, type);
    },
    dispatch: (type, props) => dispatchTo(docListeners, type, props),
    dispatchWindow: (type, props) => dispatchTo(winListeners, type, props)
  };
}

// Let pending promise callbacks and zero-delay timers run.
const settle = (ms) => new Promise(r => setTimeout(r, ms || 0));

/* Takes over the timers core.js itself starts with exactly `ms` delay (the
   8 s save and audit retries), so a test can count how many are waiting
   and run them without waiting in real time. Timers from ui.js or a page
   script, and any other delay, run as usual.
   -> { pending, started, fire() }: fire() runs every waiting one once. */
function holdCoreTimers(page, ms) {
  const sb = page.sandbox, realSet = sb.setTimeout, realClear = sb.clearTimeout;
  const waiting = new Map();
  let started = 0;
  sb.setTimeout = (f, delay, ...a) => {
    // Frame 0 is "Error", 1 this function, 2 whoever called setTimeout.
    const caller = (new Error().stack.split("\n")[2] || "");
    if (delay !== ms || !/core\.js:/.test(caller)) return realSet(f, delay, ...a);
    const id = { held: ++started };
    waiting.set(id, () => f(...a));
    return id;
  };
  sb.clearTimeout = t => { if (!waiting.delete(t)) realClear(t); };
  return {
    /* Call once the scenario has run: if core.js's stack frames stop
       matching /core\.js:/ nothing is ever held and a test would pass for
       the wrong reason (#190). */
    assertHeld() {
      if (started < 1) throw new Error("holdCoreTimers held no timer: the core.js stack-trace match may have stopped working");
    },
    get pending() { return waiting.size; },
    get started() { return started; },
    async fire() {
      const run = [...waiting.values()];
      waiting.clear();
      for (const f of run) f();
      await settle(20);
    }
  };
}

module.exports = { loadPage, settle, holdCoreTimers };
