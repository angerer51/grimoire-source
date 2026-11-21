"use strict";
/* public/js/core.js, client side of #157 and #159.
   #157: saveNow({ archive: true }) flags the save that carries an Erase or
   a Replace import, so the server keeps what it replaces; a flag set while
   another save is in the air must ride on the next PUT, not be lost.
   #159: Simple mode and the chime are per person. A personal account keeps
   them in its own document as before; an org member's live in their own
   account (/api/prefs/personal), never the Store's document, seeded once
   from the Store's old value so nobody's flips on the upgrade. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// me: the /api/auth/me answer; settings: the document's settings.
function fakeServer(me, settings, opts) {
  const o = opts || {};
  const sent = [];
  let rev = 1;
  const fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    if (method !== "GET") sent.push({ method, url, body });
    if (url === "/api/auth/me") return json(200, me);
    if (url === "/api/collection" && method === "GET") return json(200, { rev, savedAt: null, state: { cards: [], locations: [], settings } });
    if (url === "/api/collection" && method === "PUT") {
      if (o.putDelay) await new Promise(r => setTimeout(r, o.putDelay));
      rev++;
      return json(200, { rev, savedAt: new Date().toISOString() });
    }
    if (url === "/api/prefs/personal") return json(200, { personalPrefs: {} });
    return json(200, {});
  };
  return { fetch, sent };
}

const personalMe = { user: { id: "p1", username: "p", orgId: null, orgRole: null }, personalPrefs: null };
const staffMe = prefs => ({ user: { id: "s1", username: "s", orgId: "o1", orgRole: "staff" }, personalPrefs: prefs });
const settle = ms => new Promise(r => setTimeout(r, ms || 0));

test("#157: saveNow({ archive: true }) sends archive on that PUT only", async () => {
  const srv = fakeServer(personalMe, {});
  const G = freshCore({ fetch: srv.fetch });
  await G.load();
  G.state.cards = []; G.persist("Erase collection");
  await G.saveNow({ archive: true });
  G.state.settings.someNote = "x"; G.persist("edit");
  await G.saveNow();
  const puts = srv.sent.filter(r => r.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.archive, true);
  assert.equal(puts[1].body.archive, undefined, "an ordinary save after it isn't flagged");
});

test("#157: a flag set while another save is in the air rides on the next PUT", async () => {
  const srv = fakeServer(personalMe, {}, { putDelay: 50 });
  const G = freshCore({ fetch: srv.fetch });
  await G.load();
  G.state.settings.someNote = "a"; G.persist("edit");
  const first = G.saveNow();                 // in flight, unflagged
  G.state.cards = []; G.persist("Erase collection");
  await G.saveNow({ archive: true });        // returns at once: a save is already running
  await first;
  assert.equal(await G.saveAll(), true);
  const puts = srv.sent.filter(r => r.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.archive, undefined);
  assert.equal(puts[1].body.archive, true, "the Erase's save carried the flag");
});

test("#159: a personal account keeps Simple mode and the chime in its own document", async () => {
  const srv = fakeServer(personalMe, { simpleMode: true, chimeMin: 5 });
  const G = freshCore({ fetch: srv.fetch });
  await G.load();
  assert.equal(G.prefsInAccount, false);
  assert.equal(G.simpleMode, true);
  assert.equal(G.pref("chimeMin"), 5);
  await G.setPersonalPrefs({ simpleMode: false });
  assert.equal(G.state.settings.simpleMode, false, "written to the document, as before");
  assert.ok(!srv.sent.some(r => r.url === "/api/prefs/personal"));
  assert.equal(G.canManageStore(), true);
});

test("#159: Staff's Simple mode is their own: read from and saved to their account, never the Store's document", async () => {
  const srv = fakeServer(staffMe({ simpleMode: false, chime: true, chimeMin: 50 }), { simpleMode: true, chime: false, chimeMin: 1 });
  const G = freshCore({ fetch: srv.fetch });
  await G.load();
  assert.equal(G.prefsInAccount, true);
  assert.equal(G.simpleMode, false, "the person's value, not the Store's");
  assert.equal(G.pref("chimeMin"), 50);
  assert.ok(!srv.sent.some(r => r.url === "/api/prefs/personal"), "nothing to seed: every value already set");
  await G.setPersonalPrefs({ simpleMode: true });
  assert.equal(G.simpleMode, true);
  assert.equal(G.state.settings.simpleMode, true, "the Store's document copy is left as it was");
  const post = srv.sent.find(r => r.url === "/api/prefs/personal");
  assert.deepEqual(post.body, { simpleMode: true });
  assert.equal(G.canManageStore(), false);
});

test("#159: on the first load after the upgrade, a member's values are seeded from the Store's, without overwriting", async () => {
  const srv = fakeServer(staffMe({ chime: true }), { simpleMode: true, chime: false, chimeMin: 30 });
  const G = freshCore({ fetch: srv.fetch });
  await G.load();
  await settle();
  assert.equal(G.simpleMode, true, "the Store's Simple mode carries over: nobody's nav changes on the upgrade");
  assert.equal(G.pref("chime"), true, "a value the person already has wins");
  assert.equal(G.pref("chimeMin"), 30);
  const seed = srv.sent.find(r => r.url === "/api/prefs/personal");
  assert.deepEqual(seed.body, { onlyIfUnset: true, simpleMode: true, chimeMin: 30 });
});
