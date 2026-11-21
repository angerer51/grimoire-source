"use strict";
/* public/js/ui.js - the shared chrome saves before it leaves the page.
   #174: a link to another page of the app, or a button that opens one
   (UI.go), waits for G.saveAll() and only then navigates; a failed save
   keeps you on the page and says so.
   #176: Sign out used G.saveNow(), which never rejects, so its "may not have
   saved" confirm could never appear.
   #145 (client half): the sidebar store switcher saves first and holds saves
   during the switch, the way the notification bell does.
   The real ui.js and core.js run through the page shim (realUI); not a
   browser. The restart banner's reload is in ui.restartReload.test.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const ORIGIN = "https://grimoire.test";

/* opts.put(body): answers PUT /api/collection (default: saved).
   opts.org: an org member who can reach Store A and Store B.
   opts.switchAnswer(body): answers POST /api/store/switch. */
async function open(opts) {
  const o = opts || {};
  let rev = 1;
  const page = loadPage(null, {
    realUI: true,
    routes: async (url, init, body) => {
      const method = (init && init.method) || "GET";
      if (url === "/api/meta") return { version: "test", restart: null };
      if (url === "/api/auth/me") {
        return o.org
          ? { user: { id: "u1", username: "u", orgId: "o1", orgRole: "manager" }, personalPrefs: { simpleMode: false, chime: true, chimeMin: 20 } }
          : { user: { id: "u1", username: "u" }, personalPrefs: null };
      }
      if (url === "/api/collection" && method === "GET") return { rev, savedAt: null, state: { settings: { tutorialSeen: true } } };
      if (url === "/api/collection" && method === "PUT") {
        if (o.put) { const v = await o.put(body); if (v) return v; }
        return { rev: ++rev, savedAt: "2026-10-10T00:00:00Z" };
      }
      if (url === "/api/orgs/mine") {
        return { accessibleStoreIds: ["A", "B"], activeStoreId: "A", stores: [{ id: "A", name: "Store A" }, { id: "B", name: "Store B" }] };
      }
      if (url === "/api/store/switch") return o.switchAnswer ? o.switchAnswer(body) : { ok: true };
      if (url === "/api/cards/status") return { ready: true };
      return {};
    }
  });
  page.sandbox.location.pathname = "/inventory.html";
  page.sandbox.location.href = ORIGIN + "/inventory.html";
  await page.boot();
  await settle(5);
  page.ui.toasts.length = 0;
  return page;
}
function edit(G, note) {
  G.state.settings.someNote = note || "x" + Math.random();
  G.persist("edit");
}
const link = (href, extra) => Object.assign({
  tagName: "A", href: new URL(href, ORIGIN + "/inventory.html").href, target: "", attrs: {},
  hasAttribute(k) { return k in this.attrs; },
  closest(sel) { return sel === "a[href]" ? this : null; }
}, extra || {});
const click = (page, a, props) => page.dispatch("click", Object.assign({ target: a }, props || {}));
const puts = page => page.net.filter(r => r.url === "/api/collection" && r.method === "PUT");
const writes = page => page.net.filter(r => r.method !== "GET").map(r => r.method + " " + r.url);
const lastToast = page => page.ui.toasts[page.ui.toasts.length - 1] || "";

/* ---------------- #174: links and UI.go ---------------- */

test("#174: a link clicked within the autosave delay waits for the save, then opens", async () => {
  let release;
  const page = await open({ put: () => new Promise(r => { release = r; }) });
  edit(page.G);
  const ev = click(page, link("/receive.html"));
  assert.equal(ev.defaultPrevented, true, "the browser doesn't leave yet");
  await settle(5);
  assert.equal(puts(page).length, 1, "the save went at once, not after the debounce");
  assert.equal(page.sandbox.location.href, ORIGIN + "/inventory.html", "still here while it saves");
  assert.match(lastToast(page), /Saving your changes before leaving/);
  release({ rev: 2, savedAt: "2026-10-10T00:00:00Z" });
  await settle(150);
  assert.equal(page.sandbox.location.href, ORIGIN + "/receive.html");
  assert.equal(page.dispatchWindow("beforeunload").defaultPrevented, false, "nothing left for the browser to ask about");
});

test("#174: a link whose save fails keeps you on the page and says why", async () => {
  const page = await open({ put: () => ({ __status: 500, error: "disk full" }) });
  edit(page.G);
  const ev = click(page, link("/receive.html"));
  assert.equal(ev.defaultPrevented, true);
  await settle(150);
  assert.equal(page.sandbox.location.href, ORIGIN + "/inventory.html", "didn't leave");
  assert.match(lastToast(page), /haven't saved yet \(disk full\), so you're still on this page/);
  assert.equal(page.G.hasUnsaved(), true);
});

