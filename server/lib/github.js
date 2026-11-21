"use strict";
/* Support tickets <-> GitHub issues (#40).

   A Bug or Feature ticket is filed as an issue in one configured repo (an
   admin can also send any unlinked ticket by hand). A timer in index.js
   calls syncTickets() every 15 minutes: when a linked issue has closed, the
   ticket is resolved with one staff reply, and the reporter is emailed
   through the ticket's normal reply path. The whole lifecycle is drawn in
   docs/flows/ticket-github-sync.dot.

   Rules that matter:
     - Issues are never labelled `ready`: the owner decides what gets built.
       They get `bug`/`feature` plus `from-ticket`.
     - The issue body carries the reporter's username, never their email.
     - Reporters can't see the private repo, so no reply text mentions or
       links GitHub.
     - One reply per ticket, ever: `ticket.github.synced` is written to
       tickets.json BEFORE the email goes out, so a restart, a second timer
       tick or an issue closed/reopened/closed again can't reply twice.

   Config ({ repo, token }) is store.readGithubConfig(), the token already
   unsealed. Every call is plain fetch via fetchRetry with an overall
   timeout, same idiom as mailer.js / integrations.js (zero dependencies). */

const { fetchRetry } = require("./fetchRetry");

const DEFAULT_API = "https://api.github.com";
const TIMEOUT_MS = 20000;
// Bounds one sync run. Due tickets are checked oldest-checked first, so a
// backlog bigger than this rotates through over several runs instead of the
// same tickets hogging every run.
const SYNC_MAX_PER_RUN = 25;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const CATEGORY_NAMES = { bug: "Bug report", feature: "Feature request", support: "Support request" };

// Who the automatic resolve reply is "from". role admin, so
// notifyTicketReply() treats it as a staff reply and emails the reporter
// (and, being admin rather than moderator, doesn't also email every admin).
const SYSTEM_REPLIER = { id: "grimoire", username: "Grimoire", role: "admin" };

/* Plain text, no links, no mention of GitHub - the reporter reads these. */
const REPLIES = {
  completed: {
    bug: "Good news - this has been fixed, and the fix is live on Grimoire now. Thanks for reporting it!",
    feature: "Good news - this is done, and it's live on Grimoire now. Thanks for the suggestion!",
    support: "Good news - this has been taken care of, and the change is live on Grimoire now. Thanks for getting in touch!"
  },
  not_planned: "Thanks for taking the time to send this in. We've looked at it carefully and decided not to do this " +
    "for now. If anything changes, or you have more to add, just reply here."
};

let apiBase = DEFAULT_API;
/* cfg is the server config; `github.apiBase` exists only so a scratch
   server can point at a local stub (tools/scratch-server.js --github-api). */
function init(cfg) {
  const b = cfg && cfg.github && cfg.github.apiBase;
  apiBase = b ? String(b).replace(/\/+$/, "") : DEFAULT_API;
}

const validRepo = repo => REPO_RE.test(String(repo || "")) && !/\.\.|\/\.git$/i.test(String(repo));
const configured = cfg => !!(cfg && cfg.token && validRepo(cfg.repo));

/* One GitHub REST call. A GitHub error is surfaced as status 502 carrying
   GitHub's own message and `upstream` (its HTTP status) - never as our own
   401/403, which the browser's api() wrapper would read as "your Grimoire
   session expired". The token never appears in an error message. */
async function request(cfg, method, pathname, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetchRetry(apiBase + pathname, {
        method,
        headers: Object.assign({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + cfg.token,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Grimoire"
        }, body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      // A create is NOT retried: a 5xx can still have created the issue,
      // and a duplicate issue is worse than a failure the admin can retry
      // with the Send to GitHub button. Reads retry as usual.
      }, { attempts: method === "GET" ? 3 : 1 });
    } catch (e) {
      const err = new Error(e.name === "AbortError"
        ? "GitHub didn't answer within " + (TIMEOUT_MS / 1000) + "s."
        : "Couldn't reach GitHub: " + e.message);
      err.status = 502;
      throw err;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const msg = data && data.message ? data.message : String(text).slice(0, 200).replace(/\s+/g, " ");
      const err = new Error("GitHub said: " + (msg || "no details") + " (HTTP " + res.status + ")");
      err.status = 502;
      err.upstream = res.status;
      throw err;
    }
    return data;
  } finally { clearTimeout(timer); }
}

const repoPath = cfg => "/repos/" + String(cfg.repo).split("/").map(encodeURIComponent).join("/");

/* The issue for a ticket: title = subject, the first message quoted, the
   reporter's username (never email), the date, and the marker that ties
   the issue back to the ticket. */
