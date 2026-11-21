"use strict";
/* Accounts and sessions.
   Passwords: scrypt with a per-user salt, compared in constant time. Sessions:
   an opaque 32-byte id held server-side, so signing out and "sign out
   everywhere" actually revoke - a self-signed token cannot do that. */

const crypto = require("crypto");
const store = require("./store");
const httpu = require("./http");
const totp = require("./totp");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE = "grimoire_sid";
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString("base64"), key.toString("base64")].join("$");
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), pp = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "base64");
    const want = Buffer.from(parts[5], "base64");
    const got = crypto.scryptSync(String(password), salt, want.length, { N, r, p: pp });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}

function passwordProblem(password) {
  const s = String(password == null ? "" : password);
  if (s.length < 10) return "Password must be at least 10 characters.";
  if (s.length > 512) return "Password must be under 512 characters.";
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return "Password needs at least one letter and one number.";
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function emailProblem(email) {
  const s = String(email == null ? "" : email).trim();
  if (!s) return null; // clearing it back to blank is allowed
  if (s.length > 200) return "Email must be under 200 characters.";
  if (!EMAIL_RE.test(s)) return "That doesn't look like a valid email address.";
  return null;
}

function usernameProblem(username) {
  const s = String(username == null ? "" : username).toLowerCase();
  if (!USERNAME_RE.test(s)) {
    return "Username must be 3-32 characters, start with a letter or number, " +
      "and use only letters, numbers, dot, dash or underscore.";
  }
  if (["admin", "root", "api", "static", "login", "logout", "share"].includes(s)) {
    return 'Username "' + s + '" is reserved.';
  }
  return null;
}

/* Every problem with a sign-up form at once (#242), in form order, instead
   of createUser()'s first-one-wins. Pure checks on what was typed: nothing
   here reads accounts or invites, so it tells an invite-code guesser
   nothing ("already taken" stays in createUser(), behind the invite
   check). password2 is only compared when the client sent it. */
function registrationProblems(body) {
  const b = body || {};
  const out = [];
  const un = usernameProblem(String(b.username == null ? "" : b.username).trim());
  if (un) out.push(un);
  const pn = passwordProblem(b.password);
  if (pn) out.push(pn);
  if (typeof b.password2 === "string" && b.password2 !== String(b.password == null ? "" : b.password)) {
    out.push("The two passwords do not match.");
  }
  const en = emailProblem(b.email);
  if (en) out.push(en);
  return out;
}

/* Whether sign-up (past the first account) redeems the invite field (#135).
   Invite mode always does, blank included. Open mode does when a code is
   sent, so an org invite link still joins the org instead of quietly making
   a plain account; a blank code there is a plain sign-up. Closed mode never
   gets this far. */
const hasInviteCode = code => !!String(code == null ? "" : code).trim();
function signupRedeemsInvite(registration, code) {
  return registration === "invite" || hasInviteCode(code);
}

/* The refusal for a code consumeInvite() turned down. `state` is
   inviteStateByCode()'s answer. Request an invite exists only in invite
   mode; in open mode the way on is to sign up without the code. */
function inviteRefusal(registration, code, state) {
  if (!hasInviteCode(code)) return "Enter your invite code. No code yet? Request an invite instead.";
  const next = registration === "invite" ? " Use Request an invite to ask for a new one."
    : " Ask for a new one, or clear the code to sign up without it.";
  return (state === "expired" ? "That invite has expired."
    : state === "revoked" ? "That invite has been cancelled."
    : state === "off" ? "Invites from members are turned off right now."
    : "That invite code is not valid or has already been used.") + next;
}

/* orgId/orgRole/storeIds (BACKLOG.md #9) are a second, orthogonal axis from
   role: role says "how much of this Grimoire SERVER can you administer";
   orgRole says "what can you do within the one Organization's Stores you
   belong to" (null/null for every personal account, which is most of them).
   Both are safe to expose to the client - orgRole/storeIds is what drives
   the nav's store-switcher and the org-management page's own permission
   checks, the same way role already drives admin-only UI. */
const publicUser = u => u && ({
  id: u.id, username: u.username, displayName: u.displayName || u.username,
  role: u.role, createdAt: u.createdAt,
  orgId: u.orgId || null, orgRole: u.orgRole || null,
  storeIds: Array.isArray(u.storeIds) ? u.storeIds : [],
  twoFactor: !!(u.totp && u.totp.secret)
});

/* ---------- Users ---------- */
async function findUser(username) {
  const db = await store.readUsers();
  const want = String(username || "").toLowerCase();
  return db.users.find(u => u.username === want) || null;
}

async function findUserById(id) {
  const db = await store.readUsers();
  return db.users.find(u => u.id === id) || null;
}

async function findUserByEmail(email) {
  return (await findUsersByEmail(email))[0] || null;
}

/* Every account with this address (#155). Addresses aren't unique (a
   personal account and a store staff account can share one), so "Forgot
   password?" sends one link per account rather than only ever reaching the
   first. */
async function findUsersByEmail(email) {
  const want = String(email || "").trim().toLowerCase();
  if (!want) return [];
  const db = await store.readUsers();
  return db.users.filter(u => String(u.email || "").trim().toLowerCase() === want);
}

/* Whether `actor` may change `target`'s email or send it a reset link from
   Admin -> Accounts (#154, #167). null when allowed, otherwise the refusal.
   Not on your own account, from anyone: changing your own address needs
   your password (Settings -> Account), and the admin routes don't ask for
   it. Otherwise administrators only (owner's decision, #167): setting an
   address and then sending it a reset link takes the account over when it
   has no 2FA, store owners included, so moderators can't do either. */
function accountActionProblem(actor, target) {
  if (!actor || !target) return "No such user.";
  if (actor.id === target.id) return "Use Settings → Account for your own email and password.";
  if (actor.role === "admin") return null;
  return "Only an administrator can change another account's email or send it a reset link.";
}

/* "name@example.com" -> "n***@example.com", for a moderator who acts on an
   address without being shown it (#154). */
function maskEmail(email) {
  const s = String(email || "").trim();
  const at = s.lastIndexOf("@");
  if (at < 1) return s ? "***" : "";
  return s.charAt(0) + "***" + s.slice(at);
}
// Another account's address as `viewer` may see it: whole for an admin.
const emailShownTo = (viewer, email) => viewer && viewer.role === "admin" ? String(email || "") : maskEmail(email);

/* A typed username for a log line (#161): quoted and capped, so a crafted
   name with line breaks can't write fake lines into server.log. */
const logName = s => JSON.stringify(String(s == null ? "" : s).slice(0, 64));

/* opts.withDisabled adds each account's `disabled` flag, for server-side
   checks such as the sharing routes (#142); it is not part of publicUser(). */
async function listUsers(opts) {
  const db = await store.readUsers();
  if (opts && opts.withDisabled) return db.users.map(u => Object.assign(publicUser(u), { disabled: !!u.disabled }));
  return db.users.map(publicUser);
}

async function createUser(opts) {
  const username = String(opts.username || "").trim().toLowerCase();
  const un = usernameProblem(username);
  if (un) { const e = new Error(un); e.status = 400; throw e; }
  const pn = passwordProblem(opts.password);
  if (pn) { const e = new Error(pn); e.status = 400; throw e; }
  // Sign-up started sending an email address with the daily digest
  // (2026-10-08) - hold it to the same rules as Settings' setEmail().
  const en = emailProblem(opts.email);
  if (en) { const e = new Error(en); e.status = 400; throw e; }

  return store.withLock("users", async () => {
    const db = await store.readUsers();
    if (db.users.some(u => u.username === username)) {
      const e = new Error("That username is already taken.");
      e.status = 409;
      throw e;
    }
    const first = db.users.length === 0;
    const user = {
      id: httpu.randomId(12),
      username,
      displayName: String(opts.displayName || username).slice(0, 60),
      email: String(opts.email || "").trim().slice(0, 200),
      role: first || opts.role === "admin" ? "admin" : "user",
      pwd: hashPassword(opts.password),
      createdAt: new Date().toISOString(),
      disabled: false,
      // Set for real by orgs.createOrg()/acceptOrgInvite() (BACKLOG.md #9),
      // never here - registration itself never puts an account in an org.
      orgId: null, orgRole: null, storeIds: []
    };
    db.users.push(user);
    // Writing inside the lock we already hold - writeUsers() would deadlock.
    await store.writeJson(store.p("users.json"), db);
    await store.ensureUserDir(user.id);
    return user;
  });
}

async function setPassword(userId, password) {
  const pn = passwordProblem(password);
  if (pn) { const e = new Error(pn); e.status = 400; throw e; }
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const u = db.users.find(x => x.id === userId);
    if (!u) { const e = new Error("No such user"); e.status = 404; throw e; }
    u.pwd = hashPassword(password);
    await store.writeJson(store.p("users.json"), db);
    return true;
  });
}

