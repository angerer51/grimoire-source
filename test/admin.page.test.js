"use strict";
/* The Admin dashboard through its real script (public/admin.page.js) with
   the page-shim's stand-in DOM. Not a browser.
   #164: date columns sort by real time (data-v), the Status column always
   shows the state (an admin's Disable/Enable sits with the row actions),
   the admin's role <select> is labelled and sorts on its chosen role.
   #165: the moderator note says what a moderator can do. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const CREATED = "2026-03-04T10:00:00Z";
const UPDATED = "2026-10-09T15:04:12Z";
const SEEN = Date.parse("2026-10-10T08:00:00Z");
const BOB = { id: "u2", username: "bob", displayName: "Bob", role: "user", disabled: false, hasEmail: true,
  canManage: true, createdAt: CREATED, presence: { onlineNow: false, lastSeenAt: SEEN } };
const NEVER = Object.assign({}, BOB, { id: "u3", username: "eve", disabled: true, presence: null });

async function open(role, extra) {
  const routes = (url, init) => {
    const method = (init && init.method) || "GET";
    const hit = extra && extra(url, method);
    if (hit) return hit;
    if (url === "/api/auth/me") return { user: { id: "u1", username: "boss", role, createdAt: "2026-01-01" } };
    if (url === "/api/collection" && method === "GET") return { rev: 1, savedAt: null, state: { cards: [], locations: [] } };
    if (url.startsWith("/api/admin/users?")) return { users: [BOB, NEVER], total: 2, page: 1 };
    if (url.startsWith("/api/admin/tickets?")) {
      return { tickets: [{ id: "t1", subject: "Help", createdByUsername: "bob", category: "support", status: "open", updatedAt: UPDATED }], total: 1, page: 1 };
    }
    if (url === "/api/admin/status") {
      return { users: [], cards: { count: 0 }, prices: { snapshots: 0 }, memoryMB: 1, uptimeMin: 1, node: "v22", dataDir: "/d", invites: [] };
    }
    if (url === "/api/meta") return { restart: null };
    return {};
  };
  const page = loadPage("admin.page.js", { routes });
  await page.G.load();
  await page.boot();
  await settle(5);
  return page;
}
const cells = tr => tr.innerHTML.split("</td>");

test("#164: an admin's account rows: dates sort by epoch, state pill, Disable among the actions, labelled role", async () => {
  const page = await open("admin");
  const [bob, eve] = page.$("userBody").children;
  const c = cells(bob);
  assert.match(c[2], /<td data-vs="user"><select data-r="role" aria-label="Role for bob">/);
  assert.match(c[3], /<span class="pill on">active<\/span>/, "Status shows the state");
  assert.doesNotMatch(c[3], /<button/, "no button in the Status column");
  assert.ok(c[5].includes('data-v="' + SEEN + '"'), "Last active sorts on lastSeenAt");
  assert.ok(c[6].includes('data-v="' + Date.parse(CREATED) + '"'), "Created sorts on its epoch");
  assert.match(c[7], /data-r="toggleDisabled">Disable</);
  assert.match(cells(eve)[3], /disabled<\/span>/);
  assert.match(cells(eve)[7], />Enable</);
  assert.ok(cells(eve)[5].includes('data-v=""'), "never seen sorts as empty");
});

test("#164: the support ticket list's Updated sorts by epoch", async () => {
  const page = await open("moderator");
  const row = page.$("ticketBody").children[0];
  assert.ok(row.innerHTML.includes('data-v="' + Date.parse(UPDATED) + '"'), row.innerHTML);
});

test("#164/#165: a moderator sees state pills, no controls, and a note saying what they can do", async () => {
  const page = await open("moderator");
  const c = cells(page.$("userBody").children[0]);
  assert.match(c[2], /<td><span class="pill">user<\/span>/);
  assert.match(c[3], /active/);
  assert.doesNotMatch(c[7], /toggleDisabled/);
  assert.match(page.$("roleNote").textContent, /answer support tickets/);
  assert.match(page.$("roleNote").textContent, /for administrators/);
});

/* #238: Admin -> Invites -> Invite requests. */
const REQ = { id: "rq1", kind: "personal", name: "<Ann>", email: "ann@example.com", note: "hi", status: "open",
  createdAt: CREATED, hasAccount: false, inviteState: null, inviteUrl: null };
const SENT = Object.assign({}, REQ, { id: "rq2", name: "Bea", status: "sent", emailed: false, sentAt: UPDATED,
  inviteCode: "c0de", inviteState: "open", inviteUrl: "/login.html?invite=c0de" });
const BIZ = Object.assign({}, REQ, { id: "rq3", name: "Shop", kind: "business" });

