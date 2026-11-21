"use strict";
/* server/lib/fetchRetry.js - the retry wrapper around outbound calls to
   Manapool/Pitney Bowes (and, via mtgjson.js's own similar logic, MTGJSON).
   Zero test coverage before now, despite being exactly the kind of "quietly
   wrong" code a retry helper tends to be - too few retries defeats its
   purpose, too many turns a real permanent failure into a long hang, and
   retrying the wrong thing (an aborted request, a plain 404) burns time on
   an attempt that was never going to succeed.

   All tests use small/zero delaysMs so the suite stays fast - the actual
   backoff SCHEDULE isn't what's under test, the retry/no-retry DECISION is.
   global.fetch is mocked directly; no store, no scratch dataDir needed. */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { fetchRetry } = require(path.join(__dirname, "..", "server", "lib", "fetchRetry"));

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function resWithStatus(status, headers) {
  return new Response(null, { status, headers: headers || {} });
}

function queueResponses(...items) {
  let i = 0;
  global.fetch = async () => {
    const item = items[Math.min(i, items.length - 1)];
    i++;
    if (item instanceof Error) throw item;
    return item;
  };
  return () => i; // call counter
}

test("fetchRetry: a plain 2xx on the first try never retries", async () => {
  const calls = queueResponses(resWithStatus(200));
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [1, 1] });
  assert.equal(res.status, 200);
  assert.equal(calls(), 1);
});

test("fetchRetry: retries a 429, then a 5xx, then succeeds - up to the attempt cap", async () => {
  const calls = queueResponses(resWithStatus(429), resWithStatus(503), resWithStatus(200));
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [1, 1], attempts: 3 });
  assert.equal(res.status, 200);
  assert.equal(calls(), 3);
});

test("fetchRetry: exhausting every attempt on a persistent 5xx returns the last (still-failing) response, not a throw", async () => {
  const calls = queueResponses(resWithStatus(503), resWithStatus(503), resWithStatus(503));
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [1, 1], attempts: 3 });
  assert.equal(res.status, 503, "the caller gets a real response to inspect, same as a bare fetch would for any other non-ok status");
  assert.equal(calls(), 3, "never more than the configured attempt cap");
});

test("fetchRetry: a plain 404 is never retried - it isn't in the retryable status set", async () => {
  const calls = queueResponses(resWithStatus(404), resWithStatus(200));
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [1, 1], attempts: 3 });
  assert.equal(res.status, 404);
  assert.equal(calls(), 1, "a 404 returns immediately - retrying it would just waste the attempt budget on a request that isn't transient");
});

test("fetchRetry: a thrown network error is retried, then succeeds", async () => {
  const calls = queueResponses(new Error("ECONNRESET"), resWithStatus(200));
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [1, 1] });
  assert.equal(res.status, 200);
  assert.equal(calls(), 2);
});

test("fetchRetry: an AbortError is never retried, even with attempts remaining - the deadline already passed", async () => {
  const abortErr = new Error("The operation was aborted");
  abortErr.name = "AbortError";
  queueResponses(abortErr, resWithStatus(200));
  await assert.rejects(
    () => fetchRetry("https://example.test", {}, { delaysMs: [1, 1], attempts: 3 }),
    e => e.name === "AbortError"
  );
});

test("fetchRetry: a TimeoutError (what AbortSignal.timeout() rejects with) isn't retried either (#167)", async () => {
  const timeoutErr = new Error("The operation was aborted due to timeout");
  timeoutErr.name = "TimeoutError";
  queueResponses(timeoutErr, resWithStatus(200));
  await assert.rejects(
    () => fetchRetry("https://example.test", {}, { delaysMs: [1, 1], attempts: 3 }),
    e => e.name === "TimeoutError"
  );
});

test("fetchRetry: a persistent network error still throws once every attempt is exhausted", async () => {
  queueResponses(new Error("boom1"), new Error("boom2"));
  await assert.rejects(
    () => fetchRetry("https://example.test", {}, { delaysMs: [1], attempts: 2 }),
    /boom2/
  );
});

test("fetchRetry: honors a short Retry-After header rather than the full default backoff schedule", async () => {
  const calls = queueResponses(resWithStatus(429, { "retry-after": "0" }), resWithStatus(200));
  const start = Date.now();
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [5000, 5000] }); // would be slow if the header were ignored
  assert.equal(res.status, 200);
  assert.equal(calls(), 2);
  assert.ok(Date.now() - start < 1000, "a Retry-After: 0 should not fall through to the multi-second default backoff");
});

test("fetchRetry: a negative attempts count is floored at 1, not treated as zero real tries", async () => {
  const calls = queueResponses(resWithStatus(503));
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [1], attempts: -5 });
  assert.equal(res.status, 503);
  assert.equal(calls(), 1, "at least one real attempt always happens");
});

test("fetchRetry: attempts:0 falls back to the default attempt count, not zero - `0 || DEFAULT` is truthy-checked, not floored", async () => {
  // Documents real, slightly-surprising behavior rather than asserting an
  // ideal one: `ro.attempts || DEFAULT_ATTEMPTS` treats 0 as "unset" the
  // same way it would treat undefined, since 0 is falsy - only a genuinely
  // negative number reaches the Math.max(1, ...) floor tested above.
  const calls = queueResponses(resWithStatus(503), resWithStatus(503), resWithStatus(503));
  const res = await fetchRetry("https://example.test", {}, { delaysMs: [1, 1], attempts: 0 });
  assert.equal(res.status, 503);
  assert.equal(calls(), 3, "attempts:0 silently becomes the default of 3, not 1");
});
