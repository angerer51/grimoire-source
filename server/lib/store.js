"use strict";
/* On-disk state. One JSON document per thing, written atomically.
   ---------------------------------------------------------------
   Why files and not SQLite: SQLite usually means a native module
   (better-sqlite3/sqlite3), which on Windows means a compiler toolchain,
   which is the single most common reason a "just run it" server does not
   run. A collection is one JSON document that the app already loads whole,
   so a row store buys nothing here. Backups are `xcopy`.

   Exception: server/lib/prices.js uses `node:sqlite` for the price-history
   archive - that's Node's own built-in module (unflagged since 22.13), not a
   native npm package, so it needs no compiler toolchain and doesn't
   contradict this rule. It exists there specifically because that archive
   (tens of millions of rows once fully backfilled) is the one place this
   app's data genuinely outgrew "one JSON document the app loads whole" -
   see that file's own header for the incident history that motivated it.

   dataDir defaults OUTSIDE the project folder on purpose. The Scryfall bulk file
   and the daily price archive are hundreds of megabytes of churn, and putting
   that inside a OneDrive-synced folder turns every card refresh into a sync
   storm. See README, "Where your data lives". */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const merge = require("./merge");
const patchLib = require("./patch");

let DATA_DIR = null;

function defaultDataDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Grimoire", "data");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "grimoire");
  return path.join(os.homedir(), ".local", "share", "grimoire");
}

function init(cfg) {
  DATA_DIR = cfg && cfg.dataDir ? path.resolve(cfg.dataDir) : defaultDataDir();
  for (const d of ["", "users", "stores", "cards", "prices", "prices/day", "prices/series", "orders", "tmp"]) {
    fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
  }
  return DATA_DIR;
}

function dir() {
  if (!DATA_DIR) throw new Error("store.init(cfg) has not run yet");
  return DATA_DIR;
}
const p = (...bits) => path.join(dir(), ...bits);

/* ---------- Atomic read / write ---------- */
async function writeFileAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // pid+timestamp alone can collide: two different users' files share the same
  // basename ("current.json"), so two saves landing in the same millisecond raced
  // onto the same tmp path and one rename() clobbered the other user's data.
  const tmp = path.join(p("tmp"),
    path.basename(file) + "." + process.pid + "." + Date.now() + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
  await fsp.writeFile(tmp, text, "utf8");
  await renameWithRetry(tmp, file);
}

/* Windows refuses a rename onto a file another process has open without
   delete-sharing - Defender scanning the fresh tmp file, the search indexer,
   the hourly backup copying it - with EPERM/EACCES/EBUSY. That is momentary,
   but it failed real requests: 13 times by 2026-10-08 (pick-ticket invites,
   presence flushes, one collection autosave). Retry for ~2s before giving
   up, and never leave the tmp file behind on a final failure. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
async function renameWithRetry(from, to, opts) {
  const delays = (opts && opts.delays) || [10, 20, 40, 80, 160, 320, 500, 800];
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); }
    catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || i >= delays.length) {
        await fsp.unlink(from).catch(() => {});
        throw e;
      }
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
}

/* Failed writes from before renameWithRetry() left their tmp files behind
   (a later save superseded each one). Boot sweeps any older than a day -
   never a fresh one, which could belong to a write in flight. */
async function sweepTmp(maxAgeMs) {
  const dir = p("tmp"), cutoff = Date.now() - (maxAgeMs || 24 * 3600 * 1000);
  let removed = 0;
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.endsWith(".tmp")) continue;
    const f = path.join(dir, name);
    const st = await fsp.stat(f).catch(() => null);
    if (st && st.isFile() && st.mtimeMs < cutoff) { await fsp.unlink(f).catch(() => {}); removed++; }
  }
  return removed;
}

async function readJson(file, fallback, opts) {
  try {
    const text = await fsp.readFile(file, "utf8");
    return JSON.parse(text);
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    // A corrupt document is moved aside rather than silently replaced, so it can
    // still be recovered by hand.
    if (e instanceof SyntaxError) {
      try { await fsp.rename(file, file + ".corrupt." + Date.now()); } catch (e2) {}
      // users.json is the auth store: falling back to {users:[]} makes the very
      // next registration look like "the first user ever" and hands it admin.
      // Fail loudly instead of silently reopening the instance to anyone.
      if (opts && opts.critical) {
        throw new Error(file + " was corrupt and has been moved aside as " +
          file + ".corrupt.<timestamp> - restore it by hand before continuing.");
      }
      return fallback;
    }
    throw e;
  }
}
const writeJson = (file, obj) => writeFileAtomic(file, JSON.stringify(obj, null, 2));
const writeJsonCompact = (file, obj) => writeFileAtomic(file, JSON.stringify(obj));

/* ---------- Per-key write serialisation ----------
   Two autosaves landing at once must not interleave; each key gets a promise
   chain so writes for the same document run in order. */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  // The chain the NEXT caller waits on must never reject, or one failed write
  // would poison every write queued behind it.
  const guarded = run.then(() => {}, () => {});
  locks.set(key, guarded);
  guarded.then(() => { if (locks.get(key) === guarded) locks.delete(key); });
  return run;
}

/* ---------- Users / sessions / jobs ---------- */
const usersFile = () => p("users.json");
const sessionsFile = () => p("sessions.json");
const jobsFile = () => p("jobs.json");
const configuredFile = () => p("instance.json");

const readUsers = () => readJson(usersFile(), { users: [], invites: [] }, { critical: true });
const writeUsers = u => withLock("users", () => writeJson(usersFile(), u));
const readSessions = () => readJson(sessionsFile(), {});
const writeSessions = s => withLock("sessions", () => writeJsonCompact(sessionsFile(), s));
const readJobs = () => readJson(jobsFile(), {});
const writeJobs = j => withLock("jobs", () => writeJson(jobsFile(), j));

/* One-time boot tasks record that they're done here ({ name: ISO date }),
   in their own file rather than jobs.json, which runDueJobs() rewrites on
   its own schedule. */
const migrationsFile = () => p("migrations.json");
const readMigrations = () => readJson(migrationsFile(), {});
function markMigrationDone(name) {
  return withLock("migrations", async () => {
    const doc = await readJson(migrationsFile(), {});
    doc[name] = new Date().toISOString();
    await writeJson(migrationsFile(), doc);
  });
}
/* A boot task that retries on later boots, up to a limit, keeps its count
   of tries here too (#452: { name: n }). */
function noteMigrationTry(name, n) {
  return withLock("migrations", async () => {
    const doc = await readJson(migrationsFile(), {});
    doc[name] = n;
    await writeJson(migrationsFile(), doc);
  });
}
/* Read-modify-write of migrations.json under its lock, for a boot task
   that keeps more than a date or a count (#456: who has been emailed). */
function updateMigrations(mutateFn) {
  return withLock("migrations", async () => {
    const doc = await readJson(migrationsFile(), {});
    const result = await mutateFn(doc);
    await writeJson(migrationsFile(), doc);
    return result;
  });
}

/* ---------- Organizations / Stores (BACKLOG.md #9) ----------
   Instance-wide metadata lists, same "one small JSON file the app loads
   whole" shape as users.json - an org/store record itself is tiny (name,
   ids, timestamps); the actual inventory data for a store lives under
   stores/<id>/ via the same readCollection/writeCollection used for
   personal accounts (see ownerDir() above). */
