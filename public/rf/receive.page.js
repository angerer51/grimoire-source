"use strict";
/* Warehouse Mode: receive and put away (#388). Flow: docs/flows/rf-receive.dot.
   The desk opens a receipt (Receiving page); here the receiver picks it and
   books each card (name, printing, condition, finish, language, how many) or
   sealed product onto it. No money shows here: the desk closes the receipt and
   the spread happens there. Booked copies are stock at once, held until close
   (core.js "Receiving on the floor"), so they can be filed but not picked.

   Two ways to work a receipt, chosen per receipt on this phone (owner, 2026-11-02):
   - into a tray: everything goes into a sorting tray, and Put away (its own job
     on the home screen) walks a tray bin to bin later. Trays filled at the
     desk show there too.
   - card to bin: each booking goes to the "Receiving" tray for a moment and
     the screen sends it straight on to its bin.

   A bin check follows the account's Require bin scan setting, like the pick
   walk. The suggested bin is from the Putaway rules (cards) or where that
   product already sits (sealed). Scanning any other bin is accepted with no
   reason (owner); a camera read of another bin only picks it, a tap confirms.

   Routes: #receive, #receive/r/<id>, #receive/card/<id>, #receive/sealed/<id>,
   #receive/put/<id> (card to bin), #putaway, #putaway/tray/<id>. */
