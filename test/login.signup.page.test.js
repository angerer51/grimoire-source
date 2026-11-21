"use strict";
/* #242: the sign-up form through its real script (public/login.page.js) in
   a bare VM with a stand-in DOM. Not a browser. The form shows its rules
   in every sign-up mode, explains the optional email, puts the cursor in
   Username, lists every problem the server reports at once, and an empty
   sign-in asks for both fields instead of saying "Wrong username or
   password". The server side (one answer listing every problem, the reg:
   throttle unchanged) is registrationProblems in test/auth.test.js plus the
   HTTP run described in the PR. Kept apart from test/login.page.test.js so
   the two harnesses can change independently. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "login.page.js"), "utf8");
const ORIGIN = "https://grimoire.example";
const settle = () => new Promise(r => setTimeout(r, 0));

const focusLog = [];
function el(id) {
  return {
    id, hidden: false, value: "", textContent: "", className: "", autocomplete: "", disabled: false, checked: false,
    attrs: {}, children: [],
    focus() { focusLog.push(id); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); this.textContent += c.textContent || ""; return c; }
  };
}

// reply(url, sentBody) may answer a POST as { status, body }. registration
// is /api/meta's mode (default "invite", as in production).
async function loadLogin(reply, search, registration) {
  const els = new Map();
  const net = [];
  const fetch = async (url, init) => {
    const sent = init && init.body ? JSON.parse(init.body) : undefined;
    net.push({ url, body: sent });
    const r = url === "/api/meta" ? { body: { registration: registration || "invite", firstRun: false } }
      : url === "/api/auth/me" ? { body: { user: null } }
      : (reply && reply(url, sent)) || { body: { ok: true } };
    const status = r.status || 200;
    return { ok: status < 400, status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  const sandbox = {
    console, URL, URLSearchParams, fetch, setTimeout,
    location: { search: search || "", origin: ORIGIN, href: ORIGIN + "/login.html" + (search || "") },
    document: {
      getElementById: id => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); },
      createElement: tag => el("<" + tag + ">")
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "login.page.js" });
  for (let i = 0; i < 5; i++) await settle();
  return { $: id => sandbox.document.getElementById(id), net };
}

test("Create account shows the rules and the email note, and focuses Username", async () => {
  const { $ } = await loadLogin();
  assert.equal($("usernameHint").hidden, true, "no rules on the sign-in form");
  assert.equal($("username").attrs["aria-describedby"], undefined);
  focusLog.length = 0;
  $("switchBtn").onclick();
  assert.equal($("inviteWrap").hidden, false, "invite mode");
  assert.equal($("usernameHint").hidden, false);
  assert.equal($("passwordHint").hidden, false);
  assert.equal($("username").attrs["aria-describedby"], "usernameHint");
  assert.equal($("password").attrs["aria-describedby"], "passwordHint");
  assert.equal($("emailLabel").textContent, "Email (optional) — needed to reset your password and for the daily digest");
  assert.equal(focusLog.at(-1), "username");
  // Back to sign in: rules hidden; the forgot form's label is plain "Email".
  $("switchBtn").onclick();
  assert.equal($("usernameHint").hidden, true);
  assert.equal(focusLog.at(-1), "username");
  $("forgotBtn").onclick();
  assert.equal($("emailLabel").textContent, "Email");
  assert.equal(focusLog.at(-1), "email");
});

test("an empty sign-in asks for both fields and sends nothing", async () => {
  const { $, net } = await loadLogin();
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal($("msg").textContent, "Enter your username and password.");
  assert.match($("msg").className, /err/);
  $("username").value = "alice";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal($("msg").textContent, "Enter your password.");
  $("username").value = "";
  $("password").value = "something-1";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal($("msg").textContent, "Enter your username.");
  assert.equal(net.filter(r => r.url === "/api/auth/login").length, 0);
});

test("sign-up sends the repeat password and lists every problem the server reports", async () => {
  const problems = ["Password must be at least 10 characters.", "Enter your invite code. No code yet? Request an invite instead."];
  const { $, net } = await loadLogin(url => url === "/api/auth/register"
    ? { status: 403, body: { error: problems.join(" "), problems } } : null);
  $("switchBtn").onclick();
  $("username").value = "newbie";
  $("password").value = "weak";
  $("password2").value = "weak2";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal(net.find(r => r.url === "/api/auth/register").body.password2, "weak2");
  const ul = $("msg").children[0];
  assert.deepEqual(ul.children.map(li => li.textContent), problems);
  assert.match($("msg").className, /err/);
  assert.equal($("submit").disabled, false);
});

test("a single problem is plain text, not a one-item list", async () => {
  const { $ } = await loadLogin(url => url === "/api/auth/register"
    ? { status: 409, body: { error: "That username is already taken." } } : null);
  $("switchBtn").onclick();
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal($("msg").textContent, "That username is already taken.");
  assert.equal($("msg").children.length, 0);
});

/* #238: invite-only sign-up explains itself and offers a request form; an
   invite link greets the invitee; no "server"/"administrator" wording. */
test("invite-only sign-up says so and offers Request an invite", async () => {
  const { $ } = await loadLogin();
  $("switchBtn").onclick();
  assert.match($("tag").textContent, /^Grimoire is invite-only for now\./);
  assert.doesNotMatch($("tag").textContent, /server|administrator/i);
  assert.equal($("requestRow").hidden, false);
  assert.equal($("requestBtn").textContent, "Request an invite");
});