async function setEmail(userId, email) {
  const en = emailProblem(email);
  if (en) { const e = new Error(en); e.status = 400; throw e; }
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const u = db.users.find(x => x.id === userId);
    if (!u) { const e = new Error("No such user"); e.status = 404; throw e; }
    u.email = String(email == null ? "" : email).trim();
    await store.writeJson(store.p("users.json"), db);
    return publicUser(u);
  });
}

/* ---------- Password reset tokens ----------
   A single-use, short-lived, hashed-at-rest token - only its SHA-256 hash is
   ever written to disk, the same reasoning as a hashed password: whoever can
   read password-resets.json still cannot use it to reset an account, only
   whoever has the raw token from the email link. */
const RESET_TOKEN_TTL_MS = 30 * 60000;
const resetFile = () => store.p("password-resets.json");
const hashToken = t => crypto.createHash("sha256").update(String(t || "")).digest("base64url");

async function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await store.withLock("password-resets", async () => {
    const data = await store.readJson(resetFile(), {});
    const now = Date.now();
    for (const k of Object.keys(data)) if (!data[k] || data[k].exp < now) delete data[k];
    data[hashToken(token)] = { userId, exp: now + RESET_TOKEN_TTL_MS };
    await store.writeJson(resetFile(), data);
  });
  return token;
}

/* Sets the new password and invalidates every existing session for the
   account (a password reset is exactly the moment an account may have been
   compromised - any session that isn't the person who just proved control
   of the email address should not survive it). Returns the user so the
   route can decide whether to sign them straight in.
   #155: the new password is checked BEFORE the token is spent, so a
   too-short one doesn't burn the link. A disabled account's token is spent
   but changes nothing: same "invalid or expired" answer, no new password. */
const RESET_INVALID = "This reset link is invalid or has expired.";
async function consumePasswordResetToken(token, newPassword) {
  const pn = passwordProblem(newPassword);
  if (pn) { const e = new Error(pn); e.status = 400; throw e; }
  const key = hashToken(token);
  const userId = await store.withLock("password-resets", async () => {
    const data = await store.readJson(resetFile(), {});
    const rec = data[key];
    if (!rec || rec.exp < Date.now()) { const e = new Error(RESET_INVALID); e.status = 400; throw e; }
    delete data[key]; // single-use, regardless of what happens next
    await store.writeJson(resetFile(), data);
    return rec.userId;
  });
  const target = await findUserById(userId);
  if (!target || target.disabled) { const e = new Error(RESET_INVALID); e.status = 400; throw e; }
  await setPassword(userId, newPassword);
  await destroyAllSessions(userId);
  return findUserById(userId);
}

const ROLES = ["user", "moderator", "admin"];
const ROLE_RANK = { user: 0, moderator: 1, admin: 2 };

/* A self-hosted instance must never lock itself out of its own admin panel -
   refuse to demote or disable the last remaining admin. */
async function setRole(userId, role) {
  if (!ROLES.includes(role)) { const e = new Error("Not a valid role."); e.status = 400; throw e; }
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const u = db.users.find(x => x.id === userId);
    if (!u) { const e = new Error("No such user"); e.status = 404; throw e; }
    if (u.role === "admin" && role !== "admin") {
      const otherAdmins = db.users.filter(x => x.id !== userId && x.role === "admin" && !x.disabled).length;
      if (otherAdmins === 0) { const e = new Error("Cannot demote the last administrator."); e.status = 400; throw e; }
    }
    u.role = role;
    await store.writeJson(store.p("users.json"), db);
    return Object.assign(publicUser(u), { disabled: !!u.disabled });
  });
}

