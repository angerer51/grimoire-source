"use strict";
/* Customers page (#50, #62): a full-width table of the seller's customers
   (open / placed orders, wants, store credit); clicking a row opens that
   one's details, order history and wants in a slide-over panel on the right
   (UI.slideOver). A "Came in" tab lists every wanted card that came in and
   hasn't been told yet.
   All the logic (the matcher, order sync, consent rules) lives in core.js
   "Customers & wants"; this page only draws it and calls G.persist().
   Undo labels stay generic: they never carry a customer's name. */
(function () {
  const $ = UI.$;
  const esc = s => G.esc(s == null ? "" : String(s));

  let tab = "list";
  let selectedId = null;    // the customer in the slide-over, while it's open
  const panel = UI.slideOver("custPanel");
  let orders = [];          // the Manapool orders cache, for order history
  let editingId = null;     // customer modal: null = adding
  let wantPrintings = [];
  let wantExact = false;
  let detailRun = false;    // "Load their details" in progress
  let mergingId = null;     // Merge into… (#196): the customer being merged away
  // #139: customers.html?tab=came-in&match=<id> (a notification) marks that
  // "came in" row until the page is left.
  const focusMatch = new URLSearchParams(location.search).get("match");

  function fmtAgo(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));
  const customerById = id => G.state.customers.find(c => c.id === id);
  function untoldByCustomer() {
    const m = new Map();
    for (const x of G.untoldRestocks()) m.set(x.customerId, (m.get(x.customerId) || 0) + 1);
    return m;
  }

  let tabs;

  /* ---------------- Customers tab ---------------- */
  /* In-store credit doesn't exist yet (#31 is the ledger). The column is
     here so the owner sees where it will go; wire this up when it lands. */
  const storeCredit = () => null;

  function renderList() {
    const q = $("custSearch").value.trim().toLowerCase();
    const untold = untoldByCustomer();
    const list = G.state.customers
      .filter(c => !q || (c.name + " " + c.email + " " + c.note).toLowerCase().includes(q))
      .sort((a, b) => (untold.get(b.id) || 0) - (untold.get(a.id) || 0) || a.name.localeCompare(b.name));
    const body = $("custBody");
    $("custSpendNote").hidden = true;
    if (!list.length) {
      body.innerHTML = UI.emptyRow(6, G.state.customers.length
        ? { icon: "search", title: "No customer matches that search." }
        : { icon: "people", title: "No customers yet.",
            hint: "Press <b>Add customer</b>, or fetch orders on <a href=\"/lists.html\">Order Fulfillment</a> to bring in your Manapool buyers." });
      return;
    }
    // Built once per render, not once per customer: a few hundred Manapool
    // buyers against a 500-order cache.
    const byId = G.ordersById(orders);
    const refunds = G.refundsByOrder(G.state.returns, byId);
    const wantsBy = new Map();
    for (const w of G.state.customerWants) wantsBy.set(w.customerId, (wantsBy.get(w.customerId) || 0) + 1);
    const open = panel.isOpen();
    let anyPartial = false;
    body.innerHTML = list.map(c => {
      const n = untold.get(c.id) || 0;
      const h = G.customerOrders(c, byId, refunds);
      const credit = storeCredit(c);
      const spend = spendCell(h);
      if (spend.partial) anyPartial = true;
      return '<tr class="click' + (open && c.id === selectedId ? " sel" : "") + '" tabindex="0" data-id="' + esc(c.id) + '">' +
        '<td><div class="cust-name"><span class="cname">' + esc(c.name || "(no name)") + "</span>" +
          (c.source === "manapool" ? '<span class="ctag">Manapool</span>' : "") +
          (n ? '<span class="count" title="' + plural(n, "wanted card") + ' came in">' + n + "</span>" : "") +
        "</div></td>" +
        '<td class="num">' + h.open + "</td>" +
        '<td class="num hide-sm">' + h.count + "</td>" +
        spend.html +
        '<td class="num">' + (wantsBy.get(c.id) || 0) + "</td>" +
        '<td class="num hide-sm"' + (credit == null ? ' data-v=""><span class="faint">—</span>' : ' data-v="' + credit + '">' + G.money(credit)) + "</td>" +
        "</tr>";
    }).join("");
    $("custSpendNote").hidden = !anyPartial;
    UI.reapplySorts($("paneList"));
  }

  /* The Lifetime spend cell (#195): G.customerOrders' spend (paid incl.
     shipping, minus refunds), sortable on data-v. No orders at all (a
     customer added by hand) is a dash; orders that are all out of the
     cache say "not cached" rather than a $0 that looks real; some out of
     it get a "+" (at least this much), explained under the table. */
  function spendCell(h) {
    const missing = h.count - h.list.length;
    if (!h.count) return { html: '<td class="num" data-v=""><span class="faint">—</span></td>' };
    if (!h.list.length) {
      return { html: '<td class="num" data-v=""><span class="faint" title="' +
        esc(plural(h.count, "order") + " no longer in the orders cache") + '">not cached</span></td>' };
    }
    const tip = (h.refunds ? G.money(h.refunds) + " refunded taken off" +
        (h.mpRefunded ? " (" + plural(h.mpRefunded, "order") + " refunded on Manapool)" : "") + ". " : "") +
      (missing ? "At least: " + plural(missing, "older order") + " no longer in the orders cache." : "");
    return {
      partial: missing > 0,
      html: '<td class="num" data-v="' + h.spend + '"' + (tip ? ' title="' + esc(tip) + '"' : "") + ">" +
        G.money(h.spend) + (missing ? '<span class="faint" aria-label="or more">+</span>' : "") + "</td>"
    };
  }

  /* Highlight the open customer's row without redrawing the table (which
     would drop the user's column sort back to the default order). */
  function markSelectedRow() {
    const open = panel.isOpen();
    $("custBody").querySelectorAll("tr[data-id]").forEach(tr => {
      tr.classList.toggle("sel", open && tr.dataset.id === selectedId);
    });
  }
  const rowFor = id => [...$("custBody").querySelectorAll("tr[data-id]")].find(tr => tr.dataset.id === id);

  function openCustomer(id) {
    if (!customerById(id)) return;
    selectedId = id;
    renderDetail();
    panel.open();
    markSelectedRow();
  }
  // Closing (X, Esc, outside click, or the customer being deleted). The row
  // that opened the panel may have been redrawn since, so focus goes back to
  // its current copy; hideModal() then refocuses the original opener (Add
  // customer, say) if that is still on the page.
  function onPanelClosed() {
    const id = selectedId;
    selectedId = null;
    markSelectedRow();
    const tr = id && rowFor(id);
    try { (tr || $("custSearch")).focus(); } catch (e) {}
  }

  function renderDetail() {
    const c = customerById(selectedId);
    const box = $("custDetail");
    if (!c) {
      box.innerHTML = "";
      if (panel.isOpen()) panel.close();
      return;
    }
    // A save redraws the panel, which destroys the button that had focus;
    // put focus on the heading so it doesn't fall out to the page behind.
    const hadFocus = box.contains(document.activeElement);
    const contact = c.email
      ? esc(c.email) + " · " + (c.emailOk ? '<span class="pos">' + UI.icon("check") + " OK to email</span>"
        : '<span class="muted">not agreed to email</span>')
      : '<span class="faint">No email</span>';
    const hist = G.customerOrders(c, orders);
    const ordersHtml = !hist.count ? "" :
      '<div class="sec-head" style="margin-top:18px"><h3>Orders</h3><span class="muted">' +
        plural(hist.count, "order") + (hist.list.length ? " · " + G.money(hist.spend) + " spent" +
        (hist.refunds ? " after " + G.money(hist.refunds) + " in refunds" +
          (hist.mpRefunded ? " (" + plural(hist.mpRefunded, "order") + " refunded on Manapool count $0)" : "") : "") +
        (hist.list.length < hist.count ? " in the " + hist.list.length + " still cached" : "") : "") + "</span></div>" +
      (hist.list.length ? '<div class="feed">' + hist.list.map(o =>
        '<div class="feed-row"><span class="ftime">' + esc(String(o.placedAt).slice(0, 10)) + "</span>" +
        '<span class="ftext"><a href="/lists.html?order=' + encodeURIComponent(o.id) + '">' +
          esc(o.label || "Order " + o.id.slice(0, 8)) + "</a> · " + esc(o.status) +
          (o.weak ? ' <span class="faint" title="Linked by the recipient name, not Manapool\'s buyer id">(matched by name)</span>' : "") +
          (o.mpRefunded ? ' <span class="muted">· refunded on Manapool, counts $0</span>'
            : o.refund ? ' <span class="muted">· ' + G.money(o.refund) + " refunded</span>" : "") +
        "</span>" +
        '<span class="fnum">' + (o.total == null ? "" : G.money(o.total)) + "</span></div>").join("") + "</div>"
        : '<div class="hint">These orders are no longer in the orders cache.</div>');

    const wants = G.state.customerWants.filter(w => w.customerId === c.id);
    const untold = new Map(G.untoldRestocks().filter(m => m.customerId === c.id).map(m => [m.wantId, m]));
    const wantsHtml = !wants.length
      ? UI.emptyBlock({ icon: "cards", title: "No wants yet.", hint: "Press <b>Add want</b> for a card they're after." })
      : wants.map(w => {
        const m = untold.get(w.id);
        const now = G.wantAvailableNow(w);
        return '<div class="want-row">' +
          '<div class="form-row" style="align-items:center;gap:10px">' +
            "<b>" + UI.cardLink(w) + "</b>" +
            '<span class="muted">' + esc(G.wantLabel(w)) + "</span>" +
            '<span class="spacer"></span>' +
            '<span class="faint mono" style="font-size:12px">' + now + " in stock now</span>" +
            '<button class="small ghost" data-del-want="' + esc(w.id) + '" title="Remove want" aria-label="Remove want">' +
              UI.icon("trash-2") + "</button>" +
          "</div>" +
          (w.note ? '<div class="muted" style="font-size:12.5px">“' + esc(w.note) + "”</div>" : "") +
          (m ? '<div class="want-came">' + UI.icon("bell") + " CAME IN · " + m.available + " available · " +
            esc(fmtAgo(m.ts)) + ' <button class="small primary" data-told="' + esc(m.id) + '">Mark as told</button></div>' : "") +
          "</div>";
      }).join("");

    box.innerHTML =
      '<div class="sec-head"><h2 id="cdName" tabindex="-1">' + esc(c.name || "(no name)") + "</h2>" +
        '<div class="toolbar"><button class="small" id="cdEdit">' + UI.icon("pencil-line") + " Edit</button>" +
        (G.state.customers.length > 1 ? '<button class="small" id="cdMerge">' + UI.icon("merge") + " Merge into…</button>" : "") +
        '<button class="small danger" id="cdDelete">' + UI.icon("trash-2") + " Delete</button></div></div>" +
      '<div style="font-size:13px">' + contact + "</div>" +
      (c.source === "manapool" ? '<div class="faint" style="font-size:12px;margin-top:4px">Added from Manapool orders. ' +
        "The shipping address stays with the order.</div>" : "") +
      (c.note ? '<div class="muted" style="margin-top:6px">' + esc(c.note) + "</div>" : "") +
      ordersHtml +
      '<div class="sec-head" style="margin-top:18px"><h3>Wants (' + wants.length + ")</h3>" +
        '<button class="small" id="cdAddWant">' + UI.icon("plus") + " Add want</button></div>" +
      wantsHtml;

    $("cdEdit").onclick = () => openCustomerModal(c);
    $("cdDelete").onclick = () => deleteCustomer(c);
    if ($("cdMerge")) $("cdMerge").onclick = () => openMergePicker(c);
    $("cdAddWant").onclick = () => openWantModal();
    box.querySelectorAll("[data-told]").forEach(b => { b.onclick = () => markTold(b.dataset.told); });
    box.querySelectorAll("[data-del-want]").forEach(b => { b.onclick = () => deleteWant(b.dataset.delWant); });
    if (hadFocus && !box.contains(document.activeElement)) { try { $("cdName").focus(); } catch (e) {} }
  }

  /* ---------------- Came in tab ---------------- */
  function renderCameIn() {
    const rows = G.untoldRestocks().slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    $("cameInBody").innerHTML = !rows.length
      ? UI.emptyRow(6, { icon: "generic", title: "Nothing new.", hint: "When a card a customer wants comes in, it shows here." })
      : rows.map(m => {
        const c = customerById(m.customerId);
        return "<tr" + (focusMatch && m.id === focusMatch ? ' class="sel" data-focus="1"' : "") + ">" +
          '<td><a href="#" data-open="' + esc(m.customerId) + '">' + esc(c ? c.name : "(deleted)") + "</a></td>" +
          "<td>" + UI.cardLink(m) + "</td>" +
          '<td class="hide-sm">' + esc(G.wantLabel(m)) + "</td>" +
          '<td class="num">' + m.available + "</td>" +
          '<td class="num hide-sm" data-v="' + (new Date(m.ts).getTime() || 0) + '">' + esc(fmtAgo(m.ts)) + "</td>" +
          '<td><button class="small primary" data-told="' + esc(m.id) + '">Mark as told</button></td>' +
          "</tr>";
      }).join("");
    $("cameInBody").querySelectorAll("[data-told]").forEach(b => { b.onclick = () => markTold(b.dataset.told); });
    $("cameInBody").querySelectorAll("[data-open]").forEach(a => {
      a.onclick = e => { e.preventDefault(); tabs.show("list"); openCustomer(a.dataset.open); };
    });
    const told = G.state.restockMatches.filter(m => m.toldAt)
      .sort((a, b) => String(b.toldAt).localeCompare(String(a.toldAt))).slice(0, 20);
    $("toldFeed").innerHTML = !told.length
      ? UI.emptyBlock({ icon: "generic", title: "No one told yet." })
      : told.map(m => {
        const c = customerById(m.customerId);
        return '<div class="feed-row"><span class="ftime">' + esc(fmtAgo(m.toldAt).replace(" ago", "")) + "</span>" +
          '<span class="ftext"><b>' + esc(c ? c.name : "(deleted)") + "</b> told about " + UI.cardLink(m) + "</span></div>";
      }).join("");
  }

  function renderGap() {
    const n = G.ordersNeedingDetail(orders).length;
    $("gapCallout").hidden = !n && !detailRun;
    $("gapHead").textContent = plural(n, "older order") + (n === 1 ? " isn't" : " aren't") + " linked to customers yet";
    $("gapLoad").disabled = detailRun;
  }

  /* Fetch the detail of every summary-only order through the single-order
     route (which also refreshes the server's cache), one at a time with a
     pause, so a few hundred orders never hammer Manapool. Then re-sync. */
  const DETAIL_GAP_MS = 700;
  async function loadOrderDetails() {
    if (detailRun) return;
    const todo = G.ordersNeedingDetail(orders);
    if (!todo.length) return;
    detailRun = true;
    renderGap();
    let done = 0, failed = 0, failedInARow = 0;
    for (const o of todo) {
      $("gapStatus").textContent = "Loading " + (done + 1) + " of " + todo.length + "…";
      try {
        const d = await G.api("/api/manapool/order/" + encodeURIComponent(o.id));
        const i = orders.findIndex(x => x.id === o.id);
        if (d && d.order && i >= 0) orders[i] = Object.assign({}, orders[i], d.order);
        failedInARow = 0;
      } catch (e) {
        failed++; failedInARow++;
        // Not connected, token revoked or rate-limited: every further call
        // would fail too, so stop instead of grinding through the rest. The
        // in-a-row cap covers upstream errors that arrive as a plain 502.
        if ([401, 403, 429, 501].includes(e.status) || failedInARow >= 3) { done++; break; }
      }
      done++;
      if (done % 25 === 0) syncFromOrders();
      if (done < todo.length) await G.sleep(DETAIL_GAP_MS);
    }
    detailRun = false;
    const r = syncFromOrders();
    const msg = "Loaded " + (done - failed) + " of " + todo.length + " order details" +
      (failed ? " (" + failed + " failed)" : "") + "; " + plural(r.created, "customer") + " added.";
    $("gapStatus").textContent = msg;
    UI.toast(msg, failed ? "err" : "ok");
    renderGap();
  }

  function render() {
    renderGap();
    const n = G.untoldRestocks().length;
    $("cameInCount").textContent = n;
    if (tab === "list") { renderList(); if (panel.isOpen()) renderDetail(); } else renderCameIn();
  }

  /* ---------------- Actions ---------------- */
  function markTold(id) {
    if (!G.markRestockTold(id)) return;
    G.persist("Mark customer told");
    UI.toast("Marked as told.", "ok");
  }

  async function deleteWant(id) {
    const ok = await UI.confirmDialog("Remove this want? Any \"came in\" note for it goes too.", { title: "Remove want?" });
    if (!ok) return;
    G.deleteWant(id);
    G.persist("Remove want");
  }

  async function deleteCustomer(c) {
    const ok = await UI.confirmDialog("Delete this customer, their wants and their \"came in\" notes?" +
      (c.source === "manapool" ? "\n\nThey won't be added back from their Manapool orders." : ""),
      { title: "Delete customer?", danger: true });
    if (!ok) return;
    G.deleteCustomer(c.id);
    selectedId = null;
    G.persist("Delete customer");
  }

  /* Merge into… (#196): this customer (the one open) goes into the one
     picked, which is kept. G.mergeCustomers does the work; the confirm
     says what moves where, since there is no unmerge. */
  function openMergePicker(c) {
    mergingId = c.id;
    $("mgIntro").textContent = "Pick the customer to keep. " + (c.name || "This customer") +
      "'s orders, wants and note move to them, and " + (c.name || "this customer") + " is removed.";
    $("mergeSearch").value = "";
    renderMergeList();
    UI.showModal("mergeModal", "mergeSearch");
  }
  function renderMergeList() {
    const q = $("mergeSearch").value.trim().toLowerCase();
    const others = G.state.customers.filter(c => c.id !== mergingId);
    const list = others
      .filter(c => !q || (c.name + " " + c.email + " " + c.note).toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) {
      $("mgBody").innerHTML = UI.emptyRow(3, others.length
        ? { icon: "search", title: "No customer matches that search." }
        : { icon: "people", title: "No other customers." });
      return;
    }
    const wantsBy = new Map();
    for (const w of G.state.customerWants) wantsBy.set(w.customerId, (wantsBy.get(w.customerId) || 0) + 1);
    const byId = G.ordersById(orders);
    const refunds = G.refundsByOrder(G.state.returns, byId);
    $("mgBody").innerHTML = list.map(c =>
      '<tr class="click" tabindex="0" data-into="' + esc(c.id) + '">' +
        '<td><div class="cust-name"><span class="cname">' + esc(c.name || "(no name)") + "</span>" +
          (c.source === "manapool" ? '<span class="ctag">Manapool</span>' : "") + "</div>" +
          '<div class="faint" style="font-size:12px">' + esc(mergeRowDetail(c, byId, refunds)) + "</div></td>" +
        '<td class="num">' + c.orderRefs.length + "</td>" +
        '<td class="num">' + (wantsBy.get(c.id) || 0) + "</td>" +
      "</tr>").join("");
  }
  /* The line under each picker row's name, so two customers with the same
     name can be told apart: their email, their latest cached order and
     what they've spent, or when a customer with no orders was added. */
  function mergeRowDetail(c, byId, refunds) {
    const h = G.customerOrders(c, byId, refunds);
    const bits = [c.email || "no email"];
    if (h.list.length) {
      bits.push("last order " + String(h.list[0].placedAt).slice(0, 10));
      bits.push(G.money(h.spend) + (h.list.length < h.count ? "+" : "") + " spent");
    } else if (h.count) {
      bits.push(plural(h.count, "order") + " (not cached)");
    } else {
      bits.push("no orders", "added " + String(c.createdAt).slice(0, 10));
    }
    return bits.join(" · ");
  }
  function mergeMessage(gone, keep) {
    const gn = gone.name || "(no name)", kn = keep.name || "(no name)";
    const nOrders = gone.orderRefs.length;
    const nWants = G.state.customerWants.filter(w => w.customerId === gone.id).length;
    const moves = [plural(nOrders, "order"), plural(nWants, "want"), "any \"came in\" notes"];
    if (gone.note.trim()) moves.push("their note (added after " + kn + "'s)");
    let keeps = kn + " keeps their own name";
    if (!keep.name && gone.name) keeps = kn + " takes the name " + gn;
    if (keep.email) keeps += " and email.";
    else if (gone.email) keeps += ", and takes the email " + gone.email + (gone.emailOk ? ", with its OK to email." : " (not agreed to email).");
    else keeps += ".";
    return gn + " will be combined into " + kn + ".\n\n" +
      "Moving to " + kn + ": " + moves.slice(0, -1).join(", ") + " and " + moves[moves.length - 1] + ". " +
      (gone.source === "manapool" || nOrders ? "Their future Manapool orders go to " + kn + " too. " : "") + keeps + "\n\n" +
      gn + " is then removed. There's no unmerge: Undo straight away is the only way back.";
  }
  async function pickMergeTarget(keepId) {
    const gone = customerById(mergingId), keep = customerById(keepId);
    UI.hideModal("mergeModal");
    if (!gone || !keep || gone === keep) return;
    const ok = await UI.confirmDialog(mergeMessage(gone, keep),
      { title: "Merge customers?", okLabel: "Merge", danger: true });
    mergingId = null;
    // Either may have gone while the dialog was up (a merged save from
    // another tab): merge only what is still there.
    if (!ok || !G.mergeCustomers(gone.id, keep.id)) return;
    selectedId = keep.id;
    G.persist("Merge customers");
    openCustomer(keep.id);
    UI.toast("Customers merged.", "ok");
  }

  function syncConsentBox() {
    const has = !!$("cmEmail").value.trim();
    $("cmEmailOk").disabled = !has;
    if (!has) $("cmEmailOk").checked = false;
  }
  function openCustomerModal(c) {
    editingId = c ? c.id : null;
    $("custModalTitle").textContent = c ? "Edit customer" : "Add customer";
    $("cmName").value = c ? c.name : "";
    $("cmEmail").value = c ? c.email : "";
    $("cmEmailOk").checked = !!(c && c.emailOk);
    $("cmNote").value = c ? c.note : "";
    $("cmMpHint").hidden = !(c && c.source === "manapool");
    UI.setStatus("cmStatus", "");
    syncConsentBox();
    UI.showModal("custModal", "cmName");
  }
  function saveCustomer() {
    const fields = { name: $("cmName").value.trim(), email: $("cmEmail").value.trim(),
      emailOk: $("cmEmailOk").checked, note: $("cmNote").value.trim() };
    if (!fields.name) { UI.setStatus("cmStatus", "Give them a name.", "err"); return; }
    if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
      UI.setStatus("cmStatus", "That doesn't look like an email address.", "err"); return;
    }
    const added = editingId ? null : G.addCustomer(fields).id;
    if (editingId) G.updateCustomer(editingId, fields);
    UI.hideModal("custModal");
    G.persist(editingId ? "Edit customer" : "Add customer");
    if (added) openCustomer(added);   // straight to the new customer, to add their wants
  }

  function setWantMode(exact) {
    wantExact = exact;
    $("wmAny").classList.toggle("active", !exact);
    $("wmExact").classList.toggle("active", exact);
    $("wmPrintRow").hidden = !exact;
    if (exact && $("wmName").value.trim() && !wantPrintings.length) loadWantPrintings($("wmName").value.trim());
  }
  async function loadWantPrintings(name) {
    wantPrintings = await UI.loadPrintingSelect("wmPrint", name);
  }
  function openWantModal() {
    wantPrintings = [];
    $("wmName").value = "";
    $("wmNote").value = "";
    $("wmFinish").value = "nonfoil";
    $("wmPrint").innerHTML = '<option value="">— pick a card first —</option>';
    setWantMode(false);
    UI.setStatus("wmStatus", "");
    UI.showModal("wantModal", "wmName");
  }
  function saveWant() {
    const name = $("wmName").value.trim();
    if (!name) { UI.setStatus("wmStatus", "Type a card name.", "err"); return; }
    let fields = { name, note: $("wmNote").value.trim() };
    if (wantExact) {
      const p = wantPrintings[parseInt($("wmPrint").value, 10)];
      if (!p) { UI.setStatus("wmStatus", "Pick the printing, or switch to Any printing.", "err"); return; }
      fields = Object.assign(fields, { name: p.name || name, set: p.set, collector: p.collector,
        lang: p.lang || "en", finish: $("wmFinish").value, setName: p.setName || "" });
    }
    if (!G.addWant(selectedId, fields)) { UI.setStatus("wmStatus", "Could not add that want.", "err"); return; }
    UI.hideModal("wantModal");
    G.persist("Add want");
  }

  /* Every Manapool buyer becomes a customer, from whatever orders Grimoire
     has cached. Order Fulfillment's Fetch orders does the same as new ones
     arrive. */
  async function loadOrders() {
    try {
      const d = await G.api("/api/manapool/orders/cached");
      orders = (d && d.orders) || [];
    } catch (e) { orders = []; }
    const r = syncFromOrders();
    if (r.created) UI.toast("Added " + plural(r.created, "customer") + " from your Manapool orders.", "ok");
  }
  function syncFromOrders() {
    const r = G.syncCustomersFromOrders(orders);
    if (r.created || r.linked) G.persist("Customers from orders");
    else render();
    return r;
  }

  UI.boot(async function () {
    $("gapLoad").onclick = loadOrderDetails;
    $("custSearch").addEventListener("input", renderList);
    // Rows are redrawn on every change, so listen once on the tbody.
    const rowOf = e => e.target && e.target.closest ? e.target.closest("tr[data-id]") : null;
    $("custBody").addEventListener("click", e => { const tr = rowOf(e); if (tr) openCustomer(tr.dataset.id); });
    $("custBody").addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = rowOf(e);
      if (!tr || e.target !== tr) return;
      e.preventDefault();
      openCustomer(tr.dataset.id);
    });
    UI.onClose("custPanel", onPanelClosed);
    $("mergeSearch").addEventListener("input", renderMergeList);
    $("mgCancel").onclick = () => UI.hideModal("mergeModal");
    const intoOf = e => e.target && e.target.closest ? e.target.closest("tr[data-into]") : null;
    $("mgBody").addEventListener("click", e => { const tr = intoOf(e); if (tr) pickMergeTarget(tr.dataset.into); });
    $("mgBody").addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = intoOf(e);
      if (!tr || e.target !== tr) return;
      e.preventDefault();
      pickMergeTarget(tr.dataset.into);
    });
    $("custAdd").onclick = () => openCustomerModal(null);
    $("cmEmail").addEventListener("input", syncConsentBox);
    $("cmCancel").onclick = () => UI.hideModal("custModal");
    $("cmSave").onclick = saveCustomer;
    $("wmAny").onclick = () => setWantMode(false);
    $("wmExact").onclick = () => setWantMode(true);
    $("wmCancel").onclick = () => UI.hideModal("wantModal");
    $("wmSave").onclick = saveWant;
    UI.Autocomplete("wmName", "wmAcList", name => {
      wantPrintings = [];
      if (wantExact) loadWantPrintings(name);
      else $("wmNote").focus();
    });
    $("wmName").addEventListener("input", () => { wantPrintings = []; });

    G.on("change", render);
    const want = new URLSearchParams(location.search).get("tab");
    // The tab is remembered (UI.pageTabs); ?tab=came-in (a notification) wins over it.
    tabs = UI.pageTabs({ tabs: [
      { id: "list", button: "tabList", panes: ["paneList"] },
      { id: "came-in", button: "tabCameIn", panes: ["paneCameIn"] }
    ], onShow: t => { tab = t; render(); } });
    if (want === "came-in") tabs.show("came-in");
    if (want === "came-in" && focusMatch) {
      const row = $("cameInBody").querySelector("tr[data-focus]");
      if (row) { try { row.scrollIntoView({ block: "center" }); } catch (e) {} }
      else UI.toast("That card has already been marked as told, or its customer was removed.", "work");
    }
    // customers.html?id=<customer id>: a customer named elsewhere (a walk-in order, #431) opens here.
    const deepId = new URLSearchParams(location.search).get("id");
    if (deepId && want !== "came-in") openCustomer(deepId);
    loadOrders();
  });
})();
