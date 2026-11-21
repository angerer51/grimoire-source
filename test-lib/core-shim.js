"use strict";
/* Loads public/js/core.js (and its priceRuleEngine.js dependency) into a
   fresh, isolated VM sandbox per call - the same "minimal browser" shim
   pattern several disposable one-off verification scripts already used this
   session, promoted here so it survives between sessions (see BACKLOG.md
   #20). core.js expects `window`, `document`, `location`, `fetch` and a
   handful of timer globals to exist; nothing else. Network calls (fetch)
   are stubbed to reject, since every test in this suite drives core.js's
   pure state-mutation functions directly rather than its load()/persist()
   round trip to a real server - that side is covered by the disposable
   HTTP smoke tests noted in BACKLOG.md entries instead, not here.

   Each call returns a brand-new `G`, with no state bleeding between tests -
   core.js's `state` object lives inside its own IIFE closure per sandbox. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_DIR = path.join(__dirname, "..");
const RULE_ENGINE_SRC = fs.readFileSync(path.join(APP_DIR, "public/js/priceRuleEngine.js"), "utf8");
const SHIP_COST_SRC = fs.readFileSync(path.join(APP_DIR, "public/js/shipCost.js"), "utf8");
const CORE_SRC = fs.readFileSync(path.join(APP_DIR, "public/js/core.js"), "utf8");

// opts.fetch: optional stand-in for the network, for a test that drives one
// of core.js's own server calls against a canned response.
function freshCore(opts) {
  return freshCoreSandbox(opts).G;
}

// The same, plus the sandbox itself, for a harness that runs more browser
// code next to core.js (test-lib/page-shim.js runs a page's *.page.js).
function freshCoreSandbox(opts) {
  const sandbox = {
    console,
    fetch: (opts && opts.fetch) || (async () => { throw new Error("no network in the test shim - drive core.js's pure functions directly"); }),
    // opts.document: a stand-in DOM (test-lib/page-shim.js), in place
    // before core.js runs so its own listeners (visibilitychange) land on it.
    document: (opts && opts.document) || { addEventListener: () => {} },
    // opts.addEventListener: lets a test capture window listeners
    // (core.js's beforeunload flush).
    addEventListener: (opts && opts.addEventListener) || (() => {}),
    removeEventListener: () => {},
    location: { pathname: "/test", href: "" },
    navigator: { userAgent: "test" },
    // unref'd: persist() schedules a debounced save, and a failed audit
    // flush retries every 8s; neither may keep the test process alive.
    setTimeout: (f, ms, ...a) => { const t = setTimeout(f, ms, ...a); if (t.unref) t.unref(); return t; },
    clearTimeout, clearInterval,
    // The same for ui.js's pollers (notifications, heartbeat).
    setInterval: (f, ms, ...a) => { const t = setInterval(f, ms, ...a); if (t.unref) t.unref(); return t; },
    URL, URLSearchParams, TextEncoder,
    atob: s => Buffer.from(s, "base64").toString("binary"),
    btoa: s => Buffer.from(s, "binary").toString("base64")
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULE_ENGINE_SRC, sandbox, { filename: "priceRuleEngine.js" });
  vm.runInContext(SHIP_COST_SRC, sandbox, { filename: "shipCost.js" });
  vm.runInContext(CORE_SRC, sandbox, { filename: "core.js" });
  return { G: sandbox.window.G, sandbox };
}

/* Convenience: a fresh G with one storage location already in it, since
   nearly every inventory-mutating function needs a valid locationId. */
function freshCoreWithLocation(locId, locName) {
  const G = freshCore();
  G.state.locations.push(G.newLocation({ id: locId || "loc1", name: locName || "Test bin", type: "bin" }));
  return G;
}

module.exports = { freshCore, freshCoreSandbox, freshCoreWithLocation, APP_DIR };