const orgsFile = () => p("orgs.json");
const storesFile = () => p("stores.json");
const readOrgs = () => readJson(orgsFile(), { orgs: [] });
const writeOrgs = o => withLock("orgs", () => writeJson(orgsFile(), o));
/* Read-modify-write of orgs.json under the "orgs" lock (createOrg). */
function updateOrgs(mutateFn) {
  return withLock("orgs", async () => {
    const doc = await readJson(orgsFile(), { orgs: [] });
    const result = await mutateFn(doc);
    await writeJson(orgsFile(), doc);
    return result === undefined ? doc : result;
  });
}
const readStoreList = () => readJson(storesFile(), { stores: [] });
const writeStoreList = s => withLock("stores", () => writeJson(storesFile(), s));
/* Read-modify-write of stores.json under the one "stores" lock, for a
   change whose check depends on what's already there (refusing to archive
   an org's last active store, #127): two archives landing together must
   not each see the other store as still active. */
function updateStoreList(mutateFn) {
  return withLock("stores", async () => {
    const doc = await readJson(storesFile(), { stores: [] });
    const result = await mutateFn(doc);
    await writeJson(storesFile(), doc);
    return result === undefined ? doc : result;
  });
}

/* Turns an existing personal account's collection into a Store's, used once
   when an account creates an Organization (its current collection becomes
   the org's first Store rather than being lost or duplicated). Moves
   current.json + the whole rev/ archive in place - a rename, not a copy -
   so revision history survives intact. Locks both owner keys for the
   duration so a save that's mid-flight against the old location can't land
   after the move starts.

   Also moves audit/day: audit history lives in its own day-sharded tree
   (server/lib/audit.js), entirely separate from current.json/rev, so it was
   missed here originally - a real account's pre-existing audit history was
   found stranded at the old users/<id>/audit/ location after converting to
   an org, invisible once resolveDocOwner started pointing every read/write
   at the new store (BACKLOG.md #9). prefs.json is deliberately NOT moved:
   it carries account-scoped things (Manapool/Pitney Bowes credentials, the
   Friends list) a Store doesn't have its own copy of yet - see #9's "what's
   left" on per-store credentials.

   #186: the locks are the ones a save to either side takes (collLock(),
   canonical owner keys), plus each side's audit lock (audit.js), so a save
   or an audit append arriving at the same moment runs wholly before or
   wholly after the move, never into a folder being renamed away. Once the
   files have moved, the in-memory save history for the personal key
   (snapshots, saveIds, kept merge bases) is dropped: it describes a
   collection that now lives under the Store's key, and the personal
   folder starts empty again. A save still addressed to the personal key
   (sent just before the org existed) then gets the ordinary 409 instead
   of being merged against that history into the empty folder. */
