"use strict";
(function () {
  const $ = UI.$;

  /* ============================== Friends & sharing ==============================
     Moved from settings.html (2026-09-17) - a dedicated Social page for
     everything that involves somebody else's collection, rather than one
     more section on the account-settings catch-all. */
  /* ============================== Share and trade from (#128) ==============================
     An org account picks which inventory its sharing and trades use: its
     personal cards (the default) or, for a store's Owners and Managers, a
     store. The server re-checks the rank on every request; this picker
     only offers what the server says may be chosen. */
  let lastFriends = null;      // the latest /api/friends answer, for the switch confirmation
  let actFromState = null;
  // A store ({ name, orgName }) or a current view ({ storeName, orgName }).
  // The view used to print "undefined (Org)" here (found in #147's rework).
  const storeText = st => st ? (st.name || st.storeName || "") + (st.orgName ? " (" + st.orgName + ")" : "") : "";
  const LEVEL_WORD = { summary: "a summary", full: "the full card list" };

  /* #147: the personal option says how many cards it holds, so an empty
     one can't be mistaken for a store with a similar name ("Personal
     Collection"). The count only comes for those who can pick a store. */
  function personalLabel(n) {
    if (typeof n !== "number") return "My personal cards";
    return "My personal cards (" + (n === 0 ? "empty" : n.toLocaleString() + (n === 1 ? " card" : " cards")) + ")";
  }

  /* #151: several things reload the setting (boot, a switch, the tab
     coming back into view, the composer opening), so only the newest
     answer draws. A superseded call waits for the newest one instead, so
     whoever awaits loadActFrom() then reads the server's latest answer.
     `quiet`: a background refresh puts no error in the status line. */
  const actFromLatest = G.latestOnly();
  let actFromNewest = null;
  function loadActFrom(opts) {
    const isCurrent = actFromLatest();
    const run = (async () => {
      let d;
      try { d = await G.api("/api/sharing/act-from"); }
      catch (e) {
        if (!isCurrent()) return actFromNewest;
        if (!(opts && opts.quiet)) UI.setStatus("shareStatus", e.message, "err");
        return;
      }
      if (!isCurrent()) return actFromNewest;
      drawActFrom(d);
    })();
    actFromNewest = run;
    return run;
  }

  function drawActFrom(d) {
    actFromState = d;
    // #147: why a saved store choice was cleared. Shown even outside an
    // org (someone who left one), until dismissed or a new pick.
    const notice = $("actFromNotice");
    notice.innerHTML = TradeCompose.noticeHtml(d.notice, "actFromNoticeOk");
    notice.hidden = !d.notice;
    if (d.notice) $("actFromNoticeOk").onclick = () => {
      notice.hidden = true; notice.innerHTML = "";
      return TradeCompose.dismissNotice();
    };
    $("actFromArea").hidden = !d.inOrg;
    if (!d.inOrg) return;
    const sel = $("actFrom");
    sel.innerHTML = '<option value="">' + G.esc(personalLabel(d.personalCards)) + "</option>" +
      (d.stores || []).map(st => '<option value="' + G.esc(st.id) + '">' + G.esc(st.name) + "</option>").join("");
    sel.value = d.current.storeId || "";
    sel.disabled = !d.canChooseStore;
    $("actFromHint").textContent = !d.canChooseStore
      ? "Only your organization's owners and managers can share and trade from a store. Your sharing and trade offers use your personal cards."
      : d.current.kind === "store"
        ? "The people below see " + storeText(d.current) + "'s inventory, and trade offers you send go out in its name."
        : "The people below see your personal cards. Pick a store to share and trade its inventory instead.";
    // #147: an Owner/Manager on empty personal cards is offered the store
    // in one click; same confirmation and save as the picker.
    const offer = $("actFromOffer");
    offer.innerHTML = TradeCompose.offerHtml(TradeCompose.emptyPersonalOffer(d, d.current.kind), "Pick one above.");
    offer.querySelectorAll("[data-use-store]").forEach(btn => {
      btn.onclick = () => applyActFrom(btn.dataset.useStore);
    });
  }

  function changeActFrom() { return applyActFrom($("actFrom").value); }

  /* #151: a Social tab left open goes stale when the setting is switched
     somewhere else (another tab, another device). A stale picker still
     showing "My personal cards" can't be used to go back to personal: the
     browser fires no change for the option already selected. So the page
     redraws from the server when it comes back into view and when the
     trade composer opens. A refresh never saves anything, and it waits
     out a switch of this page's own that is still being confirmed. */
  let actFromSwitching = false;
  function refreshActFrom() {
    if (actFromSwitching) return Promise.resolve();
    return loadActFrom({ quiet: true });
  }
  const ACT_FROM_REFRESH_MS = 250;   // focus and visibilitychange usually arrive together
  const refreshActFromSoon = G.debounce(refreshActFrom, ACT_FROM_REFRESH_MS);
  function openComposer(opts) {
    TradeCompose.open(opts);
    refreshActFrom();
  }

  /* The picker and the empty-personal offer both land here, and from here
     in TradeCompose.switchActFrom: one save path, one "who will see it"
     confirmation (#128, #147). */
  async function applyActFrom(storeId) {
    const sel = $("actFrom");
    // Compared against the server's answer now, not the last one this page
    // drew (review of PR #150): the setting can change elsewhere (the trade
    // composer, another tab) and a stale "already personal" would save
    // nothing. loadActFrom redraws the picker, so the wanted value is put back.
    await loadActFrom();
    const prev = (actFromState && actFromState.current.storeId) || "";
    if (storeId === prev) { sel.value = prev; return; }
    const st = storeId ? ((actFromState && actFromState.stores) || []).find(s => s.id === storeId) : null;
    if (storeId && !st) { sel.value = prev; return; }
    const canChoose = !!(actFromState && actFromState.canChooseStore);
    sel.value = storeId;
    sel.disabled = true;
    actFromSwitching = true;
    let saved = null;
    try {
      // A saved switch reaches actFromSwitched below, which redraws.
      saved = await TradeCompose.switchActFrom(st, lastFriends);
    } catch (e) { UI.setStatus("shareStatus", e.message, "err"); }
    finally { actFromSwitching = false; }
    // #151: the picker is never left disabled. Saved: it shows the saved
    // value, even if the redraw after the save failed.
    if (saved) { sel.disabled = !canChoose; return; }
    // Cancelled or refused (the server may be unreachable): put back what
    // was there before, so a store that was never saved isn't left showing
    // when the reload below fails too. Then back to what the server has.
    sel.value = prev;
    sel.disabled = !canChoose;
    await loadActFrom();
  }

  /* Every saved switch, from this page or from the trade composer opened
     here (TradeCompose.onActFromChange), and a dismissed note (view null):
     redraw from the server, so the picker, hint and offer always say what
     friends really see. */
  async function actFromSwitched(view) {
    if (view && view.current) {
      UI.setStatus("shareStatus", view.current.kind === "store"
        ? "Sharing and trading from " + storeText(view.current) + "." : "Sharing and trading from your personal cards.", "ok");
    }
    await loadActFrom();
  }

  /* ============================== Friend requests (#140) ==============================
     Incoming ones (Accept / Decline) and the ones this account sent
     (Cancel). Declining tells the sender nothing: on their side the
     request just stays waiting. */
  const whenCell = at => {
    const t = Date.parse(at);
    return '<td class="hide-sm" data-v="' + (isNaN(t) ? 0 : t) + '">' + (isNaN(t) ? "" : G.esc(new Date(t).toLocaleDateString())) + "</td>";
  };
  const whoCell = r => "<td>" + G.esc(r.displayName) + " <span class='muted'>(" + G.esc(r.username) + ")</span></td>";

  async function answerRequest(btn, id, action) {
    btn.disabled = true;
    try {
      const r = await G.api("/api/friends/requests/" + encodeURIComponent(id) + "/respond", { method: "POST", body: { action } });
      UI.setStatus("shareStatus", r.message, "ok");
    } catch (e) { UI.setStatus("shareStatus", e.message, "err"); }
    loadFriends();
  }

  function drawRequests(req) {
    const incoming = Array.isArray(req.incoming) ? req.incoming : [];
    const outgoing = Array.isArray(req.outgoing) ? req.outgoing : [];
    $("reqInBody").innerHTML = incoming.length
      ? incoming.map(r => "<tr>" + whoCell(r) + whenCell(r.at) +
          '<td><div style="display:flex;gap:6px;justify-content:flex-end">' +
            '<button class="small primary" data-accept="' + G.esc(r.id) + '"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#check></use></svg> Accept</button>' +
            '<button class="small" data-decline="' + G.esc(r.id) + '">Decline</button></div></td></tr>').join("")
      : UI.emptyRow(3, { icon: "people", title: "No friend requests waiting for you." });
    $("reqOutBody").innerHTML = outgoing.length
      ? outgoing.map(r => "<tr>" + whoCell(r) + whenCell(r.at) +
          '<td><div style="display:flex;gap:6px;justify-content:flex-end">' +
            '<span class="muted" style="align-self:center">waiting</span>' +
            '<button class="small" data-cancel="' + G.esc(r.id) + '">Cancel</button></div></td></tr>').join("")
      : UI.emptyRow(3, { icon: "people", title: "You haven't asked anyone." });
    $("reqOutHint").textContent = outgoing.length
      ? outgoing.length + " of " + (req.maxPending || 20) + " requests you can have waiting at once." : "";
    $("reqInBody").querySelectorAll("[data-accept]").forEach(b => { b.onclick = () => answerRequest(b, b.dataset.accept, "accept"); });
    $("reqInBody").querySelectorAll("[data-decline]").forEach(b => { b.onclick = () => answerRequest(b, b.dataset.decline, "decline"); });
    $("reqOutBody").querySelectorAll("[data-cancel]").forEach(b => { b.onclick = () => answerRequest(b, b.dataset.cancel, "cancel"); });
  }

  async function loadFriends() {
    let d;
    try { d = await G.api("/api/friends"); }
    catch (e) { UI.setStatus("shareStatus", e.message, "err"); return; }
    lastFriends = d;
    d.friends = Array.isArray(d.friends) ? d.friends : [];
    d.sharedWithMe = Array.isArray(d.sharedWithMe) ? d.sharedWithMe : [];

    $("defaultShare").value = d.defaultShare || "off";
    drawRequests(d.requests || { incoming: [], outgoing: [], maxPending: 20 });

    /* #140: a friend's row picks what they see, "same as everyone else"
       being no level of their own. A row for someone who isn't a friend
       (left at "off" by Unfriend or Stop sharing, or a name with no
       account) only ever means Off; Remove deletes it, which hands them
       back to the server-wide setting. */
    const everyone = LEVEL_WORD[d.defaultShare] || "nothing";
    const levelSelect = f => {
      const opts = [["", "same as everyone else (" + everyone + ")"], ["off", "nothing"], ["summary", "a summary"], ["full", "the full card list"]];
      const cur = f.share || "";
      const label = (opts.find(o => o[0] === cur) || opts[0])[1];
      return '<td data-vs="' + G.esc(label) + '"><select data-level="' + G.esc(f.username) + '" aria-label="What ' +
        G.esc(f.username) + ' sees">' + opts.map(o => '<option value="' + o[0] + '"' + (o[0] === cur ? " selected" : "") + ">" +
        G.esc(o[1]) + "</option>").join("") + "</select></td>";
    };
    const tradeBtn = u => '<button class="small" data-trade="' + G.esc(u) + '"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#handshake></use></svg> Trade</button>';
    $("friendBody").innerHTML = d.friends.length
      ? d.friends.map(f => "<tr><td>" + G.esc(f.displayName) + " <span class='muted'>(" + G.esc(f.username) + ")</span>" +
          (f.friend ? "" : f.exists ? ' <span class="badge cap">not a friend</span>' : ' <span class="badge cap">no such account</span>') + "</td>" +
          (f.friend ? levelSelect(f) : '<td><span class="pill' + (f.sees === "off" ? " off" : " on") + '">' + G.esc(f.sees) + "</span></td>") +
          '<td><div style="display:flex;gap:6px;justify-content:flex-end">' +
            (f.exists ? tradeBtn(f.username) : "") +
            (f.friend
              ? '<button class="small danger" data-unfriend="' + G.esc(f.username) + '">Unfriend</button>'
              : '<button class="small" data-forget="' + G.esc(f.username) + '">Remove</button>') +
          "</div></td></tr>").join("")
      : UI.emptyRow(3, { icon: "people", title: "No friends yet.", hint: "Send a friend request above." });
    $("friendBody").querySelectorAll("select[data-level]").forEach(sel => {
      sel.onchange = async () => {
        const uname = sel.dataset.level, level = sel.value;
        sel.closest("td").dataset.vs = sel.selectedOptions[0].textContent;
        sel.disabled = true;
        try {
          if (level) await G.api("/api/friends", { method: "POST", body: { username: uname, share: level } });
          else await G.api("/api/friends/remove", { method: "POST", body: { username: uname, forget: true } });
          UI.setStatus("shareStatus", uname + " now sees " + sel.selectedOptions[0].textContent + ".", "ok");
        } catch (e) { UI.setStatus("shareStatus", e.message, "err"); }
        loadFriends();
      };
    });
    $("friendBody").querySelectorAll("[data-unfriend]").forEach(b => {
      b.onclick = async () => {
        const uname = b.dataset.unfriend;
        const ok = await UI.confirmDialog(
          "You and " + uname + " stop being friends. Each of you is set to see nothing of the other, whatever " +
          "\"Everyone else on this server sees\" says. Either of you can send a new friend request later.",
          { title: "Unfriend " + uname + "?", okLabel: "Unfriend", danger: true });
        if (!ok) return;
        b.disabled = true;
        try {
          const r = await G.api("/api/friends/unfriend", { method: "POST", body: { username: uname } });
          UI.setStatus("shareStatus", r.message, "ok");
        } catch (e) { UI.setStatus("shareStatus", e.message, "err"); }
        loadFriends();
      };
    });
    $("friendBody").querySelectorAll("[data-forget]").forEach(b => {
      b.onclick = async () => {
        const uname = b.dataset.forget;
        const fallback = $("defaultShare").selectedOptions[0];
        const ok = await UI.confirmDialog(
          "Remove " + uname + " from this list? They will then see whatever everyone else on this server sees" +
          (fallback ? " (currently: " + fallback.textContent + ")" : "") + ". To keep them seeing nothing, leave them here at \"off\".",
          { title: "Remove from list?", okLabel: "Remove" });
        if (!ok) return;
        try {
          await G.api("/api/friends/remove", { method: "POST", body: { username: uname, forget: true } });
          UI.setStatus("shareStatus", "Removed " + uname + " from the list.", "ok");
          loadFriends();
        } catch (e) { UI.setStatus("shareStatus", e.message, "err"); }
      };
    });
    $("friendBody").querySelectorAll("[data-trade]").forEach(b => {
      b.onclick = () => openComposer({ username: b.dataset.trade, lockFriend: true, onSent: loadFriends });
    });

    $("sharedBody").innerHTML = d.sharedWithMe.length
      ? d.sharedWithMe.map(s => "<tr><td>" + G.esc(s.displayName) + " <span class='muted'>(" + G.esc(s.username) +
          ")" + (s.store ? " · sharing " + G.esc(storeText(s.store)) : "") + "</span></td><td><span class='pill on'>" + G.esc(s.share) + "</span></td>" +
          '<td><div style="display:flex;gap:6px;justify-content:flex-end">' +
            '<button class="small" data-trade="' + G.esc(s.username) + '"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#handshake></use></svg> Trade</button>' +
            '<button class="small" data-view="' + G.esc(s.username) + '">View</button></div></td></tr>').join("")
      : UI.emptyRow(3, { icon: "people", title: "Nothing is listed as shared with you." });
    $("sharedBody").querySelectorAll("[data-trade]").forEach(b => {
      b.onclick = () => openComposer({ username: b.dataset.trade, lockFriend: true, onSent: loadFriends });
    });
    $("sharedBody").querySelectorAll("[data-view]").forEach(b => {
      b.onclick = () => openFriendView(b.dataset.view);
    });
    UI.reapplySorts();
  }

  /* ============================== Invite a friend (#337) ==============================
     A member's own sign-up links. The server holds the rules (allowance,
     expiry, the admin's switch); this draws what it answers. */
  const fullInviteUrl = u => { try { return new URL(u, location.origin).href; } catch (e) { return u; } };

  function inviteRow(i) {
    const made = '<td class="hide-sm" data-v="' + (Date.parse(i.createdAt) || 0) + '">' + G.esc(new Date(i.createdAt).toLocaleDateString()) + "</td>";
    if (i.status === "joined") {
      return '<tr><td><span class="muted">Used</span></td>' +
        "<td>" + (i.username ? "Joined as <b>" + G.esc(i.username) + "</b>" : "Joined") + "</td>" + made + "<td></td></tr>";
    }
    // The link and the buttons wrap, so a phone needn't scroll sideways to reach Copy link.
    const url = fullInviteUrl(i.url);
    return '<tr><td style="white-space:normal;overflow-wrap:anywhere"><code style="white-space:normal">' + G.esc(url) + "</code></td>" +
      '<td><span class="pill on">open</span> <span class="muted hide-sm">until ' + G.esc(new Date(i.expiresAt).toLocaleDateString()) + "</span></td>" + made +
      '<td style="white-space:normal"><button class="small" data-invite-copy="' + G.esc(url) + '">' + UI.icon("link") + " Copy link</button> " +
      '<button class="small danger" data-invite-cancel="' + G.esc(i.code) + '">Cancel</button></td></tr>';
  }

  async function loadInvites() {
    let d;
    try { d = await G.api("/api/member-invites"); }
    catch (e) { UI.setStatus("inviteStatus", e.message, "err"); return; }
    d.invites = Array.isArray(d.invites) ? d.invites : [];
    const on = d.enabled && !d.signupsClosed;
    $("inviteFriend").hidden = false;
    $("inviteLeft").textContent = on ? "— " + d.remaining + " of " + d.allowance + " left" : "";
    $("inviteMake").hidden = !on;
    $("inviteMake").disabled = d.remaining <= 0;
    $("inviteOff").hidden = on;
    $("inviteOffText").textContent = d.signupsClosed ? "Sign-ups are closed right now, so invite links don't work."
      : "Invites from members are turned off right now. Links you've already made won't work unless they're turned back on.";
    $("inviteRows").innerHTML = d.invites.length ? d.invites.map(inviteRow).join("")
      : UI.emptyRow(4, { icon: "people", title: "No invite links yet.",
          hint: on ? "Create one and send it to a friend." : "" });
    UI.reapplySorts();
  }

  function copyInvite(url) {
    const fail = () => UI.toast("Couldn't copy automatically. Select the link and copy it by hand.", "err");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => UI.toast("Link copied.", "ok"), fail);
    } else fail();
  }

  async function makeInvite() {
    $("inviteMake").disabled = true;
    try {
      await G.api("/api/member-invites", { method: "POST" });
      UI.setStatus("inviteStatus", "Link created. Press Copy link, then send it to your friend.", "ok");
    } catch (e) { UI.setStatus("inviteStatus", e.message, "err"); }
    await loadInvites();
  }

  async function cancelInvite(code, btn) {
    const ok = await UI.confirmDialog("Cancel this invite link? Nobody can sign up with it after this, and the invite comes back to you.",
      { title: "Cancel invite link?", danger: true, okLabel: "Cancel link" });
    if (!ok) return;
    btn.disabled = true;
    try {
      await G.api("/api/member-invites/" + encodeURIComponent(code) + "/cancel", { method: "POST" });
      UI.setStatus("inviteStatus", "Link cancelled.", "ok");
    } catch (e) { UI.setStatus("inviteStatus", e.message, "err"); }
    await loadInvites();
  }

  /* ============================== Friend's collection ==============================
     Folded in from the old friend.html (2026-09-17) - a modal instead of a
     separate page, since "go look at what they shared" and "propose a
     trade with them" are the same errand and belong in the same place. */
  let fvRows = [], fvFull = false;
  const fvFinishOf = c => G.normalizeFinish(c.finish) || (c.foil ? "foil" : "nonfoil");
  const fvFinishText = c => { const f = fvFinishOf(c); return f === "nonfoil" ? "—" : G.esc(G.FINISH_NAMES[f]); };

  function tile(big, lbl) {
    return '<div class="tile"><span class="big">' + big + '</span><span class="lbl">' + G.esc(lbl) + "</span></div>";
  }

  /* #130: a full share can be ~70k stacks. Stacks that match in every field
     the share shows (name, printing, language, finish, price) differ only in
     something hidden from the friend, usually the location, so they fold
     into one row with the quantities added up. The search text is worked out
     once per row here rather than on every keystroke. */
  function foldFvRows(list) {
    const byKey = new Map();
    for (const c of list || []) {
      const finish = fvFinishOf(c);
      const key = [String(c.name || "").toLowerCase(), c.set || "", c.collector || "", c.lang || "", finish,
        c.price == null ? "" : Number(c.price)].join("|");
      const had = byKey.get(key);
      if (had) {
        had.quantity += Number(c.quantity) || 0;
        had.listedQty += Number(c.listedQty) || 0;
        if (!had.imageUrl && c.imageUrl) had.imageUrl = c.imageUrl;
        continue;
      }
      byKey.set(key, Object.assign({}, c, {
        finish, quantity: Number(c.quantity) || 0, listedQty: Number(c.listedQty) || 0,
        hay: (c.name + " " + c.set + " " + (c.setName || "")).toLowerCase()
      }));
    }
    return [...byKey.values()];
  }

  /* Sort key per column, by index, matching what each cell shows. The table
     draws at most FV_ROW_CAP rows, so a header click sorts the whole folded
     list (UI.dataSort + G.sortRows) and the drawn rows are the top of it. The
     Full level has an extra picture column first. */
  const FV_ROW_CAP = G.PLAN_ROW_CAP;
  const FV_SORT_KEYS = [
    c => c.name,
    c => G.printingLabel(c.set, c.collector, c.setName || ""),
    c => { const f = fvFinishOf(c); return f === "nonfoil" ? null : G.FINISH_NAMES[f] || f; },
    c => c.quantity,
    c => c.price == null ? null : Number(c.price),
    c => c.listedQty || 0
  ];
  const fvSortKey = col => FV_SORT_KEYS[fvFull ? col - 1 : col];

  // The whole list in the current column sort, kept until the list or the
  // sort changes: filtering a sorted list keeps its order, so typing in the
  // filter never re-sorts.
  let fvSorted = null;
  function sortedFvRows(table) {
    const sort = UI.sortStateOf(table);
    const key = sort && fvSortKey(sort.col);
    if (!key) return fvRows;
    if (!fvSorted || fvSorted.src !== fvRows || fvSorted.col !== sort.col || fvSorted.dir !== sort.dir) {
      fvSorted = { src: fvRows, col: sort.col, dir: sort.dir, rows: G.sortRows(fvRows, key, sort.dir) };
    }
    return fvSorted.rows;
  }

  function filterFvRows() {
    const q = $("fvSearch") ? $("fvSearch").value.trim().toLowerCase() : "";
    const body = $("fvGridBody");
    if (!body) return;
    const all = sortedFvRows(body.closest("table"));
    const list = q ? all.filter(c => c.hay.includes(q)) : all;
    const more = $("fvMore");
    if (more) {
      more.textContent = list.length > FV_ROW_CAP
        ? "Showing " + FV_ROW_CAP.toLocaleString() + " of " + list.length.toLocaleString() + " — type to narrow." : "";
    }
    if (!list.length) {
      body.innerHTML = q
        ? UI.emptyRow(fvFull ? 7 : 5, { icon: "search", title: "No cards match that search." })
        : UI.emptyRow(fvFull ? 7 : 5, { icon: "cards", title: "Nothing to show." });
      return;
    }
    body.innerHTML = list.slice(0, FV_ROW_CAP).map(c => "<tr>" +
      (fvFull ? "<td>" + (c.imageUrl
        ? '<img src="' + G.esc(c.imageUrl) + '" alt="" class="sv-thumb" loading="lazy">' : "") + "</td>" : "") +
      '<td class="card-name" data-vs="' + G.esc(c.name) + '">' + UI.cardLink(c) + "</td>" +
      '<td class="hide-sm" data-vs="' + G.esc(FV_SORT_KEYS[1](c)) + '">' + G.esc(FV_SORT_KEYS[1](c)) + "</td>" +
      '<td class="hide-sm">' + fvFinishText(c) + "</td>" +
      '<td class="num">' + c.quantity + "</td>" +
      '<td class="num">' + G.money(c.price) + "</td>" +
      (fvFull ? '<td class="num hide-sm" data-v="' + (c.listedQty || 0) + '">' + (c.listedQty > 0
        ? '<span class="badge sale">' + c.listedQty + "</span>" : '<span class="muted">0</span>') + "</td>" : "") +
      "</tr>").join("");
    body.querySelectorAll(".sv-thumb").forEach(img => { img.onclick = () => UI.lightbox(img.src, img.alt); });
    UI.reapplySorts($("fvBody"));
  }

  /* #131: View alice, close, View bob - if alice's answer arrived last it
     used to fill the modal (title included) after bob was asked for. Each
     open takes a new run id and a response is dropped unless its run is
     still the latest, the same pattern as collectorRunId in stats.page.js. */
  let fvRunId = 0;

  async function openFriendView(username) {
    const runId = ++fvRunId;
    $("fvTitle").textContent = username + "'s collection";
    $("fvMeta").textContent = "";
    $("fvBody").innerHTML = UI.skeletonBlock(4);
    UI.showModal("friendViewModal", "fvClose");
    let d;
    try { d = await G.api("/api/share/" + encodeURIComponent(username)); }
    catch (e) {
      if (runId === fvRunId) $("fvBody").innerHTML = UI.emptyBlock({ icon: "error", title: G.esc(e.message) });
      return;
    }
    if (runId !== fvRunId) return;       // a newer View already started

    const s = d.summary;
    $("fvTitle").textContent = s.store
      ? storeText(s.store) + ", shared by " + (s.displayName || username)
      : (s.displayName || username) + "'s collection";
    $("fvMeta").textContent = "Sharing level: " + s.level +
      (s.savedAt ? " · last saved " + new Date(s.savedAt).toLocaleString() : "");

    let html = '<div class="tiles">' +
      tile(s.stacks.toLocaleString(), "Stacks") +
      tile(s.cards.toLocaleString(), "Cards") +
      tile(s.distinctNames.toLocaleString(), "Distinct names") +
      tile(G.money(s.totalValue), "Total value") +
      tile(s.listedForSale.toLocaleString(), "Marked to list") +
      "</div>";

    fvRows = foldFvRows(d.cards || s.top);
    fvSorted = null;
    fvFull = !!d.cards;
    html += '<div class="sec-head" style="margin-top:16px">' +
      "<h2 style='margin:0'>" + (fvFull ? "Every card" : "Most valuable cards") + "</h2>" +
      '<input id="fvSearch" placeholder="Filter by name or set…" style="min-width:220px">' +
      "</div>" +
      (fvFull ? "" : '<div class="hint" style="margin-top:0">Only the 15 most valuable cards are shared at the ' +
        "summary level — ask for the full list if you want to see everything.</div>") +
      '<div class="list-wrap"><table class="list" data-sort><thead><tr>' +
      (fvFull ? "<th></th>" : "") +
      '<th>Card</th><th class="hide-sm">Printing</th><th class="hide-sm">Finish</th><th class="num">Qty</th><th class="num">Each</th>' +
      (fvFull ? '<th class="num hide-sm">Listed</th>' : "") +
      "</tr></thead><tbody id=\"fvGridBody\"></tbody></table></div>" +
      '<div class="hint" id="fvMore" style="margin:4px 0 0"></div>';

    $("fvBody").innerHTML = html;
    $("fvSearch").addEventListener("input", G.debounce(filterFvRows, 150));
    // A header click sorts the whole list, then redraws its first rows.
    UI.dataSort($("fvGridBody").closest("table"), () => filterFvRows());
    filterFvRows();
  }

  UI.boot(async function () {
    $("friendAdd").onclick = async () => {
      const username = $("friendPick").value.trim();
      if (!username) return;
      $("friendAdd").disabled = true;
      try {
        const r = await G.api("/api/friends/requests", { method: "POST", body: { username } });
        UI.setStatus("shareStatus", r.message, "ok");
        $("friendPick").value = "";
        loadFriends();
      } catch (e) { UI.setStatus("shareStatus", e.message, "err"); }
      $("friendAdd").disabled = false;
    };
    $("friendPick").addEventListener("keydown", e => { if (e.key === "Enter") $("friendAdd").click(); });
    $("inviteMake").onclick = makeInvite;
    $("inviteRows").addEventListener("click", e => {
      const copy = e.target.closest && e.target.closest("[data-invite-copy]");
      if (copy) { copyInvite(copy.getAttribute("data-invite-copy")); return; }
      const cancel = e.target.closest && e.target.closest("[data-invite-cancel]");
      if (cancel) cancelInvite(cancel.getAttribute("data-invite-cancel"), cancel);
    });
    $("defaultShare").onchange = async () => {
      try {
        await G.api("/api/friends", { method: "POST", body: { defaultShare: $("defaultShare").value } });
        UI.setStatus("shareStatus", "Everyone else now sees: " + $("defaultShare").value + ".", "ok");
      } catch (e) { UI.setStatus("shareStatus", e.message, "err"); }
    };
    $("fvClose").onclick = () => UI.hideModal("friendViewModal");
    $("friendViewModal").addEventListener("click", e => { if (e.target.id === "friendViewModal") UI.hideModal("friendViewModal"); });
    $("btnNewProposal").onclick = () => openComposer({ onSent: loadFriends });
    $("actFrom").onchange = changeActFrom;
    TradeCompose.onActFromChange(actFromSwitched);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshActFromSoon(); });
    window.addEventListener("focus", () => refreshActFromSoon());

    await Promise.all([loadFriends(), loadActFrom(), loadInvites()]);
    // #140: a friend-request notification links to #requests, an accepted
    // one to #friends. The tables fill in after load, so scroll once they have.
    const anchor = (location.hash || "").slice(1);
    if ((anchor === "requests" || anchor === "friends" || anchor === "inviteFriend") && $(anchor) && $(anchor).scrollIntoView) $(anchor).scrollIntoView({ block: "start" });
    // #139: social.html?friend=<username> (a notification) opens that
    // person's shared collection. /api/share decides what, if anything,
    // they still share; openFriendView shows its refusal as it is.
    const deepFriend = new URLSearchParams(location.search).get("friend");
    if (deepFriend) openFriendView(deepFriend.toLowerCase().trim());
  });
})();
