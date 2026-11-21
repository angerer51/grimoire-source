"use strict";
/* Warehouse Mode (the RF menu, #386): the shell every job plugs into. Screens
   are one main element redrawn whole, so a job only says what a screen looks
   like and what its buttons do:

     RF.job({ id, label, icon, count() })    one big button on the home screen
     RF.screen(prefix, render)               route "#prefix/..." -> render(parts)
     RF.acts({ name(dataset, el) })          a button with data-act="name"

   Later jobs (#387 find and move, #388 receive and put away, #389 count and
   returns) add one rf/<job>.page.js and one <script> line in rf/index.html.

   Also here: the live-connection stop (no signal, no work, no offline queue),
   the scan field and camera, big confirm dialogs, and the photo viewer.
   Page logic lives in core.js; nothing on these screens shows a price or a
   cost, because the core.js views they draw from don't carry one. */
window.RF = (function () {
  const $ = id => document.getElementById(id);
  const esc = s => G.esc(s);
  const icon = name => '<svg class="ic" aria-hidden="true"><use href="/icons/sprite.svg#' + name + '"></use></svg>';

  /* ------------------------- Screens and routes ------------------------- */
  const jobs = [], screens = new Map(), actions = new Map();
  let current = null;   // the route's parts, for redraw()
  let held = false;     // a screen with a half-typed value: don't redraw it under the person

  function job(def) { jobs.push(def); }
  function screen(prefix, render) { screens.set(prefix, render); }
  function acts(map) { for (const k of Object.keys(map)) actions.set(k, map[k]); }

  function parts() {
    return String(location.hash || "").replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  }
  const hashOf = (...p) => "#" + p.map(encodeURIComponent).join("/");
  function go(...p) { location.hash = hashOf(...p); }
  function hold(on) { held = !!on; }
  function redraw(force) {
    if (held && !force) return;
    hold(false);
    camera.stop();
    scanHandler = null;
    // A forced draw, or a new route, is the person moving: start at the top. A
    // background redraw of the same screen leaves them where they'd scrolled to.
    const was = current ? current.join("/") : null;
    current = parts();
    const moved = force || was !== current.join("/");
    const render = screens.get(current[0] || "home") || screens.get("home");
    let html;
    try { html = render(current.slice(1)); }
    catch (e) {
      console.error(e);
      html = head("Something went wrong", "home") + '<div class="rf-body"><div class="rf-msg bad">' + esc(e.message || e) + "</div></div>";
    }
    const root = $("rfRoot");
    if (html != null) {
      const y = scrollPos();
      root.innerHTML = html;
      scrollTo(moved ? 0 : y);
    }
    if (afterDraw) { const f = afterDraw; afterDraw = null; f(root); }
  }
  // rf.css makes the body the scroller (overflow-x on a 100% height body); which
  // element scrolls can differ by browser, so both are read and both are set.
  const scrollPos = () => Math.max(window.scrollY || 0, document.body.scrollTop || 0);
  function scrollTo(y) { window.scrollTo(0, y); document.body.scrollTop = y; }
  // Runs once after the next draw: focus a field, start the scanner.
  let afterDraw = null;
  function after(fn) { afterDraw = fn; }

  // A header. back: a route's name ("pick"), or { act } for a step inside a screen.
  function head(title, back, step) {
    const backEl = !back ? ""
      : back.act ? '<button class="rf-back" data-act="' + esc(back.act) + '" title="Back" aria-label="Back">' + icon("arrow-left") + "</button>"
      : '<a class="rf-back" href="' + esc(hashOf(back)) + '" title="Back" aria-label="Back">' + icon("arrow-left") + "</a>";
    return '<header class="rf-head">' + backEl +
      "<h1>" + esc(title) + "</h1>" +
      (step ? '<span class="rf-step">' + esc(step) + "</span>" : "") +
      "</header>";
  }

  document.addEventListener("click", e => {
    const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || el.disabled) return;
    const fn = actions.get(el.dataset.act);
    if (fn) { e.preventDefault(); fn(el.dataset, el); }
  });
  window.addEventListener("hashchange", () => redraw(true));
  // A typed field with data-enter="act": Enter presses that button.
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target || !e.target.dataset || !e.target.dataset.enter) return;
    e.preventDefault();
    const b = document.querySelector('[data-act="' + e.target.dataset.enter + '"]');
    if (b) b.click();
  });

  /* ------------------------- Home ------------------------- */
  screen("home", () => {
    const me = G.me || {};
    refreshSoon();
    return head("Warehouse Mode") +
      '<div class="rf-body">' +
      jobs.map(j => {
        const n = j.count();
        return '<button class="rf-job" data-act="openJob" data-job="' + esc(j.id) + '">' + icon(j.icon) +
          '<span class="rf-job-name">' + esc(j.label) + "</span>" +
          // A job with nothing waiting to count (find and move) returns null: no badge.
          (n == null ? "" : '<span class="rf-count' + (n ? "" : " zero") + '" aria-label="' + n + ' waiting">' + n + "</span>") + "</button>";
      }).join("") +
      "</div>" +
      '<div class="rf-actions">' +
      '<div class="rf-whoami">Signed in as ' + esc(me.displayName || me.username || "") + "</div>" +
      '<div class="rf-actions two" style="padding:0;position:static">' +
      '<a class="rf-btn quiet" href="/help.html#warehouse-mode">' + icon("circle-help") + " Help</a>" +
      '<button class="rf-btn quiet" data-act="signOut">' + icon("x") + " Sign out</button>" +
      "</div>" +
      '<button class="rf-btn" data-act="exit">' + icon("arrow-left") + " Exit to Grimoire</button>" +
      "</div>";
  });
  acts({
    openJob: d => go(d.job),
    // Everything saved first, or it would ask "Leave site?" on the way out.
    exit: async () => { await G.saveAll(5000); location.href = "/index.html"; },
    signOut: async () => {
      if (!await confirm({ title: "Sign out?", body: "Someone else can then sign in on this device.", ok: "Sign out", cancel: "Stay signed in" })) return;
      await G.saveAll(5000);
      await G.api("/api/auth/logout", { method: "POST" }).catch(() => {});
      location.href = "/login.html?next=" + encodeURIComponent("/rf/");
    }
  });

  /* ------------------------- Big confirm, photo ------------------------- */
  function confirm(o) {
    return new Promise(resolve => {
      const box = $("rfOverlay");
      box.className = "rf-overlay";
      box.innerHTML = '<div class="rf-body"><div class="rf-big">' + esc(o.title) + "</div>" +
        (o.body ? '<p class="rf-text">' + esc(o.body) + "</p>" : "") + "</div>" +
        '<div class="rf-actions">' +
        '<button class="rf-btn ' + (o.danger ? "danger" : "gold") + '" id="rfConfirmOk">' + esc(o.ok || "Yes") + "</button>" +
        (o.alt ? '<button class="rf-btn" id="rfConfirmAlt">' + esc(o.alt) + "</button>" : "") +
        '<button class="rf-btn" id="rfConfirmNo">' + esc(o.cancel || "Go back") + "</button></div>";
      box.hidden = false;
      const done = v => { box.hidden = true; box.innerHTML = ""; clearScanField(); resolve(v); };
      $("rfConfirmOk").onclick = () => done(true);
      $("rfConfirmNo").onclick = () => done(false);
      if (o.alt) $("rfConfirmAlt").onclick = () => done("alt");
    });
  }
  function photo(url) {
    const box = $("rfOverlay");
    box.className = "rf-overlay photo";
    box.innerHTML = '<img src="' + esc(url) + '" alt="Large photo of the card">';
    box.hidden = false;
    box.onclick = () => { box.hidden = true; box.innerHTML = ""; box.onclick = null; };
  }
  // Scryfall's own larger copy of the same picture, when it has one.
  const largeImage = url => String(url || "").replace(/\/(normal|small)\//, "/large/");
  acts({ photo: d => photo(d.url) });

  /* ------------------------- Sound and buzz ------------------------- */
  let audio = null;
  function feedback(kind) {
    try { if (navigator.vibrate) navigator.vibrate(kind === "ok" ? 60 : [120, 80, 120]); } catch (e) {}
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === "ok" ? [[880, 0, .09]] : [[220, 0, .16], [220, .22, .16]];
      for (const [hz, at, len] of notes) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = "square"; o.frequency.value = hz; g.gain.value = .08;
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + at); o.stop(audio.currentTime + at + len);
      }
    } catch (e) {}
  }

  /* ------------------------- Scanning ------------------------- */
  /* Three ways in, all ending in the same handler:
     - a Bluetooth scanner, which is a keyboard: it types the label then Enter.
       The field is inputmode="none" so the phone's keyboard stays down, and a
       scan that arrives while nothing is focused is still caught (keydown).
     - the camera: BarcodeDetector where it exists, else the vendored jsQR
       (iPhone Safari), which only downloads when the camera first opens.
     - typing, for the keyed path, which each job offers with a reason. */
  let scanHandler = null;
  let keyBuffer = "";
  /* viaCamera is passed on so a screen can treat a camera read (which can be a
     neighbouring label drifting into view) more carefully than a trigger pull.
     Nothing is read while a confirm or a stop screen is up: the camera keeps
     running behind it, and a read must never change what the person is confirming. */
  /* A scan typed into the field while a confirm or stop screen hid it is ignored, but its
     text stays in the box: clear it when that screen goes, or it spoils the next scan. */
  function clearScanField() {
    keyBuffer = "";
    const i = $("rfScanInput");
    if (i) i.value = "";
  }
  function fireScan(text, viaCamera) {
    const t = String(text || "").trim();
    keyBuffer = "";
    if ($("rfOverlay").hidden === false) return;
    if (t && scanHandler) scanHandler(t, !!viaCamera);
  }
  document.addEventListener("keydown", e => {
    if (!scanHandler || $("rfOverlay").hidden === false) return;
    const a = document.activeElement;
    if (a && a.id === "rfScanInput") {
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const v = a.value; a.value = ""; fireScan(v); }
      return;
    }
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    if (e.key === "Enter" || e.key === "Tab") { if (keyBuffer) { e.preventDefault(); fireScan(keyBuffer); } return; }
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) keyBuffer += e.key;
  });

  const cameraPossible = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const CAMERA_PREF = "rfCamera";
  const cameraWanted = () => { try { return localStorage.getItem(CAMERA_PREF) === "on"; } catch (e) { return false; } };
  const setCameraWanted = on => { try { localStorage.setItem(CAMERA_PREF, on ? "on" : "off"); } catch (e) {} };

  function loadJsQr() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/js/vendor/jsQR.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load the QR reader."));
      document.head.appendChild(s);
    });
  }
  async function makeDecoder() {
    if ("BarcodeDetector" in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) {
          const d = new window.BarcodeDetector({ formats: ["qr_code"] });
          return async video => { const r = await d.detect(video); return r[0] ? r[0].rawValue : ""; };
        }
      } catch (e) { /* fall through to jsQR */ }
    }
    await loadJsQr();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return async video => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return "";
      const scale = Math.min(1, 720 / Math.max(w, h));
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      return hit ? hit.data : "";
    };
  }
  const camera = {
    stream: null, timer: null, run: 0,
    stop() {
      this.run++;
      clearTimeout(this.timer);
      if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
    },
    async start() {
      const run = ++this.run;
      const box = $("rfVideoBox"), video = $("rfVideo");
      if (!box || !video) return;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      } catch (e) {
        setCameraWanted(false);
        const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
        scanNote(denied ? "The camera was refused. Allow it in this phone's settings for this site, or use a Bluetooth scanner."
          : "The camera didn't start. Use a Bluetooth scanner, or the button below.");
        return;
      }
      if (run !== this.run) { for (const t of stream.getTracks()) t.stop(); return; }
      this.stream = stream;
      box.hidden = false;
      const openBtn = $("rfCameraBtn");
      if (openBtn) openBtn.hidden = true;
      video.srcObject = stream;
      try { await video.play(); } catch (e) {}
      // A light for dark aisles, on the phones that let a page use it.
      const track = stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      const torch = $("rfTorch");
      if (torch && caps.torch) torch.hidden = false;
      let decode;
      try { decode = await makeDecoder(); }
      catch (e) { scanNote(e.message); return; }
      let lastText = "", lastSeen = 0;
      const tick = async () => {
        if (run !== this.run) return;
        let text = "";
        try { text = await decode(video); } catch (e) {}
        if (run !== this.run) return;
        // A label held in view is one scan, however long it stays there.
        if (text) {
          const fresh = text !== lastText || Date.now() - lastSeen > 2000;
          lastText = text; lastSeen = Date.now();
          if (fresh) fireScan(text, true);
        }
        if (run === this.run) this.timer = setTimeout(tick, 160);
      };
      tick();
    },
    async torch(btn) {
      const track = this.stream && this.stream.getVideoTracks()[0];
      if (!track) return;
      const on = !btn.classList.contains("on");
      try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.classList.toggle("on", on); } catch (e) {}
    }
  };
  function scanNote(text) {
    const n = $("rfScanNote");
    if (n) { n.textContent = text; n.hidden = !text; }
  }
  // The scan block for a screen's body. The buttons go in scanButtons().
  function scanBlock(placeholder) {
    return '<div class="rf-scan-wrap">' +
      '<div class="rf-video-box" id="rfVideoBox" hidden>' +
      '<video id="rfVideo" playsinline muted></video>' +
      '<button class="rf-torch" id="rfTorch" data-act="torch" title="Light" aria-label="Light" hidden>' + icon("flashlight") + "</button></div>" +
      '<input id="rfScanInput" class="rf-input" inputmode="none" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" ' +
      'placeholder="' + esc(placeholder || "Scan the label") + '" aria-label="Scan">' +
      '<div class="rf-msg warn" id="rfScanNote" hidden></div></div>';
  }
  // main: it's the screen's one big action (a scan is required), else a plain button.
  function cameraButton(main) {
    return cameraPossible()
      ? '<button class="rf-btn' + (main ? " gold" : "") + '" id="rfCameraBtn" data-act="cameraOn">' + icon("camera") + " Open camera</button>" : "";
  }
  // Plain http: browsers keep the camera from any page, so only the other two ways work.
  const cameraBlockedNote = () => (cameraPossible() ? "" :
    "The camera only works on a secure (https) address. A Bluetooth scanner still works, or use the button below.");
  /* Call from a screen's render: every scan on this screen goes to handler. */
  function scanning(handler) {
    after(() => {
      scanHandler = handler;
      keyBuffer = "";
      const input = $("rfScanInput");
      if (input) input.focus({ preventScroll: true });
      const note = cameraBlockedNote();
      if (note) scanNote(note);
      else if (cameraWanted()) camera.start();
    });
  }
  acts({
    cameraOn: () => { setCameraWanted(true); camera.start(); },
    torch: (d, el) => camera.torch(el)
  });
  /* The field needs to hold focus for a scanner that only types into a focused
     element; a stray tap on the background shouldn't lose it. */
  document.addEventListener("click", () => {
    const input = $("rfScanInput");
    if (input && scanHandler && document.activeElement !== input && $("rfOverlay").hidden) input.focus({ preventScroll: true });
  });

  /* ------------------------- Keep the screen awake ------------------------- */
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* no signal for this: the phone just sleeps as usual */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && awakeWanted) keepAwake(true);
  });
  let awakeWanted = false;
  function stayAwake(on) { awakeWanted = !!on; keepAwake(awakeWanted); }

  /* ------------------------- Live connection only ------------------------- */
  /* Owner (2026-10-31): Wi-Fi is solid, so the RF works live and stops with a
     clear message if the signal drops; no offline queue. The stop screen covers
     everything until the server answers again. What's already on the phone
     (the last ticks) goes up by itself through core.js's own save retry. */
  const PING_MS = 10000, PING_TIMEOUT_MS = 7000;
  let down = false, stopped = false, version = null, pingTimer = null;
  function showStop(title, body, button) {
    const box = $("rfOverlay");
    box.className = "rf-overlay rf-stop";
    box.innerHTML = '<div class="rf-body">' + icon(button ? "triangle-alert" : "wifi-off") +
      "<h2>" + esc(title) + '</h2><p class="rf-text">' + esc(body) + "</p></div>" +
      (button ? '<div class="rf-actions"><button class="rf-btn gold" id="rfStopBtn">' + esc(button.label) + "</button></div>" : "");
    box.hidden = false;
    if (button) $("rfStopBtn").onclick = button.onClick;
    camera.stop();
    feedback("bad");
  }
  function connectionLost() {
    if (down || stopped) return;
    down = true;
    showStop("No signal. Stop here.",
      "Don't pull any more cards until this clears. Stay on this screen and walk back into Wi-Fi: it carries on by itself where you left off.");
  }
  function connectionBack() {
    if (!down) return;
    down = false;
    if (stopped) return;
    const box = $("rfOverlay");
    box.hidden = true; box.innerHTML = "";
    clearScanField();
    feedback("ok");
    G.saveNow();
    redraw();
  }
  function stopFor(title, body) {
    stopped = true;
    showStop(title, body, { label: "Reload", onClick: () => { G.leaveWithoutSaving(); location.reload(); } });
  }
  async function ping() {
    clearTimeout(pingTimer);
    if (stopped) return;
    let meta = null;
    try {
      const ctrl = window.AbortController ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS) : null;
      const res = await fetch("/api/meta", { cache: "no-store", credentials: "same-origin", signal: ctrl ? ctrl.signal : undefined });
      if (t) clearTimeout(t);
      if (res.status >= 500) throw new Error("server error");
      meta = await res.json();
    } catch (e) { connectionLost(); }
    // This device became the store's kiosk (#433): leave for the kiosk screen.
    if (meta && meta.kiosk === true) { G.leaveForKiosk(); return; }
    if (meta) {
      connectionBack();
      // A deploy while this stays open: pick up the new pages at the next safe moment.
      if (meta.version) {
        if (version && version !== meta.version && !G.hasUnsaved()) location.reload();
        else if (!version) version = meta.version;
      }
      if (onAList()) refreshNow();   // redraws through the "loaded" change if it fetched
    }
    pingTimer = setTimeout(ping, down ? 3000 : PING_MS);
  }
  window.addEventListener("offline", connectionLost);
  window.addEventListener("online", ping);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") ping(); });

  function watchSaves() {
    G.on("savestate", s => {
      // A save refused for good needs a person; one that may pass is the signal.
      if (s.wrongOwner || s.conflict) return;
      if (s.error && !down) ping();
    });
    G.on("conflict", info => {
      stopFor(info.alreadyCompleted && info.alreadyCompleted.length ? "Done on another device" : "Changed somewhere else",
        info.alreadyCompleted && info.alreadyCompleted.length
          ? "Someone else already completed this ticket, so its cards came off once, not twice. Reload to carry on."
          : "Someone else changed the same thing, so your last step wasn't saved. Reload to see where things stand.");
    });
    G.on("wrongowner", () => stopFor("This phone changed stores", "Another tab switched this sign-in to a different store. Reload to carry on."));
    // Someone else's save merged into ours: draw from the merged stock.
    G.on("change", ev => { if (ev && (ev.reason === "merged" || ev.reason === "loaded")) redraw(); });
  }

  /* ------------------------- Staying current ------------------------- */
  /* A desk prints tickets while this stays open. Going back to a list asks the
     server whether anything changed (cheap), and only then fetches it all. A
     phone left sitting on Home or a job's list asks at every ping too, and on
     waking (the ping runs then), so its counts don't go stale. */
  let refreshing = false, seenRev = null;
  async function refreshNow() {
    if (refreshing || down || stopped) return false;
    refreshing = true;
    try { return (await G.catchUp()).loaded; }
    finally { refreshing = false; }
  }
  function refreshSoon() { setTimeout(refreshNow, 0); }
  // Home or a job's own list: no half-done step to redraw under anyone.
  const onAList = () => parts().length <= 1;
  function trackOwnSaves() {
    seenRev = G.rev;
    G.on("savestate", async s => {
      if (s.saving || s.error || s.rev === seenRev) return;
      seenRev = s.rev;
      // Our own save moved the stamp; that isn't news. Skipped while a refresh
      // runs, since it's about to compare and take the stamp itself.
      if (!refreshing) await G.stampOwnSave();
    });
  }

  /* ------------------------- Start ------------------------- */
  async function start() {
    G.setUndoOff(true);   // no Undo button here; see core.js setUndoOff
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
    try {
      await G.load();
    } catch (e) {
      if (e.status === 401) return;
      stopFor("Couldn't load", "No answer from the server. Check the Wi-Fi, then press Reload. " + (e.message || ""));
      return;
    }
    if (!G.me) return;   // on the way to sign-in
    watchSaves();
    trackOwnSaves();
    redraw(true);
    ping();
  }

  return { $, esc, icon, job, screen, acts, go, hashOf, head, redraw, hold, after, confirm, photo, largeImage, feedback,
    scanBlock, cameraButton, scanning, fireScan, stayAwake, refreshSoon, ping, start, get isDown() { return down; } };
})();
