
"use strict";
(function () {
  const $ = UI.$;
  let grid = null;
  let preview = null;
  let query = null;
  let xferQty = new Map();

  /* ============================== Summary ============================== */
  function renderSummary(rows) {
    const s = G.summary(rows);
    const c = s.cost;
    let html =
      stat(s.names.toLocaleString(), "Card names") +
      stat(s.cards.toLocaleString(), "Total cards") +
      stat(s.stacks.toLocaleString(), G.simpleMode ? "Entries" : "Stacks") +
      stat(s.locations, "Locations") +
      stat(G.money(s.value), "Market value", "val") +
      // Seller bookkeeping tiles are left out in Simple mode.
      (G.simpleMode ? "" :
        stat(s.listedCards.toLocaleString(), "Marked to list") +
        stat(G.money(s.listedValue), "Marked-to-list value", "val") +
        stat(G.money(c.cost), "Cost basis") +
        stat(c.cost > 0 ? G.money(c.gain) : "—", "Unrealised gain", c.gain >= 0 ? "val" : "neg") +
        stat(Math.round(c.coverage * 100) + "%", "Cards with a cost"));
    if (rows && rows.length !== G.state.cards.length) {
      html += stat(s.filteredCards.toLocaleString() + " / " + s.filteredStacks, (G.simpleMode ? "Filtered cards / entries" : "Filtered cards / stacks")) +
        stat(G.money(s.filteredValue), "Filtered value", "val");
    }
    // A total that leaves cards out says so, and what the prices are (#326).
    const note = G.unpricedNote(s.unpricedCards);
    html += '<div class="summary-note muted" style="flex-basis:100%;font-size:12.5px">' +
      (note ? "<b>" + note + " in the market value.</b> " : "") +
      '<span data-price-basis>Near Mint market price</span>. Condition doesn\'t change these prices.</div>';
    $("summary").innerHTML = html;
    G.paintPriceBasis($("summary"));
  }
  const stat = (big, lbl, cls) =>
    '<div class="stat"><span class="big ' + (cls || "") + '">' + big + '</span><span class="lbl">' + lbl + "</span></div>";

  // Filtered to a location with a sorting method (#267): say the rows are in
  // that order, and that a column header still re-sorts.
  function renderLocOrderHint(mode) {
    const l = mode === "wms" && grid ? grid.orderLocation : null;
    const bySet = !l && mode === "wms" && grid && grid.setOrdered;
    $("locOrderHint").hidden = !l && !bySet;
    $("locOrderHint").textContent = l ? "In " + l.name + "'s order: " + G.locSortSummary(l.sortMethod) + ". Click a column to re-sort."
      : bySet ? "In set, then collector number order. Click a column to re-sort." : "";
  }

  /* ============================== Lent out (#336) ============================== */
  const lentPanel = UI.slideOver("lentPanel");
  function renderLentButton() {
    const loans = G.allLoans();
    const late = loans.filter(x => x.overdue).length;
    const btn = $("btnLentOut");
    btn.hidden = !loans.length;
    btn.innerHTML = UI.icon(late ? "clock" : "user") + " Lent out (" + loans.length + ")" + (late ? " · " + late + " overdue" : "");
  }
  function renderLentPanel() {
    const loans = G.allLoans();
    const body = $("lentBody");
    body.innerHTML = loans.length ? loans.map(({ record: r, loan }) =>
      '<div class="loan-row"><div class="loan-card">' + UI.cardLink(r) + "</div>" +
        '<div class="muted" style="font-size:12px">' + G.esc(G.recPrinting(r)) + " · " + G.esc(G.locName(r.locationId)) + "</div>" +
        UI.loanLine(r, loan) + "</div>").join("")
      : UI.emptyBlock({ icon: "generic", title: "Nothing is lent out right now." });
    UI.wireLoanLines(body, () => { renderLentPanel(); renderLentButton(); });
  }
  function openLentPanel() { renderLentPanel(); lentPanel.open(); }

  /* ============================== Query chip ============================== */
  function renderChip() {
    const chip = $("queryChip");
    const n = G.queryFieldCount(query);
    if (!n) { chip.hidden = true; chip.innerHTML = ""; return; }
    chip.hidden = false;
    chip.innerHTML = "Query · " + n + " condition" + (n === 1 ? "" : "s") + (query.sellingFast ? ", selling fast" : "") +
      ' <button id="chipX" title="Clear the query" aria-label="Clear the query">✕</button>';
    $("chipX").onclick = () => { query = null; renderChip(); grid.setFilters({ query: null }); };
  }

  /* ============================== Refresh ============================== */
  async function refresh() {
    $("btnRefresh").disabled = true;
    UI.toast("Refreshing prices and card data from the server's card database…", "work");
    try {
      const out = await G.refreshPrices(msg => UI.toastProgress(msg));
      UI.toast("Refreshed " + out.updated + " of " + out.rows + " stack" + (out.rows === 1 ? "" : "s") + ": " +
        out.priceChanged + " price change" + (out.priceChanged === 1 ? "" : "s") +
        (out.metaFilled ? ", " + out.metaFilled + " backfilled with card data" : "") +
        (out.missing ? ", " + out.missing + " not found" : "") +
        (out.skipped ? ", " + out.skipped + " couldn't be refreshed" : "") + ".",
        out.missing || out.skipped ? "work" : "ok",
        [
          out.skipped
            ? out.skipped + " stack(s) kept their old prices because the server didn't answer for them. " +
              "Press Refresh prices & data again to try them again."
            : "",
          out.missing
            ? out.missing + " printing(s) are not in the card database. Use Query → “Lookup failed” to list them, " +
              "then check the set code and collector number. A very new set may only appear after the next daily download."
            : ""
        ].filter(Boolean).join(" ") || null);
    } catch (e) {
      UI.toast("Refresh failed: " + e.message, "err");
    }
    $("btnRefresh").disabled = false;
  }

  /* ============================== Copy ============================== */
  function copyFiltered() {
    const rows = grid.rows();
    if (!rows.length) { UI.toast("Nothing to copy — no rows match.", "err"); return; }
    const head = ["Set", "Collector #", "Language", "Finish", "Card Name", "Price", "Quantity", "Listed",
      "Location", "Location Type", "Row Total", "Avg Cost", "Copies With Cost", "Cost Total"];
    const lines = [head.join("\t")];
    for (const r of rows) {
      lines.push([r.set.toUpperCase(), r.collector, (G.LANG_NAMES[r.lang] || r.lang), G.FINISH_NAMES[r.finish] || "Non-foil",
        r.name, r.price == null ? "" : r.price.toFixed(2), r.quantity, (r.listedQty || 0),
        G.locName(r.locationId), G.locType(r.locationId), G.rowTotal(r).toFixed(2),
        r.avgCost == null ? "" : r.avgCost.toFixed(2), r.costQty || 0,
        (Number(r.costTotal) || 0).toFixed(2)].join("\t"));
    }
    const text = lines.join("\n");
    const done = () => UI.toast("Copied " + rows.length + " rows — paste into Excel or Sheets.", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallback(text, done));
    } else fallback(text, done);
  }
  function fallback(text, cb) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); cb(); }
    catch (e) { UI.toast("Copy failed — this browser blocked clipboard access.", "err"); }
    ta.remove();
  }
  function exportFilteredCsv() {
    const rows = grid.rows();
    if (!rows.length) { UI.toast("Nothing to export — no rows match.", "err"); return; }
    const head = ["Set", "Collector #", "Language", "Finish", "Card Name", "Price", "Quantity", "Listed",
      "Location", "Location Type", "Row Total", "Avg Cost", "Copies With Cost", "Cost Total"];
    const lines = [head.map(G.csvCell).join(",")];
    for (const r of rows) {
      lines.push([r.set.toUpperCase(), r.collector, (G.LANG_NAMES[r.lang] || r.lang), G.FINISH_NAMES[r.finish] || "Non-foil",
        r.name, r.price == null ? "" : r.price.toFixed(2), r.quantity, (r.listedQty || 0),
        G.locName(r.locationId), G.locType(r.locationId), G.rowTotal(r).toFixed(2),
        r.avgCost == null ? "" : r.avgCost.toFixed(2), r.costQty || 0,
        (Number(r.costTotal) || 0).toFixed(2)].map(G.csvCell).join(","));
    }
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-inventory-filtered.csv");
    UI.toast("Exported " + rows.length + " filtered row" + (rows.length === 1 ? "" : "s") + ".", "ok");
  }

  /* ============================== Transfer export ============================== */
  function openTransfer() {
    const rows = grid.rows();
    if (!rows.length) { UI.toast("Nothing is filtered — narrow to the cards you want to send first.", "err"); return; }
    xferQty = new Map(rows.map(r => [r.id, G.availableQty(r)]));   // a lent copy can't be sent
    renderTransferRows(rows);
    UI.showModal("xferModal", "xfNote");
  }

  function renderTransferRows(rows) {
    const all = $("xfAll").checked;
    const cost = $("xfCost").checked;
    const body = $("xfBody");
    body.innerHTML = "";
    for (const r of rows) {
      const have = G.availableQty(r);
      const send = all ? have : (xferQty.get(r.id) || 0);
      const tr = document.createElement("tr");
      tr.className = "click";
      tr.innerHTML =
        UI.artThumbTd(r.imageUrl) +
        '<td class="card-name">' + UI.cardLink(r) + "</td>" +
        '<td class="muted">' + G.esc(G.recPrinting(r)) + "</td>" +
        "<td>" + (r.finish === "etched" ? '<span class="badge etched">ETCHED</span>' : r.finish === "foil" ? '<span class="badge foil">FOIL</span>' : '<span class="muted">—</span>') + "</td>" +
        '<td class="num">' + have + "</td>" +
        '<td class="num" data-v="' + send + '"><input type="number" min="0" max="' + have + '" value="' + send +
          '" data-id="' + r.id + '" style="width:70px"' + (all ? " disabled" : "") + "></td>" +
        '<td class="num">' + (cost && Number(r.costQty) > 0 ? G.money(r.avgCost) : '<span class="muted">—</span>') + "</td>";
      const inp = tr.querySelector("input");
      inp.oninput = () => {
        const v = Math.min(have, Math.max(0, parseInt(inp.value, 10) || 0));
        xferQty.set(r.id, v);
        inp.closest("td").dataset.v = v;
        summarize(rows);
      };
      UI.wireArtHover(tr, r.imageUrl);
      tr.onclick = e => { if (e.target.closest("input")) return; UI.reviewRecord(r); };
      body.appendChild(tr);
    }
    summarize(rows);
    UI.reapplySorts();
  }

  function sendQty(r) {
    return $("xfAll").checked ? G.availableQty(r) : Math.min(G.availableQty(r), xferQty.get(r.id) || 0);
  }

  function summarize(rows) {
    const cards = rows.reduce((s, r) => s + sendQty(r), 0);
    const value = rows.reduce((s, r) => s + (r.price == null ? 0 : r.price * sendQty(r)), 0);
    $("xfSummary").textContent = cards + " card" + (cards === 1 ? "" : "s") + " across " +
      rows.filter(r => sendQty(r) > 0).length + " line(s), " + G.money(value) + " of market value." +
      ($("xfRemove").checked ? " These copies leave your inventory when you confirm." :
        " Your inventory is left alone — use this only when you are sending a copy of the data, not the cards.");
    $("xfGo").disabled = cards === 0;
  }

  async function writeTransfer() {
    const rows = grid.rows();
    const doc = G.buildTransfer(rows, {
      includeCost: $("xfCost").checked,
      note: $("xfNote").value.trim(),
      qtyOf: sendQty
    });
    if (!doc.lines.length) { UI.toast("Nothing to send.", "err"); return; }
    const remove = $("xfRemove").checked;
    if (remove) {
      const ok = await UI.confirmDialog("Write the transfer file and remove " + doc.totalCards +
        " card(s) from your inventory?\n\nUndo reverses the removal, but the file will already be on disk.",
        { title: "Remove from inventory?", danger: true });
      if (!ok) return;
    }

    const name = "grimoire-transfer-" + G.localDay(Date.now()) + ".json";
    G.downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), name);

    if (remove) {
      for (const r of rows) {
        const n = sendQty(r);
        if (n <= 0) continue;
        G.logAudit({ action: "transfer", ...G.auditCard(r), qty: -n, oldQty: r.quantity, newQty: r.quantity - n,
          from: G.locName(r.locationId), note: "Sent on transfer file " + name });
        G.removeCost(r, n);
        r.quantity -= n;
        if (r.listedQty > r.quantity) r.listedQty = Math.max(0, r.quantity);
      }
      G.state.cards = G.state.cards.filter(r => r.quantity > 0);
      G.normalizeMerge({ silent: true });
      G.persist("Transfer out");
    }
    UI.hideModal("xferModal");
    UI.toast("Wrote " + name + " with " + doc.totalCards + " card(s)" +
      (remove ? " and removed them from your inventory" : "") + ".", "ok");
  }

  /* ============================== Bulk actions (WMS view) ==============================
     A checkbox column on the WMS grid (Grid() in ui.js) selects any number of
     stacks; these three actions cover the moves staff actually asked for
     (2026-09-12 review): move a batch to a different location, re-grade a
     batch's condition, or delete a batch - each currently only possible one
     row at a time via the Manage modal. */
  function updateBulkBar() {
    const rows = grid.getSelectedRows();
    $("bulkBar").hidden = rows.length === 0;
    if (!rows.length) return;
    $("bulkCount").textContent = rows.length + " stack" + (rows.length === 1 ? "" : "s") + " selected";
  }

  async function bulkMove() {
    const locId = $("bulkMoveLoc").value;
    if (!locId) { UI.toast("Pick a location first.", "err"); return; }
    const rows = grid.getSelectedRows();
    if (!rows.length) return;
    const destName = G.locName(locId);
    // Stacks already in the destination don't move, and don't count against
    // its free space either.
    const moving = rows.filter(r => r.locationId !== locId);
    if (!moving.length) { UI.toast("Those stacks are already in " + destName + ".", "err"); return; }
    const stackWord = n => n + " stack" + (n === 1 ? "" : "s");
    // Over the destination's card ceiling: warn with the numbers and let the
    // person go ahead, the same as Locations' "Move all" (#69).
    const fit = G.moveOverCapacity(locId, moving);
    const ok = fit.over
      ? await UI.confirmDialog(destName + " has room for " + fit.free + " but you are moving " + fit.moving +
          ".\n\nMove anyway and leave it over its ceiling?", { title: "Over capacity", danger: true, okLabel: "Move anyway" })
      : await UI.confirmDialog("Move " + stackWord(moving.length) + " to " + destName + "?", { title: "Bulk move" });
    if (!ok) return;
    for (const r of moving) {
      const fromName = G.locName(r.locationId);
      r.locationId = locId;
      G.logAudit({ action: "move", ...G.auditCard(r), qty: 0, oldQty: r.quantity, newQty: r.quantity,
        from: fromName, to: destName, note: "Bulk move" });
    }
    G.normalizeMerge({ silent: true });
    G.persist("Bulk move");
    grid.clearSelection();
    const already = rows.length - moving.length;
    UI.toast("Moved " + stackWord(moving.length) + " to " + destName +
      (already ? " (" + stackWord(already) + " already there)" : "") + ".", "ok");
  }

  async function bulkCondition() {
    const cond = $("bulkConditionSel").value;
    const rows = grid.getSelectedRows();
    if (!rows.length) return;
    const ok = await UI.confirmDialog("Set condition to " + G.CONDITION_NAMES[cond] + " on " + rows.length +
      " stack" + (rows.length === 1 ? "" : "s") + "?", { title: "Bulk set condition" });
    if (!ok) return;
    for (const r of rows) {
      if (r.condition === cond) continue;
      const old = r.condition || "NM";
      r.condition = cond;
      G.logAudit({ action: "edit", ...G.auditCard(r), qty: 0, oldQty: r.quantity, newQty: r.quantity,
        note: "Bulk condition " + old + " → " + cond });
    }
    G.normalizeMerge({ silent: true });
    G.persist("Bulk set condition");
    grid.clearSelection();
    UI.toast("Set condition on " + rows.length + " stack" + (rows.length === 1 ? "" : "s") + ".", "ok");
  }

  async function bulkDelete() {
    const rows = grid.getSelectedRows();
    if (!rows.length) return;
    const ok = await UI.confirmDialog("Delete " + rows.length + " stack" + (rows.length === 1 ? "" : "s") +
      "? This removes them from your inventory.", { title: "Delete stacks?", danger: true, okLabel: "Delete" });
    if (!ok) return;
    const ids = new Set(rows.map(r => r.id));
    for (const r of rows) {
      G.logAudit({ action: "delete", ...G.auditCard(r), qty: -r.quantity, oldQty: r.quantity, newQty: 0,
        from: G.locName(r.locationId), note: "Bulk delete" });
    }
    G.state.cards = G.state.cards.filter(r => !ids.has(r.id));
    G.persist("Bulk delete");
    grid.clearSelection();
    UI.toast("Deleted " + rows.length + " stack" + (rows.length === 1 ? "" : "s") + ".", "ok");
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    preview = UI.CardPanel("preview", { placeholder: G.simpleMode ? "Click a row to see the card." : "Click a row to see the card and where its rules say it belongs." });

    grid = UI.Grid({
      wmsWrapId: "wmsWrap",
      erpWrapId: "erpWrap",
      storefrontWrapId: "storefrontWrap",
      onSelect: r => preview.showRecord(r),
      onDrill: name => { $("search").value = name; setView("wms"); },
      onRender: (rows, mode) => { renderSummary(mode === "wms" ? rows : null); renderLocOrderHint(mode); renderLentButton(); },
      onSelectionChange: updateBulkBar
    });

    UI.fillLocationSelect($("bulkMoveLoc"), "", { anyLabel: "Move to location…" });
    $("bulkConditionSel").innerHTML = G.CONDITIONS.map(c =>
      '<option value="' + c + '">' + G.esc(G.CONDITION_NAMES[c]) + "</option>").join("");
    $("bulkMove").onclick = bulkMove;
    $("bulkCondition").onclick = bulkCondition;
    $("bulkDelete").onclick = bulkDelete;
    $("bulkClear").onclick = () => grid.clearSelection();
    // #335: a trade made in person, both sides in one go.
    $("btnRecordTrade").onclick = () => TradeRecord.open();
    $("btnLentOut").onclick = openLentPanel;
    renderLentButton();
    // ?lent=1 (the Dashboard's overdue to-do): straight to the list.
    if (new URLSearchParams(location.search).get("lent") === "1") openLentPanel();

    UI.fillLocationSelect($("filterLoc"), "", { anyLabel: "All locations" });
    const wantLoc = new URLSearchParams(location.search).get("loc");
    if (wantLoc && G.locById(wantLoc)) $("filterLoc").value = wantLoc;
    // ?noprice=1 (the "no price, not counted" links): only the cards with no price.
    if (new URLSearchParams(location.search).get("noprice") === "1") {
      query = Object.assign(G.emptyQuery(), { noPrice: true });
    }
    // #366: the Sold 7d column's Manapool sales. ?fast=1 (the Dashboard's
    // "listed cards are SELLING FAST" line, with listed=1): only those.
    if (!G.simpleMode) G.loadSoldMine();
    const sp = new URLSearchParams(location.search);
    if (sp.get("fast") === "1" && !G.simpleMode) {
      query = Object.assign(query || G.emptyQuery(), { sellingFast: true }, sp.get("listed") === "1" ? { listed: true } : {});
    }

    const setView = m => {
      grid.setMode(m);
      $("viewWms").classList.toggle("active", m === "wms");
      $("viewErp").classList.toggle("active", m === "erp");
      $("viewStorefront").classList.toggle("active", m === "storefront");
      $("filterLoc").disabled = m !== "wms";
      $("viewHint").textContent = m === "erp"
        ? "One row per card name, rolled up over every printing and location. Click a row to drill into its stacks."
        : m === "storefront"
        ? "One row per sellable printing/condition, every location folded together - the grain Manapool sells at. Listed quantity is only editable here."
        : G.simpleMode ? "One row per printing and location. Everything you own." : "One row per stack: printing · finish · language · location. Your working inventory.";
    };
    $("viewWms").onclick = () => setView("wms");
    $("viewErp").onclick = () => setView("erp");
    $("viewStorefront").onclick = () => setView("storefront");

    // BACKLOG.md #32: comfortable/compact row height for all three grids -
    // a per-viewer display convenience (localStorage, same precedent as
    // Audit Log's own "Hide sparse columns" toggle), not collection state,
    // so it never touches G.state or round-trips through the server.
    const DENSITY_KEY = "grimoire.inventoryDensity";
    const densityWraps = [$("wmsWrap"), $("erpWrap"), $("storefrontWrap")];
    const applyDensity = compact => {
      densityWraps.forEach(w => w.classList.toggle("density-compact", compact));
      $("btnDensityComfy").classList.toggle("active", !compact);
      $("btnDensityCompact").classList.toggle("active", compact);
    };
    applyDensity(localStorage.getItem(DENSITY_KEY) === "1");
    $("btnDensityComfy").onclick = () => { localStorage.setItem(DENSITY_KEY, "0"); applyDensity(false); };
    $("btnDensityCompact").onclick = () => { localStorage.setItem(DENSITY_KEY, "1"); applyDensity(true); };

    if (G.simpleMode) {
      // No grain choice, no query builder, no transfer export - just "here's
      // what I own." Export menu trims to the one casual-useful entry; the
      // others (TCGplayer listing CSV, filtered CSV, transfer file) are
      // seller/multi-user tooling. The Audit Log page itself (its own nav
      // entry) is hidden in simple mode too - see ui.js's NAV_ADVANCED_ONLY.
      setView("erp");
      document.querySelector(".tabs").hidden = true;
      $("btnQuery").hidden = true;
      $("queryChip").hidden = true;
      $("expCsv").hidden = true;
      $("expFiltered").hidden = true;
      $("expTransfer").hidden = true;
      $("expTransfer").previousElementSibling.hidden = true; // the <hr> above it
      $("expTransfer").nextElementSibling.hidden = true;     // the .mnote below it
    }

    // Typing a new search replaces the card filter from the panel (chip and printing).
    $("search").addEventListener("input", G.debounce(() => {
      UI.cardFilterChip(null, null);
      grid.setFilters({ text: $("search").value, exactName: null, printing: null });
    }, 180));
    $("filterLoc").onchange = () => grid.setFilters({ loc: $("filterLoc").value });
    // #410: opened from the card panel (?q= + set/collector): that card only,
    // with a chip to clear it. The Grid matches the exact printing when it has
    // one; the name in the search box also covers the by-name views.
    const showCardChip = () => {
      const cf = UI.cardFilterFromUrl();
      UI.cardFilterChip($("queryChip"), cf, cf ? UI.cardFilterLabel(cf) : "", () => {
        $("search").value = "";
        grid.setFilters({ text: "", printing: null });
      });
      return cf;
    };
    const cardFilter = showCardChip();
    if (cardFilter && cardFilter.name) {
      $("search").value = cardFilter.name;
      grid.setFilters({ text: cardFilter.name, printing: cardFilter.set && cardFilter.collector ? cardFilter : null });
    }
    $("btnClear").onclick = () => {
      $("search").value = ""; $("filterLoc").value = ""; query = null;
      renderChip();
      UI.cardFilterChip($("queryChip"), null);
      grid.setFilters({ text: "", loc: "", query: null, exactName: null, printing: null });
    };
    $("btnQuery").onclick = async () => {
      const out = await UI.openQuery(query);
      if (out === undefined) return;           // cancelled
      query = out;
      renderChip();
      grid.setFilters({ query });
      const n = grid.rows().length;
      UI.toast(query ? "Query applied — " + n + " stack" + (n === 1 ? "" : "s") + " match." : "Query cleared.", "ok");
    };
    $("btnRefresh").onclick = refresh;
    $("btnCopy").onclick = copyFiltered;
    $("btnExport").onclick = e => { e.stopPropagation(); $("exportMenu").hidden = !$("exportMenu").hidden; };
    $("expCsv").onclick = () => {
      $("exportMenu").hidden = true;
      try { const o = G.exportTcgCsv(); UI.toast("Exported " + o.lines + " listing(s) / " + o.cards + " cards.", "ok"); }
      catch (e) { UI.toast(e.message, "err"); }
    };
    $("expXlsx").onclick = () => {
      $("exportMenu").hidden = true;
      try { const n = G.exportExcel(); UI.toast("Exported " + n + " rows to grimoire-inventory.xlsx.", "ok"); }
      catch (e) { UI.toast(e.message, "err"); }
    };
    $("expFiltered").onclick = () => { $("exportMenu").hidden = true; exportFilteredCsv(); };
    $("expTransfer").onclick = () => { $("exportMenu").hidden = true; openTransfer(); };

    ["xfAll", "xfCost", "xfRemove"].forEach(id => {
      $(id).onchange = () => renderTransferRows(grid.rows());
    });
    $("xfCancel").onclick = () => UI.hideModal("xferModal");
    $("xfGo").onclick = writeTransfer;
    $("xferModal").addEventListener("click", e => { if (e.target.id === "xferModal") UI.hideModal("xferModal"); });

    G.on("change", () => {
      UI.fillLocationSelect($("filterLoc"), $("filterLoc").value, { anyLabel: "All locations" });
    });

    setView("wms");
    grid.setFilters({ loc: $("filterLoc").value, query });
    renderChip();
  });
})();
