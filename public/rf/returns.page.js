"use strict";
/* Warehouse Mode: returns (#411). Flow: docs/flows/rf-returns.dot.
   The desk opens a return (order, refund, cost per card, and what the order says
   should come back: the Returns page). Here the receiver sees that list, ticks in
   what's really in the package (how many, what condition), and decides per card:
   Restock, or Damaged. A card that wasn't on the order is added by name, as
   in Receive. Booked copies go into the Receiving tray and are held until the
   desk closes the return (core.js "Returns on the floor"); Put away takes them
   from the tray to a bin with the Putaway rules' suggestion and the bin check,
   exactly as for a receipt. No money, refund or buyer shows here.

   Routes: #returns, #returns/r/<id>, #returns/c/<id>/<expected line>,
   #returns/add/<id>. */
(function () {
  const { esc, icon, head } = RF;
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  RF.job({ id: "returns", label: "Returns", icon: "repeat", count: () => G.rfReturnList().length });

  const copyWord = c => [c.condition, c.finish && c.finish !== "nonfoil" ? (G.FINISH_NAMES[c.finish] || c.finish) : "",
    c.lang && c.lang !== "en" ? String(c.lang).toUpperCase() : ""].filter(Boolean).join(" ");
  const copyName = c => [copyWord(c), c.name].filter(Boolean).join(" ");
  const times = (n, c) => (n > 1 ? "×" + n + " " : "") + copyName(c);
  const printing = c => [c.set, c.collector ? "#" + c.collector : ""].filter(Boolean).join(" ");
  function chips(c) {
    const out = [];
    if (c.finish && c.finish !== "nonfoil") out.push('<span class="rf-tag warn">' + esc(G.FINISH_NAMES[c.finish] || c.finish) + "</span>");
    if (c.lang && c.lang !== "en") out.push('<span class="rf-tag warn">' + esc(String(c.lang).toUpperCase()) + "</span>");
    if (c.condition) out.push('<span class="rf-tag">' + esc(c.condition) + "</span>");
    return out.join(" ");
  }
  function cardBlock(c) {
    return '<div class="rf-mini">' +
      (c.image
        ? '<button class="rf-photo" data-act="photo" data-url="' + esc(RF.largeImage(c.image)) + '" title="Show a large photo" aria-label="Show a large photo">' +
          '<img src="' + esc(c.image) + '" alt=""></button>'
        : '<div class="rf-photo"><div class="rf-nophoto">' + icon("package") + "</div></div>") +
      '<div class="rf-card-side"><div class="rf-card-sub">' + esc(printing(c)) + "</div>" +
      '<div class="rf-chips">' + chips(c) + "</div></div></div>";
  }
  const msgBox = m => (m ? '<div class="rf-msg bad" role="alert">' + esc(m) + "</div>" : "");
  const closedScreen = () => head("Closed", "returns") +
    '<div class="rf-empty">' + icon("triangle-alert") + "That return isn't open any more. The desk has closed it.</div>" +
    '<div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("returns")) + '">Open returns</a></div>';
  async function fresh() { return !!(await G.catchUp()).ok; }
  const NO_SIGNAL = "Couldn't check the latest stock, so nothing was booked. Check the signal and try again.";

  RF.screen("returns", p => {
    if (p[0] === "r") return renderReturn(p[1] || "");
    if (p[0] === "c") return renderDetails(p[1] || "", p[2] || "");
    if (p[0] === "add") return renderAdd(p[1] || "");
    return renderList();
  });

  /* ------------------------- Open returns ------------------------- */
  function renderList() {
    RF.stayAwake(false);
    RF.refreshSoon();
    const list = G.rfReturnList();
    return head("Returns", "home") + '<div class="rf-body">' +
      (list.length ? list.map(r => '<a class="rf-row" href="' + esc(RF.hashOf("returns", "r", r.id)) + '"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(r.returnId) + "</div>" +
        '<div class="rf-row-sub">' + esc([r.orderLabel ? "Order " + r.orderLabel : "", r.expected ? plural(r.expected, "card") + " expected" : "Nothing listed", r.booked + " booked"].filter(Boolean).join(" · ")) + "</div></div>" +
        icon("arrow-right") + "</a>").join("")
        : '<div class="rf-empty">' + icon("repeat") + "No return is open. The desk opens one on the Returns page.</div>") +
      "</div>";
  }

  /* ------------------------- One return ------------------------- */
  let note = null;   // one line about what just happened, shown once
  function renderReturn(id) {
    RF.stayAwake(false);
    const v = G.rfReturnView(id);
    if (!v) return closedScreen();
    bk = null;
    const n = note; note = null;
    return head(v.returnId, "returns") + '<div class="rf-body">' +
      (v.orderLabel ? '<div class="rf-big">Order ' + esc(v.orderLabel) + "</div>" : "") +
      '<p class="rf-text">' + plural(v.booked, "card") + " booked. Held until the desk closes the return.</p>" +
      (n ? '<div class="rf-msg ' + n.kind + '" role="status">' + esc(n.text) + "</div>" : "") +
      (v.expected.length ? '<div class="rf-label">On the order: tap what came back</div>' + v.expected.map(e =>
        '<a class="rf-row stack" href="' + esc(RF.hashOf("returns", "c", id, e.id)) + '"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(times(e.qty, e)) + "</div>" +
        '<div class="rf-row-sub">' + esc(printing(e)) + " · " + (e.left ? e.got + " of " + e.qty + " booked" : "all booked") + "</div></div>" +
        icon(e.left ? "arrow-right" : "check") + "</a>").join("") : "") +
      (v.mine.length ? '<div class="rf-label">Your bookings</div>' + v.mine.map(lineRow).join("") +
        (v.mineCount > v.mine.length ? '<div class="rf-text">And ' + (v.mineCount - v.mine.length) + " earlier.</div>" : "") : "") +
      "</div>" +
      '<div class="rf-actions">' +
      '<a class="rf-btn gold" href="' + esc(RF.hashOf("returns", "add", id)) + '">' + icon("plus") + " Add a card not on the order</a>" +
      (v.toPutAway ? '<a class="rf-btn" href="' + esc(RF.hashOf("putaway")) + '">' + icon("archive") + " Put away (" + v.toPutAway + ")</a>" : "") + "</div>";
  }
  function lineRow(l) {
    return '<div class="rf-row stack"><div class="rf-row-main">' +
      '<div class="rf-row-title">' + esc(times(l.qty, l)) + "</div>" +
      '<div class="rf-row-sub">' + esc([l.disposition === "damaged" ? "Damaged" : "Restock", printing(l), l.bin].filter(Boolean).join(" · ")) + "</div></div>" +
      (l.undoable ? '<button class="rf-btn danger" data-act="rtUndo" data-id="' + esc(l.id) + '">' + icon("x") + " Undo</button>" : "") + "</div>";
  }
  async function undoLine(lineId, after) {
    const can = G.rfLineUndoable(lineId);
    if (!can.ok) { RF.feedback("bad"); after(); return; }
    const l = can.line;
    const ok = await RF.confirm({ title: "Undo this booking?",
      body: times(l.qty, l) + " comes off the return and out of " + G.locName(l.locationId) + ". Take " + (l.qty === 1 ? "it" : "them") + " back out of the tray.",
      ok: "Undo it", cancel: "Keep it", danger: true });
    if (!ok) return;
    if (!await fresh()) { note = { kind: "bad", text: "Couldn't check the latest stock, so nothing was undone. Check the signal and try again." }; RF.feedback("bad"); after(); return; }
    const res = G.rfUndoLine(lineId);
    if (!res.ok) {
      note = { kind: "bad", text: res.problem === "put-away" ? "Those copies have been put away, so the booking stays. Move or adjust them like any stock." : "That booking can't be undone now." };
      RF.feedback("bad");
    } else {
      G.persist("Booking undone in Warehouse Mode");
      G.saveNow();
      note = { kind: "ok", text: "Undone: " + times(l.qty, l) + "." };
      RF.feedback("ok");
    }
    after();
  }

  /* ------------------------- Check one card in ------------------------- */
  /* bk: where this phone is. Nothing is stock until Restock or Damaged is pressed.
     exp: the expected line it's for (printing fixed), or null for an extra (searched). */
  let bk = null;
  const finishesOf = c => { const f = ((c && c.finishes) || []).filter(x => G.FINISHES.includes(x)); return f.length ? f : ["nonfoil"]; };
  function fresh_bk(rid, exp) {
    bk = { rid, expId: exp ? exp.id : "", step: exp ? "details" : "name", q: "", names: [], groups: [], filter: "", gi: -1, name: exp ? exp.name : "",
      set: exp ? exp.set.toLowerCase() : "", collector: exp ? exp.collector : "", lang: exp ? exp.lang || "en" : "en", finish: exp ? exp.finish || "nonfoil" : "nonfoil",
      cond: exp && exp.condition ? exp.condition : G.defaultCondition(), qty: exp ? Math.max(1, exp.left || 1) : 1, image: exp ? exp.image : "", fixed: !!exp,
      busy: false, msg: null, last: null };
    return bk;
  }
  const bkStep = (step, fields) => { Object.assign(bk, { step, msg: null }, fields || {}); RF.redraw(true); };
  const bkCard = () => { const g = bk.groups[bk.gi]; return g ? (g.cards.find(c => (c.lang || "en") === bk.lang) || G.englishOf(g)) : null; };
  function choiceRow(label, act, values, current, words) {
    return '<div class="rf-label">' + esc(label) + '</div><div class="rf-choice" role="group" aria-label="' + esc(label) + '">' +
      values.map(v => '<button data-act="' + act + '" data-v="' + esc(v) + '"' + (v === current ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + ">" +
        (v === current ? icon("check") + " " : "") + esc(words ? words(v) : v) + "</button>").join("") + "</div>";
  }

  function renderDetails(rid, expId) {
    const v = G.rfReturnView(rid);
    if (!v) return closedScreen();
    const exp = v.expected.find(e => e.id === expId);
    if (!exp) { RF.go("returns", "r", rid); return null; }
    if (!bk || bk.rid !== rid || bk.expId !== expId) fresh_bk(rid, exp);
    return renderBk(v);
  }
  function renderAdd(rid) {
    const v = G.rfReturnView(rid);
    if (!v) return closedScreen();
    if (!bk || bk.rid !== rid || bk.expId) fresh_bk(rid, null);
    return renderBk(v);
  }
  function renderBk(v) {
    RF.stayAwake(true);
    const back = { act: "rtLeave" };
    if (bk.busy) return head("Book a card", null) + '<div class="rf-empty">' + icon("refresh-cw") + esc(bk.busy) + "</div>";
    if (bk.step === "booked") return renderBooked(v);
    if (bk.step === "names") {
      return head("Add a card", { act: "rtAgain" }, String(bk.names.length)) +
        '<div class="rf-body"><p class="rf-text">' + esc(bk.q) + "</p>" +
        bk.names.map((n, i) => '<button class="rf-row" data-act="rtName" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(n) + "</div></div>" + icon("arrow-right") + "</button>").join("") +
        '</div><div class="rf-actions"><button class="rf-btn" data-act="rtAgain">' + icon("search") + " Search again</button></div>";
    }
    if (bk.step === "printing") {
      const rows = [];
      bk.groups.forEach((g, i) => { if (G.printingMatches(G.englishOf(g), bk.filter)) rows.push(i); });
      RF.hold(true);
      return head(bk.name, { act: "rtAgain" }, String(bk.groups.length)) +
        '<div class="rf-body"><div class="rf-big">Which printing?</div>' +
        (bk.groups.length > 6 || bk.filter ? '<input id="rfPF" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" ' +
          'placeholder="Set code, number or year" aria-label="Narrow the printings" data-enter="rtNarrow" value="' + esc(bk.filter) + '">' : "") +
        (rows.length ? rows.slice(0, 30).map(i => {
          const c = G.englishOf(bk.groups[i]);
          return '<button class="rf-row" data-act="rtPrint" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(String(c.set || "").toUpperCase() + " #" + c.collector) + "</div>" +
            '<div class="rf-row-sub">' + esc([c.setName, String(c.releasedAt || "").slice(0, 4)].filter(Boolean).join(" · ")) + "</div></div>" + icon("arrow-right") + "</button>";
        }).join("") : '<div class="rf-empty">' + icon("search") + "No printing matches that.</div>") +
        (rows.length > 30 ? '<div class="rf-msg warn">Showing 30 of ' + rows.length + ". Type the set code or number.</div>" : "") + "</div>" +
        (bk.groups.length > 6 || bk.filter ? '<div class="rf-actions"><button class="rf-btn gold" data-act="rtNarrow">' + icon("search") + " Narrow it</button></div>" : "");
    }
    if (bk.step === "details") {
      const c = bk.fixed ? null : bkCard();
      if (!bk.fixed && !c) { bk.step = "name"; return renderBk(v); }
      const g = bk.groups[bk.gi];
      const langs = g ? [...new Set(g.cards.map(x => x.lang || "en"))] : [];
      const fins = bk.fixed ? [] : finishesOf(c);
      if (!bk.fixed && !fins.includes(bk.finish)) bk.finish = fins[0];
      const view = bk.fixed ? { name: bk.name, set: bk.set.toUpperCase(), collector: bk.collector, image: bk.image, condition: bk.cond, finish: bk.finish, lang: bk.lang }
        : { name: bk.name, set: String(c.set || "").toUpperCase(), collector: c.collector, image: c.imageUrl || "", condition: bk.cond, finish: bk.finish, lang: bk.lang };
      const left = bk.fixed ? (v.expected.find(e => e.id === bk.expId) || {}).left : null;
      return head("Check in", bk.fixed ? { act: "rtLeave" } : { act: "rtBackPrint" }, bk.fixed ? "" : "Details") +
        '<div class="rf-body"><h2 class="rf-card-name">' + esc(bk.name) + "</h2>" + cardBlock(view) +
        (bk.fixed ? '<p class="rf-text">The order has ' + (((v.expected.find(e => e.id === bk.expId) || {}).qty || 0) === 1 ? "1 copy" : ((v.expected.find(e => e.id === bk.expId) || {}).qty || 0) + " copies") + ", " + (left || 0) + " still to book. How many are in the package?</p>"
          : '<p class="rf-text">Not on the order. How many are in the package?</p>') +
        '<div class="rf-stepper"><button data-act="rtDown" title="One less" aria-label="One less">−</button>' +
        '<output aria-live="polite">' + bk.qty + '</output><button data-act="rtUp" title="One more" aria-label="One more">+</button></div>' +
        msgBox(bk.msg) +
        choiceRow("Condition", "rtCond", G.CONDITIONS, bk.cond) +
        (fins.length > 1 ? choiceRow("Finish", "rtFinish", fins, bk.finish, f => G.FINISH_NAMES[f] || f) : "") +
        (langs.length > 1 ? choiceRow("Language", "rtLang", langs, bk.lang, l => String(l).toUpperCase()) : "") +
        "</div>" +
        '<div class="rf-actions"><button class="rf-btn gold" data-act="rtBook" data-how="restock">' + icon("check") + " Restock " + bk.qty + "</button>" +
        '<button class="rf-btn danger" data-act="rtBook" data-how="damaged">' + icon("triangle-alert") + " Damaged " + bk.qty + "</button></div>";
    }
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfQ"); if (i) i.focus(); });
    return head("Add a card", back) +
      '<div class="rf-body"><div class="rf-big">Which card?</div>' +
      '<input id="rfQ" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Card name" aria-label="Card name" data-enter="rtFind" value="' + esc(bk.q) + '">' + msgBox(bk.msg) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="rtFind">' + icon("search") + " Find it</button></div>";
  }
  function renderBooked(v) {
    const r = bk.last;
    return head("Booked", null) +
      '<div class="rf-body"><div class="rf-big">' + esc(times(r.qty, r)) + "</div>" +
      '<div class="rf-text">' + esc(printing(r)) + "</div>" +
      '<div class="rf-msg ' + (r.damaged ? "warn" : "ok") + '">' + (r.damaged ? "Damaged. In " : "To restock. In ") + esc(r.bin) + " now, held until the desk closes the return.</div>" + msgBox(bk.msg) + "</div>" +
      '<div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("returns", "r", bk.rid)) + '">' + icon("check") + " Next card</a>" +
      '<div class="rf-actions two" style="padding:0;position:static">' +
      (G.rfLineUndoable(r.lineId).ok ? '<button class="rf-btn danger" data-act="rtUndoLast">' + icon("x") + " Undo</button>" : "") +
      '<a class="rf-btn" href="' + esc(RF.hashOf("putaway")) + '">Put away</a></div></div>';
  }
  RF.acts({
    rtLeave: () => { const rid = bk && bk.rid; bk = null; RF.go("returns", "r", rid || ""); },
    rtAgain: () => bkStep("name", { names: [], groups: [], filter: "" }),
    rtFind: async () => {
      const q = (RF.$("rfQ") && RF.$("rfQ").value || "").trim();
      if (q.length < 2 || bk.busy) return;
      bk.q = q;
      bk.busy = "Looking it up…";
      RF.redraw(true);
      let names = [];
      try { names = await G.cards.autocomplete(q); }
      catch (e) { bk.busy = false; bkStep("name", { msg: "Couldn't look that up: " + (e.message || e) }); return; }
      bk.busy = false;
      const exact = names.find(n => n.toLowerCase() === q.toLowerCase());
      if (exact || names.length === 1) { loadPrintings(exact || names[0]); return; }
      if (!names.length) { bkStep("name", { msg: "No card has that name. Check the spelling." }); return; }
      bkStep("names", { names: names.slice(0, 20) });
    },
    rtName: d => loadPrintings(bk.names[Number(d.i)]),
    rtNarrow: () => { bk.filter = (RF.$("rfPF") && RF.$("rfPF").value || "").trim(); RF.redraw(true); },
    rtPrint: d => {
      const g = bk.groups[Number(d.i)];
      if (!g) return;
      const langs = g.cards.map(x => x.lang || "en");
      bkStep("details", { gi: Number(d.i), lang: langs.includes(bk.lang) ? bk.lang : (langs.includes("en") ? "en" : langs[0]), qty: 1 });
    },
    rtBackPrint: () => bkStep("printing"),
    rtCond: d => { bk.cond = d.v; RF.redraw(); },
    rtFinish: d => { bk.finish = d.v; RF.redraw(); },
    rtLang: d => { bk.lang = d.v; RF.redraw(); },
    rtDown: () => { bk.qty = Math.max(1, bk.qty - 1); RF.redraw(); },
    rtUp: () => { bk.qty = Math.min(999, bk.qty + 1); RF.redraw(); },
    rtBook: d => bookCard(d.how === "damaged" ? "damaged" : "restock"),
    rtUndo: d => undoLine(d.id, () => RF.redraw(true)),
    rtUndoLast: () => undoLine(bk.last.lineId, () => { const rid = bk.rid; bk = null; RF.go("returns", "r", rid); RF.redraw(true); })
  });
  async function loadPrintings(name) {
    bk.name = name;
    bk.busy = "Loading the printings…";
    RF.redraw(true);
    let list = [];
    try { list = await G.cards.printings(name); }
    catch (e) { bk.busy = false; bkStep("name", { msg: "Couldn't load the printings: " + (e.message || e) }); return; }
    bk.busy = false;
    if (!list.length) { bkStep("name", { msg: "No printings found for that name." }); return; }
    const groups = G.sortPrintingsNewest(G.groupPrintings(list), G.englishOf);
    if (groups.length === 1) { bk.groups = groups; bkStep("details", { gi: 0, lang: groups[0].cards.some(c => (c.lang || "en") === "en") ? "en" : groups[0].cards[0].lang, qty: 1 }); return; }
    bkStep("printing", { groups, filter: "" });
  }
  async function bookCard(disposition) {
    if (bk.busy) return;
    const b = bk;
    let set = b.set, collector = b.collector;
    if (!b.fixed) { const c = bkCard(); if (!c) return; set = c.set; collector = c.collector; }
    const want = { cond: b.cond, finish: b.finish, lang: b.lang, qty: b.qty };
    b.busy = "Booking…";
    RF.redraw(true);
    const fail = text => { b.busy = false; if (bk === b) { RF.feedback("bad"); bkStep("details", { msg: text }); } };
    if (!await fresh()) return fail(NO_SIGNAL);
    if (!G.rfReturnView(b.rid)) { b.busy = false; RF.feedback("bad"); RF.redraw(true); return; }
    let info;
    try { info = await G.lookupCard(set, collector, want.lang, want.finish); }
    catch (e) { return fail("Couldn't look the card up: " + (e.message || e)); }
    const tray = G.receivingTray();
    const res = G.rfBookCard({ receivingId: b.rid, locationId: tray.id, info, set, lang: want.lang, finish: want.finish, condition: want.cond, qty: want.qty,
      disposition, expId: b.expId });
    if (!res.ok) return fail(res.problem === "closed" ? "The desk has closed this return." : "That couldn't be booked.");
    G.persist("Return booked in Warehouse Mode");
    G.saveNow();
    RF.feedback("ok");
    b.busy = false;
    bkStep("booked", { last: { lineId: res.line.id, qty: want.qty, name: res.stack.name, set: String(res.stack.set).toUpperCase(), collector: res.stack.collector,
      condition: res.stack.condition, finish: res.stack.finish, lang: res.stack.lang, bin: tray.name, damaged: disposition === "damaged" } });
  }
})();
