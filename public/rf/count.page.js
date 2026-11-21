"use strict";
/* Warehouse Mode: cycle count (#389). Flow: docs/flows/rf-count.dot.
   A blind count of one bin. The list is what's waiting: bins a short pick
   flagged, then bins the desk sent to the floor (Cycle Count > Send to the
   floor); with nothing waiting, Count next bin takes the most overdue one from
   the rotation. At the bin the counter walks each stack the book has there,
   one screen each (the item, never the number), and types how many. A count
   that differs from the book is asked for once more; a second count that still
   differs is the one posted. "Found a card not on the list" adds what the book
   doesn't have. Done posts through the desk's own full count (core.js
   rfCountPost), which stamps the bin counted and takes it off the list, a clean
   count and an empty bin included. Cards and sealed are counted apart.

   A bin check follows the account's Require bin scan setting, like the pick
   walk: off, a tap confirms it; on, a scan or a typed bin with a reason; a scan
   works either way and a wrong bin is always refused. No money shows here.

   Routes: #count, #count/bin/<location id>/<cards|sealed>. */
(function () {
  const { esc, icon, head } = RF;
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  RF.job({ id: "count", label: "Count", icon: "clipboard-list", count: () => G.rfCountTasks().length });

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
  const times = (n, c) => (n > 1 ? "×" + n + " " : "") + [copyWord(c), c.name].filter(Boolean).join(" ");
  const sealedImage = id => "https://tcgplayer-cdn.tcgplayer.com/product/" + encodeURIComponent(id) + "_200w.jpg";
  function cardBlock(c) {
    return '<div class="rf-card">' +
      (c.image
        ? '<button class="rf-photo" data-act="photo" data-url="' + esc(RF.largeImage(c.image)) + '" title="Show a large photo" aria-label="Show a large photo">' +
          '<img src="' + esc(c.image) + '" alt=""></button>'
        : '<div class="rf-photo"><div class="rf-nophoto">' + icon("package") + "</div></div>") +
      '<div class="rf-card-side"><div class="rf-card-sub">' + esc(printing(c)) + "</div>" +
      '<div class="rf-chips">' + cardChips(c) + "</div></div></div>";
  }
  const msgBox = m => (m ? '<div class="rf-msg bad" role="alert">' + esc(m) + "</div>" : "");
  const NO_SIGNAL = "Couldn't check the latest stock, so nothing was posted. Check the signal and try again.";
  async function fresh() {
    const c = await G.catchUp();
    return !!c.ok;
  }

  /* ------------------------- The list ------------------------- */
  RF.screen("count", p => (p[0] === "bin" ? renderBin(p[1] || "", p[2] || "cards") : renderList()));

  const taskWords = t => (t.desk ? "Sent from the desk" : "Short pick");
  function renderList() {
    RF.stayAwake(false);
    RF.refreshSoon();
    cnt = null;
    const tasks = G.rfCountTasks();
    return head("Count", "home") + '<div class="rf-body">' +
      (tasks.length
        ? tasks.map(t => '<a class="rf-row" href="' + esc(RF.hashOf("count", "bin", t.locationId, t.kind)) + '"><div class="rf-row-main">' +
          '<div class="rf-row-title">' + esc(t.bin) + (t.kind === "sealed" ? " (sealed)" : "") + "</div>" +
          '<div class="rf-row-sub">' + esc(taskWords(t)) + "</div></div>" + icon("arrow-right") + "</a>").join("")
        : '<div class="rf-empty">' + icon("clipboard-list") + "No bin is waiting to be counted.</div>") +
      (listMsg ? '<div class="rf-msg warn" role="status">' + esc(listMsg) + "</div>" : "") +
      "</div>" +
      '<div class="rf-actions">' +
      (tasks.length
        ? '<a class="rf-btn gold" href="' + esc(RF.hashOf("count", "bin", tasks[0].locationId, tasks[0].kind)) + '">' + icon("check") + " Count " + esc(tasks[0].bin) + "</a>"
        : '<button class="rf-btn gold" data-act="cnNext" data-kind="cards">' + icon("search") + " Count next bin</button>" +
          '<button class="rf-btn" data-act="cnNext" data-kind="sealed">' + icon("package") + " Count next sealed bin</button>") +
      "</div>";
  }
  let listMsg = "";
  RF.acts({
    cnNext: d => {
      const t = G.rfCountNext(d.kind);
      if (!t) { listMsg = d.kind === "sealed" ? "No bin has sealed product to count." : "No bin has cards to count."; RF.redraw(true); return; }
      listMsg = "";
      RF.go("count", "bin", t.locationId, t.kind);
    }
  });

  /* ------------------------- One bin ------------------------- */
  /* Where this phone is in one count. Nothing is stock until Done posts it.
     step: "stack" | "extras" | "name" | "names" | "printing" | "details" | "search" | "results" | "qty".
     counts: stack id -> the number counted (a recount replaces the first). */
  let cnt = null;
  function cntFor(locationId, kind) {
    if (cnt && cnt.loc === locationId && cnt.kind === kind) return cnt;
    const bin = G.rfCountBin(locationId, kind);
    if (!bin) return null;
    cnt = { loc: locationId, kind: bin.kind, bin: bin.bin, stacks: bin.stacks, i: 0, again: false, counts: {}, found: [],
      step: bin.stacks.length ? "stack" : "extras", verified: false, sub: null, reason: "", msg: null, busy: false, result: null,
      q: "", names: [], groups: [], filter: "", gi: -1, lang: "en", finish: "nonfoil", cond: "NM", qty: 1, results: [], product: null };
    return cnt;
  }
  const sealedKind = () => cnt.kind === "sealed";
  const set = (fields) => { Object.assign(cnt, { msg: null }, fields || {}); RF.redraw(true); };
  const working = () => "Counting " + (sealedKind() ? "sealed " : "") + "stock";

  function renderBin(locationId, kind) {
    RF.stayAwake(true);
    const c = cntFor(locationId, kind === "sealed" ? "sealed" : "cards");
    if (!c) return head("Count", "count") + '<div class="rf-empty">' + icon("triangle-alert") + "That bin isn't there any more.</div>" +
      '<div class="rf-actions"><a class="rf-btn gold" href="' + esc(RF.hashOf("count")) + '">Back to the list</a></div>';
    if (c.busy) return head("Count", null) + '<div class="rf-empty">' + icon("refresh-cw") + esc(c.busy) + "</div>";
    if (c.result) return renderDone();
    if (!c.verified) return c.sub === "reason" ? renderKeyReason() : c.sub === "key" ? renderKeyBin() : renderScan();
    switch (c.step) {
      case "stack": return renderStack();
      case "name": return renderFindName();
      case "names": return renderNames();
      case "printing": return renderPrinting();
      case "details": return renderDetails();
      case "search": return renderSealedSearch();
      case "results": return renderSealedResults();
      case "qty": return renderSealedQty();
      default: return renderExtras();
    }
  }
  const binHash = () => RF.hashOf("count", "bin", cnt.loc, cnt.kind);

  /* ------------------------- Bin check ------------------------- */
  function binOk(how) {
    RF.feedback("ok");
    if (how) { G.logBinCheck(cnt.loc, how, working()); G.persist("Bin checked in Warehouse Mode"); }
    set({ verified: true, sub: null });
  }
  function onScan(text) {
    const check = G.checkBinScan(cnt.loc, text);
    if (check.ok) { binOk("scanned"); return; }
    RF.feedback("bad");
    const msg = check.problem === "wrong-bin" ? "Wrong bin. That's " + check.scanned.name + ". Go to " + cnt.bin + "."
      : check.problem === "unknown-bin" ? "That label's bin isn't in this inventory. Go to " + cnt.bin + "."
      : "That isn't a bin label. Scan the label on " + cnt.bin + (G.binScanRequired() ? ", or press Can't scan." : ", or use the button below.");
    const box = RF.$("rfScanMsg");
    box.textContent = msg;
    box.hidden = false;
  }
  function renderScan() {
    RF.scanning(onScan);
    const required = G.binScanRequired();
    return head("Count", "count") +
      '<div class="rf-body">' +
      '<div><div class="rf-eyebrow">Go to</div><div class="rf-bin">' + esc(cnt.bin) + "</div>" +
      '<div class="rf-text">' + (sealedKind() ? "Count the sealed product here" : "Count the cards here") + "</div></div>" +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock(required ? "Scan the bin label" : "Or scan the bin label") + "</div>" +
      '<div class="rf-actions">' +
      (required
        ? RF.cameraButton(true) + '<button class="rf-btn" data-act="cnCantScan">' + icon("keyboard") + " Can't scan</button>"
        : '<button class="rf-btn gold" data-act="cnAtBin">' + icon("check") + " At this bin</button>" + RF.cameraButton(false)) +
      "</div>";
  }
  function renderKeyReason() {
    return head("Can't scan", { act: "cnClearSub" }) +
      '<div class="rf-body"><div class="rf-big">Why can\'t you scan ' + esc(cnt.bin) + "?</div>" +
      '<p class="rf-text">This goes in the audit log.</p>' +
      G.BIN_KEY_REASONS.map(r => '<button class="rf-btn" data-act="cnKeyReason" data-reason="' + esc(r) + '">' + esc(r) + "</button>").join("") +
      '</div><div class="rf-actions"><button class="rf-btn quiet" data-act="cnClearSub">Go back</button></div>';
  }
  function renderKeyBin() {
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfKeyed"); if (i) i.focus(); });
    return head("Key the bin", { act: "cnClearSub" }) +
      '<div class="rf-body"><div class="rf-big">Type the name on the bin</div>' +
      '<p class="rf-text">' + esc(cnt.reason) + ". Read it off the shelf, not this screen.</p>" + msgBox(cnt.msg) +
      '<input id="rfKeyed" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="Bin name" aria-label="Bin name" data-enter="cnKeySubmit">' +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="cnKeySubmit">Confirm bin</button>' +
      '<button class="rf-btn quiet" data-act="cnClearSub">Go back</button></div>';
  }
  RF.acts({
    cnAtBin: () => { if (!cnt || G.binScanRequired()) { RF.redraw(true); return; } binOk("tapped"); },
    cnCantScan: () => set({ sub: "reason" }),
    cnKeyReason: d => set({ sub: "key", reason: d.reason }),
    cnClearSub: () => set({ sub: null }),
    cnKeySubmit: () => {
      const res = G.keyBin(cnt.loc, RF.$("rfKeyed").value, cnt.reason, working());
      if (!res.ok) {
        RF.feedback("bad");
        set({ sub: "key", msg: "That's not the right bin. Check the shelf: you should be at " + cnt.bin + "." });
        return;
      }
      binOk(null);
      G.persist("Bin keyed in Warehouse Mode");
    }
  });

  /* ------------------------- One stack: how many? ------------------------- */
  function renderStack() {
    const s = cnt.stacks[cnt.i];
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfN"); if (i) i.focus(); });
    return head(cnt.bin, { act: "cnBack" }, (cnt.i + 1) + " of " + cnt.stacks.length) +
      '<div class="rf-progress"><span style="width:' + Math.round(cnt.i / cnt.stacks.length * 100) + '%"></span></div>' +
      '<div class="rf-body">' +
      (cnt.again ? '<div class="rf-msg warn" role="alert">That doesn\'t match the book. Count this one again, slowly.</div>' : "") +
      msgBox(cnt.msg) +
      '<h2 class="rf-card-name">' + esc(s.name) + "</h2>" + cardBlock(s) +
      '<div class="rf-big">How many?</div>' +
      '<input id="rfN" class="rf-input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" autocorrect="off" spellcheck="false" ' +
      'enterkeyhint="done" placeholder="0" aria-label="How many" data-enter="cnCount"></div>' +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="cnCount">' + icon("check") + (cnt.again ? " Count again" : " Next") + "</button></div>";
  }
  function advance() {
    // The next stack with no count yet (a re-asked stack after a stock change leaves the kept ones alone).
    const next = cnt.stacks.findIndex(s => cnt.counts[s.id] === undefined);
    if (next >= 0) set({ i: next, again: false });
    else set({ step: "extras", again: false });
  }
  RF.acts({
    cnCount: () => {
      const raw = String(RF.$("rfN").value || "").trim();
      if (!/^\d{1,5}$/.test(raw)) { RF.feedback("bad"); set({ msg: "Type how many you see. Zero if there are none." }); return; }
      const n = parseInt(raw, 10);
      const s = cnt.stacks[cnt.i];
      cnt.counts[s.id] = n;
      if (!cnt.again && !G.rfCountMatches(cnt.kind, s.id, n)) {
        RF.feedback("bad");
        set({ again: true });
        return;
      }
      RF.feedback("ok");
      advance();
    },
    cnBack: () => {
      if (cnt.i > 0) set({ i: cnt.i - 1, again: false });
      else RF.go("count");
    }
  });

  /* ------------------------- Anything else, then Done ------------------------- */
  function renderExtras() {
    RF.hold(false);
    const what = sealedKind() ? "product" : "card";
    return head(cnt.bin, { act: "cnBackToStacks" }) +
      '<div class="rf-body">' +
      (cnt.stacks.length ? '<div class="rf-big">' + plural(cnt.stacks.length, sealedKind() ? "product" : "stack") + " counted</div>"
        : '<div class="rf-big">Nothing is on the book for this bin</div>') +
      '<p class="rf-text">If there\'s ' + (sealedKind() ? "a product" : "a card") + " here that wasn\'t on the list, add it. Otherwise you\'re done.</p>" +
      msgBox(cnt.msg) +
      (cnt.found.length ? '<div class="rf-label">Found, not on the list</div>' + cnt.found.map((f, i) => '<div class="rf-row stack"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(times(f.qty, f)) + "</div>" +
        '<div class="rf-row-sub">' + esc(printing(f)) + "</div></div>" +
        '<button class="rf-btn danger" data-act="cnFoundDel" data-i="' + i + '">' + icon("x") + " Remove</button></div>").join("") : "") +
      "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="cnDone">' + icon("check") + " Done counting</button>" +
      '<button class="rf-btn" data-act="cnFound">' + icon("plus") + " Found a " + what + " not on the list</button></div>";
  }
  RF.acts({
    cnBackToStacks: () => (cnt.stacks.length ? set({ step: "stack", i: cnt.stacks.length - 1, again: false }) : RF.go("count")),
    cnFoundDel: d => { cnt.found.splice(Number(d.i), 1); RF.redraw(); },
    cnFound: () => set(sealedKind() ? { step: "search", q: "", results: [] } : { step: "name", q: "", names: [], groups: [], filter: "" }),
    cnDone: async () => {
      if (cnt.busy) return;
      const c = cnt;
      const ok = await RF.confirm({ title: "Post this count?",
        body: plural(c.stacks.length, sealedKind() ? "product" : "stack") + " counted" + (c.found.length ? ", " + c.found.length + " found" : "") + ". The bin is marked counted.",
        ok: "Post the count", cancel: "Go back" });
      if (!ok || cnt !== c) return;
      c.busy = "Posting the count…";
      RF.redraw(true);
      if (!await fresh()) { c.busy = false; RF.feedback("bad"); if (cnt === c) set({ msg: NO_SIGNAL }); return; }
      const res = await G.rfCountPost({ locationId: c.loc, kind: c.kind, found: c.found.map(f => Object.assign({}, f)),
        counts: c.stacks.map(s => ({ recordId: s.id, sig: s.sig, counted: c.counts[s.id] })) });
      c.busy = false;
      if (cnt !== c) return;
      if (!res.ok) {
        RF.feedback("bad");
        if (res.problem === "changed") {
          // Only the stacks whose shelf really changed (or are new) are asked again; the rest keep their counts.
          const bin = G.rfCountBin(c.loc, c.kind);
          if (!bin) { cnt = null; listMsg = c.bin + " isn't there any more. Nothing was posted."; RF.go("count"); RF.redraw(true); return; }
          const redo = [];
          const counts = {};
          for (const s of bin.stacks) {
            const old = c.stacks.find(x => x.id === s.id);
            if (old && old.sig === s.sig && c.counts[s.id] !== undefined) counts[s.id] = c.counts[s.id];
            else redo.push(s.id);
          }
          const first = bin.stacks.findIndex(s => counts[s.id] === undefined);
          c.stacks = bin.stacks;
          c.counts = counts;
          if (first >= 0) {
            set({ step: "stack", i: first, again: false,
              msg: plural(redo.length, "stack") + " in " + c.bin + " changed while you were counting. Count " + (redo.length === 1 ? "it" : "those") + " again; the rest are kept." });
          } else {
            set({ step: "extras", again: false, msg: "The stock in " + c.bin + " changed while you were counting. Press Done counting again." });
          }
          return;
        }
        set({ msg: res.problem === "lookup" ? res.message : "That bin isn't there any more. Nothing was posted." });
        return;
      }
      G.persist("Cycle count posted in Warehouse Mode");
      G.saveNow();
      RF.feedback("ok");
      set({ result: res });
    }
  });
  function renderDone() {
    const r = cnt.result;
    const next = G.rfCountTasks().find(t => t.id !== cnt.loc + "|" + cnt.kind);
    return head("Counted", null) +
      '<div class="rf-body"><div class="rf-big">' + esc(cnt.bin) + " counted</div>" +
      '<div class="rf-msg ok">' + (r.clean ? "Everything matched the book." :
        [r.adjusted ? plural(r.adjusted, sealedKind() ? "product" : "stack") + " corrected" : "", r.added ? plural(r.added, "item") + " added" : ""].filter(Boolean).join(", ") + ". It's in the audit log.") + "</div></div>" +
      '<div class="rf-actions">' +
      (next ? '<a class="rf-btn gold" href="' + esc(RF.hashOf("count", "bin", next.locationId, next.kind)) + '">Next: ' + esc(next.bin) + "</a>" : "") +
      '<a class="rf-btn' + (next ? "" : " gold") + '" href="' + esc(RF.hashOf("count")) + '">Back to the list</a></div>';
  }

  /* ------------------------- Found a card not on the list ------------------------- */
  const finishesOf = c => { const f = ((c && c.finishes) || []).filter(x => G.FINISHES.includes(x)); return f.length ? f : ["nonfoil"]; };
  function bkCard() {
    const g = cnt.groups[cnt.gi];
    if (!g) return null;
    return g.cards.find(c => (c.lang || "en") === cnt.lang) || G.englishOf(g);
  }
  function choiceRow(label, act, values, current, words) {
    return '<div class="rf-label">' + esc(label) + '</div><div class="rf-choice" role="group" aria-label="' + esc(label) + '">' +
      values.map(v => '<button data-act="' + act + '" data-v="' + esc(v) + '"' + (v === current ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + ">" +
        (v === current ? icon("check") + " " : "") + esc(words ? words(v) : v) + "</button>").join("") + "</div>";
  }
  const busyScreen = () => head("Found a " + (sealedKind() ? "product" : "card"), null) + '<div class="rf-empty">' + icon("refresh-cw") + esc(cnt.busy) + "</div>";
  function renderFindName() {
    if (cnt.busy) return busyScreen();
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfQ"); if (i) i.focus(); });
    return head("Found a card", { act: "cnToExtras" }) +
      '<div class="rf-body"><div class="rf-big">Which card?</div>' +
      '<input id="rfQ" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Card name" aria-label="Card name" data-enter="cnFind" value="' + esc(cnt.q) + '">' + msgBox(cnt.msg) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="cnFind">' + icon("search") + " Find it</button></div>";
  }
  function renderNames() {
    return head("Found a card", { act: "cnAgain" }, String(cnt.names.length)) +
      '<div class="rf-body"><p class="rf-text">' + esc(cnt.q) + "</p>" +
      cnt.names.map((n, i) => '<button class="rf-row" data-act="cnName" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(n) + "</div></div>" + icon("arrow-right") + "</button>").join("") +
      '</div><div class="rf-actions"><button class="rf-btn" data-act="cnAgain">' + icon("search") + " Search again</button></div>";
  }
  const PRINT_MAX = 30;
  function renderPrinting() {
    if (cnt.busy) return busyScreen();
    const rows = [];
    cnt.groups.forEach((g, i) => { if (G.printingMatches(G.englishOf(g), cnt.filter)) rows.push(i); });
    RF.hold(true);
    const narrow = cnt.groups.length > 6 || cnt.filter;
    return head(cnt.name, { act: "cnAgain" }, String(cnt.groups.length)) +
      '<div class="rf-body"><div class="rf-big">Which printing?</div>' +
      (narrow ? '<input id="rfPF" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" ' +
        'placeholder="Set code, number or year" aria-label="Narrow the printings" data-enter="cnNarrow" value="' + esc(cnt.filter) + '">' : "") +
      (rows.length ? rows.slice(0, PRINT_MAX).map(i => {
        const c = G.englishOf(cnt.groups[i]);
        const year = String(c.releasedAt || "").slice(0, 4);
        return '<button class="rf-row" data-act="cnPrint" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(String(c.set || "").toUpperCase() + " #" + c.collector) + "</div>" +
          '<div class="rf-row-sub">' + esc([c.setName, year].filter(Boolean).join(" · ")) + "</div></div>" + icon("arrow-right") + "</button>";
      }).join("") : '<div class="rf-empty">' + icon("search") + "No printing matches that.</div>") +
      (rows.length > PRINT_MAX ? '<div class="rf-msg warn">Showing ' + PRINT_MAX + " of " + rows.length + ". Type the set code or number.</div>" : "") +
      "</div>" +
      (narrow ? '<div class="rf-actions"><button class="rf-btn gold" data-act="cnNarrow">' + icon("search") + " Narrow it</button></div>" : "");
  }
  function renderDetails() {
    const g = cnt.groups[cnt.gi];
    const c = bkCard();
    if (!g || !c) return renderFindName();
    const langs = [...new Set(g.cards.map(x => x.lang || "en"))];
    const fins = finishesOf(c);
    if (!fins.includes(cnt.finish)) cnt.finish = fins[0];
    const view = { name: cnt.name, set: String(c.set || "").toUpperCase(), collector: c.collector, image: c.imageUrl || "", condition: cnt.cond, finish: cnt.finish, lang: cnt.lang };
    return head("Found a card", { act: "cnBackPrint" }, "Details") +
      '<div class="rf-body"><h2 class="rf-card-name">' + esc(cnt.name) + "</h2>" + cardBlock(view) +
      '<div class="rf-stepper"><button data-act="cnDown" title="One less" aria-label="One less">−</button>' +
      '<output aria-live="polite">' + cnt.qty + '</output><button data-act="cnUp" title="One more" aria-label="One more">+</button></div>' +
      msgBox(cnt.msg) +
      choiceRow("Condition", "cnCond", G.CONDITIONS, cnt.cond) +
      (fins.length > 1 ? choiceRow("Finish", "cnFinish", fins, cnt.finish, f => G.FINISH_NAMES[f] || f) : "") +
      (langs.length > 1 ? choiceRow("Language", "cnLang", langs, cnt.lang, l => String(l).toUpperCase()) : "") +
      "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="cnAdd">' + icon("check") + " Add " + cnt.qty + " to " + esc(cnt.bin) + "</button></div>";
  }
  async function loadPrintings(name) {
    const c = cnt;
    c.name = name;
    c.busy = "Loading the printings…";
    RF.redraw(true);
    let list = [];
    try { list = await G.cards.printings(name); }
    catch (e) { c.busy = false; if (cnt === c) set({ step: "name", msg: "Couldn't load the printings: " + (e.message || e) }); return; }
    c.busy = false;
    if (cnt !== c) return;
    if (!list.length) { set({ step: "name", msg: "No printings found for that name." }); return; }
    const groups = G.sortPrintingsNewest(G.groupPrintings(list), G.englishOf);
    if (groups.length === 1) {
      set({ groups, step: "details", gi: 0, lang: groups[0].cards.some(x => (x.lang || "en") === "en") ? "en" : groups[0].cards[0].lang, qty: 1 });
      return;
    }
    set({ step: "printing", groups, filter: "" });
  }
  RF.acts({
    cnToExtras: () => set({ step: "extras" }),
    cnAgain: () => set({ step: "name", names: [], groups: [], filter: "" }),
    cnFind: async () => {
      const q = (RF.$("rfQ") && RF.$("rfQ").value || "").trim();
      if (q.length < 2 || cnt.busy) return;
      const c = cnt;
      c.q = q;
      c.busy = "Looking it up…";
      RF.redraw(true);
      let names = [];
      try { names = await G.cards.autocomplete(q); }
      catch (e) { c.busy = false; if (cnt === c) set({ step: "name", msg: "Couldn't look that up: " + (e.message || e) }); return; }
      c.busy = false;
      if (cnt !== c) return;
      const exact = names.find(n => n.toLowerCase() === q.toLowerCase());
      if (exact || names.length === 1) { loadPrintings(exact || names[0]); return; }
      if (!names.length) { set({ step: "name", msg: "No card has that name. Check the spelling." }); return; }
      set({ step: "names", names: names.slice(0, 20) });
    },
    cnName: d => loadPrintings(cnt.names[Number(d.i)]),
    cnNarrow: () => { cnt.filter = (RF.$("rfPF") && RF.$("rfPF").value || "").trim(); RF.redraw(true); },
    cnPrint: d => {
      const g = cnt.groups[Number(d.i)];
      if (!g) return;
      const langs = g.cards.map(x => x.lang || "en");
      set({ step: "details", gi: Number(d.i), lang: langs.includes(cnt.lang) ? cnt.lang : (langs.includes("en") ? "en" : langs[0]), qty: 1 });
    },
    cnBackPrint: () => set({ step: cnt.groups.length > 1 ? "printing" : "name" }),
    cnCond: d => { cnt.cond = d.v; RF.redraw(); },
    cnFinish: d => { cnt.finish = d.v; RF.redraw(); },
    cnLang: d => { cnt.lang = d.v; RF.redraw(); },
    cnDown: () => { cnt.qty = Math.max(1, cnt.qty - 1); RF.redraw(); },
    cnUp: () => { cnt.qty = Math.min(999, cnt.qty + 1); RF.redraw(); },
    cnAdd: () => {
      const c = bkCard();
      if (!c) return;
      cnt.found.push({ name: cnt.name, set: c.set, collector: c.collector, lang: cnt.lang, finish: cnt.finish, condition: cnt.cond, qty: cnt.qty, image: c.imageUrl || "" });
      RF.feedback("ok");
      set({ step: "extras" });
    }
  });

  /* ------------------------- Found a sealed product not on the list ------------------------- */
  function renderSealedSearch() {
    if (cnt.busy) return busyScreen();
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfSQ"); if (i) i.focus(); });
    return head("Found a product", { act: "cnToExtras" }) +
      '<div class="rf-body"><div class="rf-big">Which product?</div>' +
      '<input id="rfSQ" class="rf-input" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" ' +
      'placeholder="Product name" aria-label="Product name" data-enter="cnSFind" value="' + esc(cnt.q) + '">' + msgBox(cnt.msg) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="cnSFind">' + icon("search") + " Find it</button></div>";
  }
  function renderSealedResults() {
    return head("Found a product", { act: "cnSAgain" }, String(cnt.results.length)) +
      '<div class="rf-body"><p class="rf-text">' + esc(cnt.q) + "</p>" +
      cnt.results.map((p, i) => '<button class="rf-row" data-act="cnSPick" data-i="' + i + '"><div class="rf-row-main"><div class="rf-row-title">' + esc(p.name) + "</div>" +
        '<div class="rf-row-sub">' + esc(String(p.setCode || "").toUpperCase()) + "</div></div>" + icon("arrow-right") + "</button>").join("") +
      '</div><div class="rf-actions"><button class="rf-btn" data-act="cnSAgain">' + icon("search") + " Search again</button></div>";
  }
  function renderSealedQty() {
    const p = cnt.product;
    return head("Found a product", { act: "cnSBack" }, "How many") +
      '<div class="rf-body"><h2 class="rf-card-name">' + esc(p.name) + "</h2>" +
      cardBlock({ name: p.name, sealed: true, set: String(p.setCode || "").toUpperCase(), image: sealedImage(p.tcgplayerProductId) }) +
      '<div class="rf-stepper"><button data-act="cnDown" title="One less" aria-label="One less">−</button>' +
      '<output aria-live="polite">' + cnt.qty + '</output><button data-act="cnUp" title="One more" aria-label="One more">+</button></div>' +
      msgBox(cnt.msg) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="cnSAdd">' + icon("check") + " Add " + cnt.qty + " to " + esc(cnt.bin) + "</button></div>";
  }
  RF.acts({
    cnSAgain: () => set({ step: "search", results: [] }),
    cnSBack: () => set({ step: cnt.results.length ? "results" : "search" }),
    cnSFind: async () => {
      const q = (RF.$("rfSQ") && RF.$("rfSQ").value || "").trim();
      if (q.length < 2 || cnt.busy) return;
      const c = cnt;
      c.q = q;
      c.busy = "Looking it up…";
      RF.redraw(true);
      let found = [];
      try { found = ((await G.api("/api/sealed/search?q=" + encodeURIComponent(q))).data || []); }
      catch (e) { c.busy = false; if (cnt === c) set({ step: "search", msg: "Couldn't look that up: " + (e.message || e) }); return; }
      c.busy = false;
      if (cnt !== c) return;
      const results = found.map(p => ({ tcgplayerProductId: p.tcgplayerProductId, manapoolProductId: p.manapoolProductId, name: p.name, setCode: p.setCode, marketPrice: p.marketPrice }));
      if (!results.length) { set({ step: "search", msg: "No sealed product has that name." }); return; }
      set({ step: "results", results });
    },
    cnSPick: d => { const p = cnt.results[Number(d.i)]; if (p) set({ step: "qty", product: p, qty: 1 }); },
    cnSAdd: () => {
      const p = cnt.product;
      cnt.found.push({ tcgplayerProductId: p.tcgplayerProductId, manapoolProductId: p.manapoolProductId, name: p.name, setCode: p.setCode,
        marketPrice: p.marketPrice, qty: cnt.qty, set: String(p.setCode || "").toUpperCase(), sealed: true });
      RF.feedback("ok");
      set({ step: "extras" });
    }
  });
})();
