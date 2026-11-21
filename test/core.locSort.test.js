"use strict";
/* A location's sorting method (#267): how the cards inside it physically
   sit. One comparator (G.locSortComparator) orders pick lists and Inventory
   (and Putaway placement later, #293), so they never disagree. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

// Cross-realm arrays (the sandbox's) compare by JSON.
const deq = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const order = (G, rows, method) => G.sortInLocationOrder(rows, method).map(r => r.id);
const asc = field => ({ field, dir: "asc" });
const desc = field => ({ field, dir: "desc" });

test("normalizeSortMethod: not set is null; unknown fields and repeats dropped; dir defaults to asc", () => {
  const G = freshCore();
  assert.equal(G.normalizeSortMethod(undefined), null);
  assert.equal(G.normalizeSortMethod(null), null);
  assert.equal(G.normalizeSortMethod([]), null);
  assert.equal(G.normalizeSortMethod("set"), null);
  assert.equal(G.normalizeSortMethod([{ field: "nope" }]), null);
  deq(G.normalizeSortMethod([{ field: "set" }, { field: "cmc", dir: "desc" }, { field: "set", dir: "desc" }, { field: "bogus" }]),
    [asc("set"), desc("cmc")]);
});

test("a location keeps its sorting method through save/load; one saved before #267 has none", () => {
  const G = freshCore();
  const l = G.newLocation({ id: "b1", name: "Binder", sortMethod: [asc("set"), asc("collector")] });
  const reloaded = G.newLocation(JSON.parse(JSON.stringify(l)));
  deq(reloaded.sortMethod, [asc("set"), asc("collector")]);
  const old = G.newLocation({ id: "b2", name: "Old binder", maxCards: 100 }); // no sortMethod key at all
  assert.equal(old.sortMethod, null);
  G.adoptState({ cards: [], locations: [JSON.parse(JSON.stringify(l)), { id: "b2", name: "Old" }] });
  deq(G.state.locations.map(x => x.sortMethod), [[asc("set"), asc("collector")], null]);
});

test("collector number: natural order 2 < 10 < 101a, then specials like ★", () => {
  const G = freshCore();
  const rows = ["101a", "★", "10", "2", "101", "S1", "1"].map(c => ({ id: c, collector: c }));
  const got = order(G, rows, [asc("collector")]);
  deq(got.slice(0, 5), ["1", "2", "10", "101", "101a"], "numbers first, in natural order");
  assert.ok(got.indexOf("★") > got.indexOf("101a") && got.indexOf("S1") > got.indexOf("101a"), "specials after the numbers");
  deq(order(G, rows, [desc("collector")]).slice(-5), ["101a", "101", "10", "2", "1"], "high to low reverses it");
});

test("color: W, U, B, R, G, multicolor, colorless, and the reverse; color identity reads its own field", () => {
  const G = freshCore();
  const rows = [
    { id: "C", colors: [] }, { id: "G", colors: ["G"] }, { id: "WU", colors: ["U", "W"] }, { id: "R", colors: ["R"] },
    { id: "W", colors: ["W"] }, { id: "B", colors: ["B"] }, { id: "U", colors: ["U"] }, { id: "WUB", colors: ["W", "U", "B"] },
    { id: "UB", colors: ["B", "U"] }
  ];
  deq(order(G, rows, [asc("color")]), ["W", "U", "B", "R", "G", "WU", "UB", "WUB", "C"],
    "multicolor grouped by combination, two-color before three");
  deq(order(G, rows, [desc("color")]), ["C", "WUB", "UB", "WU", "G", "R", "B", "U", "W"]);
  const ident = [{ id: "a", colors: [], colorIdentity: ["R"] }, { id: "b", colors: ["W"], colorIdentity: ["W"] }];
  deq(order(G, ident, [asc("colorIdentity")]), ["b", "a"]);
});

test("rarity common→mythic and back; finish, condition, mana value, price, release date, type, language", () => {
  const G = freshCore();
  const rar = ["mythic", "common", "rare", "uncommon"].map(r => ({ id: r, rarity: r }));
  deq(order(G, rar, [asc("rarity")]), ["common", "uncommon", "rare", "mythic"]);
  deq(order(G, rar, [desc("rarity")]), ["mythic", "rare", "uncommon", "common"]);
  const fin = ["etched", "nonfoil", "foil"].map(f => ({ id: f, finish: f }));
  deq(order(G, fin, [asc("finish")]), ["nonfoil", "foil", "etched"]);
  const cond = ["DMG", "NM", "MP", "LP", "HP"].map(c => ({ id: c, condition: c }));
  deq(order(G, cond, [asc("condition")]), ["NM", "LP", "MP", "HP", "DMG"]);
  const mv = [{ id: "3", cmc: 3 }, { id: "0", cmc: 0 }, { id: "10", cmc: 10 }];
  deq(order(G, mv, [desc("cmc")]), ["10", "3", "0"], "numeric, not text order");
  const price = [{ id: "a", price: 2.5 }, { id: "none", price: null }, { id: "b", price: 0.1 }];
  deq(order(G, price, [asc("price")]), ["b", "a", "none"], "no price sinks");
  deq(order(G, price, [desc("price")]), ["a", "b", "none"], "no price sinks either way");
  const rel = [{ id: "new", releasedAt: "2024-02-09" }, { id: "old", releasedAt: "1993-08-05" }];
  deq(order(G, rel, [asc("released")]), ["old", "new"]);
  const types = [{ id: "bolt", typeLine: "Instant" }, { id: "golem", typeLine: "Artifact Creature — Golem" },
    { id: "ring", typeLine: "Artifact" }, { id: "vault", typeLine: "Artifact Land" }];
  deq(order(G, types, [asc("type")]), ["ring", "golem", "bolt", "vault"], "Artifact Creature files as Creature, Artifact Land as Land");
  const lang = [{ id: "ja", lang: "ja" }, { id: "en", lang: "en" }, { id: "de", lang: "de" }];
  deq(order(G, lang, [asc("lang")]), ["en", "de", "ja"], "by language name: English, German, Japanese");
});

test("multi-level: set code, then color identity, then collector #; text is case-insensitive; ties keep their order", () => {
  const G = freshCore();
  const rows = [
    { id: "m10-146-R", set: "m10", colorIdentity: ["R"], collector: "146" },
    { id: "a25-141-R", set: "a25", colorIdentity: ["R"], collector: "141" },
    { id: "m10-1-W", set: "M10", colorIdentity: ["W"], collector: "1" },
    { id: "a25-10-R", set: "a25", colorIdentity: ["R"], collector: "10" },
    { id: "tie1", set: "zen", colorIdentity: ["G"], collector: "5" },
    { id: "tie2", set: "zen", colorIdentity: ["G"], collector: "5" }
  ];
  deq(order(G, rows, [asc("set"), asc("colorIdentity"), asc("collector")]),
    ["a25-10-R", "a25-141-R", "m10-1-W", "m10-146-R", "tie1", "tie2"]);
  const cmp = G.locSortComparator([asc("set"), asc("collector")]);
  assert.ok(cmp(rows[1], rows[0]) < 0, "the comparator alone agrees: a25 before m10");
  assert.equal(cmp(rows[4], rows[5]), 0);
  assert.equal(G.locSortComparator(null), null, "no method, no comparator");
  deq(order(G, rows, null), rows.map(r => r.id), "no method keeps the incoming order");
});

test("presets match their levels; the summary reads like the location card shows it", () => {
  const G = freshCore();
  assert.ok(G.LOC_SORT_PRESETS.length >= 5);
  assert.equal(G.locSortPresetOf([asc("set"), asc("collector")]).label, "Set code A–Z, then collector #");
  assert.equal(G.locSortPresetOf([asc("set"), desc("collector")]), null, "edited levels are Custom");
  assert.equal(G.locSortSummary([asc("set"), asc("colorIdentity"), asc("collector")]), "Set code A–Z › Color identity › Collector #");
  assert.equal(G.locSortSummary([desc("cmc"), asc("name")]), "Mana value (high to low) › Name A–Z");
  assert.equal(G.locSortSummary(null), "");
});

/* ---------- pick lists ---------- */
function pickSetup() {
  const G = freshCore();
  G.state.locations.push(G.newLocation({ id: "BIN", name: "Binder", sortMethod: [asc("set"), asc("collector")], pickPriority: 5 }));
  G.state.locations.push(G.newLocation({ id: "BOX", name: "Box", pickPriority: 1 }));
  const add = (locationId, set, num, name, qty) => G.addCopies({ set, num, lang: "en", finish: "nonfoil", condition: "NM",
    locationId, qty: qty || 1, info: { name, collector: num, setName: set.toUpperCase(), rarity: "common", price: 1, meta: {} },
    unitCost: 0.1, action: "receipt", receiptId: "T1", note: "" });
  add("BIN", "zen", "5", "Zulu");
  add("BIN", "a25", "141", "Alpha");
  add("BOX", "m10", "1", "Box card");
  add("BIN", "a25", "20", "Bravo");
  const line = (set, collector, name) => ({ kind: "card", set, collector, lang: "en", finish: "nonfoil", condition: "NM", name, qty: 1 });
  return { G, add, line };
}

