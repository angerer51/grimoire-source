
"use strict";
(function () {
  const $ = UI.$;
  let kind = "collection";
  let entryMode = "search";
  // #353: the add box's Card / Sealed switch (Sealed is full mode only).
  // Sealed lines sit in the same lot drafts as cards, marked item: "sealed".
  let item = "card";
  let sealedPicked = null;
  let movedSealedDraft = false;
  const isSealed = l => !!l && l.item === "sealed";
  /* TCGplayer's public product-image CDN, keyed by the tcgplayer_product_id
     Manapool's sealed catalog already gives us: no credentials needed. */
  const tcgImageUrl = id => "https://tcgplayer-cdn.tcgplayer.com/product/" + encodeURIComponent(id) + "_200w.jpg";
  // Set from G.simpleMode once UI.boot's callback runs (G.state.settings
  // isn't populated until G.load() resolves, so this can't be read at
  // module-parse time the way `kind`/`entryMode` above are initialised).
  let simpleMode = false;
  // Staff in a store (#159): the putaway checkbox and the lot allocation are
  // the store's defaults, set by its managers, so they're read-only here.
  let storeLocked = false;
  let printings = [];
  let printingGroups = []; // printings deduped by set+collector - language comes from the Language field, not this list
  let preview = null;
  let transfer = null;
  let addQueue = [];
  let queueRunning = false, queueSeq = 0, pruneTimer = null;

  /* Row click reviews a draft/historical line - shared by every line table
     on this page (lot/transfer/ledger/receipt history). None of them are a
     posted stack yet (or, for history, may no longer match one), so this
     always does a live (cached) card lookup rather than assuming a
     CardPanel-record shape those lines don't actually have. */
  async function reviewLine(l) {
    if (!l || !l.set || !l.collector) return;
    let card;
    try { card = await G.cards.one(l.set, l.collector, l.lang || "en"); }
    catch (e) { return; }
    if (card) UI.reviewCard(card, l.finish);
  }

  /* Lot drafts live in the collection document, so a half-entered box
     survives a reload and shows up on whatever device you carry to the
     table - and now there can be more than one open at once (counting in
     two boxes from two sellers, say), switched between with the tab strip
     rendered by renderDraftTabs(). */
  function newDraft() {
    return {
      id: G.uid(), receiptId: "", source: "", date: "", spend: "",
      alloc: G.state.settings.lotAllocation || "market", note: "", lines: []
    };
  }
  function drafts() {
    const s = G.state.settings;
    if (!Array.isArray(s.draftLots)) {
      s.draftLots = [];
      // Migrate the old single-draft shape, but only if it actually had
      // something in it - an empty untouched draft isn't worth carrying
      // forward as a phantom entry.
      const old = s.draftLot;
      if (old && typeof old === "object" && (
        (Array.isArray(old.lines) && old.lines.length) || old.receiptId || old.source || old.spend || old.note
      )) {
        s.draftLots.push(Object.assign({ id: G.uid() }, old, { lines: Array.isArray(old.lines) ? old.lines : [] }));
      }
      delete s.draftLot;
    }
    // #353: the old Receive Sealed page kept its one lot draft apart
    // (settings.draftSealedLot). It becomes a normal draft tab, its lines
    // marked sealed, so nothing typed there is lost.
    const sd = s.draftSealedLot;
    if (sd && typeof sd === "object") {
      const lines = Array.isArray(sd.lines) ? sd.lines : [];
      if (lines.length || sd.receiptId || sd.source || sd.spend || sd.note) {
        const moved = Object.assign(newDraft(), {
          receiptId: sd.receiptId || "", source: sd.source || "", date: sd.date || "", spend: sd.spend == null ? "" : sd.spend,
          alloc: sd.alloc || "market", note: sd.note || "",
          lines: lines.map(l => Object.assign({ id: G.uid(), manualCost: null }, l, { item: "sealed" }))
        });
        // An empty, untouched draft tab isn't worth keeping next to it.
        s.draftLots = s.draftLots.filter(d => (Array.isArray(d.lines) && d.lines.length) || d.receiptId || d.source || d.spend || d.note);
        s.draftLots.push(moved);
        s.activeDraftLotId = moved.id;
        movedSealedDraft = true;
      }
      delete s.draftSealedLot;
    }
    for (const d of s.draftLots) {
      if (!d.id) d.id = G.uid();
      if (!Array.isArray(d.lines)) d.lines = [];
    }
    if (!s.draftLots.length) s.draftLots.push(newDraft());
    if (!s.activeDraftLotId || !s.draftLots.some(d => d.id === s.activeDraftLotId)) {
      s.activeDraftLotId = s.draftLots[0].id;
    }
    return s.draftLots;
  }
  function draft() {
    const list = drafts();
    return list.find(d => d.id === G.state.settings.activeDraftLotId) || list[0];
  }
  const saveDraft = () => G.persistSettings();

  function switchDraft(id) {
    G.state.settings.activeDraftLotId = id;
    saveDraft();
    renderLot();
  }
  function createDraft() {
    const d = newDraft();
    drafts().push(d);
    G.state.settings.activeDraftLotId = d.id;
    saveDraft();
    renderLot();
  }
  async function discardDraft(id) {
    const list = drafts();
    const d = list.find(x => x.id === id);
    if (!d) return;
    if (d.lines.length) {
      const ok = await UI.confirmDialog("Discard this draft receipt (" + d.lines.length + " line(s))? Nothing has been added to inventory yet.",
        { title: "Discard draft?", danger: true });
      if (!ok) return;
    }
    const i = list.indexOf(d);
    list.splice(i, 1);
    if (!list.length) list.push(newDraft());
    if (G.state.settings.activeDraftLotId === id) {
      G.state.settings.activeDraftLotId = list[Math.min(i, list.length - 1)].id;
    }
    saveDraft();
    renderLot();
  }

  /* ============================== Import-a-file sub-mode ============================== */
  let transferMode = "xfer";
  function setTransferMode(m) {
    transferMode = m;
    $("modeXferFile").classList.toggle("active", m === "xfer");
    $("modeTcgSheet").classList.toggle("active", m === "tcg");
    $("xferFileSection").hidden = m !== "xfer";
    $("tcgSheetSection").hidden = m !== "tcg";
    if (m === "tcg") UI.fillLocationSelect($("tcgDest"), null, { anyLabel: "— choose a destination —" });
  }

  /* ============================== Kind switch ============================== */
  /* Sources (#353): "collection" = Already mine, "lot" = Bought, "manapool" =
     Mana Pool order (a purchase list on the left, the lot receipt it fills
     in the middle), "transfer" = File. */
  function setKind(k) {
    // Lot receipts and transfer/CSV imports are business-seller flows -
    // simple mode never leaves "Already mine", regardless of what's
    // asked for (a stray in-progress lot draft from before simple mode was
    // turned on, say).
    if (simpleMode) k = "collection";
    kind = k;
    $("srcMine").classList.toggle("active", k === "collection");
    $("srcBought").classList.toggle("active", k === "lot");
    $("srcManapool").classList.toggle("active", k === "manapool");
    $("srcFile").classList.toggle("active", k === "transfer");
    $("entrySection").hidden = k === "transfer" || k === "manapool";
    $("transferSection").hidden = k !== "transfer";
    $("mpSection").hidden = k !== "manapool";
    $("lotSection").hidden = k !== "lot" && k !== "manapool";
    // The receipt box carries two tabs under Bought only (#444); elsewhere it
    // is just the receipt.
    $("rcptTabs").hidden = k !== "lot";
    showRcptTab(k === "lot" ? rcptTab : "this");
    if (k === "lot") renderFloor();
    $("xferSection").hidden = !(k === "transfer" && transfer);
    $("lotLineRow").hidden = k !== "lot";
    $("sldCostRow").hidden = k !== "lot";
    $("ledgerSection").hidden = k !== "collection" || simpleMode;
    syncEntryLabels();
    // A pasted list or card-list file has no cost basis, same as the rest of
    // "Already mine" - it makes no sense for a lot receipt or a transfer, so
    // it is not offered there. Simple mode keeps it (#240): it only ever adds
    // cards you own.
    $("modeImport").hidden = k !== "collection";
    if (k !== "collection" && entryMode === "import") setMode("search");
    if (k === "lot" || k === "manapool") renderLot();
    if (k === "manapool") openPurchases();
    if (k === "collection") renderLedger();
    UI.setStatus("entryStatus", "", "");
  }

  function syncEntryLabels() {
    const lot = kind === "lot";
    $("entryTitle").textContent = (item === "sealed" ? "Add sealed product" : "Add a card") + (lot ? " to the lot" : "");
    $("btnAdd").textContent = lot ? "Add to lot" : "Add card";
    $("sldAdd").textContent = lot ? "Add to lot" : "Add sealed product";
  }

  /* ============================== Sealed product (#353) ==============================
     Folded in from the old Receive Sealed page. Already mine adds straight to
     Sealed inventory with no cost; Bought adds a line to the open lot draft,
     where it shares the spend with any card lines. */
  function setItem(i) {
    if (simpleMode) i = "card";
    item = i;
    $("itemCard").classList.toggle("active", i === "card");
    $("itemSealed").classList.toggle("active", i === "sealed");
    $("cardEntry").hidden = i !== "card";
    $("sealedEntry").hidden = i !== "sealed";
    $("csvImportSection").hidden = !(i === "card" && entryMode === "import");
    $("preview").hidden = i !== "card";
    $("sealedPreview").hidden = i !== "sealed";
    syncEntryLabels();
    UI.setStatus("entryStatus", "", "");
    if (i === "sealed") {
      UI.fillLocationSelect($("sldLoc"), $("sldLoc").value || $("inLoc").value, {});
      renderSealedPreview(sealedPicked);
      $("sldSearch").focus();
    }
    if (kind === "collection" && !simpleMode) renderLedger();
  }

  function mountProductPicker() {
    const list = $("sldAcList");
    let results = [];
    // mousedown (not click) so the pick lands before the input's blur hides the list.
    list.onmousedown = e => {
      const hit = e.target && e.target.closest && e.target.closest(".ac-item");
      const p = hit && results[Number(hit.dataset.i)];
      if (!p) return;
      e.preventDefault();
      list.hidden = true;
      pickSealed(p);
    };
    function renderResults(found) {
      results = found;
      if (!results.length) { list.hidden = true; return; }
      list.innerHTML = results.map((p, i) =>
        '<div class="ac-item" data-i="' + i + '">' + G.esc(p.name) +
        ' <span class="muted">' + G.esc(String(p.setCode || "").toUpperCase()) + "</span></div>").join("");
      list.hidden = false;
    }
    const search = G.debounce(async () => {
      const q = $("sldSearch").value.trim();
      if (sealedPicked && q !== sealedPicked.name) { sealedPicked = null; syncSealedPicked(); }
      if (q.length < 2) { list.hidden = true; return; }
      try {
        const d = await G.api("/api/sealed/search?q=" + encodeURIComponent(q));
        renderResults(d.data || []);
      } catch (e) { list.hidden = true; }
    }, 180);
    $("sldSearch").addEventListener("input", search);
    $("sldSearch").addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 150));
  }

  function renderSealedPreview(p) {
    const el = $("sealedPreview");
    if (!p) {
      el.innerHTML = '<div class="pt">Product preview</div><div class="empty">Search a product name to see it here.</div>';
      return;
    }
    el.innerHTML = '<div class="pt">Product preview</div>' +
      '<img id="sldImg" alt="' + G.esc(p.name) + '" style="width:100%;display:block">' +
      '<h3 style="margin:10px 0 2px">' + G.esc(p.name) + "</h3>" +
      '<div class="muted">' + G.esc(String(p.setCode || "").toUpperCase()) + "</div>" +
      '<div style="margin-top:10px">' +
        (p.marketPrice != null ? "<div>Market: <b>" + G.money(p.marketPrice) + "</b></div>" : "") +
        (p.lowPrice != null ? "<div>Low: " + G.money(p.lowPrice) + "</div>" : "") +
      "</div>";
    // Not an inline onerror= attribute: the CSP blocks inline handlers.
    const img = $("sldImg");
    img.onerror = () => { img.style.display = "none"; };
    img.src = tcgImageUrl(p.tcgplayerProductId);
  }

  function syncSealedPicked() {
    $("sldPickedNote").hidden = !sealedPicked;
    $("sldPickedName").textContent = sealedPicked ? sealedPicked.name : "";
    renderSealedPreview(sealedPicked);
  }

  function pickSealed(p) {
    sealedPicked = p;
    $("sldSearch").value = p.name;
    syncSealedPicked();
    UI.setStatus("entryStatus", "", "");
    $("sldQty").focus();
  }

  function resetSealedEntry() {
    sealedPicked = null;
    $("sldSearch").value = "";
    $("sldQty").value = "1";
    $("sldCost").value = "";
    syncSealedPicked();
    $("sldSearch").focus();
  }

  function submitSealed() {
    const p = sealedPicked;
    if (!p) { UI.setStatus("entryStatus", "Pick a product from the search results first.", "err"); return; }
    const qty = Math.max(1, parseInt($("sldQty").value, 10) || 1);
    const locationId = $("sldLoc").value;
    if (!locationId || !G.locById(locationId)) { UI.setStatus("entryStatus", "Choose a storage location.", "err"); return; }
    if (kind === "lot") {
      const manual = parseFloat($("sldCost").value);
      const d = draft();
      const line = {
        id: G.uid(), ts: new Date().toISOString(), item: "sealed",
        tcgplayerProductId: p.tcgplayerProductId, manapoolProductId: p.manapoolProductId,
        name: p.name, setCode: p.setCode, market: p.marketPrice == null ? null : p.marketPrice,
        qty, locationId, manualCost: isNaN(manual) ? null : Math.max(0, manual)
      };
      const same = d.lines.find(l => isSealed(l) && l.tcgplayerProductId === line.tcgplayerProductId &&
        l.locationId === line.locationId && (l.manualCost == null) === (line.manualCost == null));
      if (same) { same.qty += line.qty; same.ts = line.ts; } else d.lines.push(line);
      saveDraft();
      renderLot();
      UI.setStatus("entryStatus", "Added " + qty + "× " + p.name + " to the lot (" +
        d.lines.reduce((s, l) => s + l.qty, 0) + " items on the receipt).", "ok");
    } else {
      G.addSealedCopies({
        tcgplayerProductId: p.tcgplayerProductId, manapoolProductId: p.manapoolProductId,
        name: p.name, setCode: p.setCode, locationId, qty,
        price: p.marketPrice, unitCost: null,
        note: "Added from sealed catalog (no cost basis)"
      });
      G.persist();
      UI.setStatus("entryStatus", "✓ Added " + qty + "× " + p.name + " → " + G.locName(locationId) + ".", "ok");
      renderLedger();
    }
    resetSealedEntry();
  }

  /* ============================== Entry form ============================== */
  function setMode(m) {
    entryMode = m;
    syncAddEnabled();
    const search = m === "search";
    const csv = m === "import";
    $("lblName").hidden = !search;
    $("lblPrint").hidden = !search;
    $("lblSet").hidden = search || csv;
    $("lblNum").hidden = search || csv;
    $("lblSetSticky").hidden = search || csv;
    if ($("keepFinish").checked) autoPickFinish(null);
    $("modeSearch").classList.toggle("active", search);
    $("modeManual").classList.toggle("active", m === "manual");
    $("modeImport").classList.toggle("active", csv);
    $("entryFields").hidden = csv;
    $("entryToolbar").hidden = csv;
    $("csvImportSection").hidden = !csv || item !== "card";
    updatePickedNote();
    if (csv) { syncTray(); UI.setStatus("entryStatus", "", ""); UI.fillLocationSelect($("csvDest"), null, { anyLabel: "— choose a destination —" }); return; }
    if (search) $("inSearch").focus();
    else { $("inSet").focus(); manualPreview(); }
  }

  // One dropdown entry per (set, collector) - a name can print the same collector
  // number in several languages (Secret Lairs, Commander sets, some core sets),
  // but which of those languages you want is the Language field's job, not this
  // dropdown's - so entries are deduped down to the physical printing.

  async function loadPrintings(name) {
    if ($("keepFinish").checked) autoPickFinish(null);
    const sel = $("inPrinting");
    sel.innerHTML = '<option value="">Loading…</option>';
    preview.bump();
    preview.message("Loading…");
    UI.setStatus("entryStatus", 'Loading printings for "' + name + '" …', "work");
    try {
      printings = await G.cards.printings(name);
      if (!printings.length) throw new Error("No printings found for that name.");
      printingGroups = G.sortPrintingsNewest(G.groupPrintings(printings), G.englishOf);
      $("inPrintFilter").value = "";
      $("inPrintFilter").hidden = false;
      $("inPrintTip").hidden = false;
      // No default: the first printing is often the oldest and priciest, so the
      // list starts on a placeholder and Add waits for a real pick (#236).
      sel.value = "";
      renderPrintingOptions();
      showPicked();
      UI.setStatus("entryStatus", "Loaded " + printingGroups.length + " printing" + (printingGroups.length === 1 ? "" : "s") +
        " — choose the one you own, then Add.", "ok");
    } catch (e) {
      sel.innerHTML = '<option value="">— none found —</option>';
      $("inPrintFilter").hidden = true; $("inPrintTip").hidden = true;
      printings = []; printingGroups = [];
      syncAddEnabled();
      preview.clear();
      UI.setStatus("entryStatus", "✗ " + e.message, "err");
    }
  }

  // Fill the Printing list from printingGroups (newest first), keeping only
  // those matching the filter box. The option value is the index into
  // printingGroups. A pick the filter hides is dropped, so Add goes back to
  // waiting for a real choice (#324).
  function renderPrintingOptions() {
    const sel = $("inPrinting");
    const text = $("inPrintFilter").value;
    const keep = sel.value;
    const rows = [];
    printingGroups.forEach((g, i) => {
      if (G.printingMatches(G.englishOf(g), text))
        rows.push('<option value="' + i + '">' + G.esc(G.printingChoiceLabel(G.englishOf(g))) + "</option>");
    });
    sel.innerHTML = '<option value="">' + (rows.length ? "Choose a printing…" : "No printing matches that") + "</option>" + rows.join("");
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : "";
  }

  // The chosen card's name (and a small picture) beside the Add button, so a
  // phone shows what is about to be added without scrolling (#324).
  function updatePickedNote() {
    const c = entryMode === "import" ? null : currentPicked();
    $("pickedNote").hidden = !c;
    if (!c) return;
    $("pickedName").textContent = G.cardName(c) + " · " + String(c.set).toUpperCase() + " #" + c.collector;
    const img = $("pickedThumb");
    img.hidden = !c.imageUrl;
    if (c.imageUrl) img.src = c.imageUrl.replace(/\/(normal|large)\//, "/small/");
  }

  // The chosen printing group, or undefined while the list sits on its
  // placeholder ("" / "Loading…" / "none found" all have no number).
  const pickedGroup = () => printingGroups[parseInt($("inPrinting").value, 10)];

  /* The collector number as typed: "147/271" (as printed on the card) means
     147, and leading zeros ("007") are dropped (#330). */
  function numVal() {
    return G.normNum(String($("inNum").value).split("/")[0]);
  }
  function currentPicked() {
    if (entryMode === "search") {
      const g = pickedGroup();
      if (!g) return null;
      const lang = $("inLang").value || "en";
      return g.cards.find(c => (c.lang || "en") === lang) || null;
    }
    return G.cardCache.get(G.printKey($("inSet").value.trim(), numVal(), $("inLang").value)) || null;
  }

  /* A printing that only comes in one finish (foil-only, etched-only) picks
     that finish itself, so it can't be added as a Non-foil with no price
     (#326). Finishes the printing doesn't come in are greyed out; a printing
     with several finishes keeps whatever is picked, unless that one isn't
     offered. */
  let userFinish = "nonfoil";   // the finish the person last chose themselves (the menu starts on Non-foil)
  function autoPickFinish(c, sel) {
    sel = sel || $("inFoil");
    const f = (c && c.finishes || []).filter(x => G.FINISHES.includes(x));
    for (const o of sel.options) o.disabled = f.length > 0 && !f.includes(o.value);
    // Back to their own choice when this printing offers it; an auto-picked
    // finish never sticks to the next card.
    if (userFinish && (!f.length || f.includes(userFinish))) sel.value = userFinish;
    else if (f.length && !f.includes(sel.value)) sel.value = f[0];
    if (sel === $("inFoil")) {
      // A locked finish this printing doesn't have: it says so, and comes back next card.
      const moved = $("keepFinish").checked && sel.value !== userFinish;
      $("keepFinishNote").hidden = !moved;
      $("keepFinishNote").textContent = moved ? "No " + G.FINISH_NAMES[userFinish] + " in this printing, so this one is " +
        G.FINISH_NAMES[sel.value] + ". " + G.FINISH_NAMES[userFinish] + " stays locked." : "";
    }
  }
  // The finish a queued add or lot line really gets: looked up, and switched
  // if the printing doesn't come in the one asked for (Enter before the
  // preview ran), then priced for that finish.
  async function lookupFitted(job) {
    let info = await G.lookupCard(job.set, job.num, job.lang, job.finish);
    const f = G.fitFinish(info.card, job.finish);
    if (f !== job.finish) {
      // Moving off the untouched default isn't news; moving off a choice is.
      if (job.finish !== "nonfoil" || $("keepFinish").checked) job.fittedFrom = job.finish;
      job.finish = f;
      info = await G.lookupCard(job.set, job.num, job.lang, f);
    }
    return info;
  }
  // What lookupFitted changed, for the status line (#398).
  const fittedNote = job => (job.fittedFrom ? " This printing doesn't come in " + G.FINISH_NAMES[job.fittedFrom] +
    ", so it went in as " + G.FINISH_NAMES[job.finish] + "." : "");

  function showPicked() {
    showPickedInner();
    updatePickedNote();
  }

  function showPickedInner() {
    const g = entryMode === "search" ? pickedGroup() : null;
    if (entryMode === "search") {
      if (!g) {
        $("inSet").value = ""; $("inNum").value = "";
        if (printingGroups.length) preview.message("Choose a printing to see it here.");
        else preview.clear();
        syncAddEnabled();
        return;
      }
      $("inSet").value = g.set;
      $("inNum").value = g.collector;
    }
    syncAddEnabled();
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
    autoPickFinish(c);
    const finish = $("inFoil").value;
    const price = preview.showCard(c, finish, "", { qty: qty() });
    UI.chime(price, c.set + "|" + c.collector + "|" + finish);
    applyAutoPutaway(c, finish);
  }

  // Name-search mode: Add waits until a printing is picked. Set + number and
  // the other modes name an exact printing themselves.
  function syncAddEnabled() {
    $("btnAdd").disabled = entryMode === "search" && !!printingGroups.length && !pickedGroup();
  }

  const manualPreview = G.debounce(async () => {
    if (entryMode !== "manual") return;
    autoPickFinish(G.cardCache.get(G.printKey($("inSet").value.trim(), numVal(), $("inLang").value)));
    const finish = $("inFoil").value;
    const card = await preview.showBySetNumber($("inSet").value, numVal(), $("inLang").value, finish);
    if (card) {
      autoPickFinish(card);
      if ($("inFoil").value !== finish) { manualPreview(); return; }  // finish was auto-picked: show that one
      applyAutoPutaway(card, finish);
    }
    updatePickedNote();
  }, 260);

  const qty = () => Math.max(1, parseInt($("inQty").value, 10) || 1);

  /* Two ways to work, and the UI has to make clear which one you are in:
     receive straight to a shelf (putaway decides now), or receive into a sorting
     tray and file the whole tray afterwards. Choosing a tray disables the
     putaway checkbox, because filing happens later by definition. */
  function syncTray() {
    if (entryMode === "import") { $("trayHint").hidden = true; return; }
    const loc = G.locById($("inLoc").value);
    const tray = !!(loc && loc.staging);
    const box = $("autoPutaway");
    box.disabled = tray || storeLocked;
    const hint = $("trayHint");
    if (simpleMode) {
      hint.hidden = true; // sorting trays and Putaway are business-mode tools (#325)
    } else if (tray) {
      const st = G.locStats(loc.id);
      hint.hidden = false;
      hint.innerHTML = "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#inbox></use></svg> <b>" + G.esc(loc.name) + "</b> is a sorting tray: nothing gets filed yet. It holds " +
        st.cards + " card" + (st.cards === 1 ? "" : "s") + '. <a href="/putaway.html?bin=' + encodeURIComponent(loc.id) + '">Empty it from Putaway</a> when you are done.';
    } else if (G.stagingBins().length) {
      const b = G.stagingBins()[0];
      hint.hidden = false;
      hint.innerHTML = '<span class="faint">Filing straight to a shelf. If you would rather count a whole box in ' +
        'first, pick <b>' + G.esc(b.name) + "</b> as the location and empty it later from Putaway.</span>";
    } else {
      hint.hidden = true;
    }
  }

  /* When the box is ticked, the location select follows the putaway rules for
     whatever card is on screen - so the common case is zero clicks. */
  function trayChosen() {
    const loc = G.locById($("inLoc").value);
    return !!(loc && loc.staging);
  }
  function applyAutoPutaway(card, finish) {
    if (G.simpleMode || !$("autoPutaway").checked || trayChosen() || $("keepLoc").checked || !card) return;
    const shaped = Object.assign({}, card, { finish, price: G.priceOf(card, finish), quantity: qty() });
    const s = G.suggestLocation(shaped, { qty: qty() });
    if (s.best) {
      $("inLoc").value = s.best.locationId;
      UI.setStatus("entryStatus", "Putaway → " + s.best.name +
        (s.best.rules.length ? " (" + s.best.rules.map(G.ruleText).join("; ") + ")" : " (catch-all)"), "ok");
    } else if (s.considered) {
      UI.setStatus("entryStatus", "No location's putaway rules match this card — pick one yourself." +
        (s.blocked.length ? " " + s.blocked[0].name + " matches but is full." : ""), "work");
    }
  }

  /* The last location used, remembered per person in this browser (#330). */
  const lastLocKey = () => "grimoire.receiveLoc." + ((G.me && (G.me.id || G.me.username)) || "");
  function saveLastLoc(id) { try { localStorage.setItem(lastLocKey(), id); } catch (e) { /* private window */ } }
  function loadLastLoc() { try { return localStorage.getItem(lastLocKey()); } catch (e) { return null; } }

  /* The Keep locks (#398): a locked field holds its value after an add. Per
     person, on this device, like the last location: a Store's staff share
     G.state.settings, and one person's run of foils isn't the next person's. */
  const KEEP = { keepFinish: "inFoil", keepCondition: "inCondition", keepLang: "inLang", keepLoc: "inLoc" };
  const keepKey = () => "grimoire.receiveKeep." + ((G.me && (G.me.id || G.me.username)) || "");
  const keepValue = field => (field === "inFoil" ? userFinish : $(field).value);
  function saveKeep() {
    const out = {};
    for (const [box, field] of Object.entries(KEEP)) if ($(box).checked) out[field] = keepValue(field);
    try { localStorage.setItem(keepKey(), JSON.stringify(out)); } catch (e) { /* private window */ }
  }
  function loadKeep() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(keepKey())) || {}; } catch (e) { /* private window, or not ours */ }
    for (const [box, field] of Object.entries(KEEP)) {
      if (!Object.prototype.hasOwnProperty.call(saved, field)) continue;
      $(box).checked = true;
      // A location since deleted stays locked on whatever the page chose instead.
      const was = $(field).value;
      $(field).value = saved[field];
      if ($(field).value !== saved[field]) $(field).value = was;
    }
    if ($("keepFinish").checked) userFinish = $("inFoil").value;
  }

  /* ============================== Add ============================== */
  function validate() {
    const set = $("inSet").value.trim();
    const num = numVal();
    const locationId = $("inLoc").value;
    if (!G.state.locations.length) {
      setLocationsLink("Create a storage location first on the ", "err");
      return null;
    }
    if (!set || !num) {
      UI.setStatus("entryStatus", entryMode === "search"
        ? "Search for a card and choose a printing first."
        : "Enter a set code and collector number.", "err");
      return null;
    }
    if (entryMode === "search" && !currentPicked()) {
      UI.setStatus("entryStatus", "This printing isn't available in " +
        (G.LANG_NAMES[$("inLang").value] || $("inLang").value) + " — pick a different language.", "err");
      return null;
    }
    if (!locationId || !G.locById(locationId)) {
      UI.setStatus("entryStatus", "Choose a storage location.", "err");
      return null;
    }
    return {
      set: set.toLowerCase(), num, lang: $("inLang").value,
      finish: $("inFoil").value, condition: $("inCondition").value, locationId, qty: qty()
    };
  }

  /* Finish, language and condition go back to their defaults after every add,
     so one Japanese foil doesn't turn the next three cards into Japanese
     foils (#330). Grimoire has no default-language setting, so that is English. */
  function resetCardOptions() {
    if (!$("keepFinish").checked) { userFinish = "nonfoil"; $("inFoil").value = "nonfoil"; }
    if (!$("keepLang").checked) $("inLang").value = "en";
    if (!$("keepCondition").checked) $("inCondition").value = G.defaultCondition();
    autoPickFinish(null);
  }

  function resetEntry() {
    resetCardOptions();
    if (entryMode === "search") {
      $("inSearch").value = "";
      $("inPrinting").innerHTML = '<option value="">— pick a card first —</option>';
      $("inPrintFilter").hidden = true; $("inPrintFilter").value = ""; $("inPrintTip").hidden = true;
      printings = []; printingGroups = [];
      syncAddEnabled();
      $("inSet").value = ""; $("inNum").value = "";
      $("inQty").value = "1";
      $("inSearch").focus();
    } else {
      if (!$("inSetSticky").checked) $("inSet").value = "";
      $("inNum").value = ""; $("inQty").value = "1";
      ($("inSetSticky").checked ? $("inNum") : $("inSet")).focus();
    }
    updatePickedNote();
  }

  function submitAdd() {
    const job = validate();
    if (!job) return;
    if (kind === "lot") return addLotLine(job);

    const picked = currentPicked();
    addQueue.push(Object.assign({}, job, {
      jid: "q" + (++queueSeq), ts: new Date().toISOString(),
      label: picked ? G.cardName(picked) : (job.set.toUpperCase() + " #" + job.num),
      printing: picked ? G.printingLabel(picked.set, picked.collector, picked.setName) : G.printingLabel(job.set, job.num, ""),
      status: "queued", error: "", price: null
    }));
    renderQueue();
    UI.setStatus("entryStatus", "Queued " + job.qty + "× " +
      (picked ? G.cardName(picked) : job.set.toUpperCase() + " #" + job.num) +
      " " + optionsNote(job, true) + "→ " + G.locName(job.locationId) + ". Keep adding.", "work");
    resetEntry();
    runQueue();
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      for (;;) {
        const job = addQueue.find(j => j.status === "queued");
        if (!job) break;
        job.status = "working"; renderQueue();
        try {
          if (!G.locById(job.locationId)) throw new Error("That storage location no longer exists.");
          const info = await lookupFitted(job);
          const rec = G.addCopies({
            set: job.set, num: job.num, lang: job.lang, finish: job.finish, condition: job.condition,
            locationId: job.locationId, qty: job.qty, info,
            action: "add", note: "Added from collection (no cost basis)"
          });
          G.persist();
          job.status = "added"; job.label = info.name; job.price = info.price;
          job.printing = G.printingLabel(rec.set, rec.collector, rec.setName);
          UI.chime(info.price, job.set + "|" + job.num + "|" + job.finish);
          UI.setStatus("entryStatus", "✓ Added " + job.qty + "× " + info.name + " [" + job.printing + "] " +
            optionsNote(job, true) + G.money(info.price) + " → " + G.locName(job.locationId) +
            (rec.quantity > job.qty ? " (you now have " + rec.quantity + " of this card there)" : " (now " + rec.quantity + " there)") +
            (info.note || "") + fittedNote(job), job.fittedFrom ? "work" : "ok");
        } catch (err) {
          job.status = "error";
          job.error = err.message || String(err);
          UI.setStatus("entryStatus", "✗ " + job.label + ": " + job.error, "err");
        }
        renderQueue();
      }
    } finally { queueRunning = false; }
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(() => {
      if (addQueue.some(j => j.status === "queued" || j.status === "working")) return;
      addQueue = addQueue.filter(j => j.status === "error");
      renderQueue();
    }, 6000);
  }

  // Finish, language and condition, only the ones that aren't the defaults.
  function optionsNote(j, paren) {
    const bits = [];
    if (j.finish && j.finish !== "nonfoil") bits.push(G.FINISH_NAMES[j.finish].toLowerCase());
    if (j.lang && j.lang !== "en") bits.push(G.LANG_NAMES[j.lang] || j.lang);
    if (j.condition && j.condition !== G.defaultCondition()) bits.push(G.CONDITION_NAMES[j.condition] || j.condition);
    if (!bits.length) return "";
    return paren ? "(" + bits.join(", ") + ") " : " · " + bits.join(" · ");
  }

  // Short tag in its own non-shrinking spot, so a long card name can't hide it.
  function queueOpts(j) {
    const bits = [], full = [];
    if (j.finish && j.finish !== "nonfoil") { bits.push(j.finish === "etched" ? "Etched" : G.FINISH_NAMES[j.finish]); full.push(G.FINISH_NAMES[j.finish]); }
    if (j.lang && j.lang !== "en") { bits.push(j.lang.toUpperCase()); full.push(G.LANG_NAMES[j.lang] || j.lang); }
    if (j.condition && j.condition !== G.defaultCondition()) { bits.push(j.condition); full.push(G.CONDITION_NAMES[j.condition] || j.condition); }
    return (bits.length ? '<span class="qopts" title="' + G.esc(full.join(", ")) + '">' + G.esc(bits.join(" · ")) + "</span>" : "") +
      (j.fittedFrom ? '<span class="short-tag" title="' + G.esc(fittedNote(j).trim()) + '">Not ' + G.esc(G.FINISH_NAMES[j.fittedFrom]) + "</span>" : "");
  }

  function renderQueue() {
    const box = $("queueBox"), list = $("queueList");
    if (!addQueue.length) { box.hidden = true; list.innerHTML = ""; return; }
    const pending = addQueue.filter(j => j.status === "queued" || j.status === "working").length;
    const done = addQueue.filter(j => j.status === "added").length;
    const bad = addQueue.filter(j => j.status === "error").length;
    $("queueTitle").textContent = "Add queue — " + pending + " pending" +
      (done ? ", " + done + " added" : "") + (bad ? ", " + bad + " failed" : "");
    box.hidden = false;
    list.innerHTML = addQueue.map(j => {
      const label = { queued: "IN QUEUE", working: "ADDING…", added: "ADDED ✓", error: "FAILED" }[j.status];
      return '<div class="queue-item"><div class="qline"><span class="st ' + j.status + '">' + label + "</span>" +
        '<span class="qname">' + j.qty + "× " +
          (j.label === String(j.set || "").toUpperCase() + " #" + j.num ? G.esc(j.label)
            : UI.cardLink({ name: j.label, set: j.set, collector: j.num, finish: j.finish }, j.label)) +
        ' <span class="muted">' + G.esc(j.printing) + "</span></span></div><div class=\"qmeta\">" + queueOpts(j) +
        (j.status === "added" && j.price != null ? '<span class="muted">' + G.money(j.price) + "</span>" : "") +
        (j.status === "error" ? '<span class="short-tag" title="' + G.esc(j.error) + '">' + G.esc(j.error.slice(0, 40)) + "</span>" : "") +
        '<span class="muted">' + G.esc(G.locName(j.locationId)) + "</span></div></div>";
    }).join("");
  }

  /* ============================== Lot receipt ============================== */
  async function addLotLine(job) {
    const d = draft();
    UI.setStatus("entryStatus", "Looking up " + job.set.toUpperCase() + " #" + job.num + "…", "work");
    let info;
    try { info = await lookupFitted(job); }
    catch (e) { UI.setStatus("entryStatus", "✗ " + e.message, "err"); return; }

    const manual = parseFloat($("inLineCost").value);
    const line = {
      id: G.uid(),
      ts: new Date().toISOString(),
      set: job.set, collector: info.collector || job.num, lang: job.lang, finish: job.finish,
      condition: job.condition,
      name: info.name, setName: info.setName, rarity: info.rarity,
      scryfallId: info.scryfallId, tcgplayerId: info.tcgplayerId, imageUrl: info.card.imageUrl || "",
      market: info.price, qty: job.qty, locationId: job.locationId,
      manualCost: isNaN(manual) ? null : Math.max(0, manual),
      meta: info.meta
    };
    // Same printing + same condition + same destination is one line, not two.
    const same = d.lines.find(l => l.set === line.set && G.normNum(l.collector) === G.normNum(line.collector) &&
      l.lang === line.lang && l.finish === line.finish && l.condition === line.condition &&
      l.locationId === line.locationId &&
      (l.manualCost == null) === (line.manualCost == null));
    // Topping up an existing line counts as touching it, so it moves back to the
    // top of the newest-first list rather than staying buried where it was.
    if (same) { same.qty += line.qty; same.ts = line.ts; } else d.lines.push(line);
    saveDraft();
    renderLot();
    UI.chime(info.price, job.set + "|" + job.num + "|" + job.finish);
    UI.setStatus("entryStatus", "Added " + job.qty + "× " + info.name + " " + optionsNote(job, true) + "to the lot (" +
      d.lines.reduce((s, l) => s + l.qty, 0) + " cards on the receipt)." + (info.note || "") + fittedNote(job), job.fittedFrom ? "work" : "ok");
    $("inLineCost").value = "";
    resetEntry();
  }

  function lotAllocation() {
    const d = draft();
    const manualTotal = d.lines.reduce((s, l) => s + (l.manualCost != null ? l.manualCost * l.qty : 0), 0);
    const eff = G.lotSpend(d.spend, manualTotal);
    const spend = eff.spend;
    const spreadLines = d.lines.filter(l => l.manualCost == null);
    const spreadable = Math.max(0, spend - manualTotal);
    // "paid" (a Mana Pool order, #353) weights each line by its price paid,
    // so it gets that price plus a share of the shipping and tax.
    const paidMode = d.alloc === "paid";
    const unit = G.allocateLotCost(spreadLines.map(l => ({ qty: l.qty, market: paidMode ? l.paid : l.market })),
      spreadable, paidMode ? "market" : d.alloc);
    const byId = new Map();
    spreadLines.forEach((l, i) => byId.set(l.id, unit[i]));
    return {
      spend,
      auto: eff.auto,
      manualTotal: G.round2(manualTotal),
      spreadable: G.round2(spreadable),
      unitCost: l => l.manualCost != null ? l.manualCost : (byId.get(l.id) || 0),
      overspent: manualTotal > spend + 0.004
    };
  }

  function renderDraftTabs() {
    const box = $("lotDraftTabs");
    if (!box) return;
    const list = drafts();
    const activeId = G.state.settings.activeDraftLotId;
    box.innerHTML = "";
    for (const d of list) {
      const btn = document.createElement("button");
      btn.className = "seg" + (d.id === activeId ? " active" : "");
      const label = d.receiptId ? d.receiptId : d.manapool ? "Mana Pool " + d.manapool.orderNumber : "New lot";
      const count = d.lines.reduce((s, l) => s + l.qty, 0);
      btn.innerHTML = "<span>" + G.esc(label) + (count ? " · " + count : "") + "</span>" +
        '<span class="seg-x" title="Discard this draft">✕</span>';
      btn.onclick = () => switchDraft(d.id);
      btn.querySelector(".seg-x").onclick = e => { e.stopPropagation(); discardDraft(d.id); };
      box.appendChild(btn);
    }
  }

  function renderLot() {
    renderDraftTabs();
    const d = draft();
    $("lotId").value = d.receiptId || "";
    $("lotSource").value = d.source || "";
    $("lotDate").value = d.date || G.localDay(Date.now());
    const paidOk = d.alloc === "paid" || d.lines.some(l => l.paid != null);
    $("lotAllocPaid").hidden = $("lotAllocPaid").disabled = !paidOk;
    $("lotAlloc").value = d.alloc || "market";
    $("lotNote").value = d.note || "";
    $("lotIdLabel").textContent = d.receiptId ? "" : "will be numbered " + G.nextReceiptId("lot");
    const mp = d.manapool;
    $("lotMpRow").hidden = !mp;
    if (mp) {
      $("lotMpMark").checked = mp.markReceived !== false;
      const done = G.mpReceivedPackages();
      const clash = mp.packages.filter(p => done.has(p.id));
      $("lotMpInfo").innerHTML = "Mana Pool order " + G.esc(mp.orderNumber) + " · " +
        G.esc(mp.packages.map(p => p.seller || "seller").join(", ")) +
        (clash.length ? ' · <span class="bad">already received as ' + G.esc(done.get(clash[0].id)) + "</span>" : "");
    }

    const a = lotAllocation();
    // While the total is empty or $0 it shows the sum of the typed costs.
    if (document.activeElement !== $("lotSpend")) {
      $("lotSpend").value = a.auto ? a.spend : (d.spend == null ? "" : d.spend);
    }
    const cards = d.lines.reduce((s, l) => s + l.qty, 0);
    const market = d.lines.reduce((s, l) => s + (l.market == null ? 0 : l.market * l.qty), 0);
    const cost = d.lines.reduce((s, l) => s + a.unitCost(l) * l.qty, 0);
    // "Cards" until a sealed line joins the receipt, then "items".
    const word = d.lines.some(isSealed) ? "item" : "card";
    $("lotStrip").innerHTML =
      tile(cards.toLocaleString(), (word === "item" ? "Items" : "Cards") + " on receipt") +
      tile(d.lines.length.toLocaleString(), "Lines") +
      tile(G.money(a.spend), "Spent") +
      tile(G.money(market), "Market value", market >= a.spend ? "val" : "neg") +
      tile(cards ? G.money(cost / cards) : "—", "Avg cost / " + word) +
      tile(a.spend > 0 ? G.pct(((market - a.spend) / a.spend) * 100) : "—", "Vs market",
        market >= a.spend ? "val" : "neg");

    const noPrice = d.lines.filter(l => l.market == null).length;
    const unmatched = d.lines.filter(l => l.unmatched).length;
    $("lotAllocNote").innerHTML =
      (d.alloc === "paid"
        ? "Each line costs what you paid for it plus a share of the shipping and tax, so the receipt adds up to what you paid."
        : d.alloc === "even"
        ? "Every card on the receipt takes an equal share of the money. Simple, and wrong for a box with one expensive card in it."
        : "Each line takes a share of the money proportional to its market value × quantity. " +
          "Lines with no price on file are weighted at the average of the lines that do have one, so they absorb something rather than nothing.") +
      (noPrice && d.alloc !== "paid" ? " <b>" + noPrice + " line" + (noPrice === 1 ? " has" : "s have") + " no market price</b> — check them before posting." : "") +
      (unmatched ? ' <span class="bad">' + unmatched + " line" + (unmatched === 1 ? " isn't" : "s aren't") +
        " in Grimoire's catalog, so " + (unmatched === 1 ? "it" : "they") + " can't be posted. Note the cost shown, remove the line, " +
        "then add the item by hand under Bought with that amount in Cost each. Leave the total as it is.</span>" : "") +
      (a.auto ? " Total spent is filled in from the typed costs. Type your own total to change it." +
        (d.lines.some(l => l.manualCost == null) ? " Lines without a cost each get $0 until the total is higher." : "") : "") +
      (!a.auto && a.manualTotal > 0 ? " Typed per-card costs of " + G.money(a.manualTotal) + " come off the top; " +
        G.money(a.spreadable) + " is spread over the rest." : "") +
      (a.overspent ? ' <span class="bad">Typed costs add up to ' + G.money(a.manualTotal) + ", more than the " +
        G.money(a.spend) + " total. Raise the total or lower a cost.</span>" : "");

    const body = $("lotBody");
    if (!d.lines.length) {
      body.innerHTML = UI.emptyRow(10, { icon: "cards", title: "No lines yet.",
        hint: "Add cards on the left and they land here." });
      $("lotPost").disabled = true;
      $("lotHint").textContent = "";
      return;
    }
    body.innerHTML = "";
    // A Mana Pool order's card lines say when the same card is already in inventory.
    const owned = mp ? ownedLookup() : null;
    // Newest first. Indices are recomputed each render, so splicing by the
    // captured index stays correct even though the display order is reversed.
    const display = d.lines
      .map((l, i) => ({ l, i }))
      .sort((a2, b2) => String(b2.l.ts || "").localeCompare(String(a2.l.ts || "")) || b2.i - a2.i);
    display.forEach(({ l, i: idx }) => {
      const unit = a.unitCost(l);
      const tr = document.createElement("tr");
      if (isSealed(l)) {
        // Sealed product has no printing, finish or card preview.
        tr.innerHTML = '<td class="col-art"></td>' +
          '<td class="card-name">' + G.esc(l.name) + unmatchedMark(l) +
            '<small class="sub-sm">' + G.esc(String(l.setCode || "").toUpperCase()) + ' · Sealed</small></td>' +
          '<td class="hide-lg" data-vs="' + G.esc(String(l.setCode || "")) + '">' + G.esc(String(l.setCode || "").toUpperCase()) +
          ' <span class="pill">Sealed</span></td><td><span class="muted">—</span></td>';
      } else {
        tr.className = "click";
        tr.innerHTML = UI.artThumbTd(l.imageUrl);
        const nameTd = document.createElement("td");
        nameTd.className = "card-name";
        nameTd.innerHTML = UI.cardLink(l) + unmatchedMark(l) +
          '<small class="sub-sm">' + G.esc(G.printingLabel(l.set, l.collector)) + "</small>";
        if (owned && !l.unmatched) dupeChoice(nameTd, l, owned(l));
        tr.appendChild(nameTd);
        const printTd = document.createElement("td");
        printTd.className = "hide-lg";
        printTd.textContent = G.printingLabel(l.set, l.collector);
        tr.appendChild(printTd);
        UI.wireArtHover(tr, l.imageUrl);
        tr.onclick = e => { if (e.target.closest("select, input, button")) return; reviewLine(l); };
        const foilTd = document.createElement("td");
        const foilSel = document.createElement("select");
        foilSel.className = "small";
        foilSel.title = "Change this line's finish";
        foilSel.innerHTML = G.FINISHES.map(f =>
          '<option value="' + f + '"' + (l.finish === f ? " selected" : "") + ">" + G.esc(G.FINISH_NAMES[f]) + "</option>").join("");
        { // grey out finishes the printing doesn't come in; never change the line's own finish
          const f = ((G.cardCache.get(G.printKey(l.set, l.collector, l.lang)) || {}).finishes || []);
          for (const o of foilSel.options) o.disabled = f.length > 0 && !f.includes(o.value) && o.value !== l.finish;
        }
        foilSel.onchange = () => {
          l.finish = foilSel.value;
          saveDraft(); renderLot();
        };
        foilTd.appendChild(foilSel);
        tr.appendChild(foilTd);
      }
      const qtyTd = document.createElement("td");
      qtyTd.className = "num";
      const qtyInp = document.createElement("input");
      qtyInp.type = "number";
      qtyInp.min = "1";
      qtyInp.value = l.qty;
      qtyInp.style.width = "70px";
      qtyInp.onchange = () => {
        l.qty = Math.max(1, parseInt(qtyInp.value, 10) || 1);
        saveDraft(); renderLot();
      };
      qtyTd.appendChild(qtyInp);
      tr.appendChild(qtyTd);
      tr.insertAdjacentHTML("beforeend",
        '<td class="num hide-lg">' + (l.market == null ? '<span class="warn">no price</span>' : G.money(l.market)) + "</td>" +
        '<td class="num">' + G.money(unit) + (l.manualCost != null ? ' <span class="pill">typed</span>' : "") + "</td>" +
        '<td class="num hide-lg">' + G.money(unit * l.qty) + "</td>");
      const locTd = document.createElement("td");
      const locSel = document.createElement("select");
      locSel.className = "small";
      locSel.title = "Change where this line will be put away";
      locSel.innerHTML = UI.locOptions(l.locationId, {});
      locSel.onchange = () => {
        l.locationId = locSel.value;
        saveDraft();
      };
      locTd.appendChild(locSel);
      tr.appendChild(locTd);
      const td = document.createElement("td");
      td.innerHTML = '<button class="small" title="Remove this line" aria-label="Remove this line">✕</button>';
      td.querySelector("button").onclick = () => {
        d.lines.splice(idx, 1);
        saveDraft(); renderLot();
      };
      tr.appendChild(td);
      body.appendChild(tr);
    });
    $("lotPost").disabled = false;
    $("lotHint").textContent = a.spend > 0
      ? cards + " " + word + "s for " + G.money(a.spend)
      : "No total spent and no cost on any line — " + word + "s will post with no cost basis. Type a total spent, or a cost each.";
    UI.reapplySorts();
  }

  const unmatchedMark = l => l.unmatched
    ? ' <span class="bad">' + UI.icon("triangle-alert") + " Not in Grimoire's catalog</span>" : "";

  /* Owned copies by identity (printing, finish, condition, language), built
     once per render instead of a scan of every stack per line. -> l => count */
  function ownedLookup() {
    const key = r => [r.set, G.normNum(r.collector), r.lang || "en", r.finish || "nonfoil", r.condition || "NM"].join("|");
    const by = new Map();
    for (const r of G.state.cards) by.set(key(r), (by.get(key(r)) || 0) + (Number(r.quantity) || 0));
    return l => by.get(key(l)) || 0;
  }

  /* #353 decision 1: a purchased card already in inventory gets a marker and
     a per-line choice. "cost" sets the cost on the copies you have and adds
     nothing; "new" adds the copies. */
  function dupeChoice(td, l, n) {
    if (!n) return;
    const box = document.createElement("div");
    box.className = "faint";
    box.innerHTML = UI.icon("archive") + " You have " + n + " already. ";
    const sel = document.createElement("select");
    sel.className = "small";
    sel.title = "This card is already in your inventory: add the copies, or only set the cost on the ones you have";
    sel.setAttribute("aria-label", "Already in inventory: what to do with this line");
    sel.innerHTML = '<option value="new">Add as new copies</option>' +
      '<option value="cost">Already have it, just set the cost</option>';
    sel.value = l.dupe === "cost" ? "cost" : "new";
    sel.onchange = () => { l.dupe = sel.value; saveDraft(); renderLot(); };
    box.appendChild(sel);
    td.appendChild(box);
  }

  const tile = (big, lbl, cls) =>
    '<div class="stat"><span class="big ' + (cls || "") + '">' + big + '</span><span class="lbl">' + lbl + "</span></div>";

  async function postLot() {
    const d = draft();
    if (!d.lines.length) return;
    let a = lotAllocation();
    const receiptId = (d.receiptId || "").trim() || G.nextReceiptId("lot");
    if (G.state.receipts.some(r => r.receiptId === receiptId)) {
      UI.toast('A receipt numbered "' + receiptId + '" already exists — give this one a different ID.', "err");
      return;
    }
    const mp = d.manapool || null;
    if (d.lines.some(l => l.unmatched)) {
      UI.toast("Some lines aren't in Grimoire's catalog. Remove them (and add those items by hand) before posting.", "err");
      return;
    }
    // A Mana Pool package goes into inventory once (#353), even if another
    // device posted it since this draft was made.
    if (mp) {
      const done = G.mpReceivedPackages();
      const clash = mp.packages.find(p => done.has(p.id));
      if (clash) {
        UI.toast("Mana Pool order " + mp.orderNumber + (clash.seller ? " from " + clash.seller : "") +
          " is already received, as " + done.get(clash.id) + ". Discard this draft.", "err");
        return;
      }
    }
    // Typed costs above the user's own total would make spent and cost/card
    // disagree: ask which number is right before posting.
    if (a.overspent) {
      const sum = G.money(a.manualTotal);
      const fix = await UI.confirmDialog("Typed costs add up to " + sum + ", more than the " + G.money(a.spend) +
        " total.\n\nUse " + sum + " as the total spent, or go back and change it.",
        { title: "Costs are over the total", okLabel: "Use " + sum + " as the total", cancelLabel: "Go back" });
      if (!fix) return;
      d.spend = String(a.manualTotal);
      saveDraft();
      renderLot();
      a = lotAllocation();
    }
    const cards = d.lines.reduce((s, l) => s + l.qty, 0);
    const word = d.lines.some(isSealed) ? "item" : "card";
    const owned = mp ? ownedLookup() : null;
    const costOnly = mp ? d.lines.filter(l => !isSealed(l) && l.dupe === "cost" && owned(l) > 0) : [];
    const markMp = !!mp && $("lotMpMark").checked;
    const toMark = markMp ? mp.packages.filter(p => !p.receivedAt) : [];
    const ok = await UI.confirmDialog("Post receipt " + receiptId + "?\n\n" + cards + " " + word + "(s) for " + G.money(a.spend) +
      ".\nEvery " + word + " gets a cost basis, and the moving average updates on any stack you already own." +
      (costOnly.length ? "\n" + costOnly.length + " line(s) you already have only set the cost on those copies." : "") +
      (toMark.length ? "\nAlso marks " + (toMark.length === 1 ? "the package" : toMark.length + " packages") + " received on Mana Pool." : ""),
      { title: "Post receipt?" });
    if (!ok) return;

    const receiptLines = [];
    for (const l of d.lines) {
      const unit = a.unitCost(l);
      const acquiredAt = d.date ? new Date(d.date + "T12:00:00").toISOString() : new Date().toISOString();
      // "Already have it, just set the cost" (#353): the cost goes on the
      // copies already owned; only copies beyond those are added.
      let existing = 0;
      if (costOnly.includes(l)) {
        existing = G.costOwnedCopies({
          set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
          qty: l.qty, unitCost: a.spend > 0 ? unit : null, receiptId,
          note: "Lot receipt " + receiptId + ": cost set on copies already owned" + (a.spend > 0 ? ", " + G.money(unit) + " each" : "")
        });
      }
      if (existing) {
        if (existing < l.qty) {
          G.addCopies({
            set: l.set, num: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
            locationId: l.locationId, qty: l.qty - existing, info: lineInfo(l),
            unitCost: a.spend > 0 ? unit : null, action: "receipt", receiptId, acquiredAt,
            note: "Lot receipt " + receiptId + (a.spend > 0 ? " at " + G.money(unit) + " each" : " (no cost recorded)")
          });
        }
        receiptLines.push({
          set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition, name: l.name,
          qty: l.qty, market: l.market, unitCost: unit4(unit), locationId: l.locationId, existing
        });
        continue;
      }
      if (isSealed(l)) {
        // Sealed lines go to Sealed inventory; the receipt line carries setCode
        // instead of set/collector (showReceipt already reads that shape).
        G.addSealedCopies({
          tcgplayerProductId: l.tcgplayerProductId, manapoolProductId: l.manapoolProductId,
          name: l.name, setCode: l.setCode, locationId: l.locationId, qty: l.qty,
          price: l.market, unitCost: a.spend > 0 ? unit : null,
          note: "Lot receipt " + receiptId + (a.spend > 0 ? " at " + G.money(unit) + " each" : " (no cost recorded)")
        });
        receiptLines.push({ item: "sealed", name: l.name, setCode: l.setCode, tcgplayerProductId: l.tcgplayerProductId,
          qty: l.qty, market: l.market, unitCost: unit4(unit), locationId: l.locationId });
        continue;
      }
      G.addCopies({
        set: l.set, num: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
        locationId: l.locationId, qty: l.qty, info: lineInfo(l),
        unitCost: a.spend > 0 ? unit : null,
        action: "receipt", receiptId, acquiredAt,
        note: "Lot receipt " + receiptId + (a.spend > 0 ? " at " + G.money(unit) + " each" : " (no cost recorded)")
      });
      receiptLines.push({
        set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition, name: l.name,
        qty: l.qty, market: l.market, unitCost: unit4(unit), locationId: l.locationId
      });
    }
    const doc = G.recordReceipt(Object.assign({
      // An all-sealed receipt keeps the old Receive Sealed kind.
      kind: d.lines.every(isSealed) ? "sealed-lot" : "lot", receiptId,
      ts: d.date ? new Date(d.date + "T12:00:00").toISOString() : new Date().toISOString(),
      source: d.source || "", note: d.note || "",
      spend: a.spend, allocation: d.alloc || "market",
      lines: receiptLines
      // The Mana Pool order it came from (#353): what stops it being received twice.
    }, mp ? { manapool: { orderId: mp.orderId, orderNumber: mp.orderNumber, packageIds: mp.packages.map(p => p.id) } } : {}));
    const list = drafts();
    const i = list.indexOf(d);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) list.push(newDraft());
    G.state.settings.activeDraftLotId = list[Math.min(i, list.length - 1)].id;
    G.persist("Receipt " + receiptId);
    renderLot(); renderReceipts();
    if (kind === "manapool") renderPurchases();
    // Only after the receipt is saved: a Mana Pool failure leaves it in place.
    const markFail = toMark.length ? await markReceivedOnManapool(toMark) : "";
    const posted = "Posted " + receiptId + ": " + doc.totalCards + " " + word + (doc.totalCards === 1 ? "" : "s") +
      " for " + G.money(a.spend) + " (" + G.money(doc.totalCards ? doc.totalCost / doc.totalCards : 0) + " average)";
    if (markFail) UI.toast(posted + ", but " + markFail, "err");
    else UI.toast(posted + (toMark.length ? " and marked received on Mana Pool" : "") + ". Undo reverses the whole receipt.", "ok");
  }

  /* A receipt line's cost each, kept to 4 places: rounded to the cent, a
     line's share of the money (whole cents over several copies) could make
     the receipt's total a cent off what was spent. */
  const unit4 = u => Math.round((Number(u) || 0) * 1e4) / 1e4;

  // A posted card line's stored details, in the shape addCopies wants.
  const lineInfo = l => ({
    name: l.name, collector: l.collector, setName: l.setName, rarity: l.rarity,
    tcgplayerId: l.tcgplayerId, scryfallId: l.scryfallId,
    price: l.market, priceNote: "", note: "", meta: l.meta || {}
  });

  /* ============================== Mana Pool order (#353) ==============================
     The orders this account bought on Mana Pool, newest first. Picking one
     (or one seller's package in it) makes a new lot receipt draft: each
     line's price paid plus a share of shipping and tax, refunds already off,
     already-owned cards flagged. Posting it can also mark the packages
     received on Mana Pool. */
  const MP_PAGE = 20;
  let purchases = null;      // { orders: [...], more, loading }
  let purchasesSeq = 0;
  let mpShowDone = false;    // reveal orders whose packages are all on posted receipts

  // Plain words for a Mana Pool failure. 403 = Mana Pool refused the connection.
  function mpErrorText(e) {
    if (e && e.status === 403) {
      return "Mana Pool turned down Grimoire's connection for your purchases. Reconnect Mana Pool in " +
        "Settings → Integrations.";
    }
    if (e && e.status === 504) return "Mana Pool didn't answer in time. Try again in a minute.";
    if (e && e.status === 501) return (e.message || "Mana Pool isn't connected.");
    return "Couldn't reach Mana Pool: " + ((e && e.message) || "unknown error");
  }

  function openPurchases() {
    UI.fillLocationSelect($("mpDest"), $("mpDest").value || $("inLoc").value, {});
    if (!purchases) loadPurchases(false);
    else renderPurchases();
  }

  async function loadPurchases(more) {
    const seq = ++purchasesSeq;
    const offset = more && purchases ? purchases.orders.length : 0;
    if (!more) purchases = { orders: [], more: false, loading: true };
    else purchases.loading = true;
    renderPurchases();
    UI.setStatus("mpStatus", "Loading your Mana Pool purchases…", "work");
    try {
      const d = await G.api("/api/manapool/purchases?limit=" + MP_PAGE + "&offset=" + offset);
      if (seq !== purchasesSeq) return;
      const have = new Set(purchases.orders.map(o => o.id));
      purchases.orders.push(...(d.orders || []).filter(o => !have.has(o.id)));
      purchases.more = !!d.more;
      UI.setStatus("mpStatus", "", "");
    } catch (e) {
      if (seq !== purchasesSeq) return;
      UI.setStatus("mpStatus", mpErrorText(e), "err");
    }
    purchases.loading = false;
    renderPurchases();
  }

  const fmtDay = (iso, long) => {
    const t = Date.parse(iso || "");
    return isNaN(t) ? "" : long ? new Date(t).toLocaleDateString() : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  function renderPurchases() {
    const box = $("mpList");
    $("mpMore").hidden = !(purchases && purchases.more && !purchases.loading);
    $("mpShowDone").hidden = true;
    if (!purchases || (!purchases.orders.length && purchases.loading)) { box.innerHTML = UI.skeletonBlock ? UI.skeletonBlock() : ""; return; }
    if (!purchases.orders.length) {
      box.innerHTML = UI.emptyBlock({ icon: "shopping-bag", title: "No Mana Pool purchases yet.",
        hint: "Orders you buy on Mana Pool show up here." });
      return;
    }
    const done = G.mpReceivedPackages();
    const inDraft = new Map();
    for (const dr of drafts()) for (const p of (dr.manapool && dr.manapool.packages) || []) inDraft.set(p.id, dr.id);
    const isDone = o => o.packages.length > 0 && o.packages.every(p => done.has(p.id));
    const doneCount = purchases.orders.filter(isDone).length;
    const shown = mpShowDone ? purchases.orders : purchases.orders.filter(o => !isDone(o));
    const tog = $("mpShowDone");
    tog.hidden = !doneCount;
    tog.textContent = (mpShowDone ? "Hide received orders (" : "Show received orders (") + doneCount + ")";
    tog.setAttribute("aria-pressed", mpShowDone ? "true" : "false");
    box.innerHTML = "";
    if (!shown.length) {
      box.innerHTML = UI.emptyBlock({ icon: "orders", title: "All your Mana Pool purchases are received.",
        hint: purchases.more ? "Load older orders to see more." : "" });
      return;
    }
    for (const o of shown) {
      const head = document.createElement("div");
      head.className = "feed-row";
      head.innerHTML = '<span class="ftime" title="' + G.esc(fmtDay(o.createdAt, true)) + '">' + G.esc(fmtDay(o.createdAt)) + "</span>" +
        '<span class="ftext"><b>Order ' + G.esc(o.orderNumber || o.id) + "</b>" +
        (o.packages.length > 1 ? " · " + o.packages.length + " sellers" : "") + "</span>" +
        '<span class="fnum">' + G.money(o.total) + "</span>";
      box.appendChild(head);
      const open = o.packages.filter(p => !done.has(p.id));
      if (o.packages.length > 1 && open.length > 1) {
        const row = document.createElement("div");
        row.className = "feed-row mp-pkg";
        row.innerHTML = '<span class="ftext"><span class="mp-name">Every package still to receive</span>' +
          '<span class="mp-sub"><span class="num">' + open.length + "</span> packages</span></span>";
        const b = document.createElement("button");
        b.className = "small";
        b.textContent = "Receive all";
        b.onclick = () => importPurchase(o, open.map(p => p.id));
        row.appendChild(b);
        box.appendChild(row);
      }
      for (const p of o.packages) {
        const row = document.createElement("div");
        row.className = "feed-row mp-pkg";
        const rec = done.get(p.id);
        row.innerHTML = '<span class="ftext"><span class="mp-name">' + G.esc(p.seller || "Seller") + "</span>" +
          '<span class="mp-sub"><span class="num">' + p.itemCount + "</span> item" + (p.itemCount === 1 ? "" : "s") +
          (p.receivedAt ? " · marked received on Mana Pool" : "") + "</span></span>" +
          (rec ? '<span class="pill on" title="Received as ' + G.esc(rec) + '" aria-label="Received as ' + G.esc(rec) + '">' + UI.icon("circle-check") + " " + G.esc(rec) + "</span>" : "");
        if (!rec) {
          const b = document.createElement("button");
          b.className = "small";
          b.textContent = inDraft.has(p.id) ? "Open draft" : "Receive";
          b.onclick = () => importPurchase(o, [p.id]);
          row.appendChild(b);
        }
        box.appendChild(row);
      }
    }
  }

  /* Order (+ chosen packages) -> a new lot draft. Skips packages already on
     a posted receipt; reopens the draft that already holds them. */
  async function importPurchase(o, packageIds) {
    const done = G.mpReceivedPackages();
    const ids = packageIds.filter(id => !done.has(id));
    if (!ids.length) {
      UI.toast("Already received, as " + done.get(packageIds[0]) + ".", "err");
      return;
    }
    const existing = drafts().find(dr => dr.manapool && dr.manapool.packages.some(p => ids.includes(p.id)));
    if (existing) {
      switchDraft(existing.id);
      UI.setStatus("mpStatus", "That order is already on a draft receipt: it's open in the middle.", "ok");
      return;
    }
    UI.setStatus("mpStatus", "Fetching order " + (o.orderNumber || "") + " from Mana Pool…", "work");
    let order;
    try { order = (await G.api("/api/manapool/purchase/" + encodeURIComponent(o.id))).order; }
    catch (e) { UI.setStatus("mpStatus", mpErrorText(e), "err"); return; }
    const lot = G.mpPurchaseLot(order, ids);
    if (!lot.lines.length) {
      UI.setStatus("mpStatus", "Nothing in " + (ids.length === 1 ? "that package" : "those packages") +
        " is coming to you (everything was refunded).", "work");
      return;
    }
    UI.setStatus("mpStatus", "Looking up " + lot.lines.length + " line(s)…", "work");
    const cardLines = lot.lines.filter(l => l.kind !== "sealed" && l.matched);
    const infos = await prefetchCardInfo(cardLines, l => ({ set: l.set, num: l.collector, lang: l.lang, finish: l.finish }), 6);
    const infoOf = new Map(cardLines.map((l, i) => [l, infos[i]]));
    const dest = G.locById($("mpDest").value) ? $("mpDest").value : $("inLoc").value;
    const now = Date.now();
    const lines = lot.lines.map((l, i) => {
      // Same timestamp order as the order itself: first item on top.
      const base = { id: G.uid(), ts: new Date(now - i).toISOString(), qty: l.qty, paid: l.paid,
        manualCost: null, mpItemId: l.orderItemId, locationId: dest };
      if (l.kind === "sealed") {
        return Object.assign(base, { item: "sealed", name: l.name, setCode: l.setCode,
          tcgplayerProductId: l.tcgplayerProductId || "", manapoolProductId: l.manapoolProductId,
          market: l.market == null ? null : l.market }, l.matched ? {} : { unmatched: true });
      }
      const info = infoOf.get(l);
      const card = { set: l.set, collector: info ? info.collector : l.collector, lang: l.lang, finish: l.finish, condition: l.condition };
      if (!info) return Object.assign(base, card, { name: l.name || "Unknown card", market: null, unmatched: true });
      const line = Object.assign(base, card, {
        name: info.name, setName: info.setName, rarity: info.rarity, scryfallId: info.scryfallId || l.scryfallId,
        tcgplayerId: info.tcgplayerId, imageUrl: info.card.imageUrl || "", market: info.price, meta: info.meta
      });
      if ($("mpPutaway").checked) {
        const s = G.suggestLocation(Object.assign({}, info.card, { finish: l.finish, price: info.price, quantity: l.qty }), { qty: l.qty });
        if (s.best) line.locationId = s.best.locationId;
      }
      const dupe = G.mpDupeDefault(line, order.createdAt, order.id);
      if (dupe) line.dupe = dupe;
      return line;
    });
    const pk = lot.packages;
    const d = Object.assign(newDraft(), {
      source: "Mana Pool order " + (order.orderNumber || o.orderNumber) +
        (pk.length === 1 && pk[0].seller ? " (" + pk[0].seller + ")" : ""),
      spend: String(lot.spend), alloc: "paid", lines,
      manapool: { orderId: order.id, orderNumber: order.orderNumber || o.orderNumber, orderDate: order.createdAt,
        packages: pk, markReceived: true }
    });
    drafts().push(d);
    G.state.settings.activeDraftLotId = d.id;
    saveDraft();
    renderLot();
    renderPurchases();
    const bad = lines.filter(l => l.unmatched).length;
    const dup = lines.filter(l => l.dupe).length;
    UI.setStatus("mpStatus", "Order " + d.manapool.orderNumber + " is on a new lot receipt: " +
      lines.reduce((s, l) => s + l.qty, 0) + " item(s) for " + G.money(lot.spend) +
      " (" + G.money(lot.goods) + " items, " + G.money(lot.shipping) + " shipping, " + G.money(lot.tax) + " tax)." +
      (dup ? " " + dup + " line(s) are already in your inventory: pick what to do on each." : "") +
      (bad ? " " + bad + " line(s) aren't in Grimoire's catalog." : "") + " Check it, then post.", bad ? "work" : "ok");
  }

  /* Tells Mana Pool each package arrived. -> "" when all went through, else
     the words for the toast (the receipt is already saved either way). */
  async function markReceivedOnManapool(pkgs) {
    const failed = [];
    for (const p of pkgs) {
      try { await G.api("/api/manapool/purchase-package/" + encodeURIComponent(p.id) + "/received", { method: "POST", body: {} }); }
      catch (e) { failed.push({ p, e }); }
    }
    // Mana Pool's own "received" state changed: load the list fresh next time.
    if (purchases && kind === "manapool") loadPurchases(false);
    else purchases = null;
    if (!failed.length) return "";
    return "Mana Pool didn't take the \"received\" mark" +
      (failed.length < pkgs.length ? " for " + failed.map(f => f.p.seller || "a package").join(", ") : "") +
      ". " + mpErrorText(failed[0].e) + " You can mark it received on Mana Pool's site instead.";
  }

  /* ============================== Transfer ============================== */
  async function pickTransfer() {
    const f = await G.pickFile(".json,application/json");
    if (!f) return;
    try {
      transfer = G.parseTransfer(f.text);
    } catch (e) {
      transfer = null;
      UI.setStatus("xferSummary", "✗ " + e.message, "err");
      $("xferSection").hidden = true;
      return;
    }
    UI.setStatus("xferSummary", "Read " + f.name + ": " + transfer.lines.length + " line" +
      (transfer.lines.length === 1 ? "" : "s") + " / " + transfer.totalCards + " card" +
      (transfer.totalCards === 1 ? "" : "s") + " from " + transfer.fromUser +
      (transfer.includesCost ? ", cost basis included" : ", no cost basis included") + ".", "ok");
    $("xferCost").disabled = !transfer.includesCost;
    if (!transfer.includesCost) $("xferCost").checked = false;
    $("xferSection").hidden = false;
    renderTransfer();
  }

  function transferTarget(line) {
    if ($("xferPutaway").checked) {
      const shaped = { set: line.set, collector: line.collector, lang: line.lang, finish: line.finish,
        name: line.name, setName: line.setName, price: line.price,
        colors: [], colorIdentity: [], keywords: [], typeLine: "", rarity: "", quantity: line.qty };
      const s = G.suggestLocation(shaped, { qty: line.qty });
      if (s.best) return { id: s.best.locationId, why: "putaway" };
    }
    const chosen = $("xferDest").value;
    if (G.locById(chosen)) return { id: chosen, why: "chosen" };
    return { id: null, why: "none" };
  }

  function renderTransfer() {
    if (!transfer) return;
    $("xferFrom").textContent = "from " + transfer.fromUser +
      (transfer.createdAt ? " · " + new Date(transfer.createdAt).toLocaleString() : "") +
      (transfer.note ? " · " + transfer.note : "");
    UI.fillLocationSelect($("xferDest"), null, {});
    const body = $("xferBody");
    // A transfer file never carried an image URL - a synchronous cache peek
    // (from anything else on the page that's already looked the printing
    // up) is the best available without a network round trip per line;
    // clicking a row still does a real lookup, same as elsewhere on this
    // page.
    const cachedImg = l => (G.cardCache.get(G.printKey(l.set, l.collector, l.lang || "en")) || {}).imageUrl || "";
    body.innerHTML = transfer.lines.map(l => {
      const t = transferTarget(l);
      const carry = $("xferCost").checked && l.unitCost != null;
      return '<tr class="click">' + UI.artThumbTd(cachedImg(l)) + "<td>" + UI.cardLink(l, l.name || "(unnamed)") + "</td>" +
        "<td>" + G.esc(G.printingLabel(l.set, l.collector, l.setName)) + "</td>" +
        "<td>" + (l.finish && l.finish !== "nonfoil" ? '<span class="badge ' + l.finish + '">' + G.esc(G.FINISH_NAMES[l.finish].toUpperCase()) + "</span>" : '<span class="muted">—</span>') + "</td>" +
        '<td class="num">' + l.qty + "</td>" +
        '<td class="num">' + (carry ? G.money(l.unitCost) : '<span class="muted">—</span>') + "</td>" +
        "<td>" + (t.id ? G.esc(G.locName(t.id)) + (t.why === "putaway" ? ' <span class="pill type">putaway</span>' : "")
          : '<span class="bad">no location</span>') + "</td></tr>";
    }).join("");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const l = transfer.lines[i];
      if (!l) return;
      UI.wireArtHover(tr, cachedImg(l));
      tr.onclick = () => reviewLine(l);
    });
    $("xferPost").disabled = !transfer.lines.length || !G.state.locations.length;
  }

  /* Runs up to `limit` G.lookupCard() calls concurrently instead of one
     network round-trip at a time - a multi-hundred-line transfer, pull-sheet
     or CSV import otherwise crawls waiting on each request before starting
     the next, even though the lookups don't depend on each other at all.
     Returns results in the same order as `items`; a failed lookup resolves
     to null so the caller can fall back exactly as it did before. The actual
     G.addCopies()/G.recordReceipt() writes stay a separate, strictly
     sequential pass in original file order - only the read-only lookups run
     concurrently. */
  async function prefetchCardInfo(items, keyFn, limit) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        const k = keyFn(items[i]);
        try { results[i] = await G.lookupCard(k.set, k.num, k.lang, k.finish); }
        catch (e) { results[i] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
    return results;
  }

  async function postTransfer() {
    if (!transfer || !transfer.lines.length) return;
    const carry = $("xferCost").checked;
    const ok = await UI.confirmDialog("Receive " + transfer.totalCards + " card(s) from " + transfer.fromUser + "?" +
      (carry ? "\n\nThe sender's cost basis comes with them." : ""), { title: "Receive transfer?" });
    if (!ok) return;

    $("xferPost").disabled = true;
    const receiptId = G.nextReceiptId("transfer");
    UI.toastProgress("Looking up " + transfer.lines.length + " card(s)…");
    const infos = await prefetchCardInfo(transfer.lines, l => ({ set: l.set, num: l.collector, lang: l.lang, finish: l.finish }), 8);
    const lines = [];
    let done = 0, failed = 0;
    transfer.lines.forEach((l, idx) => {
      const t = transferTarget(l);
      if (!t.id) { failed++; return; }
      // The sender's own values are enough to hold the row on a lookup miss;
      // a later refresh fills in the rest rather than dropping the card.
      const info = infos[idx] || {
        name: l.name, collector: l.collector, setName: l.setName, rarity: "",
        tcgplayerId: "", scryfallId: l.scryfallId, price: l.price, priceNote: "", note: "", meta: {}
      };
      G.addCopies({
        set: l.set, num: l.collector, lang: l.lang, finish: l.finish, condition: l.condition,
        locationId: t.id, qty: l.qty, info,
        unitCost: (carry && l.unitCost != null) ? l.unitCost : null,
        action: "transfer", receiptId,
        note: "Received from " + transfer.fromUser + " on transfer " + receiptId
      });
      lines.push({ set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition, name: l.name,
        qty: l.qty, market: l.price, unitCost: carry && l.unitCost != null ? l.unitCost : 0, locationId: t.id });
      done++;
      UI.toastProgress("Receiving " + done + " / " + transfer.lines.length + "…");
    });
    G.recordReceipt({
      kind: "transfer", receiptId,
      source: transfer.fromUser, fromUser: transfer.fromUser,
      note: transfer.note || "", spend: null, allocation: "transfer", lines
    });
    G.persist("Transfer " + receiptId);
    UI.toast("Received " + lines.reduce((s, l) => s + l.qty, 0) + " card(s) from " + transfer.fromUser +
      " as " + receiptId + (failed ? ", " + failed + " line(s) had nowhere to go" : "") +
      ". Undo reverses the whole transfer.", failed ? "work" : "ok");
    transfer = null;
    $("xferSection").hidden = true;
    UI.setStatus("xferSummary", "", "");
    renderReceipts();
  }

  /* ============================== TCGplayer Pull Sheet import ==============================
     A CSV from TCGplayer's Manage Lists -> Pull Sheet. Unlike every other file this app reads,
     TCGplayer exports this as UTF-16LE with no BOM, so File.text() (which assumes UTF-8) would
     garble it - read the raw bytes and decode explicitly instead of going through G.pickFile.
     The file has no location column at all, so one destination is chosen once for everything
     in it, rather than per row like the generic CSV importer. */
  const TCG_ALIASES = {
    productLine: ["productline"], name: ["productname"], condition: ["condition"],
    collector: ["number"], setName: ["set"], setCode: ["setcode"], rarity: ["rarity"], quantity: ["quantity"]
  };
  let tcgParsed = null;
  let tcgSetsIndex = null;

  function pickRawFile(accept) {
    return new Promise(resolve => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = accept || "";
      inp.onchange = () => resolve(inp.files[0] || null);
      inp.click();
    });
  }

  const normSetName = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  async function loadTcgSetsIndex() {
    if (tcgSetsIndex) return tcgSetsIndex;
    const list = await G.cards.sets();
    const byName = new Map(), byCode = new Set(), byNormName = new Map();
    for (const s of list) {
      byName.set(String(s.name).toLowerCase(), s.code);
      byCode.add(String(s.code).toLowerCase());
      byNormName.set(normSetName(s.name), s.code);
    }
    tcgSetsIndex = { byName, byCode, byNormName };
    return tcgSetsIndex;
  }

  /* TCGplayer's "Set" column is a display name, not a code, and for core sets it
     often carries the code itself in trailing parens ("Magic 2015 (M15)") - try the
     exact name first, then that parenthetical as a code, then the name with the
     parens stripped. Three more known TCGplayer-vs-Scryfall naming mismatches:
     punctuation ("Secrets of Strixhaven: Mystical Archive" vs Scryfall's
     "Secrets of Strixhaven Mystical Archive", no colon) - caught by comparing
     names with all non-alphanumerics stripped - promo packs, which TCGplayer
     labels "Promo Pack: <Set>" where Scryfall names the set "<Set> Promos" -
     and Universes Beyond bonus sheets, which TCGplayer labels "<Set>: Eternal-Legal"
     where Scryfall names the set "<Set> Eternal" (e.g. "Avatar: The Last Airbender:
     Eternal-Legal" vs "Avatar: The Last Airbender Eternal"; same pattern for Marvel,
     Spider-Man, TMNT, the Hobbit, etc). Anything else (e.g. "The List Reprints") is
     left unresolved. */
  function resolveTcgSet(raw, idx) {
    const name = String(raw || "").trim();
    if (!name) return "";
    const lower = name.toLowerCase();
    if (idx.byName.has(lower)) return idx.byName.get(lower);
    const norm = idx.byNormName.get(normSetName(name));
    if (norm) return norm;
    const m = name.match(/^(.*)\s+\(([A-Za-z0-9]{2,6})\)\s*$/);
    if (m) {
      const code = m[2].toLowerCase();
      if (idx.byCode.has(code)) return code;
      const stripped = m[1].trim().toLowerCase();
      if (idx.byName.has(stripped)) return idx.byName.get(stripped);
    }
    const pp = name.match(/^promo\s*pack\s*:\s*(.+)$/i);
    if (pp) {
      const alt = pp[1].trim().toLowerCase() + " promos";
      if (idx.byName.has(alt)) return idx.byName.get(alt);
    }
    const el = name.match(/^(.+?)\s*:?\s*eternal-legal\s*$/i);
    if (el) {
      const alt = el[1].trim().toLowerCase() + " eternal";
      if (idx.byName.has(alt)) return idx.byName.get(alt);
      const altNorm = idx.byNormName.get(normSetName(el[1].trim() + " eternal"));
      if (altNorm) return altNorm;
    }
    return "";
  }

  function parseTcgSheet(text, setsIdx) {
    const parsed = G.parseTabularRows(text);
    if (!parsed) return { error: "The file appears to be empty." };
    const { headers, dataRows } = parsed;
    const idx = G.mapAliasHeaders(headers, TCG_ALIASES);
    const missing = ["name", "condition", "collector", "setName", "quantity"].filter(f => idx[f] == null);
    if (missing.length) return { error: "Missing required column(s): " + missing.join(", ") +
      ". Found headers: " + headers.join(", ") + ". Is this really a TCGplayer Pull Sheet export?" };

    const valid = [], errors = [], warnings = [];
    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r];
      const line = r + 2; // 1-based, including the header row
      const get = f => idx[f] == null ? "" : String(row[idx[f]] == null ? "" : row[idx[f]]).trim();

      const productLine = get("productLine");
      if (productLine && !/^magic$/i.test(productLine)) {
        warnings.push({ line, msg: 'Product line "' + productLine + '" is not Magic - skipped' });
        continue;
      }

      const collector = get("collector");
      if (!collector) { errors.push({ line, reason: "Number is blank" }); continue; }

      const setRaw = get("setName");
      // A hand-added "Set Code" column (Scryfall's actual code, e.g. "ecl") is exact where
      // the "Set" display name is guesswork - prefer it when present, but only if it's a
      // real code, so a typo there errors instead of silently importing under the wrong set.
      const setCodeRaw = get("setCode");
      let set;
      if (setCodeRaw) {
        const code = setCodeRaw.toLowerCase();
        if (!setsIdx.byCode.has(code)) { errors.push({ line, reason: 'Set Code "' + setCodeRaw + '" was not recognised' }); continue; }
        set = code;
      } else {
        set = resolveTcgSet(setRaw, setsIdx);
        if (!set) { errors.push({ line, reason: 'Set "' + setRaw + '" was not recognised' }); continue; }
      }

      let condRaw = get("condition");
      let finish = "nonfoil";
      const fm = condRaw.match(/^(.*?)\s+((?:etched\s+)?foil)$/i);
      if (fm) { finish = G.finishFromText(fm[2]); condRaw = fm[1]; }
      let condition = G.defaultCondition();
      if (condRaw) {
        const code = G.conditionCode(condRaw);
        if (code) condition = code;
        else warnings.push({ line, msg: 'Condition "' + condRaw + '" not recognised — using ' + G.CONDITION_NAMES[condition] });
      }

      const qtyRaw = get("quantity");
      const q = G.parseWholeQty(qtyRaw);
      if (q == null) { errors.push({ line, reason: 'Quantity must be a whole number of 1 or more: "' + qtyRaw + '"' }); continue; }

      valid.push({ line, name: get("name"), collector, set, setName: setRaw, finish, condition,
        quantity: q, rarity: get("rarity") });
    }

    return { total: dataRows.length, valid, errors, warnings, detected: Object.keys(idx) };
  }

  function renderTcgPreview(p) {
    if (p.error) {
      UI.setStatus("tcgSummary", p.error, "err");
      $("tcgDetail").innerHTML = "";
      $("tcgActions").hidden = true;
      tcgParsed = null;
      return;
    }
    tcgParsed = p;
    UI.setStatus("tcgSummary", p.valid.length + " valid · " + p.errors.length + " skipped · " +
      p.warnings.length + " warning(s), of " + p.total + " data row" + (p.total === 1 ? "" : "s") + ".",
      p.valid.length ? "ok" : "err");
    let html = "";
    if (p.errors.length) {
      html += '<b class="warn">Skipped rows:</b><ul style="margin:4px 0 8px 18px;padding:0">' +
        p.errors.slice(0, 100).map(x => '<li class="muted">Line ' + x.line + ": " + G.esc(x.reason) + "</li>").join("") +
        (p.errors.length > 100 ? '<li class="muted">…and ' + (p.errors.length - 100) + " more</li>" : "") + "</ul>";
    }
    if (p.warnings.length) {
      html += '<b>Warnings (still imported):</b><ul style="margin:4px 0 0 18px;padding:0">' +
        p.warnings.slice(0, 40).map(x => '<li class="muted">Line ' + x.line + ": " + G.esc(x.msg) + "</li>").join("") +
        (p.warnings.length > 40 ? '<li class="muted">…and ' + (p.warnings.length - 40) + " more</li>" : "") + "</ul>";
    }
    $("tcgDetail").innerHTML = html;
    $("tcgActions").hidden = false;
    $("tcgGo").disabled = !p.valid.length || !$("tcgDest").value;
    $("tcgGo").textContent = "Import " + p.valid.length + " row" + (p.valid.length === 1 ? "" : "s");
  }

  async function pickTcgSheet() {
    const file = await pickRawFile(".csv");
    if (!file) return;
    UI.setStatus("tcgSummary", "Reading " + file.name + "…", "work");
    try {
      const buf = await file.arrayBuffer();
      const text = new TextDecoder("utf-16le").decode(buf);
      const idx = await loadTcgSetsIndex();
      renderTcgPreview(parseTcgSheet(text, idx));
    } catch (e) {
      renderTcgPreview({ error: "Could not read the file: " + e.message });
    }
  }

  function clearTcg() {
    tcgParsed = null;
    UI.setStatus("tcgSummary", "", "");
    $("tcgDetail").innerHTML = "";
    $("tcgActions").hidden = true;
  }

  async function runTcgImport() {
    const p = tcgParsed;
    const locationId = $("tcgDest").value;
    if (!p || !p.valid.length || !locationId) return;
    $("tcgGo").disabled = true; $("tcgPick").disabled = true;

    const receiptId = G.nextReceiptId("transfer");
    UI.toastProgress("Looking up " + p.valid.length + " card(s)…");
    const infos = await prefetchCardInfo(p.valid, v => ({ set: v.set, num: v.collector, lang: "en", finish: v.finish }), 8);
    const lines = [];
    let i = 0;
    p.valid.forEach((v, idx) => {
      // The file's own values are enough to hold the row on a lookup miss; a
      // later "Refresh prices & data" fills in the rest rather than dropping it.
      const info = infos[idx] || { name: v.name, collector: v.collector, setName: v.setName, rarity: v.rarity,
        tcgplayerId: "", scryfallId: "", price: null, priceNote: "", note: "", meta: {} };
      G.addCopies({
        set: v.set, num: v.collector, lang: "en", finish: v.finish, condition: v.condition,
        locationId, qty: v.quantity, info,
        action: "transfer", receiptId,
        note: "Imported from TCGplayer Pull Sheet (line " + v.line + ")"
      });
      lines.push({ set: v.set, collector: v.collector, lang: "en", finish: v.finish, condition: v.condition,
        name: v.name, qty: v.quantity, market: info.price, unitCost: 0, locationId });
      i++;
      UI.toastProgress("Importing " + i + " / " + p.valid.length + "…");
    });
    G.recordReceipt({
      kind: "transfer", receiptId,
      source: "TCGplayer Pull Sheet", note: "", spend: null, allocation: "transfer", lines
    });
    G.persist("Import " + p.valid.length + " row(s) from TCGplayer Pull Sheet");
    UI.toast("Imported " + p.valid.length + " row" + (p.valid.length === 1 ? "" : "s") +
      (p.errors.length ? ", " + p.errors.length + " skipped" : "") +
      " as " + receiptId + ". Undo reverses the whole import.", "ok");
    clearTcg();
    $("tcgPick").disabled = false;
    renderReceipts();
  }

  /* ============================== Import a file (CSV / TSV) ==============================
     A bulk version of "Add from collection" - one row per stack. A Purchase
     price / Cost column becomes the stack's cost basis (the other two entry
     modes in this receipt kind carry none). Understands ManaBox, Moxfield and
     Archidekt exports and plain spreadsheets (#327): a row with a card name
     but no collector number is matched by name (and set, code or full name,
     when given) through the card index; when more than one printing fits, the
     preview shows a dropdown and Import waits until every row has a choice. Ported from v0.07's
     importer (parser, column-alias matching, preview-before-commit), rewritten
     to write through G.addCopies() - which already merges, audits and normalises
     each row - instead of pushing straight into an array. */
  const CSV_ALIASES = {
    set: ["set", "setcode", "editioncode", "edition"],
    setName: ["setname", "editionname", "expansion"],
    collector: ["collectornumber", "collector", "collectorno", "collectornum", "number", "cardnumber", "cn", "no"],
    lang: ["language", "lang", "languagecode"],
    foil: ["foil", "finish", "isfoil"],
    condition: ["condition", "grade"],
    name: ["cardname", "name", "card", "productname"],
    price: ["priceusd", "price", "usd", "marketprice", "tcgmarketprice", "tcgmarketplaceprice"],
    quantity: ["quantity", "qty", "count", "addtoquantity", "totalquantity"],
    location: ["storagelocation", "location", "storage", "locationname", "bindername", "binder"],
    cost: ["purchaseprice", "cost", "costbasis", "unitcost", "pricepaid", "paid"],
    scryfallId: ["scryfallid", "scryfall", "scryfalluuid"]
  };
  const CSV_LABEL = { set: "Set", setName: "Set name", cost: "Purchase price", collector: "Collector #", lang: "Language", foil: "Finish", condition: "Condition",
    name: "Card Name", price: "Price (USD)", quantity: "Quantity", location: "Storage Location", scryfallId: "Scryfall ID" };

  let csvParsed = null;

  /* Everything a stack needs, straight from the file - no Scryfall lookup.
     Used when the lookup is switched off, and as the fallback when a lookup
     fails for one row (keep the file's own values rather than drop the row). */
  function csvFallbackInfo(v) {
    return { name: v.name, collector: v.collector, setName: "", rarity: "", tcgplayerId: "",
      scryfallId: v.scryfallId, price: v.price, priceNote: "", note: "", meta: {} };
  }

  function parseCsvImport(text) {
    const parsed = G.parseTabularRows(text);
    if (!parsed) return { error: "The file appears to be empty." };
    const { headers, dataRows } = parsed;
    const idx = G.mapAliasHeaders(headers, CSV_ALIASES);
    const hasSet = idx.set != null || idx.setName != null;
    if (idx.name == null && !(hasSet && idx.collector != null)) {
      return { error: "Couldn't find a card name column (Name or Card Name), or Set and Collector # columns, to identify the cards. " +
        "Add one of those and try again. Found headers: " + headers.join(", ") };
    }

    const valid = [], errors = [], warnings = [];
    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r];
      const line = r + 2; // 1-based, including the header row
      const get = f => idx[f] == null ? "" : String(row[idx[f]] == null ? "" : row[idx[f]]).trim();

      const set = (get("set") || get("setName")).toLowerCase();
      const collector = get("collector");
      const nameRaw = get("name");
      // No Storage Location column, or a row that leaves it blank, isn't an error - it just
      // falls back to one destination location chosen for the whole file (see csvDest).
      const locationName = get("location");
      // A collector number is optional when there is a name to match by (resolveCsvRows).
      if (collector && !set) { errors.push({ line, reason: "Set is blank" }); continue; }
      if (!collector && !nameRaw) { errors.push({ line, reason: "Needs a card name, or a set and collector #" }); continue; }

      const lang = get("lang").toLowerCase() || "en";

      const fl = get("foil").toLowerCase();
      let finish;
      if (["etched", "etched foil", "ef"].includes(fl)) finish = "etched";
      else if (["true", "1", "yes", "y", "foil", "t"].includes(fl)) finish = "foil";
      else if (["false", "0", "no", "n", "nonfoil", "non-foil", "normal", "regular", "f", ""].includes(fl)) finish = "nonfoil";
      else { errors.push({ line, reason: 'Finish is not recognised: "' + get("foil") + '"' }); continue; }

      // Softer than foil: wrong condition doesn't corrupt identity the way
      // wrong foil would, so an unrecognised value is a warning, not a skip.
      let condition = G.defaultCondition();
      const condRaw = get("condition");
      if (condRaw) {
        const code = G.conditionCode(condRaw);
        if (code) condition = code;
        else warnings.push({ line, msg: 'Condition "' + condRaw + '" not recognised — using ' + G.CONDITION_NAMES[condition] });
      }

      let price = null;
      const priceRaw = get("price");
      if (priceRaw !== "") {
        const n = parseFloat(priceRaw.replace(/[$,\s]/g, ""));
        if (isNaN(n)) { errors.push({ line, reason: 'Price is not numeric: "' + priceRaw + '"' }); continue; }
        price = n;
      } else if (idx.price != null) warnings.push({ line, msg: "Price blank — stored as no price (refresh later)" });

      let unitCost = null;
      const costRaw = get("cost");
      if (costRaw !== "") {
        const c = parseFloat(costRaw.replace(/[$,\s]/g, ""));
        if (isNaN(c) || c < 0) warnings.push({ line, msg: 'Purchase price "' + costRaw + '" is not a number — no cost recorded' });
        else unitCost = c;
      }

      let quantity;
      const qtyRaw = get("quantity");
      if (qtyRaw === "") { quantity = 1; warnings.push({ line, msg: "Quantity blank — using 1" }); }
      else {
        const q = G.parseWholeQty(qtyRaw);
        if (q == null) { errors.push({ line, reason: 'Quantity must be a whole number of 1 or more: "' + qtyRaw + '"' }); continue; }
        quantity = q;
      }

      const name = nameRaw;
      if (!name) warnings.push({ line, msg: "Card Name blank" });

      valid.push({ line, set, collector, lang, finish, condition, name, price, quantity, locationName,
        unitCost, scryfallId: get("scryfallId"), setText: get("set") || get("setName"), cells: row });
    }

    // What a skipped row said, as written, for the preview table and the "skipped rows" file.
    const raw = (row, f) => idx[f] == null || row[idx[f]] == null ? "" : String(row[idx[f]]).trim();
    errors.forEach(e => {
      const row = dataRows[e.line - 2];
      e.cells = row; e.name = raw(row, "name"); e.qty = raw(row, "quantity"); e.finish = raw(row, "foil");
    });

    return csvStats({ total: dataRows.length, valid, errors, warnings, detected: Object.keys(idx), headers,
      locHeader: idx.location == null ? "" : headers[idx.location] });
  }

  // Derived counts the preview shows; recomputed after rows are matched by name.
  function csvStats(p) {
    const existing = new Set(G.state.locations.map(l => l.name.trim().toLowerCase()));
    p.newLocs = [...new Set(p.valid.filter(v => v.locationName).map(v => v.locationName))]
      .filter(n => !existing.has(n.trim().toLowerCase()));
    p.needsFallback = p.valid.filter(v => !v.locationName).length;
    return p;
  }

  /* Rows with no collector number are matched by card name: one printings
     lookup per distinct name (bounded concurrency), not per row. A set given
     as a full name ("Commander Masters") is turned into its code first, for
     every row. With one fitting printing the row is simply matched; with
     several it gets `choices` and waits for a pick in the preview (a row with
     no set pre-selects the newest regular printing). Rows that match nothing
     move to the skipped list. */
  const IRREGULAR_SET_TYPES = new Set(["memorabilia", "funny", "token", "box"]);
  const IRREGULAR_SETS = new Set(["plst"]); // The List reprints
  async function resolveCsvRows(p) {
    // A set given by name (any punctuation) becomes its code via the TCGplayer importer's resolver.
    if (p.valid.some(v => v.set)) {
      try {
        const idx = await loadTcgSetsIndex();
        p.valid.forEach(v => {
          if (!v.set || idx.byCode.has(v.set)) return;
          const code = String(resolveTcgSet(v.setText || v.set, idx) || "").toLowerCase();
          if (idx.byCode.has(code)) v.set = code;
        });
      } catch (e) { /* codes only, then */ }
    }
    const today = G.localDay(Date.now());

    const todo = p.valid.filter(v => !v.collector);
    if (!todo.length) return p;
    const names = [...new Set(todo.map(v => v.name.toLowerCase()))];
    const byCard = new Map();
    let next = 0, done = 0;
    async function worker() {
      while (next < names.length) {
        const nm = names[next++];
        const sample = todo.find(v => v.name.toLowerCase() === nm).name;
        try {
          const list = await G.cards.printings(sample);
          byCard.set(nm, G.sortPrintingsNewest(G.groupPrintings(list), G.englishOf).map(g => G.englishOf(g)));
        } catch (e) { byCard.set(nm, null); }
        UI.setStatus("csvSummary", "Matching card names… " + (++done) + " / " + names.length, "work");
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, names.length) }, worker));

    const drop = new Map();
    for (const v of todo) {
      const all = byCard.get(v.name.toLowerCase());
      if (all == null) { drop.set(v, 'could not look up "' + v.name + '" (try again)'); continue; }
      if (!all.length) { drop.set(v, 'no card by that name: "' + v.name + '"'); continue; }
      const fit = v.set ? all.filter(c => c.set === v.set) : all;
      if (!fit.length) { drop.set(v, "no printing of " + v.name + ' in set "' + (v.setText || v.set.toUpperCase()) + '"'); continue; }
      if (fit.length === 1) { v.set = fit[0].set; v.collector = fit[0].collector; v.matchedByName = true; continue; }
      v.choices = fit.map(c => ({ set: c.set, collector: c.collector, label: csvPrintingLabel(c),
        released: !c.releasedAt || String(c.releasedAt) <= today,
        finishOk: !(c.finishes && c.finishes.length) || c.finishes.includes(v.finish),
        regular: !c.promo && !c.fullArt && c.borderColor !== "borderless" && c.borderColor !== "gold" &&
          !IRREGULAR_SET_TYPES.has(c.setType) && !IRREGULAR_SETS.has(c.set) }));
      // Newest regular, already-released printing (that has the row's finish); else the best that remains.
      const tiers = [c => c.regular && c.released && c.finishOk, c => c.regular && c.released, c => c.released, () => true];
      v.pick = v.set ? -1 : tiers.reduce((found, t) => found >= 0 ? found : v.choices.findIndex(t), -1);
    }
    dropCsvRows(p, drop);
    return csvStats(p);
  }

  // Rows that can't be imported move from p.valid to p.errors, keeping what the row said.
  function dropCsvRows(p, drop) {
    if (!drop.size) return;
    p.valid = p.valid.filter(v => !drop.has(v));
    drop.forEach((d, v) => {
      const o = typeof d === "string" ? { reason: d } : d;
      p.errors.push({ line: v.line, reason: o.reason, matched: o.matched || "", cells: v.cells, text: v.text,
        name: v.name, qty: String(v.quantity), finish: v.finish });
    });
    p.errors.sort((a, b) => a.line - b.line);
  }

  /* ---- Does the name match its set + number? (#328) ----
     Loose on purpose: case, punctuation, accents, "&", an Alchemy "A-" prefix; a
     double-faced card matches by either face or the full "A // B"; a printed
     (non-English) name counts as well as the English one. */
  const nameKey = s => String(s || "").toLowerCase().replace(/^a-/, "").replace(/&/g, " and ")
    .replace(/æ/g, "ae").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const nameKeys = s => {
    const full = nameKey(s);
    const faces = String(s || "").split(/\s*\/+\s*/).map(nameKey).filter(Boolean);
    return new Set([full].concat(faces));
  };
  function namesAgree(written, card) {
    const mine = nameKeys(written);
    for (const nm of [card && card.name, card && card.printedName]) {
      if (!nm) continue;
      for (const k of nameKeys(nm)) if (mine.has(k)) return true;
    }
    return false;
  }

  /* Looks every set + number up (bounded concurrency; the page's card cache means the
     import itself does not repeat it) and skips a row whose name belongs to a different
     card there. A number the catalog doesn't know is kept, with a warning. */
  const CSV_NOT_IN_CATALOG = "Set and number not found in the card catalog - imported as written, with no picture or price";
  async function verifyCsvRows(p) {
    const todo = p.valid.filter(v => v.set && v.collector && !v.info);
    if (!todo.length) return p;
    let next = 0, done = 0;
    async function worker() {
      while (next < todo.length) {
        const v = todo[next++];
        try { v.info = await G.lookupCard(v.set, v.collector, v.lang, v.finish); }
        catch (e) { v.lookupMiss = /^Not found/.test(e && e.message) ? "none" : "error"; }
        if (++done % 10 === 0 || done === todo.length) UI.setStatus("csvSummary", "Checking names against set + number… " + done + " / " + todo.length, "work");
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
    const drop = new Map();
    for (const v of todo) {
      if (v.lookupMiss === "none") { p.warnings.push({ line: v.line, msg: CSV_NOT_IN_CATALOG }); continue; }
      const card = v.info && v.info.card;
      if (!card || !v.name) continue;
      // Asked for a language Scryfall doesn't have, so the card is English: its name can't be compared.
      if (card.langFallback && v.lang !== "en") continue;
      if (namesAgree(v.name, card)) continue;
      const got = csvMatchedLabel(v);
      drop.set(v, { reason: "You wrote " + v.name + ", but " + v.set.toUpperCase() + " #" + v.collector + " is " + v.info.name, matched: got });
    }
    p.warnings.sort((a, b) => a.line - b.line);
    dropCsvRows(p, drop);
    return csvStats(p);
  }

  const csvMatchedLabel = v => v.info ? v.info.name + " (" + v.set.toUpperCase() + " #" + v.collector + ")" : "";

  // One line in a printing dropdown: the usual set/number/year/price label plus what sets variants apart.
  function csvPrintingLabel(c) {
    const hints = [];
    if (c.promo) hints.push("promo");
    if (c.fullArt) hints.push("full art");
    if (c.borderColor === "borderless") hints.push("borderless");
    const f = c.finishes || [];
    if (f.length && !f.includes("nonfoil")) hints.push(f.join("/") + " only");
    return G.printingChoiceLabel(c) + (hints.length ? " · " + hints.join(", ") : "");
  }

  function csvChoiceOptions(v) {
    return '<option value="-1">— choose a printing —</option>' +
      v.choices.map((c, i) => '<option value="' + i + '"' + (i === v.pick ? " selected" : "") + ">" + G.esc(c.label) + "</option>").join("");
  }

  const csvUnchosen = p => p.valid.filter(v => v.choices && v.pick < 0).length;
  function syncCsvGo() {
    const p = csvParsed;
    if (!p) return;
    const left = csvUnchosen(p);
    $("csvGo").disabled = !p.valid.length || left > 0 || !!(p.needsFallback && !$("csvDest").value);
    $("csvPickNote").textContent = left ? left + " row" + (left === 1 ? " still needs" : "s still need") + " a printing chosen before you can import." : "";
  }

  /* Pasted deck-site list (#240), e.g. "4 Lightning Bolt (M10) 146" or "1 Sol Ring (C21) 263 *F*".
     Only lines with a set code AND collector number import; name-only lines are rejected and
     listed back so the user can fix them - no printing is ever guessed. Same result shape as
     parseCsvImport so the preview/import path is shared. */
  const PASTE_LINE = /^(?:(\d+)\s*x?\s+)?(.+?)\s+\(([A-Za-z0-9]{2,6})\)\s+([A-Za-z0-9★†-]+)(?:\s+\*([FE])\*)?\s*$/i;
  const PASTE_HEADERS = /^(deck|main(board)?|sideboard|side|maybeboard|commander|companion|about|name .*|\/\/.*|#.*)$/i;
  function parsePasteList(text) {
    const valid = [], errors = [];
    let total = 0;
    String(text || "").split(/\r?\n/).forEach((raw, i) => {
      const t = raw.trim();
      if (!t || PASTE_HEADERS.test(t)) return;
      total++;
      const m = PASTE_LINE.exec(t);
      if (!m) { errors.push({ line: i + 1, text: t, name: t, qty: "", finish: "", reason: 'needs set + number: "' + t + '"' }); return; }
      const f = (m[5] || "").toUpperCase();
      valid.push({ line: i + 1, set: m[3].toLowerCase(), collector: m[4].replace(/^0+(?=\d)/, ""), lang: "en",
        finish: f === "E" ? "etched" : f === "F" ? "foil" : "nonfoil", condition: G.defaultCondition(),
        name: m[2].trim(), price: null, quantity: m[1] ? Math.max(1, parseInt(m[1], 10)) : 1,
        locationName: "", scryfallId: "", text: t });
    });
    if (!total) return { error: "Paste a list first, one card per line, like: 4 Lightning Bolt (M10) 146" };
    return { total, valid, errors, warnings: [], newLocs: [], needsFallback: valid.length, detected: [],
      source: "pasted list", unit: "line" };
  }

  /* ---- The preview table and the skipped-rows file (#328) ---- */
  const CSV_TABLE_MAX = 200;
  function csvTableHtml(rows, total, what) {
    const shown = rows.slice(0, CSV_TABLE_MAX);
    return '<div class="muted" style="margin-top:8px">' + what + (total > shown.length ? " (first " + shown.length + " of " + total.toLocaleString() + ")" : "") + '</div>' +
      '<div class="table-wrap"><table class="list"><thead><tr><th class="num">Line</th><th>Name as written</th><th>Card matched</th><th class="num">Qty</th>' +
      '<th class="hide-sm">Finish</th><th>Problem</th></tr></thead><tbody>' +
      shown.map(r => "<tr><td class=\"num\">" + r.line + "</td><td>" + G.esc(r.name || "") + "</td><td>" + G.esc(r.matched || "") + '</td><td class="num">' +
        G.esc(r.qty == null ? "" : r.qty) + '</td><td class="hide-sm">' + G.esc(r.finish || "") + "</td><td>" +
        (r.skipped ? '<span class="warn">Skipped: ' + G.esc(r.problem) + "</span>" : G.esc(r.problem || "")) + "</td></tr>").join("") +
      "</tbody></table></div>";
  }

  // Skipped rows first, then rows that import with a warning, then the clean ones.
  function csvRowsTable(p) {
    const warnBy = new Map();
    p.warnings.forEach(w => { if (!warnBy.has(w.line)) warnBy.set(w.line, []); warnBy.get(w.line).push(w.msg); });
    const rows = p.errors.map(e => ({ line: e.line, name: e.name, matched: e.matched, qty: e.qty, finish: e.finish, problem: e.reason, skipped: true }));
    const ok = p.valid.map(v => ({ line: v.line, name: v.name,
      matched: v.choices ? "see the printing list above" : csvMatchedLabel(v) || (v.set && v.collector ? v.set.toUpperCase() + " #" + v.collector : ""),
      qty: v.quantity, finish: v.finish, problem: (warnBy.get(v.line) || []).join("; ") }));
    const all = rows.concat(ok.filter(r => r.problem), ok.filter(r => !r.problem));
    return all.length ? csvTableHtml(all, all.length, "Every row, problems first") : "";
  }

  const skippedButtons = () => '<div class="form-row" style="margin-top:6px">' +
    '<button data-skip="dl">Download skipped rows</button><button data-skip="cp">Copy skipped rows</button></div>';

  // The skipped rows as the person wrote them (so they can be fixed and imported again), plus the reason for a file.
  function skippedFile(s) {
    if (s.source === "pasted list") return { text: s.errors.map(e => e.text || e.name).join("\n"), name: "grimoire-skipped-lines.txt", type: "text/plain" };
    const cells = s.errors.map(e => (e.cells || []).concat([e.reason]).map(G.csvRawCell).join(","));
    return { text: [(s.headers || []).concat(["Skipped because"]).map(G.csvRawCell).join(",")].concat(cells).join("\r\n"),
      name: "grimoire-skipped-rows.csv", type: "text/csv" };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
  }

  async function onSkippedClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest("button[data-skip]") : null;
    if (!btn) return;
    // The last import's box shows the rows left out of that import; the preview shows the ones in the file being checked.
    const s = btn.closest("#csvLast") ? lastSkipped : csvParsed;
    if (!s || !s.errors.length) return;
    const f = skippedFile(s);
    if (btn.dataset.skip === "dl") G.downloadBlob(new Blob([f.text], { type: f.type }), f.name);
    else if (await copyText(f.text)) UI.toast("Skipped rows copied.", "ok");
    else UI.toast("Could not copy. Use Download instead.", "err");
  }

  // After an import: how many rows were left out, and a way to see them.
  let lastSkipped = null;
  function renderLastImport(done, p) {
    lastSkipped = p.errors.length ? { errors: p.errors, headers: p.headers, source: p.source } : null;
    const box = $("csvLast");
    if (!box) return;
    box.innerHTML = '<div class="callout' + (p.errors.length ? " warn" : "") + '"><div><b>Last import: ' + done + " row" + (done === 1 ? "" : "s") + " imported" +
      (p.errors.length ? ", " + p.errors.length + " skipped" : "") + ".</b>" + (p.errors.length ? skippedButtons() : "") + "</div></div>" +
      (p.errors.length ? "<details><summary>See the skipped rows</summary>" +
        csvTableHtml(p.errors.map(e => ({ line: e.line, name: e.name, matched: e.matched, qty: e.qty, finish: e.finish, problem: e.reason, skipped: true })),
          p.errors.length, "Skipped rows") + "</details>" : "");
  }

  function renderCsvPreview(p) {
    if ($("csvLast")) $("csvLast").innerHTML = "";
    if (p.error) {
      UI.setStatus("csvSummary", p.error, "err");
      $("csvDetail").innerHTML = ""; $("csvOptions").hidden = true;
      csvParsed = null;
      return;
    }
    csvParsed = p;
    const detected = p.detected.map(f => CSV_LABEL[f] || f);
    UI.setStatus("csvSummary", p.valid.length + " valid · " + p.errors.length + " skipped · " +
      p.warnings.length + " warning(s), of " + p.total + (p.unit === "line" ? " line" : " data row") + (p.total === 1 ? "" : "s") + ".",
      p.valid.length ? "ok" : "err");
    let html = p.detected.length ? '<div class="muted">Matched columns: ' + G.esc(detected.join(", ")) + "</div>" : "";
    if (p.newLocs.length) html += '<div class="muted">' + p.newLocs.length + " new location" +
      (p.newLocs.length === 1 ? "" : "s") + " will be created" + (p.locHeader ? " from " + G.esc(p.locHeader) : "") + ": " +
      G.esc(p.newLocs.join(", ")) + "</div>";
    const byNameCount = p.valid.filter(v => v.matchedByName).length;
    if (byNameCount) html += '<div class="muted">' + byNameCount + " row" + (byNameCount === 1 ? "" : "s") +
      " matched by card name.</div>";
    const pickRows = p.valid.map((v, i) => ({ v, i })).filter(x => x.v.choices);
    if (pickRows.length) {
      html += '<b>Choose the printing for ' + pickRows.length + ' row' + (pickRows.length === 1 ? "" : "s") + ':</b>' +
        '<div class="muted">These cards have more than one printing' + (pickRows.some(x => !x.v.set) ? " (or no set in the file)" : " in that set") +
        ", so Grimoire doesn't guess.</div>" +
        '<div class="table-wrap"><table class="list"><thead><tr><th>Line</th><th>Card</th><th>Printing</th></tr></thead><tbody>' +
        pickRows.map(x => "<tr><td>" + x.v.line + "</td><td>" + G.esc(x.v.name) + "</td>" +
          '<td><select data-i="' + x.i + '" aria-label="Printing for ' + G.esc(x.v.name) + '">' + csvChoiceOptions(x.v) + "</select></td></tr>").join("") +
        "</tbody></table></div>";
    }
    if (p.needsFallback) html += '<div class="muted">' + p.needsFallback + " row" +
      (p.needsFallback === 1 ? " has" : "s have") + " no location in the file - pick a destination for " +
      (p.needsFallback === 1 ? "it" : "them") + " below.</div>";
    if (p.errors.length) {
      html += '<div class="callout warn"><div><b>' + p.errors.length + " row" + (p.errors.length === 1 ? " is" : "s are") +
        ' skipped and will not be imported.</b> Fix ' + (p.errors.length === 1 ? "it" : "them") +
        " and import again." + skippedButtons() + "</div></div>";
    }
    if (p.warnings.length) {
      const groups = new Map();
      p.warnings.forEach(w => { if (!groups.has(w.msg)) groups.set(w.msg, []); groups.get(w.msg).push(w.line); });
      html += '<b>Warnings (still imported):</b><ul style="margin:4px 0 8px 18px;padding:0">' +
        [...groups].map(([msg, lines]) => '<li class="muted">' + G.esc(msg) + " — " + lines.length + " row" + (lines.length === 1 ? "" : "s") +
          " (line" + (lines.length === 1 ? " " : "s ") + lines.slice(0, 8).join(", ") + (lines.length > 8 ? ", …" : "") + ")</li>").join("") + "</ul>";
    }
    html += csvRowsTable(p);
    $("csvDetail").innerHTML = html;
    $("csvOptions").hidden = false;
    $("csvDestRow").hidden = !p.needsFallback;
    syncCsvGo();
    $("csvGo").textContent = "Import " + p.valid.length + " row" + (p.valid.length === 1 ? "" : "s");
  }

  async function pickCsv() {
    const f = await G.pickFile(".csv,.tsv,.txt");
    if (!f) return;
    UI.setStatus("csvSummary", "Reading " + f.name + "…", "work");
    try {
      const p = parseCsvImport(f.text);
      if (!p.error) { await resolveCsvRows(p); await verifyCsvRows(p); }
      renderCsvPreview(p);
    }
    catch (e) { renderCsvPreview({ error: "Could not read the file: " + e.message }); }
  }

  async function previewPaste() {
    try {
      const p = parsePasteList($("pasteText").value);
      if (!p.error) await verifyCsvRows(p);
      renderCsvPreview(p);
    }
    catch (e) { renderCsvPreview({ error: "Could not read the list: " + e.message }); }
  }

  /* ---- "You already imported this" (#328) ----
     Each import leaves a small fingerprint in settings.importPrints: a bottom-64 sketch of
     hashes of its rows (set, number, language, finish, quantity), not the rows themselves, so
     a 1,200-row file costs the same ~0.5 KB as a 20-row list. Two imports whose sketches
     overlap by 80% or more are "the same file". Kept 30 days, newest 12. */
  const PRINT_DAYS = 30, PRINT_KEEP = 12, SKETCH = 64, PRINT_SIMILAR = 0.8, PRINT_MIN_ROWS = 3;
  function rowHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  function importSketch(valid) {
    const keys = new Set(valid.map(v => [v.set, G.normNum(v.collector), v.lang, v.finish, v.quantity].join("|")));
    return [...new Set([...keys].map(rowHash))].sort((a, b) => a - b).slice(0, SKETCH);
  }
  // Estimated share of rows two sketches have in common (exact when both hold every row).
  function sketchOverlap(a, b) {
    if (!a.length || !b.length) return 0;
    const inA = new Set(a), inB = new Set(b);
    const union = [...new Set(a.concat(b))].sort((x, y) => x - y).slice(0, SKETCH);
    return union.filter(h => inA.has(h) && inB.has(h)).length / union.length;
  }
  function findRepeatImport(valid) {
    if (valid.length < PRINT_MIN_ROWS) return null;
    const sk = importSketch(valid), cutoff = Date.now() - PRINT_DAYS * 86400000;
    return (G.state.settings.importPrints || []).filter(f => f.at >= cutoff && sketchOverlap(sk, (f.sk || []).map(x => parseInt(x, 36))) >= PRINT_SIMILAR)
      .sort((a, b) => b.at - a.at)[0] || null;
  }
  function rememberImport(valid, source) {
    if (valid.length < PRINT_MIN_ROWS) return;
    const cutoff = Date.now() - PRINT_DAYS * 86400000;
    const list = (G.state.settings.importPrints || []).filter(f => f.at >= cutoff);
    list.push({ at: Date.now(), rows: valid.length, src: source || "file", sk: importSketch(valid).map(h => h.toString(36)) });
    G.state.settings.importPrints = list.slice(-PRINT_KEEP);
  }

  function clearCsv() {
    if ($("csvLast")) $("csvLast").innerHTML = "";
    lastSkipped = null;
    csvParsed = null;
    $("pasteText").value = "";
    UI.setStatus("csvSummary", "", "");
    $("csvDetail").innerHTML = "";
    $("csvOptions").hidden = true;
  }

  async function runCsvImport() {
    const p = csvParsed;
    if (!p || !p.valid.length || csvUnchosen(p)) return;
    p.valid.forEach(v => {
      if (v.choices) { const c = v.choices[v.pick]; v.set = c.set; v.collector = c.collector; }
    });
    const fetchFromScryfall = $("csvFetch").checked;
    const defaultLocType = $("csvLocType").value;
    const repeat = findRepeatImport(p.valid);
    if (repeat) {
      const when = new Date(repeat.at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      const ok = await UI.confirmDialog("This looks like the " + (p.source === "pasted list" ? "list" : "file") + " you imported on " + when +
        ". Importing it again will add every card a second time.\n\nImport again anyway?",
        { title: "Already imported?", okLabel: "Import again anyway" });
      if (!ok) return;
    }
    $("csvGo").disabled = true; $("csvPick").disabled = true; $("pasteGo").disabled = true;

    const fallbackLocationId = $("csvDest").value;
    let infos = null;
    if (fetchFromScryfall) {
      // Rows already looked up while checking names (preview) are reused, not asked for again.
      const need = p.valid.filter(v => !v.info && !v.lookupMiss);
      UI.toastProgress("Looking up " + need.length + " card(s)…");
      const fresh = await prefetchCardInfo(need, v => ({ set: v.set, num: v.collector, lang: v.lang, finish: v.finish }), 8);
      const byRow = new Map(need.map((v, k) => [v, fresh[k]]));
      infos = p.valid.map(v => v.info || byRow.get(v) || null);
    }
    let i = 0;
    p.valid.forEach((v, idx) => {
      const locationId = v.locationName ? G.findOrCreateLocation(v.locationName, defaultLocType) : fallbackLocationId;
      // Keep the file's own values on a lookup miss, or when lookup wasn't requested at all.
      const info = (infos && infos[idx]) || csvFallbackInfo(v);
      G.addCopies({
        set: v.set, num: v.collector, lang: v.lang, finish: v.finish, condition: v.condition,
        locationId, qty: v.quantity, info, unitCost: v.unitCost == null ? null : v.unitCost,
        action: "import", note: "Imported from " + (p.source || "file") + " (line " + v.line + ")"
      });
      i++;
      UI.toastProgress("Importing " + i + " / " + p.valid.length + "…");
    });
    rememberImport(p.valid, p.source);
    G.persist("Import " + p.valid.length + " row(s) from file");
    UI.toast("Imported " + p.valid.length + " row" + (p.valid.length === 1 ? "" : "s") +
      (p.errors.length ? ", " + p.errors.length + " skipped (listed on this page)" : "") +
      ". Undo reverses the whole import.", "ok");
    clearCsv();
    $("csvPick").disabled = false; $("pasteGo").disabled = false;
    // Pasted list: keep only the rejected lines in the box (and listed) so fixing them cannot re-import the rest.
    if (p.source === "pasted list" && p.errors.length) {
      $("pasteText").value = p.errors.map(x => x.text || x.name).join("\n");
      await previewPaste();
    }
    renderLastImport(p.valid.length, p);
    renderReceipts();
  }

  function downloadCsvTemplate() {
    const headers = ["Set", "Collector #", "Language", "Finish", "Condition", "Card Name", "Price (USD)",
      "Quantity", "Storage Location", "Scryfall ID"];
    const example = ["mh3", "173", "en", "nonfoil", "NM", "Flare of Denial", "14.99", "3", "Binder 1", ""];
    const csv = [headers.join(","), example.map(G.csvCell).join(",")].join("\r\n");
    G.downloadBlob(new Blob([csv], { type: "text/csv" }), "grimoire-import-template.csv");
  }

  /* ============================== Ledger for option 1 ==============================
     "Add from collection" writes no receipt, because no money changed hands - so
     the audit trail IS the record. This is that trail, narrowed to adds and
     ordered newest first. The log lives server-side now (server/lib/audit.js);
     G.queryAudit() merges in anything logged this session that hasn't reached
     the server yet, which is what keeps "lands here the moment it's looked
     up" true below. With the Sealed switch on (#353) it lists sealed adds
     instead, as the old Receive Sealed page's "Added" list did. */
  const LEDGER_MAX = 400;
  function fetchLedger() {
    return G.queryAudit({ action: item === "sealed" ? "sealed-add" : "add", q: $("ledSearch").value.trim(), limit: 20000 });
  }

  async function renderLedger() {
    const body = $("ledBody");
    // Labels follow the Card / Sealed switch at once, even if the fetch fails.
    const want = item;
    const sealed = want === "sealed";
    const word = sealed ? "item" : "card";
    $("ledTitle").textContent = sealed ? "Sealed product added" : "Added from collection";
    $("ledItemTh").textContent = sealed ? "Product" : "Card";
    $("ledIntro").textContent = sealed ? "Every sealed product you have added, newest first." : "Every card you have added this way, newest first.";
    let res;
    try { res = await fetchLedger(); }
    catch (e) { if (want === item) body.innerHTML = UI.emptyRow(8, { icon: "error", title: "Could not load the ledger." }); return; }
    // The switch moved while this was loading: a newer call draws the list.
    if (want !== item) return;
    const rows = res.entries;
    const cards = rows.reduce((s, e) => s + (Number(e.qty) || 0), 0);
    $("ledHdr").textContent = res.total
      ? "— " + cards.toLocaleString() + " " + word + (cards === 1 ? "" : "s") + " over " +
        res.total.toLocaleString() + " entr" + (res.total === 1 ? "y" : "ies")
      : "— nothing yet";
    if (!rows.length) {
      body.innerHTML = UI.emptyRow(8, { icon: "cards", title: "Nothing added this way yet.",
        hint: sealed ? "Sealed product you add on the left lands here immediately."
          : "Cards you add on the left land here the moment they are looked up." });
      return;
    }
    // Same "match back to a still-owned stack" best-effort art as Audit Log -
    // a ledger entry never stored an image URL itself.
    const byIdentity = new Map();
    for (const r of G.state.cards) {
      byIdentity.set([r.set, r.collector, r.lang || "en", r.finish || "nonfoil"].join("|"), r.imageUrl);
    }
    const imgFor = e => byIdentity.get([e.set, e.collector, e.lang || "en", G.finishOf(e) || "nonfoil"].join("|")) || "";
    const shown = rows.slice(0, LEDGER_MAX);
    body.innerHTML = shown.map(e =>
      '<tr class="click">' + UI.artThumbTd(imgFor(e)) + "<td>" + G.esc(new Date(e.ts).toLocaleString()) + "</td>" +
      "<td>" + (sealed ? G.esc(e.name || "—") : UI.cardLink(e, e.name || "—")) + "</td>" +
      '<td class="muted">' + (sealed ? "—" : G.esc(G.printingLabel(e.set, e.collector, ""))) + "</td>" +
      "<td>" + (sealed || G.finishOf(e) === "nonfoil" ? '<span class="muted">—</span>' : '<span class="badge ' + G.finishOf(e) + '">' + G.esc(G.FINISH_NAMES[G.finishOf(e)].toUpperCase()) + "</span>") + "</td>" +
      '<td class="num">' + (e.qty > 0 ? "+" : "") + (e.qty || 0) + "</td>" +
      "<td>" + G.esc(e.to || "") + "</td>" +
      '<td class="wrap muted" style="font-size:11.5px">' + G.esc(e.note || "") + "</td></tr>").join("") +
      (res.total > LEDGER_MAX
        ? '<tr><td colspan="8" class="muted" style="text-align:center">Showing the newest ' + LEDGER_MAX +
          " of " + res.total.toLocaleString() + " — narrow the filter to reach older ones.</td></tr>"
        : "");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const e = shown[i];
      if (!e || !e.set || !e.collector) return;
      UI.wireArtHover(tr, imgFor(e));
      tr.onclick = () => reviewLine({ set: e.set, collector: e.collector, lang: e.lang, finish: G.finishOf(e) });
    });
    UI.reapplySorts();
  }

  async function exportLedger() {
    let rows;
    try { rows = (await fetchLedger()).entries; }
    catch (e) { UI.toast("Could not load the ledger.", "err"); return; }
    if (!rows.length) { UI.toast("Nothing in the ledger to export.", "err"); return; }
    if (item === "sealed") {
      const out = [["Added", "Product", "Qty", "Into", "Note"].map(G.csvCell).join(",")];
      for (const e of rows) out.push([e.ts, e.name, e.qty, e.to, e.note].map(G.csvCell).join(","));
      G.downloadBlob(new Blob([out.join("\r\n")], { type: "text/csv" }), "grimoire-sealed-added.csv");
      UI.toast("Exported " + rows.length + " ledger entries.", "ok");
      return;
    }
    const head = ["Added", "Card", "Set", "Collector #", "Language", "Finish", "Qty", "Into", "Note"];
    const lines = [head.map(G.csvCell).join(",")];
    for (const e of rows) {
      lines.push([e.ts, e.name, (e.set || "").toUpperCase(), e.collector,
        G.LANG_NAMES[e.lang] || e.lang || "", G.FINISH_NAMES[G.finishOf(e)],
        e.qty, e.to, e.note].map(G.csvCell).join(","));
    }
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-added-from-collection.csv");
    UI.toast("Exported " + rows.length + " ledger entries.", "ok");
  }

  /* ============================== Received on the floor (#388) ==============================
     A receipt opened here is booked in Warehouse Mode (rf/receive.page.js),
     which never sees the money. Closing it here spreads the money across
     everything booked and frees the copies to pick and list (core.js
     closeReceiving). Mana Pool orders aren't offered: they arrive with every
     line already filled in, so they stay on the desk. */
  let rcptTab = "this"; // the open inner tab of the Bought box: "this" | "floor"
  function showRcptTab(which) {
    if (which !== "floor") which = "this";
    if (kind === "lot") rcptTab = which;
    $("lotPane").hidden = which === "floor";
    $("floorSection").hidden = which !== "floor";
    for (const [id, w] of [["rcptTabThis", "this"], ["rcptTabFloor", "floor"]]) {
      $(id).classList.toggle("active", which === w);
      $(id).setAttribute("aria-selected", which === w ? "true" : "false");
    }
  }
  function renderFloor() {
    // Gate on the source, not on the pane: the list is refreshed (and the
    // tab's count kept right) while "This receipt" is the tab on show.
    if (kind !== "lot") return;
    const open = G.openReceivings();
    $("floorHdr").textContent = open.length ? open.length + " open" : "";
    $("floorCount").textContent = String(open.length);
    $("floorCount").hidden = !open.length;
    const body = $("floorBody");
    if (!open.length) {
      body.innerHTML = UI.emptyRow(7, { icon: "receipt", title: "No receipt is open on the floor.",
        hint: "Fill in where it came from and what you spent, then open it." });
      return;
    }
    body.innerHTML = open.map(rc => {
      const s = G.receivingSummary(rc.id);
      const booked = s.cards + s.sealed;
      return "<tr><td><b>" + G.esc(rc.receiptId) + "</b>" + (rc.note ? '<div class="muted">' + G.esc(rc.note) + "</div>" : "") + "</td>" +
        '<td class="hide-sm">' + G.esc(rc.source || "—") + "</td>" +
        '<td class="num">' + booked + (s.sealed ? ' <span class="muted">(' + s.sealed + " sealed)</span>" : "") + "</td>" +
        '<td class="num">' + s.toPutAway + "</td>" +
        '<td class="hide-sm">' + G.esc(s.receivers.join(", ") || "—") + "</td>" +
        '<td class="num">' + G.money(rc.spend || 0) + "</td>" +
        '<td class="row-actions">' + (booked
          ? '<button class="small floorClose" data-id="' + G.esc(rc.id) + '">Close</button>'
          : '<button class="small danger floorRemove" data-id="' + G.esc(rc.id) + '">Remove</button>') + "</td></tr>";
    }).join("");
    for (const b of body.querySelectorAll(".floorClose")) b.onclick = () => closeFloor(b.dataset.id);
    for (const b of body.querySelectorAll(".floorRemove")) b.onclick = () => removeFloor(b.dataset.id);
  }
  function openFloor() {
    let doc;
    try {
      doc = G.openReceiving({ source: $("floorSource").value, spend: $("floorSpend").value, alloc: $("floorAlloc").value,
        note: $("floorNote").value, date: $("floorDate").value });
    } catch (e) { UI.toast(e.message, "err"); return; }
    G.persist("Receipt " + doc.receiptId + " opened for Warehouse Mode");
    $("floorSource").value = $("floorSpend").value = $("floorNote").value = $("floorDate").value = "";
    renderFloor();
    UI.toast("Opened " + doc.receiptId + ". It's on the Receive screen in Warehouse Mode now.", "ok");
  }
  // Depends on the floor: catch up first, then read it again by id.
  async function closeFloor(id) {
    const c = await G.catchUp();
    if (!c.ok) { UI.toast("Couldn't get the latest from Warehouse Mode, so nothing was closed. Check the connection and try again.", "err"); return; }
    const s = G.receivingSummary(id);
    if (!s) { renderFloor(); return; }
    const rc = s.doc;
    const parts = [s.cards ? s.cards + " card" + (s.cards === 1 ? "" : "s") : "", s.sealed ? s.sealed + " sealed" : ""].filter(Boolean).join(" and ");
    const ok = await UI.confirmDialog("Close " + rc.receiptId + "?\n\n" + parts + " booked" + (s.receivers.length ? " by " + s.receivers.join(", ") : "") + ". " +
      (Number(rc.spend) > 0 ? G.money(rc.spend) + " spreads across them by " + (rc.alloc === "even" ? "card, evenly" : "market value") + "."
        : "Nothing was spent, so no cost is recorded.") +
      "\nThey can be picked and listed once it's closed." +
      (s.toPutAway ? "\n\n" + s.toPutAway + " still to put away, in " + s.trays.join(", ") + ". They stay there as ordinary stock." : "") +
      "\n\nAnything booked after this goes on a new receipt.",
      { title: "Close receipt?", okLabel: "Close it" });
    if (!ok) return;
    // Again right before acting: a phone may have booked more while the question was up.
    const again = await G.catchUp();
    if (!again.ok) { UI.toast("Couldn't get the latest from Warehouse Mode, so nothing was closed. Check the connection and try again.", "err"); return; }
    if (!G.receivingById(id)) { UI.toast("Someone else already closed " + rc.receiptId + ".", "work"); renderFloor(); return; }
    const out = G.closeReceiving(id);
    G.persist("Receipt " + rc.receiptId + " closed");
    renderFloor(); renderReceipts();
    UI.toast("Closed " + rc.receiptId + ": " + out.doc.totalCards + " item" + (out.doc.totalCards === 1 ? "" : "s") + " for " + G.money(out.doc.spend || 0) +
      (out.toPutAway ? ". " + out.toPutAway + " still to put away." : "."), "ok");
  }
  async function removeFloor(id) {
    const rc = G.receivingById(id);
    if (!rc) return;
    const ok = await UI.confirmDialog("Remove " + rc.receiptId + "? Nothing has been booked on it.", { title: "Remove open receipt?", okLabel: "Remove it", danger: true });
    if (!ok) return;
    const c = await G.catchUp();
    if (!c.ok) { UI.toast("Couldn't get the latest from Warehouse Mode, so nothing was removed.", "err"); return; }
    if (!G.discardReceiving(id)) { UI.toast("Something was booked on " + rc.receiptId + " meanwhile, so it stays. Close it instead.", "err"); renderFloor(); return; }
    G.persist("Open receipt " + rc.receiptId + " removed");
    renderFloor();
  }

  /* ============================== Receipt history ============================== */
  function renderReceipts() {
    const rows = G.state.receipts;
    $("recHdr").textContent = rows.length
      ? rows.length + " receipt" + (rows.length === 1 ? "" : "s") + " · " +
        G.money(rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)) + " spent in total"
      : "none yet";
    const body = $("recBody");
    if (!rows.length) {
      body.innerHTML = UI.emptyRow(9, { icon: "orders", title: "No receipts yet.",
        hint: "Bought and File create one. Already mine doesn't, because no money changed hands." });
      return;
    }
    body.innerHTML = "";
    // A receipt line never stored an image URL - best-effort match its first
    // line (of possibly several different cards) against a stack still owned
    // today with the same identity. Genuinely blank for an old receipt whose
    // stack was since sold/deleted (honest gap), same convention as the
    // Ledger/Audit Log above.
    const byIdentity = new Map();
    for (const c of G.state.cards) {
      byIdentity.set([c.set, c.collector, c.lang || "en", c.finish || "nonfoil"].join("|"), c.imageUrl);
    }
    const imgForReceipt = r => {
      for (const l of (r.lines || [])) {
        if (!l.set || !l.collector) continue;
        const img = byIdentity.get([l.set, l.collector, l.lang || "en", l.finish || "nonfoil"].join("|"));
        if (img) return img;
      }
      return "";
    };
    for (const r of rows.slice(0, 200)) {
      const tr = document.createElement("tr");
      tr.className = "click";
      const per = r.totalCards ? r.totalCost / r.totalCards : null;
      tr.innerHTML =
        UI.artThumbTd(imgForReceipt(r)) +
        "<td><b>" + G.esc(r.receiptId || "—") + "</b></td>" +
        "<td>" + G.esc(new Date(r.ts).toLocaleDateString()) + "</td>" +
        '<td class="hide-lg"><span class="pill type">' + G.esc(r.kind) + "</span></td>" +
        '<td class="hide-md">' + G.esc(r.source || r.fromUser || "") + "</td>" +
        '<td class="num">' + r.totalCards + "</td>" +
        '<td class="num">' + (r.spend == null ? '<span class="muted">—</span>' : G.money(r.spend)) + "</td>" +
        '<td class="num hide-lg">' + (per == null || !per ? '<span class="muted">—</span>' : G.money(per)) + "</td>";
      const td = document.createElement("td");
      td.innerHTML = '<button class="small">Lines</button>';
      td.querySelector("button").onclick = e => { e.stopPropagation(); showReceipt(r); };
      tr.appendChild(td);
      UI.wireArtHover(tr, imgForReceipt(r));
      tr.onclick = () => showReceipt(r);
      body.appendChild(tr);
    }
  }

  function showReceipt(r) {
    UI.ensureModal("receiptModal", "wide",
      '<h3 id="rcTitle"></h3><div id="rcMeta" class="muted" style="margin-bottom:10px"></div>' +
      '<div class="list-wrap"><table class="list" data-sort><thead><tr><th>Card</th><th>Printing</th><th>Finish</th>' +
      '<th class="num">Qty</th><th class="num">Market ea.</th><th class="num">Cost ea.</th>' +
      '<th class="num">Line cost</th><th>Location</th></tr></thead><tbody id="rcBody"></tbody></table></div>' +
      '<hr><div class="modal-actions"><button id="rcPrint"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#printer></use></svg> Print</button><span class="spacer"></span>' +
      '<button id="rcClose">Close</button></div>');
    $("rcTitle").textContent = "Receipt " + (r.receiptId || "");
    $("rcMeta").textContent = [
      new Date(r.ts).toLocaleString(),
      r.kind,
      r.source || r.fromUser || "",
      r.spend == null ? "no purchase price" : G.money(r.spend) + " spent",
      "allocated by " + (r.allocation || "market"),
      r.note || ""
    ].filter(Boolean).join(" · ");
    // A sealed receipt line (postLot's sealed branch) carries setCode
    // instead of set/collector - no printing/finish concept at all for
    // sealed, so this falls back to just the set code rather than
    // G.printingLabel's "SET – #undefined"-shaped output for a card line.
    $("rcBody").innerHTML = (r.lines || []).map(l =>
      '<tr><td class="card-name">' + (l.set && l.collector ? UI.cardLink(l) : G.esc(l.name)) + "</td>" +
      "<td>" + (l.set && l.collector ? G.esc(G.printingLabel(l.set, l.collector, "")) : G.esc(String(l.setCode || "").toUpperCase())) + "</td>" +
      "<td>" + (l.finish && l.finish !== "nonfoil" ? G.esc(G.FINISH_NAMES[l.finish]) : "—") + "</td>" +
      '<td class="num">' + l.qty + "</td>" +
      '<td class="num">' + G.money(l.market) + "</td>" +
      '<td class="num">' + G.money(l.unitCost) + "</td>" +
      '<td class="num">' + G.money((l.unitCost || 0) * l.qty) + "</td>" +
      "<td>" + G.esc(G.locName(l.locationId)) + "</td></tr>").join("");
    UI.reapplySorts();
    $("rcClose").onclick = () => UI.hideModal("receiptModal");
    $("rcPrint").onclick = () => {
      G.printList("Receipt " + (r.receiptId || ""),
        ["Card", "Printing", "Finish", "Qty", "Market ea.", "Cost ea.", "Line cost", "Location"],
        (r.lines || []).map(l => [G.esc(l.name),
          l.set && l.collector ? G.esc(G.printingLabel(l.set, l.collector, "")) : G.esc(String(l.setCode || "").toUpperCase()),
          l.finish && l.finish !== "nonfoil" ? G.FINISH_NAMES[l.finish] : "", l.qty, G.money(l.market), G.money(l.unitCost),
          G.money((l.unitCost || 0) * l.qty), G.esc(G.locName(l.locationId))]),
        $("rcMeta").textContent);
    };
    UI.showModal("receiptModal", "rcClose");
  }

  /* ============================== First location (#235) ============================== */
  // A status line with a real link (setStatus only sets text).
  function setLocationsLink(lead, cls) {
    UI.setStatus("entryStatus", "", cls);
    $("entryStatus").innerHTML = G.esc(lead) + '<a href="/locations.html">Locations page</a>.';
  }
  // A personal account with no location at all gets "My Collection" so Receive
  // is never a dead end. Organization members are left alone: their document is
  // the Store's, shared with every coworker. Same shape as the tour's (#239).
  function ensureFirstLocation() {
    if ((G.me && G.me.orgId) || G.state.locations.length) return null;
    const l = G.createLocation({ name: "My Collection", type: "Other" });
    G.state.locations.push(l);
    G.logAudit({ action: "location", to: l.name, note: 'Created location "' + l.name + '" (Other) automatically when receiving with no location' });
    G.persist();
    return l;
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    simpleMode = G.simpleMode;
    if (simpleMode) { $("kinds").hidden = true; $("kindsIntro").hidden = true; }
    preview = UI.CardPanel("preview", {});
    $("inLang").innerHTML = Object.entries(G.LANG_NAMES)
      .map(([k, v]) => '<option value="' + k + '">' + G.esc(v) + "</option>").join("");
    $("inCondition").innerHTML = G.CONDITIONS
      .map(c => '<option value="' + c + '">' + G.esc(G.CONDITION_NAMES[c]) + "</option>").join("");
    $("inCondition").value = G.defaultCondition();
    $("csvLocType").innerHTML = G.LOC_TYPES
      .map(t => '<option value="' + G.esc(t) + '">' + G.esc(t) + "</option>").join("");
    $("autoPutaway").checked = G.state.settings.autoPutaway !== false;
    storeLocked = !G.canManageStore();
    if (storeLocked) {
      $("autoPutaway").disabled = $("lotAlloc").disabled = true;
      $("autoPutawayStoreNote").hidden = $("lotAllocStoreNote").hidden = false;
    }
    $("inSetSticky").checked = G.state.settings.stickySetCode !== false;

    UI.Autocomplete("inSearch", "acList", loadPrintings);
    $("modeSearch").onclick = () => setMode("search");
    $("modeManual").onclick = () => setMode("manual");
    $("modeImport").onclick = () => setMode("import");
    $("csvPick").onclick = pickCsv;
    $("csvClear").onclick = clearCsv;
    $("csvDetail").onclick = onSkippedClick;
    $("csvLast").onclick = onSkippedClick;
    $("pasteGo").onclick = previewPaste;
    $("csvGo").onclick = runCsvImport;
    $("csvTemplate").onclick = downloadCsvTemplate;
    $("csvDest").onchange = () => { if (csvParsed) renderCsvPreview(csvParsed); };
    $("csvDetail").onchange = e => {
      const t = e && e.target, i = t && t.getAttribute && t.getAttribute("data-i");
      if (i == null || !csvParsed || !csvParsed.valid[i]) return;
      csvParsed.valid[i].pick = parseInt(t.value, 10);
      syncCsvGo();
    };
    $("inPrinting").onchange = showPicked;
    $("inPrintFilter").addEventListener("input", () => { renderPrintingOptions(); showPicked(); });
    ["inSet", "inNum"].forEach(id => $(id).addEventListener("input", manualPreview));
    $("inLang").onchange = () => { if (entryMode === "manual") manualPreview(); else if (entryMode === "search") showPicked(); };
    $("inFoil").onchange = () => { userFinish = $("inFoil").value; if (entryMode === "search") showPicked(); else manualPreview(); };
    $("inQty").oninput = () => { const c = currentPicked(); if (c) applyAutoPutaway(c, $("inFoil").value); };
    $("autoPutaway").onchange = () => {
      if (storeLocked) return;
      G.state.settings.autoPutaway = $("autoPutaway").checked;
      G.persistSettings();
      const c = currentPicked();
      if (c) applyAutoPutaway(c, $("inFoil").value);
    };
    $("inSetSticky").onchange = () => {
      G.state.settings.stickySetCode = $("inSetSticky").checked;
      G.persistSettings();
    };
    $("btnAdd").onclick = submitAdd;
    ["inSet", "inNum", "inQty", "inLineCost"].forEach(id =>
      $(id).addEventListener("keydown", e => { if (e.key === "Enter") submitAdd(); }));
    $("queueClear").onclick = () => {
      addQueue = addQueue.filter(j => j.status === "queued" || j.status === "working");
      renderQueue();
    };

    $("srcMine").onclick = () => setKind("collection");
    $("srcBought").onclick = () => setKind("lot");
    $("srcFile").onclick = () => setKind("transfer");
    $("srcManapool").onclick = () => setKind("manapool");
    $("mpRefresh").onclick = () => loadPurchases(false);
    $("mpMore").onclick = () => loadPurchases(true);
    $("mpShowDone").onclick = () => { mpShowDone = !mpShowDone; renderPurchases(); };
    $("lotMpMark").onchange = () => {
      const mp = draft().manapool;
      if (mp) { mp.markReceived = $("lotMpMark").checked; saveDraft(); }
    };
    // The File section's "Already mine → Paste a list" link, without a reload.
    $("xferToPaste").onclick = e => { e.preventDefault(); setKind("collection"); setItem("card"); setMode("import"); };
    setTransferMode("xfer");

    $("itemCard").onclick = () => setItem("card");
    $("itemSealed").onclick = () => setItem("sealed");
    mountProductPicker();
    $("sldAdd").onclick = submitSealed;
    ["sldQty", "sldCost"].forEach(id =>
      $(id).addEventListener("keydown", e => { if (e.key === "Enter") submitSealed(); }));

    // Lot header fields write straight into the draft.
    const bindDraft = (id, key, num) => {
      $(id).addEventListener("input", () => {
        draft()[key] = num ? $(id).value : $(id).value;
        saveDraft();
        renderLot();
      });
    };
    bindDraft("lotId", "receiptId"); bindDraft("lotSource", "source");
    bindDraft("lotDate", "date"); bindDraft("lotSpend", "spend", true);
    bindDraft("lotNote", "note");
    $("lotSpend").addEventListener("blur", () => renderLot());
    $("lotAlloc").onchange = () => {
      if (storeLocked) return;
      draft().alloc = $("lotAlloc").value;
      // "price paid" only means something on a Mana Pool order: never the default.
      if ($("lotAlloc").value !== "paid") G.state.settings.lotAllocation = $("lotAlloc").value;
      saveDraft(); renderLot();
    };
    $("lotPost").onclick = postLot;
    $("lotDiscard").onclick = () => discardDraft(draft().id);
    $("lotNewDraft").onclick = createDraft;

    $("xferPick").onclick = pickTransfer;
    $("xferClear").onclick = () => {
      transfer = null; $("xferSection").hidden = true; UI.setStatus("xferSummary", "", "");
    };
    $("xferDest").onchange = renderTransfer;
    $("xferPutaway").onchange = renderTransfer;
    $("xferCost").onchange = renderTransfer;
    $("xferPost").onclick = postTransfer;

    $("modeXferFile").onclick = () => setTransferMode("xfer");
    $("modeTcgSheet").onclick = () => setTransferMode("tcg");
    $("tcgPick").onclick = pickTcgSheet;
    $("tcgClear").onclick = clearTcg;
    $("tcgDest").onchange = () => { if (tcgParsed) renderTcgPreview(tcgParsed); };
    $("tcgGo").onclick = runTcgImport;

    $("inLoc").onchange = () => { saveLastLoc($("inLoc").value); syncTray(); };
    for (const [box, field] of Object.entries(KEEP)) {
      $(field).addEventListener("change", saveKeep);
      $(box).onchange = () => {
        // The lock keeps what the box shows, even a finish this card picked by itself.
        if (field === "inFoil") {
          if ($(box).checked) userFinish = $(field).value;
          autoPickFinish(currentPicked());
        }
        // Auto putaway has stopped having a say: don't leave its message up.
        if (box === "keepLoc" && $(box).checked && /^Putaway/.test($("entryStatus").textContent)) UI.setStatus("entryStatus", "", "");
        saveKeep();
      };
    }
    $("ledSearch").addEventListener("input", G.debounce(renderLedger, 180));
    $("ledCsv").onclick = exportLedger;
    $("floorOpen").onclick = openFloor;
    $("rcptTabThis").onclick = () => showRcptTab("this");
    $("rcptTabFloor").onclick = () => showRcptTab("floor");
    $("floorAlloc").value = G.state.settings.lotAllocation === "even" ? "even" : "market";
    // A Store's managers set how the money spreads, as on a lot draft.
    if (storeLocked) $("floorAlloc").disabled = true;

    G.on("change", () => {
      UI.fillLocationSelect($("inLoc"), $("inLoc").value, {});
      if (item === "sealed") UI.fillLocationSelect($("sldLoc"), $("sldLoc").value, {});
      renderReceipts();
      renderFloor();
      syncTray();
      if (!$("ledgerSection").hidden) renderLedger();
      // An Undo can take a Mana Pool receipt back off: the list says so again.
      if (kind === "manapool" && purchases && !purchases.loading) renderPurchases();
    });
    const madeDefault = ensureFirstLocation();
    UI.fillLocationSelect($("inLoc"), null, {});
    if (madeDefault) $("inLoc").value = madeDefault.id;
    // Default to a sorting tray when one exists - counting a box in is the
    // common case, and it is the flow the whole bin plan is built around.
    const trays = G.stagingBins();
    if (trays.length && !madeDefault) $("inLoc").value = trays[0].id;
    // The last location this person used wins, across visits (#330).
    const lastLoc = loadLastLoc();
    if (lastLoc && G.locById(lastLoc) && !madeDefault) $("inLoc").value = lastLoc;
    loadKeep();
    syncTray();
    const params = new URLSearchParams(location.search);
    // ?mode=import (#244: the Dashboard's "Next steps") opens the paste/file
    // import straight away. Only "Already mine" offers it, so it wins over
    // opening a draft in progress.
    const wantImport = params.get("mode") === "import";
    // A lot draft in progress opens on Bought. If the open tab is empty but
    // another has lines (the old Receive Sealed draft, moved in by drafts()),
    // show that one.
    const busy = drafts().find(d => d.lines.length);
    if (busy && !draft().lines.length) G.state.settings.activeDraftLotId = busy.id;
    if (movedSealedDraft) saveDraft();
    if (busy && !wantImport) setKind("lot");
    else setKind("collection");
    if (movedSealedDraft) UI.toast("Your sealed lot draft from Receive Sealed is here now, as a lot receipt tab under Bought.", "work");
    else if (busy) UI.toast("You have a lot receipt in progress with " + draft().lines.length + " line(s).", "work");
    renderReceipts();
    renderLedger();
    setMode(wantImport && kind === "collection" ? "import" : "search");
    // ?item=sealed: where the old Receive Sealed page (and the Sealed page's
    // link) now lands. Full mode only; setItem ignores it in Simple mode.
    if (params.get("item") === "sealed") setItem("sealed");

    if (madeDefault) {
      setLocationsLink('We made a place for your cards called "My Collection". You can rename it on the ', "ok");
    } else if (!G.state.locations.length) {
      setLocationsLink("There are no storage locations yet. Cards have to go somewhere: create one on the ", "");
    }
  });
})();
