"use strict";
/* A small, standalone retry wrapper around the global fetch, for outbound
   calls to third-party APIs (Manapool, Pitney Bowes) that occasionally blip -
   a transient 5xx, a dropped connection, a 429 with a Retry-After header.
   Without this, one bad response fails the whole operation, including an
   unattended scheduled job (e.g. a nightly price/label run) that nobody is
   watching to retry by hand.

   This is deliberately NOT the queue-based rate limiter in cards.js's
   liveFetch - that is a shared token-bucket specific to staying under
   Scryfall's requests/second limit across many queued callers. This is a
   plain per-call retry: try, and on a retryable failure wait and try again,
   up to a small attempt cap. */

const DEFAULT_DELAYS_MS = [500, 1500];   // backoff before retry #1, retry #2, ...
const DEFAULT_ATTEMPTS = 3;              // total tries, including the first
const MAX_RETRY_AFTER_MS = 30000;        // never sleep longer than this even if the server asks

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/* Honor a Retry-After header (seconds, or an HTTP-date) when present;
   otherwise fall back to the plain exponential backoff schedule. */
function delayFor(res, attemptIndex, delays) {
  const header = res && res.headers && typeof res.headers.get === "function"
    ? res.headers.get("retry-after") : null;
  if (header) {
    const secs = Number(header);
    if (!isNaN(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const when = Date.parse(header);
    if (!isNaN(when)) return Math.max(0, Math.min(when - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return delays[Math.min(attemptIndex, delays.length - 1)];
}

/* fetchRetry(url, opts, retryOpts) - drop-in for fetch(url, opts): resolves
   to the same Response a bare fetch would (including a non-ok one, exactly
   like fetch itself - it never throws for a 4xx/5xx, only for a genuine
   network failure), so existing response-handling code needs no changes.

   Retries on:
     - fetch() throwing (network error) - NOT an AbortError or a
       TimeoutError, since an aborted request already hit its deadline and retrying would just
       restart a doomed wait under the same expired timeout/signal.
     - a response whose status is 429 or 5xx.
   Anything else (2xx, or a 4xx other than 429) returns on the first
   attempt, same as a bare fetch.

   retryOpts:
     attempts  - total attempts including the first try (default 3)
     delaysMs  - backoff schedule before each retry (default [500, 1500]) */
async function fetchRetry(url, opts, retryOpts) {
  const ro = retryOpts || {};
  const attempts = Math.max(1, ro.attempts || DEFAULT_ATTEMPTS);
  const delays = ro.delaysMs || DEFAULT_DELAYS_MS;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const isLast = attempt === attempts - 1;
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      // AbortSignal.timeout() rejects with a TimeoutError, not an AbortError (#167).
      if (e.name === "AbortError" || e.name === "TimeoutError" || isLast) throw e;
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
      continue;
    }
    if (!isLast && isRetryableStatus(res.status)) {
      await sleep(delayFor(res, attempt, delays));
      continue;
    }
    return res;
  }
  /* Unreachable in practice (the loop always returns or throws above once
     attempts >= 1), kept only so the function has an explicit exhaustive
     return path. */
  throw new Error("fetchRetry: exhausted attempts for " + url);
}

module.exports = { fetchRetry };
