
"use strict";
(function () {
  const $ = UI.$;
  let orders = [];
  // Which order's drill-down row is open (an id, or null) - see
  // buildOrderDetailRow/toggleOrder. Only one at a time, same as the fixed
  // bottom panel this replaced.
  let expandedOrderId = null;
  let meta = {};
  // fetchOrders(true)/silent auto-load - see the comment this had before on
  // why re-opening the tab must not silently re-sync every time.
  let ordersAutoLoaded = false;

  /* Order/pick-list lines never stored an image URL themselves - best-effort
     match against a stack still owned today with the same identity, built
     once per render rather than scanning state.cards per row. */
  function ownedImageIndex() {
    const map = new Map();
    for (const c of G.state.cards) {
      map.set([c.set, c.collector, c.lang || "en", c.finish || "nonfoil"].join("|"), c.imageUrl);
    }
    return map;
  }
  function imageForLine(index, l) {
    if (!l || !l.set || !l.collector) return "";
    return index.get([l.set, l.collector, l.lang || "en", l.finish || "nonfoil"].join("|")) || "";
  }
  /* Matches an order line back to its pick-list line by identity, not array
     index - a pick list line can be removed (the "Remove this line" ✕,
     renderPick) while still open, which shifts indices but leaves the
     order's own `lines` untouched. Shared shape between an order line and a
     pick-list line (generatePickList copies these fields straight across),
     so the same key works against either. */
  function lineIdentity(l) {
    return l.kind === "sealed" ? "sealed|" + l.tcgplayerProductId
      : ["card", l.set, l.collector, l.lang || "en", l.finish || "nonfoil"].join("|");
  }
  /* Row click reviews the card - a live (cached) lookup, since a line here
     is a flattened order/pick-list summary, not the full card-database
     shape CardPanel.showCard expects. */
  async function reviewLine(l) {
    if (!l || !l.set || !l.collector) return;
    let card;
    try { card = await G.cards.one(l.set, l.collector, l.lang || "en"); }
    catch (e) { return; }
    if (card) UI.reviewCard(card, l.finish);
  }

  let tabs;
  function onTab(t) {
    if (t === "pick") renderPick();
    if (t === "orders") {
      if (meta.manapool && !ordersAutoLoaded) {
        ordersAutoLoaded = true;
        fetchOrders(false);
      } else {
        renderOrders();
      }
    }
  }

  const allocValue = a => a.pulls.reduce((s, p) => {
    const r = G.state.cards.find(x => x.id === p.recordId) || G.state.sealed.find(x => x.id === p.recordId);
    return s + (r && r.price != null ? r.price * p.take : 0);
  }, 0);

  /* ============================== Pick list ==============================
     One pick list shown at a time in the detail view below, switchable via
     the queue table (renderPickQueue() further down) listing every ticket
     not yet shipped. This started as a tab strip (same pattern as Receive's
     lot-draft tabs), then grew checkboxes and bulk actions once several
     orders needed to move through complete/ship together, not just be
     switchable one at a time - several orders can legitimately be mid-pick
     at once (a busy day, or one blocked on a chase pick while another's
     ready to complete). */
  let currentPickListId = null;
  // Survives renderPickQueue() rebuilding the <tbody> from scratch (every
  // row click that opens a different ticket does exactly that) - without
  // this, a stray click on a row next to its checkbox silently unticked
  // every OTHER already-checked row too (reported by a user as "checking
  // multiple boxes... automatically unselects all"). Pruned against the
  // live list on each render so a shipped/discarded ticket's id doesn't
  // linger forever.
  let selectedPickIds = new Set();
  // Pick together (#212): the batch shown in place of the one-ticket view
  // (null = none), which of its two steps is showing, and which order the
  // sort step is on. View state only; the batch itself lives on the pick
  // lists (core.js "Batch picking").
  let currentBatchId = null;
  let batchStep = "pull";
  let batchSortListId = null;
  const openPickLists = () => G.pickLists().filter(p => p.status === "open");
  // Everything still in flight - both stages the bulk queue table shows.
  // openPickLists() (open only) stays around for the one place that still
  // means specifically that: currentPickList()'s orphan fallback below.
  // A shipped ticket Manapool wasn't told about stays too (#454), flagged, so its Retry is easy to reach.
  const queuedPickLists = () => G.pickLists().filter(p => p.status !== "shipped" || G.manapoolShipFailed(p));

  // The "Pick list" tab's count: tickets still waiting - open (to pick) or
  // picked (to ship) - never the cards on whichever list is selected. This is
  // the only place that writes it - it used to be set in three places, one
  // to the selected list's card total, and that came back after the owner
  // had it removed (pinned by test/lists.page.test.js).
  function renderPickCount() {
    $("pickCount").textContent = String(queuedPickLists().length);
  }

  /* ============================== Fulfillment steps ==============================
     The steps the user actually works through, end to end: choosing
     order(s) and generating pick lists (1-2) happen on the Orders tab and
     are implicitly "done" the moment a pick list row exists at all - no new
     status is stored for them. Steps 4 and 5 both live on the SAME "picked"
     status (completing a list already means step 4 happened; whether to go
     weigh a real package or skip straight to shipped is a UI choice at that
     moment, not a stored state) - stepFor() just picks which one to show as
     current.

     #188: "Weigh & manifest" exists only when a shipping API is connected
     (meta.shipping, i.e. Pitney Bowes). Without one the page has five steps
     and Ship is step 5, so stepFor()'s numbers still fit: a picked ticket
     has Ship current, and a shipped one (6) shows every step done. Shipping
     counts as off until /api/meta answers, and if it fails. */
  const shippingOn = () => !!meta.shipping;
  /* A counter sale (#431, Walk-in) is entered at the counter and handed over
     there: no order to choose, no label, weigh or ship step. */
  const COUNTER_STEPS = ["Enter order", "Pick the lines", "Complete pick list", "Hand over"];
  function stepLabels(p) {
    if (G.isCounterSale(p)) return COUNTER_STEPS;
    return shippingOn()
      ? ["Choose order(s)", "Generate pick list", "Pick the lines", "Complete pick list", "Weigh & manifest", "Ship"]
      : ["Choose order(s)", "Generate pick list", "Pick the lines", "Complete pick list", "Ship"];
  }
  function stepFor(p) {
    if (G.isCounterSale(p)) return p.status === "open" ? 2 : p.status === "picked" ? 4 : 5;
    if (!p || p.status === "open") return 3;
    if (p.status === "picked") return 5;
    return 6; // shipped
  }
  /* Shared by the queue table's one-line-per-row version (compact:true, no
     labels, just numbered dots) and the full labeled version shown above
     whichever ticket is currently open for picking. Steps before `step` are
     done (checked), `step` itself is current (highlighted), later ones are
     upcoming (dim) - matches the stepFor() mapping above, so step 4 always
     shows done the instant a ticket reaches "picked". */
  function renderStepper(step, opts) {
    const compact = !!(opts && opts.compact);
    const nodes = stepLabels(opts && opts.p).map((label, i) => {
      const n = i + 1;
      const state = n < step ? "done" : n === step ? "current" : "upcoming";
      return '<span class="step ' + state + '" title="' + (n) + ". " + G.esc(label) + '">' +
        '<span class="step-dot">' + (state === "done" ? "✓" : n) + "</span>" +
        (compact ? "" : '<span class="step-label">' + G.esc(label) + "</span>") +
        "</span>";
    }).join('<span class="step-line"></span>');
    return '<div class="stepper' + (compact ? " stepper-mini" : "") + '">' + nodes + "</div>";
  }
  function currentPickList() {
    if (currentPickListId) {
      const p = G.pickLists().find(x => x.id === currentPickListId);
      if (p) return p;
    }
    // No explicit selection - e.g. landed on this tab fresh, or cards were
    // queued via a card's Manage -> Add to pick list (manual) or a
    // TCGplayer import on an earlier visit. Neither has an order row to
    // launch it from and there's no tab strip any more to find it through,
    // so fall back to the first such orphaned list rather than leaving it
    // unreachable. If more than one is somehow open at once, this only
    // surfaces one at a time - discarding/completing it reveals the next.
    const orphan = G.pickLists().find(p => p.status === "open" && !p.orderId && p.lines.length);
    if (orphan) { currentPickListId = orphan.id; return orphan; }
    return null;
  }
  function openPickList(id) {
    currentPickListId = id;
    tabs.show("pick");
  }
  const pickListForOrder = orderId => G.pickListForOrder(orderId);

  const STATUS_LABEL = { open: "open — needs picking", picked: "picked — awaiting ship", shipped: "shipped" };
  // Packed in Warehouse Mode (#386): same stage, but the floor says it's ready.
  const COUNTER_STATUS = { open: "open — needs picking", picked: "picked — ready to hand over", shipped: "handed over" };
  const pickStatusText = p => (G.isCounterSale(p) ? COUNTER_STATUS[p.status]
    : p.status === "picked" && p.packedAt ? "packed — ready to ship"
    : G.manapoolShipFailed(p) ? "shipped — not sent to Manapool" : STATUS_LABEL[p.status]);

  /* The order's human-readable label wherever a pick list is shown, never
     its internal id/UUID. p.orderLabel is set for anything generated after
     that field existed (core.js's newPickList); an older pick list falls
     back to a live lookup against whatever `orders` happens to be loaded
     this session, and only as a last resort falls back to the id shortened
     (G.pickListOrderLabel, #197: a label saved as the UUID itself no longer
     wins over the real one in the cache). */
  function orderLabelFor(p) {
    if (!p.orderId) return null;
    return G.pickListOrderLabel(p, orders);
  }
  /* How a batch (#212) names each of its tickets: the order number only
     (owner's choice: not letters, not customer names), e.g. "#1043". A
     ticket with no order behind it (a TCGplayer import, a manual list) has
     only its ticket number to go by. */
  function orderTag(p) {
    const label = orderLabelFor(p);
    if (!label) return G.pickListTag(p);   // a Walk-in ticket says so (#431)
    return label.charAt(0) === "#" ? label : "#" + label;
  }
  /* Copies in a tote (owner, 2026-10-31): the desk can't close it out, whoever is
     looking and whatever else is true, personal accounts included. Completing
     here would allocate from scratch, and discarding would lose the record. */
  function inHandLockReason(p) {
    const hand = G.pickListInHand(p);
    if (!hand) return "";
    const mine = G.me && (G.me.displayName || G.me.username);
    const who = hand.by.map(n => (n === mine ? "you" : n)).join(" and ");
    return hand.cards + " card" + (hand.cards === 1 ? "" : "s") + " pulled" + (who ? " by " + who : "") + (hand.cards === 1 ? " is" : " are") + " on record." +
      " Finish it in Warehouse Mode, or reverse " + (hand.cards === 1 ? "it" : "them") + " there first.";
  }
  /* A batch belongs to one person (owner, 2026-10-13). In a Store only its
     assignee may tick, complete, chase or dissolve it - or complete, chase,
     edit or discard one of its tickets on its own; an Owner or Manager can
     reassign. Everyone else can still look and print. Returns why this
     person can't work the batch, or "" if they can (always "" on a
     personal inventory). Controls stay visible, disabled, with this reason. */
  function batchLockReason(batchId) {
    const first = batchId && G.pickBatchLists(batchId)[0];
    const inHand = inHandLockReason(first);
    if (inHand) return inHand;
    if (!batchId || G.canWorkPickBatch(batchId, G.me)) return "";
    const who = G.pickBatchAssignee(batchId);
    return (who ? (G.pickBatchIsOpen(batchId) ? "Made by " : "Being picked by ") + who.name + ". Only they" : "Nobody is assigned to this batch yet, so nobody") +
      " can tick, complete, chase or dissolve it" +
      (G.canReassignPickBatch(G.me) ? " - reassign it to yourself to take over." : " - ask an Owner or Manager to reassign it.");
  }
  // A ticket someone started in Warehouse Mode locks to them, here too (#386).
  function ticketLockReason(p) {
    if (!p || G.canWorkPickList(p, G.me) || !p.rfPicker) return "";
    return "Being picked by " + p.rfPicker.name + " in Warehouse Mode. Only they can tick, complete, chase or discard it" +
      (G.canReassignPickBatch(G.me) ? " - take it over in Warehouse Mode." : " - ask an Owner or Manager to take it over in Warehouse Mode.");
  }
  const pickLockReason = p => (p && p.batchId ? batchLockReason(p.batchId) : inHandLockReason(p) || ticketLockReason(p));
  /* Why an open ticket can't be completed: the locks above, or Manapool cancelled
     its order (#489). That one is discarded instead: it only set copies aside. */
  const goneReason = p => (p && p.status === "open" && G.pickOrderCancelled(p)
    ? "Manapool has this order as " + G.pickOrderCancelled(p) + ", so don't complete it. Discard the ticket instead: it only set copies aside." : "");
  const completeLockReason = p => pickLockReason(p) || goneReason(p);
  // An icon button's title + aria-label (same text), plus disabled and the
  // reason when locked.
  const lockCallout = lock => (lock
    ? '<div class="callout warn" style="margin-top:12px"><span class="cico">' + UI.icon("user") + '</span><div class="cbody">' +
      '<div class="hint" style="margin-top:0">' + G.esc(lock) + " You can still look at it and print it.</div></div></div>"
    : "");
  const lockedAttrs = (lock, label) => {
    const t = G.esc(lock ? label + " - " + lock : label);
    return (lock ? " disabled" : "") + ' title="' + t + '" aria-label="' + t + '"';
  };

  /* The queue's rows (#198): with nothing in the search box, every ticket
     not yet shipped; with a search, every ticket that matches, shipped ones
     included (looking up an old ticket by its number is half the point).
     Matches the ticket number, the order number (saved, or from the orders
     cache), the customer / ship-to name and card names on its lines. */
  let shownPickIds = new Set();
  function pickQueueRows() {
    const terms = G.searchTerms($("pqSearch").value);
    if (!terms.length) return { terms, list: queuedPickLists() };
    const byId = new Map(orders.map(o => [String(o.id), o]));
    const names = G.customerNameByOrder();
    const list = G.pickLists().filter(p => {
      const oid = p.orderId ? String(p.orderId) : "";
      return G.matchesTerms(G.pickListSearchText(p, oid ? byId.get(oid) : null, oid ? names.get(oid) : ""), terms);
    });
    return { terms, list };
  }

  /* The ticket switcher AND the bulk multi-select surface, replacing what
     used to be an open-only tab strip (renderDraftTabs()-style, same idea
     as receive.page.js) - that strip only ever listed "open" pick lists, so
     a ticket vanished from view the moment it completed (status: "picked"),
     reachable only if it happened to still be the currently-open one. This
     lists everything queuedPickLists() returns (open AND picked - anything
     not yet shipped), so a batch of "picked, awaiting ship" tickets is
     something you can actually see and act on together, not just the one
     you happen to have open. Clicking a row (not its checkbox or ✕) opens
     it the same way clicking an old tab did. */
  function renderPickQueue() {
    const box = $("pickQueueBody");
    if (!box) return;
    const { terms, list } = pickQueueRows();
    $("pqSearchNote").hidden = !terms.length;
    const activeId = currentPickList() ? currentPickList().id : null;
    shownPickIds = new Set(list.map(p => p.id));
    // A ticked ticket the search hides stays ticked (#198); only one that's
    // gone (shipped and not on screen, or discarded) is let go.
    const liveIds = new Set(queuedPickLists().map(p => p.id).concat([...shownPickIds]));
    for (const id of selectedPickIds) if (!liveIds.has(id)) selectedPickIds.delete(id);
    if (!list.length) {
      box.innerHTML = terms.length
        ? UI.emptyRow(7, { icon: "search", title: "No pick tickets match “" + G.esc($("pqSearch").value.trim()) + "”.",
          hint: "The search looks at ticket numbers, order numbers, customer names and card names, shipped tickets included." })
        : UI.emptyRow(7, { icon: "orders", title: "Nothing queued.",
          hint: "Generate a pick list from an order on the Orders tab, import a TCGplayer order, or use a card's Manage → Add to pick list." });
    } else {
      box.innerHTML = "";
      const imgIndex = ownedImageIndex();
      for (const p of list) {
        const label = orderLabelFor(p) || G.pickListTag(p) + (p.customer && p.customer.name ? " · " + p.customer.name : "");
        const count = p.lines.reduce((s, l) => s + l.qty, 0);
        // Representative art for the ticket: first line with a match still
        // owned today (a ticket usually mixes several different cards).
        let repImg = "";
        for (const l of p.lines) { repImg = imageForLine(imgIndex, l); if (repImg) break; }
        const tr = document.createElement("tr");
        // While a batch is open, its tickets are the highlighted ones.
        const isActive = currentBatchId ? p.batchId === currentBatchId : p.id === activeId;
        const inBatch = !!p.batchId && p.status !== "shipped";
        tr.className = "click" + (isActive ? " active" : "");
        tr.innerHTML =
          UI.artThumbTd(repImg) +
          '<td><input type="checkbox" class="pqPick" data-id="' + p.id + '"' + (selectedPickIds.has(p.id) ? " checked" : "") + "></td>" +
          // data-vs keeps the Batch button's word out of the sort key.
          (inBatch ? '<td data-vs="' + G.esc(label) + '">' : "<td>") + G.esc(label) +
            (inBatch ? ' <button class="small pqBatchOpen" title="Open the batch this ticket is picked with" aria-label="Open the batch this ticket is picked with">' +
              UI.icon("clipboard-list") + " Batch</button>" : "") + "</td>" +
          '<td class="hide-sm">' + renderStepper(stepFor(p), { compact: true, p }) + "</td>" +
          '<td class="num">' + count + "</td>" +
          '<td><span class="pill' + (p.status === "picked" ? " type" : "") + '">' + G.esc(pickStatusText(p)) + "</span>" +
            (G.pickListIsShort(p) ? ' <span class="short-tag">short</span>' : "") +
            (G.pickListInHand(p) ? ' <span class="short-tag">' + G.pickListInHand(p).cards + " pulled</span>" : "") +
            (G.pickOrderCancelled(p) ? ' <span class="short-tag">' + G.esc(G.pickOrderCancelled(p)) + " on Manapool</span>" : "") + "</td>" +
          "<td>" + (p.status === "open" ? '<button class="small ghost pqDiscard"' + lockedAttrs(pickLockReason(p), "Discard this pick list") + ">" +
            UI.icon("x") + "</button>" : "") + "</td>";
        tr.querySelector(".pqPick").onclick = e => {
          e.stopPropagation();
          if (e.target.checked) selectedPickIds.add(p.id); else selectedPickIds.delete(p.id);
          updatePickQueueActions();
        };
        const x = tr.querySelector(".pqDiscard");
        if (x) x.onclick = e => { e.stopPropagation(); discardPickList(p.id); };
        const bOpen = inBatch && tr.querySelector(".pqBatchOpen");
        if (bOpen) bOpen.onclick = e => { e.stopPropagation(); openBatch(p.batchId); };
        tr.onclick = () => { currentBatchId = null; currentPickListId = p.id; renderPick(); };
        UI.wireArtHover(tr, repImg);
        box.appendChild(tr);
      }
      UI.reapplySorts();
    }
    updatePickQueueActions();
  }

  /* The ticked tickets, from selectedPickIds rather than the checkboxes on
     screen, so one the search hides is still counted and acted on (#198);
     the status line says how many of them are hidden. */
  // Picked and waiting to ship: a Walk-in ticket (#431) has no ship step.
  // An order Manapool replaced or cancelled (#489) never ships: it's cancelled and put back.
  const shippable = p => p.status === "picked" && !G.isCounterSale(p) && !G.pickOrderCancelled(p);
  const selectedPicks = () => [...selectedPickIds].map(id => G.pickLists().find(p => p.id === id)).filter(Boolean);
  const hiddenNote = picks => {
    const n = picks.filter(p => !shownPickIds.has(p.id)).length;
    return n ? " (" + n + " of them hidden by the search)" : "";
  };
  /* Enables/disables the bulk action bar based on which rows are ticked and
     what stage they're in - "go to weigh & manifest" only ever makes sense
     for exactly one ticket (a real package has one real weight), the other
     two are genuine batch actions. Without a shipping API the weigh button
     stays hidden (applyShippingMode) and the other reads "Mark shipped". */
  function updatePickQueueActions() {
    const picks = selectedPicks();
    // An open ticket in someone else's batch can't be completed from here
    // either (#212); it's left out and said so below.
    const openTicked = picks.filter(p => p.status === "open");
    const openCount = openTicked.filter(p => !completeLockReason(p)).length;
    const lockedN = openTicked.filter(p => pickLockReason(p)).length;   // a cancelled order says so below (#489)
    // A counter ticket (walk-in #431, kiosk #433) is handed over and paid on its own ticket, never marked shipped in bulk.
    const pickedCount = picks.filter(shippable).length;
    const counterN = picks.filter(p => p.status === "picked" && G.isCounterSale(p)).length;
    const goneN = picks.filter(p => G.pickOrderCancelled(p)).length;
    $("pqComplete").disabled = openCount === 0;
    // Shipped but not sent to Manapool (#454): Mark shipped sends them again.
    const retryN = picks.filter(retryable).length;
    $("pqSkipWeigh").disabled = pickedCount + retryN === 0;
    $("pqGoWeigh").disabled = pickedCount !== 1 || picks.length !== 1;
    // Pick together (#212): two or more open tickets with lines, none of
    // them already in a batch (dissolve that one first).
    const batchable = picks.filter(p => p.status === "open" && p.lines.length);
    const alreadyBatched = batchable.filter(p => p.batchId).length;
    $("pqBatch").disabled = batchable.length < 2 || alreadyBatched > 0;
    // Only tickets a bulk button can act on are counted as selected; a shipped
    // one ticked while searching is mentioned separately (PR #199 review).
    const active = picks.filter(p => p.status !== "shipped");
    const shippedN = picks.length - active.length - retryN;
    $("pqStatus").textContent = [
      active.length ? active.length + " ticket(s) selected" + hiddenNote(active) : "",
      alreadyBatched ? alreadyBatched + " already in a batch (open it with its Batch button to dissolve it first)" : "",
      lockedN ? lockedN + " being picked by someone else or with cards pulled in Warehouse Mode, so not completed from here" : "",
      counterN ? counterN + " counter ticket(s) ready to hand over: open each to take the payment" : "",
      goneN ? goneN + " cancelled on Manapool, so not completed or shipped: discard an open one, Cancel and put back a picked one" : "",
      retryN ? retryN + " not sent to Manapool: Mark shipped sends " + (retryN === 1 ? "it" : "them") + " again" : "",
      shippedN ? shippedN + " shipped ticket(s) ticked, nothing to do for " + (shippedN === 1 ? "it" : "them") : ""
    ].filter(Boolean).join(" · ");
    $("pqAll").checked = shownPickIds.size > 0 && [...shownPickIds].every(id => selectedPickIds.has(id));
  }

  /* A desk page only hears of a pull on the floor when it asks (G.catchUp, #395).
     Right before a chase or a Complete: no answer means it doesn't go ahead, and
     says so. A load replaces every ticket, so re-read them by id afterwards. */
  async function caughtUp(what, btn) {
    if ((await G.catchUp(btn)).ok) return true;
    UI.toast("Couldn't reach the server to check for cards picked on another device, so " + what +
      " Nothing changed. Check the connection and try again.", "err");
    return false;
  }
  const shortLineCount = lists => lists.reduce((s, p) => s + p.lines.filter(it => G.allocatePickLine(p, it).shortfall > 0).length, 0);
  const pickById = id => G.pickLists().find(x => x.id === id);
  /* A short line with its copies in another ticket's tote says so (owner,
     2026-11-01). Each returns the words for one short line, tote is G.pickShortTote's. */
  const shortStatus = (qty, tote) => '<span class="short-tag">short ' + qty + (tote ? " (" + G.esc(tote) + ")" : "") + "</span>";
  const shortPrinted = (qty, tote) => "SHORT " + qty + (tote ? " (" + G.esc(tote) + ")" : "");
  const shortWhere = tote => (tote ? "— none on the shelf —" : "— none in inventory —");
  // One row of a batch sheet: still open and short. All its orders share the batch's holders.
  const batchRowTote = r => (r.kind === "short" && !r.done ? G.pickShortTote(pickById(r.orders[0].pickListId), r.line) : "");
  /* The Complete question (#217): asked only when some line in what's being
     completed isn't ticked as picked. All ticked = no question. The question
     says how many, and still mentions short lines so they aren't a surprise.
     Resolves true to go ahead. */
  async function confirmUnticked(lists, shorts, lead, title) {
    const q = G.pickLinesProgress(lists), left = q.total - q.done;
    if (left <= 0 && !shorts) return true;
    let msg = lead + " This permanently removes the pulled cards from inventory.";
    if (shorts) msg += "\n\n" + shorts + " line(s) do not have enough copies and will complete short.";
    if (left > 0) msg += "\n\n" + left + " of " + q.total + " lines aren't ticked as picked. Complete anyway?";
    return UI.confirmDialog(msg, { title });
  }

  // More lines went short while the Complete question was up: they weren't agreed to.
  function pickedWhileAsked() {
    renderPick();
    UI.toast("Cards were picked on another device while you were deciding, so more lines are short now. Check the ticket, then complete it again.", "err");
  }

  async function completeSelectedPickLists() {
    const canComplete = p => p && p.status === "open" && !completeLockReason(p);
    if (!selectedPicks().some(canComplete)) return;
    const notDone = "nothing was completed.";
    if (!await caughtUp(notDone, $("pqComplete"))) return;
    const asked = selectedPicks().filter(canComplete);
    if (!asked.length) { renderPick(); return; }
    const shorts = shortLineCount(asked);
    const ids = asked.map(p => p.id);
    // Only asked if some line isn't ticked as picked (#217). A hidden ticket
    // (filtered out of view) still counts.
    const ok = await confirmUnticked(asked, shorts, "Complete " + asked.length + " pick list" + (asked.length === 1 ? "" : "s") +
      hiddenNote(asked) + "?", "Complete pick list(s)?");
    if (!ok || !await caughtUp(notDone, $("pqComplete"))) return;
    const picks = ids.map(pickById).filter(Boolean);
    if (shortLineCount(picks.filter(canComplete)) > shorts) { pickedWhileAsked(); return; }
    let shipped = 0, shortLines = 0;
    for (const p of picks) {
      if (!canComplete(p)) continue;   // a save may have landed while the question was up
      const out = G.completePickList(p.id);
      shipped += out.shipped; shortLines += out.shortLines;
    }
    G.persist("Complete " + picks.length + " pick list" + (picks.length === 1 ? "" : "s"));
    renderPick();
    renderOrders();
    UI.toast("Completed " + picks.length + " ticket(s), " + shipped + " card(s)" +
      (shortLines ? ", " + shortLines + " line(s) short" : "") + ". Undo reverses the whole batch.", "ok");
  }

  /* ---- Mark shipped, and telling Manapool (#454) ----
     Bulk and single Mark shipped, and Retry, all go through shipTickets():
     one table with a row per Manapool order (shipTable, modelled on
     Manapool's own bulk "Set all to Shipped" screen), the tickets re-read
     after it closes so one another tab shipped meanwhile isn't shipped
     twice, then the picked ones marked shipped and every Manapool order
     among them sent (pushShipped). A ticket already shipped whose order
     wasn't sent ("not sent to Manapool") is only sent again. */
  const mpSending = new Set();
  const retryable = p => G.manapoolShipFailed(p) && !mpSending.has(p.id);
  /* Which orders Manapool replaced or cancelled after their tickets were made
     (#489): asked when the page opens and right before Mark shipped. No answer
     keeps what was known (the server refuses to tell Manapool one shipped anyway). */
  async function refreshCancelled() {
    if (!meta.manapool) return;
    try { if (await G.loadCancelledOrders()) renderPick(); } catch (e) { /* the server still checks */ }
  }

  async function shipSelectedPickLists() {
    const picks = selectedPicks().filter(p => shippable(p) || retryable(p));
    if (!picks.length) return;
    await shipTickets(picks, { bulk: true });
  }

  async function shipTickets(picks, o) {
    // Manapool may have replaced or cancelled an order since this page asked (#489).
    await refreshCancelled();
    const gone = picks.filter(p => G.pickOrderCancelled(pickById(p.id) || p));
    if (gone.length) {
      const one = gone.length === 1;
      UI.toast(gone.map(p => p.id).join(", ") + (one ? " was" : " were") + " cancelled on Manapool, so " + (one ? "it isn't" : "they aren't") +
        " marked shipped. Open " + (one ? "it" : "each") + " and use Cancel and put back.", "err");
      picks = picks.filter(p => !gone.includes(p));
      renderPick();
      if (!picks.length) return;
    }
    const mp = meta.manapool ? picks.filter(G.isManapoolOrderTicket) : [];
    let tracking = new Map();
    if (mp.length) {
      tracking = await shipTable(picks, mp, o);
    } else if (o.bulk) {
      const n = picks.length + " ticket(s)" + hiddenNote(picks);
      const ok = shippingOn()
        ? await UI.confirmDialog("Skip weigh & manifest and mark " + n + " shipped? No shipping label is created - use " +
          "\"Go to weigh & manifest\" first for any of these that need one.", { title: "Skip weigh & manifest?", okLabel: "Mark shipped" })
        : await UI.confirmDialog("Mark " + n + " shipped?", { title: "Mark shipped?", okLabel: "Mark shipped" });
      if (!ok) tracking = null;
    }
    if (!tracking) return;
    // A save from another tab may have shipped (or sent) some while the table was up.
    const toShip = picks.map(p => pickById(p.id)).filter(p => p && shippable(p));
    const toRetry = picks.map(p => pickById(p.id)).filter(p => p && retryable(p));
    if (!toShip.length && !toRetry.length) { renderPick(); return; }
    if (toShip.length) {
      for (const p of toShip) G.markPickListShipped(p.id);
      G.persist("Ship " + toShip.length + " pick list" + (toShip.length === 1 ? "" : "s"));
      // A shipped list has nothing left to do - move "current" off it so the
      // Pick tab doesn't keep showing the same finished list forever. From
      // the ticket's own button, jump straight to whichever ticket still
      // needs picking/shipping next (working several orders in one sitting
      // is what this page is for); from the bulk bar, clear it.
      if (toShip.some(p => p.id === currentPickListId)) {
        const next = o.bulk ? null : G.pickLists().find(x => x.status !== "shipped" && x.lines.length);
        currentPickListId = next ? next.id : null;
      }
      renderPick();
      renderOrders();
      const sending = meta.manapool && toShip.some(G.isManapoolOrderTicket);
      UI.toast((toShip.length === 1 ? toShip[0].id + " marked shipped." : toShip.length + " tickets marked shipped.") +
        (sending ? " Telling Manapool…" : "") +
        (!o.bulk && currentPickListId ? " Opened " + currentPickListId + "." : ""), "ok");
    }
    const r = await pushShipped(toShip.concat(toRetry).map(p => p.id), tracking);
    if (r.failed.length) {
      const one = r.failed.length === 1 && r.sent === 0;
      UI.toast((one ? "Not marked shipped on Manapool: " : r.failed.length + " order(s) weren't marked shipped on Manapool (") +
        r.failed[0].rec.error + (one ? "" : ")") +
        " They stay in the queue as \"not sent to Manapool\": tick them and press Mark shipped to retry.", "err");
    } else if (r.sent) {
      UI.toast(r.sent === 1 ? "Marked shipped on Manapool too." : r.sent + " orders marked shipped on Manapool too.", "ok");
    }
  }

  /* What a row's boxes start with: what was tried last time, else a label's
     tracking number (weigh & manifest), and USPS. */
  function trackingPrefill(p) {
    const order = orderOf(p);
    const last = p.manapoolShip && p.manapoolShip.tracking;
    return {
      company: (last && last.company) || "USPS",
      number: (last && last.number) || (order && order.grimoire && order.grimoire.tracking) || ""
    };
  }
  const orderOf = p => orders.find(o => String(o.id) === String(p.orderId)) || null;
  const CARRIERS = ["USPS", "UPS", "FedEx", "DHL"];

  /* The Mark shipped table: a row per Manapool order (order number, buyer
     and city/state, Carrier, Tracking #), Set all carriers above it.
     Tracking is optional, except on a Ground Advantage order
     (G.pickNeedsTracking, or Manapool asked for it last time): that row
     says "Tracking required" and the confirm stays disabled until it has a
     number. Resolves Map(ticket id -> { company, number }) for the
     Manapool rows, or null on Cancel. */
  async function shipTable(picks, mp, o) {
    // The buyer and the shipping method come from the orders cache, which
    // the Pick list tab alone never loads.
    if (!orders.length || mp.some(p => !orderOf(p))) {
      try { orders = (await G.api("/api/manapool/orders/cached")).orders || []; } catch (e) { /* the server still checks */ }
      G.noteOrderStatuses(orders);
    }
    const required = p => G.pickNeedsTracking(p, orders) || !!(p.manapoolShip && p.manapoolShip.needsTracking);
    const shipN = picks.filter(shippable).length;
    const others = picks.length - mp.length;
    UI.ensureModal("mpShipModal", "wide", '<h3 id="mpShipTitle"></h3><div id="mpShipBody"></div>' +
      '<div class="modal-actions"><span id="mpShipErr" class="hint" style="margin:0"></span><span class="spacer"></span>' +
      '<button id="mpShipCancel" class="ghost">Cancel</button><button id="mpShipOk" class="primary"></button></div>');
    $("mpShipTitle").textContent = shipN ? "Mark shipped" : "Send to Manapool";
    const okLabel = shipN ? "Mark " + (shipN === 1 ? "1 ticket" : shipN + " tickets") + " shipped" : "Send to Manapool";
    const rowsHtml = mp.map((p, i) => {
      const order = orderOf(p);
      const ship = (order && order.ship) || {};
      const buyer = ship.name || (order && order.buyer) || "";
      const where = [ship.city, ship.state].filter(Boolean).join(", ");
      const pre = trackingPrefill(p);
      const req = required(p);
      const label = orderLabelFor(p) || G.pickListTag(p);
      return '<tr data-id="' + G.esc(p.id) + '">' +
        '<td data-label="Order" data-vs="' + G.esc(label) + '"><span class="mono">' + G.esc(label) + "</span>" +
          (req ? ' <span class="badge">Tracking required</span>' : "") +
          (retryable(p) ? ' <span class="short-tag">not sent</span>' : "") + "</td>" +
        '<td data-label="Buyer" data-vs="' + G.esc(buyer) + '">' + (buyer ? G.esc(buyer) : "—") +
          (where ? '<div class="hint" style="margin:0">' + G.esc(where) + "</div>" : "") + "</td>" +
        '<td data-label="Carrier" data-vs="' + G.esc(pre.company) + '"><input id="mpCo-' + i + '" value="' + G.esc(pre.company) +
          '" list="mpCarriers" maxlength="60" autocomplete="off" aria-label="Carrier for ' + G.esc(label) + '"></td>' +
        '<td data-label="Tracking #" data-vs="' + G.esc(pre.number) + '"><input id="mpNo-' + i + '" value="' + G.esc(pre.number) +
          '" maxlength="100" autocomplete="off" placeholder="' + (req ? "Required" : "Optional") + '"' +
          (req ? ' required aria-required="true"' : "") + ' aria-label="Tracking number for ' + G.esc(label) + '"></td></tr>';
    }).join("");
    const lead = (shipN ? (shippingOn() && o.bulk ? "No shipping label is created here - use \"Go to weigh & manifest\" first for any that need one. " : "") +
        (mp.length === 1 ? "The order is marked shipped on Manapool too." : "Each order is marked shipped on Manapool too.")
      : "Grimoire tries Manapool again for " + (mp.length === 1 ? "this order." : "these orders.")) +
      (mp.some(required) ? " Tracking is optional, except on orders marked Tracking required (Ground Advantage)." : " Tracking is optional.") +
      (others ? " " + others + " other ticket(s) are marked shipped in Grimoire only." : "") +
      (o.bulk ? hiddenNote(picks) : "");
    $("mpShipBody").innerHTML =
      '<div class="hint" style="margin-top:0">' + G.esc(lead) + "</div>" +
      '<datalist id="mpCarriers">' + CARRIERS.map(c => '<option value="' + c + '">').join("") + "</datalist>" +
      (mp.length > 1 ? '<div class="toolbar mp-ship-all"><label>Set all carriers <input id="mpShipAllCo" list="mpCarriers" ' +
        'maxlength="60" autocomplete="off" placeholder="e.g. USPS"></label><button id="mpShipAllBtn">Set all</button></div>' : "") +
      '<div class="list-wrap mp-ship-wrap"><table class="list stack-sm" id="mpShipTable" data-sort><thead><tr>' +
        "<th>Order</th><th>Buyer</th><th>Carrier</th><th>Tracking #</th></tr></thead><tbody>" + rowsHtml + "</tbody></table></div>";
    $("mpShipOk").textContent = okLabel;
    const missing = () => mp.filter((p, i) => required(p) && !String($("mpNo-" + i).value || "").trim());
    const check = () => {
      const left = missing();
      $("mpShipOk").disabled = left.length > 0;
      const why = left.length ? left.length + " order(s) still need a tracking number: " +
        left.map(p => orderLabelFor(p) || G.pickListTag(p)).join(", ") + "." : "";
      $("mpShipOk").title = why;
      $("mpShipErr").textContent = why;
      return !left.length;
    };
    // Sorting reads data-vs, so it follows what's typed.
    const keep = el => { const td = el.closest && el.closest("td"); if (td) td.dataset.vs = el.value; };
    mp.forEach((p, i) => {
      $("mpNo-" + i).oninput = e => { keep(e && e.target ? e.target : $("mpNo-" + i)); check(); };
      $("mpCo-" + i).oninput = e => keep(e && e.target ? e.target : $("mpCo-" + i));
    });
    if (mp.length > 1) {
      $("mpShipAllBtn").onclick = () => {
        const v = String($("mpShipAllCo").value || "").trim();
        if (!v) { $("mpShipAllCo").focus(); return; }
        mp.forEach((p, i) => { $("mpCo-" + i).value = v; keep($("mpCo-" + i)); });
      };
    }
    check();
    const firstEmpty = mp.findIndex((p, i) => required(p) && !String($("mpNo-" + i).value || "").trim());
    return new Promise(resolve => {
      const finish = v => { UI.onClose("mpShipModal", null); UI.hideModal("mpShipModal"); resolve(v); };
      $("mpShipCancel").onclick = () => finish(null);
      $("mpShipOk").onclick = () => {
        if (!check()) return;
        const out = new Map();
        mp.forEach((p, i) => out.set(p.id, {
          company: String($("mpCo-" + i).value || "").trim() || "USPS",
          number: String($("mpNo-" + i).value || "").trim()
        }));
        finish(out);
      };
      UI.onClose("mpShipModal", () => resolve(null));
      UI.showModal("mpShipModal", "mpNo-" + Math.max(0, firstEmpty));
    });
  }

  /* After tickets are marked shipped and saved: tell Manapool about each
     Manapool order among them, a few at a time, keep each answer on its
     ticket (G.pushShippedToManapool) and save again. A row with no tracking
     number sends none. Resolves { sent, failed: [{ id, rec }] }. */
  async function pushShipped(ids, tracking) {
    const todo = meta.manapool ? ids.map(pickById).filter(G.isManapoolOrderTicket).map(p => p.id) : [];
    if (!todo.length) return { sent: 0, failed: [] };
    for (const id of todo) mpSending.add(id);
    renderPick();
    const done = [];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++];
        const t = tracking && tracking.get(id);
        const rec = await G.pushShippedToManapool(id, t && t.number ? t : null);
        mpSending.delete(id);
        if (rec) done.push({ id, rec });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    // Orders shows them shipped now, as the server's cache does.
    for (const { id, rec } of done) {
      const p = pickById(id);
      const order = rec.ok && p && orderOf(p);
      if (order && G.orderIsOpen(order.status)) order.status = "shipped";
    }
    // Not an Undo step: what Manapool was told can't be taken back from here.
    G.persist("Mark shipped on Manapool", { undo: false });
    renderPick();
    renderOrders();
    const failed = done.filter(d => !d.rec.ok);
    return { sent: done.length - failed.length, failed };
  }

  function goToWeighSelected() {
    const picks = selectedPicks().filter(shippable);
    if (!shippingOn() || picks.length !== 1) return;
    currentPickListId = picks[0].id;
    renderPick();
    $("pickStepper").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* Discards an arbitrary open pick list by id - generalized from what used
     to be pickClear's own inline logic (which only ever discarded whichever
     one was currently showing) so the tab strip's ✕ can discard a
     DIFFERENT list without switching to it first. pickClear itself still
     just calls this with the current list's id. */
  async function discardPickList(id) {
    const p = G.pickLists().find(x => x.id === id);
    if (!p || p.status !== "open") return;
    const lock = pickLockReason(p);
    if (lock) { UI.toast(lock, "err"); return; }
    if (G.isCounterSale(p)) { cancelCounterUI(p); return; }   // a Walk-in order is cancelled, not discarded (#431)
    const ok = await UI.confirmDialog("Discard " + p.id + " (" + p.lines.length + " line(s))? This does not touch inventory.",
      { title: "Discard pick list?", danger: true });
    if (!ok) return;
    const list = G.pickLists();
    const idx = list.indexOf(p);
    if (idx >= 0) list.splice(idx, 1);
    if (currentPickListId === id) currentPickListId = null;
    G.persist("Discard " + p.id);
    renderPick();
    UI.toast(p.id + " discarded.", "ok");
  }

  /* The tick-all box in a Picked / Bagged column header (#221). states is
     one boolean per TICKABLE line (ticked or not); off is the reason the
     column is read-only ("" when it isn't). Checked = all ticked,
     indeterminate = some. apply(on) does the ticking when it's clicked. */
  function setTickAll(id, states, off, label, apply) {
    const box = $(id), n = states.length, k = states.filter(Boolean).length;
    box.checked = n > 0 && k === n;
    box.indeterminate = k > 0 && k < n;
    box.disabled = !!off || n === 0;
    box.title = off || (n === 0 ? "Nothing to tick" : "Tick all " + label);
    box.onclick = e => e.stopPropagation();
    box.onchange = () => apply(box.checked);
  }

  /* "Show where this card is" (#295): on a live pull line whose stack sits in
     a location with a sorting method. Screen only: the printouts are built
     from the allocation, not from these rows. One layout cache per render. */
  function whereHelper() {
    const layouts = G.locationLayouts();
    let byId = null;
    const spotOf = id => {
      if (!id) return null;
      if (!byId) byId = new Map(G.state.cards.map(c => [c.id, c]));
      const rec = byId.get(id);
      const lay = rec ? layouts.get(rec.locationId) : null;
      const spot = lay ? lay.locate(rec) : null;
      return spot ? { rec, spot } : null;
    };
    return {
      button: id => spotOf(id) ? " " + UI.placementButton('data-where="' + G.esc(id) + '"', "Show where this card is") : "",
      show: id => { const w = spotOf(id); if (w) UI.showPlacement(w.spot, w.rec); }
    };
  }
  function wireWhere(root, where) {
    root.querySelectorAll("[data-where]").forEach(b => {
      b.onclick = e => { e.stopPropagation(); where.show(b.dataset.where); };
    });
  }

  function renderPick() {
    // A batch whose tickets have all shipped, or that another tab dissolved,
    // is over: back to the one-ticket view.
    if (currentBatchId && !G.pickBatchLists(currentBatchId).some(x => x.status !== "shipped")) currentBatchId = null;
    renderPickQueue();
    renderPickCount();
    $("pickDetail").hidden = !!currentBatchId;
    $("batchDetail").hidden = !currentBatchId;
    if (currentBatchId) { renderBatch(); return; }
    setBatchFs(false);
    const p = currentPickList();
    const body = $("pickBody");
    if (!p) {
      $("pickHdr").textContent = "— none open";
      $("pickStepper").innerHTML = "";
      renderCounterNote(null);
      body.innerHTML = UI.emptyRow(12, { icon: "orders", title: "No pick list open.",
        hint: "Tick a row above to select it, or generate one from an order on the Orders tab, import a TCGplayer order, or use a card's Manage → Add to pick list." });
      $("pickShortSummary").textContent = "";
      setTickAll("pickAll", [], "", "picked", () => {});
      $("pickClear").disabled = true;
      $("pickPrint").disabled = true;
      renderPickActions(null);
      return;
    }
    // In someone else's batch (#212): look and print only.
    const lock = pickLockReason(p);
    $("pickClear").disabled = p.status !== "open" || !!lock;
    $("pickClear").title = lock;
    $("pickPrint").disabled = false;
    const list = p.lines;
    const cards = list.reduce((s, i) => s + i.qty, 0);
    const orderLbl = orderLabelFor(p);
    $("pickHdr").textContent = "— " + p.id + (orderLbl ? " (order " + orderLbl + ")" : "") +
      (G.isCounterSale(p) ? " (" + G.ORDER_SOURCE_NAMES[p.source].toLowerCase() + ", " + G.counterSaleName(p) + ")" : "") +
      " — " + cards + " cards over " + list.length + " line(s) — " + pickStatusText(p) +
      (p.status === "open" ? " — " + G.pickLineProgress(p).done + " of " + list.length + " lines picked" : "");
    $("pickStepper").innerHTML = renderStepper(stepFor(p), { p });
    renderCounterNote(p);
    if (!list.length) {
      body.innerHTML = UI.emptyRow(12, { icon: "orders", title: "This pick list is empty." });
      setTickAll("pickAll", [], "", "picked", () => {});
      $("pickShortSummary").textContent = "";
      renderPickActions(p, 0);
      return;
    }
    body.innerHTML = "";
    let shortLines = 0, unknownLines = 0;
    const live = p.status === "open";
    // A pick list line never stored an image URL - best-effort match against
    // a stack still owned today with the same identity (blank if it's since
    // sold out entirely, an honest gap); the row's own click still does a
    // real lookup so review works either way.
    const imgIndex = ownedImageIndex();
    const imgForLine = it => imageForLine(imgIndex, it);
    const keyMap = G.pickLineKeys(p);
    const spots = live ? whereHelper() : null;
    setTickAll("pickAll", list.map(it => G.pickLinePicked(p, G.pickKey(it), keyMap)),
      lock || (live ? "" : "Picked ticks are read-only once the ticket is completed"), "picked", on => {
        // Re-checked at the moment of the click: a batch reassign may have landed.
        if (p.status !== "open" || pickLockReason(p)) { renderPick(); return; }
        G.setPickLinesPicked(p.id, on);
        G.persist((on ? "Tick all picked lines on " : "Untick all picked lines on ") + p.id);
        renderPick();
      });
    const lineInfo = list.map(it => {
      // A still-open list needs a LIVE allocation (it's what's actually
      // being worked, and the chase-pick button below acts on it). A
      // picked/shipped list is done - re-running allocatePick() against
      // whatever inventory looks like *now* used to show a stale, often
      // misleading "short 1 - none in inventory" on an already-completed,
      // already-shipped order (reported by a real user - see BACKLOG.md's
      // #8b bug-fix note). completePickList() (core.js) now freezes what
      // actually happened onto it.pickedResult at completion time - use
      // that instead. A list completed before this fix shipped has no
      // pickedResult on file; say so honestly rather than guess.
      let pulls, shortfall, value;
      if (live) {
        const a = G.allocatePickLine(p, it);
        pulls = a.pulls.map(p2 => ({ locationId: p2.locationId, qty: p2.take, recordId: p2.recordId }));
        shortfall = a.shortfall;
        value = allocValue(a);
      } else if (it.pickedResult) {
        pulls = it.pickedResult.pulls.map(pu => ({ locationId: pu.locationId, qty: pu.qty, recordId: null }));
        shortfall = it.pickedResult.shortfall;
        value = it.pickedResult.value;
      } else {
        pulls = null; shortfall = null; value = null;
      }
      return { pulls, shortfall, value, tote: live && shortfall > 0 ? G.pickShortTote(p, it) : "" };
    });
    // Lines from a location with a sorting method come in that order (#267);
    // the printout follows this DOM order. data-idx stays the line's index.
    G.pickLineOrder(p, i => lineInfo[i].pulls).forEach(idx => {
      const it = list[idx];
      const isSealed = it.kind === "sealed";
      const { pulls, shortfall, value, tote } = lineInfo[idx];
      if (shortfall > 0) shortLines++;
      if (pulls === null) unknownLines++;
      const pullsHtml = pulls === null ? "" : pulls.map(p2 =>
        '<span class="pull">' + G.esc(G.locName(p2.locationId)) + ": " + p2.qty +
        (spots && !isSealed ? spots.button(p2.recordId) : "") +
        (live
          ? ' <button class="small ghost chase" data-rec="' + p2.recordId + '" data-take="' + p2.qty + '" data-kind="' + (isSealed ? "sealed" : "card") +
            '"' + lockedAttrs(lock, "Not actually there? Try a different location") + ">" +
            UI.icon("triangle-alert") + "</button>"
          : "") +
        "</span>").join(" ");
      const tr = document.createElement("tr");
      tr.dataset.idx = idx;
      tr.className = "click" + (shortfall > 0 ? " short" : "");
      const picked = G.pickLinePicked(p, G.pickKey(it), keyMap);
      tr.innerHTML =
        UI.artThumbTd(isSealed ? "" : imgForLine(it)) +
        '<td data-v="' + (picked ? 1 : 0) + '"><input type="checkbox" class="pickTick" aria-label="' +
          G.esc("Picked: " + it.name) + '" title="' + G.esc(lock || (live ? "Tick when this line is picked" : "Picked ticks are read-only once the ticket is completed")) + '"' +
          (picked ? " checked" : "") + (live && !lock ? "" : " disabled") + "></td>" +
        '<td class="card-name">' + (isSealed ? G.esc(it.name) : UI.cardLink(it)) + (isSealed ? "" : '<small class="sub-sm">' + G.esc((it.set || "").toUpperCase()) +
          (it.collector ? " · #" + G.esc(it.collector) : "") + (it.finish === "etched" ? " · Etched" : it.finish === "foil" ? " · Foil" : "") +
          (it.condition ? " · " + G.esc(it.condition) : "") + "</small>") + "</td>" +
        '<td class="hide-sm">' + (isSealed ? G.esc(String(it.setCode || "").toUpperCase()) : G.esc((it.set || "").toUpperCase())) + "</td>" +
        '<td class="hide-sm">' + (isSealed ? '<span class="muted">—</span>' : G.esc(it.collector || "—")) + "</td>" +
        '<td class="hide-sm">' + (isSealed ? '<span class="muted">—</span>'
          : it.finish === "etched" ? '<span class="badge etched">ETCHED</span>' : it.finish === "foil" ? '<span class="badge foil">FOIL</span>' : '<span class="muted">—</span>') + "</td>" +
        '<td class="hide-sm">' + (isSealed ? '<span class="muted">—</span>'
          : it.condition ? G.esc(G.CONDITION_NAMES[it.condition] || it.condition) : '<span class="muted">Any</span>') + "</td>" +
        G.qtyTd(it.qty) +
        '<td class="alloc">' + (pulls === null
          ? '<span class="muted" title="This list was completed before Grimoire started recording it">— not recorded —</span>'
          : (pullsHtml || '<span class="muted">' + shortWhere(tote) + "</span>")) + "</td>" +
        '<td class="num hide-sm">' + (value == null ? '<span class="muted">—</span>' : G.money(value)) + "</td>" +
        "<td>" + (pulls === null ? '<span class="muted">—</span>'
          : shortfall > 0 ? shortStatus(shortfall, tote) : '<span class="ok-tag">OK</span>') + "</td>";
      const tick = tr.querySelector(".pickTick");
      tick.onclick = e => e.stopPropagation();
      tick.onchange = ev => {
        // Re-checked at the moment of the tick: a batch reassign may have landed.
        if (!live || pickLockReason(p)) { renderPick(); return; }
        G.setPickLinePicked(p.id, G.pickKey(it), !!ev.target.checked);
        G.persist((ev.target.checked ? "Tick a picked line on " : "Untick a picked line on ") + p.id);
        renderPick();
      };
      const td = document.createElement("td");
      if (live) {
        td.innerHTML = '<button class="small"' + lockedAttrs(lock, "Remove this line") + ">" + UI.icon("x") + "</button>";
        td.querySelector("button").onclick = e => {
          e.stopPropagation();
          if (lock) return;
          G.clearPickLineTicks(p, G.pickKey(it));
          p.lines.splice(idx, 1);
          G.persist("Remove pick list line");
          renderPick();
        };
      }
      // A line that finished short on a picked ticket can still be filled (#526).
      if (!live && p.status === "picked" && shortfall > 0 && !G.pickOrderCancelled(p)) {
        td.innerHTML = '<button class="small chaseShort" title="Find the missing copies and pull them onto this ticket">' + UI.icon("triangle-alert") + " Chase</button>";
        td.querySelector("button").onclick = e => { e.stopPropagation(); chaseShortUI(p.id, G.pickKey(it), e.currentTarget); };
      }
      tr.appendChild(td);
      if (!isSealed) {
        UI.wireArtHover(tr, imgForLine(it));
        tr.onclick = () => reviewLine(it);
      }
      body.appendChild(tr);
    });
    if (spots) wireWhere(body, spots);
    body.querySelectorAll(".chase").forEach(btn => {
      btn.onclick = e => { e.stopPropagation(); if (!lock) chasePickPull(btn.dataset.rec, Number(btn.dataset.take), p, btn.dataset.kind, btn); };
    });
    $("pickShortSummary").textContent = !live && unknownLines
      ? (unknownLines === list.length ? "Completed before Grimoire started recording pick history."
        : unknownLines + " line(s) have no recorded history (completed before this existed).")
      : shortLines
        ? shortLines + " line(s) " + (live ? "still short after allocation." : "shipped short.")
        : (live ? "All lines fully allocated." : "All lines fully picked.");
    $("pickShortSummary").className = "hint " + (shortLines ? "bad" : "good");
    renderPickActions(p, shortLines);
    UI.reapplySorts();
  }

  // What this ticket (or batch) wants from this stack now; `drawn` is what the screen showed.
  function chaseExpected(p, recordId, drawn) {
    if (p.batchId) {
      return G.pickBatchSheet(p.batchId).rows.filter(r => r.recordId === recordId).reduce((n, r) => n + r.qty, 0) || drawn;
    }
    return p.lines.reduce((n, it) => n + G.allocatePickLine(p, it).pulls.filter(x => x.recordId === recordId).reduce((m, x) => m + x.take, 0), 0) || drawn;
  }

  /* A picker physically didn't find (all of) a card where Grimoire said it
     was - "not there, try somewhere else." Corrects that stack's on-hand
     count on the spot (G.chasePickAdjust) and re-renders; allocatePick() is
     recomputed fresh every render, so the same pick-priority-ranked
     allocation automatically chases the shortfall to the next-best
     location with no extra logic needed here. */
  async function chasePickPull(recordId, expected, ticket, kind, btn) {
    const notDone = "the chase wasn't applied.";
    if (!await caughtUp(notDone, btn)) return;
    let p = pickById(ticket.id);
    // Someone may have pulled copies in Warehouse Mode since this ticket was drawn.
    if (!p || pickLockReason(p)) { renderPick(); return; }
    // The pull that sent someone here may have moved this ticket off this stack.
    const taking = G.pickLinesUsingRecord(p, recordId).length;
    if (!taking) {
      renderPick();
      UI.toast("This ticket doesn't pull from there any more: cards were picked on another device. It's been updated.", "err");
      return;
    }
    const rec = (kind === "sealed" ? G.state.sealed : G.state.cards).find(x => x.id === recordId);
    const label = rec ? G.locName(rec.locationId) : "this location";
    // Copies a picker has in a tote aren't missing, and aren't on the shelf to find.
    const tote = G.toteWords(G.totesByStack().get(recordId));
    const v = await UI.promptDialog(
      "How many were actually found at " + label + "? Grimoire expected " + chaseExpected(p, recordId, expected) + "." + (tote ? " " + tote : ""),
      { title: "Chase pick", value: "0", okLabel: "Correct & re-pick" });
    if (v === null) return;
    if (!await caughtUp(notDone, btn)) return;
    p = pickById(ticket.id);
    // Someone may have pulled copies in Warehouse Mode while the question was up.
    if (!p || pickLockReason(p)) { renderPick(); return; }
    const found = Math.max(0, parseInt(v, 10) || 0);
    // The lines that pulled from this stack start their ticks over: where they
    // come from is about to change (#217).
    const affected = G.pickLinesUsingRecord(p, recordId);
    G.chasePickAdjust(recordId, found, "Chase pick while working " + p.id, kind);
    for (const l of affected) G.clearPickLineTicks(G.pickLists().find(q => q.id === l.pickListId), l.key);
    G.persist("Chase pick on " + p.id);
    renderPick();
  }

  /* Chase a short line on a picked ticket (#526): the copies are on the book in
     another bin, or the short was a mistake and the picker confirms the copy is
     in the bin. Pulled onto the ticket in one logged step. */
  async function chaseShortUI(pickListId, key, btn) {
    const notDone = "the chase wasn't applied.";
    if (!await caughtUp(notDone, btn)) return;
    const p = pickById(pickListId);
    const opt = G.chaseShortOptions(pickListId, key);
    if (!p || !opt) { renderPick(); return; }
    const line = p.lines.find(l => G.pickKey(l) === key);
    const options = [];
    if (opt.onBook.length) options.push({ value: "book", label: "On the book: take " + opt.onBook.map(x => x.qty + " from " + x.name).join(", ") });
    for (const b of opt.bins) options.push({ value: "at:" + b.locationId, label: "It's in " + b.name + ", the picker has it in hand" + (b.suggested ? " (short here)" : "") });
    const choose = { label: "Where are the copies?", options, value: opt.onBook.length ? "book" : (opt.bins[0] || {}).locationId ? "at:" + opt.bins[0].locationId : "" };
    const ok = await UI.confirmDialog(
      line.name + " is short " + opt.need + " on " + p.id + ". Copies on the book elsewhere are taken from there. " +
      "If the short was a mistake, choose the bin and confirm the copy is really there: it goes back on the book and comes straight off again, logged as a chase of this short.",
      { title: "Chase this short", okLabel: "Pull onto ticket", choose });
    if (ok !== true) return;
    if (!await caughtUp(notDone, btn)) return;
    const at = String(choose.value || "");
    const out = G.chaseShortLine(pickListId, key, at.startsWith("at:") ? { foundAt: at.slice(3) } : {});
    if (!out.ok) { UI.toast(out.error, "err"); renderPick(); return; }
    G.persist("Chase a short on " + pickListId);
    renderPick();
    UI.toast("Pulled " + out.taken + " onto " + pickListId + (out.ticketShort ? ", still short on another line." : ". Nothing is short now."), "ok");
  }

  function computeWeightFromCheckboxes(p) {
    return G.estimateShipWeight(p, {
      topLoader: $("wmTopLoader").checked,
      envelope: $("wmEnvelope").checked,
      packingList: $("wmPackingList").checked,
      pickList: $("wmPickList").checked
    });
  }

  /* The action area at the bottom of the Pick pane - what it shows depends
     entirely on the pick list's stage (open / picked / shipped), so it's
     built fresh each render rather than toggling a fixed set of hidden
     blocks. */
  function renderPickActions(p) {
    const box = $("pickActionArea");
    if (!p || !p.lines.length) { box.innerHTML = ""; return; }

    if (p.status === "open") {
      const lock = completeLockReason(p);
      const canRelease = !p.batchId && G.rfCanRelease({ kind: "ticket", id: p.id }, G.me);
      box.innerHTML = lockCallout(lock) +
        '<div class="modal-actions" style="margin-top:12px"><span class="spacer"></span>' +
        (canRelease ? '<button id="pickRelease" class="ghost" title="Give this ticket back to the open queue" aria-label="Release this ticket">Release</button>' : "") +
        '<button id="pickComplete" class="gold"' + (lock ? ' disabled title="' + G.esc(lock) + '"' : "") +
        ">Complete all lines on ticket</button></div>";
      $("pickComplete").onclick = completePickListUI;
      if (canRelease) $("pickRelease").onclick = () => releaseOnDesk({ kind: "ticket", id: p.id });
      return;
    }

    if (G.isCounterSale(p)) { renderHandOver(p, box); return; }

    if (p.status === "picked") {
      // A Manapool order can be replaced or cancelled after it's picked (#489):
      // Cancel and put back is always there; once Manapool says so, it's the only action.
      const hand = G.isManapoolOrderTicket(p) ? inHandLockReason(p) : "";
      const cancelBtn = G.isManapoolOrderTicket(p)
        ? '<button id="pickCancelMp" class="danger"' + (hand ? ' disabled title="' + G.esc(hand) + '"' : "") + ">Cancel and put back…</button>" : "";
      const wireCancel = () => { if (cancelBtn) $("pickCancelMp").onclick = () => cancelPickedOrderUI(p.id); };
      if (G.pickOrderCancelled(p)) {
        box.innerHTML = '<div class="modal-actions" style="margin-top:12px"><span class="spacer"></span>' + cancelBtn + "</div>";
        wireCancel();
        return;
      }
      const order = orders.find(o => o.id === p.orderId);
      const shipTo = order && order.ship
        ? [order.ship.name, [order.ship.city, order.ship.state].filter(Boolean).join(", ")].filter(Boolean).join(" — ")
        : "";
      // No shipping API connected (#188): nothing to weigh or label, so
      // just where it's going and the button that marks it shipped.
      if (!shippingOn()) {
        box.innerHTML =
          (shipTo ? '<div class="hint" style="margin-top:12px">Ship to: ' + G.esc(shipTo) + "</div>" : "") +
          '<div class="modal-actions" style="margin-top:12px">' + cancelBtn + '<span class="spacer"></span>' +
            '<button id="pickShipGrimoire" class="gold">Mark shipped</button></div>';
        $("pickShipGrimoire").onclick = () => shipInGrimoireUI(p);
        wireCancel();
        return;
      }
      const estimate = G.estimateShipWeight(p, { envelope: true, packingList: true, pickList: true });
      const hasSealed = p.lines.some(l => l.kind === "sealed");
      box.innerHTML =
        '<div class="callout" style="margin-top:12px"><span class="cico">' + UI.icon("scale") + '</span><div class="cbody">' +
          "<h3>Weigh &amp; Manifest</h3>" +
          (shipTo ? '<div class="hint" style="margin-top:0">Ship to: ' + G.esc(shipTo) + "</div>" : "") +
          (hasSealed ? '<div class="hint bad" style="margin-top:0">This pick list has sealed product on it - the ' +
            "estimate below only covers the card lines (sealed items have no per-unit weight on file yet). Weigh " +
            "the sealed item(s) by hand and add that to the number before creating a label.</div>" : "") +
          '<div class="fields n2" style="margin-top:8px">' +
            '<label class="row"><input type="checkbox" id="wmTopLoader"> Top loader(s)</label>' +
            '<label class="row"><input type="checkbox" id="wmEnvelope" checked> Envelope</label>' +
            '<label class="row"><input type="checkbox" id="wmPackingList" checked> Packing list</label>' +
            '<label class="row"><input type="checkbox" id="wmPickList" checked> Pick list</label>' +
            '<label>Weight (oz) <input id="odWeight" type="number" min="0" step="0.01" value="' + estimate + '"></label>' +
            '<label>Service <input id="odService" placeholder="e.g. PM"></label>' +
          "</div>" +
          '<div class="modal-actions" style="margin-top:10px"><span class="spacer"></span>' +
            '<button id="odLabel" class="gold">Create shipping label</button></div>' +
          '<div id="odLabelOut" class="hint"></div>' +
        "</div></div>" +
        '<div class="modal-actions" style="margin-top:12px">' + cancelBtn + '<span class="spacer"></span>' +
          '<button id="pickShipGrimoire" class="primary">Skip weigh &amp; manifest</button></div>';
      wireCancel();
      ["wmTopLoader", "wmEnvelope", "wmPackingList", "wmPickList"].forEach(id => {
        $(id).onchange = () => { $("odWeight").value = computeWeightFromCheckboxes(p); };
      });
      $("odLabel").onclick = () => createLabel(p);
      $("pickShipGrimoire").onclick = () => shipInGrimoireUI(p);
      return;
    }

    // shipped: and what Manapool was told (#454)
    const mp = G.isManapoolOrderTicket(p);
    const rec = p.manapoolShip;
    const failed = G.manapoolShipFailed(p);
    const sending = mpSending.has(p.id);
    const trk = rec && rec.tracking && rec.tracking.number
      ? " with " + (rec.tracking.company ? rec.tracking.company + " " : "") + "tracking " + rec.tracking.number : "";
    const when = rec && rec.at ? " " + new Date(rec.at).toLocaleString() : "";
    let head = "Shipped", note = "";
    if (sending) note = "Telling Manapool…";
    else if (failed) {
      const why = String(rec.error || "no reason given").trim();
      head = "Not sent to Manapool";
      note = "Shipped in Grimoire, but Manapool wasn't told: " + why + (/[.!?]$/.test(why) ? "" : ".") +
        (trk ? " Tried" + trk + "." : "");
    }
    else if (rec && rec.ok) note = rec.alreadyDone ? "Manapool already had this order as shipped." : "Marked shipped on Manapool" + when + trk + ".";
    else if (mp) note = "Grimoire didn't tell Manapool about this one: mark the order shipped there if you haven't already.";
    box.innerHTML =
      '<div class="callout ' + (failed ? "bad" : "ok") + '" style="margin-top:12px"><span class="cico">' +
        UI.icon(failed ? "triangle-alert" : "circle-check") + '</span><div class="cbody">' +
        "<h3>" + G.esc(head) + "</h3>" +
        (note ? '<div class="hint" style="margin-top:0">' + G.esc(note) + "</div>" : "") +
        (mp ? '<div class="modal-actions" style="margin-top:8px">' +
          (failed && !sending ? '<button id="pickMpRetry" class="gold">' + UI.icon("refresh-cw") + " Retry</button>" : "") +
          '<button id="pickOpenMp">' + UI.icon("external-link") + " Open in Manapool</button></div>" : "") +
      "</div></div>";
    if (mp) {
      $("pickOpenMp").onclick = () => window.open("https://manapool.com/seller/orders/" + encodeURIComponent(p.orderId), "_blank", "noopener");
      if (failed && !sending) $("pickMpRetry").onclick = () => shipTickets([p], {});
    }
  }

  async function completePickListUI() {
    const drawn = currentPickList();
    if (!drawn || !drawn.lines.length || completeLockReason(drawn)) return;
    const id = drawn.id, notDone = "it wasn't completed.";
    const stillOpen = p => p && p.status === "open" && p.lines.length && !completeLockReason(p);
    if (!await caughtUp(notDone, $("pickComplete"))) return;
    let p = pickById(id);
    if (!stillOpen(p)) { renderPick(); return; }
    const shorts = shortLineCount([p]);
    // Every line ticked and none short: no question (#217).
    const ok = await confirmUnticked([p], shorts, "Complete " + p.id + "?", "Complete pick list?");
    if (!ok || !await caughtUp(notDone, $("pickComplete"))) return;
    // A save from another tab may have landed while the question was up
    // (completed it already, or reassigned its batch).
    p = pickById(id);
    if (!stillOpen(p)) { renderPick(); return; }
    if (shortLineCount([p]) > shorts) { pickedWhileAsked(); return; }
    const out = G.completePickList(p.id);
    G.persist();
    renderPick();
    renderOrders();
    UI.toast("Completed " + out.shipped + " card" + (out.shipped === 1 ? "" : "s") + " on " + p.id +
      (out.shortLines ? ", " + out.shortLines + " line(s) short" : "") +
      ". Undo reverses the whole pick.", "ok");
  }

  // The ticket's own Mark shipped (also after weigh & manifest): the same table, one row.
  const shipInGrimoireUI = p => shipTickets([p], {});

  /* Manapool replaced or cancelled this ticket's order (#489): said at the top
     of the ticket, in words, with what to do instead. */
  function cancelledNote(p) {
    const gone = G.pickOrderCancelled(p);
    if (!gone) return "";
    const what = p.status === "open"
      ? "Don't pick it. Discard this ticket and the copies set aside for it are free to sell again."
      : "Don't pack or ship it. Cancel and put back (below) puts its cards in a sorting tray with their cost, to shelve with put-away, and takes the sale off the books.";
    return '<div class="callout bad" style="margin-top:12px"><span class="cico">' + UI.icon("triangle-alert") + '</span><div class="cbody">' +
      "<h3>" + G.esc("Order " + (orderLabelFor(p) || G.pickListTag(p)) + " was " + gone + " on Manapool") + "</h3>" +
      '<div class="hint" style="margin-top:0">' + G.esc(what) + "</div></div></div>";
  }

  /* A kiosk order (#433) carries the customer's email or phone, so staff can
     reach someone who doesn't come back, and any Manapool listing the server
     couldn't lower when it came in (kiosk.js noteListingWarning). */
  function renderCounterNote(p) {
    const box = $("pickCounterNote");
    if (!box) return;
    const contact = G.counterContact(p);
    const warn = G.isCounterSale(p) && p.status !== "shipped" && p.listingWarning ? String(p.listingWarning) : "";
    const link = !contact ? "" : contact.includes("@")
      ? '<a href="mailto:' + G.esc(contact) + '">' + G.esc(contact) + "</a>"
      : '<a href="tel:' + G.esc(contact.replace(/[^0-9+]/g, "")) + '">' + G.esc(contact) + "</a>";
    box.innerHTML = cancelledNote(p) + (contact ? '<div class="hint" style="margin-top:8px">' + UI.icon("user") + " " + G.esc(G.counterSaleName(p)) + " · " + link + "</div>" : "") +
      (warn ? '<div class="callout warn" style="margin-top:12px"><span class="cico">' + UI.icon("triangle-alert") +
        '</span><div class="cbody"><h3>Manapool not updated</h3><div class="hint" style="margin-top:0">' + G.esc(warn) + "</div></div></div>" : "");
  }

  /* ---------- Walk-in and kiosk tickets (#431, #433) ----------
     Picked: hand it over at the counter and record how they paid (the total
     is what was really picked). Until then it can be cancelled, which puts
     the cards back where they came from. Handed over: done, nothing to ship. */
  function renderHandOver(p, box) {
    const who = G.counterSaleName(p);
    if (p.status === "shipped") {
      const pay = p.payment || {};
      box.innerHTML =
        '<div class="callout ok" style="margin-top:12px"><span class="cico">' + UI.icon("circle-check") + '</span><div class="cbody">' +
          "<h3>Handed over</h3>" +
          '<div class="hint" style="margin-top:0">' + G.esc(who) + " paid " + G.money(pay.total || 0) +
            (pay.method ? " by " + G.esc(G.PAY_METHOD_NAMES[pay.method].toLowerCase()) : "") +
            (p.handedOverAt ? ", " + G.esc(new Date(p.handedOverAt).toLocaleString()) : "") + ". It shows on Accounting as a counter sale.</div>" +
        "</div></div>";
      return;
    }
    const total = G.counterSaleTotal(p);
    box.innerHTML =
      '<div class="callout" style="margin-top:12px"><span class="cico">' + UI.icon("receipt") + '</span><div class="cbody">' +
        "<h3>Hand over to " + G.esc(who) + "</h3>" +
        '<div class="hint" style="margin-top:0">No label or shipping: take the payment at the counter and record it here.</div>' +
        '<div class="fields n2" style="margin-top:8px">' +
          '<label>Paid by <select id="hoPay"><option value="">Choose…</option>' +
            G.PAY_METHODS.map(m => '<option value="' + m + '">' + G.esc(G.PAY_METHOD_NAMES[m]) + "</option>").join("") + "</select></label>" +
          '<div class="stat"><span class="big">' + G.money(total) + '</span><span class="lbl">Total</span></div>' +
        "</div>" +
      "</div></div>" +
      '<div class="modal-actions" style="margin-top:12px">' +
        '<button id="hoCancel" class="danger">Cancel order…</button><span class="spacer"></span>' +
        '<button id="hoDone" class="gold">Hand over and record payment</button></div>';
    $("hoDone").onclick = () => handOverUI(p.id);
    $("hoCancel").onclick = () => cancelCounterUI(p);
  }
  function handOverUI(id) {
    const method = $("hoPay").value;
    if (!method) { UI.toast("Choose how they paid first.", "err"); $("hoPay").focus(); return; }
    const p = G.handOverCounterSale(id, method);
    if (!p) { renderPick(); return; }   // another device got there first
    G.persist("Hand over " + p.id);
    renderPick();
    UI.toast(p.id + " handed over to " + G.counterSaleName(p) + ": " + G.money(p.payment.total) + " paid by " +
      G.PAY_METHOD_NAMES[method].toLowerCase() + ".", "ok");
  }
  async function cancelCounterUI(p) {
    const picked = p.status === "picked";
    const ok = await UI.confirmDialog("Cancel " + G.counterOrderWord(p) + " " + p.id + " for " + G.counterSaleName(p) + "? " +
      (picked ? "Its cards were already picked: they go back on the shelf where they came from, and the sale is taken off the books."
        : "The cards set aside for it are free to sell again."),
      { title: "Cancel this order?", okLabel: "Cancel order", cancelLabel: "Keep order", danger: true });
    if (!ok) return;
    if (!await caughtUp("it wasn't cancelled.", null)) return;
    const out = G.cancelCounterSale(p.id);
    if (!out.ok) { UI.toast(out.error, "err"); renderPick(); return; }
    if (currentPickListId === p.id) currentPickListId = null;
    G.persist("Cancel " + p.id);
    renderPick();
    UI.toast(p.id + " cancelled" + (out.putBack ? ", " + out.putBack + " card(s) put back" : "") + ".", "ok");
    const sync = await G.orderEntryListingSync("cancelled", out.pickList);
    for (const w of (sync && sync.warnings) || []) UI.toast(w, "err");
  }

  /* ---------- Cancel and put back: a picked Manapool ticket (#489) ----------
     Manapool replaced or cancelled the order after it was picked. Its copies go
     into a sorting tray (the one there is, or the one chosen here), each with its
     cost, to shelve with put-away; the ticket and its sale go. */
  const pulledOf = l => ((l.pickedResult && l.pickedResult.pulls) || []).reduce((n, x) => n + (Number(x.qty) || 0), 0);
  /* A pick from before #489 kept no copy of its stacks: where the printing has no
     stack left anywhere, its details (Scryfall id, picture) come from the card
     index, so Listings can list it again once it's put away. -> Map(pickKey -> lookupCard answer). */
  async function putBackInfo(p) {
    const out = new Map();
    for (const l of p.lines) {
      if (l.kind === "sealed" || !pulledOf(l) || l.pickedResult.pulls.every(x => x.back)) continue;
      const here = G.state.cards.some(r => r.set === l.set && String(r.collector) === String(l.collector) &&
        (r.lang || "en") === (l.lang || "en") && r.finish === (l.finish || "nonfoil"));
      if (here) continue;
      try { out.set(G.pickKey(l), await G.lookupCard(l.set, l.collector, l.lang || "en", l.finish)); } catch (e) { /* the line's own name and printing still do */ }
    }
    return out;
  }
  async function cancelPickedOrderUI(id) {
    const notDone = "it wasn't cancelled.";
    if (!await caughtUp(notDone, $("pickCancelMp"))) return;
    let p = pickById(id);
    if (!p || p.status !== "picked") { renderPick(); return; }
    const trays = G.sortingTrays();
    const gone = G.pickOrderCancelled(p);
    const label = orderLabelFor(p) || G.pickListTag(p);
    const lines = p.lines.filter(l => pulledOf(l) > 0);
    const n = lines.reduce((s, l) => s + pulledOf(l), 0);
    const cards = lines.map(l => (pulledOf(l) > 1 ? pulledOf(l) + "× " : "") + l.name +
      (l.finish && l.finish !== "nonfoil" ? " (" + (G.FINISH_NAMES[l.finish] || l.finish).toLowerCase() + ")" : "")).join(", ");
    const choose = trays.length > 1 ? { label: "Sorting tray", options: trays.map(t => ({ value: t.id, label: t.name })), value: trays[0].id } : null;
    const where = trays.length === 1 ? "into " + trays[0].name : trays.length ? "into the sorting tray you choose below" : "into a new sorting tray called \"Sorting tray\"";
    const msg = (gone ? "Manapool has order " + label + " as " + gone + ". " : "Order " + label + ". ") +
      "Cancel " + p.id + " and put its " + n + " card" + (n === 1 ? "" : "s") + (cards ? " (" + cards + ")" : "") + " " + where + "?\n\n" +
      "Each keeps its cost, ready to shelve with put-away in Warehouse Mode. The ticket goes, and its sale comes off Accounting, Statistics and the Dashboard." +
      (gone ? "" : "\n\nManapool doesn't say this order was cancelled: only do this if it isn't going out.");
    const ok = await UI.confirmDialog(msg, { title: "Cancel and put back?", okLabel: "Cancel and put back", cancelLabel: "Keep ticket", danger: true, choose });
    if (!ok) return;
    const infos = await putBackInfo(p);
    if (!await caughtUp(notDone, $("pickCancelMp"))) return;
    // A load replaces every ticket and location: read them again.
    p = pickById(id);
    if (!p || p.status !== "picked") { renderPick(); return; }
    const out = G.cancelPickedOrder(id, { trayId: choose ? choose.value : null, infoFor: l => infos.get(G.pickKey(l)) || null });
    if (!out.ok) { UI.toast(out.error, "err"); renderPick(); return; }
    if (currentPickListId === id) currentPickListId = null;
    selectedPickIds.delete(id);
    G.persist("Cancel " + id);
    renderPick();
    renderOrders();
    UI.toast(id + " cancelled: " + out.putBack + " card" + (out.putBack === 1 ? "" : "s") + " in " + out.tray.name + ", each at its cost. " +
      "Put them away into a bin you sell from (Warehouse Mode put-away), and the next Listings push can list them again.", "ok");
  }

  async function importTcgOrder() {
    const f = await G.pickFile(".csv,.tsv,.txt");
    if (!f) return;
    $("pickProgress").textContent = "Reading the order and resolving set names…";
    let sets = [];
    try { sets = await G.cards.sets(); } catch (e) {}
    const byName = new Map(sets.map(s => [String(s.name).toLowerCase(), s.code]));
    const byCode = new Set(sets.map(s => String(s.code).toLowerCase()));

    const parsed = G.parseTabularRows(f.text);
    if (!parsed) { $("pickProgress").innerHTML = '<span class="warn">That file is empty.</span>'; return; }
    const { headers, dataRows } = parsed;
    const ALI = {
      name: ["productname", "name"], setName: ["set", "setname"],
      number: ["number", "cardnumber", "collectornumber"], condition: ["condition"],
      printing: ["printing", "finish"], quantity: ["quantity", "qty", "productquantity", "itemquantity"],
      language: ["language", "lang"]
    };
    const idx = G.mapAliasHeaders(headers, ALI);
    if (idx.name == null || idx.quantity == null) {
      $("pickProgress").innerHTML = '<span class="warn">That does not look like a TCGplayer order — it needs at ' +
        "least Product Name and Quantity columns. Found: " + G.esc(headers.join(", ")) + "</span>";
      return;
    }
    const langCode = v => {
      v = String(v || "").trim().toLowerCase();
      if (!v) return "en";
      if (G.LANG_NAMES[v]) return v;
      for (const [code, nm] of Object.entries(G.LANG_NAMES)) if (nm.toLowerCase() === v) return code;
      const m = { english: "en", japanese: "ja", german: "de", french: "fr", italian: "it", spanish: "es",
        portuguese: "pt", russian: "ru", korean: "ko", "chinese simplified": "zhs", "chinese traditional": "zht" };
      return m[v] || "en";
    };
    const pl = G.newPickList({ source: "tcgplayer" });
    G.pickLists().push(pl);
    let added = 0, lines = 0, unresolved = 0;
    for (const row of dataRows) {
      const get = f2 => idx[f2] == null ? "" : String(row[idx[f2]] == null ? "" : row[idx[f2]]).trim();
      const name = get("name");
      if (!name) continue;
      const qty = G.parseWholeQty(get("quantity")) || 0;
      if (qty < 1) continue;
      const raw = get("setName").toLowerCase();
      let code = byName.get(raw) || (byCode.has(raw) ? raw : raw);
      if (raw && !byName.has(raw) && !byCode.has(raw)) unresolved++;
      const foil = G.isFoilText(get("printing")) || G.isFoilText(get("condition"));
      const condition = G.conditionCode(get("condition"));
      G.addToPickList(pl.id, { set: code, collector: get("number"), lang: langCode(get("language")), foil, condition, name, qty });
      added += qty; lines++;
    }
    currentPickListId = pl.id;
    G.persist("Import TCGplayer order to " + pl.id);
    renderPick();
    $("pickProgress").textContent = "Imported into " + pl.id + ": " + lines + " line(s) / " + added + " card(s)" +
      (unresolved ? " — " + unresolved + " set name(s) could not be matched to a code; check those lines" : "") +
      ". Buyer details were not imported.";
  }

  /* Mints (or reuses) a Grimoire invite code for a pick list, so the packing
     slip that eventually goes out with the cards can double as a low-key
     acquisition channel - it's the one piece of paper that reliably reaches
     a real person. Called from generatePickList() at generation time (not
     just at print time - a stamps-only seller running everything through
     the bulk "Mark shipped" action never prints a ticket at all,
     so that used to be the only real-world trigger and their orders never
     minted anything). /api/invite/pick-list is open to any signed-in user
     (not admin-only) - whoever's actually packing orders often isn't an
     admin - and is itself idempotent server-side, keyed by this pick list's
     id, so calling this again for the same list (generation, then again at
     print time, then again on a reprint) reuses the invite already minted
     for it instead of minting a new one each time. The in-memory cache here
     just saves a round trip within the same page visit; it is not what
     prevents duplicates - the server is. Cached only in memory, never
     persisted into the saved collection (G.persist()) - an invite code has
     no business round-tripping through an export or a friend share.
     Best-effort throughout: offline just means no promo invite this time,
     never a failure the caller has to handle.

     #138: the server now only gives a code for a pick list it already has
     in an inventory this account can work, and answers 404 otherwise. A
     list generated a moment ago only reaches the server with the next
     autosave, so a 404 waits for that save and asks once more. At print
     time it waits only if there are unsaved changes, and not for long:
     the ticket prints either way, with or without the code. Only a code
     is cached, so a miss is asked again at the next print. */
  const pickInviteCache = new Map(); // pick list id -> {code, url}
  // Resolves true when a save of this page's edits finishes, false after `ms`.
  function nextSave(ms) {
    return new Promise(resolve => {
      let sawSaving = !!G.saveState().saving, stop = null;
      const finish = ok => { clearTimeout(timer); if (stop) stop(); resolve(ok); };
      const timer = setTimeout(() => finish(false), ms);
      stop = G.on("savestate", s => {
        if (s.saving) sawSaving = true;
        else if (sawSaving && !s.dirty) finish(true);
      });
    });
  }
  async function pickInvite(p, opts) {
    if (pickInviteCache.has(p.id)) return pickInviteCache.get(p.id);
    const print = !!(opts && opts.print);
    const ask = async () => {
      const out = await G.api("/api/invite/pick-list", {
        method: "POST",
        body: {
          pickListId: p.id,
          note: "Printed with " + p.id + (orderLabelFor(p) ? " (order " + orderLabelFor(p) + ")" : "")
        }
      });
      return { code: out.invite.code, url: out.url };
    };
    let info = null;
    try {
      info = await ask();
    } catch (e) {
      try {
        if (e && e.status === 404) {
          const st = G.saveState();
          let saved = false;
          if (!print) saved = await nextSave(60000);
          else if (st.dirty || st.saving) {
            const wait = nextSave(5000);
            if (!st.saving) G.saveNow();
            saved = await wait;
          }
          if (saved) info = await ask();
        }
      } catch (e2) { /* print without it */ }
    }
    if (info) pickInviteCache.set(p.id, info);
    return info;
  }

  function pickListFooter(invite) {
    return "<b>Packed with Grimoire</b> — free inventory &amp; order software for card sellers." +
      (invite ? "<br>Get your own copy: " + G.esc(invite.url) + " · invite code <b>" + G.esc(invite.code) + "</b>" : "");
  }

  async function printPick() {
    if (currentBatchId) return printBatch();
    const p = currentPickList();
    if (!p || !p.lines.length) return;
    const btn = $("pickPrint");
    btn.disabled = true;
    try {
      const order = UI.domOrder($("pickBody"), p.lines.length);
      const lines = (order || G.pickLineOrder(p)).map(i => p.lines[i]);
      const body = lines.map(it => {
        const a = G.allocatePickLine(p, it);
        const isSealed = it.kind === "sealed";
        const tote = a.shortfall > 0 ? G.pickShortTote(p, it) : "";
        return ["\u2610", G.esc(it.name), isSealed ? G.esc(String(it.setCode || "").toUpperCase()) : G.esc((it.set || "").toUpperCase()),
          isSealed ? "—" : G.esc(it.collector || "—"),
          isSealed ? "" : (it.finish !== "nonfoil" ? G.FINISH_NAMES[it.finish] : ""),
          isSealed ? "—" : (it.condition ? G.esc(G.CONDITION_NAMES[it.condition] || it.condition) : "Any"), G.qtyBadge(it.qty),
          a.pulls.map(pl => G.esc(G.locName(pl.locationId)) + ": " + pl.take).join("<br>") || (tote ? shortWhere(tote) : "—"),
          a.shortfall > 0 ? shortPrinted(a.shortfall, tote) : "OK"];
      });
      const invite = await pickInvite(p, { print: true });
      const orderLbl = orderLabelFor(p);
      G.printList(p.id, ["Picked", "Card", "Set", "#", "Foil", "Condition", "Qty", "Pull from", "Status"], body,
        orderLbl ? "order " + orderLbl : null, pickListFooter(invite));
    } finally { btn.disabled = false; }
  }

  /* ============================== Pick together (#212) ==============================
     Several open tickets pulled from one combined sheet (one line per card
     per location, sorted by location, each saying which order(s) it's for
     by order number), then a "Sort into orders" step that goes one order at
     a time: a checklist of that order's cards to bag. Each order stays its
     own pick list - completing, weighing, shipping and accounting are per
     ticket as before, and the Pick list tab count (renderPickCount) still
     counts open tickets. The batch and its sort ticks live on the pick lists
     (core.js "Batch picking"), so they survive a reload or a second device. */
  function openBatch(batchId) {
    currentBatchId = batchId;
    batchStep = "pull";
    batchSortListId = null;
    renderPick();
    const box = $("batchDetail");
    if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  /* Full screen for the batch Pull table (#446): a class on the one live pane,
     never a copy, so ticks, sorting and links behave as on the page. */
  const FS_STEPS = [1.25, 1.5, 1.75, 2, 2.5];
  let batchFsIdx = 1, batchFsScroll = 0;
  try { const v = parseInt(localStorage.getItem("grimoire.batchFsSize"), 10); if (v >= 0 && v < FS_STEPS.length) batchFsIdx = v; } catch (e) { /* storage blocked */ }
  const batchFsOn = () => $("batchPullPane").classList.contains("batch-fs");
  function applyBatchFsSize() {
    $("batchPullPane").style.setProperty("--fs-scale", FS_STEPS[batchFsIdx]);
    $("batchFsSmaller").disabled = batchFsIdx === 0;
    $("batchFsLarger").disabled = batchFsIdx === FS_STEPS.length - 1;
    try { localStorage.setItem("grimoire.batchFsSize", String(batchFsIdx)); } catch (e) { /* storage blocked */ }
  }
  function setBatchFs(on) {
    const pane = $("batchPullPane");
    if (on === batchFsOn()) return;
    if (on) {
      batchFsScroll = window.scrollY;
      pane.classList.add("batch-fs");
      document.documentElement.classList.add("batch-fs-open");
      applyBatchFsSize();
      $("batchFsExit").focus();
    } else {
      pane.classList.remove("batch-fs");
      pane.style.removeProperty("--fs-scale");
      document.documentElement.classList.remove("batch-fs-open");
      window.scrollTo(0, batchFsScroll);
      if (!pane.hidden) $("batchFsEnter").focus({ preventScroll: true });
    }
  }
  function setBatchStep(step) {
    if (step !== "pull") setBatchFs(false);
    batchStep = step;
    renderPick();
  }

  // Gives a ticket or batch started in Warehouse Mode back to the open queue,
  // from the desk (#448). Same call and audit line as Warehouse Mode's Release.
  const startedInWm = target => (target.kind === "batch" ? G.pickBatchLists(target.id) : G.pickLists().filter(p => p.id === target.id))
    .some(p => p.status === "open" && p.rfPicker);
  async function releaseOnDesk(target) {
    // Catch up with the floor first: it may have finished or released this already.
    if (!await caughtUp("it wasn't released.", null)) return;
    if (!startedInWm(target) || !G.rfCanRelease(target, G.me)) { renderPick(); return; }
    const first = target.kind === "batch" ? G.pickBatchLists(target.id)[0] : pickById(target.id);
    const hand = (G.pickListInHand(first) || { cards: 0 }).cards;
    const what = target.kind === "batch" ? "batch" : "ticket";
    const ok = await UI.confirmDialog("Release this " + what + "? It goes back to the open queue for anyone to pick." +
      (hand ? " The " + hand + " card" + (hand === 1 ? "" : "s") + " already pulled in Warehouse Mode stay on record." : ""),
      { title: "Release " + what + "?" });
    if (!ok || !startedInWm(target) || !G.rfRelease(target, G.me)) return;
    G.persist("Released " + what + " from the desk");
    renderPick();
    UI.toast("Released. It is back in the open queue.", "ok");
  }

  function pickTogether() {
    const picks = selectedPicks().filter(p => p.status === "open" && p.lines.length);
    if (picks.length < 2 || picks.some(p => p.batchId)) return;
    // Whoever presses it is assigned (#212).
    const ids = picks.map(p => p.id);
    const why = G.pickBatchBlockers(ids, G.me);
    const id = G.createPickBatch(ids, G.me);
    if (!id) { UI.toast(why.length ? why.join(" ") : "Pick together needs at least two tickets that can be batched.", "err"); return; }
    for (const p of picks) selectedPickIds.delete(p.id);
    currentBatchId = id;
    const batched = G.pickBatchLists(id).length;
    G.persist("Pick " + batched + " tickets together");
    openBatch(id);
    UI.toast(batched + " tickets batched. Pull them from the combined sheet below." + (why.length ? " Left out: " + why.join(" ") : ""), why.length ? "err" : "ok");
  }

  const batchTags = sheet => new Map(sheet.lists.map(p => [p.id, orderTag(p)]));
  const forOrdersText = (r, tags) => r.orders.map(o => (tags.get(o.pickListId) || o.pickListId) + " ×" + o.qty).join(", ");
  const BATCH_STAGE = { open: "to pull", picked: "picked", shipped: "shipped" };
  // Set / # / Foil / Condition cells, as the one-ticket table draws them.
  function batchLineTds(it, foilCls) {
    const isSealed = it.kind === "sealed";
    const dash = '<span class="muted">—</span>';
    return '<td class="hide-sm">' + (isSealed ? G.esc(String(it.setCode || "").toUpperCase()) : G.esc((it.set || "").toUpperCase())) + "</td>" +
      '<td class="hide-sm">' + (isSealed ? dash : G.esc(it.collector || "—")) + "</td>" +
      "<td" + (foilCls ? ' class="' + foilCls + '"' : "") + ">" + (isSealed ? dash
        : it.finish === "etched" ? '<span class="badge etched">ETCHED</span>' : it.finish === "foil" ? '<span class="badge foil">FOIL</span>' : dash) + "</td>" +
      '<td class="hide-sm">' + (isSealed ? dash
        : it.condition ? G.esc(G.CONDITION_NAMES[it.condition] || it.condition) : '<span class="muted">Any</span>') + "</td>";
  }

  function renderBatch() {
    const sheet = G.pickBatchSheet(currentBatchId);
    const lists = sheet.lists;
    const toPull = lists.filter(p => p.status === "open").length;
    const cards = lists.reduce((s, p) => s + p.lines.reduce((t, l) => t + l.qty, 0), 0);
    $("pickHdr").textContent = "— batch of " + lists.length + " orders — " + cards + " cards — " +
      (toPull ? toPull + " still to pull — " + (q => q.done + " of " + q.total + " lines picked")(G.pickLinesProgress(lists.filter(p => p.status === "open"))) : "all pulled");
    $("pickClear").disabled = true;
    $("pickPrint").disabled = !sheet.rows.length;
    $("batchTitle").textContent = "Picking " + lists.length + " orders together";
    $("batchFsTitle").textContent = "Picking " + lists.length + " orders together";
    $("batchOrders").textContent = "Orders: " + lists.map(p => orderTag(p) + " (" + BATCH_STAGE[p.status] + ")").join(", ") +
      ". Each order stays its own ticket: weigh, ship and accounting work per order as usual.";
    renderBatchAssignee();
    const lock = batchLockReason(currentBatchId);
    $("batchLockNote").innerHTML = lockCallout(lock);
    $("batchFsLock").innerHTML = lockCallout(lock);
    $("batchDissolve").disabled = !!lock;
    $("batchDissolve").title = lock;
    const relTarget = { kind: "batch", id: currentBatchId };
    $("batchRelease").hidden = !(startedInWm(relTarget) && G.rfCanRelease(relTarget, G.me));
    $("batchStepPull").classList.toggle("active", batchStep === "pull");
    $("batchStepSort").classList.toggle("active", batchStep === "sort");
    $("batchPullPane").hidden = batchStep !== "pull";
    if (batchStep !== "pull") setBatchFs(false);
    $("batchSortPane").hidden = batchStep !== "sort";
    if (batchStep === "sort") renderBatchSort(sheet, lock); else renderBatchPull(sheet, lock);
  }

  /* "Being picked by <name>", in a Store only (a personal inventory has one
     person, always the assignee). An Owner or Manager also gets a picker of
     the people who can open this Store, to hand the batch to someone else
     or take it over. */
  let storeMembers = null, storeMembersLoading = false, assignSelKey = "";
  async function loadStoreMembers() {
    if (storeMembers || storeMembersLoading) return;
    storeMembersLoading = true;
    try {
      const d = await G.api("/api/orgs/mine");
      const sid = d && d.activeStoreId;
      storeMembers = ((d && d.members) || [])
        .filter(m => !m.disabled && (m.orgRole === "owner" || m.orgRole === "manager" || (sid && (m.storeIds || []).includes(sid))))
        .map(m => ({ id: String(m.id), name: m.displayName || m.username }));
    } catch (e) {
      storeMembers = []; // still offers yourself and whoever has it now
    }
    storeMembersLoading = false;
    if (currentBatchId) renderPick();
  }
  function assignOptions(who) {
    const out = [], seen = new Set();
    const add = m => { if (m && m.id && !seen.has(String(m.id))) { seen.add(String(m.id)); out.push({ id: String(m.id), name: m.name }); } };
    if (G.me) add({ id: G.me.id, name: G.me.displayName || G.me.username });
    add(who);
    for (const m of storeMembers || []) add(m);
    return out;
  }
  function renderBatchAssignee() {
    const inStore = !!(G.me && G.me.orgId);
    $("batchAssignRow").hidden = !inStore;
    if (!inStore) return;
    const who = G.pickBatchAssignee(currentBatchId);
    const mine = who && G.me && who.id === String(G.me.id);
    const isOpen = G.pickBatchIsOpen(currentBatchId);
    const named = G.pickBatchIsNamed(currentBatchId) && !G.pickBatchInHand(currentBatchId);
    $("batchAssignee").innerHTML = UI.icon("user") +
      (isOpen && who ? " Made by <b>" : named ? " Assigned to <b>" : " Being picked by <b>") + G.esc(who ? who.name : "nobody yet") + "</b>" + (mine ? " (you)" : "") +
      (isOpen ? ". Open: any picker can claim it in Warehouse Mode" + (G.canReassignPickBatch(G.me) ? ", or name one here" : "") : "");
    const canRe = G.canReassignPickBatch(G.me);
    $("batchReassignBox").hidden = !canRe;
    if (!canRe) return;
    loadStoreMembers();
    const opts = assignOptions(who);
    // Rebuilt only when the people or the assignee change, so a choice
    // being made isn't reset by an unrelated save landing.
    const key = (who ? who.id : "") + "|" + opts.map(o => o.id).join(",");
    if (key !== assignSelKey) {
      assignSelKey = key;
      const sel = $("batchAssignSel");
      sel.innerHTML = opts.map(o => '<option value="' + G.esc(o.id) + '">' + G.esc(o.name) +
        (G.me && o.id === String(G.me.id) ? " (you)" : "") + "</option>").join("");
      sel.value = who ? who.id : "";
    }
  }
  async function reassignBatch() {
    if (!currentBatchId || !G.canReassignPickBatch(G.me)) return;
    const who = G.pickBatchAssignee(currentBatchId);
    const m = assignOptions(who).find(o => o.id === $("batchAssignSel").value);
    // Naming the person it's already with still takes it out of the open pool.
    if (!m || (who && who.id === m.id && !G.pickBatchIsOpen(currentBatchId))) return;
    const hand = G.pickBatchInHand(currentBatchId);
    if (hand) {
      const ok = await UI.confirmDialog((who ? who.name : "The last picker") + " still has " + hand + " card" + (hand === 1 ? "" : "s") +
        " in hand for this batch, and they stay on record. Get them to " + m.name + " first.", { title: "Reassign this batch?", okLabel: "Reassign" });
      if (!ok || !currentBatchId) return;
    }
    G.reassignPickBatch(currentBatchId, { id: m.id, displayName: m.name }, G.me);
    G.persist("Reassign a batch to " + m.name);
    UI.toast("Batch reassigned to " + m.name + ".", "ok");
  }

  function renderBatchPull(sheet, lock) {
    const body = $("batchBody");
    const tags = batchTags(sheet);
    const open = sheet.lists.filter(p => p.status === "open");
    if (!sheet.rows.length) {
      body.innerHTML = UI.emptyRow(11, { icon: "orders", title: "Nothing to pull.", hint: "The tickets in this batch have no lines." });
      setTickAll("batchPullAll", [], "", "picked", () => {});
      $("batchPullSummary").textContent = "";
      $("batchPullActions").innerHTML = "";
      return;
    }
    body.innerHTML = "";
    const imgIndex = ownedImageIndex();
    const spots = whereHelper();
    let shortQty = 0, unknown = 0;
    // The pull rows a tick-all may change: not done, and for at least one order.
    const rowTargets = r => r.done ? [] :
      r.orders.map(o => sheet.lists.find(x => x.id === o.pickListId)).filter(Boolean);
    const pullKeyOf = r => r.key + "@" + (r.kind === "pull" ? r.locationId : r.kind);
    const allTargets = r => r.orders.map(o => sheet.lists.find(x => x.id === o.pickListId)).filter(Boolean);
    const canTickAny = !lock && sheet.rows.some(r => rowTargets(r).length);
    // Read-only (locked, or every row done): still show the real state, disabled.
    const shownRows = sheet.rows.filter(r => (canTickAny ? rowTargets(r) : allTargets(r)).length);
    setTickAll("batchPullAll", shownRows.map(r => allTargets(r).every(x => (x.pickedKeys || []).includes(pullKeyOf(r)))),
      canTickAny ? "" : (lock || "Picked ticks are read-only once the orders are completed"), "picked", on => {
        // Re-checked at the moment of the click: a reassign may have landed.
        if (batchLockReason(currentBatchId)) { renderPick(); return; }
        const perList = new Map();
        for (const r of G.pickBatchSheet(currentBatchId).rows) {
          if (r.done) continue;
          const pk = pullKeyOf(r);
          for (const o of r.orders) {
            if (!perList.has(o.pickListId)) perList.set(o.pickListId, []);
            perList.get(o.pickListId).push({ lineKey: r.key, only: [pk] });
          }
        }
        for (const [id, entries] of perList) G.setPickLinesPicked(id, on, entries);
        G.persist(on ? "Tick all picked lines in a batch" : "Untick all picked lines in a batch");
        renderPick();
      });
    sheet.rows.forEach((r, idx) => {
      const it = r.line, isSealed = it.kind === "sealed";
      if (r.kind === "short") shortQty += r.qty;
      if (r.kind === "unknown") unknown++;
      const loc = r.kind === "pull" ? G.locName(r.locationId) : "";
      const tote = batchRowTote(r);
      const chase = r.kind === "pull" && !r.done && r.recordId;
      const where = r.kind === "pull"
        ? '<span class="pull">' + G.esc(loc) + (!r.done && !isSealed ? spots.button(r.recordId) : "") + (chase
          ? ' <button class="small ghost chase"' + lockedAttrs(lock, "Not actually there? Try a different location") + ">" +
            UI.icon("triangle-alert") + "</button>" : "") + "</span>"
        : r.kind === "short" ? '<span class="muted">' + shortWhere(tote) + "</span>"
        : '<span class="muted" title="This ticket was completed before Grimoire started recording it">— not recorded —</span>';
      const status = r.kind === "short" ? shortStatus(r.qty, tote)
        : r.kind === "unknown" ? '<span class="muted">—</span>'
        : '<span class="ok-tag">' + (r.done ? "Picked" : "OK") + "</span>";
      const img = isSealed ? "" : imageForLine(imgIndex, it);
      const tr = document.createElement("tr");
      tr.dataset.idx = idx;
      tr.className = "click" + (r.kind === "short" ? " short" : "");
      // One box per combined line (#217): ticked only when that card's line
      // is ticked on every order it's for; ticking it ticks them all. Read-only
      // once the orders are completed.
      const rowLists = r.orders.map(o => sheet.lists.find(x => x.id === o.pickListId)).filter(Boolean);
      // The tick is for this row's physical pull (card + location), so the
      // same card at another location is its own box.
      const pullKey = r.key + "@" + (r.kind === "pull" ? r.locationId : r.kind);
      const picked = rowLists.length > 0 && rowLists.every(x => (x.pickedKeys || []).includes(pullKey));
      const canTick = !r.done && !lock;
      tr.innerHTML =
        UI.artThumbTd(img) +
        '<td data-v="' + (picked ? 1 : 0) + '"><input type="checkbox" class="pickTick" aria-label="' +
          G.esc("Picked for all orders: " + it.name) + '" title="' + G.esc(lock || (r.done ? "Picked ticks are read-only once the orders are completed" : "Tick when this card is picked for every order")) + '"' +
          (picked ? " checked" : "") + (canTick ? "" : " disabled") + "></td>" +
        '<td class="alloc" data-vs="' + G.esc(r.kind === "pull" ? loc : r.kind === "short" ? "none" : "not recorded") + '">' + where + "</td>" +
        '<td class="card-name">' + (it.kind === "sealed" ? G.esc(it.name) : UI.cardLink(it)) + "</td>" +
        batchLineTds(it, "hide-sm") +
        G.qtyTd(r.qty) +
        "<td>" + G.esc(forOrdersText(r, tags)) + "</td>" +
        "<td>" + status + "</td>";
      const tick = tr.querySelector(".pickTick");
      tick.onclick = e => e.stopPropagation();
      tick.onchange = ev => {
        // Re-checked at the moment of the tick: a reassign may have landed.
        if (batchLockReason(currentBatchId) || r.done) { renderPick(); return; }
        for (const x of rowLists) G.setPickLinePicked(x.id, r.key, !!ev.target.checked, [pullKey]);
        G.persist((ev.target.checked ? "Tick a picked line in a batch" : "Untick a picked line in a batch"));
        renderPick();
      };
      wireWhere(tr, spots);
      if (chase) {
        tr.querySelector(".chase").onclick = e => {
          e.stopPropagation();
          if (batchLockReason(currentBatchId)) return;
          const p = G.pickLists().find(x => x.id === r.orders[0].pickListId);
          if (p) chasePickPull(r.recordId, r.qty, p, isSealed ? "sealed" : "card", e.currentTarget);
        };
      }
      if (!isSealed) {
        UI.wireArtHover(tr, img);
        tr.onclick = () => reviewLine(it);
      }
      body.appendChild(tr);
    });
    $("batchPullSummary").textContent = shortQty
      ? shortQty + " card(s) short across the batch - the short line(s) at the bottom say which order(s) go without."
      : unknown ? unknown + " line(s) have no recorded history (completed before this existed)."
      : open.length ? "All lines fully allocated." : "All lines picked.";
    $("batchPullSummary").className = "hint " + (shortQty ? "bad" : "good");
    const box = $("batchPullActions");
    if (open.length) {
      box.innerHTML = '<div class="modal-actions" style="margin-top:12px"><span class="spacer"></span>' +
        '<button id="batchComplete" class="gold"' + (lock ? ' disabled title="' + G.esc(lock) + '"' : "") + ">Complete " + open.length + " pick list" + (open.length === 1 ? "" : "s") + "</button></div>";
      $("batchComplete").onclick = completeBatch;
    } else {
      box.innerHTML =
        '<div class="callout ok" style="margin-top:12px"><span class="cico">' + UI.icon("circle-check") + '</span><div class="cbody">' +
          "<h3>Everything is pulled</h3>" +
          '<div class="hint" style="margin-top:0">Next, sort the pile back into its orders, one order at a time.</div>' +
          '<div class="modal-actions" style="margin-top:8px"><button id="batchGoSort" class="primary">' + UI.icon("shopping-bag") +
            " Sort into orders</button></div>" +
        "</div></div>";
      $("batchGoSort").onclick = () => setBatchStep("sort");
    }
    UI.reapplySorts();
  }

  /* Completing a batch = completing each of its open tickets the normal way
     (G.completePickList), one after another in batch order - the same order
     the combined sheet allocated them in, so what comes off inventory is
     what the sheet showed. */
  async function completeBatch() {
    const batchId = currentBatchId;
    if (batchLockReason(batchId)) return;
    const notDone = "nothing was completed.";
    if (!await caughtUp(notDone, $("batchComplete"))) return;
    const stoppedBy = batchLockReason(batchId);
    if (stoppedBy) { UI.toast(stoppedBy, "err"); renderPick(); return; }
    const sheet = G.pickBatchSheet(batchId);
    const open = sheet.lists.filter(p => p.status === "open");
    if (!open.length) { renderPick(); return; }
    const s = open.length === 1 ? "" : "s";
    const shortLines = open.reduce((n, p) => n + (sheet.lines.get(p.id) || []).filter(l => l.shortfall > 0).length, 0);
    // Only asked if some order's line isn't ticked as picked (#217).
    const ok = await confirmUnticked(open, shortLines, "Complete the " + open.length + " pick list" + s + " in this batch?",
      "Complete batch?");
    if (!ok || !await caughtUp(notDone, $("batchComplete"))) return;
    // A save from another tab may have landed while the question was up
    // (PR #213 review): the batch reassigned, or tickets already completed.
    // Re-read each ticket and complete only those still open, if still ours.
    const lock = batchLockReason(batchId);
    if (lock) { UI.toast(lock, "err"); renderPick(); return; }
    if (shortLineCount(G.pickBatchLists(batchId).filter(p => p.status === "open")) > shortLines) { pickedWhileAsked(); return; }
    let pulled = 0, short = 0, done = 0;
    const gone = [];
    for (const old of open) {
      const p = G.pickLists().find(x => x.id === old.id);
      if (!p || p.status !== "open" || p.batchId !== batchId) continue;
      if (G.pickOrderCancelled(p)) { gone.push(p.id); continue; }   // #489: discarded, never completed
      const out = G.completePickList(p.id);
      pulled += out.shipped; short += out.shortLines; done++;
    }
    if (gone.length) UI.toast(gone.join(", ") + (gone.length === 1 ? " was" : " were") + " cancelled on Manapool, so not completed. Discard " +
      (gone.length === 1 ? "it" : "them") + " instead.", "err");
    if (!done) { renderPick(); return; }
    batchStep = "sort";
    batchSortListId = null;
    G.persist("Complete " + done + " batched pick list" + (done === 1 ? "" : "s"));
    renderPick();
    renderOrders();
    UI.toast("Completed " + done + " ticket(s), " + pulled + " card(s)" + (short ? ", " + short + " line(s) short" : "") +
      ". Now sort them into their orders.", "ok");
  }

  const sortDone = p => { const q = G.pickBatchSortProgress(p); return q.done === q.total; };
  function renderBatchSort(sheet, lock) {
    const lists = G.sortBagOrders(sheet.lists);
    if (!lists.length) return;
    let p = lists.find(x => x.id === batchSortListId);
    if (!p) { p = lists.find(x => !sortDone(x)) || lists[0]; batchSortListId = p.id; }
    const idx = lists.indexOf(p);
    const strip = $("batchSortOrders");
    strip.innerHTML = lists.map(x => {
      const q = G.pickBatchSortProgress(x);
      return '<button class="seg' + (x.id === p.id ? " active" : "") + '" data-id="' + G.esc(x.id) + '" title="' +
        G.esc(orderTag(x) + ": " + q.done + " of " + q.total + " line(s) bagged") + '">' +
        (sortDone(x) ? UI.icon("check") + " " : "") + G.esc(orderTag(x)) + " · " + q.done + "/" + q.total + "</button>";
    }).join("");
    strip.querySelectorAll("button[data-id]").forEach(b => {
      b.onclick = () => { batchSortListId = b.dataset.id; renderPick(); };
    });
    const pr = G.pickBatchSortProgress(p);
    $("batchSortHead").textContent = "Order " + orderTag(p) + " — " + (idx + 1) + " of " + lists.length + " — " +
      pr.done + " of " + pr.total + " line(s) bagged" + (lists.length > 1 ? " (highest order number first)" : "");

    const body = $("batchSortBody");
    const entries = sheet.lines.get(p.id) || [];
    const sorted = new Set(p.batchSorted || []);
    if (!entries.length) {
      body.innerHTML = UI.emptyRow(9, { icon: "orders", title: "This ticket has no lines." });
      setTickAll("batchSortAll", [], "", "bagged", () => {});
    } else {
      body.innerHTML = "";
      const imgIndex = ownedImageIndex();
      // Tick-all for the order shown only. It doesn't re-render after a
      // single tick, so the header box is re-synced from the bagged set.
      const syncSortAll = () => setTickAll("batchSortAll",
        entries.map(e => sorted.has(e.key)), lock, "bagged", on => {
          if (batchLockReason(currentBatchId)) { renderPick(); return; }
          for (const e of entries) G.setPickBatchSorted(p.id, e.key, on);
          G.persist((on ? "Bag all cards for " : "Un-bag all cards for ") + orderTag(p));
          renderPick();
        });
      for (const e of entries) {
        const it = e.line, isSealed = it.kind === "sealed";
        const bag = e.shortfall == null ? it.qty : Math.max(0, it.qty - e.shortfall);
        const on = sorted.has(e.key);
        const img = isSealed ? "" : imageForLine(imgIndex, it);
        const status = e.shortfall == null ? '<span class="muted" title="Completed before Grimoire started recording it">not recorded</span>'
          : e.shortfall > 0 ? '<span class="short-tag">short ' + e.shortfall + "</span>"
          : '<span class="ok-tag">OK</span>';
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td data-v="' + (on ? 1 : 0) + '"><input type="checkbox" class="bsTick" aria-label="' +
            G.esc("Bagged for " + orderTag(p) + ": " + it.name) + '"' + (on ? " checked" : "") +
            (lock ? ' disabled title="' + G.esc(lock) + '"' : "") + "></td>" +
          UI.artThumbTd(img) +
          '<td class="card-name">' + (it.kind === "sealed" ? G.esc(it.name) : UI.cardLink(it)) + "</td>" +
          batchLineTds(it, "") +
          '<td class="num">' + bag + "</td>" +
          "<td>" + status + "</td>";
        tr.querySelector(".bsTick").onchange = ev => {
          // Re-checked at the moment of the tick: a reassign may have landed.
          if (batchLockReason(currentBatchId)) { renderPick(); return; }
          G.setPickBatchSorted(p.id, e.key, !!ev.target.checked);
          G.persist((ev.target.checked ? "Bag a card for " : "Un-bag a card for ") + orderTag(p));
          if (ev.target.checked) sorted.add(e.key); else sorted.delete(e.key);
          syncSortAll();   // this table isn't re-rendered by a single tick
        };
        if (!isSealed) UI.wireArtHover(tr, img);
        body.appendChild(tr);
      }
      syncSortAll();
    }

    const next = lists.slice(idx + 1).concat(lists.slice(0, idx)).find(x => !sortDone(x));
    const box = $("batchSortDone");
    if (p.status === "open") {
      box.innerHTML = '<div class="callout warn" style="margin-top:12px"><span class="cico">' + UI.icon("triangle-alert") +
        '</span><div class="cbody"><h3>Not marked picked yet</h3><div class="hint" style="margin-top:0">This order\'s cards ' +
        "are still counted in inventory. Complete the batch on the 1. Pull step once everything is pulled.</div></div></div>";
    } else if (pr.total && pr.done === pr.total) {
      box.innerHTML =
        '<div class="callout ok" style="margin-top:12px"><span class="cico">' + UI.icon("circle-check") + '</span><div class="cbody">' +
          "<h3>Order " + G.esc(orderTag(p)) + " is bagged</h3>" +
          '<div class="hint" style="margin-top:0">' + (next
            ? "Next up: order " + G.esc(orderTag(next)) + "."
            : "Every order in this batch is sorted. Weigh and ship each one from its own ticket as usual.") + "</div>" +
          '<div class="modal-actions" style="margin-top:8px"><button id="batchOpenTicket">' + UI.icon("package") +
            " Open this order's ticket</button></div>" +
        "</div></div>";
      $("batchOpenTicket").onclick = () => { currentBatchId = null; currentPickListId = p.id; renderPick(); };
    } else {
      box.innerHTML = "";
    }
    $("batchPrevOrder").disabled = idx <= 0;
    $("batchNextOrder").disabled = idx >= lists.length - 1;
    $("batchNextOrder").textContent = idx < lists.length - 1 ? "Next order: " + orderTag(lists[idx + 1]) : "Next order";
    UI.reapplySorts();
  }
  function stepBatchOrder(delta) {
    const lists = G.sortBagOrders(G.pickBatchLists(currentBatchId));
    const idx = lists.findIndex(x => x.id === batchSortListId);
    const to = lists[idx + delta];
    if (!to) return;
    batchSortListId = to.id;
    renderPick();
  }

  // Takes the tickets out of the batch, leaving each one exactly as it is.
  // Asks first only when sort ticks would be lost.
  async function dissolveBatch() {
    const id = currentBatchId;
    const lists = G.pickBatchLists(id);
    if (!lists.length || batchLockReason(id)) return;
    const ticks = lists.reduce((n, p) => n + G.pickBatchSortProgress(p).done, 0);
    if (ticks) {
      const ok = await UI.confirmDialog("Dissolve this batch of " + lists.length + " orders? Each ticket stays as it is and " +
        "nothing in inventory changes, but the " + ticks + " line(s) already ticked off in Sort into orders will be lost.",
        { title: "Dissolve batch?", danger: true });
      if (!ok || batchLockReason(id)) return;
    }
    G.dissolvePickBatch(id);
    currentBatchId = null;
    G.persist("Dissolve a batch");
    renderPick();
    UI.toast("Batch dissolved. Its " + lists.length + " tickets are back on their own.", "ok");
  }

  // The combined sheet on paper, in the order it's sorted on screen, with
  // the order numbers on every line. No "Packed with Grimoire" footer: this
  // sheet stays with the picker, it never goes in a parcel.
  function printBatch() {
    const sheet = G.pickBatchSheet(currentBatchId);
    if (!sheet.rows.length) return;
    const tags = batchTags(sheet);
    const order = batchStep === "pull" ? UI.domOrder($("batchBody"), sheet.rows.length) : null;
    const rows = order ? order.map(i => sheet.rows[i]) : sheet.rows;
    const body = rows.map(r => {
      const it = r.line, isSealed = it.kind === "sealed";
      const tote = batchRowTote(r);
      return [
        "\u2610",
        r.kind === "pull" ? G.esc(G.locName(r.locationId)) : r.kind === "short" ? shortWhere(tote) : "— not recorded —",
        G.esc(it.name),
        isSealed ? G.esc(String(it.setCode || "").toUpperCase()) : G.esc((it.set || "").toUpperCase()),
        isSealed ? "—" : G.esc(it.collector || "—"),
        isSealed ? "" : (it.finish && it.finish !== "nonfoil" ? G.FINISH_NAMES[it.finish] : ""),
        isSealed ? "—" : (it.condition ? G.esc(G.CONDITION_NAMES[it.condition] || it.condition) : "Any"),
        G.qtyBadge(r.qty),
        G.esc(forOrdersText(r, tags)),
        r.kind === "short" ? shortPrinted(r.qty, tote) : r.kind === "unknown" ? "—" : (r.done ? "PICKED" : "OK")
      ];
    });
    G.printList("Batch pick: " + sheet.lists.length + " orders",
      ["Picked", "Pull from", "Card", "Set", "#", "Foil", "Condition", "Qty", "For orders", "Status"], body,
      "Orders " + sheet.lists.map(orderTag).join(", "), null);
  }

  /* ============================== Manapool ============================== */
  function orderLineItem(l) {
    return l.kind === "sealed"
      ? { kind: "sealed", tcgplayerProductId: l.tcgplayerProductId, name: l.name, qty: l.qty }
      : { kind: "card", set: l.set, collector: l.collector, lang: l.lang || "en",
        finish: l.finish, condition: G.conditionCode(l.condition), name: l.name, qty: l.qty };
  }
  // `pl` is the order's ticket, if it has one: its own tote is still its own.
  function orderLineAlloc(l, pl) {
    return G.allocatePick(orderLineItem(l), { sellFromOnly: true }, G.pickHolders(pl));
  }

  /* Manual, per-order pick-list generation - deliberately NOT automatic.
     Ensures the order's full detail is loaded first (the LIST endpoint never
     carries line items - see toggleOrder()'s note below, same issue), creates
     a pick list scoped to just this order, and switches to it. No Manapool
     call: their public API has no write endpoint for seller order status at
     all (confirmed against the actual spec), so there's nothing to push.
     G.ensureOrderPickList makes it once per order even when several buttons
     ask at the same time (#92). */
  async function generatePickList(order, opts) {
    opts = opts || {};
    if (!order) return null;
    // A finished order (shipped, delivered, refunded...) normally needs no
    // pick list: one would reserve stock and, if completed, take the cards
    // out of inventory a second time (#94). Ask before making one by hand.
    // Bulk generate skips these before it ever gets here.
    if (!opts.silent && !G.orderIsOpen(order.status) && !pickListForOrder(order.id)) {
      const ok = await UI.confirmDialog("Order " + (order.label || order.id) + " is " + (order.status || "finished") +
        " on Manapool, so it has probably already gone out. A pick list reserves its cards, and completing it " +
        "removes them from inventory again.\n\nGenerate a pick list anyway?",
        { title: "Order already " + (order.status || "finished") + "?", okLabel: "Generate anyway" });
      if (!ok) return null;
    }
    let out;
    try {
      out = await G.ensureOrderPickList(order, async o => {
        const d = await G.api("/api/manapool/order/" + encodeURIComponent(o.id));
        Object.assign(o, d.order);
      });
    } catch (e) {
      if (!opts.silent) UI.toast("Could not load this order's details: " + e.message, "err");
      return null;
    }
    const pl = out.pickList;
    if (!pl) {
      if (!opts.silent) UI.toast("This order has no lines to pick.", "err");
      return null;
    }
    if (!out.created) {
      if (!opts.silent) openPickList(pl.id);
      return pl;
    }
    // Mint the promo invite at generation time, not just at print time - a
    // stamps-only seller using the bulk "Mark shipped" action
    // (shipSelectedPickLists()) never calls printPick(), so
    // that was the ONLY path that ever created one; every real order now
    // gets one regardless of whether its ticket is ever actually printed.
    // Fire-and-forget (same as pickInvite()'s own best-effort design) -
    // nothing here needs the result, printPick() still fetches/reuses it by
    // pick list id (idempotent server-side) when a ticket IS printed.
    pickInvite(pl);
    if (!opts.silent) {
      G.persist("Generate " + pl.id + " for order " + (order.label || order.id));
      renderOrders();
      UI.toast("Generated " + pl.id + " for order " + (order.label || order.id) + ".", "ok");
      openPickList(pl.id);
    }
    return pl;
  }

  /* Bulk version of the above, driven by the orders table's checkboxes
     (".mppick", same select-one-or-many pattern as putaway/listings/
     bulk-price's ".ppick"/"planAll"). Each ticked order still gets its own
     independent pick list via generatePickList(..., {silent:true}) - this
     never pools multiple orders into one list, it just skips the per-order
     persist/toast/tab-switch and does one persist + one summary toast for
     the whole batch instead. */
  async function generateSelectedOrderPickLists() {
    // Keyed by order id, not row/array index - the Status filter (2026-09-20)
    // means the visible rows are a subset of `orders` and no longer share its
    // indexing, so an index would grab the wrong order the moment a filter
    // (or a re-sort) is active.
    // From selectedOrderIds (#198): ticked orders the search hides count too,
    // as the line next to the search box says.
    const ticked = tickedOrders();
    if (!ticked.length) { UI.toast("Tick one or more orders first.", "err"); return; }
    const hiddenTicked = ticked.filter(o => !shownOrderIds.has(o.id)).length;
    // Ask first only when some ticked orders are off screen (owner's call,
    // PR #199): with every one in view there's nothing to be surprised by.
    if (hiddenTicked) {
      const ok = await UI.confirmDialog(hiddenTicked + " of the " + ticked.length + " ticked orders " +
        (hiddenTicked === 1 ? "is" : "are") + " hidden by your search or status filter. Generate pick lists for all " +
        ticked.length + " anyway?", { title: "Include hidden orders?" });
      if (!ok) return;
    }
    // Finished orders (shipped, delivered, refunded...) are skipped (#94):
    // the table defaults to All statuses and the header box ticks every
    // row, so this used to make a reserving pick list for every order in
    // the cache. Open includes "error" (owner's call). One finished order
    // can still get a list from its own row, after a confirm.
    const picks = ticked.filter(o => G.orderIsOpen(o.status));
    const skipped = ticked.length - picks.length;
    if (!picks.length) {
      UI.toast("Skipped " + skipped + " finished order" + (skipped === 1 ? "" : "s") + " - nothing to generate.", "err",
        "Shipped, delivered and refunded orders are skipped. Use an order's own Generate pick button if one really needs a list.");
      return;
    }
    $("mpBulkPick").disabled = true;
    let created = 0, reused = 0, failed = 0;
    let firstPl = null;
    for (const o of picks) {
      const already = !!pickListForOrder(o.id);
      const pl = await generatePickList(o, { silent: true });
      if (!pl) failed++;
      else if (already) reused++;
      else created++;
      // Every list here is created with an orderId, so none of them ever
      // qualifies as the "orphan" currentPickList() falls back to - without
      // this, generating 3 at once left the Pick tab showing nothing at all
      // until you went back to Orders and opened one by hand. Open the
      // first one, same as generating a single order's list already does.
      if (pl && !firstPl) firstPl = pl;
    }
    if (created) G.persist("Generate " + created + " pick list" + (created === 1 ? "" : "s"));
    $("mpBulkPick").disabled = false;
    // Done with this batch: untick it, as the old redraw-from-scratch did.
    for (const o of ticked) selectedOrderIds.delete(o.id);
    renderOrders();
    const parts = [];
    if (created) parts.push("Generated " + created + " pick list" + (created === 1 ? "" : "s") + ".");
    if (reused) parts.push(reused + " already had one.");
    if (failed) parts.push(failed + " failed to load.");
    if (skipped) parts.push("Skipped " + skipped + " finished order" + (skipped === 1 ? "" : "s") + ".");
    if (picks.length > 1 && firstPl) parts.push("Opening " + firstPl.id + " - find the rest from the Orders tab.");
    UI.toast(parts.join(" "), failed && !created ? "err" : "ok");
    if (firstPl) openPickList(firstPl.id); else renderPick();
  }

  function renderOrders() {
    const body = $("mpBody");
    // A drilled-open order's detail sits in its own row directly under it -
    // the generic click-to-sort (ui.js) resorts every <tr> in the tbody with
    // no idea one of them is that detail row, which would separate it from
    // its order. Switched off wholesale while anything is expanded (same
    // pivot-nosort mechanism Movers' card/printing drill-down uses), back on
    // the moment it's collapsed since the table is flat again at that point.
    // (Toggled below, once it's known whether the open order is on screen:
    // the search or the status filter may be hiding it.)
    if (!meta.manapool) {
      $("mpNote").innerHTML = "Manapool isn't switched on for this site" + (G.isAdmin
        ? ". Set <code>manapool.enabled</code> in <code>config.json</code> and restart, then each person connects their " +
          "own account in <b>Settings → Integrations</b>."
        : "; ask the site admin. Once it is, connect your own account in <b>Settings → Integrations</b>.") +
        " Until then this tab only shows whatever was fetched before.";
      $("mpFetch").disabled = true;
    } else {
      $("mpNote").innerHTML = "Fetching goes out from the server, not your browser. Orders are cached server-side " +
        "so a picklist or a label can be reprinted without another round trip. Buyer addresses stay on the server " +
        "and are never part of an export or a share.";
    }
    if (!orders.length) {
      selectedOrderIds.clear();
      shownOrderIds = new Set();
      updateOrderSelection();
      body.innerHTML = UI.emptyRow(10, { icon: "orders", title: "No orders loaded.",
        hint: "Press <b>Fetch orders</b>" + (meta.manapool ? "." : " once Manapool is configured.") });
      return;
    }
    // Open vs finished is G.orderIsOpen (#62): unfulfilled, processing and
    // error are still to go out; shipped, delivered, refunded, replaced and
    // the like are finished (#93 - "Shipped" used to match only "shipped",
    // so a delivered order showed only under All statuses).
    const filter = $("mpStatusFilter").value;
    // The search box (#198) narrows the status filter's rows further: order
    // number and id, customer / ship-to name, card names, pick ticket number.
    const q = $("mpSearch").value.trim();
    const terms = G.searchTerms(q);
    const names = terms.length ? G.customerNameByOrder() : null;
    const visible = orders.filter(o => {
      if (filter === "open" && !G.orderIsOpen(o.status)) return false;
      if (filter === "shipped" && G.orderIsOpen(o.status)) return false;
      return !terms.length ||
        G.matchesTerms(G.orderSearchText(o, pickListForOrder(o.id), names.get(String(o.id))), terms);
    });
    const liveIds = new Set(orders.map(o => o.id));
    for (const id of selectedOrderIds) if (!liveIds.has(id)) selectedOrderIds.delete(id);
    shownOrderIds = new Set(visible.map(o => o.id));
    const expandedShown = !!expandedOrderId && shownOrderIds.has(expandedOrderId);
    $("mpTable").classList.toggle("pivot-nosort", expandedShown);
    updateOrderSelection();
    if (!visible.length) {
      body.innerHTML = terms.length
        ? UI.emptyRow(10, { icon: "search", title: "No orders match “" + G.esc(q) + "”" + (filter ? " in this status filter" : "") + ".",
          hint: "The search looks at order numbers, customer and ship-to names, card names and pick ticket numbers." })
        : UI.emptyRow(10, { icon: "search", title: "No orders match this status filter." });
      return;
    }
    body.innerHTML = "";
    visible.forEach(o => {
      const cards = (o.lines || []).reduce((s, l) => s + l.qty, 0);
      const tr = document.createElement("tr");
      tr.className = "click";
      const g = o.grimoire || {};
      const pl = pickListForOrder(o.id);
      tr.innerHTML =
        '<td><input type="checkbox" class="mppick" data-order-id="' + G.esc(o.id) + '"' +
          (selectedOrderIds.has(o.id) ? " checked" : "") + "></td>" +
        // `label` is Manapool's own order number shown to the seller (e.g.
        // "564794-2007974") - `id` is an internal UUID Grimoire needs for
        // linking pick lists and order-detail lookups, but isn't what
        // anyone would recognize an order by. Cached orders fetched before
        // this fix have no label on file yet; falling back to `id` for
        // those keeps them from showing blank until the next real refresh.
        "<td><b>" + G.esc(o.label || G.shortOrderId(o.id)) + "</b></td>" +
        // data-v: the locale date text ("10/9/2026, 9:30 AM") sorted by its
        // leading month number alone (#100); sort on the timestamp instead.
        '<td data-v="' + (Date.parse(o.placedAt) || 0) + '">' + G.esc(o.placedAt ? new Date(o.placedAt).toLocaleString() : "") + "</td>" +
        '<td><span class="pill">' + G.esc(o.status || "?") + "</span></td>" +
        '<td class="num hide-sm">' + (o.lines || []).length + "</td>" +
        '<td class="num">' + cards + "</td>" +
        '<td class="num hide-sm">' + G.money(o.total) + "</td>" +
        '<td class="hide-sm">' + G.esc([o.ship && o.ship.city, o.ship && o.ship.state, o.ship && o.ship.country]
          .filter(Boolean).join(", ")) + "</td>" +
        "<td>" + (g.shippedAt ? '<span class="pill on">shipped</span>' : "") +
          (g.labelUrl ? ' <span class="pill type">label</span>' : "") +
          (pl ? ' <span class="pill' + (pl.status === "shipped" ? " on" : pl.status === "picked" ? " type" : "") + '">' +
            G.esc(pl.id) + (pl.status !== "open" ? " " + pl.status : "") + "</span>" : "") + "</td>";
      tr.querySelector(".mppick").onclick = e => {
        e.stopPropagation();
        if (e.target.checked) selectedOrderIds.add(o.id); else selectedOrderIds.delete(o.id);
        updateOrderSelection();
      };
      const td = document.createElement("td");
      td.innerHTML = '<button class="small">' + (o.id === expandedOrderId ? "Close" : "Open") + '</button> <button class="small">' +
        (pl ? "Pick list" : "Generate pick") + '</button> <button class="small">Open in Manapool ' + UI.icon("external-link") + "</button>";
      const [btnOpen, btnPick, btnOpenMp] = td.querySelectorAll("button");
      btnOpen.onclick = e => { e.stopPropagation(); toggleOrder(o); };
      // Disable-while-pending + await fully before anything else runs, so a
      // slow first click (this often has to fetch the order's line items
      // before a pick list can even be created) can't be mistaken for
      // "nothing happened" and clicked again - generatePickList() itself
      // already handles an existing pick list / double invocation safely,
      // but the missing visual feedback was the actual complaint.
      btnPick.onclick = async e => {
        e.stopPropagation();
        btnPick.disabled = true;
        try { await generatePickList(o); } finally { btnPick.disabled = false; }
      };
      btnOpenMp.onclick = e => {
        e.stopPropagation();
        window.open("https://manapool.com/seller/orders/" + encodeURIComponent(o.id), "_blank", "noopener");
      };
      tr.appendChild(td);
      tr.onclick = () => toggleOrder(o);
      body.appendChild(tr);
      // Drill-down, not a separate panel at the bottom of the page (2026-09-20
      // ask - modeled after Movers' card/printing expand): the detail content
      // lives in a row directly under whichever order is open, rebuilt every
      // renderOrders() call so a background refresh (fetchOrders()'s periodic
      // status re-check) keeps an already-open order current without a
      // second fetch of its own. Only one order open at a time.
      if (o.id === expandedOrderId) {
        const detailTr = buildOrderDetailRow(o);
        body.appendChild(detailTr);
        renderOrderDetail(o);
      }
    });
    // Typing in the search redraws on every key: keep the user's column
    // sort (only the tbody is redrawn). Not while an order is drilled open.
    if (!expandedShown) UI.reapplySorts($("paneOrders"));
  }

  /* Ticked orders live in selectedOrderIds, not just in the checkboxes, so
     a redraw (the search, the status filter, a background refresh) doesn't
     untick them, and one the search hides is still ticked (#198). The line
     next to the search box says how many are ticked and how many of those
     are hidden; Generate pick lists acts on all of them. */
  let selectedOrderIds = new Set();
  let shownOrderIds = new Set();
  const tickedOrders = () => orders.filter(o => selectedOrderIds.has(o.id));
  function updateOrderSelection() {
    const ticked = tickedOrders();
    const hidden = ticked.filter(o => !shownOrderIds.has(o.id)).length;
    $("mpSel").textContent = ticked.length
      ? ticked.length + " ticked" + (hidden ? " · " + hidden + " hidden by the search or status filter" : "") : "";
    $("mpAll").checked = shownOrderIds.size > 0 && [...shownOrderIds].every(id => selectedOrderIds.has(id));
  }

  /* The order-detail drill-down row a click on an order inserts directly
     beneath it (2026-09-20 ask - previously a fixed section pinned to the
     bottom of the page regardless of where the clicked order was in a long
     list, modeled after Movers' card/printing expand instead). colSpan
     matches mpTable's 10 header cells. IDs inside (odTitle/odBody/odShip/
     odPick/odOpenMp) are safe to reuse via plain getElementById because only
     one order is ever expanded at a time - renderOrders() always tears the
     previous detail row down before a different one goes up. */
  function buildOrderDetailRow(o) {
    const tr = document.createElement("tr");
    tr.className = "order-detail-row";
    const td = document.createElement("td");
    td.colSpan = 10;
    td.innerHTML =
      '<div class="order-detail">' +
        '<div class="sec-head"><h3 id="odTitle"></h3><span class="muted" id="odMeta"></span></div>' +
        '<div class="grid2">' +
          '<div><h4>Lines</h4><div class="list-wrap"><table class="list" data-sort><thead><tr>' +
            '<th></th><th>Card</th><th class="hide-sm">Set</th><th class="hide-sm">#</th><th>Foil</th><th class="num">Qty</th><th>Pull from</th><th>Status</th>' +
            '</tr></thead><tbody id="odBody"></tbody></table></div></div>' +
          '<div><h4>Ship to</h4><div class="move-box" id="odShip"></div>' +
            '<div class="modal-actions" style="margin-top:10px">' +
              '<button id="odPick" class="primary">Generate pick list</button>' +
              '<button id="odOpenMp">' + UI.icon("external-link") + " Open in Manapool</button>" +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>";
    tr.appendChild(td);
    return tr;
  }

  function renderOrderDetail(o) {
    $("odTitle").textContent = "Order " + (o.label || G.shortOrderId(o.id));
    $("odMeta").textContent = [o.placedAt ? new Date(o.placedAt).toLocaleString() : "", o.status,
      G.money(o.total)].filter(Boolean).join(" · ");
    const odLines = o.lines || [];
    const odImgIndex = ownedImageIndex();
    // Once this order's ticket has been picked/shipped, the cards it drew on
    // are already gone from inventory (or long since reallocated to
    // something else) - re-running allocatePick() here against *current*
    // inventory would show the same stale, misleading "short"/wrong-location
    // picture renderPick() used to before it started trusting the frozen
    // pickedResult snapshot (see that function's own comment on
    // completePickList()). Reuse that same snapshot here instead of
    // recomputing live, matched back to this order's lines by identity.
    const pl = pickListForOrder(o.id);
    const live = !pl || pl.status === "open";
    const frozenByKey = new Map();
    if (!live) for (const it of pl.lines) if (it.pickedResult) frozenByKey.set(lineIdentity(it), it.pickedResult);
    $("odBody").innerHTML = odLines.map((l, idx) => {
      const isSealed = l.kind === "sealed";
      let pulls, shortfall, unknown = false, tote = "";
      if (live) {
        const a = orderLineAlloc(l, pl);
        pulls = a.pulls.map(p => ({ locationId: p.locationId, qty: p.take }));
        shortfall = a.shortfall;
        if (shortfall > 0) tote = G.pickShortTote(pl, orderLineItem(l), { sellFromOnly: true });
      } else {
        const fr = frozenByKey.get(lineIdentity(l));
        if (fr) { pulls = fr.pulls.map(p => ({ locationId: p.locationId, qty: p.qty })); shortfall = fr.shortfall; }
        else { pulls = null; shortfall = null; unknown = true; }
      }
      return '<tr class="click' + (shortfall > 0 ? " short" : "") + '" data-idx="' + idx + '">' +
        UI.artThumbTd(isSealed ? "" : imageForLine(odImgIndex, l)) +
        '<td class="card-name">' + (isSealed ? G.esc(l.name) : UI.cardLink(l)) + "</td>" +
        '<td class="hide-sm">' + (isSealed ? G.esc(String(l.setCode || "").toUpperCase()) : G.esc((l.set || "").toUpperCase())) + "</td>" +
        '<td class="hide-sm">' + (isSealed ? "—" : G.esc(l.collector || "—")) + "</td>" +
        "<td>" + (isSealed ? "—" : (l.finish !== "nonfoil" ? G.esc(G.FINISH_NAMES[l.finish]) : "—")) + "</td>" +
        G.qtyTd(l.qty) +
        '<td class="alloc">' + (unknown
          ? '<span class="muted" title="This ticket was completed before Grimoire started recording pick history">— not recorded —</span>'
          : (pulls.map(p => '<span class="pull">' + G.esc(G.locName(p.locationId)) +
            ": " + p.qty + "</span>").join(" ") || '<span class="muted">' + (tote ? shortWhere(tote) : "— not in inventory —") + "</span>")) + "</td>" +
        "<td>" + (unknown ? '<span class="muted">—</span>' : shortfall > 0 ? shortStatus(shortfall, tote)
          : '<span class="ok-tag">OK</span>') + "</td></tr>";
    }).join("") || UI.emptyRow(8, { icon: "orders", title: "This order has no lines." });
    $("odBody").querySelectorAll("tr").forEach((tr, i) => {
      const l = odLines[i];
      if (!l || l.kind === "sealed") return;
      UI.wireArtHover(tr, imageForLine(odImgIndex, l));
      tr.onclick = () => reviewLine(l);
    });
    UI.reapplySorts();

    const s = o.ship || {};
    $("odShip").innerHTML = [s.name, s.company, s.line1, s.line2,
      [s.city, s.state, s.postal].filter(Boolean).join(" "), s.country]
      .filter(Boolean).map(x => G.esc(x)).join("<br>") ||
      '<span class="muted">Manapool returned no shipping address on this order.</span>';

    $("odPick").onclick = async () => {
      const btn = $("odPick");
      btn.disabled = true;
      try { await generatePickList(o); } finally { btn.disabled = false; }
    };
    $("odOpenMp").onclick = () => window.open("https://manapool.com/seller/orders/" + encodeURIComponent(o.id), "_blank", "noopener");
  }

  /* Manapool's order LIST endpoint (what fetchOrders() below reads) never
     includes line items, the buyer's name, or the shipping address - only
     the single-order endpoint does. Opening an order fetches that endpoint
     and folds the result into `orders` (so the table's line/card counts
     catch up), same as before - the difference is only where the result
     lands (see buildOrderDetailRow's comment). Always re-fetches on open,
     even for an order looked at earlier this session, so reopening one
     picks up anything that changed on Manapool's side since. */
  async function toggleOrder(o) {
    if (expandedOrderId === o.id) { expandedOrderId = null; renderOrders(); return; }
    expandedOrderId = o.id;
    renderOrders();
    $("odBody").innerHTML = UI.skeletonRows(8, 4);
    $("odShip").innerHTML = "";

    let full;
    try {
      const d = await G.api("/api/manapool/order/" + encodeURIComponent(o.id));
      full = d.order;
    } catch (e) {
      if (expandedOrderId !== o.id) return; // collapsed, or a different order opened, while this was loading
      $("odBody").innerHTML = UI.emptyRow(8, { icon: "error", title: G.esc("Could not load this order's details: " + e.message) });
      return;
    }
    if (expandedOrderId !== o.id) return;
    Object.assign(o, full);
    renderOrders();
  }

  async function fetchOrders(cachedOnly) {
    $("mpStatus").textContent = cachedOnly ? "Loading the cache…" : "Fetching from Manapool…";
    $("mpFetch").disabled = true;
    try {
      if (cachedOnly) {
        const d = await G.api("/api/manapool/orders/cached");
        orders = d.orders || [];
      } else {
        // No `limit` here anymore - the server now pages through everything
        // genuinely new (via Manapool's `since`, anchored on what's already
        // cached) rather than a fixed page size that silently cut off a
        // seller's actual newest orders once they had more than one page's
        // worth. See server/index.js's /api/manapool/orders route.
        const d = await G.api("/api/manapool/orders");
        orders = d.orders || [];
      }
      $("mpStatus").textContent = orders.length + " order" + (orders.length === 1 ? "" : "s");
      G.noteOrderStatuses(orders);   // a ticket whose order is now replaced shows it (#489)
      // Every buyer becomes a customer (#50, Customers page). Only the buyer
      // id, recipient name and order id are copied, never the address.
      const synced = G.syncCustomersFromOrders(orders);
      if (synced.created || synced.linked) G.persist("Customers from orders");
    } catch (e) {
      $("mpStatus").textContent = "";
      UI.toast("Manapool: " + e.message, "err",
        e.status === 501 ? "Turn it on in config.json (an administrator does this), then connect your account in Settings → Integrations."
          : "The paths and header names live in config.json under manapool - check them against Manapool's current API docs.");
    }
    $("mpFetch").disabled = !meta.manapool;
    renderOrders();
  }

  async function createLabel(p) {
    if (!p || !p.orderId) return;
    if (!meta.shipping) {
      UI.toast("Shipping labels are not configured on this server.", "err",
        "An administrator sets pitneyBowes.enabled, apiKey, apiSecret, shipperId and the from-address in config.json.");
      return;
    }
    const btn = $("odLabel");
    btn.disabled = true;
    $("odLabelOut").textContent = "Asking Pitney Bowes for a label…";
    try {
      const out = await G.api("/api/shipping/label", {
        method: "POST",
        body: {
          orderId: p.orderId,
          weightOz: parseFloat($("odWeight").value) || undefined,
          service: $("odService").value.trim() || undefined
        }
      });
      const order = orders.find(o => o.id === p.orderId);
      if (order) order.grimoire = Object.assign({}, order.grimoire, { labelUrl: out.labelUrl, tracking: out.tracking });
      $("odLabelOut").innerHTML = out.labelUrl
        ? 'Label created: <a href="' + G.esc(out.labelUrl) + '" target="_blank" rel="noopener">open the PDF</a>' +
          (out.tracking ? " · tracking " + G.esc(out.tracking) : "") +
          (out.totalCharge != null ? " · " + G.money(out.totalCharge) : "")
        : "Pitney Bowes accepted the shipment but returned no label URL. Check the raw response in the server log.";
    } catch (e) {
      $("odLabelOut").innerHTML = '<span class="bad">' + G.esc(e.message) + "</span>";
    }
    btn.disabled = false;
  }

  /* The static parts of lists.html are written for "no shipping API" (#188).
     Once /api/meta has answered, show or hide the weigh step's parts to
     match, and redraw the Pick tab if it's already showing. */
  function applyShippingMode() {
    const on = shippingOn();
    $("pqGoWeigh").hidden = !on;
    $("pqSkipWeigh").textContent = on ? "Skip weigh & manifest → mark shipped" : "Mark shipped";
    if (!$("panePick").hidden) renderPick();
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    try { meta = (await G.api("/api/meta")) || {}; } catch (e) { meta = {}; }
    applyShippingMode();

    $("pickBackToOrders").onclick = () => tabs.show("orders");

    $("pickImport").onclick = importTcgOrder;
    $("pickPrint").onclick = printPick;
    $("pickClear").onclick = () => {
      const p = currentPickList();
      if (p) discardPickList(p.id);
    };
    // Select all = every ticket on screen (the search's matches), kept in
    // selectedPickIds so the next redraw doesn't untick them.
    $("pqAll").onchange = () => {
      for (const id of shownPickIds) {
        if ($("pqAll").checked) selectedPickIds.add(id); else selectedPickIds.delete(id);
      }
      renderPickQueue();
    };
    $("pqSearch").addEventListener("input", renderPickQueue);
    $("pqComplete").onclick = completeSelectedPickLists;
    $("pqSkipWeigh").onclick = shipSelectedPickLists;
    $("pqGoWeigh").onclick = goToWeighSelected;
    $("pqBatch").onclick = pickTogether;
    $("batchStepPull").onclick = () => setBatchStep("pull");
    $("batchStepSort").onclick = () => setBatchStep("sort");
    $("batchClose").onclick = () => { setBatchFs(false); currentBatchId = null; renderPick(); };
    $("batchFsEnter").onclick = () => setBatchFs(true);
    $("batchFsExit").onclick = () => setBatchFs(false);
    $("batchFsSmaller").onclick = () => { if (batchFsIdx > 0) { batchFsIdx--; applyBatchFsSize(); } };
    $("batchFsLarger").onclick = () => { if (batchFsIdx < FS_STEPS.length - 1) { batchFsIdx++; applyBatchFsSize(); } };
    // Capture phase: decide before ui.js's Esc handler closes a modal, so an
    // open card panel / slide-over / confirm gets the Esc, not the overlay.
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !batchFsOn()) return;
      if ((UI.topModal && UI.topModal()) || document.querySelector(".modal-backdrop:not([hidden])")) return;
      setBatchFs(false);
    }, true);
    $("batchDissolve").onclick = dissolveBatch;
    $("batchRelease").onclick = () => releaseOnDesk({ kind: "batch", id: currentBatchId });
    $("batchReassign").onclick = reassignBatch;
    $("batchPrevOrder").onclick = () => stepBatchOrder(-1);
    $("batchNextOrder").onclick = () => stepBatchOrder(1);

    $("mpFetch").onclick = () => fetchOrders(false);
    $("mpCached").onclick = () => fetchOrders(true);
    $("mpStatusFilter").onchange = renderOrders;
    // Select all = every order on screen (status filter + search).
    $("mpAll").onchange = () => {
      for (const id of shownOrderIds) {
        if ($("mpAll").checked) selectedOrderIds.add(id); else selectedOrderIds.delete(id);
      }
      renderOrders();
    };
    $("mpSearch").addEventListener("input", renderOrders);
    $("mpBulkPick").onclick = generateSelectedOrderPickLists;

    G.on("change", () => {
      renderPickCount();
      if (!$("panePick").hidden) renderPick();
    });
    renderPickCount();
    refreshCancelled();

    // /lists.html?order=<id>: the Customers page's order history links
    // here. Open that order from the cache instead of a fresh Manapool fetch.
    const deepOrder = new URLSearchParams(location.search).get("order");
    // /lists.html?pick=<ticket id>: a ticket named elsewhere (Walk-in Order's waiting list, #431).
    const deepPick = new URLSearchParams(location.search).get("pick");
    const pickOk = !!deepPick && G.pickLists().some(p => p.id === deepPick);
    // The deep order is fetched below, so the tab opening must not also auto-load.
    if (deepOrder && !pickOk) ordersAutoLoaded = true;
    // The tab is remembered (UI.pageTabs); a deep link below wins over it.
    tabs = UI.pageTabs({ tabs: [
      { id: "pick", button: "tabPick", panes: ["panePick"] },
      { id: "orders", button: "tabOrders", panes: ["paneOrders"] }
    ], def: "orders", onShow: onTab });
    if (pickOk) {
      openPickList(deepPick);
    } else if (deepOrder) {
      tabs.show("orders");
      await fetchOrders(true);
      const o = orders.find(x => String(x.id) === deepOrder);
      if (o) toggleOrder(o);
      else UI.toast("That order is no longer in the orders cache.", "err", "Press Fetch orders to load it from Manapool.");
    }
  });
})();
