
"use strict";
(function () {
  const $ = UI.$;

  // What a line's copies are worth: the ones already in the destination plus
  // the ones Build would move. Plan pulls carry their stack (G.deckPlan), so
  // there's no collection lookup per pull (#118).
  const allocValue = a => a.here.concat(a.pulls).reduce((s, p) =>
    s + (p.record.price != null ? p.record.price * p.take : 0), 0);

  // Basic lands: a brewer has a box of them, so a deck that lacks some isn't
  // "missing" cards in any useful sense (#334). Shown as their own count.
  const isBasicLand = name => /^(?:snow-covered )?(?:plains|island|swamp|mountain|forest)$|^wastes$/i.test(String(name || "").trim());

  // What one more copy of a card we don't own would cost: the cheapest regular
  // (English, not promo) printing's Near Mint market price, any finish it
  // comes in (#334). undefined = still loading, null = no price to be had.
  // Missing cards that can't be priced are "not counted", like #326's totals.
  function cheapestEach(name) {
    const st = printingChoices(name);
    if (st.state === "loading") return undefined;
    if (st.state !== "ready") return null;
    const priceIn = c => [c.usd, c.usdFoil, c.usdEtched].map(v => v == null ? null : Number(v)).find(v => v != null && v > 0);
    const all = st.groups.flatMap(g => g.cards).filter(c => (c.lang || "en") === "en");
    const best = list => list.map(priceIn).filter(v => v != null).reduce((m, v) => m == null || v < m ? v : m, null);
    const normal = best(all.filter(c => !c.promo && c.setType !== "memorabilia" && c.setType !== "funny"));
    return normal != null ? normal : best(all);
  }
  // Total for a set of {name, qty} lines: { cost, counted, unpriced, loading }.
  function costToFinish(lines) {
    const out = { cost: 0, counted: 0, unpriced: 0, loading: false };
    for (const m of lines) {
      const each = cheapestEach(m.name);
      if (each === undefined) out.loading = true;
      else if (each == null) out.unpriced += m.qty;
      else { out.cost += each * m.qty; out.counted += m.qty; }
    }
    return out;
  }
  function costNote(c, lead) {
    if (!c.counted && !c.unpriced && !c.loading) return "";
    let t = lead + G.money(c.cost) + " for " + c.counted + " missing card" + (c.counted === 1 ? "" : "s") +
      " (cheapest regular printing, Near Mint market price)";
    if (c.loading) t += ". Still looking up prices…";
    else if (c.unpriced) t += ". " + c.unpriced + " missing card" + (c.unpriced === 1 ? " has" : "s have") + " no price and " + (c.unpriced === 1 ? "isn't" : "aren't") + " counted";
    return t;
  }

  // The Value cell of a missing line in a deck's detail: the cost to buy what's short.
  function costCell(m) {
    const each = isBasicLand(m.name) ? null : cheapestEach(m.name);
    return each == null ? '<td class="num hide-sm" data-v="">—</td>'
      : '<td class="num hide-sm" data-v="' + each * m.short + '" title="Cost to buy the missing copies">~' + G.money(each * m.short) + "</td>";
  }

  // The destination the preview and Build plan for: a picked location, or
  // null for "+ New deck location…" (a new box holds nothing yet).
  const planDest = () => { const v = $("deckDest").value; return v && v !== "__new" && G.locById(v) ? v : null; };

  // Is this location another deck (a saved deck's box or a Deck Box)? Building
  // from it takes cards out of that deck (#334).
  const isOtherDeck = id => !!(G.deckByLocation(id) || G.isDeckBox(G.locById(id)));
  // The other decks a plan would take cards out of: location id -> { name, cards: ["Cyclonic Rift ×1"] }.
  function deckSources(plan) {
    const out = new Map();
    for (const a of plan.lines) {
      for (const p of a.pulls) {
        if (!isOtherDeck(p.locationId)) continue;
        if (!out.has(p.locationId)) out.set(p.locationId, { name: G.locName(p.locationId), cards: [] });
        out.get(p.locationId).cards.push(p.record.name + " ×" + p.take);
      }
    }
    return out;
  }

  // "Pull from" for one plan line: copies already there, then each move.
  function pullCell(a, destId) {
    const parts = [];
    if (a.inDest) parts.push('<span class="pull">' + G.esc(G.locName(destId)) + " (already there): " + a.inDest + "</span>");
    for (const p of a.pulls) {
      parts.push('<span class="pull">' + (isOtherDeck(p.locationId)
        ? '<span class="warn" title="This is another deck. Building takes the card out of it.">' + G.esc(G.locName(p.locationId)) + " (a deck)</span>"
        : G.esc(G.locName(p.locationId))) + ": " + p.take +
        (p.listedTake ? ' <span class="muted">(' + p.listedTake + " listed)</span>" : "") + "</span>");
    }
    return parts.join(" ");
  }

  /* ===================== Format check (#80 legality, #81 rules) =====================
     The server answers name -> the card's deck-construction facts (see
     cards.js deckRules()): a legality code with one character per format in
     the order of its `formats` list ("l" legal, "n" not legal, "b" banned,
     "r" restricted, "?" unknown), colour identity, any copy-limit exemption,
     and whether it can be a commander. Cached per page load by lowercase
     name: none of it moves except on a ban announcement. */
  const FORMAT_LABELS = {
    standard: "Standard", pioneer: "Pioneer", modern: "Modern", premodern: "Premodern",
    legacy: "Legacy", vintage: "Vintage", pauper: "Pauper", commander: "Commander",
    paupercommander: "Pauper Commander", oathbreaker: "Oathbreaker"
  };
  /* Deck-construction rules per format. `cmd` is what the command zone holds
     ("lead" = legendary creature or "can be your commander", "walker" =
     planeswalker, "any" = not checked - Pauper Commander's "uncommon
     creature" depends on which printing, which a name-only line can't say). */
  const FORMAT_RULES = {
    standard: { min: 60, copies: 4 }, pioneer: { min: 60, copies: 4 }, modern: { min: 60, copies: 4 },
    premodern: { min: 60, copies: 4 }, legacy: { min: 60, copies: 4 }, vintage: { min: 60, copies: 4 },
    pauper: { min: 60, copies: 4 },
    commander: { exact: 100, copies: 1, cmd: "lead" },
    paupercommander: { exact: 100, copies: 1, cmd: "any" },
    oathbreaker: { exact: 60, copies: 1, cmd: "walker" }
  };
  const legalCache = new Map();   // lowercase name -> deckRules object | null (no such card)
  const legalInflight = new Set();
  let serverFormats = Object.keys(FORMAT_LABELS);
  let legalError = "";

  const deckFormat = () => (G.state.settings && FORMAT_LABELS[G.state.settings.deckFormat]) ? G.state.settings.deckFormat : "";
  const cmdFormat = () => { const f = deckFormat(); return !!(f && FORMAT_RULES[f].cmd); };
  const infoFor = it => legalCache.get(it.name.toLowerCase());

  async function fetchLegality() {
    // A failure sticks until the format is changed again - otherwise the
    // re-render below would immediately retry, fail, re-render, forever.
    if (!deckFormat() || legalError) return;
    const want = [...new Set(G.state.deckList.map(it => it.name))]
      .filter(n => !legalCache.has(n.toLowerCase()) && !legalInflight.has(n.toLowerCase()));
    if (!want.length) return;
    want.forEach(n => legalInflight.add(n.toLowerCase()));
    try {
      const out = await G.api("/api/cards/legality", { method: "POST", body: { names: want } });
      if (Array.isArray(out.formats)) serverFormats = out.formats;
      for (const n of want) {
        const v = out.results ? out.results[n] : undefined;
        // A bare string is a pre-#81 server's legality code alone - keep the
        // ban check, skip the rules it can't answer (copies/identity/commander).
        legalCache.set(n.toLowerCase(), v && typeof v === "object" ? v
          : typeof v === "string" ? { legal: v, partial: true } : null);
      }
      legalError = "";
    } catch (e) {
      legalError = e.message || String(e);
    } finally {
      want.forEach(n => legalInflight.delete(n.toLowerCase()));
    }
    renderDeck();
  }

  /* Deck-wide context the per-line check needs: who the commanders are and
     the colour identity they allow (null = no commander picked, so the
     identity check is skipped rather than flagging everything). */
  function deckContext() {
    const fmt = deckFormat();
    const cmds = cmdFormat() ? G.state.deckList.filter(it => it.commander) : [];
    let ci = null;
    if (cmds.length && cmds.every(it => infoFor(it) && !infoFor(it).partial)) {
      ci = new Set();
      cmds.forEach(it => [...infoFor(it).ci].forEach(c => ci.add(c)));
    }
    return { fmt, rules: fmt ? FORMAT_RULES[fmt] : null, label: FORMAT_LABELS[fmt] || "", cmds, ci };
  }

  /* Every problem with one deck line in the selected format - [] when it's
     fine or not looked up yet. `bad` marks a real rules problem; the rest
     are notes (a lone restricted copy is legal, an unknown name is
     probably a typo, "not checked yet" is a data gap, not a verdict). */
  function lineIssues(it, ctx) {
    if (!ctx.fmt) return [];
    const key = it.name.toLowerCase();
    if (!legalCache.has(key)) return [];
    const info = legalCache.get(key);
    if (info === null) return [{ kind: "unknown", bad: false, text: "unknown card name" }];
    const out = [];
    const ch = info.legal ? info.legal.charAt(serverFormats.indexOf(ctx.fmt)) : "";
    let restrictedHit = false;
    if (ch === "b") out.push({ kind: "banned", bad: true, text: "banned in " + ctx.label });
    else if (ch === "n") out.push({ kind: "notlegal", bad: true, text: "not legal in " + ctx.label });
    else if (ch === "r") {
      restrictedHit = it.qty > 1;
      out.push(restrictedHit
        ? { kind: "restricted", bad: true, text: "restricted in " + ctx.label + " — max 1" }
        : { kind: "restricted", bad: false, text: "restricted in " + ctx.label });
    } else if (ch !== "l") out.push({ kind: "nodata", bad: false, text: "" });
    if (info.partial) return out;
    // Copy limit - basics and "any number of cards named" are exempt, "up to
    // seven" (Seven Dwarves) raises it.
    const limit = info.copies === -1 ? Infinity : (info.copies > 0 ? info.copies : ctx.rules.copies);
    if (!restrictedHit && it.qty > limit) {
      out.push({ kind: "copies", bad: true, text: it.qty + " copies — max " + limit + " in " + ctx.label });
    }
    if (it.commander && cmdFormat()) {
      if (ctx.rules.cmd === "lead" && !info.lead) out.push({ kind: "cmd", bad: true, text: "can't be a commander" });
      if (ctx.rules.cmd === "walker" && !info.walker) out.push({ kind: "cmd", bad: true, text: "not a planeswalker — can't be the Oathbreaker" });
    } else if (ctx.ci) {
      const outside = [...info.ci].filter(c => !ctx.ci.has(c));
      if (outside.length) out.push({ kind: "identity", bad: true, text: "outside the commander's colours (" + outside.join("") + ")" });
    }
    return out;
  }

  function issueTags(issues) {
    return issues.filter(i => i.text).map(i =>
      " " + (i.bad ? '<span class="short-tag">' : '<span class="muted">') + "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#triangle-alert></use></svg> " + G.esc(i.text) + "</span>").join("");
  }

  function renderLegalSummary(allIssues, ctx) {
    const box = $("deckLegal");
    if (!ctx.fmt || !G.state.deckList.length) { box.hidden = true; return; }
    box.hidden = false;
    const label = G.esc(ctx.label);
    if (legalError) { box.innerHTML = '<span class="warn">Couldn\'t check ' + label + " legality: " + G.esc(legalError) + "</span>"; return; }
    const pending = G.state.deckList.some(it => !legalCache.has(it.name.toLowerCase()));
    if (pending) { box.textContent = "Checking " + ctx.label + " legality…"; return; }
    const count = kind => allIssues.reduce((s, iss) => s + (iss.some(i => i.kind === kind) ? 1 : 0), 0);
    const badLines = allIssues.filter(iss => iss.some(i => i.bad)).length;
    const problems = [];
    // Deck size counts every line, sideboard included - a name-only list has
    // no idea which copies are main deck.
    const total = G.state.deckList.reduce((s, it) => s + it.qty, 0);
    if (ctx.rules.exact && total !== ctx.rules.exact) {
      problems.push(total + " cards — " + label + " decks are exactly " + ctx.rules.exact + (ctx.rules.cmd ? " including the commander" : ""));
    } else if (ctx.rules.min && total < ctx.rules.min) {
      problems.push(total + " cards — " + label + " decks need at least " + ctx.rules.min);
    }
    if (ctx.rules.cmd) {
      const n = ctx.cmds.length;
      const loners = ctx.cmds.filter(it => infoFor(it) && !infoFor(it).partial && !infoFor(it).partner);
      if (n > 2) problems.push(n + " commanders picked — at most 2 (with Partner)");
      else if (n === 2 && loners.length) {
        problems.push("two commanders, but " + loners.map(it => UI.cardNameLink(it.name)).join(" and ") + " can't partner");
      }
    }
    const parts = [];
    if (badLines) parts.push('<span class="short-tag"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#triangle-alert></use></svg> ' + badLines + " line" + (badLines === 1 ? "" : "s") + " break " + label + " rules</span>");
    problems.forEach(p => parts.push('<span class="short-tag"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#triangle-alert></use></svg> ' + p + "</span>"));
    if (!parts.length) parts.push('<span class="ok-tag"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#check></use></svg> Legal in ' + label + " as far as can be checked</span>");
    if (ctx.rules.cmd) {
      parts.push(ctx.cmds.length
        ? "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#crown></use></svg> " + ctx.cmds.map(it => UI.cardNameLink(it.name) + (infoFor(it) && !infoFor(it).partial ? " (" + (infoFor(it).ci || "colourless") + ")" : "")).join(" + ")
        : '<span class="warn">No commander picked — press <svg class=ic aria-hidden=true><use href=/icons/sprite.svg#crown></use></svg> on its line to check colour identity</span>');
    }
    const unknown = count("unknown"), noData = count("nodata");
    if (unknown) parts.push(unknown + " name" + (unknown === 1 ? "" : "s") + " not recognised — check spelling");
    if (noData) parts.push(noData + " card" + (noData === 1 ? "" : "s") + " not checked yet — legality data arrives with the next card-database refresh");
    box.innerHTML = parts.join(" · ");
  }

  /* ============================== Deck list ============================== */
  /* Section headers the common exporters put in a pasted list (Arena,
     MTGO, Moxfield, Archidekt) - never card names. Maybeboard/tokens/the
     Arena "About" block aren't cards to gather, so their lines are skipped;
     a Commander section marks its lines as the commander. */
  const SECTION_RX = /^(?:\/\/\s*)?(commanders?|companion|deck|main|mainboard|main deck|sideboard|side|maybeboard|maybe|considering|tokens?|about)\s*(?:\(\d+\))?:?$/i;
  const SKIP_SECTIONS = new Set(["maybeboard", "maybe", "considering", "token", "tokens", "about"]);
  function deckSection(line) {
    const m = String(line || "").trim().match(SECTION_RX);
    return m ? m[1].toLowerCase() : null;
  }

  function parseDeckLine(line) {
    line = String(line || "").trim();
    if (!line) return null;
    let commander = false;
    // Archidekt-style category tags, e.g. "[Commander]" / "[Ramp{noDeck}]".
    line = line.replace(/\s*\[([^\]]*)\]/g, (m, tag) => { if (/^commander\b/i.test(tag)) commander = true; return ""; });
    // Moxfield's commander marker.
    line = line.replace(/\s*\*CMDR\*/i, () => { commander = true; return ""; });
    let qty = 1, name = line;
    const m = line.match(/^(\d+)\s*[xX]?\s+(.+)$/);
    if (m) { qty = parseInt(m[1], 10) || 1; name = m[2]; }
    // The printing a line names, e.g. "(MH2) 138 *F*": kept for "Add a deck I got" (#310).
    let set = "", collector = "", finish = "";
    name = name.replace(/\s*\*([A-Za-z])\*\s*$/, (m, f) => { // foil/etched marker, e.g. "*F*"
      finish = f.toUpperCase() === "E" ? "etched" : f.toUpperCase() === "F" ? "foil" : "";
      return "";
    });
    name = name.replace(/\s*\(([^)]*)\)\s*([\w\-★†]*)\s*$/, (m, st, num) => {
      if (/^[A-Za-z0-9]{2,6}$/.test(st) && num) { set = st.toLowerCase(); collector = num.replace(/^0+(?=\d)/, ""); }
      return "";
    }).trim();
    name = name.replace(/\s+\/\s+(?!\/)/, " // "); // MTGO-style split/DFC "A / B" -> Scryfall "A // B"
    return name ? { name, qty, commander, set, collector, finish } : null;
  }

  function renderDeck() {
    clearTimeout(lookupTimer); lookupHeld = false;
    const list = G.state.deckList;
    renderHdr();
    UI.fillLocationSelect($("deckDest"), null, { newLabel: "+ New deck location…" });
    $("deckNewWrap").hidden = $("deckDest").value !== "__new";
    const body = $("deckBody");
    const ctx = deckContext();
    const issues = list.map(it => lineIssues(it, ctx));
    renderLegalSummary(issues, ctx);
    const showCmd = cmdFormat();
    syncMode();
    previewShort = [];
    const buyLines = [];
    if (!list.length) {
      $("deckCost").hidden = true;
      body.innerHTML = UI.emptyRow(7, { icon: "cards", title: "Deck list is empty.",
        hint: "Paste a decklist above, or use a card's Manage → Add to deck list." });
      $("deckBuild").disabled = true;
      $("deckGot").disabled = true;
      syncBuy("preview");
      return;
    }
    fetchLegality();
    body.innerHTML = "";
    if (mode === "got") { renderGotRows(list, issues, showCmd); return; }
    $("deckGot").disabled = false;
    // One plan for the whole list and the chosen destination (#117): one
    // name index over the collection, not a scan per line (#118).
    const destId = planDest();
    const plan = G.deckPlan(list, destId);
    list.forEach((it, idx) => {
      const a = plan.lines[idx];
      const pulls = pullCell(a, destId);
      const basic = a.shortfall > 0 && isBasicLand(it.name);
      const each = a.shortfall > 0 && !basic ? cheapestEach(it.name) : null;
      if (a.shortfall > 0 && !basic) buyLines.push({ name: it.name, qty: a.shortfall });
      // Only a line that actually allocated has a real record to show art for
      // or review - an unresolved paste (typo, not owned) has nothing to look up.
      const first = a.here[0] || a.pulls[0];
      const rec = first ? first.record : null;
      const tr = document.createElement("tr");
      tr.dataset.idx = idx;
      tr.className = (a.shortfall > 0 && !basic ? "short " : "") + (rec ? "click" : "");
      tr.innerHTML =
        UI.artThumbTd(rec ? rec.imageUrl : "") +
        '<td class="card-name">' + (showCmd && it.commander ? '<span title="Commander" style="color:var(--gold)"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#crown></use></svg></span> ' : "") +
          (rec ? UI.cardLink(rec, it.name) : G.esc(it.name)) + issueTags(issues[idx]) + "</td>" +
        '<td class="num">' + it.qty + "</td>" +
        '<td class="alloc">' + (pulls || '<span class="muted">— not in inventory —</span>') + "</td>" +
        '<td class="num hide-sm">' + G.money(allocValue(a)) + "</td>" +
        "<td>" + (basic ? '<span class="muted" title="Basic lands aren\'t counted as missing.">basic land: ' + a.shortfall + " to find</span>"
          : a.shortfall > 0 ? tickHtml("preview", it.name) + '<span class="short-tag">short ' + a.shortfall + "</span> " +
          (each != null ? '<span class="muted" title="Cheapest regular printing, Near Mint market price, for the missing copies">~' + G.money(each * a.shortfall) + "</span> " : "") +
          mpLink(it.name) +
          (a.reserved ? ' <span class="muted" title="Sold on Manapool, not picked yet. Build never moves these.">' +
            a.reserved + " reserved for Manapool orders</span>" : "")
          : '<span class="ok-tag">OK</span>') + "</td>";
      if (a.shortfall > 0 && !basic) previewShort.push({ name: it.name, qty: a.shortfall });
      tr.appendChild(actionCell(it, idx, showCmd));
      if (rec) {
        UI.wireArtHover(tr, rec.imageUrl);
        tr.onclick = e => { if (e.target.closest("button, a, input")) return; UI.reviewRecord(rec); };
      }
      body.appendChild(tr);
    });
    $("deckBuild").disabled = false;
    const costBox = $("deckCost"), costTxt = costNote(costToFinish(buyLines), "Cost to finish: ");
    costBox.hidden = !costTxt;
    costBox.textContent = costTxt;
    pruneTicks("preview", previewShort);
    syncBuy("preview");
  }

  // The last two buttons on a deck-list row: mark as commander, remove.
  function actionCell(it, idx, showCmd) {
    const td = document.createElement("td");
    td.className = "nowrap";
    if (showCmd) {
      const label = it.commander ? "Unmark as commander" : "Mark as commander";
      const cb = document.createElement("button");
      cb.className = "small" + (it.commander ? " gold" : "");
      cb.title = label; cb.setAttribute("aria-label", label);
      cb.setAttribute("aria-pressed", it.commander ? "true" : "false");
      cb.innerHTML = "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#crown></use></svg>";
      cb.onclick = () => {
        if (it.commander) delete it.commander; else it.commander = true;
        G.persist(it.commander ? "Mark commander" : "Unmark commander");
        renderDeck();
      };
      td.appendChild(cb);
      td.appendChild(document.createTextNode(" "));
    }
    const rb = document.createElement("button");
    rb.className = "small"; rb.title = "Remove this line"; rb.setAttribute("aria-label", "Remove this line");
    rb.textContent = "✕";
    rb.onclick = () => {
      G.state.deckList.splice(idx, 1);
      G.persist("Remove deck list line");
      renderDeck();
    };
    td.appendChild(rb);
    return td;
  }

  /* "Add a deck I got": the preview shows what each line will add. A line
     with no set + number (or whose printing isn't in the card database) gets
     a printing picker with no default: the owner chooses, nothing is guessed
     (#310). Add stays off until every line has a printing. */
  const printState = new Map();     // "set|number" of a pasted printing -> "checking" | "ok" | "missing"
  const choicesFor = new Map();     // lowercase card name -> { state: loading|ready|none|error, groups, error }
  const pkey = p => p.set + "|" + G.normNum(p.collector);
  function printingState(p) {
    const k = pkey(p);
    if (!printState.has(k)) {
      printState.set(k, "checking");
      G.cards.one(p.set, p.collector, "en")
        .then(c => printState.set(k, c ? "ok" : "missing"), () => printState.set(k, "ok"))   // a network error isn't "no such printing"
        .then(redrawAfterLookup);
    }
    return printState.get(k);
  }
  /* A finished lookup redraws the preview, but never while the owner has a
     printing/finish picker focused (an open dropdown would snap shut and
     focus would be lost): it waits for the picker to lose focus, and a burst
     of lookups draws once (#314). */
  let lookupTimer = 0, lookupHeld = false;
  // After a pick the picker keeps focus (so the keyboard isn't lost) but is
  // "settled": it no longer holds redraws, until the owner touches one again.
  let pickSettled = false, refocusing = false;
  function pickerFocused() {
    const a = document.activeElement;
    return !pickSettled && !!(a && a.dataset && (a.dataset.pick !== undefined || a.dataset.finish !== undefined));
  }
  function redrawAfterLookup() {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(() => {
      if (pickerFocused()) { lookupHeld = true; return; }
      lookupHeld = false;
      renderDeck();
      if (panel.isOpen()) renderDetail();   // missing-card prices (#334)
    }, 5);
  }
  // Put focus back on the picker the owner just used, after its row was redrawn.
  function refocusPicker(attr, name) {
    const sels = $("deckBody").querySelectorAll("select");
    for (const el of sels) if (el.dataset && el.dataset[attr] === name) { refocusing = true; try { el.focus(); } finally { refocusing = false; } return; }
  }
  // A failed printings load is not remembered: Retry, or pasting lines again, asks again.
  function dropFailedLookups(name) {
    for (const [k, v] of [...choicesFor]) if (v.state === "error" && (!name || k === name.toLowerCase())) choicesFor.delete(k);
  }
  function printingChoices(name) {
    const k = name.toLowerCase();
    if (!choicesFor.has(k)) {
      const st = { state: "loading", groups: [], error: "" };
      choicesFor.set(k, st);
      G.cards.printings(name).then(
        list => { st.groups = G.groupPrintings(list); st.state = st.groups.length ? "ready" : "none"; },
        err => { st.state = "error"; st.error = err.message || String(err); }
      ).then(redrawAfterLookup);
    }
    return choicesFor.get(k);
  }
  // One line's printings: the pasted ones that exist, the owner's pick, and
  // how many copies still need a printing.
  function gotLine(it) {
    const prints = it.prints || [];
    const checking = prints.some(p => printingState(p) === "checking");
    const good = prints.filter(p => printingState(p) !== "missing");
    const picked = prints.find(p => p.picked && printingState(p) !== "missing") || null;
    let need = Math.max(0, it.qty - good.reduce((s, p) => s + p.qty, 0));
    if (picked && need > 0) { picked.qty += need; need = 0; }   // the line grew after the pick (a second paste)
    return { good, picked, need, checking, bad: prints.some(p => printingState(p) === "missing") };
  }
  // The list with only printings that exist, for the plan.
  const gotList = list => list.map(it => Object.assign({}, it, { prints: gotLine(it).good }));
  function pickPrinting(name, value) {
    const it = G.state.deckList.find(x => x.name.toLowerCase() === name.toLowerCase());
    const ch = choicesFor.get(name.toLowerCase());
    if (!it || !ch) return;
    const keepFinish = (it.prints || []).find(p => p.picked);
    const finish = (keepFinish && keepFinish.finish) || it.finish || "nonfoil";
    // Drop an earlier pick and any printing that doesn't exist; what's left is the pasted, real ones.
    it.prints = (it.prints || []).filter(p => !p.picked && printingState(p) !== "missing");
    const g = value === "" ? null : ch.groups[parseInt(value, 10)];
    if (g) {
      const rest = it.prints.reduce((s, p) => s + p.qty, 0);
      it.prints.push({ set: g.set, collector: g.collector, finish, qty: Math.max(1, it.qty - rest), picked: true });
    }
    if (!it.prints.length) delete it.prints;
    G.persist("Choose printing");
    pickSettled = true;
    renderDeck();
    refocusPicker("pick", name);
  }
  function pickFinish(name, finish) {
    const it = G.state.deckList.find(x => x.name.toLowerCase() === name.toLowerCase());
    const p = it && (it.prints || []).find(x => x.picked);
    if (!p || !G.FINISH_NAMES[finish]) return;
    p.finish = finish;
    G.persist("Choose finish");
    pickSettled = true;
    renderDeck();
    refocusPicker("finish", name);
  }
  function onGotChange(e) {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const sel = t.closest("select[data-pick]");
    if (sel && sel.dataset.pick !== undefined) return pickPrinting(sel.dataset.pick, sel.value);
    const fin = t.closest("select[data-finish]");
    if (fin && fin.dataset.finish !== undefined) pickFinish(fin.dataset.finish, fin.value);
  }
  function pickerCell(it, g) {
    const ch = printingChoices(it.name);
    if (ch.state === "loading") return '<span class="muted">Loading printings…</span>';
    if (ch.state === "none") return '<span class="warn">No card by this name — check the spelling or remove the line</span>';
    if (ch.state === "error") return '<span class="warn">Couldn\'t load printings: ' + G.esc(ch.error) + '</span> <button class="small" data-retry="' + G.esc(it.name) + '">Retry</button>';
    const at = g.picked ? ch.groups.findIndex(x => x.set === g.picked.set && G.normNum(x.collector) === G.normNum(g.picked.collector)) : -1;
    const fin = g.picked ? g.picked.finish : (it.finish || "nonfoil");
    return '<select data-pick="' + G.esc(it.name) + '" aria-label="Printing for ' + G.esc(it.name) + '"><option value="">Choose printing…</option>' +
      ch.groups.map((x, i) => '<option value="' + i + '"' + (i === at ? " selected" : "") + ">" + G.esc(G.printingChoiceLabel(G.englishOf(x))) + "</option>").join("") + "</select> " +
      '<select data-finish="' + G.esc(it.name) + '" aria-label="Finish for ' + G.esc(it.name) + '">' +
      Object.keys(G.FINISH_NAMES).map(f => '<option value="' + f + '"' + (f === fin ? " selected" : "") + ">" + G.esc(G.FINISH_NAMES[f]) + "</option>").join("") + "</select>";
  }
  function renderGotRows(list, issues, showCmd) {
    const body = $("deckBody");
    let needCards = 0, checking = false;
    list.forEach((it, idx) => {
      const g = gotLine(it);
      needCards += g.need;
      checking = checking || g.checking;
      const prints = g.good.filter(p => !p.picked).map(p => '<span class="pull">' + G.esc(p.set.toUpperCase() + " #" + p.collector) +
        (p.finish !== "nonfoil" ? " (" + G.esc(p.finish) + ")" : "") + (g.good.length > 1 || g.need ? ": " + p.qty : "") + "</span>");
      const choose = g.need > 0 || g.picked;
      const ch = choose ? choicesFor.get(it.name.toLowerCase()) || printingChoices(it.name) : null;
      const noCard = choose && ch.state === "none";
      const tr = document.createElement("tr");
      tr.className = g.need ? "short" : "";
      tr.innerHTML = "<td></td>" +
        '<td class="card-name">' + (showCmd && it.commander ? '<span title="Commander" style="color:var(--gold)"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#crown></use></svg></span> ' : "") +
          ((g.picked || g.good[0]) ? UI.cardLink(Object.assign({ name: it.name }, g.picked || g.good[0])) : G.esc(it.name)) + issueTags(issues[idx]) + "</td>" +
        '<td class="num">' + it.qty + "</td>" +
        '<td class="alloc">' + prints.join(" ") + (prints.length && choose ? " " : "") + (choose ? pickerCell(it, g) : "") + "</td>" +
        '<td class="num hide-sm"></td>' +
        "<td>" + (g.need ? '<span class="short-tag">' + (noCard ? "No such card" : "Choose a printing") + "</span>"
          : g.checking ? '<span class="muted">Checking…</span>' : '<span class="ok-tag">Will add</span>') + "</td>";
      tr.appendChild(actionCell(it, idx, showCmd));
      body.appendChild(tr);
    });
    $("deckGot").disabled = needCards > 0 || checking;
    $("gotNote").hidden = !needCards && !checking;
    $("gotNote").textContent = needCards ? plural(needCards, "card") + (needCards === 1 ? " still needs" : " still need") + " a printing"
      : "Checking printings…";
    syncBuy("preview");
  }

  /* ===================== Missing cards: Manapool links + buying (#310) =====================
     A missing line gets a Manapool search link and a tick box; the Buy button
     copies the ticked ones as "qty name" lines (what Manapool's Mass Entry
     box takes) and opens its paste page. Grimoire can't check out for you. */
  let mode = "build";           // New deck: "build" (from my stock) or "got" (a deck I got)
  let previewShort = [];        // [{ name, qty }] the New deck preview is short of
  let detailShort = [];         // the same for the open deck's missing cards
  const ticks = { preview: new Set(), deck: new Set() };   // ticked lines, by lowercase name
  const tickKey = n => String(n).toLowerCase();
  const shortOf = scope => scope === "preview" ? previewShort : detailShort;
  const tickedLines = scope => shortOf(scope).filter(m => ticks[scope].has(tickKey(m.name)));
  const tickHtml = (scope, name) => '<input type="checkbox" data-tick="' + G.esc(name) + '"' +
    (ticks[scope].has(tickKey(name)) ? " checked" : "") + ' aria-label="Buy ' + G.esc(name) + ' from Manapool"> ';
  const mpLink = name => '<a href="' + G.esc(G.manapoolSearchUrl(name)) + '" target="_blank" rel="noopener" title="Look for it on Manapool">' +
    UI.icon("external-link") + " Manapool</a>";
  function pruneTicks(scope, lines) {
    const keep = new Set(lines.map(m => tickKey(m.name)));
    ticks[scope] = new Set([...ticks[scope]].filter(k => keep.has(k)));
  }
  // Buy button enabled only with something ticked; "tick all" follows.
  function syncBuy(scope) {
    const pre = scope === "preview";
    const n = tickedLines(scope).length, all = shortOf(scope).length;
    $(pre ? "deckBuy" : "dpBuy").disabled = !n;
    const box = $(pre ? "deckTickAll" : "dpTickAll");
    if (box) box.checked = all > 0 && n === all;
    if (pre) $("tickAllWrap").hidden = mode === "got" || !all;
  }
  function onTickChange(scope, e) {
    const cb = e.target && e.target.closest ? e.target.closest("input[data-tick]") : null;
    if (!cb) return;
    const k = tickKey(cb.dataset.tick);
    if (cb.checked) ticks[scope].add(k); else ticks[scope].delete(k);
    syncBuy(scope);
  }
  function tickAll(scope, on) {
    ticks[scope] = on ? new Set(shortOf(scope).map(m => tickKey(m.name))) : new Set();
    if (scope === "preview") renderDeck(); else renderDetail();
  }
  async function buySelected(scope) {
    const lines = tickedLines(scope);
    if (!lines.length) return;
    const text = G.manapoolPasteText(lines);
    const n = lines.reduce((s, l) => s + l.qty, 0);
    // Start the copy and open the tab straight from the click, so the
    // browser allows both.
    let copied;
    try {
      copied = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"));
    } catch (err) { copied = Promise.reject(err); }
    try { window.open(G.MANAPOOL_ADD_DECK, "_blank", "noopener"); } catch (err) {}
    const pre = scope === "preview";
    const fb = $(pre ? "deckBuyFallback" : "dpBuyFallback"), ta = $(pre ? "deckBuyText" : "dpBuyText");
    try {
      await copied;
      fb.hidden = true;
      UI.toast("Copied " + plural(n, "card") + ". Paste them into Manapool's Mass Entry box.", "ok");
    } catch (err) {
      // The browser blocked the copy: show the list selected so Ctrl+C works.
      ta.value = text;
      fb.hidden = false;
      try { ta.focus(); ta.select(); } catch (e2) {}
      UI.toast("Couldn't copy automatically. Copy the list shown below, then paste it into Manapool's Mass Entry box.", "err");
    }
  }

  function setMode(m) {
    mode = m;
    renderDeck();
  }
  function syncMode() {
    const got = mode === "got";
    $("modeBuild").classList.toggle("active", !got);
    $("modeGot").classList.toggle("active", got);
    $("modeBuild").setAttribute("aria-pressed", got ? "false" : "true");
    $("modeGot").setAttribute("aria-pressed", got ? "true" : "false");
    $("modeHint").textContent = got
      ? "You got the cards for a deck (a precon, a purchase, a trade). They are added to your stock as new copies, placed straight into the deck's box. If a line has its set and number, like 1 Sol Ring (C21) 263, that printing is used. Otherwise you choose the printing on the line."
      : "The table below already shows what you own and what's short, so you can just look. Build the deck moves the cards you own into a deck box; it doesn't add any stock.";
    $("deckBuild").hidden = got;
    $("deckGot").hidden = !got;
    if (!got || !G.state.deckList.length) $("gotNote").hidden = true;
    $("deckBuy").hidden = got;
    $("deckPrint").hidden = got;
    $("deckTable").classList.toggle("got-mode", got);
    $("thPull").textContent = got ? "Printing" : "Pull from";
    $("thStatus").textContent = got ? "Will it be added?" : "Status";
    $("deckBuyFallback").hidden = $("deckBuyFallback").hidden || got;
  }

  async function addDeckLines() {
    dropFailedLookups();
    const lines = $("deckPaste").value.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    let added = 0, section = "";
    const parsed = [];
    for (const ln of lines) {
      const sec = deckSection(ln);
      if (sec) { section = sec; continue; }
      if (SKIP_SECTIONS.has(section)) continue;
      const p = parseDeckLine(ln);
      if (p) { parsed.push({ p, commander: p.commander || section === "commander" || section === "commanders" }); added += p.qty; }
    }
    if (!added) { $("deckProgress").textContent = "Nothing recognisable in that paste."; return; }
    // Moxfield-style export: one card on line 1, then a blank line, with no
    // "Commander" heading. Offer that first card as the commander (#334).
    const raw = $("deckPaste").value.split(/\r?\n/).map(s => s.trim());
    const first = raw.findIndex(Boolean);
    if (first >= 0 && raw[first + 1] === "" && raw.slice(first + 2).some(Boolean) &&
        !parsed.some(x => x.commander) && !raw.some(deckSection) && parsed.length > 2 && parsed[0].p.qty === 1) {
      if (await UI.confirmDialog('The first line, "' + parsed[0].p.name + '", is on its own above a blank line. Is it your commander?',
          { title: "Commander?", okLabel: "Yes, commander", cancelLabel: "No, just a card" })) parsed[0].commander = true;
    }
    // Pasting the same list twice would double every card (#328): when most of what's pasted is already
    // on the list at the same count or more, ask first.
    const want = new Map();
    parsed.forEach(x => { const k = x.p.name.toLowerCase(); want.set(k, (want.get(k) || 0) + x.p.qty); });
    const onList = new Map(G.state.deckList.map(x => [x.name.toLowerCase(), x.qty]));
    const already = [...want].filter(([k, q]) => (onList.get(k) || 0) >= q).length;
    if (want.size >= 3 && already / want.size >= 0.8) {
      const ok = await UI.confirmDialog(
        "Most of these cards (" + already + " of " + want.size + ") are already on your deck list. Adding the lines again will double them.\n\nAdd them anyway?",
        { title: "Already on the list?", okLabel: "Add anyway" });
      if (!ok) return;
    }
    for (const x of parsed) {
      G.addToDeckList(x.p.name, x.p.qty, { commander: x.commander, set: x.p.set, collector: x.p.collector, finish: x.p.finish });
    }
    $("deckPaste").value = "";
    G.persist("Add " + added + " card(s) to deck list");
    renderDeck();
    $("deckProgress").textContent = "Added " + added + " card(s) across " + lines.length + " line(s).";
  }

  async function buildDeck() {
    const list = G.state.deckList;
    if (!list.length) return;
    // A new deck location is only named and checked here; it is created once
    // the confirm is accepted (#118), so a Cancel leaves nothing behind.
    const isNew = $("deckDest").value === "__new";
    const newName = isNew ? $("deckNewName").value.trim() : "";
    const nameTaken = () => G.state.locations.some(l => l.name.toLowerCase() === newName.toLowerCase());
    const takenMsg = () => '<span class="warn">A location named "' + G.esc(newName) +
      '" already exists — pick it under Destination.</span>';
    let targetId = null;
    if (isNew) {
      if (!newName) { $("deckProgress").innerHTML = '<span class="warn">Name the new deck location.</span>'; $("deckNewName").focus(); return; }
      if (nameTaken()) { $("deckProgress").innerHTML = takenMsg(); return; }
    } else {
      targetId = $("deckDest").value;
      if (!G.locById(targetId)) return;
    }
    const toName = isNew ? newName : G.locName(targetId);
    // A saved deck already in the destination: ask each time whether these
    // cards add to its list or replace it (owner, 2026-10-18, #309). Adding
    // plans the moves for the deck's list plus these lines, so a 4th copy of
    // a card the box already holds 3 of moves in, as the bigger list needs.
    const saved = targetId ? G.deckByLocation(targetId) : null;
    let skip = null;   // other decks' locations the owner chose not to take from (#334)
    const planFor = mode => G.deckPlan(mode === "add" && saved ? G.mergeDeckLines(saved.lines, list) : list, targetId, skip);
    // Building a second deck can quietly empty the first: say which deck loses
    // which cards, and let the owner leave those lines short instead.
    {
      const srcs = deckSources(planFor("replace"));
      if (saved) for (const [k, v] of deckSources(planFor("add"))) if (!srcs.has(k)) srcs.set(k, v);
      if (srcs.size) {
        const lines = [...srcs.values()].map(v => '- "' + v.name + '": ' + v.cards.slice(0, 6).join(", ") +
          (v.cards.length > 6 ? ", and " + (v.cards.length - 6) + " more" : "")).join("\n");
        const take = await UI.confirmDialog(
          "Some of these cards are in other decks. Building \"" + toName + "\" takes them out of those decks:\n\n" + lines +
          "\n\nTake them anyway, or leave them where they are and leave those lines short?",
          { title: "Taking cards from another deck", okLabel: "Take them from those decks", altLabel: "Leave them (lines stay short)" });
        if (!take) return;
        if (take === "alt") skip = new Set(G.state.locations.filter(l => l.id !== targetId && isOtherDeck(l.id)).map(l => l.id));
      }
    }
    const plans = { replace: planFor("replace") };
    if (saved) plans.add = planFor("add");
    const cardsIn = lines => lines.reduce((s, l) => s + l.qty, 0);
    const shortsIn = p => p.lines.filter(a => a.shortfall > 0).length;
    const s = (n, one, many) => n + " " + (n === 1 ? one : many);
    const listedNote = (n, verb) => "\n\n" + s(n, "listed copy", "listed copies") + " " + (verb || "will") + " move. Push Listings afterwards to delist " + (n === 1 ? "it" : "them") + ".";
    const reservedNote = p => p.lines.some(a => a.shortfall > 0 && a.reserved) ? " Copies reserved for open Manapool orders are never moved." : "";
    let msg = 'Build the deck by MOVING cards into "' + toName + '"? Your total inventory is unchanged.';
    const opts = { title: "Build deck?" };
    if (!saved) {
      const plan = plans.replace, shorts = shortsIn(plan);
      if (plan.inDest) msg += "\n\n" + plan.inDest + " card(s) already in \"" + toName + "\" count toward the deck and stay put.";
      if (plan.listedMoving) msg += listedNote(plan.listedMoving);
      if (shorts) msg += "\n\n" + shorts + " line(s) do not have enough copies and will move partially.";
      msg += reservedNote(plan);
    } else {
      const was = cardsIn(saved.lines), now = cardsIn(list);
      const choice = (label, total, p) => "\n\n" + label + ": its list becomes " + s(total, "card", "cards") + " and " +
        s(p.moving, "card moves", "cards move") + " in" + (shortsIn(p) ? ", " + s(shortsIn(p), "line", "lines") + " short" : "") + ".";
      msg += '\n\n"' + toName + '" already holds the saved deck "' + saved.name + '" (' + s(was, "card", "cards") +
        " in its list). Cards already in it count toward the list and stay put." +
        choice("Add these cards to its list", was + now, plans.add) + choice("Replace its list", now, plans.replace);
      const listed = Math.max(plans.add.listedMoving, plans.replace.listedMoving);
      if (listed) msg += listedNote(listed, "may");
      msg += reservedNote(plans.add) || reservedNote(plans.replace);
      opts.okLabel = "Add these cards to " + saved.name + "'s list";
      opts.altLabel = "Replace its list (" + s(was, "card", "cards") + " → " + now + ")";
    }
    const ok = await UI.confirmDialog(msg, opts);
    if (!ok) return;
    const mode = saved && ok !== "alt" ? "add" : "replace";
    const plan = plans[mode];

    // The collection can change while the dialog is open (undo, a merged
    // save, an order picked, the saved deck edited). Re-plan for the chosen
    // way and stop if the moves are different.
    const fresh = (targetId ? G.deckByLocation(targetId) : null) === saved ? planFor(mode) : null;
    if (G.state.deckList !== list || !fresh || fresh.fingerprint !== plan.fingerprint) {
      renderDeck();
      $("deckProgress").innerHTML = '<span class="warn">Your cards changed while the confirm was open. Check the list and press Build again.</span>';
      return;
    }
    if (isNew) {
      if (nameTaken()) { $("deckProgress").innerHTML = takenMsg(); return; }
      targetId = G.findOrCreateLocation(newName, "Deck Box");
    }

    let moved = 0, shortLines = 0;
    const lines = [];
    for (const a of fresh.lines) {
      const it = a.item;
      if (a.shortfall > 0) shortLines++;
      for (const pull of a.pulls) {
        const r = pull.record;
        lines.push({ name: it.name, qty: pull.take, from: G.locName(pull.locationId), to: toName });
        G.logAudit({ action: "build", ...G.auditCard(r), qty: pull.take, oldQty: r.quantity,
          newQty: r.quantity - pull.take, from: G.locName(pull.locationId), to: toName,
          note: 'Moved into deck "' + toName + '"' });
        const costEach = Number(r.costQty) > 0 ? r.avgCost : null;
        const costCopies = Math.min(pull.take, Number(r.costQty) || 0);
        const clone = Object.assign({}, r, { id: G.uid(), locationId: targetId, quantity: pull.take,
          listedQty: 0, costQty: 0, costTotal: 0, avgCost: null });
        if (costEach != null && costCopies > 0) G.applyCost(clone, costCopies, costEach);
        G.removeCost(r, costCopies);
        r.quantity -= pull.take;
        G.splitLoans(r, clone);
        moved += pull.take;
        if (r.listedQty > r.quantity) r.listedQty = Math.max(0, r.quantity);
        G.state.cards.push(clone);
      }
    }
    G.state.cards = G.state.cards.filter(r => r.quantity > 0);
    G.normalizeMerge({ silent: true });
    G.addHistory({ id: G.uid(), ts: new Date().toISOString(), type: "build",
      title: 'Built deck "' + toName + '"', deck: toName, lines, totalCards: moved, short: shortLines });
    // The deck is kept with its whole list, missing cards included (#309),
    // in the same save as the moves, so Undo takes both back.
    G.saveBuiltDeck({ name: toName, locationId: targetId, lines: list, format: deckFormat(), source: "build", mode });
    G.state.deckList = [];
    G.persist();
    tabs.show("decks");
    UI.toast('Built "' + toName + '": moved ' + moved + " card" + (moved === 1 ? "" : "s") + " in" +
      (shortLines ? ", " + shortLines + " line(s) short" : "") + ". It's saved under My decks. Undo puts every card back.", "ok");
  }

  /* ==================== Add a deck I got (#310) ====================
     The pasted cards become NEW stock in the destination (the same
     lookup + addCopies path Receive uses), and the deck is saved with
     source "got". Every line needs a printing, and the owner picks it on the
     line when the paste didn't name one: nothing is guessed. */
  async function gotDeck() {
    const list = G.state.deckList;
    if (!list.length) return;
    const isNew = $("deckDest").value === "__new";
    const newName = isNew ? $("deckNewName").value.trim() : "";
    const nameTaken = () => G.state.locations.some(l => l.name.toLowerCase() === newName.toLowerCase());
    const takenMsg = () => '<span class="warn">A location named "' + G.esc(newName) +
      '" already exists — pick it under Destination.</span>';
    let targetId = null;
    if (isNew) {
      if (!newName) { $("deckProgress").innerHTML = '<span class="warn">Name the new deck location.</span>'; $("deckNewName").focus(); return; }
      if (nameTaken()) { $("deckProgress").innerHTML = takenMsg(); return; }
    } else {
      targetId = $("deckDest").value;
      if (!G.locById(targetId)) return;
    }
    const toName = isNew ? newName : G.locName(targetId);
    const plan = G.gotDeckPlan(gotList(list));
    if (plan.loose.length || list.some(it => gotLine(it).checking || gotLine(it).bad)) {
      $("deckProgress").innerHTML = '<span class="warn">Every line needs a printing first. Choose one on each line, or remove the line.</span>';
      return;
    }
    const signature = JSON.stringify(list);
    $("deckProgress").textContent = "Looking up " + plural(plan.printed.length, "printing") + "…";
    const entries = [];
    const looked = await Promise.all(plan.printed.map(async p => {
      try { return { p, info: await G.lookupCard(p.set, p.collector, "en", p.finish) }; }
      catch (err) { return { p, err: err.message || String(err) }; }
    }));
    const failed = looked.filter(x => !x.info);
    if (failed.length) {
      $("deckProgress").innerHTML = '<span class="warn">Nothing was added. Couldn\'t look up ' +
        G.esc(failed.map(x => x.p.name + " (" + x.err + ")").join(", ")) + "</span>";
      return;
    }
    for (const x of looked) entries.push(Object.assign({}, x.p, { lang: "en", info: x.info }));
    $("deckProgress").textContent = "";
    const cardsIn = lines => lines.reduce((s, l) => s + l.qty, 0);
    const addedCards = entries.reduce((s, e) => s + e.qty, 0);
    const s = (n, one, many) => n + " " + (n === 1 ? one : many);
    const saved = targetId ? G.deckByLocation(targetId) : null;
    let msg = 'Add ' + s(addedCards, "card", "cards") + " (" + s(entries.length, "printing", "printings") + ') to your stock as new copies in "' +
      toName + '"? Your total inventory goes up by ' + addedCards + "; no cost is recorded.";
    const opts = { title: "Add deck?" };
    if (saved) {
      const was = cardsIn(saved.lines);
      msg += '\n\n"' + toName + '" already holds the saved deck "' + saved.name + '" (' + s(was, "card", "cards") +
        " in its list). Add these cards to its list (" + (was + addedCards) + " cards), or replace its list (" + addedCards + " cards)? " +
        "Either way the cards are added to your stock.";
      opts.okLabel = "Add these cards to " + saved.name + "'s list";
      opts.altLabel = "Replace its list (" + s(was, "card", "cards") + " → " + addedCards + ")";
    } else opts.okLabel = "Add to my stock";
    const ok = await UI.confirmDialog(msg, opts);
    if (!ok) return;
    const mode = saved && ok !== "alt" ? "add" : "replace";
    // The paste or the saved deck can change while the dialog is open.
    if (G.state.deckList !== list || JSON.stringify(list) !== signature ||
        (targetId ? G.deckByLocation(targetId) : null) !== saved) {
      renderDeck();
      $("deckProgress").innerHTML = '<span class="warn">Your list changed while the confirm was open. Check it and press the button again.</span>';
      return;
    }
    if (isNew) {
      if (nameTaken()) { $("deckProgress").innerHTML = takenMsg(); return; }
      targetId = G.findOrCreateLocation(newName, "Deck Box");
    }
    G.addGotDeck({ name: toName, locationId: targetId, format: deckFormat(), mode, entries });
    G.state.deckList = [];
    G.persist('Add deck "' + toName + '"');
    tabs.show("decks");
    UI.toast('Added "' + toName + '": ' + s(addedCards, "new card", "new cards") + " in stock. It's saved under My decks. Undo takes it all back.", "ok");
  }

  function printDeck() {
    const list = G.state.deckList;
    if (!list.length) return;
    const order = UI.domOrder($("deckBody"), list.length);
    const ordered = order ? order.map(i => list[i]) : list;
    const ctx = deckContext();
    const destId = planDest();
    const plan = G.deckPlan(list, destId);
    const body = ordered.map(it => {
      const a = plan.lines[list.indexOf(it)];
      const notes = lineIssues(it, ctx).filter(i => i.text).map(i => G.esc(i.text));
      const from = (a.inDest ? [G.esc(G.locName(destId)) + " (already there): " + a.inDest] : [])
        .concat(a.pulls.map(p => G.esc(G.locName(p.locationId)) + ": " + p.take + (p.listedTake ? " (" + p.listedTake + " listed)" : "")));
      return [G.esc(it.name) + (it.commander && cmdFormat() ? " (commander)" : "") + (notes.length ? "<br><i>" + notes.join("; ") + "</i>" : ""), it.qty,
        from.join("<br>") || "—",
        a.shortfall > 0 ? "SHORT " + a.shortfall : "OK"];
    });
    G.printList("Deck list", ["Card", "Qty", "Pull from", "Status"], body);
  }

  /* ==================== My decks / All deck cards (#309) ====================
     A deck is a saved deck (Build keeps its list) or a Deck Box location
     with no saved deck in it (G.deckEntries). Clicking one opens its cards
     in a slide-over; All deck cards is every card in every deck. */
  let tab = "decks";
  let selectedKey = null;   // the deck in the slide-over, while it's open
  let entries = [];         // G.deckEntries(), refreshed on every render
  const panel = UI.slideOver("deckPanel");
  const esc = G.esc;
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const finishCell = r => r.finish === "etched" ? '<span class="badge etched">ETCHED</span>'
    : r.finish === "foil" ? '<span class="badge foil">FOIL</span>' : '<span class="muted">—</span>';
  const locCell = e => e.location == null ? '<span class="warn">(location gone)</span>' : esc(e.location);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));

  function renderHdr() {
    const h = $("deckHdr");
    if (tab === "new") {
      const list = G.state.deckList;
      const cards = list.reduce((s, i) => s + i.qty, 0);
      h.textContent = list.length ? "— " + cards + " cards over " + list.length + " lines" : "— empty";
    } else if (tab === "cards") {
      const n = entries.reduce((s, e) => s + e.have, 0);
      h.textContent = "— " + plural(n, "card") + " in " + plural(entries.length, "deck");
    } else {
      h.textContent = "— " + plural(entries.length, "deck");
    }
  }

  let tabs;

  function render() {
    entries = G.deckEntries();
    $("decksCount").textContent = entries.length;
    renderDecks();
    renderCards();
    renderDetail();
    renderDeck();   // the New deck tab; also sets the header
  }

  function renderDecks() {
    const body = $("decksBody");
    if (!entries.length) {
      body.innerHTML = UI.emptyRow(5, { icon: "layout-grid", title: "No decks yet.",
        hint: "Build one on the New deck tab, or give a location the Deck Box type." });
      return;
    }
    const open = panel.isOpen();
    body.innerHTML = entries.slice().sort(byName).map(e =>
      '<tr class="click' + (open && e.key === selectedKey ? " sel" : "") + '" tabindex="0" data-key="' + esc(e.key) + '">' +
        '<td data-vs="' + esc(e.name) + '">' + esc(e.name) + "</td>" +
        '<td class="hide-sm" data-vs="' + esc(e.location || "") + '">' + locCell(e) + "</td>" +
        '<td class="num" data-v="' + e.have + '">' + e.have + (e.listed != null ? ' <span class="muted">/ ' + e.listed + "</span>" : "") + "</td>" +
        '<td class="num" data-v="' + e.value + '">' + G.money(e.value) + "</td>" +
        (!e.deck ? '<td class="num" data-v=""><span class="faint" title="No saved list to check against">—</span></td>'
          : '<td class="num" data-v="' + e.short + '">' + (e.short ? '<span class="short-tag">' + e.short + "</span>" : '<span class="ok-tag">none</span>') + "</td>") +
      "</tr>").join("");
    UI.reapplySorts($("paneDecks"));
  }

  // One card stack as an Inventory-style row: art (hover preview from the
  // thumbnail only), name, printing, finish, condition, qty, price, value.
  function stackRow(r, deckName) {
    const tr = document.createElement("tr");
    tr.className = "click";
    tr.innerHTML = UI.artThumbTd(r.imageUrl) +
      '<td class="card-name">' + UI.cardLink(r) + "</td>" +
      // The slide-over is narrow: set code and number, the full name on hover.
      (deckName == null
        ? '<td class="muted hide-sm" title="' + esc(G.recPrinting(r)) + '">' + esc(String(r.set || "").toUpperCase() + " #" + (r.collector || "")) + "</td>"
        : '<td class="muted hide-sm">' + esc(G.recPrinting(r)) + "</td>") +
      (deckName == null ? "" : '<td class="hide-sm">' + finishCell(r) + "</td>") +
      '<td class="hide-sm">' + esc(r.condition || "") + "</td>" +
      '<td class="num" data-v="' + r.quantity + '">' + r.quantity + (G.lentQty(r) ? ' <span class="muted">' + G.lentQty(r) + " lent</span>" : "") + "</td>" +
      '<td class="num hide-sm"' + (r.price == null ? ' data-v="">—' : ' data-v="' + r.price + '">' + G.money(r.price)) + "</td>" +
      (deckName == null ? "" : '<td class="num" data-v="' + (r.price == null ? "" : r.price * r.quantity) + '">' +
        (r.price == null ? "—" : G.money(r.price * r.quantity)) + "</td>" +
        "<td>" + deckName + "</td>");
    UI.wireArtHover(tr, r.imageUrl);
    tr.onclick = () => UI.reviewRecord(r);
    return tr;
  }

  function renderCards() {
    const body = $("deckCardsBody");
    const q = $("deckCardsSearch").value.trim().toLowerCase();
    const all = [];
    for (const e of entries) for (const r of e.stacks) all.push({ r, e });
    const rows = q ? all.filter(x => (x.r.name + " " + x.e.name).toLowerCase().includes(q)) : all;
    if (!rows.length) {
      body.innerHTML = UI.emptyRow(9, all.length ? { icon: "search", title: "No deck cards match that search." }
        : { icon: "layout-grid", title: "No cards in any deck yet.", hint: "Cards in a saved deck's location or a Deck Box location show here." });
      return;
    }
    rows.sort((a, b) => byName(a.e, b.e) || byName(a.r, b.r));
    body.innerHTML = "";
    for (const x of rows) body.appendChild(stackRow(x.r, esc(x.e.name)));
    UI.reapplySorts($("paneCards"));
  }

  /* -------- One deck's cards (slide-over) -------- */
  function renderDetail() {
    const box = $("deckDetail");
    const e = selectedKey ? entries.find(x => x.key === selectedKey) : null;
    if (!e) {
      box.innerHTML = "";
      detailShort = [];
      if (panel.isOpen()) panel.close();
      return;
    }
    // A save redraws the panel, which destroys the button that had focus;
    // put focus on the heading so it doesn't fall out to the page behind.
    const hadFocus = box.contains(document.activeElement);
    const facts = [e.location == null ? '<span class="warn">(location gone)</span>' : "In " + esc(e.location)];
    if (e.deck) {
      if (FORMAT_LABELS[e.deck.format]) facts.push(FORMAT_LABELS[e.deck.format]);
      facts.push("built " + esc(String(e.deck.createdAt).slice(0, 10)));
    } else facts.push("Deck Box location, no saved list");
    const sums = [e.listed != null ? e.have + " of " + e.listed + " cards" : plural(e.have, "card"), G.money(e.value)];
    if (e.deck) sums.push(e.short ? e.short + " missing" : "nothing missing");
    const costTxt = costNote(costToFinish(e.missing.filter(m => !isBasicLand(m.name)).map(m => ({ name: m.name, qty: m.short }))), "Cost to finish: ");
    if (costTxt) sums.push(costTxt);
    box.innerHTML =
      '<div class="sec-head"><h2 id="dpName" tabindex="-1">' + esc(e.name) + "</h2>" +
        (e.deck ? '<div class="toolbar"><button class="small danger" id="dpDelete">' + UI.icon("trash-2") + " Delete</button></div>" : "") +
      "</div>" +
      '<div style="font-size:13px">' + facts.join(" · ") + "</div>" +
      '<div class="muted" style="font-size:13px;margin-top:4px">' + sums.join(" · ") + "</div>" +
      (e.missing.length ? '<div class="toolbar" style="margin-top:10px"><button class="small" id="dpBuy" disabled title="Copies the ticked cards, then opens Manapool\'s paste-a-list page">' +
          UI.icon("external-link") + " Buy selected missing cards from Manapool</button></div>" +
        '<div id="dpBuyFallback" class="hint" hidden>Couldn\'t copy automatically. Copy this list, then paste it into Manapool\'s Mass Entry box:' +
          '<textarea id="dpBuyText" readonly rows="5" style="width:100%;margin-top:6px"></textarea></div>' : "") +
      '<div class="list-wrap" style="margin-top:12px"><table class="list" data-sort aria-label="Cards in this deck"><thead><tr>' +
        "<th>" + (e.missing.length ? '<input type="checkbox" id="dpTickAll" aria-label="Tick all missing cards" title="Tick all missing cards">' : '<span class="sr-only">Image</span>') +
        '</th><th>Card</th><th class="hide-sm">Printing</th><th class="hide-sm">Condition</th>' +
        '<th class="num">Qty</th><th class="num hide-sm">Price</th></tr></thead><tbody id="dpBody"></tbody></table></div>';
    const body = $("dpBody");
    if (!e.stacks.length && !e.missing.length) {
      body.innerHTML = UI.emptyRow(6, { icon: "layout-grid", title: "No cards in this deck yet." });
    }
    // Missing cards first: the list says more than the location holds.
    detailShort = e.missing.map(m => ({ name: m.name, qty: m.short }));
    pruneTicks("deck", detailShort);
    for (const m of e.missing.slice().sort(byName)) {
      const tr = document.createElement("tr");
      tr.className = "short";
      tr.innerHTML = "<td>" + tickHtml("deck", m.name) + "</td>" +
        '<td class="card-name">' + UI.cardNameLink(m.name) + " " + mpLink(m.name) + "</td>" +
        '<td class="hide-sm"><span class="muted">' + (m.have ? m.have + " of " + m.qty + " here" : "not here") + "</span></td>" +
        '<td class="hide-sm"></td><td class="num" data-v="' + -m.short + '"><span class="short-tag">short ' + m.short + "</span></td>" +
        costCell(m);
      body.appendChild(tr);
    }
    for (const r of e.stacks.slice().sort(byName)) body.appendChild(stackRow(r, null));
    if (e.deck) $("dpDelete").onclick = () => deleteSavedDeck(e);
    if (e.missing.length) {
      $("dpBuy").onclick = () => buySelected("deck");
      $("dpTickAll").onchange = ev => tickAll("deck", !!ev.target.checked);
      syncBuy("deck");
    }
    if (hadFocus) { try { $("dpName").focus(); } catch (err) {} }
  }

  function markSelectedRow() {
    const open = panel.isOpen();
    $("decksBody").querySelectorAll("tr[data-key]").forEach(tr => {
      tr.classList.toggle("sel", open && tr.dataset.key === selectedKey);
    });
  }
  function openDeck(key) {
    if (!entries.some(e => e.key === key)) return;
    if (key !== selectedKey) ticks.deck = new Set();
    selectedKey = key;
    renderDetail();
    panel.open();
    markSelectedRow();
  }
  function onPanelClosed() {
    const key = selectedKey;
    selectedKey = null;
    markSelectedRow();
    const tr = key && [...$("decksBody").querySelectorAll("tr[data-key]")].find(t => t.dataset.key === key);
    try { if (tr) tr.focus(); } catch (err) {}
  }

  // Only the saved list goes: the cards stay where they are (#309). A Deck
  // Box location is a deck by itself, so it stays under My decks; say so,
  // or Delete looks like it did nothing.
  async function deleteSavedDeck(e) {
    const loc = G.locById(e.locationId);
    let msg = 'Delete the saved deck "' + e.name + '"? Its cards stay where they are; only the saved list is removed.';
    if (G.isDeckBox(loc)) {
      msg += '\n\n"' + loc.name + '" is a Deck Box location, so it will still show under My decks (without a list) ' +
        "until you change its type or delete it.";
    }
    const ok = await UI.confirmDialog(msg, { title: "Delete deck?", danger: true });
    if (!ok || !G.deleteDeck(e.deck.id)) return;
    G.persist("Delete deck");
    render();
    UI.toast('Deleted the saved deck "' + e.name + '". Undo brings it back.', "ok");
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    const fmtSel = $("deckFormat");
    fmtSel.innerHTML = '<option value="">— any —</option>' + Object.keys(FORMAT_LABELS)
      .map(k => '<option value="' + k + '">' + FORMAT_LABELS[k] + "</option>").join("");
    fmtSel.value = deckFormat();
    fmtSel.onchange = () => {
      G.state.settings.deckFormat = fmtSel.value;
      legalError = "";
      G.persistSettings();
      renderDeck();
    };
    $("deckCardsSearch").addEventListener("input", renderCards);
    // Rows are redrawn on every change, so listen once on the tbody.
    const rowOf = e => e.target && e.target.closest ? e.target.closest("tr[data-key]") : null;
    $("decksBody").addEventListener("click", e => { const tr = rowOf(e); if (tr) openDeck(tr.dataset.key); });
    $("decksBody").addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = rowOf(e);
      if (!tr || e.target !== tr) return;
      e.preventDefault();
      openDeck(tr.dataset.key);
    });
    UI.onClose("deckPanel", onPanelClosed);
    // The tab is remembered (UI.pageTabs). First time on this device: a deck
    // list in progress opens New deck, else My decks. deck-list.html?tab=cards|new
    // picks a tab over all of that.
    let want = "";
    try { want = new URLSearchParams(location.search).get("tab") || ""; } catch (err) {}
    tabs = UI.pageTabs({ tabs: [
      { id: "decks", button: "tabDecks", panes: ["paneDecks"] },
      { id: "cards", button: "tabCards", panes: ["paneCards"] },
      { id: "new", button: "tabNew", panes: ["paneNew"] }
    ], def: G.state.deckList.length ? "new" : "decks", onShow: t => { tab = t; render(); } });
    if (["decks", "cards", "new"].includes(want)) tabs.show(want);
    $("deckAdd").onclick = addDeckLines;
    $("deckPrint").onclick = printDeck;
    $("deckClear").onclick = async () => {
      if (!G.state.deckList.length) return;
      const n = G.state.deckList.length;
      const ok = await UI.confirmDialog("Clear the deck list (" + n + " line" + (n === 1 ? "" : "s") + ")?",
        { title: "Clear deck list?", danger: true });
      if (!ok) return;
      G.state.deckList = [];
      G.persist("Clear deck list");
      renderDeck();
      UI.toast("Deck list cleared (" + n + " line" + (n === 1 ? "" : "s") + "). Undo restores it.", "ok");
    };
    $("deckBuild").onclick = buildDeck;
    $("deckGot").onclick = gotDeck;
    $("modeBuild").onclick = () => setMode("build");
    $("modeGot").onclick = () => setMode("got");
    $("deckBuy").onclick = () => buySelected("preview");
    $("deckTickAll").onchange = e => tickAll("preview", !!e.target.checked);
    $("deckBody").addEventListener("change", e => { onTickChange("preview", e); onGotChange(e); });
    $("deckBody").addEventListener("click", e => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-retry]") : null;
      if (!b) return;
      dropFailedLookups(b.dataset.retry);
      renderDeck();
    });
    // A lookup that finished while a picker was focused redraws once it is let go.
    for (const t of ["focusin", "pointerdown", "keydown"]) $("deckBody").addEventListener(t, () => { if (!refocusing) pickSettled = false; });
    $("deckBody").addEventListener("focusout", () => { if (lookupHeld) redrawAfterLookup(); });
    $("deckDetail").addEventListener("change", e => onTickChange("deck", e));
    // The preview plans for the chosen destination (#117), so a new pick
    // redraws it (renderDeck also shows/hides the new-name box).
    $("deckDest").onchange = renderDeck;

    // A burst of change events (a bulk edit, a merged save) redraws once,
    // as Statistics does (#118).
    G.on("change", G.debounce(render, 150));
    // Copies on a fetched Manapool order with no pick list yet are sold
    // (#107), so Build never moves them (rule B), same as Listings. Until
    // the cache answers (or if it can't), pick lists alone count.
    G.loadManapoolOrders().then(orders => { if (orders.length) render(); }, () => {});
  });
})();
