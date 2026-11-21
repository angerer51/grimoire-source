"use strict";
(function () {
  const $ = UI.$;
  let registrationLine = "";

  /* ============================== Account ============================== */
  async function changePassword() {
    const cur = $("pwOld").value, next = $("pwNew").value;
    if (next !== $("pwNew2").value) { UI.setStatus("acctStatus", "The two new passwords do not match.", "err"); return; }
    $("pwSave").disabled = true;
    try {
      const out = await G.api("/api/auth/password", { method: "POST", body: { current: cur, next } });
      UI.setStatus("acctStatus", "Password changed" +
        (out.signedOutSessions ? " — " + out.signedOutSessions + " other session(s) were signed out." : "."), "ok");
      $("pwOld").value = $("pwNew").value = $("pwNew2").value = "";
    } catch (e) {
      UI.setStatus("acctStatus", e.message, "err");
    }
    $("pwSave").disabled = false;
  }


  /* ============================== Import a v0.07 save ============================== */
  let legacyText = null;

  function legModeNote() {
    const replace = $("legMode").value === "replace";
    $("legModeNote").innerHTML = replace
      ? "<b>Replace</b> throws away what is in this collection now and takes the file instead. The version it " +
        "displaces is kept in the revision list below, so you can put it back — but do it deliberately."
      : "<b>Merge</b> keeps what you have and adds the file on top. Bins are matched by name, so a " +
        "“Bulk Box A” in both is one bin, not two. Identical stacks in the same bin add together. " +
        "Importing the same file twice would double your cards, so only do it once.";
  }

  async function pickLegacy() {
    const f = await G.pickFile(".json,application/json");
    if (!f) return;
    try {
      const info = G.inspectLegacy(f.text);
      legacyText = f.text;
      const warn = [];
      if (!info.withCost) warn.push("no cost basis — v0.07 never tracked what you paid, so every stack arrives " +
        "with an unknown cost. Post future purchases as lot receipts and use Manage → Set cost basis to backfill.");
      if (info.noMeta) warn.push(info.noMeta + " stack(s) carry no card data (type line, colours, oracle text). " +
        "Putaway rules and queries cannot see those until a refresh fills them in.");
      warn.push("locations arrive with putaway switched off and no ceilings, per-card caps or sorting-tray flags — " +
        "none of that existed in v0.07. Set it up on the Locations page afterwards.");
      if (info.orphanStacks) warn.push(info.orphanStacks +
        " stack(s) reference a bin that is not in the file; they will land in “Unsorted”.");

      $("legReport").innerHTML =
        '<div class="callout ok" style="margin-top:12px"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#file-text></use></svg></span><div class="cbody">' +
        "<h3>" + G.esc(f.name) + "</h3>" +
        "<b>" + info.cards.toLocaleString() + "</b> cards in <b>" + info.stacks.toLocaleString() +
        "</b> stacks across <b>" + info.locations + "</b> bins · " + G.money(info.value) + " at the file's prices" +
        "<br>" + info.names.toLocaleString() + " distinct card names" +
        (info.savedAt ? " · saved " + new Date(info.savedAt).toLocaleString() : "") +
        " · file version " + G.esc(String(info.version)) +
        (info.locationsMatched
          ? "<br>" + info.locationsMatched + " of its bins already exist here by name; " +
            info.locationsNew + " would be created"
          : info.locations ? "<br>all " + info.locations + " bins would be created" : "") +
        (info.pickList || info.deckList || info.audit || info.history
          ? "<br><span class='faint'>Also in the file: " + [
              info.pickList ? info.pickList + " pick-list line(s)" : "",
              info.deckList ? info.deckList + " deck-list line(s)" : "",
              info.audit ? info.audit + " audit entries" : "",
              info.history ? info.history + " ship/build events" : ""
            ].filter(Boolean).join(", ") + " — carried over on Replace only.</span>"
          : "") +
        "</div></div>" +
        '<div class="cost-note">What v0.07 did not have, and so does not arrive:<ul style="margin:6px 0 0 18px;padding:0">' +
        warn.map(w => "<li>" + w + "</li>").join("") + "</ul></div>";
      $("legActions").hidden = false;
      legModeNote();
      UI.setStatus("legStatus", "", "");
    } catch (e) {
      legacyText = null;
      $("legReport").innerHTML = "";
      $("legActions").hidden = true;
      UI.setStatus("legStatus", "Couldn't read that file: " + e.message, "err");
    }
  }

  async function runLegacy() {
    if (!legacyText) return;
    const mode = $("legMode").value;
    const info = G.inspectLegacy(legacyText);
    const msg = mode === "replace"
      ? "Replace this collection with the file?\n\n" +
        "Out: " + G.state.cards.length + " stack(s) in " + G.state.locations.length + " bin(s).\n" +
        "In:  " + info.stacks + " stack(s) in " + info.locations + " bin(s).\n\n" +
        "The current version stays in the revision list, so this is reversible."
      : "Merge " + info.cards + " card(s) from the file into this collection?\n\n" +
        "Bins are matched by name. Undo reverses the whole import.";
    // Replace wholesale-wipes the collection the same way "Erase this
    // collection" does (Settings' own Danger zone below) - it deserves the
    // same danger styling, even though both are revision-recoverable.
    const ok = await UI.confirmDialog(msg,
      { title: mode === "replace" ? "Replace collection?" : "Merge collection?", danger: mode === "replace" });
    if (!ok) return;

    $("legGo").disabled = true;
    let out;
    try { out = G.importLegacy(legacyText, { mode }); }
    catch (e) { UI.setStatus("legStatus", "Couldn't import: " + e.message, "err"); $("legGo").disabled = false; return; }

    UI.setStatus("legStatus", "Imported. Saving to the server…", "work");
    // A Replace throws the current collection away: the server keeps it as
    // a revision whatever its 5-minute archive interval says (#157).
    try { await G.saveNow({ archive: out.mode === "replace" }); await G.saveAll(); } catch (e) {}

    let tail = "";
    if ($("legRefresh").checked) {
      UI.setStatus("legStatus", "Imported. Refreshing prices and card data…", "work");
      try {
        const r = await G.refreshPrices(m => UI.setStatus("legStatus", m, "work"));
        await G.saveNow();
        tail = " Refreshed " + r.updated + " of " + r.rows + " stack(s)" +
          (r.metaFilled ? ", filling in card data on " + r.metaFilled : "") +
          (r.missing ? ", " + r.missing + " not found in the card database" : "") +
          (r.skipped ? ", " + r.skipped + " couldn't be refreshed (run it again from the Inventory page)" : "") + ".";
      } catch (e) { tail = " The refresh failed (" + e.message + ") — run it from the Inventory page."; }
    }

    UI.setStatus("legStatus",
      (out.mode === "replace"
        ? "Replaced the collection: " + out.stacks + " stack(s), " + out.cards + " card(s), " +
          out.locations + " bin(s)."
        : "Merged " + out.added + " card(s): " + out.created + " new bin(s), " +
          out.mergedStacks + " stack(s) folded into ones you already had.") + tail +
      " Next: set ceilings and putaway rules on the Locations page.", "ok");
    UI.toast("Import finished. Undo reverses it, and the previous version is in the revision list.", "ok");
    legacyText = null;
    $("legActions").hidden = true;
    $("legReport").innerHTML = "";
    $("legGo").disabled = false;
    loadRevisions();
  }

  /* ============================== Revisions ============================== */
  /* #185: both name the inventory this page loaded (G.loadedOwner), so a
     tab left on one store neither lists nor restores another store's
     revisions after the session switched (another tab, the store
     switcher). The refusal is the save path's: G.refusedForOwner shows
     its message with a Reload button and stops this page saving. */
  async function loadRevisions() {
    const body = $("revBody");
    body.innerHTML = UI.skeletonRows(6, 4);
    let d;
    const owner = G.loadedOwner;
    try { d = await G.api("/api/collection/revisions" + (owner != null ? "?owner=" + encodeURIComponent(owner) : "")); }
    catch (e) {
      G.refusedForOwner(e);
      body.innerHTML = UI.emptyRow(6, { icon: "error", title: G.esc(e.message) });
      return;
    }
    if (!d.revisions.length) {
      body.innerHTML = UI.emptyRow(6, { icon: "history", title: "No earlier revisions yet.",
        hint: "They build up as you work." });
      return;
    }
    body.innerHTML = "";
    for (const r of d.revisions) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td class="num">' + r.rev + "</td>" +
        // data-v: sort by the real time, not the month the text starts with (#164).
        '<td data-v="' + (Date.parse(r.savedAt) || "") + '">' + G.esc(r.savedAt ? new Date(r.savedAt).toLocaleString() : "") +
          (r.forced ? ' <span class="faint">· kept before a big change</span>' : "") + "</td>" +
        '<td class="num">' + r.stacks + "</td>" +
        '<td class="num">' + r.cards + "</td>" +
        '<td class="num">' + r.locations + "</td>";
      const td = document.createElement("td");
      tr.appendChild(td);
      body.appendChild(tr);
      // Restoring replaces a store's whole inventory: managers and owners
      // only (#159; the server refuses anyone else).
      if (!G.canManageStore()) continue;
      const btn = document.createElement("button");
      btn.className = "small";
      btn.textContent = "Restore";
      td.appendChild(btn);
      btn.onclick = async () => {
        const ok = await UI.confirmDialog("Restore revision " + r.rev + " (" + r.cards + " cards, " + r.stacks + " stacks)?\n\n" +
          "Your current version is kept as a revision, so this is reversible.", { title: "Restore this revision?" });
        if (!ok) return;
        const req = { rev: r.rev };
        if (owner != null) req.owner = owner;
        try {
          await G.api("/api/collection/restore", { method: "POST", body: req });
          location.reload();
        } catch (e) {
          if (G.refusedForOwner(e, { again: true })) return;
          UI.toast("Restore failed: " + e.message, "err");
        }
      };
    }
    UI.reapplySorts();
  }

  /* ============================== Status boxes ============================== */
  async function loadStatus() {
    try {
      const c = await G.cards.status();
      $("cardBox").innerHTML = [
        c.ready ? "<b>" + c.count.toLocaleString() + "</b> cards indexed" : "<b>not loaded yet</b>",
        "bulk file: " + G.esc(c.bulkType),
        c.updatedAt ? "Scryfall updated " + G.esc(String(c.updatedAt).replace("T", " ").slice(0, 16)) : "",
        c.builtAt ? "indexed here " + new Date(c.builtAt).toLocaleString() : "",
        c.building ? '<span class="warn">rebuilding — ' + G.esc(c.progress || "working") + "</span>" : "",
        c.names ? c.names.toLocaleString() + " distinct card names, " + c.sets + " sets" : "",
        "live fallback: " + (c.liveFallback ? "on" : "off") +
          (c.liveHits || c.liveMisses ? " (" + c.liveHits + " hits, " + c.liveMisses + " misses this run)" : ""),
        c.error ? '<span class="bad">last error: ' + G.esc(c.error) + "</span>" : ""
      ].filter(Boolean).join("<br>");
    } catch (e) { $("cardBox").textContent = e.message; }

    try {
      const p = await G.api("/api/prices/status");
      $("priceBox").innerHTML = [
        "<b>" + p.snapshots + "</b> daily snapshot" + (p.snapshots === 1 ? "" : "s"),
        p.first ? "from " + G.esc(p.first) + " to " + G.esc(p.last) : "none taken yet",
        p.printings ? p.printings.toLocaleString() + " printings in the latest snapshot" : "",
        "kept for " + p.keepDays + " days"
      ].filter(Boolean).join("<br>");
    } catch (e) { $("priceBox").textContent = e.message; }

    try {
      const m = await G.api("/api/meta");
      registrationLine = "<b>Registration</b>: " + G.esc(m.registration);
    } catch (e) { registrationLine = e.message; }

    await loadIntegrations();
  }

  /* ============================== Integrations ============================== */
  async function loadIntegrations() {
    let d;
    try { d = await G.api("/api/integrations"); }
    catch (e) { UI.setStatus("intStatus", e.message, "err"); return; }

    const mp = d.manapool;
    const mpLine = !mp.featureOn ? "off — ask an administrator to enable it in config.json"
      : mp.connected ? "connected"
      : mp.legacy ? "connected with an old access token — reconnect below"
      : mp.dead ? "disconnected — reconnect below"
      : "not connected";
    const pbLine = !d.pitneyBowes.featureOn ? "off — ask an administrator to enable it in config.json"
      : (d.pitneyBowes.hasKey && d.pitneyBowes.hasSecret) ? "connected" + (d.pitneyBowes.shipperId ? " (shipper " + G.esc(d.pitneyBowes.shipperId) + ")" : "")
      : "not connected — add your credentials below";
    $("intBox").innerHTML = "<b>Mana Pool</b>: " + mpLine + "<br><b>Shipping labels</b>: " + pbLine +
      (registrationLine ? "<br>" + registrationLine : "");

    renderManapool(mp);
    $("pbShipper").value = d.pitneyBowes.shipperId || "";
    $("pbKey").value = ""; $("pbSecret").value = "";

    $("testPb").disabled = !d.pitneyBowes.featureOn;
  }

  /* Mana Pool connects through Mana Pool's own sign-in (#499): Connect goes
     to their consent page and comes back here; nothing is typed in. */
  const longDay = iso => { try { return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }); } catch (e) { return iso; } };
  function renderManapool(mp) {
    const st = $("mpState");
    let html;
    if (!mp.featureOn) html = '<span class="muted">Mana Pool is turned off on this server.</span>';
    else if (!mp.appReady && !mp.connected && !mp.legacy) html = '<span class="muted">An administrator needs to set up Grimoire\'s Mana Pool app (Admin → Mana Pool) before you can connect.</span>';
    else if (mp.connected) {
      html = '<span class="pill on">Connected</span> since ' + G.esc(longDay(mp.connectedAt)) + ".";
      if (mp.otherInventoryApp) html += ' <span class="muted">Another app manages your Mana Pool listings, so Grimoire reads them but doesn\'t change them.</span>';
    } else if (mp.dead) {
      html = mp.deadReason === "old-token-removed"
        ? "Your old Mana Pool access token was removed. Connect Mana Pool to use it again."
        : "Mana Pool ended Grimoire's connection (it was disconnected on Mana Pool, or not used for a long time). Reconnect to use it again.";
    } else if (mp.legacy) html = "Connected with an old access token.";
    else html = '<span class="muted">Not connected.</span>';
    st.innerHTML = html;
    $("mpGraceNote").hidden = !(mp.legacy && mp.appReady);
    if (mp.legacy) {
      $("mpGraceText").textContent = "You're still using an old access token" + (mp.legacyEmail ? " (" + mp.legacyEmail + ")" : "") +
        ". It stops working on " + (mp.cutoffAt ? longDay(mp.cutoffAt) : "a set date") + ". Press Connect Mana Pool to switch; " +
        "the old token is deleted as soon as you're connected.";
    }
    const canConnect = mp.featureOn && mp.appReady;
    $("mpConnect").hidden = !!mp.connected;
    $("mpConnect").disabled = !canConnect;
    $("mpConnectLabel").textContent = mp.dead ? "Reconnect Mana Pool" : "Connect Mana Pool";
    $("mpDisconnect").hidden = !(mp.connected || mp.dead || mp.legacy);
    if (mp.connected) $("mpConnectNoInv").hidden = true;
    $("testMp").disabled = !(mp.featureOn && mp.hasToken);
  }

  // withoutInventory (#499): another app manages this seller's listings, so ask
  // Mana Pool for everything else only.
  async function connectManapool(withoutInventory) {
    const btn = $(withoutInventory === true ? "mpConnectNoInv" : "mpConnect");
    btn.disabled = true;
    UI.setStatus("intStatus", "Opening Mana Pool…", "work");
    try {
      const out = await G.api("/api/manapool/oauth/start", { method: "POST", body: { withoutInventory: withoutInventory === true } });
      location.href = out.url;
    } catch (e) {
      UI.setStatus("intStatus", e.message, "err");
      btn.disabled = false;
    }
  }
  async function disconnectManapool() {
    const ok = await UI.confirmDialog("Grimoire stops reading your Mana Pool orders and changing your listings until you connect again. " +
      "Your listings on Mana Pool stay as they are.", { title: "Disconnect Mana Pool?", danger: true, okLabel: "Disconnect" });
    if (!ok) return;
    const btn = $("mpDisconnect");
    btn.disabled = true;
    try {
      const out = await G.api("/api/manapool/oauth/disconnect", { method: "POST", body: {} });
      UI.setStatus("intStatus", out.revoked || !out.error ? "Disconnected from Mana Pool."
        : "Disconnected here, but Mana Pool didn't confirm it. To be sure, remove Grimoire on Mana Pool under Integrations → Connected apps.",
      out.revoked || !out.error ? "ok" : "err");
    } catch (e) { UI.setStatus("intStatus", e.message, "err"); }
    btn.disabled = false;
    await loadIntegrations();
  }
  // What Mana Pool's page sent back (?mp=... on the way back from it).
  const MP_RETURN = {
    connected: ["Mana Pool is connected.", "ok"],
    denied: ["Mana Pool wasn't connected: it was turned down on Mana Pool's page. Press Connect Mana Pool to try again.", "err"],
    scope: ["Mana Pool turned down what Grimoire asked for. An administrator needs to check the Mana Pool app's permissions.", "err"],
    expired: ["That connect attempt ran out, or was started from another window or account. Press Connect Mana Pool again.", "err"],
    error: ["Mana Pool didn't finish connecting. Press Connect Mana Pool to try again.", "err"]
  };
  function showManapoolReturn() {
    const q = new URLSearchParams(location.search);
    const k = q.get("mp");
    if (!k) return;
    const m = MP_RETURN[k] || MP_RETURN.error;
    // Turned down while asking for listing rights: maybe another app manages them.
    const offer = k === "denied" && q.get("inv") === "offer";
    $("mpConnectNoInv").hidden = !offer;
    UI.setStatus("intStatus", (offer ? "Mana Pool wasn't connected. If another app already manages your Mana Pool listings, " +
      "press Connect without listing changes: Grimoire then handles orders, shipping and purchases only." : m[0]) +
      (k === "connected" && q.get("inv") === "other"
      ? " Another app manages your Mana Pool listings, so Grimoire won't change them. Orders, shipping and purchases work as usual." : ""), m[1]);
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) { /* keep the address */ }
  }

  function wireManapool() {
    $("mpConnect").onclick = () => connectManapool(false);
    $("mpDisconnect").onclick = disconnectManapool;
    $("mpConnectNoInv").onclick = () => connectManapool(true);
    showManapoolReturn();
    UI.wireCredentialTest({
      buttonId: "testMp", statusId: "intStatus", url: "/api/manapool/status", workMsg: "Testing Mana Pool…",
      onResult: s => ({ ok: s.ok, msg: s.ok ? "Mana Pool answered — the connection works."
        : "Mana Pool refused: " + (s.error || "unknown") })
    });
  }

  function wirePitneyBowes() {
    UI.wireCredentialSave({
      buttonId: "pbSave", statusId: "intStatus", url: "/api/integrations/pitneybowes",
      fields: [{ id: "pbShipper", key: "shipperId" }, { id: "pbKey", key: "apiKey", secret: true },
        { id: "pbSecret", key: "apiSecret", secret: true }],
      savedMsg: "Pitney Bowes credentials saved.", onSaved: loadIntegrations
    });
    UI.wireCredentialTest({
      buttonId: "testPb", statusId: "intStatus", url: "/api/shipping/status", workMsg: "Testing the shipping API…",
      onResult: s => ({ ok: s.ok, msg: s.ok ? "Pitney Bowes issued a token — the credentials work."
        : "Pitney Bowes refused: " + (s.error || "unknown") })
    });
  }

  /* ============================== Admin ============================== */
  /* The dashboard itself moved to /admin.html - this is just a doorway,
     shown for moderator+ (G.isModerator covers both), same "your role
     already came back with G.me" data /api/auth/me always returns. */
  function loadAdmin() {
    if (!G.isModerator) return;
    $("adminSection").hidden = false;
    $("adminNote").textContent = G.isAdmin
      ? "Accounts, support tickets, invites, outgoing email, GitHub, the card database, price snapshots and server restart all live there."
      : "You can view accounts and help with tickets there.";
  }

  /* ============================== Preferences ============================== */
  /* In a store (#159) the Preferences split in two: Simple mode and the
     chime are this person's own (G.setPersonalPrefs saves them to their
     account), and the rest are the Store's defaults, shared with everyone
     working in it, which only a manager or owner can change (the server
     keeps them as they are on anyone else's save). A personal account
     looks and saves exactly as before. */
  const STORE_PREF_IDS = ["prefAutoPut", "prefAlloc", "prefCondition", "prefMovers", "prefCycleSize", "prefCycleThreshold", "prefRequireBinScan"];
  const PERSONAL_PREF_IDS = ["prefSimpleMode", "prefChime", "prefChimeMin"];

  async function loadStoreScope() {
    if (!G.prefsInAccount) return;
    const manage = G.canManageStore();
    $("prefGeneralHead").textContent = "Just for you";
    $("prefPersonalHint").hidden = false;
    $("prefDocHint").hidden = true;
    $("prefStoreNote").hidden = false;
    let storeName = "this store";
    try {
      const d = await G.api("/api/orgs/mine");
      const s = (d.stores || []).find(x => x.id === d.activeStoreId);
      if (s && s.name) storeName = s.name;
    } catch (e) { /* the generic wording is fine */ }
    $("prefStoreHead").textContent = "Store defaults: " + storeName;
    $("prefStoreHint").textContent = "Everything below is shared with everyone who works in " + storeName + "." +
      (manage ? " Changing it changes it for all of them." : " Only a store manager or owner can change it.");
    STORE_PREF_IDS.forEach(id => { $(id).disabled = !manage; });
  }

  function loadPrefs() {
    const s = G.state.settings;
    $("prefSimpleMode").checked = G.pref("simpleMode") === true;
    $("prefChime").checked = G.pref("chime") === true;
    $("prefChimeMin").value = G.pref("chimeMin") == null ? 20 : G.pref("chimeMin");
    $("prefAutoPut").checked = s.autoPutaway !== false;
    $("prefRequireBinScan").checked = s.requireBinScan === true;
    $("prefAlloc").value = s.lotAllocation || "market";
    $("prefCondition").value = G.defaultCondition();
    $("prefMovers").value = s.moversDays || 7;
    $("prefCycleSize").value = s.cycleCountSampleSize || 10;
    $("prefCycleThreshold").value = s.cycleCountErrorThreshold || 10;
  }
  async function savePersonalPrefs() {
    const wasSimple = G.simpleMode;
    const min = parseFloat($("prefChimeMin").value);
    const values = {
      simpleMode: $("prefSimpleMode").checked,
      chime: $("prefChime").checked,
      chimeMin: isNaN(min) ? 0 : min
    };
    try { await G.setPersonalPrefs(values); }
    catch (e) { UI.setStatus("prefPersonalStatus", "Couldn't save: " + e.message, "err"); return; }
    UI.setStatus("prefPersonalStatus", "", "");
    // Nav/page gating is decided once at page load (mountChrome/UI.boot), so
    // flipping this needs a reload to actually show/hide anything - other
    // prefs don't affect layout, so only reload on this specific change.
    // A personal account's choice rides in its document, so save that
    // first (saveAll, not saveNow, which never says whether it saved: #176);
    // an org member's is already saved to their account.
    if (values.simpleMode !== wasSimple) {
      const saved = await (G.prefsInAccount ? true : G.saveAll(10000));
      if (saved) location.reload();
      else UI.setStatus("prefPersonalStatus", "Your choice isn't saved yet (" + (G.saveState().error || "still saving") +
        "). Reload the page once the header says Saved to see the change.", "err");
    }
  }

  function saveStorePrefs() {
    if (!G.canManageStore()) return; // Staff: read-only (and the server keeps them anyway)
    const s = G.state.settings;
    s.autoPutaway = $("prefAutoPut").checked;
    s.requireBinScan = $("prefRequireBinScan").checked;
    s.lotAllocation = $("prefAlloc").value;
    s.defaultCondition = G.CONDITIONS.includes($("prefCondition").value) ? $("prefCondition").value : "NM";
    const md = parseInt($("prefMovers").value, 10);
    s.moversDays = md > 0 ? md : 7;
    const csz = parseInt($("prefCycleSize").value, 10);
    s.cycleCountSampleSize = csz > 0 ? csz : 10;
    const cth = parseInt($("prefCycleThreshold").value, 10);
    s.cycleCountErrorThreshold = cth > 0 ? cth : 10;
    G.persistSettings();
  }

  /* ============================== Shipping (#457) ============================== */
  /* What packing and posting an order costs this account: supplies, packing
     rules with card/value breaks, postage. The math is public/js/shipCost.js
     (shared with the server, which freezes each shipped sale's cost from the
     saved setup). Edits change a working copy; Save stores it in
     settings.shipping. In a store it's a Store default: managers and owners
     only (server/lib/orgs.js STORE_DEFAULT_KEYS keeps a Staff save out). */
  const SHIP_KINDS = { letter: "Letter", mailer: "Bubble mailer", box: "Box" };
  const SHIP_PER = { order: "per order", card: "per card", every: "one per N cards" };
  let ship = null;            // the working copy, ShipCost.normalize()d
  let shipCanEdit = true;
  let shipRuleIdx = -1;       // the rule open in the slide-over
  let shipPanel = null;
  const shipNum = v => { const t = String(v == null ? "" : v).trim(); return t === "" ? null : Number(t); };
  const shipId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const shipMoney = n => "$" + Number(n || 0).toFixed(2);
  const shipSupplyName = id => { const s = ship.supplies.find(x => x.id === id); return s ? s.name : "(removed supply)"; };
  const shipBreak = r => {
    const parts = [];
    if (r.upToCards != null) parts.push(r.upToCards + " card" + (r.upToCards === 1 ? "" : "s"));
    if (r.upToValue != null) parts.push(shipMoney(r.upToValue));
    return parts.length ? parts.join(" and ") : "no limit";
  };
  const shipItemText = i => {
    const q = i.qty === 1 ? "" : i.qty + " × ";
    return q + shipSupplyName(i.supply) + " " + (i.per === "every" ? "per " + i.every + " cards" : SHIP_PER[i.per]);
  };

  function renderShipSupplies() {
    $("shipSupplyRows").innerHTML = ship.supplies.map((s, i) =>
      "<tr>" +
        '<td data-label="Supply"><input type="text" maxlength="60" data-sup="' + i + '" data-f="name" value="' + G.esc(s.name) + '" aria-label="Supply name"></td>' +
        '<td class="num" data-label="Cost each ($)"><input type="number" min="0" step="0.01" data-sup="' + i + '" data-f="cost" value="' + s.cost + '" aria-label="Cost each of ' + G.esc(s.name) + '"></td>' +
        '<td class="num" data-label="Weight each (oz)"><input type="number" min="0" step="0.01" data-sup="' + i + '" data-f="oz" value="' + s.oz + '" aria-label="Weight each of ' + G.esc(s.name) + '"></td>' +
        '<td><button class="small ghost" data-sup-del="' + i + '" title="Remove supply" aria-label="Remove ' + G.esc(s.name) + '">' + UI.icon("trash-2") + "</button></td></tr>").join("") ||
      UI.emptyRow(4, { title: "No supplies yet", hint: "Add what you pack orders with." });
  }
  function renderShipRules() {
    const n = ship.rules.length;
    $("shipRuleRows").innerHTML = ship.rules.map((r, i) =>
      '<tr class="click" tabindex="0" data-rule="' + i + '">' +
        '<td class="num">' + (i + 1) + "</td>" +
        "<td>" + G.esc(r.name) + (r.off ? ' <span class="faint">(off)</span>' : "") + "</td>" +
        "<td>" + G.esc(SHIP_KINDS[r.kind]) + "</td>" +
        "<td>" + G.esc(shipBreak(r)) + "</td>" +
        '<td class="hide-sm faint ship-rule-sum">' + G.esc(r.items.map(shipItemText).join(", ") || "none") + "</td>" +
        '<td class="num">' +
          '<button class="small ghost" data-rule-move="' + i + '" data-by="-1" title="Move up" aria-label="Move ' + G.esc(r.name) + ' up"' + (i === 0 ? " disabled" : "") + ">" + UI.icon("chevron-down").replace("class=ic", 'class="ic flip"') + "</button>" +
          '<button class="small ghost" data-rule-move="' + i + '" data-by="1" title="Move down" aria-label="Move ' + G.esc(r.name) + ' down"' + (i === n - 1 ? " disabled" : "") + ">" + UI.icon("chevron-down") + "</button>" +
          '<button class="small ghost" data-rule-del="' + i + '" title="Remove rule" aria-label="Remove ' + G.esc(r.name) + '">' + UI.icon("trash-2") + "</button>" +
        "</td></tr>").join("") ||
      UI.emptyRow(6, { title: "No packing rules", hint: "Add a rule so orders have something to go in." });
  }
  function renderShipBands() {
    $("shipBandRows").innerHTML = ship.postage.bands.map((b, i) =>
      "<tr>" +
        '<td class="num" data-label="Up to (oz)"><input type="number" min="0" step="0.1" data-band="' + i + '" data-f="upToOz" value="' + (b.upToOz == null ? "" : b.upToOz) + '" placeholder="heavier" aria-label="Up to ounces"></td>' +
        '<td class="num" data-label="Price ($)"><input type="number" min="0" step="0.01" data-band="' + i + '" data-f="price" value="' + b.price + '" aria-label="Price"></td>' +
        '<td><button class="small ghost" data-band-del="' + i + '" title="Remove weight" aria-label="Remove this weight">' + UI.icon("trash-2") + "</button></td></tr>").join("") ||
      UI.emptyRow(3, { title: "No tracked prices", hint: "Add your price for each weight." });
  }
  function renderShipPostage() {
    $("shipCardOz").value = ship.cardOz;
    $("shipStamp").value = ship.postage.stamp;
    $("shipExtraOz").value = ship.postage.extraOunce;
    $("shipLetterMax").value = ship.postage.letterMaxOz;
  }
  // Problems that would quietly give a wrong cost: shown as a warning, Save still allowed.
  function shipWarnings() {
    const w = [];
    const on = ship.rules.filter(r => !r.off);
    if (!on.length) w.push("No packing rule is on, so orders get no shipping cost.");
    else if (!on.some(r => r.kind !== "letter")) w.push("Every rule is a letter, so an order that needs tracking gets no shipping cost.");
    if (!ship.postage.bands.length && on.some(r => r.kind !== "letter")) w.push("There are no tracked prices, so bubble mailers and boxes cost $0 to post.");
    return w;
  }
  function renderShipTry() {
    const w = shipWarnings();
    $("shipWarn").hidden = !w.length;
    $("shipWarnText").textContent = w.join(" ");
    const cards = Math.max(1, Math.floor(Number($("shipTryCards").value) || 1));
    const value = Math.max(0, Number($("shipTryValue").value) || 0);
    const r = window.ShipCost.costOrder({ cards, value, tracked: $("shipTryTracked").checked }, ship);
    $("shipTryOut").textContent = !r ? "No rule can carry this order." :
      r.ruleName + (r.fallback ? " (past every rule's limit)" : "") + ": " + r.oz + " oz, supplies " + shipMoney(r.supplies) +
      " + postage " + shipMoney(r.postage) + (r.extraOunces ? " (" + r.extraOunces + " extra ounce" + (r.extraOunces === 1 ? "" : "s") + ")" : "") +
      " = " + shipMoney(r.total);
  }
  function renderShip() { renderShipSupplies(); renderShipRules(); renderShipBands(); renderShipPostage(); renderShipTry(); }

  function renderShipRule() {
    const r = ship.rules[shipRuleIdx];
    if (!r) return;
    const dis = shipCanEdit ? "" : " disabled";
    const supOpts = sel => ship.supplies.map(s => '<option value="' + G.esc(s.id) + '"' + (s.id === sel ? " selected" : "") + ">" + G.esc(s.name) + "</option>").join("") +
      (ship.supplies.some(s => s.id === sel) ? "" : '<option value="' + G.esc(sel) + '" selected>(removed supply)</option>');
    $("shipRuleBody").innerHTML =
      '<h3 id="shipRuleTitle" style="margin-top:0">' + G.esc(r.name) + "</h3>" +
      '<div class="ship-rule-fields">' +
        '<label>Name <input type="text" maxlength="60" data-rf="name" value="' + G.esc(r.name) + '"' + dis + "></label>" +
        '<label>Package <select data-rf="kind"' + dis + ">" + Object.keys(SHIP_KINDS).map(k => '<option value="' + k + '"' + (k === r.kind ? " selected" : "") + ">" + SHIP_KINDS[k] + "</option>").join("") + "</select></label>" +
        '<label>Up to cards <input type="number" min="1" step="1" data-rf="upToCards" value="' + (r.upToCards == null ? "" : r.upToCards) + '" placeholder="no limit"' + dis + "></label>" +
        '<label>Up to order value ($) <input type="number" min="0" step="0.01" data-rf="upToValue" value="' + (r.upToValue == null ? "" : r.upToValue) + '" placeholder="no limit"' + dis + "></label>" +
        (r.kind === "letter" ? '<label>Nonmachinable surcharge ($) <input type="number" min="0" step="0.01" data-rf="nonmachinable" value="' + r.nonmachinable + '"' + dis + "></label>" : "") +
      "</div>" +
      '<label class="row"><input type="checkbox" data-rf="off"' + (r.off ? " checked" : "") + dis + "> Switched off (skipped)</label>" +
      '<div class="hint">Both limits set: the order must fit both. Leave one blank for no limit.</div>' +
      '<h3 class="sub-h">Supplies this rule uses</h3>' +
      '<div class="list-wrap"><table class="list stack-sm ship-rule-items"><thead><tr><th>Supply</th><th>How many</th><th class="num">Every N cards</th><th class="num">Qty</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>' +
      (r.items.map((it, j) => "<tr>" +
        '<td data-label="Supply"><select data-it="' + j + '" data-f="supply" aria-label="Supply"' + dis + ">" + supOpts(it.supply) + "</select></td>" +
        '<td data-label="How many"><select data-it="' + j + '" data-f="per" aria-label="How many"' + dis + ">" + Object.keys(SHIP_PER).map(k => '<option value="' + k + '"' + (k === it.per ? " selected" : "") + ">" + SHIP_PER[k] + "</option>").join("") + "</select></td>" +
        '<td class="num" data-label="Every N cards"><input type="number" min="1" step="1" data-it="' + j + '" data-f="every" value="' + it.every + '" aria-label="Every N cards"' + (it.per === "every" ? "" : " disabled") + dis + "></td>" +
        '<td class="num" data-label="Qty"><input type="number" min="0" step="1" data-it="' + j + '" data-f="qty" value="' + it.qty + '" aria-label="Quantity"' + dis + "></td>" +
        '<td><button class="small ghost" data-it-del="' + j + '" title="Remove from rule" aria-label="Remove from rule"' + dis + ">" + UI.icon("trash-2") + "</button></td></tr>").join("") ||
        UI.emptyRow(5, { title: "No supplies in this rule" })) +
      "</tbody></table></div>" +
      '<div class="toolbar ship-tools"><button class="small" id="shipRuleAddItem"' + (shipCanEdit && ship.supplies.length ? "" : " disabled") + ">" + UI.icon("plus") + " Add supply</button>" +
      '<span class="spacer"></span><button class="primary" id="shipRuleDone">Done</button></div>' +
      '<div class="hint">Changes here are kept when you press <b>Save shipping costs</b>.</div>';
  }
  function openShipRule(i) {
    shipRuleIdx = i;
    renderShipRule();
    shipPanel.open();
  }

  // A number box → the working copy. Blank or negative in a limit box: the box says why.
  function shipReadNumber(el, allowBlank) {
    const v = shipNum(el.value);
    if (v == null) return allowBlank ? { ok: true, v: null } : { ok: false };
    if (!isFinite(v) || v < 0) return { ok: false };
    return { ok: true, v };
  }

  function validateShip() {
    const errs = [];
    ship.supplies.forEach(s => { if (!String(s.name).trim()) errs.push("A supply has no name."); });
    ship.rules.forEach(r => {
      if (!String(r.name).trim()) errs.push("A packing rule has no name.");
      if (r.upToCards != null && r.upToCards < 1) errs.push("“" + r.name + "”: up to cards must be 1 or more, or blank.");
    });
    const open = ship.postage.bands.filter(b => b.upToOz == null).length;
    if (open > 1) errs.push("Only one tracked weight can be left blank (anything heavier).");
    return errs;
  }

  function initShipping() {
    if (!window.ShipCost || !$("paneShipping")) return;
    ship = window.ShipCost.normalize(G.state.settings.shipping);
    shipCanEdit = !G.prefsInAccount || G.canManageStore();
    if (G.prefsInAccount) {
      $("shipStoreNote").hidden = false;
      $("shipStoreHint").textContent = "Shared with everyone in this store." +
        (shipCanEdit ? " Changing them changes them for all of them." : " Only a store manager or owner can change them.");
    }
    $("shipFields").disabled = !shipCanEdit;
    $("shipActions").hidden = !shipCanEdit;
    shipPanel = UI.slideOver("shipRulePanel");
    renderShip();

    $("shipSupplyRows").addEventListener("input", e => {
      const el = e.target, i = Number(el.dataset.sup), s = ship.supplies[i];
      if (!s) return;
      if (el.dataset.f === "name") s.name = el.value;
      else { const r = shipReadNumber(el, false); el.classList.toggle("invalid", !r.ok); if (r.ok) s[el.dataset.f] = r.v; }
      renderShipTry();
    });
    $("shipSupplyRows").addEventListener("change", e => { if (e.target.dataset.f === "name") renderShipRules(); });
    $("shipSupplyRows").addEventListener("click", async e => {
      const b = e.target.closest("[data-sup-del]");
      if (!b) return;
      const s = ship.supplies[Number(b.dataset.supDel)];
      const used = ship.rules.filter(r => r.items.some(it => it.supply === s.id));
      if (used.length && !(await UI.confirmDialog("“" + s.name + "” is used by " + used.map(r => r.name).join(", ") +
        ". Remove it from those rules too?", { okLabel: "Remove" }))) return;
      ship.supplies = ship.supplies.filter(x => x !== s);
      ship.rules.forEach(r => { r.items = r.items.filter(it => it.supply !== s.id); });
      renderShip();
    });
    $("shipAddSupply").onclick = () => {
      ship.supplies.push({ id: shipId("sup-"), name: "New supply", cost: 0, oz: 0 });
      renderShipSupplies();
      const last = $("shipSupplyRows").querySelector("tr:last-child input");
      if (last) { last.focus(); last.select(); }
    };
    $("shipCardOz").addEventListener("input", e => { const r = shipReadNumber(e.target, false); e.target.classList.toggle("invalid", !r.ok); if (r.ok) { ship.cardOz = r.v; renderShipTry(); } });
    const post = (id, key) => $(id).addEventListener("input", e => {
      const r = shipReadNumber(e.target, false);
      e.target.classList.toggle("invalid", !r.ok);
      if (r.ok) { ship.postage[key] = r.v; renderShipTry(); }
    });
    post("shipStamp", "stamp"); post("shipExtraOz", "extraOunce"); post("shipLetterMax", "letterMaxOz");

    $("shipBandRows").addEventListener("input", e => {
      const el = e.target, b = ship.postage.bands[Number(el.dataset.band)];
      if (!b) return;
      const r = shipReadNumber(el, el.dataset.f === "upToOz");
      el.classList.toggle("invalid", !r.ok);
      if (r.ok) { b[el.dataset.f] = r.v; renderShipTry(); }
    });
    // Bands stay in weight order once a box is left.
    // (Redrawn only when the order moved, so Tab through the boxes isn't lost.)
    $("shipBandRows").addEventListener("change", () => {
      const before = ship.postage.bands.slice();
      const sorted = window.ShipCost.normalize(ship).postage.bands;
      if (sorted.some((b, i) => b.upToOz !== before[i].upToOz)) { ship.postage.bands = sorted; renderShipBands(); }
      renderShipTry();
    });
    $("shipBandRows").addEventListener("click", e => {
      const b = e.target.closest("[data-band-del]");
      if (!b) return;
      ship.postage.bands.splice(Number(b.dataset.bandDel), 1);
      renderShipBands(); renderShipTry();
    });
    $("shipAddBand").onclick = () => {
      const last = ship.postage.bands.filter(b => b.upToOz != null).pop();
      const open = ship.postage.bands.find(b => b.upToOz == null);
      const band = { upToOz: last ? last.upToOz + 4 : 4, price: last ? last.price : 0 };
      ship.postage.bands.splice(open ? ship.postage.bands.indexOf(open) : ship.postage.bands.length, 0, band);
      renderShipBands(); renderShipTry();
    };

    $("shipRuleRows").addEventListener("click", async e => {
      const mv = e.target.closest("[data-rule-move]");
      if (mv) {
        const i = Number(mv.dataset.ruleMove), j = i + Number(mv.dataset.by);
        if (j < 0 || j >= ship.rules.length) return;
        const t = ship.rules[i]; ship.rules[i] = ship.rules[j]; ship.rules[j] = t;
        renderShipRules(); renderShipTry();
        return;
      }
      const del = e.target.closest("[data-rule-del]");
      if (del) {
        const r = ship.rules[Number(del.dataset.ruleDel)];
        if (!(await UI.confirmDialog("Remove the packing rule “" + r.name + "”? It's gone for good once you press Save.", { title: "Remove packing rule", okLabel: "Remove", danger: true }))) return;
        ship.rules = ship.rules.filter(x => x !== r);
        renderShipRules(); renderShipTry();
        return;
      }
      const tr = e.target.closest("tr[data-rule]");
      if (tr && !e.target.closest("button")) openShipRule(Number(tr.dataset.rule));
    });
    $("shipRuleRows").addEventListener("keydown", e => {
      const tr = e.target.closest("tr[data-rule]");
      if (tr && e.target === tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openShipRule(Number(tr.dataset.rule)); }
    });
    $("shipAddRule").onclick = () => {
      ship.rules.push({ id: shipId("rule-"), name: "New rule", kind: "mailer", upToCards: null, upToValue: null, nonmachinable: 0, off: false, items: [] });
      renderShipRules(); renderShipTry();
      openShipRule(ship.rules.length - 1);
    };

    // The rule's slide-over.
    const body = $("shipRuleBody");
    const ruleChanged = full => { renderShipRules(); renderShipTry(); if (full) renderShipRule(); };
    body.addEventListener("input", e => {
      const el = e.target, r = ship.rules[shipRuleIdx];
      if (!r) return;
      if (el.dataset.rf) {
        const f = el.dataset.rf;
        if (f === "name") { r.name = el.value; $("shipRuleTitle").textContent = el.value; ruleChanged(false); return; }
        if (f === "off" || f === "kind") return;   // handled on change
        // Blank: no limit for a break, none for the surcharge. Only a negative is refused.
        const rd = shipReadNumber(el, true);
        el.classList.toggle("invalid", !rd.ok);
        if (rd.ok) { r[f] = f === "nonmachinable" ? rd.v || 0 : f === "upToCards" && rd.v != null ? Math.floor(rd.v) : rd.v; ruleChanged(false); }
        return;
      }
      if (el.dataset.it != null && el.tagName === "INPUT") {
        const it = r.items[Number(el.dataset.it)];
        // Blank: every 1 card, qty 0 (none). Only a negative is refused.
        const rd = shipReadNumber(el, true);
        el.classList.toggle("invalid", !rd.ok);
        if (it && rd.ok) { it[el.dataset.f] = el.dataset.f === "every" ? Math.max(1, Math.floor(rd.v) || 1) : rd.v || 0; ruleChanged(false); }
      }
    });
    body.addEventListener("change", e => {
      const el = e.target, r = ship.rules[shipRuleIdx];
      if (!r) return;
      if (el.dataset.rf === "off") { r.off = el.checked; ruleChanged(false); }
      else if (el.dataset.rf === "kind") { r.kind = el.value; ruleChanged(true); }
      else if (el.dataset.it != null && el.tagName === "SELECT") {
        const it = r.items[Number(el.dataset.it)];
        if (it) { it[el.dataset.f] = el.value; ruleChanged(el.dataset.f === "per"); }
      }
    });
    body.addEventListener("click", e => {
      const r = ship.rules[shipRuleIdx];
      if (!r) return;
      const d = e.target.closest("[data-it-del]");
      if (d) { r.items.splice(Number(d.dataset.itDel), 1); ruleChanged(true); return; }
      if (e.target.closest("#shipRuleAddItem")) {
        const used = new Set(r.items.map(it => it.supply));
        const next = ship.supplies.find(s => !used.has(s.id)) || ship.supplies[0];
        if (next) { r.items.push({ supply: next.id, per: "order", every: 1, qty: 1 }); ruleChanged(true); }
        return;
      }
      if (e.target.closest("#shipRuleDone")) shipPanel.close();
    });

    ["shipTryCards", "shipTryValue"].forEach(id => $(id).addEventListener("input", renderShipTry));
    $("shipTryTracked").addEventListener("change", renderShipTry);

    $("shipSave").onclick = () => {
      if (!shipCanEdit) return;
      // A refused box in a closed rule panel was never applied (the rule kept its
      // old value) and can't be seen, so only the open panel counts.
      const panelBad = !$("shipRulePanel").hidden && $("shipRuleBody").querySelectorAll("input.invalid").length;
      if ($("paneShipping").querySelectorAll("input.invalid").length || panelBad) {
        UI.setStatus("shipStatus", "A box holds a number that can't be used (blank or below 0). Fix the box outlined in red.", "err");
        return;
      }
      const errs = validateShip();
      if (errs.length) { UI.setStatus("shipStatus", errs.join(" "), "err"); return; }
      ship.supplies.forEach(s => { s.name = String(s.name).trim(); });
      ship.rules.forEach(r => { r.name = String(r.name).trim(); });
      ship = window.ShipCost.normalize(ship);
      G.state.settings.shipping = JSON.parse(JSON.stringify(ship));
      G.persistSettings();
      renderShip();
      UI.setStatus("shipStatus", "✓ Saved.", "ok");
    };
    $("shipReset").onclick = async () => {
      if (!(await UI.confirmDialog("Replace your supplies, packing rules and postage with the suggested ones? Nothing changes until you press Save.", { okLabel: "Use suggested" }))) return;
      shipPanel.close();
      $("shipRuleBody").innerHTML = "";
      ship = window.ShipCost.normalize(window.ShipCost.defaults());
      renderShip();
      UI.setStatus("shipStatus", "Suggested costs loaded. Press Save to keep them.", "");
    };
  }

  /* Two-factor sign-in (BACKLOG #51; server/lib/totp.js + auth.js). One
     modal, three steps for turning it on - password, scan + first code,
     save recovery codes - reused for "new recovery codes" (password, then
     codes) and a separate password+code step for turning it off. */
  async function wireTwoFactor() {
    const refresh = async () => {
      let st;
      try { st = await G.api("/api/auth/2fa"); } catch (e) { $("tfaStatus").textContent = "· couldn't load"; return; }
      $("tfaStatus").textContent = st.enabled
        ? "· on · " + st.recoveryLeft + " recovery code" + (st.recoveryLeft === 1 ? "" : "s") + " left"
        : "· off";
      $("tfaStatus").className = st.enabled ? (st.recoveryLeft <= 2 ? "warn" : "ok-tag") : "muted";
      $("tfaOn").hidden = st.enabled;
      $("tfaOff").hidden = $("tfaCodes").hidden = !st.enabled;
    };
    UI.ensureModal("tfaModal", "", '<h3 id="tfaTitle"></h3><div id="tfaBody"></div>' +
      '<div id="tfaMsg" class="status"></div>' +
      '<div class="modal-actions" style="margin-top:12px"><span class="spacer"></span>' +
      '<button id="tfaCancel" class="ghost" type="button">Cancel</button><button id="tfaNext" class="primary" type="button"></button></div>');
    const close = () => { UI.hideModal("tfaModal"); refresh(); };
    $("tfaCancel").onclick = close;
    const step = (title, bodyHtml, nextLabel, onNext, focusId) => {
      $("tfaTitle").textContent = title;
      $("tfaBody").innerHTML = bodyHtml;
      $("tfaMsg").textContent = ""; $("tfaMsg").className = "status";
      $("tfaNext").textContent = nextLabel;
      $("tfaNext").disabled = false;
      $("tfaNext").onclick = async () => {
        $("tfaNext").disabled = true;
        try { await onNext(); }
        catch (e) { $("tfaMsg").textContent = e.message; $("tfaMsg").className = "status err"; $("tfaNext").disabled = false; }
      };
      if ($("tfaModal").hidden) UI.showModal("tfaModal", focusId);
      else if (focusId) setTimeout(() => $(focusId) && $(focusId).focus(), 0);
    };
    const pwField = '<label>Your password <input id="tfaPw" type="password" autocomplete="current-password"></label>';
    const showCodes = (codes, title) => {
      const text = "Grimoire recovery codes for " + (G.me ? G.me.username : "") + "\n" +
        "Each works once, in place of an authenticator code.\n\n" + codes.join("\n") + "\n";
      step(title || "Save your recovery codes",
        '<div class="hint" style="margin-top:0">If you lose your phone, each of these signs you in once instead of a ' +
          "code. Save them somewhere safe - <b>they won't be shown again.</b></div>" +
        '<pre class="mono" style="margin:12px 0;padding:12px;background:var(--well);border:1px solid var(--line);' +
          'columns:2;font-size:14px;line-height:1.9">' + codes.map(G.esc).join("\n") + "</pre>" +
        '<div class="toolbar"><button id="tfaCopy" type="button" class="small">Copy</button>' +
          '<button id="tfaDl" type="button" class="small">Download .txt</button></div>',
        "I've saved them", async () => close());
      $("tfaCancel").hidden = true;
      $("tfaCopy").onclick = () => navigator.clipboard.writeText(text).then(() => UI.toast("Recovery codes copied.", "ok"));
      $("tfaDl").onclick = () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        a.download = "grimoire-recovery-codes.txt";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      };
    };
    $("tfaOn").onclick = () => {
      $("tfaCancel").hidden = false;
      step("Turn on two-factor sign-in", pwField, "Continue", async () => {
        const r = await G.api("/api/auth/2fa/begin", { method: "POST", body: { password: $("tfaPw").value } });
        const qr = qrcode(0, "M"); qr.addData(r.uri); qr.make();
        step("Scan this with your authenticator app",
          '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
            '<div style="background:#fff;padding:10px;line-height:0">' + qr.createSvgTag(4, 0) + "</div>" +
            '<div style="flex:1;min-width:180px" class="hint">Can\'t scan? Add an account by key instead:<br>' +
              '<code style="font-size:13px;word-break:break-all">' + G.esc(r.secret.replace(/(.{4})/g, "$1 ").trim()) + "</code></div></div>" +
          '<label style="margin-top:14px">Then enter the 6-digit code it shows <input id="tfaCode" inputmode="numeric" autocomplete="one-time-code"></label>',
          "Turn on", async () => {
            const c = await G.api("/api/auth/2fa/confirm", { method: "POST", body: { code: $("tfaCode").value } });
            showCodes(c.recoveryCodes, "Two-factor is on - save your recovery codes");
          }, "tfaCode");
      }, "tfaPw");
    };
    $("tfaCodes").onclick = () => {
      $("tfaCancel").hidden = false;
      step("New recovery codes", '<div class="hint" style="margin-top:0">Replaces all your old recovery codes.</div>' + pwField,
        "Make new codes", async () => {
          const r = await G.api("/api/auth/2fa/recovery", { method: "POST", body: { password: $("tfaPw").value } });
          showCodes(r.recoveryCodes);
        }, "tfaPw");
    };
    $("tfaOff").onclick = () => {
      $("tfaCancel").hidden = false;
      step("Turn off two-factor sign-in", pwField +
        '<label style="margin-top:10px">Authenticator code (or a recovery code) <input id="tfaCode" inputmode="numeric" autocomplete="one-time-code"></label>',
        "Turn off", async () => {
          await G.api("/api/auth/2fa/disable", { method: "POST", body: { password: $("tfaPw").value, code: $("tfaCode").value } });
          close();
          UI.toast("Two-factor sign-in is off.", "ok");
        }, "tfaPw");
    };
    refresh();
  }

  /* Daily digest subscription (server/lib/digest.js) - on by default; the
     checkbox saves immediately, like the other account toggles. */
  async function wireDigest() {
    const hint = $("digestHint").textContent;
    const note = (msg, cls) => {
      $("digestHint").textContent = msg ? hint + " " + msg : hint;
      $("digestHint").className = "hint" + (cls ? " " + cls : "");
    };
    let st;
    try { st = await G.api("/api/digest/subscription"); }
    catch (e) { $("digestOn").disabled = true; note("Couldn't load: " + e.message, "warn"); return; }
    $("digestOn").checked = st.subscribed;
    if (!st.hasEmail) note("Add an email address above to receive it.", "warn");
    else if (!st.emailConfigured) note("Email isn't set up on this server yet, so nothing is sent for now.", "warn");
    $("digestOn").onchange = async () => {
      const on = $("digestOn").checked;
      try {
        await G.api("/api/digest/subscription", { method: "POST", body: { subscribed: on } });
        UI.setStatus("acctStatus", on ? "Daily digest on." : "Unsubscribed from the daily digest.", "ok");
      } catch (e) {
        $("digestOn").checked = !on;
        UI.setStatus("acctStatus", e.message, "err");
      }
    };
    $("digestTest").onclick = async () => {
      $("digestTest").disabled = true;
      try {
        const r = await G.api("/api/digest/send-test", { method: "POST" });
        UI.setStatus("acctStatus", "Sent a digest to " + r.sentTo + ".", "ok");
      } catch (e) { UI.setStatus("acctStatus", e.message, "err"); }
      finally { $("digestTest").disabled = false; }
    };
  }

  /* Notification types (#139): one checkbox per group, saved at once. */
  async function wireNotifGroups() {
    const box = $("notifGroups");
    let d;
    try { d = await G.api("/api/notifications/settings"); }
    catch (e) { box.innerHTML = '<div class="hint">Couldn\'t load: ' + G.esc(e.message) + "</div>"; return; }
    box.innerHTML = d.groups.map(g =>
      '<label class="row"><input type="checkbox" data-group="' + G.esc(g.id) + '"' + (g.on ? " checked" : "") + "> " +
      G.esc(g.label) + "</label>").join("");
    box.querySelectorAll("input[data-group]").forEach(cb => {
      cb.onchange = async () => {
        const on = cb.checked;
        cb.disabled = true;
        try {
          await G.api("/api/notifications/settings", { method: "POST", body: { group: cb.dataset.group, on } });
          UI.setStatus("acctStatus", on ? "Notifications on for that." : "No more notifications for that.", "ok");
        } catch (e) { cb.checked = !on; UI.setStatus("acctStatus", e.message, "err"); }
        finally { cb.disabled = false; }
      };
    });
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    $("acctWho").textContent = G.me ? G.me.username + " · joined " +
      new Date(G.me.createdAt).toLocaleDateString() : "";
    $("acctEmail").value = (G.me && G.me.email) || "";
    // Changing the address needs the password (password resets go there);
    // re-saving the same one doesn't, so only ask when it actually changed.
    $("emailSave").onclick = async () => {
      const email = $("acctEmail").value.trim();
      const was = (G.me && G.me.email) || "";
      const body = { email };
      if (email.toLowerCase() !== was.toLowerCase()) {
        const pw = await UI.promptDialog("Your password", {
          title: email ? "Change recovery email" : "Remove recovery email", okLabel: "Save", password: true
        });
        if (pw === null) return;
        body.password = pw;
      }
      try {
        await G.api("/api/auth/email", { method: "POST", body });
        if (G.me) G.me.email = email;
        UI.setStatus("acctStatus", "Email saved.", "ok");
      } catch (e) { UI.setStatus("acctStatus", e.message, "err"); }
    };
    wireDigest();
    wireNotifGroups();
    wireTwoFactor();
    $("pwSave").onclick = changePassword;
    $("signOutAll").onclick = async () => {
      const ok = await UI.confirmDialog("Sign out of every device, including this one?", { title: "Sign out everywhere?" });
      if (!ok) return;
      $("signOutAll").disabled = true;
      // saveAll, not saveNow: saveNow never rejects, so a failed save went
      // unnoticed (#176, the same gap as the sidebar's Sign out).
      let leaveUnsaved = false;
      if (!(await G.saveAll(10000))) {
        const err = G.saveState().error;
        const anyway = await UI.confirmDialog("Your last change hasn't saved yet" + (err ? " (" + err + ")" : "") +
          ". Sign out anyway? Unsaved work will be lost.", { title: "Not saved", danger: true, okLabel: "Sign out anyway" });
        if (!anyway) { $("signOutAll").disabled = false; return; }
        leaveUnsaved = true;
      }
      // Only leave once the server says every session is gone (#162): this
      // is the button for a lost or stolen device, so a failure must say so
      // rather than look like it worked.
      try { await G.api("/api/auth/signout-everywhere", { method: "POST" }); }
      catch (e) {
        UI.setStatus("acctStatus", "Couldn't sign out your other devices: " + e.message +
          ". They may still be signed in; try again.", "err");
        $("signOutAll").disabled = false;
        return;
      }
      if (leaveUnsaved) G.leaveWithoutSaving();
      location.href = "/login.html";
    };
    $("digestPreview").onclick = () => window.open("/api/digest/preview", "_blank", "noopener");
    $("adminOpen").onclick = () => { UI.go("/admin.html"); };

    $("legPick").onclick = pickLegacy;
    $("legMode").onchange = legModeNote;
    $("legGo").onclick = runLegacy;
    $("legClear").onclick = () => {
      legacyText = null;
      $("legReport").innerHTML = "";
      $("legActions").hidden = true;
      UI.setStatus("legStatus", "", "");
    };

    $("revLoad").onclick = loadRevisions;

    PERSONAL_PREF_IDS.forEach(id => $(id).addEventListener("change", savePersonalPrefs));
    STORE_PREF_IDS.forEach(id => $(id).addEventListener("change", saveStorePrefs));

    wireManapool();
    wirePitneyBowes();

    $("wipe").onclick = async () => {
      const n = G.state.cards.reduce((s, r) => s + r.quantity, 0);
      // Store staff can't clear the store's shared activity log (#76): erase
      // everything else and say the log is kept.
      const clearLog = G.canClearAuditLog();
      const ok = await UI.confirmDialog("Erase this collection?\n\n" + n + " card(s), " + G.state.locations.length +
        " location(s), " + G.state.receipts.length + " receipt(s) and " +
        (clearLog ? "every log entry.\n\n" : "the ship/build events. The store's activity log is kept.\n\n") +
        "The current version stays in the revision list, so you can put it back from there.",
        { title: "Erase collection?", danger: true, okLabel: "Erase", typeToConfirm: "ERASE" });
      if (!ok) return;
      G.state.cards = []; G.state.locations = []; G.state.receipts = [];
      G.state.pickLists = []; G.state.deckList = []; G.state.history = []; G.state.trades = [];
      G.state.settings.draftLots = [];
      G.state.settings.activeDraftLotId = null;
      if (clearLog) await G.clearAuditLog().catch(() => {});
      G.logAudit({ action: "delete", note: "Collection erased from Settings" });
      G.persist("Erase collection");
      // Always keep the version being erased as a revision (#157), even
      // inside the server's 5-minute archive interval. saveAll() waits for
      // it to land if another save was already in the air.
      await G.saveNow({ archive: true });
      if (!(await G.saveAll())) {
        UI.toast("The erase isn't saved on the server yet: " + (G.saveState().error || "still saving") +
          ". The save indicator at the top shows when it is.", "err");
        return;
      }
      UI.toast("Collection erased" + (clearLog ? "" : " (the store's activity log is kept)") +
        ". Restore an earlier revision above to get it back.", "ok");
      loadRevisions();
    };

    // Erase, Replace import and Restore act on a store's whole inventory:
    // managers and owners only (#159). Staff don't see them at all.
    if (!G.canManageStore()) {
      $("dangerZone").hidden = true;
      $("revStaffNote").hidden = false;
      $("legMode").innerHTML = '<option value="merge">Merge into what is already here</option>';
    }

    $("prefCondition").innerHTML = G.CONDITIONS
      .map(c => '<option value="' + c + '">' + G.esc(G.CONDITION_NAMES[c]) + "</option>").join("");
    loadPrefs();
    loadStoreScope();
    initShipping();
    loadRevisions();
    if (!G.simpleMode) loadStatus(); // those boxes are hidden in Simple mode
    loadAdmin();

    // Tabs (#444). Run after the Simple-mode and role gating above, so a
    // hidden tab (Integrations in Simple mode) is never chosen. An old link
    // to a box on the page (settings.html#acctEmail, #notifications) opens
    // the tab that holds it and then scrolls to it.
    const TABS = [
      { id: "account", button: "tabAccount", panes: ["paneAccount"] },
      { id: "prefs", button: "tabPrefs", panes: ["panePrefs"] },
      { id: "shipping", button: "tabShipping", panes: ["paneShipping"] },
      { id: "integrations", button: "tabIntegrations", panes: ["paneIntegrations"] },
      { id: "data", button: "tabData", panes: ["paneData"] }
    ];
    // The tab holding the box a bare #anchor names, if any.
    const anchorTab = () => {
      const id = decodeURIComponent(String(location.hash || "").replace(/^#/, ""));
      const el = id && !id.includes("=") ? $(id) : null;
      const owner = el && TABS.find(t => !$(t.button).hidden && $(t.panes[0]).contains(el));
      return owner ? { owner, el } : null;
    };
    const first = anchorTab();
    if (first) {
      try { history.replaceState(history.state, "", location.pathname + location.search + "#tab=" + first.owner.id); } catch (e) { /* falls back to the remembered tab */ }
    }
    const tabs = UI.pageTabs({ tabs: TABS, def: "account" });
    if (first && first.el.scrollIntoView) first.el.scrollIntoView();
    // The same link followed while already on Settings (the bell's "Choose what
    // you hear about"): no reload, so switch tab and scroll here too.
    window.addEventListener("hashchange", () => {
      const a = anchorTab();
      if (!a) return;
      tabs.show(a.owner.id);
      if (a.el.scrollIntoView) a.el.scrollIntoView();
    });
  });
})();
