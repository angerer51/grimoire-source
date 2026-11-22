"use strict";
/* #506: open sign-up's guard (server/lib/signupGuard.js): the honeypot,
   the per-address daily limit and the site-wide daily cap. The route's use
   of it (lockout after repeated refusals, first account and invite codes
   untouched) was run over HTTP on a scratch server; see the PR. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const sg = require(path.join(__dirname, "..", "server", "lib", "signupGuard"));

const T0 = Date.parse("2026-11-21T12:00:00Z");
const HOUR = 3600 * 1000;

test("defaults: 3 per address, 200 a day; null, 0 or off turns a check off", () => {
  const g = sg.createGuard(undefined);
  assert.equal(g.perIp, 3);
  assert.equal(g.cap, 200);
  const off = sg.createGuard({ perIpPerDay: null, dailyCap: 0 });
  assert.equal(off.perIp, null);
  assert.equal(off.cap, null);
  assert.equal(sg.createGuard({ dailyCap: "off" }).cap, null);
  assert.equal(sg.createGuard({ perIpPerDay: "5" }).perIp, 5);
  assert.equal(sg.createGuard({ perIpPerDay: "junk" }).perIp, 3, "nonsense falls back to the default");
});

test("honeypot: only a filled-in website field counts", () => {
  assert.equal(sg.honeypotHit({ website: "http://spam" }), true);
  assert.equal(sg.honeypotHit({ website: "  x " }), true);
  for (const b of [{}, { website: "" }, { website: "   " }, { website: null }, null, undefined]) {
    assert.equal(sg.honeypotHit(b), false, JSON.stringify(b));
  }
});

test("per address: 3 sign-ups in 24 hours, then refused until the oldest ages out", () => {
  const g = sg.createGuard({ perIpPerDay: 3 });
  assert.equal(g.take("1.2.3.4", T0), true);
  assert.equal(g.take("1.2.3.4", T0 + HOUR), true);
  assert.equal(g.take("1.2.3.4", T0 + 2 * HOUR), true);
  assert.equal(g.take("1.2.3.4", T0 + 3 * HOUR), false, "fourth in a day refused");
  assert.equal(g.take("5.6.7.8", T0 + 3 * HOUR), true, "another address is its own count");
  assert.equal(g.take("1.2.3.4", T0 + 24 * HOUR - 1), false, "still inside the first one's day");
  assert.equal(g.take("1.2.3.4", T0 + 24 * HOUR), true, "the first one has aged out");
  assert.equal(g.take("1.2.3.4", T0 + 24 * HOUR + 1), false);
});

test("release hands a reserved sign-up back (a form with problems, a taken username)", () => {
  const g = sg.createGuard({ perIpPerDay: 1 });
  assert.equal(g.take("9.9.9.9", T0), true);
  g.release("9.9.9.9");
  assert.equal(g.size(), 0, "nothing left for that address");
  assert.equal(g.take("9.9.9.9", T0), true, "the slot is free again");
  assert.equal(g.take("9.9.9.9", T0), false);
  g.release("never-seen");     // harmless
});

test("per-address limit off: every take passes and nothing is remembered", () => {
  const g = sg.createGuard({ perIpPerDay: null });
  for (let i = 0; i < 20; i++) assert.equal(g.take("1.1.1.1", T0), true);
  assert.equal(g.size(), 0);
});

test("the address map stays bounded: stale entries swept, then oldest dropped", () => {
  const g = sg.createGuard({ perIpPerDay: 3 }, { maxIps: 100 });
  for (let i = 0; i < 100; i++) g.take("10.0.0." + i, T0);
  // A day later the old ones are stale: the sweep clears them all.
  g.take("fresh", T0 + 25 * HOUR);
  assert.equal(g.size(), 1);
  // A flood inside one day: still never more than maxIps.
  for (let i = 0; i < 500; i++) g.take("11.0." + i, T0 + 26 * HOUR);
  assert.equal(g.size(), 100);
  assert.equal(g.take("11.0.499", T0 + 26 * HOUR), true, "the newest address keeps its count");
  assert.equal(g.take("11.0.499", T0 + 26 * HOUR), true);
  assert.equal(g.take("11.0.499", T0 + 26 * HOUR), false);
});

test("daily cap counts every account made in the last 24 hours", () => {
  const at = ms => ({ createdAt: new Date(ms).toISOString() });
  const users = [at(T0 - 25 * HOUR), at(T0 - 23 * HOUR), at(T0 - HOUR), { createdAt: undefined }, {}];
  assert.equal(sg.recentAccounts(users, T0), 2);
  assert.equal(sg.recentAccounts([], T0), 0);
  const g = sg.createGuard({ dailyCap: 2 });
  assert.equal(g.capReached(1), false);
  assert.equal(g.capReached(2), true);
  assert.equal(sg.createGuard({ dailyCap: null }).capReached(1e6), false, "off never trips");
});

test("the cap's server.log line is written once an hour while it stays tripped", () => {
  const g = sg.createGuard({});
  assert.equal(g.shouldLogCap(T0), true);
  assert.equal(g.shouldLogCap(T0 + 1000), false);
  assert.equal(g.shouldLogCap(T0 + HOUR - 1), false);
  assert.equal(g.shouldLogCap(T0 + HOUR), true);
});

test("refusals are short and plain", () => {
  assert.equal(sg.REFUSE_IP, "Too many new accounts from your network today. Please try again tomorrow.");
  assert.equal(sg.REFUSE_CAP, "We can't take new sign-ups right now. Please try again tomorrow.");
});

test("addressKey: IPv4 as is, IPv6 by its /64 however it's written, IPv4-mapped as IPv4", () => {
  assert.equal(sg.addressKey("203.0.113.7"), "203.0.113.7");
  const k = "2001:db8:1:2::/64";
  for (const a of ["2001:db8:1:2::1", "2001:db8:1:2::5", "2001:0db8:0001:0002:0000:0000:0000:0001",
    "2001:DB8:1:2:ffff:ffff:ffff:ffff", "[2001:db8:1:2::9]", "2001:db8:1:2::9%eth0", "2001:db8:1:2:a:b:1.2.3.4"]) {
    assert.equal(sg.addressKey(a), k, a);
  }
  assert.equal(sg.addressKey("2001:db8:1:3::1"), "2001:db8:1:3::/64", "the next /64 is its own");
  assert.equal(sg.addressKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(sg.addressKey("::1"), "0:0:0:0::/64");
  assert.equal(sg.addressKey("::ffff:198.51.100.4"), "198.51.100.4");
  assert.equal(sg.addressKey("0:0:0:0:0:ffff:c633:6404"), "198.51.100.4");
  assert.equal(sg.addressKey(""), "");
  assert.equal(sg.addressKey("not:an::ip::x"), "not:an::ip::x", "unparseable stays as given");
});

test("per address: one IPv6 /64 shares a count, another /64 doesn't, a mapped IPv4 is its IPv4", () => {
  const g = sg.createGuard({ perIpPerDay: 3 });
  for (const a of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2::3"]) assert.equal(g.take(a, T0), true, a);
  assert.equal(g.take("2001:db8:1:2::4", T0), false, "a 4th address in the same /64 is refused");
  assert.equal(g.take("2001:db8:1:2:dead:beef:0:1", T0), false);
  assert.equal(g.take("2001:db8:1:3::1", T0), true, "a different /64");
  g.release("2001:db8:1:2::77");
  assert.equal(g.take("2001:db8:1:2::5", T0), true, "release hands back the /64's slot");
  assert.equal(g.take("198.51.100.4", T0), true);
  assert.equal(g.take("::ffff:198.51.100.4", T0), true);
  assert.equal(g.take("198.51.100.4", T0), true);
  assert.equal(g.take("::ffff:198.51.100.4", T0), false, "the mapped form counts with the plain IPv4");
});

test("daily cap holds against a parallel burst: checked inside createUser's users lock", async () => {
  const fs = require("fs");
  const os = require("os");
  const store = require(path.join(__dirname, "..", "server", "lib", "store"));
  const auth = require(path.join(__dirname, "..", "server", "lib", "auth"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-signup-cap-test-"));
  try {
    store.init({ dataDir: dir });
    for (let i = 0; i < 3; i++) await auth.createUser({ username: "early" + i, password: "correct-horse-1" });
    const g = sg.createGuard({ dailyCap: 5 });                  // room for 2 more
    // Every request read the list on arrival, before any of the burst wrote.
    const onArrival = await auth.listUsers();
    assert.equal(g.capReached(sg.recentAccounts(onArrival)), false);
    const burst = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => auth.createUser({
      username: "burst" + i, password: "correct-horse-1", refuseIf: db => g.capRefusal(db.users)
    })));
    const made = burst.filter(r => r.status === "fulfilled").length;
    assert.equal(made, 2, "only the room the cap had left");
    for (const r of burst.filter(x => x.status === "rejected")) {
      assert.equal(r.reason.status, 503);
      assert.equal(r.reason.message, sg.REFUSE_CAP);
    }
    assert.equal((await auth.listUsers()).length, 5);
    // No refuseIf (an invite sign-up): never held to it.
    await auth.createUser({ username: "invited", password: "correct-horse-1" });
    assert.equal((await auth.listUsers()).length, 6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
