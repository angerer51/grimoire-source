"use strict";
/* #67: every putaway plan used to rescan the whole collection once per
   card x location (locStats + nameCountAt inside candidates()). Plans now
   build one per-location index per run. These tests pin the plans' output
   for a small fixture, captured from the old scanning code before the
   change, so the index must reproduce it exactly - including the per-card
   limit's "oracle id, else name" matching for rows written before oracle
   ids were captured. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshCore } = require("../test-lib/core-shim");

const CATCH_ALL = { combinator: "ALL", not: false, conditions: [], groups: [] };
const rarity = v => ({ combinator: "ALL", not: false, conditions: [{ on: true, field: "rarity", op: "is", value: v }], groups: [] });

function fixture() {
  const G = freshCore();
  const loc = (o) => {
    const l = G.newLocation({ id: o.id, name: o.id, type: "bin", priority: o.priority, maxCards: o.maxCards,
      maxPerName: o.maxPerName, putaway: { enabled: o.enabled !== false, rules: o.rules || CATCH_ALL } });
    if (o.staging) l.staging = true;
    G.state.locations.push(l);
  };
  loc({ id: "tray", staging: true });
  loc({ id: "rares", rules: rarity("rare"), maxCards: 10, maxPerName: 2, priority: 2 });
  loc({ id: "commons", rules: rarity("common"), maxCards: 12, priority: 1 });
  loc({ id: "singles", rules: rarity("common"), maxPerName: 1, priority: 3 });
  loc({ id: "bulk", rules: CATCH_ALL });
  loc({ id: "off", enabled: false });
  let n = 0;
  const card = (name, o) => {
    n++;
    const r = G.addCopies({
      set: "tst", num: String(n), lang: "en", finish: "nonfoil", condition: "NM",
      locationId: o.at, qty: o.qty || 1,
      info: { name, collector: String(n), setName: "Test", rarity: o.rarity || "common", tcgplayerId: "1",
        scryfallId: "sid-" + n, price: o.price || 0.25, priceNote: "", note: "",
        meta: { oracleId: o.oracle === undefined ? "oid-" + name : o.oracle, typeLine: "Instant" } },
      action: "receipt", receiptId: "T1", note: ""
    });
    r.tag = name + "#" + n;
    return r;
  };
  card("Bolt", { at: "tray", qty: 3 });
  card("Bolt", { at: "singles", qty: 1 });
  card("Bolt", { at: "commons", qty: 2, oracle: "" });      // an old row with no oracle id
  card("Shock", { at: "tray", qty: 4 });
  card("Shock", { at: "bulk", qty: 5 });
  card("Opt", { at: "commons", qty: 6 });
  card("Opt", { at: "off", qty: 2, oracle: "" });
  card("Thoughtseize", { at: "tray", qty: 2, rarity: "rare", price: 12 });
  card("Thoughtseize", { at: "rares", qty: 1, rarity: "rare", price: 12 });
  card("Goyf", { at: "commons", qty: 3, rarity: "rare", price: 30 });
  card("Goyf", { at: "rares", qty: 1, rarity: "rare", price: 30, oracle: "" });
  card("Island", { at: "off", qty: 9, rarity: "basic" });
  return G;
}

const inf = v => (v === Infinity ? "inf" : v);
const cand = c => c && [c.locationId, inf(c.free), inf(c.capFree), inf(c.nameFree), c.nameHeld, c.cards, c.blockedBy].join(",");

function snapshot(G) {
  return {
    plan: G.putawayPlan({}).map(p => [p.record.tag, p.move, cand(p.suggestion), p.blocked.map(cand).join(" | ")].join(" ; ")),
    breakers: G.ruleBreakers({}).map(b => [b.record.tag, b.locationId, cand(b.suggestion)].join(" ; ")),
    bin: G.binPlan("tray").lines.map(l => [l.record.tag, l.shortfall,
      l.picks.map(p => p.locationId + "x" + p.take + "/" + p.nameHeld).join(" ")].join(" ; ")),
    here: G.whatBelongsHere("singles").rows.map(x => x.record.tag + "=" + x.nameHeld),
    one: G.candidates(G.state.cards.find(r => r.tag === "Bolt#1"), {}).map(cand)
  };
}

const EXPECTED = {
  plan: [
    "Bolt#1 ; true ; bulk,inf,inf,inf,0,5, ; singles,0,inf,0,1,1,per-name | commons,1,1,inf,0,11,",
    "Bolt#2 ; true ; commons,1,1,inf,0,11, ; singles,0,inf,0,1,1,per-name",
    "Bolt#3 ; true ; bulk,inf,inf,inf,0,5, ; singles,0,inf,0,1,1,per-name | commons,1,1,inf,0,11,",
    "Shock#4 ; true ; bulk,inf,inf,inf,0,5, ; singles,1,inf,1,0,1, | commons,1,1,inf,0,11,",
    "Shock#5 ; false ; bulk,inf,inf,inf,0,5, ; singles,1,inf,1,0,1, | commons,1,1,inf,0,11,",
    "Opt#6 ; true ; bulk,inf,inf,inf,0,5, ; singles,1,inf,1,0,1, | commons,1,1,inf,0,11,",
    "Opt#7 ; true ; bulk,inf,inf,inf,0,5, ; singles,1,inf,1,0,1, | commons,1,1,inf,0,11,",
    "Thoughtseize#8 ; true ; bulk,inf,inf,inf,0,5, ; rares,1,8,1,1,2,",
    "Thoughtseize#9 ; false ; rares,1,8,1,1,2, ; ",
    "Goyf#10 ; true ; bulk,inf,inf,inf,0,5, ; rares,1,8,1,1,2,",
    "Goyf#11 ; false ; rares,1,8,1,1,2, ; ",
    "Island#12 ; true ; bulk,inf,inf,inf,0,5, ; "
  ],
  breakers: [
    "Goyf#10 ; commons ; bulk,inf,inf,inf,0,5,"
  ],
  bin: [
    "Thoughtseize#8 ; 0 ; raresx1/1 bulkx1/0",
    "Shock#4 ; 0 ; singlesx1/0 commonsx1/0 bulkx2/0",
    "Bolt#1 ; 0 ; bulkx3/0"
  ],
  here: ["Bolt#1=1", "Bolt#3=1", "Shock#4=0", "Shock#5=0", "Opt#6=0", "Opt#7=0"],
  one: ["singles,0,inf,0,1,1,per-name", "commons,1,1,inf,0,11,", "bulk,inf,inf,inf,0,5,"]
};

test("putaway plans: output is pinned for a fixture (the per-location index must match the old full scans)", () => {
  // JSON round trip: the arrays come from the core.js VM realm, whose
  // prototypes deepStrictEqual would otherwise treat as different.
  const snap = JSON.parse(JSON.stringify(snapshot(fixture())));
  if (process.env.PRINT_SNAPSHOT) console.log(JSON.stringify(snap, null, 2));
  assert.deepEqual(snap, EXPECTED);
});

test("putaway plans: a whole-collection plan over 20k stacks x 30 locations finishes in seconds", () => {
  // Sized toward the ~70k-stack accounts the grid is built for. The old
  // per-card x location full scans made this billions of row visits.
  const G = freshCore();
  for (let i = 0; i < 30; i++) {
    G.state.locations.push(G.newLocation({ id: "L" + i, name: "Loc " + i, type: "bin", maxCards: 5000,
      maxPerName: i % 3 ? null : 4,
      putaway: { enabled: true, rules: i === 0 ? CATCH_ALL : rarity(["common", "uncommon", "rare"][i % 3]) } }));
  }
  const rar = ["common", "uncommon", "rare", "mythic"];
  for (let i = 0; i < 20000; i++) {
    G.state.cards.push({ id: "c" + i, name: "Card " + (i % 4000), oracleId: "o" + (i % 4000), rarity: rar[i % 4],
      locationId: "L" + (i % 30), quantity: 1 + (i % 3), finish: "nonfoil", set: "tst", collector: String(i) });
  }
  const t0 = Date.now();
  const plan = G.putawayPlan({});
  const breakers = G.ruleBreakers({});
  const ms = Date.now() - t0;
  if (process.env.PRINT_SNAPSHOT) console.log("20k-stack plan + rule breakers: " + ms + "ms");
  assert.equal(plan.length, 20000);
  assert.ok(breakers.length > 0);
  assert.ok(ms < 20000, "plan + rule breakers took " + ms + "ms");
});
