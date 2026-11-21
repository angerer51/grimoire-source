"use strict";
/* Three-way merge for a collection document. (BACKLOG.md #9.)
   --------------------------------------------------------------
   store.writeCollection() calls merge(base, mine, theirs) when a save's
   baseRev no longer matches what's on disk: `base` is the document as of
   that baseRev (from the in-memory rolling snapshot buffer), `mine` is the
   state the client is trying to save, `theirs` is what's currently on disk
   (already committed by someone else's concurrent save). The result
   replaces the old hard 409 reject for every case this can resolve;
   store.js still falls back to the 409 when `base` isn't available at all
   (buffer miss), so this is a pure enhancement with a safe floor.

   Scope, deliberately: this operates one level deep. Each of the id-keyed
   arrays in state.cards/locations/receipts/pickLists/etc. is diffed and
   merged entry-by-entry; a NESTED array inside one of those entries (e.g.
   a pick list's own `lines`) is treated as an opaque field for conflict
   purposes, not recursively merged. `settings` and `history` are merged as
   single whole values, not id-keyed collections - nobody concurrently
   fights over their own display prefs, and history is an append/cap log,
   not something users edit in place.

   Tiebreak rule, applied consistently everywhere a genuine same-field
   conflict can't be resolved any other way: `theirs` wins, because theirs
   is - by construction - already committed to disk; `mine` is the one
   arriving into a race. The loser is never silently dropped: it's reported
   in the returned `conflicts` list so the caller can tell the person who
   lost a field-level tiebreak what happened, in a much narrower way than
   today's old whole-document "reload or overwrite everything" prompt. */

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

const indexBy = (arr, key) => {
  const m = new Map();
  for (const item of Array.isArray(arr) ? arr : []) {
    if (item && item[key] != null) m.set(item[key], item);
  }
  return m;
};

/* Merges one entity (one card row, one location, ...) present on both
   sides. `base` may be null (the entity is new - independently added under
   the same key on both sides, e.g. two people both typing a decklist entry
   named "Sol Ring"); delta fields treat a missing base value as 0 in that
   case, so two independent adds of the same new key correctly sum rather
   than picking one side arbitrarily. */
function mergeEntity(base, mine, theirs, opts, keyVal, conflicts) {
  const deltaFields = opts.deltaFields || [];
  const out = Object.assign({}, theirs);
  const allFields = new Set([
    ...Object.keys(mine || {}), ...Object.keys(theirs || {}), ...Object.keys(base || {})
  ]);
  for (const f of allFields) {
    if (f === opts.key) continue;
    const bv = base ? base[f] : undefined, mv = mine ? mine[f] : undefined, tv = theirs ? theirs[f] : undefined;

    if (deltaFields.includes(f) && typeof mv === "number" && typeof tv === "number") {
      const bvNum = typeof bv === "number" ? bv : 0;
      out[f] = Math.round((mv + tv - bvNum) * 100) / 100;
      continue;
    }
    if (base && deepEqual(mv, bv)) { out[f] = tv; continue; }        // mine didn't touch this field
    if (base && deepEqual(tv, bv)) { out[f] = mv; continue; }        // theirs didn't touch this field
    if (deepEqual(mv, tv)) { out[f] = mv; continue; }                // both landed on the same value
    out[f] = tv;                                                     // genuine conflict - theirs wins
    conflicts.push({ array: opts.name, key: keyVal, field: f, mine: mv, theirs: tv, resolution: "theirs" });
  }
  return out;
}

/* A row one side deleted and the other edited (#218). For a stack
   (opts.countField), the delete is usually "emptied": sold or picked to 0,
   or moved whole to another stack. Its delta fields are running totals, so
   the deleted side counts as 0 and only the editing side's change applies:
   10 Bolts, one device takes all 10, the other receives 3 -> 3, not 13.
   Every other field is the edited row's, as before. A stack that ends at 0
   or less stays deleted (null), as the page drops an emptied stack. Arrays
   without a countField keep the edited row whole. */
function editOverDelete(b, edited, opts) {
  if (!opts.countField) return edited;
  const out = Object.assign({}, edited);
  for (const f of opts.deltaFields || []) {
    if (typeof edited[f] !== "number") continue;
    out[f] = Math.round((edited[f] - (typeof b[f] === "number" ? b[f] : 0)) * 100) / 100;
  }
  return out[opts.countField] > 0 ? out : null;
}

