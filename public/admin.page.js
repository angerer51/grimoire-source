"use strict";
(function () {
  const $ = UI.$;
  const PAGE_SIZE = 25;
  let page = 1;
  let lastCardsStatus = null;  // cards.status() from the most recent loadAdmin() - see renderPriceSource

  /* ============================== Tabs ============================== */
  // One tab (system) spans two non-adjacent DOM sections (tiles up top,
  // System actions' danger-zone stuff further down, same order as before
  // tabs existed) - an array of pane ids per tab, not a 1:1 map, so both
  // toggle together without having to move either section's markup.
  const PANES = {
    system: ["paneSystemA", "paneSystemB"], accounts: ["paneAccounts"],
    tickets: ["paneTickets"], invites: ["paneInvites"], email: ["paneEmail"], github: ["paneGithub"],
    manapool: ["paneManapool"]
  };
  let tabs;

  /* ============================== Accounts ============================== */
  function fmtWhen(iso) {
    if (!iso) return '<span class="muted">—</span>';
    try { return new Date(iso).toLocaleString(); } catch (e) { return "—"; }
  }
  function fmtAgo(ms) {
    if (ms == null) return '<span class="muted">never</span>';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  // A date cell's data-v: epoch ms, or "" (sorts as empty) when there is
  // none, so the column sorts by real time, not the text's month (#164).
  const sortTime = v => {
    const n = typeof v === "number" ? v : Date.parse(v);
    return isNaN(n) ? "" : String(n);
  };

  function userRow(u) {
    const tr = document.createElement("tr");
    const online = u.presence && u.presence.onlineNow;
    // An admin's Role cell is a <select>: data-vs carries the chosen role so
    // the column sorts on it, not on every option's text run together.
    const roleCell = G.isAdmin
      ? '<td data-vs="' + G.esc(u.role) + '"><select data-r="role" aria-label="' + G.esc("Role for " + u.username) + '">' +
        '<option value="user"' + (u.role === "user" ? " selected" : "") + '>user</option>' +
        '<option value="moderator"' + (u.role === "moderator" ? " selected" : "") + '>moderator</option>' +
        '<option value="admin"' + (u.role === "admin" ? " selected" : "") + '>admin</option></select></td>'
      : '<td><span class="pill' + (u.role === "admin" ? " on" : "") + '">' + G.esc(u.role) + "</span></td>";
    // Everyone sees the state; an admin's Disable/Enable sits with the other
    // row actions (#164), so the column never has to be read backwards.
    const statusCell = '<span class="pill' + (u.disabled ? "" : " on") + '">' + (u.disabled ? "disabled" : "active") + "</span>";
    // Email and reset only on rows the viewer may act on (#154, #167): an
    // admin on everyone else, a moderator on nobody, nobody on their own row
    // (that's Settings → Account, which asks for the password). The server
    // checks again; this just doesn't offer what would be refused.
    const canManage = !!u.canManage;
    const actionsCell =
      (canManage ? '<button class="small ghost" data-r="setEmail">' + (u.hasEmail ? "Change email" : "Set email") + "</button>" : "") +
      (canManage && u.hasEmail && !u.disabled ? ' <button class="small ghost" data-r="resetEmail">Send reset email</button>' : "") +
      // Admin-only escape hatch for a lost phone AND lost recovery codes (#51).
      (G.isAdmin && u.twoFactor ? ' <button class="small ghost danger" data-r="reset2fa">Reset 2FA</button>' : "") +
      (G.isAdmin ? ' <button class="small ghost" data-r="toggleDisabled">' + (u.disabled ? "Enable" : "Disable") + "</button>" : "");
    const lastSeen = u.presence ? u.presence.lastSeenAt : null;
    tr.innerHTML =
      "<td>" + G.esc(u.username) + (u.twoFactor ? ' <span class="pill on" title="Two-factor sign-in is on">2FA</span>' : "") + "</td>" +
      '<td class="hide-sm">' + G.esc(u.displayName) + "</td>" +
      roleCell +
      "<td>" + statusCell + "</td>" +
      '<td><span class="pill' + (online ? " on" : "") + '">' + (online ? "online" : "offline") + "</span></td>" +
      '<td class="hide-sm" data-v="' + (lastSeen == null ? "" : sortTime(lastSeen)) + '">' + fmtAgo(lastSeen) + "</td>" +
      '<td class="hide-sm" data-v="' + sortTime(u.createdAt) + '">' + fmtWhen(u.createdAt) + "</td>" +
      "<td>" + (actionsCell.trim() || '<span class="muted">—</span>') + "</td>";
    if (canManage) tr.querySelector('[data-r="setEmail"]').onclick = async () => {
      // Nobody sees the account's current raw email here (the users list
      // only ever exposes hasEmail, a boolean) - only set a new one.
      const next = await UI.promptDialog("Email address for " + u.username + (u.hasEmail ? " (replaces the one on file):" : ":"),
        { title: "Set email", placeholder: "name@example.com" });
      if (next == null) return; // cancelled
      try {
        await G.api("/api/admin/users/" + encodeURIComponent(u.id) + "/email", { method: "POST", body: { email: next.trim() } });
        UI.toast("Email updated for " + u.username + ".", "ok");
        loadUsers();
      } catch (err) { UI.toast(err.message, "err"); }
    };
    if (canManage && u.hasEmail && !u.disabled) {
      tr.querySelector('[data-r="resetEmail"]').onclick = async e => {
        const ok = await UI.confirmDialog("Send a password-reset link to " + u.username + "'s email?", { title: "Send reset email?" });
        if (!ok) return;
        e.target.disabled = true;
        try {
          const out = await G.api("/api/admin/users/" + encodeURIComponent(u.id) + "/reset-email", { method: "POST" });
          UI.toast("Reset link sent to " + out.sentTo + ".", "ok");
        } catch (err) { UI.toast(err.message, "err"); }
        e.target.disabled = false;
      };
    }
    if (G.isAdmin && u.twoFactor) {
      tr.querySelector('[data-r="reset2fa"]').onclick = async () => {
        const ok = await UI.confirmDialog("Turn off two-factor sign-in for " + u.username + " and sign them out everywhere? " +
          "Only do this once you're sure it's really them - after this, their password alone gets in until they set it up again.",
          { title: "Reset two-factor?", danger: true });
        if (!ok) return;
        try {
          await G.api("/api/admin/users/" + encodeURIComponent(u.id) + "/2fa-reset", { method: "POST" });
          UI.toast("Two-factor reset for " + u.username + ".", "ok");
          loadUsers();
        } catch (err) { UI.toast(err.message, "err"); }
      };
    }
    if (G.isAdmin) {
      tr.querySelector('[data-r="role"]').onchange = async e => {
        const next = e.target.value;
        if (next === u.role) return;
        const ok = await UI.confirmDialog("Change " + u.username + "'s role to " + next + "?", { title: "Change role?" });
        if (!ok) { e.target.value = u.role; return; }
        try {
          await G.api("/api/admin/users/" + encodeURIComponent(u.id) + "/role", { method: "POST", body: { role: next } });
          loadUsers();
        } catch (err) { UI.toast(err.message, "err"); e.target.value = u.role; }
      };
      tr.querySelector('[data-r="toggleDisabled"]').onclick = async () => {
        const next = !u.disabled;
        const ok = await UI.confirmDialog((next ? "Disable" : "Re-enable") + " " + u.username + "?",
          { title: next ? "Disable account?" : "Re-enable account?", danger: next });
        if (!ok) return;
        try {
          await G.api("/api/admin/users/" + encodeURIComponent(u.id) + "/disabled", { method: "POST", body: { disabled: next } });
          loadUsers();
        } catch (err) { UI.toast(err.message, "err"); }
      };
    }
    return tr;
  }

  async function loadUsers() {
    const params = new URLSearchParams({
      q: $("userSearch").value.trim(),
      role: $("userRoleFilter").value,
      status: $("userStatusFilter").value,
      page: String(page), pageSize: String(PAGE_SIZE)
    });
    let d;
    try { d = await G.api("/api/admin/users?" + params.toString()); }
    catch (e) { UI.toast(e.message, "err"); return; }

    const body = $("userBody");
    body.innerHTML = "";
    if (!d.users.length) {
      body.innerHTML = UI.emptyRow(8, { icon: "people", title: "No accounts match." });
    } else {
      d.users.forEach(u => body.appendChild(userRow(u)));
    }
    const onlineNow = d.users.filter(u => u.presence && u.presence.onlineNow).length;
    $("usersHdr").textContent = "— " + d.total + " account" + (d.total === 1 ? "" : "s") +
      (onlineNow ? ", " + onlineNow + " online on this page" : "");
    const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
    $("userPageInfo").textContent = "Page " + d.page + " of " + pages;
    $("userPrev").disabled = d.page <= 1;
    $("userNext").disabled = d.page >= pages;
    UI.reapplySorts();
  }

  /* ============================== Support tickets ============================== */
  const TICKET_PAGE_SIZE = 25;
  let ticketPage = 1;

  function ticketStatusPill(status) {
    const on = status === "open" || status === "in-progress";
    return '<span class="pill' + (on ? " on" : "") + '">' + G.esc(status) + "</span>";
  }

  /* The linked GitHub issue (staff only - this whole tab is moderator+), or
     for an admin a Send to GitHub button when there isn't one yet. A
     moderator can follow the link but not file: the GitHub connection is
     admin-only. */
  function githubIssueHtml(gh) {
    if (gh) {
      return '<a href="' + G.esc(gh.url) + '" target="_blank" rel="noopener" title="Open issue #' + gh.number +
        ' on GitHub">' + UI.icon("github") + " #" + gh.number + "</a>" +
        (gh.state === "closed" ? ' <span class="muted">closed</span>' : "");
    }
    return G.isAdmin
      ? '<button class="small" data-r="gh">' + UI.icon("github") + " Send to GitHub</button>"
      : '<span class="muted">—</span>';
  }

  async function sendToGithub(id, btn) {
    btn.disabled = true;
    try {
      const out = await G.api("/api/admin/tickets/" + encodeURIComponent(id) + "/github", { method: "POST" });
      UI.toast("Filed as issue #" + out.ticket.github.number + ".", "ok");
      await loadTickets();
      if (ticketPanel.isOpen() && currentTicketId === id) renderTicketThread(out.ticket);
    } catch (e) { UI.toast(e.message, "err"); btn.disabled = false; }
  }

  async function loadTickets() {
    const params = new URLSearchParams({
      q: $("ticketSearch").value.trim(),
      status: $("ticketStatusFilter").value,
      category: $("ticketCategoryFilter").value,
      page: String(ticketPage), pageSize: String(TICKET_PAGE_SIZE)
    });
    let d;
    try { d = await G.api("/api/admin/tickets?" + params.toString()); } catch (e) { UI.toast(e.message, "err"); return; }

    const body = $("ticketBody");
    body.innerHTML = "";
    if (!d.tickets.length) {
      body.innerHTML = UI.emptyRow(6, { icon: "tickets", title: "No tickets match." });
    } else {
      d.tickets.forEach(t => {
        const tr = document.createElement("tr");
        tr.className = "click" + (ticketPanel.isOpen() && t.id === currentTicketId ? " sel" : "");
        tr.tabIndex = 0;
        tr.dataset.id = t.id;
        tr.innerHTML =
          "<td>" + G.esc(t.subject) + "</td>" +
          "<td>" + G.esc(t.createdByUsername) + "</td>" +
          "<td>" + G.esc(t.category) + "</td>" +
          "<td>" + ticketStatusPill(t.status) + "</td>" +
          '<td class="hide-sm" data-v="' + (t.github ? t.github.number : 0) + '">' + githubIssueHtml(t.github) + "</td>" +
          '<td data-v="' + sortTime(t.updatedAt) + '">' + fmtWhen(t.updatedAt) + "</td>";
        const gh = tr.querySelector('[data-r="gh"]');
        if (gh) gh.onclick = e => { e.stopPropagation(); sendToGithub(t.id, gh); };
        // The issue link opens GitHub; it must not also open the ticket.
        const ghLink = tr.querySelector("a");
        if (ghLink) ghLink.onclick = e => e.stopPropagation();
        body.appendChild(tr);
      });
    }
    $("ticketsHdr").textContent = "— " + d.total + " ticket" + (d.total === 1 ? "" : "s");
    const pages = Math.max(1, Math.ceil(d.total / TICKET_PAGE_SIZE));
    $("ticketPageInfo").textContent = "Page " + d.page + " of " + pages;
    $("ticketPrev").disabled = d.page <= 1;
    $("ticketNext").disabled = d.page >= pages;
    UI.reapplySorts();
  }

  function markTicketRow() {
    const open = ticketPanel.isOpen();
    $("ticketBody").querySelectorAll("tr[data-id]").forEach(tr => tr.classList.toggle("sel", open && tr.dataset.id === currentTicketId));
  }

  async function openTicket(id) {
    let d;
    try { d = await G.api("/api/admin/tickets/" + encodeURIComponent(id)); }
    catch (e) { UI.toast(e.message, "err"); return; }
    renderTicketThread(d.ticket);
    ticketPanel.open();
    markTicketRow();
  }

  // Status changes are handled here (not through UI.renderTicketThread,
  // which only ever posts replies) and explicitly re-render the thread with
  // the result; a reply's re-render instead comes from renderTicketThread's
  // own return-value handling - never both for the same action, same
  // reasoning as support.page.js's identical split.
  let currentTicketId = null;
  const ticketPanel = UI.slideOver("ticketPanel");
  function renderTicketThread(ticket) {
    currentTicketId = ticket.id;
    $("ticketGithub").innerHTML = githubIssueHtml(ticket.github);
    const ghBtn = $("ticketGithub").querySelector('[data-r="gh"]');
    if (ghBtn) ghBtn.onclick = () => sendToGithub(ticket.id, ghBtn);
    $("ticketThreadTitle").textContent = ticket.subject + " — " + ticket.createdByUsername;
    $("ticketStatusSelect").value = ticket.status;
    $("ticketStatusSelect").onchange = async () => {
      try {
        const out = await G.api("/api/admin/tickets/" + encodeURIComponent(ticket.id) + "/status", {
          method: "POST", body: { status: $("ticketStatusSelect").value }
        });
        await loadTickets();
        renderTicketThread(out.ticket);
      } catch (e) { UI.toast(e.message, "err"); }
    };
    UI.renderTicketThread($("ticketThreadHost"), ticket, async text => {
      const out = await G.api("/api/tickets/" + encodeURIComponent(ticket.id) + "/reply", {
        method: "POST", body: { message: text }
      });
      await loadTickets();
      $("ticketThreadTitle").textContent = out.ticket.subject + " — " + out.ticket.createdByUsername;
      $("ticketStatusSelect").value = out.ticket.status;
      return out.ticket;
    });
  }

  /* ============================== Admin-only: tiles / invites / system ============================== */
  // Every code stops working 30 days after it was made (org invites after 7).
  function inviteStatus(i) {
    const until = i.expiresAt ? "Works until " + new Date(i.expiresAt).toLocaleDateString() : "";
    if (i.used) return '<span class="pill">used</span>';
    if (i.revoked) return '<span class="pill off">revoked</span>';
    if (i.expired) return '<span class="pill off" title="' + G.esc("Expired " + new Date(i.expiresAt).toLocaleDateString()) + '">expired</span>';
    return '<span class="pill on" title="' + G.esc(until) + '">open</span>';
  }

  async function loadAdmin() {
    let d;
    try { d = await G.api("/api/admin/status"); }
    catch (e) { return; }
    $("admTiles").innerHTML =
      '<div class="tile"><span class="big">' + d.users.length + '</span><span class="lbl">Accounts</span></div>' +
      '<div class="tile"><span class="big">' + d.cards.count.toLocaleString() + '</span><span class="lbl">Cards indexed</span></div>' +
      '<div class="tile"><span class="big">' + d.prices.snapshots + '</span><span class="lbl">Price snapshots</span></div>' +
      '<div class="tile"><span class="big">' + d.memoryMB + '</span><span class="lbl">RSS (MB)</span>' +
        '<div class="muted" style="font-size:12px;margin-top:4px">up ' + d.uptimeMin + ' min · ' + G.esc(d.node) + "</div></div>" +
      '<div class="tile"><span class="big" style="font-size:13px;overflow-wrap:anywhere">' + G.esc(d.dataDir) +
        '</span><span class="lbl">Data directory</span></div>';
    renderPriceSource(d.cards);
    renderSealedStatus(d.sealed);
    renderMtgjsonStatus(d.mtgjson);
    invites = d.invites || [];
    renderInvites();
  }

  /* Admin -> Invites (#160): "Show: open" (the default) lists only codes
     that still work, newest first; "all" adds used, revoked and expired
     ones. "Made by" says Pick ticket for the codes printed pick tickets
     make, so the ones an admin minted aren't lost among them. Open rows
     get a Revoke button. */
  let invites = [];
  function renderInvites() {
    const all = $("inviteShow").value === "all";
    const rows = invites.filter(i => all || i.open).slice().reverse();
    const madeBy = i => i.fromPickTicket ? "Pick ticket"
      : i.createdByUsername ? G.esc(i.createdByUsername) + (i.memberInvite ? ' <span class="pill type">member</span>' : "")
      : '<span class="muted">—</span>';
    $("inviteBody").innerHTML = rows.length
      ? rows.map(i => "<tr><td>" + (i.code ? "<code>" + G.esc(i.code) + "</code>" : '<span class="muted">—</span>') + "</td>" +
          '<td data-v="' + (Date.parse(i.createdAt) || 0) + '">' + G.esc(new Date(i.createdAt).toLocaleDateString()) + "</td>" +
          "<td>" + madeBy(i) + "</td>" +
          "<td>" + G.esc(i.note || "") + "</td>" +
          "<td>" + inviteStatus(i) + "</td>" +
          "<td>" + (i.open && i.code ? '<button class="small danger" data-revoke="' + G.esc(i.code) + '">Revoke</button>' : "") + "</td></tr>").join("")
      : UI.emptyRow(6, { icon: "tickets", title: all ? "No invites minted." : "No open invites." });
    $("invitesHdr").textContent = "— " + invites.filter(i => i.open).length + " open, " + invites.length + " in all";
    UI.reapplySorts();
  }

  async function revokeInvite(code, btn) {
    const ok = await UI.confirmDialog("Revoke invite " + code + "? Nobody can sign up with it after this. It can't be undone; " +
      "mint a new one if it's needed again.", { title: "Revoke invite?", danger: true });
    if (!ok) return;
    btn.disabled = true;
    try {
      await G.api("/api/admin/invites/" + encodeURIComponent(code) + "/revoke", { method: "POST" });
      UI.setStatus("admStatus", "Invite " + code + " revoked.", "ok");
      await loadAdmin();
    } catch (e) { UI.setStatus("admStatus", e.message, "err"); btn.disabled = false; }
  }

  /* Admin -> Invites -> Member invites (#337): the switch, the usual number
     and one person's number, plus who invited whom. Only people who have made
     a link or have a number of their own are listed. */
  let memberInvites = null;
  async function loadMemberInvites() {
    let d;
    try { d = await G.api("/api/admin/member-invites"); }
    catch (e) { UI.setStatus("miStatus", e.message, "err"); return; }
    memberInvites = d;
    d.people = Array.isArray(d.people) ? d.people : [];
    $("miEnabled").checked = d.enabled;
    $("miAllowance").value = d.allowance;
    $("miUserAllowance").placeholder = "the usual (" + d.allowance + ")";
    $("memberInvitesHdr").textContent = d.enabled ? "— on, " + d.allowance + " each" : "— off";
    const invitedCell = p => p.invited.length
      ? p.invited.map(x => x.username ? G.esc(x.username) : '<span class="muted">—</span>').join(", ")
      : '<span class="muted">nobody yet</span>';
    $("miBody").innerHTML = d.people.length
      ? d.people.map(p => '<tr><td data-vs="' + G.esc(p.username) + '">' + G.esc(p.username) +
          (p.disabled ? ' <span class="pill off">disabled</span>' : "") + "</td>" +
          "<td>" + invitedCell(p) + "</td>" +
          '<td class="num">' + p.open + "</td>" +
          '<td class="num">' + p.remaining + "</td>" +
          '<td class="num" data-v="' + p.allowance + '">' + p.allowance + (p.custom != null ? ' <span class="pill type">own</span>' : "") + "</td></tr>").join("")
      : UI.emptyRow(5, { icon: "people", title: "No member has made an invite link yet." });
    UI.reapplySorts();
  }

  // A whole number from the box, or null for a blank one, or undefined if it isn't one.
  function wholeNumber(raw) {
    const t = String(raw).trim();
    if (!t) return null;
    return /^\d+$/.test(t) ? Number(t) : undefined;
  }

  async function saveMemberInvites() {
    const enabled = $("miEnabled").checked;
    const allowance = wholeNumber($("miAllowance").value);
    if (allowance == null) { UI.setStatus("miStatus", "Enter how many invites each member gets.", "err"); return; }
    if (memberInvites && memberInvites.enabled && !enabled) {
      const ok = await UI.confirmDialog("Turn member invites off? Members can't make new links, and links already handed out stop working. " +
        "Turning this back on brings back any link that hasn't expired.", { title: "Turn member invites off?", danger: true });
      if (!ok) { $("miEnabled").checked = true; return; }
    }
    try {
      await G.api("/api/admin/member-invites", { method: "POST", body: { enabled, allowance } });
      UI.setStatus("miStatus", "Saved.", "ok");
    } catch (e) { UI.setStatus("miStatus", e.message, "err"); }
    await loadMemberInvites();
  }

  async function saveOneAllowance() {
    const username = $("miUser").value.trim();
    if (!username) { UI.setStatus("miStatus", "Enter whose invites to change.", "err"); return; }
    const allowance = wholeNumber($("miUserAllowance").value);
    if (allowance === undefined) { UI.setStatus("miStatus", "Enter a whole number, or leave it blank for the usual.", "err"); return; }
    try {
      await G.api("/api/admin/member-invites/allowance", { method: "POST", body: { username, allowance } });
      UI.setStatus("miStatus", allowance == null ? username + " is back on the usual number." : username + " now has " + allowance + " in all.", "ok");
      $("miUser").value = "";
      $("miUserAllowance").value = "";
    } catch (e) { UI.setStatus("miStatus", e.message, "err"); }
    await loadMemberInvites();
  }

  /* Admin -> Invites -> Invite requests (#238): what the sign-up page's
     "Request an invite" form sent. "Show: Waiting" (the default) lists the
     open ones; "All" adds sent and dismissed. Send invite mints an invite
     and emails the link; when email can't send it, the link is shown here
     to copy instead. A kind other than "personal" (the business contact
     form, #249) gets a tag on the name. A business enquiry also shows its
     shop name and size under the name and what it wants under Details;
     it has no invite to send, so its action is Mark handled, for once the
     admin has been in touch outside Grimoire. */
  let requests = [];
  const isBusiness = r => r.kind === "business";
  function requestStatus(r) {
    if (r.status === "dismissed") return '<span class="pill off">dismissed</span>';
    if (r.status === "handled") {
      return '<span class="pill on" title="' + G.esc("Handled " + new Date(r.handledAt).toLocaleString()) + '">handled</span>';
    }
    if (r.status === "sent") {
      const joined = r.inviteState === "used";
      const title = "Sent " + new Date(r.sentAt).toLocaleString() +
        (r.inviteState && !joined ? " · the invite is " + r.inviteState : "");
      return '<span class="pill' + (joined ? " on" : "") + '" title="' + G.esc(title) + '">' +
        (joined ? "joined" : r.emailed ? "sent" : "sent, not emailed") + "</span>";
    }
    return '<span class="pill tray">waiting</span>';
  }
  function requestActions(r) {
    const id = G.esc(r.id);
    if (r.status === "open" && isBusiness(r)) {
      return '<button class="small primary" data-rq-handled="' + id + '">' + UI.icon("check") + " Mark handled</button> " +
        '<button class="small" data-rq-dismiss="' + id + '">Dismiss</button>';
    }
    if (r.status === "open") {
      return '<button class="small primary" data-rq-send="' + id + '">' + UI.icon("mail") + " Send invite</button> " +
        '<button class="small" data-rq-dismiss="' + id + '">Dismiss</button>';
    }
    if (r.status !== "sent" || r.inviteState === "used") return "";
    return (r.inviteUrl && r.inviteState === "open"
      ? '<button class="small" data-rq-copy="' + id + '">' + UI.icon("link") + " Copy link</button> " : "") +
      '<button class="small" data-rq-send="' + id + '">Send again</button>';
  }
  function renderRequests() {
    const all = $("requestShow").value === "all";
    const waiting = requests.filter(r => r.status === "open").length;
    const rows = requests.filter(r => all || r.status === "open");
    $("requestBody").innerHTML = rows.length
      ? rows.map(r => '<tr><td data-vs="' + G.esc(r.name) + '">' + G.esc(r.name) +
          (r.kind && r.kind !== "personal" ? ' <span class="pill type">' + G.esc(r.kind) + "</span>" : "") +
          (r.hasAccount ? ' <span class="pill" title="An account already uses this email">has an account</span>' : "") +
          // The shop, under the name so a phone (no Details column) still shows it.
          (isBusiness(r) ? '<div class="muted">' + G.esc(r.shopName || "") +
            (r.shopSize ? " · " + G.esc(r.shopSize) : "") + "</div>" : "") + "</td>" +
          "<td>" + G.esc(r.email) + "</td>" +
          '<td class="hide-sm" style="white-space:pre-wrap">' + G.esc((isBusiness(r) ? r.plans : r.note) || "") + "</td>" +
          '<td class="hide-sm" data-v="' + sortTime(r.createdAt) + '">' + G.esc(new Date(r.createdAt).toLocaleDateString()) + "</td>" +
          "<td>" + requestStatus(r) + "</td>" +
          "<td>" + requestActions(r) + "</td></tr>").join("")
      : UI.emptyRow(6, { icon: "generic", title: all ? "No invite requests yet." : "No requests waiting.",
          hint: all ? "" : "Requests from the sign-up page's Request an invite form, and the landing page's business contact form, show up here." });
    $("requestsHdr").textContent = "— " + waiting + " waiting, " + requests.length + " in all";
    $("requestsBadge").textContent = String(waiting);
    $("requestsBadge").hidden = !waiting;
    UI.reapplySorts();
  }
  async function loadRequests() {
    let d;
    try { d = await G.api("/api/admin/invite-requests"); }
    catch (e) { UI.setStatus("requestStatus", e.message, "err"); return; }
    requests = Array.isArray(d.requests) ? d.requests : [];
    $("requestEmailNote").hidden = d.emailConfigured !== false;
    renderRequests();
  }
  // The server answers with a path when no baseUrl is configured.
  const fullUrl = u => { try { return new URL(u, location.origin).href; } catch (e) { return u; } };
  function copyLink(text) {
    const input = $("requestLink");
    const fallback = () => {
      if (input) { input.focus(); input.select(); }
      UI.toast("Couldn't copy automatically. The link is selected: press Ctrl+C to copy it.", "err");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => UI.toast("Link copied.", "ok"), fallback);
    } else fallback();
  }
  /* The link to send by hand: after a Send that couldn't email it (why,
     in `problem`), or from a sent row's Copy link. */
  function showLink(r, url, problem) {
    const host = $("requestResult");
    host.hidden = false;
    host.innerHTML = '<div class="callout' + (problem ? " warn" : "") + '">' +
      '<span class="cico">' + UI.icon(problem ? "triangle-alert" : "link") + "</span>" +
      '<div class="cbody"><h3>' + (problem ? "Invite made, but not emailed" : "Sign-up link for " + G.esc(r.name)) + "</h3>" +
      (problem ? G.esc(problem) + " " : "") + "Copy this link and send it to " + G.esc(r.name) + " (" + G.esc(r.email) +
      ") yourself. It works once, for 30 days." +
      '<div class="form-row" style="margin-top:8px"><input id="requestLink" readonly aria-label="Sign-up link" ' +
      'style="flex:1;min-width:220px" value="' + G.esc(url) + '">' +
      '<button class="small" id="requestCopy">' + UI.icon("link") + " Copy link</button></div></div></div>";
    $("requestCopy").onclick = () => copyLink(url);
  }
  async function sendRequest(id, btn) {
    const r = requests.find(x => x.id === id);
    if (!r) return;
    btn.disabled = true;
    $("requestResult").hidden = true;
    UI.setStatus("requestStatus", "Sending an invite to " + r.email + "…", "work");
    try {
      const out = await G.api("/api/admin/invite-requests/" + encodeURIComponent(id) + "/send", { method: "POST" });
      if (out.emailed) UI.setStatus("requestStatus", "Invite emailed to " + r.email + ".", "ok");
      else {
        UI.setStatus("requestStatus", "", "");
        showLink(r, fullUrl(out.url), out.emailConfigured
          ? "The email to " + r.email + " didn't go out (" + (out.emailError || "the provider refused it") + ")."
          : "Email isn't set up, so nothing was sent.");
      }
      await loadRequests();
      loadAdmin();
    } catch (e) { UI.setStatus("requestStatus", e.message, "err"); btn.disabled = false; }
  }
  async function dismissRequest(id, btn) {
    const r = requests.find(x => x.id === id);
    if (!r) return;
    const ok = await UI.confirmDialog(isBusiness(r)
      ? "Dismiss the business enquiry from " + r.name + " (" + r.email + ", " + (r.shopName || "no shop name") + ")? " +
        "They aren't told. It can't be undone, but if they get in touch again, the new enquiry shows up here."
      : "Dismiss the request from " + r.name + " (" + r.email + ")? No invite is sent and " +
      "they aren't told. It can't be undone, but if they ask again, the new request shows up here.",
      { title: isBusiness(r) ? "Dismiss enquiry?" : "Dismiss request?", okLabel: "Dismiss", danger: true });
    if (!ok) return;
    btn.disabled = true;
    try {
      await G.api("/api/admin/invite-requests/" + encodeURIComponent(id) + "/dismiss", { method: "POST" });
      UI.setStatus("requestStatus", "Request from " + r.name + " dismissed.", "ok");
      await loadRequests();
    } catch (e) { UI.setStatus("requestStatus", e.message, "err"); btn.disabled = false; }
  }
  // A business enquiry (#249), after the admin has been in touch. Nothing
  // is sent and the entry stays under "Show: All", so no confirm.
  async function handledRequest(id, btn) {
    const r = requests.find(x => x.id === id);
    if (!r) return;
    btn.disabled = true;
    try {
      await G.api("/api/admin/invite-requests/" + encodeURIComponent(id) + "/handled", { method: "POST" });
      UI.setStatus("requestStatus", "Enquiry from " + r.name + " marked handled.", "ok");
      await loadRequests();
    } catch (e) { UI.setStatus("requestStatus", e.message, "err"); btn.disabled = false; }
  }

  /* Reflects cards.status()'s priceSource/mpPricesUpdatedAt/mpPricesMatched
     into the select + status line - called from loadAdmin() (d.cards is
     cards.status() wholesale) so this stays in sync with admReload/the
     4-second post-action polls the same way every other tile does, without
     a second network round trip just for this one control. Only touches
     the select's value when it's not what the user is actively looking at
     mid-edit... in practice there's no free-text entry here, just a
     two-option dropdown, so simply always syncing it is fine. */
  function renderPriceSource(c) {
    if (!c) return;
    lastCardsStatus = c;
    $("priceSourceSelect").value = c.priceSource || "scryfall";
    $("priceSourceManapoolNote").hidden = c.priceSource !== "manapool";
    if (c.priceSource === "manapool" && c.mpPricesFailedAt) {
      // #529: a refused refresh leaves the loaded prices alone - say so,
      // and which prices those are.
      const why = String(c.mpPricesError || "no reason given").replace(/\.?\s*$/, ".");
      UI.setStatus("priceSourceStatus", "Last Manapool refresh failed at " +
        new Date(c.mpPricesFailedAt).toLocaleString() + ": " + why + " " +
        (c.mpPricesUpdatedAt
          ? "Still using Manapool prices from " + new Date(c.mpPricesUpdatedAt).toLocaleString() + " (" +
            (c.mpPricesMatched == null ? "?" : c.mpPricesMatched.toLocaleString()) + " of " +
            c.count.toLocaleString() + " printings priced)."
          : "Showing Scryfall's prices until Manapool answers properly. It retries daily, or press Refresh now."),
        "err");
    } else if (c.priceSource === "manapool") {
      UI.setStatus("priceSourceStatus", c.mpPricesUpdatedAt
        ? "Manapool prices as of " + new Date(c.mpPricesUpdatedAt).toLocaleString() + " — " +
          (c.mpPricesMatched == null ? "?" : c.mpPricesMatched.toLocaleString()) + " of " +
          c.count.toLocaleString() + " printings priced."
        : "Manapool is selected but hasn't refreshed yet — press Refresh now.", "work");
    } else {
      UI.setStatus("priceSourceStatus", "Using Scryfall's own prices.", "");
    }
  }

  /* Reflects sealed.status() into the status line - same "called from
     loadAdmin(), stays in sync with admReload" pattern as renderPriceSource
     above. Catalog/pricing-only for now (BACKLOG.md #24), so there's no
     select to sync, just a count/timestamp. */
  function renderSealedStatus(s) {
    if (!s) return;
    if (s.error) { UI.setStatus("sealedStatus", "Last refresh failed: " + s.error, "err"); return; }
    UI.setStatus("sealedStatus", s.updatedAt
      ? s.count.toLocaleString() + " sealed products as of " + new Date(s.updatedAt).toLocaleString() + "."
      : "Hasn't refreshed yet — press Refresh now.", s.updatedAt ? "" : "work");
  }

  /* Reflects mtgjson.status() into the status line - same "called from
     loadAdmin()" pattern as renderSealedStatus above. Two independent
     background operations share this one line (identifier refresh, 90-day
     backfill) since they're never both meaningfully running for a viewer to
     care about at once - whichever is active/most-recently-relevant wins. */
  function renderMtgjsonStatus(m) {
    if (!m) return;
    if (m.backfillRunning) { UI.setStatus("mtgjsonStatus", "Backfilling: " + (m.backfillProgress || "working…"), "work"); return; }
    if (m.backfillError) { UI.setStatus("mtgjsonStatus", "Last backfill failed: " + m.backfillError, "err"); return; }
    if (m.idsBuilding) { UI.setStatus("mtgjsonStatus", "Refreshing the identifier map…", "work"); return; }
    if (m.idsError) { UI.setStatus("mtgjsonStatus", "Identifier map refresh failed: " + m.idsError, "err"); return; }
    if (!m.idsReady) { UI.setStatus("mtgjsonStatus", "No identifier map yet — press Refresh identifier map first.", "work"); return; }
    const idsLine = m.idsCount.toLocaleString() + " printings mapped" +
      (m.idsBuiltAt ? " as of " + new Date(m.idsBuiltAt).toLocaleString() : "");
    const backfillLine = m.backfillDone ? " · last backfill " + new Date(m.backfillDone).toLocaleString() : " · never backfilled";
    UI.setStatus("mtgjsonStatus", idsLine + backfillLine, "ok");
  }

  async function loadEmailConfig() {
    let d;
    try { d = await G.api("/api/admin/email"); } catch (e) { return; }
    $("emailProvider").value = d.provider || "resend";
    $("emailFrom").value = d.from || "";
    $("emailKey").value = "";
    $("emailKey").placeholder = d.hasKey ? "leave blank to keep the saved key" : "paste your API key";
    $("emailState").textContent = d.configured ? "configured" : "not configured yet";
  }

  async function loadGithubConfig() {
    let d;
    try { d = await G.api("/api/admin/github"); } catch (e) { return; }
    $("githubRepo").value = d.repo || "";
    $("githubToken").value = "";
    $("githubToken").placeholder = d.hasToken ? "leave blank to keep the saved token" : "paste a fine-grained token";
    $("githubState").textContent = d.configured ? "connected" : "not connected yet";
    const s = d.lastSync;
    $("githubSyncInfo").textContent = !d.syncMinutes
      ? "Automatic checking is switched off in config.json (github.syncMinutes)."
      : !s ? "Checks linked issues every " + d.syncMinutes + " minutes; no check since the server started."
      : "Last check " + new Date(s.at).toLocaleString() + ": " +
        (s.skipped ? s.skipped : s.error && !s.checked ? s.error
          : s.checked + " issue" + (s.checked === 1 ? "" : "s") + " checked, " + s.resolved + " ticket" +
            (s.resolved === 1 ? "" : "s") + " resolved" + (s.error ? " (stopped early: " + s.error + ")" : "") + ".");
  }

  /* Grimoire's Mana Pool app (#499): the secret never comes back, only that one is saved. */
  async function loadManapoolApp() {
    let d;
    try { d = await G.api("/api/admin/manapool-app"); } catch (e) { return; }
    $("mpAppId").value = d.clientId || "";
    $("mpAppSecret").value = "";
    $("mpAppSecret").placeholder = d.hasSecret ? "leave blank to keep the saved secret" : "paste the client secret";
    $("mpAppState").textContent = !d.featureOn ? "Mana Pool is turned off in config.json" : d.ready ? "saved" : "not set up yet";
    const day = iso => iso ? new Date(iso).toLocaleString() : "";
    $("mpAppFacts").innerHTML =
      "<dt>Redirect URI to register</dt><dd><code>" + G.esc(d.redirectUri) + "</code></dd>" +
      "<dt>Scopes Grimoire asks for</dt><dd><code>" + G.esc((d.scopes || []).join(" ")) + "</code></dd>" +
      (d.cutoffAt ? "<dt>Old access tokens stop working</dt><dd>" + G.esc(day(d.cutoffAt)) + "</dd>" : "");
  }

  async function loadRestartStatus() {
    let m;
    try { m = await G.api("/api/meta"); } catch (e) { return; }
    const pending = m.restart;
    $("restartCancel").hidden = !pending;
    if (pending) {
      const secs = Math.max(0, Math.round((pending.at - Date.now()) / 1000));
      UI.setStatus("restartStatus", "Restart pending in ~" + secs + "s" +
        (pending.reason ? " — " + pending.reason : "") + ".", "work");
    }
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    if (!G.isModerator) {
      UI.toast("Administrators and moderators only.", "err");
      location.href = "/index.html";
      return;
    }

    $("roleNote").textContent = G.isAdmin
      ? "You're signed in as an administrator."
      : "You're signed in as a moderator: you can see accounts and answer support tickets here. The rest is for administrators.";

    if (G.isAdmin) {
      $("tilesSection").hidden = false;
      $("invitesSection").hidden = false;
      $("memberInvitesSection").hidden = false;
      $("emailSection").hidden = false;
      $("githubSection").hidden = false;
      $("systemSection").hidden = false;
      $("systemDanger").hidden = false;
      // Tab buttons for admin-only panes start hidden in the markup (a
      // moderator must never see a tab that opens onto an empty pane) -
      // unhide them alongside the sections themselves.
      $("tabSystem").hidden = false;
      $("tabInvites").hidden = false;
      $("tabEmail").hidden = false;
      $("tabGithub").hidden = false;
      $("tabManapool").hidden = false;
      $("mpAppSection").hidden = false;
      $("requestsSection").hidden = false;
      loadAdmin();
      loadRestartStatus();
      loadEmailConfig();
      loadGithubConfig();
      loadManapoolApp();
      // Loaded now for the tab's waiting count, and again on opening the
      // tab so a request (or an email set-up) since then shows.
      loadRequests();
      $("tabInvites").addEventListener("click", loadRequests);
      $("tabInvites").addEventListener("click", loadMemberInvites);
      loadMemberInvites();
      $("miSave").onclick = saveMemberInvites;
      $("miUserSave").onclick = saveOneAllowance;
      $("requestShow").onchange = renderRequests;
      $("requestBody").addEventListener("click", e => {
        const b = e.target.closest && e.target.closest("[data-rq-send],[data-rq-dismiss],[data-rq-copy],[data-rq-handled]");
        if (!b) return;
        if (b.hasAttribute("data-rq-send")) sendRequest(b.getAttribute("data-rq-send"), b);
        else if (b.hasAttribute("data-rq-handled")) handledRequest(b.getAttribute("data-rq-handled"), b);
        else if (b.hasAttribute("data-rq-dismiss")) dismissRequest(b.getAttribute("data-rq-dismiss"), b);
        else {
          const r = requests.find(x => x.id === b.getAttribute("data-rq-copy"));
          if (r && r.inviteUrl) { const url = fullUrl(r.inviteUrl); showLink(r, url, null); copyLink(url); }
        }
      });

      UI.wireCredentialSave({
        buttonId: "emailSave", statusId: "emailStatus", url: "/api/admin/email",
        fields: [{ id: "emailProvider", key: "provider" }, { id: "emailFrom", key: "from" },
          { id: "emailKey", key: "apiKey", secret: true }],
        savedMsg: "Saved.", onSaved: loadEmailConfig
      });
      UI.wireCredentialTest({
        buttonId: "emailTest", statusId: "emailStatus", url: "/api/admin/email/test",
        method: "POST", workMsg: "Sending…",
        onResult: out => ({ ok: true, msg: "Sent to " + out.sentTo + " — check your inbox." })
      });

      UI.wireCredentialSave({
        buttonId: "mpAppSave", statusId: "mpAppStatus", url: "/api/admin/manapool-app",
        fields: [{ id: "mpAppId", key: "clientId" }, { id: "mpAppSecret", key: "clientSecret", secret: true }],
        savedMsg: "Saved.", onSaved: loadManapoolApp
      });
      UI.wireCredentialSave({
        buttonId: "githubSave", statusId: "githubStatus", url: "/api/admin/github",
        fields: [{ id: "githubRepo", key: "repo" }, { id: "githubToken", key: "token", secret: true }],
        savedMsg: "Saved.", onSaved: loadGithubConfig
      });
      UI.wireCredentialTest({
        buttonId: "githubTest", statusId: "githubStatus", url: "/api/admin/github/test",
        method: "POST", workMsg: "Checking…",
        onResult: out => ({ ok: true, msg: "Connected to " + out.fullName + (out.private ? " (private)" : "") + "." })
      });

      $("admReload").onclick = loadAdmin;
      $("admCards").onclick = async () => {
        const ok = await UI.confirmDialog("Rebuild the card database now?\n\nThis downloads Scryfall's bulk file again — several hundred " +
          "megabytes and a few minutes. The app keeps working while it runs.", { title: "Rebuild card database?" });
        if (!ok) return;
        const btn = $("admCards");
        const label = btn.innerHTML; // keeps the button's icon
        btn.disabled = true;
        try {
          await G.api("/api/admin/cards/refresh", { method: "POST" });
          UI.setStatus("sysStatus", "Rebuild started.", "ok");
        } catch (e) {
          UI.setStatus("sysStatus", e.message, "err");
          btn.disabled = false;
          return;
        }
        // The POST above only starts the job - it runs for minutes on the
        // server, so keep the button disabled (a second click would queue a
        // redundant rebuild) until a poll of /api/cards/status says it's
        // done, rather than re-enabling the instant this request returns.
        const poll = setInterval(async () => {
          let st;
          try { st = await G.cards.status(); } catch (e) { return; }
          if (st.building) {
            btn.textContent = "Rebuilding" + (st.progress ? " — " + st.progress : "…");
          } else {
            clearInterval(poll);
            btn.innerHTML = label;
            btn.disabled = false;
            loadAdmin();
          }
        }, 4000);
      };
      $("admTags").onclick = async () => {
        const ok = await UI.confirmDialog("Rebuild the oracle/art tag index now?\n\nThis downloads Scryfall's Tagger bulk files again — " +
          "about 20MB combined, well under a minute. The app keeps working while it runs; otag/art search just answers from " +
          "the old index until it's done.", { title: "Rebuild tag index?" });
        if (!ok) return;
        const btn = $("admTags");
        const label = btn.innerHTML; // keeps the button's icon
        btn.disabled = true;
        try {
          await G.api("/api/admin/tags/refresh", { method: "POST" });
          UI.setStatus("sysStatus", "Tag index rebuild started.", "ok");
        } catch (e) {
          UI.setStatus("sysStatus", e.message, "err");
          btn.disabled = false;
          return;
        }
        const poll = setInterval(async () => {
          let st;
          try { st = await G.api("/api/cards/tags-status"); } catch (e) { return; }
          if (st.building) {
            btn.textContent = "Rebuilding" + (st.progress ? " — " + st.progress : "…");
          } else {
            clearInterval(poll);
            btn.innerHTML = label;
            btn.disabled = false;
          }
        }, 3000);
      };
      $("admSnap").onclick = async () => {
        UI.setStatus("sysStatus", "Taking a snapshot…", "work");
        try {
          const out = await G.api("/api/admin/prices/snapshot", { method: "POST" });
          UI.setStatus("sysStatus", out.ok
            ? "Snapshot " + out.date + ": " + out.printings + " printings, " + out.priced + " with a price."
            : "Skipped: " + (out.skipped || "unknown reason"), out.ok ? "ok" : "work");
        } catch (e) { UI.setStatus("sysStatus", e.message, "err"); }
      };
      $("priceSourceSave").onclick = async () => {
        const value = $("priceSourceSelect").value;
        if (value === "manapool") {
          const ok = await UI.confirmDialog("Switch every printing's price to Manapool's own numbers?\n\n" +
            "A printing Manapool has no current listing for will show no price at all - it will NOT fall back " +
            "to Scryfall. This affects the price snapshot, Movers, Portfolio, and any bulk-price rule using the " +
            "default basis, for everyone.", { title: "Switch to Manapool prices?" });
          if (!ok) { renderPriceSource(lastCardsStatus); return; }
        }
        const btn = $("priceSourceSave");
        btn.disabled = true;
        UI.setStatus("priceSourceStatus", "Applying…", "work");
        try {
          const out = await G.api("/api/admin/cards/price-source", { method: "POST", body: { priceSource: value } });
          UI.setStatus("priceSourceStatus", out.source === "manapool"
            ? "Switched to Manapool - " + (out.matched == null ? "?" : out.matched.toLocaleString()) +
              " of " + out.total.toLocaleString() + " printings priced."
            : "Switched to Scryfall's own prices.", "ok");
        } catch (e) { UI.setStatus("priceSourceStatus", e.message, "err"); }
        btn.disabled = false;
        loadAdmin();
      };
      $("priceSourceApply").onclick = async () => {
        const btn = $("priceSourceApply");
        btn.disabled = true;
        UI.setStatus("priceSourceStatus", "Refreshing…", "work");
        try {
          const out = await G.api("/api/admin/cards/apply-price-source", { method: "POST" });
          UI.setStatus("priceSourceStatus", out.source === "manapool"
            ? "Refreshed - " + (out.matched == null ? "?" : out.matched.toLocaleString()) +
              " of " + out.total.toLocaleString() + " printings priced."
            : "Using Scryfall's own prices.", "ok");
        } catch (e) { UI.setStatus("priceSourceStatus", e.message, "err"); }
        btn.disabled = false;
        loadAdmin();
      };
      $("sealedRefresh").onclick = async () => {
        const btn = $("sealedRefresh");
        btn.disabled = true;
        UI.setStatus("sealedStatus", "Refreshing…", "work");
        try {
          const out = await G.api("/api/admin/sealed/refresh", { method: "POST" });
          UI.setStatus("sealedStatus", out.count.toLocaleString() + " sealed products refreshed.", "ok");
        } catch (e) { UI.setStatus("sealedStatus", e.message, "err"); }
        btn.disabled = false;
        loadAdmin();
      };
      $("mtgjsonIdsRefresh").onclick = async () => {
        const btn = $("mtgjsonIdsRefresh");
        const label = btn.innerHTML; // keeps the button's icon
        btn.disabled = true;
        try {
          await G.api("/api/admin/mtgjson/refresh-identifiers", { method: "POST" });
          UI.setStatus("mtgjsonStatus", "Identifier map refresh started — ~229MB download, streamed and discarded once trimmed.", "work");
        } catch (e) {
          UI.setStatus("mtgjsonStatus", e.message, "err");
          btn.disabled = false;
          return;
        }
        const poll = setInterval(async () => {
          let st;
          try { st = await G.api("/api/admin/mtgjson/status"); } catch (e) { return; }
          renderMtgjsonStatus(st);
          if (!st.idsBuilding) { clearInterval(poll); btn.innerHTML = label; btn.disabled = false; }
        }, 4000);
      };
      $("mtgjsonBackfill").onclick = async () => {
        const ok = await UI.confirmDialog("Replace the whole price history archive with MTGJSON's 90-day history?\n\n" +
          "This deletes every existing day/series snapshot file first, then rebuilds from TCGplayer/CardKingdom/" +
          "Cardmarket/Cardsphere data. Anything the nightly snapshot recorded before now is permanently gone.",
          { title: "Replace price archive?", danger: true });
        if (!ok) return;
        const btn = $("mtgjsonBackfill");
        const label = btn.innerHTML; // keeps the button's icon
        btn.disabled = true;
        try {
          await G.api("/api/admin/mtgjson/backfill", { method: "POST" });
          UI.setStatus("mtgjsonStatus", "Backfill started — ~147MB download, streamed. This can take several minutes.", "work");
        } catch (e) {
          UI.setStatus("mtgjsonStatus", e.message, "err");
          btn.disabled = false;
          return;
        }
        const poll = setInterval(async () => {
          let st;
          try { st = await G.api("/api/admin/mtgjson/status"); } catch (e) { return; }
          renderMtgjsonStatus(st);
          if (!st.backfillRunning) { clearInterval(poll); btn.innerHTML = label; btn.disabled = false; }
        }, 5000);
      };
      $("inviteShow").onchange = renderInvites;
      $("inviteBody").addEventListener("click", e => {
        const b = e.target.closest && e.target.closest("[data-revoke]");
        if (b) revokeInvite(b.getAttribute("data-revoke"), b);
      });
      $("admInvite").onclick = async () => {
        try {
          const out = await G.api("/api/admin/invite", { method: "POST", body: { note: $("invNote").value } });
          UI.setStatus("admStatus", "Invite code " + out.invite.code + " — sign-up link: " + out.url, "ok");
          $("invNote").value = "";
          loadAdmin();
        } catch (e) { UI.setStatus("admStatus", e.message, "err"); }
      };
      $("restartGo").onclick = async () => {
        const delaySeconds = Math.max(5, parseInt($("restartDelay").value, 10) || 30);
        const reason = $("restartReason").value.trim();
        const ok = await UI.confirmDialog("Restart the server in " + delaySeconds + "s? Everyone connected will see a countdown banner first.",
          { title: "Restart the server?" });
        if (!ok) return;
        try {
          await G.api("/api/admin/restart", { method: "POST", body: { delaySeconds, reason } });
          UI.setStatus("restartStatus", "Restart scheduled in " + delaySeconds + "s.", "ok");
          loadRestartStatus();
        } catch (e) { UI.setStatus("restartStatus", e.message, "err"); }
      };
      $("restartCancel").onclick = async () => {
        try {
          await G.api("/api/admin/restart/cancel", { method: "POST" });
          UI.setStatus("restartStatus", "Pending restart cancelled.", "ok");
          loadRestartStatus();
        } catch (e) { UI.setStatus("restartStatus", e.message, "err"); }
      };
    } else {
      // A moderator has no System/Invites/Email/GitHub tabs (never unhidden above),
      // so they land on the first one they actually have (a remembered
      // admin-only tab is never chosen: its button is hidden).
    }
    // After the admin-only tab buttons are unhidden above; the tab is remembered (UI.pageTabs).
    tabs = UI.pageTabs({ tabs: Object.entries(PANES).map(([k, ids]) =>
      ({ id: k, button: "tab" + k.charAt(0).toUpperCase() + k.slice(1), panes: ids })) });

    $("userSearch").addEventListener("input", G.debounce(() => { page = 1; loadUsers(); }, 250));
    $("userRoleFilter").onchange = () => { page = 1; loadUsers(); };
    $("userStatusFilter").onchange = () => { page = 1; loadUsers(); };
    $("userPrev").onclick = () => { if (page > 1) { page--; loadUsers(); } };
    $("userNext").onclick = () => { page++; loadUsers(); };
    loadUsers();

    $("ticketSearch").addEventListener("input", G.debounce(() => { ticketPage = 1; loadTickets(); }, 250));
    $("ticketStatusFilter").onchange = () => { ticketPage = 1; loadTickets(); };
    $("ticketCategoryFilter").onchange = () => { ticketPage = 1; loadTickets(); };
    // Rows are redrawn on every load, so listen once on the tbody.
    const ticketRowOf = e => e.target && e.target.closest ? e.target.closest("tr[data-id]") : null;
    $("ticketBody").addEventListener("click", e => { const tr = ticketRowOf(e); if (tr) openTicket(tr.dataset.id); });
    $("ticketBody").addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = ticketRowOf(e);
      if (!tr || e.target !== tr) return;
      e.preventDefault();
      openTicket(tr.dataset.id);
    });
    UI.onClose("ticketPanel", markTicketRow);
    $("ticketPrev").onclick = () => { if (ticketPage > 1) { ticketPage--; loadTickets(); } };
    $("ticketNext").onclick = () => { ticketPage++; loadTickets(); };
    loadTickets();
  });
})();
