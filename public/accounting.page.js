
"use strict";
(function () {
  const $ = UI.$;

  /* Split out of stats.page.js onto its own page (BACKLOG.md #19, direct
     user ask) - logic unchanged, just no longer sharing a page with
     collection-analytics stuff that has nothing to do with bookkeeping.
     Real numbers only - no fabricated revenue/tax. Revenue+COGS come from
     completePickList() (core.js), which only knows a sale price for a line
     that actually carried one in from a real order (see lists.page.js's
     generatePickList) or was priced at the counter (a Walk-in order, #431) -
     a manual pick or deck pull's ship event has none and is left out of the
     "Sale" rows entirely rather than guessed at.

     A counter sale (G.isCounterSale) is a Sale row marked `counter`: shown
     as "Counter sale", dated when it was handed over and paid, and counted
     only then (a picked one waiting at the counter can still be cancelled).
     It has no Manapool fees, so it never counts as a sale missing its fees. */
  const typeLabel = r => (r.counter ? "Counter sale" : r.type);
  function dateInRange(iso, from, to) {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (isNaN(t)) return false;
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  }
  function acctRange() {
    const from = $("acctFrom").value ? new Date($("acctFrom").value + "T00:00:00").getTime() : null;
    const to = $("acctTo").value ? new Date($("acctTo").value + "T23:59:59").getTime() : null;
    return { from, to };
  }
  /* The orders cache, only to find the readable order number of a pick
     list saved without one (#197). Loaded once at boot; until it arrives
     (or if it can't), G.pickListOrderLabel falls back to a shortened id. */
  let ordersById = new Map();
  async function loadOrders() {
    // Only when some sale still lacks its number: the backfill fixed the
    // saved ones, so this is normally no request at all.
    if (!G.state.pickLists.some(p => p.orderId && (!p.orderLabel || p.orderLabel === p.orderId))) return;
    try {
      const d = await G.api("/api/manapool/orders/cached");
      ordersById = G.ordersById((d && d.orders) || []);
    } catch (e) { return; }
    renderAccounting();
  }

  /* fullIds: the CSV, where an order with no readable number keeps its
     whole id (a spreadsheet can still look it up) instead of the table's
     shortened one. */
  /* #410: opened from the card panel (?q= + set/collector): that card's own
     sales only - its lines (copies x sale price) and the cost of those copies.
     Receipts, returns, fees, refunds and shipping can't be split per card, so
     they're left out while the filter is on. A pick completed before per-line
     cost was recorded gets its order's cost split by copies (`estimated`). */
  let cardFilter = UI.cardFilterFromUrl(), cardEstimated = false, introOrig = null;
  const copiesOf = it => it.pickedResult ? it.pickedResult.pulls.reduce((s, x) => s + (Number(x.qty) || 0), 0) : (Number(it.qty) || 0);
  function cardSale(p) {
    const name = cardFilter.name.toLowerCase();
    const exact = cardFilter.set && cardFilter.collector;
    let copies = 0, all = 0, revenue = 0, cogs = 0, hasLineCogs = true;
    for (const it of p.lines || []) {
      const n = copiesOf(it);
      all += n;
      if (it.kind === "sealed" || !(exact ? UI.cardFilterMatches(cardFilter, it) : String(it.name || "").toLowerCase().includes(name))) continue;
      copies += n;
      if (it.unitPrice != null) revenue += it.unitPrice * n;
      if (it.pickedResult && typeof it.pickedResult.cogs === "number") cogs += it.pickedResult.cogs;
      else hasLineCogs = false;
    }
    if (!copies) return null;
    const estimated = !hasLineCogs;
    if (estimated) cogs = all > 0 ? (Number(p.cogs) || 0) * copies / all : 0;
    // This card's share of the order's shipping (#457, owner: "net of both"), split
    // by copies, every copy in the envelope counting once: what the buyer paid for
    // it joins revenue, as in the P&L, and the packing and postage it cost is its
    // own column. null: no cost frozen on this sale.
    const paid = p.shippingRevenue != null ? Number(p.shippingRevenue) : p.orderPayment && p.orderPayment.shipping;
    if (paid && all > 0) revenue += Number(paid) * copies / all;
    const shipping = p.shipCost && all > 0 ? G.round2(G.saleShipCost(p) * copies / all) : null;
    return { revenue: G.round2(revenue), cogs: G.round2(cogs), copies, estimated, shipping };
  }
  function accountingRows(fullIds) {
    const { from, to } = acctRange();
    const rows = [];
    cardEstimated = false;
    for (const p of G.state.pickLists) {
      const counter = G.isCounterSale(p);
      // A counter sale counts once it's handed over and paid; anything else once picked (G.saleDate,
      // the same rule as the Dashboard and the card panel).
      const date = G.saleDate(p);
      if (!date || !dateInRange(date, from, to)) continue;
      // Manapool's readable order number, never its internal UUID (#197); a counter sale's customer.
      const order = counter ? G.counterSaleName(p) : G.pickListOrderLabel(p, ordersById, !!fullIds);
      const paid = counter && p.payment && G.PAY_METHOD_NAMES[p.payment.method] || "";
      // The customer, while they're still in Customers, is a link there.
      const customerId = counter && p.customer && p.customer.id && G.state.customers.some(c => c.id === p.customer.id) ? p.customer.id : "";
      if (cardFilter) {
        const s = p.orderId || counter ? cardSale(p) : null;
        if (!s || (!s.revenue && !s.cogs)) continue;
        if (s.estimated) cardEstimated = true;
        rows.push({
          date, type: "Sale", counter, ref: p.id, order, paid, customerId,
          revenue: s.revenue, cogs: s.cogs, fees: null, earnings: null,
          shipping: s.shipping, shipRule: s.shipping != null ? "This card's share, by copies" : "", spend: null, refund: null
        });
        continue;
      }
      if (!counter && !p.revenue && !p.cogs) continue; // nothing recognised on this one - a manual/deck pick, leave it out
      rows.push({
        date, type: "Sale", counter, ref: p.id, order, paid, customerId,
        revenue: Number(p.revenue) || 0, cogs: Number(p.cogs) || 0,
        // No Manapool cut on a counter sale: no fee, and Earnings is Manapool's own payout.
        fees: counter ? 0 : p.fees == null ? null : Number(p.fees), earnings: p.earnings == null ? null : Number(p.earnings),
        // Packing + postage frozen on the sale (#457); a counter sale doesn't ship.
        shipping: p.shipCost ? G.saleShipCost(p) : null, shipRule: p.shipCost ? p.shipCost.ruleName || "" : "",
        spend: null, refund: null
      });
    }
    for (const r of cardFilter ? [] : G.state.receipts) {
      if (!(Number(r.spend) > 0) || !dateInRange(r.ts, from, to)) continue;
      rows.push({
        date: r.ts, type: "Receipt", ref: r.receiptId || "", order: "",
        revenue: null, cogs: null, fees: null, earnings: null, spend: Number(r.spend) || 0, refund: null
      });
    }
    for (const r of cardFilter ? [] : G.state.returns) {
      if (!dateInRange(r.ts, from, to)) continue;
      rows.push({
        date: r.ts, type: "Return", ref: r.returnId || "", order: r.orderLabel || "",
        revenue: null, cogs: null, fees: null, earnings: null,
        spend: null, refund: r.refundTotal == null ? null : Number(r.refundTotal),
        // Cost a restocked return put back into inventory - see G.returnCostBack().
        costBack: G.returnCostBack(r)
      });
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }
  /* Buckets accountingRows() by calendar day for the chart below the tiles.
     Days with no activity get a real 0, not a gap - unlike a price chart
     (where a missing day means "unknown"), a bookkeeping day with no sales
     genuinely made $0, and a flat line at zero is the honest picture. */
  function dayBucketedSeries(rows, from, to) {
    let startMs = from, endMs = to;
    if (startMs == null || endMs == null) {
      const dates = rows.map(r => Date.parse(r.date)).filter(t => !isNaN(t));
      if (!dates.length) return { labels: [], revenue: [], cogs: [] };
      if (startMs == null) startMs = Math.min.apply(null, dates);
      if (endMs == null) endMs = Math.max.apply(null, dates);
    }
    // Local calendar-day math, not toISOString() - a UTC+ browser's local
    // midnight would otherwise round-trip to the PREVIOUS day once converted
    // to UTC, and a plain 86400000ms step would mis-step across a DST change.
    const dayKey = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
    const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
    const startDay = startOfDay(startMs), endDay = startOfDay(endMs);
    const byDay = new Map();
    for (const r of rows) {
      const key = dayKey(new Date(r.date));
      let b = byDay.get(key);
      if (!b) { b = { revenue: 0, cogs: 0 }; byDay.set(key, b); }
      b.revenue += r.revenue || 0;
      b.cogs += r.cogs || 0;
    }
    const labels = [], revenue = [], cogs = [];
    for (const d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d);
      labels.push(key);
      const b = byDay.get(key);
      revenue.push(b ? G.round2(b.revenue) : 0);
      cogs.push(b ? G.round2(b.cogs) : 0);
    }
    return { labels, revenue, cogs };
  }
  function renderAcctChart(rows) {
    const { from, to } = acctRange();
    const { labels, revenue, cogs } = dayBucketedSeries(rows, from, to);
    $("acctChart").innerHTML = UI.lineChart({
      labels,
      series: [{ values: revenue, cls: "pos" }, { values: cogs, cls: "neg" }],
      height: 220,
      title: "Daily revenue vs COGS",
      yFormat: G.money,
      emptyText: "Not enough activity in this range to chart yet."
    });
  }
  function tile(big, lbl, cls) {
    return '<div class="tile ' + (cls || "") + '"><span class="big ' + (cls || "") + '">' + big + "</span>" +
      '<span class="lbl">' + lbl + "</span></div>";
  }
  function renderAccounting() {
    const rows = accountingRows();
    const revenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
    const cogs = rows.reduce((s, r) => s + (r.cogs || 0), 0);
    const spend = rows.reduce((s, r) => s + (r.spend || 0), 0);
    const refund = rows.reduce((s, r) => s + (r.refund || 0), 0);
    // Only summed over rows that actually carry a real payment breakdown
    // (an order whose full detail was fetched) - unlike revenue/COGS, there
    // is no honest zero to fall back on for an order that was never fetched
    // in enough detail to know its fee, so a row with earnings == null is
    // just skipped rather than counted as $0.
    const earningsRows = rows.filter(r => r.earnings != null);
    const earnings = earningsRows.reduce((s, r) => s + r.earnings, 0);
    // One card's sales: only what can be split per card (see cardSale).
    $("acctTable").classList.toggle("card-only", !!cardFilter);
    $("pnlTable").classList.toggle("card-only-pnl", !!cardFilter);
    const intro = $("acctIntro");
    if (introOrig == null) introOrig = intro.textContent;
    intro.textContent = cardFilter
      ? "One card's sales: copies sold × sale price, with the cost and profit of those copies. Its share of each order's shipping is split by copies: what the buyer paid for shipping is in Revenue, and what packing and postage cost you is under Shipping cost. Fees, receipt spend and refunds can't be split per card, so they're hidden." +
        (cardEstimated ? " Sales picked before Grimoire recorded each line's cost have their order's cost shared out by copies." : "")
      : introOrig;
    const shipShare = cardFilter ? G.round2(rows.reduce((s, r) => s + (r.shipping || 0), 0)) : 0;
    const afterShip = G.round2(revenue - cogs - shipShare);
    $("acctTiles").innerHTML = cardFilter
      ? tile(rows.length, "Sales") + tile(G.money(revenue), "Revenue", "val") + tile(G.money(cogs), "COGS") +
        tile(G.money(revenue - cogs), "Gross profit", (revenue - cogs) >= 0 ? "val" : "neg") +
        tile(G.money(shipShare), "Shipping share") +
        tile(G.money(afterShip), "Profit after shipping", afterShip >= 0 ? "val" : "neg")
      : tile(G.money(revenue), "Revenue", "val") +
      tile(G.money(cogs), "COGS") +
      tile(G.money(revenue - cogs), "Gross profit", (revenue - cogs) >= 0 ? "val" : "neg") +
      tile(earningsRows.length ? G.money(earnings) : "—", "Earnings (Manapool net)",
        earningsRows.length ? (earnings >= 0 ? "val" : "neg") : "") +
      tile(G.money(spend), "Receipt spend") +
      tile(G.money(refund), "Refunds", refund ? "neg" : "");
    renderAcctChart(rows);
    renderPnl(rows);
    $("acctBody").innerHTML = rows.length ? rows.map(r => {
      const gross = r.type === "Sale" ? r.revenue - r.cogs : null;
      return "<tr><td>" + G.esc(new Date(r.date).toLocaleDateString()) + "</td>" +
        '<td><span class="pill type">' + G.esc(typeLabel(r)) + "</span></td>" +
        "<td>" + G.esc(r.ref) + "</td>" +
        "<td>" + (r.customerId ? '<a href="/customers.html?id=' + encodeURIComponent(r.customerId) + '">' + G.esc(r.order) + "</a>"
          : G.esc(r.order)) + "</td>" +
        '<td class="num">' + (r.revenue == null ? '<span class="muted">—</span>' : G.money(r.revenue)) + "</td>" +
        '<td class="num">' + (r.cogs == null ? '<span class="muted">—</span>' : G.money(r.cogs)) + "</td>" +
        '<td class="num ' + (gross == null ? "" : gross >= 0 ? "good" : "bad") + '">' +
          (gross == null ? '<span class="muted">—</span>' : G.money(gross)) + "</td>" +
        '<td class="num">' + (r.fees == null ? '<span class="muted">—</span>' : G.money(r.fees)) + "</td>" +
        '<td class="num hide-sm"' + (r.shipping != null && r.shipRule ? ' title="' + G.esc(r.shipRule) + '"' : "") + ">" +
          (r.shipping == null ? '<span class="muted">—</span>' : G.money(r.shipping)) + "</td>" +
        '<td class="num ' + (r.earnings == null ? "" : r.earnings >= 0 ? "good" : "bad") + '">' +
          (r.earnings == null ? '<span class="muted">—</span>' : G.money(r.earnings)) + "</td>" +
        '<td class="num">' + (r.spend == null ? '<span class="muted">—</span>' : G.money(r.spend)) + "</td>" +
        '<td class="num">' + (r.refund == null ? '<span class="muted">—</span>' : G.money(r.refund)) + "</td></tr>";
    }).join("") : UI.emptyRow(12, { icon: "search", title: "Nothing in this date range." });
    UI.reapplySorts();
  }
  function exportAccountingCsv() {
    const rows = accountingRows(true);
    if (!rows.length) { UI.toast("Nothing in this date range to export.", "err"); return; }
    // Local Date / Returned Stock Cost / Paid By (#431) are appended, never inserted, so a
    // spreadsheet built on the original columns keeps working. Date stays the
    // raw UTC timestamp; Local Date is the day the P&L files it under.
    const head = ["Date", "Type", "Reference", "Order", "Revenue", "COGS", "Gross Profit", "Fees", "Earnings", "Spend", "Refund",
      "Local Date", "Returned Stock Cost", "Paid By", "Shipping Cost"];
    const lines = [head.map(G.csvCell).join(",")];
    for (const r of rows) {
      const gross = r.type === "Sale" ? G.round2(r.revenue - r.cogs) : "";
      lines.push([r.date, typeLabel(r), r.ref, r.order,
        r.revenue == null ? "" : r.revenue, r.cogs == null ? "" : r.cogs, gross,
        r.fees == null ? "" : r.fees, r.earnings == null ? "" : r.earnings,
        r.spend == null ? "" : r.spend, r.refund == null ? "" : r.refund,
        G.localDay(Date.parse(r.date)), r.type === "Return" ? r.costBack : "", r.paid || "",
        r.shipping == null ? "" : r.shipping].map(G.csvCell).join(","));
    }
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-accounting.csv");
    UI.toast("Exported " + rows.length + " row" + (rows.length === 1 ? "" : "s") + ".", "ok");
  }

  /* ---------- P&L statement (issue #48) ----------
     A view over the same accountingRows() as the tiles, table and CSV, rolled
     up by G.pnlByMonth() (core.js, unit-tested there). Nothing here does its
     own arithmetic, so the statement can't drift from the tiles. */
  const localDay = G.localDay;
  function monthLabel(m) {
    return new Date(m.year, m.month - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  function currentPnl(rows) {
    const { from, to } = acctRange();
    return G.pnlByMonth(rows || accountingRows(), from, to);
  }
  const moneyCell = (v, signed) =>
    '<td class="num' + (signed ? (v >= 0 ? " good" : " bad") : "") + '">' + G.money(v) + "</td>";
  function pnlCells(m) {
    return '<td class="num hide-sm">' + m.sales + "</td>" +
      moneyCell(m.revenue) + moneyCell(m.cogs) + moneyCell(m.gross, true) +
      '<td class="num hide-sm">' + G.money(m.fees) + "</td>" +
      '<td class="num hide-sm">' + G.money(m.shipping) + "</td>" +
      '<td class="num hide-sm">' + G.money(m.refunds) + "</td>" +
      '<td class="num hide-sm">' + G.money(m.costBack) + "</td>" +
      moneyCell(m.net, true);
  }
  function renderPnl(rows) {
    const { months, totals } = currentPnl(rows);
    const fmtDay = ms => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    $("pnlBody").innerHTML = months.length ? months.map(m =>
      '<tr><td data-v="' + (m.year * 100 + m.month) + '">' + G.esc(monthLabel(m)) +
        (m.partial ? ' <span class="muted">' + G.esc(fmtDay(m.start) + " – " + fmtDay(m.end)) + "</span>" : "") +
        "</td>" + pnlCells(m) + "</tr>").join("")
      : UI.emptyRow(10, { icon: "money", title: "Pick a date range to see the statement." });
    $("pnlFoot").innerHTML = months.length ? "<tr><td>Total</td>" + pnlCells(totals) + "</tr>" : "";
    const missing = totals.salesMissingFees;
    $("pnlFeesNote").hidden = !missing || !!cardFilter;
    $("pnlFeesNoteBody").innerHTML = missing
      ? "<h3>Fees unknown for " + missing + " sale" + (missing === 1 ? "" : "s") + "</h3>" +
        "Their full order details were never fetched from Manapool, so their fees count as $0 here and net " +
        "profit reads a little high for those months. The <b>Fees</b> column in the transactions export is " +
        "blank for the same sales."
      : "";
  }
  function exportPnlCsv() {
    const { months, totals } = currentPnl();
    if (!months.length) { UI.toast("Pick a date range to export the statement.", "err"); return; }
    const head = ["Month", "Period Start", "Period End", "Sales", "Sales Missing Fees",
      "Revenue", "COGS", "Gross Profit", "Fees", "Refunds", "Returned Stock Cost Back", "Net Profit", "Shipping Cost"];
    const line = (label, m, start, end) => [label, start, end, m.sales, m.salesMissingFees,
      m.revenue, m.cogs, m.gross, m.fees, m.refunds, m.costBack, m.net, m.shipping].map(G.csvCell).join(",");
    const lines = [head.map(G.csvCell).join(",")];
    for (const m of months) lines.push(line(m.key, m, localDay(m.start), localDay(m.end)));
    lines.push(line("Total", totals, localDay(months[0].start), localDay(months[months.length - 1].end)));
    G.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "grimoire-pnl.csv");
    UI.toast("Exported " + months.length + " month" + (months.length === 1 ? "" : "s") + ".", "ok");
  }

  let tab = "txns";
  let tabs;

  // Local calendar dates, stepped by calendar day: see G.accountingPresetRange().
  function setRange(key) {
    const r = G.accountingPresetRange(key, Date.now());
    if (!r) return false;
    $("acctFrom").value = r.from;
    $("acctTo").value = r.to;
    return true;
  }
  function applyDatePreset(key) {
    if (setRange(key)) renderAccounting();
  }

  function showCardChip() {
    UI.cardFilterChip($("acctPresets").parentNode, cardFilter, cardFilter ? "One card's sales: " + UI.cardFilterLabel(cardFilter) + " (all dates)" : "", () => {
      cardFilter = null; setRange("30"); renderAccounting();
    });
  }
  UI.boot(async function () {
    setRange("30");
    // A card's sales are shown across all dates; the range buttons narrow them.
    if (cardFilter) $("acctFrom").value = "";
    showCardChip();
    $("acctFrom").onchange = renderAccounting;
    $("acctTo").onchange = renderAccounting;
    $("acctCsv").onclick = () => (tab === "pnl" ? exportPnlCsv() : exportAccountingCsv());
    // The tab is remembered (UI.pageTabs); the Export button follows it.
    tabs = UI.pageTabs({ tabs: [
      { id: "txns", button: "tabTxns", panes: ["paneTxns"] },
      { id: "pnl", button: "tabPnl", panes: ["panePnl"] }
    ], onShow: t => {
      tab = t;
      $("acctCsv").textContent = t === "pnl" ? "Export P&L CSV" : "Export CSV";
    } });
    $("acctPresets").onclick = e => {
      const btn = e.target.closest("button[data-preset]");
      if (btn) applyDatePreset(btn.dataset.preset);
    };
    renderAccounting();
    loadOrders();
  });
})();