/* Diffs+merges one id-keyed array (opts: {name, key ('id' unless
   overridden), deltaFields, countField}). Returns {result, conflicts}. */
function mergeArray(base, mine, theirs, opts) {
  const key = opts.key || "id";
  const baseMap = indexBy(base, key), mineMap = indexBy(mine, key), theirsMap = indexBy(theirs, key);
  const allKeys = new Set([...baseMap.keys(), ...mineMap.keys(), ...theirsMap.keys()]);
  const result = [];
  const conflicts = [];

  for (const k of allKeys) {
    const inBase = baseMap.has(k), inMine = mineMap.has(k), inTheirs = theirsMap.has(k);
    const b = baseMap.get(k), m = mineMap.get(k), t = theirsMap.get(k);

    if (!inBase) {
      if (inMine && inTheirs) result.push(mergeEntity(null, m, t, opts, k, conflicts));
      else if (inMine) result.push(m);
      else result.push(t);
      continue;
    }

    const mineDeleted = !inMine, theirsDeleted = !inTheirs;
    if (mineDeleted && theirsDeleted) continue; // agreed gone

    if (mineDeleted && !theirsDeleted) {
      const kept = deepEqual(b, t) ? null : editOverDelete(b, t, opts);
      if (kept) {
        conflicts.push({ array: opts.name, key: k, type: "edit-beats-delete", resolution: "theirs" });
        result.push(kept);
      } // else theirs is unchanged from base, or emptied - the deletion stands
      continue;
    }
    if (theirsDeleted && !mineDeleted) {
      const kept = deepEqual(b, m) ? null : editOverDelete(b, m, opts);
      if (kept) {
        conflicts.push({ array: opts.name, key: k, type: "edit-beats-delete", resolution: "mine" });
        result.push(kept);
      }
      continue;
    }

    // Present on all three sides.
    const mineChanged = !deepEqual(b, m), theirsChanged = !deepEqual(b, t);
    if (!mineChanged && !theirsChanged) { result.push(t); continue; }
    if (mineChanged && !theirsChanged) { result.push(m); continue; }
    if (!mineChanged && theirsChanged) { result.push(t); continue; }
    result.push(mergeEntity(b, m, t, opts, k, conflicts));
  }
  return { result, conflicts };
}

/* Whole-value merge for a single field that isn't an id-keyed array
   (settings, history). Same tiebreak philosophy as mergeEntity: theirs
   wins a genuine conflict, reported rather than silently dropped. */
function mergeWhole(base, mine, theirs) {
  const mineChanged = !deepEqual(mine, base), theirsChanged = !deepEqual(theirs, base);
  if (mineChanged && theirsChanged && !deepEqual(mine, theirs)) return { value: theirs, conflict: true };
  if (mineChanged) return { value: mine, conflict: false };
  return { value: theirs, conflict: false };
}

/* quantity/listedQty/costQty/costTotal are running totals that are
   fundamentally additive even though the document stores an absolute
   value - see the module comment. Every other id-keyed array here has no
   analogous field, so its deltaFields list is empty (plain field-level
   last-write-wins-on-conflict for anything other than quantity itself).
   countField marks a stack, whose row goes when its count reaches 0: an
   edit to one the other side deleted applies only its delta (#218,
   editOverDelete). */
