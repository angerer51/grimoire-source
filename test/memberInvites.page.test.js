"use strict";
/* Member invites (#337) through the real page scripts with the page-shim's
   stand-in DOM. Not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, settle } = require("../test-lib/page-shim");

const OPEN = { code: "abc", status: "open", createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z", url: "/login.html?invite=abc" };
const JOINED = { code: "def", status: "joined", createdAt: "2026-09-20T00:00:00Z", expiresAt: "2026-10-20T00:00:00Z", username: "<nia>" };

async function social(mine) {
  const routes = (url, init) => {
    if (url === "/api/auth/me") return { user: { id: "u1", username: "ann", role: "user", createdAt: "2026-01-01" } };
    if (url === "/api/collection") return { rev: 1, savedAt: null, state: { cards: [], locations: [] } };
    if (url === "/api/member-invites" && !(init && init.method === "POST")) return mine;
    if (url === "/api/meta") return { restart: null };
    return {};
  };
  const page = loadPage("social.page.js", { scripts: ["js/tradeCompose.js"], routes });
  await page.G.load();
  await page.boot();
  await settle(5);
  return page;
}

test("Social shows what's left, an open link to copy and who joined, escaped", async () => {
  const page = await social({ enabled: true, allowance: 3, used: 1, open: 1, remaining: 1, signupsClosed: false, invites: [OPEN, JOINED] });
  assert.equal(page.$("inviteFriend").hidden, false);
  assert.match(page.$("inviteLeft").textContent, /1 of 3 left/);
  assert.equal(page.$("inviteMake").hidden, false);
  assert.equal(page.$("inviteMake").disabled, false);
  assert.equal(page.$("inviteOff").hidden, true);
  const html = page.$("inviteRows").innerHTML;
  assert.match(html, /data-invite-copy="[^"]*login\.html\?invite=abc"/);
  assert.match(html, /data-invite-cancel="abc"/);
  assert.match(html, /Joined as <b>&lt;nia&gt;<\/b>/);
  assert.equal((html.match(/data-invite-cancel/g) || []).length, 1, "only the open link can be cancelled");
});

test("Social: none left disables the button", async () => {
  const page = await social({ enabled: true, allowance: 3, used: 3, open: 0, remaining: 0, signupsClosed: false, invites: [] });
  assert.equal(page.$("inviteMake").disabled, true);
});

test("Social: turned off, the button goes and the notice says what happens to links", async () => {
  const page = await social({ enabled: false, allowance: 3, used: 0, open: 1, remaining: 2, signupsClosed: false, invites: [OPEN] });
  assert.equal(page.$("inviteMake").hidden, true);
  assert.equal(page.$("inviteOff").hidden, false);
  assert.match(page.$("inviteOffText").textContent, /turned off/);
});

async function admin(role, overview) {
  const calls = [];
  const routes = (url, init) => {
    calls.push(url);
    if (url === "/api/auth/me") return { user: { id: "u1", username: "boss", role, createdAt: "2026-01-01" } };
    if (url === "/api/collection") return { rev: 1, savedAt: null, state: { cards: [], locations: [] } };
    if (url.startsWith("/api/admin/users?")) return { users: [], total: 0, page: 1 };
    if (url.startsWith("/api/admin/tickets?")) return { tickets: [], total: 0, page: 1 };
    if (url === "/api/admin/status") return { users: [], cards: { count: 0 }, prices: { snapshots: 0 }, memoryMB: 1, uptimeMin: 1, node: "v22", dataDir: "/d",
      invites: [{ code: "abc", createdAt: "2026-10-01T00:00:00Z", createdByUsername: "ann", memberInvite: true, open: true }] };
    if (url === "/api/admin/member-invites") return overview;
    if (url === "/api/meta") return { restart: null };
    return {};
  };
  const page = loadPage("admin.page.js", { routes });
  await page.G.load();
  await page.boot();
  await settle(5);
  return { page, calls };
}

test("Admin shows the settings and who invited whom, and marks a member's code", async () => {
  const { page } = await admin("admin", { enabled: true, allowance: 3, maxAllowance: 100, people: [
    { username: "ann", displayName: "Ann", disabled: false, custom: 5, invited: [{ username: "nia", at: "2026-10-02" }], allowance: 5, used: 1, open: 1, remaining: 3 }
  ] });
  assert.equal(page.$("memberInvitesSection").hidden, false);
  assert.equal(page.$("miEnabled").checked, true);
  assert.equal(page.$("miAllowance").value, 3);
  const row = page.$("miBody").innerHTML;
  assert.match(row, /ann/);
  assert.match(row, /nia/);
  assert.match(row, />own</);
  assert.match(page.$("inviteBody").innerHTML, /ann <span class="pill type">member<\/span>/);
});

test("A moderator never asks for it and the section stays hidden", async () => {
  const { calls } = await admin("moderator", {});
  assert.equal(calls.includes("/api/admin/member-invites"), false);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
  assert.match(html, /id="memberInvitesSection" hidden/);
});
