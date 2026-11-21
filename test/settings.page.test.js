"use strict";
/* Settings through its real script (public/settings.page.js) with the
   page-shim's stand-in DOM. Not a browser.
   #159: in a store, Staff don't get Erase, Replace import or Restore, and
   see the Store defaults read-only; their Simple mode / chime go to their
   own account. Managers keep everything. Personal accounts are unchanged.
   #157: Erase sends its save flagged archive: true.
   #162: Sign out of every device only leaves the page once it worked.
   #176: it, and the Simple mode reload, wait for the save (G.saveAll), so a
   failed one is noticed instead of leaving anyway.
   #164: the revision list's Saved column sorts by real time. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

let signoutAnswer = { ok: true, sessions: 2 };
let putAnswer = { rev: 4, savedAt: "2026-10-10T00:00:00Z" };
function routesFor(me) {
  return (url, init, body) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/auth/me") return me;
    if (url === "/api/collection" && method === "GET") {
      return { rev: 3, savedAt: null, state: { cards: [{ id: "c1", quantity: 2, locationId: "l1" }], locations: [{ id: "l1", name: "Bin" }],
        settings: { simpleMode: false, defaultCondition: "LP" } } };
    }
    if (url === "/api/collection" && method === "PUT") return putAnswer;
    if (url === "/api/collection/revisions") return { revisions: [{ rev: 2, savedAt: "2026-10-09T00:00:00Z", stacks: 1, cards: 2, locations: 1 }] };
    if (url === "/api/orgs/mine") return { stores: [{ id: "st1", name: "Main Street" }], activeStoreId: "st1" };
    if (url === "/api/notifications/settings") return { groups: [] };
    if (url === "/api/integrations") return { manapool: {}, pitneyBowes: {} };
    if (url === "/api/prefs/personal") return { personalPrefs: body };
    if (url === "/api/auth/signout-everywhere") return signoutAnswer;
    return {};
  };
}
const ME = (orgRole, prefs) => ({
  user: { id: "u1", username: "u", createdAt: "2026-01-01", orgId: orgRole ? "o1" : null, orgRole: orgRole || null },
  personalPrefs: orgRole ? (prefs || { simpleMode: false, chime: true, chimeMin: 20 }) : null
});

async function open(orgRole, routes) {
  const page = loadPage("settings.page.js", { routes: routes || routesFor(ME(orgRole)) });
  page.reloads = 0;
  page.sandbox.location.reload = () => { page.reloads++; };
  await page.G.load();
  await page.boot();
  await settle(5);
  return page;
}
const restoreButton = tr => {
  for (const td of tr.children) for (const b of td.children || []) if (b.textContent === "Restore") return b;
  return null;
};
const restoreButtons = page => page.$("revBody").children.filter(restoreButton);

test("#159: Staff in a store: no Danger zone, no Replace, no Restore; Store defaults read-only", async () => {
  const page = await open("staff");
  assert.equal(page.$("dangerZone").hidden, true);
  assert.equal(page.$("revStaffNote").hidden, false);
  assert.ok(!/value="replace"/.test(page.$("legMode").innerHTML), "Replace isn't offered");
  assert.equal(page.$("revBody").children.length, 1, "the revision is still listed");
  assert.equal(restoreButtons(page).length, 0, "but without a Restore button");
  for (const id of ["prefAutoPut", "prefAlloc", "prefCondition", "prefMovers", "prefCycleSize", "prefCycleThreshold"]) {
    assert.equal(page.$(id).disabled, true, id + " is read-only");
  }
  assert.equal(page.$("prefSimpleMode").disabled, false, "their own Simple mode stays editable");
  assert.match(page.$("prefStoreHint").textContent, /Main Street.*Only a store manager or owner/);
});

test("#159: Staff ticking Simple mode saves it to their own account, not the store's document", async () => {
  const page = await open("staff");
  page.$("prefSimpleMode").checked = true;
  page.$("prefCondition").value = "DMG";
  await page.$("prefCondition").fire("change");
  await page.$("prefSimpleMode").fire("change");
  await settle(5);
  const post = page.net.find(r => r.url === "/api/prefs/personal");
  assert.equal(post.body.simpleMode, true);
  assert.equal(page.G.state.settings.simpleMode, false, "the store's copy is untouched");
  assert.equal(page.G.state.settings.defaultCondition, "LP", "a Staff change to a store default isn't applied");
  assert.equal(page.reloads, 1, "the page reloads to show or hide the advanced pages");
});

test("#159: a store manager keeps Erase, Replace and Restore, and can change the Store defaults", async () => {
  const page = await open("manager");
  assert.equal(page.$("dangerZone").hidden, false);
  assert.equal(restoreButtons(page).length, 1);
  assert.equal(page.$("prefCondition").disabled, false);
  assert.match(page.$("prefStoreHint").textContent, /changes it for all of them/);
});

test("#159: a personal account's Settings are as before", async () => {
  const page = await open(null);
  assert.equal(page.$("dangerZone").hidden, false);
  assert.notEqual(page.$("prefGeneralHead").textContent, "Just for you", "no store split");
  assert.equal(page.$("prefCondition").disabled, false);
  assert.equal(restoreButtons(page).length, 1);
  assert.ok(!page.net.some(r => r.url === "/api/orgs/mine"), "no store lookup");
  page.$("prefSimpleMode").checked = true;
  await page.$("prefSimpleMode").fire("change");
  await settle(5);
  assert.equal(page.G.state.settings.simpleMode, true, "saved in the collection document");
  assert.ok(!page.net.some(r => r.url === "/api/prefs/personal"));
});

test("#157: Erase sends its save flagged archive: true", async () => {
  const page = await open("manager");
  await page.$("wipe").fire("click");
  await settle(5);
  const put = page.net.find(r => r.url === "/api/collection" && r.method === "PUT");
  assert.ok(put, "the erase was saved");
  assert.equal(put.body.archive, true);
  assert.deepEqual(put.body.state.cards, []);
});

test("#162: Sign out of every device stays on the page and says so when it fails", async () => {
  signoutAnswer = { __status: 500, error: "disk full" };
  try {
    const page = await open(null);
    page.sandbox.location.href = "/settings.html";
    await page.$("signOutAll").fire("click");
    await settle(5);
    assert.ok(page.net.some(r => r.url === "/api/auth/signout-everywhere"));
    assert.equal(page.sandbox.location.href, "/settings.html", "not sent to the sign-in page");
    assert.match(page.$("acctStatus").textContent, /Couldn't sign out your other devices: disk full/);
    assert.equal(page.$("signOutAll").disabled, false, "the button works again for a retry");
  } finally { signoutAnswer = { ok: true, sessions: 2 }; }
});

test("#162: Sign out of every device goes to the sign-in page once it worked", async () => {
  const page = await open(null);
  await page.$("signOutAll").fire("click");
  await settle(5);
  assert.equal(page.sandbox.location.href, "/login.html");
});

test("#176: Sign out of every device with a save that fails asks first; Cancel stays", async () => {
  putAnswer = { __status: 500, error: "disk full" };
  try {
    const page = await open(null);
    page.sandbox.location.href = "/settings.html";
    page.G.state.settings.someNote = "unsaved";
    page.G.persist("edit");
    let n = 0;
    page.ui.confirmDialog = async msg => { page.ui.confirms.push(msg); return n++ === 0; }; // yes to "everywhere?", no to "anyway?"
    await page.$("signOutAll").fire("click");
    await settle(50);
    assert.match(page.ui.confirms[1] || "", /hasn't saved yet \(disk full\)\. Sign out anyway\?/);
    assert.ok(!page.net.some(r => r.url === "/api/auth/signout-everywhere"), "nobody signed out");
    assert.equal(page.sandbox.location.href, "/settings.html");
    assert.equal(page.$("signOutAll").disabled, false);
  } finally { putAnswer = { rev: 4, savedAt: "2026-10-10T00:00:00Z" }; }
});

test("#176: turning Simple mode on with a save that fails doesn't reload over it", async () => {
  putAnswer = { __status: 500, error: "disk full" };
  try {
    const page = await open(null);
    page.$("prefSimpleMode").checked = true;
    await page.$("prefSimpleMode").fire("change");
    await settle(50);
    assert.equal(page.reloads, 0);
    assert.match(page.$("prefPersonalStatus").textContent, /isn't saved yet \(disk full\)/);
  } finally { putAnswer = { rev: 4, savedAt: "2026-10-10T00:00:00Z" }; }
});

test("#176: turning Simple mode on saves it, then reloads", async () => {
  const page = await open(null);
  page.$("prefSimpleMode").checked = true;
  await page.$("prefSimpleMode").fire("change");
  await settle(50);
  assert.ok(page.net.some(r => r.url === "/api/collection" && r.method === "PUT" && r.body.state.settings.simpleMode === true));
  assert.equal(page.reloads, 1);
});

test("#164: the revision list's Saved cell carries the epoch for sorting", async () => {
  const page = await open(null);
  const row = page.$("revBody").children[0];
  assert.ok(row.innerHTML.includes('data-v="' + Date.parse("2026-10-09T00:00:00Z") + '"'), row.innerHTML);
});

/* #185: Restore and the revision list name the inventory the page loaded
   (GET /api/collection's `owner`), and a refusal for another store is the
   save path's: its message with Reload (the wrongowner event ui.js shows),
   not "Restore failed", and no reload behind the person's back. */