test("#174: with nothing unsaved a link is left to the browser", async () => {
  const page = await open();
  const ev = click(page, link("/receive.html"));
  assert.equal(ev.defaultPrevented, false);
  assert.equal(puts(page).length, 0);
});

test("#174: new-tab clicks, downloads, #sections of this page and other sites are never held up", async () => {
  const page = await open({ put: () => new Promise(() => {}) });
  edit(page.G);
  const cases = [
    [link("/receive.html"), { ctrlKey: true }],
    [link("/receive.html"), { metaKey: true }],
    [link("/receive.html"), { button: 1 }],
    [link("/receive.html", { target: "_blank" })],
    [link("/api/export.csv", { attrs: { download: "" } })],
    [link("#support")],
    [link("https://scryfall.com/card/neo/1")],
    [link("mailto:help@example.com")],
    [Object.assign(link("/receive.html"), { href: { baseVal: "/receive.html" } })]   // an SVG <a>
  ];
  for (const [a, props] of cases) {
    const ev = click(page, a, props);
    assert.equal(ev.defaultPrevented, false, a.href + " " + JSON.stringify(props || {}));
  }
  assert.equal(click(page, link("/receive.html"), { defaultPrevented: true }).defaultPrevented, true,
    "a page's own handler that already took the click is left alone");
  await settle(5);
  assert.equal(puts(page).length, 0, "none of those started a save");
});

test("#174: a button that opens another page (UI.go) saves first too", async () => {
  const page = await open();
  edit(page.G);
  const went = await page.sandbox.UI.go("/admin.html");
  assert.equal(went, true);
  assert.equal(puts(page).length, 1);
  assert.equal(page.sandbox.location.href, "/admin.html");
});

test("#174: clicking a second link while saving goes to the last one, with one save", async () => {
  let release;
  const page = await open({ put: () => new Promise(r => { release = r; }) });
  edit(page.G);
  click(page, link("/receive.html"));
  click(page, link("/putaway.html"));
  await settle(5);
  release({ rev: 2, savedAt: "2026-10-10T00:00:00Z" });
  await settle(150);
  assert.equal(puts(page).length, 1);
  assert.equal(page.sandbox.location.href, ORIGIN + "/putaway.html");
});

/* ---------------- #176: Sign out ---------------- */

test("#176: Sign out with a save that fails asks first, and Cancel stays signed in", async () => {
  const page = await open({ put: () => ({ __status: 503, error: "server restarting" }) });
  edit(page.G);
  const out = page.$("btnSignOut").onclick();
  await settle(150);
  assert.equal(typeof page.$("confirmOkBtn").onclick, "function", "the 'Sign out anyway?' confirm is showing");
  assert.ok(!writes(page).includes("POST /api/auth/logout"), "not signed out while it asks");
  page.$("confirmCancelBtn").onclick();
  await out;
  assert.ok(!writes(page).includes("POST /api/auth/logout"));
  assert.equal(page.sandbox.location.href, ORIGIN + "/inventory.html");
});

test("#176: Sign out anyway signs out, and the browser doesn't ask a second time", async () => {
  const page = await open({ put: () => ({ __status: 503, error: "server restarting" }) });
  edit(page.G);
  const out = page.$("btnSignOut").onclick();
  await settle(150);
  page.$("confirmOkBtn").onclick();
  await out;
  assert.ok(writes(page).includes("POST /api/auth/logout"));
  assert.equal(page.sandbox.location.href, "/login.html");
  assert.equal(page.dispatchWindow("beforeunload").defaultPrevented, false, "no second Leave site? prompt");
});

test("#176: Sign out saves the last edit first, then signs out, with no question", async () => {
  const page = await open();
  edit(page.G);
  await page.$("btnSignOut").onclick();
  assert.deepEqual(writes(page), ["PUT /api/collection", "POST /api/auth/logout"]);
  assert.equal(page.$("confirmOkBtn").onclick, undefined, "no confirm");
  assert.equal(page.sandbox.location.href, "/login.html");
});

/* ---------------- #145 client half: the store switcher ---------------- */

