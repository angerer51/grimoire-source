
"use strict";
(function () {
  const G = window.G, UI = window.UI;
  const $ = UI.$;
  const CONDS = G.CONDITIONS;

  let draftCriteria = G.newCriteriaBox();
  let editRuleId = "";     // "" while creating a new rule
  let plan = [];
  // Evaluate rows the user UNticked, by listing key (#97, #227). Every rebuild of the
  // table (a price edit, the filter box, the rule picker) used to tick every
  // row again, so Push sent rows deliberately left out. New rows start ticked.
  const unticked = new Set();
  const autoSeen = new Set();

  /* ============================== Tabs ==============================
     Split 2026-09-01 from one long stack of sections (rule setup, the
     evaluate/apply working view, and the live Manapool sync) into three -
     everything here already shared state, so this is pure DOM visibility,
     no new data flow. Evaluate & Apply defaults active - it's the thing
     most visits are actually here to do; Rules is setup you touch rarely,
     Manapool is a live cross-check + the account-wide danger zone. */
  let tabs;
  function onTab(t) {
    // The switch on Rules and the counts can change while another tab is open.
    if (t === "pricing") $("bpAutoPushLoss").hidden = !G.state.settings.neverListAtLoss;
    if (t === "manapool") refreshUnprofitableCount();
    // The Card and Sealed pricing tabs (bulk-price.page.js) does its work only once it is first opened.
    if ((t === "pricing" || t === "sealed") && !pricingStarted && window.startPricingTab) {
      pricingStarted = true;
      // Same as UI.boot did on the old page: a failure shows a toast, and the
      // next open of the tab tries again instead of leaving dead buttons.
      Promise.resolve().then(() => window.startPricingTab()).catch(e => {
        pricingStarted = false;
        UI.toast("Could not load the pricing tab: " + (e && e.message || e), "err");
      });
    }
  }
  let pricingStarted = false;

  /* ============================== Condition pricing / defaults ============================== */
  function renderCondFields() {
    $("condFields").innerHTML = CONDS.map(c =>
      '<label>' + G.esc(G.CONDITION_NAMES[c]) + '<br><span class="muted" style="font-weight:400">% of market</span>' +
      '<input id="cond_' + c + '" type="number" min="0" step="1"></label>').join("");
  }
  function loadPrefs() {
    const s = G.state.settings;
    const pricing = s.conditionPricing || {};
    CONDS.forEach(c => { $("cond_" + c).value = Math.round((pricing[c] == null ? 1 : pricing[c]) * 100); });
    $("prefDefaultKeep").value = s.listingDefaultKeep || 0;
    $("prefNeverLoss").checked = !!s.neverListAtLoss;
    // The minimum in effect, stored or not (#390): what's shown is what Save stores.
    $("prefMinProfit").value = G.minProfitPct();
  }
  function savePrefs() {
    const s = G.state.settings;
    const pricing = {};
    CONDS.forEach(c => { pricing[c] = Math.max(0, (parseFloat($("cond_" + c).value) || 0) / 100); });
    s.conditionPricing = pricing;
    s.listingDefaultKeep = Math.max(0, parseInt($("prefDefaultKeep").value, 10) || 0);
    // An empty or unreadable minimum is never saved as a surprise 0 (#390): it
    // keeps the minimum in effect before this save, the same number the box showed.
    const typed = window.RuleEngine.readMinProfitPct($("prefMinProfit").value);
    s.minProfitPct = typed != null ? typed : G.minProfitPct();
    s.neverListAtLoss = $("prefNeverLoss").checked;
    $("prefMinProfit").value = s.minProfitPct;
    G.persistSettings();
    UI.setStatus("prefStatus", "✓ Saved.", "ok");
  }

  /* ============================== Rule list ============================== */
  function renderRuleSelect() {
    const sel = $("planRule");
    const prev = sel.value;
    const rules = G.state.listingRules.slice().sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="">All rules (auto, by priority)</option>' +
      rules.map(r => '<option value="' + r.id + '">' + G.esc(r.name || "(unnamed rule)") +
        (r.on ? "" : " (off)") + "</option>").join("");
    sel.value = rules.some(r => r.id === prev) ? prev : "";
  }

  function renderRulesList() {
    const rules = G.state.listingRules.slice().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    $("rulesHdr").textContent = rules.length ? "— " + rules.length + " rule" + (rules.length === 1 ? "" : "s") : "";
    renderRuleSelect();
    const host = $("rulesList");
    if (!rules.length) {
      host.innerHTML = UI.emptyBlock({ icon: "generic", title: "No rules yet.",
        hint: "Until you add one, every stack falls back to the default keep above." });
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
          '<span class="pill">keep ' + r.keep + '</span>' +
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
    const r = G.state.listingRules.find(x => x.id === id);
    if (!r) return;
    r.on = !r.on;
    G.logAudit({ action: "listing-rule", note: 'Listing rule "' + (r.name || "(unnamed rule)") + '" switched ' + (r.on ? "on" : "off") });
    G.persist();
    renderRulesList();
  }

  async function deleteRule(id) {
    const r = G.state.listingRules.find(x => x.id === id);
    if (!r) return;
    const ok = await UI.confirmDialog('Delete listing rule "' + (r.name || "(unnamed rule)") + '"?', { title: "Delete rule?", danger: true });
    if (!ok) return;
    G.state.listingRules = G.state.listingRules.filter(x => x.id !== id);
    G.logAudit({ action: "listing-rule", note: 'Deleted listing rule "' + (r.name || "(unnamed rule)") + '"' });
    G.persist();
    renderRulesList();
    UI.toast("Rule deleted. Undo brings it back.", "ok");
  }

  /* ============================== Name overrides (keep exceptions) ============================== */
  function renderExceptions() {
    const rows = G.state.listingKeepExceptions.slice().sort((a, b) => a.name.localeCompare(b.name));
    $("excHdr").textContent = rows.length ? "— " + rows.length + " exception" + (rows.length === 1 ? "" : "s") : "";
    const host = $("excList");
    if (!rows.length) {
      host.innerHTML = UI.emptyRow(3, { icon: "cards", title: "No name overrides yet." });
      return;
    }
    host.innerHTML = rows.map(x =>
      '<tr><td class="card-name">' + UI.cardNameLink(x.name) + "</td>" +
      '<td class="num">' + x.keep + "</td>" +
      '<td><button class="small ghost" data-id="' + x.id + '">Delete</button></td></tr>'
    ).join("");
    host.querySelectorAll("button[data-id]").forEach(btn => {
      btn.onclick = () => deleteException(btn.dataset.id);
    });
    UI.reapplySorts();
  }

  function addException() {
    const name = $("excName").value.trim();
    if (!name) { UI.toast("Type a card name first.", "err"); return; }
    const keep = Math.max(0, parseInt($("excKeep").value, 10) || 0);
    const key = name.toLowerCase();
    const existing = G.state.listingKeepExceptions.find(x => x.name.toLowerCase() === key);
    if (existing) {
      existing.keep = keep;
      G.logAudit({ action: "listing-rule", note: 'Updated name override "' + name + '" to keep ' + keep });
    } else {
      G.state.listingKeepExceptions.push(G.normalizeKeepException({ name, keep }));
      G.logAudit({ action: "listing-rule", note: 'Added name override "' + name + '" (keep ' + keep + ")" });
    }
    G.persist();
    $("excName").value = "";
    $("excKeep").value = 4;
    renderExceptions();
    renderPlan();
  }

  async function deleteException(id) {
    const x = G.state.listingKeepExceptions.find(e => e.id === id);
    if (!x) return;
    const ok = await UI.confirmDialog('Delete the name override for "' + x.name + '"?', { title: "Delete override?", danger: true });
    if (!ok) return;
    G.state.listingKeepExceptions = G.state.listingKeepExceptions.filter(e => e.id !== id);
    G.logAudit({ action: "listing-rule", note: 'Deleted name override "' + x.name + '"' });
    G.persist();
    renderExceptions();
    renderPlan();
    UI.toast("Override deleted. Undo brings it back.", "ok");
  }

  /* ============================== Condition editor (shared with locations.html / bulk-price.html) ============================== */
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

  /* ============================== Add / edit rule modal ============================== */
  function openRuleModal(id) {
    editRuleId = id || "";
    const r = id ? G.state.listingRules.find(x => x.id === id) : null;
    $("rmTitle").textContent = r ? "Edit " + (r.name || "rule") : "New listing rule";
    $("rmName").value = r ? r.name : "";
    $("rmPriority").value = r ? r.priority : 0;
    $("rmKeep").value = r ? r.keep : 0;
    $("rmDelete").hidden = !r;
    draftCriteria = G.normalizeCriteriaBox(r && r.criteria);
    renderCriteria();
    UI.showModal("ruleModal", "rmName");
  }

  function saveRule() {
    const name = $("rmName").value.trim();
    if (!name) { UI.toast("Give the rule a name.", "err"); return; }
    const draft = G.normalizeListingRule({
      id: editRuleId || undefined,
      on: true,
      name,
      priority: parseInt($("rmPriority").value, 10) || 0,
      keep: parseInt($("rmKeep").value, 10) || 0,
      criteria: draftCriteria
    });
    const existing = editRuleId ? G.state.listingRules.find(x => x.id === editRuleId) : null;
    if (existing) {
      draft.on = existing.on;
      Object.assign(existing, draft);
      G.logAudit({ action: "listing-rule", note: 'Edited listing rule "' + name + '"' });
    } else {
      G.state.listingRules.push(draft);
      G.logAudit({ action: "listing-rule", note: 'Created listing rule "' + name + '"' });
    }
    G.persist();
    UI.hideModal("ruleModal");
    renderRulesList();
    UI.toast("Saved.", "ok");
  }

  /* ============================== Evaluate / apply ==============================
     The Manapool-facing ask for a stack: its listing's live ask (#228) -
     the Bulk Price rule that prices the listing, else the market price
     scaled by whatever % the condition asks for (Rules tab) - core.js
     manapoolListPrice (#88). Shared by the Price column
     below and pushToManapool() so what you see is exactly what gets sent -
     Manapool refuses to create a brand-new listing with no price at all
     (mpBuildItem sends price_cents: null), which is what made these look
     unlistable with no obvious cause until this column existed. */
  // `asks` = G.manapoolListingAsks(), built once per render/push: every
  // stack of one listing goes out at that listing's one ask.
  const listPriceFor = (record, asks) => G.manapoolListPrice(record, asks);

  /* The last computed plan (#99). Building one walks every stack (~230 ms at
     70k stacks), so it is rebuilt only by renderPlan(): Evaluate, the rule
     picker, "Show unchanged too", and a real change (apply,
     push, name override). The filter box only re-filters it
     (renderPlanRows). `plan` stays the whole filtered list, so Apply, Push
     and the header tick box act on every ticked row matching the filter,
     including rows past the drawn limit. */
  let view = G.planView([], () => "");
  let planAsks = new Map();
  let rowCap = G.PLAN_ROW_CAP;

  /* One row per Manapool listing (#227): G.listingPlanRows merges a whole
     plan's stacks by listing, so a row's Have / Listed now / Target add up
     over every stack of it, changing or not. Each row's `lines` are the
     stacks Apply and Push act on. */
  function renderPlan() {
    const ruleId = $("planRule").value;
    const lines = G.listingPlan({ includeUnchanged: true, ruleId: ruleId || null });
    const full = G.listingPlanRows(lines, { includeUnchanged: $("planShowAll").checked });
    view = G.planView(full, p => p.record.name + " " + p.record.set + " " + p.record.setName + " " + p.record.collector);
    planAsks = G.manapoolListingAsks();
    // Rows with no price start unticked (once; a later tick sticks).
    for (const p of full) {
      if (autoSeen.has(p.key)) continue;
      autoSeen.add(p.key);
      if (listPriceFor(p.record, planAsks) == null) unticked.add(p.key);
    }
    const up = full.filter(p => p.delta > 0).length, down = full.filter(p => p.delta < 0).length;
    const scope = ruleId ? ' — rule "' + $("planRule").selectedOptions[0].textContent + '" only' : "";
    const n = (k, word) => k + " " + word + (k === 1 ? "" : "s");
    $("planHdr").textContent = "— " + n(up, "listing") + " going up, " + n(down, "listing") + " going down, " +
      n(full.length, "listing") + " total" + scope;
    renderPlanRows();
  }

  // What a row shows in the Keep and Rule columns: one value, or each
  // distinct one when a listing's stacks fall under different rules.
  const keepText = p => p.keeps.join(" / ");
  const ruleText = p => p.rules.map(r => r ? r.name : "default").join(", ");
  const langOf = p => String(p.record.lang || "en").toUpperCase();
  const finishOf = p => G.FINISH_NAMES[p.record.finish] || "Non-foil";
  // Condition as its code (NM, LP...), the full name in the cell's title (#366, design-guidelines §4.6).
  const condOf = p => p.record.condition || "NM";
  const condName = p => G.CONDITION_NAMES[condOf(p)] || condOf(p);

  /* Sort key per Evaluate column, by column index, matching what each cell
     shows. A column sort orders the whole filtered plan with these
     (UI.dataSort), so the first 500 drawn rows are the top of the real
     order, not a sort of whichever 500 happened to be drawn. */
  const PLAN_SORT_KEYS = {
    2: p => p.record.name,
    3: p => String(p.record.set || "").toUpperCase(),
    4: p => String(p.record.collector || ""),
    5: p => { const i = G.CONDITIONS.indexOf(condOf(p)); return i < 0 ? 99 : i; },   // best grade first
    6: finishOf,
    7: langOf,
    8: p => listPriceFor(p.record, planAsks),
    9: p => { const x = G.soldOf(p.record); return x ? x.n : null; },   // Sold 7d (#366)
    10: p => { const x = G.soldOf(p.record); return x ? x.daysLeft : null; },   // Days left (#368), shortest first
    11: p => p.have,
    12: p => Math.min(...p.keeps),
    13: ruleText,
    14: p => p.listedNow,
    15: p => p.target,
    16: p => p.delta
  };

  /* #368: the Days left cell: about how long the copies listed on Manapool
     now (every seller) last at the last 7 days' pace. Blank (sorts last)
     while the sales aren't in, or with too few sales to say. */
  function daysLeftTd(rec) {
    const x = G.soldOf(rec), s = G.soldSales() || {};
    const why = !x ? "No Manapool sales for this printing to estimate from."
      : "Too few separate sales in the last 7 days" + (s.daysLeftMinSales ? " (it needs " + s.daysLeftMinSales + ")" : "") +
        ", or the listed supply isn't known, to estimate this.";
    const d = x ? x.daysLeft : null;
    const v = G.daysLeftView(d, x && x.available, x ? x.n : 0, x && x.atLeast, why);
    return '<td class="num hide-sm" data-v="' + (d == null ? "" : d) + '" title="' + G.esc(v.title) + '">' +
      (d == null ? '<span class="faint">—</span>' : v.text) + "</td>";
  }

  /* #366: "Selling fast only". A listing is one printing, so its record says
     whether it's SELLING FAST. The box is off until the sales are in, and
     stays off while there's too little history to compare. */
  const isFast = p => { const x = G.soldOf(p.record); return !!(x && x.hot); };
  function syncFastBox() {
    const s = G.soldSales(), box = $("planFast");
    const why = !s ? "Loading Manapool sales…" : s.error ? s.error
      : !s.historySince ? "No Manapool sales history has been collected yet."
      : !s.comparable ? "Too early: SELLING FAST needs " + s.hotNeedsDays + " days of sales history to compare paces." : "";
    box.disabled = !!why;
    if (why && s) box.checked = false;   // loaded, and there's nothing to filter by
    $("planFastWrap").title = why || "Only listings whose printing is SELLING FAST on Manapool: sold well above its usual pace in the last 7 days";
  }

  // Why some of a listing's copies are never listed (#194). A stack whose
  // location was deleted counts as not sold from too.
  function sellFromOffTitle(p) {
    const named = p.offLocations.filter(Boolean);
    return (named.length ? named.map(G.esc).join(", ") + (named.length === 1 ? " has" : " have") +
        " Sell from this location off, so nothing there is listed."
      : "These copies have no location, so they are not listed.") + " They still count toward Keep.";
  }

  function renderPlanRows() {
    plan = view.filter($("planSearch").value);
    if ($("planFast").checked) plan = plan.filter(isFast);
    const sort = UI.sortStateOf($("planBody").closest("table"));
    if (sort && PLAN_SORT_KEYS[sort.col]) plan = G.sortRows(plan, PLAN_SORT_KEYS[sort.col], sort.dir);
    const body = $("planBody");
    syncPlanAll();
    UI.planMoreNote($("planMore"), plan.length, rowCap);
    if (!plan.length) {
      body.innerHTML = view.lines.length
        ? UI.emptyRow(17, { icon: "search", title: "No listings match that filter." })
        : UI.emptyRow(17, { icon: "generic", title: "Nothing to change — every listing already matches its target." });
      return;
    }
    const asks = planAsks;
    // The note may wrap ("2 sell / from off") so it doesn't widen its column
    // past the table's 1366px budget (#368).
    const note = (title, text) => '<div class="muted" style="font-size:.85em;white-space:normal" title="' + title + '">' + text + "</div>";
    body.innerHTML = plan.slice(0, rowCap).map((p, i) => {
      // Read-only (#227): the price a push sends for this listing. "none"
      // means Manapool will refuse to create it as a new listing.
      const listPrice = listPriceFor(p.record, asks);
      const priceCell = '<td class="num" data-v="' + (listPrice == null ? "" : listPrice) + '">' +
        (listPrice == null
          ? '<span style="color:var(--neg)" title="No price - Manapool will refuse to create a new listing for this">none</span>'
          : G.money(listPrice)) + "</td>";
      const rec = p.record;
      const setCode = PLAN_SORT_KEYS[3](p), num = PLAN_SORT_KEYS[4](p);
      return '<tr class="click">' +
        UI.artThumbTd(rec.imageUrl) +
        '<td><input type="checkbox" class="ppick" data-i="' + i + '"' + (unticked.has(p.key) ? "" : " checked") +
          ' aria-label="Include this listing"></td>' +
        '<td class="card-name">' + UI.cardLink(rec) + "</td>" +
        '<td data-vs="' + G.esc(setCode) + '" title="' + G.esc(rec.setName || "") + '">' + G.esc(setCode) + "</td>" +
        '<td data-vs="' + G.esc(num) + '">' + G.esc(num) + "</td>" +
        '<td class="hide-sm" data-v="' + PLAN_SORT_KEYS[5](p) + '" title="' + G.esc(condName(p)) + '">' + G.esc(condOf(p)) + "</td>" +
        '<td class="hide-sm nowrap">' + G.esc(finishOf(p)) + "</td>" +
        '<td class="hide-sm" title="' + G.esc(G.LANG_NAMES[rec.lang || "en"] || "") + '">' + G.esc(langOf(p)) + "</td>" +
        priceCell +
        UI.soldTd(rec, "hide-sm") +
        daysLeftTd(rec) +
        '<td class="num" data-v="' + p.have + '">' + p.have +
          (p.reserved > 0 ? note("Sold on Manapool, not picked yet - not listable", p.reserved + " sold") : "") + "</td>" +
        '<td class="num" data-v="' + PLAN_SORT_KEYS[12](p) + '">' + G.esc(keepText(p)) + "</td>" +
        '<td class="hide-sm" data-vs="' + G.esc(ruleText(p)) + '">' +
          p.rules.map(r => r ? G.esc(r.name) : '<span class="muted">default</span>').join(", ") + "</td>" +
        '<td class="num">' + p.listedNow + "</td>" +
        '<td class="num" data-v="' + p.target + '">' + p.target +
          (p.offQty > 0 ? note(sellFromOffTitle(p), p.offQty + " sell from off") : "") + "</td>" +
        '<td class="num" data-v="' + p.delta + '">' + (p.delta > 0 ? "+" : "") + p.delta + "</td>" +
        "</tr>";
    }).join("");
    body.querySelectorAll(".ppick").forEach(c => {
      c.addEventListener("change", () => {
        const row = plan[Number(c.dataset.i)];
        if (!row) return;
        if (c.checked) unticked.delete(row.key); else unticked.add(row.key);
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

  // The header box reflects the listings matching the filter: ticked if all
  // are, half-ticked if some are.
  function syncPlanAll() {
    const all = $("planAll");
    const on = plan.filter(p => !unticked.has(p.key)).length;
    all.checked = plan.length > 0 && on === plan.length;
    all.indeterminate = on > 0 && on < plan.length;
  }
  // The ticked listings from the CURRENT plan, by listing rather than by
  // whatever checkboxes happen to be in the DOM.
  const tickedRows = () => plan.filter(p => !unticked.has(p.key));
  // Every stack of the ticked listings, each listing's stacks together and
  // its first stack first, so a push prices a listing from the same stack
  // the Price column shows (manapoolPushGroups' sample).
  const tickedLines = () => tickedRows().flatMap(p => p.lines);

  /* The plan is kept between real changes (#99), but the stacks under it can
     move on without this page rebuilding it: Fetch listings, an undo, another
     device's save merged in, an order picked elsewhere. A Push sends each
     line's target as the live Manapool quantity, so acting on a stale plan
     could put sold copies back up. Rebuild from live data right before acting
     and go ahead only if the ticked rows, their targets and the prices a push
     would send are unchanged; otherwise show the fresh plan and stop. */
  function planStillCurrent() {
    const sig = asks => G.planFingerprint(tickedLines(), p => listPriceFor(p.record, asks));
    const before = sig(planAsks);
    renderPlan();
    if (sig(planAsks) === before) return true;
    UI.toast("Your stacks or Manapool orders changed since this plan was built, so it has been rebuilt with the current numbers. " +
      "Check it, then press again. Nothing was applied or pushed.", "err");
    return false;
  }

  /* The fetched Manapool orders (#107): copies on an unfinished order with
     no pick list yet are already sold, so the plan holds them back (core.js
     manapoolReservations). The server's cache is enough for Evaluate and
     Apply; Push fetches fresh first. If even the cache can't be read, the
     plan falls back to pick lists only, as before. */
  async function loadCachedOrders() {
    try { await G.loadManapoolOrders(); } catch (e) { /* see above */ }
  }

  async function applyPlan() {
    const picks0 = tickedLines();
    if (!picks0.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const ok = await UI.confirmDialog("Mark " + tickedRows().length + " listing(s) to list at their target quantities?\n\nThis only updates Grimoire. Nothing is sent to Manapool or any other marketplace until you push.", { title: "Mark quantities to list?" });
    if (!ok) return;
    if (!planStillCurrent()) return;
    const picks = tickedLines();
    const out = G.applyListingPlan(picks, "Listing plan");
    G.persist("Listing plan");
    refreshUnprofitableCount();
    UI.toast("Marked " + out.changed + " stack(s) to list (not sent to a marketplace yet). Undo puts it back.", "ok");
    renderPlan();
  }

  /* ============================== Manapool push (shared batching) ==============================
     Both "Push ticked" and "Delist all" send the same shape of request
     ({card, quantity, price, condition} entries, matched 1:1 against
     `keys` = manapoolIdentityKey per entry) through the same batched,
     stop-if-Manapool-looks-down flow - the only real difference between the
     two callers is how `entries`/`keys` get built and what the resulting
     toast says. `route` defaults to the card endpoint; Delist all passes
     the sealed one for its sealed entries ({item, quantity, price}).
     Progress counts listings, not batches (#480): "Pushing 1,200 of 7,419
     listings to Manapool…" with the toast's bar. */
  async function pushManapoolBatch(entries, keys, verb, route) {
    const BATCH = G.MANAPOOL_BATCH_SIZE || 100;
    const sealedRun = route === "/api/manapool/list-bulk-sealed";
    const where = /^Delist/.test(verb) ? " from Manapool…" : " to Manapool…";
    const noun = n => (sealedRun ? "sealed " : "") + (n === 1 ? "listing" : "listings");
    const batches = [];
    for (let start = 0; start < entries.length; start += BATCH) {
      batches.push({ items: entries.slice(start, start + BATCH), keys: keys.slice(start, start + BATCH) });
    }

    const succeeded = [], failed = [];
    let consecutiveFullFailures = 0;
    for (let b = 0; b < batches.length; b++) {
      const { items: batch, keys: batchKeys } = batches[b];
      if (batches.length > 1) {
        const sent = b * BATCH;
        UI.toastProgress(verb + " " + sent.toLocaleString() + " of " + entries.length.toLocaleString() + " " +
          noun(entries.length) + where, sent, entries.length);
      } else UI.toastProgress(verb + " " + batch.length + " " + noun(batch.length) + where);
      let out, thisBatchFailed = [];
      try {
        out = await G.api(route || "/api/manapool/list-bulk", { method: "POST", body: { items: batch } });
      } catch (e) {
        // The whole request failed outright (not per-item skips) - record
        // every item in it as failed, but still try the remaining batches
        // rather than abandoning cards that were never even attempted.
        for (const key of batchKeys) { const f = { key, error: e.message }; failed.push(f); thisBatchFailed.push(f); }
        out = { succeeded: 0 };
      }
      if (out.results) {
        out.results.forEach((r, j) => {
          const key = batchKeys[j];
          // r.warning: Manapool confirmed fewer copies than were sent (#225).
          if (r.ok) succeeded.push({ key, quantity: r.quantity != null ? r.quantity : batch[j].quantity, warning: r.warning || null });
          else { const f = { key, error: r.error }; failed.push(f); thisBatchFailed.push(f); }
        });
      }
      // A single batch coming back with nothing confirmed is usually about
      // those specific items (see their own error text below), not a sign
      // Manapool itself is down - only TWO fully-failed batches in a row is
      // treated as "Manapool is rejecting everything" (bad token, an outage)
      // and worth giving up on, so one flaky/rejected batch doesn't abandon
      // every batch after it - which used to mean any single stumble forced
      // a full manual re-push of everything still untouched.
      if (out.succeeded === 0 && batch.length > 0) {
        consecutiveFullFailures++;
        if (consecutiveFullFailures >= 2 && batches.length > 1) {
          UI.toastProgress("");
          const reasons = [...new Set(thisBatchFailed.map(f => f.error))];
          return { succeeded, failed, stoppedEarly: true, stoppedAt: b, totalBatches: batches.length, batchSize: BATCH, reasons };
        }
      } else {
        consecutiveFullFailures = 0;
      }
    }
    UI.toastProgress("");
    return { succeeded, failed, stoppedEarly: false, totalBatches: batches.length, batchSize: BATCH };
  }

  /* ============================== Push to Manapool ============================== */
  async function pushToManapool() {
    const picks0 = tickedLines();
    if (!picks0.length) { UI.toast("Nothing is ticked.", "err"); return; }
    const ok = await UI.confirmDialog("Push " + tickedRows().length + " listing(s) to Manapool? This creates/updates real listings on your account.",
      { title: "Push live listings to Manapool?" });
    if (!ok) return;
    // Orders first (#107): a copy sold on an order nobody has fetched yet
    // must not go back up. Fetch orders fresh, rebuild the plan with them,
    // and stop if that moved anything. No orders, no push.
    UI.toastProgress("Checking Manapool for new orders…");
    try {
      await G.loadManapoolOrders({ fresh: true });
    } catch (e) {
      UI.toastProgress("");
      UI.toast("Couldn't fetch your Manapool orders, so nothing was pushed: " + e.message, "err",
        "A push checks for new orders first, so copies that have already sold aren't listed again. Try again in a bit.");
      return;
    }
    UI.toastProgress("");
    if (!planStillCurrent()) return;
    const picks = tickedLines();

    // One entry per Manapool listing, with untouched same-listing stacks
    // folded in (G.manapoolPushGroups has the rules: rule scope, reserved
    // copies, and never a stack in a location with "Sell from" off, #194).
    const groups = G.manapoolPushGroups(picks);

    const keys = [...groups.keys()];
    const asks = G.manapoolListingAsks();
    const entries = keys.map(key => {
      const g = groups.get(key);
      return { card: g.sample, quantity: g.targetSum, price: listPriceFor(g.sample, asks), condition: g.sample.condition };
    });

    // Send only what changes (#482): read what Manapool shows right now and
    // leave out every listing already at exactly this quantity and price.
    // No live read, no push - never a silent fall back to sending everything.
    UI.toastProgress("Reading your live Manapool listings…");
    let live;
    try {
      live = G.manapoolLiveListings((await G.api("/api/manapool/listings")).listings);
    } catch (e) {
      UI.toastProgress("");
      UI.toast("Couldn't read your live Manapool listings, so nothing was pushed: " + e.message, "err",
        "A push checks what's already on Manapool first, so it only sends listings that would change. Try again in a bit.");
      return;
    }
    UI.toastProgress("");
    const toSend = G.splitManapoolPush(keys, entries, live);
    const upToDate = toSend.upToDate;

    const { succeeded, failed, stoppedEarly, stoppedAt, totalBatches, batchSize, reasons } =
      await pushManapoolBatch(toSend.entries, toSend.keys, "Pushing");

    // A listing already right on Manapool counts as a confirmed send at
    // those numbers: same listed counts and "last sent" price.
    const confirmed = succeeded.concat(upToDate.map(u => ({ key: u.key, quantity: u.quantity, warning: null })));
    for (const s of confirmed) {
      const g = groups.get(s.key);
      G.applyManapoolPushToStacks(s.key, g.perStack, g.targetSum, s.quantity, "Manapool push");
    }
    // What went out becomes each listing's "last sent" price (#228).
    const sentPrice = new Map(keys.map((k, i) => [k, entries[i].price]));
    G.recordManapoolAsks(confirmed.map(s => ({ key: s.key, price: sentPrice.get(s.key) })), "Manapool push");
    if (confirmed.length) G.persist("Manapool push");
    const upToDateNote = upToDate.length
      ? " " + upToDate.length.toLocaleString() + " " + (upToDate.length === 1 ? "was" : "were") + " already up to date on Manapool." : "";

    if (stoppedEarly) {
      UI.toast("Stopped after batch " + (stoppedAt + 1) + "/" + totalBatches +
        " - two batches in a row came back with nothing confirmed, which usually means Manapool itself is rejecting requests right now (bad token, an outage). " +
        (succeeded.length ? succeeded.length + " listing(s) before that went through. " : "") +
        (upToDateNote ? upToDateNote.trim() + " " : "") +
        "Try again in a bit - Evaluate first to pick up what's still outstanding.",
        "err", reasons && reasons.length ? "Reason(s) from the last batch:\n" + reasons.map(r => "• " + r).join("\n") : undefined);
      renderPlan();
      refreshUnprofitableCount();
      return;
    }

    // A confirmed push is one of three things (#225): copies listed as sent,
    // fewer copies than sent (Manapool's count wins locally, see warning),
    // or a group sent with 0 copies - nothing free to sell (all kept,
    // reserved for an open order, or in a location with "Sell from" off),
    // which takes it off Manapool rather than listing it.
    const short = succeeded.filter(s => s.warning);
    const zero = succeeded.filter(s => !s.warning && groups.get(s.key).targetSum === 0);
    const listed = succeeded.length - short.length - zero.length;
    const label = key => { const r = groups.get(key).sample; return r.name + " (" + G.recPrinting(r) + ")"; };
    const section = (title, lines) => lines.length
      ? title + "\n" + lines.slice(0, 10).map(l => "• " + l).join("\n") + (lines.length > 10 ? "\n… and " + (lines.length - 10) + " more" : "")
      : "";
    const detail = [
      totalBatches > 1 ? "Sent in " + totalBatches + " batch(es) of up to " + batchSize + " listing(s) each, each confirmed before the next was sent." : "",
      section("Fewer copies on Manapool than sent:", short.map(s => s.warning)),
      section("Sent with 0 copies, so not for sale on Manapool:", zero.map(s => label(s.key))),
      section("Failures:", failed.map(f => f.error))
    ].filter(Boolean).join("\n\n");
    const head = listed ? "Pushed " + listed + "/" + groups.size + " listing(s) to Manapool"
      : !toSend.entries.length ? "Nothing needed sending to Manapool"
      : "Nothing was listed for sale on Manapool";
    UI.toast(head + " (" + tickedRows().length + " ticked" + (totalBatches > 1 ? ", " + totalBatches + " batches" : "") + ")." +
      upToDateNote +
      (short.length ? " " + short.length + " came back with fewer copies than sent." : "") +
      (zero.length ? " " + zero.length + " had no copies free to sell (kept, sold to an open order, or in a location with \"Sell from\" off), so they were set to 0." : "") +
      (failed.length ? " " + failed.length + " failed." : ""),
      failed.length || short.length ? "err" : "ok", detail || undefined);
    renderPlan();
    refreshUnprofitableCount();
  }

  /* ============================== Delist all from Manapool ============================== */
  async function delistAll() {
    // Account-wide "take everything off Manapool" (#96): built from a fresh
    // read of the LIVE listings, not local listedQty, so it also takes down
    // sealed, anything listed on Manapool directly, and anything whose local
    // count is stale. Not scoped to the Evaluate plan's filter or ticks. If
    // the live read fails, nothing is sent - the button must never report
    // "everything is down" from a guess.
    UI.toastProgress("Reading your live Manapool listings…");
    let listings;
    try {
      listings = (await G.api("/api/manapool/listings")).listings || [];
    } catch (e) {
      UI.toastProgress("");
      UI.toast("Couldn't read your live Manapool listings, so nothing was delisted: " + e.message, "err");
      return;
    }
    UI.toastProgress("");
    const { cards, sealed, cantDelist } = G.delistAllPlan(listings);
    const total = cards.length + sealed.length;
    if (!total) {
      UI.toast(cantDelist.length
        ? "Manapool shows " + cantDelist.length + " listing(s), but none Grimoire can identify to delist - take them down on Manapool directly."
        : "Nothing is listed on Manapool right now.", "err");
      return;
    }
    // Irreversible from Manapool's side (relisting means pushing again from
    // Evaluate) - the one place in this page that gets the extra
    // typed-confirmation friction, same policy as Settings' "Erase this
    // collection."
    const parts = [];
    if (cards.length) parts.push(cards.length + " card listing" + (cards.length === 1 ? "" : "s"));
    if (sealed.length) parts.push(sealed.length + " sealed listing" + (sealed.length === 1 ? "" : "s"));
    const ok = await UI.confirmDialog("Delist ALL " + parts.join(" and ") + " live on Manapool right now?\n\n" +
      "This sets every quantity to 0 on your real Manapool account, right now, including listings you made on " +
      "Manapool directly. To relist afterward you'd need to push again from Evaluate." +
      (cantDelist.length ? "\n\n" + cantDelist.length + " other listing(s) can't be identified and would stay up." : ""),
      { title: "Delist everything?", danger: true, okLabel: "Delist all", typeToConfirm: "DELIST" });
    if (!ok) return;

    const cardRun = cards.length
      ? await pushManapoolBatch(cards.map(c => c.entry), cards.map(c => c.key), "Delisting")
      : { succeeded: [], failed: [], stoppedEarly: false };
    // Sealed goes even if the card run stopped early: an emergency stop
    // should take down whatever it still can.
    const sealedRun = sealed.length
      ? await pushManapoolBatch(sealed.map(s => s.entry), sealed.map(s => s.key), "Delisting", "/api/manapool/list-bulk-sealed")
      : { succeeded: [], failed: [], stoppedEarly: false };

    // Everything that didn't come down stays listed locally; everything else
    // (including stale local counts Manapool never had) goes to 0.
    // Only a confirmed quantity of 0 counts as down: an "ok" that comes back
    // still showing copies listed is reported as a failure, not as delisted.
    const stillUp = [];
    const confirmedDown = run => new Set(run.succeeded.filter(s => {
      if (Number(s.quantity) > 0) { stillUp.push({ key: s.key, error: "Manapool still shows " + s.quantity + " listed after the delist." }); return false; }
      return true;
    }).map(s => s.key));
    const downCards = confirmedDown(cardRun);
    const downSealed = confirmedDown(sealedRun);
    const keep = { cards: new Set(), sealed: new Set() };
    for (const c of cards) if (!downCards.has(c.key)) keep.cards.add(c.key);
    for (const s of sealed) {
      if (downSealed.has(s.key)) continue;
      keep.sealed.add(s.key);
      if (s.tcgplayerProductId) keep.sealed.add(s.tcgplayerProductId);
    }
    const local = G.applyDelistAll(keep, "Delist all");
    if (local.changed) G.persist("Delist all");

    const down = downCards.size + downSealed.size;
    const failed = cardRun.failed.concat(sealedRun.failed, stillUp);
    const notSent = total - down - failed.length;
    const problems = failed.length + notSent + cantDelist.length;
    const detail = [];
    if (failed.length) detail.push("Failed:\n" + failed.slice(0, 10).map(f => "• " + f.error).join("\n") +
      (failed.length > 10 ? "\n… and " + (failed.length - 10) + " more" : ""));
    if (notSent > 0) detail.push(notSent + " listing(s) were not sent: Manapool rejected two batches in a row, " +
      "which usually means it is rejecting every request right now (bad token, an outage).");
    if (cantDelist.length) detail.push("Can't identify these, so they are still up - take them down on Manapool directly:\n" +
      cantDelist.slice(0, 10).map(n => "• " + n).join("\n") + (cantDelist.length > 10 ? "\n… and " + (cantDelist.length - 10) + " more" : ""));
    UI.toast("Delisted " + down + "/" + (total + cantDelist.length) + " live Manapool listing(s)" +
      (sealed.length ? " (" + downSealed.size + " sealed)" : "") + "." +
      (problems ? " " + problems + " still listed - see details." : ""),
      problems ? "err" : "ok", detail.length ? detail.join("\n\n") : undefined);
    renderPlan();
    refreshUnprofitableCount();
  }

  /* ============================== Delist unprofitable ============================== */
  // The count on the button comes from the local stacks (listed, priced at
  // askPrice); the push itself re-reads the live listings first, like Delist all.
  function refreshUnprofitableCount() {
    const n = G.delistUnprofitablePlan().items.length;
    $("unprofitableCount").textContent = n ? "(" + n + ")" : "";
    $("btnDelistUnprofitable").disabled = !manapoolOn || mpOtherApp || !n;
  }
  async function delistUnprofitable() {
    UI.toastProgress("Reading your live Manapool listings…");
    let listings;
    try {
      listings = (await G.api("/api/manapool/listings")).listings || [];
    } catch (e) {
      UI.toastProgress("");
      UI.toast("Couldn't read your live Manapool listings, so nothing was delisted: " + e.message, "err");
      return;
    }
    UI.toastProgress("");
    const { cards, items, minPct } = G.delistUnprofitablePlan(listings);
    const minWords = G.minProfitWords(minPct);
    if (!cards.length) {
      UI.toast("No live Manapool card listing is " + minWords + ".", "ok");
      refreshUnprofitableCount();
      return;
    }
    const usd = n => "$" + Number(n).toFixed(2);
    const lines = items.slice(0, 10).map(i => "• " + i.name + ": listed " + usd(i.price) + ", cost " + usd(i.cost) +
      ", profit " + G.pct(i.pct));
    const ok = await UI.confirmDialog("Take " + cards.length + " listing" + (cards.length === 1 ? "" : "s") +
      " down from Manapool? Each is listed " + minWords + ".\n\n" + lines.join("\n") +
      (items.length > 10 ? "\n… and " + (items.length - 10) + " more" : "") +
      "\n\nThis sets them to 0 on your real Manapool account right now. Everything else stays up.",
      { title: "Delist unprofitable?", danger: true, okLabel: "Delist " + cards.length });
    if (!ok) return;

    const run = await pushManapoolBatch(cards.map(c => c.entry), cards.map(c => c.key), "Delisting");
    // Only a confirmed quantity of 0 counts as down, same as Delist all.
    const stillUp = [];
    const down = new Set(run.succeeded.filter(s => {
      if (Number(s.quantity) > 0) { stillUp.push({ key: s.key, error: "Manapool still shows " + s.quantity + " listed after the delist." }); return false; }
      return true;
    }).map(s => s.key));
    const local = G.applyDelistUnprofitable(down, "Delist unprofitable");
    if (local.changed) G.persist("Delist unprofitable");

    const failed = run.failed.concat(stillUp);
    const notSent = cards.length - down.size - failed.length;
    const problems = failed.length + Math.max(0, notSent);
    const detail = [];
    if (failed.length) detail.push("Failed:\n" + failed.slice(0, 10).map(f => "• " + f.error).join("\n") +
      (failed.length > 10 ? "\n… and " + (failed.length - 10) + " more" : ""));
    if (notSent > 0) detail.push(notSent + " listing(s) were not sent: Manapool rejected two batches in a row, " +
      "which usually means it is rejecting every request right now (bad token, an outage).");
    UI.toast("Delisted " + down.size + "/" + cards.length + " unprofitable Manapool listing(s)." +
      (problems ? " " + problems + " still listed - see details." : ""),
      problems ? "err" : "ok", detail.length ? detail.join("\n\n") : undefined);
    renderPlan();
    refreshUnprofitableCount();
  }

  // Plain-words reason the Manapool buttons are greyed out.
  function setWhyOff(why) {
    document.querySelectorAll(".mp-why-off").forEach(el => { el.textContent = why; el.hidden = !why; });
    for (const id of ["btnPushMp", "btnDelistAll", "btnDelistUnprofitable", "lpFetch"]) {
      const b = $(id);
      if (why) { if (b.dataset.t == null) b.dataset.t = b.title; b.title = why; }
      else if (b.dataset.t != null) b.title = b.dataset.t;
    }
  }

  async function refreshManapoolButton() {
    try {
      const d = await G.api("/api/integrations");
      const on = !!(d.manapool.featureOn && d.manapool.hasToken);
      manapoolOn = on;
      // #499: another tool manages this seller's listings on Mana Pool: read, never change.
      mpOtherApp = on && !!d.manapool.otherInventoryApp;
      $("btnPushMp").disabled = !on || mpOtherApp;
      $("btnDelistAll").disabled = !on || mpOtherApp;
      refreshUnprofitableCount();
      $("lpFetch").disabled = !on;
      setWhyOff(mpOtherApp ? "Another app manages your Mana Pool listings, so Grimoire can't change them." : on ? "" : !d.manapool.featureOn
        ? "Manapool isn't switched on for this site" + (G.isAdmin ? " (set manapool.enabled in config.json and restart)." : "; ask the site admin.")
        : "Connect your Manapool account in Settings \u2192 Integrations first.");
      return on;
    } catch (e) {
      manapoolOn = false;
      $("btnPushMp").disabled = true;
      $("btnDelistAll").disabled = true;
      $("btnDelistUnprofitable").disabled = true;
      $("lpFetch").disabled = true;
      setWhyOff("Couldn't check whether Manapool is connected.");
      return false;
    }
  }

  /* ============================== Your Manapool listings ==============================
     Moved here from Lists & Orders / Order Fulfillment (2026-09-01, user
     request) - a live sync against what's actually listed belongs next to
     this page's own listing-rules plan ("what SHOULD be listed"), not
     buried in the orders workflow. G.syncManapoolListings/manapoolGroup/
     etc. are page-agnostic core.js functions already used elsewhere on this
     page for the push/delist flow above - this section is pure wiring. */
  let manapoolListings = [];
  let manapoolOn = false;
  let mpOtherApp = false;

  /* Everything known locally about this Manapool listing's identity - not just
     the listed-qty sum, but whether a local stack exists at all, and if not,
     whether one exists under the SAME card but a different language/foil/
     condition (a likely data-entry mismatch, not a missing card) - Manapool
     has no concept of storage location, so a listing there can correspond to
     several local rows split across bins.

     Sealed listings (l.kind === "sealed", see integrations.js's
     normalizeListing) match against state.sealed by tcgplayerProductId
     instead - no lang/finish/condition tiers to match on, so no "near"
     mismatch concept either (there's nothing else for it to be mistaken
     for). Before this branch existed, every sealed listing fell through the
     card-only match below with a blank/garbage set+collector from the
     server and always reported "no matching card in local inventory,"
     regardless of what state.sealed actually held. */
  /* Index G.state.cards/sealed by identity ONCE per render rather than
     filtering the whole collection fresh for every listing inside
     localMatchInfo() below - on a large enough account (thousands of
     stacks × over a thousand live listings) that was a real
     O(listings × stacks) hot spot, easily tens of millions of array-filter
     visits, and is exactly why this table looked like it never finished
     loading rather than just taking a moment. */
  function buildLocalMatchIndex() {
    const byIdentity = new Map(), byScryfallId = new Map();
    for (const r of G.state.cards) {
      const key = [r.set, G.normNum(r.collector), r.lang, r.finish, r.condition || "NM"].join("|");
      let arr = byIdentity.get(key);
      if (!arr) { arr = []; byIdentity.set(key, arr); }
      arr.push(r);
      if (r.scryfallId) {
        let arr2 = byScryfallId.get(r.scryfallId);
        if (!arr2) { arr2 = []; byScryfallId.set(r.scryfallId, arr2); }
        arr2.push(r);
      }
    }
    const sealedByTcg = new Map();
    for (const r of G.state.sealed) {
      if (!r.tcgplayerProductId) continue;
      let arr = sealedByTcg.get(r.tcgplayerProductId);
      if (!arr) { arr = []; sealedByTcg.set(r.tcgplayerProductId, arr); }
      arr.push(r);
    }
    return { byIdentity, byScryfallId, sealedByTcg };
  }

  function localMatchInfo(l, idx) {
    if (l.kind === "sealed") {
      const rows = idx.sealedByTcg.get(l.tcgplayerProductId) || [];
      return {
        listed: rows.reduce((s, r) => s + (r.listedQty || 0), 0),
        onHand: rows.reduce((s, r) => s + (r.quantity || 0), 0),
        exactCount: rows.length,
        near: []
      };
    }
    const cond = G.conditionCode(l.condition) || "NM";
    const key = [l.set, G.normNum(l.collector), l.lang, l.finish, cond].join("|");
    const exact = idx.byIdentity.get(key) || [];
    const near = exact.length || !l.scryfallId ? [] : (idx.byScryfallId.get(l.scryfallId) || []);
    return {
      listed: exact.reduce((s, r) => s + (r.listedQty || 0), 0),
      onHand: exact.reduce((s, r) => s + (r.quantity || 0), 0),
      exactCount: exact.length,
      near
    };
  }

  /* A Manapool listing never carries an image URL - best-effort match
     against a stack still owned today with the same identity (blank if
     nothing local matches, which the row's own status column already
     explains); clicking still does a real lookup either way. */
  function ownedImageFor(l) {
    if (!l || l.kind === "sealed" || !l.set || !l.collector) return "";
    const cond = G.conditionCode(l.condition) || "NM";
    const match = G.state.cards.find(r => r.set === l.set && G.normNum(r.collector) === G.normNum(l.collector) &&
      r.lang === l.lang && r.finish === l.finish && (G.conditionCode(r.condition) || "NM") === cond);
    return match ? match.imageUrl : "";
  }
  async function reviewListing(l) {
    if (!l || l.kind === "sealed" || !l.set || !l.collector) return;
    let card;
    try { card = await G.cards.one(l.set, l.collector, l.lang || "en"); }
    catch (e) { return; }
    if (card) UI.reviewCard(card, l.finish);
  }

  function renderManapoolListings() {
    const body = $("lpBody");
    if (!manapoolListings.length) {
      body.innerHTML = UI.emptyRow(8, { icon: "money", title: "No listings loaded.", hint: "Press <b>Fetch listings</b>." });
      return;
    }
    const idx = buildLocalMatchIndex();
    body.innerHTML = manapoolListings.map(l => {
      const isSealed = l.kind === "sealed";
      const info = localMatchInfo(l, idx);
      const local = info.listed;
      let status;
      if (local === l.quantity) status = '<span class="ok-tag">' + UI.icon("circle-check") + " matches</span>";
      else if (local > 0) status = '<span class="short-tag">' + UI.icon("triangle-alert") + " local says " + local + ", Manapool has " + l.quantity + "</span>";
      else if (info.exactCount > 0) status = '<span class="short-tag">' + UI.icon("triangle-alert") + " " + info.onHand + " on hand locally, 0 listed</span>";
      else if (info.near.length) {
        const s = info.near[0];
        status = '<span class="short-tag">' + UI.icon("triangle-alert") + " found locally as " + G.esc(G.LANG_NAMES[s.lang] || s.lang) + ", " +
          G.esc(G.FINISH_NAMES[s.finish] || "Non-foil").toLowerCase() + ", " + G.esc(G.CONDITION_NAMES[s.condition] || s.condition) +
          " — check for a mismatch</span>";
      } else status = '<span class="short-tag">' + UI.icon("triangle-alert") + " no matching " + (isSealed ? "sealed product" : "card") + " in local inventory</span>";
      return '<tr class="' + (isSealed ? "" : "click") + '">' +
        UI.artThumbTd(ownedImageFor(l)) +
        "<td>" + (isSealed || !l.name ? G.esc(l.name || "—") : UI.cardLink(l)) + "</td>" +
        '<td class="muted hide-sm">' + (isSealed
          ? G.esc(String(l.setCode || "").toUpperCase())
          : G.esc(G.printingLabel(l.set, l.collector, l.setName)) + (l.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[l.finish].toLowerCase() : "")) + "</td>" +
        '<td class="hide-sm">' + (isSealed ? '<span class="muted">—</span>' : G.esc(G.CONDITION_NAMES[G.conditionCode(l.condition)] || l.condition || "")) + "</td>" +
        '<td class="num">' + l.quantity + "</td>" +
        '<td class="num hide-sm">' + G.money(l.price) + "</td>" +
        '<td class="num">' + local + "</td>" +
        "<td>" + status + "</td></tr>";
    }).join("");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const l = manapoolListings[i];
      if (!l || l.kind === "sealed") return;
      UI.wireArtHover(tr, ownedImageFor(l));
      tr.onclick = () => reviewListing(l);
    });
    UI.reapplySorts();
  }

  async function fetchManapoolListings(silent) {
    if (!silent) {
      const ok = await UI.confirmDialog("Fetch your current Manapool listings? This overwrites every card's Listed quantity here to " +
        "match Manapool exactly - Manapool is the source of truth, this is not a merge.", { title: "Fetch Manapool listings?", danger: true });
      if (!ok) return;
    }
    $("lpStatus").textContent = "Fetching from Manapool…";
    $("lpFetch").disabled = true;
    try {
      const d = await G.api("/api/manapool/listings");
      manapoolListings = d.listings || [];
      const out = G.syncManapoolListings(manapoolListings);
      // Saved even when no stack changed: the sync also stamps when it ran
      // and which open order pick lists it already accounted for (#86).
      // With no stack changed, that bookkeeping alone doesn't earn an undo
      // slot (an "Undo: Manapool sync" that visibly does nothing).
      if (out.changed) G.persist("Manapool sync"); else G.persistSettings();
      $("lpStatus").textContent = manapoolListings.length + " listing" + (manapoolListings.length === 1 ? "" : "s") +
        " - " + out.changed + " local stack(s) updated to match.";
    } catch (e) {
      $("lpStatus").textContent = "";
      UI.toast("Manapool: " + e.message, "err",
        e.status === 501 ? "Turn it on in config.json (an administrator does this), then connect your account in Settings → Integrations."
          : "The paths and header names live in config.json under manapool - check them against Manapool's current API docs.");
    }
    $("lpFetch").disabled = !manapoolOn;
    renderManapoolListings();
    refreshUnprofitableCount();
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {

    renderCondFields();
    loadPrefs();
    renderRulesList();
    renderExceptions();

    // Drill-through from Movers ("Sell this") lands here with ?q=<name> -
    // force it into view even if the card's listing wouldn't otherwise
    // change, since the whole point of the link was to show that one card.
    const dq = new URLSearchParams(location.search).get("q");
    if (dq) {
      $("planSearch").value = dq;
      $("planShowAll").checked = true;
      // #410: the card filter shows as a chip; clearing it empties the filter box.
      UI.cardFilterChip($("planSearch").closest("div") || $("planSearch"), UI.cardFilterFromUrl(), dq, () => {
        $("planSearch").value = "";
        $("planSearch").dispatchEvent(new Event("input"));
      });
    }
    // #366: the Sold 7d column's Manapool sales, in after the first draw.
    // ?fast=1 opens on the listings that are SELLING FAST, unchanged included.
    const fast = new URLSearchParams(location.search).get("fast") === "1";
    if (fast) { $("planFast").checked = true; $("planShowAll").checked = true; }
    syncFastBox();
    G.on("sold", () => { syncFastBox(); renderPlanRows(); });
    G.loadSoldMine();
    await loadCachedOrders();
    renderPlan();
    if (dq) $("planSearch").scrollIntoView({ block: "center" });

    UI.Autocomplete("excName", "excAcList", () => $("excKeep").focus());
    $("excAdd").onclick = addException;
    $("excName").addEventListener("keydown", e => { if (e.key === "Enter") addException(); });
    $("excKeep").addEventListener("keydown", e => { if (e.key === "Enter") addException(); });

    $("prefSave").onclick = savePrefs;
    $("btnNewRule").onclick = () => openRuleModal("");
    $("rmCancel").onclick = () => UI.hideModal("ruleModal");
    $("rmSave").onclick = saveRule;
    $("rmDelete").onclick = () => { UI.hideModal("ruleModal"); if (editRuleId) deleteRule(editRuleId); };
    $("ruleModal").addEventListener("click", e => { if (e.target.id === "ruleModal") UI.hideModal("ruleModal"); });

    // A new filter or a fresh plan starts back at the first page of rows.
    const fresh = fn => () => { rowCap = G.PLAN_ROW_CAP; fn(); };
    $("planSearch").oninput = G.debounce(fresh(renderPlanRows), 150);
    $("planShowAll").onchange = fresh(renderPlan);
    $("planFast").onchange = fresh(renderPlanRows);
    $("planRule").onchange = fresh(renderPlan);
    // Evaluate re-reads the orders cache first (#107), so an order fetched
    // on Lists since this page opened is held back too.
    $("btnEvaluate").onclick = fresh(async () => { await loadCachedOrders(); renderPlan(); });
    $("planMoreBtn").onclick = () => { rowCap += G.PLAN_ROW_CAP; renderPlanRows(); };
    // A column sort orders the whole plan, then redraws its first rows.
    UI.dataSort($("planBody").closest("table"), () => renderPlanRows());
    $("planApply").onclick = applyPlan;
    $("planAll").onchange = () => {
      const on = $("planAll").checked;
      for (const p of plan) { if (on) unticked.delete(p.key); else unticked.add(p.key); }
      $("planBody").querySelectorAll(".ppick").forEach(c => { c.checked = on; });
    };
    $("btnPushMp").onclick = pushToManapool;
    $("btnDelistAll").onclick = delistAll;
    $("btnDelistUnprofitable").onclick = delistUnprofitable;
    $("lpFetch").onclick = () => fetchManapoolListings(false);
    renderManapoolListings();
    refreshManapoolButton();
    $("btnExport").onclick = () => {
      try {
        const out = G.exportTcgCsv();
        UI.toast("Exported " + out.lines + " line(s), " + out.cards + " card(s).", "ok");
      } catch (e) {
        UI.toast(e.message, "err");
      }
    };

    G.on("change", () => { renderRulesList(); });
    // The tab is remembered (UI.pageTabs); an old #pricing / #rules link still opens it.
    tabs = UI.pageTabs({ tabs: [
      { id: "rules", button: "tabRules", panes: ["paneRules"] },
      { id: "evaluate", button: "tabEvaluate", panes: ["paneEvaluate"] },
      { id: "pricing", button: "tabPricing", panes: ["panePricing"] },
      { id: "sealed", button: "tabSealed", panes: ["paneSealed"] },
      { id: "manapool", button: "tabManapool", panes: ["paneManapool"] }
    ], def: "evaluate", onShow: onTab });
  });
})();
