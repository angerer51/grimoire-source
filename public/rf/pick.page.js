"use strict";
/* Warehouse Mode: pick and pack (#386). Flow: docs/flows/rf-pick.dot.
   Execution only: tickets and batches are made on the desk (lists.html); here
   the picker chooses one and walks it. Which screen shows is worked out fresh
   from live stock on every draw (core.js rfPickWalk), so a short pick that
   reroutes a line, or a coworker's save merging in, just draws the next step.

   Routes: #pick (the choice of work), #pick/ticket/<id>, #pick/batch/<id>. */
(function () {
  const { esc, icon, head } = RF;

  // Where this phone is in the walk: reload and it asks for the bin again. What's
  // been pulled isn't here, it's on the ticket (core.js rfPulls).
  let work = null;
  function workFor(kind, id) {
    if (!work || work.kind !== kind || work.id !== id) {
      work = { kind, id, verifiedBin: null, skipped: [], sub: null, rowId: null, msg: null, count: 0, reason: "", result: null, packId: null };
    }
    return work;
  }
  const target = () => ({ kind: work.kind, id: work.id });
  const walkNow = () => G.rfPickWalk(target(), work.skipped);
  const canWork = () => G.rfCanWork(target(), G.me);
  const label = () => (work.kind === "batch" ? "Batch" : "Pick");
  const backToList = "pick";
  /* Before anything that writes stock or the pulls, from a screen drawn earlier (the
     rule from #395, and now a desk or another phone can move copies under a picker):
     look at the server first. Not ok: say so and do nothing. Fresh stock came in:
     redraw from it and make the picker look again, but only if same() says this stop's
     own stock changed: any other save landing is no reason to stop or lose a count.
     true = go ahead. */
  async function freshFirst(what, same) {
    const c = await G.catchUp();
    if (!c.ok) {
      RF.feedback("bad");
      work.msg = "Couldn't check the latest stock, so " + what + " didn't happen. Check the signal and try again.";
      RF.redraw(true);
      return false;
    }
    // Someone else's save came in. It only matters if this stop's own stock changed.
    if (c.loaded && same && !same()) {
      RF.feedback("bad");
      work.msg = "Stock changed while you were here (a move or a pick elsewhere). Look at this stop again.";
      if (work.sub === "short") work.sub = null;   // the count was against the old numbers
      RF.redraw(true);
      return false;
    }
    return true;
  }
  const msgBox = () => (work.msg ? '<div class="rf-msg bad" role="alert">' + esc(work.msg) + "</div>" : "");

  function setSub(sub, fields) {
    work.sub = sub;
    Object.assign(work, fields || {});
    RF.redraw(true);
  }

  // Foil and language are how a picker grabs the wrong copy, so they shout.
  function cardChips(c) {
    const out = [];
    if (c.finish && c.finish !== "nonfoil") out.push('<span class="rf-tag warn">' + esc(G.FINISH_NAMES[c.finish] || c.finish) + "</span>");
    if (c.lang && c.lang !== "en") out.push('<span class="rf-tag warn">' + esc(String(c.lang).toUpperCase()) + "</span>");
    if (c.condition) out.push('<span class="rf-tag">' + esc(c.condition) + "</span>");
    if (c.sealed) out.push('<span class="rf-tag">Sealed</span>');
    return out.join(" ");
  }
  const printing = c => [c.set, c.collector ? "#" + c.collector : ""].filter(Boolean).join(" ");
  const qtyBig = n => '<div class="rf-qty' + (n > 1 ? " multi" : "") + '" aria-label="Quantity ' + n + '">' + (n > 1 ? "×" + n : n) + "</div>";
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  /* ------------------------- The choice of work ------------------------- */
  RF.job({
    id: "pick", label: "Pick and pack", icon: "package",
    // Waiting for this person: what someone else is picking isn't.
    count: () => G.rfPickQueue(G.me).filter(i => i.canWork).length
  });

  const takeOverButton = (kind, id, inHand) => '<button class="rf-btn" data-act="takeOver" data-kind="' + esc(kind) +
    '" data-id="' + esc(id) + '" data-hand="' + esc(inHand || 0) + '">Take over</button>';
  const releaseButton = (kind, id, inHand, quiet) => '<button class="rf-btn' + (quiet ? " quiet" : "") + '" data-act="release" data-kind="' + esc(kind) +
    '" data-id="' + esc(id) + '" data-hand="' + esc(inHand || 0) + '">Release</button>';
  function queueRow(item) {
    const sub = item.kind === "batch" ? item.orders.join(", ") : plural(item.cards, "card") + ", " + plural(item.lines, "line");
    const tags = [];
    if (item.stage === "pack") tags.push('<span class="rf-tag go">Pack</span>');
    else if (item.started) tags.push('<span class="rf-tag go">Started</span>');
    else if (item.unclaimed) tags.push('<span class="rf-tag go">Open</span>');
    if (item.released) tags.push('<span class="rf-tag warn">Released</span>');
    if (item.released && item.inHand) tags.push('<span class="rf-tag">' + item.inHand + " pulled</span>");
    if (item.named) tags.push('<span class="rf-tag">For you</span>');
    if (item.short) tags.push('<span class="rf-tag bad">Short</span>');
    if (item.cancelled) tags.push('<span class="rf-tag bad">Cancelled on Manapool</span>');
    if (!item.canWork) {
      return '<div class="rf-row' + (item.canTakeOver ? " stack" : "") + '"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + esc(item.title) + "</div>" +
        '<div class="rf-row-sub">' + esc(sub) + "</div>" +
        '<div class="rf-row-sub">' + esc(item.assignee ? (item.named && !item.started ? "Assigned to " : "Being picked by ") + item.assignee : "Nobody assigned") +
        (item.canTakeOver ? "" : ". A manager can take it over.") + "</div></div>" +
        (item.canTakeOver ? takeOverButton(item.kind, item.id, item.inHand) : "") +
        (item.canTakeOver && item.canRelease ? releaseButton(item.kind, item.id, item.inHand) : "") +
        "</div>";
    }
    return '<a class="rf-row" href="' + esc(RF.hashOf("pick", item.kind, item.id)) + '">' +
      '<div class="rf-row-main"><div class="rf-row-title">' + esc(item.title) + "</div>" +
      '<div class="rf-row-sub">' + esc(item.kind === "batch" ? plural(item.cards, "card") + " · " + sub : sub) + "</div>" +
      (tags.length ? '<div class="rf-chips" style="margin-top:6px">' + tags.join(" ") + "</div>" : "") + "</div>" +
      icon("arrow-right") + "</a>";
  }
  /* Which orders Manapool replaced or cancelled (#489), asked at most every 30
     seconds while picking: a background redraw when the answer changes. No
     answer keeps what was known; the desk and the server still refuse to ship one. */
  let cancelledAskedAt = 0;
  function refreshCancelled() {
    if (Date.now() - cancelledAskedAt < 30000) return;
    cancelledAskedAt = Date.now();
    G.loadCancelledOrders().then(changed => { if (changed) RF.redraw(); }).catch(() => {});
  }

  function renderQueue() {
    RF.stayAwake(false);
    RF.refreshSoon();
    refreshCancelled();
    const items = G.rfPickQueue(G.me);
    return head("Choose work", "home", items.length ? String(items.length) : "") +
      (items.length
        ? '<div class="rf-body">' + items.map(queueRow).join("") + "</div>"
        : '<div class="rf-empty">' + icon("circle-check") + "Nothing to pick or pack.<br>New tickets are made at the desk, on Order Fulfillment.</div>");
  }
  RF.acts({
    takeOver: async d => {
      const hand = Number(d.hand) || 0;
      if (!await RF.confirm({ title: "Take over this " + (d.kind === "batch" ? "batch" : "ticket") + "?",
        body: "It moves to you, and the person it's with can't work it any more." +
          (hand ? " They still have " + plural(hand, "card") + " in hand: get them first." : ""), ok: "Take over" })) return;
      G.rfTakeOver({ kind: d.kind, id: d.id }, G.me);
      G.persist("Take over in Warehouse Mode");
      G.saveNow();
      RF.redraw(true);
    },
    release: async d => {
      const t = { kind: d.kind, id: d.id };
      const who = G.rfPickerOf(t);
      const mine = who && G.me && String(who.id) === String(G.me.id);
      const hand = Number(d.hand) || 0;
      if (!await RF.confirm({ title: "Release this " + (d.kind === "batch" ? "batch" : "ticket") + "?",
        body: "It goes back to the open queue for anyone to pick." + (!hand ? ""
          : mine ? " The " + plural(hand, "card") + " you pulled stay on record: leave them where the next picker can find them."
          : " " + (who ? who.name : "The picker") + " still has " + plural(hand, "card") + " in hand, and they stay on record: get them first."),
        ok: "Release", cancel: "Keep it" })) return;
      if (G.rfRelease(t, G.me)) {
        RF.feedback("ok");
        G.persist("Released in Warehouse Mode");
        G.saveNow();
      }
      work = null;
      if (location.hash === "#pick") RF.redraw(true); else RF.go("pick");
    }
  });

  /* ------------------------- Start: from here it's theirs ------------------------- */
  function renderStart(walk) {
    const batch = work.kind === "batch";
    return head(label(), backToList) +
      '<div class="rf-body"><div class="rf-big">' + esc(batch ? "Batch of " + walk.tags.length + " orders" : walk.tags.join(", ")) + "</div>" +
      (batch ? '<p class="rf-text">' + esc(walk.tags.join(", ")) + "</p>" : "") +
      '<p class="rf-text">' + plural(walk.cards, "card") + " from " + plural(walk.stops, "bin") + ".</p>" +
      (walk.cardsDone ? '<div class="rf-msg warn">' + plural(walk.cardsDone, "card") + " already pulled" +
        (walk.releasedBy ? " by " + esc(walk.releasedBy) : "") + ". Get " + (walk.cardsDone === 1 ? "it" : "them") + " before you start.</div>" : "") +
      (walk.cardsDone ? '<button class="rf-btn quiet" data-act="pickedSoFar">' + icon("clipboard-list") + " Picked so far: " + walk.cardsDone + "</button>" : "") +
      (G.me && G.me.orgId ? '<p class="rf-text">Once you start, ' + (batch ? "this batch" : "this ticket") + " is yours until you release it. A manager can take it over.</p>" : "") +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="startWork">' + icon("arrow-right") + (batch ? " Claim and start" : " Start picking") + "</button>" +
      '<a class="rf-btn quiet" href="' + esc(RF.hashOf(backToList)) + '">Go back</a></div>';
  }
  RF.acts({
    startWork: () => {
      if (G.rfStartWork(target(), G.me)) {
        RF.feedback("ok");
        G.persist("Started in Warehouse Mode");
        G.saveNow();   // so a coworker sees it's taken before walking anywhere
      }
      RF.redraw(true);
    }
  });

  /* ------------------------- Go to the bin, and check it ------------------------- */
  /* What the next bin check is for. Copies going back come first (owner,
     2026-10-31: the same location check as a pick when the scan is required),
     then the next pull. */
  function pendingCheck(walk) {
    if (work.returning) {
      const r = walk.rows.find(x => x.id === work.returning && x.held > 0);
      if (r) return { kind: "reverse", locationId: r.locationId, bin: r.bin, name: r.name, qty: r.held, rowId: r.id };
      work.returning = null;
    }
    const x = walk.putBack[0];
    if (x) return { kind: "putBack", locationId: x.locationId, bin: x.bin, name: x.name, qty: x.qty, id: x.id };
    return walk.next ? { kind: "pick", locationId: walk.next.locationId, bin: walk.next.bin } : null;
  }
  const working = (walk, check) => (check.kind === "pick" ? "Picking " : "Putting back on ") + walk.tags.join(", ");
  function binChecked(check, how, walk) {
    RF.feedback("ok");
    work.verifiedBin = check.locationId;
    if (how) G.logBinCheck(check.locationId, how, working(walk, check));
    if (check.kind === "putBack") G.rfPutBack(target(), check.id);
    if (check.kind === "reverse") { G.rfReversePull(target(), check.rowId); work.returning = null; }
    if (how || check.kind !== "pick") G.persist("Bin checked in Warehouse Mode");
    // Reversing what's on a ticket nobody has started: back to the list of them.
    setSub(check.kind === "reverse" && G.rfNeedsStart(target()) ? "review" : null, { msg: null });
  }
  function onScan(row, walk, text) {
    const check = G.checkBinScan(row.locationId, text);
    if (check.ok) { binChecked(row, "scanned", walk); return; }
    RF.feedback("bad");
    const msg = check.problem === "wrong-bin" ? "Wrong bin. That's " + check.scanned.name + ". Go to " + row.bin + "."
      : check.problem === "unknown-bin" ? "That label's bin isn't in this inventory. Go to " + row.bin + "."
      : "That isn't a bin label. Scan the label on " + row.bin + (G.binScanRequired() ? ", or press Can't scan." : ", or use the button below.");
    // In place, not a redraw: the camera keeps running and the field keeps its focus.
    const box = RF.$("rfScanMsg");
    box.textContent = msg;
    box.hidden = false;
  }
  function renderScan(row, walk) {
    const check = pendingCheck(walk);
    RF.scanning(text => onScan(check, walk, text));
    const required = G.binScanRequired();
    const back = row.held > 0;
    return head(label(), backToList, "Stop " + walk.stopNo + " of " + walk.stops) +
      '<div class="rf-body">' + msgBox() +
      '<div><div class="rf-eyebrow">' + (back ? "Go back to" : "Go to") + '</div><div class="rf-bin">' + esc(row.bin) + "</div>" +
      '<div class="rf-text">' + (back ? "Take " + walk.binCards + " more here" : plural(walk.binCards, "card") + " here") + "</div></div>" +
      (work.skipped.includes(row.locationId) ? '<div class="rf-msg warn">You skipped this stop. It has to be picked or shorted before you can finish.</div>' : "") +
      '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' +
      RF.scanBlock(required ? "Scan the bin label" : "Or scan the bin label") +
      walkTools(walk) +
      "</div>" +
      '<div class="rf-actions">' +
      (required
        ? RF.cameraButton(true) + '<button class="rf-btn" data-act="cantScan">' + icon("keyboard") + " Can't scan</button>"
        : '<button class="rf-btn gold" data-act="atBin">' + icon("check") + " At this bin</button>" + RF.cameraButton(false)) +
      (walk.binsLeft > 1 ? '<button class="rf-btn quiet" data-act="skipStop" data-loc="' + esc(row.locationId) + '">Skip this stop</button>' : "") +
      "</div>";
  }
  // Blocked aisle: to the end of the walk. It still has to be picked or shorted.
  RF.acts({
    atBin: () => {
      const walk = walkNow();
      const check = pendingCheck(walk);
      if (!check || check.kind !== "pick" || !canWork() || G.binScanRequired()) { RF.redraw(true); return; }
      binChecked(check, "tapped", walk);
    },
    skipStop: d => {
      work.skipped = work.skipped.filter(x => x !== d.loc).concat(d.loc);
      setSub(null, { msg: null });
    }
  });
  // The walk's two side doors: below the work, out of the thumb's way.
  function walkTools(walk) {
    const a = walk.cardsDone ? '<button class="rf-btn quiet" data-act="pickedSoFar">' + icon("clipboard-list") + " Picked so far: " + walk.cardsDone + "</button>" : "";
    const b = G.rfCanRelease(target(), G.me) ? releaseButton(work.kind, work.id, walk.cardsDone, true) : "";
    return a || b ? '<div class="rf-tools">' + a + b + "</div>" : "";
  }

  /* ------------------------- Can't scan: reason, then key the bin ------------------------- */
  function renderKeyReason(row) {
    return head("Can't scan", { act: "clearSub" }) +
      '<div class="rf-body"><div class="rf-big">Why can\'t you scan ' + esc(row.bin) + "?</div>" +
      '<p class="rf-text">This goes in the audit log.</p>' +
      G.BIN_KEY_REASONS.map(r => '<button class="rf-btn" data-act="keyReason" data-reason="' + esc(r) + '">' + esc(r) + "</button>").join("") +
      '</div><div class="rf-actions"><button class="rf-btn quiet" data-act="clearSub">Go back</button></div>';
  }
  function renderKeyBin(row) {
    RF.hold(true);
    RF.after(() => { const i = RF.$("rfKeyed"); if (i) i.focus(); });
    return head("Key the bin", { act: "clearSub" }) +
      '<div class="rf-body"><div class="rf-big">Type the name on the bin</div>' +
      '<p class="rf-text">' + esc(work.reason) + ". Read it off the shelf, not this screen.</p>" +
      (work.msg ? '<div class="rf-msg bad" role="alert">' + esc(work.msg) + "</div>" : "") +
      '<input id="rfKeyed" class="rf-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="Bin name" aria-label="Bin name" data-enter="keySubmit">' +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="keySubmit">Confirm bin</button>' +
      '<button class="rf-btn quiet" data-act="clearSub">Go back</button></div>';
  }
  RF.acts({
    cantScan: () => setSub("keyReason", { msg: null }),
    keyReason: d => setSub("keyBin", { reason: d.reason, msg: null }),
    clearSub: () => setSub(null, { msg: null }),
    keySubmit: () => {
      const walk = walkNow();
      const row = pendingCheck(walk);
      if (!row) { setSub(null); return; }
      const res = G.keyBin(row.locationId, RF.$("rfKeyed").value, work.reason, working(walk, row));
      if (!res.ok) {
        RF.feedback("bad");
        setSub("keyBin", { msg: "That's not the right bin. Check the shelf: you should be at " + row.bin + "." });
        return;
      }
      G.persist("Bin keyed in Warehouse Mode");
      binChecked(row, null, walk);
    }
  });

  /* ------------------------- The card: compare, then tap ------------------------- */
  function renderCard(row, walk) {
    const art = row.image ? G.artCropUrl(row.image) : "";
    const large = row.image ? RF.largeImage(row.image) : "";
    const forOrders = work.kind === "batch"
      ? '<div class="rf-card-sub">For ' + row.orders.filter(o => o.need > 0).map(o => esc(o.tag) + (o.need > 1 ? " ×" + o.need : "")).join(", ") + "</div>" : "";
    return head(row.bin, backToList, "Stop " + walk.stopNo + " of " + walk.stops) +
      '<div class="rf-progress"><span style="width:' + (walk.cards ? Math.round(walk.cardsDone / walk.cards * 100) : 0) + '%"></span></div>' +
      '<div class="rf-body">' + msgBox() +
      '<h2 class="rf-card-name">' + esc(row.name) + "</h2>" +
      '<div class="rf-card">' +
      (row.image
        ? '<button class="rf-photo" data-act="photo" data-url="' + esc(large) + '" title="Show a large photo" aria-label="Show a large photo">' +
          '<img src="' + esc(row.image) + '" alt=""></button>'
        : '<div class="rf-photo"><div class="rf-nophoto">' + icon("package") + "</div></div>") +
      '<div class="rf-card-side">' +
      qtyBig(row.need) +
      (row.held ? '<div class="rf-card-sub">' + row.held + " already in hand</div>" : "") +
      (art && !row.sealed ? '<img class="rf-art" src="' + esc(art) + '" alt="">' : "") +
      '<div class="rf-card-sub">' + esc(printing(row)) + "</div>" +
      '<div class="rf-chips">' + cardChips(row) + "</div>" +
      forOrders +
      "</div></div>" + walkTools(walk) + "</div>" +
      '<div class="rf-actions">' +
      '<button class="rf-btn gold" data-act="picked" data-row="' + esc(row.id) + '">' + icon("check") + (row.need > 1 ? " Picked all " + row.need : " Picked") + "</button>" +
      '<button class="rf-btn" data-act="short" data-row="' + esc(row.id) + '">' + icon("triangle-alert") + " Short: not all here</button></div>";
  }
  RF.acts({
    /* No latest-stock check here (round 2 of #403): Picked writes only the pull record,
       not on-hand, and every tap would wait on the server. A pull against copies that
       moved since is put right by the walk's put-back; Short and Finish, which do
       change on-hand, check first. */
    picked: d => {
      if (!canWork()) { RF.redraw(true); return; }
      if (G.rfConfirmPull(target(), d.row, work.skipped)) {
        RF.feedback("ok");
        G.persist("Picked in Warehouse Mode");
      }
      setSub(null, { msg: null });
    },
    short: d => {
      const row = walkNow().rows.find(r => r.id === d.row);
      if (!row) { setSub(null); return; }
      setSub("short", { msg: null, rowId: row.id, count: Math.max(0, Math.min(row.need, row.shelfQty) - 1) });
    },
    pickedSoFar: () => setSub("review", { msg: null })
  });

  /* ------------------------- Picked so far: reverse a mis-tap ------------------------- */
  function renderReview(walk) {
    const rows = walk.rows.filter(r => r.held > 0);
    const unstarted = G.rfNeedsStart(target());
    return head("Picked so far", { act: "clearSub" }) +
      '<div class="rf-body"><p class="rf-text">Tapped Picked by mistake? Reverse it until you press Finish. Reversals go in the audit log.</p>' +
      (rows.length ? rows.map(r => '<div class="rf-row"><div class="rf-row-main">' +
        '<div class="rf-row-title">' + (r.held > 1 ? "×" + r.held + " " : "") + esc(r.name) + "</div>" +
        '<div class="rf-row-sub">' + esc(r.bin) + "</div></div>" +
        '<button class="rf-btn" style="width:auto" data-act="reverse" data-row="' + esc(r.id) + '">Reverse</button></div>').join("")
        : '<div class="rf-empty">' + (unstarted ? "Nothing is on record now. You can start it here, or discard it at the desk." : "Nothing picked yet.") + "</div>") +
      '</div><div class="rf-actions"><button class="rf-btn gold" data-act="clearSub">' + (unstarted ? "Go back" : "Back to the walk") + "</button></div>";
  }
  /* ------------------------- Put back what's no longer needed ------------------------- */
  /* Owner, 2026-10-31: with the scan required, copies going back take the same
     location check as a pick: scan, or Can't scan with a reason. Standing at that
     bin already, or with the setting off, a tap is enough. A scan works either way
     and a wrong bin is refused. A bin that's since been deleted can't be checked. */
  function renderReturn(x, walk) {
    const atBin = work.verifiedBin === x.locationId;
    const scanNeeded = G.binScanRequired() && !atBin && !!G.locById(x.locationId);
    const reversing = x.kind === "reverse";
    if (!atBin) RF.scanning(text => onScan(x, walk, text));
    return head("Put back", reversing ? { act: "cancelReturn" } : null) +
      '<div class="rf-body"><div class="rf-big">' + esc(x.name) + "</div>" +
      '<div><div class="rf-eyebrow">Put ' + x.qty + " back in</div><div class=\"rf-bin\">" + esc(x.bin) + "</div></div>" +
      '<p class="rf-text">' + (reversing ? "You reversed this Picked." : "This order doesn\'t need " + (x.qty === 1 ? "it" : "them") + " any more.") + " It stays on the book in this bin.</p>" +
      (atBin ? "" : '<div class="rf-msg bad" id="rfScanMsg" role="alert" hidden></div>' + RF.scanBlock(scanNeeded ? "Scan the bin label" : "Or scan the bin label")) +
      "</div>" +
      '<div class="rf-actions">' +
      (scanNeeded
        ? RF.cameraButton(true) + '<button class="rf-btn" data-act="cantScan">' + icon("keyboard") + " Can't scan</button>"
        : '<button class="rf-btn gold" data-act="putBack">' + icon("check") + " Put back</button>" + (atBin ? "" : RF.cameraButton(false))) +
      (reversing ? '<button class="rf-btn quiet" data-act="cancelReturn">Keep it picked</button>' : "") +
      "</div>";
  }
  RF.acts({
    reverse: async d => {
      const row = walkNow().rows.find(r => r.id === d.row);
      if (!row || !row.held) { RF.redraw(true); return; }
      const what = (row.held > 1 ? row.held + " " : "") + row.name;
      const atBin = work.verifiedBin === row.locationId;
      /* A location check only when the copies are physically going back (owner,
         2026-10-31). Not if the picker hasn't left that bin, nor on a mis-tap with
         nothing pulled or copies that stay in hand. */
      if (G.binScanRequired() && !atBin && G.locById(row.locationId)) {
        const answer = await RF.confirm({
          title: "Is " + what + " going back in " + row.bin + "?",
          body: "It goes back on the walk either way, and the reversal is logged. If it's going back, you'll check the bin when you get there.",
          ok: "Yes, going back", alt: "No, nothing goes back", cancel: "Keep it picked" });
        if (!answer) return;
        if (!canWork()) { setSub(null); return; }
        if (answer === "alt") {
          if (G.rfReversePull(target(), row.id, { returned: false })) {
            RF.feedback("ok");
            G.persist("Reversed a pick in Warehouse Mode");
          }
          work.verifiedBin = null;
          RF.redraw(true);
          return;
        }
        setSub(null, { returning: row.id, msg: null });
        return;
      }
      const ok = await RF.confirm({
        title: "Put " + what + " back in " + row.bin + "?",
        body: "It goes back on the walk, and the reversal is logged.", ok: "Yes, it's back", cancel: "Keep it picked" });
      if (!ok) return;
      if (!canWork()) { setSub(null); return; }
      if (G.rfReversePull(target(), row.id)) {
        RF.feedback("ok");
        G.persist("Reversed a pick in Warehouse Mode");
      }
      // Still standing at that bin: the row is right here. Anywhere else, it asks again.
      if (!atBin) work.verifiedBin = null;
      RF.redraw(true);
    },
    putBack: () => {
      const walk = walkNow();
      const check = pendingCheck(walk);
      if (!check || check.kind === "pick" || !canWork()) { setSub(null); return; }
      const atBin = work.verifiedBin === check.locationId;
      if (G.binScanRequired() && !atBin && G.locById(check.locationId)) { RF.redraw(true); return; }
      binChecked(check, atBin ? null : "tapped", walk);
    },
    cancelReturn: () => setSub(null, { returning: null, msg: null })
  });

  /* ------------------------- Short pick ------------------------- */
  /* A row is one stack: one condition, finish and language. A bin holding another
     grade of the same card is ordinary, and those copies aren't this stack's. */
  function copyWord(c) {
    return [c.condition, c.finish && c.finish !== "nonfoil" ? (G.FINISH_NAMES[c.finish] || c.finish) : "",
      c.lang && c.lang !== "en" ? String(c.lang).toUpperCase() : ""].filter(Boolean).join(" ");
  }
  const copyName = c => [copyWord(c), c.name].filter(Boolean).join(" ");
  function renderShort(row) {
    return head("Short", { act: "clearSub" }) +
      '<div class="rf-body">' + msgBox() +
      '<div class="rf-big">How many ' + esc(copyName(row)) + " are really in " + esc(row.bin) + "?</div>" +
      '<div class="rf-chips">' + cardChips(row) + (printing(row) ? ' <span class="rf-tag">' + esc(printing(row)) + "</span>" : "") + "</div>" +
      '<p class="rf-text">' + (row.sealed ? "Count every one in the bin."
        : "Count only " + esc(copyWord(row) || "these") + " copies of this printing. Don't count other conditions, finishes or languages.") +
      " The book says " + row.shelfQty + ", and you need " + row.need + "." +
      (row.heldInBin ? " Don't count the " + row.heldInBin + " already pulled." : "") + "</p>" +
      '<div class="rf-stepper">' +
      '<button data-act="shortDown" title="One less" aria-label="One less">−</button>' +
      '<output aria-live="polite">' + work.count + "</output>" +
      '<button data-act="shortUp" title="One more" aria-label="One more">+</button></div></div>' +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="shortSave">That\'s what\'s here</button>' +
      '<button class="rf-btn quiet" data-act="clearSub">Go back</button></div>';
  }
  function renderShortResult() {
    const r = work.result;
    const lines = [];
    lines.push('<div class="rf-msg ok">On-hand in ' + esc(r.row.bin) + " is now " + r.onHand + (r.onHand !== r.found ? ", with " + r.found + " on the shelf" : "") + ". That's logged, and the bin is on the count list.</div>");
    if (r.sameBin) lines.push('<div class="rf-big">Take ' + r.sameBin + " from here</div>");
    for (const m of r.moved) lines.push('<div><div class="rf-eyebrow">' + (m.back ? "Go back for " + m.qty + " more from" : "Then " + m.qty + " from") + "</div><div class=\"rf-bin small\">" + esc(m.bin) + "</div></div>");
    for (const x of r.putBack) lines.push('<div class="rf-msg warn">Put ' + x.qty + " " + esc(x.name) + " back in " + esc(x.bin) + ".</div>");
    if (r.short) {
      lines.push('<div class="rf-msg bad" role="alert">No other bin has any: ' + r.short + " short. " +
        esc((r.shortOrders.length ? r.shortOrders.join(", ") : "This order") + (r.shortOrders.length === 1 ? " is" : " are") + " flagged short.") + "</div>");
    }
    return head("Short recorded") + '<div class="rf-body"><div class="rf-big">' + esc(copyName(r.row)) + "</div>" + lines.join("") + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="clearSub">Carry on</button></div>';
  }
  RF.acts({
    shortDown: () => { work.count = Math.max(0, work.count - 1); RF.redraw(); },
    shortUp: () => {
      const row = walkNow().rows.find(r => r.id === work.rowId);
      work.count = Math.min(row ? row.shelfQty : work.count, work.count + 1);
      RF.redraw();
    },
    shortSave: async () => {
      const row = walkNow().rows.find(r => r.id === work.rowId);
      if (!row) { setSub(null); return; }
      if (work.count >= row.shelfQty) {
        // Everything the book says is here: nothing to correct, so back to the card.
        setSub(null, { msg: null });
        return;
      }
      const ok = await RF.confirm({
        title: "Change on-hand of " + copyName(row) + " in " + row.bin + " from " + row.shelfQty + " to " + work.count + "?",
        body: "This corrects only " + (copyWord(row) || "these") + " copies, right away, and is logged. The rest goes to the next bin that has it.",
        ok: "Yes, correct it", danger: true });
      if (!ok) return;
      if (!canWork()) { setSub(null); return; }
      // Only this stack's own numbers matter: another save elsewhere changes nothing here.
      const was = row.shelfQty;
      if (!await freshFirst("the correction", () => {
        const now = walkNow().rows.find(r => r.id === row.id);
        return !!now && now.shelfQty === was;
      })) return;
      if (!canWork()) { setSub(null); return; }
      const out = G.rfShortPick(target(), row.id, work.count, work.skipped);
      if (!out || !out.changed) { setSub(null); return; }
      RF.feedback("bad");
      G.persist("Short pick in Warehouse Mode");
      G.saveNow();
      setSub("shortResult", { result: out, rowId: null });
    }
  });

  /* ------------------------- Everything's pulled ------------------------- */
  function renderFinish(walk) {
    // Orders Manapool cancelled (#489): what's in hand finishes as picked and is set aside
    // for the desk's Cancel and put back; one with nothing in hand just stays for the desk.
    const gone = G.rfCancelledOrders(target());
    const aside = gone.filter(g => g.held > 0).map(g => g.tag), untouched = gone.filter(g => !g.held).map(g => g.tag);
    const goneNote = (aside.length ? '<div class="rf-msg bad" role="alert">' + icon("triangle-alert") + " " + esc(aside.join(", ")) + (aside.length === 1 ? " was" : " were") +
        " cancelled on Manapool: set " + (aside.length === 1 ? "its" : "their") + " cards aside, don't pack.</div>" : "") +
      (untouched.length ? '<div class="rf-msg bad">' + icon("triangle-alert") + " " + esc(untouched.join(", ")) + (untouched.length === 1 ? " was" : " were") +
        " cancelled on Manapool before anything was picked. Nothing to do here: the desk discards " + (untouched.length === 1 ? "it" : "them") + ".</div>" : "");
    if (untouched.length && !walk.rows.length) {   // nothing else here to finish
      return head(label(), backToList, "") + '<div class="rf-body">' + msgBox() + '<div class="rf-big">Nothing to pick</div>' + goneNote + "</div>" +
        '<div class="rf-actions"><button class="rf-btn gold" data-act="goneNext">Next work</button></div>';
    }
    return head(label(), backToList, "Pulled") +
      '<div class="rf-body">' + msgBox() + '<div class="rf-big">' + plural(walk.cardsDone, "card") + " pulled from " + plural(walk.binsPulled, "bin") + "</div>" +
      (walk.cardsShort ? '<div class="rf-msg bad">' + plural(walk.cardsShort, "card") + " short:</div>" +
        walk.shorts.map(s => '<div class="rf-text">' + esc(s.name) + " ×" + s.qty + " · " + esc(s.orders.join(", ")) + "</div>").join("") : "") +
      goneNote + '<p class="rf-text">Finishing takes these cards off stock.</p>' + walkTools(walk) + "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="finish">' + icon("check") + " Finish picking</button></div>";
  }
  RF.acts({
    // Nothing to pick (#489): the cancelled ticket leaves its batch and picker for the desk.
    goneNext: () => {
      if (canWork() && (G.rfFinishPicking(target()).setAside || []).length) {
        G.persist("Left a cancelled order for the desk");
        G.saveNow();
      }
      RF.go("pick");
    },
    finish: async () => {
      if (!canWork()) { RF.redraw(true); return; }
      const walk = walkNow();
      if (walk.next || walk.putBack.length) { RF.redraw(true); return; }
      const ok = await RF.confirm({
        title: "Finish picking?",
        body: plural(walk.cardsDone, "card") + " pulled from " + plural(walk.binsPulled, "bin") +
          (walk.cardsShort ? ", " + plural(walk.cardsShort, "card") + " short. It goes on to packing and shows as short at the desk." : ", none short.") +
          " These come off stock now, and can't be reversed here after this.",
        ok: "Finish picking" });
      if (!ok) return;
      if (!canWork()) { RF.redraw(true); return; }
      // Only a stop that's open again, or copies to put back, is a real change.
      if (!await freshFirst("Finish", () => { const w = walkNow(); return !(w.next || w.putBack.length); })) return;
      if (!canWork()) { RF.redraw(true); return; }
      const done = G.rfFinishPicking(target());
      if (done.refused) { RF.redraw(true); return; }
      RF.feedback("ok");
      G.persist("Picked " + walk.tags.join(", ") + " in Warehouse Mode");
      G.saveNow();
      // A cancelled order left the batch (#489) and one ticket was left: no batch any more, so pack it as a ticket.
      if (work.kind === "batch" && !G.pickBatchLists(work.id).length && done.rest && done.rest.length === 1) {
        RF.go("pick", "ticket", done.rest[0]);
        return;
      }
      setSub(null, { msg: null, verifiedBin: null, skipped: [] });
    }
  });

  /* ------------------------- Pack ------------------------- */
  const lineMeta = l => [printing(l), l.condition].filter(Boolean).join(" · ");
  function packLine(order, l, tappable) {
    const short = l.short ? ' <span class="rf-tag bad">Short ' + l.short + "</span>" : "";
    const body = '<div class="rf-row-main"><div class="rf-row-title">' + (l.pulled > 1 ? "×" + l.pulled + " " : "") + esc(l.name) + "</div>" +
      '<div class="rf-row-sub">' + esc(lineMeta(l)) + "</div>" +
      '<div class="rf-chips" style="margin-top:4px">' + (l.finish && l.finish !== "nonfoil" ? '<span class="rf-tag warn">' + esc(G.FINISH_NAMES[l.finish] || l.finish) + "</span>" : "") + short + "</div></div>";
    if (!tappable || !l.pulled) return '<div class="rf-row">' + body + "</div>";
    return '<button class="rf-row' + (l.bagged ? " done" : "") + '" data-act="bag" data-list="' + esc(order.pickListId) + '" data-key="' + esc(l.key) + '" aria-pressed="' + !!l.bagged + '">' +
      body + '<span class="rf-tickbox">' + (l.bagged ? icon("check") : "") + "</span></button>";
  }
  /* Manapool cancelled this order after it was picked (#489): a stop, not a pack.
     Set aside moves this phone on; the desk cancels it and puts the cards in a
     sorting tray. */
  function renderSetAside(o, ofN) {
    return head("Pack " + o.tag, backToList, ofN) +
      '<div class="rf-body">' +
      '<div class="rf-big">Don\'t pack ' + esc(o.tag) + "</div>" +
      '<div class="rf-msg bad" role="alert">' + icon("triangle-alert") + " This order was " + esc(o.cancelled) + " on Manapool. Set it aside.</div>" +
      '<p class="rf-text">Keep its ' + plural(o.cards, "card") + " together and take " + (o.cards === 1 ? "it" : "them") + " to the desk. The desk cancels the ticket and puts the cards in a sorting tray to put away.</p>" +
      o.lines.map(l => packLine(o, l, false)).join("") +
      "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="setAside" data-list="' + esc(o.pickListId) + '">' +
      icon("check") + " Set aside</button></div>";
  }
  function renderAllSetAside(orders) {
    const aside = orders.filter(o => !o.packed && o.cancelled).map(o => o.tag);
    return head("Set aside", backToList) +
      '<div class="rf-empty">' + icon("triangle-alert") + esc(aside.join(", ")) + (aside.length === 1 ? " was" : " were") +
      " cancelled on Manapool: set aside for the desk.<br>Everything else here is packed.</div>" +
      '<div class="rf-actions"><a class="rf-btn gold" href="#pick">Next work</a></div>';
  }
  function renderPack(orders) {
    refreshCancelled();
    const setAside = work.setAside || [];
    const todo = orders.filter(o => !o.packed && !(o.cancelled && setAside.includes(o.pickListId)));
    if (!todo.length) return renderAllSetAside(orders);
    // One order per screen; the one chosen last time, or the first still open.
    const o = todo.find(x => x.pickListId === work.packId) || todo[0];
    work.packId = o.pickListId;
    if (o.cancelled) return renderSetAside(o, orders.length > 1 ? (orders.length - todo.length + 1) + " of " + orders.length : "");
    const ofN = orders.length > 1 ? (orders.length - todo.length + 1) + " of " + orders.length : "";
    const inBatch = o.inBatch;
    const ready = !inBatch || o.lines.every(l => l.bagged);
    return head("Pack " + o.tag, backToList, ofN) +
      '<div class="rf-body">' +
      '<div class="rf-big">' + (inBatch ? "Bag these for " : "Pack ") + esc(o.tag) + "</div>" +
      '<p class="rf-text">' + plural(o.cards, "card") + (inBatch ? ". Tap each line as it goes in the bag." + (orders.length > 1 ? " Highest order number first." : "") : ". Check them against this list.") + "</p>" +
      (o.short ? '<div class="rf-msg bad">This order is ' + plural(o.short, "card") + " short.</div>" : "") +
      o.lines.map(l => packLine(o, l, inBatch)).join("") +
      "</div>" +
      '<div class="rf-actions"><button class="rf-btn gold" data-act="packed" data-list="' + esc(o.pickListId) + '"' + (ready ? "" : " disabled") + ">" +
      icon("package") + " Packed, ready to ship</button></div>";
  }
  function renderDone(walk) {
    RF.stayAwake(false);
    const one = walk.tags.length === 1;
    const anyPacked = G.rfPackedHere(target());
    return head(!anyPacked ? "Finished at the desk" : one ? "Packed" : "All packed", backToList) +
      '<div class="rf-empty">' + icon("circle-check") + (anyPacked
        ? esc(walk.tags.join(", ")) + (one ? " is" : " are") + " ready to ship.<br>Labels and shipping happen at the desk."
        : esc(walk.tags.join(", ")) + " was picked at the desk, so it finishes there.") + "</div>" +
      '<div class="rf-actions"><a class="rf-btn gold" href="#pick">Next work</a></div>';
  }
  RF.acts({
    bag: d => {
      if (!canWork()) { RF.redraw(true); return; }
      const order = G.rfPackView(target()).find(o => o.pickListId === d.list);
      const line = order && order.lines.find(l => l.key === d.key);
      if (!line) return;
      G.setPickBatchSorted(d.list, d.key, !line.bagged);
      G.persist("Bagged in Warehouse Mode");
      RF.redraw();
    },
    setAside: d => {
      work.setAside = (work.setAside || []).concat(d.list);
      setSub(null, { packId: null });
    },
    packed: d => {
      if (!canWork()) { RF.redraw(true); return; }
      if (G.rfPackOrder(d.list)) {
        RF.feedback("ok");
        G.persist("Packed in Warehouse Mode");
        G.saveNow();
      }
      setSub(null, { packId: null });
    }
  });

  /* ------------------------- Which step are we on? ------------------------- */
  function renderWork(kind, id) {
    workFor(kind, id);
    const walk = walkNow();
    // Nothing left to pull at the bin last confirmed: the picker has moved on.
    if (work.verifiedBin && !walk.rows.some(r => r.locationId === work.verifiedBin && r.need > 0)) work.verifiedBin = null;
    if (!walk.tags.length) {
      return head("Not found", backToList) + '<div class="rf-empty">' + icon("triangle-alert") + "This ticket isn't here any more. It may have been discarded at the desk.</div>";
    }
    if (!canWork()) {
      const who = G.rfPickerOf(target());
      const canTake = G.canReassignPickBatch(G.me);
      return head(label(), backToList) + '<div class="rf-empty">' + icon("user") +
        esc(who ? "Being picked by " + who.name + "." : "Nobody is assigned to this batch.") + "<br>Only they can work it." + (canTake ? "" : " A manager can take it over.") + "</div>" +
        (canTake ? '<div class="rf-actions">' + takeOverButton(kind, id, walk.cardsDone) +
          (G.rfCanRelease(target(), G.me) ? releaseButton(kind, id, walk.cardsDone) : "") + "</div>" : "");
    }
    RF.stayAwake(true);
    if (work.sub === "shortResult" && work.result) return renderShortResult();
    if (walk.stage === "done") return renderDone(walk);
    if (walk.stage === "pack") return renderPack(G.rfPackView(target()));
    // Reversing comes before Start: it's how a released ticket gets cancelled, by
    // anyone, without taking it on.
    if (work.sub === "review") return renderReview(walk);
    const going = pendingCheck(walk);
    const unstarted = G.rfNeedsStart(target());
    if (unstarted && (!going || going.kind !== "reverse")) return renderStart(walk);
    if (going && going.kind !== "pick") {
      if (work.sub === "keyReason") return renderKeyReason(going);
      if (work.sub === "keyBin") return renderKeyBin(going);
      return renderReturn(going, walk);
    }
    const row = work.sub === "short" ? walk.rows.find(r => r.id === work.rowId) : walk.next;
    if (!row) { work.sub = null; return renderFinish(walk); }
    if (work.sub === "short") return renderShort(row);
    if (work.sub === "keyReason") return renderKeyReason(row);
    if (work.sub === "keyBin") return renderKeyBin(row);
    if (work.verifiedBin !== row.locationId) return renderScan(row, walk);
    return renderCard(row, walk);
  }

  RF.screen("pick", p => {
    if (p[0] === "ticket" || p[0] === "batch") return renderWork(p[0], p[1]);
    return renderQueue();
  });
})();
