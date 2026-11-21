"use strict";
/* public/js/core.js - saving everything before the session moves to another
   store (#139, PR #144 review). Opening a notification about Store B from a
   Store A page must not let any of A's edits save after the switch: a PUT
   names no owner, so the server would put it into B. G.saveAll() saves the
   document and audit entries and says whether it landed; G.holdSaves(true)
   stops every later save, beforeunload's keepalive flush included. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* A fake server recording every write. opts.putStatus: what PUT
   /api/collection answers; opts.putDelay: ms before it answers. */
function fakeServer(opts) {
  const o = opts || {};
  const writes = [];
  let rev = 1;
  const fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    if (method !== "GET") writes.push(method + " " + url + (init && init.keepalive ? " keepalive" : ""));
    // personalPrefs already set (#159), so load() has nothing to seed and
    // every write below is one the test made.
    if (url === "/api/auth/me") return json(200, { user: { id: "u1", username: "m", orgId: "o1", orgRole: "manager" },
      personalPrefs: { simpleMode: false, chime: true, chimeMin: 20 } });
    if (url === "/api/collection" && method === "GET") return json(200, { rev, savedAt: null, state: null });
    if (url === "/api/collection" && method === "PUT") {
      if (o.putDelay) await new Promise(r => setTimeout(r, o.putDelay));
      if (o.putStatus && o.putStatus !== 200) return json(o.putStatus, { error: "nope", serverRev: rev });
      rev++;
      return json(200, { rev, savedAt: new Date().toISOString() });
    }
    if (url.startsWith("/api/audit") && method === "POST") return json(200, { ok: true });
    return json(200, {});
  };
  return { fetch, writes };
}

async function loaded(opts) {
  const srv = fakeServer(opts);
  const listeners = {};
  const G = freshCore({ fetch: srv.fetch, addEventListener: (type, fn) => { listeners[type] = fn; } });
  await G.load();
  const unload = () => {
    const e = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: undefined };
    listeners.beforeunload(e);
    return e;
  };
  return { G, srv, unload };
}

function edit(G) {
  G.state.settings.someNote = "x" + Math.random();
  G.logAudit({ action: "edit", note: "an edit" });
  G.persist("edit");
}

test("saveAll saves a pending edit and its audit entries, and then beforeunload has nothing to send", async () => {
  const { G, srv, unload } = await loaded();
  edit(G);
  assert.equal(G.hasUnsaved(), true);
  assert.equal(await G.saveAll(), true);
  assert.equal(G.hasUnsaved(), false);
  assert.ok(srv.writes.includes("PUT /api/collection"));
  assert.ok(srv.writes.includes("POST /api/audit"));
  const before = srv.writes.length;
  const e = unload();
  assert.equal(srv.writes.length, before, "no keepalive PUT or audit POST after a save that landed");
  assert.equal(e.prevented, false, "no Leave site? prompt either");
});

test("saveAll waits out a save already in flight, then saves what changed meanwhile", async () => {
  const { G, srv } = await loaded({ putDelay: 40 });
  edit(G);
  const first = G.saveNow();           // in flight
  edit(G);                             // changed while it was in the air
  assert.equal(await G.saveAll(), true);
  await first;
  assert.equal(srv.writes.filter(w => w === "PUT /api/collection").length, 2);
  assert.equal(G.hasUnsaved(), false);
});

test("a save that fails (or conflicts) makes saveAll say no, so nothing is opened", async () => {
  for (const status of [500, 409]) {
    const { G } = await loaded({ putStatus: status });
    edit(G);
    assert.equal(await G.saveAll(), false, String(status));
    assert.equal(G.hasUnsaved(), true);
  }
});

test("nothing to save: saveAll is true at once and sends no PUT", async () => {
  const { G, srv } = await loaded();
  assert.equal(await G.saveAll(), true);
  assert.deepEqual(srv.writes, []);
});

test("held: no autosave, no saveNow and no beforeunload flush reaches the server; an edit while held still warns", async () => {
  const { G, srv, unload } = await loaded();
  G.holdSaves(true);
  edit(G);
  await G.saveNow();
  await new Promise(r => setTimeout(r, 1700)); // past the 1.5 s autosave debounce
  assert.deepEqual(srv.writes, [], "the session may already point at another store");
  assert.equal(G.hasUnsaved(), true, "the page can tell something changed while held");
  const e = unload();
  assert.deepEqual(srv.writes, [], "no keepalive PUT into the other store");
  assert.equal(e.prevented, true, "the browser still warns before leaving");
  // Released (the switch failed or was undone): saving resumes.
  G.holdSaves(false);
  assert.equal(await G.saveAll(), true);
  assert.ok(srv.writes.includes("PUT /api/collection"));
});
