
"use strict";
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
// "login" | "register" | "forgot" | "reset" | "request" (ask for an invite,
// #238) | "requested" (that request sent: the form is gone)
let mode = "login";
let meta = { registration: "invite" };
let resetToken = "";
// Arrived through an invite link (?invite=): greeted, not told they need a code.
let invited = false;
// ...and the server has since refused that code (#238 review).
let inviteRefused = false;

function setMode(m) {
  mode = m;
  const reg = m === "register";
  const forgot = m === "forgot";
  const reset = m === "reset";
  const request = m === "request";
  const requested = m === "requested";
  // Sign-up needs an invite code (not the very first account, and not in
  // open or closed mode). Only then is there anything to request.
  const inviteOnly = meta.registration === "invite" && !meta.first;

  $("form").hidden = requested;
  $("usernameWrap").hidden = forgot || reset || request;
  $("displayWrap").hidden = !reg;
  $("reqNameWrap").hidden = !request;
  $("reqNoteWrap").hidden = !request;
  // Email is asked for at sign-up too (optional): it's how password reset
  // and the daily digest reach you. The digest checkbox only matters with it.
  $("emailWrap").hidden = !(forgot || reg || request);
  $("emailLabel").textContent = reg
    ? "Email (optional) — needed to reset your password and for the daily digest"
    : request ? "Email — your invite will be sent here" : "Email";
  // The rules up front in every sign-up mode, not only in open mode's
  // tagline (#242). Described-by only while shown, so sign-in stays quiet.
  for (const f of ["username", "password"]) {
    $(f + "Hint").hidden = !reg;
    if (reg) $(f).setAttribute("aria-describedby", f + "Hint");
    else $(f).removeAttribute("aria-describedby");
  }
  $("digestWrap").hidden = !reg;
  $("passwordWrap").hidden = forgot || request;
  $("password2Wrap").hidden = !(reg || reset);
  // Open mode still honours a code from an invite link (#135), so it shows
  // there too: one the server turns down can be seen and cleared.
  $("inviteWrap").hidden = !(reg && (inviteOnly || (invited && !meta.first)));
  $("password").autocomplete = reg || reset ? "new-password" : "current-password";
  $("forgotRow").hidden = !(m === "login");
  // Sign-up without a code offers the request form; the request form leads
  // back to sign-up for anyone who has a code after all. Someone who came
  // through an invite link has one, so they see it only once the server has
  // turned that code down (expired, used, cancelled: see the submit handler).
  $("requestRow").hidden = !inviteOnly || !((reg && (!invited || inviteRefused)) || request);
  $("requestText").textContent = request ? "Have an invite code?" : invited ? "Invite not working?" : "No invite code?";
  $("requestBtn").textContent = request ? "Create your account" : "Request an invite";
  // The 2FA code field only appears once the server says this account needs
  // one (a "needs2fa" answer to a correct password) - see the submit handler.
  $("codeWrap").hidden = true;
  $("code").value = "";

  $("submit").textContent = forgot ? "Send reset link" : reset ? "Set new password" :
    request ? "Request an invite" :
    reg ? (meta.first ? "Create the first account" : "Create account") : "Sign in";
  if (forgot || reset || request || requested) {
    $("switchText").textContent = "";
    $("switchBtn").textContent = "Back to sign in";
    $("switchBtn").hidden = false;
  } else {
    $("switchText").textContent = reg ? "Already have an account?" : "Need an account?";
    $("switchBtn").textContent = reg ? "Sign in instead" : "Create one";
    $("switchBtn").hidden = !!meta.first || (!reg && meta.registration === "closed");
  }

  $("tag").textContent = forgot
    ? "Enter the email on your account and we'll send a link to reset your password."
    : reset
      ? "Choose a new password — at least ten characters, with a letter and a number."
      : request
        ? "Grimoire is invite-only for now. Tell us who you are, and if your request is approved, " +
          "an invite link will be emailed to you."
        : requested
          ? "Grimoire is invite-only for now."
          : meta.first
            ? "No accounts exist yet. The first account you create becomes the administrator."
            : reg
              ? (invited
                  ? "You've been invited to Grimoire. Pick a username and password to create your account."
                  : !inviteOnly
                    ? "Pick a username and a password of at least 10 characters with a letter and a number."
                    : "Grimoire is invite-only for now. Have a code? Enter it below with a username and password.")
              : "Card inventory, storage and price history for your Magic: The Gathering collection.";
  say("");
}