test("the request form posts name, email, note and the honeypot, then thanks them", async () => {
  const { $, net } = await loadLogin();
  $("switchBtn").onclick();
  focusLog.length = 0;
  $("requestBtn").onclick();
  assert.equal(focusLog.at(-1), "reqName");
  assert.equal($("reqNameWrap").hidden, false);
  assert.equal($("emailWrap").hidden, false);
  assert.equal($("usernameWrap").hidden, true);
  assert.equal($("passwordWrap").hidden, true);
  assert.equal($("inviteWrap").hidden, true);
  assert.equal($("submit").textContent, "Request an invite");
  assert.equal($("requestBtn").textContent, "Create your account", "back to the code form");

  // Nothing typed: asked for here, nothing sent.
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal(net.filter(r => r.url === "/api/invite-requests").length, 0);
  assert.equal($("msg").children[0].children.length, 2);

  $("reqName").value = "Ann Lee";
  $("email").value = "ann@example.com";
  $("reqNote").value = "From the forum";
  await $("form").onsubmit({ preventDefault() {} });
  const sent = net.find(r => r.url === "/api/invite-requests").body;
  assert.deepEqual(sent, { kind: "personal", name: "Ann Lee", email: "ann@example.com", note: "From the forum", website: "" });
  assert.equal($("form").hidden, true, "the form is gone once sent");
  assert.match($("msg").textContent, /ann@example\.com/);
  assert.match($("msg").className, /ok/);
  assert.equal($("switchBtn").textContent, "Back to sign in");
  $("switchBtn").onclick();
  assert.equal($("form").hidden, false);
});

test("a refused request lists the server's problems and keeps the form", async () => {
  const problems = ["Your name must be 80 characters or fewer.", "That doesn't look like a valid email address."];
  const { $ } = await loadLogin(url => url === "/api/invite-requests"
    ? { status: 400, body: { error: problems.join(" "), problems } } : null);
  $("switchBtn").onclick();
  $("requestBtn").onclick();
  $("reqName").value = "x";
  $("email").value = "nope";
  await $("form").onsubmit({ preventDefault() {} });
  assert.deepEqual($("msg").children[0].children.map(li => li.textContent), problems);
  assert.equal($("form").hidden, false);
  assert.equal($("submit").disabled, false);
});

test("an invite link greets the invitee, with no request offer", async () => {
  const { $ } = await loadLogin(null, "?invite=abc123");
  assert.equal($("invite").value, "abc123");
  assert.equal($("tag").textContent, "You've been invited to Grimoire. Pick a username and password to create your account.");
  assert.equal($("requestRow").hidden, true);
});

test("an invite link the server turns down shows the way to ask for a new one", async () => {
  const msg = "That invite has expired. Use Request an invite to ask for a new one.";
  const { $ } = await loadLogin(url => url === "/api/auth/register"
    ? { status: 403, body: { error: msg, problems: [msg] } } : null, "?invite=old1");
  assert.equal($("requestRow").hidden, true);
  $("username").value = "newbie";
  $("password").value = "good-pass-1";
  $("password2").value = "good-pass-1";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal($("msg").textContent, msg);
  assert.equal($("requestRow").hidden, false);
  assert.equal($("requestText").textContent, "Invite not working?");
  assert.equal($("requestBtn").textContent, "Request an invite");
  $("requestBtn").onclick();
  assert.equal($("reqNameWrap").hidden, false, "the request form opens");
  $("requestBtn").onclick();
  assert.equal($("requestRow").hidden, false, "and stays offered back on the sign-up form");
});

test("a non-invite problem on an invite link doesn't offer a request", async () => {
  const { $ } = await loadLogin(url => url === "/api/auth/register"
    ? { status: 409, body: { error: "That username is already taken." } } : null, "?invite=abc123");
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal($("requestRow").hidden, true);
});

/* #135: open registration still honours an invite link's code (an org
   invite joins the org), so the field shows there too, the code is sent,
   and a refusal can be seen and cleared. No request offer: open mode takes
   no invite requests. */
test("open mode: an invite link shows its code, greets the invitee and sends the code", async () => {
  const { $, net } = await loadLogin(null, "?invite=org123", "open");
  assert.equal($("inviteWrap").hidden, false);
  assert.equal($("invite").value, "org123");
  assert.equal($("tag").textContent, "You've been invited to Grimoire. Pick a username and password to create your account.");
  assert.equal($("requestRow").hidden, true);
  $("username").value = "newbie";
  $("password").value = "good-pass-1";
  $("password2").value = "good-pass-1";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal(net.find(r => r.url === "/api/auth/register").body.invite, "org123");
});

test("open mode: a refused invite link shows the message, keeps the field and offers no request", async () => {
  const msg = "That invite has expired. Ask for a new one, or clear the code to sign up without it.";
  const { $ } = await loadLogin(url => url === "/api/auth/register"
    ? { status: 403, body: { error: msg, problems: [msg] } } : null, "?invite=old1", "open");
  $("username").value = "newbie";
  $("password").value = "good-pass-1";
  $("password2").value = "good-pass-1";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal($("msg").textContent, msg);
  assert.equal($("inviteWrap").hidden, false, "the code can be cleared");
  assert.equal($("requestRow").hidden, true);
});

test("open mode without a link: no invite field, plain tagline, blank code sent", async () => {
  const { $, net } = await loadLogin(null, "?mode=register", "open");
  assert.equal($("inviteWrap").hidden, true);
  assert.equal($("requestRow").hidden, true);
  assert.equal($("tag").textContent, "Pick a username and a password of at least 10 characters with a letter and a number.");
  $("username").value = "newbie";
  $("password").value = "good-pass-1";
  await $("form").onsubmit({ preventDefault() {} });
  assert.equal(net.find(r => r.url === "/api/auth/register").body.invite, "");
});