const WRONG = "This tab was showing Main Street, but you have switched to a different store since (maybe in another tab), so the revision was not restored. Reload to continue.";
function ownerRoutes(owner, answers) {
  const base = routesFor(ME("manager"));
  return (url, init, body) => {
    const method = (init && init.method) || "GET";
    if (url === "/api/collection" && method === "GET") return Object.assign(base(url, init, body), owner ? { owner } : {});
    if (url.startsWith("/api/collection/revisions")) {
      return answers.list ? answers.list(url) : base("/api/collection/revisions", init, body);
    }
    if (url === "/api/collection/restore") return answers.restore ? answers.restore(body) : { rev: 9, restoredFrom: body.rev };
    return base(url, init, body);
  };
}
async function clickRestore(page) {
  const btn = restoreButton(page.$("revBody").children[0]);
  assert.ok(btn, "a Restore button");
  await btn.fire("click");
  await settle(5);
}

test("#185: Restore and the revision list send the store this page loaded; a same-store restore reloads", async () => {
  const page = await open("manager", ownerRoutes("store:st1", {}));
  const list = page.net.find(r => r.url.startsWith("/api/collection/revisions"));
  assert.equal(list.url, "/api/collection/revisions?owner=store%3Ast1");
  await clickRestore(page);
  const post = page.net.find(r => r.url === "/api/collection/restore");
  assert.deepEqual(post.body, { rev: 2, owner: "store:st1" });
  assert.equal(page.reloads, 1);
});

