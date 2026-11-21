"use strict";
/* One-time email to Manapool sellers: Mark shipped now tells Manapool (#456).
   -----------------------------------------------------------------------
   #454 made Mark shipped on Order Fulfillment also mark the order shipped
   on Manapool. This tells the people it affects, once, by email.

   Who: every account with its OWN Manapool connection (prefs.manapool has
   an email and a token; owner's answer on #456), that isn't disabled, has
   an email address, and hasn't turned off the daily digest. The digest is
   the only email opt-out Grimoire has, so "no digest" is read as "no
   Grimoire email" and respected here too. Store staff who work a
   teammate's Manapool orders get the in-app "What's new" tutorial (#455)
   instead.

   When: in the background a few minutes after the boot of the release
   that ships it (index.js). Nothing is sent, and nothing is marked done,
   when this server has no email set up (a scratch server or a test's data
   dir never does), when Manapool is off for the site, when
   config.announcements is off (tools/scratch-server.js turns it off too),
   or when #454's code isn't in this release.

   Never twice: each account is claimed in migrations.json
   (mpShipAnnouncementSent: { userId: { state, at } }) BEFORE its email is
   sent, then marked "sent". A crash mid-send leaves "sending", which is
   never retried, so a crash can at worst skip someone, never email them
   twice. A send the provider clearly refused is unclaimed and retried on a
   later boot, up to MAX_TRIES boots; a timeout (the email may have gone)
   is kept as "unsure" and not retried. The done marker
   (mpShipAnnouncement) stops the whole thing once nothing is left to
   retry. */

const store = require("./store");
const mpAuth = require("./mpAuth");

const MARKER = "mpShipAnnouncement";
const SENT = "mpShipAnnouncementSent";
const MAX_TRIES = 3;
const GAP_MS = 600; // Resend's default rate limit is a couple of requests a second (digest.js)

const SUBJECT = "Grimoire now marks your Manapool orders shipped for you";

const hasOwnManapool = prefs => !!prefs && mpAuth.connected(prefs);
const digestOff = prefs => !!(prefs && prefs.digest && prefs.digest.unsubscribed);

/* Accounts this email is for (see the header). */
async function recipients() {
  const db = await store.readUsers();
  const out = [];
  for (const u of db.users || []) {
    if (u.disabled || !String(u.email || "").includes("@")) continue;
    const prefs = await store.readPrefs(u.id).catch(() => null);
    if (hasOwnManapool(prefs) && !digestOff(prefs)) out.push(u);
  }
  return out;
}

/* ---------- the email ---------- */

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* The words, once, for both the plain-text and HTML parts. */
function content(user, baseUrl) {
  const link = (baseUrl || "") + "/lists.html#tab=pick";
  return {
    hi: "Hi " + (user.displayName || user.username) + ",",
    intro: "Good news for your Manapool orders: when you press Mark shipped in Grimoire, it now tells Manapool the order " +
      "has shipped too. You no longer need to go to Manapool and mark each order shipped there yourself.",
    howTitle: "How it works",
    steps: [
      "On Order Fulfillment (the Pick list tab), tick one or more tickets and press Mark shipped, or press Mark shipped on a single picked ticket.",
      "A short table opens with one row per Manapool order. Pick the carrier (USPS is filled in) and type the tracking number if you have one. " +
        "If you printed the label through Grimoire, its tracking number is already there.",
      "Tracking is optional, except on Ground Advantage orders. Those are marked \"Tracking required\" and need a tracking number before you can confirm.",
      "If Manapool can't be reached or turns an order down, the ticket stays on your list marked \"not sent to Manapool\", with the reason. " +
        "Press Retry to send it again. Nothing is lost."
    ],
    tour: "The next time you open Grimoire, a short \"What's new\" tutorial walks you through these steps. You can replay it any time from Help.",
    linkLabel: "Open Order Fulfillment",
    link,
    footer: "This is a one-time note, sent because your Grimoire account (" + user.username + ") is connected to Manapool."
  };
}

function renderText(user, baseUrl) {
  const c = content(user, baseUrl);
  return [c.hi, "", c.intro, "", c.howTitle + ":", ...c.steps.map(s => "- " + s), "", c.tour, "",
    c.linkLabel + ": " + c.link, "", c.footer].join("\n");
}

