"use strict";
/* #159, PR #171 review: outside Settings, Receive (putaway checkbox, lot
   allocation) and Movers (window) also wrote Store defaults. For Staff the
   server keeps the old value, so the change quietly flipped back on the
   next load. These controls are now read-only for Staff, with a "set by
   your store's managers" note; managers and personal accounts unchanged.
   Real page scripts through test-lib/page-shim.js; not a browser. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

const ME = orgRole => ({
  user: { id: "u1", username: "u", createdAt: "2026-01-01", orgId: orgRole ? "o1" : null, orgRole: orgRole || null },
  personalPrefs: orgRole ? { simpleMode: false, chime: true, chimeMin: 20 } : null
});
const routes = orgRole => (url, init) => {
  const method = (init && init.method) || "GET";
  if (url === "/api/auth/me") return ME(orgRole);
  if (url === "/api/collection" && method === "GET") {
    return { rev: 1, savedAt: null, state: { cards: [], locations: [{ id: "l1", name: "Bin" }],
      settings: { autoPutaway: true, lotAllocation: "market", moversDays: 14 } } };
  }
  if (url.startsWith("/api/prices/movers")) return { fromDate: "2026-10-01", toDate: "2026-10-08", requestedDays: 14, rows: [] };
  if (url.startsWith("/api/prices/golden-cross")) {
    return { vendor: "tcg", days: 7, toDate: "2026-10-08", sinceDate: "2026-10-02", windowDays: 7, total: 0, ownedTotal: 0, shown: 0, best: [], rows: [] };
  }
  return {};
};

async function open(file, orgRole, scripts) {
  const pg = loadPage(file, { routes: routes(orgRole), scripts });
  // The notes start hidden in the HTML (the shim doesn't parse it).
  pg.$("autoPutawayStoreNote").hidden = pg.$("lotAllocStoreNote").hidden = true;
  await pg.G.load();
  await pg.boot();
  await settle(5);
  return pg;
}

for (const [role, locked] of [["staff", true], ["manager", false], [null, false]]) {
  const who = role || "personal account";

  test("Receive, " + who + ": putaway checkbox and lot allocation " + (locked ? "read-only" : "editable"), async () => {
    const pg = await open("receive.page.js", role);
    assert.equal(pg.$("autoPutaway").disabled, locked);
    assert.equal(pg.$("lotAlloc").disabled, locked);
    assert.equal(pg.$("autoPutawayStoreNote").hidden, !locked);
    assert.equal(pg.$("lotAllocStoreNote").hidden, !locked);
    // Even if the control fires, Staff don't change the store default.
    pg.$("autoPutaway").checked = false;
    await pg.$("autoPutaway").fire("change");
    assert.equal(pg.G.state.settings.autoPutaway, locked ? true : false);
  });

  test("Movers, " + who + ": window " + (locked ? "read-only and not saved as the default" : "editable and saved"), async () => {
    const pg = loadPage("movers.page.js", { routes: routes(role), scripts: ["js/moversPicks.js"] });
    pg.$("vendor").value = "tcg"; pg.$("exCategory").value = "valueUp"; pg.$("portDays").value = "90";
    pg.$("days").value = "14";
    pg.$("daysStoreNote").hidden = true; // as in the HTML
    await pg.G.load();
    await pg.boot();
    await settle(5);
    assert.equal(pg.$("days").disabled, locked);
    assert.equal(pg.$("daysStoreNote").hidden, !locked);
    pg.$("days").value = "90";
    await pg.$("btnReload").fire("click");
    await settle(5);
    assert.equal(pg.G.state.settings.moversDays, locked ? 14 : 90);
  });
}
