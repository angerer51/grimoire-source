
"use strict";
(function () {
  const $ = UI.$;
  let editId = null;
  let draftCriteria = G.newCriteriaBox();   // criteria being edited in the modal
  let testPrintings = [];
  let viewMode = "compact";                 // "compact" (table) or "cards" (tiles)

  const PRESETS = G.LOC_TYPES;

  function typeSelectHtml(selected) {
    const known = PRESETS.includes(selected);
    return PRESETS.map(t => '<option value="' + G.esc(t) + '"' + (t === selected ? " selected" : "") + ">" +
      G.esc(t) + "</option>").join("") +
      '<option value="__custom"' + (selected && !known ? " selected" : "") + ">Custom…</option>";
  }
  function typeFromPair(selEl, customEl) {
    return selEl.value === "__custom" ? (customEl.value.trim() || "Custom") : selEl.value;
  }

  /* ============================== Sorting method editor (#267) ============================== */
  /* One preset dropdown ("Not set", the ready-made setups, "Custom…") over a
     levels list: a field and a direction per row, "+ Add level", a remove X.
     Picking a preset fills the levels; editing a level afterwards switches
     the dropdown to Custom. Used by the Add form (prefix "new") and the Edit
     dialog ("el"). get() is the method to save: null when not set. */
  function sortEditor(prefix) {
    const sel = $(prefix + "SortPreset"), wrap = $(prefix + "SortLevels"), list = $(prefix + "SortList"), add = $(prefix + "SortAdd");
    let levels = [];
    sel.innerHTML = '<option value="">Not set</option>' +
      G.LOC_SORT_PRESETS.map(p => '<option value="' + G.esc(p.id) + '">' + G.esc(p.label) + "</option>").join("") +
      '<option value="__custom">Custom…</option>';
    const render = () => {
      wrap.hidden = sel.value === "";
      const used = new Set(levels.map(l => l.field));
      list.innerHTML = levels.map((l, i) => {
        const f = G.LOC_SORT_FIELDS.find(x => x.id === l.field);
        return '<div class="sort-level" data-i="' + i + '"><span class="lvl">' + (i + 1) + "</span>" +
          '<select data-k="field" aria-label="Level ' + (i + 1) + ' sorts by">' +
            G.LOC_SORT_FIELDS.map(x => '<option value="' + x.id + '"' + (x.id === l.field ? " selected" : used.has(x.id) ? " disabled" : "") +
              ">" + G.esc(x.label) + "</option>").join("") + "</select>" +
          '<select data-k="dir" aria-label="Level ' + (i + 1) + ' direction">' +
            '<option value="asc"' + (l.dir === "asc" ? " selected" : "") + ">" + G.esc(f.dirs[0]) + "</option>" +
            '<option value="desc"' + (l.dir === "desc" ? " selected" : "") + ">" + G.esc(f.dirs[1]) + "</option></select>" +
          '<button class="small ghost" type="button" data-k="remove" title="Remove this level" aria-label="Remove this level">' + UI.icon("x") + "</button>" +
          "</div>";
      }).join("");
      add.disabled = levels.length >= Math.min(G.LOC_SORT_MAX_LEVELS, G.LOC_SORT_FIELDS.length);
    };
    // A hand edit: the dropdown says Custom unless the levels still match a preset.
    const edited = () => {
      const p = G.locSortPresetOf(levels);
      sel.value = p ? p.id : levels.length ? "__custom" : "";
      render();
    };
    sel.onchange = () => {
      const p = G.LOC_SORT_PRESETS.find(x => x.id === sel.value);
      if (p) levels = p.levels.map(l => Object.assign({}, l));
      else if (sel.value === "") levels = [];
      else if (!levels.length) levels = [{ field: G.LOC_SORT_FIELDS[0].id, dir: "asc" }];
      render();
    };
    list.onchange = e => {
      const row = e.target.closest(".sort-level");
      if (!row) return;
      const l = levels[Number(row.dataset.i)];
      if (e.target.dataset.k === "field") l.field = e.target.value;
      if (e.target.dataset.k === "dir") l.dir = e.target.value;
      edited();
    };
    list.onclick = e => {
      const btn = e.target.closest('[data-k="remove"]');
      if (!btn) return;
      levels.splice(Number(btn.closest(".sort-level").dataset.i), 1);
      edited();
    };
    add.onclick = () => {
      const used = new Set(levels.map(l => l.field));
      const f = G.LOC_SORT_FIELDS.find(x => !used.has(x.id));
      if (!f) return;
      levels.push({ field: f.id, dir: "asc" });
      edited();
    };
    return {
      set(method) {
        levels = (G.normalizeSortMethod(method) || []).map(l => Object.assign({}, l));
        const p = G.locSortPresetOf(levels);
        sel.value = p ? p.id : levels.length ? "__custom" : "";
        render();
      },
      get: () => (sel.value === "" ? null : G.normalizeSortMethod(levels))
    };
  }
  let newSort = null, editSort = null;   // the Add form's and the Edit dialog's editors
  const sortText = m => G.locSortSummary(m) || "none";

  /* ============================== Grid of locations ============================== */
  function populateTypeFilter() {
    const sel = $("locTypeFilter");
    const prev = sel.value;
    const types = [...new Set(G.state.locations.map(l => l.type).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = '<option value="">All types</option>' +
      types.map(t => '<option value="' + G.esc(t) + '"' + (t === prev ? " selected" : "") + ">" + G.esc(t) + "</option>").join("");
  }

  // The locations the search box and type filter leave showing.
  function shownLocations() {
    const q = $("locSearch").value.trim().toLowerCase();
    const type = $("locTypeFilter").value;
    return G.sortedLocations().filter(l =>
      (!q || (l.name + " " + l.type + " " + (l.notes || "")).toLowerCase().includes(q)) &&
      (!type || l.type === type));
  }
  function renderGrid() {
    populateTypeFilter();
    const list = shownLocations();
    const total = G.state.locations.length;
    const withRules = G.state.locations.filter(l => l.putaway && l.putaway.enabled).length;
    $("locHdr").textContent = total
      ? "— " + total + " location" + (total === 1 ? "" : "s") + (G.simpleMode ? "" : ", " + withRules + " in the putaway rotation")
      : "";

    $("locTableWrap").hidden = viewMode !== "compact";
    $("locGrid").hidden = viewMode !== "cards";
    if (viewMode === "compact") renderTable(list, total); else renderCardGrid(list, total);
  }

  function putawayCellHtml(l) {
    if (l.staging) return '<span class="faint"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#inbox></use></svg> tray</span>';
    if (!(l.putaway && l.putaway.enabled)) return '<span class="faint">off</span>';
    const onRules = G.criteriaConditions(l.putaway.rules).filter(r => r.on);
    if (!onRules.length) return '<span class="muted">catch-all</span>';
    return '<span class="good" title="' + G.esc(G.criteriaExpressionText(l.putaway.rules)) + '">' +
      onRules.length + " rule" + (onRules.length === 1 ? "" : "s") + "</span>";
  }

  function renderTable(list, total) {
    const body = $("locTableBody");
    if (!total) {
      body.innerHTML = UI.emptyRow(9, { icon: "locations", title: "No locations yet.",
        hint: "Add one above — a name and a type is enough to start." });
      return;
    }
    if (!list.length) { body.innerHTML = UI.emptyRow(9, { icon: "search", title: "No locations match that filter." }); return; }

    const hid = G.simpleMode ? " hidden" : ""; // putaway/priority columns are full-mode only
    body.innerHTML = list.map(l => {
      const st = G.locStats(l.id);
      const cardsCls = st.over || (st.cap != null && st.free === 0) ? " class=\"num bad\""
        : (st.cap != null && st.fillPct >= 85) ? " class=\"num warn\"" : ' class="num"';
      const cardsTxt = st.cap != null ? st.cards + " / " + st.cap : String(st.cards);
      const nameFlags = (l.sellFrom ? '<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#tag></use></svg> ' : "") + G.esc(l.name);
      const titleParts = [];
      if (l.notes) titleParts.push(l.notes);
      if (l.sellFrom) titleParts.push("Sell from this location");
      if (l.sortMethod) titleParts.push("Sorted by " + G.locSortSummary(l.sortMethod));
      return '<tr data-id="' + G.esc(l.id) + '">' +
        '<td' + (titleParts.length ? ' title="' + G.esc(titleParts.join(" — ")) + '"' : "") + '>' + nameFlags + "</td>" +
        "<td>" + G.esc(l.type) + "</td>" +
        "<td" + cardsCls + ">" + cardsTxt + "</td>" +
        '<td class="num hide-md">' + G.money(st.value) + "</td>" +
        "<td" + hid + ">" + putawayCellHtml(l) + "</td>" +
        '<td class="num hide-lg"' + hid + '>' + (Number(l.priority) ? Number(l.priority) : '<span class="faint">—</span>') + "</td>" +
        '<td class="num hide-lg"' + hid + '>' + (Number(l.pickPriority) ? Number(l.pickPriority) : '<span class="faint">—</span>') + "</td>" +
        '<td class="num hide-lg"' + hid + (l.walkSeq == null ? ' data-v="999999999"' : "") + ">" + (l.walkSeq != null ? l.walkSeq : '<span class="faint">—</span>') + "</td>" +
        '<td class="row-actions"><button class="small" data-act="edit">Edit</button>' +
          '<button class="small ghost" data-act="view">View</button>' +
          '<button class="small ghost" data-act="dup">Dup</button></td>' +
        "</tr>";
    }).join("");

    for (const tr of body.querySelectorAll("tr[data-id]")) {
      const l = G.locById(tr.dataset.id);
      if (!l) continue;
      tr.querySelector('[data-act="edit"]').onclick = () => openEdit(l.id);
      tr.querySelector('[data-act="view"]').onclick = () => { UI.go("/inventory.html?loc=" + encodeURIComponent(l.id)); };
      tr.querySelector('[data-act="dup"]').onclick = () => duplicate(l);
    }
    UI.reapplySorts();
  }

  function renderCardGrid(list, total) {
    const grid = $("locGrid");
    if (!total) {
      grid.innerHTML = '<div class="loc-empty">No locations yet. Add one above — a name and a type is enough to start.</div>';
      return;
    }
    if (!list.length) { grid.innerHTML = '<div class="loc-empty">No locations match that filter.</div>'; return; }

    grid.innerHTML = "";
    for (const l of list) {
      const st = G.locStats(l.id);
      const onRules = G.criteriaConditions(l.putaway && l.putaway.rules).filter(r => r.on);
      const div = document.createElement("div");
      div.className = "loc-card" + (st.over || (st.cap != null && st.free === 0) ? " full" : "");
      let capHtml = "";
      if (st.cap != null) {
        const p = Math.min(100, st.fillPct || 0);
        const cls = p >= 100 ? "hot" : p >= 85 ? "warm" : "";
        capHtml = '<div class="capbar"><span class="' + cls + '" style="width:' + p.toFixed(1) + '%"></span></div>' +
          '<div class="capline">' + st.cards + " / " + st.cap + " cards" +
          (st.over ? ' · <span class="bad">over by ' + (st.cards - st.cap) + "</span>"
            : st.free === 0 ? ' <span class="badge cap">FULL</span>' : " · " + st.free + " free") + "</div>";
      } else {
        capHtml = '<div class="capline">no ceiling</div>';
      }
      div.innerHTML =
        '<div class="ln">' + G.esc(l.name) +
          ' <span class="pill type">' + G.esc(l.type) + "</span>" +
          (l.staging ? '<span class="pill tray"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#inbox></use></svg> sorting tray</span>'
            : l.putaway && l.putaway.enabled
              ? '<span class="pill on">' + (onRules.length ? onRules.length + " rule" + (onRules.length === 1 ? "" : "s") : "catch-all") + "</span>"
              : '<span class="pill off">putaway off</span>') +
          (l.maxPerName != null ? '<span class="pill">max ' + l.maxPerName + " / card</span>" : "") +
          (Number(l.priority) ? '<span class="pill">priority ' + Number(l.priority) + "</span>" : "") +
          (Number(l.pickPriority) ? '<span class="pill">pick priority ' + Number(l.pickPriority) + "</span>" : "") +
          (l.sellFrom ? '<span class="pill on"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#tag></use></svg> sell from here</span>' : "") +
        "</div>" +
        '<div class="lstats"><span><b>' + st.cards + "</b> cards</span><span><b>" + st.rows +
          "</b> stacks</span><span><b>" + G.money(st.value) + "</b> value</span>" +
          (st.cost ? "<span><b>" + G.money(st.cost) + "</b> cost</span>" : "") +
          (st.listed ? '<span><b>' + st.listed + "</b> listed</span>" : "") + "</div>" +
        (l.sortMethod ? '<div class="lsort"><span class="pill" title="Sorting method: how the cards inside are arranged">' +
          UI.icon("list") + " " + G.esc(G.locSortSummary(l.sortMethod)) + "</span></div>" : "") +
        capHtml +
        (l.staging
          ? '<div class="rules faint">Cards arrive here. File them out with ' +
            '<a href="/putaway.html?bin=' + encodeURIComponent(l.id) + '">Putaway → From a bin</a>.</div>'
          : onRules.length
            ? '<div class="rules"><code>' + G.esc(G.criteriaExpressionText(l.putaway.rules)) + "</code></div>"
            : (l.putaway && l.putaway.enabled ? '<div class="rules faint">Catch-all — anything can land here.</div>' : "")) +
        (l.notes ? '<div class="lnote">' + G.esc(l.notes) + "</div>" : "") +
        '<div class="lacts">' +
          '<button class="small" data-act="edit">Edit &amp; rules</button>' +
          '<button class="small" data-act="view">View cards</button>' +
          (!l.staging && l.putaway && l.putaway.enabled
            ? '<button class="small ghost" data-act="belongs"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#target></use></svg> What belongs here?</button>' : "") +
          '<button class="small ghost" data-act="dup">Duplicate</button>' +
        "</div>";
      div.querySelector('[data-act="edit"]').onclick = () => openEdit(l.id);
      div.querySelector('[data-act="view"]').onclick = () => { UI.go("/inventory.html?loc=" + encodeURIComponent(l.id)); };
      if (div.querySelector('[data-act="belongs"]')) {
        div.querySelector('[data-act="belongs"]').onclick = () => {
          UI.go("/putaway.html?to=" + encodeURIComponent(l.id) + "#to");
        };
      }
      div.querySelector('[data-act="dup"]').onclick = () => duplicate(l);
      grid.appendChild(div);
    }
  }

  // Fresh ids for every leaf condition, so the duplicate's rows are not
  // literally the same objects (and datalist ids like "opts_<id>") as the
  // original - structure (combinator/not/groups) is preserved as-is.
  function cloneCriteriaBox(box) {
    const b = G.normalizeCriteriaBox(box);
    return {
      combinator: b.combinator, not: b.not,
      conditions: b.conditions.map(r => Object.assign({}, r, { id: G.uid() })),
      groups: b.groups.map(g => ({
        combinator: g.combinator, not: g.not,
        conditions: g.conditions.map(r => Object.assign({}, r, { id: G.uid() }))
      }))
    };
  }

  function duplicate(l) {
    let name = l.name + " (copy)";
    let n = 2;
    while (G.state.locations.some(x => x.name.toLowerCase() === name.toLowerCase())) {
      name = l.name + " (copy " + (n++) + ")";
    }
    const copy = G.createLocation({
      name, type: l.type, maxCards: l.maxCards, maxPerName: l.maxPerName,
      priority: l.priority, pickPriority: l.pickPriority, staging: l.staging, sellFrom: l.sellFrom, notes: l.notes,
      sortMethod: l.sortMethod, cardsPerPage: l.cardsPerPage,
      putaway: { enabled: l.putaway.enabled, rules: cloneCriteriaBox(l.putaway.rules) }
    });
    G.state.locations.push(copy);
    G.logAudit({ action: "location", to: name, note: 'Duplicated location "' + l.name + '" as "' + name + '" with its putaway rules' });
    G.persist();
    UI.toast('Created "' + name + '" with the same rules. Undo removes it.', "ok");
  }

  /* ============================== Add ============================== */
  function addLocation() {
    const name = $("newName").value.trim();
    if (!name) { UI.setStatus("addStatus", "Enter a location name.", "err"); $("newName").focus(); return; }
    if (G.state.locations.some(l => l.name.toLowerCase() === name.toLowerCase())) {
      UI.setStatus("addStatus", 'A location named "' + name + '" already exists.', "err");
      return;
    }
    const type = typeFromPair($("newType"), $("newCustom"));
    const l = G.createLocation({
      name, type,
      maxCards: $("newMax").value === "" ? null : Math.max(0, parseInt($("newMax").value, 10) || 0),
      maxPerName: $("newPerName").value === "" ? null : Math.max(0, parseInt($("newPerName").value, 10) || 0),
      priority: parseInt($("newPriority").value, 10) || 0,
      pickPriority: parseInt($("newPickPriority").value, 10) || 0,
      staging: $("newStaging").checked,
      sellFrom: $("newSellFrom").checked,
      sortMethod: newSort.get()
    });
    G.state.locations.push(l);
    G.logAudit({ action: "location", to: name, note: 'Created location "' + name + '" (' + type + ")" +
      (l.staging ? ", sorting tray" : "") +
      (l.sellFrom ? ", sell from here" : "") +
      (l.maxCards == null ? "" : ", ceiling " + l.maxCards + " cards") +
      (l.maxPerName == null ? "" : ", max " + l.maxPerName + " per card") +
      (l.sortMethod ? ", sorted by " + G.locSortSummary(l.sortMethod) : "") });
    G.persist();
    $("newName").value = ""; $("newCustom").value = "";
    $("newMax").value = ""; $("newPerName").value = ""; $("newStaging").checked = false; $("newSellFrom").checked = false;
    newSort.set(null);
    UI.setStatus("addStatus", "Added " + name + " (" + type + ")." +
      (G.simpleMode ? "" : l.staging ? " Receive cards into it, then file them out from the Putaway page."
        : " Open it to set putaway rules."), "ok");
    $("newName").focus();
  }

  /* ============================== Rule editor ============================== */
  function updateRuleBadge() {
    const all = G.criteriaConditions(draftCriteria);
    const on = all.filter(r => r.on).length;
    $("elRuleCount").textContent = all.length
      ? on + " of " + all.length + " condition" + (all.length === 1 ? "" : "s") + " active"
      : "";
  }
  function renderRules() {
    G.renderCriteriaBuilder($("elRules"), draftCriteria, () => { updateRuleBadge(); runTest(); });
    updateRuleBadge();
    runTest();
  }

  /* ============================== Rule test ============================== */
  async function loadTestPrintings(name) {
    testPrintings = await UI.loadPrintingSelect("elTestPrint", name);
    runTest();
  }

  function runTest() {
    const out = $("elTestOut");
    const i = parseInt($("elTestPrint").value, 10);
    const c = testPrintings[i];
    if (!c) { out.innerHTML = '<span class="muted">Pick a card above and this shows which rules it passes.</span>'; return; }
    const shaped = G.shapeForRuleTest(c, $("elTestFoil").value, 1);
    const active = G.criteriaConditions(draftCriteria).filter(r => r.on);
    if (!active.length) {
      out.innerHTML = "<b>" + UI.cardLink(c) + "</b> would land here — there are no active conditions, " +
        "so this location accepts everything.";
      return;
    }
    const lines = active.map(r => {
      const ok = G.matchRule(shaped, r);
      return '<div>' + (ok ? '<span class="good">' + UI.icon("check") + "</span>" : '<span class="bad">' + UI.icon("x") + "</span>") +
        " <code>" + G.esc(G.ruleText(r)) + "</code></div>";
    });
    const all = G.matchesCriteria(shaped, draftCriteria);
    const st = G.locStats(editId);
    const full = st.cap != null && st.free < 1;
    out.innerHTML = "<b>" + UI.cardLink(c) + "</b> — " +
      (all ? (full ? '<span class="warn">passes every rule, but this location is full.</span>'
                   : '<span class="good">belongs here.</span>')
           : '<span class="bad">does not belong here.</span>') +
      '<div style="margin-top:6px">' + lines.join("") + "</div>" +
      '<div class="muted" style="margin-top:6px">Type line: ' + G.esc(c.typeLine || "—") +
      " · identity " + G.normColors(c.colorIdentity).join("") + " · " + G.esc(c.rarity || "?") + "</div>";
  }

  /* ============================== Edit modal ============================== */
  function openEdit(id, opts) {
    const l = G.locById(id);
    if (!l) return;
    editId = id;
    $("elTitle").textContent = "Edit " + l.name;
    $("elType").innerHTML = typeSelectHtml(l.type);
    $("elCustomWrap").hidden = PRESETS.includes(l.type);
    $("elCustom").value = PRESETS.includes(l.type) ? "" : l.type;
    $("elName").value = l.name;
    $("elMax").value = l.maxCards == null ? "" : l.maxCards;
    $("elPerName").value = l.maxPerName == null ? "" : l.maxPerName;
    $("elPriority").value = Number(l.priority) || 0;
    $("elPickPriority").value = Number(l.pickPriority) || 0;
    $("elWalkSeq").value = l.walkSeq == null ? "" : l.walkSeq;
    $("elNotes").value = l.notes || "";
    $("elStaging").checked = !!l.staging;
    $("elSellFrom").checked = !!l.sellFrom;
    editSort.set(l.sortMethod);
    // Binders only (#293); kept as-is on any other type.
    $("elPerPage").value = l.cardsPerPage || G.DEFAULT_PAGE_SIZE;
    showPerPage();
    $("elPutOn").checked = !!(l.putaway && l.putaway.enabled);
    draftCriteria = G.normalizeCriteriaBox(l.putaway && l.putaway.rules);

    const st = G.locStats(id);
    // How many distinct cards are already over the per-name cap, if there is one.
    // One pass over this location's own rows, summing quantity per name into a
    // Map, instead of the old "for each distinct name at this location, call
    // G.nameCountAt() (itself a full state.cards scan)" - which made opening
    // this modal O(collection size x distinct names here) on every open.
    let overName = 0;
    if (l.maxPerName != null) {
      const totals = new Map();
      for (const r of G.state.cards) {
        if (r.locationId !== id) continue;
        const k = G.oracleKey(r) || r.name.toLowerCase();
        totals.set(k, (totals.get(k) || 0) + r.quantity);
      }
      for (const total of totals.values()) {
        if (total > l.maxPerName) overName++;
      }
    }
    $("elInfo").innerHTML = G.esc(st.cards + " cards in " + st.rows + " stacks · " + G.money(st.value) + " value" +
      (st.cost ? " · " + G.money(st.cost) + " cost basis" : "") +
      (st.cap == null ? " · no ceiling" : " · ceiling " + st.cap + " (" + st.free + " free)") +
      (l.maxPerName == null ? "" : " · max " + l.maxPerName + " per card")) +
      (overName ? ' <span class="warn">— ' + overName + " card" + (overName === 1 ? " is" : "s are") +
        " already over the per-card cap</span>" : "");

    UI.fillLocationSelect($("elMoveDest"), null, { exclude: id });
    const others = G.state.locations.length - 1;
    $("elMoveAll").disabled = others <= 0 || st.rows === 0;
    $("elMoveHint").className = "hint";
    $("elMoveHint").textContent = st.rows === 0 ? "This location is empty — nothing to move."
      : others <= 0 ? "Create another location first."
      : "Moves all " + st.cards + " card(s) in " + st.rows + " stack(s), cost basis included.";

    $("elTestName").value = ""; $("elTestPrint").innerHTML = '<option value="">— pick a card —</option>';
    testPrintings = [];
    renderRules();
    UI.showModal("locModal", opts && opts.focus === "sort" ? "elSortPreset" : "elName");
  }

  // "Cards per page" shows for a binder type only.
  function showPerPage() {
    $("elPerPageWrap").hidden = !G.isBinderType($("elType").value);
  }

  function saveEdit() {
    const l = G.locById(editId);
    if (!l) { UI.hideModal("locModal"); return; }
    const name = $("elName").value.trim();
    if (!name) { UI.toast("A location needs a name.", "err"); return; }
    if (G.state.locations.some(x => x.id !== l.id && x.name.toLowerCase() === name.toLowerCase())) {
      UI.toast('Another location is already named "' + name + '".', "err");
      return;
    }
    const before = {
      name: l.name, type: l.type, maxCards: l.maxCards, maxPerName: l.maxPerName,
      priority: l.priority, pickPriority: l.pickPriority, walkSeq: l.walkSeq, staging: !!l.staging, sellFrom: !!l.sellFrom,
      sortMethod: sortText(l.sortMethod),
      cardsPerPage: l.cardsPerPage,
      enabled: !!(l.putaway && l.putaway.enabled),
      rules: G.criteriaConditions(l.putaway && l.putaway.rules).length
    };
    l.name = name;
    l.type = typeFromPair($("elType"), $("elCustom"));
    l.maxCards = $("elMax").value === "" ? null : Math.max(0, parseInt($("elMax").value, 10) || 0);
    l.maxPerName = $("elPerName").value === "" ? null : Math.max(0, parseInt($("elPerName").value, 10) || 0);
    l.priority = parseInt($("elPriority").value, 10) || 0;
    l.pickPriority = parseInt($("elPickPriority").value, 10) || 0;
    l.walkSeq = G.normalizeWalkSeq($("elWalkSeq").value);
    l.staging = $("elStaging").checked;
    l.sellFrom = $("elSellFrom").checked;
    l.notes = $("elNotes").value.trim();
    l.sortMethod = editSort.get();
    // Leaving the default 9 on a binder that never set it stores nothing.
    const perPage = G.normalizePageSize($("elPerPage").value);
    l.cardsPerPage = perPage === G.DEFAULT_PAGE_SIZE && before.cardsPerPage == null ? null : perPage;
    l.putaway = { enabled: $("elPutOn").checked, rules: G.normalizeCriteriaBox(draftCriteria) };

    const changes = [];
    if (before.name !== l.name) changes.push("renamed from " + before.name);
    if (before.type !== l.type) changes.push("type " + before.type + " → " + l.type);
    if (before.maxCards !== l.maxCards) {
      changes.push("ceiling " + (before.maxCards == null ? "none" : before.maxCards) +
        " → " + (l.maxCards == null ? "none" : l.maxCards));
    }
    if (before.maxPerName !== l.maxPerName) {
      changes.push("max per card " + (before.maxPerName == null ? "none" : before.maxPerName) +
        " → " + (l.maxPerName == null ? "none" : l.maxPerName));
    }
    if (before.staging !== l.staging) changes.push(l.staging ? "marked a sorting tray" : "no longer a sorting tray");
    if (before.sellFrom !== l.sellFrom) changes.push(l.sellFrom ? "now sells from here" : "no longer sells from here");
    if (before.sortMethod !== sortText(l.sortMethod)) changes.push("sorting method " + before.sortMethod + " → " + sortText(l.sortMethod));
    if (before.cardsPerPage !== l.cardsPerPage) {
      const pp = v => (v == null ? G.DEFAULT_PAGE_SIZE + " (default)" : v);
      changes.push("cards per page " + pp(before.cardsPerPage) + " → " + pp(l.cardsPerPage));
    }
    if (before.priority !== l.priority) changes.push("priority " + before.priority + " → " + l.priority);
    if (before.pickPriority !== l.pickPriority) changes.push("pick priority " + before.pickPriority + " → " + l.pickPriority);
    if (before.walkSeq !== l.walkSeq) changes.push("walk sequence " + (before.walkSeq == null ? "none" : before.walkSeq) + " → " + (l.walkSeq == null ? "none" : l.walkSeq));
    if (before.enabled !== l.putaway.enabled) changes.push("putaway " + (l.putaway.enabled ? "on" : "off"));
    const ruleCount = G.criteriaConditions(l.putaway.rules).length;
    if (before.rules !== ruleCount) changes.push(ruleCount + " putaway condition(s)");
    G.logAudit({ action: "location", from: before.name, to: l.name,
      note: 'Location "' + l.name + '" edited' + (changes.length ? ": " + changes.join(", ") : "") });
    G.persist();
    UI.hideModal("locModal");
    UI.toast("Saved " + l.name + ".", "ok");
  }

  async function moveAll() {
    const src = G.locById(editId);
    if (!src) return;
    const dest = $("elMoveDest").value;
    if (!G.locById(dest) || dest === editId) {
      $("elMoveHint").textContent = "Choose a different destination.";
      $("elMoveHint").className = "hint warn";
      return;
    }
    const moving = G.state.cards.filter(r => r.locationId === editId);
    const movingSealed = G.state.sealed.filter(r => r.locationId === editId);
    if (!moving.length && !movingSealed.length) return;
    const cards = moving.reduce((s, r) => s + r.quantity, 0);
    const sealedQty = movingSealed.reduce((s, r) => s + r.quantity, 0);
    // Sealed stock has no capacity-ceiling concept today (locStats' cap is
    // card-count-based) - it moves unconditionally alongside; only the card
    // side is gated on the destination's capacity.
    const fit = G.moveOverCapacity(dest, moving);
    if (fit.over) {
      const ok = await UI.confirmDialog(G.locName(dest) + " has room for " + fit.free + " but you are moving " + cards +
        ".\n\nMove anyway and leave it over its ceiling?", { title: "Over capacity", danger: true, okLabel: "Move anyway" });
      if (!ok) return;
    } else {
      const parts = [];
      if (cards) parts.push(cards + " card(s)");
      if (sealedQty) parts.push(sealedQty + " sealed item(s)");
      const ok = await UI.confirmDialog('Move all ' + parts.join(" and ") + ' from "' + src.name + '" into "' + G.locName(dest) + '"?',
        { title: "Move all stock?" });
      if (!ok) return;
    }

    for (const r of moving) {
      G.logAudit({ action: "move", ...G.auditCard(r), qty: r.quantity, oldQty: r.quantity, newQty: r.quantity,
        from: src.name, to: G.locName(dest), note: "Location emptied into " + G.locName(dest) });
      r.locationId = dest;
    }
    G.normalizeMerge({ silent: true });
    if (movingSealed.length) G.moveAllSealedFromLocation(editId, dest);
    G.persist();
    UI.hideModal("locModal");
    const parts = [];
    if (cards) parts.push(cards + " card(s)");
    if (sealedQty) parts.push(sealedQty + " sealed item(s)");
    UI.toast('Moved ' + parts.join(" and ") + ' from "' + src.name + '" to "' + G.locName(dest) + '". Undo puts them back.', "ok");
  }

  async function deleteLocation() {
    const l = G.locById(editId);
    if (!l) return;
    const st = G.locStats(l.id);
    // Sealed stock at this location was previously left behind with a
    // dangling locationId pointing at nothing once the location itself
    // was gone - a real bug, not just an omission, spotted while wiring
    // up this same function for sealed's bulk-move above.
    const sealedHere = G.state.sealed.filter(r => r.locationId === l.id);
    const sealedQty = sealedHere.reduce((s, r) => s + r.quantity, 0);
    let msg = 'Delete location "' + l.name + '"?';
    const dooms = [];
    if (st.cards > 0) dooms.push(st.cards + " card(s) worth " + G.money(st.value));
    if (sealedQty > 0) dooms.push(sealedQty + " sealed item(s)");
    if (dooms.length) msg += "\n\nThis also DELETES " + dooms.join(" and ") + " stored here.";
    const ok = await UI.confirmDialog(msg, { title: "Delete location?", danger: true, okLabel: "Delete" });
    if (!ok) return;
    for (const r of G.state.cards.filter(r => r.locationId === l.id)) {
      G.logAudit({ action: "delete", ...G.auditCard(r), qty: -r.quantity, oldQty: r.quantity, newQty: 0,
        from: l.name, note: 'Location "' + l.name + '" deleted' });
    }
    G.logAudit({ action: "location", from: l.name,
      note: 'Deleted location "' + l.name + '"' + (st.cards ? " with " + st.cards + " card(s)" : " (empty)") });
    G.state.cards = G.state.cards.filter(r => r.locationId !== l.id);
    if (sealedHere.length) G.deleteSealedRowsAtLocation(l.id, l.name);
    G.state.locations = G.state.locations.filter(x => x.id !== l.id);
    G.persist();
    UI.hideModal("locModal");
    UI.toast('Deleted "' + l.name + '". Undo brings it and everything stored there back.', "ok");
  }

  /* ============================== Bin labels (#386) ==============================
     One QR label per location, for Warehouse Mode's bin scan. The code holds
     the location's id (G.binLabelText), so renaming a bin doesn't void its
     label; the name is printed big beside it for a person to read and key.
     The grid is 3 across on letter paper, the common 1 x 2-5/8 in sheet. */
  function binLabelHtml(l) {
    const qr = qrcode(0, "M");
    qr.addData(G.binLabelText(l));
    qr.make();
    const name = String(l.name);
    const size = name.length <= 6 ? 30 : name.length <= 12 ? 20 : 14;
    return '<div class="lbl"><div class="qr">' + qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true }) + "</div>" +
      '<div class="nm" style="font-size:' + size + 'pt">' + G.esc(name) + "</div></div>";
  }
  function printBinLabels(locs) {
    const w = window.open("", "_blank");
    if (!w) { UI.toast("Pop-up blocked. Allow pop-ups for this site to print.", "err"); return; }
    const style = "@page{size:letter;margin:.5in .19in}body{margin:0;background:#fff;color:#000;font-family:Consolas,monospace}" +
      ".sheet{display:grid;grid-template-columns:repeat(3,2.625in);grid-auto-rows:1in;column-gap:.125in}" +
      ".lbl{display:flex;align-items:center;gap:.08in;padding:.06in .1in;overflow:hidden;break-inside:avoid;page-break-inside:avoid}" +
      ".qr{flex:none;width:.86in;height:.86in}.qr svg{display:block;width:100%;height:100%}" +
      ".nm{font-weight:700;line-height:1.05;overflow-wrap:anywhere}";
    w.document.write("<!DOCTYPE html><html><head><title>Bin labels</title><style>" + style + '</style></head><body><div class="sheet">' +
      locs.map(binLabelHtml).join("") + "</div></body></html>");
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
  }
  async function printShownBinLabels() {
    const locs = shownLocations();
    if (!locs.length) { UI.toast("No locations to print. Clear the filter or add one.", "err"); return; }
    const ok = await UI.confirmDialog("Print " + locs.length + " bin label" + (locs.length === 1 ? "" : "s") + "? Use the search box or type filter to print fewer.",
      { title: "Print bin labels?", okLabel: "Print" });
    if (ok) printBinLabels(locs);
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    $("newType").innerHTML = typeSelectHtml("Binder");
    $("newType").onchange = () => {
      $("newCustomWrap").hidden = $("newType").value !== "__custom";
      if (!$("newCustomWrap").hidden) $("newCustom").focus();
    };
    newSort = sortEditor("new");
    editSort = sortEditor("el");
    newSort.set(null);
    $("btnAdd").onclick = addLocation;
    $("newName").addEventListener("keydown", e => { if (e.key === "Enter") addLocation(); });
    $("locSearch").addEventListener("input", G.debounce(renderGrid, 150));
    $("locTypeFilter").onchange = renderGrid;
    $("btnBinLabels").onclick = printShownBinLabels;
    $("elPrintLabel").onclick = () => { const l = G.locById(editId); if (l) printBinLabels([l]); };

    const setView = m => {
      viewMode = m;
      $("viewCompact").classList.toggle("active", m === "compact");
      $("viewCards").classList.toggle("active", m === "cards");
      renderGrid();
    };
    $("viewCompact").onclick = () => setView("compact");
    $("viewCards").onclick = () => setView("cards");

    $("elType").onchange = () => {
      showPerPage();
      $("elCustomWrap").hidden = $("elType").value !== "__custom";
      if (!$("elCustomWrap").hidden) $("elCustom").focus();
    };
    $("elAddRule").onclick = () => { draftCriteria.conditions.push(G.newRule()); renderRules(); };
    $("elPutOn").onchange = runTest;
    $("elSave").onclick = saveEdit;
    $("elCancel").onclick = () => UI.hideModal("locModal");
    $("elDelete").onclick = deleteLocation;
    $("elMoveAll").onclick = moveAll;
    $("elTestPrint").onchange = runTest;
    $("elTestFoil").onchange = runTest;
    $("locModal").addEventListener("click", e => { if (e.target.id === "locModal") UI.hideModal("locModal"); });
    UI.Autocomplete("elTestName", "elTestAc", loadTestPrintings);

    G.on("change", renderGrid);
    renderGrid();

    // locations.html#edit=<id> opens that location's editor at its Sorting
    // method (the dimmed pin on Card Inventory, #401).
    const m = /^#edit=(.+)$/.exec(location.hash);
    if (m) {
      const id = decodeURIComponent(m[1]);
      history.replaceState(null, "", location.pathname + location.search);
      if (G.locById(id)) {
        openEdit(id, { focus: "sort" });
        // showModal focuses it on the next tick; scroll it into view after that.
        setTimeout(() => { const sm = $("elSortPreset"); if (sm) sm.scrollIntoView({ block: "center" }); }, 0);
      }
    }
  });
})();
