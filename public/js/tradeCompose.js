/* Grimoire v0.08 - shared trade-proposal composer.
   ==============================================================
   One "propose a trade" modal, usable from three places: the Buy List's
   "a friend owns this" popup (a specific card already in mind - opens with
   presetRow filled in and both sides auto-suggested, same as v0.08's
   original single-purpose flow), and the Trade Proposals / Social pages'
   "New proposal" button (nothing in mind yet - pick a friend, add lines by
   hand to either side). All three used to mean "duplicate the balancing
   logic in every page that wants it" - it now lives once, here.

   Every line on both sides has the same shape sanitizeTradeLines() on the
   server already expects: {name,set,collector,lang,finish,qty,price,
   oracleId,role}. `why` is a display-only extra the server ignores. */
"use strict";
window.TradeCompose = (function () {
  const $ = UI.$;

  /* ============================== Balancing engine ==============================
     Moved from buy-list.page.js unchanged (2026-09-17) - see that file's git
     history for the reasoning behind the bucket sizes, the "search outward
     from the gap's own bucket" strategy, and the under-or-at-target main-card
     preference. Only the names lost their buy-list-specific framing. */
  function wantedMatchKeys(watchItems) {
    const ids = new Set(), names = new Set();
    for (const w of (watchItems || [])) {
      if (w.oracleId) ids.add(w.oracleId);
      if (w.name) names.add(String(w.name).trim().toLowerCase());
    }
    return { ids, names };
  }
  function isWanted(r, keys) {
    if (r.oracleId && keys.ids.has(r.oracleId)) return true;
    return !!(r.name && keys.names.has(String(r.name).trim().toLowerCase()));
  }
  function priceBuckets() {
    const bounds = [0];
    let b = 0.25;
    while (b < 1000) { bounds.push(b); b *= 2; }
    bounds.push(Infinity);
    return bounds;
  }
  function bucketIndex(price, bounds) {
    for (let i = 0; i < bounds.length - 1; i++) {
      if (price >= bounds[i] && price < bounds[i + 1]) return i;
    }
    return bounds.length - 2;
  }
  function bucketLabel(i, bounds) {
    const lo = bounds[i], hi = bounds[i + 1];
    return G.money(lo) + " – " + (hi === Infinity ? "up" : G.money(hi));
  }
  const rankOf = r => r.edhrecRank == null ? Infinity : r.edhrecRank;

  function fillFromBuckets(pool, gap, ceiling) {
    const bounds = priceBuckets();
    const maxBucket = bounds.length - 2;
    const byBucket = new Map();
    for (const r of pool) {
      const bi = bucketIndex(r.price, bounds);
      if (!byBucket.has(bi)) byBucket.set(bi, []);
      byBucket.get(bi).push(r);
    }
    for (const arr of byBucket.values()) arr.sort((a, b) => rankOf(a) - rankOf(b));

    const picked = [];
    let total = 0;
    let remaining = gap;
    let guard = 0;
    while (remaining > 0.005 && guard++ < 25) {
      const targetBi = Math.max(0, Math.min(maxBucket, bucketIndex(remaining, bounds)));
      let found = null, foundBi = null;
      for (let d = 0; d <= maxBucket && !found; d++) {
        const tryBis = d === 0 ? [targetBi] : [targetBi - d, targetBi + d];
        for (const bi of tryBis) {
          if (bi < 0 || bi > maxBucket) continue;
          const arr = byBucket.get(bi);
          if (!arr || !arr.length) continue;
          if (total + arr[0].price > ceiling) continue;
          found = arr[0]; foundBi = bi;
          break;
        }
      }
      if (!found) break;
      picked.push(Object.assign({ bucket: bucketLabel(foundBi, bounds) }, found));
      total += found.price;
      remaining = gap - total;
      byBucket.get(foundBi).shift();
    }
    return { picked, total };
  }

  function bestMainCard(pool, targetValue) {
    const underOrAt = pool.filter(r => r.price <= targetValue);
    return underOrAt.length
      ? underOrAt.slice().sort((a, b) => b.price - a.price)[0]
      : pool.slice().sort((a, b) => Math.abs(a.price - targetValue) - Math.abs(b.price - targetValue))[0];
  }

  function suggestTradeOffer(targetValue, watchItems, theirPool) {
    const keys = wantedMatchKeys(watchItems);
    const myOwned = myCards().filter(r => G.availableQty(r) > 0 && r.price > 0);
    if (!myOwned.length) {
      return { myMain: null, myFiller: [], theirFiller: [], myTotal: 0, theirTotal: targetValue, keys };
    }
    const wanted = myOwned.filter(r => isWanted(r, keys));
    const myMain = bestMainCard(wanted.length ? wanted : myOwned, targetValue);

    let myTotal = myMain.price;
    let theirTotal = targetValue;
    let myFiller = [], theirFiller = [];
    const diff = theirTotal - myTotal;
    if (diff > 0.005) {
      const rest = myOwned.filter(r => r !== myMain);
      const ceiling = theirTotal * 1.2 - myTotal;
      if (rest.length && ceiling > 0) {
        const f = fillFromBuckets(rest, diff, ceiling);
        myFiller = f.picked; myTotal += f.total;
      }
    } else if (diff < -0.005 && theirPool && theirPool.length) {
      const gap = -diff;
      const ceiling = myTotal * 1.2 - theirTotal;
      if (ceiling > 0) {
        const f = fillFromBuckets(theirPool, gap, ceiling);
        theirFiller = f.picked; theirTotal += f.total;
      }
    }
    return { myMain, myFiller, theirFiller, myTotal, theirTotal, keys };
  }

  /* ============================== Composer state ============================== */
  let ctx = null;
  let built = false;

  /* #128: the "You give" pool is the inventory this account shares and
     trades from, the same one friends are shown. For an account outside
     any organization that is its own collection, already loaded here as
     G.state.cards. For an org account it is its personal cards, or a store
     an Owner/Manager picked on the Social page, which need not be the store
     open in the app, so it comes from the server (/api/trades/my-pool). */
  const inOrg = () => !!(G.me && G.me.orgId);
  const myCards = () => !ctx ? [] : inOrg() ? (ctx.myPool || []) : G.state.cards;
  let myPoolRunId = 0;
  async function loadMyPool() {
    const runId = ++myPoolRunId;
    if (!inOrg()) {
      ctx.myPool = null;
      ctx.myFrom = { kind: "personal", storeId: null };
      ctx.loadingMine = false;
      return;
    }
    const mine = ctx;
    mine.myPool = []; mine.myFrom = null; mine.loadingMine = true;
    let d = null;
    try { d = await G.api("/api/trades/my-pool"); }
    catch (e) { UI.toast("Could not load the cards you trade from: " + e.message, "err"); }
    if (runId !== myPoolRunId || ctx !== mine) return;   // the composer was opened again meanwhile
    mine.myPool = (d && d.data) || [];
    mine.myFrom = (d && d.actFrom) || null;
    // #147: what's needed to say why the pool is empty and to offer a store.
    mine.myInfo = d ? { personalCards: d.personalCards, canChooseStore: !!d.canChooseStore,
      stores: Array.isArray(d.stores) ? d.stores : [], notice: d.notice || null } : null;
    mine.loadingMine = false;
  }
  function myFromLabel() {
    if (!inOrg() || !ctx.myFrom) return "";
    return ctx.myFrom.kind === "store"
      ? "from " + ctx.myFrom.storeName + (ctx.myFrom.orgName ? " (" + ctx.myFrom.orgName + ")" : "")
      : "from your personal cards";
  }
  const storeText = s => s ? s.name + (s.orgName ? " (" + s.orgName + ")" : "") : "";

  /* ============================== Share and trade from (#128, #147) ==============================
     Shared by the composer and the Social page, so switching to a store
     goes through ONE save path with ONE "who will see it" confirmation,
     wherever it is started from. Never switches without that confirmation:
     the store's inventory replaces the personal cards in everything this
     account shares (owner's decision, 2026-10-10: no silent switch). */
  const LEVEL_WORD = { summary: "a summary", full: "the full card list" };

  // Who would see a store if this account switched to it, in words, from
  // an /api/friends answer. A friend with no level of their own is covered
  // by "everyone else".
  function whoWillSee(d) {
    d = d || { friends: [], defaultShare: "off" };
    const lines = (Array.isArray(d.friends) ? d.friends : []).filter(f => f.friend && f.share && LEVEL_WORD[f.sees])
      .map(f => "- " + f.displayName + " (" + f.username + "): " + LEVEL_WORD[f.sees]);
    if (LEVEL_WORD[d.defaultShare]) lines.push("- Everyone else on this server: " + LEVEL_WORD[d.defaultShare]);
    return lines.length ? "Who will see it:\n" + lines.join("\n")
      : "Nobody will see it yet: you aren't sharing with anyone.";
  }

  /* Switches to store `st` ({ id, name }), or back to personal cards with
     st null. A store is confirmed first, listing who will see it;
     `friendsData` is the page's latest /api/friends answer, fetched here
     when the page has none (no list, no switch). Resolves to the new
     /api/sharing/act-from view, or null when cancelled. Throws on a
     refused save. */
  async function switchActFrom(st, friendsData) {
    if (st && st.id) {
      const d = friendsData || await G.api("/api/friends");
      const ok = await UI.confirmDialog(
        st.name + "'s inventory will take the place of your personal cards in everything you share, and trade offers " +
        "you send will go out in " + st.name + "'s name.\n\n" + whoWillSee(d),
        { title: "Share and trade from " + st.name + "?", okLabel: "Use " + st.name });
      if (!ok) return null;
    }
    const view = await G.api("/api/sharing/act-from", { method: "POST", body: { storeId: (st && st.id) || null } });
    await announceActFrom(view);
    return view;
  }
  async function announceActFrom(view) {
    for (const fn of actFromListeners.slice()) {
      try { await fn(view); } catch (e) { /* one listener failing never undoes the save */ }
    }
  }

  /* Review of PR #150: a switch made in the composer must reach the page
     that opened it. Social shows what friends see (picker, hint, offer)
     and would otherwise keep showing the old inventory, and a later
     "back to personal" would compare against that stale state and save
     nothing. A page registers here and reloads its own state from the
     server after every saved switch, wherever it was started. */
  const actFromListeners = [];
  function onActFromChange(fn) { if (typeof fn === "function") actFromListeners.push(fn); }

  /* The stores to offer an Owner/Manager whose personal cards are empty
     while they act from them, or [] (owner's decision, 2026-10-10). `v`:
     { canChooseStore, personalCards, stores } plus the current kind. */
  function emptyPersonalOffer(v, kind) {
    if (!v || !v.canChooseStore || kind !== "personal" || v.personalCards !== 0) return [];
    return Array.isArray(v.stores) ? v.stores : [];
  }
  const OFFER_BUTTONS_MAX = 3;
  /* The offer's markup. Buttons carry data-use-store; the page wires them.
     More stores than fit as buttons: point at the Social picker
     (`pickerHint`) instead. */
  function offerHtml(stores, pickerHint) {
    if (!stores.length) return "";
    const one = stores.length === 1;
    const buttons = stores.length <= OFFER_BUTTONS_MAX
      ? stores.map(st => '<button class="small primary" data-use-store="' + G.esc(st.id) + '">Use ' + G.esc(st.name) + "</button>").join(" ")
      : pickerHint;
    return '<div class="callout warn" style="margin:6px 0"><span class="cico">' + UI.icon("building-2") + '</span>' +
      '<div class="cbody">Your personal cards are empty. Share and trade from ' +
      (one ? "<b>" + G.esc(stores[0].name) + "</b>" : "one of your stores") + "?" +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px">' + buttons + "</div></div></div>";
  }
  // The "why you're back on your personal cards" note, with its dismiss.
  function noticeHtml(text, btnId) {
    if (!text) return "";
    return '<div class="callout" style="margin:6px 0"><span class="cico">' + UI.icon("repeat") + '</span>' +
      '<div class="cbody">' + G.esc(text) +
      '<div style="margin-top:6px"><button class="small" id="' + btnId + '">Got it</button></div></div></div>';
  }
  async function dismissNotice() {
    try { await G.api("/api/sharing/act-from/dismiss", { method: "POST", body: {} }); } catch (e) { return; /* shown again next time */ }
    await announceActFrom(null);   // the host page drops its copy of the note too
  }

  /* #147: why "You give" has nothing to offer, in words, or "" when it
     does (or the reason isn't one of these). Used by the browse list and
     by Suggest filler. */
  function emptyPoolReason() {
    if (!ctx || ctx.loadingMine) return "";
    if (myCards().some(tradeable)) return "";
    if (!inOrg()) return "Your collection has no priced cards to give.";
    if (!ctx.myFrom) return "";
    const info = ctx.myInfo || {};
    if (ctx.myFrom.kind === "store") return "You're trading from " + ctx.myFrom.storeName + ", which has no priced cards to give.";
    if (info.personalCards === 0) {
      return "You're trading from your personal cards, which are empty." +
        (!info.canChooseStore ? " Only your organization's owners and managers can trade from a store." : "");
    }
    return "You're trading from your personal cards, and none of them has a price.";
  }

  // The notice and the empty-personal offer above "You give".
  function myNoteHtml() {
    if (!inOrg() || !ctx.myFrom || !ctx.myInfo) return "";
    return noticeHtml(ctx.myInfo.notice, "tcNoticeOk") +
      offerHtml(emptyPersonalOffer(ctx.myInfo, ctx.myFrom.kind),
        'Pick one under <a href="/social.html#sharing">Share and trade from</a> on Social.');
  }
  function drawMyNote() {
    const box = $("tcMyNote");
    if (!box) return;
    box.innerHTML = myNoteHtml();
    const ok = $("tcNoticeOk");
    if (ok && ctx.myInfo && ctx.myInfo.notice) ok.onclick = () => {
      ctx.myInfo.notice = null;
      drawMyNote();
      return dismissNotice();
    };
    box.querySelectorAll("[data-use-store]").forEach(btn => {
      btn.onclick = () => useStore(btn.dataset.useStore);
    });
  }

  /* The offer's button: the shared save path, then "You give" reloads from
     the store. Lines already on "You give" came from the old pool, so they
     go. */
  async function useStore(storeId) {
    const mine = ctx;
    const st = ((mine.myInfo && mine.myInfo.stores) || []).find(s => s.id === storeId);
    if (!st) return;
    let v;
    try { v = await switchActFrom(st); }
    catch (e) { UI.toast("Could not switch: " + e.message, "err"); return; }
    if (!v || ctx !== mine) return;
    UI.toast(v.current && v.current.kind === "store"
      ? "Sharing and trading from " + storeText({ name: v.current.storeName, orgName: v.current.orgName }) + "."
      : "Still sharing and trading from your personal cards.", v.current && v.current.kind === "store" ? "ok" : "err");
    mine.myLines = [];
    mine.loadingMine = true;
    renderMyBrowse();
    await loadMyPool();
    if (ctx !== mine || !$("tcMyFrom")) return;
    $("tcMyFrom").textContent = myFromLabel();
    drawMyNote();
    refreshSide("my");
  }

  const lineKey = l => [String(l.name || "").toLowerCase(), l.set || "", l.collector || "", l.finish || "nonfoil"].join("|");

  function addLine(list, line) {
    const key = lineKey(line);
    const ex = list.find(l => lineKey(l) === key);
    if (ex) { ex.qty = (Number(ex.qty) || 1) + (Number(line.qty) || 1); }
    else list.push(Object.assign({ qty: 1, role: "main" }, line));
  }
  const total = lines => lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 1), 0);

  function buildModal() {
    if (built) return;
    built = true;
    UI.ensureModal("tcModal", "xxwide",
      '<h3 id="tcTitle">Propose a trade</h3>' +
      '<div id="tcBody"></div>' +
      '<div class="hint" style="margin-top:10px">Sending puts this in their Trade Proposals inbox - it\'s still not ' +
        'an automatic exchange, Grimoire has no way to move cards between two accounts on its own, but they\'ll ' +
        'actually see it instead of you having to tell them yourself. Filler can come from either side: whichever ' +
        'side is short gets padded from its own collection, most-popular-available-at-that-price first.</div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
        '<button id="tcSuggest" class="ghost">' + UI.icon("scale") + ' Suggest filler</button>' +
        '<span class="spacer"></span>' +
        '<button id="tcClose" class="ghost">Close</button>' +
        '<button id="tcSend" class="primary"><svg class=ic aria-hidden=true><use href=/icons/sprite.svg#upload></use></svg> Send trade offer</button>' +
      '</div>');
    $("tcClose").onclick = () => UI.hideModal("tcModal");
    $("tcModal").addEventListener("click", e => { if (e.target.id === "tcModal") UI.hideModal("tcModal"); });
    $("tcSuggest").onclick = suggestFiller;
    $("tcSend").onclick = send;
  }

  function lineRowHtml(l, i, side) {
    return "<tr>" + UI.artThumbTd(l.imageUrl) + '<td class="card-name">' + UI.cardLink(l) + "</td>" +
      '<td class="muted">' + (l.set ? G.esc(G.printingLabel(l.set, l.collector)) : '<span class="muted">—</span>') +
        (l.finish && l.finish !== "nonfoil" ? " · " + G.esc(G.FINISH_NAMES[l.finish] || l.finish) : "") + "</td>" +
      '<td class="num" data-v="' + (l.qty || 1) + '"><input type="number" min="1" class="tcQty" data-side="' + side + '" data-i="' + i +
        '" value="' + (l.qty || 1) + '" style="width:48px"></td>' +
      '<td class="num" data-v="' + (l.price == null ? "" : l.price) + '"><input type="number" min="0" step="0.01" class="tcPrice" data-side="' + side + '" data-i="' + i +
        '" value="' + (l.price == null ? "" : l.price) + '" style="width:70px"></td>' +
      '<td class="num">' + (l.edhrecRank == null ? '<span class="muted">—</span>' : l.edhrecRank.toLocaleString()) + "</td>" +
      "<td class=\"hide-sm\">" + (l.why ? '<span class="muted">' + G.esc(l.why) + "</span>" : "") + "</td>" +
      '<td><button class="small ghost" data-rm="' + side + ":" + i + '" title="Remove" aria-label="Remove">✕</button></td></tr>';
  }

  function friendPickerHtml() {
    const theirStore = ctx.theirStore ? " · sharing " + G.esc(storeText(ctx.theirStore)) : "";
    if (ctx.lockFriend) return '<p class="muted" style="margin:0 0 10px">Trading with <b>' + G.esc(ctx.username) + "</b>" + theirStore + "</p>";
    if (ctx.friends == null) return '<div class="empty">Loading your friends…</div>';
    if (!ctx.friends.length) {
      return UI.emptyBlock({ icon: "people", title: "You have nobody to trade with yet.",
        hint: 'Add a friend from the <a href="/social.html">Social</a> page first. Traded in person with someone? ' +
          'Use <b>Record a trade</b> on <a href="/trades.html">Trade Proposals</a> or <a href="/inventory.html">Card Inventory</a>.' });
    }
    return '<label style="max-width:320px">Friend<select id="tcFriendSelect"><option value="">— choose a friend —</option>' +
      ctx.friends.map(f => '<option value="' + G.esc(f.username) + '"' + (f.username === ctx.username ? " selected" : "") + '>' +
        G.esc(f.displayName) + "</option>").join("") +
      "</select></label>" + (theirStore ? '<p class="muted" style="margin:4px 0 0">' + G.esc(ctx.username) + theirStore + "</p>" : "");
  }

  /* ============================== Browse lists ==============================
     Direct ask, 2026-09-18: search-only meant you had to already know an
     exact name to add anything - "I want to browse through their cards and
     click add to trade." Both sides now default to their whole pool
     (alphabetical, already-added lines excluded so nothing can be double-
     added by accident), with the search box narrowing it rather than being
     the only way in. Capped per render - a full collection can run to
     thousands of stacks - with a "type to narrow" hint past the cap. */
  const BROWSE_LIMIT = 150;

  const tradeable = r => G.availableQty(r) > 0 && r.price > 0;   // a lent copy isn't there to offer
  function poolMine() {
    const used = new Set(ctx.myLines.map(lineKey));
    return myCards().filter(r => tradeable(r) && !used.has(lineKey(r)));
  }
  function poolTheirs() {
    const used = new Set(ctx.theirLines.map(lineKey));
    return ctx.theirCollection.filter(r => !used.has(lineKey(r)));
  }
  /* Sorts the WHOLE filtered pool before the BROWSE_LIMIT cap below picks
     which rows actually get shown - direct ask, 2026-09-18: clicking a
     header used to just reorder whichever 150 rows the (always
     alphabetical-by-name) pre-cap slice happened to land on, so sorting by
     price never surfaced the pool's actual cheapest/priciest cards once a
     collection ran past the cap. This is why the browse tables can't use
     the generic click-to-sort every other table[data-sort] gets (ui.js) -
     that only ever reorders rows already in the DOM, which is exactly the
     wrong side of the cap for a pool this size.

     #130: a collection runs to ~70k stacks, and sorting that with
     localeCompare(..., options) built a collator per comparison (~4 s per
     sort, paid on every keystroke and every + Add). G.sortRows uses one
     shared Intl.Collator over keys computed once per row (~0.3 s at 70k),
     and the sorted pool is cached per side: it is re-sorted only when the
     source list or the sort changes. Filtering a sorted list keeps its
     order, so the filter text only re-filters the cached pool (~10 ms), and
     lines already added are skipped while drawing instead of being taken
     out up front, so + Add and the remove button never re-sort either. A
     blank rank sinks to the bottom either way, the same as every other
     sortable column. */
  const SORT_KEYS = {
    name: r => String(r.name || ""),
    printing: r => G.printingLabel(r.set, r.collector),
    price: r => Number(r.price) || 0,
    rank: r => r.edhrecRank == null ? null : Number(r.edhrecRank)
  };
  function sortedPool(side, q) {
    const src = side === "my" ? myCards() : ctx.theirCollection;
    const sort = side === "my" ? ctx.mySort : ctx.theirSort;
    let c = ctx.browseCache[side];
    if (!c || c.src !== src || c.srcLen !== src.length || c.key !== sort.key || c.dir !== sort.dir) {
      const rows = G.sortRows(side === "my" ? src.filter(tradeable) : src, SORT_KEYS[sort.key] || SORT_KEYS.name, sort.dir || 1);
      c = ctx.browseCache[side] = {
        src, srcLen: src.length, key: sort.key, dir: sort.dir, rows,
        keys: rows.map(lineKey), names: rows.map(r => String(r.name || "").toLowerCase()),
        q: "", hits: null              // hits: row indexes matching q, in sorted order (null = every row)
      };
    }
    if (c.q !== q) {
      const ql = q.toLowerCase();
      c.q = q;
      c.hits = null;
      if (ql) {
        c.hits = [];
        for (let i = 0; i < c.names.length; i++) if (c.names[i].includes(ql)) c.hits.push(i);
      }
    }
    return c;
  }

  function browseRowHtml(r, i, side) {
    return "<tr>" + UI.artThumbTd(r.imageUrl) + '<td class="card-name">' + UI.cardLink(r) + "</td>" +
      '<td class="muted">' + G.esc(G.printingLabel(r.set, r.collector)) +
        (r.finish && r.finish !== "nonfoil" ? " · " + G.esc(G.FINISH_NAMES[r.finish] || r.finish) : "") + "</td>" +
      '<td class="num">' + G.money(r.price) + "</td>" +
      '<td class="num">' + (r.edhrecRank == null ? '<span class="muted">—</span>' : r.edhrecRank.toLocaleString()) + "</td>" +
      '<td><button class="small" data-add="' + side + ":" + i + '">+ Add</button></td></tr>';
  }

  function wireBrowseHeaders(side, tableEl, sort) {
    if (!tableEl) return;
    tableEl.querySelectorAll("thead th[data-sk]").forEach(th => {
      th.classList.add("sortable");
      const old = th.querySelector(".arrow"); if (old) old.remove();
      const active = sort && sort.key === th.dataset.sk;
      th.classList.toggle("sorted", !!active);
      if (active) {
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = sort.dir === 1 ? " ▲" : " ▼";
        th.appendChild(arrow);
      }
      th.onclick = () => {
        const cur = side === "my" ? ctx.mySort : ctx.theirSort;
        if (cur.key === th.dataset.sk) cur.dir = -cur.dir; else { cur.key = th.dataset.sk; cur.dir = 1; }
        if (side === "my") renderMyBrowse(); else renderTheirBrowse();
      };
    });
  }

  function renderBrowse(side, searchId, bodyId, moreId) {
    const q = $(searchId) ? $(searchId).value.trim() : "";
    const sort = side === "my" ? ctx.mySort : ctx.theirSort;
    const pool = sortedPool(side, q);
    const used = new Set((side === "my" ? ctx.myLines : ctx.theirLines).map(lineKey));
    const shown = [];
    let matches = 0;
    const count = pool.hits ? pool.hits.length : pool.rows.length;
    for (let j = 0; j < count; j++) {
      const i = pool.hits ? pool.hits[j] : j;
      if (used.size && used.has(pool.keys[i])) continue;
      matches++;
      if (shown.length < BROWSE_LIMIT) shown.push(pool.rows[i]);
    }
    ctx[side === "my" ? "myBrowseRows" : "theirBrowseRows"] = shown;
    const emptyTitle = q ? "No matches."
      : side === "my" && ctx.loadingMine ? "Loading your cards…"
      : side === "my" && !pool.rows.length && emptyPoolReason() ? emptyPoolReason()
      : "Nothing left to add.";
    $(bodyId).innerHTML = shown.length ? shown.map((r, i) => browseRowHtml(r, i, side)).join("")
      : UI.emptyRow(6, { title: emptyTitle });
    $(moreId).textContent = matches > BROWSE_LIMIT
      ? "Showing top " + BROWSE_LIMIT + " of " + matches.toLocaleString() + " — type to narrow." : "";
    [...$(bodyId).rows].forEach((tr, i) => {
      const r = shown[i];
      if (r) UI.wireArtHover(tr, r.imageUrl);
    });
    $(bodyId).querySelectorAll("[data-add]").forEach(btn => {
      btn.onclick = () => {
        const [s, i] = btn.dataset.add.split(":");
        const rows = ctx[s === "my" ? "myBrowseRows" : "theirBrowseRows"];
        const r = rows[Number(i)]; if (!r) return;
        addLine(s === "my" ? ctx.myLines : ctx.theirLines, Object.assign({ role: "main" }, r));
        refreshSide(s);
      };
    });
    wireBrowseHeaders(side, $(bodyId).closest("table"), sort);
  }
  function renderMyBrowse() { renderBrowse("my", "tcMySearch", "tcMyBrowseBody", "tcMyBrowseMore"); }
  function renderTheirBrowse() { renderBrowse("their", "tcTheirSearch", "tcTheirBrowseBody", "tcTheirBrowseMore"); }
  // The filter boxes wait for a pause in typing before redrawing.
  const renderMyBrowseSoon = G.debounce(() => { if (ctx && $("tcMySearch")) renderMyBrowse(); }, 150);
  const renderTheirBrowseSoon = G.debounce(() => { if (ctx && $("tcTheirSearch")) renderTheirBrowse(); }, 150);

  function theirAddAreaHtml() {
    if (!ctx.username) return UI.emptyBlock({ icon: "people", title: "Choose a friend first." });
    if (ctx.loadingFriend) return '<div class="empty">Loading ' + G.esc(ctx.username) + "'s collection…</div>";
    if (!ctx.theirCollection.length) {
      return '<div class="hint" style="margin:0 0 8px">' + G.esc(ctx.username) +
        " isn't sharing their full collection with you, so you'll have to type in what you're asking for.</div>" +
        '<div class="form-row" style="margin-top:6px">' +
          '<label style="flex:2;min-width:140px">Card name<input id="tcTheirName" placeholder="Card name" autocomplete="off"></label>' +
          '<label style="width:70px">Qty<input id="tcTheirQty" type="number" min="1" value="1"></label>' +
          '<label style="width:90px">Price<input id="tcTheirPrice" type="number" min="0" step="0.01" placeholder="0.00"></label>' +
          '<button id="tcTheirAdd" class="small" style="align-self:end">+ Add</button>' +
        "</div>";
    }
    return '<input id="tcTheirSearch" placeholder="Filter ' + G.esc(ctx.username) + '\'s cards…" autocomplete="off">' +
      '<div class="list-wrap" style="max-height:200px;overflow:auto;margin-top:6px">' +
        '<table class="list"><thead><tr><th></th><th data-sk="name">Card</th><th data-sk="printing">Printing</th>' +
          '<th class="num" data-sk="price">Price</th><th class="num" data-sk="rank" title="EDHRec rank - lower is more popular">Rank</th><th></th></tr></thead>' +
        '<tbody id="tcTheirBrowseBody"></tbody></table></div>' +
      '<div class="hint" id="tcTheirBrowseMore" style="margin:4px 0 0"></div>';
  }

  function renderMyLines() {
    $("tcMyLinesBody").innerHTML = ctx.myLines.length
      ? ctx.myLines.map((l, i) => lineRowHtml(l, i, "my")).join("")
      : UI.emptyRow(8, { title: "Nothing added yet." });
    wireLineRows("tcMyLinesBody", "my");
  }
  function renderTheirLines() {
    $("tcTheirLinesBody").innerHTML = ctx.theirLines.length
      ? ctx.theirLines.map((l, i) => lineRowHtml(l, i, "their")).join("")
      : UI.emptyRow(8, { title: "Nothing added yet." });
    wireLineRows("tcTheirLinesBody", "their");
  }
  function wireLineRows(bodyId, side) {
    const body = $(bodyId);
    const list = side === "my" ? ctx.myLines : ctx.theirLines;
    [...body.rows].forEach((tr, i) => {
      const l = list[i];
      if (l) UI.wireArtHover(tr, l.imageUrl);
    });
    body.querySelectorAll(".tcQty, .tcPrice").forEach(inp => {
      inp.oninput = () => {
        const i = Number(inp.dataset.i);
        const list = side === "my" ? ctx.myLines : ctx.theirLines;
        const l = list[i]; if (!l) return;
        let v;
        if (inp.classList.contains("tcQty")) v = l.qty = Math.max(1, parseInt(inp.value, 10) || 1);
        else v = l.price = Math.max(0, parseFloat(inp.value) || 0);
        inp.closest("td").dataset.v = v;
        updateTotals();
      };
    });
    body.querySelectorAll("[data-rm]").forEach(btn => {
      btn.onclick = () => {
        const [s, i] = btn.dataset.rm.split(":");
        (s === "my" ? ctx.myLines : ctx.theirLines).splice(Number(i), 1);
        refreshSide(s);
      };
    });
    UI.reapplySorts();
  }

  function updateTotals() {
    const myTotal = total(ctx.myLines), theirTotal = total(ctx.theirLines);
    $("tcMyTotal").textContent = G.money(myTotal);
    $("tcMyTotal").className = "big " + (myTotal >= theirTotal ? "val" : "neg");
    $("tcTheirTotal").textContent = G.money(theirTotal);
  }

  /* Re-draws one side's browse list + added-lines table (a card just added
     or removed there affects both: added/removed from the pool the browse
     list draws from, and from the added-lines table itself) plus totals -
     without touching the other side or the friend picker, so the other
     side's search box keeps its text and focus. */
  function refreshSide(side) {
    if (side === "my") { renderMyBrowse(); renderMyLines(); }
    else { renderTheirBrowse(); renderTheirLines(); }
    updateTotals();
  }

  function render() {
    $("tcBody").innerHTML =
      '<div id="tcFriendArea">' + friendPickerHtml() + "</div>" +
      '<div class="summary" style="margin:10px 0">' +
        '<div class="stat"><span class="big" id="tcMyTotal"></span><span class="lbl">You give</span></div>' +
        '<div class="stat"><span class="big" id="tcTheirTotal"></span><span class="lbl">You get</span></div>' +
      "</div>" +
      '<div class="grid2">' +
        "<div><h4 style=\"margin:0 0 6px\">You give" +
          ' <span class="muted" id="tcMyFrom" style="font-weight:normal">' + G.esc(myFromLabel()) + "</span>" +
          "</h4>" +
          '<div id="tcMyNote"></div>' +
          '<input id="tcMySearch" placeholder="Filter your cards…" autocomplete="off">' +
          '<div class="list-wrap" style="max-height:200px;overflow:auto;margin-top:6px">' +
            '<table class="list"><thead><tr><th></th><th data-sk="name">Card</th><th data-sk="printing">Printing</th>' +
              '<th class="num" data-sk="price">Price</th><th class="num" data-sk="rank" title="EDHRec rank - lower is more popular">Rank</th><th></th></tr></thead>' +
            '<tbody id="tcMyBrowseBody"></tbody></table></div>' +
          '<div class="hint" id="tcMyBrowseMore" style="margin:4px 0 0"></div>' +
          '<h5 style="margin:12px 0 4px">Added</h5>' +
          '<div class="list-wrap" style="max-height:200px">' +
            '<table class="list" data-sort><thead><tr><th></th><th>Card</th><th>Printing</th><th class="num">Qty</th>' +
              '<th class="num">Price</th><th class="num" title="EDHRec rank - lower is more popular">Rank</th>' +
              '<th class="hide-sm">Why</th><th></th></tr></thead><tbody id="tcMyLinesBody"></tbody></table>' +
          "</div>" +
        "</div>" +
        '<div><h4 style="margin:0 0 6px">You get</h4><div id="tcTheirAddArea"></div>' +
          '<h5 style="margin:12px 0 4px">Added</h5>' +
          '<div class="list-wrap" style="max-height:200px">' +
            '<table class="list" data-sort><thead><tr><th></th><th>Card</th><th>Printing</th><th class="num">Qty</th>' +
              '<th class="num">Price</th><th class="num" title="EDHRec rank - lower is more popular">Rank</th>' +
              '<th class="hide-sm">Why</th><th></th></tr></thead><tbody id="tcTheirLinesBody"></tbody></table>' +
          "</div>" +
        "</div>" +
      "</div>";

    drawMyNote();
    const fsel = $("tcFriendSelect");
    if (fsel) fsel.onchange = () => selectFriend(fsel.value);
    $("tcMySearch").addEventListener("input", renderMyBrowseSoon);
    renderMyBrowse();
    renderMyLines();

    $("tcTheirAddArea").innerHTML = theirAddAreaHtml();
    const theirSearch = $("tcTheirSearch");
    if (theirSearch) { theirSearch.addEventListener("input", renderTheirBrowseSoon); renderTheirBrowse(); }
    const theirAdd = $("tcTheirAdd");
    if (theirAdd) theirAdd.onclick = () => {
      const name = $("tcTheirName").value.trim();
      if (!name) { UI.toast("Enter a card name.", "err"); return; }
      const qty = Math.max(1, parseInt($("tcTheirQty").value, 10) || 1);
      const price = Math.max(0, parseFloat($("tcTheirPrice").value) || 0);
      addLine(ctx.theirLines, { name, qty, price, role: "main" });
      renderTheirLines();
      updateTotals();
      $("tcTheirName").value = ""; $("tcTheirQty").value = "1"; $("tcTheirPrice").value = "";
    };
    renderTheirLines();
    updateTotals();
  }

  /* #131: every friend load (picker change, or the composer being opened
     again) takes a new run id, and a response is dropped unless its run is
     still the latest. Without it, picking alice (slow) then bob (fast) let
     alice's collection land last and sit under bob's name, so + Add and
     Suggest filler asked bob for alice's cards. Same pattern as
     collectorRunId in stats.page.js. */
  let friendRunId = 0;

  async function selectFriend(username) {
    const runId = ++friendRunId;
    // Changing to a DIFFERENT friend after already adding "you get" lines
    // would otherwise leave those lines pointing at the previous friend's
    // collection - drop them rather than propose the wrong person's cards.
    if (username !== ctx.username && ctx.theirLines.length) ctx.theirLines = [];
    ctx.username = username;
    ctx.theirCollection = []; ctx.theirWatch = []; ctx.theirStore = null;
    if (!username) { ctx.loadingFriend = false; render(); return; }
    ctx.loadingFriend = true;
    render();
    let watch = [], collection = [], theirStore = null;
    try {
      const [wd, cd] = await Promise.all([
        G.api("/api/friends/watchlist", { method: "POST", body: { username } }),
        G.api("/api/friends/collection", { method: "POST", body: { username } })
      ]);
      watch = wd.data || [];
      collection = cd.data || [];
      theirStore = cd.store || null;
    } catch (e) { /* fine - the manual add form still works for their side */ }
    if (runId !== friendRunId) return;   // a newer friend (or a reopened composer) took over
    ctx.theirWatch = watch;
    ctx.theirCollection = collection;
    ctx.theirStore = theirStore;
    ctx.loadingFriend = false;
    render();
  }

  async function loadFriendsList() {
    const mine = ctx;
    mine.friends = null;
    render();
    let friends = [];
    try {
      const d = await G.api("/api/friends");
      const map = new Map();
      (d.friends || []).forEach(f => { if (f.exists) map.set(f.username, f.displayName || f.username); });
      (d.sharedWithMe || []).forEach(f => map.set(f.username, f.displayName || f.username));
      friends = [...map.entries()].map(([username, displayName]) => ({ username, displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    } catch (e) { /* an empty picker says "nobody to trade with" */ }
    if (ctx !== mine) return;            // the composer was closed and opened again meanwhile
    mine.friends = friends;
    render();
  }

  function suggestFiller() {
    if (!ctx.username) { UI.toast("Choose a friend first.", "err"); return; }
    const myTotal = total(ctx.myLines), theirTotal = total(ctx.theirLines);
    const diff = theirTotal - myTotal;
    if (Math.abs(diff) < 0.005) { UI.toast("Already balanced.", "ok"); return; }
    if (diff > 0) {
      const pool = poolMine();
      const ceiling = theirTotal * 1.2 - myTotal;
      const f = pool.length && ceiling > 0 ? fillFromBuckets(pool, diff, ceiling) : { picked: [] };
      if (!f.picked.length) {
        // #147: an empty pool says why, instead of blaming the gap.
        const why = emptyPoolReason();
        const offer = why && ctx.myInfo && emptyPersonalOffer(ctx.myInfo, ctx.myFrom && ctx.myFrom.kind).length
          ? " You can switch to a store above." : "";
        UI.toast(why ? why + offer : "Nothing " + (inOrg() && ctx.myFrom
          ? (ctx.myFrom.kind === "store" ? "in " + ctx.myFrom.storeName : "in your personal cards")
          : "in your collection") + " closes that gap.", "err");
        return;
      }
      f.picked.forEach(r => addLine(ctx.myLines, Object.assign({ role: "filler", why: "filler · " + r.bucket }, r)));
      refreshSide("my");
    } else {
      const pool = poolTheirs();
      const ceiling = myTotal * 1.2 - theirTotal;
      const f = pool.length && ceiling > 0 ? fillFromBuckets(pool, -diff, ceiling) : { picked: [] };
      if (!f.picked.length) {
        UI.toast(ctx.theirCollection.length ? "Nothing in their collection closes that gap." :
          ctx.username + " isn't sharing their full collection with you - add their side by hand.", "err");
        return;
      }
      f.picked.forEach(r => addLine(ctx.theirLines, Object.assign({ role: "filler", why: "filler · " + r.bucket }, r)));
      refreshSide("their");
    }
  }

  /* #129: a "you give" line is built from a whole inventory stack (oracle
     text, cost basis, location, vendor prices...), ~1.2 KB of JSON each, and
     POST /api/trades/propose keeps only these fields
     anyway (server/lib/trades.js sanitizeLine). Only these leave the
     browser: an offer no longer fails at about a dozen cards, and cost and
     location never go over the wire. */
  const TRADE_LINE_FIELDS = ["name", "set", "collector", "lang", "finish", "qty", "price", "oracleId", "role", "imageUrl"];
  function tradeLine(l) {
    const out = {};
    for (const k of TRADE_LINE_FIELDS) if (l[k] !== undefined) out[k] = l[k];
    return out;
  }
  // The server's request-body limit for a proposal: trades.PROPOSE_BODY_LIMIT
  // in server/lib/trades.js (64 KB since #137, room for 50 lines a side).
  const PROPOSE_BODY_LIMIT = 65536;

  async function send() {
    if (!ctx.username) { UI.toast("Choose a friend first.", "err"); return; }
    if (ctx.loadingMine) { UI.toast("Still loading the cards you trade from.", "err"); return; }
    if (!ctx.myLines.length || !ctx.theirLines.length) { UI.toast("Add at least one card to each side.", "err"); return; }
    const body = { toUsername: ctx.username, fromStoreId: (ctx.myFrom && ctx.myFrom.storeId) || null, offering: ctx.myLines.map(tradeLine), requesting: ctx.theirLines.map(tradeLine) };
    // Byte length, not string length: a name with accents or non-Latin text
    // takes more than one byte per character.
    if (new TextEncoder().encode(JSON.stringify(body)).length > PROPOSE_BODY_LIMIT) {
      UI.toast("This offer has too many cards to send in one go (" + (ctx.myLines.length + ctx.theirLines.length) +
        " lines). Take some lines off, or split it into two offers.", "err");
      return;
    }
    $("tcSend").disabled = true;
    try {
      await G.api("/api/trades/propose", { method: "POST", body });
      UI.toast("Trade offer sent to " + ctx.username + ".", "ok");
      UI.hideModal("tcModal");
      if (ctx.onSent) ctx.onSent();
    } catch (e) {
      UI.toast("Could not send the offer: " + e.message, "err");
    } finally {
      $("tcSend").disabled = false;
    }
  }

  /* Opened from the Buy List's "a friend owns this" flow: a specific card
     already picked out (presetRow, the search-result row it's wanted at)
     and a specific friend (username) already chosen. Both sides start
     pre-filled with the same auto-suggested balance v0.08 always showed
     here - the new part is that every line is now editable/removable
     instead of being a fixed take-it-or-leave-it suggestion. */
  async function openForRow(row, username, onSent) {
    open({ username, lockFriend: true, onSent, presetRow: true, title: "Offer trade with " + username + " for " + row.name });
    const runId = ++friendRunId;
    ctx.loadingFriend = true;
    render();
    let watch = [], theirCollection = [], theirStore = null;
    try {
      const [wd, cd] = await Promise.all([
        G.api("/api/friends/watchlist", { method: "POST", body: { username } }),
        G.api("/api/friends/collection", { method: "POST", body: { username } })
      ]);
      watch = wd.data || [];
      theirCollection = (cd.data || []).filter(c => String(c.name || "").trim().toLowerCase() !== String(row.name || "").trim().toLowerCase());
      theirStore = cd.store || null;
    } catch (e) { /* suggest from my side alone */ }
    await ctx.myPoolReady;               // the suggestion picks from my trading pool, so wait for it
    if (runId !== friendRunId) return;   // the composer was opened again for someone else
    ctx.theirWatch = watch;
    ctx.theirCollection = theirCollection;
    ctx.theirStore = theirStore;
    ctx.loadingFriend = false;
    const target = row.low != null ? row.low : 0;
    const { myMain, myFiller, theirFiller } = suggestTradeOffer(target, watch, theirCollection);
    if (myMain) {
      const keys = wantedMatchKeys(watch);
      addLine(ctx.myLines, Object.assign({ role: "main",
        why: "main · " + (isWanted(myMain, keys) ? "on their list" : "closest value match") }, myMain));
      myFiller.forEach(r => addLine(ctx.myLines, Object.assign({ role: "filler", why: "filler · " + r.bucket }, r)));
    }
    addLine(ctx.theirLines, {
      role: "main", why: "main · what you asked for",
      name: row.name, set: row.set, collector: row.collector, lang: row.lang,
      finish: row.foilOnly ? "foil" : "nonfoil", qty: 1, price: target, oracleId: row.oracleId,
      imageUrl: row.imageUrl || ""
    });
    theirFiller.forEach(r => addLine(ctx.theirLines, Object.assign({ role: "filler", why: "their filler · " + r.bucket }, r)));
    render();
  }

  /* Opened from Trade Proposals / Social's "New proposal" button, or from a
     specific friend row there: nothing pre-suggested, everything added by
     hand. `username` preselects and locks the friend when the entry point
     already knows who (a Social friend row); leave it blank to show the
     picker (a bare "New proposal" button with no context). */
  function open(opts) {
    opts = opts || {};
    friendRunId++;                       // a load still in flight from the last time it was open is dropped
    ctx = {
      username: opts.username || "", lockFriend: !!opts.lockFriend && !!opts.username,
      onSent: opts.onSent || null,
      myLines: [], theirLines: [],
      theirCollection: [], theirWatch: [], theirStore: null, loadingFriend: false,
      myPool: null, myFrom: null, myInfo: null, loadingMine: inOrg(),
      myBrowseRows: [], theirBrowseRows: [], browseCache: { my: null, their: null },
      mySort: { key: "name", dir: 1 }, theirSort: { key: "name", dir: 1 },
      friends: opts.username ? [] : null
    };
    buildModal();
    $("tcTitle").textContent = opts.title || (ctx.username ? "Offer trade with " + ctx.username : "Propose a trade");
    render();
    UI.showModal("tcModal", "tcClose");
    // Only the "You give" side and its label redraw when the pool lands, so
    // a search already typed on the other side keeps its text.
    const mine = ctx;
    mine.myPoolReady = loadMyPool().then(() => {
      if (ctx !== mine || !$("tcMyFrom")) return;
      $("tcMyFrom").textContent = myFromLabel();
      drawMyNote();
      renderMyBrowse();
    });
    if (!opts.presetRow) {
      if (ctx.username) selectFriend(ctx.username);
      else loadFriendsList();
    }
  }

  // #147: Social's picker and its empty-personal offer use the same switch.
  return { open, openForRow, switchActFrom, onActFromChange, emptyPersonalOffer, offerHtml, noticeHtml, dismissNotice };
})();
