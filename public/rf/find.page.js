"use strict";
/* Warehouse Mode: find and move cards (#387). Flow: docs/flows/rf-move.dot.
   Look a card up by name to see every bin it's in, or look in a bin (scan its
   label, or choose it by name), and move copies from one bin to another: from
   bin, card, quantity, to bin, done. The book changes the moment the to-bin is
   confirmed, so nothing sits in transit. Stock logic is core.js (rfFindCards,
   rfCardWhere, rfBinView, rfMoveCards -> the desk's own moveCopies).

   A bin check follows the account's Require bin scan setting, like the pick
   walk: off, a tap confirms it; on, a scan or a typed bin with a reason; a scan
   works either way and a wrong bin is always refused.

   Routes: #find, #find/search/<text>, #find/card/<printing>, #find/bins,
   #find/bin/<id>, #find/move/<stack id>. */
(function () {
  const { esc, icon, head } = RF;
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const BIN_LIST_MAX = 12;
  const copies = n => n + (n === 1 ? " copy" : " copies");

  RF.job({ id: "find", label: "Find and move", icon: "search", count: () => null });

  /* ------------------------- Words for a copy ------------------------- */
  function cardChips(c) {
    const out = [];
    if (c.finish && c.finish !== "nonfoil") out.push('<span class="rf-tag warn">' + esc(G.FINISH_NAMES[c.finish] || c.finish) + "</span>");
    if (c.lang && c.lang !== "en") out.push('<span class="rf-tag warn">' + esc(String(c.lang).toUpperCase()) + "</span>");
    if (c.condition) out.push('<span class="rf-tag">' + esc(c.condition) + "</span>");
    return out.join(" ");
  }
  const printing = c => [c.set, c.collector ? "#" + c.collector : ""].filter(Boolean).join(" ");
  const copyWord = c => [c.condition, c.finish && c.finish !== "nonfoil" ? (G.FINISH_NAMES[c.finish] || c.finish) : "",
    c.lang && c.lang !== "en" ? String(c.lang).toUpperCase() : ""].filter(Boolean).join(" ");
  const copyName = c => [copyWord(c), c.name].filter(Boolean).join(" ");
  const back = () => { if (history.length > 1) history.back(); else RF.go("find"); };
  RF.acts({ back });

  /* ------------------------- Where one stack is, and what's left of its book ------------------------- */
  /* The shelf count first, then the rest of the book beside it, so the book
     adds up for whoever is standing at the bin. Only the shelf copies can move. */
  function stackRow(s, byBin) {
    const lines = ['<div class="rf-row-sub"><b>' + copies(s.onShelf) + " on the shelf</b></div>"];
    if (s.inTote) lines.push('<div class="rf-row-sub">' + esc(s.toteWords) + "</div>");
    if (s.lent) lines.push('<div class="rf-row-sub">' + s.lent + " lent</div>");
    if (s.receiving) lines.push('<div class="rf-row-sub">On ' + esc(s.receiving) + ", not for picking until it closes</div>");
    return '<div class="rf-row stack"><div class="rf-row-main">' +
      '<div class="rf-row-title">' + esc(byBin ? s.bin : s.name) + "</div>" +
      '<div class="rf-row-sub">' + esc(printing(s)) + "</div>" +
      '<div class="rf-chips" style="margin:4px 0">' + cardChips(s) + "</div>" + lines.join("") + "</div>" +
      (s.onShelf > 0 ? '<button class="rf-btn gold" data-act="startMove" data-id="' + esc(s.id) + '">' + icon("arrow-right") + " Move</button>" : "") +
      (!byBin ? '<a class="rf-btn" href="' + esc(RF.hashOf("find", "card", s.printing)) + '">Where else</a>' : "") +
      "</div>";
  }

  /* ------------------------- Start ------------------------- */
  RF.screen("find", p => {
    if (p[0] === "search") return renderResults(p[1] || "");
    if (p[0] === "card") return renderCard(p[1] || "");
    if (p[0] === "bins") return renderBins();
    if (p[0] === "bin") return renderBin(p[1] || "");
    if (p[0] === "move") return renderMove(p[1] || "");
    return renderStart();
  });

  function renderStart() {
    RF.stayAwake(false);
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfQ"); if (i) i.focus(); });
    return head("Find and move", "home") +
      '<div class="rf-body"><div class="rf-big">Which card?</div>' +
      '<input id="rfQ" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Card name" aria-label="Card name" data-enter="search"></div>' +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="search">' + icon("search") + " Find it</button>" +
      '<a class="rf-btn" href="' + esc(RF.hashOf("find", "bins")) + '">' + icon("qr-code") + " Look in a bin</a></div>";
  }
  RF.acts({
    search: () => {
      const q = (RF.$("rfQ").value || "").trim();
      if (q) RF.go("find", "search", q);
    }
  });

  function renderResults(q) {
    RF.hold(false);
    const found = G.rfFindCards(q);
    return head("Find", { act: "back" }, found.printings.length ? String(found.printings.length) + (found.more ? "+" : "") : "") +
      '<div class="rf-body"><p class="rf-text">' + esc(q) + "</p>" +
      (found.printings.length
        ? found.printings.map(c => '<a class="rf-row" href="' + esc(RF.hashOf("find", "card", c.printing)) + '"><div class="rf-row-main">' +
          '<div class="rf-row-title">' + esc(c.name) + "</div>" +
          '<div class="rf-row-sub">' + esc(printing(c)) + " · " + copies(c.copies) + " in " + plural(c.bins, "bin") + "</div></div>" +
          icon("arrow-right") + "</a>").join("") +
        (found.more ? '<div class="rf-msg warn">Only the first ' + found.printings.length + " are shown. Add the set code or number.</div>" : "")
        : '<div class="rf-empty">' + icon("search") + "No card here has that name. Sealed product isn't searched here.</div>") +
      '</div><div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("find")) + '">Search again</a></div>';
  }

  function renderCard(key) {
    RF.hold(false);
    const c = G.rfCardWhere(key);
    if (!c.found) {
      return head("Not found", { act: "back" }) + '<div class="rf-empty">' + icon("triangle-alert") + "None of this card is in stock any more.</div>";
    }
    return head(c.name, { act: "back" }) +
      '<div class="rf-body"><div class="rf-card-sub">' + esc(printing(c)) + "</div>" +
      '<p class="rf-text">' + copies(c.book) + " in the book, in " + plural(c.bins, "bin") + ". " +
      c.onShelf + " on the shelf.</p>" +
      c.stacks.map(s => stackRow(s, true)).join("") + "</div>";
  }

  /* ------------------------- Bins ------------------------- */
  let binQ = "";
  function renderBins() {
    RF.stayAwake(false);
    const bins = G.rfBinList(binQ);
    const shown = binQ || bins.length <= BIN_LIST_MAX ? bins.slice(0, BIN_LIST_MAX * 2) : [];
    RF.hold(true);
    RF.scanning(text => {
      const loc = G.binFromLabel(text);
      if (loc) { RF.feedback("ok"); RF.go("find", "bin", loc.id); return; }
      RF.feedback("bad");
      const box = RF.$("rfScanMsg");
      box.textContent = /^GRIMBIN:/i.test(text) ? "That label's bin isn't in this inventory." : "That isn't a bin label.";
      box.hidden = false;
    });
    return head("Look in a bin", "find") +
      '<div class="rf-body">' +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock("Scan a bin label") +
      '<input id="rfBinQ" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Or type part of the bin name" aria-label="Bin name" value="' + esc(binQ) + '" data-enter="binSearch">' +
      (shown.length ? shown.map(binRow).join("")
        : binQ ? '<div class="rf-empty">' + icon("search") + "No bin has that in its name.</div>"
        : '<div class="rf-text">' + plural(bins.length, "bin") + ". Type part of a name to find one.</div>") +
      (shown.length && shown.length < bins.length ? '<div class="rf-msg warn">Showing ' + shown.length + " of " + bins.length + ". Type more of the name.</div>" : "") +
      "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="binSearch">' + icon("search") + " Find the bin</button>" + RF.cameraButton(false) + "</div>";
  }
  const binWords = b => plural(b.cards, "card") + (b.sealed ? ", " + b.sealed + " sealed" : "");
  const binRow = b => '<a class="rf-row" href="' + esc(RF.hashOf("find", "bin", b.id)) + '"><div class="rf-row-main">' +
    '<div class="rf-row-title">' + esc(b.name) + '</div><div class="rf-row-sub">' + binWords(b) + "</div></div>" + icon("arrow-right") + "</a>";
  RF.acts({
    binSearch: () => { binQ = (RF.$("rfBinQ").value || "").trim(); RF.redraw(true); }
  });

  /* A big bin draws only its first stacks (core.js rfBinView), and says so: type a card
     name to narrow it. This build is cards only: sealed product in the bin
     is named, never "nothing", and moved at the desk (follow-up #404). */
  let binCardQ = "", binCardFor = "";
  function renderBin(id) {
    if (binCardFor !== id) { binCardFor = id; binCardQ = ""; }
    RF.hold(true);
    const b = G.rfBinView(id, binCardQ);
    if (!b) return head("Not found", { act: "back" }) + '<div class="rf-empty">' + icon("triangle-alert") + "That bin isn't in this inventory.</div>";
    const room = b.cap == null ? "No limit." : "Limit " + b.cap + ", room for " + b.free + " more.";
    const sealed = b.sealed
      ? '<div class="rf-msg warn">' + (b.stackCount ? "" : "No cards here. ") + b.sealed + " sealed in this bin. Move sealed at the desk.</div>" : "";
    const empty = b.stackCount ? '<div class="rf-empty">' + icon("search") + "No card in this bin has that name.</div>"
      : b.sealed ? "" : '<div class="rf-empty">' + icon("inbox") + "Nothing in this bin.</div>";
    return head(b.name, { act: "back" }) +
      '<div class="rf-body"><p class="rf-text">' + plural(b.cards, "card") + " in " + plural(b.stackCount, "stack") + ". " + esc(room) + "</p>" + sealed +
      (b.stackCount > 8 || binCardQ ? '<input id="rfCardQ" class="rf-input" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" ' +
        'placeholder="Card name, set code or number" aria-label="Card name" value="' + esc(binCardQ) + '" data-enter="binCardSearch">' : "") +
      (b.stacks.length ? b.stacks.map(s => stackRow(s, false)).join("") : empty) +
      (b.more ? '<div class="rf-msg warn">Showing the first ' + b.stacks.length + " of " + b.matching + " stacks. Add the set code or number to narrow it.</div>" : "") +
      (b.stackCount > 8 || binCardQ ? '</div><div class="rf-actions"><button class="rf-btn gold" data-act="binCardSearch">' + icon("search") + " Narrow it</button></div>" : "</div>");
  }
  RF.acts({
    binCardSearch: () => { binCardQ = (RF.$("rfCardQ").value || "").trim(); RF.redraw(true); }
  });

  /* ------------------------- The move ------------------------- */
  /* Where this phone is in a move. Nothing here is stock: reload and it starts
     the move over at the from bin. step: from, qty, to, toCheck, done. */
  let mv = null;
  function mvFor(id) {
    if (!mv || mv.id !== id) {
      mv = { id, step: "from", sub: null, qty: 1, toId: null, binQ: "", reason: "", msg: null, busy: false, result: null, key: "" };
    }
    return mv;
  }
  function setStep(step, fields) {
    mv.step = step;
    mv.sub = null;
    Object.assign(mv, fields || {});
    RF.redraw(true);
  }
  function setSub(sub, fields) { mv.sub = sub; Object.assign(mv, fields || {}); RF.redraw(true); }
  const working = s => "Moving " + copyName(s);

  RF.acts({
    startMove: d => { mv = null; RF.go("find", "move", d.id); },
    leaveMove: () => { mv = null; back(); }
  });

  function renderMove(id) {
    RF.stayAwake(true);
    mvFor(id);
    if (mv.step === "done") return renderDone();
    if (mv.busy) {
      return head("Move", null) + '<div class="rf-empty">' + icon("refresh-cw") + "Checking the latest stock…</div>";
    }
    const s = G.rfStack(id);
    if (!s) {
      return head("Move", { act: "leaveMove" }) + '<div class="rf-empty">' + icon("triangle-alert") +
        "These copies aren't in that bin any more. Someone may have moved them.</div>" +
        '<div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("find")) + '">Find again</a></div>';
    }
    if (!s.onShelf) {
      return head("Move", { act: "leaveMove" }) + '<div class="rf-empty">' + icon("triangle-alert") +
        "None of these can move now. They're in a tote or lent out.</div>";
    }
    if (mv.step === "from") return renderCheck(s, s.locationId, s.bin, "Go to");
    if (mv.step === "qty") return renderQty(s);
    if (mv.step === "to") return renderTo(s);
    const to = G.locById(mv.toId);
    if (!to) { mv.step = "to"; return renderTo(s); }
    if (mv.step === "toTap") return renderTap(s, to);
    return renderCheck(s, to.id, to.name, "Move them to");
  }

  /* One bin check, used for the from bin and the to bin. */
  function renderCheck(s, locationId, binName, eyebrow) {
    if (mv.sub === "keyReason") return renderKeyReason(binName);
    if (mv.sub === "keyBin") return renderKeyBin(binName);
    const to = mv.step === "toCheck";
    const required = G.binScanRequired();
    RF.scanning(text => onCheckScan(s, locationId, text));
    return head("Move", { act: to ? "toBack" : "leaveMove" }, to ? "To" : "From") +
      '<div class="rf-body">' +
      (to ? '<div class="rf-text">' + esc(summary(s)) + "</div>" : "") +
      '<div><div class="rf-eyebrow">' + esc(eyebrow) + '</div><div class="rf-bin">' + esc(binName) + "</div>" +
      (to ? "" : '<div class="rf-text">' + esc(copyName(s)) + "</div>") + "</div>" +
      (mv.msg ? '<div class="rf-msg bad" role="alert">' + esc(mv.msg) + "</div>" : "") +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock(required ? "Scan the bin label" : "Or scan the bin label") +
      "</div>" +
      '<div class="rf-actions">' +
      (required
        ? RF.cameraButton(true) + '<button class="rf-btn" data-act="mvCantScan">' + icon("keyboard") + " Can't scan</button>"
        : '<button class="rf-btn gold" data-act="mvAtBin">' + icon("check") + (to ? " Put them in " + esc(binName) : " At this bin") + "</button>" + RF.cameraButton(false)) +
      "</div>";
  }
  /* The camera read a bin label at the to step. It can be a neighbouring label drifting
     into view, so it only picks the bin: one tap confirms it. (A scanner's trigger, a
     deliberate act, moves at once.) A scan of this bin's own label still goes straight on. */
  function renderTap(s, to) {
    RF.scanning(text => onCheckScan(s, to.id, text));
    return head("Move", { act: "toBack" }, "To") +
      '<div class="rf-body"><div class="rf-text">' + esc(summary(s)) + "</div>" +
      '<div><div class="rf-eyebrow">The camera read</div><div class="rf-bin">' + esc(to.name) + "</div></div>" +
      (mv.msg ? '<div class="rf-msg bad" role="alert">' + esc(mv.msg) + "</div>" : "") +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      '<p class="rf-text">Is this the bin they\'re going into?</p></div>' +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="mvTapTo">' + icon("check") + " Put them in " + esc(to.name) + "</button>" +
      '<button class="rf-btn" data-act="toBack">Not this bin</button></div>';
  }
  RF.acts({
    mvTapTo: () => {
      const s = G.rfStack(mv && mv.id);
      if (!s || mv.busy || mv.step !== "toTap" || !G.locById(mv.toId)) { RF.redraw(true); return; }
      G.logBinCheck(mv.toId, "scanned", working(s));
      doMove(s);
    }
  });
  const summary = s => "Moving " + mv.qty + " × " + copyName(s) + " from " + s.bin;
  function badScan(check, binName) {
    RF.feedback("bad");
    const msg = check.problem === "wrong-bin" ? "Wrong bin. That's " + check.scanned.name + ". Go to " + binName + "."
      : check.problem === "unknown-bin" ? "That label's bin isn't in this inventory. Go to " + binName + "."
      : "That isn't a bin label. Scan the label on " + binName + (G.binScanRequired() ? ", or press Can't scan." : ", or use the button below.");
    const box = RF.$("rfScanMsg");
    box.textContent = msg;
    box.hidden = false;
  }
  function onCheckScan(s, locationId, text) {
    if (mv.busy) return;
    const check = G.checkBinScan(locationId, text);
    if (!check.ok) { badScan(check, G.locName(locationId)); return; }
    checked(s, "scanned");
  }
  // The bin in front of the person is proven (scanned, tapped or keyed): on to the next step.
  function checked(s, how) {
    if (mv.busy) return;
    if (mv.step === "from") {
      RF.feedback("ok");
      if (how) G.logBinCheck(s.locationId, how, working(s));
      G.persist("Bin checked in Warehouse Mode");
      setStep("qty", { msg: null, qty: Math.min(Math.max(1, mv.qty), s.onShelf) });
    } else {
      if (how) G.logBinCheck(mv.toId, how, working(s));
      doMove(s);
    }
  }
  RF.acts({
    mvAtBin: () => {
      const s = G.rfStack(mv && mv.id);
      if (!s || G.binScanRequired() || (mv.step !== "from" && mv.step !== "toCheck")) { RF.redraw(true); return; }
      checked(s, "tapped");
    },
    mvCantScan: () => setSub("keyReason", { msg: null }),
    mvKeyReason: d => setSub("keyBin", { reason: d.reason, msg: null }),
    mvClearSub: () => setSub(null, { msg: null }),
    toBack: () => setStep("to", { toId: null, msg: null })
  });

  function renderKeyReason(binName) {
    return head("Can't scan", { act: "mvClearSub" }) +
      '<div class="rf-body"><div class="rf-big">Why can\'t you scan ' + esc(binName) + "?</div>" +
      '<p class="rf-text">This goes in the audit log.</p>' +
      G.BIN_KEY_REASONS.map(r => '<button class="rf-btn" data-act="mvKeyReason" data-reason="' + esc(r) + '">' + esc(r) + "</button>").join("") +
      '</div><div class="rf-actions"><button class="rf-btn quiet" data-act="mvClearSub">Go back</button></div>';
  }
  function renderKeyBin() {
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfKeyed"); if (i) i.focus(); });
    return head("Key the bin", { act: "mvClearSub" }) +
      '<div class="rf-body"><div class="rf-big">Type the name on the bin</div>' +
      '<p class="rf-text">' + esc(mv.reason) + ". Read it off the shelf, not this screen.</p>" +
      (mv.msg ? '<div class="rf-msg bad" role="alert">' + esc(mv.msg) + "</div>" : "") +
      '<input id="rfKeyed" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="Bin name" aria-label="Bin name" data-enter="mvKeySubmit">' +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="mvKeySubmit">Confirm bin</button>' +
      '<button class="rf-btn quiet" data-act="mvClearSub">Go back</button></div>';
  }
  RF.acts({
    mvKeySubmit: () => {
      const s = G.rfStack(mv && mv.id);
      if (!s) { RF.redraw(true); return; }
      const expected = mv.step === "from" ? s.locationId : mv.toId;
      const res = G.keyBin(expected, RF.$("rfKeyed").value, mv.reason, working(s));
      if (!res.ok) {
        RF.feedback("bad");
        setSub("keyBin", { msg: "That's not the right bin. Check the shelf: you should be at " + G.locName(expected) + "." });
        return;
      }
      G.persist("Bin keyed in Warehouse Mode");
      checked(s, null);
    }
  });

  /* ------------------------- How many ------------------------- */
  function renderQty(s) {
    const left = s.book - s.onShelf;
    const art = s.image ? G.artCropUrl(s.image) : "";
    return head("Move", { act: "leaveMove" }, "How many") +
      '<div class="rf-body"><h2 class="rf-card-name">' + esc(s.name) + "</h2>" +
      // A small picture (tap it for the large photo): the how-many control must stay in reach on a small phone.
      '<div class="rf-card compact">' +
      (s.image
        ? '<button class="rf-photo" data-act="photo" data-url="' + esc(RF.largeImage(s.image)) + '" title="Show a large photo" aria-label="Show a large photo">' +
          '<img src="' + esc(s.image) + '" alt=""></button>'
        : '<div class="rf-photo"><div class="rf-nophoto">' + icon("package") + "</div></div>") +
      '<div class="rf-card-side">' +
      (art ? '<img class="rf-art" src="' + esc(art) + '" alt="">' : "") +
      '<div class="rf-card-sub">' + esc(printing(s)) + "</div>" +
      '<div class="rf-chips">' + cardChips(s) + "</div></div></div>" +
      '<div class="rf-stepper">' +
      '<button data-act="qtyDown" title="One less" aria-label="One less">−</button>' +
      '<output aria-live="polite">' + mv.qty + "</output>" +
      '<button data-act="qtyUp" title="One more" aria-label="One more">+</button></div>' +
      (s.onShelf > 1 ? '<button class="rf-btn quiet" data-act="qtyAll">All ' + s.onShelf + "</button>" : "") +
      (mv.msg ? '<div class="rf-msg bad" role="alert">' + esc(mv.msg) + "</div>" : "") +
      '<p class="rf-text">How many ' + esc(copyWord(s) || "copies") + " out of " + esc(s.bin) + "? " + copies(s.onShelf) + " on the shelf.</p>" +
      (left ? '<div class="rf-msg warn">' + (s.inTote ? esc(s.toteWords) + ". " : "") + (s.lent ? s.lent + " lent. " : "") + "Those can't move.</div>" : "") +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="qtyNext">' + icon("arrow-right") + " Next: where to</button></div>";
  }
  RF.acts({
    qtyDown: () => { mv.qty = Math.max(1, mv.qty - 1); RF.redraw(); },
    qtyUp: () => { const s = G.rfStack(mv.id); mv.qty = Math.min(s ? s.onShelf : mv.qty, mv.qty + 1); RF.redraw(); },
    qtyAll: () => { const s = G.rfStack(mv.id); if (s) mv.qty = s.onShelf; RF.redraw(); },
    qtyNext: () => setStep("to", { msg: null, toId: null })
  });

  /* ------------------------- Where to ------------------------- */
  /* A scan of the to bin's label is the check and the choice at once. Without a
     label, choose the bin by name; then it takes the same check as any bin. */
  function renderTo(s) {
    const bins = G.rfBinList(mv.binQ).filter(b => b.id !== s.locationId);
    const shown = mv.binQ || bins.length <= BIN_LIST_MAX ? bins.slice(0, BIN_LIST_MAX * 2) : [];
    RF.hold(true);
    RF.scanning((text, viaCamera) => {
      if (mv.busy) return;
      const loc = G.binFromLabel(text);
      if (!loc) { RF.feedback("bad"); toMsg(/^GRIMBIN:/i.test(text) ? "That label's bin isn't in this inventory." : "That isn't a bin label."); return; }
      if (loc.id === s.locationId) { RF.feedback("bad"); toMsg("That's the bin they're in. Scan the bin they're going to."); return; }
      mv.toId = loc.id;
      if (viaCamera) { RF.feedback("ok"); setStep("toTap", { msg: null }); return; }
      checked(G.rfStack(mv.id) || s, "scanned");
    });
    return head("Move", { act: "backToQty" }, "To") +
      '<div class="rf-body"><div class="rf-big">' + esc(summary(s)) + "</div>" +
      (mv.msg ? '<div class="rf-msg bad" role="alert">' + esc(mv.msg) + "</div>" : "") +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock("Scan the bin they're going to") +
      '<input id="rfBinQ" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Or type part of the bin name" aria-label="Bin name" value="' + esc(mv.binQ) + '" data-enter="toSearch">' +
      (shown.length ? shown.map(b => '<button class="rf-row" data-act="pickTo" data-to="' + esc(b.id) + '"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(b.name) + '</div><div class="rf-row-sub">' + plural(b.cards, "card") + "</div></div>" + icon("arrow-right") + "</button>").join("")
        : mv.binQ ? '<div class="rf-empty">' + icon("search") + "No other bin has that in its name.</div>"
        : '<div class="rf-text">Type part of the bin name to find it.</div>') +
      (shown.length && shown.length < bins.length ? '<div class="rf-msg warn">Showing ' + shown.length + " of " + bins.length + ". Type more of the name.</div>" : "") +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="toSearch">' + icon("search") + " Find the bin</button>" + RF.cameraButton(false) + "</div>";
  }
  function toMsg(text) {
    const box = RF.$("rfScanMsg");
    box.textContent = text;
    box.hidden = false;
  }
  RF.acts({
    backToQty: () => setStep("qty", { msg: null }),
    toSearch: () => { mv.binQ = (RF.$("rfBinQ").value || "").trim(); mv.msg = null; RF.redraw(true); },
    pickTo: d => {
      if (!G.locById(d.to)) { RF.redraw(true); return; }
      setStep("toCheck", { toId: d.to, msg: null });
    }
  });

  /* ------------------------- Do it ------------------------- */
  /* The to bin is confirmed: the book changes now. Looks at the latest first
     (a desk or another phone may have moved or pulled these), and a bin over
     its limit gets the big confirm with how much room is left. */
  async function doMove(s) {
    if (mv.busy) return;
    const m = mv, toId = mv.toId, qty = mv.qty;   // what was confirmed is what gets booked
    m.busy = true;
    RF.redraw(true);   // "Checking..." while the latest stock comes in
    let next;
    try { next = await attempt(m, s, toId, qty); }
    catch (e) { next = () => { RF.feedback("bad"); setStep("to", { toId: null, msg: "Couldn't move them: " + (e.message || e) }); }; }
    m.busy = false;
    if (mv === m) next();
  }
  // Returns what to do once the screen is free again.
  async function attempt(m, s, toId, qty) {
    const caught = await G.catchUp();
    if (!caught.ok) return () => { RF.feedback("bad"); setStep("to", { toId: null, msg: "Couldn't check the latest stock, so nothing moved. Check the signal and try again." }); };
    let check = G.rfMoveCheck(s.id, toId, qty);
    if (!check.ok) {
      if (check.problem === "gone") return () => { RF.feedback("bad"); RF.redraw(true); };
      const text = check.problem === "too-many" ? "Only " + check.movable + " can move now. Someone changed these copies." : "That can't move to that bin.";
      return () => { RF.feedback("bad"); setStep("qty", { toId: null, msg: text, qty: Math.max(1, Math.min(qty, check.movable)) }); };
    }
    const to = G.locName(toId);
    if (check.over) {
      RF.feedback("bad");
      const room = check.free === 0 ? to + " is full" : to + " only has room for " + check.free + " more";
      const ok = await RF.confirm({
        title: "Over the limit",
        body: room + " (limit " + check.cap + "), and you're putting " + qty + " in " + to + ". Move them anyway?",
        ok: "Move anyway", cancel: "Go back", danger: true });
      if (!ok) return () => setStep("to", { toId: null, msg: null });
      check = G.rfMoveCheck(s.id, toId, qty);
      if (!check.ok) return () => RF.redraw(true);
    }
    const done = G.rfMoveCards(s.id, toId, qty);
    if (!done.ok) return () => RF.redraw(true);
    G.persist("Moved in Warehouse Mode");
    G.saveNow();
    return () => { RF.feedback("ok"); setStep("done", { result: Object.assign({ name: copyName(s), printing: s.printing, over: check.over }, done) }); };
  }

  function renderDone() {
    const r = mv.result;
    RF.stayAwake(false);
    return head("Moved", null) +
      '<div class="rf-body"><div class="rf-big">' + (r.moved > 1 ? "×" + r.moved + " " : "") + esc(r.name) + "</div>" +
      '<div class="rf-text">' + esc(r.from) + " → " + esc(r.to) + "</div>" +
      '<div class="rf-msg ok">It\'s on the book in ' + esc(r.to) + " now, and logged.</div>" +
      (r.merged ? '<div class="rf-text">It joined a matching stack already in ' + esc(r.to) + ".</div>" : "") +
      (r.over ? '<div class="rf-msg warn">' + esc(r.to) + " is over its limit.</div>" : "") +
      '</div><div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("find")) + '">Find another card</a>' +
      '<a class="rf-btn" href="' + esc(RF.hashOf("find", "card", r.printing)) + '">Where is it now</a></div>';
  }
})();
