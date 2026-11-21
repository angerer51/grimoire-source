"use strict";
/* The public landing page (#237). Plain links do all the work without this
   script; it only adjusts the two buttons to who is looking:
   - already signed in (someone opened /welcome.html directly): one orange
     "Go to your Dashboard" instead of Create account / Sign in;
   - sign-ups closed on this server: no Create account button, so Sign in
     becomes the page's one orange action. */
const $ = id => document.getElementById(id);

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  return res.json();
}

function promoteSignIn(label, href) {
  $("createBtn").hidden = true;
  const btn = $("signInBtn");
  btn.className = "lp-btn gold";
  btn.textContent = label;
  btn.href = href;
}

(async function init() {
  try {
    const me = await getJson("/api/auth/me");
    if (me && me.user) {
      promoteSignIn("Go to your Dashboard", "/index.html");
      $("topSignIn").textContent = "Open Grimoire";
      $("topSignIn").href = "/index.html";
      return;
    }
    const meta = await getJson("/api/meta");
    if (meta && meta.registration === "closed" && !meta.firstRun) promoteSignIn("Sign in", "/login.html");
  } catch (e) { /* offline or an old server: the plain links still work */ }
})();
