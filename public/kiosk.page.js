"use strict";
(function () {
  /* The store's kiosk (#433, part 3 of #402 Order Entry). A customer finds
     cards, builds an order and sends it with their name and an email or
     phone. Everything comes from the four kiosk routes (server/lib/kiosk.js):
     the search only ever sees cards free to sell at market price, and the
     server decides stock and prices again when the order is sent. Staff
     leave kiosk mode with the PIN; nothing else of Grimoire is reachable. */
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = n => '<svg class=ic aria-hidden=true><use href=/icons/sprite.svg#' + n + "></use></svg>";
  const money = n => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const COND = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };
  const FINISH = { foil: "Foil", etched: "Etched" };
  const IDLE_MS = 2 * 60 * 1000;   // an unfinished order is cleared for the next customer
  const DONE_MS = 30 * 1000;       // the thank-you screen goes back to a fresh order

  let order = [];                  // { key, name, set, collector, condition, finish, lang, price, free, qty }
  let rows = [];                   // the last search's cards
  let searchSeq = 0, lastTouch = Date.now(), doneTimer = 0, sending = false;
  let maxCards = null;             // the account's most cards per order (Kiosk page), null = no limit
  const cardCount = () => order.reduce((s, l) => s + l.qty, 0);
  const atLimit = () => maxCards != null && cardCount() >= maxCards;

  /* ---------- Talking to the server ---------- */
  async function api(url, opts) {
    const o = opts || {};
    const res = await fetch(url, {
      method: o.method || "GET", credentials: "same-origin",
      headers: o.body ? { "Content-Type": "application/json" } : {},
      body: o.body ? JSON.stringify(o.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    // 401: this device isn't a kiosk any more (ended from the Kiosk page, or its manager lost the role).
    if (res.status === 401) { showEnded(); throw Object.assign(new Error(data.error || "Not in kiosk mode."), { status: 401 }); }
    if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please ask at the counter."), { status: res.status, data });
    return data;
  }

  function showEnded() {
    $("kShop").hidden = true;
    $("kDone").hidden = true;
    $("kEnded").hidden = false;
    $("kStaff").hidden = true;
    $("kPinDlg").hidden = true;
  }

  /* ---------- Finding cards ---------- */
  const inOrder = key => { const l = order.find(x => x.key === key); return l ? l.qty : 0; };
  const cardMeta = r => [String(r.set || "").toUpperCase() + (r.collector ? " #" + r.collector : ""), COND[r.condition] || r.condition,
    FINISH[r.finish], r.lang && r.lang !== "en" ? String(r.lang).toUpperCase() : ""].filter(Boolean).join(" · ");

  /* Browsing (#438): before anything is typed the grid is everything in
     stock, a page at a time, narrowed by set, color, card type, rarity and
     price with no typing; the filters combine with the search box. Above it,
     while nothing is narrowed, the store's SELLING FAST cards (a yes from
     the server, never a count). */
  const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", M: "Multicolor", C: "Colorless" };
  const RARITY_NAMES = { common: "Common", uncommon: "Uncommon", rare: "Rare", mythic: "Mythic", special: "Special", bonus: "Bonus" };
  const PRICES = [["", "Any price"], ["0-1", "Under $1"], ["1-5", "$1 to $5"], ["5-20", "$5 to $20"], ["20-50", "$20 to $50"], ["50-", "$50 and up"]];
  let filters = { set: "", type: "", rarity: "", price: "", colors: [] };
  let popular = [], more = false, page = 0, loaded = false;
  const filtered = () => !!(filters.set || filters.type || filters.rarity || filters.price || filters.colors.length);
  const byKey = key => rows.find(r => r.key === key) || popular.find(r => r.key === key);

  function fillFilters(f) {
    const opts = (id, first, list) => {
      $(id).innerHTML = '<option value="">' + esc(first) + "</option>" + list.map(([v, t]) => '<option value="' + esc(v) + '">' + esc(t) + "</option>").join("");
    };
    opts("kfSet", "All sets", (f.sets || []).map(([code, name]) => [code, name]));
    opts("kfType", "All card types", (f.types || []).map(t => [t, t]));
    opts("kfRarity", "All rarities", (f.rarities || []).map(r => [r, RARITY_NAMES[r] || r]));
    opts("kfPrice", "Any price", PRICES.slice(1));
    $("kfColors").innerHTML = (f.colors || []).map(c => '<button type="button" data-color="' + esc(c) + '" aria-pressed="false">' + esc(COLOR_NAMES[c] || c) + "</button>").join("");
    $("kFilters").hidden = false;
    showFilters();
  }
  // The controls as the filters stand (after a clear, or a choice that's no longer in stock).
  function showFilters() {
    $("kfSet").value = filters.set;
    $("kfType").value = filters.type;
    $("kfRarity").value = filters.rarity;
    $("kfPrice").value = filters.price;
    for (const b of $("kfColors").querySelectorAll("[data-color]")) {
      const on = filters.colors.includes(b.dataset.color);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.innerHTML = (on ? icon("check") + " " : "") + esc(COLOR_NAMES[b.dataset.color] || b.dataset.color);
    }
    $("kfClear").hidden = !filtered();
  }

  const tile = (r, strip) => {
    const left = r.free - inOrder(r.key);
    const can = left > 0 && !atLimit();
    return '<li class="kiosk-tile">' +
      '<button type="button" class="kt-pic" data-zoom="' + esc(r.key) + '" title="See this card bigger" aria-label="See ' + esc(r.name) + ' bigger">' +
        (r.imageUrl ? '<img src="' + esc(r.imageUrl) + '" alt="" loading="lazy">' : '<span class="kt-noimg">' + esc(r.name) + "</span>") + "</button>" +
      (r.popular && !strip ? '<span class="kt-tag">' + icon("trending-up") + " Popular</span>" : "") +
      '<div class="kt-name">' + esc(r.name) + '</div><div class="kt-meta">' + esc(cardMeta(r)) + "</div>" +
      '<div class="kt-foot"><span class="kt-price">' + money(r.price) + '</span><span class="kt-meta">' + (left > 0 ? left + " left" : "All in your order") + "</span></div>" +
      addBtn(r, can) + "</li>";
  };
  const addBtn = (r, can) => '<button class="primary" data-add="' + esc(r.key) + '"' + (can ? "" : " disabled") + ">" + icon("plus") + " Add</button>";

  /* ---------- A card, bigger (#459) ----------
     Tap a tile's picture: the card fills the screen with its details and the
     same Add button. Where the device really hovers (a mouse), a bigger
     picture also floats by the pointer, like the desk's art hover. The kiosk
     loads no ui.js (#433), so both are built here. */
  // Scryfall's bigger picture of the same printing; anything else stays as it is.
  const largeUrl = u => /^https:\/\/cards\.scryfall\.io\/normal\//.test(u || "") ? u.replace("/normal/", "/large/") : u;
  const bigImg = u => '<img src="' + esc(largeUrl(u)) + '" data-fallback="' + esc(u) + '" alt="">';
  // A large picture that fails falls back to the tile's own (error doesn't bubble, so catch it on the way down).
  document.addEventListener("error", e => {
    const im = e.target;
    if (im && im.tagName === "IMG" && im.dataset.fallback && im.getAttribute("src") !== im.dataset.fallback) im.src = im.dataset.fallback;
  }, true);
  let zoomKey = null;
  function renderZoom() {
    const r = zoomKey && byKey(zoomKey);
    if (!r) { closeZoom(); return; }
    const left = r.free - inOrder(r.key);
    $("kZoomTitle").textContent = r.name;
    $("kZoomBody").innerHTML =
      (r.imageUrl ? '<div class="kz-pic">' + bigImg(r.imageUrl) + "</div>" : "") +
      '<div class="kz-info"><div class="kt-meta">' + esc(cardMeta(r)) + "</div>" +
        '<div class="kz-price">' + money(r.price) + "</div>" +
        '<div class="kt-meta">' + (left > 0 ? left + " left" : "All in your order") + "</div>" +
        addBtn(r, left > 0 && !atLimit()) + "</div>";
  }
  function openZoom(key) {
    zoomKey = key;
    hideHover();
    renderZoom();
    if (!zoomKey) return;
    $("kZoom").hidden = false;
    $("kZoomClose").focus();
  }
  function closeZoom() { zoomKey = null; $("kZoom").hidden = true; $("kZoomBody").innerHTML = ""; }

  const canHover = window.matchMedia ? window.matchMedia("(hover: hover)") : { matches: false };
  let hoverEl = null;
  function hideHover() { if (hoverEl) hoverEl.hidden = true; }
  function placeHover(e) {
    const w = hoverEl.offsetWidth || 300, h = hoverEl.offsetHeight || 418, pad = 16;
    let x = e.clientX + 24;
    if (x + w + pad > window.innerWidth) x = e.clientX - w - 24;   // no room on the right: show it on the left
    const y = Math.max(pad, Math.min(e.clientY - h / 2, window.innerHeight - h - pad));
    hoverEl.style.left = Math.max(pad, x) + "px";
    hoverEl.style.top = y + "px";
  }
  function wireHover(box) {
    box.addEventListener("pointerover", e => {
      const im = e.target.closest(".kt-pic img");
      if (!im || e.pointerType !== "mouse" || !canHover.matches || !$("kZoom").hidden) return;
      if (!hoverEl) { hoverEl = document.createElement("img"); hoverEl.className = "kiosk-hover"; hoverEl.alt = ""; document.body.appendChild(hoverEl); }
      hoverEl.dataset.fallback = im.getAttribute("src");
      hoverEl.src = largeUrl(im.getAttribute("src"));
      hoverEl.hidden = false;
      placeHover(e);
    });
    box.addEventListener("pointermove", e => { if (hoverEl && !hoverEl.hidden) placeHover(e); });
    box.addEventListener("pointerout", e => {
      const im = e.target.closest(".kt-pic img");
      if (!im) return;
      const to = e.relatedTarget;
      if (!to || !to.closest || to.closest(".kt-pic img") !== im) hideHover();
    });
  }

  function renderResults() {
    const q = $("kSearch").value.trim();
    const narrowed = !!q || filtered();
    $("kPopular").hidden = narrowed || !popular.length;
    if (!$("kPopular").hidden) $("kPopularRow").innerHTML = popular.map(r => tile(r, true)).join("");
    $("kGridTitle").textContent = narrowed ? "Matching cards" : "Everything in stock";
    const box = $("kResults");
    $("kMore").hidden = !more;
    if (!loaded) { box.innerHTML = '<li class="empty"><div class="empty-title">Loading the cards in stock…</div></li>'; return; }
    if (!rows.length) {
      box.innerHTML = '<li class="empty"><div class="empty-title">' +
        (q ? "Nothing in stock matches “" + esc(q) + "”" + (filtered() ? " with these filters." : ".") : filtered() ? "Nothing in stock matches these filters." : "Nothing is in stock just now.") + "</div>" +
        '<div class="empty-hint">' + (filtered() ? "Try fewer filters, or ask at the counter." : q ? "Check the spelling, or ask at the counter." : "Ask at the counter.") + "</div></li>";
      return;
    }
    box.innerHTML = rows.map(r => tile(r)).join("");
  }

  function searchUrl(pageNo, extra) {
    const p = new URLSearchParams({ q: $("kSearch").value.trim() });
    if (filters.set) p.set("set", filters.set);
    if (filters.type) p.set("type", filters.type);
    if (filters.rarity) p.set("rarity", filters.rarity);
    if (filters.colors.length) p.set("colors", filters.colors.join(","));
    if (filters.price) {
      const [min, max] = filters.price.split("-");
      if (min) p.set("min", min);
      if (max) p.set("max", max);
    }
    if (pageNo) p.set("page", String(pageNo));
    for (const k of extra || []) p.set(k, "1");
    return "/api/kiosk/search?" + p.toString();
  }
  // first: also the filter choices and the Popular row (on opening, and after each order: the stock moved).
  async function search(first) {
    const seq = ++searchSeq;
    try {
      const d = await api(searchUrl(0, first === true ? ["facets", "popular"] : []));
      if (seq !== searchSeq) return;   // a newer search is on its way
      if (d.facets) fillFilters(d.facets);
      if (d.popular) popular = d.popular;
      loaded = true;
      rows = d.rows || [];
      more = !!d.more;
      page = 0;
      renderResults();
    } catch (e) {
      if (e.status !== 401 && seq === searchSeq) $("kResults").innerHTML = '<li class="empty"><div class="empty-title">' + esc(e.message) + "</div></li>";
    }
  }
  async function showMore() {
    const seq = searchSeq;
    $("kMore").disabled = true;
    try {
      const d = await api(searchUrl(page + 1));
      if (seq !== searchSeq) return;
      page = d.page;
      const have = new Set(rows.map(r => r.key));
      rows = rows.concat((d.rows || []).filter(r => !have.has(r.key)));
      more = !!d.more;
      renderResults();
    } catch (e) {
      if (e.status !== 401) setStatus(e.message, "err");
    } finally {
      $("kMore").disabled = false;
    }
  }
  let searchTimer = 0;
  const searchSoon = () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 200); };
  function setFilter(k, v) {
    filters[k] = v;
    showFilters();
    clearTimeout(searchTimer);
    search();
  }

  /* ---------- The order ---------- */
  function add(r) {
    if (atLimit()) return;
    const l = order.find(x => x.key === r.key);
    if (l) { if (l.qty < r.free) l.qty++; l.free = r.free; }
    else if (r.free > 0) order.push(Object.assign({}, r, { qty: 1 }));
    renderAll();
  }
  function step(key, by) {
    const l = order.find(x => x.key === key);
    if (!l) return;
    if (by > 0 && atLimit()) return;
    l.qty = Math.min(l.free, l.qty + by);
    if (l.qty < 1) order = order.filter(x => x !== l);
    renderAll();
  }
  const total = () => Math.round(order.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;

  function renderOrder() {
    const box = $("kLines");
    box.innerHTML = order.length ? order.map(l =>
      '<li><div class="kl-name"><div>' + esc(l.name) + '</div><div class="faint">' + esc(cardMeta(l)) + "</div></div>" +
        '<div class="kiosk-step">' +
          '<button data-step="' + esc(l.key) + '" data-by="-1" title="One less" aria-label="One less ' + esc(l.name) + '">' + icon(l.qty === 1 ? "trash-2" : "minus") + "</button>" +
          '<span class="qty">' + l.qty + "</span>" +
          '<button data-step="' + esc(l.key) + '" data-by="1" title="One more" aria-label="One more ' + esc(l.name) + '"' + (l.qty >= l.free || atLimit() ? " disabled" : "") + ">" + icon("plus") + "</button>" +
        "</div>" +
        '<span class="kl-price">' + money(l.price * l.qty) + "</span></li>").join("")
      : '<li class="empty"><div class="empty-hint">Add cards to start your order.</div></li>';
    $("kTotal").textContent = money(total());
    $("kLimit").hidden = maxCards == null;
    $("kLimit").textContent = maxCards == null ? "" : atLimit()
      ? "That's the most for one order (" + maxCards + " cards). Ask at the counter for more."
      : "Up to " + maxCards + " cards per order.";
    $("kSend").disabled = !order.length || sending;
    $("kClear").disabled = !order.length && !$("kName").value && !$("kContact").value;
  }
  function renderAll() { renderOrder(); renderResults(); if (zoomKey) renderZoom(); }

  function setStatus(text, kind) {
    const el = $("kStatus");
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  async function send() {
    const name = $("kName").value.trim(), contact = $("kContact").value.trim();
    if (!order.length) return;
    if (!name) { setStatus("Enter your name.", "err"); $("kName").focus(); return; }
    if (!contact) { setStatus("Enter your email or phone number.", "err"); $("kContact").focus(); return; }
    sending = true;
    renderOrder();
    setStatus("Sending your order…", "work");
    try {
      const d = await api("/api/kiosk/order", { method: "POST", body: { name, contact, lines: order.map(l => ({ key: l.key, qty: l.qty })) } });
      showDone(name, d);
    } catch (e) {
      if (e.status === 401) return;
      // Someone else got there first: what's left is in the order now, to check and send again.
      for (const s of (e.data && e.data.short) || []) {
        const l = order.find(x => x.key === s.key);
        if (!l) continue;
        l.free = Math.max(0, Number(s.free) || 0);
        l.qty = Math.min(l.qty, l.free);
      }
      order = order.filter(l => l.qty > 0);
      setStatus(e.message, "err");
      if (e.data && (e.data.field === "name" || e.data.field === "contact")) $(e.data.field === "name" ? "kName" : "kContact").focus();
      search();
    } finally {
      sending = false;
      renderOrder();
    }
  }

  function showDone(name, d) {
    $("kShop").hidden = true;
    $("kDone").hidden = false;
    $("kDoneTitle").textContent = "Thank you, " + name.split(" ")[0];
    $("kDoneNo").textContent = d.id;
    $("kDoneWhat").textContent = d.cards + " card" + (d.cards === 1 ? "" : "s") + ", " + money(d.total) + " to pay at the counter.";
    clearOrder();
    clearTimeout(doneTimer);
    doneTimer = setTimeout(nextCustomer, DONE_MS);
    $("kNext").focus();
  }
  function clearOrder() {
    closeZoom();
    order = [];
    filters = { set: "", type: "", rarity: "", price: "", colors: [] };
    $("kSearch").value = "";
    $("kName").value = "";
    $("kContact").value = "";
    setStatus("");
    showFilters();
    renderAll();
    search(true);   // back to browsing everything, with the stock as it is now
  }
  function nextCustomer() {
    clearTimeout(doneTimer);
    clearOrder();
    $("kDone").hidden = true;
    $("kShop").hidden = false;
    window.scrollTo(0, 0);
  }

  /* ---------- Leaving kiosk mode (staff) ---------- */
  function openPin() {
    $("kPin").value = "";
    $("kPinStatus").textContent = "";
    $("kPinDlg").hidden = false;
    $("kPin").focus();
  }
  const closePin = () => { $("kPinDlg").hidden = true; $("kPin").value = ""; };
  async function leave() {
    const st = $("kPinStatus");
    st.className = "status work";
    st.textContent = "Checking…";
    try {
      await api("/api/kiosk/exit", { method: "POST", body: { pin: $("kPin").value.trim() } });
      location.replace("/login.html");
    } catch (e) {
      if (e.status === 401) return;
      st.className = "status err";
      st.textContent = e.message;
      $("kPin").value = "";
      $("kPin").focus();
    }
  }

  /* ---------- Wire up ---------- */
  $("kSearch").addEventListener("input", searchSoon);
  for (const id of ["kResults", "kPopularRow"]) {
    $(id).addEventListener("click", e => {
      const z = e.target.closest("[data-zoom]");
      if (z) { openZoom(z.dataset.zoom); return; }
      const b = e.target.closest("[data-add]");
      const r = b && byKey(b.dataset.add);
      if (r) add(r);
    });
    wireHover($(id));
  }
  $("kZoom").addEventListener("click", e => {
    if (e.target === $("kZoom")) { closeZoom(); return; }   // a tap outside the card
    const b = e.target.closest("[data-add]");
    const r = b && byKey(b.dataset.add);
    if (r) add(r);
  });
  $("kZoomClose").onclick = closeZoom;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("kZoom").hidden) closeZoom(); });
  window.addEventListener("scroll", hideHover, { passive: true });
  $("kMore").onclick = showMore;
  $("kfSet").addEventListener("change", () => setFilter("set", $("kfSet").value));
  $("kfType").addEventListener("change", () => setFilter("type", $("kfType").value));
  $("kfRarity").addEventListener("change", () => setFilter("rarity", $("kfRarity").value));
  $("kfPrice").addEventListener("change", () => setFilter("price", $("kfPrice").value));
  $("kfColors").addEventListener("click", e => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    const c = b.dataset.color;
    setFilter("colors", filters.colors.includes(c) ? filters.colors.filter(x => x !== c) : filters.colors.concat([c]));
  });
  $("kfClear").onclick = () => { filters = { set: "", type: "", rarity: "", price: "", colors: [] }; setFilter("colors", []); };
  $("kLines").addEventListener("click", e => {
    const b = e.target.closest("[data-step]");
    if (b) step(b.dataset.step, Number(b.dataset.by));
  });
  $("kName").addEventListener("input", () => renderOrder());
  $("kContact").addEventListener("input", () => renderOrder());
  $("kSend").onclick = send;
  $("kClear").onclick = clearOrder;
  $("kNext").onclick = nextCustomer;
  $("kStaff").onclick = openPin;
  $("kPinCancel").onclick = closePin;
  $("kPinOk").onclick = leave;
  $("kPin").addEventListener("keydown", e => { if (e.key === "Enter") leave(); if (e.key === "Escape") closePin(); });
  // A half-built order (and the customer's name and contact) isn't left for the next person.
  for (const ev of ["pointerdown", "keydown", "input"]) document.addEventListener(ev, () => { lastTouch = Date.now(); }, true);
  setInterval(() => {
    const busy = order.length || $("kSearch").value || filtered() || page > 0 || $("kName").value || $("kContact").value;
    if (Date.now() - lastTouch <= IDLE_MS) return;
    if (!$("kZoom").hidden) closeZoom();
    if (busy && !sending && !$("kShop").hidden) { clearOrder(); closePin(); }
  }, 10000);

  renderAll();
  search(true);
  api("/api/kiosk/info").then(d => {
    if (d.storeName) $("kStore").textContent = d.storeName;
    maxCards = Number.isInteger(d.maxCards) && d.maxCards > 0 ? d.maxCards : null;
    renderAll();
  }).catch(() => {});
})();