async function setDisabled(userId, disabled) {
  const updated = await store.withLock("users", async () => {
    const db = await store.readUsers();
    const u = db.users.find(x => x.id === userId);
    if (!u) { const e = new Error("No such user"); e.status = 404; throw e; }
    if (disabled && u.role === "admin") {
      const otherAdmins = db.users.filter(x => x.id !== userId && x.role === "admin" && !x.disabled).length;
      if (otherAdmins === 0) { const e = new Error("Cannot disable the last administrator."); e.status = 400; throw e; }
    }
    u.disabled = !!disabled;
    await store.writeJson(store.p("users.json"), db);
    return Object.assign(publicUser(u), { disabled: !!u.disabled });
  });
  // #142: a disabled account shares nothing (actFrom.resolve), and its saved
  // "Share and trade from" store is cleared now, so re-enabling it restores
  // personal sharing only; store sharing waits until the store is picked
  // again on Social, with its confirmation (#128's "ask again" rule). Taken
  // after the users lock is released (users, then prefs; never nested).
  // #147: dropChoice leaves the "why" note for when it is turned back on.
  // Required lazily: actFrom needs this module.
  if (disabled) {
    const af = require("./actFrom"), nameOf = await af.storeNamer();
    await store.updatePrefs(userId, prefs => { af.dropChoice(prefs, "disabled", undefined, nameOf); });
  }
  return updated;
}

/* ---------- Organization membership (BACKLOG.md #9) ----------
   A second, orthogonal permission axis from role/setRole above - see the
   comment on publicUser(). ORG_ROLES/ORG_ROLE_RANK mirror ROLES/ROLE_RANK's
   shape on purpose, for the same "at least this rank" route-gating pattern
   in server/index.js. storeIds only means anything for "staff" - "owner"
   and "manager" implicitly reach every Store in their org (see orgs.js),
   so it's left [] for those rather than kept in sync with the org's store
   list. */
const ORG_ROLES = ["staff", "manager", "owner"];
const ORG_ROLE_RANK = { staff: 0, manager: 1, owner: 2 };

/* "At least this org rank": the check behind the { orgRole: "..." } route
   option in server/index.js, here so a route that must also let personal
   accounts through (no orgRole) can apply the same test to org members
   only - see DELETE /api/audit (#76). */
function hasOrgRole(user, min) {
  // ?? not ||: staff is rank 0, which || would turn into "no rank".
  return (ORG_ROLE_RANK[user && user.orgRole] ?? -1) >= ORG_ROLE_RANK[min];
}

/* Generic mutator for all three org fields at once, used by orgs.js for
   org creation, invite acceptance, and later role/store-assignment changes
   - one place that enforces "cannot strip the last Owner of an org" the
   same way setRole() above refuses to demote the last server admin. Pass
   orgId: null to remove someone from their org entirely (orgRole/storeIds
   are forced back to null/[] in that case regardless of what's passed).
   opts.by: the account making the change. #139 tells the member in-app
   when they're added to an org or their role changes, unless they did it
   themselves (opts.by === userId). */
async function setOrgMembership(userId, { orgId, orgRole, storeIds }, opts) {
  if (orgId && !ORG_ROLES.includes(orgRole)) {
    const e = new Error("Not a valid organization role."); e.status = 400; throw e;
  }
  let keepsStoreRank = false;
  let before = null;
  const updated = await store.withLock("users", async () => {
    const db = await store.readUsers();
    const u = db.users.find(x => x.id === userId);
    if (!u) { const e = new Error("No such user"); e.status = 404; throw e; }
    before = { orgId: u.orgId || null, orgRole: u.orgRole || null };
    const wasManager = u.orgRole === "owner" || u.orgRole === "manager";
    keepsStoreRank = wasManager && !!orgId && orgId === u.orgId && (orgRole === "owner" || orgRole === "manager");
    const leavingOwner = u.orgId && u.orgRole === "owner" && (!orgId || orgId !== u.orgId || orgRole !== "owner");
    if (leavingOwner) {
      const otherOwners = db.users.filter(x =>
        x.id !== userId && x.orgId === u.orgId && x.orgRole === "owner" && !x.disabled).length;
      if (otherOwners === 0) { const e = new Error("Cannot remove the last owner of an organization."); e.status = 400; throw e; }
    }
    if (!orgId) {
      u.orgId = null; u.orgRole = null; u.storeIds = [];
    } else {
      u.orgId = orgId; u.orgRole = orgRole;
      u.storeIds = orgRole === "staff" && Array.isArray(storeIds) ? storeIds : [];
    }
    await store.writeJson(store.p("users.json"), db);
    return publicUser(u);
  });
  // #128: acting from a store needs Owner/Manager rank in that store's org,
  // so any change that doesn't keep that rank in the same org (demotion,
  // removal, leaving, joining another org) clears the saved "Share and
  // trade from" store at once. Getting the rank back must not quietly share
  // the store again: the person picks it on Social, with its confirmation.
  // Taken after the users lock is released (users, then prefs; never nested).
  // #147: dropChoice leaves a note saying why (demoted, or left the org),
  // shown on Social and in the trade composer. Required lazily: actFrom
  // needs this module.
  if (!keepsStoreRank) {
    const reason = updated.orgId && updated.orgId === before.orgId ? "demoted" : "left";
    const af = require("./actFrom"), nameOf = await af.storeNamer();
    await store.updatePrefs(userId, prefs => { af.dropChoice(prefs, reason, undefined, nameOf); });
  }
  // #139. Required lazily: notifyEvents needs this module. Never throws.
  await require("./notifyEvents").membershipChanged(userId, before,
    { orgId: updated.orgId || null, orgRole: updated.orgRole || null }, opts && opts.by);
  return updated;
}

/* ---------- Presence ----------
   In-memory only, keyed by session id - "online now" is exact for the
   current process's lifetime and costs zero disk I/O per request. A
   periodic flush (server/index.js) folds this into sessions.json so "last
   active" survives a restart to within the flush interval's staleness. */
const presence = new Map(); // sid -> { userId, lastSeenAt }
function touchPresence(sid, userId) {
  if (!sid || !userId) return;
  presence.set(sid, { userId, lastSeenAt: Date.now() });
}
function presenceSnapshot() { return presence; }

/* Merges the in-memory map into sessions.json's per-session objects. Skips
   the write entirely when nothing is new, so an idle server does not touch
   the file on every tick. */
