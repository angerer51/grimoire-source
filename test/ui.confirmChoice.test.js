"use strict";
/* UI.confirmDialog's optional second action (#309, Deck List's Build into
   a saved deck: add to its list or replace it). The real ui.js runs through
   the page shim (realUI). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../test-lib/page-shim");

async function ask(press, opts) {
  const page = loadPage(null, { realUI: true });
  const out = page.sandbox.UI.confirmDialog("Which way?", opts);
  await settle();
  page.$(press).onclick();
  return { page, answer: await out };
}

test("altLabel adds a second action that resolves \"alt\"; the main button and Cancel answer as before", async () => {
  const opts = { okLabel: "Add", altLabel: "Replace" };
  const alt = await ask("confirmAltBtn", opts);
  assert.equal(alt.answer, "alt");
  assert.match(alt.page.$("confirmModal").querySelector(".modal").innerHTML, /<button id="confirmAltBtn">Replace<\/button>/);
  assert.equal((await ask("confirmOkBtn", opts)).answer, true);
  assert.equal((await ask("confirmCancelBtn", opts)).answer, false);
});

test("without altLabel there is no second action", async () => {
  const { page, answer } = await ask("confirmOkBtn", {});
  assert.equal(answer, true);
  assert.doesNotMatch(page.$("confirmModal").querySelector(".modal").innerHTML, /confirmAltBtn/);
});
