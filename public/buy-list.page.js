
"use strict";
(function () {
  const $ = UI.$;
  const params = new URLSearchParams(location.search);
  // #139: buy-list.html?watch=<id> (a notification) marks that watch-list
  // row; &friend=<username> also loads the card below with its "A friend
  // owns this card" button, and opens it when that friend is listed.
  const focusWatch = params.get("watch") || "";
  let focusScrolled = false;
  let tabs = null;        // UI.pageTabs, once the page is wired
  const ALLOWED_SET_TYPES = new Set(["core", "expansion", "masters", "draft_innovation", "commander"]);

  let mode = "";          // "set" | "search" | "single"
  let setCode = "";       // the set code results came from, when mode === "set"
  let rendered = [];      // rows currently on screen, for CSV export
  // Row action buttons live inside a row whose own onclick reviews the card -
  // same pattern Movers uses to keep a button click from also opening that.
  const stop = fn => e => { e.stopPropagation(); fn(); };

  /* Row click reviews the card - a live lookup (cached by G.cards.one) since
     a Results/Watch row is a flattened summary (a specific price already
     picked out), not the full card-database shape CardPanel.showCard
     expects. */
  async function reviewPrinting(set, collector, lang, finish) {
    let card;
    try { card = await G.cards.one(set, collector, lang || "en"); }
    catch (e) { return; }
    if (card) UI.reviewCard(card, finish);
  }

  // Searches and set loads can overlap (the debounced search box, the set
  // picker, "Only cards I don't own"): only the newest one may render (#103).
  const beginRequest = G.latestOnly();

  /* Groups every card-database row by oracle id + set code - one group per
     (card name, set) pair, so a name search across the card's whole
     reprint history shows a separate row per set instead of one row that
     blends every set's prices into a single low/high range (2026-09-07
     ask). Browsing a single set was already scoped to one set and is
     unaffected, other than still merging same-set variants (e.g. a
     showcase alt art) that share the same oracle id. `best` is the
     cheapest-priced printing in the group (falling back to whichever came
     first if nothing is priced) - used as the representative for art/
     rarity/rows that need just one printing to point at. `cards` is every
     printing in the group, used for the low/high price range and the Buy
     menu's full list (2026-09-06 ask). */
  function bestPerName(list) {
    const map = new Map();
    for (const c of list) {
      if (!c.oracleId) continue;
      const key = c.oracleId + "|" + c.set;
      let g = map.get(key);
      if (!g) { g = { best: c, cards: [] }; map.set(key, g); }
      g.cards.push(c);
      const price = c.usd != null ? c.usd : c.usdFoil;
      const bestPrice = g.best.usd != null ? g.best.usd : g.best.usdFoil;
      if (price != null && (bestPrice == null || price < bestPrice)) g.best = c;
    }
    return [...map.values()];
  }
  /* Every (printing, finish) combination in a group that actually has a
     price, flattened and sorted low to high - the Buy menu's own list
     (2026-09-06 ask). Non-foil/foil/etched of the same printing are listed
     separately (they're genuinely different prices) even though they share
     one Manapool product page. */
  function pricedPrintings(cards) {
    const out = [];
    for (const c of cards) {
      for (const finish of ["usd", "usdFoil", "usdEtched"]) {
        if (c[finish] == null) continue;
        out.push({
          set: c.set, collector: c.collector, setName: c.setName, name: G.cardName(c),
          finish: finish === "usd" ? "nonfoil" : finish === "usdFoil" ? "foil" : "etched",
          price: c[finish]
        });
      }
    }
    return out.sort((a, b) => a.price - b.price);
  }

  async function loadSets() {
    let sets;
    try { sets = await G.cards.sets(); } catch (e) { sets = []; }
    const allowed = sets.filter(s => ALLOWED_SET_TYPES.has(s.type) && !s.digital)
      .sort((a, b) => String(b.released).localeCompare(String(a.released)));
    $("bwSet").innerHTML = '<option value="">— pick a set —</option>' +
      allowed.map(s => '<option value="' + s.code + '">' + G.esc(s.name) + " (" + s.code.toUpperCase() + ")</option>").join("");
  }

  async function run() {
    const isCurrent = beginRequest();
    const q = $("bwSearch").value.trim();
    const chosenSet = $("bwSet").value;
    if (q) {
      mode = "search"; setCode = "";
      UI.setStatus("status", "Searching…", "work");
      let list;
      try { list = await G.cards.search({ q, limit: 200 }); }
      catch (e) { if (isCurrent()) UI.setStatus("status", "Search failed: " + e.message, "err"); return; }
      if (!isCurrent()) return;
      await finish(bestPerName(list), '"' + q + '"', isCurrent);
      return;
    }
    if (!chosenSet) {
      mode = ""; setCode = "";
      $("tiles").innerHTML = ""; $("resHdr").textContent = "";
      renderRows([]);
      UI.setStatus("status", "Pick a set, or search by name.", "");
      return;
    }
    mode = "set"; setCode = chosenSet;
    UI.setStatus("status", "Loading set…", "work");
    let d;
    try { d = await G.api("/api/cards/set/" + encodeURIComponent(chosenSet)); }
    catch (e) { if (isCurrent()) UI.setStatus("status", "Could not load that set: " + e.message, "err"); return; }
    if (!isCurrent()) return;
    await finish(bestPerName(d.data || []), $("bwSet").selectedOptions[0].textContent, isCurrent);
  }

  async function runSingle(set, collector, name) {
    const isCurrent = beginRequest();
    mode = "single"; setCode = "";
    UI.setStatus("status", "Loading " + name + "…", "work");
    let card;
    try { card = await G.cards.one(set, collector, "en"); }
    catch (e) { if (isCurrent()) UI.setStatus("status", "Could not load that card: " + e.message, "err"); return; }
    if (!isCurrent()) return;
    if (!card) {
      UI.setStatus("status", "Could not find " + name + " (" + set.toUpperCase() + " #" + collector + ").", "err");
      await finish([], "", isCurrent);
      return;
    }
    await finish([{ best: card, cards: [card] }], "that one printing", isCurrent);
  }

  // `isCurrent` is the request's latestOnly() check: a result that a newer
  // search or set load has overtaken is dropped instead of drawn.
  /* The set's own printing of a card (#334): English, not a promo, lowest
     collector number - showcase and extended-art variants number higher. */
  const numOf = c => { const m = String(c.collector || "").match(/^\d+/); return m ? parseInt(m[0], 10) : 1e9; };
  function mainPrinting(cards) {
    const en = cards.filter(c => (c.lang || "en") === "en");
    const pool = en.length ? en : cards;
    return pool.slice().sort((a, b) => (a.promo ? 1 : 0) - (b.promo ? 1 : 0) || numOf(a) - numOf(b) ||
      String(a.collector).localeCompare(String(b.collector)))[0];
  }
  // The main printing's price in the chosen finish; a printing that doesn't come in it uses its own.
  const finishVal = () => ($("bwFinish") && $("bwFinish").value) || "nonfoil";
  function mainPrice(r) {
    const c = r.main;
    return c ? G.priceOf(c, G.fitFinish(c, finishVal())) : null;
  }

  async function finish(groups, scopeLabel, isCurrent) {
    const owned = G.ownedIndex();
    let rows = groups.map(g => {
      // The row is the set's own printing, so Watch, Buy and the review all use the
      // same one the # and Price columns show (#334).
      const c = mainPrinting(g.cards) || g.best;
      const priced = pricedPrintings(g.cards);
      priced.sort((a, b) => (b.set === c.set && b.collector === c.collector ? 1 : 0) - (a.set === c.set && a.collector === c.collector ? 1 : 0));
      const prices = priced.map(p => p.price);
      const main = mainPrinting(g.cards);
      return {
        main, number: c.collector,
        oracleId: c.oracleId, name: G.cardName(c), set: c.set, collector: c.collector,
        setName: c.setName, lang: c.lang || "en", rarity: c.rarity, imageUrl: c.imageUrl,
        foilOnly: c.usd == null && c.usdFoil != null,
        low: prices.length ? Math.min.apply(null, prices) : null,
        high: prices.length ? Math.max.apply(null, prices) : null,
        printings: priced,
        owned: owned.qty(c.oracleId),
        ownedThis: owned.qtyInSet(c.set, c.oracleId),
        inThisSet: owned.inSet(c.set, c.oracleId),
        englishName: c.name
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.setName.localeCompare(b.setName));
    // A whole set opens in collector-number order, so it reads as a checklist (#334).
    if (mode === "set") rows.sort((a, b) => numOf({ collector: a.number }) - numOf({ collector: b.number }) || String(a.number).localeCompare(String(b.number)));

    // An exact English-name match to the search ranks first (#246); the sort
    // above is stable, so everything else keeps its alphabetical order.
    const fold = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const needle = mode === "search" ? fold($("bwSearch").value) : "";
    if (needle) {
      // Tiers: shown name matches, then English name only (foreign
      // printings), then the rest; existing order kept within each tier.
      const tier = r => fold(r.name) === needle ? 0 : fold(r.englishName) === needle ? 1 : 2;
      rows = [0, 1, 2].flatMap(t => rows.filter(r => tier(r) === t));
    }

    const ownMode = ownFilter();
    const onlyMissing = ownMode !== "all";
    if (ownMode === "printing") {
      // Scoped per (name, set) row like the results table itself now is -
      // owning a card in one set no longer hides its other-set rows.
      rows = rows.filter(r => !r.inThisSet);
    } else if (ownMode === "any") {
      rows = rows.filter(r => !r.owned);
    }

    let friendsHave = {};
    const ids = [...new Set(rows.map(r => r.oracleId).filter(Boolean))];
    if (ids.length) {
      try {
        const d = await G.api("/api/friends/have", { method: "POST", body: { oracleIds: ids } });
        friendsHave = d.data || {};
      } catch (e) { /* friends are a nicety here, not worth failing the page over */ }
    }
    if (!isCurrent()) return;
    for (const r of rows) r.friends = friendsHave[r.oracleId] || [];

    const total = groups.length;
    $("tiles").innerHTML =
      tile(total.toLocaleString(), mode === "set" ? "Names in set" : "Printings found") +
      tile(rows.length.toLocaleString(), onlyMissing ? "Missing" : "Shown") +
      tile(rows.filter(r => r.friends.length).length.toLocaleString(), "A friend already has");
    $("resHdr").textContent = scopeLabel ? "— " + rows.length + " of " + total + " from " + scopeLabel : "";
    UI.setStatus("status", rows.length
      ? "Showing " + rows.length + " card" + (rows.length === 1 ? "" : "s") + "."
      : (total ? "Nothing left to show at this filter." : "No cards matched."), "ok");
    renderRows(rows);
  }

  const ownFilter = () => { const el = document.querySelector('input[name="bwOwn"]:checked'); return el ? el.value : "printing"; };
  const setOwnFilter = v => { const el = document.querySelector('input[name="bwOwn"][value="' + v + '"]'); if (el) el.checked = true; };

  function tile(big, lbl) {
    return '<div class="tile"><span class="big">' + big + '</span><span class="lbl">' + G.esc(lbl) + "</span></div>";
  }

  function renderRows(rows) {
    rendered = rows;
    const body = $("resBody");
    if (!rows.length) {
      body.innerHTML = UI.emptyRow(11, { icon: "search", title: "Nothing to show yet." });
      return;
    }
    // One pass over the watch list per render, not one per row.
    const watched = new Set(G.state.watchList.map(w => G.watchKey(w)));
    const isWatched = r => watched.has(rowWatchKey(r));
    body.innerHTML = rows.map((r, i) => '<tr class="click">' +
      UI.artThumbTd(r.imageUrl) +
      '<td class="card-name">' + UI.cardLink(r) + '<small class="sub-sm">' + G.esc(r.setName) + " (" + G.esc(r.set.toUpperCase()) + ")</small></td>" +
      '<td class="muted hide-sm">' + G.esc(r.setName) + " (" + G.esc(r.set.toUpperCase()) + ")</td>" +
      '<td class="num hide-sm" data-v="' + numOf({ collector: r.number }) + '">' + G.esc(r.number) + "</td>" +
      '<td class="hide-sm">' + G.esc(r.rarity || "") + "</td>" +
      (mainPrice(r) != null ? '<td class="num hide-sm" data-v="' + mainPrice(r) + '">' + G.money(mainPrice(r)) + "</td>" : '<td class="num hide-sm" data-v="" title="No price for this printing">—</td>') +
      '<td class="num hide-sm" data-v="' + (r.low == null ? "" : r.low) + '">' + G.money(r.low) + " – " + G.money(r.high) + "</td>" +
      '<td class="num hide-xs" data-v="' + r.ownedThis + '">' + (r.ownedThis ? r.ownedThis : '<span class="muted">0</span>') + "</td>" +
      '<td class="num hide-sm" data-v="' + r.owned + '">' + (r.owned ? r.owned : '<span class="muted">0</span>') + "</td>" +
      '<td class="friends-cell">' + (r.friends.length
        ? '<button class="small ghost" data-act="friends" data-i="' + i + '"><span class="lg-only">A friend owns this card</span><span class="sm-only">Friends</span></button>'
        : '<span class="muted"><span class="lg-only">No friends own this</span><span class="sm-only">None</span></span>') + "</td>" +
      '<td class="row-actions">' +
      '<button class="small" data-act="buy" data-i="' + i + '"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#shopping-bag></use></svg> Buy</button>' +
      '<button class="small ' + (isWatched(r) ? "" : "ghost") + '" data-act="watch" data-i="' + i + '">' +
        UI.icon("star") + (isWatched(r) ? " Watching" : " Watch") + "</button>" +
      "</td></tr>").join("");
    body.querySelectorAll('[data-act="buy"]').forEach(btn => {
      btn.onclick = stop(() => openBuyMenu(rows[Number(btn.dataset.i)]));
    });
    body.querySelectorAll('[data-act="friends"]').forEach(btn => {
      btn.onclick = stop(() => openFriendsModal(rows[Number(btn.dataset.i)]));
    });
    body.querySelectorAll('[data-act="watch"]').forEach(btn => {
      btn.onclick = stop(() => toggleWatch(rows[Number(btn.dataset.i)]));
    });
    body.querySelectorAll("tr").forEach((tr, i) => {
      const r = rows[i];
      UI.wireArtHover(tr, r.imageUrl);
      tr.onclick = () => reviewPrinting(r.set, r.collector, r.lang, r.foilOnly ? "foil" : "nonfoil");
    });
    UI.reapplySorts();
  }

  /* ============================== Watch list ============================== */
  // A Results row watches its own finish (foil when it comes only in foil); a
  // Restock row (#370) names the finish it sold or was wanted in.
  const rowFinish = r => r.finish || (r.foilOnly ? "foil" : "nonfoil");
  const rowWatchKey = r => G.watchKey({ set: r.set, collector: r.collector, lang: r.lang, finish: rowFinish(r) });
  function toggleWatch(r) {
    const key = rowWatchKey(r);
    const existing = G.state.watchList.find(w => G.watchKey(w) === key);
    if (existing) {
      G.state.watchList = G.state.watchList.filter(w => w.id !== existing.id);
      G.logAudit({ action: "watch-list", note: "Removed " + r.name + " from the watch list" });
      UI.toast("Removed " + r.name + " from the watch list.", "ok");
    } else {
      G.state.watchList.push(G.normalizeWatchItem({
        set: r.set, collector: r.collector, lang: r.lang, finish: rowFinish(r),
        name: r.name, setName: r.setName, oracleId: r.oracleId
      }));
      G.logAudit({ action: "watch-list", note: "Added " + r.name + " to the watch list" });
      UI.toast("Watching " + r.name + ". Track it in the watch list.", "ok");
    }
    G.persist();
    renderRows(rendered);
    drawRestock();
    renderWatch();
  }

  /* ============================== Restock (#370) ==============================
     Cards the account sold before (or customers want), has none of now, and
     that are selling well on Manapool this week: SELLING FAST, or the card
     is in the week's top list. The candidates come from this document
     (G.restockHints); the server says which of them qualify. The table shows
     the best RESTOCK_SHOWN until "Show all"; a header click sorts the whole
     list (UI.dataSort + G.sortRows), and the drawn rows are the top of it. */
  const RESTOCK_SHOWN = 10;
  let restock = [], restockAll = false, restockAsked = "", restockAnswer = null, restockSorted = null;
  const RESTOCK_SORT_KEYS = [
    r => r.name,
    r => (r.printing ? G.printingLabel(r.set, r.collector, r.setName) : null),
    r => r.sold7,
    r => r.rank,
    r => r.ownSold,
    r => r.wanted
  ];
  async function loadRestock() {
    const c = G.restockHints();
    const sec = $("restockSec");
    // Never sold anything and no wants (a collector): no section at all.
    // The Restock tab follows the section: no tab either (it falls back to the Watch list).
    if (!c.prints.length && !c.names.length) {
      sec.hidden = true; restock = [];
      $("tabRestock").hidden = true;
      if (tabs && tabs.current() === "restock") tabs.show("watch");
      return;
    }
    sec.hidden = false;
    $("tabRestock").hidden = false;
    const req = G.restockRequest(c), ask = JSON.stringify(req);
    if (ask !== restockAsked || !restockAnswer) {
      restockAsked = ask;
      restockAnswer = null;
      $("restockBody").innerHTML = UI.skeletonRows(7, 2);
      let d;
      try { d = await G.api("/api/prices/restock", { method: "POST", body: req }); }
      catch (e) { d = { sales: { error: "Manapool sales couldn't be loaded just now." } }; }
      if (ask !== restockAsked) return;    // a newer ask overtook this one
      restockAnswer = d;
      // A failed answer is shown but not kept: the next change (or Watch,
      // or reload) asks again. No timer, so no retry loop.
      if (!d || (d.sales && d.sales.error)) restockAsked = "";
    }
    restock = G.restockRows(c, restockAnswer);
    restockSorted = null;
    drawRestock();
  }
  function sortedRestock() {
    const sort = UI.sortStateOf($("restockBody").closest("table"));
    const key = sort && RESTOCK_SORT_KEYS[sort.col];
    if (!key) return restock;
    if (!restockSorted || restockSorted.src !== restock || restockSorted.col !== sort.col || restockSorted.dir !== sort.dir) {
      restockSorted = { src: restock, col: sort.col, dir: sort.dir, rows: G.sortRows(restock, key, sort.dir) };
    }
    return restockSorted.rows;
  }
  function drawRestock() {
    if ($("restockSec").hidden || !restockAnswer) return;
    const s = restockAnswer.sales || {};
    const body = $("restockBody"), more = $("btnRestockMore");
    $("restockHdr").textContent = restock.length ? "— " + restock.length + " card" + (restock.length === 1 ? "" : "s") : "";
    $("restockCount").textContent = restock.length || "";
    $("restockCount").hidden = !restock.length;
    // Too early to compare paces: only the week's top list can qualify yet.
    $("restockHint").innerHTML = "Cards you've sold or customers want, that you have none of, and that are selling well on Manapool this week." +
      (s.historySince && !s.comparable ? " It's too early to spot <b>SELLING FAST</b> cards, so for now this is the week's top " + (restockAnswer.topN || 100) + " only." : "") +
      ' <a href="/help.html#buy-restock">More in Help</a>';
    more.hidden = restock.length <= RESTOCK_SHOWN;
    more.textContent = restockAll ? "Show fewer" : "Show all " + restock.length;
    if (s.error || !s.historySince) {
      body.innerHTML = UI.emptyRow(7, { icon: s.error ? "error" : "history", title: s.error ? G.esc(s.error) : "No Manapool sales history has been collected yet." });
      return;
    }
    if (!restock.length) {
      body.innerHTML = UI.emptyRow(7, { icon: "cards", title: "Nothing to restock right now.",
        hint: "None of the cards you've sold or customers want, and are out of, is selling fast or in this week's top " + (restockAnswer.topN || 100) + " on Manapool." });
      return;
    }
    const rows = sortedRestock();
    const shown = restockAll ? rows : rows.slice(0, RESTOCK_SHOWN);
    const watched = new Set(G.state.watchList.map(w => G.watchKey(w)));
    body.innerHTML = shown.map((r, i) => {
      const isW = r.set && watched.has(rowWatchKey(r));
      const sub = r.printing ? G.printingLabel(r.set, r.collector, r.setName) + (r.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[r.finish].toLowerCase() : "")
        : "any printing";
      return '<tr class="click" tabindex="0">' +
        '<td class="card-name" data-vs="' + G.esc(r.name) + '">' + UI.cardLink(r) + '<small class="sub-sm">' + G.esc(sub) + "</small></td>" +
        '<td class="muted hide-sm"' + (r.printing ? "" : ' data-vs=""') + ">" + G.esc(sub) + "</td>" +
        UI.soldCountTd(r.sold7, r.atLeast, r.hot) +
        (r.rank != null ? '<td class="num hide-sm" data-v="' + r.rank + '">#' + r.rank.toLocaleString() + "</td>"
          : '<td class="num hide-sm" data-v="" title="Not among this week\'s sellers by name"><span class="faint">—</span></td>') +
        '<td class="num" data-v="' + r.ownSold + '">' + (r.ownSold ? r.ownSold.toLocaleString() : '<span class="faint">—</span>') + "</td>" +
        '<td class="num hide-sm" data-v="' + r.wanted + '">' + (r.wanted ? r.wanted : '<span class="faint">—</span>') + "</td>" +
        '<td class="row-actions">' + (r.set
          ? '<button class="small ' + (isW ? "" : "ghost") + '" data-i="' + i + '" title="' + (r.printing ? (isW ? "On your watch list" : "Add it to your watch list")
            : (isW ? "Its best-selling printing is on your watch list" : "Watch its best-selling printing, " + G.printingLabel(r.set, r.collector, r.setName))) + '">' +
            UI.icon("star") + (isW ? " Watching" : " Watch") + "</button>"
          : "") + "</td></tr>";
    }).join("");
    body.querySelectorAll("button[data-i]").forEach(btn => { btn.onclick = stop(() => toggleWatch(shown[Number(btn.dataset.i)])); });
    body.querySelectorAll("tr").forEach((tr, i) => {
      const r = shown[i];
      if (!r.set) return;
      const open = () => reviewPrinting(r.set, r.collector, r.lang, r.finish);
      tr.onclick = open;
      tr.onkeydown = e => { if (e.target === tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } };
    });
    UI.reapplySorts($("restockSec"));
  }

  async function renderWatch() {
    const items = G.state.watchList;
    $("watchHdr").textContent = items.length ? "— " + items.length + " card" + (items.length === 1 ? "" : "s") : "";
    if (!items.length) {
      $("watchBody").innerHTML = UI.emptyRow(12, { icon: "cards", title: "Nothing watched yet.",
        hint: "Add a card from the Missing from a set tab." });
      $("watchAlert").hidden = true;
      return;
    }
    let data;
    try {
      data = await G.api("/api/prices/watch", {
        method: "POST",
        body: { items: items.map(w => ({ set: w.set, collector: w.collector, lang: w.lang, finish: w.finish })), days: $("wDays").value }
      });
    } catch (e) {
      $("watchBody").innerHTML = UI.emptyRow(12, { icon: "error", title: "Could not load price data: " + G.esc(e.message) });
      return;
    }
    // No snapshots yet (or another server-side error): still list every
    // watched card, with blank prices, and show the message as a note (#246).
    if (data.error) $("watchHdr").textContent += " — " + data.error;
    const byKey = new Map((data.rows || []).map(r => [r.key + "|" + r.finish, r]));
    // A watch item never stored an image URL itself - a synchronous peek at
    // whatever's already cached (from browsing Results earlier, most likely)
    // avoids a fetch storm on every render; the row's own click still does a
    // real lookup so review always works even on a cold cache.
    const cachedImg = w => (G.cardCache.get(G.printKey(w.set, w.collector, w.lang || "en")) || {}).imageUrl || "";
    const hits = [];
    // #369: watched printings SELLING FAST on Manapool ("set|collector"; one
    // flag covers every finish and language of the printing).
    const fastKeys = new Set(data.fast || []), fast = new Map();
    $("watchBody").innerHTML = items.map((w, i) => {
      const row = byKey.get(G.watchKey(w));
      const now = row ? row.now : null, then = row ? row.then : null, delta = row ? row.delta : null;
      const nearLow = row && row.now != null && row.windowLow != null && row.now <= row.windowLow * 1.03;
      const belowMa = row && row.now != null && row.ma60 != null && row.now < row.ma60;
      const hit = G.watchTargetHit(w, now);
      if (hit) hits.push(w);
      const pk = String(w.set).toLowerCase() + "|" + w.collector;
      const isFast = fastKeys.has(pk);
      if (isFast && !fast.has(pk)) fast.set(pk, w);
      const signal = (isFast ? UI.sellingFastFlag(true) + (hit || nearLow || belowMa ? " " : "") : "") + (hit
        ? '<span class="badge cap" title="Crossed the target you set"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#bell></use></svg> Target hit</span>'
        : nearLow
        ? '<span class="badge sale" title="Within 3% of its low over the window above"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#trending-down></use></svg> Near low</span>'
        : belowMa
          ? '<span class="muted" title="' + (G.simpleMode ? "Cheaper than it usually is" : "Below its own 60-day average") + '">' + UI.icon("arrow-down") + (G.simpleMode ? " Cheaper than usual" : " Below 60d avg") + "</span>"
          : isFast ? "" : '<span class="muted">—</span>');
      return '<tr class="click ' + (nearLow || hit ? "signal-buy" : "") + (focusWatch && w.id === focusWatch ? " sel" : "") + '">' +
        UI.artThumbTd(cachedImg(w)) +
        '<td class="card-name">' + UI.cardLink(w) + '<small class="sub-sm">' + G.esc(G.printingLabel(w.set, w.collector, w.setName)) + (w.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[w.finish].toLowerCase() : "") + "</small></td>" +
        '<td class="muted hide-sm">' + G.esc(G.printingLabel(w.set, w.collector, w.setName)) + (w.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[w.finish].toLowerCase() : "") + "</td>" +
        '<td class="num">' + G.money(now) + "</td>" +
        '<td class="num hide-sm">' + G.money(then) + "</td>" +
        '<td class="num hide-sm ' + (delta > 0 ? "pos" : delta < 0 ? "neg" : "") + '">' +
          (delta == null ? "—" : (delta > 0 ? "+" : "") + G.money(delta)) + "</td>" +
        '<td class="num ' + (delta > 0 ? "pos" : delta < 0 ? "neg" : "") + '">' + G.pct(row ? row.pct : null) + "</td>" +
        '<td class="num muted hide-sm">' + G.money(row ? row.ma30 : null) + "</td>" +
        '<td class="num muted hide-sm">' + G.money(row ? row.ma60 : null) + "</td>" +
        '<td class="hide-sm">' + signal + "</td>" +
        '<td class="num" data-v="' + (w.target == null ? "" : w.target) + '">' +
          (w.target == null ? '<span class="muted">—</span>' : (w.targetDir === "above" ? "≥ " : "≤ ") + G.money(w.target)) + "</td>" +
        '<td class="row-actions">' +
          '<button class="small ghost" data-act="target" data-i="' + i + '" title="Set a price to be flagged at" aria-label="Set a target price"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#target></use></svg> Target</button>' +
          '<button class="small ghost" data-act="hist" data-i="' + i + '"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#trending-up></use></svg> History</button>' +
          '<button class="small ghost" data-act="unwatch" data-i="' + i + '">' + UI.icon("x") + " Remove</button>" +
        "</td></tr>";
    }).join("");
    renderWatchAlert(hits, [...fast.values()]);
    if (focusWatch && !focusScrolled) {
      focusScrolled = true;
      const i = items.findIndex(w => w.id === focusWatch);
      const tr = i >= 0 ? $("watchBody").querySelectorAll("tr")[i] : null;
      if (tr) { try { tr.scrollIntoView({ block: "center" }); } catch (e) {} }
      else UI.toast("That card isn't on this watch list any more.", "work");
    }
    $("watchBody").querySelectorAll('[data-act="target"]').forEach(btn => {
      btn.onclick = stop(() => editTarget(items[Number(btn.dataset.i)]));
    });
    $("watchBody").querySelectorAll('[data-act="hist"]').forEach(btn => {
      btn.onclick = stop(() => showHistory(items[Number(btn.dataset.i)]));
    });
    $("watchBody").querySelectorAll('[data-act="unwatch"]').forEach(btn => {
      btn.onclick = stop(async () => {
        const w = items[Number(btn.dataset.i)];
        const ok = await UI.confirmDialog("Stop watching " + w.name + "? Its price history stays, but it drops off this list.",
          { title: "Remove from watch list?", danger: true });
        if (!ok) return;
        G.state.watchList = G.state.watchList.filter(x => x.id !== w.id);
        G.logAudit({ action: "watch-list", note: "Removed " + w.name + " from the watch list" });
        G.persist();
        renderRows(rendered);
        renderWatch();
        UI.toast("Removed " + w.name + " from the watch list.", "ok");
      });
    });
    $("watchBody").querySelectorAll("tr").forEach((tr, i) => {
      const w = items[i];
      if (!w) return;
      UI.wireArtHover(tr, cachedImg(w));
      tr.onclick = () => reviewPrinting(w.set, w.collector, w.lang, w.finish);
    });
    UI.reapplySorts();
  }

  /* BACKLOG #79: the in-app half of watch-list alerts - a banner over the
     table naming every watched card that has crossed its target. #369: and
     a second one naming the watched printings SELLING FAST on Manapool, so
     the flag shows on a phone too (the Signal column is hidden there). */
  function renderWatchAlert(hits, fast) {
    const box = $("watchAlert");
    const parts = [];
    if (hits.length) parts.push(["warn", "bell", hits.length + " watched card" + (hits.length === 1 ? " has" : "s have") + " crossed your target",
      hits.map(w => "<b>" + UI.cardLink(w) + "</b> " + (w.targetDir === "above" ? "≥ " : "≤ ") + G.money(w.target)).join(" · ")]);
    if (fast.length) parts.push(["", "trending-up", fast.length + " watched card" + (fast.length === 1 ? " is" : "s are") + " SELLING FAST on Manapool",
      fast.map(w => "<b>" + UI.cardLink(w) + "</b> " + G.esc(String(w.set).toUpperCase()) + " #" + G.esc(w.collector)).join(" · ") +
      "<br>Sales in the last 7 days are well above their usual pace."]);
    box.hidden = !parts.length;
    box.innerHTML = parts.map(([cls, ic, title, body], i) =>
      '<div class="callout ' + cls + '" style="margin:' + (i < parts.length - 1 ? "0 0 8px" : "0") + '"><span class="cico">' + UI.icon(ic) +
      '</span><div class="cbody"><h3>' + title + "</h3>" + body + "</div></div>").join("");
  }

  function editTarget(w) {
    UI.ensureModal("targetModal", "", '<h3 id="tgTitle"></h3>' +
      '<div class="hint" style="margin-top:0">Flag this card on the watch list (and the Dashboard) once its price crosses this ' +
      "line. Uses the same price as the Now column.</div>" +
      '<div class="fields n2" style="margin-top:12px">' +
        '<label>Tell me when it\'s<select id="tgDir"><option value="below">at or below</option><option value="above">at or above</option></select></label>' +
        '<label>Price ($)<input id="tgPrice" type="number" min="0.01" step="0.01" inputmode="decimal"></label>' +
      "</div>" +
      '<div class="modal-actions" style="margin-top:14px"><button id="tgClear" class="ghost">Remove target</button>' +
        '<span class="spacer"></span><button id="tgCancel" class="ghost">Cancel</button>' +
        '<button id="tgSave" class="primary">Save target</button></div>');
    $("tgTitle").textContent = "Target price — " + w.name;
    $("tgDir").value = w.targetDir || "below";
    $("tgPrice").value = w.target == null ? "" : w.target;
    $("tgClear").hidden = w.target == null;
    const close = () => UI.hideModal("targetModal");
    const apply = (target, dir) => {
      const live = G.state.watchList.find(x => x.id === w.id);
      if (!live) { close(); return; }
      live.target = target; live.targetDir = dir;
      G.persist(target == null ? "Remove watch target" : "Set watch target");
      close();
      renderWatch();
    };
    $("tgCancel").onclick = close;
    $("tgClear").onclick = () => apply(null, "below");
    $("tgSave").onclick = () => {
      const v = Number($("tgPrice").value);
      if (!(v > 0)) { $("tgPrice").focus(); return; }
      apply(Math.round(v * 100) / 100, $("tgDir").value === "above" ? "above" : "below");
    };
    UI.showModal("targetModal", "tgPrice");
  }

  async function showHistory(w) {
    UI.showModal("histModal", "hClose");
    $("hTitle").textContent = w.name;
    $("hMeta").textContent = G.printingLabel(w.set, w.collector, w.setName) + (w.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[w.finish].toLowerCase() : "");
    $("hChart").innerHTML = UI.skeletonBlock(4);
    $("hTable").innerHTML = "";
    let h;
    try { h = await G.api("/api/prices/history?key=" + encodeURIComponent(G.printKey(w.set, w.collector, w.lang))); }
    catch (e) { $("hChart").innerHTML = UI.emptyBlock({ icon: "error", title: "Could not load history: " + G.esc(e.message) }); return; }
    const maSeries = w.finish === "etched" ? { ma30: h.etchedMa30, ma60: h.etchedMa60 }
      : w.finish === "foil" ? { ma30: h.foilMa30, ma60: h.foilMa60 } : { ma30: h.usdMa30, ma60: h.usdMa60 };
    $("hChart").innerHTML = UI.lineChart({
      labels: h.dates,
      series: [
        { values: h.usd, cls: "" },
        { values: h.foil, cls: "foil" },
        { values: h.etched, cls: "etched" },
        // Moving-average lines are a trader's view: left off in Simple mode (#325).
        ...(G.simpleMode ? [] : [{ values: maSeries.ma30, cls: "ma30" }, { values: maSeries.ma60, cls: "ma60" }])
      ],
      width: 1000, height: 320,
      title: w.name + " price history"
    });
    const n = h.dates.length;
    if (n) {
      const series = w.finish === "etched" ? h.etched : w.finish === "foil" ? h.foil : h.usd;
      const known = series.map((v, i) => ({ v, d: h.dates[i] })).filter(x => x.v != null);
      if (known.length) {
        const first = known[0], last = known[known.length - 1];
        const hi = known.reduce((a, b) => (b.v > a.v ? b : a));
        const lo = known.reduce((a, b) => (b.v < a.v ? b : a));
        $("hTable").innerHTML =
          '<div class="summary">' +
          '<div class="stat"><span class="big">' + G.money(last.v) + '</span><span class="lbl">Latest (' + last.d + ")</span></div>" +
          '<div class="stat"><span class="big">' + G.money(first.v) + '</span><span class="lbl">First (' + first.d + ")</span></div>" +
          '<div class="stat"><span class="big val">' + G.money(hi.v) + '</span><span class="lbl">High (' + hi.d + ")</span></div>" +
          '<div class="stat"><span class="big neg">' + G.money(lo.v) + '</span><span class="lbl">Low (' + lo.d + ")</span></div>" +
          '<div class="stat"><span class="big">' + n + '</span><span class="lbl">Snapshots</span></div>' +
          "</div>";
      }
    }
    // Every vendor side by side (BACKLOG #78a) - for a buyer, the LOWEST
    // listing is the interesting one; the table shows both ends.
    $("hTable").insertAdjacentHTML("beforeend", UI.vendorCompare(h, w.finish));
  }

  /* ============================== Buy menu ============================== */
  function openBuyMenu(row) {
    $("buyTitle").textContent = "Buy — " + row.name;
    if (!row.printings.length) {
      $("buyBody").innerHTML = UI.emptyBlock({ icon: "money", title: "No priced printing on file for this card." });
    } else {
      $("buyBody").innerHTML =
        '<table class="list"><thead><tr><th>Printing</th><th>Finish</th><th class="num">Price</th><th></th></tr></thead><tbody>' +
        row.printings.map(p =>
          "<tr><td>" + G.esc(G.printingLabel(p.set, p.collector, p.setName)) + "</td>" +
          "<td>" + (p.finish === "nonfoil" ? '<span class="muted">—</span>' : G.esc(G.FINISH_NAMES[p.finish])) + "</td>" +
          '<td class="num">' + G.money(p.price) + "</td>" +
          '<td><a href="' + G.esc(G.manapoolUrl(p.set, p.collector, p.name)) + '" target="_blank" rel="noopener">' + UI.icon("external-link") + " Manapool</a></td></tr>"
        ).join("") + "</tbody></table>";
    }
    UI.showModal("buyModal", "buyClose");
  }

  /* ============================== Friends who have it ============================== */
  function openFriendsModal(row) {
    $("frTitle").textContent = "Who owns " + row.name;
    $("frBody").innerHTML = row.friends.map(f =>
      '<div class="move-box" style="margin-bottom:10px"><strong>' + G.esc(f.username) + "</strong>" +
      // #128: a friend who shares a store's inventory is shown as such.
      (f.store ? ' <span class="muted">· ' + G.esc(f.store.name + (f.store.orgName ? " (" + f.store.orgName + ")" : "")) + "</span>" : "") +
      '<div class="hint" style="margin:4px 0 8px">' +
      f.printings.map(p => G.esc(G.printingLabel(p.set, p.collector)) +
        (p.finish !== "nonfoil" ? " · " + G.esc(G.FINISH_NAMES[p.finish]) : "") + " × " + p.qty
      ).join("<br>") + "</div>" +
      '<button class="small" data-user="' + G.esc(f.username) + '"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#handshake></use></svg> Offer trade</button></div>'
    ).join("");
    $("frBody").querySelectorAll("button[data-user]").forEach(btn => {
      btn.onclick = () => openTradeOffer(row, btn.dataset.user);
    });
    UI.showModal("friendsModal", "frClose");
  }

  /* ============================== Offer trade ============================== */
  /* The suggestion/balance engine and the modal itself both moved to the
     shared public/js/tradeCompose.js (2026-09-17), so Trade Proposals and
     Social's own "new proposal" composer can use the same logic instead of
     duplicating it - this page just hands it the one card already in mind. */
  function openTradeOffer(row, username) {
    TradeCompose.openForRow(row, username);
  }

  function exportCsv() {
    if (!rendered.length) { UI.toast("Nothing to export.", "err"); return; }
    const head = ["Card", "Set", "Number", "Rarity", "Price (main printing)", "Low Price", "High Price", "Own: This Printing", "Own: Any Printing", "Friends With It"];
    const lines = [head.map(G.csvCell).join(",")];
    for (const r of rendered) {
      lines.push([r.name, r.setName + " (" + r.set.toUpperCase() + ")", r.number, r.rarity || "",
        mainPrice(r) == null ? "" : mainPrice(r).toFixed(2), r.low == null ? "" : r.low.toFixed(2), r.high == null ? "" : r.high.toFixed(2),
        r.ownedThis, r.owned, r.friends.map(f => f.username).join("; ")].map(G.csvCell).join(","));
    }
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-buy-list.csv");
    UI.toast("Exported " + rendered.length + " rows.", "ok");
  }

  UI.boot(async function () {
    if (G.simpleMode) {
      // #325: plain labels; Then / change in dollars / the two averages are hidden by CSS.
      $("thChange").textContent = "Change";
      $("thSignal").textContent = "Price hint";
      $("watchHintSimple").hidden = false;
    }
    await loadSets();

    $("bwSet").onchange = () => { $("bwSearch").value = ""; run(); };
    $("bwSearch").addEventListener("input", G.debounce(() => { if ($("bwSearch").value.trim()) $("bwSet").value = ""; run(); }, 300));
    document.querySelectorAll('input[name="bwOwn"]').forEach(el => { el.onchange = run; });
    $("btnCsv").onclick = exportCsv;
    $("bwFinish").onchange = () => renderRows(rendered);
    $("buyClose").onclick = () => UI.hideModal("buyModal");
    $("frClose").onclick = () => UI.hideModal("friendsModal");
    for (const id of ["buyModal", "friendsModal"]) {
      $(id).addEventListener("click", e => { if (e.target.id === id) UI.hideModal(id); });
    }

    $("wDays").onchange = renderWatch;
    $("btnWatchReload").onclick = renderWatch;
    $("hClose").onclick = () => UI.hideModal("histModal");
    $("histModal").addEventListener("click", e => { if (e.target.id === "histModal") UI.hideModal("histModal"); });
    // A watch item can be added/removed from another tab (or another device,
    // via a background reload of the collection) - same debounce idiom
    // stats.page.js already uses for its own "anything changed" re-render.
    G.on("change", G.debounce(renderWatch, 200));
    renderWatch();
    // Restock (#370): stock, tickets or wants changing elsewhere redraw it; the
    // server is asked again only when the candidates themselves changed.
    UI.dataSort($("restockBody").closest("table"), () => drawRestock());
    $("btnRestockMore").onclick = () => { restockAll = !restockAll; drawRestock(); };
    G.on("change", G.debounce(loadRestock, 300));
    loadRestock();

    const pSet = params.get("set") || "";
    const pQ = params.get("q") || "";
    const pCollector = params.get("collector") || "";
    if (pSet) $("bwSet").value = pSet;

    // The tab is remembered (UI.pageTabs). A link to a set or a card, or one
    // that opens a friend's copy, lands on the set tab; a watch link on Watch list.
    tabs = UI.pageTabs({ tabs: [
      { id: "watch", button: "tabWatch", panes: ["paneWatch"] },
      { id: "restock", button: "tabRestock", panes: ["paneRestock"] },
      { id: "set", button: "tabSet", panes: ["paneSet"] }
    ] });
    if (pSet || pQ || (focusWatch && params.get("friend"))) tabs.show("set");
    else if (focusWatch) tabs.show("watch");

    // #410: opened from the card panel (?q= + set/collector): show why only
    // this card is here; clearing it reloads the page without the filter.
    if (pQ && !focusWatch) {
      UI.cardFilterChip($("bwSearch").closest(".toolbar, .form-row, div"), UI.cardFilterFromUrl(), pSet && pCollector ? pQ + " (" + pSet.toUpperCase() + " #" + pCollector + ")" : pQ, () => location.reload());
    }
    if (pQ && pSet && pCollector) {
      setOwnFilter("all");
      await runSingle(pSet, pCollector, pQ);
    } else if (pQ) {
      $("bwSearch").value = pQ;
      setOwnFilter("all");
      await run();
    } else if (pSet) {
      await run();
    } else if (!focusWatch || !params.get("friend")) {
      UI.setStatus("status", "Pick a set, or search by name.", "");
    }
    if (focusWatch && params.get("friend")) await showFriendFor(focusWatch, params.get("friend").toLowerCase().trim());
  });

  /* The watched card as a result row, with the friend's copies open, so the
     trade is one click away. /api/friends/have decides who is listed (Full
     shares only), so a friend who stopped sharing simply isn't. */
  async function showFriendFor(watchId, username) {
    const w = G.state.watchList.find(x => x.id === watchId);
    if (!w) return;
    await runSingle(w.set, w.collector, w.name);
    const row = rendered.find(r => r.oracleId && r.oracleId === w.oracleId) || rendered[0];
    if (!row) return;
    const idx = rendered.indexOf(row);
    const tr = $("resBody").querySelectorAll("tr")[idx];
    if (tr) tr.classList.add("sel");
    if (row.friends.some(f => f.username === username)) openFriendsModal(row);
    else UI.toast(username + " isn't sharing this card with you any more.", "work");
  }
})();
