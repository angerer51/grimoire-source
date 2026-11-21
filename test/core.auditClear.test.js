"use strict";
/* Clearing the activity log from the browser side (#76): who may, and that
   a refused or failed clear never throws away entries that were logged but
   not yet sent. The server's own 403 is covered by hasOrgRole in
   auth.test.js; this is core.js's half. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// A fake server: signs in as `user`, answers the audit routes, and records
// every DELETE /api/audit. `deleteStatus` is what the clear gets back.
function fakeServer(user, deleteStatus) {
  const calls = [];
  const fetch = async (url, o) => {
    const method = (o && o.method) || "GET";
    calls.push(method + " " + url);
    if (url === "/api/auth/me") return json(200, { user });
    if (url === "/api/collection") return json(200, { rev: 0, savedAt: null, state: null });
    if (url.startsWith("/api/audit") && method === "DELETE") {
      return deleteStatus === 200 ? json(200, { ok: true }) : json(deleteStatus, { error: "nope" });
    }
    if (url.startsWith("/api/audit")) return json(200, { entries: [], total: 0 });
    return json(200, {});
  };
  return { fetch, calls };
}

async function loadedCore(user, deleteStatus) {
  const srv = fakeServer(user, deleteStatus);
  const G = freshCore({ fetch: srv.fetch });
  await G.load();
  return { G, srv };
}

test("canClearAuditLog: store staff may not clear the shared log; managers, owners and personal accounts may", async () => {
  const who = [
    [{ id: "u1", username: "s", orgId: "o1", orgRole: "staff" }, false],
    [{ id: "u2", username: "m", orgId: "o1", orgRole: "manager" }, true],
    [{ id: "u3", username: "o", orgId: "o1", orgRole: "owner" }, true],
    [{ id: "u4", username: "p", orgId: null, orgRole: null }, true]
  ];
  for (const [user, can] of who) {
    const { G } = await loadedCore(user, 200);
    assert.equal(G.canClearAuditLog(), can, user.username + " (" + (user.orgRole || "personal") + ")");
  }
});

test("clearAuditLog: a refused clear (403) keeps unsent entries queued instead of silently dropping them", async () => {
  const { G } = await loadedCore({ id: "u1", username: "s", orgId: "o1", orgRole: "staff" }, 403);
  G.logAudit({ action: "edit", note: "logged just before the clear" });
  await assert.rejects(G.clearAuditLog());
  const after = await G.queryAudit({});
  assert.equal(after.total, 1, "the unsent entry is still there to flush");
  assert.equal(after.entries[0].note, "logged just before the clear");
});

test("clearAuditLog: a successful clear drops the unsent entries too, so they don't reappear after it", async () => {
  const { G } = await loadedCore({ id: "u2", username: "m", orgId: "o1", orgRole: "manager" }, 200);
  G.logAudit({ action: "edit", note: "cleared along with the rest" });
  await G.clearAuditLog();
  assert.equal((await G.queryAudit({})).total, 0);
});
