
"use strict";
(function () {
  const $ = UI.$;
  let proposals = [];
  // #139: trades.html?proposal=<id> (a notification) opens that proposal:
  // its tab, scrolled to and marked. Handled once, on the first load.
  let deepProposal = new URLSearchParams(location.search).get("proposal");

  let tabs;

  /* ---------- Trades made in person (#335) ----------
     Recorded with "Record a trade" (js/tradeRecord.js); kept in the
     inventory's own document (G.state.trades), drawn newest first
     (G.tradesNewestFirst: a merged save can leave them out of order). */
  function recordedLineRows(lines) {
    return (lines || []).map(l =>
      '<tr data-img="' + G.esc(l.imageUrl || "") + '">' + UI.artThumbTd(l.imageUrl) +
      '<td class="card-name">' + UI.cardLink(l, l.name || "(unnamed card)") + "</td>" +
      '<td class="muted hide-sm">' + G.esc(G.printingLabel(l.set, l.collector)) +
        (l.finish && l.finish !== "nonfoil" ? " · " + G.esc(G.FINISH_NAMES[l.finish] || l.finish) : "") + "</td>" +
      '<td class="num">' + (l.qty > 1 ? l.qty + "× " : "") + (l.price == null ? '<span class="muted">no price</span>' : G.money(l.price)) + "</td></tr>"
    ).join("") || UI.emptyRow(4, { title: "Nothing." });
  }
  function tradeDate(t) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date || "");
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(t.ts);
    return isNaN(d) ? "" : d.toLocaleDateString();
  }
  function recordedCard(t) {
    const diff = Math.round((t.gotValue - t.gaveValue) * 100) / 100;
    const bits = [diff ? "You came out " + G.money(Math.abs(diff)) + (diff > 0 ? " ahead" : " behind") + " by value." : "Even by value."];
    const un = (t.gaveUnpriced || 0) + (t.gotUnpriced || 0);
    if (un) bits.push(G.unpricedNote(un, false) + ".");
    if (t.got.length) bits.push(t.costTotal == null ? "The cards you got have no cost." : "The cards you got took " + G.money(t.costTotal) + " as their cost.");
    return '<div class="move-box" data-trade="' + G.esc(t.id) + '">' +
      '<div class="row" style="justify-content:space-between;align-items:center">' +
        "<strong>" + G.esc(t.who ? "With " + t.who : "Trade") + "</strong>" +
        '<span class="muted">' + G.esc(tradeDate(t)) + "</span>" +
      "</div>" +
      (t.note ? '<div class="muted" style="font-size:11.5px;margin:2px 0 0">' + G.esc(t.note) + "</div>" : "") +
      '<div class="grid2" style="margin-top:8px">' +
        '<div><div class="muted" style="margin-bottom:4px">You gave — ' + G.money(t.gaveValue) + "</div>" +
          '<div class="list-wrap"><table class="list"><tbody>' + recordedLineRows(t.gave) + "</tbody></table></div></div>" +
        '<div><div class="muted" style="margin-bottom:4px">You got — ' + G.money(t.gotValue) + "</div>" +
          '<div class="list-wrap"><table class="list"><tbody>' + recordedLineRows(t.got) + "</tbody></table></div></div>" +
      "</div>" +
      '<div class="modal-actions" style="margin-top:10px"><span class="muted" style="font-size:12px">' + G.esc(bits.join(" ")) + "</span>" +
        '<span class="spacer"></span><button class="small ghost" data-act="delete">Delete record</button></div>' +
      "</div>";
  }
  function renderRecorded() {
    const list = G.tradesNewestFirst(G.state.trades);
    $("recHdr").textContent = list.length ? "— " + list.length + " total" : "";
    $("recList").innerHTML = list.length
      ? list.map(recordedCard).join("")
      : UI.emptyBlock({ icon: "people", title: "No trades recorded yet.",
          hint: "Traded cards with someone in person? Press <b>Record a trade</b> above." });
    $("recList").querySelectorAll("table.list tbody tr[data-img]").forEach(tr => {
      if (tr.dataset.img) UI.wireArtHover(tr, tr.dataset.img);
    });
    $("recList").querySelectorAll(".move-box").forEach(el => {
      el.querySelector('[data-act="delete"]').onclick = async () => {
        const ok = await UI.confirmDialog("Delete this trade from your history? Your cards stay as they are.",
          { title: "Delete trade record?", danger: true, okLabel: "Delete" });
        if (!ok) return;
        G.deleteTrade(el.dataset.trade);
        G.persist("delete trade record");
      };
    });
  }

  const total = lines => (lines || []).reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 1), 0);

  function lineRows(lines) {
    return (lines || []).map(l =>
      '<tr data-img="' + G.esc(l.imageUrl || "") + '">' + UI.artThumbTd(l.imageUrl) +'<td class="card-name">' + (l.name ? UI.cardLink(l) : '<span class="muted">(unnamed card)</span>') + "</td>" +
      '<td class="muted">' + (l.set ? G.esc(G.printingLabel(l.set, l.collector)) : "") +
        (l.finish && l.finish !== "nonfoil" ? " · " + G.esc(G.FINISH_NAMES[l.finish] || l.finish) : "") + "</td>" +
      '<td class="num">' + (l.qty > 1 ? l.qty + "× " : "") + G.money(l.price) + "</td>" +
      "<td>" + (l.role === "filler" ? '<span class="muted">filler</span>' : '<span class="badge sale">main</span>') + "</td></tr>"
    ).join("");
  }

  const STATUS_PILL = {
    open: '<span class="pill">Open</span>',
    accepted: '<span class="pill type">Accepted</span>',
    declined: '<span class="short-tag">Declined</span>',
    withdrawn: '<span class="muted">Withdrawn</span>'
  };

  /* #128: a side that acted from a store is named by the store, with the
     person who sent it or was sent it alongside. */
  const myName = () => (G.me && G.me.username) || "";
  function headline(p, direction) {
    if (direction === "outgoing") {
      return "To " + p.toUsername + (p.toStoreName ? " for " + p.toStoreName : "");
    }
    return "From " + (p.fromStoreName ? p.fromStoreName + " (sent by " + p.fromUsername + ")" : p.fromUsername);
  }
  function subline(p, direction, when) {
    const bits = [when];
    if (direction === "outgoing" && p.fromStoreName) {
      bits.push("from " + p.fromStoreName + (p.fromUsername !== myName() ? ", sent by " + p.fromUsername : ""));
    }
    if (direction === "incoming" && p.toStoreName) {
      bits.push("to " + p.toStoreName + (p.toUsername !== myName() ? ", addressed to " + p.toUsername : ""));
    }
    if (p.status !== "open" && p.statusReason) bits.push(STATUS_WORD[p.status] + ": " + p.statusReason);
    else if (p.status !== "open" && p.statusByUsername && p.statusByUsername !== myName()) {
      bits.push(STATUS_WORD[p.status] + " by " + p.statusByUsername);
    }
    return bits.join(" · ");
  }
  const STATUS_WORD = { accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn", open: "Open" };

  function card(p, direction) {
    // From the viewer's own side, regardless of who proposed it: "give" is
    // always what leaves the viewer's collection, "get" is always what
    // arrives - incoming flips offering/requesting since the sender's
    // "offering" is the recipient's "get".
    const give = direction === "outgoing" ? p.offering : p.requesting;
    const get = direction === "outgoing" ? p.requesting : p.offering;
    const when = new Date(p.createdAt).toLocaleString();
    // What this viewer may do comes from the server (#128): the recipient
    // or any Owner/Manager of the store it went to may answer; the sender
    // of a personal offer, or any Owner/Manager of the sending store, may
    // withdraw.
    const canRespond = direction === "incoming" && !!p.canRespond;
    const canWithdraw = direction === "outgoing" && !!p.canWithdraw;
    return '<div class="move-box" style="margin-bottom:12px" data-id="' + G.esc(p.id) + '">' +
      '<div class="row" style="justify-content:space-between;align-items:center">' +
        "<strong>" + G.esc(headline(p, direction)) + "</strong>" +
        STATUS_PILL[p.status] +
      "</div>" +
      '<div class="muted" style="font-size:11.5px;margin:2px 0 8px">' + G.esc(subline(p, direction, when)) + "</div>" +
      '<div class="grid2">' +
        '<div><div class="muted" style="margin-bottom:4px">You give — ' + G.money(total(give)) + '</div>' +
          '<div class="list-wrap"><table class="list"><tbody>' + lineRows(give) + "</tbody></table></div></div>" +
        '<div><div class="muted" style="margin-bottom:4px">You get — ' + G.money(total(get)) + '</div>' +
          '<div class="list-wrap"><table class="list"><tbody>' + lineRows(get) + "</tbody></table></div></div>" +
      "</div>" +
      (canRespond
        ? '<div class="modal-actions" style="margin-top:10px"><span class="spacer"></span>' +
          '<button class="small ghost" data-act="decline">Decline</button>' +
          '<button class="small primary" data-act="accept">Accept</button></div>'
        : canWithdraw
          ? '<div class="modal-actions" style="margin-top:10px"><span class="spacer"></span>' +
            '<button class="small ghost" data-act="withdraw">Withdraw</button></div>'
          : "") +
      "</div>";
  }

  /* One malformed proposal (a record stored before the server sanitised
     every field, or a hand-edited one) must not stop the rest of the list
     drawing, and its recipient must still be able to decline it - so a
     card that throws is replaced by a plain one that keeps the buttons. */
  function safeCard(p, direction) {
    try { return card(p, direction); }
    catch (e) {
      const act = direction === "incoming" && p && p.canRespond
        ? '<button class="small ghost" data-act="decline">Decline</button>'
        : direction === "outgoing" && p && p.canWithdraw ? '<button class="small ghost" data-act="withdraw">Withdraw</button>' : "";
      return '<div class="move-box" style="margin-bottom:12px" data-id="' + G.esc(p && typeof p.id === "string" ? p.id : "") + '">' +
        '<div class="callout warn"><div class="cbody">Couldn&#39;t display this proposal: some of its details are damaged.</div></div>' +
        (act ? '<div class="modal-actions" style="margin-top:10px"><span class="spacer"></span>' + act + "</div>" : "") +
        "</div>";
    }
  }

  function respond(id, status) {
    return G.api("/api/trades/" + encodeURIComponent(id) + "/respond", { method: "POST", body: { status } })
      .then(load)
      .catch(e => UI.toast("Could not update that proposal: " + e.message, "err"));
  }

  function render() {
    // incoming / outgoing come from the server: a proposal to or from a
    // store this account manages counts as its own (#128).
    // A server not yet restarted onto #128 sends no flags: fall back to the
    // old sender/recipient rule for that one load.
    const myId = G.me && G.me.id;
    proposals.forEach(p => {
      if (!p || p.incoming !== undefined) return;
      const open = p.status === "open";
      p.incoming = p.toUserId === myId; p.outgoing = p.fromUserId === myId;
      p.canRespond = open && p.incoming; p.canWithdraw = open && p.outgoing;
    });
    const incoming = proposals.filter(p => p && p.incoming && !p.outgoing);
    const outgoing = proposals.filter(p => p && p.outgoing);
    const openIncoming = incoming.filter(p => p.status === "open").length;
    $("inCount").textContent = String(openIncoming);
    $("inHdr").textContent = incoming.length ? "— " + incoming.length + " total, " + openIncoming + " open" : "";
    $("outHdr").textContent = outgoing.length ? "— " + outgoing.length + " total" : "";

    $("inList").innerHTML = incoming.length
      ? incoming.map(p => safeCard(p, "incoming")).join("")
      : UI.emptyBlock({ icon: "people", title: "Nothing proposed to you yet." });
    $("outList").innerHTML = outgoing.length
      ? outgoing.map(p => safeCard(p, "outgoing")).join("")
      : UI.emptyBlock({ icon: "people", title: "You haven't sent any trade offers yet.",
          hint: 'Click "New proposal" above, or start one from a card\'s Friends popup on the <a href="/buy-list.html">Buy List</a>.' });

    // Hover shows the whole card: each row carries its line's imageUrl in
    // data-img. The thumbnail's own src is the art crop, which the popup
    // used to show blown up (#132).
    [$("inList"), $("outList")].forEach(list => {
      list.querySelectorAll("table.list tbody tr[data-img]").forEach(tr => {
        if (tr.dataset.img) UI.wireArtHover(tr, tr.dataset.img);
      });
    });

    $("inList").querySelectorAll(".move-box").forEach(el => {
      const id = el.dataset.id;
      const accept = el.querySelector('[data-act="accept"]');
      const decline = el.querySelector('[data-act="decline"]');
      if (accept) accept.onclick = () => respond(id, "accepted");
      if (decline) decline.onclick = () => respond(id, "declined");
    });
    $("outList").querySelectorAll(".move-box").forEach(el => {
      const id = el.dataset.id;
      const withdraw = el.querySelector('[data-act="withdraw"]');
      if (withdraw) withdraw.onclick = async () => {
        const ok = await UI.confirmDialog("Withdraw this trade offer?", { title: "Withdraw offer?" });
        if (ok) respond(id, "withdrawn");
      };
    });
  }

  async function load() {
    try {
      const d = await G.api("/api/trades");
      proposals = d.data || [];
    } catch (e) {
      $("inList").innerHTML = UI.emptyBlock({ icon: "error", title: "Could not load trade proposals: " + G.esc(e.message) });
      return;
    }
    render();
    if (deepProposal) { showProposal(deepProposal); deepProposal = null; }
  }

  /* Opens one proposal by id: the tab it's on, scrolled into view and
     marked. The server only lists proposals this viewer may see, so one
     that's gone (or no longer theirs) just says so. */
  function showProposal(id) {
    const p = proposals.find(x => x && x.id === id);
    const tab = p && p.outgoing ? "outgoing" : p && p.incoming ? "incoming" : null;
    if (!tab) { UI.toast("That trade offer isn't one you can see any more.", "err"); return; }
    tabs.show(tab);
    const box = [...$(tab === "outgoing" ? "outList" : "inList").querySelectorAll(".move-box")].find(el => el.dataset.id === id);
    if (!box) return;
    box.classList.add("sel");
    try { box.scrollIntoView({ block: "center" }); } catch (e) {}
  }

  UI.boot(async function () {
    // The tab is remembered (UI.pageTabs); ?tab=recorded and ?proposal= win over it.
    tabs = UI.pageTabs({ tabs: [
      { id: "incoming", button: "tabIncoming", panes: ["paneIncoming"] },
      { id: "outgoing", button: "tabOutgoing", panes: ["paneOutgoing"] },
      { id: "recorded", button: "tabRecorded", panes: ["paneRecorded"] }
    ] });
    $("btnNewProposal").onclick = () => TradeCompose.open({ onSent: load });
    $("btnRecordTrade").onclick = () => TradeRecord.open({ onSaved: () => tabs.show("recorded") });
    G.on("change", renderRecorded);
    renderRecorded();
    if (new URLSearchParams(location.search).get("tab") === "recorded") tabs.show("recorded");
    await load();
  });
})();