async function moveCollectionToStore(fromUserId, toStoreId) {
  const fromKey = canonicalOwner(fromUserId), toKey = canonicalOwner("store:" + toStoreId);
  return withLock(collLock(fromKey), () => withLock(collLock(toKey), () =>
    withLock("audit:" + fromKey, () => withLock("audit:" + toKey, async () => {
    await fsp.mkdir(ownerDir(toKey), { recursive: true });
    const fromDir = ownerDir(fromKey);
    for (const name of ["current.json", "rev"]) {
      const src = path.join(fromDir, name);
      const dest = path.join(ownerDir(toKey), name);
      try { await fsp.rename(src, dest); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    const fromAudit = path.join(fromDir, "audit", "day");
    const toAudit = path.join(ownerDir(toKey), "audit", "day");
    try {
      await fsp.mkdir(toAudit, { recursive: true });
      for (const f of await fsp.readdir(fromAudit)) {
        if (!f.endsWith(".json")) continue;
        // A day-file already present at the destination (today's activity,
        // logged post-switch before this move runs) wins the collision - it
        // reflects the account's Store-scoped audit trail already in
        // progress, whereas the source side is always pre-conversion
        // history for that same account. Extremely unlikely (the move
        // happens synchronously right after org creation) but silent data
        // loss on either side is worse than a very rare skipped file.
        const dest = path.join(toAudit, f);
        try { await fsp.access(dest); continue; } catch (e) {}
        await fsp.rename(path.join(fromAudit, f), dest);
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    forgetOwner(fromKey);
  }))));
}

/* ---------- Support tickets ----------
   One shared document, same "one JSON file the app loads whole" shape as
   users.json/jobs.json - this is a self-hosted app's support queue, not a
   call-center's, so a row store buys nothing here either. */
const ticketsFile = () => p("tickets.json");
const readTickets = () => readJson(ticketsFile(), { tickets: [] });
const writeTickets = t => withLock("tickets", () => writeJson(ticketsFile(), t));

/* Read-modify-write with the lock held across the WHOLE cycle, not just the
   write - readTickets() then writeTickets(db) as two separate calls (the
   pattern most callers used to use) leaves a window where two concurrent
   requests touching the same ticket (an owner and a staff reply landing
   within milliseconds of each other, a completely ordinary support
   interaction) both read the same starting state and the second write
   silently discards the first caller's change, with no error to either
   side. writeCollection() above already gets this right; this is the same
   shape for the tickets document. mutateFn may be sync or async; its
   return value (if not undefined) is what the call resolves to, otherwise
   the whole mutated document is returned. */
function updateTickets(mutateFn) {
  return withLock("tickets", async () => {
    const db = await readJson(ticketsFile(), { tickets: [] });
    const result = await mutateFn(db);
    await writeJson(ticketsFile(), db);
    return result === undefined ? db : result;
  });
}

/* ---------- Invite requests (#238) ----------
   What the sign-up page's "Request an invite" form sends, waiting for an
   admin. Same one-small-document shape and whole-cycle lock as tickets.json
   above; server/lib/inviteRequests.js keeps it bounded. No file handle is
   held between calls. */
const inviteRequestsFile = () => p("invite-requests.json");
const readInviteRequests = () => readJson(inviteRequestsFile(), { requests: [] });
function updateInviteRequests(mutateFn) {
  return withLock("invite-requests", async () => {
    const db = await readJson(inviteRequestsFile(), { requests: [] });
    if (!Array.isArray(db.requests)) db.requests = [];
    const result = await mutateFn(db);
    await writeJson(inviteRequestsFile(), db);
    return result === undefined ? db : result;
  });
}

/* ---------- Collections ----------
   One folder per user. current.json is the live document; rev/ keeps the last
   REVISIONS writes so a bad autosave (or a bad import) is recoverable from the
   server even after the browser's undo stack is gone. */
const REVISIONS = 30;
/* Autosave fires on a 1.5s debounce (public/js/core.js), and until now every
   single one of those also archived a full copy of the outgoing state as a
   revision - a rapid string of quantity-bump edits meant a second full-
   document write for every one, and burned through the 30-slot revision
   history in minutes instead of covering a useful span of time. Revisions
   are a coarse "undo a disaster" net (the client's own 25-entry undo stack
   already covers per-click undo), so archiving is throttled to at most once
   per interval - the current document itself is still written in full on
   every save either way, only the extra archive copy is skipped when the
   last one is still fresh. Process-local by design: a restart just means the
   next save after it archives regardless of the interval, which is fine. */
const REVISION_MIN_INTERVAL_MS = 5 * 60 * 1000;
const lastRevisionAt = new Map();
/* The throttle above must never cost the version a destructive save throws
   away (#157). Erase, a Replace import and Restore promise "the current
   version stays in the revision list", but with only the throttle the
   newest revision could be up to 5 minutes older than what they replaced.
   So writeCollection() always archives when opts.forceRevision is set
   (Restore, and a PUT whose client flagged it as an Erase/Replace), and,
   as a net for anything that forgets the flag (a stale tab, a future
   feature), when a save drops more than half the stacks of a collection
   that had at least MASS_DROP_MIN_STACKS.

   Those out-of-schedule copies must not be a cheap way to flush the real
   history (PR #171 review): emptying and refilling a collection 60 times in
   a minute would otherwise push all 30 spaced revisions out. So a revision
   archived only because it was forced (the 5-minute spacing hadn't passed)
   is marked "forced" in its summary and kept in a separate, smaller set:
   pruning keeps the newest REVISIONS ordinary revisions AND the newest
   FORCED_REVISIONS forced ones, and a forced copy never evicts an ordinary
   one. Forced copies don't move the spacing clock either, so the ordinary
   history keeps its usual 5-minute cadence whatever happens around it.
   Every forced save still keeps the version just before it. */
const FORCED_REVISIONS = 10;
const MASS_DROP_MIN_STACKS = 50;
function dropsMostStacks(before, after) {
  const was = before && Array.isArray(before.cards) ? before.cards.length : 0;
  const now = after && Array.isArray(after.cards) ? after.cards.length : 0;
  return was >= MASS_DROP_MIN_STACKS && now < was / 2;
}

/* What the Settings revision table shows for one revision. Stored at the
   front of each revision file (see revisionText()) so listing them reads a
   few hundred bytes per file instead of parsing 30 whole collections
   (#158: 224 MB and ~1 s of blocking JSON.parse per Settings visit). */
function revisionSummary(state) {
  const st = state || {};
  const cards = Array.isArray(st.cards) ? st.cards : [];
  return {
    stacks: cards.length,
    cards: cards.reduce((s, c) => s + (Number(c && c.quantity) || 0), 0),
    locations: Array.isArray(st.locations) ? st.locations.length : 0
  };
}
/* Key order is the file format: rev, savedAt, summary, then the (large)
   state, so the summary sits in the first few hundred bytes. */
function revisionText(rev, savedAt, state, forced) {
  const summary = revisionSummary(state);
  if (forced) summary.forced = true;
  return JSON.stringify({ rev, savedAt: savedAt || null, summary, state });
}

/* In-memory-only rolling buffer of recent full states, per owner key -
   the merge-base source for writeCollection()'s three-way merge below.
   Separate from (and much shorter-lived than) the on-disk rev/ archive
   above: that one is a throttled, permanent "undo a disaster" net capped
   at REVISIONS slots; this one exists purely so a save whose baseRev has
   since moved can still find what it was diffing against, and only needs
   to cover the gap between "a client last synced" and "that client saves
   again" - a handful of revisions, not a long history. Process-local by
   design: a restart empties it, and writeCollection() degrades to the old
   hard 409 reject when a lookup misses, so that's a safe, low-risk failure
   mode rather than a new one - which is exactly what makes the OWNER_CAP
   eviction below safe too, not just the per-owner SIZE cap: evicting a
   whole owner's buffer early just means their next stale-baseRev save takes
   the same already-accepted degraded path, not a new failure mode.

   Found genuinely unbounded at the OWNER level while adding test coverage
   for this file (BACKLOG #20): SNAPSHOT_BUFFER_SIZE only ever capped each
   individual owner's inner Map, but the outer Map gained one permanent
   entry per distinct owner key this process has EVER seen a save from, for
   the life of the process - fine at this app's actual current scale (order
   of 100 accounts, per the backup-verification numbers in BACKLOG.md), but
   a real long-lived-process leak as accounts accumulate over time, and
   exactly the "never add a cache without an explicit bound" rule this
   codebase otherwise holds itself to (see cards.js's shard/rank caches). */
const SNAPSHOT_BUFFER_SIZE = 50;
const SNAPSHOT_OWNER_CAP = 500; // bounds total distinct owners kept warm at once, not just each one's own history
const snapshotBuffers = new Map(); // ownerKey -> Map(rev -> state), insertion-ordered
function rememberSnapshot(ownerKey, rev, state) {
  let buf = snapshotBuffers.get(ownerKey);
  snapshotBuffers.delete(ownerKey); // re-insert at the end - LRU at the owner level too, not just within one owner's buffer
  if (!buf) buf = new Map();
  snapshotBuffers.set(ownerKey, buf);
  buf.delete(rev); // re-insert at the end so it counts as freshest, not evicted early
  buf.set(rev, state);
  if (buf.size > SNAPSHOT_BUFFER_SIZE) buf.delete(buf.keys().next().value);
  if (snapshotBuffers.size > SNAPSHOT_OWNER_CAP) snapshotBuffers.delete(snapshotBuffers.keys().next().value);
}
function findSnapshot(ownerKey, rev) {
  const buf = snapshotBuffers.get(ownerKey);
  return buf ? buf.get(rev) : undefined;
}

/* Idempotent saves (#175, docs/flows/collection-save.dot). A save the
   server already applied can reach it again: the reply was lost (a phone
   changing networks, a proxy error after the write), a page hidden mid-save
   saw it fail although it landed, or the browser itself retried the PUT.
   Merged against itself, every quantity change in it would count twice
   (merge.js adds quantity deltas). So the browser names every PUT with a
   fresh saveId, and while earlier PUTs are unanswered the next one lists
   them as afterSaveIds. Per owner, the last SAVE_IDS_PER_OWNER committed
   saveIds are kept here with the rev each became:
   - a PUT whose own saveId is here is answered with that earlier result,
     with no write and no merge;
   - a PUT whose afterSaveIds include one committed at rev X takes X as its
     base, since its own earlier save is already in;
   - an afterSaveId not seen yet is noted as covered by this PUT, so if
     that earlier request turns up late it is answered, not applied.
   In memory only, bounded the same way as the snapshot buffer above (per
   owner, and LRU across owners); a restart or an eviction falls back to
   today's behaviour (the PUT's own rev is the base). Each record is a few
   numbers and strings.

   One wrinkle: when the earlier save was itself MERGED with someone else's
   edit, the state written at X holds that other edit, and the browser
   never saw it (it never got the reply). Diffing the browser's next save
   against X would read the other edit as "mine removed it" and undo it.
   The right base is what the earlier save sent, so that state is kept for
   merged saves only. Once it is gone, a save that needs it gets the
   ordinary 409 rather than a guess.

   Memory (#187): each kept state is close to a whole extra copy of a
   collection. It is the document parsed from the request, and the merge
   reuses only the rows this save changed (every other row in the merged
   result, and so in the snapshot buffer, is the version already on the
   server), so nearly all of it is held here alone. Live collections reach
   about 8 MB of JSON, about 9.5 MB once parsed. So the states are bounded
   twice, oldest evicted first, across all owners: at most SENT_STATE_CAP
   of them, and at most SENT_STATE_BYTES of request JSON between them
   (the size of the PUT body each came in, which the route passes as
   opts.sentBytes, or the state's own JSON length if it doesn't). 40 MB
   keeps five of the largest collections, or all ten of anything under
   4 MB, for about 50 MB of heap at most (up to ~80 MB if rows parse less
   compactly), against the ~1.6 GB the card index takes. A state is only
   needed between a merged save whose reply was lost and that page's next
   save, seconds to minutes later, so five at once is plenty. One bigger
   than the whole budget isn't kept at all. */
const SAVE_IDS_PER_OWNER = 50;
const SAVE_ID_OWNER_CAP = 500;
const SENT_STATE_CAP = 10;
const SENT_STATE_BYTES = 40 * 1024 * 1024;
const SAVE_ID_RX = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_AFTER_SAVE_IDS = 20;
const committedSaves = new Map(); // ownerKey -> Map(saveId -> { rev, savedAt, merged, conflicts })
const sentStates = new Map();     // ownerKey + "\n" + saveId -> { state a merged save diffed as "mine", bytes }
let sentStateBytes = 0;           // sum of sentStates' bytes
const validSaveId = s => typeof s === "string" && SAVE_ID_RX.test(s);
function dropSentState(k) {
  const e = sentStates.get(k);
  if (!e) return;
  sentStates.delete(k);
  sentStateBytes -= e.bytes;
}
function keepSentState(k, state, bytes) {
  dropSentState(k);
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : JSON.stringify(state).length;
  if (n > SENT_STATE_BYTES) return; // can't fit even alone: its retry gets the 409
  sentStates.set(k, { state, bytes: n });
  sentStateBytes += n;
  while (sentStates.size > SENT_STATE_CAP || sentStateBytes > SENT_STATE_BYTES) {
    dropSentState(sentStates.keys().next().value);
  }
}
function sentStateFor(ownerKey, saveId) {
  const e = sentStates.get(ownerKey + "\n" + saveId);
  return e ? e.state : undefined;
}
function rememberSave(ownerKey, saveId, rec, sent, sentBytes) {
  let m = committedSaves.get(ownerKey);
  committedSaves.delete(ownerKey); // LRU at the owner level, as rememberSnapshot does
  if (!m) m = new Map();
  committedSaves.set(ownerKey, m);
  m.set(saveId, rec);
  if (m.size > SAVE_IDS_PER_OWNER) m.delete(m.keys().next().value);
  if (committedSaves.size > SAVE_ID_OWNER_CAP) committedSaves.delete(committedSaves.keys().next().value);
  if (sent !== undefined) keepSentState(ownerKey + "\n" + saveId, sent, sentBytes);
}
/* Everything remembered in memory about one collection (#186: its files
   just moved to a Store, see moveCollectionToStore). */
function forgetOwner(ownerKey) {
  const k = canonicalOwner(ownerKey);
  snapshotBuffers.delete(k);
  committedSaves.delete(k);
  lastRevisionAt.delete(k);
  for (const sk of Array.from(sentStates.keys())) if (sk.startsWith(k + "\n")) dropSentState(sk);
}
/* For tests: how much the kept merge bases hold right now. */
function sentStateStats() { return { count: sentStates.size, bytes: sentStateBytes, cap: SENT_STATE_CAP, budget: SENT_STATE_BYTES }; }
function findSave(ownerKey, saveId) {
  const m = committedSaves.get(ownerKey);
  return m ? m.get(saveId) : undefined;
}
// The latest committed save among afterSaveIds, or null.
function latestCommitted(ownerKey, ids) {
  if (!Array.isArray(ids)) return null;
  let best = null;
  for (const id of ids.slice(-MAX_AFTER_SAVE_IDS)) {
    if (!validSaveId(id)) continue;
    const r = findSave(ownerKey, id);
    // A save covered by a later one (r.via, below) stands for that one.
    if (r && (!best || r.rev > best.rev)) best = Object.assign({}, r, { saveId: r.via || id });
  }
  return best;
}
/* An earlier save this one lists but the server hasn't seen may still be on
   its way (the page gave up on the connection, the request didn't): this
   save already carries everything in it, so when it does arrive it is
   answered as a copy of this one and never applied. */
function rememberCovered(ownerKey, ids, saveId, rec) {
  if (!Array.isArray(ids)) return;
  for (const id of ids.slice(-MAX_AFTER_SAVE_IDS)) {
    if (validSaveId(id) && id !== saveId && !findSave(ownerKey, id)) {
      rememberSave(ownerKey, id, Object.assign({ via: saveId }, rec));
    }
  }
}

/* #145: a save says which inventory its page loaded (GET /api/collection's
   `owner`, echoed back). One from a page that loaded a different inventory
   than the one this session now acts on (the store was switched in another
   tab) is refused: never merged, never written. `loaded` null or undefined
   is a page still running the JS from before this check, which keeps
   today's behaviour (see PUT /api/collection). */
function ownerMismatch(loaded, ownerKey) {
  return loaded != null && canonicalOwner(loaded) !== canonicalOwner(ownerKey);
}
function wrongOwnerError(loaded) {
  const e = new Error("This page was loaded for a different inventory. Reload to continue.");
  e.status = 409;
  e.wrongOwner = true;
  e.loadedOwner = String(loaded);
  return e;
}

/* The answer a save got the first time, given again for a copy of it. A
   merged save's answer carried the merged document, which the page adopts;
   that is the state written at its rev (the snapshot buffer, or the file
   if nothing has been saved since). If neither is to hand any more, the
   page is told to reload rather than handed a document it can't use. */
async function replayResult(ownerKey, done) {
  const result = { rev: done.rev, savedAt: done.savedAt, replayed: true };
  if (!done.merged) return result;
  let st = findSnapshot(ownerKey, done.rev);
  if (st === undefined) {
    const cur = await readCollection(ownerKey);
    if (cur.rev === done.rev) st = cur.state;
  }
  if (st === undefined) throw staleRevError({ rev: (await readCollection(ownerKey)).rev }, done.rev);
  return Object.assign(result, { merged: true, conflicts: done.conflicts || [], state: st });
}

/* #214 (merge.js "Repeat completions"): this save completes pick lists
   another device already completed, from a tab whose completion can't be
   undone on its own (opened before #214). Refused whole, nothing written,
   rather than taking those cards off inventory a second time. */
function alreadyCompletedError(cur, ids) {
  const e = new Error("Already completed on another device - reload. " +
    (ids.length === 1 ? "Pick list " + ids[0] + " was" : "Pick lists " + ids.join(", ") + " were") +
    " completed somewhere else first, so this save was not applied: its cards would have come off twice.");
  e.status = 409;
  e.serverRev = cur.rev;
  e.alreadyCompleted = ids.slice(0, 50);
  return e;
}

/* #181: a patch save (patch.js) that doesn't fit the document at its rev,
   or whose rev the server no longer holds. Nothing was written; the page
   sends the whole document instead (core.js flushSave). */
function patchRefusedError(cur, why) {
  const e = new Error("This change couldn't be applied on its own (" + why + "). Send the whole collection.");
  e.status = 422;
  e.patchRefused = true;
  e.serverRev = cur.rev;
  return e;
}

function staleRevError(cur, baseRev) {
  const e = new Error("This collection was changed somewhere else (server revision " +
    cur.rev + ", you sent " + baseRev + "). Reload before saving again.");
  e.status = 409;
  e.serverRev = cur.rev;
  return e;
}

const userDir = userId => p("users", String(userId));

/* Collection documents (current.json + rev/) live under one of two roots:
   users/<id> for a personal account (today's exact layout, unchanged) or
   stores/<id> for a Store under an Organization (BACKLOG.md #9). The
   functions below all take a single "owner key" string rather than a bare
   user id so one set of read/write/revision code serves both - a bare id
   with no ":" resolves exactly as it always has (users/<id>), so every
   existing call site (store.readCollection(user.id), etc.) keeps working
   completely unchanged. Only a caller that explicitly wants a Store's
   document passes the "store:<id>" form. */
function ownerDir(ownerKey) {
  const s = String(ownerKey);
  if (s.startsWith("store:")) return p("stores", s.slice(6));
  if (s.startsWith("user:")) return p("users", s.slice(5));
  return p("users", s);
}

/* One name per collection folder (#186). ownerDir() accepts a personal
   account as "user:<id>", "<id>" or the number <id>, and all three are the
   same folder, but a lock or an in-memory map keyed on the raw value
   treated them as three different owners: Create organization's move
   locked "coll:user:<id>" while that account's saves locked "coll:<id>",
   so the two weren't kept in order. Everything keyed per collection (the
   "coll:" lock, the revision-list lock, the snapshot buffer, the saveId
   memory and kept merge bases, the revision throttle) goes through this:
   the bare id for a personal account (what resolveDocOwner() and GET
   /api/collection's `owner` already use), "store:<id>" for a Store. */
function canonicalOwner(ownerKey) {
  const s = String(ownerKey);
  return s.startsWith("user:") ? s.slice(5) : s;
}
function collLock(ownerKey) { return "coll:" + canonicalOwner(ownerKey); }
const collectionFile = ownerKey => path.join(ownerDir(ownerKey), "current.json");
const revDir = ownerKey => path.join(ownerDir(ownerKey), "rev");
/* prefs.json is genuinely mixed-concern (personal login-adjacent settings
   like the Friends list alongside more operational state like
   bulkPriceJobs bookkeeping - see priceRules.js) - generalized through the
   same ownerDir() as the collection itself so a Store can eventually carry
   its own prefs.json (e.g. its own Manapool credentials, not built yet -
   BACKLOG.md #9's "what's left") without another path-building bug like
   the one this same generalization already fixed once in audit.js. A bare
   id keeps reading/writing users/<id>/prefs.json exactly as before. */
const prefsFile = ownerKey => path.join(ownerDir(ownerKey), "prefs.json");

async function ensureUserDir(ownerKey) {
  await fsp.mkdir(revDir(ownerKey), { recursive: true });
}

async function readCollection(ownerKey) {
  const doc = await readJson(collectionFile(ownerKey), null);
  if (!doc) return { rev: 0, savedAt: null, state: null };
  return {
    rev: Number(doc.rev) || 0,
    savedAt: doc.savedAt || null,
    state: doc.state || null
  };
}

/* A cheap "has this collection changed" token: the live document's mtime and
   size, without reading or parsing it (a 70k-stack collection is a large
   JSON file). Every save replaces current.json via an atomic rename, so the
   stamp changes with it. prices.js keys its per-account result caches on
   this, so a collection save invalidates them with no explicit hook. */
async function collectionStamp(ownerKey) {
  try {
    const st = await fsp.stat(collectionFile(ownerKey));
    return st.mtimeMs + ":" + st.size;
  } catch (e) {
    return "none";
  }
}

/* Optimistic concurrency: the browser sends the rev it last saw. If nobody
   else has saved since (the overwhelmingly common case), this is an exact,
   unchanged fast path - same CAS as always, no merge involved. If someone
   else HAS saved concurrently, try a three-way merge (merge.js) before
   giving up: look up the state as of the client's baseRev in the rolling
   snapshot buffer above and merge base/incoming/current. Only when that
   base isn't available (a restart, or an edit old enough to have aged out
   of the buffer) does this fall back to the original hard 409 reject -
   baseRev === -1 still means "I do not care, take it" (restore/"Keep
   mine"), skipping all of the above same as before. */
/* opts.carryForward: top-level fields to keep from what's on disk when the
   incoming state doesn't have them AT ALL (undefined, not an empty array).
   That shape means a browser still running a core.js from before the field
   existed - a tab left open across a deploy - and its save must not wipe
   data it never knew about (#50: customers, which are personal data the
   seller entered by hand). An empty array is a deliberate "none" and is
   written as sent. In a merged save the missing field is treated as
   "mine didn't touch it" (the base's value), so theirs wins cleanly.
   opts.onWrite(before, after): called once the new document is on disk,
   still inside the lock, with the state it replaced and the state written
   (merged, if it was). Must be quick and must not throw: PUT
   /api/collection uses it to spot new "came in" matches (#139).
   opts.forceRevision: archive the outgoing version whatever the throttle
   says (#157, see dropsMostStacks above).
   opts.lockSettings: keys of state.settings this save may not change; they
   keep what's on disk whatever the incoming (or merged) state says (#159:
   a Store's defaults are its managers' to change, and the per-person
   preferences no longer live in a Store's document at all). */
function lockSettings(state, keys, from) {
  if (!keys || !keys.length || !from || !state) return state;
  const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
  const was = plain(from.settings) ? from.settings : {};
  // No settings sent (missing, null, not an object): keep what's on disk,
  // or a hand-made save could wipe the locked keys along with the rest
  // (PR #171 review).
  if (!plain(state.settings)) return Object.assign({}, state, { settings: Object.assign({}, was) });
  const inc = state.settings;
  let out = null;
  for (const k of keys) {
    const same = JSON.stringify(inc[k]) === JSON.stringify(was[k]);
    if (same) continue;
    if (!out) out = Object.assign({}, inc);
    if (was[k] === undefined) delete out[k]; else out[k] = was[k];
  }
  return out ? Object.assign({}, state, { settings: out }) : state;
}

function carryForward(state, fields, from) {
  if (!fields || !from) return state;
  let out = state;
  for (const k of fields) {
    if (state[k] === undefined && from[k] !== undefined) {
      if (out === state) out = Object.assign({}, state);
      out[k] = from[k];
    }
  }
  return out;
}

/* opts.saveId / opts.afterSaveIds: see "Idempotent saves" above (#175).
   opts.sentBytes: the request body's size, for the kept merge base's
   memory budget (#187).
   opts.loadedOwner: see ownerMismatch() above (#145).
   opts.patch (#181, patch.js): `state` is ignored; the document is rebuilt
   from the patch and the state this collection had at baseRev (on disk, or
   the snapshot buffer), inside the lock, and then saved exactly as a full
   save of it would be. A patch that can't be rebuilt throws a 422
   (patchRefusedError) and writes nothing.
   opts.mutate (#433, updateCollection below): `state` and baseRev are
   ignored; mutate(draft) gets a private copy of the saved state, inside the
   lock, changes it in place and returns { write, result }. write false:
   nothing is written, and { unchanged: true, result } comes back. */
async function writeCollection(ownerKey, state, baseRev, opts) {
  ownerKey = canonicalOwner(ownerKey); // #186: one lock and one memory per folder
  const keep = opts && opts.carryForward;
  const loaded = opts && opts.loadedOwner;
  if (ownerMismatch(loaded, ownerKey)) throw wrongOwnerError(loaded);
  const saveId = opts && validSaveId(opts.saveId) ? opts.saveId : null;
  return withLock(collLock(ownerKey), async () => {
    // Already applied: answer it again, and change nothing. Inside the
    // lock, so a copy arriving while the original is still being written
    // waits for it and then finds it here.
    const done = saveId ? findSave(ownerKey, saveId) : undefined;
    if (done) return replayResult(ownerKey, done);
    await ensureUserDir(ownerKey);
    const cur = await readCollection(ownerKey);
    rememberSnapshot(ownerKey, cur.rev, cur.state); // capture the pre-write state as a possible future merge base
    let mutated;
    if (opts && typeof opts.mutate === "function") {
      // A copy: cur.state is now the merge base kept for this revision.
      const draft = structuredClone(cur.state || { cards: [], locations: [] });
      mutated = (await opts.mutate(draft)) || {};
      if (!mutated.write) return { rev: cur.rev, savedAt: cur.savedAt, unchanged: true, result: mutated.result };
      state = draft;
      baseRev = cur.rev; // made from what's on disk: nothing to merge
    }
    const patched = !!(opts && opts.patch);
    if (patched) {
      const b = baseRev == null ? -1 : Number(baseRev);
      const at = b === -1 ? undefined : b === cur.rev ? cur.state : findSnapshot(ownerKey, b);
      const r = at ? patchLib.applyPatch(at, opts.patch) : { refused: "revision " + b + " isn't held any more" };
      if (r.refused) throw patchRefusedError(cur, r.refused);
      if (!Array.isArray(r.state.cards) || !Array.isArray(r.state.locations)) throw patchRefusedError(cur, "no cards or locations");
      state = r.state;
    }
    const sent = state; // with its completion marks, for completionAudit below
    let auditBase = cur.state;
    let mergeInfo = null;
    let mine; // what a merged save diffed as its own, kept for a later save (above)
    if (baseRev != null && baseRev !== -1) {
      let b = Number(baseRev);
      let base;          // undefined: no merge (the fast path)
      let needsMerge = false;
      const after = latestCommitted(ownerKey, opts && opts.afterSaveIds);
      if (after && after.rev > b && after.merged) {
        // Its earlier save was merged: diff against what that save sent,
        // never against the merged result (see above). Even when nothing
        // has been saved since, the browser lacks the merged-in edit.
        base = sentStateFor(ownerKey, after.saveId);
        if (base === undefined) throw staleRevError(cur, baseRev);
        needsMerge = true;
      } else {
        if (after && after.rev > b) b = after.rev;
        if (b !== cur.rev) {
          base = findSnapshot(ownerKey, b);
          if (base === undefined) throw staleRevError(cur, baseRev);
          needsMerge = true;
        }
      }
      if (needsMerge) {
        state = carryForward(state, keep, base);
        mine = state;
        const { merged, conflicts, refused } = merge.merge(base, state, cur.state);
        if (refused && refused.length) throw alreadyCompletedError(cur, refused);
        state = merged;
        mergeInfo = { merged: true, conflicts };
        auditBase = base;
      }
    }
    state = carryForward(state, keep, cur.state);
    state = merge.dropCompletionMarks(state); // #214: only the save carrying it needs it
    if (cur.state) state = lockSettings(state, opts && opts.lockSettings, cur.state);
    const rev = cur.rev + 1;
    const doc = { rev, savedAt: new Date().toISOString(), state };
    await writeFileAtomic(collectionFile(ownerKey), JSON.stringify(doc));
    rememberSnapshot(ownerKey, rev, state);
    // Recorded the moment it is on disk, before anything below that could
    // still fail the request: a save that errors after this point has
    // landed, and its retry must know that.
    if (saveId) {
      const rec = { rev, savedAt: doc.savedAt, merged: !!mergeInfo, conflicts: mergeInfo ? mergeInfo.conflicts.slice(0, 100) : undefined };
      rememberCovered(ownerKey, opts && opts.afterSaveIds, saveId, rec);
      // A patch's body is no measure of the state kept: keepSentState sizes it.
      rememberSave(ownerKey, saveId, rec, mine, patched ? undefined : opts && Number(opts.sentBytes));
    }
    if (opts && typeof opts.onWrite === "function") {
      try { opts.onWrite(cur.state, state); } catch (e) { /* a hook never fails a save */ }
    }
    // #216 (merge.js completionAudit): the activity log lines of the
    // completions this save made and kept, for the caller to log. A save
    // answered again (replayResult) logged its own the first time.
    if (opts && typeof opts.onAudit === "function") {
      const lines = merge.completionAudit(sent, auditBase, mergeInfo && mergeInfo.conflicts);
      if (lines.length) { try { opts.onAudit(lines); } catch (e) { /* a hook never fails a save */ } }
    }
    // Keep the outgoing version as a revision (throttled, see REVISION_MIN_INTERVAL_MS,
    // unless this save must keep it: #157), then prune.
    const now = Date.now();
    const force = !!(opts && opts.forceRevision) || dropsMostStacks(cur.state, state);
    const due = (now - (lastRevisionAt.get(ownerKey) || 0)) >= REVISION_MIN_INTERVAL_MS;
    if (cur.state && (force || due)) {
      const stamp = String(cur.rev).padStart(8, "0");
      await writeFileAtomic(path.join(revDir(ownerKey), stamp + ".json"), revisionText(cur.rev, cur.savedAt, cur.state, !due));
      if (due) lastRevisionAt.set(ownerKey, now); // a forced copy doesn't move the spacing clock
      await pruneRevisions(ownerKey);
    }
    const result = { rev, savedAt: doc.savedAt };
    if (mergeInfo) Object.assign(result, mergeInfo, { state });
    if (mutated) result.result = mutated.result;
    return result;
  });
}

/* A change the server itself makes to a collection (#433: a kiosk order),
   read, decided and written under the collection's own lock, so no save can
   land between what mutate saw and what it writes. A browser's next save is
   merged with it as with any other device's save. mutate(state) changes the
   state in place and returns { write, result }; resolves { rev, result }, or
   { unchanged: true, result } when write was false. */
function updateCollection(ownerKey, mutate) {
  return writeCollection(ownerKey, null, null, { mutate });
}
/* fn(collection, stamp) inside the collection's lock (#433), after any save
   in flight, so what it reads is one whole saved version. */
function readCollectionLocked(ownerKey, fn) {
  const key = canonicalOwner(ownerKey);
  return withLock(collLock(key), async () => fn(await readCollection(key), await collectionStamp(key)));
}

/* Listing revisions (#158). A revision file written since #158 starts
   {"rev":N,"savedAt":...,"summary":{...},"state":... (revisionText()), so
   its row comes from the first REV_HEAD_BYTES of the file. A file written
   before that has no summary: it is parsed once, here, and rewritten in
   place with the summary in front (the same bytes of state, spliced, not
   re-serialised), so it never needs parsing again. Live sizes when this
   shipped: four owners with 30 old files each, 79-224 MB per owner, about
   7 MB per file at most. One file at a time, yielding between files, so
   that one-off cost never blocks the server for more than one file's
   parse; a second listing for the same owner waits for the first instead
   of repeating it. */
const REV_HEAD_BYTES = 1024;
const REV_HEAD_RE = /^\{"rev":(\d+),"savedAt":(null|"[^"\\]*"),"summary":(\{[^{}]*\}),"state":/;
const LEGACY_HEAD_RE = /^\{"rev":(\d+),"savedAt":(null|"[^"\\]*"),"state":/;

async function readHead(file) {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(REV_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, REV_HEAD_BYTES, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally { await fh.close(); }
}

function rowFromHead(head) {
  const m = REV_HEAD_RE.exec(head);
  if (!m) return null;
  try {
    const s = JSON.parse(m[3]);
    const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
    const row = { rev: Number(m[1]), savedAt: JSON.parse(m[2]), stacks: num(s.stacks), cards: num(s.cards), locations: num(s.locations) };
    if (s.forced === true) row.forced = true;
    return row;
  } catch (e) { return null; }
}

/* An old-format file: parse it once, add the summary, rewrite it. The
   rewrite happens under the collection's own lock (pruning runs there) and
   only if the file is still there, so it can't resurrect a pruned one. A
   failed rewrite still returns the row; the next listing just tries again. */
async function backfillRevision(ownerKey, file) {
  let text;
  try { text = await fsp.readFile(file, "utf8"); } catch (e) { return null; }
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    // Same as readJson(): a corrupt document is moved aside, not deleted.
    await fsp.rename(file, file + ".corrupt." + Date.now()).catch(() => {});
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const summary = revisionSummary(doc.state);
  const row = Object.assign({ rev: doc.rev, savedAt: doc.savedAt || null }, summary);
  const m = LEGACY_HEAD_RE.exec(text);
  const rewritten = m && Number(m[1]) === doc.rev
    ? text.slice(0, m[0].length - '"state":'.length) + '"summary":' + JSON.stringify(summary) + "," + text.slice(m[0].length - '"state":'.length)
    : revisionText(doc.rev, doc.savedAt, doc.state);
  doc = null; text = null; // let the parsed collection go before the write
  await withLock(collLock(ownerKey), async () => {
    try { await fsp.access(file); } catch (e) { return; }
    await writeFileAtomic(file, rewritten);
  }).catch(() => {});
  return row;
}

/* Keeps the newest REVISIONS ordinary revisions and, separately, the newest
   FORCED_REVISIONS forced ones (see FORCED_REVISIONS above). Runs inside
   writeCollection()'s lock. A file with no readable summary (written before
   #158) counts as ordinary, as it always was. Reads ~1 KB per file, about
   40 files at most. */
async function pruneRevisions(ownerKey) {
  try {
    const files = (await fsp.readdir(revDir(ownerKey))).filter(f => /^\d+\.json$/.test(f)).sort().reverse();
    let ordinary = 0, forced = 0;
    for (const f of files) {
      const file = path.join(revDir(ownerKey), f);
      let row = null;
      try { row = rowFromHead(await readHead(file)); } catch (e) { continue; }
      const isForced = !!(row && row.forced);
      const kept = isForced ? ++forced <= FORCED_REVISIONS : ++ordinary <= REVISIONS;
      if (!kept) await fsp.unlink(file).catch(() => {});
    }
  } catch (e) {}
}

function listRevisions(ownerKey) {
  ownerKey = canonicalOwner(ownerKey);
  return withLock("revlist:" + ownerKey, async () => {
    let files;
    try {
      files = (await fsp.readdir(revDir(ownerKey))).filter(f => /^\d+\.json$/.test(f)).sort().reverse();
    } catch (e) { return []; }
    const out = [];
    for (const f of files) {
      const file = path.join(revDir(ownerKey), f);
      let row = null;
      try { row = rowFromHead(await readHead(file)); } catch (e) { continue; } // gone (pruned) meanwhile
      if (!row) {
        row = await backfillRevision(ownerKey, file);
        await new Promise(r => setImmediate(r)); // let other requests in between big parses
      }
      if (row) out.push(row);
    }
    return out;
  });
}

/* rev is client-controlled - GET /api/collection/revision/:rev sends it
   straight from the URL, POST /api/collection/restore from the request
   body - and used to be trusted as already-numeric before padStart() and
   path.join() ever saw it (found in a security pass, 2026-09-15). A real
   revision id is always digits, but nothing enforced that: a crafted rev
   like "../../../../secret.key" (reachable even past index.js's own router,
   whose :rev capture only excludes a literal "/" - a %2f-encoded slash
   still decodes to one by the time it gets here) walked straight past
   padStart (a no-op on any string already 8+ characters long, so it does
   NOT truncate or sanitize anything) into path.join() with no length limit
   at all - unlike a same-shaped bug just fixed in audit.js's dateOf(),
   which at least had ts.slice(0, 10) capping the damage. This one could
   reach anything path.join() could resolve to relative to revDir(), read
   back over the API if it happened to parse as JSON, or get silently
   renamed aside as "corrupt" by readJson()'s recovery path if it didn't -
   arbitrary file read/corruption, from any signed-in account. Rejecting
   anything that isn't purely digits closes it regardless of encoding. */
async function readRevision(ownerKey, rev) {
  if (!/^\d+$/.test(String(rev))) return null;
  const file = path.join(revDir(ownerKey), String(rev).padStart(8, "0") + ".json");
  return readJson(file, null);
}

/* ---------- Secrets at rest ----------
   Manapool/Pitney Bowes credentials in prefs.json are the one thing in this
   data directory worth encrypting: live access to someone's external
   marketplace/shipping accounts, not just this app's own data. AES-256-GCM
   with a key that lives next to the data it protects - this defends against
   a partial leak (one file emailed for support, a stray backup of prefs.json)
   the same way scrypt-hashed passwords do, not against someone who already
   has the whole data directory plus this key file.

   openSecret() returns its input unchanged when it doesn't carry the "gcm1:"
   marker, so prefs.json written before this feature existed keep working
   untouched and get sealed transparently the next time they're saved - no
   migration step. */
let MASTER_KEY = null;
function masterKey() {
  if (MASTER_KEY) return MASTER_KEY;
  const file = p("secret.key");
  try {
    const k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (k.length === 32) { MASTER_KEY = k; return MASTER_KEY; }
  } catch (e) {}
  MASTER_KEY = crypto.randomBytes(32);
  fs.writeFileSync(file, MASTER_KEY.toString("base64"), { mode: 0o600 });
  return MASTER_KEY;
}

/* A keyed signature over `data` with the same master key - for links that
   must prove they came from this server without carrying a session (the
   daily digest's unsubscribe link). Never reversible, never the key itself. */
function hmac(data) {
  return crypto.createHmac("sha256", masterKey()).update(String(data)).digest("base64url");
}

const SECRET_MARK = "gcm1:";
function sealSecret(plain) {
  if (plain == null || plain === "") return plain;
  const s = String(plain);
  if (s.startsWith(SECRET_MARK)) return s; // already sealed - idempotent
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  return SECRET_MARK + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}
function openSecret(sealed) {
  if (sealed == null || sealed === "") return sealed;
  const s = String(sealed);
  if (!s.startsWith(SECRET_MARK)) return s; // legacy plaintext, or not a secret field
  try {
    const raw = Buffer.from(s.slice(SECRET_MARK.length), "base64");
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (e) { return ""; } // corrupt or key rotated - fail closed, not throw
}

// manapoolAuth (#499): the Mana Pool sign-in's tokens, server-side only.
const SECRET_PATHS = [["manapool", "accessToken"], ["manapoolAuth", "accessToken"], ["manapoolAuth", "refreshToken"],
  ["pitneyBowes", "apiKey"], ["pitneyBowes", "apiSecret"]];
function sealPrefs(prefs) {
  const out = Object.assign({}, prefs);
  for (const [a, b] of SECRET_PATHS) {
    if (out[a] && typeof out[a][b] === "string" && out[a][b]) {
      out[a] = Object.assign({}, out[a], { [b]: sealSecret(out[a][b]) });
    }
  }
  return out;
}
function openPrefs(prefs) {
  const out = Object.assign({}, prefs);
  for (const [a, b] of SECRET_PATHS) {
    if (out[a] && typeof out[a][b] === "string" && out[a][b]) {
      out[a] = Object.assign({}, out[a], { [b]: openSecret(out[a][b]) });
    }
  }
  return out;
}

const readPrefs = userId => readJson(prefsFile(userId), {}).then(openPrefs);
const writePrefs = (userId, prefs) => withLock("prefs:" + userId, () => writeJson(prefsFile(userId), sealPrefs(prefs)));

/* Same read-modify-write-under-one-lock shape as updateTickets() above -
   two tabs/requests for the same account (e.g. two integration-credential
   saves, or a "fetch orders" racing a "save friends list") reading prefs
   before either writes back would otherwise silently lose whichever wrote
   first. */
function updatePrefs(userId, mutateFn) {
  return withLock("prefs:" + userId, async () => {
    const prefs = await readJson(prefsFile(userId), {}).then(openPrefs);
    const result = await mutateFn(prefs);
    await writeJson(prefsFile(userId), sealPrefs(prefs));
    return result === undefined ? prefs : result;
  });
}

/* ---------- Trade proposals (Buy List "Offer trade") ----------
   One shared document, same "one JSON file, no per-user document" shape as
   tickets.json above - a proposal is a mailbox-like record between two
   accounts, never part of anyone's actual collection document, so this
   doesn't need (and deliberately avoids) any write path into another
   user's collection - the "no write path into anybody else's collection"
   rule (README §11) is about the collection itself, and stays true; this
   is its own inbox, same as a support ticket is its own thing. */
const tradeProposalsFile = () => p("tradeProposals.json");
const readTradeProposals = () => readJson(tradeProposalsFile(), { proposals: [] });
const writeTradeProposals = t => withLock("tradeProposals", () => writeJson(tradeProposalsFile(), t));

/* Same read-modify-write-under-one-lock shape as updateTickets() above. */
function updateTradeProposals(mutateFn) {
  return withLock("tradeProposals", async () => {
    const db = await readJson(tradeProposalsFile(), { proposals: [] });
    const result = await mutateFn(db);
    await writeJson(tradeProposalsFile(), db);
    return result === undefined ? db : result;
  });
}

/* ---------- Email (instance-level) ----------
   One transactional-email account for the whole server, not per-user like
   Manapool/PB - this sends password-reset mail on the app operator's behalf.
   Lives in the data directory (never the git repo, unlike config.json which
   is merely gitignored) with its apiKey sealed the same way prefs.json's
   secrets are. */
const emailFile = () => p("email.json");
const readEmailConfig = () => readJson(emailFile(), {}).then(c => {
  const out = Object.assign({}, c);
  if (out.apiKey) out.apiKey = openSecret(out.apiKey);
  return out;
});
const writeEmailConfig = cfg => withLock("email", () => {
  const out = Object.assign({}, cfg);
  if (out.apiKey) out.apiKey = sealSecret(out.apiKey);
  return writeJson(emailFile(), out);
});

/* ---------- GitHub (instance-level) ----------
   Where Bug/Feature support tickets are filed as GitHub issues (#40): one
   repo + token for the whole server, admin-only, same file-in-the-data-dir
   and sealed-secret shape as email.json above. The token never leaves the
   server once saved - the admin route only ever reports hasToken. */
const githubFile = () => p("github.json");
const readGithubConfig = () => readJson(githubFile(), {}).then(c => {
  const out = Object.assign({}, c);
  if (out.token) out.token = openSecret(out.token);
  return out;
});
const writeGithubConfig = cfg => withLock("github", () => {
  const out = Object.assign({}, cfg);
  if (out.token) out.token = sealSecret(out.token);
  return writeJson(githubFile(), out);
});

/* ---------- Mana Pool app (instance-level, #499) ----------
   Grimoire's own registration with Mana Pool (client ID + client secret),
   entered on the Admin page, plus when the move off pasted tokens started
   (graceStartAt). Same sealed-secret shape as github.json: the secret never
   leaves the server once saved. */
const mpAppFile = () => p("manapool-app.json");
const openMpApp = c => {
  const out = Object.assign({}, c);
  if (out.clientSecret) out.clientSecret = openSecret(out.clientSecret);
  return out;
};
const readManapoolApp = () => readJson(mpAppFile(), {}).then(openMpApp);
function updateManapoolApp(mutateFn) {
  return withLock("manapool-app", async () => {
    const cur = openMpApp(await readJson(mpAppFile(), {}));
    const result = await mutateFn(cur);
    const out = Object.assign({}, cur);
    if (out.clientSecret) out.clientSecret = sealSecret(out.clientSecret);
    await writeJson(mpAppFile(), out);
    return result === undefined ? cur : result;
  });
}

/* ---------- Orders (Manapool) ----------
   Imported orders live server-side, not in the collection document: they carry a
   buyer's shipping address, so they are kept out of anything the app exports or
   shares with a friend. */
const ordersFile = userId => p("orders", String(userId) + ".json");
const readOrders = userId => readJson(ordersFile(userId), { orders: [] });
const writeOrders = (userId, o) => withLock("orders:" + userId, () => writeJson(ordersFile(userId), o));
// A cheap "has this account's orders cache changed" token, like collectionStamp (#433: the kiosk's offer).
async function ordersStamp(userId) {
  try { const st = await fsp.stat(ordersFile(userId)); return st.mtimeMs + ":" + st.size; }
  catch (e) { return "none"; }
}

/* Same read-modify-write-under-one-lock shape as updateTickets() above -
   e.g. marking one order shipped while a label-creation request is also
   writing back the same cached orders document. */
function updateOrders(userId, mutateFn) {
  return withLock("orders:" + userId, async () => {
    const doc = await readJson(ordersFile(userId), { orders: [] });
    const result = await mutateFn(doc);
    await writeJson(ordersFile(userId), doc);
    return result === undefined ? doc : result;
  });
}

/* ---------- Restart requests ----------
   A file rather than an HTTP call to the running process: there's no
   cross-platform IPC/signal story available (this runs on Windows too), but
   every writer already coordinates through files here. The admin API route
   and the `--restart-in` CLI one-shot both just write this file; the running
   server's own poll loop is what actually notices and acts on it. */
const restartFile = () => p("restart.json");
const readRestartRequest = () => readJson(restartFile(), null);
const writeRestartRequest = req => withLock("restart", () => writeJson(restartFile(), req));
const clearRestartRequest = () => withLock("restart", async () => {
  try { await fsp.unlink(restartFile()); } catch (e) { if (e.code !== "ENOENT") throw e; }
});

/* ---------- Digest send requests ----------
   Same file-not-IPC shape as restart.json above: the `--send-digest` CLI
   writes this, the running server's poll loop (it has the card index and
   the open price archive a digest needs) picks it up, clears it, sends. */
const digestRequestFile = () => p("digest-request.json");
const readDigestRequest = () => readJson(digestRequestFile(), null);
const writeDigestRequest = req => withLock("digest-request", () => writeJson(digestRequestFile(), req));
const clearDigestRequest = () => withLock("digest-request", async () => {
  try { await fsp.unlink(digestRequestFile()); } catch (e) { if (e.code !== "ENOENT") throw e; }
});

module.exports = {
  init, dir, p, defaultDataDir,
  readJson, writeJson, writeJsonCompact, writeFileAtomic, renameWithRetry, sweepTmp, withLock,
  readUsers, writeUsers, readSessions, writeSessions, readJobs, writeJobs, configuredFile,
  readMigrations, markMigrationDone, noteMigrationTry, updateMigrations,
  readTickets, writeTickets, updateTickets,
  readInviteRequests, updateInviteRequests,
  readTradeProposals, writeTradeProposals, updateTradeProposals,
  readOrgs, writeOrgs, updateOrgs, readStoreList, writeStoreList, updateStoreList, moveCollectionToStore,
  userDir, ownerDir, canonicalOwner, collLock, collectionFile, ensureUserDir, ownerMismatch, wrongOwnerError, sentStateStats,
  readCollection, collectionStamp, writeCollection, updateCollection, readCollectionLocked, listRevisions, readRevision, dropsMostStacks,
  readPrefs, writePrefs, updatePrefs, sealSecret, openSecret, hmac,
  readEmailConfig, writeEmailConfig,
  readGithubConfig, writeGithubConfig,
  readManapoolApp, updateManapoolApp,
  readOrders, writeOrders, updateOrders, ordersStamp,
  readRestartRequest, writeRestartRequest, clearRestartRequest,
  readDigestRequest, writeDigestRequest, clearDigestRequest,
  REVISIONS, FORCED_REVISIONS
};
