/* Grimoire v0.08 - shared UI.
   ==============================================================
   The chrome every page wears (header, nav, save indicator, toast, lightbox),
   the modal plumbing, the card preview panel, the inventory grid with its
   Manage dialog, and the query builder.

   Splitting one page into nine meant this had to become a component library or
   the nine pages would each grow their own slightly-different copy of the grid. */
"use strict";

window.UI = (function () {
  const G = window.G;
  const $ = id => document.getElementById(id);
  const esc = G.esc;
  const money = G.money;
  const pct = G.pct;
  // The one place a finish becomes a badge - every grid/table that shows a
  // stack's finish (WMS grid, Storefront grid, and anywhere else that grows
  // one later) calls this instead of hand-rolling FOIL/ETCHED markup itself.
  const finishBadge = finish => finish === "etched" ? '<span class="badge etched">ETCHED</span>'
    : finish === "foil" ? '<span class="badge foil">FOIL</span>' : '<span class="badge non">—</span>';

  /* ============================== Chrome ============================== */
  // Dashboard stands alone at the top (the landing page, no group fits it).
  // Everything else sits in a labeled, foldable bucket by what it's
  // actually for: Receive/Putaway/Locations are "get cards into the right
  // place", Inventory/Cycle Count are "know what you actually have",
  // Selling is pricing/moving stock to a buyer specifically, Social is
  // anything that involves somebody else's collection (friends, trades,
  // decks you might show off), Reports is look-back/analysis that isn't
  // itself a selling action, and Account is the always-there-but-rarely-
  // clicked account/support pages. Re-bucketed 2026-09-17: Buy List, Trade
  // Proposals, Statistics, Accounting and Movers used to all sit under
  // Selling by default even though most of them aren't actually about
  // selling - direct ask, "these don't intrinsically have to do with
  // selling."
  const NAV_DASHBOARD = { href: "/index.html", label: "Dashboard", match: ["/", "/index.html"] };
  const NAV_WAREHOUSE = [
    { href: "/receive.html", label: "Receive", match: ["/receive.html"] },
    { href: "/putaway.html", label: "Putaway", match: ["/putaway.html"] },
    { href: "/locations.html", label: "Locations", match: ["/locations.html"] }
  ];
  const NAV_STOCK = [
    { href: "/inventory.html", label: "Card Inventory", match: ["/inventory.html"] },
    { href: "/sealed.html", label: "Sealed", match: ["/sealed.html"] },
    { href: "/cycle-count.html", label: "Cycle Count", match: ["/cycle-count.html"] },
    { href: "/audit-log.html", label: "Audit Log", match: ["/audit-log.html"] }
  ];
  /* #402: orders that don't come from Manapool, one page per source; every
     one becomes a pick ticket on Order Fulfillment. Kiosk (#433) is where a
     Manager sets up the store's kiosk, so only they see it (below). */
  const NAV_ORDER_ENTRY = [
    { href: "/walk-in.html", label: "Walk-in Order", match: ["/walk-in.html"] },
    { href: "/kiosk-setup.html", label: "Kiosk", match: ["/kiosk-setup.html"] }
  ];
  const NAV_SELLING = [
    { href: "/listings.html", label: "Listings", match: ["/listings.html"] },
    { href: "/lists.html", label: "Order Fulfillment", match: ["/lists.html"] },
    { href: "/returns.html", label: "Returns", match: ["/returns.html"] },
    { href: "/customers.html", label: "Customers", match: ["/customers.html"] }
  ];
  const NAV_SOCIAL = [
    { href: "/social.html", label: "Social", match: ["/social.html"] },
    { href: "/trades.html", label: "Trade Proposals", match: ["/trades.html"] },
    { href: "/buy-list.html", label: "Buy List", match: ["/buy-list.html"] },
    { href: "/deck-list.html", label: "Deck List", match: ["/deck-list.html"] }
  ];
  const NAV_REPORTS = [
    { href: "/stats.html", label: "Statistics", match: ["/stats.html"] },
    { href: "/accounting.html", label: "Accounting", match: ["/accounting.html"] },
    { href: "/movers.html", label: "Movers", match: ["/movers.html"] }
  ];
  const NAV_ACCOUNT = [
    { href: "/help.html", label: "Help & Support", match: ["/help.html"] },
    { href: "/settings.html", label: "Settings", match: ["/settings.html"] }
  ];
  // Simple mode removes exactly these hrefs (see the "loaded" listener
  // below) rather than any whole bucket - Warehouse keeps Receive, Stock
  // keeps Inventory, and Social/Reports keep Buy List/Social/Statistics
  // (casual-collector things, not power-seller ones) even though the rest
  // of each bucket goes.
  // #325: Simple mode's plainer menu names (full mode keeps the labels above).
  const NAV_SIMPLE_LABELS = {
    "/receive.html": "Add cards",
    "/inventory.html": "My cards",
    "/buy-list.html": "Price watch"
  };
  const NAV_ADVANCED_ONLY = [
    "/sealed.html", "/putaway.html", "/cycle-count.html",
    "/listings.html", "/movers.html", "/lists.html", "/returns.html",
    "/audit-log.html", "/accounting.html", "/customers.html", "/walk-in.html", "/kiosk-setup.html"
  ];
  // Added to #accountNavWrap after G.load() resolves (see the "loaded"
  // listener below) - whether it belongs there depends on G.isModerator,
  // which is unknown at mountChrome() time, before the collection/auth
  // round trip completes.
  const NAV_ADMIN = { href: "/admin.html", label: "Admin", match: ["/admin.html"] };
  // Injected into #accountNavWrap unconditionally (every account, not
  // gated on already being in an org) - org.html itself handles both the
  // "not in one yet" and "already a member" states. BACKLOG.md #9.
  const NAV_ORG = { href: "/org.html", label: "Organization", match: ["/org.html"] };

  // Bucket fold state is per-browser, not per-collection - a plain
  // localStorage set of pinned-open bucket ids, read fresh on every page
  // (this is a multi-page app; each navigation rebuilds the sidebar from
  // scratch via mountChrome(), so nothing survives in memory between pages).
  // Buckets are collapsed by default (see mountChrome()) - hovering a
  // collapsed one reveals its links via CSS alone (:hover, app.css) without
  // touching this at all; clicking a bucket's header *pins* it open (or
  // un-pins it), which is what actually gets persisted here.
  const NAV_PINNED_KEY = "grimoireNavPinned";
  function loadNavPinned() {
    try { return new Set(JSON.parse(localStorage.getItem(NAV_PINNED_KEY) || "[]")); }
    catch (e) { return new Set(); }
  }
  function saveNavPinned(id, pinned) {
    try {
      const set = loadNavPinned();
      if (pinned) set.add(id); else set.delete(id);
      localStorage.setItem(NAV_PINNED_KEY, JSON.stringify([...set]));
    } catch (e) { /* private-browsing/quota - pin state just won't stick */ }
  }
  /* #244: a new account's menu starts with every bucket open, so a newcomer
     sees the page names instead of six headings. "New" means made on or
     after this shipped, and only in a browser with no saved pin state yet:
     everyone else's collapsed/pinned buckets stay exactly as they were. The
     opened set is saved as pins, so clicking a heading closes it as usual. */
  const NAV_OPEN_FOR_ACCOUNTS_FROM = Date.parse("2026-10-16T00:00:00Z");
  function openNavForNewAccount(u) {
    try { if (localStorage.getItem(NAV_PINNED_KEY) !== null) return; } catch (e) { return; }
    if (!u || !(Date.parse(u.createdAt) >= NAV_OPEN_FOR_ACCOUNTS_FROM)) return;
    const ids = [];
    $("appNav").querySelectorAll(".nav-group").forEach(group => {
      ids.push(group.id);
      group.classList.remove("collapsed");
      group.querySelector(".side-label").setAttribute("aria-expanded", "true");
    });
    try { localStorage.setItem(NAV_PINNED_KEY, JSON.stringify(ids)); } catch (e) { /* won't stick */ }
  }

  /* The header's price ticker - reuses the same /api/prices/movers data
     the Dashboard and Movers page already fetch (days=1: the latest daily
     snapshot vs. the one before it, i.e. "today"), scoped to what the
     signed-in account actually holds, same as everywhere else that endpoint
     is used. Two flags keep this cheap enough to call on every page load
     (unlike the Dashboard/Movers page, which call it once per visit):
     ownedOnly=1 skips the endpoint's full-catalog sweep (hundreds of
     thousands of Scryfall printings, there so someone can spot a card worth
     buying that they don't already own - irrelevant to a ticker that only
     ever shows owned rows), and skipMA=1 skips its per-row moving-average
     computation (a trailing SMA over up to 200 points, twice, for every
     owned row - real cost across a few thousand owned printings, and
     nothing the ticker displays anyway). Together these took a ~10s fetch
     down to well under a second on a 4,000-printing collection. Fetched
     once per page load, not re-polled - a ticker of "today's" movement
     doesn't need to update mid-visit. #priceTicker itself is the header's
     flex spacer (see mountChrome()) whether or not this ever fills it in,
     so an early return just leaves an empty spacer instead of a broken-
     looking half-built ticker - a brief "Loading…" state covers the gap
     while the fetch is still in flight either way. */
  async function loadTicker() {
    if (G.simpleMode) return;
    const box = $("priceTicker");
    if (!box) return;
    box.innerHTML = '<span class="ticker-label">Today</span><span class="ticker-loading">Loading…</span>';
    let d;
    // top=16: the server picks the 16 rows shown below and caches that per
    // account per snapshot date, instead of sending every owned row on every
    // page view (#113).
    try { d = await G.api("/api/prices/movers?days=1&ownedOnly=1&skipMA=1&top=16"); }
    catch (e) { box.innerHTML = ""; return; }
    if (!d || d.error || !Array.isArray(d.rows)) { box.innerHTML = ""; return; }
    const rows = d.rows
      .filter(r => r.qty > 0 && r.delta != null && Math.abs(r.valueDelta || 0) >= 0.01)
      .sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta))
      .slice(0, 16);
    if (!rows.length) { box.innerHTML = ""; return; }
    // tabindex on the "real" copy only, so a keyboard user can focus an
    // item to pause the scroll (see .ticker-track:has(:focus-visible) in
    // app.css) the same way hovering it with a mouse does - not just
    // decorative, it's what makes auto-scrolling content actually readable
    // without a mouse. The visual-only duplicate copy below is neither
    // focusable nor announced, so tabbing/screen-reader nav sees each card
    // once, not twice.
    const item = (r, live) => {
      const dir = r.delta > 0 ? "up" : "down";
      const title = esc(r.name) + ": " + money(r.then) + " → " + money(r.now);
      const mark = r.finish === "etched" ? " ✧" : r.finish === "foil" ? " ✦" : "";
      return '<span class="ticker-item ' + dir + '"' + (live ? ' tabindex="0"' : "") +
        ' title="' + title + '">' +
        cardLink(r) + mark + " " +
        '<b>' + (r.delta > 0 ? "▲" : "▼") + " " + money(Math.abs(r.delta)) + '</b>' +
        " (" + pct(r.pct) + ")" +
        "</span>";
    };
    // Two back-to-back copies of the same sequence, scrolled exactly one
    // copy-width via CSS animation (see .ticker-track in app.css) - the
    // loop point is invisible because copy 2 is pixel-identical to copy 1.
    // display:contents on the duplicate's wrapper keeps it out of the flex
    // layout (its spans lay out as if they were direct .ticker-track
    // children) while aria-hidden pulls the whole copy out of the a11y tree.
    const html = rows.map(r => item(r, true)).join("");
    const dupe = '<span aria-hidden="true" style="display:contents">' +
      rows.map(r => item(r, false)).join("") + "</span>";
    box.innerHTML =
      '<span class="ticker-label">Today</span>' +
      '<div class="ticker-viewport"><div class="ticker-track">' + html + dupe + '</div></div>';
  }

  /* The sidebar's store-switcher (BACKLOG.md #9) - only meaningful for an
     org account that can reach more than one Store; hidden (see the plain
     [hidden] markup mountChrome() writes) for every personal account and
     for a single-store org member, since there's no actual choice to make.
     Switching triggers a full page reload rather than trying to make every
     open page re-render live against the new store - the same "just
     reload" approach the header's restart-countdown already takes for a
     bigger version of the same problem (the whole app's data changed out
     from under this page). */
  /* A store switch holds this page's saves for good: the page is about to
     reload into the other store. If the browser restores it from its back/
     forward cache instead (Back after the switch), it would come back frozen
     with saves held and showing the old store (#146). core.js now reloads
     every page restored from that cache (#433), which covers this too. */
  function holdForStoreSwitch(on) {
    G.holdSaves(on);
  }
  async function loadStoreSwitcher() {
    let d;
    try { d = await G.api("/api/orgs/mine"); } catch (e) { return; }
    const ids = d.accessibleStoreIds || [];
    if (ids.length < 2) return; // nothing to switch between
    const box = $("storeSwitcher"), select = $("storeSwitcherSelect");
    const byId = new Map((d.stores || []).map(s => [s.id, s]));
    select.innerHTML = ids.map(id => {
      const s = byId.get(id);
      return '<option value="' + id + '">' + esc((s && s.name) || id) + '</option>';
    }).join("");
    if (d.activeStoreId) select.value = d.activeStoreId;
    box.hidden = false;
    // Saves first and holds saves during the switch, the way the bell does
    // (#145): a save names no store, so one landing after the switch would
    // go into the other store.
    select.onchange = async () => {
      const storeId = select.value;
      const from = d.activeStoreId;
      const putBack = () => { select.disabled = false; if (from) select.value = from; };
      select.disabled = true;
      if (!(await G.saveAll(LEAVE_SAVE_MS))) {
        notSavedToast("the store wasn't switched");
        putBack();
        return;
      }
      holdForStoreSwitch(true);
      try { await G.api("/api/store/switch", { method: "POST", body: { storeId } }); }
      catch (e) {
        holdForStoreSwitch(false);
        toast("Could not switch stores: " + e.message, "err");
        putBack();
        return;
      }
      if (G.hasUnsaved()) {
        // Something changed on this page during the switch. Put the session
        // back so it saves where it belongs, and stay.
        const back = from
          ? await G.api("/api/store/switch", { method: "POST", body: { storeId: from } }).then(() => true, () => false)
          : false;
        if (back) {
          holdForStoreSwitch(false);
          toast("Something changed on this page while switching, so you're still in this store. Pick the store again.", "err");
          putBack();
        } else {
          toast("Something changed on this page while switching stores. Reload the page before making more changes.", "err");
        }
        return;
      }
      location.reload();
    };
  }

  /* ============================== Leaving the page (#174) ==============================
     docs/flows/save-before-leave.dot. A link to another page, a button that
     opens one (UI.go), the store switcher and Sign out all wait for
     G.saveAll() before leaving, so the browser never has to be asked to
     carry a save out of a page that is going away. While it saves, the save
     indicator says "saving…" and a toast says why the page hasn't changed
     yet. A save that fails keeps you on the page and says so; the browser's
     own "Leave site?" prompt still covers closing, reloading and Back. */
  const LEAVE_SAVE_MS = 10000;
  let leaveRun = null, leaveTo = null;
  /* The server refused this page's save because the session has moved to
     another store since the page loaded (#145, e.g. switched in another
     tab). Not the conflict prompt: there is nothing to overwrite, and
     overwriting would put this store's inventory into the other one. The
     page stops saving (core.js) and offers a reload, which shows the store
     the session is in now. */
  let wrongOwnerMsg = "";
  function wrongOwnerToast() {
    toast(wrongOwnerMsg || "This tab was showing a different store. Reload to continue.", "err",
      "Reloading shows the store you're working in now.");
    const btn = document.createElement("button");
    btn.textContent = "Reload";
    btn.className = "small";
    btn.onclick = () => { G.leaveWithoutSaving(); location.reload(); };
    $("toastDetail").appendChild(document.createElement("br"));
    $("toastDetail").appendChild(btn);
  }
  function notSavedToast(what) {
    const s = G.saveState();
    // A conflict already has its own toast, with "Keep mine": keep it showing.
    if (s.conflict) return;
    // This page can't save at all any more (#145): say why again.
    if (s.wrongOwner) { wrongOwnerToast(); return; }
    toast("Your latest changes haven't saved yet" + (s.error ? " (" + s.error + ")" : "") + ", so " + what +
      ". Try again once the header says Saved, or reload the page to drop them.", "err");
  }
  // Opens url once everything on this page has saved. Resolves true when it
  // is on its way. A second call while saving changes where it goes.
  function go(url) {
    leaveTo = url;
    if (leaveRun) return leaveRun;
    if (!G.hasUnsaved()) { location.href = url; return Promise.resolve(true); }
    toast("Saving your changes before leaving this page…", "work");
    leaveRun = G.saveAll(LEAVE_SAVE_MS).then(ok => {
      leaveRun = null;
      if (!ok) { notSavedToast("you're still on this page"); return false; }
      hideToast();
      location.href = leaveTo;
      return true;
    });
    return leaveRun;
  }
  // The address a plain click on this element would open in this tab, if
  // that is another page of this app; null for anything else (a new tab or
  // window, a download, a #section of this page, another site).
  function inAppLink(e) {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
    const a = e.target && typeof e.target.closest === "function" ? e.target.closest("a[href]") : null;
    // An SVG <a> has an object for href and target; leave those alone.
    if (!a || typeof a.href !== "string" || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
    let url;
    try { url = new URL(a.href, location.href); } catch (err) { return null; }
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return null;
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return null;
    return url.href;
  }

  // The original book mark, recoloured for the 2026-10-08 restyle: graphite
  // cover and the orange signal colour where it used to be purple and gold.
  // Mirrors the favicon data: URI in every page's <head> and icons/icon-*.png.
  const LOGO = '<svg class="logo" viewBox="0 0 32 32" role="img" aria-label="Grimoire">' +
    '<rect x="9" y="5" width="18" height="22" rx="1" fill="#d9d7cf"/>' +
    '<rect x="5.5" y="4" width="19" height="24" rx="1.5" fill="#1d1e21" stroke="#f26b1d" stroke-width="1.5"/>' +
    '<path d="M10.2 4.9v22.2" stroke="#f26b1d" stroke-width="1.2" opacity=".75"/>' +
    '<path d="M17.4 11.2 20.8 16l-3.4 4.8L14 16z" fill="#f26b1d"/>' +
    '<path d="M17.4 22.7v1.6" stroke="#f26b1d" stroke-width="1.2" opacity=".8"/></svg>';

  function mountChrome() {
    const here = location.pathname;
    // <main> already exists in every page's static HTML - relocated into
    // #appMain below (alongside the sticky banner/header) rather than
    // rebuilt, the same "move what's already there" approach the toast/
    // lightbox block below takes for its own markup.
    const existingMain = document.querySelector("main");
    // title= carries the full label for the rare case a link's own CSS
    // truncates it with an ellipsis (app.css, .side-nav a) instead of
    // wrapping onto a second line.
    const navLink = n => '<a href="' + n.href + '" title="' + esc(n.label) + '"' + (n.match.includes(here) ? ' class="here"' : '') + '>' + esc(n.label) + '</a>';
    // A bucket header is a real <button> (not just styled text) so the fold
    // is keyboard- and screen-reader-operable, not just clickable. Initial
    // aria-expanded/collapsed state gets corrected right after insertion
    // below, once localStorage + "does this bucket hold the current page"
    // are both known.
    const navGroup = (id, label, items) =>
      '<div class="nav-group" id="' + id + '">' +
        '<button type="button" class="side-label" aria-expanded="true">' +
          esc(label) + '<span class="fold" aria-hidden="true"></span>' +
        '</button>' +
        '<div class="nav-links">' + items.map(navLink).join("") + '</div>' +
      '</div>';

    // The sidebar is the one persistent piece of chrome that isn't inside
    // #appMain's sticky column - it's a flex sibling of it (see body{} in
    // app.css), pinned to the viewport on its own so a long page's scroll
    // never carries the nav away.
    const sidebar = document.createElement("aside");
    sidebar.id = "appSidebar";
    sidebar.setAttribute("aria-label", "Sidebar");
    sidebar.innerHTML =
      '<a class="brand" href="/index.html">' + LOGO + 'Grimoire</a>' +
      // Hidden until the "loaded" listener below knows whether this account
      // is an org member with more than one Store to choose from
      // (BACKLOG.md #9) - most accounts never see this at all.
      '<div class="store-switcher" id="storeSwitcher" hidden>' +
        '<label>Store<select id="storeSwitcherSelect"></select></label>' +
      '</div>' +
      '<nav class="side-nav" id="appNav" aria-label="Main">' +
        // #250: a bold gold external link above Dashboard. Not a navLink(), so it
        // never gets the "current page" highlight; always shown (Simple and full).
        '<a class="support-link" href="https://buymeacoffee.com/bmowens99x" target="_blank" rel="noopener" title="Support Grimoire (opens in a new tab)">' +
          '<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#heart></use></svg> Support Grimoire</a>' +
        navLink(NAV_DASHBOARD) +
        // #386: Warehouse Mode is a separate app at /rf/, always shown, never "here".
        '<a class="rf-link" href="/rf/" title="Warehouse Mode: the RF menu for working on the floor">' +
          '<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#qr-code></use></svg> Warehouse Mode</a>' +
        navGroup("whNavWrap", "Warehouse", NAV_WAREHOUSE) +
        navGroup("stockNavWrap", "Stock", NAV_STOCK) +
        navGroup("orderEntryNavWrap", "Order Entry", NAV_ORDER_ENTRY) +
        navGroup("sellNavWrap", "Selling", NAV_SELLING) +
        navGroup("socialNavWrap", "Social", NAV_SOCIAL) +
        navGroup("reportsNavWrap", "Reports", NAV_REPORTS) +
        // Not just navGroup(...) - the profile block (username + sign out,
        // moved here from the header's top-right) sits inside this bucket
        // too, below the Admin link that gets appended between Settings and
        // it (see the "loaded" listener's insertBefore below).
        '<div class="nav-group" id="accountNavWrap">' +
          '<button type="button" class="side-label" aria-expanded="true">Account' +
            '<span class="fold" aria-hidden="true"></span></button>' +
          '<div class="nav-links">' +
            NAV_ACCOUNT.map(navLink).join("") +
            '<div class="side-profile">' +
              '<span class="side-profile-name" id="whoami"></span>' +
              '<button type="button" id="btnSignOut" class="side-profile-signout">Sign out</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</nav>';

    // Buckets are collapsed by default - hovering one open (app.css) is the
    // normal way to see its links without permanently changing anything.
    // Two things force a bucket open on load instead: it's been pinned open
    // by an earlier click (persisted below), or it holds the page you're
    // currently on, which always opens regardless of pin state so
    // navigating somewhere never hides your own location in the nav.
    const pinnedIds = loadNavPinned();
    sidebar.querySelectorAll(".nav-group").forEach(group => {
      const open = pinnedIds.has(group.id) || group.querySelector("a.here");
      group.classList.toggle("collapsed", !open);
      group.querySelector(".side-label").setAttribute("aria-expanded", open ? "true" : "false");
    });
    sidebar.querySelectorAll(".side-label").forEach(btn => {
      btn.onclick = () => {
        const group = btn.closest(".nav-group");
        const collapsed = group.classList.toggle("collapsed");
        btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
        saveNavPinned(group.id, !collapsed);
      };
    });

    const backdrop = document.createElement("div");
    backdrop.id = "sidebarBackdrop";
    backdrop.hidden = true;

    // banner + header stick together as one unit (sticky on the wrapper, not
    // on each separately - two independent top:0 sticky siblings overlap
    // instead of stacking once the page is scrolled far enough).
    const chromeSticky = document.createElement("div");
    chromeSticky.id = "chromeSticky";

    const banner = document.createElement("div");
    banner.id = "restartBanner";
    banner.className = "restart-banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;
    banner.innerHTML = '<span id="restartBannerMsg"></span>';
    chromeSticky.appendChild(banner);

    const loading = document.createElement("div");
    loading.id = "pageLoading";
    loading.className = "page-loading";
    loading.innerHTML = '<div class="loading-mark" aria-hidden="true">' + LOGO + '</div><span>Loading…</span>';
    document.body.insertBefore(loading, document.body.firstChild);

    // Slim utility bar - navigation itself lives in the sidebar now. The
    // brand mark here only shows at phone width, where the sidebar is an
    // off-canvas drawer rather than a permanent column, so the header would
    // otherwise look nav-less with the drawer closed. #priceTicker is the
    // flexible spacer that pushes chrome-right to the far edge, same job
    // .spacer used to do - loadTicker() (called once G.load() resolves)
    // fills it with the scrolling price strip when there's data to show,
    // but even empty it still fills that space, so nothing else needs to.
    const header = document.createElement("header");
    header.className = "app";
    header.innerHTML =
      '<button id="navToggle" class="nav-toggle" aria-label="Menu" aria-expanded="false">☰</button>' +
      '<a class="brand mobile-brand" href="/index.html">' + LOGO + 'Grimoire</a>' +
      '<div class="ticker" id="priceTicker"></div>' +
      '<div class="chrome-right">' +
        '<span id="saveState"><span class="dot" id="saveDot"></span><span id="saveText">loading…</span></span>' +
        '<button id="btnUndo" disabled title="Undo (Ctrl+Z)">↶ Undo<span class="ulabel" id="undoLabel"></span></button>' +
        '<button id="btnRedo" disabled title="Redo (Ctrl+Y)">↷ Redo</button>' +
        // #139: the notification bell. Its count and list come from
        // /api/notifications (see "Notifications" below).
        '<div class="menu-wrap notif-wrap">' +
          '<button type="button" id="btnNotif" class="notif-btn" title="Notifications" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">' +
            '<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#bell></use></svg>' +
            '<span class="notif-count" id="notifCount" hidden></span></button>' +
          '<div class="menu notif-menu" id="notifMenu" role="dialog" aria-label="Notifications" hidden>' +
            '<div class="notif-head"><span class="notif-title">Notifications</span>' +
              '<button type="button" class="small ghost" id="notifAllRead">Mark all read</button></div>' +
            '<div class="notif-list" id="notifList"></div>' +
            '<div class="notif-foot"><a href="/settings.html#notifications">Choose what you hear about</a></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    chromeSticky.appendChild(header);

    const appMain = document.createElement("div");
    appMain.id = "appMain";
    appMain.appendChild(chromeSticky);
    if (existingMain) appMain.appendChild(existingMain);

    // Skip link (#247): first Tab stop on every page; moves focus into <main>
    // so keyboard users skip the whole sidebar. Hidden until focused (app.css).
    if (existingMain) {
      if (!existingMain.id) existingMain.id = "main";
      existingMain.setAttribute("tabindex", "-1");
      const skip = document.createElement("a");
      skip.className = "skip-link";
      skip.href = "#" + existingMain.id;
      skip.textContent = "Skip to content";
      skip.addEventListener("click", e => {
        e.preventDefault();
        existingMain.focus();
        existingMain.scrollIntoView();
      });
      document.body.insertBefore(skip, document.body.firstChild);
    }

    document.body.appendChild(sidebar);
    document.body.appendChild(backdrop);
    document.body.appendChild(appMain);

    const extra = document.createElement("div");
    extra.innerHTML =
      '<div class="toast" id="toast" role="status" aria-live="polite" hidden>' +
        '<span class="ticon" id="toastIcon" aria-hidden="true"></span>' +
        '<div class="tbody"><div id="toastMsg"></div>' +
          '<div class="tprog" id="toastProg" hidden><div id="toastProgText"></div>' +
            '<div class="tbar" id="toastBar" role="progressbar" aria-label="Progress"><i></i></div></div>' +
          '<details id="toastDetails" hidden><summary>Details</summary><div id="toastDetail"></div></details>' +
        '</div><button id="toastClose" title="Dismiss" aria-label="Dismiss">✕</button></div>' +
      '<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Full-size card image" hidden>' +
        '<button class="lbclose" id="lightboxClose" title="Close" aria-label="Close">✕</button>' +
        '<img id="lightboxImg" src="" alt=""></div>';
    while (extra.firstChild) document.body.appendChild(extra.firstChild);

    $("toastClose").onclick = hideToast;
    $("lightbox").addEventListener("click", () => hideModal("lightbox"));
    $("lightboxClose").onclick = e => { e.stopPropagation(); hideModal("lightbox"); };
    $("btnUndo").onclick = () => { const l = G.undo(); if (l) toast("Undone: " + l + ". Redo puts it back.", "ok"); };
    $("btnRedo").onclick = () => { const l = G.redo(); if (l) toast("Redone: " + l + ".", "ok"); };
    // At phone width the sidebar is an off-canvas drawer (see the
    // max-width:760px block in app.css) - the hamburger and the backdrop
    // both just toggle it open/closed. Above that width #appSidebar is
    // always visible and none of this ever fires (navToggle is display:none).
    const closeSidebar = () => {
      $("appSidebar").classList.remove("open");
      $("sidebarBackdrop").hidden = true;
      $("navToggle").setAttribute("aria-expanded", "false");
    };
    $("navToggle").onclick = () => {
      const open = $("appSidebar").classList.toggle("open");
      $("sidebarBackdrop").hidden = !open;
      $("navToggle").setAttribute("aria-expanded", open ? "true" : "false");
    };
    $("sidebarBackdrop").onclick = closeSidebar;
    $("appSidebar").addEventListener("click", e => {
      if (e.target.tagName === "A") closeSidebar();
    });

    // Every page runs mountChrome() via UI.boot(), so this is the one place
    // that needs to register it - no per-page wiring required.
    if ("serviceWorker" in navigator) {
      // updateViaCache: "none" - sw.js is fetched directly (no ?v= query
      // string the way HTML/manifest references get rewritten with, since
      // there's no HTML tag pointing at it for serveHtml() to rewrite), so
      // without this the browser's own HTTP cache (and Cloudflare's ~4h
      // edge cache in front of it) could serve a stale service worker file
      // for hours after a real deploy (BACKLOG.md #52). Paired with a
      // Cache-Control: no-store response specifically for this one route
      // (server/lib/http.js) so neither layer holds onto a stale copy.
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
    }

    startRestartWatch();
    startNotifications();
    // Keeps "last active"/"online now" fresh on the admin dashboard even
    // while this tab sits open and idle with no other API traffic.
    setInterval(() => { G.api("/api/heartbeat", { method: "POST" }).catch(() => {}); }, 2 * 60 * 1000);
    // saveAll, not saveNow: saveNow never rejects, so this confirm could
    // never appear (#176).
    $("btnSignOut").onclick = async () => {
      if (!(await G.saveAll(LEAVE_SAVE_MS))) {
        const err = G.saveState().error;
        const ok = await confirmDialog(
          "Your last change hasn't saved yet" + (err ? " (" + err + ")" : "") +
          ". Sign out anyway? Unsaved work will be lost.",
          { title: "Not saved", danger: true, okLabel: "Sign out anyway" });
        if (!ok) return;
        G.leaveWithoutSaving();
      }
      await G.api("/api/auth/logout", { method: "POST" }).catch(() => {});
      location.href = "/login.html";
    };
    // A link to another page of the app waits for the save (#174). With
    // nothing unsaved the browser follows it as usual.
    document.addEventListener("click", e => {
      const url = inAppLink(e);
      if (!url || !G.hasUnsaved()) return;
      e.preventDefault();
      go(url);
    });

    G.on("savestate", renderSaveState);
    G.on("undo", renderUndo);
    G.on("loaded", () => {
      const u = G.me;
      $("whoami").textContent = u ? (u.displayName || u.username) : "";
      renderUndo(G.undoInfo());
      // Setting up the kiosk is a Manager's or Owner's (#433; the server refuses anyone else).
      if (!G.canManageStore()) {
        const k = $("appNav").querySelector('a[href="/kiosk-setup.html"]');
        if (k) k.remove();
      }
      if (G.simpleMode) {
        NAV_ADVANCED_ONLY.forEach(href => {
          const a = $("appNav").querySelector('a[href="' + href + '"]');
          if (a) a.remove();
        });
        // #325: plain words for a casual collector. The pages are the same; only
        // the menu labels change, and only here (full mode keeps its names).
        Object.keys(NAV_SIMPLE_LABELS).forEach(href => {
          const a = $("appNav").querySelector('a[href="' + href + '"]');
          if (a) { a.textContent = NAV_SIMPLE_LABELS[href]; a.title = NAV_SIMPLE_LABELS[href]; }
        });
        // No "Warehouse" heading: what is left of it (Add cards, Locations) sits
        // straight under Dashboard, like Dashboard itself.
        const wh = $("whNavWrap");
        if (wh) {
          [...wh.querySelectorAll(".nav-links a")].forEach(a => wh.parentNode.insertBefore(a, wh));
          wh.remove();
        }
        // A group left with no links would show as an empty heading.
        $("appNav").querySelectorAll(".nav-group").forEach(g => {
          if (!g.querySelector(".nav-links a") && g.id !== "accountNavWrap") g.remove();
        });
        // #331: one click back to the full app (not only Settings -> Preferences).
        // Sealed, Movers and the other power-seller pages come back with it.
        const full = document.createElement("div");
        full.className = "simple-full-link";
        full.innerHTML = '<button type="button" class="small ghost" id="turnOnFullMode" title="Brings back Sealed, Movers and the other business tools">Turn on full mode</button>';
        $("appNav").appendChild(full);
        $("turnOnFullMode").onclick = async () => {
          $("turnOnFullMode").disabled = true;
          try {
            await G.setPersonalPrefs({ simpleMode: false });
            if (!(G.prefsInAccount || await G.saveAll(10000))) throw new Error("still saving");
            location.reload();
          } catch (e) {
            $("turnOnFullMode").disabled = false;
            toast("Couldn't switch modes: " + (e.message || "try again"), "err");
          }
        };
      }
      if (G.isModerator) {
        const entry = NAV_ADMIN;
        if (!$("appNav").querySelector('a[href="' + entry.href + '"]')) {
          const a = document.createElement("a");
          a.href = entry.href;
          a.textContent = entry.label;
          if (entry.match.includes(location.pathname)) a.className = "here";
          const links = $("accountNavWrap").querySelector(".nav-links");
          links.insertBefore(a, links.querySelector(".side-profile"));
        }
      }
      // Shown to every full-mode account (not gated on u.orgId), unlike NAV_ADMIN above - org.html itself handles the
      // "not in an organization yet" state (a create-org form), so this is
      // the only discovery path for that first step. Gating it on
      // u.orgId (as an earlier version of this did) meant nobody could
      // ever find their way to creating one in the first place.
      if (!G.simpleMode) { // hidden in Simple mode: multi-store is a business feature
        const entry = NAV_ORG;
        if (!$("appNav").querySelector('a[href="' + entry.href + '"]')) {
          const a = document.createElement("a");
          a.href = entry.href;
          a.textContent = entry.label;
          if (entry.match.includes(location.pathname)) a.className = "here";
          const links = $("accountNavWrap").querySelector(".nav-links");
          links.insertBefore(a, links.querySelector(".side-profile"));
        }
      }
      openNavForNewAccount(u);
      if (u && u.orgId) loadStoreSwitcher();
      loadTicker();
      renderCustomerBadge();
    });
    G.on("change", renderCustomerBadge);
    // "Pick list P-1 was" / "Pick lists P-1, P-2 were" (#214).
    const pickListsWere = ids => (ids.length === 1 ? "Pick list " + ids[0] + " was" :
      "Pick lists " + ids.slice(0, 5).join(", ") + (ids.length > 5 ? " and " + (ids.length - 5) + " more" : "") + " were");
    G.on("conflict", info => {
      // #214: this save would have completed pick lists another device had
      // already completed. Not applied, and no Keep mine: reloading takes
      // the other device's completion, which is the one that counts.
      if (info.alreadyCompleted && info.alreadyCompleted.length) {
        toast("Already completed on another device - reload.", "err",
          pickListsWere(info.alreadyCompleted) + " completed on another device first, so this tab's last change " +
          "was not saved and no cards came off twice. Reload this page to carry on.");
        const reload = document.createElement("button");
        reload.textContent = "Reload";
        reload.className = "small";
        reload.onclick = () => location.reload();
        $("toastDetail").appendChild(document.createElement("br"));
        $("toastDetail").appendChild(reload);
        return;
      }
      toast("This collection was also changed somewhere else (server revision " +
        (info.serverRev == null ? "?" : info.serverRev) + "), so your last change was not saved.",
        "err",
        "Reload this page to take the other version, or press \"Keep mine\" to overwrite it.");
      const btn = document.createElement("button");
      btn.textContent = "Keep mine";
      btn.className = "small";
      btn.onclick = async () => {
        try { await G.overwriteServer(); toast("Your version is now the one on the server.", "ok"); }
        catch (e) { toast("Could not overwrite: " + e.message, "err"); }
      };
      $("toastDetail").appendChild(document.createElement("br"));
      $("toastDetail").appendChild(btn);
    });
    G.on("wrongowner", info => { wrongOwnerMsg = info.message; wrongOwnerToast(); });
    /* The gentler cousin of "conflict" above: the server resolved a
       concurrent save by merging (server/lib/merge.js) instead of
       rejecting it, and core.js has already adopted the merged result -
       nothing lost, nothing to reload or overwrite. Silent when the merge
       was clean (the overwhelmingly common case - different rows, or the
       same row's quantity summed correctly); only surfaces a toast when a
       genuine same-field conflict actually had to be resolved one way,
       so the loser's browser can see what happened instead of just
       silently not getting their change. */
    G.on("merged", info => {
      // A customer's mergedAt (#196) is bookkeeping, not something the
      // person changed: a conflict on it alone loses nothing and has
      // nothing to say (#201; core.js foldStamp keeps it from happening).
      const all = (info.conflicts || []).filter(c => !(c.array === "customers" && c.field === "mergedAt"));
      // #214: a pick list completed here that another device had already
      // completed. The server kept that completion and undid this one, so
      // the cards came off once; this tab already shows the result.
      const done = all.filter(c => c.type === "already-completed");
      const conflicts = all.filter(c => c.type !== "already-completed");
      if (!done.length && !conflicts.length) return;
      const describe = c => {
        if (c.type === "edit-beats-delete") return "a deleted row was kept because someone else had just edited it";
        if (c.type === "whole-value") return "your " + c.array + " change was overridden by a more recent one";
        return "your change to " + c.array + "." + c.field + " was overridden by a more recent one";
      };
      const shown = conflicts.slice(0, 3).map(describe);
      const more = conflicts.length > 3 ? " (+" + (conflicts.length - 3) + " more)" : "";
      if (done.length) {
        toast("Already completed on another device - reload.", "work",
          pickListsWere(done.map(c => c.key)) + " completed on another device first, so " + (done.length === 1 ? "its" : "their") + " cards came off " +
          "inventory once, not twice. Your other changes were saved." +
          (shown.length ? " Also: " + shown.join("; ") + more + "." : ""));
        return;
      }
      // "work" (gold), not "ok"/"err" - not a failure, but worth a second
      // look, same tone as .callout.warn elsewhere in the app. Passing a
      // detail string means this toast persists until dismissed rather
      // than auto-hiding, same as the "conflict" toast above.
      toast("Someone else saved changes to this collection at the same time - merged automatically.",
        "work", shown.join("; ") + more);
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        closeMenus();
        const top = topModal();
        // A first showing of "What's new" (#455) is finished with Done, not Esc.
        if (top && !top.hasAttribute("data-must-finish")) { hideModal(top.id); }
        return;
      }
      if (e.key === "Tab" && topModal()) { trapTab(e); return; }
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || "");
      if ((e.ctrlKey || e.metaKey) && !typing) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); $("btnUndo").click(); }
        else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); $("btnRedo").click(); }
        else if (k === "s") { e.preventDefault(); G.saveNow(); }
        return;
      }
      // Two low-ceremony shortcuts for a staff tool built around repetitive
      // data entry (receiving, cycle counts, pricing) - Ctrl+Z/Y/S above were
      // the only ones that existed, with nothing to make even those
      // discoverable to a new hire. "/" jumps to whatever this page's own
      // primary filter/search box is (every page puts it first inside its
      // .toolbar or .list-toolbar, so one selector covers all of them without
      // each page wiring its own handler); "?" opens a cheat sheet listing
      // all of this, including itself.
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "/") {
          const el = document.querySelector(
            ".toolbar input:not([type=checkbox]):not([type=radio]), .list-toolbar input:not([type=checkbox]):not([type=radio])");
          if (el) { e.preventDefault(); el.focus(); if (el.select) el.select(); }
        } else if (e.key === "?") {
          e.preventDefault();
          showShortcutHelp();
        }
      }
    });
    document.addEventListener("click", e => {
      const t = e.target;
      const wrap = (t && typeof t.closest === "function") ? t.closest(".menu-wrap") : null;
      document.querySelectorAll(".menu").forEach(m => { if (!wrap || !wrap.contains(m)) m.hidden = true; });
    });
    // Any button whose label reads "Save ..." (Save, Save rule, Save schedule, ...)
    // flushes the collection PUT immediately instead of waiting out the autosave
    // debounce - otherwise a click-then-navigate can lose the edit in transit.
    document.addEventListener("click", e => {
      const btn = e.target && typeof e.target.closest === "function" ? e.target.closest("button") : null;
      if (!btn || btn.disabled) return;
      if (/^save\b/i.test(btn.textContent.trim())) G.saveNow().catch(() => {});
    });
    // `maxlength` is silently ignored on type="number" inputs (a long-standing
    // HTML gap, not a bug here) - typing/pasting a huge run of digits into one
    // has real, reproducible perf problems in Chromium-family browsers well
    // before any value that long could ever be real (nothing in Grimoire -
    // quantities, ceilings, prices - is anywhere near 15 digits). One delegated
    // listener covers every number input on every page, present or future,
    // rather than hand-limiting each one - reported directly against a real
    // location field, but the same gap exists everywhere type="number" is used.
    document.addEventListener("input", e => {
      const t = e.target;
      if (t && t.tagName === "INPUT" && t.type === "number" && t.value.length > 15) t.value = t.value.slice(0, 15);
    });
    enableSorting();
  }

  function renderSaveState(s) {
    const dot = $("saveDot"), text = $("saveText");
    if (!dot) return;
    dot.className = "dot" + (s.error ? " bad" : s.saving ? " dirty" : s.dirty ? " dirty" : "");
    text.textContent = s.error ? "save failed" : s.saving ? "saving…" : s.dirty ? "unsaved" : "saved";
    $("saveState").title = s.error
      ? "The last save failed: " + s.error
      : "Server revision " + s.rev + (s.savedAt ? " · saved " + new Date(s.savedAt).toLocaleString() : "");
  }
  function renderUndo(info) {
    const i = info || G.undoInfo();
    if (!$("btnUndo")) return;
    $("btnUndo").disabled = !i.canUndo;
    $("btnRedo").disabled = !i.canRedo;
    $("undoLabel").textContent = i.canUndo ? i.undoLabel : "";
    $("btnUndo").title = i.canUndo ? "Undo: " + i.undoLabel + "  (Ctrl+Z)" : "Nothing to undo";
    $("btnRedo").title = i.canRedo ? "Redo: " + i.redoLabel + "  (Ctrl+Y)" : "Nothing to redo";
  }
  const closeMenus = () => document.querySelectorAll(".menu").forEach(m => { m.hidden = true; });

  /* ============================== Notifications (#139) ==============================
     The header bell: an unread count (hidden at 0, "99+" past 99), polled
     on load, about every 60 seconds while the tab is visible, and the
     moment it becomes visible again. Opening the bell loads the list,
     newest first. Clicking an item asks the server to open it: the server
     marks it read, re-checks that you can still see what it's about, and
     only then hands back the link (same-origin paths only, checked again
     here), plus the store to switch to when the item is about a store
     other than the current one. The page saves everything first, says it
     is switching, switches through /api/store/switch, then navigates.
     Text is the server's plain text, always escaped. */
  const NOTIF_POLL_MS = 60 * 1000;
  // A note carried across the reload when opening a notification switched
  // stores, so the next page says where you are now.
  const NOTIF_FLASH_KEY = "grimoire.notifFlash";
  const NOTIF_LINK_RX = /^\/[a-z0-9-]+\.html(\?[A-Za-z0-9=&%._~+-]*)?(#[A-Za-z0-9_-]*)?$/;
  let notifItems = [];
  const notifListRun = G.latestOnly();
  const notifCountRun = G.latestOnly();

  function setNotifCount(n) {
    const el = $("notifCount"), btn = $("btnNotif");
    if (!el || !btn) return;
    const k = Math.max(0, Number(n) || 0);
    el.hidden = !k;
    el.textContent = k > 99 ? "99+" : String(k);
    const label = k ? "Notifications, " + k + " unread" : "Notifications";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  async function pollNotifications() {
    if (document.visibilityState === "hidden") return;
    const isCurrent = notifCountRun();
    try {
      const d = await G.api("/api/notifications?unread=1");
      if (isCurrent()) setNotifCount(d.unread);
    } catch (e) { /* the next poll tries again */ }
  }

  function notifAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
    return new Date(t).toLocaleDateString();
  }

  function renderNotifList() {
    const list = $("notifList");
    if (!notifItems.length) {
      list.innerHTML = emptyBlock({ icon: "generic", title: "No notifications." });
      $("notifAllRead").disabled = true;
      return;
    }
    $("notifAllRead").disabled = !notifItems.some(x => !x.read);
    list.innerHTML = notifItems.map(x =>
      '<button type="button" class="notif-item' + (x.read ? "" : " unread") + '" data-id="' + esc(x.id) + '">' +
        '<span class="notif-icon">' + icon(x.icon || "bell") + "</span>" +
        '<span class="notif-body"><span class="notif-text">' + esc(x.text) + "</span>" +
        '<span class="notif-time" title="' + esc(new Date(x.at).toLocaleString()) + '">' + esc(notifAgo(x.at)) +
        (x.read ? "" : ' · <span class="notif-new">new</span>') + "</span></span></button>").join("");
    list.querySelectorAll(".notif-item").forEach(b => { b.onclick = () => openNotification(b.dataset.id); });
  }

  async function loadNotifList() {
    const isCurrent = notifListRun();
    $("notifList").innerHTML = skeletonBlock(3);
    let d;
    try { d = await G.api("/api/notifications"); }
    catch (e) {
      if (isCurrent()) $("notifList").innerHTML = emptyBlock({ icon: "error", title: "Could not load notifications: " + esc(e.message) });
      return;
    }
    if (!isCurrent()) return;
    notifItems = Array.isArray(d.items) ? d.items : [];
    setNotifCount(d.unread);
    renderNotifList();
  }

  async function openNotification(id) {
    let r;
    try { r = await G.api("/api/notifications/" + encodeURIComponent(id) + "/open", { method: "POST" }); }
    catch (e) { toast("Could not open that notification: " + e.message, "err"); return; }
    const it = notifItems.find(x => x.id === id);
    if (it) it.read = true;
    setNotifCount(r.unread);
    renderNotifList();
    const link = typeof r.link === "string" && NOTIF_LINK_RX.test(r.link) ? r.link : null;
    if (!link) { toast(r.message || "This can't be opened any more.", "err"); return; }
    const sw = r.switchTo && typeof r.switchTo.id === "string" && r.switchTo.id ? r.switchTo : null;
    const swName = sw ? String(sw.name || "another store") : "";
    if (sw) toast("This is about " + swName + ". Saving your changes here, then switching to it…", "work");
    // This page's own edits save first, wherever the link leads. A save
    // names no inventory: the server puts it in the session's active
    // store, so one landing after a switch would go into the wrong store
    // (PR #144 review). Nothing is opened until everything has saved.
    if (!(await G.saveAll())) {
      toast("Your latest changes haven't saved yet, so the notification wasn't opened. " +
        "Try again once the header says Saved.", "err");
      return;
    }
    $("notifMenu").hidden = true;
    $("btnNotif").setAttribute("aria-expanded", "false");
    if (sw) {
      // Nothing on this page may save from here on: the session is about
      // to point at the other store.
      holdForStoreSwitch(true);
      try { await G.api("/api/store/switch", { method: "POST", body: { storeId: sw.id } }); }
      catch (e) { holdForStoreSwitch(false); toast("Could not switch to " + swName + ": " + e.message, "err"); return; }
      if (G.hasUnsaved()) {
        // Something changed on this page during the switch. Put the
        // session back so it saves where it belongs, and don't leave.
        const back = r.from
          ? await G.api("/api/store/switch", { method: "POST", body: { storeId: r.from } }).then(() => true, () => false)
          : false;
        if (back) {
          holdForStoreSwitch(false);
          toast("Something changed on this page while switching, so you're still in this store. Open the notification again.", "err");
        } else {
          toast("Something changed on this page while switching stores. Reload the page before making more changes.", "err");
        }
        return;
      }
      try { sessionStorage.setItem(NOTIF_FLASH_KEY, "Switched to " + swName + ": that notification is about this store."); } catch (e) {}
    }
    // The same page with a different query reloads by itself; the exact
    // same URL (another notification about the same thing) needs a nudge.
    if (link === location.pathname + location.search + location.hash) location.reload();
    else location.href = link;
  }

  function startNotifications() {
    const btn = $("btnNotif"), menu = $("notifMenu");
    if (!btn || !menu) return;
    let flash = null;
    try { flash = sessionStorage.getItem(NOTIF_FLASH_KEY); sessionStorage.removeItem(NOTIF_FLASH_KEY); } catch (e) {}
    if (flash) toast(flash, "ok");
    btn.onclick = () => {
      const open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) loadNotifList();
    };
    $("notifAllRead").onclick = async () => {
      try {
        const r = await G.api("/api/notifications/read-all", { method: "POST" });
        notifItems.forEach(x => { x.read = true; });
        setNotifCount(r.unread);
        renderNotifList();
      } catch (e) { toast("Could not mark them read: " + e.message, "err"); }
    };
    pollNotifications();
    setInterval(pollNotifications, NOTIF_POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollNotifications(); });
  }

  /* ============================== Toast ============================== */
  let toastTimer = null;
  // Static markup only (never user text) - rendered with innerHTML below.
  const TOAST_ICON = { ok: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#check></use></svg>", err: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#x></use></svg>", work: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#hourglass></use></svg>" };
  // True while the toast on screen was opened by toastProgress itself (no
  // "work" toast was up), so toastProgress("") knows to close it again.
  let progOwned = false;
  function toast(msg, cls, detail) {
    clearTimeout(toastTimer);
    progOwned = false;
    $("toastIcon").innerHTML = TOAST_ICON[cls] || "";
    $("toastMsg").textContent = msg;
    $("toast").className = "toast " + (cls || "");
    $("toast").hidden = false;
    toastProgress("");
    const d = $("toastDetails");
    if (detail) { $("toastDetail").textContent = detail; d.open = false; d.hidden = false; }
    else { d.hidden = true; $("toastDetail").textContent = ""; }
    if (cls !== "err" && cls !== "work" && !detail) toastTimer = setTimeout(hideToast, 8000);
  }
  /* Progress of a long job (#480). With text it always shows something:
     under a "work" toast that's already up it fills the line beneath it;
     otherwise it opens the toast itself as a working message. done/total
     draw a filled bar; without them the bar just moves (indeterminate).
     toastProgress("") clears the line, and closes the toast only if
     progress opened it. Any UI.toast(...) replaces it. */
  function toastProgress(text, done, total) {
    const box = $("toast"), el = $("toastProg");
    if (!box || !el) return;
    if (!text) {
      el.hidden = true;
      $("toastProgText").textContent = "";
      if (progOwned) { progOwned = false; hideToast(); }
      return;
    }
    if (!progOwned && (box.hidden || !/(^| )work( |$)/.test(box.className))) {
      toast(text, "work");
      progOwned = true;
    }
    if (progOwned) { $("toastMsg").textContent = text; $("toastProgText").textContent = ""; }
    else $("toastProgText").textContent = text;
    const bar = $("toastBar"), fill = bar.querySelector("i");
    const known = Number.isFinite(done) && Number.isFinite(total) && total > 0;
    bar.classList.toggle("indet", !known);
    if (known) {
      const n = Math.max(0, Math.min(done, total));
      fill.style.width = (n / total * 100) + "%";
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", String(total));
      bar.setAttribute("aria-valuenow", String(n));
    } else {
      fill.style.width = "";
      ["aria-valuemin", "aria-valuemax", "aria-valuenow"].forEach(a => bar.removeAttribute(a));
    }
    el.hidden = false;
  }
  function hideToast() { clearTimeout(toastTimer); $("toast").hidden = true; }

  /* ============================== Loading skeletons ==============================
     BACKLOG.md #29: a shimmering placeholder for a slow async panel, meant to
     replace the plain ".empty" "Loading…" text at the same call sites (swap
     in right before the fetch, overwritten by the real render() once data
     lands) - not a new pattern to learn, just a nicer version of what was
     already there. Widths vary per line (a fixed seed off the loop index,
     not random - a stable, non-jittery look) so a stack of placeholder lines
     doesn't read as one repeated graphic. */
  function skeletonRows(colspan, n) {
    n = n || 3;
    let out = "";
    for (let i = 0; i < n; i++) {
      out += '<tr class="skeleton-row"><td colspan="' + colspan + '">' +
        '<div class="skeleton skeleton-line" style="width:' + (40 + (i * 17) % 40) + '%"></div></td></tr>';
    }
    return out;
  }
  function skeletonBlock(lines) {
    lines = lines || 3;
    let out = '<div class="skeleton-block">';
    for (let i = 0; i < lines; i++) {
      out += '<div class="skeleton skeleton-line" style="width:' + (50 + (i * 13) % 45) + '%"></div>';
    }
    return out + "</div>";
  }

  /* ============================== Empty states ==============================
     BACKLOG.md #33 (shape (b), decided 2026-09-15 after three alternatives
     were written up rather than one picked silently): every "nothing here
     yet" / "no match" / "could not load" panel across the app gets the same
     real empty-state block - an icon, a short bold title, and an optional
     muted hint - instead of one plain centered sentence. `icon` is a key
     into EMPTY_ICONS below; an unrecognised or omitted key quietly falls
     back to the generic one rather than rendering blank, so a future typo'd
     key degrades gracefully instead of silently breaking. `hint` is
     optional - plenty of messages don't have a natural second clause and
     read fine as a title alone. Both `title`/`hint` are raw HTML, the same
     trust level the strings they replace already had (a call site that
     interpolates real user/server text still runs it through G.esc() itself,
     same as before - this helper doesn't escape anything on its own). */
  const EMPTY_ICONS = {
    generic: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#inbox></use></svg>", cards: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#archive></use></svg>", locations: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#map-pin></use></svg>", orders: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg>", money: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#circle-dollar-sign></use></svg>",
    people: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#users></use></svg>", tickets: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#ticket></use></svg>", search: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#search></use></svg>", error: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#triangle-alert></use></svg>", history: "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#trending-up></use></svg>"
  };
  function emptyBlock(o) {
    o = o || {};
    const icon = EMPTY_ICONS[o.icon] || EMPTY_ICONS.generic;
    return '<div class="empty"><div class="empty-icon" aria-hidden="true">' + icon + "</div>" +
      '<div class="empty-title">' + (o.title || "") + "</div>" +
      (o.hint ? '<div class="empty-hint">' + o.hint + "</div>" : "") + "</div>";
  }
  // <td>-safe variant for a table body's "no rows" state - the wrapping td
  // gets its own .empty-cell class rather than the old .empty (see app.css)
  // since the richer block needs real height, not the fixed-height th/td
  // rule every other cell in the app relies on.
  function emptyRow(colspan, o) {
    return '<tr><td colspan="' + colspan + '" class="empty-cell">' + emptyBlock(o) + "</td></tr>";
  }

  /* "Showing 500 of 49,750" under a plan table that draws only the first
     `cap` rows (#99, Listings and Bulk Price Evaluate). `host` holds a
     `.more-text` span and a Show more button; it is hidden when every row
     is drawn. */
  function planMoreNote(host, total, cap) {
    host.hidden = total <= cap;
    if (host.hidden) return;
    host.querySelector(".more-text").textContent = "Showing " + cap.toLocaleString() + " of " + total.toLocaleString() +
      " rows. Type in the filter to narrow them down. Sorting a column sorts every row, not just these. " +
      "Apply and Push still include every ticked row that matches the filter, drawn or not.";
  }

  /* ============================== Restart notice ==============================
     GET /api/meta needs no session and is already fetched once at boot, so
     polling it is cheap: every 5s for a pending restart, every 2s once the
     deadline passes or a poll fails outright - that failure IS the signal
     the process is mid-respawn, not just a normal error to report. */
  let restartPollTimer = null;
  let restartTickTimer = null;
  let restartState = "idle"; // idle | counting | down
  let restartAt = null;
  let restartReason = "";
  let versionShown = false;

  // While the banner says "Back online, but your last change hasn't saved
  // yet": the rev the page had then. The first save that lands (a new rev)
  // takes the banner down (#183), instead of it staying up until a reload.
  // null otherwise.
  let restartBannerWaitsForSave = null;

  function restartBannerShow(text) {
    restartBannerWaitsForSave = null;
    const b = $("restartBanner");
    if (!b) return;
    $("restartBannerMsg").textContent = text;
    b.hidden = false;
  }
  function restartBannerHide() {
    restartBannerWaitsForSave = null;
    const b = $("restartBanner");
    if (b) b.hidden = true;
  }
  function restartTick() {
    if (restartState !== "counting" || restartAt == null) return;
    const secs = Math.max(0, Math.round((restartAt - Date.now()) / 1000));
    const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, "0");
    const prefix = restartReason ? restartReason + " — " : "";
    restartBannerShow(prefix + "⚠ This server will restart in " + mm + ":" + ss + ". Your work is being saved now.");
  }
  async function restartPoll() {
    let m;
    try { m = await fetch("/api/meta", { credentials: "same-origin" }).then(r => r.json()); }
    catch (e) {
      restartState = "down";
      clearInterval(restartTickTimer);
      restartBannerShow("Restarting — reconnecting…");
      return;
    }
    // This device became the store's kiosk (#433): any other Grimoire tab left
    // open on it leaves for the kiosk screen within one poll.
    if (m && m.kiosk === true) { G.leaveForKiosk(); return; }
    // Pulled from the running server rather than hardcoded here, so the badge
    // can never again silently go stale the way a fixed "v0.08" string did
    // through months of shipped features - it just shows whatever VERSION
    // server/index.js was started with.
    if (!versionShown && m && m.version && $("verBadge")) {
      $("verBadge").textContent = "v" + m.version;
      versionShown = true;
    }
    if (restartState === "down") {
      restartState = "idle";
      restartBannerShow("✓ Back online — saving, then reloading…");
      // An edit made during the countdown or the downtime is still waiting
      // for its retry: save it now, and never reload over it (#176).
      const ok = await G.saveAll(15000);
      if (ok) { restartBannerShow("✓ Back online — reloading…"); setTimeout(() => location.reload(), 1200); }
      else {
        restartBannerShow("Back online, but your last change hasn't saved yet. Reload once the save indicator says Saved.");
        restartBannerWaitsForSave = { rev: G.rev };
      }
      return;
    }
    if (m && m.restart) {
      if (restartState !== "counting") {
        restartState = "counting";
        if (window.G && typeof G.saveNow === "function") G.saveNow().catch(() => {});
        clearInterval(restartTickTimer);
        restartTickTimer = setInterval(restartTick, 1000);
      }
      restartAt = m.restart.at;
      restartReason = m.restart.reason || "";
      restartTick();
    } else if (restartState === "counting") {
      restartState = "idle";
      restartReason = "";
      clearInterval(restartTickTimer);
      restartBannerHide();
    }
  }
  function startRestartWatch() {
    G.on("savestate", s => {
      const w = restartBannerWaitsForSave;
      // An audit-only failure leaves the rev alone: it is over once the
      // audit flush lands and nothing is left unsaved (#190).
      if (w && !s.saving && !s.error && (s.rev !== w.rev || !G.hasUnsaved())) restartBannerHide();
    });
    const loop = () => {
      restartPoll().finally(() => {
        restartPollTimer = setTimeout(loop, restartState === "down" ? 2000 : 5000);
      });
    };
    loop();
  }

  /* Loads G.cards.printings(name) into a <select> of printing options,
     labeled with G.printingOptionLabel (language-suffixed, since these
     callers have no separate Language field of their own to disambiguate
     with - putaway/locations' rule-test pickers and cycle-count's floor-
     entry pickers). Never rejects (a failed/empty lookup still resolves,
     with the select showing why) - resolves with the loaded list so the
     caller can look up "the one currently selected" via list[index]
     however it needs to. Receive has its own variant (receive.page.js's
     loadPrintings) since it groups printings by set+collector and resolves
     language via its own separate Language field instead. */
  function loadPrintingSelect(selId, name) {
    const sel = $(selId);
    sel.innerHTML = '<option value="">Loading…</option>';
    return G.cards.printings(name).then(list => {
      sel.innerHTML = list.length
        ? list.map((c, i) => '<option value="' + i + '">' + esc(G.printingOptionLabel(c)) + "</option>").join("")
        : '<option value="">— none found —</option>';
      sel.value = list.length ? "0" : "";
      return list;
    }).catch(() => {
      sel.innerHTML = '<option value="">— lookup failed —</option>';
      return [];
    });
  }

  function setStatus(elId, msg, cls) {
    const el = $(elId);
    if (!el) return;
    // login.html/tutorial.html already mark their status elements this way by
    // hand; every other page's plain <div class="status"> never got it, so a
    // screen-reader user got no announcement when e.g. "Added 4x Lightning
    // Bolt" or "Restart failed" appeared. Setting it once here (idempotent,
    // and never overriding a role a page already declared) covers every one
    // of setStatus()'s ~74 call sites without touching each page's HTML.
    if (!el.hasAttribute("aria-live")) {
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
    }
    el.textContent = msg;
    el.className = "status " + (cls || "");
  }

  /* Shared save-button wiring for a third-party credential form (Manapool,
     Pitney Bowes, instance email config, ...): read the given fields, POST
     them, blank any field marked secret so it's never left showing what was
     just typed, report status, then let the caller refresh its own display.
     Pulled out so the three near-identical hand-rolled save handlers this
     app had can't quietly drift apart from each other. */
  function wireCredentialSave(o) {
    $(o.buttonId).onclick = async () => {
      const body = {};
      for (const f of o.fields) body[f.key] = $(f.id).value.trim();
      try {
        await G.api(o.url, { method: "POST", body });
        for (const f of o.fields) if (f.secret) $(f.id).value = "";
        setStatus(o.statusId, o.savedMsg || "✓ Saved.", "ok");
        if (o.onSaved) o.onSaved();
      } catch (e) { setStatus(o.statusId, e.message, "err"); }
    };
  }

  /* Shared "test this connection" wiring - same three integrations as
     wireCredentialSave above. onResult maps the endpoint's response to
     {msg, ok} since what "success" looks like differs per integration. */
  function wireCredentialTest(o) {
    $(o.buttonId).onclick = async () => {
      setStatus(o.statusId, o.workMsg || "Testing…", "work");
      try {
        const data = await G.api(o.url, o.method ? { method: o.method } : undefined);
        const r = o.onResult ? o.onResult(data) : { ok: true, msg: "OK" };
        setStatus(o.statusId, r.msg, r.ok ? "ok" : "err");
      } catch (e) { setStatus(o.statusId, e.message, "err"); }
    };
  }

  /* ============================== Modals ============================== */
  const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
    'textarea:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])';
  const focusables = root => [...root.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
  // {id, focus} per currently-open modal, in the order each was shown - NOT
  // DOM order. A modal created early (the lightbox, built once in
  // mountChrome()) can still be opened AFTER one created later (any
  // ensureModal() page adds to the end of <body> on first use), so "top" has
  // to mean "opened most recently", not "last in the document".
  let modalStack = [];
  const closeHandlers = {};
  // .modal-backdrop's CSS z-index (40) is the same for every modal, so paint
  // order between two open backdrops falls back to DOM order - i.e. whichever
  // ensureModal() happened to run first, NOT which one was actually opened on
  // top. That's independent of modalStack (which already tracks true show-
  // order correctly for focus-trap/Escape purposes) - so without this, a modal
  // created earlier in the session could paint underneath one opened after it.
  // Stamping an increasing inline z-index at show time keeps paint order
  // locked to show order, matching what the stack already assumes.
  let modalZCounter = 40;
  function showModal(id, focusId) {
    modalStack.push({ id, focus: document.activeElement });
    const m = $(id);
    m.style.zIndex = ++modalZCounter;
    m.hidden = false;
    const el = (focusId && $(focusId)) || focusables(m)[0];
    if (el) setTimeout(() => { try { el.focus(); } catch (e) {} }, 0);
  }
  function hideModal(id) {
    const el = $(id);
    if (!el || el.hidden) return;
    el.hidden = true;
    el.style.zIndex = "";
    if (closeHandlers[id]) { try { closeHandlers[id](); } catch (e) {} }
    const i = modalStack.findIndex(m => m.id === id);
    const back = i >= 0 ? modalStack.splice(i, 1)[0].focus : null;
    if (back && document.contains(back)) { try { back.focus(); } catch (e) {} }
  }
  const onClose = (id, fn) => { closeHandlers[id] = fn; };
  function topModal() {
    for (let i = modalStack.length - 1; i >= 0; i--) {
      const el = $(modalStack[i].id);
      if (el && !el.hidden) return el;
    }
    return null;
  }
  function trapTab(e) {
    const m = topModal(); if (!m) return;
    const items = focusables(m); if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) {
      // Focus can fall outside when the modal re-renders the button it was
      // on (the Customers slide-over redraws on every save).
      e.preventDefault(); first.focus();
    }
  }
  /* Create a modal container once, from markup, and dismiss it on a backdrop click. */
  function ensureModal(id, cls, html) {
    let el = $(id);
    if (el) return el;
    el = document.createElement("div");
    el.id = id;
    el.className = "modal-backdrop";
    el.hidden = true;
    el.innerHTML = '<div class="modal ' + (cls || "") + '" role="dialog" aria-modal="true">' + html + "</div>";
    el.addEventListener("click", e => { if (e.target === el) hideModal(id); });
    document.body.appendChild(el);
    return el;
  }
  /* Slide-over detail panel (#62): markup is
     <div class="modal-backdrop slideover" id> <div class="slideover-panel"
     role="dialog" aria-modal="true"> ... </div></div>, with any [data-close]
     button inside closing it. As far as the modal stack is concerned it IS a
     modal, so Esc, the Tab trap, stacking a confirm/edit modal on top and
     focus going back to whatever opened it all come from showModal /
     hideModal; this only adds the outside-click and close-button wiring.
     onClose(id, fn) still works for a page that needs to react to closing. */
  function slideOver(id) {
    const el = $(id);
    if (el && !el.dataset.slideoverWired) {
      el.dataset.slideoverWired = "1";
      // Outside click closes only when the press AND the release are both
      // on the backdrop: a text selection dragged out of the panel ends
      // with a click on the backdrop, and that mustn't close it.
      let downOnBackdrop = false;
      el.addEventListener("pointerdown", e => { downOnBackdrop = e.target === el; });
      el.addEventListener("click", e => {
        const ok = downOnBackdrop && e.target === el;
        downOnBackdrop = false;
        if (ok) hideModal(id);
      });
      el.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => hideModal(id)));
    }
    return {
      open: focusId => { if (el && el.hidden) showModal(id, focusId); },
      close: () => hideModal(id),
      isOpen: () => !!el && !el.hidden
    };
  }
  /* Page tabs that remember where you were (#438, CLAUDE.md "Tabs remember
     where you were"). spec = { tabs: [{ id, button, panes: [paneIds] }],
     page?, def?, onShow?(id) }. The open tab is in the address (#tab=<id>, put
     there with replaceState, so Back and a link land on it; a bare #<id> of
     a tab works too, for old links); with none there, the page opens on the
     tab last used on it on this device (localStorage, per page), else def
     (an id), else the first. A hidden button's tab (a role-gated one) is
     never chosen. onShow(id) runs on every show, for per-tab loads.
     Returns { show(id), current() }. */
  function pageTabs(spec) {
    const list = (spec && spec.tabs) || [];
    const storeKey = "grimoire.tab." + ((spec && spec.page) || location.pathname || "");
    const usable = id => list.find(t => t.id === id && $(t.button) && !$(t.button).hidden) || null;
    const dec = v => { try { return decodeURIComponent(v); } catch (e) { return ""; } };
    const fromHash = () => {
      const raw = String(location.hash || "").replace(/^#/, "");
      const m = /(?:^|&)tab=([^&]*)/.exec(raw);
      if (m) return dec(m[1]);
      return list.some(t => t.id === dec(raw)) ? dec(raw) : "";
    };
    const stored = () => { try { return localStorage.getItem(storeKey) || ""; } catch (e) { return ""; } };
    let cur = null;
    function show(id) {
      const t = usable(id) || list.find(x => usable(x.id));
      if (!t) return;
      cur = t.id;
      for (const x of list) {
        const b = $(x.button);
        if (b) { b.classList.toggle("active", x === t); b.setAttribute("aria-selected", x === t ? "true" : "false"); }
        for (const p of x.panes || []) if ($(p)) $(p).hidden = x !== t;
      }
      try { localStorage.setItem(storeKey, cur); } catch (e) { /* won't stick */ }
      // Keep any other #key=value the page uses; a plain #anchor gives way.
      const h = String(location.hash || "").replace(/^#/, "");
      const rest = h.includes("=") ? h.split("&").filter(kv => kv && !/^tab=/.test(kv)) : [];
      const hash = "#" + rest.concat(["tab=" + encodeURIComponent(cur)]).join("&");
      if (location.hash !== hash) {
        try { history.replaceState(history.state, "", location.pathname + location.search + hash); } catch (e) { /* the address just won't show it */ }
      }
      if (spec.onShow) spec.onShow(cur);
    }
    for (const t of list) { const b = $(t.button); if (b) b.addEventListener("click", () => show(t.id)); }
    // A link to another tab of this page (#tab=...) switches without a reload.
    window.addEventListener("hashchange", () => { const h = fromHash(); if (h && h !== cur && usable(h)) show(h); });
    show(usable(fromHash()) ? fromHash() : usable(stored()) ? stored() : spec.def);
    return { show, current: () => cur };
  }
  function lightbox(src, alt) {
    $("lightboxImg").src = src;
    $("lightboxImg").alt = alt || "";
    showModal("lightbox", "lightboxClose");
  }

  /* "?" cheat sheet - the only thing that made the handful of global
     shortcuts (keydown listener above) discoverable before this was reading
     the source. Lazily built like every other on-demand modal here. */
  function showShortcutHelp() {
    ensureModal("shortcutHelpModal", "", '<h3>Keyboard shortcuts</h3>' +
      '<table class="list" style="margin-top:8px"><tbody>' +
      ["/|Focus this page's search or filter box", "?|Show this cheat sheet",
        "Esc|Close the open dialog or menu", "Ctrl/⌘+Z|Undo", "Ctrl/⌘+Shift+Z (or Ctrl/⌘+Y)|Redo",
        "Ctrl/⌘+S|Save now, skipping the autosave delay"]
        .map(l => { const [k, d] = l.split("|"); return "<tr><td><code>" + esc(k) + "</code></td><td>" + esc(d) + "</td></tr>"; })
        .join("") +
      '</tbody></table>' +
      '<div class="modal-actions" style="margin-top:14px"><span class="spacer"></span>' +
      '<button id="shortcutHelpClose">Close</button></div>');
    $("shortcutHelpClose").onclick = () => hideModal("shortcutHelpModal");
    showModal("shortcutHelpModal", "shortcutHelpClose");
  }

  /* ============================== Right-click row menu ==============================
     A generic floating menu at the click point - not anchored to any one
     page - so a table's own row-render code just supplies the item list
     instead of each page building its own popup. `items` is an array of
     { label, onClick, danger? } or `null` for a divider. Reuses the same
     actions a row's own buttons/Manage modal already expose; this only adds
     a faster path to them for a mouse+keyboard desktop user. */
  let ctxMenuEl = null;
  function closeContextMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }
  function showContextMenu(x, y, items) {
    closeContextMenu();
    const el = document.createElement("div");
    el.className = "menu ctx-menu";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.innerHTML = items.map((it, i) => it
      ? '<button data-i="' + i + '"' + (it.danger ? ' class="danger"' : "") + ">" + esc(it.label) + "</button>"
      : "<hr>").join("");
    items.forEach((it, i) => {
      if (!it) return;
      el.querySelector('[data-i="' + i + '"]').onclick = () => { closeContextMenu(); it.onClick(); };
    });
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = Math.max(4, window.innerWidth - r.width - 4) + "px";
    if (r.bottom > window.innerHeight) el.style.top = Math.max(4, window.innerHeight - r.height - 4) + "px";
    ctxMenuEl = el;
  }
  document.addEventListener("click", closeContextMenu);
  document.addEventListener("contextmenu", e => {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeContextMenu();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeContextMenu(); });
  document.addEventListener("scroll", closeContextMenu, true);

  /* Styled, theme-aware replacement for window.confirm()/prompt() - native
     confirm() ignores the app's dark theme, blocks the render thread, and
     bypasses the focus-trap/aria-modal work every other dialog here gets.
     Resolves true/false; never rejects. Pass typeToConfirm (e.g. "ERASE")
     for the extra-friction, type-the-word confirmation reserved for
     account-wide/irreversible actions - everything else gets a single
     styled Confirm/Cancel. altLabel adds a second action button beside the
     main one, for a "which way?" choice (Deck List's Build into a saved
     deck: add to its list or replace it, #309); pressing it resolves "alt"
     (true for the main button, false for Cancel/Esc/outside click). choose
     ({ label, options: [{ value, label }], value }) adds a dropdown for a
     "which one?" pick (#489: which sorting tray); on confirm, the chosen
     value is written back to choose.value. */
  // A second confirmDialog() call before an earlier one's Promise settled used
  // to silently orphan that earlier Promise forever: the shared #confirmModal
  // markup (box.innerHTML below) gets overwritten out from under it, so its
  // captured okBtn/cancelBtn are detached nodes nothing can click anymore -
  // whatever `await`ed that first call just hangs. Real-world trigger: two
  // pick lists confirmed in quick succession (ship one, immediately act on
  // another) - the first's "Complete"/"Ship" never actually resolves, so
  // that pick list silently never gets marked shipped even though the user
  // believes they confirmed it. Settling any pending confirm as a cancel
  // before opening a new one closes that gap.
  let cancelPendingConfirm = null;
  function confirmDialog(message, opts) {
    if (cancelPendingConfirm) { const c = cancelPendingConfirm; cancelPendingConfirm = null; c(); }
    const o = opts || {};
    let el = $("confirmModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "confirmModal";
      el.className = "modal-backdrop";
      el.hidden = true;
      el.innerHTML = '<div class="modal" role="dialog" aria-modal="true"></div>';
      el.addEventListener("click", e => { if (e.target === el) hideModal("confirmModal"); });
      document.body.appendChild(el);
    }
    const box = el.querySelector(".modal");
    const typed = o.typeToConfirm;
    box.innerHTML =
      "<h3>" + esc(o.title || "Are you sure?") + "</h3>" +
      '<div class="hint" style="margin-top:0;white-space:pre-wrap">' + esc(message) + "</div>" +
      (typed
        ? '<label style="margin-top:12px">Type <code>' + esc(typed) + '</code> to confirm' +
          '<input id="confirmTypeInput" autocomplete="off"></label>'
        : "") +
      (o.choose
        ? '<label style="margin-top:12px">' + esc(o.choose.label || "Choose") + ' <select id="confirmChoose">' +
          (o.choose.options || []).map(c => '<option value="' + esc(c.value) + '"' + (c.value === o.choose.value ? " selected" : "") + ">" +
            esc(c.label) + "</option>").join("") + "</select></label>"
        : "") +
      '<div class="modal-actions" style="margin-top:16px"><span class="spacer"></span>' +
        '<button id="confirmCancelBtn" class="ghost">' + esc(o.cancelLabel || "Cancel") + "</button>" +
        (o.altLabel ? '<button id="confirmAltBtn">' + esc(o.altLabel) + "</button>" : "") +
        '<button id="confirmOkBtn" class="' + (o.danger ? "danger" : "primary") + '"' +
          (typed ? " disabled" : "") + ">" + esc(o.okLabel || "Confirm") + "</button></div>";
    return new Promise(resolve => {
      const okBtn = $("confirmOkBtn"), cancelBtn = $("confirmCancelBtn"), altBtn = o.altLabel ? $("confirmAltBtn") : null;
      const typeInput = typed ? $("confirmTypeInput") : null;
      const checkTyped = () => { okBtn.disabled = typeInput.value !== typed; };
      if (typeInput) typeInput.addEventListener("input", checkTyped);
      const finish = v => { cleanup(); hideModal("confirmModal"); resolve(v); };
      okBtn.onclick = () => { if (o.choose) o.choose.value = $("confirmChoose").value; finish(true); };
      cancelBtn.onclick = () => finish(false);
      if (altBtn) altBtn.onclick = () => finish("alt");
      function cleanup() {
        cancelPendingConfirm = null;
        okBtn.onclick = null; cancelBtn.onclick = null;
        if (altBtn) altBtn.onclick = null;
        if (typeInput) typeInput.removeEventListener("input", checkTyped);
        onClose("confirmModal", null);
      }
      onClose("confirmModal", () => { cleanup(); resolve(false); });
      cancelPendingConfirm = () => finish(false);
      showModal("confirmModal", typeInput ? "confirmTypeInput" : "confirmCancelBtn");
    });
  }

  /* Styled replacement for window.prompt() - same reasoning as confirmDialog
     above. Resolves the entered string, or null if cancelled (matching
     prompt()'s own contract so call sites didn't need to change shape). */
  function promptDialog(message, opts) {
    const o = opts || {};
    let el = $("promptModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "promptModal";
      el.className = "modal-backdrop";
      el.hidden = true;
      el.innerHTML = '<div class="modal" role="dialog" aria-modal="true"></div>';
      el.addEventListener("click", e => { if (e.target === el) hideModal("promptModal"); });
      document.body.appendChild(el);
    }
    const box = el.querySelector(".modal");
    box.innerHTML =
      "<h3>" + esc(o.title || "") + "</h3>" +
      '<label style="margin-top:2px">' + esc(message) +
        // opts.password: a masked "confirm it's you" field, so a password
        // manager can fill it and it never shows on screen.
        '<input id="promptInput" ' + (o.password ? 'type="password" autocomplete="current-password"' : 'autocomplete="off"') +
        ' placeholder="' + esc(o.placeholder || "") + '"></label>' +
      '<div class="modal-actions" style="margin-top:12px"><span class="spacer"></span>' +
        '<button id="promptCancelBtn" class="ghost">Cancel</button>' +
        '<button id="promptOkBtn" class="primary">' + esc(o.okLabel || "OK") + "</button></div>";
    $("promptInput").value = o.value || "";
    return new Promise(resolve => {
      const okBtn = $("promptOkBtn"), cancelBtn = $("promptCancelBtn"), input = $("promptInput");
      const finish = v => { cleanup(); hideModal("promptModal"); resolve(v); };
      okBtn.onclick = () => finish(input.value);
      cancelBtn.onclick = () => finish(null);
      const onKey = e => { if (e.key === "Enter") { e.preventDefault(); finish(input.value); } };
      input.addEventListener("keydown", onKey);
      function cleanup() {
        okBtn.onclick = null; cancelBtn.onclick = null;
        input.removeEventListener("keydown", onKey);
        onClose("promptModal", null);
      }
      onClose("promptModal", () => { cleanup(); resolve(null); });
      showModal("promptModal", "promptInput");
    });
  }

  /* ============================== Cha-ching ============================== */
  let audioCtx = null;
  const chimed = new Set();
  function playChing() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      [[1318.5, 0], [1975.5, 0.09]].forEach(([hz, off]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "triangle"; o.frequency.value = hz;
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + off + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.42);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0 + off); o.stop(t0 + off + 0.45);
      });
    } catch (e) { /* no audio available - not worth reporting */ }
  }
  function chime(price, key) {
    if (G.pref("chime") !== true || price == null) return;
    const min = G.pref("chimeMin") == null ? 20 : Number(G.pref("chimeMin"));
    if (!(price >= min)) return;
    if (key) { if (chimed.has(key)) return; chimed.add(key); }
    playChing();
  }

  /* ============================== Card preview panel ============================== */
  /* One panel, three sources: a printing picked by name, a set+number being
     typed, or an inventory row that was clicked. Now it also shows where the
     putaway rules say the card belongs. */
  function CardPanel(containerId, opts) {
    const o = opts || {};
    const host = $(containerId);
    host.innerHTML =
      '<div class="pt">Card preview</div>' +
      '<div class="card-preview" id="' + containerId + '_img">' +
        '<div class="ph">' + esc(o.placeholder ||
          "Search a card, or type a set code and collector number, to preview it here.") + '</div></div>' +
      '<div class="cardmeta" id="' + containerId + '_meta" hidden></div>' +
      (o.chime === false ? "" :
        '<label class="chime-row" title="Plays a cha-ching when a previewed or added card is worth at least this much">' +
        '<input type="checkbox" id="' + containerId + '_chimeOn" style="width:auto"> <svg class=ic aria-hidden=true><use href=/icons/sprite.svg#bell></use></svg> ' + (G.simpleMode ? "Sound for cards worth over $" : "Cha-ching over $") +
        '<input type="number" id="' + containerId + '_chimeMin" min="0" step="1"></label>');

    const imgEl = $(containerId + "_img");
    const metaEl = $(containerId + "_meta");
    imgEl.addEventListener("click", e => {
      const img = e.target.closest("img");
      if (img) lightbox(img.src, img.alt);
    });
    if (o.chime !== false) {
      const on = $(containerId + "_chimeOn"), min = $(containerId + "_chimeMin");
      const sync = () => {
        on.checked = G.pref("chime") === true;
        min.value = G.pref("chimeMin") == null ? 20 : G.pref("chimeMin");
      };
      G.on("loaded", sync);
      if (G.loaded) sync();
      // Per person (#159): in a store, this is your chime, not everyone's.
      const saveFailed = e => toast("Couldn't save the chime setting: " + e.message, "err");
      on.addEventListener("change", () => { G.setPersonalPrefs({ chime: on.checked }).catch(saveFailed); });
      min.addEventListener("change", () => {
        const v = parseFloat(min.value);
        G.setPersonalPrefs({ chimeMin: isNaN(v) ? 0 : v }).catch(saveFailed);
      });
    }

    let token = 0;

    function message(msg) {
      imgEl.innerHTML = '<div class="ph">' + esc(msg) + "</div>";
      metaEl.hidden = true; metaEl.innerHTML = "";
    }
    function clear() { message(o.placeholder || "Search a card, or type a set code and collector number, to preview it here."); }

    function render(v) {
      imgEl.innerHTML = v.img
        ? '<img src="' + esc(v.img) + '" alt="' + esc(v.name || "") + '" title="Click to enlarge">'
        : '<div class="ph">No image available for this printing.</div>';
      const rar = v.rarity ? v.rarity.charAt(0).toUpperCase() + v.rarity.slice(1) : "";
      let html = '<div class="cm-name">' + esc(v.name || "") + "</div>" +
        '<div class="cm-print">' + esc(v.printing || "") + "</div>";
      if (v.typeLine || rar) {
        html += '<div class="cm-type">' + esc(v.typeLine || "") +
          (rar ? ' <span class="pill">' + esc(rar) + "</span>" : "") + "</div>";
      }
      html += '<div class="cm-prices"><span class="cm-price">' + money(v.price) + "</span>" +
        "<span>" + finishBadge(v.finish) + "</span>" +
        (v.altPrice != null ? '<span class="muted">' + esc((G.FINISH_NAMES[v.altFinish] || "").toLowerCase()) + " " + money(v.altPrice) + "</span>" : "") +
        "</div>";
      if (v.note) html += '<div class="cm-note">' + esc(v.note) + "</div>";
      if (v.putaway) html += '<div class="cm-putaway">' + v.putaway + "</div>";
      metaEl.innerHTML = html;
      metaEl.hidden = false;
      scrollPreviewIntoView();
      return v.price;
    }

    /* Below 1400px (app.css's .cols breakpoint) this panel stops being a sticky
       side column and stacks below the page's form/table instead - often a full
       screen or more of scrolling away, with no other cue that it changed. Bring
       it into view and flash it so picking/scanning a card on a phone doesn't
       silently update a panel the user isn't looking at. Above that width the
       panel is already visible in its sticky column, so this is a no-op there. */
    function scrollPreviewIntoView() {
      if (o.inline) return;   // inside the card slide-over: already in view
      if (!window.matchMedia || !window.matchMedia("(max-width:1400px)").matches) return;
      const panel = host.closest(".card-panel") || host;
      // Only when the panel really is stacked below its form: in a side column
      // (.sticky) it is already in view, and scrolling would just jump the page.
      if (window.getComputedStyle(panel).position === "sticky") return;
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      panel.classList.remove("preview-flash");
      void panel.offsetWidth;
      panel.classList.add("preview-flash");
    }

    /* Shows the split, not just the winner: a one-of-each binder taking one copy
       and an overflow bin taking the other three is the normal answer, and
       hiding that would make the preview lie. */
    function putawayHtml(cardLike, qty) {
      if (G.simpleMode) return ""; // putaway rules are a business-mode feature (#325)
      const n = Math.max(1, qty || 1);
      const a = G.allocatePutaway(cardLike, n, {});
      if (!a.considered) {
        return '<span class="muted">No location has putaway rules yet — ' +
          '<a href="/locations.html">set them up</a> and this will tell you where the card belongs.</span>';
      }
      if (a.picks.length) {
        const lines = a.picks.map(p => {
          const why = p.rules.length
            ? p.rules.map(r => "<code>" + esc(G.ruleText(r)) + "</code>").join(" · ")
            : "catch-all (no rules)";
          const lim = p.perName != null
            ? "max " + p.perName + " of this card, holds " + p.nameHeld
            : (p.cap == null ? "no limit" : "ceiling " + p.cap);
          return (p.overflow ? "↳ " : "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg> ") + "<b>" + esc(p.name) + "</b>" +
            (a.split ? " × " + p.take : "") +
            ' <span class="pill type">' + esc(p.type) + "</span>" +
            '<div class="muted" style="margin:2px 0 5px">' + why + " · " + esc(lim) + "</div>";
        }).join("");
        return lines + (a.shortfall
          ? '<span class="warn">' + a.shortfall + " cop" + (a.shortfall === 1 ? "y" : "ies") +
            " have nowhere to go.</span>"
          : "");
      }
      const blocked = a.candidates.filter(c => c.free <= 0);
      if (blocked.length) {
        const b = blocked[0];
        return '<span class="warn"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg> ' + esc(b.name) + " matches but is full (" +
          (b.blockedBy === "per-name"
            ? "already holds " + b.nameHeld + " of " + b.perName + " allowed"
            : b.cards + " / " + b.cap) + ").</span>";
      }
      return '<span class="muted"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg> No location\'s putaway rules match this card.</span>';
    }

    /* From a server card object. */
    function showCard(card, finish, note, opts2) {
      const o2 = opts2 || {};
      finish = G.normalizeFinish(finish) || "nonfoil";
      // Contrast the picked finish against non-foil (or, if non-foil is what's
      // picked, against foil) - the same two-way "what's the other one worth"
      // hint the old foil/non-foil toggle gave, etched just inherits the
      // non-foil side of it rather than adding a three-way comparison.
      const altFinish = finish === "nonfoil" ? "foil" : "nonfoil";
      const shaped = Object.assign({}, card, {
        name: G.cardName(card),
        price: G.priceOf(card, finish),
        finish,
        lang: card.lang
      });
      const v = {
        name: G.cardName(card),
        printing: G.printingLabel(card.set, card.collector, card.setName),
        typeLine: card.typeLine || "",
        rarity: card.rarity || "",
        img: card.imageUrl || "",
        price: G.priceOf(card, finish),
        altPrice: G.priceOf(card, altFinish), altFinish,
        finish,
        note: note || (card.langFallback ? "That language isn't on Scryfall — showing the default print." : ""),
        putaway: o2.putaway === false ? null : putawayHtml(shaped, o2.qty || 1)
      };
      return render(v);
    }

    /* From an inventory row - no network needed. */
    function showRecord(r, opts2) {
      const o2 = opts2 || {};
      return render({
        name: r.name, printing: G.recPrinting(r), typeLine: r.typeLine, rarity: r.rarity,
        img: r.imageUrl, price: r.price, altPrice: null, finish: r.finish,
        putaway: o2.putaway === false ? null
          : putawayHtml(r, r.quantity) +
            (Number(r.costQty) > 0
              ? '<div class="muted" style="margin-top:5px">Cost basis ' + money(r.avgCost) + " each across " +
                r.costQty + " of " + r.quantity + " cop" + (r.quantity === 1 ? "y" : "ies") + "</div>"
              : '<div class="muted" style="margin-top:5px">No cost basis recorded for this stack.</div>')
      });
    }

    /* Look up a set+number and show it. Guarded so an older keystroke cannot win. */
    async function showBySetNumber(set, num, lang, finish) {
      set = String(set || "").trim().toLowerCase();
      num = String(num || "").trim();
      if (!set || !num) { message("Enter a set code and collector number to preview the card and its price."); return null; }
      const t = ++token;
      const key = G.printKey(set, num, lang);
      if (!G.cardCache.has(key)) message("Looking up " + set.toUpperCase() + " #" + num + " …");
      let card;
      try { card = await G.cards.one(set, num, lang); }
      catch (e) { if (t === token) message("Lookup failed: " + e.message); return null; }
      if (t !== token) return null;
      if (!card) { message("No card found for " + set.toUpperCase() + " #" + num + "."); return null; }
      const price = showCard(card, finish);
      chime(price, key + "|" + (finish || "nonfoil"));
      return card;
    }

    return { message, clear, render, showCard, showRecord, showBySetNumber, putawayHtml, bump: () => ++token };
  }

  /* ============================== Card row consistency ==============================
     Every table that lists cards is supposed to behave the same way (2026-09-05 ask):
     an art-crop thumbnail column, hovering a row shows the full card, and clicking a
     row is reserved for reviewing/managing that card - never a lightbox zoom, never a
     history jump hidden behind the row itself (a page can still offer those as their
     own explicit buttons). This section is the shared plumbing so each page's row
     renderer is a couple of calls, not its own copy-pasted version. */

  /* Hover has no touch equivalent - a tap can't "hover then leave," so wiring
     mouseenter/mousemove/mouseleave on a touch-primary device either never
     fires (nothing to see) or, worse, shows the preview after a tap with no
     mouseleave ever coming to close it again. (hover: hover) plus
     (pointer: fine) is the real capability check, not a screen-width guess -
     a touch laptop with a mouse plugged in still gets it, and a desktop
     window narrowed for testing doesn't lose it. Read once; this doesn't
     change mid-session. */
  const SUPPORTS_HOVER = !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches);

  /* Hover-to-preview: a small floating card image that follows the cursor. Originally
     built once for Movers; promoted here so every table gets it instead of each page
     hand-rolling its own copy. Lazily injects its own DOM (position:fixed, so it
     doesn't need a spot in any particular page's layout) rather than requiring every
     page's HTML to carry the markup. */
  function ensureHoverPreviewEl() {
    let el = $("cardHoverPreview");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cardHoverPreview";
    el.className = "hover-preview";
    el.hidden = true;
    el.innerHTML = '<img alt="" id="cardHoverPreviewImg">';
    document.body.appendChild(el);
    return el;
  }
  function positionHoverPreview(x, y) {
    const el = ensureHoverPreviewEl();
    const pad = 18;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth || 260, h = el.offsetHeight || 360;
    let left = x + pad, top = y + pad;
    if (left + w > vw) left = x - w - pad;
    if (top + h > vh) top = vh - h - pad;
    el.style.left = Math.max(4, left) + "px";
    el.style.top = Math.max(4, top) + "px";
  }
  function showHoverPreview(url, x, y) {
    if (!url) return;
    ensureHoverPreviewEl();
    $("cardHoverPreviewImg").src = url;
    $("cardHoverPreview").hidden = false;
    positionHoverPreview(x, y);
  }
  function hideHoverPreview() { const el = $("cardHoverPreview"); if (el) el.hidden = true; }
  /* Wires the three mouse events a row needs onto `el` for one image URL - the usual
     case. Pass a function instead of a string when the row's card can change after
     render (e.g. a grouped/summarized row - see artForGroup below). Assigns the
     on* properties directly rather than addEventListener - several tables (WMS/ERP/
     Storefront grids) reuse the same <tr> node across renders and re-wire it each
     time its data changes, and addEventListener would stack a duplicate listener on
     every re-wire instead of replacing it. */
  function wireHoverPreview(el, imageUrlOrFn) {
    if (!SUPPORTS_HOVER) return;
    const urlOf = typeof imageUrlOrFn === "function" ? imageUrlOrFn : () => imageUrlOrFn;
    el.onmouseenter = e => showHoverPreview(urlOf(), e.clientX, e.clientY);
    el.onmousemove = e => { const p = $("cardHoverPreview"); if (p && !p.hidden) positionHoverPreview(e.clientX, e.clientY); };
    el.onmouseleave = hideHoverPreview;
  }

  /* One `<td>` for an art-crop thumbnail column - same markup/classes Inventory's WMS
     grid already used (`.col-art`/`.art-thumb`), just factored out so every other
     table's row renderer can produce an identical cell instead of re-inventing it. */
  function artThumbTd(imageUrl) {
    const art = G.artCropUrl(imageUrl);
    return '<td class="col-art">' + (art ? '<img class="art-thumb" src="' + esc(art) + '" alt="" loading="lazy">' : "") + "</td>";
  }

  /* Sold 7d (#366): copies sold on Manapool in the last 7 days, the same
     look as Movers' Sold 7d column (#209, movers.page.js sfNum/sfFlag).
     "≥ 12" when the count is a minimum (the title says why); SELLING FAST
     is an icon plus words, never colour alone. */
  function soldNum(n, atLeast, what) {
    return atLeast
      ? '<span title="At least ' + n + " " + what + " - Manapool's history for this window is incomplete or capped, so the real number may be higher\">≥ " + n + "</span>"
      : String(n);
  }
  // The full SELLING FAST flag, icon + words: Movers' sfFlag look, for the
  // Buy List watch list (#369).
  // `wrap` lets it break onto two lines in a crowded table, as Target hit does.
  const sellingFastFlag = wrap => '<span class="badge sale"' + (wrap ? "" : ' style="white-space:nowrap"') + ' title="Separate sales in the last 7 days came well above their usual pace">' +
    icon("trending-up") + " SELLING FAST</span>";
  // Short form for the wide Listings and Inventory grids, where the full
  // words would push their own columns off the screen; the title and a
  // screen reader still say SELLING FAST.
  const sellingFastBadge = () => '<span class="badge sale" title="SELLING FAST: separate sales in the last 7 days came well above their usual pace">' +
    icon("trending-up") + ' FAST<span class="sr-only"> (selling fast)</span></span>';
  // Why a stack's Sold 7d is blank (G.soldOf gave null).
  function soldWhyNot() {
    const s = G.soldSales();
    if (!s) return "Loading Manapool sales…";
    if (s.error) return s.error;
    if (!s.historySince) return "No Manapool sales history has been collected yet.";
    return "This printing couldn't be matched to Manapool.";
  }
  /* A stack's Sold 7d cell from G.soldOf(r): `cls` adds the column's classes
     (col-sold7d, hide-sm). data-v sorts it; a blank sorts last. */
  function soldTd(r, cls) {
    const x = G.soldOf(r);
    const c = "num sold7d" + (cls ? " " + cls : "");
    if (!x) return '<td class="' + c + '" data-v="" title="' + esc(soldWhyNot()) + '"><span class="faint">—</span></td>';
    return soldCountTd(x.n, x.atLeast, x.hot, cls);
  }
  // The same cell from numbers already in hand (Buy List's Restock, #370).
  function soldCountTd(n, atLeast, hot, cls) {
    return '<td class="num sold7d' + (cls ? " " + cls : "") + '" data-v="' + n + '">' + soldNum(n, atLeast, "copies in 7 days") +
      (hot ? " " + sellingFastBadge() : "") + "</td>";
  }
  // The sort value for a Sold 7d column: unknown below every real count.
  const soldSortValue = r => { const x = G.soldOf(r); return x ? x.n : -1; };
  // What a Sold 7d cell shows, as a string, for a grid row's fingerprint.
  const soldFp = r => { const x = G.soldOf(r); return x ? x.n + (x.atLeast ? "+" : "") + String(x.hot) : soldWhyNot(); };
  /* Wires hover-to-preview onto JUST a row's art-crop cell (`.col-art`, from
     artThumbTd above) - not the whole row. Direct ask (2026-09-05): the full-card
     popup should only appear from hovering the thumbnail itself, since a row's other
     cells are for reading data, not for triggering a popup as a side effect of
     glancing at a price. No-ops quietly if the row has no art cell/image - nothing
     to hover. */
  function wireArtHover(tr, imageUrlOrFn) {
    const cell = tr.querySelector(".col-art");
    if (!cell) return;
    const urlOf = typeof imageUrlOrFn === "function" ? imageUrlOrFn : () => imageUrlOrFn;
    if (!urlOf()) { cell.onmouseenter = cell.onmousemove = cell.onmouseleave = null; return; }
    wireHoverPreview(cell, urlOf);
  }

  /* For a summarized/grouped row (several printings folded into one line): pick the
     art from a member that's actually owned when one exists, falling back to
     whichever came first otherwise. `rows` is the group's member rows; `ownedTest`
     defaults to "has a positive quantity," the shape every owned-stack row already
     has, but callers with a different shape for "owned" can override it. */
  function artForGroup(rows, ownedTest) {
    if (!rows || !rows.length) return "";
    const isOwned = ownedTest || (r => (r.quantity || r.qty || 0) > 0);
    const owned = rows.find(r => isOwned(r) && r.imageUrl);
    return (owned || rows.find(r => r.imageUrl) || rows[0]).imageUrl || "";
  }

  /* ============================== Card panel (#410) ==============================
     "Every record is a doorway" (design-guidelines 4.10): clicking a card name
     anywhere opens this one slide-over on top of the page - the printing and
     price, where it is held, listed, sold, recent activity, then the same set of
     go-to links on every page. Built here and nowhere else: a page puts
     UI.cardLink(card) in its name cell and the click is handled below, so no
     page hand-rolls the panel or the link set. reviewCard/reviewRecord (the old
     popup's callers) open the same panel. */
  const CP_ID = "cardPanel";
  let cpPanel = null, cpToken = 0, cpBack = null, cpGroupName = "", cpGroupRows = [];
  const cpSet = x => String(x || "").toLowerCase();
  const cpNum = x => String(x == null ? "" : x).toLowerCase();
  function cardIdentity(x) {
    x = x || {};
    return { name: x.name || (x.printedName ? x.printedName : ""), set: cpSet(x.set), collector: String(x.collector == null ? "" : x.collector),
      finish: G.normalizeFinish(x.finish) || (x.foil ? "foil" : "nonfoil"), lang: x.lang || "en", imageUrl: x.imageUrl || "" };
  }
  // The card filter every target page reads: ?q=<name>&set=<code>&collector=<#>.
  function cardParams(id) {
    return "q=" + encodeURIComponent(id.name) +
      (id.set && id.collector ? "&set=" + encodeURIComponent(id.set) + "&collector=" + encodeURIComponent(id.collector) : "");
  }
  /* The one "go to" set: In inventory · Price history · Listings · Sales ·
     History · Buy list. Listings and Sales are business-mode pages. */
  function cardLinks(card) {
    const id = cardIdentity(card), p = cardParams(id);
    const out = [
      { label: "In inventory", href: "/inventory.html?" + p },
      { label: "Price history", href: "/movers.html?hist=1&" + p + "&finish=" + id.finish + "&lang=" + encodeURIComponent(id.lang) }
    ];
    if (!G.simpleMode) {
      out.push({ label: "Listings", href: "/listings.html?q=" + encodeURIComponent(id.name) });
      out.push({ label: "Sales", href: "/accounting.html?" + p });
    }
    out.push({ label: "History", href: "/audit-log.html?" + p });
    out.push({ label: "Buy list", href: "/buy-list.html?" + p });
    return out;
  }
  /* Outbound "See on" links: Mana Pool, Scryfall, EDHREC (public pages, new tab).
     A card with no single printing (the grouped name view) gets name-level URLs. */
  function cardOutLinks(card) {
    const id = cardIdentity(card);
    id.name = (card && card.englishName) || id.name;   // printed names (foreign stacks) don't resolve on these sites
    const front = id.name.split(" // ")[0];
    const edh = "https://edhrec.com/cards/" + G.slugify(front.replace(/['\u2019]/g, ""));
    if (!id.set || !id.collector) {
      return [
        { label: "Mana Pool", href: G.manapoolSearchUrl(id.name) },
        { label: "Scryfall", href: "https://scryfall.com/search?q=" + encodeURIComponent('!"' + id.name + '"') },
        { label: "EDHREC", href: edh }
      ];
    }
    return [
      { label: "Mana Pool", href: G.manapoolUrl(id.set, id.collector, id.name) },
      { label: "Scryfall", href: "https://scryfall.com/card/" + encodeURIComponent(id.set) + "/" + encodeURIComponent(id.collector) + (id.lang !== "en" ? "/" + encodeURIComponent(id.lang) : "") },
      { label: "EDHREC", href: edh }
    ];
  }
  function seeOnSec(card) {
    return '<div class="cp-sec"><div class="eyebrow">See on</div><div class="cp-links">' +
      cardOutLinks(card).map(l => '<a href="' + esc(l.href) + '" target="_blank" rel="noopener noreferrer">' + esc(l.label) + " " + icon("external-link") + "</a>").join("") + "</div></div>";
  }
  /* A card's name as a link that opens the panel (the click is delegated, below). */
  function cardLink(card, text) {
    const id = cardIdentity(card);
    const label = text == null ? id.name : text;
    if (!id.set || !id.collector) return id.name ? cardNameLink(id.name, label) : esc(label);   // no single printing: the grouped printing list
    return '<a class="card-link" href="/inventory.html?' + esc(cardParams(id)) + '" data-name="' + esc(id.name) +
      '" data-set="' + esc(id.set) + '" data-collector="' + esc(id.collector) + '" data-finish="' + esc(id.finish) +
      '" data-lang="' + esc(id.lang) + '" data-img="' + esc(id.imageUrl) + '">' + esc(label) + "</a>";
  }

  /* Everything the panel says about a printing that is already in memory, in
     single passes over the stacks and the pick lists (70k stacks: one scan per
     open, never per row). Holdings are `quantity` per location (lent copies
     are still yours); the lent count is shown beside it. */
  function cardFacts(id) {
    const byLoc = new Map();
    let total = 0, listed = 0, lent = 0, rec = null;
    for (const r of G.state.cards) {
      if (cpSet(r.set) !== id.set || cpNum(r.collector) !== cpNum(id.collector)) continue;
      if (!rec || (r.finish === id.finish && rec.finish !== id.finish)) rec = r;
      total += Number(r.quantity) || 0; listed += Number(r.listedQty) || 0; lent += G.lentQty(r);
      let l = byLoc.get(r.locationId);
      if (!l) byLoc.set(r.locationId, l = { id: r.locationId, qty: 0, kinds: new Set() });
      l.qty += Number(r.quantity) || 0;
      l.kinds.add((r.finish && r.finish !== "nonfoil" ? G.FINISH_NAMES[r.finish].toLowerCase() + " " : "") + (r.condition || "NM"));
    }
    const cutoff = Date.now() - 90 * 864e5;
    let sold = 0, revenue = 0, soldOrders = 0;
    const orders = [];
    for (const p of G.state.pickLists || []) {
      // Orders only (Manapool and counter sales), counted and dated like the other sales figures (G.saleDate).
      const when = G.isOrderSale(p) ? G.saleDate(p) : null;
      if (!when) continue;
      let n = 0, rev = 0;
      for (const it of p.lines || []) {
        if (it.kind === "sealed" || cpSet(it.set) !== id.set || cpNum(it.collector) !== cpNum(id.collector)) continue;
        const q = it.pickedResult ? it.pickedResult.pulls.reduce((s, x) => s + (Number(x.qty) || 0), 0) : (Number(it.qty) || 0);
        n += q;
        if (it.unitPrice != null) rev += it.unitPrice * q;
      }
      if (!n) continue;
      const t = Date.parse(when);
      orders.push({ p, n, t });
      if (t >= cutoff) { sold += n; revenue += rev; soldOrders++; }
    }
    orders.sort((a, b) => b.t - a.t);
    return { rec, total, listed, lent, locs: [...byLoc.values()].sort((a, b) => b.qty - a.qty), sold, revenue, soldOrders, orders: orders.slice(0, 3) };
  }
  const cpSec = (title, html) => '<div class="cp-sec"><div class="eyebrow">' + title + "</div>" + html + "</div>";
  function cardFactsHtml(id, f) {
    const copies = n => n + " cop" + (n === 1 ? "y" : "ies");
    let hold;
    if (!f.total) hold = '<div class="muted">You don\'t hold this printing.</div>';
    else {
      const shown = f.locs.slice(0, 10);
      hold = '<div class="cp-big">' + copies(f.total) + (f.lent ? ' <span class="muted">(' + f.lent + " lent out)</span>" : "") + "</div><ul class=cp-list>" +
        shown.map(l => '<li><a href="/inventory.html?loc=' + encodeURIComponent(l.id) + '" data-go>' + esc(G.locName(l.id)) + "</a> " +
          '<span class="num">× ' + l.qty + '</span> <span class="muted">' + esc([...l.kinds].join(", ")) + "</span></li>").join("") +
        (f.locs.length > shown.length ? '<li class="muted">and ' + (f.locs.length - shown.length) + " more locations</li>" : "") + "</ul>";
    }
    let h = cpSec("You hold", hold);
    if (!G.simpleMode) {
      h += cpSec("Listed", f.total ? "<div>" + f.listed + " of " + f.total + " listed for sale</div>" : '<div class="muted">Nothing to list.</div>');
      h += cpSec("Sold (90 days)", f.sold
        ? "<div>" + copies(f.sold) + " in " + f.soldOrders + " order" + (f.soldOrders === 1 ? "" : "s") + (f.revenue ? " · " + money(f.revenue) : "") + "</div>"
        : '<div class="muted">None sold in the last 90 days.</div>');
    }
    h += cpSec("Recent activity", '<ul class=cp-list>' + f.orders.map(o => {
      const label = G.pickListOrderLabel(o.p, null, false) || (G.isCounterSale(o.p) ? G.pickListTag(o.p) : "Pick list");
      const link = o.p.orderId ? '<a class="mono" href="/lists.html?order=' + encodeURIComponent(o.p.orderId) + '" data-go>' + esc(label) + "</a>"
        : G.isCounterSale(o.p) ? '<a class="mono" href="/lists.html?pick=' + encodeURIComponent(o.p.id) + '" data-go>' + esc(label) + "</a>" : esc(label);
      return "<li>" + esc(new Date(o.t).toLocaleDateString()) + " · sold " + o.n + " · " + link + "</li>";
    }).join("") + '</ul><div class="muted" id="cpAudit">Loading the audit log…</div>');
    h += '<div class="cp-sec"><div class="eyebrow">Go to</div><div class="cp-links">' +
      cardLinks(id).map(l => '<a href="' + esc(l.href) + '" data-go>' + esc(l.label) + "</a>").join("") + "</div></div>";
    h += seeOnSec(Object.assign({}, id, { englishName: f.rec && f.rec.englishName }));
    return h;
  }
  /* The two parts that need the server: the 30-day price change and the last
     few audit entries (receipts link into the log). */
  async function cardPanelLate(id, token) {
    const live = () => token === cpToken && $(CP_ID) && !$(CP_ID).hidden;
    G.api("/api/prices/history?key=" + encodeURIComponent(G.printKey(id.set, id.collector, id.lang)) +
      (G.state.settings.moversVendor ? "&vendor=" + encodeURIComponent(G.state.settings.moversVendor) : "")).then(h => {
      if (!live() || !h || !h.dates) return;
      const s = id.finish === "etched" ? h.etched : id.finish === "foil" ? h.foil : h.usd;
      if (!s) return;
      let last = -1;
      for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) { last = i; break; }
      if (last < 0) return;
      const want = Date.parse(h.dates[last]) - 30 * 864e5;
      let base = -1;
      for (let i = last; i >= 0; i--) if (s[i] != null && Date.parse(h.dates[i]) <= want) { base = i; break; }
      const el = $("cpMarket");
      if (!el) return;
      if (base < 0) { el.textContent = "Not enough price history for a 30-day change yet."; return; }
      const d = s[last] - s[base], pct = s[base] > 0 ? d / s[base] * 100 : null;
      el.innerHTML = "30 days: <b class=" + (d > 0 ? "pos" : d < 0 ? "neg" : "") + ">" + (d > 0 ? "+" : "") + money(d) +
        (pct == null ? "" : " (" + (d > 0 ? "+" : "") + pct.toFixed(1) + "%)") + "</b>";
    }).catch(() => {});
    try {
      const res = await G.queryAudit({ set: id.set, collector: id.collector, limit: 5, total: false });
      if (!live()) return;
      const rows = res.entries;
      const el = $("cpAudit");
      if (!el) return;
      el.outerHTML = rows.length ? '<ul class=cp-list>' + rows.map(e => "<li>" + esc(new Date(e.ts).toLocaleDateString()) + " · " +
        esc(String(e.action || "").toLowerCase()) + " " + (e.qty > 0 ? "+" : "") + (e.qty || 0) +
        (e.receiptId ? ' · <a class="mono" href="/audit-log.html?q=' + encodeURIComponent(e.receiptId) + '" data-go>' + esc(e.receiptId) + "</a>" : "") +
        "</li>").join("") + "</ul>" : '<div class="muted">No audit entries for this printing.</div>';
    } catch (e) {
      if (live() && $("cpAudit")) $("cpAudit").textContent = "Couldn't load the audit log.";
    }
  }
  function ensureCardPanel() {
    if (cpPanel) return cpPanel;
    const el = document.createElement("div");
    el.id = CP_ID; el.className = "modal-backdrop slideover"; el.hidden = true;
    el.innerHTML = '<div class="slideover-panel" role="dialog" aria-modal="true" aria-label="Card details">' +
      '<div class="slideover-head">' +
      '<button type="button" class="small ghost" id="cardPanelBack" hidden title="Back to the printing list" aria-label="Back to the printing list"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#arrow-left></use></svg></button>' +
      '<span class="eyebrow">Card</span>' +
      '<button type="button" class="small ghost" data-close id="cardPanelClose" title="Close" aria-label="Close"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#x></use></svg></button></div>' +
      '<div class="slideover-body"><div id="cpGroup" hidden></div><div id="cardPanelHost"></div><div id="cpMarket" class="muted cp-market"></div><div id="cpFacts"></div></div></div>';
    document.body.appendChild(el);
    el.addEventListener("click", e => {
      const a = e.target.closest && e.target.closest("a[data-go]");
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      go(a.getAttribute("href"));
    });
    $("cardPanelBack").addEventListener("click", () => { if (cpBack) openCardGroup(cpBack); });
    $("cpGroup").addEventListener("click", e => {
      const a = e.target.closest && e.target.closest("[data-pi]");
      if (!a) return;
      e.preventDefault();
      const r = cpGroupRows[Number(a.dataset.pi)];
      if (r) { const name = cpGroupName; openCardPanel(r, p => p.showRecord(r, { putaway: false }), name); }
    });
    const so = slideOver(CP_ID);
    cpPanel = { el, so, card: CardPanel("cardPanelHost", { chime: false, inline: true }) };
    return cpPanel;
  }
  /* show(panel) draws the top of the panel (image, name, price); the sections
     underneath are the same whatever opened it. */
  function openCardPanel(raw, show, backName) {
    const id = cardIdentity(raw);
    const p = ensureCardPanel();
    const token = ++cpToken;
    cpBack = backName || null;
    $("cardPanelBack").hidden = !cpBack;
    $("cpGroup").hidden = true;
    for (const x of ["cardPanelHost", "cpMarket", "cpFacts"]) $(x).hidden = false;
    const f = id.set && id.collector ? cardFacts(id) : null;
    p.card.bump();
    $("cpMarket").textContent = "";
    if (show) show(p.card);
    else if (f && f.rec) p.card.showRecord(f.rec, { putaway: false });
    else {
      p.card.message("Looking up " + (id.name || "the card") + " …");
      G.cards.one(id.set, id.collector, id.lang).then(card => {
        if (token !== cpToken) return;
        if (card) p.card.showCard(card, id.finish, "", { putaway: false });
        else p.card.message("No card found for " + id.set.toUpperCase() + " #" + id.collector + ".");
      }, e => { if (token === cpToken) p.card.message("Lookup failed: " + e.message); });
    }
    $("cpFacts").innerHTML = f ? cardFactsHtml(id, f) : "";
    p.so.open("cardPanelClose");
    if (f) cardPanelLate(id, token);
  }
  /* A card NAME with no single printing (a grouped row: Statistics by name,
     Movers' card view, Inventory's by-name view): the panel opens on a list of
     the printings you hold, each opening its own full panel with a back
     arrow. One pass over the stacks gathers them all. */
  function cardNameLink(name, text) {
    const n = String(name == null ? "" : name).trim();
    const label = text == null ? n : text;
    if (!n) return esc(label);
    return '<a class="card-link" href="/inventory.html?q=' + encodeURIComponent(n) + '" data-group="1" data-name="' + esc(n) + '">' + esc(label) + "</a>";
  }
  function openCardGroup(name) {
    const p = ensureCardPanel();
    ++cpToken; cpBack = null;
    p.card.bump();
    const key = String(name).toLowerCase();
    const by = new Map();
    let total = 0, lent = 0;
    for (const r of G.state.cards) {
      if (r.name !== name && String(r.name || "").toLowerCase() !== key) continue;
      const k = cpSet(r.set) + "|" + cpNum(r.collector) + "|" + (r.finish || "nonfoil");
      let g = by.get(k);
      if (!g) by.set(k, g = { rec: r, qty: 0, conds: new Set() });
      const q = Number(r.quantity) || 0;
      g.qty += q; total += q; lent += G.lentQty(r);
      g.conds.add(r.condition || "NM");
      if ((Number(r.price) || 0) > (Number(g.rec.price) || 0)) g.rec = r;
    }
    const groups = [...by.values()].sort((a, b) => b.qty - a.qty);
    cpGroupName = name; cpGroupRows = groups.map(g => g.rec);
    const first = groups[0] && groups[0].rec;
    const q = encodeURIComponent(name);
    const links = [{ label: "In inventory", href: "/inventory.html?q=" + q }, { label: "Price history", href: "/movers.html?q=" + q }];
    if (!G.simpleMode) {
      links.push({ label: "Listings", href: "/listings.html?q=" + q });
      links.push({ label: "Sales", href: "/accounting.html?q=" + q });
    }
    links.push({ label: "History", href: "/audit-log.html?q=" + q });
    links.push({ label: "Buy list", href: "/buy-list.html?q=" + q });
    $("cpGroup").innerHTML =
      (first && first.imageUrl ? '<img class="cp-art" alt="" loading="lazy" src="' + esc(first.imageUrl) + '">' : "") +
      '<div class="cp-big">' + esc(name) + "</div>" +
      (groups.length
        ? '<div class="muted">You hold ' + total + " across " + groups.length + " printing" + (groups.length === 1 ? "" : "s") +
          (lent ? " (" + lent + " lent out)" : "") + "</div>" +
          '<div class="cp-sec"><div class="eyebrow">Printings</div><table class="cp-print"><thead><tr><th>Printing</th><th>Finish</th><th>Cond.</th><th class="num">Held</th><th class="num">Market</th></tr></thead><tbody>' +
          groups.map((g, i) => {
            const r = g.rec, f = G.normalizeFinish(r.finish) || "nonfoil";
            return '<tr><td><a href="#" data-pi="' + i + '">' + esc(cpSet(r.set).toUpperCase() + " #" + r.collector) + "</a></td>" +
              "<td>" + (f === "nonfoil" ? '<span class="muted">—</span>' : esc(G.FINISH_NAMES[f] || f)) + "</td>" +
              "<td>" + esc([...g.conds].join(", ")) + '</td><td class="num">' + g.qty + '</td><td class="num">' + (r.price != null ? money(r.price) : "—") + "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : '<div class="muted">You don\'t hold any printing of this card.</div>') +
      '<div class="cp-sec"><div class="eyebrow">Go to</div><div class="cp-links">' +
      links.map(l => '<a href="' + esc(l.href) + '" data-go>' + esc(l.label) + "</a>").join("") + "</div></div>" +
      seeOnSec({ name: name, englishName: cpGroupRows[0] && cpGroupRows[0].englishName });
    $("cardPanelBack").hidden = true;
    $("cpGroup").hidden = false;
    for (const x of ["cardPanelHost", "cpMarket", "cpFacts"]) $(x).hidden = true;
    p.so.open("cardPanelClose");
  }
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a.card-link");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    e.preventDefault(); e.stopPropagation();   // the name opens the panel; the row keeps its own click
    const d = a.dataset;
    if (d.group) { openCardGroup(d.name); return; }
    openCardPanel({ name: d.name, set: d.set, collector: d.collector, finish: d.finish, lang: d.lang, imageUrl: d.img });
  }, true);
  /* From an owned-stack-shaped row (imageUrl/name/quantity/etc). */
  function reviewRecord(r) {
    if (!r) return;
    openCardPanel(r, p => p.showRecord(r));
  }
  /* From a raw card-database-shaped row (set/collector/setName/typeLine/rarity) -
     the shape Buy List and Movers' unowned rows carry. */
  function reviewCard(card, finish, note) {
    if (!card) return;
    openCardPanel(Object.assign({}, card, { name: G.cardName(card), finish: finish || card.finish }), p => p.showCard(card, finish, note));
  }

  /* The "card filter" a target page shows when it was opened from the panel
     (?q= + set/collector): read it from the URL, show it as a clearable chip,
     and drop it from the URL on clear. */
  function cardFilterFromUrl() {
    const sp = new URLSearchParams(location.search);
    const name = sp.get("q") || "";
    if (!name && !sp.get("set")) return null;
    return { name, set: cpSet(sp.get("set")), collector: sp.get("collector") || "" };
  }
  const cardFilterMatches = (f, x) => !f || !f.set || !f.collector ||
    (cpSet(x.set) === f.set && cpNum(x.collector) === cpNum(f.collector));
  const cardFilterLabel = f => f.name + (f.set && f.collector ? " (" + f.set.toUpperCase() + " #" + f.collector + ")" : "");
  /* Draws (or with a null filter, removes) the chip just before `anchor`. */
  function cardFilterChip(anchor, filter, label, onClear) {
    let el = $("cardFilterChip");
    if (!filter) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "cardFilterChip"; el.className = "card-filter-bar";
      anchor.parentNode.insertBefore(el, anchor);
    }
    el.innerHTML = '<span class="chip">' + esc(label) + ' <button type="button" aria-label="Clear the card filter" title="Clear the card filter">✕</button></span>';
    el.querySelector("button").onclick = () => {
      const u = new URL(location.href);
      ["q", "set", "collector", "hist", "finish", "lang"].forEach(k => u.searchParams.delete(k));
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      el.remove();
      onClear();
    };
  }

  /* Customers nav count (#50): wanted cards that came in and nobody has told
     the customer about yet. Shown on the link and on its bucket's header,
     since buckets start collapsed. */
  function renderCustomerBadge() {
    const nav = $("appNav");
    const a = nav && nav.querySelector('a[href="/customers.html"]');
    const n = G.untoldRestocks ? G.untoldRestocks().length : 0;
    const set = (el, cls) => {
      if (!el) return;
      let b = el.querySelector("." + cls);
      if (!n) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement("span"); b.className = "count " + cls; el.insertBefore(b, el.querySelector(".fold")); }
      b.textContent = n;
      b.title = n + " wanted card" + (n === 1 ? "" : "s") + " came in";
    };
    set(a, "cust-count");
    const group = a && a.closest(".nav-group");
    set(group && group.querySelector(".side-label"), "cust-count-group");
  }

  /* ============================== Name autocomplete ============================== */
  /* ↑/↓ move, Enter takes the highlighted one. Enter taking the FIRST suggestion
     regardless of the highlight is how v0.06 kept adding the wrong printing of a
     card whose name is a prefix of another. */
  function Autocomplete(inputId, listId, onPick) {
    const input = $(inputId), list = $(listId);
    let token = 0, index = -1;
    const items = () => [...list.querySelectorAll(".ac-item")];
    const hide = () => { list.hidden = true; index = -1; };
    function highlight(i) {
      const it = items();
      if (!it.length) return;
      index = (i + it.length) % it.length;
      it.forEach((el, n) => el.classList.toggle("sel", n === index));
      it[index].scrollIntoView({ block: "nearest" });
    }
    function move(delta) {
      if (list.hidden || !items().length) return false;
      highlight(index < 0 ? (delta > 0 ? 0 : -1) : index + delta);
      return true;
    }
    function accept() {
      const it = items();
      if (list.hidden || !it.length) return false;
      const name = it[index < 0 ? 0 : index].textContent;
      input.value = name; hide(); onPick(name);
      return true;
    }
    function renderList(names) {
      if (!names.length) { hide(); return; }
      index = -1;
      list.innerHTML = names.map(n => '<div class="ac-item" role="option">' + esc(n) + "</div>").join("");
      items().forEach((item, i) => {
        item.addEventListener("mousedown", e => {
          e.preventDefault();
          input.value = item.textContent; hide(); onPick(item.textContent);
        });
        item.addEventListener("mousemove", () => highlight(i));
      });
      list.hidden = false;
    }
    const run = G.debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { hide(); return; }
      const t = ++token;
      try {
        const names = await G.cards.autocomplete(q);
        if (t !== token) return;
        renderList(names);
      } catch (e) { if (t === token) hide(); }
    }, 180);

    input.addEventListener("input", run);
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { if (move(1)) e.preventDefault(); }
      else if (e.key === "ArrowUp") { if (move(-1)) e.preventDefault(); }
      else if (e.key === "Enter") { e.preventDefault(); accept(); }
      else if (e.key === "Escape") hide();
    });
    input.addEventListener("blur", () => setTimeout(hide, 150));
    return { hide, accept };
  }

  /* ============================== Location selects ============================== */
  function locOptions(selectedId, opts) {
    const o = opts || {};
    let html = o.anyLabel ? '<option value="">' + esc(o.anyLabel) + "</option>" : "";
    if (o.newLabel) html += '<option value="__new">' + esc(o.newLabel) + "</option>";
    html += G.sortedLocations()
      .filter(l => !o.exclude || l.id !== o.exclude)
      .map(l => {
        const st = G.locStats(l.id);
        const cap = st.cap == null ? "" : " " + st.cards + "/" + st.cap;
        const per = l.maxPerName == null ? "" : " · max " + l.maxPerName + "/card";
        return '<option value="' + l.id + '"' + (l.id === selectedId ? " selected" : "") + ">" +
          esc(l.name) + (l.staging && !/tray/i.test(l.type || "") ? " — tray" : "") + " (" + esc(l.type) + cap + per + ")</option>";
      }).join("");
    return html;
  }
  function fillLocationSelect(el, selectedId, opts) {
    if (!el) return;
    const keep = selectedId != null ? selectedId : el.value;
    el.innerHTML = locOptions(keep, opts) ||
      '<option value="">— create a location first —</option>';
    if (keep && [...el.options].some(o => o.value === keep)) el.value = keep;
  }

  /* ============================== Query builder modal ============================== */
  const RARITIES = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
  const describeTagMatches = (ids, kind) => !ids ? "" : !ids.size ? "No matches for this tag" :
    ids.size.toLocaleString() + (kind === "otag" ? " card" : " printing") + (ids.size === 1 ? "" : "s") + " match";
  function ensureQueryModal() {
    if ($("queryModal")) return;
    const html =
      '<h3>Inventory Query <span class="muted" id="qCount"></span></h3>' +
      '<div class="muted" style="margin:4px 0 10px">Filter on everything known about a row, including the Scryfall ' +
        'card data captured when it was added. Rows added before that existed have none until a ' +
        '<b>Refresh prices &amp; data</b> fills it in — tick “Missing card data” to find them. Oracle tag and Art ' +
        'tag look up Scryfall Tagger live (not part of that cached data), so they resolve a moment after you stop typing.</div>' +
      '<div class="qgrid">' +
        '<label>Card name contains <input id="qName" autocomplete="off"></label>' +
        '<label>Set code or set name <input id="qSet" autocomplete="off" placeholder="e.g. afr or Forgotten"></label>' +
        '<label>Collector # contains <input id="qNum" autocomplete="off"></label>' +
        '<label>Type line contains <input id="qType" autocomplete="off" placeholder="e.g. Legendary Creature"></label>' +
        '<label>Oracle text contains <input id="qOracle" autocomplete="off" placeholder="e.g. draw a card"></label>' +
        '<label>Artist contains <input id="qArtist" autocomplete="off"></label>' +
        '<label>Keyword <input id="qKeyword" autocomplete="off" placeholder="e.g. Flying"></label>' +
        '<label>Mana cost contains <input id="qMana" autocomplete="off" placeholder="e.g. {G}{G}"></label>' +
        '<label>Oracle tag (otag) <input id="qOtag" autocomplete="off" placeholder="e.g. removal, ramp">' +
          '<span class="muted" id="qOtagStatus" style="font-weight:400;font-size:10.5px;min-height:13px"></span></label>' +
        '<label>Art tag <input id="qArt" autocomplete="off" placeholder="e.g. dragon, knight">' +
          '<span class="muted" id="qArtStatus" style="font-weight:400;font-size:10.5px;min-height:13px"></span></label>' +
        '<label>Set type <input id="qSetType" autocomplete="off" placeholder="e.g. expansion, masters"></label>' +
        '<label>Language <select id="qLang"><option value="">Any</option></select></label>' +
        '<label>Finish <select id="qFoil"><option value="">Any</option>' +
          G.FINISHES.map(f => '<option value="' + f + '">' + esc(G.FINISH_NAMES[f]) + "</option>").join("") +
          "</select></label>" +
        '<label>Condition <select id="qCondition"><option value="">Any</option>' +
          G.CONDITIONS.map(c => '<option value="' + c + '">' + esc(G.CONDITION_NAMES[c]) + "</option>").join("") +
          "</select></label>" +
        '<label>Location <select id="qLoc"><option value="">Any</option></select></label>' +
      "</div>" +
      '<div class="qgrid n4" style="margin-top:10px">' +
        '<label>Mana value ≥ <input id="qCmcMin" type="number" step="0.5"></label>' +
        '<label>Mana value ≤ <input id="qCmcMax" type="number" step="0.5"></label>' +
        '<label>Price ≥ <input id="qPriceMin" type="number" step="0.01"></label>' +
        '<label>Price ≤ <input id="qPriceMax" type="number" step="0.01"></label>' +
        '<label>Qty ≥ <input id="qQtyMin" type="number"></label>' +
        '<label>Qty ≤ <input id="qQtyMax" type="number"></label>' +
        '<label>Released on/after <input id="qRelFrom" type="date"></label>' +
        '<label>Released on/before <input id="qRelTo" type="date"></label>' +
      "</div>" +
      '<div class="chkrow"><span class="cap">Rarity</span>' +
        RARITIES.map(r => '<label><input type="checkbox" class="qrar" value="' + r + '"> ' +
          r.charAt(0).toUpperCase() + r.slice(1) + "</label>").join("") +
      "</div>" +
      '<div class="chkrow"><span class="cap">Colors</span>' +
        '<select id="qColorField"><option value="colors">Card colors</option><option value="identity">Color identity</option></select>' +
        G.COLOR_LETTERS.map(c => '<label><input type="checkbox" class="qcol" value="' + c + '"> ' +
          (c === "C" ? "Colorless" : c) + "</label>").join("") +
        '<select id="qColorMode"><option value="any">includes any of these</option>' +
        '<option value="all">includes all of these</option><option value="exact">is exactly these</option></select>' +
      "</div>" +
      '<div class="chkrow"><span class="cap">Flags</span>' +
        '<label><input type="checkbox" id="qListed"> Listed for sale</label>' +
        // #366: Manapool's SELLING FAST flag on the printing; seller-only, so not in Simple mode.
        '<label' + (G.simpleMode ? " hidden" : "") + ' title="The printing sold well above its usual pace on Manapool in the last 7 days"><input type="checkbox" id="qSellingFast"> Selling fast</label>' +
        '<label><input type="checkbox" id="qPromo"> Promo</label>' +
        '<label><input type="checkbox" id="qFullArt"> Full art</label>' +
        '<label><input type="checkbox" id="qReserved"> Reserved list</label>' +
        '<label><input type="checkbox" id="qNoPrice"> No price on file</label>' +
        '<label><input type="checkbox" id="qNeedsMeta"> Missing card data</label>' +
        '<label><input type="checkbox" id="qFailed"> Lookup failed</label>' +
        '<label><input type="checkbox" id="qHasCost"> Has a cost basis</label>' +
        '<label><input type="checkbox" id="qNoCost"> No cost basis</label>' +
      "</div>" +
      "<hr>" +
      '<div class="modal-actions"><button id="qReset">Reset</button><span class="spacer"></span>' +
      '<button id="qCancel">Cancel</button><button id="qApply" class="primary">Apply</button></div>';
    ensureModal("queryModal", "xwide", html);
  }

  /* tagState (optional) is openQuery's live otag/art lookup state - see there.
     Passed in explicitly rather than closed over, since readQueryForm/
     writeQueryForm are also exported standalone. */
  function readQueryForm(tagState) {
    const q = G.emptyQuery();
    const v = id => ($(id) ? $(id).value.trim().toLowerCase() : "");
    q.name = v("qName"); q.set = v("qSet"); q.num = v("qNum"); q.type = v("qType");
    q.oracle = v("qOracle"); q.artist = v("qArtist"); q.keyword = v("qKeyword");
    q.mana = v("qMana"); q.setType = v("qSetType");
    q.otag = v("qOtag"); q.art = v("qArt");
    // Only attach a resolved Set if it's actually for the text currently in
    // the box - if the user typed something new since the last lookup
    // finished (or never triggered one), this field contributes no filter
    // yet rather than silently filtering by stale results.
    if (tagState) {
      q.otagIds = tagState.otag.text === q.otag ? tagState.otag.ids : null;
      q.artIds = tagState.art.text === q.art ? tagState.art.ids : null;
    }
    q.lang = $("qLang").value; q.finish = $("qFoil").value; q.condition = $("qCondition").value; q.loc = $("qLoc").value;
    q.rarities = [...document.querySelectorAll(".qrar:checked")].map(c => c.value);
    q.colorField = $("qColorField").value;
    q.colors = [...document.querySelectorAll(".qcol:checked")].map(c => c.value);
    q.colorMode = $("qColorMode").value;
    q.cmcMin = G.numOrNull($("qCmcMin").value); q.cmcMax = G.numOrNull($("qCmcMax").value);
    q.priceMin = G.numOrNull($("qPriceMin").value); q.priceMax = G.numOrNull($("qPriceMax").value);
    q.qtyMin = G.numOrNull($("qQtyMin").value); q.qtyMax = G.numOrNull($("qQtyMax").value);
    q.relFrom = $("qRelFrom").value; q.relTo = $("qRelTo").value;
    ["listed", "sellingFast", "promo", "fullArt", "reserved", "noPrice", "needsMeta", "failed", "hasCost", "noCost"]
      .forEach(k => { q[k] = $("q" + k.charAt(0).toUpperCase() + k.slice(1)).checked; });
    return q;
  }
  function writeQueryForm(q, tagState) {
    q = q || G.emptyQuery();
    const set = (id, val) => { if ($(id)) $(id).value = val == null ? "" : val; };
    set("qName", q.name); set("qSet", q.set); set("qNum", q.num); set("qType", q.type);
    set("qOracle", q.oracle); set("qArtist", q.artist); set("qKeyword", q.keyword);
    set("qMana", q.mana); set("qSetType", q.setType);
    set("qOtag", q.otag); set("qArt", q.art);
    if (tagState) {
      tagState.otag = { text: (q.otag || "").toLowerCase(), ids: q.otagIds || null, seq: 0 };
      tagState.art = { text: (q.art || "").toLowerCase(), ids: q.artIds || null, seq: 0 };
      if ($("qOtagStatus")) $("qOtagStatus").textContent = describeTagMatches(tagState.otag.ids, "otag");
      if ($("qArtStatus")) $("qArtStatus").textContent = describeTagMatches(tagState.art.ids, "art");
    }
    set("qLang", q.lang); set("qFoil", q.finish); set("qCondition", q.condition); set("qLoc", q.loc);
    document.querySelectorAll(".qrar").forEach(c => { c.checked = (q.rarities || []).includes(c.value); });
    set("qColorField", q.colorField); set("qColorMode", q.colorMode);
    document.querySelectorAll(".qcol").forEach(c => { c.checked = (q.colors || []).includes(c.value); });
    set("qCmcMin", q.cmcMin); set("qCmcMax", q.cmcMax);
    set("qPriceMin", q.priceMin); set("qPriceMax", q.priceMax);
    set("qQtyMin", q.qtyMin); set("qQtyMax", q.qtyMax);
    set("qRelFrom", q.relFrom); set("qRelTo", q.relTo);
    ["listed", "sellingFast", "promo", "fullArt", "reserved", "noPrice", "needsMeta", "failed", "hasCost", "noCost"]
      .forEach(k => { $("q" + k.charAt(0).toUpperCase() + k.slice(1)).checked = !!q[k]; });
  }

  /* Opens the builder and resolves with a query object (or null when cleared). */
  function openQuery(current) {
    ensureQueryModal();
    const langs = [...new Set(G.state.cards.map(r => r.lang))].sort();
    $("qLang").innerHTML = '<option value="">Any</option>' +
      langs.map(l => '<option value="' + l + '">' + esc(G.LANG_NAMES[l] || l) + "</option>").join("");
    $("qLoc").innerHTML = '<option value="">Any</option>' +
      G.sortedLocations().map(l => '<option value="' + l.id + '">' + esc(l.name) + " (" + esc(l.type) + ")</option>").join("");
    // otag/art are the only fields in this modal that need a live network
    // round trip instead of an in-memory filter - tagState tracks what's
    // been resolved (or is still resolving) for each, keyed by the exact
    // text it was resolved for, so readQueryForm can tell "not typed", "typed
    // but not looked up yet" and "resolved" apart (see there).
    const tagState = { otag: { text: "", ids: null, seq: 0 }, art: { text: "", ids: null, seq: 0 } };
    // The Selling fast flag needs this account's Manapool sales (#366); once per page.
    G.loadSoldMine().then(updateCount);
    writeQueryForm(current, tagState);
    updateCount();

    async function resolveTag(kind) {
      const inputId = kind === "otag" ? "qOtag" : "qArt";
      const statusId = kind === "otag" ? "qOtagStatus" : "qArtStatus";
      const text = $(inputId).value.trim().toLowerCase();
      const st = tagState[kind];
      if (text === st.text && (st.ids !== null || !text)) return;   // already resolved (or empty) for this text
      st.text = text;
      if (!text) { st.ids = null; $(statusId).textContent = ""; return; }
      const mySeq = ++st.seq;
      $(statusId).textContent = "Looking up…";
      try {
        const { ids, found } = await G.cards.tagSearch(kind, text);
        if (st.seq !== mySeq) return;   // superseded by a newer edit before this resolved
        st.ids = new Set(ids);
        $(statusId).textContent = found
          ? describeTagMatches(st.ids, kind)
          : 'No tag named "' + text + '" - check the exact name on tagger.scryfall.com';
        updateCount();
      } catch (e) {
        if (st.seq !== mySeq) return;
        st.ids = null;
        $(statusId).textContent = "Couldn't look this up: " + e.message;
      }
    }
    const otagDebounced = G.debounce(() => resolveTag("otag"), 500);
    const artDebounced = G.debounce(() => resolveTag("art"), 500);
    const onTagInput = e => {
      if (e.target.id === "qOtag") otagDebounced();
      else if (e.target.id === "qArt") artDebounced();
    };

    return new Promise(resolve => {
      /* cleanup() FIRST. It clears the close handler registered below; if
         hideModal() runs before it, that handler fires and resolves the promise
         with undefined, and because a promise settles once the real resolve(val)
         after it is silently dropped - so Apply always looked like Cancel. */
      const finish = val => { cleanup(); hideModal("queryModal"); resolve(val); };
      const onApply = async () => {
        // Force-resolve rather than trusting the debounce fired already - a
        // click right after typing (or an Enter keypress) shouldn't silently
        // apply the query with the new otag/art text un-looked-up. A broad
        // tag can take several seconds (Scryfall search, paginated, rate-
        // limited server-side) - disable Apply so that wait is visible
        // instead of looking like the click did nothing.
        const label = $("qApply").textContent;
        $("qApply").disabled = true; $("qApply").textContent = "Looking up…";
        try {
          await Promise.all([resolveTag("otag"), resolveTag("art")]);
        } finally {
          $("qApply").disabled = false; $("qApply").textContent = label;
        }
        const draft = readQueryForm(tagState);
        finish(G.queryFieldCount(draft) ? draft : null);
      };
      const onCancel = () => finish(undefined);
      const onReset = () => { writeQueryForm(G.emptyQuery(), tagState); updateCount(); };
      const onKey = e => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); onApply(); } };
      function cleanup() {
        $("qApply").onclick = null; $("qCancel").onclick = null; $("qReset").onclick = null;
        $("queryModal").removeEventListener("input", updateCount);
        $("queryModal").removeEventListener("input", onTagInput);
        $("queryModal").removeEventListener("change", updateCount);
        $("queryModal").removeEventListener("keydown", onKey);
        onClose("queryModal", null);
      }
      $("qApply").onclick = onApply;
      $("qCancel").onclick = onCancel;
      $("qReset").onclick = onReset;
      $("queryModal").addEventListener("input", updateCount);
      $("queryModal").addEventListener("input", onTagInput);
      $("queryModal").addEventListener("change", updateCount);
      $("queryModal").addEventListener("keydown", onKey);
      onClose("queryModal", () => { cleanup(); resolve(undefined); });
      showModal("queryModal", "qName");
    });

    function updateCount() {
      const draft = readQueryForm(tagState);
      const n = G.queryFieldCount(draft);
      if (!n) { $("qCount").textContent = "— no conditions set (Apply clears any active query)"; return; }
      const rows = G.state.cards.filter(r => G.matchesQuery(r, draft));
      const cardsN = rows.reduce((s, r) => s + r.quantity, 0);
      const value = rows.reduce((s, r) => s + G.rowTotal(r), 0);
      $("qCount").textContent = "— " + rows.length + " stack" + (rows.length === 1 ? "" : "s") + ", " +
        cardsN + " card" + (cardsN === 1 ? "" : "s") + ", " + money(value) + " · " +
        n + " condition" + (n === 1 ? "" : "s");
    }
  }

  /* ============================== Manage-card modal ============================== */
  function ensureManageModal() {
    if ($("manageModal")) return;
    // Cost basis / Move / Add-to-list are business-seller depth - skipped
    // entirely in simple mode (checked once here, at first build, since
    // G.state.settings is already loaded by the time any modal can open).
    const simple = G.simpleMode;
    const html =
      '<h3 id="mTitle">Manage Card</h3>' +
      '<div id="mInfo" class="muted" style="margin-bottom:12px"></div>' +
      '<div class="move-box" style="margin-bottom:14px"><strong>Card identity</strong>' +
        '<div class="hint" style="margin-top:2px">Change any of these and the card is looked up again — its name, ' +
        'printing and price refresh to match. Collector numbers work with or without leading zeros.</div>' +
        '<div class="idgrid">' +
          '<label>Set code <input id="mSet" autocomplete="off" placeholder="e.g. neo"></label>' +
          '<label>Collector # <input id="mNum" autocomplete="off" placeholder="e.g. 123"></label>' +
          '<label>Language <select id="mLang"></select></label>' +
          '<label>Finish <select id="mFoil">' +
            G.FINISHES.map(f => '<option value="' + f + '">' + esc(G.FINISH_NAMES[f]) + "</option>").join("") +
            "</select></label>" +
        "</div><div class='hint' id='mIdHint'></div></div>" +
      '<div class="grid2">' +
        '<label>Quantity (0 deletes the stack) <input id="mQty" type="number" min="0"></label>' +
        '<label title="How many of this stack are on the pick list, not yet shipped. Listed-for-sale quantity is managed from the Storefront view instead - Manapool has no concept of which location a card sits in.">' +
          'Allocated to order (qty) <input id="mAllocated" type="text" readonly></label>' +
      "</div>" +
      '<label>Condition <select id="mCond"></select></label>' +
      '<label>Storage location <select id="mLoc"></select></label>' +
      '<div class="move-box" style="margin-bottom:14px"><strong>Lending</strong>' +
        '<div id="mLoans"></div>' +
        '<div class="row" id="mLendOpenRow" style="margin-top:8px"><button id="mLendOpen">Lend…</button></div>' +
        '<div id="mLendForm" hidden>' +
          '<div class="row" style="margin-top:8px">' +
            '<label style="flex:0 0 90px">Copies <input id="mLendQty" type="number" min="1" value="1"></label>' +
            '<label>Lend to <input id="mLendTo" list="mLendNames" maxlength="80" autocomplete="off" placeholder="Anyone\'s name"></label>' +
            '<label>Give back by (optional) <input id="mLendDue" type="date"></label>' +
            '<button id="mLendGo" class="primary">Lend</button>' +
          "</div>" +
          '<datalist id="mLendNames"></datalist>' +
          '<div class="hint" id="mLendHint"></div>' +
        "</div></div>" +
      (simple ? "" :
      '<div class="move-box" style="margin-bottom:14px"><strong>Cost basis</strong>' +
        '<div class="hint" id="mCostNow" style="margin-top:2px"></div>' +
        '<div class="row" style="margin-top:8px">' +
          '<label>Cost each <input id="mCostEach" type="number" min="0" step="0.01" placeholder="0.00"></label>' +
          '<label>Applies to how many copies <input id="mCostQty" type="number" min="1"></label>' +
          '<button id="mCostSet">Set cost basis</button>' +
        "</div>" +
        '<div class="hint">Use this for copies you already owned before you started tracking spend. ' +
        'Lot receipts fill this in automatically.</div></div>' +
      '<div class="move-box" style="margin-bottom:14px"><strong>Move copies to another location</strong>' +
        '<div class="row" style="margin-top:8px">' +
          '<label>Copies <input id="mMoveQty" type="number" min="1" value="1"></label>' +
          '<label>Destination <select id="mMoveDest"></select></label>' +
          '<button id="mMoveBtn">Move</button>' +
          '<button id="mPutaway" title="Move to wherever the putaway rules say this card belongs"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg> Putaway</button>' +
        "</div><div class='hint' id='mMoveHint'></div></div>" +
      '<div class="move-box"><strong>Add to a list</strong>' +
        '<div class="row" style="margin-top:8px">' +
          '<label style="flex:0 0 90px">Copies <input id="mListQty" type="number" min="1" value="1"></label>' +
          '<button id="mAddPick">Add to pick list</button>' +
          '<button id="mAddDeck">Add to deck list</button>' +
        "</div>" +
        '<div class="hint">Pick list pulls this exact printing for a sale. Deck list gathers this card by name.</div></div>') +
      "<hr>" +
      '<div class="modal-actions"><button id="mDelete" class="danger">Delete</button><span class="spacer"></span>' +
      '<button id="mCancel">Cancel</button><button id="mSave" class="primary">Save changes</button></div>';
    ensureModal("manageModal", "", html);
    $("mLang").innerHTML = Object.entries(G.LANG_NAMES)
      .map(([k, v]) => '<option value="' + k + '">' + esc(v) + "</option>").join("");
    $("mCond").innerHTML = G.CONDITIONS
      .map(c => '<option value="' + c + '">' + esc(G.CONDITION_NAMES[c]) + "</option>").join("");
  }

  /* ============================== Lending (#336) ============================== */
  const loanDate = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  // "Lent to Sam x2". Overdue says so in words and an icon, never colour alone.
  function loanTag(l) {
    const late = G.loanOverdue(l);
    return '<span class="lent-tag' + (late ? " overdue" : "") + '"' + (l.due ? ' title="Give back by ' + esc(loanDate(l.due)) + '"' : "") + ">" +
      (late ? icon("clock") + " " : "") + "Lent to " + esc(l.to) + (l.qty > 1 ? " ×" + l.qty : "") + (late ? " · overdue" : "") + "</span>";
  }
  const loanTags = loans => (loans && loans.length) ? '<span class="lent-tags">' + loans.map(loanTag).join("") + "</span>" : "";
  /* Booked in Warehouse Mode on a receipt still open (#388): in stock, but not
     picked or listed until the desk closes it. Same quiet tag as a loan. */
  function heldTag(r) {
    const no = G.heldOn(r);
    return no ? '<span class="lent-tags"><span class="lent-tag" title="Booked in Warehouse Mode. Orders and listings skip it until the receipt is closed on Receiving.">' +
      "Held on " + esc(no) + " until the desk closes it</span></span>" : "";
  }
  const loansKey = loans => (loans || []).map(l => l.id + ":" + l.qty + ":" + l.to + ":" + l.due).join(",");
  // A loan's give-back line and its Mark returned control (Manage and the Lent out list).
  function loanLine(rec, l) {
    return '<div class="loan-line">' + loanTag(l) +
      '<span class="muted">' + (l.due ? "Give back by " + esc(loanDate(l.due)) : "No give-back date") + "</span>" +
      '<span class="loan-back">' +
      (l.qty > 1 ? '<input type="number" class="loan-back-qty" min="1" max="' + l.qty + '" value="' + l.qty + '" aria-label="Copies returned">' : "") +
      '<button class="small" data-return="' + esc(l.id) + '" data-rec="' + esc(rec.id) + '">Mark returned</button></span></div>';
  }
  function wireLoanLines(box, after) {
    box.querySelectorAll("[data-return]").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const rec = G.state.cards.find(x => x.id === btn.dataset.rec);
        const input = btn.parentNode.querySelector(".loan-back-qty");
        const out = rec && G.returnLoan(rec, btn.dataset.return, input ? input.value : undefined);
        if (!out) return;
        G.persist("Mark returned: " + rec.name);
        toast(out.to + " returned " + out.qty + "× " + rec.name + ". Undo puts the loan back.", "ok");
        after();
      };
    });
  }
  // Friends' names for the "Lend to" box, asked for once a page and only when lending.
  let lendFriends = null;
  function lendFriendNames() {
    if (!lendFriends) {
      lendFriends = G.api("/api/friends")
        .then(d => (d && Array.isArray(d.friends) ? d.friends : []).filter(f => f && f.friend).map(f => f.displayName || f.username))
        .catch(() => []);
    }
    return lendFriends;
  }

  const identityText = (set, num, lang, finish) =>
    String(set).toUpperCase() + " #" + num + " · " + (G.LANG_NAMES[lang] || lang) + " · " + (G.FINISH_NAMES[finish] || "Non-foil").toLowerCase();
  const idHint = (msg, bad) => { $("mIdHint").textContent = msg; $("mIdHint").className = "hint" + (bad ? " warn" : ""); };

  /* The Storefront grid's +/- Listed buttons (see pushListedDelta in Grid()
     below): listedQty is Manapool-sourced now, so the control has to push to
     Manapool and adopt whatever quantity comes back, rather than writing a
     local number that the next sync/push would just overwrite anyway.
     Manapool has no concept of storage location, so G.storefrontListedPush
     works out the whole listing: copies listed only from locations with
     "Sell from" on, copies sold to an open order never listed again (#86),
     and anything listed from elsewhere taken down (#194). Returns a message
     for the caller to show (null when there is nothing to say). Throws on no
     Scryfall ID or a failed request. */
  async function pushManapoolListed(identityKey, delta) {
    // Copies on a fetched order with no pick list yet are sold too (#107):
    // read the orders cache so + never lists one of them again.
    try { await G.loadManapoolOrders(); } catch (e) { /* pick lists alone, as before */ }
    const plan = G.storefrontListedPush(identityKey, delta);
    if (plan.refused === "noSellFrom") {
      return { err: "All copies of " + (plan.name || "this card") + " are in locations with Sell from off. " +
        "Turn Sell from on for one of them, or move a copy, to list it." +
        (plan.offTakenDown > 0 ? " Press \u2212 to take down the " + plan.offTakenDown + " listed there." : "") };
    }
    if (plan.refused) return null;
    const r = plan.sample;
    if (!r.scryfallId) throw new Error("This card has no Scryfall ID on file - can't push to Manapool.");
    // The listing's live ask: its Bulk Price rule, else market x condition % -
    // same as Listings (#88, #228).
    const price = G.manapoolListPrice(r);
    const out = await G.api("/api/manapool/list", { method: "POST",
      body: { card: r, quantity: plan.quantity, price, condition: r.condition } });
    G.applyManapoolPushToStacks(identityKey, plan.perStack, plan.quantity, out.quantity != null ? out.quantity : plan.quantity, "Manapool push");
    G.recordManapoolAsks([{ key: identityKey, price }], "Manapool push");
    return plan.offTakenDown > 0
      ? { ok: "Took down " + plan.offTakenDown + " cop" + (plan.offTakenDown === 1 ? "y" : "ies") +
          " listed from locations with Sell from off." }
      : null;
  }

  function openManage(id, afterChange) {
    ensureManageModal();
    const r = G.state.cards.find(x => x.id === id);
    if (!r) return;
    let editId = id;
    const done = () => { if (afterChange) afterChange(); };
    // Matches ensureManageModal()'s own check - the Cost basis/Move/Add-to-list
    // fields simply aren't in the DOM when this is true, so every $() lookup
    // for them below has to be skipped, not just their move-box wrapper.
    const simple = G.simpleMode;

    function fill() {
      const rec = G.state.cards.find(x => x.id === editId);
      if (!rec) { hideModal("manageModal"); return; }
      $("mTitle").textContent = rec.name || "(unnamed card)";
      $("mInfo").textContent = G.recPrinting(rec) + " · " + (G.LANG_NAMES[rec.lang] || rec.lang) +
        (rec.finish !== "nonfoil" ? " · " + G.FINISH_NAMES[rec.finish] : "") + " · " + (G.CONDITION_NAMES[rec.condition] || rec.condition) +
        " · " + money(rec.price) + " each";
      $("mSet").value = rec.set.toUpperCase();
      $("mNum").value = rec.collector;
      $("mLang").value = rec.lang;
      $("mFoil").value = rec.finish || "nonfoil";
      idHint(""); $("mSave").disabled = false;
      $("mCond").value = rec.condition || "NM";
      $("mQty").value = rec.quantity;
      $("mAllocated").value = G.pickAllocations().get(rec.id) || 0;
      fillLocationSelect($("mLoc"), rec.locationId);
      $("mLoans").innerHTML = (rec.loans || []).map(l => loanLine(rec, l)).join("");
      wireLoanLines($("mLoans"), () => { fill(); done(); });
      $("mLendForm").hidden = true;
      $("mLendOpenRow").hidden = false;
      $("mLendOpen").disabled = G.availableQty(rec) < 1;
      $("mLendOpen").title = G.availableQty(rec) < 1 ? "Every copy of this stack is already lent out" : "";
      if (!simple) {
        $("mListQty").value = 1; $("mListQty").max = rec.quantity;
        $("mMoveQty").value = 1; $("mMoveQty").max = rec.quantity;
        fillLocationSelect($("mMoveDest"), null, { exclude: rec.locationId });
        $("mMoveHint").className = "hint";
        $("mMoveHint").textContent = "Splits this stack — moved copies merge into any matching stack at the destination.";
        const costed = Number(rec.costQty) || 0;
        $("mCostNow").textContent = costed > 0
          ? "Currently " + money(rec.avgCost) + " each across " + costed + " of " + rec.quantity +
            " copies (" + money(rec.costTotal) + " total)."
          : "No cost basis recorded — these copies count as unknown cost, not as free.";
        $("mCostEach").value = rec.avgCost == null ? "" : rec.avgCost;
        $("mCostQty").value = rec.quantity;
        $("mCostQty").max = rec.quantity;
        const a = G.allocatePutaway(rec, rec.quantity, { excludeLocationId: rec.locationId });
        $("mPutaway").disabled = !a.picks.length;
        $("mPutaway").innerHTML = a.split ? "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg> Putaway (splits)" : "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#package></use></svg> Putaway";
        $("mPutaway").title = a.picks.length
          ? "File to " + a.picks.map(p => p.name + " × " + p.take).join(", ")
          : "No other location's putaway rules will take this card";
      }
    }

    $("mLendOpen").onclick = async () => {
      const rec = G.state.cards.find(x => x.id === editId);
      if (!rec) return;
      $("mLendOpenRow").hidden = true;
      $("mLendForm").hidden = false;
      $("mLendQty").value = 1; $("mLendQty").max = G.availableQty(rec);
      $("mLendTo").value = ""; $("mLendDue").value = "";
      $("mLendHint").className = "hint";
      $("mLendHint").textContent = "Lent copies stay in your total, but aren't picked, listed or traded until they're back.";
      $("mLendTo").focus();
      const names = G.loanNameSuggestions(await lendFriendNames());
      $("mLendNames").innerHTML = names.map(n => '<option value="' + esc(n) + '"></option>').join("");
    };
    $("mLendGo").onclick = () => {
      const rec = G.state.cards.find(x => x.id === editId);
      if (!rec) return;
      let out;
      try { out = G.lendCopies(rec, { qty: $("mLendQty").value, to: $("mLendTo").value, due: $("mLendDue").value }); }
      catch (err) { $("mLendHint").className = "hint warn"; $("mLendHint").textContent = err.message; return; }
      G.persist("Lend " + rec.name);
      toast("Lent " + out.qty + "× " + rec.name + " to " + out.to + ". Undo takes it back." +
        (out.stillListed ? " " + out.stillListed + " still listed on Manapool: take them down on Listings." : ""), "ok");
      fill(); done();
    };
    ["mLendQty", "mLendTo", "mLendDue"].forEach(fid => {
      $(fid).onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("mLendGo").click(); } };
    });
    $("mCancel").onclick = () => hideModal("manageModal");
    $("mDelete").onclick = () => {
      const rec = G.state.cards.find(x => x.id === editId);
      const what = rec ? rec.quantity + "× " + rec.name + " from " + G.locName(rec.locationId) : "that stack";
      G.deleteRecord(editId);
      hideModal("manageModal");
      toast("Deleted " + what + ". Undo restores it.", "ok");
      done();
    };
    if (!simple) {
      $("mCostSet").onclick = () => {
        const rec = G.state.cards.find(x => x.id === editId);
        if (!rec) return;
        const each = parseFloat($("mCostEach").value);
        if (isNaN(each) || each < 0) { $("mCostNow").textContent = "Enter a cost per copy first."; return; }
        const copies = Math.min(Math.max(1, parseInt($("mCostQty").value, 10) || 1), rec.quantity);
        G.setCostBasis(rec, each, copies);
        G.logAudit({
          action: "cost", ...G.auditCard(rec), qty: 0, oldQty: rec.quantity, newQty: rec.quantity,
          from: G.locName(rec.locationId), cost: each * copies,
          note: "Cost basis set to " + money(each) + " each over " + copies + " cop" + (copies === 1 ? "y" : "ies")
        });
        G.persist("Cost basis");
        fill(); done();
        toast("Cost basis set: " + money(each) + " each over " + copies + " cop" + (copies === 1 ? "y" : "ies") + ".", "ok");
      };
      $("mMoveBtn").onclick = () => moveCopies($("mMoveDest").value);
      /* Files the whole stack by the rules, splitting across an overflow bin when
         the first choice will only take some of it. */
      $("mPutaway").onclick = () => {
        const rec = G.state.cards.find(x => x.id === editId);
        if (!rec) return;
        const a = G.allocatePutaway(rec, rec.quantity, { excludeLocationId: rec.locationId });
        if (!a.picks.length) return;
        const out = G.applyPutawayLines([{ record: rec, picks: a.picks, shortfall: a.shortfall }], "Putaway");
        G.persist("Putaway " + rec.name);
        toast("Filed " + out.moved + " card(s) to " + a.picks.map(p => p.name + " × " + p.take).join(", ") +
          (a.shortfall ? " — " + a.shortfall + " had nowhere to go" : "") + ". Undo puts them back.", "ok");
        const still = G.state.cards.find(x => x.id === editId);
        if (still) fill(); else hideModal("manageModal");
        done();
      };
      $("mAddPick").onclick = () => {
        const rec = G.state.cards.find(x => x.id === editId);
        if (!rec) return;
        const qty = Math.max(1, parseInt($("mListQty").value, 10) || 1);
        const pl = G.currentManualPickList();
        G.addToPickList(pl.id, { set: rec.set, collector: rec.collector, lang: rec.lang, finish: rec.finish,
          condition: rec.condition || "NM", name: rec.name, qty });
        G.persist("Add " + qty + "× " + rec.name + " to " + pl.id);
        toast("Added " + qty + "× " + rec.name + " to the pick list.", "ok");
        done();
      };
      $("mAddDeck").onclick = () => {
        const rec = G.state.cards.find(x => x.id === editId);
        if (!rec) return;
        const qty = Math.max(1, parseInt($("mListQty").value, 10) || 1);
        G.addToDeckList(rec.name, qty);
        G.persist("Add " + qty + "× " + rec.name + " to deck list");
        toast("Added " + qty + "× " + rec.name + " to the deck list.", "ok");
        done();
      };
    }
    ["mSet", "mNum"].forEach(fid => {
      $(fid).oninput = () => idHint("");
      $(fid).onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("mSave").click(); } };
    });
    $("mSave").onclick = () => save();

    function moveCopies(dest, why) {
      const rec = G.state.cards.find(x => x.id === editId);
      if (!rec) return;
      if (!G.locById(dest)) { $("mMoveHint").textContent = "Choose a destination."; $("mMoveHint").className = "hint warn"; return; }
      if (dest === rec.locationId) {
        $("mMoveHint").textContent = "That is the current location — pick a different one.";
        $("mMoveHint").className = "hint warn";
        return;
      }
      const n = Math.min(Math.max(1, parseInt($("mMoveQty").value, 10) || 1), rec.quantity);
      const st = G.locStats(dest);
      if (st.cap != null && st.free < n) {
        $("mMoveHint").textContent = G.locName(dest) + " only has room for " + st.free + " more card" +
          (st.free === 1 ? "" : "s") + " (cap " + st.cap + ").";
        $("mMoveHint").className = "hint warn";
        return;
      }
      const m = G.moveCopies(rec, dest, n, why);
      G.persist();
      const survivor = G.state.cards.find(x => x.id === editId);
      if (survivor) { fill(); } else { hideModal("manageModal"); }
      toast("Moved " + n + " card" + (n === 1 ? "" : "s") + " to " + G.locName(dest) +
        (m.merged ? " — combined with a matching stack already there" : "") + ". Undo puts them back.", "ok");
      done();
    }

    async function save() {
      let rec = G.state.cards.find(x => x.id === editId);
      if (!rec) { hideModal("manageModal"); return; }
      const lent = G.lentQty(rec);
      if ((parseInt($("mQty").value, 10) || 0) < lent) {
        toast(lent + " of these " + (lent === 1 ? "is" : "are") + " lent out, so the quantity can't go below " + lent + ". Mark them returned first.", "err");
        return;
      }
      const newSet = $("mSet").value.trim().toLowerCase();
      const newNum = $("mNum").value.trim();
      const newLang = $("mLang").value;
      const newFinish = G.normalizeFinish($("mFoil").value) || "nonfoil";
      if (!newSet || !newNum) { idHint("Set code and collector number are both required.", true); return; }

      const identityChanged = newSet !== rec.set || G.normNum(newNum) !== G.normNum(rec.collector) ||
        newLang !== rec.lang || newFinish !== rec.finish;
      let info = null;
      if (identityChanged) {
        const before = identityText(rec.set, rec.collector, rec.lang, rec.finish);
        $("mSave").disabled = true;
        idHint("Looking up " + newSet.toUpperCase() + " #" + newNum + "…");
        try { info = await G.lookupCard(newSet, newNum, newLang, newFinish); }
        catch (err) { idHint("✗ " + err.message + " — nothing was changed.", true); $("mSave").disabled = false; return; }
        $("mSave").disabled = false;
        rec = G.state.cards.find(x => x.id === editId);
        if (!rec) { hideModal("manageModal"); toast("That stack merged into another while the lookup ran.", "err"); return; }
        rec.set = newSet;
        rec.collector = info.collector || newNum;
        rec.lang = newLang; rec.finish = newFinish;
        rec.name = info.name || rec.name;
        rec.setName = info.setName; rec.rarity = info.rarity;
        rec.tcgplayerId = info.tcgplayerId; rec.scryfallId = info.scryfallId || "";
        rec.price = info.price; rec.priceNote = info.priceNote || "";
        rec.priceUpdated = new Date().toISOString();
        Object.assign(rec, info.meta);
        G.logAudit({
          action: "edit", ...G.auditCard(rec), qty: 0, oldQty: rec.quantity, newQty: rec.quantity,
          from: G.locName(rec.locationId),
          note: "Card details edited: " + before + " → " +
            identityText(rec.set, rec.collector, rec.lang, rec.finish) + (info.note || "")
        });
      }

      const oldQty = rec.quantity, oldListed = rec.listedQty || 0, oldLoc = G.locName(rec.locationId);
      const oldCond = rec.condition || "NM";
      const wantQty = Math.max(0, parseInt($("mQty").value, 10) || 0);
      if (wantQty < oldQty) G.removeCost(rec, oldQty - wantQty);
      rec.quantity = wantQty;
      // Listed-for-sale quantity is only ever managed from the Storefront view
      // now (it's Manapool-sourced and has no concept of location), but
      // shrinking a stack below what's already listed still has to bring the
      // listed count down with it - same clamp the grid's own quantity
      // controls apply.
      if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
      if (G.locById($("mLoc").value)) rec.locationId = $("mLoc").value;
      // Condition does not need a Scryfall re-lookup - Scryfall has no concept
      // of it - so it is written directly here rather than folded into
      // identityChanged above. It still feeds normalizeMerge() below, since
      // it is part of idKey.
      if (G.CONDITIONS.includes($("mCond").value)) rec.condition = $("mCond").value;
      const newLoc = G.locName(rec.locationId);
      const notes = [];
      if (rec.listedQty !== oldListed) notes.push("Listed for sale " + oldListed + " → " + rec.listedQty);
      if (newLoc !== oldLoc) notes.push("Moved location");
      if (rec.condition !== oldCond) notes.push("Condition " + oldCond + " → " + rec.condition);
      if (rec.quantity === 0) notes.push("Quantity set to 0 — stack removed");
      if (rec.quantity !== oldQty || rec.listedQty !== oldListed || newLoc !== oldLoc || rec.condition !== oldCond) {
        G.logAudit({
          action: rec.quantity === 0 ? "delete" : (newLoc !== oldLoc && rec.quantity === oldQty ? "move" : "edit"),
          ...G.auditCard(rec), qty: rec.quantity - oldQty, oldQty, newQty: rec.quantity,
          from: (newLoc !== oldLoc || rec.quantity < oldQty) ? oldLoc : "",
          to: (newLoc !== oldLoc || rec.quantity > oldQty) ? newLoc : "",
          note: notes.join("; ") || "Edited via Manage"
        });
      }
      const m = G.normalizeMerge({ silent: true });
      G.persist();
      hideModal("manageModal");
      done();
      if (identityChanged) {
        toast("Updated to " + rec.name + " [" + G.recPrinting(rec) + "] " + money(rec.price) +
          (m.merged ? " — combined with a matching stack that already existed" : "") +
          (info && info.note ? info.note : ""), "ok");
      } else if (m.merged) {
        toast("Saved — combined with a matching stack that already existed.", "ok");
      }
    }

    fill();
    showModal("manageModal", "mQty");
  }

  /* ============================== Inventory grid ============================== */
  const WMS_COLUMNS = [
    { key: "sel", label: "", type: "none" },
    { key: "art", label: "", type: "none" },
    { key: "set", label: "Set", type: "str" },
    { key: "collector", label: "Collector #", type: "nat" },
    { key: "lang", label: "Lang", type: "str" },
    { key: "foil", label: "Foil", type: "bool" },
    { key: "condition", label: "Cond", type: "str" },
    { key: "name", label: "Card Name", type: "str" },
    { key: "price", label: "Price", type: "num", num: true },
    // #366: copies of this printing sold on Manapool in the last 7 days.
    { key: "sold7d", label: "Sold 7d", type: "num", num: true, title: "Copies of this printing sold on Manapool in the last 7 days (every finish, condition and language together)" },
    { key: "rank", label: "EDHRec Rank", type: "num", num: true },
    { key: "quantity", label: "Qty", type: "num", num: true },
    { key: "actions", label: "Actions", type: "none" },
    { key: "location", label: "Location", type: "str" },
    { key: "total", label: "Row Total", type: "num", num: true },
    { key: "avgCost", label: "Avg Cost", type: "num", num: true },
    { key: "gain", label: "Gain", type: "num", num: true },
    { key: "allocated", label: "Allocated", type: "num", num: true }
  ];
  const ERP_COLUMNS = [
    { key: "art", label: "", type: "none" },
    { key: "name", label: "Card Name", type: "str" },
    { key: "qty", label: "On Hand", type: "num", num: true },
    { key: "listed", label: "Listed", type: "num", num: true },
    { key: "printings", label: "Printings", type: "num", num: true },
    { key: "locs", label: "Locations", type: "num", num: true },
    { key: "low", label: "Low $", type: "num", num: true },
    { key: "high", label: "High $", type: "num", num: true },
    { key: "cost", label: "Cost", type: "num", num: true },
    { key: "value", label: "Total Value", type: "num", num: true }
  ];
  /* One row per sellable identity - the grain Manapool itself sells at, and
     the only grain with a listed-quantity control (see the note by
     renderStorefront below for why WMS's per-location rows no longer have
     one). */
  const STOREFRONT_COLUMNS = [
    { key: "art", label: "", type: "none" },
    { key: "set", label: "Set", type: "str" },
    { key: "collector", label: "Collector #", type: "nat" },
    { key: "lang", label: "Lang", type: "str" },
    { key: "foil", label: "Foil", type: "bool" },
    { key: "condition", label: "Cond", type: "str" },
    { key: "name", label: "Card Name", type: "str" },
    { key: "price", label: "Price", type: "num", num: true },
    { key: "qty", label: "Qty", type: "num", num: true },
    { key: "sold7d", label: "Sold 7d", type: "num", num: true, title: "Copies of this printing sold on Manapool in the last 7 days (every finish, condition and language together)", cls: "hide-sm" },
    { key: "listed", label: "Listed", type: "num", num: true },
    { key: "locs", label: "Locations", type: "num", num: true }
  ];

  const rowGain = r => {
    const costed = Math.min(r.quantity, Number(r.costQty) || 0);
    if (r.price == null || costed <= 0) return null;
    return r.price * costed - (Number(r.costTotal) || 0);
  };

  /* One grid component used by the inventory page, the stats page and the
     locations drill-down. Owns its own sort state and selection. */
  function Grid(opts) {
    const o = opts || {};
    const wmsWrap = $(o.wmsWrapId);
    const erpWrap = $(o.erpWrapId);
    const storefrontWrap = $(o.storefrontWrapId);
    let mode = o.mode || "wms";
    let sortKey = "name", sortDir = 1;
    // Phone only (css): the Collector # / Set / Price / Qty headers are
    // mostly hidden there, so a plain dropdown does the sorting instead.
    const sortSm = document.createElement("select");
    if (wmsWrap && wmsWrap.parentNode) {
      sortSm.className = "sort-sm";
      sortSm.setAttribute("aria-label", "Sort the list by");
      for (const [k, label] of [["name", "Card name"], ["collector", "Collector #"], ["set", "Set"], ["price", "Price"], ["quantity", "Quantity"]]) {
        const op = document.createElement("option");
        op.value = k; op.textContent = "Sort: " + label;
        sortSm.appendChild(op);
      }
      sortSm.onchange = () => {
        locOrder = false; sortKey = sortSm.value;
        sortDir = sortKey === "price" || sortKey === "quantity" ? -1 : 1;
        page = 0;
        render();
      };
      wmsWrap.parentNode.insertBefore(sortSm, wmsWrap);
    }
    // Filtered to one location that has a sorting method (#267), the stacks
    // come in that order until a column header is clicked; picking another
    // location goes back to it.
    let locOrder = true;
    const orderLoc = () => {
      const l = locOrder && filters.loc ? G.locById(filters.loc) : null;
      return l && l.sortMethod ? l : null;
    };
    // A location with no sorting method that is mostly one set opens in set,
    // then collector-number order, like a binder (#334); a header click goes
    // back to the normal column sort.
    let implicitSetOrder = false;
    // The last column sort picked for each location, remembered per browser
    // like other display prefs (#334).
    const SORT_KEY = "grimoire.locSort";
    const savedSort = id => { try { return (JSON.parse(localStorage.getItem(SORT_KEY) || "{}") || {})[id] || null; } catch (e) { return null; } };
    const saveSort = (id, v) => { try { const m = JSON.parse(localStorage.getItem(SORT_KEY) || "{}") || {}; m[id] = v; localStorage.setItem(SORT_KEY, JSON.stringify(m)); } catch (e) { /* won't stick */ } };
    const mostlyOneSet = rows => {
      if (rows.length < 5) return false;
      const per = new Map();
      for (const r of rows) per.set(r.set, (per.get(r.set) || 0) + 1);
      return Math.max(...per.values()) >= rows.length * 0.6;
    };
    let erpSortKey = "value", erpSortDir = -1;
    let sfSortKey = "name", sfSortDir = 1;
    let selectedId = null;
    // Bulk selection (WMS view only - a checkbox column, same idiom
    // listings.html's "select all" plan-review table already uses). Separate
    // from `selectedId` above, which is the single row the preview panel is
    // pinned to - a stack can be bulk-checked without being the preview pin,
    // and vice versa.
    let selectedIds = new Set();
    const notifySelection = () => { if (o.onSelectionChange) o.onSelectionChange(selectedIds.size); };
    let filters = { text: "", loc: "", query: null, exactName: null, printing: null };
    // Recomputed once per WMS render (see render() below), not per row - how
    // many of each stack are already spoken for by the current pick list.
    let pickAlloc = new Map();

    wmsWrap.innerHTML = '<table><thead><tr id="' + o.wmsWrapId + '_head"></tr></thead><tbody id="' + o.wmsWrapId + '_body"></tbody></table>';
    erpWrap.innerHTML = '<table><thead><tr id="' + o.erpWrapId + '_head"></tr></thead><tbody id="' + o.erpWrapId + '_body"></tbody></table>';
    storefrontWrap.innerHTML = '<table><thead><tr id="' + o.storefrontWrapId + '_head"></tr></thead><tbody id="' + o.storefrontWrapId + '_body"></tbody></table>';

    function filteredRows() {
      const q = String(filters.text || "").trim().toLowerCase();
      const exact = filters.exactName ? String(filters.exactName).trim().toLowerCase() : "";
      let rows = G.state.cards.filter(r => {
        if (!G.matchesQuery(r, filters.query)) return false;
        if (filters.loc && r.locationId !== filters.loc) return false;
        if (filters.printing && !cardFilterMatches(filters.printing, r)) return false;   // #410: one printing, from the card panel
        if (o.rowFilter && !o.rowFilter(r)) return false;
        // A drill-through from "By card name" wants exactly that name, not a
        // substring - "Shock" must not also pull in "Barbed Shocker" and
        // "Staggershock" the way the free-text search box's fuzzy match would.
        if (exact) return String(r.name || "").trim().toLowerCase() === exact;
        if (q) {
          const hay = (r.name + " " + (r.englishName || "") + " " + r.set + " " + r.setName + " " + r.collector + " " +
            G.locName(r.locationId) + " " + G.locType(r.locationId)).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const byLoc = orderLoc();
      if (byLoc) return G.sortInLocationOrder(rows, byLoc.sortMethod);
      implicitSetOrder = !!(locOrder && filters.loc && !savedSort(filters.loc) && mostlyOneSet(rows));
      const mem = !byLoc && locOrder && filters.loc ? savedSort(filters.loc) : null;
      if (mem && WMS_COLUMNS.some(c => c.key === mem.key)) { sortKey = mem.key; sortDir = mem.dir === -1 ? -1 : 1; locOrder = false; }
      if (implicitSetOrder) {
        const nat = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
        return rows.sort((a, b) => nat(a.set, b.set) || nat(a.collector, b.collector) || nat(a.name, b.name));
      }
      const col = WMS_COLUMNS.find(c => c.key === sortKey) || { type: "str" };
      rows.sort((a, b) => {
        let av, bv;
        if (sortKey === "total") { av = G.rowTotal(a); bv = G.rowTotal(b); }
        else if (sortKey === "gain") { av = rowGain(a); bv = rowGain(b); }
        else if (sortKey === "allocated") { av = pickAlloc.get(a.id) || 0; bv = pickAlloc.get(b.id) || 0; }
        else if (sortKey === "location") { av = G.locName(a.locationId); bv = G.locName(b.locationId); }
        else if (sortKey === "rank") { av = a.edhrecRank; bv = b.edhrecRank; }
        else if (sortKey === "sold7d") { av = soldSortValue(a); bv = soldSortValue(b); }
        else { av = a[sortKey]; bv = b[sortKey]; }
        // A card with no EDHRec rank at all (basic lands, tokens, most
        // reprints) is not "the most popular card" - it's unranked. Treating
        // null as 0 would sort those to the very top on an ascending sort,
        // same mistake `Number(null) || 0` makes anywhere else. Sink unranked
        // rows to the bottom regardless of sort direction, same convention
        // the generic data-sort tables already use for blank cells.
        if (sortKey === "rank" && (av == null || bv == null)) {
          if (av == null && bv == null) return 0;
          return av == null ? 1 : -1;
        }
        let cmp;
        if (col.type === "num") cmp = (Number(av) || 0) - (Number(bv) || 0);
        else if (col.type === "bool") cmp = (av ? 1 : 0) - (bv ? 1 : 0);
        else if (col.type === "nat") cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
        else cmp = String(av || "").localeCompare(String(bv || ""), undefined, { sensitivity: "base" });
        return cmp * sortDir;
      });
      return rows;
    }

    // #301: Grimoire's own column headers get preview-only glossary words; the head
    // is rebuilt here, so this is the one place it needs linking.
    const linkHead = tr => { try { if (window.Glossary) window.Glossary.link(tr, { simple: G.simpleMode }); } catch (e) {} };
    function renderHead() {
      const tr = $(o.wmsWrapId + "_head");
      tr.innerHTML = "";
      for (const c of WMS_COLUMNS) {
        const th = document.createElement("th");
        th.classList.add("col-" + c.key);
        if (c.title) th.title = c.title;
        if (c.num) th.classList.add("num");
        if (c.key === "sel") {
          th.innerHTML = '<input type="checkbox" id="' + o.wmsWrapId + '_selAll" title="Select all rows on this page" aria-label="Select all rows on this page">';
          tr.appendChild(th);
          continue;
        }
        if (c.type === "none") {
          if (c.label) th.textContent = c.label;
          else th.innerHTML = '<span class="sr-only">' + (c.key === "art" ? "Image" : "Actions") + "</span>";
          tr.appendChild(th); continue;
        }
        th.classList.add("sortable");
        const byLoc = !!orderLoc() || implicitSetOrder;
        th.innerHTML = c.label + '<span class="arrow">' + (!byLoc && sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : "") + "</span>";
        th.onclick = () => {
          if (orderLoc() || implicitSetOrder) { locOrder = false; sortKey = c.key; sortDir = 1; }
          else if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = 1; }
          if (filters.loc) saveSort(filters.loc, { key: sortKey, dir: sortDir });
          page = 0;
          render();
        };
        tr.appendChild(th);
      }
      linkHead(tr);
    }

    /* The grid's +/- Listed control pushes to Manapool for real - listedQty
       is Manapool-sourced now, so a button that only nudged a local number
       would just get overwritten by the next sync/push anyway. Manapool has
       no concept of storage location, so this has to account for any OTHER
       local stack sharing the same identity (the same G.manapoolPushGroups
       the Listings push uses) rather than just one row's own quantity. */
    const mpBusy = new Set();
    async function pushListedDelta(identityKey, delta) {
      if (mpBusy.has(identityKey)) return;
      mpBusy.add(identityKey);
      try {
        const msg = await pushManapoolListed(identityKey, delta);
        if (msg && msg.err) { toast(msg.err, "err"); return; }
        G.persist("Manapool push");
        if (msg && msg.ok) toast(msg.ok, "ok");
      } catch (e) {
        toast("Manapool: " + e.message, "err");
      } finally {
        mpBusy.delete(identityKey);
      }
    }

    /* Everything about a row that shows up on screen, condensed into one
       string. renderBody() below only touches a row's DOM when this changes,
       instead of tearing down and rebuilding every <tr> on every edit
       anywhere in the collection - the previous behaviour, and expensive
       once there are a few thousand stacks. Location name/type are pulled in
       here too (not just locationId) so a rename elsewhere still invalidates
       the rows that show it. */
    function rowFingerprint(r) {
      return [
        r.set, r.collector, r.lang, r.finish, r.condition, r.name, r.englishName,
        r.price, soldFp(r), r.edhrecRank, r.priceNote, r.lookupFail ? 1 : 0, r.quantity, pickAlloc.get(r.id) || 0, r.imageUrl,
        r.costQty, r.costTotal, r.avgCost, r.locationId, loansKey(r.loans), r.held || "",
        G.locName(r.locationId), G.locType(r.locationId),
        (G.locById(r.locationId) || {}).sortMethod ? "s" : ""
      ].join("");
    }

    function fillRow(tr, r) {
      tr.className = "click" + (r.id === selectedId ? " sel" : "") + (selectedIds.has(r.id) ? " bulk-sel" : "");
      // Plain words, shown under the price (not hover-only, so it reads on a
      // phone too) and not counted in the totals (#326).
      const ver = (r.lang && r.lang !== "en" ? (G.LANG_NAMES[r.lang] || r.lang) + " " : "") +
        (r.priceNote === "no-foil-price" ? "foil " : r.priceNote === "no-etched-price" ? "etched foil " : r.priceNote === "no-nonfoil-price" ? "non-foil " : "") + "version";
      const priceWhy = /^no-(foil|nonfoil|etched)-price$/.test(r.priceNote || "") ? "No price for the " + ver + " of this card. It isn't counted in totals."
        : r.lookupFail ? "The last refresh could not find this printing. Check the set code and collector number."
        : "";
      const named = esc(r.name) + " (" + esc(r.set.toUpperCase()) + " #" + esc(r.collector) + ")";
      const gain = rowGain(r);
      const costed = Math.min(r.quantity, Number(r.costQty) || 0);
      const alloc = pickAlloc.get(r.id) || 0;
      tr.innerHTML =
        '<td class="col-sel"><input type="checkbox" class="rowsel" aria-label="Select ' + named + '" ' +
          (selectedIds.has(r.id) ? "checked" : "") + '></td>' +
        artThumbTd(r.imageUrl) +
        '<td class="col-set">' + esc(r.set.toUpperCase()) + "</td>" +
        '<td class="col-collector">' + esc(r.collector) + "</td>" +
        '<td class="col-lang"><span class="pill">' + esc(G.LANG_NAMES[r.lang] || r.lang) + "</span></td>" +
        '<td class="col-foil">' + finishBadge(r.finish) + "</td>" +
        '<td class="col-condition"><span class="pill cond">' + esc(r.condition || "NM") + "</span></td>" +
        '<td class="col-name">' + cardLink(r) +
          (r.englishName ? ' <span class="muted en-name">(' + esc(r.englishName) + ")</span>" : "") +
          '<small class="name-sub">' + esc(r.set.toUpperCase()) + " · #" + esc(r.collector) +
          (r.finish && r.finish !== "nonfoil" ? ' · <span class="sub-finish">' + (r.finish === "etched" ? "Etched" : "Foil") + "</span>" : "") +
          " · " + esc(r.condition || "NM") + "</small>" + loanTags(r.loans) + heldTag(r) + "</td>" +
        '<td class="col-price num"' + (priceWhy ? ' title="' + esc(priceWhy) + '"' : "") + ">" + money(r.price) +
          (priceWhy ? ' <span class="warn" aria-hidden="true">⚠</span><small class="price-why muted" style="display:block;font-size:11px;line-height:1.3;white-space:normal;max-width:16em;margin-left:auto">' + esc(priceWhy) + "</small>" : "") + "</td>" +
          soldTd(r, "col-sold7d") +
        '<td class="col-rank num">' + (r.edhrecRank == null ? '<span class="muted">—</span>' : r.edhrecRank.toLocaleString()) + "</td>" +
        '<td class="col-quantity num">' + r.quantity + "</td>" +
        '<td class="col-actions acts"></td>' +
        '<td class="col-location"><div class="loc-cell"><span>' + esc(G.locName(r.locationId)) + "</span><small>" +
          esc(G.locType(r.locationId)) + "</small></div></td>" +
        '<td class="col-total num">' + money(G.rowTotal(r)) + "</td>" +
        '<td class="col-avgCost num"' + (costed ? ' title="' + costed + " of " + r.quantity + ' copies have a cost basis"' : "") + ">" +
          (costed ? money(r.avgCost) + (costed < r.quantity ? ' <span class="muted">' + costed + "/" + r.quantity + "</span>" : "") : '<span class="muted">—</span>') + "</td>" +
        '<td class="col-gain num ' + (gain == null ? "" : gain >= 0 ? "good" : "bad") + '">' + (gain == null ? "—" : money(gain)) + "</td>" +
        '<td class="col-allocated num"' + (alloc > 0 ? ' title="On the pick list, not yet shipped"' : "") + ">" +
          (alloc > 0 ? '<span class="badge sale">' + alloc + "</span>" : '<span class="muted">0</span>') +
        "</td>";

      const acts = tr.querySelector("td.acts");
      acts.innerHTML = '<div class="row-actions">' +
        '<button data-act="dec" title="Remove one copy" aria-label="Remove one copy of ' + named + '">−</button>' +
        '<button data-act="inc" title="Add one copy" aria-label="Add one copy of ' + named + '">+</button>' +
        // A location with a sorting method (#267): "Show where this card is"
        // (#295). Worked out on the click, so it is never stale.
        // No method: a dimmed pin that opens that location's sorting setup
        // (Full mode only), or an empty slot in Simple mode, so Manage and the
        // other buttons stay in the same place on every row (#401).
        (G.locById(r.locationId) && G.locById(r.locationId).sortMethod
          ? placementButton('data-act="where"', "Show where this card is")
          : G.locById(r.locationId) && !G.simpleMode
            ? placementButton('data-act="setsort"', "Set a sorting method for " + G.locName(r.locationId) + " to see where cards go")
              .replace('class="small ghost spot-btn"', 'class="small ghost spot-btn spot-off"')
            : '<span class="spot-slot" aria-hidden="true"></span>') +
        '<button data-act="manage" aria-label="Manage ' + named + '">Manage</button></div>';
      const whereBtn = acts.querySelector('[data-act="where"]');
      if (whereBtn) whereBtn.onclick = e => {
        e.stopPropagation();
        const lay = G.locationLayouts().get(r.locationId);
        const spot = lay && lay.locate(r);
        if (spot) showPlacement(spot, r);
      };

      const setSortBtn = acts.querySelector('[data-act="setsort"]');
      if (setSortBtn) setSortBtn.onclick = e => {
        e.stopPropagation();
        location.href = "/locations.html#edit=" + encodeURIComponent(r.locationId);
      };

      const body = $(o.wmsWrapId + "_body");
      const stop = fn => e => { e.stopPropagation(); fn(); };
      acts.querySelector('[data-act="inc"]').onclick = stop(() => {
        const old = r.quantity; r.quantity++;
        G.logAudit({ action: "add", ...G.auditCard(r), qty: 1, oldQty: old, newQty: r.quantity, to: G.locName(r.locationId), note: "Row +1" });
        G.persist();
      });
      acts.querySelector('[data-act="dec"]').onclick = stop(async () => {
        if (G.lentQty(r) && !G.availableQty(r)) {
          toast("Every copy of " + r.name + " here is lent out. Mark it returned first.", "err");
          return;
        }
        if (r.quantity <= 1) {
          const ok = await confirmDialog(G.simpleMode
            ? "Remove the last copy of " + r.name + "? It will be taken out of your inventory."
            : "Remove the last copy of " + r.name + "? This deletes the stack.",
            { title: G.simpleMode ? "Remove this card?" : "Delete stack?", danger: true, okLabel: G.simpleMode ? "Remove" : "Delete" });
          if (!ok) return;
          G.deleteRecord(r.id);
          return;
        }
        const old = r.quantity;
        G.removeCost(r, 1);
        r.quantity--;
        if (r.listedQty > r.quantity) r.listedQty = r.quantity;
        G.logAudit({ action: "remove", ...G.auditCard(r), qty: -1, oldQty: old, newQty: r.quantity, from: G.locName(r.locationId), note: "Row −1" });
        G.persist();
      });
      acts.querySelector('[data-act="manage"]').onclick = stop(() => openManage(r.id, () => render()));
      const rowsel = tr.querySelector(".rowsel");
      rowsel.onclick = e => e.stopPropagation();
      rowsel.onchange = () => {
        if (rowsel.checked) selectedIds.add(r.id); else selectedIds.delete(r.id);
        tr.classList.toggle("bulk-sel", rowsel.checked);
        const selAllEl = $(o.wmsWrapId + "_selAll");
        if (selAllEl) syncSelectAll(selAllEl);
        notifySelection();
      };
      tr.onclick = () => {
        selectedId = r.id;
        [...body.querySelectorAll("tr.sel")].forEach(t => t.classList.remove("sel"));
        tr.classList.add("sel");
        if (o.onSelect) o.onSelect(r);
      };
      // Right-click: the same actions the row's own buttons already expose
      // (reused via .click() rather than re-implemented, so there is only
      // ever one copy of "what removing the last copy does") plus a select
      // toggle, for a faster path than hunting the row-actions cell itself.
      tr.oncontextmenu = e => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "+ Add one copy", onClick: () => acts.querySelector('[data-act="inc"]').click() },
          { label: "− Remove one copy", onClick: () => acts.querySelector('[data-act="dec"]').click() },
          null,
          { label: "Manage…", onClick: () => acts.querySelector('[data-act="manage"]').click() },
          { label: "Card details…", onClick: () => openCardPanel(r) },
          null,
          { label: rowsel.checked ? "Deselect" : "Select", onClick: () => { rowsel.checked = !rowsel.checked; rowsel.onchange(); } }
        ]);
      };
      wireArtHover(tr, () => r.imageUrl);
      tr._fp = rowFingerprint(r);
    }

    let rowNodes = new Map(); // card id -> <tr>, reused across renders
    // A large account's inventory (BACKLOG.md: ~70k owned stacks is a real,
    // supported size) previously had no ceiling here at all - every matching
    // row became a live <tr>, every render, forever. Cap what actually
    // reaches the DOM and let a "Show N more" row (below) raise the cap on
    // request, the same load-more-on-demand discipline the Audit Log already
    // uses for the same reason. Resets in setFilters() below, since a new
    // filter is the normal way to narrow back down rather than keep paging.
    // Paging (#427): every view draws one page of the sorted, filtered rows
    // (sorting always runs over the whole array first, so a header sort orders
    // across every page). A search/filter/sort/view change goes back to page 1;
    // a re-render from a row action or a save keeps the page (clamped).
    const PAGE_SIZES = [50, 100, 250, 500];
    const PAGE_SIZE_KEY = "grimoire.gridPageSize";
    function gridPageMath(total, page, size) {
      const pages = Math.max(1, Math.ceil(total / size));
      const p = Math.min(Math.max(0, page | 0), pages - 1);
      const start = p * size;
      return { page: p, pages, start, end: Math.min(total, start + size) };
    }
    let pageSize = 100, page = 0, pagerTotal = 0, wmsAllRows = [];
    try {
      const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
      if (PAGE_SIZES.includes(saved)) pageSize = saved;
    } catch (e) { /* storage blocked: keep the default */ }
    const pager = document.createElement("div");
    pager.className = "grid-pager";
    pager.hidden = true;
    if (storefrontWrap && storefrontWrap.parentNode) storefrontWrap.parentNode.insertBefore(pager, storefrontWrap.nextSibling);

    function slicePage(rows) {
      const m = gridPageMath(rows.length, page, pageSize);
      page = m.page; pagerTotal = rows.length;
      return rows.length > pageSize ? rows.slice(m.start, m.end) : rows;
    }
    function goPage(p) {
      page = p;
      render();
      for (const el of [wmsWrap, erpWrap, storefrontWrap]) {
        if (!el || el.hidden) continue;
        el.scrollTop = 0;
        // Park the table just under the sticky top bar (measured now), then resize
        // the box so the pager still fits in the window.
        const bar = $("chromeSticky"), under = (bar ? bar.getBoundingClientRect().height : 0) + 4;
        const top = el.getBoundingClientRect().top;
        if (top < under) { window.scrollBy(0, top - under); sizeGrid(); }
      }
    }
    function renderPager() {
      const m = gridPageMath(pagerTotal, page, pageSize);
      pager.hidden = pagerTotal === 0;
      if (pager.hidden) return;
      const nav = (act, label, inner, off) => '<button type="button" class="small ghost" data-pg="' + act + '" title="' + label +
        '" aria-label="' + label + '"' + (off ? " disabled" : "") + ">" + inner + "</button>";
      const selMatching = mode === "wms" && pagerTotal > pageSize && wmsAllRows.length > 0;
      pager.innerHTML =
        '<span class="pg-range">' + (m.start + 1).toLocaleString() + "–" + m.end.toLocaleString() + " of " + pagerTotal.toLocaleString() + "</span>" +
        '<span class="pg-nav">' +
          nav("first", "First page", "First", m.page === 0) +
          nav("prev", "Previous page", icon("arrow-left"), m.page === 0) +
          '<span class="pg-of" aria-live="polite">Page ' + (m.page + 1).toLocaleString() + " of " + m.pages.toLocaleString() + "</span>" +
          nav("next", "Next page", icon("arrow-right"), m.page >= m.pages - 1) +
          nav("last", "Last page", "Last", m.page >= m.pages - 1) +
        "</span>" +
        '<label class="pg-size">Rows per page <select aria-label="Rows per page">' +
          PAGE_SIZES.map(n => '<option value="' + n + '"' + (n === pageSize ? " selected" : "") + ">" + n + "</option>").join("") +
        "</select></label>" +
        (selMatching ? '<button type="button" class="small ghost" data-pg="selmatch" title="Tick every row that matches, on all pages">Select all ' +
          pagerTotal.toLocaleString() + " matching</button>" : "");
      for (const b of pager.querySelectorAll("button[data-pg]")) {
        b.onclick = () => {
          const k = b.dataset.pg;
          if (k === "first") goPage(0);
          else if (k === "prev") goPage(m.page - 1);
          else if (k === "next") goPage(m.page + 1);
          else if (k === "last") goPage(m.pages - 1);
          else if (k === "selmatch") selectAllMatching();
        };
      }
      pager.querySelector("select").onchange = e => {
        pageSize = Number(e.target.value) || 100;
        try { localStorage.setItem(PAGE_SIZE_KEY, String(pageSize)); } catch (err) { /* won't stick */ }
        goPage(0);
      };
    }
    // The header "select all" ticks this page; this button ticks every
    // matching row on every page.
    function selectAllMatching() {
      for (const r of wmsAllRows) selectedIds.add(r.id);
      for (const [id, tr] of rowNodes) {
        tr.classList.toggle("bulk-sel", selectedIds.has(id));
        const cb = tr.querySelector(".rowsel");
        if (cb) cb.checked = selectedIds.has(id);
      }
      const selAllEl = $(o.wmsWrapId + "_selAll");
      if (selAllEl) syncSelectAll(selAllEl);
      notifySelection();
      toast("Selected all " + wmsAllRows.length.toLocaleString() + " matching rows.");
    }

    function renderBody(rows) {
      const body = $(o.wmsWrapId + "_body");
      if (!rows.length) {
        rowNodes.clear();
        body.innerHTML = '<tr><td colspan="' + WMS_COLUMNS.length + '" class="empty">' +
          (G.state.cards.length === 0
            ? 'Nothing here yet — <a href="/receive.html">' + (G.simpleMode ? 'add some cards' : 'receive some cards') + '</a> to get started.'
            : "No cards match your search or query.") + "</td></tr>";
        return;
      }
      if (body.firstElementChild && !body.firstElementChild.dataset.id) body.innerHTML = "";

      wmsAllRows = rows;
      const capped = slicePage(rows);
      const seen = new Set();
      let prevNode = null;
      for (const r of capped) {
        seen.add(r.id);
        let tr = rowNodes.get(r.id);
        if (!tr) {
          tr = document.createElement("tr");
          tr.dataset.id = r.id;
          fillRow(tr, r);
          rowNodes.set(r.id, tr);
        } else if (tr._fp !== rowFingerprint(r)) {
          fillRow(tr, r);
        } else {
          tr.classList.toggle("sel", r.id === selectedId);
        }
        const wantAfter = prevNode ? prevNode.nextSibling : body.firstChild;
        if (wantAfter !== tr) body.insertBefore(tr, wantAfter);
        prevNode = tr;
      }
      for (const [id, node] of rowNodes) {
        if (!seen.has(id)) { node.remove(); rowNodes.delete(id); }
      }

      const selAllEl = $(o.wmsWrapId + "_selAll");
      if (selAllEl) {
        syncSelectAll(selAllEl);
        selAllEl.onchange = () => {
          for (const r of capped) {
            if (selAllEl.checked) selectedIds.add(r.id); else selectedIds.delete(r.id);
            const tr = rowNodes.get(r.id);
            if (tr) {
              tr.classList.toggle("bulk-sel", selAllEl.checked);
              const cb = tr.querySelector(".rowsel");
              if (cb) cb.checked = selAllEl.checked;
            }
          }
          notifySelection();
        };
      }
    }
    // Recomputes the header "select all" checkbox's checked/indeterminate
    // state from whichever rows are currently rendered (rowNodes' keys),
    // not the full unfiltered/uncapped dataset - "select all" means all
    // visible, the same scope listings.html's #planAll uses.
    function syncSelectAll(selAllEl) {
      const ids = [...rowNodes.keys()];
      const allSel = ids.length > 0 && ids.every(id => selectedIds.has(id));
      const someSel = ids.some(id => selectedIds.has(id));
      selAllEl.checked = allSel;
      selAllEl.indeterminate = !allSel && someSel;
    }

    let erpRowNodes = new Map(); // card name -> <tr>, reused across renders (same idiom as renderBody above)

    function erpRowFingerprint(a) {
      return [a.qty, a.listed, a.printings, a.locs, a.low, a.high, a.costQty, a.cost, a.value, loansKey(a.loans)].join("|");
    }
    function fillErpRow(tr, a) {
      tr.className = "click";
      tr.title = "Click to drill into the per-stack detail for this card";
      tr.innerHTML =
        artThumbTd(a.imageUrl) +
        "<td>" + cardNameLink(a.name) + loanTags(a.loans) + "</td>" +
        '<td class="num">' + a.qty + "</td>" +
        '<td class="num">' + (a.listed > 0 ? '<span class="badge sale">' + a.listed + "</span>" : '<span class="muted">0</span>') + "</td>" +
        '<td class="num">' + a.printings + "</td>" +
        '<td class="num">' + a.locs + "</td>" +
        '<td class="num">' + money(a.low) + "</td>" +
        '<td class="num">' + money(a.high) + "</td>" +
        '<td class="num">' + (a.costQty ? money(a.cost) : '<span class="muted">—</span>') + "</td>" +
        '<td class="num">' + money(a.value) + "</td>";
      tr.onclick = () => {
        filters.text = a.name;
        filters.exactName = a.name;
        if (o.onDrill) o.onDrill(a.name);
        setMode("wms");
      };
      wireArtHover(tr, () => a.imageUrl);
      tr._fp = erpRowFingerprint(a);
    }

    function renderErp() {
      const head = $(o.erpWrapId + "_head");
      head.innerHTML = "";
      for (const c of ERP_COLUMNS) {
        const th = document.createElement("th");
        if (c.type === "none") { th.textContent = c.label; head.appendChild(th); continue; }
        th.className = (c.num ? "num " : "") + "sortable";
        th.innerHTML = c.label + '<span class="arrow">' + (erpSortKey === c.key ? (erpSortDir === 1 ? " ▲" : " ▼") : "") + "</span>";
        th.onclick = () => {
          if (erpSortKey === c.key) erpSortDir = -erpSortDir;
          else { erpSortKey = c.key; erpSortDir = c.num ? -1 : 1; }
          page = 0;
          render();
        };
        head.appendChild(th);
      }
      linkHead(head);
      const q = String(filters.text || "").trim().toLowerCase();
      let rows = G.aggregateByName(filters.query).filter(a => !q || a.hay.includes(q));
      const col = ERP_COLUMNS.find(c => c.key === erpSortKey) || { type: "str" };
      rows.sort((x, y) => {
        const av = x[erpSortKey], bv = y[erpSortKey];
        const cmp = col.type === "num" ? (Number(av) || 0) - (Number(bv) || 0)
          : String(av || "").localeCompare(String(bv || ""), undefined, { sensitivity: "base" });
        return cmp * erpSortDir;
      });
      const body = $(o.erpWrapId + "_body");
      if (!rows.length) {
        erpRowNodes.clear();
        body.innerHTML = '<tr><td colspan="' + ERP_COLUMNS.length + '" class="empty">' +
          (G.state.cards.length === 0 ? "No cards yet." : "No card names match your search.") + "</td></tr>";
        return;
      }
      if (body.firstElementChild && !body.firstElementChild.dataset.name) body.innerHTML = "";

      const capped = slicePage(rows);
      const seen = new Set();
      let prevNode = null;
      for (const a of capped) {
        seen.add(a.name);
        let tr = erpRowNodes.get(a.name);
        if (!tr) {
          tr = document.createElement("tr");
          tr.dataset.name = a.name;
          fillErpRow(tr, a);
          erpRowNodes.set(a.name, tr);
        } else if (tr._fp !== erpRowFingerprint(a)) {
          fillErpRow(tr, a);
        }
        const wantAfter = prevNode ? prevNode.nextSibling : body.firstChild;
        if (wantAfter !== tr) body.insertBefore(tr, wantAfter);
        prevNode = tr;
      }
      for (const [name, node] of erpRowNodes) {
        if (!seen.has(name)) { node.remove(); erpRowNodes.delete(name); }
      }
    }

    /* The only grain with a listed-quantity control. WMS shows one row per
       stack per location - editing "listed" there would mean guessing which
       of possibly several rows sharing one Manapool identity the click was
       meant to apply to, when Manapool itself has no idea locations exist.
       Storefront already has exactly one row per identity, so the button is
       unambiguous: G.storefrontListedPush picks which stack moves (the
       highest-pick-priority one in a location with "Sell from" on, #194) and
       reconciles the rest of the listing's stacks. */
    function renderStorefront() {
      const head = $(o.storefrontWrapId + "_head");
      head.innerHTML = "";
      for (const c of STOREFRONT_COLUMNS) {
        const th = document.createElement("th");
        if (c.type === "none") { th.textContent = c.label; head.appendChild(th); continue; }
        th.className = (c.num ? "num " : "") + "sortable" + (c.cls ? " " + c.cls : "");
        if (c.title) th.title = c.title;
        th.innerHTML = c.label + '<span class="arrow">' + (sfSortKey === c.key ? (sfSortDir === 1 ? " ▲" : " ▼") : "") + "</span>";
        th.onclick = () => {
          if (sfSortKey === c.key) sfSortDir = -sfSortDir;
          else { sfSortKey = c.key; sfSortDir = c.num ? -1 : 1; }
          page = 0;
          render();
        };
        head.appendChild(th);
      }
      linkHead(head);
      const q = String(filters.text || "").trim().toLowerCase();
      let rows = G.aggregateStorefront(filters.query).filter(a => !q || a.hay.includes(q));
      const col = STOREFRONT_COLUMNS.find(c => c.key === sfSortKey) || { type: "str" };
      rows.sort((a, b) => {
        let av = sfSortKey === "sold7d" ? soldSortValue(a) : a[sfSortKey], bv = sfSortKey === "sold7d" ? soldSortValue(b) : b[sfSortKey];
        let cmp;
        if (col.type === "num") cmp = (Number(av) || 0) - (Number(bv) || 0);
        else if (col.type === "bool") cmp = (av ? 1 : 0) - (bv ? 1 : 0);
        else if (col.type === "nat") cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
        else cmp = String(av || "").localeCompare(String(bv || ""), undefined, { sensitivity: "base" });
        return cmp * sfSortDir;
      });
      const body = $(o.storefrontWrapId + "_body");
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="' + STOREFRONT_COLUMNS.length + '" class="empty">' +
          (G.state.cards.length === 0 ? "No cards yet." : "No cards match your search.") + "</td></tr>";
        return;
      }
      body.innerHTML = "";
      const capped = slicePage(rows);
      const frag = document.createDocumentFragment();
      for (const a of capped) {
        const tr = document.createElement("tr");
        tr.className = "click";
        tr.title = "Click to manage this stack";
        tr.innerHTML =
          artThumbTd(a.imageUrl) +
          "<td>" + esc(a.set.toUpperCase()) + "</td>" +
          "<td>" + esc(a.collector) + "</td>" +
          '<td><span class="pill">' + esc(G.LANG_NAMES[a.lang] || a.lang) + "</span></td>" +
          "<td>" + finishBadge(a.finish) + "</td>" +
          '<td><span class="pill cond">' + esc(a.condition || "NM") + "</span></td>" +
          "<td>" + cardLink(a) + loanTags(a.loans) + "</td>" +
          '<td class="num">' + money(a.price) + "</td>" +
          '<td class="num">' + a.qty + "</td>" +
          soldTd(a, "hide-sm") +
          '<td class="num"><span class="listed-ctl">' +
            '<button data-act="unlist" title="Unlist one from Manapool" aria-label="Unlist one from Manapool">−</button>' +
            (a.listed > 0 ? '<span class="badge sale">' + a.listed + "</span>" : '<span class="muted">0</span>') +
            '<button data-act="list" title="List one on Manapool" aria-label="List one on Manapool">+</button>' +
          "</span></td>" +
          '<td class="num">' + a.locs + "</td>";
        const stop = fn => e => { e.stopPropagation(); fn(); };
        const rep = () => (G.manapoolGroup(a.identityKey) || [])[0];
        tr.querySelector('[data-act="list"]').onclick = stop(() => { if (rep()) pushListedDelta(a.identityKey, 1); });
        tr.querySelector('[data-act="unlist"]').onclick = stop(() => { if (rep()) pushListedDelta(a.identityKey, -1); });
        tr.onclick = () => { const r = rep(); if (r) openManage(r.id, () => render()); };
        wireArtHover(tr, a.imageUrl);
        frag.appendChild(tr);
      }
      body.appendChild(frag);
    }

    function sizeGrid() {
      for (const el of [wmsWrap, erpWrap, storefrontWrap]) {
        if (!el || el.hidden) continue;
        const top = el.getBoundingClientRect().top;
        const pg = pager.hidden ? 0 : pager.offsetHeight + 8;
        el.style.maxHeight = Math.max(240, Math.round(window.innerHeight - top - 20 - pg)) + "px";
      }
    }

    function render() {
      pagerTotal = 0;
      wmsWrap.hidden = mode !== "wms";
      erpWrap.hidden = mode !== "erp";
      storefrontWrap.hidden = mode !== "storefront";
      let rows;
      if (mode === "erp") { renderErp(); rows = filteredRows(); }
      else if (mode === "storefront") { renderStorefront(); rows = filteredRows(); }
      else { pickAlloc = G.pickAllocations(); rows = filteredRows(); renderHead(); renderBody(rows); }
      renderPager();
      sortSm.hidden = mode !== "wms";
      if (sortSm.querySelector('option[value="' + sortKey + '"]')) sortSm.value = sortKey;
      sizeGrid();
      if (o.onRender) o.onRender(rows, mode);
      return rows;
    }

    function setMode(m) { if (m !== mode) page = 0; mode = m; render(); }
    function setFilters(f) {
      if ("loc" in f && f.loc !== filters.loc) locOrder = true;
      Object.assign(filters, f); page = 0; render();
    }

    window.addEventListener("resize", G.debounce(sizeGrid, 120));
    G.on("change", () => render());
    // Sold 7d (#366) arrives after the first draw.
    G.on("sold", () => render());

    return {
      render, setMode, setFilters,
      get mode() { return mode; },
      gridPageMath,
      get filters() { return filters; },
      // The location whose sorting method orders the WMS rows right now, or null.
      get orderLocation() { return orderLoc(); },
      // True while a location with no sorting method is shown in set + collector number order (#334).
      get setOrdered() { return implicitSetOrder; },
      rows: filteredRows,
      selected: () => G.state.cards.find(r => r.id === selectedId) || null,
      select: id => { selectedId = id; render(); },
      getSelectedRows: () => G.state.cards.filter(r => selectedIds.has(r.id)),
      clearSelection: () => { selectedIds.clear(); notifySelection(); render(); }
    };
  }

  /* ============================== Generic column sorting ==============================
     Any <table data-sort> becomes click-to-sort on every column, with no work in
     the page that renders it. It sorts the rows that are currently in the DOM
     rather than the underlying data, which is what makes it universal: most of
     these tables are built as innerHTML strings by a dozen different render
     functions, and teaching each one to sort would mean rewriting all of them.

     The cost of that choice: a re-render drops back to the render order. Pages
     that re-render on a filter change call reapplySorts() to put it back. */
  const SORT_STATE = new WeakMap();      // table -> {col, dir}

  const CLEAN_NUM = /^[-+]?[$€£]?\s*[\d,]*\.?\d+\s*%?$/;
  // A cell whose display text isn't itself parseable (an arrow icon, a
  // badge, anything decorative wrapped around the number) can opt out of
  // text-scraping entirely with data-v="<the number to sort by>" - sorting
  // then reads that instead of textContent, so a cell is always free to
  // format itself however reads best without silently breaking its column.
  // data-vs="<text>" is the text counterpart: always compared as text
  // (case-insensitive, natural order), never as a number - so a bin named
  // "101" stays a name. For cells whose textContent is useless as a key,
  // e.g. a <select>, whose text is every option run together and so
  // identical on every row (#79).
  function cellValue(td) {
    if (td && td.dataset && td.dataset.vs !== undefined) {
      const s = td.dataset.vs.trim();
      return s ? { empty: false, n: 0, s: s.toLowerCase() } : { empty: true, n: 0, s: "" };
    }
    if (td && td.dataset && td.dataset.v !== undefined) {
      const n = Number(td.dataset.v);
      if (td.dataset.v === "" || isNaN(n)) return { empty: true, n: 0, s: "" };
      return { empty: false, n, s: td.dataset.v, numeric: true };
    }
    const raw = (td ? td.textContent : "").trim();
    if (!raw || raw === "—" || raw === "-" || raw === "∞") return { empty: true, n: 0, s: "" };
    // Numbers, money and percentages all sort numerically.
    const stripped = raw.replace(/[$€£,\s%]/g, "").replace(/^\+/, "");
    if (CLEAN_NUM.test(raw) && stripped !== "" && !isNaN(Number(stripped))) {
      return { empty: false, n: Number(stripped), s: raw, numeric: true };
    }
    // A leading count like "3 · $12.40" or "12/400" sorts on its first number -
    // but only when a separator (space, ·, /, etc.) follows the digits, not
    // when a letter is fused directly onto them. Without that boundary check,
    // an MTG set code like "2X2" (Double Masters 2022) or "40K" would match
    // as "the number 2/40" and sort into the middle of alphabetic set codes
    // like "NEO"/"MH3" - which themselves all fall through to n:0 below, so
    // one such code silently flips the WHOLE column to numeric mode
    // (anyNumeric in sortTable() is column-wide) and every alphabetic code
    // ties at 0, sorting in whatever order they happened to render rather
    // than alphabetically.
    const lead = raw.match(/^[-+]?[\d,]*\.?\d+(?=$|[^\w])/);
    if (lead && /[\d]/.test(lead[0]) && raw.length < 24) {
      const n = Number(lead[0].replace(/,/g, ""));
      if (!isNaN(n)) return { empty: false, n, s: raw, numeric: true };
    }
    const t = Date.parse(raw);
    if (!isNaN(t) && /\d{4}|\d{1,2}\/\d{1,2}/.test(raw)) return { empty: false, n: t, s: raw, numeric: true };
    return { empty: false, n: 0, s: raw.toLowerCase() };
  }

  function sortTable(table, col, dir) {
    const tbody = table.tBodies[0];
    if (!tbody) return;
    const rows = [...tbody.rows];
    // The "nothing here" placeholder must not be dragged into the ordering.
    if (rows.length < 2 || rows.some(r => r.cells.length === 1 && r.cells[0].classList.contains("empty"))) return;

    const keyed = rows.map((tr, i) => ({ tr, i, v: cellValue(tr.cells[col]) }));
    const anyNumeric = keyed.some(k => k.v.numeric);
    keyed.sort((a, b) => {
      // Blanks always sink, whichever way the column is pointing.
      if (a.v.empty !== b.v.empty) return a.v.empty ? 1 : -1;
      let cmp;
      if (anyNumeric) cmp = a.v.n - b.v.n;
      else cmp = String(a.v.s).localeCompare(String(b.v.s), undefined, { numeric: true, sensitivity: "base" });
      if (cmp === 0) cmp = a.i - b.i;                 // stable
      return cmp * dir;
    });
    const frag = document.createDocumentFragment();
    for (const k of keyed) frag.appendChild(k.tr);
    tbody.appendChild(frag);

    const heads = table.tHead ? [...table.tHead.rows[0].cells] : [];
    heads.forEach((th, i) => {
      const old = th.querySelector(".arrow");
      if (old) old.remove();
      th.classList.toggle("sorted", i === col);
      if (i === col) {
        const s = document.createElement("span");
        s.className = "arrow";
        s.textContent = dir === 1 ? " ▲" : " ▼";
        th.appendChild(s);
      }
    });
    SORT_STATE.set(table, { col, dir });
  }

  /* Rows tagged with data-idx (the position of the item they represent in
     the underlying array) report back their current on-screen order, so a
     print/export action can match whatever sort the user clicked into the
     table instead of always falling back to the array's own order. Returns
     null if the rows aren't tagged or the count doesn't match `expected`,
     so callers can fall back safely. */
  function domOrder(tbody, expected) {
    if (!tbody) return null;
    const idxs = [...tbody.rows].map(r => r.dataset.idx).filter(v => v !== undefined).map(Number);
    if (idxs.length !== expected) return null;
    return idxs;
  }

  /* A table that draws only part of its data (Listings and Bulk Price
     Evaluate draw the first 500 plan rows, #99) can't be sorted from the DOM
     alone: that would only reorder the drawn rows. Such a page registers
     dataSort(table, onSort). A header click then records the new {col, dir}
     and calls onSort(col, dir), so the page sorts its whole array and
     redraws; the redraw's reapplySorts() orders the drawn rows to match.
     sortStateOf(table) is the current {col, dir}, or null. */
  const DATA_SORT = new WeakMap();       // table -> onSort(col, dir)
  function dataSort(table, onSort) { DATA_SORT.set(table, onSort); }
  function sortStateOf(table) { return SORT_STATE.get(table) || null; }

  /* Put the user's chosen sort back after a re-render. */
  function reapplySorts(root) {
    const scope = root || document;
    scope.querySelectorAll("table[data-sort]").forEach(t => {
      if (t.classList.contains("pivot-nosort")) return;
      const s = SORT_STATE.get(t);
      if (s) sortTable(t, s.col, s.dir);
    });
  }

  /* One delegated listener for the whole page. Tables opt in with data-sort;
     individual columns opt out with data-nosort on the <th>. */
  function enableSorting() {
    document.addEventListener("click", e => {
      const th = e.target && e.target.closest ? e.target.closest("th") : null;
      if (!th) return;
      const table = th.closest("table[data-sort]");
      if (!table || !table.tHead || th.hasAttribute("data-nosort")) return;
      // A table with rows nested under other rows (Movers' card/printing
      // drill-down) can't use the generic "resort every <tr> in the tbody by
      // one column" approach below - it has no concept of a parent row's
      // children, so it would scatter printings away from their card. Such a
      // table opts out wholesale with this class rather than per-column.
      if (table.classList.contains("pivot-nosort")) return;
      // An action column with no label is not a sort key.
      if (!th.textContent.trim() && !th.querySelector("input")) return;
      if (e.target.closest("input")) return;          // the header's select-all / tick-all box itself
      if (!th.textContent.trim()) return;             // a header holding only a select-all box
      const col = th.cellIndex;
      const prev = SORT_STATE.get(table);
      const dir = (prev && prev.col === col) ? -prev.dir : 1;
      const onSort = DATA_SORT.get(table);
      if (onSort) { SORT_STATE.set(table, { col, dir }); onSort(col, dir); }
      else sortTable(table, col, dir);
    });
    // Mark headers as clickable as soon as a sortable table appears.
    const mark = () => document.querySelectorAll("table[data-sort] thead th").forEach(th => {
      if (th.hasAttribute("data-nosort")) return;
      if (!th.textContent.trim()) return;
      th.classList.add("sortable");
    });
    mark();
    setTimeout(mark, 400);
    setTimeout(mark, 1500);
  }

  /* ============================== Tiny SVG chart ============================== */
  /* A line chart with no charting library: the whole point of a price history
     page is one series over time, and that is 40 lines of SVG. */
  /* The viewBox is deliberately wide and short, and the SVG scales uniformly
     (`meet`, not `none`). Scaling non-uniformly to fill a 1800px column stretched
     the axis labels into billboards and made a 220px chart 560px tall. */
  /* `yFormat` swaps the axis label formatter (default: money) for callers
     charting something that isn't currency (e.g. EDHRec rank). `invert`
     flips which end of the value range plots at the top - for rank, a
     SMALLER number is better, so inverting makes an upward line mean
     "gaining popularity," the same "up is good" reading a price chart
     already has, instead of the literal-value default (bigger plots
     higher) reading backwards for a metric where bigger is worse. */
  function lineChart(opts) {
    const o = opts || {};
    const w = o.width || 1600, h = o.height || 300;
    const pad = { l: 62, r: 16, t: 16, b: 30 };
    const series = (o.series || []).filter(s => s.values && s.values.some(v => v != null));
    if (!series.length || !o.labels || o.labels.length < 2) {
      return '<div class="empty">' + esc(o.emptyText || "Not enough price history yet — snapshots build up one a day.") + "</div>";
    }
    const all = series.flatMap(s => s.values).filter(v => v != null);
    let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi === lo) { hi = lo + Math.max(0.5, lo * 0.1); lo = Math.max(0, lo - Math.max(0.5, lo * 0.1)); }
    const n = o.labels.length;
    const x = i => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r);
    const frac = v => (v - lo) / (hi - lo);
    const y = o.invert
      ? v => pad.t + frac(v) * (h - pad.t - pad.b)
      : v => pad.t + (1 - frac(v)) * (h - pad.t - pad.b);
    const fmt = o.yFormat || money;

    let svg = '<svg class="chart" viewBox="0 0 ' + w + " " + h +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' +
      esc(o.title || "Price history") + '">';
    for (let g = 0; g <= 4; g++) {
      const v = lo + (hi - lo) * (g / 4);
      const yy = y(v);
      svg += '<line class="grid-line" x1="' + pad.l + '" y1="' + yy.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + yy.toFixed(1) + '"/>';
      svg += '<text class="axis-text" x="' + (pad.l - 8) + '" y="' + (yy + 4).toFixed(1) +
        '" text-anchor="end">' + esc(fmt(v)) + "</text>";
    }
    const ticks = Math.min(8, n);
    for (let t = 0; t < ticks; t++) {
      const i = Math.round((t / Math.max(1, ticks - 1)) * (n - 1));
      svg += '<text class="axis-text" x="' + x(i).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle">' +
        esc(String(o.labels[i]).slice(5)) + "</text>";
    }
    for (const s of series) {
      const pts = [];
      s.values.forEach((v, i) => { if (v != null) pts.push(x(i).toFixed(1) + "," + y(v).toFixed(1)); });
      if (pts.length < 2) continue;
      svg += '<polyline class="series' + (s.cls ? " " + s.cls : "") + '" points="' + pts.join(" ") + '"/>';
    }
    return svg + "</svg>";
  }

  function barList(rows, opts) {
    const o = opts || {};
    if (!rows.length) return '<div class="muted">Nothing to show.</div>';
    const max = Math.max.apply(null, rows.map(r => Math.abs(Number(r.value) || 0))) || 1;
    return '<div class="bars">' + rows.map(r => {
      const pctW = Math.max(1, (Math.abs(Number(r.value) || 0) / max) * 100);
      return '<div class="bar-row"><span class="nowrap" title="' + esc(r.label) + '">' + esc(r.label) + "</span>" +
        '<span class="bar-track"><span class="bar' + (o.alt ? " alt" : "") + '" style="width:' + pctW.toFixed(1) + '%"></span></span>' +
        '<span class="num">' + esc(r.text != null ? r.text : String(r.value)) + "</span></div>";
    }).join("") + "</div>";
  }

  /* ============================== Boot helper ============================== */
  /* ============================== Support ticket thread ============================== */
  /* Renders a ticket's messages + a reply box into `host` - the one widget
     shared by help.html's Support tab (a user's own tickets) and admin.html's
     ticket queue, since both need exactly the same thing. `onReply(text)` posts
     the reply and must return the updated ticket (or throw); this function
     re-renders itself with the result so the caller does not have to. Any
     extra controls a caller wants (e.g. the moderator queue's status
     selector) belong in a sibling element the caller manages itself - this
     function only ever touches `host`. */
  function renderTicketThread(host, ticket, onReply) {
    host.innerHTML = ticket.messages.map(m => {
      const staffMsg = m.fromRole && m.fromRole !== "user";
      return '<div class="ticket-msg' + (staffMsg ? " staff" : "") + '">' +
        '<div class="tm-head"><b>' + esc(m.fromUsername) + '</b>' +
          (staffMsg ? ' <span class="pill on">staff</span>' : "") +
          '<span class="muted">' + new Date(m.at).toLocaleString() + '</span></div>' +
        '<div class="tm-body">' + esc(m.body).replace(/\n/g, "<br>") + '</div>' +
        '</div>';
    }).join("");

    const replyBox = document.createElement("div");
    replyBox.className = "ticket-reply";
    replyBox.innerHTML = '<textarea placeholder="Write a reply…" rows="3" maxlength="1000"></textarea>' +
      '<div class="form-row" style="margin-top:6px"><span class="spacer"></span>' +
      '<button class="small primary">Send</button></div>';
    const ta = replyBox.querySelector("textarea");
    const btn = replyBox.querySelector("button");
    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        const updated = await onReply(text);
        renderTicketThread(host, updated, onReply);
      } catch (e) { toast(e.message, "err"); btn.disabled = false; }
    };
    host.appendChild(replyBox);
  }

  /* ============================== What's new (#455) ==============================
     Short step cards for a newly added feature. On the next load of any desk
     page (UI.boot), a signed-in person who hasn't finished one gets it and
     clicks through to Done: no X, Esc or outside click (the owner wants it
     completed). Several play one after another. Finished ids are a personal
     pref (whatsNewDone, server-side), so each plays once per person, on any
     device. Help > Guide > "What's new" lists them all for a replay, which
     can be closed. The welcome tour, Warehouse Mode, the kiosk and print
     views never run UI.boot, so none of them shows these.

     Adding one is one entry in WHATS_NEW, newest last:
       id        lowercase letters, digits and dashes, at most 32 (never reuse one)
       released  the day it ships ("YYYY-MM-DD"). An account made more than
                 WHATS_NEW_GRACE_DAYS after that never gets it, so a new account
                 straight off the welcome tour isn't shown old news, and a
                 release that slips by days or weeks still reaches everyone
                 who had an account before it (owner, on #455: 30 days).
       audience  a WHATS_NEW_AUDIENCE key
       title, summary (one sentence, for the Help list)
       steps     2-4 of { img, w, h, alt, text }: a WebP under /img/ (from
                 tools/screenshot.js on a scratch server, never live data)
                 and a sentence or two. */
  const WHATS_NEW = [
    { id: "mp-mark-shipped", released: "2026-11-12", audience: "manapool",
      title: "Mark shipped now tells Manapool",
      summary: "Marking a Manapool order's ticket shipped also marks the order shipped on Manapool, with the carrier and tracking number.",
      steps: [
        { img: "/img/whats-new-mp-ship-1.webp", w: 842, h: 477,
          alt: "The Pick list tab of Order Fulfillment: three picked tickets ticked, with the Mark shipped button above them.",
          text: "Mark shipped now tells Manapool too, so there's no second trip to their site. It's on Order Fulfillment, Pick list tab: tick picked tickets and press Mark shipped, or open a picked ticket and press its Mark shipped button." },
        { img: "/img/whats-new-mp-ship-2.webp", w: 900, h: 396,
          alt: "The Mark shipped table: a row per order with the buyer, a Carrier box set to USPS and a Tracking # box. The Ground Advantage order says Tracking required.",
          text: "A table opens with a row per order: the carrier (USPS to start; Set all carriers changes every row) and a tracking number. Tracking is optional, except on Ground Advantage orders, marked Tracking required." },
        { img: "/img/whats-new-mp-ship-3.webp", w: 556, h: 139,
          alt: "A red Not sent to Manapool panel with the reason, and Retry and Open in Manapool buttons.",
          text: "If Manapool can't be reached or says no, the ticket stays on the Pick list tab as not sent to Manapool, with the reason. Press Retry to send it again." }
      ] },
    { id: "shipping-costs", released: "2026-11-12", audience: "manapool",
      title: "Your shipping costs, in Settings",
      summary: "Settings has a Shipping tab for what packing and posting an order costs you: supplies, packing rules and postage.",
      steps: [
        { img: "/img/whats-new-ship-1.webp", w: 776, h: 349,
          alt: "Settings, Shipping tab: the Supplies table with a cost each and a weight each for #10 envelope, penny sleeve, toploader and more.",
          text: "Settings has a new Shipping tab for what packing and posting an order costs you. Supplies lists everything you pack with, with its cost and weight. It starts with typical prices, so change them to yours and press Save shipping costs. In a store, a manager or owner sets them." },
        { img: "/img/whats-new-ship-2.webp", w: 776, h: 247,
          alt: "The Packing rules table: Letter up to 8 cards and $50, Small bubble mailer up to 25 cards, Large bubble mailer up to 60 cards, then Box.",
          text: "Packing rules choose the package and supplies by the number of cards and the order value. An order uses the first rule it fits, top to bottom. Click a rule to change what it uses or where it stops." },
        { img: "/img/whats-new-ship-3.webp", w: 776, h: 373,
          alt: "Postage: a stamp price, an extra-ounce price and the heaviest letter, then a table of tracked parcel prices by weight.",
          text: "Postage: a letter pays a stamp plus a little for each extra ounce. A tracked parcel pays your own price for its weight. A Manapool order that needs tracking never goes as a letter." },
        { img: "/img/whats-new-ship-4.webp", w: 776, h: 108,
          alt: "Try it with 12 cards and $35: Small bubble mailer, 2.45 oz, supplies $0.80 plus postage $4.10 equals $4.90.",
          text: "Try it shows what an order would cost and which rule it uses, so you can check your numbers before you save." }
      ] },
    { id: "pricing-portfolio-tabs", released: "2026-11-16", audience: "full",
      title: "Sealed pricing and Portfolio have their own tabs",
      summary: "Listings has a Sealed pricing tab apart from Card pricing, and Movers has a Portfolio tab for the portfolio value chart.",
      steps: [
        { img: "/img/whats-new-sealed-pricing-1.webp", w: 839, h: 455,
          alt: "Listings with five tabs: Rules, Evaluate & Apply, Card pricing, Sealed pricing and Manapool. Sealed pricing is open, showing sealed price rules and Evaluate sealed.",
          text: "Sealed price rules and Evaluate sealed moved off the pricing page into their own Sealed pricing tab on Listings. Card pricing keeps the card price rules, Evaluate and the Schedule. They work as before." },
        { img: "/img/whats-new-portfolio-1.webp", w: 839, h: 249,
          alt: "Movers with a Portfolio tab open: the Portfolio value chart with Vendor and Range picks above it.",
          text: "The portfolio value chart is now the Portfolio tab on Movers, with its own Vendor and Range picks. Vendor is the same setting as on the Movers tab, so changing one changes the other." }
      ] },
    { id: "mp-connect", released: "2026-11-20", audience: "manapoolApp",
      title: "Connect Mana Pool with its own sign-in",
      summary: "Grimoire now connects to Mana Pool through Mana Pool's own sign-in page instead of a pasted access token. Old tokens stop working seven days after the switch.",
      steps: [
        { img: "/img/whats-new-mp-connect-1.webp", w: 1138, h: 83,
          alt: "A yellow Reconnect Mana Pool banner at the top of the Dashboard: the old access token stops working on a date, with a Connect Mana Pool link.",
          text: "If you pasted a Mana Pool email and access token before, every page now shows this reminder with the date the old token stops working. Until then everything keeps working as before." },
        { img: "/img/whats-new-mp-connect-2.webp", w: 746, h: 268,
          alt: "Settings, Integrations tab, Mana Pool: a Reconnect Mana Pool note with the date, and the Connect Mana Pool, Disconnect and Test Mana Pool buttons.",
          text: "Go to Settings, Integrations tab (or press the link in the reminder) and press Connect Mana Pool. There is nothing to type in. Mana Pool's own page opens (sign in there if it asks) and lists what Grimoire may do: your listings, your orders and shipping, and your purchases. Press its allow button. If another app already manages your listings, use Connect without listing changes." },
        { img: "/img/whats-new-mp-connect-3.webp", w: 746, h: 174,
          alt: "Settings, Integrations tab, Mana Pool: Connected since a date, with Disconnect and Test Mana Pool buttons.",
          text: "Back in Settings it says Connected, and the old token is deleted. To end the connection, press Disconnect here, or remove Grimoire on Mana Pool under Integrations, Connected apps. Either way Grimoire asks you to reconnect before it uses Mana Pool again." }
      ] }
  ];
  /* Who each tutorial is for: async, asked at most once per page load. */
  const WHATS_NEW_AUDIENCE = {
    everyone: async () => true,
    // Simple mode hides Listings and Movers (NAV_ADVANCED_ONLY), so a tutorial about them is for full mode.
    full: async () => !G.simpleMode,
    // Selling on Manapool: full mode (Simple mode hides Order Fulfillment),
    // Manapool switched on for this site, and this person's own connection
    // or Manapool order tickets in the inventory they work in (in a store,
    // the connection may be a teammate's).
    manapool: async () => mpSeller(false),
    // #499: the same people, once an administrator has saved Grimoire's Mana Pool app
    // (before that, Connect Mana Pool can't work, so the tutorial waits, unseen).
    manapoolApp: async () => mpSeller(true)
  };
  async function mpSeller(needApp) {
    if (G.simpleMode) return false;
    const d = await G.api("/api/integrations");
    const mp = d && d.manapool;
    if (!mp || !mp.featureOn || (needApp && !mp.appReady)) return false;
    // #499: also anyone whose connection ended (an old token removed, or disconnected on Mana Pool).
    return !!mp.hasToken || !!mp.dead || G.pickLists().some(p => p && p.source === "manapool");
  }
  // Same rules as the server's orgs.whatsNewClean (the pref's route takes 4 KB).
  const WHATS_NEW_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const WHATS_NEW_MAX = 60;
  function whatsNewClean(list) {
    const seen = new Set(), out = [];
    for (const id of Array.isArray(list) ? list : []) {
      if (typeof id !== "string" || !WHATS_NEW_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.slice(-WHATS_NEW_MAX);
  }
  /* The tutorials in `list` not finished yet (`done`) for an account made no
     more than WHATS_NEW_GRACE_DAYS after each was released (no or a bad
     createdAt counts as an old account). */
  const WHATS_NEW_GRACE_DAYS = 30;
  function whatsNewDue(list, done, createdAt) {
    const fin = new Set(whatsNewClean(done));
    const made = Date.parse(createdAt);
    const cutoff = t => Date.parse(t.released + "T00:00:00Z") + WHATS_NEW_GRACE_DAYS * 86400000;
    return list.filter(t => !fin.has(t.id) && !(made > cutoff(t)));
  }
  function whatsNewModal() {
    let el = $("whatsNewModal");
    if (el) return el;
    el = document.createElement("div");
    el.id = "whatsNewModal";
    el.className = "modal-backdrop";
    el.hidden = true;
    el.innerHTML = '<div class="modal whats-new" role="dialog" aria-modal="true" aria-labelledby="wnTitle" aria-describedby="wnText">' +
      '<div class="wn-head"><span class="eyebrow" id="wnEyebrow">What\'s new</span><span class="wn-count" id="wnCount"></span>' +
      '<button type="button" class="small ghost" id="wnClose" title="Close" aria-label="Close">' + icon("x") + "</button></div>" +
      '<h3 id="wnTitle"></h3>' +
      '<figure class="wn-shot"><img id="wnImg" alt=""></figure>' +
      '<p class="wn-text" id="wnText"></p>' +
      '<div class="modal-actions"><button type="button" class="ghost" id="wnBack">' + icon("arrow-left") + " Back</button>" +
      '<span class="spacer"></span><button type="button" class="primary" id="wnNext"></button></div></div>';
    // A replay closes on an outside click; a first showing doesn't (data-must-finish, Esc too).
    el.addEventListener("click", e => { if (e.target === el && !el.hasAttribute("data-must-finish")) hideModal("whatsNewModal"); });
    document.body.appendChild(el);
    return el;
  }
  /* Plays tutorials one after another. o.must: Done is the only way out (a
     first showing); otherwise X, Esc and an outside click close it (a replay).
     o.onDone(t) runs as each one is finished. Resolves once it's closed. */
  function playWhatsNew(list, o) {
    const opts = o || {};
    const todo = (list || []).filter(t => t && Array.isArray(t.steps) && t.steps.length);
    if (!todo.length) return Promise.resolve();
    const el = whatsNewModal();
    if (opts.must) el.setAttribute("data-must-finish", ""); else el.removeAttribute("data-must-finish");
    $("wnClose").hidden = !!opts.must;
    // Fetch every picture now, so Next never waits on one.
    todo.forEach(t => t.steps.forEach(s => { try { new Image().src = s.img; } catch (e) { /* drawn anyway */ } }));
    let ti = 0, si = 0, ended = false;
    return new Promise(resolve => {
      const end = () => { if (ended) return; ended = true; onClose("whatsNewModal", null); resolve(); };
      const draw = () => {
        const t = todo[ti], s = t.steps[si];
        $("wnEyebrow").textContent = "What's new" + (todo.length > 1 ? " · " + (ti + 1) + " of " + todo.length : "");
        $("wnCount").textContent = (si + 1) + " of " + t.steps.length;
        $("wnTitle").textContent = t.title;
        const img = $("wnImg");
        img.src = s.img;
        img.alt = s.alt || "";
        if (s.w && s.h) { img.width = s.w; img.height = s.h; } else { img.removeAttribute("width"); img.removeAttribute("height"); }
        $("wnText").textContent = s.text;
        $("wnBack").hidden = si === 0;
        $("wnNext").innerHTML = si < t.steps.length - 1 ? "Next " + icon("arrow-right") : "Done";
        setTimeout(() => { try { $("wnNext").focus(); } catch (e) {} }, 0);
      };
      $("wnBack").onclick = () => { if (si > 0) { si--; draw(); } };
      $("wnNext").onclick = () => {
        const t = todo[ti];
        if (si < t.steps.length - 1) { si++; draw(); return; }
        if (opts.onDone) { try { opts.onDone(t); } catch (e) { console.error(e); } }
        if (ti < todo.length - 1) { ti++; si = 0; draw(); return; }
        end();
        hideModal("whatsNewModal");
      };
      $("wnClose").onclick = () => hideModal("whatsNewModal");
      onClose("whatsNewModal", end);
      draw();
      showModal("whatsNewModal", "wnNext");
    });
  }
  function markWhatsNewDone(id) {
    const done = whatsNewClean([].concat(G.pref("whatsNewDone") || [], id));
    return Promise.resolve(G.setPersonalPrefs({ whatsNewDone: done })).catch(() => {});
  }
  /* UI.boot, after the page has drawn: anything due and meant for this person. */
  async function whatsNewOnLoad() {
    try {
      if (!G.me || location.pathname === "/tutorial.html") return;
      const due = whatsNewDue(WHATS_NEW, G.pref("whatsNewDone"), G.me.createdAt);
      if (!due.length) return;
      const asked = new Map(), fits = [];
      for (const t of due) {
        if (!asked.has(t.audience)) {
          const ask = WHATS_NEW_AUDIENCE[t.audience];
          asked.set(t.audience, ask ? await ask().catch(() => false) : false);
        }
        if (asked.get(t.audience)) fits.push(t);
      }
      if (fits.length) await playWhatsNew(fits, { must: true, onDone: t => markWhatsNewDone(t.id) });
    } catch (e) { console.error(e); }
  }
  /* For Help's list (newest first) and its Replay buttons. */
  const whatsNew = {
    list: () => WHATS_NEW.slice().reverse().map(t => ({ id: t.id, title: t.title, summary: t.summary, released: t.released, steps: t.steps.length })),
    replay: id => {
      const t = WHATS_NEW.find(x => x.id === id);
      return t ? playWhatsNew([t], { onDone: x => markWhatsNewDone(x.id) }) : Promise.resolve();
    },
    due: whatsNewDue, clean: whatsNewClean, onLoad: whatsNewOnLoad
  };

  /* Every page ends with UI.boot(fn). It mounts the chrome, loads the collection,
     then hands control to the page, and reports a failure somewhere visible
     instead of leaving a blank screen. */
  /* #247: a table wrapper that scrolls sideways (narrow screens) must be
     reachable by keyboard, or its off-screen columns can't be scrolled to.
     Only wrappers that actually overflow get a tab stop; re-checked on resize
     and a moment after load, since pages fill their tables asynchronously. */
  function markScrollRegions() {
    document.querySelectorAll(".list-wrap, .table-wrap").forEach(el => {
      const over = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      const set = el.hasAttribute("tabindex");
      if (over && !set) { el.setAttribute("tabindex", "0"); el.dataset.scrollTab = "1"; }
      else if (!over && set && el.dataset.scrollTab) { el.removeAttribute("tabindex"); delete el.dataset.scrollTab; }
    });
  }
  let scrollRegionTimer = 0;
  function scheduleScrollRegions() {
    clearTimeout(scrollRegionTimer);
    scrollRegionTimer = setTimeout(markScrollRegions, 300);
  }

  /* #499: on every desk page, until this person connects Mana Pool through
     its sign-in: their old pasted token stops working on a set date, or Mana
     Pool ended the connection, or the old token was removed. */
  function mpReconnectBanner() {
    const b = G.mpBanner;
    const main = document.querySelector("main");
    if (!b || !main || $("mpReconnect")) return;
    let day = "";
    try { day = new Date(b.cutoffAt).toLocaleDateString(undefined, { month: "long", day: "numeric" }); } catch (e) { day = ""; }
    const text = b.kind === "grace" ? "The old access token stops working on " + (day || "a set date") +
        ". Connect through Mana Pool's own sign-in to keep your orders, listings and shipping working."
      : b.kind === "removed" ? "Your old Mana Pool access token was removed. Connect Mana Pool to use it again."
      : "Mana Pool ended Grimoire's connection to your account, so nothing is sent to or read from Mana Pool until you reconnect.";
    const el = document.createElement("div");
    el.id = "mpReconnect";
    el.className = "callout warn";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="cico">' + icon("triangle-alert") + '</span><div class="cbody"><h3>Reconnect Mana Pool</h3>' +
      esc(text) + ' <a href="/settings.html#tab=integrations">' + (b.kind === "dead" ? "Reconnect" : "Connect") + " Mana Pool</a></div>";
    main.insertBefore(el, main.firstChild);
  }

  async function boot(pageInit) {
    mountChrome();
    window.addEventListener("resize", scheduleScrollRegions);
    try {
      await G.load();
    } catch (e) {
      if ($("pageLoading")) $("pageLoading").remove();
      if (e.status === 401) return;
      toast("Could not load your collection: " + (e.message || e), "err");
      return;
    }
    if ($("pageLoading")) $("pageLoading").remove();
    // #331: a brand-new account that left the tour before choosing (closed the
    // tab, reloaded) goes back to it, instead of landing in the full business
    // app. Same test as the tour's own first-run check; finishing or pressing
    // Skip sets tutorialSeen and ends this.
    if (location.pathname !== "/tutorial.html" && !(G.me && G.me.orgId) &&
        !G.state.settings.tutorialSeen && !G.state.cards.length &&
        !(G.state.sealed || []).length) {
      location.replace("/tutorial.html");
      return;
    }
    mpReconnectBanner();
    // Simple mode: [data-full-only] elements are hidden, [data-simple-only]
    // ones shown (they start hidden in the markup).
    document.querySelectorAll("[data-full-only]").forEach(el => { if (G.simpleMode) el.hidden = true; });
    document.querySelectorAll("[data-simple-only]").forEach(el => { el.hidden = !G.simpleMode; });
    if (document.documentElement && document.documentElement.classList) document.documentElement.classList.toggle("simple-mode", !!G.simpleMode);
    // #325: the same plain page names in the tab title and the page heading.
    if (G.simpleMode && NAV_SIMPLE_LABELS[location.pathname]) {
      const nm = NAV_SIMPLE_LABELS[location.pathname];
      document.title = nm + " · Grimoire";
      const h = document.querySelector("main h1");
      if (h && h.firstChild && h.firstChild.nodeType === 3) h.firstChild.nodeValue = nm + (h.children.length ? " " : "");
    }
    // #301: glossary words in the page's own text become links with a hover preview.
    // Once per load, before the page draws user data, so redraws never rescan.
    try { if (window.Glossary) window.Glossary.linkPage({ simple: G.simpleMode }); } catch (e) { console.error(e); }
    try { await pageInit(); }
    catch (e) {
      console.error(e);
      toast("This page hit an error: " + (e.message || e), "err", String(e.stack || ""));
    }
    // #455: "What's new" step cards for anything shipped since (not awaited).
    whatsNewOnLoad();
    markScrollRegions();
    setTimeout(markScrollRegions, 1500);
    // Nudge the card database status into view if it is still building.
    try {
      const st = await G.cards.status();
      if (!st.ready) {
        toast("The server is still building its card database" +
          (st.progress ? " (" + st.progress + ")" : "") +
          ". Autocomplete and price refreshes will be thin until it finishes.", "work");
      } else if (st.error) {
        toast("The last card-database refresh failed: " + st.error, "err");
      }
    } catch (e) {}
  }

  /* One sprite icon (public/icons/sprite.svg) as markup, for code that builds
     HTML. Unquoted attributes on purpose: the same string is safe to paste
     inside a single- OR double-quoted JS literal, which is how the emoji it
     replaced were inlined across every page. Decorative only (aria-hidden) -
     the visible text beside it carries the meaning. Not for textContent,
     <option> text, title= or toast/setStatus messages - those are plain text
     and would show the markup literally. */
  /* BACKLOG #78a: every vendor's latest retail price for one printing, side
     by side, from /api/prices/history's latestByVendor. Shared by the Movers
     and Buy List price-history modals. `finish` is the row's own finish -
     that column gets the "highest" marker; the other finishes are context.
     Cardmarket is EUR with no FX feed in this app (mtgjson.js), so it is
     shown in € and deliberately left OUT of the highest/spread comparison
     rather than ranked against dollar prices as if they were one currency. */
  const VENDOR_NAMES = { tcg: "TCGplayer", ck: "Card Kingdom", cm: "Cardmarket", cs: "Cardsphere", mp: "Manapool" };
  const EUR_VENDORS = new Set(["cm"]);
  function vendorCompare(h, finish) {
    const lbv = h && h.latestByVendor;
    if (!lbv || !lbv.vendors) return "";
    const codes = Object.keys(lbv.vendors);
    const FIN = [["nonfoil", "Non-foil"], ["foil", "Foil"], ["etched", "Etched"]]
      .filter(([f]) => codes.some(c => lbv.vendors[c][f]));
    if (!FIN.length) return "";
    const focus = FIN.some(([f]) => f === finish) ? finish : FIN[0][0];
    const usd = codes.filter(c => !EUR_VENDORS.has(c) && lbv.vendors[c][focus]).map(c => ({ c, p: lbv.vendors[c][focus].price }));
    const hi = usd.length ? usd.reduce((a, b) => (b.p > a.p ? b : a)) : null;
    const lo = usd.length ? usd.reduce((a, b) => (b.p < a.p ? b : a)) : null;
    const fmtP = (c, p) => EUR_VENDORS.has(c) ? "€" + Number(p).toFixed(2) : G.money(p);
    const rows = codes.filter(c => FIN.some(([f]) => lbv.vendors[c][f])).map(c => {
      const cells = FIN.map(([f]) => {
        const e = lbv.vendors[c][f];
        if (!e) return '<td class="num muted">—</td>';
        const isHi = f === focus && hi && hi.c === c && usd.length > 1;
        const stale = e.date !== lbv.date ? ' <span class="faint" title="Last price this vendor published">(' + esc(e.date) + ")</span>" : "";
        return '<td class="num" data-v="' + e.price + '">' + (isHi ? '<b class="pos">' : "") + fmtP(c, e.price) +
          (isHi ? " ▲ highest</b>" : "") + stale + "</td>";
      }).join("");
      return "<tr><td>" + esc(VENDOR_NAMES[c] || c.toUpperCase()) + (EUR_VENDORS.has(c) ? ' <span class="faint">(EUR)</span>' : "") + "</td>" + cells + "</tr>";
    }).join("");
    let note = "";
    if (hi && lo && usd.length > 1 && lo.p > 0) {
      const spread = hi.p - lo.p;
      note = (VENDOR_NAMES[hi.c] || hi.c) + " lists the " + FIN.find(([f]) => f === focus)[1].toLowerCase() +
        " printing highest — " + G.money(spread) + " (" + Math.round(spread / lo.p * 100) + "%) above " +
        (VENDOR_NAMES[lo.c] || lo.c) + ". ";
    }
    if (codes.some(c => EUR_VENDORS.has(c) && lbv.vendors[c][focus])) {
      note += "Cardmarket's € price isn't compared - there's no exchange-rate feed. ";
    }
    return '<h4 style="margin:16px 0 8px">Retail price by vendor <span class="faint" style="font-weight:400">· latest snapshot ' +
      esc(lbv.date || "") + "</span></h4>" +
      '<div class="list-wrap" style="max-height:none"><table class="list" data-sort><thead><tr><th>Vendor</th>' +
      FIN.map(([f, label]) => '<th class="num"' + (f === focus ? ' title="The finish you opened - the one compared below"' : "") + ">" + label + (f === focus ? " ●" : "") + "</th>").join("") +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      (note ? '<div class="hint">' + esc(note.trim()) + "</div>" : "");
  }

  /* ---------- Where a card goes / sits inside a sorted location (#293) ----------
     placementPicture(p) draws a placement from G.locationLayouts() (core.js):
     a box or other location as a side view (front on the left), split into
     its level-1 sections, empty room up to the card ceiling greyed, the
     target section outlined and the card's best-guess spot marked; a binder
     as its pages, with the section's pages outlined, the target page solid
     and that page's pockets drawn. Never colour alone: outline vs solid,
     the marker and the sentence under it say the same thing.
     showPlacement(p, rec) opens it in a dialog: "Where it goes" for a
     Putaway line (p.mode "put"), "Where it is" for a stack already there
     ("here", pick lists / Inventory, #295). */
  const PIC_MAX_PAGES = 240, PIC_MAX_SEGS = 400;
  function placementPicture(p) {
    const secs = p.sections ? p.sections() : [];
    const total = p.total;
    const room = p.cap != null ? Math.max(p.cap, total) : total;
    const n = p.to - p.from + 1;
    const fmt = v => Number(v).toLocaleString();
    const pctOf = v => Math.max(0, Math.min(100, v / Math.max(1, room) * 100));
    const isTarget = s => s.from === p.section.from && s.label === p.section.label;
    if (p.perPage) {
      const per = p.perPage, pages = Math.max(1, Math.ceil(room / per));
      if (pages <= PIC_MAX_PAGES) {
        const pg = v => Math.ceil(v / per);
        const secA = pg(p.section.from), secB = pg(p.section.to), tA = pg(p.from), tB = pg(p.to);
        let cells = "";
        for (let i = 1; i <= pages; i++) {
          const filled = Math.min(per, Math.max(0, total - (i - 1) * per));
          const cls = (filled >= per ? "fil" : filled > 0 ? "par" : "vac") +
            (i >= secA && i <= secB ? " sec" : "") + (i >= tA && i <= tB ? " tgt" : "");
          cells += '<span class="pg ' + cls + '">' + i + "</span>";
        }
        // The target page's pockets, front side of the sheet as you open to it.
        const cols = per === 4 ? 2 : per === 12 || per === 16 ? 4 : Math.ceil(Math.sqrt(per));
        const a = G.binderSpot(p.from, per), b = G.binderSpot(p.to, per);
        const lastPocket = a.page === b.page ? b.pocket : per;
        let pockets = "";
        for (let k = 1; k <= per; k++) {
          const pos = (a.page - 1) * per + k;
          const cls = k >= a.pocket && k <= lastPocket ? "tgt" : pos <= total ? "fil" : "vac";
          pockets += '<span class="pk ' + cls + '">' + k + "</span>";
        }
        return '<div class="locpic binder">' +
          '<div class="locpic-cap"><span>' + esc(p.section.label) + " section · pages " + secA + (secB !== secA ? "–" + secB : "") + "</span>" +
            "<span>" + fmt(pages) + " page" + (pages === 1 ? "" : "s") + " · " + per + " per page</span></div>" +
          '<div class="locpic-pages" role="img" aria-label="' + esc("Binder pages; the " + p.section.label + " section is pages " + secA + "–" + secB + ", this card goes on page " + tA) + '">' + cells + "</div>" +
          '<div class="locpic-page"><div class="locpic-cap"><span>Page ' + a.page + ", pocket " + a.pocket + (lastPocket !== a.pocket ? "–" + lastPocket : "") + "</span></div>" +
            '<div class="locpic-pockets" style="grid-template-columns:repeat(' + cols + ',1fr)" aria-hidden="true">' + pockets + "</div></div>" +
          '<div class="locpic-key"><span><i class="k fil"></i>filled</span><span><i class="k vac"></i>empty</span>' +
            '<span><i class="k sec"></i>' + esc(p.section.label) + " section</span><span><i class=\"k tgt\"></i>" + (p.mode === "here" ? "where it is" : "where it goes") + "</span></div>" +
          "</div>";
      }
    }
    // Side view. The filled run is one bar underneath, so a section too thin
    // to draw (one card among 70,000) still reads as filled.
    let segs = "", labels = "";
    let drawn = 0;
    secs.forEach((s, i) => {
      const left = pctOf(s.from - 1), w = pctOf(s.cards), tgt = isTarget(s);
      if (!tgt && (w < 0.3 || drawn >= PIC_MAX_SEGS)) return;
      drawn++;
      segs += '<span class="seg ' + (tgt ? "tgt" : i % 2 ? "b" : "a") + '" style="left:' + left.toFixed(3) + "%;width:" + (tgt ? Math.max(w, 1.2) : w).toFixed(3) + '%"></span>';
      if (tgt || w >= 6) {
        labels += '<span class="lbl' + (tgt ? " tgt" : "") + '" style="left:' + (left + w / 2).toFixed(3) + '%">' + esc(s.label) + "</span>";
      }
    });
    const mid = pctOf(p.from - 1 + n / 2);
    const where = p.perPage
      ? "page " + G.binderSpot(p.from, p.perPage).page
      : "#" + fmt(p.from) + (n > 1 ? "–" + fmt(p.to) : "");
    return '<div class="locpic box">' +
      '<div class="locpic-cap"><span>Front</span><span>Back</span></div>' +
      '<div class="locpic-bar" role="img" aria-label="' + esc("Side view, front on the left: " + p.section.label + " section is cards " + p.section.from + "–" + p.section.to + ", this card about " + where) + '">' +
        '<span class="fill" style="width:' + pctOf(total).toFixed(3) + '%"></span>' +
        (room > total ? '<span class="room" style="left:' + pctOf(total).toFixed(3) + '%"></span>' : "") +
        segs +
        '<span class="mark" style="left:' + mid.toFixed(3) + '%"><b>' + esc(where) + "</b></span>" +
      "</div>" +
      '<div class="locpic-labels" aria-hidden="true">' + labels + "</div>" +
      '<div class="locpic-scale"><span>1</span><span>' + fmt(total) + " card" + (total === 1 ? "" : "s") +
        (p.cap != null ? " of " + fmt(p.cap) : "") + "</span></div>" +
      '<div class="locpic-key"><span><i class="k fil"></i>filled</span>' + (room > total ? '<span><i class="k vac"></i>room left</span>' : "") +
        '<span><i class="k sec"></i>' + esc(p.section.label) + " section</span><span><i class=\"k mk\"></i>" + (p.mode === "here" ? "where it is" : "where it goes") + "</span></div>" +
      "</div>";
  }
  function showPlacement(p, rec) {
    if (!p) return;
    const el = ensureModal("placeModal", "wide",
      '<div class="eyebrow" id="placeLoc"></div><h3 id="placeTitle"></h3><div id="placeCard" class="muted"></div>' +
      '<div id="placePic"></div><div id="placeText" class="place-text"></div>' +
      '<div class="modal-actions" style="margin-top:14px"><span class="spacer"></span><button class="primary" id="placeClose">Close</button></div>');
    el.querySelector(".modal").setAttribute("aria-labelledby", "placeTitle");
    $("placeLoc").textContent = p.name + (p.type ? " · " + p.type : "");
    $("placeTitle").textContent = p.mode === "here" ? "Where it is" : "Where it goes";
    const n = p.to - p.from + 1;
    $("placeCard").textContent = rec ? (rec.name || "") + " · " + G.recPrinting(rec) + (n > 1 ? " · " + n + " copies" : "") : "";
    $("placePic").innerHTML = placementPicture(p);
    $("placeText").innerHTML = "<div>" + esc(G.placementSectionText(p)) + "</div><div class=\"muted\">" +
      esc(G.placementNeighbourText(p).replace(/^./, c => c.toUpperCase())) + ".</div>";
    $("placeClose").onclick = () => hideModal("placeModal");
    showModal("placeModal", "placeClose");
  }
  // The icon button a Putaway line (or #295's pick line) carries; the page
  // wires its click to showPlacement.
  const placementButton = (attrs, label) =>
    '<button type="button" class="small ghost spot-btn" ' + (attrs || "") + ' title="' + esc(label || "Show where it goes") +
    '" aria-label="' + esc(label || "Show where it goes") + '">' + icon("map-pin") + "</button>";

  function icon(name) {
    return "<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#" + String(name).replace(/[^a-z0-9-]/g, "") + "></use></svg>";
  }

  return {
    icon, vendorCompare, finishBadge,
    glossLink: el => { try { if (window.Glossary) window.Glossary.link(el, { simple: G.simpleMode }); } catch (e) {} },
    mountChrome, boot, go, toast, toastProgress, hideToast, setStatus, skeletonRows, skeletonBlock,
    emptyBlock, emptyRow, planMoreNote, loanLine, wireLoanLines,
    wireCredentialSave, wireCredentialTest, loadPrintingSelect,
    showModal, hideModal, ensureModal, slideOver, pageTabs, onClose, lightbox, topModal, confirmDialog, promptDialog,
    chime, playChing,
    CardPanel, Autocomplete, Grid, openManage, openQuery, readQueryForm, writeQueryForm,
    showHoverPreview, positionHoverPreview, hideHoverPreview, wireHoverPreview, wireArtHover,
    showContextMenu, closeContextMenu, showShortcutHelp,
    artThumbTd, soldTd, soldCountTd, sellingFastFlag, artForGroup, reviewRecord, reviewCard,
    cardLink, cardNameLink, cardLinks, openCardPanel, cardFilterFromUrl, cardFilterMatches, cardFilterLabel, cardFilterChip,
    placementPicture, showPlacement, placementButton,
    locOptions, fillLocationSelect,
    enableSorting, reapplySorts, sortTable, domOrder, dataSort, sortStateOf,
    lineChart, barList,
    WMS_COLUMNS, ERP_COLUMNS, STOREFRONT_COLUMNS, rowGain,
    renderTicketThread, whatsNew,
    $
  };
})();
