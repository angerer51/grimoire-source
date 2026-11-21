"use strict";
/* Patch saves (#181, docs/flows/collection-save.dot).
   ----------------------------------------------------
   A full save sends the whole collection document, 2.7-7.8 MB on a real
   account, on every autosave. A patch save sends only what changed since
   the revision the page last saw (`rev`), and the server rebuilds the full
   document from the state it holds at that rev. What comes out is exactly
   the document a full save would have sent, so everything after it in
   store.writeCollection (the rev check and three-way merge, saveIds,
   Staff setting locks, the big-drop revision, onWrite hooks) runs
   unchanged.

   The patch (core.js savePlan builds it):
     { v: 1,
       keys: [...],              top-level fields of the new document, in order
       set:  { field: value },   fields sent whole (settings, history, ...)
       rows: { field: {          an id-keyed array (merge.js MERGE_ARRAYS)
         edit: [row],            rows whose key is at the base, changed
         add:  [row],            rows whose key isn't at the base
         del:  [key],            keys at the base that are gone
         order: [seg],           optional, see below
         n: <length> } } }
   A field in `keys` but in neither `set` nor `rows` keeps the base's
   value; a base field not in `keys` is dropped, as a full save drops it.
   Without `order`, the array is the base's rows in their order (deleted
   ones out, edited ones in place) followed by the added rows. When the
   page's order differs (a receipt or history entry added at the front,
   a re-sort), `order` lists the result as segments: a key string is that
   added row, [start, count] is a run of the base's surviving rows.

   Anything that doesn't fit the base exactly (an edit or delete whose key
   isn't there, an add whose key is, a base row with no key or a repeated
   one, a wrong length) is refused, never guessed at: the page then sends
   the full document (core.js flushSave). applyPatch never changes `base`;
   unchanged rows are shared with it. */

const { MERGE_ARRAYS } = require("./merge");

const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class Refused extends Error {}
const refuse = why => { throw new Refused(why); };

function applyRows(field, arr, op, key) {
  if (!Array.isArray(arr)) refuse(field + " isn't a list at the base");
  if (!plain(op)) refuse(field + ": bad change");
  const at = new Map();
  for (let i = 0; i < arr.length; i++) {
    const k = arr[i] && arr[i][key];
    if (typeof k !== "string" || at.has(k)) refuse(field + ": a base row has no " + key + " or a repeated one");
    at.set(k, i);
  }
  const list = (v, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) refuse(field + "." + what + " isn't a list");
    return v;
  };
  const dels = new Set();
  for (const k of list(op.del, "del")) {
    if (typeof k !== "string" || !at.has(k) || dels.has(k)) refuse(field + ": deletes a row the base doesn't have");
    dels.add(k);
  }
  const edits = new Map();
  for (const row of list(op.edit, "edit")) {
    const k = plain(row) ? row[key] : undefined;
    if (typeof k !== "string" || !at.has(k) || dels.has(k) || edits.has(k)) refuse(field + ": edits a row the base doesn't have");
    edits.set(k, row);
  }
  const adds = new Map();
  for (const row of list(op.add, "add")) {
    const k = plain(row) ? row[key] : undefined;
    if (typeof k !== "string" || at.has(k) || adds.has(k)) refuse(field + ": adds a row the base already has");
    adds.set(k, row);
  }
  const kept = [];
  for (const row of arr) {
    const k = row[key];
    if (!dels.has(k)) kept.push(edits.has(k) ? edits.get(k) : row);
  }
  let out;
  if (op.order === undefined) {
    out = kept.concat(Array.from(adds.values()));
  } else {
    if (!Array.isArray(op.order)) refuse(field + ".order isn't a list");
    out = [];
    const used = new Uint8Array(kept.length);
    const placed = new Set();
    for (const seg of op.order) {
      if (typeof seg === "string") {
        if (!adds.has(seg) || placed.has(seg)) refuse(field + ".order: bad added row");
        placed.add(seg);
        out.push(adds.get(seg));
      } else if (Array.isArray(seg) && seg.length === 2 && Number.isInteger(seg[0]) && Number.isInteger(seg[1]) &&
          seg[0] >= 0 && seg[1] >= 1 && seg[0] + seg[1] <= kept.length) {
        for (let i = seg[0]; i < seg[0] + seg[1]; i++) {
          if (used[i]) refuse(field + ".order: a row placed twice");
          used[i] = 1;
          out.push(kept[i]);
        }
      } else refuse(field + ".order: bad segment");
    }
    if (out.length !== kept.length + adds.size) refuse(field + ".order leaves rows out");
  }
  if (op.n !== out.length) refuse(field + ": " + out.length + " rows, the page has " + op.n);
  return out;
}

/* -> { state } or { refused: "why" }. */
function applyPatch(base, patch) {
  try {
    if (!plain(base)) refuse("no document at that revision");
    if (!plain(patch) || patch.v !== 1 || !Array.isArray(patch.keys)) refuse("not a patch this server reads");
    const set = patch.set === undefined ? {} : patch.set;
    const rows = patch.rows === undefined ? {} : patch.rows;
    if (!plain(set) || !plain(rows)) refuse("bad patch");
    const keys = new Set();
    for (const k of patch.keys) {
      if (typeof k !== "string" || keys.has(k)) refuse("bad field list");
      keys.add(k);
    }
    for (const k of Object.keys(set)) if (!keys.has(k)) refuse(k + " is sent but not listed");
    for (const k of Object.keys(rows)) {
      if (!keys.has(k) || has(set, k) || !has(MERGE_ARRAYS, k)) refuse(k + " can't be patched by row");
    }
    const state = {};
    for (const k of patch.keys) {
      if (has(set, k)) state[k] = set[k];
      else if (has(rows, k)) state[k] = applyRows(k, base[k], rows[k], MERGE_ARRAYS[k].key || "id");
      else if (base[k] !== undefined) state[k] = base[k];
      else refuse(k + " isn't at the base");
    }
    return { state };
  } catch (e) {
    if (e instanceof Refused) return { refused: e.message };
    throw e;
  }
}

module.exports = { applyPatch };