test("#145: switching stores with a save that fails doesn't switch, and says why", async () => {
  const page = await open({ org: true, put: () => ({ __status: 500, error: "disk full" }) });
  edit(page.G);
  const sel = page.$("storeSwitcherSelect");
  sel.value = "B";
  await sel.fire("change");
  assert.ok(!writes(page).includes("POST /api/store/switch"), "the session stays on Store A");
  assert.equal(page.sandbox.location.reloads, 0);
  assert.match(lastToast(page), /haven't saved yet \(disk full\), so the store wasn't switched/);
  assert.equal(sel.value, "A", "the menu shows the store you're still in");
  assert.equal(sel.disabled, false);
});

test("#145: switching stores saves Store A's edit first, then switches and reloads with nothing left to save", async () => {
  const page = await open({ org: true });
  edit(page.G);
  const sel = page.$("storeSwitcherSelect");
  sel.value = "B";
  await sel.fire("change");
  assert.deepEqual(writes(page), ["PUT /api/collection", "POST /api/store/switch"], "saved before the switch");
  assert.equal(page.sandbox.location.reloads, 1);
  // Held from the switch on: nothing from this page may save into Store B.
  edit(page.G);
  await page.fireWindow("pagehide");
  await settle(1700);
  assert.deepEqual(writes(page), ["PUT /api/collection", "POST /api/store/switch"]);
});

test("#145: an edit made during the switch puts the session back on Store A and stays", async () => {
  let page;
  page = await open({ org: true, switchAnswer: body => { if (body.storeId === "B") edit(page.G, "during"); return { ok: true }; } });
  const sel = page.$("storeSwitcherSelect");
  sel.value = "B";
  await sel.fire("change");
  assert.deepEqual(writes(page), ["POST /api/store/switch", "POST /api/store/switch"]);
  assert.deepEqual(page.net.filter(r => r.url === "/api/store/switch").map(r => r.body.storeId), ["B", "A"]);
  assert.equal(page.sandbox.location.reloads, 0);
  assert.match(lastToast(page), /still in this store/);
  // Released again, so the edit saves into Store A.
  assert.equal(await page.G.saveAll(), true);
  assert.equal(puts(page).length, 1);
});

/* ---------------- #145 server half: the refusal ---------------- */

test("#145: a save refused because the session moved to another store says reload, with no Keep mine; a link then says it again", async () => {
  const msg = "This tab was showing Store A, but you have switched to a different store since (maybe in another tab), so your latest change here was not saved. Reload to continue.";
  const page = await open({ org: true, put: () => ({ __status: 409, error: msg, wrongOwner: true }) });
  edit(page.G);
  await page.G.saveNow();
  assert.equal(lastToast(page), msg);
  const labels = page.$("toastDetail").children.map(c => c.textContent).filter(Boolean);
  assert.deepEqual(labels, ["Reload"], "Reload, never Keep mine (that would write Store A over Store B)");
  page.ui.toasts.length = 0;
  click(page, link("/receive.html"));
  await settle(20);
  assert.equal(page.sandbox.location.href, ORIGIN + "/inventory.html", "didn't leave");
  assert.equal(lastToast(page), msg, "the same message again, not 'try again once it says Saved'");
  assert.equal(puts(page).length, 1, "nothing more sent");
  // Reload: no second "Leave site?" question, since nothing here can be saved.
  const reload = page.$("toastDetail").children.find(c => c.textContent === "Reload");
  await reload.onclick();
  assert.equal(page.sandbox.location.reloads, 1);
  assert.equal(page.dispatchWindow("beforeunload").defaultPrevented, false);
});

test("#146: Back into a switched-away page restored from the browser's cache reloads it", async () => {
  const page = await open({ org: true });
  const sel = page.$("storeSwitcherSelect");
  sel.value = "B";
  await sel.fire("change");
  assert.equal(page.sandbox.location.reloads, 1);
  // A normal page show does nothing more; a restore from the cache reloads.
  page.dispatchWindow("pageshow", { persisted: false });
  assert.equal(page.sandbox.location.reloads, 1);
  page.dispatchWindow("pageshow", { persisted: true });
  assert.equal(page.sandbox.location.reloads, 2);
});

test("#146/#433: a cache restore reloads even when the switch failed: every restored page does", async () => {
  const page = await open({ org: true, switchAnswer: () => { throw new Error("nope"); } });
  const sel = page.$("storeSwitcherSelect");
  sel.value = "B";
  await sel.fire("change");
  assert.equal(page.sandbox.location.reloads, 0);
  page.dispatchWindow("pageshow", { persisted: true });
  assert.equal(page.sandbox.location.reloads, 1, "a page from the back/forward cache never shows stale (#433: a kiosk device)");
});
