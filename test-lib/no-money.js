"use strict";
/* The RF screens must show no money (owner, 2026-10-31). Checking that with
   one regex over JSON.stringify(view) is flaky: a view carries ISO times and
   random ids, and "05:17:41.118Z" contains "1.11", "...:17.254Z" contains
   "7.25", a random id can spell "fee" (#421). So walk the value instead:
   every key is checked by name, numbers by value, and strings by text, except
   ids and timestamps, which are never money.

   moneyLeaks(value, { words: /price|cost/i, numbers: [9.99] }) -> ["key: value", ...] */

const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/;
const GENERATED_ID = /^c[0-9a-z]{10,}$/; // core.js uid(): "c" + base36 time + random
// id, locationId, pickListId, record_id - by camelCase, so "paid" and "amountPaid" are still checked.
const ID_KEY = /(^id|Id|ID|_id)$/;

function moneyLeaks(value, { words, numbers = [] }) {
  const esc = (n) => String(n).replace(".", "\\.");
  const numText = numbers.length ? new RegExp("(^|[^\\d.])(" + numbers.map(esc).join("|") + ")0*(?!\\d)") : null;
  const leaks = [];
  JSON.parse(JSON.stringify(value === undefined ? null : value), (k, v) => {
    if (words && words.test(k)) leaks.push(k);
    if (typeof v === "number" && numbers.includes(v)) leaks.push(k + ": " + v);
    if (typeof v === "string" && !ID_KEY.test(k) && !ISO_TIME.test(v) && !GENERATED_ID.test(v)
      && ((words && words.test(v)) || (numText && numText.test(v)))) leaks.push(k + ": " + v);
    return v;
  });
  return leaks;
}

module.exports = { moneyLeaks };
