"use strict";
(function () {
  const $ = UI.$;

  /* Order Entry → Kiosk (#433, part 3 of #402). A Manager or Owner (or a
     personal account) sets the staff PIN, switches the device they're on
     into kiosk mode for the store they're working in, and ends kiosks that
     are running. The server decides who may (GET /api/kiosk/setup answers
     403 to anyone else) and what a kiosk can reach (server/lib/kiosk.js). */

  let setup = null;

  function render() {
    const s = setup;
    $("ksStore").textContent = s.storeName ? "Store: " + s.storeName : "";
    $("ksStart").hidden = false;
    $("ksStart").disabled = !s.pinSet;
    $("ksStart").title = s.pinSet ? "" : "Set the staff PIN first";
    $("ksNeedPin").hidden = s.pinSet;
    $("ksPinHint").textContent = s.pinSet
      ? "A PIN is set. One PIN for the whole account: every kiosk asks for it to leave kiosk mode. Setting a new one replaces it."
      : "No PIN yet. One PIN for the whole account: every kiosk asks for it to leave kiosk mode. Give it to the staff who need it.";
    $("ksPinSave").textContent = s.pinSet ? "Change PIN" : "Set PIN";
    const lim = s.limits || {};
    $("ksMaxCards").value = lim.maxCards == null ? "" : String(lim.maxCards);
    $("ksMaxWaiting").value = lim.maxWaiting == null ? "" : String(lim.maxWaiting);
    $("ksRunHdr").textContent = s.kiosks.length ? String(s.kiosks.length) : "";
    $("ksRunHdr").hidden = !s.kiosks.length;
    const body = $("ksRunBody");
    if (!s.kiosks.length) {
      body.innerHTML = UI.emptyRow(4, { icon: "generic", title: "No kiosk is running.", hint: "On the device that stays in the store, press Start kiosk on this device." });
      return;
    }
    body.innerHTML = s.kiosks.map(k => {
      const when = Date.parse(k.startedAt);
      return "<tr>" +
        '<td data-v="' + (isNaN(when) ? 0 : when) + '">' + G.esc(isNaN(when) ? "—" : new Date(when).toLocaleString()) + "</td>" +
        "<td>" + G.esc(k.by || "—") + (k.running ? "" : ' <span class="pill off" title="Whoever started it is no longer a manager here, so it has stopped">stopped</span>') + "</td>" +
        '<td class="hide-sm faint" title="' + G.esc(k.device) + '">' + G.esc(deviceName(k.device)) + "</td>" +
        '<td><button class="small danger" data-end="' + G.esc(k.id) + '">End kiosk…</button></td></tr>';
    }).join("");
    UI.reapplySorts();
  }
  // A readable guess at the device from its browser's description.
  function deviceName(ua) {
    const u = String(ua || "");
    const os = /iPad/.test(u) ? "iPad" : /iPhone/.test(u) ? "iPhone" : /Android/.test(u) ? "Android" : /CrOS/.test(u) ? "Chromebook"
      : /Windows/.test(u) ? "Windows" : /Mac OS X/.test(u) ? "Mac" : /Linux/.test(u) ? "Linux" : "";
    const br = /Edg\//.test(u) ? "Edge" : /Chrome\//.test(u) ? "Chrome" : /Firefox\//.test(u) ? "Firefox" : /Safari\//.test(u) ? "Safari" : "";
    return [br, os].filter(Boolean).join(" on ") || "—";
  }

  async function load() {
    try {
      setup = await G.api("/api/kiosk/setup");
    } catch (e) {
      $("ksBody").hidden = true;
      $("ksStart").hidden = true;
      $("ksDenied").hidden = false;
      $("ksDenied").innerHTML = UI.emptyBlock({ icon: "generic", title: G.esc(e.message || "The kiosk can't be set up from here.") });
      return;
    }
    $("ksDenied").hidden = true;
    $("ksBody").hidden = false;
    render();
  }

  async function savePin() {
    const pin = $("ksPin").value.trim(), again = $("ksPin2").value.trim();
    if (!/^\d{4,8}$/.test(pin)) { UI.setStatus("ksPinStatus", "The PIN must be 4 to 8 digits.", "err"); $("ksPin").focus(); return; }
    if (pin !== again) { UI.setStatus("ksPinStatus", "The two PINs don't match.", "err"); $("ksPin2").focus(); return; }
    if (setup.pinSet && !(await UI.confirmDialog("Replace the staff PIN? The old one stops working on every kiosk at once.",
      { title: "Change the PIN?", okLabel: "Change PIN" }))) return;
    $("ksPinSave").disabled = true;
    try {
      await G.api("/api/kiosk/pin", { method: "POST", body: { pin } });
      $("ksPin").value = $("ksPin2").value = "";
      UI.setStatus("ksPinStatus", "Staff PIN saved.", "ok");
      await load();
    } catch (e) {
      UI.setStatus("ksPinStatus", e.message, "err");
    } finally {
      $("ksPinSave").disabled = false;
    }
  }

  // Blank = no limit; the server checks for a whole number of 1 or more too.
  async function saveLimits() {
    const read = id => {
      const v = $(id).value.trim();
      if (!v) return { ok: true, value: null };
      return /^\d+$/.test(v) && Number(v) >= 1 ? { ok: true, value: Number(v) } : { ok: false };
    };
    const cards = read("ksMaxCards"), waiting = read("ksMaxWaiting");
    if (!cards.ok) { UI.setStatus("ksLimitsStatus", "Most cards in one order must be a whole number of 1 or more, or blank.", "err"); $("ksMaxCards").focus(); return; }
    if (!waiting.ok) { UI.setStatus("ksLimitsStatus", "Most orders waiting must be a whole number of 1 or more, or blank.", "err"); $("ksMaxWaiting").focus(); return; }
    $("ksLimitsSave").disabled = true;
    try {
      await G.api("/api/kiosk/limits", { method: "POST", body: { maxCards: cards.value, maxWaiting: waiting.value } });
      UI.setStatus("ksLimitsStatus", "Limits saved.", "ok");
      await load();
    } catch (e) {
      UI.setStatus("ksLimitsStatus", e.message, "err");
    } finally {
      $("ksLimitsSave").disabled = false;
    }
  }

  async function start() {
    // The page's old warning box lives here now (#438): it's what this button does.
    const ok = await UI.confirmDialog("This device shows only the kiosk from then on, with " +
      (setup.storeName ? setup.storeName + "'s" : "this store's") + " cards that are free to sell at market price. " +
      "Staff leave kiosk mode with the staff PIN. Close any other Grimoire tabs on this device first.",
      { title: "You'll be signed out on this device", okLabel: "Start kiosk" });
    if (!ok) return;
    $("ksStart").disabled = true;
    UI.setStatus("ksStartStatus", "Saving your changes first…", "work");
    // Like signing out: nothing unsaved may be lost when this session ends.
    if (!(await G.saveAll(10000))) {
      UI.setStatus("ksStartStatus", "Your last change hasn't saved yet, so the kiosk wasn't started. Try again in a moment.", "err");
      $("ksStart").disabled = false;
      return;
    }
    try {
      await G.api("/api/kiosk/start", { method: "POST", body: { owner: G.loadedOwner } });
      G.leaveWithoutSaving();   // this session is gone: nothing more to save, and no "Leave site?" prompt
      location.replace("/kiosk.html");
    } catch (e) {
      UI.setStatus("ksStartStatus", e.message, "err");
      $("ksStart").disabled = !setup.pinSet;
    }
  }

  async function endKiosk(id) {
    const ok = await UI.confirmDialog("End this kiosk? Its screen leaves kiosk mode and goes to the sign-in page the next time it's used.",
      { title: "End the kiosk?", okLabel: "End kiosk", danger: true });
    if (!ok) return;
    try {
      await G.api("/api/kiosk/" + encodeURIComponent(id) + "/end", { method: "POST" });
      UI.toast("Kiosk ended.", "ok");
    } catch (e) {
      UI.toast(e.message, "err");
    }
    load();
  }

  UI.boot(async function () {
    // Running kiosks first; the tab is remembered (UI.pageTabs).
    UI.pageTabs({ tabs: [
      { id: "running", button: "ksTabRunning", panes: ["ksPaneRunning"] },
      { id: "pin", button: "ksTabPin", panes: ["ksPanePin"] },
      { id: "limits", button: "ksTabLimits", panes: ["ksPaneLimits"] }
    ] });
    $("ksPinSave").onclick = savePin;
    $("ksLimitsSave").onclick = saveLimits;
    $("ksStart").onclick = start;
    $("ksRunBody").addEventListener("click", e => {
      const b = e.target.closest("[data-end]");
      if (b) endKiosk(b.dataset.end);
    });
    await load();
  });
})();