function buildIssue(t) {
  const labels = (t.category === "bug" || t.category === "feature") ? [t.category, "from-ticket"] : ["from-ticket"];
  const first = String((t.messages && t.messages[0] && t.messages[0].body) || "");
  // Quoted, and a reporter can't smuggle in their own marker comment.
  const quoted = first.replace(/<!--/g, "&lt;!--").split(/\r?\n/).map(l => "> " + l).join("\n");
  const body = [
    "**Category:** " + (CATEGORY_NAMES[t.category] || t.category),
    "**Reported by:** " + t.createdByUsername + " (Grimoire username)",
    "**Opened:** " + String(t.createdAt || "").slice(0, 10),
    "",
    quoted,
    "",
    "_Filed automatically from a Grimoire support ticket. When this issue is closed, Grimoire resolves the " +
      "ticket and tells the reporter: closed as completed means \"fixed and live\", closed as not planned " +
      "sends a polite decline._",
    "",
    "<!-- grimoire-ticket:" + t.id + " -->"
  ].join("\n");
  return { title: String(t.subject || "").slice(0, 256) || "Support ticket " + t.id, body, labels };
}

/* What gets stored as ticket.github. `repo` is the repo it was filed in, so
   the sync never looks the number up in a different repo after an admin
   changes the setting. A reply that isn't really an issue is refused rather
   than linking the ticket to "#undefined" forever. */
function linkFor(cfg, data) {
  if (!data || !Number.isInteger(data.number) || data.number <= 0) {
    const e = new Error("GitHub's reply didn't include an issue number."); e.status = 502; throw e;
  }
  return { repo: cfg.repo, number: data.number, url: data.html_url, state: data.state || "open" };
}

async function createIssue(cfg, t) {
  return linkFor(cfg, await request(cfg, "POST", repoPath(cfg) + "/issues", buildIssue(t)));
}

/* An issue already filed for this ticket, found by its marker - so a manual
   Send to GitHub after a create that timed out (but did happen) links that
   issue instead of opening a second one. null when there isn't one. */
async function findIssueForTicket(cfg, ticketId) {
  const marker = "<!-- grimoire-ticket:" + ticketId + " -->";
  const q = "repo:" + cfg.repo + " is:issue in:body \"grimoire-ticket:" + ticketId + "\"";
  const data = await request(cfg, "GET", "/search/issues?per_page=20&q=" + encodeURIComponent(q));
  const hit = ((data && data.items) || []).find(i => !i.pull_request && String(i.body || "").includes(marker));
  return hit ? linkFor(cfg, hit) : null;
}

async function getIssue(cfg, number) {
  const data = await request(cfg, "GET", repoPath(cfg) + "/issues/" + encodeURIComponent(number));
  return { state: data.state, stateReason: data.state_reason || null };
}

/* The admin pane's Test button: can this token read the repo, and does the
   repo take issues? */
async function testRepo(cfg) {
  if (!validRepo(cfg.repo)) { const e = new Error("The repository must look like owner/name."); e.status = 400; throw e; }
  if (!cfg.token) { const e = new Error("Save a token first."); e.status = 400; throw e; }
  const data = await request(cfg, "GET", repoPath(cfg));
  if (data.has_issues === false) {
    const e = new Error("Issues are turned off for " + data.full_name + "."); e.status = 400; throw e;
  }
  return { fullName: data.full_name, private: !!data.private };
}

/* What a closed issue means for its ticket: null while it's still open. A
   close with no reason (older GitHub closes) counts as completed. A
   duplicate is tracked on the other issue, so the ticket gets no reply and
   is left OPEN in the queue (only marked synced, so it isn't checked again)
   for staff to answer by hand - "it's fixed" could be false there. */
function outcomeFor(issue) {
  if (!issue || issue.state !== "closed") return null;
  if (issue.stateReason === "not_planned") return "not_planned";
  if (issue.stateReason === "duplicate") return "duplicate";
  return "completed";
}

function replyText(t, outcome) {
  if (outcome === "not_planned") return REPLIES.not_planned;
  return REPLIES.completed[t.category] || REPLIES.completed.support;
}

const isDue = t => !!(t.github && t.github.number && !t.github.synced &&
  t.status !== "resolved" && t.status !== "closed");

/* The repo a ticket's issue lives in. Links made before repo was recorded
   (none exist in practice) are taken to be in the configured repo. */
const ticketRepo = (t, cfg) => (t.github && t.github.repo) || cfg.repo;
const sameRepo = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/* Applies one issue's state to its ticket, in place. Returns the outcome
   when a reply was added (the caller then emails it), otherwise null. The
   synced marker is what makes this once-only. */