function renderHtml(user, baseUrl) {
  const c = content(user, baseUrl);
  const C = { ink: "#151617", text: "#26272b", muted: "#6b6a64", line: "#e3e1da", orange: "#f26b1d", bg: "#f4f3ef" };
  const mono = "font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;";
  const sans = "font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;";
  const row = html => '<tr><td style="padding:6px 28px;' + sans + 'font-size:14px;line-height:1.55;color:' + C.text + ';">' + html + "</td></tr>";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + ';">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:' + C.bg + ';"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ' + C.line + ';">' +
    '<tr><td style="background:' + C.ink + ';border-bottom:3px solid ' + C.orange + ';padding:16px 28px;' + mono +
    'font-size:14px;font-weight:600;letter-spacing:.14em;color:#e6e5e0;">GRIMOIRE <span style="color:#8b8a84;font-weight:400;letter-spacing:.06em;">· WHAT\'S NEW</span></td></tr>' +
    '<tr><td style="height:16px;"></td></tr>' +
    row('<p style="margin:0;">' + esc(c.hi) + "</p>") +
    row('<p style="margin:0;">' + esc(c.intro) + "</p>") +
    row('<p style="margin:8px 0 0;font-weight:600;">' + esc(c.howTitle) + "</p>" +
      '<ul style="margin:4px 0 0;padding-left:18px;">' + c.steps.map(s => '<li style="margin:4px 0;">' + esc(s) + "</li>").join("") + "</ul>") +
    row('<p style="margin:0;">' + esc(c.tour) + "</p>") +
    row('<p style="margin:8px 0 4px;"><a href="' + esc(c.link) + '" style="display:inline-block;background:' + C.orange +
      ';color:#ffffff;text-decoration:none;padding:9px 16px;font-weight:600;">' + esc(c.linkLabel) + "</a></p>") +
    '<tr><td style="padding:22px 28px;' + sans + 'font-size:12px;line-height:1.6;color:' + C.muted + ';border-top:1px solid ' + C.line + ';">' +
    esc(c.footer) + "</td></tr></table></td></tr></table></body></html>";
}

/* ---------- sending ---------- */

/* Claim an account before its send; false when it was already claimed (by
   an earlier boot, sent or not). */
function claim(userId) {
  return store.updateMigrations(doc => {
    const sent = doc[SENT] = doc[SENT] || {};
    if (sent[userId]) return false;
    sent[userId] = { state: "sending", at: new Date().toISOString() };
    return true;
  });
}
function settle(userId, state) {
  return store.updateMigrations(doc => {
    const sent = doc[SENT] = doc[SENT] || {};
    if (state) sent[userId] = { state, at: new Date().toISOString() };
    else delete sent[userId];
  });
}

/* One pass over every recipient not yet claimed. opts: mailer, baseUrl,
   log, gapMs. */
async function announce(opts) {
  const { mailer, baseUrl } = opts;
  const log = opts.log || (() => {});
  const gap = opts.gapMs == null ? GAP_MS : opts.gapMs;
  const out = { recipients: 0, sent: 0, already: 0, failed: 0, unsure: 0 };
  const list = await recipients();
  out.recipients = list.length;
  for (const u of list) {
    if (!(await claim(u.id))) { out.already++; continue; }
    let sent = false;
    try {
      await mailer.send(store, { to: u.email, subject: SUBJECT, html: renderHtml(u, baseUrl), text: renderText(u, baseUrl) });
      sent = true;
    } catch (e) {
      // A timeout may still have delivered it: keep the claim, don't retry.
      const unsure = e && e.status === 504;
      if (unsure) out.unsure++; else out.failed++;
      log("Manapool shipping email to " + u.username + " " + (unsure ? "may not have gone (not retried)" : "failed (retried next boot)") + ": " + (e.message || e));
      await settle(u.id, unsure ? "unsure" : null).catch(() => {});
    }
    // Outside the send's try: a failed "sent" write leaves the claim as
    // "sending", which is never sent again - it must not release it.
    if (sent) {
      out.sent++;
      await settle(u.id, "sent").catch(e => log("Manapool shipping email to " + u.username + " went, but recording it failed (kept as sending, not re-sent): " + (e.message || e)));
    }
    if (gap) await new Promise(r => setTimeout(r, gap));
  }
  return out;
}

/* Runs announce() once per data directory (see the header). Returns null
   when it's done already, { skipped } when it can't run on this server
   (no marker, so a later boot looks again). opts: mailer, baseUrl,
   enabled, manapoolOn, featureShipped, log, gapMs. */
async function announceOnce(opts) {
  const done = await store.readMigrations();
  if (done[MARKER]) return null;
  if (opts.enabled === false) return { skipped: "announcements are off in config.json" };
  if (!opts.featureShipped) return { skipped: "Mark shipped -> Manapool (#454) isn't in this release" };
  if (!opts.manapoolOn) return { skipped: "Manapool is off on this server" };
  if (!(await opts.mailer.configured(store))) return { skipped: "email isn't configured" };
  const out = await announce(opts);
  const tries = (Number(done[MARKER + "Tries"]) || 0) + 1;
  out.tries = tries;
  if (!out.failed || tries >= MAX_TRIES) await store.markMigrationDone(MARKER);
  else await store.noteMigrationTry(MARKER + "Tries", tries);
  return out;
}

module.exports = { MARKER, SENT, MAX_TRIES, SUBJECT, hasOwnManapool, recipients, renderText, renderHtml, announce, announceOnce };
