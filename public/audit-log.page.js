
"use strict";
(function () {
  const $ = UI.$;
  let logTab = "audit";

  const AUDIT_ACTIONS = ["", "add", "remove", "edit", "move", "delete", "list", "import", "receipt",
    "transfer", "cost", "putaway", "ship", "build", "location", "price", "lend", "undo"];
  // One neutral badge per action, the word doing the work; only the two
  // that take cards away are red (#164: no extra accent colours).
  const AUDIT_LABELS = { list: "LISTING" };
  const auditLabel = a => AUDIT_LABELS[a] || String(a || "").toUpperCase();
  const auditTag = a => '<span class="badge ' + (a === "delete" || a === "remove" ? "neg" : "non") + '">' +
    G.esc(auditLabel(a)) + "</span>";
  const whenText = ts => { try { return new Date(ts).toLocaleString(); } catch (e) { return ts || ""; } };
  // Epoch ms for the When cell's data-v, so the column sorts by real time
  // rather than by the month its text starts with (#164).
  const whenSort = ts => { const n = Date.parse(ts); return isNaN(n) ? "" : String(n); };
  const stopClick = fn => e => { e.stopPropagation(); fn(); };

  /* Row click reviews the card an audit entry was about - a live lookup
     (cached by G.cards.one same as everywhere else that does this), since an
     audit entry never stored an image URL itself. Silently does nothing on a
     bad/missing identity (very old entries) rather than showing an error for
     what's just a gap in old data. */
  async function reviewAuditEntry(e) {
    let card;
    try { card = await G.cards.one(e.set, e.collector, e.lang || "en"); }
    catch (err) { return; }
    if (card) UI.reviewCard(card, G.finishOf(e));
  }

  /* ============================== Audit log ==============================
     The log lives server-side (day-sharded, see server/lib/audit.js), so
     this is a query, not an in-memory filter - G.queryAudit() already
     applies the action/text filter and merges in anything logged this
     session that hasn't been flushed to the server yet. */
  // #410: opened from the card panel (?q= + set/collector): that card only.
  let cardFilter = UI.cardFilterFromUrl();
  function auditFilter() {
    return { action: $("auditAction").value, q: cardFilter ? (cardFilter.set && cardFilter.collector ? "" : cardFilter.name) : $("auditSearch").value.trim(),
      set: cardFilter ? cardFilter.set : "", collector: cardFilter ? cardFilter.collector : "" };
  }
  function showCardChip() {
    UI.cardFilterChip($("auditSearch"), cardFilter, cardFilter ? UI.cardFilterLabel(cardFilter) : "", () => {
      cardFilter = null; auditPage = 1; renderAudit();
    });
  }
  const AUDIT_PAGE = 400;
  let auditPage = 1;
  // The whole log's size, from the last unfiltered answer (null = not known
  // yet). Each query re-reads every day file on the server, so the header
  // and Clear log reuse this rather than asking again (#162).
  let logTotal = null;
  // Typing, paging and a merged save all redraw; only the newest answer
  // may draw, so a slow "bol" can't land on top of "bolt" (#162).
  const beginAudit = G.latestOnly();

  function renderHeader() {
    $("logHdr").textContent = "— " + (logTotal == null ? "?" : logTotal) + " logged action" +
      (logTotal === 1 ? "" : "s");
  }

  async function renderAudit() {
    const isCurrent = beginAudit();
    const body = $("auditBody");
    const filter = auditFilter();
    let res;
    try {
      res = await G.queryAudit(Object.assign(
        { limit: AUDIT_PAGE, offset: (auditPage - 1) * AUDIT_PAGE }, filter));
    }
    catch (e) {
      if (!isCurrent()) return;
      body.innerHTML = UI.emptyRow(16, { icon: "error", title: "Could not load the activity log." });
      return;
    }
    if (!isCurrent()) return;
    if (!filter.action && !filter.q && !filter.set) { logTotal = res.total; renderHeader(); }
    const rows = res.entries;
    const pages = Math.max(1, Math.ceil(res.total / AUDIT_PAGE));
    if (auditPage > pages) { auditPage = pages; return renderAudit(); }
    $("auditPageInfo").textContent = "Page " + auditPage + " of " + pages;
    $("auditPrev").disabled = auditPage <= 1;
    $("auditNext").disabled = auditPage >= pages;
    if (!rows.length) {
      body.innerHTML = res.total
        ? UI.emptyRow(16, { icon: "search", title: "No entries match this filter." })
        : UI.emptyRow(16, { icon: "history", title: "Nothing logged yet.",
            hint: "Adding, editing, moving or deleting cards records an entry here." });
      $("auditMeta").textContent = res.total ? res.total + " entries in the log." : "";
      return;
    }
    // An audit entry only ever recorded metadata, never an image URL - the
    // best we can do without a network round trip per row is match it back
    // to a stack still in the collection today with the same identity.
    // Genuinely no image for an entry whose stack was since deleted (honest
    // gap, not a guess) - clicking the row still looks the card up live.
    const byIdentity = new Map();
    for (const r of G.state.cards) {
      byIdentity.set([r.set, r.collector, r.lang || "en", r.finish || "nonfoil"].join("|"), r.imageUrl);
    }
    const imgFor = e => byIdentity.get([e.set, e.collector, e.lang || "en", G.finishOf(e) || "nonfoil"].join("|")) || "";
    // Only a row that names a card opens it, by click or by Enter/Space.
    const reviewable = e => !!(e && e.set && e.collector);
    body.innerHTML = rows.map((e, i) =>
      (reviewable(e) ? '<tr class="click" tabindex="0">' : "<tr>") + UI.artThumbTd(imgFor(e)) +
      '<td data-v="' + whenSort(e.ts) + '">' + G.esc(whenText(e.ts)) + "</td>" +
      '<td class="hide-sm">' + (e.by ? G.esc(e.by) : '<span class="muted">—</span>') + "</td>" +
      "<td>" + auditTag(e.action) + "</td>" +
      "<td>" + UI.cardLink(e, e.name || "—") + (G.finishOf(e) === "etched" ? ' <span class="badge etched">E</span>' : G.finishOf(e) === "foil" ? ' <span class="badge foil">F</span>' : "") + "</td>" +
      '<td class="hide-sm">' + G.esc((e.set || "").toUpperCase()) + "</td>" +
      '<td class="hide-sm">' + G.esc(e.collector || "") + "</td>" +
      '<td class="num">' + (e.qty > 0 ? "+" : "") + (e.qty || 0) + "</td>" +
      '<td class="num hide-sm">' + (e.oldQty == null ? "—" : e.oldQty) + "</td>" +
      '<td class="num hide-sm">' + (e.newQty == null ? "—" : e.newQty) + "</td>" +
      '<td class="num col-optional hide-sm">' + (e.cost == null ? "—" : G.money(e.cost)) + "</td>" +
      '<td class="col-optional hide-sm">' + G.esc(e.from || "") + "</td>" +
      '<td class="col-optional hide-sm">' + G.esc(e.to || "") + "</td>" +
      '<td class="col-optional hide-sm">' + G.esc(e.receiptId || "") + "</td>" +
      '<td class="wrap">' + G.esc(e.note || "") + "</td>" +
      "<td>" + (G.canUndoAudit(e) ? '<button class="small ghost auditundo" data-i="' + i + '">Undo</button>' : "") +
      "</td></tr>").join("");
    body.querySelectorAll(".auditundo").forEach(btn => {
      btn.onclick = stopClick(() => undoAuditRow(rows[Number(btn.dataset.i)]));
    });
    body.querySelectorAll("tr").forEach((tr, i) => {
      const e = rows[i];
      if (!reviewable(e)) return;
      UI.wireArtHover(tr, imgFor(e));
      tr.onclick = () => reviewAuditEntry(e);
      // The row's own Enter/Space, not one bubbling up from its Undo button.
      tr.onkeydown = ev => {
        if ((ev.key !== "Enter" && ev.key !== " ") || ev.target !== tr) return;
        ev.preventDefault();
        reviewAuditEntry(e);
      };
    });
    const shownFrom = (auditPage - 1) * AUDIT_PAGE + 1;
    $("auditMeta").textContent = "Showing " + shownFrom + "–" + (shownFrom + rows.length - 1) +
      " of " + res.total + " matching entries.";
    UI.reapplySorts();
  }

  async function undoAuditRow(entry) {
    const ok = await UI.confirmDialog('Undo "' + auditLabel(entry.action) + '" on ' +
      (entry.name || "this entry") + " from " + whenText(entry.ts) + "?", { title: "Undo this entry?" });
    if (!ok) return;
    const out = G.undoAuditEntry(entry);
    if (!out.ok) { UI.toast(out.message, "err"); return; }
    G.logAudit({
      action: "undo", name: entry.name, set: entry.set, collector: entry.collector,
      lang: entry.lang, finish: G.finishOf(entry), condition: entry.condition,
      qty: out.qty, from: out.from || "", to: out.to || "",
      note: 'Undid "' + entry.action + '" logged ' + whenText(entry.ts) + " - " + out.summary
    });
    G.persist("Undo: " + out.summary);
    UI.toast(out.summary + ".", "ok");
    renderAudit();
  }

  const HIST_PAGE = 400;
  function renderHistory() {
    const wrap = $("histWrap");
    const h = G.state.history;
    if (!h.length) {
      wrap.innerHTML = UI.emptyBlock({ icon: "history", title: "No events yet.",
        hint: "Shipping a pick list or building a deck records one." });
      $("histMeta").textContent = "";
      return;
    }
    const shown = h.slice(0, HIST_PAGE);
    wrap.innerHTML = shown.map(x => {
      let when; try { when = new Date(x.ts).toLocaleString(); } catch (e) { when = x.ts || ""; }
      let cols, rows;
      if (x.type === "build") {
        cols = ["Card", "Qty", "From", "To"];
        rows = (x.lines || []).map(l => [UI.cardLink(l), l.qty, G.esc(l.from || ""), G.esc(l.to || x.deck || "")]);
      } else {
        cols = ["Card", "Set", "#", "Finish", "Qty", "From"];
        rows = (x.lines || []).map(l => [UI.cardLink(l), G.esc((l.set || "").toUpperCase()),
          G.esc(l.collector || "—"), l.finish && l.finish !== "nonfoil" ? G.FINISH_NAMES[l.finish] : "", l.qty, G.esc(l.from || "")]);
      }
      const tag = x.type === "ship" ? '<span class="pill">SHIP</span>' : '<span class="pill type">BUILD</span>';
      return '<div class="hist-entry"><div class="hist-head">' + tag + " <b>" + G.esc(x.title || "") + "</b> " +
        '<span class="muted">' + G.esc(when) + "</span> — " + (x.totalCards || 0) + " card" +
        ((x.totalCards || 0) === 1 ? "" : "s") +
        (x.short ? ' <span class="short-tag">(' + x.short + " line(s) short)</span>" : "") + "</div>" +
        '<table class="list"><thead><tr>' + cols.map(c => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>";
    }).join("");
    $("histMeta").textContent = "Showing " + shown.length + " of " + h.length + " events" +
      (h.length > HIST_PAGE ? " — clear old ones or export to see the rest." : ".");
  }

  // The header's action count comes from renderAudit()'s own answer, not a
  // second whole-log query (#162).
  function setLogTab(t) {
    logTab = t;
    renderHeader();
    if (t === "audit") return renderAudit();
    renderHistory();
  }

  async function clearLog() {
    // Known from the last unfiltered answer; ask only if a filter has been
    // on the whole visit.
    let total = logTotal;
    if (total == null) {
      try { total = (await G.queryAudit({ limit: 0 })).total; }
      catch (e) { UI.toast("Couldn't load the activity log: " + e.message, "err"); return; }
    }
    if (!total) { UI.toast("The activity log is already empty.", "ok"); return; }
    // The log lives server-side now, outside the undo-snapshotted document,
    // so unlike most edits in this app, this really cannot be undone.
    const ok = await UI.confirmDialog("Clear the activity log (" + total + " entries)? This cannot be undone.",
      { title: "Clear activity log?", danger: true, okLabel: "Clear log" });
    if (!ok) return;
    $("auditClear").disabled = true;
    try { await G.clearAuditLog(); }
    catch (e) {
      UI.toast("Couldn't clear the log: " + e.message, "err");
      $("auditClear").disabled = false;
      return;
    }
    $("auditClear").disabled = false;
    UI.toast("Activity log cleared.", "ok");
    logTotal = 0;
    renderHeader();
    auditPage = 1;
    return renderAudit();
  }

  async function exportAuditCsv() {
    let rows;
    try { rows = (await G.queryAudit(Object.assign({ limit: 20000 }, auditFilter()))).entries; }
    catch (e) { UI.toast("Could not load the activity log.", "err"); return; }
    if (!rows.length) { UI.toast("No log entries to export.", "err"); return; }
    const head = ["Timestamp", "By", "Action", "Card Name", "Set", "Collector #", "Language", "Finish",
      "Qty Change", "Old Qty", "New Qty", "Cost", "From Location", "To Location", "Receipt", "Note"];
    const lines = [head.map(G.csvCell).join(",")];
    for (const e of rows) {
      lines.push([e.ts, e.by || "", e.action, e.name, (e.set || "").toUpperCase(), e.collector,
        G.LANG_NAMES[e.lang] || e.lang || "", G.FINISH_NAMES[G.finishOf(e)],
        e.qty, e.oldQty == null ? "" : e.oldQty, e.newQty == null ? "" : e.newQty,
        e.cost == null ? "" : e.cost, e.from, e.to, e.receiptId || "", e.note].map(G.csvCell).join(","));
    }
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-audit-log.csv");
    UI.toast("Exported " + rows.length + " log entries.", "ok");
  }

  function exportHistoryCsv() {
    if (!G.state.history.length) { UI.toast("No events to export.", "err"); return; }
    const head = ["Timestamp", "Type", "Event", "Card", "Set", "Collector #", "Finish", "Qty", "From", "To"];
    const lines = [head.map(G.csvCell).join(",")];
    for (const h of G.state.history) {
      for (const l of (h.lines || [])) {
        lines.push([h.ts, h.type, h.title, l.name, (l.set || "").toUpperCase(), l.collector || "",
          G.FINISH_NAMES[l.finish] || "Non-foil", l.qty, l.from || "", l.to || h.deck || ""].map(G.csvCell).join(","));
      }
    }
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-history.csv");
    UI.toast("Exported " + G.state.history.length + " events.", "ok");
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    $("auditAction").innerHTML = AUDIT_ACTIONS.map(a =>
      '<option value="' + a + '">' + (a ? a.charAt(0).toUpperCase() + a.slice(1) : "All actions") + "</option>").join("");

    const resetPage = () => { auditPage = 1; renderAudit(); };
    // Typing your own search replaces the card filter from the panel.
    $("auditSearch").addEventListener("input", G.debounce(() => {
      if (cardFilter) { cardFilter = null; UI.cardFilterChip(null, null); }
      resetPage();
    }, 150));
    $("auditAction").onchange = resetPage;
    $("auditPrev").onclick = () => { if (auditPage > 1) { auditPage--; renderAudit(); } };
    $("auditNext").onclick = () => { auditPage++; renderAudit(); };
    let compact = false;
    try { compact = localStorage.getItem("grimoire.auditCompact") === "1"; } catch (e) { /* storage blocked */ }
    $("auditCompact").checked = compact;
    $("auditTable").classList.toggle("compact-cols", compact);
    $("auditCompact").onchange = () => {
      try { localStorage.setItem("grimoire.auditCompact", $("auditCompact").checked ? "1" : "0"); } catch (e) { /* storage blocked */ }
      $("auditTable").classList.toggle("compact-cols", $("auditCompact").checked);
    };
    $("auditExport").onclick = exportAuditCsv;
    // Store staff can't clear the shared log (the server refuses them too).
    $("auditDanger").hidden = !G.canClearAuditLog();
    $("auditClear").onclick = clearLog;
    $("histExport").onclick = exportHistoryCsv;
    $("histClear").onclick = async () => {
      if (!G.state.history.length) return;
      const ok = await UI.confirmDialog("Clear the ship/build event log (" + G.state.history.length + " events)?",
        { title: "Clear event log?", danger: true, okLabel: "Clear log" });
      if (!ok) return;
      G.state.history = [];
      G.persist("Clear ship/build events");
      renderHistory();
      renderHeader();
    };

    G.on("change", () => { if (logTab === "audit") renderAudit(); else { renderHistory(); renderHeader(); } });
    showCardChip();
    // The tab is remembered (UI.pageTabs); onShow loads what that tab shows.
    UI.pageTabs({ tabs: [
      { id: "audit", button: "tabAudit", panes: ["paneAudit"] },
      { id: "events", button: "tabEvents", panes: ["paneEvents"] }
    ], onShow: setLogTab });
  });
})();