(function () {
  const { esc, icon, head } = RF;
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const BIN_LIST_MAX = 12;

  RF.job({ id: "receive", label: "Receive", icon: "inbox", count: () => G.rfReceivingList().length });
  RF.job({ id: "putaway", label: "Put away", icon: "archive", count: () => G.rfPutawayTrays().length });

  /* ------------------------- Words for a copy ------------------------- */
  function cardChips(c) {
    const out = [];
    if (c.sealed) out.push('<span class="rf-tag">Sealed</span>');
    if (c.finish && c.finish !== "nonfoil") out.push('<span class="rf-tag warn">' + esc(G.FINISH_NAMES[c.finish] || c.finish) + "</span>");
    if (c.lang && c.lang !== "en") out.push('<span class="rf-tag warn">' + esc(String(c.lang).toUpperCase()) + "</span>");
    if (c.condition) out.push('<span class="rf-tag">' + esc(c.condition) + "</span>");
    return out.join(" ");
  }
  const printing = c => [c.set, c.collector ? "#" + c.collector : ""].filter(Boolean).join(" ");
  const copyWord = c => [c.condition, c.finish && c.finish !== "nonfoil" ? (G.FINISH_NAMES[c.finish] || c.finish) : "",
    c.lang && c.lang !== "en" ? String(c.lang).toUpperCase() : ""].filter(Boolean).join(" ");
  const copyName = c => [copyWord(c), c.name].filter(Boolean).join(" ");
  const times = (n, c) => (n > 1 ? "×" + n + " " : "") + copyName(c);
  const sealedImage = id => "https://tcgplayer-cdn.tcgplayer.com/product/" + encodeURIComponent(id) + "_200w.jpg";
  // A small picture (tap it for the large photo), so what's asked stays in reach on a small phone.
  function cardBlock(c) {
    return '<div class="rf-mini">' +
      (c.image
        ? '<button class="rf-photo" data-act="photo" data-url="' + esc(RF.largeImage(c.image)) + '" title="Show a large photo" aria-label="Show a large photo">' +
          '<img src="' + esc(c.image) + '" alt=""></button>'
        : '<div class="rf-photo"><div class="rf-nophoto">' + icon("package") + "</div></div>") +
      '<div class="rf-card-side"><div class="rf-card-sub">' + esc(printing(c)) + "</div>" +
      '<div class="rf-chips">' + cardChips(c) + "</div></div></div>";
  }
  const closedScreen = (back) => head("Closed", back || "receive") +
    '<div class="rf-empty">' + icon("triangle-alert") + "That receipt isn't open any more. The desk has closed it.</div>" +
    '<div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("receive")) + '">Open receipts</a></div>';
  const msgBox = m => (m ? '<div class="rf-msg bad" role="alert">' + esc(m) + "</div>" : "");
  const scanMsg = text => { RF.feedback("bad"); const box = RF.$("rfScanMsg"); if (box) { box.textContent = text; box.hidden = false; } };

  /* How this phone works a receipt: { mode: "tray" | "bin", trayId }. Kept on the
     phone, so a reload carries on the same way. */
  const HOW = "rfReceiveHow:";
  function how(id) {
    try { return JSON.parse(localStorage.getItem(HOW + id) || "{}") || {}; } catch (e) { return {}; }
  }
  function setHow(id, v) { try { localStorage.setItem(HOW + id, JSON.stringify(v || {})); } catch (e) {} }
  const trayOk = id => { const l = G.locById(id); return !!(l && l.staging); };
  // Where a booking goes: the chosen tray, or Receiving (made the first time) for card to bin.
  function bookingTray(id) {
    const h = how(id);
    if (h.mode === "tray" && trayOk(h.trayId)) return h.trayId;
    return G.receivingTray().id;
  }

  /* Before anything that writes stock: the latest from the server first (#395). */
  async function fresh() {
    const c = await G.catchUp();
    return !!c.ok;
  }
  const NO_SIGNAL = "Couldn't check the latest stock, so nothing was booked. Check the signal and try again.";

  /* ------------------------- Open receipts ------------------------- */
  RF.screen("receive", p => {
    if (p[0] === "r") return renderReceipt(p[1] || "");
    if (p[0] === "card") return renderCard(p[1] || "");
    if (p[0] === "sealed") return renderSealed(p[1] || "");
    if (p[0] === "put") return renderPutFor(p[1] || "");
    return renderList();
  });

  function renderList() {
    RF.stayAwake(false);
    RF.refreshSoon();
    const list = G.rfReceivingList();
    return head("Receive", "home") + '<div class="rf-body">' +
      (list.length ? list.map(r => '<a class="rf-row" href="' + esc(RF.hashOf("receive", "r", r.id)) + '"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(r.receiptId) + "</div>" +
        '<div class="rf-row-sub">' + esc([r.source, plural(r.booked, "item") + " booked" + (r.mine ? ", " + r.mine + " by you" : "")].filter(Boolean).join(" · ")) + "</div></div>" +
        icon("arrow-right") + "</a>").join("")
        : '<div class="rf-empty">' + icon("inbox") + "No receipt is open. The desk opens one on the Receiving page.</div>") +
      "</div>";
  }

  /* ------------------------- One receipt ------------------------- */
  function renderReceipt(id) {
    RF.stayAwake(false);
    const v = G.rfReceiptView(id);
    if (!v) return closedScreen();
    const h = how(id);
    if (!h.mode) return renderHow(v);
    if (h.mode === "tray" && !trayOk(h.trayId)) return renderTrayChoice(v);
    const where = h.mode === "tray" ? "Into " + G.locName(h.trayId) : "Card to bin";
    const mine = v.mine;
    return head(v.receiptId, "receive") +
      '<div class="rf-body">' +
      (v.source ? '<div class="rf-big">' + esc(v.source) + "</div>" : "") +
      '<p class="rf-text">' + plural(v.booked, "item") + " booked" + (v.receivers.length ? " by " + esc(v.receivers.join(", ")) : "") +
      ". Held until the desk closes the receipt.</p>" +
      (recMsg ? '<div class="rf-msg ' + recMsg.kind + '" role="status">' + esc(recMsg.text) + "</div>" : "") +
      '<div class="rf-row"><div class="rf-row-main"><div class="rf-row-title">' + esc(where) + '</div><div class="rf-row-sub">How you\'re working this receipt</div></div>' +
      '<button class="rf-btn quiet" style="width:auto" data-act="rcHowReset">Change</button></div>' +
      (mine.length ? '<div class="rf-label">Your bookings</div>' + mine.map(lineRow).join("") +
        (v.mineCount > mine.length ? '<div class="rf-text">And ' + (v.mineCount - mine.length) + " earlier.</div>" : "") : "") +
      "</div>" +
      '<div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("receive", "card", id)) + '">' + icon("plus") + " Book a card</a>" +
      '<a class="rf-btn" href="' + esc(RF.hashOf("receive", "sealed", id)) + '">' + icon("package") + " Book sealed</a></div>";
  }
  let recMsg = null;   // one line about what just happened (an undo), shown once
  RF.acts({ rcHowReset: () => { setHow(receiptId(), {}); recMsg = null; RF.redraw(true); } });
  const WHY_NOT = { "put-away": "Put away", closed: "Closed", "not-yours": "", gone: "" };
  function lineRow(l) {
    return '<div class="rf-row stack"><div class="rf-row-main">' +
      '<div class="rf-row-title">' + esc(times(l.qty, l)) + "</div>" +
      '<div class="rf-row-sub">' + esc([printing(l), l.bin].filter(Boolean).join(" · ")) + "</div>" +
      (!l.undoable && WHY_NOT[l.why] ? '<div class="rf-row-sub">' + esc(WHY_NOT[l.why]) + "</div>" : "") + "</div>" +
      (l.undoable ? '<button class="rf-btn danger" data-act="rcUndo" data-id="' + esc(l.id) + '">' + icon("x") + " Undo</button>" : "") +
      "</div>";
  }
  function renderHow(v) {
    return head(v.receiptId, "receive", "How") +
      '<div class="rf-body"><div class="rf-big">How are you working this one?</div>' +
      '<button class="rf-row" data-act="rcMode" data-mode="tray"><div class="rf-row-main"><div class="rf-row-title">Into a tray</div>' +
      '<div class="rf-row-sub">Book everything into a sorting tray. Put it away after, from Put away.</div></div>' + icon("arrow-right") + "</button>" +
      '<button class="rf-row" data-act="rcMode" data-mode="bin"><div class="rf-row-main"><div class="rf-row-title">Card to bin</div>' +
      '<div class="rf-row-sub">Book a card, and the screen sends it straight to its bin.</div></div>' + icon("arrow-right") + "</button>" +
      "</div>";
  }
  function renderTrayChoice(v) {
    const trays = G.rfReceivingTrays();
    const hasReceiving = trays.some(t => t.name.toLowerCase() === "receiving");
    RF.scanning(text => {
      const loc = G.binFromLabel(text);
      if (!loc) { scanMsg(/^GRIMBIN:/i.test(text) ? "That label's bin isn't in this inventory." : "That isn't a bin label."); return; }
      if (!loc.staging) { scanMsg(loc.name + " isn't a sorting tray. Scan a tray, or choose one below."); return; }
      RF.feedback("ok");
      chooseTray(v.id, loc.id);
    });
    return head(v.receiptId, { act: "rcHowReset" }, "Tray") +
      '<div class="rf-body"><div class="rf-big">Which tray?</div>' +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock("Scan the tray's label") +
      trays.map(t => '<button class="rf-row" data-act="rcTray" data-tray="' + esc(t.id) + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(t.name) + "</div>" +
        '<div class="rf-row-sub">' + (t.items ? plural(t.items, "item") + " in it" : "Empty") + "</div></div>" + icon("arrow-right") + "</button>").join("") +
      (hasReceiving ? "" : '<button class="rf-row" data-act="rcTrayNew"><div class="rf-row-main"><div class="rf-row-title">Receiving</div>' +
        '<div class="rf-row-sub">A new sorting tray, made now</div></div>' + icon("plus") + "</button>") +
      '</div><div class="rf-actions">' + RF.cameraButton(false) + "</div>";
  }
  function chooseTray(id, trayId) {
    setHow(id, { mode: "tray", trayId });
    RF.redraw(true);
  }
  const receiptId = () => decodeURIComponent((location.hash.split("/")[2]) || "");
  RF.acts({
    rcMode: d => { setHow(receiptId(), { mode: d.mode }); RF.redraw(true); },
    rcTray: d => chooseTray(receiptId(), d.tray),
    rcTrayNew: () => { const t = G.receivingTray(); G.persist("Receiving tray made in Warehouse Mode"); chooseTray(receiptId(), t.id); },
    rcUndo: d => undoLine(d.id, () => RF.redraw(true))
  });
  async function undoLine(lineId, after) {
    const v = G.rfLineUndoable(lineId);
    if (!v.ok) { RF.feedback("bad"); RF.redraw(true); return; }
    const l = v.line;
    const ok = await RF.confirm({ title: "Undo this booking?",
      body: times(l.qty, l) + " comes off the receipt and out of " + G.locName(l.locationId) + ". Take " + (l.qty === 1 ? "it" : "them") + " back out of the tray.",
      ok: "Undo it", cancel: "Keep it", danger: true });
    if (!ok) return;
    if (!await fresh()) { recMsg = { kind: "bad", text: "Couldn't check the latest stock, so nothing was undone. Check the signal and try again." }; RF.feedback("bad"); after(); return; }
    const res = G.rfUndoLine(lineId);
    if (!res.ok) {
      recMsg = { kind: "bad", text: res.problem === "put-away" ? "Those copies have been put away, so the booking stays. Move or adjust them like any stock." : "That booking can't be undone now." };
      RF.feedback("bad");
    } else {
      G.persist("Booking undone in Warehouse Mode");
      G.saveNow();
      recMsg = { kind: "ok", text: "Undone: " + times(l.qty, l) + "." };
      RF.feedback("ok");
    }
    after();
  }

  /* ------------------------- Book a card ------------------------- */
  /* Where this phone is in one booking. Nothing here is stock until Book. */
  let bk = null;
  function bkFor(id) {
    if (!bk || bk.rid !== id) bk = { rid: id, step: "name", q: "", names: [], groups: [], filter: "", gi: -1, lang: "en", finish: "nonfoil", cond: "NM", qty: 1, busy: false, msg: null, last: null };
    return bk;
  }
  const bkStep = (step, fields) => { Object.assign(bk, { step, msg: null }, fields || {}); RF.redraw(true); };
  function bkCard() {
    const g = bk.groups[bk.gi];
    if (!g) return null;
    return g.cards.find(c => (c.lang || "en") === bk.lang) || G.englishOf(g);
  }
  const finishesOf = c => { const f = ((c && c.finishes) || []).filter(x => G.FINISHES.includes(x)); return f.length ? f : ["nonfoil"]; };

  function renderCard(id) {
    if (!G.receivingById(id)) return closedScreen();
    if (!how(id).mode) { RF.go("receive", "r", id); return null; }
    bkFor(id);
    RF.stayAwake(true);
    if (bk.busy) return head("Book a card", null) + '<div class="rf-empty">' + icon("refresh-cw") + esc(bk.busy) + "</div>";
    if (bk.step === "names") return renderNames();
    if (bk.step === "printing") return renderPrinting();
    if (bk.step === "details") return renderDetails();
    if (bk.step === "booked") return renderBooked();
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfQ"); if (i) i.focus(); });
    return head("Book a card", { act: "bkLeave" }) +
      '<div class="rf-body"><div class="rf-big">Which card?</div>' +
      '<input id="rfQ" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Card name" aria-label="Card name" data-enter="bkFind" value="' + esc(bk.q) + '">' + msgBox(bk.msg) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="bkFind">' + icon("search") + " Find it</button></div>";
  }
  function renderNames() {
    return head("Book a card", { act: "bkAgain" }, String(bk.names.length)) +
      '<div class="rf-body"><p class="rf-text">' + esc(bk.q) + "</p>" +
      bk.names.map((n, i) => '<button class="rf-row" data-act="bkName" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(n) + "</div></div>" + icon("arrow-right") + "</button>").join("") +
      '</div><div class="rf-actions"><button class="rf-btn" data-act="bkAgain">' + icon("search") + " Search again</button></div>";
  }
  const PRINT_MAX = 30;
  function renderPrinting() {
    const rows = [];
    bk.groups.forEach((g, i) => { if (G.printingMatches(G.englishOf(g), bk.filter)) rows.push(i); });
    RF.hold(true);
    return head(bk.name, { act: "bkAgain" }, String(bk.groups.length)) +
      '<div class="rf-body"><div class="rf-big">Which printing?</div>' +
      (bk.groups.length > 6 || bk.filter ? '<input id="rfPF" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" ' +
        'placeholder="Set code, number or year" aria-label="Narrow the printings" data-enter="bkNarrow" value="' + esc(bk.filter) + '">' : "") +
      (rows.length ? rows.slice(0, PRINT_MAX).map(i => {
        const c = G.englishOf(bk.groups[i]);
        const year = String(c.releasedAt || "").slice(0, 4);
        return '<button class="rf-row" data-act="bkPrint" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(String(c.set || "").toUpperCase() + " #" + c.collector) + "</div>" +
          '<div class="rf-row-sub">' + esc([c.setName, year].filter(Boolean).join(" · ")) + "</div></div>" + icon("arrow-right") + "</button>";
      }).join("") : '<div class="rf-empty">' + icon("search") + "No printing matches that.</div>") +
      (rows.length > PRINT_MAX ? '<div class="rf-msg warn">Showing ' + PRINT_MAX + " of " + rows.length + ". Type the set code or number.</div>" : "") +
      "</div>" +
      (bk.groups.length > 6 || bk.filter ? '<div class="rf-actions"><button class="rf-btn gold" data-act="bkNarrow">' + icon("search") + " Narrow it</button></div>" : "");
  }
  function choiceRow(label, act, values, current, words) {
    return '<div class="rf-label">' + esc(label) + '</div><div class="rf-choice" role="group" aria-label="' + esc(label) + '">' +
      values.map(v => '<button data-act="' + act + '" data-v="' + esc(v) + '"' + (v === current ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + ">" +
        (v === current ? icon("check") + " " : "") + esc(words ? words(v) : v) + "</button>").join("") + "</div>";
  }
  function renderDetails() {
    const g = bk.groups[bk.gi];
    const c = bkCard();
    if (!g || !c) { bk.step = "name"; return renderCard(bk.rid); }
    const langs = [...new Set(g.cards.map(x => x.lang || "en"))];
    const fins = finishesOf(c);
    if (!fins.includes(bk.finish)) bk.finish = fins[0];
    const view = { name: bk.name, set: String(c.set || "").toUpperCase(), collector: c.collector, image: c.imageUrl || "", condition: bk.cond, finish: bk.finish, lang: bk.lang };
    const where = how(bk.rid).mode === "tray" ? "into " + G.locName(bookingTray(bk.rid)) : "";
    return head("Book a card", { act: "bkBackPrint" }, "Details") +
      '<div class="rf-body"><h2 class="rf-card-name">' + esc(bk.name) + "</h2>" + cardBlock(view) +
      // How many first: the condition stays as last chosen, so a run of cards often only needs this.
      '<div class="rf-stepper"><button data-act="bkDown" title="One less" aria-label="One less">−</button>' +
      '<output aria-live="polite">' + bk.qty + '</output><button data-act="bkUp" title="One more" aria-label="One more">+</button></div>' +
      msgBox(bk.msg) +
      choiceRow("Condition", "bkCond", G.CONDITIONS, bk.cond) +
      (fins.length > 1 ? choiceRow("Finish", "bkFinish", fins, bk.finish, f => G.FINISH_NAMES[f] || f) : "") +
      (langs.length > 1 ? choiceRow("Language", "bkLang", langs, bk.lang, l => String(l).toUpperCase()) : "") +
      "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="bkBook">' + icon("check") + " Book " + bk.qty + (where ? " " + esc(where) : "") + "</button></div>";
  }
  function renderBooked() {
    const r = bk.last;
    return head("Booked", null) +
      '<div class="rf-body"><div class="rf-big">' + esc(times(r.qty, r)) + "</div>" +
      '<div class="rf-text">' + esc(printing(r)) + "</div>" +
      '<div class="rf-msg ok">In ' + esc(r.bin) + " now, held until the desk closes the receipt.</div>" + msgBox(bk.msg) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="bkNext">' + icon("plus") + " Next card</button>" +
      '<div class="rf-actions two" style="padding:0;position:static">' +
      (G.rfLineUndoable(r.lineId).ok ? '<button class="rf-btn danger" data-act="bkUndo">' + icon("x") + " Undo</button>" : "") +
      '<a class="rf-btn" href="' + esc(RF.hashOf("receive", "r", bk.rid)) + '">Done</a></div></div>';
  }
  RF.acts({
    bkLeave: () => { bk = null; RF.go("receive", "r", receiptId()); },
    bkAgain: () => bkStep("name", { names: [], groups: [], filter: "" }),
    bkFind: async () => {
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
    bkName: d => loadPrintings(bk.names[Number(d.i)]),
    bkNarrow: () => { bk.filter = (RF.$("rfPF") && RF.$("rfPF").value || "").trim(); RF.redraw(true); },
    bkPrint: d => {
      const g = bk.groups[Number(d.i)];
      if (!g) return;
      const langs = g.cards.map(x => x.lang || "en");
      bkStep("details", { gi: Number(d.i), lang: langs.includes(bk.lang) ? bk.lang : (langs.includes("en") ? "en" : langs[0]), qty: 1 });
    },
    bkBackPrint: () => bkStep("printing"),
    bkCond: d => { bk.cond = d.v; RF.redraw(); },
    bkFinish: d => { bk.finish = d.v; RF.redraw(); },
    bkLang: d => { bk.lang = d.v; RF.redraw(); },
    bkDown: () => { bk.qty = Math.max(1, bk.qty - 1); RF.redraw(); },
    bkUp: () => { bk.qty = Math.min(999, bk.qty + 1); RF.redraw(); },
    bkBook: () => bookCard(),
    bkNext: () => bkStep("name", { q: "", names: [], groups: [], filter: "", last: null }),
    bkUndo: () => undoLine(bk.last.lineId, () => { bk.step = "name"; bk.msg = recMsg && recMsg.kind === "bad" ? recMsg.text : null; recMsg = null; RF.redraw(true); })
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
  async function bookCard() {
    if (bk.busy) return;
    const b = bk, c = bkCard();
    if (!c) return;
    const want = { cond: b.cond, finish: b.finish, lang: b.lang, qty: b.qty, set: c.set, collector: c.collector };
    b.busy = "Booking…";
    RF.redraw(true);
    const fail = text => { b.busy = false; if (bk === b) { RF.feedback("bad"); bkStep("details", { msg: text }); } };
    if (!await fresh()) return fail(NO_SIGNAL);
    if (!G.receivingById(b.rid)) { b.busy = false; RF.feedback("bad"); RF.redraw(true); return; }
    let info;
    try { info = await G.lookupCard(want.set, want.collector, want.lang, want.finish); }
    catch (e) { return fail("Couldn't look the card up: " + (e.message || e)); }
    const trayId = bookingTray(b.rid);
    const res = G.rfBookCard({ receivingId: b.rid, locationId: trayId, info, set: want.set, lang: want.lang, finish: want.finish, condition: want.cond, qty: want.qty });
    if (!res.ok) return fail(res.problem === "closed" ? "The desk has closed this receipt." : "That couldn't be booked.");
    G.persist("Booked in Warehouse Mode");
    G.saveNow();
    RF.feedback("ok");
    b.busy = false;
    const last = { lineId: res.line.id, qty: want.qty, name: res.stack.name, set: String(res.stack.set).toUpperCase(), collector: res.stack.collector,
      condition: res.stack.condition, finish: res.stack.finish, lang: res.stack.lang, bin: G.locName(trayId) };
    if (how(b.rid).mode === "bin") {
      startPut({ kind: "card", stackId: res.stack.id, trayId, rid: b.rid, lineId: res.line.id });
      bk.step = "name"; bk.q = ""; bk.last = last;
      RF.go("receive", "put", b.rid);
      return;
    }
    bkStep("booked", { last });
  }

  /* ------------------------- Book sealed ------------------------- */
  let sk = null;
  function skFor(id) {
    if (!sk || sk.rid !== id) sk = { rid: id, step: "search", q: "", results: [], product: null, qty: 1, busy: false, msg: null, last: null };
    return sk;
  }
  const skStep = (step, fields) => { Object.assign(sk, { step, msg: null }, fields || {}); RF.redraw(true); };
  function renderSealed(id) {
    if (!G.receivingById(id)) return closedScreen();
    if (!how(id).mode) { RF.go("receive", "r", id); return null; }
    skFor(id);
    RF.stayAwake(true);
    if (sk.busy) return head("Book sealed", null) + '<div class="rf-empty">' + icon("refresh-cw") + esc(sk.busy) + "</div>";
    if (sk.step === "results") {
      return head("Book sealed", { act: "skAgain" }, String(sk.results.length)) +
        '<div class="rf-body"><p class="rf-text">' + esc(sk.q) + "</p>" +
        sk.results.map((p, i) => '<button class="rf-row" data-act="skPick" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(p.name) + "</div>" +
          '<div class="rf-row-sub">' + esc(String(p.setCode || "").toUpperCase()) + "</div></div>" + icon("arrow-right") + "</button>").join("") +
        '</div><div class="rf-actions"><button class="rf-btn" data-act="skAgain">' + icon("search") + " Search again</button></div>";
    }
    if (sk.step === "qty") {
      const p = sk.product;
      const where = how(id).mode === "tray" ? " into " + G.locName(bookingTray(id)) : "";
      return head("Book sealed", { act: "skBack" }, "How many") +
        '<div class="rf-body"><h2 class="rf-card-name">' + esc(p.name) + "</h2>" +
        cardBlock({ name: p.name, sealed: true, set: String(p.setCode || "").toUpperCase(), image: sealedImage(p.tcgplayerProductId) }) +
        '<div class="rf-stepper"><button data-act="skDown" title="One less" aria-label="One less">−</button>' +
        '<output aria-live="polite">' + sk.qty + '</output><button data-act="skUp" title="One more" aria-label="One more">+</button></div>' +
        msgBox(sk.msg) + "</div>" +
        '<div class="rf-actions"><button class="rf-btn gold" data-act="skBook">' + icon("check") + " Book " + sk.qty + esc(where) + "</button></div>";
    }
    if (sk.step === "booked") {
      const r = sk.last;
      return head("Booked", null) +
        '<div class="rf-body"><div class="rf-big">' + esc((r.qty > 1 ? "×" + r.qty + " " : "") + r.name) + "</div>" +
        '<div class="rf-msg ok">In ' + esc(r.bin) + " now, held until the desk closes the receipt.</div>" + msgBox(sk.msg) + "</div>" +
        '<div class="rf-actions"><button class="rf-btn gold" data-act="skNext">' + icon("plus") + " Next product</button>" +
        '<div class="rf-actions two" style="padding:0;position:static">' +
        (G.rfLineUndoable(r.lineId).ok ? '<button class="rf-btn danger" data-act="skUndo">' + icon("x") + " Undo</button>" : "") +
        '<a class="rf-btn" href="' + esc(RF.hashOf("receive", "r", id)) + '">Done</a></div></div>';
    }
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfSQ"); if (i) i.focus(); });
    return head("Book sealed", { act: "bkLeave" }) +
      '<div class="rf-body"><div class="rf-big">Which product?</div>' +
      '<input id="rfSQ" class="rf-input" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Product name" aria-label="Product name" data-enter="skFind" value="' + esc(sk.q) + '">' + msgBox(sk.msg) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="skFind">' + icon("search") + " Find it</button></div>";
  }
  RF.acts({
    skAgain: () => skStep("search", { results: [] }),
    skBack: () => skStep(sk.results.length ? "results" : "search"),
    skFind: async () => {
      const q = (RF.$("rfSQ") && RF.$("rfSQ").value || "").trim();
      if (q.length < 2 || sk.busy) return;
      sk.q = q;
      sk.busy = "Looking it up…";
      RF.redraw(true);
      let found = [];
      try { found = ((await G.api("/api/sealed/search?q=" + encodeURIComponent(q))).data || []); }
      catch (e) { sk.busy = false; skStep("search", { msg: "Couldn't look that up: " + (e.message || e) }); return; }
      sk.busy = false;
      // Only what the screen needs: the search's own market figure stays behind.
      const results = found.map(p => ({ tcgplayerProductId: p.tcgplayerProductId, manapoolProductId: p.manapoolProductId, name: p.name, setCode: p.setCode, marketPrice: p.marketPrice }));
      if (!results.length) { skStep("search", { msg: "No sealed product has that name." }); return; }
      skStep("results", { results });
    },
    skPick: d => { const p = sk.results[Number(d.i)]; if (p) skStep("qty", { product: p, qty: 1 }); },
    skDown: () => { sk.qty = Math.max(1, sk.qty - 1); RF.redraw(); },
    skUp: () => { sk.qty = Math.min(999, sk.qty + 1); RF.redraw(); },
    skBook: () => bookSealed(),
    skNext: () => skStep("search", { q: "", results: [], product: null, last: null }),
    skUndo: () => undoLine(sk.last.lineId, () => { sk.step = "search"; sk.msg = recMsg && recMsg.kind === "bad" ? recMsg.text : null; recMsg = null; RF.redraw(true); })
  });
  async function bookSealed() {
    if (sk.busy || !sk.product) return;
    const s = sk, product = sk.product, qty = sk.qty;
    s.busy = "Booking…";
    RF.redraw(true);
    const fail = text => { s.busy = false; if (sk === s) { RF.feedback("bad"); skStep("qty", { msg: text }); } };
    if (!await fresh()) return fail(NO_SIGNAL);
    if (!G.receivingById(s.rid)) { s.busy = false; RF.feedback("bad"); RF.redraw(true); return; }
    const trayId = bookingTray(s.rid);
    const res = G.rfBookSealed({ receivingId: s.rid, locationId: trayId, product, qty });
    if (!res.ok) return fail("That couldn't be booked.");
    G.persist("Booked in Warehouse Mode");
    G.saveNow();
    RF.feedback("ok");
    s.busy = false;
    const last = { lineId: res.line.id, qty, name: res.stack.name, bin: G.locName(trayId) };
    if (how(s.rid).mode === "bin") {
      startPut({ kind: "sealed", stackId: res.stack.id, trayId, rid: s.rid, lineId: res.line.id });
      sk.step = "search"; sk.q = ""; sk.last = last;
      RF.go("receive", "put", s.rid);
      return;
    }
    skStep("booked", { last });
  }

  /* ------------------------- Putting one stack away ------------------------- */
  /* Shared by card to bin and the Put away walk. pw: { kind, stackId, trayId, rid,
     lineId, toId (another bin the person chose), step: "put" | "other" | "tap",
     sub (keyReason, keyBin), reason, msg, busy, binQ }. The stop itself (which
     bin, how many) comes fresh from stock on every draw (core.js rfPutawayStops). */
  let pw = null;
  function startPut(o) {
    pw = Object.assign({ toId: null, step: "put", sub: null, reason: "", msg: null, busy: false, binQ: "", done: null }, o);
  }
  const pwSet = (fields) => { Object.assign(pw, { msg: null }, fields || {}); RF.redraw(true); };
  const stopNow = () => (pw ? G.rfPutawayStop(pw.trayId, pw.stackId) : null);
  const destOf = s => pw.toId || s.toId;
  // Another bin than suggested takes everything; the suggested one, its share.
  const qtyOf = s => (pw.toId && pw.toId !== s.toId ? s.movable : s.take);
  const workingWords = s => "Putting away " + copyName(s);

  function renderPutFor(rid) {
    if (!pw || pw.rid !== rid) { RF.go("receive", "r", rid); return null; }
    RF.stayAwake(true);
    const s = stopNow();
    if (!s) {
      // All of it filed (or someone else did): on to the next card.
      const done = pw.done;
      return head("Put away", null) + '<div class="rf-body">' +
        (done ? '<div class="rf-big">' + esc(done.words) + '</div><div class="rf-msg ok">In ' + esc(done.to) + " now, and logged.</div>" +
          (done.over ? '<div class="rf-msg warn">' + esc(done.to) + " is over its limit.</div>" : "")
          : '<div class="rf-empty">' + icon("circle-check") + "Nothing of this booking is left in " + esc(G.locName(pw.trayId)) + ".</div>") +
        '</div><div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("receive", pw.kind === "sealed" ? "sealed" : "card", rid)) + '">' + icon("plus") + " Book the next one</a>" +
        '<a class="rf-btn" href="' + esc(RF.hashOf("receive", "r", rid)) + '">Back to the receipt</a></div>';
    }
    return renderPut(s, { back: { act: "pwLeaveReceive" }, step: "To the bin" });
  }

  function renderPut(s, o) {
    if (pw.busy) return head("Put away", null) + '<div class="rf-empty">' + icon("refresh-cw") + "Checking the latest stock…</div>";
    if (pw.step === "other") return renderOther(s);
    const dest = destOf(s);
    if (pw.step === "tap" && dest) return renderTap(s, dest);
    if (pw.sub === "keyReason") return renderKeyReason(G.locName(dest));
    if (pw.sub === "keyBin") return renderKeyBin(G.locName(dest));
    const required = G.binScanRequired();
    const n = qtyOf(s);
    RF.scanning((text, viaCamera) => onPutScan(s, text, viaCamera));
    const undo = pw.lineId && G.rfLineUndoable(pw.lineId).ok;
    return head("Put away", o.back, o.step) +
      '<div class="rf-body">' +
      (pw.done ? '<div class="rf-msg ok" role="status">' + esc(pw.done.words) + " → " + esc(pw.done.to) + "</div>" : "") +
      '<h2 class="rf-card-name">' + esc(s.name) + "</h2>" + cardBlock(s) +
      '<p class="rf-text">Take <b>' + n + "</b> out of " + esc(s.bin) + "." +
      (s.receiving ? " On " + esc(s.receiving) + ", held until it closes." : "") + "</p>" +
      (dest ? '<div><div class="rf-eyebrow">' + (pw.toId && pw.toId !== s.toId ? "You chose" : "Put them in") + '</div><div class="rf-bin">' + esc(G.locName(dest)) + "</div></div>"
        : '<div class="rf-msg warn">' + (s.kind === "sealed" ? "This product isn't anywhere else yet" : "No Putaway rule takes this card") + ". Scan the bin it goes in, or choose one.</div>") +
      msgBox(pw.msg) +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock(dest ? (required ? "Scan the bin label" : "Or scan the bin label") : "Scan the bin it goes in") +
      "</div>" +
      '<div class="rf-actions">' +
      (dest ? (required
        ? RF.cameraButton(true) + '<button class="rf-btn" data-act="pwCantScan">' + icon("keyboard") + " Can't scan</button>"
        : '<button class="rf-btn gold" data-act="pwTap">' + icon("check") + " Put them in " + esc(G.locName(dest)) + "</button>" + RF.cameraButton(false))
        : RF.cameraButton(true)) +
      '<div class="rf-actions two" style="padding:0;position:static">' +
      '<button class="rf-btn" data-act="pwOther">' + icon("search") + (dest ? " Another bin" : " Choose a bin") + "</button>" +
      (o.skip ? '<button class="rf-btn quiet" data-act="pwSkip">Skip for now</button>' : "") +
      (undo ? '<button class="rf-btn danger" data-act="pwUndo">' + icon("x") + " Undo booking</button>" : "") +
      "</div></div>";
  }
  function onPutScan(s, text, viaCamera) {
    if (pw.busy) return;
    const loc = G.binFromLabel(text);
    if (!loc) { scanMsg(/^GRIMBIN:/i.test(text) ? "That label's bin isn't in this inventory." : "That isn't a bin label." + (G.binScanRequired() ? " Scan the bin, or press Can't scan." : "")); return; }
    if (loc.id === s.locationId) { scanMsg("That's " + loc.name + ", where they are now. Scan the bin they're going in."); return; }
    const dest = destOf(s);
    if (loc.id === dest) { RF.feedback("ok"); checked(s, "scanned"); return; }
    // Any other bin is fine, no reason needed (owner). A camera read can be a
    // neighbouring label: it only picks the bin, and a tap confirms it.
    pw.toId = loc.id;
    if (viaCamera) { RF.feedback("ok"); pwSet({ step: "tap" }); return; }
    RF.feedback("ok");
    checked(s, "scanned");
  }
  function renderTap(s, dest) {
    RF.scanning((text, viaCamera) => onPutScan(s, text, viaCamera));
    return head("Put away", { act: "pwNotThis" }, "To") +
      '<div class="rf-body"><div class="rf-text">' + esc(workingWords(s)) + "</div>" +
      '<div><div class="rf-eyebrow">The camera read</div><div class="rf-bin">' + esc(G.locName(dest)) + "</div></div>" +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      '<p class="rf-text">Is this the bin they\'re going in?</p></div>' +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="pwTapCamera">' + icon("check") + " Put them in " + esc(G.locName(dest)) + "</button>" +
      '<button class="rf-btn" data-act="pwNotThis">Not this bin</button></div>';
  }
  function renderOther(s) {
    const bins = G.rfBinList(pw.binQ).filter(b => b.id !== s.locationId);
    const shown = pw.binQ || bins.length <= BIN_LIST_MAX ? bins.slice(0, BIN_LIST_MAX * 2) : [];
    RF.hold(true);
    RF.scanning((text, viaCamera) => {
      if (!G.binFromLabel(text)) { scanMsg(/^GRIMBIN:/i.test(text) ? "That label's bin isn't in this inventory." : "That isn't a bin label."); return; }
      pw.step = "put";
      onPutScan(s, text, viaCamera);
    });
    return head("Another bin", { act: "pwOtherBack" }) +
      '<div class="rf-body"><div class="rf-text">' + esc(workingWords(s)) + "</div>" +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock("Scan the bin they're going in") +
      '<input id="rfBinQ" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Or type part of the bin name" aria-label="Bin name" value="' + esc(pw.binQ) + '" data-enter="pwBinSearch">' +
      (shown.length ? shown.map(b => '<button class="rf-row" data-act="pwPick" data-to="' + esc(b.id) + '"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(b.name) + '</div><div class="rf-row-sub">' + plural(b.cards, "card") + (b.sealed ? ", " + b.sealed + " sealed" : "") + "</div></div>" + icon("arrow-right") + "</button>").join("")
        : pw.binQ ? '<div class="rf-empty">' + icon("search") + "No other bin has that in its name.</div>"
        : '<div class="rf-text">Type part of the bin name to find it.</div>') +
      (shown.length && shown.length < bins.length ? '<div class="rf-msg warn">Showing ' + shown.length + " of " + bins.length + ". Type more of the name.</div>" : "") +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="pwBinSearch">' + icon("search") + " Find the bin</button>" + RF.cameraButton(false) + "</div>";
  }
  function renderKeyReason(binName) {
    return head("Can't scan", { act: "pwClearSub" }) +
      '<div class="rf-body"><div class="rf-big">Why can\'t you scan ' + esc(binName) + "?</div>" +
      '<p class="rf-text">This goes in the audit log.</p>' +
      G.BIN_KEY_REASONS.map(r => '<button class="rf-btn" data-act="pwKeyReason" data-reason="' + esc(r) + '">' + esc(r) + "</button>").join("") +
      '</div><div class="rf-actions"><button class="rf-btn quiet" data-act="pwClearSub">Go back</button></div>';
  }
  function renderKeyBin() {
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfKeyed"); if (i) i.focus(); });
    return head("Key the bin", { act: "pwClearSub" }) +
      '<div class="rf-body"><div class="rf-big">Type the name on the bin</div>' +
      '<p class="rf-text">' + esc(pw.reason) + ". Read it off the shelf, not this screen.</p>" + msgBox(pw.msg) +
      '<input id="rfKeyed" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="Bin name" aria-label="Bin name" data-enter="pwKeySubmit">' +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="pwKeySubmit">Confirm bin</button>' +
      '<button class="rf-btn quiet" data-act="pwClearSub">Go back</button></div>';
  }
  // The bin in front of the person is proven (scanned, tapped or keyed): file them.
  function checked(s, how) {
    if (pw.busy) return;
    const dest = destOf(s);
    if (!dest) return;
    if (how) G.logBinCheck(dest, how, workingWords(s));
    doPut(s, dest, qtyOf(s));
  }
  RF.acts({
    pwTap: () => {
      const s = stopNow();
      if (!s || G.binScanRequired() || !destOf(s) || pw.step !== "put") { RF.redraw(true); return; }
      checked(s, "tapped");
    },
    pwTapCamera: () => {
      const s = stopNow();
      if (!s || pw.step !== "tap" || !pw.toId) { RF.redraw(true); return; }
      checked(s, "scanned");
    },
    pwNotThis: () => pwSet({ step: "put", toId: null }),
    pwOther: () => pwSet({ step: "other", binQ: "" }),
    pwOtherBack: () => pwSet({ step: "put" }),
    pwBinSearch: () => { pw.binQ = (RF.$("rfBinQ").value || "").trim(); RF.redraw(true); },
    pwPick: d => { if (G.locById(d.to)) pwSet({ step: "put", toId: d.to }); },
    pwCantScan: () => pwSet({ sub: "keyReason" }),
    pwKeyReason: d => pwSet({ sub: "keyBin", reason: d.reason }),
    pwClearSub: () => pwSet({ sub: null }),
    pwKeySubmit: () => {
      const s = stopNow();
      if (!s) { RF.redraw(true); return; }
      const dest = destOf(s);
      const res = G.keyBin(dest, RF.$("rfKeyed").value, pw.reason, workingWords(s));
      if (!res.ok) { RF.feedback("bad"); pwSet({ sub: "keyBin", msg: "That's not the right bin. Check the shelf: you should be at " + G.locName(dest) + "." }); return; }
      pw.sub = null;
      G.persist("Bin keyed in Warehouse Mode");
      checked(s, null);
    },
    pwLeaveReceive: () => { const rid = pw && pw.rid; pw = null; RF.go("receive", "r", rid || ""); },
    pwUndo: () => undoLine(pw.lineId, () => {
      const rid = pw.rid, kind = pw.kind, bad = recMsg && recMsg.kind === "bad";
      if (bad) { pw.msg = recMsg.text; recMsg = null; RF.redraw(true); return; }
      pw = null; recMsg = null;
      RF.go("receive", kind === "sealed" ? "sealed" : "card", rid);
    })
  });

  /* Into the bin, right now: nothing sits in transit. The latest stock first;
     a bin over its limit is the big confirm with the room left, never a refusal. */
  async function doPut(s, dest, qty) {
    if (pw.busy) return;
    const p = pw;
    p.busy = true;
    RF.redraw(true);
    let next;
    try { next = await attempt(p, s, dest, qty); }
    catch (e) { next = () => { RF.feedback("bad"); pwSet({ step: "put", toId: null, msg: "Couldn't put them away: " + (e.message || e) }); }; }
    p.busy = false;
    if (pw === p) next();
  }
  async function attempt(p, s, dest, qty) {
    if (!await fresh()) return () => { RF.feedback("bad"); pwSet({ step: "put", msg: "Couldn't check the latest stock, so nothing moved. Check the signal and try again." }); };
    let check = G.rfPutawayCheck(s.kind, s.id, dest, qty);
    if (!check.ok) {
      if (check.problem === "gone") return () => { RF.feedback("bad"); RF.redraw(true); };
      // Fewer here than the screen said: draw the stop again from what's there now.
      return () => { RF.feedback("bad"); pwSet({ step: "put", toId: null, msg: check.problem === "too-many" ? "Someone changed these copies. Count what's in the tray against this screen." : "They can't go in that bin." }); };
    }
    const to = G.locName(dest);
    if (check.over) {
      RF.feedback("bad");
      const room = check.free === 0 ? to + " is full" : to + " only has room for " + check.free + " more";
      const ok = await RF.confirm({ title: "Over the limit", body: room + " (limit " + check.cap + "), and you're putting " + qty + " in " + to + ". Put them in anyway?",
        ok: "Put them in anyway", cancel: "Go back", danger: true });
      if (!ok) return () => pwSet({ step: "put", toId: null });
      check = G.rfPutawayCheck(s.kind, s.id, dest, qty);
      if (!check.ok) return () => RF.redraw(true);
    }
    const done = G.rfPutaway(s.kind, s.id, dest, qty, s.toId);
    if (!done.ok) return () => RF.redraw(true);
    G.persist("Put away in Warehouse Mode");
    G.saveNow();
    return () => {
      RF.feedback("ok");
      pw.done = { words: times(qty, s), to, over: check.over };
      pwSet({ step: "put", toId: null, sub: null });
    };
  }

  /* ------------------------- Put away: trays ------------------------- */
  RF.screen("putaway", p => (p[0] === "tray" ? renderTray(p[1] || "") : renderTrays()));
  function renderTrays() {
    RF.stayAwake(false);
    RF.refreshSoon();
    const trays = G.rfPutawayTrays();
    RF.scanning(text => {
      const loc = G.binFromLabel(text);
      if (!loc) { scanMsg(/^GRIMBIN:/i.test(text) ? "That label's bin isn't in this inventory." : "That isn't a bin label."); return; }
      if (!loc.staging) { scanMsg(loc.name + " isn't a sorting tray."); return; }
      RF.feedback("ok");
      RF.go("putaway", "tray", loc.id);
    });
    return head("Put away", "home") + '<div class="rf-body">' +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      (trays.length ? RF.scanBlock("Scan a tray, or choose one") + trays.map(t => '<a class="rf-row" href="' + esc(RF.hashOf("putaway", "tray", t.id)) + '"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(t.name) + "</div>" +
        '<div class="rf-row-sub">' + plural(t.items, "item") + " to put away" + (t.held ? ", " + t.held + " on open receipts" : "") + "</div></div>" + icon("arrow-right") + "</a>").join("")
        : '<div class="rf-empty">' + icon("circle-check") + "Every sorting tray is empty.</div>") +
      "</div>" + (trays.length ? '<div class="rf-actions">' + RF.cameraButton(false) + "</div>" : "");
  }
  /* The walk: the tray's stops in walk order of where they go. Skip sends a
     stop to the end for this walk; reload and it's back in its place. */
  let walk = null;
  function renderTray(trayId) {
    if (!walk || walk.trayId !== trayId) walk = { trayId, skipped: [] };
    RF.stayAwake(true);
    const t = G.rfPutawayStops(trayId);
    if (!t) return head("Not found", "putaway") + '<div class="rf-empty">' + icon("triangle-alert") + "That tray isn't in this inventory.</div>";
    walk.skipped = walk.skipped.filter(id => t.stops.some(s => s.id === id));
    const order = t.stops.filter(s => !walk.skipped.includes(s.id)).concat(walk.skipped.map(id => t.stops.find(s => s.id === id)));
    const s = order[0];
    if (!s) {
      const done = pw && pw.trayId === trayId && !pw.rid ? pw.done : null;
      RF.stayAwake(false);
      return head(t.name, "putaway") + '<div class="rf-body">' +
        (done ? '<div class="rf-msg ok">' + esc(done.words) + " → " + esc(done.to) + "</div>" : "") +
        '<div class="rf-empty">' + icon("circle-check") + "Everything in " + esc(t.name) + " is put away.</div></div>" +
        '<div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("putaway")) + '">Other trays</a></div>';
    }
    if (!pw || pw.rid || pw.trayId !== trayId || pw.stackId !== s.id) {
      const done = pw && !pw.rid && pw.trayId === trayId ? pw.done : null;
      startPut({ kind: s.kind, stackId: s.id, trayId, rid: null, lineId: null, done });
    }
    return renderPut(s, { back: "putaway", step: plural(order.length, "stop") + " left", skip: order.length > 1 });
  }
  RF.acts({
    pwSkip: () => {
      if (!walk || !pw) return;
      walk.skipped = walk.skipped.filter(id => id !== pw.stackId).concat([pw.stackId]);
      pw = null;
      RF.redraw(true);
    }
  });
})();
