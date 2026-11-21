"use strict";
/* #328: Deck List's Add lines asks before a repeat paste doubles the whole list. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("../test-lib/page-shim");

test("#328: pasting the same list again asks before it doubles every card", async () => {
  const pg = loadPage("deck-list.page.js", { routes: () => ({}) });
  const G = pg.G;
  await pg.boot();
  G.state.deckList = [{ name: "Sol Ring", qty: 1 }, { name: "Arcane Signet", qty: 1 }, { name: "Command Tower", qty: 2 }];
  const asked = [];
  let answer = false;
  pg.ui.confirmDialog = async (msg, opts) => { asked.push({ msg, opts }); return answer; };
  const tower = () => G.state.deckList.find(x => x.name === "Command Tower").qty;
  const text = "1 Sol Ring\n1 Arcane Signet\n2 Command Tower";
  pg.$("deckPaste").value = text;
  await pg.$("deckAdd").fire("click");
  assert.equal(asked.length, 1);
  assert.match(asked[0].msg, /3 of 3\) are already on your deck list/);
  assert.equal(asked[0].opts.okLabel, "Add anyway");
  assert.equal(tower(), 2, "declined: nothing added");
  assert.equal(pg.$("deckPaste").value, text, "the paste box keeps its text");
  answer = true;
  await pg.$("deckAdd").fire("click");
  assert.equal(tower(), 4, "Add anyway doubles it");
  // A couple of new cards on a bigger list is not a repeat
  asked.length = 0;
  pg.$("deckPaste").value = "1 Sol Ring\n1 Mana Crypt\n1 Counterspell";
  await pg.$("deckAdd").fire("click");
  assert.equal(asked.length, 0);
});