function applySync(t, issue, now) {
  if (!t.github) return null;
  t.github.state = issue.state;
  t.github.checkedAt = now;
  delete t.github.lastError;
  if (!isDue(t)) return null;
  const outcome = outcomeFor(issue);
  if (!outcome) return null;
  t.github.synced = { outcome, at: now };
  if (outcome === "duplicate") return null;
  t.messages.push({
    from: SYSTEM_REPLIER.id, fromUsername: SYSTEM_REPLIER.username, fromRole: SYSTEM_REPLIER.role,
    body: replyText(t, outcome), at: now
  });
  t.status = "resolved";
  t.updatedAt = now;
  return outcome;
}

/* One sync run. deps: { store, cfg (github config), notify(ticket, replier),
   log, max }. Reads GitHub outside the tickets lock, then applies every
   result in ONE updateTickets() (re-checking each ticket inside the lock,
   so a staff action in between wins), then emails. Returns a summary for
   the admin pane. */
async function syncTickets(deps) {
  const log = deps.log || (() => {});
  if (!configured(deps.cfg)) return { skipped: "GitHub isn't connected." };
  const db = await deps.store.readTickets();
  const linked = db.tickets.filter(isDue);
  // Filed in a different repo than the one connected now (the admin
  // switched it): never looked up - the same number in the new repo is an
  // unrelated issue, and the token may not even cover the old repo. They
  // stay linked, with a note for staff, and are checked again if the
  // setting is switched back.
  const otherRepo = linked.filter(t => !sameRepo(ticketRepo(t, deps.cfg), deps.cfg.repo));
  const due = linked.filter(t => sameRepo(ticketRepo(t, deps.cfg), deps.cfg.repo))
    .sort((a, b) => String(a.github.checkedAt || "").localeCompare(String(b.github.checkedAt || "")))
    .slice(0, deps.max || SYNC_MAX_PER_RUN);
  const results = new Map();
  for (const t of otherRepo) {
    if (t.github.lastError && t.github.lastError.startsWith("Filed in ")) continue; // already noted
    results.set(t.id, { error: "Filed in " + t.github.repo + ", but GitHub is now connected to " + deps.cfg.repo + ", so it isn't checked." });
  }
  let error = null;
  let repoReadable = null; // checked once, only if an issue comes back 404
  let checked = 0;
  for (const t of due) {
    checked++;
    try {
      results.set(t.id, { issue: await getIssue(deps.cfg, t.github.number) });
    } catch (e) {
      // 404/410: the issue was deleted (or moved somewhere this token can't
      // see). Unlink so staff can send the ticket again - but only once the
      // repo itself is still readable: a token that lost access to a
      // private repo gets 404 for EVERY issue, and that must not unlink
      // them all.
      if (e.upstream === 404 || e.upstream === 410) {
        if (repoReadable === null) {
          try { await request(deps.cfg, "GET", repoPath(deps.cfg)); repoReadable = true; }
          catch (e2) { repoReadable = false; error = "Can't read " + deps.cfg.repo + ": " + e2.message; }
        }
        if (repoReadable) { results.set(t.id, { gone: true }); continue; }
        log("[github] " + error);
        break;
      }
      results.set(t.id, { error: e.message });
      log("[github] checking issue #" + t.github.number + " for ticket " + t.id + " failed: " + e.message);
      // A bad or expired token fails every call the same way - stop here.
      if (e.upstream === 401 || e.upstream === 403) { error = e.message; break; }
    }
  }
  if (!results.size) return { checked, resolved: 0, error };
  const now = new Date().toISOString();
  const replied = await deps.store.updateTickets(db2 => {
    const out = [];
    for (const [id, r] of results) {
      const x = db2.tickets.find(t => t.id === id);
      if (!x || !x.github) continue;
      if (r.gone) {
        log("[github] issue #" + x.github.number + " in " + ticketRepo(x, deps.cfg) + " is gone (deleted or moved) - ticket " +
          x.id + " unlinked, it can be sent to GitHub again");
        delete x.github;
        continue;
      }
      if (r.error) { x.github.checkedAt = now; x.github.lastError = r.error.slice(0, 300); continue; }
      if (applySync(x, r.issue, now)) out.push(JSON.parse(JSON.stringify(x)));
    }
    return out;
  });
  for (const t of replied) {
    log("[github] ticket " + t.id + " resolved (" + t.github.synced.outcome + ", issue #" + t.github.number + ")");
    try { await deps.notify(t, SYSTEM_REPLIER); } catch (e) { log("[github] reply email for " + t.id + " failed: " + e.message); }
  }
  return { checked, resolved: replied.length, error };
}

module.exports = {
  init, validRepo, configured, buildIssue, createIssue, findIssueForTicket, getIssue, testRepo,
  outcomeFor, replyText, applySync, isDue, syncTickets,
  SYSTEM_REPLIER, REPLIES, SYNC_MAX_PER_RUN, DEFAULT_API
};
