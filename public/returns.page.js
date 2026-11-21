
"use strict";
(function () {
  const $ = UI.$;
  let printings = [];
  let printingGroups = []; // deduped by set+collector, same idiom as receive.page.js
  let preview = null;
  let lines = [];   // this return's draft lines - page-local only, not persisted (a return is a short, one-sitting task)
  let lineSeq = 0;
  let orders = [];        // this account's cached Manapool orders (server-side cache, GET /api/manapool/orders/cached)
  let selectedOrder = null; // the matched order, if the user picked one from the search below rather than typing free text

  // One dropdown entry per (set, collector) - see receive.page.js's own copy of this for why.
  function groupPrintings(list) {
    const map = new Map();
    for (const c of list) {
      const key = c.set + "|" + G.normNum(c.collector);
      let g = map.get(key);
      if (!g) { g = { set: c.set, collector: c.collector, setName: c.setName, cards: [] }; map.set(key, g); }
      g.cards.push(c);
    }
    return [...map.values()];
  }

  async function loadPrintings(name) {
    const sel = $("inPrinting");
    sel.innerHTML = '<option value="">Loading…</option>';
    preview.bump();
    preview.message("Loading…");
    UI.setStatus("entryStatus", 'Loading printings for "' + name + '" …', "work");
    try {
      printings = await G.cards.printings(name);
      if (!printings.length) throw new Error("No printings found for that name.");
      printingGroups = groupPrintings(printings);
      sel.innerHTML = printingGroups.map((g, i) =>
        '<option value="' + i + '">' + G.esc(G.printingLabel(g.set, g.collector, g.setName)) + "</option>").join("");
      sel.value = "0";
      showPicked();
      UI.setStatus("entryStatus", "Loaded " + printingGroups.length + " printing" + (printingGroups.length === 1 ? "" : "s") +
        " — pick the one that came back, then Add.", "ok");
    } catch (e) {
      sel.innerHTML = '<option value="">— none found —</option>';
      printings = []; printingGroups = [];
      preview.clear();
      UI.setStatus("entryStatus", "✗ " + e.message, "err");
    }
  }

  function currentPicked() {
    const g = printingGroups[parseInt($("inPrinting").value, 10)];
    if (!g) return null;
    const lang = $("inLang").value || "en";
    return g.cards.find(c => (c.lang || "en") === lang) || null;
  }

  function showPicked() {
    const g = printingGroups[parseInt($("inPrinting").value, 10)];
    const c = currentPicked();
    if (!c) {
      if (g) {
        const langs = [...new Set(g.cards.map(x => G.LANG_NAMES[x.lang || "en"] || x.lang))].join(", ");
        preview.message("Not printed in " + (G.LANG_NAMES[$("inLang").value] || $("inLang").value) +
          " — this printing is available in: " + langs + ".");
      } else {
        preview.clear();
      }
      return;
    }
    const finish = $("inFoil").value;
    preview.showCard(c, finish, "", { qty: qty(), putaway: false });
  }

  const qty = () => Math.max(1, parseInt($("inQty").value, 10) || 1);

  function addLine() {
    const picked = currentPicked();
    if (!picked) {
      UI.setStatus("entryStatus", "Search for a card and pick a printing (in the language it actually is) first.", "err");
      return;
    }
    const unitCostRaw = $("inUnitCost").value.trim();
    const unitCost = unitCostRaw === "" ? null : Math.max(0, parseFloat(unitCostRaw) || 0);
    lines.push({
      jid: "l" + (++lineSeq),
      set: picked.set, collector: picked.collector, setName: picked.setName,
      name: G.cardName(picked), lang: picked.lang || "en",
      finish: $("inFoil").value, condition: $("inCondition").value,
      qty: qty(), tcgplayerId: picked.tcgplayerId || "", scryfallId: picked.id || "", rarity: picked.rarity || "",
      market: G.priceOf(picked, $("inFoil").value), meta: G.pickMeta(picked),
      imageUrl: picked.imageUrl || "",
      unitCost
    });
    renderLines();
    UI.setStatus("entryStatus", "Added " + qty() + "× " + G.cardName(picked) + " to this return.", "ok");
    $("inSearch").value = ""; $("inPrinting").innerHTML = '<option value="">— pick a card first —</option>';
    printings = []; printingGroups = []; $("inQty").value = "1"; $("inUnitCost").value = "";
    preview.clear();
    $("inSearch").focus();
  }

  function removeLine(jid) {
    lines = lines.filter(l => l.jid !== jid);
    renderLines();
  }

  // Same "look the printing back up and open the read-only modal" idiom as
  // receive.page.js's own staged-lines table - the persistent preview aside
  // above only ever shows the card currently being picked, not any of these
  // already-added lines.
  async function reviewLine(l) {
    if (!l || !l.set || !l.collector) return;
    let card;
    try { card = await G.cards.one(l.set, l.collector, l.lang || "en"); }
    catch (e) { return; }
    if (card) UI.reviewCard(card, l.finish);
  }

  function renderLines() {
    const body = $("retLinesBody");
    if (!lines.length) {
      body.innerHTML = UI.emptyRow(7, { icon: "cards", title: "Nothing added yet.", hint: "Find a card on the left." });
    } else {
      body.innerHTML = "";
      for (const l of lines) {
        const tr = document.createElement("tr");
        tr.className = "click";
        tr.innerHTML =
          UI.artThumbTd(l.imageUrl) +
          '<td class="card-name">' + UI.cardLink(l) + "</td>" +
          "<td>" + G.esc(G.printingLabel(l.set, l.collector, l.setName)) + "</td>" +
          "<td>" + (l.finish !== "nonfoil" ? '<span class="badge ' + l.finish + '">' + G.esc(G.FINISH_NAMES[l.finish].toUpperCase()) + "</span>" : '<span class="muted">—</span>') + "</td>" +
          '<td class="num">' + l.qty + "</td>" +
          '<td class="num">' + (l.unitCost == null ? '<span class="muted">—</span>' : G.money(l.unitCost)) + "</td>";
        const td = document.createElement("td");
        td.innerHTML = '<button class="small ghost">✕</button>';
        td.querySelector("button").title = "Remove this line";
        td.querySelector("button").setAttribute("aria-label", "Remove this line");
        td.querySelector("button").onclick = e => { e.stopPropagation(); removeLine(l.jid); };
        tr.appendChild(td);
        UI.wireArtHover(tr, l.imageUrl);
        tr.onclick = e => { if (e.target.closest("button")) return; reviewLine(l); };
        body.appendChild(tr);
      }
    }
    UI.reapplySorts();
  }

  /* Puts every line back into inventory (same G.addCopies() lot receipts use),
     then records the return doc - see core.js's recordReturn for why the
     split. */
  async function postReturn() {
    if (!lines.length) { UI.toast("Add at least one card first.", "err"); return; }
    const locationId = $("retLoc").value;
    if (!locationId || !G.locById(locationId)) { UI.toast("Choose where the return goes.", "err"); return; }
    const returnId = $("retId").value.trim() || G.nextReturnId();
    if (G.state.returns.some(r => r.returnId === returnId)) {
      UI.toast('A return numbered "' + returnId + '" already exists — give this one a different ID.', "err");
      return;
    }
    const orderLabel = $("retOrderLabel").value.trim();
    const buyer = $("retBuyer").value.trim();
    const disposition = $("retDisposition").value;
    const reason = $("retReason").value.trim();
    const note = $("retNote").value.trim();
    const refundRaw = $("retRefund").value.trim();
    const refundTotal = refundRaw === "" ? null : Math.max(0, parseFloat(refundRaw) || 0);
    const cards = lines.reduce((s, l) => s + l.qty, 0);
    // A written-off return (damaged/other) still goes into the bin, but with
    // no cost basis: a later sale would otherwise charge its cost twice.
    const restoresCost = G.returnRestoresCost(disposition);
    const costIgnored = !restoresCost && lines.some(l => l.unitCost != null);

    const ok = await UI.confirmDialog("Post return " + returnId + "?\n\n" + cards + " card(s) going to " +
      G.locName(locationId) + (refundTotal != null ? ", " + G.money(refundTotal) + " refunded" : "") + "." +
      (costIgnored ? "\n\nThis return is written off, so the cost basis you entered is not restored." : ""),
      { title: "Post return?" });
    if (!ok) return;

    const returnLines = [];
    for (const l of lines) {
      const info = {
        name: l.name, collector: l.collector, setName: l.setName, rarity: l.rarity,
        tcgplayerId: l.tcgplayerId, scryfallId: l.scryfallId,
        price: l.market, priceNote: "", note: "", meta: l.meta || {}
      };
      G.addCopies({
        set: l.set, num: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
        locationId, qty: l.qty, info, unitCost: restoresCost ? l.unitCost : null,
        action: "return",
        note: "Return " + returnId + (orderLabel ? " — order " + orderLabel : "") + (reason ? " (" + reason + ")" : "")
      });
      returnLines.push({
        set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
        name: l.name, scryfallId: l.scryfallId, qty: l.qty, unitCost: restoresCost ? l.unitCost : null
      });
    }
    const doc = G.recordReturn({
      returnId, orderId: selectedOrder ? selectedOrder.id : "", orderLabel, buyer, disposition, locationId, reason, note, refundTotal,
      lines: returnLines,
      orderSnapshot: selectedOrder ? {
        placedAt: selectedOrder.placedAt || "",
        status: selectedOrder.status || "",
        ship: selectedOrder.ship || null,
        lines: (selectedOrder.lines || []).map(l => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice }))
      } : null
    });
    // Only a return put back to stock counts as a wanted card coming in
    // (Customers page, #50). A written-off one adds copies nobody can buy.
    G.persist("Return " + returnId, { restock: disposition === "restock" });
    clearForm();
    renderHistory();
    UI.toast("Posted " + returnId + ": " + doc.totalQty + " card" + (doc.totalQty === 1 ? "" : "s") +
      " into " + G.locName(locationId) + ".", "ok");
  }

  function clearForm() {
    lines = [];
    renderLines();
    $("retOrderLabel").value = ""; $("retBuyer").value = ""; $("retId").value = "";
    $("retReason").value = ""; $("retNote").value = ""; $("retRefund").value = "";
    selectedOrder = null;
    clearOrderInfo();
  }

  /* ============================== On the floor (#411) ==============================
     Send to the floor opens this form as a return for Warehouse Mode instead of
     posting it: the draft lines become what's expected back (with their cost), the
     phone books what actually arrives, restock or damaged per card, and Close here
     settles the cost and the refund (core.js closeReturn). */
  async function addOrderCards() {
    if (!selectedOrder) return;
    const order = selectedOrder;
    const want = G.returnExpectedFromOrder(order);
    if (!want.length) { UI.toast("This order has no card lines on file to add.", "err"); return; }
    const costs = await G.returnSaleCosts(order.id);
    let added = 0;
    for (const w of want) {
      let card = null;
      try { card = await G.cards.one(w.set, w.collector, w.lang || "en"); } catch (e) { card = null; }
      const finish = w.finish || "nonfoil";
      lines.push({
        jid: "l" + (++lineSeq), set: w.set, collector: w.collector, setName: card ? card.setName : "",
        name: w.name || (card ? G.cardName(card) : ""), lang: w.lang || "en", finish, condition: w.condition || G.defaultCondition(), qty: w.qty,
        tcgplayerId: card ? card.tcgplayerId || "" : "", scryfallId: card ? card.id || "" : "", rarity: card ? card.rarity || "" : "",
        market: card ? G.priceOf(card, finish) : null, meta: card ? G.pickMeta(card) : {}, imageUrl: card ? card.imageUrl || "" : "",
        unitCost: costs.has([w.set.toLowerCase(), G.normNum(w.collector), finish].join("|")) ? costs.get([w.set.toLowerCase(), G.normNum(w.collector), finish].join("|")) : null
      });
      added += w.qty;
    }
    renderLines();
    UI.toast("Added " + added + " card" + (added === 1 ? "" : "s") + " from the order. Cost is filled in where the sale's cost is on record.", "ok");
  }
  /* One at a time (#470): the order lookup below is awaited, and a quick
     second click used to open a second return for the same order. */
  let sendingToFloor = false;
  async function sendToFloor() {
    if (sendingToFloor) return;
    sendingToFloor = true;
    $("retFloor").disabled = true;
    try { await sendToFloorNow(); }
    finally { sendingToFloor = false; $("retFloor").disabled = false; }
  }
  async function sendToFloorNow() {
    if (selectedOrder && !lines.length) await addOrderCards();
    if (!lines.length && !selectedOrder && !$("retOrderLabel").value.trim()) { UI.toast("Add the cards you expect back, or an order, first.", "err"); return; }
    const refundRaw = $("retRefund").value.trim();
    let doc;
    try {
      doc = G.openReturn({
        returnId: $("retId").value, orderId: selectedOrder ? selectedOrder.id : "", orderLabel: $("retOrderLabel").value, buyer: $("retBuyer").value,
        refundTotal: refundRaw === "" ? null : Math.max(0, parseFloat(refundRaw) || 0), reason: $("retReason").value, note: $("retNote").value,
        orderSnapshot: selectedOrder ? {
          placedAt: selectedOrder.placedAt || "", status: selectedOrder.status || "", ship: selectedOrder.ship || null,
          lines: (selectedOrder.lines || []).map(l => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice }))
        } : null,
        expected: lines.map(l => ({ set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition, name: l.name,
          qty: l.qty, image: l.imageUrl, unitCost: l.unitCost }))
      });
    } catch (e) { UI.toast(e.message, "err"); return; }
    G.persist("Return " + doc.receiptId + " opened for Warehouse Mode");
    clearForm();
    renderFloor();
    UI.toast("Opened " + doc.receiptId + ". It's under Returns in Warehouse Mode now.", "ok");
  }
  function renderFloor() {
    const open = G.openReturns();
    $("floorHdr").textContent = open.length ? open.length + " open" : "";
    $("retFloorCount").textContent = open.length || "";
    $("retFloorCount").hidden = !open.length;
    const body = $("floorBody");
    if (!open.length) {
      body.innerHTML = UI.emptyRow(6, { icon: "orders", title: "No return is open on the floor." });
      return;
    }
    body.innerHTML = open.map(rc => {
      const s = G.returnSummary(rc.id);
      return "<tr><td><b>" + G.esc(rc.receiptId) + "</b>" + (rc.note ? '<div class="muted">' + G.esc(rc.note) + "</div>" : "") + "</td>" +
        '<td class="hide-sm">' + G.esc(rc.orderLabel || rc.buyer || "—") + "</td>" +
        '<td class="num">' + (s.expectedQty || "—") + "</td>" +
        '<td class="num">' + s.received + (s.damaged ? ' <span class="muted">(' + s.damaged + " damaged)</span>" : "") + "</td>" +
        '<td class="num">' + s.toPutAway + "</td>" +
        '<td class="row-actions"><button class="small floorClose" data-id="' + G.esc(rc.id) + '">Close</button>' +
        (s.received ? "" : ' <button class="small danger floorRemove" data-id="' + G.esc(rc.id) + '">Remove</button>') + "</td></tr>";
    }).join("");
    for (const b of body.querySelectorAll(".floorClose")) b.onclick = () => closeFloor(b.dataset.id);
    for (const b of body.querySelectorAll(".floorRemove")) b.onclick = () => removeFloor(b.dataset.id);
  }
  const NO_FLOOR = "Couldn't get the latest from Warehouse Mode, so nothing was closed. Check the connection and try again.";
  // Depends on the floor: catch up first, then read it again by id.
  async function closeFloor(id) {
    const c = await G.catchUp();
    if (!c.ok) { UI.toast(NO_FLOOR, "err"); return; }
    const s = G.returnSummary(id);
    if (!s) { renderFloor(); return; }
    const rc = s.doc;
    const costRows = G.returnCostRows(id);
    UI.ensureModal("returnCloseModal", "wide",
      '<h3 id="rcTitle"></h3><div id="rcMeta" class="muted" style="margin-bottom:10px"></div>' +
      '<div class="list-wrap"><table class="list"><thead><tr><th>Card</th><th class="num">On the order</th><th class="num">Booked</th><th class="num">Damaged</th></tr></thead><tbody id="rcExpected"></tbody></table></div>' +
      '<p id="rcExtras" class="hint"></p>' +
      '<div class="sec-head"><h2>Cost back into stock</h2></div>' +
      '<p class="hint">Restock copies go back with this cost each (filled in from the original sale where it is on record). Damaged copies go back with none.</p>' +
      '<div class="list-wrap"><table class="list"><thead><tr><th>Card</th><th class="num">Restock</th><th class="num">Cost each ($)</th></tr></thead><tbody id="rcCosts"></tbody></table></div>' +
      '<div class="grid3" style="margin-top:10px"><label>Refund amount ($) <input id="rcRefund" type="number" min="0" step="0.01" placeholder="0.00"></label></div>' +
      '<p id="rcPut" class="hint"></p><hr><div class="modal-actions"><button id="rcCancel">Cancel</button><span class="spacer"></span><button id="rcClose" class="gold">Close return</button></div>');
    $("rcTitle").textContent = "Close " + rc.receiptId;
    $("rcMeta").textContent = [rc.orderLabel ? "order " + rc.orderLabel : "", rc.buyer, s.receivers.length ? "booked by " + s.receivers.join(", ") : ""].filter(Boolean).join(" · ");
    $("rcExpected").innerHTML = s.rows.length ? s.rows.map(e => "<tr><td class=\"card-name\">" + UI.cardLink(e) + " <span class=\"muted\">" + G.esc(G.printingLabel(e.set, e.collector, "")) + "</span></td>" +
      '<td class="num">' + e.qty + '</td><td class="num">' + e.got + '</td><td class="num">' + (e.damaged || "—") + "</td></tr>").join("")
      : UI.emptyRow(4, { icon: "cards", title: "Nothing was listed for this return." });
    $("rcExtras").textContent = s.extras ? s.extras + " card" + (s.extras === 1 ? "" : "s") + " came back that weren't on the order." : "";
    $("rcCosts").innerHTML = costRows.length ? costRows.map((r, i) => "<tr><td class=\"card-name\">" + UI.cardLink(r) + " <span class=\"muted\">" + G.esc(G.printingLabel(r.set, r.collector, "")) +
      (r.finish && r.finish !== "nonfoil" ? " " + G.esc(G.FINISH_NAMES[r.finish]) : "") + "</span></td>" +
      '<td class="num">' + r.qty + '</td><td class="num"><input class="rcCost" data-i="' + i + '" type="number" min="0" step="0.01" placeholder="none" value="' +
      (r.unitCost == null ? "" : r.unitCost) + '" aria-label="Cost each for ' + G.esc(r.name) + '"></td></tr>').join("")
      : UI.emptyRow(3, { icon: "cards", title: "No restock copies booked." });
    $("rcRefund").value = rc.refundTotal == null ? "" : rc.refundTotal;
    $("rcPut").textContent = s.toPutAway ? s.toPutAway + " still to put away, in " + s.trays.join(", ") + ". They stay there as ordinary stock." : "";
    $("rcCancel").onclick = () => UI.hideModal("returnCloseModal");
    $("rcClose").onclick = async () => {
      const unitCosts = {};
      for (const inp of document.querySelectorAll("#rcCosts .rcCost")) unitCosts[costRows[Number(inp.dataset.i)].costKey] = inp.value.trim() === "" ? null : Math.max(0, parseFloat(inp.value) || 0);
      const refundRaw = $("rcRefund").value.trim();
      // Again right before acting: a phone may have booked more while this was open.
      const again = await G.catchUp();
      if (!again.ok) { UI.toast(NO_FLOOR, "err"); return; }
      if (!G.receivingById(id)) { UI.hideModal("returnCloseModal"); UI.toast("Someone else already closed " + rc.receiptId + ".", "work"); renderFloor(); return; }
      const out = G.closeReturn(id, { refundTotal: refundRaw === "" ? null : Math.max(0, parseFloat(refundRaw) || 0), unitCosts });
      G.persist("Return " + rc.receiptId, { restock: out.restock });
      UI.hideModal("returnCloseModal");
      renderFloor(); renderHistory();
      UI.toast("Closed " + rc.receiptId + ": " + out.doc.totalQty + " card" + (out.doc.totalQty === 1 ? "" : "s") + " back" +
        (out.toPutAway ? ". " + out.toPutAway + " still to put away." : "."), "ok");
    };
    UI.showModal("returnCloseModal", "rcClose");
  }
  async function removeFloor(id) {
    const rc = G.receivingById(id);
    if (!rc) return;
    const ok = await UI.confirmDialog("Remove " + rc.receiptId + "? Nothing has been booked on it.", { title: "Remove open return?", okLabel: "Remove it", danger: true });
    if (!ok) return;
    const c = await G.catchUp();
    if (!c.ok) { UI.toast("Couldn't get the latest from Warehouse Mode, so nothing was removed.", "err"); return; }
    if (!G.discardReturn(id)) { UI.toast("Something was booked on " + rc.receiptId + " meanwhile, so it stays. Close it instead.", "err"); renderFloor(); return; }
    G.persist("Open return " + rc.receiptId + " removed");
    renderFloor();
  }

  function discardDraft() {
    if (!lines.length) return;
    lines = [];
    renderLines();
  }

  /* ============================== Tie a return to its original order ==============================
     Manapool orders are already fetched/cached server-side for Order
     Fulfillment (GET /api/manapool/orders/cached) - this searches that same
     cache by label/buyer/id so a return can be linked to a real order
     (orderId, not just typed text) and show what actually shipped, instead
     of relying on a staffer to retype the order label correctly by hand. */
  function orderMatches(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    return orders.filter(o =>
      (o.label || "").toLowerCase().includes(q) ||
      (o.buyer || "").toLowerCase().includes(q) ||
      (o.id || "").toLowerCase().includes(q)
    ).slice(0, 8);
  }

  function clearOrderInfo() {
    $("origOrderInfo").hidden = true;
  }

  function showOrderInfo(o) {
    const box = $("origOrderInfo");
    box.hidden = false;
    const s = o.ship || {};
    const addr = [s.name, [s.city, s.state, s.postal].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    $("origOrderMeta").textContent = [
      o.placedAt ? "placed " + new Date(o.placedAt).toLocaleDateString() : "",
      o.status || "",
      addr || "no shipping address on file"
    ].filter(Boolean).join(" · ");
    const ls = o.lines || [];
    $("origOrderLines").innerHTML = ls.length
      ? ls.map(l => G.esc(l.qty + "× ") + (l.name ? (l.kind === "sealed" ? G.esc(l.name) : UI.cardLink(l)) : "?") + G.esc(l.unitPrice != null ? " (" + G.money(l.unitPrice) + " ea.)" : "")).join("<br>")
      : '<span class="muted">no line items on file for this order</span>';
  }

  function wireOrderPicker() {
    const input = $("retOrderLabel"), list = $("orderAcList");
    let index = -1;
    const items = () => [...list.querySelectorAll(".ac-item")];
    const hide = () => { list.hidden = true; index = -1; };
    function pick(o) {
      selectedOrder = o;
      input.value = o.label || o.id;
      if (!$("retBuyer").value.trim()) $("retBuyer").value = o.buyer || "";
      hide();
      showOrderInfo(o);
    }
    function render(matched) {
      if (!matched.length) { hide(); return; }
      index = -1;
      list.innerHTML = matched.map(o =>
        '<div class="ac-item">' + G.esc(o.label || o.id) + " — " + G.esc(o.buyer || "unknown buyer") +
        (o.placedAt ? " · " + G.esc(new Date(o.placedAt).toLocaleDateString()) : "") + "</div>").join("");
      items().forEach((el, i) => {
        el.addEventListener("mousedown", e => { e.preventDefault(); pick(matched[i]); });
      });
      list.hidden = false;
    }
    input.addEventListener("input", () => {
      if (selectedOrder && input.value !== (selectedOrder.label || selectedOrder.id)) {
        selectedOrder = null;
        clearOrderInfo();
      }
      render(orderMatches(input.value));
    });
    input.addEventListener("blur", () => setTimeout(hide, 150));
  }

  function renderHistory() {
    const rows = G.state.returns;
    $("retHdr").textContent = rows.length
      ? rows.length + " return" + (rows.length === 1 ? "" : "s") + " · " +
        G.money(rows.reduce((s, r) => s + (Number(r.refundTotal) || 0), 0)) + " refunded in total"
      : "none yet";
    const body = $("retBody");
    if (!rows.length) {
      body.innerHTML = UI.emptyRow(8, { icon: "orders", title: "No returns recorded yet." });
      return;
    }
    body.innerHTML = "";
    for (const r of rows.slice(0, 200)) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td><b>" + G.esc(r.returnId || "—") + "</b></td>" +
        "<td>" + G.esc(new Date(r.ts).toLocaleDateString()) + "</td>" +
        "<td>" + G.esc(r.orderLabel || "") + "</td>" +
        "<td>" + G.esc(r.buyer || "") + "</td>" +
        '<td><span class="pill type">' + G.esc(r.disposition || "restock") + "</span></td>" +
        '<td class="num">' + r.totalQty + "</td>" +
        '<td class="num">' + (r.refundTotal == null ? '<span class="muted">—</span>' : G.money(r.refundTotal)) + "</td>";
      const td = document.createElement("td");
      td.innerHTML = '<button class="small">Lines</button>';
      td.querySelector("button").onclick = () => showReturn(r);
      tr.appendChild(td);
      body.appendChild(tr);
    }
    UI.reapplySorts();
  }

  function showReturn(r) {
    UI.ensureModal("returnModal", "wide",
      '<h3 id="rtTitle"></h3><div id="rtMeta" class="muted" style="margin-bottom:10px"></div>' +
      '<div id="rtOrigOrder" class="callout" hidden style="margin-bottom:10px">' +
      '<span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#link></use></svg></span><div class="cbody"><h3>Original order</h3>' +
      '<div id="rtOrigOrderMeta"></div><div id="rtOrigOrderLines" style="margin-top:6px"></div></div></div>' +
      '<div class="list-wrap"><table class="list" data-sort><thead><tr><th>Card</th><th>Printing</th><th>Finish</th>' +
      '<th class="num">Qty</th><th class="num">Cost ea.</th></tr></thead><tbody id="rtBody"></tbody></table></div>' +
      '<hr><div class="modal-actions"><button id="rtPrint"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#printer></use></svg> Print</button><span class="spacer"></span>' +
      '<button id="rtClose">Close</button></div>');
    $("rtTitle").textContent = "Return " + (r.returnId || "");
    $("rtMeta").textContent = [
      new Date(r.ts).toLocaleString(),
      r.orderLabel ? "order " + r.orderLabel : "",
      r.buyer,
      r.disposition,
      G.locName(r.locationId),
      r.refundTotal == null ? "no refund on file" : G.money(r.refundTotal) + " refunded",
      r.reason, r.note
    ].filter(Boolean).join(" · ");
    if (r.orderSnapshot) {
      $("rtOrigOrder").hidden = false;
      const s = r.orderSnapshot.ship || {};
      const addr = [s.name, [s.city, s.state, s.postal].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
      $("rtOrigOrderMeta").textContent = [
        r.orderSnapshot.placedAt ? "placed " + new Date(r.orderSnapshot.placedAt).toLocaleDateString() : "",
        r.orderSnapshot.status || "",
        addr || "no shipping address on file"
      ].filter(Boolean).join(" · ");
      const ls = r.orderSnapshot.lines || [];
      $("rtOrigOrderLines").innerHTML = ls.length
        ? ls.map(l => G.esc(l.qty + "× ") + (l.name ? (l.kind === "sealed" ? G.esc(l.name) : UI.cardLink(l)) : "?") + G.esc(l.unitPrice != null ? " (" + G.money(l.unitPrice) + " ea.)" : "")).join("<br>")
        : '<span class="muted">no line items on file for this order</span>';
    } else {
      $("rtOrigOrder").hidden = true;
    }
    $("rtBody").innerHTML = (r.lines || []).map(l =>
      '<tr><td class="card-name">' + UI.cardLink(l) + "</td>" +
      "<td>" + G.esc(G.printingLabel(l.set, l.collector, "")) + "</td>" +
      "<td>" + (l.finish && l.finish !== "nonfoil" ? G.esc(G.FINISH_NAMES[l.finish]) : "—") + "</td>" +
      '<td class="num">' + l.qty + "</td>" +
      '<td class="num">' + (l.unitCost == null ? "—" : G.money(l.unitCost)) + "</td></tr>").join("");
    UI.reapplySorts();
    $("rtClose").onclick = () => UI.hideModal("returnModal");
    $("rtPrint").onclick = () => {
      G.printList("Return " + (r.returnId || ""),
        ["Card", "Printing", "Finish", "Qty", "Cost ea."],
        (r.lines || []).map(l => [G.esc(l.name), G.esc(G.printingLabel(l.set, l.collector, "")),
          l.finish && l.finish !== "nonfoil" ? G.FINISH_NAMES[l.finish] : "", l.qty,
          l.unitCost == null ? "" : G.money(l.unitCost)]),
        $("rtMeta").textContent);
    };
    UI.showModal("returnModal", "rtClose");
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    preview = UI.CardPanel("preview", {});
    $("inLang").innerHTML = Object.entries(G.LANG_NAMES)
      .map(([k, v]) => '<option value="' + k + '">' + G.esc(v) + "</option>").join("");
    $("inCondition").innerHTML = G.CONDITIONS
      .map(c => '<option value="' + c + '">' + G.esc(G.CONDITION_NAMES[c]) + "</option>").join("");
    $("inCondition").value = G.defaultCondition();
    UI.fillLocationSelect($("retLoc"), null, { anyLabel: "— choose a destination —" });

    UI.Autocomplete("inSearch", "acList", loadPrintings);
    $("inPrinting").onchange = showPicked;
    $("inLang").onchange = showPicked;
    $("inFoil").onchange = showPicked;
    $("inQty").oninput = showPicked;
    $("btnAddLine").onclick = addLine;
    $("retDiscard").onclick = discardDraft;
    $("retPost").onclick = postReturn;
    wireOrderPicker();
    try {
      const d = await G.api("/api/manapool/orders/cached");
      orders = d.orders || [];
    } catch (e) { orders = []; } // Manapool not connected/configured - free-text order label still works

    $("retFloor").onclick = sendToFloor;
    $("retOrderCards").onclick = addOrderCards;
    renderLines();
    renderHistory();
    renderFloor();
    // The tab is remembered (UI.pageTabs). The floor tab's button is full-mode only.
    UI.pageTabs({ tabs: [
      { id: "new", button: "tabNew", panes: ["paneNew"] },
      { id: "floor", button: "tabFloor", panes: ["paneFloor"] },
      { id: "history", button: "tabHist", panes: ["paneHist"] }
    ] });
    G.on("change", () => {
      UI.fillLocationSelect($("retLoc"), $("retLoc").value, { anyLabel: "— choose a destination —" });
      renderHistory();
      renderFloor();
    });
  });
})();
