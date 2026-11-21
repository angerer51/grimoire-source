"use strict";
/* How a self-restart ends this process (#503).

   Unsupervised (the Windows scheduled task, a plain `node server/index.js`):
   checkRestartRequest() spawns a detached copy of itself and exits, because
   nothing else would start the new process.

   Under a supervisor (systemd): that spawn would die with us. When the main
   PID exits, systemd counts the service as stopped and kills everything
   left in its cgroup, the fresh child included. So the unit sets
   GRIMOIRE_SUPERVISOR=systemd, and the restart just exits with
   RESTART_EXIT_CODE; the unit's Restart= starts the new process.
   tools/linux/grimoire.service treats that code as a clean exit
   (SuccessExitStatus) that always restarts (RestartForceExitStatus).

   Any non-empty value other than an "off" word counts as supervised, so a
   different supervisor (Docker's restart policy, pm2) works the same way. */

// EX_TEMPFAIL from sysexits.h: "try again", which is what a restart is.
const RESTART_EXIT_CODE = 75;
const OFF = new Set(["", "0", "false", "no", "none", "off"]);

/* env: a process.env-shaped object. Returns { mode: "spawn" } or
   { mode: "exit", code, supervisor }. */
function restartPlan(env) {
  const v = String((env && env.GRIMOIRE_SUPERVISOR) || "").trim().toLowerCase();
  if (OFF.has(v)) return { mode: "spawn" };
  return { mode: "exit", code: RESTART_EXIT_CODE, supervisor: v };
}

module.exports = { restartPlan, RESTART_EXIT_CODE };