async function flushPresence() {
  if (!presence.size) return;
  await store.withLock("sessions", async () => {
    const sessions = await store.readSessions();
    let changed = false;
    for (const [sid, p] of presence) {
      if (sessions[sid]) {
        if (sessions[sid].lastSeenAt !== p.lastSeenAt) {
          sessions[sid].lastSeenAt = p.lastSeenAt;
          changed = true;
        }
      } else {
        // The session no longer exists on disk - expired and swept by
        // createSession()'s own opportunistic cleanup (the common case:
        // most sessions end by simply going stale, not an explicit sign-
        // out), or explicitly destroyed. Either way there's nothing left
        // to flush this entry into, and leaving it in `presence` forever
        // would mean one permanent entry per login this process has EVER
        // handled - genuinely unbounded over a long-running process's
        // lifetime, found in passing while fixing the same class of leak
        // for destroySession()/destroyAllSessions() (BACKLOG #20 test
        // coverage). Pruned here since this periodic tick already visits
        // every entry anyway.
        presence.delete(sid);
      }
    }
    if (changed) await store.writeJsonCompact(SESSION_FILE(), sessions);
  });
}

const ONLINE_WINDOW_MS = 5 * 60000;
/* { [userId]: { lastSeenAt, onlineNow } } - the freshest of the in-memory map
   (this process, exact) and whatever sessions.json has on disk (covers a
   session older than the last flush, or right after a restart). */
async function presenceByUser() {
  const sessions = await store.readSessions();
  const now = Date.now();
  const out = {};
  const bump = (userId, lastSeenAt) => {
    if (lastSeenAt == null) return;
    const cur = out[userId];
    if (!cur || lastSeenAt > cur.lastSeenAt) out[userId] = { lastSeenAt, onlineNow: now - lastSeenAt < ONLINE_WINDOW_MS };
  };
  for (const s of Object.values(sessions)) if (s) bump(s.userId, s.lastSeenAt || null);
  for (const p of presence.values()) bump(p.userId, p.lastSeenAt);
  return out;
}

/* ---------- Invites ---------- */
/* orgMeta (BACKLOG.md #9) is optional and absent for every ordinary
   server-join invite today - only set by orgs.js's employee-invite flow, so
   that accepting the invite both creates the account AND sets its org
   membership in one step (see markInviteUsed's caller in the registration
   route, which should apply orgMeta via auth.setOrgMembership() once the
   account exists). */
/* sourceRef (optional) tags an invite as belonging to a specific non-admin
   action - e.g. "pick:<owner key>:<pick list id>" for the invite a printed
   pick ticket's promo footer links to (server/lib/pickInvite.js) - so the
   same tag finds the same invite again instead of blindly minting a new one every time the
   same pick ticket gets printed again. Plain manual admin-minted invites
   (Settings - Invites) pass no sourceRef and are never deduped. */
/* Org employee invites expire (#126): an Owner invite minted months ago
   used to still make whoever registered with it an Owner. Org invites
   last 7 days; every other invite (admin, CLI, pick tickets) 30 days, the
   limit below (PR #143). revokedAt is set by revokeInvite(). */
const ORG_INVITE_DAYS = 7;
const ORG_INVITE_MS = ORG_INVITE_DAYS * 24 * 3600 * 1000;

/* Every invite, of any kind, lasts at most 30 days from when it was made
   (owner's decision, 2026-10-10, on PR #143): a code printed on a pick
   ticket, minted by an admin or from the CLI stops working after that.
   Worked out when a code is read or redeemed, never stored, so it applies
   to codes made before this rule too, with no migration: anything older
   than 30 days stopped working the moment this shipped. A shorter stored
   expiry (an org invite's 7 days) still wins. A record with no readable
   createdAt counts as expired. */
const INVITE_MAX_DAYS = 30;
const INVITE_MAX_MS = INVITE_MAX_DAYS * 24 * 3600 * 1000;

/* The moment an invite stops working, in ms: the earlier of its stored
   expiresAt and createdAt + 30 days. */
function inviteExpiryMs(inv) {
  const created = Date.parse(inv && inv.createdAt);
  const cap = Number.isFinite(created) ? created + INVITE_MAX_MS : 0;
  const stored = inv && inv.expiresAt ? Date.parse(inv.expiresAt) : NaN;
  return Number.isFinite(stored) ? Math.min(stored, cap) : cap;
}

/* Why an invite can't be used right now: "used", "revoked", "expired", or
   null when it's still good. A pending one (mid-registration) counts as
   used. */
function inviteState(inv, now) {
  if (!inv) return "missing";
  if (inv.usedBy) return "used";
  if (inv.revokedAt) return "revoked";
  if (inviteExpiryMs(inv) <= (now || Date.now())) return "expired";
  return null;
}

/* ---------- Pruning finished invites (#160) ----------
   Owner's rule (2026-10-10): an expired or revoked invite is deleted 30
   days after it stopped working. A used one stays as the sign-up record,
   but a used pick-ticket invite loses its code and note 90 days after it
   was used. Every printed pick ticket adds a record, and users.json is
   read whole on every signed-in request, so the file must not grow
   forever. Runs where records are made (createInvite, inside the same
   lock and write) and once at boot, so the file stays bounded by roughly
   two months of invites plus the used ones. */
const INVITE_PRUNE_MS = 30 * 24 * 3600 * 1000;
const PICK_TRIM_MS = 90 * 24 * 3600 * 1000;
const isPickInvite = i => String((i && i.sourceRef) || "").startsWith("pick:");

/* When an unused invite stopped working, in ms (the earlier of being
   revoked and expiring), or null while it still works. A record stuck at
   "pending" (a sign-up that crashed half-way) counts as unused here. */
function inviteStoppedMs(inv, now) {
  const expiry = inviteExpiryMs(inv);
  const revoked = inv.revokedAt ? Date.parse(inv.revokedAt) : NaN;
  const stopped = Math.min(expiry, Number.isFinite(revoked) ? revoked : Infinity);
  return stopped <= now ? stopped : null;
}

/* Applies the rule to db.invites in place. Returns { dropped, trimmed }. */
function pruneInviteList(db, now) {
  const at = now || Date.now();
  let dropped = 0, trimmed = 0;
  const keep = [];
  for (const i of db.invites || []) {
    const used = !!(i.usedBy && i.usedBy !== "pending");
    if (!used) {
      const stopped = inviteStoppedMs(i, at);
      if (stopped != null && at - stopped >= INVITE_PRUNE_MS) { dropped++; continue; }
    } else if (isPickInvite(i) && (i.code || i.note)) {
      const usedAt = Date.parse(i.usedAt || i.createdAt);
      if (Number.isFinite(usedAt) && at - usedAt >= PICK_TRIM_MS) {
        i.code = null; i.note = ""; i.trimmedAt = new Date(at).toISOString();
        trimmed++;
      }
    }
    keep.push(i);
  }
  db.invites = keep;
  return { dropped, trimmed };
}

