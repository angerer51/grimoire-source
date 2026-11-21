"use strict";
(function () {
  const $ = UI.$;
  let data = null;       // last GET /api/orgs/mine response
  let managing = null;   // member currently open in the manage modal

  const ROLE_LABEL = { owner: "Owner", manager: "Manager", staff: "Staff" };
  const isManager = () => G.me && (G.me.orgRole === "owner" || G.me.orgRole === "manager");
  const isOwner = () => G.me && G.me.orgRole === "owner";

  /* A store's name for display. An archived one (#134) shows as
     "Name (archived)"; the server sends Managers and Owners its name. */
  function storeLabel(id) {
    const s = data.stores.find(x => x.id === id);
    if (s) return s.name;
    const name = (data.archivedStoreNames || {})[id];
    return name ? name + " (archived)" : "an archived store";
  }

  function storeChecklist(containerId, checkedIds, opts) {
    const el = $(containerId);
    if (!data || !data.stores.length) { el.innerHTML = ""; return; }
    // Archived stores aren't tickable, but the server keeps them on save
    // (#134), so say so rather than letting them silently vanish.
    const archived = checkedIds.filter(id => !data.stores.some(s => s.id === id));
    el.innerHTML = '<span class="muted" style="align-self:center">Stores</span>' +
      data.stores.filter(s => !s.archived).map(s =>
        '<label style="min-width:0"><input type="checkbox" value="' + s.id + '"' +
          (checkedIds.includes(s.id) ? " checked" : "") + '> ' + G.esc(s.name) + '</label>'
      ).join("") +
      (archived.length ? '<span class="muted" style="align-self:center">Also has ' +
        archived.map(storeLabel).map(G.esc).join(", ") + ", kept for when " + (archived.length > 1 ? "they're" : "it's") + " restored</span>" : "");
    if (opts && opts.hidden) el.hidden = true; else el.hidden = false;
  }
  function checkedStoreIds(containerId) {
    return [...$(containerId).querySelectorAll("input[type=checkbox]:checked")].map(c => c.value);
  }

  /* ============================== Load / render ============================== */
  async function load() {
    if (!G.me || !G.me.orgId) {
      $("noOrgSection").hidden = false;
      $("orgSection").hidden = true;
      return;
    }
    try { data = await G.api("/api/orgs/mine"); }
    catch (e) { UI.toast("Could not load your organization: " + e.message, "err"); return; }

    $("noOrgSection").hidden = true;
    $("orgSection").hidden = false;
    $("orgTitle").textContent = data.org.name;
    $("orgRoleBadge").textContent = "You are " + (ROLE_LABEL[G.me.orgRole] || G.me.orgRole);

    renderStores();
    renderArchived();
    renderMembers();

    $("addStoreRow").hidden = !isManager();
    $("inviteBox").hidden = !isManager();
    if (isManager()) {
      const inviteRoleSel = $("inviteRole");
      // Only an Owner can mint another Owner/Manager invite - same rule the
      // server enforces (POST /api/orgs/invite), reflected here so a
      // Manager isn't offered an option that would just 403.
      [...inviteRoleSel.options].forEach(o => { o.hidden = (o.value !== "staff") && !isOwner(); });
      inviteRoleSel.value = "staff";
      syncInviteStoresVisibility();
      await loadInvites();
    }
    UI.reapplySorts();
  }

  function renderStores() {
    $("storesBody").innerHTML = data.stores.filter(s => !s.archived).map(s =>
      "<tr><td>" + G.esc(s.name) + "</td>" +
      "<td>" + G.esc(new Date(s.createdAt).toLocaleDateString()) + "</td>" +
      "<td>" + (isManager()
        ? '<button class="small" data-rename="' + s.id + '">Rename</button> ' +
          // Archive is Owner-only (the server enforces it too).
          (isOwner() ? '<button class="small" data-archive="' + s.id + '">Archive</button>' : "")
        : "") + "</td></tr>"
    ).join("") || UI.emptyRow(3, { icon: "locations", title: "No stores yet." });
    $("storesBody").querySelectorAll("[data-rename]").forEach(b => {
      b.onclick = async () => {
        const id = b.dataset.rename;
        const s = data.stores.find(x => x.id === id);
        const name = await UI.promptDialog("New name for this store", { title: "Rename store", value: s && s.name, okLabel: "Rename" });
        if (name == null) return; // cancelled
        try {
          await G.api("/api/orgs/stores/" + encodeURIComponent(id) + "/rename", { method: "POST", body: { name } });
          UI.setStatus("storesStatus", "Renamed.", "ok");
          load();
        } catch (e) { UI.setStatus("storesStatus", e.message, "err"); }
      };
    });
    $("storesBody").querySelectorAll("[data-archive]").forEach(b => {
      b.onclick = async () => {
        const id = b.dataset.archive;
        const s = data.stores.find(x => x.id === id);
        const ok = await UI.confirmDialog(
          "Archive \"" + (s && s.name) + "\"? Its inventory and history stay on the server, but nobody can access " +
          "or switch to it until an owner restores it from Archived stores.", { title: "Archive store?", danger: true, okLabel: "Archive" });
        if (!ok) return;
        try {
          await G.api("/api/orgs/stores/" + encodeURIComponent(id) + "/archive", { method: "POST" });
          UI.setStatus("storesStatus", "Archived.", "ok");
          load();
        } catch (e) { UI.setStatus("storesStatus", e.message, "err"); }
      };
    });
  }

  /* Owners only: the server sends archivedStores empty to anyone else. */
  function renderArchived() {
    const list = (data.archivedStores || []);
    $("archivedBox").hidden = !isOwner() || !list.length;
    $("archivedBody").innerHTML = list.map(s =>
      "<tr><td>" + G.esc(s.name) + "</td>" +
      "<td>" + (s.archivedAt ? G.esc(new Date(s.archivedAt).toLocaleDateString()) : '<span class="muted">—</span>') + "</td>" +
      '<td><button class="small" data-restore="' + G.esc(s.id) + '">Restore</button></td></tr>'
    ).join("");
    $("archivedBody").querySelectorAll("[data-restore]").forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await G.api("/api/orgs/stores/" + encodeURIComponent(b.dataset.restore) + "/restore", { method: "POST" });
          UI.setStatus("storesStatus", "Restored.", "ok");
          load();
        } catch (e) { UI.setStatus("storesStatus", e.message, "err"); b.disabled = false; }
      };
    });
  }

  /* ============================== Outstanding invites ============================== */
  async function loadInvites() {
    let d;
    try { d = await G.api("/api/orgs/invites"); }
    catch (e) { UI.setStatus("invitesStatus", e.message, "err"); return; }
    const storeName = id => { const s = data.stores.find(x => x.id === id); return s ? s.name : null; };
    $("invitesHint").textContent = isOwner()
      ? "Every unused invite into this organization. Each expires " + d.days + " days after it was made."
      : "The staff invites you made that haven't been used yet. Each expires " + d.days + " days after it was made.";
    $("invitesBody").innerHTML = d.invites.map(i => {
      const stores = i.orgRole === "staff"
        ? (i.storeIds.map(storeName).filter(Boolean).map(G.esc).join(", ") || '<span class="muted">none</span>')
        : '<span class="muted">all stores</span>';
      return "<tr><td><code>" + G.esc(i.code) + "</code>" + (i.note ? ' <span class="muted">' + G.esc(i.note) + "</span>" : "") + "</td>" +
        "<td>" + G.esc(ROLE_LABEL[i.orgRole] || i.orgRole) + "</td>" +
        '<td class="hide-sm">' + stores + "</td>" +
        '<td class="hide-sm">' + G.esc(i.createdByUsername || "—") + "</td>" +
        '<td data-v="' + (Date.parse(i.expiresAt) || 0) + '">' + (i.expiresAt ? G.esc(new Date(i.expiresAt).toLocaleString()) : "—") + "</td>" +
        '<td><button class="small danger" data-revoke="' + G.esc(i.code) + '">Revoke</button></td></tr>';
    }).join("") || UI.emptyRow(6, { icon: "people", title: "No outstanding invites." });
    $("invitesBody").querySelectorAll("[data-revoke]").forEach(b => {
      b.onclick = async () => {
        const code = b.dataset.revoke;
        const ok = await UI.confirmDialog("Revoke invite " + code + "? Nobody will be able to sign up with it.",
          { title: "Revoke invite?", danger: true, okLabel: "Revoke" });
        if (!ok) return;
        try {
          await G.api("/api/orgs/invites/" + encodeURIComponent(code) + "/revoke", { method: "POST" });
          UI.setStatus("invitesStatus", "Revoked " + code + ".", "ok");
          loadInvites();
        } catch (e) { UI.setStatus("invitesStatus", e.message, "err"); }
      };
    });
    UI.reapplySorts();
  }

  function renderMembers() {
    $("membersBody").innerHTML = data.members.map(m => {
      const stores = (m.orgRole === "owner" || m.orgRole === "manager")
        ? '<span class="muted">all stores</span>'
        : (m.storeIds.length ? m.storeIds.map(storeLabel).map(G.esc).join(", ") : '<span class="muted">none assigned</span>');
      const canManage = isManager() && m.id !== G.me.id &&
        !((m.orgRole === "owner" || m.orgRole === "manager") && !isOwner());
      return "<tr><td>" + G.esc(m.displayName) + " <span class='muted'>(" + G.esc(m.username) + ")</span>" +
        (m.id === G.me.id ? ' <span class="pill on">you</span>' : "") + "</td>" +
        "<td>" + G.esc(ROLE_LABEL[m.orgRole] || m.orgRole) + "</td>" +
        "<td>" + stores + "</td>" +
        "<td>" + (canManage ? '<button class="small" data-manage="' + m.id + '">Manage</button>' : "") + "</td></tr>";
    }).join("") || UI.emptyRow(4, { icon: "people", title: "No members." });
    $("membersBody").querySelectorAll("[data-manage]").forEach(b => {
      b.onclick = () => openManageModal(data.members.find(m => m.id === b.dataset.manage));
    });
  }

  /* ============================== Invite ============================== */
  function syncInviteStoresVisibility() {
    const staffOnly = $("inviteRole").value === "staff";
    storeChecklist("inviteStoresRow", [], { hidden: !staffOnly });
  }

  /* ============================== Manage-member modal ============================== */
  function openManageModal(m) {
    managing = m;
    $("memberModalTitle").textContent = "Manage " + (m.displayName || m.username);
    $("memberRole").value = m.orgRole;
    // Only an Owner can promote someone to Owner/Manager or demote one -
    // same rule as the invite role picker above.
    [...$("memberRole").options].forEach(o => { o.hidden = (o.value !== "staff") && !isOwner(); });
    syncMemberStoresVisibility();
    storeChecklist("memberStoresRow", m.storeIds || [], { hidden: $("memberRole").value !== "staff" });
    $("memberModalStatus").textContent = "";
    $("memberModalStatus").className = "status";
    UI.showModal("memberModal", "memberRole");
  }
  function syncMemberStoresVisibility() {
    $("memberStoresRow").hidden = $("memberRole").value !== "staff";
  }

  UI.boot(async function () {
    $("orgCreate").onclick = async () => {
      $("orgCreate").disabled = true;
      UI.setStatus("orgCreateStatus", "Creating…", "work");
      try {
        await G.api("/api/orgs", { method: "POST", body: { name: $("orgName").value } });
        UI.setStatus("orgCreateStatus", "Organization created — your collection is now Store 1.", "ok");
        await G.load(); // G.me.orgId/orgRole changed server-side - refresh before re-rendering
        await load();
      } catch (e) {
        UI.setStatus("orgCreateStatus", e.message, "err");
      }
      $("orgCreate").disabled = false;
    };

    $("addStoreBtn").onclick = async () => {
      const name = $("newStoreName").value.trim();
      if (!name) { UI.setStatus("storesStatus", "Give the store a name.", "err"); return; }
      $("addStoreBtn").disabled = true;
      try {
        await G.api("/api/orgs/stores", { method: "POST", body: { name } });
        $("newStoreName").value = "";
        UI.setStatus("storesStatus", "Added.", "ok");
        await load();
      } catch (e) { UI.setStatus("storesStatus", e.message, "err"); }
      $("addStoreBtn").disabled = false;
    };

    $("inviteRole").onchange = syncInviteStoresVisibility;
    $("inviteCreate").onclick = async () => {
      $("inviteCreate").disabled = true;
      UI.setStatus("inviteStatus", "Creating…", "work");
      try {
        const orgRole = $("inviteRole").value;
        const storeIds = orgRole === "staff" ? checkedStoreIds("inviteStoresRow") : [];
        if (orgRole === "staff" && !storeIds.length) {
          UI.setStatus("inviteStatus", "Pick at least one store for a staff invite.", "err");
          $("inviteCreate").disabled = false;
          return;
        }
        const out = await G.api("/api/orgs/invite", { method: "POST", body: { orgRole, storeIds, note: $("inviteNote").value } });
        UI.setStatus("inviteStatus", "Invite code " + out.invite.code + " — sign-up link: " + out.url, "ok");
        $("inviteNote").value = "";
        loadInvites();
      } catch (e) { UI.setStatus("inviteStatus", e.message, "err"); }
      $("inviteCreate").disabled = false;
    };

    $("memberRole").onchange = () => {
      syncMemberStoresVisibility();
      if (managing) storeChecklist("memberStoresRow", managing.storeIds || [], { hidden: $("memberRole").value !== "staff" });
    };
    $("memberCancel").onclick = () => UI.hideModal("memberModal");
    $("memberSave").onclick = async () => {
      const orgRole = $("memberRole").value;
      const storeIds = orgRole === "staff" ? checkedStoreIds("memberStoresRow") : [];
      $("memberSave").disabled = true;
      try {
        await G.api("/api/orgs/members/" + encodeURIComponent(managing.id), { method: "POST", body: { orgRole, storeIds } });
        UI.hideModal("memberModal");
        await load();
      } catch (e) { UI.setStatus("memberModalStatus", e.message, "err"); }
      $("memberSave").disabled = false;
    };
    $("memberRemove").onclick = async () => {
      const ok = await UI.confirmDialog(
        "Remove " + (managing.displayName || managing.username) + " from the organization? They keep their " +
        "account and can sign in, but lose access to every store until invited again.",
        { title: "Remove from organization?", danger: true, okLabel: "Remove" });
      if (!ok) return;
      $("memberRemove").disabled = true;
      try {
        await G.api("/api/orgs/members/" + encodeURIComponent(managing.id), { method: "POST", body: { remove: true } });
        UI.hideModal("memberModal");
        await load();
      } catch (e) { UI.setStatus("memberModalStatus", e.message, "err"); }
      $("memberRemove").disabled = false;
    };

    await load();
  });
})();
