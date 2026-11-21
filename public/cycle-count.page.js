
"use strict";
(function () {
  const $ = UI.$;
  const finishText = f => f && f !== "nonfoil" ? G.FINISH_NAMES[f] : "—";

  /* A search box + printing <select> + foil <select>, wrapping the shared
     UI.loadPrintingSelect (also used by Putaway/Locations' pickers) - "type
     a card, pick the exact printing" for "enter what you found" (floor→book)
     and "found, not in the book" (full count). One instance per DOM
     id-prefix so the page can mount it more than once. */
  function mountPicker(searchId, acListId, printSelId, foilSelId) {
    let printings = [];
    function loadPrintings(name) {
      return UI.loadPrintingSelect(printSelId, name).then(list => { printings = list; });
    }
    UI.Autocomplete(searchId, acListId, loadPrintings);
    return {
      current() {
        const c = printings[parseInt($(printSelId).value, 10)];
        if (!c) return null;
        return { name: c.name, set: c.set, collector: c.collector, setName: c.setName,
          lang: c.lang || "en", finish: $(foilSelId).value, imageUrl: c.imageUrl || "" };
      },
      reset() {
        printings = [];
        $(searchId).value = "";
        $(printSelId).innerHTML = '<option value="">— pick a card first —</option>';
        $(foilSelId).value = "nonfoil";
      }
    };
  }

  let fbPicker, fcPicker;

  /* Sealed's equivalent of mountPicker() above - searches the Manapool
     sealed catalog (GET /api/sealed/search, same as Receive's Sealed switch) rather
     than Scryfall printings, since a sealed pick has no card/foil axis at
     all, just "which product." */
  function mountSealedPicker(searchId, acListId) {
    let picked = null;
    const search = G.debounce(async () => {
      const q = $(searchId).value.trim();
      if (q.length < 2) { $(acListId).hidden = true; return; }
      let results;
      try { results = (await G.api("/api/sealed/search?q=" + encodeURIComponent(q))).data || []; }
      catch (e) { $(acListId).hidden = true; return; }
      const list = $(acListId);
      if (!results.length) { list.hidden = true; return; }
      list.innerHTML = results.map((p, i) =>
        '<div class="ac-item" data-i="' + i + '">' + G.esc(p.name) +
        ' <span class="muted">' + G.esc(String(p.setCode || "").toUpperCase()) + "</span></div>").join("");
      [...list.querySelectorAll(".ac-item")].forEach((el, i) => {
        el.addEventListener("mousedown", e => {
          e.preventDefault();
          picked = results[i];
          $(searchId).value = picked.name;
          list.hidden = true;
        });
      });
      list.hidden = false;
    }, 180);
    $(searchId).addEventListener("input", search);
    $(searchId).addEventListener("blur", () => setTimeout(() => { $(acListId).hidden = true; }, 150));
    return {
      current() { return picked; },
      reset() { picked = null; $(searchId).value = ""; }
    };
  }
  let scPicker;

  /* ============================== Tabs ============================== */
  let tabs;

  function threshold() { return Number(G.state.settings.cycleCountErrorThreshold) || 10; }

  /* ============================== Copies in a tote (#395) ==============================
     Pulled in Warehouse Mode: off the shelf, still on the book until Finish. Every
     tab asks about the shelf, and says so next to a stack that has any. */
  const toteLine = t => (t && t.qty ? '<div class="short-tag toteNote" style="min-width:11em">' + G.esc(G.toteWords(t)) + "</div>" : "");
  function renderToteCallout(hostId, rows) {
    const cards = rows.reduce((n, r) => n + (r.tote ? r.tote.qty : 0), 0);
    $(hostId).innerHTML = !cards ? "" :
      '<div class="callout warn"><span class="cico">' + UI.icon("triangle-alert") + '</span><div class="cbody"><h3>' +
      cards + (cards === 1 ? " copy" : " copies") + " from this bin " + (cards === 1 ? "is" : "are") + " in a tote</h3>" +
      "Book qty here is what should be on the shelf. Count only the shelf: the book keeps what's in a tote until picking finishes.</div></div>";
  }
  /* A desk page only hears of a pull on the floor when it asks (G.catchUp). Asked
     when a bin opens, so the screen starts right, and again right before Apply,
     where no answer means the count isn't applied: what's typed stays on screen. */
  async function caughtUp(btn) {
    if ((await G.catchUp(btn)).ok) return true;
    UI.toast("Couldn't reach the server to check for cards picked on another device, so the count wasn't applied. Nothing changed. Check the connection and press Apply again.", "err");
    return false;
  }
  const openFresh = (render, refresh) => { render(); G.catchUp().then(r => { if (r.loaded) refresh(); }); };
  const openFull = () => openFresh(renderFull, refreshFull);
  const openSealed = () => openFresh(renderSealed, refreshSealed);
  function sayMoved(names) {
    // Any change to these stacks while counting (#474): a pick, a desk move, another device.
    UI.toast("The stock of " + names.join(", ") + " changed while you were counting (a pick, a move or another device). Count " + (names.length === 1 ? "it" : "them") + " again, then apply.", "err");
  }
  /* The catch-up after a bin opens can take seconds, and counters don't wait for it:
     the boxes are open from the start. So it never rebuilds the table: a rebuilt box
     loses its cursor, and the next digit lands in front of the number (3 becomes 35).
     Only what changed is touched, row by row, and a box nobody needs to change is left
     exactly as it is, value, selection and cursor. A row's number can only be replaced
     if it's typed and its tote moved, or untouched and its expected number moved.
     If that's the box the cursor is in, the cursor leaves it, so the next key can't
     land in a number nobody chose, and the message names the card. `movedWhileOpen`
     lets an Apply pressed during the same catch-up know it mustn't go on. The
     found-cards list isn't touched. `t` is the tab: { body, inputClass, rowHtml, wire,
     rows, show, redraw }. */
  let movedWhileOpen = 0;
  function patchRows(t, fresh) {
    const rows = t.rows();
    const held = x => (x ? x.qty : 0);
    const toteOf = r => (r.tote ? r.tote.qty + ":" + r.tote.by.join() : "");
    const sameRow = (a, b) => a.bookQty === b.bookQty && toteOf(a) === toteOf(b);
    if (rows.length === fresh.length && rows.every((r, i) => r.recordId === fresh[i].recordId && sameRow(r, fresh[i]))) return;
    const body = t.body();
    const trs = new Map([...body.querySelectorAll("tr[data-rec]")].map(tr => [tr.dataset.rec, tr]));
    const freshById = new Map(fresh.map(n => [n.recordId, n]));
    const active = document.activeElement;
    const cleared = [], merged = [];
    for (const r of rows) {
      const n = freshById.get(r.recordId), tr = trs.get(r.recordId);
      const box = tr ? tr.querySelector("." + t.inputClass) : null;
      const typed = !!box && String(box.value) !== String(r.bookQty);
      if (!n) {
        if (tr) tr.remove();
        if (typed || box === active) cleared.push(r.name);
        continue;
      }
      merged.push(n);
      if (!tr || sameRow(r, n)) continue;
      tr.querySelector("td.num").textContent = n.bookQty;
      tr.querySelector(".toteSlot").innerHTML = toteLine(n.tote);
      if (typed ? held(r.tote) === held(n.tote) : r.bookQty === n.bookQty) continue;
      box.value = n.bookQty;
      if (box === active) box.blur();
      if (typed || box === active) cleared.push(n.name);
    }
    // New to this bin: added at the end, so nothing already on screen moves.
    const known = new Set(rows.map(r => r.recordId));
    for (const n of fresh) {
      if (known.has(n.recordId)) continue;
      merged.push(n);
      if (rows.length) {
        body.insertAdjacentHTML("beforeend", t.rowHtml(n, merged.length - 1));
        t.wire(body.lastElementChild, n);
      }
    }
    t.show(merged);
    if (!rows.length || !merged.length) t.redraw();   // to or from the empty row: no box to keep
    else body.querySelectorAll("." + t.inputClass).forEach((box, i) => { box.dataset.i = String(i); });   // same order as merged
    if (cleared.length) { movedWhileOpen++; sayMoved(cleared); }
  }
  function refreshFull() {
    const binId = $("fcBin").value;
    if (binId) patchRows({ body: () => $("fcBody"), inputClass: "fcCounted", rowHtml: fcRowHtml, wire: wireFcRow, rows: () => fcRows, redraw: renderFcBody,
      show: rows => { fcRows = rows; showFcHdr(); renderToteCallout("fcTote", fcRows); } }, fullRows(binId));
  }
  function refreshSealed() {
    const binId = $("scBin").value;
    if (binId) patchRows({ body: () => $("scBody"), inputClass: "scCounted", rowHtml: scRowHtml, wire: () => {}, rows: () => scRows, redraw: renderScBody,
      show: rows => { scRows = rows; showScHdr(); renderToteCallout("scTote", scRows); } }, sealedRows(binId));
  }
  /* Copies pulled or put back while the count was on screen change what the shelf
     should hold, so a number typed before that can't be trusted. Stops, redraws
     those rows and says which; every other row keeps what was typed. */
  function totesMoved(rows, inputClass, shelfOf, redraw) {
    const totes = G.totesByStack();
    const held = t => (t ? t.qty : 0);
    const moved = rows.filter(r => held(totes.get(r.recordId)) !== held(r.tote));
    if (!moved.length) return false;
    for (const inp of document.querySelectorAll("." + inputClass)) rows[Number(inp.dataset.i)].typed = inp.value;
    for (const r of moved) { r.tote = totes.get(r.recordId) || null; r.bookQty = shelfOf(r, totes); delete r.typed; }
    redraw();
    sayMoved(moved.map(r => r.name));
    return true;
  }

  /* ============================== Floor -> Book ============================== */
  let fbEntries = [];

  function addFbEntry() {
    const c = fbPicker.current();
    if (!c) { UI.toast("Pick a card first.", "err"); return; }
    fbEntries.push(c);
    fbPicker.reset();
    renderFbEntries();
  }

  function renderFbEntries() {
    $("fbEntries").innerHTML = fbEntries.length ? fbEntries.map((e, i) =>
      '<tr class="click">' + UI.artThumbTd(e.imageUrl) +
      '<td class="card-name">' + UI.cardLink(e) + "</td><td>" + G.esc(G.printingLabel(e.set, e.collector, e.setName)) + "</td>" +
      "<td>" + finishText(e.finish) + "</td><td><button class=\"small\" data-rm=\"" + i + "\" title=\"Remove this line\" aria-label=\"Remove this line\">✕</button></td></tr>"
    ).join("") : UI.emptyRow(5, { icon: "cards", title: "Nothing added yet." });
    $("fbEntries").querySelectorAll("[data-rm]").forEach(b => {
      b.onclick = e => { e.stopPropagation(); fbEntries.splice(Number(b.dataset.rm), 1); renderFbEntries(); };
    });
    $("fbEntries").querySelectorAll("tr").forEach((tr, i) => {
      const e = fbEntries[i];
      if (!e) return;
      UI.wireArtHover(tr, e.imageUrl);
      tr.onclick = ev => { if (ev.target.closest("button")) return; G.cards.one(e.set, e.collector, e.lang || "en").then(c => { if (c) UI.reviewCard(c, e.finish); }); };
    });
    $("fbResultSection").hidden = true;
    renderFbProgress();
  }

  // The Sample size box sets how many cards this check is aiming for.
  function renderFbProgress() {
    $("fbProgress").textContent = G.cycleSampleProgress(fbEntries.length, $("fbSize").value).text;
  }

  function resultBadge(result) {
    if (result.status === "match") return '<span class="ok-tag">' + UI.icon("check") + " in this bin</span>";
    if (result.status === "elsewhere") return '<span class="short-tag">' + UI.icon("x") + " book says " + G.esc(G.locName(result.locationId)) + "</span>";
    if (result.status === "zero") return '<span class="short-tag">' + UI.icon("x") +
      (result.inTote ? " book says none on the shelf here: " + result.inTote + " in a tote" : " book says qty 0 here") + "</span>";
    return '<span class="short-tag">' + UI.icon("x") + " not in inventory at all</span>";
  }

  function offerFullCount(host, binId, pct) {
    host.innerHTML = '<div class="callout warn"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#triangle-alert></use></svg></span><div class="cbody">' +
      "<h3>" + pct + "% mismatch rate exceeds your " + threshold() + "% threshold</h3>" +
      "Consider a full cycle count of " + G.esc(G.locName(binId)) +
      '. <button class="small gold" id="goFullCount">Run full count</button></div></div>';
    $("goFullCount").onclick = () => { tabs.show("full"); $("fcBin").value = binId; openFull(); };
  }

  function checkFloorToBook() {
    const binId = $("fbBin").value;
    if (!binId) { UI.toast("Pick a bin first.", "err"); return; }
    if (!fbEntries.length) { UI.toast("Add at least one card first.", "err"); return; }
    const results = fbEntries.map(entry => ({ entry, result: G.matchStackInBin(binId, entry) }));
    const mismatches = results.filter(r => r.result.status !== "match").length;
    const errorRate = mismatches / results.length;
    const pct = Math.round(errorRate * 100);

    $("fbResultSection").hidden = false;
    const prog = G.cycleSampleProgress(results.length, $("fbSize").value);
    $("fbResultHdr").textContent = "— " + results.length + (prog.done ? "" : " of " + prog.target + " planned") +
      " sampled, " + mismatches + " mismatch" +
      (mismatches === 1 ? "" : "es") + " (" + pct + "%)";
    $("fbResultBody").innerHTML = results.map(({ entry, result }) =>
      '<tr class="click">' + UI.artThumbTd(entry.imageUrl) +
      '<td class="card-name">' + UI.cardLink(entry) + "</td><td>" + G.esc(G.printingLabel(entry.set, entry.collector, entry.setName)) + "</td>" +
      "<td>" + finishText(entry.finish) + "</td><td>" + resultBadge(result) + "</td></tr>"
    ).join("");
    $("fbResultBody").querySelectorAll("tr").forEach((tr, i) => {
      const entry = results[i] && results[i].entry;
      if (!entry) return;
      UI.wireArtHover(tr, entry.imageUrl);
      tr.onclick = () => G.cards.one(entry.set, entry.collector, entry.lang || "en").then(c => { if (c) UI.reviewCard(c, entry.finish); });
    });

    const banner = $("fbBanner");
    if (pct > threshold()) offerFullCount(banner, binId, pct);
    else banner.innerHTML = '<div class="callout ok"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#circle-check></use></svg></span><div class="cbody">Within threshold — no full count needed.</div></div>';

    G.addHistory({
      id: G.uid(), ts: new Date().toISOString(), type: "cycle-count", mode: "floor-to-book",
      binId, binName: G.locName(binId), sampleSize: results.length, mismatches, errorRate,
      entries: results.map(r => ({ name: r.entry.name, set: r.entry.set, collector: r.entry.collector,
        finish: r.entry.finish, status: r.result.status }))
    });
    G.persist("Cycle count (floor→book) on " + G.locName(binId));
  }

  /* ============================== Book -> Floor ============================== */
  let bfBin = null;
  let bfSample = [];

  function pickBinForMe() {
    const loc = G.pickCycleCountBin({ sampling: true });
    if (!loc) { UI.toast("No bin has any stock to sample.", "err"); return; }
    bfBin = loc;
    $("bfBinSelect").value = loc.id;
    renderBfBinInfo();
  }

  function renderBfBinInfo() {
    const host = $("bfBinInfo");
    $("bfResultSection").hidden = true;
    if (!bfBin) { host.innerHTML = ""; $("bfListSection").hidden = true; bfSample = []; return; }
    const last = bfBin.lastCycleCountAt ? new Date(bfBin.lastCycleCountAt).toLocaleDateString() : "never";
    host.innerHTML = '<div class="callout"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg></span><div class="cbody"><h3>' + G.esc(bfBin.name) +
      "</h3>Last fully counted: " + last + "</div></div>";
    const size = Math.max(1, parseInt(G.state.settings.cycleCountSampleSize, 10) || 10);
    bfSample = G.sampleBinStacks(bfBin.id, size);
    renderBfList();
  }

  function renderBfList() {
    $("bfListSection").hidden = !bfSample.length;
    if (!bfSample.length) return;
    $("bfHdr").textContent = "— " + bfSample.length + " to find";
    const totes = G.totesByStack();
    $("bfBody").innerHTML = bfSample.map((r, i) =>
      '<tr class="click">' + UI.artThumbTd(r.imageUrl) +
      '<td class="card-name">' + UI.cardLink(r) + toteLine(totes.get(r.id)) + "</td><td>" + G.esc(G.printingLabel(r.set, r.collector, r.setName)) + "</td>" +
      "<td>" + finishText(r.finish) + "</td><td class=\"num\">" + G.shelfQty(r, totes) + "</td>" +
      "<td><label class=\"row\"><input type=\"checkbox\" class=\"bfFound\" data-i=\"" + i + "\"> Found</label></td></tr>"
    ).join("");
    $("bfBody").querySelectorAll("tr").forEach((tr, i) => {
      const r = bfSample[i];
      if (!r) return;
      UI.wireArtHover(tr, r.imageUrl);
      tr.onclick = e => { if (e.target.closest("input,label")) return; UI.reviewRecord(r); };
    });
  }

  function submitBookToFloor() {
    if (!bfBin || !bfSample.length) return;
    const checks = [...document.querySelectorAll(".bfFound")];
    const found = checks.filter(c => c.checked).length;
    const notFound = bfSample.length - found;
    const errorRate = notFound / bfSample.length;
    const pct = Math.round(errorRate * 100);

    $("bfResultSection").hidden = false;
    $("bfResultHdr").textContent = "— " + bfSample.length + " checked, " + notFound + " not found (" + pct + "%)";
    const banner = $("bfBanner");
    if (pct > threshold()) offerFullCount(banner, bfBin.id, pct);
    else banner.innerHTML = '<div class="callout ok"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#circle-check></use></svg></span><div class="cbody">Within threshold — no full count needed.</div></div>';

    G.addHistory({
      id: G.uid(), ts: new Date().toISOString(), type: "cycle-count", mode: "book-to-floor",
      binId: bfBin.id, binName: bfBin.name, sampleSize: bfSample.length, mismatches: notFound, errorRate,
      entries: bfSample.map((r, i) => ({ name: r.name, set: r.set, collector: r.collector, finish: r.finish,
        status: checks[i] && checks[i].checked ? "match" : "missing" }))
    });
    G.persist("Cycle count (book→floor) on " + bfBin.name);
  }

  /* ============================== Full Count ============================== */
  let fcRows = [];
  let fcNewRows = [];

  function fullRows(binId) {
    const totes = G.totesByStack();
    return G.stacksInLocation(binId).map(r => ({
      recordId: r.id, name: r.name, set: r.set, collector: r.collector, setName: r.setName,
      lang: r.lang, finish: r.finish, condition: r.condition, tote: totes.get(r.id) || null,
      bookQty: G.shelfQty(r, totes)   // on the shelf: lent copies and copies in a tote aren't there to count
    }));
  }
  const showFcHdr = () => { $("fcHdr").textContent = "— " + fcRows.length + " stack" + (fcRows.length === 1 ? "" : "s"); };
  function renderFull() {
    const binId = $("fcBin").value;
    $("fcBookSection").hidden = !binId;
    if (!binId) return;
    fcRows = fullRows(binId);
    fcNewRows = [];
    showFcHdr();
    renderFcBody();
    renderFcNewBody();
  }

  function fcRowHtml(r, i) {
    const rec = G.state.cards.find(x => x.id === r.recordId);
    return '<tr data-rec="' + G.esc(r.recordId) + '" class="' + (rec ? "click" : "") + '">' + UI.artThumbTd(rec ? rec.imageUrl : "") +
      '<td class="card-name">' + UI.cardLink(r) + '<div class="toteSlot">' + toteLine(r.tote) + "</div></td><td>" + G.esc(G.printingLabel(r.set, r.collector, r.setName)) + "</td>" +
      "<td>" + finishText(r.finish) + "</td><td>" + G.esc(G.CONDITION_NAMES[r.condition] || r.condition) + "</td>" +
      '<td class="num">' + r.bookQty + '</td>' +
      '<td class="num"><input type="number" min="0" class="fcCounted" data-i="' + i + '" value="' + G.esc(r.typed != null ? r.typed : r.bookQty) + '" style="width:70px"></td></tr>';
  }
  // Looked up when clicked: a catch-up's load replaces the stacks without redrawing the row.
  function wireFcRow(tr, r) {
    const rec = r && G.state.cards.find(x => x.id === r.recordId);
    if (!rec) return;
    UI.wireArtHover(tr, rec.imageUrl);
    tr.onclick = e => {
      if (e.target.closest("input")) return;
      const now = G.state.cards.find(x => x.id === r.recordId);
      if (now) UI.reviewRecord(now);
    };
  }
  function renderFcBody() {
    renderToteCallout("fcTote", fcRows);
    $("fcBody").innerHTML = fcRows.length ? fcRows.map(fcRowHtml).join("") : UI.emptyRow(7, { icon: "locations", title: "Nothing in this bin." });
    $("fcBody").querySelectorAll("tr").forEach((tr, i) => wireFcRow(tr, fcRows[i]));
  }

  function renderFcNewBody() {
    $("fcNewBody").innerHTML = fcNewRows.length ? fcNewRows.map((r, i) =>
      '<tr class="click">' + UI.artThumbTd(r.imageUrl) +
      '<td class="card-name">' + UI.cardLink(r) + "</td><td>" + G.esc(G.printingLabel(r.set, r.collector, r.setName)) + "</td>" +
      "<td>" + finishText(r.finish) + "</td><td>" + G.esc(G.CONDITION_NAMES[r.condition] || r.condition) + "</td>" +
      '<td class="num">' + r.qty + '</td><td><button class="small" data-rm="' + i + '" title="Remove this line" aria-label="Remove this line">✕</button></td></tr>'
    ).join("") : UI.emptyRow(7, { icon: "cards", title: "None added." });
    $("fcNewBody").querySelectorAll("[data-rm]").forEach(b => {
      b.onclick = e => { e.stopPropagation(); fcNewRows.splice(Number(b.dataset.rm), 1); renderFcNewBody(); };
    });
    $("fcNewBody").querySelectorAll("tr").forEach((tr, i) => {
      const r = fcNewRows[i];
      if (!r) return;
      UI.wireArtHover(tr, r.imageUrl);
      tr.onclick = e => { if (e.target.closest("button")) return; G.cards.one(r.set, r.collector, r.lang || "en").then(c => { if (c) UI.reviewCard(c, r.finish); }); };
    });
  }

  function addFcNew() {
    const c = fcPicker.current();
    if (!c) { UI.toast("Pick a card first.", "err"); return; }
    const qty = Math.max(1, parseInt($("fcQty").value, 10) || 1);
    fcNewRows.push(Object.assign({}, c, { condition: $("fcCond").value || "NM", qty }));
    fcPicker.reset();
    $("fcQty").value = "1";
    renderFcNewBody();
  }

  /* The count list (#386): bins a short pick said are wrong, oldest first, cards
     and sealed apart. A full count of that kind takes it off, and opens on the
     matching tab. */
  function renderCountList() {
    const bins = G.binsToCount();
    const box = $("countList");
    box.hidden = !bins.length;
    box.innerHTML = !bins.length ? "" :
      '<div class="callout warn"><span class="cico">' + UI.icon("triangle-alert") + '</span><div class="cbody">' +
      "<h3>Bins to count (" + bins.length + ")</h3>" +
      '<div class="toolbar" style="margin-top:6px">' +
      bins.map(l => '<button class="small countBin" data-id="' + G.esc(l.id) + '" data-kind="' + G.esc(l.kind) + '" title="' +
        G.esc(l.reason + (l.at ? " on " + new Date(l.at).toLocaleDateString() : "")) + '">' +
        G.esc(l.name) + (l.kind === "sealed" ? " (sealed)" : "") + "</button>").join("") + "</div></div></div>";
    box.querySelectorAll(".countBin").forEach(b => {
      b.onclick = () => {
        if (b.dataset.kind === "sealed") { tabs.show("sealed"); $("scBin").value = b.dataset.id; openSealed(); }
        else { tabs.show("full"); $("fcBin").value = b.dataset.id; openFull(); }
      };
    });
  }

  /* Send a bin to the floor (#389): it joins the RF's Count list, behind any short-pick
     bin, and a full count of that kind (here or on the phone) takes it off. */
  function sendToFloor(binId, kind) {
    if (!binId) { UI.toast("Pick a bin first.", "err"); return; }
    const field = kind === "sealed" ? "countWantedSealed" : "countWanted";
    const had = !!(G.locById(binId) || {})[field];
    G.requestBinCount(binId, "Sent from the desk", kind, "desk");
    if (!had) G.persist("Sent " + G.locName(binId) + " to the floor to count");
    UI.toast(had ? G.locName(binId) + " is already on the count list." : G.locName(binId) + " sent to the floor.", "ok");
    renderCountList();
  }

  async function applyFullCount() {
    const binId = $("fcBin").value;
    if (!binId) return;
    $("fcApply").disabled = true;
    const moves = movedWhileOpen;
    const current = await caughtUp($("fcApply"));
    $("fcApply").disabled = false;
    if (!current || movedWhileOpen !== moves) return;
    const shelfOf = (r, totes) => { const rec = G.state.cards.find(x => x.id === r.recordId); return rec ? G.shelfQty(rec, totes) : 0; };
    if (totesMoved(fcRows, "fcCounted", shelfOf, renderFcBody)) return;
    const counted = [...document.querySelectorAll(".fcCounted")];
    const rows = counted.map(inp => ({ recordId: fcRows[Number(inp.dataset.i)].recordId, countedQty: inp.value }));
    const changed = rows.filter((row, i) => Number(row.countedQty) !== fcRows[i].bookQty).length;
    for (const n of fcNewRows) {
      rows.push({ recordId: null, set: n.set, collector: n.collector, lang: n.lang, finish: n.finish,
        condition: n.condition, countedQty: n.qty });
    }
    // A count that matches the book, or finds the bin empty, is still a count: it's recorded.
    const clean = !changed && !fcNewRows.length;
    const ok = await UI.confirmDialog(clean
      ? (fcRows.length ? "Everything in " + G.locName(binId) + " matches the book. Record this full count?"
        : "Nothing on the book for " + G.locName(binId) + ". Record it as counted and empty?")
      : "Apply full count of " + G.locName(binId) + "? " + changed + " stack(s) adjusted, " + fcNewRows.length + " new card(s) added.",
      { title: clean ? "Record this count?" : "Apply full count?" });
    if (!ok) return;

    $("fcApply").disabled = true;
    try {
      const out = await G.applyCycleCountAdjustments(binId, rows);
      G.addHistory({ id: G.uid(), ts: new Date().toISOString(), type: "cycle-count-full",
        binId, binName: G.locName(binId), adjusted: out.adjusted, added: out.added });
      G.persist("Full cycle count of " + G.locName(binId));
      UI.toast(clean ? "Count recorded. No differences." : "Full count applied: " + out.adjusted + " adjusted, " + out.added + " added.", "ok");
      renderFull();
      renderCountList();
    } catch (e) {
      UI.toast("Full count not applied: " + e.message, "err");
    } finally {
      $("fcApply").disabled = false;
    }
  }

  /* ============================== Sealed Full Count ============================== */
  let scRows = [];
  let scNewRows = [];

  function sealedRows(binId) {
    const totes = G.totesByStack();
    return G.sealedStacksInLocation(binId).map(r => ({
      recordId: r.id, name: r.name, setCode: r.setCode, tcgplayerProductId: r.tcgplayerProductId,
      manapoolProductId: r.manapoolProductId, price: r.price, tote: totes.get(r.id) || null,
      bookQty: G.shelfQty(r, totes)
    }));
  }
  const showScHdr = () => { $("scHdr").textContent = "— " + scRows.length + " SKU" + (scRows.length === 1 ? "" : "s"); };
  function renderSealed() {
    const binId = $("scBin").value;
    $("scBookSection").hidden = !binId;
    if (!binId) return;
    scRows = sealedRows(binId);
    scNewRows = [];
    showScHdr();
    renderScBody();
    renderScNewBody();
  }

  function scRowHtml(r, i) {
    return '<tr data-rec="' + G.esc(r.recordId) + '"><td class="card-name">' + G.esc(r.name) + '<div class="toteSlot">' + toteLine(r.tote) + "</div></td><td>" + G.esc(String(r.setCode || "").toUpperCase()) + "</td>" +
      '<td class="num">' + r.bookQty + '</td>' +
      '<td class="num"><input type="number" min="0" class="scCounted" data-i="' + i + '" value="' + G.esc(r.typed != null ? r.typed : r.bookQty) + '" style="width:70px"></td></tr>';
  }
  function renderScBody() {
    renderToteCallout("scTote", scRows);
    $("scBody").innerHTML = scRows.length ? scRows.map(scRowHtml).join("") : UI.emptyRow(4, { icon: "orders", title: "Nothing sealed in this bin." });
  }

  function renderScNewBody() {
    $("scNewBody").innerHTML = scNewRows.length ? scNewRows.map((r, i) =>
      '<tr><td class="card-name">' + G.esc(r.name) + "</td><td>" + G.esc(String(r.setCode || "").toUpperCase()) + "</td>" +
      '<td class="num">' + r.qty + '</td><td><button class="small" data-rm="' + i + '" title="Remove this line" aria-label="Remove this line">✕</button></td></tr>'
    ).join("") : UI.emptyRow(4, { icon: "orders", title: "Nothing added yet." });
    $("scNewBody").querySelectorAll("[data-rm]").forEach(b => {
      b.onclick = () => { scNewRows.splice(Number(b.dataset.rm), 1); renderScNewBody(); };
    });
  }

  function addScNew() {
    const p = scPicker.current();
    if (!p) { UI.toast("Pick a product first.", "err"); return; }
    const qty = Math.max(1, parseInt($("scQty").value, 10) || 1);
    scNewRows.push({ tcgplayerProductId: p.tcgplayerProductId, manapoolProductId: p.manapoolProductId,
      name: p.name, setCode: p.setCode, price: p.marketPrice, qty });
    scPicker.reset();
    $("scQty").value = "1";
    renderScNewBody();
  }

  async function applySealedFullCount() {
    const binId = $("scBin").value;
    if (!binId) return;
    $("scApply").disabled = true;
    const moves = movedWhileOpen;
    const current = await caughtUp($("scApply"));
    $("scApply").disabled = false;
    if (!current || movedWhileOpen !== moves) return;
    const shelfOf = (r, totes) => { const rec = G.state.sealed.find(x => x.id === r.recordId); return rec ? G.shelfQty(rec, totes) : 0; };
    if (totesMoved(scRows, "scCounted", shelfOf, renderScBody)) return;
    const counted = [...document.querySelectorAll(".scCounted")];
    const rows = counted.map(inp => ({ recordId: scRows[Number(inp.dataset.i)].recordId, countedQty: inp.value }));
    const changed = rows.filter((row, i) => Number(row.countedQty) !== scRows[i].bookQty).length;
    for (const n of scNewRows) {
      rows.push({ recordId: null, tcgplayerProductId: n.tcgplayerProductId, manapoolProductId: n.manapoolProductId,
        name: n.name, setCode: n.setCode, price: n.price, countedQty: n.qty });
    }
    const clean = !changed && !scNewRows.length;
    const ok = await UI.confirmDialog(clean
      ? (scRows.length ? "All sealed stock in " + G.locName(binId) + " matches the book. Record this full count?"
        : "No sealed stock on the book for " + G.locName(binId) + ". Record it as counted and empty?")
      : "Apply full count of " + G.locName(binId) + "? " + changed + " row(s) adjusted, " + scNewRows.length + " new product(s) added.",
      { title: clean ? "Record this count?" : "Apply full count?" });
    if (!ok) return;

    $("scApply").disabled = true;
    try {
      const out = G.applySealedCycleCountAdjustments(binId, rows);
      G.addHistory({ id: G.uid(), ts: new Date().toISOString(), type: "cycle-count-full-sealed",
        binId, binName: G.locName(binId), adjusted: out.adjusted, added: out.added });
      G.persist("Full sealed count of " + G.locName(binId));
      UI.toast(clean ? "Count recorded. No differences." : "Full count applied: " + out.adjusted + " adjusted, " + out.added + " added.", "ok");
      renderSealed();
      renderCountList();
    } finally {
      $("scApply").disabled = false;
    }
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    fbPicker = mountPicker("fbSearch", "fbAcList", "fbPrint", "fbFoil");
    fcPicker = mountPicker("fcSearch", "fcAcList", "fcPrint", "fcFoil");

    UI.fillLocationSelect($("fbBin"), null, {});
    UI.fillLocationSelect($("bfBinSelect"), null, { anyLabel: "— pick a bin —" });
    UI.fillLocationSelect($("fcBin"), null, { anyLabel: "— pick a bin —" });
    $("fcCond").innerHTML = G.CONDITIONS.map(c => '<option value="' + c + '">' + G.esc(G.CONDITION_NAMES[c]) + "</option>").join("");
    $("fcCond").value = G.defaultCondition();
    $("fbSize").value = G.state.settings.cycleCountSampleSize || 10;
    $("fbSize").addEventListener("input", renderFbProgress);
    renderFbProgress();

    scPicker = mountSealedPicker("scSearch", "scAcList");
    UI.fillLocationSelect($("scBin"), null, { anyLabel: "— pick a bin —" });

    $("fcSend").onclick = () => sendToFloor($("fcBin").value, "cards");
    $("scSend").onclick = () => sendToFloor($("scBin").value, "sealed");

    $("fbAdd").onclick = addFbEntry;
    $("fbCheck").onclick = checkFloorToBook;
    $("fbPick").onclick = () => {
      const loc = G.pickCycleCountBin({ sampling: true });
      if (!loc) { UI.toast("No bin has any stock to sample.", "err"); return; }
      $("fbBin").value = loc.id;
    };
    renderFbEntries();

    $("bfPick").onclick = pickBinForMe;
    $("bfBinSelect").onchange = () => { bfBin = G.locById($("bfBinSelect").value) || null; renderBfBinInfo(); };
    $("bfSubmit").onclick = submitBookToFloor;

    $("fcBin").onchange = openFull;
    renderCountList();
    $("fcPick").onclick = () => {
      const loc = G.pickCycleCountBin();
      if (!loc) { UI.toast("No bin has any stock to sample.", "err"); return; }
      $("fcBin").value = loc.id;
      openFull();
    };
    $("fcAddNew").onclick = addFcNew;
    $("fcApply").onclick = applyFullCount;

    $("scBin").onchange = openSealed;
    $("scPick").onclick = () => {
      const loc = G.pickSealedCycleCountBin();
      if (!loc) { UI.toast("No bin has any sealed stock to count.", "err"); return; }
      $("scBin").value = loc.id;
      openSealed();
    };
    $("scAddNew").onclick = addScNew;
    $("scApply").onclick = applySealedFullCount;

    // The tab is remembered (UI.pageTabs).
    tabs = UI.pageTabs({ tabs: [
      { id: "fb", button: "tabFB", panes: ["paneFB"] },
      { id: "bf", button: "tabBF", panes: ["paneBF"] },
      { id: "full", button: "tabFull", panes: ["paneFull"] },
      { id: "sealed", button: "tabSealed", panes: ["paneSealed"] }
    ] });
  });
})();