const MERGE_ARRAYS = {
  cards: { key: "id", deltaFields: ["quantity", "listedQty", "costQty", "costTotal"], countField: "quantity" },
  locations: { key: "id", deltaFields: [] },
  receipts: { key: "id", deltaFields: [] },
  returns: { key: "id", deltaFields: [] },
  pickLists: { key: "id", deltaFields: [] },
  listingRules: { key: "id", deltaFields: [] },
  listingKeepExceptions: { key: "id", deltaFields: [] },
  priceRules: { key: "id", deltaFields: [] },
  watchList: { key: "id", deltaFields: [] },
  sealed: { key: "id", deltaFields: ["quantity"], countField: "quantity" },
  sealedPriceRules: { key: "id", deltaFields: [] },
  // Customer wantlists (#50, core.js "Customers & wants"). Four flat arrays
  // rather than wants nested inside customers, so two people editing the
  // same customer (one adds a want, the other marks a match told) merge
  // entity by entity instead of one whole customer winning. A customer's
  // `orderRefs` is a nested array and so opaque here; losing one side's
  // refs in a race is harmless, the next order sync relinks them.
  customers: { key: "id", deltaFields: [] },
  customerWants: { key: "id", deltaFields: [] },
  restockMatches: { key: "id", deltaFields: [] },
  customerTombstones: { key: "id", deltaFields: [] },
  // A customer merged into another (#196), keyed on the merged-away
  // customer's id. Its own array so two merges into one customer at once
  // both survive. A tab that hadn't seen a merge can bring the merged-away
  // customer back (an edit beats a delete here) or add a want to it;
  // core.js tidyCustomers folds both into the customer kept.
  customerAliases: { key: "id", deltaFields: [] },
  // deckList entries have no id (core.js: `deckList.push({name, qty})`,
  // deduplicated by name) - keyed on name instead, with qty as a delta
  // field so two people adding the same card to a shared decklist at once
  // sum rather than clobber.
  deckList: { key: "name", deltaFields: ["qty"] },
  // Saved decks (#309, core.js "Saved decks"). A deck's `lines` is a nested
  // array and so one field here: two devices editing the same deck's list
  // at once keep one side's list whole (theirs on a real conflict).
  decks: { key: "id", deltaFields: [] },
  // Trades made in person (#335, core.js "Trades made in person"): a
  // history record per trade. Its card changes are ordinary `cards` edits;
  // two devices each recording a trade keep both records.
  trades: { key: "id", deltaFields: [] },
  // Receipts open on the floor (#388, core.js "Receiving on the floor") and
  // what's been booked onto them, a row per booking: several phones booking
  // onto one receipt at once each add their own rows, never edit one row.
  receiving: { key: "id", deltaFields: [] },
  receivingLines: { key: "id", deltaFields: [] }
};
const WHOLE_FIELDS = ["settings", "history"];

/* Repeat completions (#214, docs/flows/collection-save.dot).
   Completing a pick list takes its cards off inventory, and quantity merges
   as a delta. So two devices that each complete the same open list would
   each send a minus, and the cards would come off twice. A save whose base
   still had the list open, whose own copy completed it, while the copy on
   disk is already completed (picked or shipped), is a repeat. The other
   device's completion is the one that stands, so this save's is undone
   before the merge, and only that: its other edits merge as usual.

   That needs to know exactly what the completion changed, which the
   document can't tell apart from other edits to the same rows. So the page
   (core.js completePickList) puts it on the list it completes:
     p.completion = { historyId, takes: [{ kind: "cards"|"sealed", id,
       before: {field: value}, after: {field: value}, gone?: <the row as it
       was, when the completion emptied it and so deleted it> }],
       audit: [its activity log lines (#216, completionAudit below)] }
   Undoing it here, on this save's own rows ("mine"):
   - a numeric count (quantity, listedQty, costQty, costTotal) gets back
     what the completion took, so its delta is only the save's other edits;
     any other field (avgCost) goes back only if nothing changed it since;
   - a row missing from this save was emptied, and so deleted, by one of
     its completions: that one's take carries the row (gone). It may not be
     the repeat: in a batch an earlier ticket can take from a row a later
     ticket empties (PR #215 review). So the row is rebuilt as this save
     left it (gone with that take's after: quantity 0) and the repeat undone
     on top, then merged like any row. Rebuilt only if the disk copy still
     has it, or if it was never on the server (this save's own new row).
     When the disk copy has also lost it, the other completion emptied it
     too: it stays gone. A rebuilt row the merge leaves at 0 or less is
     dropped, as the page drops an emptied row (`revived`);
   - the completion's own history entry is dropped;
   - the list itself loses the fields completion writes (COMPLETION_FIELDS),
     so the disk copy's completion stands with no field-by-field conflicts.
     A list this save also marked shipped stays shipped.
   It is reported as an "already-completed" conflict, which the page tells
   the person about. A repeat whose list carries no completion (a tab
   opened before this change) can't be undone safely, so merge() lists it
   in `refused` and store.writeCollection refuses the whole save with a 409:
   nothing is written, and that tab's Keep mine writes absolute numbers,
   which can't take anything twice either.
   The mark only matters inside one save, so the server never stores it
   (dropCompletionMarks, called by store.writeCollection). */
const TAKE_COUNTS = new Set(["quantity", "listedQty", "costQty", "costTotal"]);
const COMPLETION_FIELDS = ["status", "pickedAt", "revenue", "cogs", "shippingRevenue", "fees", "earnings", "shipCost", "lines", "completion"];
const isDone = p => !!p && (p.status === "picked" || p.status === "shipped");
const validCompletion = c => !!c && typeof c === "object" && Array.isArray(c.takes);
const round2 = n => Math.round(n * 100) / 100;

