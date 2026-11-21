"use strict";
/* Friends-sharing level rules, shared by every route that decides what one
   account may see of another's collection (GET /api/friends, /api/share,
   /api/friends/have, /watchlist, /collection) and by the notifications.

   A sharing-list entry (prefs.friends, by username) sets one person's
   level. Since #140 it counts only between FRIENDS (an accepted friend
   request, server/lib/friends.js), passed in as `friend`:
   - an entry at "off" (or an unknown level) always means Off, friend or
     not, and beats the owner's defaultShare ("Everyone else on this server
     sees"). That is what makes Stop sharing (#124) and Unfriend actually
     stop: they leave an "off" entry rather than deleting the row, which
     would drop the person back to defaultShare and could leave them
     seeing as much as before, or more;
   - an entry at Summary/Full gives that level to a friend. For anyone who
     isn't a friend it means nothing: they are "everyone else" and get
     defaultShare, like someone with no entry;
   - no entry: defaultShare, friend or not. */

const LEVELS = ["off", "summary", "full"];
const SHARED = ["summary", "full"];

function entryFor(sharing, viewerUsername) {
  const friends = sharing && Array.isArray(sharing.friends) ? sharing.friends : [];
  return friends.find(x => x && x.username === viewerUsername) || null;
}

/* sharing = { friends: [{ username, share }], defaultShare } */
function levelFor(sharing, viewerUsername, friend) {
  const f = entryFor(sharing, viewerUsername);
  if (f && !SHARED.includes(f.share)) return "off";
  if (f && friend === true) return f.share;
  const level = sharing && sharing.defaultShare;
  return LEVELS.includes(level) ? level : "off";
}

/* Mutates and returns the friends list. Default: keep (or add) the entry
   at "off". forget: delete the entry, so the person falls back to
   defaultShare; the page only offers that with a warning saying so. */
function stopSharing(friends, username, opts) {
  const list = Array.isArray(friends) ? friends : [];
  if (opts && opts.forget) return list.filter(f => !f || f.username !== username);
  const ex = list.find(f => f && f.username === username);
  if (ex) ex.share = "off";
  else list.push({ username, share: "off", addedAt: new Date().toISOString() });
  return list;
}

/* The level the owner set for this person by name, ignoring defaultShare:
   "off" when there is no entry for them, or when they aren't friends
   (#140). This is what makes someone a friend for "a friend has a card on
   your watch list" (#139); a server-wide defaultShare alone doesn't. */
function personalLevel(sharing, viewerUsername, friend) {
  const f = entryFor(sharing, viewerUsername);
  return f && friend === true && SHARED.includes(f.share) ? f.share : "off";
}

/* The most valuable stacks: all a "summary" share shows of the cards
   (GET /api/share/:username). */
const SUMMARY_TOP = 15;
function summaryTop(list) {
  return (Array.isArray(list) ? list : []).slice()
    .sort((a, b) => (b.price || 0) * (b.quantity || 0) - (a.price || 0) * (a.quantity || 0))
    .slice(0, SUMMARY_TOP);
}

module.exports = { LEVELS, levelFor, personalLevel, stopSharing, SUMMARY_TOP, summaryTop };