/* The boot-time pass. Writes only when something changed. */
async function pruneInvites(now) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const r = pruneInviteList(db, now);
    if (r.dropped || r.trimmed) await store.writeJson(store.p("users.json"), db);
    return r;
  });
}

async function createInvite(byUserId, note, orgMeta, sourceRef) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    // Find-or-create in one locked step: two prints of the same pick ticket
    // landing together both saw "none yet" when the check ran outside the
    // lock (index.js), and would each have minted a code. Only a code that
    // still works is reused: an expired, revoked or used one gets a fresh
    // code under the same tag (PR #143).
    const existing = sourceRef && findUsableBySource(db, sourceRef);
    if (existing) return existing;
    // Finished invites go in the same write as the new one (#160).
    pruneInviteList(db);
    const invite = newInviteRecord(byUserId, note, orgMeta, sourceRef);
    db.invites.push(invite);
    await store.writeJson(store.p("users.json"), db);
    return invite;
  });
}

function newInviteRecord(byUserId, note, orgMeta, sourceRef) {
  const isOrg = !!(orgMeta && orgMeta.orgId);
  const created = Date.now();
  return {
    code: httpu.randomId(9),
    createdBy: byUserId,
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + (isOrg ? ORG_INVITE_MS : INVITE_MAX_MS)).toISOString(),
    revokedAt: null,
    note: String(note || "").slice(0, 120),
    sourceRef: sourceRef || null,
    usedBy: null,
    usedAt: null,
    orgMeta: orgMeta && orgMeta.orgId ? {
      orgId: orgMeta.orgId,
      orgRole: ORG_ROLES.includes(orgMeta.orgRole) ? orgMeta.orgRole : "staff",
      storeIds: Array.isArray(orgMeta.storeIds) ? orgMeta.storeIds : []
    } : null
  };
}

/* ---------- Member invites (#337) ----------
   Any member can hand out a few personal sign-up links, with no admin
   approval (owner's decisions, 2026-10-28). They are ordinary invite records
   with memberInvite: true, so consuming, expiry, pruning and the admin's
   Revoke are the code above. What's added:
   - The allowance: 3 each by default (db.memberInvites.allowance), or
     user.inviteAllowance for one person. A used link spends one for good; an
     open one holds one. An expired or revoked one holds nothing, which is how
     an unused link "goes back to the member". Checked inside the users lock,
     so two clicks together can't pass it.
   - The switch (db.memberInvites.enabled). Off stops new links AND stops the
     ones already handed out from working, without changing them: the admin
     who turns this off wants member sign-ups to stop, and turning it back on
     restores any link that hasn't expired. Checked at use, as is the inviter:
     a disabled account's links stop working too (checkMemberInviteAtUse).
   - A member cancelling a link deletes the record instead of marking it
     revoked. Nobody joined through it, and cancel-then-make-another could
     otherwise grow users.json (read whole on every signed-in request)
     without limit. A deleted code is simply not a valid code. */
const MEMBER_INVITE_DEFAULT = 3;
const MEMBER_INVITE_MAX = 100;
const inviteProblem = (status, message) => Object.assign(new Error(message), { status });
const validAllowance = n => Number.isInteger(n) && n >= 0 && n <= MEMBER_INVITE_MAX;

function memberInviteSettings(db) {
  const s = (db && db.memberInvites) || {};
  return {
    enabled: s.enabled !== false,
    allowance: validAllowance(s.allowance) ? s.allowance : MEMBER_INVITE_DEFAULT
  };
}

const inviteIsUsed = i => !!(i.usedBy && i.usedBy !== "pending");

/* How one member stands. A sign-up in progress ("pending") holds its invite
   like an open link, and one stuck that way by a crash goes back on expiry. */
function memberInviteCounts(db, u, now) {
  const at = now || Date.now();
  const mine = db.invites.filter(i => i.memberInvite && i.createdBy === u.id);
  const used = mine.filter(inviteIsUsed).length;
  const open = mine.filter(i => !inviteIsUsed(i) && !i.revokedAt && inviteExpiryMs(i) > at).length;
  const allowance = validAllowance(u.inviteAllowance) ? u.inviteAllowance : memberInviteSettings(db).allowance;
  return { allowance, used, open, remaining: Math.max(0, allowance - used - open) };
}

/* Makes a link for this member, or throws { status } with the message to
   show. The caller has already refused it if sign-ups are closed. */
async function createMemberInvite(userId) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    if (!memberInviteSettings(db).enabled) throw inviteProblem(403, "Member invites are turned off right now.");
    const u = db.users.find(x => x.id === userId);
    if (!u || u.disabled) throw inviteProblem(403, "This account can't send invites.");
    if (memberInviteCounts(db, u).remaining <= 0) {
      throw inviteProblem(409, "You have no invites left. An unused link comes back to you when it expires or you cancel it.");
    }
    pruneInviteList(db);
    const invite = Object.assign(newInviteRecord(userId), { memberInvite: true });
    db.invites.push(invite);
    await store.writeJson(store.p("users.json"), db);
    return invite;
  });
}

/* What Social's Invite a friend shows one member: their own links only. */
async function memberInvitesFor(userId) {
  const db = await store.readUsers();
  const u = db.users.find(x => x.id === userId);
  const now = Date.now();
  const byId = new Map(db.users.map(x => [x.id, x]));
  const invites = [];
  for (const i of db.invites) {
    if (!i.memberInvite || i.createdBy !== userId) continue;
    const row = { code: i.code, createdAt: i.createdAt, expiresAt: new Date(inviteExpiryMs(i)).toISOString() };
    if (inviteIsUsed(i)) {
      const who = byId.get(i.usedBy);
      invites.push(Object.assign(row, { status: "joined", joinedAt: i.usedAt,
        username: who ? who.username : null, displayName: who ? who.displayName || who.username : null }));
    } else if (!i.revokedAt && inviteExpiryMs(i) > now) {
      invites.push(Object.assign(row, { status: "open" }));
    }
  }
  invites.reverse();
  return Object.assign({ enabled: memberInviteSettings(db).enabled, invites },
    u ? memberInviteCounts(db, u, now) : { allowance: 0, used: 0, open: 0, remaining: 0 });
}

/* The member takes back one of their own unused links, handing the invite
   back. Returns false for anyone else's code, a used one or no such code,
   so a code can't be probed. */
