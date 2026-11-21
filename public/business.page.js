"use strict";
/* The business contact form (#249), opened from the landing page's
   "Run a shop?" band. Signed in or out, it posts to /api/business-enquiries
   and, once it's in, swaps the form for "Thanks, we'll be in touch at
   <email>". Nothing is emailed: the enquiry waits in Admin -> Invites. The
   server repeats every check below and lists all its problems at once,
   the way the sign-up form does (#242). */
const $ = id => document.getElementById(id);

function say(text, cls, list) {
  const m = $("msg");
  m.textContent = text || "";
  if (list && list.length > 1) {
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

$("form").onsubmit = async e => {
  e.preventDefault();
  const v = id => $(id).value.trim();
  const body = {
    name: v("name"), email: v("email"), shopName: v("shopName"), shopSize: v("shopSize"),
    plans: $("plans").value, website: $("website").value
  };
  const missing = [];
  if (!body.name) missing.push("Enter your name.");
  if (!body.email) missing.push("Enter your email address, so we can get back to you.");
  if (!body.shopName) missing.push("Enter your shop's name.");
  if (!body.plans.trim()) missing.push("Tell us what you'd like to do with Grimoire.");
  if (missing.length) { say(missing.join(" "), "err", missing); return; }
  $("submit").disabled = true;
  say("Sending…", "work");
  try {
    await post("/api/business-enquiries", body);
    $("form").hidden = true;
    $("tag").textContent = "Your message is in.";
    say("Thanks, we'll be in touch at " + body.email + ".", "ok");
    $("msg").focus();
  } catch (err) {
    say(err.message, "err", err.problems);
    $("submit").disabled = false;
  }
};

$("name").focus();
