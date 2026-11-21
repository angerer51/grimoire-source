"use strict";
(function () {
  const $ = UI.$;

  /* ============================== Tabs ============================== */
  const TABS = { guide: "Guide", glossary: "Glossary", support: "Support", changelog: "Changelog" };
  let tabs;

  /* ============================== Glossary (#301) ==============================
     Drawn from the shared term list (public/js/glossary.js), so the A-Z list and
     the hover previews on other pages always say the same thing. Simple mode
     leaves out the terms about features it hides. */
  function initGlossary() {
    const host = $("glossList");
    const GL = window.Glossary;
    if (!host || !GL) return;
    const terms = GL.termsFor(G.simpleMode).slice().sort((a, b) => a.term.localeCompare(b.term));
    const groups = new Map();
    terms.forEach(t => {
      const L = t.term[0].toUpperCase();
      if (!groups.has(L)) groups.set(L, []);
      groups.get(L).push(t);
    });
    host.innerHTML = Array.from(groups).map(([L, list]) =>
      '<section class="gloss-group" id="gl-' + L + '"><h2>' + L + "</h2><dl>" +
      list.map(t => '<div class="gloss-term" id="g-' + t.id + '"><dt>' + G.esc(t.term) + "</dt><dd>" + G.esc(t.def) +
        (t.id === "condition" ? ' <a href="#condition-grading">See the grading pictures.</a>' : "") +
        (t.id === "whats-new" ? ' <a href="#whats-new">See the list.</a>' : "") + "</dd></div>").join("") +
      "</dl></section>").join("");
    $("glossLetters").innerHTML = Array.from(groups.keys()).map(L => '<a href="#gl-' + L + '">' + L + "</a>").join("");
    const hay = new Map(terms.map(t => [t.id, (t.term + " " + GL.formsOf(t).join(" ") + " " + t.def).toLowerCase()]));
    function filter() {
      const words = $("glossSearch").value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      terms.forEach(t => {
        const ok = words.every(w => hay.get(t.id).includes(w));
        document.getElementById("g-" + t.id).hidden = !ok;
        if (ok) shown++;
      });
      groups.forEach((list, L) => {
        const any = list.some(t => !document.getElementById("g-" + t.id).hidden);
        document.getElementById("gl-" + L).hidden = !any;
        const a = $("glossLetters").querySelector('a[href="#gl-' + L + '"]');
        if (a) a.hidden = !any;
      });
      $("glossEmpty").hidden = shown > 0;
    }
    $("glossSearch").addEventListener("input", filter);
    $("glossSearch").addEventListener("keydown", e => {
      if (e.key === "Escape") { $("glossSearch").value = ""; filter(); }
    });
  }

  function safeHash() {
    try { return decodeURIComponent(location.hash.slice(1)); } catch (e) { return ""; }
  }
  // help.html#glossary, #g-<term>, #gl-<letter> and #condition-grading open the Glossary tab.
  function isGlossaryHash(id) {
    return id === "glossary" || id === "condition-grading" || /^gl?-/.test(id);
  }
  function openGlossaryHash(id) {
    tabs.show("glossary");
    const target = id === "glossary" ? null : document.getElementById(id);
    if (target && $("paneGlossary").contains(target)) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  /* ============================== Support tickets ==============================
     Folded in from the retired support.html/.page.js when Help and Support
     were merged into one page - unchanged apart from that. */
  let tickets = [];
  let selectedId = null;

  function fmtWhen(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso || ""; }
  }

  function statusPill(status) {
    const on = status === "open" || status === "in-progress";
    return '<span class="pill' + (on ? " on" : "") + '">' + G.esc(status) + "</span>";
  }

  function renderTable() {
    const body = $("ticketBody");
    if (!tickets.length) {
      body.innerHTML = UI.emptyRow(5, { icon: "tickets", title: "No tickets yet." });
    } else {
      body.innerHTML = "";
      tickets.forEach(t => {
        const tr = document.createElement("tr");
        // The open ticket's row: the shared selected-row style (#180).
        if (t.id === selectedId) tr.className = "sel";
        // Updated sorts by real time (data-v), not by its text (#180, as #164).
        tr.innerHTML =
          "<td>" + G.esc(t.subject) + "</td>" +
          "<td>" + G.esc(t.category) + "</td>" +
          "<td>" + statusPill(t.status) + "</td>" +
          '<td data-v="' + (Date.parse(t.updatedAt) || 0) + '">' + G.esc(fmtWhen(t.updatedAt)) + "</td>" +
          '<td><button class="small ghost" data-r="open">Open</button></td>';
        tr.querySelector('[data-r="open"]').onclick = () => selectTicket(t.id);
        body.appendChild(tr);
      });
    }
    $("ticketsHdr").textContent = tickets.length ? "— " + tickets.length : "";
    UI.reapplySorts();
  }

  // Refreshes the table only. The open thread (if any) re-renders itself via
  // UI.renderTicketThread's own return-value handling (see renderThread's
  // onReply below) or via an explicit renderThread() call after an action
  // that isn't a reply (close/reopen, submitting a new ticket) - never both,
  // or the thread would flicker through two renders for one action.
  async function loadTickets() {
    let d;
    try { d = await G.api("/api/tickets"); } catch (e) { UI.toast(e.message, "err"); return; }
    tickets = d.tickets;
    renderTable();
  }

  function renderThread(ticket) {
    const moved = selectedId !== ticket.id;
    selectedId = ticket.id;
    if (moved) renderTable();   // move the .sel row to this ticket
    $("threadSection").hidden = false;
    $("threadTitle").textContent = ticket.subject + " — " + ticket.status;
    $("threadClose").textContent = ticket.status === "closed" ? "Reopen" : "Close ticket";
    $("threadClose").onclick = async () => {
      try {
        const out = await G.api("/api/tickets/" + encodeURIComponent(ticket.id) + "/close", { method: "POST" });
        await loadTickets();
        renderThread(out.ticket);
      } catch (e) { UI.toast(e.message, "err"); }
    };
    UI.renderTicketThread($("threadHost"), ticket, async text => {
      const out = await G.api("/api/tickets/" + encodeURIComponent(ticket.id) + "/reply", {
        method: "POST", body: { message: text }
      });
      await loadTickets(); // table only - the thread re-renders from out.ticket below
      $("threadTitle").textContent = out.ticket.subject + " — " + out.ticket.status;
      $("threadClose").textContent = out.ticket.status === "closed" ? "Reopen" : "Close ticket";
      return out.ticket;
    });
  }

  function selectTicket(id) {
    const t = tickets.find(x => x.id === id);
    if (t) renderThread(t);
  }

  /* ============================== Guide side menu ==============================
     Scroll highlight, search filter (heading + text), and the phone dropdown. */
  function initGuideMenu() {
    const body = document.querySelector("#paneGuide .guide-body");
    if (!body) return;
    const sections = Array.from(body.querySelectorAll("section[id]"));
    const links = Array.from(document.querySelectorAll("#guideToc a"));
    const options = Array.from($("guideJump").options);
    const text = new Map(sections.map(s => [s, s.textContent.toLowerCase().replace(/\s+/g, " ")]));
    const linkFor = id => links.find(a => a.getAttribute("href") === "#" + id);
    const optFor = id => options.find(o => o.value === id);

    function filter() {
      const terms = $("guideSearch").value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      sections.forEach(s => {
        const ok = terms.every(t => text.get(s).includes(t));
        s.hidden = !ok;
        const a = linkFor(s.id), o = optFor(s.id);
        if (a) a.hidden = !ok;
        if (o) o.hidden = o.disabled = !ok;
        if (ok) shown++;
      });
      $("guideEmpty").hidden = shown > 0;
      highlight();
    }

    function highlight() {
      const bar = document.getElementById("chromeSticky");
      const line = (bar ? bar.getBoundingClientRect().height : 0) + 40;
      let current = null;
      sections.forEach(s => { if (!s.hidden && s.getBoundingClientRect().top <= line) current = s; });
      if (!current) current = sections.find(s => !s.hidden) || null;
      links.forEach(a => a.classList.toggle("active", !!current && a.getAttribute("href") === "#" + current.id));
      if (current && !$("guideSearch").value) $("guideJump").value = current.id;
    }

    // The top bar is sticky and its height differs by width, so keep headings clear of it.
    function clearBar() {
      const bar = document.getElementById("chromeSticky");
      const h = bar ? bar.getBoundingClientRect().height : 0;
      document.querySelectorAll("#paneGuide [id], #paneGlossary [id]").forEach(s => { s.style.scrollMarginTop = (h + 14) + "px"; });
    }
    clearBar();
    window.addEventListener("resize", clearBar);
    window.addEventListener("load", clearBar);
    setTimeout(clearBar, 500);

    let queued = false;
    window.addEventListener("scroll", () => {
      if (queued || $("paneGuide").hidden) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; highlight(); });
    }, { passive: true });
    $("guideSearch").addEventListener("input", filter);
    $("guideSearch").addEventListener("keydown", e => {
      if (e.key === "Escape") { $("guideSearch").value = ""; filter(); }
    });
    $("guideJump").addEventListener("change", () => {
      const s = document.getElementById($("guideJump").value);
      if (!s) return;
      history.replaceState(null, "", "#" + s.id);
      s.scrollIntoView();
    });
    highlight();
  }

  /* ============================== What's new (#455) ==============================
     Every "What's new" tutorial, newest first, each with Replay. Drawn before
     initGuideMenu, so the guide search finds their titles and summaries. */
  function initWhatsNew() {
    const host = $("whatsNewList");
    if (!host || !UI.whatsNew || typeof UI.whatsNew.list !== "function") return;
    const list = UI.whatsNew.list();
    if (!list.length) { host.innerHTML = UI.emptyBlock({ icon: "generic", title: "Nothing new yet." }); return; }
    const day = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    host.innerHTML = list.map(t => '<div class="feed-row"><span class="ftime">' + G.esc(day(t.released)) + "</span>" +
      '<span class="ftext"><b>' + G.esc(t.title) + "</b><br>" + G.esc(t.summary) + "</span>" +
      '<button type="button" class="small" data-wn="' + G.esc(t.id) + '">Replay</button></div>').join("");
    host.querySelectorAll("button[data-wn]").forEach(b => { b.onclick = () => UI.whatsNew.replay(b.dataset.wn); });
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    initGlossary();
    initWhatsNew();
    initGuideMenu();
    // Read before UI.pageTabs rewrites the address to #tab=<id>.
    const anchor = safeHash();
    // The tab is remembered (UI.pageTabs). #guide, #glossary, #support and
    // #changelog name a tab; #tab=<id> is the address it keeps.
    tabs = UI.pageTabs({ tabs: Object.keys(TABS).map(k => ({ id: k, button: "tab" + TABS[k], panes: ["pane" + TABS[k]] })), def: "guide" });
    if (anchor === "" || /^tab=/.test(anchor) || TABS[anchor]) { /* the tab is already open */ }
    else if (isGlossaryHash(anchor)) openGlossaryHash(anchor);
    else {
      // A deep link from a page's [?] (help.html#putaway-page): the Guide tab, scrolled to that section.
      tabs.show("guide");
      let target = null;
      try { target = document.getElementById(anchor); } catch (e) { /* bad escape */ }
      if (target && $("paneGuide").contains(target)) {
        // The top bar is sticky, so leave its height (it differs by width) above the heading.
        const bar = document.getElementById("chromeSticky");
        const barH = bar ? bar.getBoundingClientRect().height : 0;
        target.style.scrollMarginTop = (barH + 14) + "px";
        target.scrollIntoView();
      }
    }

    // Clicking a #g-term link (or the Guide menu's Glossary link) while already here.
    // The Glossary's "What's new" link (#455) goes back to the Guide's list.
    window.addEventListener("hashchange", () => {
      if (isGlossaryHash(safeHash())) openGlossaryHash(safeHash());
      else if (safeHash() === "whats-new") { tabs.show("guide"); $("whats-new").scrollIntoView(); }
    });

    $("newSubmit").onclick = async () => {
      const subject = $("newSubject").value.trim();
      const message = $("newMessage").value.trim();
      if (!subject) { UI.setStatus("newStatus", "Give the ticket a subject.", "err"); return; }
      if (!message) { UI.setStatus("newStatus", "Describe the issue.", "err"); return; }
      $("newSubmit").disabled = true;
      try {
        const out = await G.api("/api/tickets", { method: "POST", body: {
          category: $("newCategory").value, subject, message
        } });
        $("newSubject").value = ""; $("newMessage").value = "";
        UI.setStatus("newStatus", "Ticket submitted.", "ok");
        await loadTickets();
        renderThread(out.ticket);
      } catch (e) { UI.setStatus("newStatus", e.message, "err"); }
      $("newSubmit").disabled = false;
    };

    // #139: help.html?ticket=<id>#support (a notification) opens that
    // ticket's thread. /api/tickets lists only the reporter's own tickets,
    // so anyone else's id simply isn't found.
    const deepTicket = new URLSearchParams(location.search).get("ticket");
    await loadTickets();
    if (deepTicket) {
      tabs.show("support");
      if (tickets.some(t => t.id === deepTicket)) {
        selectTicket(deepTicket);
        try { $("threadSection").scrollIntoView({ block: "start" }); } catch (e) {}
      } else UI.toast("That ticket isn't one of yours any more.", "err");
    }
  });
})();