function repeatCompletions(base, mine, theirs) {
  const baseLists = indexBy(base.pickLists, "id"), theirLists = indexBy(theirs.pickLists, "id");
  const out = [];
  for (const m of Array.isArray(mine.pickLists) ? mine.pickLists : []) {
    if (!m || m.id == null || !isDone(m)) continue;
    const b = baseLists.get(m.id), t = theirLists.get(m.id);
    if (b && b.status === "open" && isDone(t)) out.push({ id: m.id, m, b, t });
  }
  return out;
}

// Puts one row of `mine` back to how it was before the completion `take`.
function undoTake(row, take) {
  const out = Object.assign({}, row);
  const before = take.before && typeof take.before === "object" ? take.before : {};
  const after = take.after && typeof take.after === "object" ? take.after : {};
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (f === "id") continue;
    const bv = before[f], av = after[f];
    if (TAKE_COUNTS.has(f) && typeof bv === "number" && typeof av === "number" && typeof out[f] === "number") {
      out[f] = round2(out[f] - (av - bv));
    } else if (deepEqual(out[f], av)) {
      if (bv === undefined) delete out[f]; else out[f] = bv;
    }
  }
  return out;
}

const rowKey = (kind, id) => kind + "\n" + id;
const hasRow = (doc, kind, id) => (Array.isArray(doc[kind]) ? doc[kind] : []).some(x => x && x.id === id);

/* Returns { base, mine, conflicts, refused, revived }: base and mine with
   every repeat completion that can be undone undone (copied, never mutated:
   base is the server's snapshot buffer), the ids of those that can't, and
   the rows rebuilt from a gone (rowKey). */
function undoRepeatCompletions(base, mine, theirs) {
  const repeats = repeatCompletions(base, mine, theirs);
  const conflicts = [], refused = [], revived = new Set();
  if (!repeats.length) return { base, mine, conflicts, refused, revived };
  // The take that emptied each row, from any completion in this save.
  const emptiedBy = new Map();
  for (const p of Array.isArray(mine.pickLists) ? mine.pickLists : []) {
    if (!p || !validCompletion(p.completion)) continue;
    for (const t of p.completion.takes) {
      if (t && (t.kind === "cards" || t.kind === "sealed") && t.id != null && t.gone && typeof t.gone === "object") {
        emptiedBy.set(rowKey(t.kind, t.id), t);
      }
    }
  }
  base = Object.assign({}, base);
  mine = Object.assign({}, mine);
  const copied = new Set();
  const own = (doc, field) => {
    const key = (doc === base ? "b:" : "m:") + field;
    if (!copied.has(key)) { doc[field] = Array.isArray(doc[field]) ? doc[field].slice() : []; copied.add(key); }
    return doc[field];
  };
  for (const r of repeats) {
    const c = r.m.completion;
    if (!validCompletion(c)) { refused.push(r.id); continue; }
    for (const take of c.takes) {
      if (!take || (take.kind !== "cards" && take.kind !== "sealed") || take.id == null) continue;
      const rows = own(mine, take.kind);
      let i = rows.findIndex(x => x && x.id === take.id);
      if (i < 0) {
        const key = rowKey(take.kind, take.id);
        const emptier = emptiedBy.get(key);
        if (!emptier) continue; // nothing to rebuild it from
        if (!hasRow(theirs, take.kind, take.id) && hasRow(base, take.kind, take.id)) continue; // emptied on disk too
        const after = emptier.after && typeof emptier.after === "object" ? emptier.after : {};
        rows.push(Object.assign({}, emptier.gone, after, { id: take.id }));
        revived.add(key);
        i = rows.length - 1;
      }
      rows[i] = undoTake(rows[i], take);
    }
    if (c.historyId != null && Array.isArray(mine.history)) mine.history = mine.history.filter(h => !h || h.id !== c.historyId);
    // The list: this save's completion fields go back to base, so the copy
    // on disk keeps its own. A ship this save added on top still counts:
    // the base copy then reads "picked", so "shipped" is this save's change.
    const lists = own(mine, "pickLists");
    const li = lists.findIndex(x => x && x.id === r.id);
    const list = Object.assign({}, r.m);
    for (const f of COMPLETION_FIELDS) {
      if (r.b[f] === undefined) delete list[f]; else list[f] = r.b[f];
    }
    if (r.m.status === "shipped" && r.t.status === "picked") {
      list.status = "shipped";
      const bl = own(base, "pickLists");
      const bi = bl.findIndex(x => x && x.id === r.id);
      bl[bi] = Object.assign({}, r.b, { status: "picked" });
    }
    lists[li] = list;
    conflicts.push({ array: "pickLists", key: r.id, type: "already-completed", resolution: "theirs" });
  }
  return { base, mine, conflicts, refused, revived };
}

