
"use strict";
(function () {
  const $ = UI.$;
  let data = null;
  // The vendor `data` was fetched for (#114). The price-history modal asks
  // for this vendor, not whatever the dropdown says, so a click while a
  // newer reload is still downloading opens the history of the rows drawn.
  let dataVendor = null;
  // Only the newest reload / portfolio / history request may draw (#114):
  // switching vendor and back while the first (possibly cold-sweep) response
  // is still downloading must not land the old vendor's rows last.
  const beginReload = G.latestOnly(), beginPortfolio = G.latestOnly(), beginHistory = G.latestOnly();
  // Row action buttons live inside a row whose own onclick opens the price-
  // history modal - this keeps that click from also firing when the button
  // itself is what got clicked.
  const stop = fn => e => { e.stopPropagation(); fn(); };

  // Which card rows are drilled open in the "Any printing (whole card)"
  // view - a pivot-table-style expand, not a one-off detail popover, so more
  // than one card can be open at once and stays open across a re-render
  // (a filter/sort change, a live "change" event) until the user collapses
  // it or reloads. Keyed the same way groupByCard() groups (oracleId, or
  // "name:X" for the rare row with none) - cleared on reload() since a new
  // vendor/window can turn up a different card entirely.
  let expandedCards = new Set();
  const cardKeyOf = r => r.oracleId || ("name:" + r.name);

  /* Column-click sort for the grouped ("Any printing") view - the generic
     click-to-sort (ui.js) is switched off wholesale on this table (see
     pivot-nosort below) because it resorts every <tr> in the tbody with no
     idea some of them are a card's children, which would scatter printings
     away from their card. This is the replacement: it sorts the CARD rows
     (real data, not scraped cell text) and renderTable() always re-appends
     each card's children immediately after it, so the hierarchy survives a
     sort the same way it survives a re-render. Only columns with a real
     card-level value are listed - Then/Now/MA30/MA60/MA30-60/Δ each and
     Actions have none (see buildCardRow's merged cell), so clicking those
     while grouped is a no-op rather than sorting by nothing. */
  const GROUP_SORT_KEYS = {
    1: r => r.name.toLowerCase(),
    2: r => r.movedCount,
    3: r => r.up - r.down,
    4: r => r.qty,
    11: r => r.pct == null ? -Infinity : r.pct,
    12: r => r.valueDelta == null ? -Infinity : r.valueDelta,
    13: r => r.rankNow == null ? Infinity : r.rankNow,
    14: r => r.rankDelta == null ? Infinity : r.rankDelta,
    15: r => r.sold7d == null ? -Infinity : r.sold7d,
    16: r => r.listed || 0,
    17: r => r.avgCost == null ? -Infinity : r.avgCost
  };
  let groupSort = null; // {col, dir}
  // Mirrors ui.js's own sortTable() header-marking (arrow span + .sorted) so
  // a grouped-mode sort looks identical to the generic one - just driven by
  // groupSort instead of ui.js's SORT_STATE. Columns with no card-level
  // value (see GROUP_SORT_KEYS above) visibly stop looking clickable while
  // grouped rather than silently no-opping when clicked.
  function markGroupSortHeaders(grouping) {
    const heads = [...$("moveTable").tHead.rows[0].cells];
    heads.forEach((th, i) => {
      const old = th.querySelector(".arrow");
      if (old) old.remove();
      th.classList.remove("sorted");
      th.classList.toggle("sort-disabled", grouping && !GROUP_SORT_KEYS[i]);
    });
    if (!grouping || !groupSort) return;
    const th = heads[groupSort.col];
    if (!th) return;
    th.classList.add("sorted");
    const s = document.createElement("span");
    s.className = "arrow";
    s.textContent = groupSort.dir === 1 ? " ▲" : " ▼";
    th.appendChild(s);
  }

  /* Worth a look today got its own tab (2026-09-06 ask) instead of living
     squeezed above the main table - same small hidden-pane pattern
     stats.html already uses elsewhere. Both panes' data comes from the same
     reload() below, so switching tabs never needs a new fetch. */
  let tabs;

  /* ---- Selling fast (#202) ------------------------------------------------
     Cards ranked by copies sold on Manapool in the last 7 days, from the
     server's own accumulated sales history (GET /api/prices/selling-fast).
     Same card row + printing drill-down shape as "What moved", but its own
     table: its columns share nothing with the price table and the rows nest,
     so it sorts itself (sellSort) the way the grouped Movers table does.
     Honesty is the point: Manapool only, history since a date, and any count
     the server marks as a minimum (atLeast) is shown with a leading "≥". */
  let sell = null, sellLoading = false, sellSort = { col: 4, dir: -1 };
  // #233: "Show 500 more" appends the next page by rank to `sell.cards`;
  // sfMoreBusy keeps the button disabled while a page is on its way.
  const SELL_PAGE = 500;
  let sfMoreBusy = false;
  // #231: the name search's answer while the box has text (null otherwise):
  // the server searches every card that sold, not just the top list in `sell`.
  let sfFound = null;
  const beginSfSearch = G.latestOnly();
  const sellOpen = new Set();
  const BASIC_LAND = /^(snow-covered )?(plains|island|swamp|mountain|forest)$|^wastes$/i;
  // One key per column for both card rows and an open card's printing rows
  // (#223), so printings follow the table's sort. A printing has no name or
  // printing count: it sorts by its set + number label, and on the Printings
  // column it ties, keeping copies-in-7-days order. Nor has it a rank (#233):
  // on the Rank column its printings tie the same way.
  const SELL_SORT_KEYS = {
    1: o => o.rank != null ? o.rank : 0,
    2: o => o.name != null ? o.name.toLowerCase() : G.printingLabel(o.set, o.number, "").toLowerCase(),
    3: o => o.printingCount || 0,
    4: o => o.copies7,
    5: o => o.copies30,
    6: o => o.sales7,
    7: o => o.paceRatio == null ? -Infinity : o.paceRatio,
    // Listed supply: how far it fell over 7 days (7 days ago minus now), so
    // the first click puts "supply falling" on top. Unknown sorts last. (#365)
    8: o => o.printings ? sfCardDrop(o) : sfDrop(o),
    // Days of listings left (#368): starts shortest first; null (no estimate)
    // sorts last either way.
    9: o => o.printings ? sfCardDaysLeft(o) : o.daysLeft,
    10: o => o.hot ? 2 : o.hot === false ? 1 : 0
  };
  // Ties (and both-unknown paces) fall back to copies in 7 days, high to low.
  // A null key sinks below every value in both directions.
  function sellCompare(a, b) {
    const key = SELL_SORT_KEYS[sellSort.col] || SELL_SORT_KEYS[4];
    const av = key(a), bv = key(b);
    if (av == null || bv == null) return av == null && bv == null ? b.copies7 - a.copies7 : av == null ? 1 : -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) : av - bv;
    return cmp ? cmp * sellSort.dir : b.copies7 - a.copies7;
  }
  // The API sends no image, so build Scryfall's standard front-face URL from the id.
  const sfArt = id => id ? "https://cards.scryfall.io/normal/front/" + id[0] + "/" + id[1] + "/" + id + ".jpg" : "";

  async function loadSelling() {
    if (sellLoading) return;
    sellLoading = true;
    UI.setStatus("sfStatus", "Loading Manapool sales…", "work");
    try {
      sell = await G.api("/api/prices/selling-fast?limit=" + SELL_PAGE);
      UI.setStatus("sfStatus", "", "ok");
    } catch (e) {
      sell = null;
      UI.setStatus("sfStatus", "Could not load Selling fast: " + e.message, "err");
    } finally { sellLoading = false; }
    renderSelling();
  }

  // #233: the next SELL_PAGE cards by rank, appended to the list. A failure
  // goes to the status line and keeps the rows already shown. A card already
  // listed (the ranking can shift a little when the day's counts update
  // between pages) isn't listed twice.
  async function moreSelling() {
    if (!sell || sfMoreBusy || sellLoading) return;
    const base = sell;
    sfMoreBusy = true;
    renderSellMore();
    UI.setStatus("sfStatus", "Loading more Manapool sales…", "work");
    try {
      const page = await G.api("/api/prices/selling-fast?limit=" + SELL_PAGE + "&offset=" + base.cards.length);
      if (sell === base) {                             // else the tab reloaded meanwhile: drop this page
        const have = new Set(base.cards.map(c => c.name));
        const add = (page.cards || []).filter(c => !have.has(c.name));
        sell = Object.assign({}, base, { cards: base.cards.concat(add), total: page.total, coverage: page.coverage || base.coverage,
          // Nothing new on a non-empty page would ask for it again forever: stop there.
          exhausted: !(page.cards || []).length || !add.length });
        UI.setStatus("sfStatus", "", "ok");
      }
    } catch (e) {
      if (sell === base) UI.setStatus("sfStatus", "Could not load more of Selling fast: " + e.message, "err");
    } finally {
      sfMoreBusy = false;
    }
    renderSelling();
  }

  // #231: typed (debounced) name search; clearing the box goes back to the top list.
  async function searchSelling() {
    const q = $("sfSearch").value.trim();
    const isCurrent = beginSfSearch();
    if (!q) {
      sfFound = null;
      UI.setStatus("sfStatus", "", "ok");
      renderSelling();
      return;
    }
    UI.setStatus("sfStatus", "Searching Manapool sales…", "work");
    let found;
    try {
      found = await G.api("/api/prices/selling-fast?q=" + encodeURIComponent(q));
      if (!isCurrent()) return;
      UI.setStatus("sfStatus", "", "ok");
    } catch (e) {
      if (!isCurrent()) return;
      found = { cards: [], matched: 0, failed: true };
      UI.setStatus("sfStatus", "Could not search Selling fast: " + e.message, "err");
    }
    sfFound = Object.assign(found, { typed: q });
    renderSelling();
  }

  // "≥ 12" when the server says the number is a minimum; the title spells it out.
  function sfNum(n, atLeast, what) {
    return atLeast
      ? '<span title="At least ' + n + " " + what + " - Manapool's history for this window is incomplete or capped, so the real number may be higher\">≥ " + n + "</span>"
      : String(n);
  }
  // The SELLING FAST flag: icon + words, never colour alone. Shared with the
  // main Movers table's Sold 7d column (#209).
  const sfFlag = () => '<span class="badge sale" style="white-space:nowrap" title="Separate sales in the last 7 days came well above their usual pace"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#trending-up></use></svg> SELLING FAST</span>';
  function sfStatusCell(c) {
    if (c.hot) return '<td data-v="2">' + sfFlag() + "</td>";
    if (c.hot === false) return '<td data-v="1" class="muted">Steady</td>';
    return '<td data-v="0" class="muted" title="The flag needs two weeks of history (a full week before these 7 days) before it can compare paces">Too early</td>';
  }

  // "Pace vs usual" for a card or one of its printings (#223); the baseline
  // length is the card's, the same for every printing.
  // #354: paces are separate sales per day (a bulk buy counts once), and
  // "usual" is the days of history before these 7.
  function sfPaceCell(o, baselineDays) {
    const why = !baselineDays ? "No history before these 7 days yet to compare with"
      : o.pace7 + " sales/day in the last 7 days vs " + o.paceBaseline + " sales/day in the " + baselineDays + " day" + (baselineDays === 1 ? "" : "s") + " before";
    return '<td class="num hide-sm" data-v="' + (o.paceRatio == null ? "" : o.paceRatio) + '" title="' + why + '">' +
      (o.paceRatio == null ? "—" : o.paceRatio + "×") + "</td>";
  }

  // "Listed now (was 7 days ago)" for a printing (#365): falling supply is the
  // noteworthy direction, so it gets the arrow and the green; rising gets red.
  // Card rows pass null and leave it blank.
  function sfSupplyCell(p) {
    if (!p) return '<td class="num hide-sm"></td>';
    if (p.available == null || p.available7DaysAgo == null) return '<td class="num hide-sm" data-v="" title="Listed supply is not known for both days">—</td>';
    const d = p.available7DaysAgo - p.available;
    const cls = d > 0 ? "pos" : d < 0 ? "neg" : "muted";
    const arrow = d > 0 ? "▼ " : d < 0 ? "▲ " : "";
    const word = d > 0 ? "Supply is falling: " + d + " fewer listed copies than 7 days ago" : d < 0 ? "Supply is rising: " + (-d) + " more listed copies than 7 days ago" : "Listed supply is unchanged from 7 days ago";
    return '<td class="num hide-sm" data-v="' + d + '" title="' + word + '"><span class="' + cls + '">' + arrow + p.available + '</span> <span class="muted">(' + p.available7DaysAgo + ")</span></td>";
  }
  // Supply drop over 7 days (7 days ago minus now); -Infinity when unknown.
  const sfDrop = p => p.available == null || p.available7DaysAgo == null ? -Infinity : p.available7DaysAgo - p.available;
  // A card sorts by its biggest printing drop, so the card list follows.
  const sfCardDrop = c => (c.printings || []).reduce((m, p) => Math.max(m, sfDrop(p)), -Infinity);

  // "Days left" for a printing (#368): the server's estimate of how long the
  // copies listed now last at the last 7 days' pace. Card rows pass null.
  function sfDaysLeftCell(p) {
    if (!p) return '<td class="num hide-sm"></td>';
    const min = ((sell && sell.coverage) || {}).daysLeftMinSales;
    const why = p.available == null ? "Listed supply isn't known for this printing, so there's no estimate."
      : "Too few separate sales in the last 7 days to estimate" + (min ? " (it needs " + min + ")" : "") + ".";
    const v = G.daysLeftView(p.daysLeft, p.available, p.copies7, p.atLeast7, why);
    return '<td class="num hide-sm" data-v="' + (p.daysLeft == null ? "" : p.daysLeft) + '" title="' + G.esc(v.title) + '">' +
      (p.daysLeft == null ? '<span class="faint">—</span>' : v.text) + "</td>";
  }
  // A card sorts by its printing that runs out soonest; null (sorts last) if none can say.
  const sfCardDaysLeft = c => (c.printings || []).reduce((m, p) => p.daysLeft == null ? m : m == null ? p.daysLeft : Math.min(m, p.daysLeft), null);

  // The Rank column (#233): a card's overall rank by 7-day copies among every
  // card that sold, fixed by the server, so sorting never renumbers it.
  function sfRankCell(c, src) {
    if (c.rank == null) return '<td class="num" data-v=""></td>';
    return '<td class="num" data-v="' + c.rank + '" title="Ranked #' + c.rank + " of " + src.total + ' cards by copies sold on Manapool in the last 7 days">#' + c.rank + "</td>";
  }

  function buildSellCard(c, src) {
    const open = sellOpen.has(c.name);
    const tr = document.createElement("tr");
    tr.className = "click card-row";
    tr.title = open ? "Click to collapse" : "Click to see this card's printings";
    const art = sfArt((c.printings[0] || {}).scryfallId);
    tr.innerHTML =
      UI.artThumbTd(art) +
      sfRankCell(c, src) +
      '<td class="card-name"><span class="disclosure">' + (open ? "▾" : "▸") + "</span>" + UI.cardNameLink(c.name) + "</td>" +
      '<td class="muted hide-sm" data-v="' + c.printingCount + '">' + c.printingCount + (c.printingCount === 1 ? " printing" : " printings") + "</td>" +
      '<td class="num" data-v="' + c.copies7 + '">' + sfNum(c.copies7, c.atLeast7, "copies in 7 days") + "</td>" +
      '<td class="num hide-sm" data-v="' + c.copies30 + '">' + sfNum(c.copies30, c.atLeast30, "copies in 30 days") + "</td>" +
      '<td class="num hide-sm" data-v="' + c.sales7 + '">' + sfNum(c.sales7, c.atLeast7, "sales in 7 days") + "</td>" +
      sfPaceCell(c, c.baselineDays) +
      sfSupplyCell(null) +
      sfDaysLeftCell(null) +
      sfStatusCell(c);
    UI.wireArtHover(tr, art);
    tr.onclick = () => {
      if (open) sellOpen.delete(c.name); else sellOpen.add(c.name);
      renderSelling();
    };
    return tr;
  }

  function buildSellPrinting(p, c) {
    const tr = document.createElement("tr");
    tr.className = "child-row";
    const art = sfArt(p.scryfallId);
    tr.innerHTML =
      UI.artThumbTd(art) +
      '<td class="num"></td>' +
      '<td class="card-name">' + UI.cardLink({ name: c.name, set: p.set, collector: p.number }, G.printingLabel(p.set, p.number, "")) + "</td>" +
      '<td class="muted hide-sm">—</td>' +
      '<td class="num" data-v="' + p.copies7 + '">' + sfNum(p.copies7, p.atLeast7, "copies in 7 days") + "</td>" +
      '<td class="num hide-sm" data-v="' + p.copies30 + '">' + sfNum(p.copies30, p.atLeast30, "copies in 30 days") + "</td>" +
      '<td class="num hide-sm" data-v="' + p.sales7 + '">' + sfNum(p.sales7, p.atLeast7, "sales in 7 days") + "</td>" +
      sfPaceCell(p, c.baselineDays) +
      sfSupplyCell(p) +
      sfDaysLeftCell(p) +
      sfStatusCell(p);
    UI.wireArtHover(tr, art);
    return tr;
  }

  function renderSellNotes(cv) {
    const notes = [];
    notes.push("<b>" + G.esc(cv.sourceNote || "Manapool sales only") + "</b> - other stores' sales are not included.");
    notes.push(cv.historySince
      ? "Sales history since <b>" + G.esc(cv.historySince) + "</b> (" + cv.historyDays + " day" + (cv.historyDays === 1 ? "" : "s") + ")" +
        (cv.dataThrough ? ", up to <b>" + G.esc(cv.dataThrough) + "</b>: Manapool dates each sale by day and publishes once a day, so the 7 days end on its latest day." : ".")
      : "No sales history has been collected yet.");
    if (cv.historySince && (!cv.window7Complete || !cv.window30Complete)) {
      const which = !cv.window7Complete ? "7-day and 30-day windows are" : "30-day window is";
      notes.push("<b>Still building history:</b> the " + which + " not full yet, so counts marked <b>≥</b> are minimums and the real numbers may be higher. " +
        "History starts " + G.esc(cv.historySince) + ": there's little or no sales history before that day.");
    }
    notes.push("A <b>≥</b> also appears where Manapool shows only the latest 20 sales of a version and more may have sold between our checks.");
    if (cv.hotNeedsDays && cv.historyDays < cv.hotNeedsDays) {
      notes.push("The <b>SELLING FAST</b> flag needs " + cv.hotNeedsDays + " days of history to compare paces; it shows \"Too early\" until then.");
    } else if (cv.hotRule) {
      notes.push("<b>SELLING FAST</b> means: " + G.esc(cv.hotRule) + ".");
    }
    if (sfFound) {
      notes.push("The search covers all " + sfFound.total + " cards that sold in the last 7 days and shows up to " + sfFound.searchMax +
        " best-selling matches; sorting reorders just those. Clear the search to see the top " + (sell ? (sell.cards || []).length : sfFound.limit) + " again.");
    } else if (sell) {
      const n = (sell.cards || []).length;
      notes.push("Sorting reorders only the cards loaded so far: the top " + n + " by 7-day sales" + (sell.total > n ? " (of " + sell.total + " that sold)" : "") +
        (sfCanMore() ? ". Show more loads the next " + SELL_PAGE + ", and a" : ". A") + " search by card name finds any card that sold.");
    }
    if (cv.topup && cv.topup.enabled === false) {
      notes.push("Counts refresh once a day." + (G.isAdmin && cv.topup.reason ? " Extra checks on very fast sellers are off: " + G.esc(cv.topup.reason) : ""));
    }
    $("sfNotes").innerHTML = notes.map(n => "<div>" + n + "</div>").join("");
  }

  // #233: more of the ranking left to load (and the last page added something).
  const sfCanMore = () => !!sell && !sell.exhausted && sell.total > (sell.cards || []).length;
  // "Showing N of TOTAL sold" and the Show more button under the list; not
  // while a search's answer stands in for it.
  function renderSellMore() {
    const n = sell && !sfFound ? (sell.cards || []).length : 0;
    $("sfMore").hidden = !n;
    if (!n) return;
    $("sfMoreCount").textContent = "Showing " + n + " of " + sell.total + " sold";
    $("sfMoreBtn").hidden = !sfCanMore();
    $("sfMoreBtn").disabled = sfMoreBusy;
    $("sfMoreLabel").textContent = sfMoreBusy ? "Loading…" : "Show " + Math.min(SELL_PAGE, sell.total - n) + " more";
  }

  function renderSelling() {
    hidePreview();
    renderSellMore();
    const body = $("sellBody");
    // While searching (#231) the search's answer stands in for the top list.
    const src = sfFound || sell;
    if (!src || src.failed) {
      $("sfHdr").textContent = "";
      $("sfNotes").innerHTML = "";
      body.innerHTML = sfFound
        ? UI.emptyRow(11, { icon: "error", title: "The search could not be run.", hint: "Try again in a moment." })
        : UI.emptyRow(11, { icon: "error", title: "Selling fast could not be loaded.", hint: "Try the tab again in a moment." });
      return;
    }
    const cv = src.coverage || {};
    renderSellNotes(cv);
    let cards = src.cards || [];
    if ($("sfHideLands").checked) cards = cards.filter(c => !BASIC_LAND.test(c.name));
    cards = cards.slice().sort(sellCompare);
    const plural = n => n + " card" + (n === 1 ? "" : "s");
    if (sfFound) {
      const got = (src.cards || []).length;
      $("sfHdr").textContent = !cards.length ? ""
        : "- " + cards.length + " shown: " + (src.matched > got ? "the " + got + " best sellers of " + plural(src.matched) : plural(src.matched)) +
          ' matching "' + sfFound.typed + '", out of ' + src.total + " sold on Manapool in the last 7 days";
    } else {
      $("sfHdr").textContent = cards.length ? "- " + plural(cards.length) + " shown, top " + (sell.cards || []).length + " of " + (sell.total != null ? sell.total : (sell.cards || []).length) + " sold on Manapool in the last 7 days" : "";
    }
    [...$("sellTable").tHead.rows[0].cells].forEach((th, i) => {
      const old = th.querySelector(".arrow");
      if (old) old.remove();
      th.classList.toggle("sorted", i === sellSort.col);
      if (i === sellSort.col) {
        const s = document.createElement("span");
        s.className = "arrow";
        s.textContent = sellSort.dir === 1 ? " ▲" : " ▼";
        th.appendChild(s);
      }
    });
    if (!cards.length && sfFound) {
      const typed = G.esc(sfFound.typed);
      body.innerHTML = (src.cards || []).length          // every match is a basic land
        ? UI.emptyRow(11, { icon: "search", title: "Every card matching \"" + typed + "\" is a basic land, and basic lands are hidden.",
            hint: "Untick Hide basic lands to see them." })
        : UI.emptyRow(11, { icon: "search", title: "No card matching \"" + typed + "\" sold on Manapool in the last 7 days." });
      return;
    }
    if (!cards.length) {
      body.innerHTML = !cv.historySince
        ? UI.emptyRow(11, { icon: "history", title: "No Manapool sales history yet.",
            hint: "Grimoire collects it from Manapool's daily catalog. The first pull runs shortly after the server starts, then once a day. Check back soon." })
        : UI.emptyRow(11, { icon: "search", title: "No cards sold on Manapool in the last 7 days" + ($("sfHideLands").checked ? " (basic lands hidden)" : "") + "." });
      return;
    }
    body.innerHTML = "";
    for (const c of cards) {
      body.appendChild(buildSellCard(c, src));
      if (sellOpen.has(c.name)) {
        for (const p of c.printings.slice().sort(sellCompare)) body.appendChild(buildSellPrinting(p, c));
        if (c.printingCount > c.printings.length) {
          const more = document.createElement("tr");
          more.className = "child-row";
          more.innerHTML = '<td></td><td></td><td class="muted" colspan="9">+' + (c.printingCount - c.printings.length) + " more printings with fewer sales</td>";
          body.appendChild(more);
        }
      }
    }
  }

  /* Hover-to-preview used to be a page-local copy of this; promoted to UI so
     every table gets the same behavior (2026-09-05 card-row consistency pass). */
  const hidePreview = UI.hideHoverPreview;

  // Cardmarket prices are EUR, not USD - G.money() always renders a literal
  // "$", which would silently mislabel those numbers as dollars. Every price
  // rendered below goes through this instead, switching to a "€" prefix only
  // when the currently-loaded data is Cardmarket's.
  function euro(n) {
    if (n == null || n === "" || isNaN(n)) return "—";
    const num = Number(n);
    return (num < 0 ? "-" : "") + "€" + Math.abs(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmt(n) { return (data && data.vendor === "cm") ? euro(n) : G.money(n); }

  function tile(big, lbl, cls, extra, accent) {
    return '<div class="tile ' + (accent || "") + '"><span class="big ' + (cls || "") + '">' + big + "</span>" +
      '<span class="lbl">' + lbl + "</span>" +
      (extra ? '<div class="faint" style="font-size:11.5px;margin-top:5px;line-height:1.5">' + extra + "</div>" : "") +
      "</div>";
  }

  function visibleRows() {
    if (!data || !data.rows) return [];
    const dir = $("dir").value;
    const rankDir = $("rankDir").value;
    const signal = $("signal").value;
    const min = parseFloat($("minPrice").value);
    const flatPct = parseFloat($("flatPct").value);
    const flatSpots = parseFloat($("flatSpots").value);
    const held = $("onlyHeld").checked;
    const q = $("search").value.trim().toLowerCase();
    let rows = data.rows.filter(r => {
      if (held && !(r.qty > 0)) return false;
      if (!isNaN(min) && min > 0) {
        const p = Math.max(r.now == null ? 0 : r.now, r.then == null ? 0 : r.then);
        if (p < min) return false;
      }
      // A row must have moved by SOME metric to be worth showing - price or
      // EDHRec rank - not just price the way this used to be. A card whose
      // rank moved but price hasn't caught up yet is exactly what the
      // "rank improving, price flat" signal below exists to surface, so it
      // can't be filtered out before that check ever runs.
      const priceMoved = r.delta != null && Math.abs(r.delta) >= 0.005;
      const rankMoved = r.rankDelta != null && r.rankDelta !== 0;
      if (!priceMoved && !rankMoved) return false;
      if (dir === "up" && !(r.delta > 0)) return false;
      if (dir === "down" && !(r.delta < 0)) return false;
      // rankDelta is negative when the rank NUMBER goes down, i.e. the card
      // got MORE popular - opposite polarity from price's delta.
      if (rankDir === "up" && !(r.rankDelta < 0)) return false;
      if (rankDir === "down" && !(r.rankDelta > 0)) return false;
      // #367: a rise with real buying behind it. Uses the row's own SELLING FAST
      // flag (the Sold 7d column shows the same badge); golden-cross status
      // isn't in the movers rows, so this is "price up" only.
      if (signal === "backedRise" && !(r.delta > 0 && r.sellingFast === true)) return false;
      if (signal !== "any" && signal !== "backedRise") {
        const priceFlat = r.pct == null ? (r.delta == null) : Math.abs(r.pct) < flatPct;
        const rankFlat = r.rankDelta == null ? true : Math.abs(r.rankDelta) < flatSpots;
        const rankImproving = r.rankDelta != null && r.rankDelta < 0 && !rankFlat;
        if (signal === "rankLeads" && !(rankImproving && priceFlat)) return false;
        // "price improved" read as a real increase, not any move either way.
        if (signal === "priceLeads" && !(rankFlat && r.delta > 0 && !priceFlat)) return false;
      }
      if (q) {
        const hay = (r.name + " " + r.set + " " + r.setName + " " + r.collector).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const key = $("rank").value;
    rows.sort((a, b) => Math.abs(Number(b[key]) || 0) - Math.abs(Number(a[key]) || 0));
    return rows;
  }

  /* The tiles summarise EVERY held printing (#111). The server sends that
     summary as data.held, worked out before the table's meaningful-move bar,
     so unticking Only held (which drops small owned moves from the table)
     doesn't change these numbers, and they agree with the Portfolio chart.
     It counts printing + finish, so one printing held as NM and LP is one
     printing up, not two (#112). The fallback below only runs against an
     older server that doesn't send it. */
  function heldSummary() {
    if (data.held) return data.held;
    const held = data.rows.filter(r => r.qty > 0 && r.delta != null);
    const up = held.filter(r => r.delta > 0);
    const down = held.filter(r => r.delta < 0);
    return {
      nowValue: data.rows.reduce((s, r) => s + (r.now == null ? 0 : r.now * r.qty), 0),
      netValue: held.reduce((s, r) => s + (r.valueDelta || 0), 0),
      up: up.length, upValue: up.reduce((s, r) => s + (r.valueDelta || 0), 0),
      down: down.length, downValue: down.reduce((s, r) => s + (r.valueDelta || 0), 0),
      best: up.slice().sort((a, b) => (b.valueDelta || 0) - (a.valueDelta || 0))[0] || null,
      worst: down.slice().sort((a, b) => (a.valueDelta || 0) - (b.valueDelta || 0))[0] || null
    };
  }

  function renderTiles() {
    if (!data || !data.rows) { $("tiles").innerHTML = ""; return; }
    const h = heldSummary();
    const netValue = h.netValue, nowValue = h.nowValue, best = h.best, worst = h.worst;
    const window0 = data.fromDate ? data.fromDate + " → " + data.toDate : "no earlier snapshot to compare against";
    $("tiles").innerHTML =
      tile(fmt(nowValue), "Priced holdings now", "val", data.toDate ? "as of " + data.toDate : "", "gold") +
      tile((netValue >= 0 ? "+" : "") + fmt(netValue), "Net change over the window",
        netValue >= 0 ? "val" : "neg", window0, netValue >= 0 ? "pos" : "neg") +
      tile(h.up.toLocaleString(), "Printings up", "val", fmt(h.upValue) + " gained", "pos") +
      tile(h.down.toLocaleString(), "Printings down", "neg", fmt(Math.abs(h.downValue)) + " lost", "neg") +
      (best ? tile(UI.cardLink(best), "Biggest gainer", "val text",
        fmt(best.then) + " → " + fmt(best.now) + " × " + best.qty +
        " = " + fmt(best.valueDelta), "pos") : "") +
      (worst ? tile(UI.cardLink(worst), "Biggest faller", "neg text",
        fmt(worst.then) + " → " + fmt(worst.now) + " × " + worst.qty +
        " = " + fmt(worst.valueDelta), "neg") : "");
  }

  /* A short, curated pick from the FULL (unfiltered) row set - independent
     of whatever the toolbar's Direction/Signal/Min price/Only held controls
     currently say, since the whole point is not needing to touch those to
     find something worth a look. Fixed thresholds (not the Signal section's
     own live flatPct/flatSpots inputs) so this panel doesn't shift around
     as someone tunes those for a manual search elsewhere on the same page. */
  // The thresholds and the floor / early-signal / trending-up rules live in
  // public/js/moversPicks.js (pure, unit-tested - test/moversPicks.test.js).
  const Picks = window.MoversPicks;
  const { HL_FLAT_SPOTS, HL_MIN_PRICE, HL_MAX_PCT } = Picks;
  const hlEarlySignal = Picks.earlySignal, hlMeetsFloor = Picks.meetsFloor, hlTrendingUp = Picks.trendingUpUnowned;
  // Belt and suspenders: even with both ends past the floor, a swing this
  // extreme is far more likely leftover bad/sparse data than a real move
  // worth flagging as "worth a look" - the curated panel should be
  // trustworthy at a glance, unlike the full table below it.
  function hlSanePct(r) { return r.pct != null && Math.abs(r.pct) <= HL_MAX_PCT; }
  function hlPctFnum(r) { return G.pct(r.pct); } // G.pct signs it already (was showing "++28.7%")
  // BACKLOG.md #74: trend + cost basis together, not just a raw window
  // delta. ma30/ma60 (and so maDiff, their difference) is real for held
  // rows AND for unowned catalog-sweep rows (the sweep has computed MAs for
  // its survivors since 2026-09-20 - that's what "Trending up (not owned)"
  // uses). What makes Recovering/Losing steam owned-only is the cost basis:
  // hlCostPct needs a real cost basis on file (costQty>0) to mean anything;
  // not sanity-capped like hlSanePct's window swings - a real cost basis
  // can legitimately be very far from today's price (bought for cents,
  // worth dollars now), that's not a data bug.
  function hlCostPct(r) {
    if (!(r.costQty > 0) || r.avgCost == null || !(r.avgCost > 0) || r.now == null) return null;
    return (r.now - r.avgCost) / r.avgCost * 100;
  }
  function hlRecovering(r) {
    const cp = hlCostPct(r);
    return r.qty > 0 && cp != null && cp < 0 && Picks.hasMaTrend(r) && r.maDiff > 0;
  }
  function hlFading(r) {
    const cp = hlCostPct(r);
    return r.qty > 0 && cp != null && cp > 0 && Picks.hasMaTrend(r) && r.maDiff < 0;
  }
  function hlCostFnum(r) { return G.pct(hlCostPct(r)) + " vs. cost"; }
  // "(rank)" said explicitly, not left implied - a bare "▲ 1,653 spots" next
  // to a printing label reads as if that printing moved; EDHRec rank is
  // always card-level, never per-printing (2026-09-06 framing fix, #67).
  function hlRankFnum(r) { return (r.rankDelta < 0 ? "▲ " : "▼ ") + Math.abs(r.rankDelta).toLocaleString() + " spots (rank)"; }
  // Trend pick's number: how far (in percent, #266) the 30-day median sits
  // above the 60-day one. The ▲ carries the direction so it isn't colour alone.
  function hlMaFnum(r) { return "▲ 30-day " + maPctText(r.maPct) + " vs 60-day"; }
  // Signed percent for the 30-vs-60-day trend, "—" when there's none.
  function maPctText(p) { return G.pct(p); } // G.pct signs it and dashes a null
  // The MA30−60 % cell: percent shown, dollar gap in the tooltip, sorts by
  // the percent (data-v) whatever the display text.
  function maPctTd(r) {
    return '<td class="num hide-sm ' + (r.maPct > 0 ? "pos" : r.maPct < 0 ? "neg" : "") + '"' +
      (r.maPct == null ? "" : ' data-v="' + r.maPct + '"') +
      (r.maDiff == null ? "" : ' title="' + G.esc((r.maDiff > 0 ? "+" : "") + fmt(r.maDiff) + " (30-day minus 60-day)") + '"') + ">" +
      maPctText(r.maPct) + "</td>";
  }
  /* `fnumHtml` (the flex-right number - .fnum, unchanged position/styling)
     always describes the CARD (its EDHRec rank move, or its price move -
     both are properties of the card, never of one printing on its own), so
     the text beside it leads with the card name. The printing/finish/qty is
     real but secondary - "here's a copy you can act on," not "this is what
     moved" - so it's now a second, explicitly-labeled "shown via" line
     instead of running directly into the number on one line, which used to
     read as if the printing itself had moved. */
  function highlightEl(r, tag, fnumHtml, cls) {
    const el = document.createElement("div");
    el.className = "feed-row click " + (cls || "");
    el.title = "Click for this printing's whole price history";
    el.innerHTML =
      '<span class="ftext"><span class="muted">' + tag + '</span> <b>' + UI.cardLink(r) + "</b><br>" +
      '<span class="muted" style="font-size:.9em">shown via ' + G.esc(G.printingLabel(r.set, r.collector, r.setName)) +
        (r.finish === "etched" ? ' <span class="badge etched">E</span>' : r.finish === "foil" ? ' <span class="badge foil">F</span>' : "") +
        (r.qty ? " · qty " + r.qty : "") + "</span></span>" +
      '<span class="fnum">' + fnumHtml + "</span>";
    UI.wireHoverPreview(el, r.imageUrl);
    el.onclick = () => { hidePreview(); showHistory(r); };
    return el;
  }
  function renderHighlights() {
    const wrap = $("highlightsWrap");
    if (!data || !data.rows || !data.rows.length) {
      wrap.innerHTML = UI.emptyBlock({ icon: "history", title: "Nothing to show yet." });
      $("highlightsHdr").textContent = "";
      return;
    }
    const pool = data.rows.filter(hlMeetsFloor);
    // #356: each CARD fills at most one line (every printing and finish of
    // it, since rank is per card): each pick, in display order, skips cards
    // an earlier line already shows and falls to its next-best card.
    const shown = [];
    const take = (sorted, n) => { const got = Picks.takeNewCards(sorted, n, shown); shown.push(...got); return got; };
    const takeOne = (r) => { if (r) shown.push(r); return r; };
    const signal = take(pool.filter(hlEarlySignal).sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta)), 3);
    const trending = takeOne(Picks.pickTrendingUp(pool, shown));
    // #352: the strongest golden cross in the Golden cross list's window,
    // once that list (its own fetch) has arrived for the same vendor.
    const cross = takeOne(gx && !gx.error && gx.vendor === dataVendor ? Picks.pickGoldenCross(gx.best, shown) : null);
    const recovering = take(pool.filter(hlRecovering).sort((a, b) => b.maPct - a.maPct), 1)[0];
    const fading = take(pool.filter(hlFading).sort((a, b) => a.maPct - b.maPct), 1)[0];
    const pctPool = pool.filter(hlSanePct);
    const heldUp = take(pctPool.filter(r => r.qty > 0 && r.pct > 0).sort((a, b) => b.pct - a.pct), 1)[0];
    const heldDown = take(pctPool.filter(r => r.qty > 0 && r.pct < 0).sort((a, b) => a.pct - b.pct), 1)[0];
    const newUp = take(pctPool.filter(r => !(r.qty > 0) && r.pct > 0).sort((a, b) => b.pct - a.pct), 1)[0];
    const newDown = take(pctPool.filter(r => !(r.qty > 0) && r.pct < 0).sort((a, b) => a.pct - b.pct), 1)[0];

    const els = [];
    for (const r of signal) els.push(highlightEl(r, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#trending-up></use></svg> Early signal", hlRankFnum(r), ""));
    if (trending) els.push(highlightEl(trending, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#compass></use></svg> Trending up (not owned)", hlMaFnum(trending), "up"));
    if (cross) els.push(highlightEl(cross, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#merge></use></svg> Golden cross", hlCrossFnum(cross), "up"));
    if (recovering) els.push(highlightEl(recovering, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#arrow-up-right></use></svg> Recovering (held, below cost)", hlCostFnum(recovering), "up"));
    if (fading) els.push(highlightEl(fading, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#arrow-down-right></use></svg> Losing steam (held, above cost)", hlCostFnum(fading), "down"));
    if (heldUp) els.push(highlightEl(heldUp, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#chart-column></use></svg> Biggest % gain (held)", hlPctFnum(heldUp), "up"));
    if (heldDown) els.push(highlightEl(heldDown, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#chart-column></use></svg> Biggest % drop (held)", hlPctFnum(heldDown), "down"));
    if (newUp) els.push(highlightEl(newUp, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#scan-search></use></svg> Biggest % gain (not held)", hlPctFnum(newUp), "up"));
    if (newDown) els.push(highlightEl(newDown, "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#scan-search></use></svg> Biggest % drop (not held)", hlPctFnum(newDown), "down"));

    $("highlightsHdr").textContent = els.length ? "— " + els.length + " pick" + (els.length === 1 ? "" : "s") + " today" : "";
    wrap.innerHTML = "";
    if (!els.length) {
      wrap.innerHTML = UI.emptyBlock({ icon: "search", title: "Nothing stands out today at " + fmt(HL_MIN_PRICE) + "+ - try a longer window." });
      return;
    }
    for (const el of els) wrap.appendChild(el);
  }

  /* "Explore" - direct follow-up ask (2026-09-06): the curated picks above
     are a fixed handful of lines: good for a glance, not for actually digging into
     the data. This is a second, independent lens on the SAME pool (still
     decoupled from the Movers tab's own toolbar, same reasoning as the
     curated feed above) but with real controls - a category, a row count up
     to 100, its own min-price and held-only - and a real sortable table
     instead of a fixed pick list. */
  const EXPLORE_LENS = {
    signal: { filter: hlEarlySignal, sortKey: "rankDelta", sortAbs: true },
    caution: { filter: r => hlSanePct(r) && r.pct > 0 && (r.rankDelta == null || Math.abs(r.rankDelta) < HL_FLAT_SPOTS), sortKey: "pct", sortAbs: false },
    pctUp: { filter: r => hlSanePct(r) && r.pct > 0, sortKey: "pct", sortAbs: false },
    pctDown: { filter: r => hlSanePct(r) && r.pct < 0, sortKey: "pct", sortAbs: false, asc: true },
    rankUp: { filter: r => r.rankDelta != null && r.rankDelta < 0, sortKey: "rankDelta", sortAbs: true },
    rankDown: { filter: r => r.rankDelta != null && r.rankDelta > 0, sortKey: "rankDelta", sortAbs: true },
    valueUp: { filter: r => r.qty > 0 && r.valueDelta != null && r.valueDelta > 0, sortKey: "valueDelta", sortAbs: false },
    valueDown: { filter: r => r.qty > 0 && r.valueDelta != null && r.valueDelta < 0, sortKey: "valueDelta", sortAbs: false, asc: true },
    recovering: { filter: hlRecovering, sortKey: "maPct", sortAbs: false },
    fading: { filter: hlFading, sortKey: "maPct", sortAbs: false, asc: true },
    trendingUp: { filter: hlTrendingUp, sortKey: "maPct", sortAbs: false }
  };
  function renderExplore() {
    const body = $("exploreBody");
    if (!data || !data.rows || !data.rows.length) {
      body.innerHTML = UI.emptyRow(12, { icon: "history", title: "Nothing to show yet." });
      $("exploreHdr").textContent = "";
      return;
    }
    const lens = EXPLORE_LENS[$("exCategory").value] || EXPLORE_LENS.signal;
    const minPrice = parseFloat($("exMinPrice").value) || 0;
    const heldOnly = $("exHeldOnly").checked;
    const count = Number($("exCount").value) || 25;
    let pool = data.rows.filter(hlMeetsFloor).filter(lens.filter);
    if (heldOnly) pool = pool.filter(r => r.qty > 0);
    if (minPrice > 0) pool = pool.filter(r => (r.now == null ? 0 : r.now) >= minPrice);
    pool = pool.slice().sort((a, b) => {
      const av = Number(a[lens.sortKey]) || 0, bv = Number(b[lens.sortKey]) || 0;
      const cmp = lens.sortAbs ? Math.abs(bv) - Math.abs(av) : bv - av;
      return lens.asc ? -cmp : cmp;
    }).slice(0, count);
    $("exploreHdr").textContent = "— " + pool.length.toLocaleString() + " printing" + (pool.length === 1 ? "" : "s");
    if (!pool.length) {
      body.innerHTML = UI.emptyRow(12, { icon: "search", title: "Nothing matches this lens at these filters." });
      return;
    }
    body.innerHTML = pool.map(r =>
      UI.artThumbTd(r.imageUrl) +
      '<td class="card-name"><b>' + UI.cardLink(r) + "</b></td>" +
      '<td class="muted">' + G.esc(G.printingLabel(r.set, r.collector, r.setName)) +
        (r.finish === "etched" ? ' <span class="badge etched">E</span>' : r.finish === "foil" ? ' <span class="badge foil">F</span>' : "") + "</td>" +
      '<td class="num">' + r.qty + "</td>" +
      maPctTd(r) +
      '<td class="num">' + fmt(r.now) + "</td>" +
      '<td class="num ' + (r.delta > 0 ? "pos" : r.delta < 0 ? "neg" : "") + '">' +
        (r.delta == null ? "—" : (r.delta > 0 ? "+" : "") + fmt(r.delta)) + "</td>" +
      '<td class="num ' + (r.pct > 0 ? "pos" : r.pct < 0 ? "neg" : "") + '">' + G.pct(r.pct) + "</td>" +
      '<td class="num ' + (r.valueDelta > 0 ? "pos" : r.valueDelta < 0 ? "neg" : "") + '">' +
        (r.valueDelta == null ? "—" : (r.valueDelta > 0 ? "+" : "") + fmt(r.valueDelta)) + "</td>" +
      // Cost basis is what the user actually paid, always USD regardless of
      // the selected vendor's currency - never routed through fmt()/euro(),
      // same rule as the main Movers table's own "Cost ea." column.
      '<td class="num hide-sm">' + (r.costQty ? G.money(r.avgCost) : '<span class="muted">—</span>') + "</td>" +
      '<td class="num">' + (r.rankNow == null ? "—" : r.rankNow.toLocaleString()) + "</td>" +
      '<td class="num ' + (r.rankDelta > 0 ? "neg" : r.rankDelta < 0 ? "pos" : "") +
        '" data-v="' + (r.rankDelta == null ? "" : r.rankDelta) + '">' +
        (r.rankDelta == null ? "—" : (r.rankDelta < 0 ? "▲ " : r.rankDelta > 0 ? "▼ " : "") +
          Math.abs(r.rankDelta).toLocaleString()) + "</td>"
    ).map(rowHtml => '<tr class="click">' + rowHtml + "</tr>").join("");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const r = pool[i];
      UI.wireArtHover(tr, r.imageUrl);
      tr.onclick = () => showHistory(r);
    });
    UI.reapplySorts();
  }

  /* ---- Golden cross (#352) ------------------------------------------------
     Catalog printings whose 30-day line crossed above the 60-day line in the
     last N snapshot days and is still above (GET /api/prices/golden-cross).
     The server works out the catalog-wide list once per snapshot day; this
     only asks for the vendor / N / minimum gap / Show only mine slice of it,
     so changing them is a small fetch, not a page reload. `gx.best` (the
     strongest steady climbers, whatever Show only mine says) feeds the
     curated pick above. */
  let gx = null;
  const beginCross = G.latestOnly();
  const GX_COLS = 8;
  function gxDays() {
    const n = Math.floor(Number($("gxDays").value));
    return n >= 1 ? Math.min(30, n) : 7;
  }
  // "At least N% above": 0-100, blank or junk back to the default 5.
  function gxGap() {
    const raw = $("gxGap").value.trim(), n = Number(raw);
    return raw === "" || !Number.isFinite(n) ? 5 : Math.min(100, Math.max(0, n));
  }
  // Calendar days between the cross and the latest snapshot.
  function gxAge(r) {
    return gx && gx.toDate ? Math.round((Date.parse(gx.toDate) - Date.parse(r.crossDate)) / 86400000) : null;
  }
  function gxAgeText(n) { return n == null ? "—" : n === 0 ? "today" : n === 1 ? "1 day ago" : n + " days ago"; }
  // The pick's number: how far above the 60-day line it is now, and when it
  // crossed. Kept about as short as the Trending up one so it fits a phone.
  function hlCrossFnum(r) { return "▲ 30-day " + maPctText(r.maPct) + " · " + gxAgeText(gxAge(r)); }

  async function loadCross() {
    const isCurrent = beginCross();
    const vendor = $("vendor").value, days = gxDays(), gap = gxGap();
    // Show a clamped value (45 -> 30), but leave a box the user just cleared
    // alone so typing a new number isn't interrupted.
    if ($("gxDays").value.trim() !== "" && String(days) !== $("gxDays").value) $("gxDays").value = String(days);
    if ($("gxGap").value.trim() !== "" && String(gap) !== $("gxGap").value) $("gxGap").value = String(gap);
    if (!gx) $("gxBody").innerHTML = UI.skeletonRows(GX_COLS, 3);
    let got;
    try {
      got = await G.api("/api/prices/golden-cross?days=" + days + "&minGap=" + gap + "&vendor=" + encodeURIComponent(vendor) +
        "&mine=" + ($("gxMine").checked ? "1" : "0"));
    } catch (e) {
      if (!isCurrent()) return;
      gx = null;
      $("gxHdr").textContent = "";
      $("gxBody").innerHTML = UI.emptyRow(GX_COLS, { icon: "error", title: "Could not load golden crosses: " + G.esc(e.message) });
      if (data) renderHighlights();
      return;
    }
    if (!isCurrent()) return;
    gx = got;
    renderCross();
    // The Movers fetch may still be on its way; it draws the picks itself.
    if (data) renderHighlights();
  }

  function renderCross() {
    const body = $("gxBody");
    if (!gx || gx.error || !Array.isArray(gx.rows)) {
      $("gxHdr").textContent = "";
      body.innerHTML = UI.emptyRow(GX_COLS, { icon: "history", title: gx && gx.error ? G.esc(gx.error) : "Nothing to show yet." });
      return;
    }
    const n = gx.total, owned = gx.ownedTotal;
    const span = gx.windowDays < gx.days ? " (the archive has " + gx.windowDays + " day" + (gx.windowDays === 1 ? "" : "s") + " so far)" : "";
    $("gxHdr").textContent = "— " + (gx.mine
      ? owned.toLocaleString() + " of yours, " + n.toLocaleString() + " in all"
      : n.toLocaleString() + " printing" + (n === 1 ? "" : "s") + (owned ? ", " + owned.toLocaleString() + " yours" : "")) +
      (gx.shown < (gx.mine ? owned : n) ? ", strongest " + gx.shown.toLocaleString() + " shown" : "") + span;
    if (!gx.rows.length) {
      body.innerHTML = UI.emptyRow(GX_COLS, { icon: "search",
        title: gx.mine && n ? "None of the cards you own crossed in the last " + gxDaysText(gx.days) + gxGapText() + "."
          : "No card crossed in the last " + gxDaysText(gx.days) + gxGapText() + " at " + fmt(HL_MIN_PRICE) + "+.",
        hint: gx.days < 30 ? "Try more days" + (gx.minGap > 0 ? " or a lower %." : ".") : gx.minGap > 0 ? "Try a lower %." : "" });
      return;
    }
    body.innerHTML = gx.rows.map(r => {
      const age = gxAge(r);
      return '<tr class="click">' +
        UI.artThumbTd(r.imageUrl) +
        // The printing rides under the name rather than in its own column,
        // so the numbers still fit beside it on a phone.
        '<td class="card-name" data-vs="' + G.esc(r.name) + '"><b>' + UI.cardLink(r) + "</b><br>" +
          '<span class="muted" style="font-size:.9em">' + G.esc(G.printingLabel(r.set, r.collector, r.setName)) +
          (r.finish === "etched" ? ' <span class="badge etched">E</span>' : r.finish === "foil" ? ' <span class="badge foil">F</span>' : "") + "</span></td>" +
        '<td class="num" data-v="' + (age == null ? "" : age) + '" title="' + G.esc(r.crossDate) + '">' + gxAgeText(age) + "</td>" +
        '<td class="num">' + fmt(r.now) + "</td>" +
        '<td class="num hide-sm">' + fmt(r.ma30) + "</td>" +
        '<td class="num hide-sm">' + fmt(r.ma60) + "</td>" +
        maPctTd(r).replace(" hide-sm", "") +
        '<td class="num" data-v="' + (r.qty || 0) + '">' + (r.qty > 0 ? r.qty : '<span class="muted">—</span>') + "</td>" +
        "</tr>";
    }).join("");
    body.querySelectorAll("tr").forEach((tr, i) => {
      const r = gx.rows[i];
      UI.wireArtHover(tr, r.imageUrl);
      tr.onclick = () => showHistory(r);
    });
    UI.reapplySorts();
  }
  function gxDaysText(n) { return n === 1 ? "day" : n + " days"; }
  function gxGapText() { return gx && gx.minGap > 0 ? " by " + gx.minGap + "% or more" : ""; }

  /* Collapses the (already filtered) per-printing rows down to one row per
     oracle card, so "is it one printing driving the price up, or is the
     card just increasing in demand overall" has a direct answer. Pure
     client-side reduction over rows already in hand - no new fetch, no new
     server work, so this can't be the thing that makes Movers slow or
     crash the way earlier attempts at broader sweeps did (see BACKLOG.md/
     the memory on this page's crash history). A card's "moved" printings
     are exactly the ones already present in `rows` (unowned candidates only
     ever appear here once they clear the server's meaningful-move bar,
     owned ones always appear) - `totalPrintings` (server-stamped, from a
     one-time catalog index) is the only extra fact needed to say "N of M",
     not a full per-printing fetch for cards that didn't individually move. */
  /* ---- Sold 7d in the main table (#209) -----------------------------------
     The server attaches each row's Manapool sales (sold7d, sold7dAtLeast,
     soldBase = copies over the baseline window, sellingFast, mpId) and
     data.sales says how much history there is. Manapool counts per
     printing, so every finish/condition/language row of one printing shows
     the same number, and a card row sums each printing (mpId) once and
     re-applies the server's SELLING FAST rule (data.sales) to the sums. */
  let soldTitle = null; // the Sold 7d header's static tooltip (movers.html), extended per render
  function soldWhyNot(card) {
    const s = data && data.sales;
    if (!s) return "Manapool sales aren't available right now.";
    if (s.error) return s.error;
    if (!s.historySince) return "No Manapool sales history has been collected yet.";
    return card ? "None of this card's printings here could be matched to Manapool." : "This printing couldn't be matched to Manapool.";
  }
  function soldCell(r, card) {
    if (r.sold7d == null) return '<td class="num hide-sm muted" data-v="" title="' + G.esc(soldWhyNot(card)) + '">—</td>';
    return '<td class="num hide-sm" data-v="' + r.sold7d + '"' +
      (card ? ' title="Copies sold on Manapool in the last 7 days, adding up each printing listed here once"' : "") + ">" +
      sfNum(r.sold7d, r.sold7dAtLeast, "copies in 7 days") + (r.sellingFast ? " " + sfFlag() : "") + "</td>";
  }
  // #354: the pace compares separate sales (soldSales7 vs soldBase, sales
  // over the baselineDays before the 7), so one bulk buy can't flag a card.
  function rollUpSold(rows) {
    const seen = new Set();
    let any = false, sold7d = 0, sales7 = 0, soldBase = 0, atLeast = false;
    for (const r of rows) {
      if (r.sold7d == null) continue;
      any = true;
      if (r.sold7dAtLeast) atLeast = true;
      // A row with no sales on record (no mpId) sold 0 and adds nothing.
      if (!r.mpId || seen.has(r.mpId)) continue;
      seen.add(r.mpId);
      sold7d += r.sold7d;
      sales7 += r.soldSales7 || 0;
      soldBase += r.soldBase || 0;
    }
    if (!any) return { sold7d: null, soldSales7: null, soldBase: null, sold7dAtLeast: false, sellingFast: null };
    const s = data && data.sales;
    const sellingFast = s && s.comparable
      ? sold7d >= s.hotMinCopies && sales7 >= (s.hotMinSales || 0) && sales7 / 7 >= s.hotRatio * (soldBase / s.baselineDays) : null;
    return { sold7d, soldSales7: sales7, soldBase, sold7dAtLeast: atLeast, sellingFast };
  }

  function groupByCard(rows) {
    const groups = new Map();
    for (const r of rows) {
      const key = r.oracleId || ("name:" + r.name);
      let g = groups.get(key);
      if (!g) {
        g = {
          oracleId: r.oracleId, name: r.name,
          totalPrintings: r.totalPrintings || 1,
          rankNow: null, rankDelta: null,
          qty: 0, listed: 0, valueDelta: 0, costTotal: 0, costQty: 0,
          rows: []
        };
        groups.set(key, g);
      }
      g.rows.push(r);
      g.qty += r.qty || 0;
      g.listed += r.listed || 0;
      g.valueDelta += r.valueDelta || 0;
      if (r.costQty) { g.costTotal += (r.avgCost || 0) * r.costQty; g.costQty += r.costQty; }
      // EDHRec rank is oracle-level - every printing of this card should
      // already carry the same rankNow/rankDelta, so just take the first
      // real value seen rather than trying to combine them.
      if (g.rankNow == null && r.rankNow != null) g.rankNow = r.rankNow;
      if (g.rankDelta == null && r.rankDelta != null) g.rankDelta = r.rankDelta;
    }
    const out = [];
    for (const g of groups.values()) {
      const pcts = g.rows.map(r => r.pct).filter(v => v != null).sort((a, b) => a - b);
      const n = pcts.length;
      const median = n ? (n % 2 ? pcts[(n - 1) / 2] : (pcts[n / 2 - 1] + pcts[n / 2]) / 2) : null;
      g.rows.sort((a, b) => Math.abs(b.pct || 0) - Math.abs(a.pct || 0));
      // "N of M printings" counts (set, collector) pairs, matching
      // totalPrintings and how a collector actually counts printings - NOT
      // raw rows, which also vary by language and finish. A single card
      // catalogued in several languages (all_cards, this deployment's real
      // bulkType) would otherwise inflate both sides of the ratio - caught
      // live on Elrond, Moon-Reader showing "2 of 20" for a card with 2
      // actual printings, ~5 of its language copies x 2 finishes each.
      const printings = new Map(); // "set|collector" -> best |pct| row seen
      for (const r of g.rows) {
        if (r.pct == null) continue;
        const pKey = r.set + "|" + r.collector;
        const prev = printings.get(pKey);
        if (!prev || Math.abs(r.pct) > Math.abs(prev.pct)) printings.set(pKey, r);
      }
      const moved = [...printings.values()];
      // Prefer a printing the user actually owns for the group's thumbnail -
      // 2026-09-05 card-row consistency ask - falling back to whichever
      // printing happened to sort first otherwise.
      out.push(Object.assign({
        oracleId: g.oracleId, name: g.name, imageUrl: UI.artForGroup(g.rows),
        qty: g.qty, listed: g.listed, valueDelta: g.valueDelta,
        avgCost: g.costQty ? g.costTotal / g.costQty : null, costQty: g.costQty,
        rankNow: g.rankNow, rankDelta: g.rankDelta,
        totalPrintings: g.totalPrintings, movedCount: moved.length,
        pct: median, minPct: n ? pcts[0] : null, maxPct: n ? pcts[n - 1] : null,
        up: moved.filter(r => r.pct > 0).length, down: moved.filter(r => r.pct < 0).length,
        delta: null, now: null, then: null,
        rows: g.rows
      }, rollUpSold(g.rows)));
    }
    return out;
  }

  /* One printing's full row - Then/Now/MA/Δ/Rank/Listed/Cost/Actions, every
     real number this page can show for a single printing. Used both for the
     flat "Exact printing" table and, since the card view stopped collapsing
     printings into a single opaque summary line (2026-09-20 ask - a median %
     and a wall of dashes gave no way to actually decide anything), for the
     printing rows a drilled-open card row expands into below it. `opts.child`
     indents it and dims it slightly so the hierarchy reads at a glance. */
  function buildPrintingRow(r, opts) {
    const child = !!(opts && opts.child);
    const tr = document.createElement("tr");
    tr.className = "click " + (child ? "child-row " : "") + (r.delta > 0 ? "up" : r.delta < 0 ? "down" : "");
    tr.title = "Click for this printing's whole price history";
    tr.innerHTML =
      UI.artThumbTd(r.imageUrl) +
      '<td class="card-name">' + UI.cardLink(r) + "</td>" +
      // Owned rows are one per condition (#112): the condition rides in the
      // Printing cell so an NM and an LP row of one printing can be told apart.
      '<td class="muted">' + G.esc(G.printingLabel(r.set, r.collector, r.setName)) +
        (r.condition ? " · " + G.esc(r.condition) : "") + "</td>" +
      "<td>" + (r.finish === "etched" ? '<span class="badge etched">ETCHED</span>' : r.finish === "foil" ? '<span class="badge foil">FOIL</span>' : '<span class="badge non">—</span>') + "</td>" +
      '<td class="num">' + r.qty + "</td>" +
      '<td class="num hide-sm">' + fmt(r.then) + "</td>" +
      '<td class="num hide-sm">' + fmt(r.now) + "</td>" +
      '<td class="num muted hide-sm">' + fmt(r.ma30) + "</td>" +
      '<td class="num muted hide-sm">' + fmt(r.ma60) + "</td>" +
      maPctTd(r) +
      '<td class="num delta">' + (r.delta == null ? "—" : (r.delta > 0 ? "+" : "") + fmt(r.delta)) + "</td>" +
      '<td class="num delta">' + G.pct(r.pct) + "</td>" +
      '<td class="num delta">' + (r.valueDelta == null ? "—" : (r.valueDelta > 0 ? "+" : "") + fmt(r.valueDelta)) + "</td>" +
      '<td class="num hide-sm">' + (r.rankNow == null ? "—" : r.rankNow.toLocaleString()) + "</td>" +
      /* rank: lower number is better - polarity inverted vs. every $ column above. An
         arrow (not just the color) carries "more/less popular" so the sign of the raw
         number - which reads as +/- everywhere else on this row - doesn't have to be
         mentally flipped to tell which way is good. data-v carries the real signed
         number for the generic column-sort (ui.js cellValue) to key on, since the
         displayed text (an arrow plus an unsigned magnitude) isn't itself parseable. */
      '<td class="num ' + (r.rankDelta > 0 ? "neg" : r.rankDelta < 0 ? "pos" : "") +
        '" data-v="' + (r.rankDelta == null ? "" : r.rankDelta) + '">' +
        (r.rankDelta == null ? "—" : (r.rankDelta < 0 ? "▲ " : r.rankDelta > 0 ? "▼ " : "") +
          Math.abs(r.rankDelta).toLocaleString()) + "</td>" +
      soldCell(r, false) +
      '<td class="num hide-sm">' + (r.listed ? r.listed : '<span class="muted">—</span>') + "</td>" +
      // Cost basis is what the user actually paid, always their own
      // currency (USD) regardless of which vendor's trend is selected -
      // never routed through fmt()/euro().
      '<td class="num hide-sm">' + (r.costQty ? G.money(r.avgCost) : '<span class="muted">—</span>') + "</td>" +
      '<td class="row-actions"><button class="small" data-act="sell"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#circle-dollar-sign></use></svg> Sell</button>' +
        '<button class="small" data-act="buy"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#shopping-cart></use></svg> Buy</button></td>';
    tr.querySelector('[data-act="sell"]').onclick = stop(() => {
      UI.go("/listings.html?q=" + encodeURIComponent(r.name));
    });
    tr.querySelector('[data-act="buy"]').onclick = stop(() => {
      UI.go("/buy-list.html?q=" + encodeURIComponent(r.name) +
        "&set=" + encodeURIComponent(r.set) + "&collector=" + encodeURIComponent(r.collector));
    });
    UI.wireArtHover(tr, r.imageUrl);
    tr.onclick = () => { hidePreview(); showHistory(r); };
    return tr;
  }

  /* A card's summary/pivot row - Excel-PivotTable-style drill-down (2026-09-20
     ask): the row itself only shows what's genuinely true at the card level
     (rank, total qty/value, the spread of how far its printings moved), then
     expands in place into a buildPrintingRow() per moved printing so every
     actual price/MA/rank number - the things you'd need to decide whether to
     buy or sell a SPECIFIC printing - is one click away instead of averaged
     into oblivion. Then/Now/MA30/MA60/MA30-60/Δ each have no honest card-level
     value (a card's printings can sit at wildly different price points), so
     rather than a row of dashes they're one merged, empty cell - the point is
     "look below," not "here's a number that doesn't mean anything." */
  function buildCardRow(r) {
    const key = cardKeyOf(r);
    const isOpen = expandedCards.has(key);
    const tr = document.createElement("tr");
    tr.className = "click card-row " + (r.pct > 0 ? "up" : r.pct < 0 ? "down" : "");
    tr.title = isOpen ? "Click to collapse" : "Click to see this card's individual printings";
    tr.innerHTML =
      UI.artThumbTd(r.imageUrl) +
      '<td class="card-name"><span class="disclosure">' + (isOpen ? "▾" : "▸") + "</span>" + UI.cardNameLink(r.name) + "</td>" +
      '<td class="muted" title="' + r.movedCount + ' of this card\'s ' + r.totalPrintings + ' known printings moved enough to show up here">' +
        r.movedCount + " of " + r.totalPrintings + " printings moved</td>" +
      '<td class="num">' + (r.up ? '<span class="pos">▲' + r.up + "</span> " : "") +
        (r.down ? '<span class="neg">▼' + r.down + "</span>" : "") +
        (!r.up && !r.down ? "—" : "") + "</td>" +
      '<td class="num">' + r.qty + "</td>" +
      '<td class="num muted" colspan="6"></td>' +
      '<td class="num delta">' + G.pct(r.pct) +
        (r.minPct != null && r.maxPct != null && (r.minPct !== r.pct || r.maxPct !== r.pct)
          ? '<div class="muted" style="font-size:.85em">' + G.pct(r.minPct) + " to " + G.pct(r.maxPct) + "</div>" : "") + "</td>" +
      '<td class="num delta">' + (r.valueDelta == null ? "—" : (r.valueDelta > 0 ? "+" : "") + fmt(r.valueDelta)) + "</td>" +
      '<td class="num hide-sm">' + (r.rankNow == null ? "—" : r.rankNow.toLocaleString()) + "</td>" +
      '<td class="num ' + (r.rankDelta > 0 ? "neg" : r.rankDelta < 0 ? "pos" : "") +
        '" data-v="' + (r.rankDelta == null ? "" : r.rankDelta) + '">' +
        (r.rankDelta == null ? "—" : (r.rankDelta < 0 ? "▲ " : r.rankDelta > 0 ? "▼ " : "") +
          Math.abs(r.rankDelta).toLocaleString()) + "</td>" +
      soldCell(r, true) +
      '<td class="num hide-sm">' + (r.listed ? r.listed : '<span class="muted">—</span>') + "</td>" +
      '<td class="num hide-sm">' + (r.costQty ? G.money(r.avgCost) : '<span class="muted">—</span>') + "</td>" +
      '<td class="row-actions"><button class="small" data-act="sell"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#circle-dollar-sign></use></svg> Sell</button>' +
        '<button class="small" data-act="buy"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#shopping-cart></use></svg> Buy</button></td>';
    tr.querySelector('[data-act="sell"]').onclick = stop(() => {
      UI.go("/listings.html?q=" + encodeURIComponent(r.name));
    });
    tr.querySelector('[data-act="buy"]').onclick = stop(() => {
      UI.go("/buy-list.html?q=" + encodeURIComponent(r.name));
    });
    UI.wireArtHover(tr, r.imageUrl);
    tr.onclick = () => {
      if (isOpen) expandedCards.delete(key); else expandedCards.add(key);
      renderTable();
    };
    return tr;
  }

  function renderTable() {
    hidePreview(); // a re-render can replace the row currently under the cursor
    const grouping = $("group").value === "card";
    $("thPrinting").textContent = grouping ? "Printings" : "Printing";
    $("thPrinting").title = grouping ? "How many of this card's known printings (different sets/versions - not counting foil or language separately) moved enough to show up here" : "";
    $("thFinish").textContent = grouping ? "Moved" : "Finish";
    $("thPct").title = grouping ? "Median % change across the card's printings that moved - click the row to drill into each one" : "";
    if (soldTitle == null) soldTitle = $("thSold").title || "";
    const sales = data && data.sales;
    $("thSold").title = soldTitle + (grouping ? " A card row adds up each of its printings listed here once." : "") +
      (sales && sales.dataThrough ? " The 7 days run to " + sales.dataThrough + ", the latest day of Manapool sales we have." : "") +
      (sales && sales.historySince ? " Sales history since " + sales.historySince + "." : "");
    // A drilled-open card's printing rows nest under it in DOM order - the
    // generic click-to-sort column reorder (ui.js) has no idea rows can be
    // parent/child and would scatter them, so it's switched off wholesale
    // while grouped rather than per-column.
    $("moveTable").classList.toggle("pivot-nosort", grouping);
    markGroupSortHeaders(grouping);

    const printRows = visibleRows();
    const rows = grouping ? groupByCard(printRows) : printRows;
    if (grouping) {
      if (groupSort && GROUP_SORT_KEYS[groupSort.col]) {
        const getVal = GROUP_SORT_KEYS[groupSort.col];
        rows.sort((a, b) => {
          const av = getVal(a), bv = getVal(b);
          const cmp = typeof av === "string" ? av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) : av - bv;
          return cmp * groupSort.dir;
        });
      } else {
        const key = $("rank").value;
        rows.sort((a, b) => Math.abs(Number(b[key]) || 0) - Math.abs(Number(a[key]) || 0));
      }
    }
    $("moveHdr").textContent = data && data.fromDate
      ? "— " + rows.length + " " + (grouping ? "card" : "printing") + (rows.length === 1 ? "" : "s") + " moved between " +
        data.fromDate + " and " + data.toDate
      : "";
    const body = $("moveBody");
    if (!rows.length) {
      const vendorLabel = $("vendor").selectedOptions[0].textContent;
      body.innerHTML = data && !data.fromDate
        ? UI.emptyRow(19, { icon: "history", title: "There is only one snapshot so far, so nothing can be compared yet.",
            hint: "Come back tomorrow." })
        : data && data.vendorCoverage === 0
        ? UI.emptyRow(19, { icon: "error", title: G.esc(vendorLabel) + " isn't publishing any price data right now.",
            hint: "Not a Grimoire bug (confirmed against the live feed) - try a different market." })
        : $("signal").value === "backedRise" && data.sales && data.sales.comparable === false
        ? UI.emptyRow(19, { icon: "history", title: "Too early to tell which rises are backed by faster selling.",
            hint: "SELLING FAST needs about two weeks of sales history to compare paces." })
        : UI.emptyRow(19, { icon: "search", title: "Nothing moved by more than a cent in this window, at these filters." });
      return;
    }
    body.innerHTML = "";
    for (const r of rows.slice(0, 500)) {
      if (grouping) {
        body.appendChild(buildCardRow(r));
        if (expandedCards.has(cardKeyOf(r))) {
          for (const pr of r.rows) body.appendChild(buildPrintingRow(pr, { child: true }));
        }
        continue;
      }
      body.appendChild(buildPrintingRow(r, {}));
    }
    UI.reapplySorts();
  }

  async function showHistory(r) {
    const isCurrent = beginHistory();
    const vendor = dataVendor || $("vendor").value;
    const vendorOpt = [...$("vendor").options].find(o => o.value === vendor);
    UI.showModal("histModal", "hClose");
    $("hTitle").textContent = r.name;
    $("hMeta").textContent = G.printingLabel(r.set, r.collector, r.setName) +
      (r.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[r.finish].toLowerCase() : "") +
      " · you hold " + r.qty + " · " + (vendorOpt ? vendorOpt.textContent : vendor);
    $("hChart").innerHTML = UI.skeletonBlock(4);
    $("hTable").innerHTML = "";
    let h;
    try { h = await G.api("/api/prices/history?key=" + encodeURIComponent(r.key) + "&vendor=" + encodeURIComponent(vendor)); }
    catch (e) {
      if (isCurrent()) $("hChart").innerHTML = UI.emptyBlock({ icon: "error", title: "Could not load history: " + G.esc(e.message) });
      return;
    }
    if (!isCurrent()) return;   // another row's history was opened meanwhile
    // The MA overlay tracks whichever finish this row actually is - all
    // three finishes' price lines are shown together above, but an MA pair
    // per finish at once would be six extra lines on top of three.
    const seriesForFinish = f => f === "etched" ? h.etched : f === "foil" ? h.foil : h.usd;
    const maSeries = r.finish === "etched" ? { ma30: h.etchedMa30, ma60: h.etchedMa60 }
      : r.finish === "foil" ? { ma30: h.foilMa30, ma60: h.foilMa60 } : { ma30: h.usdMa30, ma60: h.usdMa60 };
    $("hChart").innerHTML = UI.lineChart({
      labels: h.dates,
      series: [
        { values: h.usd, cls: "" },
        { values: h.foil, cls: "foil" },
        { values: h.etched, cls: "etched" },
        { values: maSeries.ma30, cls: "ma30" },
        { values: maSeries.ma60, cls: "ma60" }
      ],
      // Taller ratio: the modal is far narrower than the page.
      width: 1000, height: 320,
      title: r.name + " price history",
      yFormat: fmt
    });
    const n = h.dates.length;
    if (n) {
      const series = seriesForFinish(r.finish);
      const known = series.map((v, i) => ({ v, d: h.dates[i] })).filter(x => x.v != null);
      if (known.length) {
        const first = known[0], last = known[known.length - 1];
        const hi = known.reduce((a, b) => (b.v > a.v ? b : a));
        const lo = known.reduce((a, b) => (b.v < a.v ? b : a));
        $("hTable").innerHTML =
          '<div class="summary">' +
          '<div class="stat"><span class="big">' + fmt(last.v) + '</span><span class="lbl">Latest (' + last.d + ")</span></div>" +
          '<div class="stat"><span class="big">' + fmt(first.v) + '</span><span class="lbl">First (' + first.d + ")</span></div>" +
          '<div class="stat"><span class="big val">' + fmt(hi.v) + '</span><span class="lbl">High (' + hi.d + ")</span></div>" +
          '<div class="stat"><span class="big neg">' + fmt(lo.v) + '</span><span class="lbl">Low (' + lo.d + ")</span></div>" +
          '<div class="stat"><span class="big">' + n + '</span><span class="lbl">Snapshots</span></div>' +
          "</div>";
      }
    }

    // Every vendor side by side (BACKLOG #78a) - beneath the one-vendor summary above.
    $("hTable").insertAdjacentHTML("beforeend", UI.vendorCompare(h, r.finish));

    // Rank is per-card, not per-finish (movers' own rankNow/rankDelta work
    // the same way) - one chart regardless of which finish row was clicked.
    // Hidden entirely rather than an empty-chart placeholder when this
    // printing has never had a tracked rank (most non-EDH-relevant cards).
    const rankKnown = (h.rank || []).some(v => v != null);
    $("hRankSection").hidden = !rankKnown;
    if (rankKnown) {
      $("hRankChart").innerHTML = UI.lineChart({
        labels: h.dates,
        series: [{ values: h.rank, cls: "" }],
        width: 1000, height: 220,
        title: r.name + " EDHRec rank history",
        yFormat: v => Math.round(v).toLocaleString(),
        invert: true
      });
    }
  }

  let portStale = true;
  async function renderPortfolio() {
    portStale = false;
    const el = $("portChart");
    const isCurrent = beginPortfolio();
    el.innerHTML = UI.skeletonBlock(4);
    try {
      const p = await G.api("/api/prices/portfolio?days=" + encodeURIComponent($("portDays").value) +
        "&vendor=" + encodeURIComponent($("vendor").value));
      if (!isCurrent()) return;   // a newer vendor/window request superseded this one
      if (!p.points || p.points.length < 2) {
        el.innerHTML = UI.emptyBlock({ icon: "history", title: "Not enough snapshots yet.", hint: "One lands per day." });
        return;
      }
      el.innerHTML = UI.lineChart({
        labels: p.points.map(x => x.date),
        series: [{ values: p.points.map(x => G.round2(x.value)) }],
        height: 240,
        title: "Portfolio value",
        yFormat: fmt
      });
    } catch (e) {
      if (!isCurrent()) return;
      el.innerHTML = UI.emptyBlock({ icon: "error", title: "Could not load portfolio history: " + G.esc(e.message) });
    }
  }

  /* The status line for a loaded window. The server counts the window back
     from the latest snapshot (#110), so the span only differs from what was
     asked for when no snapshot sits exactly that far back: either the archive
     starts later (fromDate is its first snapshot), or that day is missing and
     the nearest snapshot stood in. (No oldestDate = an older server: keep
     its old reading.) */
  function windowStatus(d) {
    const span = Math.round((new Date(d.toDate) - new Date(d.fromDate)) / 86400000);
    let note = "";
    if (span !== d.requestedDays) {
      note = (span < d.requestedDays && (d.oldestDate === undefined || d.fromDate <= d.oldestDate))
        ? "; that is as far back as the archive goes"
        : "; the nearest snapshot to " + d.requestedDays + " days back";
    }
    return "Comparing " + d.fromDate + " with " + d.toDate + " (" + span + " day" +
      (span === 1 ? "" : "s") + " apart" + note + ").";
  }

  async function reload() {
    const isCurrent = beginReload();
    UI.setStatus("status", "Loading price snapshots…", "work");
    const vendor = $("vendor").value, days = $("days").value;
    let got;
    try {
      got = await G.api("/api/prices/movers?days=" + encodeURIComponent(days) +
        "&vendor=" + encodeURIComponent(vendor) +
        "&heldOnly=" + ($("onlyHeld").checked ? "1" : "0"));
    } catch (e) {
      if (isCurrent()) UI.setStatus("status", "Could not load movers: " + e.message, "err");
      return;
    }
    if (!isCurrent()) return;   // a newer vendor/window/Only held/Reload request superseded this one
    data = got;
    dataVendor = vendor;
    expandedCards = new Set();
    // The window is a store default in a store (#159): only managers save it.
    if (G.canManageStore()) G.state.settings.moversDays = Number(days);
    G.state.settings.moversVendor = vendor;
    G.persistSettings();
    if (data.error) {
      UI.setStatus("status", data.error + " The server takes one snapshot a day" +
        (G.isAdmin ? "; you can force one now from Settings, or run `node server/index.js --snapshot-prices`." : "; ask the site admin if this keeps happening."), "err");
    } else if (!data.fromDate) {
      UI.setStatus("status", "Only one snapshot exists so far (" + data.toDate +
        "). Comparisons start once there are two.", "work");
    } else {
      UI.setStatus("status", windowStatus(data), "ok");
    }
    renderHighlights();
    // Explore always redraws with the new data (#114), empty states included.
    // It used to run only from inside renderHighlights() when a curated pick
    // qualified, so a no-picks day left it blank or showing the old rows.
    renderExplore();
    renderTiles();
    renderTable();
  }

  function exportCsv() {
    const rows = visibleRows();
    if (!rows.length) { UI.toast("Nothing to export.", "err"); return; }
    const head = ["Card", "Set", "Collector #", "Language", "Finish", "Condition", "Vendor", "Qty", "Then", "Now",
      "MA30", "MA60", "MA30-60", "MA30-60 Pct", "Delta Each", "Delta Pct", "Delta Value",
      "EDHRec Rank Now", "EDHRec Rank Delta", "Manapool Sold 7d", "Sold 7d Is A Minimum", "Listed", "Avg Cost", "From Date", "To Date"];
    const lines = [head.map(G.csvCell).join(",")];
    const vendorLabel = $("vendor").selectedOptions[0].textContent;
    for (const r of rows) {
      lines.push([r.name, r.set.toUpperCase(), r.collector, r.lang, G.FINISH_NAMES[r.finish] || "Non-foil", r.condition || "", vendorLabel, r.qty,
        r.then == null ? "" : r.then.toFixed(2), r.now == null ? "" : r.now.toFixed(2),
        r.ma30 == null ? "" : r.ma30.toFixed(2), r.ma60 == null ? "" : r.ma60.toFixed(2),
        r.maDiff == null ? "" : r.maDiff.toFixed(2), r.maPct == null ? "" : r.maPct.toFixed(2),
        r.delta == null ? "" : r.delta.toFixed(2), r.pct == null ? "" : r.pct.toFixed(2),
        r.valueDelta == null ? "" : r.valueDelta.toFixed(2),
        r.rankNow == null ? "" : r.rankNow, r.rankDelta == null ? "" : r.rankDelta,
        r.sold7d == null ? "" : r.sold7d, r.sold7d != null && r.sold7dAtLeast ? "Yes" : "",
        r.listed || "", r.avgCost == null ? "" : r.avgCost.toFixed(2),
        data.fromDate || "", data.toDate || ""].map(G.csvCell).join(","));
    }
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-movers.csv");
    UI.toast("Exported " + rows.length + " rows.", "ok");
  }

  UI.boot(async function () {
    const want = Number(G.state.settings.moversDays);
    if (want && [...$("days").options].some(o => Number(o.value) === want)) $("days").value = String(want);
    // Staff in a store (#159): the movers window is the store's default, set
    // by its managers, so it's read-only here, like on Settings.
    if (!G.canManageStore()) { $("days").disabled = true; $("daysStoreNote").hidden = false; }
    const wantVendor = G.state.settings.moversVendor;
    if (wantVendor && [...$("vendor").options].some(o => o.value === wantVendor)) $("vendor").value = wantVendor;
    $("portVendor").value = $("vendor").value;

    // The tab is remembered (UI.pageTabs); movers.html#tab=selling is a link to Selling fast.
    tabs = UI.pageTabs({ tabs: [
      { id: "movers", button: "tabMovers", panes: ["paneMovers"] },
      { id: "highlights", button: "tabHighlights", panes: ["paneHighlights"] },
      { id: "selling", button: "tabSelling", panes: ["paneSelling"] },
      { id: "portfolio", button: "tabPortfolio", panes: ["panePortfolio"] }
    ], onShow: t => {
      if (t === "selling") loadSelling();
      // The chart loads when the tab is first opened, and again if the vendor changed meanwhile.
      if (t === "portfolio" && portStale) renderPortfolio();
    } });
    $("sfHideLands").addEventListener("change", renderSelling);
    $("sfSearch").addEventListener("input", G.debounce(searchSelling, 250));
    $("sellTable").tHead.addEventListener("click", e => {
      const th = e.target.closest("th");
      if (!th || !SELL_SORT_KEYS[th.cellIndex]) return;
      const col = th.cellIndex;
      // Rank (#1 first), Card (A to Z) and Days left (shortest first, #368)
      // start ascending; counts high to low.
      sellSort = sellSort.col === col ? { col, dir: -sellSort.dir } : { col, dir: col <= 2 || col === 9 ? 1 : -1 };
      renderSelling();
    });
    $("sfMoreBtn").onclick = moreSelling;
    ["exCategory", "exCount", "exMinPrice", "exHeldOnly"].forEach(id => {
      $(id).addEventListener("change", renderExplore);
    });
    // Golden cross (#352): its own small fetch, so N and Show only mine
    // redraw just that list.
    $("gxDays").addEventListener("input", G.debounce(loadCross, 400));
    $("gxDays").addEventListener("change", loadCross);
    $("gxGap").addEventListener("input", G.debounce(loadCross, 400));
    $("gxGap").addEventListener("change", loadCross);
    $("gxMine").addEventListener("change", loadCross);
    $("days").onchange = reload;
    // Vendor is one setting with two selects (Movers tab and Portfolio tab): changing either moves the other.
    const vendorChanged = () => {
      $("portVendor").value = $("vendor").value;
      reload(); loadCross();
      portStale = true;
      if (tabs.current() === "portfolio") renderPortfolio();
    };
    $("vendor").onchange = vendorChanged;
    $("portVendor").onchange = () => { $("vendor").value = $("portVendor").value; vendorChanged(); };
    $("btnReload").onclick = () => { loadCross(); return reload(); };
    $("portDays").onchange = renderPortfolio;
    // "Only held" changes what the SERVER returns, not just what the client
    // shows (see reload()'s heldOnly param and prices.js's requireMeaningfulOwned) -
    // an owned row below the catalog-wide "meaningful move" bar only exists
    // in the fetched data at all when this is checked, so toggling it needs
    // a real re-fetch, not just a re-render of what's already in hand.
    $("onlyHeld").addEventListener("change", reload);
    ["dir", "rank", "minPrice", "rankDir", "signal", "flatPct", "flatSpots", "group"].forEach(id => {
      $(id).addEventListener("change", () => { renderTiles(); renderTable(); });
    });
    $("search").addEventListener("input", G.debounce(renderTable, 180));
    // The generic click-to-sort (ui.js) is switched off on this table while
    // grouped (pivot-nosort, above) since it can't safely reorder rows that
    // have children - this is its grouped-mode replacement, scoped to the
    // header row so it never intercepts a click on the table body.
    $("moveTable").tHead.addEventListener("click", e => {
      const th = e.target.closest("th");
      if (!th || $("group").value !== "card") return;
      const col = th.cellIndex;
      if (!GROUP_SORT_KEYS[col]) return;
      groupSort = (groupSort && groupSort.col === col) ? { col, dir: -groupSort.dir } : { col, dir: 1 };
      renderTable();
    });
    $("btnCsv").onclick = exportCsv;
    $("hClose").onclick = () => UI.hideModal("histModal");
    $("histModal").addEventListener("click", e => { if (e.target.id === "histModal") UI.hideModal("histModal"); });

    loadCross();
    await reload();

    // #410: the card panel's "Price history" link (?hist=1&q=&set=&collector=&finish=):
    // open that printing's history over the page; the chip closes it again.
    const sp = new URLSearchParams(location.search);
    const cf = UI.cardFilterFromUrl();
    if (sp.get("hist") && cf && cf.set && cf.collector) {
      const finish = G.normalizeFinish(sp.get("finish")) || "nonfoil";
      let qty = 0;
      for (const c of G.state.cards) {
        if (c.set === cf.set && String(c.collector).toLowerCase() === cf.collector.toLowerCase() && c.finish === finish) qty += Number(c.quantity) || 0;
      }
      UI.cardFilterChip($("search").closest("div") || $("search"), cf, "Price history: " + UI.cardFilterLabel(cf), () => UI.hideModal("histModal"));
      // Closing it by any route (Esc, X, backdrop, the chip) drops the params,
      // so Back doesn't reopen the history.
      UI.onClose("histModal", () => {
        UI.cardFilterChip(null, null);
        const u = new URL(location.href);
        ["hist", "q", "set", "collector", "finish", "lang"].forEach(k => u.searchParams.delete(k));
        history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      });
      showHistory({ name: cf.name, set: cf.set, collector: cf.collector, finish, qty, key: G.printKey(cf.set, cf.collector, sp.get("lang") || "en") });
    }
  });
})();