async function cancelMemberInvite(code, userId) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const at = db.invites.findIndex(i => i.code === String(code || "") && i.memberInvite && i.createdBy === userId);
    if (at < 0 || db.invites[at].usedBy) return false;
    db.invites.splice(at, 1);
    await store.writeJson(store.p("users.json"), db);
    return true;
  });
}

/* At sign-up, once the code itself has been accepted. Returns { inviter }, or
   { state } for inviteRefusal(). */
async function checkMemberInviteAtUse(inv) {
  const db = await store.readUsers();
  if (!memberInviteSettings(db).enabled) return { state: "off" };
  const inviter = db.users.find(u => u.id === inv.createdBy);
  if (!inviter || inviter.disabled) return { state: "revoked" };
  return { inviter };
}

/* Admin -> Invites -> Member invites: the settings, then everyone who has
   made a link or has an allowance of their own, with who they invited. */
async function memberInviteOverview() {
  const db = await store.readUsers();
  const now = Date.now();
  const byId = new Map(db.users.map(u => [u.id, u]));
  const invitedBy = new Map();
  const made = new Set();
  for (const i of db.invites) {
    if (!i.memberInvite) continue;
    made.add(i.createdBy);
    if (!inviteIsUsed(i)) continue;
    const who = byId.get(i.usedBy);
    if (!invitedBy.has(i.createdBy)) invitedBy.set(i.createdBy, []);
    invitedBy.get(i.createdBy).push({ username: who ? who.username : null, at: i.usedAt });
  }
  const people = db.users
    .filter(u => made.has(u.id) || validAllowance(u.inviteAllowance))
    .map(u => Object.assign({
      username: u.username, displayName: u.displayName || u.username, disabled: !!u.disabled,
      custom: validAllowance(u.inviteAllowance) ? u.inviteAllowance : null,
      invited: invitedBy.get(u.id) || []
    }, memberInviteCounts(db, u, now)));
  return Object.assign(memberInviteSettings(db), { people, maxAllowance: MEMBER_INVITE_MAX });
}

/* patch: { enabled?, allowance? }. Returns the settings now. */
async function setMemberInviteSettings(patch) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const next = memberInviteSettings(db);
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.allowance !== undefined) {
      if (!validAllowance(patch.allowance)) throw inviteProblem(400, "Invites per member must be a whole number from 0 to " + MEMBER_INVITE_MAX + ".");
      next.allowance = patch.allowance;
    }
    db.memberInvites = next;
    await store.writeJson(store.p("users.json"), db);
    return next;
  });
}

/* One person's allowance, or null to put them back on the usual number.
   Lowering it never touches links already out; it only stops new ones. */
async function setMemberInviteAllowance(rawUsername, allowance) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const uname = String(rawUsername || "").toLowerCase().trim();
    const u = db.users.find(x => x.username === uname);
    if (!u) throw inviteProblem(404, "No user named " + (uname || "that") + " on this server.");
    if (allowance === null) delete u.inviteAllowance;
    else if (validAllowance(allowance)) u.inviteAllowance = allowance;
    else throw inviteProblem(400, "An allowance must be a whole number from 0 to " + MEMBER_INVITE_MAX + ".");
    await store.writeJson(store.p("users.json"), db);
    return u.username;
  });
}

/* Get-or-create's "get" half - the actual dedup a printed pick ticket needs.
   Without this, every reprint (a page reload resets the caller's own
   in-memory cache, a different browser/session has none at all) minted a
   brand new invite code tied to the same pick ticket - caught live, two
   separate codes both noted "Printed with PICK-2026-0004". */
async function findInviteBySource(sourceRef) {
  if (!sourceRef) return null;
  return findUsableBySource(await store.readUsers(), sourceRef);
}
// The newest still-usable invite carrying this tag, or null.
function findUsableBySource(db, sourceRef) {
  const now = Date.now();
  const hits = db.invites.filter(i => i.sourceRef === sourceRef && !inviteState(i, now));
  return hits.length ? hits[hits.length - 1] : null;
}

async function consumeInvite(code) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const inv = db.invites.find(i => i.code === String(code || ""));
    if (!inv || inviteState(inv)) return null;
    inv.usedBy = "pending";
    await store.writeJson(store.p("users.json"), db);
    return inv;
  });
}

async function markInviteUsed(code, userId) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const inv = db.invites.find(i => i.code === code);
    if (inv) { inv.usedBy = userId; inv.usedAt = new Date().toISOString(); }
    await store.writeJson(store.p("users.json"), db);
  });
}

async function releaseInvite(code) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const inv = db.invites.find(i => i.code === code);
    if (inv && inv.usedBy === "pending") inv.usedBy = null;
    await store.writeJson(store.p("users.json"), db);
  });
}

/* Just the state of a code, for a clearer refusal message at sign-up. */
async function inviteStateByCode(code) {
  const db = await store.readUsers();
  return inviteState(db.invites.find(i => i.code === String(code || "")));
}

/* Outstanding (unused, unrevoked, unexpired) invites into one org, for the
   org page's list (#126). The caller decides who sees which. */
async function listOrgInvites(orgId) {
  const db = await store.readUsers();
  const byId = new Map(db.users.map(u => [u.id, u.username]));
  const now = Date.now();
  return db.invites
    .filter(i => i.orgMeta && i.orgMeta.orgId === orgId && !inviteState(i, now))
    .map(i => ({
      code: i.code, note: i.note, createdAt: i.createdAt, expiresAt: new Date(inviteExpiryMs(i)).toISOString(),
      createdBy: i.createdBy, createdByUsername: byId.get(i.createdBy) || null,
      orgRole: i.orgMeta.orgRole, storeIds: Array.isArray(i.orgMeta.storeIds) ? i.orgMeta.storeIds : []
    }));
}

/* Revokes an unused invite. Returns the invite, or null if there's no such
   code or it's already used. The caller checks who may revoke what. */
async function revokeInvite(code, byUserId) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const inv = db.invites.find(i => i.code === String(code || ""));
    if (!inv || inv.usedBy) return null;
    if (!inv.revokedAt) { inv.revokedAt = new Date().toISOString(); inv.revokedBy = byUserId || null; }
    await store.writeJson(store.p("users.json"), db);
    return inv;
  });
}

/* One-off migration for org invites made before #126, which have no
   expiresAt. Rather than kill them all on deploy, or leave them valid
   forever, each unused one gets the same 7 days from the first boot that
   sees it, as if it had been created at deploy time. Idempotent: it only
   writes when it stamps something. Returns how many it stamped. */