test("#185: a restore refused for another store says so with Reload, not \"Restore failed\", and stops this page saving", async () => {
  const page = await open("manager", ownerRoutes("store:st1", { restore: () => ({ __status: 409, error: WRONG, wrongOwner: true }) }));
  const told = [];
  page.G.on("wrongowner", i => told.push(i.message));
  await clickRestore(page);
  assert.deepEqual(told, [WRONG]);
  assert.ok(!page.ui.toasts.some(t => /Restore failed/.test(t)), page.ui.toasts.join(" | "));
  assert.equal(page.reloads, 0);
  assert.equal(page.G.saveState().wrongOwner, true);
  // A second press says it again (the toast may have been closed).
  await clickRestore(page);
  assert.equal(told.length, 2);
});

test("#185: a revision list refused for another store shows the message, not another store's list", async () => {
  const msg = WRONG.replace("the revision was not restored", "the revision list can't be shown here");
  const page = await open("manager", ownerRoutes("store:st1", { list: () => ({ __status: 409, error: msg, wrongOwner: true }) }));
  assert.equal(page.$("revBody").children.length, 0, "no rows, so nothing to restore");
  assert.match(page.$("revBody").innerHTML, /can't be shown here/);
  assert.equal(page.G.saveState().wrongOwner, true);
});

test("#185: an ordinary restore failure still says Restore failed", async () => {
  const page = await open("manager", ownerRoutes("store:st1", { restore: () => ({ __status: 404, error: "No such revision." }) }));
  await clickRestore(page);
  assert.ok(page.ui.toasts.some(t => /Restore failed: No such revision\./.test(t)));
  assert.equal(page.G.saveState().wrongOwner, false);
});

test("#185: a server that names no owner: no owner is sent, as before", async () => {
  const page = await open("manager", ownerRoutes(null, {}));
  assert.ok(page.net.some(r => r.url === "/api/collection/revisions"));
  await clickRestore(page);
  assert.deepEqual(page.net.find(r => r.url === "/api/collection/restore").body, { rev: 2 });
});
