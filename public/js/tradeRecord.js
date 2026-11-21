/* Grimoire v0.08 - "Record a trade" (#335).
   ==============================================================
   One screen for a trade made in person (FNM, across the table): the cards
   you gave, picked from your own inventory, and the cards you got, searched
   by name or Set + number. Save takes the given copies out, adds the
   received ones with the value given as their cost basis, and keeps a
   record on Trade Proposals' "Recorded trades" tab (core.js
   recordTrade). The header's Undo takes the whole trade back.
   Opened from Card Inventory and from Trade Proposals. */
"use strict";
window.TradeRecord = (function () {
  const $ = UI.$;
  const NEW_LOC = "__new";
  let built = false, ctx = null;

  function blankCtx(opts) {
    return {
      onSaved: (opts && opts.onSaved) || null,
      gave: [],              // { id (stack), qty }
      got: [],               // { set, num, lang, finish, condition, qty, info }
      groups: [],            // printings of the name being searched
      mode: "name",
      locTouched: false,
      busy: false
    };
  }

  function buildModal() {
    if (built) return;
    built = true;
    const finishOpts = G.FINISHES.map(f => '<option value="' + f + '">' + G.esc(G.FINISH_NAMES[f]) + "</option>").join("");
    UI.ensureModal("trModal", "wide",
      '<h3>Record a trade</h3>' +
      '<p class="muted" style="margin:-6px 0 12px">Saving takes what you gave out of your cards and adds what you got.</p>' +
      '<div class="fields n2">' +
        '<label>Traded with <input id="trWho" maxlength="80" placeholder="Optional, e.g. Sam at FNM" autocomplete="off"></label>' +
        '<label>Date <input id="trDate" type="date"></label>' +
      "</div>" +
      '<div class="grid2 tr-sides">' +
        "<div>" +
          '<div class="sec-head"><h2>You gave <span class="muted" id="trGaveTotal"></span></h2></div>' +
          '<label>Find a card you own <input id="trGaveSearch" placeholder="Name, set code or collector #" autocomplete="off"></label>' +
          '<div id="trGaveHits"></div>' +
          '<div class="list-wrap"><table class="list"><tbody id="trGaveBody"></tbody></table></div>' +
        "</div>" +
        "<div>" +
          '<div class="sec-head"><h2>You got <span class="muted" id="trGotTotal"></span></h2></div>' +
          '<div class="mode-toggle" style="margin-bottom:10px">' +
            '<button id="trModeName" class="seg active">Search by name</button>' +
            '<button id="trModeSet" class="seg">Set + number</button>' +
          "</div>" +
          '<div class="fields n2 tr-got">' +
            '<label id="trLblName" class="span-all" style="position:relative">Card name' +
              '<input id="trName" placeholder="Start typing a card name…" autocomplete="off">' +
              '<div id="trAc" class="ac-list" hidden></div></label>' +
            '<label id="trLblPrint" class="span-all">Printing <select id="trPrinting"><option value="">— pick a card first —</option></select></label>' +
            '<label id="trLblSet" hidden>Set code <input id="trSet" placeholder="e.g. neo" autocomplete="off"></label>' +
            '<label id="trLblNum" hidden>Collector # <input id="trNum" placeholder="e.g. 123" autocomplete="off"></label>' +
            '<label>Finish <select id="trFinish">' + finishOpts + "</select></label>" +
            '<label>Condition <select id="trCondition"></select></label>' +
            '<label>Quantity <input id="trQty" type="number" min="1" value="1"></label>' +
            '<button id="trAddGot">' + UI.icon("plus") + " Add</button>" +
          "</div>" +
          '<div class="status" id="trGotStatus"></div>' +
          '<div class="list-wrap"><table class="list"><tbody id="trGotBody"></tbody></table></div>' +
          '<label style="margin-top:10px">Put the cards you got in <select id="trLoc"></select></label>' +
        "</div>" +
      "</div>" +
      '<div class="callout" id="trSummary" style="margin-top:12px"><div class="cbody" id="trSummaryBody"></div></div>' +
      '<label style="margin-top:10px">Note <input id="trNote" maxlength="500" placeholder="Optional" autocomplete="off"></label>' +
      '<div class="modal-actions">' +
        '<span class="faint" style="font-size:11.5px" data-price-basis>Near Mint market price</span>' +
        '<span class="spacer"></span>' +
        '<button id="trCancel" class="ghost">Cancel</button>' +
        '<button id="trSave" class="primary">' + UI.icon("handshake") + " Save trade</button>" +
      "</div>");

    $("trCondition").innerHTML = G.CONDITIONS
      .map(c => '<option value="' + c + '">' + G.esc(G.CONDITION_NAMES[c]) + "</option>").join("");
    $("trCancel").onclick = () => UI.hideModal("trModal");
    $("trSave").onclick = save;
    $("trGaveSearch").addEventListener("input", G.debounce(renderGaveHits, 120));
    $("trModeName").onclick = () => setMode("name");
    $("trModeSet").onclick = () => setMode("set");
    UI.Autocomplete("trName", "trAc", loadPrintings);
    $("trPrinting").onchange = syncFinishChoices;
    $("trAddGot").onclick = addGot;
    [$("trSet"), $("trNum")].forEach(inp => inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addGot(); } }));
    $("trLoc").onchange = () => { if (ctx) ctx.locTouched = true; };
  }

  /* ---------- You gave: pick from your own cards ---------- */
  const stackById = id => G.state.cards.find(r => r.id === id) || null;
  const finishText = f => f && f !== "nonfoil" ? " · " + (G.FINISH_NAMES[f] || f) : "";
  const valueText = (price, qty) => price == null ? '<span class="muted">no price</span>' : G.money(price * qty);

  function renderGaveHits() {
    const box = $("trGaveHits");
    const words = $("trGaveSearch").value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) { box.innerHTML = ""; return; }
    const taken = new Map(ctx.gave.map(g => [g.id, g.qty]));
    const hits = G.state.cards.filter(r => {
      if ((taken.get(r.id) || 0) >= G.availableQty(r)) return false;
      const hay = [r.name, r.set, r.collector, r.setName].join(" ").toLowerCase();
      return words.every(w => hay.includes(w));
    }).sort((a, b) => a.name.localeCompare(b.name) || (Number(b.price) || 0) - (Number(a.price) || 0)).slice(0, 8);
    if (!hits.length) {
      box.innerHTML = UI.emptyBlock({ icon: "search", title: G.state.cards.length ? "None of your cards match that." : "You don't have any cards yet." });
      return;
    }
    box.innerHTML = '<div class="list-wrap" style="margin-bottom:10px"><table class="list"><tbody>' + hits.map(r =>
      '<tr data-id="' + G.esc(r.id) + '">' + UI.artThumbTd(r.imageUrl) +
      '<td class="card-name">' + UI.cardLink(r) +
        '<div class="muted" style="font-size:11.5px">' + G.esc(G.printingLabel(r.set, r.collector) + finishText(r.finish)) +
        " · " + G.esc(G.locName(r.locationId)) + " · have " + G.availableQty(r) + "</div></td>" +
      '<td class="num">' + valueText(r.price, 1) + "</td>" +
      '<td><button class="small" data-pick aria-label="Add ' + G.esc(r.name) + ' to You gave">Add</button></td></tr>'
    ).join("") + "</tbody></table></div>";
    box.querySelectorAll("tr[data-id]").forEach(tr => {
      const r = stackById(tr.dataset.id);
      if (r) UI.wireArtHover(tr, r.imageUrl);
      tr.querySelector("[data-pick]").onclick = () => addGave(tr.dataset.id);
    });
  }

  function addGave(id) {
    const r = stackById(id);
    if (!r) return;
    const line = ctx.gave.find(g => g.id === id);
    if (line) line.qty = Math.min(G.availableQty(r), line.qty + 1);
    else ctx.gave.push({ id, qty: 1 });
    // The cards you got usually go where the ones you gave came from.
    if (!ctx.locTouched && G.locById(r.locationId)) $("trLoc").value = r.locationId;
    renderGave();
    renderGaveHits();
    renderSummary();
  }

  function renderGave() {
    const body = $("trGaveBody");
    ctx.gave = ctx.gave.filter(g => stackById(g.id));
    if (!ctx.gave.length) { body.innerHTML = UI.emptyRow(5, { title: "Nothing added yet." }); return; }
    body.innerHTML = ctx.gave.map((g, i) => {
      const r = stackById(g.id);
      return "<tr>" + UI.artThumbTd(r.imageUrl) +
        '<td class="card-name">' + UI.cardLink(r) +
          '<div class="muted" style="font-size:11.5px">' + G.esc(G.printingLabel(r.set, r.collector) + finishText(r.finish)) + "</div></td>" +
        '<td class="num"><input type="number" class="tr-qty" min="1" max="' + G.availableQty(r) + '" value="' + g.qty + '" data-i="' + i +
          '" aria-label="How many ' + G.esc(r.name) + ' you gave"></td>' +
        '<td class="num">' + valueText(r.price, g.qty) + "</td>" +
        '<td><button class="small ghost" data-rm="' + i + '" title="Remove" aria-label="Remove">' + UI.icon("x") + "</button></td></tr>";
    }).join("");
    wireLines(body, ctx.gave, i => G.availableQty(stackById(ctx.gave[i].id)), renderGave);
    [...body.rows].forEach((tr, i) => { const r = stackById(ctx.gave[i].id); if (r) UI.wireArtHover(tr, r.imageUrl); });
  }

  function wireLines(body, list, maxOf, redraw) {
    body.querySelectorAll(".tr-qty").forEach(inp => {
      inp.onchange = () => {
        const i = Number(inp.dataset.i);
        list[i].qty = Math.max(1, Math.min(maxOf(i), parseInt(inp.value, 10) || 1));
        redraw();
        renderGaveHits();
        renderSummary();
      };
    });
    body.querySelectorAll("[data-rm]").forEach(b => {
      b.onclick = () => {
        list.splice(Number(b.dataset.rm), 1);
        redraw();
        renderGaveHits();
        renderSummary();
      };
    });
  }

  /* ---------- You got: search the card database ---------- */
  function setMode(m) {
    ctx.mode = m;
    const byName = m === "name";
    $("trModeName").classList.toggle("active", byName);
    $("trModeSet").classList.toggle("active", !byName);
    $("trLblName").hidden = $("trLblPrint").hidden = !byName;
    $("trLblSet").hidden = $("trLblNum").hidden = byName;
    UI.setStatus("trGotStatus", "", "");
    $(byName ? "trName" : "trSet").focus();
  }

  async function loadPrintings(name) {
    const sel = $("trPrinting");
    sel.innerHTML = '<option value="">Loading…</option>';
    ctx.groups = [];
    try {
      const list = await G.cards.printings(name);
      if (!list.length) throw new Error("No printings found for that name.");
      ctx.groups = G.sortPrintingsNewest(G.groupPrintings(list), G.englishOf);
      sel.innerHTML = '<option value="">Choose a printing…</option>' + ctx.groups.map((g, i) =>
        '<option value="' + i + '">' + G.esc(G.printingChoiceLabel(G.englishOf(g))) + "</option>").join("");
      // One printing: nothing to choose.
      if (ctx.groups.length === 1) sel.value = "0";
      syncFinishChoices();
      UI.setStatus("trGotStatus", "", "");
    } catch (e) {
      sel.innerHTML = '<option value="">— none found —</option>';
      UI.setStatus("trGotStatus", e.message, "err");
    }
  }

  const pickedGroup = () => ctx.groups[parseInt($("trPrinting").value, 10)];

  // A printing that comes in only one finish picks it (#326).
  function syncFinishChoices() {
    const g = pickedGroup();
    const c = g && G.englishOf(g);
    const f = ((c && c.finishes) || []).filter(x => G.FINISHES.includes(x));
    const sel = $("trFinish");
    for (const o of sel.options) o.disabled = f.length > 0 && !f.includes(o.value);
    if (f.length && !f.includes(sel.value)) sel.value = f[0];
  }

  async function addGot() {
    let set, num;
    if (ctx.mode === "name") {
      const g = pickedGroup();
      if (!g) { UI.setStatus("trGotStatus", ctx.groups.length ? "Choose a printing first." : "Search for a card first.", "err"); return; }
      const c = G.englishOf(g);
      set = c.set; num = c.collector;
    } else {
      set = $("trSet").value.trim().toLowerCase(); num = $("trNum").value.trim();
      if (!set || !num) { UI.setStatus("trGotStatus", "Enter a set code and collector number.", "err"); return; }
    }
    const lang = "en";
    const qty = Math.max(1, parseInt($("trQty").value, 10) || 1);
    const condition = $("trCondition").value;
    let finish = $("trFinish").value;
    $("trAddGot").disabled = true;
    UI.setStatus("trGotStatus", "Looking it up…", "work");
    try {
      let info = await G.lookupCard(set, num, lang, finish);
      const fit = G.fitFinish(info.card, finish);
      if (fit !== finish) { finish = fit; info = await G.lookupCard(set, num, lang, finish); }
      if (!ctx) return;
      const same = ctx.got.find(l => l.set === set && G.normNum(l.info.collector) === G.normNum(info.collector) &&
        l.finish === finish && l.condition === condition);
      if (same) same.qty += qty;
      else ctx.got.push({ set, num: info.collector, lang, finish, condition, qty, info });
      UI.setStatus("trGotStatus", "Added " + qty + "× " + info.name + ".", "ok");
      // Ready for the next card.
      $("trQty").value = "1";
      if (ctx.mode === "name") {
        $("trName").value = ""; ctx.groups = [];
        $("trPrinting").innerHTML = '<option value="">— pick a card first —</option>';
        $("trName").focus();
      } else { $("trNum").value = ""; $("trNum").focus(); }
      renderGot();
      renderSummary();
    } catch (e) {
      UI.setStatus("trGotStatus", e.message, "err");
    } finally { $("trAddGot").disabled = false; }
  }

  function renderGot() {
    const body = $("trGotBody");
    if (!ctx.got.length) { body.innerHTML = UI.emptyRow(5, { title: "Nothing added yet." }); return; }
    body.innerHTML = ctx.got.map((l, i) => {
      const img = l.info.meta && l.info.meta.imageUrl;
      return "<tr>" + UI.artThumbTd(img) +
        '<td class="card-name">' + UI.cardLink({ name: l.info.name, set: l.set, collector: l.num, finish: l.finish, imageUrl: img }) +
          '<div class="muted" style="font-size:11.5px">' + G.esc(G.printingLabel(l.set, l.num) + finishText(l.finish) +
          (l.condition !== "NM" ? " · " + l.condition : "")) + "</div></td>" +
        '<td class="num"><input type="number" class="tr-qty" min="1" value="' + l.qty + '" data-i="' + i +
          '" aria-label="How many ' + G.esc(l.info.name) + ' you got"></td>' +
        '<td class="num">' + valueText(l.info.price, l.qty) + "</td>" +
        '<td><button class="small ghost" data-rm="' + i + '" title="Remove" aria-label="Remove">' + UI.icon("x") + "</button></td></tr>";
    }).join("");
    wireLines(body, ctx.got, () => 9999, renderGot);
    [...body.rows].forEach((tr, i) => { const l = ctx.got[i]; if (l) UI.wireArtHover(tr, l.info.meta && l.info.meta.imageUrl); });
  }

  /* ---------- Totals ---------- */
  function sides() {
    const gave = G.tradeValue(ctx.gave.map(g => { const r = stackById(g.id); return { qty: g.qty, price: r ? r.price : null }; }));
    const got = G.tradeValue(ctx.got.map(l => ({ qty: l.qty, price: l.info.price })));
    return { gave, got };
  }
  // "+$1.50" style difference in words, so it never relies on colour.
  function balanceText(gaveV, gotV) {
    const d = Math.round((gotV - gaveV) * 100) / 100;
    if (!d) return "An even trade by value.";
    return "You came out " + G.money(Math.abs(d)) + (d > 0 ? " ahead" : " behind") + " by value.";
  }

  function renderSummary() {
    const s = sides();
    $("trGaveTotal").textContent = ctx.gave.length ? "— " + G.money(s.gave.value) : "";
    $("trGotTotal").textContent = ctx.got.length ? "— " + G.money(s.got.value) : "";
    const bits = [];
    if (!ctx.gave.length && !ctx.got.length) bits.push("Add the cards you gave and the cards you got.");
    else {
      bits.push("You gave " + G.money(s.gave.value) + ", you got " + G.money(s.got.value) + ". " + balanceText(s.gave.value, s.got.value));
      const un = s.gave.unpriced + s.got.unpriced;
      if (un) bits.push(G.unpricedNote(un, false) + ".");
      if (ctx.got.length) {
        bits.push(s.gave.value > 0
          ? "The cards you got take " + G.money(s.gave.value) + " (what you gave) as their cost, split by their value."
          : "Nothing you gave has a price, so the cards you got get no cost.");
      }
    }
    $("trSummaryBody").textContent = bits.join(" ");
    $("trSave").disabled = ctx.busy || (!ctx.gave.length && !ctx.got.length);
  }

  /* ---------- Save ---------- */
  function fillLocations() {
    const sel = $("trLoc");
    if (!G.state.locations.length && !(G.me && G.me.orgId)) {
      sel.innerHTML = '<option value="' + NEW_LOC + '">My Collection (new)</option>';
      return;
    }
    UI.fillLocationSelect(sel, null, {});
  }

  function ensureLocation() {
    const v = $("trLoc").value;
    if (v !== NEW_LOC) return v;
    // Same first location Receive makes for a brand-new account.
    const l = G.createLocation({ name: "My Collection", type: "Other" });
    G.state.locations.push(l);
    G.logAudit({ action: "location", to: l.name, note: 'Created location "' + l.name + '" (Other) automatically when recording a trade' });
    return l.id;
  }

  async function save() {
    if (!ctx || ctx.busy) return;
    const s = sides();
    const who = $("trWho").value.trim();
    const msg = "You gave " + ctx.gave.reduce((n, g) => n + g.qty, 0) + " card(s) worth " + G.money(s.gave.value) +
      " and got " + ctx.got.reduce((n, l) => n + l.qty, 0) + " card(s) worth " + G.money(s.got.value) + "." +
      "\n\nThe cards you gave come out of your inventory and the cards you got are added. Undo at the top takes it back.";
    const ok = await UI.confirmDialog(msg, { title: "Save this trade?", okLabel: "Save trade" });
    if (!ok || !ctx) return;
    ctx.busy = true;
    renderSummary();
    try {
      const rec = G.recordTrade({
        date: $("trDate").value, who, note: $("trNote").value,
        locationId: ctx.got.length ? ensureLocation() : null,
        gave: ctx.gave.map(g => ({ id: g.id, qty: g.qty })),
        got: ctx.got.map(l => ({ set: l.set, num: l.num, lang: l.lang, finish: l.finish, condition: l.condition, qty: l.qty, info: l.info }))
      });
      G.persist("trade" + (who ? " with " + who : ""));
      const done = ctx.onSaved;
      UI.hideModal("trModal");
      UI.toast("Trade saved" + (who ? " with " + who : "") + ". It's under Trade Proposals → Recorded trades; Undo at the top takes it back.", "ok");
      if (done) done(rec);
    } catch (e) {
      ctx.busy = false;
      renderSummary();
      UI.toast(e.message, "err");
    }
  }

  function open(opts) {
    buildModal();
    ctx = blankCtx(opts);
    $("trWho").value = ""; $("trNote").value = "";
    $("trDate").value = G.localDay(Date.now());
    $("trGaveSearch").value = ""; $("trGaveHits").innerHTML = "";
    $("trName").value = ""; $("trSet").value = ""; $("trNum").value = ""; $("trQty").value = "1";
    $("trPrinting").innerHTML = '<option value="">— pick a card first —</option>';
    $("trFinish").value = "nonfoil";
    $("trCondition").value = G.defaultCondition();
    fillLocations();
    setMode("name");
    renderGave();
    renderGot();
    renderSummary();
    G.paintPriceBasis($("trModal"));
    UI.showModal("trModal", "trWho");
  }

  return { open };
})();