async function stampLegacyOrgInviteExpiry(now) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const at = now || Date.now();
    let n = 0;
    for (const i of db.invites || []) {
      if (i.orgMeta && i.orgMeta.orgId && !i.usedBy && !i.expiresAt) {
        i.expiresAt = new Date(at + ORG_INVITE_MS).toISOString();
        i.expiryBackfilled = true;
        n++;
      }
    }
    if (n) await store.writeJson(store.p("users.json"), db);
    return n;
  });
}

async function listInvites() {
  const db = await store.readUsers();
  const byId = new Map(db.users.map(u => [u.id, u.username]));
  const now = Date.now();
  return db.invites.map(i => {
    const at = inviteExpiryMs(i);
    return {
      code: i.code || null, createdAt: i.createdAt, note: i.note || "",
      createdByUsername: byId.get(i.createdBy) || null,
      // Admin -> Invites' "Made by" reads "Pick ticket" for these (#160).
      fromPickTicket: isPickInvite(i),
      memberInvite: !!i.memberInvite,
      used: !!(i.usedBy && i.usedBy !== "pending"),
      // The real end date, the 30-day limit included (PR #143).
      expiresAt: at ? new Date(at).toISOString() : null,
      expired: !i.usedBy && !i.revokedAt && at <= now,
      revoked: !!i.revokedAt,
      // Still usable: what the "Show: open" filter and Revoke go by.
      open: !inviteState(i, now)
    };
  });
}

/* ---------- Sessions ---------- */
/* Read-modify-write of the session file happens inside the lock, and writes the
   file directly rather than through store.writeSessions() - that helper takes the
   same lock, and taking it twice would deadlock. */
const SESSION_FILE = () => store.p("sessions.json");
const DAY_MS = 86400000;

/* Two limits on a session (#268): `exp` is the absolute one - sessionDays
   (30) after the sign-in that created it, never extended, so even a daily
   user re-enters their password monthly. The idle one - sessionIdleDays (7)
   without a request - is checked here from the freshest of the in-memory
   presence entry (this process, exact) and the on-disk lastSeenAt (flushed
   once a minute; covers a restart). A session with neither yet counts from
   its sign-in: createdAt, or for a session made before createdAt existed,
   exp minus sessionDays. */
function sessionLastActive(sid, s, cfg) {
  const days = Number(cfg && cfg.sessionDays) || 30;
  const p = presence.get(sid);
  return Math.max(
    (p && p.lastSeenAt) || 0,
    Number(s.lastSeenAt) || 0,
    Number(s.createdAt) || (Number(s.exp) - days * DAY_MS) || 0);
}
function sessionExpired(sid, s, cfg, now) {
  if (!s || !(s.exp >= now)) return true;
  const idleDays = Number(cfg && cfg.sessionIdleDays) || 7;
  return now - sessionLastActive(sid, s, cfg) > idleDays * DAY_MS;
}

async function createSession(userId, cfg, req) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const days = Number(cfg.sessionDays) || 30;
  await store.withLock("sessions", async () => {
    const sessions = await store.readSessions();
    const now = Date.now();
    // Opportunistic sweep, so the file cannot grow without bound. Covers
    // both limits; flushPresence() prunes the swept sids' presence entries.
    for (const k of Object.keys(sessions)) if (sessionExpired(k, sessions[k], cfg, now)) delete sessions[k];
    sessions[sid] = {
      userId,
      createdAt: now,
      exp: now + days * DAY_MS,
      ua: String((req && req.headers["user-agent"]) || "").slice(0, 160)
    };
    await store.writeJsonCompact(SESSION_FILE(), sessions);
  });
  return { sid, days };
}

async function destroySession(sid) {
  if (!sid) return;
  await store.withLock("sessions", async () => {
    const sessions = await store.readSessions();
    if (sessions[sid]) {
      delete sessions[sid];
      await store.writeJsonCompact(SESSION_FILE(), sessions);
    }
  });
  // Also drop this sid's in-memory presence entry - presenceByUser() takes
  // whichever of sessions.json or this in-memory map is freshest, so a
  // stale-but-recent entry left behind here would keep reporting a
  // just-signed-out user as "online" for up to ONLINE_WINDOW_MS after they
  // actually logged out. Real bug, not theoretical: found while adding test
  // coverage for this file (BACKLOG #20) and confirmed by tracing
  // presenceByUser()'s own "freshest of either source" logic.
  presence.delete(sid);
}

async function destroyAllSessions(userId) {
  return store.withLock("sessions", async () => {
    const sessions = await store.readSessions();
    let n = 0;
    for (const k of Object.keys(sessions)) {
      if (sessions[k] && sessions[k].userId === userId) { delete sessions[k]; presence.delete(k); n++; }
    }
    if (n) await store.writeJsonCompact(SESSION_FILE(), sessions);
    return n;
  });
}

/* cfg carries sessionDays/sessionIdleDays (#268); without it the defaults
   (30/7) apply. Must run before the request's own touchPresence(), or the
   idle check would always see "active just now". */
async function userFromRequest(req, cfg) {
  const sid = httpu.parseCookies(req)[COOKIE];
  if (!sid) return null;
  const sessions = await store.readSessions();
  const s = sessions[sid];
  if (!s) return null;
  if (sessionExpired(sid, s, cfg, Date.now())) {
    // Delete it rather than just refusing: a dead session left on disk
    // would keep its user's "last active" and session count looking live.
    await destroySession(sid);
    return null;
  }
  const u = await findUserById(s.userId);
  if (!u || u.disabled) return null;
  u.__sid = sid;
  // Which Store an org account is currently acting on behalf of (BACKLOG.md
  // #9) - carried on the session, same idea as __sid above, so
  // orgs.resolveDocOwner() doesn't need a second sessions.json read per
  // request. Meaningless (and ignored) for a personal account.
  u.__activeStoreId = s.activeStoreId || null;
  return u;
}

/* Persists which Store a session is currently acting on behalf of - called
   by the store-switcher route (server/index.js, BACKLOG.md #9). Silently a
   no-op if the session vanished between the request being authenticated
   and this running (logged out in another tab, say). */
async function setActiveStore(sid, storeId) {
  if (!sid) return;
  await store.withLock("sessions", async () => {
    const sessions = await store.readSessions();
    if (!sessions[sid]) return;
    sessions[sid].activeStoreId = storeId || null;
    await store.writeJsonCompact(SESSION_FILE(), sessions);
  });
}