/* Where to go after signing in: ?next= only when it is a path on this
   site (#156). A value starting with "/" isn't enough: "//evil.example"
   and "/\evil.example" are other sites to a browser, and "/.//evil.example"
   becomes "//evil.example" once the browser tidies the path. So the value
   is parsed the way the browser will read it, must stay on this origin,
   and the full same-origin URL is used, never the bare path. The server
   only ever builds next from a request path (plus its query, #248), so
   nothing real is lost. */
function safeNext() {
  const n = params.get("next") || "";
  if (n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\")) {
    try {
      const u = new URL(n, location.origin);
      if (u.origin === location.origin) return u.href;
    } catch (e) { /* not a URL at all */ }
  }
  return "/index.html";
}

/* The same rules as the server's passwordProblem(), so a too-short new
   password is caught here, before the reset link is used (#155). */
function passwordProblem(s) {
  if (s.length < 10) return "Password must be at least 10 characters.";
  if (s.length > 512) return "Password must be under 512 characters.";
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return "Password needs at least one letter and one number.";
  return null;
}

function say(text, cls, list) {
  const m = $("msg");
  m.textContent = text || "";
  if (list && list.length > 1) {
    // Several problems at once (#242): one line each.
    m.textContent = "";
    const ul = document.createElement("ul");
    for (const t of list) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    }
    m.appendChild(ul);
  }
  m.className = "status " + (cls || "");
}

// Where the cursor goes when the form changes shape: its first field.
function focusFirst() {
  (mode === "forgot" ? $("email") : mode === "reset" ? $("password") : mode === "request" ? $("reqName")
    : mode === "requested" ? $("switchBtn") : $("username")).focus();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin"
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || ("HTTP " + res.status));
    if (data && Array.isArray(data.problems)) err.problems = data.problems;
    throw err;
  }
  return data;
}

$("switchBtn").onclick = () => {
  setMode(mode === "login" ? "register" : "login"); // forgot/reset: back to sign in
  focusFirst();
};
$("forgotBtn").onclick = () => { setMode("forgot"); focusFirst(); };
$("requestBtn").onclick = () => { setMode(mode === "request" ? "register" : "request"); focusFirst(); };