test("pickLineOrder: lines from a location with a sorting method follow it; other lines keep their places", () => {
  const { G, line } = pickSetup();
  const p = G.newPickList({ source: "manual" });
  G.pickLists().push(p);
  p.lines.push(line("zen", "5", "Zulu"), line("m10", "1", "Box card"), line("a25", "141", "Alpha"), line("a25", "20", "Bravo"));
  const names = G.pickLineOrder(p).map(i => p.lines[i].name);
  deq(names, ["Bravo", "Box card", "Alpha", "Zulu"], "Binder lines walk a25 #20, a25 #141, zen #5; the Box line stays second");
  G.locById("BIN").sortMethod = null;
  deq(G.pickLineOrder(p), [0, 1, 2, 3], "no sorting method: exactly today's order");
});

test("pickLineOrder: a completed list orders by what was really pulled, from the line itself once stacks are gone", () => {
  const { G, line } = pickSetup();
  const p = G.newPickList({ source: "manual" });
  G.pickLists().push(p);
  p.lines.push(line("zen", "5", "Zulu"), line("a25", "141", "Alpha"));
  G.completePickList(p.id);
  assert.equal(p.status, "picked");
  deq(G.pickLineOrder(p).map(i => p.lines[i].name), ["Alpha", "Zulu"]);
});

test("pickBatchSheet: locations keep their order; rows inside one with a sorting method follow it (#212, #267)", () => {
  const { G, line } = pickSetup();
  const mk = lines => { const p = G.newPickList({ source: "manual" }); G.pickLists().push(p); p.lines.push(...lines); return p; };
  const a = mk([line("zen", "5", "Zulu"), line("m10", "1", "Box card")]);
  const b = mk([line("a25", "141", "Alpha"), line("a25", "20", "Bravo")]);
  const id = G.createPickBatch([a.id, b.id]);
  const rows = G.pickBatchSheet(id).rows;
  deq(rows.map(r => [G.locName(r.locationId), r.line.name]),
    [["Binder", "Bravo"], ["Binder", "Alpha"], ["Binder", "Zulu"], ["Box", "Box card"]],
    "Binder before Box as before; inside Binder by set code then collector #, not by name");
  G.locById("BIN").sortMethod = null;
  deq(G.pickBatchSheet(id).rows.map(r => r.line.name), ["Alpha", "Bravo", "Zulu", "Box card"], "without one: by name, as before");
});
