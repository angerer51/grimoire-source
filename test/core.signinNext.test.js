"use strict";
/* #248: being sent to sign in keeps the page's query string in ?next=, so
   /inventory.html?q=sol comes back to ?q=sol afterwards. login.page.js
   still checks next is on this site (#156; test/login.page.test.js). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCoreSandbox } = require("../test-lib/core-shim");

function signedOut(status) {
  const fetch = async url => {
    const body = url === "/api/auth/me" ? { user: null } : { rev: 1, state: {} };
    return { status, ok: status < 400, text: async () => JSON.stringify(body) };
  };
  const { G, sandbox } = freshCoreSandbox({ fetch });
  Object.assign(sandbox.location, { pathname: "/inventory.html", search: "?q=sol", hash: "", href: "" });
  return { G, sandbox };
}

test("#248: signed out at load: next keeps the query", async () => {
  const { G, sandbox } = signedOut(200);
  await G.load();
  assert.equal(sandbox.location.href, "/login.html?next=" + encodeURIComponent("/inventory.html?q=sol"));
});

test("#248: session expires mid-use (401): next keeps the query", async () => {
  const { G, sandbox } = signedOut(401);
  await assert.rejects(G.load());
  assert.equal(sandbox.location.href, "/login.html?next=" + encodeURIComponent("/inventory.html?q=sol"));
});
