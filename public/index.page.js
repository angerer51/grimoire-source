
"use strict";
(function () {
  const $ = UI.$;

  /* One tile's content; drawTile() below makes the markup. list: a wide
     tile's short top-3 (#298), as .feed-row html. */
  const tile = (big, lbl, cls, extra, href, accent, list) => ({ big, lbl, cls, extra, href, accent, list });

  // Ticket counts are the one thing on this page that genuinely differ per
  // signed-in person rather than per collection: "mine" is this account's own
  // open tickets, "queue" is the sitewide staff queue and only exists for
  // moderator+. Fetched once at boot (see loadTicketInfo) and re-rendered
  // from cache on every "change" - re-fetching on every state mutation would
  // hit the API far more than a ticket count needs to.
  let ticketInfo = null;
  let watchHits = [];   // BACKLOG #79: watched cards past their target price

  /* #244: what to do once the first card is in, so the page never goes
     quiet on a newcomer. Each step ticks itself off from data the page
     already has; the list goes once every step is done or the person hides
     it (a per-person pref, see core.js PERSONAL_KEYS). */
  const MANY_STACKS = 10;
  function nextSteps() {
    return [
      { icon: "upload", done: G.state.cards.length >= MANY_STACKS,
        html: "<b>Add the rest of your cards.</b> " +
          '<a href="/receive.html?mode=import">Paste a list</a> from a deck site (Moxfield, Archidekt…) ' +
          "or import a CSV file to add many at once." },
      { icon: "target", done: G.state.watchList.length > 0,
        html: "<b>Watch a card's price.</b> Add it to the " +
          '<a href="/buy-list.html">' + (G.simpleMode ? "Price watch" : "Buy List") + '</a> with a target price, and this page tells you when it gets there.' },
      { icon: "mail", done: !!(G.me && String(G.me.email || "").trim()),
        html: '<b>Add an email address</b> in <a href="/settings.html#acctEmail">Settings</a>, so you can ' +
          "reset a forgotten password and get the daily digest if you want it." }
    ];
  }

  /* #244: "since your last visit". A visit is a run of Dashboard views with
     no gap longer than VISIT_GAP_MS. This browser keeps one small
     localStorage entry per account and Store: when the Dashboard was last
     seen, when the previous visit was, and the figure worked out for it (so
     reloads don't refetch). The figure is price movement only:
     /api/prices/portfolio values today's holdings at each daily snapshot,
     so cards added since then don't read as a rise. */
  const VISIT_GAP_MS = 4 * 3600000;
  const SINCE_MAX_DAYS = 90;
  const visitKey = () => "grimoireLastVisit:" + ((G.me && G.me.id) || "") + ":" + (G.loadedOwner || "");
  function saveVisit(rec) {
    try { localStorage.setItem(visitKey(), JSON.stringify(rec)); } catch (e) { /* private mode: no line */ }
  }
  function noteVisit(now) {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(visitKey()) || "null"); } catch (e) { rec = null; }
    if (!rec || typeof rec !== "object") rec = {};
    const seen = Number(rec.seenAt) || 0;
    if (seen && now - seen > VISIT_GAP_MS) { rec.prevAt = seen; delete rec.moved; }
    rec.seenAt = now;
    saveVisit(rec);
    return rec;
  }
  function daysAgoText(t) {
    const mid = x => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const n = Math.round((mid(Date.now()) - mid(t)) / 86400000);
    return n <= 0 ? "earlier today" : n === 1 ? "yesterday" : n + " days ago";
  }
  async function loadSinceLast(rec) {
    if (!rec.prevAt) return;
    let m = rec.moved && rec.moved.prevAt === rec.prevAt ? rec.moved : null;
    if (!m) {
      const span = Math.ceil((Date.now() - rec.prevAt) / 86400000) + 1;
      let p;
      // Rounded up to the Movers page's windows, so its cached answer serves.
      const days = span <= 7 ? 7 : span <= 30 ? 30 : SINCE_MAX_DAYS;
      try { p = await G.api("/api/prices/portfolio?days=" + days); }
      catch (e) { return; }   // no snapshots, or no Store assigned: no line
      const pts = p && Array.isArray(p.points) ? p.points : [];
      const prevDay = G.localDay(rec.prevAt);
      let base = null;
      for (const x of pts) if (x.date <= prevDay) base = x;
      const capped = !base && span > SINCE_MAX_DAYS && pts.length > 0;
      if (capped) base = pts[0];
      const last = pts[pts.length - 1];
      // No snapshot since the last visit (same day), or none from before it.
      // A different priced-card count means a card had no price on one of
      // the two days, so the difference isn't price movement: no line.
      m = !base || !last || base.date >= last.date || base.pricedCards !== last.pricedCards
        ? { prevAt: rec.prevAt, none: true }
        : { prevAt: rec.prevAt, delta: last.value - base.value, base: base.value, capped };
      rec.moved = m;
      saveVisit(rec);
    }
    if (m.none || !(Math.abs(m.delta) >= 0.005)) return;
    const up = m.delta > 0;
    const box = $("sinceLast");
    box.className = "since-last " + (up ? "up" : "down");
    box.innerHTML = UI.icon(up ? "trending-up" : "trending-down") + " Card prices moved your collection <b>" +
      (up ? "up " : "down ") + G.money(Math.abs(m.delta)) + "</b>" +
      (m.base > 0 ? " (" + G.pct(100 * m.delta / m.base) + ")" : "") +
      (m.capped ? " over the last " + SINCE_MAX_DAYS + " days." : " since your last visit (" + daysAgoText(rec.prevAt) + ").") +
      // Simple mode hides Movers (#177): no link to a page it can't open.
      (G.simpleMode ? "" : ' <a href="/movers.html">See what moved</a>');
    box.hidden = false;
  }

  const CYCLE_COUNT_OVERDUE_DAYS = 90;
  function overdueBinCount() {
    const cutoff = Date.now() - CYCLE_COUNT_OVERDUE_DAYS * 86400000;
    // Never counted: fall back to when it was made. A location from before
    // createdAt existed has neither, so it stays overdue if it holds cards.
    return G.state.locations.filter(l => {
      if (!G.stacksInLocation(l.id).length) return false;
      const since = l.lastCycleCountAt || l.createdAt;
      return !since || new Date(since).getTime() < cutoff;
    }).length;
  }

  /* ============================== Tiles (#298) ==============================
     Each person picks which tiles they see, their order and size
     (Customize). The layout is a personal pref (core.js dashLayout), so
     coworkers in a Store keep their own. TILES is the catalog in default
     order; a new account gets the DEFAULT_TILES, which are the tiles from
     before #298 in their old order, so nothing changes until someone
     customizes.
     - full: only in full mode (Simple mode hides the page it's about).
     - mod: moderators only. wide: can be switched to wide (a short top 3).
     - src: data from the server, fetched once per visit and only while a
       tile that needs it is on the screen (see source()).
     A draw that returns null has nothing to say right now (no open
     tickets): left out, or a placeholder while customizing. */
  const DAY = 86400000;
  const s0 = () => G.summary(null);
  const plural = (n, one, many) => n.toLocaleString() + " " + (n === 1 ? one : (many || one + "s"));
  const arrow = n => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");
  const listRow = (text, num, cls, pre) => '<div class="feed-row' + (cls ? " " + cls : "") + '">' + (pre || "") +
    '<span class="ftext">' + text + '</span><span class="fnum">' + num + "</span></div>";
  // A fetched source not back yet, or failed: a quiet tile, not a wrong 0.
  const pending = (src, lbl, href) => src.busy ? tile("…", lbl, "", "loading", href)
    : tile("—", lbl, "", "couldn't load this just now", href);

  const SOURCES = {
    // The header ticker's cheap form of Movers: owned rows only, no moving
    // averages, the top few cached per account per snapshot day.
    movers: () => G.api("/api/prices/movers?days=7&ownedOnly=1&skipMA=1&top=6"),
    selling: () => G.api("/api/prices/selling-fast?limit=100"),
    // #366: Sold 7d and SELLING FAST for your own stock (the core.js cache).
    soldMine: () => G.loadSoldMine(),
    trades: async () => {
      const [t, f] = await Promise.all([
        G.api("/api/trades").catch(() => null),
        G.api("/api/friends").catch(() => null)
      ]);
      if (!t && !f) throw new Error("trades");
      const offers = ((t && t.data) || []).filter(p => p && p.incoming && !p.outgoing && p.status === "open").length;
      const requests = f && f.requests && Array.isArray(f.requests.incoming) ? f.requests.incoming.length : 0;
      return { offers, requests };
    }
  };
  const sources = {};
  function source(name) {
    let s = sources[name];
    if (!s) {
      s = sources[name] = { busy: true, data: null, err: false };
      SOURCES[name]().then(d => { s.data = d; }, () => { s.err = true; })
        .then(() => { s.busy = false; renderTiles(); renderAlerts(); });
    }
    return s;
  }

  // The Selling fast tile's main figure: Movers' Selling fast ranking
  // (copies sold on Manapool in the last 7 days), matched to your stock by
  // card name, as its rows are names.
  function sellingTop(wide) {
    const src = source("selling");
    if (src.busy || src.err) return pending(src, "Selling fast", "/movers.html");
    const owned = new Set(G.state.cards.filter(r => r.quantity > 0).map(r => String(r.name || "").toLowerCase()));
    const all = (src.data && src.data.cards) || [];
    const has = c => owned.has(String(c.name || "").toLowerCase());
    const mine = all.filter(has).length;
    const sold = c => (c.atLeast7 ? "≥ " : "") + (Number(c.copies7) || 0).toLocaleString() + " sold 7d";
    return tile(mine.toLocaleString(), "Selling fast", "",
      "you have " + mine.toLocaleString() + " of the top " + all.length.toLocaleString() + " sellers this week",
      "/movers.html", "",
      // Wide: the top 3 overall, each marked in words when you have it.
      wide ? all.slice(0, 3).map((c, i) => listRow('<span class="muted">#' + (c.rank || i + 1) + "</span> <b>" + UI.cardNameLink(c.name) + "</b>" +
        (has(c) ? ' <span class="tile-have">' + UI.icon("check") + " you have it</span>" : ""), sold(c))) : null);
  }

  const TILES = [
    { id: "cards", label: "Cards", draw: () => {
      const s = s0();
      return tile(s.cards.toLocaleString(), "Cards", "", (G.simpleMode ? s.names.toLocaleString() + " different cards" : s.names.toLocaleString() + " names in " + s.stacks + " stacks"), "/inventory.html");
    } },
    { id: "value", label: "Market value", draw: () => {
      const s = s0();
      // Averages leave out cards with no price (#326). The tile is one big
      // link, so the "not counted" note is plain text here; the link is on
      // Statistics and Card Inventory.
      return tile(G.money(s.value), "Market value", "val",
        (s.pricedCards ? G.money(s.value / s.pricedCards) + " per priced card<br>" : "") +
        (s.unpricedCards ? G.unpricedNote(s.unpricedCards, false) + "<br>" : "") +
        '<span data-price-basis>Near Mint market price</span>', "/stats.html", "gold");
    } },
    { id: "cost", label: "Cost basis", full: true, draw: () => {
      const c = s0().cost;
      return tile(G.money(c.cost), "Cost basis", "", Math.round(c.coverage * 100) + "% of cards have one", "/stats.html");
    } },
    { id: "gain", label: "Unrealised gain", full: true, draw: () => {
      const c = s0().cost;
      return tile(c.cost > 0 ? arrow(c.gain) + G.money(c.gain) : "—",
        "Unrealised gain", c.gain >= 0 ? "val" : "neg",
        c.gainPct == null ? "post a lot receipt to measure this" : G.pct(c.gainPct) + " on costed copies",
        "/stats.html", c.gain >= 0 ? "pos" : "neg");
    } },
    { id: "locations", label: "Locations", draw: () => tile(G.state.locations.length.toLocaleString(), "Locations", "",
      // Putaway is hidden in Simple mode (#177), so no putaway count there.
      G.simpleMode ? "where your cards live"
        : G.state.locations.filter(l => l.putaway && l.putaway.enabled).length + " in the putaway rotation", "/locations.html") },
    { id: "sealed", label: "Sealed value", full: true, draw: () =>
      tile(G.money(G.state.sealed.reduce((x, r) => x + (r.price == null ? 0 : r.price * r.quantity), 0)), "Sealed value", "val",
        G.state.sealed.reduce((x, r) => x + r.quantity, 0).toLocaleString() + " item(s) across " +
        G.state.sealed.length + " SKU(s)", "/sealed.html", "gold") },
    { id: "listed", label: "Marked to list", full: true, draw: () => {
      const s = s0();
      return tile(s.listedCards.toLocaleString(), "Marked to list", "", G.money(s.listedValue) + " of value, not necessarily sent to a marketplace", "/inventory.html");
    } },
    { id: "picklist", label: "On the pick list", full: true, draw: () => {
      const openPick = G.pickLists().filter(p => p.status === "open");
      // "picked" (BACKLOG.md #8's 2026-09-01 fulfillment redesign) means
      // inventory is already decremented but weigh/manifest/ship in Grimoire
      // hasn't happened yet: its own count, not folded into openPick's.
      const awaitingShip = G.pickLists().filter(G.awaitsShip);
      return tile(openPick.reduce((x, p) => x + p.lines.reduce((y, i) => y + i.qty, 0), 0).toLocaleString(), "On the pick list",
        "", openPick.length + " open list(s)" + (awaitingShip.length ? ", " + awaitingShip.length + " awaiting ship" : ""), "/lists.html");
    } },
    { id: "decklist", label: "On the deck list", full: true, draw: () =>
      tile(G.state.deckList.reduce((x, i) => x + i.qty, 0).toLocaleString(), "On the deck list",
        "", G.state.deckList.length + " line(s)", "/deck-list.html") },
    { id: "watching", label: "Watching", draw: () => {
      const watching = G.state.watchList.length;
      return tile(watching.toLocaleString(), "Watching", "",
        watching ? "price" + (watching === 1 ? "" : "s") + " tracked" : "not tracking any prices yet", "/buy-list.html");
    } },
    // Simple mode hides Cycle Count (#177): no tile pointing at a page it can't open.
    { id: "overdue", label: "Overdue for a count", full: true, draw: () => {
      const overdue = overdueBinCount();
      return tile(overdue.toLocaleString(), "Overdue for a count", "",
        overdue ? "location" + (overdue === 1 ? "" : "s") + " not counted in " + CYCLE_COUNT_OVERDUE_DAYS + "+ days" : "every location's been counted recently",
        "/cycle-count.html", overdue > 0 ? "gold" : "");
    } },
    { id: "tickets", label: "Support tickets", empty: "shows when you have an open support ticket", draw: () => {
      if (!ticketInfo) return null;
      const waiting = ticketInfo.waiting > 0 ? ticketInfo.waiting + " more waiting on the support team" : "";
      if (ticketInfo.mine > 0) {
        return tile(ticketInfo.mine.toLocaleString(), "Awaiting your reply",
          "", (ticketInfo.mine === 1 ? "1 support ticket" : ticketInfo.mine + " support tickets") + (waiting ? "; " + waiting : ""),
          "/help.html#support", "gold");
      }
      // Waiting on staff, not on you: a quiet count, not an orange one.
      if (ticketInfo.waiting > 0) return tile(ticketInfo.waiting.toLocaleString(), "Open tickets", "", "waiting on the support team", "/help.html#support");
      return null;
    } },
    { id: "queue", label: "Support queue", mod: true, draw: () => ticketInfo
      ? tile(ticketInfo.queue.toLocaleString(), "Support queue", "", "open across all accounts", "/admin.html", ticketInfo.queue > 0 ? "gold" : "")
      : null },

    // ---- New with #298: not on anyone's Dashboard until they add them. ----
    // Movers' own held summary (the same request as Biggest movers): only
    // cards priced at both ends of the week count (core.js heldChange).
    { id: "valueChange", label: "Value change", src: "movers", draw: () => {
      // Movers has the portfolio chart; Simple mode hides Movers (#177).
      const href = G.simpleMode ? "/stats.html" : "/movers.html";
      const src = source("movers");
      if (src.busy || src.err) return pending(src, "Value change, 7 days", href);
      const m = G.heldChange(src.data);
      if (!m) return tile("—", "Value change, 7 days", "", "not enough price history yet", href);
      return tile(arrow(m.delta) + G.money(Math.abs(m.delta)), "Value change, 7 days", m.delta >= 0 ? "val" : "neg",
        (m.pct == null ? "" : G.pct(m.pct) + " ") + "from card prices", href, m.delta > 0 ? "pos" : m.delta < 0 ? "neg" : "");
    } },
    { id: "soldWeek", label: "Sold, last 7 days", full: true, draw: () => {
      const s = G.salesBetween(Date.now() - 7 * DAY, Date.now());
      return tile(s.copies.toLocaleString(), "Sold, last 7 days", "",
        G.money(s.revenue) + " from " + plural(s.orders, "order"), "/accounting.html");
    } },
    { id: "soldMonth", label: "Sold this month", full: true, draw: () => {
      const s = G.salesBetween(G.monthStartMs(Date.now()), Date.now());
      return tile(s.copies.toLocaleString(), "Sold this month", "",
        G.money(s.revenue) + " from " + plural(s.orders, "order"), "/accounting.html");
    } },
    { id: "profit", label: "Profit this month", full: true, draw: () => {
      const t = G.profitBetween(G.monthStartMs(Date.now()), Date.now());
      return tile(arrow(t.net) + G.money(t.net), "Profit this month", t.net >= 0 ? "val" : "neg",
        "net, after cost, fees and refunds", "/accounting.html", t.net > 0 ? "pos" : t.net < 0 ? "neg" : "");
    } },
    { id: "toShip", label: "Orders to ship", full: true, draw: () => {
      const n = G.pickLists().filter(G.awaitsShip).length;   // a walk-in (#431) is handed over, not shipped
      return tile(n.toLocaleString(), "Orders to ship", "", n ? "picked, waiting to ship" : "nothing waiting to ship", "/lists.html", n ? "gold" : "");
    } },
    { id: "received", label: "Recently received", full: true, wide: true, draw: wide => {
      const r = G.receiptsSince(G.dayStartMs(Date.now() - 6 * DAY));
      return tile(r.cards.toLocaleString(), "Received, last 7 days", "", plural(r.receipts.length, "receipt"), "/receive.html", "",
        wide ? G.state.receipts.slice(0, 3).map(x => listRow("<b>" + G.esc(x.receiptId || "—") + "</b> " +
          '<span class="muted">' + G.esc(new Date(x.ts).toLocaleDateString()) + "</span>", (Number(x.totalCards) || 0).toLocaleString())) : null);
    } },
    { id: "putaway", label: "Waiting for putaway", full: true, draw: () => {
      const bins = G.stagingBins().filter(b => b.cards > 0);
      const n = bins.reduce((x, b) => x + b.cards, 0);
      return tile(n.toLocaleString(), "Waiting for putaway", "",
        n ? "in " + plural(bins.length, "sorting tray") : "every sorting tray is empty", "/putaway.html", n ? "gold" : "");
    } },
    { id: "topCard", label: "Most valuable card", wide: true, draw: wide => {
      const top = G.topCardsByPrice(3);
      if (!top.length) return tile("—", "Most valuable card", "", "no priced cards yet", "/inventory.html");
      const r = top[0];
      return tile(G.money(r.price), "Most valuable card", "val",
        wide ? "" : "<b>" + UI.cardLink(r) + "</b> · " + G.esc(String(r.set || "").toUpperCase()) + " #" + G.esc(r.collector), "/inventory.html", "",
        wide ? top.map(x => {
          const art = G.artCropUrl(x.imageUrl);
          return listRow("<b>" + UI.cardLink(x) + "</b> " + '<span class="muted">' + G.esc(String(x.set || "").toUpperCase()) + "</span>",
            G.money(x.price), "", art ? '<img class="art-thumb" src="' + G.esc(art) + '" alt="" loading="lazy">' : '<span class="art-thumb"></span>');
        }) : null);
    } },
    { id: "movers", label: "Biggest movers", full: true, wide: true, src: "movers", draw: wide => {
      const src = source("movers");
      if (src.busy || src.err) return pending(src, "Biggest movers, 7 days", "/movers.html");
      const rows = ((src.data && src.data.rows) || []).filter(r => r.qty > 0 && r.delta != null && Math.abs(r.valueDelta || 0) >= 0.01);
      if (!rows.length) return tile("—", "Biggest movers, 7 days", "", "none of your cards moved", "/movers.html");
      const r = rows[0];
      return tile(arrow(r.valueDelta) + G.money(Math.abs(r.valueDelta)), "Biggest movers, 7 days", r.valueDelta >= 0 ? "val" : "neg",
        wide ? "" : "<b>" + UI.cardLink(r) + "</b> " + G.pct(r.pct), "/movers.html", "",
        wide ? rows.slice(0, 3).map(x => listRow("<b>" + UI.cardLink(x) + "</b> " + '<span class="muted">' + G.pct(x.pct) + "</span>",
          arrow(x.valueDelta) + G.money(Math.abs(x.valueDelta)), x.valueDelta >= 0 ? "up" : "down")) : null);
    } },
    { id: "selling", label: "Selling fast", full: true, wide: true, src: "selling", draw: wide => {
      const out = sellingTop(wide);
      // #366: your own listed cards flagged SELLING FAST, per printing, from
      // your stock's own sales (not the top-100-by-name match). Left out
      // until those sales are in, and while it's too early to compare.
      if (!source("soldMine").busy) {
        const n = G.listedSellingFast();
        if (n != null) out.foot = n > 0
          ? { href: "/inventory.html?fast=1&listed=1", html: UI.icon("trending-up") + " " + n.toLocaleString() + " of your listed cards " + (n === 1 ? "is" : "are") + " SELLING FAST" }
          : { html: "none of your listed cards is SELLING FAST" };
      }
      return out;
    } },
    { id: "targets", label: "Price targets hit", wide: true, draw: wide => {
      const n = watchHits.length;
      return tile(n.toLocaleString(), "Price targets hit", "",
        wide && n ? "" : n ? "watched cards past your target" : "no watched card is past its target", "/buy-list.html", n ? "gold" : "",
        wide && n ? watchHits.slice(0, 3).map(w => listRow("<b>" + UI.cardLink(w) + "</b>",
          (w.targetDir === "above" ? "≥ " : "≤ ") + G.money(w.target))) : null);
    } },
    { id: "nearlyFull", label: "Nearly full locations", wide: true, draw: wide => {
      const list = G.nearlyFullLocations(90);
      return tile(list.length.toLocaleString(), "Nearly full locations", "",
        wide && list.length ? "" : list.length ? "90% full or more" : "every location has room", "/locations.html", list.length ? "gold" : "",
        wide && list.length ? list.slice(0, 3).map(x => listRow("<b>" + G.esc(x.location.name) + "</b>",
          x.cards.toLocaleString() + "/" + x.cap.toLocaleString())) : null);
    } },
    // There's no "open" return: a return is recorded once it's back, so the
    // useful count is how many came back lately.
    { id: "returns", label: "Returns this month", full: true, draw: () => {
      const r = G.returnsSince(G.monthStartMs(Date.now()));
      return tile(r.returns.toLocaleString(), "Returns this month", "", plural(r.copies, "card") + " sent back", "/returns.html");
    } },
    { id: "wants", label: "Wantlist matches", full: true, draw: () => {
      const w = G.wantsInStock();
      return tile(w.wants.toLocaleString(), "Wantlist matches", "",
        w.wants ? "wanted cards in stock, for " + plural(w.customers, "customer") : "no customer wants a card you have", "/customers.html");
    } },
    { id: "trades", label: "Trades", src: "trades", draw: () => {
      const src = source("trades");
      if (src.busy || src.err) return pending(src, "Trades", "/trades.html");
      const d = src.data, n = d.offers + d.requests;
      return tile(n.toLocaleString(), "Trades", "",
        plural(d.offers, "trade offer") + ", " + plural(d.requests, "friend request") + " waiting for you",
        d.offers || !d.requests ? "/trades.html" : "/social.html", n ? "gold" : "");
    } },
    { id: "noCost", label: "Missing cost basis", full: true, draw: () => {
      const n = G.copiesWithoutCost(), all = s0().cards;
      return tile(n.toLocaleString(), "Missing cost basis", "",
        all ? Math.round((100 * n) / all) + "% of your copies have no cost" : "no cards yet", "/inventory.html");
    } },
    { id: "avgValue", label: "Average card value", draw: () => {
      const s = s0();
      return tile(s.pricedCards ? G.money(s.value / s.pricedCards) : "—", "Average card value", "", "market value per priced copy", "/stats.html");
    } }
  ];
  const TILE_BY_ID = new Map(TILES.map(t => [t.id, t]));
  // The Dashboard from before #298, in its order.
  const DEFAULT_TILES = ["cards", "value", "cost", "gain", "locations", "sealed", "listed", "picklist", "decklist",
    "watching", "overdue", "tickets", "queue"];
  const tileAllowed = t => !(t.full && G.simpleMode) && !(t.mod && !G.isModerator);
  const allowedIds = () => TILES.filter(tileAllowed).map(t => t.id);

  let editing = null;   // the working layout while Customize is open
  let dragId = null;
  const savedLayout = () => G.dashLayout(G.pref("dashTiles"), allowedIds(), DEFAULT_TILES);
  const layout = () => editing || savedLayout();

  function drawTile(t, spec, edit) {
    const def = TILE_BY_ID.get(t.id);
    const wide = !!(t.wide && def.wide);
    let inner = '<span class="big ' + (spec.cls || "") + '">' + spec.big + '</span><span class="lbl">' + spec.lbl + "</span>" +
      (spec.extra ? '<div class="faint" style="font-size:11.5px;margin-top:5px;line-height:1.5">' + spec.extra + "</div>" : "") +
      (wide && spec.list && spec.list.length ? '<div class="feed tile-list">' + spec.list.join("") + "</div>" : "");
    const cls = "tile " + (spec.accent || "") + (wide ? " wide" : "") + (edit ? " editing" : "");
    if (!edit) {
      // spec.foot (#366): a line under the tile with a link of its own,
      // outside the tile's link (a link can't hold another).
      const foot = spec.foot ? (spec.foot.href ? '<a class="tile-foot" href="' + spec.foot.href + '">' + spec.foot.html + "</a>"
        : '<div class="tile-foot faint">' + spec.foot.html + "</div>") : "";
      // A card name inside the tile is a link of its own (#423), and a link can't hold
      // another: the tile's link becomes a cover laid under the content.
      const covered = spec.href && inner.includes('class="card-link"');
      return '<div data-tile="' + t.id + '" class="' + cls + (covered ? " has-cardlinks" : "") + '">' +
        (covered ? '<a class="tile-cover" href="' + spec.href + '" aria-label="' + G.esc(String(spec.lbl).replace(/<[^>]*>/g, "")) + '"></a>' + inner
          : spec.href ? '<a href="' + spec.href + '">' + inner + "</a>" : inner) + foot + "</div>";
    }
    // Customizing: no link (a drag or a missed button mustn't leave the
    // page), and every control is a real button, so arrows work by keyboard
    // and on a phone, where dragging doesn't.
    const list = editing, i = list.findIndex(x => x.id === t.id);
    const name = G.esc(def.label);
    const btn = (act, icon, label, disabled) => '<button type="button" class="small ghost" data-act="' + act + '" data-id="' + t.id + '"' +
      ' title="' + label + '" aria-label="' + label + '"' + (disabled ? " disabled" : "") + ">" + UI.icon(icon) + "</button>";
    const controls = '<div class="tile-edit">' +
      '<span class="tile-grip" role="img" title="Drag to move" aria-label="Drag to move">' + UI.icon("grip-vertical") + "</span>" +
      btn("left", "arrow-left", "Move " + name + " earlier", i <= 0) +
      btn("right", "arrow-right", "Move " + name + " later", i >= list.length - 1) +
      (def.wide ? '<button type="button" class="small" data-act="wide" data-id="' + t.id + '" aria-pressed="' + wide + '">Wide</button>' : "") +
      btn("hide", "x", "Hide " + name) + "</div>";
    return '<div data-tile="' + t.id + '" class="' + cls + '" draggable="true">' + controls + inner + "</div>";
  }

  function renderTiles() {
    const edit = !!editing;
    let html = "";
    for (const t of layout()) {
      const def = TILE_BY_ID.get(t.id);
      let spec = def.draw(!!(t.wide && def.wide));
      if (!spec) {
        if (!edit) continue;
        spec = tile("—", G.esc(def.label), "", def.empty || "nothing to show right now");
      }
      html += drawTile(t, spec, edit);
    }
    $("tiles").innerHTML = html;
    G.paintPriceBasis($("tiles"));
    // #301: tile labels are Grimoire's own text (a tile is one big link, so these are preview-only). Not while customizing: tiles are drag handles then, and every Customize toggle redraws them, so no live link survives.
    if (UI.glossLink && !edit) $("tiles").querySelectorAll(".lbl").forEach(el => UI.glossLink(el));
    $("tiles").classList.toggle("editing", edit);
    renderTilesBar();
  }

  function renderTilesBar() {
    const bar = $("tilesBar");
    if (!editing) {
      bar.innerHTML = '<button type="button" class="small ghost" data-act="customize">' + UI.icon("layout-grid") + " Customize</button>";
      return;
    }
    const shown = new Set(editing.map(t => t.id));
    const hidden = TILES.filter(t => tileAllowed(t) && !shown.has(t.id));
    bar.innerHTML = '<div class="tiles-done"><span class="muted">Drag tiles or use the arrows to move them.</span>' +
      '<button type="button" data-act="reset">Reset</button>' +
      '<button type="button" class="primary" data-act="done">' + UI.icon("check") + " Done</button></div>" +
      '<div class="tiles-tray"><h3>Add a tile</h3>' +
      (hidden.length ? '<div class="tiles-add">' + hidden.map(t => '<button type="button" class="small" data-act="add" data-id="' + t.id + '">' +
        UI.icon("plus") + " " + G.esc(t.label) + "</button>").join("") + "</div>"
        : '<p class="muted">Every tile is on your Dashboard.</p>') + "</div>";
  }

  /* What Done saves: the working layout, plus any saved tile this mode or
     role can't show (a full-mode tile while in Simple mode), so switching
     back brings it back. Ids no longer in the catalog drop out. */
  function layoutToSave() {
    const shown = new Set(editing.map(t => t.id));
    const base = G.dashLayoutClean(G.pref("dashTiles")) || DEFAULT_TILES.map(id => ({ id }));
    const ok = new Set(allowedIds());
    const kept = base.filter(t => TILE_BY_ID.has(t.id) && !ok.has(t.id) && !shown.has(t.id));
    return editing.map(t => (t.wide ? { id: t.id, wide: true } : { id: t.id })).concat(kept);
  }

  function moveTile(id, to) {
    const i = editing.findIndex(t => t.id === id);
    if (i < 0 || to < 0 || to >= editing.length || to === i) return;
    const [t] = editing.splice(i, 1);
    editing.splice(to, 0, t);
  }

  async function tileAction(act, id) {
    if (act === "customize") {
      editing = layout().map(t => Object.assign({}, t));
      renderTiles();
      return;
    }
    if (!editing) return;
    const i = editing.findIndex(t => t.id === id);
    if (act === "left") moveTile(id, i - 1);
    else if (act === "right") moveTile(id, i + 1);
    else if (act === "hide" && i >= 0) editing.splice(i, 1);
    else if (act === "wide" && i >= 0) editing[i].wide = !editing[i].wide;
    else if (act === "add" && i < 0 && TILE_BY_ID.has(id)) editing.push({ id });
    else if (act === "done" || act === "reset") {
      if (act === "reset" && !(await UI.confirmDialog("Put your Dashboard tiles back to the standard set and order?",
        { title: "Reset your tiles?", okLabel: "Reset" }))) return;
      // setPersonalPrefs updates the pref at once and then saves, so the
      // redraw below already shows the new layout.
      const saving = G.setPersonalPrefs({ dashTiles: act === "reset" ? null : layoutToSave() });
      editing = null;
      renderTiles();
      try { await saving; }
      catch (e) { UI.toast("Couldn't save your tiles. Try Customize again.", "err"); }
      return;
    }
    renderTiles();
    refocus(act, id);
  }

  // A redraw replaces the buttons: keep the keyboard where it was.
  function refocus(act, id) {
    let el = null;
    if (act === "left" || act === "right" || act === "wide") {
      const tileEl = $("tiles").querySelector('[data-tile="' + id + '"]');
      el = tileEl && (tileEl.querySelector('[data-act="' + act + '"]:not([disabled])') ||
        tileEl.querySelector('[data-act="' + (act === "left" ? "right" : "left") + '"]:not([disabled])'));
    } else if (act === "add") {
      const tileEl = $("tiles").querySelector('[data-tile="' + id + '"]');
      el = tileEl && tileEl.querySelector('[data-act="hide"]');
    } else if (act === "hide") {
      el = $("tilesBar").querySelector('[data-act="add"][data-id="' + id + '"]');
    }
    if (el && el.focus) el.focus();
  }

  function wireTiles() {
    const onClick = e => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-act]") : null;
      if (!b || b.disabled) return;
      e.preventDefault();
      tileAction(b.dataset.act, b.dataset.id);
    };
    $("tiles").onclick = onClick;
    $("tilesBar").onclick = onClick;
    // Drag to move (a mouse). The drop lands before or after the tile under
    // the pointer, by which half of it the pointer is on.
    const box = $("tiles");
    const tileAt = e => (e.target && e.target.closest ? e.target.closest("[data-tile]") : null);
    box.addEventListener("dragstart", e => {
      const el = tileAt(e);
      if (!editing || !el) return;
      dragId = el.dataset.tile;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch (err) { /* old browsers */ }
      el.classList.add("dragging");
    });
    box.addEventListener("dragover", e => { if (dragId) e.preventDefault(); });
    box.addEventListener("drop", e => {
      if (!dragId) return;
      e.preventDefault();
      const el = tileAt(e);
      if (el && el.dataset.tile !== dragId) {
        const r = el.getBoundingClientRect();
        let to = editing.findIndex(t => t.id === el.dataset.tile);
        const from = editing.findIndex(t => t.id === dragId);
        if (e.clientX > r.left + r.width / 2) to++;
        if (from < to) to--;
        moveTile(dragId, to);
      }
      dragId = null;
      renderTiles();
    });
    box.addEventListener("dragend", () => { if (dragId) { dragId = null; renderTiles(); } });
  }

  /* Only asks the server when at least one watched card has a target - the
     common case (no targets) costs nothing. Same price source as Buy List's
     Now column (/api/prices/watch), so the two pages can't disagree. */
  async function loadWatchHits() {
    const items = G.state.watchList.filter(w => w.target != null);
    if (!items.length) { if (watchHits.length) { watchHits = []; renderAlerts(); } return; }
    try {
      const d = await G.api("/api/prices/watch", { method: "POST",
        body: { items: items.map(w => ({ set: w.set, collector: w.collector, lang: w.lang, finish: w.finish })), days: 30 } });
      const byKey = new Map((d.rows || []).map(r => [r.key + "|" + r.finish, r]));
      watchHits = items.filter(w => { const r = byKey.get(G.watchKey(w)); return r && G.watchTargetHit(w, r.now); });
    } catch (e) { watchHits = []; }
    renderAlerts();
    renderTiles();   // the Price targets hit tile (#298)
  }

  async function loadTicketInfo() {
    try {
      const mineRes = await G.api("/api/tickets");
      const open = mineRes.tickets.filter(t => t.status === "open" || t.status === "in-progress");
      // #177: a ticket is yours to answer only when someone else spoke last.
      // A ticket is "open" the moment you file it (and again when you reply),
      // so the status alone can't say whose turn it is.
      const mine = open.filter(t => {
        const last = Array.isArray(t.messages) && t.messages.length ? t.messages[t.messages.length - 1] : null;
        return !!last && last.from !== G.me.id;
      }).length;
      let queue = 0;
      if (G.isModerator) {
        const q = await G.api("/api/admin/tickets?status=open&pageSize=1");
        queue = q.total;
      }
      ticketInfo = { mine, waiting: open.length - mine, queue };
    } catch (e) { ticketInfo = null; }
    renderTiles();
    renderAlerts();   // the "tickets waiting on you" to-do (#299)
  }

  /* Callouts, not sections: something that wants attention must not look like
     just another panel of content. */
  function renderAlerts() {
    const out = [];
    const add = (tone, icon, head, body) => out.push({ tone, icon, head, body });

    if (!G.state.locations.length) {
      add("warn", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#map-pin></use></svg>", "Start with a location", 'Cards have to live somewhere. Create a binder or a box on the ' +
        '<a href="/locations.html">Locations</a> page, then ' + (G.simpleMode ? "add" : "receive") + ' cards into it.');
    } else if (!G.state.cards.length) {
      add("", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#download></use></svg>", "Nothing in inventory yet", 'Head to <a href="/receive.html">' + (G.simpleMode ? "Add cards" : "Receive") + '</a> — ' +
        "search for a card by name to add the ones you already own.");
    }
    // Customer wantlists (#50): a wanted card came in and the customer
    // hasn't been told yet. Names stay on the Customers page.
    const cameIn = G.customersWithUntold();
    if (cameIn) {
      add("warn", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#bell></use></svg>",
        cameIn + " customer" + (cameIn === 1 ? " wants a card" : "s want cards") + " that just came in",
        'Let them know, then mark them told. <a href="/customers.html?tab=came-in">View</a>');
    }
    // A tray with cards in it is unfinished work, and it is the most actionable
    // thing on this page - so it goes first.
    const waiting = G.stagingBins().filter(b => b.cards > 0);
    if (waiting.length) {
      add("warn", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#inbox></use></svg>", "Cards waiting to be filed",
        waiting.map(b => '<b>' + G.esc(b.name) + "</b> holds " + b.cards + " card" +
          (b.cards === 1 ? "" : "s") + ' (<a href="/putaway.html?bin=' + encodeURIComponent(b.id) +
          '">empty it</a>)').join("; ") + ".");
    }
    // More things to do (#299): each shows only above 0, with a link to the
    // page that fixes it, and reuses the data the tiles already hold (the
    // pick lists, the tickets and trades fetches). Simple mode hides the
    // pages marked full, so it gets no to-do pointing at them.
    const todo = (icon, count, text, href, link) => add("warn", UI.icon(icon), plural(count, text[0], text[1]) + text[2],
      '<a href="' + href + '">' + link + "</a>");
    if (!G.simpleMode) {
      const toShip = G.pickLists().filter(G.awaitsShip).length;
      if (toShip) todo("package", toShip, ["order", "orders", " picked, waiting to ship"], "/lists.html", "Open the pick lists");
      const overdue = overdueBinCount();
      if (overdue) todo("clipboard-list", overdue, ["location", "locations", " overdue for a count"], "/cycle-count.html", "Start a count");
      if (!cameIn) {   // the "customers want cards that came in" to-do above already says it
        const w = G.wantsInStock();
        if (w.wants) todo("heart", w.wants, ["wanted card", "wanted cards", " in stock for " + plural(w.customers, "customer")],
          "/customers.html", "See who wants them");
      }
      const unpriced = G.listedWithoutAsk();
      if (unpriced) todo("tag", unpriced, ["listing", "listings", " with no price to send"], "/listings.html", "Open Listings");
    }
    const lateLoans = G.allLoans().filter(x => x.overdue).length;
    if (lateLoans) todo("clock", lateLoans, ["loan", "loans", " past the give-back date"], "/inventory.html?lent=1", "See what's lent out");
    if (ticketInfo && ticketInfo.mine > 0) {
      todo("life-buoy", ticketInfo.mine, ["support ticket", "support tickets", " waiting on your reply"], "/help.html#support", "Open your tickets");
    }
    const trades = source("trades");
    if (!trades.busy && !trades.err && trades.data) {
      const d = trades.data;
      if (d.offers) todo("repeat", d.offers, ["trade offer", "trade offers", " waiting for your answer"], "/trades.html", "See the offers");
      if (d.requests) todo("users", d.requests, ["friend request", "friend requests", " waiting for you"], "/social.html", "See the requests");
    }
    // Simple mode hides Putaway and its settings (#177): nothing there could fix this.
    if (!G.simpleMode && G.state.locations.length && !G.state.locations.some(l => l.putaway && l.putaway.enabled && !l.staging)) {
      add("warn", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg>", "Putaway is not set up", 'No location has putaway switched on, so nothing can tell you ' +
        'where a card belongs. Open a location on the <a href="/locations.html">Locations</a> page, tick ' +
        '“Use this location for putaway”, and give it a rule or two.');
    }
    const over = G.state.locations.filter(l => G.locStats(l.id).over);
    if (over.length) {
      add("bad", UI.icon("triangle-alert"), "Over capacity", over.map(l => {
        const st = G.locStats(l.id);
        return "<b>" + G.esc(l.name) + "</b> holds " + st.cards + " against a ceiling of " + st.cap;
      }).join("; ") + ".");
    }
    const full = G.state.locations.filter(l => {
      const st = G.locStats(l.id);
      return st.cap != null && st.free === 0 && !st.over;
    });
    if (full.length) {
      add("warn", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#ban></use></svg>", "Full locations", full.length + " location" + (full.length === 1 ? " is" : "s are") +
        " at capacity and will not be suggested for putaway: " +
        full.map(l => "<b>" + G.esc(l.name) + "</b>").join(", ") + ".");
    }
    const noMeta = G.state.cards.filter(r => !r.typeLine).length;
    if (noMeta) {
      add("", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#refresh-cw></use></svg>", "Cards without card data", noMeta + (G.simpleMode ? " card" : " stack") + (noMeta === 1 ? "" : "s") +
        (G.simpleMode ? " have no type line, colours or oracle text, so searches cannot see them. Run " : " have no type line, colours or oracle text, so putaway rules and queries cannot see them. Run ") +
        '<b>Refresh prices &amp; data</b> on the <a href="/inventory.html">' + (G.simpleMode ? "My cards" : "Inventory") + '</a> page once.');
    }
    // Simple mode nudge: the tutorial already asks new signups this question
    // directly, but any account from before that shipped (or that skipped it)
    // never got asked at all, and would otherwise never learn a "just
    // tracking cards for myself" mode exists short of stumbling into
    // Settings. Dismissible and one-shot, not repeated once acknowledged.
    if (watchHits.length) {
      add("warn", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#bell></use></svg>", watchHits.length + " watched card" + (watchHits.length === 1 ? " has" : "s have") + " crossed your target",
        watchHits.slice(0, 6).map(w => "<b>" + UI.cardLink(w) + "</b> " + (w.targetDir === "above" ? "≥ " : "≤ ") + G.money(w.target)).join(" · ") +
        (watchHits.length > 6 ? " and " + (watchHits.length - 6) + " more" : "") +
        ' — see the <a href="/buy-list.html">' + (G.simpleMode ? "Price watch" : "Buy List") + '</a>.');
    }
    const steps = nextSteps();
    const showSteps = G.state.cards.length > 0 && G.pref("nextStepsDismissed") !== true && steps.some(s => !s.done);
    if (showSteps) {
      add("", UI.icon("list"), "Next steps <span class=\"faint\">" + steps.filter(s => s.done).length +
        " of " + steps.length + " done</span>",
        '<div class="feed steps">' + steps.map(s =>
          '<div class="feed-row' + (s.done ? " done" : "") + '"><span class="sico">' +
            UI.icon(s.done ? "circle-check" : s.icon) + '</span><span class="ftext">' + s.html + "</span>" +
            (s.done ? '<span class="fnum">Done</span>' : "") + "</div>").join("") +
        '</div><button class="small ghost" id="dismissNextSteps">Hide these</button>');
    }
    // Never for an organization member (#177): these flags live in the
    // Store's shared document, so one person's "Not now" would hide it for
    // every coworker, and a store's staff need the full set of pages anyway.
    let showSimpleNudge = false;
    const inOrg = !!(G.me && G.me.orgId);
    if (!inOrg && !G.simpleMode && !G.state.settings.tutorialSeen && !G.state.settings.simpleModeNudgeDismissed) {
      showSimpleNudge = true;
      add("", "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#compass></use></svg>", "Just tracking cards for yourself?",
        'If Locations, Putaway, Listings and the rest feel like more than you need, <a href="/settings.html">' +
        'Settings → Preferences</a> has a <b>Simple mode</b> that hides the power-seller tools and keeps just ' +
        'the everyday pages. <button class="small ghost" id="dismissSimpleNudge">Not now</button>');
    }
    $("secThingsToDo").hidden = !out.length;
    $("alerts").innerHTML = out.map(a =>
      '<div class="callout ' + a.tone + '"><span class="cico">' + a.icon + "</span>" +
      '<div class="cbody"><h3>' + a.head + "</h3>" + a.body + "</div></div>").join("");
    if (showSimpleNudge) {
      $("dismissSimpleNudge").onclick = () => {
        G.state.settings.simpleModeNudgeDismissed = true;
        G.persistSettings();
        renderAlerts();
      };
    }
    if (showSteps) {
      $("dismissNextSteps").onclick = () => {
        G.setPersonalPrefs({ nextStepsDismissed: true })
          .catch(() => UI.toast("Couldn't save that - the list may come back next time.", "err"));
        renderAlerts();
      };
    }
  }

  // "Check a price": pick a card by name (the Add cards autocomplete), then see
  // every printing's non-foil / foil / etched market price. Adds nothing.
  function wirePriceCheck() {
    const out = $("priceCheckOut");
    let seq = 0;
    async function show(name) {
      const mine = ++seq;
      out.innerHTML = '<p class="muted">Looking up prices…</p>';
      let list;
      try { list = await G.cards.printings(name); }
      catch (e) { if (mine === seq) out.innerHTML = '<p class="muted">Lookup failed: ' + G.esc(e.message) + "</p>"; return; }
      if (mine !== seq) return;
      const rows = G.sortPrintingsNewest(G.groupPrintings(list), g => G.englishOf(g)).map(G.englishOf);
      if (!rows.length) { out.innerHTML = '<p class="muted">No printings found for "' + G.esc(name) + '".</p>'; return; }
      const m = v => v != null ? G.money(v) : "—";
      out.innerHTML = '<h3 class="price-check-name">' + UI.cardNameLink(name) + "</h3>" +
        '<div class="price-check-scroll"><table class="price-check-tbl"><thead><tr><th>Printing</th><th class="num">Regular</th><th class="num">Foil</th><th class="num">Etched</th></tr></thead><tbody>' +
        rows.map(c => "<tr><td>" + UI.cardLink({ name, set: c.set, collector: c.collector, lang: c.lang, imageUrl: c.imageUrl }, c.setName || String(c.set || "").toUpperCase()) +
          ' <span class="muted">#' + G.esc(String(c.collector || "")) + "</span></td>" +
          '<td class="num">' + m(c.usd) + '</td><td class="num">' + m(c.usdFoil) + '</td><td class="num">' + m(c.usdEtched) + "</td></tr>").join("") +
        '</tbody></table></div><p class="hint">Near Mint market prices. Nothing was added to your collection.</p>';
    }
    UI.Autocomplete("priceCheckSearch", "priceCheckAc", show);
    $("priceCheckSearch").addEventListener("input", () => { seq++; out.innerHTML = ""; });
  }

  UI.boot(async function () {
    wirePriceCheck();
    // #244: "Welcome back" only for someone who has been here before: an
    // earlier visit in this browser, or an account over a day old (a new
    // device). A brand-new account's first visit is just "Welcome".
    const visit = noteVisit(Date.now());
    const made = Date.parse(G.me && G.me.createdAt);
    const back = !!visit.prevAt || !(Date.now() - made < 86400000);
    $("hello").textContent = (back ? "Welcome back, " : "Welcome, ") + ((G.me && (G.me.displayName || G.me.username)) || "");
    loadSinceLast(visit);
    // Plain buttons, not buttons inside links (#177): UI.go saves first.
    $("goReceive").onclick = () => UI.go("/receive.html");
    $("linkPutaway").onclick = () => UI.go("/putaway.html");
    $("goInventory").onclick = () => UI.go("/inventory.html");
    wireTiles();
    loadTicketInfo();
    loadWatchHits();
    if (G.simpleMode) {
      $("linkPutaway").hidden = true;
      // #325: the same plain page names on the Dashboard buttons.
      const gr = $("goReceive").lastChild; if (gr) gr.nodeValue = " Add cards";
      $("goInventory").textContent = "Browse my cards";
      const draw = () => { renderTiles(); renderAlerts(); };
      G.on("change", draw);
      draw();
      return;
    }
    const draw = () => { renderTiles(); renderAlerts(); };
    G.on("change", draw);
    draw();
  });
})();
