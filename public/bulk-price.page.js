
"use strict";
(function () {
  const G = window.G, UI = window.UI;
  // This script shares Listings with listings.page.js, which owns these ids; the
  // Pricing pane's copies are prefixed "bp_" in the markup.
  const SHARED = new Set("btnEvaluate btnNewRule btnPushMp planAll planBody planHdr planMore planMoreBtn planRule planSearch planShowAll rmCancel rmCriteria rmCriterionCount rmDelete rmName rmPriority rmSave rmTitle ruleModal rulesHdr rulesList".split(" "));
  const $ = id => UI.$(SHARED.has(id) ? "bp_" + id : id);

  let draftCriteria = G.newCriteriaBox();
  let editRuleId = "";     // "" while creating a new rule
  let plan = [];

  /* ============================== Rule list ============================== */
  const BASIS_SHORT = {
    market: "Scryfall market", mpLow: "Manapool lowest", mpMarket: "Manapool market",
    vTcg: "TCGplayer", vCk: "Card Kingdom", vMp: "Manapool (daily)", vHigh: "highest vendor", vLow: "lowest vendor"
  };
  function modeText(r) {
    if (r.mode === "exclude") return "excluded";
    if (r.mode === "fixed") return "fixed " + G.money(r.fixed);
    const base = BASIS_SHORT[r.basis] || "Scryfall market";
    if (r.mode === "delta") return base + " " + (r.delta >= 0 ? "+ " : "− ") + G.money(Math.abs(r.delta));
    return Math.round(r.percent * 100) + "% of " + base;
  }

  function fillRuleSelect(sel, allLabel) {
    const prev = sel.value;
    const rules = G.state.priceRules.slice().sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="">' + allLabel + '</option>' +
      rules.map(r => '<option value="' + r.id + '">' + G.esc(r.name || "(unnamed rule)") +
        (r.on ? "" : " (off)") + "</option>").join("");
    sel.value = rules.some(r => r.id === prev) ? prev : "";
  }
  function renderRuleSelect() {
    fillRuleSelect($("planRule"), "All rules (auto, by priority)");
    fillRuleSelect($("schRule"), "All active rules (auto, by priority)");
  }

  function renderRulesList() {
    const rules = G.state.priceRules.slice().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    $("rulesHdr").textContent = rules.length ? "— " + rules.length + " rule" + (rules.length === 1 ? "" : "s") : "";
    renderRuleSelect();
    const host = $("rulesList");
    if (!rules.length) {
      host.innerHTML = UI.emptyBlock({ icon: "money", title: "No rules yet.",
        hint: "Until you add one, this page has nothing to price. Nothing is touched by default." });
      return;
    }
    host.innerHTML = "";
    for (const r of rules) {
      const hasAny = G.criteriaConditions(r.criteria).some(c => c.on);
      const div = document.createElement("div");
      div.className = "loc-card";
      if (!r.on) div.style.opacity = ".55";
      div.innerHTML =
        '<div class="ln">' + G.esc(r.name || "(unnamed rule)") +
          '<span class="pill' + (r.on ? " on" : " off") + '">' + (r.on ? "on" : "off") + "</span>" +
          '<span class="pill">priority ' + r.priority + '</span>' +
          '<span class="pill">' + G.esc(modeText(r)) + '</span>' +
        "</div>" +
        (hasAny
          ? '<div class="rules"><code>' + G.esc(G.criteriaExpressionText(r.criteria)) + "</code></div>"
          : '<div class="rules faint">Catch-all — matches every stack.</div>') +
        '<div class="lacts">' +
          '<button class="small" data-act="edit">Edit</button>' +
          '<button class="small ghost" data-act="toggle">' + (r.on ? "Disable" : "Enable") + '</button>' +
          '<button class="small ghost" data-act="del">Delete</button>' +
        "</div>";
      div.querySelector('[data-act="edit"]').onclick = () => openRuleModal(r.id);
      div.querySelector('[data-act="toggle"]').onclick = () => toggleRule(r.id);
      div.querySelector('[data-act="del"]').onclick = () => deleteRule(r.id);
      host.appendChild(div);
    }
  }

  function toggleRule(id) {
    const r = G.state.priceRules.find(x => x.id === id);
    if (!r) return;
    r.on = !r.on;
    G.logAudit({ action: "price-rule", note: 'Price rule "' + (r.name || "(unnamed rule)") + '" switched ' + (r.on ? "on" : "off") });
    G.persist();
    renderRulesList();
  }

  async function deleteRule(id) {
    const r = G.state.priceRules.find(x => x.id === id);
    if (!r) return;
    const ok = await UI.confirmDialog('Delete price rule "' + (r.name || "(unnamed rule)") + '"?', { title: "Delete rule?", danger: true });
    if (!ok) return;
    G.state.priceRules = G.state.priceRules.filter(x => x.id !== id);
    G.logAudit({ action: "price-rule", note: 'Deleted price rule "' + (r.name || "(unnamed rule)") + '"' });
    G.persist();
    renderRulesList();
    UI.toast("Rule deleted. Undo brings it back.", "ok");
  }

  /* ============================== Condition editor (shared with listings.html / locations.html) ============================== */
  function updateCriteriaBadge() {
    const all = G.criteriaConditions(draftCriteria);
    const on = all.filter(c => c.on).length;
    $("rmCriterionCount").textContent = all.length
      ? on + " of " + all.length + " condition" + (all.length === 1 ? "" : "s") + " active" : "";
  }
  function renderCriteria() {
    G.renderCriteriaBuilder($("rmCriteria"), draftCriteria, updateCriteriaBadge, { pricing: true });
    updateCriteriaBadge();
  }

  /* ============================== Mode value area ============================== */
  function basisSelectHtml(current) {
    return '<label>Base price <select id="rmBasis">' + G.PRICE_BASES.map(b =>
      '<option value="' + b.key + '"' + (b.key === current ? " selected" : "") + ">" + G.esc(b.label) + "</option>").join("") +
      "</select></label>";
  }

  function renderValueArea(basisOverride) {
    const mode = $("rmMode").value;
    const basis = basisOverride || ($("rmBasis") ? $("rmBasis").value : "market");
    const host = $("rmValueArea");
    if (mode === "percent") {
      host.innerHTML = '<div class="fields" style="grid-template-columns:220px 1fr 1fr">' +
        '<label>Ask price = base price × <input id="rmPercent" type="number" min="0" step="1" value="100"> %</label>' +
        basisSelectHtml(basis) +
        '<div class="hint" style="align-self:end;margin:0">100 charges exactly the base price; 90 asks 10% under.</div>' +
        "</div>";
    } else if (mode === "delta") {
      host.innerHTML = '<div class="fields" style="grid-template-columns:260px 1fr 1fr">' +
        '<label>Ask price = base price plus/minus $ <input id="rmDelta" type="number" step="0.01" value="0"></label>' +
        basisSelectHtml(basis) +
        '<div class="hint" style="align-self:end;margin:0">Negative undercuts the base by a flat amount, e.g. -0.25.</div>' +
        "</div>";
    } else if (mode === "fixed") {
      host.innerHTML = '<div class="fields" style="grid-template-columns:220px 1fr">' +
        '<label>Ask price = $ <input id="rmFixed" type="number" min="0" step="0.01" value="1.00"></label>' +
        '<div class="hint" style="align-self:end;margin:0">Ignores market price entirely - useful for a bulk box.</div>' +
        "</div>";
    } else {
      host.innerHTML = '<div class="hint" style="margin:0">Matched stacks are left exactly as they are - no ask ' +
        "price is set or changed. Use a higher priority than the rule you want to carve an exception out of.</div>";
    }
  }

  /* ============================== Add / edit rule modal ============================== */
  function openRuleModal(id) {
    editRuleId = id || "";
    const r = id ? G.state.priceRules.find(x => x.id === id) : null;
    $("rmTitle").textContent = r ? "Edit " + (r.name || "rule") : "New price rule";
    $("rmName").value = r ? r.name : "";
    $("rmPriority").value = r ? r.priority : 0;
    $("rmMode").value = r ? r.mode : "percent";
    renderValueArea(r ? r.basis : "market");
    if (r) {
      if (r.mode === "percent" && $("rmPercent")) $("rmPercent").value = Math.round(r.percent * 100);
      if (r.mode === "delta" && $("rmDelta")) $("rmDelta").value = r.delta;
      if (r.mode === "fixed" && $("rmFixed")) $("rmFixed").value = r.fixed;
    }
    $("rmDelete").hidden = !r;
    draftCriteria = G.normalizeCriteriaBox(r && r.criteria);
    renderCriteria();
    UI.showModal("bp_ruleModal", "bp_rmName");
  }

  function saveRule() {
    const name = $("rmName").value.trim();
    if (!name) { UI.toast("Give the rule a name.", "err"); return; }
    const mode = $("rmMode").value;
    const draft = G.normalizePriceRule({
      id: editRuleId || undefined,
      on: true,
      name,
      priority: parseInt($("rmPriority").value, 10) || 0,
      mode,
      basis: (mode === "percent" || mode === "delta") && $("rmBasis") ? $("rmBasis").value : "market",
      percent: mode === "percent" ? (parseFloat($("rmPercent").value) || 0) / 100 : 1,
      delta: mode === "delta" ? (parseFloat($("rmDelta").value) || 0) : 0,
      fixed: mode === "fixed" ? (parseFloat($("rmFixed").value) || 0) : null,
      criteria: draftCriteria
    });
    const existing = editRuleId ? G.state.priceRules.find(x => x.id === editRuleId) : null;
    if (existing) {
      draft.on = existing.on;
      Object.assign(existing, draft);
      G.logAudit({ action: "price-rule", note: 'Edited price rule "' + name + '"' });
    } else {
      G.state.priceRules.push(draft);
      G.logAudit({ action: "price-rule", note: 'Created price rule "' + name + '"' });
    }
    G.persist();
    UI.hideModal("bp_ruleModal");
    renderRulesList();
    UI.toast("Saved.", "ok");
  }

  /* ============================== Evaluate / apply ==============================
     The last computed plan (#99). It is rebuilt only by renderPlan():
     Evaluate, the rule picker, and a real change (apply, push, backfill).
     The filter box and "Show unchanged too" only re-filter it
     (renderPlanRows). Ticks are kept by stack id, as on Listings (#97), so
     Apply and Push take every ticked row matching the filter, including
     rows past the drawn limit, and a redraw doesn't re-tick rows you left
     out. */
  let view = G.planView([], () => "");
  let rowCap = G.PLAN_ROW_CAP;
  const unticked = new Set();
  // #228: an excluded, $0.00 or unbased listing carries the market x % ask,
  // so it can be pushed like any other; only "no price at all" can't.
  const canPick = p => p.target != null;

  function renderPlan() {
    const ruleId = $("planRule").value;
    // Always evaluated in full - "Show unchanged too" is purely a display
    // filter from here on, not something the engine call has to redo, so the
    // header counts (in particular "waiting on price data") stay accurate
    // and visible even while the table itself is hiding those rows.
    const everything = G.bulkPricePlan({ includeUnchanged: true, ruleId: ruleId || null });
    view = G.planView(everything, p => p.record.name + " " + p.record.set + " " + p.record.setName);
    const up = everything.filter(p => p.delta > 0).length, down = everything.filter(p => p.delta < 0).length;
    const excluded = everything.filter(p => p.excluded).length;
    const noBasis = everything.filter(p => p.noBasis).length;
    const zero = everything.filter(p => p.zero).length;
    const scope = ruleId ? ' — rule "' + $("planRule").selectedOptions[0].textContent + '" only' : "";
    const noPrice = everything.filter(p => p.target == null).length;
    const toDelist = everything.filter(p => p.delist).length;
    $("planHdr").textContent = "— " + up + " to raise, " + down + " to lower, " +
      (toDelist ? toDelist + " to delist (below minimum profit), " : "") +
      (noBasis ? noBasis + " waiting on price data, " : "") +
      (zero ? zero + " at $0.00 under their rule, " : "") +
      (excluded ? excluded + " excluded, " : "") +
      (noPrice ? noPrice + " with no price at all, " : "") + everything.length + " row(s) total" + scope;

    let hint = "";
    // Asks are live (#228): picking a rule here only narrows the plan to the
    // listings that rule prices, so a switched-off rule shows nothing.
    const picked = ruleId ? G.state.priceRules.find(r => r.id === ruleId) : null;
    if (picked && !picked.on) {
      hint += '<div class="hint" style="margin-top:0">This rule is switched off, so it prices nothing. ' +
        'Switch it on in the list above to see the listings it would price.</div>';
    }
    if (noBasis) {
      hint += warnBox('<b>' + noBasis + ' stack(s)</b> are claimed by a rule but have no price to work from yet, so the rule is <b>not being applied</b> to them: ' +
        'they would go out at plain market price (times the condition %) instead. ' +
        '<button class="small" id="bpRefreshPrices">Refresh prices</button> then Evaluate again. ' +
        '<a href="/help.html#bulk-price-fallback">More in Help</a>');
    }
    if (zero) hint += zeroHint(zero);
    if (toDelist) {
      hint += warnBox('<b>' + toDelist + ' stack(s)</b> would sell ' + G.esc(G.minProfitWords()) + ', so <b>Never list below my minimum profit</b> takes those listings down when you push. ' +
        '<a href="/help.html#bulk-price-no-loss">More in Help</a>');
    }
    $("planHint").innerHTML = hint;
    const rp = $("bpRefreshPrices");
    if (rp) rp.onclick = async () => {
      rp.disabled = true;
      UI.toast("Refreshing prices from the server's card database…", "work");
      try {
        const out = await G.refreshPrices(msg => UI.toastProgress(msg));
        UI.toast("Refreshed prices for " + out.updated + " of " + out.rows + " stack(s). Evaluating again.", "ok");
        renderPlan();
      } catch (e) {
        UI.toast("Refresh failed: " + e.message, "err");
        rp.disabled = false;
      }
    };
    renderPlanRows();
  }

  // A short warning box for the plan header; the background is in Help.
  const warnBox = html => '<div class="callout warn" style="margin-top:0"><span class="cico">' + UI.icon("triangle-alert") +
    '</span><div class="cbody">' + html + '</div></div>';

  const isChange = p => p.delist || p.target != null && !(p.current != null && Math.abs(p.current - p.target) < 0.005);

  // Why a line's ask is the market x condition % fallback (#228).
  const fallbackWhy = p => p.excluded ? "An exclude rule claims it"
    : p.zero ? "Its rule works out to $0.00 or less" : "Its rule has no base price to work from yet";

  // The Ask cell holds a word when there is no price at all: that sorts as
  // blank, below every real price.
  const targetSortKey = p => (p.target == null ? "" : p.target);
  /* Sort key per Evaluate column, by column index, matching what each cell
     shows. A column sort orders the whole filtered plan with these
     (UI.dataSort), so the first 500 drawn rows are the top of the real
     order, not a sort of whichever 500 happened to be drawn. */
  const PLAN_SORT_KEYS = {
    2: p => p.record.name,
    3: p => G.recPrinting(p.record) + (p.record.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[p.record.finish].toLowerCase() : ""),
    4: p => G.CONDITION_NAMES[p.record.condition] || p.record.condition || "",
    5: p => p.record.quantity,
    6: p => p.record.listedQty || 0,
    7: p => p.market == null ? null : Number(p.market),
    8: p => p.current == null ? null : Number(p.current),
    9: p => p.rule ? p.rule.name : null,
    10: p => { const k = targetSortKey(p); return k === "" ? null : Number(k); },
    11: p => p.delta
  };

  function renderPlanRows() {
    const showAll = $("planShowAll").checked;
    const matching = view.filter($("planSearch").value);
    plan = showAll ? matching : matching.filter(isChange);
    const sort = UI.sortStateOf($("planBody").closest("table"));
    if (sort && PLAN_SORT_KEYS[sort.col]) plan = G.sortRows(plan, PLAN_SORT_KEYS[sort.col], sort.dir);
    const full = showAll ? view.lines : view.lines.filter(isChange);

    const body = $("planBody");
    syncPlanAll();
    UI.planMoreNote($("planMore"), plan.length, rowCap);
    if (!plan.length) {
      body.innerHTML = full.length
        ? UI.emptyRow(12, { icon: "search", title: "No stacks match that filter." })
        : UI.emptyRow(12, { icon: "money", title: "Nothing to price yet.",
            hint: 'Add a rule above, or tick "Show unchanged too".' });
      return;
    }
    body.innerHTML = plan.slice(0, rowCap).map((p, i) => {
      const rec = p.record;
      return '<tr class="click' + (p.excluded || p.delist ? ' short' : '') + '">' +
        UI.artThumbTd(rec.imageUrl) +
        "<td>" + (canPick(p) ? '<input type="checkbox" class="ppick" data-i="' + i + '"' +
          (unticked.has(rec.id) ? "" : " checked") + ' aria-label="Include this row">' : "") + "</td>" +
        '<td class="card-name">' + UI.cardLink(rec) + "</td>" +
        '<td class="muted hide-sm">' + G.esc(G.recPrinting(rec)) + (rec.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[rec.finish].toLowerCase() : "") + "</td>" +
        '<td class="hide-sm">' + G.esc(G.CONDITION_NAMES[rec.condition] || rec.condition || "") + "</td>" +
        '<td class="num hide-sm">' + rec.quantity + "</td>" +
        '<td class="num">' + (rec.listedQty || 0) + "</td>" +
        '<td class="num hide-sm">' + G.money(p.market) + "</td>" +
        '<td class="num">' + (p.current == null ? '<span class="muted">—</span>' : G.money(p.current)) + "</td>" +
        '<td class="hide-sm">' + (p.excluded ? '<span class="pill">excluded</span>'
          : p.rule ? G.esc(p.rule.name) : '<span class="muted">—</span>') + "</td>" +
        '<td class="num" data-v="' + targetSortKey(p) + '"' + (p.rule && !p.fallback && p.rule.mode !== "fixed" && p.rule.mode !== "exclude"
          ? ' title="based on ' + G.esc(BASIS_SHORT[p.rule.basis] || "Scryfall market") + ": " +
            (p.basisVal == null ? "no price on file" : G.esc(G.money(p.basisVal))) + '"' : "") + ">" +
          (p.target == null ? '<span class="muted" title="No market price on file either, so there is nothing to send">no price</span>'
          : p.delist ? '<span class="pill">Delist (below minimum profit)</span><div class="muted" style="font-size:.85em">ask ' + G.money(p.target) + ", cost " + G.money(p.cost) + ", profit " + G.pct(p.pct) + "</div>"
          : G.money(p.target) + (p.fallback ? '<div class="muted" style="font-size:.85em" title="' +
            G.esc(fallbackWhy(p)) + ', so this listing goes out at its market price times the condition % on Listings\' Rules tab">market × %</div>' : "")) + "</td>" +
        '<td class="num">' + (p.delta == null ? "" : (p.delta > 0 ? "+" : "") + p.delta.toFixed(2)) + "</td>" +
        "</tr>";
    }).join("");
    body.querySelectorAll(".ppick").forEach(c => {
      c.addEventListener("change", () => {
        const line = plan[Number(c.dataset.i)];
        if (!line) return;
        if (c.checked) unticked.delete(line.record.id); else unticked.add(line.record.id);
        syncPlanAll();
      });
    });
    body.querySelectorAll("tr").forEach((tr, i) => {
      const p = plan[i];
      if (!p) return;
      UI.wireArtHover(tr, p.record.imageUrl);
      tr.onclick = e => { if (e.target.closest("input")) return; UI.reviewRecord(p.record); };
    });
    UI.reapplySorts();
  }

  // The header box reflects the tickable rows matching the filter.
  function syncPlanAll() {
    const all = $("planAll");
    const pickable = plan.filter(canPick);
    const on = pickable.filter(p => !unticked.has(p.record.id)).length;
    all.checked = pickable.length > 0 && on === pickable.length;
    all.indeterminate = on > 0 && on < pickable.length;
  }

  // The ticked lines from the CURRENT filtered plan, by stack id rather than
  // by whatever checkboxes happen to be drawn.
  const tickedLines = () => plan.filter(p => canPick(p) && !unticked.has(p.record.id));

  /* The plan is kept between real changes (#99), but stacks can change under
     it without this page rebuilding it (an undo, another device's save merged
     in). Rebuild from live data right before Apply or Push and go ahead only
     if the ticked rows, their target prices and whether each is listed are
     unchanged; otherwise show the fresh plan and stop. Push still reads
     Manapool's live quantities itself, so this guards the price it sends. */
  function planStillCurrent() {
    const sig = () => G.planFingerprint(tickedLines(), p => ((p.record.listedQty || 0) > 0 ? 1 : 0) + (p.delist ? ":delist" : ""));
    const before = sig();
    renderPlan();
    if (sig() === before) return true;
    UI.toast("Your stacks changed since this plan was built, so it has been rebuilt with the current numbers. " +
      "Check it, then press again. Nothing was pushed.", "err");
    return false;
  }

  /* No card "Apply" any more (#228): a listing's ask is worked out live from
     the rules, so there is nothing to save locally. Push is the only action. */
  // A $0.00 rule price is never sent (#98): Manapool can't take a zero price,
  // so it would keep its old one while the push reported success. Since
  // #228 those listings go out at market x condition % instead.
  const zeroHint = n => warnBox('<b>' + n + ' stack(s)</b> work out to <b>$0.00</b> under their rule, which Manapool cannot take. ' +
    'They go out at market × % instead. <a href="/help.html#bulk-price-fallback">More in Help</a>');


  /* ============================== Push to Manapool ============================== */
  // Progress in listings, not batches (#480): "Pushing 1,200 of 7,419
  // listings to Manapool…" with the toast's bar. One batch: just the count.
  function pushProgress(sent, total, nBatches, noun) {
    const words = n => noun + (n === 1 ? "" : "s");
    if (nBatches > 1) UI.toastProgress("Pushing " + sent.toLocaleString() + " of " + total.toLocaleString() + " " + words(total) +
      " to Manapool…", sent, total);
    else UI.toastProgress("Pushing " + total + " " + words(total) + " to Manapool…");
  }
  // Listings left out because Manapool already showed that quantity and price (#482).
  const upToDateNote = n => (n ? " " + n.toLocaleString() + " " + (n === 1 ? "was" : "were") + " already up to date on Manapool." : "");

  async function pushToManapool() {
    const pushable = () => tickedLines().filter(p => p.target != null && (p.record.listedQty || 0) > 0);
    let picks = pushable();
    const skippedUnlisted = tickedLines().length - picks.length;
    if (!picks.length) {
      UI.toast(skippedUnlisted
        ? "None of the ticked rows are currently listed on Manapool - there is nothing to push a price onto."
        : "Nothing is ticked.", "err");
      return;
    }
    const delistCount = new Set(picks.filter(p => p.delist).map(p => p.key)).size;
    const priceCount = picks.filter(p => !p.delist).length;
    const proceed = await UI.confirmDialog((delistCount
      ? "Take " + delistCount + " listing(s) under your minimum profit down on Manapool" + (priceCount ? " and push a new price for " + priceCount + " listing(s)" : "") + "? " +
        "A listing taken down stays down until you list it again from Listings. "
      : "Push a new price for " + picks.length + " listing(s) to Manapool? ") +
      "Quantity is never raised: each listing keeps the quantity Manapool shows right now, or goes lower if fewer copies " +
      "are free to sell here (copies sold to a Manapool order that isn't picked yet don't count)" +
      (skippedUnlisted ? ". " + skippedUnlisted + " ticked row(s) are not currently listed and will be skipped" : "") + ".",
      delistCount ? { title: "Delist and push live prices to Manapool?", danger: true } : { title: "Push live prices to Manapool?" });
    if (!proceed) return;
    if (!planStillCurrent()) return;
    picks = pushable();

    // Manapool's write endpoint SETS quantity alongside the price, so a price
    // push has to send one. It used to send the local listedQty total, which
    // is stale whenever something sold since the last Fetch listings - and
    // that put a sold copy back up for sale (#86). Read what Manapool lists
    // right now, just before pushing, and never send more than that or than
    // the copies on hand that aren't already sold to an open order.
    UI.toastProgress("Reading your current Manapool listings…");
    // The same read also tells which listings are already right (#482).
    let live;
    try {
      live = G.manapoolLiveListings((await G.api("/api/manapool/listings")).listings);
    } catch (e) {
      UI.toastProgress("");
      UI.toast("Couldn't read your current Manapool listings, so nothing was pushed: " + e.message, "err");
      return;
    }
    UI.toastProgress("");

    // Same grouping problem Listings' push has: Manapool identifies a listing by
    // (scryfall_id, language, finish, condition) with no location, and its write
    // endpoint SETS quantity - so every row sharing an identity is pushed once.
    // Every row of one listing carries the listing's one live ask (#228), so
    // the first ticked row's target is the listing's.
    // Copies on a fetched order with no pick list yet are sold too (#107).
    // The live quantity above already caps the push, so a cache that can't
    // be read only means pick lists alone are held back.
    try { await G.loadManapoolOrders(); } catch (e) { /* see above */ }
    const reserved = G.manapoolReservations();
    const groups = new Map();
    let notOnManapool = 0;
    for (const line of picks) {
      const key = G.manapoolIdentityKey(line.record);
      if (groups.has(key)) { if (groups.get(key)) groups.get(key).lines.push(line); continue; }
      const liveQty = (live.get(key) || { quantity: 0 }).quantity;
      // Nothing listed on Manapool any more (sold out, or delisted there):
      // there is no listing to put a price on, and a price push never
      // creates one.
      if (!liveQty) { notOnManapool++; groups.set(key, null); continue; }
      // Under the minimum profit (#378, #390): the same write Delist unprofitable sends.
      groups.set(key, line.delist
        ? { sample: line.record, price: null, qty: 0, delist: true, lines: [line] }
        : { sample: line.record, price: line.target, qty: G.pricePushQuantity(key, liveQty, reserved), lines: [line] });
    }
    for (const [key, g] of [...groups]) if (!g) groups.delete(key);
    if (!groups.size) {
      UI.toast("None of the ticked listings are on Manapool right now (they may have sold) - nothing was pushed.", "err");
      return;
    }

    // Only what changes is sent (#482): a listing Manapool already shows at
    // this quantity and price counts as landed without a request.
    const allKeys = [...groups.keys()];
    const toSend = G.splitManapoolPush(allKeys, allKeys.map(key => {
      const g = groups.get(key);
      return { card: g.sample, quantity: g.qty, price: g.price, condition: g.sample.condition };
    }), live);
    const { keys, entries, upToDate } = toSend;
    // Whatever Manapool confirms becomes the local listed count, so local
    // matches Manapool again (it can only have gone down - see above).
    // The price that landed becomes the listing's "last sent" price on every
    // stack of it (#98, #228), so "On Manapool" shows what is live and
    // Evaluate stops offering the same change. Already-right listings
    // start out landed.
    const landed = upToDate.map(u => ({ key: u.key, quantity: u.quantity }));
    const recordLanded = () => {
      const sent = [];
      const downKeys = new Set();
      for (const s of landed) {
        if (groups.get(s.key).delist) { downKeys.add(s.key); continue; }
        G.applyManapoolQuantity(s.key, s.quantity, "Manapool price push", reserved);
        const g = groups.get(s.key);
        const l0 = g.lines[0];
        sent.push({ key: s.key, price: g.price, note: "Manapool price push: " + (l0.fallback ? "market x condition %"
          : "rule \"" + (l0.rule ? l0.rule.name : "?") + "\"") });
      }
      if (downKeys.size) G.applyDelistUnprofitable(downKeys, "Bulk Price push, under minimum profit");
      G.recordManapoolAsks(sent, "Manapool price push");
      if (landed.length) { G.persist("Manapool price push"); renderPlan(); }
      landed.length = 0;
    };

    // Same batching Listings' push does - see the comment there.
    const BATCH = G.MANAPOOL_BATCH_SIZE || 100;
    const batches = [];
    for (let start = 0; start < entries.length; start += BATCH) batches.push(entries.slice(start, start + BATCH));

    let ok = 0, delisted = 0, failed = [];
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      pushProgress(b * BATCH, entries.length, batches.length, "listing");
      let out;
      try {
        out = await G.api("/api/manapool/list-bulk", { method: "POST", body: { items: batch } });
      } catch (e) {
        for (const entry of batch) failed.push({ key: G.manapoolIdentityKey(entry.card), error: e.message });
        continue;
      }
      out.results.forEach((r, j) => {
        const key = keys[b * BATCH + j];
        // Only a reply showing exactly 0 counts as down.
        if (r.ok && groups.get(key).delist && r.quantity !== 0) {
          failed.push({ key, error: r.quantity == null ? "Manapool did not confirm the delist." : "Manapool still shows " + r.quantity + " listed after the delist." });
        } else if (r.ok) {
          if (groups.get(key).delist) delisted++; else ok++;
          landed.push({ key, quantity: r.quantity != null ? r.quantity : batch[j].quantity });
        } else failed.push({ key, error: r.error });
      });
      // Confirm this batch actually landed before starting the next one -
      // if everything in it failed, the rest are almost certainly going to
      // fail the same way, so stop instead of burning through them blind.
      if (out.succeeded === 0 && batch.length > 0 && batches.length > 1) {
        recordLanded();
        UI.toast("Stopped after batch " + (b + 1) + "/" + batches.length +
          " - every price push in it failed (" + (out.results[0] && out.results[0].error || "unknown error") +
          "). Fix the issue and push the rest again." + upToDateNote(upToDate.length), "err");
        UI.toastProgress("");
        return;
      }
    }
    UI.toastProgress("");
    recordLanded();
    const detail = batches.length > 1 && failed.length
      ? "Sent in " + batches.length + " batch(es) of up to " + BATCH + " listing(s) each, each confirmed before the next was sent." +
        "\n\nFailures:\n" + failed.slice(0, 10).map(f => "• " + f.error).join("\n") +
        (failed.length > 10 ? "\n… and " + (failed.length - 10) + " more" : "")
      : (failed.length ? failed[0].error : "");
    const delistGroups = [...groups.values()].filter(g => g.delist).length;
    UI.toast((delistGroups ? "Delisted " + delisted + "/" + delistGroups + " listing(s) under your minimum profit. " : "") +
      (entries.length ? "Pushed " + ok + "/" + (groups.size - delistGroups) + " price(s) to Manapool" +
        (batches.length > 1 ? " across " + batches.length + " batches" : "") + "." : "Nothing needed sending to Manapool.") +
      upToDateNote(upToDate.length) +
      (failed.length ? " " + failed.length + " failed." : "") +
      (notOnManapool ? " " + notOnManapool + " skipped: no longer listed on Manapool." : ""),
      failed.length ? "err" : "ok", detail || undefined);
  }

  // Plain-words reason the Push buttons are greyed out.
  function setWhyOff(why) {
    document.querySelectorAll(".mp-why-off").forEach(el => { el.textContent = why; el.hidden = !why; });
    for (const id of ["btnPushMp", "spBtnPushMp"]) {
      const b = $(id);
      if (!b) continue;
      if (why) { if (b.dataset.t == null) b.dataset.t = b.title; b.title = why; }
      else if (b.dataset.t != null) b.title = b.dataset.t;
    }
  }

  async function refreshManapoolButton() {
    try {
      const d = await G.api("/api/integrations");
      const on = !!(d.manapool.featureOn && d.manapool.hasToken);
      // #499: another tool manages this seller's listings on Mana Pool.
      const other = on && !!d.manapool.otherInventoryApp;
      $("btnPushMp").disabled = !on || other;
      setWhyOff(other ? "Another app manages your Mana Pool listings, so Grimoire can't change them." : on ? "" : !d.manapool.featureOn
        ? "Manapool isn't switched on for this site" + (G.isAdmin ? " (set manapool.enabled in config.json and restart)." : "; ask the site admin.")
        : "Connect your Manapool account in Settings → Integrations first.");
      return on;
    } catch (e) { $("btnPushMp").disabled = true; setWhyOff("Couldn't check whether Manapool is connected."); return false; }
  }

  /* Best-effort, silent catch-up on load - see backfillAskPricesFromManapool
     in core.js for why some listed stacks have never had a local askPrice
     at all. A failed lookup (offline, Manapool down) just leaves those rows
     blank as before; nothing here is worth surfacing an error toast over. */
  //
  // It reads every page of your Manapool listings, so it only runs when
  // there's a row it hasn't tried yet (#98): rows a fetch couldn't fill
  // (listed here but not on Manapool) are remembered for this browser tab's
  // session, so coming back to the page doesn't refetch everything.
  const BACKFILL_TRIED_KEY = "grimoire.askBackfillTried";
  function readBackfillTried() {
    try { return new Set(JSON.parse(sessionStorage.getItem(BACKFILL_TRIED_KEY) || "[]")); } catch (e) { return new Set(); }
  }
  function saveBackfillTried(set) {
    try { sessionStorage.setItem(BACKFILL_TRIED_KEY, JSON.stringify([...set].slice(-20000))); } catch (e) { /* convenience only */ }
  }
  let backfillRan = false;
  async function backfillAskPrices() {
    if (backfillRan) return;   // at most once per page visit
    backfillRan = true;
    const tried = readBackfillTried();
    if (!G.askPriceBackfillPending(tried).length) return;
    try {
      const d = await G.api("/api/manapool/listings");
      const out = G.backfillAskPricesFromManapool(d.listings || []);
      for (const id of out.missed || []) tried.add(id);
      saveBackfillTried(tried);
      if (out.filled) { G.persist("Manapool ask-price backfill"); renderPlan(); }
    } catch (e) { /* best-effort - Manapool optional */ }
  }

  /* ============================== Schedule ============================== */
  function hourOptions() {
    const opts = [];
    for (let h = 0; h < 24; h++) {
      const label = h === 0 ? "12:00 AM" : h < 12 ? h + ":00 AM" : h === 12 ? "12:00 PM" : (h - 12) + ":00 PM";
      opts.push('<option value="' + h + '">' + label + "</option>");
    }
    return opts.join("");
  }
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function loadSchedule() {
    const s = Object.assign({ enabled: false, ruleId: "", frequency: "daily", hourLocal: 6, weekday: 1, autoPush: false },
      G.state.settings.bulkPriceSchedule || {});
    $("schEnabled").checked = !!s.enabled;
    $("schRule").value = G.state.priceRules.some(r => r.id === s.ruleId) ? s.ruleId : "";
    $("schFreq").value = s.frequency === "weekly" ? "weekly" : "daily";
    $("schHour").value = String(s.hourLocal);
    $("schWeekday").value = String(s.weekday);
    $("schAutoPush").checked = !!s.autoPush;
    $("bpAutoPushLoss").hidden = !G.state.settings.neverListAtLoss;
    $("schWeekdayWrap").hidden = $("schFreq").value !== "weekly";
    renderTzNote(s);
  }

  function tzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ""; }
  }

  function saveSchedule() {
    const s = {
      enabled: $("schEnabled").checked,
      ruleId: $("schRule").value,
      frequency: $("schFreq").value,
      hourLocal: parseInt($("schHour").value, 10) || 0,
      weekday: parseInt($("schWeekday").value, 10) || 0,
      autoPush: $("schAutoPush").checked,
      // Captured from THIS browser at save time so the server can run the
      // schedule at the hour the person setting it actually meant, instead
      // of the server's own (possibly different) time zone.
      tzOffsetMinutes: new Date().getTimezoneOffset(),
      tzName: tzName()
    };
    G.state.settings.bulkPriceSchedule = s;
    G.persistSettings();
    UI.setStatus("schStatus", "✓ Saved.", "ok");
    renderLastRun();
    renderTzNote(s);
  }

  function renderTzNote(s) {
    const el = $("schTzNote");
    if (!el) return;
    if (!Number.isFinite(Number(s.tzOffsetMinutes))) {
      el.textContent = "";
      return;
    }
    const here = new Date().getTimezoneOffset();
    el.textContent = "Runs at this hour in " + (s.tzName || "the time zone this was last saved from") +
      (here !== Number(s.tzOffsetMinutes) ? " - not this browser's current time zone." : ".");
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  async function renderLastRun() {
    try {
      const d = await G.api("/api/bulk-price/status");
      if (!d || !d.lastRunAt) { $("schLastRun").textContent = "This schedule has not run yet."; return; }
      const r = d.lastResult || {};
      let text = (d.manual ? "Last run (manual): " : "Last scheduled run: ") + fmtWhen(d.lastRunAt) + " — ";
      if (r.skipped) text += r.skipped + ".";
      else if (r.ok === false) text += "failed: " + (r.error || "unknown error");
      // #228: `changed` counts listings whose live ask differed from what
      // Manapool last got; an older run's result only has `repriced`.
      else text += (r.changed != null ? r.changed + " listing(s) with a new price" : (r.repriced || 0) + " stack(s) repriced") +
        (r.pushed ? ", " + r.pushed + " listing(s) pushed to Manapool" : "") +
        (r.pushFailed ? " (" + r.pushFailed + " push failure(s))" : "") +
        (r.delisted ? ", " + r.delisted + " listing(s) under the minimum profit delisted" : "") +
        (r.delistFailed ? " (" + r.delistFailed + " delist failure(s))" : "") +
        (r.delistLeft ? ", " + r.delistLeft + " listing(s) under the minimum profit left for the next run (limit 50 a run)" : "") +
        // Under the minimum profit but not taken down, e.g. Auto-push is off.
        (r.belowCost > (r.delisted || 0) + (r.delistFailed || 0) + (r.delistLeft || 0)
          ? ", " + (r.belowCost - (r.delisted || 0) - (r.delistFailed || 0) - (r.delistLeft || 0)) + " under the minimum profit and not delisted" : "") +
        (r.fallback ? ", " + r.fallback + " at market price x condition % because their rule gave no price" : "") +
        (r.noPrice ? ", " + r.noPrice + " skipped with no price at all" : "") +
        (r.zeroSkipped ? ", " + r.zeroSkipped + " left alone because their rule works out to $0.00" : "") + ".";
      $("schLastRun").textContent = text;
    } catch (e) { $("schLastRun").textContent = ""; }
  }

  async function runNow() {
    // Uses whatever schedule is actually saved server-side, not the
    // possibly-unsaved state of the form on screen - save first if the rule
    // (or anything else here) was just changed.
    const ruleOpt = $("schRule").options[$("schRule").selectedIndex];
    const ruleLabel = ruleOpt && ruleOpt.value ? 'the "' + ruleOpt.text.replace(/ \(off\)$/, "") + '" rule' : "all active rules";
    const ok = await UI.confirmDialog("Run the bulk price sweep right now, using the saved schedule's rule selection (" + ruleLabel + ")" +
      ($("schAutoPush").checked ? " - this will push updated prices to Manapool live" +
        (G.state.settings.neverListAtLoss ? " and take down up to 50 listings whose price would be under your minimum profit" : "") : "") + "?",
      { title: "Run sweep now?", danger: $("schAutoPush").checked });
    if (!ok) return;
    $("schRunNow").disabled = true;
    UI.toastProgress("Running…");
    try {
      await G.api("/api/bulk-price/run-now", { method: "POST" });
      UI.toastProgress("");
      UI.toast("Done. Reloading to pick up any changes made server-side…", "ok");
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      UI.toastProgress("");
      UI.toast("Run failed: " + e.message, "err");
      $("schRunNow").disabled = false;
    }
  }

  /* ============================== Sealed pricing ==============================
     A structurally separate rule engine from the card one above, not a
     shared criteria matcher over both - see core.js's own comment on
     sealedBulkPricePlan for why (an absent card field reads as "no
     opinion, matches" for most criteria kinds, which would let a sealed
     record wrongly match a card rule). Sealed rules only ever see sealed
     records. */
  let spEditRuleId = "";
  let spPlan = [];

  function spModeText(r) {
    if (r.mode === "exclude") return "excluded";
    if (r.mode === "fixed") return "fixed " + G.money(r.fixed);
    if (r.mode === "delta") return "market " + (r.delta >= 0 ? "+ " : "− ") + G.money(Math.abs(r.delta));
    return Math.round(r.percent * 100) + "% of market";
  }
  function spFilterText(r) {
    const parts = [];
    if (r.setCode) parts.push("set is " + r.setCode.toUpperCase());
    if (r.nameContains) parts.push('name contains "' + r.nameContains + '"');
    return parts.join(" and ");
  }

  function spFillRuleSelect(sel, allLabel) {
    const prev = sel.value;
    const rules = G.state.sealedPriceRules.slice().sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="">' + allLabel + '</option>' +
      rules.map(r => '<option value="' + r.id + '">' + G.esc(r.name || "(unnamed rule)") +
        (r.on ? "" : " (off)") + "</option>").join("");
    sel.value = rules.some(r => r.id === prev) ? prev : "";
  }

  function spRenderRulesList() {
    const rules = G.state.sealedPriceRules.slice().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    $("spRulesHdr").textContent = rules.length ? "— " + rules.length + " rule" + (rules.length === 1 ? "" : "s") : "";
    spFillRuleSelect($("spPlanRule"), "All rules (auto, by priority)");
    const host = $("spRulesList");
    if (!rules.length) {
      host.innerHTML = UI.emptyBlock({ icon: "orders", title: "No sealed pricing rules yet.",
        hint: "Until you add one, this section has nothing to price. Nothing is touched by default." });
      return;
    }
    host.innerHTML = "";
    for (const r of rules) {
      const filterText = spFilterText(r);
      const div = document.createElement("div");
      div.className = "loc-card";
      if (!r.on) div.style.opacity = ".55";
      div.innerHTML =
        '<div class="ln">' + G.esc(r.name || "(unnamed rule)") +
          '<span class="pill' + (r.on ? " on" : " off") + '">' + (r.on ? "on" : "off") + "</span>" +
          '<span class="pill">priority ' + r.priority + '</span>' +
          '<span class="pill">' + G.esc(spModeText(r)) + '</span>' +
        "</div>" +
        (filterText
          ? '<div class="rules"><code>' + G.esc(filterText) + "</code></div>"
          : '<div class="rules faint">Catch-all — matches every listed sealed item.</div>') +
        '<div class="lacts">' +
          '<button class="small" data-act="edit">Edit</button>' +
          '<button class="small ghost" data-act="toggle">' + (r.on ? "Disable" : "Enable") + '</button>' +
          '<button class="small ghost" data-act="del">Delete</button>' +
        "</div>";
      div.querySelector('[data-act="edit"]').onclick = () => spOpenRuleModal(r.id);
      div.querySelector('[data-act="toggle"]').onclick = () => spToggleRule(r.id);
      div.querySelector('[data-act="del"]').onclick = () => spDeleteRule(r.id);
      host.appendChild(div);
    }
  }

  function spToggleRule(id) {
    const r = G.state.sealedPriceRules.find(x => x.id === id);
    if (!r) return;
    r.on = !r.on;
    G.logAudit({ action: "sealed-edit", note: 'Sealed price rule "' + (r.name || "(unnamed rule)") + '" switched ' + (r.on ? "on" : "off") });
    G.persist();
    spRenderRulesList();
  }

  async function spDeleteRule(id) {
    const r = G.state.sealedPriceRules.find(x => x.id === id);
    if (!r) return;
    const ok = await UI.confirmDialog('Delete sealed price rule "' + (r.name || "(unnamed rule)") + '"?', { title: "Delete rule?", danger: true });
    if (!ok) return;
    G.state.sealedPriceRules = G.state.sealedPriceRules.filter(x => x.id !== id);
    G.logAudit({ action: "sealed-edit", note: 'Deleted sealed price rule "' + (r.name || "(unnamed rule)") + '"' });
    G.persist();
    spRenderRulesList();
    UI.toast("Rule deleted. Undo brings it back.", "ok");
  }

  function spRenderValueArea() {
    const mode = $("spRmMode").value;
    const host = $("spRmValueArea");
    if (mode === "percent") {
      host.innerHTML = '<div class="fields" style="grid-template-columns:260px 1fr">' +
        '<label>Ask price = market price × <input id="spRmPercent" type="number" min="0" step="1" value="100"> %</label>' +
        '<div class="hint" style="align-self:end;margin:0">100 charges exactly market price; 90 asks 10% under.</div>' +
        "</div>";
    } else if (mode === "delta") {
      host.innerHTML = '<div class="fields" style="grid-template-columns:300px 1fr">' +
        '<label>Ask price = market price plus/minus $ <input id="spRmDelta" type="number" step="0.01" value="0"></label>' +
        '<div class="hint" style="align-self:end;margin:0">Negative undercuts market by a flat amount, e.g. -1.00.</div>' +
        "</div>";
    } else if (mode === "fixed") {
      host.innerHTML = '<div class="fields" style="grid-template-columns:220px 1fr">' +
        '<label>Ask price = $ <input id="spRmFixed" type="number" min="0" step="0.01" value="1.00"></label>' +
        '<div class="hint" style="align-self:end;margin:0">Ignores market price entirely.</div>' +
        "</div>";
    } else {
      host.innerHTML = '<div class="hint" style="margin:0">Matched items are left exactly as they are - no ask ' +
        "price is set or changed.</div>";
    }
  }

  function spOpenRuleModal(id) {
    spEditRuleId = id || "";
    const r = id ? G.state.sealedPriceRules.find(x => x.id === id) : null;
    $("spRmTitle").textContent = r ? "Edit " + (r.name || "rule") : "New sealed price rule";
    $("spRmName").value = r ? r.name : "";
    $("spRmPriority").value = r ? r.priority : 0;
    $("spRmMode").value = r ? r.mode : "percent";
    $("spRmSetCode").value = r ? r.setCode : "";
    $("spRmNameContains").value = r ? r.nameContains : "";
    spRenderValueArea();
    if (r) {
      if (r.mode === "percent" && $("spRmPercent")) $("spRmPercent").value = Math.round(r.percent * 100);
      if (r.mode === "delta" && $("spRmDelta")) $("spRmDelta").value = r.delta;
      if (r.mode === "fixed" && $("spRmFixed")) $("spRmFixed").value = r.fixed;
    }
    $("spRmDelete").hidden = !r;
    UI.showModal("spRuleModal", "spRmName");
  }

  function spSaveRule() {
    const name = $("spRmName").value.trim();
    if (!name) { UI.toast("Give the rule a name.", "err"); return; }
    const mode = $("spRmMode").value;
    const draft = G.normalizeSealedPriceRule({
      id: spEditRuleId || undefined,
      on: true,
      name,
      priority: parseInt($("spRmPriority").value, 10) || 0,
      mode,
      setCode: $("spRmSetCode").value,
      nameContains: $("spRmNameContains").value,
      percent: mode === "percent" ? (parseFloat($("spRmPercent").value) || 0) / 100 : 1,
      delta: mode === "delta" ? (parseFloat($("spRmDelta").value) || 0) : 0,
      fixed: mode === "fixed" ? (parseFloat($("spRmFixed").value) || 0) : null
    });
    const existing = spEditRuleId ? G.state.sealedPriceRules.find(x => x.id === spEditRuleId) : null;
    if (existing) {
      draft.on = existing.on;
      Object.assign(existing, draft);
      G.logAudit({ action: "sealed-edit", note: 'Edited sealed price rule "' + name + '"' });
    } else {
      G.state.sealedPriceRules.push(draft);
      G.logAudit({ action: "sealed-edit", note: 'Created sealed price rule "' + name + '"' });
    }
    G.persist();
    UI.hideModal("spRuleModal");
    spRenderRulesList();
    UI.toast("Saved.", "ok");
  }

  function spRenderPlan() {
    const q = $("spPlanSearch").value.trim().toLowerCase();
    const ruleId = $("spPlanRule").value;
    const showAll = $("spPlanShowAll").checked;
    const everything = G.sealedBulkPricePlan({ includeUnchanged: true, ruleId: ruleId || null });
    const up = everything.filter(p => p.delta > 0).length, down = everything.filter(p => p.delta < 0).length;
    const excluded = everything.filter(p => p.excluded).length;
    const noBasis = everything.filter(p => p.noBasis).length;
    const zero = everything.filter(p => p.zero).length;
    const scope = ruleId ? ' — rule "' + $("spPlanRule").selectedOptions[0].textContent + '" only' : "";
    $("spPlanHdr").textContent = "— " + up + " to raise, " + down + " to lower, " +
      (noBasis ? noBasis + " waiting on price data, " : "") +
      (zero ? zero + " left alone at $0.00, " : "") +
      (excluded ? excluded + " excluded, " : "") + everything.length + " row(s) total" + scope;

    const full = showAll ? everything : everything.filter(p =>
      !p.excluded && p.target != null && !(p.current != null && Math.abs(p.current - p.target) < 0.005));
    spPlan = full.filter(p => {
      if (!q) return true;
      const hay = (p.record.name + " " + p.record.setCode).toLowerCase();
      return hay.includes(q);
    });

    const body = $("spPlanBody");
    if (!spPlan.length) {
      body.innerHTML = full.length
        ? UI.emptyRow(10, { icon: "search", title: "No items match that filter." })
        : UI.emptyRow(10, { icon: "money", title: "Nothing to price yet.",
            hint: 'Add a rule above, list some sealed product for sale, or tick "Show unchanged too".' });
      return;
    }
    body.innerHTML = spPlan.map((p, i) => {
      const rec = p.record;
      const canPick = !p.excluded && p.target != null;
      return '<tr' + (p.excluded ? ' class="short"' : '') + '>' +
        "<td>" + (canPick ? '<input type="checkbox" class="sppick" data-i="' + i + '" checked>' : "") + "</td>" +
        '<td class="card-name">' + G.esc(rec.name) + "</td>" +
        '<td class="muted hide-sm">' + G.esc(String(rec.setCode || "").toUpperCase()) + "</td>" +
        '<td class="num hide-sm">' + rec.quantity + "</td>" +
        '<td class="num">' + (rec.listedQty || 0) + "</td>" +
        '<td class="num hide-sm">' + G.money(p.market) + "</td>" +
        '<td class="num">' + (p.current == null ? '<span class="muted">—</span>' : G.money(p.current)) + "</td>" +
        '<td class="hide-sm">' + (p.rule ? G.esc(p.rule.name) : '<span class="muted">—</span>') + "</td>" +
        '<td class="num">' + (p.excluded
          ? '<span class="pill">excluded</span>'
          : p.zero ? '<span class="muted" title="This rule works out to $0.00 or less here, so the item is left alone">$0.00, skipped</span>'
          : p.target == null ? '<span class="muted">no market price</span>' : G.money(p.target)) + "</td>" +
        '<td class="num">' + (p.delta == null ? "" : (p.delta > 0 ? "+" : "") + p.delta.toFixed(2)) + "</td>" +
        "</tr>";
    }).join("");
    UI.reapplySorts();
  }

  function spTickedLines() {
    return [...document.querySelectorAll(".sppick:checked")]
      .map(c => spPlan[Number(c.dataset.i)]).filter(Boolean);
  }

  async function spApplyPlan() {
    const picks = spTickedLines();
    if (!picks.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const ok = await UI.confirmDialog("Set the ask price for " + picks.length + " item(s)?", { title: "Apply local prices?" });
    if (!ok) return;
    const out = G.applySealedBulkPricePlan(picks, "Sealed price plan");
    G.persist("Sealed price plan");
    UI.toast("Updated " + out.changed + " item(s). Undo puts it back.", "ok");
    spRenderPlan();
  }

  /* Push to Manapool - same per-identity grouping/batching shape as the
     card push above, keyed by tcgplayerProductId (sealedIdentityKey)
     instead of manapoolIdentityKey since sealed has no lang/finish/
     condition tiers to fold in. */
  async function spPushToManapool() {
    const picks = spTickedLines().filter(p => !p.excluded && p.target != null && (p.record.listedQty || 0) > 0);
    const skippedUnlisted = spTickedLines().length - picks.length;
    if (!picks.length) {
      UI.toast(skippedUnlisted
        ? "None of the ticked rows are currently listed on Manapool - there is nothing to push a price onto."
        : "Nothing is ticked.", "err");
      return;
    }
    const proceed = await UI.confirmDialog("Push a new price for " + picks.length + " listing(s) to Manapool? " +
      "Quantity is never raised: each listing keeps the quantity Manapool shows right now, or goes lower if fewer copies " +
      "are free to sell here (copies sold to a Manapool order that isn't picked yet don't count)" +
      (skippedUnlisted ? ". " + skippedUnlisted + " ticked row(s) are not currently listed and will be skipped" : "") + ".",
      { title: "Push live prices to Manapool?" });
    if (!proceed) return;

    // Same live read and quantity cap as the card push above (#86).
    UI.toastProgress("Reading your current Manapool listings…");
    let live;
    try {
      live = G.manapoolLiveListings((await G.api("/api/manapool/listings")).listings, true);
    } catch (e) {
      UI.toastProgress("");
      UI.toast("Couldn't read your current Manapool listings, so nothing was pushed: " + e.message, "err");
      return;
    }
    UI.toastProgress("");

    // Copies on a fetched order with no pick list yet are sold too (#107).
    // The live quantity above already caps the push, so a cache that can't
    // be read only means pick lists alone are held back.
    try { await G.loadManapoolOrders(); } catch (e) { /* see above */ }
    const reserved = G.manapoolReservations();
    const groups = new Map();
    let notOnManapool = 0;
    for (const line of picks) {
      const key = G.sealedIdentityKey(line.record);
      if (groups.has(key)) { if (groups.get(key)) groups.get(key).lines.push(line); continue; }
      const liveQty = (live.get(key) || { quantity: 0 }).quantity;
      if (!liveQty) { notOnManapool++; groups.set(key, null); continue; }
      groups.set(key, { sample: line.record, price: line.target, qty: G.sealedPricePushQuantity(key, liveQty, reserved), lines: [line] });
    }
    for (const [key, g] of [...groups]) if (!g) groups.delete(key);
    if (!groups.size) {
      UI.toast("None of the ticked listings are on Manapool right now (they may have sold) - nothing was pushed.", "err");
      return;
    }

    // Only what changes is sent (#482), as in the card push above.
    const allKeys = [...groups.keys()];
    const { keys, entries, upToDate } = G.splitManapoolPush(allKeys, allKeys.map(key => {
      const g = groups.get(key);
      return { item: g.sample, quantity: g.qty, price: g.price };
    }), live);
    const landed = upToDate.map(u => ({ key: u.key, quantity: u.quantity }));
    // The price that landed becomes each ticked row's ask (#98), as above.
    const recordLanded = () => {
      const asks = [];
      for (const s of landed) {
        G.applySealedManapoolQuantity(s.key, s.quantity, "Manapool price push");
        const g = groups.get(s.key);
        for (const l of g.lines) asks.push(Object.assign({}, l, { target: g.price }));
      }
      G.applySealedBulkPricePlan(asks, "Manapool price push");
      if (landed.length) { G.persist("Manapool price push"); spRenderPlan(); }
      landed.length = 0;
    };

    const BATCH = G.MANAPOOL_BATCH_SIZE || 100;
    const batches = [];
    for (let start = 0; start < entries.length; start += BATCH) batches.push(entries.slice(start, start + BATCH));

    let ok = 0, failed = [];
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      pushProgress(b * BATCH, entries.length, batches.length, "sealed listing");
      let out;
      try {
        out = await G.api("/api/manapool/list-bulk-sealed", { method: "POST", body: { items: batch } });
      } catch (e) {
        for (const entry of batch) failed.push({ key: G.sealedIdentityKey(entry.item), error: e.message });
        continue;
      }
      out.results.forEach((r, j) => {
        const key = keys[b * BATCH + j];
        if (r.ok) {
          ok++;
          landed.push({ key, quantity: r.quantity != null ? r.quantity : batch[j].quantity });
        } else failed.push({ key, error: r.error });
      });
      if (out.succeeded === 0 && batch.length > 0 && batches.length > 1) {
        recordLanded();
        UI.toast("Stopped after batch " + (b + 1) + "/" + batches.length +
          " - every price push in it failed (" + (out.results[0] && out.results[0].error || "unknown error") +
          "). Fix the issue and push the rest again." + upToDateNote(upToDate.length), "err");
        UI.toastProgress("");
        return;
      }
    }
    UI.toastProgress("");
    recordLanded();
    const detail = batches.length > 1 && failed.length
      ? "Sent in " + batches.length + " batch(es) of up to " + BATCH + " listing(s) each, each confirmed before the next was sent." +
        "\n\nFailures:\n" + failed.slice(0, 10).map(f => "• " + f.error).join("\n") +
        (failed.length > 10 ? "\n… and " + (failed.length - 10) + " more" : "")
      : (failed.length ? failed[0].error : "");
    UI.toast((entries.length ? "Pushed " + ok + "/" + groups.size + " price(s) to Manapool" +
        (batches.length > 1 ? " across " + batches.length + " batches" : "") + "." : "Nothing needed sending to Manapool.") +
      upToDateNote(upToDate.length) +
      (failed.length ? " " + failed.length + " failed." : "") +
      (notOnManapool ? " " + notOnManapool + " skipped: no longer listed on Manapool." : ""),
      failed.length ? "err" : "ok", detail || undefined);
  }

  /* ============================== Wire up ============================== */
  // Started by listings.page.js the first time the Pricing tab opens, so Listings stays
  // quick to load (and the shared page boot only runs once).
  window.startPricingTab = async function () {
    $("schHour").innerHTML = hourOptions();
    $("schWeekday").innerHTML = WEEKDAYS.map((d, i) => '<option value="' + i + '">' + d + "</option>").join("");

    renderRulesList();
    renderPlan();
    loadSchedule();
    renderLastRun();

    $("btnNewRule").onclick = () => openRuleModal("");
    // Not `renderValueArea` directly: onchange hands the handler the Event
    // object, which is truthy and so was silently satisfying `basisOverride
    // || ...` above - the currently-selected Base price then never matched
    // any option (an Event isn't a PRICE_BASES key) and silently fell back
    // to whatever the browser defaults an unmatched <select> to (its first
    // option, Scryfall market), discarding the real selection every time
    // Mode was changed.
    $("rmMode").onchange = () => renderValueArea();
    $("rmCancel").onclick = () => UI.hideModal("bp_ruleModal");
    $("rmSave").onclick = saveRule;
    $("rmDelete").onclick = () => { UI.hideModal("bp_ruleModal"); if (editRuleId) deleteRule(editRuleId); };
    $("ruleModal").addEventListener("click", e => { if (e.target.id === "bp_ruleModal") UI.hideModal("bp_ruleModal"); });

    // A new filter or a fresh plan starts back at the first page of rows.
    const fresh = fn => () => { rowCap = G.PLAN_ROW_CAP; fn(); };
    $("planSearch").oninput = G.debounce(fresh(renderPlanRows), 150);
    $("planShowAll").onchange = fresh(renderPlanRows);
    $("planRule").onchange = fresh(renderPlan);
    $("btnEvaluate").onclick = fresh(renderPlan);
    $("planMoreBtn").onclick = () => { rowCap += G.PLAN_ROW_CAP; renderPlanRows(); };
    // A column sort orders the whole plan, then redraws its first rows.
    UI.dataSort($("planBody").closest("table"), () => renderPlanRows());
    $("planAll").onchange = () => {
      const on = $("planAll").checked;
      for (const p of plan) { if (!canPick(p)) continue; if (on) unticked.delete(p.record.id); else unticked.add(p.record.id); }
      $("planBody").querySelectorAll(".ppick").forEach(c => { c.checked = on; });
    };
    $("btnPushMp").onclick = pushToManapool;
    refreshManapoolButton().then(connected => {
      $("spBtnPushMp").disabled = !connected;
      if (connected) backfillAskPrices();
    });

    $("schFreq").onchange = () => { $("schWeekdayWrap").hidden = $("schFreq").value !== "weekly"; };
    $("schSave").onclick = saveSchedule;
    $("schRunNow").onclick = runNow;

    spRenderRulesList();
    spRenderPlan();
    $("spBtnNewRule").onclick = () => spOpenRuleModal("");
    $("spRmMode").onchange = spRenderValueArea;
    $("spRmCancel").onclick = () => UI.hideModal("spRuleModal");
    $("spRmSave").onclick = spSaveRule;
    $("spRmDelete").onclick = () => { UI.hideModal("spRuleModal"); if (spEditRuleId) spDeleteRule(spEditRuleId); };
    $("spRuleModal").addEventListener("click", e => { if (e.target.id === "spRuleModal") UI.hideModal("spRuleModal"); });
    $("spPlanSearch").oninput = G.debounce(spRenderPlan, 150);
    $("spPlanShowAll").onchange = spRenderPlan;
    $("spPlanRule").onchange = spRenderPlan;
    $("spBtnEvaluate").onclick = spRenderPlan;
    $("spPlanApply").onclick = spApplyPlan;
    $("spPlanAll").onchange = () => {
      document.querySelectorAll(".sppick").forEach(c => { c.checked = $("spPlanAll").checked; });
    };
    $("spBtnPushMp").onclick = spPushToManapool;

    G.on("change", () => { renderRulesList(); spRenderRulesList(); });
  };
})();
