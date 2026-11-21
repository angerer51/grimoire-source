"use strict";
/* GET /api/meta's body, per viewer (#161). The route is open: the sign-in
   page reads registration/firstRun from it, and every page polls it for
   the restart countdown. A signed-out visitor gets only that. Who asked
   for a restart (the admin's username: the one account worth locking out
   through the sign-in throttle), the restart's typed reason, and process
   uptime and memory are for signed-in accounts. */

/* full: everything a signed-in page gets. Returns the object to send. */
function forViewer(full, signedIn) {
  if (signedIn) return full;
  return {
    app: full.app, version: full.version,
    registration: full.registration, firstRun: full.firstRun,
    manapool: full.manapool, shipping: full.shipping,
    restart: full.restart ? { at: full.restart.at } : null
  };
}

module.exports = { forViewer };
