
"use strict";
(function () {
  const $ = UI.$;
  let printings = [];
  let preview = null;
  let plan = [];            // whole-collection plan rows
  let breakers = [];        // rule-breaker rows currently on screen
  let binResult = null;     // current bin plan
  let binId = "";

  /* ============================== Tabs ============================== */
  const PANES = { bin: "paneBin", to: "paneTo", consolidate: "paneConsolidate", one: "paneOne",
    plan: "panePlan", break: "paneBreak", cap: "paneCap" };
  let tabs;
  function onTab(t) {
    if (t === "bin") renderBin();
    if (t === "to") renderTo();
    if (t === "consolidate") renderConsolidate();
    if (t === "plan") renderPlan();
    if (t === "break") renderBreak();
    if (t === "cap") renderCapacity();
    if (t === "one") answer();
  }

  const tile = (big, lbl, cls, extra) =>
    '<div class="tile ' + (cls || "") + '"><span class="big">' + big + "</span>" +
    '<span class="lbl">' + lbl + "</span>" +
    (extra ? '<div class="faint" style="font-size:11.5px;margin-top:5px">' + extra + "</div>" : "") + "</div>";

  /* One destination, as a chip: where, how many, and why it stopped there. */
  function pickChip(p, qty) {
    const partial = p.take < qty;
    return '<span class="pull' + (p.overflow ? " overflow" : "") + '">' +
      (p.overflow ? "↳ " : "") + G.esc(p.name) +
      (partial || p.overflow ? " × " + p.take : "") + "</span>";
  }
  /* Where inside a sorted destination (#293): the "Show where it goes"
     button and the placement sentence under it. spot is a placement from
     G.locationLayouts(); key finds it again on click. */
  function spotHtml(spot, key) {
    return UI.placementButton('data-spot="' + key + '"') +
      '<div class="spot-text">' + G.esc(G.placementNeighbourText(spot)) + "<br>" +
      '<span class="sec">' + G.esc(G.placementSectionText(spot)) + "</span></div>";
  }
  const spotLine = spot => G.placementNeighbourText(spot) + " · " + G.placementSectionText(spot);
  /* Spots for the lines that will actually be filed: the ticked ones, in
     list order, each counting those before it, worked out again whenever a
     tick changes so "after X" never names a card that stays put. Stacks
     being moved aren't counted where they sit now. items: [{ key, record,
     locationId, qty }] -> Map key -> placement. */
  function placeAll(items) {
    const layouts = G.locationLayouts({ leaving: new Set(items.map(it => it.record.id)) });
    const out = new Map();
    for (const it of items) {
      if (it.locationId === it.record.locationId) continue;
      const lay = layouts.get(it.locationId);
      if (lay) out.set(String(it.key), lay.place(it.record, it.qty));
    }
    return out;
  }
  // Fill each .spot-slot under body from spots (empty when it has none).
  function fillSpots(body, spots) {
    body.querySelectorAll(".spot-slot").forEach(el => {
      const sp = spots.get(el.dataset.key);
      const html = sp ? spotHtml(sp, el.dataset.key) : "";
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
      if (el.tagName === "TD") el.dataset.v = sp ? sp.from : 1e9;
    });
  }
  const tickedIdx = cls => [...document.querySelectorAll("." + cls + ":checked")]
    .map(c => Number(c.dataset.i)).sort((a, b) => a - b);
  let binSpots = new Map(), toSpots = new Map(), planSpots = new Map(), breakSpots = new Map();
  function refreshBinSpots() {
    if (!binResult) return;
    const items = [];
    for (const i of tickedIdx("bpick")) {
      const l = binResult.lines[i];
      if (l) l.picks.forEach((p, k) => items.push({ key: i + ":" + k, record: l.record, locationId: p.locationId, qty: p.take }));
    }
    binSpots = placeAll(items);
    fillSpots($("binBody"), binSpots);
  }
  function refreshToSpots() {
    toSpots = placeAll(tickedIdx("topick").filter(i => toRows[i])
      .map(i => ({ key: i, record: toRows[i].record, locationId: toId, qty: toRows[i].record.quantity })));
    fillSpots($("toBody"), toSpots);
  }
  function refreshPlanSpots() {
    planSpots = placeAll(tickedIdx("ppick").filter(i => plan[i] && plan[i].suggestion)
      .map(i => ({ key: i, record: plan[i].record, locationId: plan[i].suggestion.locationId, qty: plan[i].record.quantity })));
    fillSpots($("planBody"), planSpots);
  }
  function refreshBreakSpots() {
    breakSpots = placeAll(tickedIdx("brpick").filter(i => breakers[i] && breakers[i].suggestion)
      .map(i => ({ key: i, record: breakers[i].record, locationId: breakers[i].suggestion.locationId, qty: breakers[i].record.quantity })));
    fillSpots($("breakBody"), breakSpots);
  }
  const spotSlot = (key, td) => td
    ? '<td class="spot-slot" data-key="' + key + '" data-v="1e9"></td>'
    : '<div class="spot-slot" data-key="' + key + '"></div>';
  function limitNote(p) {
    const bits = [];
    if (p.perName != null) bits.push("max " + p.perName + "/card, holds " + p.nameHeld);
    if (p.cap != null) bits.push("ceiling " + p.cap);
    return bits.join(" · ");
  }

  /* ============================== From a bin ============================== */
  function renderBinChoices() {
    const bins = G.putawaySources();
    const host = $("binChoices");
    // Any location can be emptied - every non-empty one is offered as a
    // quick-pick button below, sorting trays first since emptying one is the
    // everyday case, but the dropdown next to it always accepted anything.
    UI.fillLocationSelect($("binPick"), binId || null, { anyLabel: "— any location —" });
    if (!bins.length) {
      host.innerHTML = "";
      $("binEmpty").innerHTML =
        '<div class="callout warn"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#inbox></use></svg></span><div class="cbody">' +
        "<h3>Nothing to file anywhere</h3>" +
        "No location holds any cards yet. Receive some in, or mark one location as a sorting tray on the " +
        '<a href="/locations.html">Locations</a> page — a shoebox, a stack on the desk, whatever you actually ' +
        "drop cards into — so counting a whole box in and filing it later has a home to start from." +
        "</div></div>";
      return;
    }
    $("binEmpty").innerHTML = "";
    host.innerHTML = bins.map(b =>
      '<button class="kind' + (b.id === binId ? " active" : "") + '" data-bin="' + b.id + '">' +
      '<span class="num">' + (b.staging ? "Sorting tray" : G.esc(b.type)) + '</span><b>' + G.esc(b.name) + "</b>" +
      "<span>" + b.cards + " card" + (b.cards === 1 ? "" : "s") + " in " + b.stacks +
      " stack" + (b.stacks === 1 ? "" : "s") + " · " + G.money(b.value) + " — ready to file</span></button>").join("");
    host.querySelectorAll("[data-bin]").forEach(el => {
      el.onclick = () => { binId = el.dataset.bin; $("binPick").value = binId; renderBin(); };
    });
  }

  function renderBin() {
    renderBinChoices();
    if (!binId || !G.locById(binId)) {
      const bins = G.putawaySources();
      binId = bins.length ? bins[0].id : "";
      if (binId) { $("binPick").value = binId; renderBinChoices(); }
    }
    if (!binId) {
      $("binTiles").hidden = true;
      $("binPlanSection").hidden = true;
      return;
    }
    binResult = G.binPlan(binId, { allowSame: $("binAllowSame").checked });
    const r = binResult;
    const dests = new Set();
    let splits = 0, overflowed = 0;
    for (const l of r.lines) {
      if (l.split) splits++;
      for (const p of l.picks) { dests.add(p.locationId); if (p.overflow) overflowed += p.take; }
    }
    $("binTiles").hidden = false;
    $("binTiles").innerHTML =
      tile(r.cards.toLocaleString(), "Cards in the tray", "", r.stacks + " stack" + (r.stacks === 1 ? "" : "s")) +
      tile(r.moves.toLocaleString(), "Cards with a home", "pos", dests.size + " destination" + (dests.size === 1 ? "" : "s")) +
      tile(overflowed.toLocaleString(), "Overflowed", overflowed ? "gold" : "",
        "pushed past a full or one-of-each location") +
      tile(r.stranded.toLocaleString(), "Stranded", r.stranded ? "neg" : "",
        r.stranded ? "no location will take them" : "everything has somewhere to go");

    if (!r.cards) {
      $("binPlanSection").hidden = true;
      $("binEmpty").innerHTML = '<div class="callout ok"><span class="cico">' + UI.icon("circle-check") + '</span><div class="cbody">' +
        "<h3>" + G.esc(G.locName(binId)) + " is empty</h3>Nothing to file. Receive some cards into it first." +
        "</div></div>";
      return;
    }
    $("binPlanSection").hidden = false;
    renderBinRows();
  }

  function renderBinRows() {
    if (!binResult) return;
    const q = $("binSearch").value.trim().toLowerCase();
    const lines = binResult.lines.filter(l => {
      if (!q) return true;
      const r = l.record;
      return (r.name + " " + r.set + " " + r.setName + " " + r.collector).toLowerCase().includes(q);
    });
    $("binHdr").textContent = "— " + binResult.cards + " card" + (binResult.cards === 1 ? "" : "s") +
      " in " + G.locName(binId) +
      (binResult.stranded ? ", " + binResult.stranded + " with nowhere to go" : "");

    const body = $("binBody");
    if (!lines.length) {
      body.innerHTML = UI.emptyRow(8, { icon: "search", title: "Nothing matches that filter." });
      return;
    }
    body.innerHTML = "";
    lines.forEach(l => {
      const r = l.record;
      const idx = binResult.lines.indexOf(l);
      const movable = l.picks.length > 0;
      const tr = document.createElement("tr");
      tr.className = "click" + (movable ? "" : " short");
      const spotted = l.picks.some(p => p.spot);
      const where = movable
        ? (spotted
            ? l.picks.map((p, k) => '<div class="goes">' + pickChip(p, r.quantity) +
                (p.spot ? spotSlot(idx + ":" + k) : "") + "</div>").join("")
            : l.picks.map(p => pickChip(p, r.quantity)).join(" ")) +
          (l.shortfall ? ' <span class="short-tag">' + l.shortfall + " stranded</span>" : "")
        : '<span class="muted">— nowhere —</span>';
      const why = movable
        ? l.picks.map(p => {
            const reason = p.reason.join("; ") || "catch-all";
            const lim = limitNote(p);
            return reason + (lim ? " · " + lim : "");
          }).join("<br>")
        : explainStranded(l);
      tr.innerHTML =
        UI.artThumbTd(r.imageUrl) +
        "<td>" + (movable ? '<input type="checkbox" class="bpick" aria-label="' + G.esc("Select " + (r.name || "card")) + '" data-i="' + idx + '" checked>' : "") + "</td>" +
        "<td>" + UI.cardLink(r, r.name || "(unnamed)") + (r.finish === "etched" ? ' <span class="badge etched">E</span>' : r.finish === "foil" ? ' <span class="badge foil">F</span>' : "") + "</td>" +
        '<td class="muted hide-sm">' + G.esc(G.recPrinting(r)) + "</td>" +
        '<td class="num">' + r.quantity + "</td>" +
        "<td>" + where + "</td>" +
        '<td class="wrap muted hide-sm" style="font-size:11.5px">' + why + "</td>" +
        "<td>" + (!movable ? '<span class="short-tag">stranded</span>'
          : l.split ? '<span class="pill type">split</span>'
          : '<span class="ok-tag">OK</span>') + "</td>";
      // Row click reviews the card - the checkbox's own click (picking it for
      // filing) must not also pop that open.
      const cb = tr.querySelector(".bpick");
      if (cb) cb.onclick = e => e.stopPropagation();
      tr.onclick = e => {
        const b = e.target.closest(".spot-btn");
        if (b) { UI.showPlacement(binSpots.get(b.dataset.spot), r); return; }
        UI.reviewRecord(r);
      };
      UI.wireArtHover(tr, r.imageUrl);
      body.appendChild(tr);
    });
    $("binNote").innerHTML = binResult.stranded
      ? "<b>" + binResult.stranded + " card(s) have nowhere to go.</b> Either no location's rules claim them, or " +
        "every location that does is full. The usual fix is one <b>sell overflow</b> bin: putaway on, no rules, " +
        "priority below everything else — it catches whatever the good binders refuse."
      : "Every card in this tray has a home. Ticked lines move when you press the button; Undo reverses the lot.";
    refreshBinSpots();
    UI.reapplySorts();
  }

  function explainStranded(l) {
    const c = l.candidates || [];
    if (!c.length) return "No location's putaway rules match this card.";
    return c.slice(0, 3).map(x =>
      G.esc(x.name) + " matches but is full (" +
      (x.blockedBy === "per-name"
        ? "already holds " + x.nameHeld + " of " + x.perName + " allowed"
        : x.cards + " / " + x.cap) + ")").join("<br>");
  }

  async function applyBin() {
    if (!binResult) return;
    const picks = [...document.querySelectorAll(".bpick:checked")]
      .map(c => binResult.lines[Number(c.dataset.i)]).filter(Boolean);
    if (!picks.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const cards = picks.reduce((s, l) => s + l.picks.reduce((t, p) => t + p.take, 0), 0);
    const dests = new Set();
    picks.forEach(l => l.picks.forEach(p => dests.add(p.name)));
    const ok = await UI.confirmDialog("File " + cards + " card(s) out of " + G.locName(binId) + " into " +
      dests.size + " location(s)?\n\n" + [...dests].join(", "), { title: "File cards?" });
    if (!ok) return;

    const out = G.applyPutawayLines(picks, "Bin putaway from " + G.locName(binId));
    G.persist("Putaway from " + G.locName(binId));
    UI.toast("Filed " + out.moved + " card(s) out of " + G.locName(binId) +
      (out.split ? ", splitting " + out.split + " stack(s) across locations" : "") +
      ". Undo puts everything back in the tray.", "ok");
    renderBin();
  }

  function printBin() {
    if (!binResult || !binResult.lines.length) return;
    const rows = binResult.lines.map(l => [
      G.esc(l.record.name), G.esc(G.recPrinting(l.record)), l.record.quantity,
      l.picks.map(p => G.esc(p.name) + " × " + p.take +
        (p.spot ? '<br><small>' + G.esc(spotLine(p.spot)) + "</small>" : "")).join("<br>") || "—",
      l.picks.map(p => G.esc(p.reason.join("; ") || "catch-all")).join("<br>") || "—",
      l.shortfall ? "STRANDED " + l.shortfall : "OK"
    ]);
    G.printList("Putaway from " + G.locName(binId),
      ["Card", "Printing", "Qty", "Goes to", "Because", "Status"], rows,
      binResult.cards + " cards · " + binResult.moves + " with a home · " + binResult.stranded + " stranded");
  }

  /* ============================== To a bin ============================== */
  let toId = "";
  let toResult = null;      // { location, cap, free, rows } from G.whatBelongsHere
  let toRows = [];          // filtered subset currently on screen

  function renderTo() {
    UI.fillLocationSelect($("toPick"), toId || null, { anyLabel: "— pick a location —" });
    if (!toId || !G.locById(toId)) {
      const first = G.sortedLocations().find(l => !l.staging && l.putaway && l.putaway.enabled);
      toId = first ? first.id : "";
      if (toId) $("toPick").value = toId;
    }
    if (!toId) {
      $("toRules").textContent = "";
      $("toEmpty").innerHTML = '<div class="muted">No location has putaway switched on yet.</div>';
      $("toPlanSection").hidden = true;
      return;
    }
    const loc = G.locById(toId);
    const pa = loc.putaway || {};
    if (loc.staging) {
      $("toRules").textContent = "";
      $("toEmpty").innerHTML = '<div class="callout warn"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#inbox></use></svg></span><div class="cbody">' +
        "<h3>" + G.esc(loc.name) + " is a sorting tray</h3>Nothing is ever filed INTO a tray by the rules - it's " +
        "where cards wait before going somewhere else. Pick a shelf or binder instead.</div></div>";
      $("toPlanSection").hidden = true;
      return;
    }
    if (!pa.enabled) {
      $("toRules").textContent = "";
      $("toEmpty").innerHTML = '<div class="callout warn"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg></span><div class="cbody">' +
        "<h3>Putaway is off for " + G.esc(loc.name) + "</h3>Switch on “Use this location for putaway” on the " +
        '<a href="/locations.html">Locations</a> page before anything can be claimed for it here.</div></div>';
      $("toPlanSection").hidden = true;
      return;
    }
    $("toRules").innerHTML = "Matches: <b>" + G.esc(G.criteriaExpressionText(pa.rules)) + "</b>" +
      (loc.maxCards != null || loc.maxPerName != null
        ? " · " + [loc.maxCards != null ? "ceiling " + loc.maxCards : null,
            loc.maxPerName != null ? "max " + loc.maxPerName + "/card" : null].filter(Boolean).join(", ")
        : "");
    toResult = G.whatBelongsHere(toId);
    $("toEmpty").innerHTML = "";
    $("toPlanSection").hidden = false;
    renderToRows();
  }

  function renderToRows() {
    if (!toResult) return;
    const q = $("toSearch").value.trim().toLowerCase();
    const filtered = toResult.rows.filter(x => {
      if (!q) return true;
      const hay = (x.record.name + " " + x.record.set + " " + x.record.setName + " " +
        G.locName(x.from)).toLowerCase();
      return hay.includes(q);
    });
    $("toHdr").textContent = "— " + toResult.rows.length + " stack" + (toResult.rows.length === 1 ? "" : "s") +
      " match" + (toResult.rows.length === 1 ? "es" : "") + " these rules elsewhere in the collection";

    // Tally consumption as we walk the (filtered, displayed) list, the same
    // way the Whole-collection tab's "fits" column does for one shared
    // destination - a static per-row check against the location's current
    // free space would mark every row "fits" right up until the real total
    // ran out, not just as many as the ceiling actually allows.
    // G.fitPutawayMoves does that reservation, counting "the same card" the
    // way stock is counted (an oracle-id stack and an older same-name stack
    // without one share a per-card limit).
    const fitList = G.fitPutawayMoves(filtered.map(x => ({ record: x.record, locationId: toId })));
    // A sorted target (#293) gets a "Where in it" column (refreshToSpots).
    const sortedTarget = !!(G.locById(toId) || {}).sortMethod;
    $("toWhereTh").hidden = !sortedTarget;
    const cols = sortedTarget ? 8 : 7;
    toRows = filtered.map((x, k) =>
      Object.assign({}, x, { fits: fitList[k].fits, nameFree: fitList[k].nameFree, blockedBy: fitList[k].blockedBy }));
    const body = $("toBody");
    if (!toRows.length) {
      body.innerHTML = toResult.rows.length
        ? UI.emptyRow(cols, { icon: "search", title: "Nothing matches that filter." })
        : UI.emptyRow(cols, { icon: "locations", title: "Nothing elsewhere in the collection matches this location's rules." });
      return;
    }
    body.innerHTML = toRows.map((x, i) => {
      const r = x.record;
      return '<tr class="click' + (x.fits ? "" : " short") + '">' +
        UI.artThumbTd(r.imageUrl) +
        "<td>" + (x.fits ? '<input type="checkbox" class="topick" aria-label="' + G.esc("Select " + (r.name || "card")) + '" data-i="' + i + '" checked>' : "") + "</td>" +
        '<td class="card-name">' + UI.cardLink(r) + (r.finish === "etched" ? ' <span class="badge etched">E</span>' : r.finish === "foil" ? ' <span class="badge foil">F</span>' : "") + "</td>" +
        '<td class="muted hide-sm">' + G.esc(G.recPrinting(r)) + "</td>" +
        '<td class="num">' + r.quantity + "</td>" +
        "<td>" + G.esc(G.locName(x.from)) + "</td>" +
        "<td>" + (x.fits ? '<span class="ok-tag">yes</span>'
          : '<span class="short-tag">' + (x.blockedBy === "per-name" ? "per-card limit" : "no room") + "</span>") + "</td>" +
        (sortedTarget ? spotSlot(i, true) : "") + "</tr>";
    }).join("");
    // Row click reviews the card - the checkbox's own click must not also pop
    // that open, so it's excluded via closest() rather than a per-row handler.
    body.querySelectorAll("tr").forEach((tr, i) => {
      const x = toRows[i];
      if (!x) return;
      UI.wireArtHover(tr, x.record.imageUrl);
      tr.onclick = e => {
        if (e.target.closest(".topick")) return;
        if (e.target.closest(".spot-btn")) { UI.showPlacement(toSpots.get(String(i)), x.record); return; }
        UI.reviewRecord(x.record);
      };
    });
    refreshToSpots();
    UI.reapplySorts();
  }

  async function applyTo() {
    const picks = [...document.querySelectorAll(".topick:checked")]
      .map(c => toRows[Number(c.dataset.i)]).filter(Boolean);
    if (!picks.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const ok = await UI.confirmDialog("Move " + picks.length + " stack(s) into " + G.locName(toId) + "?", { title: "Move cards?" });
    if (!ok) return;
    const loc = G.locById(toId);
    const lines = picks.map(x => ({
      record: x.record,
      picks: [{ locationId: toId, name: loc.name, take: x.record.quantity,
        reason: [], cap: loc.maxCards, perName: loc.maxPerName, nameHeld: x.nameHeld, rules: [], overflow: false }],
      shortfall: 0
    }));
    const out = G.applyPutawayLines(lines, "Filed into " + loc.name);
    G.persist("Filed into " + loc.name);
    UI.toast("Moved " + out.moved + " card(s) into " + loc.name + ". Undo puts everything back.", "ok");
    renderTo();
  }

  /* ============================== Consolidate ============================== */
  let conFull = [];             // every fragmented card name at the current min-locations threshold
  let conRows = [];             // filtered + target/fits computed, in render order
  const conTargetOverride = new Map();   // group.key -> locationId, survives re-renders until changed

  function renderConsolidate() {
    const minLocs = parseInt($("conMinLocs").value, 10) || 2;
    const q = $("conSearch").value.trim().toLowerCase();
    conFull = G.consolidatePlan().filter(g => g.locations >= minLocs);
    const filtered = conFull.filter(g => !q || g.name.toLowerCase().includes(q));
    $("conHdr").textContent = "— " + conFull.length + " card name" + (conFull.length === 1 ? "" : "s") +
      " split across " + minLocs + "+ locations";

    // Several groups can share the same suggested target in one run, so
    // capacity there is tallied cumulatively across them - same reasoning as
    // "To a bin"'s fits column.
    const usedByLoc = new Map();
    const statsCache = new Map();   // one locStats() scan per target, not per row
    conRows = filtered.map(g => {
      // A stale override (location deleted or turned into a tray) falls back
      // to the default; the default is never a tray and may be null when
      // every copy sits in trays - then the row asks for a target.
      const override = conTargetOverride.get(g.key);
      const targetId = G.consolidateTarget(g, override);
      if (override && override !== targetId) conTargetOverride.delete(g.key);
      if (!targetId) {
        return Object.assign({}, g, { targetId: null, incoming: g.totalQty, fits: false, imageUrl: UI.artForGroup(g.stacks) });
      }
      const loc = G.locById(targetId);
      if (!statsCache.has(targetId)) statsCache.set(targetId, G.locStats(targetId));
      const st = statsCache.get(targetId);
      const heldAtTarget = g.stacks.filter(s => s.locationId === targetId).reduce((s, r) => s + r.quantity, 0);
      const incoming = g.totalQty - heldAtTarget;
      const already = usedByLoc.get(targetId) || 0;
      const totalFree = st.cap == null ? Infinity : Math.max(0, st.cap - st.cards - already);
      const perName = loc.maxPerName == null ? null : Number(loc.maxPerName);
      const nameFree = perName == null ? Infinity : Math.max(0, perName - heldAtTarget);
      const fits = incoming <= 0 || (totalFree >= incoming && nameFree >= incoming);
      if (fits && incoming > 0) usedByLoc.set(targetId, already + incoming);
      // Every stack in the group is already owned - pick any member's art,
      // same "summarized row" convention used elsewhere (2026-09-05 pass).
      return Object.assign({}, g, { targetId, incoming, fits, imageUrl: UI.artForGroup(g.stacks) });
    });

    const body = $("conBody");
    if (!conRows.length) {
      body.innerHTML = conFull.length
        ? UI.emptyRow(8, { icon: "search", title: "Nothing matches that filter." })
        : UI.emptyRow(8, { icon: "locations", title: "Nothing is fragmented across that many locations." });
      return;
    }
    const locOpts = G.sortedLocations().filter(l => !l.staging);
    body.innerHTML = conRows.map((g, i) => {
      // The selected option is always the location Gather will use: trays
      // are never a target, so with no target the placeholder is selected
      // rather than the browser silently showing the first location.
      const options = (g.targetId ? "" : '<option value="" selected>— pick a target —</option>') +
        locOpts.map(l =>
        "<option value=\"" + G.esc(l.id) + "\"" + (l.id === g.targetId ? " selected" : "") + ">" +
        G.esc(l.name) + "</option>").join("");
      return '<tr class="click">' +
        UI.artThumbTd(g.imageUrl) +
        "<td>" + (g.fits ? '<input type="checkbox" class="conpick" aria-label="' + G.esc("Select " + (g.name || "card")) + '" data-i="' + i + '" checked>' : "") + "</td>" +
        '<td class="card-name">' + UI.cardNameLink(g.name) + "</td>" +
        '<td class="num">' + g.locations + "</td>" +
        '<td class="num hide-sm">' + g.stacks.length + "</td>" +
        '<td class="num">' + g.totalQty + "</td>" +
        // data-vs: the chosen target's name, so the Target column sorts (#79) -
        // a <select>'s own text is every option at once, same on every row.
        '<td data-vs="' + (g.targetId ? G.esc(G.locName(g.targetId)) : "") + '"><select class="contarget" aria-label="' + G.esc("Target location for " + (g.name || "card")) + '" data-key="' + G.esc(g.key) + '">' + options + "</select></td>" +
        "<td>" + (g.fits ? '<span class="ok-tag">yes</span>'
          : !g.targetId ? '<span class="short-tag">pick a target</span>'
          : '<span class="short-tag">no room</span>') + "</td></tr>";
    }).join("");
    body.querySelectorAll(".contarget").forEach(sel => {
      sel.onchange = () => {
        sel.closest("td").dataset.vs = sel.value ? sel.options[sel.selectedIndex].text : "";
        if (sel.value) conTargetOverride.set(sel.dataset.key, sel.value);
        else conTargetOverride.delete(sel.dataset.key);
        renderConsolidate();
      };
    });
    body.querySelectorAll("tr").forEach((tr, i) => {
      const g = conRows[i];
      if (!g) return;
      UI.wireArtHover(tr, g.imageUrl);
      tr.onclick = e => {
        if (e.target.closest(".conpick") || e.target.closest("select")) return;
        UI.reviewRecord(g.stacks[0]);
      };
    });
    UI.reapplySorts();
  }

  async function applyConsolidate() {
    const picks = [...document.querySelectorAll(".conpick:checked")]
      .map(c => conRows[Number(c.dataset.i)]).filter(Boolean);
    if (!picks.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const ok = await UI.confirmDialog("Gather " + picks.length + " card name(s) into their target location?", { title: "Consolidate cards?" });
    if (!ok) return;
    const lines = [];
    for (const g of picks) {
      const loc = g.targetId && G.locById(g.targetId);
      if (!loc || loc.staging) continue;      // no target picked, or it went away since render
      for (const r of g.stacks) {
        if (r.locationId === g.targetId) continue;
        lines.push({
          record: r,
          picks: [{ locationId: g.targetId, name: loc.name, take: r.quantity, reason: [],
            cap: loc.maxCards, perName: loc.maxPerName, nameHeld: 0, rules: [], overflow: false }],
          shortfall: 0
        });
      }
    }
    const out = G.applyPutawayLines(lines, "Consolidated");
    G.persist("Consolidated");
    UI.toast("Moved " + out.moved + " card(s) into place across " + picks.length +
      " card name(s). Undo puts everything back.", "ok");
    renderConsolidate();
  }

  /* ============================== One card ============================== */
  async function loadPrintings(name) {
    preview.message("Loading…");
    printings = await UI.loadPrintingSelect("inPrint", name);
    answer();
  }

  const currentCard = () => printings[parseInt($("inPrint").value, 10)] || null;

  function inventoryRow(card, finish) {
    if (!card) return null;
    return G.state.cards.find(r => r.set === card.set &&
      G.normNum(r.collector) === G.normNum(card.collector) && r.finish === finish) || null;
  }

  function answer() {
    const card = currentCard();
    const host = $("answer");
    if (!card) {
      host.innerHTML = '<div class="callout"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#scan-search></use></svg></span><div class="cbody">' +
        "<h3>Pick a card</h3>Type a name above and this shows where it goes, which rule decided that, and " +
        "every other location that would have taken it.</div></div>";
      $("rankSection").hidden = true;
      preview.clear();
      return;
    }
    const finish = $("inFoil").value;
    const qty = Math.max(1, parseInt($("inQty").value, 10) || 1);
    const row = inventoryRow(card, finish);
    const shaped = Object.assign({}, card, {
      finish, price: G.priceOf(card, finish), quantity: qty,
      costQty: row ? row.costQty : 0, costTotal: row ? row.costTotal : 0, avgCost: row ? row.avgCost : null
    });
    preview.showCard(card, finish, "", { putaway: false });

    if (row && !$("inFrom").value) $("inFrom").value = row.locationId;
    const from = $("inFrom").value || (row ? row.locationId : "");
    const exclude = $("allowSame").checked ? null : (from || null);
    const alloc = G.allocatePutaway(shaped, qty, { excludeLocationId: exclude });
    // Where inside each sorted destination (#293); where it already sits
    // when the copies held are in that very location.
    const layouts = G.locationLayouts();
    const oneSpots = alloc.picks.map(p => {
      const lay = layouts.get(p.locationId);
      if (!lay) return null;
      return row && row.locationId === p.locationId ? lay.locate(row) : lay.place(shaped, p.take);
    });

    let html = "";
    if (!alloc.considered) {
      html = '<div class="callout warn"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg></span><div class="cbody"><h3>No putaway locations</h3>' +
        'Nothing has putaway switched on yet. Open <a href="/locations.html">Locations</a>, tick ' +
        "“Use this location for putaway” on a few, and give them rules.</div></div>";
    } else if (alloc.picks.length) {
      const first = alloc.picks[0];
      html = '<div class="callout ok"><span class="cico"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg></span><div class="cbody">' +
        '<div style="font-size:21px;font-weight:650;color:var(--text);letter-spacing:-.02em">' +
        alloc.picks.map(p => G.esc(p.name) + (alloc.split ? " × " + p.take : "")).join("  →  ") + "</div>" +
        '<div style="margin-top:6px">' + alloc.picks.map((p, k) =>
          "<b>" + G.esc(p.name) + "</b> takes " + p.take + " — " +
          (p.reason.join("; ") || "catch-all, no rules") +
          (limitNote(p) ? " · " + limitNote(p) : "") +
          (oneSpots[k] ? '<div class="one-spot">' + spotHtml(oneSpots[k], k) + "</div>" : "")).join("<br>") + "</div>" +
        (alloc.shortfall ? '<div class="warn" style="margin-top:6px">' + alloc.shortfall +
          " cop" + (alloc.shortfall === 1 ? "y" : "ies") + " have nowhere to go.</div>" : "") +
        "</div></div>";
      if (row) {
        html += '<div class="toolbar" style="margin-top:4px">' +
          '<span class="muted">You hold ' + row.quantity + " cop" + (row.quantity === 1 ? "y" : "ies") +
          " in " + G.esc(G.locName(row.locationId)) + ".</span>" +
          (row.locationId === first.locationId && !alloc.split
            ? '<span class="good">Already in the right place.</span>'
            : '<button id="doMove" class="gold">File ' + Math.min(qty, row.quantity) + " cop" +
              (Math.min(qty, row.quantity) === 1 ? "y" : "ies") + " now</button>") +
          "</div>";
      } else {
        html += '<div class="hint">This printing is not in your inventory yet — ' +
          '<a href="/receive.html">receive it</a> and the location gets picked for you.</div>';
      }
    } else {
      const blocked = alloc.candidates.filter(c => c.free <= 0);
      html = '<div class="callout bad"><span class="cico">' + UI.icon("triangle-alert") + '</span><div class="cbody"><h3>Nowhere to put it</h3>' +
        (blocked.length
          ? "Every location whose rules match is full:<br>" + blocked.map(b =>
              "<b>" + G.esc(b.name) + "</b> — " + (b.blockedBy === "per-name"
                ? "already holds " + b.nameHeld + " of " + b.perName + " allowed copies"
                : b.cards + " / " + b.cap + " cards")).join("<br>") +
            "<br><br>Add a <b>sell overflow</b> bin — putaway on, no rules, lowest priority — and cards like this " +
            "land there instead of nowhere."
          : "No location's rules claim this card. Either add a rule that covers it, or give one location putaway " +
            "with <b>no</b> rules so it acts as the catch-all.") + "</div></div>";
    }
    host.innerHTML = html;
    host.querySelectorAll(".spot-btn").forEach(b => {
      const sp = oneSpots[Number(b.dataset.spot)];
      if (sp && sp.mode === "here") { b.title = "Show where it is"; b.setAttribute("aria-label", "Show where it is"); }
      b.onclick = () => UI.showPlacement(sp, row || shaped);
    });

    if ($("doMove")) {
      $("doMove").onclick = () => {
        const line = { record: row, picks: alloc.picks.map(p => Object.assign({}, p)), shortfall: alloc.shortfall };
        const out = G.applyPutawayLines([line], "Putaway");
        G.persist("Putaway " + row.name);
        UI.toast("Filed " + out.moved + " cop" + (out.moved === 1 ? "y" : "ies") + " of " + row.name +
          (out.split ? " across " + alloc.picks.length + " locations" : " into " + alloc.picks[0].name) +
          ". Undo puts them back.", "ok");
        answer();
      };
    }

    // Ranked list of every candidate, so the decision is inspectable.
    const all = alloc.candidates;
    $("rankSection").hidden = !all.length;
    $("rankHdr").textContent = all.length
      ? all.length + " of " + alloc.considered + " putaway location" + (alloc.considered === 1 ? "" : "s") + " match"
      : "";
    const bestId = alloc.picks.length ? alloc.picks[0].locationId : null;
    $("rankBody").innerHTML = all.map(c =>
      "<tr" + (c.locationId === bestId ? ' class="qrow"' : "") + ">" +
      "<td><b>" + G.esc(c.name) + "</b>" +
        (c.locationId === bestId ? ' <span class="badge sale">PICK</span>' : "") + "</td>" +
      '<td class="hide-sm"><span class="pill type">' + G.esc(c.type) + "</span></td>" +
      '<td class="num hide-sm">' + c.matched + "</td>" +
      '<td class="num hide-sm">' + c.priority + "</td>" +
      '<td class="num">' + c.cards + "</td>" +
      '<td class="num">' + (c.free === Infinity ? "∞" : c.free) + "</td>" +
      "<td>" + (c.perName != null
        ? (c.nameFree <= 0
            ? '<span class="short-tag">' + c.nameHeld + "/" + c.perName + " of this card</span>"
            : '<span class="muted">' + c.nameHeld + "/" + c.perName + " of this card</span>")
        : c.cap != null
          ? '<span class="muted">' + c.cards + "/" + c.cap + " cards</span>"
          : '<span class="faint">none</span>') + "</td>" +
      '<td class="wrap muted hide-sm" style="font-size:11.5px">' +
        G.esc(c.rules.map(G.ruleText).join("; ") || "catch-all") + "</td></tr>").join("");
    UI.reapplySorts();
  }

  /* ============================== Whole collection ============================== */
  // The last computed plan. Building one walks every stack against every
  // location, so it is rebuilt only on tab open and on a real change; the
  // search box and the show-filter just re-filter this.
  let planFull = [];
  let planIdx = null;       // location totals as of planFull, for the Fits? column
  function renderPlan() {
    planFull = G.putawayPlan({});
    planIdx = G.putawayIndex();
    renderPlanRows();
  }

  function renderPlanRows() {
    const mode = $("planFilter").value;
    const q = $("planSearch").value.trim().toLowerCase();
    const full = planFull;
    plan = full.filter(p => {
      if (mode === "move" && !p.move) return false;
      if (mode === "nohome" && p.suggestion) return false;
      if (q) {
        const hay = (p.record.name + " " + p.record.set + " " + p.record.setName + " " +
          G.locName(p.current)).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const movers = full.filter(p => p.move).length;
    const homeless = full.filter(p => !p.suggestion).length;
    $("planHdr").textContent = "— " + movers + " should move, " + homeless +
      " have no rule that claims them, " + full.length + " stacks in total";

    const body = $("planBody");
    if (!plan.length) {
      body.innerHTML = mode === "move" ? UI.emptyRow(9, { icon: "generic", title: "Everything is already where the rules put it." })
        : mode === "nohome" ? UI.emptyRow(9, { icon: "generic", title: "Every stack is claimed by some location's rules." })
        : UI.emptyRow(9, { icon: "search", title: "No stacks match that filter." });
      return;
    }
    // Several stacks can share one destination, so room there is reserved
    // down the list (ceiling and per-card limit both) - the same check Apply
    // runs, so a row shown "no room" is one Apply would skip. Those rows
    // start unticked.
    const moving = plan.filter(p => p.move && p.suggestion);
    const fitList = G.fitPutawayMoves(moving.map(p => ({ record: p.record, locationId: p.suggestion.locationId })),
      { index: planIdx });
    const fitOf = new Map(moving.map((p, k) => [p, fitList[k]]));
    body.innerHTML = plan.map((p, i) => {
      let fits = "—", cls = "", tick = true;
      if (p.suggestion) {
        const f = fitOf.get(p);
        if (!p.move) fits = '<span class="muted">stays</span>';
        else if (f.fits) fits = '<span class="ok-tag">yes</span>';
        else {
          fits = f.blockedBy === "per-name"
            ? '<span class="short-tag">per-card limit</span>'
            : '<span class="short-tag">no room (' + (f.capFree === Infinity ? "∞" : f.capFree) + ")</span>";
          cls = "short";
          tick = false;
        }
      }
      return '<tr class="click ' + cls + '">' +
        UI.artThumbTd(p.record.imageUrl) +
        "<td>" + (p.move ? '<input type="checkbox" class="ppick" aria-label="' + G.esc("Select " + (p.record.name || "card")) + '" data-i="' + i + '"' + (tick ? " checked" : "") + ">" : "") + "</td>" +
        '<td class="card-name">' + UI.cardLink(p.record) + "</td>" +
        '<td class="muted hide-sm">' + G.esc(G.recPrinting(p.record)) + (p.record.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[p.record.finish].toLowerCase() : "") + "</td>" +
        '<td class="num">' + p.record.quantity + "</td>" +
        "<td>" + G.esc(G.locName(p.current)) + "</td>" +
        "<td>" + (p.suggestion ? G.esc(p.suggestion.name) + (p.move ? spotSlot(i) : "") : '<span class="muted">— no rule claims it —</span>') + "</td>" +
        '<td class="wrap muted hide-sm" style="font-size:11.5px">' +
          G.esc(p.reason.join("; ") || (p.suggestion ? "catch-all" : "")) + "</td>" +
        "<td>" + fits + "</td></tr>";
    }).join("");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const p = plan[i];
      if (!p) return;
      UI.wireArtHover(tr, p.record.imageUrl);
      tr.onclick = e => {
        if (e.target.closest(".ppick")) return;
        if (e.target.closest(".spot-btn")) { UI.showPlacement(planSpots.get(String(i)), p.record); return; }
        UI.reviewRecord(p.record);
      };
    });
    refreshPlanSpots();
    UI.reapplySorts();
  }

  // Ticked rows in list order (not the DOM's, which a column sort can
  // reorder), so Apply reserves room in the same order the Fits? column did.
  const tickedRows = (cls, rows) => [...document.querySelectorAll("." + cls + ":checked")]
    .map(c => Number(c.dataset.i)).sort((a, b) => a - b).map(i => rows[i]).filter(Boolean);

  async function applyPlan() {
    const picks = tickedRows("ppick", plan);
    if (!picks.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const ok = await UI.confirmDialog("Move " + picks.length + " stack(s) to where the putaway rules say they belong?", { title: "Move cards?" });
    if (!ok) return;
    // Re-checked against current stock, reserving as it goes: a stack that
    // no longer fits once the earlier ones are in is skipped, not forced in.
    const out = G.applySuggestedMoves(picks, "Whole-collection putaway");
    G.persist("Putaway plan");     // fires "change", which rebuilds the plan
    UI.toast("Moved " + out.moved + " card(s)" +
      (out.skipped ? ", skipped " + out.skipped + " that would not fit" : "") +
      ". Undo puts everything back.", "ok");
  }

  /* ============================== Rule breakers ============================== */
  let breakFull = [];       // last computed rule-breaker list; search re-filters it
  let breakIdx = null;      // location totals as of breakFull
  function renderBreak() {
    breakFull = G.ruleBreakers({});
    breakIdx = G.putawayIndex();
    renderBreakRows();
  }

  function renderBreakRows() {
    const q = $("breakSearch").value.trim().toLowerCase();
    const full = breakFull;
    breakers = full.filter(b => {
      if (!q) return true;
      const hay = (b.record.name + " " + b.record.set + " " + b.record.setName + " " +
        G.locName(b.locationId)).toLowerCase();
      return hay.includes(q);
    });
    $("breakHdr").textContent = "— " + full.length + " stack" + (full.length === 1 ? "" : "s") +
      " breaking the rules of the bin " + (full.length === 1 ? "it's" : "they're") + " in";

    const body = $("breakBody");
    if (!breakers.length) {
      body.innerHTML = full.length
        ? UI.emptyRow(8, { icon: "search", title: "Nothing matches that filter." })
        : UI.emptyRow(8, { icon: "generic", title: "Nothing breaks its own location's rules right now." });
      return;
    }
    // Same reserving check as the Whole-collection tab: once earlier rows
    // have filled a destination, later ones say so and start unticked.
    const moving = breakers.filter(b => b.suggestion);
    const fitList = G.fitPutawayMoves(moving.map(b => ({ record: b.record, locationId: b.suggestion.locationId })),
      { index: breakIdx });
    const fitOf = new Map(moving.map((b, k) => [b, fitList[k]]));
    body.innerHTML = breakers.map((b, i) => {
      const breaks = '<div>' + G.esc(b.expression) + '</div>' +
        (b.failed.length ? '<div class="muted" style="font-size:11.5px">fails: ' +
          G.esc(b.failed.join("; ")) + "</div>" : "");
      const f = b.suggestion ? fitOf.get(b) : null;
      const to = b.suggestion
        ? "<b>" + G.esc(b.suggestion.name) + "</b>" +
          (f.fits ? "" : ' <span class="short-tag">' + (f.blockedBy === "per-name" ? "per-card limit" : "no room") + "</span>") +
          "<br>" +
          '<span class="muted" style="font-size:11.5px">' + G.esc(b.reason.join("; ") || "catch-all") + "</span>" + spotSlot(i)
        : '<span class="muted">— nowhere else fits either —</span>';
      return '<tr class="click' + (f && !f.fits ? " short" : "") + '">' +
        UI.artThumbTd(b.record.imageUrl) +
        "<td>" + (b.suggestion ? '<input type="checkbox" class="brpick" aria-label="' + G.esc("Select " + (b.record.name || "card")) + '" data-i="' + i + '"' + (f.fits ? " checked" : "") + ">" : "") + "</td>" +
        '<td class="card-name">' + UI.cardLink(b.record) + (b.record.finish === "etched" ? ' <span class="badge etched">E</span>' : b.record.finish === "foil" ? ' <span class="badge foil">F</span>' : "") + "</td>" +
        '<td class="muted hide-sm">' + G.esc(G.recPrinting(b.record)) + "</td>" +
        '<td class="num">' + b.record.quantity + "</td>" +
        "<td>" + G.esc(G.locName(b.locationId)) + "</td>" +
        '<td class="wrap hide-sm" style="font-size:11.5px">' + breaks + "</td>" +
        '<td class="wrap" style="font-size:11.5px">' + to + "</td></tr>";
    }).join("");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const b = breakers[i];
      if (!b) return;
      UI.wireArtHover(tr, b.record.imageUrl);
      tr.onclick = e => {
        if (e.target.closest(".brpick")) return;
        if (e.target.closest(".spot-btn")) { UI.showPlacement(breakSpots.get(String(i)), b.record); return; }
        UI.reviewRecord(b.record);
      };
    });
    refreshBreakSpots();
    UI.reapplySorts();
  }

  async function applyBreak() {
    const picks = tickedRows("brpick", breakers);
    if (!picks.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const ok = await UI.confirmDialog("Move " + picks.length + " stack(s) out of the location whose rules they break?", { title: "Move cards?" });
    if (!ok) return;
    const out = G.applySuggestedMoves(picks, "Rule-breaker cleanup");
    G.persist("Rule-breaker cleanup");   // fires "change", which rebuilds the list
    UI.toast("Moved " + out.moved + " card(s)" +
      (out.skipped ? ", skipped " + out.skipped + " that would not fit" : "") +
      ". Undo puts everything back.", "ok");
  }

  /* ============================== Capacity ============================== */
  function renderCapacity() {
    const withCap = [], perNameOnly = [], without = [];
    for (const l of G.sortedLocations()) {
      const st = G.locStats(l.id);
      if (st.cap != null) withCap.push({ loc: l, st });
      else if (l.maxPerName != null) perNameOnly.push({ loc: l, st });
      else without.push({ loc: l, st });
    }
    withCap.sort((a, b) => (b.st.fillPct || 0) - (a.st.fillPct || 0));
    const full = withCap.filter(x => x.st.free === 0).length;
    $("capHdr").textContent = withCap.length
      ? withCap.length + " with a ceiling, " + full + " full, " +
        (perNameOnly.length + without.length) + " unlimited"
      : "no location has a ceiling yet";

    let html = "";
    if (withCap.length) {
      html += UI.barList(withCap.map(x => ({
        label: x.loc.name + (x.loc.staging ? " (tray)" : ""),
        value: x.st.fillPct || 0,
        text: x.st.cards + " / " + x.st.cap + (x.st.over ? " OVER" : x.st.free === 0 ? " FULL" : "")
      })));
    } else {
      html += '<div class="muted">No location has a card ceiling. Set one on the Locations page and a full ' +
        "binder stops being suggested for putaway.</div>";
    }
    const perName = G.state.locations.filter(l => l.maxPerName != null);
    if (perName.length) {
      html += "<hr><h3>Per-card limits</h3><div class='bars'>" + perName.map(l => {
        const st = G.locStats(l.id);
        return '<div class="bar-row"><span>' + G.esc(l.name) + "</span>" +
          '<span class="muted" style="font-size:11.5px">max ' + l.maxPerName +
          " cop" + (l.maxPerName === 1 ? "y" : "ies") + " of any one card</span>" +
          '<span class="num">' + st.cards + " held</span></div>";
      }).join("") + "</div>";
    }
    if (without.length) {
      html += "<hr><h3>No limits at all</h3><div class='muted'>" +
        without.map(x => G.esc(x.loc.name) + " (" + x.st.cards + " cards)").join(" · ") + "</div>";
    }
    $("capBody").innerHTML = html;
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    preview = UI.CardPanel("preview", { chime: false, placeholder: "Type a card name to see where it belongs." });
    UI.Autocomplete("inName", "acList", loadPrintings);
    UI.fillLocationSelect($("inFrom"), null, { anyLabel: "— not filed yet / in my hand —" });

    $("binPick").onchange = () => { binId = $("binPick").value; renderBin(); };
    $("binAllowSame").onchange = renderBin;
    $("binReload").onclick = renderBin;
    $("binSearch").addEventListener("input", G.debounce(renderBinRows, 180));
    $("binAll").onclick = () => { document.querySelectorAll(".bpick").forEach(c => { c.checked = true; }); refreshBinSpots(); };
    $("binNone").onclick = () => { document.querySelectorAll(".bpick").forEach(c => { c.checked = false; }); refreshBinSpots(); };
    // A tick changes which lines get filed, so where the rest land (#293).
    $("binBody").addEventListener("change", e => { if (e.target.classList.contains("bpick")) refreshBinSpots(); });
    $("toBody").addEventListener("change", e => { if (e.target.classList.contains("topick")) refreshToSpots(); });
    $("planBody").addEventListener("change", e => { if (e.target.classList.contains("ppick")) refreshPlanSpots(); });
    $("breakBody").addEventListener("change", e => { if (e.target.classList.contains("brpick")) refreshBreakSpots(); });
    $("binGo").onclick = applyBin;
    $("binPrint").onclick = printBin;

    $("toPick").onchange = () => { toId = $("toPick").value; renderTo(); };
    $("toReload").onclick = renderTo;
    $("toSearch").addEventListener("input", G.debounce(renderToRows, 180));
    $("toAll").onclick = () => { document.querySelectorAll(".topick").forEach(c => { c.checked = true; }); refreshToSpots(); };
    $("toNone").onclick = () => { document.querySelectorAll(".topick").forEach(c => { c.checked = false; }); refreshToSpots(); };
    $("toGo").onclick = applyTo;

    $("conMinLocs").onchange = renderConsolidate;
    $("conSearch").addEventListener("input", G.debounce(renderConsolidate, 180));
    $("conAll").onclick = () => document.querySelectorAll(".conpick").forEach(c => { c.checked = true; });
    $("conNone").onclick = () => document.querySelectorAll(".conpick").forEach(c => { c.checked = false; });
    $("conGo").onclick = applyConsolidate;

    $("inPrint").onchange = answer;
    $("inFoil").onchange = answer;
    $("inQty").oninput = answer;
    $("inFrom").onchange = answer;
    $("allowSame").onchange = answer;

    $("planFilter").onchange = renderPlanRows;
    $("planSearch").addEventListener("input", G.debounce(renderPlanRows, 180));
    $("planApply").onclick = applyPlan;
    $("planAll").onchange = () => {
      document.querySelectorAll(".ppick").forEach(c => { c.checked = $("planAll").checked; });
      refreshPlanSpots();
    };

    $("breakSearch").addEventListener("input", G.debounce(renderBreakRows, 180));
    $("breakApply").onclick = applyBreak;

    G.on("change", () => {
      UI.fillLocationSelect($("inFrom"), $("inFrom").value, { anyLabel: "— not filed yet / in my hand —" });
      if (!$("paneBin").hidden) renderBin();
      if (!$("paneTo").hidden) renderTo();
      if (!$("paneConsolidate").hidden) renderConsolidate();
      if (!$("panePlan").hidden) renderPlan();
      if (!$("paneBreak").hidden) renderBreak();
      if (!$("paneCap").hidden) renderCapacity();
    });

    // ?bin=<id> from a location card, #plan/#break/#to from the Locations page links.
    const params = new URLSearchParams(location.search);
    const wantBin = params.get("bin");
    if (wantBin && G.locById(wantBin)) binId = wantBin;
    const wantTo = params.get("to");
    if (wantTo && G.locById(wantTo)) toId = wantTo;
    // The tab is remembered (UI.pageTabs); the old #plan / #break / #to links still open theirs.
    tabs = UI.pageTabs({ tabs: Object.entries(PANES).map(([k, id]) =>
      ({ id: k, button: "tab" + k.charAt(0).toUpperCase() + k.slice(1), panes: [id] })), def: "bin", onShow: onTab });

    if (!G.putawayLocationCount()) {
      UI.toast("No location has putaway switched on yet, so there is nothing to decide from. " +
        "Set that up on the Locations page.", "work");
    }
  });
})();