/* secure is decided by httpu.isSecureRequest(), not cfg.secureCookie alone -
   that flag stays as a manual override, but a request arriving over HTTPS
   through a trusted proxy now gets the Secure flag even if nobody remembered
   to also flip secureCookie in config.json. */
function sessionCookie(sid, cfg, days, req) {
  return httpu.cookieHeader(COOKIE, sid, {
    maxAge: (days || Number(cfg.sessionDays) || 30) * 86400,
    secure: httpu.isSecureRequest(req, cfg),
    sameSite: "Lax"
  });
}

function clearCookie(cfg, req) {
  return httpu.cookieHeader(COOKIE, "", { maxAge: 0, secure: httpu.isSecureRequest(req, cfg), sameSite: "Lax" });
}

/* ---------- Two-factor sign-in (BACKLOG #51) ----------
   Optional per account: an authenticator-app code (server/lib/totp.js)
   after the password, with 10 single-use recovery codes for a lost phone.
   On the user record in users.json:
     totp        { secret (sealed with store.sealSecret - same at-rest
                   encryption as the Manapool credentials), enabledAt,
                   lastStep (newest time step accepted - a code can't be
                   replayed inside its own 30s window) }
     totpPending sealed secret between "show me the QR" and "here's my first
                 code" - nothing is enforced until that first code proves
                 the phone actually has it
     totpRecovery SHA-256 hashes of the unused recovery codes, never the
                 codes themselves */
const RECOVERY_COUNT = 10;
const normCode = c => String(c || "").toLowerCase().replace(/[\s-]/g, "");
const hashCode = c => crypto.createHash("sha256").update("grimoire-recovery:" + normCode(c)).digest("hex");
function newRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    const raw = totp.base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    codes.push(raw.slice(0, 5) + "-" + raw.slice(5));
  }
  return codes;
}
function mutateUser(userId, fn) {
  return store.withLock("users", async () => {
    const db = await store.readUsers();
    const u = db.users.find(x => x.id === userId);
    if (!u) { const e = new Error("No such user"); e.status = 404; throw e; }
    const out = await fn(u);
    await store.writeJson(store.p("users.json"), db);
    return out;
  });
}
const badRequest = msg => Object.assign(new Error(msg), { status: 400 });

async function totpBegin(userId) {
  return mutateUser(userId, u => {
    if (u.totp && u.totp.secret) throw badRequest("Two-factor sign-in is already on. Turn it off first to set up a new phone.");
    const secret = totp.generateSecret();
    u.totpPending = store.sealSecret(secret);
    return { secret, uri: totp.otpauthUri(secret, u.username) };
  });
}

async function totpConfirm(userId, code) {
  return mutateUser(userId, u => {
    const secret = u.totpPending ? store.openSecret(u.totpPending) : "";
    if (!secret) throw badRequest("Start setup again - there's no pending authenticator for this account.");
    const step = totp.matchStep(secret, code);
    if (step < 0) throw badRequest("That code didn't match. Check the phone's clock is right and try the newest code.");
    const codes = newRecoveryCodes();
    u.totp = { secret: store.sealSecret(secret), enabledAt: new Date().toISOString(), lastStep: step };
    u.totpRecovery = codes.map(hashCode);
    delete u.totpPending;
    return codes;
  });
}

async function totpDisable(userId) {
  return mutateUser(userId, u => { delete u.totp; delete u.totpPending; delete u.totpRecovery; });
}

async function totpNewRecovery(userId) {
  return mutateUser(userId, u => {
    if (!(u.totp && u.totp.secret)) throw badRequest("Two-factor sign-in isn't on for this account.");
    const codes = newRecoveryCodes();
    u.totpRecovery = codes.map(hashCode);
    return codes;
  });
}

/* The second step of signing in: an authenticator code (newer than the
   last one accepted) or an unused recovery code, which is then spent.
   { ok, recoveryUsed, recoveryLeft }. */
async function checkSecondFactor(userId, code) {
  return mutateUser(userId, u => {
    if (!(u.totp && u.totp.secret)) return { ok: true };
    const secret = store.openSecret(u.totp.secret);
    const step = secret ? totp.matchStep(secret, code) : -1;
    if (step >= 0 && step > (Number(u.totp.lastStep) || -1)) {
      u.totp.lastStep = step;
      return { ok: true };
    }
    const h = hashCode(code);
    const list = Array.isArray(u.totpRecovery) ? u.totpRecovery : [];
    const i = normCode(code).length === 10 ? list.findIndex(x => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h))) : -1;
    if (i >= 0) {
      list.splice(i, 1);
      u.totpRecovery = list;
      return { ok: true, recoveryUsed: true, recoveryLeft: list.length };
    }
    return { ok: false };
  });
}
const hasTwoFactor = u => !!(u && u.totp && u.totp.secret);

module.exports = {
  totpBegin, totpConfirm, totpDisable, totpNewRecovery, checkSecondFactor, hasTwoFactor,
  COOKIE, hashPassword, verifyPassword, passwordProblem, usernameProblem, emailProblem, registrationProblems, signupRedeemsInvite, inviteRefusal, publicUser,
  findUser, findUserById, findUserByEmail, findUsersByEmail, listUsers, createUser, setPassword, setEmail,
  accountActionProblem, maskEmail, emailShownTo, logName,
  createPasswordResetToken, consumePasswordResetToken,
  pruneInvites, pruneInviteList,
  ROLES, ROLE_RANK, setRole, setDisabled,
  ORG_ROLES, ORG_ROLE_RANK, hasOrgRole, setOrgMembership,
  touchPresence, presenceSnapshot, flushPresence, presenceByUser,
  createInvite, findInviteBySource, consumeInvite, markInviteUsed, releaseInvite, listInvites,
  MEMBER_INVITE_DEFAULT, MEMBER_INVITE_MAX, createMemberInvite, memberInvitesFor, cancelMemberInvite, checkMemberInviteAtUse,
  memberInviteOverview, setMemberInviteSettings, setMemberInviteAllowance,
  ORG_INVITE_DAYS, INVITE_MAX_DAYS, inviteExpiryMs, inviteState, inviteStateByCode, listOrgInvites, revokeInvite, stampLegacyOrgInviteExpiry,
  createSession, destroySession, destroyAllSessions, userFromRequest, setActiveStore,
  sessionCookie, clearCookie
};