$("form").onsubmit = async e => {
  e.preventDefault();
  $("submit").disabled = true;
  try {
    if (mode === "request") {
      // Ask for an invite (#238). Nothing is emailed now: the request waits
      // for an admin, whose one click emails the invite link.
      const name = $("reqName").value.trim();
      const email = $("email").value.trim();
      const missing = [];
      if (!name) missing.push("Enter your name.");
      if (!email) missing.push("Enter your email address, so the invite has somewhere to go.");
      if (missing.length) { say(missing.join(" "), "err", missing); $("submit").disabled = false; return; }
      say("Sending your request…", "work");
      await post("/api/invite-requests", {
        kind: "personal", name, email, note: $("reqNote").value, website: $("website").value
      });
      setMode("requested");
      say("Thanks, your request is in. If it's approved, an invite link will be emailed to " + email + ".", "ok");
      $("submit").disabled = false;
      focusFirst();
      return;
    }
    if (mode === "forgot") {
      say("Sending…", "work");
      const email = $("email").value.trim();
      if (!email) throw new Error("Enter your email address.");
      const out = await post("/api/auth/forgot", { email });
      say(out.message, "ok");
      $("submit").disabled = false;
      return;
    }
    if (mode === "reset") {
      say("Setting your new password…", "work");
      const password = $("password").value;
      if (password !== $("password2").value) throw new Error("The two passwords do not match.");
      const weak = passwordProblem(password);
      if (weak) throw new Error(weak);
      const r = await post("/api/auth/reset", { token: resetToken, password });
      if (r && r.needsSignIn) {
        // Two-factor account: the emailed link changed the password but
        // isn't the second factor - sign in normally, code included.
        setMode("login");
        say("Password changed. Sign in with it and your authenticator code.", "ok");
        $("submit").disabled = false;
        return;
      }
      location.href = safeNext();
      return;
    }
    const username = $("username").value.trim().toLowerCase();
    const password = $("password").value;
    if (mode === "login" && (!username || !password)) {
      // Asked for here, never sent: an empty attempt isn't a wrong password.
      throw new Error(!username && !password ? "Enter your username and password."
        : !username ? "Enter your username." : "Enter your password.");
    }
    say(mode === "register" ? "Creating your account…" : "Signing in…", "work");
    if (mode === "register") {
      // The server checks the repeat (password2), so a mismatch is listed
      // with every other problem in one answer (#242).
      await post("/api/auth/register", {
        username, password, password2: $("password2").value,
        displayName: $("displayName").value.trim(),
        email: $("email").value.trim(),
        digest: $("digestOptIn").checked,
        invite: $("invite").value.trim()
      });
      // A brand-new account, unconditionally - the tutorial is the first
      // thing that happens after creation, ?next= included (it finishes by
      // sending you to /index.html itself, not back to whatever ?next= was).
      location.href = "/tutorial.html";
      return;
    }
    const code = $("codeWrap").hidden ? "" : $("code").value.trim();
    const out = await post("/api/auth/login", { username, password, code });
    if (out && out.needs2fa) {
      $("codeWrap").hidden = false;
      $("code").focus();
      say("Enter the code from your authenticator app.", "");
      $("submit").disabled = false;
      return;
    }
    if (out && out.recovery && out.recovery.used) {
      // Spent a recovery code - say how many are left before moving on, so
      // nobody silently runs out. A short pause, not a dialog.
      say("Signed in with a recovery code - " + out.recovery.left + " left. Make new ones under Settings → Account.", "ok");
      await new Promise(r => setTimeout(r, 2500));
    }
    location.href = safeNext();
  } catch (err) {
    // The server's invite problems all name the invite ("That invite has
    // expired…"): from then on the way to ask for a new one shows. Only in
    // invite mode: open mode takes no requests (#135), and there the
    // message says to clear the code instead.
    if (mode === "register" && invited && !inviteRefused && /invite/i.test(err.message)) {
      inviteRefused = true;
      $("requestRow").hidden = meta.registration !== "invite";
    }
    say(err.message, "err", err.problems);
    $("submit").disabled = false;
  }
};

(async function init() {
  try {
    meta = await (await fetch("/api/meta", { credentials: "same-origin" })).json();
    meta.first = !!meta.firstRun;
    const me = await (await fetch("/api/auth/me", { credentials: "same-origin" })).json();
    if (me && me.user) {
      location.href = safeNext();
      return;
    }
  } catch (e) { /* fall through to the plain login form */ }

  if (params.get("reset")) {
    resetToken = params.get("reset");
    setMode("reset");
  } else if (params.get("invite")) {
    $("invite").value = params.get("invite");
    invited = true;
    setMode("register");
  } else if (meta.first) {
    setMode("register");
  } else if (params.get("mode") === "register" && meta.registration !== "closed") {
    // The landing page's Create account button (#237).
    setMode("register");
  } else {
    setMode("login");
  }
  (mode === "forgot" ? $("email") : mode === "reset" ? $("password") : $("username")).focus();
})();
