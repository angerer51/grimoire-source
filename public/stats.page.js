
"use strict";
(function () {
  const $ = UI.$;
  let query = null;

  /* ============================== Tabs ============================== */
  // BACKLOG.md #28 originally left the six small breakdown widgets (colour/
  // rarity/type/price band/finish/data quality) always-visible in a col-right
  // sidebar next to every tab, as an "ambient" tier. #30 reversed that call:
  // always-visible next to EVERY tab just moved the "too much on one screen"
  // complaint sideways instead of fixing it. They're their own "Breakdowns"
  // tab now, same as every other pane - stats.html is pure tabs, no
  // persistent sidebar.
  const PANES = {
    locations: ["paneLocations"], sealed: ["paneSealed"], collector: ["paneCollector"],
    topstacks: ["paneTopStacks"], sold: ["paneSold"], activity: ["paneActivity"],
    breakdowns: ["paneBreakdowns"]
  };
  const TAB_ID = { locations: "tabLocations", sealed: "tabSealed", collector: "tabCollector",
    topstacks: "tabTopStacks", sold: "tabSold", activity: "tabActivity", breakdowns: "tabBreakdowns" };
  let tabs;

  function scope() {
    const loc = $("scopeLoc").value;
    return G.state.cards.filter(r => G.matchesQuery(r, query) && (!loc || r.locationId === loc));
  }

  /* Sealed has none of the query's matchable fields (color/rarity/type…),
     so this section deliberately only respects the location filter, not
     the query above - see the hint on the page itself. */
  function sealedScope() {
    const loc = $("scopeLoc").value;
    return G.state.sealed.filter(r => !loc || r.locationId === loc);
  }

  const tile = (big, lbl, cls, extra) =>
    '<div class="tile"><span class="big ' + (cls || "") + '">' + big + "</span>" +
    '<span class="lbl">' + lbl + "</span>" +
    (extra ? '<div class="muted" style="font-size:12px;margin-top:4px">' + extra + "</div>" : "") + "</div>";

  /* Group rows by a key function into [{label, cards, stacks, value, cost}] */
  function group(rows, keyFn) {
    const map = new Map();
    for (const r of rows) {
      for (const key of [].concat(keyFn(r))) {
        const k = key == null || key === "" ? "(unknown)" : String(key);
        let g = map.get(k);
        if (!g) { g = { label: k, cards: 0, stacks: 0, value: 0, cost: 0 }; map.set(k, g); }
        g.cards += r.quantity;
        g.stacks++;
        g.value += G.rowTotal(r);
        g.cost += Number(r.costTotal) || 0;
      }
    }
    return [...map.values()];
  }

  function bars(groups, metric, opts) {
    const o = opts || {};
    const rows = groups.slice()
      .sort((a, b) => (b[metric] || 0) - (a[metric] || 0))
      .slice(0, o.limit || 25)
      .map(g => ({
        label: g.label,
        value: g[metric] || 0,
        text: metric === "value" || metric === "cost" ? G.money(g[metric])
          : (g[metric] || 0).toLocaleString() + (o.suffix || "")
      }));
    return UI.barList(rows, { alt: o.alt });
  }

  /* ============================== Render ============================== */
  function render() {
    const rows = scope();
    const total = G.state.cards.length;
    $("scopeHdr").textContent = rows.length === total
      ? "whole collection · " + total + " stacks"
      : rows.length + " of " + total + " stacks selected";

    const cards = rows.reduce((s, r) => s + r.quantity, 0);
    const value = rows.reduce((s, r) => s + G.rowTotal(r), 0);
    const cost = G.costSummary(rows);
    const names = new Set(rows.map(r => r.name.toLowerCase())).size;
    const listed = rows.reduce((s, r) => s + (r.listedQty || 0), 0);
    const foils = rows.filter(r => r.finish === "foil").reduce((s, r) => s + r.quantity, 0);
    const etched = rows.filter(r => r.finish === "etched").reduce((s, r) => s + r.quantity, 0);
    const priced = rows.filter(r => r.price != null).reduce((s, r) => s + r.quantity, 0);

    $("tiles").innerHTML =
      tile(cards.toLocaleString(), "Cards", "", names.toLocaleString() + " distinct names") +
      tile(rows.length.toLocaleString(), "Stacks", "",
        new Set(rows.map(r => r.locationId)).size + " location(s)") +
      tile(G.money(value), "Market value", "val",
        (priced ? G.money(value / priced) + " average per priced card" : "") +
        (cards > priced ? "<br>" + G.unpricedNote(cards - priced) + "." : "") +
        '<br><span data-price-basis>Near Mint market price</span>') +
      tile(G.money(cost.cost), "Cost basis", "",
        cost.costCards.toLocaleString() + " of " + cards.toLocaleString() + " cards (" +
        Math.round(cost.coverage * 100) + "%)") +
      tile(cost.cost > 0 ? G.money(cost.gain) : "—", "Unrealised gain", cost.gain >= 0 ? "val" : "neg",
        cost.gainPct == null ? "no cost basis to compare" : G.pct(cost.gainPct) + " on the copies with a cost") +
      tile(listed.toLocaleString(), "Marked to list", "",
        G.money(rows.reduce((s, r) => s + (r.price == null ? 0 : r.price * (r.listedQty || 0)), 0)) + " of value") +
      tile(foils.toLocaleString(), "Foils", "",
        cards ? Math.round((foils / cards) * 100) + "% of the selection" : "") +
      tile(priced.toLocaleString(), "Cards with a price", "",
        (cards - priced) + " with none on file");
    G.paintPriceBasis($("tiles"));

    $("byLoc").innerHTML = bars(group(rows, r => G.locName(r.locationId)), $("locMetric").value, { limit: 30 });
    $("bySet").innerHTML = bars(group(rows, r => (r.setName || r.set.toUpperCase())), $("setMetric").value, { limit: 20, alt: true });
    $("byColor").innerHTML = bars(group(rows, r => {
      const ci = G.normColors(r.colorIdentity);
      return ci.join("") === "C" ? "Colorless" : ci.join("");
    }), "cards", { limit: 20 });
    $("byRarity").innerHTML = bars(group(rows, r => (r.rarity || "(unknown)")), "cards", { limit: 10, alt: true });
    $("byType").innerHTML = bars(group(rows, r => {
      const t = G.typeParts(r.typeLine).types;
      return t.length ? t.map(x => x.charAt(0).toUpperCase() + x.slice(1)) : "(unknown)";
    }), "cards", { limit: 15 });

    const BANDS = [
      ["no price", r => r.price == null],
      ["under $0.25", r => r.price != null && r.price < 0.25],
      ["$0.25 – $1", r => r.price >= 0.25 && r.price < 1],
      ["$1 – $5", r => r.price >= 1 && r.price < 5],
      ["$5 – $20", r => r.price >= 5 && r.price < 20],
      ["$20 – $100", r => r.price >= 20 && r.price < 100],
      ["$100+", r => r.price >= 100]
    ];
    $("byBand").innerHTML = UI.barList(BANDS.map(([label, test]) => {
      const hit = rows.filter(test);
      return {
        label, value: hit.reduce((s, r) => s + r.quantity, 0),
        text: hit.reduce((s, r) => s + r.quantity, 0).toLocaleString() + " · " +
          G.money(hit.reduce((s, r) => s + G.rowTotal(r), 0))
      };
    }).filter(b => b.value > 0), { alt: true });

    const finish = [
      { label: "Non-foil", value: rows.filter(r => r.finish === "nonfoil").reduce((s, r) => s + r.quantity, 0) },
      { label: "Foil", value: foils },
      { label: "Etched foil", value: etched }
    ].filter(x => x.value > 0).map(x => ({ label: x.label, value: x.value, text: x.value.toLocaleString() }));
    const langs = group(rows, r => G.LANG_NAMES[r.lang] || r.lang)
      .sort((a, b) => b.cards - a.cards)
      .map(g => ({ label: g.label, value: g.cards, text: g.cards.toLocaleString() }));
    $("byMisc").innerHTML = UI.barList(finish) + "<hr>" + UI.barList(langs, { alt: true });

    const noMeta = rows.filter(r => !r.typeLine).reduce((s, r) => s + r.quantity, 0);
    const failed = rows.filter(r => r.lookupFail).length;
    const noPrice = rows.filter(r => r.price == null).length;
    const stale = rows.filter(r => !r.priceUpdated ||
      (Date.now() - Date.parse(r.priceUpdated)) > 14 * 86400000).length;
    $("quality").innerHTML = UI.barList([
      { label: "Cards missing card data", value: noMeta, text: noMeta.toLocaleString() },
      { label: "Stacks with no price", value: noPrice, text: noPrice.toLocaleString() },
      { label: "Stacks whose lookup failed", value: failed, text: failed.toLocaleString() },
      { label: "Stacks not priced in 14 days", value: stale, text: stale.toLocaleString() },
      { label: "Stacks with no cost basis", value: rows.filter(r => !(Number(r.costQty) > 0)).length,
        text: rows.filter(r => !(Number(r.costQty) > 0)).length.toLocaleString() }
    ].filter(x => x.value > 0)) +
      ((noMeta || failed || noPrice)
        ? '<div class="hint">Run <b>Refresh prices &amp; data</b> on the ' +
          '<a href="/inventory.html">Inventory</a> page to fill these in.</div>'
        : '<div class="hint good">Nothing obviously missing in this selection.</div>');

    const top = rows.slice().sort((a, b) => G.rowTotal(b) - G.rowTotal(a)).slice(0, 40);
    $("topBody").innerHTML = top.length ? top.map(r => {
      const gain = UI.rowGain(r);
      return '<tr class="click">' +
        UI.artThumbTd(r.imageUrl) +
        '<td class="card-name">' + UI.cardLink(r) + "</td>" +
        '<td class="muted hide-sm">' + G.esc(G.recPrinting(r)) + "</td>" +
        "<td>" + (r.finish === "etched" ? '<span class="badge etched">ETCHED</span>' : r.finish === "foil" ? '<span class="badge foil">FOIL</span>' : '<span class="muted">—</span>') + "</td>" +
        '<td class="num">' + r.quantity + "</td>" +
        '<td class="num hide-sm">' + G.money(r.price) + "</td>" +
        '<td class="num">' + G.money(G.rowTotal(r)) + "</td>" +
        '<td class="num hide-sm">' + (Number(r.costQty) ? G.money(r.avgCost) : '<span class="muted">—</span>') + "</td>" +
        '<td class="num ' + (gain == null ? "" : gain >= 0 ? "good" : "bad") + '">' +
          (gain == null ? "—" : G.money(gain)) + "</td>" +
        '<td class="hide-sm">' + G.esc(G.locName(r.locationId)) + "</td></tr>";
    }).join("") : UI.emptyRow(10, { icon: "search", title: "Nothing in this selection." });
    $("topBody").querySelectorAll("tr").forEach((tr, i) => {
      const r = top[i];
      if (!r) return;
      UI.wireArtHover(tr, r.imageUrl);
      tr.onclick = () => UI.reviewRecord(r);
    });

    renderSealedStats();
    renderReturnStats();
    // Not awaited, same as the rest of render(). It only goes to the network
    // when the set of sold printings changed since the last fetch (#115);
    // a location/metric/query change redraws from the prices in hand.
    renderSold();
    renderReceipts();
    renderCollector();
    UI.reapplySorts();
  }

  /* Returns don't have a query/location scope of their own the way sealed
     does above - a return already names its own destination location, and
     there are usually few enough of them that filtering doesn't earn its
     keep. Whole-account, always. */
  function renderReturnStats() {
    const rows = G.state.returns;
    const qty = rows.reduce((s, r) => s + (Number(r.totalQty) || 0), 0);
    const refunded = rows.reduce((s, r) => s + (Number(r.refundTotal) || 0), 0);
    const damaged = rows.filter(r => r.disposition === "damaged").reduce((s, r) => s + (Number(r.totalQty) || 0), 0);
    $("retTiles").innerHTML =
      tile(rows.length.toLocaleString(), "Returns") +
      tile(qty.toLocaleString(), "Cards returned") +
      tile(G.money(refunded), "Refunded", "neg") +
      tile(damaged.toLocaleString(), "Written off as damaged", damaged ? "neg" : "");
    $("retStatHdr").textContent = rows.length ? rows.length + " on file" : "none yet";
    const body = $("retStatBody");
    body.innerHTML = rows.length ? rows.slice(0, 200).map(r =>
      "<tr><td><b>" + G.esc(r.returnId || "—") + "</b></td>" +
      "<td>" + G.esc(new Date(r.ts).toLocaleDateString()) + "</td>" +
      "<td>" + G.esc(r.orderLabel || "") + "</td>" +
      '<td><span class="pill type">' + G.esc(r.disposition || "restock") + "</span></td>" +
      '<td class="num">' + r.totalQty + "</td>" +
      '<td class="num">' + (r.refundTotal == null ? '<span class="muted">—</span>' : G.money(r.refundTotal)) + "</td></tr>"
    ).join("") : UI.emptyRow(6, { icon: "orders", title: "No returns recorded yet.",
      hint: 'See the <a href="/returns.html">Returns</a> page.' });
  }

  function renderSealedStats() {
    const rows = sealedScope();
    const qty = rows.reduce((s, r) => s + r.quantity, 0);
    const value = rows.reduce((s, r) => s + G.rowTotal(r), 0);
    const cost = G.costSummary(rows);
    $("sealedTiles").innerHTML =
      tile(rows.length.toLocaleString(), "SKUs") +
      tile(qty.toLocaleString(), "Total quantity") +
      tile(G.money(value), "Market value", "val", qty ? G.money(value / qty) + " average per item" : "") +
      tile(G.money(cost.cost), "Cost basis", "",
        cost.cost > 0 ? G.pct(cost.gainPct) + " unrealised gain" : "no cost basis on file");
    $("sealedByLoc").innerHTML = rows.length
      ? bars(group(rows, r => G.locName(r.locationId)), "value", { limit: 30 })
      : UI.emptyBlock({ icon: "orders", title: "Nothing sealed in this selection." });
  }

  /* Collector view: what % of each set's unique card names you own - not
     scoped by the location/query filter above, since "how complete is this
     set" is a whole-collection question, not one about a filtered slice.
     Default order is most-complete first (highest % first). */
  let collectorRunId = 0;
  // The owned key set the table was last fetched for (or is being fetched
  // for). The view ignores the location filter and the query, so only a
  // change to what's owned needs a new POST (#115); at 70k stacks the body
  // is large. Cleared on failure so the next render retries.
  let collectorKeys = null;
  async function renderCollector() {
    const keySet = new Set();
    for (const r of G.state.cards) if (r.oracleId) keySet.add(r.set + "|" + r.oracleId);
    if (G.sameKeySet(keySet, collectorKeys)) return;
    collectorKeys = keySet;
    const runId = ++collectorRunId;
    let sets;
    try { sets = (await G.api("/api/cards/set-completion", { method: "POST", body: { owned: [...keySet] } })).data || []; }
    catch (e) {
      if (runId !== collectorRunId) return;
      collectorKeys = null;
      $("collBody").innerHTML = UI.emptyRow(6, { icon: "error", title: "Could not load: " + G.esc(e.message) });
      return;
    }
    if (runId !== collectorRunId) return;   // a newer call already landed
    sets = sets.filter(s => s.total > 0).sort((a, b) => (b.owned / b.total) - (a.owned / a.total));
    $("collHdr").textContent = sets.length ? "— " + sets.length + " sets" : "";
    if (!sets.length) {
      $("collBody").innerHTML = UI.emptyRow(6, { icon: "history", title: "No set data loaded yet." });
      return;
    }
    $("collBody").innerHTML = sets.map(s => {
      const pct = s.total ? (s.owned / s.total) * 100 : 0;
      return "<tr><td>" + G.esc(s.setName) + '<span class="muted"> (' + s.set.toUpperCase() + ")</span></td>" +
        "<td>" + G.esc(s.released || "") + "</td>" +
        '<td class="num">' + s.owned.toLocaleString() + " / " + s.total.toLocaleString() + "</td>" +
        '<td class="num">' + Math.round(pct) + "%</td>" +
        '<td><span class="bar-track" style="width:100px"><span class="bar' +
          (pct >= 100 ? " alt" : "") + '" style="width:' + Math.max(1, pct).toFixed(1) + '%"></span></span></td>' +
        '<td><a href="/buy-list.html?set=' + encodeURIComponent(s.set) + '">What\'s missing →</a></td></tr>';
    }).join("");
    UI.reapplySorts();
  }

  /* Receipt performance: what the cards from each receipt are worth now. */
  function renderReceipts() {
    const rows = G.state.receipts.filter(r => r.spend != null && r.spend > 0);
    $("recHdr").textContent = rows.length
      ? rows.length + " receipt" + (rows.length === 1 ? "" : "s") + " with a purchase price"
      : "no receipts with a purchase price yet";
    const body = $("recBody");
    if (!rows.length) {
      body.innerHTML = UI.emptyRow(9, { icon: "money", title: "Nothing to measure yet.",
        hint: "A lot receipt with a purchase price shows up here once it is posted." });
      return;
    }
    // One pass over the stacks per render, then a Map lookup per receipt
    // line (#115). It was a full collection scan per line: seconds of main-
    // thread work at 70k stacks and a few hundred lot receipts.
    const idx = G.printFinishIndex(G.state.cards);
    body.innerHTML = rows.map(r => {
      // Market value of the printings on the receipt, at the quantities received.
      const { market, priced } = G.receiptMarket(r, idx);
      const gain = market - r.spend;
      const ret = r.spend > 0 ? (gain / r.spend) * 100 : null;
      return "<tr><td><b>" + G.esc(r.receiptId || "—") + "</b></td>" +
        "<td>" + G.esc(new Date(r.ts).toLocaleDateString()) + "</td>" +
        '<td class="hide-sm"><span class="pill type">' + G.esc(r.kind) + "</span></td>" +
        '<td class="hide-sm">' + G.esc(r.source || r.fromUser || "") + "</td>" +
        '<td class="num hide-sm">' + r.totalCards + (priced < r.totalCards ? ' <span class="muted" title="' +
          (r.totalCards - priced) + ' card(s) have no price">*</span>' : "") + "</td>" +
        '<td class="num">' + G.money(r.spend) + "</td>" +
        '<td class="num hide-sm">' + G.money(market) + "</td>" +
        '<td class="num ' + (gain >= 0 ? "good" : "bad") + '">' + G.money(gain) + "</td>" +
        '<td class="num ' + (gain >= 0 ? "good" : "bad") + '">' + G.pct(ret) + "</td></tr>";
    }).join("");
  }

  /* ============================== Sold vs market price ==============================
     Ticket ask (criticalhops): "the market value... is skewed from what the
     true card cost is on the seller page" - i.e. compare what a printing
     ACTUALLY sold for against its current market price, not just show
     market price everywhere like every other page already does. The real
     sale prices already exist (core.js's completePickList freezes each
     shipped line's order-sourced unitPrice onto state.history, captured for
     BACKLOG.md #19's accounting export) - nothing here needed a new data
     source, just a new lens on data already being recorded. Grouped by
     set/collector/finish, not lang - a sale line never carried language, so
     comparing by language isn't possible without changing what gets
     recorded going forward; the hint in stats.html says so. */
  function soldGroups() {
    const groups = new Map();
    for (const h of G.state.history) {
      if (h.type !== "pick") continue;
      for (const l of (h.lines || [])) {
        if (l.unitPrice == null || !l.set || !l.collector || !(l.qty > 0)) continue;
        const finish = l.finish || "nonfoil";
        const key = l.set + "|" + l.collector + "|" + finish;
        let g = groups.get(key);
        if (!g) { g = { name: l.name, set: l.set, collector: l.collector, finish, qty: 0, total: 0 }; groups.set(key, g); }
        g.qty += l.qty;
        g.total += l.unitPrice * l.qty;
      }
    }
    return [...groups.values()];
  }
  /* Current market prices for the sold printings, fetched once per distinct
     set of printings (#115), not on every render: the route can call
     Manapool live, and a location or metric change has nothing to do with
     sales. `soldPrices` is {keys, found} for the last good fetch (one entry,
     replaced, never grows); `soldInflight` shares a fetch already running
     for the same keys. The run id drops a response a newer render superseded. */
  let soldPrices = null, soldInflight = null, soldRunId = 0;
  const soldKeys = groups => new Set(groups.map(g => G.printKey(g.set, g.collector, "en")));
  function soldMarket(groups, keys) {
    if (soldPrices && G.sameKeySet(keys, soldPrices.keys)) return Promise.resolve(soldPrices.found);
    if (!soldInflight || !G.sameKeySet(keys, soldInflight.keys)) {
      const identifiers = groups.map(g => ({ set: g.set, collector: g.collector, lang: "en" }));
      const p = G.cards.collection(identifiers).then(out => {
        const found = new Map();
        for (const c of out.found || []) found.set(G.printKey(c.set, c.collector, c.lang), c);
        soldPrices = { keys, found };
        return found;
      }).finally(() => { if (soldInflight && soldInflight.p === p) soldInflight = null; });
      soldInflight = { keys, p };
    }
    return soldInflight.p;
  }
  async function renderSold() {
    const runId = ++soldRunId;
    const groups = soldGroups();
    const body = $("soldBody");
    const tiles = $("soldTiles");
    $("soldHdr").textContent = groups.length ? groups.length + " printing(s) with a real sale" : "";
    tiles.innerHTML = "";
    if (!groups.length) {
      body.innerHTML = UI.emptyRow(9, { icon: "money", title: "No sales with a captured sale price yet.",
        hint: "Ship a Manapool order or sell cards on a walk-in order to start building this up." });
      return;
    }
    const keys = soldKeys(groups);
    if (!(soldPrices && G.sameKeySet(keys, soldPrices.keys))) body.innerHTML = UI.skeletonRows(9, 4);
    let found;
    try {
      found = await soldMarket(groups, keys);
    } catch (e) {
      if (runId !== soldRunId) return;
      body.innerHTML = UI.emptyRow(9, { icon: "error", title: "Could not load current market prices: " + G.esc(e.message) });
      return;
    }
    if (runId !== soldRunId) return;   // a newer render superseded this one
    groups.sort((a, b) => b.qty - a.qty);
    // BACKLOG.md #72: totalSold covers every real sale, always known. The
    // market side (and so the delta) can only be computed over printings
    // that still resolve a current price - a group with none excluded here
    // the same way its own row already shows "no longer priced" rather than
    // counting it as $0 market value, which would inflate an apparent loss
    // with no real basis.
    let totalSold = 0, matchedSold = 0, totalMarket = 0, unpriced = 0;
    body.innerHTML = groups.map(g => {
      const avgSold = g.total / g.qty;
      const card = found.get(G.printKey(g.set, g.collector, "en"));
      const market = card ? G.priceOf(card, g.finish) : null;
      const delta = market != null && market > 0 ? (avgSold - market) / market * 100 : null;
      totalSold += g.total;
      if (market != null && market > 0) { matchedSold += g.total; totalMarket += market * g.qty; }
      else unpriced++;
      return '<tr class="' + (card ? "click" : "") + '">' +
        UI.artThumbTd(card ? card.imageUrl : "") +
        '<td class="card-name">' + UI.cardLink({ name: g.name, set: g.set, collector: g.collector, finish: g.finish }) + "</td>" +
        '<td class="hide-sm">' + G.esc(g.set.toUpperCase()) + "</td>" +
        '<td class="hide-sm">' + G.esc(g.collector) + "</td>" +
        "<td>" + (g.finish === "etched" ? '<span class="badge etched">ETCHED</span>' :
          g.finish === "foil" ? '<span class="badge foil">FOIL</span>' : '<span class="muted">—</span>') + "</td>" +
        '<td class="num hide-sm">' + g.qty + "</td>" +
        '<td class="num">' + G.money(avgSold) + "</td>" +
        '<td class="num">' + (market == null ? '<span class="muted">no longer priced</span>' : G.money(market)) + "</td>" +
        '<td class="num ' + (delta == null ? "" : delta >= 0 ? "good" : "bad") + '">' +
        (delta == null ? '<span class="muted">—</span>' : (delta >= 0 ? "+" : "") + delta.toFixed(1) + "%") + "</td></tr>";
    }).join("");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const g = groups[i];
      const card = g && found.get(G.printKey(g.set, g.collector, "en"));
      if (!card) return;
      UI.wireArtHover(tr, card.imageUrl);
      tr.onclick = () => UI.reviewCard(card, g.finish);
    });
    UI.reapplySorts();

    const marketDelta = matchedSold - totalMarket;
    const marketPct = totalMarket > 0 ? marketDelta / totalMarket * 100 : null;
    tiles.innerHTML =
      tile(G.money(totalSold), "Total sold", "", groups.length + " printing(s)") +
      tile(G.money(totalMarket), "Current market value", "",
        "of those same sold units" + (unpriced ? " · " + unpriced + " printing(s) no longer priced, excluded" : "")) +
      tile(marketPct == null ? "—" : G.money(marketDelta), "Δ vs market",
        marketPct == null ? "" : marketDelta >= 0 ? "val" : "neg",
        marketPct == null ? "" : G.pct(marketPct) + " · matched printings only");
  }

  function renderChip() {
    const chip = $("queryChip");
    const n = G.queryFieldCount(query);
    if (!n) { chip.hidden = true; chip.innerHTML = ""; return; }
    chip.hidden = false;
    chip.innerHTML = "Query · " + n + " condition" + (n === 1 ? "" : "s") + ' <button id="chipX" title="Clear the query" aria-label="Clear the query"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#x></use></svg></button>';
    $("chipX").onclick = () => { query = null; renderChip(); render(); };
  }

  function exportCsv() {
    const rows = scope();
    const out = [];
    const push = (section, label, cards, stacks, value, cost) =>
      out.push([section, label, cards, stacks, G.round2(value), G.round2(cost)]);
    push("Total", "selection", rows.reduce((s, r) => s + r.quantity, 0), rows.length,
      rows.reduce((s, r) => s + G.rowTotal(r), 0), rows.reduce((s, r) => s + (Number(r.costTotal) || 0), 0));
    const sections = [
      ["Location", r => G.locName(r.locationId)],
      ["Set", r => (r.setName || r.set.toUpperCase())],
      ["Rarity", r => (r.rarity || "(unknown)")],
      ["Colour identity", r => { const ci = G.normColors(r.colorIdentity); return ci.join("") === "C" ? "Colorless" : ci.join(""); }],
      ["Language", r => G.LANG_NAMES[r.lang] || r.lang],
      ["Finish", r => G.FINISH_NAMES[r.finish] || "Non-foil"]
    ];
    for (const [name, fn] of sections) {
      for (const g of group(rows, fn).sort((a, b) => b.cards - a.cards)) {
        push(name, g.label, g.cards, g.stacks, g.value, g.cost);
      }
    }
    const head = ["Section", "Label", "Cards", "Stacks", "Market Value", "Cost Basis"];
    const lines = [head.join(",")].concat(out.map(r => r.map(G.csvCell).join(",")));
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-statistics.csv");
    UI.toast("Exported " + out.length + " summary rows.", "ok");
  }

  UI.boot(async function () {
    // The tab is remembered (UI.pageTabs).
    tabs = UI.pageTabs({ tabs: Object.keys(PANES).map(k => ({ id: k, button: TAB_ID[k], panes: PANES[k] })) });

    UI.fillLocationSelect($("scopeLoc"), "", { anyLabel: "All locations" });
    $("scopeLoc").onchange = render;
    $("locMetric").onchange = render;
    $("setMetric").onchange = render;
    $("btnCsv").onclick = exportCsv;

    $("btnClear").onclick = () => { query = null; $("scopeLoc").value = ""; renderChip(); render(); };
    $("btnQuery").onclick = async () => {
      const out = await UI.openQuery(query);
      if (out === undefined) return;
      query = out;
      renderChip();
      render();
    };
    // A change event fires per edit, not per batch - a rapid run of edits
    // (a bulk price refresh, a multi-line receive) would otherwise recompute
    // every tile/breakdown/table from scratch once per edit while this page
    // happens to be open. Same debounce idiom already used for search inputs
    // above, just triggered by G.on("change") instead of an input event.
    const rerenderOnChange = G.debounce(() => {
      UI.fillLocationSelect($("scopeLoc"), $("scopeLoc").value, { anyLabel: "All locations" });
      render();
    }, 150);
    G.on("change", rerenderOnChange);
    render();
  });
})();
