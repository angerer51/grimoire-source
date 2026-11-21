
"use strict";
(function () {
  const $ = id => document.getElementById(id);

  /* Everything below is local and never touches G.state - see the plan's
     safety finding: G.state is read by-reference by every shared render
     component, and a background 5s restart-notice poll (ui.js) can call
     G.saveNow() unconditionally, so anything sitting in G.state.cards at
     the wrong moment could get shipped to the server as if real. Card
     SEARCH is the one real thing here (G.cards.autocomplete/printings hit
     the shared, read-only Scryfall-backed catalog, not user data) - only
     the resulting "added to inventory" row is fake and local. */
  const DEMO_LOCATIONS = [
    { id: "d1", name: "Trade Binder" },
    { id: "d2", name: "Bulk Box" },
    { id: "d3", name: "Display Case" }
  ];
  let demoCards = [];
  let demoSeq = 0;
  /* Who is taking the tour (#179), decided once the account has loaded:
     - a first run on a new personal account: Skip means Simple mode, as
       before;
     - a replay from Help: nothing changes unless an answer is picked;
     - an organization member: no mode question at all (the Store's staff
       need the full set of pages), and nothing is written to the Store's
       shared document, so finishing the tour can't mark it seen, or save
       the whole store, for every coworker. */
  let simpleModeChoice = null;   // null = no answer picked on step 1
  let firstRun = false;
  let inOrg = false;
  let storeName = "";
  let pickedCard = null;
  let tutPrintings = [];
  let step = 1;
  let firstStep = 1;             // 2 for an organization member: no step 1
  const TOTAL_STEPS = 5;
  /* The first place cards live (#239). A personal account with no location
     yet is offered a binder name on the last step; Finish creates it and
     hands off to Receive. Skip, or Finish with the name left blank, creates
     DEFAULT_LOCATION instead, so nobody ends up with two. Organization
     members never get one (their document is the Store's), and neither does
     an account that already has a location (a replay). */
  const DEFAULT_LOCATION = "My Collection";
  let madeLocation = false;      // a location was created by this tour
  const needsFirstLocation = () => !inOrg && !madeLocation && !G.state.locations.length;

  function renderDots() {
    const n = TOTAL_STEPS - firstStep + 1;
    $("tutDots").innerHTML = Array.from({ length: n }, (_, i) =>
      '<span class="tut-dot' + (i + firstStep === step ? " on" : "") + '"></span>').join("");
  }

  // The mode the account ends up in when the tour finishes: an answer
  // picked on step 1, else Simple mode on a first run, else unchanged (null).
  function modeOnFinish() {
    if (inOrg) return null;
    if (simpleModeChoice !== null) return simpleModeChoice;
    return firstRun ? true : null;
  }

  function summaryText() {
    const added = "You added " + demoCards.length + " card" + (demoCards.length === 1 ? "" : "s") + " to this demo";
    if (inOrg) {
      return added + ". Nothing in this tour touched " + (storeName ? storeName + "'s" : "your store's") + " inventory.";
    }
    const real = G.state.cards.length === 0
      ? " — your real collection is still empty and ready for the real thing."
      : ". Your real collection wasn't touched.";
    const mode = modeOnFinish();
    const modeText = mode === true ? " Starting in Simple mode (you can turn it off in Settings anytime)."
      : mode === false ? " Starting in full mode." : "";
    return added + real + modeText;
  }

  // Does this person get the business features (Mark listed, Integrations)?
  // Whoever is in Simple mode (or will be after the tour) does not; org members follow their own Simple setting too.
  function sellingIsSimple() {
    const m = modeOnFinish();
    return m !== null ? m : !!G.simpleMode;
  }

  function renderDemo() {
    $("tutDemoWrap").classList.toggle("tut-no-listed", sellingIsSimple());
    $("tutDemoWrap").hidden = step < 2 || !demoCards.length;
    $("tutDemoBody").innerHTML = demoCards.map(c =>
      '<tr class="click" tabindex="0" data-id="' + c.id + '">' +
      UI.artThumbTd(c.imageUrl) +
      '<td class="card-name">' + UI.cardLink(Object.assign({}, c.card, { name: c.name, finish: c.finish })) + (c.finish === "foil" ? ' <span class="badge foil">FOIL</span>' : "") + "</td>" +
      '<td class="hide-sm">' + G.esc(c.locationName) + "</td>" +
      '<td class="num">' + c.qty + "</td>" +
      '<td class="num">' + G.money(c.price) + "</td>" +
      '<td class="tut-listed-col"><button type="button" class="small tut-listed-btn' + (c.listed ? " on" : "") + '" data-id="' + c.id + '">' +
      (c.listed ? UI.icon("check") + " Listed" : "Mark listed") + "</button></td>" +
      "</tr>"
    ).join("");
    $("tutDemoBody").querySelectorAll(".tut-listed-btn").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const row = demoCards.find(c => c.id === btn.dataset.id);
        if (row) { row.listed = !row.listed; renderDemo(); }
      };
    });
    $("tutDemoBody").querySelectorAll("tr[data-id]").forEach(tr => {
      const row = demoCards.find(c => c.id === tr.dataset.id);
      if (!row) return;
      UI.wireArtHover(tr, row.imageUrl);
      tr.onclick = e => { if (e.target.closest("button")) return; if (row.card) UI.reviewCard(row.card, row.finish); };
      // Keyboard: Enter or Space on the row opens the same preview (#179).
      tr.onkeydown = e => {
        if (e.target !== tr || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        if (row.card) UI.reviewCard(row.card, row.finish);
      };
    });
  }

  function tile(big, lbl, extra) {
    return '<div class="tile"><span class="big">' + big + '</span><span class="lbl">' + lbl + "</span>" +
      (extra ? '<div class="faint" style="font-size:11.5px;margin-top:5px">' + extra + "</div>" : "") + "</div>";
  }

  function renderTiles() {
    const cardCount = demoCards.reduce((s, c) => s + c.qty, 0);
    const value = demoCards.reduce((s, c) => s + (c.price || 0) * c.qty, 0);
    const listed = demoCards.filter(c => c.listed).reduce((s, c) => s + c.qty, 0);
    $("tutTiles").innerHTML =
      tile(cardCount, "Cards", demoCards.length + " name(s)") +
      tile(G.money(value), "Market value") +
      tile(listed, "Listed for sale");
  }

  function showStep(n) {
    step = n;
    for (let i = 1; i <= TOTAL_STEPS; i++) $("step" + i).hidden = i !== n;
    renderDots();
    renderDemo();
    if (n === 3) renderTiles();
    $("tutRealPage").textContent = sellingIsSimple() ? "Add cards" : "Receive";
    $("sellBiz").hidden = sellingIsSimple();
    $("sellSimple").hidden = !sellingIsSimple();
    $("tutBack").hidden = n === firstStep;
    $("tutNext").disabled = n === 2 && !demoCards.length;
    $("tutNext").textContent = n === TOTAL_STEPS ? "Enter Grimoire →" : "Next →";
    if (n === 2) setTimeout(() => $("tutSearch").focus(), 0);
    if (n === 5) {
      $("tutSummary").textContent = summaryText();
      $("tutBinder").hidden = !needsFirstLocation();
      if (needsFirstLocation()) $("tutNext").textContent = "Create it & add my first card →";
    }
  }

  // Create the account's first location, once, in G.state. Returns true if
  // one was made. Never duplicates a name (case-insensitive).
  function createFirstLocation(name) {
    if (!needsFirstLocation()) return false;
    name = (name || "").trim().slice(0, 60) || DEFAULT_LOCATION;
    if (G.state.locations.some(l => l.name.toLowerCase() === name.toLowerCase())) return false;
    const l = G.createLocation({ name, type: name === DEFAULT_LOCATION ? "Other" : "Binder" });
    G.state.locations.push(l);
    G.logAudit({ action: "location", to: name, note: 'Created location "' + name + '" (' + l.type + ") from the welcome tour" });
    G.persist();
    madeLocation = true;
    return true;
  }

  async function finish(skipped) {
    $("tutNext").disabled = true;
    $("tutSkip").disabled = true;
    $("tutMsg").className = "status";
    $("tutMsg").textContent = "";
    // An organization member's tour writes nothing (#179): their document
    // is the Store's, shared with every coworker.
    if (inOrg) { location.href = "/index.html"; return; }
    const mode = modeOnFinish();
    // Finish on the last step uses the typed name; Skip or blank uses the default.
    createFirstLocation(skipped === true || step !== TOTAL_STEPS ? "" : $("tutBinderName").value);
    if (!G.state.settings.tutorialSeen) {
      G.state.settings.tutorialSeen = true;
      G.persistSettings();
    }
    // A replay that picked nothing has nothing to save.
    if (mode === null && !G.hasUnsaved()) { location.href = "/index.html"; return; }
    // persistSettings() only schedules a debounced save - force it through
    // now so the choice is guaranteed saved before we navigate away and the
    // pending timer never gets a chance to fire. Unlike before, a failure
    // here (a network blip right after registration is exactly when this is
    // plausible) no longer navigates away regardless - that silently landed
    // a brand-new user back on a full page load that re-fetches settings
    // from the server and gets simpleMode reverted with no explanation.
    // Staying put and re-enabling the buttons lets them just try again.
    try {
      // Simple mode is per person (#159): a personal account's goes into
      // its own document, which saveAll() sends. Only when an answer was
      // picked, or on a first run (#179): replaying the tour and pressing
      // Skip must not switch a full-mode account into Simple mode.
      if (mode !== null) await G.setPersonalPrefs({ simpleMode: mode });
      // saveAll, not saveNow: saveNow never rejects, so a failed save used
      // to leave the page anyway (#176).
      if (!(await G.saveAll(10000))) throw new Error(G.saveState().error || "still saving");
    } catch (e) {
      $("tutMsg").textContent = "Couldn't save your choice (" + (e.message || "connection problem") +
        "). Check your connection and try again.";
      $("tutMsg").className = "status err";
      $("tutNext").disabled = false;
      $("tutSkip").disabled = false;
      return;
    }
    location.href = madeLocation && !skipped ? "/receive.html" : "/index.html";
  }

  function chooseMode(simple) {
    simpleModeChoice = simple;
    showStep(2);
  }

  (async function boot() {
    try { await G.load(); }
    catch (e) { $("tutMsg").textContent = "Could not load your account: " + (e.message || e); return; }

    inOrg = !!(G.me && G.me.orgId);
    // A brand-new account has never seen the tour and owns nothing yet. An
    // older account that predates the tour has cards: a look from Help
    // there is a replay, so Skip leaves its mode alone.
    firstRun = !inOrg && !G.state.settings.tutorialSeen && !G.state.cards.length;
    if (inOrg) {
      firstStep = 2;
      try {
        const d = await G.api("/api/orgs/mine");
        const sid = d.activeStoreId || (G.loadedOwner && G.loadedOwner.startsWith("store:") ? G.loadedOwner.slice(6) : null);
        const s = (d.stores || []).find(x => x.id === sid);
        storeName = s && s.name ? s.name : "";
      } catch (e) { storeName = ""; }
    } else if (!firstRun) {
      $("step1Hint").textContent = "You're in " + (G.simpleMode ? "Simple" : "full") + " mode now. Picking an answer " +
        "here switches to that mode; Skip leaves it as it is. You can also change it in Settings → Preferences.";
    }

    $("tutLoc").innerHTML = DEMO_LOCATIONS.map(l => '<option value="' + l.id + '">' + G.esc(l.name) + "</option>").join("");

    const preview = UI.CardPanel("tutPreview", { chime: false, placeholder: "Search a card above to preview it here." });
    UI.Autocomplete("tutSearch", "tutAcList", async name => {
      $("tutMsg").textContent = "";
      try {
        const printings = await G.cards.printings(name);
        if (!printings.length) { preview.message("No printings found for that name."); pickedCard = null; return; }
        // One entry per set + collector number, and no default: the first printing is
        // often the oldest and priciest, so the demo waits for a pick (#236).
        tutPrintings = G.sortPrintingsNewest(G.groupPrintings(printings).map(G.englishOf));
        pickedCard = null;
        $("tutPrintFilter").value = "";
        $("tutPrinting").value = "";
        renderTutPrintings();
        $("tutPrintLbl").hidden = false;
        $("tutAddFields").hidden = false;
        $("tutAddBtn").hidden = false;
        $("tutAddBtn").disabled = true;
        $("tutPreviewHint").hidden = true;
        preview.message("Choose a printing to see it here.");
      } catch (e) {
        preview.message("Lookup failed: " + e.message);
        pickedCard = null;
        $("tutPreviewHint").hidden = true;
      }
    });

    // Option value = index into tutPrintings (newest first); the filter box
    // narrows the list and drops a pick it hides (#324).
    function renderTutPrintings() {
      const sel = $("tutPrinting"), keep = sel.value, text = $("tutPrintFilter").value;
      const rows = [];
      tutPrintings.forEach((c, i) => {
        if (G.printingMatches(c, text)) rows.push('<option value="' + i + '">' + G.esc(G.printingChoiceLabel(c)) + "</option>");
      });
      sel.innerHTML = '<option value="">' + (rows.length ? "Choose a printing…" : "No printing matches that") + "</option>" + rows.join("");
      sel.value = [...sel.options].some(o => o.value === keep) ? keep : "";
    }
    $("tutPrintFilter").addEventListener("input", () => { renderTutPrintings(); $("tutPrinting").onchange(); });

    $("tutPrinting").onchange = () => {
      pickedCard = tutPrintings[parseInt($("tutPrinting").value, 10)] || null;
      $("tutAddBtn").disabled = !pickedCard;
      if (!pickedCard) { preview.message("Choose a printing to see it here."); $("tutPreviewHint").hidden = true; return; }
      preview.showCard(pickedCard, G.fitFinish(pickedCard, "nonfoil"), "", { putaway: false, qty: 1 });
      $("tutPreviewHint").hidden = false;
    };

    $("tutAddBtn").onclick = () => {
      if (!pickedCard) return;
      const loc = DEMO_LOCATIONS.find(l => l.id === $("tutLoc").value) || DEMO_LOCATIONS[0];
      const qty = Math.max(1, parseInt($("tutQty").value, 10) || 1);
      demoCards.push({
        id: "demo" + (++demoSeq),
        name: G.cardName(pickedCard),
        price: G.priceOf(pickedCard, G.fitFinish(pickedCard, "nonfoil")),
        finish: G.fitFinish(pickedCard, "nonfoil"),
        qty, locationName: loc.name, listed: false,
        imageUrl: pickedCard.imageUrl || "", card: pickedCard
      });
      $("tutSearch").value = "";
      pickedCard = null;
      preview.clear();
      $("tutPrintLbl").hidden = true;
      $("tutAddFields").hidden = true;
      $("tutAddBtn").hidden = true;
      $("tutPreviewHint").hidden = true;
      $("tutMsg").textContent = "Added. Search another, or hit Next when you're ready.";
      $("tutMsg").className = "status ok";
      renderDemo();
      $("tutNext").disabled = false;
    };

    $("choiceSimple").onclick = () => chooseMode(true);
    $("choiceBusiness").onclick = () => chooseMode(false);
    $("tutBack").onclick = () => showStep(Math.max(firstStep, step - 1));
    $("tutNext").onclick = () => { if (step === TOTAL_STEPS) finish(false); else showStep(step + 1); };
    $("tutSkip").onclick = () => finish(true);

    showStep(firstStep);
  })();
})();