test("#238: waiting requests are listed with a count on the tab, and the no-email note shows", async () => {
  const page = await open("admin", (url, method) =>
    url === "/api/admin/invite-requests" && method === "GET" ? { emailConfigured: false, requests: [REQ, SENT, BIZ] } : null);
  assert.equal(page.$("requestsSection").hidden, false);
  assert.equal(page.$("requestsBadge").textContent, "2");
  assert.equal(page.$("requestsBadge").hidden, false);
  assert.equal(page.$("requestEmailNote").hidden, false);
  const html = page.$("requestBody").innerHTML;
  assert.ok(html.includes("&lt;Ann&gt;") && !html.includes("<Ann>"), "names are escaped");
  assert.match(html, /data-rq-send="rq1"/);
  assert.match(html, /data-rq-dismiss="rq1"/);
  assert.doesNotMatch(html, /rq2/, "Waiting hides a sent request");
  assert.match(html, /<span class="pill type">business<\/span>/, "a business request (#249) is tagged");
  page.$("requestShow").value = "all";
  await page.$("requestShow").fire("change");
  const all = page.$("requestBody").innerHTML;
  assert.match(all, /sent, not emailed/);
  assert.match(all, /data-rq-copy="rq2"/);
  assert.match(all, /data-rq-send="rq2"[^>]*>Send again/);
});

// The section starts hidden in the markup (the stand-in DOM doesn't model
// that); the route itself is admin-only server-side.
test("#238: a moderator's page never asks for invite requests", async () => {
  const page = await open("moderator");
  assert.equal(page.net.filter(r => r.url === "/api/admin/invite-requests").length, 0);
});

test("#238: Send invite without email shows the link to copy; Dismiss confirms first", async () => {
  const page = await open("admin", (url, method) => {
    if (url === "/api/admin/invite-requests" && method === "GET") return { emailConfigured: false, requests: [REQ] };
    if (url === "/api/admin/invite-requests/rq1/send") {
      return { emailed: false, emailConfigured: false, emailError: null, url: "https://g.example/login.html?invite=zz9" };
    }
    if (url === "/api/admin/invite-requests/rq1/dismiss") return { ok: true };
    return null;
  });
  const body = page.$("requestBody");
  const btn = attr => ({ disabled: false, hasAttribute: k => k === attr, getAttribute: k => (k === attr ? "rq1" : null) });
  // fire() targets the tbody itself; point its closest() at the button.
  body.closest = () => btn("data-rq-send");
  await body.fire("click");
  await settle(5);
  assert.ok(page.net.some(r => r.url === "/api/admin/invite-requests/rq1/send" && r.method === "POST"));
  const box = page.$("requestResult");
  assert.equal(box.hidden, false);
  assert.match(box.innerHTML, /Email isn't set up, so nothing was sent\./);
  assert.match(box.innerHTML, /value="https:\/\/g\.example\/login\.html\?invite=zz9"/);

  const opts = [];
  const stubConfirm = page.ui.confirmDialog;
  page.ui.confirmDialog = (msg, op) => { opts.push(op); return stubConfirm(msg, op); };
  body.closest = () => btn("data-rq-dismiss");
  await body.fire("click");
  await settle(5);
  assert.match(page.ui.confirms.at(-1), /^Dismiss the request from <Ann> \(ann@example\.com\)\?/);
  assert.equal(opts.at(-1).danger, true, "a dismissed request can't be brought back");
  assert.ok(page.net.some(r => r.url === "/api/admin/invite-requests/rq1/dismiss" && r.method === "POST"));
});

/* #249: business enquiries share the list, tagged business, with their
   shop and plans, and Mark handled instead of Send invite. */
const SHOP = Object.assign({}, REQ, { id: "rq4", kind: "business", name: "Sam", email: "sam@shop.example", note: undefined,
  shopName: "<Sam's> Cards", shopSize: "3 staff", plans: "Track stock" });
const DONE = Object.assign({}, SHOP, { id: "rq5", status: "handled", handledAt: UPDATED });

test("#249: a business enquiry shows its shop and plans, and offers Mark handled, not Send invite", async () => {
  const page = await open("admin", (url, method) => {
    if (url === "/api/admin/invite-requests" && method === "GET") return { emailConfigured: true, requests: [SHOP, DONE] };
    if (url === "/api/admin/invite-requests/rq4/handled") return { ok: true };
    return null;
  });
  const html = page.$("requestBody").innerHTML;
  assert.match(html, /<span class="pill type">business<\/span>/);
  assert.match(html, /&lt;Sam(&#39;|')s&gt; Cards · 3 staff/);
  assert.match(html, /Track stock/);
  assert.match(html, /data-rq-handled="rq4"[^>]*>.*Mark handled/);
  assert.match(html, /data-rq-dismiss="rq4"/);
  assert.doesNotMatch(html, /data-rq-send/);
  assert.doesNotMatch(html, /rq5/, "Waiting hides a handled enquiry");
  assert.equal(page.$("requestsBadge").textContent, "1");
  page.$("requestShow").value = "all";
  await page.$("requestShow").fire("change");
  assert.match(page.$("requestBody").innerHTML, /<span class="pill on"[^>]*>handled<\/span>/);

  const confirmsBefore = page.ui.confirms.length;
  const body = page.$("requestBody");
  body.closest = () => ({ disabled: false, hasAttribute: k => k === "data-rq-handled",
    getAttribute: k => (k === "data-rq-handled" ? "rq4" : null) });
  await body.fire("click");
  await settle(5);
  assert.ok(page.net.some(r => r.url === "/api/admin/invite-requests/rq4/handled" && r.method === "POST"));
  assert.equal(page.ui.confirms.length, confirmsBefore, "Mark handled doesn't confirm: nothing is lost");
});
