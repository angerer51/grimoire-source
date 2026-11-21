"use strict";
(function () {
  const $ = UI.$;

  /* Order Entry → Walk-in Order (#431, part 1 of #402). Staff build an order
     for a customer at the counter from what's in stock, each line at the
     card's market price (editable), then either send it to Order Fulfillment
     as a Walk-in ticket or finish it on the spot with the payment. All the
     stock and money logic is core.js's (enterWalkInOrder and friends), so a
     counter sale and a Manapool order agree on what's free to sell. */

  let draft = [];          // the order being built: { key, name, set, collector, lang, finish, condition, imageUrl, qty, unitPrice, marketPrice }
  let mode = "pick";       // "pick" (send to be picked) or "now" (finish now)
  let found = { rows: [], more: false };

  const condName = c => G.CONDITION_NAMES[c] || c;
  const setCode = s => '<span class="mono">' + G.esc(String(s || "").toUpperCase()) + "</span>";
  const none = '<span class="faint">—</span>';
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const lineTotal = l => (l.unitPrice === "" || l.unitPrice == null || !isFinite(Number(l.unitPrice)) ? null : G.round2(Number(l.unitPrice) * l.qty));

  /* ---------- Find cards ---------- */
  function renderFind() {
    const q = $("wiSearch").value.trim();
    const body = $("wiFindBody");
    found = q ? G.counterFindCards(q, draft) : { rows: [], more: false };
    const n = found.rows.length;
    $("wiFindHdr").textContent = !q ? "" : found.more ? "first " + n + " matches" : n + (n === 1 ? " match" : " matches");
    if (!q) {
      body.innerHTML = UI.emptyRow(10, { icon: "search", title: "Search your stock to start an order.",
        hint: "Type a card name, set code or collector number." });
      return;
    }
    if (!found.rows.length) {
      body.innerHTML = UI.emptyRow(10, { icon: "search", title: "No card in stock matches “" + G.esc(q) + "”.",
        hint: "Only locations marked <b>Sell from this location</b> are searched." });
      return;
    }
    body.innerHTML = "";
    found.rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const held = r.onHand - r.free;
      tr.innerHTML = UI.artThumbTd(r.imageUrl) +
        "<td>" + UI.cardLink(r) + "</td>" +
        '<td class="hide-sm">' + setCode(r.set) + "</td>" +
        '<td class="hide-sm mono">' + G.esc(r.collector) + "</td>" +
        '<td class="mono" title="' + G.esc(condName(r.condition)) + '">' + G.esc(r.condition) + "</td>" +
        "<td>" + UI.finishBadge(r.finish) + "</td>" +
        '<td class="hide-sm mono">' + G.esc(String(r.lang || "en").toUpperCase()) + "</td>" +
        '<td class="num" data-v="' + r.free + '"' + (held > 0 ? ' title="' + r.onHand + " on hand, " + held +
          ' set aside for other orders, lent out or on this order"' : "") + ">" + r.free + "</td>" +
        '<td class="num" data-v="' + (r.price == null ? -1 : r.price) + '">' + (r.price == null ? none : G.money(r.price)) + "</td>" +
        '<td><button class="small wiAdd"' + (r.free > 0 ? ' title="Add one copy to the order"'
          : ' disabled title="None free to sell: every copy is set aside for another order, lent out or already on this order"') +
          ">" + UI.icon("plus") + " Add</button></td>";
      tr.querySelector(".wiAdd").onclick = () => addLine(found.rows[i]);
      UI.wireArtHover(tr, r.imageUrl);
      body.appendChild(tr);
    });
    UI.reapplySorts();
  }

  function addLine(r) {
    if (!r || r.free <= 0) return;
    const ex = draft.find(l => l.key === r.key);
    if (ex) ex.qty += 1;
    else {
      draft.push({ key: r.key, name: r.name, set: r.set, collector: r.collector, lang: r.lang, finish: r.finish,
        condition: r.condition, imageUrl: r.imageUrl, qty: 1, marketPrice: r.price,
        unitPrice: r.price == null ? "" : r.price });
    }
    renderAll();
  }

  /* ---------- This order ---------- */
  function orderTotal() {
    return G.round2(draft.reduce((s, l) => s + (lineTotal(l) || 0), 0));
  }
  function renderLines() {
    const body = $("wiLinesBody");
    const cards = draft.reduce((s, l) => s + l.qty, 0);
    $("wiOrderHdr").textContent = draft.length ? plural(cards, "card") + " · " + plural(draft.length, "line") : "";
    if (!draft.length) {
      body.innerHTML = UI.emptyRow(8, { icon: "orders", title: "Nothing on this order yet.",
        hint: "Find a card, then press <b>Add</b>." });
      $("wiLinesFoot").innerHTML = "";
      return;
    }
    body.innerHTML = "";
    draft.forEach(l => {
      const tr = document.createElement("tr");
      const noPrice = l.marketPrice == null;
      tr.innerHTML =
        "<td>" + UI.cardLink(l) + "</td>" +
        '<td class="hide-sm">' + setCode(l.set) + ' <span class="mono faint">#' + G.esc(l.collector) + "</span></td>" +
        '<td class="mono" title="' + G.esc(condName(l.condition)) + '">' + G.esc(l.condition) + "</td>" +
        '<td class="hide-sm">' + UI.finishBadge(l.finish) + "</td>" +
        '<td class="num"><input class="wi-qty" type="number" min="1" step="1" value="' + l.qty + '" aria-label="Quantity of ' + G.esc(l.name) + '"></td>' +
        '<td class="num"><input class="wi-price" type="number" min="0" step="0.01" value="' + G.esc(l.unitPrice) + '"' +
          (noPrice ? ' placeholder="Price" title="No market price for this card: type what it sells for"'
            : ' title="Market price ' + G.esc(G.money(l.marketPrice)) + '"') +
          ' aria-label="Price each for ' + G.esc(l.name) + '"></td>' +
        '<td class="num wi-line-total">' + (lineTotal(l) == null ? none : G.money(lineTotal(l))) + "</td>" +
        '<td><button class="small ghost wiRemove" title="Remove from the order" aria-label="Remove from the order">' + UI.icon("x") + "</button></td>";
      const qty = tr.querySelector(".wi-qty"), price = tr.querySelector(".wi-price");
      qty.onchange = () => {
        const n = Math.max(1, parseInt(qty.value, 10) || 1);
        l.qty = n;
        renderAll();
      };
      // Typing a price only updates its own line total and the order total, so the box keeps focus.
      price.oninput = () => {
        l.unitPrice = price.value;
        tr.querySelector(".wi-line-total").innerHTML = lineTotal(l) == null ? none : G.money(lineTotal(l));
        renderFoot();
      };
      tr.querySelector(".wiRemove").onclick = () => {
        draft = draft.filter(x => x !== l);
        renderAll();
      };
      body.appendChild(tr);
    });
    renderFoot();
  }
  function renderFoot() {
    const missing = draft.filter(l => lineTotal(l) == null).length;
    // One cell per column (no colspan), so the total stays under Line total when the phone hides columns.
    $("wiLinesFoot").innerHTML = draft.length
      ? "<tr><td>Total" + (missing ? ' <span class="muted">(' + plural(missing, "line") + " without a price)</span>" : "") +
        '</td><td class="hide-sm"></td><td></td><td class="hide-sm"></td><td></td><td></td><td class="num">' + G.money(orderTotal()) + "</td><td></td></tr>"
      : "";
  }

  /* Customer: optional. A name that matches one in Customers is that
     customer; a new name is added to Customers when the order goes in; blank
     is an anonymous walk-in. */
  const customerByName = name => {
    const k = String(name || "").trim().toLowerCase();
    return k ? G.state.customers.find(c => String(c.name || "").trim().toLowerCase() === k) || null : null;
  };
  const CUSTOMER_LIST_MAX = 2000;
  function fillCustomerList() {
    const names = [...new Set(G.state.customers.map(c => String(c.name || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)).slice(0, CUSTOMER_LIST_MAX);
    $("wiCustomerList").innerHTML = names.map(n => '<option value="' + G.esc(n) + '">').join("");
  }
  function renderCustomer() {
    const name = $("wiCustomer").value.trim();
    const known = customerByName(name);
    $("wiEmailWrap").hidden = !name || !!known;
    $("wiCustomerHint").textContent = !name ? "No name: the sale is recorded as an anonymous walk-in."
      : known ? "One of your customers."
        : "New customer: added to Customers when the order goes in.";
  }

  function setMode(m) {
    mode = m;
    $("wiModePick").classList.toggle("active", m === "pick");
    $("wiModeNow").classList.toggle("active", m === "now");
    $("wiModePick").setAttribute("aria-pressed", m === "pick" ? "true" : "false");
    $("wiModeNow").setAttribute("aria-pressed", m === "now" ? "true" : "false");
    $("wiPayWrap").hidden = m !== "now";
    $("wiModeHint").textContent = m === "now"
      ? "The cards are already in hand: they come off stock now and the sale is recorded."
      : "A Walk-in ticket goes to Order Fulfillment to be picked; it's paid when handed over.";
    $("wiSubmit").textContent = m === "now" ? "Finish sale" : "Send to be picked";
  }

  /* ---------- Waiting counter orders: walk-ins sent to be picked, and kiosk orders (#433) ---------- */
  function renderWaiting() {
    const list = G.pickLists().filter(p => G.isCounterSale(p) && p.status !== "shipped")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    $("wiWaitHdr").textContent = list.length ? String(list.length) : "";
    $("wiWaitCount").textContent = list.length || "";
    $("wiWaitCount").hidden = !list.length;
    const body = $("wiWaitBody");
    if (!list.length) {
      body.innerHTML = UI.emptyRow(6, { icon: "orders", title: "No counter orders waiting.",
        hint: "Walk-in orders sent to be picked, and orders sent from the kiosk, show here until they're handed over." });
      return;
    }
    body.innerHTML = list.map(p => {
      const cards = p.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
      const total = G.counterSaleTotal(p);
      const cust = p.customer && p.customer.id && G.state.customers.some(c => c.id === p.customer.id)
        ? '<a href="/customers.html?id=' + encodeURIComponent(p.customer.id) + '">' + G.esc(p.customer.name) + "</a>"
        : G.esc(G.counterSaleName(p));
      const when = Date.parse(p.createdAt);
      return "<tr>" +
        '<td data-vs="' + G.esc(p.id) + '"><a class="mono" href="/lists.html?pick=' + encodeURIComponent(p.id) + '">' + G.esc(p.id) + "</a></td>" +
        '<td data-vs="' + G.esc(G.counterSaleName(p)) + '">' + cust + "</td>" +
        '<td class="hide-sm" data-v="' + (isNaN(when) ? 0 : when) + '">' + (isNaN(when) ? none : G.esc(new Date(when).toLocaleString())) + "</td>" +
        '<td class="num">' + cards + "</td>" +
        '<td class="num" data-v="' + total + '">' + G.money(total) + "</td>" +
        '<td><span class="pill' + (p.status === "picked" ? " type" : "") + '">' + (p.status === "picked" ? "ready to hand over" : "to pick") + "</span>" +
          (G.pickListIsShort(p) ? ' <span class="short-tag">short</span>' : "") + "</td></tr>";
    }).join("");
    UI.reapplySorts();
  }

  function renderAll() {
    renderLines();
    renderFind();
    renderWaiting();
    $("wiSubmit").disabled = !draft.length;
    $("wiSubmit").title = draft.length ? "" : "Add a card to the order first";
    $("wiClear").disabled = !draft.length;
  }

  /* ---------- Enter the order ---------- */
  async function submit() {
    if (!draft.length) return;
    const btn = $("wiSubmit");
    const payment = $("wiPay").value;
    if (mode === "now" && !payment) { UI.setStatus("wiStatus", "Choose how they paid.", "err"); $("wiPay").focus(); return; }
    btn.disabled = true;
    try {
      // What's free depends on the floor too (#395): no answer, no sale.
      if (!(await G.catchUp(btn)).ok) {
        UI.toast("Couldn't reach the server to check for cards picked on another device, so the order wasn't entered. " +
          "Check the connection and try again.", "err");
        return;
      }
      // An online order fetched since the page opened holds its copies too (#433).
      try { await G.loadFetchedOrders(); } catch (e) { /* the ones already loaded still count */ }
      const name = $("wiCustomer").value.trim();
      const known = customerByName(name);
      const out = G.enterWalkInOrder({
        lines: draft.map(l => ({ set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
          name: l.name, qty: l.qty, unitPrice: l.unitPrice, marketPrice: l.marketPrice })),
        customer: name ? { id: known ? known.id : "", name: known ? known.name : name } : null,
        mode, payment
      });
      if (!out.ok) { UI.setStatus("wiStatus", out.error, "err"); renderFind(); return; }
      const p = out.pickList;
      if (name && !known) {
        const c = G.addCustomer({ name, email: $("wiEmail").value.trim() });
        p.customer.id = c.id;
      }
      G.persist(mode === "now" ? "Walk-in sale " + p.id : "Walk-in order " + p.id);
      draft = [];
      $("wiCustomer").value = "";
      $("wiEmail").value = "";
      $("wiPay").value = "";
      $("wiSearch").value = "";
      fillCustomerList();
      renderCustomer();
      UI.setStatus("wiStatus", "");
      renderAll();
      UI.toast(mode === "now"
        ? "Sold " + G.money(p.payment ? p.payment.total : 0) + " to " + G.counterSaleName(p) + ", paid by " +
          G.PAY_METHOD_NAMES[payment].toLowerCase() + ". Undo reverses it."
        : p.id + " sent to Order Fulfillment to be picked.", "ok");
      $("wiSearch").focus();
      // The order is in: Manapool's listings follow (#432) while staff carry on.
      const sync = await G.orderEntryListingSync("entered", p);
      for (const w of (sync && sync.warnings) || []) UI.toast(w, "err");
    } finally {
      btn.disabled = !draft.length;
    }
  }

  async function clearOrder() {
    if (!draft.length) return;
    const ok = await UI.confirmDialog("Clear the " + plural(draft.length, "line") + " on this order? Nothing has been sold or set aside yet.",
      { title: "Clear this order?", okLabel: "Clear order" });
    if (!ok) return;
    draft = [];
    UI.setStatus("wiStatus", "");
    renderAll();
  }

  /* ---------- Wire up ---------- */
  UI.boot(async function () {
    $("wiPay").innerHTML = '<option value="">Choose…</option>' +
      G.PAY_METHODS.map(m => '<option value="' + m + '">' + G.esc(G.PAY_METHOD_NAMES[m]) + "</option>").join("");
    $("wiSearch").addEventListener("input", G.debounce(renderFind, 150));
    $("wiSearch").addEventListener("keydown", e => {
      // Enter adds the only match, so a scanned or typed exact search is one key.
      if (e.key === "Enter" && found.rows.length === 1) { e.preventDefault(); addLine(found.rows[0]); }
    });
    $("wiCustomer").addEventListener("input", renderCustomer);
    $("wiModePick").onclick = () => setMode("pick");
    $("wiModeNow").onclick = () => setMode("now");
    $("wiSubmit").onclick = submit;
    $("wiClear").onclick = clearOrder;
    G.on("change", () => { renderFind(); renderWaiting(); });
    fillCustomerList();
    renderCustomer();
    setMode("pick");
    renderAll();
    // The tab is remembered (UI.pageTabs).
    UI.pageTabs({ tabs: [
      { id: "new", button: "tabNewOrder", panes: ["paneNewOrder"] },
      { id: "waiting", button: "tabWaiting", panes: ["paneWaiting"] }
    ] });
    // Fetched Manapool orders not on a ticket yet still claim their copies
    // (counterFree): the store's fetched ones, whoever fetched them (#433),
    // no Manapool call. None fetched or unreachable: only tickets count.
    try { await G.loadFetchedOrders(); renderFind(); } catch (e) { /* tickets only */ }
  });
})();
