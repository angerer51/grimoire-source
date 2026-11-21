"use strict";
/* The Audit Log through its real script (public/audit-log.page.js) with the
   page-shim's stand-in DOM. Not a browser.
   #162: only the newest query draws (a slow "bol" can't land on "bolt"),
   a visit asks the server for the log once, not twice, and a failed Clear
   log says so instead of quietly redrawing.
   #164: When sorts by real time (data-v), rows that open a card are
   keyboard-reachable, and the action badges use no colours of their own. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const ENTRY = (id, name, ts) => ({ id, ts, action: "add", name, set: "lea", collector: "161", qty: 1 });

// answer(params) decides each /api/audit GET; DELETE answers `clear`.
async function open(answer, opts) {
  const o = opts || {};
  const routes = (url, init) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/auth/me") return { user: { id: "u1", username: "u", createdAt: "2026-01-01" } };
    if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state: { cards: [], locations: [] } };
    if (url.startsWith("/api/audit?")) return answer(new URL("http://x" + url).searchParams);
    if (url === "/api/audit" && method === "DELETE") return o.clear || { ok: true };
    return {};
  };
  const page = loadPage("audit-log.page.js", { routes });
  page.sandbox.localStorage = { getItem: () => null, setItem() {} };
  await page.G.load();
  await page.boot();
  await settle(5);
  return page;
}
const auditGets = page => page.net.filter(r => r.method === "GET" && r.url.startsWith("/api/audit?"));

test("#162: a visit queries the log once and the header uses that answer's total", async () => {
  const page = await open(() => ({ entries: [ENTRY("a1", "Bolt", "2026-10-09T15:04:12Z")], total: 1 }));
  assert.equal(auditGets(page).length, 1, "no second limit=0 query just for the header");
  assert.match(page.$("logHdr").textContent, /1 logged action/);
  // Switching tabs doesn't ask again either.
  await page.$("tabEvents").fire("click");
  await page.$("tabAudit").fire("click");
  await settle(5);
  assert.equal(auditGets(page).length, 2, "only the Activity redraw itself");
});

test("#162: an older, slower answer doesn't overwrite a newer filter's rows", async () => {
  const pending = {};
  const page = await open(p => {
    const q = p.get("q") || "";
    if (!q) return { entries: [], total: 0 };
    return new Promise(resolve => { pending[q] = resolve; });
  });
  page.$("auditSearch").value = "bol";
  page.$("auditAction").fire("change");
  page.$("auditSearch").value = "bolt";
  page.$("auditAction").fire("change");
  await settle(5);
  pending.bolt({ entries: [ENTRY("b2", "Bolt Newer", "2026-10-09T15:04:12Z")], total: 1 });
  await settle(5);
  pending.bol({ entries: [ENTRY("b1", "Bolas Older", "2026-10-08T15:04:12Z")], total: 1 });
  await settle(5);
  const html = page.$("auditBody").innerHTML;
  assert.match(html, /Bolt Newer/);
  assert.doesNotMatch(html, /Bolas Older/, "the stale \"bol\" answer was dropped");
  assert.match(page.$("logHdr").textContent, /0 logged actions/, "a filtered total isn't the header's total");
});

test("#162: a failed Clear log says so and leaves the log as it was", async () => {
  const page = await open(() => ({ entries: [ENTRY("a1", "Bolt", "2026-10-09T15:04:12Z")], total: 1 }),
    { clear: { __status: 403, error: "Only a store manager or owner can clear the log." } });
  const before = auditGets(page).length;
  await page.$("auditClear").fire("click");
  await settle(5);
  assert.ok(page.ui.toasts.some(t => /Couldn't clear the log: Only a store manager/.test(t)), page.ui.toasts.join(" | "));
  assert.equal(auditGets(page).length, before, "nothing redrawn, no extra whole-log query for the count");
  assert.equal(page.$("auditClear").disabled, false);
});

test("#162: a successful Clear log confirms and redraws", async () => {
  let cleared = false;
  const page = await open(() => cleared ? { entries: [], total: 0 }
    : { entries: [ENTRY("a1", "Bolt", "2026-10-09T15:04:12Z")], total: 1 });
  page.net.length = 0;
  const clearing = page.$("auditClear").fire("click");
  cleared = true;
  await clearing;
  await settle(5);
  assert.ok(page.net.some(r => r.method === "DELETE" && r.url === "/api/audit"));
  assert.ok(page.ui.toasts.includes("Activity log cleared."));
  assert.match(page.$("logHdr").textContent, /0 logged actions/);
});

test("#164: When sorts on epoch ms, card rows take the keyboard, badges are neutral", async () => {
  const ts = "2026-10-09T15:04:12Z";
  const page = await open(() => ({ entries: [ENTRY("a1", "Bolt", ts),
    { id: "a2", ts, action: "delete", note: "Collection erased" }], total: 2 }));
  const html = page.$("auditBody").innerHTML;
  assert.ok(html.includes('data-v="' + Date.parse(ts) + '"'), "When carries data-v");
  assert.match(html, /<tr class="click" tabindex="0">/, "a card row is focusable");
  assert.match(html, /<tr><td><\/td>/, "an entry with no card isn't");
  assert.doesNotMatch(html, /style="background/, "no hard-coded badge colours");
  assert.match(html, /class="badge non">ADD</);
  assert.match(html, /class="badge neg">DELETE</);
});