/* The completion mark is for the save that carries it (see above): a copy
   of `state` without any, or `state` itself when it has none. */
function dropCompletionMarks(state) {
  if (!state || !Array.isArray(state.pickLists) || !state.pickLists.some(p => p && p.completion !== undefined)) return state;
  return Object.assign({}, state, {
    pickLists: state.pickLists.map(p => {
      if (!p || p.completion === undefined) return p;
      const q = Object.assign({}, p);
      delete q.completion;
      return q;
    })
  });
}

/* #216: the activity log lines a completion wrote (the pick lines, and the
   listed count it lowered) ride on its mark too, as completion.audit,
   rather than posting to /api/audit on their own: posted apart, a repeat's
   lines landed even though the repeat itself was undone, and the log
   showed the pick twice. store.writeCollection hands back the ones to keep
   (opts.onAudit), and PUT /api/collection logs them:
   - not a repeat this save undid (`conflicts`, from merge() above);
   - and new in this save: the list was open in the document it was
     measured against (`base`). A save whose base already had the list
     completed is one sent again (its reply was lost) or the retry after
     it; the first one kept or dropped its lines already.
   The log drops an id it already holds, so a line sent twice lands once. */
const AUDIT_MAX = 20000;
function completionAudit(sent, base, conflicts) {
  const undone = new Set((conflicts || []).filter(c => c && c.type === "already-completed").map(c => c.key));
  const baseLists = indexBy(base && base.pickLists, "id");
  const out = [];
  for (const p of (sent && Array.isArray(sent.pickLists)) ? sent.pickLists : []) {
    const c = p && p.completion;
    if (!validCompletion(c) || !Array.isArray(c.audit) || undone.has(p.id)) continue;
    if (isDone(baseLists.get(p.id))) continue;
    for (const e of c.audit) {
      if (out.length >= AUDIT_MAX) return out;
      if (e && typeof e === "object" && e.id) out.push(e);
    }
  }
  return out;
}

/* Top-level entry point. base/mine/theirs are each a whole `state` object
   (core.js's stateObject() shape). Returns {merged, conflicts}. Any field
   in mine/theirs this module hasn't been taught about (forward
   compatibility - a new top-level state field added later without a
   matching merge.js update) falls back to the same theirs-wins rule as
   settings/history, rather than being silently dropped.
   `refused` lists repeat completions that couldn't be undone (#214, above):
   the caller must not write `merged` when it isn't empty. */
function merge(base, mine, theirs) {
  base = base || {}; mine = mine || {}; theirs = theirs || {};
  const merged = {};
  const undone = undoRepeatCompletions(base, mine, theirs);
  base = undone.base; mine = undone.mine;
  const conflicts = undone.conflicts.slice();

  for (const [field, cfg] of Object.entries(MERGE_ARRAYS)) {
    const { result, conflicts: c } = mergeArray(base[field], mine[field], theirs[field],
      Object.assign({ name: field }, cfg));
    // A row rebuilt to undo a repeat completion (above) that still ends up
    // empty goes, as the page drops an emptied row.
    merged[field] = undone.revived.size
      ? result.filter(x => !(x && undone.revived.has(rowKey(field, x.id)) && !(x.quantity > 0)))
      : result;
    conflicts.push(...c);
  }

  for (const field of WHOLE_FIELDS) {
    const r = mergeWhole(base[field], mine[field], theirs[field]);
    merged[field] = r.value;
    if (r.conflict) conflicts.push({ array: field, type: "whole-value", resolution: "theirs" });
  }

  const known = new Set([...Object.keys(MERGE_ARRAYS), ...WHOLE_FIELDS]);
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (known.has(k)) continue;
    merged[k] = theirs[k] !== undefined ? theirs[k] : mine[k];
  }

  return { merged, conflicts, refused: undone.refused };
}

module.exports = { merge, mergeArray, mergeEntity, mergeWhole, deepEqual, dropCompletionMarks, completionAudit, MERGE_ARRAYS };
